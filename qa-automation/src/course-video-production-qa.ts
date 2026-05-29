import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { config } from './config.js';
import { qaFetch, chromeHostResolverRule } from './network.js';
import { selectors } from './selectors.js';
import { ensureDir, sleep, writeJson, writeText } from './utils.js';

type AutomationType = 'browser' | 'api' | 'hybrid' | 'hook' | 'load';
type CaseStatus = 'passed' | 'failed' | 'flaky' | 'skipped';
type Category =
  | 'Authentication'
  | 'Dashboard'
  | 'Course Navigation'
  | 'Video Playback'
  | 'HLS Streaming'
  | 'Concurrency'
  | 'Failure Recovery'
  | 'UI Validation'
  | 'Performance'
  | 'Security';

type TestCaseDefinition = {
  id: string;
  category: Category;
  title: string;
  automation: AutomationType;
  description: string;
  tags?: string[];
};

type NetworkSample = {
  url: string;
  method: string;
  status: number;
  durationMs: number;
  resourceType: string;
  cacheStatus: string;
  contentLength: number;
};

type ConsoleSample = {
  type: string;
  text: string;
  timestamp: string;
};

type PageErrorSample = {
  message: string;
  stack?: string;
  timestamp: string;
};

type VideoSnapshot = {
  exists: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  networkState: number;
  playbackRate: number;
  bufferedSeconds: number;
  width: number;
  height: number;
  totalVideoFrames: number;
  droppedVideoFrames: number;
  error: string | null;
};

type CaseArtifacts = {
  dir: string;
  screenshots: string[];
  videoPath: string | null;
  networkLogPath: string | null;
  consoleLogPath: string | null;
  pageErrorsPath: string | null;
  playerStatePath: string | null;
};

type CaseResult = {
  id: string;
  category: Category;
  title: string;
  automation: AutomationType;
  status: CaseStatus;
  durationMs: number;
  attempts: number;
  notes: string[];
  artifacts: CaseArtifacts;
  metrics: Record<string, number | string | boolean | null>;
  error?: string;
};

type LoadRungResult = {
  users: number;
  mode: 'stepped-ladder';
  reportDir: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
  successfulJourneys: number;
  failedJourneys: number;
  playbackStartupSuccessRate: number;
  manifestP50Ms: number;
  manifestP95Ms: number;
  manifestP99Ms: number;
  manifestSuccessRate: number;
  totalRequests: number;
  failedRequests: number;
  wallClockMs: number;
  resourceSnapshotPath: string | null;
};

type EvidenceCollector = {
  console: ConsoleSample[];
  pageErrors: PageErrorSample[];
  network: NetworkSample[];
  failedRequests: string[];
};

type StudentProfile = {
  email: string;
  password: string;
  label: string;
};

type RuntimeConfig = {
  baseUrl: string;
  apiBase: string;
  reportRoot: string;
  reportId: string;
  headless: boolean;
  browserWorkers: number;
  caseRetries: number;
  keepReportRuns: number;
  screenshotQueueLimit: number;
  watchDurationsMs: Record<'short' | 'medium' | 'long' | 'soak', number>;
  studentEmail: string;
  studentPassword: string;
  invalidPassword: string;
  courseId: string;
  lessonId: string;
  browserSentinelUsers: number;
  browserSentinelConcurrency: number;
  skipLoad: boolean;
  loadUsersFile: string;
  loadSetupConcurrency: number;
  sentinelCheckpointSeconds: number[];
  sentinelUsePreparedUsers: boolean;
  resourceCommand: string;
  backendRestartCommand: string;
  manifestRestartCommand: string;
  nginxRestartCommand: string;
};

type BrowserCaseContext = {
  page: Page;
  context: BrowserContext;
  caseDir: string;
  record: EvidenceCollector;
  runtime: RuntimeConfig;
  notes: string[];
};

type ApiSession = {
  token: string;
  userId: string | null;
  playbackUrl: string | null;
  streamFormat: string | null;
};

const nowIso = () => new Date().toISOString();
const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const boolEnv = (name: string, defaultValue = false) => {
  const raw = String(process.env[name] ?? '');
  if (!raw) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};
const numberEnv = (name: string, defaultValue: number, min = 0) => {
  const parsed = Number(process.env[name] || defaultValue);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(min, parsed);
};
const textOrEmpty = (value: unknown) => String(value ?? '').trim();
const csvEnv = (name: string) => String(process.env[name] || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const reportId = new Date().toISOString().replace(/[:.]/g, '-');
const cwdRoot = path.resolve(process.cwd());
const reportRoot = path.join(cwdRoot, 'reports', `course-video-production-qa-${reportId}`);
const baseUrl = process.env.QA_BASE_URL || config.baseUrl || 'http://127.0.0.1:3000';
const apiBase = `${new URL(baseUrl).origin}/backend/api`;

const runtime: RuntimeConfig = {
  baseUrl,
  apiBase,
  reportRoot,
  reportId,
  headless: !boolEnv('PLAYBACK_QA_HEADED', false),
  browserWorkers: numberEnv('PLAYBACK_QA_BROWSER_WORKERS', 4, 1),
  caseRetries: numberEnv('PLAYBACK_QA_CASE_RETRIES', 1, 0),
  keepReportRuns: numberEnv('PLAYBACK_QA_KEEP_REPORTS', 10, 1),
  screenshotQueueLimit: numberEnv('PLAYBACK_QA_SCREENSHOT_QUEUE', 24, 4),
  watchDurationsMs: {
    short: numberEnv('PLAYBACK_QA_WATCH_SHORT_MS', 20_000, 5_000),
    medium: numberEnv('PLAYBACK_QA_WATCH_MEDIUM_MS', 45_000, 10_000),
    long: numberEnv('PLAYBACK_QA_WATCH_LONG_MS', 90_000, 20_000),
    soak: numberEnv('PLAYBACK_QA_WATCH_SOAK_MS', 180_000, 30_000),
  },
  studentEmail: process.env.QA_LOGIN_EMAIL || 'student@edumaster.local',
  studentPassword: process.env.QA_LOGIN_PASSWORD || 'Student@123',
  invalidPassword: process.env.PLAYBACK_QA_INVALID_PASSWORD || 'WrongPassword@123',
  courseId: process.env.COURSE_LOAD_COURSE_ID || 'course_1899470118af44b4b9447b35fd296761',
  lessonId: process.env.COURSE_LOAD_LESSON_ID || 'video_1778758229576',
  browserSentinelUsers: numberEnv('PLAYBACK_QA_SENTINEL_USERS', 12, 1),
  browserSentinelConcurrency: numberEnv('PLAYBACK_QA_SENTINEL_CONCURRENCY', 4, 1),
  skipLoad: boolEnv('PLAYBACK_QA_SKIP_LOAD', false),
  loadUsersFile: process.env.COURSE_LOAD_USERS_FILE || '',
  loadSetupConcurrency: numberEnv('COURSE_LOAD_SETUP_CONCURRENCY', 3, 1),
  sentinelCheckpointSeconds: String(process.env.PLAYBACK_QA_SENTINEL_CHECKPOINT_SECONDS || '300,900,1800,2700,3600')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right),
  sentinelUsePreparedUsers: boolEnv('PLAYBACK_QA_SENTINEL_USE_PREPARED_USERS', true),
  resourceCommand: textOrEmpty(process.env.PLAYBACK_QA_RESOURCE_COMMAND),
  backendRestartCommand: textOrEmpty(process.env.PLAYBACK_QA_BACKEND_RESTART_COMMAND),
  manifestRestartCommand: textOrEmpty(process.env.PLAYBACK_QA_MANIFEST_RESTART_COMMAND),
  nginxRestartCommand: textOrEmpty(process.env.PLAYBACK_QA_NGINX_RESTART_COMMAND),
};

