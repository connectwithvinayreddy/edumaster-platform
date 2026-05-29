const { liveClassesRepository, notificationsRepository, usersRepository } = require('../lib/repositories.js');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
  requireNumber,
  requireBoolean,
} = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const { getRedisJson, setRedisJson } = require('../lib/redis.js');
const sessionService = require('./live-session.service.js');
const { broadcastLiveEvent } = require('./live-event-bus.js');
const liveKitService = require('./livekit.service.js');
const {
  ensureLiveState,
  readLiveState,
  writeLiveState,
  buildLiveStateFromClass,
} = require('./live-state.repository.js');
const { issuePlaybackToken, verifyPlaybackToken } = require('../lib/private-video.js');
const {
  getSignedPrivateVideoUrl,
  getPrivateStorageObjectBuffer,
  isS3Provider,
} = require('../lib/private-video-storage.js');
const {
  getHlsAssetMimeType,
  rewriteHlsManifestUris,
} = require('../lib/hls-manifest.js');
const ffmpegPath = require('ffmpeg-static');

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 64);

const buildJitsiTeacherStudioAccess = (liveClass) => {
  const roomName = `${slugify(liveClass?.title) || 'live-class'}-${String(liveClass?._id || '')}`;
  const roomUrl = liveClass?.roomUrl || `https://${appConfig.jitsiMeetDomain}/${roomName}`;
  const embedUrl = liveClass?.embedUrl || `${roomUrl}#config.prejoinPageEnabled=false&config.requireDisplayName=false&config.disableDeepLinking=true&config.startWithAudioMuted=false&config.startWithVideoMuted=false&interfaceConfig.DISABLE_JOIN_LEAVE_NOTIFICATIONS=true`;

  return { roomName, roomUrl, embedUrl };
};

const sanitizeActivePollResponsesInput = (value) => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.entries(value).reduce((acc, [userId, optionId]) => {
    const normalizedUserId = optionalString(userId, '', { maxLength: 120 });
    const normalizedOptionId = optionalString(optionId, '', { maxLength: 80 });
    if (normalizedUserId && normalizedOptionId) {
      acc[normalizedUserId] = normalizedOptionId;
    }
    return acc;
  }, {});
};

const sanitizeActivePollInput = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const question = optionalString(value.question, '', { maxLength: 240 });
  const options = Array.isArray(value.options)
    ? value.options
      .map((option, index) => {
        const entry = option && typeof option === 'object' ? option : {};
        const text = optionalString(entry.text, '', { maxLength: 120 });
        if (!text) {
          return null;
        }
        return {
          id: optionalString(entry.id, `option-${index + 1}`, { maxLength: 80 }) || `option-${index + 1}`,
          text,
        };
      })
      .filter(Boolean)
    : [];

  if (!question || options.length === 0) {
    return null;
  }

  return {
    question,
    status: optionalString(value.status, 'live', { maxLength: 40 }) || 'live',
    options,
    responses: sanitizeActivePollResponsesInput(value.responses),
  };
};

const buildActivePollVoteCounts = (activePoll) => {
  const counts = new Map();
  if (!activePoll || !Array.isArray(activePoll.options)) {
    return counts;
  }

  activePoll.options.forEach((option) => {
    counts.set(String(option.id || ''), 0);
  });

  const responses = activePoll.responses && typeof activePoll.responses === 'object' ? activePoll.responses : {};
  Object.values(responses).forEach((optionId) => {
    const normalizedOptionId = String(optionId || '');
    if (!counts.has(normalizedOptionId)) {
      return;
    }
    counts.set(normalizedOptionId, (counts.get(normalizedOptionId) || 0) + 1);
  });

  return counts;
};

const enrichActivePoll = (activePoll) => {
  if (!activePoll) {
    return null;
  }

  const counts = buildActivePollVoteCounts(activePoll);
  return {
    ...activePoll,
    options: Array.isArray(activePoll.options)
      ? activePoll.options.map((option) => ({
        ...option,
        votes: counts.get(String(option.id || '')) || 0,
      }))
      : [],
    totalVotes: Array.from(counts.values()).reduce((sum, value) => sum + Number(value || 0), 0),
  };
};

const buildLiveClassEventSnapshot = (liveClass) => ({
  _id: String(liveClass?._id || ''),
  title: liveClass?.title || '',
  status: liveClass?.status || null,
  livePlaybackType: liveClass?.livePlaybackType || null,
  roomUrl: liveClass?.roomUrl || null,
  embedUrl: liveClass?.embedUrl || null,
  roomName: liveClass?.roomName || null,
  provider: liveClass?.provider || null,
  activePoll: enrichActivePoll(liveClass?.activePoll || null),
  replayAvailable: liveClass?.replayAvailable !== false,
});

const broadcastLiveClassUpdate = async (liveClass, event = 'live-class.updated') => {
  if (!liveClass?._id) {
    return;
  }

  await broadcastLiveEvent({
    event,
    liveClassId: String(liveClass._id),
    timestamp: new Date().toISOString(),
    liveClass: buildLiveClassEventSnapshot(liveClass),
  });
};

const normalizeOptionalUrl = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.toLowerCase() === 'null' || normalized.toLowerCase() === 'undefined') {
    return null;
  }
  return normalized;
};

const resolvePreferredLivePlaybackType = () => {
  const preferred = String(appConfig.preferredLivePlaybackType || '').toLowerCase();
  if (preferred === 'livekit') {
    return 'livekit';
  }
  if (preferred === 'hls') {
    return 'live-stream';
  }
  return null;
};

const normalizeLivePlaybackType = (value) => {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'hls') {
    return 'live-stream';
  }
  return type || null;
};

const isLoopbackUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return ['127.0.0.1', 'localhost', '0.0.0.0'].includes(String(url.hostname || '').toLowerCase());
  } catch {
    return false;
  }
};

const shouldUseLocalDevHlsOrigin = () => (
  appConfig.nodeEnv !== 'production'
  && (
    !appConfig.liveHlsInternalBaseUrl
    || isLoopbackUrl(appConfig.liveHlsInternalBaseUrl)
  )
);

const getLocalDevHlsRootDir = () => path.join(process.cwd(), 'uploads/live-hls');
const getLocalDevHlsStreamDir = (streamName) => path.join(getLocalDevHlsRootDir(), String(streamName || '').replace(/[^a-zA-Z0-9._-]+/g, '_'));
const getLocalDevHlsPlaylistPath = (streamName) => path.join(getLocalDevHlsStreamDir(streamName), 'index.m3u8');
const getLocalDevHlsPidPath = (streamName) => path.join(getLocalDevHlsStreamDir(streamName), 'ffmpeg.pid');

const getLocalDevHlsSourcePath = () => {
  const configured = String(appConfig.liveHlsDevSourcePath || '').trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  }
  return path.join(process.cwd(), 'uploads/live-fallback.mp4');
};

