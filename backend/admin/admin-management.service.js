const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { appConfig } = require('../lib/config.js');
const {
  ApiError,
  requireString,
  optionalString,
  requireNumber,
  optionalNumber,
} = require('../lib/http.js');
const { isPostgresReady, queryPostgres, runInTransaction } = require('../lib/postgres.js');
const { getHealthSnapshot } = require('../lib/health.js');
const { state, nextId, nowIso, clone } = require('../lib/store.js');
const {
  usersRepository,
  coursesRepository,
  testsRepository,
  sessionRepository,
  videoPlaybackRepository,
  invalidateAllPlatformCachesForUser,
  paymentRepository,
} = require('../lib/repositories.js');
const {
  COURSE_VIDEO_TYPE,
  normalizeVideoWatchState,
  buildVideoWatchStateSummary,
} = require('../lib/video-watch-limits.js');
const { fetchRazorpayPaymentsByDateRange } = require('../payment/razorpay-client.js');

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizePage = (value) => Math.max(1, optionalNumber(value, 1, { min: 1, integer: true }));
const normalizePageSize = (value) => Math.min(MAX_PAGE_SIZE, Math.max(1, optionalNumber(value, DEFAULT_PAGE_SIZE, { min: 1, max: MAX_PAGE_SIZE, integer: true })));
const normalizeSearch = (value) => String(value || '').trim();
const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;
const normalizeStatus = (value, allowed, fallback = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
};
const likePattern = (value) => `%${String(value || '').trim().toLowerCase()}%`;
const toIso = (value) => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const WATCH_PROGRESS_RESET_ACTIONS = ['full_reset', 'completed_watches', 'grace_unlock'];
const normalizeWatchProgressResetAction = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return 'full_reset';
  }
  if (!WATCH_PROGRESS_RESET_ACTIONS.includes(normalized)) {
    throw new ApiError(400, 'Invalid watch progress repair action', { code: 'WATCH_PROGRESS_REPAIR_ACTION_INVALID' });
  }
  return normalized;
};
const buildAdminWatchProgressRecord = (stateRecord, courseTitle = 'Course') => {
  const normalized = normalizeVideoWatchState(stateRecord);
  const summary = buildVideoWatchStateSummary(normalized);
  return {
    stateId: normalized._id,
    courseId: normalized.courseId,
    courseTitle,
    lessonId: normalized.lessonId || null,
    videoId: normalized.videoId,
    videoType: normalized.videoType || COURSE_VIDEO_TYPE,
    completedFullWatches: normalized.completedFullWatches,
    allowedFullWatches: normalized.allowedFullWatches,
    currentCycleUniqueWatchedSeconds: normalized.currentCycleUniqueWatchedSeconds,
    totalUniqueWatchedSeconds: normalized.totalUniqueWatchedSeconds,
    repeatWatchedSeconds: normalized.repeatWatchedSeconds,
    revisionBufferUsedSeconds: normalized.revisionBufferUsedSeconds,
    remainingRevisionBufferSeconds: normalized.remainingRevisionBufferSeconds,
    stableEndWindowWatchedSeconds: summary.stableEndWindowWatchedSeconds,
    completionThresholdPercentage: summary.completionThresholdPercentage,
    completionProofSatisfied: summary.completionProofSatisfied,
    completionProofSatisfiedAt: summary.completionProofSatisfiedAt || null,
    endStabilityWindowSeconds: summary.endStabilityWindowSeconds,
    endStabilitySatisfied: summary.endStabilitySatisfied,
    progressSeconds: normalized.lastPositionSeconds,
    lastHeartbeatAt: normalized.lastHeartbeatAt || null,
    activeSessionStatus: normalized.activeSessionStatus || 'idle',
    deviceId: normalized.deviceId || null,
    ipAddress: normalized.ipAddress || null,
    userAgent: normalized.userAgent || null,
    locked: Boolean(normalized.isLocked),
    updatedAt: normalized.updatedAt || null,
  };
};
const applyWatchProgressRepairAction = (stateRecord, action, timestamp) => {
  const nextState = {
    ...normalizeVideoWatchState(stateRecord),
    playbackSessionId: null,
    activeSessionStatus: 'idle',
    updatedAt: timestamp,
  };

  if (action === 'grace_unlock') {
    nextState.revisionBufferUsedSeconds = 0;
    nextState.remainingRevisionBufferSeconds = nextState.revisionBufferSeconds;
    nextState.isLocked = false;
    nextState.lockedAt = null;
    nextState.stableEndWindowWatchedSeconds = 0;
    return nextState;
  }

  if (action === 'completed_watches') {
    nextState.completedFullWatches = 0;
    nextState.revisionBufferUsedSeconds = 0;
    nextState.remainingRevisionBufferSeconds = nextState.revisionBufferSeconds;
    nextState.isLocked = false;
    nextState.lockedAt = null;
    nextState.stableEndWindowWatchedSeconds = 0;
    nextState.completionProofSatisfiedAt = null;
    return nextState;
  }

  nextState.completedFullWatches = 0;
  nextState.watchedSegments = [];
  nextState.currentCycleUniqueWatchedSeconds = 0;
  nextState.totalUniqueWatchedSeconds = 0;
  nextState.repeatWatchedSeconds = 0;
  nextState.revisionBufferUsedSeconds = 0;
  nextState.remainingRevisionBufferSeconds = nextState.revisionBufferSeconds;
  nextState.stableEndWindowWatchedSeconds = 0;
  nextState.completionProofSatisfiedAt = null;
  nextState.lastPositionSeconds = 0;
  nextState.isLocked = false;
  nextState.lockedAt = null;
  return nextState;
};
const ADMIN_PAYMENT_DEFAULT_TIMEZONE = 'Asia/Kolkata';
const ADMIN_PAYMENT_DATE_PRESETS = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'current_month', 'custom', 'all_time'];
const normalizeTimezone = (value) => String(value || ADMIN_PAYMENT_DEFAULT_TIMEZONE).trim() || ADMIN_PAYMENT_DEFAULT_TIMEZONE;
const formatDatePartsForTimezone = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value || 0),
    month: Number(parts.find((part) => part.type === 'month')?.value || 1),
    day: Number(parts.find((part) => part.type === 'day')?.value || 1),
  };
};
const getTimezoneOffsetSuffix = (timeZone) => {
  if (String(timeZone).trim() === 'Asia/Kolkata') {
    return '+05:30';
  }
  return 'Z';
};
const buildTimezoneStartDate = ({ year, month, day }, timeZone) => new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00${getTimezoneOffsetSuffix(timeZone)}`);
const addDays = (date, days) => new Date(date.getTime() + (days * 24 * 60 * 60 * 1000));
const buildPaymentRange = (query = {}) => {
  const preset = ADMIN_PAYMENT_DATE_PRESETS.includes(String(query.rangePreset || '').trim().toLowerCase())
    ? String(query.rangePreset || '').trim().toLowerCase()
    : 'today';
  const timeZone = normalizeTimezone(query.timezone);
  const now = new Date();
  const parts = formatDatePartsForTimezone(now, timeZone);
  const todayStart = buildTimezoneStartDate(parts, timeZone);
  const tomorrowStart = addDays(todayStart, 1);

  let start = todayStart;
  let end = tomorrowStart;
  let label = 'Today';
  if (preset === 'yesterday') {
    start = addDays(todayStart, -1);
    end = todayStart;
    label = 'Yesterday';
  } else if (preset === 'last_7_days') {
    start = addDays(todayStart, -6);
    end = tomorrowStart;
    label = 'Last 7 days';
  } else if (preset === 'last_30_days') {
    start = addDays(todayStart, -29);
    end = tomorrowStart;
    label = 'Last 30 days';
  } else if (preset === 'current_month') {
    start = buildTimezoneStartDate({ year: parts.year, month: parts.month, day: 1 }, timeZone);
    end = tomorrowStart;
    label = 'Current month';
  } else if (preset === 'all_time') {
    start = new Date('2000-01-01T00:00:00Z');
    end = now;
    label = 'All time';
  } else if (preset === 'custom') {
    const startDate = String(query.startDate || '').slice(0, 10);
    const endDate = String(query.endDate || '').slice(0, 10);
    if (!startDate || !endDate) {
      throw new ApiError(400, 'startDate and endDate are required for a custom payment range', { code: 'CUSTOM_RANGE_REQUIRED' });
    }
    start = new Date(`${startDate}T00:00:00${getTimezoneOffsetSuffix(timeZone)}`);
    end = addDays(new Date(`${endDate}T00:00:00${getTimezoneOffsetSuffix(timeZone)}`), 1);
    label = `${startDate} to ${endDate}`;
  }

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new ApiError(400, 'Invalid payment date range', { code: 'INVALID_PAYMENT_RANGE' });
  }

  return {
    preset,
    label,
    timezone: timeZone,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
  };
};
const getRazorpayMode = () => String(appConfig.razorpayKeyId || '').trim().startsWith('rzp_live_') ? 'live' : 'test';
const SAFE_TEST_USER_EMAIL_PATTERNS = [
  /^phase2_load_/i,
  /^platform_load_/i,
  /^qa[_-]/i,
  /^automation[_-]/i,
  /^dummy[_-]/i,
  /@edumaster\.local$/i,
];
const SAFE_TEST_COURSE_PATTERNS = [
  /^QA Load Course /i,
  /^QA Automation /i,
  /^Automation Test /i,
  /^Dummy /i,
];
const SAFE_TEST_DESCRIPTION_PATTERNS = [
  /Synthetic 1000-user QA course generated by automation\./i,
  /automation/i,
  /dummy/i,
  /qa course/i,
];
const SAFE_TEST_TEST_PATTERNS = [
  /^QA Load Mock Test /i,
  /^QA Automation /i,
  /^Automation Test /i,
];
const SAFE_TEST_LIVE_CLASS_PATTERNS = [
  /^QA /i,
  /^Automation /i,
  /^Dummy /i,
];
const CLEANUP_BACKUP_DIR = path.resolve(process.cwd(), 'tmp', 'admin-cleanup-backups');
const sha256 = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const getPaymentEventIso = (payment) => {
  const meta = asObject(payment?.payment_meta || payment?.meta);
  return (
    meta.gatewayCapturedAt
    || payment?.paid_at
    || payment?.paidAt
    || payment?.created_at
    || payment?.createdAt
    || null
  );
};
const listVerificationMetadataGaps = (payment) => {
  const meta = asObject(payment?.payment_meta || payment?.meta);
  const gaps = [];
  const decision = String(meta.verificationDecision || meta.verificationStatus || '').trim().toUpperCase();
  const gatewayStatus = String(meta.gatewayStatus || meta.razorpayGatewayStatus || '').trim().toLowerCase();
  const currency = String(meta.currency || payment?.currency || '').trim().toUpperCase() || 'INR';
  if (!String(payment?.provider_payment_id || payment?.providerPaymentId || '').trim()) {
    gaps.push('missing_gateway_payment_id');
  }
  if (!String(payment?.provider_order_id || payment?.providerOrderId || '').trim()) {
    gaps.push('missing_gateway_order_id');
  }
  if (!decision) {
    gaps.push('missing_verification_decision');
  } else if (decision !== 'VERIFIED_CAPTURED_ACTIVATED') {
    gaps.push(`verification_decision_${decision.toLowerCase()}`);
  }
  if (!gatewayStatus) {
    gaps.push('missing_gateway_status');
  } else if (gatewayStatus !== 'captured') {
    gaps.push(`gateway_status_${gatewayStatus}`);
  }
  if (currency !== 'INR') {
    gaps.push(`currency_${currency.toLowerCase()}`);
  }
  if (!meta.expectedAmount && !meta.expectedAmountPaise) {
    gaps.push('missing_expected_amount');
  }
  if (!meta.receivedAmount && !meta.receivedAmountPaise) {
    gaps.push('missing_received_amount');
  }
  if (!meta.gatewayCapturedAt) {
    gaps.push('missing_captured_at');
  }
  return gaps;
};
const normalizeCleanupEmail = (value) => String(value || '').trim().toLowerCase();
const isSafeTestEmail = (value) => {
  const email = normalizeCleanupEmail(value);
  return email ? SAFE_TEST_USER_EMAIL_PATTERNS.some((pattern) => pattern.test(email)) : false;
};
const isSafeTestCourse = (course = {}) => {
  const title = String(course.title || '').trim();
  const description = String(course.description || '').trim();
  return SAFE_TEST_COURSE_PATTERNS.some((pattern) => pattern.test(title))
    || SAFE_TEST_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(description))
    || ['qa', 'automation'].includes(String(course.category || '').trim().toLowerCase())
    || ['qa', 'automation'].includes(String(course.exam || '').trim().toLowerCase());
};
const isSafeTestTest = (test = {}) => {
  const title = String(test.title || '').trim();
  const description = String(test.description || '').trim();
  return SAFE_TEST_TEST_PATTERNS.some((pattern) => pattern.test(title))
    || /automation|synthetic|dummy/i.test(description);
};
const isSafeTestLiveClass = (liveClass = {}) => {
  const title = String(liveClass.title || '').trim();
  const description = String(liveClass.class_description || '').trim();
  return SAFE_TEST_LIVE_CLASS_PATTERNS.some((pattern) => pattern.test(title))
    || /automation|synthetic|dummy/i.test(description);
};
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
const isWithinPaymentRange = (payment, range) => {
  const eventIso = getPaymentEventIso(payment);
  const timestamp = Date.parse(eventIso || '');
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp >= Date.parse(range.startIso) && timestamp < Date.parse(range.endIso);
};
const isStrictVerifiedCapturedPayment = (payment) => {
  const meta = asObject(payment?.payment_meta || payment?.meta);
  const decision = String(meta.verificationDecision || meta.verificationStatus || '').trim().toUpperCase();
  const gatewayStatus = String(meta.gatewayStatus || meta.razorpayGatewayStatus || '').trim().toLowerCase();
  const currency = String(meta.currency || payment?.currency || '').trim().toUpperCase() || 'INR';
  const refundStatus = String(meta.refundStatus || '').trim().toLowerCase();
  const disputeStatus = String(meta.disputeStatus || '').trim().toLowerCase();
  return (
    String(payment?.status || '').trim().toLowerCase() === 'paid'
    && decision === 'VERIFIED_CAPTURED_ACTIVATED'
    && gatewayStatus === 'captured'
    && Boolean(payment?.provider_payment_id || payment?.providerPaymentId)
    && Boolean(payment?.provider_order_id || payment?.providerOrderId)
    && currency === 'INR'
    && !refundStatus
    && !disputeStatus
  );
};
const hasStrictVerifiedCapturedMeta = (paymentMeta = {}, payment = {}) => {
  const meta = asObject(paymentMeta);
  const decision = String(meta.verificationDecision || meta.verificationStatus || '').trim().toUpperCase();
  const gatewayStatus = String(meta.gatewayStatus || meta.razorpayGatewayStatus || '').trim().toLowerCase();
  const currency = String(meta.currency || payment?.currency || '').trim().toUpperCase() || 'INR';
  const refundStatus = String(meta.refundStatus || '').trim().toLowerCase();
  const disputeStatus = String(meta.disputeStatus || '').trim().toLowerCase();
  return (
    decision === 'VERIFIED_CAPTURED_ACTIVATED'
    && gatewayStatus === 'captured'
    && Boolean(payment?.provider_payment_id || payment?.providerPaymentId)
    && Boolean(payment?.provider_order_id || payment?.providerOrderId)
    && currency === 'INR'
    && !refundStatus
    && !disputeStatus
  );
};
const normalizePaymentRow = (row) => ({
  ...row,
  payment_meta: asObject(row.payment_meta),
});
const fetchAllRazorpayPaymentsForRange = async (range) => {
  const items = [];
  for (let skip = 0; ; skip += 100) {
    const payload = await fetchRazorpayPaymentsByDateRange({
      from: range.startUnix,
      to: range.endUnix,
      count: 100,
      skip,
    });
    const pageItems = Array.isArray(payload?.items) ? payload.items : [];
    items.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return items;
};
const fetchLocalPaymentsForRange = async (range) => {
  if (isPostgresReady()) {
    const result = await queryPostgres(
      `
        SELECT
          p.*,
          u.full_name,
          u.email,
          u.mobile_number,
          c.title AS course_name,
          e.source AS enrollment_source,
          e.access_status,
          e.expires_at
        FROM payments p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN courses c ON c.id = p.course_id
        LEFT JOIN enrollments e ON e.user_id = p.user_id AND e.course_id = p.course_id
        WHERE u.role <> 'admin'
      `,
    );
    return result.rows.map(normalizePaymentRow).filter((row) => isWithinPaymentRange(row, range));
  }
  return state.payments
    .map((payment) => {
      const user = state.users.find((entry) => entry._id === payment.userId);
      const course = state.courses.find((entry) => entry._id === payment.courseId);
      const enrollment = state.enrollments.find((entry) => entry.userId === payment.userId && entry.courseId === payment.courseId);
      return normalizePaymentRow({
        ...payment,
        full_name: user?.name || 'Unknown Student',
        email: user?.email || null,
        mobile_number: user?.mobileNumber || null,
        course_name: course?.title || null,
        enrollment_source: enrollment?.source || null,
        access_status: enrollment?.accessStatus || null,
        expires_at: enrollment?.expiresAt || null,
      });
    })
    .filter((row) => isWithinPaymentRange(row, range));
};
const fetchAllLocalPaidOutsideRange = async (range) => {
  if (isPostgresReady()) {
    const result = await queryPostgres(
      `
        SELECT
          p.*,
          u.full_name,
          u.email,
          u.mobile_number,
          c.title AS course_name
        FROM payments p
        LEFT JOIN users u ON u.id = p.user_id
        LEFT JOIN courses c ON c.id = p.course_id
        WHERE LOWER(p.status) = 'paid'
          AND COALESCE((NULLIF(p.payment_meta ->> 'gatewayCapturedAt', ''))::timestamptz, p.paid_at, p.created_at) < $1
        ORDER BY COALESCE((NULLIF(p.payment_meta ->> 'gatewayCapturedAt', ''))::timestamptz, p.paid_at, p.created_at) ASC
      `,
      [range.startIso],
    );
    return result.rows.map(normalizePaymentRow);
  }
  return state.payments
    .filter((payment) => String(payment.status || '').toLowerCase() === 'paid')
    .map((payment) => {
      const user = state.users.find((entry) => entry._id === payment.userId);
      const course = state.courses.find((entry) => entry._id === payment.courseId);
      return normalizePaymentRow({
        ...payment,
        full_name: user?.name || 'Unknown Student',
        email: user?.email || null,
        mobile_number: user?.mobileNumber || null,
        course_name: course?.title || null,
      });
    })
    .filter((row) => {
      const timestamp = Date.parse(getPaymentEventIso(row) || '');
      return Number.isFinite(timestamp) && timestamp < Date.parse(range.startIso);
    })
    .sort((left, right) => Date.parse(getPaymentEventIso(left) || 0) - Date.parse(getPaymentEventIso(right) || 0));
};
const asObject = (value) => (value && typeof value === 'object' ? clone(value) : {});
const sortNewestFirst = (left, right, field) => Number(new Date(right?.[field] || 0)) - Number(new Date(left?.[field] || 0));
const isRecentIso = (value, windowMs = RECENT_ACTIVITY_WINDOW_MS) => {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && (Date.now() - timestamp) <= windowMs;
};
const stringifyDevice = (value) => {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    const device = value;
    return device.label
      || device.name
      || [device.browser, device.os, device.platform].filter(Boolean).join(' / ')
      || device.id
      || null;
  }
  return String(value);
};
const extractDeviceField = (device, keys = []) => {
  if (!device || typeof device !== 'object') {
    return null;
  }
  for (const key of keys) {
    const value = device[key];
    if (value !== undefined && value !== null && value !== '') {
      return String(value);
    }
  }
  return null;
};
const isManualReviewDecision = (decision, paymentMeta = {}) => {
  const normalized = String(decision || '').trim().toUpperCase();
  if ([
    'AMOUNT_MISMATCH',
    'ORDER_MISMATCH',
    'USER_MISMATCH',
    'COURSE_MISMATCH',
    'LOCAL_TRANSACTION_NOT_FOUND',
    'MANUAL_REVIEW_REQUIRED',
    'REFUNDED_OR_CHARGEBACK',
  ].includes(normalized)) {
    return true;
  }
  return Boolean(paymentMeta?.manualReviewRequired);
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
const mapPaymentStatusLabel = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'paid') return 'success';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'pending') return 'pending';
  if (normalized === 'refunded') return 'refunded';
  if (normalized === 'manual') return 'manual';
  return normalized || 'pending';
};
const normalizeStudentQuickFilter = (value) => normalizeStatus(value, ['all', 'verified-paid', 'online', 'active-access', 'needs-review'], 'all');
const normalizeStudentSortBy = (value) => normalizeStatus(value, ['newest', 'name', 'online-first', 'verified-payments', 'active-access'], 'newest');
const applyStudentQuickFilter = (items, quickFilter) => {
  if (quickFilter === 'verified-paid') {
    return items.filter((item) => Number(item?.paymentSummary?.successful || 0) > 0);
  }
  if (quickFilter === 'online') {
    return items.filter((item) => Boolean(item?.loggedInNow));
  }
  if (quickFilter === 'active-access') {
    return items.filter((item) => Number(item?.activeCourseAccessCount || 0) > 0);
  }
  if (quickFilter === 'needs-review') {
    return items.filter((item) => Number(item?.manualReviewCount || 0) > 0);
  }
  return items;
};
const sortStudentSummaries = (items, sortBy) => items.slice().sort((left, right) => {
  if (sortBy === 'name') {
    return String(left?.name || '').localeCompare(String(right?.name || ''));
  }
  if (sortBy === 'online-first') {
    return Number(Boolean(right?.loggedInNow)) - Number(Boolean(left?.loggedInNow))
      || String(left?.name || '').localeCompare(String(right?.name || ''));
  }
  if (sortBy === 'verified-payments') {
    return Number(right?.paymentSummary?.successful || 0) - Number(left?.paymentSummary?.successful || 0)
      || Number(right?.activeCourseAccessCount || 0) - Number(left?.activeCourseAccessCount || 0)
      || String(left?.name || '').localeCompare(String(right?.name || ''));
  }
  if (sortBy === 'active-access') {
    return Number(right?.activeCourseAccessCount || 0) - Number(left?.activeCourseAccessCount || 0)
      || Number(right?.paymentSummary?.successful || 0) - Number(left?.paymentSummary?.successful || 0)
      || String(left?.name || '').localeCompare(String(right?.name || ''));
  }
  return new Date(right?.createdAt || 0).getTime() - new Date(left?.createdAt || 0).getTime();
});
const filterSortAndPaginateStudents = ({ items, quickFilter, sortBy, page, pageSize }) => {
  const filtered = applyStudentQuickFilter(items, quickFilter);
  const sorted = sortStudentSummaries(filtered, sortBy);
  const total = sorted.length;
  const offset = (page - 1) * pageSize;
  return {
    items: sorted.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
};
const normalizeLoginActivityFilter = (value) => normalizeStatus(value, ['app-active', 'video-active', 'test-active', 'logged-out-today'], '');
const isTodayDate = (value) => {
  if (!value) {
    return false;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.toDateString() === new Date().toDateString();
};
const filterLoginSessionsByActivity = (items, activityFilter) => {
  if (activityFilter === 'app-active') {
    return items.filter((item) => Boolean(item.appActiveNow));
  }
  if (activityFilter === 'video-active') {
    return items.filter((item) => Boolean(item.watchingVideoNow));
  }
  if (activityFilter === 'test-active') {
    return items.filter((item) => Boolean(item.recentTestCbtActivity));
  }
  if (activityFilter === 'logged-out-today') {
    return items.filter((item) => isTodayDate(item.logoutTime));
  }
  return items;
};
const buildLoginSessionSummary = (items) => {
  const onlineUsers = new Set();
  const loggedOutTodayUsers = new Set();
  const appActiveUsers = new Set();
  const watchingVideoUsers = new Set();
  const recentTestUsers = new Set();
  const activeSessionCountsByUser = new Map();
  let activePlaybackSessions = 0;

  items.forEach((item) => {
    if (item.sessionStatus === 'online') {
      onlineUsers.add(item.studentId);
      activeSessionCountsByUser.set(item.studentId, (activeSessionCountsByUser.get(item.studentId) || 0) + 1);
    }
    if (isTodayDate(item.logoutTime)) {
      loggedOutTodayUsers.add(item.studentId);
    }
    if (item.appActiveNow) {
      appActiveUsers.add(item.studentId);
    }
    if (item.watchingVideoNow) {
      watchingVideoUsers.add(item.studentId);
    }
    if (item.recentTestCbtActivity) {
      recentTestUsers.add(item.studentId);
    }
    activePlaybackSessions += Number(item.activePlaybackSessions || 0);
  });

  return {
    loggedInNow: onlineUsers.size,
    recentLogins: items.length,
    recentLogouts: loggedOutTodayUsers.size,
    failedLoginAttempts: 0,
    multipleDeviceLoginCount: Array.from(activeSessionCountsByUser.values()).filter((count) => count > 1).length,
    inAppNow: appActiveUsers.size,
    watchingVideosNow: watchingVideoUsers.size,
    activePlaybackSessions,
    recentTestCbtUsers: recentTestUsers.size,
  };
};
const buildPurchaseAccessStatus = (enrollment, paymentStatus) => {
  if (!enrollment) {
    return paymentStatus === 'success' ? 'pending_access' : 'disabled';
  }
  if (String(enrollment.accessStatus || 'enabled').toLowerCase() !== 'enabled') {
    return 'disabled';
  }
  if (!isEnrollmentActive(enrollment)) {
    return 'expired';
  }
  return 'enabled';
};
const toCourseAccessStatusPayload = ({
  enrollment,
  paymentStatus,
  paymentMeta = {},
}) => {
  const accessStatus = buildPurchaseAccessStatus(enrollment, paymentStatus);
  const canAccessCourse = accessStatus === 'enabled';
  const validUntil = enrollment?.expiresAt || null;
  const expired = Boolean(validUntil && Date.parse(validUntil) <= Date.now());
  let accessBlockReason = null;
  if (accessStatus === 'disabled' || accessStatus === 'removed') {
    accessBlockReason = enrollment?.adminNote || 'ACCESS_DISABLED';
  } else if (accessStatus === 'expired' || expired) {
    accessBlockReason = 'ACCESS_EXPIRED';
  } else if (paymentMeta?.manualReviewRequired) {
    accessBlockReason = 'MANUAL_REVIEW_REQUIRED';
  } else if (paymentStatus === 'pending') {
    accessBlockReason = 'PAYMENT_PENDING';
  } else if (paymentStatus === 'failed') {
    accessBlockReason = 'PAYMENT_FAILED';
  } else if (paymentStatus === 'refunded') {
    accessBlockReason = 'PAYMENT_REFUNDED';
  }
  return {
    accessStatus,
    validUntil,
    canAccessCourse,
    accessBlockReason,
  };
};

const createAuditLog = async ({
  adminUserId,
  actionType,
  targetUserId = null,
  courseId = null,
  transactionId = null,
  oldValue = {},
  newValue = {},
  reason = null,
  ipAddress = null,
  userAgent = null,
}) => {
  const entry = {
    _id: isPostgresReady() ? `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` : nextId('audit'),
    adminUserId: String(adminUserId),
    actionType: String(actionType),
    targetUserId: targetUserId ? String(targetUserId) : null,
    courseId: courseId ? String(courseId) : null,
    transactionId: transactionId ? String(transactionId) : null,
    oldValue: asObject(oldValue),
    newValue: asObject(newValue),
    reason: reason ? String(reason) : null,
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
    createdAt: nowIso(),
  };

  if (isPostgresReady()) {
    await queryPostgres(
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
    );
    return entry;
  }

  state.adminAuditLogs.unshift(entry);
  state.adminAuditLogs = state.adminAuditLogs.slice(0, 5000);
  return clone(entry);
};

const getAuditLogsForUser = async (userId, limit = 100) => {
  if (isPostgresReady()) {
    const result = await queryPostgres(
      `
        SELECT *
        FROM admin_audit_logs
        WHERE target_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [String(userId), Number(limit)],
    );
    return result.rows.map((row) => ({
      _id: row.id,
      adminUserId: row.admin_user_id,
      actionType: row.action_type,
      targetUserId: row.target_user_id || null,
      courseId: row.course_id || null,
      transactionId: row.transaction_id || null,
      oldValue: asObject(row.old_value),
      newValue: asObject(row.new_value),
      reason: row.reason || null,
      ipAddress: row.ip_address || null,
      userAgent: row.user_agent || null,
      createdAt: toIso(row.created_at) || nowIso(),
    }));
  }

  return state.adminAuditLogs
    .filter((entry) => entry.targetUserId === String(userId))
    .sort((left, right) => sortNewestFirst(left, right, 'createdAt'))
    .slice(0, limit)
    .map((entry) => clone(entry));
};

