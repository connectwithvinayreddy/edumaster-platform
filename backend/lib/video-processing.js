const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { appConfig } = require('./config.js');
const { resolveFfmpegPath, resolveFfprobePath } = require('./ffmpeg.js');
const {
  addRedisSetMember,
  removeRedisSetMember,
  getRedisSetMembers,
  publishRedisMessage,
  subscribeRedisChannel,
} = require('./redis.js');
const {
  buildPrivateHlsAssetKey,
  resolvePrivateVideoPath,
  resolvePrivateHlsPath,
  ensureStorageDirectory,
} = require('./private-video.js');
const {
  getPrivateVideoStorageProvider,
  downloadPrivateStorageObjectToFile,
  getPrivateStorageObjectText,
  privateStorageObjectExists,
  uploadPrivateStorageFile,
  deleteStoredPrivateVideoPrefix,
} = require('./private-video-storage.js');
const {
  buildManifestBundleStorageKey,
  createManifestBundleFromDirectory,
  createManifestBundleFromStorage,
  storeManifestBundle,
  writeManifestBundleToDirectory,
} = require('./manifest-bundle.js');

const activeJobs = new Set();
const activeJobMeta = new Map();
const queuedJobs = [];
const queuedJobIds = new Set();
let activeTranscodingJobs = 0;
let recoveryTimer = null;
let remoteEnqueueSubscriber = null;
const backgroundWorkersEnabled = String(process.env.ENABLE_BACKGROUND_WORKERS || 'true').toLowerCase() !== 'false';
const HLS_UPLOAD_CONCURRENCY = Math.max(Number(process.env.VIDEO_HLS_UPLOAD_CONCURRENCY || 8), 1);
const HLS_UPLOAD_RETRY_ATTEMPTS = Math.max(Number(process.env.VIDEO_HLS_UPLOAD_RETRY_ATTEMPTS || 3), 1);
const REMOTE_VIDEO_JOB_SET_KEY = 'video-processing:pending-course-jobs';
const REMOTE_VIDEO_JOB_CHANNEL = 'video-processing:enqueue-course-job';
const LOCAL_QUEUE_STALE_AFTER_MS = Math.max(
  Number(appConfig.videoLocalQueueStaleAfterMs || 45_000),
  5_000,
);
const PROCESSING_STALE_AFTER_MS = Math.max(
  Number(appConfig.videoProcessingStaleAfterMs || 20 * 60 * 1000),
  60_000,
);

const logVideoProcessingEvent = (level, event, payload = {}) => {
  const message = `[video-processing] ${JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...payload,
  })}`;

  if (level === 'warn') {
    console.warn(message);
    return;
  }

  if (level === 'error') {
    console.error(message);
    return;
  }

  console.info(message);
};

const getFfmpegRuntimePath = () => resolveFfmpegPath();

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
  playbackReady: false,
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

const probeSourceDurationSeconds = (sourcePath) => {
  const ffprobePath = resolveFfprobePath();
  if (ffprobePath) {
    try {
      const result = spawnSync(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        sourcePath,
      ], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (!result.error && result.status === 0) {
        const parsed = Number.parseFloat(String(result.stdout || '').trim());
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed;
        }
      }
    } catch {
      // Fall through to the configured baseline timeout.
    }
  }

  return null;
};

const resolveVideoTranscodingTimeoutMs = ({ sourcePath }) => {
  const baselineTimeoutMs = Math.max(Number(appConfig.videoTranscodingJobTimeoutMs || 0), 60_000);
  const durationSeconds = probeSourceDurationSeconds(sourcePath);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return baselineTimeoutMs;
  }

  const durationBasedTimeoutMs = Math.ceil(durationSeconds * 1.5 * 1000);
  const hardCapTimeoutMs = Math.max(
    Number(process.env.VIDEO_TRANSCODING_JOB_TIMEOUT_MAX_MS || 0),
    6 * 60 * 60 * 1000,
  );

  return Math.min(
    Math.max(baselineTimeoutMs, durationBasedTimeoutMs),
    hardCapTimeoutMs,
  );
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

const trimFfmpegErrorOutput = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(-600);

const waitForFfmpeg = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegRuntimePath();
    if (!ffmpegPath) {
      reject(new Error('ffmpeg runtime is unavailable. Install ffmpeg in the runtime image or set FFMPEG_PATH.'));
      return;
    }

    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    let stderrTail = '';
    const timeoutMs = resolveVideoTranscodingTimeoutMs({
      sourcePath: options.sourcePath,
    });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      const details = trimFfmpegErrorOutput(stderrTail);
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)} seconds${details ? `: ${details}` : ''}`));
    }, timeoutMs);
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`;
        if (stderrTail.length > 8000) {
          stderrTail = stderrTail.slice(-8000);
        }
      });
    }
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
      const details = trimFfmpegErrorOutput(stderrTail);
      reject(new Error(`ffmpeg exited with code ${code}${details ? `: ${details}` : ''}`));
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