const ensureLocalDevHlsAssets = async (streamName) => {
  const sourcePath = getLocalDevHlsSourcePath();
  if (!fs.existsSync(sourcePath)) {
    throw new ApiError(503, 'Local live HLS source is unavailable', {
      code: 'LIVE_HLS_DEV_SOURCE_MISSING',
      details: { sourcePath },
    });
  }

  if (!ffmpegPath) {
    throw new ApiError(503, 'ffmpeg runtime is unavailable for local live HLS generation', {
      code: 'LIVE_HLS_DEV_FFMPEG_UNAVAILABLE',
    });
  }

  const streamDir = getLocalDevHlsStreamDir(streamName);
  const playlistPath = getLocalDevHlsPlaylistPath(streamName);
  if (fs.existsSync(playlistPath)) {
    return playlistPath;
  }

  fs.mkdirSync(streamDir, { recursive: true });
  const pidPath = getLocalDevHlsPidPath(streamName);
  const ffmpegArgs = [
    '-y',
    '-stream_loop', '-1',
    '-re',
    '-i', sourcePath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '48000',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_flags', 'append_list+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(streamDir, 'segment-%03d.m4s'),
    playlistPath,
  ];

  const existingPid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, 'utf8').trim()) : 0;
  if (!existingPid || Number.isNaN(existingPid)) {
    const stdioTarget = fs.openSync(path.join(streamDir, 'ffmpeg.log'), 'a');
    const child = spawn(ffmpegPath, ffmpegArgs, {
      detached: true,
      stdio: ['ignore', stdioTarget, stdioTarget],
    });
    child.unref();
    fs.writeFileSync(pidPath, String(child.pid));
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(playlistPath)) {
      return playlistPath;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (!fs.existsSync(playlistPath)) {
    throw new ApiError(503, 'Local live HLS playlist was not generated', {
      code: 'LIVE_HLS_DEV_PLAYLIST_MISSING',
      details: {
        playlistPath,
        pidPath,
        streamName,
      },
    });
  }

  return playlistPath;
};

const buildManagedHlsPlaybackUrl = (streamName, requestOrigin = appConfig.appUrl) => {
  if (shouldUseLocalDevHlsOrigin()) {
    const baseOrigin = String(requestOrigin || appConfig.appUrl || '').replace(/\/+$/, '');
    return `${baseOrigin}/uploads/live-hls/${encodeURIComponent(String(streamName))}/index.m3u8`;
  }

  if (!appConfig.liveHlsInternalBaseUrl || !streamName) {
    return null;
  }

  const baseUrl = String(appConfig.liveHlsInternalBaseUrl).replace(/\/+$/, '');
  if (/\/hls$/i.test(baseUrl)) {
    return `${baseUrl}/${encodeURIComponent(String(streamName))}.m3u8`;
  }
  return `${baseUrl}/${encodeURIComponent(String(streamName))}/index.m3u8`;
};

const buildAdminIngestDetails = (liveClass) => {
  if (!appConfig.liveIngestStreamBaseUrl || !appConfig.liveIngestPublisherSecret) {
    return liveClass;
  }

  const streamName = liveClass.courseId && liveClass.moduleId
    ? `${liveClass._id}__${liveClass.courseId}__${liveClass.moduleId}__${liveClass.chapterId || 'root'}`
    : String(liveClass._id);

  return {
    ...liveClass,
    ingestServerUrl: appConfig.liveIngestStreamBaseUrl,
    ingestStreamKey: streamName,
  };
};

const buildLiveHlsAssetUrl = (payload, storagePath, mimeType) => {
  const issued = issuePlaybackToken({
    userId: payload.userId,
    sessionId: payload.sessionId,
    liveClassId: payload.liveClassId,
    storageProvider: payload.storageProvider || 'local',
    storagePath,
    mimeType,
    assetKind: 'hls',
  });
  return `/backend/api/live-classes/stream/${issued.token}`;
};

const resolveLiveUpstreamAssetUrl = (baseUpstreamUrl, assetReference) => {
  try {
    return new URL(String(assetReference || ''), String(baseUpstreamUrl || '')).toString();
  } catch {
    return null;
  }
};

const buildLiveUpstreamAssetTokenUrl = (payload, upstreamUrl, mimeType, assetKind) => {
  const issued = issuePlaybackToken({
    userId: payload.userId,
    sessionId: payload.sessionId,
    liveClassId: payload.liveClassId,
    upstreamUrl,
    mimeType,
    assetKind,
  });
  return `/backend/api/live-classes/stream/${issued.token}`;
};

const proxyLiveUpstreamAsset = async ({ payload, res }) => {
  const upstreamUrl = String(payload.upstreamUrl || '').trim();
  if (!upstreamUrl) {
    throw new ApiError(503, 'Protected live asset is not ready yet', {
      code: 'LIVE_ASSET_NOT_READY',
      details: { upstreamUrl: null },
    });
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    redirect: 'follow',
    headers: {
      'user-agent': 'edumaster-live-proxy/1.0',
    },
  });

  if (!upstreamResponse.ok) {
    throw new ApiError(502, 'Protected live asset could not be delivered', {
      code: 'LIVE_UPSTREAM_FETCH_FAILED',
      details: { status: upstreamResponse.status, upstreamUrl },
    });
  }

  const upstreamPathname = (() => {
    try {
      return new URL(upstreamUrl).pathname || '';
    } catch {
      return '';
    }
  })();
  const extension = path.extname(String(upstreamPathname || '').split('?')[0]).toLowerCase();
  const contentType = upstreamResponse.headers.get('content-type') || payload.mimeType || getHlsAssetMimeType(upstreamPathname);
  const isManifest = payload.assetKind === 'live-hls'
    && (extension === '.m3u8' || /mpegurl|application\/x-mpegurl/i.test(contentType));

  res.setHeader('Cache-Control', payload.assetKind === 'live-hls' ? 'no-store' : 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (isManifest) {
    const manifestText = await upstreamResponse.text();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(rewriteHlsManifestUris(manifestText, (assetReference) => {
      const nextUpstreamUrl = resolveLiveUpstreamAssetUrl(upstreamUrl, assetReference);
      if (!nextUpstreamUrl) {
        return assetReference;
      }
      const nextMimeType = getHlsAssetMimeType(nextUpstreamUrl);
      const nextAssetKind = String(nextMimeType).includes('mpegurl') ? 'live-hls' : 'live-source';
      return buildLiveUpstreamAssetTokenUrl(payload, nextUpstreamUrl, nextMimeType, nextAssetKind);
    }));
    return;
  }

  res.setHeader('Content-Type', contentType);
  const arrayBuffer = await upstreamResponse.arrayBuffer();
  res.send(Buffer.from(arrayBuffer));
};

const sanitizeTeacherProfileInput = (value, fallbackName = 'Live Faculty') => {
  const profile = value && typeof value === 'object' ? value : {};
  return {
    name: optionalString(profile.name, fallbackName, { maxLength: 120 }),
    role: optionalString(profile.role, '', { maxLength: 120 }) || null,
    experience: optionalString(profile.experience, '', { maxLength: 160 }) || null,
    bio: optionalString(profile.bio, '', { maxLength: 1200 }) || null,
    avatarUrl: optionalString(profile.avatarUrl, '', { maxLength: 2000 }) || null,
  };
};

