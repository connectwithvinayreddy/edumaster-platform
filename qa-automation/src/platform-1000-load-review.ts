import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { config } from './config.js';
import {
  assertMutationAllowed,
  certificationModeSummary,
  isProdSafeExistingDataMode,
  requireValueInProdSafeMode,
} from './certification-mode.js';
import { qaFetch } from './network.js';

type Json = Record<string, unknown>;

type Metric = {
  name: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  durationMs: number;
  user?: string;
  clientProfile?: string;
  journeyProfile?: string;
  bytes?: number;
  error?: string;
};

type Issue = {
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  whatBroke: string;
  where: string;
  exactErrorMessage: string;
  stepsToReproduce: string;
  userCountDuringFailure: number;
  apiServerResponse?: unknown;
  suggestedFix: string;
};

type LoadUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type CourseAccessSnapshot = {
  courseId: string;
  isPurchased: boolean;
  paymentStatus: string;
  accessStatus: string;
  canAccessCourse: boolean;
  accessBlockReason: string | null;
};

type JourneyProfileName =
  | 'full_journey'
  | 'browse_read'
  | 'video_active'
  | 'auth_session'
  | 'light_write'
  | 'pdf_read'
  | 'test_read';

type JourneyProfileConfig = {
  name: JourneyProfileName;
  label: string;
  description: string;
  runCourseReads: boolean;
  runTestReads: boolean;
  runTestSubmit: boolean;
  runVideoProgress: boolean;
  runNotifications: boolean;
  runProfileRead: boolean;
  runProfileUpdate: boolean;
  runUserInsights: boolean;
  runPaymentCheckout: boolean;
  runLiveReads: boolean;
  runLiveWrites: boolean;
  runEnroll: boolean;
  runPdfRead: boolean;
};

type JourneyProfileStats = {
  assigned: number;
  completed: number;
  successful: number;
  failed: number;
};

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const rootDir = path.resolve(process.cwd());
const resolveRootEnvPath = () => {
  const workspaceRoot = path.resolve(rootDir, path.basename(rootDir) === 'qa-automation' ? '..' : '.');
  const requestedEnvFile = String(process.env.ENV_FILE || '').trim();
  if (requestedEnvFile) {
    return path.isAbsolute(requestedEnvFile)
      ? requestedEnvFile
      : path.resolve(workspaceRoot, requestedEnvFile);
  }
  return path.join(workspaceRoot, '.env');
};
dotenv.config({ path: resolveRootEnvPath() });
const REPORT_PREFIX = (process.env.PLATFORM_LOAD_REPORT_PREFIX || 'platform-1000').trim() || 'platform-1000';
const reportDir = path.join(rootDir, 'reports', `${REPORT_PREFIX}-${runId}`);
const manifestPath = path.join(reportDir, 'prepared-users.json');
const configuredBaseUrl = process.env.QA_BASE_URL || config.baseUrl || 'http://127.0.0.1:3300';
const apiOrigin = (() => {
  const url = new URL(configuredBaseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();
const apiBase = `${apiOrigin}/backend/api`;

const VUS = Math.max(1, Number(process.env.PLATFORM_LOAD_USERS || 1000));
const SETUP_CONCURRENCY = Math.max(1, Number(process.env.PLATFORM_LOAD_SETUP_CONCURRENCY || 50));
const ACTIVE_CONCURRENCY = Math.max(1, Number(process.env.PLATFORM_LOAD_ACTIVE_CONCURRENCY || VUS));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.PLATFORM_LOAD_TIMEOUT_MS || 30000));
const LOGOUT_TIMEOUT_MS = Math.max(
  REQUEST_TIMEOUT_MS,
  Number(process.env.PLATFORM_LOAD_LOGOUT_TIMEOUT_MS || 45000),
);
const SETUP_DELAY_MS = Math.max(0, Number(process.env.PLATFORM_LOAD_SETUP_DELAY_MS || 0));
const USER_PASSWORD = process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123';
const SYNTHETIC_COURSE_PRICE = Math.max(1, Number(process.env.PLATFORM_LOAD_COURSE_PRICE || 1));
const EXISTING_COURSE_ID = String(process.env.PLATFORM_LOAD_COURSE_ID || '').trim();
const EXISTING_LESSON_ID = String(process.env.PLATFORM_LOAD_LESSON_ID || '').trim();
const EXISTING_TEST_ID = String(process.env.PLATFORM_LOAD_TEST_ID || '').trim();
const EXISTING_LIVE_CLASS_ID = String(process.env.PLATFORM_LOAD_LIVE_CLASS_ID || '').trim();
const ENABLE_PAYMENT_CHECKOUT = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT || '').toLowerCase());
const ENABLE_LIVE = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_ENABLE_LIVE || '').toLowerCase());
const ENABLE_VIDEO_PROGRESS = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS || '').toLowerCase());
const ENABLE_PROFILE_UPDATE = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_ENABLE_PROFILE_UPDATE || '').toLowerCase());
const ENABLE_ENROLL = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_ENABLE_ENROLL || '').toLowerCase());
const normalizeTrafficModel = (value: string): 'full_journey' | '5k_mixed' | 'streaming_pdf_mixed' => {
  const normalized = value.trim().toLowerCase();
  if (['streaming-pdf-mixed', 'streaming_pdf_mixed', 'pdf-mixed', 'pdf_mixed'].includes(normalized)) {
    return 'streaming_pdf_mixed';
  }
  if (['5k-mixed', '5k_mixed', 'mixed', 'mixed-5k', 'mixed_5k'].includes(normalized)) {
    return '5k_mixed';
  }
  return 'full_journey';
};
const TRAFFIC_MODEL = normalizeTrafficModel(String(process.env.PLATFORM_LOAD_TRAFFIC_MODEL || 'full_journey'));
const BROWSE_READ_WEIGHT = Math.max(0, Number(process.env.PLATFORM_LOAD_BROWSE_READ_PERCENT || 70));
const VIDEO_ACTIVE_WEIGHT = Math.max(0, Number(process.env.PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT || 15));
const AUTH_SESSION_WEIGHT = Math.max(0, Number(process.env.PLATFORM_LOAD_AUTH_SESSION_PERCENT || 10));
const LIGHT_WRITE_WEIGHT = Math.max(0, Number(process.env.PLATFORM_LOAD_LIGHT_WRITE_PERCENT || 5));
const PDF_READ_WEIGHT = Math.max(0, Number(process.env.PLATFORM_LOAD_PDF_READ_PERCENT || 50));
const TEST_READ_WEIGHT = Math.max(0, Number(process.env.PLATFORM_LOAD_TEST_READ_PERCENT || 20));
const PDF_ATTACHMENT_ID = String(process.env.PLATFORM_LOAD_PDF_ATTACHMENT_ID || '').trim();
const PDF_RANGE_BYTES = Math.max(4096, Number(process.env.PLATFORM_LOAD_PDF_RANGE_BYTES || 65536));
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || process.env.QA_LOGIN_EMAIL || config.loginEmail;
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.QA_LOGIN_PASSWORD || config.loginPassword;
const EXISTING_USERS_FILE = process.env.PLATFORM_LOAD_USERS_FILE || '';
const PARTIAL_REPORT_INTERVAL_MS = Math.max(5000, Number(process.env.PLATFORM_LOAD_PARTIAL_REPORT_MS || 30000));
const PREPARE_ONLY = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_PREPARE_ONLY || '').toLowerCase());
const PREPARE_RETRY_MAX = Math.max(0, Number(process.env.PLATFORM_LOAD_PREPARE_RETRY_MAX || 2));
const REUSE_EXISTING_USERS = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_REUSE_EXISTING_USERS || '').toLowerCase());
const TOP_UP_EXISTING_USERS = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_TOP_UP_EXISTING_USERS ?? 'true').toLowerCase());
const REFRESH_EXISTING_TOKENS = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLATFORM_LOAD_REFRESH_EXISTING_TOKENS || '').toLowerCase());
const LOGOUT_FRACTION = Math.min(1, Math.max(0, Number(process.env.PLATFORM_LOAD_LOGOUT_FRACTION || 0.3)));
const TRANSIENT_GET_RETRIES = Math.max(0, Number(process.env.PLATFORM_LOAD_TRANSIENT_GET_RETRIES || 1));
const TRANSIENT_LOGIN_RETRIES = Math.max(0, Number(process.env.PLATFORM_LOAD_TRANSIENT_LOGIN_RETRIES || 1));
const AUTH_MIN_INTERVAL_MS = Math.max(0, Number(process.env.PLATFORM_LOAD_AUTH_MIN_INTERVAL_MS || 1100));
const AUTH_JITTER_MS = Math.max(0, Number(process.env.PLATFORM_LOAD_AUTH_JITTER_MS || 200));
const PROD_SAFE_MODE = isProdSafeExistingDataMode();
const loadLabel = TRAFFIC_MODEL === '5k_mixed'
  ? `${VUS}-user platform mixed`
  : TRAFFIC_MODEL === 'streaming_pdf_mixed'
    ? `${VUS}-user streaming/pdf mixed background`
    : `${VUS}-user platform`;

