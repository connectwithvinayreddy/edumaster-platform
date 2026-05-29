const crypto = require('crypto');
const { appConfig } = require('./config.js');
const logger = require('./logger.js');

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const pendingStatusTimers = new Map();

const isCloudflareStreamConfigured = () => Boolean(
  appConfig.cloudflareStreamAccountId
  && appConfig.cloudflareStreamApiToken,
);

const isCloudflareStreamEnabled = () =>
  String(appConfig.videoProcessingProvider || '').toLowerCase() === 'cloudflare-stream';

const assertCloudflareStreamConfigured = () => {
  if (!isCloudflareStreamConfigured()) {
    throw new Error('Cloudflare Stream is not configured. Set CLOUDFLARE_STREAM_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN.');
  }
};

const streamApiUrl = (path) =>
  `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(appConfig.cloudflareStreamAccountId)}/stream${path}`;

const parseCloudflareResponse = async (response) => {
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = { raw: text };
  }

  if (!response.ok || payload?.success === false) {
    const message = payload?.errors?.[0]?.message
      || payload?.message
      || `Cloudflare Stream API request failed with ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.cloudflare = payload;
    throw error;
  }

  return payload?.result ?? payload;
};

const buildUploadMetadataHeader = (metadata = {}) => Object.entries(metadata)
  .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
  .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
  .join(',');

const getAllowedOrigins = () => {
  const origins = Array.isArray(appConfig.cloudflareStreamAllowedOrigins)
    ? appConfig.cloudflareStreamAllowedOrigins
    : [];
  return origins.filter(Boolean);
};

const getMaxDurationSeconds = (durationMinutes) => {
  const requestedSeconds = Math.ceil(Math.max(Number(durationMinutes || 0), 0) * 60);
  const defaultSeconds = Math.max(Number(appConfig.cloudflareStreamDefaultMaxDurationSeconds || 0), 60);
  const safetySeconds = Math.max(Number(appConfig.cloudflareStreamUploadDurationSafetySeconds || 0), 0);
  const providerMaxSeconds = Math.max(Number(appConfig.cloudflareStreamMaxUploadDurationSeconds || 0), 60);
  const requestedWithSafety = requestedSeconds > 0 ? requestedSeconds + safetySeconds : 0;

  return Math.min(
    Math.max(defaultSeconds, requestedWithSafety, 60),
    providerMaxSeconds,
  );
};

const buildCloudflareStreamPlaybackUrls = (uid, playback = {}) => {
  const id = String(uid || '').trim();
  if (!id) {
    return { hls: null, dash: null };
  }

  const suppliedHls = String(playback?.hls || '').trim();
  const suppliedDash = String(playback?.dash || '').trim();
  const customerCode = String(appConfig.cloudflareStreamCustomerCode || '').trim();

  if (suppliedHls || suppliedDash) {
    return {
      hls: suppliedHls || null,
      dash: suppliedDash || null,
    };
  }

  if (!customerCode) {
    return { hls: null, dash: null };
  }

  const base = `https://customer-${customerCode}.cloudflarestream.com/${encodeURIComponent(id)}`;
  return {
    hls: `${base}/manifest/video.m3u8`,
    dash: `${base}/manifest/video.mpd`,
  };
};

const normalizeStreamState = (video = {}) => {
  const status = video.status || {};
  const state = String(status.state || video.state || '').toLowerCase();
  const pctComplete = Number(status.pctComplete ?? video.pctComplete ?? 0);
  const readyToStream = Boolean(video.readyToStream || video.readytoStream);
  const hasError = state === 'error' || Boolean(status.errorReasonCode || status.errorReasonText || video.errorReasonCode);
  const fullyReady = readyToStream && state === 'ready' && pctComplete >= 100;
  const playback = buildCloudflareStreamPlaybackUrls(video.uid, video.playback || {});

  return {
    uid: video.uid || null,
    state: hasError ? 'failed' : fullyReady ? 'ready' : readyToStream ? 'processing' : (state || 'queued'),
    providerState: state || null,
    pctComplete: Number.isFinite(pctComplete) ? pctComplete : null,
    readyToStream,
    fullyReady,
    hasError,
    errorCode: status.errorReasonCode || video.errorReasonCode || null,
    errorText: status.errorReasonText || video.errorReasonText || null,
    durationSeconds: Number.isFinite(Number(video.duration)) ? Number(video.duration) : null,
    input: video.input || null,
    playback,
    thumbnail: video.thumbnail || null,
    raw: video,
  };
};