const isLocalLiveImageUploadPath = (value) => typeof value === 'string' && value.startsWith('/uploads/live-posters/');

const removeLocalLiveImageIfManaged = (value) => {
  if (!isLocalLiveImageUploadPath(value)) {
    return;
  }

  try {
    const resolvedPath = path.join(__dirname, '../../', value);
    if (fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  } catch (error) {
    console.error(`Failed to remove live image asset: ${value}`, error);
  }
};

const queueLiveClassNotification = (task) => {
  void Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error('[live-class-notification] background fan-out failed', error);
    });
};

const queueLiveClassPersistence = (liveClassId, payload) => {
  void Promise.resolve()
    .then(() => liveClassesRepository.update(liveClassId, payload))
    .catch((error) => {
      console.error('[live-class-runtime-state] background persistence failed', {
        liveClassId,
        payload,
        error,
      });
    });
};

const LIVE_ACCESS_CACHE_TTL_SECONDS = 5;
const getLiveAccessCacheKey = (liveClassId, userId) => `live:class:${String(liveClassId)}:user:${String(userId)}:access`;

const deriveRuntimeRecordingState = (liveClass) => {
  if (liveClass?.replayAvailable === false) {
    return 'disabled';
  }

  const explicit = String(liveClass?.recordingState || '').trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const status = String(liveClass?.status || '').trim().toLowerCase();
  if (status === 'live') {
    return 'recording';
  }
  if (liveClass?.recordingPublishedAt || liveClass?.recordingUrl || liveClass?.recordingStoragePath) {
    return 'published';
  }
  if (status === 'ended') {
    return 'processing';
  }
  return 'pending';
};

const deriveRuntimeReplayState = (liveClass) => {
  if (liveClass?.replayAvailable === false) {
    return 'disabled';
  }

  const explicit = String(liveClass?.replayState || '').trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  if (
    liveClass?.recordingUrl
    || liveClass?.recordingStoragePath
    || (liveClass?.replayCourseId && liveClass?.replayLessonId)
  ) {
    return 'replay_ready';
  }

  const status = String(liveClass?.status || '').trim().toLowerCase();
  if (status === 'ended') {
    return 'processing';
  }

  return 'pending';
};

const sanitizeResourceItemsInput = (value) => (
  Array.isArray(value)
    ? value
      .map((item, index) => {
        const entry = item && typeof item === 'object' ? item : {};
        const title = optionalString(entry.title, '', { maxLength: 160 });
        if (!title) {
          return null;
        }
        return {
          id: optionalString(entry.id, `resource-${index + 1}`, { maxLength: 80 }) || `resource-${index + 1}`,
          title,
          type: optionalString(entry.type, '', { maxLength: 40 }) || null,
          url: optionalString(entry.url, '', { maxLength: 2000 }) || null,
          description: optionalString(entry.description, '', { maxLength: 500 }) || null,
          lines: Array.isArray(entry.lines)
            ? entry.lines.map((line) => optionalString(line, '', { maxLength: 240 })).filter(Boolean)
            : [],
        };
      })
      .filter(Boolean)
    : []
);

const rewriteLiveHlsManifest = (manifestText, payload) => rewriteHlsManifestUris(manifestText, (assetReference) => {
  const resolvedAssetPath = path.posix.join(path.posix.dirname(payload.storagePath), assetReference);
  return buildLiveHlsAssetUrl(payload, resolvedAssetPath, getHlsAssetMimeType(resolvedAssetPath));
});

const getActingUser = async (req) => {
  if (req.user?.profile) {
    return req.user.profile;
  }

  const user = await usersRepository.findSafeById(req.user?.id || '');
  if (!user) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }
  return user;
};

const buildStateBackedAccess = async ({ liveClass, liveState, user }) => {
  const effectiveState = liveState || await ensureLiveState(liveClass);
  const effectivePlaybackType = String(effectiveState.playbackType || '').toLowerCase();

  if (effectiveState.status === 'live' && effectivePlaybackType === 'livekit' && appConfig.hasLiveKit) {
    const session = await sessionService.getSessionSnapshot(liveClass);
    const participant = session.participants.find((entry) => entry.userId === String(user._id)) || null;
    const liveKitAccess = await liveKitService.buildToken({
      liveClass,
      user,
      participant,
    });

    return {
      liveClassId: String(liveClass._id),
      title: effectiveState.title || liveClass.title,
      provider: effectiveState.provider || liveClass.provider,
      mode: effectiveState.mode || liveClass.mode || 'live',
      status: effectiveState.status,
      accessType: 'livekit-room',
      streamUrl: null,
      streamFormat: null,
      embedUrl: null,
      roomUrl: null,
      liveRoomName: liveKitAccess?.roomName || effectiveState.roomName || liveKitService.getRoomName(liveClass),
      liveKitUrl: appConfig.livekitUrl || null,
      liveKitToken: liveKitAccess?.token || null,
      liveKitIdentity: liveKitAccess?.identity || null,
      replayPlayback: null,
      replayExternalUrl: null,
      replayCourseId: effectiveState.replayCourseId || null,
      replayLessonId: effectiveState.replayLessonId || null,
      recordingState: effectiveState.recordingState || null,
      replayState: effectiveState.replayState || null,
      tokenExpiresAt: liveKitAccess?.tokenExpiresAt || null,
      watermarkText: `${user.email} • ${user._id}`,
      statusMessage: 'Live class is running inside the in-app classroom.',
    };
  }

  const playbackUrl = normalizeOptionalUrl(effectiveState.playbackUrl);
  if (effectiveState.status === 'live' && effectivePlaybackType === 'live-stream' && playbackUrl) {
    const extension = playbackUrl.toLowerCase().includes('.m3u8') ? '.m3u8' : '.mp4';
    const mimeType = extension === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4';
    const issuedToken = issuePlaybackToken({
      userId: String(user._id),
      sessionId: user.session || null,
      liveClassId: String(liveClass._id),
      upstreamUrl: playbackUrl,
      mimeType,
      assetKind: extension === '.m3u8' ? 'live-hls' : 'live-source',
    });

    return {
      liveClassId: String(liveClass._id),
      title: effectiveState.title || liveClass.title,
      provider: effectiveState.provider || liveClass.provider,
      mode: effectiveState.mode || liveClass.mode || 'live',
      status: effectiveState.status,
      accessType: 'live-stream',
      streamUrl: `/backend/api/live-classes/stream/${issuedToken.token}`,
      streamFormat: extension === '.m3u8' ? 'hls' : 'source',
      embedUrl: null,
      roomUrl: null,
      replayPlayback: null,
      replayExternalUrl: null,
      replayCourseId: effectiveState.replayCourseId || null,
      replayLessonId: effectiveState.replayLessonId || null,
      recordingState: effectiveState.recordingState || null,
      replayState: effectiveState.replayState || null,
      tokenExpiresAt: issuedToken.expiresAt,
      watermarkText: `${user.email} • ${user._id}`,
      statusMessage: 'Live class is running with protected in-app playback.',
    };
  }

  return null;
};

