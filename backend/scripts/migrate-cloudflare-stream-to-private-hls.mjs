import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const { resolveFfmpegPath } = require('../lib/ffmpeg.js');
const crypto = require('crypto');
const { connectDatabase } = require('../lib/database.js');
const { appConfig } = require('../lib/config.js');
const { coursesRepository } = require('../lib/repositories.js');
const { transcodeToHls: sharedTranscodeToHls } = require('../lib/video-processing.js');
const {
  resolveVideoDownloadUrl,
  syncCloudflareStreamVideoStatus,
  deleteCloudflareStreamVideo,
  isCloudflareStreamConfigured,
} = require('../lib/cloudflare-stream.js');
const {
  buildPrivateHlsAssetKey,
} = require('../lib/private-video.js');
const {
  uploadPrivateStorageFile,
  deleteStoredPrivateVideoPrefix,
} = require('../lib/private-video-storage.js');
const {
  buildManifestBundleStorageKey,
  createManifestBundleFromDirectory,
  writeManifestBundleToDirectory,
} = require('../lib/manifest-bundle.js');

const TARGET_COURSE_ID = String(process.env.MIGRATE_COURSE_ID || '').trim();
const TARGET_LESSON_ID = String(process.env.MIGRATE_LESSON_ID || '').trim();
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_DRY_RUN || '').toLowerCase());
const DELETE_STREAM_AFTER_SUCCESS = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_DELETE_STREAM_AFTER_SUCCESS || '').toLowerCase());
const KEEP_STREAM_AS_ROLLBACK = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_KEEP_STREAM_AS_ROLLBACK || 'true').toLowerCase());
const MAX_LESSONS = Math.max(Number(process.env.MIGRATE_MAX_LESSONS || 0), 0);
const DESIRED_DELIVERY_PROFILE = String(process.env.MIGRATE_DELIVERY_PROFILE || appConfig.videoDeliveryProfile || 'r2-private-hls').trim() || 'r2-private-hls';
const ENV_TARGET_QUALITIES = String(process.env.MIGRATE_TARGET_QUALITIES || '')
  .split(',')
  .map((entry) => String(entry || '').trim())
  .filter(Boolean);
const MIGRATE_UPLOAD_CONCURRENCY = Math.max(Number(process.env.MIGRATE_UPLOAD_CONCURRENCY || 4), 1);
const MIGRATE_UPLOAD_RETRY_ATTEMPTS = Math.max(Number(process.env.MIGRATE_UPLOAD_RETRY_ATTEMPTS || 5), 1);
const SUPPORTED_QUALITIES = ['240p', '360p', '480p', '720p'];
const DOWNLOAD_TYPE = String(process.env.MIGRATE_DOWNLOAD_TYPE || 'default').trim().toLowerCase() || 'default';
const DOWNLOAD_READY_MAX_ATTEMPTS = Math.max(Number(process.env.MIGRATE_DOWNLOAD_READY_MAX_ATTEMPTS || 12), 1);
const DOWNLOAD_READY_DELAY_MS = Math.max(Number(process.env.MIGRATE_DOWNLOAD_READY_DELAY_MS || 5000), 1000);
const DOWNLOAD_PROBE_BYTES = Math.max(Number(process.env.MIGRATE_DOWNLOAD_PROBE_BYTES || 1024), 256);

const cloudflareHostPattern = /cloudflarestream\.com|videodelivery\.net/i;

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
  '.json': 'application/json',
};

const getTargetQualities = (lesson) => {
  const envConfigured = ENV_TARGET_QUALITIES
    .filter((entry) => SUPPORTED_QUALITIES.includes(entry));
  if (envConfigured.length > 0) {
    return envConfigured;
  }

  const lessonQualities = Array.isArray(lesson?.targetQualities) ? lesson.targetQualities : [];
  const configured = lessonQualities.length > 0 ? lessonQualities : appConfig.videoTargetRenditions;
  const result = (Array.isArray(configured) ? configured : [])
    .map((entry) => String(entry || '').trim())
    .filter((entry) => SUPPORTED_QUALITIES.includes(entry));
  return result.length > 0 ? result : ['240p', '360p', '480p', '720p'];
};