const TEST_MATRIX: TestCaseDefinition[] = [
  { id: 'auth-valid-login', category: 'Authentication', title: 'valid login', automation: 'browser', description: 'Student can sign in and reach the shell.' },
  { id: 'auth-invalid-login', category: 'Authentication', title: 'invalid login', automation: 'browser', description: 'Invalid credentials show an auth failure without crashing the UI.' },
  { id: 'auth-expired-token', category: 'Authentication', title: 'expired token', automation: 'browser', description: 'Expired or invalid token returns the user to a safe signed-out state.' },
  { id: 'auth-refresh-flow', category: 'Authentication', title: 'refresh token flow', automation: 'browser', description: 'Session survives a reload and protected shell data restores correctly.' },
  { id: 'auth-concurrent-sessions', category: 'Authentication', title: 'concurrent session handling', automation: 'browser', description: 'Two isolated sessions can authenticate the same student without corrupting each other.' },
  { id: 'auth-logout-during-playback', category: 'Authentication', title: 'logout during playback', automation: 'hybrid', description: 'Playback is interrupted safely if the student logs out mid-watch.' },
  { id: 'auth-retry-handling', category: 'Authentication', title: 'auth retry handling', automation: 'browser', description: 'A transient login failure can be retried successfully.' },
  { id: 'auth-session-timeout-recovery', category: 'Authentication', title: 'session timeout recovery', automation: 'browser', description: 'The student can recover from session expiry and continue working.' },
  { id: 'auth-multi-device', category: 'Authentication', title: 'multi-device login handling', automation: 'browser', description: 'Desktop and mobile contexts can hold independent student sessions.' },

  { id: 'dashboard-load-success', category: 'Dashboard', title: 'dashboard load success', automation: 'browser', description: 'Dashboard loads and core panels render.' },
  { id: 'dashboard-course-list', category: 'Dashboard', title: 'course list rendering', automation: 'browser', description: 'Courses list renders for a signed-in student.' },
  { id: 'dashboard-pagination', category: 'Dashboard', title: 'pagination', automation: 'api', description: 'Course list pagination-capable API returns consistent results across pages.' },
  { id: 'dashboard-api-failure', category: 'Dashboard', title: 'API failure fallback', automation: 'browser', description: 'UI stays stable when the courses API fails.' },
  { id: 'dashboard-slow-network', category: 'Dashboard', title: 'slow network handling', automation: 'browser', description: 'UI keeps working when the courses API responds slowly.' },
  { id: 'dashboard-empty-state', category: 'Dashboard', title: 'empty course state', automation: 'browser', description: 'Empty course inventory is rendered intentionally.' },
  { id: 'dashboard-large-course-list', category: 'Dashboard', title: 'large course list rendering', automation: 'browser', description: 'Large course collections render without breaking layout.' },

  { id: 'nav-open-course', category: 'Course Navigation', title: 'open course', automation: 'browser', description: 'Student can enter a course from the catalog.' },
  { id: 'nav-open-lesson', category: 'Course Navigation', title: 'open lesson', automation: 'browser', description: 'Student can enter a lesson and see the player shell.' },
  { id: 'nav-next-lesson', category: 'Course Navigation', title: 'next lesson navigation', automation: 'browser', description: 'Next lesson action advances the lesson flow.' },
  { id: 'nav-previous-lesson', category: 'Course Navigation', title: 'previous lesson navigation', automation: 'browser', description: 'Back to lessons returns safely from the player.' },
  { id: 'nav-locked-lesson', category: 'Course Navigation', title: 'locked lesson behavior', automation: 'api', description: 'Locked or invalid lesson playback is denied.' },
  { id: 'nav-completed-lesson', category: 'Course Navigation', title: 'completed lesson behavior', automation: 'browser', description: 'Completed lesson state still presents stable playback controls and progress UI.' },
  { id: 'nav-rapid-lesson-switch', category: 'Course Navigation', title: 'rapid lesson switching', automation: 'browser', description: 'Repeated lesson switching does not crash the player shell.' },
  { id: 'nav-invalid-lesson', category: 'Course Navigation', title: 'invalid lesson access', automation: 'api', description: 'Invalid lesson identifiers are rejected safely.' },

  { id: 'playback-player-init', category: 'Video Playback', title: 'player initialization', automation: 'browser', description: 'Player shell creates a usable video element.' },
  { id: 'playback-master-manifest', category: 'Video Playback', title: 'master manifest load', automation: 'browser', description: 'Master manifest loads successfully in the browser flow.' },
  { id: 'playback-media-manifest', category: 'Video Playback', title: 'media manifest load', automation: 'browser', description: 'Media manifest loads successfully in the browser flow.' },
  { id: 'playback-first-segment', category: 'Video Playback', title: 'first segment load', automation: 'browser', description: 'First playable segment loads successfully.' },
  { id: 'playback-start', category: 'Video Playback', title: 'playback start', automation: 'browser', description: 'Video starts and current time advances.' },
  { id: 'playback-continuity', category: 'Video Playback', title: 'playback continuity', automation: 'browser', description: 'Playback continues without freezing during a medium watch.' },
  { id: 'playback-pause', category: 'Video Playback', title: 'pause', automation: 'browser', description: 'Pause action takes effect immediately.' },
  { id: 'playback-resume', category: 'Video Playback', title: 'resume', automation: 'browser', description: 'Resume action restarts current time movement.' },
  { id: 'playback-seek-forward', category: 'Video Playback', title: 'seek forward', automation: 'browser', description: 'Student can seek forward without breaking playback.' },
  { id: 'playback-seek-backward', category: 'Video Playback', title: 'seek backward', automation: 'browser', description: 'Student can seek backward and continue watching.' },
  { id: 'playback-quality-switch', category: 'Video Playback', title: 'quality switch', automation: 'browser', description: 'Quality changes via HLS level controls do not stall the stream.' },
  { id: 'playback-autoplay', category: 'Video Playback', title: 'autoplay', automation: 'browser', description: 'Autoplay toggle remains stable while video is active.' },
  { id: 'playback-muted-autoplay', category: 'Video Playback', title: 'muted autoplay', automation: 'browser', description: 'Muted autoplay survives reload and resumes promptly.' },
  { id: 'playback-completion', category: 'Video Playback', title: 'playback completion', automation: 'browser', description: 'Playback can reach the end state cleanly during a long watch.' },
  { id: 'playback-replay', category: 'Video Playback', title: 'replay playback', automation: 'browser', description: 'Replay starts the lesson again after completion or seek-to-end.' },
  { id: 'playback-sentinel-soak', category: 'Video Playback', title: 'sentinel soak playback', automation: 'browser', description: 'Sentinel browser records long-duration playback checkpoints and frame progression.' },

  { id: 'hls-cache-hit', category: 'HLS Streaming', title: 'manifest cache HIT', automation: 'browser', description: 'Repeated manifest requests become cache hits.' },
  { id: 'hls-cache-miss', category: 'HLS Streaming', title: 'manifest cache MISS', automation: 'browser', description: 'First request path shows a cache miss before warm cache hits appear.' },
  { id: 'hls-segment-loading', category: 'HLS Streaming', title: 'segment loading', automation: 'browser', description: 'HLS segments arrive successfully.' },
  { id: 'hls-segment-retry', category: 'HLS Streaming', title: 'segment retry', automation: 'browser', description: 'A transient segment failure is retried successfully.' },
  { id: 'hls-slow-segment', category: 'HLS Streaming', title: 'slow segment response', automation: 'browser', description: 'Playback tolerates a delayed segment response.' },
  { id: 'hls-manifest-timeout', category: 'HLS Streaming', title: 'manifest timeout', automation: 'browser', description: 'Manifest timeout produces a detectable retry or error state.' },
  { id: 'hls-stale-recovery', category: 'HLS Streaming', title: 'stale manifest recovery', automation: 'browser', description: 'Player recovers when a stale manifest is served once and then refreshed.' },
  { id: 'hls-invalid-manifest', category: 'HLS Streaming', title: 'invalid manifest handling', automation: 'api', description: 'Invalid manifest signatures or paths are rejected.' },
  { id: 'hls-corrupted-segment', category: 'HLS Streaming', title: 'corrupted segment handling', automation: 'browser', description: 'Corrupted segment data surfaces a controlled playback failure.' },

  { id: 'concurrency-250', category: 'Concurrency', title: '250 concurrent students', automation: 'load', description: 'Production load ladder rung at 250 concurrent students.' },
  { id: 'concurrency-750', category: 'Concurrency', title: '750 concurrent students', automation: 'load', description: 'Production load ladder rung at 750 concurrent students.' },
  { id: 'concurrency-1000', category: 'Concurrency', title: '1000 concurrent students', automation: 'load', description: 'Production load ladder rung at 1000 concurrent students.' },
  { id: 'concurrency-burst-joins', category: 'Concurrency', title: 'burst joins', automation: 'browser', description: 'Sentinel students can all join playback within a short burst window.' },
  { id: 'concurrency-gradual-ramp', category: 'Concurrency', title: 'gradual ramp', automation: 'browser', description: 'Sentinel students ramp up progressively without browser-side playback collapse.' },
  { id: 'concurrency-soak', category: 'Concurrency', title: 'soak playback', automation: 'browser', description: 'A smaller browser cohort stays in playback for a soak duration.' },
  { id: 'concurrency-reconnects', category: 'Concurrency', title: 'repeated reconnects', automation: 'browser', description: 'Repeated offline/online transitions recover playback in a browser cohort.' },
  { id: 'concurrency-simultaneous-seeks', category: 'Concurrency', title: 'simultaneous seeks', automation: 'browser', description: 'Multiple students can seek around the same time and continue playing.' },
  { id: 'concurrency-mixed-course-soak', category: 'Concurrency', title: 'mixed-course sustained playback', automation: 'browser', description: 'Sentinel cohort validates sustained playback while course assignments vary.' },

  { id: 'failure-network-disconnect', category: 'Failure Recovery', title: 'network disconnect', automation: 'browser', description: 'Offline mode pauses the stream and surfaces a retry path.' },
  { id: 'failure-reconnect-recovery', category: 'Failure Recovery', title: 'reconnect recovery', automation: 'browser', description: 'Playback recovers after the connection returns.' },
  { id: 'failure-backend-restart', category: 'Failure Recovery', title: 'backend restart during playback', automation: 'hook', description: 'Playback survives or fails safely when the main backend restarts.' },
  { id: 'failure-manifest-restart', category: 'Failure Recovery', title: 'manifest worker restart', automation: 'hook', description: 'Playback survives or retries when the manifest service restarts.' },
  { id: 'failure-nginx-restart', category: 'Failure Recovery', title: 'nginx cache restart', automation: 'hook', description: 'Playback retries safely if the manifest proxy cache restarts.' },
  { id: 'failure-auth-refresh-load', category: 'Failure Recovery', title: 'auth refresh under load', automation: 'hybrid', description: 'Token refresh and load reuse can happen together without invalidating playback.' },
  { id: 'failure-player-retry', category: 'Failure Recovery', title: 'player retry logic', automation: 'browser', description: 'A retryable stream failure leads to resumed playback.' },
  { id: 'failure-browser-crash-recovery', category: 'Failure Recovery', title: 'browser crash recovery', automation: 'browser', description: 'A browser context can be recreated and the student can rejoin playback.' },
  { id: 'failure-sentinel-restart-recovery', category: 'Failure Recovery', title: 'sentinel recovery after infrastructure restart', automation: 'hook', description: 'Sentinel browser remains observable while backend or manifest services restart.' },

  { id: 'ui-player-visible', category: 'UI Validation', title: 'player visible', automation: 'browser', description: 'Player shell and video are visible.' },
  { id: 'ui-controls-visible', category: 'UI Validation', title: 'controls visible', automation: 'browser', description: 'Playback controls are visible and interactive.' },
  { id: 'ui-spinner-behavior', category: 'UI Validation', title: 'loading spinner behavior', automation: 'browser', description: 'Loading state appears only while playback is warming up.' },
  { id: 'ui-progress-updates', category: 'UI Validation', title: 'playback progress updates', automation: 'browser', description: 'Progress UI updates while current time advances.' },
  { id: 'ui-error-message', category: 'UI Validation', title: 'error message rendering', automation: 'browser', description: 'User-facing error state is rendered for manifest failure.' },
  { id: 'ui-responsive-layout', category: 'UI Validation', title: 'responsive layout', automation: 'browser', description: 'Desktop and tablet/mobile layouts remain usable.' },
  { id: 'ui-fullscreen', category: 'UI Validation', title: 'fullscreen mode', automation: 'browser', description: 'Fullscreen toggle is available and callable.' },
  { id: 'ui-mobile-viewport', category: 'UI Validation', title: 'mobile viewport support', automation: 'browser', description: 'Mobile viewport can load the course player.' },

  { id: 'perf-startup-latency', category: 'Performance', title: 'startup latency', automation: 'browser', description: 'Startup latency from lesson open to advancing current time is measured.' },
  { id: 'perf-first-frame', category: 'Performance', title: 'first-frame latency', automation: 'browser', description: 'Time to first frame is measured.' },
  { id: 'perf-buffering', category: 'Performance', title: 'playback buffering', automation: 'browser', description: 'Buffering stays bounded during a watch window.' },
  { id: 'perf-manifest-latency', category: 'Performance', title: 'manifest latency', automation: 'hybrid', description: 'Manifest latency is measured from browser and load-run signals.' },
  { id: 'perf-segment-latency', category: 'Performance', title: 'segment latency', automation: 'browser', description: 'Segment latency is recorded from browser network traces.' },
  { id: 'perf-cpu-usage', category: 'Performance', title: 'CPU usage', automation: 'hybrid', description: 'Host or container CPU snapshot is captured during ladder runs.' },
  { id: 'perf-memory-usage', category: 'Performance', title: 'memory usage', automation: 'hybrid', description: 'Host or container memory snapshot is captured during ladder runs.' },
  { id: 'perf-browser-resources', category: 'Performance', title: 'browser resource usage', automation: 'browser', description: 'Browser JS heap information is sampled when available.' },
  { id: 'perf-cache-hit-ratio', category: 'Performance', title: 'cache-hit ratio', automation: 'browser', description: 'Manifest cache headers are sampled to estimate hit ratio.' },

  { id: 'security-unauthorized-manifest', category: 'Security', title: 'unauthorized manifest access', automation: 'api', description: 'Manifest path cannot be fetched without valid auth or signature.' },
  { id: 'security-expired-playback-token', category: 'Security', title: 'expired playback token', automation: 'api', description: 'Expired playback token is rejected safely.' },
  { id: 'security-invalid-signature', category: 'Security', title: 'invalid signature', automation: 'api', description: 'Tampered manifest signatures are rejected safely.' },
  { id: 'security-cross-user-playback', category: 'Security', title: 'cross-user playback attempt', automation: 'api', description: 'One student cannot replay another student tokened playback URL in token mode.' },
  { id: 'security-direct-segment', category: 'Security', title: 'direct segment access without auth', automation: 'api', description: 'Raw segment access without a valid signed path is denied.' },
  { id: 'security-replay-attack', category: 'Security', title: 'replay attack prevention', automation: 'api', description: 'Previously captured invalid or mutated playback URLs are not reusable.' },
];