const buildAdminTeacherStudioAccess = async ({ liveClassId, user }) => {
  if (String(user?.role || '').toLowerCase() !== 'admin') {
    return null;
  }

  const access = await liveClassesRepository.getAccess({
    liveClassId,
    userId: user?._id,
    user,
  });

  return access.accessType === 'livekit-room' || access.accessType === 'jitsi-room' ? access : null;
};

const requireAdmin = (req) => {
  if (req.user?.role !== 'admin') {
    throw new ApiError(403, 'Admin access required', { code: 'ADMIN_REQUIRED' });
  }
};

const findLiveClassOrThrow = async (liveClassId) => {
  const liveClass = await liveClassesRepository.findRawById(liveClassId);
  if (!liveClass) {
    throw new ApiError(404, 'Live class not found', { code: 'LIVE_CLASS_NOT_FOUND' });
  }
  return liveClass;
};

const listLiveClasses = asyncHandler(async (_req, res) => {
  const liveClasses = await liveClassesRepository.list();
  return ok(res, { liveClasses });
});

const listAdminLiveClasses = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClasses = await liveClassesRepository.listAdmin();
  return ok(res, { liveClasses: liveClasses.map(buildAdminIngestDetails) });
});

const uploadLiveImageAsset = asyncHandler(async (req, res) => {
  requireAdmin(req);
  if (!req.file) {
    throw new ApiError(400, 'Image file is required', { code: 'LIVE_IMAGE_REQUIRED' });
  }

  return created(res, {
    asset: {
      url: `/uploads/live-posters/${req.file.filename}`,
      name: req.file.originalname || req.file.filename,
      mimeType: req.file.mimetype || null,
      size: Number(req.file.size || 0),
    },
  });
});

const createLiveClass = asyncHandler(async (req, res) => {
  requireAdmin(req);
  if (!appConfig.hasLiveKit && !appConfig.hasManagedLiveHls) {
    throw new ApiError(503, 'No live backend is configured. Configure managed HLS or LiveKit.', {
      code: 'LIVE_BACKEND_REQUIRED',
    });
  }
  const title = requireString(req.body?.title, 'title', { maxLength: 160 });
  const startTime = requireString(req.body?.startTime, 'startTime');
  const durationMinutes = requireNumber(req.body?.durationMinutes ?? 60, 'durationMinutes', { min: 15, max: 480 });
  const provider = optionalString(req.body?.provider, 'LiveKit Cloud', { maxLength: 80 });
  const mockTestId = optionalString(req.body?.mockTestId, '', { maxLength: 120 }) || null;
  const mockTestTitle = optionalString(req.body?.mockTestTitle, '', { maxLength: 255 }) || null;
  const courseId = optionalString(req.body?.courseId, '', { maxLength: 120 }) || null;
  const linkageType = optionalString(
    req.body?.linkageType,
    mockTestId ? 'mock-test' : courseId ? 'course' : 'standalone',
    { maxLength: 40 },
  );
  const topicTags = Array.isArray(req.body?.topicTags) ? req.body.topicTags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const instructor = optionalString(req.body?.instructor, 'Live Faculty', { maxLength: 120 });
  const teacherProfile = sanitizeTeacherProfileInput(req.body?.teacherProfile, instructor);
  if (mockTestId && !topicTags.some((tag) => String(tag).toLowerCase() === `mock-test-id:${String(mockTestId).toLowerCase()}`)) {
    topicTags.push(`mock-test-id:${mockTestId}`);
  }
  if (mockTestTitle && !topicTags.some((tag) => String(tag).toLowerCase().startsWith('mock-test:'))) {
    topicTags.push(`mock-test:${mockTestTitle}`);
  }

  const createdLiveClass = await liveClassesRepository.create({
    title,
    linkageType,
    courseId,
    moduleId: optionalString(req.body?.moduleId, '', { maxLength: 120 }) || null,
    moduleTitle: optionalString(req.body?.moduleTitle, '', { maxLength: 160 }) || null,
    chapterId: optionalString(req.body?.chapterId, '', { maxLength: 120 }) || null,
    chapterTitle: optionalString(req.body?.chapterTitle, '', { maxLength: 160 }) || null,
    mockTestId,
    mockTestTitle,
    instructor,
    startTime,
    durationMinutes,
    provider,
    mode: 'live',
    status: optionalString(req.body?.status, 'scheduled', { maxLength: 30 }),
    attendees: requireNumber(req.body?.attendees ?? 0, 'attendees', { min: 0 }),
    maxAttendees: requireNumber(req.body?.maxAttendees ?? 2500, 'maxAttendees', { min: 1, max: 100000 }),
    requiresEnrollment: req.body?.requiresEnrollment === undefined ? true : requireBoolean(req.body.requiresEnrollment, 'requiresEnrollment'),
    chatEnabled: req.body?.chatEnabled === undefined ? true : requireBoolean(req.body.chatEnabled, 'chatEnabled'),
    doubtSolving: req.body?.doubtSolving === undefined ? true : requireBoolean(req.body.doubtSolving, 'doubtSolving'),
    replayAvailable: req.body?.replayAvailable === undefined ? true : requireBoolean(req.body.replayAvailable, 'replayAvailable'),
    posterUrl: optionalString(req.body?.posterUrl, '', { maxLength: 2000 }) || null,
    description: optionalString(req.body?.description, '', { maxLength: 3000 }) || null,
    teacherProfile,
    sessionNotes: Array.isArray(req.body?.sessionNotes)
      ? req.body.sessionNotes.map((item) => optionalString(item, '', { maxLength: 240 })).filter(Boolean)
      : [],
    resources: sanitizeResourceItemsInput(req.body?.resources),
    activePoll: sanitizeActivePollInput(req.body?.activePoll),
    topicTags,
  });

  const preferredPlaybackType = resolvePreferredLivePlaybackType();
  if (!preferredPlaybackType) {
    throw new ApiError(503, 'No live backend is configured. Configure managed HLS or LiveKit.', {
      code: 'LIVE_BACKEND_REQUIRED',
    });
  }
  const teacherStudio = buildJitsiTeacherStudioAccess(createdLiveClass);

  const nextLiveClass = preferredPlaybackType === 'livekit'
    ? await liveClassesRepository.update(createdLiveClass._id, {
      livePlaybackType: 'livekit',
      roomUrl: null,
      embedUrl: null,
      livePlaybackUrl: null,
      roomName: liveKitService.getRoomName(createdLiveClass),
      provider: 'LiveKit Cloud',
    })
    : await liveClassesRepository.update(createdLiveClass._id, {
      livePlaybackType: 'live-stream',
      roomUrl: teacherStudio.roomUrl,
      embedUrl: teacherStudio.embedUrl,
      livePlaybackUrl: null,
      provider: 'Managed HLS',
    });

  await sessionService.ensureSession(nextLiveClass, {
    status: nextLiveClass.status || 'scheduled',
    roomName: nextLiveClass.roomName || null,
  });
  await ensureLiveState(nextLiveClass, {
    status: nextLiveClass.status || 'scheduled',
    roomName: nextLiveClass.roomName || null,
    provider: nextLiveClass.provider || null,
    playbackType: nextLiveClass.livePlaybackType || null,
    playbackUrl: nextLiveClass.livePlaybackUrl || null,
    recordingState: deriveRuntimeRecordingState(nextLiveClass),
    replayState: deriveRuntimeReplayState(nextLiveClass),
  });
  if (String(nextLiveClass.status || 'scheduled').toLowerCase() === 'scheduled') {
    queueLiveClassNotification(() => notificationsRepository.notifyLiveClassScheduled(nextLiveClass));
  }
  await broadcastLiveClassUpdate(nextLiveClass, 'live-class.updated');
  return created(res, { liveClass: buildAdminIngestDetails(nextLiveClass) });
});

