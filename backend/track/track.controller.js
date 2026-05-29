const { asyncHandler, ok, requireString, optionalString, requireNumber, ApiError } = require('../lib/http.js');
const { platformRepository, coursesRepository } = require('../lib/repositories.js');
const { appConfig } = require('../lib/config.js');
const { buildSecurePlaybackClientContext } = require('../lib/secure-playback.js');
const {
  getRedisJson,
  setRedisJson,
  addRedisSetMember,
  removeRedisSetMember,
} = require('../lib/redis.js');

const ACTIVE_TRACK_SET = 'playback:heartbeat:active';
const HEARTBEAT_TTL_SECONDS = 180;
const WATCH_COMPLETION_THRESHOLD = Math.min(
  Math.max(Number(appConfig.videoWatchCompletionThresholdPercent || 90) / 100, 0.5),
  1,
);

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return false;
};

const buildHeartbeatKey = ({ userId, videoId, courseId, lessonId }) => [
  'playback:heartbeat',
  String(userId),
  String(courseId || 'course'),
  String(lessonId || videoId || 'lesson'),
  String(videoId),
].join(':');

const trackHeartbeat = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const videoId = requireString(req.body?.videoId, 'videoId', { maxLength: 120 });
  const courseId = optionalString(req.body?.courseId || '', '', { maxLength: 120 }) || null;
  const lessonId = optionalString(req.body?.lessonId || '', '', { maxLength: 120 }) || null;
  const currentTimeSeconds = requireNumber(req.body?.currentTimeSeconds ?? 0, 'currentTimeSeconds', { min: 0 });
  const durationSeconds = requireNumber(req.body?.durationSeconds ?? 0, 'durationSeconds', { min: 0 });
  const isPlaying = normalizeBoolean(req.body?.isPlaying);
  const completed = normalizeBoolean(req.body?.completed);
  const now = new Date().toISOString();

  const key = buildHeartbeatKey({ userId, videoId, courseId, lessonId });
  const existing = await getRedisJson(key);
  const watchSeconds = Math.max(
    Number(existing?.watchSeconds || 0),
    Number(existing?.currentTimeSeconds || 0),
    Number(currentTimeSeconds || 0),
  );

  const shouldCountCompletedWatch = !existing?.viewCountedAt
    && courseId
    && lessonId
    && durationSeconds > 0
    && watchSeconds >= (durationSeconds * WATCH_COMPLETION_THRESHOLD);

  if (shouldCountCompletedWatch) {
    // Re-check playback eligibility before counting a completed watch so
    // heartbeat spoofing cannot bypass lesson release, unlock, or platform rules.
    await coursesRepository.getProtectedLessonPlayback({
      userId,
      user: req.user?.profile || null,
      courseId,
      lessonId,
      requestContext: buildSecurePlaybackClientContext(req),
    });

    await platformRepository.recordCompletedVideoWatch({
      userId,
      courseId,
      lessonId,
      progressSeconds: watchSeconds,
      durationSeconds,
      sessionId: req.user?.session || null,
      device: {
        id: req.headers['x-edumaster-device-id'] || null,
        platform: req.headers['x-edumaster-client-platform'] || null,
        browser: req.headers['x-edumaster-client-browser'] || null,
        app: req.headers['x-edumaster-app'] || 'web',
        userAgent: req.headers['user-agent'] || null,
      },
    });
  }

  const payload = {
    userId,
    videoId,
    courseId,
    lessonId,
    currentTimeSeconds: Number(currentTimeSeconds || 0),
    durationSeconds: Number(durationSeconds || 0),
    watchSeconds,
    isPlaying,
    completed,
    lastSeenAt: now,
    startedAt: existing?.startedAt || now,
    viewCountedAt: existing?.viewCountedAt || (shouldCountCompletedWatch ? now : null),
    sessionId: req.user?.session || null,
    device: {
      id: req.headers['x-edumaster-device-id'] || null,
      platform: req.headers['x-edumaster-client-platform'] || null,
      browser: req.headers['x-edumaster-client-browser'] || null,
      app: req.headers['x-edumaster-app'] || 'web',
      userAgent: req.headers['user-agent'] || null,
    },
  };

  await setRedisJson(key, payload, { ttlSeconds: HEARTBEAT_TTL_SECONDS });
  await addRedisSetMember(ACTIVE_TRACK_SET, key);

  if (!isPlaying) {
    await removeRedisSetMember(ACTIVE_TRACK_SET, key);
  }

  return ok(res, {
    message: 'Heartbeat tracked',
    sessionKey: key,
    watchSeconds: payload.watchSeconds,
  });
});

module.exports = {
  trackHeartbeat,
  ACTIVE_TRACK_SET,
  HEARTBEAT_TTL_SECONDS,
};