const createSharedHlsKeyInfoFile = (outputDirectory) => {
  if (!appConfig.privateVideoHlsAesEncryptionEnabled) {
    return null;
  }

  const keyFilePath = path.join(outputDirectory, 'enc.key');
  const keyInfoPath = path.join(outputDirectory, 'enc.keyinfo');
  const iv = crypto.randomBytes(16).toString('hex');

  fs.writeFileSync(keyFilePath, crypto.randomBytes(16));
  fs.writeFileSync(keyInfoPath, `../enc.key\n${keyFilePath}\n${iv}\n`);

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

const hasAudioStream = (sourcePath) => {
  const ffprobePath = resolveFfprobePath();
  if (ffprobePath) {
    try {
      const result = spawnSync(ffprobePath, [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_type',
        '-of', 'csv=p=0',
        sourcePath,
      ], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      if (!result.error && result.status === 0) {
        return String(result.stdout || '').trim().includes('audio');
      }
    } catch {
      // Fall through to ffmpeg-based probe.
    }
  }

  const ffmpegPath = getFfmpegRuntimePath();
  if (!ffmpegPath) {
    return true;
  }

  try {
    const result = spawnSync(ffmpegPath, ['-i', sourcePath], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return /Stream #\d+:\d+(?:\[[^\]]+\])?(?:\([^)]+\))?: Audio:/i.test(output);
  } catch {
    return true;
  }
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

const uploadProcessedHlsDirectory = async ({
  outputDirectory,
  manifestKey,
  expectedAssetRelativePaths = [],
}) => {
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
      uploadTasks.push({
        storagePath: path.posix.join(prefix, relativePath),
        localFilePath: fullPath,
        contentType: hlsAssetMimeTypeByExtension[extension] || 'application/octet-stream',
      });
    });
  };

  walk(outputDirectory);
  await runWithConcurrency(uploadTasks, async (task) => {
    await withRetries(() => uploadPrivateStorageFile({
      storageProvider: 's3',
      storagePath: task.storagePath,
      localFilePath: task.localFilePath,
      contentType: task.contentType,
    }));
  });

  const assetPathsToVerify = expectedAssetRelativePaths.length > 0 ? expectedAssetRelativePaths : listRelativeFiles(outputDirectory);
  await runWithConcurrency(assetPathsToVerify, async (relativePath) => {
    const exists = await withRetries(() => privateStorageObjectExists({
      storageProvider: 's3',
      storagePath: path.posix.join(prefix, relativePath),
    }));
    if (!exists) {
      throw new Error(`Uploaded HLS asset is missing from object storage: ${path.posix.join(prefix, relativePath)}`);
    }
  });
};

const uploadPrivateStorageText = async ({
  storageProvider,
  storagePath,
  text,
  contentType,
  cacheControl,
}) => {
  const tempFilePath = path.join(
    os.tmpdir(),
    `edumaster-hls-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.writeFileSync(tempFilePath, String(text || ''), 'utf8');
  try {
    await uploadPrivateStorageFile({
      storageProvider,
      storagePath,
      localFilePath: tempFilePath,
      contentType,
      cacheControl,
    });
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
};

const buildMasterManifestText = (variants) => {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  variants.forEach((variant) => {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.resolution}`);
    lines.push(`${variant.name}/index.m3u8`);
  });
  return `${lines.join('\n')}\n`;
};

const parseManifestAssetReferences = (manifestText) => String(manifestText || '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split('?')[0])
  .filter((line) => line && !/^[a-z]+:\/\//i.test(line));

const listRelativeFiles = (rootDirectory) => {
  const files = [];
  const walk = (directoryPath) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      files.push(path.relative(rootDirectory, fullPath).split(path.sep).join(path.posix.sep));
    });
  };
  walk(rootDirectory);
  return files.sort();
};

const withRetries = async (operation, attempts = HLS_UPLOAD_RETRY_ATTEMPTS) => {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 3000)));
    }
  }
  throw lastError;
};

const runWithConcurrency = async (items, worker, concurrency = HLS_UPLOAD_CONCURRENCY) => {
  const limit = Math.max(Number(concurrency || HLS_UPLOAD_CONCURRENCY), 1);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => runWorker()));
};

const validateStoredMediaManifest = async ({
  storageProvider,
  rootPath,
  relativeManifestPath,
}) => {
  const manifestStoragePath = path.posix.join(rootPath, relativeManifestPath);
  const manifestText = await getPrivateStorageObjectText({
    storageProvider,
    storagePath: manifestStoragePath,
  });
  if (!manifestText || !String(manifestText).includes('#EXTM3U')) {
    return null;
  }

  const references = parseManifestAssetReferences(manifestText);
  for (const reference of references) {
    const assetRelativePath = path.posix.normalize(
      path.posix.join(path.posix.dirname(relativeManifestPath), reference),
    );
    const exists = await privateStorageObjectExists({
      storageProvider,
      storagePath: path.posix.join(rootPath, assetRelativePath),
    });
    if (!exists) {
      return null;
    }
  }

  return manifestText;
};