const updateLiveClass = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const nextPosterUrl = req.body?.posterUrl === undefined ? liveClass.posterUrl : optionalString(req.body.posterUrl, '', { maxLength: 2000 }) || null;
  const nextTeacherProfile = req.body?.teacherProfile === undefined
    ? liveClass.teacherProfile
    : sanitizeTeacherProfileInput(
      req.body.teacherProfile,
      req.body?.instructor === undefined ? liveClass.instructor : requireString(req.body.instructor, 'instructor', { maxLength: 120 }),
    );
  const nextLiveClass = await liveClassesRepository.update(liveClass._id, {
    title: req.body?.title === undefined ? liveClass.title : requireString(req.body.title, 'title', { maxLength: 160 }),
    instructor: req.body?.instructor === undefined ? liveClass.instructor : requireString(req.body.instructor, 'instructor', { maxLength: 120 }),
    startTime: req.body?.startTime === undefined ? liveClass.startTime : requireString(req.body.startTime, 'startTime'),
    durationMinutes: req.body?.durationMinutes === undefined ? liveClass.durationMinutes : requireNumber(req.body.durationMinutes, 'durationMinutes', { min: 15, max: 480 }),
    status: req.body?.status === undefined ? liveClass.status : optionalString(req.body.status, liveClass.status, { maxLength: 30 }),
    linkageType: req.body?.linkageType === undefined ? liveClass.linkageType : optionalString(req.body.linkageType, liveClass.linkageType || 'standalone', { maxLength: 40 }),
    courseId: req.body?.courseId === undefined ? liveClass.courseId : optionalString(req.body.courseId, '', { maxLength: 120 }) || null,
    moduleId: req.body?.moduleId === undefined ? liveClass.moduleId : optionalString(req.body.moduleId, '', { maxLength: 120 }) || null,
    moduleTitle: req.body?.moduleTitle === undefined ? liveClass.moduleTitle : optionalString(req.body.moduleTitle, '', { maxLength: 160 }) || null,
    chapterId: req.body?.chapterId === undefined ? liveClass.chapterId : optionalString(req.body.chapterId, '', { maxLength: 120 }) || null,
    chapterTitle: req.body?.chapterTitle === undefined ? liveClass.chapterTitle : optionalString(req.body.chapterTitle, '', { maxLength: 160 }) || null,
    mockTestId: req.body?.mockTestId === undefined ? liveClass.mockTestId : optionalString(req.body.mockTestId, '', { maxLength: 120 }) || null,
    mockTestTitle: req.body?.mockTestTitle === undefined ? liveClass.mockTestTitle : optionalString(req.body.mockTestTitle, '', { maxLength: 255 }) || null,
    recordingUrl: req.body?.recordingUrl === undefined ? liveClass.recordingUrl : optionalString(req.body.recordingUrl, '', { maxLength: 2000 }) || null,
    recordingStorageProvider: req.body?.recordingStorageProvider === undefined ? liveClass.recordingStorageProvider : optionalString(req.body.recordingStorageProvider, '', { maxLength: 40 }) || null,
    recordingStoragePath: req.body?.recordingStoragePath === undefined ? liveClass.recordingStoragePath : optionalString(req.body.recordingStoragePath, '', { maxLength: 2000 }) || null,
    recordingPublishedAt: req.body?.recordingPublishedAt === undefined ? liveClass.recordingPublishedAt : optionalString(req.body.recordingPublishedAt, '', { maxLength: 80 }) || null,
    recordingExpiresAt: req.body?.recordingExpiresAt === undefined ? liveClass.recordingExpiresAt : optionalString(req.body.recordingExpiresAt, '', { maxLength: 80 }) || null,
    recordingDurationMinutes: req.body?.recordingDurationMinutes === undefined ? liveClass.recordingDurationMinutes : requireNumber(req.body.recordingDurationMinutes, 'recordingDurationMinutes', { min: 1, max: 10000 }),
    replayAvailable: req.body?.replayAvailable === undefined ? liveClass.replayAvailable : requireBoolean(req.body.replayAvailable, 'replayAvailable'),
    replayCourseId: req.body?.replayCourseId === undefined ? liveClass.replayCourseId : optionalString(req.body.replayCourseId, '', { maxLength: 120 }) || null,
    replayLessonId: req.body?.replayLessonId === undefined ? liveClass.replayLessonId : optionalString(req.body.replayLessonId, '', { maxLength: 120 }) || null,
    posterUrl: nextPosterUrl,
    description: req.body?.description === undefined ? liveClass.description : optionalString(req.body.description, '', { maxLength: 3000 }) || null,
    teacherProfile: nextTeacherProfile,
    sessionNotes: Array.isArray(req.body?.sessionNotes)
      ? req.body.sessionNotes.map((item) => optionalString(item, '', { maxLength: 240 })).filter(Boolean)
      : liveClass.sessionNotes,
    resources: req.body?.resources === undefined ? liveClass.resources : sanitizeResourceItemsInput(req.body.resources),
    activePoll: req.body?.activePoll === undefined ? liveClass.activePoll : sanitizeActivePollInput(req.body.activePoll),
    topicTags: Array.isArray(req.body?.topicTags) ? req.body.topicTags.map((tag) => String(tag).trim()).filter(Boolean) : liveClass.topicTags,
  });

  if (nextPosterUrl !== liveClass.posterUrl) {
    removeLocalLiveImageIfManaged(liveClass.posterUrl);
  }
  if ((nextTeacherProfile?.avatarUrl || null) !== (liveClass.teacherProfile?.avatarUrl || null)) {
    removeLocalLiveImageIfManaged(liveClass.teacherProfile?.avatarUrl || null);
  }

  await sessionService.ensureSession(nextLiveClass, {
    status: nextLiveClass.status,
    roomName: nextLiveClass.roomName || liveClass.roomName || null,
  });
  await ensureLiveState(nextLiveClass, {
    status: nextLiveClass.status,
    roomName: nextLiveClass.roomName || liveClass.roomName || null,
    provider: nextLiveClass.provider || liveClass.provider || null,
    playbackType: nextLiveClass.livePlaybackType || liveClass.livePlaybackType || null,
    playbackUrl: nextLiveClass.livePlaybackUrl || liveClass.livePlaybackUrl || null,
    recordingState: deriveRuntimeRecordingState(nextLiveClass),
    replayState: deriveRuntimeReplayState(nextLiveClass),
  });
  const scheduleChanged = (
    String(nextLiveClass.title || '') !== String(liveClass.title || '')
    || String(nextLiveClass.startTime || '') !== String(liveClass.startTime || '')
    || String(nextLiveClass.status || '') !== String(liveClass.status || '')
  );
  const nextStatus = String(nextLiveClass.status || '').toLowerCase();
  if (scheduleChanged && ['scheduled', 'upcoming'].includes(nextStatus)) {
    queueLiveClassNotification(() => notificationsRepository.notifyLiveClassScheduled(nextLiveClass, { updated: true }));
  }
  await broadcastLiveClassUpdate(nextLiveClass, 'live-class.updated');
  return ok(res, { liveClass: buildAdminIngestDetails(nextLiveClass) });
});

