const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { appConfig } = require('./config.js');
const {
  buildPrivateHlsAssetKey,
  resolvePrivateVideoPath,
  resolvePrivateHlsPath,
  ensureStorageDirectory,
} = require('./private-video.js');
const {
  getPrivateVideoStorageProvider,
  downloadPrivateStorageObjectToFile,
  uploadPrivateStorageFile,
  deleteStoredPrivateVideoPrefix,
} = require('./private-video-storage.js');
const {
  buildManifestBundleStorageKey,
  createManifestBundleFromDirectory,
  writeManifestBundleToDirectory,
} = require('./manifest-bundle.js');

const activeJobs = new Set();
const queuedJobs = [];
let activeTranscodingJobs = 0;

const getRecordedHlsStorageProvider = () => {
  const configured = String(appConfig.videoHlsStorageProvider || appConfig.privateVideoStorageProvider || 'local').toLowerCase();
  if (configured === 's3') {
    return 's3';
  }
  return 'local';
};

const getTargetQualities = () => {
  const configured = Array.isArray(appConfig.videoTargetRenditions) ? appConfig.videoTargetRenditions : [];
  const supported = ['240p', '360p', '480p', '720p'];
  const result = configured.filter((entry) => supported.includes(entry));
  return result.length > 0 ? result : ['240p', '360p', '480p', '720p'];
};

const createInitialVideoDeliveryState = () => ({
  deliveryProfile: appConfig.videoDeliveryProfile,
  deliveryStrategy: 'hls',
  sourceFallbackAllowed: false,
  targetQualities: getTargetQualities(),
  hlsStorageProvider: null,
  hlsProcessingStatus: appConfig.enableVideoTranscoding ? 'queued' : 'ready',
  hlsProcessingQueuedAt: appConfig.enableVideoTranscoding ? new Date().toISOString() : null,
  hlsProcessingStartedAt: null,
  hlsProcessingCompletedAt: null,
  hlsProcessingError: null,
  hlsManifestPath: null,
  hlsPlaybackPath: null,
  hlsManifestBundlePath: null,
  hlsManifestRootPath: null,
  hlsManifestVersion: null,
});

const cleanupDirectory = (directoryPath) => {
  if (directoryPath && fs.existsSync(directoryPath)) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
};

const deleteProcessedHlsAssets = async (manifestPath, storageProvider = null) => {
  if (!manifestPath) {
    return;
  }

  const resolvedManifest = resolvePrivateHlsPath(manifestPath);
  if ((!storageProvider || storageProvider === 'local') && resolvedManifest && fs.existsSync(path.dirname(resolvedManifest))) {
    cleanupDirectory(path.dirname(resolvedManifest));
    return;
  }

  await deleteStoredPrivateVideoPrefix({
    storageProvider: storageProvider || getRecordedHlsStorageProvider(),
    storagePathPrefix: path.posix.dirname(String(manifestPath)),
  });
};

const waitForFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: 'ignore' });
    let settled = false;
    const timeoutMs = Math.max(Number(appConfig.videoTranscodingJobTimeoutMs || 0), 60_000);
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });

const createHlsKeyInfoFile = (variantDir) => {
  if (!appConfig.privateVideoHlsAesEncryptionEnabled) {
    return null;
  }

  const keyFilePath = path.join(variantDir, 'enc.key');
  const keyInfoPath = path.join(variantDir, 'enc.keyinfo');
  const iv = crypto.randomBytes(16).toString('hex');

  fs.writeFileSync(keyFilePath, crypto.randomBytes(16));
  fs.writeFileSync(keyInfoPath, `enc.key\n${keyFilePath}\n${iv}\n`);

  return keyInfoPath;
};