const validateLocalHlsDirectory = ({ outputDirectory, requestedQualities }) => {
  const validVariants = [];

  for (const quality of requestedQualities) {
    const profile = renditionProfiles[quality];
    if (!profile) {
      continue;
    }

    const relativeManifestPath = path.posix.join(quality, 'index.m3u8');
    const absoluteManifestPath = path.join(outputDirectory, quality, 'index.m3u8');
    if (!fs.existsSync(absoluteManifestPath)) {
      continue;
    }

    const manifestText = fs.readFileSync(absoluteManifestPath, 'utf8');
    if (!manifestText || !manifestText.includes('#EXTM3U')) {
      continue;
    }

    const references = parseManifestAssetReferences(manifestText);
    const allAssetsPresent = references.every((reference) => {
      const relativeAssetPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativeManifestPath), reference),
      );
      return fs.existsSync(path.join(outputDirectory, ...relativeAssetPath.split('/')));
    });

    if (!allAssetsPresent) {
      continue;
    }

    validVariants.push({
      name: quality,
      bandwidth: profile.bandwidth,
      resolution: profile.resolution,
    });
  }

  if (validVariants.length === 0) {
    throw new Error('No fully valid HLS renditions were produced for this upload.');
  }

  fs.writeFileSync(path.join(outputDirectory, 'master.m3u8'), buildMasterManifestText(validVariants), 'utf8');

  return {
    validVariants,
    assetRelativePaths: listRelativeFiles(outputDirectory),
  };
};

const repairExistingHlsOutputs = async ({
  courseId,
  lesson,
}) => {
  if (!lesson) {
    return null;
  }

  const outputStorageProvider = getRecordedHlsStorageProvider();
  const outputKey = String(lesson.hlsManifestPath || buildPrivateHlsAssetKey({
    courseId,
    moduleId: lesson.moduleId || 'module',
    lessonId: lesson.id,
    assetName: 'master.m3u8',
  }));
  const outputRootPath = path.posix.dirname(outputKey);
  const requestedQualities = Array.isArray(lesson.targetQualities) && lesson.targetQualities.length > 0
    ? lesson.targetQualities
    : getTargetQualities();
  const availableVariants = [];

  for (const quality of requestedQualities) {
    const profile = renditionProfiles[quality];
    if (!profile) {
      continue;
    }

    const variantManifestPath = path.posix.join(quality, 'index.m3u8');
    try {
      const manifestText = await validateStoredMediaManifest({
        storageProvider: outputStorageProvider,
        rootPath: outputRootPath,
        relativeManifestPath: variantManifestPath,
      });
      if (!manifestText) {
        continue;
      }
      availableVariants.push({
        name: quality,
        bandwidth: profile.bandwidth,
        resolution: profile.resolution,
      });
    } catch {
      // Ignore missing renditions and keep probing.
    }
  }

  if (availableVariants.length === 0) {
    return null;
  }

  const manifestVersion = Date.now().toString(36);
  await uploadPrivateStorageText({
    storageProvider: outputStorageProvider,
    storagePath: outputKey,
    text: buildMasterManifestText(availableVariants),
    contentType: hlsAssetMimeTypeByExtension['.m3u8'],
    cacheControl: 'private, max-age=300, stale-while-revalidate=3600',
  });

  const bundle = await createManifestBundleFromStorage({
    storageProvider: outputStorageProvider,
    manifestPath: outputKey,
    version: manifestVersion,
  });
  const manifestBundleKey = await storeManifestBundle({
    storageProvider: outputStorageProvider,
    bundlePath: bundle.bundlePath,
    bundle,
  });

  return {
    outputKey,
    outputRootPath,
    manifestBundleKey,
    manifestVersion,
    availableQualities: availableVariants.map((variant) => variant.name),
    outputStorageProvider,
  };
};