const JOURNEY_PROFILES: Record<JourneyProfileName, JourneyProfileConfig> = {
  full_journey: {
    name: 'full_journey',
    label: 'Full journey',
    description: 'Legacy full user journey touching the broad app surface for each user.',
    runCourseReads: true,
    runTestReads: true,
    runTestSubmit: true,
    runVideoProgress: true,
    runNotifications: true,
    runProfileRead: true,
    runProfileUpdate: true,
    runUserInsights: true,
    runPaymentCheckout: true,
    runLiveReads: true,
    runLiveWrites: true,
    runEnroll: true,
    runPdfRead: false,
  },
  browse_read: {
    name: 'browse_read',
    label: 'Browse/read',
    description: 'Dashboard, catalog, course detail, lessons, tests listing, notifications, and profile reads.',
    runCourseReads: true,
    runTestReads: true,
    runTestSubmit: false,
    runVideoProgress: false,
    runNotifications: true,
    runProfileRead: true,
    runProfileUpdate: false,
    runUserInsights: true,
    runPaymentCheckout: false,
    runLiveReads: false,
    runLiveWrites: false,
    runEnroll: false,
    runPdfRead: false,
  },
  video_active: {
    name: 'video_active',
    label: 'Active video',
    description: 'Recorded-lesson active cohort with dashboard, course access, lesson reads, and watch-progress updates.',
    runCourseReads: true,
    runTestReads: false,
    runTestSubmit: false,
    runVideoProgress: true,
    runNotifications: true,
    runProfileRead: true,
    runProfileUpdate: false,
    runUserInsights: true,
    runPaymentCheckout: false,
    runLiveReads: false,
    runLiveWrites: false,
    runEnroll: false,
    runPdfRead: false,
  },
  auth_session: {
    name: 'auth_session',
    label: 'Auth/session',
    description: 'Login/session-heavy cohort with dashboard, session checks, notifications, and profile reads.',
    runCourseReads: false,
    runTestReads: false,
    runTestSubmit: false,
    runVideoProgress: false,
    runNotifications: true,
    runProfileRead: true,
    runProfileUpdate: false,
    runUserInsights: false,
    runPaymentCheckout: false,
    runLiveReads: false,
    runLiveWrites: false,
    runEnroll: false,
    runPdfRead: false,
  },
  light_write: {
    name: 'light_write',
    label: 'Light write',
    description: 'Low-write cohort with profile update plus light reads and session checks.',
    runCourseReads: true,
    runTestReads: false,
    runTestSubmit: false,
    runVideoProgress: false,
    runNotifications: true,
    runProfileRead: true,
    runProfileUpdate: true,
    runUserInsights: false,
    runPaymentCheckout: false,
    runLiveReads: false,
    runLiveWrites: false,
    runEnroll: false,
    runPdfRead: false,
  },
  pdf_read: {
    name: 'pdf_read',
    label: 'PDF read',
    description: 'Protected PDF reader cohort with course metadata reads and authenticated partial PDF fetches.',
    runCourseReads: true,
    runTestReads: false,
    runTestSubmit: false,
    runVideoProgress: false,
    runNotifications: false,
    runProfileRead: false,
    runProfileUpdate: false,
    runUserInsights: false,
    runPaymentCheckout: false,
    runLiveReads: false,
    runLiveWrites: false,
    runEnroll: false,
    runPdfRead: true,
  },
  test_read: {
    name: 'test_read',
    label: 'Test read',
    description: 'Protected mock-test reader cohort with tests list and test-detail reads only.',
    runCourseReads: false,
    runTestReads: true,
    runTestSubmit: false,
    runVideoProgress: false,
    runNotifications: false,
    runProfileRead: false,
    runProfileUpdate: false,
    runUserInsights: false,
    runPaymentCheckout: false,
    runLiveReads: false,
    runLiveWrites: false,
    runEnroll: false,
    runPdfRead: false,
  },
};

const resolveExplicitWeight = (rawValue: string | undefined, fallback: number) =>
  rawValue === undefined ? fallback : Math.max(0, Number(rawValue));

const mixedTrafficWeights = (() => {
  if (TRAFFIC_MODEL === 'streaming_pdf_mixed') {
    return [
      {
        profile: JOURNEY_PROFILES.auth_session,
        weight: resolveExplicitWeight(process.env.PLATFORM_LOAD_AUTH_SESSION_PERCENT, 40),
      },
      {
        profile: JOURNEY_PROFILES.pdf_read,
        weight: resolveExplicitWeight(process.env.PLATFORM_LOAD_PDF_READ_PERCENT, 40),
      },
      {
        profile: JOURNEY_PROFILES.test_read,
        weight: resolveExplicitWeight(process.env.PLATFORM_LOAD_TEST_READ_PERCENT, 20),
      },
    ].filter((item) => item.weight > 0);
  }

  return [
    { profile: JOURNEY_PROFILES.browse_read, weight: BROWSE_READ_WEIGHT },
    { profile: JOURNEY_PROFILES.video_active, weight: VIDEO_ACTIVE_WEIGHT },
    { profile: JOURNEY_PROFILES.auth_session, weight: AUTH_SESSION_WEIGHT },
    { profile: JOURNEY_PROFILES.light_write, weight: LIGHT_WRITE_WEIGHT },
  ].filter((item) => item.weight > 0);
})();

const totalMixedTrafficWeight = mixedTrafficWeights.reduce((sum, item) => sum + item.weight, 0);
const effectiveMixedTrafficWeights = totalMixedTrafficWeight > 0
  ? mixedTrafficWeights
  : TRAFFIC_MODEL === 'streaming_pdf_mixed'
    ? [
        { profile: JOURNEY_PROFILES.auth_session, weight: 40 },
        { profile: JOURNEY_PROFILES.pdf_read, weight: 40 },
        { profile: JOURNEY_PROFILES.test_read, weight: 20 },
      ]
    : [
        { profile: JOURNEY_PROFILES.browse_read, weight: 70 },
        { profile: JOURNEY_PROFILES.video_active, weight: 15 },
        { profile: JOURNEY_PROFILES.auth_session, weight: 10 },
        { profile: JOURNEY_PROFILES.light_write, weight: 5 },
      ];
const effectiveMixedTrafficWeightTotal = effectiveMixedTrafficWeights.reduce((sum, item) => sum + item.weight, 0);

const coveredModules = [
  TRAFFIC_MODEL === '5k_mixed' || TRAFFIC_MODEL === 'streaming_pdf_mixed'
    ? 'Journey-cohort traffic model'
    : 'Full user journey model',
  'Login/session',
  'Student dashboard',
  'Courses list/detail',
  'Notifications',
  'Profile read',
  'Navigation/route smoke',
  'Admin-authenticated seed discovery',
  TRAFFIC_MODEL === 'streaming_pdf_mixed' ? 'Tests list/detail' : 'Tests list',
  TRAFFIC_MODEL === 'streaming_pdf_mixed' ? 'Protected PDF partial read' : null,
].filter(Boolean) as string[];

const skippedModules = [
  ENABLE_ENROLL ? null : 'Course enroll/checkout access mutation',
  ENABLE_VIDEO_PROGRESS ? null : 'Recorded video watch progress',
  ENABLE_LIVE ? null : 'Live classes session/chat/media',
  ENABLE_PROFILE_UPDATE ? null : 'Profile update write path',
  ENABLE_PAYMENT_CHECKOUT ? null : 'Payment checkout/write path',
].filter(Boolean) as string[];

const metrics: Metric[] = [];
const issues: Issue[] = [];
const userJourneyProfiles = new Map<string, JourneyProfileName>();
const journeyProfileStats = new Map<JourneyProfileName, JourneyProfileStats>();
const progress = {
  phase: 'initializing',
  preparedUsers: 0,
  startedJourneys: 0,
  completedJourneys: 0,
  successfulJourneys: 0,
  logoutJourneys: 0,
  keptActiveJourneys: 0,
};

const ensureJourneyProfileStats = (name: JourneyProfileName) => {
  const existing = journeyProfileStats.get(name);
  if (existing) {
    return existing;
  }
  const created = {
    assigned: 0,
    completed: 0,
    successful: 0,
    failed: 0,
  };
  journeyProfileStats.set(name, created);
  return created;
};