const deleteLiveClass = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  removeLocalLiveImageIfManaged(liveClass.posterUrl);
  removeLocalLiveImageIfManaged(liveClass.teacherProfile?.avatarUrl || null);
  await liveClassesRepository.delete(liveClass._id);
  return ok(res, { message: 'Live class deleted successfully', liveClassId: liveClass._id });
});

const startLiveClass = asyncHandler(async (req, res) => {
  requireAdmin(req);
  if (!appConfig.hasLiveKit && !appConfig.hasManagedLiveHls) {
    throw new ApiError(503, 'No live backend is configured. Configure managed HLS or LiveKit.', {
      code: 'LIVE_BACKEND_REQUIRED',
    });
  }
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const livePlaybackType = resolvePreferredLivePlaybackType()
    || normalizeLivePlaybackType(liveClass.livePlaybackType)
    || (appConfig.hasManagedLiveHls ? 'live-stream' : 'livekit');
  const roomName = livePlaybackType === 'livekit' ? liveKitService.getRoomName(liveClass) : liveClass.roomName || null;
  const teacherStudio = livePlaybackType === 'live-stream'
    ? buildJitsiTeacherStudioAccess(liveClass)
    : null;
  const nextLiveClass = await liveClassesRepository.update(liveClass._id, {
    status: 'live',
    startTime: liveClass.startTime || new Date().toISOString(),
    livePlaybackType,
    provider: livePlaybackType === 'livekit' ? 'LiveKit Cloud' : 'Managed HLS',
    livePlaybackUrl: livePlaybackType === 'live-stream' ? (liveClass.livePlaybackUrl || null) : null,
    roomUrl: livePlaybackType === 'livekit' ? null : (liveClass.roomUrl || teacherStudio?.roomUrl || null),
    embedUrl: livePlaybackType === 'livekit' ? null : (liveClass.embedUrl || teacherStudio?.embedUrl || null),
    roomName,
  });

  if (livePlaybackType === 'livekit') {
    await liveKitService.createRoomIfMissing(nextLiveClass);
  }

  const session = await sessionService.syncStatus(nextLiveClass, 'live');
  await ensureLiveState(nextLiveClass, {
    status: 'live',
    roomName,
    provider: livePlaybackType === 'livekit' ? 'LiveKit Cloud' : 'Managed HLS',
    playbackType: livePlaybackType,
    playbackUrl: livePlaybackType === 'live-stream' ? (nextLiveClass.livePlaybackUrl || liveClass.livePlaybackUrl || null) : null,
    startedAt: session.startedAt || new Date().toISOString(),
    endedAt: null,
    recordingState: nextLiveClass.replayAvailable !== false ? 'recording' : 'disabled',
    replayState: nextLiveClass.replayAvailable !== false ? 'pending' : 'disabled',
  });
  queueLiveClassNotification(() => notificationsRepository.notifyLiveClassStarted(nextLiveClass));
  await broadcastLiveClassUpdate(nextLiveClass, 'live-class.started');
  return ok(res, { liveClass: buildAdminIngestDetails(nextLiveClass), session });
});

const endLiveClass = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const nextLiveClass = await liveClassesRepository.update(liveClass._id, {
    status: 'ended',
  });

  const livePlaybackType = String(nextLiveClass.livePlaybackType || liveClass.livePlaybackType || '').toLowerCase();
  const session = await sessionService.syncStatus(nextLiveClass, 'ended');
  await ensureLiveState(nextLiveClass, {
    status: 'ended',
    playbackType: livePlaybackType || null,
    provider: nextLiveClass.provider || liveClass.provider || null,
    playbackUrl: nextLiveClass.livePlaybackUrl || liveClass.livePlaybackUrl || null,
    startedAt: session.startedAt || null,
    endedAt: session.endedAt || new Date().toISOString(),
    recordingState: nextLiveClass.replayAvailable !== false ? 'processing' : 'disabled',
    replayState: nextLiveClass.replayAvailable !== false ? 'pending' : 'disabled',
  });
  if (livePlaybackType === 'livekit') {
    await liveKitService.closeRoom(nextLiveClass);
  }
  await broadcastLiveClassUpdate(nextLiveClass, 'live-class.ended');
  return ok(res, { liveClass: nextLiveClass, session });
});