const transcodeToHls = async ({ sourcePath, outputDirectory, qualities }) => {
  cleanupDirectory(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const variants = qualities
    .map((quality) => ({
      name: quality,
      profile: renditionProfiles[quality],
    }))
    .filter((entry) => entry.profile);

  if (variants.length === 0) {
    throw new Error('No supported target renditions were requested for HLS packaging.');
  }

  if (variants.length === 1) {
    const [{ name, profile }] = variants;
    const variantDir = path.join(outputDirectory, name);
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

    await waitForFfmpeg(args, { sourcePath });
    if (keyInfoPath && fs.existsSync(keyInfoPath)) {
      fs.unlinkSync(keyInfoPath);
    }
    writeMasterManifest({
      outputDirectory,
      variants: [{
        name,
        bandwidth: profile.bandwidth,
        resolution: profile.resolution,
      }],
    });
    return;
  }

  const audioPresent = hasAudioStream(sourcePath);
  const splitOutputs = variants.map((_, index) => `[video_${index}]`).join('');
  const filterGraph = [
    `[0:v]split=${variants.length}${splitOutputs}`,
    ...variants.map(({ profile }, index) =>
      `[video_${index}]scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2[scaled_${index}]`),
  ].join(';');

  const keyInfoPath = createSharedHlsKeyInfoFile(outputDirectory);
  const args = [
    '-y',
    '-i', sourcePath,
    '-filter_complex', filterGraph,
  ];

  variants.forEach((_, index) => {
    args.push('-map', `[scaled_${index}]`);
    if (audioPresent) {
      args.push('-map', '0:a:0');
    }
  });

  variants.forEach(({ profile }, index) => {
    args.push(`-c:v:${index}`, 'libx264');
    args.push(`-preset:v:${index}`, 'veryfast');
    args.push(`-profile:v:${index}`, 'main');
    args.push(`-crf:v:${index}`, '23');
    args.push(`-sc_threshold:v:${index}`, '0');
    args.push(`-g:v:${index}`, '48');
    args.push(`-keyint_min:v:${index}`, '48');
    args.push(`-b:v:${index}`, profile.videoBitrate);
    args.push(`-maxrate:v:${index}`, profile.maxRate);
    args.push(`-bufsize:v:${index}`, profile.bufferSize);
    if (audioPresent) {
      args.push(`-c:a:${index}`, 'aac');
      args.push(`-ar:a:${index}`, '48000');
      args.push(`-b:a:${index}`, '128k');
      args.push(`-ac:a:${index}`, '2');
    }
  });

  const variantStreamMap = variants.map((entry, index) =>
    audioPresent
      ? `v:${index},a:${index},name:${entry.name}`
      : `v:${index},name:${entry.name}`).join(' ');

  args.push(
    '-f', 'hls',
    '-hls_time', String(appConfig.videoHlsSegmentDurationSeconds),
    '-hls_flags', 'independent_segments',
    '-hls_playlist_type', 'vod',
    ...(keyInfoPath ? ['-hls_key_info_file', keyInfoPath] : []),
    '-var_stream_map', variantStreamMap,
    '-hls_segment_filename', path.join(outputDirectory, '%v', 'segment_%03d.ts'),
    path.join(outputDirectory, '%v', 'index.m3u8'),
  );

  await waitForFfmpeg(args, { sourcePath });
  if (keyInfoPath && fs.existsSync(keyInfoPath)) {
    fs.unlinkSync(keyInfoPath);
  }

  writeMasterManifest({
    outputDirectory,
    variants: variants.map(({ name, profile }) => ({
      name,
      bandwidth: profile.bandwidth,
      resolution: profile.resolution,
    })),
  });
};

const markActiveJobQueued = ({ jobId, courseId, lessonId, source }) => {
  activeJobs.add(jobId);
  activeJobMeta.set(jobId, {
    jobId,
    courseId: String(courseId),
    lessonId: String(lessonId),
    phase: 'queued',
    source: source || 'unknown',
    queuedAtMs: Date.now(),
    startedAtMs: null,
  });
};

const markActiveJobRunning = (jobId) => {
  const current = activeJobMeta.get(jobId) || { jobId, queuedAtMs: Date.now() };
  activeJobMeta.set(jobId, {
    ...current,
    phase: 'running',
    startedAtMs: Date.now(),
  });
};

const clearActiveJob = (jobId) => {
  activeJobs.delete(jobId);
  activeJobMeta.delete(jobId);
};

const isQueuedJobStale = (jobId) => {
  const meta = activeJobMeta.get(jobId);
  if (!meta || meta.phase !== 'queued') {
    return false;
  }
  return Date.now() - Number(meta.queuedAtMs || 0) > LOCAL_QUEUE_STALE_AFTER_MS;
};

const isRunningJobStale = (jobId) => {
  const meta = activeJobMeta.get(jobId);
  if (!meta || meta.phase !== 'running') {
    return false;
  }
  return Date.now() - Number(meta.startedAtMs || meta.queuedAtMs || 0) > PROCESSING_STALE_AFTER_MS;
};

const releaseActiveJobLock = (jobId, reason) => {
  const meta = activeJobMeta.get(jobId);
  if (!meta) {
    return false;
  }
  clearActiveJob(jobId);
  logVideoProcessingEvent('warn', 'local-lock-released', {
    jobId,
    courseId: meta.courseId,
    lessonId: meta.lessonId,
    phase: meta.phase,
    reason,
  });
  return true;
};

const runQueuedVideoJob = (jobId, job) => {
  markActiveJobRunning(jobId);
  logVideoProcessingEvent('info', 'job-picked-up', {
    jobId,
    activeTranscodingJobs: activeTranscodingJobs + 1,
    queuedJobs: queuedJobs.length,
  });
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
      queuedJobIds.delete(nextJob.jobId);
      runQueuedVideoJob(nextJob.jobId, nextJob.job);
    }
  }
};

