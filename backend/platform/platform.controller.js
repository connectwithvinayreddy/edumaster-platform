const { platformRepository } = require('../lib/repositories.js');
const { generateAssessmentDraft } = require('../lib/ai-content.js');
const { buildSecurePlaybackClientContext } = require('../lib/secure-playback.js');
const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
  requireNumber,
  optionalNumber,
  requireBoolean,
} = require('../lib/http.js');

const getOverview = asyncHandler(async (req, res) => {
  const requestedUserId = req.query.userId || null;
  const userId = req.user?.role === 'admin'
    ? requestedUserId || req.user?.id || null
    : req.user?.id || null;
  const overview = await platformRepository.getOverview(userId);
  return ok(res, overview);
});

const enroll = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  const courseId = requireString(req.body?.courseId, 'courseId');
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }
  if (req.user?.role !== 'admin') {
    throw new ApiError(403, 'Course access requires a verified payment', { code: 'PAYMENT_REQUIRED' });
  }

  const enrollment = await platformRepository.enroll({
    userId,
    courseId,
    source: optionalString(req.body?.source, 'direct-access', { maxLength: 80 }),
    accessType: optionalString(req.body?.accessType, 'course', { maxLength: 40 }),
  });

  return created(res, enrollment);
});

const subscribe = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  const planId = requireString(req.body?.planId, 'planId');
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const subscription = await platformRepository.subscribe({
    userId,
    planId,
    source: optionalString(req.body?.source, 'payment', { maxLength: 80 }),
  });

  if (!subscription) {
    throw new ApiError(404, 'Subscription plan not found', { code: 'PLAN_NOT_FOUND' });
  }

  return created(res, subscription);
});

const updateWatchProgress = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  const courseId = requireString(req.body?.courseId, 'courseId');
  const lessonId = requireString(req.body?.lessonId, 'lessonId');
  const requestContext = buildSecurePlaybackClientContext(req);
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const watchRecord = await platformRepository.updateWatchProgress({
    userId,
    courseId,
    lessonId,
    progressPercent: requireNumber(req.body?.progressPercent ?? 0, 'progressPercent', { min: 0, max: 100 }),
    progressSeconds: requireNumber(req.body?.progressSeconds ?? 0, 'progressSeconds', { min: 0 }),
    completed: requireBoolean(req.body?.completed ?? false, 'completed'),
    lessonStage: optionalString(req.body?.lessonStage, '', { maxLength: 20 }) || null,
    examSubmitted: req.body?.examSubmitted === undefined ? null : requireBoolean(req.body?.examSubmitted, 'examSubmitted'),
    examSelectedOption: req.body?.examSelectedOption === undefined || req.body?.examSelectedOption === null || req.body?.examSelectedOption === ''
      ? null
      : optionalNumber(req.body?.examSelectedOption, null, { integer: true, min: 0 }),
    explanationSeconds: optionalNumber(req.body?.explanationSeconds, null, { min: 0 }),
    videoWatchCount: optionalNumber(req.body?.videoWatchCount, null, { integer: true, min: 0 }),
    explanationWatchCount: optionalNumber(req.body?.explanationWatchCount, null, { integer: true, min: 0 }),
    durationSeconds: optionalNumber(req.body?.durationSeconds, null, { min: 0 }),
    eventType: optionalString(req.body?.eventType, '', { maxLength: 64 }) || null,
    playbackTabId: optionalString(req.body?.playbackTabId, '', { maxLength: 160 }) || null,
    requestTimestamp: optionalString(req.body?.requestTimestamp, '', { maxLength: 64 }) || null,
    sessionId: req.user?.session || null,
    requestContext,
    device: {
      id: requestContext.deviceId || req.headers['x-edumaster-device-id'] || null,
      playbackTabId: requestContext.playbackTabId || optionalString(req.body?.playbackTabId, '', { maxLength: 160 }) || null,
      platform: requestContext.platform || req.headers['x-edumaster-client-platform'] || null,
      browser: requestContext.browser || req.headers['x-edumaster-client-browser'] || null,
      app: requestContext.appMode || req.headers['x-edumaster-app'] || 'web',
      userAgent: requestContext.userAgent || req.headers['user-agent'] || null,
    },
  });

  return ok(res, watchRecord);
});

const askAi = asyncHandler(async (req, res) => {
  const userId = req.user?.id || 'guest';
  const message = requireString(req.body?.message, 'message', { maxLength: 2000 });
  const aiResponse = await platformRepository.askAi({ userId, message });
  return ok(res, aiResponse);
});

const generateAssessment = asyncHandler(async (req, res) => {
  if (req.user?.role !== 'admin') {
    throw new ApiError(403, 'Admin access required', { code: 'ADMIN_REQUIRED' });
  }

  const generated = await generateAssessmentDraft(req.body || {});
  return ok(res, generated);
});

module.exports = {
  getOverview,
  enroll,
  subscribe,
  updateWatchProgress,
  askAi,
  generateAssessment,
};