const getLiveClassAccess = asyncHandler(async (req, res) => {
  const user = await getActingUser(req);
  const accessCacheKey = getLiveAccessCacheKey(req.params.liveClassId, req.user?.id || user._id);
  const liveState = await readLiveState(req.params.liveClassId);
  const useStateBackedAccess = Boolean(liveState);

  const liveClass = useStateBackedAccess
    ? {
      _id: req.params.liveClassId,
      title: liveState.title,
      provider: liveState.provider,
      mode: liveState.mode || 'live',
      roomName: liveState.roomName || null,
      liveRoomName: liveState.roomName || null,
      livePlaybackUrl: liveState.playbackUrl || null,
      livePlaybackType: liveState.playbackType || null,
      status: liveState.status,
      courseId: liveState.courseId || null,
      requiresEnrollment: liveState.requiresEnrollment !== false,
      chatEnabled: liveState.chatEnabled !== false,
      doubtSolving: liveState.doubtSolving !== false,
      replayAvailable: liveState.replayAvailable !== false,
      replayCourseId: liveState.replayCourseId || null,
      replayLessonId: liveState.replayLessonId || null,
      recordingUrl: liveState.recordingUrl || null,
      recordingStorageProvider: liveState.recordingStorageProvider || null,
      recordingStoragePath: liveState.recordingStoragePath || null,
      recordingPublishedAt: liveState.recordingPublishedAt || null,
    }
    : await findLiveClassOrThrow(req.params.liveClassId);

  const stateBackedAccess = useStateBackedAccess
    ? await buildStateBackedAccess({ liveClass, liveState, user })
    : null;

  if (stateBackedAccess) {
    if (
      String(user.role || '').toLowerCase() !== 'admin'
      && liveState?.requiresEnrollment !== false
      && liveState?.courseId
    ) {
      await liveClassesRepository.getAccess({
        liveClassId: req.params.liveClassId,
        userId: req.user?.id,
        user,
      });
    }
    if (stateBackedAccess.accessType === 'live-stream' && stateBackedAccess.status === 'live') {
      await sessionService.joinSession(liveClass, user);
      const adminTeacherStudioAccess = await buildAdminTeacherStudioAccess({
        liveClassId: req.params.liveClassId,
        user,
      });
      if (adminTeacherStudioAccess) {
        await setRedisJson(accessCacheKey, adminTeacherStudioAccess, { ttlSeconds: LIVE_ACCESS_CACHE_TTL_SECONDS }).catch(() => false);
        return ok(res, adminTeacherStudioAccess);
      }
    }
    if (stateBackedAccess.accessType !== 'livekit-room') {
      await setRedisJson(accessCacheKey, stateBackedAccess, { ttlSeconds: LIVE_ACCESS_CACHE_TTL_SECONDS }).catch(() => false);
    }
    return ok(res, stateBackedAccess);
  }

  const cachedAccess = await getRedisJson(accessCacheKey).catch(() => null);
  if (cachedAccess && cachedAccess.accessType !== 'livekit-room') {
    if (cachedAccess.accessType === 'live-stream' && cachedAccess.status === 'live') {
      await sessionService.joinSession({
        _id: req.params.liveClassId,
        status: cachedAccess.status,
        roomName: cachedAccess.liveRoomName || null,
        liveRoomName: cachedAccess.liveRoomName || null,
      }, user);
      const adminTeacherStudioAccess = await buildAdminTeacherStudioAccess({
        liveClassId: req.params.liveClassId,
        user,
      });
      if (adminTeacherStudioAccess) {
        await setRedisJson(accessCacheKey, adminTeacherStudioAccess, { ttlSeconds: LIVE_ACCESS_CACHE_TTL_SECONDS }).catch(() => false);
        return ok(res, adminTeacherStudioAccess);
      }
    }
    return ok(res, cachedAccess);
  }

  const access = await liveClassesRepository.getAccess({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    user,
  });
  if (access.accessType === 'livekit-room' && appConfig.hasLiveKit) {
    const session = await sessionService.getSessionSnapshot(liveClass);
    const participant = session.participants.find((entry) => entry.userId === String(user._id)) || null;
    const liveKitAccess = await liveKitService.buildToken({
      liveClass,
      user,
      participant,
    });
    return ok(res, {
      ...access,
      liveRoomName: liveKitAccess?.roomName || access.liveRoomName || liveKitService.getRoomName(liveClass),
      liveKitUrl: appConfig.livekitUrl || access.liveKitUrl || null,
      liveKitToken: liveKitAccess?.token || null,
      liveKitIdentity: liveKitAccess?.identity || null,
      tokenExpiresAt: liveKitAccess?.tokenExpiresAt || null,
    });
  }

  if (access.accessType === 'live-stream' && access.status === 'live') {
    await sessionService.joinSession(liveClass, user);
  }

  if (access.accessType !== 'livekit-room') {
    await setRedisJson(accessCacheKey, access, { ttlSeconds: LIVE_ACCESS_CACHE_TTL_SECONDS }).catch(() => false);
  }

  return ok(res, access);
});

const getLiveClassChat = asyncHandler(async (req, res) => {
  const user = await getActingUser(req);
  await liveClassesRepository.getAccess({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    user,
  });
  const messages = await liveClassesRepository.getChat(req.params.liveClassId);
  return ok(res, { messages });
});

const postLiveClassChat = asyncHandler(async (req, res) => {
  const message = await liveClassesRepository.postChat({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    message: requireString(req.body?.message, 'message', { maxLength: 2000 }),
    kind: optionalString(req.body?.kind, 'chat', { maxLength: 20 }),
  });

  await sessionService.publishChat(req.params.liveClassId, message);
  return created(res, { message });
});

const getSessionState = asyncHandler(async (req, res) => {
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const user = await getActingUser(req);
  await liveClassesRepository.getAccess({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    user,
  });
  return ok(res, { session: await sessionService.getSessionSnapshot(liveClass) });
});

const joinSession = asyncHandler(async (req, res) => {
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const user = await getActingUser(req);
  const access = await liveClassesRepository.getAccess({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    user,
  });
  if (access.status !== 'live') {
    throw new ApiError(409, 'Live class is not active yet', { code: 'LIVE_CLASS_NOT_ACTIVE' });
  }

  await sessionService.joinSession(liveClass, user);
  res.status(204).end();
});

const leaveSession = asyncHandler(async (req, res) => {
  const session = await sessionService.leaveSession(req.params.liveClassId, req.user?.id);
  return ok(res, { session });
});

const heartbeat = asyncHandler(async (req, res) => {
  const participant = await sessionService.heartbeat(req.params.liveClassId, req.user?.id);
  return ok(res, { participant });
});

const updateMedia = asyncHandler(async (req, res) => {
  const participant = await sessionService.updateParticipantMedia(req.params.liveClassId, req.user?.id, {
    micMuted: req.body?.micMuted === undefined ? undefined : requireBoolean(req.body.micMuted, 'micMuted'),
    videoEnabled: req.body?.videoEnabled === undefined ? undefined : requireBoolean(req.body.videoEnabled, 'videoEnabled'),
    isScreenSharing: req.body?.isScreenSharing === undefined ? undefined : requireBoolean(req.body.isScreenSharing, 'isScreenSharing'),
  });
  return ok(res, { participant });
});

const updateRaisedHand = asyncHandler(async (req, res) => {
  const participant = await sessionService.setRaisedHand(
    req.params.liveClassId,
    req.user?.id,
    requireBoolean(req.body?.raised, 'raised'),
  );
  return ok(res, { participant });
});

const submitPollVote = asyncHandler(async (req, res) => {
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const user = await getActingUser(req);
  await liveClassesRepository.getAccess({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    user,
  });

  const optionId = requireString(req.body?.optionId, 'optionId', { maxLength: 80 });
  const activePoll = sanitizeActivePollInput(liveClass.activePoll);
  if (!activePoll) {
    throw new ApiError(409, 'No live poll is running right now', { code: 'LIVE_POLL_NOT_ACTIVE' });
  }

  const optionExists = activePoll.options.some((option) => String(option.id) === optionId);
  if (!optionExists) {
    throw new ApiError(400, 'Poll option not found', { code: 'LIVE_POLL_OPTION_NOT_FOUND' });
  }

  const nextPoll = {
    ...activePoll,
    responses: {
      ...(activePoll.responses || {}),
      [String(user._id)]: optionId,
    },
  };

  const nextLiveClass = await liveClassesRepository.update(liveClass._id, {
    activePoll: nextPoll,
  });

  await broadcastLiveClassUpdate(nextLiveClass, 'live-class.updated');
  return ok(res, {
    liveClass: buildLiveClassEventSnapshot(nextLiveClass),
    activePoll: enrichActivePoll(nextLiveClass.activePoll),
    selectedOptionId: optionId,
  });
});