const collectLessons = (course) => (course.modules || []).flatMap((module) => ([
  ...(module.lessons || []).map((lesson) => ({ ...lesson, moduleId: module.id || lesson.moduleId || 'module' })),
  ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => ({
    ...lesson,
    moduleId: module.id || lesson.moduleId || 'module',
    chapterId: chapter.id || lesson.chapterId || null,
  })))),
]));

const isCloudflareStreamLesson = (lesson) => {
  const provider = String(lesson?.storageProvider || lesson?.streamProvider || lesson?.hlsStorageProvider || '').toLowerCase();
  return provider === 'cloudflare-stream'
    || Boolean(String(lesson?.cloudflareStreamUid || '').trim())
    || cloudflareHostPattern.test(String(lesson?.hlsPlaybackPath || ''))
    || cloudflareHostPattern.test(String(lesson?.hlsManifestPath || ''))
    || cloudflareHostPattern.test(String(lesson?.streamUrl || ''));
};

const waitForFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      reject(new Error('ffmpeg runtime is unavailable. Install ffmpeg in the runtime image or set FFMPEG_PATH.'));
      return;
    }
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

const createTemporaryWorkspace = (lessonId) => fs.mkdtempSync(
  path.join(os.tmpdir(), `edumaster-stream-migrate-${String(lessonId || 'lesson').replace(/[^a-zA-Z0-9_-]/g, '_')}-`),
);