const enqueueVideoProcessingJob = ({ jobId, job }) => {
  if (queuedJobIds.has(jobId)) {
    return false;
  }
  queuedJobIds.add(jobId);
  queuedJobs.push({ jobId, job });
  logVideoProcessingEvent('info', 'job-enqueued-locally', {
    jobId,
    queuedJobs: queuedJobs.length,
    activeTranscodingJobs,
  });
  drainVideoProcessingQueue();
  return true;
};

const encodeRemoteVideoJob = ({ courseId, lessonId }) => `${String(courseId)}:${String(lessonId)}`;

const decodeRemoteVideoJob = (value) => {
  const normalized = String(value || '').trim();
  const separatorIndex = normalized.indexOf(':');
  if (!normalized || separatorIndex <= 0 || separatorIndex >= normalized.length - 1) {
    return null;
  }

  return {
    jobId: normalized,
    courseId: normalized.slice(0, separatorIndex),
    lessonId: normalized.slice(separatorIndex + 1),
  };
};

const persistRemoteVideoProcessingRequest = async ({ courseId, lessonId }) => {
  const payload = encodeRemoteVideoJob({ courseId, lessonId });
  await addRedisSetMember(REMOTE_VIDEO_JOB_SET_KEY, payload);
  logVideoProcessingEvent('info', 'job-persisted-remotely', { jobId: payload });
  return payload;
};

const publishRemoteVideoProcessingRequest = async ({ jobId }) => {
  await publishRedisMessage(REMOTE_VIDEO_JOB_CHANNEL, jobId);
  logVideoProcessingEvent('info', 'job-published-remotely', { jobId });
};

const drainRemoteVideoProcessingRequests = async () => {
  if (!backgroundWorkersEnabled) {
    return { queued: 0, scheduled: 0 };
  }

  const members = await getRedisSetMembers(REMOTE_VIDEO_JOB_SET_KEY).catch(() => []);
  let scheduled = 0;

  for (const rawMember of members) {
    const parsed = decodeRemoteVideoJob(rawMember);
    if (!parsed) {
      await removeRedisSetMember(REMOTE_VIDEO_JOB_SET_KEY, rawMember).catch(() => undefined);
      continue;
    }

    if (activeJobs.has(parsed.jobId)) {
      if (isQueuedJobStale(parsed.jobId) && !queuedJobIds.has(parsed.jobId)) {
        releaseActiveJobLock(parsed.jobId, 'stale-queued-lock-detected-during-remote-drain');
      } else {
        continue;
      }
    }

    if (await scheduleVideoProcessing({
      courseId: parsed.courseId,
      lessonId: parsed.lessonId,
      alreadyPersisted: true,
      announceRemote: false,
      source: 'remote-drain',
    })) {
      scheduled += 1;
      await removeRedisSetMember(REMOTE_VIDEO_JOB_SET_KEY, parsed.jobId).catch(() => undefined);
    }
  }

  return {
    queued: members.length,
    scheduled,
  };
};

const isLessonProcessingStale = (lesson) => {
  const staleAfterMs = Math.max(Number(appConfig.videoProcessingStaleAfterMs || 0), 60_000);
  const startedAt = Date.parse(lesson?.hlsProcessingStartedAt || lesson?.hlsProcessingQueuedAt || lesson?.uploadedAt || 0);
  return Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt > staleAfterMs;
};