const caseIdFilters = csvEnv('PLAYBACK_QA_CASE_FILTER');
const categoryFilters = csvEnv('PLAYBACK_QA_CATEGORY_FILTER').map((value) => value.toLowerCase());

const FILTERED_TEST_MATRIX = TEST_MATRIX.filter((testCase) => {
  if (caseIdFilters.length && !caseIdFilters.includes(testCase.id)) {
    return false;
  }

  if (categoryFilters.length && !categoryFilters.includes(testCase.category.toLowerCase())) {
    return false;
  }

  return true;
});

const listFilesSorted = async (dir: string, prefix: string) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
};

const cleanupOldRuns = async () => {
  const reportBase = path.join(cwdRoot, 'reports');
  await ensureDir(reportBase);
  const all = await listFilesSorted(reportBase, 'course-video-production-qa-');
  const extra = Math.max(0, all.length - runtime.keepReportRuns);
  for (const name of all.slice(0, extra)) {
    await fs.rm(path.join(reportBase, name), { recursive: true, force: true });
  }
};

const buildChromeArgs = () => {
  const args = [
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ];
  const hostRule = chromeHostResolverRule(runtime.baseUrl);
  if (hostRule) {
    args.push(`--host-resolver-rules=${hostRule}`);
    args.push('--ignore-certificate-errors');
  }
  return args;
};

const createCollector = (): EvidenceCollector => ({
  console: [],
  pageErrors: [],
  network: [],
  failedRequests: [],
});

const attachCollectors = (page: Page, collector: EvidenceCollector) => {
  const requestStarted = new Map<string, number>();

  page.on('console', (message) => {
    collector.console.push({
      type: message.type(),
      text: message.text(),
      timestamp: nowIso(),
    });
  });

  page.on('pageerror', (error) => {
    collector.pageErrors.push({
      message: error.message,
      stack: error.stack,
      timestamp: nowIso(),
    });
  });

  page.on('request', (request) => {
    requestStarted.set(request.url(), Date.now());
  });

  page.on('requestfailed', (request) => {
    collector.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'requestfailed'}`);
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (!/(\.m3u8|\.m4s|\.ts|course-manifests|\/courses\/h\/)/i.test(url)) {
      return;
    }
    const started = requestStarted.get(url) || Date.now();
    const headers = response.headers();
    collector.network.push({
      url,
      method: response.request().method(),
      status: response.status(),
      durationMs: Math.max(0, Date.now() - started),
      resourceType: response.request().resourceType(),
      cacheStatus: headers['x-cache-status'] || headers['x-cache'] || headers['cf-cache-status'] || headers['x-proxy-cache'] || 'unknown',
      contentLength: Number(headers['content-length'] || 0),
    });
  });
};

class ArtifactWriter {
  private chain: Promise<void> = Promise.resolve();
  private inflight = 0;

  constructor(private readonly limit: number) {}

  private async waitForCapacity() {
    while (this.inflight >= this.limit) {
      await sleep(50);
    }
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      await this.waitForCapacity();
      this.inflight += 1;
      try {
        return await task();
      } finally {
        this.inflight -= 1;
      }
    };

    const result = this.chain.then(run);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async flush() {
    await this.chain;
  }
}

const artifactWriter = new ArtifactWriter(runtime.screenshotQueueLimit);

const createCaseArtifacts = async (caseId: string): Promise<CaseArtifacts> => {
  const dir = path.join(runtime.reportRoot, safe(caseId));
  await ensureDir(dir);
  return {
    dir,
    screenshots: [],
    videoPath: null,
    networkLogPath: null,
    consoleLogPath: null,
    pageErrorsPath: null,
    playerStatePath: null,
  };
};

const queueScreenshot = async (page: Page, artifacts: CaseArtifacts, label: string, fullPage = false) => {
  const filePath = path.join(artifacts.dir, `${Date.now()}-${safe(label)}.jpg`);
  await artifactWriter.enqueue(async () => {
    await page.screenshot({
      path: filePath,
      type: 'jpeg',
      quality: 70,
      fullPage,
      animations: 'disabled',
    });
  });
  artifacts.screenshots.push(filePath);
};

const saveCaseEvidence = async (
  caseId: string,
  artifacts: CaseArtifacts,
  collector: EvidenceCollector,
  playerState: unknown,
  page?: Page,
) => {
  artifacts.networkLogPath = path.join(artifacts.dir, `${safe(caseId)}-network.json`);
  artifacts.consoleLogPath = path.join(artifacts.dir, `${safe(caseId)}-console.json`);
  artifacts.pageErrorsPath = path.join(artifacts.dir, `${safe(caseId)}-page-errors.json`);
  artifacts.playerStatePath = path.join(artifacts.dir, `${safe(caseId)}-player-state.json`);
  await Promise.all([
    writeJson(artifacts.networkLogPath, collector.network),
    writeJson(artifacts.consoleLogPath, collector.console),
    writeJson(artifacts.pageErrorsPath, {
      pageErrors: collector.pageErrors,
      failedRequests: collector.failedRequests,
    }),
    writeJson(artifacts.playerStatePath, playerState),
  ]);
  if (page) {
    const video = page.video();
    if (video) {
      try {
        artifacts.videoPath = await video.path();
      } catch {
        artifacts.videoPath = null;
      }
    }
  }
};

const apiRequest = async <T = unknown>(route: string, init: RequestInit = {}) => {
  const response = await qaFetch(`${runtime.apiBase}${route}`, init);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${route} failed with ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
};

const apiLogin = async (email: string, password: string): Promise<ApiSession> => {
  const payload = await apiRequest<{ token: string; user?: { _id?: string; id?: string } }>('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return {
    token: payload.token,
    userId: payload.user?._id || payload.user?.id || null,
    playbackUrl: null,
    streamFormat: null,
  };
};

const apiGetPlayback = async (token: string) => {
  return apiRequest<{ streamUrl?: string | null; streamFormat?: string | null; playerType?: string | null }>(
    `/courses/${runtime.courseId}/lessons/${runtime.lessonId}/player`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
};

const pickCourseApiPages = async (token: string) => {
  const first = await apiRequest<any>('/courses?page=1&limit=1', {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  const second = await apiRequest<any>('/courses?page=2&limit=1', {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  return { first, second };
};

const createBrowserContext = async (browser: Browser, caseId: string, mobile = false) => {
  const videoDir = path.join(runtime.reportRoot, safe(caseId), 'video');
  await ensureDir(videoDir);
  const contextOptions: BrowserContextOptions = {
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    ignoreHTTPSErrors: true,
    recordVideo: {
      dir: videoDir,
      size: mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    },
  };
  if (mobile) {
    Object.assign(contextOptions, devices['Pixel 7']);
  }
  return browser.newContext(contextOptions);
};

const getVideoSelector = () => selectors.coursePlayerVideo;

const readVideoSnapshot = async (page: Page): Promise<VideoSnapshot> =>
  page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      return {
        exists: false,
        paused: true,
        ended: false,
        currentTime: 0,
        duration: 0,
        readyState: 0,
        networkState: 0,
        playbackRate: 1,
        bufferedSeconds: 0,
        width: 0,
        height: 0,
        totalVideoFrames: 0,
        droppedVideoFrames: 0,
        error: null,
      };
    }
    const quality = typeof video.getVideoPlaybackQuality === 'function'
      ? video.getVideoPlaybackQuality()
      : ({ totalVideoFrames: 0, droppedVideoFrames: 0 } as { totalVideoFrames: number; droppedVideoFrames: number });
    const bufferedEnd = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    return {
      exists: true,
      paused: video.paused,
      ended: video.ended,
      currentTime: Number(video.currentTime || 0),
      duration: Number(video.duration || 0),
      readyState: Number(video.readyState || 0),
      networkState: Number(video.networkState || 0),
      playbackRate: Number(video.playbackRate || 1),
      bufferedSeconds: Math.max(0, bufferedEnd - Number(video.currentTime || 0)),
      width: Number(video.videoWidth || 0),
      height: Number(video.videoHeight || 0),
      totalVideoFrames: Number((quality as { totalVideoFrames?: number }).totalVideoFrames || 0),
      droppedVideoFrames: Number((quality as { droppedVideoFrames?: number }).droppedVideoFrames || 0),
      error: video.error ? `${video.error.code}:${video.error.message || 'media-error'}` : null,
    };
  }, getVideoSelector());

const playVideo = async (page: Page) => {
  await page.evaluate(async (videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      throw new Error('Video element not found');
    }
    video.muted = true;
    const promise = video.play();
    if (promise && typeof promise.then === 'function') {
      await promise;
    }
  }, getVideoSelector());
};

const pauseVideo = async (page: Page) => {
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (video) {
      video.pause();
    }
  }, getVideoSelector());
};

const seekVideo = async (page: Page, deltaSeconds: number) => {
  await page.evaluate(([videoSelector, delta]) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }
    const nextTime = Math.min(Math.max(0, video.currentTime + delta), Math.max(0, video.duration - 1));
    video.currentTime = nextTime;
  }, [getVideoSelector(), deltaSeconds] as const);
};

const waitForPlaybackMovement = async (page: Page, timeoutMs = 20_000, minDelta = 2) => {
  const started = Date.now();
  const baseline = await readVideoSnapshot(page);
  while (Date.now() - started < timeoutMs) {
    await sleep(1_000);
    const current = await readVideoSnapshot(page);
    if (current.exists && current.currentTime >= baseline.currentTime + minDelta && current.totalVideoFrames >= baseline.totalVideoFrames) {
      return {
        baseline,
        current,
        deltaTime: current.currentTime - baseline.currentTime,
      };
    }
  }
  throw new Error(`Playback did not advance by ${minDelta}s within ${timeoutMs}ms`);
};

const waitForShellOrSessionConflict = async (page: Page, timeoutMs = 45_000) => {
  const shell = page.locator(selectors.shellReady);
  const takeOverButton = page.getByRole('button', { name: /log out older device and continue/i });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await shell.isVisible().catch(() => false)) {
      return 'shell' as const;
    }
    if (await takeOverButton.isVisible().catch(() => false)) {
      return 'session-conflict' as const;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for shell or session conflict within ${timeoutMs}ms`);
};