const createDirectUpload = async ({
  lessonTitle,
  durationMinutes,
  creator,
  metadata = {},
}) => {
  assertCloudflareStreamConfigured();

  const maxDurationSeconds = getMaxDurationSeconds(durationMinutes);
  const body = {
    maxDurationSeconds,
    meta: {
      name: lessonTitle || metadata.name || 'Lesson video',
      ...metadata,
    },
  };

  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.length > 0) {
    body.allowedOrigins = allowedOrigins;
  }

  if (appConfig.cloudflareStreamSignedPlaybackRequired) {
    body.requireSignedURLs = true;
  }

  const response = await fetch(streamApiUrl('/direct_upload'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appConfig.cloudflareStreamApiToken}`,
      'Content-Type': 'application/json',
      ...(creator ? { 'Upload-Creator': String(creator) } : {}),
    },
    body: JSON.stringify(body),
  });

  const result = await parseCloudflareResponse(response);
  return {
    uid: result.uid,
    uploadURL: result.uploadURL,
    expiresAt: result.expires || result.expiry || null,
    maxDurationSeconds,
    method: 'direct-post',
  };
};

const createTusUpload = async ({
  fileSize,
  lessonTitle,
  durationMinutes,
  mimeType,
  creator,
  metadata = {},
}) => {
  assertCloudflareStreamConfigured();

  const expiresAt = new Date(
    Date.now() + Math.max(Number(appConfig.cloudflareStreamDirectUploadExpiryMinutes || 180), 15) * 60_000,
  ).toISOString();
  const maxDurationSeconds = getMaxDurationSeconds(durationMinutes);
  const uploadMetadata = {
    name: lessonTitle || metadata.name || 'Lesson video',
    filetype: mimeType || 'video/mp4',
    maxDurationSeconds,
    expiry: expiresAt,
    ...metadata,
  };

  if (appConfig.cloudflareStreamSignedPlaybackRequired) {
    uploadMetadata.requiresignedurls = '';
  }

  const response = await fetch(streamApiUrl('?direct_user=true'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appConfig.cloudflareStreamApiToken}`,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(Math.max(Number(fileSize || 0), 0)),
      'Upload-Metadata': buildUploadMetadataHeader(uploadMetadata),
      ...(creator ? { 'Upload-Creator': String(creator) } : {}),
    },
  });

  if (!response.ok) {
    await parseCloudflareResponse(response);
  }

  const uploadURL = response.headers.get('location');
  const uid = response.headers.get('stream-media-id');
  if (!uploadURL || !uid) {
    throw new Error('Cloudflare Stream did not return a TUS upload URL and media id.');
  }

  return {
    uid,
    uploadURL,
    expiresAt,
    maxDurationSeconds,
    method: 'tus',
  };
};

const getVideoDetails = async (uid) => {
  assertCloudflareStreamConfigured();
  const response = await fetch(streamApiUrl(`/${encodeURIComponent(uid)}`), {
    headers: {
      Authorization: `Bearer ${appConfig.cloudflareStreamApiToken}`,
    },
  });
  return parseCloudflareResponse(response);
};