const scheduleVideoProcessing = async ({
  courseId,
  lessonId,
  alreadyPersisted = false,
  announceRemote = !backgroundWorkersEnabled,
  source = 'direct',
} = {}) => {
  if (!appConfig.enableVideoTranscoding) {
    return false;
  }

  const jobId = `${courseId}:${lessonId}`;

  if (!alreadyPersisted) {
    try {
      await persistRemoteVideoProcessingRequest({ courseId, lessonId });
    } catch (error) {
      logVideoProcessingEvent('error', 'job-persist-failed', {
        jobId,
        courseId,
        lessonId,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  if (!backgroundWorkersEnabled) {
    if (announceRemote) {
      await publishRemoteVideoProcessingRequest({ jobId });
    }
    return true;
  }

  if (activeJobs.has(jobId)) {
    if (isQueuedJobStale(jobId) && !queuedJobIds.has(jobId)) {
      releaseActiveJobLock(jobId, 'stale-queued-lock-detected-during-schedule');
    } else {
      logVideoProcessingEvent('info', 'job-deduplicated', {
        jobId,
        courseId,
        lessonId,
        source,
        phase: activeJobMeta.get(jobId)?.phase || 'active',
      });
      return false;
    }
  }
  markActiveJobQueued({ jobId, courseId, lessonId, source });

  enqueueVideoProcessingJob({ jobId, job: async () => {
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
        logVideoProcessingEvent('warn', 'job-failed-missing-source', {
          jobId,
          courseId,
          lessonId,
        });
        return;
      }

      await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
        ...current,
        sourceFallbackAllowed: false,
        playbackReady: false,
        hlsProcessingStatus: 'processing',
        hlsProcessingStartedAt: new Date().toISOString(),
        hlsProcessingError: null,
      }));
      logVideoProcessingEvent('info', 'job-started', {
        jobId,
        courseId,
        lessonId,
      });

      const workspaceDirectory = createTemporaryWorkspace(jobId);
      const manifestVersion = Date.now().toString(36);
      const outputKey = buildPrivateHlsAssetKey({
        courseId,
        moduleId: lesson.moduleId || 'module',
        lessonId,
        assetVersion: `v-${manifestVersion}`,
        assetName: 'master.m3u8',
      });
      const outputRootPath = path.posix.dirname(outputKey);
      const manifestBundleKey = buildManifestBundleStorageKey(outputKey);
      const localOutputDirectory = path.join(workspaceDirectory, 'hls');
      const outputStorageProvider = getRecordedHlsStorageProvider();
      const previousManifestPath = lesson.hlsManifestPath ? String(lesson.hlsManifestPath) : null;
      const previousStorageProvider = lesson.hlsStorageProvider || null;
      let sourceDownload;
      try {
        sourceDownload = await downloadStorageSourceToLocal({
          lesson,
          workspaceDirectory,
        });
      } catch (error) {
        const repaired = await repairExistingHlsOutputs({
          courseId,
          lesson,
        });
        if (repaired) {
          await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
            ...current,
            deliveryStrategy: 'hls',
            sourceFallbackAllowed: false,
            playbackReady: true,
            hlsStorageProvider: repaired.outputStorageProvider,
            hlsProcessingStatus: 'ready',
            hlsProcessingCompletedAt: new Date().toISOString(),
            hlsManifestPath: repaired.outputKey,
            hlsPlaybackPath: repaired.outputKey,
            hlsManifestBundlePath: repaired.manifestBundleKey,
            hlsManifestRootPath: repaired.outputRootPath,
            hlsManifestVersion: repaired.manifestVersion,
            hlsProcessingError: null,
            targetQualities: repaired.availableQualities,
          }));
          cleanupDirectory(workspaceDirectory);
          logVideoProcessingEvent('info', 'job-repaired-from-existing-assets', {
            jobId,
            courseId,
            lessonId,
          });
          return;
        }
        throw error;
      }
      const { sourcePath, cleanup } = sourceDownload;
      let validatedOutputs = null;

      try {
        await transcodeToHls({
          sourcePath,
          outputDirectory: localOutputDirectory,
          qualities: Array.isArray(lesson.targetQualities) && lesson.targetQualities.length > 0 ? lesson.targetQualities : getTargetQualities(),
        });
        validatedOutputs = validateLocalHlsDirectory({
          outputDirectory: localOutputDirectory,
          requestedQualities: Array.isArray(lesson.targetQualities) && lesson.targetQualities.length > 0 ? lesson.targetQualities : getTargetQualities(),
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
          await uploadProcessedHlsDirectory({
            outputDirectory: localOutputDirectory,
            manifestKey: outputKey,
            expectedAssetRelativePaths: validatedOutputs.assetRelativePaths,
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
        sourceFallbackAllowed: false,
        playbackReady: true,
        hlsStorageProvider: outputStorageProvider,
        hlsProcessingStatus: 'ready',
        hlsProcessingCompletedAt: new Date().toISOString(),
        hlsManifestPath: outputKey,
        hlsPlaybackPath: outputKey,
        hlsManifestBundlePath: manifestBundleKey,
        hlsManifestRootPath: outputRootPath,
        hlsManifestVersion: manifestVersion,
        hlsProcessingError: null,
        targetQualities: validatedOutputs ? validatedOutputs.validVariants.map((variant) => variant.name) : current.targetQualities,
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

      if (previousManifestPath && path.posix.dirname(previousManifestPath) !== outputRootPath) {
        await deleteProcessedHlsAssets(previousManifestPath, previousStorageProvider).catch(() => undefined);
      }
      logVideoProcessingEvent('info', 'job-finished', {
        jobId,
        courseId,
        lessonId,
        manifestPath: outputKey,
      });
    } catch (error) {
      const { coursesRepository } = require('./repositories.js');
      await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
        ...current,
        sourceFallbackAllowed: false,
        playbackReady: false,
        hlsProcessingStatus: 'failed',
        hlsProcessingCompletedAt: new Date().toISOString(),
        hlsProcessingError: error instanceof Error ? error.message : 'Video processing failed.',
      }));
      logVideoProcessingEvent('error', 'job-failed', {
        jobId,
        courseId,
        lessonId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      void removeRedisSetMember(REMOTE_VIDEO_JOB_SET_KEY, jobId).catch(() => undefined);
      clearActiveJob(jobId);
    }
  }});

  return true;
};

