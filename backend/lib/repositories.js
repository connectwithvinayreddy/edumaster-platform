const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const path = require('path');
const User = require('../models/User.js');
const Course = require('../models/Course.js');
const Test = require('../models/Test.js');
const { ApiError } = require('./http.js');
const { getDatabaseMode } = require('./database.js');
const { initializePostgres, isPostgresReady, queryPostgres, runInTransaction } = require('./postgres.js');
const {
  getRedisValue,
  setRedisValue,
  deleteRedisKey,
  getRedisJson,
  setRedisJson,
} = require('./redis.js');
const { state, clone, nextId, nowIso } = require('./store.js');
const { decryptVideoId, normalizeYouTubeVideoId, buildSecureYouTubeEmbedUrl } = require('./video-security.js');
const { issuePlaybackToken, buildManifestBundleUrl, buildCompactAssetUrl } = require('./private-video.js');
const { appConfig } = require('./config.js');
const {
  fetchRazorpayOrder,
  fetchRazorpayPayment,
  fetchRazorpayOrderPayments,
  verifyRazorpayWebhookSignature,
} = require('../payment/razorpay-client.js');
const { getAiGenerationProviders } = require('./ai-content.js');
const {
  COURSE_VIDEO_TYPE,
  EXPLANATION_VIDEO_TYPE,
  EDITORIAL_VIDEO_TYPE,
  normalizeVideoType,
  getVideoWatchPolicy,
  getDefaultVideoWatchState,
  normalizeVideoWatchState,
  applyPlaybackHeartbeat,
  deriveProtectedReplayState,
  buildVideoWatchStateSummary,
} = require('./video-watch-limits.js');
const liveKitService = require('../live/livekit.service.js');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const normalizeMobileNumber = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.replace(/[^\d+]/g, '');
  if (!normalized) {
    return '';
  }
  const digitsOnly = normalized.replace(/\D/g, '');
  if (!digitsOnly) {
    return '';
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    return digitsOnly.slice(-10);
  }
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    return digitsOnly.slice(-10);
  }
  if (normalized.startsWith('+')) {
    return `+${digitsOnly}`;
  }
  return digitsOnly;
};
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const asArray = (value) => (Array.isArray(value) ? clone(value) : []);
const asObject = (value) => (value && typeof value === 'object' ? clone(value) : {});
const createPersistentId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`;
const createId = (prefix) => (isPostgresReady() ? createPersistentId(prefix) : nextId(prefix));
const CACHE_PREFIX = String(appConfig.cachePrefix || 'varonenglish').replace(/[:\s]+/g, '-');
const cacheKey = (name, suffix) => `${CACHE_PREFIX}:${name}:${suffix}`;
const courseDefaultValidityDays = Math.max(1, Number(appConfig.courseDefaultValidityDays || 183));
const replayRetentionDays = Math.max(1, Number(appConfig.videoReplayRetentionDays || 183));
const replayViewLimitEnabled = Boolean(appConfig.videoReplayViewLimitEnabled);
const replayMaxViews = Math.max(0, Number(appConfig.videoReplayMaxViews || 0));
const replayRetentionMs = replayRetentionDays * 24 * 60 * 60 * 1000;
const liveReplayRetentionDays = replayRetentionDays;
const liveReplayMaxViews = replayMaxViews;
const liveReplayRetentionMs = liveReplayRetentionDays * 24 * 60 * 60 * 1000;
const videoWatchChunkSeconds = Math.max(1, Number(appConfig.videoWatchChunkSeconds || 10));
const videoPlaybackReconnectGraceSeconds = Math.min(
  60,
  Math.max(30, Number(appConfig.videoPlaybackReconnectGraceSeconds || 60)),
);
const videoPlaybackSessionTtlSeconds = Math.max(
  videoPlaybackReconnectGraceSeconds + 15,
  Number(appConfig.videoPlaybackSessionTtlSeconds || 120),
);
const videoPlaybackHeartbeatGraceSeconds = Math.max(3, Number(appConfig.videoPlaybackHeartbeatGraceSeconds || 8));
const videoPlaybackMaxHeartbeatGapSeconds = Math.max(45, Number(appConfig.videoPlaybackMaxHeartbeatGapSeconds || 90));
const videoPlaybackMaxRate = Math.max(1, Number(appConfig.videoPlaybackMaxRate || 2));
const platformReadyCacheTtlMs = Math.max(1_000, Number(appConfig.platformReadyCacheTtlMs || 60_000));
const platformDataCacheTtlMs = Math.max(0, Number(appConfig.platformDataCacheTtlMs || 3_000));
const activeEnrollmentSql = "((access_status IS NULL OR access_status = 'enabled') AND (expires_at IS NULL OR expires_at > now()))";
const addDaysIso = (days, baseMs = Date.now()) => new Date(baseMs + Math.max(1, Number(days || courseDefaultValidityDays)) * 24 * 60 * 60 * 1000).toISOString();
const getPaymentStatusPriority = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'paid':
      return 3;
    case 'failed':
      return 2;
    case 'pending':
      return 1;
    default:
      return 0;
  }
};
const shouldAdvancePaymentStatus = (currentStatus, nextStatus) =>
  getPaymentStatusPriority(nextStatus) >= getPaymentStatusPriority(currentStatus);
const getCoursePayableAmount = (course) => {
  const basePrice = Math.max(0, toNumber(course?.price, 0));
  const offerPercentage = Math.min(100, Math.max(0, toNumber(course?.offerPercentage, 0)));
  const discountedPrice = basePrice * (1 - (offerPercentage / 100));
  return Math.max(Number(discountedPrice.toFixed(2)), 1);
};
const getCoursePayableAmountPaise = (course) => Math.max(100, Math.round(getCoursePayableAmount(course) * 100));
const getLessonStagePriority = (stage) => {
  switch (String(stage || '').toLowerCase()) {
    case 'explanation':
      return 3;
    case 'exam':
      return 2;
    case 'video':
      return 1;
    default:
      return 0;
  }
};
const normalizeLessonStage = (stage) => {
  const normalized = String(stage || '').trim().toLowerCase();
  return ['video', 'exam', 'explanation'].includes(normalized) ? normalized : null;
};
const shouldUseManifestBundlePlaybackRoute = () =>
  appConfig.nodeEnv === 'production' && Boolean(appConfig.privateVideoHlsCacheWarmBaseUrl);
const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');
const trimSlashes = (value) => String(value || '').replace(/^\/+|\/+$/g, '');
const buildPlaybackWatermarkText = (user) => [
  user?.name,
  user?.email,
  user?.mobileNumber,
  user?._id,
].filter(Boolean).join(' • ');
const getLessonConfiguredWatchLimit = (lesson) => {
  const explicitLimit = Number(lesson?.watchLimit);
  if (Number.isFinite(explicitLimit) && explicitLimit > 0) {
    return Math.max(Math.floor(explicitLimit), 1);
  }

  return Math.max(Number(appConfig.privateVideoLegacyLessonWatchLimit || 2), 1);
};
const getLessonConfiguredCompletionPercent = (lesson) => {
  const explicitPercent = Number(lesson?.watchCompletionPercent);
  if (Number.isFinite(explicitPercent) && explicitPercent >= 50 && explicitPercent <= 100) {
    return explicitPercent;
  }

  return Math.min(Math.max(Number(appConfig.videoWatchCompletionThresholdPercent || 90), 50), 100);
};
const resolveEffectiveLessonWatchSettings = async ({
  userId,
  courseId,
  lessonId,
  lesson = null,
}) => {
  const override = userId && courseId && lessonId
    ? await getStudentLessonWatchOverride({ studentId: userId, courseId, lessonId })
    : null;
  return {
    override,
    allowedFullWatches: override?.allowedFullWatches || getLessonConfiguredWatchLimit(lesson),
    watchCompletionPercent: override?.watchCompletionPercent || getLessonConfiguredCompletionPercent(lesson),
  };
};
const buildDrmLicenseServers = () => Object.fromEntries(
  Object.entries({
    'com.widevine.alpha': appConfig.privateVideoDrmWidevineLicenseUrl,
    'com.apple.fps': appConfig.privateVideoDrmFairplayLicenseUrl,
    'com.microsoft.playready': appConfig.privateVideoDrmPlayreadyLicenseUrl,
  }).filter(([, value]) => Boolean(String(value || '').trim())),
);
const buildProtectedPlaybackDrmConfig = ({
  manifestRootPath,
  courseId,
  lessonId,
  userId,
  sessionId,
  playbackSessionId = null,
  videoId = null,
  videoType = COURSE_VIDEO_TYPE,
  playbackContext,
}) => {
  if (!appConfig.privateVideoDrmEnabled) {
    return null;
  }

  const manifestBaseUrl = trimTrailingSlash(appConfig.privateVideoDrmManifestBaseUrl);
  const manifestRoot = trimSlashes(manifestRootPath);
  const manifestFileName = trimSlashes(appConfig.privateVideoDrmManifestFileName || 'master.mpd');
  const licenseServers = buildDrmLicenseServers();

  if (!manifestBaseUrl || !manifestRoot || !manifestFileName || !Object.keys(licenseServers).length) {
    return null;
  }

  const issueDrmToken = (provider) => issuePlaybackToken({
    kind: 'course-drm-license',
    provider,
    userId: String(userId),
    sessionId: sessionId || null,
    courseId: String(courseId),
    lessonId: String(lessonId),
    playbackSessionId: playbackSessionId || null,
    videoId: videoId || String(lessonId),
    videoType: normalizeVideoType(videoType),
    userAgentHash: playbackContext?.userAgentHash || null,
    deviceId: playbackContext?.deviceId || null,
    platform: playbackContext?.platform || null,
    browser: playbackContext?.browser || null,
    appMode: playbackContext?.appMode || null,
  });

  const buildProxyLicenseUrl = (provider) => {
    const issued = issueDrmToken(provider);
    return `/backend/api/courses/${encodeURIComponent(String(courseId))}/lessons/${encodeURIComponent(String(lessonId))}/drm/license/${encodeURIComponent(provider)}?token=${encodeURIComponent(issued.token)}`;
  };

  const fairplayCertificateUrl = String(appConfig.privateVideoDrmFairplayCertificateUrl || '').trim()
    ? `/backend/api/courses/${encodeURIComponent(String(courseId))}/lessons/${encodeURIComponent(String(lessonId))}/drm/fairplay-certificate?token=${encodeURIComponent(issueDrmToken('fairplay-cert').token)}`
    : null;

  return {
    enabled: true,
    provider: 'multi-drm',
    manifestUrl: `${manifestBaseUrl}/${path.posix.join(manifestRoot, manifestFileName)}`,
    manifestFormat: String(appConfig.privateVideoDrmManifestFormat || 'dash'),
    licenseServers: Object.fromEntries(
      Object.keys(licenseServers).map((keySystem) => {
        if (keySystem === 'com.widevine.alpha') {
          return [keySystem, buildProxyLicenseUrl('widevine')];
        }
        if (keySystem === 'com.apple.fps') {
          return [keySystem, buildProxyLicenseUrl('fairplay')];
        }
        if (keySystem === 'com.microsoft.playready') {
          return [keySystem, buildProxyLicenseUrl('playready')];
        }
        return [keySystem, licenseServers[keySystem]];
      }),
    ),
    fairplayCertificateUrl,
    preferredKeySystem: String(appConfig.privateVideoDrmPreferredKeySystem || '').trim() || null,
    captureProtection: null,
  };
};
const assertLessonReleasedForPlayback = (lesson) => {
  const releaseAt = lesson?.releaseAt || lesson?.availableAt || lesson?.publishedAt || null;
  if (!releaseAt) {
    return;
  }

  const releaseTimestamp = Date.parse(releaseAt);
  if (Number.isFinite(releaseTimestamp) && releaseTimestamp > Date.now()) {
    throw new ApiError(403, 'This video has not been released yet.', { code: 'LESSON_NOT_RELEASED' });
  }
};
const isEnrollmentActive = (enrollment) => {
  if (!enrollment) {
    return false;
  }

  if (String(enrollment.accessStatus || 'enabled').toLowerCase() !== 'enabled') {
    return false;
  }

  if (!enrollment.expiresAt) {
    return true;
  }

  const expiresAt = Date.parse(enrollment.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
};
const filterActiveEnrollments = (enrollments) => (enrollments || []).filter(isEnrollmentActive);
const normalizeCoursePaymentStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'paid') return 'success';
  if (normalized === 'manual') return 'manual';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'pending') return 'pending';
  if (normalized === 'refunded') return 'refunded';
  return normalized || 'none';
};
const getLatestTimestampValue = (entry) => (
  Date.parse(
    entry?.updatedAt
    || entry?.paidAt
    || entry?.createdAt
    || entry?.enrolledAt
    || entry?.lastWatchedAt
    || 0,
  ) || 0
);
const getLatestEntry = (entries) => (
  Array.isArray(entries) && entries.length > 0
    ? [...entries].sort((left, right) => getLatestTimestampValue(right) - getLatestTimestampValue(left))[0]
    : null
);
const getPaymentPriorityRank = (payment) => {
  const meta = asObject(payment?.payment_meta || payment?.meta);
  const decision = String(meta.verificationDecision || meta.verificationStatus || '').trim().toUpperCase();
  const gatewayStatus = String(meta.gatewayStatus || meta.razorpayGatewayStatus || '').trim().toLowerCase();
  const localStatus = String(payment?.status || '').trim().toLowerCase();
  if (decision === 'VERIFIED_CAPTURED_ACTIVATED' && gatewayStatus === 'captured' && localStatus === 'paid') {
    return 0;
  }
  if (localStatus === 'paid') {
    return 1;
  }
  if (localStatus === 'pending') {
    return 2;
  }
  if (localStatus === 'failed') {
    return 3;
  }
  if (localStatus === 'refunded') {
    return 4;
  }
  return 5;
};
const getBestPaymentEntry = (entries) => (
  Array.isArray(entries) && entries.length > 0
    ? [...entries].sort((left, right) => {
      const rankDifference = getPaymentPriorityRank(left) - getPaymentPriorityRank(right);
      if (rankDifference !== 0) {
        return rankDifference;
      }
      return getLatestTimestampValue(right) - getLatestTimestampValue(left);
    })[0]
    : null
);
const getCourseAccessLabel = ({
  canAccessCourse = false,
  paymentStatus = 'none',
  accessStatus = 'not_purchased',
  verificationStatus = '',
}) => {
  if (canAccessCourse) {
    return 'Continue Learning';
  }

  const normalizedPaymentStatus = String(paymentStatus || '').toLowerCase();
  const normalizedAccessStatus = String(accessStatus || '').toLowerCase();
  const normalizedVerificationStatus = normalizeRazorpayVerificationDecision(verificationStatus);
  if (normalizedVerificationStatus === 'MANUAL_REVIEW_REQUIRED' || normalizedVerificationStatus === 'LOCAL_TRANSACTION_NOT_FOUND') {
    return 'Payment Under Verification';
  }
  if (['AMOUNT_MISMATCH', 'ORDER_MISMATCH', 'USER_MISMATCH', 'COURSE_MISMATCH', 'REFUNDED_OR_CHARGEBACK'].includes(normalizedVerificationStatus)) {
    return 'Contact Support';
  }
  if (normalizedAccessStatus === 'expired') {
    return 'Renew Course';
  }
  if (normalizedAccessStatus === 'disabled') {
    return 'Contact Support';
  }
  if (normalizedPaymentStatus === 'pending') {
    return 'Payment Pending';
  }
  if (normalizedPaymentStatus === 'failed') {
    return 'Payment Failed';
  }
  if (normalizedAccessStatus === 'pending_access') {
    return 'Access Pending';
  }
  return 'Buy Course';
};
const getCourseVideoPlaybackAccess = ({ course, enrollment = null, payment = null, isAdmin = false }) => {
  const paymentMeta = asObject(payment?.meta);
  const paymentStatus = isAdmin
    ? 'manual'
    : payment
      ? normalizeCoursePaymentStatus(payment.status)
      : enrollment
        ? 'manual'
        : 'none';
  const enrollmentAccessStatus = String(enrollment?.accessStatus || '').trim().toLowerCase();
  const validityActive = isAdmin || isEnrollmentActive(enrollment);
  const accessDisabled = Boolean(enrollment) && enrollmentAccessStatus !== '' && enrollmentAccessStatus !== 'enabled';
  const hasSuccessfulPayment = ['success', 'manual'].includes(paymentStatus);
  const hasPurchaseSignal = Boolean(enrollment) || hasSuccessfulPayment || ['pending', 'refunded'].includes(paymentStatus);
  const verificationStatus = isAdmin
    ? 'VERIFIED_CAPTURED_ACTIVATED'
    : normalizeRazorpayVerificationDecision(paymentMeta.verificationStatus || paymentMeta.verificationDecision || '');
  const verificationPresentation = getRazorpayVerificationPresentation(verificationStatus);
  let accessStatus = 'not_purchased';
  let accessBlockReason = 'Please purchase course to watch.';

  if (isAdmin || validityActive) {
    accessStatus = 'enabled';
    accessBlockReason = null;
  } else if (verificationPresentation.manualReviewRequired) {
    accessStatus = 'pending_access';
    accessBlockReason = paymentMeta.verificationReason || verificationPresentation.reason;
  } else if (accessDisabled) {
    accessStatus = 'disabled';
    accessBlockReason = 'Access disabled. Contact support.';
  } else if (enrollment && !validityActive) {
    accessStatus = 'expired';
    accessBlockReason = 'Course validity expired.';
  } else if (hasSuccessfulPayment) {
    accessStatus = 'pending_access';
    accessBlockReason = 'Payment successful but course access is still being activated.';
  } else if (paymentStatus === 'pending') {
    accessStatus = 'pending_access';
    accessBlockReason = 'Payment is pending confirmation.';
  } else if (paymentStatus === 'refunded') {
    accessStatus = 'disabled';
    accessBlockReason = 'Payment was refunded. Contact support.';
  }

  return {
    isPurchased: hasPurchaseSignal,
    paymentStatus,
    enrollmentStatus: validityActive
      ? 'active'
      : accessDisabled
        ? 'disabled'
        : enrollment
          ? 'expired'
          : 'missing',
    accessStatus,
    validUntil: enrollment?.expiresAt || null,
    isExpired: accessStatus === 'expired',
    canAccessCourse: accessStatus === 'enabled',
    canPlayReleasedVideos: accessStatus === 'enabled',
    accessBlockReason,
    transactionId: payment?.providerPaymentId || payment?._id || null,
    gatewayOrderId: payment?.providerOrderId || null,
    gatewayPaymentId: payment?.providerPaymentId || null,
    gatewayStatus: paymentMeta.gatewayStatus || null,
    verificationStatus,
    verificationReason: paymentMeta.verificationReason || verificationPresentation.reason,
    expectedAmount: paymentMeta.expectedAmount ?? (payment?.amount ?? null),
    receivedAmount: paymentMeta.receivedAmount ?? (payment?.amount ?? null),
    currency: payment?.currency || paymentMeta.currency || 'INR',
    manualReviewRequired: Boolean(verificationPresentation.manualReviewRequired),
    accessSource: enrollment?.source || (payment ? payment.provider || 'payment' : null),
    courseAccessLabel: getCourseAccessLabel({
      canAccessCourse: accessStatus === 'enabled',
      paymentStatus,
      accessStatus,
      verificationStatus,
    }),
    courseVideoAccessMode: getCourseVideoAccessMode(course),
  };
};
const hasReplayViewLimit = () => replayViewLimitEnabled && replayMaxViews > 0;
const toIso = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value.toISOString === 'function') {
    return value.toISOString();
  }

  return String(value);
};

const normalizeOptionalUrl = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.toLowerCase() === 'null' || normalized.toLowerCase() === 'undefined') {
    return null;
  }
  return normalized;
};

const isMongoMode = () => getDatabaseMode() === 'mongodb';
const isPostgresMode = () => isPostgresReady();
let platformReadyUntil = 0;
let platformReadyPromise = null;
let platformDataCache = null;
let platformDataCachePromise = null;
const watchProgressInvalidationState = new Map();
const courseMutationLocks = new Map();

const withCourseMutationLock = async (courseId, fn) => {
  const key = String(courseId || '');
  const previous = courseMutationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  courseMutationLocks.set(key, next);

  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (courseMutationLocks.get(key) === next) {
      courseMutationLocks.delete(key);
    }
  }
};

const PLATFORM_READY_REDIS_KEY = cacheKey('platform-ready', 'v1');
const PLATFORM_DATA_REDIS_KEY = cacheKey('platform-data', 'v1');
const PLATFORM_ANALYTICS_REDIS_KEY = cacheKey('analytics', 'platform');
const PLATFORM_COURSES_REDIS_KEY = cacheKey('courses', 'list');
const PLATFORM_TESTS_REDIS_KEY = cacheKey('tests', 'list');
const PLATFORM_NOTIFICATIONS_REDIS_KEY = cacheKey('notifications', 'list');
const PLATFORM_QUIZ_WEEKLY_REDIS_KEY = cacheKey('quiz-weekly', 'all');
const PLATFORM_LEADERBOARD_REDIS_KEY = cacheKey('analytics', 'leaderboard');
const USER_LOOKUP_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.userLookupCacheTtlMs || 10_000) / 1000);
const COURSE_LOOKUP_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.courseLookupCacheTtlMs || 15_000) / 1000);
const VIEWER_COURSE_LOOKUP_CACHE_TTL_SECONDS = Math.max(3, Number(appConfig.viewerCourseLookupCacheTtlMs || 10_000) / 1000);
const TEST_LOOKUP_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.testLookupCacheTtlMs || 15_000) / 1000);
const ACTIVE_ENROLLMENTS_LOOKUP_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.activeEnrollmentsCacheTtlMs || 15_000) / 1000);
const USER_PROGRESS_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.userProgressCacheTtlMs || 15_000) / 1000);
const LIVE_CLASS_LOOKUP_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.liveClassLookupCacheTtlMs || 10_000) / 1000);
const LIVE_CLASS_ACCESS_CACHE_TTL_SECONDS = Math.max(5, Number(appConfig.liveClassAccessCacheTtlMs || 10_000) / 1000);
const LIVE_CLASS_ENTITLEMENT_CACHE_TTL_SECONDS = Math.max(10, Number(appConfig.liveClassEntitlementCacheTtlMs || 30_000) / 1000);
const ANALYTICS_LEADERBOARD_CACHE_TTL_SECONDS = Math.max(2, Number(appConfig.analyticsLeaderboardCacheTtlMs || 5_000) / 1000);
const WATCH_PROGRESS_CACHE_INVALIDATION_INTERVAL_SECONDS = Math.max(60, Number(appConfig.watchProgressCacheInvalidationIntervalMs || 300_000) / 1000);
const WATCH_PROGRESS_CACHE_INVALIDATION_PERCENT_STEP = Math.max(5, Number(appConfig.watchProgressCacheInvalidationPercentStep || 25));

const getCachedJsonValue = async (key, loader, ttlSeconds) => {
  try {
    const cached = await getRedisJson(key);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
  } catch (error) {
    // Ignore cache read failures and fall back to the loader.
  }

  const value = await loader();
  if (value === null || value === undefined) {
    return value;
  }

  try {
    await setRedisJson(key, value, { ttlSeconds: Math.max(1, Math.ceil(ttlSeconds)) });
  } catch (error) {
    // Ignore cache write failures.
  }

  return value;
};

const clearRedisKeys = (keys) => {
  keys.filter(Boolean).forEach((key) => {
    void deleteRedisKey(key).catch(() => undefined);
  });
};

const invalidateGlobalPlatformCaches = () => {
  platformDataCache = null;
  platformDataCachePromise = null;
  clearRedisKeys([
    PLATFORM_DATA_REDIS_KEY,
    PLATFORM_ANALYTICS_REDIS_KEY,
    PLATFORM_LEADERBOARD_REDIS_KEY,
    PLATFORM_COURSES_REDIS_KEY,
    PLATFORM_TESTS_REDIS_KEY,
    PLATFORM_NOTIFICATIONS_REDIS_KEY,
    PLATFORM_QUIZ_WEEKLY_REDIS_KEY,
  ]);
};

const invalidateAllPlatformCachesForUser = (userId) => {
  invalidateGlobalPlatformCaches();
  if (userId) {
    invalidateUserPlatformCaches(userId);
  }
};

const invalidateUserPlatformCaches = (userId) => {
  if (!userId) {
    return;
  }

  clearRedisKeys([
    cacheKey('enrollments', `active:${userId}`),
    cacheKey('analytics', `user:${userId}`),
    cacheKey('notifications', `user:${userId}`),
    cacheKey('notifications-count', `user:${userId}`),
    cacheKey('progress', String(userId)),
    cacheKey('user-session', String(userId)),
  ]);
};

const shouldInvalidateWatchProgressCaches = ({ userId, courseId, lessonId, progressPercent, progressSeconds, completed }) => {
  if (!userId) {
    return false;
  }

  const stateKey = `${String(userId)}:${String(courseId)}:${String(lessonId)}`;
  if (completed) {
    watchProgressInvalidationState.delete(stateKey);
    return true;
  }

  const now = Date.now();
  const existing = watchProgressInvalidationState.get(stateKey);
  const nextState = {
    progressPercent: Number(progressPercent || 0),
    progressSeconds: Number(progressSeconds || 0),
    updatedAt: now,
  };

  if (!existing) {
    watchProgressInvalidationState.set(stateKey, nextState);
    return false;
  }

  const advancedSeconds = Number(progressSeconds || 0) - Number(existing.progressSeconds || 0);
  const advancedPercent = Number(progressPercent || 0) - Number(existing.progressPercent || 0);
  const elapsedSeconds = (now - Number(existing.updatedAt || now)) / 1000;
  const shouldInvalidate = advancedSeconds >= WATCH_PROGRESS_CACHE_INVALIDATION_INTERVAL_SECONDS
    || advancedPercent >= WATCH_PROGRESS_CACHE_INVALIDATION_PERCENT_STEP
    || elapsedSeconds >= WATCH_PROGRESS_CACHE_INVALIDATION_INTERVAL_SECONDS;

  watchProgressInvalidationState.set(stateKey, nextState);

  if (watchProgressInvalidationState.size > 20_000) {
    for (const [key, value] of watchProgressInvalidationState.entries()) {
      if ((now - Number(value.updatedAt || 0)) > (WATCH_PROGRESS_CACHE_INVALIDATION_INTERVAL_SECONDS * 1000 * 2)) {
        watchProgressInvalidationState.delete(key);
      }
    }
  }

  return shouldInvalidate;
};

const invalidateQuizCaches = ({ quizId = null, quizDate = null } = {}) => {
  clearRedisKeys([
    PLATFORM_QUIZ_WEEKLY_REDIS_KEY,
    quizId ? cacheKey('quiz-leaderboard', String(quizId)) : null,
    quizDate ? cacheKey('quiz', `date:${String(quizDate).slice(0, 10)}`) : null,
  ]);
};

const getPlatformDataFromRedis = async () => {
  try {
    const cached = await getRedisJson(PLATFORM_DATA_REDIS_KEY);
    if (cached && cached.expiresAt && Number(cached.expiresAt) > Date.now()) {
      return cached.value;
    }
    return null;
  } catch (e) {
    return null;
  }
};

const setPlatformDataToRedis = async (value) => {
  try {
    await setRedisJson(PLATFORM_DATA_REDIS_KEY, { value, expiresAt: Date.now() + platformDataCacheTtlMs }, { ttlSeconds: Math.ceil(platformDataCacheTtlMs / 1000) });
    return true;
  } catch (e) {
    return false;
  }
};

const getPlatformReadyFromRedis = async () => {
  try {
    const val = await getRedisValue(PLATFORM_READY_REDIS_KEY);
    if (!val) return 0;
    const num = Number(val);
    return Number.isFinite(num) ? num : 0;
  } catch (e) {
    return 0;
  }
};

const setPlatformReadyToRedis = async (untilMs) => {
  try {
    // store as unix ms string with TTL
    await setRedisValue(PLATFORM_READY_REDIS_KEY, String(untilMs), { ttlSeconds: Math.ceil(platformReadyCacheTtlMs / 1000) });
    return true;
  } catch (e) {
    return false;
  }
};

const invalidatePlatformDataCache = () => {
  invalidateGlobalPlatformCaches();
};
const getDefaultLivePlaybackType = () => (appConfig.preferredLivePlaybackType === 'hls' ? 'live-stream' : 'livekit');
const getEffectiveLivePlaybackType = (liveClass) => {
  const explicitType = String(liveClass?.livePlaybackType || '').trim().toLowerCase();

  if (!explicitType) {
    if (liveClass?.livePlaybackUrl) {
      return 'live-stream';
    }
    if (liveClass?.embedUrl || liveClass?.roomUrl) {
      return 'unsupported';
    }
    return getDefaultLivePlaybackType();
  }

  if (explicitType === 'hls') {
    return 'live-stream';
  }

  return explicitType;
};

const buildManagedHlsStreamName = (liveClass) => (liveClass?.courseId && liveClass?.moduleId
  ? `${liveClass._id}__${liveClass.courseId}__${liveClass.moduleId}__${liveClass.chapterId || 'root'}`
  : String(liveClass?._id || ''));

const buildPublicManagedHlsPlaybackUrl = (streamName) => {
  const publicBaseUrl = String(appConfig.liveHlsPublicBaseUrl || '').replace(/\/+$/, '');
  if (!publicBaseUrl || !streamName) {
    return null;
  }

  if (/\/hls$/i.test(publicBaseUrl)) {
    return `${publicBaseUrl}/${encodeURIComponent(String(streamName))}.m3u8`;
  }

  return `${publicBaseUrl}/${encodeURIComponent(String(streamName))}/index.m3u8`;
};

const getReplayExpiresAtIso = (baseMs = Date.now()) => new Date(baseMs + replayRetentionMs).toISOString();
const getLiveReplayExpiresAtIso = (baseMs = Date.now()) => new Date(baseMs + liveReplayRetentionMs).toISOString();
const isReplayGrantExpired = (grant) => {
  if (!grant?.expiresAt) {
    return true;
  }

  const expiresAt = Date.parse(grant.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
};

const isLiveReplayGrantExpired = (grant) => isReplayGrantExpired(grant);

const ensurePersistentDatabaseAvailability = async () => {
  if (appConfig.postgresUrl && !isPostgresReady()) {
    await initializePostgres();
  }

  if (isPostgresMode() || isMongoMode()) {
    return;
  }

  if (!appConfig.allowMemoryFallback && (appConfig.postgresUrl || appConfig.mongoUri)) {
    throw new ApiError(
      503,
      'Persistent database is unavailable. Start Postgres or MongoDB to use saved admin content.',
      { code: 'PERSISTENT_DATABASE_UNAVAILABLE' },
    );
  }
};

const sanitizeUser = (user) => {
  if (!user) {
    return null;
  }

  const plainUser = typeof user.toObject === 'function' ? user.toObject() : clone(user);
  const { password, ...safeUser } = plainUser;
  return safeUser;
};

const pushIfMissing = (collection, item, idField = '_id') => {
  if (!collection.some((entry) => entry[idField] === item[idField])) {
    collection.push(clone(item));
  }
};

const ensureDefaultAdminUser = async () => {
  const email = normalizeEmail(appConfig.adminEmail);
  const name = String(appConfig.adminName || 'Platform Admin').trim() || 'Platform Admin';
  const password = String(appConfig.adminPassword || '');
  if (!email || !password) {
    return null;
  }
  const passwordHash = await bcrypt.hash(password, 10);

  if (isPostgresMode()) {
    const existing = await pgOne('SELECT * FROM users WHERE email = $1', [email], mapUserRow);
    if (existing) {
      return upsertPgUser({
        ...existing,
        name,
        email,
        password: passwordHash,
        role: 'admin',
        updated_at: nowIso(),
      });
    }

    return upsertPgUser({
      name,
      email,
        password: passwordHash,
        role: 'admin',
        device: null,
        session: null,
        badges: [],
        streak: 0,
        points: 0,
        referral_code: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
  }

  if (isMongoMode()) {
    const existing = await User.findOne({ email });
    if (existing) {
      existing.name = name;
      existing.role = 'admin';
      existing.password = passwordHash;
      await existing.save();
      return existing.toObject();
    }

    const createdUser = await User.create({
      name,
      email,
      password: passwordHash,
      role: 'admin',
    });
    return createdUser.toObject();
  }

  const existing = state.users.find((user) => user.email === email) || null;
  if (existing) {
    existing.name = name;
    existing.role = 'admin';
    existing.password = passwordHash;
    existing.updated_at = nowIso();
    return clone(existing);
  }

  const createdUser = {
    _id: nextId('user'),
    name,
    email,
    password: passwordHash,
    role: 'admin',
    device: null,
    session: null,
    streak: 0,
    points: 0,
    badges: [],
    referral_code: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  state.users.push(createdUser);
  return clone(createdUser);
};

const getModuleLessons = (module) => Array.isArray(module?.lessons) ? module.lessons : [];
const getModuleChapters = (module) => Array.isArray(module?.chapters) ? module.chapters : [];
const getChapterLessons = (chapter) => Array.isArray(chapter?.lessons) ? chapter.lessons : [];
const ACCESS_SCOPE_ORDER = {
  course: 1,
  chapter: 2,
  lesson: 3,
};
const ACCESS_BLOCK_MESSAGE = 'This content is locked by the admin.';
const normalizeStudentScope = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'student' ? 'student' : 'all_students';
};
const normalizeContentScope = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['course', 'chapter', 'lesson'].includes(normalized) ? normalized : 'course';
};
const normalizeAccessMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'allow' ? 'allow' : 'block';
};
const normalizeCourseContentAccessRuleRecord = (payload = {}) => ({
  _id: String(payload._id || payload.id || createId('content_rule')),
  courseId: String(payload.courseId || payload.course_id || ''),
  studentScope: normalizeStudentScope(payload.studentScope || payload.student_scope),
  studentId: payload.studentId || payload.student_id ? String(payload.studentId || payload.student_id) : null,
  contentScope: normalizeContentScope(payload.contentScope || payload.content_scope),
  moduleId: payload.moduleId || payload.module_id ? String(payload.moduleId || payload.module_id) : null,
  chapterId: payload.chapterId || payload.chapter_id ? String(payload.chapterId || payload.chapter_id) : null,
  lessonId: payload.lessonId || payload.lesson_id ? String(payload.lessonId || payload.lesson_id) : null,
  access: normalizeAccessMode(payload.access),
  adminNote: payload.adminNote || payload.admin_note ? String(payload.adminNote || payload.admin_note) : null,
  createdBy: payload.createdBy || payload.created_by ? String(payload.createdBy || payload.created_by) : null,
  updatedBy: payload.updatedBy || payload.updated_by ? String(payload.updatedBy || payload.updated_by) : null,
  createdAt: payload.createdAt || payload.created_at || nowIso(),
  updatedAt: payload.updatedAt || payload.updated_at || nowIso(),
});
const normalizeStudentLessonWatchOverrideRecord = (payload = {}) => ({
  _id: String(payload._id || payload.id || createId('watch_override')),
  courseId: String(payload.courseId || payload.course_id || ''),
  studentId: String(payload.studentId || payload.student_id || ''),
  moduleId: String(payload.moduleId || payload.module_id || ''),
  chapterId: payload.chapterId || payload.chapter_id ? String(payload.chapterId || payload.chapter_id) : null,
  lessonId: String(payload.lessonId || payload.lesson_id || ''),
  allowedFullWatches: Math.max(1, Math.floor(Number(payload.allowedFullWatches ?? payload.allowed_full_watches ?? 1))),
  watchCompletionPercent: payload.watchCompletionPercent === null || payload.watch_completion_percent === null
    ? null
    : Math.min(Math.max(Math.floor(Number(payload.watchCompletionPercent ?? payload.watch_completion_percent ?? appConfig.videoWatchCompletionThresholdPercent ?? 90)), 50), 100),
  adminNote: payload.adminNote || payload.admin_note ? String(payload.adminNote || payload.admin_note) : null,
  createdBy: payload.createdBy || payload.created_by ? String(payload.createdBy || payload.created_by) : null,
  updatedBy: payload.updatedBy || payload.updated_by ? String(payload.updatedBy || payload.updated_by) : null,
  createdAt: payload.createdAt || payload.created_at || nowIso(),
  updatedAt: payload.updatedAt || payload.updated_at || nowIso(),
});
const findLessonContextInCourse = (course, lessonId) => {
  for (const module of course?.modules || []) {
    for (const lesson of getModuleLessons(module)) {
      if (lesson.id === String(lessonId)) {
        return {
          moduleId: module.id,
          moduleTitle: module.title,
          chapterId: null,
          chapterTitle: null,
          lesson,
        };
      }
    }
    for (const chapter of getModuleChapters(module)) {
      for (const lesson of getChapterLessons(chapter)) {
        if (lesson.id === String(lessonId)) {
          return {
            moduleId: module.id,
            moduleTitle: module.title,
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            lesson,
          };
        }
      }
    }
  }
  return null;
};
const matchesCourseContentRule = (rule, target = {}) => {
  if (rule.contentScope === 'course') {
    return true;
  }
  if (rule.contentScope === 'chapter') {
    return Boolean(target.chapterId) && String(rule.chapterId || '') === String(target.chapterId || '');
  }
  if (rule.contentScope === 'lesson') {
    return Boolean(target.lessonId) && String(rule.lessonId || '') === String(target.lessonId || '');
  }
  return false;
};
const getAccessRuleReason = (rule) => rule?.adminNote || ACCESS_BLOCK_MESSAGE;
const summarizeMatchingAccessRules = (rules = []) => {
  const matching = [...rules].sort((left, right) => {
    const specificityDelta = (ACCESS_SCOPE_ORDER[right.contentScope] || 0) - (ACCESS_SCOPE_ORDER[left.contentScope] || 0);
    if (specificityDelta !== 0) {
      return specificityDelta;
    }
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
  });
  const allowRule = matching.find((rule) => rule.access === 'allow') || null;
  const blockRule = matching.find((rule) => rule.access === 'block') || null;
  return {
    matching,
    allowRule,
    blockRule,
    blocked: !allowRule && Boolean(blockRule),
    reason: !allowRule && blockRule ? getAccessRuleReason(blockRule) : null,
  };
};
const createCourseAccessEvaluator = ({ course, rules = [] } = {}) => {
  const normalizedRules = (Array.isArray(rules) ? rules : [])
    .map((entry) => normalizeCourseContentAccessRuleRecord(entry))
    .filter((entry) => entry.courseId === String(course?._id || ''));
  return (target = {}) => summarizeMatchingAccessRules(
    normalizedRules.filter((rule) => matchesCourseContentRule(rule, target)),
  );
};

const lessonListFromCourse = (course) =>
  (course.modules || []).flatMap((module) => ([
    ...getModuleLessons(module).map((lesson) => ({
      ...clone(lesson),
      moduleId: module.id,
      moduleTitle: module.title,
      chapterId: null,
      chapterTitle: null,
      courseId: course._id,
    })),
    ...getModuleChapters(module).flatMap((chapter) =>
      getChapterLessons(chapter).map((lesson) => ({
        ...clone(lesson),
        moduleId: module.id,
        moduleTitle: module.title,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        courseId: course._id,
      }))),
  ]));

const lessonProgressMapForCourse = (data, userId, courseId) =>
  new Map(
    data.watchHistory
      .filter((entry) => entry.userId === String(userId) && entry.courseId === String(courseId))
      .map((entry) => [entry.lessonId, entry]),
  );

const buildLessonProgressMap = (watchHistory, userId, courseId) =>
  new Map(
    (watchHistory || [])
      .filter((entry) => entry.userId === String(userId) && entry.courseId === String(courseId))
      .map((entry) => [entry.lessonId, entry]),
  );

const isLessonSequentiallyUnlockedForProgressMap = (course, lessonId, progressMap) => {
  const lessons = lessonListFromCourse(course);
  const lessonIndex = lessons.findIndex((lesson) => lesson.id === String(lessonId));

  if (lessonIndex <= 0) {
    return true;
  }

  const currentProgress = progressMap.get(String(lessonId));
  if (currentProgress?.completed) {
    return true;
  }

  const previousLesson = lessons[lessonIndex - 1];
  const previousProgress = progressMap.get(previousLesson.id);
  return Boolean(previousProgress?.completed || Number(previousProgress?.progressPercent || 0) >= 90);
};

const isLessonSequentiallyUnlocked = (course, userId, lessonId, data) => {
  return isLessonSequentiallyUnlockedForProgressMap(
    course,
    lessonId,
    lessonProgressMapForCourse(data, userId, course._id),
  );
};

const shouldRequireEnrollmentForLesson = (lesson, enforceEnrollment = true) =>
  Boolean(enforceEnrollment && lesson?.premium);

const shouldRequireSequentialUnlockForLesson = (lesson, enforceSequentialUnlock = true, enforceEnrollment = true) =>
  Boolean(
    enforceSequentialUnlock
    && shouldRequireEnrollmentForLesson(lesson, enforceEnrollment),
  );

const normalizeCourseVideoAccessMode = (value, fallback = appConfig.courseVideoAccessMode) => {
  const normalized = String(value || fallback || 'free_order').trim().toLowerCase();
  return normalized === 'sequential' ? 'sequential' : 'free_order';
};

const getCourseVideoAccessMode = (course) => normalizeCourseVideoAccessMode(
  course?.courseVideoAccessMode
  || course?.videoAccessMode
  || course?.settings?.courseVideoAccessMode
  || appConfig.courseVideoAccessMode,
);

const shouldRequireSequentialUnlockForCourseLesson = ({
  course,
  lesson,
  enforceSequentialUnlock = true,
  enforceEnrollment = true,
}) => (
  shouldRequireSequentialUnlockForLesson(lesson, enforceSequentialUnlock, enforceEnrollment)
  && getCourseVideoAccessMode(course) === 'sequential'
);

const sanitizeLessonForViewer = (lesson, hasFullAccess, options = {}) => {
  const accessDecision = options.accessDecision || { blocked: false, reason: null };
  const isLocked = (Boolean(lesson.premium) && !hasFullAccess) || Boolean(accessDecision.blocked);
  const isProtectedYoutube = lesson.type === 'youtube';
  const isPrivateVideo = lesson.type === 'private-video';

  return {
    ...clone(lesson),
    videoUrl: isLocked || isProtectedYoutube || isPrivateVideo ? null : lesson.videoUrl,
    youtubeVideoIdCiphertext: undefined,
    storagePath: undefined,
    storageProvider: undefined,
    hlsManifestPath: undefined,
    hlsPlaybackPath: undefined,
    locked: isLocked,
    accessBlockReason: accessDecision.blocked ? accessDecision.reason : null,
    requiresSecurePlayback: isProtectedYoutube || isPrivateVideo,
  };
};

const sanitizePdfAttachmentForViewer = (attachment, options = {}) => ({
  id: attachment.id,
  title: attachment.title,
  fileName: attachment.fileName || null,
  mimeType: attachment.mimeType || 'application/pdf',
  fileSize: Number(attachment.fileSize || 0) || 0,
  premium: Boolean(attachment.premium),
  scope: attachment.scope || 'module',
  locked: Boolean(options.blocked),
  accessBlockReason: options.blocked ? options.reason || ACCESS_BLOCK_MESSAGE : null,
  uploadedAt: attachment.uploadedAt || null,
  uploadedBy: attachment.uploadedBy || null,
});

const sanitizePdfAttachmentsForViewer = (attachments, hasFullAccess, options = {}) =>
  (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    const premiumLocked = Boolean(attachment?.premium) && !hasFullAccess;
    const accessDecision = options.evaluateAttachmentAccess
      ? options.evaluateAttachmentAccess(attachment)
      : { blocked: false, reason: null };
    return sanitizePdfAttachmentForViewer(attachment, {
      blocked: premiumLocked || Boolean(accessDecision?.blocked),
      reason: accessDecision?.blocked ? accessDecision.reason : null,
    });
  });

const sanitizeEditorialVideoForViewer = (editorial, hasFullAccess, isAdmin = false) => ({
  id: editorial.id,
  title: editorial.title,
  description: editorial.description || '',
  weekLabel: editorial.weekLabel || null,
  editorialDate: editorial.editorialDate || null,
  durationMinutes: Number(editorial.durationMinutes || 0),
  published: Boolean(editorial.published),
  uploadedAt: editorial.uploadedAt || null,
  uploadedBy: editorial.uploadedBy || null,
  playbackReady: Boolean(editorial.storagePath),
  hlsProcessingStatus: editorial.hlsProcessingStatus || 'ready',
  watchLimit: 1,
  watchCompletionPercent: Number(editorial.watchCompletionPercent || appConfig.videoWatchCompletionThresholdPercent || 90),
  locked: !hasFullAccess && !isAdmin,
});

const sanitizeEditorialVideosForViewer = (editorials, hasFullAccess, isAdmin = false) =>
  (Array.isArray(editorials) ? editorials : [])
    .filter((editorial) => isAdmin || Boolean(editorial?.published))
    .map((editorial) => sanitizeEditorialVideoForViewer(editorial, hasFullAccess, isAdmin));

const getLessonReleaseStatus = (lesson) => {
  const releaseAt = lesson?.releaseAt || lesson?.availableAt || lesson?.publishedAt || null;
  if (!releaseAt) {
    return 'released';
  }

  const releaseTimestamp = Date.parse(releaseAt);
  if (Number.isFinite(releaseTimestamp) && releaseTimestamp > Date.now()) {
    return 'unreleased';
  }

  return 'released';
};

const isCloudflareStreamUrl = (value) => {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return false;
  }

  try {
    const parsed = new URL(rawValue);
    return parsed.hostname.toLowerCase().endsWith('cloudflarestream.com');
  } catch {
    return false;
  }
};

const getPrivateLessonPlaybackProvider = (lesson) => {
  const directProvider = String(
    lesson?.hlsStorageProvider
    || lesson?.storageProvider
    || lesson?.streamProvider
    || '',
  ).toLowerCase();

  if (directProvider === 'cloudflare-stream') {
    return 'cloudflare-stream';
  }

  if (
    lesson?.cloudflareStreamUid
    || isCloudflareStreamUrl(lesson?.hlsPlaybackPath)
    || isCloudflareStreamUrl(lesson?.hlsManifestPath)
    || isCloudflareStreamUrl(lesson?.streamUrl)
    || isCloudflareStreamUrl(lesson?.dashStreamUrl)
  ) {
    return 'cloudflare-stream';
  }

  return String(lesson?.hlsStorageProvider || lesson?.storageProvider || lesson?.streamProvider || '').toLowerCase();
};

const isPrivateLessonStreamReady = (lesson) => {
  if (lesson?.type !== 'private-video') {
    return true;
  }

  const provider = getPrivateLessonPlaybackProvider(lesson);
  const status = String(lesson.hlsProcessingStatus || '').toLowerCase();
  const sourceReady = Boolean(lesson.storagePath);
  const sourceFallbackAllowed = Boolean(lesson.sourceFallbackAllowed ?? appConfig.sourcePlaybackFallbackEnabled)
    || ['queued', 'processing', 'failed'].includes(status);
  if (provider === 'cloudflare-stream') {
    return Boolean(
      lesson.playbackReady !== false
      && status === 'ready'
      && lesson.hlsPlaybackPath,
    );
  }

  if (lesson.deliveryStrategy === 'hls') {
    return Boolean(
      (status === 'ready' && lesson.hlsPlaybackPath)
      || (sourceReady && sourceFallbackAllowed),
    );
  }

  return Boolean(lesson.videoUrl || sourceReady);
};

const filterLessonsForViewer = (lessons, isAdmin) =>
  (Array.isArray(lessons) ? lessons : [])
    .filter((lesson) => isAdmin || isPrivateLessonStreamReady(lesson));

const deriveLiveClassStatus = (liveClass) => {
  const explicitStatus = String(liveClass?.status || '').trim().toLowerCase();
  if (['live', 'ended', 'cancelled'].includes(explicitStatus)) {
    return explicitStatus;
  }

  const startTime = Date.parse(String(liveClass?.startTime || ''));
  const durationMinutes = Math.max(Number(liveClass?.durationMinutes || 0), 0);
  const endTime = Number.isFinite(startTime)
    ? startTime + (durationMinutes * 60 * 1000)
    : Number.NaN;
  const now = Date.now();

  if (Number.isFinite(startTime) && now < startTime) {
    return 'scheduled';
  }

  if (Number.isFinite(endTime) && now <= endTime) {
    return 'live';
  }

  return explicitStatus || 'ended';
};

const deriveLiveClassRecordingState = (liveClass) => {
  if (liveClass?.replayAvailable === false) {
    return 'disabled';
  }

  const explicit = String(liveClass?.recordingState || '').trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const status = deriveLiveClassStatus(liveClass);
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

const deriveLiveClassReplayState = (liveClass) => {
  if (liveClass?.replayAvailable === false) {
    return 'disabled';
  }

  const explicit = String(liveClass?.replayState || '').trim().toLowerCase();
  if (explicit) {
    return explicit;
  }

  const recordingExpired = Boolean(
    liveClass?.recordingExpiresAt
    && Number.isFinite(Date.parse(liveClass.recordingExpiresAt))
    && Date.parse(liveClass.recordingExpiresAt) <= Date.now(),
  );

  if (
    !recordingExpired
    && (liveClass?.recordingUrl || liveClass?.recordingStoragePath || (liveClass?.replayCourseId && liveClass?.replayLessonId))
  ) {
    return 'replay_ready';
  }

  if (deriveLiveClassStatus(liveClass) === 'ended') {
    return 'processing';
  }

  return 'pending';
};

const sanitizeLiveClassForViewer = (liveClass) => {
  const status = deriveLiveClassStatus(liveClass);
  const effectivePlaybackType = getEffectiveLivePlaybackType(liveClass);
  const recordingExpired = Boolean(
    liveClass?.recordingExpiresAt
    && Number.isFinite(Date.parse(liveClass.recordingExpiresAt))
    && Date.parse(liveClass.recordingExpiresAt) <= Date.now(),
  );
  const replayReady = Boolean(
    liveClass?.replayAvailable
    && !recordingExpired
    && (liveClass?.recordingUrl || liveClass?.recordingStoragePath || (liveClass?.replayCourseId && liveClass?.replayLessonId)),
  );
  const recordingState = deriveLiveClassRecordingState(liveClass);
  const replayState = deriveLiveClassReplayState(liveClass);
  const managedPlaybackReady = Boolean(
    liveClass?.livePlaybackUrl
    || liveClass?.embedUrl
    || liveClass?.roomUrl,
  );

  return {
    ...clone(liveClass),
    status,
    livePlaybackType: effectivePlaybackType,
    livePlaybackUrl: undefined,
    embedUrl: undefined,
    roomUrl: undefined,
    recordingUrl: undefined,
    recordingStorageProvider: undefined,
    recordingStoragePath: undefined,
    recordingPublishedAt: undefined,
    recordingExpiresAt: undefined,
    recordingDurationMinutes: undefined,
    replayCourseId: undefined,
    replayLessonId: undefined,
    joinEnabled: status === 'live' && effectivePlaybackType === 'livekit',
    replayReady,
    recordingState,
    replayState,
  };
};

const findLessonInCourse = (course, lessonId) =>
  lessonListFromCourse(course).find((lesson) => lesson.id === String(lessonId)) || null;

const updateLessonInModules = (modules, lessonId, updater) => {
  let updatedLesson = null;
  const nextModules = (modules || []).map((module) => {
    const nextModule = clone(module);

    if (Array.isArray(nextModule.lessons)) {
      nextModule.lessons = nextModule.lessons.map((lesson) => {
        if (lesson.id !== String(lessonId)) {
          return lesson;
        }
        updatedLesson = updater(clone(lesson));
        return updatedLesson;
      });
    }

    if (Array.isArray(nextModule.chapters)) {
      nextModule.chapters = nextModule.chapters.map((chapter) => {
        const nextChapter = clone(chapter);
        if (Array.isArray(nextChapter.lessons)) {
          nextChapter.lessons = nextChapter.lessons.map((lesson) => {
            if (lesson.id !== String(lessonId)) {
              return lesson;
            }
            updatedLesson = updater(clone(lesson));
            return updatedLesson;
          });
        }
        return nextChapter;
      });
    }

    return nextModule;
  });

  return { modules: nextModules, updatedLesson };
};

const redactCourseForViewer = (course, hasFullAccess, options = {}) => {
  const isAdmin = Boolean(options.isAdmin);
  const evaluateAccess = options.evaluateAccess || (() => ({ blocked: false, reason: null }));
  return {
  ...clone(course),
  modules: (course.modules || []).map((module) => ({
    ...clone(module),
    attachments: sanitizePdfAttachmentsForViewer(module.attachments, hasFullAccess, {
      evaluateAttachmentAccess: () => evaluateAccess({ moduleId: module.id }),
    }),
    lessons: filterLessonsForViewer(getModuleLessons(module), isAdmin).map((lesson) => ({
      ...sanitizeLessonForViewer(lesson, hasFullAccess, {
        accessDecision: evaluateAccess({ moduleId: module.id, lessonId: lesson.id }),
      }),
      notesUrl: Boolean(lesson.premium) && !hasFullAccess ? null : lesson.notesUrl,
      attachments: sanitizePdfAttachmentsForViewer(lesson.attachments, hasFullAccess, {
        evaluateAttachmentAccess: () => evaluateAccess({ moduleId: module.id, lessonId: lesson.id }),
      }),
    })),
    chapters: getModuleChapters(module).map((chapter) => ({
      ...clone(chapter),
      locked: Boolean(evaluateAccess({ moduleId: module.id, chapterId: chapter.id }).blocked),
      accessBlockReason: evaluateAccess({ moduleId: module.id, chapterId: chapter.id }).reason,
      attachments: sanitizePdfAttachmentsForViewer(chapter.attachments, hasFullAccess, {
        evaluateAttachmentAccess: () => evaluateAccess({ moduleId: module.id, chapterId: chapter.id }),
      }),
      lessons: filterLessonsForViewer(getChapterLessons(chapter), isAdmin).map((lesson) => ({
        ...sanitizeLessonForViewer(lesson, hasFullAccess, {
          accessDecision: evaluateAccess({ moduleId: module.id, chapterId: chapter.id, lessonId: lesson.id }),
        }),
        notesUrl: Boolean(lesson.premium) && !hasFullAccess ? null : lesson.notesUrl,
        attachments: sanitizePdfAttachmentsForViewer(lesson.attachments, hasFullAccess, {
          evaluateAttachmentAccess: () => evaluateAccess({ moduleId: module.id, chapterId: chapter.id, lessonId: lesson.id }),
        }),
      })),
    })),
  })),
  editorials: sanitizeEditorialVideosForViewer(course.editorials, hasFullAccess, isAdmin),
  };
};

const redactQuizForAttempt = (quiz) => ({
  ...clone(quiz),
  questions: (quiz.questions || []).map((question) => ({
    id: question.id,
    prompt: question.prompt,
    options: clone(question.options || []),
    topic: question.topic || 'General Practice',
  })),
});

const sanitizeTestVideoForViewer = (video) => {
  if (!video || typeof video !== 'object') {
    return null;
  }

  return {
    id: video.id || null,
    title: video.title || 'Test explanation video',
    type: video.type || 'private-video',
    durationMinutes: Number(video.durationMinutes || 0),
    uploadedAt: video.uploadedAt || null,
    deliveryProfile: video.deliveryProfile || 'private-source',
    deliveryStrategy: video.deliveryStrategy || 'source',
    hlsProcessingStatus: video.hlsProcessingStatus || 'ready',
    hlsProcessingError: video.hlsProcessingError || null,
    sourceFallbackAllowed: Boolean(video.sourceFallbackAllowed ?? true),
    targetQualities: asArray(video.targetQualities),
    available: Boolean(video.storagePath || video.hlsPlaybackPath),
  };
};

const redactTestForAttempt = (test) => ({
  ...clone(test),
  companionVideo: sanitizeTestVideoForViewer(test.companionVideo),
  questions: (test.questions || []).map((question) => ({
    id: question.id,
    questionText: question.questionText,
    options: clone(question.options || []),
    marks: Number(question.marks || 1),
    topic: question.topic || 'General Practice',
  })),
});

const getLinkedCourseIdForTest = (test) => {
  const courseId = String(test?.course || '').trim();
  return courseId || null;
};

const canAccessLinkedTestWithCourseIds = (test, enrolledCourseIds, userRole = 'guest') => {
  if (userRole === 'admin') {
    return true;
  }

  const linkedCourseId = getLinkedCourseIdForTest(test);
  if (!linkedCourseId) {
    return false;
  }

  return enrolledCourseIds.has(linkedCourseId);
};

const assertLinkedCourseForMockTest = async (payload) => {
  const linkedCourseId = String(payload?.course || '').trim();

  if (!linkedCourseId) {
    throw new ApiError(400, 'Mock tests must be linked to a course.', {
      code: 'TEST_COURSE_REQUIRED',
    });
  }

  const linkedCourse = await coursesRepository.findById(linkedCourseId);
  if (!linkedCourse) {
    throw new ApiError(404, 'Linked course not found for this mock test.', {
      code: 'TEST_COURSE_NOT_FOUND',
      details: {
        courseId: linkedCourseId,
      },
    });
  }
};

const sortRecentFirst = (left, right, field) => new Date(right[field] || 0) - new Date(left[field] || 0);
const sortOldestFirst = (left, right, field) => new Date(left[field] || 0) - new Date(right[field] || 0);
const sortNewestFirst = (left, right, field) => new Date(right[field] || 0) - new Date(left[field] || 0);

const computeCourseProgress = (data, userId, course) => {
  const lessons = lessonListFromCourse(course);
  if (lessons.length === 0) {
    return { progressPercent: 0, continueLesson: null, continueProgressSeconds: 0, watchHistory: [] };
  }

  const history = data.watchHistory
    .filter((entry) => entry.userId === String(userId) && entry.courseId === course._id)
    .sort((left, right) => sortRecentFirst(left, right, 'updatedAt'));

  const progressPercent = Math.round(
    history.reduce((sum, item) => sum + Number(item.progressPercent || 0), 0) / Math.max(lessons.length, 1),
  );

  const continueItem = history[0] || null;
  const continueLesson = continueItem
    ? lessons.find((lesson) => lesson.id === continueItem.lessonId) || null
    : lessons[0] || null;

  return {
    progressPercent,
    continueLesson,
    continueProgressSeconds: Number(continueItem?.progressSeconds || 0),
    watchHistory: clone(history),
  };
};

const computeQuizInsights = (data, userId) => {
  const entries = data.quizzes.flatMap((quiz) =>
    (quiz.leaderboard || [])
      .filter((entry) => entry.userId === String(userId))
      .map((entry) => ({
        quizId: quiz._id,
        date: quiz.date,
        ...clone(entry),
      })),
  );

  const totalQuestions = entries.reduce((sum, entry) => sum + Number(entry.total || 0), 0);
  const totalCorrect = entries.reduce((sum, entry) => sum + Number(entry.score || 0), 0);

  return {
    attempts: entries.length,
    totalQuestions,
    totalCorrect,
    accuracy: totalQuestions === 0 ? 0 : Number(((totalCorrect / totalQuestions) * 100).toFixed(2)),
  };
};

const computeTestInsights = (data, userId) => {
  const attempts = data.testAttempts
    .filter((attempt) => attempt.userId === String(userId))
    .sort((left, right) => sortRecentFirst(left, right, 'completedAt'));

  const latestAttempt = attempts[0] || null;
  const averageScore = attempts.length === 0
    ? 0
    : Number((attempts.reduce((sum, attempt) => sum + Number(attempt.score || 0), 0) / attempts.length).toFixed(2));

  const totalMarks = attempts.reduce((sum, attempt) => sum + Number(attempt.totalMarks || 0), 0);
  const obtainedMarks = attempts.reduce((sum, attempt) => sum + Number(attempt.score || 0), 0);

  return {
    attempts,
    latestAttempt,
    averageScore,
    accuracy: totalMarks === 0 ? 0 : Number(((obtainedMarks / totalMarks) * 100).toFixed(2)),
  };
};

const getAnalyticsPerformanceStatus = (accuracy) => {
  if (accuracy < 50) {
    return 'weak';
  }

  if (accuracy < 75) {
    return 'watch';
  }

  return 'strong';
};

const normalizeAnalyticsLabel = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenizeAnalyticsLabel = (value) =>
  normalizeAnalyticsLabel(value)
    .split(' ')
    .filter((token) => token.length > 2);

const buildCourseTopicReference = (course) => {
  const references = [];

  (course?.modules || []).forEach((module) => {
    const moduleTitle = String(module?.title || '').trim();

    (module?.chapters || []).forEach((chapter) => {
      const chapterTitle = String(chapter?.title || '').trim();
      if (chapterTitle) {
        references.push({
          kind: 'chapter',
          label: chapterTitle,
          moduleTitle: moduleTitle || null,
          chapterTitle,
          lessonTitle: null,
        });
      }

      (chapter?.lessons || []).forEach((lesson) => {
        const lessonTitle = String(lesson?.title || '').trim();
        if (!lessonTitle) {
          return;
        }

        references.push({
          kind: 'lesson',
          label: lessonTitle,
          moduleTitle: moduleTitle || null,
          chapterTitle: chapterTitle || null,
          lessonTitle,
        });
      });
    });

    (module?.lessons || []).forEach((lesson) => {
      const lessonTitle = String(lesson?.title || '').trim();
      if (!lessonTitle) {
        return;
      }

      references.push({
        kind: 'lesson',
        label: lessonTitle,
        moduleTitle: moduleTitle || null,
        chapterTitle: null,
        lessonTitle,
      });
    });

    if (moduleTitle) {
      references.push({
        kind: 'module',
        label: moduleTitle,
        moduleTitle,
        chapterTitle: null,
        lessonTitle: null,
      });
    }
  });

  return references;
};

const resolveAnalyticsTopicMeta = (course, topic, referenceCache = null) => {
  if (!course) {
    return null;
  }

  const normalizedTopic = normalizeAnalyticsLabel(topic);
  if (!normalizedTopic) {
    return null;
  }

  const references = referenceCache || buildCourseTopicReference(course);
  const topicTokens = new Set(tokenizeAnalyticsLabel(topic));
  let bestMatch = null;
  let bestScore = 0;

  references.forEach((reference) => {
    const normalizedLabel = normalizeAnalyticsLabel(reference.label);
    if (!normalizedLabel) {
      return;
    }

    let score = 0;
    if (normalizedLabel === normalizedTopic) {
      score = 300;
    } else if (normalizedLabel.includes(normalizedTopic) || normalizedTopic.includes(normalizedLabel)) {
      score = 200 - Math.abs(normalizedLabel.length - normalizedTopic.length);
    } else if (topicTokens.size > 0) {
      const labelTokens = tokenizeAnalyticsLabel(reference.label);
      const overlap = labelTokens.filter((token) => topicTokens.has(token)).length;
      if (overlap > 0) {
        score = 100 + (overlap * 10);
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = reference;
    }
  });

  if (!bestMatch) {
    return null;
  }

  const path = [course.subject || course.exam || course.title, bestMatch.moduleTitle, bestMatch.chapterTitle || bestMatch.lessonTitle]
    .filter(Boolean)
    .join(' / ');

  return {
    subjectTitle: course.subject || course.exam || course.title || null,
    moduleTitle: bestMatch.moduleTitle || null,
    chapterTitle: bestMatch.chapterTitle || null,
    lessonTitle: bestMatch.lessonTitle || null,
    pathLabel: path || null,
  };
};

const getSubmittedOptionIndexes = (answer) => {
  if (Array.isArray(answer)) {
    return [...new Set(answer.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right);
  }

  if (answer === undefined || answer === null) {
    return [];
  }

  const coerced = Number(answer);
  return Number.isInteger(coerced) && coerced >= 0 ? [coerced] : [];
};

const getCorrectOptionIndexesForAnalytics = (question = {}, solution = null) => {
  if (Array.isArray(solution?.correctOptions) && solution.correctOptions.length > 0) {
    return [...new Set(solution.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right);
  }

  if (Array.isArray(question.correctOptions) && question.correctOptions.length > 0) {
    return [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right);
  }

  const fallback = Number(solution?.correctOption ?? question.correctOption ?? question.answer);
  return Number.isInteger(fallback) && fallback >= 0 ? [fallback] : [0];
};

const areOptionIndexesEqual = (left = [], right = []) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const buildQuestionSectionNames = (test) => {
  const questionCount = Array.isArray(test?.questions) ? test.questions.length : 0;
  const names = new Array(questionCount).fill('Mixed Practice');
  const sections = Array.isArray(test?.sectionBreakup) ? test.sectionBreakup : [];
  let cursor = 0;
  let lastLabel = 'Mixed Practice';

  sections.forEach((section, sectionIndex) => {
    const label = String(section?.name || `Section ${sectionIndex + 1}`).trim() || `Section ${sectionIndex + 1}`;
    const count = Math.max(Number(section?.questions || 0), 0);
    if (count > 0) {
      lastLabel = label;
    }

    for (let index = 0; index < count && cursor < questionCount; index += 1) {
      names[cursor] = label;
      cursor += 1;
    }
  });

  for (; cursor < questionCount; cursor += 1) {
    names[cursor] = lastLabel;
  }

  return names;
};

const buildTestSeriesPerformance = (data, userId) => {
  const attempts = data.testAttempts
    .filter((attempt) => attempt.userId === String(userId))
    .sort((left, right) => sortRecentFirst(left, right, 'completedAt'));
  const testsById = new Map((data.tests || []).map((test) => [String(test._id), test]));
  const coursesById = new Map((data.courses || []).map((course) => [String(course._id), course]));
  const groups = new Map();

  attempts.forEach((attempt) => {
    const test = testsById.get(String(attempt.testId));
    if (!test) {
      return;
    }

    const linkedCourseId = getLinkedCourseIdForTest(test);
    const linkedCourse = linkedCourseId ? coursesById.get(String(linkedCourseId)) || null : null;
    const groupKey = linkedCourseId ? `course:${linkedCourseId}` : `test:${test._id}`;
    const sectionNames = buildQuestionSectionNames(test);

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        id: groupKey,
        title: linkedCourse?.title || test.title,
        courseId: linkedCourse?._id || null,
        courseTitle: linkedCourse?.title || null,
        exam: linkedCourse?.exam || test.category || null,
        attempts: 0,
        linkedTestIds: new Set(),
        latestAttemptAt: null,
        totalCorrect: 0,
        totalIncorrect: 0,
        totalUnattempted: 0,
        totalQuestions: 0,
        totalScore: 0,
        totalMarks: 0,
        sections: new Map(),
        topicMetaCache: new Map(),
        courseTopicReference: linkedCourse ? buildCourseTopicReference(linkedCourse) : [],
      });
    }

    const group = groups.get(groupKey);
    group.attempts += 1;
    group.linkedTestIds.add(String(test._id));
    group.latestAttemptAt = !group.latestAttemptAt || new Date(attempt.completedAt || 0) > new Date(group.latestAttemptAt || 0)
      ? attempt.completedAt
      : group.latestAttemptAt;
    group.totalScore += Number(attempt.score || 0);
    group.totalMarks += Number(attempt.totalMarks || test.totalMarks || 0);

    const solutionByQuestionId = new Map((attempt.solutions || []).map((solution) => [String(solution.questionId), solution]));

    (test.questions || []).forEach((question, questionIndex) => {
      const sectionName = sectionNames[questionIndex] || 'Mixed Practice';
      const solution = solutionByQuestionId.get(String(question.id)) || null;
      const selectedIndexes = getSubmittedOptionIndexes(solution?.selectedOptions?.length ? solution.selectedOptions : solution?.selectedOption ?? attempt.answers?.[question.id]);
      const correctIndexes = getCorrectOptionIndexesForAnalytics(question, solution);
      const topic = String(question.topic || solution?.topic || 'General Practice').trim() || 'General Practice';

      if (!group.sections.has(sectionName)) {
        group.sections.set(sectionName, {
          name: sectionName,
          correct: 0,
          incorrect: 0,
          unattempted: 0,
          totalQuestions: 0,
          topics: new Map(),
        });
      }

      const sectionStats = group.sections.get(sectionName);
      if (!sectionStats.topics.has(topic)) {
        let topicMeta = null;
        if (linkedCourse) {
          if (!group.topicMetaCache.has(topic)) {
            group.topicMetaCache.set(topic, resolveAnalyticsTopicMeta(linkedCourse, topic, group.courseTopicReference));
          }
          topicMeta = group.topicMetaCache.get(topic);
        }

        sectionStats.topics.set(topic, {
          topic,
          correct: 0,
          incorrect: 0,
          unattempted: 0,
          totalQuestions: 0,
          attempts: 0,
          meta: topicMeta,
        });
      }

      const topicStats = sectionStats.topics.get(topic);
      sectionStats.totalQuestions += 1;
      topicStats.totalQuestions += 1;
      topicStats.attempts = Math.max(topicStats.attempts, group.attempts);
      group.totalQuestions += 1;

      if (selectedIndexes.length === 0) {
        sectionStats.unattempted += 1;
        topicStats.unattempted += 1;
        group.totalUnattempted += 1;
      } else if (areOptionIndexesEqual(selectedIndexes, correctIndexes)) {
        sectionStats.correct += 1;
        topicStats.correct += 1;
        group.totalCorrect += 1;
      } else {
        sectionStats.incorrect += 1;
        topicStats.incorrect += 1;
        group.totalIncorrect += 1;
      }
    });
  });

  return Array.from(groups.values()).map((group) => {
    const sectionRows = Array.from(group.sections.values()).map((section) => {
      const accuracy = section.totalQuestions === 0
        ? 0
        : Number(((section.correct / section.totalQuestions) * 100).toFixed(2));
      const topicRows = Array.from(section.topics.values()).map((topic) => {
        const topicAccuracy = topic.totalQuestions === 0
          ? 0
          : Number(((topic.correct / topic.totalQuestions) * 100).toFixed(2));
        return {
          topic: topic.topic,
          sectionName: section.name,
          accuracy: topicAccuracy,
          correct: topic.correct,
          incorrect: topic.incorrect,
          unattempted: topic.unattempted,
          totalQuestions: topic.totalQuestions,
          attempts: topic.attempts,
          status: getAnalyticsPerformanceStatus(topicAccuracy),
          subjectTitle: topic.meta?.subjectTitle || null,
          moduleTitle: topic.meta?.moduleTitle || null,
          chapterTitle: topic.meta?.chapterTitle || null,
          lessonTitle: topic.meta?.lessonTitle || null,
          pathLabel: topic.meta?.pathLabel || null,
        };
      }).sort((left, right) => {
        if (left.accuracy !== right.accuracy) {
          return left.accuracy - right.accuracy;
        }

        return right.totalQuestions - left.totalQuestions;
      });

      return {
        name: section.name,
        accuracy,
        correct: section.correct,
        incorrect: section.incorrect,
        unattempted: section.unattempted,
        totalQuestions: section.totalQuestions,
        attempts: group.attempts,
        status: getAnalyticsPerformanceStatus(accuracy),
        weakConcepts: topicRows.filter((topic) => topic.status !== 'strong').slice(0, 4),
        strongConcepts: topicRows.filter((topic) => topic.status === 'strong').slice(0, 3),
      };
    }).sort((left, right) => {
      if (left.accuracy !== right.accuracy) {
        return left.accuracy - right.accuracy;
      }

      return right.totalQuestions - left.totalQuestions;
    });

    const focusConcepts = sectionRows
      .flatMap((section) => section.weakConcepts)
      .sort((left, right) => {
        if (left.accuracy !== right.accuracy) {
          return left.accuracy - right.accuracy;
        }

        return right.totalQuestions - left.totalQuestions;
      })
      .slice(0, 6);

    const healthyConcepts = sectionRows
      .flatMap((section) => section.strongConcepts)
      .sort((left, right) => {
        if (left.accuracy !== right.accuracy) {
          return right.accuracy - left.accuracy;
        }

        return right.totalQuestions - left.totalQuestions;
      })
      .slice(0, 4);

    const overallAccuracy = group.totalQuestions === 0
      ? 0
      : Number(((group.totalCorrect / group.totalQuestions) * 100).toFixed(2));

    return {
      id: group.id,
      title: group.title,
      courseId: group.courseId,
      courseTitle: group.courseTitle,
      exam: group.exam,
      attempts: group.attempts,
      linkedTests: group.linkedTestIds.size,
      lastAttemptedAt: group.latestAttemptAt,
      overallAccuracy,
      averageScore: group.attempts === 0 ? 0 : Number((group.totalScore / group.attempts).toFixed(2)),
      totalMarks: group.attempts === 0 ? 0 : Number((group.totalMarks / group.attempts).toFixed(2)),
      correct: group.totalCorrect,
      incorrect: group.totalIncorrect,
      unattempted: group.totalUnattempted,
      status: getAnalyticsPerformanceStatus(overallAccuracy),
      sections: sectionRows,
      focusConcepts,
      healthyConcepts,
    };
  }).sort((left, right) => {
    if (left.lastAttemptedAt && right.lastAttemptedAt && left.lastAttemptedAt !== right.lastAttemptedAt) {
      return sortRecentFirst({ completedAt: left.lastAttemptedAt }, { completedAt: right.lastAttemptedAt }, 'completedAt');
    }

    return left.overallAccuracy - right.overallAccuracy;
  });
};

const computeAdaptivePlan = ({ accuracy, attempts }) => {
  if (attempts === 0) {
    return {
      nextTestType: 'topic-wise',
      difficulty: 'foundation',
      reason: 'Start with topic-wise fundamentals before graduating to sectional and full mocks.',
    };
  }

  if (accuracy < 60) {
    return {
      nextTestType: 'topic-wise',
      difficulty: 'easy',
      reason: 'Accuracy is still unstable, so adaptive flow recommends another topic-wise test.',
    };
  }

  if (accuracy < 80) {
    return {
      nextTestType: 'sectional',
      difficulty: 'medium',
      reason: 'You are ready for sectional pressure before the next full-length mock.',
    };
  }

  return {
    nextTestType: 'full-length',
    difficulty: 'hard',
    reason: 'Strong accuracy trend detected. Move to exam-mode full mocks to improve percentile.',
  };
};

const buildAnalyticsTrend = (data, userId) => {
  const testPoints = data.testAttempts
    .filter((attempt) => attempt.userId === String(userId))
    .slice(-4)
    .map((attempt, index) => ({
      label: `Mock ${index + 1}`,
      score: Number(attempt.score || 0),
      accuracy: attempt.totalMarks
        ? Number((((Number(attempt.score || 0) / Number(attempt.totalMarks || 1)) * 100)).toFixed(2))
        : 0,
    }));

  const quizPoints = data.quizzes
    .flatMap((quiz) =>
      (quiz.leaderboard || [])
        .filter((entry) => entry.userId === String(userId))
        .map((entry) => ({
          label: `Quiz ${quiz.date.slice(5)}`,
          score: Number(entry.score || 0),
          accuracy: entry.total ? Number((((entry.score / entry.total) * 100)).toFixed(2)) : 0,
        })),
    )
    .slice(-4);

  return [...testPoints, ...quizPoints];
};

const buildUserAnalyticsFromData = (data, userId) => {
  const quizInsights = computeQuizInsights(data, userId);
  const testInsights = computeTestInsights(data, userId);
  const seriesPerformance = buildTestSeriesPerformance(data, userId);
  const weakTopics = new Set(
    seriesPerformance.length > 0
      ? seriesPerformance.flatMap((series) => series.focusConcepts.map((concept) => concept.topic)).slice(0, 8)
      : (testInsights.latestAttempt?.weakTopics || []),
  );
  const strongTopics = new Set(
    seriesPerformance.length > 0
      ? seriesPerformance.flatMap((series) => series.healthyConcepts.map((concept) => concept.topic)).slice(0, 8)
      : (testInsights.latestAttempt?.strongTopics || []),
  );

  const accuracyValues = [quizInsights.accuracy, testInsights.accuracy].filter((value) => value > 0);
  const accuracy = accuracyValues.length === 0
    ? 0
    : Number((accuracyValues.reduce((sum, value) => sum + value, 0) / accuracyValues.length).toFixed(2));

  const speed = testInsights.attempts.length === 0
    ? quizInsights.attempts === 0 ? 0 : 1.1
    : Number((testInsights.attempts.length / Math.max(testInsights.attempts.length, 1)).toFixed(2));

  const attempts = quizInsights.attempts + testInsights.attempts.length;

  return {
    accuracy,
    speed,
    attempts,
    weakTopics: Array.from(weakTopics),
    strongTopics: Array.from(strongTopics),
    suggestions: [buildAiRecommendation({ accuracy, weakTopics: Array.from(weakTopics), attempts })].filter(Boolean),
    trend: buildAnalyticsTrend(data, userId),
    adaptivePlan: computeAdaptivePlan({ accuracy, attempts }),
    seriesPerformance,
  };
};

const buildAiRecommendation = (analytics) => {
  const weakTopic = (analytics.weakTopics || [])[0];
  if (weakTopic) {
    return `Focus more on ${weakTopic}. Use revision before attempting the next test.`;
  }

  if (analytics.attempts > 0 && analytics.accuracy < 70) {
    return 'Your concept retention is improving. Spend the next revision block on weak topics before attempting another full test.';
  }

  if (analytics.attempts > 0) {
    return 'You are on a strong trend. Keep alternating full mocks with topic-wise revision to protect your percentile.';
  }

  return '';
};

const normalizeQuizLeaderboard = (entries) =>
  clone(entries || []).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return sortOldestFirst(left, right, 'submittedAt');
  });

const redisJsonTtl = 60;

const mapUserRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    _id: row.id,
    name: row.full_name,
    email: row.email,
    mobileNumber: row.mobile_number || null,
    password: row.password_hash,
    role: row.role,
    accountStatus: row.account_status || 'active',
    statusNote: row.status_note || null,
    device: row.device || null,
    session: row.active_session_id || null,
    streak: Number(row.streak_days || 0),
    points: Number(row.reward_points || 0),
    badges: asArray(row.badges),
    referral_code: row.referral_code || null,
    lastLoginAt: toIso(row.last_login_at) || null,
    disabledAt: toIso(row.disabled_at) || null,
    blockedAt: toIso(row.blocked_at) || null,
    created_at: toIso(row.created_at) || nowIso(),
    updated_at: toIso(row.updated_at) || nowIso(),
  };
};

const mapCourseRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    _id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category || 'SSC JE',
    exam: row.exam || row.category || 'SSC JE',
    subject: row.subject || 'General',
    level: row.level || 'Full Course',
    price: toNumber(row.price_inr),
    offerPercentage: toNumber(row.offer_percentage),
    validityDays: Number(row.validity_days || 365),
    thumbnailUrl: row.thumbnail_url || null,
    instructor: row.instructor_name || 'VARONENGLISH Faculty',
    officialChannelUrl: row.official_channel_url || null,
    editorials: asArray(row.editorials),
    modules: asArray(row.modules),
    createdBy: row.created_by || null,
    created_at: toIso(row.created_at) || nowIso(),
  };
};

const mapTestRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    _id: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category || 'SSC JE',
    type: row.test_type || 'full-length',
    durationMinutes: Number(row.duration_minutes || 60),
    totalMarks: toNumber(row.total_marks),
    negativeMarking: toNumber(row.negative_marking),
    course: row.course_id || null,
    companionVideo: row.companion_video ? asObject(row.companion_video) : null,
    sectionBreakup: asArray(row.section_breakup),
    questions: asArray(row.questions),
    created_at: toIso(row.created_at) || nowIso(),
  };
};

const mapTestAttemptRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    _id: row.id,
    userId: row.user_id,
    testId: row.test_id,
    score: toNumber(row.score),
    totalMarks: toNumber(row.total_marks),
    correctCount: Number(row.correct_count || 0),
    incorrectCount: Number(row.incorrect_count || 0),
    unattemptedCount: Number(row.unattempted_count || 0),
    percentile: toNumber(row.percentile),
    rank: Number(row.all_india_rank || 0),
    answers: asObject(row.answers),
    weakTopics: asArray(row.weak_topics),
    strongTopics: asArray(row.strong_topics),
    solutions: asArray(row.solutions),
    startedAt: toIso(row.started_at) || nowIso(),
    completedAt: toIso(row.completed_at) || nowIso(),
  };
};

const mapQuizRow = (row) => ({
  _id: row.id,
  date: typeof row.quiz_date === 'string' ? row.quiz_date.slice(0, 10) : toIso(row.quiz_date).slice(0, 10),
  title: row.title || 'Daily Quiz',
  questions: asArray(row.questions),
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapQuizAttemptRow = (row) => ({
  _id: row.id,
  quizId: row.daily_quiz_id,
  userId: row.user_id,
  score: Number(row.score || 0),
  total: Number(row.total || 0),
  submittedAt: toIso(row.submitted_at) || nowIso(),
  name: row.full_name || undefined,
});

const mapLiveClassRow = (row) => ({
  _id: row.id,
  linkageType: row.linkage_type || 'standalone',
  courseId: row.course_id || null,
  moduleId: row.module_id || null,
  moduleTitle: row.module_title || null,
  chapterId: row.chapter_id || null,
  chapterTitle: row.chapter_title || null,
  mockTestId: row.mock_test_id || null,
  mockTestTitle: row.mock_test_title || null,
  title: row.title,
  instructor: row.instructor_name || 'VARONENGLISH Faculty',
  startTime: toIso(row.scheduled_start_at) || nowIso(),
  durationMinutes: Number(row.duration_minutes || 60),
  provider: row.provider || 'Jitsi Meet',
  mode: row.mode || 'live',
  status: row.status || 'scheduled',
  livePlaybackUrl: row.live_playback_url || null,
  livePlaybackType: row.live_playback_type || getDefaultLivePlaybackType(),
  embedUrl: row.embed_url || null,
  roomUrl: row.room_url || null,
  recordingUrl: row.recording_url || null,
  replayCourseId: row.replay_course_id || null,
  replayLessonId: row.replay_lesson_id || null,
  chatEnabled: Boolean(row.chat_enabled),
  doubtSolving: Boolean(row.doubt_solving),
  replayAvailable: Boolean(row.replay_available),
  attendees: Number(row.attendee_count || 0),
  maxAttendees: Number(row.max_attendees || 2500),
  requiresEnrollment: row.requires_enrollment !== false,
  recordingStorageProvider: row.recording_storage_provider || null,
  recordingStoragePath: row.recording_storage_path || null,
  recordingPublishedAt: toIso(row.recording_published_at),
  recordingExpiresAt: toIso(row.recording_expires_at),
  recordingDurationMinutes: row.recording_duration_minutes === null || row.recording_duration_minutes === undefined
    ? null
    : Number(row.recording_duration_minutes || 0),
  posterUrl: row.poster_url || null,
  description: row.class_description || null,
  teacherProfile: asObject(row.teacher_profile),
  sessionNotes: asArray(row.session_notes),
  resources: asArray(row.resource_items),
  activePoll: asObject(row.active_poll),
  topicTags: asArray(row.topic_tags),
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapLiveChatRow = (row) => ({
  _id: row.id,
  liveClassId: row.live_class_id,
  userId: row.user_id,
  userName: row.user_name,
  kind: row.kind || 'chat',
  message: row.message,
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapPlanRow = (row) => ({
  _id: row.id,
  title: row.title,
  description: row.description || '',
  price: toNumber(row.price_inr),
  billingCycle: row.billing_cycle || 'monthly',
  accessType: row.access_type || 'subscription',
  features: asArray(row.feature_list),
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapSubscriptionRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  planId: row.plan_id,
  status: row.status || 'active',
  source: row.source || 'payment',
  startedAt: toIso(row.started_at) || nowIso(),
  expiresAt: toIso(row.expires_at),
});

const mapNotificationRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  title: row.title,
  message: row.message,
  type: row.notification_type || 'general',
  entityId: row.entity_id || null,
  actionUrl: row.action_url || null,
  actionLabel: row.action_label || null,
  payload: asObject(row.payload),
  isRead: Boolean(row.is_read),
  readAt: toIso(row.read_at) || null,
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapReferralRow = (row) => ({
  _id: row.id,
  referrerUserId: row.referrer_user_id,
  referredEmail: row.referred_email,
  rewardPoints: Number(row.reward_points || 0),
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapEnrollmentRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  courseId: row.course_id,
  accessType: row.access_type || 'course',
  source: row.source || 'payment',
  accessStatus: row.access_status || 'enabled',
  adminNote: row.admin_note || null,
  enrolledAt: toIso(row.enrolled_at) || nowIso(),
  expiresAt: toIso(row.expires_at),
  viewCount: Number(row.view_count || 0),
  updatedAt: toIso(row.updated_at) || nowIso(),
});

const mapCourseContentAccessRuleRow = (row) => normalizeCourseContentAccessRuleRecord({
  _id: row.id,
  courseId: row.course_id,
  studentScope: row.student_scope,
  studentId: row.student_id,
  contentScope: row.content_scope,
  moduleId: row.module_id,
  chapterId: row.chapter_id,
  lessonId: row.lesson_id,
  access: row.access,
  adminNote: row.admin_note,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
});

const mapStudentLessonWatchOverrideRow = (row) => normalizeStudentLessonWatchOverrideRecord({
  _id: row.id,
  courseId: row.course_id,
  studentId: row.student_id,
  moduleId: row.module_id,
  chapterId: row.chapter_id,
  lessonId: row.lesson_id,
  allowedFullWatches: row.allowed_full_watches,
  watchCompletionPercent: row.watch_completion_percent,
  adminNote: row.admin_note,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
});

const mapVideoAccessGrantRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  courseId: row.course_id,
  lessonId: row.lesson_id,
  accessType: row.access_type || 'replay',
  expiresAt: toIso(row.expires_at) || null,
  maxViews: Number(row.max_views || replayMaxViews),
  usedViews: Number(row.used_views || 0),
  activeSessionId: row.active_session_id || null,
  lastStartedAt: toIso(row.last_started_at),
  lastCompletedAt: toIso(row.last_completed_at),
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
});

const mapLiveReplayGrantRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  liveClassId: row.live_class_id,
  accessType: row.access_type || 'live-replay',
  expiresAt: toIso(row.expires_at) || null,
  maxViews: Number(row.max_views || replayMaxViews),
  usedViews: Number(row.used_views || 0),
  activeSessionId: row.active_session_id || null,
  lastStartedAt: toIso(row.last_started_at),
  lastCompletedAt: toIso(row.last_completed_at),
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
});

const mapWatchHistoryRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  courseId: row.course_id,
  lessonId: row.lesson_id,
  progressPercent: toNumber(row.progress_percent),
  progressSeconds: Number(row.progress_seconds || 0),
  completed: Boolean(row.completed),
  lessonStage: normalizeLessonStage(row.lesson_stage),
  examSubmitted: Boolean(row.exam_submitted),
  examSelectedOption: row.exam_selected_option === null || row.exam_selected_option === undefined
    ? null
    : Number(row.exam_selected_option),
  explanationSeconds: Number(row.explanation_seconds || 0),
  videoWatchCount: Number(row.video_watch_count || 0),
  explanationWatchCount: Number(row.explanation_watch_count || 0),
  lastSessionId: row.last_session_id || null,
  lastDevice: asObject(row.last_device),
  lastWatchedAt: toIso(row.last_watched_at) || toIso(row.updated_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
});

const mapVideoWatchStateRow = (row) => normalizeVideoWatchState({
  _id: row.id,
  userId: row.user_id,
  courseId: row.course_id,
  lessonId: row.lesson_id || null,
  videoId: row.video_id,
  videoType: row.video_type || COURSE_VIDEO_TYPE,
  videoDurationSeconds: Number(row.video_duration_seconds || 0),
  allowedFullWatches: Number(row.allowed_full_watches || 0),
  completedFullWatches: Number(row.completed_full_watches || 0),
  fullWatchThresholdPercentage: toNumber(row.full_watch_threshold_percentage),
  watchedSegments: asArray(row.watched_segments),
  currentCycleUniqueWatchedSeconds: toNumber(row.current_cycle_unique_watched_seconds),
  totalUniqueWatchedSeconds: toNumber(row.total_unique_watched_seconds),
  repeatWatchedSeconds: toNumber(row.repeat_watched_seconds),
  revisionBufferSeconds: toNumber(row.revision_buffer_seconds),
  revisionBufferUsedSeconds: toNumber(row.revision_buffer_used_seconds),
  stableEndWindowWatchedSeconds: toNumber(row.stable_end_window_watched_seconds),
  completionProofSatisfiedAt: toIso(row.completion_proof_satisfied_at) || null,
  lastPositionSeconds: toNumber(row.last_position_seconds),
  playbackSessionId: row.playback_session_id || null,
  activeSessionStatus: row.active_session_status || 'idle',
  deviceId: row.device_id || null,
  ipAddress: row.ip_address || null,
  userAgent: row.user_agent || null,
  lastHeartbeatAt: toIso(row.last_heartbeat_at) || null,
  isLocked: Boolean(row.is_locked),
  lockedAt: toIso(row.locked_at) || null,
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
}, {
  chunkSeconds: videoWatchChunkSeconds,
});

const resolveProtectedLessonResumeSeconds = ({
  watchState = null,
  lessonProgress = null,
  durationSeconds = 0,
}) => {
  const safeDurationSeconds = Math.max(
    Number(watchState?.videoDurationSeconds || 0),
    Number(durationSeconds || 0),
    Number(lessonProgress?.progressSeconds || 0),
    0,
  );
  const clampResume = (value) => {
    const safeValue = Math.max(Number(value || 0), 0);
    if (safeDurationSeconds <= 0) {
      return safeValue;
    }
    return Math.min(safeValue, safeDurationSeconds);
  };

  if (watchState) {
    const replayState = deriveProtectedReplayState(watchState);
    if (replayState === 'resume_current_cycle' || replayState === 'grace_cycle') {
      return clampResume(watchState.lastPositionSeconds);
    }

    return 0;
  }

  if (Number(lessonProgress?.videoWatchCount || 0) > 0) {
    return 0;
  }

  return clampResume(lessonProgress?.progressSeconds || 0);
};

const mapPaymentRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  amount: toNumber(row.amount_inr),
  currency: row.currency || 'INR',
  provider: row.provider || 'internal',
  providerOrderId: row.provider_order_id || null,
  providerPaymentId: row.provider_payment_id || null,
  providerSignature: row.provider_signature || null,
  courseId: row.course_id || null,
  receipt: row.receipt || null,
  item: row.item || 'Course Purchase',
  status: row.status || 'pending',
  attemptCount: Number(row.attempt_count || 1),
  retryable: Boolean(row.retryable),
  lastError: row.last_error || null,
  meta: asObject(row.payment_meta),
  paidAt: toIso(row.paid_at) || null,
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || null,
});

const mapUploadRow = (row) => ({
  _id: row.id,
  title: row.title,
  course: row.course_id || null,
  questionCount: Number(row.question_count || 0),
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapWebhookRow = (row) => ({
  _id: row.id,
  event: row.event,
  paymentId: row.payment_id || null,
  status: row.status,
  receivedAt: toIso(row.received_at) || nowIso(),
  payload: asObject(row.payload),
});

const mapAiMessageRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  message: row.message,
  answer: row.answer,
  createdAt: toIso(row.created_at) || nowIso(),
});

const mapSessionRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  sessionId: row.jwt_session_id,
  device: row.device || null,
  status: row.status || 'active',
  reason: row.reason || null,
  createdAt: toIso(row.created_at) || nowIso(),
  lastSeenAt: toIso(row.last_seen_at) || nowIso(),
  endedAt: toIso(row.ended_at),
});

const mapDeviceActivityRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  sessionId: row.session_id || null,
  device: row.device || null,
  eventType: row.event_type,
  meta: asObject(row.event_meta),
  createdAt: toIso(row.created_at) || nowIso(),
});

const pgMany = async (sql, params = [], mapper = (row) => row, client = null) => {
  const result = await queryPostgres(sql, params, client);
  return result.rows.map((row) => mapper(row));
};

const pgOne = async (sql, params = [], mapper = (row) => row, client = null) => {
  const result = await queryPostgres(sql, params, client);
  return result.rows[0] ? mapper(result.rows[0]) : null;
};

const pgExec = async (sql, params = [], client = null) => queryPostgres(sql, params, client);

const upsertPgUser = async (payload, client = null) => {
  const user = {
    _id: payload._id || createPersistentId('user'),
    name: payload.name,
    email: normalizeEmail(payload.email),
    mobileNumber: payload.mobileNumber || null,
    password: payload.password,
    role: payload.role || 'student',
    accountStatus: payload.accountStatus || 'active',
    statusNote: payload.statusNote || null,
    device: payload.device || null,
    session: payload.session || null,
    streak: payload.streak ?? 0,
    points: payload.points ?? 0,
    badges: asArray(payload.badges),
    referral_code: payload.referral_code || null,
    lastLoginAt: payload.lastLoginAt || null,
    disabledAt: payload.disabledAt || null,
    blockedAt: payload.blockedAt || null,
    created_at: payload.created_at || nowIso(),
    updated_at: payload.updated_at || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO users (
        id, full_name, email, mobile_number, password_hash, role, account_status, status_note,
        device, active_session_id, streak_days, reward_points, badges, referral_code,
        last_login_at, disabled_at, blocked_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        email = EXCLUDED.email,
        mobile_number = EXCLUDED.mobile_number,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        account_status = EXCLUDED.account_status,
        status_note = EXCLUDED.status_note,
        device = EXCLUDED.device,
        active_session_id = EXCLUDED.active_session_id,
        streak_days = EXCLUDED.streak_days,
        reward_points = EXCLUDED.reward_points,
        badges = EXCLUDED.badges,
        referral_code = EXCLUDED.referral_code,
        last_login_at = EXCLUDED.last_login_at,
        disabled_at = EXCLUDED.disabled_at,
        blocked_at = EXCLUDED.blocked_at,
        updated_at = EXCLUDED.updated_at
    `,
    [
      user._id,
      user.name,
      user.email,
      user.mobileNumber,
      user.password,
      user.role,
      user.accountStatus,
      user.statusNote,
      JSON.stringify(user.device),
      user.session,
      Number(user.streak || 0),
      Number(user.points || 0),
      JSON.stringify(user.badges || []),
      user.referral_code,
      user.lastLoginAt,
      user.disabledAt,
      user.blockedAt,
      user.created_at,
      user.updated_at,
    ],
    client,
  );

  return user;
};

const upsertPgCourse = async (payload, client = null) => {
  const course = {
    _id: payload._id || createPersistentId('course'),
    title: payload.title,
    description: payload.description || '',
    category: payload.category || 'SSC JE',
    exam: payload.exam || payload.category || 'SSC JE',
    subject: payload.subject || 'General',
    level: payload.level || 'Full Course',
    price: Number(payload.price || 0),
    offerPercentage: Number(payload.offerPercentage || 0),
    validityDays: Number(payload.validityDays || courseDefaultValidityDays),
    thumbnailUrl: payload.thumbnailUrl || null,
    instructor: payload.instructor || 'VARONENGLISH Faculty',
    officialChannelUrl: payload.officialChannelUrl || null,
    editorials: asArray(payload.editorials),
    modules: asArray(payload.modules),
    createdBy: payload.createdBy || null,
    created_at: payload.created_at || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO courses (
        id, title, description, category, exam, subject, level, price_inr, offer_percentage,
        validity_days, thumbnail_url, instructor_name, official_channel_url,
        editorials, modules, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        exam = EXCLUDED.exam,
        subject = EXCLUDED.subject,
        level = EXCLUDED.level,
        price_inr = EXCLUDED.price_inr,
        offer_percentage = EXCLUDED.offer_percentage,
        validity_days = EXCLUDED.validity_days,
        thumbnail_url = EXCLUDED.thumbnail_url,
        instructor_name = EXCLUDED.instructor_name,
        official_channel_url = EXCLUDED.official_channel_url,
        editorials = EXCLUDED.editorials,
        modules = EXCLUDED.modules,
        created_by = EXCLUDED.created_by
    `,
    [
      course._id,
      course.title,
      course.description,
      course.category,
      course.exam,
      course.subject,
      course.level,
      course.price,
      course.offerPercentage,
      course.validityDays,
      course.thumbnailUrl,
      course.instructor,
      course.officialChannelUrl,
      JSON.stringify(course.editorials || []),
      JSON.stringify(course.modules || []),
      course.createdBy,
      course.created_at,
    ],
    client,
  );

  return course;
};

const upsertPgTest = async (payload, client = null) => {
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((question, index) => {
        const normalizedCorrectOptions = Array.isArray(question.correctOptions) && question.correctOptions.length > 0
          ? [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
          : Number.isFinite(Number(question.correctOption ?? question.answer))
            ? [Number(question.correctOption ?? question.answer)]
            : [0];

        return {
          ...clone(question),
          id: question.id || createPersistentId(`question_${index + 1}`),
          answer: normalizedCorrectOptions[0],
          correctOption: normalizedCorrectOptions[0],
          correctOptions: normalizedCorrectOptions,
          explanation: question.explanation || '',
          marks: Number(question.marks || 1),
          topic: question.topic || 'General Practice',
        };
      })
    : [];

  const test = {
    _id: payload._id || createPersistentId('test'),
    title: payload.title,
    description: payload.description || '',
    category: payload.category || 'SSC JE',
    type: payload.type || 'full-length',
    durationMinutes: Number(payload.durationMinutes || 60),
    totalMarks: Number(payload.totalMarks || questions.reduce((sum, question) => sum + Number(question.marks || 1), 0)),
    negativeMarking: Number(payload.negativeMarking || 0),
    companionVideo: payload.companionVideo && typeof payload.companionVideo === 'object'
      ? clone(payload.companionVideo)
      : null,
    sectionBreakup: asArray(payload.sectionBreakup),
    course: payload.course || null,
    questions,
    created_at: payload.created_at || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO tests (
        id, title, description, category, test_type, duration_minutes, total_marks,
        negative_marking, course_id, companion_video, section_breakup, questions, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        category = EXCLUDED.category,
        test_type = EXCLUDED.test_type,
        duration_minutes = EXCLUDED.duration_minutes,
        total_marks = EXCLUDED.total_marks,
        negative_marking = EXCLUDED.negative_marking,
        course_id = EXCLUDED.course_id,
        companion_video = EXCLUDED.companion_video,
        section_breakup = EXCLUDED.section_breakup,
        questions = EXCLUDED.questions
    `,
    [
      test._id,
      test.title,
      test.description,
      test.category,
      test.type,
      test.durationMinutes,
      test.totalMarks,
      test.negativeMarking,
      test.course,
      JSON.stringify(test.companionVideo || null),
      JSON.stringify(test.sectionBreakup || []),
      JSON.stringify(test.questions || []),
      test.created_at,
    ],
    client,
  );

  return test;
};

const upsertPgQuiz = async (payload, client = null) => {
  const quizDate = String(payload.date || '').slice(0, 10);
  const existing = await pgOne(
    'SELECT * FROM daily_quizzes WHERE quiz_date = $1',
    [quizDate],
    mapQuizRow,
    client,
  );

  const quiz = {
    _id: existing?._id || payload._id || createPersistentId('quiz'),
    date: quizDate,
    title: payload.title || existing?.title || 'Daily Quiz',
    questions: asArray(payload.questions),
    createdAt: payload.createdAt || existing?.createdAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO daily_quizzes (id, quiz_date, title, questions, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (id) DO UPDATE SET
        quiz_date = EXCLUDED.quiz_date,
        title = EXCLUDED.title,
        questions = EXCLUDED.questions
    `,
    [quiz._id, quiz.date, quiz.title, JSON.stringify(quiz.questions || []), quiz.createdAt],
    client,
  );

  await deleteRedisKey(cacheKey('quiz-leaderboard', quiz._id));
  await deleteRedisKey(cacheKey('quiz-weekly', 'all'));
  return quiz;
};

const insertPgNotification = async (payload, client = null) => {
  const notification = {
    _id: payload._id || createPersistentId('notification'),
    userId: String(payload.userId),
    title: payload.title || 'Notification',
    message: payload.message || '',
    type: payload.type || 'general',
    entityId: payload.entityId ? String(payload.entityId) : null,
    actionUrl: payload.actionUrl || null,
    actionLabel: payload.actionLabel || null,
    payload: asObject(payload.payload),
    isRead: Boolean(payload.isRead),
    readAt: payload.readAt || null,
    createdAt: payload.createdAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO notifications (
        id, user_id, title, message, notification_type, entity_id, action_url, action_label, payload, is_read, read_at, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        notification_type = EXCLUDED.notification_type,
        entity_id = EXCLUDED.entity_id,
        action_url = EXCLUDED.action_url,
        action_label = EXCLUDED.action_label,
        payload = EXCLUDED.payload,
        is_read = EXCLUDED.is_read,
        read_at = EXCLUDED.read_at
    `,
    [
      notification._id,
      notification.userId,
      notification.title,
      notification.message,
      notification.type,
      notification.entityId,
      notification.actionUrl,
      notification.actionLabel,
      JSON.stringify(notification.payload),
      notification.isRead,
      notification.readAt,
      notification.createdAt,
    ],
    client,
  );

  return notification;
};

const insertPgEnrollment = async (payload, client = null) => {
  const enrollment = {
    _id: payload._id || createPersistentId('enrollment'),
    userId: String(payload.userId),
    courseId: String(payload.courseId),
    accessType: payload.accessType || 'course',
    source: payload.source || 'payment',
    accessStatus: payload.accessStatus || 'enabled',
    adminNote: payload.adminNote || null,
    enrolledAt: payload.enrolledAt || nowIso(),
    expiresAt: payload.expiresAt || addDaysIso(payload.validityDays),
    viewCount: Number(payload.viewCount || 0),
    updatedAt: payload.updatedAt || nowIso(),
  };

  const saved = await pgOne(
    `
      INSERT INTO enrollments (id, user_id, course_id, access_type, source, access_status, admin_note, enrolled_at, expires_at, view_count, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (user_id, course_id) DO UPDATE SET
        access_type = EXCLUDED.access_type,
        source = EXCLUDED.source,
        access_status = EXCLUDED.access_status,
        admin_note = EXCLUDED.admin_note,
        enrolled_at = enrollments.enrolled_at,
        expires_at = EXCLUDED.expires_at,
        view_count = enrollments.view_count,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
    [
      enrollment._id,
      enrollment.userId,
      enrollment.courseId,
      enrollment.accessType,
      enrollment.source,
      enrollment.accessStatus,
      enrollment.adminNote,
      enrollment.enrolledAt,
      enrollment.expiresAt,
      enrollment.viewCount,
      enrollment.updatedAt,
    ],
    mapEnrollmentRow,
    client,
  );

  return saved || enrollment;
};

const resolveReplayGrantExpiryIso = ({ enrollment = null, currentGrant = null } = {}) => {
  const candidates = [Date.now() + replayRetentionMs];

  if (enrollment?.expiresAt) {
    const enrollmentExpiry = Date.parse(enrollment.expiresAt);
    if (Number.isFinite(enrollmentExpiry)) {
      candidates.push(enrollmentExpiry);
    }
  }

  if (currentGrant?.expiresAt) {
    const currentExpiry = Date.parse(currentGrant.expiresAt);
    if (Number.isFinite(currentExpiry)) {
      candidates.push(currentExpiry);
    }
  }

  return new Date(Math.min(...candidates)).toISOString();
};

const resolveLiveReplayGrantExpiryIso = ({ liveClass = null, currentGrant = null } = {}) => {
  const candidates = [Date.now() + liveReplayRetentionMs];

  if (liveClass?.recordingExpiresAt) {
    const recordingExpiry = Date.parse(liveClass.recordingExpiresAt);
    if (Number.isFinite(recordingExpiry)) {
      candidates.push(recordingExpiry);
    }
  }

  if (liveClass?.recordingPublishedAt) {
    const publishedAt = Date.parse(liveClass.recordingPublishedAt);
    if (Number.isFinite(publishedAt)) {
      candidates.push(publishedAt + liveReplayRetentionMs);
    }
  }

  if (currentGrant?.expiresAt) {
    const currentExpiry = Date.parse(currentGrant.expiresAt);
    if (Number.isFinite(currentExpiry)) {
      candidates.push(currentExpiry);
    }
  }

  return new Date(Math.min(...candidates)).toISOString();
};

const mapReplayGrantForResponse = (grant) => ({
  _id: grant._id,
  userId: grant.userId,
  courseId: grant.courseId,
  lessonId: grant.lessonId,
  accessType: grant.accessType || 'replay',
  expiresAt: grant.expiresAt,
  maxViews: Number(grant.maxViews || replayMaxViews),
  usedViews: Number(grant.usedViews || 0),
  remainingViews: Math.max(Number(grant.maxViews || replayMaxViews) - Number(grant.usedViews || 0), 0),
  activeSessionId: grant.activeSessionId || null,
  lastStartedAt: grant.lastStartedAt || null,
  lastCompletedAt: grant.lastCompletedAt || null,
  createdAt: grant.createdAt || nowIso(),
  updatedAt: grant.updatedAt || nowIso(),
});

const mapLiveReplayGrantForResponse = (grant) => ({
  _id: grant._id,
  userId: grant.userId,
  liveClassId: grant.liveClassId,
  accessType: grant.accessType || 'live-replay',
  expiresAt: grant.expiresAt,
  maxViews: Number(grant.maxViews || liveReplayMaxViews),
  usedViews: Number(grant.usedViews || 0),
  remainingViews: Math.max(Number(grant.maxViews || liveReplayMaxViews) - Number(grant.usedViews || 0), 0),
  activeSessionId: grant.activeSessionId || null,
  lastStartedAt: grant.lastStartedAt || null,
  lastCompletedAt: grant.lastCompletedAt || null,
  createdAt: grant.createdAt || nowIso(),
  updatedAt: grant.updatedAt || nowIso(),
});

const syncPgReplayGrantUsageFromWatchProgress = async ({
  userId,
  courseId,
  lessonId,
  videoWatchCount,
  completed = false,
  client = null,
}) => {
  const targetWatchCount = Math.max(Number(videoWatchCount || 0), 0);
  if (targetWatchCount <= 0 && !completed) {
    return;
  }

  await pgExec(
    `
      UPDATE video_access_grants
      SET used_views = GREATEST(COALESCE(used_views, 0), $4),
          last_completed_at = CASE
            WHEN $5 = TRUE THEN now()
            ELSE last_completed_at
          END,
          updated_at = now()
      WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3
    `,
    [String(userId), String(courseId), String(lessonId), targetWatchCount, Boolean(completed)],
    client,
  );
};

const syncMemoryReplayGrantUsageFromWatchProgress = ({
  userId,
  courseId,
  lessonId,
  videoWatchCount,
  completed = false,
}) => {
  const grant = state.videoAccessGrants.find(
    (entry) =>
      entry.userId === String(userId)
      && entry.courseId === String(courseId)
      && entry.lessonId === String(lessonId),
  );

  if (!grant) {
    return;
  }

  grant.usedViews = Math.max(Number(grant.usedViews || 0), Math.max(Number(videoWatchCount || 0), 0));
  if (completed) {
    grant.lastCompletedAt = nowIso();
  }
  grant.updatedAt = nowIso();
};

const upsertPgReplayGrant = async ({
  userId,
  courseId,
  lessonId,
  sessionId,
  lesson = null,
  enrollment = null,
  client = null,
}) => {
  const maxViews = getLessonConfiguredWatchLimit(lesson);
  const existing = await pgOne(
    'SELECT * FROM video_access_grants WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
    [String(userId), String(courseId), String(lessonId)],
    mapVideoAccessGrantRow,
    client,
  );
  const existingWatchHistory = await pgOne(
    'SELECT * FROM watch_history WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
    [String(userId), String(courseId), String(lessonId)],
    mapWatchHistoryRow,
    client,
  );

  const expiresAt = existing?.expiresAt || resolveReplayGrantExpiryIso({ enrollment });

  if (existing) {
    if (isReplayGrantExpired(existing)) {
      throw new ApiError(403, 'Replay access has expired', { code: 'REPLAY_ACCESS_EXPIRED' });
    }

    if (hasReplayViewLimit() && Number(existing.usedViews || 0) >= Number(existing.maxViews || replayMaxViews)) {
      throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
    }

    await pgExec(
      `
        UPDATE video_access_grants
        SET max_views = $2,
            active_session_id = $3,
            last_started_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [existing._id, maxViews, sessionId || null],
      client,
    );

    const updated = await pgOne(
      'SELECT * FROM video_access_grants WHERE id = $1',
      [existing._id],
      mapVideoAccessGrantRow,
      client,
    );
    return updated || existing;
  }

  const grant = {
    _id: createPersistentId('video_grant'),
    userId: String(userId),
    courseId: String(courseId),
    lessonId: String(lessonId),
    accessType: 'replay',
    expiresAt,
    maxViews,
    usedViews: Math.max(Number(existingWatchHistory?.videoWatchCount || 0), 0),
    activeSessionId: null,
    lastStartedAt: null,
    lastCompletedAt: existingWatchHistory?.completed ? (existingWatchHistory.lastWatchedAt || nowIso()) : null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  if (hasReplayViewLimit() && Number(grant.usedViews || 0) >= Number(grant.maxViews || replayMaxViews)) {
    throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
  }

  const saved = await pgOne(
    `
      INSERT INTO video_access_grants (
        id, user_id, course_id, lesson_id, access_type, expires_at, max_views, used_views,
        active_session_id, last_started_at, last_completed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, now())
      ON CONFLICT (user_id, course_id, lesson_id) DO UPDATE SET
        expires_at = video_access_grants.expires_at,
        max_views = video_access_grants.max_views,
        active_session_id = EXCLUDED.active_session_id,
        last_started_at = now(),
        updated_at = now()
      RETURNING *
    `,
    [
      grant._id,
      grant.userId,
      grant.courseId,
      grant.lessonId,
      grant.accessType,
      grant.expiresAt,
      grant.maxViews,
      grant.usedViews,
      sessionId || null,
      grant.lastCompletedAt,
      grant.createdAt,
    ],
    mapVideoAccessGrantRow,
    client,
  );
  return saved || {
    ...grant,
    activeSessionId: sessionId || null,
    lastStartedAt: nowIso(),
    updatedAt: nowIso(),
  };
};

const upsertPgLiveReplayGrant = async ({
  userId,
  liveClassId,
  sessionId,
  liveClass = null,
  client = null,
}) => {
  const existing = await pgOne(
    'SELECT * FROM live_replay_access_grants WHERE user_id = $1 AND live_class_id = $2 FOR UPDATE',
    [String(userId), String(liveClassId)],
    mapLiveReplayGrantRow,
    client,
  );

  const expiresAt = existing?.expiresAt || resolveLiveReplayGrantExpiryIso({ liveClass });

  if (existing) {
    if (isLiveReplayGrantExpired(existing)) {
      throw new ApiError(403, 'Replay access has expired', { code: 'REPLAY_ACCESS_EXPIRED' });
    }

    if (hasReplayViewLimit() && Number(existing.usedViews || 0) >= Number(existing.maxViews || liveReplayMaxViews)) {
      throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
    }

    await pgExec(
      `
        UPDATE live_replay_access_grants
        SET used_views = COALESCE(used_views, 0),
            active_session_id = $2,
            last_started_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [existing._id, sessionId || null, 0],
      client,
    );

    const updated = await pgOne(
      'SELECT * FROM live_replay_access_grants WHERE id = $1',
      [existing._id],
      mapLiveReplayGrantRow,
      client,
    );
    return updated || existing;
  }

  const grant = {
    _id: createPersistentId('live_replay_grant'),
    userId: String(userId),
    liveClassId: String(liveClassId),
    accessType: 'live-replay',
    expiresAt,
    maxViews: liveReplayMaxViews,
    usedViews: 0,
    activeSessionId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await pgExec(
    `
      INSERT INTO live_replay_access_grants (
        id, user_id, live_class_id, access_type, expires_at, max_views, used_views,
        active_session_id, last_started_at, last_completed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      grant._id,
      grant.userId,
      grant.liveClassId,
      grant.accessType,
      grant.expiresAt,
      grant.maxViews,
      grant.usedViews,
      grant.activeSessionId,
      grant.lastStartedAt,
      grant.lastCompletedAt,
      grant.createdAt,
      grant.updatedAt,
    ],
    client,
  );

  await pgExec(
    `
      UPDATE live_replay_access_grants
      SET used_views = used_views,
          active_session_id = $2,
          last_started_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [grant._id, sessionId || null, 0],
    client,
  );

  const created = await pgOne(
    'SELECT * FROM live_replay_access_grants WHERE id = $1',
    [grant._id],
    mapLiveReplayGrantRow,
    client,
  );
  return created || grant;
};

const consumeMemoryReplayGrant = ({
  userId,
  courseId,
  lessonId,
  sessionId,
  lesson = null,
  enrollment = null,
}) => {
  const maxViews = getLessonConfiguredWatchLimit(lesson);
  const grantKey = {
    userId: String(userId),
    courseId: String(courseId),
    lessonId: String(lessonId),
  };
  let grant = state.videoAccessGrants.find(
    (entry) =>
      entry.userId === grantKey.userId
      && entry.courseId === grantKey.courseId
      && entry.lessonId === grantKey.lessonId,
  ) || null;

  if (grant && isReplayGrantExpired(grant)) {
    throw new ApiError(403, 'Replay access has expired', { code: 'REPLAY_ACCESS_EXPIRED' });
  }

  if (!grant) {
    grant = {
      _id: nextId('video_grant'),
      userId: grantKey.userId,
      courseId: grantKey.courseId,
      lessonId: grantKey.lessonId,
      accessType: 'replay',
      expiresAt: resolveReplayGrantExpiryIso({ enrollment }),
      maxViews,
      usedViews: 0,
      activeSessionId: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.videoAccessGrants.push(grant);
  }

  grant.maxViews = maxViews;
  if (hasReplayViewLimit() && Number(grant.usedViews || 0) >= Number(grant.maxViews || replayMaxViews)) {
    throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
  }

  grant.activeSessionId = sessionId || null;
  grant.lastStartedAt = nowIso();
  grant.updatedAt = nowIso();

  return clone(grant);
};

const consumeMemoryLiveReplayGrant = ({
  userId,
  liveClassId,
  sessionId,
  liveClass = null,
}) => {
  const grantKey = {
    userId: String(userId),
    liveClassId: String(liveClassId),
  };
  let grant = state.liveReplayAccessGrants.find(
    (entry) => entry.userId === grantKey.userId && entry.liveClassId === grantKey.liveClassId,
  ) || null;

  if (grant && isLiveReplayGrantExpired(grant)) {
    throw new ApiError(403, 'Replay access has expired', { code: 'REPLAY_ACCESS_EXPIRED' });
  }

  if (!grant) {
    grant = {
      _id: nextId('live_replay_grant'),
      userId: grantKey.userId,
      liveClassId: grantKey.liveClassId,
      accessType: 'live-replay',
      expiresAt: resolveLiveReplayGrantExpiryIso({ liveClass }),
      maxViews: liveReplayMaxViews,
      usedViews: 0,
      activeSessionId: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.liveReplayAccessGrants.push(grant);
  }

  if (hasReplayViewLimit() && Number(grant.usedViews || 0) >= Number(grant.maxViews || liveReplayMaxViews)) {
    throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
  }

  grant.activeSessionId = sessionId || null;
  grant.lastStartedAt = nowIso();
  grant.updatedAt = nowIso();

  return clone(grant);
};

const consumeLiveReplayGrant = async ({
  userId,
  liveClassId,
  sessionId,
}) => {
  const liveClass = await findStoredLiveClassById(liveClassId);
  if (!liveClass) {
    throw new ApiError(404, 'Live class not found', { code: 'LIVE_CLASS_NOT_FOUND' });
  }

  const derivedLiveReplayExpiry = Date.parse(
    liveClass.recordingExpiresAt
    || resolveLiveReplayGrantExpiryIso({ liveClass }),
  );
  if (Number.isFinite(derivedLiveReplayExpiry) && derivedLiveReplayExpiry <= Date.now()) {
    throw new ApiError(403, 'Replay access has expired', { code: 'REPLAY_ACCESS_EXPIRED' });
  }

  const user = await usersRepository.findSafeById(userId);
  if (!user) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const accessSessionId = sessionId || user.session || null;

  if (isPostgresMode()) {
    return {
      liveClass,
      user,
      grant: await runInTransaction(async (client) => upsertPgLiveReplayGrant({
        userId,
        liveClassId,
        sessionId: accessSessionId,
        liveClass,
        client,
      })),
    };
  }

  return {
    liveClass,
    user,
    grant: consumeMemoryLiveReplayGrant({
      userId,
      liveClassId,
      sessionId: accessSessionId,
      liveClass,
    }),
  };
};

const consumeReplayGrant = async ({
  userId,
  courseId,
  lessonId,
  sessionId,
  enforceEnrollment = true,
  enforceSequentialUnlock = true,
}) => {
  await ensurePlatformReady();

  const user = await usersRepository.findSafeById(userId);
  if (!user) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }
  const playbackSessionId = sessionId || user.session || null;

  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  const isAdmin = user.role === 'admin';
  let enrollment = null;

  const lesson = findLessonInCourse(course, lessonId);
  if (!lesson) {
    throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
  }

  const requireEnrollment = shouldRequireEnrollmentForLesson(lesson, enforceEnrollment);
  const requireSequentialUnlock = shouldRequireSequentialUnlockForCourseLesson({
    course,
    lesson,
    enforceSequentialUnlock,
    enforceEnrollment,
  });

  if (requireEnrollment && !isAdmin) {
    enrollment = await getEnrollmentForCourse(userId, courseId);
    if (!enrollment) {
      throw new ApiError(403, 'Please purchase course to watch.', { code: 'COURSE_ACCESS_REQUIRED' });
    }

    if (!isEnrollmentActive(enrollment)) {
      throw new ApiError(403, 'Course validity expired.', { code: 'COURSE_VALIDITY_EXPIRED' });
    }
  }

  const watchHistory = isPostgresMode()
    ? await getPgWatchHistoryForCourseUser(userId, courseId)
    : (await loadPlatformData()).watchHistory;
  const progressMap = buildLessonProgressMap(watchHistory, userId, courseId);

  if (requireSequentialUnlock && !isAdmin && !isLessonSequentiallyUnlockedForProgressMap(course, lessonId, progressMap)) {
    throw new ApiError(403, 'Finish the previous topic to unlock this lesson', { code: 'SEQUENTIAL_LOCKED' });
  }

  assertLessonReleasedForPlayback(lesson);

  if (isPostgresMode()) {
    return runInTransaction(async (client) => {
      const grant = await upsertPgReplayGrant({
        userId,
        courseId,
        lessonId,
        sessionId: playbackSessionId,
        lesson,
        enrollment,
        client,
      });
      return {
        user,
        course,
        lesson,
        enrollment,
        grant,
      };
    });
  }

  const grant = consumeMemoryReplayGrant({
    userId,
    courseId,
    lessonId,
    sessionId: playbackSessionId,
    lesson,
    enrollment,
  });

  return {
    user,
    course,
    lesson,
    enrollment,
    grant,
  };
};

const upsertPgWatchHistory = async (payload, client = null) => {
  const record = {
    _id: payload._id || createPersistentId('watch'),
    userId: String(payload.userId),
    courseId: String(payload.courseId),
    lessonId: String(payload.lessonId),
    progressPercent: Number(payload.progressPercent || 0),
    progressSeconds: Number(payload.progressSeconds || 0),
    completed: Boolean(payload.completed),
    lessonStage: normalizeLessonStage(payload.lessonStage),
    examSubmitted: payload.examSubmitted === null || payload.examSubmitted === undefined ? false : Boolean(payload.examSubmitted),
    examSelectedOption: payload.examSelectedOption === null || payload.examSelectedOption === undefined
      ? null
      : Number(payload.examSelectedOption),
    explanationSeconds: Math.max(Number(payload.explanationSeconds || 0), 0),
    videoWatchCount: Math.max(Number(payload.videoWatchCount || 0), 0),
    explanationWatchCount: Math.max(Number(payload.explanationWatchCount || 0), 0),
    lastSessionId: payload.sessionId || null,
    lastDevice: payload.device || null,
    lastWatchedAt: payload.lastWatchedAt || nowIso(),
    updatedAt: payload.updatedAt || nowIso(),
  };

  const saved = await pgOne(
    `
      INSERT INTO watch_history (
        id, user_id, course_id, lesson_id, progress_percent, progress_seconds, completed,
        lesson_stage, exam_submitted, exam_selected_option, explanation_seconds,
        video_watch_count, explanation_watch_count, last_session_id, last_device, last_watched_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
      ON CONFLICT (user_id, course_id, lesson_id) DO UPDATE SET
        progress_percent = GREATEST(watch_history.progress_percent, EXCLUDED.progress_percent),
        progress_seconds = GREATEST(watch_history.progress_seconds, EXCLUDED.progress_seconds),
        completed = watch_history.completed OR EXCLUDED.completed,
        lesson_stage = CASE
          WHEN (
            CASE watch_history.lesson_stage
              WHEN 'explanation' THEN 3
              WHEN 'exam' THEN 2
              WHEN 'video' THEN 1
              ELSE 0
            END
          ) >= (
            CASE EXCLUDED.lesson_stage
              WHEN 'explanation' THEN 3
              WHEN 'exam' THEN 2
              WHEN 'video' THEN 1
              ELSE 0
            END
          )
          THEN watch_history.lesson_stage
          ELSE EXCLUDED.lesson_stage
        END,
        exam_submitted = watch_history.exam_submitted OR EXCLUDED.exam_submitted,
        exam_selected_option = COALESCE(EXCLUDED.exam_selected_option, watch_history.exam_selected_option),
        explanation_seconds = GREATEST(watch_history.explanation_seconds, EXCLUDED.explanation_seconds),
        video_watch_count = GREATEST(watch_history.video_watch_count, EXCLUDED.video_watch_count),
        explanation_watch_count = GREATEST(watch_history.explanation_watch_count, EXCLUDED.explanation_watch_count),
        last_session_id = COALESCE(EXCLUDED.last_session_id, watch_history.last_session_id),
        last_device = COALESCE(EXCLUDED.last_device, watch_history.last_device),
        last_watched_at = EXCLUDED.last_watched_at,
        updated_at = CASE
          WHEN EXCLUDED.completed = TRUE
            OR EXCLUDED.progress_seconds >= watch_history.progress_seconds
            OR EXCLUDED.progress_percent >= watch_history.progress_percent
            OR EXCLUDED.explanation_seconds >= watch_history.explanation_seconds
            OR EXCLUDED.video_watch_count >= watch_history.video_watch_count
            OR EXCLUDED.explanation_watch_count >= watch_history.explanation_watch_count
            OR EXCLUDED.exam_submitted = TRUE
          THEN EXCLUDED.updated_at
          ELSE watch_history.updated_at
        END
      RETURNING *
    `,
    [
      record._id,
      record.userId,
      record.courseId,
      record.lessonId,
      record.progressPercent,
      record.progressSeconds,
      record.completed,
      record.lessonStage,
      record.examSubmitted,
      record.examSelectedOption,
      record.explanationSeconds,
      record.videoWatchCount,
      record.explanationWatchCount,
      record.lastSessionId,
      JSON.stringify(record.lastDevice),
      record.lastWatchedAt,
      record.updatedAt,
    ],
    mapWatchHistoryRow,
    client,
  );
  return saved || record;
};

const upsertPgVideoWatchState = async (payload, client = null) => {
  const stateRecord = normalizeVideoWatchState({
    _id: payload._id || createPersistentId('video_watch_state'),
    userId: payload.userId,
    courseId: payload.courseId,
    lessonId: payload.lessonId || null,
    videoId: payload.videoId,
    videoType: payload.videoType || COURSE_VIDEO_TYPE,
    videoDurationSeconds: payload.videoDurationSeconds,
    allowedFullWatches: payload.allowedFullWatches,
    completedFullWatches: payload.completedFullWatches,
    fullWatchThresholdPercentage: payload.fullWatchThresholdPercentage,
    watchedSegments: payload.watchedSegments,
    currentCycleUniqueWatchedSeconds: payload.currentCycleUniqueWatchedSeconds,
    totalUniqueWatchedSeconds: payload.totalUniqueWatchedSeconds,
    repeatWatchedSeconds: payload.repeatWatchedSeconds,
    revisionBufferSeconds: payload.revisionBufferSeconds,
    revisionBufferUsedSeconds: payload.revisionBufferUsedSeconds,
    stableEndWindowWatchedSeconds: payload.stableEndWindowWatchedSeconds,
    completionProofSatisfiedAt: payload.completionProofSatisfiedAt || null,
    lastPositionSeconds: payload.lastPositionSeconds,
    playbackSessionId: payload.playbackSessionId || null,
    activeSessionStatus: payload.activeSessionStatus || 'idle',
    deviceId: payload.deviceId || null,
    ipAddress: payload.ipAddress || null,
    userAgent: payload.userAgent || null,
    lastHeartbeatAt: payload.lastHeartbeatAt || null,
    isLocked: payload.isLocked,
    lockedAt: payload.lockedAt || null,
    createdAt: payload.createdAt || nowIso(),
    updatedAt: payload.updatedAt || nowIso(),
  }, {
    chunkSeconds: videoWatchChunkSeconds,
  });

  const saved = await pgOne(
    `
      INSERT INTO video_watch_states (
        id, user_id, course_id, lesson_id, video_id, video_type, video_duration_seconds,
        allowed_full_watches, completed_full_watches, full_watch_threshold_percentage,
        watched_segments, current_cycle_unique_watched_seconds, total_unique_watched_seconds,
        repeat_watched_seconds, revision_buffer_seconds, revision_buffer_used_seconds,
        stable_end_window_watched_seconds, completion_proof_satisfied_at,
        last_position_seconds, playback_session_id, active_session_status, device_id,
        ip_address, user_agent, last_heartbeat_at, is_locked, locked_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11::jsonb, $12, $13,
        $14, $15, $16,
        COALESCE($17, 0), $18,
        $19, $20, $21, $22,
        $23, $24, $25, $26, $27, $28, $29
      )
      ON CONFLICT (user_id, course_id, video_id, video_type) DO UPDATE SET
        lesson_id = EXCLUDED.lesson_id,
        video_duration_seconds = EXCLUDED.video_duration_seconds,
        allowed_full_watches = EXCLUDED.allowed_full_watches,
        completed_full_watches = EXCLUDED.completed_full_watches,
        full_watch_threshold_percentage = EXCLUDED.full_watch_threshold_percentage,
        watched_segments = EXCLUDED.watched_segments,
        current_cycle_unique_watched_seconds = EXCLUDED.current_cycle_unique_watched_seconds,
        total_unique_watched_seconds = EXCLUDED.total_unique_watched_seconds,
        repeat_watched_seconds = EXCLUDED.repeat_watched_seconds,
        revision_buffer_seconds = EXCLUDED.revision_buffer_seconds,
        revision_buffer_used_seconds = EXCLUDED.revision_buffer_used_seconds,
        stable_end_window_watched_seconds = EXCLUDED.stable_end_window_watched_seconds,
        completion_proof_satisfied_at = EXCLUDED.completion_proof_satisfied_at,
        last_position_seconds = EXCLUDED.last_position_seconds,
        playback_session_id = EXCLUDED.playback_session_id,
        active_session_status = EXCLUDED.active_session_status,
        device_id = EXCLUDED.device_id,
        ip_address = EXCLUDED.ip_address,
        user_agent = EXCLUDED.user_agent,
        last_heartbeat_at = EXCLUDED.last_heartbeat_at,
        is_locked = EXCLUDED.is_locked,
        locked_at = EXCLUDED.locked_at,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
    [
      stateRecord._id,
      stateRecord.userId,
      stateRecord.courseId,
      stateRecord.lessonId,
      stateRecord.videoId,
      stateRecord.videoType,
      stateRecord.videoDurationSeconds,
      stateRecord.allowedFullWatches,
      stateRecord.completedFullWatches,
      stateRecord.fullWatchThresholdPercentage,
      JSON.stringify(stateRecord.watchedSegments || []),
      stateRecord.currentCycleUniqueWatchedSeconds,
      stateRecord.totalUniqueWatchedSeconds,
      stateRecord.repeatWatchedSeconds,
      stateRecord.revisionBufferSeconds,
      stateRecord.revisionBufferUsedSeconds,
      stateRecord.stableEndWindowWatchedSeconds ?? 0,
      stateRecord.completionProofSatisfiedAt,
      stateRecord.lastPositionSeconds,
      stateRecord.playbackSessionId,
      stateRecord.activeSessionStatus,
      stateRecord.deviceId,
      stateRecord.ipAddress,
      stateRecord.userAgent,
      stateRecord.lastHeartbeatAt,
      stateRecord.isLocked,
      stateRecord.lockedAt,
      stateRecord.createdAt,
      stateRecord.updatedAt,
    ],
    mapVideoWatchStateRow,
    client,
  );

  return saved || stateRecord;
};

const insertPgLiveClass = async (payload, client = null) => {
  const liveClass = {
    _id: payload._id || createPersistentId('live_class'),
    linkageType: payload.linkageType || (payload.mockTestId ? 'mock-test' : payload.courseId ? 'course' : 'standalone'),
    courseId: payload.courseId || null,
    moduleId: payload.moduleId || null,
    moduleTitle: payload.moduleTitle || null,
    chapterId: payload.chapterId || null,
    chapterTitle: payload.chapterTitle || null,
    mockTestId: payload.mockTestId || null,
    mockTestTitle: payload.mockTestTitle || null,
    title: payload.title,
    instructor: payload.instructor || 'VARONENGLISH Faculty',
    startTime: payload.startTime || nowIso(),
    durationMinutes: Number(payload.durationMinutes || 60),
    provider: payload.provider || 'Jitsi Meet',
    mode: payload.mode || 'live',
    status: payload.status || 'scheduled',
    livePlaybackUrl: payload.livePlaybackUrl || null,
    livePlaybackType: payload.livePlaybackType || getDefaultLivePlaybackType(),
    embedUrl: payload.embedUrl || null,
    roomUrl: payload.roomUrl || null,
    recordingUrl: payload.recordingUrl || null,
    replayCourseId: payload.replayCourseId || null,
    replayLessonId: payload.replayLessonId || null,
    chatEnabled: payload.chatEnabled !== false,
    doubtSolving: payload.doubtSolving !== false,
    replayAvailable: payload.replayAvailable !== false,
    attendees: Number(payload.attendees || 0),
    maxAttendees: Number(payload.maxAttendees || 2500),
    requiresEnrollment: payload.requiresEnrollment !== false,
    recordingStorageProvider: payload.recordingStorageProvider || null,
    recordingStoragePath: payload.recordingStoragePath || null,
    recordingPublishedAt: payload.recordingPublishedAt || null,
    recordingExpiresAt: payload.recordingExpiresAt || null,
    recordingDurationMinutes: payload.recordingDurationMinutes === undefined ? null : Number(payload.recordingDurationMinutes || 0),
    posterUrl: payload.posterUrl || null,
    description: payload.description || null,
    teacherProfile: asObject(payload.teacherProfile),
    sessionNotes: asArray(payload.sessionNotes),
    resources: asArray(payload.resources),
    activePoll: payload.activePoll ? asObject(payload.activePoll) : null,
    topicTags: asArray(payload.topicTags),
  };

  await pgExec(
    `
      INSERT INTO live_classes (
        id, linkage_type, course_id, module_id, module_title, chapter_id, chapter_title, mock_test_id, mock_test_title, title, instructor_name, scheduled_start_at, duration_minutes, provider,
        mode, status, live_playback_url, live_playback_type, embed_url, room_url, recording_url,
        replay_course_id, replay_lesson_id, chat_enabled, doubt_solving, replay_available,
        attendee_count, max_attendees, requires_enrollment, recording_storage_provider, recording_storage_path,
        recording_published_at, recording_expires_at, recording_duration_minutes, poster_url, class_description,
        teacher_profile, session_notes, resource_items, active_poll, topic_tags
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26,
        $27, $28, $29, $30, $31,
        $32, $33, $34, $35, $36,
        $37::jsonb, $38::jsonb, $39::jsonb, $40::jsonb, $41::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        linkage_type = EXCLUDED.linkage_type,
        course_id = EXCLUDED.course_id,
        module_id = EXCLUDED.module_id,
        module_title = EXCLUDED.module_title,
        chapter_id = EXCLUDED.chapter_id,
        chapter_title = EXCLUDED.chapter_title,
        mock_test_id = EXCLUDED.mock_test_id,
        mock_test_title = EXCLUDED.mock_test_title,
        title = EXCLUDED.title,
        instructor_name = EXCLUDED.instructor_name,
        scheduled_start_at = EXCLUDED.scheduled_start_at,
        duration_minutes = EXCLUDED.duration_minutes,
        provider = EXCLUDED.provider,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        live_playback_url = EXCLUDED.live_playback_url,
        live_playback_type = EXCLUDED.live_playback_type,
        embed_url = EXCLUDED.embed_url,
        room_url = EXCLUDED.room_url,
        recording_url = EXCLUDED.recording_url,
        replay_course_id = EXCLUDED.replay_course_id,
        replay_lesson_id = EXCLUDED.replay_lesson_id,
        chat_enabled = EXCLUDED.chat_enabled,
        doubt_solving = EXCLUDED.doubt_solving,
        replay_available = EXCLUDED.replay_available,
        attendee_count = EXCLUDED.attendee_count,
        max_attendees = EXCLUDED.max_attendees,
        requires_enrollment = EXCLUDED.requires_enrollment,
        recording_storage_provider = EXCLUDED.recording_storage_provider,
        recording_storage_path = EXCLUDED.recording_storage_path,
        recording_published_at = EXCLUDED.recording_published_at,
        recording_expires_at = EXCLUDED.recording_expires_at,
        recording_duration_minutes = EXCLUDED.recording_duration_minutes,
        poster_url = EXCLUDED.poster_url,
        class_description = EXCLUDED.class_description,
        teacher_profile = EXCLUDED.teacher_profile,
        session_notes = EXCLUDED.session_notes,
        resource_items = EXCLUDED.resource_items,
        active_poll = EXCLUDED.active_poll,
        topic_tags = EXCLUDED.topic_tags
    `,
    [
      liveClass._id,
      liveClass.linkageType,
      liveClass.courseId,
      liveClass.moduleId,
      liveClass.moduleTitle,
      liveClass.chapterId,
      liveClass.chapterTitle,
      liveClass.mockTestId,
      liveClass.mockTestTitle,
      liveClass.title,
      liveClass.instructor,
      liveClass.startTime,
      liveClass.durationMinutes,
      liveClass.provider,
      liveClass.mode,
      liveClass.status,
      liveClass.livePlaybackUrl,
      liveClass.livePlaybackType,
      liveClass.embedUrl,
      liveClass.roomUrl,
      liveClass.recordingUrl,
      liveClass.replayCourseId,
      liveClass.replayLessonId,
      liveClass.chatEnabled,
      liveClass.doubtSolving,
      liveClass.replayAvailable,
      liveClass.attendees,
      liveClass.maxAttendees,
      liveClass.requiresEnrollment,
      liveClass.recordingStorageProvider,
      liveClass.recordingStoragePath,
      liveClass.recordingPublishedAt,
      liveClass.recordingExpiresAt,
      liveClass.recordingDurationMinutes,
      liveClass.posterUrl,
      liveClass.description,
      JSON.stringify(liveClass.teacherProfile || {}),
      JSON.stringify(liveClass.sessionNotes || []),
      JSON.stringify(liveClass.resources || []),
      JSON.stringify(liveClass.activePoll || null),
      JSON.stringify(liveClass.topicTags || []),
    ],
    client,
  );

  return liveClass;
};

const insertPgLiveChatMessage = async (payload, client = null) => {
  const message = {
    _id: payload._id || createPersistentId('live_chat'),
    liveClassId: String(payload.liveClassId),
    userId: String(payload.userId),
    userName: payload.userName,
    kind: payload.kind === 'doubt' ? 'doubt' : 'chat',
    message: String(payload.message || ''),
    createdAt: payload.createdAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO live_chat_messages (id, live_class_id, user_id, user_name, kind, message, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      message._id,
      message.liveClassId,
      message.userId,
      message.userName,
      message.kind,
      message.message,
      message.createdAt,
    ],
    client,
  );

  return message;
};

const upsertPgSubscriptionPlan = async (payload, client = null) => {
  const plan = {
    _id: payload._id || createPersistentId('plan'),
    title: payload.title,
    description: payload.description || '',
    price: Number(payload.price || 0),
    billingCycle: payload.billingCycle || 'monthly',
    accessType: payload.accessType || 'subscription',
    features: asArray(payload.features),
    createdAt: payload.createdAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO subscription_plans (
        id, title, description, price_inr, billing_cycle, access_type, feature_list, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        price_inr = EXCLUDED.price_inr,
        billing_cycle = EXCLUDED.billing_cycle,
        access_type = EXCLUDED.access_type,
        feature_list = EXCLUDED.feature_list
    `,
    [
      plan._id,
      plan.title,
      plan.description,
      plan.price,
      plan.billingCycle,
      plan.accessType,
      JSON.stringify(plan.features || []),
      plan.createdAt,
    ],
    client,
  );

  return plan;
};

const insertPgSubscription = async (payload, client = null) => {
  const subscription = {
    _id: payload._id || createPersistentId('subscription'),
    userId: String(payload.userId),
    planId: String(payload.planId),
    status: payload.status || 'active',
    source: payload.source || 'payment',
    startedAt: payload.startedAt || nowIso(),
    expiresAt: payload.expiresAt || null,
  };

  await pgExec(
    `
      INSERT INTO subscriptions (id, user_id, plan_id, status, source, started_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        started_at = EXCLUDED.started_at,
        expires_at = EXCLUDED.expires_at
    `,
    [
      subscription._id,
      subscription.userId,
      subscription.planId,
      subscription.status,
      subscription.source,
      subscription.startedAt,
      subscription.expiresAt,
    ],
    client,
  );

  return subscription;
};

const insertPgTestAttempt = async (payload, client = null) => {
  const attempt = {
    _id: payload._id || createPersistentId('attempt'),
    userId: String(payload.userId),
    testId: String(payload.testId),
    score: Number(payload.score || 0),
    totalMarks: Number(payload.totalMarks || 0),
    correctCount: Number(payload.correctCount || 0),
    incorrectCount: Number(payload.incorrectCount || 0),
    unattemptedCount: Number(payload.unattemptedCount || 0),
    percentile: Number(payload.percentile || 0),
    rank: Number(payload.rank || 0),
    answers: asObject(payload.answers),
    weakTopics: asArray(payload.weakTopics),
    strongTopics: asArray(payload.strongTopics),
    solutions: asArray(payload.solutions),
    startedAt: payload.startedAt || nowIso(),
    completedAt: payload.completedAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO test_attempts (
        id, user_id, test_id, score, total_marks, correct_count, incorrect_count, unattempted_count,
        percentile, all_india_rank, answers, weak_topics, strong_topics, solutions, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16)
    `,
    [
      attempt._id,
      attempt.userId,
      attempt.testId,
      attempt.score,
      attempt.totalMarks,
      attempt.correctCount,
      attempt.incorrectCount,
      attempt.unattemptedCount,
      attempt.percentile,
      attempt.rank,
      JSON.stringify(attempt.answers || {}),
      JSON.stringify(attempt.weakTopics || []),
      JSON.stringify(attempt.strongTopics || []),
      JSON.stringify(attempt.solutions || []),
      attempt.startedAt,
      attempt.completedAt,
    ],
    client,
  );

  return attempt;
};

const upsertPgQuizAttempt = async (payload, client = null) => {
  const existing = await pgOne(
    'SELECT * FROM daily_quiz_attempts WHERE user_id = $1 AND daily_quiz_id = $2',
    [String(payload.userId), String(payload.quizId)],
    mapQuizAttemptRow,
    client,
  );

  const attempt = {
    _id: existing?._id || payload._id || createPersistentId('quiz_attempt'),
    userId: String(payload.userId),
    quizId: String(payload.quizId),
    score: Number(payload.score || 0),
    total: Number(payload.total || 0),
    submittedAt: payload.submittedAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO daily_quiz_attempts (id, user_id, daily_quiz_id, score, total, submitted_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, daily_quiz_id) DO UPDATE SET
        score = EXCLUDED.score,
        total = EXCLUDED.total,
        submitted_at = EXCLUDED.submitted_at
    `,
    [attempt._id, attempt.userId, attempt.quizId, attempt.score, attempt.total, attempt.submittedAt],
    client,
  );

  await deleteRedisKey(cacheKey('quiz-leaderboard', attempt.quizId));
  await deleteRedisKey(cacheKey('quiz-weekly', 'all'));
  return { attempt, existing };
};

const insertPgReferral = async (payload, client = null) => {
  const referral = {
    _id: payload._id || createPersistentId('referral'),
    referrerUserId: String(payload.referrerUserId),
    referredEmail: normalizeEmail(payload.referredEmail),
    rewardPoints: Number(payload.rewardPoints || 25),
    createdAt: payload.createdAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO referrals (id, referrer_user_id, referred_email, reward_points, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [referral._id, referral.referrerUserId, referral.referredEmail, referral.rewardPoints, referral.createdAt],
    client,
  );

  return referral;
};

const insertPgPayment = async (payload, client = null) => {
  const payment = {
    _id: payload._id || createPersistentId('payment'),
    userId: String(payload.userId || ''),
    amount: Number(payload.amount || 0),
    currency: payload.currency || 'INR',
    provider: payload.provider || 'internal',
    providerOrderId: payload.providerOrderId || null,
    providerPaymentId: payload.providerPaymentId || null,
    providerSignature: payload.providerSignature || null,
    courseId: payload.courseId || null,
    receipt: payload.receipt || null,
    item: payload.item || 'Course Purchase',
    status: payload.status || 'pending',
    attemptCount: Number(payload.attemptCount || 1),
    retryable: payload.retryable !== false,
    lastError: payload.lastError || null,
    meta: asObject(payload.meta),
    paidAt: payload.paidAt || null,
    createdAt: payload.createdAt || nowIso(),
    updatedAt: payload.updatedAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO payments (
        id, user_id, amount_inr, currency, provider, provider_order_id, provider_payment_id,
        provider_signature, course_id, receipt, item, status, attempt_count, retryable,
        last_error, payment_meta, paid_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19)
      ON CONFLICT (id) DO UPDATE SET
        amount_inr = EXCLUDED.amount_inr,
        currency = EXCLUDED.currency,
        provider = EXCLUDED.provider,
        provider_order_id = EXCLUDED.provider_order_id,
        provider_payment_id = EXCLUDED.provider_payment_id,
        provider_signature = EXCLUDED.provider_signature,
        course_id = EXCLUDED.course_id,
        receipt = EXCLUDED.receipt,
        item = EXCLUDED.item,
        status = EXCLUDED.status,
        attempt_count = EXCLUDED.attempt_count,
        retryable = EXCLUDED.retryable,
        last_error = EXCLUDED.last_error,
        payment_meta = EXCLUDED.payment_meta,
        paid_at = EXCLUDED.paid_at,
        updated_at = EXCLUDED.updated_at
    `,
    [
      payment._id,
      payment.userId,
      payment.amount,
      payment.currency,
      payment.provider,
      payment.providerOrderId,
      payment.providerPaymentId,
      payment.providerSignature,
      payment.courseId,
      payment.receipt,
      payment.item,
      payment.status,
      payment.attemptCount,
      payment.retryable,
      payment.lastError,
      JSON.stringify(payment.meta),
      payment.paidAt,
      payment.createdAt,
      payment.updatedAt,
    ],
    client,
  );

  return payment;
};

const insertPgWebhook = async (payload, client = null) => {
  const webhook = {
    _id: payload._id || createPersistentId('webhook'),
    event: payload.event || 'payment.updated',
    paymentId: payload.paymentId || null,
    status: payload.status || 'received',
    receivedAt: payload.receivedAt || nowIso(),
    payload: asObject(payload.payload ?? payload),
  };

  await pgExec(
    `
      INSERT INTO payment_webhooks (id, event, payment_id, status, received_at, payload)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [webhook._id, webhook.event, webhook.paymentId, webhook.status, webhook.receivedAt, JSON.stringify(webhook.payload)],
    client,
  );

  return webhook;
};

const insertAdminAuditLogEntry = async (payload, client = null) => {
  const entry = {
    _id: payload._id || createPersistentId('audit'),
    adminUserId: String(payload.adminUserId || 'system'),
    actionType: String(payload.actionType || 'payment_reconciled'),
    targetUserId: payload.targetUserId ? String(payload.targetUserId) : null,
    courseId: payload.courseId ? String(payload.courseId) : null,
    transactionId: payload.transactionId ? String(payload.transactionId) : null,
    oldValue: asObject(payload.oldValue),
    newValue: asObject(payload.newValue),
    reason: payload.reason ? String(payload.reason) : null,
    ipAddress: payload.ipAddress || null,
    userAgent: payload.userAgent || null,
    createdAt: payload.createdAt || nowIso(),
  };

  if (isPostgresMode()) {
    await pgExec(
      `
        INSERT INTO admin_audit_logs (
          id, admin_user_id, action_type, target_user_id, course_id, transaction_id,
          old_value, new_value, reason, ip_address, user_agent, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
      `,
      [
        entry._id,
        entry.adminUserId,
        entry.actionType,
        entry.targetUserId,
        entry.courseId,
        entry.transactionId,
        JSON.stringify(entry.oldValue),
        JSON.stringify(entry.newValue),
        entry.reason,
        entry.ipAddress,
        entry.userAgent,
        entry.createdAt,
      ],
      client,
    );
    return entry;
  }

  state.adminAuditLogs.unshift({
    _id: entry._id,
    adminUserId: entry.adminUserId,
    actionType: entry.actionType,
    targetUserId: entry.targetUserId,
    courseId: entry.courseId,
    transactionId: entry.transactionId,
    oldValue: clone(entry.oldValue),
    newValue: clone(entry.newValue),
    reason: entry.reason,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt,
  });
  state.adminAuditLogs = state.adminAuditLogs.slice(0, 5000);
  return entry;
};

const toUnixTimestampIso = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000).toISOString() : null;
};

const mapRazorpayStatusToLocalPaymentStatus = (status) => {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'captured') return 'paid';
  if (normalized === 'refunded') return 'refunded';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'authorized') return 'pending';
  return 'pending';
};

const getRazorpayAcquirerReference = (remotePayment) => {
  const acquirerData = asObject(remotePayment?.acquirer_data);
  return String(
    acquirerData.rrn
    || acquirerData.upi_transaction_id
    || acquirerData.reference16
    || acquirerData.reference1
    || '',
  ).trim() || null;
};

const normalizeRazorpayVerificationDecision = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || 'MANUAL_REVIEW_REQUIRED';
};

const isRazorpayVerificationActivated = (decision) =>
  normalizeRazorpayVerificationDecision(decision) === 'VERIFIED_CAPTURED_ACTIVATED';

const getRazorpayVerificationPresentation = (decision) => {
  switch (normalizeRazorpayVerificationDecision(decision)) {
    case 'VERIFIED_CAPTURED_ACTIVATED':
      return {
        paymentStatus: 'success',
        label: 'Continue Learning',
        reason: 'Payment verified and access activated.',
        manualReviewRequired: false,
      };
    case 'GATEWAY_PENDING':
      return {
        paymentStatus: 'pending',
        label: 'Payment Pending',
        reason: 'Payment is still pending at Razorpay.',
        manualReviewRequired: false,
      };
    case 'GATEWAY_FAILED':
      return {
        paymentStatus: 'failed',
        label: 'Payment Failed',
        reason: 'Razorpay marked this payment as failed.',
        manualReviewRequired: false,
      };
    case 'REFUNDED_OR_CHARGEBACK':
      return {
        paymentStatus: 'refunded',
        label: 'Contact Support',
        reason: 'Payment was refunded, disputed, or charged back.',
        manualReviewRequired: true,
      };
    case 'AMOUNT_MISMATCH':
      return {
        paymentStatus: 'pending',
        label: 'Payment Under Verification',
        reason: 'Received amount does not match the expected course amount.',
        manualReviewRequired: true,
      };
    case 'ORDER_MISMATCH':
      return {
        paymentStatus: 'pending',
        label: 'Payment Under Verification',
        reason: 'Gateway payment does not belong to the expected Razorpay order.',
        manualReviewRequired: true,
      };
    case 'USER_MISMATCH':
      return {
        paymentStatus: 'pending',
        label: 'Contact Support',
        reason: 'Gateway payment details do not safely match the expected student.',
        manualReviewRequired: true,
      };
    case 'COURSE_MISMATCH':
      return {
        paymentStatus: 'pending',
        label: 'Contact Support',
        reason: 'Gateway payment details do not safely match the expected course.',
        manualReviewRequired: true,
      };
    case 'LOCAL_TRANSACTION_NOT_FOUND':
      return {
        paymentStatus: 'pending',
        label: 'Payment Under Verification',
        reason: 'No safe local transaction could be matched to this gateway payment.',
        manualReviewRequired: true,
      };
    default:
      return {
        paymentStatus: 'pending',
        label: 'Payment Under Verification',
        reason: 'Manual review is required before access can be activated.',
        manualReviewRequired: true,
      };
  }
};

const selectBestRazorpayPayment = (payments, providerPaymentId = '') => {
  const normalizedProviderPaymentId = String(providerPaymentId || '').trim();
  const items = Array.isArray(payments) ? payments.filter(Boolean) : [];
  if (normalizedProviderPaymentId) {
    const exactMatch = items.find((entry) => String(entry.id || '').trim() === normalizedProviderPaymentId);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const captured = items
    .filter((entry) => String(entry.status || '').toLowerCase() === 'captured')
    .sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0));
  if (captured[0]) {
    return captured[0];
  }

  const authorized = items
    .filter((entry) => String(entry.status || '').toLowerCase() === 'authorized')
    .sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0));
  if (authorized[0]) {
    return authorized[0];
  }

  return items.sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0))[0] || null;
};

const buildRazorpayPaymentMeta = ({ payment, remotePayment, previousMeta = {}, syncSource = 'system' }) => {
  const method = String(remotePayment?.method || '').trim() || null;
  const gatewayStatus = String(remotePayment?.status || '').trim().toLowerCase() || null;
  const gatewayCapturedAt = toUnixTimestampIso(remotePayment?.captured_at || remotePayment?.created_at);
  const paymentMeta = {
    ...asObject(previousMeta),
    gatewayStatus,
    razorpayGatewayStatus: gatewayStatus,
    paymentMethod: method,
    bankRrn: getRazorpayAcquirerReference(remotePayment),
    gatewayReference: getRazorpayAcquirerReference(remotePayment),
    gatewayEmail: remotePayment?.email || null,
    gatewayContact: remotePayment?.contact || null,
    gatewayBank: remotePayment?.bank || null,
    gatewayVpa: remotePayment?.vpa || remotePayment?.upi?.vpa || null,
    gatewayCaptured: Boolean(remotePayment?.captured),
    gatewayCapturedAt,
    gatewayCreatedAt: toUnixTimestampIso(remotePayment?.created_at),
    razorpayOrderId: String(remotePayment?.order_id || payment?.providerOrderId || '').trim() || null,
    razorpayPaymentId: String(remotePayment?.id || payment?.providerPaymentId || '').trim() || null,
    razorpaySignature: payment?.providerSignature || previousMeta?.razorpaySignature || null,
    gatewayWebhookReceivedAt: previousMeta?.gatewayWebhookReceivedAt || null,
    syncedFrom: syncSource,
    syncCheckedAt: nowIso(),
  };

  if (payment?.courseId) {
    paymentMeta.courseId = payment.courseId;
  }
  if (payment?.userId) {
    paymentMeta.userId = payment.userId;
  }

  return paymentMeta;
};

const buildRazorpayVerificationMeta = ({
  payment,
  course = null,
  user = null,
  remoteOrder = null,
  remotePayment = null,
  previousMeta = {},
  syncSource = 'system',
  verificationDecision = 'MANUAL_REVIEW_REQUIRED',
  verificationReason = '',
  verificationNotes = [],
  callbackSignatureVerified = false,
  webhookSignatureVerified = false,
}) => {
  const normalizedDecision = normalizeRazorpayVerificationDecision(verificationDecision);
  const expectedAmountPaise = course ? getCoursePayableAmountPaise(course) : Number(previousMeta.expectedAmountPaise || 0);
  const receivedAmountPaise = Number(remotePayment?.amount || 0) || Number(previousMeta.receivedAmountPaise || 0);
  const currency = String(remotePayment?.currency || remoteOrder?.currency || payment?.currency || previousMeta.currency || 'INR').trim().toUpperCase() || 'INR';
  const remoteOrderNotes = asObject(remoteOrder?.notes);
  const remotePaymentNotes = asObject(remotePayment?.notes);
  const presentation = getRazorpayVerificationPresentation(normalizedDecision);

  return {
    ...buildRazorpayPaymentMeta({
      payment,
      remotePayment: remotePayment || {
        id: payment?.providerPaymentId || null,
        order_id: payment?.providerOrderId || null,
        status: previousMeta.gatewayStatus || null,
      },
      previousMeta,
      syncSource,
    }),
    verificationStatus: normalizedDecision,
    verificationDecision: normalizedDecision,
    verificationReason: verificationReason || presentation.reason,
    verificationNotes: Array.isArray(verificationNotes) ? verificationNotes.filter(Boolean) : [],
    manualReviewRequired: Boolean(presentation.manualReviewRequired),
    callbackSignatureVerified: Boolean(callbackSignatureVerified || previousMeta.callbackSignatureVerified),
    webhookSignatureVerified: Boolean(webhookSignatureVerified || previousMeta.webhookSignatureVerified),
    signatureVerified: Boolean(
      callbackSignatureVerified
      || webhookSignatureVerified
      || previousMeta.signatureVerified
      || payment?.providerSignature,
    ),
    expectedAmountPaise,
    expectedAmount: expectedAmountPaise > 0 ? Number((expectedAmountPaise / 100).toFixed(2)) : null,
    receivedAmountPaise,
    receivedAmount: receivedAmountPaise > 0 ? Number((receivedAmountPaise / 100).toFixed(2)) : null,
    currency,
    refundStatus: remotePayment?.refund_status || previousMeta.refundStatus || null,
    amountRefundedPaise: Number(remotePayment?.amount_refunded || 0) || Number(previousMeta.amountRefundedPaise || 0),
    amountRefunded: Number(remotePayment?.amount_refunded || 0) > 0
      ? Number((Number(remotePayment.amount_refunded) / 100).toFixed(2))
      : (previousMeta.amountRefunded || 0),
    disputeStatus: remotePayment?.disputed ? 'disputed' : (previousMeta.disputeStatus || null),
    suspiciousPayment: Boolean(remotePayment?.disputed || previousMeta.suspiciousPayment),
    remoteOrderStatus: String(remoteOrder?.status || previousMeta.remoteOrderStatus || '').trim().toLowerCase() || null,
    remoteOrderNotes,
    remotePaymentNotes,
    localTransactionId: payment?._id || previousMeta.localTransactionId || null,
    localUserId: payment?.userId || previousMeta.localUserId || null,
    localCourseId: payment?.courseId || previousMeta.localCourseId || null,
    localUserEmail: user?.email || previousMeta.localUserEmail || null,
    localUserMobile: user?.mobileNumber || previousMeta.localUserMobile || null,
    localCourseTitle: course?.title || previousMeta.localCourseTitle || null,
    lastSyncedAt: nowIso(),
  };
};

const insertPgUpload = async (payload, client = null) => {
  const upload = {
    _id: payload._id || createPersistentId('upload'),
    title: payload.title || 'Bulk Upload',
    course: payload.course || null,
    questionCount: Array.isArray(payload.questions) ? payload.questions.length : Number(payload.questionCount || 0),
    createdAt: payload.createdAt || nowIso(),
  };

  await pgExec(
    `
      INSERT INTO admin_uploads (id, title, course_id, question_count, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [upload._id, upload.title, upload.course, upload.questionCount, upload.createdAt],
    client,
  );

  return upload;
};

const insertPgAiMessage = async (payload, client = null) => {
  const message = {
    _id: payload._id || createPersistentId('ai_message'),
    userId: String(payload.userId),
    message: String(payload.message || ''),
    answer: String(payload.answer || ''),
    createdAt: payload.createdAt || nowIso(),
  };

  await pgExec(
    'INSERT INTO ai_messages (id, user_id, message, answer, created_at) VALUES ($1, $2, $3, $4, $5)',
    [message._id, message.userId, message.message, message.answer, message.createdAt],
    client,
  );

  return message;
};

const insertPgSession = async (payload, client = null) => {
  const session = {
    _id: payload._id || createPersistentId('session'),
    userId: String(payload.userId),
    sessionId: String(payload.sessionId),
    device: payload.device || null,
    status: payload.status || 'active',
    reason: payload.reason || null,
    createdAt: payload.createdAt || nowIso(),
    lastSeenAt: payload.lastSeenAt || nowIso(),
    endedAt: payload.endedAt || (payload.status === 'active' ? null : nowIso()),
  };

  await pgExec(
    `
      INSERT INTO user_sessions (
        id, user_id, jwt_session_id, device, status, reason, created_at, last_seen_at, ended_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
    `,
    [
      session._id,
      session.userId,
      session.sessionId,
      JSON.stringify(session.device),
      session.status,
      session.reason,
      session.createdAt,
      session.lastSeenAt,
      session.endedAt,
    ],
    client,
  );

  return session;
};

const closePgSession = async ({ userId, sessionId, reason = 'logout' }, client = null) => {
  const updated = await pgOne(
    `
      UPDATE user_sessions
      SET status = 'ended', reason = $3, ended_at = now(), last_seen_at = now()
      WHERE user_id = $1 AND jwt_session_id = $2 AND status = 'active'
      RETURNING *
    `,
    [String(userId), String(sessionId), reason],
    mapSessionRow,
    client,
  );

  return updated;
};

const insertPgDeviceActivity = async ({ userId, sessionId = null, device = null, eventType, meta = {} }, client = null) => {
  if (!userId || !eventType) {
    return null;
  }

  const activity = {
    _id: createPersistentId('activity'),
    userId: String(userId),
    sessionId: sessionId ? String(sessionId) : null,
    device: device || null,
    eventType: String(eventType),
    meta: asObject(meta),
    createdAt: nowIso(),
  };

  await pgExec(
    `
      INSERT INTO device_activity (id, user_id, session_id, device, event_type, event_meta, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7)
    `,
    [
      activity._id,
      activity.userId,
      activity.sessionId,
      JSON.stringify(activity.device),
      activity.eventType,
      JSON.stringify(activity.meta),
      activity.createdAt,
    ],
    client,
  );

  return activity;
};

const queueBestEffortDeviceActivity = ({ userId, sessionId = null, device = null, eventType, meta = {} }) => {
  if (!userId || !eventType) {
    return;
  }

  if (isPostgresMode()) {
    setImmediate(() => {
      void insertPgDeviceActivity({ userId, sessionId, device, eventType, meta }).catch(() => undefined);
    });
    return;
  }

  const user = state.users.find((item) => item._id === String(userId));
  if (!user) {
    return;
  }

  state.deviceActivities.unshift({
    _id: nextId('activity'),
    userId: user._id,
    sessionId: sessionId || user.session || null,
    device: device || user.device || null,
    eventType: String(eventType),
    meta: asObject(meta),
    createdAt: nowIso(),
  });
  state.deviceActivities = state.deviceActivities.slice(0, 200);
};

const buildVideoWatchStateRecordIdentity = ({ userId, courseId, videoId, videoType }) => ({
  userId: String(userId),
  courseId: String(courseId),
  videoId: String(videoId),
  videoType: normalizeVideoType(videoType),
});

const buildActivePlaybackSessionKey = (userId) => cacheKey('video-playback-active', String(userId));

const getPlaybackSessionAgeSeconds = (session) => {
  if (!session) {
    return null;
  }

  const lastActivityMs = Number(new Date(session.lastHeartbeatAt || session.updatedAt || session.issuedAt || 0).getTime() || 0);
  if (!lastActivityMs) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - lastActivityMs) / 1000));
};

const isFreshActivePlaybackSession = (session) => {
  const ageSeconds = getPlaybackSessionAgeSeconds(session);
  if (ageSeconds === null) {
    return false;
  }

  return ageSeconds <= videoPlaybackReconnectGraceSeconds;
};

const buildPlaybackDeviceMeta = ({
  requestContext = null,
  userAgent = null,
  ipAddress = null,
}) => ({
  id: requestContext?.deviceId || null,
  platform: requestContext?.platform || null,
  browser: requestContext?.browser || null,
  app: requestContext?.appMode || null,
  userAgent: userAgent || requestContext?.userAgent || null,
  ipAddress: ipAddress || null,
});

const matchesPlaybackClientContext = ({
  activeSession,
  authSessionId = null,
  requestContext = null,
}) => {
  if (!activeSession || !requestContext) {
    return false;
  }

  const nextTabId = String(requestContext.playbackTabId || '').trim();
  const nextDeviceId = String(requestContext.deviceId || '').trim();
  const nextUserAgentHash = String(requestContext.userAgentHash || '').trim();
  const activeTabId = String(activeSession.clientSessionId || '').trim();
  const activeDeviceId = String(activeSession.deviceId || '').trim();
  const activeUserAgentHash = String(activeSession.userAgentHash || '').trim();
  const authMatches = !authSessionId || String(activeSession.authSessionId || '') === String(authSessionId || '');

  if (nextTabId && activeTabId && nextTabId === activeTabId) {
    return true;
  }

  if (nextDeviceId && activeDeviceId && nextDeviceId === activeDeviceId) {
    if (!nextTabId || !activeTabId) {
      return true;
    }

    if (authMatches && (!nextUserAgentHash || !activeUserAgentHash || nextUserAgentHash === activeUserAgentHash)) {
      return true;
    }
  }

  return false;
};

const describePlaybackSessionDecision = ({
  activeSession,
  authSessionId = null,
  requestContext = null,
  courseId = null,
  lessonId = null,
  videoId = null,
  videoType = null,
}) => {
  if (!activeSession) {
    return {
      decision: 'allow',
      reason: 'no_existing_active_session',
      existingAgeSeconds: null,
      isStale: false,
      isSameVideo: false,
      replaceExisting: false,
      reuseExistingSession: false,
    };
  }

  const existingAgeSeconds = getPlaybackSessionAgeSeconds(activeSession);
  const nextTabId = String(requestContext?.playbackTabId || '').trim();
  const nextDeviceId = String(requestContext?.deviceId || '').trim();
  const nextUserAgentHash = String(requestContext?.userAgentHash || '').trim();
  const activeTabId = String(activeSession.clientSessionId || '').trim();
  const activeDeviceId = String(activeSession.deviceId || '').trim();
  const activeUserAgentHash = String(activeSession.userAgentHash || '').trim();
  const authMatches = !authSessionId || String(activeSession.authSessionId || '') === String(authSessionId || '');
  const sameVideoByAuthSession = Boolean(
    authMatches
    && String(activeSession.videoId || '') === String(videoId || '')
    && normalizeVideoType(activeSession.videoType) === normalizeVideoType(videoType)
    && String(activeSession.courseId || '') === String(courseId || ''),
  );
  const missingDeviceIdentity = !nextDeviceId || !activeDeviceId;
  const matchingUserAgentIdentity = Boolean(
    authMatches
    && nextUserAgentHash
    && activeUserAgentHash
    && nextUserAgentHash === activeUserAgentHash,
  );
  const sameTrustedDeviceSession = Boolean(
    nextDeviceId
    && activeDeviceId
    && nextDeviceId === activeDeviceId
    && authMatches
    && (!nextUserAgentHash || !activeUserAgentHash || nextUserAgentHash === activeUserAgentHash),
  );
  const sameClient = matchesPlaybackClientContext({ activeSession, authSessionId, requestContext });
  const sameVideo = sameClient && sameVideoByAuthSession;
  const sameDeviceReconnect = Boolean(
    sameVideoByAuthSession
    && sameTrustedDeviceSession
    && (
      !nextTabId
      || !activeTabId
      || nextTabId !== activeTabId
      || String(activeSession.status || '').trim().toLowerCase() !== 'active'
    )
  );

  if (!isFreshActivePlaybackSession(activeSession)) {
    return {
      decision: 'expire',
      reason: 'reconnect_grace_expired',
      existingAgeSeconds,
      isStale: true,
      isSameVideo: false,
      replaceExisting: false,
      reuseExistingSession: false,
    };
  }

  if (sameVideo) {
    return {
      decision: 'allow',
      reason: sameDeviceReconnect
        ? 'same_device_same_video_reconnect_allowed'
        : 'same_tab_same_video_retry_allowed',
      existingAgeSeconds,
      isStale: false,
      isSameVideo: true,
      replaceExisting: false,
      reuseExistingSession: true,
    };
  }

  if (sameVideoByAuthSession && missingDeviceIdentity && matchingUserAgentIdentity) {
    return {
      decision: 'allow',
      reason: 'same_auth_same_video_missing_device_identity_allowed',
      existingAgeSeconds,
      isStale: false,
      isSameVideo: true,
      replaceExisting: false,
      reuseExistingSession: true,
    };
  }

  if (sameClient) {
    return {
      decision: 'replace',
      reason: sameTrustedDeviceSession ? 'same_device_session_lesson_switch_replaced' : 'same_tab_lesson_switch_replaced',
      existingAgeSeconds,
      isStale: false,
      isSameVideo: false,
      replaceExisting: true,
      reuseExistingSession: false,
    };
  }

  if (nextDeviceId && activeDeviceId && nextDeviceId !== activeDeviceId) {
    return {
      decision: 'reject_409',
      reason: 'real_different_device_active',
      existingAgeSeconds,
      isStale: false,
      isSameVideo: false,
      replaceExisting: false,
      reuseExistingSession: false,
    };
  }

  if (nextTabId && activeTabId && nextTabId !== activeTabId && !sameTrustedDeviceSession) {
    return {
      decision: 'reject_409',
      reason: 'real_different_tab_active',
      existingAgeSeconds,
      isStale: false,
      isSameVideo: false,
      replaceExisting: false,
      reuseExistingSession: false,
    };
  }

  if (nextDeviceId && activeDeviceId && nextDeviceId === activeDeviceId) {
    if (!nextTabId || !activeTabId || !authMatches || (nextUserAgentHash && activeUserAgentHash && nextUserAgentHash === activeUserAgentHash)) {
      return {
        decision: 'replace',
        reason: sameTrustedDeviceSession ? 'same_device_same_auth_allowed' : 'missing_tab_same_device_allowed',
        existingAgeSeconds,
        isStale: false,
        isSameVideo: false,
        replaceExisting: true,
        reuseExistingSession: false,
      };
    }
  }

  if (!nextDeviceId || !activeDeviceId) {
    return {
      decision: 'replace',
      reason: 'invalid_or_missing_device_id',
      existingAgeSeconds,
      isStale: false,
      isSameVideo: false,
      replaceExisting: true,
      reuseExistingSession: false,
    };
  }

  return {
    decision: 'reject_409',
    reason: 'unknown_conflict',
    existingAgeSeconds,
    isStale: false,
    isSameVideo: false,
    replaceExisting: false,
    reuseExistingSession: false,
  };
};

const logPlaybackSessionDecision = ({
  userId,
  courseId,
  lessonId = null,
  videoId,
  authSessionId = null,
  requestContext = null,
  activeSession,
  playbackSessionId = null,
  decision,
  reason,
  playbackUrlGenerated = false,
}) => {
  const payload = JSON.stringify({
    user_id: userId ? String(userId) : null,
    current_course_id: courseId ? String(courseId) : null,
    current_lesson_id: lessonId ? String(lessonId) : null,
    current_video_id: videoId ? String(videoId) : null,
    current_device_id: requestContext?.deviceId || null,
    current_browser_tab_id: requestContext?.playbackTabId || null,
    current_browser_tab_id_missing: !String(requestContext?.playbackTabId || '').trim(),
    current_auth_session_id: authSessionId || null,
    current_playback_session_id: playbackSessionId || null,
    request_source: requestContext?.appMode || requestContext?.browser || 'unknown',
    existing_active_session_id: activeSession?.playbackSessionId || null,
    existing_video_id: activeSession?.videoId || null,
    existing_lesson_id: activeSession?.lessonId || null,
    existing_device_id: activeSession?.deviceId || null,
    existing_browser_tab_id: activeSession?.clientSessionId || null,
    existing_auth_session_id: activeSession?.authSessionId || null,
    existing_last_heartbeat_at: activeSession?.lastHeartbeatAt || null,
    existing_age_seconds: getPlaybackSessionAgeSeconds(activeSession),
    stale_timeout_seconds: videoPlaybackSessionTtlSeconds,
    reconnect_grace_seconds: videoPlaybackReconnectGraceSeconds,
    conflict_reason: reason,
    decision,
    playback_url_generated: Boolean(playbackUrlGenerated),
  });
  const level = decision === 'reject_409' ? 'warn' : 'info';
  console[level](`[video-playback-session] ${payload}`);
};

const findMemoryVideoWatchState = ({ userId, courseId, videoId, videoType }) =>
  state.videoWatchStates.find((entry) =>
    entry.userId === String(userId)
    && entry.courseId === String(courseId)
    && entry.videoId === String(videoId)
    && normalizeVideoType(entry.videoType) === normalizeVideoType(videoType)
  ) || null;

const upsertMemoryVideoWatchState = (payload) => {
  const normalized = normalizeVideoWatchState({
    ...payload,
    updatedAt: payload.updatedAt || nowIso(),
    createdAt: payload.createdAt || nowIso(),
  }, {
    chunkSeconds: videoWatchChunkSeconds,
  });
  const existingIndex = state.videoWatchStates.findIndex((entry) =>
    entry.userId === String(normalized.userId)
    && entry.courseId === String(normalized.courseId)
    && entry.videoId === String(normalized.videoId)
    && normalizeVideoType(entry.videoType) === normalizeVideoType(normalized.videoType)
  );

  if (existingIndex >= 0) {
    state.videoWatchStates[existingIndex] = normalized;
  } else {
    state.videoWatchStates.push(normalized);
  }

  return clone(normalized);
};

const videoPlaybackRepository = {
  async getWatchState({
    userId,
    courseId,
    lessonId = null,
    videoId,
    videoType = COURSE_VIDEO_TYPE,
    videoDurationSeconds = 0,
  }, client = null) {
    const identity = buildVideoWatchStateRecordIdentity({ userId, courseId, videoId, videoType });
    let effectiveWatchSettings = null;
    if (lessonId && courseId && userId) {
      const course = await coursesRepository.findById(courseId).catch(() => null);
      const lesson = course ? findLessonInCourse(course, lessonId) : null;
      effectiveWatchSettings = await resolveEffectiveLessonWatchSettings({
        userId,
        courseId,
        lessonId,
        lesson,
      });
    }
    const normalizeStateWithEffectivePolicy = (stateRecord) => normalizeVideoWatchState(stateRecord, {
      chunkSeconds: videoWatchChunkSeconds,
      allowedFullWatches: effectiveWatchSettings?.allowedFullWatches,
      fullWatchThresholdPercentage: effectiveWatchSettings?.watchCompletionPercent,
    });

    if (isPostgresMode()) {
      const existing = await pgOne(
        `
          SELECT * FROM video_watch_states
          WHERE user_id = $1 AND course_id = $2 AND video_id = $3 AND video_type = $4
        `,
        [identity.userId, identity.courseId, identity.videoId, identity.videoType],
        mapVideoWatchStateRow,
        client,
      );
      if (existing) {
        return normalizeStateWithEffectivePolicy({
          ...existing,
          lessonId: lessonId || existing.lessonId || null,
          videoDurationSeconds: Math.max(Number(existing.videoDurationSeconds || 0), Number(videoDurationSeconds || 0)),
        });
      }
    } else {
      const existing = findMemoryVideoWatchState(identity);
      if (existing) {
        return normalizeStateWithEffectivePolicy({
          ...existing,
          lessonId: lessonId || existing.lessonId || null,
          videoDurationSeconds: Math.max(Number(existing.videoDurationSeconds || 0), Number(videoDurationSeconds || 0)),
        });
      }
    }

    return normalizeStateWithEffectivePolicy(getDefaultVideoWatchState({
      userId,
      courseId,
      lessonId,
      videoId,
      videoType,
      videoDurationSeconds,
      chunkSeconds: videoWatchChunkSeconds,
      allowedFullWatches: effectiveWatchSettings?.allowedFullWatches,
      fullWatchThresholdPercentage: effectiveWatchSettings?.watchCompletionPercent,
    }));
  },

  async saveWatchState(stateRecord, client = null) {
    if (isPostgresMode()) {
      return upsertPgVideoWatchState(stateRecord, client);
    }

    return upsertMemoryVideoWatchState(stateRecord);
  },

  async getActivePlaybackSession(userId) {
    const active = await getRedisJson(buildActivePlaybackSessionKey(userId));
    if (!active) {
      return null;
    }
    if (!isFreshActivePlaybackSession(active)) {
      await deleteRedisKey(buildActivePlaybackSessionKey(userId));
      return null;
    }
    return active;
  },

  async validatePlaybackSession({
    userId,
    playbackSessionId,
    authSessionId = null,
    courseId = null,
    videoId = null,
    videoType = null,
    requestContext = null,
  }) {
    const active = await videoPlaybackRepository.getActivePlaybackSession(userId);
    if (!active) {
      return null;
    }

    const sessionMatches = String(active.playbackSessionId || '') === String(playbackSessionId || '');
    const authMatches = !authSessionId || String(active.authSessionId || '') === String(authSessionId || '');
    const courseMatches = !courseId || String(active.courseId || '') === String(courseId || '');
    const videoMatches = !videoId || String(active.videoId || '') === String(videoId || '');
    const videoTypeMatches = !videoType || normalizeVideoType(active.videoType) === normalizeVideoType(videoType);
    const requestedUserAgentHash = String(requestContext?.userAgentHash || '').trim();
    const activeUserAgentHash = String(active.userAgentHash || '').trim();
    const missingDeviceIdentity = !String(requestContext?.deviceId || '').trim() || !String(active.deviceId || '').trim();
    const matchingUserAgentIdentity = Boolean(
      authMatches
      && requestedUserAgentHash
      && activeUserAgentHash
      && requestedUserAgentHash === activeUserAgentHash,
    );

    if (sessionMatches && authMatches && courseMatches && videoMatches && videoTypeMatches) {
      return active;
    }

    const sameClient = matchesPlaybackClientContext({
      activeSession: active,
      authSessionId,
      requestContext,
    });

    if (!sessionMatches && authMatches && courseMatches && videoMatches && videoTypeMatches && sameClient) {
      console.info(`[video-playback-validate] ${JSON.stringify({
        user_id: userId ? String(userId) : null,
        requested_playback_session_id: playbackSessionId ? String(playbackSessionId) : null,
        active_playback_session_id: active.playbackSessionId || null,
        course_id: courseId ? String(courseId) : null,
        video_id: videoId ? String(videoId) : null,
        video_type: normalizeVideoType(videoType),
        auth_session_id: authSessionId || null,
        current_device_id: requestContext?.deviceId || null,
        current_browser_tab_id: requestContext?.playbackTabId || null,
        active_device_id: active.deviceId || null,
        active_browser_tab_id: active.clientSessionId || null,
        validation_reason: 'same_client_same_video_session_rollover_allowed',
      })}`);
      return {
        ...active,
        validationReason: 'same_client_same_video_session_rollover_allowed',
        requestedPlaybackSessionId: playbackSessionId ? String(playbackSessionId) : null,
      };
    }

    if (!sessionMatches && authMatches && courseMatches && videoMatches && videoTypeMatches && missingDeviceIdentity && matchingUserAgentIdentity) {
      console.info(`[video-playback-validate] ${JSON.stringify({
        user_id: userId ? String(userId) : null,
        requested_playback_session_id: playbackSessionId ? String(playbackSessionId) : null,
        active_playback_session_id: active.playbackSessionId || null,
        course_id: courseId ? String(courseId) : null,
        video_id: videoId ? String(videoId) : null,
        video_type: normalizeVideoType(videoType),
        auth_session_id: authSessionId || null,
        current_device_id: requestContext?.deviceId || null,
        current_browser_tab_id: requestContext?.playbackTabId || null,
        active_device_id: active.deviceId || null,
        active_browser_tab_id: active.clientSessionId || null,
        validation_reason: 'same_auth_same_video_missing_device_identity_allowed',
      })}`);
      return {
        ...active,
        validationReason: 'same_auth_same_video_missing_device_identity_allowed',
        requestedPlaybackSessionId: playbackSessionId ? String(playbackSessionId) : null,
      };
    }

    return null;
  },

  async setActivePlaybackSession(userId, session, { ttlSeconds = videoPlaybackSessionTtlSeconds } = {}) {
    await setRedisJson(buildActivePlaybackSessionKey(userId), session, { ttlSeconds });
    return session;
  },

  async clearActivePlaybackSession(userId) {
    await deleteRedisKey(buildActivePlaybackSessionKey(userId));
  },

  async startPlaybackSession({
    userId,
    courseId,
    lessonId = null,
    videoId,
    videoType = COURSE_VIDEO_TYPE,
    videoDurationSeconds = 0,
    authSessionId = null,
    requestContext = null,
    ipAddress = null,
    userAgent = null,
  }) {
    const watchState = await videoPlaybackRepository.getWatchState({
      userId,
      courseId,
      lessonId,
      videoId,
      videoType,
      videoDurationSeconds,
    });

    if (watchState.isLocked) {
      throw new ApiError(403, 'Video watch limit reached', {
        code: 'VIDEO_WATCH_LIMIT_REACHED',
        details: {
          watchState: buildVideoWatchStateSummary(watchState),
        },
      });
    }

    const activePlaybackSessionKey = buildActivePlaybackSessionKey(userId);
    const rawActiveSession = await getRedisJson(activePlaybackSessionKey);
    const sessionDecision = describePlaybackSessionDecision({
      activeSession: rawActiveSession,
      authSessionId,
      requestContext,
      courseId,
      lessonId,
      videoId,
      videoType,
    });
    const activeSession = sessionDecision.decision === 'expire' ? null : rawActiveSession;

    if (sessionDecision.decision === 'expire') {
      await deleteRedisKey(activePlaybackSessionKey);
      logPlaybackSessionDecision({
        userId,
        courseId,
        lessonId,
        videoId,
        authSessionId,
        requestContext,
        activeSession: rawActiveSession,
        decision: sessionDecision.decision,
        reason: sessionDecision.reason,
      });
    }

    if ((sessionDecision.replaceExisting || sessionDecision.reuseExistingSession) && rawActiveSession?.playbackSessionId) {
      await deleteRedisKey(activePlaybackSessionKey);
    }

    if (sessionDecision.decision === 'reject_409') {
      queueBestEffortDeviceActivity({
        userId,
        sessionId: authSessionId || null,
        device: buildPlaybackDeviceMeta({ requestContext, userAgent, ipAddress }),
        eventType: 'video_playback_session_blocked',
        meta: {
          activePlaybackSessionId: rawActiveSession?.playbackSessionId || null,
          requestedVideoId: String(videoId),
          requestedVideoType: normalizeVideoType(videoType),
          requestedCourseId: String(courseId),
          conflictReason: sessionDecision.reason,
        },
      });
      logPlaybackSessionDecision({
        userId,
        courseId,
        lessonId,
        videoId,
        authSessionId,
        requestContext,
        activeSession: rawActiveSession,
        decision: sessionDecision.decision,
        reason: sessionDecision.reason,
      });
      throw new ApiError(409, 'Another active video session is already running for this account', {
        code: 'PLAYBACK_SESSION_CONFLICT',
        details: {
          activeVideoId: rawActiveSession?.videoId || null,
          activeVideoType: rawActiveSession?.videoType || null,
          conflictReason: sessionDecision.reason,
        },
      });
    }

    const playbackSessionId = sessionDecision.reuseExistingSession && activeSession?.playbackSessionId
      ? String(activeSession.playbackSessionId)
      : createPersistentId('playback_session');
    const issuedAt = nowIso();
    const preserveClientIdentity = sessionDecision.reuseExistingSession || sessionDecision.replaceExisting;
    const preservedClientSessionId = preserveClientIdentity
      ? activeSession?.clientSessionId || null
      : null;
    const preservedDeviceId = preserveClientIdentity
      ? activeSession?.deviceId || null
      : null;
    const preservedUserAgentHash = preserveClientIdentity
      ? activeSession?.userAgentHash || null
      : null;
    const preservedUserAgent = preserveClientIdentity
      ? activeSession?.userAgent || null
      : null;
    const preservedIpAddress = preserveClientIdentity
      ? activeSession?.ipAddress || null
      : null;
    const nextSession = {
      playbackSessionId,
      userId: String(userId),
      authSessionId: authSessionId || null,
      courseId: String(courseId),
      lessonId: lessonId ? String(lessonId) : null,
      videoId: String(videoId),
      videoType: normalizeVideoType(videoType),
      clientSessionId: requestContext?.playbackTabId || preservedClientSessionId,
      deviceId: requestContext?.deviceId || preservedDeviceId,
      userAgentHash: requestContext?.userAgentHash || preservedUserAgentHash,
      userAgent: userAgent || requestContext?.userAgent || preservedUserAgent,
      ipAddress: ipAddress || requestContext?.ipAddress || preservedIpAddress,
      issuedAt: sessionDecision.reuseExistingSession ? activeSession?.issuedAt || issuedAt : issuedAt,
      lastHeartbeatAt: sessionDecision.reuseExistingSession ? activeSession?.lastHeartbeatAt || null : null,
      updatedAt: issuedAt,
      status: watchState.isLocked ? 'locked' : 'active',
    };

    await videoPlaybackRepository.setActivePlaybackSession(userId, nextSession);
    const savedState = await videoPlaybackRepository.saveWatchState({
      ...watchState,
      lessonId: lessonId || watchState.lessonId || null,
      playbackSessionId,
      activeSessionStatus: nextSession.status,
      deviceId: nextSession.deviceId || watchState.deviceId || null,
      ipAddress: nextSession.ipAddress || watchState.ipAddress || null,
      userAgent: nextSession.userAgent || watchState.userAgent || null,
      updatedAt: issuedAt,
      createdAt: watchState.createdAt || issuedAt,
    });
    logPlaybackSessionDecision({
      userId,
      courseId,
      lessonId,
      videoId,
      authSessionId,
      requestContext,
      activeSession: rawActiveSession,
      playbackSessionId,
      decision: sessionDecision.decision,
      reason: sessionDecision.reason,
    });

    return {
      playbackSession: nextSession,
      watchState: savedState,
    };
  },

  async recordHeartbeat({
    userId,
    courseId,
    lessonId = null,
    videoId,
    videoType = COURSE_VIDEO_TYPE,
    videoDurationSeconds = 0,
    playbackSessionId,
    authSessionId = null,
    requestContext = null,
    ipAddress = null,
    userAgent = null,
    heartbeatPayload,
  }) {
    const activeSession = await videoPlaybackRepository.validatePlaybackSession({
      userId,
      playbackSessionId,
      authSessionId,
      courseId,
      videoId,
      videoType,
      requestContext,
    });

    if (!activeSession) {
      throw new ApiError(409, 'Playback session is no longer valid', {
        code: 'PLAYBACK_SESSION_INVALID',
      });
    }

    const effectivePlaybackSessionId = String(activeSession.playbackSessionId || playbackSessionId || '');

    const existingState = await videoPlaybackRepository.getWatchState({
      userId,
      courseId,
      lessonId,
      videoId,
      videoType,
      videoDurationSeconds,
    });

    const serverNowMs = Date.now();
    const { state: nextStateRaw, outcome, heartbeat } = applyPlaybackHeartbeat(existingState, {
      ...heartbeatPayload,
      videoId,
      videoType,
      playbackSessionId: effectivePlaybackSessionId,
      deviceId: requestContext?.deviceId || heartbeatPayload?.deviceId || null,
      userAgent: userAgent || requestContext?.userAgent || heartbeatPayload?.userAgent || null,
      ipAddress: ipAddress || heartbeatPayload?.ipAddress || null,
    }, {
      chunkSeconds: videoWatchChunkSeconds,
      maxPlaybackRate: videoPlaybackMaxRate,
      heartbeatGraceSeconds: videoPlaybackHeartbeatGraceSeconds,
      maxHeartbeatGapSeconds: videoPlaybackMaxHeartbeatGapSeconds,
      serverNowMs,
      videoDurationSeconds,
    });

    const nextState = await videoPlaybackRepository.saveWatchState({
      ...nextStateRaw,
      lessonId: lessonId || nextStateRaw.lessonId || null,
    });

    const nextActiveSession = {
      ...activeSession,
      courseId: String(courseId),
      lessonId: lessonId ? String(lessonId) : null,
      videoId: String(videoId),
      videoType: normalizeVideoType(videoType),
      lastHeartbeatAt: nextState.lastHeartbeatAt || nowIso(),
      updatedAt: nextState.updatedAt || nowIso(),
      ipAddress: ipAddress || activeSession.ipAddress || null,
      userAgent: userAgent || activeSession.userAgent || null,
      deviceId: requestContext?.deviceId || activeSession.deviceId || null,
      status: nextState.isLocked ? 'locked' : 'active',
    };
    await videoPlaybackRepository.setActivePlaybackSession(userId, nextActiveSession);

    if (outcome.suspiciousReasons.length > 0) {
      queueBestEffortDeviceActivity({
        userId,
        sessionId: authSessionId || null,
        device: buildPlaybackDeviceMeta({ requestContext, userAgent, ipAddress }),
        eventType: 'video_playback_suspicious',
        meta: {
          courseId: String(courseId),
          lessonId: lessonId ? String(lessonId) : null,
          videoId: String(videoId),
          videoType: normalizeVideoType(videoType),
          reasons: outcome.suspiciousReasons,
          previousPositionSeconds: heartbeat.previousPositionSeconds,
          currentPositionSeconds: heartbeat.currentPositionSeconds,
          playbackRate: heartbeat.playbackRate,
          requestedPlaybackSessionId: playbackSessionId || null,
          effectivePlaybackSessionId: effectivePlaybackSessionId || null,
        },
      });
    }

    if (
      outcome.accepted
      || outcome.completedFullWatch
      || outcome.suspiciousReasons.length > 0
      || ['seek-backward', 'seek-forward', 'no-progress'].includes(String(outcome.reason || ''))
    ) {
      queueBestEffortDeviceActivity({
        userId,
        sessionId: authSessionId || null,
        device: buildPlaybackDeviceMeta({ requestContext, userAgent, ipAddress }),
        eventType: 'video_playback_heartbeat',
        meta: {
          courseId: String(courseId),
          lessonId: lessonId ? String(lessonId) : null,
          videoId: String(videoId),
          videoType: normalizeVideoType(videoType),
          playbackSessionId: effectivePlaybackSessionId || null,
          requestedPlaybackSessionId: playbackSessionId || null,
          previousPositionSeconds: heartbeat.previousPositionSeconds,
          currentPositionSeconds: heartbeat.currentPositionSeconds,
          durationSeconds: heartbeat.durationSeconds,
          playbackRate: heartbeat.playbackRate,
          accepted: Boolean(outcome.accepted),
          reason: outcome.reason,
          countableSeconds: outcome.countableSeconds,
          uniqueSecondsAdded: outcome.uniqueSecondsAdded,
          repeatSecondsAdded: outcome.repeatSecondsAdded,
          completedFullWatch: Boolean(outcome.completedFullWatch),
          completedFullWatches: nextState.completedFullWatches,
          currentCycleUniqueWatchedSeconds: nextState.currentCycleUniqueWatchedSeconds,
          totalUniqueWatchedSeconds: nextState.totalUniqueWatchedSeconds,
          stableEndWindowWatchedSeconds: nextState.stableEndWindowWatchedSeconds || 0,
          endStabilitySatisfied: Boolean(outcome.endStabilitySatisfied),
          completionProofSatisfied: Boolean(outcome.completionProofSatisfied),
          completionThresholdPercentage: nextState.fullWatchThresholdPercentage,
          suspiciousReasons: outcome.suspiciousReasons,
        },
      });
    }

    if (nextState.isLocked) {
      queueBestEffortDeviceActivity({
        userId,
        sessionId: authSessionId || null,
        device: buildPlaybackDeviceMeta({ requestContext, userAgent, ipAddress }),
        eventType: 'video_watch_locked',
        meta: {
          courseId: String(courseId),
          lessonId: lessonId ? String(lessonId) : null,
          videoId: String(videoId),
          videoType: normalizeVideoType(videoType),
          completedFullWatches: nextState.completedFullWatches,
          revisionBufferUsedSeconds: nextState.revisionBufferUsedSeconds,
        },
      });
    }

    return {
      watchState: nextState,
      watchSummary: buildVideoWatchStateSummary(nextState),
      playbackSession: nextActiveSession,
      outcome,
    };
  },
};

const getPgUsers = async (client = null) => pgMany('SELECT * FROM users ORDER BY created_at ASC', [], mapUserRow, client);
const getPgCourses = async (client = null) => pgMany('SELECT * FROM courses ORDER BY created_at ASC', [], mapCourseRow, client);
const getPgTests = async (client = null) => pgMany('SELECT * FROM tests ORDER BY created_at ASC', [], mapTestRow, client);
const getPgAttempts = async (client = null) => pgMany('SELECT * FROM test_attempts ORDER BY completed_at ASC', [], mapTestAttemptRow, client);
const getPgQuizzes = async (client = null) => {
  const quizzes = await pgMany('SELECT * FROM daily_quizzes ORDER BY quiz_date ASC', [], mapQuizRow, client);
  const attempts = await pgMany('SELECT * FROM daily_quiz_attempts ORDER BY submitted_at ASC', [], mapQuizAttemptRow, client);
  const attemptMap = attempts.reduce((accumulator, attempt) => {
    if (!accumulator.has(attempt.quizId)) {
      accumulator.set(attempt.quizId, []);
    }
    accumulator.get(attempt.quizId).push({
      userId: attempt.userId,
      score: attempt.score,
      total: attempt.total,
      submittedAt: attempt.submittedAt,
    });
    return accumulator;
  }, new Map());

  return quizzes.map((quiz) => ({
    ...quiz,
    leaderboard: normalizeQuizLeaderboard(attemptMap.get(quiz._id) || []),
  }));
};
const getPgEnrollments = async (client = null) => pgMany('SELECT * FROM enrollments ORDER BY enrolled_at ASC', [], mapEnrollmentRow, client);
const getPgCourseContentAccessRules = async (client = null) => pgMany(
  'SELECT * FROM course_content_access_rules ORDER BY updated_at DESC, created_at DESC',
  [],
  mapCourseContentAccessRuleRow,
  client,
);
const getPgStudentLessonWatchOverrides = async (client = null) => pgMany(
  'SELECT * FROM student_lesson_watch_overrides ORDER BY updated_at DESC, created_at DESC',
  [],
  mapStudentLessonWatchOverrideRow,
  client,
);
const getPgWatchHistory = async (client = null) => pgMany('SELECT * FROM watch_history ORDER BY updated_at DESC', [], mapWatchHistoryRow, client);
const getPgLiveClasses = async (client = null) => pgMany('SELECT * FROM live_classes ORDER BY scheduled_start_at ASC', [], mapLiveClassRow, client);
const getPgLiveChatMessages = async (client = null) => pgMany('SELECT * FROM live_chat_messages ORDER BY created_at ASC', [], mapLiveChatRow, client);
const getPgPlans = async (client = null) => pgMany('SELECT * FROM subscription_plans ORDER BY created_at ASC', [], mapPlanRow, client);
const getPgUserSubscriptions = async (client = null) => pgMany('SELECT * FROM subscriptions ORDER BY started_at DESC', [], mapSubscriptionRow, client);
const getPgAiMessages = async (client = null) => pgMany('SELECT * FROM ai_messages ORDER BY created_at DESC', [], mapAiMessageRow, client);
const getPgSessions = async (client = null) => pgMany('SELECT * FROM user_sessions ORDER BY created_at DESC LIMIT 200', [], mapSessionRow, client);
const getPgDeviceActivities = async (client = null) => pgMany('SELECT * FROM device_activity ORDER BY created_at DESC LIMIT 200', [], mapDeviceActivityRow, client);
const getPgNotifications = async (client = null) => pgMany('SELECT * FROM notifications ORDER BY created_at DESC', [], mapNotificationRow, client);
const getPgNotificationCount = async (client = null) => pgOne(
  'SELECT count(*)::int AS count FROM notifications',
  [],
  (row) => Number(row.count || 0),
  client,
);
const getPgReferrals = async (client = null) => pgMany('SELECT * FROM referrals ORDER BY created_at DESC', [], mapReferralRow, client);
const getPgUploads = async (client = null) => pgMany('SELECT * FROM admin_uploads ORDER BY created_at DESC', [], mapUploadRow, client);
const getPgPayments = async (client = null) => pgMany('SELECT * FROM payments ORDER BY created_at DESC', [], mapPaymentRow, client);
const getPgWebhooks = async (client = null) => pgMany('SELECT * FROM payment_webhooks ORDER BY received_at DESC', [], mapWebhookRow, client);
const getPgWatchHistoryForCourseUser = async (userId, courseId, client = null) => pgMany(
  'SELECT * FROM watch_history WHERE user_id = $1 AND course_id = $2 ORDER BY updated_at DESC',
  [String(userId), String(courseId)],
  mapWatchHistoryRow,
  client,
);

const getActiveEnrollmentsCacheKey = (userId) => cacheKey('enrollments', `active:${String(userId)}`);
const getUserProgressCacheKey = (userId) => cacheKey('progress', String(userId));
const getViewerCourseListCacheKey = (userId) => cacheKey('courses-viewer', String(userId || 'guest'));
const getViewerCourseCacheKey = (userId, courseId) => cacheKey('course-viewer', `${String(userId || 'guest')}:${String(courseId)}`);
const getViewerLessonsCacheKey = (userId, courseId) => cacheKey('course-lessons-viewer', `${String(userId || 'guest')}:${String(courseId)}`);
const getCourseAccessRulesCacheKey = (courseId, userId) => cacheKey('course-access-rules', `${String(courseId)}:${String(userId || 'guest')}`);
const getStudentLessonWatchOverrideCacheKey = (studentId, courseId, lessonId) => cacheKey('student-watch-override', `${String(studentId)}:${String(courseId)}:${String(lessonId)}`);

const listCourseContentAccessRulesForCourseUser = async (courseId, userId, client = null) => {
  const normalizedCourseId = String(courseId || '');
  const normalizedUserId = userId ? String(userId) : null;

  if (isPostgresMode()) {
    const params = [normalizedCourseId];
    let sql = 'SELECT * FROM course_content_access_rules WHERE course_id = $1';
    if (normalizedUserId) {
      params.push(normalizedUserId);
      sql += ' AND (student_scope = \'all_students\' OR (student_scope = \'student\' AND student_id = $2))';
    } else {
      sql += ' AND student_scope = \'all_students\'';
    }
    sql += ' ORDER BY updated_at DESC, created_at DESC';
    return pgMany(sql, params, mapCourseContentAccessRuleRow, client);
  }

  return state.courseContentAccessRules
    .map((entry) => normalizeCourseContentAccessRuleRecord(entry))
    .filter((entry) => entry.courseId === normalizedCourseId)
    .filter((entry) => entry.studentScope === 'all_students' || (normalizedUserId && entry.studentScope === 'student' && entry.studentId === normalizedUserId))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
};

const getStudentLessonWatchOverride = async ({ studentId, courseId, lessonId }, client = null) => {
  const normalizedStudentId = String(studentId || '');
  const normalizedCourseId = String(courseId || '');
  const normalizedLessonId = String(lessonId || '');
  const overrideCacheKey = getStudentLessonWatchOverrideCacheKey(normalizedStudentId, normalizedCourseId, normalizedLessonId);

  return getCachedJsonValue(overrideCacheKey, async () => {
    if (isPostgresMode()) {
      return pgOne(
        'SELECT * FROM student_lesson_watch_overrides WHERE student_id = $1 AND course_id = $2 AND lesson_id = $3',
        [normalizedStudentId, normalizedCourseId, normalizedLessonId],
        mapStudentLessonWatchOverrideRow,
        client,
      );
    }

    const match = state.studentLessonWatchOverrides.find((entry) =>
      String(entry.studentId || '') === normalizedStudentId
      && String(entry.courseId || '') === normalizedCourseId
      && String(entry.lessonId || '') === normalizedLessonId
    );
    return match ? normalizeStudentLessonWatchOverrideRecord(match) : null;
  }, redisJsonTtl);
};

const getActiveEnrollmentsForUser = async (userId) => {
  await ensurePlatformReady();

  if (!userId) {
    return [];
  }

  const cacheKeyActiveEnrollments = getActiveEnrollmentsCacheKey(userId);
  if (!isMongoMode()) {
    return getCachedJsonValue(cacheKeyActiveEnrollments, async () => {
      if (isPostgresMode()) {
        return pgMany(
          `SELECT * FROM enrollments WHERE user_id = $1 AND ${activeEnrollmentSql}`,
          [String(userId)],
          mapEnrollmentRow,
        );
      }

      return filterActiveEnrollments(state.enrollments.filter((entry) => entry.userId === String(userId)));
    }, ACTIVE_ENROLLMENTS_LOOKUP_CACHE_TTL_SECONDS);
  }

  return filterActiveEnrollments(state.enrollments.filter((entry) => entry.userId === String(userId)));
};

const hasActiveEnrollmentForCourse = async (userId, courseId) => {
  if (!userId || !courseId) {
    return false;
  }

  const enrollments = await getActiveEnrollmentsForUser(userId);
  return enrollments.some((entry) => entry.courseId === String(courseId));
};

const getEnrollmentForCourse = async (userId, courseId, client = null) => {
  if (!userId || !courseId) {
    return null;
  }

  if (isPostgresMode()) {
    return pgOne(
      `
        SELECT * FROM enrollments
        WHERE user_id = $1 AND course_id = $2
        ORDER BY enrolled_at DESC
        LIMIT 1
      `,
      [String(userId), String(courseId)],
      mapEnrollmentRow,
      client,
    );
  }

  return state.enrollments.find(
    (entry) => entry.userId === String(userId) && entry.courseId === String(courseId),
  ) || null;
};

const getActiveEnrollmentCourseIds = async (userId) => {
  if (!userId) {
    return new Set();
  }

  const enrollments = await getActiveEnrollmentsForUser(userId);
  return new Set(enrollments.map((entry) => String(entry.courseId)));
};

const loadPlatformData = async () => {
  await ensurePlatformReady();

  if (isPostgresMode()) {
    const now = Date.now();
    // Try in-memory cache first
    if (platformDataCache && platformDataCache.expiresAt > now) {
      return platformDataCache.value;
    }

    // If Redis is available, try reading the platform data cache from Redis to avoid DB hits
    try {
      const redisCached = await getPlatformDataFromRedis();
      if (redisCached) {
        platformDataCache = {
          value: redisCached,
          expiresAt: Date.now() + platformDataCacheTtlMs,
        };
        return redisCached;
      }
    } catch (e) {
      // ignore Redis errors and fall back to DB
    }

    if (platformDataCachePromise) {
      return platformDataCachePromise;
    }

    platformDataCachePromise = (async () => {
      const value = await runInTransaction(async (client) => {
        const users = await getPgUsers(client);
        const courses = await getPgCourses(client);
        const tests = await getPgTests(client);
        const testAttempts = await getPgAttempts(client);
        const quizzes = await getPgQuizzes(client);
        const enrollments = await getPgEnrollments(client);
        const courseContentAccessRules = await getPgCourseContentAccessRules(client);
        const studentLessonWatchOverrides = await getPgStudentLessonWatchOverrides(client);
        const watchHistory = await getPgWatchHistory(client);
        const liveClasses = await getPgLiveClasses(client);
        const liveChatMessages = await getPgLiveChatMessages(client);
        const subscriptions = await getPgPlans(client);
        const userSubscriptions = await getPgUserSubscriptions(client);
        const aiMessages = await getPgAiMessages(client);
        const loginSessions = await getPgSessions(client);
        const deviceActivities = await getPgDeviceActivities(client);
        const notificationCount = await getPgNotificationCount(client);
        const referrals = await getPgReferrals(client);
        const uploads = await getPgUploads(client);
        const payments = await getPgPayments(client);
        const webhooks = await getPgWebhooks(client);

        return {
          users,
          courses,
          tests,
          testAttempts,
          quizzes,
          enrollments,
          courseContentAccessRules,
          studentLessonWatchOverrides,
          watchHistory,
          liveClasses,
          liveChatMessages,
          subscriptions,
          userSubscriptions,
          aiMessages,
          loginSessions,
          deviceActivities,
          notifications: [],
          notificationCount,
          referrals,
          uploads,
          payments,
          webhooks,
        };
      });
      platformDataCache = {
        value,
        expiresAt: Date.now() + platformDataCacheTtlMs,
      };
      // Also attempt to populate Redis cache for other instances/processes
      try {
        await setPlatformDataToRedis(value);
      } catch (e) {
        // ignore Redis set errors
      }

      return value;
    })();

    try {
      return await platformDataCachePromise;
    } finally {
      platformDataCachePromise = null;
    }
  }

  return state;
};

const ensurePlatformReady = async () => {
  await ensurePersistentDatabaseAvailability();

  // Check Redis first for platform ready marker to avoid repeating admin setup on hot requests
  try {
    const redisUntil = await getPlatformReadyFromRedis();
    if (redisUntil > Date.now()) {
      platformReadyUntil = redisUntil;
      return 'ready';
    }
  } catch (e) {
    // ignore Redis errors and continue
  }

  if (platformReadyUntil > Date.now()) {
    return 'ready';
  }

  if (!platformReadyPromise) {
    platformReadyPromise = (async () => {
      await ensureDefaultAdminUser();
      platformReadyUntil = Date.now() + platformReadyCacheTtlMs;
      // try to persist marker to Redis so other processes can skip DB work
      try {
        await setPlatformReadyToRedis(platformReadyUntil);
      } catch (e) {
        // ignore
      }
      return 'ready';
    })();
  }

  try {
    return await platformReadyPromise;
  } finally {
    platformReadyPromise = null;
  }
};

const getRecentSessions = (data, userId) =>
  data.loginSessions
    .filter((entry) => !userId || entry.userId === String(userId))
    .slice(0, 8)
    .map((entry) => clone(entry));

const getRecentDeviceActivity = (data, userId) =>
  data.deviceActivities
    .filter((entry) => !userId || entry.userId === String(userId))
    .slice(0, 8)
    .map((entry) => clone(entry));

const getUserByIdFromData = (data, userId) => data.users.find((user) => user._id === String(userId)) || null;

const reconcilePgActiveSessionState = async (userId) => {
  const normalizedUserId = String(userId);
  const [user, activeSessions] = await Promise.all([
    pgOne('SELECT active_session_id FROM users WHERE id = $1', [normalizedUserId], (row) => row),
    pgMany(
      `
        SELECT *
        FROM user_sessions
        WHERE user_id = $1 AND status = 'active'
        ORDER BY last_seen_at DESC, created_at DESC
      `,
      [normalizedUserId],
      mapSessionRow,
    ),
  ]);

  const persistedActiveSessionId = user?.active_session_id || null;

  if (!activeSessions.length) {
    if (persistedActiveSessionId) {
      await pgExec(
        'UPDATE users SET active_session_id = NULL, updated_at = now() WHERE id = $1',
        [normalizedUserId],
      );
    }
    await deleteRedisKey(cacheKey('user-session', normalizedUserId));
    return null;
  }

  let chosenSession = activeSessions[0];
  if (persistedActiveSessionId) {
    const matchedSession = activeSessions.find((entry) => String(entry.sessionId) === String(persistedActiveSessionId));
    if (matchedSession) {
      chosenSession = matchedSession;
    }
  }

  const duplicateSessions = activeSessions.filter((entry) => entry._id !== chosenSession._id);
  if (duplicateSessions.length) {
    await pgExec(
      `
        UPDATE user_sessions
        SET status = 'ended',
            reason = 'repair_replaced_duplicate',
            ended_at = now(),
            last_seen_at = now()
        WHERE user_id = $1
          AND status = 'active'
          AND jwt_session_id <> $2
      `,
      [normalizedUserId, String(chosenSession.sessionId)],
    );
  }

  if (String(persistedActiveSessionId || '') !== String(chosenSession.sessionId)) {
    await pgExec(
      'UPDATE users SET active_session_id = $2, updated_at = now() WHERE id = $1',
      [normalizedUserId, String(chosenSession.sessionId)],
    );
  }

  await setRedisValue(cacheKey('user-session', normalizedUserId), String(chosenSession.sessionId), {
    ttlSeconds: 7 * 24 * 60 * 60,
  });

  return String(chosenSession.sessionId);
};

const sessionRepository = {
  async getActiveSessionId(userId, fallback = null) {
    const cached = await getRedisValue(cacheKey('user-session', String(userId)));
    if (cached) {
      return cached;
    }

    if (isPostgresMode()) {
      const reconciled = await reconcilePgActiveSessionState(userId);
      return reconciled || fallback || null;
    }

    return fallback || null;
  },

  async setActiveSession({ userId, sessionId }) {
    await setRedisValue(cacheKey('user-session', String(userId)), String(sessionId), { ttlSeconds: 7 * 24 * 60 * 60 });
  },

  async clearActiveSession(userId) {
    await deleteRedisKey(cacheKey('user-session', String(userId)));
  },

  async recordLogin({ userId, sessionId, device }) {
    if (isPostgresMode()) {
      await runInTransaction(async (client) => {
        await pgExec(
          'UPDATE user_sessions SET status = $2, reason = $3, ended_at = now(), last_seen_at = now() WHERE user_id = $1 AND status = $4',
          [String(userId), 'ended', 'replaced', 'active'],
          client,
        );
        await insertPgSession({ userId, sessionId, device, status: 'active' }, client);
        await pgExec(
          'UPDATE users SET active_session_id = $2, updated_at = now() WHERE id = $1',
          [String(userId), String(sessionId)],
          client,
        );
        await insertPgDeviceActivity({
          userId,
          sessionId,
          device,
          eventType: 'login',
          meta: {},
        }, client);
      });
      await sessionRepository.setActiveSession({ userId, sessionId });
      invalidateUserPlatformCaches(userId);
      return;
    }

    const session = {
      _id: nextId('session'),
      userId: String(userId),
      sessionId: String(sessionId),
      device: device || null,
      status: 'active',
      reason: null,
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
      endedAt: null,
    };

    state.loginSessions.unshift(session);
    state.loginSessions = state.loginSessions.slice(0, 200);
    state.deviceActivities.unshift({
      _id: nextId('activity'),
      userId: String(userId),
      sessionId: String(sessionId),
      device: device || null,
      eventType: 'login',
      meta: {},
      createdAt: nowIso(),
    });
    state.deviceActivities = state.deviceActivities.slice(0, 200);
    await sessionRepository.setActiveSession({ userId, sessionId });
    invalidateUserPlatformCaches(userId);
  },

  async recordLogout({ userId, sessionId, device, reason = 'logout' }) {
    if (isPostgresMode()) {
      await runInTransaction(async (client) => {
        await closePgSession({ userId, sessionId, reason }, client);
        if (sessionId) {
          await pgExec(
            `
              UPDATE users
              SET active_session_id = CASE
                WHEN active_session_id = $2 THEN NULL
                ELSE active_session_id
              END,
              updated_at = now()
              WHERE id = $1
            `,
            [String(userId), String(sessionId)],
            client,
          );
        } else {
          await pgExec(
            'UPDATE users SET active_session_id = NULL, updated_at = now() WHERE id = $1',
            [String(userId)],
            client,
          );
        }
        await insertPgDeviceActivity({
          userId,
          sessionId,
          device,
          eventType: 'logout',
          meta: { reason },
        }, client);
      });
      await sessionRepository.clearActiveSession(userId);
      await videoPlaybackRepository.clearActivePlaybackSession(userId);
      invalidateUserPlatformCaches(userId);
      return;
    }

    const sessionIndex = state.loginSessions.findIndex(
      (entry) => entry.userId === String(userId) && entry.sessionId === String(sessionId) && entry.status === 'active',
    );
    if (sessionIndex >= 0) {
      state.loginSessions[sessionIndex] = {
        ...state.loginSessions[sessionIndex],
        status: 'ended',
        reason,
        endedAt: nowIso(),
        lastSeenAt: nowIso(),
      };
    }

    state.deviceActivities.unshift({
      _id: nextId('activity'),
      userId: String(userId),
      sessionId: String(sessionId),
      device: device || null,
      eventType: 'logout',
      meta: { reason },
      createdAt: nowIso(),
    });
    state.deviceActivities = state.deviceActivities.slice(0, 200);
    await sessionRepository.clearActiveSession(userId);
    await videoPlaybackRepository.clearActivePlaybackSession(userId);
    invalidateUserPlatformCaches(userId);
  },

  async replaceActiveSession({ userId, sessionId, device }) {
    await sessionRepository.recordLogin({ userId, sessionId, device });
  },

  async getRecentSessions(userId) {
    const data = await loadPlatformData();
    return getRecentSessions(data, userId);
  },

  async getRecentDeviceActivity(userId) {
    const data = await loadPlatformData();
    return getRecentDeviceActivity(data, userId);
  },
};

const usersRepository = {
  async listSafe() {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return pgMany('SELECT * FROM users ORDER BY created_at ASC', [], (row) => sanitizeUser(mapUserRow(row)));
    }

    if (isMongoMode()) {
      return User.find().select('-password').lean();
    }

    return state.users.map((user) => sanitizeUser(user));
  },

  async findByEmail(email) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return pgOne('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)], mapUserRow);
    }

    if (isMongoMode()) {
      return User.findOne({ email: normalizeEmail(email) });
    }

    return state.users.find((user) => user.email === normalizeEmail(email)) || null;
  },

  async findByMobileNumber(mobileNumber) {
    await ensurePlatformReady();
    const normalizedMobileNumber = normalizeMobileNumber(mobileNumber);
    if (!normalizedMobileNumber) {
      return null;
    }

    if (isPostgresMode()) {
      return pgOne('SELECT * FROM users WHERE mobile_number = $1', [normalizedMobileNumber], mapUserRow);
    }

    if (isMongoMode()) {
      return User.findOne({ mobileNumber: normalizedMobileNumber });
    }

    return state.users.find((user) => normalizeMobileNumber(user.mobileNumber) === normalizedMobileNumber) || null;
  },

  async findByLoginIdentifier(identifier) {
    const normalized = String(identifier || '').trim();
    if (!normalized) {
      return null;
    }
    if (normalized.includes('@')) {
      return usersRepository.findByEmail(normalized);
    }
    return usersRepository.findByMobileNumber(normalized);
  },

  async findById(id) {
    await ensurePlatformReady();

    const cacheKeyUser = cacheKey('user', String(id));
    const ttlSeconds = USER_LOOKUP_CACHE_TTL_SECONDS;

    if (!isMongoMode()) {
      return getCachedJsonValue(cacheKeyUser, async () => {
        if (isPostgresMode()) {
          return pgOne('SELECT * FROM users WHERE id = $1', [String(id)], mapUserRow);
        }

        return state.users.find((user) => user._id === String(id)) || null;
      }, ttlSeconds);
    }

    return User.findById(id);
  },

  async findSafeById(id) {
    const user = await usersRepository.findById(id);
    return sanitizeUser(user);
  },

  async create(payload) {
    if (isPostgresMode()) {
      const createdUser = await upsertPgUser({
        ...payload,
        _id: payload._id || createPersistentId('user'),
        email: normalizeEmail(payload.email),
        mobileNumber: normalizeMobileNumber(payload.mobileNumber),
      });
      try {
        await deleteRedisKey(cacheKey('user', String(createdUser._id)));
      } catch (error) {}
      return clone(createdUser);
    }

    if (isMongoMode()) {
      const createdUser = await User.create({
        ...payload,
        email: normalizeEmail(payload.email),
        mobileNumber: normalizeMobileNumber(payload.mobileNumber),
      });
      return createdUser.toObject();
    }

    const createdUser = {
      _id: payload._id || nextId('user'),
      name: payload.name,
      email: normalizeEmail(payload.email),
      mobileNumber: normalizeMobileNumber(payload.mobileNumber) || null,
      password: payload.password,
      role: payload.role || 'student',
      accountStatus: payload.accountStatus || 'active',
      statusNote: payload.statusNote || null,
      device: payload.device || null,
      session: payload.session || null,
      streak: payload.streak ?? 0,
      points: payload.points ?? 0,
      badges: Array.isArray(payload.badges) ? clone(payload.badges) : [],
      referral_code: payload.referral_code || null,
      lastLoginAt: payload.lastLoginAt || null,
      disabledAt: payload.disabledAt || null,
      blockedAt: payload.blockedAt || null,
      created_at: payload.created_at || nowIso(),
      updated_at: payload.updated_at || nowIso(),
    };

    state.users.push(createdUser);
    try {
      await deleteRedisKey(cacheKey('user', String(createdUser._id)));
    } catch (error) {}
    return clone(createdUser);
  },

  async update(id, patch) {
    if (isPostgresMode()) {
      const current = await usersRepository.findById(id);
      if (!current) {
        return null;
      }

      const merged = {
        ...current,
        ...clone(patch),
        mobileNumber: patch.mobileNumber === undefined ? current.mobileNumber : normalizeMobileNumber(patch.mobileNumber),
        updated_at: nowIso(),
      };
      await upsertPgUser(merged);
      try {
        await deleteRedisKey(cacheKey('user', String(id)));
      } catch (error) {}
      invalidateGlobalPlatformCaches();
      invalidateUserPlatformCaches(id);
      return clone(merged);
    }

    if (isMongoMode()) {
      const updatedUser = await User.findByIdAndUpdate(id, patch, { new: true });
      return updatedUser ? updatedUser.toObject() : null;
    }

    const userIndex = state.users.findIndex((user) => user._id === String(id));
    if (userIndex === -1) {
      return null;
    }

    state.users[userIndex] = {
      ...state.users[userIndex],
      ...clone(patch),
      mobileNumber: patch.mobileNumber === undefined ? state.users[userIndex].mobileNumber : normalizeMobileNumber(patch.mobileNumber),
      updated_at: nowIso(),
    };
    try {
      await deleteRedisKey(cacheKey('user', String(id)));
    } catch (error) {}
    invalidateGlobalPlatformCaches();
    invalidateUserPlatformCaches(id);

    return clone(state.users[userIndex]);
  },
};

const buildViewerCourseRedactionOptions = async ({ course, userId, isAdmin = false } = {}) => {
  if (isAdmin || !course?._id || !userId) {
    return {
      evaluateAccess: () => ({ blocked: false, reason: null }),
      rules: [],
    };
  }

  const rules = await listCourseContentAccessRulesForCourseUser(course._id, userId);
  const evaluateAccess = createCourseAccessEvaluator({ course, rules });
  return {
    evaluateAccess,
    rules,
  };
};

const coursesRepository = {
  async list() {
    await ensurePlatformReady();

    const cacheKeyCourses = cacheKey('courses', 'list');
    const courseCacheTtlMs = Math.max(1000, Number(appConfig.courseCacheTtlMs || platformDataCacheTtlMs));

    // Try Redis cache first
    try {
      const cached = await getRedisJson(cacheKeyCourses);
      if (cached) {
        return cached;
      }
    } catch (e) {
      // ignore redis errors
    }

    let courses;
    if (isPostgresMode()) {
      courses = await getPgCourses();
    } else if (isMongoMode()) {
      courses = await Course.find().lean();
    } else {
      courses = state.courses.map((course) => clone(course));
    }

    // populate redis cache for short TTL
    try {
      await setRedisJson(cacheKeyCourses, courses, { ttlSeconds: Math.ceil(courseCacheTtlMs / 1000) });
    } catch (e) {
      // ignore
    }

    return courses;
  },

  async listForViewer(userId) {
    const viewerCacheKey = getViewerCourseListCacheKey(userId);
    return getCachedJsonValue(viewerCacheKey, async () => {
      if (userId) {
        await paymentRepository.syncPendingRazorpayPaymentsForUser(userId, { maxRecords: 20 }).catch(() => undefined);
      }
      const data = await loadPlatformData();
      const courses = data.courses.map((course) => clone(course));
      let enrollments = [];
      let userEnrollments = [];
      let userPayments = [];
      let isAdmin = false;

      if (userId) {
        const user = await usersRepository.findSafeById(userId);
        isAdmin = user?.role === 'admin';
        userEnrollments = data.enrollments.filter((entry) => entry.userId === String(userId));
        enrollments = filterActiveEnrollments(userEnrollments);
        userPayments = data.payments.filter((entry) => entry.userId === String(userId));
      }

      const enrolledCourseIds = new Set(enrollments.map((entry) => entry.courseId));
      return Promise.all(courses.map(async (course) => {
        const latestEnrollment = getLatestEntry(userEnrollments.filter((entry) => entry.courseId === course._id));
        const latestPayment = getBestPaymentEntry(userPayments.filter((entry) => entry.courseId === course._id));
        const access = getCourseVideoPlaybackAccess({
          course,
          enrollment: latestEnrollment,
          payment: latestPayment,
          isAdmin,
        });
        const hasFullCourseAccess = isAdmin || enrolledCourseIds.has(course._id) || Boolean(access.canAccessCourse);
        const redactionOptions = await buildViewerCourseRedactionOptions({
          course,
          userId,
          isAdmin,
        });
        return {
          ...redactCourseForViewer(course, hasFullCourseAccess, {
            isAdmin,
            evaluateAccess: redactionOptions.evaluateAccess,
          }),
          enrolled: hasFullCourseAccess,
          ...access,
        };
      }));
    }, VIEWER_COURSE_LOOKUP_CACHE_TTL_SECONDS);
  },

  async findById(id) {
    await ensurePlatformReady();

    const cacheKeyCourse = cacheKey('course', String(id));
    const ttlSeconds = COURSE_LOOKUP_CACHE_TTL_SECONDS;

    if (!isMongoMode()) {
      return getCachedJsonValue(cacheKeyCourse, async () => {
        if (isPostgresMode()) {
          return pgOne('SELECT * FROM courses WHERE id = $1', [String(id)], mapCourseRow);
        }

        return clone(state.courses.find((course) => course._id === String(id)) || null);
      }, ttlSeconds);
    }

    return Course.findById(id).lean();
  },

  async findVisibleById(id, userId) {
    const viewerCacheKey = getViewerCourseCacheKey(userId, id);
    return getCachedJsonValue(viewerCacheKey, async () => {
      if (userId) {
        await paymentRepository.syncPendingRazorpayPaymentsForUser(userId, { maxRecords: 20 }).catch(() => undefined);
      }
      const course = await coursesRepository.findById(id);
      if (!course) {
        return null;
      }

      let isEnrolled = false;
      let isAdmin = false;
      let latestEnrollment = null;
      let latestPayment = null;
      if (userId) {
        const user = await usersRepository.findSafeById(userId);
        isAdmin = user?.role === 'admin';
        latestEnrollment = await getEnrollmentForCourse(userId, id);
        if (isPostgresMode()) {
          const payments = await pgMany(
            `
              SELECT * FROM payments
              WHERE user_id = $1 AND course_id = $2
              ORDER BY COALESCE(paid_at, updated_at, created_at) DESC
            `,
            [String(userId), String(id)],
            mapPaymentRow,
          );
          latestPayment = getBestPaymentEntry(payments);
        } else {
          latestPayment = getBestPaymentEntry(state.payments.filter((entry) => entry.userId === String(userId) && entry.courseId === String(id)));
        }
        isEnrolled = Boolean(isAdmin || isEnrollmentActive(latestEnrollment));
      }

      const access = getCourseVideoPlaybackAccess({
        course,
        enrollment: latestEnrollment,
        payment: latestPayment,
        isAdmin,
      });

      const redactionOptions = await buildViewerCourseRedactionOptions({
        course,
        userId,
        isAdmin,
      });

      return {
        ...redactCourseForViewer(course, isAdmin || isEnrolled || Boolean(access.canAccessCourse), {
          isAdmin,
          evaluateAccess: redactionOptions.evaluateAccess,
        }),
        enrolled: isAdmin || isEnrolled || Boolean(access.canAccessCourse),
        ...access,
      };
    }, VIEWER_COURSE_LOOKUP_CACHE_TTL_SECONDS);
  },

  async create(payload) {
    if (isPostgresMode()) {
      const course = await upsertPgCourse(payload);
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('course', String(course._id)));
      } catch (error) {}
      return clone(course);
    }

    if (isMongoMode()) {
      const createdCourse = await Course.create(payload);
      return createdCourse.toObject();
    }

    const createdCourse = {
      _id: payload._id || nextId('course'),
      title: payload.title,
      description: payload.description || '',
      category: payload.category || 'SSC JE',
      exam: payload.exam || payload.category || 'SSC JE',
      subject: payload.subject || 'General',
      level: payload.level || 'Full Course',
      price: Number(payload.price || 0),
      offerPercentage: Number(payload.offerPercentage || 0),
      validityDays: Number(payload.validityDays || courseDefaultValidityDays),
      thumbnailUrl: payload.thumbnailUrl || '',
      instructor: payload.instructor || 'VARONENGLISH Faculty',
      officialChannelUrl: payload.officialChannelUrl || null,
      modules: Array.isArray(payload.modules) ? clone(payload.modules) : [],
      createdBy: payload.createdBy || null,
      created_at: payload.created_at || nowIso(),
    };

    state.courses.push(createdCourse);
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('course', String(createdCourse._id)));
    } catch (error) {}
    return clone(createdCourse);
  },

  async listLessons(courseId, userId) {
    const viewerCacheKey = getViewerLessonsCacheKey(userId, courseId);
    return getCachedJsonValue(viewerCacheKey, async () => {
      const course = await coursesRepository.findById(courseId);
      if (!course) {
        return [];
      }

      let isEnrolled = false;
      let isAdmin = false;
      if (userId) {
        const user = await usersRepository.findSafeById(userId);
        isAdmin = user?.role === 'admin';
        isEnrolled = await hasActiveEnrollmentForCourse(userId, courseId);
      }

      const redactionOptions = await buildViewerCourseRedactionOptions({
        course,
        userId,
        isAdmin,
      });
      return lessonListFromCourse(redactCourseForViewer(course, isAdmin || isEnrolled, {
        isAdmin,
        evaluateAccess: redactionOptions.evaluateAccess,
      }));
    }, VIEWER_COURSE_LOOKUP_CACHE_TTL_SECONDS);
  },

  async listContentAccessRules({ courseId = '', studentId = '', studentScope = '', contentScope = '' } = {}) {
    await ensurePlatformReady();
    const normalizedCourseId = String(courseId || '').trim();
    const normalizedStudentId = String(studentId || '').trim();
    const normalizedStudentScope = String(studentScope || '').trim().toLowerCase();
    const normalizedContentScope = String(contentScope || '').trim().toLowerCase();

    if (isPostgresMode()) {
      const params = [];
      const clauses = [];
      if (normalizedCourseId) {
        params.push(normalizedCourseId);
        clauses.push(`course_id = $${params.length}`);
      }
      if (normalizedStudentId) {
        params.push(normalizedStudentId);
        clauses.push(`student_id = $${params.length}`);
      }
      if (normalizedStudentScope) {
        params.push(normalizedStudentScope);
        clauses.push(`student_scope = $${params.length}`);
      }
      if (normalizedContentScope) {
        params.push(normalizedContentScope);
        clauses.push(`content_scope = $${params.length}`);
      }
      const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return pgMany(
        `SELECT * FROM course_content_access_rules ${whereClause} ORDER BY updated_at DESC, created_at DESC`,
        params,
        mapCourseContentAccessRuleRow,
      );
    }

    return state.courseContentAccessRules
      .map((entry) => normalizeCourseContentAccessRuleRecord(entry))
      .filter((entry) => !normalizedCourseId || entry.courseId === normalizedCourseId)
      .filter((entry) => !normalizedStudentId || entry.studentId === normalizedStudentId)
      .filter((entry) => !normalizedStudentScope || entry.studentScope === normalizedStudentScope)
      .filter((entry) => !normalizedContentScope || entry.contentScope === normalizedContentScope)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  },

  async upsertContentAccessRule(payload) {
    await ensurePlatformReady();
    const normalized = normalizeCourseContentAccessRuleRecord(payload);

    if (isPostgresMode()) {
      const existing = await pgOne(
        `
          SELECT * FROM course_content_access_rules
          WHERE course_id = $1
            AND student_scope = $2
            AND COALESCE(student_id, '') = COALESCE($3, '')
            AND content_scope = $4
            AND COALESCE(module_id, '') = COALESCE($5, '')
            AND COALESCE(chapter_id, '') = COALESCE($6, '')
            AND COALESCE(lesson_id, '') = COALESCE($7, '')
        `,
        [
          normalized.courseId,
          normalized.studentScope,
          normalized.studentId,
          normalized.contentScope,
          normalized.moduleId,
          normalized.chapterId,
          normalized.lessonId,
        ],
        mapCourseContentAccessRuleRow,
      );
      const record = {
        ...normalized,
        _id: existing?._id || normalized._id,
        createdAt: existing?.createdAt || normalized.createdAt,
      };
      await pgExec(
        `
          INSERT INTO course_content_access_rules (
            id, course_id, student_scope, student_id, content_scope, module_id, chapter_id, lesson_id,
            access, admin_note, created_by, updated_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (id) DO UPDATE SET
            access = EXCLUDED.access,
            admin_note = EXCLUDED.admin_note,
            created_by = EXCLUDED.created_by,
            updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at
        `,
        [
          record._id,
          record.courseId,
          record.studentScope,
          record.studentId,
          record.contentScope,
          record.moduleId,
          record.chapterId,
          record.lessonId,
          record.access,
          record.adminNote,
          record.createdBy,
          record.updatedBy,
          record.createdAt,
          record.updatedAt,
        ],
      );
      invalidateGlobalPlatformCaches();
      if (record.studentId) {
        invalidateUserPlatformCaches(record.studentId);
        await deleteRedisKey(getViewerCourseCacheKey(record.studentId, record.courseId)).catch(() => undefined);
        await deleteRedisKey(getViewerLessonsCacheKey(record.studentId, record.courseId)).catch(() => undefined);
      }
      await deleteRedisKey(getCourseAccessRulesCacheKey(record.courseId, record.studentId || 'guest')).catch(() => undefined);
      return record;
    }

    const existingIndex = state.courseContentAccessRules.findIndex((entry) =>
      String(entry.courseId || '') === normalized.courseId
      && normalizeStudentScope(entry.studentScope) === normalized.studentScope
      && String(entry.studentId || '') === String(normalized.studentId || '')
      && normalizeContentScope(entry.contentScope) === normalized.contentScope
      && String(entry.moduleId || '') === String(normalized.moduleId || '')
      && String(entry.chapterId || '') === String(normalized.chapterId || '')
      && String(entry.lessonId || '') === String(normalized.lessonId || '')
    );
    const record = {
      ...(existingIndex >= 0 ? normalizeCourseContentAccessRuleRecord(state.courseContentAccessRules[existingIndex]) : normalized),
      ...normalized,
      createdAt: existingIndex >= 0 ? state.courseContentAccessRules[existingIndex].createdAt : normalized.createdAt,
    };
    if (existingIndex >= 0) {
      state.courseContentAccessRules[existingIndex] = record;
    } else {
      state.courseContentAccessRules.unshift(record);
    }
    invalidateGlobalPlatformCaches();
    if (record.studentId) {
      invalidateUserPlatformCaches(record.studentId);
      await deleteRedisKey(getViewerCourseCacheKey(record.studentId, record.courseId)).catch(() => undefined);
      await deleteRedisKey(getViewerLessonsCacheKey(record.studentId, record.courseId)).catch(() => undefined);
    }
    return clone(record);
  },

  async deleteContentAccessRule(ruleId) {
    await ensurePlatformReady();
    const normalizedRuleId = String(ruleId || '');

    if (isPostgresMode()) {
      const existing = await pgOne(
        'SELECT * FROM course_content_access_rules WHERE id = $1',
        [normalizedRuleId],
        mapCourseContentAccessRuleRow,
      );
      if (!existing) {
        return null;
      }
      await pgExec('DELETE FROM course_content_access_rules WHERE id = $1', [normalizedRuleId]);
      invalidateGlobalPlatformCaches();
      if (existing.studentId) {
        invalidateUserPlatformCaches(existing.studentId);
        await deleteRedisKey(getViewerCourseCacheKey(existing.studentId, existing.courseId)).catch(() => undefined);
        await deleteRedisKey(getViewerLessonsCacheKey(existing.studentId, existing.courseId)).catch(() => undefined);
      }
      return existing;
    }

    const existingIndex = state.courseContentAccessRules.findIndex((entry) => String(entry._id || '') === normalizedRuleId);
    if (existingIndex === -1) {
      return null;
    }
    const [removed] = state.courseContentAccessRules.splice(existingIndex, 1);
    invalidateGlobalPlatformCaches();
    if (removed.studentId) {
      invalidateUserPlatformCaches(removed.studentId);
      await deleteRedisKey(getViewerCourseCacheKey(removed.studentId, removed.courseId)).catch(() => undefined);
      await deleteRedisKey(getViewerLessonsCacheKey(removed.studentId, removed.courseId)).catch(() => undefined);
    }
    return clone(removed);
  },

  async listStudentLessonWatchOverrides({ courseId = '', studentId = '', lessonId = '' } = {}) {
    await ensurePlatformReady();
    const normalizedCourseId = String(courseId || '').trim();
    const normalizedStudentId = String(studentId || '').trim();
    const normalizedLessonId = String(lessonId || '').trim();

    if (isPostgresMode()) {
      const params = [];
      const clauses = [];
      if (normalizedCourseId) {
        params.push(normalizedCourseId);
        clauses.push(`course_id = $${params.length}`);
      }
      if (normalizedStudentId) {
        params.push(normalizedStudentId);
        clauses.push(`student_id = $${params.length}`);
      }
      if (normalizedLessonId) {
        params.push(normalizedLessonId);
        clauses.push(`lesson_id = $${params.length}`);
      }
      const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return pgMany(
        `SELECT * FROM student_lesson_watch_overrides ${whereClause} ORDER BY updated_at DESC, created_at DESC`,
        params,
        mapStudentLessonWatchOverrideRow,
      );
    }

    return state.studentLessonWatchOverrides
      .map((entry) => normalizeStudentLessonWatchOverrideRecord(entry))
      .filter((entry) => !normalizedCourseId || entry.courseId === normalizedCourseId)
      .filter((entry) => !normalizedStudentId || entry.studentId === normalizedStudentId)
      .filter((entry) => !normalizedLessonId || entry.lessonId === normalizedLessonId)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  },

  async upsertStudentLessonWatchOverride(payload) {
    await ensurePlatformReady();
    const normalized = normalizeStudentLessonWatchOverrideRecord(payload);

    if (isPostgresMode()) {
      await pgExec(
        `
          INSERT INTO student_lesson_watch_overrides (
            id, course_id, student_id, module_id, chapter_id, lesson_id, allowed_full_watches,
            watch_completion_percent, admin_note, created_by, updated_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (course_id, student_id, lesson_id) DO UPDATE SET
            module_id = EXCLUDED.module_id,
            chapter_id = EXCLUDED.chapter_id,
            allowed_full_watches = EXCLUDED.allowed_full_watches,
            watch_completion_percent = EXCLUDED.watch_completion_percent,
            admin_note = EXCLUDED.admin_note,
            updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at
        `,
        [
          normalized._id,
          normalized.courseId,
          normalized.studentId,
          normalized.moduleId,
          normalized.chapterId,
          normalized.lessonId,
          normalized.allowedFullWatches,
          normalized.watchCompletionPercent,
          normalized.adminNote,
          normalized.createdBy,
          normalized.updatedBy,
          normalized.createdAt,
          normalized.updatedAt,
        ],
      );
      const saved = await getStudentLessonWatchOverride({
        studentId: normalized.studentId,
        courseId: normalized.courseId,
        lessonId: normalized.lessonId,
      });
      invalidateUserPlatformCaches(normalized.studentId);
      await deleteRedisKey(getViewerCourseCacheKey(normalized.studentId, normalized.courseId)).catch(() => undefined);
      await deleteRedisKey(getViewerLessonsCacheKey(normalized.studentId, normalized.courseId)).catch(() => undefined);
      await deleteRedisKey(getStudentLessonWatchOverrideCacheKey(normalized.studentId, normalized.courseId, normalized.lessonId)).catch(() => undefined);
      return saved || normalized;
    }

    const existingIndex = state.studentLessonWatchOverrides.findIndex((entry) =>
      String(entry.studentId || '') === normalized.studentId
      && String(entry.courseId || '') === normalized.courseId
      && String(entry.lessonId || '') === normalized.lessonId
    );
    const record = {
      ...(existingIndex >= 0 ? normalizeStudentLessonWatchOverrideRecord(state.studentLessonWatchOverrides[existingIndex]) : normalized),
      ...normalized,
      createdAt: existingIndex >= 0 ? state.studentLessonWatchOverrides[existingIndex].createdAt : normalized.createdAt,
    };
    if (existingIndex >= 0) {
      state.studentLessonWatchOverrides[existingIndex] = record;
    } else {
      state.studentLessonWatchOverrides.unshift(record);
    }
    invalidateUserPlatformCaches(record.studentId);
    await deleteRedisKey(getViewerCourseCacheKey(record.studentId, record.courseId)).catch(() => undefined);
    await deleteRedisKey(getViewerLessonsCacheKey(record.studentId, record.courseId)).catch(() => undefined);
    return clone(record);
  },

  async deleteStudentLessonWatchOverride(overrideId) {
    await ensurePlatformReady();
    const normalizedOverrideId = String(overrideId || '');

    if (isPostgresMode()) {
      const existing = await pgOne(
        'SELECT * FROM student_lesson_watch_overrides WHERE id = $1',
        [normalizedOverrideId],
        mapStudentLessonWatchOverrideRow,
      );
      if (!existing) {
        return null;
      }
      await pgExec('DELETE FROM student_lesson_watch_overrides WHERE id = $1', [normalizedOverrideId]);
      invalidateUserPlatformCaches(existing.studentId);
      await deleteRedisKey(getViewerCourseCacheKey(existing.studentId, existing.courseId)).catch(() => undefined);
      await deleteRedisKey(getViewerLessonsCacheKey(existing.studentId, existing.courseId)).catch(() => undefined);
      await deleteRedisKey(getStudentLessonWatchOverrideCacheKey(existing.studentId, existing.courseId, existing.lessonId)).catch(() => undefined);
      return existing;
    }

    const existingIndex = state.studentLessonWatchOverrides.findIndex((entry) => String(entry._id || '') === normalizedOverrideId);
    if (existingIndex === -1) {
      return null;
    }
    const [removed] = state.studentLessonWatchOverrides.splice(existingIndex, 1);
    invalidateUserPlatformCaches(removed.studentId);
    await deleteRedisKey(getViewerCourseCacheKey(removed.studentId, removed.courseId)).catch(() => undefined);
    await deleteRedisKey(getViewerLessonsCacheKey(removed.studentId, removed.courseId)).catch(() => undefined);
    return clone(removed);
  },

  async addEditorialVideo(courseId, editorial) {
    return withCourseMutationLock(courseId, async () => {
      const course = await coursesRepository.findById(courseId);
      if (!course) {
        throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
      }

      const nextEditorial = {
        ...clone(editorial),
        id: editorial.id || createPersistentId('editorial'),
        type: 'private-video',
        videoType: EDITORIAL_VIDEO_TYPE,
        watchLimit: 1,
        watchCompletionPercent: Math.max(Number(editorial.watchCompletionPercent || appConfig.videoWatchCompletionThresholdPercent || 90), 50),
        published: editorial.published !== false,
        uploadedAt: editorial.uploadedAt || nowIso(),
      };
      course.editorials = [nextEditorial, ...asArray(course.editorials).filter((entry) => String(entry.id) !== String(nextEditorial.id))];
      course.updated_at = nowIso();
      await coursesRepository.updateCourseModule(courseId, course);
      return sanitizeEditorialVideoForViewer(nextEditorial, true, true);
    });
  },

  async deleteEditorialVideo(courseId, editorialId) {
    return withCourseMutationLock(courseId, async () => {
      const course = await coursesRepository.findById(courseId);
      if (!course) {
        throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
      }

      const editorials = asArray(course.editorials);
      const target = editorials.find((entry) => String(entry.id) === String(editorialId));
      if (!target) {
        throw new ApiError(404, 'Editorial video not found', { code: 'EDITORIAL_NOT_FOUND' });
      }

      if (target.storagePath) {
        const { deleteStoredPrivateVideo } = require('./private-video-storage.js');
        await deleteStoredPrivateVideo({
          storageProvider: target.storageProvider,
          storagePath: target.storagePath,
        }).catch(() => undefined);
      }
      if (target.hlsManifestPath) {
        const { deleteProcessedHlsAssets } = require('./video-processing.js');
        await deleteProcessedHlsAssets(target.hlsManifestPath, target.hlsStorageProvider || null).catch(() => undefined);
      }

      course.editorials = editorials.filter((entry) => String(entry.id) !== String(editorialId));
      course.updated_at = nowIso();
      await coursesRepository.updateCourseModule(courseId, course);
      return true;
    });
  },

  async getProtectedEditorialPlayback({
    userId,
    courseId,
    editorialId,
    user = null,
    requestContext = null,
  }) {
    const course = await coursesRepository.findById(courseId);
    if (!course) {
      throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
    }

    const editorial = asArray(course.editorials).find((entry) => String(entry.id) === String(editorialId));
    if (!editorial || !editorial.storagePath || editorial.published === false) {
      throw new ApiError(404, 'Editorial video not found', { code: 'EDITORIAL_NOT_FOUND' });
    }

    const resolvedUser = user || (userId ? await usersRepository.findSafeById(userId) : null);
    if (!resolvedUser) {
      throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
    }

    if (resolvedUser.role !== 'admin') {
      const hasAccess = await hasActiveEnrollmentForCourse(String(resolvedUser._id || userId), courseId);
      if (!hasAccess) {
        throw new ApiError(403, 'Course enrollment is required to access this editorial video', {
          code: 'EDITORIAL_ENROLLMENT_REQUIRED',
          details: { courseId, editorialId },
        });
      }
    }

    const durationSeconds = Math.max(Number(editorial.durationMinutes || 0) * 60, 1);
    const { playbackSession, watchState } = await videoPlaybackRepository.startPlaybackSession({
      userId: String(resolvedUser._id || userId),
      courseId: String(courseId),
      lessonId: null,
      videoId: String(editorial.id),
      videoType: EDITORIAL_VIDEO_TYPE,
      videoDurationSeconds: durationSeconds,
      authSessionId: resolvedUser.session || null,
      requestContext,
      ipAddress: requestContext?.ipAddress || null,
      userAgent: requestContext?.userAgent || null,
    });

    const issuedToken = issuePlaybackToken({
      userId: String(resolvedUser._id || userId),
      sessionId: resolvedUser.session || null,
      courseId: String(courseId),
      editorialId: String(editorial.id),
      videoId: String(editorial.id),
      videoType: EDITORIAL_VIDEO_TYPE,
      playbackSessionId: playbackSession.playbackSessionId,
      userAgentHash: requestContext?.userAgentHash || null,
      storageProvider: editorial.storageProvider || 'local',
      storagePath: String(editorial.storagePath),
      mimeType: editorial.mimeType || 'video/mp4',
      assetKind: 'source',
    });

    return {
      playerType: 'private-video',
      embedUrl: null,
      streamUrl: `/backend/api/courses/stream/${issuedToken.token}`,
      drmConfig: null,
      fallbackStreamUrl: null,
      fallbackStreamFormat: null,
      fallbackReason: null,
      streamFormat: 'source',
      playbackStatus: 'ready',
      deliveryProfile: editorial.deliveryProfile || 'private-source',
      availableQualities: [],
      statusMessage: 'Protected editorial video ready.',
      watermarkText: buildPlaybackWatermarkText(resolvedUser),
      resumeSeconds: resolveProtectedLessonResumeSeconds({
        watchState,
        lessonProgress: null,
        durationSeconds,
      }),
      completed: false,
      tokenExpiresAt: issuedToken.expiresAt,
      drmEnabled: false,
      courseId: String(courseId),
      videoId: String(editorial.id),
      playbackSessionId: playbackSession.playbackSessionId,
      videoType: EDITORIAL_VIDEO_TYPE,
      watchLimit: watchState.allowedFullWatches,
      watchCompletionPercent: watchState.fullWatchThresholdPercentage,
      watchState: buildVideoWatchStateSummary(watchState),
    };
  },

  async getProtectedLessonBootstrap({
    userId,
    courseId,
    lessonId,
    requestContext = null,
  }) {
    const [course, lessons, player] = await Promise.all([
      coursesRepository.findVisibleById(courseId, userId),
      coursesRepository.listLessons(courseId, userId),
      coursesRepository.getProtectedLessonPlayback({
        userId,
        courseId,
        lessonId,
        requestContext,
      }),
    ]);

    if (!course) {
      throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
    }

    const lesson = lessons.find((entry) => String(entry.id || entry._id || '') === String(lessonId)) || null;

    return {
      course,
      lessons,
      lesson,
      player,
    };
  },

  async updateCourseModule(courseId, updatedCourse) {
    if (isPostgresMode()) {
      await upsertPgCourse({
        _id: courseId,
        ...updatedCourse,
      });
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('course', String(courseId)));
      } catch (error) {}
      return updatedCourse;
    }

    if (isMongoMode()) {
      const updated = await Course.findByIdAndUpdate(
        courseId,
        {
          title: updatedCourse.title,
          description: updatedCourse.description,
          category: updatedCourse.category,
          exam: updatedCourse.exam,
          subject: updatedCourse.subject,
          level: updatedCourse.level,
          price: Number(updatedCourse.price || 0),
          offerPercentage: Number(updatedCourse.offerPercentage || 0),
          validityDays: Number(updatedCourse.validityDays || 365),
          thumbnailUrl: updatedCourse.thumbnailUrl,
          instructor: updatedCourse.instructor,
          officialChannelUrl: updatedCourse.officialChannelUrl,
          editorials: Array.isArray(updatedCourse.editorials) ? updatedCourse.editorials : [],
          modules: updatedCourse.modules,
          createdBy: updatedCourse.createdBy || null,
          created_at: updatedCourse.created_at,
          updated_at: updatedCourse.updated_at || nowIso(),
        },
        { new: true },
      );
      return updated?.toObject?.() || updatedCourse;
    }

    const courseIndex = state.courses.findIndex((course) => course._id === String(courseId));
    if (courseIndex === -1) {
      return null;
    }

    state.courses[courseIndex] = {
      ...state.courses[courseIndex],
      ...clone(updatedCourse),
      _id: state.courses[courseIndex]._id,
      modules: clone(updatedCourse.modules || []),
      editorials: clone(updatedCourse.editorials || []),
      updated_at: nowIso(),
    };
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('course', String(courseId)));
    } catch (error) {}

    return clone(state.courses[courseIndex]);
  },

  async delete(courseId) {
    if (isPostgresMode()) {
      const normalizedCourseId = String(courseId);
      const affectedUserIds = await pgMany(
        `
          SELECT DISTINCT user_id
          FROM (
            SELECT user_id FROM enrollments WHERE course_id = $1
            UNION
            SELECT user_id FROM watch_history WHERE course_id = $1
            UNION
            SELECT user_id FROM payments WHERE course_id = $1
          ) affected
        `,
        [normalizedCourseId],
        (row) => String(row.user_id || ''),
      );

      await runInTransaction(async (client) => {
        await pgExec(
          `
            UPDATE tests
            SET course_id = NULL
            WHERE course_id = $1
          `,
          [normalizedCourseId],
          client,
        );
        await pgExec(
          `
            UPDATE live_classes
            SET course_id = NULL
            WHERE course_id = $1
          `,
          [normalizedCourseId],
          client,
        );
        await pgExec(
          `
            UPDATE live_classes
            SET replay_course_id = NULL
            WHERE replay_course_id = $1
          `,
          [normalizedCourseId],
          client,
        );
        await pgExec(
          `
            UPDATE payments
            SET course_id = NULL,
                updated_at = now()
            WHERE course_id = $1
          `,
          [normalizedCourseId],
          client,
        );
        await pgExec(
          `
            UPDATE admin_uploads
            SET course_id = NULL
            WHERE course_id = $1
          `,
          [normalizedCourseId],
          client,
        );
        await pgExec('DELETE FROM courses WHERE id = $1', [normalizedCourseId], client);
      });
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('course', normalizedCourseId));
      } catch (error) {}
      affectedUserIds.filter(Boolean).forEach((userId) => invalidateUserPlatformCaches(userId));
      return true;
    }

    if (isMongoMode()) {
      await Course.findByIdAndDelete(courseId);
      invalidateGlobalPlatformCaches();
      return true;
    }

    const normalizedCourseId = String(courseId);
    const affectedUserIds = new Set([
      ...state.enrollments.filter((entry) => entry.courseId === normalizedCourseId).map((entry) => String(entry.userId || '')),
      ...state.watchHistory.filter((entry) => entry.courseId === normalizedCourseId).map((entry) => String(entry.userId || '')),
      ...state.payments.filter((entry) => entry.courseId === normalizedCourseId).map((entry) => String(entry.userId || '')),
    ].filter(Boolean));
    const courseIndex = state.courses.findIndex((course) => course._id === normalizedCourseId);
    if (courseIndex >= 0) {
      state.courses.splice(courseIndex, 1);
    }
    state.enrollments = state.enrollments.filter((entry) => entry.courseId !== normalizedCourseId);
    state.watchHistory = state.watchHistory.filter((entry) => entry.courseId !== normalizedCourseId);
    state.videoWatchStates = state.videoWatchStates.filter((entry) => entry.courseId !== normalizedCourseId);
    state.videoAccessGrants = state.videoAccessGrants.filter((entry) => entry.courseId !== normalizedCourseId);
    state.liveReplayAccessGrants = state.liveReplayAccessGrants.filter((entry) => entry.courseId !== normalizedCourseId);
    state.payments = state.payments.map((entry) => (
      entry.courseId === normalizedCourseId
        ? { ...entry, courseId: null }
        : entry
    ));
    state.tests = state.tests.map((entry) => (
      entry.courseId === normalizedCourseId
        ? { ...entry, courseId: null }
        : entry
    ));
    state.liveClasses = state.liveClasses.map((entry) => ({
      ...entry,
      courseId: entry.courseId === normalizedCourseId ? null : entry.courseId,
      replayCourseId: entry.replayCourseId === normalizedCourseId ? null : entry.replayCourseId,
    }));
    state.uploads = state.uploads.map((entry) => (
      entry.courseId === normalizedCourseId
        ? { ...entry, courseId: null }
        : entry
    ));
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('course', normalizedCourseId));
    } catch (error) {}
    affectedUserIds.forEach((userId) => invalidateUserPlatformCaches(userId));
    return courseIndex >= 0;
  },

  async updateLesson(courseId, lessonId, updater) {
    return withCourseMutationLock(courseId, async () => {
      const course = await coursesRepository.findById(courseId);
      if (!course) {
        return null;
      }

      const { modules, updatedLesson } = updateLessonInModules(course.modules || [], lessonId, updater);
      if (!updatedLesson) {
        return null;
      }

      course.modules = modules;
      course.updated_at = nowIso();
      await coursesRepository.updateCourseModule(courseId, course);
      return clone(updatedLesson);
    });
  },

  async getProtectedLessonPlayback({
    userId,
    courseId,
    lessonId,
    user = null,
    requestContext = null,
    enforceEnrollment = true,
    enforceSequentialUnlock = true,
  }) {
    const startedAtMs = Date.now();
    const accessDecision = {
      request_id: requestContext?.requestId || null,
      replica: requestContext?.replica || String(process.env.REPLICA_NAME || process.env.HOSTNAME || process.env.SERVICE_NAME || `pid:${process.pid}`),
      user_id: userId ? String(userId) : null,
      course_id: String(courseId),
      lesson_id: String(lessonId),
      video_id: String(lessonId),
      course_access_status: 'unknown',
      course_validity_status: 'unknown',
      video_release_status: 'unknown',
      video_watch_limit_status: 'not_checked',
      course_video_access_mode: 'free_order',
      blocked_reason: null,
      playback_session_id: null,
      device_id: requestContext?.deviceId || null,
      browser_tab_id: requestContext?.playbackTabId || null,
      playback_url_generated: false,
      bootstrap_duration_ms: null,
      conflict_reason: null,
      failure_code: null,
    };
    const logPlaybackAccessDecision = (level = 'info') => {
      accessDecision.bootstrap_duration_ms = Date.now() - startedAtMs;
      const payload = JSON.stringify(accessDecision);
      if (level === 'warn') {
        console.warn(`[course-video-access] ${payload}`);
        return;
      }
      console.info(`[course-video-access] ${payload}`);
    };
    const finalizePlayer = (player) => {
      accessDecision.video_id = String(player?.videoId || accessDecision.video_id || lessonId);
      accessDecision.playback_session_id = player?.playbackSessionId || null;
      accessDecision.playback_url_generated = Boolean(player?.streamUrl || player?.embedUrl);
      logPlaybackAccessDecision('info');
      return player;
    };

    try {
      const course = await coursesRepository.findById(courseId);
      if (!course) {
        throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
      }

      accessDecision.course_video_access_mode = getCourseVideoAccessMode(course);

      const resolvedUser = user || await usersRepository.findSafeById(userId);
      if (!resolvedUser) {
        throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
      }

      const isAdmin = resolvedUser.role === 'admin';
      const lesson = findLessonInCourse(course, lessonId);
      if (!lesson) {
        throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
      }
      const lessonContext = findLessonContextInCourse(course, lessonId);
      if (!lessonContext) {
        throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
      }

      accessDecision.video_id = String(lesson._id || lesson.id || lessonId);

      const requireEnrollment = shouldRequireEnrollmentForLesson(lesson, enforceEnrollment);
      const requireSequentialUnlock = shouldRequireSequentialUnlockForCourseLesson({
        course,
        lesson,
        enforceSequentialUnlock,
        enforceEnrollment,
      });
      let enrollment = null;

      if (isAdmin || !requireEnrollment) {
        accessDecision.course_access_status = isAdmin ? 'admin_override' : 'not_required';
        accessDecision.course_validity_status = isAdmin ? 'admin_override' : 'not_required';
      } else {
        enrollment = await getEnrollmentForCourse(userId, courseId);
        if (!enrollment) {
          accessDecision.course_access_status = 'not_purchased';
          accessDecision.course_validity_status = 'not_found';
          throw new ApiError(403, 'Please purchase course to watch.', { code: 'COURSE_ACCESS_REQUIRED' });
        }

        if (!isEnrollmentActive(enrollment)) {
          accessDecision.course_access_status = 'expired';
          accessDecision.course_validity_status = 'expired';
          throw new ApiError(403, 'Course validity expired.', { code: 'COURSE_VALIDITY_EXPIRED' });
        }

        accessDecision.course_access_status = 'purchased_active';
        accessDecision.course_validity_status = 'active';
      }

      if (!isAdmin) {
        const redactionOptions = await buildViewerCourseRedactionOptions({
          course,
          userId,
          isAdmin,
        });
        const contentAccessDecision = redactionOptions.evaluateAccess({
          moduleId: lessonContext.moduleId,
          chapterId: lessonContext.chapterId,
          lessonId: lessonContext.lesson.id,
        });
        if (contentAccessDecision.blocked) {
          accessDecision.blocked_reason = 'CONTENT_ACCESS_RULE_BLOCKED';
          accessDecision.failure_code = 'LESSON_ACCESS_RULE_BLOCKED';
          throw new ApiError(403, contentAccessDecision.reason || ACCESS_BLOCK_MESSAGE, {
            code: 'LESSON_ACCESS_RULE_BLOCKED',
          });
        }
      }

      const watchHistory = isPostgresMode()
        ? await getPgWatchHistoryForCourseUser(userId, courseId)
        : (await loadPlatformData()).watchHistory;
      const progressMap = buildLessonProgressMap(watchHistory, userId, courseId);

      if (requireSequentialUnlock && !isAdmin && !isLessonSequentiallyUnlockedForProgressMap(course, lessonId, progressMap)) {
        accessDecision.blocked_reason = 'SEQUENTIAL_LOCKED';
        throw new ApiError(403, 'Finish the previous topic to unlock this lesson', { code: 'SEQUENTIAL_LOCKED' });
      }

      const lessonProgress = progressMap.get(String(lessonId));
      const protectedLessonDurationSeconds = Math.max(Number(lesson.durationMinutes || 0) * 60, 0);
      accessDecision.video_release_status = getLessonReleaseStatus(lesson);
      assertLessonReleasedForPlayback(lesson);

    if (lesson.type === 'youtube') {
      const decryptedId = decryptVideoId(lesson.youtubeVideoIdCiphertext) || normalizeYouTubeVideoId(lesson.videoUrl);
      const embedUrl = buildSecureYouTubeEmbedUrl(decryptedId, {
        startSeconds: lessonProgress?.progressSeconds || 0,
      });

      if (!embedUrl) {
        throw new ApiError(500, 'Protected lesson could not be prepared for playback', { code: 'EMBED_BUILD_FAILED' });
      }

      accessDecision.video_watch_limit_status = 'not_applicable';
      return finalizePlayer({
        playerType: 'youtube',
        embedUrl,
        streamUrl: null,
        watermarkText: buildPlaybackWatermarkText(resolvedUser),
        resumeSeconds: Number(lessonProgress?.progressSeconds || 0),
        completed: Boolean(lessonProgress?.completed),
        tokenExpiresAt: null,
        drmEnabled: false,
        courseVideoAccessMode: accessDecision.course_video_access_mode,
      });
    }

    if (lesson.type === 'private-video') {
      const resolvedPlaybackProvider = getPrivateLessonPlaybackProvider(lesson);
      const isCloudflareStreamLesson = resolvedPlaybackProvider === 'cloudflare-stream';
      const cloudflareStreamReady = isCloudflareStreamLesson
        && lesson.hlsProcessingStatus === 'ready'
        && lesson.playbackReady !== false
        && lesson.hlsPlaybackPath;
      const hlsReady = (
        lesson.deliveryStrategy === 'hls'
        || lesson.deliveryStrategy === 'cloudflare-stream'
        || cloudflareStreamReady
      ) && lesson.hlsProcessingStatus === 'ready'
        && lesson.hlsPlaybackPath;
      const sourceReady = Boolean(lesson.storagePath);
      const hlsProcessingStatus = String(lesson.hlsProcessingStatus || '').toLowerCase();
      const sourceFallbackAllowed = Boolean(lesson.sourceFallbackAllowed)
        || Boolean(appConfig.sourcePlaybackFallbackEnabled)
        || ['queued', 'processing', 'failed'].includes(hlsProcessingStatus);

      if (!hlsReady && !sourceReady && !isCloudflareStreamLesson) {
        throw new ApiError(isAdmin ? 500 : 404, isAdmin
          ? 'Private video storage path is missing or Cloudflare Stream playback is not ready yet.'
          : 'Lesson video is not available yet.', {
          code: isAdmin ? 'PRIVATE_VIDEO_PATH_MISSING' : 'LESSON_VIDEO_NOT_AVAILABLE',
        });
      }

      if (!hlsReady) {
        if (sourceReady && sourceFallbackAllowed) {
          const { playbackSession, watchState } = await videoPlaybackRepository.startPlaybackSession({
            userId,
            courseId,
            lessonId,
            videoId: lesson._id || lesson.id || lessonId,
            videoType: COURSE_VIDEO_TYPE,
            videoDurationSeconds: Number(lesson.durationMinutes || 0) * 60,
            authSessionId: resolvedUser.session || null,
            requestContext,
            ipAddress: requestContext?.ipAddress || null,
            userAgent: requestContext?.userAgent || null,
          });
          const issuedToken = issuePlaybackToken({
            kind: 'course-private-source',
            userId: String(userId),
            sessionId: resolvedUser.session || null,
            courseId: String(courseId),
            lessonId: String(lessonId),
            videoId: String(lesson._id || lesson.id || lessonId),
            videoType: COURSE_VIDEO_TYPE,
            playbackSessionId: playbackSession.playbackSessionId,
            userAgentHash: requestContext?.userAgentHash || null,
            storageProvider: lesson.storageProvider || 'local',
            storagePath: String(lesson.storagePath),
            mimeType: lesson.mimeType || 'video/mp4',
            assetKind: 'source',
          });

          accessDecision.video_watch_limit_status = watchState.isLocked ? 'reached' : 'within_limit';
          return finalizePlayer({
            playerType: 'private-video',
            embedUrl: null,
            streamUrl: `/backend/api/courses/stream/${issuedToken.token}`,
            drmConfig: null,
            fallbackStreamUrl: null,
            fallbackStreamFormat: null,
            fallbackReason: hlsProcessingStatus === 'queued' || hlsProcessingStatus === 'processing'
              ? 'Protected source playback is active while adaptive HLS packaging finishes.'
              : hlsProcessingStatus === 'failed' || lesson.hlsProcessingError
                ? 'Protected source playback is active because adaptive HLS is temporarily unavailable.'
                : 'Protected source playback is active for this lesson.',
            streamFormat: 'source',
            playbackStatus: lesson.hlsProcessingStatus || 'ready',
            deliveryProfile: lesson.deliveryProfile || 'r2-private-hls',
            availableQualities: Array.isArray(lesson.targetQualities) ? lesson.targetQualities : [],
            statusMessage: hlsProcessingStatus === 'queued' || hlsProcessingStatus === 'processing'
              ? 'Adaptive HLS processing is running. Protected source playback is temporarily available.'
              : hlsProcessingStatus === 'failed' || lesson.hlsProcessingError
                ? 'Adaptive HLS processing failed. Protected source playback is temporarily available.'
                : 'Protected lesson video ready.',
            watermarkText: buildPlaybackWatermarkText(resolvedUser),
            resumeSeconds: resolveProtectedLessonResumeSeconds({
              watchState,
              lessonProgress,
              durationSeconds: protectedLessonDurationSeconds,
            }),
            completed: Boolean(lessonProgress?.completed),
            tokenExpiresAt: issuedToken.expiresAt,
            drmEnabled: false,
            courseId: String(courseId),
            videoId: String(lesson._id || lesson.id || lessonId),
            playbackSessionId: playbackSession.playbackSessionId,
            videoType: COURSE_VIDEO_TYPE,
            watchLimit: watchState.allowedFullWatches,
            watchCompletionPercent: watchState.fullWatchThresholdPercentage,
            watchState: buildVideoWatchStateSummary(watchState),
            playbackGrantExpiresAt: null,
            playbackGrantRemainingViews: null,
            courseVideoAccessMode: accessDecision.course_video_access_mode,
          });
        }

        if (hlsProcessingStatus === 'queued' || hlsProcessingStatus === 'processing') {
          try {
            const { maybeRecoverStaleCourseVideoProcessingJob } = require('./video-processing.js');
            await maybeRecoverStaleCourseVideoProcessingJob({ courseId, lesson });
          } catch (error) {
            console.error('[video-processing] failed to requeue stale course lesson', error);
          }

          accessDecision.video_watch_limit_status = 'not_checked';
          return finalizePlayer({
            playerType: 'private-video',
            embedUrl: null,
            streamUrl: null,
            streamFormat: null,
            playbackStatus: lesson.hlsProcessingStatus,
            deliveryProfile: lesson.deliveryProfile || 'r2-private-hls',
            availableQualities: Array.isArray(lesson.targetQualities) ? lesson.targetQualities : [],
            statusMessage: 'Adaptive stream is still preparing. Playback will unlock automatically after HLS packaging completes.',
            watermarkText: buildPlaybackWatermarkText(resolvedUser),
            resumeSeconds: resolveProtectedLessonResumeSeconds({
              lessonProgress,
              durationSeconds: protectedLessonDurationSeconds,
            }),
            completed: Boolean(lessonProgress?.completed),
            tokenExpiresAt: null,
            drmEnabled: Boolean(appConfig.privateVideoDrmEnabled),
            watchLimit: getLessonConfiguredWatchLimit(lesson),
            watchCompletionPercent: getLessonConfiguredCompletionPercent(lesson),
            playbackGrantExpiresAt: null,
            playbackGrantRemainingViews: null,
            courseVideoAccessMode: accessDecision.course_video_access_mode,
          });
        }

        try {
          const { maybeRecoverStaleCourseVideoProcessingJob } = require('./video-processing.js');
          const requeued = await maybeRecoverStaleCourseVideoProcessingJob({ courseId, lesson });
          if (requeued) {
            accessDecision.video_watch_limit_status = 'not_checked';
            return finalizePlayer({
              playerType: 'private-video',
              embedUrl: null,
              streamUrl: null,
              streamFormat: null,
              playbackStatus: 'queued',
              deliveryProfile: lesson.deliveryProfile || 'r2-private-hls',
              availableQualities: Array.isArray(lesson.targetQualities) ? lesson.targetQualities : [],
              statusMessage: 'Adaptive stream is being prepared again. Playback will unlock automatically after HLS packaging completes.',
              watermarkText: buildPlaybackWatermarkText(resolvedUser),
              resumeSeconds: resolveProtectedLessonResumeSeconds({
                lessonProgress,
                durationSeconds: protectedLessonDurationSeconds,
              }),
              completed: Boolean(lessonProgress?.completed),
              tokenExpiresAt: null,
              drmEnabled: Boolean(appConfig.privateVideoDrmEnabled),
              watchLimit: getLessonConfiguredWatchLimit(lesson),
              watchCompletionPercent: getLessonConfiguredCompletionPercent(lesson),
              playbackGrantExpiresAt: null,
              playbackGrantRemainingViews: null,
              courseVideoAccessMode: accessDecision.course_video_access_mode,
            });
          }
        } catch (error) {
          console.error('[video-processing] failed to requeue failed course lesson', error);
        }

        throw new ApiError(503, 'Adaptive HLS playback is not ready for this lesson yet', {
          code: 'PRIVATE_VIDEO_HLS_NOT_READY',
        });
      }
      const { playbackSession, watchState } = await videoPlaybackRepository.startPlaybackSession({
        userId,
        courseId,
        lessonId,
        videoId: lesson._id || lesson.id || lessonId,
        videoType: COURSE_VIDEO_TYPE,
        videoDurationSeconds: Number(lesson.durationMinutes || 0) * 60,
        authSessionId: resolvedUser.session || null,
        requestContext,
        ipAddress: requestContext?.ipAddress || null,
        userAgent: requestContext?.userAgent || null,
      });
      const playbackPath = hlsReady ? String(lesson.hlsPlaybackPath) : String(lesson.storagePath);
      const playbackMimeType = hlsReady ? 'application/vnd.apple.mpegurl' : (lesson.mimeType || 'video/mp4');
      const playbackProvider = hlsReady
        ? (resolvedPlaybackProvider || lesson.hlsStorageProvider || lesson.storageProvider || 'local')
        : (lesson.storageProvider || 'local');
      const cloudflarePlayback = String(playbackProvider || '').toLowerCase() === 'cloudflare-stream';
      const playbackBundlePath = String(lesson.hlsManifestRootPath || '').trim();
      const playbackBundleVersion = String(lesson.hlsManifestVersion || '').trim();
      const drmConfig = cloudflarePlayback ? null : buildProtectedPlaybackDrmConfig({
        manifestRootPath: playbackBundlePath || path.posix.dirname(playbackPath),
        courseId,
        lessonId,
        userId,
        sessionId: resolvedUser.session || null,
        playbackSessionId: playbackSession.playbackSessionId,
        videoId: String(lesson._id || lesson.id || lessonId),
        videoType: COURSE_VIDEO_TYPE,
        playbackContext: requestContext,
      });

        const issuedToken = hlsReady
        ? (
          cloudflarePlayback
            ? {
              url: String(lesson.hlsPlaybackPath),
              expiresAt: null,
            }
            : shouldUseManifestBundlePlaybackRoute()
            ? buildManifestBundleUrl({
              storageProvider: playbackProvider,
              bundlePath: playbackBundlePath || path.posix.dirname(playbackPath),
              version: playbackBundleVersion || 'legacy',
            }, {
              assetPath: 'master.m3u8',
            })
            : buildCompactAssetUrl({
              storageProvider: playbackProvider,
              storagePath: playbackPath,
              cacheScope: 'shared-hls-manifest',
            })
        )
        : issuePlaybackToken({
          kind: 'course-private-source',
          userId: String(userId),
          sessionId: resolvedUser.session || null,
          courseId: String(courseId),
          lessonId: String(lessonId),
          videoId: String(lesson._id || lesson.id || lessonId),
          videoType: COURSE_VIDEO_TYPE,
          playbackSessionId: playbackSession.playbackSessionId,
          userAgentHash: requestContext?.userAgentHash || null,
          storageProvider: playbackProvider,
          storagePath: playbackPath,
          mimeType: playbackMimeType,
          assetKind: 'source',
        });

      accessDecision.video_watch_limit_status = watchState.isLocked ? 'reached' : 'within_limit';
      const sourceIssuedToken = sourceReady && sourceFallbackAllowed
        ? issuePlaybackToken({
          kind: 'course-private-source',
          userId: String(userId),
          sessionId: resolvedUser.session || null,
          courseId: String(courseId),
          lessonId: String(lessonId),
          videoId: String(lesson._id || lesson.id || lessonId),
          videoType: COURSE_VIDEO_TYPE,
          playbackSessionId: playbackSession.playbackSessionId,
          userAgentHash: requestContext?.userAgentHash || null,
          storageProvider: lesson.storageProvider || 'local',
          storagePath: String(lesson.storagePath),
          mimeType: lesson.mimeType || 'video/mp4',
          assetKind: 'source',
        })
        : null;

      return finalizePlayer({
        playerType: 'private-video',
        embedUrl: null,
        streamUrl: issuedToken.url,
        drmConfig,
        fallbackStreamUrl: sourceIssuedToken ? `/backend/api/courses/stream/${sourceIssuedToken.token}` : null,
        fallbackStreamFormat: sourceIssuedToken ? 'source' : null,
        fallbackReason: sourceIssuedToken
          ? 'Protected source playback is available if adaptive HLS needs to recover.'
          : null,
        streamFormat: 'hls',
        playbackStatus: 'ready',
        deliveryProfile: lesson.deliveryProfile || (cloudflarePlayback ? 'cloudflare-stream' : 'r2-private-hls'),
        availableQualities: Array.isArray(lesson.targetQualities) ? lesson.targetQualities : [],
        statusMessage: 'Adaptive HLS stream ready.',
        watermarkText: buildPlaybackWatermarkText(resolvedUser),
        resumeSeconds: resolveProtectedLessonResumeSeconds({
          watchState,
          lessonProgress,
          durationSeconds: protectedLessonDurationSeconds,
        }),
        completed: Boolean(lessonProgress?.completed),
        tokenExpiresAt: issuedToken.expiresAt,
        drmEnabled: Boolean(drmConfig),
        courseId: String(courseId),
        videoId: String(lesson._id || lesson.id || lessonId),
        playbackSessionId: playbackSession.playbackSessionId,
        videoType: COURSE_VIDEO_TYPE,
        watchLimit: watchState.allowedFullWatches,
        watchCompletionPercent: watchState.fullWatchThresholdPercentage,
        watchState: buildVideoWatchStateSummary(watchState),
        playbackGrantExpiresAt: null,
        playbackGrantRemainingViews: null,
        courseVideoAccessMode: accessDecision.course_video_access_mode,
      });
    }

    throw new ApiError(400, 'Secure playback is only available for protected lessons', { code: 'UNSUPPORTED_LESSON_TYPE' });
    } catch (error) {
      accessDecision.failure_code = error?.code || error?.name || 'UNKNOWN_ERROR';
      accessDecision.conflict_reason = error?.details?.conflictReason || error?.details?.decisionReason || null;
      accessDecision.blocked_reason = error?.code || error?.message || 'UNKNOWN_ERROR';
      if (accessDecision.video_release_status === 'unknown') {
        accessDecision.video_release_status = 'not_checked';
      }
      if (accessDecision.course_access_status === 'unknown') {
        accessDecision.course_access_status = 'not_checked';
      }
      if (accessDecision.course_validity_status === 'unknown') {
        accessDecision.course_validity_status = 'not_checked';
      }
      if (accessDecision.video_watch_limit_status === 'not_checked' && error?.code === 'VIDEO_WATCH_LIMIT_REACHED') {
        accessDecision.video_watch_limit_status = 'reached';
      }
      logPlaybackAccessDecision('warn');
      throw error;
    }
  },

  async delete(id) {
    if (isPostgresMode()) {
      await pgExec('DELETE FROM users WHERE id = $1', [String(id)]);
      try {
        await deleteRedisKey(cacheKey('user', String(id)));
        await deleteRedisKey(cacheKey('user-session', String(id)));
      } catch (error) {}
      invalidateGlobalPlatformCaches();
      invalidateUserPlatformCaches(id);
      return true;
    }

    if (isMongoMode()) {
      await User.findByIdAndDelete(id);
      return true;
    }

    const index = state.users.findIndex((user) => user._id === String(id));
    if (index >= 0) {
      state.users.splice(index, 1);
      return true;
    }

    return false;
  },
};

const testsRepository = {
  async list() {
    await ensurePlatformReady();

    const cacheKeyTests = cacheKey('tests', 'list');
    const testsCacheTtlMs = Math.max(1000, Number(appConfig.testsCacheTtlMs || platformDataCacheTtlMs));

    try {
      const cached = await getRedisJson(cacheKeyTests);
      if (cached) {
        return cached;
      }
    } catch (e) {
      // ignore
    }

    let tests;
    if (isPostgresMode()) {
      tests = await getPgTests();
    } else if (isMongoMode()) {
      tests = await Test.find().lean();
    } else {
      tests = state.tests.map((test) => clone(test));
    }

    try {
      await setRedisJson(cacheKeyTests, tests, { ttlSeconds: Math.ceil(testsCacheTtlMs / 1000) });
    } catch (e) {}

    return tests;
  },

  async listForAttempt({ userId = null, userRole = 'guest' } = {}) {
    const tests = await testsRepository.list();
    const enrolledCourseIds = await getActiveEnrollmentCourseIds(userId);
    return tests
      .filter((test) => canAccessLinkedTestWithCourseIds(test, enrolledCourseIds, userRole))
      .map((test) => redactTestForAttempt(test));
  },

  async findById(id) {
    await ensurePlatformReady();

    const cacheKeyTest = cacheKey('test', String(id));
    const ttlSeconds = TEST_LOOKUP_CACHE_TTL_SECONDS;

    if (!isMongoMode()) {
      return getCachedJsonValue(cacheKeyTest, async () => {
        if (isPostgresMode()) {
          return pgOne('SELECT * FROM tests WHERE id = $1', [String(id)], mapTestRow);
        }

        return clone(state.tests.find((test) => test._id === String(id)) || null);
      }, ttlSeconds);
    }

    return Test.findById(id).lean();
  },

  async findAttemptById(id, { userId = null, userRole = 'guest' } = {}) {
    const test = await testsRepository.findById(id);
    if (!test) {
      return null;
    }

    const enrolledCourseIds = await getActiveEnrollmentCourseIds(userId);
    return canAccessLinkedTestWithCourseIds(test, enrolledCourseIds, userRole)
      ? redactTestForAttempt(test)
      : null;
  },

  async create(payload) {
    await assertLinkedCourseForMockTest(payload);

    if (isPostgresMode()) {
      const test = await upsertPgTest(payload);
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('test', String(test._id)));
      } catch (error) {}
      return clone(test);
    }

    if (isMongoMode()) {
      const createdTest = await Test.create(payload);
      return createdTest.toObject();
    }

    const questions = Array.isArray(payload.questions)
      ? payload.questions.map((question, index) => {
          const normalizedCorrectOptions = Array.isArray(question.correctOptions) && question.correctOptions.length > 0
            ? [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
            : Number.isFinite(Number(question.correctOption ?? question.answer))
              ? [Number(question.correctOption ?? question.answer)]
              : [0];

          return {
            ...clone(question),
            id: question.id || nextId(`question_${index + 1}`),
            answer: normalizedCorrectOptions[0],
            correctOption: normalizedCorrectOptions[0],
            correctOptions: normalizedCorrectOptions,
            explanation: question.explanation || '',
            marks: Number(question.marks || 1),
            topic: question.topic || 'General Practice',
          };
        })
      : [];

    const createdTest = {
      _id: payload._id || nextId('test'),
      title: payload.title,
      description: payload.description || '',
      category: payload.category || 'SSC JE',
      type: payload.type || 'full-length',
      durationMinutes: Number(payload.durationMinutes || 60),
      totalMarks: Number(payload.totalMarks || questions.reduce((sum, question) => sum + Number(question.marks || 1), 0)),
      negativeMarking: Number(payload.negativeMarking || 0),
      companionVideo: payload.companionVideo && typeof payload.companionVideo === 'object'
        ? clone(payload.companionVideo)
        : null,
      sectionBreakup: Array.isArray(payload.sectionBreakup) ? clone(payload.sectionBreakup) : [],
      course: payload.course || null,
      questions,
      created_at: payload.created_at || nowIso(),
    };

    state.tests.push(createdTest);
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('test', String(createdTest._id)));
    } catch (error) {}
    return clone(createdTest);
  },

  async update(testId, payload) {
    await ensurePlatformReady();
    const current = await testsRepository.findById(testId);
    if (!current) {
      return null;
    }

    const nextPayload = {
      ...current,
      ...clone(payload || {}),
      _id: current._id,
      created_at: current.created_at || nowIso(),
    };

    await assertLinkedCourseForMockTest(nextPayload);

    if (isPostgresMode()) {
      const updatedTest = await upsertPgTest(nextPayload);
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('test', String(testId)));
      } catch (error) {}
      return updatedTest;
    }

    if (isMongoMode()) {
      const updatedTest = await Test.findByIdAndUpdate(
        testId,
        nextPayload,
        { new: true, overwrite: true },
      );
      return updatedTest ? updatedTest.toObject() : null;
    }

    const index = state.tests.findIndex((test) => test._id === String(testId));
    if (index === -1) {
      return null;
    }

    const questions = Array.isArray(nextPayload.questions)
      ? nextPayload.questions.map((question, questionIndex) => {
          const normalizedCorrectOptions = Array.isArray(question.correctOptions) && question.correctOptions.length > 0
            ? [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
            : Number.isFinite(Number(question.correctOption ?? question.answer))
              ? [Number(question.correctOption ?? question.answer)]
              : [0];

          return {
            ...clone(question),
            id: question.id || nextId(`question_${questionIndex + 1}`),
            answer: normalizedCorrectOptions[0],
            correctOption: normalizedCorrectOptions[0],
            correctOptions: normalizedCorrectOptions,
            explanation: question.explanation || '',
            marks: Number(question.marks || 1),
            topic: question.topic || 'General Practice',
          };
        })
      : [];

    const updatedTest = {
      _id: current._id,
      title: nextPayload.title,
      description: nextPayload.description || '',
      category: nextPayload.category || 'SSC JE',
      type: nextPayload.type || 'full-length',
      durationMinutes: Number(nextPayload.durationMinutes || 60),
      totalMarks: Number(nextPayload.totalMarks || questions.reduce((sum, question) => sum + Number(question.marks || 1), 0)),
      negativeMarking: Number(nextPayload.negativeMarking || 0),
      companionVideo: nextPayload.companionVideo && typeof nextPayload.companionVideo === 'object'
        ? clone(nextPayload.companionVideo)
        : null,
      sectionBreakup: Array.isArray(nextPayload.sectionBreakup) ? clone(nextPayload.sectionBreakup) : [],
      course: nextPayload.course || null,
      questions,
      created_at: current.created_at || nowIso(),
    };

    state.tests[index] = updatedTest;
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('test', String(testId)));
    } catch (error) {}
    return clone(updatedTest);
  },

  async updateCompanionVideo(testId, updater) {
    await ensurePlatformReady();
    const current = await testsRepository.findById(testId);
    if (!current) {
      return null;
    }

    const nextCompanionVideo = updater(clone(current.companionVideo || null), clone(current));
    const updated = await testsRepository.update(testId, {
      ...current,
      companionVideo: nextCompanionVideo,
    });
    return updated;
  },

  async delete(testId) {
    await ensurePlatformReady();

    const existing = await testsRepository.findById(testId);

    if (isPostgresMode()) {
      await pgExec('DELETE FROM tests WHERE id = $1', [String(testId)]);
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('test', String(testId)));
      } catch (error) {}
      if (existing?.companionVideo?.storagePath) {
        const { deleteStoredPrivateVideo } = require('./private-video-storage.js');
        const { deleteProcessedHlsAssets } = require('./video-processing.js');
        await deleteStoredPrivateVideo({
          storageProvider: existing.companionVideo.storageProvider,
          storagePath: existing.companionVideo.storagePath,
        });
        await deleteProcessedHlsAssets(existing.companionVideo.hlsManifestPath, existing.companionVideo.hlsStorageProvider || null);
      }
      return true;
    }

    if (isMongoMode()) {
      await Test.findByIdAndDelete(testId);
      return true;
    }

    const index = state.tests.findIndex((test) => test._id === String(testId));
    if (index === -1) {
      return false;
    }

    state.tests.splice(index, 1);
    state.testAttempts = state.testAttempts.filter((attempt) => attempt.testId !== String(testId));
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('test', String(testId)));
    } catch (error) {}
    if (existing?.companionVideo?.storagePath) {
      const { deleteStoredPrivateVideo } = require('./private-video-storage.js');
      const { deleteProcessedHlsAssets } = require('./video-processing.js');
      await deleteStoredPrivateVideo({
        storageProvider: existing.companionVideo.storageProvider,
        storagePath: existing.companionVideo.storagePath,
      });
      await deleteProcessedHlsAssets(existing.companionVideo.hlsManifestPath, existing.companionVideo.hlsStorageProvider || null);
    }
    return true;
  },

  async getProtectedVideoPlayback(testId, { userId = null, userRole = 'guest', user = null, requestContext = null } = {}) {
    const test = await testsRepository.findById(testId);
    if (!test) {
      throw new ApiError(404, 'Test not found', { code: 'TEST_NOT_FOUND' });
    }

    const video = test.companionVideo && typeof test.companionVideo === 'object' ? test.companionVideo : null;
    if (!video || !video.storagePath) {
      throw new ApiError(404, 'Test video not found', { code: 'TEST_VIDEO_NOT_FOUND' });
    }

    const resolvedUser = user || (userId ? await usersRepository.findSafeById(userId) : null);
    if (!resolvedUser) {
      throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
    }

    if (userRole !== 'admin') {
      const linkedCourseId = getLinkedCourseIdForTest(test);
      if (!linkedCourseId) {
        throw new ApiError(403, 'This mock test is not linked to a course yet.', {
          code: 'TEST_COURSE_LINK_REQUIRED',
          details: {
            testId: test._id,
          },
        });
      }

      const hasAccess = await hasActiveEnrollmentForCourse(String(resolvedUser._id || userId), linkedCourseId);
      if (!hasAccess) {
        throw new ApiError(403, 'Course enrollment is required to access this test video', {
          code: 'TEST_ENROLLMENT_REQUIRED',
          details: {
            testId: test._id,
            courseId: linkedCourseId,
          },
        });
      }
    }

    const linkedCourseId = getLinkedCourseIdForTest(test) || `test:${String(test._id)}`;
    const hlsReady = video.deliveryStrategy === 'hls'
      && video.hlsProcessingStatus === 'ready'
      && video.hlsPlaybackPath;
    const sourceReady = Boolean(video.storagePath);
    const sourceFallbackAllowed = Boolean(video.sourceFallbackAllowed ?? appConfig.sourcePlaybackFallbackEnabled);

    const playbackPath = hlsReady ? String(video.hlsPlaybackPath) : String(video.storagePath);
    const playbackMimeType = hlsReady ? 'application/vnd.apple.mpegurl' : (video.mimeType || 'video/mp4');
    const playbackProvider = hlsReady
      ? (video.hlsStorageProvider || video.storageProvider || 'local')
      : (video.storageProvider || 'local');
    const playbackBundlePath = String(video.hlsManifestRootPath || '').trim();
    const playbackBundleVersion = String(video.hlsManifestVersion || '').trim();
    const drmConfig = null;
    const allowSourceFallback = !drmConfig && sourceFallbackAllowed;
    const { playbackSession, watchState } = await videoPlaybackRepository.startPlaybackSession({
      userId: String(resolvedUser._id || userId),
      courseId: linkedCourseId,
      lessonId: null,
      videoId: video.id || test._id,
      videoType: EXPLANATION_VIDEO_TYPE,
      videoDurationSeconds: Number(video.durationMinutes || 0) * 60,
      authSessionId: resolvedUser.session || null,
      requestContext,
      ipAddress: requestContext?.ipAddress || null,
      userAgent: requestContext?.userAgent || null,
    });

    const sourceIssuedToken = allowSourceFallback && sourceReady
      ? issuePlaybackToken({
        userId: String(resolvedUser._id || userId),
        sessionId: resolvedUser.session || null,
        testId: String(test._id),
        courseId: linkedCourseId,
        videoId: String(video.id || test._id),
        videoType: EXPLANATION_VIDEO_TYPE,
        playbackSessionId: playbackSession.playbackSessionId,
        userAgentHash: requestContext?.userAgentHash || null,
        storageProvider: video.storageProvider || 'local',
        storagePath: String(video.storagePath),
        mimeType: video.mimeType || 'video/mp4',
        assetKind: 'source',
      })
      : null;

    const issuedToken = hlsReady
      ? (
        shouldUseManifestBundlePlaybackRoute()
          ? buildManifestBundleUrl({
            storageProvider: playbackProvider,
            bundlePath: playbackBundlePath || path.posix.dirname(playbackPath),
            version: playbackBundleVersion || 'legacy',
          }, {
            assetPath: 'master.m3u8',
          })
          : buildCompactAssetUrl({
            storageProvider: playbackProvider,
            storagePath: playbackPath,
            cacheScope: 'shared-hls-manifest',
          })
      )
      : issuePlaybackToken({
        userId: String(resolvedUser._id || userId),
        sessionId: resolvedUser.session || null,
        testId: String(test._id),
        courseId: linkedCourseId,
        videoId: String(video.id || test._id),
        videoType: EXPLANATION_VIDEO_TYPE,
        playbackSessionId: playbackSession.playbackSessionId,
        userAgentHash: requestContext?.userAgentHash || null,
        storageProvider: playbackProvider,
        storagePath: playbackPath,
        mimeType: playbackMimeType,
        assetKind: 'source',
      });

    return {
      playerType: 'private-video',
      embedUrl: null,
      streamUrl: hlsReady ? issuedToken.url : `/backend/api/tests/stream/${issuedToken.token}`,
      drmConfig,
      fallbackStreamUrl: hlsReady && sourceIssuedToken ? `/backend/api/tests/stream/${sourceIssuedToken.token}` : null,
      fallbackStreamFormat: hlsReady && sourceIssuedToken ? 'source' : null,
      fallbackReason: hlsReady && sourceIssuedToken
        ? 'Protected source playback is available if the adaptive stream cannot load.'
        : null,
      streamFormat: hlsReady ? 'hls' : 'source',
      playbackStatus: hlsReady ? 'ready' : (video.hlsProcessingStatus || 'ready'),
      deliveryProfile: video.deliveryProfile || 'private-source',
      availableQualities: asArray(video.targetQualities),
      statusMessage: hlsReady
        ? 'Adaptive test-series stream ready.'
        : video.hlsProcessingStatus === 'processing' || video.hlsProcessingStatus === 'queued'
          ? 'Adaptive HLS processing is running. Protected source playback is temporarily available.'
          : video.hlsProcessingError
            ? 'Adaptive HLS processing failed. Protected source playback is temporarily available.'
            : 'Protected test-series video ready.',
      watermarkText: buildPlaybackWatermarkText(resolvedUser),
      resumeSeconds: resolveProtectedLessonResumeSeconds({
        watchState,
        lessonProgress: null,
        durationSeconds: Number(video.durationMinutes || 0) * 60,
      }),
      completed: false,
      tokenExpiresAt: issuedToken.expiresAt,
      drmEnabled: Boolean(drmConfig),
      courseId: linkedCourseId,
      videoId: String(video.id || test._id),
      playbackSessionId: playbackSession.playbackSessionId,
      videoType: EXPLANATION_VIDEO_TYPE,
      watchLimit: watchState.allowedFullWatches,
      watchCompletionPercent: watchState.fullWatchThresholdPercentage,
      watchState: buildVideoWatchStateSummary(watchState),
    };
  },

  async submit(testId, payload) {
    await ensurePlatformReady();
    const test = await testsRepository.findById(testId);
    if (!test) {
      return null;
    }

    const userRole = String(payload?.userRole || 'student');
    if (payload?.userId && userRole !== 'admin') {
      if (isPostgresMode()) {
        const existingAttempt = await pgOne(
          'SELECT * FROM test_attempts WHERE user_id = $1 AND test_id = $2 ORDER BY completed_at DESC LIMIT 1',
          [String(payload.userId), String(test._id)],
          mapTestAttemptRow,
        );
        if (existingAttempt) {
          return existingAttempt;
        }
      } else {
        const existingAttempt = state.testAttempts
          .filter((attempt) => attempt.userId === String(payload.userId) && attempt.testId === String(test._id))
          .sort((left, right) => sortRecentFirst(left, right, 'completedAt'))[0];
        if (existingAttempt) {
          return clone(existingAttempt);
        }
      }
    }

    if (userRole !== 'admin') {
      const linkedCourseId = getLinkedCourseIdForTest(test);
      if (!linkedCourseId) {
        throw new ApiError(403, 'This mock test is not linked to a course yet.', {
          code: 'TEST_COURSE_LINK_REQUIRED',
          details: {
            testId: test._id,
          },
        });
      }

      const hasAccess = await hasActiveEnrollmentForCourse(payload.userId, linkedCourseId);
      if (!hasAccess) {
        throw new ApiError(403, 'Course enrollment is required to access this test series', {
          code: 'TEST_ENROLLMENT_REQUIRED',
          details: {
            testId: test._id,
            courseId: linkedCourseId,
          },
        });
      }
    }

    const answers = payload.answers || {};
    let score = 0;
    let correctCount = 0;
    let incorrectCount = 0;
    let unattemptedCount = 0;
    const topicStats = new Map();

    test.questions.forEach((question) => {
      const submittedAnswer = answers[question.id];
      const submittedOptionIndexes = Array.isArray(submittedAnswer)
        ? [...new Set(submittedAnswer.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
        : submittedAnswer === undefined || submittedAnswer === null
          ? []
          : [Number(submittedAnswer)].filter((option) => Number.isInteger(option) && option >= 0);
      const correctOptionIndexes = Array.isArray(question.correctOptions) && question.correctOptions.length > 0
        ? [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
        : Number.isFinite(Number(question.correctOption ?? question.answer))
          ? [Number(question.correctOption ?? question.answer)]
          : [0];
      const topic = question.topic || 'General Practice';
      const currentStats = topicStats.get(topic) || { correct: 0, incorrect: 0 };

      if (submittedOptionIndexes.length === 0) {
        unattemptedCount += 1;
      } else if (
        submittedOptionIndexes.length === correctOptionIndexes.length
        && submittedOptionIndexes.every((option, optionIndex) => option === correctOptionIndexes[optionIndex])
      ) {
        correctCount += 1;
        score += Number(question.marks || 1);
        currentStats.correct += 1;
      } else {
        incorrectCount += 1;
        score -= Number(test.negativeMarking || 0);
        currentStats.incorrect += 1;
      }

      topicStats.set(topic, currentStats);
    });

    const solutions = test.questions.map((question) => ({
      questionId: question.id,
      questionText: question.questionText,
      selectedOption: Array.isArray(answers[question.id]) ? null : answers[question.id] ?? null,
      selectedOptions: Array.isArray(answers[question.id])
        ? [...new Set(answers[question.id].map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
        : answers[question.id] === undefined || answers[question.id] === null
          ? []
          : [Number(answers[question.id])].filter((option) => Number.isInteger(option) && option >= 0),
      correctOption: Array.isArray(question.correctOptions) && question.correctOptions.length > 0
        ? Number(question.correctOptions[0])
        : Number(question.correctOption ?? question.answer),
      correctOptions: Array.isArray(question.correctOptions) && question.correctOptions.length > 0
        ? [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
        : Number.isFinite(Number(question.correctOption ?? question.answer))
          ? [Number(question.correctOption ?? question.answer)]
          : [0],
      explanation: question.explanation || '',
      topic: question.topic || 'General Practice',
    }));

    const weakTopics = [];
    const strongTopics = [];
    topicStats.forEach((stats, topic) => {
      if (stats.incorrect > stats.correct) {
        weakTopics.push(topic);
      } else if (stats.correct > 0) {
        strongTopics.push(topic);
      }
    });

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const ranking = await pgOne(
          'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE score > $1)::int AS higher FROM test_attempts',
          [Number(score)],
          (row) => ({
            total: Number(row.total || 0),
            higher: Number(row.higher || 0),
          }),
          client,
        );
        const totalAttempts = Number(ranking?.total || 0) + 1;
        const higherAttempts = Number(ranking?.higher || 0);
        const rank = higherAttempts + 1;
        const percentile = totalAttempts === 0
          ? 0
          : Number((((totalAttempts - rank) / totalAttempts) * 100).toFixed(2));

        const attempt = await insertPgTestAttempt({
          userId: payload.userId,
          testId: test._id,
          score: Number(score.toFixed(2)),
          totalMarks: Number(test.totalMarks || 0),
          correctCount,
          incorrectCount,
          unattemptedCount,
          percentile,
          rank,
          answers,
          weakTopics,
          strongTopics,
          solutions,
          startedAt: payload.startedAt || nowIso(),
          completedAt: nowIso(),
        }, client);

        const user = await pgOne('SELECT * FROM users WHERE id = $1', [String(payload.userId)], mapUserRow, client);
        if (user) {
          await upsertPgUser({
            ...user,
            points: Number(user.points || 0) + Math.max(Math.round(score), 0),
          }, client);
        }

        queueBestEffortDeviceActivity({
          userId: payload.userId,
          eventType: 'mock_test_submitted',
          meta: {
            testId: test._id,
            score: attempt.score,
            percentile: attempt.percentile,
          },
        });

        invalidateGlobalPlatformCaches();
        invalidateUserPlatformCaches(payload.userId);
        return attempt;
      });
    }

    const rankedAttempts = [...state.testAttempts, { score }].sort((left, right) => Number(right.score) - Number(left.score));
    const rank = rankedAttempts.findIndex((attempt) => Number(attempt.score) === score) + 1;
    const percentile = rankedAttempts.length === 0
      ? 0
      : Number((((rankedAttempts.length - rank) / rankedAttempts.length) * 100).toFixed(2));

    const attempt = {
      _id: nextId('attempt'),
      userId: String(payload.userId),
      testId: test._id,
      score: Number(score.toFixed(2)),
      totalMarks: Number(test.totalMarks || 0),
      correctCount,
      incorrectCount,
      unattemptedCount,
      percentile,
      rank,
      answers: clone(answers),
      weakTopics,
      strongTopics,
      solutions,
      startedAt: payload.startedAt || nowIso(),
      completedAt: nowIso(),
    };

    state.testAttempts.push(attempt);
    invalidateGlobalPlatformCaches();

    const user = state.users.find((item) => item._id === String(payload.userId));
    if (user) {
      user.points += Math.max(Math.round(score), 0);
    }

    queueBestEffortDeviceActivity({
      userId: payload.userId,
      eventType: 'mock_test_submitted',
      meta: {
        testId: test._id,
        score: attempt.score,
        percentile: attempt.percentile,
      },
    });

    return clone(attempt);
  },

  async listAttempts(userId) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return pgMany(
        'SELECT * FROM test_attempts WHERE user_id = $1 ORDER BY completed_at DESC',
        [String(userId)],
        mapTestAttemptRow,
      );
    }

    return state.testAttempts
      .filter((attempt) => attempt.userId === String(userId))
      .sort((left, right) => sortRecentFirst(left, right, 'completedAt'))
      .map((attempt) => clone(attempt));
  },
};

const quizzesRepository = {
  async create(payload) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const quiz = await upsertPgQuiz(payload);
      invalidateGlobalPlatformCaches();
      invalidateQuizCaches({ quizId: quiz._id, quizDate: quiz.date });
      return quiz;
    }

    const quizDate = String(payload.date || '').slice(0, 10);
    const existingQuizIndex = state.quizzes.findIndex((quiz) => quiz.date === quizDate);

    const createdQuiz = {
      _id: existingQuizIndex >= 0 ? state.quizzes[existingQuizIndex]._id : payload._id || nextId('quiz'),
      date: quizDate,
      questions: Array.isArray(payload.questions) ? clone(payload.questions) : [],
      leaderboard: existingQuizIndex >= 0 ? state.quizzes[existingQuizIndex].leaderboard : [],
      createdAt: payload.createdAt || nowIso(),
    };

    if (existingQuizIndex >= 0) {
      state.quizzes[existingQuizIndex] = createdQuiz;
    } else {
      state.quizzes.push(createdQuiz);
    }
    invalidateGlobalPlatformCaches();
    invalidateQuizCaches({ quizId: createdQuiz._id, quizDate: createdQuiz.date });

    return clone(createdQuiz);
  },

  async findByDate(date) {
    await ensurePlatformReady();
    const dateKey = String(date).slice(0, 10);
    const cacheKeyQuizDate = cacheKey('quiz', `date:${dateKey}`);
    const quizCacheTtlMs = Math.max(500, Number(appConfig.quizCacheTtlMs || 3000));

    try {
      const cached = await getRedisJson(cacheKeyQuizDate);
      if (cached) return cached;
    } catch (e) {}

    if (isPostgresMode()) {
      const quiz = await pgOne(
        'SELECT * FROM daily_quizzes WHERE quiz_date = $1',
        [String(date).slice(0, 10)],
        mapQuizRow,
      );
      if (!quiz) {
        return null;
      }

      const leaderboard = await quizzesRepository.getLeaderboard(quiz._id);
      return {
        ...quiz,
        leaderboard: leaderboard ? normalizeQuizLeaderboard(leaderboard) : [],
      };
    }

    const result = clone(state.quizzes.find((quiz) => quiz.date === String(date).slice(0, 10)) || null);
    try {
      await setRedisJson(cacheKeyQuizDate, result, { ttlSeconds: Math.ceil(quizCacheTtlMs / 1000) });
    } catch (e) {}
    return result;
  },

  async findById(id) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const quiz = await pgOne('SELECT * FROM daily_quizzes WHERE id = $1', [String(id)], mapQuizRow);
      if (!quiz) {
        return null;
      }

      const leaderboard = await quizzesRepository.getLeaderboard(quiz._id);
      return {
        ...quiz,
        leaderboard: leaderboard ? normalizeQuizLeaderboard(leaderboard) : [],
      };
    }

    return clone(state.quizzes.find((quiz) => quiz._id === String(id)) || null);
  },

  async submitAttempt({ quizId, userId, answers }) {
    await ensurePlatformReady();
    const quiz = await quizzesRepository.findById(quizId);
    if (!quiz) {
      return null;
    }

    const submittedAnswers = Array.isArray(answers) ? answers : [];
    const score = quiz.questions.reduce((total, question, index) => (
      submittedAnswers[index] === question.answer ? total + 1 : total
    ), 0);

    const review = quiz.questions.map((question, index) => ({
      questionId: question.id,
      prompt: question.prompt,
      selectedAnswer: submittedAnswers[index] || '',
      correctAnswer: question.answer,
      explanation: question.explanation || '',
      topic: question.topic || 'General Practice',
    }));

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const { attempt, existing } = await upsertPgQuizAttempt({
          quizId,
          userId,
          score,
          total: quiz.questions.length,
          submittedAt: nowIso(),
        }, client);

        const user = await pgOne('SELECT * FROM users WHERE id = $1', [String(userId)], mapUserRow, client);
        if (user) {
          const priorScore = existing ? Number(existing.score || 0) : 0;
          const pointsDelta = Math.max(score - priorScore, 0) * 10;
          const nextPoints = Number(user.points || 0) + pointsDelta;
          const nextStreak = Number(user.streak || 0) + (existing ? 0 : 1);
          const nextBadges = asArray(user.badges);
          if (nextPoints >= 50 && !nextBadges.some((badge) => badge.code === 'quiz_starter')) {
            nextBadges.push({ code: 'quiz_starter', label: 'Quiz Starter' });
          }

          await upsertPgUser({
            ...user,
            points: nextPoints,
            streak: nextStreak,
            badges: nextBadges,
          }, client);

          queueBestEffortDeviceActivity({
            userId: user._id,
            sessionId: user.session,
            device: user.device,
            eventType: 'daily_quiz_submitted',
            meta: {
              quizId: quiz._id,
              score,
              total: quiz.questions.length,
            },
          });
        }

    invalidateQuizCaches({ quizId: quiz._id, quizDate: quiz.date });
    invalidateUserPlatformCaches(userId);
    return {
          score,
          total: quiz.questions.length,
          leaderboardEntry: {
            userId: String(userId),
            score,
            total: quiz.questions.length,
            submittedAt: attempt.submittedAt,
          },
          review,
        };
      });
    }

    const quizIndex = state.quizzes.findIndex((item) => item._id === String(quizId));
    const entry = {
      userId: String(userId),
      score,
      total: quiz.questions.length,
      submittedAt: nowIso(),
    };

    state.quizzes[quizIndex].leaderboard.push(entry);
    invalidateQuizCaches({ quizId: quiz._id, quizDate: quiz.date });

    const user = state.users.find((item) => item._id === String(userId));
    if (user) {
      user.points += score * 10;
      user.streak += 1;
      if (user.points >= 50 && !user.badges.some((badge) => badge.code === 'quiz_starter')) {
        user.badges.push({ code: 'quiz_starter', label: 'Quiz Starter' });
      }

      state.deviceActivities.unshift({
        _id: nextId('activity'),
        userId: user._id,
        sessionId: user.session,
        device: user.device,
        eventType: 'daily_quiz_submitted',
        meta: {
          quizId: quiz._id,
          score,
          total: quiz.questions.length,
        },
        createdAt: nowIso(),
      });
      state.deviceActivities = state.deviceActivities.slice(0, 200);
    }

    return {
      score,
      total: quiz.questions.length,
      leaderboardEntry: clone(entry),
      review,
    };
  },

  async getLeaderboard(quizId) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const cached = await getRedisJson(cacheKey('quiz-leaderboard', String(quizId)));
      if (cached) {
        return cached;
      }

      const leaderboard = await pgMany(
        `
          SELECT a.*, u.full_name
          FROM daily_quiz_attempts a
          JOIN users u ON u.id = a.user_id
          WHERE a.daily_quiz_id = $1
          ORDER BY a.score DESC, a.submitted_at ASC
        `,
        [String(quizId)],
        (row) => ({
          userId: row.user_id,
          score: Number(row.score || 0),
          total: Number(row.total || 0),
          submittedAt: toIso(row.submitted_at) || nowIso(),
          name: row.full_name,
        }),
      );

      if (leaderboard.length > 0) {
        await setRedisJson(cacheKey('quiz-leaderboard', String(quizId)), leaderboard, { ttlSeconds: redisJsonTtl });
      }

      return leaderboard;
    }

    const quiz = state.quizzes.find((item) => item._id === String(quizId));
    if (!quiz) {
      return null;
    }

    return normalizeQuizLeaderboard(quiz.leaderboard);
  },

  async getWeeklyLeaderboard() {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const cached = await getRedisJson(cacheKey('quiz-weekly', 'all'));
      if (cached) {
        return cached;
      }

      const weeklyLeaderboard = await pgMany(
        `
          SELECT
            a.user_id,
            u.full_name,
            SUM(a.score)::int AS score,
            SUM(a.total)::int AS total,
            COUNT(*)::int AS attempts,
            MIN(a.submitted_at) AS submitted_at
          FROM daily_quiz_attempts a
          JOIN daily_quizzes q ON q.id = a.daily_quiz_id
          JOIN users u ON u.id = a.user_id
          WHERE q.quiz_date >= CURRENT_DATE - INTERVAL '6 days'
          GROUP BY a.user_id, u.full_name
          ORDER BY SUM(a.score) DESC, MIN(a.submitted_at) ASC
        `,
        [],
        (row) => ({
          userId: row.user_id,
          name: row.full_name,
          score: Number(row.score || 0),
          total: Number(row.total || 0),
          attempts: Number(row.attempts || 0),
          submittedAt: toIso(row.submitted_at) || nowIso(),
        }),
      );

      await setRedisJson(cacheKey('quiz-weekly', 'all'), weeklyLeaderboard, { ttlSeconds: redisJsonTtl });
      return weeklyLeaderboard;
    }

    const weekStart = new Date();
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    weekStart.setUTCHours(0, 0, 0, 0);

    const aggregated = new Map();

    state.quizzes.forEach((quiz) => {
      const quizDate = new Date(`${quiz.date}T00:00:00.000Z`);
      if (Number.isNaN(quizDate.getTime()) || quizDate < weekStart) {
        return;
      }

      quiz.leaderboard.forEach((entry) => {
        const current = aggregated.get(entry.userId) || {
          userId: entry.userId,
          score: 0,
          total: 0,
          attempts: 0,
          submittedAt: entry.submittedAt,
        };

        current.score += Number(entry.score || 0);
        current.total += Number(entry.total || 0);
        current.attempts += 1;
        if (new Date(entry.submittedAt) < new Date(current.submittedAt)) {
          current.submittedAt = entry.submittedAt;
        }

        aggregated.set(entry.userId, current);
      });
    });

    return Array.from(aggregated.values()).sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return sortOldestFirst(left, right, 'submittedAt');
    });
  },

  async listLeaderboardEntries() {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return pgMany(
        `
          SELECT a.id, a.daily_quiz_id, a.user_id, a.score, a.total, a.submitted_at, q.quiz_date
          FROM daily_quiz_attempts a
          JOIN daily_quizzes q ON q.id = a.daily_quiz_id
          ORDER BY a.submitted_at DESC
        `,
        [],
        (row) => ({
          quizId: row.daily_quiz_id,
          date: typeof row.quiz_date === 'string' ? row.quiz_date.slice(0, 10) : toIso(row.quiz_date).slice(0, 10),
          userId: row.user_id,
          score: Number(row.score || 0),
          total: Number(row.total || 0),
          submittedAt: toIso(row.submitted_at) || nowIso(),
        }),
      );
    }

    return state.quizzes.flatMap((quiz) =>
      quiz.leaderboard.map((entry) => ({
        quizId: quiz._id,
        date: quiz.date,
        ...clone(entry),
      })),
    );
  },
};

const notificationsRepository = {
  async list(userId, options = {}) {
    await ensurePlatformReady();

    const requestedLimit = Number(options.limit || 0);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.max(1, Math.min(Math.floor(requestedLimit), 100))
      : null;
    const cacheScope = userId ? `user:${userId}` : 'list';
    const cacheKeyNotifications = cacheKey('notifications', limit ? `${cacheScope}:limit:${limit}` : cacheScope);
    const notificationsCacheTtlMs = Math.max(500, Number(appConfig.notificationsCacheTtlMs || 2000));

    try {
      const cached = await getRedisJson(cacheKeyNotifications);
      if (cached) return cached;
    } catch (e) {}

    if (isPostgresMode()) {
      if (userId) {
        const params = [String(userId)];
        let sql = 'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC';
        if (limit) {
          params.push(limit);
          sql += ' LIMIT $2';
        }
        const rows = await pgMany(
          sql,
          params,
          mapNotificationRow,
        );
        try { await setRedisJson(cacheKeyNotifications, rows, { ttlSeconds: Math.ceil(notificationsCacheTtlMs / 1000) }); } catch (e) {}
        return rows;
      }

      const all = await getPgNotifications();
      try { await setRedisJson(cacheKeyNotifications, all, { ttlSeconds: Math.ceil(notificationsCacheTtlMs / 1000) }); } catch (e) {}
      return all;
    }

    const items = userId
      ? state.notifications.filter((notification) => notification.userId === String(userId))
      : state.notifications;

    const result = items
      .slice()
      .sort((left, right) => sortNewestFirst(left, right, 'createdAt'))
      .slice(0, limit || undefined)
      .map((item) => clone(item));

    try { await setRedisJson(cacheKeyNotifications, result, { ttlSeconds: Math.ceil(notificationsCacheTtlMs / 1000) }); } catch (e) {}
    return result;
  },

  async count(userId) {
    await ensurePlatformReady();

    if (!userId) {
      return Number(state.notifications?.length || 0);
    }

    const cacheKeyNotificationsCount = cacheKey('notifications-count', `user:${userId}`);
    const notificationsCacheTtlMs = Math.max(500, Number(appConfig.notificationsCacheTtlMs || 2000));
    try {
      const cached = await getRedisJson(cacheKeyNotificationsCount);
      if (cached !== null && cached !== undefined) {
        return Number(cached || 0);
      }
    } catch (e) {}

    let total = 0;
    if (isPostgresMode()) {
      total = await pgOne(
        'SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = $1 AND is_read = FALSE',
        [String(userId)],
        (row) => Number(row.total || 0),
      );
    } else {
      total = state.notifications.filter((notification) => notification.userId === String(userId) && !notification.isRead).length;
    }

    try {
      await setRedisJson(cacheKeyNotificationsCount, total, { ttlSeconds: Math.ceil(notificationsCacheTtlMs / 1000) });
    } catch (e) {}
    return total;
  },

  async create(payload) {
    if (isPostgresMode()) {
      const notification = await insertPgNotification(payload);
      invalidateUserPlatformCaches(notification.userId);
      return notification;
    }

    const notificationId = payload._id || nextId('notification');
    const existingIndex = state.notifications.findIndex((item) => item._id === String(notificationId));
    const notification = {
      _id: String(notificationId),
      userId: String(payload.userId),
      title: payload.title || 'Notification',
      message: payload.message || '',
      type: payload.type || 'general',
      entityId: payload.entityId ? String(payload.entityId) : null,
      actionUrl: payload.actionUrl || null,
      actionLabel: payload.actionLabel || null,
      payload: asObject(payload.payload),
      isRead: Boolean(payload.isRead),
      readAt: payload.readAt || null,
      createdAt: nowIso(),
    };

    if (existingIndex >= 0) {
      state.notifications[existingIndex] = {
        ...state.notifications[existingIndex],
        ...notification,
        createdAt: state.notifications[existingIndex].createdAt || notification.createdAt,
      };
      invalidateUserPlatformCaches(notification.userId);
      return clone(state.notifications[existingIndex]);
    }

    state.notifications.push(notification);
    invalidateUserPlatformCaches(notification.userId);
    return clone(notification);
  },

  async markRead(userId, notificationId) {
    await ensurePlatformReady();
    const now = nowIso();

    if (isPostgresMode()) {
      const notification = await pgOne(
        `
          UPDATE notifications
          SET is_read = TRUE,
              read_at = COALESCE(read_at, $3)
          WHERE id = $1 AND user_id = $2
          RETURNING *
        `,
        [String(notificationId), String(userId), now],
        mapNotificationRow,
      );
      if (!notification) {
        return null;
      }
      invalidateUserPlatformCaches(String(userId));
      return notification;
    }

    const entry = state.notifications.find((notification) =>
      notification._id === String(notificationId) && notification.userId === String(userId));
    if (!entry) {
      return null;
    }
    entry.isRead = true;
    entry.readAt = entry.readAt || now;
    invalidateUserPlatformCaches(String(userId));
    return clone(entry);
  },

  async markAllRead(userId) {
    await ensurePlatformReady();
    const now = nowIso();

    if (isPostgresMode()) {
      const result = await pgExec(
        `
          UPDATE notifications
          SET is_read = TRUE,
              read_at = COALESCE(read_at, $2)
          WHERE user_id = $1 AND is_read = FALSE
        `,
        [String(userId), now],
      );
      invalidateUserPlatformCaches(String(userId));
      return Number(result.rowCount || 0);
    }

    let count = 0;
    state.notifications.forEach((notification) => {
      if (notification.userId === String(userId) && !notification.isRead) {
        notification.isRead = true;
        notification.readAt = notification.readAt || now;
        count += 1;
      }
    });
    invalidateUserPlatformCaches(String(userId));
    return count;
  },

  async resolveLiveClassAudience(liveClass) {
    if (!liveClass?._id) {
      return [];
    }

    let audienceUserIds = [];

    if (liveClass.requiresEnrollment !== false && liveClass.courseId) {
      if (isPostgresMode()) {
        audienceUserIds = await pgMany(
          `SELECT DISTINCT user_id FROM enrollments WHERE course_id = $1 AND ${activeEnrollmentSql}`,
          [String(liveClass.courseId)],
          (row) => String(row.user_id),
        );
      } else {
        audienceUserIds = state.enrollments
          .filter((entry) => entry.courseId === String(liveClass.courseId) && isEnrollmentActive(entry))
          .map((entry) => String(entry.userId));
      }
    } else {
      audienceUserIds = (await usersRepository.listSafe())
        .filter((user) => user.role !== 'admin')
        .map((user) => String(user._id));
    }

    return Array.from(new Set(audienceUserIds.filter(Boolean)));
  },

  async notifyLiveClassScheduled(liveClass, options = {}) {
    if (!liveClass?._id) {
      return [];
    }

    // Public live classes can fan out to the entire student base. Avoid writing
    // thousands of notification rows on the critical class start/join path.
    if (liveClass.requiresEnrollment === false || !liveClass.courseId) {
      return [];
    }

    const uniqueAudience = await notificationsRepository.resolveLiveClassAudience(liveClass);
    const appBaseUrl = String(appConfig.appUrl || '').replace(/\/$/, '');
    const actionUrl = `${appBaseUrl || ''}/?tab=live&liveClassId=${encodeURIComponent(liveClass._id)}`;
    const startsAt = liveClass.startTime ? new Date(liveClass.startTime).toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    }) : 'soon';
    const eventLabel = options.updated ? 'updated' : 'scheduled';

    return Promise.all(uniqueAudience.map((userId) =>
      notificationsRepository.create({
        _id: `notification_live_${eventLabel}_${liveClass._id}_${userId}`,
        userId,
        title: options.updated ? `${liveClass.title} schedule updated` : `${liveClass.title} scheduled`,
        message: options.updated
          ? `The live class schedule changed. It is now set for ${startsAt}.`
          : `A live class is scheduled for ${startsAt}. Tap to view the class details.`,
        type: options.updated ? 'live-class-updated' : 'live-class-scheduled',
        entityId: liveClass._id,
        actionUrl,
        actionLabel: 'View class',
        payload: {
          tab: 'live',
          liveClassId: liveClass._id,
          courseId: liveClass.courseId || null,
          startTime: liveClass.startTime || null,
        },
      })));
  },

  async notifyLiveClassStarted(liveClass) {
    if (!liveClass?._id) {
      return [];
    }

    // Keep the live start path responsive for open classes instead of fanning
    // out per-user notification writes during the broadcast start sequence.
    if (liveClass.requiresEnrollment === false || !liveClass.courseId) {
      return [];
    }

    const uniqueAudience = await notificationsRepository.resolveLiveClassAudience(liveClass);
    const appBaseUrl = String(appConfig.appUrl || '').replace(/\/$/, '');
    const actionUrl = `${appBaseUrl || ''}/?tab=live&liveClassId=${encodeURIComponent(liveClass._id)}`;

    return Promise.all(uniqueAudience.map((userId) =>
      notificationsRepository.create({
        _id: `notification_live_started_${liveClass._id}_${userId}`,
        userId,
        title: `${liveClass.title} is live now`,
        message: 'Tap to open the protected class inside VARONENGLISH and join with your enrolled account.',
        type: 'live-class-started',
        entityId: liveClass._id,
        actionUrl,
        actionLabel: 'Join now',
        payload: {
          liveClassId: liveClass._id,
          courseId: liveClass.courseId || null,
          tab: 'live',
          provider: liveClass.provider || 'Jitsi Meet',
        },
      })));
  },

  async notifyAnnouncement(payload) {
    const audienceUserIds = payload.userId
      ? [String(payload.userId)]
      : (await usersRepository.listSafe())
        .filter((user) => user.role !== 'admin')
        .map((user) => String(user._id));
    const uniqueAudience = Array.from(new Set(audienceUserIds.filter(Boolean)));

    const notifications = await Promise.all(uniqueAudience.map((userId) =>
      notificationsRepository.create({
        userId,
        title: payload.title || 'Announcement',
        message: payload.message || '',
        type: payload.type || 'announcement',
        entityId: payload.entityId || null,
        actionUrl: payload.actionUrl || null,
        actionLabel: payload.actionLabel || 'Open',
        payload: asObject(payload.payload),
      })));
    uniqueAudience.forEach((userId) => invalidateUserPlatformCaches(userId));
    return notifications;
  },
};

const engagementRepository = {
  async addReferral(payload) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const referral = await insertPgReferral(payload, client);
        const user = await pgOne('SELECT * FROM users WHERE id = $1', [String(payload.referrerUserId)], mapUserRow, client);
        if (user) {
          const nextBadges = asArray(user.badges);
          if (!nextBadges.some((badge) => badge.code === 'community_builder')) {
            nextBadges.push({ code: 'community_builder', label: 'Community Builder' });
          }

          await upsertPgUser({
            ...user,
            points: Number(user.points || 0) + 25,
            badges: nextBadges,
          }, client);
        }

        invalidateGlobalPlatformCaches();
        invalidateUserPlatformCaches(payload.referrerUserId);
        return referral;
      });
    }

    const referral = {
      _id: nextId('referral'),
      referrerUserId: String(payload.referrerUserId),
      referredEmail: normalizeEmail(payload.referredEmail),
      createdAt: nowIso(),
    };

    state.referrals.push(referral);

    const user = state.users.find((item) => item._id === referral.referrerUserId);
    if (user) {
      user.points += 25;
      if (!user.badges.some((badge) => badge.code === 'community_builder')) {
        user.badges.push({ code: 'community_builder', label: 'Community Builder' });
      }
    }

    invalidateGlobalPlatformCaches();
    invalidateUserPlatformCaches(referral.referrerUserId);
    return clone(referral);
  },

  async getGamification(userId) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const user = await usersRepository.findById(userId);
      const referralCount = await pgOne(
        'SELECT COUNT(*)::int AS count FROM referrals WHERE referrer_user_id = $1',
        [String(userId)],
        (row) => Number(row.count || 0),
      );

      return {
        points: user?.points || 0,
        badges: clone(user?.badges || []),
        streak: user?.streak || 0,
        referrals: referralCount || 0,
      };
    }

    const user = state.users.find((item) => item._id === String(userId));

    return {
      points: user?.points || 0,
      badges: clone(user?.badges || []),
      streak: user?.streak || 0,
      referrals: state.referrals.filter((referral) => referral.referrerUserId === String(userId)).length,
    };
  },
};

const listStoredLiveClasses = async () => {
  await ensurePlatformReady();

  if (isPostgresMode()) {
    return getPgLiveClasses();
  }

  return clone(state.liveClasses).sort((left, right) => sortOldestFirst(left, right, 'startTime'));
};

const findStoredLiveClassById = async (liveClassId) => {
  await ensurePlatformReady();

  const cacheKeyLiveClass = cacheKey('live-class', String(liveClassId));
  const ttlSeconds = LIVE_CLASS_LOOKUP_CACHE_TTL_SECONDS;

  if (!isMongoMode()) {
    return getCachedJsonValue(cacheKeyLiveClass, async () => {
      if (isPostgresMode()) {
        return pgOne('SELECT * FROM live_classes WHERE id = $1', [String(liveClassId)], mapLiveClassRow);
      }

      return clone(state.liveClasses.find((item) => item._id === String(liveClassId)) || null);
    }, ttlSeconds);
  }

  return clone(state.liveClasses.find((item) => item._id === String(liveClassId)) || null);
};

const canUserAccessLiveClass = async ({ liveClass, userId, user = null, allowAdmin = true }) => {
  const resolvedUser = user || await usersRepository.findById(userId);
  if (!resolvedUser) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  if (allowAdmin && resolvedUser.role === 'admin') {
    return { user: resolvedUser, hasAccess: true };
  }

  if (!liveClass.requiresEnrollment || !liveClass.courseId) {
    return { user: resolvedUser, hasAccess: true };
  }

  const entitlementCacheKey = cacheKey('live-class-entitlement', `${String(liveClass._id)}:${String(userId)}`);
  try {
    const cached = await getRedisJson(entitlementCacheKey);
    if (cached && cached.hasAccess === true) {
      return { user: resolvedUser, hasAccess: true };
    }
  } catch (error) {
    // Ignore entitlement cache read failures.
  }

  let hasAccess = false;
  if (isPostgresMode()) {
    const enrollment = await pgOne(
      `SELECT id FROM enrollments WHERE user_id = $1 AND course_id = $2 AND ${activeEnrollmentSql}`,
      [String(userId), String(liveClass.courseId)],
      (row) => row,
    );
    hasAccess = Boolean(enrollment);
  } else {
    hasAccess = state.enrollments.some(
      (entry) => entry.userId === String(userId) && entry.courseId === String(liveClass.courseId) && isEnrollmentActive(entry),
    );
  }

  if (!hasAccess) {
    throw new ApiError(403, 'Course enrollment is required to access this live class', { code: 'LIVE_CLASS_ACCESS_REQUIRED' });
  }

  try {
    await setRedisJson(entitlementCacheKey, {
      liveClassId: String(liveClass._id),
      userId: String(userId),
      hasAccess: true,
      issuedAt: nowIso(),
    }, { ttlSeconds: LIVE_CLASS_ENTITLEMENT_CACHE_TTL_SECONDS });
  } catch (error) {
    // Ignore entitlement cache write failures.
  }

  return { user: resolvedUser, hasAccess };
};

const isLegacyRealtimeBroadcastClass = (liveClass) => {
  const playbackUrl = String(liveClass?.livePlaybackUrl || '').trim();
  if (!playbackUrl) {
    return false;
  }

  try {
    const url = new URL(playbackUrl, appConfig.appUrl);
    return (
      url.hostname === 'live.example.com'
      && (String(liveClass?.provider || '').toLowerCase().includes('broadcast')
        || String(liveClass?.provider || '').toLowerCase().includes('live'))
      && String(liveClass?.livePlaybackType || '').toLowerCase() === 'hls'
      && appConfig.nodeEnv !== 'production'
    );
  } catch {
    return false;
  }
};

const extractJitsiRoomName = (value) => {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return null;
  }

  try {
    const url = new URL(rawValue, appConfig.appUrl);
    return url.pathname.replace(/^\/+/, '').split('/')[0] || null;
  } catch {
    return rawValue
      .replace(/^https?:\/\/[^/]+\//i, '')
      .replace(/[?#].*$/, '')
      .replace(/^\/+/, '') || null;
  }
};

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')
  .slice(0, 64);

const buildJitsiTeacherStudioAccess = (liveClass) => {
  const roomName = extractJitsiRoomName(liveClass?.roomUrl || liveClass?.embedUrl || liveClass?.roomName)
    || `edumaster-${slugify(liveClass?.title) || 'live-class'}-${String(liveClass?._id || '')}`;
  const roomUrl = liveClass?.roomUrl || `https://${appConfig.jitsiMeetDomain}/${roomName}`;
  const embedUrl = liveClass?.embedUrl || `${roomUrl}#config.prejoinPageEnabled=false&config.requireDisplayName=false&config.disableDeepLinking=true&config.startWithAudioMuted=false&config.startWithVideoMuted=false&interfaceConfig.DISABLE_JOIN_LEAVE_NOTIFICATIONS=true`;

  return { roomName, roomUrl, embedUrl };
};

const liveClassesRepository = {
  async list() {
    const liveClasses = await listStoredLiveClasses();
    return liveClasses.map((item) => sanitizeLiveClassForViewer(item));
  },

  async listAdmin() {
    return listStoredLiveClasses();
  },

  async findById(liveClassId) {
    const liveClass = await findStoredLiveClassById(liveClassId);
    return liveClass ? sanitizeLiveClassForViewer(liveClass) : null;
  },

  async findRawById(liveClassId) {
    return findStoredLiveClassById(liveClassId);
  },

  async create(payload) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const liveClass = await insertPgLiveClass(payload);
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('live-class', String(liveClass._id)));
      } catch (error) {}
      return liveClass;
    }

    const liveClass = {
      _id: nextId('live_class'),
      linkageType: payload.linkageType || (payload.mockTestId ? 'mock-test' : payload.courseId ? 'course' : 'standalone'),
      courseId: payload.courseId || null,
      moduleId: payload.moduleId || null,
      moduleTitle: payload.moduleTitle || null,
      chapterId: payload.chapterId || null,
      chapterTitle: payload.chapterTitle || null,
      mockTestId: payload.mockTestId || null,
      mockTestTitle: payload.mockTestTitle || null,
      title: payload.title,
      instructor: payload.instructor || 'VARONENGLISH Faculty',
      startTime: payload.startTime || nowIso(),
      durationMinutes: Number(payload.durationMinutes || 60),
      provider: payload.provider || 'Jitsi Meet',
      mode: payload.mode || 'live',
      status: payload.status || 'scheduled',
      livePlaybackUrl: payload.livePlaybackUrl || null,
      livePlaybackType: payload.livePlaybackType || getDefaultLivePlaybackType(),
      embedUrl: payload.embedUrl || null,
      roomUrl: payload.roomUrl || null,
      recordingUrl: payload.recordingUrl || null,
      replayCourseId: payload.replayCourseId || null,
      replayLessonId: payload.replayLessonId || null,
      chatEnabled: payload.chatEnabled !== false,
      doubtSolving: payload.doubtSolving !== false,
    replayAvailable: payload.replayAvailable !== false,
    attendees: Number(payload.attendees || 0),
    maxAttendees: Number(payload.maxAttendees || 2500),
    requiresEnrollment: payload.requiresEnrollment !== false,
    recordingStorageProvider: payload.recordingStorageProvider || null,
      recordingStoragePath: payload.recordingStoragePath || null,
      recordingPublishedAt: payload.recordingPublishedAt || null,
      recordingExpiresAt: payload.recordingExpiresAt || null,
      recordingDurationMinutes: payload.recordingDurationMinutes === undefined ? null : Number(payload.recordingDurationMinutes || 0),
      posterUrl: payload.posterUrl || null,
      description: payload.description || null,
      teacherProfile: asObject(payload.teacherProfile),
      sessionNotes: asArray(payload.sessionNotes),
      resources: asArray(payload.resources),
      activePoll: payload.activePoll ? asObject(payload.activePoll) : null,
      topicTags: asArray(payload.topicTags),
      createdAt: nowIso(),
  };

    state.liveClasses.push(liveClass);
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('live-class', String(liveClass._id)));
    } catch (error) {}
    return clone(liveClass);
  },

  async update(liveClassId, payload) {
    await ensurePlatformReady();
    const current = await findStoredLiveClassById(liveClassId);
    if (!current) {
      return null;
    }

    const nextLiveClass = {
      ...current,
      ...clone(payload),
      _id: current._id,
    };

    if (isPostgresMode()) {
      const updated = await insertPgLiveClass(nextLiveClass);
      invalidateGlobalPlatformCaches();
      try {
        await deleteRedisKey(cacheKey('live-class', String(liveClassId)));
      } catch (error) {}
      return updated;
    }

    const index = state.liveClasses.findIndex((item) => item._id === String(liveClassId));
    state.liveClasses[index] = nextLiveClass;
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('live-class', String(liveClassId)));
    } catch (error) {}
    return clone(nextLiveClass);
  },

  async delete(liveClassId) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const deleted = await pgOne(
        'DELETE FROM live_classes WHERE id = $1 RETURNING *',
        [String(liveClassId)],
        mapLiveClassRow,
      );
      invalidateGlobalPlatformCaches();
      return deleted;
    }

    const index = state.liveClasses.findIndex((item) => item._id === String(liveClassId));
    if (index < 0) {
      return null;
    }

    const [deleted] = state.liveClasses.splice(index, 1);
    state.liveChatMessages = state.liveChatMessages.filter((item) => item.liveClassId !== String(liveClassId));
    invalidateGlobalPlatformCaches();
    try {
      await deleteRedisKey(cacheKey('live-class', String(liveClassId)));
    } catch (error) {}
    return clone(deleted);
  },

  async getAccess({ liveClassId, userId, user = null }) {
    const liveClass = await findStoredLiveClassById(liveClassId);
    if (!liveClass) {
      throw new ApiError(404, 'Live class not found', { code: 'LIVE_CLASS_NOT_FOUND' });
    }

    const { user: resolvedUser } = await canUserAccessLiveClass({ liveClass, userId, user });
    const status = deriveLiveClassStatus(liveClass);
    const livePlaybackType = String(getEffectiveLivePlaybackType(liveClass) || '').toLowerCase();
    const hasLivePlayback = Boolean(
      liveClass.livePlaybackUrl
      || liveClass.embedUrl
      || liveClass.roomUrl,
    );
    const hasReplayLesson = Boolean(liveClass.replayCourseId && liveClass.replayLessonId);
    const hasReplayLink = Boolean(liveClass.recordingUrl || liveClass.recordingStoragePath);
    const recordingState = deriveLiveClassRecordingState(liveClass);
    const replayState = deriveLiveClassReplayState(liveClass);

    if (status === 'live' && livePlaybackType === 'livekit') {
      return {
        liveClassId: liveClass._id,
        title: liveClass.title,
        provider: liveClass.provider,
        mode: liveClass.mode,
        status,
        accessType: 'livekit-room',
        streamUrl: null,
        streamFormat: null,
        embedUrl: null,
        roomUrl: null,
        liveRoomName: `${appConfig.livekitRoomPrefix}-${String(liveClass._id)}`,
        liveKitUrl: appConfig.livekitUrl || null,
        replayPlayback: null,
        replayExternalUrl: null,
        replayCourseId: liveClass.replayCourseId || null,
        replayLessonId: liveClass.replayLessonId || null,
        recordingState,
        replayState,
        tokenExpiresAt: null,
        watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
        statusMessage: appConfig.hasLiveKit
          ? 'Live class is running inside the in-app classroom.'
          : 'LiveKit is not configured on the server yet. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.',
      };
    }

    if (status === 'live' && livePlaybackType === 'webrtc') {
      return {
        liveClassId: liveClass._id,
        title: liveClass.title,
        provider: liveClass.provider,
        mode: liveClass.mode,
        status,
        accessType: 'webrtc-live',
        streamUrl: null,
        streamFormat: null,
        embedUrl: null,
        roomUrl: null,
        liveKitUrl: null,
        replayPlayback: null,
        replayExternalUrl: null,
        replayCourseId: liveClass.replayCourseId || null,
        replayLessonId: liveClass.replayLessonId || null,
        recordingState,
        replayState,
        tokenExpiresAt: null,
        watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
        statusMessage: 'Live class is running in the realtime classroom.',
      };
    }

    if (status === 'live' && livePlaybackType === 'live-stream' && String(resolvedUser.role || '').toLowerCase() === 'admin') {
      if (appConfig.hasLiveKit) {
        const liveKitAccess = await liveKitService.buildToken({
          liveClass,
          user: resolvedUser,
          participant: {
            canSpeak: true,
            micMuted: false,
          },
        });

        return {
          liveClassId: liveClass._id,
          title: liveClass.title,
          provider: liveClass.provider,
          mode: liveClass.mode,
          status,
          accessType: 'livekit-room',
          streamUrl: null,
          streamFormat: null,
          embedUrl: null,
          roomUrl: null,
          liveRoomName: liveKitAccess?.roomName || `${appConfig.livekitRoomPrefix}-${String(liveClass._id)}`,
          liveKitUrl: appConfig.livekitUrl || null,
          liveKitToken: liveKitAccess?.token || null,
          liveKitIdentity: liveKitAccess?.identity || null,
          replayPlayback: null,
          replayExternalUrl: null,
          replayCourseId: liveClass.replayCourseId || null,
          replayLessonId: liveClass.replayLessonId || null,
          recordingState,
          replayState,
          tokenExpiresAt: liveKitAccess?.tokenExpiresAt || null,
          watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
          statusMessage: 'Teacher studio is available alongside the broadcast stream.',
        };
      }

      const teacherStudio = buildJitsiTeacherStudioAccess(liveClass);
      return {
        liveClassId: liveClass._id,
        title: liveClass.title,
        provider: liveClass.provider,
        mode: liveClass.mode,
        status,
        accessType: 'jitsi-room',
        streamUrl: null,
        streamFormat: null,
        embedUrl: teacherStudio.embedUrl,
        roomUrl: teacherStudio.roomUrl,
        liveRoomName: teacherStudio.roomName,
        liveKitUrl: null,
        replayPlayback: null,
        replayExternalUrl: null,
        replayCourseId: liveClass.replayCourseId || null,
        replayLessonId: liveClass.replayLessonId || null,
        recordingState,
        replayState,
        tokenExpiresAt: null,
        watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
        statusMessage: 'Teacher studio is available alongside the broadcast stream.',
      };
    }

    if (status === 'live' && livePlaybackType === 'unsupported') {
      throw new ApiError(409, 'This live class uses an unsupported legacy room type. Recreate it with LiveKit.', {
        code: 'LIVE_CLASS_UNSUPPORTED_PLAYBACK',
      });
    }

    if (status === 'live' && livePlaybackType === 'live-stream') {
      const livePlaybackUrl = normalizeOptionalUrl(liveClass.livePlaybackUrl);
      const publicPlaybackUrl = buildPublicManagedHlsPlaybackUrl(buildManagedHlsStreamName(liveClass));
      const playbackUrl = publicPlaybackUrl || livePlaybackUrl;
      if (!playbackUrl) {
        return {
          liveClassId: liveClass._id,
          title: liveClass.title,
          provider: liveClass.provider,
          mode: liveClass.mode,
          status,
          accessType: 'live-stream',
          streamUrl: null,
          streamFormat: null,
          embedUrl: null,
          roomUrl: null,
          replayPlayback: null,
          replayExternalUrl: null,
          replayCourseId: liveClass.replayCourseId || null,
          replayLessonId: liveClass.replayLessonId || null,
          recordingState,
          replayState,
          tokenExpiresAt: null,
          watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
          statusMessage: 'Live stream is starting. Playback URL is not ready yet.',
        };
      }

      const extension = playbackUrl.toLowerCase().includes('.m3u8') ? '.m3u8' : '.mp4';
      const mimeType = extension === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      let issuedToken = null;
      const streamUrl = publicPlaybackUrl || (() => {
        issuedToken = issuePlaybackToken({
          userId: String(resolvedUser._id),
          sessionId: resolvedUser.session || null,
          liveClassId: String(liveClass._id),
          upstreamUrl: playbackUrl,
          mimeType,
          assetKind: extension === '.m3u8' ? 'live-hls' : 'live-source',
        });
        return `/backend/api/live-classes/stream/${issuedToken.token}`;
      })();

      return {
        liveClassId: liveClass._id,
        title: liveClass.title,
        provider: liveClass.provider,
        mode: liveClass.mode,
        status,
        accessType: 'live-stream',
        streamUrl,
        streamFormat: extension === '.m3u8' ? 'hls' : 'source',
        embedUrl: null,
        roomUrl: null,
        replayPlayback: null,
        replayExternalUrl: null,
        replayCourseId: liveClass.replayCourseId || null,
        replayLessonId: liveClass.replayLessonId || null,
        recordingState,
        replayState,
        tokenExpiresAt: issuedToken?.expiresAt || null,
        watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
        statusMessage: publicPlaybackUrl
          ? 'Live class is running with public HLS playback through the live domain.'
          : 'Live class is running with protected in-app playback.',
      };
    }

    if (hasReplayLesson) {
      const replayPlayback = await coursesRepository.getProtectedLessonPlayback({
        userId: String(resolvedUser._id),
        courseId: String(liveClass.replayCourseId),
        lessonId: String(liveClass.replayLessonId),
        enforceEnrollment: false,
        enforceSequentialUnlock: false,
      });

      return {
        liveClassId: liveClass._id,
        title: liveClass.title,
        provider: liveClass.provider,
        mode: 'replay',
        status,
        accessType: 'replay-lesson',
        streamUrl: null,
        streamFormat: null,
        embedUrl: null,
        roomUrl: null,
        replayPlayback,
        replayExternalUrl: null,
        replayCourseId: liveClass.replayCourseId,
        replayLessonId: liveClass.replayLessonId,
        recordingState,
        replayState,
        tokenExpiresAt: replayPlayback.tokenExpiresAt || null,
        watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
        statusMessage: 'Replay is protected and available inside the app.',
      };
    }

    if (hasReplayLink) {
      const access = await consumeLiveReplayGrant({
        userId: String(resolvedUser._id),
        liveClassId: String(liveClass._id),
        sessionId: resolvedUser.session || null,
      });

      const storagePath = liveClass.recordingStoragePath || liveClass.recordingUrl;
      const storageProvider = liveClass.recordingStorageProvider || 'local';
      const extension = String(storagePath || '').toLowerCase().includes('.m3u8') ? '.m3u8' : '.mp4';
      const mimeType = extension === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      const recordingUrl = normalizeOptionalUrl(liveClass.recordingUrl);
      const playbackTokenPayload = liveClass.recordingStoragePath
        ? {
          userId: String(resolvedUser._id),
          sessionId: resolvedUser.session || null,
          liveClassId: String(liveClass._id),
          storageProvider,
          storagePath,
          mimeType,
          assetKind: extension === '.m3u8' ? 'hls' : 'source',
        }
        : {
          userId: String(resolvedUser._id),
          sessionId: resolvedUser.session || null,
          liveClassId: String(liveClass._id),
          upstreamUrl: recordingUrl,
          mimeType,
          assetKind: extension === '.m3u8' ? 'live-hls' : 'live-source',
        };
      const issuedToken = issuePlaybackToken(playbackTokenPayload);

      return {
        liveClassId: liveClass._id,
        title: liveClass.title,
        provider: liveClass.provider,
        mode: 'replay',
        status,
        accessType: 'recording-link',
        streamUrl: `/backend/api/live-classes/stream/${issuedToken.token}`,
        streamFormat: extension === '.m3u8' ? 'hls' : 'source',
        embedUrl: null,
        roomUrl: null,
        replayPlayback: null,
        replayExternalUrl: null,
        replayCourseId: null,
        replayLessonId: null,
        recordingState,
        replayState,
        tokenExpiresAt: issuedToken.expiresAt,
        watermarkText: `${resolvedUser.email} • ${resolvedUser._id}`,
        statusMessage: access.grant
          ? hasReplayViewLimit()
            ? `Replay is protected. Remaining views: ${Math.max(Number(access.grant.maxViews || liveReplayMaxViews) - Number(access.grant.usedViews || 0), 0)}`
            : 'Replay is protected for the full course validity period.'
          : 'Replay recording is ready inside the app.',
        playbackGrantRemainingViews: access.grant
          ? hasReplayViewLimit()
            ? Math.max(Number(access.grant.maxViews || liveReplayMaxViews) - Number(access.grant.usedViews || 0), 0)
            : null
          : null,
        recordingExpiresAt: liveClass.recordingExpiresAt || null,
      };
    }

    return {
      liveClassId: liveClass._id,
      title: liveClass.title,
      provider: liveClass.provider,
      mode: liveClass.mode,
      status,
      accessType: 'upcoming',
      streamUrl: null,
      streamFormat: null,
      embedUrl: null,
      roomUrl: null,
      replayPlayback: null,
      replayExternalUrl: null,
      replayCourseId: liveClass.replayCourseId || null,
      replayLessonId: liveClass.replayLessonId || null,
      recordingState,
      replayState,
      tokenExpiresAt: null,
      watermarkText: buildPlaybackWatermarkText(resolvedUser),
      statusMessage: status === 'cancelled'
        ? 'This live class has been cancelled.'
        : status === 'ended'
          ? replayState === 'replay_ready'
            ? 'Replay is ready for protected playback.'
            : recordingState === 'processing' || replayState === 'processing'
              ? 'Recording is processing and the replay will appear here after upload finishes.'
              : 'Replay is processing or will appear here after the recording is uploaded.'
        : 'Live playback becomes available when the class starts.',
    };
  },

  async getChat(liveClassId) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return pgMany(
        'SELECT * FROM live_chat_messages WHERE live_class_id = $1 ORDER BY created_at ASC',
        [String(liveClassId)],
        mapLiveChatRow,
      );
    }

    return state.liveChatMessages
      .filter((item) => item.liveClassId === String(liveClassId))
      .sort((left, right) => sortOldestFirst(left, right, 'createdAt'))
      .map((item) => clone(item));
  },

  async postChat({ liveClassId, userId, message, kind = 'chat' }) {
    await ensurePlatformReady();
    const liveClass = await findStoredLiveClassById(liveClassId);
    if (!liveClass) {
      return null;
    }

    const { user } = await canUserAccessLiveClass({ liveClass, userId });

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const chatMessage = await insertPgLiveChatMessage({
          liveClassId,
          userId,
          userName: user.name,
          kind,
          message,
        }, client);

        queueBestEffortDeviceActivity({
          userId: user._id,
          sessionId: user.session,
          device: user.device,
          eventType: kind === 'doubt' ? 'live_class_doubt_posted' : 'live_class_chat_posted',
          meta: {
            liveClassId: String(liveClassId),
          },
        });

        return chatMessage;
      });
    }

    const chatMessage = {
      _id: nextId('live_chat'),
      liveClassId: String(liveClassId),
      userId: String(userId),
      userName: user.name,
      kind: kind === 'doubt' ? 'doubt' : 'chat',
      message: String(message || ''),
      createdAt: nowIso(),
    };

    state.liveChatMessages.push(chatMessage);
    state.deviceActivities.unshift({
      _id: nextId('activity'),
      userId: user._id,
      sessionId: user.session,
      device: user.device,
      eventType: chatMessage.kind === 'doubt' ? 'live_class_doubt_posted' : 'live_class_chat_posted',
      meta: {
        liveClassId: String(liveClassId),
      },
      createdAt: nowIso(),
    });
    state.deviceActivities = state.deviceActivities.slice(0, 200);

    return clone(chatMessage);
  },
};

const adminRepository = {
  async uploadQuestions(payload) {
    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const upload = await insertPgUpload(payload, client);
        let createdTest = null;
        if (Array.isArray(payload.questions) && payload.questions.length > 0) {
          createdTest = await upsertPgTest({
            title: payload.title || 'Uploaded Test',
            category: payload.category || 'SSC JE',
            type: payload.type || 'topic-wise',
            course: payload.course || null,
            questions: payload.questions,
            totalMarks: payload.questions.reduce((sum, question) => sum + Number(question.marks || 1), 0),
          }, client);
        }

        return {
          upload,
          test: createdTest,
        };
      });
    }

    const uploadRecord = {
      _id: nextId('upload'),
      title: payload.title || 'Bulk Upload',
      course: payload.course || null,
      questionCount: Array.isArray(payload.questions) ? payload.questions.length : 0,
      createdAt: nowIso(),
    };

    state.uploads.push(uploadRecord);

    let createdTest = null;
    if (Array.isArray(payload.questions) && payload.questions.length > 0) {
      createdTest = await testsRepository.create({
        title: payload.title || 'Uploaded Test',
        category: payload.category || 'SSC JE',
        type: payload.type || 'topic-wise',
        course: payload.course || null,
        questions: payload.questions,
        totalMarks: payload.questions.reduce((sum, question) => sum + Number(question.marks || 1), 0),
      });
    }

    return {
      upload: clone(uploadRecord),
      test: createdTest,
    };
  },

  async getPlatformAnalytics() {
    const cacheKeyPlatformAnalytics = cacheKey('analytics', 'platform');
    const analyticsCacheTtlMs = Math.max(1000, Number(appConfig.analyticsCacheTtlMs || 5_000));

    try {
      const cached = await getRedisJson(cacheKeyPlatformAnalytics);
      if (cached) {
        return cached;
      }
    } catch (e) {
      // ignore
    }

    const data = await loadPlatformData();
    const leaderboardEntries = await quizzesRepository.listLeaderboardEntries();

    const result = {
      activeUsers: data.users.length,
      activeSessions: data.users.filter((user) => Boolean(user.session)).length,
      totalCourses: data.courses.length,
      totalTests: data.tests.length,
      liveClasses: data.liveClasses.filter((item) => item.mode === 'live').length,
      notificationsSent: Number(data.notificationCount ?? data.notifications.length),
      referralCount: data.referrals.length,
      paymentCount: data.payments.length,
      testParticipation: data.testAttempts.length + leaderboardEntries.length,
      revenue: data.payments
        .filter((payment) => payment.status === 'paid')
        .reduce((total, payment) => total + Number(payment.amount || 0), 0),
      concurrentCapacityTarget: '',
      recentDeviceActivity: getRecentDeviceActivity(data),
    };

    try {
      await setRedisJson(cacheKeyPlatformAnalytics, result, { ttlSeconds: Math.ceil(analyticsCacheTtlMs / 1000) });
    } catch (e) {}

    return result;
  },

};

const analyticsRepository = {
  async getUserAnalytics(userId) {
    const cacheKeyUserAnalytics = cacheKey('analytics', `user:${userId}`);
    const userAnalyticsCacheTtlMs = Math.max(500, Number(appConfig.userAnalyticsCacheTtlMs || 2_000));

    try {
      const cached = await getRedisJson(cacheKeyUserAnalytics);
      if (cached) {
        return cached;
      }
    } catch (e) {
      // ignore
    }

    const data = await loadPlatformData();
    const result = buildUserAnalyticsFromData(data, userId);

    try {
      await setRedisJson(cacheKeyUserAnalytics, result, { ttlSeconds: Math.ceil(userAnalyticsCacheTtlMs / 1000) });
    } catch (e) {}

    return result;
  },

  async getLeaderboard() {
    try {
      const cached = await getRedisJson(PLATFORM_LEADERBOARD_REDIS_KEY);
      if (cached) {
        return cached;
      }
    } catch (error) {
      // Ignore cache read failures and rebuild the leaderboard.
    }

    const data = await loadPlatformData();
    const userScores = new Map();

    data.testAttempts.forEach((attempt) => {
      const current = userScores.get(attempt.userId) || 0;
      if (Number(attempt.score) > current) {
        userScores.set(attempt.userId, Number(attempt.score));
      }
    });

    (await quizzesRepository.listLeaderboardEntries()).forEach((entry) => {
      const current = userScores.get(entry.userId) || 0;
      if (entry.score > current) {
        userScores.set(entry.userId, entry.score);
      }
    });

    const leaderboard = Array.from(userScores.entries())
      .map(([userId, score]) => {
        const user = data.users.find((item) => item._id === userId);
        return {
          userId,
          name: user?.name || 'Unknown User',
          score,
        };
      })
      .sort((left, right) => right.score - left.score);

    try {
      await setRedisJson(PLATFORM_LEADERBOARD_REDIS_KEY, leaderboard, { ttlSeconds: ANALYTICS_LEADERBOARD_CACHE_TTL_SECONDS });
    } catch (error) {
      // Ignore cache write failures.
    }

    return leaderboard;
  },

  async getProgress(userId) {
    await ensurePlatformReady();

    const cacheKeyUserProgress = getUserProgressCacheKey(userId);
    if (isPostgresMode()) {
      return getCachedJsonValue(cacheKeyUserProgress, async () => {
        const [
          testSummary,
          quizSummary,
          enrollments,
          watchHistory,
          courses,
        ] = await Promise.all([
          pgOne(
            `
              SELECT
                COUNT(*)::int AS attempts,
                COALESCE(AVG(score), 0)::numeric(10,2) AS average_score
              FROM test_attempts
              WHERE user_id = $1
            `,
            [String(userId)],
            (row) => ({
              attempts: Number(row.attempts || 0),
              averageScore: Number(row.average_score || 0),
            }),
          ),
          pgOne(
            'SELECT COUNT(*)::int AS attempts FROM daily_quiz_attempts WHERE user_id = $1',
            [String(userId)],
            (row) => ({ attempts: Number(row.attempts || 0) }),
          ),
          getActiveEnrollmentsForUser(userId),
          pgMany(
            'SELECT * FROM watch_history WHERE user_id = $1 ORDER BY updated_at DESC',
            [String(userId)],
            mapWatchHistoryRow,
          ),
          coursesRepository.list(),
        ]);

        const data = { watchHistory };
        const coursesInProgress = enrollments
          .map((enrollment) => courses.find((course) => course._id === enrollment.courseId))
          .filter(Boolean)
          .map((course) => ({
            courseId: course._id,
            title: course.title,
            progressPercent: computeCourseProgress(data, userId, course).progressPercent,
          }));

        return {
          testsTaken: Number(testSummary?.attempts || 0),
          quizzesTaken: Number(quizSummary?.attempts || 0),
          coursesAvailable: courses.length,
          coursesInProgress,
          averageScore: Number(testSummary?.averageScore || 0),
        };
      }, USER_PROGRESS_CACHE_TTL_SECONDS);
    }

    const data = await loadPlatformData();
    const testInsights = computeTestInsights(data, userId);
    const enrollments = filterActiveEnrollments(data.enrollments.filter((entry) => entry.userId === String(userId)));
    const coursesInProgress = enrollments
      .map((enrollment) => data.courses.find((course) => course._id === enrollment.courseId))
      .filter(Boolean)
      .map((course) => ({
        courseId: course._id,
        title: course.title,
        progressPercent: computeCourseProgress(data, userId, course).progressPercent,
      }));

    return {
      testsTaken: testInsights.attempts.length,
      quizzesTaken: computeQuizInsights(data, userId).attempts,
      coursesAvailable: data.courses.length,
      coursesInProgress,
      averageScore: testInsights.averageScore,
    };
  },
};

const findPgPaymentByIdentifiers = async ({
  paymentId = '',
  providerOrderId = '',
  providerPaymentId = '',
  userId = '',
  courseId = '',
}, client = null) => {
  const filters = [`provider = 'razorpay'`];
  const params = [];
  const identifierFilters = [];

  if (paymentId) {
    params.push(String(paymentId));
    identifierFilters.push(`id = $${params.length}`);
  }
  if (providerOrderId) {
    params.push(String(providerOrderId));
    identifierFilters.push(`provider_order_id = $${params.length}`);
  }
  if (providerPaymentId) {
    params.push(String(providerPaymentId));
    identifierFilters.push(`provider_payment_id = $${params.length}`);
  }
  if (identifierFilters.length === 0) {
    return null;
  }
  filters.push(`(${identifierFilters.join(' OR ')})`);
  if (userId) {
    params.push(String(userId));
    filters.push(`user_id = $${params.length}`);
  }
  if (courseId) {
    params.push(String(courseId));
    filters.push(`course_id = $${params.length}`);
  }

  return pgOne(
    `
      SELECT * FROM payments
      WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(paid_at, updated_at, created_at) DESC
      LIMIT 1
    `,
    params,
    mapPaymentRow,
    client,
  );
};

const findMemoryPaymentByIdentifiers = ({
  paymentId = '',
  providerOrderId = '',
  providerPaymentId = '',
  userId = '',
  courseId = '',
}) => state.payments.find((payment) => {
  if (payment.provider !== 'razorpay') {
    return false;
  }
  const identifierMatch = (
    (paymentId && payment._id === String(paymentId))
    || (providerOrderId && payment.providerOrderId === String(providerOrderId))
    || (providerPaymentId && payment.providerPaymentId === String(providerPaymentId))
  );
  if (!identifierMatch) {
    return false;
  }
  if (userId && payment.userId !== String(userId)) {
    return false;
  }
  if (courseId && payment.courseId !== String(courseId)) {
    return false;
  }
  return true;
}) || null;

const findRazorpayPaymentByReference = async ({
  paymentId = '',
  providerOrderId = '',
  providerPaymentId = '',
  userId = '',
  courseId = '',
}, client = null) => {
  const exact = isPostgresMode()
    ? await findPgPaymentByIdentifiers({ paymentId, providerOrderId, providerPaymentId, userId, courseId }, client)
    : findMemoryPaymentByIdentifiers({ paymentId, providerOrderId, providerPaymentId, userId, courseId });
  if (exact) {
    return exact;
  }
  if (!userId || !courseId) {
    return null;
  }
  if (isPostgresMode()) {
    return pgOne(
      `
        SELECT * FROM payments
        WHERE provider = 'razorpay'
          AND user_id = $1
          AND course_id = $2
        ORDER BY COALESCE(paid_at, updated_at, created_at) DESC
        LIMIT 1
      `,
      [String(userId), String(courseId)],
      mapPaymentRow,
      client,
    );
  }
  return getLatestEntry(state.payments.filter((entry) =>
    entry.provider === 'razorpay'
    && entry.userId === String(userId)
    && entry.courseId === String(courseId))) || null;
};

const verifyAndActivateRazorpayAccess = async ({
  paymentId = '',
  providerOrderId = '',
  providerPaymentId = '',
  userId = '',
  courseId = '',
  remotePayment = null,
  remoteOrder = null,
  syncSource = 'system',
  reason = '',
  actorId = null,
  ipAddress = null,
  userAgent = null,
  callbackSignatureVerified = false,
  webhookSignatureVerified = false,
}, client = null) => {
  const payment = typeof paymentId === 'object' && paymentId
    ? paymentId
    : await findRazorpayPaymentByReference({
      paymentId,
      providerOrderId,
      providerPaymentId,
      userId,
      courseId,
    }, client);

  if (!payment) {
    return {
      payment: null,
      remoteOrder: remoteOrder ? clone(remoteOrder) : null,
      remotePayment: remotePayment ? clone(remotePayment) : null,
      outcome: 'pending',
      verificationDecision: 'LOCAL_TRANSACTION_NOT_FOUND',
      verificationReason: 'No safe local transaction could be matched.',
      enrollment: null,
      enrollmentCreated: false,
      accessEnabled: false,
      validityUpdated: false,
      cacheRefreshed: false,
      manualReviewRequired: true,
    };
  }
  if (payment.provider !== 'razorpay') {
    throw new ApiError(400, 'Only Razorpay transactions can be synced from gateway', { code: 'RAZORPAY_SYNC_UNSUPPORTED' });
  }

  const resolvedProviderOrderId = String(providerOrderId || payment.providerOrderId || remotePayment?.order_id || remoteOrder?.id || '').trim();
  const resolvedProviderPaymentId = String(providerPaymentId || payment.providerPaymentId || remotePayment?.id || '').trim();
  const fetchedRemoteOrder = remoteOrder || (resolvedProviderOrderId ? await fetchRazorpayOrder(resolvedProviderOrderId).catch(() => null) : null);
  const remotePayments = remotePayment
    ? [remotePayment]
    : resolvedProviderPaymentId
      ? [await fetchRazorpayPayment(resolvedProviderPaymentId).catch(() => null)].filter(Boolean)
      : resolvedProviderOrderId
        ? await fetchRazorpayOrderPayments(resolvedProviderOrderId).catch(() => [])
        : [];
  const resolvedRemotePayment = selectBestRazorpayPayment(remotePayments, payment.providerPaymentId);
  const user = payment.userId ? await usersRepository.findSafeById(payment.userId).catch(() => null) : null;
  const course = payment.courseId ? await coursesRepository.findById(payment.courseId).catch(() => null) : null;
  if (!course && payment.courseId) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  const remoteOrderNotes = asObject(fetchedRemoteOrder?.notes);
  const remotePaymentOrderId = String(resolvedRemotePayment?.order_id || '').trim();
  const remoteOrderId = String(fetchedRemoteOrder?.id || '').trim();
  const remoteStatus = String(resolvedRemotePayment?.status || '').trim().toLowerCase();
  const receivedAmountPaise = Number(resolvedRemotePayment?.amount || 0);
  const expectedAmountPaise = course ? getCoursePayableAmountPaise(course) : Number(payment.meta?.expectedAmountPaise || 0);
  const currency = String(resolvedRemotePayment?.currency || fetchedRemoteOrder?.currency || payment.currency || 'INR').trim().toUpperCase();
  const localUserId = String(payment.userId || '').trim();
  const localCourseId = String(payment.courseId || '').trim();
  const orderMatches = Boolean(resolvedProviderOrderId && remotePaymentOrderId && resolvedProviderOrderId === remotePaymentOrderId);
  const remoteOrderMatches = !resolvedProviderOrderId || !remoteOrderId || resolvedProviderOrderId === remoteOrderId;
  const amountMatches = expectedAmountPaise > 0 && receivedAmountPaise > 0 && expectedAmountPaise === receivedAmountPaise;
  const currencyMatches = currency === 'INR';
  const refundDetected = Boolean(
    String(resolvedRemotePayment?.refund_status || '').trim()
    || Number(resolvedRemotePayment?.amount_refunded || 0) > 0
    || remoteStatus === 'refunded'
  );
  const disputeDetected = Boolean(resolvedRemotePayment?.disputed);
  const orderNoteUserId = String(remoteOrderNotes.userId || '').trim();
  const orderNoteCourseId = String(remoteOrderNotes.courseId || '').trim();
  const gatewayEmail = normalizeEmail(resolvedRemotePayment?.email || '');
  const gatewayContact = normalizeMobileNumber(resolvedRemotePayment?.contact || '');
  const localEmail = normalizeEmail(user?.email || '');
  const localMobile = normalizeMobileNumber(user?.mobileNumber || '');
  const userMatches = (!orderNoteUserId || orderNoteUserId === localUserId)
    && (!gatewayEmail || !localEmail || gatewayEmail === localEmail)
    && (!gatewayContact || !localMobile || gatewayContact === localMobile);
  const courseMatches = (!orderNoteCourseId || orderNoteCourseId === localCourseId)
    && (!payment.meta?.courseId || String(payment.meta.courseId) === localCourseId);
  const verificationNotes = [];

  let verificationDecision = 'MANUAL_REVIEW_REQUIRED';
  let verificationReason = '';
  if (!resolvedRemotePayment || !fetchedRemoteOrder) {
    verificationDecision = 'MANUAL_REVIEW_REQUIRED';
    verificationReason = 'Razorpay order or payment could not be verified safely.';
  } else if (!orderMatches || !remoteOrderMatches) {
    verificationDecision = 'ORDER_MISMATCH';
    verificationReason = 'Gateway payment does not belong to the expected Razorpay order.';
  } else if (!currencyMatches || !amountMatches) {
    verificationDecision = 'AMOUNT_MISMATCH';
    verificationReason = !currencyMatches
      ? `Currency mismatch. Expected INR but received ${currency || 'unknown'}.`
      : 'Payment amount does not match the expected course amount.';
  } else if (!userMatches) {
    verificationDecision = 'USER_MISMATCH';
    verificationReason = 'Gateway order/payment details do not safely match the expected student.';
  } else if (!courseMatches) {
    verificationDecision = 'COURSE_MISMATCH';
    verificationReason = 'Gateway order/payment details do not safely match the expected course.';
  } else if (refundDetected || disputeDetected) {
    verificationDecision = 'REFUNDED_OR_CHARGEBACK';
    verificationReason = disputeDetected
      ? 'Payment is disputed or suspicious at Razorpay.'
      : 'Payment was refunded at Razorpay.';
  } else if (remoteStatus === 'failed') {
    verificationDecision = 'GATEWAY_FAILED';
    verificationReason = String(resolvedRemotePayment?.error_description || 'Razorpay marked the payment as failed.');
  } else if (['authorized', 'created', 'pending'].includes(remoteStatus)) {
    verificationDecision = 'GATEWAY_PENDING';
    verificationReason = 'Payment is still pending confirmation at Razorpay.';
  } else if (remoteStatus === 'captured') {
    verificationDecision = 'VERIFIED_CAPTURED_ACTIVATED';
    verificationReason = 'Gateway order, payment, amount, user, and course all matched safely.';
  }

  if (orderNoteUserId) {
    verificationNotes.push(`Gateway order user note: ${orderNoteUserId}`);
  }
  if (orderNoteCourseId) {
    verificationNotes.push(`Gateway order course note: ${orderNoteCourseId}`);
  }
  if (gatewayEmail) {
    verificationNotes.push(`Gateway email: ${gatewayEmail}`);
  }
  if (gatewayContact) {
    verificationNotes.push(`Gateway contact: ${gatewayContact}`);
  }

  const presentation = getRazorpayVerificationPresentation(verificationDecision);
  const localStatus = mapRazorpayStatusToLocalPaymentStatus(resolvedRemotePayment?.status);
  const effectiveStatus = verificationDecision === 'VERIFIED_CAPTURED_ACTIVATED'
    ? 'paid'
    : verificationDecision === 'GATEWAY_FAILED'
      ? 'failed'
      : verificationDecision === 'REFUNDED_OR_CHARGEBACK'
        ? 'refunded'
        : 'pending';
  const nextMeta = buildRazorpayVerificationMeta({
    payment,
    course,
    user,
    remoteOrder: fetchedRemoteOrder,
    remotePayment: resolvedRemotePayment,
    previousMeta: payment.meta,
    syncSource,
    verificationDecision,
    verificationReason,
    verificationNotes,
    callbackSignatureVerified,
    webhookSignatureVerified,
  });
  const previousPayment = clone(payment);
  const nextPayment = {
    ...payment,
    providerOrderId: String(resolvedRemotePayment?.order_id || fetchedRemoteOrder?.id || payment.providerOrderId || ''),
    providerPaymentId: String(resolvedRemotePayment?.id || payment.providerPaymentId || ''),
    status: effectiveStatus,
    retryable: effectiveStatus !== 'paid',
    lastError: effectiveStatus === 'failed'
      ? String(resolvedRemotePayment?.error_description || payment.lastError || 'Payment failed on Razorpay.')
      : (presentation.manualReviewRequired ? verificationReason : null),
    paidAt: effectiveStatus === 'paid'
      ? (payment.paidAt || toUnixTimestampIso(resolvedRemotePayment?.captured_at || resolvedRemotePayment?.created_at) || nowIso())
      : payment.paidAt || null,
    updatedAt: nowIso(),
    meta: nextMeta,
  };

  if (client) {
    const duplicatePayment = nextPayment.providerPaymentId
      ? await pgOne(
        'SELECT id FROM payments WHERE provider_payment_id = $1 AND id <> $2 LIMIT 1',
        [nextPayment.providerPaymentId, payment._id],
        (row) => row,
        client,
      )
      : null;
    if (duplicatePayment) {
      throw new ApiError(409, 'Duplicate gateway payment ID is not allowed', { code: 'DUPLICATE_TRANSACTION_ID' });
    }
    await insertPgPayment(nextPayment, client);
  } else {
    const duplicatePayment = nextPayment.providerPaymentId
      ? state.payments.find((entry) => entry.providerPaymentId === nextPayment.providerPaymentId && entry._id !== payment._id)
      : null;
    if (duplicatePayment) {
      throw new ApiError(409, 'Duplicate gateway payment ID is not allowed', { code: 'DUPLICATE_TRANSACTION_ID' });
    }
    const paymentIndex = state.payments.findIndex((entry) => entry._id === payment._id);
    if (paymentIndex >= 0) {
      state.payments[paymentIndex] = nextPayment;
    }
  }

  const previousEnrollment = payment.courseId && payment.userId
    ? await getEnrollmentForCourse(payment.userId, payment.courseId, client)
    : null;
  const hasVerifiedCapturedAccessForCourse = async () => {
    if (!payment.courseId || !payment.userId) {
      return false;
    }

    if (verificationDecision === 'VERIFIED_CAPTURED_ACTIVATED') {
      return true;
    }

    if (client) {
      const verifiedMatch = await pgOne(
        `
          SELECT id
          FROM payments
          WHERE user_id = $1
            AND course_id = $2
            AND id <> $3
            AND status = 'paid'
            AND UPPER(COALESCE(payment_meta ->> 'verificationDecision', payment_meta ->> 'verificationStatus', '')) = 'VERIFIED_CAPTURED_ACTIVATED'
            AND LOWER(COALESCE(payment_meta ->> 'gatewayStatus', payment_meta ->> 'razorpayGatewayStatus', '')) = 'captured'
            AND COALESCE(NULLIF(provider_payment_id, ''), '') <> ''
            AND COALESCE(NULLIF(provider_order_id, ''), '') <> ''
          LIMIT 1
        `,
        [payment.userId, payment.courseId, payment._id],
        (row) => row,
        client,
      );
      return Boolean(verifiedMatch);
    }

    return state.payments.some((entry) => (
      entry._id !== payment._id
      && entry.userId === payment.userId
      && entry.courseId === payment.courseId
      && String(entry.status || '').toLowerCase() === 'paid'
      && normalizeRazorpayVerificationDecision(entry.meta?.verificationDecision || entry.meta?.verificationStatus || '') === 'VERIFIED_CAPTURED_ACTIVATED'
      && String(entry.meta?.gatewayStatus || entry.meta?.razorpayGatewayStatus || '').toLowerCase() === 'captured'
      && Boolean(entry.providerPaymentId)
      && Boolean(entry.providerOrderId)
    ));
  };
  let enrollment = previousEnrollment;
  let enrollmentCreated = false;
  let accessEnabled = false;
  let validityUpdated = false;

  if (verificationDecision === 'VERIFIED_CAPTURED_ACTIVATED' && payment.courseId && payment.userId && course) {
    const nextExpiry = (!enrollment || !isEnrollmentActive(enrollment))
      ? addDaysIso(course.validityDays || courseDefaultValidityDays)
      : enrollment.expiresAt || addDaysIso(course.validityDays || courseDefaultValidityDays);

    if (client) {
      enrollment = await insertPgEnrollment({
        userId: payment.userId,
        courseId: payment.courseId,
        source: syncSource === 'manual_admin_grant' ? 'manual_admin_grant' : 'razorpay',
        accessType: 'course',
        accessStatus: 'enabled',
        adminNote: reason || 'Auto-synced from Razorpay captured payment',
        validityDays: course.validityDays || courseDefaultValidityDays,
        expiresAt: nextExpiry,
      }, client);
    } else if (previousEnrollment) {
      previousEnrollment.source = syncSource === 'manual_admin_grant' ? 'manual_admin_grant' : 'razorpay';
      previousEnrollment.accessStatus = 'enabled';
      previousEnrollment.adminNote = reason || 'Auto-synced from Razorpay captured payment';
      previousEnrollment.expiresAt = nextExpiry;
      previousEnrollment.updatedAt = nowIso();
      enrollment = previousEnrollment;
    } else {
      enrollment = {
        _id: nextId('enrollment'),
        userId: payment.userId,
        courseId: payment.courseId,
        accessType: 'course',
        source: syncSource === 'manual_admin_grant' ? 'manual_admin_grant' : 'razorpay',
        accessStatus: 'enabled',
        adminNote: reason || 'Auto-synced from Razorpay captured payment',
        enrolledAt: nowIso(),
        expiresAt: nextExpiry,
        viewCount: 0,
        updatedAt: nowIso(),
      };
      state.enrollments.push(enrollment);
    }
    enrollmentCreated = !previousEnrollment;
    accessEnabled = true;
    validityUpdated = !previousEnrollment?.expiresAt || !isEnrollmentActive(previousEnrollment);
  } else if (previousEnrollment && payment.courseId && payment.userId) {
    const enrollmentSource = String(previousEnrollment.source || '').toLowerCase();
    const isManualGrant = ['manual_admin_grant', 'admin', 'admin_repair'].includes(enrollmentSource);
    if (!isManualGrant) {
      const hasVerifiedCapturedAccess = await hasVerifiedCapturedAccessForCourse();
      const shouldDisable = !hasVerifiedCapturedAccess;
      const disabledReason = verificationReason || (
        shouldDisable
          ? 'Access disabled after Razorpay verification failed.'
          : 'Access held until payment verification completes.'
      );
      if (client) {
        enrollment = await insertPgEnrollment({
          _id: previousEnrollment._id,
          userId: payment.userId,
          courseId: payment.courseId,
          source: enrollmentSource || 'razorpay',
          accessType: previousEnrollment.accessType || 'course',
          accessStatus: shouldDisable ? 'disabled' : previousEnrollment.accessStatus || 'enabled',
          adminNote: reason || disabledReason,
          enrolledAt: previousEnrollment.enrolledAt || nowIso(),
          expiresAt: previousEnrollment.expiresAt || addDaysIso(courseDefaultValidityDays),
          viewCount: previousEnrollment.viewCount || 0,
          updatedAt: nowIso(),
        }, client);
      } else {
        if (shouldDisable) {
          previousEnrollment.accessStatus = 'disabled';
        }
        previousEnrollment.adminNote = reason || disabledReason;
        previousEnrollment.updatedAt = nowIso();
        enrollment = previousEnrollment;
      }
    }
  }

  if (payment.userId) {
    const user = await usersRepository.findSafeById(payment.userId).catch(() => null);
    if (user) {
      queueBestEffortDeviceActivity({
        userId: user._id,
        sessionId: user.session,
        device: user.device,
        eventType: effectiveStatus === 'paid' ? 'payment_completed' : effectiveStatus === 'failed' ? 'payment_failed' : 'payment_status_synced',
        meta: {
          paymentId: payment._id,
          provider: 'razorpay',
          courseId: payment.courseId || null,
          status: effectiveStatus,
          verificationDecision,
          gatewayStatus: nextMeta.gatewayStatus || null,
          providerPaymentId: nextPayment.providerPaymentId || null,
        },
      });
    }
  }

  await insertAdminAuditLogEntry({
    adminUserId: actorId || 'system',
    actionType: syncSource === 'system' ? 'razorpay_payment_auto_synced' : 'razorpay_payment_synced',
    targetUserId: payment.userId || null,
    courseId: payment.courseId || null,
    transactionId: nextPayment.providerPaymentId || payment.providerPaymentId || payment._id,
    oldValue: previousPayment,
    newValue: {
      verificationDecision,
      verificationReason,
      payment: nextPayment,
      remoteOrder: fetchedRemoteOrder ? {
        id: fetchedRemoteOrder.id || null,
        amount: Number(fetchedRemoteOrder.amount || 0) || null,
        currency: fetchedRemoteOrder.currency || null,
        status: fetchedRemoteOrder.status || null,
        notes: asObject(fetchedRemoteOrder.notes),
      } : null,
      remotePayment: {
        id: resolvedRemotePayment?.id || null,
        orderId: resolvedRemotePayment?.order_id || null,
        status: resolvedRemotePayment?.status || null,
        method: resolvedRemotePayment?.method || null,
        rrn: getRazorpayAcquirerReference(resolvedRemotePayment),
      },
      enrollment,
    },
    reason: reason || verificationReason || `Razorpay ${effectiveStatus} sync`,
    ipAddress,
    userAgent,
  }, client);

  console.info('[payments] razorpay reconciliation complete', {
    paymentId: payment._id,
    providerOrderId: nextPayment.providerOrderId || null,
    providerPaymentId: nextPayment.providerPaymentId || null,
    localStatus: effectiveStatus,
    gatewayStatus: nextMeta.gatewayStatus || null,
    verificationDecision,
    userId: payment.userId || null,
    courseId: payment.courseId || null,
    syncSource,
    enrollmentCreated,
    accessEnabled,
  });

  return {
    payment: clone(nextPayment),
    remoteOrder: fetchedRemoteOrder ? clone(fetchedRemoteOrder) : null,
    remotePayment: resolvedRemotePayment ? clone(resolvedRemotePayment) : null,
    enrollment: enrollment ? clone(enrollment) : null,
    outcome: effectiveStatus,
    verificationDecision,
    verificationReason,
    enrollmentCreated,
    accessEnabled,
    validityUpdated,
    cacheRefreshed: Boolean(payment.userId),
    manualReviewRequired: Boolean(nextMeta.manualReviewRequired),
  };
};

const reconcileRazorpayPaymentRecord = async (payload, client = null) => verifyAndActivateRazorpayAccess(payload, client);

const paymentRepository = {
  async createCheckout(payload) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      const payment = await insertPgPayment(payload);
      queueBestEffortDeviceActivity({
        userId: payload.userId,
        eventType: 'payment_checkout_started',
        meta: {
          paymentId: payment._id,
          item: payment.item,
          amount: payment.amount,
        },
      });

      return {
        ...clone(payment),
        paymentUrl: `https://payment-gateway.com/checkout/${payment._id}`,
      };
    }

    const user = state.users.find((item) => item._id === String(payload.userId || ''));

    const payment = {
      _id: nextId('payment'),
      userId: String(payload.userId || ''),
      amount: Number(payload.amount || 0),
      currency: payload.currency || 'INR',
      item: payload.item || 'Course Purchase',
      status: 'pending',
      attemptCount: 1,
      retryable: true,
      lastError: null,
      createdAt: nowIso(),
    };

    state.payments.push(payment);

    if (user) {
      queueBestEffortDeviceActivity({
        userId: user._id,
        sessionId: user.session,
        device: user.device,
        eventType: 'payment_checkout_started',
        meta: {
          paymentId: payment._id,
          item: payment.item,
          amount: payment.amount,
        },
      });
    }

    return {
      ...clone(payment),
      paymentUrl: `https://payment-gateway.com/checkout/${payment._id}`,
    };
  },

  async createRazorpayCourseOrder(payload) {
    await ensurePlatformReady();

    const userId = String(payload.userId || '');
    const courseId = String(payload.courseId || '');
    const course = await coursesRepository.findById(courseId);
    if (!course) {
      throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
    }

    if (await hasActiveEnrollmentForCourse(userId, courseId)) {
      throw new ApiError(409, 'Course is already unlocked for this student', { code: 'COURSE_ALREADY_UNLOCKED' });
    }

    const amount = getCoursePayableAmountPaise(course);
    const currency = String(payload.currency || 'INR').trim() || 'INR';
    const item = `Course Purchase: ${course.title}`;
    const paymentPayload = {
      _id: payload.paymentId || null,
      userId,
      amount: amount / 100,
      currency,
      provider: 'razorpay',
      providerOrderId: String(payload.providerOrderId || ''),
      courseId,
      receipt: String(payload.receipt || ''),
      item,
      status: 'pending',
      attemptCount: 1,
      retryable: true,
      lastError: null,
      meta: {
        requestedAmountPaise: Number(payload.requestedAmountPaise || 0),
        expectedAmountPaise: amount,
        courseTitle: course.title,
        origin: payload.origin || null,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (isPostgresMode()) {
      const payment = await insertPgPayment(paymentPayload);
      queueBestEffortDeviceActivity({
        userId,
        eventType: 'payment_checkout_started',
        meta: {
          paymentId: payment._id,
          provider: 'razorpay',
          courseId,
          item,
          amount: payment.amount,
        },
      });
      return clone(payment);
    }

    const payment = {
      ...paymentPayload,
      _id: paymentPayload._id || nextId('payment'),
    };
    state.payments.push(payment);
    queueBestEffortDeviceActivity({
      userId,
      eventType: 'payment_checkout_started',
      meta: {
        paymentId: payment._id,
        provider: 'razorpay',
        courseId,
        item,
        amount: payment.amount,
      },
    });
    return clone(payment);
  },

  async markRazorpayCoursePaymentPaid(payload) {
    await ensurePlatformReady();

    const userId = String(payload.userId || '');
    const paymentId = String(payload.paymentId || '');
    const courseId = String(payload.courseId || '');
    const providerOrderId = String(payload.providerOrderId || '');
    const providerPaymentId = String(payload.providerPaymentId || '');
    const providerSignature = String(payload.providerSignature || '');
    const remoteStatus = String(payload.remoteStatus || 'captured').trim().toLowerCase() || 'captured';
    const remoteCreatedAt = Number(payload.remoteCreatedAt || 0);
    const remoteMethod = String(payload.remoteMethod || '').trim() || null;
    const remoteAcquirerData = asObject(payload.remoteAcquirerData);

    const loadPayment = async (client = null) => {
      const payment = client
        ? await pgOne('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [paymentId, userId], mapPaymentRow, client)
        : state.payments.find((item) => item._id === paymentId && item.userId === userId) || null;
      if (!payment) {
        throw new ApiError(404, 'Payment not found', { code: 'PAYMENT_NOT_FOUND' });
      }
      if (payment.provider !== 'razorpay') {
        throw new ApiError(400, 'Payment provider mismatch', { code: 'PAYMENT_PROVIDER_MISMATCH' });
      }
      if (payment.courseId !== courseId) {
        throw new ApiError(400, 'Payment does not match this course', { code: 'PAYMENT_COURSE_MISMATCH' });
      }
      if (payment.providerOrderId !== providerOrderId) {
        throw new ApiError(400, 'Payment order mismatch', { code: 'PAYMENT_ORDER_MISMATCH' });
      }
      return payment;
    };

    const remotePayment = {
      id: providerPaymentId,
      order_id: providerOrderId,
      status: remoteStatus,
      captured: remoteStatus === 'captured',
      created_at: Number.isFinite(remoteCreatedAt) && remoteCreatedAt > 0 ? remoteCreatedAt : Math.floor(Date.now() / 1000),
      method: remoteMethod,
      acquirer_data: remoteAcquirerData,
    };

    if (isPostgresMode()) {
      const result = await runInTransaction(async (client) => {
        const payment = await loadPayment(client);
        const synced = await verifyAndActivateRazorpayAccess({
          paymentId: {
            ...payment,
            providerSignature,
            meta: {
              ...asObject(payment.meta),
              verifiedAt: nowIso(),
              verifiedBy: 'checkout_signature',
            },
          },
          providerOrderId,
          providerPaymentId,
          remotePayment,
          syncSource: 'checkout_signature',
          reason: 'Verified from Razorpay checkout signature callback',
          actorId: userId,
          callbackSignatureVerified: true,
        }, client);
        return {
          payment: synced.payment,
          enrollment: synced.enrollment,
          verificationDecision: synced.verificationDecision,
        };
      });
      invalidatePlatformDataCache();
      invalidateUserPlatformCaches(userId);
      return result;
    }

    const payment = await loadPayment();
    const synced = await verifyAndActivateRazorpayAccess({
      paymentId: {
        ...payment,
        providerSignature,
        meta: {
          ...asObject(payment.meta),
          verifiedAt: nowIso(),
          verifiedBy: 'checkout_signature',
        },
      },
      providerOrderId,
      providerPaymentId,
      remotePayment,
      syncSource: 'checkout_signature',
      reason: 'Verified from Razorpay checkout signature callback',
      actorId: userId,
      callbackSignatureVerified: true,
    });
    invalidatePlatformDataCache();
    invalidateUserPlatformCaches(userId);
    return {
      payment: synced.payment,
      enrollment: synced.enrollment,
      verificationDecision: synced.verificationDecision,
    };
  },

  async handleWebhook(payload) {
    await ensurePlatformReady();
    const isRazorpayWebhook = Boolean(payload?.event && payload?.payload?.payment?.entity);

    if (isRazorpayWebhook) {
      const paymentEntity = payload.payload.payment.entity || {};
      const paymentId = String(paymentEntity.id || '').trim();
      const orderId = String(paymentEntity.order_id || '').trim();
      const webhookStatus = mapRazorpayStatusToLocalPaymentStatus(paymentEntity.status);

      if (isPostgresMode()) {
        const result = await runInTransaction(async (client) => {
          const localPayment = await findPgPaymentByIdentifiers({
            paymentId: '',
            providerOrderId: orderId,
            providerPaymentId: paymentId,
          }, client);
          const webhookRecord = await insertPgWebhook({
            paymentId: localPayment?._id || null,
            status: webhookStatus,
            event: String(payload.event || 'payment.updated'),
            payload: {
              ...payload,
              providerPaymentId: paymentId,
              providerOrderId: orderId,
            },
          }, client);

          if (!localPayment) {
            return webhookRecord;
          }

          const synced = await verifyAndActivateRazorpayAccess({
            paymentId: {
              ...localPayment,
              meta: {
                ...asObject(localPayment.meta),
                gatewayWebhookReceivedAt: nowIso(),
                gatewayWebhookEvent: String(payload.event || 'payment.updated'),
              },
            },
            providerOrderId: orderId,
            providerPaymentId: paymentId,
            remotePayment: paymentEntity,
            syncSource: 'razorpay_webhook',
            reason: `Auto-reconciled from Razorpay webhook ${String(payload.event || 'payment.updated')}`,
            actorId: 'system',
            webhookSignatureVerified: true,
          }, client);
          await insertPgWebhook({
            paymentId: synced.payment?._id || localPayment._id,
            status: synced.outcome,
            event: String(payload.event || 'payment.updated'),
            payload: {
              ...payload,
              syncOutcome: synced.outcome,
            },
          }, client);
          return webhookRecord;
        });
        invalidatePlatformDataCache();
        return result;
      }

      const localPayment = findMemoryPaymentByIdentifiers({
        providerOrderId: orderId,
        providerPaymentId: paymentId,
      });
      const webhookRecord = {
        _id: nextId('webhook'),
        event: String(payload.event || 'payment.updated'),
        paymentId: localPayment?._id || '',
        status: webhookStatus,
        receivedAt: nowIso(),
        payload: clone(payload),
      };
      state.webhooks.push(webhookRecord);
      if (localPayment) {
        await verifyAndActivateRazorpayAccess({
          paymentId: {
            ...localPayment,
            meta: {
              ...asObject(localPayment.meta),
              gatewayWebhookReceivedAt: nowIso(),
              gatewayWebhookEvent: String(payload.event || 'payment.updated'),
            },
          },
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          remotePayment: paymentEntity,
          syncSource: 'razorpay_webhook',
          reason: `Auto-reconciled from Razorpay webhook ${String(payload.event || 'payment.updated')}`,
          actorId: 'system',
          webhookSignatureVerified: true,
        });
        invalidateUserPlatformCaches(localPayment.userId);
      }
      invalidatePlatformDataCache();
      return clone(webhookRecord);
    }

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const webhookRecord = await insertPgWebhook(payload, client);
        const payment = await pgOne('SELECT * FROM payments WHERE id = $1', [String(webhookRecord.paymentId || '')], mapPaymentRow, client);
        if (payment) {
          const nextStatus = shouldAdvancePaymentStatus(payment.status, webhookRecord.status)
            ? webhookRecord.status
            : payment.status;
          const updatedPayment = {
            ...payment,
            status: nextStatus,
            retryable: nextStatus !== 'paid',
            lastError: nextStatus === 'failed'
              ? payload.errorMessage || 'Payment failed. Retry is available.'
              : payment.lastError || null,
            updatedAt: nowIso(),
          };
          if (nextStatus === 'paid') {
            updatedPayment.lastError = null;
          }
          await insertPgPayment(updatedPayment, client);
        }
        return webhookRecord;
      });
    }

    const webhookRecord = {
      _id: nextId('webhook'),
      event: payload.event || 'payment.updated',
      paymentId: String(payload.paymentId || ''),
      status: payload.status || 'received',
      receivedAt: nowIso(),
      payload: clone(payload),
    };
    state.webhooks.push(webhookRecord);
    return clone(webhookRecord);
  },

  async verifyAndActivateRazorpayAccess(payload = {}) {
    await ensurePlatformReady();

    const params = {
      paymentId: String(payload.paymentId || '').trim(),
      providerOrderId: String(payload.orderId || payload.providerOrderId || '').trim(),
      providerPaymentId: String(payload.gatewayPaymentId || payload.providerPaymentId || '').trim(),
      userId: String(payload.userId || '').trim(),
      courseId: String(payload.courseId || '').trim(),
    };

    if (isPostgresMode()) {
      const result = await runInTransaction(async (client) => verifyAndActivateRazorpayAccess({
        ...params,
        remotePayment: payload.remotePayment || null,
        remoteOrder: payload.remoteOrder || null,
        syncSource: String(payload.syncSource || 'manual_verification').trim() || 'manual_verification',
        reason: String(payload.reason || 'Razorpay access verification').trim() || 'Razorpay access verification',
        actorId: payload.actorId ? String(payload.actorId) : 'system',
        ipAddress: payload.ipAddress || null,
        userAgent: payload.userAgent || null,
        callbackSignatureVerified: Boolean(payload.callbackSignatureVerified),
        webhookSignatureVerified: Boolean(payload.webhookSignatureVerified),
      }, client));
      invalidatePlatformDataCache();
      if (result.payment?.userId) {
        invalidateUserPlatformCaches(result.payment.userId);
      }
      return result;
    }

    const result = await verifyAndActivateRazorpayAccess({
      ...params,
      remotePayment: payload.remotePayment || null,
      remoteOrder: payload.remoteOrder || null,
      syncSource: String(payload.syncSource || 'manual_verification').trim() || 'manual_verification',
      reason: String(payload.reason || 'Razorpay access verification').trim() || 'Razorpay access verification',
      actorId: payload.actorId ? String(payload.actorId) : 'system',
      ipAddress: payload.ipAddress || null,
      userAgent: payload.userAgent || null,
      callbackSignatureVerified: Boolean(payload.callbackSignatureVerified),
      webhookSignatureVerified: Boolean(payload.webhookSignatureVerified),
    });
    invalidatePlatformDataCache();
    if (result.payment?.userId) {
      invalidateUserPlatformCaches(result.payment.userId);
    }
    return result;
  },

  async syncRazorpayPayment(payload) {
    await ensurePlatformReady();

    const params = {
      paymentId: String(payload.paymentId || '').trim(),
      providerOrderId: String(payload.orderId || payload.providerOrderId || '').trim(),
      providerPaymentId: String(payload.gatewayPaymentId || payload.providerPaymentId || '').trim(),
      userId: String(payload.userId || '').trim(),
      courseId: String(payload.courseId || '').trim(),
    };
    const syncSource = String(payload.syncSource || 'admin_sync').trim() || 'admin_sync';
    const reason = String(payload.reason || 'Razorpay payment sync').trim() || 'Razorpay payment sync';
    const actorId = payload.actorId ? String(payload.actorId) : 'system';

    if (isPostgresMode()) {
      const result = await runInTransaction(async (client) => {
        return verifyAndActivateRazorpayAccess({
          paymentId: params.paymentId,
          providerOrderId: params.providerOrderId,
          providerPaymentId: params.providerPaymentId,
          userId: params.userId,
          courseId: params.courseId,
          syncSource,
          reason,
          actorId,
          ipAddress: payload.ipAddress || null,
          userAgent: payload.userAgent || null,
        }, client);
      });
      invalidatePlatformDataCache();
      if (result.payment?.userId) {
        invalidateUserPlatformCaches(result.payment.userId);
      }
      return result;
    }

    const result = await verifyAndActivateRazorpayAccess({
      paymentId: params.paymentId,
      providerOrderId: params.providerOrderId,
      providerPaymentId: params.providerPaymentId,
      userId: params.userId,
      courseId: params.courseId,
      syncSource,
      reason,
      actorId,
      ipAddress: payload.ipAddress || null,
      userAgent: payload.userAgent || null,
    });
    invalidatePlatformDataCache();
    if (result.payment?.userId) {
      invalidateUserPlatformCaches(result.payment.userId);
    }
    return result;
  },

  async syncAllPendingRazorpayPayments(payload = {}) {
    await ensurePlatformReady();

    const maxRecords = Math.max(1, Math.min(Number(payload.maxRecords || 500), 5000));
    const actorId = payload.actorId ? String(payload.actorId) : 'system';
    const syncSource = String(payload.syncSource || 'bulk_admin_sync').trim() || 'bulk_admin_sync';
    const summary = {
      totalChecked: 0,
      capturedFixed: 0,
      verifiedCapturedActivated: 0,
      stillPending: 0,
      failed: 0,
      refunded: 0,
      amountMismatch: 0,
      orderMismatch: 0,
      userMismatch: 0,
      courseMismatch: 0,
      manualReviewRequired: 0,
      enrollmentCreated: 0,
      accessEnabled: 0,
      cacheRefreshed: 0,
      errors: [],
      items: [],
    };

    const pendingPayments = isPostgresMode()
      ? await queryPostgres(
        `
          SELECT * FROM payments
          WHERE provider = 'razorpay'
            AND status = 'pending'
            AND COALESCE(provider_order_id, '') <> ''
          ORDER BY created_at ASC
          LIMIT $1
        `,
        [maxRecords],
      ).then((result) => result.rows.map(mapPaymentRow))
      : state.payments
        .filter((payment) => payment.provider === 'razorpay' && payment.status === 'pending' && payment.providerOrderId)
        .slice(0, maxRecords);

    for (const payment of pendingPayments) {
      summary.totalChecked += 1;
      try {
        const result = await paymentRepository.syncRazorpayPayment({
          paymentId: payment._id,
          actorId,
          syncSource,
          reason: `Bulk sync for pending Razorpay payment ${payment._id}`,
          ipAddress: payload.ipAddress || null,
          userAgent: payload.userAgent || null,
        });
        switch (normalizeRazorpayVerificationDecision(result.verificationDecision)) {
          case 'VERIFIED_CAPTURED_ACTIVATED':
            summary.capturedFixed += 1;
            summary.verifiedCapturedActivated += 1;
            break;
          case 'GATEWAY_FAILED':
            summary.failed += 1;
            break;
          case 'REFUNDED_OR_CHARGEBACK':
            summary.refunded += 1;
            break;
          case 'AMOUNT_MISMATCH':
            summary.amountMismatch += 1;
            break;
          case 'ORDER_MISMATCH':
            summary.orderMismatch += 1;
            break;
          case 'USER_MISMATCH':
            summary.userMismatch += 1;
            break;
          case 'COURSE_MISMATCH':
            summary.courseMismatch += 1;
            break;
          case 'MANUAL_REVIEW_REQUIRED':
          case 'LOCAL_TRANSACTION_NOT_FOUND':
            summary.manualReviewRequired += 1;
            break;
          default:
            summary.stillPending += 1;
            break;
        }
        if (result.enrollmentCreated) {
          summary.enrollmentCreated += 1;
        }
        if (result.accessEnabled) {
          summary.accessEnabled += 1;
        }
        if (result.cacheRefreshed) {
          summary.cacheRefreshed += 1;
        }
        summary.items.push({
          paymentId: payment._id,
          orderId: payment.providerOrderId || null,
          gatewayPaymentId: result.payment?.providerPaymentId || null,
          status: result.payment?.status || payment.status,
          verificationDecision: result.verificationDecision || null,
          courseId: payment.courseId || null,
          userId: payment.userId || null,
        });
      } catch (error) {
        summary.errors.push({
          paymentId: payment._id,
          orderId: payment.providerOrderId || null,
          message: error instanceof Error ? error.message : 'Unknown sync error',
        });
      }
    }

    return summary;
  },

  async syncPendingRazorpayPaymentsForUser(userId, payload = {}) {
    await ensurePlatformReady();

    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
      return [];
    }

    const maxRecords = Math.max(1, Math.min(Number(payload.maxRecords || 5), 20));
    const pendingPayments = isPostgresMode()
      ? await queryPostgres(
        `
          SELECT * FROM payments
          WHERE provider = 'razorpay'
            AND status = 'pending'
            AND user_id = $1
            AND COALESCE(provider_order_id, '') <> ''
          ORDER BY created_at DESC
          LIMIT $2
        `,
        [normalizedUserId, maxRecords],
      ).then((result) => result.rows.map(mapPaymentRow))
      : state.payments
        .filter((payment) => payment.provider === 'razorpay' && payment.status === 'pending' && payment.userId === normalizedUserId && payment.providerOrderId)
        .slice(0, maxRecords);

    const results = [];
    for (const payment of pendingPayments) {
      try {
        results.push(await paymentRepository.syncRazorpayPayment({
          paymentId: payment._id,
          actorId: 'system',
          syncSource: 'student_access_refresh',
          reason: 'Auto-refreshed pending Razorpay payment while loading student access',
        }));
      } catch (error) {
        results.push({
          payment: clone(payment),
          outcome: 'error',
          error: error instanceof Error ? error.message : 'Unknown sync error',
        });
      }
    }

    return results;
  },

  async retryPayment(paymentId, userId) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const updatedPayment = await pgOne(
          `
            UPDATE payments
            SET status = 'pending',
                retryable = TRUE,
                attempt_count = attempt_count + 1,
                last_error = NULL,
                updated_at = now()
            WHERE id = $1 AND user_id = $2
            RETURNING *
          `,
          [String(paymentId), String(userId)],
          mapPaymentRow,
          client,
        );

        if (!updatedPayment) {
          const payment = await pgOne('SELECT * FROM payments WHERE id = $1', [String(paymentId)], mapPaymentRow, client);
          if (!payment) {
            return null;
          }
          if (payment.userId !== String(userId)) {
            return false;
          }
          return {
            ...clone(payment),
            paymentUrl: `https://payment-gateway.com/checkout/${paymentId}?retry=${payment.attemptCount}`,
          };
        }

        queueBestEffortDeviceActivity({
          userId,
          eventType: 'payment_retry_requested',
          meta: {
            paymentId: String(paymentId),
            attempts: updatedPayment.attemptCount,
          },
        });

        return {
          ...clone(updatedPayment),
          paymentUrl: `https://payment-gateway.com/checkout/${paymentId}?retry=${updatedPayment.attemptCount}`,
        };
      });
    }

    const paymentIndex = state.payments.findIndex((item) => item._id === String(paymentId));
    if (paymentIndex === -1) {
      return null;
    }

    const payment = state.payments[paymentIndex];
    if (payment.userId !== String(userId)) {
      return false;
    }

    state.payments[paymentIndex] = {
      ...payment,
      status: 'pending',
      retryable: true,
      attemptCount: Number(payment.attemptCount || 1) + 1,
      lastError: null,
      updatedAt: nowIso(),
    };

    queueBestEffortDeviceActivity({
      userId,
      eventType: 'payment_retry_requested',
      meta: {
        paymentId: String(paymentId),
        attempts: state.payments[paymentIndex].attemptCount,
      },
    });

    return {
      ...clone(state.payments[paymentIndex]),
      paymentUrl: `https://payment-gateway.com/checkout/${paymentId}?retry=${state.payments[paymentIndex].attemptCount}`,
    };
  },
};

const platformRepository = {
  async ensureReady() {
    return ensurePlatformReady();
  },

  async getOverview(userId) {
    if (userId) {
      await paymentRepository.syncPendingRazorpayPaymentsForUser(userId, { maxRecords: 20 }).catch(() => undefined);
    }
    const data = await loadPlatformData();
    const rawUser = userId
      ? data.users.find((user) => String(user._id) === String(userId)) || null
      : null;
    const safeUser = sanitizeUser(rawUser);
    const analytics = userId ? buildUserAnalyticsFromData(data, userId) : {
      accuracy: 0,
      speed: 0,
      attempts: 0,
      weakTopics: [],
      strongTopics: [],
      suggestions: [],
      trend: buildAnalyticsTrend(data, 'guest'),
      adaptivePlan: computeAdaptivePlan({ accuracy: 0, attempts: 0 }),
      seriesPerformance: [],
    };
    const dailyQuizPromise = quizzesRepository.findByDate(new Date().toISOString().slice(0, 10));
    const gamificationPromise = userId
      ? engagementRepository.getGamification(userId)
      : Promise.resolve({ points: 0, badges: [], streak: 0, referrals: 0 });
    const weeklyLeaderboardPromise = quizzesRepository.getWeeklyLeaderboard();
    const notificationsPromise = userId
      ? notificationsRepository.list(userId, { limit: 10 }).catch(() => [])
      : Promise.resolve([]);
    const notificationCountPromise = userId
      ? notificationsRepository.count(userId).catch(() => 0)
      : Promise.resolve(0);
    const testInsightsPromise = userId
      ? Promise.resolve(computeTestInsights(data, userId))
      : Promise.resolve({ latestAttempt: null, attempts: [] });
    const adminOverviewPromise = safeUser?.role === 'admin'
      ? adminRepository.getPlatformAnalytics()
      : Promise.resolve(null);
    const leaderboardPromise = dailyQuizPromise.then((quiz) => (quiz ? quizzesRepository.getLeaderboard(quiz._id) : []));

    const [
      dailyQuiz,
      leaderboard,
      gamification,
      weeklyLeaderboard,
      notifications,
      notificationCount,
      testInsights,
      adminOverview,
    ] = await Promise.all([
      dailyQuizPromise,
      leaderboardPromise,
      gamificationPromise,
      weeklyLeaderboardPromise,
      notificationsPromise,
      notificationCountPromise,
      testInsightsPromise,
      adminOverviewPromise,
    ]);

    const userEnrollments = userId
      ? data.enrollments.filter((entry) => entry.userId === String(userId))
      : [];
    const enrollments = filterActiveEnrollments(userEnrollments);
    const enrolledCourseIds = new Set(enrollments.map((entry) => entry.courseId));
    const userPayments = userId
      ? data.payments.filter((entry) => entry.userId === String(userId))
      : [];
    const userNameById = new Map(data.users.map((user) => [user._id, user.name]));
    const decorateLeaderboard = (entries) =>
      entries.map((entry) => ({
        ...clone(entry),
        name: userNameById.get(entry.userId) || entry.name || entry.userId,
      }));

    const visibleCourses = data.courses.filter((course) => {
      if (safeUser?.role === 'admin') {
        return true;
      }

      return enrolledCourseIds.has(course._id) || Number(course.price || 0) > 0;
    });

    const courseCards = visibleCourses.map((course) => {
      const latestEnrollment = getLatestEntry(userEnrollments.filter((entry) => entry.courseId === course._id));
      const latestPayment = getBestPaymentEntry(userPayments.filter((entry) => entry.courseId === course._id));
      const access = getCourseVideoPlaybackAccess({
        course,
        enrollment: latestEnrollment,
        payment: latestPayment,
        isAdmin: safeUser?.role === 'admin',
      });
      const hasFullCourseAccess = safeUser?.role === 'admin' || Boolean(access.canAccessCourse);
      const progress = userId ? computeCourseProgress(data, userId, course) : { progressPercent: 0, continueLesson: null, continueProgressSeconds: 0 };
      const visibleCourse = redactCourseForViewer(course, hasFullCourseAccess);
      return {
        ...visibleCourse,
        enrolled: hasFullCourseAccess,
        ...access,
        progressPercent: progress.progressPercent,
        continueLesson: progress.continueLesson,
        continueProgressSeconds: progress.continueProgressSeconds,
        lessonCount: lessonListFromCourse(course).length,
        lessonProgress: progress.watchHistory || [],
      };
    });
    const tests = data.tests
      .filter((test) => canAccessLinkedTestWithCourseIds(test, enrolledCourseIds, safeUser?.role || 'guest'))
      .map((test) => redactTestForAttempt(test));

    const liveClasses = appConfig.liveClassesEnabled
      ? clone(data.liveClasses)
          .sort((left, right) => sortOldestFirst(left, right, 'startTime'))
          .map((item) => sanitizeLiveClassForViewer(item))
      : [];
    const activePlanIds = new Set(
      userId
        ? data.userSubscriptions
            .filter((subscription) => subscription.userId === String(userId) && subscription.status === 'active')
            .map((subscription) => subscription.planId)
        : [],
    );

    return {
      user: safeUser,
      highlights: {
        concurrencyTarget: adminOverview?.concurrentCapacityTarget || '',
        deploymentProfile: '',
        modules: [],
      },
      dashboard: {
        streak: gamification.streak,
        points: gamification.points,
        accuracy: analytics.accuracy,
        speed: analytics.speed,
        weakTopics: analytics.weakTopics,
        strongTopics: analytics.strongTopics,
        continueLearning: courseCards.filter((course) => course.enrolled && course.continueLesson).slice(0, 3),
        latestMockTest: testInsights.latestAttempt,
      },
      dailyQuiz: dailyQuiz
        ? {
            quiz: redactQuizForAttempt(dailyQuiz),
            leaderboard: decorateLeaderboard((leaderboard || []).slice(0, 5)),
            weeklyLeaderboard: decorateLeaderboard((weeklyLeaderboard || []).slice(0, 5)),
            streak: gamification.streak,
          }
        : null,
      courses: courseCards,
      testSeries: tests,
      liveClasses,
      subscriptions: clone(data.subscriptions).map((plan) => ({
        ...plan,
        active: activePlanIds.has(plan._id),
      })),
      notifications,
      notificationCount,
      analytics,
      ai: {
        headline: buildAiRecommendation({ accuracy: analytics.accuracy, weakTopics: analytics.weakTopics, attempts: analytics.attempts }),
        prompts: (analytics.weakTopics || []).slice(0, 3).map((topic) => `How should I revise ${topic}?`),
        generation: getAiGenerationProviders(),
      },
      sessionActivity: userId ? {
        activeSessions: safeUser?.session ? 1 : 0,
        recentSessions: getRecentSessions(data, userId),
        recentDeviceActivity: getRecentDeviceActivity(data, userId),
      } : null,
      adminOverview: adminOverview
        ? {
            ...adminOverview,
            liveClasses: appConfig.liveClassesEnabled ? adminOverview.liveClasses : 0,
          }
        : null,
    };
  },

  async enroll({ userId, courseId, source = 'payment', accessType = 'course' }) {
    await ensurePlatformReady();

    const course = await coursesRepository.findById(courseId);
    if (!course) {
      throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
    }

    const normalizedSource = String(source || 'payment');
    if (['direct-access', 'free-course', 'free', 'self-serve'].includes(normalizedSource)) {
      throw new ApiError(403, 'Course access requires a verified payment', { code: 'PAYMENT_REQUIRED' });
    }

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const enrollment = await insertPgEnrollment({
          userId,
          courseId,
          source: normalizedSource,
          accessType,
          validityDays: course.validityDays || courseDefaultValidityDays,
          expiresAt: addDaysIso(course.validityDays || courseDefaultValidityDays),
        }, client);
        queueBestEffortDeviceActivity({
          userId,
          eventType: 'course_enrolled',
          meta: {
            courseId: String(courseId),
            source: normalizedSource,
            accessType,
          },
        });

        return enrollment;
      }).finally(() => {
        invalidatePlatformDataCache();
        invalidateUserPlatformCaches(userId);
      });
    }

    const existingEnrollment = state.enrollments.find(
      (entry) => entry.userId === String(userId) && entry.courseId === String(courseId),
    );
    if (existingEnrollment) {
      return clone(existingEnrollment);
    }

    const enrollment = {
      _id: nextId('enrollment'),
      userId: String(userId),
      courseId: String(courseId),
      accessType,
      source: normalizedSource,
      enrolledAt: nowIso(),
      expiresAt: addDaysIso(course.validityDays || courseDefaultValidityDays),
      viewCount: 0,
    };

    state.enrollments.push(enrollment);
    queueBestEffortDeviceActivity({
      userId,
      eventType: 'course_enrolled',
      meta: {
        courseId: String(courseId),
        source: normalizedSource,
        accessType,
      },
    });

    invalidatePlatformDataCache();
    invalidateUserPlatformCaches(userId);
    return clone(enrollment);
  },

  async subscribe({ userId, planId, source = 'payment' }) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const existing = await pgOne(
          'SELECT * FROM subscriptions WHERE user_id = $1 AND plan_id = $2 AND status = $3',
          [String(userId), String(planId), 'active'],
          mapSubscriptionRow,
          client,
        );
        if (existing) {
          return existing;
        }

        const plan = await pgOne('SELECT * FROM subscription_plans WHERE id = $1', [String(planId)], mapPlanRow, client);
        if (!plan) {
          return null;
        }

        const durationDays = plan.billingCycle === 'yearly' ? 365 : 30;
        const subscription = await insertPgSubscription({
          userId,
          planId,
          status: 'active',
          source,
          startedAt: nowIso(),
          expiresAt: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString(),
        }, client);

        await insertPgNotification({
          userId,
          title: `${plan.title} activated`,
          message: 'Your subscription is active and premium access is available immediately.',
          type: 'subscription',
        }, client);

        queueBestEffortDeviceActivity({
          userId,
          eventType: 'subscription_activated',
          meta: {
            planId: String(planId),
          },
        });

        return subscription;
      }).finally(invalidatePlatformDataCache);
    }

    const existing = state.userSubscriptions.find(
      (entry) => entry.userId === String(userId) && entry.planId === String(planId) && entry.status === 'active',
    );
    if (existing) {
      return clone(existing);
    }

    const plan = state.subscriptions.find((item) => item._id === String(planId));
    if (!plan) {
      return null;
    }

    const durationDays = plan.billingCycle === 'yearly' ? 365 : 30;
    const subscription = {
      _id: nextId('user_subscription'),
      userId: String(userId),
      planId: String(planId),
      status: 'active',
      source,
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString(),
    };

    state.userSubscriptions.push(subscription);

    queueBestEffortDeviceActivity({
      userId,
      eventType: 'subscription_activated',
      meta: {
        planId: String(planId),
      },
    });

    await notificationsRepository.create({
      userId,
      title: `${plan.title} activated`,
      message: 'Your subscription is active and premium access is available immediately.',
      type: 'subscription',
    });

    invalidatePlatformDataCache();
    invalidateUserPlatformCaches(userId);
    return clone(subscription);
  },

  async updateWatchProgress({
    userId,
    courseId,
    lessonId,
    progressPercent,
    progressSeconds,
    completed,
    lessonStage = null,
    examSubmitted = null,
    examSelectedOption = null,
    explanationSeconds = null,
    videoWatchCount = null,
    explanationWatchCount = null,
    durationSeconds = null,
    eventType = null,
    playbackTabId = null,
    requestTimestamp = null,
    sessionId = null,
    device = null,
    requestContext = null,
  }) {
    await ensurePlatformReady();

    const course = await coursesRepository.findById(courseId);
    if (!course) {
      throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
    }

    const lesson = findLessonInCourse(course, lessonId);
    if (!lesson) {
      throw new ApiError(404, 'Lesson not found in this course', { code: 'LESSON_NOT_FOUND' });
    }

    const hasAccess = await hasActiveEnrollmentForCourse(userId, courseId);

    if (!hasAccess) {
      throw new ApiError(403, 'Enroll in the course before saving progress', { code: 'COURSE_ACCESS_REQUIRED' });
    }

    const existingRecord = isPostgresMode()
      ? await pgOne(
        'SELECT * FROM watch_history WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
        [String(userId), String(courseId), String(lessonId)],
        mapWatchHistoryRow,
      )
      : state.watchHistory.find(
        (entry) =>
          entry.userId === String(userId)
          && entry.courseId === String(courseId)
          && entry.lessonId === String(lessonId),
      ) || null;

    const isProtectedVideoLesson = lesson.type === 'private-video';
    const safeProgressPercent = Math.max(Math.min(Number(progressPercent || 0), 100), 0);
    const safeProgressSeconds = Math.max(Number(progressSeconds || 0), 0);
    const safeDurationSeconds = Math.max(Number(durationSeconds || 0), safeProgressSeconds, 0);
    const normalizedEventType = String(
      eventType
      || (completed ? 'completion' : 'progress'),
    ).trim().toLowerCase() || 'progress';
    const deliveryProfileHint = String(lesson.deliveryProfile || '').trim() || null;
    const deliveryPathHint = (() => {
      const normalizedDeliveryProfile = String(deliveryProfileHint || '').toLowerCase();
      if (
        normalizedDeliveryProfile.includes('private-source')
        || normalizedDeliveryProfile.includes('source-fallback')
      ) {
        return 'source_fallback';
      }
      if (normalizedDeliveryProfile.includes('cloudflare-stream')) {
        return 'direct_cloudflare_stream';
      }
      if (
        lesson.type === 'private-video'
        || normalizedDeliveryProfile.includes('private-hls')
        || normalizedDeliveryProfile.includes('manifest')
        || normalizedDeliveryProfile.includes('gateway')
        || normalizedDeliveryProfile.includes('cache')
      ) {
        return 'protected_hls_gateway';
      }
      return 'unknown';
    })();
    const effectiveRequestTimestamp = (() => {
      if (!requestTimestamp) {
        return nowIso();
      }
      const parsed = new Date(String(requestTimestamp));
      return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
    })();
    const effectivePlaybackTabId = String(
      playbackTabId
      || device?.playbackTabId
      || requestContext?.playbackTabId
      || '',
    ).trim() || null;
    const existingProgressSeconds = Math.max(Number(existingRecord?.progressSeconds || 0), 0);
    const existingProgressPercent = Math.max(Number(existingRecord?.progressPercent || 0), 0);
    const existingUpdatedAtMs = Date.parse(String(existingRecord?.updatedAt || existingRecord?.lastWatchedAt || ''));
    const requestTimestampMs = Date.parse(effectiveRequestTimestamp);
    const staleProgressRegression = Boolean(
      existingRecord
      && normalizedEventType !== 'seek'
      && safeProgressSeconds + 3 < existingProgressSeconds
      && safeProgressPercent + 3 < existingProgressPercent,
    );
    const staleRequestRegression = Boolean(
      existingRecord
      && Number.isFinite(existingUpdatedAtMs)
      && Number.isFinite(requestTimestampMs)
      && requestTimestampMs + 5000 < existingUpdatedAtMs
      && safeProgressSeconds <= existingProgressSeconds
      && safeProgressPercent <= existingProgressPercent
      && !completed,
    );
    const logWatchProgressDecision = (extra = {}) => {
      console.info(`[watch-progress] ${JSON.stringify({
        request_id: requestContext?.requestId || null,
        replica: requestContext?.replica || String(process.env.REPLICA_NAME || process.env.HOSTNAME || process.env.SERVICE_NAME || `pid:${process.pid}`),
        user_id: String(userId),
        course_id: String(courseId),
        lesson_id: String(lessonId),
        video_id: String(lesson._id || lesson.id || lessonId),
        incoming_current_time: safeProgressSeconds,
        saved_current_time: Math.max(Number(extra.savedCurrentTime ?? existingRecord?.progressSeconds ?? 0), 0),
        duration_seconds: safeDurationSeconds || null,
        incoming_progress_percent: safeProgressPercent,
        saved_progress_percent: Math.max(Number(extra.savedProgressPercent ?? existingRecord?.progressPercent ?? 0), 0),
        event_type: normalizedEventType,
        delivery_profile: deliveryProfileHint,
        delivery_path_hint: deliveryPathHint,
        accepted: extra.accepted ?? true,
        rejection_reason: extra.rejectionReason || null,
        completion_requested: Boolean(completed),
        completion_saved: Boolean(extra.completionSaved ?? existingRecord?.completed ?? false),
        watch_count_before: Math.max(Number(existingRecord?.videoWatchCount || 0), 0),
        watch_count_after: Math.max(Number(extra.watchCountAfter ?? existingRecord?.videoWatchCount ?? 0), 0),
        device_id: device?.id || requestContext?.deviceId || null,
        playback_tab_id: effectivePlaybackTabId,
        request_time: effectiveRequestTimestamp,
      })}`);
    };

    if (staleProgressRegression || staleRequestRegression) {
      logWatchProgressDecision({
        accepted: false,
        rejectionReason: staleProgressRegression ? 'out_of_order_progress' : 'stale_request_timestamp',
      });
      return existingRecord || null;
    }

    const normalizedLessonStage = normalizeLessonStage(lessonStage);
    const requestedVideoWatchCount = videoWatchCount === null || videoWatchCount === undefined
      ? (completed ? 1 : 0)
      : Math.max(Number(videoWatchCount || 0), 0);
    const normalizedVideoWatchCount = isProtectedVideoLesson
      ? Math.max(Number(existingRecord?.videoWatchCount || 0), 0)
      : requestedVideoWatchCount;
    const normalizedExplanationWatchCount = explanationWatchCount === null || explanationWatchCount === undefined
      ? 0
      : Math.max(Number(explanationWatchCount || 0), 0);
    const normalizedCompleted = isProtectedVideoLesson && normalizedLessonStage !== 'explanation'
      ? false
      : Boolean(completed);
    const configuredVideoWatchLimit = getLessonConfiguredWatchLimit(lesson);

    if (normalizedVideoWatchCount > configuredVideoWatchLimit) {
      throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
    }

    if (isPostgresMode()) {
      if (!normalizedCompleted) {
        const record = await upsertPgWatchHistory({
          userId,
          courseId,
          lessonId,
          progressPercent: safeProgressPercent,
          progressSeconds: safeProgressSeconds,
          completed: normalizedCompleted,
          lessonStage: normalizedLessonStage,
          examSubmitted,
          examSelectedOption,
          explanationSeconds,
          videoWatchCount: normalizedVideoWatchCount,
          explanationWatchCount: normalizedExplanationWatchCount,
          sessionId,
          device,
        });
        if (shouldInvalidateWatchProgressCaches({
          userId,
          courseId,
          lessonId,
          progressPercent: safeProgressPercent,
          progressSeconds: safeProgressSeconds,
          completed: normalizedCompleted,
        })) {
          invalidateUserPlatformCaches(userId);
        }
        logWatchProgressDecision({
          savedCurrentTime: record?.progressSeconds,
          savedProgressPercent: record?.progressPercent,
          completionSaved: record?.completed,
          watchCountAfter: record?.videoWatchCount,
        });
        return record;
      }

      return runInTransaction(async (client) => {
        const record = await upsertPgWatchHistory({
          userId,
          courseId,
          lessonId,
          progressPercent: safeProgressPercent,
          progressSeconds: safeProgressSeconds,
          completed: normalizedCompleted,
          lessonStage: normalizedLessonStage,
          examSubmitted,
          examSelectedOption,
          explanationSeconds,
          videoWatchCount: normalizedVideoWatchCount,
          explanationWatchCount: normalizedExplanationWatchCount,
          sessionId,
          device,
        }, client);
        await syncPgReplayGrantUsageFromWatchProgress({
          userId,
          courseId,
          lessonId,
          videoWatchCount: normalizedVideoWatchCount,
          completed: normalizedCompleted,
          client,
        });
        queueBestEffortDeviceActivity({
          userId,
          eventType: normalizedCompleted ? 'lesson_completed' : 'lesson_progress_updated',
          meta: {
            courseId: String(courseId),
            lessonId: String(lessonId),
            progressPercent: safeProgressPercent,
            progressSeconds: safeProgressSeconds,
            eventType: normalizedEventType,
          },
        });

        invalidatePlatformDataCache();
        invalidateUserPlatformCaches(userId);
        logWatchProgressDecision({
          savedCurrentTime: record?.progressSeconds,
          savedProgressPercent: record?.progressPercent,
          completionSaved: record?.completed,
          watchCountAfter: record?.videoWatchCount,
        });
        return record;
      });
    }

    const existingIndex = state.watchHistory.findIndex(
      (entry) =>
        entry.userId === String(userId)
        && entry.courseId === String(courseId)
        && entry.lessonId === String(lessonId),
    );
    const existingMemoryRecord = existingIndex >= 0 ? state.watchHistory[existingIndex] : null;

    const record = {
      _id: existingMemoryRecord?._id || nextId('watch'),
      userId: String(userId),
      courseId: String(courseId),
      lessonId: String(lessonId),
      progressPercent: Math.max(Number(existingMemoryRecord?.progressPercent || 0), safeProgressPercent),
      progressSeconds: Math.max(Number(existingMemoryRecord?.progressSeconds || 0), safeProgressSeconds),
      completed: Boolean(existingMemoryRecord?.completed) || Boolean(normalizedCompleted),
      lessonStage: getLessonStagePriority(existingMemoryRecord?.lessonStage) >= getLessonStagePriority(normalizedLessonStage)
        ? normalizeLessonStage(existingMemoryRecord?.lessonStage)
        : normalizedLessonStage,
      examSubmitted: Boolean(existingMemoryRecord?.examSubmitted) || Boolean(examSubmitted),
      examSelectedOption: examSelectedOption === null || examSelectedOption === undefined
        ? existingMemoryRecord?.examSelectedOption ?? null
        : Number(examSelectedOption),
      explanationSeconds: Math.max(Number(existingMemoryRecord?.explanationSeconds || 0), Math.max(Number(explanationSeconds || 0), 0)),
      videoWatchCount: Math.max(Number(existingMemoryRecord?.videoWatchCount || 0), normalizedVideoWatchCount),
      explanationWatchCount: Math.max(Number(existingMemoryRecord?.explanationWatchCount || 0), normalizedExplanationWatchCount),
      lastSessionId: sessionId || existingMemoryRecord?.lastSessionId || null,
      lastDevice: device || existingMemoryRecord?.lastDevice || null,
      lastWatchedAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (existingIndex >= 0) {
      state.watchHistory[existingIndex] = record;
    } else {
      state.watchHistory.push(record);
    }

    queueBestEffortDeviceActivity({
      userId,
      eventType: normalizedCompleted ? 'lesson_completed' : 'lesson_progress_updated',
      meta: {
        courseId: String(courseId),
        lessonId: String(lessonId),
        progressPercent: safeProgressPercent,
        progressSeconds: safeProgressSeconds,
        eventType: normalizedEventType,
      },
    });

    if (shouldInvalidateWatchProgressCaches({
      userId,
      courseId,
      lessonId,
      progressPercent: safeProgressPercent,
      progressSeconds: safeProgressSeconds,
      completed: normalizedCompleted,
    })) {
      invalidateUserPlatformCaches(userId);
    }
    syncMemoryReplayGrantUsageFromWatchProgress({
      userId,
      courseId,
      lessonId,
      videoWatchCount: normalizedVideoWatchCount,
      completed: normalizedCompleted,
    });
    logWatchProgressDecision({
      savedCurrentTime: record?.progressSeconds,
      savedProgressPercent: record?.progressPercent,
      completionSaved: record?.completed,
      watchCountAfter: record?.videoWatchCount,
    });
    return clone(record);
  },

  async recordCompletedVideoWatch({
    userId,
    courseId,
    lessonId,
    progressSeconds = 0,
    durationSeconds = 0,
    sessionId = null,
    device = null,
  }) {
    await ensurePlatformReady();

    const course = await coursesRepository.findById(courseId);
    if (!course) {
      throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
    }

    const lesson = findLessonInCourse(course, lessonId);
    if (!lesson) {
      throw new ApiError(404, 'Lesson not found in this course', { code: 'LESSON_NOT_FOUND' });
    }

    const hasAccess = await hasActiveEnrollmentForCourse(userId, courseId);
    if (!hasAccess) {
      throw new ApiError(403, 'Enroll in the course before saving progress', { code: 'COURSE_ACCESS_REQUIRED' });
    }

    const maxViews = getLessonConfiguredWatchLimit(lesson);
    const safeDurationSeconds = Math.max(Number(durationSeconds || 0), Number(progressSeconds || 0), 1);
    const safeProgressSeconds = Math.max(Number(progressSeconds || 0), 0);
    const progressPercent = Math.max(0, Math.min(100, Math.round((safeProgressSeconds / safeDurationSeconds) * 100)));

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const existing = await pgOne(
          'SELECT * FROM watch_history WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
          [String(userId), String(courseId), String(lessonId)],
          mapWatchHistoryRow,
          client,
        );
        const nextVideoWatchCount = Number(existing?.videoWatchCount || 0) + 1;
        if (Number(existing?.videoWatchCount || 0) >= maxViews) {
          throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
        }

        const record = await upsertPgWatchHistory({
          userId,
          courseId,
          lessonId,
          progressPercent,
          progressSeconds: safeProgressSeconds,
          completed: true,
          lessonStage: 'video',
          videoWatchCount: nextVideoWatchCount,
          sessionId,
          device,
        }, client);

        await syncPgReplayGrantUsageFromWatchProgress({
          userId,
          courseId,
          lessonId,
          videoWatchCount: nextVideoWatchCount,
          completed: true,
          client,
        });

        await pgExec(
          `
            UPDATE enrollments
            SET view_count = COALESCE(view_count, 0) + 1
            WHERE user_id = $1 AND course_id = $2
          `,
          [String(userId), String(courseId)],
          client,
        );

        queueBestEffortDeviceActivity({
          userId,
          eventType: 'lesson_video_watch_completed',
          meta: {
            courseId: String(courseId),
            lessonId: String(lessonId),
            videoWatchCount: nextVideoWatchCount,
          },
        });

        invalidatePlatformDataCache();
        invalidateUserPlatformCaches(userId);
        return record;
      });
    }

    const existingIndex = state.watchHistory.findIndex(
      (entry) =>
        entry.userId === String(userId)
        && entry.courseId === String(courseId)
        && entry.lessonId === String(lessonId),
    );
    const existingRecord = existingIndex >= 0 ? state.watchHistory[existingIndex] : null;
    const nextVideoWatchCount = Number(existingRecord?.videoWatchCount || 0) + 1;
    if (Number(existingRecord?.videoWatchCount || 0) >= maxViews) {
      throw new ApiError(403, 'Replay access limit reached', { code: 'REPLAY_VIEW_LIMIT_REACHED' });
    }

    const record = {
      _id: existingRecord?._id || nextId('watch'),
      userId: String(userId),
      courseId: String(courseId),
      lessonId: String(lessonId),
      progressPercent: Math.max(Number(existingRecord?.progressPercent || 0), progressPercent),
      progressSeconds: Math.max(Number(existingRecord?.progressSeconds || 0), safeProgressSeconds),
      completed: true,
      lessonStage: getLessonStagePriority(existingRecord?.lessonStage) >= getLessonStagePriority('video')
        ? normalizeLessonStage(existingRecord?.lessonStage)
        : 'video',
      examSubmitted: Boolean(existingRecord?.examSubmitted),
      examSelectedOption: existingRecord?.examSelectedOption ?? null,
      explanationSeconds: Number(existingRecord?.explanationSeconds || 0),
      videoWatchCount: nextVideoWatchCount,
      explanationWatchCount: Number(existingRecord?.explanationWatchCount || 0),
      lastSessionId: sessionId || existingRecord?.lastSessionId || null,
      lastDevice: device || existingRecord?.lastDevice || null,
      lastWatchedAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (existingIndex >= 0) {
      state.watchHistory[existingIndex] = record;
    } else {
      state.watchHistory.push(record);
    }

    syncMemoryReplayGrantUsageFromWatchProgress({
      userId,
      courseId,
      lessonId,
      videoWatchCount: nextVideoWatchCount,
      completed: true,
    });

    const enrollment = state.enrollments.find(
      (entry) => entry.userId === String(userId) && entry.courseId === String(courseId),
    );
    if (enrollment) {
      enrollment.viewCount = Number(enrollment.viewCount || 0) + 1;
    }

    queueBestEffortDeviceActivity({
      userId,
      eventType: 'lesson_video_watch_completed',
      meta: {
        courseId: String(courseId),
        lessonId: String(lessonId),
        videoWatchCount: nextVideoWatchCount,
      },
    });

    invalidateUserPlatformCaches(userId);
    return clone(record);
  },

  async incrementEnrollmentViewCount({ userId, courseId }) {
    await ensurePlatformReady();

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        await pgExec(
          `
            UPDATE enrollments
            SET view_count = COALESCE(view_count, 0) + 1
            WHERE user_id = $1 AND course_id = $2
          `,
          [String(userId), String(courseId)],
          client,
        );

        const enrollment = await pgOne(
          'SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2',
          [String(userId), String(courseId)],
          mapEnrollmentRow,
          client,
        );
        return enrollment;
      });
    }

    const enrollment = state.enrollments.find(
      (entry) => entry.userId === String(userId) && entry.courseId === String(courseId),
    );

    if (enrollment) {
      enrollment.viewCount = Number(enrollment.viewCount || 0) + 1;
      return clone(enrollment);
    }

    return null;
  },

  async askAi({ userId, message }) {
    await ensurePlatformReady();

    const normalizedMessage = String(message || '').toLowerCase();
    let answer = 'Focus on high-yield revision blocks, solve one mock test, and review every incorrect answer with the explanation.';

    if (normalizedMessage.includes('network')) {
      answer = 'Start with the fundamentals for the topic, solve a focused problem set, and revise incorrect answers before the next mock.';
    } else if (normalizedMessage.includes('7-day') || normalizedMessage.includes('plan')) {
      answer = 'Use a 7-day cycle: 3 days concept revision, 2 days sectional tests, 1 full-length mock, and 1 day for analytics review plus live class replay.';
    } else if (normalizedMessage.includes('mock')) {
      answer = 'Attempt a sectional test first if your accuracy is below 75%. Once accuracy stabilizes, move to a full-length mock with timer and negative marking enabled.';
    }

    if (isPostgresMode()) {
      return runInTransaction(async (client) => {
        const thread = await insertPgAiMessage({
          userId: userId || 'guest',
          message,
          answer,
        }, client);

        const user = await pgOne('SELECT * FROM users WHERE id = $1', [String(userId || '')], mapUserRow, client);
        if (user) {
          queueBestEffortDeviceActivity({
            userId: user._id,
            sessionId: user.session,
            device: user.device,
            eventType: 'ai_doubt_asked',
            meta: {
              message: String(message || '').slice(0, 120),
            },
          });
        }

        return thread;
      });
    }

    const thread = {
      _id: nextId('ai_message'),
      userId: String(userId || 'guest'),
      message: String(message || ''),
      answer,
      createdAt: nowIso(),
    };

    state.aiMessages.push(thread);

    const user = state.users.find((item) => item._id === String(userId));
    if (user) {
      state.deviceActivities.unshift({
        _id: nextId('activity'),
        userId: user._id,
        sessionId: user.session,
        device: user.device,
        eventType: 'ai_doubt_asked',
        meta: {
          message: String(message || '').slice(0, 120),
        },
        createdAt: nowIso(),
      });
      state.deviceActivities = state.deviceActivities.slice(0, 200);
    }

    return clone(thread);
  },
};

module.exports = {
  usersRepository,
  coursesRepository,
  testsRepository,
  quizzesRepository,
  notificationsRepository,
  engagementRepository,
  liveClassesRepository,
  adminRepository,
  analyticsRepository,
  paymentRepository,
  platformRepository,
  sessionRepository,
  videoPlaybackRepository,
  resolveProtectedLessonResumeSeconds,
  sanitizeUser,
  invalidateAllPlatformCachesForUser,
};