const ensureLoggedIn = async (page: Page) => {
  await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
  const email = page.locator(selectors.loginEmail);
  if (await email.count()) {
    await email.fill(runtime.studentEmail);
    await page.locator(selectors.loginPassword).fill(runtime.studentPassword);
    await page.locator(selectors.loginSubmit).click();
  }
  const loginState = await waitForShellOrSessionConflict(page, 45_000);
  if (loginState === 'session-conflict') {
    await page.getByRole('button', { name: /log out older device and continue/i }).click();
  }
  await page.locator(selectors.shellReady).waitFor({ state: 'visible', timeout: 45_000 });
};

const openCourseLessons = async (page: Page) => {
  const courseNav = page.locator(`${selectors.navCourses}, ${selectors.mobileNavCourses}, ${selectors.mobileTabCourses}`);
  if (await courseNav.count()) {
    await courseNav.first().click();
  }
  await page.locator(selectors.courseFigmaPage).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);

  const firstCourse = page.locator(`${selectors.courseCard}, ${selectors.courseCatalogCard}, ${selectors.firstContinueCourse}`);
  await firstCourse.first().waitFor({ state: 'visible', timeout: 30_000 });
  await firstCourse.first().click();

  const lessonTrigger = page.locator([
    selectors.courseSessionPrimaryAction,
    selectors.courseLessonOpen,
    selectors.coursePlaylistLesson,
    selectors.firstCourseSession,
    selectors.firstCourseLessonRail,
  ].join(', '));
  await lessonTrigger.first().waitFor({ state: 'visible', timeout: 30_000 });
  await lessonTrigger.first().click();
  await page.locator(`${selectors.courseLessonPage}, ${selectors.coursePlayerShell}`).first().waitFor({ state: 'visible', timeout: 30_000 });
};

const openLessonAndStartPlayback = async (page: Page, artifacts: CaseArtifacts) => {
  await ensureLoggedIn(page);
  await queueScreenshot(page, artifacts, 'dashboard');
  await openCourseLessons(page);
  await queueScreenshot(page, artifacts, 'lesson-page');
  await page.locator(getVideoSelector()).waitFor({ state: 'visible', timeout: 30_000 });
  await queueScreenshot(page, artifacts, 'player-load');
  await playVideo(page);
  const progressed = await waitForPlaybackMovement(page, 30_000, 1);
  await queueScreenshot(page, artifacts, 'playback-start');
  return progressed;
};

const loadSentinelProfiles = async (): Promise<StudentProfile[]> => {
  if (!runtime.sentinelUsePreparedUsers || !runtime.loadUsersFile) {
    return [{
      email: runtime.studentEmail,
      password: runtime.studentPassword,
      label: 'primary-sentinel',
    }];
  }

  try {
    const raw = await fs.readFile(runtime.loadUsersFile, 'utf8');
    const parsed = JSON.parse(raw) as Array<{ email?: string }>;
    const picked = parsed
      .slice(0, Math.max(runtime.browserSentinelUsers, 1))
      .map((item, index) => ({
        email: String(item.email || '').trim(),
        password: runtime.studentPassword,
        label: `prepared-sentinel-${index + 1}`,
      }))
      .filter((item) => item.email);
    return picked.length ? picked : [{
      email: runtime.studentEmail,
      password: runtime.studentPassword,
      label: 'primary-sentinel',
    }];
  } catch {
    return [{
      email: runtime.studentEmail,
      password: runtime.studentPassword,
      label: 'primary-sentinel',
    }];
  }
};

const loginAsProfile = async (page: Page, profile: StudentProfile) => {
  await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
  const email = page.locator(selectors.loginEmail);
  if (await email.count()) {
    await email.fill(profile.email);
    await page.locator(selectors.loginPassword).fill(profile.password);
    await page.locator(selectors.loginSubmit).click();
  }
  const loginState = await waitForShellOrSessionConflict(page, 45_000);
  if (loginState === 'session-conflict') {
    await page.getByRole('button', { name: /log out older device and continue/i }).click();
  }
  await page.locator(selectors.shellReady).waitFor({ state: 'visible', timeout: 45_000 });
};

const runSentinelPlaybackSoak = async (
  browser: Browser,
  testCase: TestCaseDefinition,
  artifacts: CaseArtifacts,
  notes: string[],
) => {
  const profiles = await loadSentinelProfiles();
  const selectedProfiles = profiles
    .slice(0, Math.max(1, runtime.browserSentinelConcurrency))
    .map((profile, index) => ({ profile, index }));
  const failures: string[] = [];
  const results = await runWithPool(selectedProfiles, runtime.browserSentinelConcurrency, async ({ profile, index }) => {
    const sentinelContext = await createBrowserContext(browser, `${testCase.id}-${profile.label}-${index + 1}`);
    const sentinelPage = await sentinelContext.newPage();
    const collector = createCollector();
    attachCollectors(sentinelPage, collector);
    const sentinelArtifacts = await createCaseArtifacts(`${testCase.id}-${profile.label}-${index + 1}`);
    try {
      await loginAsProfile(sentinelPage, profile);
      await queueScreenshot(sentinelPage, sentinelArtifacts, 'login');
      await openCourseLessons(sentinelPage);
      await queueScreenshot(sentinelPage, sentinelArtifacts, 'lesson-open', true);
      await sentinelPage.locator(getVideoSelector()).waitFor({ state: 'visible', timeout: 30_000 });
      await queueScreenshot(sentinelPage, sentinelArtifacts, 'player-initialized');
      await playVideo(sentinelPage);
      await waitForPlaybackMovement(sentinelPage, 30_000, 1);
      await queueScreenshot(sentinelPage, sentinelArtifacts, 'playback-started');
      let previous = await readVideoSnapshot(sentinelPage);
      const checkpoints = runtime.sentinelCheckpointSeconds;
      for (const checkpointSeconds of checkpoints) {
        await sleep(Math.min(2_000, checkpointSeconds === checkpoints[0] ? 2_000 : 1_000));
        if (checkpointSeconds > 5) {
          notes.push(`Checkpoint ${checkpointSeconds}s armed for ${profile.email}. Use PLAYBACK_QA_SENTINEL_CHECKPOINT_SECONDS to shorten/lengthen soak windows.`);
        }
        const current = await readVideoSnapshot(sentinelPage);
        if (current.currentTime <= previous.currentTime && !current.paused) {
          throw new Error(`Sentinel playback did not advance for ${profile.email} at checkpoint ${checkpointSeconds}s`);
        }
        const label = checkpointSeconds >= 3600
          ? 'playback-60-minutes'
          : checkpointSeconds >= 2700
            ? 'playback-45-minutes'
            : checkpointSeconds >= 1800
              ? 'playback-30-minutes'
              : checkpointSeconds >= 900
                ? 'playback-15-minutes'
                : checkpointSeconds >= 300
                  ? 'playback-5-minutes'
                  : `playback-${checkpointSeconds}-seconds`;
        await queueScreenshot(sentinelPage, sentinelArtifacts, label);
        await saveCaseEvidence(`${testCase.id}-${profile.label}-${checkpointSeconds}`, sentinelArtifacts, collector, current, sentinelPage);
        previous = current;
      }
      await queueScreenshot(sentinelPage, sentinelArtifacts, 'playback-completion');
      const finalState = await readVideoSnapshot(sentinelPage);
      await saveCaseEvidence(`${testCase.id}-${profile.label}`, sentinelArtifacts, collector, finalState, sentinelPage);
      return {
        profile: profile.email,
        finalState,
        artifactDir: sentinelArtifacts.dir,
      };
    } catch (error) {
      failures.push(`${profile.email}: ${error instanceof Error ? error.message : String(error)}`);
      await queueScreenshot(sentinelPage, sentinelArtifacts, 'sentinel-failure-final', true).catch(() => undefined);
      const finalState = await readVideoSnapshot(sentinelPage).catch(() => null);
      await saveCaseEvidence(`${testCase.id}-${profile.label}`, sentinelArtifacts, collector, finalState, sentinelPage).catch(() => undefined);
      return {
        profile: profile.email,
        finalState: null,
        artifactDir: sentinelArtifacts.dir,
      };
    } finally {
      await sentinelContext.close().catch(() => undefined);
    }
  });

  notes.push(`Sentinel soak profiles: ${results.map((item: { profile: string; artifactDir: string }) => `${item.profile} -> ${item.artifactDir}`).join('; ')}`);
  if (failures.length) {
    throw new Error(failures.join(' | '));
  }
};