const recoverPendingCourseVideoProcessingJobs = async ({ forceRestartRecovery = false } = {}) => {
  const cloudflareStreamEnabled = String(appConfig.videoProcessingProvider || '').toLowerCase() === 'cloudflare-stream';
  if ((!appConfig.enableVideoTranscoding && !cloudflareStreamEnabled) || !backgroundWorkersEnabled) {
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

        if (status === 'queued') {
          if (await scheduleVideoProcessing({
            courseId: course._id,
            lessonId: lesson.id,
            source: forceRestartRecovery ? 'startup-recovery' : 'periodic-recovery',
          })) {
            scheduled += 1;
          }
          continue;
        }

        const shouldForceRecover = forceRestartRecovery && status === 'processing';
        if (!shouldForceRecover && !isLessonProcessingStale(lesson)) {
          continue;
        }

        const requeuedLesson = await coursesRepository.updateLesson(course._id, lesson.id, (current) => ({
          ...current,
          sourceFallbackAllowed: false,
          playbackReady: false,
          hlsProcessingStatus: 'queued',
          hlsProcessingQueuedAt: new Date().toISOString(),
          hlsProcessingStartedAt: null,
          hlsProcessingError: null,
        }));
        if (requeuedLesson && await scheduleVideoProcessing({
          courseId: course._id,
          lessonId: lesson.id,
          source: 'stale-recovery',
        })) {
          scheduled += 1;
        }
      }
    }
  }

  return { scanned, scheduled };
};

const maybeRecoverStaleCourseVideoProcessingJob = async ({ courseId, lesson }) => {
  if (!appConfig.enableVideoTranscoding || !lesson || !backgroundWorkersEnabled) {
    return false;
  }

  const status = String(lesson.hlsProcessingStatus || '').toLowerCase();
  const stale = isLessonProcessingStale(lesson);
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
    sourceFallbackAllowed: false,
    playbackReady: false,
    hlsProcessingStatus: 'queued',
    hlsProcessingQueuedAt: new Date().toISOString(),
    hlsProcessingStartedAt: null,
    hlsProcessingError: null,
  }));

  if (!updatedLesson) {
    return false;
  }

  return scheduleVideoProcessing({ courseId, lessonId: lesson.id, source: 'player-stale-recovery' });
};

const repairCourseLessonHlsOutputs = async ({ courseId, lessonId }) => {
  const { coursesRepository } = require('./repositories.js');
  const course = await coursesRepository.findById(courseId);
  const lesson = course ? course.modules.flatMap((module) => ([
    ...(module.lessons || []),
    ...((module.chapters || []).flatMap((chapter) => chapter.lessons || [])),
  ])).find((entry) => entry.id === String(lessonId)) : null;

  if (!lesson) {
    throw new Error(`Lesson ${lessonId} was not found in course ${courseId}.`);
  }

  const repaired = await repairExistingHlsOutputs({
    courseId,
    lesson,
  });

  if (repaired) {
    await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
      ...current,
      deliveryStrategy: 'hls',
      sourceFallbackAllowed: false,
      playbackReady: true,
      hlsStorageProvider: repaired.outputStorageProvider,
      hlsProcessingStatus: 'ready',
      hlsProcessingCompletedAt: new Date().toISOString(),
      hlsManifestPath: repaired.outputKey,
      hlsPlaybackPath: repaired.outputKey,
      hlsManifestBundlePath: repaired.manifestBundleKey,
      hlsManifestRootPath: repaired.outputRootPath,
      hlsManifestVersion: repaired.manifestVersion,
      hlsProcessingError: null,
      targetQualities: repaired.availableQualities,
    }));
    return {
      status: 'repaired',
      availableQualities: repaired.availableQualities,
      manifestPath: repaired.outputKey,
    };
  }

  if (lesson.storagePath) {
    const updatedLesson = await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
      ...current,
      sourceFallbackAllowed: false,
      playbackReady: false,
      hlsProcessingStatus: 'queued',
      hlsProcessingQueuedAt: new Date().toISOString(),
      hlsProcessingStartedAt: null,
      hlsProcessingCompletedAt: null,
      hlsProcessingError: null,
    }));
    if (updatedLesson) {
      await scheduleVideoProcessing({ courseId, lessonId, source: 'admin-retry' });
      return {
        status: 'requeued',
        availableQualities: [],
        manifestPath: null,
      };
    }
  }

  await coursesRepository.updateLesson(courseId, lessonId, (current) => ({
    ...current,
    sourceFallbackAllowed: false,
    playbackReady: false,
    hlsProcessingStatus: 'failed',
    hlsProcessingCompletedAt: new Date().toISOString(),
    hlsProcessingError: 'No healthy HLS renditions were found and no source file is available for reprocessing.',
  }));

  return {
    status: 'failed',
    availableQualities: [],
    manifestPath: null,
  };
};