const listStudents = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const search = normalizeSearch(query.search);
  const status = normalizeStatus(query.status, ['active', 'disabled', 'blocked']);
  const quickFilter = normalizeStudentQuickFilter(query.quickFilter);
  const sortBy = normalizeStudentSortBy(query.sortBy);

  if (isPostgresReady()) {
    const params = [];
    const filters = [`u.role <> 'admin'`];

    if (search) {
      params.push(likePattern(search));
      filters.push(`(LOWER(u.full_name) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length} OR COALESCE(u.mobile_number, '') LIKE REPLACE($${params.length}, '%', ''))`);
    }

    if (status) {
      params.push(status);
      filters.push(`u.account_status = $${params.length}`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = await queryPostgres(
      `
        SELECT
          u.id,
          u.full_name,
          u.email,
          u.mobile_number,
          u.account_status,
          u.status_note,
          u.created_at,
          u.last_login_at,
          activity.last_active_at,
          activity.last_logout_at,
          COALESCE(s.active_session_count, 0)::int AS active_session_count,
          COALESCE(e.course_access_count, 0)::int AS course_access_count,
          COALESCE(e.active_course_access_count, 0)::int AS active_course_access_count,
          COALESCE(t.test_attempts_count, 0)::int AS test_attempts_count,
          COALESCE(p.success_count, 0)::int AS successful_payments_count,
          COALESCE(p.failed_count, 0)::int AS failed_payments_count,
          COALESCE(p.pending_count, 0)::int AS pending_payments_count,
          COALESCE(p.manual_review_count, 0)::int AS manual_review_count,
          COALESCE(d.device_count, 0)::int AS device_count,
          latest_payment.latest_payment_id,
          latest_payment.latest_payment_status,
          latest_payment.latest_payment_transaction_id,
          latest_payment.latest_payment_order_id,
          latest_payment.latest_payment_gateway_payment_id,
          latest_payment.latest_payment_course_name,
          latest_payment.latest_payment_verification_status,
          latest_payment.latest_payment_created_at,
          latest_device.latest_device_label
        FROM users u
        LEFT JOIN (
          SELECT user_id, COUNT(*) FILTER (WHERE status = 'active') AS active_session_count
          FROM user_sessions
          GROUP BY user_id
        ) s ON s.user_id = u.id
        LEFT JOIN (
          SELECT
            user_id,
            COUNT(*) AS course_access_count,
            COUNT(*) FILTER (
              WHERE (access_status IS NULL OR access_status = 'enabled')
                AND (expires_at IS NULL OR expires_at > now())
            ) AS active_course_access_count
          FROM enrollments
          GROUP BY user_id
        ) e ON e.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS test_attempts_count
          FROM test_attempts
          GROUP BY user_id
        ) t ON t.user_id = u.id
        LEFT JOIN (
          SELECT
            user_id,
            COUNT(*) FILTER (
              WHERE status = 'paid'
                AND UPPER(COALESCE(payment_meta ->> 'verificationDecision', payment_meta ->> 'verificationStatus', '')) = 'VERIFIED_CAPTURED_ACTIVATED'
                AND LOWER(COALESCE(payment_meta ->> 'gatewayStatus', payment_meta ->> 'razorpayGatewayStatus', '')) = 'captured'
                AND COALESCE(NULLIF(provider_payment_id, ''), NULLIF(payment_meta ->> 'providerPaymentId', ''), NULLIF(payment_meta ->> 'gatewayPaymentId', '')) IS NOT NULL
                AND COALESCE(NULLIF(provider_order_id, ''), NULLIF(payment_meta ->> 'providerOrderId', ''), NULLIF(payment_meta ->> 'gatewayOrderId', '')) IS NOT NULL
                AND UPPER(COALESCE(payment_meta ->> 'currency', currency, 'INR')) = 'INR'
                AND COALESCE(NULLIF(payment_meta ->> 'refundStatus', ''), '') = ''
                AND COALESCE(NULLIF(payment_meta ->> 'disputeStatus', ''), '') = ''
            ) AS success_count,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
            COUNT(*) FILTER (
              WHERE status = 'pending'
                AND NOT EXISTS (
                  SELECT 1
                  FROM payments verified
                  WHERE verified.user_id = payments.user_id
                    AND verified.course_id = payments.course_id
                    AND verified.status = 'paid'
                    AND UPPER(COALESCE(verified.payment_meta ->> 'verificationDecision', verified.payment_meta ->> 'verificationStatus', '')) = 'VERIFIED_CAPTURED_ACTIVATED'
                    AND LOWER(COALESCE(verified.payment_meta ->> 'gatewayStatus', verified.payment_meta ->> 'razorpayGatewayStatus', '')) = 'captured'
                    AND COALESCE(NULLIF(verified.provider_payment_id, ''), NULLIF(verified.payment_meta ->> 'providerPaymentId', ''), NULLIF(verified.payment_meta ->> 'gatewayPaymentId', '')) IS NOT NULL
                    AND COALESCE(NULLIF(verified.provider_order_id, ''), NULLIF(verified.payment_meta ->> 'providerOrderId', ''), NULLIF(verified.payment_meta ->> 'gatewayOrderId', '')) IS NOT NULL
                    AND UPPER(COALESCE(verified.payment_meta ->> 'currency', verified.currency, 'INR')) = 'INR'
                    AND COALESCE(NULLIF(verified.payment_meta ->> 'refundStatus', ''), '') = ''
                    AND COALESCE(NULLIF(verified.payment_meta ->> 'disputeStatus', ''), '') = ''
                )
            ) AS pending_count,
            COUNT(*) FILTER (
              WHERE (
                COALESCE(payment_meta ->> 'manualReviewRequired', 'false') = 'true'
                OR UPPER(COALESCE(payment_meta ->> 'verificationDecision', payment_meta ->> 'verificationStatus', '')) IN (
                  'AMOUNT_MISMATCH',
                  'ORDER_MISMATCH',
                  'USER_MISMATCH',
                  'COURSE_MISMATCH',
                  'LOCAL_TRANSACTION_NOT_FOUND',
                  'MANUAL_REVIEW_REQUIRED',
                  'REFUNDED_OR_CHARGEBACK'
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM payments verified
                WHERE verified.user_id = payments.user_id
                  AND verified.course_id = payments.course_id
                  AND verified.status = 'paid'
                  AND UPPER(COALESCE(verified.payment_meta ->> 'verificationDecision', verified.payment_meta ->> 'verificationStatus', '')) = 'VERIFIED_CAPTURED_ACTIVATED'
                  AND LOWER(COALESCE(verified.payment_meta ->> 'gatewayStatus', verified.payment_meta ->> 'razorpayGatewayStatus', '')) = 'captured'
                  AND COALESCE(NULLIF(verified.provider_payment_id, ''), NULLIF(verified.payment_meta ->> 'providerPaymentId', ''), NULLIF(verified.payment_meta ->> 'gatewayPaymentId', '')) IS NOT NULL
                  AND COALESCE(NULLIF(verified.provider_order_id, ''), NULLIF(verified.payment_meta ->> 'providerOrderId', ''), NULLIF(verified.payment_meta ->> 'gatewayOrderId', '')) IS NOT NULL
                  AND UPPER(COALESCE(verified.payment_meta ->> 'currency', verified.currency, 'INR')) = 'INR'
                  AND COALESCE(NULLIF(verified.payment_meta ->> 'refundStatus', ''), '') = ''
                  AND COALESCE(NULLIF(verified.payment_meta ->> 'disputeStatus', ''), '') = ''
              )
            ) AS manual_review_count
          FROM payments
          GROUP BY user_id
        ) p ON p.user_id = u.id
        LEFT JOIN (
          SELECT
            user_id,
            MAX(created_at) AS last_active_at,
            MAX(created_at) FILTER (WHERE event_type = 'logout') AS last_logout_at
          FROM device_activity
          GROUP BY user_id
        ) activity ON activity.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(DISTINCT COALESCE(device ->> 'id', device ->> 'deviceId', device::text)) AS device_count
          FROM user_sessions
          GROUP BY user_id
        ) d ON d.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT
            p.id AS latest_payment_id,
            p.status AS latest_payment_status,
            COALESCE(
              NULLIF(p.provider_payment_id, ''),
              NULLIF(p.payment_meta ->> 'providerPaymentId', ''),
              NULLIF(p.payment_meta ->> 'gatewayPaymentId', ''),
              p.id
            ) AS latest_payment_transaction_id,
            COALESCE(NULLIF(p.provider_order_id, ''), NULLIF(p.payment_meta ->> 'providerOrderId', ''), NULLIF(p.payment_meta ->> 'gatewayOrderId', '')) AS latest_payment_order_id,
            COALESCE(NULLIF(p.provider_payment_id, ''), NULLIF(p.payment_meta ->> 'providerPaymentId', ''), NULLIF(p.payment_meta ->> 'gatewayPaymentId', '')) AS latest_payment_gateway_payment_id,
            c.title AS latest_payment_course_name,
            UPPER(COALESCE(p.payment_meta ->> 'verificationDecision', p.payment_meta ->> 'verificationStatus', '')) AS latest_payment_verification_status,
            p.created_at AS latest_payment_created_at
          FROM payments p
          LEFT JOIN courses c ON c.id = p.course_id
          WHERE p.user_id = u.id
          ORDER BY
            CASE
              WHEN p.status = 'paid'
                AND UPPER(COALESCE(p.payment_meta ->> 'verificationDecision', p.payment_meta ->> 'verificationStatus', '')) = 'VERIFIED_CAPTURED_ACTIVATED'
                AND LOWER(COALESCE(p.payment_meta ->> 'gatewayStatus', p.payment_meta ->> 'razorpayGatewayStatus', '')) = 'captured'
              THEN 0
              WHEN p.status = 'paid' THEN 1
              WHEN p.status = 'pending' THEN 2
              WHEN p.status = 'failed' THEN 3
              WHEN p.status = 'refunded' THEN 4
              ELSE 5
            END,
            COALESCE(p.created_at, p.updated_at) DESC
          LIMIT 1
        ) latest_payment ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(
            us.device ->> 'id',
            us.device ->> 'deviceId',
            us.device ->> 'label',
            us.device ->> 'name',
            us.device ->> 'deviceName',
            NULLIF(
              TRIM(
                CONCAT(
                  COALESCE(us.device ->> 'browser', ''),
                  ' / ',
                  COALESCE(us.device ->> 'os', '')
                )
              ),
              ' / '
            ),
            us.jwt_session_id,
            us.id
          ) AS latest_device_label
          FROM user_sessions us
          WHERE us.user_id = u.id
          ORDER BY COALESCE(us.last_seen_at, us.created_at) DESC
          LIMIT 1
        ) latest_device ON true
        ${whereSql}
        ORDER BY u.created_at DESC
      `,
      params,
    );

    return filterSortAndPaginateStudents({
      items: rows.rows.map((row) => ({
        studentId: row.id,
        name: row.full_name,
        email: row.email,
        mobileNumber: row.mobile_number || null,
        accountStatus: row.account_status || 'active',
        statusNote: row.status_note || null,
        createdAt: toIso(row.created_at),
        lastLoginAt: toIso(row.last_login_at),
        lastActiveAt: toIso(row.last_active_at),
        lastLogoutAt: toIso(row.last_logout_at),
        loggedInNow: Number(row.active_session_count || 0) > 0 && isRecentIso(toIso(row.last_active_at) || toIso(row.last_login_at)),
        deviceSessionStatus: Number(row.active_session_count || 0) > 0 ? 'active' : 'inactive',
        enrolledCoursesCount: Number(row.course_access_count || 0),
        activeCourseAccessCount: Number(row.active_course_access_count || 0),
        testAttemptsCount: Number(row.test_attempts_count || 0),
        deviceCount: Number(row.device_count || 0),
        manualReviewCount: Number(row.manual_review_count || 0),
        latestPaymentId: row.latest_payment_id || null,
        latestPaymentStatus: row.latest_payment_status || null,
        latestPaymentTransactionId: row.latest_payment_transaction_id || null,
        latestPaymentOrderId: row.latest_payment_order_id || null,
        latestPaymentGatewayPaymentId: row.latest_payment_gateway_payment_id || null,
        latestPaymentCourseName: row.latest_payment_course_name || null,
        latestPaymentVerificationStatus: row.latest_payment_verification_status || null,
        latestPaymentCreatedAt: toIso(row.latest_payment_created_at),
        latestDeviceLabel: row.latest_device_label || null,
        paymentSummary: {
          successful: Number(row.successful_payments_count || 0),
          failed: Number(row.failed_payments_count || 0),
          pending: Number(row.pending_payments_count || 0),
        },
      })),
      quickFilter,
      sortBy,
      page,
      pageSize,
    });
  }

  const searchLower = search.toLowerCase();
  const users = state.users
    .filter((user) => user.role !== 'admin')
    .filter((user) => !status || String(user.accountStatus || 'active').toLowerCase() === status)
    .filter((user) => {
      if (!searchLower) {
        return true;
      }
      return [user.name, user.email, user.mobileNumber].some((value) => String(value || '').toLowerCase().includes(searchLower));
    })
    .sort((left, right) => sortNewestFirst(left, right, 'created_at'));

  const items = users.map((user) => {
    const payments = state.payments.filter((payment) => payment.userId === user._id);
    const latestPayment = payments
      .slice()
      .sort((left, right) => {
        const rankDifference = getPaymentPriorityRank(left) - getPaymentPriorityRank(right);
        if (rankDifference !== 0) return rankDifference;
        return sortNewestFirst(left, right, 'createdAt');
      })[0] || null;
    const strictVerifiedCourseIds = new Set(
      payments
        .filter((payment) => String(payment.status || '').toLowerCase() === 'paid' && hasStrictVerifiedCapturedMeta(payment.meta || payment.payment_meta, payment))
        .map((payment) => String(payment.courseId || '')),
    );
    const unresolvedPendingCount = payments.filter((payment) => {
      if (String(payment.status || '').toLowerCase() !== 'pending') {
        return false;
      }
      return !strictVerifiedCourseIds.has(String(payment.courseId || ''));
    }).length;
    const unresolvedManualReviewCount = payments.filter((payment) => {
      if (!isManualReviewDecision(payment.meta?.verificationDecision || payment.meta?.verificationStatus, payment.meta || {})) {
        return false;
      }
      return !strictVerifiedCourseIds.has(String(payment.courseId || ''));
    }).length;
    return {
      studentId: user._id,
      name: user.name,
      email: user.email,
      mobileNumber: user.mobileNumber || null,
      accountStatus: user.accountStatus || 'active',
      statusNote: user.statusNote || null,
      createdAt: user.created_at,
      lastLoginAt: user.lastLoginAt || null,
      lastActiveAt: state.deviceActivities.find((entry) => entry.userId === user._id)?.createdAt || user.lastLoginAt || null,
      lastLogoutAt: state.deviceActivities.find((entry) => entry.userId === user._id && entry.eventType === 'logout')?.createdAt || null,
      loggedInNow: state.loginSessions.some((session) => session.userId === user._id && session.status === 'active'),
      deviceSessionStatus: state.loginSessions.some((session) => session.userId === user._id && session.status === 'active') ? 'active' : 'inactive',
      enrolledCoursesCount: state.enrollments.filter((enrollment) => enrollment.userId === user._id).length,
      activeCourseAccessCount: state.enrollments.filter((enrollment) => enrollment.userId === user._id && isEnrollmentActive(enrollment)).length,
      testAttemptsCount: state.testAttempts.filter((attempt) => attempt.userId === user._id).length,
      deviceCount: new Set(state.loginSessions.filter((session) => session.userId === user._id).map((session) => stringifyDevice(session.device) || session.sessionId)).size,
      manualReviewCount: unresolvedManualReviewCount,
      latestPaymentId: latestPayment?._id || null,
      latestPaymentStatus: latestPayment?.status || null,
      latestPaymentTransactionId: latestPayment?.transactionId || null,
      latestPaymentOrderId: latestPayment?.providerOrderId || latestPayment?.meta?.providerOrderId || null,
      latestPaymentGatewayPaymentId: latestPayment?.providerPaymentId || latestPayment?.meta?.providerPaymentId || null,
      latestPaymentCourseName: coursesRepository.findById(latestPayment?.courseId || '')?.title || null,
      latestPaymentVerificationStatus: latestPayment?.meta?.verificationDecision || latestPayment?.meta?.verificationStatus || null,
      latestPaymentCreatedAt: latestPayment?.createdAt || null,
      latestDeviceLabel: (() => {
        const latestSession = state.loginSessions
          .filter((session) => session.userId === user._id)
          .sort((left, right) => sortNewestFirst(left, right, 'lastSeenAt'))[0];
        if (!latestSession) return null;
        return stringifyDevice(latestSession.device) || latestSession.sessionId || null;
      })(),
      paymentSummary: {
        successful: payments.filter((payment) => String(payment.status || '').toLowerCase() === 'paid' && hasStrictVerifiedCapturedMeta(payment.meta || payment.payment_meta, payment)).length,
        failed: payments.filter((payment) => payment.status === 'failed').length,
        pending: unresolvedPendingCount,
      },
    };
  });

  return filterSortAndPaginateStudents({
    items,
    quickFilter,
    sortBy,
    page,
    pageSize,
  });
};

const getStudentDetails = async (studentId) => {
  const user = await usersRepository.findSafeById(studentId);
  if (!user || user.role === 'admin') {
    throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
  }

  await paymentRepository.syncPendingRazorpayPaymentsForUser(studentId, { maxRecords: 20 }).catch(() => undefined);

  if (isPostgresReady()) {
    const [purchases, watchProgressRows, testAttemptsRows, sessionsRows, deviceRows, auditRows, lessonDoubtRows, lessonReportRows] = await Promise.all([
      listPurchases({ page: 1, pageSize: 100, studentId }),
      queryPostgres(
        `
          SELECT vws.*, c.title AS course_title
          FROM video_watch_states vws
          LEFT JOIN courses c ON c.id = vws.course_id
          WHERE vws.user_id = $1
          ORDER BY vws.updated_at DESC
          LIMIT 200
        `,
        [String(studentId)],
      ),
      queryPostgres(
        `
          SELECT ta.*, t.title AS test_title
          FROM test_attempts ta
          LEFT JOIN tests t ON t.id = ta.test_id
          WHERE ta.user_id = $1
          ORDER BY ta.completed_at DESC
          LIMIT 100
        `,
        [String(studentId)],
      ),
      queryPostgres(
        `SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [String(studentId)],
      ),
      queryPostgres(
        `SELECT * FROM device_activity WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [String(studentId)],
      ),
      getAuditLogsForUser(studentId, 200),
      queryPostgres(
        `
          SELECT *
          FROM lesson_doubt_threads
          WHERE student_user_id = $1
          ORDER BY COALESCE(last_message_at, updated_at, created_at) DESC
          LIMIT 100
        `,
        [String(studentId)],
      ),
      queryPostgres(
        `
          SELECT *
          FROM lesson_reports
          WHERE user_id = $1
          ORDER BY COALESCE(updated_at, created_at) DESC
          LIMIT 100
        `,
        [String(studentId)],
      ),
    ]);

    return {
      student: { ...user, accountStatus: user.accountStatus || 'active' },
      purchases: purchases.items,
      watchProgress: watchProgressRows.rows.map((row) => buildAdminWatchProgressRecord({
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
        watchedSegments: row.watched_segments,
        currentCycleUniqueWatchedSeconds: toNumber(row.current_cycle_unique_watched_seconds),
        totalUniqueWatchedSeconds: toNumber(row.total_unique_watched_seconds),
        repeatWatchedSeconds: toNumber(row.repeat_watched_seconds),
        revisionBufferSeconds: toNumber(row.revision_buffer_seconds),
        revisionBufferUsedSeconds: toNumber(row.revision_buffer_used_seconds),
        stableEndWindowWatchedSeconds: toNumber(row.stable_end_window_watched_seconds),
        completionProofSatisfiedAt: toIso(row.completion_proof_satisfied_at),
        lastPositionSeconds: toNumber(row.last_position_seconds),
        playbackSessionId: row.playback_session_id || null,
        activeSessionStatus: row.active_session_status || 'idle',
        deviceId: row.device_id || null,
        ipAddress: row.ip_address || null,
        userAgent: row.user_agent || null,
        lastHeartbeatAt: toIso(row.last_heartbeat_at),
        isLocked: Boolean(row.is_locked),
        lockedAt: toIso(row.locked_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      }, row.course_title || 'Course')),
      testAttempts: testAttemptsRows.rows.map((row) => ({
        attemptId: row.id,
        testId: row.test_id,
        testName: row.test_title || 'Test',
        score: toNumber(row.score),
        totalMarks: toNumber(row.total_marks),
        correctCount: Number(row.correct_count || 0),
        wrongCount: Number(row.incorrect_count || 0),
        skippedCount: Number(row.unattempted_count || 0),
        status: 'submitted',
        startedAt: toIso(row.started_at),
        submittedAt: toIso(row.completed_at),
        analysisAvailable: Array.isArray(row.solutions) ? row.solutions.length > 0 : true,
      })),
      supportIssues: [
        ...lessonDoubtRows.rows.map((row) => ({
          issueId: row.id,
          issueType: 'lesson_doubt',
          courseId: row.course_id,
          lessonId: row.lesson_id,
          pathLabel: [
            row.course_title,
            row.module_title || null,
            row.chapter_title || null,
            row.lesson_title,
          ].filter(Boolean).join(' -> '),
          status: row.status || 'open',
          studentMessage: row.last_message_preview || null,
          adminReply: null,
          adminNote: null,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at) || toIso(row.last_message_at),
        })),
        ...lessonReportRows.rows.map((row) => ({
          issueId: row.id,
          issueType: 'video_report',
          courseId: row.course_id,
          lessonId: row.lesson_id,
          pathLabel: [
            row.course_title,
            row.module_title || null,
            row.chapter_title || null,
            row.lesson_title,
          ].filter(Boolean).join(' -> '),
          status: row.status || 'open',
          studentMessage: row.description || null,
          adminReply: row.admin_reply || null,
          adminNote: row.admin_note || null,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
        })),
      ].sort((left, right) => sortNewestFirst(left, right, 'updatedAt')),
      sessions: sessionsRows.rows.map((row) => ({
        sessionId: row.jwt_session_id,
        status: row.status,
        device: row.device || null,
        reason: row.reason || null,
        createdAt: toIso(row.created_at),
        lastSeenAt: toIso(row.last_seen_at),
        endedAt: toIso(row.ended_at),
      })),
      deviceActivity: deviceRows.rows.map((row) => ({
        _id: row.id,
        eventType: row.event_type,
        device: row.device || null,
        meta: asObject(row.event_meta),
        createdAt: toIso(row.created_at),
      })),
      auditLog: auditRows,
    };
  }

  const purchases = await listPurchases({ page: 1, pageSize: 100, studentId });
  return {
    student: { ...sanitizeMemoryUser(user), accountStatus: user.accountStatus || 'active' },
    purchases: purchases.items,
    watchProgress: state.videoWatchStates
      .filter((entry) => entry.userId === String(studentId))
      .sort((left, right) => sortNewestFirst(left, right, 'updatedAt'))
      .slice(0, 200)
      .map((entry) => buildAdminWatchProgressRecord(entry, state.courses.find((course) => course._id === entry.courseId)?.title || 'Course')),
    testAttempts: state.testAttempts.filter((entry) => entry.userId === String(studentId)).sort((left, right) => sortNewestFirst(left, right, 'completedAt')).slice(0, 100).map((entry) => ({
      attemptId: entry._id,
      testId: entry.testId,
      testName: state.tests.find((test) => test._id === entry.testId)?.title || 'Test',
      score: entry.score,
      totalMarks: entry.totalMarks,
      correctCount: entry.correctCount,
      wrongCount: entry.incorrectCount,
      skippedCount: entry.unattemptedCount,
      status: 'submitted',
      startedAt: entry.startedAt || entry.completedAt,
      submittedAt: entry.completedAt,
      analysisAvailable: Array.isArray(entry.solutions) ? entry.solutions.length > 0 : true,
    })),
    supportIssues: [
      ...state.lessonDoubtThreads
        .filter((entry) => String(entry.studentUserId) === String(studentId))
        .map((entry) => ({
          issueId: entry._id,
          issueType: 'lesson_doubt',
          courseId: entry.courseId,
          lessonId: entry.lessonId,
          pathLabel: entry.pathLabel,
          status: entry.status || 'open',
          studentMessage: entry.lastMessagePreview || null,
          adminReply: null,
          adminNote: null,
          createdAt: entry.createdAt || null,
          updatedAt: entry.updatedAt || entry.lastMessageAt || null,
        })),
      ...state.lessonReports
        .filter((entry) => String(entry.userId) === String(studentId))
        .map((entry) => ({
          issueId: entry._id,
          issueType: 'video_report',
          courseId: entry.courseId,
          lessonId: entry.lessonId,
          pathLabel: entry.pathLabel,
          status: entry.status || 'open',
          studentMessage: entry.description || null,
          adminReply: entry.adminReply || null,
          adminNote: entry.adminNote || null,
          createdAt: entry.createdAt || null,
          updatedAt: entry.updatedAt || null,
        })),
    ].sort((left, right) => sortNewestFirst(left, right, 'updatedAt')).slice(0, 100),
    sessions: state.loginSessions.filter((entry) => entry.userId === String(studentId)).sort((left, right) => sortNewestFirst(left, right, 'createdAt')).slice(0, 100),
    deviceActivity: state.deviceActivities.filter((entry) => entry.userId === String(studentId)).sort((left, right) => sortNewestFirst(left, right, 'createdAt')).slice(0, 100),
    auditLog: await getAuditLogsForUser(studentId, 200),
  };
};

const sanitizeMemoryUser = (user) => {
  const { password, ...safeUser } = clone(user);
  return safeUser;
};

const createStudent = async ({ name, email, mobileNumber, password, adminUserId = null, requestContext = null }) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const existingEmail = await usersRepository.findByEmail(email);
  if (existingEmail) {
    throw new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
  }
  if (mobileNumber) {
    const existingMobile = await usersRepository.findByMobileNumber(mobileNumber);
    if (existingMobile) {
      throw new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
    }
  }

  const user = await usersRepository.create({
    name,
    email,
    mobileNumber,
    password: passwordHash,
    role: 'student',
    accountStatus: 'active',
  });
  if (adminUserId) {
    await createAuditLog({
      adminUserId,
      actionType: 'student_created',
      targetUserId: user._id,
      oldValue: {},
      newValue: { name, email, mobileNumber: mobileNumber || null },
      reason: 'Student created manually',
      ipAddress: requestContext?.ipAddress || null,
      userAgent: requestContext?.userAgent || null,
    });
  }
  return user;
};