const writeMasterManifest = ({ outputDirectory, variants }) => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  variants.forEach((variant) => {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.resolution}`);
    lines.push(`${variant.name}/index.m3u8`);
  });
  fs.writeFileSync(path.join(outputDirectory, 'master.m3u8'), `${lines.join('\n')}\n`);
};

const renditionProfiles = {
  '240p': { width: 426, height: 240, videoBitrate: '320k', maxRate: '342k', bufferSize: '480k', bandwidth: 400000, resolution: '426x240' },
  '360p': { width: 640, height: 360, videoBitrate: '550k', maxRate: '588k', bufferSize: '825k', bandwidth: 650000, resolution: '640x360' },
  '480p': { width: 854, height: 480, videoBitrate: '900k', maxRate: '963k', bufferSize: '1350k', bandwidth: 1000000, resolution: '854x480' },
  '720p': { width: 1280, height: 720, videoBitrate: '2200k', maxRate: '2354k', bufferSize: '3300k', bandwidth: 2500000, resolution: '1280x720' },
};

const hlsAssetMimeTypeByExtension = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.key': 'application/octet-stream',
};

const createTemporaryWorkspace = (jobId) => fs.mkdtempSync(path.join(os.tmpdir(), `edumaster-video-${jobId.replace(/[^a-zA-Z0-9_-]/g, '_')}-`));

const downloadStorageSourceToLocal = async ({ lesson, workspaceDirectory }) => {
  const localSourcePath = resolvePrivateVideoPath(lesson.storagePath);
  if (localSourcePath && fs.existsSync(localSourcePath)) {
    return {
      sourcePath: localSourcePath,
      cleanup: () => {},
    };
  }

  if ((lesson.storageProvider || 'local') !== 's3') {
    throw new Error('Source video file not found for HLS processing.');
  }

  const extension = path.extname(String(lesson.originalFilename || lesson.storagePath || 'video.mp4')) || '.mp4';
  const downloadedSourcePath = path.join(workspaceDirectory, `source${extension}`);
  const downloaded = await downloadPrivateStorageObjectToFile({
    storageProvider: lesson.storageProvider,
    storagePath: lesson.storagePath,
    destinationPath: downloadedSourcePath,
  });
  if (!downloaded) {
    throw new Error('Source video file could not be downloaded from object storage.');
  }

  return {
    sourcePath: downloadedSourcePath,
    cleanup: () => {
      if (fs.existsSync(downloadedSourcePath)) {
        fs.unlinkSync(downloadedSourcePath);
      }
    },
  };
};

const uploadProcessedHlsDirectory = async ({ outputDirectory, manifestKey }) => {
  const prefix = path.posix.dirname(manifestKey);
  const uploadTasks = [];

  const walk = (directoryPath) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }

      const relativePath = path.relative(outputDirectory, fullPath).split(path.sep).join(path.posix.sep);
      const extension = path.extname(entry.name).toLowerCase();
      uploadTasks.push(uploadPrivateStorageFile({
        storageProvider: 's3',
        storagePath: path.posix.join(prefix, relativePath),
        localFilePath: fullPath,
        contentType: hlsAssetMimeTypeByExtension[extension] || 'application/octet-stream',
      }));
    });
  };

  walk(outputDirectory);
  await Promise.all(uploadTasks);
};

const transcodeToHls = async ({ sourcePath, outputDirectory, qualities }) => {
  cleanupDirectory(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const variants = [];

  for (const quality of qualities) {
    const profile = renditionProfiles[quality];
    if (!profile) {
      continue;
    }

    const variantDir = path.join(outputDirectory, quality);
    fs.mkdirSync(variantDir, { recursive: true });
    const playlistPath = path.join(variantDir, 'index.m3u8');
    const segmentPattern = path.join(variantDir, 'segment_%03d.ts');
    const keyInfoPath = createHlsKeyInfoFile(variantDir);

    const args = [
      '-y',
      '-i', sourcePath,
      '-vf', `scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`,
      '-ac', '2',
      '-c:a', 'aac',
      '-ar', '48000',
      '-b:a', '128k',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-crf', '23',
      '-sc_threshold', '0',
      '-g', '48',
      '-keyint_min', '48',
      '-b:v', profile.videoBitrate,
      '-maxrate', profile.maxRate,
      '-bufsize', profile.bufferSize,
      '-hls_time', String(appConfig.videoHlsSegmentDurationSeconds),
      '-hls_flags', 'independent_segments',
      '-hls_playlist_type', 'vod',
      ...(keyInfoPath ? ['-hls_key_info_file', keyInfoPath] : []),
      '-hls_segment_filename', segmentPattern,
      playlistPath,
    ];

    await waitForFfmpeg(args);
    if (keyInfoPath && fs.existsSync(keyInfoPath)) {
      fs.unlinkSync(keyInfoPath);
    }
    variants.push({
      name: quality,
      bandwidth: profile.bandwidth,
      resolution: profile.resolution,
    });
  }

  writeMasterManifest({ outputDirectory, variants });
};

const runQueuedVideoJob = (job) => {
  activeTranscodingJobs += 1;
  void job().finally(() => {
    activeTranscodingJobs = Math.max(activeTranscodingJobs - 1, 0);
    drainVideoProcessingQueue();
  });
};

const drainVideoProcessingQueue = () => {
  const maxConcurrency = Math.max(Number(appConfig.videoTranscodingConcurrency || 1), 1);
  while (activeTranscodingJobs < maxConcurrency && queuedJobs.length > 0) {
    const nextJob = queuedJobs.shift();
    if (nextJob) {
      runQueuedVideoJob(nextJob);
    }
  }
};

const enqueueVideoProcessingJob = (job) => {
  queuedJobs.push(job);
  drainVideoProcessingQueue();
};

const scheduleVideoProcessing = ({ courseId, lessonId }) => {
  if (!appConfig.enableVideoTranscoding) {
    return;
  }

  const jobId = `${courseId}:${lessonId}`;
  if (activeJobs.has(jobId)) {
    return;
  }
  activeJobs.add(jobId);

  enqueueVideoProcessingJob(async () => {
    const { coursesRepository } = require('./repositories.js');
    try {
      const course = await coursesRepository.findById(courseId);
      const lesson = course ? course.modules.flatMap((module) => ([
        ...(module.lessons || []),
        ...((module.chapters || []).flatMap((chapter) => chapter.lessons || [])),
      ])).find((entry) => entry.id === String(lessonId)) : null;

      if (!lesson || !lesson.storagePath) {
        await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
          ...current,
          hlsProcessingStatus: 'failed',
          hlsProcessingCompletedAt: new Date().toISOString(),
          hlsProcessingError: 'Source video file is missing for HLS processing.',
        }));
        return;
      }

      await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
        ...current,
        hlsProcessingStatus: 'processing',
        hlsProcessingStartedAt: new Date().toISOString(),
        hlsProcessingError: null,
      }));

      if (!ffmpegPath) {
        throw new Error('ffmpeg runtime is unavailable.');
      }

      const workspaceDirectory = createTemporaryWorkspace(jobId);
      const outputKey = buildPrivateHlsAssetKey({ courseId, moduleId: lesson.moduleId || 'module', lessonId, assetName: 'master.m3u8' });
      const outputRootPath = path.posix.dirname(outputKey);
      const manifestBundleKey = buildManifestBundleStorageKey(outputKey);
      const localOutputDirectory = path.join(workspaceDirectory, 'hls');
      const outputStorageProvider = getRecordedHlsStorageProvider();
      const { sourcePath, cleanup } = await downloadStorageSourceToLocal({
        lesson,
        workspaceDirectory,
      });
      const manifestVersion = Date.now().toString(36);

      try {
        await transcodeToHls({
          sourcePath,
          outputDirectory: localOutputDirectory,
          qualities: Array.isArray(lesson.targetQualities) && lesson.targetQualities.length > 0 ? lesson.targetQualities : getTargetQualities(),
        });
        const manifestBundle = createManifestBundleFromDirectory({
          outputDirectory: localOutputDirectory,
          manifestKey: outputKey,
          storageProvider: outputStorageProvider,
          version: manifestVersion,
        });
        writeManifestBundleToDirectory({
          outputDirectory: localOutputDirectory,
          bundle: manifestBundle,
        });

        if (outputStorageProvider === 's3') {
          await deleteStoredPrivateVideoPrefix({
            storageProvider: 's3',
            storagePathPrefix: path.posix.dirname(outputKey),
          });
          await uploadProcessedHlsDirectory({
            outputDirectory: localOutputDirectory,
            manifestKey: outputKey,
          });
        } else {
          const resolvedOutputDirectory = path.dirname(resolvePrivateHlsPath(outputKey));
          cleanupDirectory(resolvedOutputDirectory);
          fs.mkdirSync(path.dirname(resolvedOutputDirectory), { recursive: true });
          fs.renameSync(localOutputDirectory, resolvedOutputDirectory);
        }
      } finally {
        cleanup();
        cleanupDirectory(workspaceDirectory);
      }

      const updatedLesson = await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
        ...current,
        storagePath: appConfig.videoKeepSourceAfterProcessing ? current.storagePath : null,
        deliveryStrategy: 'hls',
        hlsStorageProvider: outputStorageProvider,
        hlsProcessingStatus: 'ready',
        hlsProcessingCompletedAt: new Date().toISOString(),
        hlsManifestPath: outputKey,
        hlsPlaybackPath: outputKey,
        hlsManifestBundlePath: manifestBundleKey,
        hlsManifestRootPath: outputRootPath,
        hlsManifestVersion: manifestVersion,
        hlsProcessingError: null,
      }));

      if (!updatedLesson) {
        await deleteProcessedHlsAssets(outputKey, outputStorageProvider);
        throw new Error(`Lesson ${lessonId} disappeared before HLS metadata could be saved.`);
      }

      if (!appConfig.videoKeepSourceAfterProcessing && lesson.storagePath) {
        if ((lesson.storageProvider || 'local') === 's3') {
          const { deleteStoredPrivateVideo } = require('./private-video-storage.js');
          await deleteStoredPrivateVideo({
            storageProvider: lesson.storageProvider,
            storagePath: lesson.storagePath,
          });
        } else if (sourcePath && fs.existsSync(sourcePath)) {
          fs.unlinkSync(sourcePath);
        }
      }
    } catch (error) {
      const { coursesRepository } = require('./repositories.js');
      await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
        ...current,
        hlsProcessingStatus: 'failed',
        hlsProcessingCompletedAt: new Date().toISOString(),
        hlsProcessingError: error instanceof Error ? error.message : 'Video processing failed.',
      }));
    } finally {
      activeJobs.delete(jobId);
    }
  });
};

const recoverPendingCourseVideoProcessingJobs = async () => {
  const cloudflareStreamEnabled = String(appConfig.videoProcessingProvider || '').toLowerCase() === 'cloudflare-stream';
  if (!appConfig.enableVideoTranscoding && !cloudflareStreamEnabled) {
    return { scanned: 0, scheduled: 0 };
  }

  const { coursesRepository } = require('./repositories.js');
  const courses = await coursesRepository.list();
  let scanned = 0;
  let scheduled = 0;

  for (const course of courses || []) {
    for (const moduleEntry of course.modules || []) {
      const lessons = [
        ...(moduleEntry.lessons || []),
        ...((moduleEntry.chapters || []).flatMap((chapter) => chapter.lessons || [])),
      ];

      for (const lesson of lessons) {
        scanned += 1;
        const status = String(lesson.hlsProcessingStatus || '').toLowerCase();
        const provider = String(lesson.storageProvider || '').toLowerCase();
        const streamProvider = String(lesson.streamProvider || '').toLowerCase();
        const cloudflareUid = lesson.cloudflareStreamUid || lesson.streamUid || null;
        if ((provider === 'cloudflare-stream' || streamProvider === 'cloudflare-stream') && cloudflareUid) {
          if (['queued', 'processing', 'upload-pending', ''].includes(status) || !lesson.playbackReady) {
            const { scheduleCloudflareStreamStatusPolling } = require('./cloudflare-stream.js');
            scheduleCloudflareStreamStatusPolling({ uid: cloudflareUid });
            scheduled += 1;
          }
          continue;
        }

        const hasSource = Boolean(lesson.storagePath);
        const needsHls = lesson.type === 'private-video'
          && appConfig.enableVideoTranscoding
          && lesson.deliveryStrategy === 'hls'
          && hasSource
          && !lesson.hlsPlaybackPath
          && ['queued', 'processing', 'failed'].includes(status)
          && provider !== 'bunny-stream';

        if (!needsHls) {
          continue;
        }

        await coursesRepository.updateLesson(course._id, lesson.id, (current) => ({
          ...current,
          hlsProcessingStatus: 'queued',
          hlsProcessingQueuedAt: current.hlsProcessingQueuedAt || new Date().toISOString(),
          hlsProcessingStartedAt: null,
          hlsProcessingError: null,
        }));
        scheduleVideoProcessing({ courseId: course._id, lessonId: lesson.id });
        scheduled += 1;
      }
    }
  }

  return { scanned, scheduled };
};

const maybeRecoverStaleCourseVideoProcessingJob = async ({ courseId, lesson }) => {
  if (!appConfig.enableVideoTranscoding || !lesson) {
    return false;
  }

  const status = String(lesson.hlsProcessingStatus || '').toLowerCase();
  const staleAfterMs = Math.max(Number(appConfig.videoProcessingStaleAfterMs || 0), 60_000);
  const startedAt = Date.parse(lesson.hlsProcessingStartedAt || lesson.hlsProcessingQueuedAt || lesson.uploadedAt || 0);
  const stale = Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt > staleAfterMs;
  const needsHls = lesson.type === 'private-video'
    && lesson.deliveryStrategy === 'hls'
    && Boolean(lesson.storagePath)
    && !lesson.hlsPlaybackPath
    && ['queued', 'processing', 'failed'].includes(status)
    && String(lesson.storageProvider || '').toLowerCase() !== 'bunny-stream';

  if (!needsHls || !stale) {
    return false;
  }

  const { coursesRepository } = require('./repositories.js');
  const updatedLesson = await coursesRepository.updateLesson(courseId, lesson.id, (current) => ({
    ...current,
    hlsProcessingStatus: 'queued',
    hlsProcessingQueuedAt: new Date().toISOString(),
    hlsProcessingStartedAt: null,
    hlsProcessingError: null,
  }));

  if (!updatedLesson) {
    return false;
  }

  scheduleVideoProcessing({ courseId, lessonId: lesson.id });
  return true;
};

const scheduleTestVideoProcessing = ({ testId }) => {
  if (!appConfig.enableVideoTranscoding) {
    return;
  }

  const jobId = `test:${testId}`;
  if (activeJobs.has(jobId)) {
    return;
  }
  activeJobs.add(jobId);

  enqueueVideoProcessingJob(async () => {
    const { testsRepository } = require('./repositories.js');
    try {
      const test = await testsRepository.findById(testId);
      const video = test?.companionVideo || null;

      if (!video || !video.storagePath) {
        await testsRepository.updateCompanionVideo(testId, (current) => ({
          ...(current || {}),
          hlsProcessingStatus: 'failed',
          hlsProcessingCompletedAt: new Date().toISOString(),
          hlsProcessingError: 'Source video file is missing for HLS processing.',
        }));
        return;
      }

      await testsRepository.updateCompanionVideo(testId, (current) => ({
        ...(current || {}),
        hlsProcessingStatus: 'processing',
        hlsProcessingStartedAt: new Date().toISOString(),
        hlsProcessingError: null,
      }));

      if (!ffmpegPath) {
        throw new Error('ffmpeg runtime is unavailable.');
      }

      const workspaceDirectory = createTemporaryWorkspace(jobId);
      const videoId = String(video.id || `test-video-${testId}`);
      const outputKey = buildPrivateHlsAssetKey({ courseId: 'tests', moduleId: testId, lessonId: videoId, assetName: 'master.m3u8' });
      const outputRootPath = path.posix.dirname(outputKey);
      const manifestBundleKey = buildManifestBundleStorageKey(outputKey);
      const localOutputDirectory = path.join(workspaceDirectory, 'hls');
      const outputStorageProvider = getRecordedHlsStorageProvider();
      const { sourcePath, cleanup } = await downloadStorageSourceToLocal({
        lesson: video,
        workspaceDirectory,
      });
      const manifestVersion = Date.now().toString(36);

      try {
        await transcodeToHls({
          sourcePath,
          outputDirectory: localOutputDirectory,
          qualities: Array.isArray(video.targetQualities) && video.targetQualities.length > 0 ? video.targetQualities : getTargetQualities(),
        });
        const manifestBundle = createManifestBundleFromDirectory({
          outputDirectory: localOutputDirectory,
          manifestKey: outputKey,
          storageProvider: outputStorageProvider,
          version: manifestVersion,
        });
        writeManifestBundleToDirectory({
          outputDirectory: localOutputDirectory,
          bundle: manifestBundle,
        });

        if (outputStorageProvider === 's3') {
          await deleteStoredPrivateVideoPrefix({
            storageProvider: 's3',
            storagePathPrefix: path.posix.dirname(outputKey),
          });
          await uploadProcessedHlsDirectory({
            outputDirectory: localOutputDirectory,
            manifestKey: outputKey,
          });
        } else {
          const resolvedOutputDirectory = path.dirname(resolvePrivateHlsPath(outputKey));
          cleanupDirectory(resolvedOutputDirectory);
          fs.mkdirSync(path.dirname(resolvedOutputDirectory), { recursive: true });
          fs.renameSync(localOutputDirectory, resolvedOutputDirectory);
        }
      } finally {
        cleanup();
        cleanupDirectory(workspaceDirectory);
      }

      if (!appConfig.videoKeepSourceAfterProcessing && video.storagePath) {
        if ((video.storageProvider || 'local') === 's3') {
          const { deleteStoredPrivateVideo } = require('./private-video-storage.js');
          await deleteStoredPrivateVideo({
            storageProvider: video.storageProvider,
            storagePath: video.storagePath,
          });
        } else if (sourcePath && fs.existsSync(sourcePath)) {
          fs.unlinkSync(sourcePath);
        }
      }

      await testsRepository.updateCompanionVideo(testId, (current) => ({
        ...(current || {}),
        storagePath: appConfig.videoKeepSourceAfterProcessing ? current?.storagePath : null,
        deliveryStrategy: 'hls',
        hlsStorageProvider: outputStorageProvider,
        hlsProcessingStatus: 'ready',
        hlsProcessingCompletedAt: new Date().toISOString(),
        hlsManifestPath: outputKey,
        hlsPlaybackPath: outputKey,
        hlsManifestBundlePath: manifestBundleKey,
        hlsManifestRootPath: outputRootPath,
        hlsManifestVersion: manifestVersion,
        hlsProcessingError: null,
      }));
    } catch (error) {
      const { testsRepository } = require('./repositories.js');
      await testsRepository.updateCompanionVideo(testId, (current) => ({
        ...(current || {}),
        hlsProcessingStatus: 'failed',
        hlsProcessingCompletedAt: new Date().toISOString(),
        hlsProcessingError: error instanceof Error ? error.message : 'Video processing failed.',
      }));
    } finally {
      activeJobs.delete(jobId);
    }
  });
};

module.exports = {
  createInitialVideoDeliveryState,
  scheduleVideoProcessing,
  scheduleTestVideoProcessing,
  recoverPendingCourseVideoProcessingJobs,
  maybeRecoverStaleCourseVideoProcessingJob,
  deleteProcessedHlsAssets,
};
