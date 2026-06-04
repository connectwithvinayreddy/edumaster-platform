const {
  ApiError,
  asyncHandler,
  ok,
  requireNumber,
  requireString,
  optionalString,
} = require('../lib/http.js');
const { videoPlaybackRepository } = require('../lib/repositories.js');
const { buildSecurePlaybackClientContext } = require('../lib/secure-playback.js');

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

const buildHeartbeatLogPayload = (req, requestContext, extra = {}) => ({
  request_id: req.requestId || null,
  replica: requestContext?.replica || String(process.env.REPLICA_NAME || process.env.HOSTNAME || process.env.SERVICE_NAME || `pid:${process.pid}`),
  user_id: req.user?.id || null,
  auth_session_id: req.user?.session || null,
  device_id: requestContext?.deviceId || null,
  browser_tab_id: requestContext?.playbackTabId || null,
  ...extra,
});

const trackHeartbeat = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const videoId = requireString(req.body?.videoId, 'videoId', { maxLength: 120 });
  const playbackSessionId = requireString(req.body?.playbackSessionId, 'playbackSessionId', { maxLength: 160 });
  const courseId = optionalString(req.body?.courseId || '', 'courseId', { maxLength: 160 }) || null;
  const lessonId = optionalString(req.body?.lessonId || '', 'lessonId', { maxLength: 160 }) || null;
  const videoType = optionalString(req.body?.videoType || '', 'videoType', { maxLength: 64 }) || null;
  const currentPositionSeconds = requireNumber(
    req.body?.currentPositionSeconds ?? req.body?.currentTimeSeconds ?? 0,
    'currentPositionSeconds',
    { min: 0 },
  );
  const previousPositionSeconds = requireNumber(
    req.body?.previousPositionSeconds ?? 0,
    'previousPositionSeconds',
    { min: 0 },
  );
  const durationSeconds = requireNumber(req.body?.durationSeconds ?? 0, 'durationSeconds', { min: 0 });
  const playbackRate = requireNumber(req.body?.playbackRate ?? 1, 'playbackRate', { min: 0, max: 8 });
  const timestamp = optionalString(req.body?.timestamp || '', 'timestamp', { maxLength: 64 }) || null;
  const requestContext = buildSecurePlaybackClientContext(req);
  const startedAtMs = Date.now();
  try {
    const heartbeatResult = await videoPlaybackRepository.recordHeartbeat({
      userId: String(userId),
      courseId: courseId || 'course',
      lessonId,
      videoId,
      videoType,
      videoDurationSeconds: durationSeconds,
      playbackSessionId,
      authSessionId: req.user?.session || null,
      requestContext,
      ipAddress: requestContext.ipAddress || null,
      userAgent: requestContext.userAgent || null,
      heartbeatPayload: {
        courseId,
        lessonId,
        videoId,
        videoType,
        playbackSessionId,
        currentPositionSeconds,
        previousPositionSeconds,
        durationSeconds,
        isPlaying: normalizeBoolean(req.body?.isPlaying),
        isPaused: normalizeBoolean(req.body?.isPaused),
        isBuffering: normalizeBoolean(req.body?.isBuffering),
        playbackRate,
        timestamp,
      },
    });

    console.info(`[video-playback-heartbeat] ${JSON.stringify(buildHeartbeatLogPayload(req, requestContext, {
      course_id: courseId,
      lesson_id: lessonId,
      video_id: videoId,
      video_type: videoType,
      playback_session_id: heartbeatResult.playbackSession?.playbackSessionId || playbackSessionId,
      heartbeat_duration_ms: Date.now() - startedAtMs,
      current_position_seconds: currentPositionSeconds,
      previous_position_seconds: previousPositionSeconds,
      accepted: heartbeatResult.outcome.accepted,
      reason: heartbeatResult.outcome.reason,
      session_status: heartbeatResult.playbackSession?.status || 'active',
      conflict_reason: heartbeatResult.outcome.conflictReason || null,
      previous_watch_summary: heartbeatResult.previousWatchSummary || null,
      next_watch_summary: heartbeatResult.watchSummary || null,
    }))}`);

    return ok(res, {
      message: 'Heartbeat tracked',
      accepted: heartbeatResult.outcome.accepted,
      reason: heartbeatResult.outcome.reason,
      outcome: heartbeatResult.outcome,
      watchState: heartbeatResult.watchState,
      playbackSessionId: heartbeatResult.playbackSession?.playbackSessionId || playbackSessionId,
      sessionStatus: heartbeatResult.playbackSession?.status || 'active',
    });
  } catch (error) {
    console.warn(`[video-playback-heartbeat] ${JSON.stringify(buildHeartbeatLogPayload(req, requestContext, {
      course_id: courseId,
      lesson_id: lessonId,
      video_id: videoId,
      video_type: videoType,
      playback_session_id: playbackSessionId,
      heartbeat_duration_ms: Date.now() - startedAtMs,
      accepted: false,
      reason: error instanceof ApiError ? error.code : 'UNKNOWN_ERROR',
      session_status: 'error',
      conflict_reason: error instanceof ApiError ? error.details?.conflictReason || error.details?.decisionReason || null : null,
      error_message: error instanceof Error ? error.message : String(error),
    }))}`);
    throw error;
  }
});

const trackSuspiciousActivity = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const eventName = requireString(req.body?.eventName || req.body?.reason, 'eventName', { maxLength: 80 });
  const courseId = optionalString(req.body?.courseId || '', 'courseId', { maxLength: 160 }) || null;
  const lessonId = optionalString(req.body?.lessonId || '', 'lessonId', { maxLength: 160 }) || null;
  const videoId = optionalString(req.body?.videoId || '', 'videoId', { maxLength: 160 }) || null;
  const videoType = optionalString(req.body?.videoType || '', 'videoType', { maxLength: 64 }) || null;
  const playbackSessionId = optionalString(req.body?.playbackSessionId || '', 'playbackSessionId', { maxLength: 160 }) || null;
  const source = optionalString(req.body?.source || 'browser-content-protection', 'source', { maxLength: 80 });
  const timestamp = optionalString(req.body?.timestamp || '', 'timestamp', { maxLength: 64 }) || null;
  const requestContext = buildSecurePlaybackClientContext(req);

  console.warn(`[protected-content-suspicious] ${JSON.stringify(buildHeartbeatLogPayload(req, requestContext, {
    event_name: eventName,
    source,
    course_id: courseId,
    lesson_id: lessonId,
    video_id: videoId,
    video_type: videoType,
    playback_session_id: playbackSessionId,
    timestamp,
    platform: requestContext.platform || null,
    browser: requestContext.browser || null,
    ip_address: requestContext.ipAddress || null,
  }))}`);

  return ok(res, {
    message: 'Suspicious protected-content event logged',
    accepted: true,
  });
});

module.exports = {
  trackHeartbeat,
  trackSuspiciousActivity,
};
