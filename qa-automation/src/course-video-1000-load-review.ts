import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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
  recordedAt: string;
  user?: string;
  userId?: string | null;
  courseId?: string;
  lessonId?: string;
  soakMinute?: number;
  tickIndex?: number;
  endpointKind?: string;
  phase?: string;
  retryAttempt?: number;
  clientProfile?: string;
  bytes?: number;
  worker?: string | null;
  cacheStatus?: string | null;
  cacheDetail?: string | null;
  cacheKey?: string | null;
  upstreamResponseTime?: string | null;
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

type PlayerPayload = {
  playerType?: string;
  streamUrl?: string | null;
  streamFormat?: string | null;
  playbackStatus?: string | null;
  tokenExpiresAt?: string | null;
};

type PlayerBootstrap = {
  player: PlayerPayload;
  playbackGrantCookie: string | null;
};

type LessonBootstrapPayload = {
  course?: {
    _id?: string;
    title?: string;
  } | null;
  lessons?: Array<{
    id?: string;
    _id?: string;
    title?: string;
  }>;
  lesson?: {
    id?: string;
    _id?: string;
    title?: string;
  } | null;
  player?: PlayerPayload | null;
};

type CourseAssignment = {
  courseId: string;
  lessonId: string;
  weight: number;
  label: string;
  source: 'hot-course' | 'mixed-course';
};

type WatchTickTelemetry = {
  tickIndex: number;
  expectedCurrentTimeSeconds: number;
  heartbeatOk: boolean;
  progressPersisted: boolean;
  masterManifestMs: number | null;
  mediaManifestMs: number | null;
  segmentWindowMs: number | null;
  segmentRequests: number;
  interrupted: boolean;
  interruptionReason?: string;
  authRefreshed: boolean;
  qualitySwitchTriggered: boolean;
  bufferingSeconds: number;
  retryCount: number;
  reconnectCount: number;
  stallDetected: boolean;
};

type UserJourneyTelemetry = {
  user: string;
  assignment: CourseAssignment;
  startedAt: string;
  completedAt?: string;
  watchDurationSeconds: number;
  heartbeatCount: number;
  progressWriteCount: number;
  manifestRefreshCount: number;
  segmentWindowCount: number;
  interruptions: number;
  reconnectCount: number;
  retryCount: number;
  authRefreshCount: number;
  qualitySwitchCount: number;
  stallCount: number;
  freezeCount: number;
  bufferingSeconds: number;
  playbackSecondsAdvanced: number;
  completed: boolean;
  ticks: WatchTickTelemetry[];
};

type ResourceTelemetrySample = {
  recordedAt: string;
  source: string;
  output: string;
};

type FailureInjection = {
  name: string;
  command: string;
  delayMs: number;
};

type RequestContext = {
  user?: string;
  userId?: string | null;
  courseId?: string;
  lessonId?: string;
  soakSecond?: number;
  tickIndex?: number;
  endpointKind?: string;
  phase?: string;
  retryAttempt?: number;
};

type FailureAttribution = {
  recordedAt: string;
  minuteOfSoak: number;
  endpoint: string;
  method: string;
  path: string;
  statusCode: number;
  category: 'timeout' | 'upstream-error' | 'auth-failure' | 'network-abort' | 'client-error' | 'unknown';
  durationMs: number;
  retryAttempt: number;
  user: string | null;
  userId: string | null;
  courseId: string | null;
  lessonId: string | null;
  worker: string | null;
  cacheStatus: string | null;
  cacheDetail: string | null;
  cacheKey: string | null;
  upstreamResponseTime: string | null;
  phase: string | null;
  endpointKind: string | null;
  tickIndex: number | null;
  errorMessage: string;
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
const require = createRequire(import.meta.url);
const REPORT_PREFIX = (process.env.COURSE_LOAD_REPORT_PREFIX || 'course-video-1000').trim() || 'course-video-1000';
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

const VUS = Math.max(1, Number(process.env.COURSE_LOAD_USERS || 1000));
const SETUP_CONCURRENCY = Math.max(1, Number(process.env.COURSE_LOAD_SETUP_CONCURRENCY || 50));
const ACTIVE_CONCURRENCY = Math.max(1, Number(process.env.COURSE_LOAD_ACTIVE_CONCURRENCY || VUS));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.COURSE_LOAD_TIMEOUT_MS || 30000));
const USER_PASSWORD = process.env.COURSE_LOAD_USER_PASSWORD || 'Student@123';
const EXISTING_USERS_FILE = process.env.COURSE_LOAD_USERS_FILE || '';
const PREPARE_ONLY = ['1', 'true', 'yes', 'on'].includes(String(process.env.COURSE_LOAD_PREPARE_ONLY || '').toLowerCase());
const REFRESH_EXISTING_USER_TOKENS = String(process.env.COURSE_LOAD_REFRESH_EXISTING_USER_TOKENS || 'true').toLowerCase() !== 'false';
const PARTIAL_REPORT_INTERVAL_MS = Math.max(5000, Number(process.env.COURSE_LOAD_PARTIAL_REPORT_MS || 30000));
const COURSE_ID = process.env.COURSE_LOAD_COURSE_ID || 'course_1899470118af44b4b9447b35fd296761';
const LESSON_ID = process.env.COURSE_LOAD_LESSON_ID || 'video_1778758229576';
const SEGMENTS_PER_USER = Math.max(1, Number(process.env.COURSE_LOAD_SEGMENTS_PER_USER || 3));
const SAMPLE_USERS_FOR_BROWSER = Math.max(1, Number(process.env.COURSE_LOAD_BROWSER_SAMPLE_USERS || 3));
const PREPARE_RETRY_ATTEMPTS = Math.max(1, Number(process.env.COURSE_LOAD_PREPARE_RETRY_ATTEMPTS || 4));
const PREPARE_RETRY_BACKOFF_MS = Math.max(250, Number(process.env.COURSE_LOAD_PREPARE_RETRY_BACKOFF_MS || 1500));
const WATCH_MODE = String(process.env.COURSE_LOAD_WATCH_MODE || '').toLowerCase() === 'sustained';
const WATCH_DURATION_SECONDS = Math.max(30, Number(process.env.COURSE_LOAD_WATCH_DURATION_SECONDS || 3600));
const WATCH_HEARTBEAT_SECONDS = Math.max(5, Number(process.env.COURSE_LOAD_WATCH_HEARTBEAT_SECONDS || 10));
const WATCH_PROGRESS_INTERVAL_SECONDS = Math.max(10, Number(process.env.COURSE_LOAD_WATCH_PROGRESS_INTERVAL_SECONDS || 15));
const WATCH_MANIFEST_REFRESH_INTERVAL_SECONDS = Math.max(10, Number(process.env.COURSE_LOAD_WATCH_MANIFEST_REFRESH_INTERVAL_SECONDS || process.env.COURSE_LOAD_MANIFEST_REFRESH_INTERVAL_SECONDS || 60));
const WATCH_SEGMENT_WINDOW_SIZE = Math.max(1, Number(process.env.COURSE_LOAD_WATCH_SEGMENT_WINDOW_SIZE || 2));
const WATCH_QUALITY_SWITCH_INTERVAL_SECONDS = Math.max(0, Number(process.env.COURSE_LOAD_WATCH_QUALITY_SWITCH_INTERVAL_SECONDS || 300));
const WATCH_AUTH_REFRESH_INTERVAL_SECONDS = Math.max(0, Number(process.env.COURSE_LOAD_WATCH_AUTH_REFRESH_INTERVAL_SECONDS || 900));
const WATCH_ALLOW_REAL_SLEEP = process.env.COURSE_LOAD_WATCH_ALLOW_REAL_SLEEP == null
  ? WATCH_MODE
  : ['1', 'true', 'yes', 'on'].includes(String(process.env.COURSE_LOAD_WATCH_ALLOW_REAL_SLEEP || '').toLowerCase());
const WATCH_INTERVAL_JITTER_SECONDS = Math.max(0, Number(process.env.COURSE_LOAD_WATCH_INTERVAL_JITTER_SECONDS || 12));
const WATCH_START_JITTER_SECONDS = Math.max(0, Number(process.env.COURSE_LOAD_WATCH_START_JITTER_SECONDS || 25));
const WATCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.COURSE_LOAD_WATCH_RETRY_ATTEMPTS || 3));
const WATCH_RETRY_BACKOFF_MS = Math.max(250, Number(process.env.COURSE_LOAD_WATCH_RETRY_BACKOFF_MS || 1500));
const WATCH_PROGRESS_MIN_DELTA_SECONDS = Math.max(15, Number(process.env.COURSE_LOAD_WATCH_PROGRESS_MIN_DELTA_SECONDS || 180));
const USE_LESSON_BOOTSTRAP = String(process.env.COURSE_LOAD_USE_LESSON_BOOTSTRAP || 'true').toLowerCase() !== 'false';
const ENROLL_ON_START = ['1', 'true', 'yes', 'on'].includes(String(process.env.COURSE_LOAD_ENROLL_ON_START || '').toLowerCase());
const LOCAL_ENROLL_ON_START = String(process.env.COURSE_LOAD_LOCAL_ENROLL || '').toLowerCase() !== 'false'
  && /127\.0\.0\.1|localhost/.test(apiOrigin);
const MIXED_ADDITIONAL_ASSIGNMENTS_JSON = String(process.env.COURSE_LOAD_MIXED_ASSIGNMENTS_JSON || '').trim();
const HOT_COURSE_PERCENT = Math.max(0, Math.min(100, Number(process.env.COURSE_LOAD_HOT_COURSE_PERCENT || 95)));
const RESOURCE_TELEMETRY_COMMAND = String(process.env.COURSE_LOAD_RESOURCE_COMMAND || '').trim();
const RESOURCE_TELEMETRY_INTERVAL_SECONDS = Math.max(10, Number(process.env.COURSE_LOAD_RESOURCE_INTERVAL_SECONDS || 60));
const FAILURE_INJECTIONS_JSON = String(process.env.COURSE_LOAD_FAILURE_INJECTIONS_JSON || '').trim();
const loadLabel = `${VUS}-user course/video`;
const PROD_SAFE_MODE = isProdSafeExistingDataMode();