const summarizeJourneyProfiles = () => {
  const orderedNames = TRAFFIC_MODEL === '5k_mixed' || TRAFFIC_MODEL === 'streaming_pdf_mixed'
    ? effectiveMixedTrafficWeights.map((item) => item.profile.name)
    : [JOURNEY_PROFILES.full_journey.name];
  return orderedNames.map((name) => {
    const config = JOURNEY_PROFILES[name];
    const stats = ensureJourneyProfileStats(name);
    const target = journeyProfileTargets.find((item) => item.name === name);
    return {
      name,
      label: config.label,
      description: config.description,
      targetPercent: target?.percent ?? null,
      targetUsersAtCurrentLoad: target?.usersAtCurrentLoad ?? null,
      assigned: stats.assigned,
      completed: stats.completed,
      successful: stats.successful,
      failed: stats.failed,
    };
  });
};

const summarizeClientProfiles = (users: LoadUser[]) => {
  const summary: Record<string, number> = {};
  for (const user of users) {
    const profileName = getClientProfile(user.email).name;
    summary[profileName] = (summary[profileName] || 0) + 1;
  }
  return summary;
};

const percentile = (values: number[], target: number) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values: number[]) =>
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let authQueue = Promise.resolve();
let authNextAvailableAt = 0;

const withAuthPacing = async <T>(work: () => Promise<T>) => {
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = authQueue;
  authQueue = authQueue.then(() => next);

  await previous;
  const delayMs = Math.max(0, authNextAvailableAt - Date.now());
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  try {
    return await work();
  } finally {
    authNextAvailableAt = Date.now() + AUTH_MIN_INTERVAL_MS + (AUTH_JITTER_MS ? Math.floor(Math.random() * AUTH_JITTER_MS) : 0);
    release();
  }
};

const shouldRetryPrepareError = (error: unknown) => {
  const status = Number((error as { status?: number })?.status || 0);
  const message = error instanceof Error ? error.message : String(error);
  return status === 503 || (status === 0 && /aborted|timeout/i.test(message));
};

const pickId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  const direct = item._id || item.id;
  return direct ? String(direct) : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const buildCourseAccessSnapshot = (value: unknown, fallbackCourseId = ''): CourseAccessSnapshot | null => {
  const item = asRecord(value);
  if (!item) {
    return null;
  }

  return {
    courseId: String(item._id || item.id || fallbackCourseId || ''),
    isPurchased: Boolean(item.isPurchased),
    paymentStatus: String(item.paymentStatus || 'none').toLowerCase(),
    accessStatus: String(item.accessStatus || 'not_purchased').toLowerCase(),
    canAccessCourse: Boolean(item.canAccessCourse ?? item.enrolled),
    accessBlockReason: item.accessBlockReason ? String(item.accessBlockReason) : null,
  };
};

const getClientProfile = (user?: string) => {
  const index = Number(String(user || '').match(/_(\d+)@/)?.[1] || 0);
  if (index % 3 === 1) {
    return {
      name: 'mobile-ios-web',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    };
  }
  if (index % 3 === 2) {
    return {
      name: 'mobile-android-web',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    };
  }
  return {
    name: 'desktop-web',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  };
};

const getJourneyProfileForIndex = (index: number): JourneyProfileConfig => {
  if (TRAFFIC_MODEL === 'full_journey') {
    return JOURNEY_PROFILES.full_journey;
  }

  const normalizedSlot = ((index % effectiveMixedTrafficWeightTotal) + effectiveMixedTrafficWeightTotal) % effectiveMixedTrafficWeightTotal;
  let cursor = 0;
  for (const item of effectiveMixedTrafficWeights) {
    cursor += item.weight;
    if (normalizedSlot < cursor) {
      return item.profile;
    }
  }
  return effectiveMixedTrafficWeights[effectiveMixedTrafficWeights.length - 1]?.profile || JOURNEY_PROFILES.browse_read;
};

const getJourneyProfileForUser = (user: LoadUser) => getJourneyProfileForIndex(user.index);

const journeyProfileTargets = TRAFFIC_MODEL === '5k_mixed' || TRAFFIC_MODEL === 'streaming_pdf_mixed'
  ? effectiveMixedTrafficWeights.map((item) => ({
      name: item.profile.name,
      label: item.profile.label,
      description: item.profile.description,
      weight: item.weight,
      percent: Number(((item.weight / effectiveMixedTrafficWeightTotal) * 100).toFixed(2)),
      usersAtCurrentLoad: Math.round((item.weight / effectiveMixedTrafficWeightTotal) * VUS),
    }))
  : [{
      name: JOURNEY_PROFILES.full_journey.name,
      label: JOURNEY_PROFILES.full_journey.label,
      description: JOURNEY_PROFILES.full_journey.description,
      weight: 100,
      percent: 100,
      usersAtCurrentLoad: VUS,
    }];

const requiresTestReadTarget = TRAFFIC_MODEL === 'streaming_pdf_mixed'
  && journeyProfileTargets.some((item) => item.name === JOURNEY_PROFILES.test_read.name && Number(item.usersAtCurrentLoad || 0) > 0);

const recordIssue = (issue: Issue) => {
  issues.push(issue);
};

const dropLatestFailureMetric = (name: string, route: string, user?: string) => {
  for (let index = metrics.length - 1; index >= 0; index -= 1) {
    const metric = metrics[index];
    if (!metric.ok && metric.name === name && metric.path === route && metric.user === user) {
      metrics.splice(index, 1);
      return;
    }
  }
};

const getRequestTimeoutMs = (name: string, method: string) => {
  if (name === 'auth.logout' || (method.toUpperCase() === 'POST' && /\/auth\/logout$/.test(name))) {
    return LOGOUT_TIMEOUT_MS;
  }
  return REQUEST_TIMEOUT_MS;
};

const getRequestMaxAttempts = (name: string, method: string, route: string) => {
  const upperMethod = method.toUpperCase();
  if (upperMethod === 'GET') {
    return TRANSIENT_GET_RETRIES + 1;
  }
  if (name === 'auth.login' || (upperMethod === 'POST' && route === '/auth/login')) {
    return TRANSIENT_LOGIN_RETRIES + 1;
  }
  if (name === 'auth.logout' || (upperMethod === 'POST' && route === '/auth/logout')) {
    return 2;
  }
  return 1;
};