const updateStudent = async (studentId, payload, options = {}) => {
  const current = await usersRepository.findById(studentId);
  if (!current || current.role === 'admin') {
    throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
  }

  if (payload.email && payload.email !== current.email) {
    const existingEmail = await usersRepository.findByEmail(payload.email);
    if (existingEmail && String(existingEmail._id) !== String(studentId)) {
      throw new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
    }
  }
  if (payload.mobileNumber && payload.mobileNumber !== current.mobileNumber) {
    const existingMobile = await usersRepository.findByMobileNumber(payload.mobileNumber);
    if (existingMobile && String(existingMobile._id) !== String(studentId)) {
      throw new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
    }
  }

  const updated = await usersRepository.update(studentId, payload);
  if (options.adminUserId) {
    await createAuditLog({
      adminUserId: options.adminUserId,
      actionType: 'student_updated',
      targetUserId: studentId,
      oldValue: {
        name: current.name,
        email: current.email,
        mobileNumber: current.mobileNumber || null,
      },
      newValue: {
        name: updated?.name,
        email: updated?.email,
        mobileNumber: updated?.mobileNumber || null,
      },
      reason: options.reason || 'Student profile updated',
      ipAddress: options.requestContext?.ipAddress || null,
      userAgent: options.requestContext?.userAgent || null,
    });
  }
  return updated;
};