const metrics: Metric[] = [];
const issues: Issue[] = [];
const journeyTelemetry: UserJourneyTelemetry[] = [];
const activeJourneyTelemetry = new Map<string, UserJourneyTelemetry>();
const resourceTelemetry: ResourceTelemetrySample[] = [];
const failureAttribution: FailureAttribution[] = [];
const progress = {
  phase: 'initializing',
  preparedUsers: 0,
  startedJourneys: 0,
  completedJourneys: 0,
  successfulJourneys: 0,
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

const deterministicFraction = (seed: string) => {
  let hash = 0;
  for (const char of seed) {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    hash |= 0;
  }
  return (Math.abs(hash) % 1000) / 1000;
};

const computeJitterSeconds = (seed: string, maxSeconds: number) =>
  maxSeconds <= 0 ? 0 : Math.round(deterministicFraction(seed) * maxSeconds);

const classifyFailure = (status: number, message: string): FailureAttribution['category'] => {
  const lower = message.toLowerCase();
  if (lower.includes('aborted') || lower.includes('timeout') || lower.includes('timed out')) {
    return 'timeout';
  }
  if (status === 401 || status === 403) {
    return 'auth-failure';
  }
  if (status >= 500) {
    return 'upstream-error';
  }
  if (status >= 400) {
    return 'client-error';
  }
  if (lower.includes('fetch failed') || lower.includes('network')) {
    return 'network-abort';
  }
  return 'unknown';
};

const groupCount = <T>(items: T[], keyFn: (item: T) => string) => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count);
};

const getAllTelemetry = () => [...journeyTelemetry, ...activeJourneyTelemetry.values()];

