import path from 'node:path';
import { openAsBlob, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  getPrivateVideoStorageProvider,
  uploadPrivateStorageFile,
} = require('../lib/private-video-storage.js');
const ffmpegPath = require('ffmpeg-static');

const supportedMimeTypes = {
  '.flv': 'video/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

const prepareRecordingUploadAsset = async (filePath) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.flv') {
    return {
      uploadPath: filePath,
      cleanup: async () => undefined,
      mimeType: supportedMimeTypes[extension] || 'video/mp4',
    };
  }

  if (!ffmpegPath) {
    throw new Error('ffmpeg-static is required to import FLV live recordings.');
  }

  const convertedPath = path.join(
    tmpdir(),
    `${path.basename(filePath, extension).replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now()}.mp4`,
  );

  await execFileAsync(ffmpegPath, [
    '-y',
    '-i',
    filePath,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    convertedPath,
  ], {
    maxBuffer: 1024 * 1024 * 32,
  });

  return {
    uploadPath: convertedPath,
    cleanup: async () => {
      await fs.unlink(convertedPath).catch(() => undefined);
    },
    mimeType: 'video/mp4',
  };
};

const normalizeStreamKey = (streamKey) => {
  const normalized = String(streamKey || '').trim().replace(/\\/g, '/').split('?')[0];
  const segments = normalized.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : normalized;
};

const parseStreamKey = (streamKey) => {
  const normalizedStreamKey = normalizeStreamKey(streamKey);
  const [liveClassId, courseId, moduleId, chapterId = 'root'] = normalizedStreamKey.split('__');
  if (!liveClassId) {
    throw new Error(`Invalid stream key "${streamKey}". Expected liveClassId or liveClassId__courseId__moduleId__chapterId.`);
  }

  return {
    liveClassId,
    courseId: courseId && courseId !== 'mock' ? courseId : '',
    moduleId: moduleId && courseId !== 'mock' ? moduleId : '',
    chapterId: chapterId === 'root' ? '' : chapterId,
  };
};

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `${response.status} ${response.statusText}`);
  }

  return body;
};

export const importLiveRecording = async ({
  apiBaseUrl = process.env.REPLAY_IMPORT_API_BASE_URL || (process.env.APP_URL ? new URL('/backend/api', process.env.APP_URL).toString() : ''),
  adminEmail = process.env.REPLAY_IMPORT_ADMIN_EMAIL,
  adminPassword = process.env.REPLAY_IMPORT_ADMIN_PASSWORD,
  streamKey,
  filePath,
  deleteAfterSuccess = process.env.REPLAY_IMPORT_DELETE_AFTER_SUCCESS !== 'false',
}) => {
  if (!apiBaseUrl) {
    throw new Error('REPLAY_IMPORT_API_BASE_URL or APP_URL must be set.');
  }

  if (!adminEmail || !adminPassword) {
    throw new Error('REPLAY_IMPORT_ADMIN_EMAIL and REPLAY_IMPORT_ADMIN_PASSWORD must be set.');
  }

  const { liveClassId, courseId, moduleId, chapterId } = parseStreamKey(streamKey);
  const extension = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);

  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Recording file is empty or missing: ${filePath}`);
  }

  const preparedAsset = await prepareRecordingUploadAsset(filePath);
  const uploadPath = preparedAsset.uploadPath;
  const mimeType = preparedAsset.mimeType;

  const normalizedApiBaseUrl = apiBaseUrl.replace(/\/$/, '');
  const login = await requestJson(`${normalizedApiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      device: 'recording-importer',
      forceLogoutOtherSessions: true,
    }),
  });

  const token = login?.token;
  if (!token) {
    throw new Error('Admin login did not return a token.');
  }

  if (!courseId || !moduleId) {
    const storageProvider = getPrivateVideoStorageProvider();
    const storagePath = `live-replays/${liveClassId}/${Date.now()}-${path.basename(uploadPath).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
    await uploadPrivateStorageFile({
      storageProvider,
      storagePath,
      localFilePath: uploadPath,
      contentType: mimeType,
      cacheControl: 'private, max-age=0, no-store',
    });

    await requestJson(`${normalizedApiBaseUrl}/live-classes/${liveClassId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replayAvailable: true,
        recordingStorageProvider: storageProvider,
        recordingStoragePath: storagePath,
        recordingDurationMinutes: Math.max(1, Number(process.env.REPLAY_IMPORT_DURATION_MINUTES || 120)),
        recordingPublishedAt: new Date().toISOString(),
        recordingUrl: null,
        status: 'ended',
      }),
    });

    if (deleteAfterSuccess) {
      await fs.unlink(filePath).catch(() => undefined);
    }
    await preparedAsset.cleanup();

    return {
      liveClassId,
      courseId: null,
      moduleId: null,
      chapterId: null,
      replayLessonId: null,
      recordingStorageProvider: storageProvider,
      recordingStoragePath: storagePath,
      filePath,
    };
  }

  const uploadExtension = path.extname(uploadPath).toLowerCase();
  const recordingBlob = await openAsBlob(uploadPath, { type: mimeType });
  const lessonTitle = `${path.basename(uploadPath, uploadExtension).replace(/[_-]+/g, ' ')} Replay`;
  const durationMinutes = Math.max(1, Number(process.env.REPLAY_IMPORT_DURATION_MINUTES || 120));

  const formData = new FormData();
  formData.append('video', recordingBlob, path.basename(uploadPath));
  formData.append('lessonTitle', lessonTitle);
  formData.append('lessonType', 'private-video');
  formData.append('durationMinutes', String(durationMinutes));
  formData.append('isPremium', 'true');
  if (chapterId) {
    formData.append('chapterId', chapterId);
  }

  const uploadResponse = await fetch(
    `${normalizedApiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    },
  );
  const uploadPayload = await uploadResponse.text();
  const uploadBody = uploadPayload ? JSON.parse(uploadPayload) : null;
  if (!uploadResponse.ok) {
    throw new Error(uploadBody?.error?.message || uploadBody?.message || `Replay upload failed with ${uploadResponse.status}`);
  }

  const replayLessonId = uploadBody?.video?.id;
  if (!replayLessonId) {
    throw new Error('Replay upload did not return a lesson id.');
  }

  await requestJson(`${normalizedApiBaseUrl}/live-classes/${liveClassId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replayAvailable: true,
      replayCourseId: courseId,
      replayLessonId,
      recordingUrl: null,
      status: 'ended',
    }),
  });

    if (deleteAfterSuccess) {
      await fs.unlink(filePath).catch(() => undefined);
    }
    await preparedAsset.cleanup();

    return {
    liveClassId,
    courseId,
    moduleId,
    chapterId,
    replayLessonId,
    filePath,
  };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [streamKey, filePath] = process.argv.slice(2);

  importLiveRecording({ streamKey, filePath })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