const updateStudentStatus = async ({ studentId, status, note, adminUserId, requestContext }) => {
  const current = await usersRepository.findById(studentId);
  if (!current || current.role === 'admin') {
    throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
  }
  const nextPatch = {
    accountStatus: status,
    statusNote: note || null,
    disabledAt: status === 'disabled' ? nowIso() : null,
    blockedAt: status === 'blocked' ? nowIso() : null,
    session: status === 'active' ? current.session : null,
  };
  const updated = await usersRepository.update(studentId, nextPatch);
  if (status !== 'active') {
    await forceLogoutStudent({ studentId, adminUserId, requestContext, reason: `account_${status}` });
  }
  await createAuditLog({
    adminUserId,
    actionType: 'student_status_updated',
    targetUserId: studentId,
    oldValue: {
      accountStatus: current.accountStatus || 'active',
      statusNote: current.statusNote || null,
    },
    newValue: {
      accountStatus: status,
      statusNote: note || null,
    },
    reason: note || null,
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return updated;
};

const resetStudentPassword = async ({ studentId, newPassword, adminUserId, requestContext, reason }) => {
  const current = await usersRepository.findById(studentId);
  if (!current || current.role === 'admin') {
    throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await usersRepository.update(studentId, {
    password: passwordHash,
  });
  await forceLogoutStudent({ studentId, adminUserId, requestContext, reason: 'password_reset' });
  await createAuditLog({
    adminUserId,
    actionType: 'student_password_reset',
    targetUserId: studentId,
    oldValue: {},
    newValue: { passwordReset: true },
    reason: reason || 'Admin password reset',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const forceLogoutStudent = async ({ studentId, adminUserId = null, requestContext = null, reason = 'admin_force_logout' }) => {
  const current = await usersRepository.findById(studentId);
  if (!current) {
    throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
  }

  if (isPostgresReady()) {
    await runInTransaction(async (client) => {
      await queryPostgres(
        `UPDATE users SET active_session_id = NULL, updated_at = now() WHERE id = $1`,
        [String(studentId)],
        client,
      );
      await queryPostgres(
        `UPDATE user_sessions SET status = 'ended', reason = $2, ended_at = now(), last_seen_at = now() WHERE user_id = $1 AND status = 'active'`,
        [String(studentId), String(reason)],
        client,
      );
    });
  } else {
    const user = state.users.find((entry) => entry._id === String(studentId));
    if (user) {
      user.session = null;
      user.updated_at = nowIso();
    }
    state.loginSessions = state.loginSessions.map((entry) => (
      entry.userId === String(studentId) && entry.status === 'active'
        ? { ...entry, status: 'ended', reason, endedAt: nowIso(), lastSeenAt: nowIso() }
        : entry
    ));
  }

  await sessionRepository.clearActiveSession(studentId);
  if (adminUserId) {
    await createAuditLog({
      adminUserId,
      actionType: 'student_force_logout',
      targetUserId: studentId,
      oldValue: { hadActiveSession: Boolean(current.session) },
      newValue: { hadActiveSession: false },
      reason,
      ipAddress: requestContext?.ipAddress || null,
      userAgent: requestContext?.userAgent || null,
    });
  }
  return { success: true };
};

const clearPlaybackSessions = async ({ studentId, adminUserId, requestContext }) => {
  if (isPostgresReady()) {
    await queryPostgres(
      `
        UPDATE video_watch_states
        SET playback_session_id = NULL, active_session_status = 'idle', updated_at = now()
        WHERE user_id = $1
      `,
      [String(studentId)],
    );
  } else {
    state.videoWatchStates = state.videoWatchStates.map((entry) => (
      entry.userId === String(studentId)
        ? { ...entry, playbackSessionId: null, activeSessionStatus: 'idle', updatedAt: nowIso() }
        : entry
    ));
  }
  await videoPlaybackRepository.clearActivePlaybackSession(studentId);
  await createAuditLog({
    adminUserId,
    actionType: 'student_playback_sessions_cleared',
    targetUserId: studentId,
    oldValue: {},
    newValue: { cleared: true },
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const resetWatchProgress = async ({ studentId, stateId, adminUserId, requestContext, reason, action }) => {
  const repairAction = normalizeWatchProgressResetAction(action);
  const timestamp = nowIso();
  if (isPostgresReady()) {
    const currentResult = await queryPostgres(`SELECT * FROM video_watch_states WHERE id = $1 AND user_id = $2`, [String(stateId), String(studentId)]);
    const current = currentResult.rows[0];
    if (!current) {
      throw new ApiError(404, 'Watch progress not found', { code: 'WATCH_PROGRESS_NOT_FOUND' });
    }
    const repairedState = applyWatchProgressRepairAction({
      _id: current.id,
      userId: current.user_id,
      courseId: current.course_id,
      lessonId: current.lesson_id || null,
      videoId: current.video_id,
      videoType: current.video_type || COURSE_VIDEO_TYPE,
      videoDurationSeconds: Number(current.video_duration_seconds || 0),
      allowedFullWatches: Number(current.allowed_full_watches || 0),
      completedFullWatches: Number(current.completed_full_watches || 0),
      fullWatchThresholdPercentage: toNumber(current.full_watch_threshold_percentage),
      watchedSegments: current.watched_segments,
      currentCycleUniqueWatchedSeconds: toNumber(current.current_cycle_unique_watched_seconds),
      totalUniqueWatchedSeconds: toNumber(current.total_unique_watched_seconds),
      repeatWatchedSeconds: toNumber(current.repeat_watched_seconds),
      revisionBufferSeconds: toNumber(current.revision_buffer_seconds),
      revisionBufferUsedSeconds: toNumber(current.revision_buffer_used_seconds),
      stableEndWindowWatchedSeconds: toNumber(current.stable_end_window_watched_seconds),
      completionProofSatisfiedAt: toIso(current.completion_proof_satisfied_at),
      lastPositionSeconds: toNumber(current.last_position_seconds),
      playbackSessionId: current.playback_session_id || null,
      activeSessionStatus: current.active_session_status || 'idle',
      deviceId: current.device_id || null,
      ipAddress: current.ip_address || null,
      userAgent: current.user_agent || null,
      lastHeartbeatAt: toIso(current.last_heartbeat_at),
      isLocked: Boolean(current.is_locked),
      lockedAt: toIso(current.locked_at),
      createdAt: toIso(current.created_at),
      updatedAt: toIso(current.updated_at),
    }, repairAction, timestamp);
    await videoPlaybackRepository.saveWatchState(repairedState);
    await videoPlaybackRepository.clearActivePlaybackSession(studentId);
    await createAuditLog({
      adminUserId,
      actionType: 'watch_progress_repaired',
      targetUserId: studentId,
      courseId: current.course_id || null,
      oldValue: { stateId, completedFullWatches: Number(current.completed_full_watches || 0), locked: Boolean(current.is_locked) },
      newValue: { stateId, repairAction, reset: repairAction === 'full_reset' },
      reason: reason || null,
      ipAddress: requestContext?.ipAddress || null,
      userAgent: requestContext?.userAgent || null,
    });
    return { success: true };
  }

  const index = state.videoWatchStates.findIndex((entry) => entry._id === String(stateId) && entry.userId === String(studentId));
  if (index === -1) {
    throw new ApiError(404, 'Watch progress not found', { code: 'WATCH_PROGRESS_NOT_FOUND' });
  }
  const current = state.videoWatchStates[index];
  state.videoWatchStates[index] = applyWatchProgressRepairAction(current, repairAction, timestamp);
  await videoPlaybackRepository.clearActivePlaybackSession(studentId);
  await createAuditLog({
    adminUserId,
    actionType: 'watch_progress_repaired',
    targetUserId: studentId,
    courseId: current.courseId || null,
    oldValue: { stateId, completedFullWatches: Number(current.completedFullWatches || 0), locked: Boolean(current.isLocked) },
    newValue: { stateId, repairAction, reset: repairAction === 'full_reset' },
    reason: reason || null,
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const buildPurchaseItem = ({ enrollment, payment, user, course }) => {
  const paymentStatus = mapPaymentStatusLabel(payment?.status || (enrollment?.source === 'admin' ? 'manual' : 'pending'));
  const paymentMeta = asObject(payment?.meta || payment?.payment_meta);
  return {
    purchaseId: enrollment?._id || `payment_${payment?._id || 'unknown'}`,
    paymentId: payment?._id || null,
    studentId: user?._id || payment?.userId || enrollment?.userId || null,
    studentName: user?.name || 'Unknown Student',
    studentEmail: user?.email || null,
    studentMobile: user?.mobileNumber || null,
    courseId: course?._id || payment?.courseId || enrollment?.courseId || null,
    courseName: course?.title || payment?.meta?.courseTitle || 'Course',
    transactionId: payment?.providerPaymentId || payment?._id || null,
    paymentGatewayName: payment?.provider || (enrollment?.source === 'admin' ? 'manual' : null),
    paymentAmount: payment?.amount || null,
    courseFee: course?.price || null,
    paymentStatus,
    purchaseDate: payment?.createdAt || enrollment?.enrolledAt || null,
    courseStartDate: enrollment?.enrolledAt || null,
    validUntil: enrollment?.expiresAt || null,
    accessStatus: buildPurchaseAccessStatus(enrollment, paymentStatus),
    paymentProof: payment?.meta?.paymentProofUrl || null,
    accessSource: enrollment?.source || payment?.provider || 'payment',
    createdAt: payment?.createdAt || enrollment?.enrolledAt || null,
    updatedAt: enrollment?.updatedAt || payment?.updatedAt || payment?.createdAt || null,
    adminNote: enrollment?.adminNote || payment?.meta?.adminNote || null,
    gatewayOrderId: payment?.providerOrderId || null,
    gatewayPaymentId: payment?.providerPaymentId || null,
    gatewayStatus: paymentMeta.gatewayStatus || paymentMeta.razorpayGatewayStatus || null,
    verificationStatus: paymentMeta.verificationDecision || paymentMeta.verificationStatus || null,
    verificationReason: paymentMeta.verificationReason || null,
  };
};

const listPurchases = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const offset = (page - 1) * pageSize;
  const search = normalizeSearch(query.search);
  const courseId = optionalString(query.courseId, '');
  const paymentStatus = normalizeStatus(query.paymentStatus, ['success', 'failed', 'pending', 'refunded', 'manual']);
  const accessStatus = normalizeStatus(query.accessStatus, ['enabled', 'disabled', 'expired', 'pending_access']);
  const studentId = optionalString(query.studentId, '');

  if (isPostgresReady()) {
    const params = [];
    const filters = [];
    if (studentId) {
      params.push(studentId);
      filters.push(`base.student_id = $${params.length}`);
    }
    if (courseId) {
      params.push(courseId);
      filters.push(`base.course_id = $${params.length}`);
    }
    if (search) {
      params.push(likePattern(search));
      filters.push(`(
        LOWER(COALESCE(base.purchase_id, '')) LIKE $${params.length}
        OR
        LOWER(COALESCE(base.student_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(base.student_email, '')) LIKE $${params.length}
        OR LOWER(COALESCE(base.student_mobile, '')) LIKE REPLACE($${params.length}, '%', '')
        OR LOWER(COALESCE(base.course_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(base.transaction_id, '')) LIKE $${params.length}
      )`);
    }
    if (paymentStatus) {
      params.push(paymentStatus);
      filters.push(`base.payment_status = $${params.length}`);
    }
    if (accessStatus) {
      params.push(accessStatus);
      filters.push(`base.access_status = $${params.length}`);
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const baseSql = `
      WITH latest_payments AS (
        SELECT DISTINCT ON (p.user_id, p.course_id)
          p.id,
          p.user_id,
          p.course_id,
          p.provider,
          p.provider_order_id,
          p.provider_payment_id,
          p.amount_inr,
          p.status,
          p.payment_meta,
          p.created_at,
          p.updated_at
        FROM payments p
        ORDER BY
          p.user_id,
          p.course_id,
          CASE
            WHEN p.status = 'paid'
              AND UPPER(COALESCE(p.payment_meta ->> 'verificationDecision', p.payment_meta ->> 'verificationStatus', '')) = 'VERIFIED_CAPTURED_ACTIVATED'
              AND LOWER(COALESCE(p.payment_meta ->> 'gatewayStatus', p.payment_meta ->> 'razorpayGatewayStatus', '')) = 'captured'
            THEN 0
            WHEN p.status = 'paid' THEN 1
            WHEN p.status = 'pending' THEN 2
            WHEN p.status = 'failed' THEN 3
            WHEN p.status = 'refunded' THEN 4
            ELSE 5
          END ASC,
          COALESCE(p.paid_at, p.updated_at, p.created_at) DESC
      ),
      enrollment_rows AS (
        SELECT
          e.id AS purchase_id,
          lp.id AS payment_id,
          u.id AS student_id,
          u.full_name AS student_name,
          u.email AS student_email,
          u.mobile_number AS student_mobile,
          c.id AS course_id,
          c.title AS course_name,
          lp.provider_payment_id AS transaction_id,
          lp.provider AS payment_gateway_name,
          lp.amount_inr AS payment_amount,
          c.price_inr AS course_fee,
          CASE
            WHEN lp.status = 'paid' THEN 'success'
            WHEN lp.status = 'failed' THEN 'failed'
            WHEN lp.status = 'refunded' THEN 'refunded'
            WHEN lp.status = 'pending' THEN 'pending'
            WHEN e.source = 'admin' THEN 'manual'
            ELSE COALESCE(lp.status, 'pending')
          END AS payment_status,
          COALESCE(lp.created_at, e.enrolled_at) AS purchase_date,
          e.enrolled_at AS course_start_date,
          e.expires_at AS valid_until,
          CASE
            WHEN e.access_status <> 'enabled' THEN 'disabled'
            WHEN e.expires_at IS NOT NULL AND e.expires_at <= now() THEN 'expired'
            ELSE 'enabled'
          END AS access_status,
          COALESCE(lp.payment_meta ->> 'paymentProofUrl', NULL) AS payment_proof,
          e.source AS access_source,
          COALESCE(lp.created_at, e.enrolled_at) AS created_at,
          COALESCE(e.updated_at, lp.updated_at, lp.created_at, e.enrolled_at) AS updated_at,
          COALESCE(e.admin_note, lp.payment_meta ->> 'adminNote', NULL) AS admin_note,
          lp.provider_order_id AS gateway_order_id,
          lp.provider_payment_id AS gateway_payment_id,
          lp.payment_meta AS payment_meta
        FROM enrollments e
        JOIN users u ON u.id = e.user_id
        JOIN courses c ON c.id = e.course_id
        LEFT JOIN latest_payments lp ON lp.user_id = e.user_id AND lp.course_id = e.course_id
        WHERE u.role <> 'admin'
      ),
      orphan_payment_rows AS (
        SELECT
          'payment_' || p.id AS purchase_id,
          p.id AS payment_id,
          u.id AS student_id,
          u.full_name AS student_name,
          u.email AS student_email,
          u.mobile_number AS student_mobile,
          c.id AS course_id,
          c.title AS course_name,
          p.provider_payment_id AS transaction_id,
          p.provider AS payment_gateway_name,
          p.amount_inr AS payment_amount,
          c.price_inr AS course_fee,
          CASE
            WHEN p.status = 'paid' THEN 'success'
            WHEN p.status = 'failed' THEN 'failed'
            WHEN p.status = 'refunded' THEN 'refunded'
            WHEN p.status = 'pending' THEN 'pending'
            ELSE COALESCE(p.status, 'pending')
          END AS payment_status,
          p.created_at AS purchase_date,
          NULL::timestamptz AS course_start_date,
          NULL::timestamptz AS valid_until,
          'disabled' AS access_status,
          COALESCE(p.payment_meta ->> 'paymentProofUrl', NULL) AS payment_proof,
          p.provider AS access_source,
          p.created_at AS created_at,
          COALESCE(p.updated_at, p.created_at) AS updated_at,
          COALESCE(p.payment_meta ->> 'adminNote', NULL) AS admin_note,
          p.provider_order_id AS gateway_order_id,
          p.provider_payment_id AS gateway_payment_id,
          p.payment_meta AS payment_meta
        FROM payments p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN courses c ON c.id = p.course_id
        LEFT JOIN enrollments e ON e.user_id = p.user_id AND e.course_id = p.course_id
        WHERE u.role <> 'admin' AND e.id IS NULL
      ),
      base AS (
        SELECT * FROM enrollment_rows
        UNION ALL
        SELECT * FROM orphan_payment_rows
      )
    `;

    const totalResult = await queryPostgres(`${baseSql} SELECT COUNT(*)::int AS total FROM base ${whereSql}`, params);
    const total = Number(totalResult.rows[0]?.total || 0);
    const rowsResult = await queryPostgres(
      `${baseSql}
       SELECT * FROM base
       ${whereSql}
       ORDER BY created_at DESC NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );

    return {
      items: rowsResult.rows.map((row) => ({
        ...(function enrichMeta() {
          const meta = asObject(row.payment_meta);
          return {
        purchaseId: row.purchase_id,
        paymentId: row.payment_id || null,
        studentId: row.student_id,
        studentName: row.student_name,
        studentEmail: row.student_email,
        studentMobile: row.student_mobile || null,
        courseId: row.course_id,
        courseName: row.course_name,
        transactionId: row.transaction_id || null,
        paymentGatewayName: row.payment_gateway_name || null,
        paymentAmount: toNumber(row.payment_amount, null),
        courseFee: toNumber(row.course_fee, null),
        paymentStatus: row.payment_status,
        purchaseDate: toIso(row.purchase_date),
        courseStartDate: toIso(row.course_start_date),
        validUntil: toIso(row.valid_until),
        accessStatus: row.access_status,
        paymentProof: row.payment_proof || null,
        accessSource: row.access_source || null,
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        adminNote: row.admin_note || null,
        gatewayOrderId: row.gateway_order_id || null,
        gatewayPaymentId: row.gateway_payment_id || null,
        gatewayStatus: meta.gatewayStatus || meta.razorpayGatewayStatus || null,
        verificationStatus: meta.verificationDecision || meta.verificationStatus || null,
        verificationReason: meta.verificationReason || null,
          };
        })(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  const courses = state.courses;
  const users = state.users.filter((user) => user.role !== 'admin');
  const latestPaymentMap = new Map();
  state.payments.forEach((payment) => {
    const key = `${payment.userId}:${payment.courseId || ''}`;
    const current = latestPaymentMap.get(key);
    if (!current) {
      latestPaymentMap.set(key, payment);
      return;
    }
    const currentRank = getPaymentPriorityRank(current);
    const nextRank = getPaymentPriorityRank(payment);
    if (
      nextRank < currentRank
      || (nextRank === currentRank && sortNewestFirst(payment, current, 'createdAt') < 0)
    ) {
      latestPaymentMap.set(key, payment);
    }
  });
  const purchaseItems = [
    ...state.enrollments.map((enrollment) => {
      const user = users.find((entry) => entry._id === enrollment.userId);
      const course = courses.find((entry) => entry._id === enrollment.courseId);
      const payment = latestPaymentMap.get(`${enrollment.userId}:${enrollment.courseId}`);
      return buildPurchaseItem({ enrollment, payment, user, course });
    }),
    ...state.payments
      .filter((payment) => !state.enrollments.some((enrollment) => enrollment.userId === payment.userId && enrollment.courseId === payment.courseId))
      .map((payment) => buildPurchaseItem({
        enrollment: null,
        payment,
        user: users.find((entry) => entry._id === payment.userId),
        course: courses.find((entry) => entry._id === payment.courseId),
      })),
  ];

  const searchLower = search.toLowerCase();
  const filtered = purchaseItems
    .filter((item) => !studentId || item.studentId === studentId)
    .filter((item) => !courseId || item.courseId === courseId)
    .filter((item) => !paymentStatus || item.paymentStatus === paymentStatus)
    .filter((item) => !accessStatus || item.accessStatus === accessStatus)
    .filter((item) => {
      if (!searchLower) return true;
      return [
        item.purchaseId,
        item.studentName,
        item.studentEmail,
        item.studentMobile,
        item.courseName,
        item.transactionId,
      ].some((value) => String(value || '').toLowerCase().includes(searchLower));
    })
    .sort((left, right) => sortNewestFirst(left, right, 'createdAt'));

  return {
    items: filtered.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    },
  };
};

const listTransactions = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const offset = (page - 1) * pageSize;
  const search = normalizeSearch(query.search);
  const paymentStatus = normalizeStatus(query.paymentStatus, ['paid', 'failed', 'pending', 'refunded']);
  const courseId = optionalString(query.courseId, '');
  const manualReviewOnly = String(query.manualReviewOnly || '').toLowerCase() === 'true';
  const hasPaymentRangeFilter = Boolean(query.rangePreset || query.startDate || query.endDate);
  const paymentRange = hasPaymentRangeFilter ? buildPaymentRange(query) : null;

  if (isPostgresReady()) {
    const params = [];
    const filters = [`u.role <> 'admin'`];
    if (search) {
      params.push(likePattern(search));
      filters.push(`(
        LOWER(u.email) LIKE $${params.length}
        OR LOWER(COALESCE(u.mobile_number, '')) LIKE REPLACE($${params.length}, '%', '')
        OR LOWER(COALESCE(c.title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(p.id, '')) LIKE $${params.length}
        OR LOWER(COALESCE(p.provider_payment_id, '')) LIKE $${params.length}
        OR LOWER(COALESCE(p.provider_order_id, '')) LIKE $${params.length}
      )`);
    }
    if (paymentStatus) {
      params.push(paymentStatus);
      filters.push(`p.status = $${params.length}`);
    }
    if (courseId) {
      params.push(courseId);
      filters.push(`p.course_id = $${params.length}`);
    }
    if (manualReviewOnly) {
      filters.push(`(
        COALESCE(p.payment_meta ->> 'manualReviewRequired', 'false') = 'true'
        OR UPPER(COALESCE(p.payment_meta ->> 'verificationDecision', p.payment_meta ->> 'verificationStatus', '')) IN (
          'AMOUNT_MISMATCH',
          'ORDER_MISMATCH',
          'USER_MISMATCH',
          'COURSE_MISMATCH',
          'LOCAL_TRANSACTION_NOT_FOUND',
          'MANUAL_REVIEW_REQUIRED',
          'REFUNDED_OR_CHARGEBACK'
        )
      )`);
    }
    if (paymentRange) {
      params.push(paymentRange.startIso, paymentRange.endIso);
      filters.push(`COALESCE((NULLIF(p.payment_meta ->> 'gatewayCapturedAt', ''))::timestamptz, p.paid_at, p.created_at) >= $${params.length - 1}`);
      filters.push(`COALESCE((NULLIF(p.payment_meta ->> 'gatewayCapturedAt', ''))::timestamptz, p.paid_at, p.created_at) < $${params.length}`);
    }
    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const totalResult = await queryPostgres(
      `
        SELECT COUNT(*)::int AS total
        FROM payments p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN courses c ON c.id = p.course_id
        ${whereSql}
      `,
      params,
    );
    const total = Number(totalResult.rows[0]?.total || 0);
    const rows = await queryPostgres(
      `
        SELECT
          p.*,
          u.full_name,
          u.email,
          u.mobile_number,
          c.title AS course_name,
          e.access_status,
          e.expires_at
        FROM payments p
        JOIN users u ON u.id = p.user_id
        LEFT JOIN courses c ON c.id = p.course_id
        LEFT JOIN enrollments e ON e.user_id = p.user_id AND e.course_id = p.course_id
        ${whereSql}
        ORDER BY COALESCE(p.paid_at, p.updated_at, p.created_at) DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset],
    );
    return {
      items: rows.rows.map((row) => ({
        ...(function buildRecord() {
          const meta = asObject(row.payment_meta);
          return {
        paymentId: row.id,
        transactionId: row.id,
        studentId: row.user_id,
        studentName: row.full_name,
        studentEmail: row.email,
        studentMobile: row.mobile_number || null,
        courseId: row.course_id || null,
        courseName: row.course_name || null,
        amount: toNumber(row.amount_inr),
        currency: row.currency || 'INR',
        paymentMethod: meta.paymentMethod || row.provider || 'internal',
        paymentGatewayResponse: meta,
        paymentStatus: row.status || 'pending',
        paymentDateTime: toIso(row.paid_at || row.created_at),
        gatewayOrderId: row.provider_order_id || null,
        gatewayPaymentId: row.provider_payment_id || null,
        gatewayStatus: meta.gatewayStatus || null,
        verificationDecision: meta.verificationStatus || meta.verificationDecision || null,
        verificationReason: meta.verificationReason || null,
        expectedAmount: toNumber(meta.expectedAmount, null),
        receivedAmount: toNumber(meta.receivedAmount, null),
        bankRrn: meta.bankRrn || null,
        capturedAt: meta.gatewayCapturedAt || null,
        refundStatus: meta.refundStatus || (row.status === 'refunded' ? 'refunded' : null),
        disputeStatus: meta.disputeStatus || null,
        accessSource: row.access_status ? 'payment' : null,
        manualReviewRequired: Boolean(meta.manualReviewRequired),
        lastSyncedAt: meta.lastSyncedAt || meta.syncCheckedAt || null,
        signatureVerified: Boolean(meta.signatureVerified || row.provider_signature),
        failureReason: row.last_error || null,
        accessStatus: buildPurchaseAccessStatus(row.access_status ? { accessStatus: row.access_status, expiresAt: toIso(row.expires_at) } : null, mapPaymentStatusLabel(row.status)),
        validUntil: toIso(row.expires_at),
        courseAccessLabel: meta.manualReviewRequired
          ? 'Payment Under Verification'
          : getStudentCourseAccessLabel({
            paymentStatus: mapPaymentStatusLabel(row.status),
            enrollmentExists: Boolean(row.access_status),
            accessEnabled: Boolean(row.access_status ? String(row.access_status).toLowerCase() === 'enabled' : false),
            validityActive: Boolean(row.access_status ? isEnrollmentActive({ accessStatus: row.access_status, expiresAt: toIso(row.expires_at) }) : false),
            frontendPurchaseFlagExpected: Boolean(row.access_status && String(row.access_status).toLowerCase() === 'enabled' && (!row.expires_at || Date.parse(row.expires_at) > Date.now()) && mapPaymentStatusLabel(row.status) === 'success'),
          }),
          };
        })(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  const searchLower = search.toLowerCase();
  const items = state.payments
    .filter((payment) => !paymentStatus || payment.status === paymentStatus)
    .filter((payment) => !courseId || payment.courseId === courseId)
    .filter((payment) => !paymentRange || isWithinPaymentRange(payment, paymentRange))
    .filter((payment) => !manualReviewOnly || isManualReviewDecision(payment.meta?.verificationDecision || payment.meta?.verificationStatus, payment.meta || {}))
    .map((payment) => {
      const user = state.users.find((entry) => entry._id === payment.userId);
      const course = state.courses.find((entry) => entry._id === payment.courseId);
      const enrollment = state.enrollments.find((entry) => entry.userId === payment.userId && entry.courseId === payment.courseId);
      const meta = asObject(payment.meta);
      return {
        paymentId: payment._id,
        transactionId: payment._id,
        studentId: payment.userId,
        studentName: user?.name || 'Unknown Student',
        studentEmail: user?.email || null,
        studentMobile: user?.mobileNumber || null,
        courseId: payment.courseId || null,
        courseName: course?.title || null,
        amount: payment.amount,
        currency: payment.currency || 'INR',
        paymentMethod: meta.paymentMethod || payment.provider || 'internal',
        paymentGatewayResponse: meta,
        paymentStatus: payment.status || 'pending',
        paymentDateTime: payment.paidAt || payment.createdAt,
        gatewayOrderId: payment.providerOrderId || null,
        gatewayPaymentId: payment.providerPaymentId || null,
        gatewayStatus: meta.gatewayStatus || null,
        verificationDecision: meta.verificationStatus || meta.verificationDecision || null,
        verificationReason: meta.verificationReason || null,
        expectedAmount: toNumber(meta.expectedAmount, null),
        receivedAmount: toNumber(meta.receivedAmount, null),
        bankRrn: meta.bankRrn || null,
        capturedAt: meta.gatewayCapturedAt || null,
        refundStatus: meta.refundStatus || (payment.status === 'refunded' ? 'refunded' : null),
        disputeStatus: meta.disputeStatus || null,
        accessSource: enrollment?.source || payment.provider || null,
        manualReviewRequired: Boolean(meta.manualReviewRequired),
        lastSyncedAt: meta.lastSyncedAt || meta.syncCheckedAt || null,
        signatureVerified: Boolean(meta.signatureVerified || payment.providerSignature),
        failureReason: payment.lastError || null,
        accessStatus: buildPurchaseAccessStatus(enrollment, mapPaymentStatusLabel(payment.status)),
        validUntil: enrollment?.expiresAt || null,
        courseAccessLabel: meta.manualReviewRequired
          ? 'Payment Under Verification'
          : getStudentCourseAccessLabel({
            paymentStatus: mapPaymentStatusLabel(payment.status),
            enrollmentExists: Boolean(enrollment),
            accessEnabled: Boolean(enrollment && String(enrollment.accessStatus || 'enabled').toLowerCase() === 'enabled'),
            validityActive: isEnrollmentActive(enrollment),
            frontendPurchaseFlagExpected: Boolean(['paid', 'success'].includes(String(payment.status || '').toLowerCase()) && enrollment && isEnrollmentActive(enrollment) && String(enrollment.accessStatus || 'enabled').toLowerCase() === 'enabled'),
          }),
      };
    })
    .filter((item) => {
      if (!searchLower) return true;
      return [item.studentEmail, item.studentMobile, item.transactionId, item.courseName].some((value) => String(value || '').toLowerCase().includes(searchLower));
    })
    .sort((left, right) => sortNewestFirst(left, right, 'paymentDateTime'));

  return {
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
    },
  };
};

const listLoginSessions = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const offset = (page - 1) * pageSize;
  const search = normalizeSearch(query.search);
  const status = normalizeStatus(query.status, ['active', 'ended', 'online', 'offline']);

  if (isPostgresReady()) {
    const params = [];
    const filters = [`u.role <> 'admin'`];
    if (search) {
      params.push(likePattern(search));
      filters.push(`(
        LOWER(u.full_name) LIKE $${params.length}
        OR LOWER(u.email) LIKE $${params.length}
        OR LOWER(COALESCE(u.mobile_number, '')) LIKE REPLACE($${params.length}, '%', '')
        OR LOWER(COALESCE(us.jwt_session_id, '')) LIKE $${params.length}
      )`);
    }
    if (status === 'active' || status === 'ended') {
      params.push(status === 'active' ? 'active' : 'ended');
      filters.push(`us.status = $${params.length}`);
    }
    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const totalResult = await queryPostgres(
      `
        SELECT COUNT(*)::int AS total
        FROM user_sessions us
        JOIN users u ON u.id = us.user_id
        ${whereSql}
      `,
      params,
    );
    const total = Number(totalResult.rows[0]?.total || 0);
    const rows = await queryPostgres(
      `
        SELECT
          us.*,
          u.full_name,
          u.email,
          u.mobile_number,
          activity.last_activity_at,
          activity.last_logout_at
        FROM user_sessions us
        JOIN users u ON u.id = us.user_id
        LEFT JOIN (
          SELECT
            user_id,
            MAX(created_at) AS last_activity_at,
            MAX(created_at) FILTER (WHERE event_type = 'logout') AS last_logout_at
          FROM device_activity
          GROUP BY user_id
        ) activity ON activity.user_id = us.user_id
        ${whereSql}
        ORDER BY COALESCE(us.last_seen_at, us.created_at) DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset],
    );
    const items = rows.rows
      .map((row) => {
        const device = asObject(row.device);
        const lastActiveAt = toIso(row.last_seen_at) || toIso(row.last_activity_at) || toIso(row.created_at);
        const online = row.status === 'active' && isRecentIso(lastActiveAt);
        return {
          sessionId: row.jwt_session_id,
          studentId: row.user_id,
          studentName: row.full_name,
          email: row.email,
          mobileNumber: row.mobile_number || null,
          loginTime: toIso(row.created_at),
          logoutTime: toIso(row.ended_at) || toIso(row.last_logout_at),
          lastActiveTime: lastActiveAt,
          deviceId: extractDeviceField(device, ['id', 'deviceId']) || row.jwt_session_id,
          browser: extractDeviceField(device, ['browser', 'browserName']) || null,
          os: extractDeviceField(device, ['os', 'platform']) || null,
          ipAddress: extractDeviceField(device, ['ipAddress', 'ip']) || null,
          userAgent: extractDeviceField(device, ['userAgent']) || stringifyDevice(device),
          sessionStatus: online ? 'online' : 'offline',
          rawStatus: row.status || 'ended',
          reason: row.reason || null,
        };
      })
      .filter((item) => !status || item.sessionStatus === status || item.rawStatus === status);
    const loggedInNow = items.filter((item) => item.sessionStatus === 'online').length;
    const recentLogouts = items.filter((item) => item.logoutTime).length;
    const multipleDeviceUsers = new Set(
      items
        .filter((item) => item.rawStatus === 'active')
        .map((item) => item.studentId),
    ).size;
    return {
      summary: {
        loggedInNow,
        recentLogins: items.length,
        recentLogouts,
        failedLoginAttempts: 0,
        multipleDeviceLoginCount: multipleDeviceUsers,
      },
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  const items = state.loginSessions
    .map((session) => {
      const user = state.users.find((entry) => entry._id === session.userId);
      const lastActiveTime = session.lastSeenAt || session.createdAt || null;
      return {
        sessionId: session.sessionId,
        studentId: session.userId,
        studentName: user?.name || 'Unknown Student',
        email: user?.email || null,
        mobileNumber: user?.mobileNumber || null,
        loginTime: session.createdAt || null,
        logoutTime: session.endedAt || null,
        lastActiveTime,
        deviceId: stringifyDevice(session.device) || session.sessionId,
        browser: extractDeviceField(session.device, ['browser', 'browserName']) || null,
        os: extractDeviceField(session.device, ['os', 'platform']) || null,
        ipAddress: extractDeviceField(session.device, ['ipAddress', 'ip']) || null,
        userAgent: extractDeviceField(session.device, ['userAgent']) || stringifyDevice(session.device),
        sessionStatus: session.status === 'active' && isRecentIso(lastActiveTime) ? 'online' : 'offline',
        rawStatus: session.status,
        reason: session.reason || null,
      };
    })
    .filter((item) => {
      if (!search) return true;
      const haystack = [item.studentName, item.email, item.mobileNumber, item.sessionId].join(' ').toLowerCase();
      return haystack.includes(search.toLowerCase());
    })
    .filter((item) => !status || item.sessionStatus === status || item.rawStatus === status)
    .sort((left, right) => sortNewestFirst(left, right, 'lastActiveTime'));

  return {
    summary: {
      loggedInNow: items.filter((item) => item.sessionStatus === 'online').length,
      recentLogins: items.length,
      recentLogouts: items.filter((item) => item.logoutTime).length,
      failedLoginAttempts: 0,
      multipleDeviceLoginCount: new Set(items.filter((item) => item.rawStatus === 'active').map((item) => item.studentId)).size,
    },
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
    },
  };
};

const findLessonContextInCourse = (course, lessonId) => {
  for (const module of course?.modules || []) {
    for (const lesson of module.lessons || []) {
      if (String(lesson.id || '') === String(lessonId || '')) {
        return {
          moduleId: module.id,
          moduleTitle: module.title,
          chapterId: null,
          chapterTitle: null,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
        };
      }
    }
    for (const chapter of module.chapters || []) {
      for (const lesson of chapter.lessons || []) {
        if (String(lesson.id || '') === String(lessonId || '')) {
          return {
            moduleId: module.id,
            moduleTitle: module.title,
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            lessonId: lesson.id,
            lessonTitle: lesson.title,
          };
        }
      }
    }
  }
  return null;
};

const listCourseLessonTargets = (course, scope = 'course', chapterId = '') => {
  const targets = [];
  for (const module of course?.modules || []) {
    for (const lesson of module.lessons || []) {
      if (scope === 'chapter') {
        continue;
      }
      targets.push({
        moduleId: module.id,
        moduleTitle: module.title,
        chapterId: null,
        chapterTitle: null,
        lessonId: lesson.id,
        lessonTitle: lesson.title,
      });
    }
    for (const chapter of module.chapters || []) {
      if (scope === 'chapter' && String(chapter.id || '') !== String(chapterId || '')) {
        continue;
      }
      for (const lesson of chapter.lessons || []) {
        targets.push({
          moduleId: module.id,
          moduleTitle: module.title,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
        });
      }
    }
  }
  return targets;
};

const paginateItems = (items, page, pageSize) => ({
  items: items.slice((page - 1) * pageSize, page * pageSize),
  pagination: {
    page,
    pageSize,
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  },
});

const listCourseAccess = async (query) => {
  const toCourseAccessItem = (purchase) => {
    const paymentStatus = purchase.paymentStatus || 'pending';
    const paymentMeta = {};
    const access = toCourseAccessStatusPayload({
      enrollment: {
        accessStatus: purchase.accessStatus,
        expiresAt: purchase.validUntil,
        adminNote: purchase.adminNote,
      },
      paymentStatus,
      paymentMeta,
    });
    return {
      studentId: purchase.studentId,
      studentName: purchase.studentName,
      email: purchase.studentEmail || null,
      mobileNumber: purchase.studentMobile || null,
      courseId: purchase.courseId,
      courseName: purchase.courseName,
      accessSource: purchase.accessSource || 'payment',
      accessStatus: purchase.accessStatus,
      validUntil: purchase.validUntil || null,
      paymentStatus,
      verificationStatus: purchase.verificationStatus || null,
      verificationReason: purchase.verificationReason || null,
      gatewayStatus: purchase.gatewayStatus || null,
      canAccessCourse: access.canAccessCourse,
      accessBlockReason: access.accessBlockReason,
      adminNote: purchase.adminNote || null,
      paymentId: purchase.paymentId || null,
      gatewayOrderId: purchase.gatewayOrderId || null,
      gatewayPaymentId: purchase.gatewayPaymentId || null,
    };
  };
  const purchases = await listPurchases(query);
  const items = purchases.items.map(toCourseAccessItem);
  const summaryPurchases = [];
  let summaryPage = 1;
  let summaryTotalPages = 1;

  do {
    const pageResult = await listPurchases({ ...query, page: summaryPage, pageSize: MAX_PAGE_SIZE });
    summaryPurchases.push(...pageResult.items);
    summaryTotalPages = Number(pageResult.pagination?.totalPages || 1);
    summaryPage += 1;
  } while (summaryPage <= summaryTotalPages);

  const summaryItems = summaryPurchases.map(toCourseAccessItem);
  const summary = {
    activeAccessCount: summaryItems.filter((item) => item.accessStatus === 'enabled' && item.canAccessCourse).length,
    expiredAccessCount: summaryItems.filter((item) => item.accessStatus === 'expired').length,
    disabledAccessCount: summaryItems.filter((item) => ['disabled', 'removed'].includes(String(item.accessStatus || '').toLowerCase())).length,
    manuallyGrantedAccessCount: summaryItems.filter((item) => item.accessSource === 'manual_admin_grant').length,
    paymentLinkedAccessCount: summaryItems.filter((item) => item.accessSource !== 'manual_admin_grant').length,
  };
  return {
    summary,
    items,
    pagination: purchases.pagination,
  };
};

const listCourseAccessRules = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const search = normalizeSearch(query.search).toLowerCase();
  const [rules, courses, students] = await Promise.all([
    coursesRepository.listContentAccessRules({
      courseId: optionalString(query.courseId, '', { maxLength: 160 }) || '',
      studentId: optionalString(query.studentId, '', { maxLength: 160 }) || '',
      studentScope: optionalString(query.studentScope, '', { maxLength: 20 }) || '',
      contentScope: optionalString(query.contentScope, '', { maxLength: 20 }) || '',
    }),
    coursesRepository.list(),
    usersRepository.listSafe(),
  ]);
  const courseMap = new Map(courses.map((course) => [String(course._id), course]));
  const studentMap = new Map(students.map((student) => [String(student._id), student]));
  const items = rules.map((rule) => {
    const course = courseMap.get(String(rule.courseId || '')) || null;
    const lessonContext = rule.lessonId && course ? findLessonContextInCourse(course, rule.lessonId) : null;
    const chapter = !lessonContext && rule.chapterId && course
      ? (course.modules || []).flatMap((module) => module.chapters || []).find((entry) => String(entry.id || '') === String(rule.chapterId || '')) || null
      : null;
    const student = rule.studentId ? studentMap.get(String(rule.studentId || '')) || null : null;
    return {
      ruleId: rule._id,
      courseId: rule.courseId,
      courseTitle: course?.title || rule.courseId,
      studentScope: rule.studentScope,
      studentId: rule.studentId,
      studentName: student?.name || null,
      studentEmail: student?.email || null,
      contentScope: rule.contentScope,
      moduleId: lessonContext?.moduleId || rule.moduleId || null,
      moduleTitle: lessonContext?.moduleTitle || null,
      chapterId: lessonContext?.chapterId || rule.chapterId || null,
      chapterTitle: lessonContext?.chapterTitle || chapter?.title || null,
      lessonId: lessonContext?.lessonId || rule.lessonId || null,
      lessonTitle: lessonContext?.lessonTitle || null,
      access: rule.access,
      adminNote: rule.adminNote || null,
      updatedAt: rule.updatedAt,
      createdAt: rule.createdAt,
    };
  }).filter((item) => {
    if (!search) {
      return true;
    }
    const haystack = [
      item.courseTitle,
      item.studentName,
      item.studentEmail,
      item.moduleTitle,
      item.chapterTitle,
      item.lessonTitle,
      item.adminNote,
      item.access,
      item.contentScope,
    ].join(' ').toLowerCase();
    return haystack.includes(search);
  });
  return paginateItems(items, page, pageSize);
};

const upsertCourseAccessRule = async ({
  courseId,
  studentScope = 'all_students',
  studentId = '',
  contentScope = 'course',
  moduleId = '',
  chapterId = '',
  lessonId = '',
  access = 'block',
  adminNote = '',
  adminUserId,
  requestContext = {},
}) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }
  const normalizedStudentScope = String(studentScope || '').trim().toLowerCase() === 'student' ? 'student' : 'all_students';
  const normalizedContentScope = ['course', 'chapter', 'lesson'].includes(String(contentScope || '').trim().toLowerCase())
    ? String(contentScope).trim().toLowerCase()
    : 'course';
  const normalizedAccess = String(access || '').trim().toLowerCase() === 'allow' ? 'allow' : 'block';
  if (normalizedStudentScope === 'student') {
    const student = await usersRepository.findSafeById(studentId);
    if (!student) {
      throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
    }
  }
  if (normalizedContentScope === 'chapter' && !String(chapterId || '').trim()) {
    throw new ApiError(400, 'chapterId is required for chapter rules', { code: 'CHAPTER_ID_REQUIRED' });
  }
  if (normalizedContentScope === 'lesson' && !String(lessonId || '').trim()) {
    throw new ApiError(400, 'lessonId is required for lesson rules', { code: 'LESSON_ID_REQUIRED' });
  }
  const saved = await coursesRepository.upsertContentAccessRule({
    courseId,
    studentScope: normalizedStudentScope,
    studentId: normalizedStudentScope === 'student' ? String(studentId || '') : null,
    contentScope: normalizedContentScope,
    moduleId: moduleId || null,
    chapterId: chapterId || null,
    lessonId: lessonId || null,
    access: normalizedAccess,
    adminNote: adminNote || null,
    createdBy: adminUserId,
    updatedBy: adminUserId,
  });
  await createAuditLog({
    adminUserId,
    actionType: 'course_content_access_rule_upserted',
    targetUserId: saved.studentId,
    courseId: saved.courseId,
    oldValue: {},
    newValue: saved,
    reason: adminNote || null,
    ipAddress: requestContext.ipAddress || null,
    userAgent: requestContext.userAgent || null,
  });
  return {
    success: true,
    rule: saved,
  };
};

const deleteCourseAccessRule = async ({ ruleId, adminUserId, requestContext = {} }) => {
  const removed = await coursesRepository.deleteContentAccessRule(ruleId);
  if (!removed) {
    throw new ApiError(404, 'Access rule not found', { code: 'COURSE_ACCESS_RULE_NOT_FOUND' });
  }
  await createAuditLog({
    adminUserId,
    actionType: 'course_content_access_rule_deleted',
    targetUserId: removed.studentId,
    courseId: removed.courseId,
    oldValue: removed,
    newValue: {},
    reason: removed.adminNote || null,
    ipAddress: requestContext.ipAddress || null,
    userAgent: requestContext.userAgent || null,
  });
  return {
    success: true,
    rule: removed,
  };
};

const listStudentLessonWatchOverrides = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const search = normalizeSearch(query.search).toLowerCase();
  const [overrides, courses, students] = await Promise.all([
    coursesRepository.listStudentLessonWatchOverrides({
      courseId: optionalString(query.courseId, '', { maxLength: 160 }) || '',
      studentId: optionalString(query.studentId, '', { maxLength: 160 }) || '',
      lessonId: optionalString(query.lessonId, '', { maxLength: 160 }) || '',
    }),
    coursesRepository.list(),
    usersRepository.listSafe(),
  ]);
  const courseMap = new Map(courses.map((course) => [String(course._id), course]));
  const studentMap = new Map(students.map((student) => [String(student._id), student]));
  const items = overrides.map((override) => {
    const course = courseMap.get(String(override.courseId || '')) || null;
    const lessonContext = course ? findLessonContextInCourse(course, override.lessonId) : null;
    const student = studentMap.get(String(override.studentId || '')) || null;
    return {
      overrideId: override._id,
      courseId: override.courseId,
      courseTitle: course?.title || override.courseId,
      studentId: override.studentId,
      studentName: student?.name || null,
      studentEmail: student?.email || null,
      moduleId: override.moduleId,
      moduleTitle: lessonContext?.moduleTitle || null,
      chapterId: override.chapterId,
      chapterTitle: lessonContext?.chapterTitle || null,
      lessonId: override.lessonId,
      lessonTitle: lessonContext?.lessonTitle || override.lessonId,
      allowedFullWatches: override.allowedFullWatches,
      watchCompletionPercent: override.watchCompletionPercent,
      adminNote: override.adminNote || null,
      updatedAt: override.updatedAt,
      createdAt: override.createdAt,
    };
  }).filter((item) => {
    if (!search) {
      return true;
    }
    const haystack = [
      item.courseTitle,
      item.studentName,
      item.studentEmail,
      item.moduleTitle,
      item.chapterTitle,
      item.lessonTitle,
      item.adminNote,
    ].join(' ').toLowerCase();
    return haystack.includes(search);
  });
  return paginateItems(items, page, pageSize);
};

const upsertStudentLessonWatchOverride = async ({
  courseId,
  studentId,
  moduleId = '',
  chapterId = '',
  lessonId = '',
  allowedFullWatches,
  watchCompletionPercent,
  bulkScope = '',
  adminNote = '',
  adminUserId,
  requestContext = {},
}) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }
  const student = await usersRepository.findSafeById(studentId);
  if (!student) {
    throw new ApiError(404, 'Student not found', { code: 'STUDENT_NOT_FOUND' });
  }
  const normalizedAllowedFullWatches = Math.max(1, optionalNumber(allowedFullWatches, 1, { min: 1, max: 50, integer: true }));
  const normalizedWatchCompletionPercent = watchCompletionPercent === undefined || watchCompletionPercent === null || watchCompletionPercent === ''
    ? undefined
    : optionalNumber(watchCompletionPercent, 90, { min: 50, max: 100, integer: true });
  const normalizedBulkScope = String(bulkScope || '').trim().toLowerCase();

  let targets = [];
  if (normalizedBulkScope === 'course') {
    targets = listCourseLessonTargets(course, 'course');
  } else if (normalizedBulkScope === 'chapter') {
    if (!String(chapterId || '').trim()) {
      throw new ApiError(400, 'chapterId is required for chapter bulk overrides', { code: 'CHAPTER_ID_REQUIRED' });
    }
    targets = listCourseLessonTargets(course, 'chapter', chapterId);
  } else {
    const lessonContext = findLessonContextInCourse(course, lessonId);
    if (!lessonContext) {
      throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
    }
    targets = [lessonContext];
  }

  if (!targets.length) {
    throw new ApiError(404, 'No lessons found for the selected override scope', { code: 'WATCH_OVERRIDE_TARGETS_NOT_FOUND' });
  }

  const savedOverrides = [];
  for (const target of targets) {
    const saved = await coursesRepository.upsertStudentLessonWatchOverride({
      courseId,
      studentId,
      moduleId: target.moduleId || moduleId,
      chapterId: target.chapterId || null,
      lessonId: target.lessonId,
      allowedFullWatches: normalizedAllowedFullWatches,
      watchCompletionPercent: normalizedWatchCompletionPercent,
      adminNote: adminNote || null,
      createdBy: adminUserId,
      updatedBy: adminUserId,
    });
    savedOverrides.push(saved);
  }

  await createAuditLog({
    adminUserId,
    actionType: 'student_lesson_watch_override_upserted',
    targetUserId: studentId,
    courseId,
    oldValue: {},
    newValue: {
      bulkScope: normalizedBulkScope || 'lesson',
      savedCount: savedOverrides.length,
      lessonIds: savedOverrides.map((entry) => entry.lessonId),
      allowedFullWatches: normalizedAllowedFullWatches,
      watchCompletionPercent: normalizedWatchCompletionPercent ?? null,
    },
    reason: adminNote || null,
    ipAddress: requestContext.ipAddress || null,
    userAgent: requestContext.userAgent || null,
  });

  return {
    success: true,
    overrides: savedOverrides,
    savedCount: savedOverrides.length,
  };
};

const deleteStudentLessonWatchOverride = async ({ overrideId, adminUserId, requestContext = {} }) => {
  const removed = await coursesRepository.deleteStudentLessonWatchOverride(overrideId);
  if (!removed) {
    throw new ApiError(404, 'Watch override not found', { code: 'WATCH_OVERRIDE_NOT_FOUND' });
  }
  await createAuditLog({
    adminUserId,
    actionType: 'student_lesson_watch_override_deleted',
    targetUserId: removed.studentId,
    courseId: removed.courseId,
    oldValue: removed,
    newValue: {},
    reason: removed.adminNote || null,
    ipAddress: requestContext.ipAddress || null,
    userAgent: requestContext.userAgent || null,
  });
  return {
    success: true,
    override: removed,
  };
};

const listManualReviewQueue = async (query) => {
  const result = await listTransactions({ ...query, manualReviewOnly: true });
  const items = result.items.map((item) => ({
    paymentId: item.paymentId,
    studentId: item.studentId,
    studentName: item.studentName,
    email: item.studentEmail || null,
    mobileNumber: item.studentMobile || null,
    courseId: item.courseId || null,
    courseName: item.courseName || null,
    amountExpected: item.expectedAmount ?? item.amount,
    amountReceived: item.receivedAmount ?? item.amount,
    localOrderId: item.paymentId,
    razorpayOrderId: item.gatewayOrderId || null,
    razorpayPaymentId: item.gatewayPaymentId || null,
    verificationDecision: item.verificationDecision || null,
    reason: item.verificationReason || item.failureReason || null,
    adminNote: item.paymentGatewayResponse?.adminNote || null,
    createdTime: item.paymentDateTime,
    refundStatus: item.refundStatus || null,
    disputeStatus: item.disputeStatus || null,
    status: item.paymentStatus,
  }));
  return {
    summary: {
      total: items.length,
      amountMismatch: items.filter((item) => item.verificationDecision === 'AMOUNT_MISMATCH').length,
      orderMismatch: items.filter((item) => item.verificationDecision === 'ORDER_MISMATCH').length,
      userMismatch: items.filter((item) => item.verificationDecision === 'USER_MISMATCH').length,
      courseMismatch: items.filter((item) => item.verificationDecision === 'COURSE_MISMATCH').length,
      localTransactionNotFound: items.filter((item) => item.verificationDecision === 'LOCAL_TRANSACTION_NOT_FOUND').length,
      refundedOrDisputed: items.filter((item) => item.verificationDecision === 'REFUNDED_OR_CHARGEBACK' || item.refundStatus || item.disputeStatus).length,
    },
    items,
    pagination: result.pagination,
  };
};

const listAuditLogs = async (query) => {
  const page = normalizePage(query.page);
  const pageSize = normalizePageSize(query.pageSize);
  const offset = (page - 1) * pageSize;
  const search = normalizeSearch(query.search);
  const actionType = optionalString(query.actionType, '');

  if (isPostgresReady()) {
    const params = [];
    const filters = ['1=1'];
    if (search) {
      params.push(likePattern(search));
      filters.push(`(
        LOWER(COALESCE(admin_user.full_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(target_user.full_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(course.title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(log.action_type, '')) LIKE $${params.length}
      )`);
    }
    if (actionType) {
      params.push(actionType);
      filters.push(`log.action_type = $${params.length}`);
    }
    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const totalResult = await queryPostgres(
      `
        SELECT COUNT(*)::int AS total
        FROM admin_audit_logs log
        LEFT JOIN users admin_user ON admin_user.id = log.admin_user_id
        LEFT JOIN users target_user ON target_user.id = log.target_user_id
        LEFT JOIN courses course ON course.id = log.course_id
        ${whereSql}
      `,
      params,
    );
    const total = Number(totalResult.rows[0]?.total || 0);
    const rows = await queryPostgres(
      `
        SELECT
          log.*,
          admin_user.full_name AS admin_user_name,
          target_user.full_name AS target_user_name,
          course.title AS course_name
        FROM admin_audit_logs log
        LEFT JOIN users admin_user ON admin_user.id = log.admin_user_id
        LEFT JOIN users target_user ON target_user.id = log.target_user_id
        LEFT JOIN courses course ON course.id = log.course_id
        ${whereSql}
        ORDER BY log.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, pageSize, offset],
    );
    return {
      items: rows.rows.map((row) => ({
        _id: row.id,
        adminUserId: row.admin_user_id,
        adminUserName: row.admin_user_name || row.admin_user_id,
        actionType: row.action_type,
        targetUserId: row.target_user_id || null,
        targetUserName: row.target_user_name || null,
        courseId: row.course_id || null,
        courseName: row.course_name || null,
        transactionId: row.transaction_id || null,
        oldValue: asObject(row.old_value),
        newValue: asObject(row.new_value),
        reason: row.reason || null,
        ipAddress: row.ip_address || null,
        userAgent: row.user_agent || null,
        createdAt: toIso(row.created_at) || nowIso(),
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  }

  const items = state.adminAuditLogs
    .filter((entry) => !actionType || entry.actionType === actionType)
    .filter((entry) => {
      if (!search) return true;
      return JSON.stringify(entry).toLowerCase().includes(search.toLowerCase());
    })
    .sort((left, right) => sortNewestFirst(left, right, 'createdAt'))
    .map((entry) => ({
      ...clone(entry),
      adminUserName: state.users.find((user) => user._id === entry.adminUserId)?.name || entry.adminUserId,
      targetUserName: state.users.find((user) => user._id === entry.targetUserId)?.name || null,
      courseName: state.courses.find((course) => course._id === entry.courseId)?.title || null,
    }));
  return {
    items: items.slice(offset, offset + pageSize),
    pagination: {
      page,
      pageSize,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
    },
  };
};

const toPaymentReportRecord = (payment, reason = null) => {
  const meta = asObject(payment?.payment_meta || payment?.meta);
  return {
    localTransactionId: payment?.id || payment?._id || null,
    razorpayOrderId: payment?.provider_order_id || payment?.providerOrderId || meta.razorpayOrderId || null,
    razorpayPaymentId: payment?.provider_payment_id || payment?.providerPaymentId || meta.razorpayPaymentId || null,
    localStatus: payment?.status || 'pending',
    razorpayStatus: meta.gatewayStatus || meta.razorpayGatewayStatus || null,
    verificationStatus: meta.verificationDecision || meta.verificationStatus || null,
    amountExpected: toNumber(meta.expectedAmount, payment?.amount_inr ?? payment?.amount ?? 0),
    amountReceived: toNumber(meta.receivedAmount, payment?.amount_inr ?? payment?.amount ?? 0),
    currency: meta.currency || payment?.currency || 'INR',
    student: payment?.full_name || payment?.studentName || 'Unknown Student',
    course: payment?.course_name || payment?.courseName || null,
    createdAt: toIso(payment?.created_at || payment?.createdAt) || getPaymentEventIso(payment),
    capturedAt: meta.gatewayCapturedAt || null,
    reason,
  };
};

const buildPaymentReconciliationReport = async (query = {}) => {
  const range = buildPaymentRange(query);
  const paymentMode = String(query.paymentMode || getRazorpayMode()).trim().toLowerCase() || getRazorpayMode();
  const [localRows, localPaidOutsideRange, razorpayPayments, enrollmentCounts] = await Promise.all([
    fetchLocalPaymentsForRange(range),
    fetchAllLocalPaidOutsideRange(range),
    fetchAllRazorpayPaymentsForRange(range),
    (async () => {
      if (isPostgresReady()) {
        const result = await queryPostgres(
          `
            SELECT
              COUNT(*) FILTER (WHERE source = 'manual_admin_grant')::int AS manual_grant_count,
              COUNT(*) FILTER (
                WHERE (access_status IS NULL OR access_status = 'enabled')
                  AND (expires_at IS NULL OR expires_at > now())
              )::int AS active_access_count
            FROM enrollments
          `,
        );
        return {
          manualGrantCount: Number(result.rows[0]?.manual_grant_count || 0),
          activeAccessCount: Number(result.rows[0]?.active_access_count || 0),
        };
      }
      return {
        manualGrantCount: state.enrollments.filter((entry) => entry.source === 'manual_admin_grant').length,
        activeAccessCount: state.enrollments.filter((entry) => isEnrollmentActive(entry)).length,
      };
    })(),
  ]);

  const capturedRazorpayPayments = razorpayPayments.filter((payment) =>
    String(payment?.status || '').toLowerCase() === 'captured'
    && String(payment?.currency || '').toUpperCase() === 'INR',
  );
  const capturedRazorpayByPaymentId = new Map(
    capturedRazorpayPayments
      .map((payment) => [String(payment.id || '').trim(), payment])
      .filter(([paymentId]) => paymentId),
  );
  const localPaidRows = localRows.filter((row) => String(row.status || '').toLowerCase() === 'paid');
  const localPendingRows = localRows.filter((row) => String(row.status || '').toLowerCase() === 'pending');
  const localFailedRows = localRows.filter((row) => String(row.status || '').toLowerCase() === 'failed');
  const localRefundedRows = localRows.filter((row) => String(row.status || '').toLowerCase() === 'refunded');
  const manualReviewRows = localRows.filter((row) =>
    isManualReviewDecision(row.payment_meta?.verificationDecision || row.payment_meta?.verificationStatus, row.payment_meta || {}),
  );

  const localSuccessByKey = new Map();
  for (const payment of localPaidRows) {
    const providerPaymentId = String(payment.provider_payment_id || payment.providerPaymentId || '').trim();
    const dedupeKey = providerPaymentId || String(payment.id || payment._id || '');
    if (!localSuccessByKey.has(dedupeKey)) {
      localSuccessByKey.set(dedupeKey, payment);
    }
  }

  const duplicateLocalSuccessfulTransactions = [];
  const localSuccessGroups = new Map();
  for (const payment of localPaidRows) {
    const providerPaymentId = String(payment.provider_payment_id || payment.providerPaymentId || '').trim();
    if (!providerPaymentId) {
      continue;
    }
    const list = localSuccessGroups.get(providerPaymentId) || [];
    list.push(payment);
    localSuccessGroups.set(providerPaymentId, list);
  }
  localSuccessGroups.forEach((group, providerPaymentId) => {
    if (group.length > 1) {
      duplicateLocalSuccessfulTransactions.push({
        razorpayPaymentId: providerPaymentId,
        localRows: group.map((payment) => toPaymentReportRecord(payment, 'Duplicate local successful transaction shares the same Razorpay payment ID.')),
      });
    }
  });

  const capturedButPendingLocally = [];
  const matchedCapturedPayments = [];
  for (const gatewayPayment of capturedRazorpayPayments) {
    const localMatches = localRows.filter((row) => {
      const providerPaymentId = String(row.provider_payment_id || row.providerPaymentId || '').trim();
      const providerOrderId = String(row.provider_order_id || row.providerOrderId || '').trim();
      return providerPaymentId === String(gatewayPayment.id || '').trim()
        || (providerOrderId && providerOrderId === String(gatewayPayment.order_id || '').trim());
    });
    const strictVerifiedMatch = localMatches.find((row) => isStrictVerifiedCapturedPayment(row)) || null;
    const pendingMatch = localMatches.find((row) => String(row.status || '').toLowerCase() === 'pending') || null;
    const nonSuccessMatch = localMatches.find((row) => String(row.status || '').toLowerCase() !== 'paid') || null;

    if (strictVerifiedMatch) {
      matchedCapturedPayments.push({
        localTransactionId: strictVerifiedMatch.id || strictVerifiedMatch._id,
        razorpayPaymentId: gatewayPayment.id || null,
        razorpayOrderId: gatewayPayment.order_id || null,
        amount: Number(gatewayPayment.amount || 0) / 100,
        currency: gatewayPayment.currency || 'INR',
        student: strictVerifiedMatch.full_name || 'Unknown Student',
        course: strictVerifiedMatch.course_name || null,
        capturedAt: toIso(new Date(Number(gatewayPayment.created_at || 0) * 1000)),
      });
      continue;
    }

    if (pendingMatch) {
      capturedButPendingLocally.push({
        ...toPaymentReportRecord(pendingMatch, 'Razorpay captured payment is still pending in the local database.'),
        razorpayPaymentId: gatewayPayment.id || pendingMatch.provider_payment_id || null,
        razorpayOrderId: gatewayPayment.order_id || pendingMatch.provider_order_id || null,
      });
      continue;
    }

    if (!localMatches.length) {
      capturedButPendingLocally.push({
        razorpayPaymentId: gatewayPayment.id || null,
        razorpayOrderId: gatewayPayment.order_id || null,
        localTransactionId: null,
        localStatus: null,
        razorpayStatus: String(gatewayPayment.status || '').toLowerCase() || 'captured',
        verificationStatus: 'LOCAL_TRANSACTION_NOT_FOUND',
        amountExpected: Number(gatewayPayment.amount || 0) / 100,
        amountReceived: Number(gatewayPayment.amount || 0) / 100,
        currency: gatewayPayment.currency || 'INR',
        student: gatewayPayment.notes?.userId || null,
        course: gatewayPayment.notes?.courseId || null,
        createdAt: toIso(new Date(Number(gatewayPayment.created_at || 0) * 1000)),
        capturedAt: toIso(new Date(Number(gatewayPayment.created_at || 0) * 1000)),
        reason: 'Razorpay captured payment has no matching local transaction in the selected range.',
      });
      continue;
    }

    if (nonSuccessMatch) {
      capturedButPendingLocally.push({
        ...toPaymentReportRecord(nonSuccessMatch, 'Razorpay captured payment has a non-success local state and needs repair.'),
        razorpayPaymentId: gatewayPayment.id || nonSuccessMatch.provider_payment_id || null,
        razorpayOrderId: gatewayPayment.order_id || nonSuccessMatch.provider_order_id || null,
      });
    }
  }

  const localSuccessButNotVerifiedInRazorpay = Array.from(localSuccessByKey.values())
    .filter((payment) => {
      const providerPaymentId = String(payment.provider_payment_id || payment.providerPaymentId || '').trim();
      return !providerPaymentId || !capturedRazorpayByPaymentId.has(providerPaymentId) || !isStrictVerifiedCapturedPayment(payment);
    })
    .map((payment) => {
      const providerPaymentId = String(payment.provider_payment_id || payment.providerPaymentId || '').trim();
      return toPaymentReportRecord(payment, !providerPaymentId
        ? 'Local success has no Razorpay payment ID, so Razorpay cannot verify it as captured.'
        : !capturedRazorpayByPaymentId.has(providerPaymentId)
          ? 'Local success payment ID is not captured in Razorpay for the selected range.'
          : 'Local success is missing strict verification fields even though a Razorpay payment exists.');
    });

  const wrongDateTimezoneRecords = localPaidOutsideRange.map((payment) => toPaymentReportRecord(payment, 'Legacy dashboard counted this paid row outside the selected payment date range.'));
  const refundedOrDisputedRecords = localRows
    .filter((payment) => {
      const meta = asObject(payment.payment_meta);
      return String(payment.status || '').toLowerCase() === 'refunded' || meta.refundStatus || meta.disputeStatus;
    })
    .map((payment) => toPaymentReportRecord(payment, 'Refunded or disputed records must stay separate from captured payment counts.'));
  const mismatchBuckets = {
    amountMismatch: manualReviewRows.filter((payment) => String(payment.payment_meta?.verificationDecision || payment.payment_meta?.verificationStatus || '').toUpperCase() === 'AMOUNT_MISMATCH').map((payment) => toPaymentReportRecord(payment, 'Amount mismatch.')),
    orderMismatch: manualReviewRows.filter((payment) => String(payment.payment_meta?.verificationDecision || payment.payment_meta?.verificationStatus || '').toUpperCase() === 'ORDER_MISMATCH').map((payment) => toPaymentReportRecord(payment, 'Order mismatch.')),
    userMismatch: manualReviewRows.filter((payment) => String(payment.payment_meta?.verificationDecision || payment.payment_meta?.verificationStatus || '').toUpperCase() === 'USER_MISMATCH').map((payment) => toPaymentReportRecord(payment, 'User mismatch.')),
    courseMismatch: manualReviewRows.filter((payment) => String(payment.payment_meta?.verificationDecision || payment.payment_meta?.verificationStatus || '').toUpperCase() === 'COURSE_MISMATCH').map((payment) => toPaymentReportRecord(payment, 'Course mismatch.')),
  };
  const localTransactionNotFound = manualReviewRows
    .filter((payment) => String(payment.payment_meta?.verificationDecision || payment.payment_meta?.verificationStatus || '').toUpperCase() === 'LOCAL_TRANSACTION_NOT_FOUND')
    .map((payment) => toPaymentReportRecord(payment, 'Local transaction not found.'));

  const localSuccessCount = localSuccessByKey.size;
  const razorpayCapturedCount = capturedRazorpayPayments.length;
  const localStrictVerifiedCount = Array.from(localSuccessByKey.values()).filter((payment) => isStrictVerifiedCapturedPayment(payment)).length;

  return {
    range,
    paymentMode,
    lastReconciledAt: nowIso(),
    cards: {
      razorpayCapturedPayments: razorpayCapturedCount,
      localSuccessfulTransactions: localSuccessCount,
      capturedButPendingLocally: capturedButPendingLocally.length,
      localSuccessButNotVerifiedInRazorpay: localSuccessButNotVerifiedInRazorpay.length,
      pendingPayments: localPendingRows.length,
      failedPayments: localFailedRows.length,
      refundedPayments: localRefundedRows.length,
      manualReviewPayments: manualReviewRows.length,
      adminGrantedAccess: enrollmentCounts.manualGrantCount,
      activeCourseAccess: enrollmentCounts.activeAccessCount,
      differenceCount: localSuccessCount - razorpayCapturedCount,
      localVerifiedSuccessfulTransactions: localStrictVerifiedCount,
    },
    matchedCapturedPayments,
    capturedButPendingLocally,
    localSuccessButNotVerifiedInRazorpay,
    duplicateLocalSuccessfulTransactions,
    manualGrantsWronglyCountedAsPayments: [],
    refundedOrDisputedRecords,
    wrongDateTimezoneRecords,
    testModeLiveModeMismatchRecords: paymentMode === getRazorpayMode() ? [] : localRows.map((payment) => toPaymentReportRecord(payment, `Payment mode mismatch. Dashboard requested ${paymentMode}, server is running ${getRazorpayMode()}.`)),
    amountMismatchRecords: mismatchBuckets.amountMismatch,
    orderMismatchRecords: mismatchBuckets.orderMismatch,
    userMismatchRecords: mismatchBuckets.userMismatch,
    courseMismatchRecords: mismatchBuckets.courseMismatch,
    localTransactionNotFoundRecords: localTransactionNotFound,
  };
};

const getUnverifiedLocalPaidRowsReport = async ({
  rangePreset,
  startDate,
  endDate,
  timezone,
  paymentMode,
  limit,
  adminUserId = null,
  requestContext = null,
}) => {
  const rangeQuery = {
    rangePreset,
    startDate,
    endDate,
    timezone,
    paymentMode,
  };
  const range = buildPaymentRange(rangeQuery);
  const razorpayMode = String(paymentMode || getRazorpayMode()).trim().toLowerCase() || getRazorpayMode();
  const maxRows = Math.max(1, Math.min(1000, Number(limit) || 500));
  const [localRows, razorpayPayments] = await Promise.all([
    fetchLocalPaymentsForRange(range),
    fetchAllRazorpayPaymentsForRange(range),
  ]);

  const razorpayByPaymentId = new Map();
  const razorpayByOrderId = new Map();
  razorpayPayments.forEach((payment) => {
    const paymentId = String(payment?.id || '').trim();
    const orderId = String(payment?.order_id || '').trim();
    if (paymentId) {
      razorpayByPaymentId.set(paymentId, payment);
    }
    if (orderId && !razorpayByOrderId.has(orderId)) {
      razorpayByOrderId.set(orderId, payment);
    }
  });

  const rows = localRows
    .filter((payment) => String(payment.status || '').toLowerCase() === 'paid')
    .filter((payment) => !isStrictVerifiedCapturedPayment(payment))
    .map((payment) => {
      const meta = asObject(payment.payment_meta || payment.meta);
      const localPaymentId = String(payment.provider_payment_id || payment.providerPaymentId || '').trim();
      const localOrderId = String(payment.provider_order_id || payment.providerOrderId || '').trim();
      const byPaymentId = localPaymentId ? razorpayByPaymentId.get(localPaymentId) || null : null;
      const byOrderId = localOrderId ? razorpayByOrderId.get(localOrderId) || null : null;
      const possibleMatch = byPaymentId || byOrderId || null;
      const possibleMatchKind = byPaymentId
        ? 'gateway_payment_id'
        : byOrderId
          ? 'gateway_order_id'
          : null;
      const possibleMatchStatus = possibleMatch ? String(possibleMatch.status || '').toLowerCase() || null : null;
      const metadataGaps = listVerificationMetadataGaps(payment);
      return {
        localTransactionId: payment.id || payment._id || null,
        userId: payment.user_id || payment.userId || null,
        studentName: payment.full_name || 'Unknown Student',
        email: payment.email || null,
        mobileNumber: payment.mobile_number || payment.mobileNumber || null,
        courseId: payment.course_id || payment.courseId || null,
        courseName: payment.course_name || payment.courseName || null,
        amount: toNumber(payment.amount_inr ?? payment.amount ?? 0, 0),
        localStatus: payment.status || 'paid',
        gatewayOrderId: localOrderId || null,
        gatewayPaymentId: localPaymentId || null,
        createdAt: toIso(payment.created_at || payment.createdAt) || null,
        updatedAt: toIso(payment.updated_at || payment.updatedAt) || null,
        paidAt: toIso(payment.paid_at || payment.paidAt) || null,
        accessStatus: payment.access_status || null,
        validUntil: toIso(payment.expires_at || payment.expiresAt) || null,
        verificationStatus: meta.verificationDecision || meta.verificationStatus || null,
        verificationReason: meta.verificationReason || null,
        gatewayStatus: meta.gatewayStatus || meta.razorpayGatewayStatus || null,
        currency: meta.currency || payment.currency || 'INR',
        metadataGaps,
        possibleRazorpayMatch: possibleMatch ? {
          matchType: possibleMatchKind,
          razorpayPaymentId: possibleMatch.id || null,
          razorpayOrderId: possibleMatch.order_id || null,
          razorpayStatus: possibleMatchStatus,
          amount: Number(possibleMatch.amount || 0) / 100,
          currency: possibleMatch.currency || 'INR',
          email: possibleMatch.email || null,
          contact: possibleMatch.contact || null,
          capturedAt: toIso(new Date(Number(possibleMatch.captured_at || possibleMatch.created_at || 0) * 1000)) || null,
        } : null,
        dryRunDecision: possibleMatchStatus === 'captured'
          ? 'POTENTIALLY_REPAIRABLE_AFTER_SAFE_VERIFICATION'
          : possibleMatch
            ? 'MATCH_FOUND_BUT_NOT_CAPTURED'
            : 'NO_SAFE_RAZORPAY_MATCH_FOUND',
      };
    });

  const summary = {
    totalUnverifiedLocalPaidRows: rows.length,
    potentiallyRepairable: rows.filter((row) => row.dryRunDecision === 'POTENTIALLY_REPAIRABLE_AFTER_SAFE_VERIFICATION').length,
    matchedButNotCaptured: rows.filter((row) => row.dryRunDecision === 'MATCH_FOUND_BUT_NOT_CAPTURED').length,
    unmatched: rows.filter((row) => row.dryRunDecision === 'NO_SAFE_RAZORPAY_MATCH_FOUND').length,
    missingGatewayPaymentId: rows.filter((row) => row.metadataGaps.includes('missing_gateway_payment_id')).length,
    missingGatewayOrderId: rows.filter((row) => row.metadataGaps.includes('missing_gateway_order_id')).length,
  };

  const report = {
    range,
    paymentMode: razorpayMode,
    generatedAt: nowIso(),
    summary,
    rows: rows.slice(0, maxRows),
    totalRowsBeforeLimit: rows.length,
    limitApplied: maxRows,
  };

  if (adminUserId) {
    await createAuditLog({
      adminUserId,
      actionType: 'payment_unverified_reconciliation_dry_run',
      oldValue: {},
      newValue: {
        range,
        paymentMode: razorpayMode,
        summary,
        limitApplied: maxRows,
      },
      reason: 'Unverified local paid rows dry-run reconciliation',
      ipAddress: requestContext?.ipAddress || null,
      userAgent: requestContext?.userAgent || null,
    });
  }

  return report;
};

const loadCleanupCandidates = async () => {
  if (isPostgresReady()) {
    const [usersResult, coursesResult, testsResult, liveClassesResult] = await Promise.all([
      queryPostgres(`SELECT id, full_name, email, mobile_number, role, account_status, created_at FROM users WHERE role <> 'admin'`),
      queryPostgres(`SELECT id, title, description, category, exam, created_at FROM courses`),
      queryPostgres(`SELECT id, title, description, course_id, created_at FROM tests`),
      queryPostgres(`SELECT id, title, class_description, course_id, mock_test_id, created_at FROM live_classes`),
    ]);
    return {
      users: usersResult.rows,
      courses: coursesResult.rows,
      tests: testsResult.rows,
      liveClasses: liveClassesResult.rows,
    };
  }

  return {
    users: state.users.filter((entry) => entry.role !== 'admin').map((entry) => ({
      id: entry._id,
      full_name: entry.name,
      email: entry.email,
      mobile_number: entry.mobileNumber || null,
      role: entry.role,
      account_status: entry.accountStatus || 'active',
      created_at: entry.created_at || entry.createdAt || null,
    })),
    courses: state.courses.map((entry) => ({
      id: entry._id,
      title: entry.title,
      description: entry.description,
      category: entry.category,
      exam: entry.exam,
      created_at: entry.created_at || entry.createdAt || null,
    })),
    tests: state.tests.map((entry) => ({
      id: entry._id,
      title: entry.title,
      description: entry.description,
      course_id: entry.courseId || null,
      created_at: entry.created_at || entry.createdAt || null,
    })),
    liveClasses: state.liveClasses.map((entry) => ({
      id: entry._id,
      title: entry.title,
      class_description: entry.classDescription || '',
      course_id: entry.courseId || null,
      mock_test_id: entry.mockTestId || null,
      created_at: entry.created_at || entry.createdAt || null,
    })),
  };
};

const buildCleanupPreview = async () => {
  const candidates = await loadCleanupCandidates();
  const safeUsers = candidates.users.filter((user) => isSafeTestEmail(user.email));
  const safeCourses = candidates.courses.filter((course) => isSafeTestCourse(course));
  const safeCourseIds = new Set(safeCourses.map((course) => String(course.id)));
  const safeTests = candidates.tests.filter((test) => isSafeTestTest(test) || safeCourseIds.has(String(test.course_id || '')));
  const safeTestIds = new Set(safeTests.map((test) => String(test.id)));
  const safeLiveClasses = candidates.liveClasses.filter((liveClass) =>
    isSafeTestLiveClass(liveClass)
    || safeCourseIds.has(String(liveClass.course_id || ''))
    || safeTestIds.has(String(liveClass.mock_test_id || '')),
  );

  let dependentCounts = {
    enrollments: 0,
    payments: 0,
    sessions: 0,
    notifications: 0,
    watchHistory: 0,
    videoWatchStates: 0,
    supportTickets: 0,
    testAttempts: 0,
    liveChatMessages: 0,
    liveReplayAccessGrants: 0,
  };

  if (isPostgresReady()) {
    const safeUserIds = safeUsers.map((user) => String(user.id));
    const safeCourseIdsArray = Array.from(safeCourseIds);
    const safeLiveClassIds = safeLiveClasses.map((entry) => String(entry.id));
    const safeTestIdsArray = Array.from(safeTestIds);
    const countByIds = async (sql, ids) => {
      if (!ids.length) return 0;
      const result = await queryPostgres(sql, [ids]);
      return Number(result.rows[0]?.total || 0);
    };
    dependentCounts = {
      enrollments: await countByIds(`SELECT COUNT(*)::int AS total FROM enrollments WHERE user_id = ANY($1::text[]) OR course_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeCourseIdsArray])]),
      payments: await countByIds(`SELECT COUNT(*)::int AS total FROM payments WHERE user_id = ANY($1::text[]) OR course_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeCourseIdsArray])]),
      sessions: await countByIds(`SELECT COUNT(*)::int AS total FROM user_sessions WHERE user_id = ANY($1::text[])`, safeUserIds),
      notifications: await countByIds(`SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = ANY($1::text[])`, safeUserIds),
      watchHistory: await countByIds(`SELECT COUNT(*)::int AS total FROM watch_history WHERE user_id = ANY($1::text[]) OR course_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeCourseIdsArray])]),
      videoWatchStates: await countByIds(`SELECT COUNT(*)::int AS total FROM video_watch_states WHERE user_id = ANY($1::text[]) OR course_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeCourseIdsArray])]),
      supportTickets: await countByIds(`SELECT COUNT(*)::int AS total FROM lesson_doubt_threads WHERE student_user_id = ANY($1::text[]) OR course_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeCourseIdsArray])]),
      testAttempts: await countByIds(`SELECT COUNT(*)::int AS total FROM test_attempts WHERE user_id = ANY($1::text[]) OR test_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeTestIdsArray])]),
      liveChatMessages: await countByIds(`SELECT COUNT(*)::int AS total FROM live_chat_messages WHERE user_id = ANY($1::text[]) OR live_class_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeLiveClassIds])]),
      liveReplayAccessGrants: await countByIds(`SELECT COUNT(*)::int AS total FROM live_replay_access_grants WHERE user_id = ANY($1::text[]) OR live_class_id = ANY($1::text[])`, [...new Set([...safeUserIds, ...safeLiveClassIds])]),
    };
  } else {
    const safeUserIds = new Set(safeUsers.map((user) => String(user.id)));
    dependentCounts = {
      enrollments: state.enrollments.filter((entry) => safeUserIds.has(String(entry.userId)) || safeCourseIds.has(String(entry.courseId))).length,
      payments: state.payments.filter((entry) => safeUserIds.has(String(entry.userId)) || safeCourseIds.has(String(entry.courseId))).length,
      sessions: state.loginSessions.filter((entry) => safeUserIds.has(String(entry.userId))).length,
      notifications: state.notifications.filter((entry) => safeUserIds.has(String(entry.userId))).length,
      watchHistory: state.watchHistory.filter((entry) => safeUserIds.has(String(entry.userId)) || safeCourseIds.has(String(entry.courseId))).length,
      videoWatchStates: state.videoWatchStates.filter((entry) => safeUserIds.has(String(entry.userId)) || safeCourseIds.has(String(entry.courseId))).length,
      supportTickets: 0,
      testAttempts: state.testAttempts.filter((entry) => safeUserIds.has(String(entry.userId)) || safeTestIds.has(String(entry.testId))).length,
      liveChatMessages: 0,
      liveReplayAccessGrants: 0,
    };
  }

  const riskyRecords = [];
  if (safeUsers.some((user) => !String(user.email || '').endsWith('@edumaster.local'))) {
    riskyRecords.push('Some cleanup candidates do not use the synthetic @edumaster.local domain.');
  }

  const tokenPayload = {
    userIds: safeUsers.map((entry) => String(entry.id)).sort(),
    courseIds: Array.from(safeCourseIds).sort(),
    testIds: Array.from(safeTestIds).sort(),
    liveClassIds: safeLiveClasses.map((entry) => String(entry.id)).sort(),
  };
  const confirmToken = sha256(JSON.stringify(tokenPayload));

  return {
    matchingRules: {
      safeUserEmailPatterns: SAFE_TEST_USER_EMAIL_PATTERNS.map((pattern) => pattern.toString()),
      safeCourseTitlePatterns: SAFE_TEST_COURSE_PATTERNS.map((pattern) => pattern.toString()),
      safeCourseDescriptionPatterns: SAFE_TEST_DESCRIPTION_PATTERNS.map((pattern) => pattern.toString()),
      safeTestTitlePatterns: SAFE_TEST_TEST_PATTERNS.map((pattern) => pattern.toString()),
      safeLiveClassPatterns: SAFE_TEST_LIVE_CLASS_PATTERNS.map((pattern) => pattern.toString()),
    },
    totals: {
      testUsers: safeUsers.length,
      testCourses: safeCourses.length,
      testTests: safeTests.length,
      testLiveClasses: safeLiveClasses.length,
      testEnrollments: dependentCounts.enrollments,
      testPaymentRecords: dependentCounts.payments,
      testSessions: dependentCounts.sessions,
      testSupportTickets: dependentCounts.supportTickets,
      testNotifications: dependentCounts.notifications,
    },
    sampleRecords: {
      users: safeUsers.slice(0, 10),
      courses: safeCourses.slice(0, 10),
      tests: safeTests.slice(0, 10),
      liveClasses: safeLiveClasses.slice(0, 10),
    },
    riskyRecords,
    deletionMode: 'hard_delete_for_synthetic_records_only',
    backupExportPath: path.join(CLEANUP_BACKUP_DIR, `cleanup-preview-${Date.now()}.json`),
    confirmToken,
    safeToExecute: riskyRecords.length === 0,
    tokenPayload,
  };
};

const previewAutomationCleanup = async ({ adminUserId, requestContext }) => {
  const preview = await buildCleanupPreview();
  await createAuditLog({
    adminUserId,
    actionType: 'automation_cleanup_preview',
    oldValue: {},
    newValue: {
      totals: preview.totals,
      riskyRecords: preview.riskyRecords,
      safeToExecute: preview.safeToExecute,
    },
    reason: 'Preview cleanup of automation and synthetic QA data',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return preview;
};

const executeAutomationCleanup = async ({ adminUserId, requestContext, confirmToken }) => {
  const preview = await buildCleanupPreview();
  if (!preview.safeToExecute) {
    throw new ApiError(409, 'Cleanup preview contains risky records and cannot execute.', { code: 'CLEANUP_RISK_BLOCKED' });
  }
  if (!confirmToken || confirmToken !== preview.confirmToken) {
    throw new ApiError(409, 'Cleanup confirmation token did not match the latest preview.', { code: 'CLEANUP_CONFIRMATION_REQUIRED' });
  }

  await fs.mkdir(CLEANUP_BACKUP_DIR, { recursive: true });
  const backupExportPath = path.join(CLEANUP_BACKUP_DIR, `automation-cleanup-backup-${Date.now()}.json`);
  await fs.writeFile(backupExportPath, JSON.stringify(preview, null, 2), 'utf8');

  const userIds = preview.tokenPayload.userIds;
  const courseIds = preview.tokenPayload.courseIds;
  const testIds = preview.tokenPayload.testIds;
  const liveClassIds = preview.tokenPayload.liveClassIds;

  if (isPostgresReady()) {
    await runInTransaction(async (client) => {
      if (liveClassIds.length) {
        await queryPostgres(`DELETE FROM live_classes WHERE id = ANY($1::text[])`, [liveClassIds], client);
      }
      if (testIds.length) {
        await queryPostgres(`DELETE FROM tests WHERE id = ANY($1::text[])`, [testIds], client);
      }
      if (courseIds.length) {
        await queryPostgres(`DELETE FROM courses WHERE id = ANY($1::text[])`, [courseIds], client);
      }
      if (userIds.length) {
        await queryPostgres(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds], client);
      }
    });
  } else {
    state.liveClasses = state.liveClasses.filter((entry) => !liveClassIds.includes(String(entry._id)));
    state.tests = state.tests.filter((entry) => !testIds.includes(String(entry._id)));
    state.courses = state.courses.filter((entry) => !courseIds.includes(String(entry._id)));
    state.users = state.users.filter((entry) => !userIds.includes(String(entry._id)));
    state.enrollments = state.enrollments.filter((entry) => !userIds.includes(String(entry.userId)) && !courseIds.includes(String(entry.courseId)));
    state.payments = state.payments.filter((entry) => !userIds.includes(String(entry.userId)) && !courseIds.includes(String(entry.courseId)));
    state.loginSessions = state.loginSessions.filter((entry) => !userIds.includes(String(entry.userId)));
    state.notifications = state.notifications.filter((entry) => !userIds.includes(String(entry.userId)));
  }

  await createAuditLog({
    adminUserId,
    actionType: 'automation_cleanup_execute',
    oldValue: {},
    newValue: {
      totals: preview.totals,
      deletedUserIds: userIds,
      deletedCourseIds: courseIds,
      deletedTestIds: testIds,
      deletedLiveClassIds: liveClassIds,
      backupExportPath,
    },
    reason: 'Execute cleanup of automation and synthetic QA data',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });

  return {
    success: true,
    totals: preview.totals,
    backupExportPath,
    deleted: {
      users: userIds.length,
      courses: courseIds.length,
      tests: testIds.length,
      liveClasses: liveClassIds.length,
    },
  };
};

const getSystemHealthSummary = async () => {
  const snapshot = await getHealthSnapshot();
  const db = snapshot.dependencies?.postgres || {};
  const recentBulkSync = isPostgresReady()
    ? await queryPostgres(
      `
        SELECT created_at
        FROM admin_audit_logs
        WHERE action_type IN ('bulk_razorpay_sync', 'bulk_payment_sync')
        ORDER BY created_at DESC
        LIMIT 1
      `,
    ).then((result) => toIso(result.rows[0]?.created_at) || null).catch(() => null)
    : (state.adminAuditLogs.find((entry) => ['bulk_razorpay_sync', 'bulk_payment_sync'].includes(entry.actionType))?.createdAt || null);

  return {
    backendStatus: snapshot.status,
    appReplica1Health: 'unknown',
    appReplica2Health: 'unknown',
    dbStatus: db.status || 'unknown',
    dbConnections: db.pool || { total: null, idle: null, waiting: null },
    apiErrorRate: null,
    paymentSyncErrorRate: null,
    adminActionFailureRate: null,
    p95Latency: null,
    p99Latency: null,
    status502Count: null,
    status503Count: null,
    status504Count: null,
    lastSuccessfulBulkSyncTime: recentBulkSync,
    dependencies: snapshot.dependencies,
    checkedAt: snapshot.timestamp,
  };
};

const updateEnrollmentRecord = async ({ studentId, courseId, patch }) => {
  if (isPostgresReady()) {
    const existingResult = await queryPostgres(`SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2`, [String(studentId), String(courseId)]);
    const existing = existingResult.rows[0];
    if (!existing) {
      return null;
    }
    const next = {
      accessStatus: patch.accessStatus ?? existing.access_status ?? 'enabled',
      adminNote: patch.adminNote ?? existing.admin_note ?? null,
      expiresAt: patch.expiresAt ?? toIso(existing.expires_at),
      accessType: patch.accessType ?? existing.access_type ?? 'course',
      source: patch.source ?? existing.source ?? 'payment',
      updatedAt: nowIso(),
    };
    await queryPostgres(
      `
        UPDATE enrollments
        SET access_status = $3,
            admin_note = $4,
            expires_at = $5,
            access_type = $6,
            source = $7,
            updated_at = $8
        WHERE user_id = $1 AND course_id = $2
      `,
      [String(studentId), String(courseId), next.accessStatus, next.adminNote, next.expiresAt, next.accessType, next.source, next.updatedAt],
    );
    return next;
  }

  const enrollment = state.enrollments.find((entry) => entry.userId === String(studentId) && entry.courseId === String(courseId));
  if (!enrollment) {
    return null;
  }
  Object.assign(enrollment, patch, { updatedAt: nowIso() });
  return clone(enrollment);
};

const insertEnrollmentRecord = async ({ studentId, courseId, source = 'admin', expiresAt = null, accessStatus = 'enabled', adminNote = null }) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }
  if (isPostgresReady()) {
    await queryPostgres(
      `
        INSERT INTO enrollments (id, user_id, course_id, access_type, source, access_status, admin_note, enrolled_at, expires_at, view_count, updated_at)
        VALUES ($1, $2, $3, 'course', $4, $5, $6, now(), $7, 0, now())
        ON CONFLICT (user_id, course_id) DO UPDATE
        SET access_status = EXCLUDED.access_status,
            admin_note = EXCLUDED.admin_note,
            expires_at = EXCLUDED.expires_at,
            source = EXCLUDED.source,
            updated_at = now()
      `,
      [`enrollment_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, String(studentId), String(courseId), source, accessStatus, adminNote, expiresAt || new Date(Date.now() + Number(course.validityDays || 183) * 86400000).toISOString()],
    );
    return true;
  }

  const existing = state.enrollments.find((entry) => entry.userId === String(studentId) && entry.courseId === String(courseId));
  if (existing) {
    Object.assign(existing, {
      source,
      accessStatus,
      adminNote,
      expiresAt: expiresAt || new Date(Date.now() + Number(course.validityDays || 183) * 86400000).toISOString(),
      updatedAt: nowIso(),
    });
    return true;
  }
  state.enrollments.push({
    _id: nextId('enrollment'),
    userId: String(studentId),
    courseId: String(courseId),
    accessType: 'course',
    source,
    accessStatus,
    adminNote,
    enrolledAt: nowIso(),
    expiresAt: expiresAt || new Date(Date.now() + Number(course.validityDays || 183) * 86400000).toISOString(),
    viewCount: 0,
    updatedAt: nowIso(),
  });
  return true;
};

const updatePaymentRecord = async ({ paymentId, patch }) => {
  if (isPostgresReady()) {
    const currentResult = await queryPostgres(`SELECT * FROM payments WHERE id = $1`, [String(paymentId)]);
    const current = currentResult.rows[0];
    if (!current) {
      throw new ApiError(404, 'Transaction not found', { code: 'TRANSACTION_NOT_FOUND' });
    }
    if (patch.providerPaymentId && patch.providerPaymentId !== current.provider_payment_id) {
      const duplicateResult = await queryPostgres(
        `SELECT id FROM payments WHERE provider_payment_id = $1 AND id <> $2 LIMIT 1`,
        [String(patch.providerPaymentId), String(paymentId)],
      );
      if (duplicateResult.rows[0]) {
        throw new ApiError(409, 'Duplicate gateway payment ID is not allowed', { code: 'DUPLICATE_TRANSACTION_ID' });
      }
    }
    const nextMeta = {
      ...asObject(current.payment_meta),
      ...(patch.meta || {}),
    };
    await queryPostgres(
      `
        UPDATE payments
        SET status = $2,
            provider_payment_id = $3,
            provider_order_id = $4,
            last_error = $5,
            payment_meta = $6::jsonb,
            updated_at = now(),
            paid_at = CASE WHEN $2 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END
        WHERE id = $1
      `,
      [
        String(paymentId),
        patch.status ?? current.status,
        patch.providerPaymentId ?? current.provider_payment_id,
        patch.providerOrderId ?? current.provider_order_id,
        patch.lastError ?? current.last_error,
        JSON.stringify(nextMeta),
      ],
    );
    return { ...current, ...patch, meta: nextMeta };
  }

  const payment = state.payments.find((entry) => entry._id === String(paymentId));
  if (!payment) {
    throw new ApiError(404, 'Transaction not found', { code: 'TRANSACTION_NOT_FOUND' });
  }
  if (patch.providerPaymentId && patch.providerPaymentId !== payment.providerPaymentId) {
    const duplicate = state.payments.find((entry) => entry.providerPaymentId === String(patch.providerPaymentId) && entry._id !== String(paymentId));
    if (duplicate) {
      throw new ApiError(409, 'Duplicate gateway payment ID is not allowed', { code: 'DUPLICATE_TRANSACTION_ID' });
    }
  }
  payment.status = patch.status ?? payment.status;
  payment.providerPaymentId = patch.providerPaymentId ?? payment.providerPaymentId;
  payment.providerOrderId = patch.providerOrderId ?? payment.providerOrderId;
  payment.lastError = patch.lastError ?? payment.lastError;
  payment.meta = { ...(payment.meta || {}), ...(patch.meta || {}) };
  payment.updatedAt = nowIso();
  if (payment.status === 'paid' && !payment.paidAt) {
    payment.paidAt = nowIso();
  }
  return clone(payment);
};

const assignCourse = async ({ studentId, courseId, validUntil, adminNote, adminUserId, requestContext }) => {
  await insertEnrollmentRecord({
    studentId,
    courseId,
    source: 'manual_admin_grant',
    expiresAt: validUntil || null,
    accessStatus: 'enabled',
    adminNote: adminNote || null,
  });
  await createAuditLog({
    adminUserId,
    actionType: 'course_assigned_manually',
    targetUserId: studentId,
    courseId,
    oldValue: {},
    newValue: { validUntil: validUntil || null, adminNote: adminNote || null },
    reason: adminNote || 'Manual course assignment',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const updatePurchase = async ({ purchaseId, accessStatus, validUntil, paymentStatus, transactionId, adminNote, adminUserId, requestContext }) => {
  const purchases = await listPurchases({ page: 1, pageSize: 1, search: purchaseId });
  const purchase = purchases.items.find((item) => item.purchaseId === purchaseId);
  if (!purchase) {
    throw new ApiError(404, 'Purchase not found', { code: 'PURCHASE_NOT_FOUND' });
  }

  if (purchase.courseId) {
    const existingEnrollment = await updateEnrollmentRecord({
      studentId: purchase.studentId,
      courseId: purchase.courseId,
      patch: {
        accessStatus: accessStatus || undefined,
        adminNote: adminNote || undefined,
        expiresAt: validUntil || undefined,
      },
    });
    if (!existingEnrollment && accessStatus !== 'removed') {
      await insertEnrollmentRecord({
        studentId: purchase.studentId,
        courseId: purchase.courseId,
        source: 'admin',
        expiresAt: validUntil || null,
        accessStatus: accessStatus || 'enabled',
        adminNote: adminNote || null,
      });
    }
  }

  if (purchase.transactionId && purchase.transactionId !== purchase.purchaseId) {
    const transactionList = await listTransactions({ page: 1, pageSize: 1000, search: purchase.transactionId });
    const transaction = transactionList.items.find((item) => item.transactionId === purchase.transactionId || item.paymentId === purchase.transactionId);
    if (transaction) {
      await updatePaymentRecord({
        paymentId: transaction.paymentId,
        patch: {
          status: paymentStatus
            ? (paymentStatus === 'success' ? 'paid' : paymentStatus)
            : undefined,
          providerPaymentId: transactionId || undefined,
          meta: adminNote ? { adminNote } : undefined,
        },
      });
    }
  }

  await createAuditLog({
    adminUserId,
    actionType: 'purchase_updated',
    targetUserId: purchase.studentId,
    courseId: purchase.courseId,
    transactionId: purchase.transactionId,
    oldValue: purchase,
    newValue: { accessStatus, validUntil, paymentStatus, transactionId, adminNote },
    reason: adminNote || null,
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const removeCourseAccess = async ({ studentId, courseId, adminNote, adminUserId, requestContext }) => {
  const current = await updateEnrollmentRecord({
    studentId,
    courseId,
    patch: {
      accessStatus: 'removed',
      adminNote: adminNote || 'Access removed by admin',
      expiresAt: nowIso(),
    },
  });
  if (!current) {
    throw new ApiError(404, 'Course access not found', { code: 'COURSE_ACCESS_NOT_FOUND' });
  }
  await createAuditLog({
    adminUserId,
    actionType: 'course_removed',
    targetUserId: studentId,
    courseId,
    oldValue: {},
    newValue: { accessStatus: 'removed', adminNote: adminNote || null },
    reason: adminNote || null,
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const updateTransaction = async ({
  paymentId,
  status,
  transactionId,
  adminNote,
  manualReviewRequired,
  verificationDecision,
  verificationReason,
  adminUserId,
  requestContext,
}) => {
  const transactions = await listTransactions({ page: 1, pageSize: 1000, search: paymentId });
  const current = transactions.items.find((item) => item.paymentId === paymentId);
  if (!current) {
    throw new ApiError(404, 'Transaction not found', { code: 'TRANSACTION_NOT_FOUND' });
  }

  await updatePaymentRecord({
    paymentId,
    patch: {
      status: status || undefined,
      providerPaymentId: transactionId || undefined,
      meta: {
        ...(adminNote ? { adminNote } : {}),
        ...(manualReviewRequired === undefined ? {} : { manualReviewRequired: Boolean(manualReviewRequired) }),
        ...(verificationDecision ? { verificationDecision } : {}),
        ...(verificationReason ? { verificationReason } : {}),
      },
    },
  });

  if (current.courseId && current.studentId) {
    if (status === 'paid') {
      await insertEnrollmentRecord({
        studentId: current.studentId,
        courseId: current.courseId,
        source: 'payment',
        accessStatus: 'enabled',
        adminNote: adminNote || null,
      });
    } else if (status === 'failed' || status === 'pending' || status === 'refunded') {
      await updateEnrollmentRecord({
        studentId: current.studentId,
        courseId: current.courseId,
        patch: {
          accessStatus: 'disabled',
          adminNote: adminNote || `Payment marked ${status}`,
        },
      });
    }
  }

  await createAuditLog({
    adminUserId,
    actionType: 'transaction_updated',
    targetUserId: current.studentId,
    courseId: current.courseId,
    transactionId: current.transactionId,
    oldValue: current,
    newValue: { status, transactionId, adminNote, manualReviewRequired, verificationDecision, verificationReason },
    reason: adminNote || null,
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return { success: true };
};

const syncRazorpayPayment = async ({
  paymentId = '',
  transactionId = '',
  orderId = '',
  studentId = '',
  courseId = '',
  adminNote,
  adminUserId,
  requestContext,
}) => {
  const result = await paymentRepository.syncRazorpayPayment({
    paymentId,
    providerPaymentId: transactionId,
    providerOrderId: orderId,
    userId: studentId,
    courseId,
    actorId: adminUserId,
    syncSource: 'admin_sync',
    reason: adminNote || 'Manual Razorpay sync from admin panel',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });

  const diagnosis = result.payment?.userId && result.payment?.courseId
    ? await diagnoseCourseAccess({
      studentId: result.payment.userId,
      courseId: result.payment.courseId,
      transactionId: result.payment.providerPaymentId || result.payment._id,
    })
    : null;

  await createAuditLog({
    adminUserId,
    actionType: 'single_razorpay_sync',
    targetUserId: result.payment?.userId || studentId || null,
    courseId: result.payment?.courseId || courseId || null,
    transactionId: result.payment?.providerPaymentId || transactionId || paymentId || null,
    oldValue: {},
    newValue: {
      verificationDecision: result.verificationDecision || null,
      verificationReason: result.verificationReason || null,
      accessEnabled: Boolean(result.accessEnabled),
      enrollmentCreated: Boolean(result.enrollmentCreated),
      manualReviewRequired: Boolean(result.manualReviewRequired || result.payment?.meta?.manualReviewRequired),
    },
    reason: adminNote || 'Manual Razorpay sync from admin panel',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });

  return {
    success: true,
    summary: {
      paymentFound: Boolean(result.remotePayment),
      paymentId: result.payment?._id || paymentId || null,
      transactionId: result.payment?.providerPaymentId || transactionId || null,
      orderId: result.payment?.providerOrderId || orderId || null,
      gatewayStatus: result.remotePayment?.status || result.payment?.meta?.gatewayStatus || null,
      localStatus: result.payment?.status || null,
      verificationDecision: result.verificationDecision || result.payment?.meta?.verificationStatus || null,
      verificationReason: result.verificationReason || result.payment?.meta?.verificationReason || null,
      method: result.remotePayment?.method || result.payment?.meta?.paymentMethod || null,
      expectedAmount: result.payment?.meta?.expectedAmount ?? null,
      receivedAmount: result.payment?.meta?.receivedAmount ?? null,
      currency: result.payment?.meta?.currency || result.payment?.currency || 'INR',
      bankRrn: result.payment?.meta?.bankRrn || null,
      enrollmentCreated: Boolean(result.enrollmentCreated),
      accessEnabled: Boolean(result.accessEnabled),
      validityUpdated: Boolean(result.validityUpdated),
      cacheRefreshed: Boolean(result.cacheRefreshed),
      manualReviewRequired: Boolean(result.manualReviewRequired || result.payment?.meta?.manualReviewRequired),
      courseAccessLabel: diagnosis?.courseAccessLabel || null,
    },
    diagnosis,
  };
};

const syncAllPendingRazorpayPayments = async ({ maxRecords, adminNote, adminUserId, requestContext }) => {
  const result = await paymentRepository.syncAllPendingRazorpayPayments({
    maxRecords: maxRecords || 500,
    actorId: adminUserId,
    syncSource: 'bulk_admin_sync',
    reason: adminNote || 'Bulk sync for pending Razorpay payments',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  await createAuditLog({
    adminUserId,
    actionType: 'bulk_razorpay_sync',
    oldValue: {},
    newValue: {
      maxRecords: maxRecords || 500,
      totalChecked: result.totalChecked,
      verifiedCapturedActivated: result.verifiedCapturedActivated || 0,
      stillPending: result.stillPending,
      failed: result.failed,
      refunded: result.refunded,
      manualReviewRequired: result.manualReviewRequired || 0,
      errors: result.errors.length,
    },
    reason: adminNote || 'Bulk sync for pending Razorpay payments',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });
  return result;
};

const repairUnverifiedLocalPaidRows = async ({
  rangePreset,
  startDate,
  endDate,
  timezone,
  paymentMode,
  limit,
  dryRun = true,
  adminNote,
  adminUserId,
  requestContext,
}) => {
  const report = await getUnverifiedLocalPaidRowsReport({
    rangePreset,
    startDate,
    endDate,
    timezone,
    paymentMode,
    limit,
  });
  const candidates = report.rows.filter((row) =>
    row.dryRunDecision === 'POTENTIALLY_REPAIRABLE_AFTER_SAFE_VERIFICATION'
    && row.possibleRazorpayMatch
    && row.possibleRazorpayMatch.razorpayStatus === 'captured',
  );
  const summary = {
    totalScopedRows: report.totalRowsBeforeLimit,
    attempted: 0,
    repaired: 0,
    manualReviewRequired: 0,
    skipped: report.rows.length - candidates.length,
    errors: [],
    items: [],
  };

  if (!dryRun) {
    for (const row of candidates) {
      summary.attempted += 1;
      try {
        const result = await paymentRepository.syncRazorpayPayment({
          paymentId: row.localTransactionId,
          providerPaymentId: row.possibleRazorpayMatch.razorpayPaymentId,
          providerOrderId: row.possibleRazorpayMatch.razorpayOrderId,
          userId: row.userId,
          courseId: row.courseId,
          actorId: adminUserId,
          syncSource: 'historical_unverified_paid_repair',
          reason: adminNote || 'Repair historical paid row using strict Razorpay verification',
          ipAddress: requestContext?.ipAddress || null,
          userAgent: requestContext?.userAgent || null,
        });
        const repaired = String(result.verificationDecision || '').toUpperCase() === 'VERIFIED_CAPTURED_ACTIVATED';
        if (repaired) {
          summary.repaired += 1;
        }
        if (result.manualReviewRequired) {
          summary.manualReviewRequired += 1;
        }
        summary.items.push({
          localTransactionId: row.localTransactionId,
          razorpayPaymentId: row.possibleRazorpayMatch.razorpayPaymentId,
          verificationDecision: result.verificationDecision || null,
          verificationReason: result.verificationReason || null,
          repaired,
        });
      } catch (error) {
        summary.errors.push({
          localTransactionId: row.localTransactionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await createAuditLog({
    adminUserId,
    actionType: dryRun ? 'historical_paid_rows_repair_dry_run' : 'historical_paid_rows_repair_execute',
    oldValue: {},
    newValue: {
      range: report.range,
      paymentMode: report.paymentMode,
      dryRun,
      summary,
    },
    reason: adminNote || (dryRun ? 'Dry-run repair for historical unverified paid rows' : 'Execute repair for historical unverified paid rows'),
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });

  return {
    dryRun,
    range: report.range,
    paymentMode: report.paymentMode,
    candidateSummary: report.summary,
    executionSummary: summary,
    sampleRows: candidates.slice(0, Math.min(25, candidates.length)),
  };
};

const findPaymentByIdentifiers = async ({ paymentId = '', transactionId = '', studentId = '', courseId = '' }) => {
  if (isPostgresReady()) {
    const params = [];
    const filters = [];
    if (paymentId) {
      params.push(String(paymentId));
      filters.push(`p.id = $${params.length}`);
    }
    if (transactionId) {
      params.push(String(transactionId));
      filters.push(`(p.provider_payment_id = $${params.length} OR p.id = $${params.length})`);
    }
    if (studentId) {
      params.push(String(studentId));
      filters.push(`p.user_id = $${params.length}`);
    }
    if (courseId) {
      params.push(String(courseId));
      filters.push(`p.course_id = $${params.length}`);
    }
    if (!filters.length) {
      return null;
    }
    const result = await queryPostgres(
      `SELECT * FROM payments p WHERE ${filters.join(' AND ')} ORDER BY COALESCE(p.paid_at, p.updated_at, p.created_at) DESC LIMIT 1`,
      params,
    );
    return result.rows[0] || null;
  }

  return state.payments.find((payment) =>
    (!paymentId || payment._id === String(paymentId))
    && (!transactionId || payment.providerPaymentId === String(transactionId) || payment._id === String(transactionId))
    && (!studentId || payment.userId === String(studentId))
    && (!courseId || payment.courseId === String(courseId))) || null;
};

const findDuplicateUsers = async ({ email = '', mobileNumber = '', userId = '' }) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedMobile = String(mobileNumber || '').trim();

  if (isPostgresReady()) {
    const result = await queryPostgres(
      `
        SELECT id, full_name, email, mobile_number
        FROM users
        WHERE role <> 'admin'
          AND id <> $1
          AND (
            ($2 <> '' AND LOWER(email) = $2)
            OR ($3 <> '' AND COALESCE(mobile_number, '') = $3)
          )
        ORDER BY created_at DESC
      `,
      [String(userId || ''), normalizedEmail, normalizedMobile],
    );
    return result.rows.map((row) => ({
      studentId: row.id,
      name: row.full_name,
      email: row.email,
      mobileNumber: row.mobile_number || null,
    }));
  }

  return state.users
    .filter((user) => user.role !== 'admin' && user._id !== String(userId))
    .filter((user) => (normalizedEmail && String(user.email || '').toLowerCase() === normalizedEmail) || (normalizedMobile && String(user.mobileNumber || '') === normalizedMobile))
    .map((user) => ({
      studentId: user._id,
      name: user.name,
      email: user.email,
      mobileNumber: user.mobileNumber || null,
    }));
};

const getStudentCourseAccessLabel = ({
  paymentStatus = '',
  enrollmentExists = false,
  accessEnabled = false,
  validityActive = false,
  frontendPurchaseFlagExpected = false,
}) => {
  const normalizedPaymentStatus = String(paymentStatus || '').toLowerCase();
  if (frontendPurchaseFlagExpected) {
    return 'Start Course';
  }
  if (normalizedPaymentStatus === 'pending') {
    return 'Payment Pending';
  }
  if (normalizedPaymentStatus === 'failed') {
    return 'Buy';
  }
  if (normalizedPaymentStatus === 'refunded') {
    return 'Buy';
  }
  if (enrollmentExists && !accessEnabled) {
    return 'Access Disabled';
  }
  if (enrollmentExists && accessEnabled && !validityActive) {
    return 'Expired';
  }
  return 'Buy';
};

const buildRepairDiagnosis = async ({ studentId, courseId, payment = null, enrollment = null }) => {
  const student = await usersRepository.findSafeById(studentId);
  const course = courseId ? await coursesRepository.findById(courseId) : null;
  const resolvedPayment = payment || await findPaymentByIdentifiers({ studentId, courseId });
  const resolvedEnrollment = enrollment || (courseId ? await getEnrollment(studentId, courseId) : null);
  const duplicates = await findDuplicateUsers({
    email: student?.email || '',
    mobileNumber: student?.mobileNumber || '',
    userId: studentId,
  });

  const paymentSuccess = ['paid', 'success'].includes(String(resolvedPayment?.status || '').toLowerCase());
  const enrollmentExists = Boolean(resolvedEnrollment);
  const accessEnabled = Boolean(resolvedEnrollment) && String(resolvedEnrollment?.accessStatus || 'enabled').toLowerCase() === 'enabled';
  const validityActive = isEnrollmentActive(resolvedEnrollment);
  const courseIdMatched = Boolean(!resolvedPayment || !courseId || String(resolvedPayment.course_id || resolvedPayment.courseId || '') === String(courseId));
  const userIdMatched = Boolean(!resolvedPayment || String(resolvedPayment.user_id || resolvedPayment.userId || '') === String(studentId));
  const frontendPurchaseFlagExpected = Boolean(paymentSuccess && enrollmentExists && accessEnabled && validityActive && courseIdMatched && userIdMatched);

  let reason = 'No blocking diagnosis detected.';
  if (paymentSuccess && !enrollmentExists) {
    reason = 'Payment success but enrollment missing';
  } else if (paymentSuccess && enrollmentExists && !accessEnabled) {
    reason = 'Enrollment exists but access disabled';
  } else if (paymentSuccess && enrollmentExists && accessEnabled && !validityActive) {
    reason = 'Access enabled but validity expired';
  } else if (resolvedPayment && !courseIdMatched) {
    reason = 'Transaction course_id does not match course';
  } else if (resolvedPayment && !userIdMatched) {
    reason = 'Transaction user_id does not match student';
  } else if (duplicates.length > 0) {
    reason = 'Student has duplicate account with different email/mobile';
  } else if (!paymentSuccess && resolvedPayment) {
    reason = `Payment is ${String(resolvedPayment.status || 'pending').toLowerCase()}, access not enabled`;
  } else if (!resolvedPayment && enrollmentExists && accessEnabled && validityActive) {
    reason = 'Frontend cache stale or payment not linked';
  }

  const shouldShowStartCourse = frontendPurchaseFlagExpected;
  const shouldShowBuyButton = !shouldShowStartCourse && !['pending'].includes(String(resolvedPayment?.status || '').toLowerCase()) && !(enrollmentExists && !accessEnabled) && !(enrollmentExists && accessEnabled && !validityActive);
  const courseAccessLabel = getStudentCourseAccessLabel({
    paymentStatus: resolvedPayment?.status || '',
    enrollmentExists,
    accessEnabled,
    validityActive,
    frontendPurchaseFlagExpected,
  });

  return {
    studentId,
    studentName: student?.name || 'Unknown Student',
    studentEmail: student?.email || null,
    studentMobile: student?.mobileNumber || null,
    studentAccountStatus: student?.accountStatus || 'active',
    studentCreatedAt: student?.createdAt || student?.created_at || null,
    studentLastLoginAt: student?.lastLoginAt || null,
    courseId: courseId || null,
    courseName: course?.title || null,
    paymentSuccess,
    enrollmentExists,
    accessEnabled,
    validityActive,
    courseIdMatched,
    userIdMatched,
    frontendPurchaseFlagExpected,
    shouldShowBuyButton,
    shouldShowStartCourse,
    accessBlockReason: frontendPurchaseFlagExpected ? null : reason,
    courseAccessLabel,
    reasonStudentSeesBuyButton: frontendPurchaseFlagExpected ? null : reason,
    duplicateAccounts: duplicates,
    payment: resolvedPayment ? {
      paymentId: resolvedPayment.id || resolvedPayment._id,
      transactionId: resolvedPayment.provider_payment_id || resolvedPayment.providerPaymentId || null,
      providerOrderId: resolvedPayment.provider_order_id || resolvedPayment.providerOrderId || null,
      status: resolvedPayment.status || 'pending',
      amount: toNumber(resolvedPayment.amount_inr ?? resolvedPayment.amount),
      courseId: resolvedPayment.course_id || resolvedPayment.courseId || null,
      userId: resolvedPayment.user_id || resolvedPayment.userId || null,
      meta: asObject(resolvedPayment.payment_meta || resolvedPayment.meta),
    } : null,
    enrollment: resolvedEnrollment ? {
      enrollmentId: resolvedEnrollment._id,
      accessStatus: resolvedEnrollment.accessStatus || 'enabled',
      expiresAt: resolvedEnrollment.expiresAt || null,
      source: resolvedEnrollment.source || null,
      adminNote: resolvedEnrollment.adminNote || null,
    } : null,
  };
};

const getEnrollment = async (studentId, courseId) => {
  if (!studentId || !courseId) {
    return null;
  }
  if (isPostgresReady()) {
    const result = await queryPostgres(
      `SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2 ORDER BY enrolled_at DESC LIMIT 1`,
      [String(studentId), String(courseId)],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      _id: row.id,
      userId: row.user_id,
      courseId: row.course_id,
      accessType: row.access_type || 'course',
      source: row.source || 'payment',
      accessStatus: row.access_status || 'enabled',
      adminNote: row.admin_note || null,
      enrolledAt: toIso(row.enrolled_at) || null,
      expiresAt: toIso(row.expires_at) || null,
      viewCount: Number(row.view_count || 0),
      updatedAt: toIso(row.updated_at) || null,
    };
  }
  return state.enrollments.find((entry) => entry.userId === String(studentId) && entry.courseId === String(courseId)) || null;
};

const diagnoseCourseAccess = async ({ studentId, courseId = '', transactionId = '' }) => {
  let resolvedCourseId = courseId ? String(courseId) : '';
  let payment = null;
  if (transactionId) {
    payment = await findPaymentByIdentifiers({ transactionId, studentId, courseId: resolvedCourseId });
    if (payment && !resolvedCourseId) {
      resolvedCourseId = String(payment.course_id || payment.courseId || '');
    }
  }
  return buildRepairDiagnosis({
    studentId,
    courseId: resolvedCourseId,
    payment,
    enrollment: resolvedCourseId ? await getEnrollment(studentId, resolvedCourseId) : null,
  });
};

const repairCourseAccess = async ({ studentId, courseId = '', transactionId = '', adminNote, adminUserId, requestContext }) => {
  const diagnosisBefore = await diagnoseCourseAccess({ studentId, courseId, transactionId });
  const actions = [];

  let resolvedCourseId = diagnosisBefore.courseId || courseId || '';
  const payment = diagnosisBefore.payment;
  if (!resolvedCourseId && payment?.courseId) {
    resolvedCourseId = payment.courseId;
  }
  if (!resolvedCourseId) {
    throw new ApiError(400, 'Course ID could not be resolved for repair', { code: 'COURSE_ID_REQUIRED_FOR_REPAIR' });
  }

  if (payment && ['paid', 'success'].includes(String(payment.status || '').toLowerCase()) && !diagnosisBefore.enrollmentExists) {
    await insertEnrollmentRecord({
      studentId,
      courseId: resolvedCourseId,
      source: 'payment',
      accessStatus: 'enabled',
      adminNote: adminNote || 'Repair: created enrollment from paid transaction',
    });
    actions.push('created_enrollment');
  }

  const currentEnrollment = await getEnrollment(studentId, resolvedCourseId);
  const course = await coursesRepository.findById(resolvedCourseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  if (currentEnrollment && String(currentEnrollment.accessStatus || 'enabled').toLowerCase() !== 'enabled') {
    await updateEnrollmentRecord({
      studentId,
      courseId: resolvedCourseId,
      patch: {
        accessStatus: 'enabled',
        adminNote: adminNote || 'Repair: re-enabled access',
      },
    });
    actions.push('enabled_access');
  }

  const refreshedEnrollment = await getEnrollment(studentId, resolvedCourseId);
  if (refreshedEnrollment && !isEnrollmentActive(refreshedEnrollment)) {
    const nextExpiry = new Date(Date.now() + Number(course.validityDays || 365) * 86400000).toISOString();
    await updateEnrollmentRecord({
      studentId,
      courseId: resolvedCourseId,
      patch: {
        expiresAt: nextExpiry,
        accessStatus: 'enabled',
        adminNote: adminNote || 'Repair: refreshed validity',
      },
    });
    actions.push('extended_validity');
  }

  if (payment && (!payment.courseId || !diagnosisBefore.courseIdMatched)) {
    await updatePaymentRecord({
      paymentId: payment.paymentId,
      patch: {
        meta: {
          repairedCourseId: resolvedCourseId,
          adminNote: adminNote || 'Repair: linked payment to course',
        },
      },
    });
    actions.push('annotated_payment_course_mapping');
  }

  invalidateAllPlatformCachesForUser(studentId);
  actions.push('cleared_access_cache');

  const diagnosisAfter = await diagnoseCourseAccess({ studentId, courseId: resolvedCourseId, transactionId });
  await createAuditLog({
    adminUserId,
    actionType: 'course_access_repaired',
    targetUserId: studentId,
    courseId: resolvedCourseId,
    transactionId: payment?.transactionId || transactionId || null,
    oldValue: diagnosisBefore,
    newValue: diagnosisAfter,
    reason: adminNote || 'Repair Course Access',
    ipAddress: requestContext?.ipAddress || null,
    userAgent: requestContext?.userAgent || null,
  });

  return {
    success: true,
    actions,
    diagnosisBefore,
    diagnosisAfter,
    repairSummary: {
      paymentFound: Boolean(payment),
      transactionId: payment?.transactionId || transactionId || null,
      courseName: diagnosisAfter.courseName || null,
      enrollmentCreated: actions.includes('created_enrollment'),
      accessEnabled: diagnosisAfter.accessEnabled,
      validityUpdated: actions.includes('extended_validity'),
      cacheRefreshed: actions.includes('cleared_access_cache'),
      finalAccessStatus: diagnosisAfter.enrollment?.accessStatus || (diagnosisAfter.validityActive ? 'enabled' : 'disabled'),
      studentShouldNowSee: diagnosisAfter.courseAccessLabel || 'Buy',
      repairNote: adminNote || 'Course access repaired from admin panel',
    },
  };
};

const getDashboardSummary = async (query = {}) => {
  const [reconciliation, transactions, loginSessions, systemHealth] = await Promise.all([
    buildPaymentReconciliationReport(query),
    listTransactions({ ...query, page: 1, pageSize: 20 }),
    listLoginSessions({ page: 1, pageSize: 50 }),
    getSystemHealthSummary(),
  ]);

  if (isPostgresReady()) {
    const [studentCounts, enrollmentCounts] = await Promise.all([
      queryPostgres(`
        SELECT
          COUNT(*)::int AS total_students,
          COUNT(*) FILTER (WHERE account_status = 'active')::int AS active_count,
          COUNT(*) FILTER (WHERE account_status = 'disabled')::int AS disabled_count,
          COUNT(*) FILTER (WHERE account_status = 'blocked')::int AS blocked_count
        FROM users
        WHERE role <> 'admin'
      `),
      queryPostgres(`
        SELECT
          COUNT(*) FILTER (
            WHERE (access_status IS NULL OR access_status = 'enabled')
              AND (expires_at IS NULL OR expires_at > now())
          )::int AS active_access_count,
          COUNT(*) FILTER (
            WHERE (access_status IS NOT NULL AND access_status <> 'enabled')
               OR (expires_at IS NOT NULL AND expires_at <= now())
          )::int AS expired_access_count,
          COUNT(*) FILTER (WHERE source = 'manual_admin_grant')::int AS manual_grant_count
        FROM enrollments
      `),
    ]);

    return {
      totalStudents: Number(studentCounts.rows[0]?.total_students || 0),
      activeStudents: Number(studentCounts.rows[0]?.active_count || 0),
      disabledStudents: Number(studentCounts.rows[0]?.disabled_count || 0),
      blockedStudents: Number(studentCounts.rows[0]?.blocked_count || 0),
      activeStudentsNow: loginSessions.summary.loggedInNow,
      loggedInStudentsNow: loginSessions.summary.loggedInNow,
      loggedOutStudentsToday: loginSessions.items.filter((item) => item.logoutTime && new Date(item.logoutTime).toDateString() === new Date().toDateString()).length,
      totalCoursePurchases: reconciliation.cards.localSuccessfulTransactions,
      successfulPayments: reconciliation.cards.razorpayCapturedPayments,
      failedPayments: reconciliation.cards.failedPayments,
      pendingPayments: reconciliation.cards.pendingPayments,
      refundedPayments: reconciliation.cards.refundedPayments,
      manualReviewPayments: reconciliation.cards.manualReviewPayments,
      capturedInGatewayPendingLocally: reconciliation.cards.capturedButPendingLocally,
      activeCourseAccessCount: Number(enrollmentCounts.rows[0]?.active_access_count || 0),
      expiredCourseAccessCount: Number(enrollmentCounts.rows[0]?.expired_access_count || 0),
      adminGrantedAccessCount: Number(enrollmentCounts.rows[0]?.manual_grant_count || 0),
      backendHealth: systemHealth.backendStatus,
      dbHealth: systemHealth.dbStatus,
      recentTransactions: transactions.items.slice(0, 10),
      paymentDateRange: {
        ...reconciliation.range,
        dbStartIso: reconciliation.range.startIso,
        dbEndIso: reconciliation.range.endIso,
        razorpayStartIso: reconciliation.range.startIso,
        razorpayEndIso: reconciliation.range.endIso,
        paymentMode: reconciliation.paymentMode,
        lastReconciliationTime: reconciliation.lastReconciledAt,
      },
      paymentOverview: reconciliation.cards,
      paymentReconciliationPreview: {
        differenceCount: reconciliation.cards.differenceCount,
        matchedCapturedPayments: reconciliation.matchedCapturedPayments.length,
        capturedButPendingLocally: reconciliation.capturedButPendingLocally.length,
        localSuccessButNotVerifiedInRazorpay: reconciliation.localSuccessButNotVerifiedInRazorpay.length,
        duplicateLocalSuccessfulTransactions: reconciliation.duplicateLocalSuccessfulTransactions.length,
        wrongDateTimezoneRecords: reconciliation.wrongDateTimezoneRecords.length,
      },
    };
  }

  const [students, purchases] = await Promise.all([
    listStudents({ page: 1, pageSize: 1 }),
    listPurchases({ page: 1, pageSize: MAX_PAGE_SIZE }),
  ]);
  const purchaseItems = purchases.items;
  return {
    totalStudents: students.pagination.total,
    activeStudents: state.users.filter((user) => user.role !== 'admin' && (user.accountStatus || 'active') === 'active').length,
    disabledStudents: state.users.filter((user) => user.role !== 'admin' && (user.accountStatus || 'active') === 'disabled').length,
    blockedStudents: state.users.filter((user) => user.role !== 'admin' && (user.accountStatus || 'active') === 'blocked').length,
    activeStudentsNow: loginSessions.summary.loggedInNow,
    loggedInStudentsNow: loginSessions.summary.loggedInNow,
    loggedOutStudentsToday: loginSessions.items.filter((item) => item.logoutTime && new Date(item.logoutTime).toDateString() === new Date().toDateString()).length,
    totalCoursePurchases: reconciliation.cards.localSuccessfulTransactions,
    successfulPayments: reconciliation.cards.razorpayCapturedPayments,
    failedPayments: reconciliation.cards.failedPayments,
    pendingPayments: reconciliation.cards.pendingPayments,
    refundedPayments: reconciliation.cards.refundedPayments,
    manualReviewPayments: reconciliation.cards.manualReviewPayments,
    capturedInGatewayPendingLocally: reconciliation.cards.capturedButPendingLocally,
    activeCourseAccessCount: purchaseItems.filter((item) => item.accessStatus === 'enabled').length,
    expiredCourseAccessCount: purchaseItems.filter((item) => item.accessStatus === 'expired').length,
    adminGrantedAccessCount: state.enrollments.filter((entry) => entry.source === 'manual_admin_grant').length,
    backendHealth: systemHealth.backendStatus,
    dbHealth: systemHealth.dbStatus,
    recentTransactions: transactions.items.slice(0, 10),
    paymentDateRange: {
      ...reconciliation.range,
      dbStartIso: reconciliation.range.startIso,
      dbEndIso: reconciliation.range.endIso,
      razorpayStartIso: reconciliation.range.startIso,
      razorpayEndIso: reconciliation.range.endIso,
      paymentMode: reconciliation.paymentMode,
      lastReconciliationTime: reconciliation.lastReconciledAt,
    },
    paymentOverview: reconciliation.cards,
    paymentReconciliationPreview: {
      differenceCount: reconciliation.cards.differenceCount,
      matchedCapturedPayments: reconciliation.matchedCapturedPayments.length,
      capturedButPendingLocally: reconciliation.capturedButPendingLocally.length,
      localSuccessButNotVerifiedInRazorpay: reconciliation.localSuccessButNotVerifiedInRazorpay.length,
      duplicateLocalSuccessfulTransactions: reconciliation.duplicateLocalSuccessfulTransactions.length,
      wrongDateTimezoneRecords: reconciliation.wrongDateTimezoneRecords.length,
    },
  };
};

const getStudentLiveMetricsSummary = async () => {
  if (isPostgresReady()) {
    const result = await queryPostgres(`
      SELECT
        (
          SELECT COUNT(DISTINCT us.user_id)::int
          FROM user_sessions us
          WHERE us.status = 'active'
            AND COALESCE(us.last_seen_at, us.created_at) >= now() - interval '5 minutes'
        ) AS online_now,
        (
          SELECT COUNT(*)::int
          FROM device_activity da
          WHERE da.event_type = 'logout'
            AND da.created_at >= date_trunc('day', now())
            AND da.created_at < date_trunc('day', now()) + interval '1 day'
        ) AS logged_out_today,
        (
          SELECT COUNT(DISTINCT da.user_id)::int
          FROM device_activity da
          WHERE da.created_at >= now() - interval '5 minutes'
        ) AS active_now
    `);
    return {
      onlineNow: Number(result.rows[0]?.online_now || 0),
      loggedOutToday: Number(result.rows[0]?.logged_out_today || 0),
      activeNow: Number(result.rows[0]?.active_now || 0),
      refreshedAt: nowIso(),
    };
  }

  const todayKey = new Date().toDateString();
  return {
    onlineNow: new Set(state.loginSessions.filter((session) => session.status === 'active').map((session) => session.userId)).size,
    loggedOutToday: state.deviceActivities.filter((item) => item.eventType === 'logout' && new Date(item.createdAt || 0).toDateString() === todayKey).length,
    activeNow: state.deviceActivities.filter((item) => {
      const createdAt = new Date(item.createdAt || 0).getTime();
      return Number.isFinite(createdAt) && createdAt >= (Date.now() - 5 * 60 * 1000);
    }).length,
    refreshedAt: nowIso(),
  };
};

module.exports = {
  listStudents,
  createStudent,
  getStudentDetails,
  updateStudent,
  updateStudentStatus,
  resetStudentPassword,
  forceLogoutStudent,
  clearPlaybackSessions,
  resetWatchProgress,
  getAuditLogsForUser,
  listPurchases,
  listLoginSessions,
  listCourseAccess,
  listCourseAccessRules,
  upsertCourseAccessRule,
  deleteCourseAccessRule,
  listStudentLessonWatchOverrides,
  upsertStudentLessonWatchOverride,
  deleteStudentLessonWatchOverride,
  listManualReviewQueue,
  listAuditLogs,
  getSystemHealthSummary,
  assignCourse,
  updatePurchase,
  removeCourseAccess,
  listTransactions,
  updateTransaction,
  syncRazorpayPayment,
  syncAllPendingRazorpayPayments,
  diagnoseCourseAccess,
  repairCourseAccess,
  getDashboardSummary,
  getStudentLiveMetricsSummary,
  createAuditLog,
  getPaymentReconciliationReport: buildPaymentReconciliationReport,
  getUnverifiedLocalPaidRowsReport,
  previewAutomationCleanup,
  executeAutomationCleanup,
  repairUnverifiedLocalPaidRows,
};