const buildJourneyTelemetrySummary = () => {
  const allTelemetry = getAllTelemetry();
  return {
    usersTracked: allTelemetry.length,
    averagePlaybackSeconds: average(allTelemetry.map((item) => item.playbackSecondsAdvanced)),
    interruptions: allTelemetry.reduce((sum, item) => sum + item.interruptions, 0),
    reconnects: allTelemetry.reduce((sum, item) => sum + item.reconnectCount, 0),
    retries: allTelemetry.reduce((sum, item) => sum + item.retryCount, 0),
    authRefreshes: allTelemetry.reduce((sum, item) => sum + item.authRefreshCount, 0),
    qualitySwitches: allTelemetry.reduce((sum, item) => sum + item.qualitySwitchCount, 0),
    stalls: allTelemetry.reduce((sum, item) => sum + item.stallCount, 0),
    freezes: allTelemetry.reduce((sum, item) => sum + item.freezeCount, 0),
    bufferingSeconds: allTelemetry.reduce((sum, item) => sum + item.bufferingSeconds, 0),
    completedWatchers: allTelemetry.filter((item) => item.completed).length,
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const pickId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  const direct = item._id || item.id;
  return direct ? String(direct) : null;
};

const enrollUserLocally = async (userId: string, courseId: string) => {
  const repositories = require(path.resolve(rootDir, '../backend/lib/repositories.js'));
  const platformRepository = repositories.platformRepository || repositories.default?.platformRepository;
  if (!platformRepository) {
    throw new Error('Local enrollment repositories are unavailable.');
  }

  await platformRepository.enroll({
    userId,
    courseId,
    source: 'course-video-load-review',
    accessType: 'course',
  });
};

const enrollUserForCourse = async (token: string, user: LoadUser, courseId: string, userLabel: string) => {
  if (LOCAL_ENROLL_ON_START && user.userId) {
    await enrollUserLocally(user.userId, courseId);
    return { local: true };
  }

  return request('course.enroll', 'POST', '/platform/enroll', {
    courseId,
    source: 'load-test',
  }, token, userLabel);
};

const getClientProfile = (user?: string) => {
  const index = Number(String(user || '').match(/_(\d+)@/)?.[1] || 0);
  if (index % 3 === 1) {
    return {
      name: 'mobile-ios-safari',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      app: 'web',
      platform: 'ios',
      browser: 'safari',
    };
  }
  if (index % 3 === 2) {
    return {
      name: 'android-app',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
      app: 'native',
      platform: 'android',
      browser: 'android-webview',
    };
  }
  return {
    name: 'desktop-windows-edge',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    app: 'web',
    platform: 'windows',
    browser: 'edge',
  };
};

const buildClientHeaders = (clientProfile: ReturnType<typeof getClientProfile>, user?: string, token?: string) => ({
  'user-agent': clientProfile.userAgent,
  'x-qa-client-profile': clientProfile.name,
  'x-edumaster-app': clientProfile.app,
  'x-edumaster-client-platform': clientProfile.platform,
  'x-edumaster-client-browser': clientProfile.browser,
  'x-edumaster-device-id': `course-load-${clientProfile.platform}-${Buffer.from(String(user || 'anonymous')).toString('hex').slice(0, 24)}`,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const recordIssue = (issue: Issue) => {
  issues.push(issue);
};

const extractCookiePair = (setCookieHeader: string | null, cookieName: string) => {
  if (!setCookieHeader) {
    return null;
  }

  const cookieMatch = setCookieHeader
    .split(/,(?=[^;]+=[^;]+)/)
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${cookieName}=`));

  if (!cookieMatch) {
    return null;
  }

  return cookieMatch.split(';')[0] || null;
};

const parseAdditionalAssignments = (): CourseAssignment[] => {
  if (!MIXED_ADDITIONAL_ASSIGNMENTS_JSON) {
    return [];
  }
  try {
    const parsed = JSON.parse(MIXED_ADDITIONAL_ASSIGNMENTS_JSON) as Array<Record<string, unknown>>;
    return parsed
      .map((item, index) => ({
        courseId: String(item.courseId || '').trim(),
        lessonId: String(item.lessonId || '').trim(),
        weight: Math.max(1, Number(item.weight || 1)),
        label: String(item.label || `mixed-course-${index + 1}`),
        source: 'mixed-course' as const,
      }))
      .filter((item) => item.courseId && item.lessonId);
  } catch (error) {
    console.warn(`Unable to parse COURSE_LOAD_MIXED_ASSIGNMENTS_JSON: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

const parseFailureInjections = (): FailureInjection[] => {
  if (!FAILURE_INJECTIONS_JSON) {
    return [];
  }
  try {
    const parsed = JSON.parse(FAILURE_INJECTIONS_JSON) as Array<Record<string, unknown>>;
    return parsed
      .map((item, index) => ({
        name: String(item.name || `failure-injection-${index + 1}`),
        command: String(item.command || '').trim(),
        delayMs: Math.max(0, Number(item.delayMs || item.delaySeconds || 0) * (String(item.delayMs || '').trim() ? 1 : 1000)),
      }))
      .filter((item) => item.command);
  } catch (error) {
    console.warn(`Unable to parse COURSE_LOAD_FAILURE_INJECTIONS_JSON: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

const courseAssignments: CourseAssignment[] = [
  {
    courseId: COURSE_ID,
    lessonId: LESSON_ID,
    weight: Math.max(1, HOT_COURSE_PERCENT),
    label: 'hot-course',
    source: 'hot-course',
  },
  ...parseAdditionalAssignments(),
];

const pickAssignmentForUser = (index: number): CourseAssignment => {
  if (courseAssignments.length === 1) {
    return courseAssignments[0];
  }

  const hotUsers = Math.round((HOT_COURSE_PERCENT / 100) * VUS);
  if (index < hotUsers) {
    return courseAssignments[0];
  }

  const mixedAssignments = courseAssignments.slice(1);
  if (!mixedAssignments.length) {
    return courseAssignments[0];
  }

  const weighted: CourseAssignment[] = [];
  for (const assignment of mixedAssignments) {
    for (let copy = 0; copy < assignment.weight; copy += 1) {
      weighted.push(assignment);
    }
  }
  return weighted[(index - hotUsers) % weighted.length] || courseAssignments[0];
};

const readResponseTelemetry = (response: Response) => {
  const worker = response.headers.get('x-worker')
    || response.headers.get('x-served-by')
    || response.headers.get('server')
    || null;
  const cacheStatus = response.headers.get('x-cache')
    || response.headers.get('x-cache-status')
    || response.headers.get('x-recorded-hls-cache')
    || response.headers.get('x-manifest-bundle-cache')
    || null;
  const cacheDetail = response.headers.get('x-cache-detail')
    || response.headers.get('cf-cache-status')
    || response.headers.get('x-manifest-asset-kind')
    || null;
  const cacheKey = response.headers.get('x-cache-key') || null;
  const upstreamResponseTime = response.headers.get('x-upstream-response-time')
    || response.headers.get('x-proxy-response-time')
    || null;

  return {
    worker,
    cacheStatus,
    cacheDetail,
    cacheKey,
    upstreamResponseTime,
  };
};

const request = async <T = unknown>(
  name: string,
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  user?: string,
  context: RequestContext = {},
): Promise<T | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let status = 0;
  let responsePayload: unknown = null;
  const clientProfile = getClientProfile(user);
  const recordedAt = new Date().toISOString();

  try {
    const response = await qaFetch(`${apiBase}${route}`, {
      method,
      headers: {
        ...buildClientHeaders(clientProfile, user, token),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    status = response.status;
    const text = await response.text();
    responsePayload = text ? JSON.parse(text) : null;
    const durationMs = Math.round(performance.now() - started);
    const {
      worker,
      cacheStatus,
      cacheDetail,
      cacheKey,
      upstreamResponseTime,
    } = readResponseTelemetry(response);
    metrics.push({
      name,
      method,
      path: route,
      status,
      ok: response.ok,
      durationMs,
      recordedAt,
      user,
      userId: context.userId,
      courseId: context.courseId,
      lessonId: context.lessonId,
      soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
      tickIndex: context.tickIndex,
      endpointKind: context.endpointKind,
      phase: context.phase,
      retryAttempt: context.retryAttempt,
      clientProfile: clientProfile.name,
      bytes: text.length,
      worker,
      cacheStatus,
      cacheDetail,
      cacheKey,
      upstreamResponseTime,
    });

    if (!response.ok) {
      const message = typeof responsePayload === 'object' && responsePayload
        ? String((responsePayload as Record<string, unknown>).message || (responsePayload as Record<string, unknown>).error || `${status}`)
        : `${status}`;
      throw Object.assign(new Error(`${method} ${route} failed with ${status}: ${message}`), {
        status,
        payload: responsePayload,
        metricRecorded: true,
        worker,
        cacheStatus,
        cacheDetail,
        cacheKey,
        upstreamResponseTime,
      });
    }

    return responsePayload as T;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    if (!(error as { metricRecorded?: boolean })?.metricRecorded) {
      metrics.push({
        name,
        method,
        path: route,
        status,
        ok: false,
        durationMs,
        recordedAt,
        user,
        userId: context.userId,
        courseId: context.courseId,
        lessonId: context.lessonId,
        soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
        tickIndex: context.tickIndex,
        endpointKind: context.endpointKind,
        phase: context.phase,
        retryAttempt: context.retryAttempt,
        clientProfile: clientProfile.name,
        error: message,
      });
    }
    failureAttribution.push({
      recordedAt,
      minuteOfSoak: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : 0,
      endpoint: name,
      method,
      path: route,
      statusCode: status,
      category: classifyFailure(status, message),
      durationMs,
      retryAttempt: context.retryAttempt || 0,
      user: user || null,
      userId: context.userId || null,
      courseId: context.courseId || null,
      lessonId: context.lessonId || null,
        worker: (error as { worker?: string | null })?.worker || null,
        cacheStatus: (error as { cacheStatus?: string | null })?.cacheStatus || null,
        cacheDetail: (error as { cacheDetail?: string | null })?.cacheDetail || null,
        cacheKey: (error as { cacheKey?: string | null })?.cacheKey || null,
        upstreamResponseTime: (error as { upstreamResponseTime?: string | null })?.upstreamResponseTime || null,
      phase: context.phase || null,
      endpointKind: context.endpointKind || null,
      tickIndex: context.tickIndex ?? null,
      errorMessage: message,
    });
    throw Object.assign(new Error(message), { status, payload: responsePayload });
  } finally {
    clearTimeout(timeout);
  }
};

const requestPlayerBootstrap = async (
  route: string,
  token: string,
  user?: string,
  context: RequestContext = {},
): Promise<PlayerBootstrap | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let status = 0;
  let responsePayload: unknown = null;
  const clientProfile = getClientProfile(user);
  const recordedAt = new Date().toISOString();

  try {
    const response = await qaFetch(`${apiBase}${route}`, {
      method: 'GET',
      headers: buildClientHeaders(clientProfile, user, token),
      signal: controller.signal,
    });
    status = response.status;
    const text = await response.text();
    responsePayload = text ? JSON.parse(text) : null;
    const durationMs = Math.round(performance.now() - started);
    const telemetry = readResponseTelemetry(response);
    metrics.push({
      name: 'course.player',
      method: 'GET',
      path: route,
      status,
      ok: response.ok,
      durationMs,
      recordedAt,
      user,
      userId: context.userId,
      courseId: context.courseId,
      lessonId: context.lessonId,
      soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
      tickIndex: context.tickIndex,
      endpointKind: context.endpointKind,
      phase: context.phase,
      retryAttempt: context.retryAttempt,
      clientProfile: clientProfile.name,
      bytes: text.length,
      worker: telemetry.worker,
      cacheStatus: telemetry.cacheStatus,
      cacheDetail: telemetry.cacheDetail,
      cacheKey: telemetry.cacheKey,
      upstreamResponseTime: telemetry.upstreamResponseTime,
    });

    if (!response.ok) {
      const message = typeof responsePayload === 'object' && responsePayload
        ? String((responsePayload as Record<string, unknown>).message || (responsePayload as Record<string, unknown>).error || `${status}`)
        : `${status}`;
      throw Object.assign(new Error(`GET ${route} failed with ${status}: ${message}`), {
        status,
        payload: responsePayload,
        metricRecorded: true,
        ...telemetry,
      });
    }

    return {
      player: (responsePayload || {}) as PlayerPayload,
      playbackGrantCookie: extractCookiePair(response.headers.get('set-cookie'), 'edumaster_hls'),
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    if (!(error as { metricRecorded?: boolean })?.metricRecorded) {
      metrics.push({
        name: 'course.player',
        method: 'GET',
        path: route,
        status,
        ok: false,
        durationMs,
        recordedAt,
        user,
        userId: context.userId,
        courseId: context.courseId,
        lessonId: context.lessonId,
        soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
        tickIndex: context.tickIndex,
        endpointKind: context.endpointKind,
        phase: context.phase,
        retryAttempt: context.retryAttempt,
        clientProfile: clientProfile.name,
        error: message,
      });
    }
    failureAttribution.push({
      recordedAt,
      minuteOfSoak: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : 0,
      endpoint: 'course.player',
      method: 'GET',
      path: route,
      statusCode: status,
      category: classifyFailure(status, message),
      durationMs,
      retryAttempt: context.retryAttempt || 0,
      user: user || null,
      userId: context.userId || null,
      courseId: context.courseId || null,
      lessonId: context.lessonId || null,
      worker: (error as { worker?: string | null })?.worker || null,
      cacheStatus: (error as { cacheStatus?: string | null })?.cacheStatus || null,
      cacheDetail: (error as { cacheDetail?: string | null })?.cacheDetail || null,
      cacheKey: (error as { cacheKey?: string | null })?.cacheKey || null,
      upstreamResponseTime: (error as { upstreamResponseTime?: string | null })?.upstreamResponseTime || null,
      phase: context.phase || null,
      endpointKind: context.endpointKind || null,
      tickIndex: context.tickIndex ?? null,
      errorMessage: message,
    });
    throw Object.assign(new Error(message), { status, payload: responsePayload });
  } finally {
    clearTimeout(timeout);
  }
};

const requestLessonBootstrap = async (
  route: string,
  token: string,
  user?: string,
  context: RequestContext = {},
): Promise<PlayerBootstrap | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let status = 0;
  let responsePayload: unknown = null;
  const clientProfile = getClientProfile(user);
  const recordedAt = new Date().toISOString();

  try {
    const response = await qaFetch(`${apiBase}${route}`, {
      method: 'GET',
      headers: buildClientHeaders(clientProfile, user, token),
      signal: controller.signal,
    });
    status = response.status;
    const text = await response.text();
    responsePayload = text ? JSON.parse(text) : null;
    const durationMs = Math.round(performance.now() - started);
    const telemetry = readResponseTelemetry(response);
    metrics.push({
      name: 'course.lessonBootstrap',
      method: 'GET',
      path: route,
      status,
      ok: response.ok,
      durationMs,
      recordedAt,
      user,
      userId: context.userId,
      courseId: context.courseId,
      lessonId: context.lessonId,
      soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
      tickIndex: context.tickIndex,
      endpointKind: context.endpointKind,
      phase: context.phase,
      retryAttempt: context.retryAttempt,
      clientProfile: clientProfile.name,
      bytes: text.length,
      worker: telemetry.worker,
      cacheStatus: telemetry.cacheStatus,
      cacheDetail: telemetry.cacheDetail,
      cacheKey: telemetry.cacheKey,
      upstreamResponseTime: telemetry.upstreamResponseTime,
    });

    if (!response.ok) {
      const message = typeof responsePayload === 'object' && responsePayload
        ? String((responsePayload as Record<string, unknown>).message || (responsePayload as Record<string, unknown>).error || `${status}`)
        : `${status}`;
      throw Object.assign(new Error(`GET ${route} failed with ${status}: ${message}`), {
        status,
        payload: responsePayload,
        metricRecorded: true,
        ...telemetry,
      });
    }

    const payload = (responsePayload || {}) as LessonBootstrapPayload;
    if (!payload.player) {
      return null;
    }

    return {
      player: payload.player,
      playbackGrantCookie: extractCookiePair(response.headers.get('set-cookie'), 'edumaster_hls'),
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    if (!(error as { metricRecorded?: boolean })?.metricRecorded) {
      metrics.push({
        name: 'course.lessonBootstrap',
        method: 'GET',
        path: route,
        status,
        ok: false,
        durationMs,
        recordedAt,
        user,
        userId: context.userId,
        courseId: context.courseId,
        lessonId: context.lessonId,
        soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
        tickIndex: context.tickIndex,
        endpointKind: context.endpointKind,
        phase: context.phase,
        retryAttempt: context.retryAttempt,
        clientProfile: clientProfile.name,
        error: message,
      });
    }
    failureAttribution.push({
      recordedAt,
      minuteOfSoak: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : 0,
      endpoint: 'course.lessonBootstrap',
      method: 'GET',
      path: route,
      statusCode: status,
      category: classifyFailure(status, message),
      durationMs,
      retryAttempt: context.retryAttempt || 0,
      user: user || null,
      userId: context.userId || null,
      courseId: context.courseId || null,
      lessonId: context.lessonId || null,
      worker: (error as { worker?: string | null })?.worker || null,
      cacheStatus: (error as { cacheStatus?: string | null })?.cacheStatus || null,
      cacheDetail: (error as { cacheDetail?: string | null })?.cacheDetail || null,
      cacheKey: (error as { cacheKey?: string | null })?.cacheKey || null,
      upstreamResponseTime: (error as { upstreamResponseTime?: string | null })?.upstreamResponseTime || null,
      phase: context.phase || null,
      endpointKind: context.endpointKind || null,
      tickIndex: context.tickIndex ?? null,
      errorMessage: message,
    });
    throw Object.assign(new Error(message), { status, payload: responsePayload });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchText = async (
  name: string,
  url: string,
  token?: string,
  cookieHeader?: string | null,
  user?: string,
  context: RequestContext = {},
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let status = 0;
  const clientProfile = getClientProfile(user);
  const recordedAt = new Date().toISOString();

  try {
    const response = await qaFetch(url, {
      method: 'GET',
      headers: {
        ...buildClientHeaders(clientProfile, user, token),
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      signal: controller.signal,
    });
    status = response.status;
    const text = await response.text();
    const durationMs = Math.round(performance.now() - started);
    const {
      worker,
      cacheStatus,
      cacheDetail,
      cacheKey,
      upstreamResponseTime,
    } = readResponseTelemetry(response);
    metrics.push({
      name,
      method: 'GET',
      path: new URL(url).pathname,
      status,
      ok: response.ok,
      durationMs,
      recordedAt,
      user,
      userId: context.userId,
      courseId: context.courseId,
      lessonId: context.lessonId,
      soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
      tickIndex: context.tickIndex,
      endpointKind: context.endpointKind,
      phase: context.phase,
      retryAttempt: context.retryAttempt,
      clientProfile: clientProfile.name,
      bytes: text.length,
      worker,
      cacheStatus,
      cacheDetail,
      cacheKey,
      upstreamResponseTime,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`GET ${url} failed with ${status}`), {
        metricRecorded: true,
        worker,
        cacheStatus,
        cacheDetail,
        cacheKey,
        upstreamResponseTime,
      });
    }
    return text;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    if (!(error as { metricRecorded?: boolean })?.metricRecorded) {
      metrics.push({
        name,
        method: 'GET',
        path: new URL(url).pathname,
        status,
        ok: false,
        durationMs,
        recordedAt,
        user,
        userId: context.userId,
        courseId: context.courseId,
        lessonId: context.lessonId,
        soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
        tickIndex: context.tickIndex,
        endpointKind: context.endpointKind,
        phase: context.phase,
        retryAttempt: context.retryAttempt,
        clientProfile: clientProfile.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    failureAttribution.push({
      recordedAt,
      minuteOfSoak: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : 0,
      endpoint: name,
      method: 'GET',
      path: new URL(url).pathname,
      statusCode: status,
      category: classifyFailure(status, message),
      durationMs,
      retryAttempt: context.retryAttempt || 0,
      user: user || null,
      userId: context.userId || null,
      courseId: context.courseId || null,
      lessonId: context.lessonId || null,
      worker: (error as { worker?: string | null })?.worker || null,
      cacheStatus: (error as { cacheStatus?: string | null })?.cacheStatus || null,
      cacheDetail: (error as { cacheDetail?: string | null })?.cacheDetail || null,
      cacheKey: (error as { cacheKey?: string | null })?.cacheKey || null,
      upstreamResponseTime: (error as { upstreamResponseTime?: string | null })?.upstreamResponseTime || null,
      phase: context.phase || null,
      endpointKind: context.endpointKind || null,
      tickIndex: context.tickIndex ?? null,
      errorMessage: message,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const fetchBinary = async (
  name: string,
  url: string,
  token?: string,
  cookieHeader?: string | null,
  user?: string,
  context: RequestContext = {},
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  let status = 0;
  const clientProfile = getClientProfile(user);
  const recordedAt = new Date().toISOString();

  try {
    const response = await qaFetch(url, {
      method: 'GET',
      headers: {
        ...buildClientHeaders(clientProfile, user, token),
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      signal: controller.signal,
    });
    status = response.status;
    const bytes = (await response.arrayBuffer()).byteLength;
    const durationMs = Math.round(performance.now() - started);
    const {
      worker,
      cacheStatus,
      cacheDetail,
      cacheKey,
      upstreamResponseTime,
    } = readResponseTelemetry(response);
    metrics.push({
      name,
      method: 'GET',
      path: new URL(url).pathname,
      status,
      ok: response.ok,
      durationMs,
      recordedAt,
      user,
      userId: context.userId,
      courseId: context.courseId,
      lessonId: context.lessonId,
      soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
      tickIndex: context.tickIndex,
      endpointKind: context.endpointKind,
      phase: context.phase,
      retryAttempt: context.retryAttempt,
      clientProfile: clientProfile.name,
      bytes,
      worker,
      cacheStatus,
      cacheDetail,
      cacheKey,
      upstreamResponseTime,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`GET ${url} failed with ${status}`), {
        metricRecorded: true,
        worker,
        cacheStatus,
        cacheDetail,
        cacheKey,
        upstreamResponseTime,
      });
    }
    return bytes;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    if (!(error as { metricRecorded?: boolean })?.metricRecorded) {
      metrics.push({
        name,
        method: 'GET',
        path: new URL(url).pathname,
        status,
        ok: false,
        durationMs,
        recordedAt,
        user,
        userId: context.userId,
        courseId: context.courseId,
        lessonId: context.lessonId,
        soakMinute: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : undefined,
        tickIndex: context.tickIndex,
        endpointKind: context.endpointKind,
        phase: context.phase,
        retryAttempt: context.retryAttempt,
        clientProfile: clientProfile.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    failureAttribution.push({
      recordedAt,
      minuteOfSoak: context.soakSecond != null ? Math.floor(context.soakSecond / 60) : 0,
      endpoint: name,
      method: 'GET',
      path: new URL(url).pathname,
      statusCode: status,
      category: classifyFailure(status, message),
      durationMs,
      retryAttempt: context.retryAttempt || 0,
      user: user || null,
      userId: context.userId || null,
      courseId: context.courseId || null,
      lessonId: context.lessonId || null,
      worker: (error as { worker?: string | null })?.worker || null,
      cacheStatus: (error as { cacheStatus?: string | null })?.cacheStatus || null,
      cacheDetail: (error as { cacheDetail?: string | null })?.cacheDetail || null,
      cacheKey: (error as { cacheKey?: string | null })?.cacheKey || null,
      upstreamResponseTime: (error as { upstreamResponseTime?: string | null })?.upstreamResponseTime || null,
      phase: context.phase || null,
      endpointKind: context.endpointKind || null,
      tickIndex: context.tickIndex ?? null,
      errorMessage: message,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

const buildFailureBreakdown = () => ({
  totalFailures: failureAttribution.length,
  byEndpoint: groupCount(failureAttribution, (item) => item.endpoint),
  byMinute: groupCount(failureAttribution, (item) => String(item.minuteOfSoak)),
  byCategory: groupCount(failureAttribution, (item) => item.category),
  byUserCohort: groupCount(failureAttribution, (item) => item.user ? item.user.split('_').slice(-1)[0]?.split('@')[0] || 'unknown' : 'unknown'),
  byWorker: groupCount(failureAttribution, (item) => item.worker || 'unknown'),
  byRetryAttempt: groupCount(failureAttribution, (item) => String(item.retryAttempt)),
});

const buildRequestAmplificationReport = () => {
  const allTelemetry = getAllTelemetry();
  const totalUsers = Math.max(1, VUS);
  const simulatedHours = Math.max((WATCH_MODE ? WATCH_DURATION_SECONDS : 3700) / 3600, 1 / 60);
  const endpointCounts = groupCount(metrics, (item) => item.name).map((entry) => ({
    endpoint: entry.key,
    requests: entry.count,
    perUserPerHour: Number((entry.count / totalUsers / simulatedHours).toFixed(2)),
  }));
  const retryCount = allTelemetry.reduce((sum, item) => sum + item.retryCount, 0);
  const avoidableBackgroundRequests = metrics.filter((item) => item.name.startsWith('recorded.watchHeartbeat.') || item.name.startsWith('recorded.watchProgress.') || item.name.startsWith('course.video.masterManifest') || item.name.startsWith('course.video.mediaManifest')).length;
  return {
    totalRequests: metrics.length,
    requestsPerUserPerHour: Number((metrics.length / totalUsers / simulatedHours).toFixed(2)),
    retryAmplificationFactor: Number((retryCount / Math.max(1, failureAttribution.length)).toFixed(2)),
    avoidableBackgroundRequestPercentage: Number(((avoidableBackgroundRequests / Math.max(1, metrics.length)) * 100).toFixed(2)),
    endpointAmplificationRatios: endpointCounts.sort((left, right) => right.requests - left.requests),
  };
};

const buildAuthRefreshAnalysis = () => ({
  refreshAttempts: metrics.filter((item) => item.name === 'auth.login' && item.phase === 'watch-auth-refresh').length,
  refreshFailures: failureAttribution.filter((item) => item.endpoint === 'auth.login').length,
  refreshRetries: failureAttribution.filter((item) => item.endpoint === 'auth.login' && item.retryAttempt > 0).length,
  latencyByMinute: groupCount(metrics.filter((item) => item.name === 'auth.login'), (item) => String(item.soakMinute ?? 0)).map((entry) => {
    const minute = Number(entry.key);
    const rows = metrics.filter((item) => item.name === 'auth.login' && (item.soakMinute ?? 0) === minute);
    return { minute, count: rows.length, avgMs: average(rows.map((row) => row.durationMs)), p95Ms: percentile(rows.map((row) => row.durationMs), 95) };
  }),
});

const buildManifestSoakAnalysis = () => ({
  refreshCountPerUserAverage: Number((getAllTelemetry().reduce((sum, item) => sum + item.manifestRefreshCount, 0) / Math.max(1, getAllTelemetry().length)).toFixed(2)),
  masterManifestFailures: failureAttribution.filter((item) => item.endpoint === 'course.video.masterManifest').length,
  mediaManifestFailures: failureAttribution.filter((item) => item.endpoint === 'course.video.mediaManifest').length,
  cacheStatusCounts: groupCount(metrics.filter((item) => item.name === 'course.video.masterManifest' || item.name === 'course.video.mediaManifest'), (item) => `${item.name}:${item.cacheStatus || 'unknown'}`),
  minuteTrend: groupCount(metrics.filter((item) => item.name === 'course.video.masterManifest' || item.name === 'course.video.mediaManifest'), (item) => String(item.soakMinute ?? 0)).map((entry) => ({
    minute: Number(entry.key),
    requests: entry.count,
    failures: failureAttribution.filter((item) => (item.endpoint === 'course.video.masterManifest' || item.endpoint === 'course.video.mediaManifest') && item.minuteOfSoak === Number(entry.key)).length,
  })),
});

const buildRetryAnalysis = () => ({
  totalRetries: getAllTelemetry().reduce((sum, item) => sum + item.retryCount, 0),
  retriesPerEndpoint: groupCount(failureAttribution.filter((item) => item.retryAttempt > 0), (item) => item.endpoint),
  retriesPerMinute: groupCount(failureAttribution.filter((item) => item.retryAttempt > 0), (item) => String(item.minuteOfSoak)),
  retryChains: failureAttribution.filter((item) => item.retryAttempt > 0).slice(0, 200),
});

const buildCacheTelemetry = () => ({
  counts: groupCount(metrics.filter((item) => item.cacheStatus || item.cacheDetail), (item) => `${item.cacheStatus || 'unknown'}:${item.cacheDetail || 'none'}`),
  masterManifest: groupCount(metrics.filter((item) => item.name === 'course.video.masterManifest'), (item) => item.cacheStatus || 'unknown'),
  mediaManifest: groupCount(metrics.filter((item) => item.name === 'course.video.mediaManifest'), (item) => item.cacheStatus || 'unknown'),
});

const buildSoakCompletionReport = () => ({
  completedWatchers: getAllTelemetry().filter((item) => item.completed && item.playbackSecondsAdvanced >= WATCH_DURATION_SECONDS).length,
  interruptedWatchers: getAllTelemetry().filter((item) => item.interruptions > 0).length,
  recoveredWatchers: getAllTelemetry().filter((item) => item.interruptions > 0 && item.completed).length,
  permanentlyFailedWatchers: getAllTelemetry().filter((item) => !item.completed && item.completedAt).length,
  continuityScore: buildJourneyTelemetrySummary(),
});

const buildResourceCorrelationReport = () => {
  const failureByMinute = groupCount(failureAttribution, (item) => String(item.minuteOfSoak));
  return {
    resourceSamples: resourceTelemetry.length,
    failureByMinute,
    failureSlopeIncreasing: failureByMinute.length > 2 && failureByMinute[failureByMinute.length - 1].count > failureByMinute[0].count,
    samples: resourceTelemetry.slice(-20),
  };
};

const currentSummary = (extra: Json = {}) => {
  const finalMemory = process.memoryUsage();
  const journeyTelemetrySummary = buildJourneyTelemetrySummary();
  return {
    runId,
    baseUrl: apiOrigin,
    apiBase,
    usersRequested: VUS,
    setupConcurrency: SETUP_CONCURRENCY,
    activeConcurrency: ACTIVE_CONCURRENCY,
    targetCourseId: COURSE_ID,
    targetLessonId: LESSON_ID,
    progress: { ...progress },
    totalRequests: metrics.length,
    failedRequests: metrics.filter((metric) => !metric.ok).length,
    endpointSummary: summarizeByName(),
    courseAssignments,
    journeyTelemetrySummary,
    resourceTelemetry,
    failureBreakdown: buildFailureBreakdown(),
    requestAmplificationReport: buildRequestAmplificationReport(),
    authRefreshAnalysis: buildAuthRefreshAnalysis(),
    manifestSoakAnalysis: buildManifestSoakAnalysis(),
    retryAnalysis: buildRetryAnalysis(),
    resourceCorrelationReport: buildResourceCorrelationReport(),
    cacheTelemetry: buildCacheTelemetry(),
    soakCompletionReport: buildSoakCompletionReport(),
    issues,
    crashed: false,
    finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
    peakHeapUsedMb: Math.round(finalMemory.heapUsed / 1024 / 1024),
    artifacts: {
      reportDir,
      json: path.join(reportDir, 'full-course-video-report.json'),
      markdown: path.join(reportDir, 'full-course-video-report.md'),
      manifest: manifestPath,
    },
    ...extra,
  };
};

const writePartialReport = async (reason: string) => {
  await fs.mkdir(reportDir, { recursive: true });
  const summary = currentSummary({ partial: true, reason });
  await fs.writeFile(path.join(reportDir, 'partial-report.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(reportDir, 'journey-telemetry.partial.json'), JSON.stringify(getAllTelemetry(), null, 2));
  await fs.writeFile(path.join(reportDir, 'failure-breakdown.json'), JSON.stringify(buildFailureBreakdown(), null, 2));
  await fs.writeFile(path.join(reportDir, 'failure-timeline.json'), JSON.stringify(failureAttribution, null, 2));
  await fs.writeFile(path.join(reportDir, 'endpoint-failure-ranking.json'), JSON.stringify(buildFailureBreakdown().byEndpoint, null, 2));
  console.log(`[${new Date().toISOString()}] partial report: ${reason}; phase=${progress.phase}; prepared=${progress.preparedUsers}/${VUS}; completed=${progress.completedJourneys}/${VUS}; requests=${metrics.length}; failures=${metrics.filter((metric) => !metric.ok).length}`);
};

const isRetryableSetupError = (error: unknown) => {
  const status = Number((error as { status?: number })?.status || 0);
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return status === 0
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
    || message.includes('aborted')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('fetch failed')
    || message.includes('socket hang up');
};

const withPrepareRetry = async <T>(label: string, operation: () => Promise<T>) => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PREPARE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= PREPARE_RETRY_ATTEMPTS || !isRetryableSetupError(error)) {
        throw error;
      }
      const backoffMs = PREPARE_RETRY_BACKOFF_MS * attempt;
      console.warn(`[prepare] ${label} retry ${attempt}/${PREPARE_RETRY_ATTEMPTS - 1} after ${backoffMs}ms: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(backoffMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
};

const isRetryableWatchError = (error: unknown) => {
  const status = Number((error as { status?: number })?.status || 0);
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return status === 0
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
    || message.includes('aborted')
    || message.includes('timed out')
    || message.includes('timeout')
    || message.includes('fetch failed')
    || message.includes('socket hang up');
};

const withWatchRetry = async <T>(
  label: string,
  context: RequestContext,
  telemetry: UserJourneyTelemetry,
  tick: WatchTickTelemetry | null,
  operation: (retryAttempt: number) => Promise<T>,
) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < WATCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableWatchError(error) || attempt >= WATCH_RETRY_ATTEMPTS - 1) {
        throw error;
      }
      telemetry.retryCount += 1;
      if (tick) {
        tick.retryCount += 1;
      }
      const jitterMs = Math.round(deterministicFraction(`${label}:${context.user || 'anon'}:${attempt}`) * 750);
      const backoffMs = (WATCH_RETRY_BACKOFF_MS * (attempt + 1)) + jitterMs;
      await sleep(backoffMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
};

let manifestWriteChain: Promise<void> = Promise.resolve();

const queueManifestWrite = (users: Array<LoadUser | undefined>) => {
  manifestWriteChain = manifestWriteChain.then(async () => {
    const readyUsers = users.filter(Boolean);
    await fs.mkdir(reportDir, { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(readyUsers, null, 2));
  }).catch(() => undefined);
  return manifestWriteChain;
};

const login = async (email: string, password: string, device: string, context: RequestContext = {}) => {
  const payload = await withPrepareRetry(`login:${email}`, () => request<{ token: string; user: Json }>('auth.login', 'POST', '/auth/login', {
    email,
    password,
    device,
    forceLogoutOtherSessions: true,
  }, undefined, email, context));
  if (!payload?.token) {
    throw new Error(`Login did not return token for ${email}`);
  }
  return payload;
};

const prepareUsers = async (): Promise<LoadUser[]> => {
  if (PROD_SAFE_MODE) {
    requireValueInProdSafeMode('COURSE_LOAD_USERS_FILE', EXISTING_USERS_FILE);
    requireValueInProdSafeMode('COURSE_LOAD_COURSE_ID', COURSE_ID);
    requireValueInProdSafeMode('COURSE_LOAD_LESSON_ID', LESSON_ID);
  }
  if (EXISTING_USERS_FILE) {
    const raw = await fs.readFile(EXISTING_USERS_FILE, 'utf8');
    const loaded = JSON.parse(raw) as LoadUser[];
    const selectedUsers = loaded.slice(0, VUS);
    if (selectedUsers.length < VUS) {
      throw new Error(
        PROD_SAFE_MODE
          ? `Prepared user manifest only contains ${selectedUsers.length} users, but COURSE_LOAD_USERS=${VUS}. Prod-safe mode will not create or top up users.`
          : `Prepared user manifest only contains ${selectedUsers.length} users, but COURSE_LOAD_USERS=${VUS}.`,
      );
    }

    if (!REFRESH_EXISTING_USER_TOKENS) {
      console.log(`Loaded ${selectedUsers.length} prepared users from ${EXISTING_USERS_FILE} without token refresh`);
      progress.preparedUsers = selectedUsers.length;
      return selectedUsers;
    }

    console.log(`Loaded ${selectedUsers.length} prepared users from ${EXISTING_USERS_FILE}; refreshing auth tokens`);
    const refreshedUsersSnapshot: Array<LoadUser | undefined> = new Array(selectedUsers.length);
    const refreshedUsers = await runPool(selectedUsers, SETUP_CONCURRENCY, async (user, index) => {
      const loginPayload = await login(user.email, USER_PASSWORD, `course-load-refresh-${index + 1}`);
      progress.preparedUsers += 1;
      refreshedUsersSnapshot[index] = {
        ...user,
        token: loginPayload.token,
        userId: pickId(loginPayload.user),
      };
      if (progress.preparedUsers % 25 === 0 || progress.preparedUsers === selectedUsers.length) {
        await queueManifestWrite(refreshedUsersSnapshot);
      }
      if (progress.preparedUsers % 25 === 0 || progress.preparedUsers === selectedUsers.length) {
        console.log(`[prepare] refreshed ${progress.preparedUsers}/${selectedUsers.length} existing users`);
      }
      return refreshedUsersSnapshot[index] as LoadUser;
    });
    await fs.writeFile(manifestPath, JSON.stringify(refreshedUsers, null, 2));
    console.log(`Refreshed user manifest: ${manifestPath}`);
    return refreshedUsers;
  }

  if (PROD_SAFE_MODE) {
    throw new Error('COURSE_LOAD_USERS_FILE is required in prod-safe mode because synthetic user creation is disabled.');
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const indexes = Array.from({ length: VUS }, (_, index) => index);
  const preparedUsers: Array<LoadUser | undefined> = new Array(VUS);
  const users = await runPool(indexes, SETUP_CONCURRENCY, async (index) => {
    assertMutationAllowed('Creating synthetic course/video load users');
    const email = `course_load_${suffix}_${index}@edumaster.local`;
    const mobileNumber = `9${String(Date.now()).slice(-4)}${String(index).padStart(5, '0')}`;
    try {
      await withPrepareRetry(`signup:${email}`, () => request('auth.signup', 'POST', '/auth/register', {
        name: `Course Load User ${index + 1}`,
        email,
        password: USER_PASSWORD,
        mobileNumber,
      }, undefined, email));
    } catch (error) {
      recordIssue({
        severity: 'High',
        whatBroke: 'Signup failed during user preparation',
        where: 'Auth / Register',
        exactErrorMessage: error instanceof Error ? error.message : String(error),
        stepsToReproduce: `Run course video load with COURSE_LOAD_USERS=${VUS}; failing synthetic user index ${index}.`,
        userCountDuringFailure: index + 1,
        apiServerResponse: (error as { payload?: unknown }).payload,
        suggestedFix: 'Check auth validation, unique email handling, password hashing throughput, and database insert latency.',
      });
      throw error;
    }
    const loginPayload = await login(email, USER_PASSWORD, `course-load-${index + 1}`);
    progress.preparedUsers += 1;
    preparedUsers[index] = {
      index,
      email,
      token: loginPayload.token,
      userId: pickId(loginPayload.user),
      name: `Course Load User ${index + 1}`,
    };
    if (progress.preparedUsers % 25 === 0 || progress.preparedUsers === VUS) {
      await queueManifestWrite(preparedUsers);
    }
    if (progress.preparedUsers % 25 === 0 || progress.preparedUsers === VUS) {
      console.log(`[prepare] ${progress.preparedUsers}/${VUS} users ready`);
    }
    return preparedUsers[index] as LoadUser;
  });
  await fs.writeFile(manifestPath, JSON.stringify(users, null, 2));
  console.log(`Prepared user manifest: ${manifestPath}`);
  return users;
};

const parseM3u8Entries = (manifest: string) => manifest
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const absoluteUrl = (raw: string) => new URL(raw, apiOrigin).toString();

const fetchManifestAndSegments = async (
  player: PlayerPayload,
  token: string,
  cookieHeader: string | null,
  userLabel: string,
  segmentCount: number,
  context: RequestContext = {},
) => {
  if (!player.streamUrl) {
    throw new Error('Protected player did not return streamUrl');
  }

  const startedMaster = performance.now();
  const masterUrl = absoluteUrl(String(player.streamUrl));
  const masterManifest = await fetchText('course.video.masterManifest', masterUrl, token, cookieHeader, userLabel, {
    ...context,
    endpointKind: 'master-manifest',
  });
  const masterManifestMs = Math.round(performance.now() - startedMaster);
  const masterEntries = parseM3u8Entries(masterManifest);
  if (!masterEntries.length) {
    throw new Error('Master manifest did not contain any media entries');
  }

  const startedMedia = performance.now();
  const playlistUrl = absoluteUrl(masterEntries.find((entry) => entry.endsWith('.m3u8')) || masterEntries[0]);
  const mediaManifest = await fetchText('course.video.mediaManifest', playlistUrl, token, cookieHeader, userLabel, {
    ...context,
    endpointKind: 'media-manifest',
  });
  const mediaManifestMs = Math.round(performance.now() - startedMedia);
  const mediaEntries = parseM3u8Entries(mediaManifest)
    .filter((entry) => !entry.endsWith('.m3u8'))
    .slice(0, segmentCount);

  if (!mediaEntries.length) {
    throw new Error('Media manifest did not contain any segment entries');
  }

  const startedSegments = performance.now();
  for (const [index, entry] of mediaEntries.entries()) {
    const segmentUrl = absoluteUrl(entry);
    await fetchBinary(`course.video.segment.${index + 1}`, segmentUrl, token, cookieHeader, userLabel, {
      ...context,
      endpointKind: `segment-${index + 1}`,
    });
  }
  const segmentWindowMs = Math.round(performance.now() - startedSegments);

  return {
    masterManifestMs,
    mediaManifestMs,
    segmentWindowMs,
    segmentRequests: mediaEntries.length,
  };
};

const runVideoFetchFlow = async (
  player: PlayerPayload,
  token: string,
  playbackGrantCookie: string | null,
  userLabel: string,
) => fetchManifestAndSegments(player, token, playbackGrantCookie, userLabel, SEGMENTS_PER_USER);

const maybeSleepForWatch = async (
  playbackStartedAtMs: number,
  expectedCurrentTimeSeconds: number,
  userJitterSeconds: number,
) => {
  if (!WATCH_ALLOW_REAL_SLEEP) {
    return;
  }
  const dueAtMs = playbackStartedAtMs + ((expectedCurrentTimeSeconds + userJitterSeconds) * 1000);
  const waitMs = Math.max(0, dueAtMs - Date.now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }
};

const runResourceTelemetryCommand = async () => {
  if (!RESOURCE_TELEMETRY_COMMAND) {
    return;
  }

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(RESOURCE_TELEMETRY_COMMAND, {
      cwd: rootDir,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${RESOURCE_TELEMETRY_COMMAND} failed with ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout || stderr);
    });
  });

  resourceTelemetry.push({
    recordedAt: new Date().toISOString(),
    source: RESOURCE_TELEMETRY_COMMAND,
    output,
  });
};

const scheduleFailureInjections = () => {
  const injections = parseFailureInjections();
  return injections.map((injection) => setTimeout(() => {
    const startedAt = new Date().toISOString();
    const child = spawn(injection.command, {
      cwd: rootDir,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      resourceTelemetry.push({
        recordedAt: startedAt,
        source: `failure-injection:${injection.name}:${code}`,
        output: stdout || stderr || `completed with code ${code}`,
      });
    });
  }, injection.delayMs));
};

const runUserJourney = async (user: LoadUser) => {
  const userLabel = user.email;
  const assignment = pickAssignmentForUser(user.index);
  let failed = false;
  let fatalSoakFailure = false;
  let currentToken = user.token;
  const userStartJitterSeconds = computeJitterSeconds(`${userLabel}:start`, WATCH_START_JITTER_SECONDS);
  const heartbeatOffsetSeconds = computeJitterSeconds(`${userLabel}:heartbeat`, WATCH_INTERVAL_JITTER_SECONDS);
  const progressOffsetSeconds = computeJitterSeconds(`${userLabel}:progress`, WATCH_INTERVAL_JITTER_SECONDS);
  const manifestOffsetSeconds = computeJitterSeconds(`${userLabel}:manifest`, WATCH_INTERVAL_JITTER_SECONDS);
  const authOffsetSeconds = computeJitterSeconds(`${userLabel}:auth`, WATCH_INTERVAL_JITTER_SECONDS);
  const telemetry: UserJourneyTelemetry = {
    user: userLabel,
    assignment,
    startedAt: new Date().toISOString(),
    watchDurationSeconds: WATCH_MODE ? WATCH_DURATION_SECONDS : Math.max(60, WATCH_PROGRESS_INTERVAL_SECONDS),
    heartbeatCount: 0,
    progressWriteCount: 0,
    manifestRefreshCount: 0,
    segmentWindowCount: 0,
    interruptions: 0,
    reconnectCount: 0,
    retryCount: 0,
    authRefreshCount: 0,
    qualitySwitchCount: 0,
    stallCount: 0,
    freezeCount: 0,
    bufferingSeconds: 0,
    playbackSecondsAdvanced: 0,
    completed: false,
    ticks: [],
  };
  activeJourneyTelemetry.set(userLabel, telemetry);
  const step = async (
    label: string,
    fn: () => Promise<unknown>,
    severity: Issue['severity'] = 'High',
    markFailed = true,
  ) => {
    try {
      return await fn();
    } catch (error) {
      if (markFailed) {
        failed = true;
      }
      recordIssue({
        severity,
        whatBroke: `${label} failed`,
        where: label,
        exactErrorMessage: error instanceof Error ? error.message : String(error),
        stepsToReproduce: `Run the course video sustained load test; failing user ${userLabel}; course ${assignment.courseId}; lesson ${assignment.lessonId}; step ${label}.`,
        userCountDuringFailure: VUS,
        apiServerResponse: (error as { payload?: unknown }).payload,
        suggestedFix: 'Inspect the endpoint contract, server route wiring, cache usage, DB query latency, and request timeout/5xx pattern for this feature.',
      });
      return null;
    }
  };

  try {
    let playerBootstrap = null;
    if (USE_LESSON_BOOTSTRAP) {
      if (ENROLL_ON_START) {
        await step('Course enroll', () => enrollUserForCourse(currentToken, user, assignment.courseId, userLabel));
      }

      playerBootstrap = await step(
        'Course lesson bootstrap',
        () => requestLessonBootstrap(`/courses/${assignment.courseId}/lessons/${assignment.lessonId}/bootstrap`, currentToken, userLabel, {
          userId: user.userId,
          courseId: assignment.courseId,
          lessonId: assignment.lessonId,
        }),
        'Critical',
      ) as PlayerBootstrap | null;
    } else {
      await step('Courses list', () => request('courses.list', 'GET', '/courses', undefined, currentToken, userLabel));
      await step('Course detail', () => request('courses.detail', 'GET', `/courses/${assignment.courseId}`, undefined, currentToken, userLabel));
      await step('Course lessons', () => request('courses.lessons', 'GET', `/courses/${assignment.courseId}/lessons`, undefined, currentToken, userLabel));
      await step('Course enroll', () => enrollUserForCourse(currentToken, user, assignment.courseId, userLabel));

      playerBootstrap = await step(
        'Course lesson player',
        () => requestPlayerBootstrap(`/courses/${assignment.courseId}/lessons/${assignment.lessonId}/player`, currentToken, userLabel, {
          userId: user.userId,
          courseId: assignment.courseId,
          lessonId: assignment.lessonId,
        }),
        'Critical',
      ) as PlayerBootstrap | null;
    }

    if (playerBootstrap?.player) {
      const {
        player,
        playbackGrantCookie,
      } = playerBootstrap;
      await step('Course video startup fetch', () => runVideoFetchFlow(player, currentToken, playbackGrantCookie, userLabel), 'Critical');

      if (WATCH_MODE) {
        if (userStartJitterSeconds > 0) {
          await maybeSleepForWatch(Date.now(), 0, userStartJitterSeconds);
        }
        const playbackStartedAtMs = Date.now();
        const totalTicks = Math.max(1, Math.ceil(WATCH_DURATION_SECONDS / WATCH_HEARTBEAT_SECONDS));
        for (let tickIndex = 1; tickIndex <= totalTicks; tickIndex += 1) {
          const expectedCurrentTimeSeconds = Math.min(WATCH_DURATION_SECONDS, tickIndex * WATCH_HEARTBEAT_SECONDS);
          const tick: WatchTickTelemetry = {
            tickIndex,
            expectedCurrentTimeSeconds,
            heartbeatOk: false,
            progressPersisted: false,
            masterManifestMs: null,
            mediaManifestMs: null,
            segmentWindowMs: null,
            segmentRequests: 0,
            interrupted: false,
            authRefreshed: false,
            qualitySwitchTriggered: false,
            bufferingSeconds: 0,
            retryCount: 0,
            reconnectCount: 0,
            stallDetected: false,
          };

          const heartbeatContext: RequestContext = {
            user: userLabel,
            userId: user.userId,
            courseId: assignment.courseId,
            lessonId: assignment.lessonId,
            soakSecond: expectedCurrentTimeSeconds,
            tickIndex,
            phase: 'watch-heartbeat',
            endpointKind: 'watch-heartbeat',
          };
          const heartbeatPayload = {
            videoId: assignment.lessonId,
            courseId: assignment.courseId,
            lessonId: assignment.lessonId,
            currentTimeSeconds: expectedCurrentTimeSeconds,
            durationSeconds: WATCH_DURATION_SECONDS,
            isPlaying: true,
            completed: expectedCurrentTimeSeconds >= WATCH_DURATION_SECONDS,
            watchMode: 'sustained',
            heartbeatIndex: tickIndex,
          };

          const heartbeatResult = await step(
            `Watch heartbeat ${tickIndex}`,
            () => withWatchRetry(`Watch heartbeat ${tickIndex}`, heartbeatContext, telemetry, tick, (retryAttempt) =>
              request(`recorded.watchHeartbeat.${tickIndex}`, 'POST', '/track', heartbeatPayload, currentToken, userLabel, {
                ...heartbeatContext,
                retryAttempt,
              })),
            'High',
            false,
          );
          if (heartbeatResult) {
            tick.heartbeatOk = true;
            telemetry.heartbeatCount += 1;
          } else {
            tick.interrupted = true;
            tick.interruptionReason = 'heartbeat-failed';
            telemetry.interruptions += 1;
            fatalSoakFailure = true;
          }

          const shouldPersistProgress = tickIndex === 1
            || (((expectedCurrentTimeSeconds + progressOffsetSeconds) % WATCH_PROGRESS_INTERVAL_SECONDS) === 0
              && expectedCurrentTimeSeconds >= WATCH_PROGRESS_MIN_DELTA_SECONDS);
          if (shouldPersistProgress) {
            const progressContext: RequestContext = {
              ...heartbeatContext,
              phase: 'watch-progress-persist',
              endpointKind: 'watch-progress-persist',
            };
            const progressResult = await step(
              `Watch progress persistence ${tickIndex}`,
              () => withWatchRetry(`Watch progress persistence ${tickIndex}`, progressContext, telemetry, tick, (retryAttempt) =>
                request(`recorded.watchProgress.${tickIndex}`, 'POST', '/platform/watch-progress', {
                  courseId: assignment.courseId,
                  lessonId: assignment.lessonId,
                  progressPercent: Math.min(99, Math.round((expectedCurrentTimeSeconds / Math.max(WATCH_DURATION_SECONDS, 1)) * 100)),
                  progressSeconds: expectedCurrentTimeSeconds,
                  completed: false,
                  watchMode: 'sustained',
                  checkpoint: tickIndex,
                }, currentToken, userLabel, {
                  ...progressContext,
                  retryAttempt,
                })),
              'High',
              false,
            );
            if (progressResult) {
              tick.progressPersisted = true;
              telemetry.progressWriteCount += 1;
            } else {
              fatalSoakFailure = true;
            }
          }

          const shouldRefreshManifest = tickIndex === 1
            || ((expectedCurrentTimeSeconds + manifestOffsetSeconds) % WATCH_MANIFEST_REFRESH_INTERVAL_SECONDS) === 0;
          if (shouldRefreshManifest) {
            const refreshContext: RequestContext = {
              ...heartbeatContext,
              phase: 'watch-manifest-refresh',
              endpointKind: 'manifest-continuity',
            };
            const refreshStats = await step(`Manifest continuity ${tickIndex}`, () => withWatchRetry(
              `Manifest continuity ${tickIndex}`,
              refreshContext,
              telemetry,
              tick,
              (retryAttempt) => fetchManifestAndSegments(player, currentToken, playbackGrantCookie, userLabel, WATCH_SEGMENT_WINDOW_SIZE, {
                ...refreshContext,
                retryAttempt,
              }),
            ), 'Critical', false) as {
              masterManifestMs: number;
              mediaManifestMs: number;
              segmentWindowMs: number;
              segmentRequests: number;
            } | null;
            if (refreshStats) {
              tick.masterManifestMs = refreshStats.masterManifestMs;
              tick.mediaManifestMs = refreshStats.mediaManifestMs;
              tick.segmentWindowMs = refreshStats.segmentWindowMs;
              tick.segmentRequests = refreshStats.segmentRequests;
              telemetry.manifestRefreshCount += 1;
              telemetry.segmentWindowCount += 1;
            } else {
              tick.interrupted = true;
              tick.interruptionReason = 'manifest-refresh-failed';
              telemetry.interruptions += 1;
              telemetry.reconnectCount += 1;
              tick.reconnectCount += 1;
              fatalSoakFailure = true;
            }
          }

          if (WATCH_QUALITY_SWITCH_INTERVAL_SECONDS > 0 && expectedCurrentTimeSeconds % WATCH_QUALITY_SWITCH_INTERVAL_SECONDS === 0) {
            tick.qualitySwitchTriggered = true;
            telemetry.qualitySwitchCount += 1;
          }

          const shouldRefreshAuth = WATCH_AUTH_REFRESH_INTERVAL_SECONDS > 0
            && ((expectedCurrentTimeSeconds + authOffsetSeconds) % WATCH_AUTH_REFRESH_INTERVAL_SECONDS) === 0;
          if (shouldRefreshAuth) {
            const loginPayload = await step(`Auth refresh ${tickIndex}`, () => withWatchRetry(
              `Auth refresh ${tickIndex}`,
              {
                ...heartbeatContext,
                phase: 'watch-auth-refresh',
                endpointKind: 'auth-refresh',
              },
              telemetry,
              tick,
              (retryAttempt) => login(user.email, USER_PASSWORD, `course-load-refresh-long-${user.index + 1}`, {
                user: userLabel,
                userId: user.userId,
                courseId: assignment.courseId,
                lessonId: assignment.lessonId,
                soakSecond: expectedCurrentTimeSeconds,
                tickIndex,
                phase: 'watch-auth-refresh',
                endpointKind: 'auth-refresh',
                retryAttempt,
              }),
            ), 'Medium', false) as { token: string } | null;
            if (loginPayload?.token) {
              currentToken = loginPayload.token;
              tick.authRefreshed = true;
              telemetry.authRefreshCount += 1;
            } else {
              fatalSoakFailure = true;
            }
          }

          if (tick.mediaManifestMs !== null && tick.mediaManifestMs > REQUEST_TIMEOUT_MS / 2) {
            tick.stallDetected = true;
            telemetry.stallCount += 1;
            telemetry.bufferingSeconds += WATCH_HEARTBEAT_SECONDS;
            tick.bufferingSeconds += WATCH_HEARTBEAT_SECONDS;
          }

          telemetry.playbackSecondsAdvanced = expectedCurrentTimeSeconds;
          telemetry.ticks.push(tick);
          await maybeSleepForWatch(playbackStartedAtMs, expectedCurrentTimeSeconds, heartbeatOffsetSeconds);
        }

        const completionResult = await step('Recorded watch progress 100%', () => withWatchRetry(
          'Recorded watch progress 100%',
          {
            user: userLabel,
            userId: user.userId,
            courseId: assignment.courseId,
            lessonId: assignment.lessonId,
            soakSecond: WATCH_DURATION_SECONDS,
            tickIndex: totalTicks,
            phase: 'watch-progress-complete',
            endpointKind: 'watch-progress-complete',
          },
          telemetry,
          null,
          (retryAttempt) => request('recorded.watchProgress.100', 'POST', '/platform/watch-progress', {
            courseId: assignment.courseId,
            lessonId: assignment.lessonId,
            progressPercent: 100,
            progressSeconds: WATCH_DURATION_SECONDS,
            completed: true,
            watchMode: 'sustained',
          }, currentToken, userLabel, {
            user: userLabel,
            userId: user.userId,
            courseId: assignment.courseId,
            lessonId: assignment.lessonId,
            soakSecond: WATCH_DURATION_SECONDS,
            tickIndex: totalTicks,
            phase: 'watch-progress-complete',
            endpointKind: 'watch-progress-complete',
            retryAttempt,
          }),
        ), 'High', false);
        if (completionResult) {
          telemetry.progressWriteCount += 1;
        } else {
          fatalSoakFailure = true;
        }
      } else {
        await step('Recorded watch progress 25%', () => request('recorded.watchProgress.25', 'POST', '/platform/watch-progress', {
          courseId: assignment.courseId,
          lessonId: assignment.lessonId,
          progressPercent: 25,
          progressSeconds: 900,
          completed: false,
        }, currentToken, userLabel));
        await step('Recorded watch progress 100%', () => request('recorded.watchProgress.100', 'POST', '/platform/watch-progress', {
          courseId: assignment.courseId,
          lessonId: assignment.lessonId,
          progressPercent: 100,
          progressSeconds: 3700,
          completed: true,
        }, currentToken, userLabel));
        telemetry.progressWriteCount += 2;
        telemetry.playbackSecondsAdvanced = 3700;
      }
    }

    await step('User progress', () => request('user.progress', 'GET', '/users/progress', undefined, currentToken, userLabel));

    progress.completedJourneys += 1;
    if (!failed && !fatalSoakFailure) {
      progress.successfulJourneys += 1;
    }
    telemetry.completed = !failed && !fatalSoakFailure && telemetry.playbackSecondsAdvanced >= WATCH_DURATION_SECONDS;
    telemetry.completedAt = new Date().toISOString();
    journeyTelemetry.push(telemetry);
    activeJourneyTelemetry.delete(userLabel);
    if (progress.completedJourneys % 25 === 0 || progress.completedJourneys === VUS) {
      console.log(`[active] ${progress.completedJourneys}/${VUS} journeys complete; success=${progress.successfulJourneys}; failures=${progress.completedJourneys - progress.successfulJourneys}`);
    }
    return !failed;
  } catch (error) {
    recordIssue({
      severity: 'High',
      whatBroke: 'Full user course-video journey failed',
      where: 'Concurrent course-video journey',
      exactErrorMessage: error instanceof Error ? error.message : String(error),
      stepsToReproduce: `Run the course video sustained load test; failing user ${userLabel}; course ${assignment.courseId}; lesson ${assignment.lessonId}.`,
      userCountDuringFailure: VUS,
      apiServerResponse: (error as { payload?: unknown }).payload,
      suggestedFix: 'Inspect the named endpoint metrics, server logs, DB locks, replay grant path, and HLS delivery cache behavior for this user.',
    });
    progress.completedJourneys += 1;
    telemetry.completed = false;
    telemetry.completedAt = new Date().toISOString();
    journeyTelemetry.push(telemetry);
    activeJourneyTelemetry.delete(userLabel);
    return false;
  }
};

const writeReports = async (summary: Json) => {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'full-course-video-report.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(reportDir, 'journey-telemetry.json'), JSON.stringify(getAllTelemetry(), null, 2));
  await fs.writeFile(path.join(reportDir, 'resource-telemetry.json'), JSON.stringify(resourceTelemetry, null, 2));
  await fs.writeFile(path.join(reportDir, 'failure-breakdown.json'), JSON.stringify(buildFailureBreakdown(), null, 2));
  await fs.writeFile(path.join(reportDir, 'failure-timeline.json'), JSON.stringify(failureAttribution, null, 2));
  await fs.writeFile(path.join(reportDir, 'endpoint-failure-ranking.json'), JSON.stringify(buildFailureBreakdown().byEndpoint, null, 2));
  await fs.writeFile(path.join(reportDir, 'request-amplification-report.json'), JSON.stringify(buildRequestAmplificationReport(), null, 2));
  await fs.writeFile(path.join(reportDir, 'auth-refresh-analysis.json'), JSON.stringify(buildAuthRefreshAnalysis(), null, 2));
  await fs.writeFile(path.join(reportDir, 'manifest-soak-analysis.json'), JSON.stringify(buildManifestSoakAnalysis(), null, 2));
  await fs.writeFile(path.join(reportDir, 'retry-analysis.json'), JSON.stringify(buildRetryAnalysis(), null, 2));
  await fs.writeFile(path.join(reportDir, 'resource-correlation-report.json'), JSON.stringify(buildResourceCorrelationReport(), null, 2));
  await fs.writeFile(path.join(reportDir, 'cache-telemetry.json'), JSON.stringify(buildCacheTelemetry(), null, 2));
  await fs.writeFile(path.join(reportDir, 'soak-completion-report.json'), JSON.stringify(buildSoakCompletionReport(), null, 2));
  const endpointRows = (summary.endpointSummary as Json[]).map((row) =>
    `| ${row.name} | ${row.requests} | ${row.successRate}% | ${row.avgMs} | ${row.p95Ms} | ${row.p99Ms} | ${row.maxMs} | ${JSON.stringify(row.statuses)} |`,
  ).join('\n');
  const issueRows = issues.length
    ? issues.map((issue, index) =>
      `### ${index + 1}. ${issue.severity}: ${issue.whatBroke}\n- Where: ${issue.where}\n- Error: ${issue.exactErrorMessage}\n- Users: ${issue.userCountDuringFailure}\n- Repro: ${issue.stepsToReproduce}\n- Suggested fix: ${issue.suggestedFix}`,
    ).join('\n\n')
    : 'No course-video failures were captured by this run.';

  const markdown = `# 1000-User Course Video QA Report

Run: ${runId}

## Scope
- Users requested: ${VUS}
- Active journey concurrency: ${ACTIVE_CONCURRENCY}
- Setup concurrency: ${SETUP_CONCURRENCY}
- Base URL: ${apiOrigin}
- Hot course: ${COURSE_ID}
- Default hot lesson: ${LESSON_ID}
- Watch mode: ${WATCH_MODE ? 'sustained' : 'startup-sampling'}
- Target watch duration: ${WATCH_DURATION_SECONDS} seconds
- Heartbeat interval: ${WATCH_HEARTBEAT_SECONDS} seconds
- Manifest refresh interval: ${WATCH_MANIFEST_REFRESH_INTERVAL_SECONDS} seconds
- Mixed assignments configured: ${courseAssignments.length}
- Video startup sampled via: player -> master manifest -> media manifest -> ${WATCH_MODE ? `${WATCH_SEGMENT_WINDOW_SIZE} segments per refresh window` : `${SEGMENTS_PER_USER} segments per user`}

## Environment
- Host: ${os.hostname()}
- CPU cores visible to Node: ${os.cpus().length}
- Memory total: ${Math.round(os.totalmem() / 1024 / 1024)} MB
- Node: ${process.version}

## Load Summary
- Total requests: ${summary.totalRequests}
- Failed requests: ${summary.failedRequests}
- Successful journeys: ${summary.successfulJourneys}/${VUS}
- Wall clock: ${summary.wallClockMs} ms
- Peak heap used: ${summary.peakHeapUsedMb} MB
- RSS after run: ${summary.finalRssMb} MB

## Sustained Playback Telemetry
- Users tracked: ${(summary.journeyTelemetrySummary as Json).usersTracked}
- Completed watchers: ${(summary.journeyTelemetrySummary as Json).completedWatchers}
- Average playback seconds advanced: ${(summary.journeyTelemetrySummary as Json).averagePlaybackSeconds}
- Interruptions: ${(summary.journeyTelemetrySummary as Json).interruptions}
- Reconnects: ${(summary.journeyTelemetrySummary as Json).reconnects}
- Retries: ${(summary.journeyTelemetrySummary as Json).retries}
- Auth refreshes: ${(summary.journeyTelemetrySummary as Json).authRefreshes}
- Quality switches: ${(summary.journeyTelemetrySummary as Json).qualitySwitches}
- Stalls: ${(summary.journeyTelemetrySummary as Json).stalls}
- Freezes: ${(summary.journeyTelemetrySummary as Json).freezes}
- Buffering seconds: ${(summary.journeyTelemetrySummary as Json).bufferingSeconds}

## Endpoint Performance
| Endpoint | Requests | Success | Avg ms | P95 ms | P99 ms | Max ms | Statuses |
|---|---:|---:|---:|---:|---:|---:|---|
${endpointRows}

## Artifacts
- Journey telemetry: ${path.join(reportDir, 'journey-telemetry.json')}
- Resource telemetry: ${path.join(reportDir, 'resource-telemetry.json')}

## Issues
${issueRows}
`;

  await fs.writeFile(path.join(reportDir, 'full-course-video-report.md'), markdown);
};

const main = async () => {
  const runStarted = performance.now();
  if (PROD_SAFE_MODE && ENROLL_ON_START) {
    throw new Error('COURSE_LOAD_ENROLL_ON_START is not allowed when QA_CERT_MODE=prod_safe_existing_data_only.');
  }
  const memorySamples: NodeJS.MemoryUsage[] = [];
  const sampler = setInterval(() => memorySamples.push(process.memoryUsage()), 1000);
  const resourceSampler = RESOURCE_TELEMETRY_COMMAND
    ? setInterval(() => {
      runResourceTelemetryCommand().catch((error) => {
        resourceTelemetry.push({
          recordedAt: new Date().toISOString(),
          source: RESOURCE_TELEMETRY_COMMAND,
          output: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }, RESOURCE_TELEMETRY_INTERVAL_SECONDS * 1000)
    : null;
  const partialSampler = setInterval(() => {
    writePartialReport('interval').catch((error) => {
      console.error(`Unable to write partial report: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, PARTIAL_REPORT_INTERVAL_MS);
  const failureInjectionTimers = scheduleFailureInjections();

  const stopRequested = async (signal: string) => {
    progress.phase = `interrupted:${signal}`;
    await writePartialReport(`interrupted by ${signal}`).catch(() => undefined);
    process.exit(130);
  };
  process.once('SIGINT', () => { void stopRequested('SIGINT'); });
  process.once('SIGTERM', () => { void stopRequested('SIGTERM'); });

  try {
    await fs.mkdir(reportDir, { recursive: true });
    progress.phase = EXISTING_USERS_FILE ? 'load-user-manifest' : 'prepare-users';
    const users = await prepareUsers();

    if (PREPARE_ONLY) {
      progress.phase = 'prepared-only';
      const finalMemory = process.memoryUsage();
      const summary = {
        runId,
        ...certificationModeSummary(),
        baseUrl: apiOrigin,
        apiBase,
        usersRequested: VUS,
        setupConcurrency: SETUP_CONCURRENCY,
        activeConcurrency: 0,
        successfulJourneys: 0,
        failedJourneys: 0,
        totalRequests: metrics.length,
        failedRequests: metrics.filter((metric) => !metric.ok).length,
        wallClockMs: Math.round(performance.now() - runStarted),
        journeyWallClockMs: 0,
        endpointSummary: summarizeByName(),
        issues,
        crashed: false,
        finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
        peakHeapUsedMb: Math.round(Math.max(finalMemory.heapUsed, ...memorySamples.map((sample) => sample.heapUsed)) / 1024 / 1024),
        sampleBrowserUsers: users.slice(0, SAMPLE_USERS_FOR_BROWSER).map((user) => ({
          email: user.email,
          token: user.token,
        })),
        journeyTelemetrySummary: buildJourneyTelemetrySummary(),
        resourceTelemetry,
        artifacts: {
          reportDir,
          json: path.join(reportDir, 'full-course-video-report.json'),
          markdown: path.join(reportDir, 'full-course-video-report.md'),
          manifest: manifestPath,
        },
        courseAssignments,
        watchMode: WATCH_MODE,
        note: 'Prepared users only. No active playback journeys were run.',
      };
      await writeReports(summary);
      console.log(JSON.stringify({
        reportDir,
        usersPrepared: users.length,
        manifest: manifestPath,
        prepareOnly: true,
      }, null, 2));
      return;
    }

    progress.phase = 'active-1000-course-video-journeys';
    const journeyStarted = performance.now();
    const journeyResults = await runPool(users, ACTIVE_CONCURRENCY, (user) => {
      progress.startedJourneys += 1;
      if (progress.startedJourneys % 100 === 0 || progress.startedJourneys === users.length) {
        console.log(`[active] started ${progress.startedJourneys}/${users.length} journeys`);
      }
      return runUserJourney(user);
    });
    const journeyWallClockMs = Math.round(performance.now() - journeyStarted);
    const successfulJourneys = journeyResults.filter(Boolean).length;
    progress.phase = 'reporting';

    const endpointSummary = summarizeByName();
    const finalMemory = process.memoryUsage();
    const peakHeapUsedMb = Math.round(Math.max(finalMemory.heapUsed, ...memorySamples.map((sample) => sample.heapUsed)) / 1024 / 1024);
    const summary = {
      runId,
      ...certificationModeSummary(),
      baseUrl: apiOrigin,
      apiBase,
      usersRequested: VUS,
      setupConcurrency: SETUP_CONCURRENCY,
      activeConcurrency: ACTIVE_CONCURRENCY,
      successfulJourneys,
      failedJourneys: VUS - successfulJourneys,
      totalRequests: metrics.length,
      failedRequests: metrics.filter((metric) => !metric.ok).length,
      wallClockMs: Math.round(performance.now() - runStarted),
      journeyWallClockMs,
      endpointSummary,
      issues,
      crashed: false,
      finalRssMb: Math.round(finalMemory.rss / 1024 / 1024),
      peakHeapUsedMb,
      sampleBrowserUsers: users.slice(0, SAMPLE_USERS_FOR_BROWSER).map((user) => ({
        email: user.email,
        token: user.token,
        assignment: pickAssignmentForUser(user.index),
      })),
      journeyTelemetrySummary: buildJourneyTelemetrySummary(),
      resourceTelemetry,
      artifacts: {
        reportDir,
        json: path.join(reportDir, 'full-course-video-report.json'),
        markdown: path.join(reportDir, 'full-course-video-report.md'),
        manifest: manifestPath,
      },
      courseAssignments,
      watchMode: WATCH_MODE,
      note: WATCH_MODE
        ? `This run validates sustained ${loadLabel} watch continuity, periodic manifest refresh, segment continuity, and watch-progress persistence. It does not represent ${VUS} simultaneous local browsers.`
        : `This run validates the ${loadLabel} API path and HLS startup fetches, not ${VUS} simultaneous local browsers.`,
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
      sampleBrowserUsers: summary.sampleBrowserUsers,
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
      ...certificationModeSummary(),
      baseUrl: apiOrigin,
      usersRequested: VUS,
      totalRequests: metrics.length,
      failedRequests: metrics.filter((metric) => !metric.ok).length,
      endpointSummary: summarizeByName(),
      journeyTelemetrySummary: buildJourneyTelemetrySummary(),
      resourceTelemetry,
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
    if (resourceSampler) {
      clearInterval(resourceSampler);
    }
    clearInterval(partialSampler);
    for (const timer of failureInjectionTimers) {
      clearTimeout(timer);
    }
  }
};

main();