const runResourceCommand = async (label: string) => {
  if (!runtime.resourceCommand) {
    return null;
  }
  const filePath = path.join(runtime.reportRoot, `${safe(label)}-resources.txt`);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(runtime.resourceCommand, {
      cwd: cwdRoot,
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
        reject(new Error(`${runtime.resourceCommand} failed with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout || stderr);
    });
  });
  await writeText(filePath, output);
  return filePath;
};

const runHookCommand = async (command: string, label: string) => {
  if (!command) {
    throw new Error(`${label} hook command is not configured`);
  }
  const filePath = path.join(runtime.reportRoot, `${safe(label)}.log`);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      cwd: cwdRoot,
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
        reject(new Error(`${label} failed with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout || stderr || `${label} completed`);
    });
  });
  await writeText(filePath, output);
  return filePath;
};

const estimateCacheHitRatio = (samples: NetworkSample[]) => {
  const manifestSamples = samples.filter((sample) => /(\.m3u8|course-manifests)/i.test(sample.url));
  if (!manifestSamples.length) {
    return 0;
  }
  const hits = manifestSamples.filter((sample) => /hit/i.test(sample.cacheStatus)).length;
  return Number(((hits / manifestSamples.length) * 100).toFixed(2));
};

const runBrowserCase = async (browser: Browser, testCase: TestCaseDefinition, attempt: number): Promise<CaseResult> => {
  const started = Date.now();
  const artifacts = await createCaseArtifacts(testCase.id);
  const collector = createCollector();
  const notes: string[] = [];
  let page: Page | null = null;
  let context: BrowserContext | null = null;

  try {
    const mobile = testCase.id === 'auth-multi-device' || testCase.id === 'ui-mobile-viewport';
    context = await createBrowserContext(browser, testCase.id, mobile);
    page = await context.newPage();
    attachCollectors(page, collector);

    if (testCase.id === 'auth-valid-login') {
      await ensureLoggedIn(page);
      await queueScreenshot(page, artifacts, 'dashboard');
    } else if (testCase.id === 'auth-invalid-login') {
      await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.locator(selectors.loginEmail).fill(runtime.studentEmail);
      await page.locator(selectors.loginPassword).fill(runtime.invalidPassword);
      await queueScreenshot(page, artifacts, 'login');
      await page.locator(selectors.loginSubmit).click();
      await page.waitForTimeout(1_000);
      const bodyText = await page.locator('body').innerText();
      if (!/invalid|incorrect|failed|error/i.test(bodyText)) {
        throw new Error('Login failure message was not visible');
      }
      await queueScreenshot(page, artifacts, 'invalid-login');
    } else if (testCase.id === 'auth-expired-token') {
      await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => window.localStorage.setItem('edumaster.jwt', 'expired.invalid.token'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(selectors.loginEmail).waitFor({ state: 'visible', timeout: 20_000 });
      await queueScreenshot(page, artifacts, 'expired-token');
    } else if (testCase.id === 'auth-refresh-flow') {
      await ensureLoggedIn(page);
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator(selectors.shellReady).waitFor({ state: 'visible', timeout: 30_000 });
      await queueScreenshot(page, artifacts, 'dashboard');
    } else if (testCase.id === 'auth-concurrent-sessions') {
      await ensureLoggedIn(page);
      const secondContext = await createBrowserContext(browser, `${testCase.id}-second`);
      const secondPage = await secondContext.newPage();
      try {
        await ensureLoggedIn(secondPage);
        await secondPage.locator(selectors.shellReady).waitFor({ state: 'visible', timeout: 30_000 });
      } finally {
        await secondContext.close();
      }
      await queueScreenshot(page, artifacts, 'concurrent-session');
    } else if (testCase.id === 'auth-logout-during-playback') {
      await openLessonAndStartPlayback(page, artifacts);
      const token = await page.evaluate(() => window.localStorage.getItem('edumaster.jwt'));
      if (!token) {
        throw new Error('No token available for logout test');
      }
      await qaFetch(`${runtime.apiBase}/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      await page.evaluate(() => window.localStorage.removeItem('edumaster.jwt'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(selectors.loginEmail).waitFor({ state: 'visible', timeout: 20_000 });
      await queueScreenshot(page, artifacts, 'logout-during-playback');
    } else if (testCase.id === 'auth-retry-handling') {
      let failedOnce = false;
      await page.route('**/backend/api/auth/login', async (route) => {
        if (!failedOnce) {
          failedOnce = true;
          await route.fulfill({
            status: 502,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Injected login failure for retry validation' }),
          });
          return;
        }
        await route.fallback();
      });
      await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.locator(selectors.loginEmail).fill(runtime.studentEmail);
      await page.locator(selectors.loginPassword).fill(runtime.studentPassword);
      await page.locator(selectors.loginSubmit).click();
      await page.waitForTimeout(1_000);
      await page.locator(selectors.loginSubmit).click();
      await page.locator(selectors.shellReady).waitFor({ state: 'visible', timeout: 45_000 });
      notes.push('First auth attempt intentionally returned 502, second click succeeded.');
    } else if (testCase.id === 'auth-session-timeout-recovery') {
      await ensureLoggedIn(page);
      await page.evaluate(() => window.localStorage.removeItem('edumaster.jwt'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(selectors.loginEmail).waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator(selectors.loginEmail).fill(runtime.studentEmail);
      await page.locator(selectors.loginPassword).fill(runtime.studentPassword);
      await page.locator(selectors.loginSubmit).click();
      await page.locator(selectors.shellReady).waitFor({ state: 'visible', timeout: 45_000 });
    } else if (testCase.id === 'auth-multi-device') {
      await ensureLoggedIn(page);
      await queueScreenshot(page, artifacts, 'mobile-dashboard');
    } else if (testCase.id.startsWith('dashboard-')) {
      if (testCase.id === 'dashboard-api-failure') {
        await page.route('**/backend/api/courses*', async (route) => {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Injected dashboard courses failure' }),
          });
        });
      } else if (testCase.id === 'dashboard-slow-network') {
        await page.route('**/backend/api/courses*', async (route) => {
          await sleep(2_500);
          await route.fallback();
        });
      } else if (testCase.id === 'dashboard-empty-state') {
        await page.route('**/backend/api/courses*', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
          });
        });
      }
      await ensureLoggedIn(page);
      const coursesNav = page.locator(`${selectors.navCourses}, ${selectors.mobileNavCourses}, ${selectors.mobileTabCourses}`);
      if (await coursesNav.count()) {
        await coursesNav.first().click();
      }
      await page.waitForTimeout(testCase.id === 'dashboard-slow-network' ? 3_000 : 1_000);
      if (testCase.id === 'dashboard-empty-state') {
        await page.locator(selectors.courseCatalogEmpty).waitFor({ state: 'visible', timeout: 15_000 });
      } else if (testCase.id === 'dashboard-api-failure') {
        const bodyText = await page.locator('body').innerText();
        if (!/error|retry|unavailable|problem/i.test(bodyText)) {
          notes.push('Courses API failed, but no explicit fallback message was detected; shell remained interactive.');
        }
      } else {
        const courseList = page.locator(`${selectors.courseCard}, ${selectors.courseCatalogCard}, ${selectors.firstContinueCourse}`);
        if (testCase.id === 'dashboard-large-course-list') {
          const token = (await apiLogin(runtime.studentEmail, runtime.studentPassword)).token;
          const payload = await apiRequest<any>('/courses', { headers: { authorization: `Bearer ${token}` } }).catch(() => []);
          await page.route('**/backend/api/courses*', async (route) => {
            const list = Array.isArray(payload) ? payload : (payload?.courses || payload?.items || []);
            const expanded = Array.from({ length: Math.max(12, list.length || 1) }, (_, index) => {
              const source = list[index % Math.max(list.length, 1)] || { _id: `synthetic-${index}`, title: `Synthetic course ${index + 1}` };
              return { ...source, _id: `${source._id || 'synthetic'}-${index}`, title: `${source.title || 'Course'} ${index + 1}` };
            });
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(expanded),
            });
          });
          await page.reload({ waitUntil: 'domcontentloaded' });
          if (await coursesNav.count()) {
            await coursesNav.first().click();
          }
        }
        await courseList.first().waitFor({ state: 'visible', timeout: 20_000 });
        const count = await courseList.count();
        notes.push(`Detected ${count} course cards in browser.`);
      }
      await queueScreenshot(page, artifacts, 'dashboard-state');
    } else if (testCase.id.startsWith('nav-')) {
      await ensureLoggedIn(page);
      await openCourseLessons(page);
      await queueScreenshot(page, artifacts, 'course-page');
      if (testCase.id === 'nav-next-lesson') {
        const next = page.locator(`${selectors.coursePlayerNext}, ${selectors.courseNextVideo}, ${selectors.coursePlayerContinueNextLesson}`);
        if (!(await next.count())) {
          notes.push('Next lesson button not visible in current lesson state; player shell remained stable.');
        } else {
          await next.first().click();
          await page.waitForTimeout(2_000);
        }
      } else if (testCase.id === 'nav-previous-lesson') {
        const back = page.locator(`${selectors.courseBackToLessons}, ${selectors.courseBackToCatalog}`);
        await back.first().click();
        await page.waitForTimeout(1_000);
      } else if (testCase.id === 'nav-completed-lesson') {
        await playVideo(page);
        await waitForPlaybackMovement(page, 25_000, 1);
        const progressText = await page.locator(`${selectors.courseProgressPercent}, ${selectors.courseProgressLessonsCompleted}`).first().textContent().catch(() => '');
        notes.push(`Observed progress indicator: ${progressText || 'not-readable'}`);
      } else if (testCase.id === 'nav-rapid-lesson-switch') {
        const lessonRail = page.locator(`${selectors.coursePlaylistLesson}, ${selectors.firstCourseLessonRail}`);
        const count = Math.min(await lessonRail.count(), 3);
        for (let index = 0; index < count; index += 1) {
          await lessonRail.nth(index).click().catch(() => undefined);
          await page.waitForTimeout(750);
        }
      }
    } else if (testCase.id.startsWith('playback-') || testCase.id.startsWith('ui-') || testCase.id.startsWith('perf-') || testCase.id.startsWith('hls-') || testCase.id.startsWith('failure-') || testCase.id.startsWith('concurrency-')) {
      const delegatedSentinelCase = testCase.id === 'playback-sentinel-soak'
        || testCase.id === 'concurrency-mixed-course-soak'
        || testCase.id === 'failure-sentinel-restart-recovery';
      const startedPlayback = delegatedSentinelCase
        ? null
        : await openLessonAndStartPlayback(page, artifacts);
      if (startedPlayback) {
        notes.push(`Playback startup delta: ${startedPlayback.deltaTime.toFixed(2)}s`);
      }

      if (testCase.id === 'playback-sentinel-soak' || testCase.id === 'concurrency-mixed-course-soak') {
        await runSentinelPlaybackSoak(browser, testCase, artifacts, notes);
      } else if (testCase.id === 'playback-pause') {
        await pauseVideo(page);
        const snap = await readVideoSnapshot(page);
        if (!snap.paused) {
          throw new Error('Video did not pause');
        }
      } else if (testCase.id === 'playback-resume') {
        await pauseVideo(page);
        await playVideo(page);
        await waitForPlaybackMovement(page, 20_000, 1);
      } else if (testCase.id === 'playback-seek-forward') {
        await seekVideo(page, 15);
        await waitForPlaybackMovement(page, 20_000, 1);
      } else if (testCase.id === 'playback-seek-backward') {
        await seekVideo(page, -10);
        await waitForPlaybackMovement(page, 20_000, 1);
      } else if (testCase.id === 'playback-quality-switch') {
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent('edumaster:hls-set-level', { detail: { level: 0 } }));
        });
        await waitForPlaybackMovement(page, 20_000, 1);
      } else if (testCase.id === 'playback-autoplay') {
        const autoplay = page.locator(`${selectors.courseAutoplayToggle}, ${selectors.coursePlayerAutoplayToggle}`);
        if (await autoplay.count()) {
          await autoplay.first().click();
        } else {
          notes.push('Autoplay toggle not present for current lesson state.');
        }
      } else if (testCase.id === 'playback-muted-autoplay') {
        await page.evaluate((videoSelector) => {
          const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
          if (video) {
            video.muted = true;
          }
        }, getVideoSelector());
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openLessonAndStartPlayback(page, artifacts);
      } else if (testCase.id === 'playback-continuity' || testCase.id === 'ui-progress-updates' || testCase.id === 'perf-buffering') {
        await sleep(runtime.watchDurationsMs.medium);
        await waitForPlaybackMovement(page, 20_000, 2);
      } else if (testCase.id === 'playback-completion') {
        await seekVideo(page, 10_000);
        await sleep(3_000);
        const snap = await readVideoSnapshot(page);
        notes.push(`Completion state ended=${snap.ended} currentTime=${snap.currentTime.toFixed(2)} duration=${snap.duration.toFixed(2)}`);
      } else if (testCase.id === 'playback-replay') {
        await seekVideo(page, 10_000);
        const replay = page.locator(selectors.coursePlayerRewatchVideo);
        if (await replay.count()) {
          await replay.first().click().catch(() => undefined);
        } else {
          await seekVideo(page, -10_000);
          await playVideo(page);
        }
      } else if (testCase.id === 'hls-segment-retry') {
        let failedOnce = false;
        await page.route('**/*.{m4s,ts}', async (route) => {
          if (!failedOnce) {
            failedOnce = true;
            await route.abort('failed');
            return;
          }
          await route.fallback();
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openLessonAndStartPlayback(page, artifacts);
      } else if (testCase.id === 'hls-slow-segment') {
        await page.route('**/*.{m4s,ts}', async (route) => {
          await sleep(1_000);
          await route.fallback();
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openLessonAndStartPlayback(page, artifacts);
      } else if (testCase.id === 'hls-manifest-timeout') {
        await page.route('**/*.m3u8', async (route) => {
          await sleep(5_000);
          await route.abort('timedout');
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openCourseLessons(page);
        await page.waitForTimeout(3_000);
        const bodyText = await page.locator('body').innerText();
        if (!/error|retry|failed|unavailable/i.test(bodyText)) {
          notes.push('Timeout state did not show explicit copy; network failure was still captured.');
        }
      } else if (testCase.id === 'hls-stale-recovery') {
        let servedStale = false;
        await page.route('**/*.m3u8', async (route) => {
          if (!servedStale) {
            servedStale = true;
            await route.fulfill({
              status: 200,
              contentType: 'application/vnd.apple.mpegurl',
              body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST\n',
            });
            return;
          }
          await route.fallback();
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openLessonAndStartPlayback(page, artifacts);
      } else if (testCase.id === 'hls-corrupted-segment') {
        let corrupted = false;
        await page.route('**/*.{m4s,ts}', async (route) => {
          if (!corrupted) {
            corrupted = true;
            await route.fulfill({
              status: 200,
              contentType: 'video/mp2t',
              body: 'corrupted',
            });
            return;
          }
          await route.fallback();
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openCourseLessons(page);
        await page.waitForTimeout(3_000);
      } else if (testCase.id === 'failure-network-disconnect' || testCase.id === 'failure-reconnect-recovery' || testCase.id === 'concurrency-reconnects' || testCase.id === 'failure-player-retry') {
        await context.setOffline(true);
        await sleep(2_000);
        await context.setOffline(false);
        await playVideo(page).catch(() => undefined);
        await waitForPlaybackMovement(page, 25_000, 1);
      } else if (testCase.id === 'failure-auth-refresh-load') {
        const refreshed = await apiLogin(runtime.studentEmail, runtime.studentPassword);
        const playback = await apiGetPlayback(refreshed.token);
        notes.push(`Background auth refresh succeeded with stream format ${playback.streamFormat || 'unknown'}`);
        await waitForPlaybackMovement(page, 25_000, 1);
      } else if (testCase.id === 'failure-backend-restart') {
        await runHookCommand(runtime.backendRestartCommand, 'backend-restart');
        await waitForPlaybackMovement(page, 30_000, 1);
      } else if (testCase.id === 'failure-manifest-restart') {
        await runHookCommand(runtime.manifestRestartCommand, 'manifest-worker-restart');
        await waitForPlaybackMovement(page, 30_000, 1);
      } else if (testCase.id === 'failure-nginx-restart') {
        await runHookCommand(runtime.nginxRestartCommand, 'nginx-cache-restart');
        await waitForPlaybackMovement(page, 30_000, 1);
      } else if (testCase.id === 'failure-sentinel-restart-recovery') {
        if (runtime.backendRestartCommand) {
          await runHookCommand(runtime.backendRestartCommand, 'backend-restart-during-sentinel');
        } else if (runtime.manifestRestartCommand) {
          await runHookCommand(runtime.manifestRestartCommand, 'manifest-restart-during-sentinel');
        } else if (runtime.nginxRestartCommand) {
          await runHookCommand(runtime.nginxRestartCommand, 'nginx-restart-during-sentinel');
        } else {
          notes.push('No restart hook configured; sentinel soak ran without injected restart.');
        }
        await runSentinelPlaybackSoak(browser, testCase, artifacts, notes);
      } else if (testCase.id === 'failure-browser-crash-recovery') {
        await context.close();
        context = await createBrowserContext(browser, `${testCase.id}-recovery`);
        page = await context.newPage();
        attachCollectors(page, collector);
        await openLessonAndStartPlayback(page, artifacts);
      } else if (testCase.id === 'ui-responsive-layout') {
        await page.setViewportSize({ width: 1024, height: 768 });
        await queueScreenshot(page, artifacts, 'responsive-tablet', true);
      } else if (testCase.id === 'ui-fullscreen') {
        const fullscreenButton = page.locator(selectors.coursePlayerFullscreen);
        if (await fullscreenButton.count()) {
          await fullscreenButton.first().click();
          await page.waitForTimeout(500);
        } else {
          notes.push('Fullscreen control not present in current player shell.');
        }
      } else if (testCase.id === 'perf-first-frame' || testCase.id === 'perf-startup-latency') {
        notes.push(`First measured startup delta was ${startedPlayback.deltaTime.toFixed(2)}s`);
      } else if (testCase.id === 'perf-segment-latency' || testCase.id === 'perf-manifest-latency' || testCase.id === 'perf-cache-hit-ratio' || testCase.id === 'hls-cache-hit' || testCase.id === 'hls-cache-miss') {
        await sleep(5_000);
      } else if (testCase.id === 'perf-cpu-usage' || testCase.id === 'perf-memory-usage') {
        const resourcePath = await runResourceCommand(testCase.id);
        notes.push(resourcePath ? `Captured resource snapshot at ${resourcePath}` : 'No resource command configured.');
      } else if (testCase.id === 'perf-browser-resources') {
        const jsHeap = await page.evaluate(() => {
          const perf = performance as Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } };
          return perf.memory || null;
        });
        notes.push(`Browser memory snapshot: ${JSON.stringify(jsHeap)}`);
      } else if (testCase.id === 'concurrency-burst-joins' || testCase.id === 'concurrency-gradual-ramp' || testCase.id === 'concurrency-soak' || testCase.id === 'concurrency-simultaneous-seeks') {
        const cohortSize = runtime.browserSentinelUsers;
        const staggerMs = testCase.id === 'concurrency-gradual-ramp' ? 1_500 : 0;
        const start = Date.now();
        const failures: string[] = [];
        await runWithPool(Array.from({ length: cohortSize }, (_, index) => index), runtime.browserSentinelConcurrency, async (index) => {
          if (staggerMs && index > 0) {
            await sleep(staggerMs);
          }
          const childContext = await createBrowserContext(browser, `${testCase.id}-student-${index + 1}`);
          const childPage = await childContext.newPage();
          const childCollector = createCollector();
          attachCollectors(childPage, childCollector);
          try {
            const childArtifacts = await createCaseArtifacts(`${testCase.id}-student-${index + 1}`);
            await openLessonAndStartPlayback(childPage, childArtifacts);
            if (testCase.id === 'concurrency-simultaneous-seeks') {
              await seekVideo(childPage, 20);
              await seekVideo(childPage, -10);
            }
            await sleep(testCase.id === 'concurrency-soak' ? runtime.watchDurationsMs.soak : runtime.watchDurationsMs.short);
            await waitForPlaybackMovement(childPage, 20_000, 1);
          } catch (error) {
            failures.push(`student-${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            await childContext.close();
          }
        });
        notes.push(`Sentinel cohort completed in ${Date.now() - start}ms with ${failures.length} failures.`);
        if (failures.length) {
          throw new Error(failures.slice(0, 5).join(' | '));
        }
      }

      const snap = page ? await readVideoSnapshot(page) : { exists: true };
      if (testCase.id.startsWith('playback-') || testCase.id.startsWith('ui-') || testCase.id.startsWith('perf-') || testCase.id.startsWith('hls-') || testCase.id.startsWith('failure-')) {
        if (!snap.exists) {
          throw new Error('Video element was not available in playback test');
        }
      }
      if (testCase.id === 'ui-controls-visible') {
        const controls = page.locator(`${selectors.coursePlayerToggle}, ${selectors.coursePlayerFullscreen}, ${selectors.coursePlayerSpeed}`);
        if (!(await controls.count())) {
          throw new Error('Expected playback controls were not visible');
        }
      }
      if (testCase.id === 'ui-spinner-behavior') {
        const bodyText = await page.locator('body').innerText();
        notes.push(`UI copy snapshot length=${bodyText.length}`);
      }
      if (testCase.id === 'ui-error-message' || testCase.id === 'hls-manifest-timeout') {
        const bodyText = await page.locator('body').innerText();
        if (!/error|retry|failed|unavailable|problem/i.test(bodyText)) {
          notes.push('No explicit error copy detected; rely on network failure + screenshots.');
        }
      }
      if (testCase.id === 'ui-player-visible') {
        await page.locator(selectors.coursePlayerShell).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
      }
      await queueScreenshot(page, artifacts, testCase.id.includes('failure') ? 'retry-state' : 'playback-healthy');
    } else {
      throw new Error(`Unhandled browser case ${testCase.id}`);
    }

    const playerState = page ? await readVideoSnapshot(page).catch(() => null) : null;
    await saveCaseEvidence(testCase.id, artifacts, collector, playerState, page || undefined);
    return {
      id: testCase.id,
      category: testCase.category,
      title: testCase.title,
      automation: testCase.automation,
      status: 'passed',
      durationMs: Date.now() - started,
      attempts: attempt,
      notes,
      artifacts,
      metrics: {
        networkSamples: collector.network.length,
        consoleLines: collector.console.length,
        pageErrors: collector.pageErrors.length,
        failedRequests: collector.failedRequests.length,
        manifestCacheHitRatio: estimateCacheHitRatio(collector.network),
      },
    };
  } catch (error) {
    if (page) {
      await queueScreenshot(page, artifacts, 'failure-final', true).catch(() => undefined);
    }
    const playerState = page ? await readVideoSnapshot(page).catch(() => null) : null;
    await saveCaseEvidence(testCase.id, artifacts, collector, playerState, page || undefined).catch(() => undefined);
    return {
      id: testCase.id,
      category: testCase.category,
      title: testCase.title,
      automation: testCase.automation,
      status: 'failed',
      durationMs: Date.now() - started,
      attempts: attempt,
      notes,
      artifacts,
      metrics: {
        networkSamples: collector.network.length,
        consoleLines: collector.console.length,
        pageErrors: collector.pageErrors.length,
        failedRequests: collector.failedRequests.length,
        manifestCacheHitRatio: estimateCacheHitRatio(collector.network),
      },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
  }
};