const request = async <T = unknown>(
  name: string,
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  user?: string,
): Promise<T | null> => {
  const clientProfile = getClientProfile(user);
  const maxAttempts = getRequestMaxAttempts(name, method, route);
  const timeoutMs = getRequestTimeoutMs(name, method);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    let status = 0;
    let responsePayload: unknown = null;

    try {
      const response = await qaFetch(`${apiBase}${route}`, {
        method,
        headers: {
          'user-agent': clientProfile.userAgent,
          'x-qa-client-profile': clientProfile.name,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      const text = await response.text();
      const contentType = response.headers.get('content-type') || '';
      responsePayload = !text
        ? null
        : /application\/json/i.test(contentType)
          ? JSON.parse(text)
          : { raw: text.slice(0, 2_000), contentType };
      const durationMs = Math.round(performance.now() - started);

      if (!response.ok) {
        const message = typeof responsePayload === 'object' && responsePayload
          ? String((responsePayload as Record<string, unknown>).message || (responsePayload as Record<string, unknown>).error || `${status}`)
          : `${status}`;
        throw Object.assign(new Error(`${method} ${route} failed with ${status}: ${message}`), {
          status,
          payload: responsePayload,
          retryAfterMs: Math.max(0, Number(response.headers.get('retry-after') || 0) * 1000),
        });
      }

      metrics.push({
        name,
        method,
        path: route,
        status,
        ok: true,
        durationMs,
        user,
        clientProfile: clientProfile.name,
        journeyProfile: user ? userJourneyProfiles.get(user) : undefined,
        bytes: text.length,
      });
      return responsePayload as T;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : String(error);
      const retryable = attempt + 1 < maxAttempts
        && status === 0
        && /aborted|timeout|fetch failed|network/i.test(message);
      if (retryable) {
        dropLatestFailureMetric(name, route, user);
        await sleep(250 * (attempt + 1));
        continue;
      }
      metrics.push({
        name,
        method,
        path: route,
        status,
        ok: false,
        durationMs,
        user,
        clientProfile: clientProfile.name,
        journeyProfile: user ? userJourneyProfiles.get(user) : undefined,
        error: message,
      });
      throw Object.assign(new Error(message), { status, payload: responsePayload });
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Request failed without a terminal response: ${method} ${route}`);
};

const optionalRequest = async <T = unknown>(
  name: string,
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  user?: string,
): Promise<T | null> => {
  try {
    return await request<T>(name, method, route, body, token, user);
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 0);
    if (status === 404) {
      return null;
    }
    throw error;
  }
};

const requestPdfPartial = async (
  name: string,
  route: string,
  token: string,
  user?: string,
  rangeStart = 0,
  rangeEnd = PDF_RANGE_BYTES - 1,
) => {
  const clientProfile = getClientProfile(user);
  const started = performance.now();
  const response = await qaFetch(`${apiBase}${route}`, {
    method: 'GET',
    headers: {
      'user-agent': clientProfile.userAgent,
      'x-qa-client-profile': clientProfile.name,
      authorization: `Bearer ${token}`,
      accept: 'application/pdf',
      range: `bytes=${rangeStart}-${Math.max(rangeStart, rangeEnd)}`,
      'x-edumaster-app': 'web',
      'x-edumaster-client-platform': 'windows',
      'x-edumaster-client-browser': 'edge',
      'x-edumaster-device-id': `platform-load-pdf-${user || 'anonymous'}`,
      'x-edumaster-playback-tab-id': `platform-load-pdf-tab-${user || 'anonymous'}`,
      'x-edumaster-browser-tab-id': `platform-load-pdf-tab-${user || 'anonymous'}`,
    },
  });

  const reader = response.body?.getReader?.();
  let bytesRead = 0;
  try {
    if (reader) {
      while (bytesRead < PDF_RANGE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytesRead += chunk.value?.byteLength || 0;
        if (bytesRead >= PDF_RANGE_BYTES) {
          break;
        }
      }
      await reader.cancel().catch(() => undefined);
    } else {
      const buffer = await response.arrayBuffer();
      bytesRead = buffer.byteLength;
    }
  } catch (error) {
    await reader?.cancel?.().catch(() => undefined);
    throw error;
  }

  const durationMs = Math.round(performance.now() - started);
  const ok = response.ok || response.status === 206;
  metrics.push({
    name,
    method: 'GET',
    path: route,
    status: response.status,
    ok,
    durationMs,
    user,
    clientProfile: clientProfile.name,
    journeyProfile: user ? userJourneyProfiles.get(user) : undefined,
    bytes: bytesRead,
    error: ok ? undefined : `Unexpected PDF response status ${response.status}`,
  });

  if (!ok) {
    throw Object.assign(
      new Error(`GET ${route} failed with ${response.status}`),
      { status: response.status },
    );
  }

  return {
    status: response.status,
    bytesRead,
    contentLength: Number(response.headers.get('content-length') || 0) || null,
    contentRange: response.headers.get('content-range'),
  };
};

const runPool = async <T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) => {
  const results: R[] = [];
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
  return results;
};

const currentSummary = (extra: Json = {}) => {
  const finalMemory = process.memoryUsage();
  return {
    runId,
    baseUrl: apiOrigin,
    apiBase,
    trafficModel: TRAFFIC_MODEL,
    journeyProfileTargets,
    journeyProfileBreakdown: summarizeJourneyProfiles(),
    usersRequested: VUS,
    setupConcurrency: SETUP_CONCURRENCY,
    activeConcurrency: ACTIVE_CONCURRENCY,
    progress: { ...progress },
    totalRequests: metrics.length,
    failedRequests: metrics.filter((metric) => !metric.ok).length,
    endpointSummary: summarizeByName(),
    issues,
    crashed: false,
    finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
    peakHeapUsedMb: Math.round(finalMemory.heapUsed / 1024 / 1024),
    artifacts: {
      reportDir,
      json: path.join(reportDir, 'full-automation-test-report.json'),
      markdown: path.join(reportDir, 'full-automation-test-report.md'),
      manifest: manifestPath,
    },
    certificationMode: certificationModeSummary(),
    ...extra,
  };
};

const writePartialReport = async (reason: string) => {
  await fs.mkdir(reportDir, { recursive: true });
  const summary = currentSummary({ partial: true, reason });
  await fs.writeFile(path.join(reportDir, 'partial-report.json'), JSON.stringify(summary, null, 2));
  console.log(`[${new Date().toISOString()}] partial report: ${reason}; phase=${progress.phase}; prepared=${progress.preparedUsers}/${VUS}; completed=${progress.completedJourneys}/${VUS}; requests=${metrics.length}; failures=${metrics.filter((metric) => !metric.ok).length}`);
};

const login = async (email: string, password: string, device: string) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= TRANSIENT_LOGIN_RETRIES; attempt += 1) {
    try {
      const payload = await withAuthPacing(() => request<{ token: string; user: Json }>('auth.login', 'POST', '/auth/login', {
        email,
        password,
        device,
        forceLogoutOtherSessions: true,
      }, undefined, email));
      if (!payload?.token) {
        throw new Error(`Login did not return token for ${email}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      const status = Number((error as { status?: number })?.status || 0);
      const message = error instanceof Error ? error.message : String(error);
      const retryable = attempt < TRANSIENT_LOGIN_RETRIES && (
        (status === 0 && /aborted|timeout|fetch failed|network/i.test(message))
        || [429, 502, 503, 504].includes(status)
      );
      if (!retryable) {
        throw error;
      }
      dropLatestFailureMetric('auth.login', '/auth/login', email);
      const retryAfterMs = Math.max(0, Number((error as { retryAfterMs?: number })?.retryAfterMs || 0));
      await sleep(status === 429 ? Math.max(retryAfterMs, 2_000 * (attempt + 1)) : 300 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Login failed for ${email}`);
};

const resolveExistingTargets = async (adminToken: string) => {
  requireValueInProdSafeMode('PLATFORM_LOAD_COURSE_ID', EXISTING_COURSE_ID);
  if (TRAFFIC_MODEL === 'streaming_pdf_mixed') {
    requireValueInProdSafeMode('PLATFORM_LOAD_LESSON_ID', EXISTING_LESSON_ID);
    requireValueInProdSafeMode('PLATFORM_LOAD_PDF_ATTACHMENT_ID', PDF_ATTACHMENT_ID);
    requireValueInProdSafeMode('PLATFORM_LOAD_TEST_ID', EXISTING_TEST_ID);
  }
  const courseList = await request<Json[]>('courses.list.seed', 'GET', '/courses', undefined, adminToken, 'admin');
  const courseId = EXISTING_COURSE_ID || (Array.isArray(courseList) && courseList.length > 0 ? pickId(courseList[0]) : null);
  if (!courseId) {
    throw new Error('No existing course available for platform load test.');
  }

  const lessonsPayload = await request<Json[]>('courses.lessons.seed', 'GET', `/courses/${courseId}/lessons`, undefined, adminToken, 'admin');
  const lessonId = EXISTING_LESSON_ID
    || (Array.isArray(lessonsPayload) && lessonsPayload.length > 0 ? pickId(lessonsPayload[0]) : null);

  const testId = EXISTING_TEST_ID || null;
  const liveClassId = EXISTING_LIVE_CLASS_ID || null;

  return {
    courseId,
    moduleId: null,
    lessonId,
    testId,
    liveClassId,
  };
};

const createTestData = async (adminToken: string) => {
  if (EXISTING_COURSE_ID || EXISTING_TEST_ID || EXISTING_LIVE_CLASS_ID) {
    return resolveExistingTargets(adminToken);
  }

  return resolveExistingTargets(adminToken);
};

const createSyntheticTestData = async (adminToken: string) => {
  assertMutationAllowed('Creating synthetic platform load targets');
  const stamp = Date.now();
  const lessonId = `lesson_load_${stamp}`;
  const moduleId = `module_load_${stamp}`;
  const course = await request<Json>('admin.course.create', 'POST', '/courses', {
    title: `QA Load Course ${stamp}`,
    description: `Synthetic ${loadLabel} QA course generated by automation.`,
    category: 'QA',
    exam: 'QA',
    subject: 'Scalability',
    level: 'Full Course',
    price: SYNTHETIC_COURSE_PRICE,
    validityDays: 30,
    modules: [{
      id: moduleId,
      title: 'Load Module',
      lessons: [{
        id: lessonId,
        title: 'Recorded Video Smoke Lesson',
        lessonType: 'video',
        videoUrl: 'https://example.com/synthetic-load-video.mp4',
        durationMinutes: 30,
      }],
      chapters: [],
    }],
  }, adminToken, 'admin');
  const courseId = pickId(course);
  if (!courseId) {
    throw new Error('Synthetic course did not return an id.');
  }

  const test = await request<Json>('admin.test.create', 'POST', '/tests', {
    title: `QA Load Mock Test ${stamp}`,
    description: 'Synthetic concurrent mock test.',
    category: 'QA',
    type: 'mock',
    courseId,
    durationMinutes: 30,
    totalMarks: 3,
    negativeMarking: 0.25,
    questions: [
      {
        id: 'q1',
        questionText: 'Load question 1',
        options: ['A', 'B', 'C', 'D'],
        correctOption: 0,
        answer: 0,
        marks: 1,
        topic: 'Load',
      },
      {
        id: 'q2',
        questionText: 'Load question 2',
        options: ['A', 'B', 'C', 'D'],
        correctOption: 1,
        answer: 1,
        marks: 1,
        topic: 'Load',
      },
      {
        id: 'q3',
        questionText: 'Load question 3',
        options: ['A', 'B', 'C', 'D'],
        correctOption: 2,
        answer: 2,
        marks: 1,
        topic: 'Load',
      },
    ],
  }, adminToken, 'admin');
  const testId = pickId(test);
  if (!testId) {
    throw new Error('Synthetic test did not return an id.');
  }

  const livePayload = await request<{ liveClass: Json }>('admin.live.create', 'POST', '/live-classes', {
    title: `QA Load Live Class ${stamp}`,
    startTime: new Date(Date.now() - 60_000).toISOString(),
    durationMinutes: 60,
    instructor: 'QA Load Faculty',
    status: 'scheduled',
    maxAttendees: Math.max(2500, VUS + 100),
    requiresEnrollment: false,
    chatEnabled: true,
    doubtSolving: true,
    topicTags: ['load-test'],
  }, adminToken, 'admin');
  const liveClassId = pickId(livePayload?.liveClass);
  if (!liveClassId) {
    throw new Error('Synthetic live class did not return an id.');
  }
  await request('admin.live.start', 'POST', `/live-classes/${liveClassId}/start`, {}, adminToken, 'admin');

  return { courseId, moduleId, lessonId, testId, liveClassId };
};

const prepareUsers = async (): Promise<LoadUser[]> => {
  requireValueInProdSafeMode('PLATFORM_LOAD_USERS_FILE', EXISTING_USERS_FILE);
  const existingUsers = EXISTING_USERS_FILE
    ? JSON.parse(await fs.readFile(EXISTING_USERS_FILE, 'utf8')) as LoadUser[]
    : [];

  const refreshExistingUsers = async (usersToRefresh: LoadUser[]) => {
    if (!usersToRefresh.length || !REFRESH_EXISTING_TOKENS) {
      return usersToRefresh;
    }

    await runPool(usersToRefresh, SETUP_CONCURRENCY, async (user, position) => {
      const loginPayload = await login(user.email, USER_PASSWORD, `platform-load-refresh-${position + 1}`);
      user.token = loginPayload.token;
      user.userId = pickId(loginPayload.user) || user.userId;
      if ((position + 1) % 25 === 0 || position + 1 === usersToRefresh.length) {
        console.log(`[prepare] refreshed ${position + 1}/${usersToRefresh.length} existing user tokens`);
      }
      return user;
    });

    return usersToRefresh;
  };

  if (EXISTING_USERS_FILE && (!TOP_UP_EXISTING_USERS || existingUsers.length >= VUS)) {
    const raw = await fs.readFile(EXISTING_USERS_FILE, 'utf8');
    const loaded = JSON.parse(raw) as LoadUser[];
    console.log(`Loaded ${loaded.length} prepared users from ${EXISTING_USERS_FILE}`);
    const prepared = loaded.slice(0, VUS);
    progress.preparedUsers = prepared.length;
    await refreshExistingUsers(prepared);
    await fs.writeFile(manifestPath, JSON.stringify(prepared, null, 2));
    console.log(`Prepared user manifest: ${manifestPath}`);
    return prepared;
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mobileSeed = String(Date.now()).slice(-5);
  const startingCount = Math.min(existingUsers.length, VUS);
  if (PROD_SAFE_MODE && startingCount < VUS) {
    throw new Error(
      `Prepared user manifest only contains ${startingCount} users, but PLATFORM_LOAD_USERS=${VUS}. ` +
      'Prod-safe mode will not create or top up users.',
    );
  }
  assertMutationAllowed('Creating or topping up platform load users');
  if (startingCount > 0) {
    console.log(`Loaded ${startingCount} prepared users from ${EXISTING_USERS_FILE}; topping up to ${VUS}.`);
  }
  progress.preparedUsers = startingCount;
  await refreshExistingUsers(existingUsers.slice(0, startingCount));
  const indexes = Array.from({ length: Math.max(0, VUS - startingCount) }, (_, index) => startingCount + index);
  const users = await runPool(indexes, SETUP_CONCURRENCY, async (index) => {
    const email = `platform_load_${suffix}_${index}@edumaster.local`;
    if (SETUP_DELAY_MS > 0 && index > 0) {
      await sleep(SETUP_DELAY_MS);
    }
    let signupSucceeded = false;
    let preparedUser: LoadUser | null = null;
    for (let attempt = 0; attempt <= PREPARE_RETRY_MAX; attempt += 1) {
      try {
        const signupPayload = await withAuthPacing(() => request<{ token?: string; user?: Json }>('auth.signup', 'POST', '/auth/register', {
          name: `Platform Load User ${index + 1}`,
          email,
          password: USER_PASSWORD,
          mobileNumber: `9${mobileSeed}${String(index).padStart(4, '0')}`.slice(0, 10),
        }, undefined, email));
        signupSucceeded = true;
        if (signupPayload?.token) {
          preparedUser = {
            index,
            email,
            token: signupPayload.token,
            userId: pickId(signupPayload.user),
            name: `Platform Load User ${index + 1}`,
          };
        }
        break;
      } catch (error) {
        const status = Number((error as { status?: number })?.status || 0);
        if (status === 409 && REUSE_EXISTING_USERS) {
          dropLatestFailureMetric('auth.signup', '/auth/register', email);
          signupSucceeded = true;
          break;
        }
        if (attempt < PREPARE_RETRY_MAX && shouldRetryPrepareError(error)) {
          dropLatestFailureMetric('auth.signup', '/auth/register', email);
          await sleep(500 * (2 ** attempt));
          continue;
        }
        recordIssue({
          severity: 'High',
          whatBroke: 'Signup failed during user preparation',
          where: 'Login / Signup',
          exactErrorMessage: error instanceof Error ? error.message : String(error),
          stepsToReproduce: `Run platform load test with PLATFORM_LOAD_USERS=${VUS}; failing synthetic user index ${index}.`,
          userCountDuringFailure: index + 1,
          apiServerResponse: (error as { payload?: unknown }).payload,
          suggestedFix: 'Check auth validation, unique email handling, password hashing saturation, and database write throughput.',
        });
        throw error;
      }
    }
    if (!signupSucceeded) {
      throw new Error(`Signup did not succeed for ${email}`);
    }
    if (!preparedUser) {
      const loginPayload = await login(email, USER_PASSWORD, `platform-load-${index + 1}`);
      preparedUser = {
        index,
        email,
        token: loginPayload.token,
        userId: pickId(loginPayload.user),
        name: `Platform Load User ${index + 1}`,
      };
    }
    progress.preparedUsers += 1;
    if (progress.preparedUsers % 25 === 0 || progress.preparedUsers === VUS) {
      console.log(`[prepare] ${progress.preparedUsers}/${VUS} users ready`);
    }
    return preparedUser;
  });
  const combinedUsers = [...existingUsers.slice(0, startingCount), ...users].slice(0, VUS);
  await fs.writeFile(manifestPath, JSON.stringify(combinedUsers, null, 2));
  console.log(`Prepared user manifest: ${manifestPath}`);
  return combinedUsers;
};

const runUserJourney = async (
  user: Awaited<ReturnType<typeof prepareUsers>>[number],
  targets: Awaited<ReturnType<typeof createTestData>>,
) => {
  const userLabel = user.email;
  const journeyProfile = getJourneyProfileForUser(user);
  userJourneyProfiles.set(userLabel, journeyProfile.name);
  const journeyStats = ensureJourneyProfileStats(journeyProfile.name);
  journeyStats.assigned += 1;
  let failed = false;
  const shouldLogout = user.index < Math.round(VUS * LOGOUT_FRACTION);
  let courseAccess: CourseAccessSnapshot | null = null;
  const step = async (label: string, fn: () => Promise<unknown>, severity: Issue['severity'] = 'High') => {
    try {
      await fn();
    } catch (error) {
      failed = true;
      recordIssue({
        severity,
        whatBroke: `${label} failed`,
        where: label,
        exactErrorMessage: error instanceof Error ? error.message : String(error),
        stepsToReproduce: `Run the ${loadLabel} load test; failing user ${userLabel}; step ${label}.`,
        userCountDuringFailure: VUS,
        apiServerResponse: (error as { payload?: unknown }).payload,
        suggestedFix: 'Inspect the endpoint contract, server route wiring, DB query latency, request timeout/5xx pattern, and frontend callsite for this feature.',
      });
    }
  };

  try {
    await step('Student Dashboard', () => request('dashboard.overview', 'GET', '/platform/overview', undefined, user.token, userLabel));
    if (journeyProfile.runCourseReads || journeyProfile.runVideoProgress || journeyProfile.runEnroll || journeyProfile.runPdfRead) {
      const courseList = await request<Json[]>('courses.list', 'GET', '/courses', undefined, user.token, userLabel).catch((error) => {
        failed = true;
        recordIssue({
          severity: 'High',
          whatBroke: 'Courses list failed',
          where: 'Courses list',
          exactErrorMessage: error instanceof Error ? error.message : String(error),
          stepsToReproduce: `Run the ${loadLabel} load test; failing user ${userLabel}; step Courses list.`,
          userCountDuringFailure: VUS,
          apiServerResponse: (error as { payload?: unknown }).payload,
          suggestedFix: 'Inspect the courses list API contract, auth state, and backend latency.',
        });
        return null;
      });
      const listedCourse = Array.isArray(courseList)
        ? courseList.find((entry) => pickId(entry) === targets.courseId) || courseList[0] || null
        : null;
      courseAccess = buildCourseAccessSnapshot(listedCourse, targets.courseId);

      const courseDetail = await request('courses.detail', 'GET', `/courses/${targets.courseId}`, undefined, user.token, userLabel)
        .catch(() => null);
      courseAccess = buildCourseAccessSnapshot(courseDetail, targets.courseId) || courseAccess;

      await step('Course lessons', () => request('courses.lessons', 'GET', `/courses/${targets.courseId}/lessons`, undefined, user.token, userLabel));
    }

    const canAccessCourse = Boolean(courseAccess?.canAccessCourse);

    if (ENABLE_ENROLL && journeyProfile.runEnroll) {
      if (canAccessCourse) {
        await step('Course enroll', () => request('course.enroll', 'POST', '/platform/enroll', {
          courseId: targets.courseId,
          source: 'load-test',
        }, user.token, userLabel));
      } else {
        metrics.push({
          name: 'course.enroll.skipped',
          method: 'POST',
          path: '/platform/enroll',
          status: 0,
          ok: true,
          durationMs: 0,
          user: userLabel,
          clientProfile: getClientProfile(userLabel).name,
          journeyProfile: journeyProfile.name,
        });
      }
    }

    if (ENABLE_VIDEO_PROGRESS && journeyProfile.runVideoProgress && canAccessCourse && targets.lessonId) {
      await step('Recorded video watch progress 25%', () => request('recorded.watchProgress.25', 'POST', '/platform/watch-progress', {
        courseId: targets.courseId,
        lessonId: targets.lessonId,
        progressPercent: 25,
        progressSeconds: 450,
        completed: false,
      }, user.token, userLabel));
      await step('Recorded video watch progress 100%', () => request('recorded.watchProgress.100', 'POST', '/platform/watch-progress', {
        courseId: targets.courseId,
        lessonId: targets.lessonId,
        progressPercent: 100,
        progressSeconds: 1800,
        completed: true,
      }, user.token, userLabel));
    }

    if (journeyProfile.runPdfRead) {
      if (!PDF_ATTACHMENT_ID) {
        await step('Protected PDF read precondition', async () => {
          throw new Error('PLATFORM_LOAD_PDF_ATTACHMENT_ID is required for the pdf_read journey.');
        });
      } else if (canAccessCourse) {
        await step('Course detail for PDF reader', () => request('courses.detail.pdf-reader', 'GET', `/courses/${targets.courseId}`, undefined, user.token, userLabel));
        await step('Protected PDF open first chunk', () => requestPdfPartial(
          'course.pdf.range_open',
          `/courses/${targets.courseId}/pdf-attachments/${encodeURIComponent(PDF_ATTACHMENT_ID)}/view`,
          user.token,
          userLabel,
          0,
          PDF_RANGE_BYTES - 1,
        ));
        await step('Protected PDF follow-up chunk', () => requestPdfPartial(
          'course.pdf.range_followup',
          `/courses/${targets.courseId}/pdf-attachments/${encodeURIComponent(PDF_ATTACHMENT_ID)}/view`,
          user.token,
          userLabel,
          PDF_RANGE_BYTES,
          (PDF_RANGE_BYTES * 2) - 1,
        ));
      } else {
        metrics.push({
          name: 'course.pdf.skipped',
          method: 'GET',
          path: `/courses/${targets.courseId}/pdf-attachments/${encodeURIComponent(PDF_ATTACHMENT_ID || 'missing')}/view`,
          status: 0,
          ok: true,
          durationMs: 0,
          user: userLabel,
          clientProfile: getClientProfile(userLabel).name,
          journeyProfile: journeyProfile.name,
        });
      }
    }

    if (journeyProfile.runTestReads) {
      await step('Mock tests list', () => request('tests.list', 'GET', '/tests', undefined, user.token, userLabel));
      if (targets.testId) {
        await step('Mock test detail', () => request('tests.detail', 'GET', `/tests/${targets.testId}`, undefined, user.token, userLabel));
        if (journeyProfile.runTestSubmit) {
          await step('Mock test submit', () => request('tests.submit', 'POST', `/tests/${targets.testId}/submit`, {
            startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            answers: {
              q1: user.index % 4,
              q2: (user.index + 1) % 4,
              q3: (user.index + 2) % 4,
            },
          }, user.token, userLabel));
        }
      }
    }

    if (journeyProfile.runUserInsights) {
      await step('Leaderboard', () => request('analytics.leaderboard', 'GET', '/analytics/leaderboard', undefined, user.token, userLabel));
    }
    if (ENABLE_PAYMENT_CHECKOUT && journeyProfile.runPaymentCheckout) {
      await step('Payment checkout', () => request('payment.checkout', 'POST', '/payment/checkout', {
        amount: 199,
        currency: 'INR',
        item: 'Production load access check',
      }, user.token, userLabel), 'Medium');
    }
    if (ENABLE_LIVE && journeyProfile.runLiveReads) {
      await step('Live classes list', () => request('live.list', 'GET', '/live-classes', undefined, user.token, userLabel));
    }
    if (ENABLE_LIVE && journeyProfile.runLiveWrites && targets.liveClassId) {
      await step('Live access', () => request('live.access', 'GET', `/live-classes/${targets.liveClassId}/access`, undefined, user.token, userLabel));
      await step('Live join', () => request('live.session.join', 'POST', `/live-classes/${targets.liveClassId}/session/join`, {}, user.token, userLabel));
      await step('Live chat send', () => request('live.chat.send', 'POST', `/live-classes/${targets.liveClassId}/chat`, {
        message: `Load chat ${user.index}`,
        kind: 'chat',
      }, user.token, userLabel));
      await step('Live heartbeat', () => request('live.session.heartbeat', 'POST', `/live-classes/${targets.liveClassId}/session/heartbeat`, {}, user.token, userLabel));
      await step('Live media update', () => request('live.session.media', 'POST', `/live-classes/${targets.liveClassId}/session/media`, {
        micMuted: user.index % 2 === 0,
        videoEnabled: user.index % 5 === 0,
        isScreenSharing: false,
      }, user.token, userLabel));
      await step('Live raise hand', () => request('live.session.raiseHand', 'POST', `/live-classes/${targets.liveClassId}/session/raise-hand`, {
        raised: user.index % 10 === 0,
      }, user.token, userLabel));
      await step('Live chat list', () => request('live.chat.list', 'GET', `/live-classes/${targets.liveClassId}/chat`, undefined, user.token, userLabel));
    }
    if (journeyProfile.runNotifications) {
      await step('Notifications list', () => request('notifications.list', 'GET', '/notifications', undefined, user.token, userLabel));
    }
    if (journeyProfile.runProfileRead) {
      await step('Profile get', () => request('profile.get', 'GET', '/users/profile', undefined, user.token, userLabel));
    }
    if (ENABLE_PROFILE_UPDATE && journeyProfile.runProfileUpdate) {
      await step('Profile update', () => request('profile.update', 'PATCH', '/users/profile', {
        name: user.name,
        email: user.email,
        mobileNumber: `91111${String(user.index).padStart(5, '0')}`,
      }, user.token, userLabel));
    }
    if (journeyProfile.runUserInsights) {
      await step('User progress', () => request('user.progress', 'GET', '/users/progress', undefined, user.token, userLabel));
      await step('User analytics', () => request('user.analytics', 'GET', '/users/analytics', undefined, user.token, userLabel));
    }
    if (journeyProfile.runLiveWrites && targets.liveClassId) {
      await step('Live leave', () => request('live.session.leave', 'POST', `/live-classes/${targets.liveClassId}/session/leave`, {}, user.token, userLabel));
    }
    await step('Auth session', () => request('auth.session', 'GET', '/auth/session', undefined, user.token, userLabel));
    if (shouldLogout) {
      await step('Auth logout', () => request('auth.logout', 'POST', '/auth/logout', {}, user.token, userLabel));
      await step('Auth relogin', () => login(user.email, USER_PASSWORD, `platform-load-relogin-${user.index + 1}`));
      progress.logoutJourneys += 1;
    } else {
      await step('Auth keep-alive', () => request('auth.session.keepalive', 'GET', '/auth/session', undefined, user.token, userLabel), 'Medium');
      progress.keptActiveJourneys += 1;
    }
    progress.completedJourneys += 1;
    journeyStats.completed += 1;
    if (!failed) {
      progress.successfulJourneys += 1;
      journeyStats.successful += 1;
    } else {
      journeyStats.failed += 1;
    }
    if (progress.completedJourneys % 25 === 0 || progress.completedJourneys === VUS) {
      console.log(`[active] ${progress.completedJourneys}/${VUS} journeys complete; success=${progress.successfulJourneys}; failures=${progress.completedJourneys - progress.successfulJourneys}`);
    }
    return !failed;
  } catch (error) {
    recordIssue({
      severity: 'High',
      whatBroke: 'Full user journey failed',
      where: 'Concurrent journey',
      exactErrorMessage: error instanceof Error ? error.message : String(error),
      stepsToReproduce: `Run the ${loadLabel} load test; failing user ${userLabel}.`,
      userCountDuringFailure: VUS,
      apiServerResponse: (error as { payload?: unknown }).payload,
      suggestedFix: 'Inspect the named endpoint metric, server logs, DB locks, session conflicts, and request timeout/5xx pattern for this user.',
    });
    progress.completedJourneys += 1;
    journeyStats.completed += 1;
    journeyStats.failed += 1;
    return false;
  }
};

const summarizeByName = () => {
  const grouped = new Map<string, Metric[]>();
  for (const metric of metrics) {
    grouped.set(metric.name, [...(grouped.get(metric.name) || []), metric]);
  }
  return Array.from(grouped.entries()).map(([name, rows]) => {
    const durations = rows.map((row) => row.durationMs);
    const failures = rows.filter((row) => !row.ok);
    return {
      name,
      requests: rows.length,
      failures: failures.length,
      successRate: rows.length ? Number((((rows.length - failures.length) / rows.length) * 100).toFixed(2)) : 0,
      avgMs: average(durations),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      maxMs: durations.length ? Math.max(...durations) : 0,
      statuses: rows.reduce<Record<string, number>>((acc, row) => {
        acc[String(row.status)] = (acc[String(row.status)] || 0) + 1;
        return acc;
      }, {}),
      sampleErrors: failures.slice(0, 5).map((row) => row.error || `${row.status}`),
    };
  }).sort((left, right) => right.p95Ms - left.p95Ms);
};

const smokeRoute = async (route: string) => {
  const started = performance.now();
  const response = await qaFetch(`${apiOrigin}${route}`);
  await response.text();
  return {
    route,
    status: response.status,
    durationMs: Math.round(performance.now() - started),
    ok: response.ok,
  };
};

const writeReports = async (summary: Json) => {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'full-automation-test-report.json'), JSON.stringify(summary, null, 2));
  const journeyProfileRows = ((summary.journeyProfileBreakdown as Json[] | undefined) || [])
    .map((row) => `- ${row.label} (${row.name}): assigned ${row.assigned}, successful ${row.successful}, failed ${row.failed}, target ${row.targetPercent ?? 'n/a'}%`)
    .join('\n') || 'No journey-profile breakdown captured.';
  const clientProfileRows = Object.entries((summary.clientProfileBreakdown as Record<string, number> | undefined) || {})
    .map(([name, count]) => `- ${name}: ${count}`)
    .join('\n') || 'No client-profile breakdown captured.';
  const endpointRows = (summary.endpointSummary as Json[]).map((row) =>
    `| ${row.name} | ${row.requests} | ${row.successRate}% | ${row.avgMs} | ${row.p95Ms} | ${row.p99Ms} | ${row.maxMs} | ${JSON.stringify(row.statuses)} |`,
  ).join('\n');
  const issueRows = issues.length
    ? issues.map((issue, index) =>
      `### ${index + 1}. ${issue.severity}: ${issue.whatBroke}\n- Where: ${issue.where}\n- Error: ${issue.exactErrorMessage}\n- Users: ${issue.userCountDuringFailure}\n- Repro: ${issue.stepsToReproduce}\n- Suggested fix: ${issue.suggestedFix}`,
    ).join('\n\n')
    : 'No API/journey failures were captured by this run.';

  const markdown = `# ${VUS}-User Platform QA Report

Run: ${runId}

## Scope
- Users requested: ${VUS}
- Active journey concurrency: ${ACTIVE_CONCURRENCY}
- Setup concurrency: ${SETUP_CONCURRENCY}
- Base URL: ${apiOrigin}
- Traffic model: ${summary.trafficModel}
- Modules covered: ${coveredModules.join(', ')}
- Modules skipped by configuration: ${skippedModules.length ? skippedModules.join(', ') : 'None'}

## Traffic Breakdown
${journeyProfileRows}

## Client Profile Breakdown
${clientProfileRows}

## Environment
- Host: ${os.hostname()}
- CPU cores visible to Node: ${os.cpus().length}
- Memory total: ${Math.round(os.totalmem() / 1024 / 1024)} MB
- Node: ${process.version}

## Load/Stress Summary
- Total requests: ${summary.totalRequests}
- Failed requests: ${summary.failedRequests}
- Successful journeys: ${summary.successfulJourneys}/${VUS}
- Wall clock: ${summary.wallClockMs} ms
- Peak heap used: ${summary.peakHeapUsedMb} MB
- RSS after run: ${summary.finalRssMb} MB

## Endpoint Performance
| Endpoint | Requests | Success | Avg ms | P95 ms | P99 ms | Max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
${endpointRows}

## Bug Report
${issueRows}

## Crash Report
${summary.crashed ? 'Run crashed before completion.' : 'No runner crash captured.'}

## Failed API Report
${(summary.endpointSummary as Json[]).filter((row) => Number(row.failures) > 0).map((row) => `- ${row.name}: ${row.failures} failures, statuses ${JSON.stringify(row.statuses)}, sample ${JSON.stringify(row.sampleErrors)}`).join('\n') || 'No failed API groups captured.'}

## Route Smoke
${((summary.routeSmokes as Array<{ route: string; status: number; ok: boolean }> | undefined) || [])
  .map((item) => `- ${item.route}: ${item.status} (${item.ok ? 'ok' : 'failed'})`)
  .join('\n') || 'No route smoke details captured.'}

## UI/UX Issue Report
This run performs route smoke checks, not ${VUS} real browser sessions. Existing Puppeteer module tests should be run separately for visual proof because ${VUS} concurrent browsers on this local machine would invalidate performance numbers.

## Database Performance Report
Database-backed paths exercised in this run: login/session, course reads, test list reads, notifications, profile reads, and route smoke. Use the endpoint P95/P99 table as the DB/API bottleneck proxy for this local run.

## Scalability Recommendations
- Re-run this script against a production-like environment with isolated Postgres metrics, Redis/session backing, and observability enabled.
- Move live session and chat fan-out to Redis/pubsub or a managed realtime layer before relying on multi-instance scaling.
- Add dedicated k6/Artillery streaming tests for real video/audio media servers; this API test does not prove media-plane quality.
- Add DB indexes for high-volume attempt, notification, enrollment, and session queries if p95/p99 grows under this run.
- Use queueing/backpressure for broadcast notifications and analytics aggregation.
`;

  await fs.writeFile(path.join(reportDir, 'full-automation-test-report.md'), markdown);
};

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Admin credentials required. Set QA_ADMIN_EMAIL/QA_ADMIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD.');
  }
  if (PROD_SAFE_MODE) {
    if (PREPARE_ONLY) {
      throw new Error('PLATFORM_LOAD_PREPARE_ONLY is not allowed when QA_CERT_MODE=prod_safe_existing_data_only.');
    }
    if (ENABLE_ENROLL) {
      throw new Error('PLATFORM_LOAD_ENABLE_ENROLL is not allowed when QA_CERT_MODE=prod_safe_existing_data_only.');
    }
    if (ENABLE_PROFILE_UPDATE) {
      throw new Error('PLATFORM_LOAD_ENABLE_PROFILE_UPDATE is not allowed when QA_CERT_MODE=prod_safe_existing_data_only.');
    }
    if (ENABLE_PAYMENT_CHECKOUT) {
      throw new Error('PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT is not allowed when QA_CERT_MODE=prod_safe_existing_data_only.');
    }
    if (ENABLE_LIVE) {
      throw new Error('PLATFORM_LOAD_ENABLE_LIVE is not allowed when QA_CERT_MODE=prod_safe_existing_data_only.');
    }
    if (TRAFFIC_MODEL === 'full_journey' || TRAFFIC_MODEL === '5k_mixed') {
      throw new Error(
        'Use PLATFORM_LOAD_TRAFFIC_MODEL=streaming_pdf_mixed when QA_CERT_MODE=prod_safe_existing_data_only. ' +
        'The other traffic models include mutating flows.',
      );
    }
  }
  if (TRAFFIC_MODEL === 'streaming_pdf_mixed' && !PDF_ATTACHMENT_ID) {
    throw new Error('PLATFORM_LOAD_PDF_ATTACHMENT_ID is required for PLATFORM_LOAD_TRAFFIC_MODEL=streaming-pdf-mixed.');
  }
  if (requiresTestReadTarget && !EXISTING_TEST_ID) {
    throw new Error('PLATFORM_LOAD_TEST_ID is required for PLATFORM_LOAD_TRAFFIC_MODEL=streaming-pdf-mixed.');
  }

  const runStarted = performance.now();
  const memorySamples: NodeJS.MemoryUsage[] = [];
  const sampler = setInterval(() => memorySamples.push(process.memoryUsage()), 1000);
  const partialSampler = setInterval(() => {
    writePartialReport('interval').catch((error) => {
      console.error(`Unable to write partial report: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, PARTIAL_REPORT_INTERVAL_MS);

  const stopRequested = async (signal: string) => {
    progress.phase = `interrupted:${signal}`;
    await writePartialReport(`interrupted by ${signal}`).catch(() => undefined);
    process.exit(130);
  };
  process.once('SIGINT', () => { void stopRequested('SIGINT'); });
  process.once('SIGTERM', () => { void stopRequested('SIGTERM'); });

  try {
    await fs.mkdir(reportDir, { recursive: true });
    progress.phase = 'health-check';
    await request('health.api', 'GET', '/health').catch(() => undefined);
    progress.phase = 'admin-login';
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD, 'platform-load-admin');
    progress.phase = 'test-data';
    const targets = await createTestData(admin.token);
    progress.phase = EXISTING_USERS_FILE ? 'load-user-manifest' : 'prepare-users';
    const users = await prepareUsers();
    const clientProfileBreakdown = summarizeClientProfiles(users);

    if (PREPARE_ONLY) {
      progress.phase = 'prepare-only-complete';
      const finalMemory = process.memoryUsage();
      const summary = {
        runId,
        baseUrl: apiOrigin,
        apiBase,
        certificationMode: certificationModeSummary(),
        trafficModel: TRAFFIC_MODEL,
        journeyProfileTargets,
        journeyProfileBreakdown: summarizeJourneyProfiles(),
        clientProfileBreakdown,
        usersRequested: VUS,
        setupConcurrency: SETUP_CONCURRENCY,
        activeConcurrency: ACTIVE_CONCURRENCY,
        preparedUsers: users.length,
        totalRequests: metrics.length,
        failedRequests: metrics.filter((metric) => !metric.ok).length,
        wallClockMs: Math.round(performance.now() - runStarted),
        endpointSummary: summarizeByName(),
        issues,
        crashed: false,
        finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
        peakHeapUsedMb: Math.round(finalMemory.heapUsed / 1024 / 1024),
        artifacts: {
          reportDir,
          json: path.join(reportDir, 'full-automation-test-report.json'),
          markdown: path.join(reportDir, 'full-automation-test-report.md'),
          manifest: manifestPath,
        },
        note: `Prepare-only mode completed for traffic model ${TRAFFIC_MODEL}. No concurrent student journeys were executed.`,
      };
      await writeReports(summary);
      console.log(JSON.stringify({
        prepareOnly: true,
        manifestPath,
        preparedUsers: users.length,
        totalRequests: metrics.length,
        failedRequests: metrics.filter((metric) => !metric.ok).length,
      }, null, 2));
      return;
    }

    progress.phase = 'route-smoke';
    const routeSmokes = await Promise.all([
      '/',
      '/?tab=courses',
      '/?tab=live',
      '/?tab=tests',
      '/?tab=profile',
    ].map(smokeRoute));

    progress.phase = `active-${VUS}-simultaneous-journeys`;
    const journeyStarted = performance.now();
    const journeyResults = await runPool(users, ACTIVE_CONCURRENCY, (user) => {
      progress.startedJourneys += 1;
      if (progress.startedJourneys % 100 === 0 || progress.startedJourneys === users.length) {
        console.log(`[active] started ${progress.startedJourneys}/${users.length} journeys`);
      }
      return runUserJourney(user, targets);
    });
    const journeyWallClockMs = Math.round(performance.now() - journeyStarted);
    const successfulJourneys = journeyResults.filter(Boolean).length;
    progress.phase = 'reporting';

    const endpointSummary = summarizeByName();
    const finalMemory = process.memoryUsage();
    const peakHeapUsedMb = Math.round(Math.max(finalMemory.heapUsed, ...memorySamples.map((sample) => sample.heapUsed)) / 1024 / 1024);
    const summary = {
      runId,
      baseUrl: apiOrigin,
      apiBase,
      certificationMode: certificationModeSummary(),
      trafficModel: TRAFFIC_MODEL,
      journeyProfileTargets,
      journeyProfileBreakdown: summarizeJourneyProfiles(),
      clientProfileBreakdown,
      usersRequested: VUS,
      setupConcurrency: SETUP_CONCURRENCY,
      activeConcurrency: ACTIVE_CONCURRENCY,
      successfulJourneys,
      failedJourneys: VUS - successfulJourneys,
      totalRequests: metrics.length,
      failedRequests: metrics.filter((metric) => !metric.ok).length,
      wallClockMs: Math.round(performance.now() - runStarted),
      journeyWallClockMs,
      logoutJourneys: progress.logoutJourneys,
      keptActiveJourneys: progress.keptActiveJourneys,
      endpointSummary,
      routeSmokes,
      issues,
      crashed: false,
      finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
      peakHeapUsedMb,
      artifacts: {
        reportDir,
        json: path.join(reportDir, 'full-automation-test-report.json'),
        markdown: path.join(reportDir, 'full-automation-test-report.md'),
      },
      note: `This is a local API/load automation run for traffic model ${TRAFFIC_MODEL}. It validates ${loadLabel} API-backed journeys and route smoke checks, not true ${VUS}-device video/audio quality.`,
    };
    await writeReports(summary);
    console.log(JSON.stringify({
      reportDir,
      users: VUS,
      successfulJourneys,
      failedJourneys: VUS - successfulJourneys,
      totalRequests: metrics.length,
      failedRequests: metrics.filter((metric) => !metric.ok).length,
      journeyWallClockMs,
      slowestP95: endpointSummary.slice(0, 8),
    }, null, 2));

    if (successfulJourneys !== VUS || metrics.some((metric) => !metric.ok)) {
      process.exitCode = 1;
    }
  } catch (error) {
    progress.phase = 'crashed';
    const finalMemory = process.memoryUsage();
    const summary = {
      runId,
      baseUrl: apiOrigin,
      trafficModel: TRAFFIC_MODEL,
      journeyProfileTargets,
      journeyProfileBreakdown: summarizeJourneyProfiles(),
      usersRequested: VUS,
      totalRequests: metrics.length,
      failedRequests: metrics.filter((metric) => !metric.ok).length,
      endpointSummary: summarizeByName(),
      issues,
      crashed: true,
      crash: error instanceof Error ? error.stack || error.message : String(error),
      finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
      peakHeapUsedMb: Math.round(finalMemory.heapUsed / 1024 / 1024),
    };
    await writeReports(summary);
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  } finally {
    clearInterval(sampler);
    clearInterval(partialSampler);
  }
};

main();
