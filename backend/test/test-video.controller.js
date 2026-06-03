const fs = require('fs');
const path = require('path');
const { testsRepository, sessionRepository, videoPlaybackRepository } = require('../lib/repositories.js');
const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
  optionalNumber,
} = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const {
  HLS_ACCESS_COOKIE_NAME,
  issuePlaybackToken,
  verifyPlaybackToken,
  resolvePrivateVideoPath,
  getProtectedAssetStorageRoot,
} = require('../lib/private-video.js');
const { buildSecurePlaybackClientContext } = require('../lib/secure-playback.js');
const {
  storePrivateVideoUpload,
  deleteStoredPrivateVideo,
  getSignedPrivateVideoUrl,
  isS3Provider,
} = require('../lib/private-video-storage.js');
const { createInitialVideoDeliveryState, scheduleTestVideoProcessing, deleteProcessedHlsAssets } = require('../lib/video-processing.js');

const validVideoTypes = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'application/x-matroska',
];
const validVideoExtensions = new Set(['.mp4', '.webm', '.ogg', '.mov', '.mkv']);
const maxSize = appConfig.maxVideoUploadMb * 1024 * 1024;

const HLS_ACCESS_COOKIE_PATH = '/backend/api/';

const requestMatchesPlaybackContext = (req, payload = {}) => {
  if (!payload?.userAgentHash) {
    return true;
  }

  const requestContext = buildSecurePlaybackClientContext(req);
  return String(requestContext.userAgentHash || '') === String(payload.userAgentHash || '');
};