const updateSpeakerApproval = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const participant = await sessionService.setSpeakerApproval(
    req.params.liveClassId,
    req.params.participantUserId,
    requireBoolean(req.body?.approved, 'approved'),
  );
  if (appConfig.hasLiveKit) {
    await liveKitService.syncParticipantPermission(liveClass, participant);
  }
  return ok(res, { participant });
});

const updateParticipantMute = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const participant = await sessionService.setParticipantMuted(
    req.params.liveClassId,
    req.params.participantUserId,
    requireBoolean(req.body?.muted, 'muted'),
  );
  if (appConfig.hasLiveKit) {
    await liveKitService.syncParticipantPermission(liveClass, participant);
  }
  return ok(res, { participant });
});

const removeParticipant = asyncHandler(async (req, res) => {
  requireAdmin(req);
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const participant = await sessionService.removeParticipant(req.params.liveClassId, req.params.participantUserId);
  if (appConfig.hasLiveKit) {
    await liveKitService.removeParticipant(liveClass, req.params.participantUserId);
  }
  return ok(res, { participant });
});

const validateIngestPublish = asyncHandler(async (req, res) => {
  const rawStreamName = String(req.body?.name || req.body?.path || req.query?.name || req.query?.path || '').trim();
  const authAction = String(req.body?.action || '').trim().toLowerCase();
  const authProtocol = String(req.body?.protocol || '').trim().toLowerCase();
  const requestQuery = new URLSearchParams(String(req.body?.query || req.originalUrl.split('?')[1] || ''));
  const secret = String(
    req.body?.secret
      || req.query?.secret
      || req.body?.password
      || req.body?.token
      || requestQuery.get('secret')
      || requestQuery.get('pass')
      || '',
  ).trim();

  if (!appConfig.liveIngestPublisherSecret || secret !== appConfig.liveIngestPublisherSecret) {
    throw new ApiError(403, 'Invalid live ingest secret', { code: 'LIVE_INGEST_SECRET_INVALID' });
  }

  if (authAction && authAction !== 'publish') {
    res.status(200).send('OK');
    return;
  }

  if (authProtocol && authProtocol !== 'rtmp') {
    res.status(200).send('OK');
    return;
  }

  if (!rawStreamName) {
    throw new ApiError(400, 'Missing stream name', { code: 'LIVE_INGEST_STREAM_NAME_REQUIRED' });
  }

  const normalizedStreamName = rawStreamName
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .pop() || '';
  const liveClassId = normalizedStreamName.split('__')[0];
  const liveClass = await findLiveClassOrThrow(liveClassId);
  const requestOrigin = `${req.protocol}://${req.get('host')}`;
  if (shouldUseLocalDevHlsOrigin()) {
    await ensureLocalDevHlsAssets(normalizedStreamName);
  }
  const playbackUrl = buildManagedHlsPlaybackUrl(normalizedStreamName, requestOrigin);
  await writeLiveState(buildLiveStateFromClass(liveClass, {
    status: 'live',
    provider: 'Managed HLS',
    playbackType: 'live-stream',
    playbackUrl,
    playbackReadyAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    recordingState: liveClass.replayAvailable !== false ? 'recording' : 'disabled',
    replayState: liveClass.replayAvailable !== false ? 'pending' : 'disabled',
  }));
  await sessionService.syncStatus({
    ...liveClass,
    status: 'live',
    livePlaybackType: 'live-stream',
    livePlaybackUrl: playbackUrl,
    provider: 'Managed HLS',
  }, 'live');
  queueLiveClassPersistence(liveClass._id, {
    status: 'live',
    livePlaybackType: 'live-stream',
    livePlaybackUrl: playbackUrl,
    provider: 'Managed HLS',
  });
  res.status(200).send('OK');
});

const streamProtectedLiveAsset = asyncHandler(async (req, res) => {
  const token = requireString(req.params.token, 'playback token');
  const payload = verifyPlaybackToken(token);

  if (!payload) {
    throw new ApiError(401, 'Playback token is invalid or expired', { code: 'PLAYBACK_TOKEN_INVALID' });
  }

  if (payload.upstreamUrl) {
    await proxyLiveUpstreamAsset({ payload, res });
    return;
  }

  if (isS3Provider(payload.storageProvider) && payload.assetKind === 'hls') {
    const extension = path.extname(String(payload.storagePath || '')).toLowerCase();
    if (extension === '.m3u8') {
      const manifestBuffer = await getPrivateStorageObjectBuffer({
        storageProvider: payload.storageProvider,
        storagePath: payload.storagePath,
      });

      if (!manifestBuffer) {
        throw new ApiError(404, 'Protected live replay manifest could not be delivered', { code: 'LIVE_HLS_MANIFEST_UNAVAILABLE' });
      }

      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteLiveHlsManifest(manifestBuffer.toString('utf8'), payload));
      return;
    }

    const signedUrl = await getSignedPrivateVideoUrl({
      storagePath: payload.storagePath,
      mimeType: payload.mimeType,
    });

    if (!signedUrl) {
      throw new ApiError(404, 'Protected live replay asset could not be delivered', { code: 'LIVE_HLS_ASSET_UNAVAILABLE' });
    }

    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.redirect(307, signedUrl);
    return;
  }

  throw new ApiError(404, 'Protected live asset could not be delivered', { code: 'LIVE_ASSET_UNAVAILABLE' });
});

const streamEvents = asyncHandler(async (req, res) => {
  const liveClass = await findLiveClassOrThrow(req.params.liveClassId);
  const user = await getActingUser(req);
  await liveClassesRepository.getAccess({
    liveClassId: req.params.liveClassId,
    userId: req.user?.id,
    user,
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  sessionService.registerStream(liveClass._id, res);
  res.write(`event: session.snapshot\n`);
  res.write(`data: ${JSON.stringify({
    event: 'session.snapshot',
    liveClassId: String(liveClass._id),
    timestamp: new Date().toISOString(),
    session: await sessionService.getSessionSnapshot(liveClass),
  })}\n\n`);

  const heartbeatTimer = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeatTimer);
    sessionService.unregisterStream(liveClass._id, res);
    res.end();
  });
});

module.exports = {
  listLiveClasses,
  listAdminLiveClasses,
  uploadLiveImageAsset,
  createLiveClass,
  updateLiveClass,
  deleteLiveClass,
  startLiveClass,
  endLiveClass,
  getLiveClassAccess,
  getLiveClassChat,
  postLiveClassChat,
  getSessionState,
  joinSession,
  leaveSession,
  heartbeat,
  updateMedia,
  updateRaisedHand,
  submitPollVote,
  updateSpeakerApproval,
  updateParticipantMute,
  removeParticipant,
  validateIngestPublish,
  streamProtectedLiveAsset,
  streamEvents,
};