const scheduleTestVideoProcessing = ({ testId }) => {
  if (!appConfig.enableVideoTranscoding || !backgroundWorkersEnabled) {
    return false;
  }

  const jobId = `test:${testId}`;
  if (activeJobs.has(jobId)) {
    return false;
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

      const workspaceDirectory = createTemporaryWorkspace(jobId);
      const videoId = String(video.id || `test-video-${testId}`);
      const manifestVersion = Date.now().toString(36);
      const outputKey = buildPrivateHlsAssetKey({
        courseId: 'tests',
        moduleId: testId,
        lessonId: videoId,
        assetVersion: `v-${manifestVersion}`,
        assetName: 'master.m3u8',
      });
      const outputRootPath = path.posix.dirname(outputKey);
      const manifestBundleKey = buildManifestBundleStorageKey(outputKey);
      const localOutputDirectory = path.join(workspaceDirectory, 'hls');
      const outputStorageProvider = getRecordedHlsStorageProvider();
      const previousManifestPath = video.hlsManifestPath ? String(video.hlsManifestPath) : null;
      const previousStorageProvider = video.hlsStorageProvider || null;
      const { sourcePath, cleanup } = await downloadStorageSourceToLocal({
        lesson: video,
        workspaceDirectory,
      });
      let validatedOutputs = null;

      try {
        await transcodeToHls({
          sourcePath,
          outputDirectory: localOutputDirectory,
          qualities: Array.isArray(video.targetQualities) && video.targetQualities.length > 0 ? video.targetQualities : getTargetQualities(),
        });
        validatedOutputs = validateLocalHlsDirectory({
          outputDirectory: localOutputDirectory,
          requestedQualities: Array.isArray(video.targetQualities) && video.targetQualities.length > 0 ? video.targetQualities : getTargetQualities(),
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
          await uploadProcessedHlsDirectory({
            outputDirectory: localOutputDirectory,
            manifestKey: outputKey,
            expectedAssetRelativePaths: validatedOutputs.assetRelativePaths,
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
        targetQualities: validatedOutputs ? validatedOutputs.validVariants.map((variant) => variant.name) : current?.targetQualities,
      }));

      if (previousManifestPath && path.posix.dirname(previousManifestPath) !== outputRootPath) {
        await deleteProcessedHlsAssets(previousManifestPath, previousStorageProvider).catch(() => undefined);
      }
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

  return true;
};

const startVideoProcessingRecoveryLoop = () => {
  if (!appConfig.enableVideoTranscoding || !backgroundWorkersEnabled || recoveryTimer) {
    return () => undefined;
  }

  const pollMs = Math.max(Number(appConfig.videoProcessingRecoveryPollMs || 0), 5_000);
  const tick = () => {
    drainRemoteVideoProcessingRequests().catch((error) => {
      console.error('[video-processing] remote request drain failed', error);
    });
    recoverPendingCourseVideoProcessingJobs().catch((error) => {
      console.error('[video-processing] periodic recovery failed', error);
    });
  };

  if (!remoteEnqueueSubscriber) {
    remoteEnqueueSubscriber = subscribeRedisChannel({
      channel: REMOTE_VIDEO_JOB_CHANNEL,
      onMessage(message) {
        const parsed = decodeRemoteVideoJob(message);
        if (!parsed) {
          return;
        }
        if (activeJobs.has(parsed.jobId)) {
          return;
        }
        void scheduleVideoProcessing({
          courseId: parsed.courseId,
          lessonId: parsed.lessonId,
          alreadyPersisted: true,
          announceRemote: false,
          source: 'redis-pubsub',
        }).then((scheduled) => {
          if (scheduled) {
            void removeRedisSetMember(REMOTE_VIDEO_JOB_SET_KEY, parsed.jobId).catch(() => undefined);
          }
        }).catch((error) => {
          console.error('[video-processing] remote enqueue schedule failed', error);
        });
      },
      onError(error) {
        console.error('[video-processing] remote enqueue subscriber failed', error);
      },
    });
  }

  recoveryTimer = setInterval(tick, pollMs);
  if (typeof recoveryTimer.unref === 'function') {
    recoveryTimer.unref();
  }
  tick();

  return () => {
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
    if (remoteEnqueueSubscriber) {
      remoteEnqueueSubscriber.close();
      remoteEnqueueSubscriber = null;
    }
  };
};

module.exports = {
  createInitialVideoDeliveryState,
  scheduleVideoProcessing,
  scheduleTestVideoProcessing,
  recoverPendingCourseVideoProcessingJobs,
  maybeRecoverStaleCourseVideoProcessingJob,
  repairCourseLessonHlsOutputs,
  startVideoProcessingRecoveryLoop,
  deleteProcessedHlsAssets,
  transcodeToHls,
};