const setPlaybackCookie = (res, token, expiresAtIso) => {
  const expiresAtMs = Number(new Date(expiresAtIso || '').getTime() || 0);
  const maxAgeSeconds = expiresAtMs > Date.now()
    ? Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000))
    : Math.max(Number(appConfig.privateVideoHlsSegmentTokenTtlSeconds || 21_600), 300);
  const cookieParts = [
    `${HLS_ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${HLS_ACCESS_COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (appConfig.nodeEnv === 'production') {
    cookieParts.push('Secure');
  }

  res.append('Set-Cookie', cookieParts.join('; '));
};

const getStorageRootFromPlayerStreamUrl = (streamUrl) => {
  const rawUrl = String(streamUrl || '');
  const manifestBundlePath = rawUrl.split('/course-manifests/b/')[1]?.split('/_p/')[0] || '';
  if (manifestBundlePath) {
    return getProtectedAssetStorageRoot(manifestBundlePath);
  }

  const compactAssetPath = rawUrl.split('/courses/h/')[1]?.split('?')[0] || '';
  if (compactAssetPath) {
    return getProtectedAssetStorageRoot(compactAssetPath);
  }

  return '';
};

const appendPlaybackGrantCookieIfNeeded = (req, res, player) => {
  if (!(player?.streamFormat === 'hls' && player?.streamUrl)) {
    return;
  }

  const storageRoot = getStorageRootFromPlayerStreamUrl(player.streamUrl);
  if (!storageRoot) {
    return;
  }

  const issuedGrant = issuePlaybackToken({
    kind: 'course-hls-grant',
    userId: req.user?.id || null,
    sessionId: req.user?.session || null,
    storageRoot,
    playbackSessionId: player?.playbackSessionId || null,
    courseId: player?.courseId || null,
    videoType: player?.videoType || null,
    videoId: player?.videoId || null,
    userAgentHash: buildSecurePlaybackClientContext(req).userAgentHash,
  }, {
    expiresAtMs: Number(new Date(player.tokenExpiresAt || '').getTime() || 0) || undefined,
    ttlSeconds: appConfig.privateVideoHlsSegmentTokenTtlSeconds,
  });
  setPlaybackCookie(res, issuedGrant.token, issuedGrant.expiresAt);
};

const uploadTestVideo = asyncHandler(async (req, res) => {
  const testId = requireString(req.params.id, 'testId');
  const title = requireString(req.body?.title, 'title', { maxLength: 160 });
  const durationMinutes = optionalNumber(req.body?.durationMinutes, 0, { min: 0, max: 5000 });

  if (!req.file) {
    throw new ApiError(400, 'No video file provided', { code: 'VIDEO_REQUIRED' });
  }

  const fileExtension = path.extname(req.file.originalname || '').toLowerCase();
  if (!validVideoTypes.includes(req.file.mimetype) && !validVideoExtensions.has(fileExtension)) {
    fs.unlinkSync(req.file.path);
    throw new ApiError(400, 'Invalid video format. Supported: MP4, WebM, OGG, MOV, MKV', { code: 'INVALID_VIDEO_FORMAT' });
  }

  if (req.file.size > maxSize) {
    fs.unlinkSync(req.file.path);
    throw new ApiError(400, `Video file too large. Max ${appConfig.maxVideoUploadMb}MB allowed`, { code: 'VIDEO_TOO_LARGE' });
  }

  const test = await testsRepository.findById(testId);
  if (!test) {
    fs.unlinkSync(req.file.path);
    throw new ApiError(404, 'Test not found', { code: 'TEST_NOT_FOUND' });
  }

  if (test.companionVideo?.storagePath) {
    await deleteStoredPrivateVideo({
      storageProvider: test.companionVideo.storageProvider,
      storagePath: test.companionVideo.storagePath,
    });
    await deleteProcessedHlsAssets(test.companionVideo.hlsManifestPath, test.companionVideo.hlsStorageProvider || null);
  }

  const videoId = test.companionVideo?.id || `test_video_${Date.now()}`;
  const storedVideo = await storePrivateVideoUpload({
    tempFilePath: req.file.path,
    courseId: 'tests',
    moduleId: testId,
    lessonId: videoId,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
  });

  const companionVideo = {
    id: videoId,
    title,
    type: 'private-video',
    storagePath: storedVideo.storagePath,
    storageProvider: storedVideo.storageProvider,
    originalFilename: req.file.originalname || null,
    fileSize: req.file.size || 0,
    mimeType: req.file.mimetype || null,
    uploadedAt: new Date().toISOString(),
    uploadedBy: req.user?.id || 'admin',
    durationMinutes,
    accessPolicy: storedVideo.accessPolicy,
    ...createInitialVideoDeliveryState(),
  };

  const updatedTest = await testsRepository.update(testId, {
    ...test,
    companionVideo,
  });

  scheduleTestVideoProcessing({ testId });

  return created(res, {
    message: 'Test-series video uploaded successfully',
    companionVideo,
    test: updatedTest,
  });
});

const getTestVideoMetadata = asyncHandler(async (req, res) => {
  const testId = requireString(req.params.id, 'testId');
  const test = await testsRepository.findById(testId);
  if (!test) {
    throw new ApiError(404, 'Test not found', { code: 'TEST_NOT_FOUND' });
  }

  if (!test.companionVideo) {
    throw new ApiError(404, 'Test video not found', { code: 'TEST_VIDEO_NOT_FOUND' });
  }

  return ok(res, {
    companionVideo: test.companionVideo,
  });
});

const deleteTestVideo = asyncHandler(async (req, res) => {
  const testId = requireString(req.params.id, 'testId');
  const test = await testsRepository.findById(testId);
  if (!test) {
    throw new ApiError(404, 'Test not found', { code: 'TEST_NOT_FOUND' });
  }

  if (!test.companionVideo?.storagePath) {
    throw new ApiError(404, 'Test video not found', { code: 'TEST_VIDEO_NOT_FOUND' });
  }

  await deleteStoredPrivateVideo({
    storageProvider: test.companionVideo.storageProvider,
    storagePath: test.companionVideo.storagePath,
  });
  await deleteProcessedHlsAssets(test.companionVideo.hlsManifestPath, test.companionVideo.hlsStorageProvider || null);

  const updatedTest = await testsRepository.update(testId, {
    ...test,
    companionVideo: null,
  });

  return ok(res, {
    message: 'Test-series video deleted successfully',
    test: updatedTest,
  });
});

const getProtectedTestVideoPlayer = asyncHandler(async (req, res) => {
  const testId = requireString(req.params.id, 'testId');
  const player = await testsRepository.getProtectedVideoPlayback(testId, {
    userId: req.user?.id || null,
    userRole: req.user?.role || 'guest',
    user: req.user?.profile || req.user || null,
    requestContext: buildSecurePlaybackClientContext(req),
  });
  appendPlaybackGrantCookieIfNeeded(req, res, player);
  return ok(res, player);
});

const streamProtectedTestVideo = asyncHandler(async (req, res) => {
  const token = requireString(req.params.token, 'playback token');
  const payload = verifyPlaybackToken(token);

  if (!payload) {
    throw new ApiError(401, 'Playback token is invalid or expired', { code: 'PLAYBACK_TOKEN_INVALID' });
  }

  const activeSessionId = payload.userId
    ? await sessionRepository.getActiveSessionId(String(payload.userId), payload.sessionId || null)
    : null;
  if (payload.sessionId && activeSessionId !== payload.sessionId) {
    throw new ApiError(401, 'Playback session is no longer active', { code: 'PLAYBACK_SESSION_INVALID' });
  }

  if (!requestMatchesPlaybackContext(req, payload)) {
    throw new ApiError(401, 'Playback token is not valid for this device or browser session', {
      code: 'PLAYBACK_CONTEXT_INVALID',
    });
  }

  if (payload.userId && payload.playbackSessionId) {
    const requestContext = buildSecurePlaybackClientContext(req);
    const activePlaybackSession = await videoPlaybackRepository.validatePlaybackSession({
      userId: String(payload.userId),
      playbackSessionId: String(payload.playbackSessionId),
      authSessionId: payload.sessionId || null,
      courseId: payload.courseId || null,
      videoId: payload.videoId || null,
      videoType: payload.videoType || null,
      requestContext,
    });
    if (!activePlaybackSession) {
      throw new ApiError(401, 'Playback session is no longer valid', { code: 'PLAYBACK_SESSION_INVALID' });
    }
    if (String(activePlaybackSession.status || '').toLowerCase() === 'locked') {
      throw new ApiError(403, 'Video watch limit reached', { code: 'VIDEO_WATCH_LIMIT_REACHED' });
    }
  }

  if (isS3Provider(payload.storageProvider)) {
    const signedUrl = await getSignedPrivateVideoUrl({
      storagePath: payload.storagePath,
      mimeType: payload.mimeType,
    });

    if (!signedUrl) {
      throw new ApiError(404, 'Protected video could not be delivered', { code: 'PRIVATE_VIDEO_URL_UNAVAILABLE' });
    }

    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.redirect(307, signedUrl);
    return;
  }

  const filePath = resolvePrivateVideoPath(payload.storagePath);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new ApiError(404, 'Protected video file not found', { code: 'PRIVATE_VIDEO_NOT_FOUND' });
  }

  const stat = fs.statSync(filePath);
  const mimeType = payload.mimeType || 'video/mp4';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const [startText, endText] = String(range).replace(/bytes=/, '').split('-');
  const start = Number(startText || 0);
  const end = endText ? Number(endText) : stat.size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

module.exports = {
  uploadTestVideo,
  getTestVideoMetadata,
  deleteTestVideo,
  getProtectedTestVideoPlayer,
  streamProtectedTestVideo,
};