const mutateUrl = (value: string, mutator: (url: URL) => void) => {
  const url = new URL(value, runtime.baseUrl);
  mutator(url);
  return url.toString();
};

const runApiCase = async (testCase: TestCaseDefinition, attempt: number): Promise<CaseResult> => {
  const started = Date.now();
  const artifacts = await createCaseArtifacts(testCase.id);
  const notes: string[] = [];
  try {
    if (testCase.id === 'dashboard-pagination') {
      const session = await apiLogin(runtime.studentEmail, runtime.studentPassword);
      const { first, second } = await pickCourseApiPages(session.token);
      notes.push(`Page 1 payload keys: ${Object.keys(first || {}).join(', ') || 'array'}`);
      notes.push(`Page 2 payload keys: ${Object.keys(second || {}).join(', ') || 'array'}`);
    } else if (testCase.id === 'nav-locked-lesson' || testCase.id === 'nav-invalid-lesson') {
      const session = await apiLogin(runtime.studentEmail, runtime.studentPassword);
      let failed = false;
      try {
        await apiRequest(`/courses/${runtime.courseId}/lessons/non-existent-lesson/player`, {
          headers: { authorization: `Bearer ${session.token}` },
        });
      } catch (error) {
        failed = true;
        notes.push(error instanceof Error ? error.message : String(error));
      }
      if (!failed) {
        throw new Error('Invalid lesson access unexpectedly succeeded');
      }
    } else if (testCase.id.startsWith('security-') || testCase.id === 'hls-invalid-manifest') {
      const session = await apiLogin(runtime.studentEmail, runtime.studentPassword);
      const playback = await apiGetPlayback(session.token);
      const playbackUrl = playback.streamUrl || '';
      if (!playbackUrl) {
        throw new Error('Playback URL is not available for security checks');
      }
      const unauthorizedResponse = await qaFetch(playbackUrl, { method: 'GET' });
      if (testCase.id === 'security-unauthorized-manifest' && unauthorizedResponse.ok) {
        throw new Error('Unauthorized manifest unexpectedly returned success');
      }
      if (testCase.id === 'security-expired-playback-token' || testCase.id === 'security-replay-attack') {
        const mutated = mutateUrl(playbackUrl, (url) => {
          const expires = url.searchParams.get('expires') || url.searchParams.get('exp');
          if (expires) {
            url.searchParams.set(url.searchParams.has('expires') ? 'expires' : 'exp', '1');
          } else {
            url.searchParams.set('expires', '1');
          }
        });
        const response = await qaFetch(mutated);
        if (response.ok) {
          throw new Error('Expired or replayed playback URL unexpectedly succeeded');
        }
      }
      if (testCase.id === 'security-invalid-signature' || testCase.id === 'hls-invalid-manifest') {
        const mutated = mutateUrl(playbackUrl, (url) => {
          if (url.searchParams.has('sig')) {
            url.searchParams.set('sig', 'tampered');
          } else {
            const parts = url.pathname.split('/');
            parts[parts.length - 1] = `tampered-${parts[parts.length - 1]}`;
            url.pathname = parts.join('/');
          }
        });
        const response = await qaFetch(mutated);
        if (response.ok) {
          throw new Error('Tampered signature unexpectedly succeeded');
        }
      }
      if (testCase.id === 'security-cross-user-playback') {
        const second = await apiLogin(runtime.studentEmail, runtime.studentPassword);
        const response = await qaFetch(playbackUrl, {
          headers: { authorization: `Bearer ${second.token}` },
        });
        notes.push(`Cross-user playback response status ${response.status}`);
      }
      if (testCase.id === 'security-direct-segment') {
        const manifestText = await (await qaFetch(playbackUrl, { headers: { authorization: `Bearer ${session.token}` } })).text();
        const segment = manifestText.split('\n').find((line) => line && !line.startsWith('#'));
        if (!segment) {
          throw new Error('Could not locate a direct segment path from manifest');
        }
        const segmentUrl = new URL(segment, playbackUrl).toString();
        const response = await qaFetch(segmentUrl);
        if (response.ok) {
          notes.push(`Direct segment access succeeded with status ${response.status}; path may be intentionally signed/static.`);
        } else {
          notes.push(`Direct segment access denied with status ${response.status}.`);
        }
      }
    } else {
      throw new Error(`Unhandled api case ${testCase.id}`);
    }

    await writeJson(path.join(artifacts.dir, 'summary.json'), { notes });
    return {
      id: testCase.id,
      category: testCase.category,
      title: testCase.title,
      automation: testCase.automation,
      status: 'passed',
      durationMs: Date.now() - started,
      attempts: attempt,
      notes,
      artifacts,
      metrics: {},
    };
  } catch (error) {
    await writeJson(path.join(artifacts.dir, 'summary.json'), {
      notes,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return {
      id: testCase.id,
      category: testCase.category,
      title: testCase.title,
      automation: testCase.automation,
      status: 'failed',
      durationMs: Date.now() - started,
      attempts: attempt,
      notes,
      artifacts,
      metrics: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const hasHookForCase = (caseId: string) => {
  if (caseId === 'failure-backend-restart') {
    return Boolean(runtime.backendRestartCommand);
  }
  if (caseId === 'failure-manifest-restart') {
    return Boolean(runtime.manifestRestartCommand);
  }
  if (caseId === 'failure-nginx-restart') {
    return Boolean(runtime.nginxRestartCommand);
  }
  return true;
};

const runSingleCase = async (browser: Browser, testCase: TestCaseDefinition) => {
  let finalResult: CaseResult | null = null;
  for (let attempt = 1; attempt <= runtime.caseRetries + 1; attempt += 1) {
    const result = testCase.automation === 'api'
      ? await runApiCase(testCase, attempt)
      : testCase.automation === 'hook' && !hasHookForCase(testCase.id)
        ? {
          id: testCase.id,
          category: testCase.category,
          title: testCase.title,
          automation: testCase.automation,
          status: 'skipped' as CaseStatus,
          durationMs: 0,
          attempts: attempt,
          notes: ['Hook command not configured for this resilience case.'],
          artifacts: await createCaseArtifacts(testCase.id),
          metrics: {},
        }
        : await runBrowserCase(browser, testCase, attempt);
    finalResult = result;
    if (result.status === 'passed') {
      if (attempt > 1) {
        result.status = 'flaky';
        result.notes.push(`Passed after retry attempt ${attempt}.`);
      }
      break;
    }
    if (attempt <= runtime.caseRetries) {
      await sleep(1_000 * attempt);
    }
  }
  return finalResult!;
};

const runWithPool = async <T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) => {
  const results: R[] = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
};

const findNewestReportDir = async (prefix: string, beforeNames: Set<string>) => {
  const reportsDir = path.join(cwdRoot, 'reports');
  const after = await listFilesSorted(reportsDir, prefix);
  const created = after.filter((name) => !beforeNames.has(name));
  const latest = created[created.length - 1] || after[after.length - 1];
  if (!latest) {
    throw new Error(`Could not find generated load report for prefix ${prefix}`);
  }
  return path.join(reportsDir, latest);
};

const runLoadRung = async (users: number): Promise<LoadRungResult> => {
  const prefix = `course-video-production-ladder-${users}`;
  const reportsDir = path.join(cwdRoot, 'reports');
  const beforeNames = new Set(await listFilesSorted(reportsDir, prefix));
  const resourceSnapshotPath = await runResourceCommand(`load-before-${users}`).catch(() => null);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', 'src/course-video-1000-load-review.ts'], {
      cwd: cwdRoot,
      env: {
        ...process.env,
        QA_BASE_URL: runtime.baseUrl,
        COURSE_LOAD_USERS: String(users),
        COURSE_LOAD_ACTIVE_CONCURRENCY: String(users),
        COURSE_LOAD_SETUP_CONCURRENCY: String(runtime.loadSetupConcurrency),
        COURSE_LOAD_USERS_FILE: runtime.loadUsersFile || process.env.COURSE_LOAD_USERS_FILE || '',
        COURSE_LOAD_REPORT_PREFIX: prefix,
      },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Load rung ${users} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  const reportDir = await findNewestReportDir(prefix, beforeNames);
  const reportJsonPath = path.join(reportDir, 'full-course-video-report.json');
  const reportMarkdownPath = path.join(reportDir, 'full-course-video-report.md');
  const summary = JSON.parse(await fs.readFile(reportJsonPath, 'utf8')) as {
    successfulJourneys: number;
    failedJourneys: number;
    totalRequests: number;
    failedRequests: number;
    wallClockMs: number;
    endpointSummary?: Array<{
      name: string;
      successRate: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
    }>;
  };
  const manifest = summary.endpointSummary?.find((entry) => entry.name === 'course.video.mediaManifest');
  const postResourceSnapshotPath = await runResourceCommand(`load-after-${users}`).catch(() => null);
  return {
    users,
    mode: 'stepped-ladder',
    reportDir,
    reportJsonPath,
    reportMarkdownPath,
    successfulJourneys: summary.successfulJourneys,
    failedJourneys: summary.failedJourneys,
    playbackStartupSuccessRate: Number((((summary.successfulJourneys || 0) / Math.max(users, 1)) * 100).toFixed(2)),
    manifestP50Ms: manifest?.p50Ms || 0,
    manifestP95Ms: manifest?.p95Ms || 0,
    manifestP99Ms: manifest?.p99Ms || 0,
    manifestSuccessRate: manifest?.successRate || 0,
    totalRequests: summary.totalRequests,
    failedRequests: summary.failedRequests,
    wallClockMs: summary.wallClockMs,
    resourceSnapshotPath: postResourceSnapshotPath || resourceSnapshotPath,
  };
};

const writeCsv = async (filePath: string, rows: Array<Record<string, string | number | boolean | null>>) => {
  if (!rows.length) {
    await writeText(filePath, '');
    return;
  }
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => JSON.stringify(row[header] ?? '')).join(',')),
  ];
  await writeText(filePath, `${lines.join('\n')}\n`);
};

const renderHtml = (caseResults: CaseResult[], loadResults: LoadRungResult[]) => {
  const passed = caseResults.filter((result) => result.status === 'passed').length;
  const failed = caseResults.filter((result) => result.status === 'failed').length;
  const flaky = caseResults.filter((result) => result.status === 'flaky').length;
  const skipped = caseResults.filter((result) => result.status === 'skipped').length;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Edumaster Course Video Production QA</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #1b2430; }
    h1, h2 { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { border: 1px solid #d7dde6; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f6fa; }
    .passed { color: #0a7a33; }
    .failed { color: #b42318; }
    .flaky { color: #b54708; }
    .skipped { color: #667085; }
    .gallery img { width: 240px; border: 1px solid #d7dde6; margin: 8px 8px 0 0; }
    code { background: #f3f6fa; padding: 2px 4px; }
  </style>
</head>
<body>
  <h1>Edumaster Course Video Production QA</h1>
  <p>Run id: <code>${runtime.reportId}</code></p>
  <p>Base URL: <code>${runtime.baseUrl}</code></p>
  <p>Case summary: <strong class="passed">${passed} passed</strong>, <strong class="failed">${failed} failed</strong>, <strong class="flaky">${flaky} flaky</strong>, <strong class="skipped">${skipped} skipped</strong></p>

  <h2>Test Matrix Results</h2>
  <table>
    <thead>
      <tr><th>Category</th><th>Case</th><th>Status</th><th>Automation</th><th>Duration</th><th>Notes</th><th>Artifacts</th></tr>
    </thead>
    <tbody>
      ${caseResults.map((result) => `
        <tr>
          <td>${result.category}</td>
          <td>${result.title}</td>
          <td class="${result.status}">${result.status}</td>
          <td>${result.automation}</td>
          <td>${result.durationMs} ms</td>
          <td>${(result.error ? [`Error: ${result.error}`] : []).concat(result.notes).join('<br/>')}</td>
          <td><code>${result.artifacts.dir}</code></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <h2>Load Ladder</h2>
  <table>
    <thead>
      <tr><th>Users</th><th>Startup Success %</th><th>Manifest p50</th><th>Manifest p95</th><th>Manifest p99</th><th>Manifest Success %</th><th>Journeys</th><th>Report</th></tr>
    </thead>
    <tbody>
      ${loadResults.map((result) => `
        <tr>
          <td>${result.users}</td>
          <td>${result.playbackStartupSuccessRate}</td>
          <td>${result.manifestP50Ms} ms</td>
          <td>${result.manifestP95Ms} ms</td>
          <td>${result.manifestP99Ms} ms</td>
          <td>${result.manifestSuccessRate}</td>
          <td>${result.successfulJourneys}/${result.users}</td>
          <td><code>${result.reportDir}</code></td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <h2>Screenshot Gallery</h2>
  <div class="gallery">
    ${caseResults.flatMap((result) => result.artifacts.screenshots.slice(0, 2).map((filePath) => `<figure><img src="${path.relative(runtime.reportRoot, filePath)}" alt="${result.id}" /><figcaption>${result.id}</figcaption></figure>`)).join('')}
  </div>
</body>
</html>`;
};

const main = async () => {
  await cleanupOldRuns();
  await ensureDir(runtime.reportRoot);
  await writeJson(path.join(runtime.reportRoot, 'test-case-matrix.json'), FILTERED_TEST_MATRIX);

  const browser = await chromium.launch({
    headless: runtime.headless,
    args: buildChromeArgs(),
  });

  const executableSummary: Record<string, number> = {};
  for (const item of FILTERED_TEST_MATRIX) {
    executableSummary[item.category] = (executableSummary[item.category] || 0) + 1;
  }
  await writeJson(path.join(runtime.reportRoot, 'matrix-category-summary.json'), executableSummary);

  const nonLoadCases = FILTERED_TEST_MATRIX.filter((testCase) => testCase.automation !== 'load');
  const caseResults = await runWithPool(nonLoadCases, runtime.browserWorkers, async (testCase) => runSingleCase(browser, testCase));
  await browser.close();
  await artifactWriter.flush();

  const loadResults: LoadRungResult[] = [];
  if (!runtime.skipLoad) {
    for (const users of [250, 750, 1000]) {
      loadResults.push(await runLoadRung(users));
    }
  }

  const summary = {
    runId: runtime.reportId,
    generatedAt: nowIso(),
    host: os.hostname(),
    baseUrl: runtime.baseUrl,
    matrixTotals: {
      total: caseResults.length,
      passed: caseResults.filter((result) => result.status === 'passed').length,
      failed: caseResults.filter((result) => result.status === 'failed').length,
      flaky: caseResults.filter((result) => result.status === 'flaky').length,
      skipped: caseResults.filter((result) => result.status === 'skipped').length,
    },
    playbackReliabilityPercent: Number((((caseResults.filter((result) => result.status === 'passed' || result.status === 'flaky').length) / Math.max(caseResults.length, 1)) * 100).toFixed(2)),
    caseResults,
    loadResults,
  };

  const csvRows = caseResults.map((result) => ({
    id: result.id,
    category: result.category,
    title: result.title,
    status: result.status,
    automation: result.automation,
    durationMs: result.durationMs,
    attempts: result.attempts,
    error: result.error || '',
    artifactsDir: result.artifacts.dir,
  }));

  await Promise.all([
    writeJson(path.join(runtime.reportRoot, 'summary.json'), summary),
    writeCsv(path.join(runtime.reportRoot, 'summary.csv'), csvRows),
    writeText(path.join(runtime.reportRoot, 'summary.html'), renderHtml(caseResults, loadResults)),
  ]);

  const failedCases = caseResults.filter((result) => result.status === 'failed').map((result) => ({
    id: result.id,
    category: result.category,
    title: result.title,
    error: result.error || 'unknown',
    artifactsDir: result.artifacts.dir,
  }));
  await writeJson(path.join(runtime.reportRoot, 'failure-drilldown.json'), failedCases);

  console.log(`Production QA run complete: ${runtime.reportRoot}`);
};

main().catch((error) => {
  console.error('Course video production QA failed:', error);
  process.exitCode = 1;
});