const deleteCloudflareStreamVideo = async (uid) => {
  if (!uid || !isCloudflareStreamConfigured()) {
    return false;
  }

  const response = await fetch(streamApiUrl(`/${encodeURIComponent(uid)}`), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${appConfig.cloudflareStreamApiToken}`,
    },
  });

  if (response.status === 404) {
    return false;
  }

  await parseCloudflareResponse(response);
  return true;
};

const verifyCloudflareStreamWebhookSignature = (rawBody, signatureHeader) => {
  const secret = String(appConfig.cloudflareStreamWebhookSecret || '').trim();
  if (!secret) {
    return true;
  }

  const values = String(signatureHeader || '')
    .split(',')
    .map((entry) => entry.trim().split('='))
    .reduce((accumulator, [key, value]) => {
      if (key && value) {
        accumulator[key] = value;
      }
      return accumulator;
    }, {});

  const timestamp = Number(values.time || 0);
  const signature = String(values.sig1 || '');
  if (!timestamp || !signature) {
    return false;
  }

  const maxAgeSeconds = 5 * 60;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > maxAgeSeconds) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
};

const updateLessonFromCloudflareState = async ({ uid, state, source = 'poll' }) => {
  if (!uid || !state) {
    return null;
  }

  const { coursesRepository } = require('./repositories.js');
  const courses = await coursesRepository.list();
  let matched = null;

  for (const course of courses || []) {
    const lessons = (course.modules || []).flatMap((module) => ([
      ...(module.lessons || []),
      ...((module.chapters || []).flatMap((chapter) => chapter.lessons || [])),
    ]));
    const lesson = lessons.find((entry) =>
      String(entry.cloudflareStreamUid || entry.streamUid || '') === String(uid));

    if (!lesson) {
      continue;
    }

    const now = new Date().toISOString();
    const updatedLesson = await coursesRepository.updateLesson(course._id, lesson.id, (current) => {
      const base = {
        ...current,
        storageProvider: 'cloudflare-stream',
        streamProvider: 'cloudflare-stream',
        cloudflareStreamUid: uid,
        cloudflareStreamStatus: state.providerState || state.state,
        cloudflareStreamPctComplete: state.pctComplete,
        cloudflareStreamReadyToStream: state.readyToStream,
        cloudflareStreamLastCheckedAt: now,
        hlsProcessingError: state.errorText || state.errorCode || null,
      };

      if (state.fullyReady) {
        return {
          ...base,
          deliveryStrategy: 'cloudflare-stream',
          deliveryProfile: 'cloudflare-stream',
          hlsProcessingStatus: 'ready',
          hlsProcessingCompletedAt: now,
          hlsPlaybackPath: state.playback.hls,
          hlsManifestPath: state.playback.hls,
          hlsStorageProvider: 'cloudflare-stream',
          playbackReady: true,
          streamUrl: state.playback.hls,
          dashStreamUrl: state.playback.dash,
          videoUrl: null,
          durationMinutes: state.durationSeconds
            ? Math.max(1, Math.round(state.durationSeconds / 60))
            : current.durationMinutes,
          releaseAt: current.releaseAt || now,
          sourceFallbackAllowed: false,
        };
      }

      if (state.hasError) {
        return {
          ...base,
          hlsProcessingStatus: 'failed',
          hlsProcessingCompletedAt: now,
          playbackReady: false,
          releaseAt: null,
          sourceFallbackAllowed: false,
        };
      }

      return {
        ...base,
        hlsProcessingStatus: state.state === 'queued' ? 'queued' : 'processing',
        hlsProcessingStartedAt: current.hlsProcessingStartedAt || now,
        playbackReady: false,
        releaseAt: null,
        sourceFallbackAllowed: false,
      };
    });

    matched = { courseId: course._id, lessonId: lesson.id, lesson: updatedLesson };
    logger.info('[cloudflare-stream] lesson status updated', {
      uid,
      courseId: course._id,
      lessonId: lesson.id,
      state: state.state,
      pctComplete: state.pctComplete,
      source,
    });
    break;
  }

  if (!matched) {
    logger.warn('[cloudflare-stream] webhook/status update did not match any lesson', { uid, source });
  }

  return matched;
};

const syncCloudflareStreamVideoStatus = async ({ uid, source = 'poll' }) => {
  const details = await getVideoDetails(uid);
  const state = normalizeStreamState(details);
  await updateLessonFromCloudflareState({ uid, state, source });
  return state;
};

const scheduleCloudflareStreamStatusPolling = ({ uid, attempt = 0, delayMs = null }) => {
  if (!uid || !isCloudflareStreamEnabled() || !isCloudflareStreamConfigured()) {
    return;
  }

  const key = String(uid);
  if (pendingStatusTimers.has(key)) {
    return;
  }

  const maxAttempts = Math.max(Number(appConfig.cloudflareStreamStatusPollMaxAttempts || 36), 1);
  if (attempt >= maxAttempts) {
    return;
  }

  const baseDelay = delayMs ?? Math.max(Number(appConfig.cloudflareStreamStatusPollInitialDelayMs || 30_000), 5_000);
  const nextDelay = Math.min(baseDelay * Math.max(attempt + 1, 1), 5 * 60_000);
  const timer = setTimeout(async () => {
    pendingStatusTimers.delete(key);
    try {
      const state = await syncCloudflareStreamVideoStatus({ uid, source: 'poll' });
      if (!state.fullyReady && !state.hasError) {
        scheduleCloudflareStreamStatusPolling({ uid, attempt: attempt + 1, delayMs: baseDelay });
      }
    } catch (error) {
      logger.warn('[cloudflare-stream] status poll failed', {
        uid,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleCloudflareStreamStatusPolling({ uid, attempt: attempt + 1, delayMs: baseDelay });
    }
  }, nextDelay);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  pendingStatusTimers.set(key, timer);
};

module.exports = {
  isCloudflareStreamConfigured,
  isCloudflareStreamEnabled,
  createDirectUpload,
  createTusUpload,
  normalizeStreamState,
  syncCloudflareStreamVideoStatus,
  scheduleCloudflareStreamStatusPolling,
  updateLessonFromCloudflareState,
  verifyCloudflareStreamWebhookSignature,
  deleteCloudflareStreamVideo,
};