const cleanupDirectory = (directoryPath) => {
  if (directoryPath && fs.existsSync(directoryPath)) {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetries = async (operation, {
  attempts = MIGRATE_UPLOAD_RETRY_ATTEMPTS,
  baseDelayMs = 500,
  onRetry = null,
} = {}) => {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      if (typeof onRetry === 'function') {
        onRetry(error, attempt);
      }
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
};

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

const transcodeToHls = async ({ sourcePath, outputDirectory, qualities }) =>
  sharedTranscodeToHls({ sourcePath, outputDirectory, qualities });

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
      uploadTasks.push({
        storagePath: path.posix.join(prefix, relativePath),
        localFilePath: fullPath,
        contentType: hlsAssetMimeTypeByExtension[extension] || 'application/octet-stream',
        cacheControl: relativePath.endsWith('.m3u8')
          ? 'private, max-age=60, stale-while-revalidate=600'
          : 'private, max-age=31536000, immutable',
      });
    });
  };

  walk(outputDirectory);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < uploadTasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const task = uploadTasks[currentIndex];
      await withRetries(() => uploadPrivateStorageFile({
        storageProvider: 's3',
        storagePath: task.storagePath,
        localFilePath: task.localFilePath,
        contentType: task.contentType,
        cacheControl: task.cacheControl,
      }), {
        onRetry: (error, attempt) => {
          console.warn(`[stream-migrate] retrying upload for ${task.storagePath} after attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
        },
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MIGRATE_UPLOAD_CONCURRENCY, uploadTasks.length || 1) }, () => runWorker()),
  );
};

const downloadStreamMp4ToFile = async ({ downloadUrl, destinationPath }) => {
  if (!downloadUrl) {
    throw new Error('Cloudflare Stream downloadable MP4 URL is missing.');
  }

  let response = null;
  for (let attempt = 1; attempt <= DOWNLOAD_READY_MAX_ATTEMPTS; attempt += 1) {
    response = await fetch(downloadUrl);
    if (response.ok && response.body) {
      break;
    }

    const retryable = [202, 404, 409, 423, 425, 429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt >= DOWNLOAD_READY_MAX_ATTEMPTS) {
      throw new Error(`Cloudflare Stream download failed with ${response.status} for ${downloadUrl}`);
    }

    await sleep(DOWNLOAD_READY_DELAY_MS);
  }

  const tempPath = `${destinationPath}.download`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
  fs.renameSync(tempPath, destinationPath);
};

const probeDownloadUrl = async (downloadUrl) => {
  if (!downloadUrl) {
    return false;
  }

  try {
    const response = await fetch(downloadUrl, {
      headers: {
        Range: `bytes=0-${Math.max(DOWNLOAD_PROBE_BYTES - 1, 0)}`,
      },
    });
    if (!response.ok || !response.body) {
      return false;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return false;
    }

    return response.status === 200
      || response.status === 206
      || contentType.startsWith('video/');
  } catch {
    return false;
  }
};

const resolveLegacyStreamManifestUrl = async (lesson) => {
  const candidateUrls = [
    lesson?.hlsPlaybackPath,
    lesson?.hlsManifestPath,
    lesson?.streamUrl,
    lesson?.legacyCloudflareStream?.hlsPlaybackPath,
    lesson?.legacyCloudflareStream?.streamUrl,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const firstCloudflareManifest = candidateUrls.find((value) => cloudflareHostPattern.test(value) && value.includes('.m3u8'));
  return firstCloudflareManifest || null;
};

const resolveMigrationSource = async ({ lesson, workspaceDirectory }) => {
  const downloadUrl = await resolveStreamDownloadUrl(lesson);
  if (downloadUrl) {
    try {
      const reachable = await probeDownloadUrl(downloadUrl);
      if (reachable) {
        return {
          sourcePath: downloadUrl,
          downloadUrl,
          sourceType: 'downloadable-mp4-url',
        };
      }
    } catch (error) {
      const manifestUrl = await resolveLegacyStreamManifestUrl(lesson);
      if (!manifestUrl) {
        throw error;
      }
    }

    const downloadedSourcePath = path.join(workspaceDirectory, 'source.mp4');
    try {
      await downloadStreamMp4ToFile({ downloadUrl, destinationPath: downloadedSourcePath });
      return {
        sourcePath: downloadedSourcePath,
        downloadUrl,
        sourceType: 'downloadable-mp4-file',
      };
    } catch (error) {
      const manifestUrl = await resolveLegacyStreamManifestUrl(lesson);
      if (!manifestUrl) {
        throw error;
      }
      console.warn(`[stream-migrate] MP4 download unavailable for ${lesson.id}; falling back to legacy HLS manifest source`);
      return {
        sourcePath: manifestUrl,
        downloadUrl,
        sourceType: 'legacy-hls-manifest',
      };
    }
  }

  const manifestUrl = await resolveLegacyStreamManifestUrl(lesson);
  if (!manifestUrl) {
    throw new Error('Legacy Stream lesson has no usable downloadable MP4 URL or HLS manifest.');
  }
  return {
    sourcePath: manifestUrl,
    downloadUrl: null,
    sourceType: 'legacy-hls-manifest',
  };
};

const resolveStreamDownloadUrl = async (lesson) => {
  const uid = String(lesson?.cloudflareStreamUid || lesson?.streamUid || '').trim();
  if (!uid) {
    return null;
  }
  if (!isCloudflareStreamConfigured()) {
    return null;
  }
  return resolveVideoDownloadUrl(uid, { type: DOWNLOAD_TYPE, tokenTtlSeconds: 3600 });
};

const updateLessonToPrivateHls = async ({
  courseId,
  lesson,
  manifestKey,
  manifestBundleKey,
  manifestRootPath,
  manifestVersion,
  durationMinutes,
  targetQualities,
}) => {
  const now = new Date().toISOString();
  const previousStreamState = {
    uid: lesson.cloudflareStreamUid || lesson.streamUid || null,
    storageProvider: lesson.storageProvider || null,
    streamProvider: lesson.streamProvider || null,
    hlsStorageProvider: lesson.hlsStorageProvider || null,
    hlsPlaybackPath: lesson.hlsPlaybackPath || null,
    hlsManifestPath: lesson.hlsManifestPath || null,
    streamUrl: lesson.streamUrl || null,
    dashStreamUrl: lesson.dashStreamUrl || null,
    cloudflareStreamStatus: lesson.cloudflareStreamStatus || null,
    cloudflareStreamReadyToStream: lesson.cloudflareStreamReadyToStream ?? null,
    migratedAt: now,
    rollbackDeleteAfter: new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)).toISOString(),
  };
  return coursesRepository.updateLesson(courseId, lesson.id, (current) => ({
    ...current,
    legacyCloudflareStream: previousStreamState,
    storagePath: null,
    storageProvider: null,
    streamProvider: null,
    cloudflareStreamUid: null,
    cloudflareStreamUploadMethod: null,
    cloudflareStreamUploadUrlExpiresAt: null,
    cloudflareStreamMaxDurationSeconds: null,
    cloudflareStreamStatus: 'migrated-to-private-hls',
    cloudflareStreamPctComplete: 100,
    cloudflareStreamReadyToStream: false,
    cloudflareStreamLastCheckedAt: now,
    accessPolicy: {
      type: 'signed-object-url',
      drmReady: Boolean(appConfig.privateVideoDrmEnabled),
    },
    deliveryProfile: DESIRED_DELIVERY_PROFILE,
    deliveryStrategy: 'hls',
    sourceFallbackAllowed: false,
    targetQualities,
    hlsStorageProvider: 's3',
    hlsProcessingStatus: 'ready',
    hlsProcessingQueuedAt: current.hlsProcessingQueuedAt || now,
    hlsProcessingStartedAt: current.hlsProcessingStartedAt || now,
    hlsProcessingCompletedAt: now,
    hlsProcessingError: null,
    hlsManifestPath: manifestKey,
    hlsPlaybackPath: manifestKey,
    hlsManifestBundlePath: manifestBundleKey,
    hlsManifestRootPath: manifestRootPath,
    hlsManifestVersion: manifestVersion,
    playbackReady: true,
    streamUrl: null,
    dashStreamUrl: null,
    releaseAt: current.releaseAt || lesson.releaseAt || now,
    durationMinutes: Math.max(Number(durationMinutes || current.durationMinutes || lesson.durationMinutes || 0), 0),
  }));
};

const migrateLesson = async (courseId, lesson) => {
  const uid = String(lesson.cloudflareStreamUid || lesson.streamUid || '').trim();
  const workspaceDirectory = createTemporaryWorkspace(lesson.id);
  const outputDirectory = path.join(workspaceDirectory, 'hls');
  const outputKey = buildPrivateHlsAssetKey({
    courseId,
    moduleId: lesson.moduleId || 'module',
    lessonId: lesson.id,
    assetName: 'master.m3u8',
  });
  const outputRootPath = path.posix.dirname(outputKey);
  const manifestBundleKey = buildManifestBundleStorageKey(outputKey);
  const targetQualities = getTargetQualities(lesson);
  const manifestVersion = Date.now().toString(36);
  let syncedDurationMinutes = Number(lesson.durationMinutes || 0);
  let migrationSource = null;

  try {
    const state = uid ? await syncCloudflareStreamVideoStatus({ uid, source: 'migration' }).catch(() => null) : null;
    if (Number.isFinite(Number(state?.durationSeconds)) && Number(state.durationSeconds) > 0) {
      syncedDurationMinutes = Math.max(1, Math.round(Number(state.durationSeconds) / 60));
    }

    migrationSource = await resolveMigrationSource({ lesson, workspaceDirectory });
    console.log(`[stream-migrate] using ${migrationSource.sourceType} source for ${courseId}/${lesson.id}`);

    console.log(`[stream-migrate] transcoding ${courseId}/${lesson.id} to private HLS`);
    if (!DRY_RUN) {
      await transcodeToHls({
        sourcePath: migrationSource.sourcePath,
        outputDirectory,
        qualities: targetQualities,
      });
      const manifestBundle = createManifestBundleFromDirectory({
        outputDirectory,
        manifestKey: outputKey,
        storageProvider: 's3',
        version: manifestVersion,
      });
      writeManifestBundleToDirectory({
        outputDirectory,
        bundle: manifestBundle,
      });

      await deleteStoredPrivateVideoPrefix({
        storageProvider: 's3',
        storagePathPrefix: path.posix.dirname(outputKey),
      });
      await uploadProcessedHlsDirectory({
        outputDirectory,
        manifestKey: outputKey,
      });

      await updateLessonToPrivateHls({
        courseId,
        lesson,
        manifestKey: outputKey,
        manifestBundleKey,
        manifestRootPath: outputRootPath,
        manifestVersion,
        durationMinutes: syncedDurationMinutes,
        targetQualities,
      });

      if (uid && DELETE_STREAM_AFTER_SUCCESS && !KEEP_STREAM_AS_ROLLBACK) {
        await deleteCloudflareStreamVideo(uid).catch((error) => {
          console.warn(`[stream-migrate] failed to delete Cloudflare Stream video ${uid}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  } finally {
    cleanupDirectory(workspaceDirectory);
  }

  return {
    courseId,
    lessonId: lesson.id,
    cloudflareStreamUid: uid || null,
    downloadUrl: migrationSource?.downloadUrl || null,
    sourceType: migrationSource?.sourceType || null,
    manifestKey: outputKey,
    deliveryProfile: DESIRED_DELIVERY_PROFILE,
    targetQualities,
    deletedStreamAfterSuccess: DELETE_STREAM_AFTER_SUCCESS && !KEEP_STREAM_AS_ROLLBACK && Boolean(uid),
  };
};

const main = async () => {
  if (String(appConfig.videoHlsStorageProvider || '').toLowerCase() !== 's3') {
    throw new Error('VIDEO_HLS_STORAGE_PROVIDER must be s3 before running Stream migration.');
  }
  if (!resolveFfmpegPath()) {
    throw new Error('ffmpeg runtime is unavailable. Install ffmpeg in the runtime image or set FFMPEG_PATH.');
  }
  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const allCourses = TARGET_COURSE_ID
    ? [await coursesRepository.findById(TARGET_COURSE_ID)].filter(Boolean)
    : await coursesRepository.list();

  const migrationTargets = [];
  for (const course of allCourses) {
    const lessons = collectLessons(course)
      .filter((lesson) => lesson?.type === 'private-video')
      .filter((lesson) => isCloudflareStreamLesson(lesson))
      .filter((lesson) => !TARGET_LESSON_ID || String(lesson.id) === TARGET_LESSON_ID);
    for (const lesson of lessons) {
      migrationTargets.push({ courseId: course._id, lesson });
    }
  }

  const limitedTargets = MAX_LESSONS > 0 ? migrationTargets.slice(0, MAX_LESSONS) : migrationTargets;
  const results = [];
  if (!isCloudflareStreamConfigured()) {
    console.warn('[stream-migrate] Cloudflare Stream credentials are unavailable; falling back to existing legacy playback URLs when possible.');
  }
  for (const target of limitedTargets) {
    console.log(`[stream-migrate] starting ${target.courseId}/${target.lesson.id}`);
    const result = await migrateLesson(target.courseId, target.lesson);
    results.push(result);
    console.log(`[stream-migrate] finished ${target.courseId}/${target.lesson.id}`);
  }

  console.log(JSON.stringify({
    processed: limitedTargets.length,
    dryRun: DRY_RUN,
    deleteStreamAfterSuccess: DELETE_STREAM_AFTER_SUCCESS,
    keepStreamAsRollback: KEEP_STREAM_AS_ROLLBACK,
    targetCourseId: TARGET_COURSE_ID || null,
    targetLessonId: TARGET_LESSON_ID || null,
    results,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
