import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page } from 'puppeteer-core';
import { config } from './config.js';
import {
  classifyRecordedDeliveryPath,
  createDeliveryPathBreakdown,
  normalizeRecordedDeliveryPath,
  type RecordedDeliveryPath,
} from './recorded-delivery-path.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type ViewerNetworkSample = {
  url: string;
  status: number;
  durationMs: number;
  contentType: string;
};

type ViewerVideoEvent = {
  type: string;
  at: number;
  currentTime: number | null;
  duration: number | null;
  paused: boolean | null;
  readyState: number | null;
  networkState: number | null;
  buffered: Array<[number, number]>;
  extra?: Record<string, unknown>;
};

type ViewerNavigationSnapshot = {
  label: string;
  at: string;
  url: string;
  title: string;
  readyState: string | null;
  bodyTextSnippet: string;
  loginVisible: boolean;
  shellVisible: boolean;
  coursesVisible: boolean;
  playerVisible: boolean;
  playerUnavailableVisible: boolean;
  videoCount: number;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  note?: string;
};

type ViewerBootTelemetryEvent = {
  name: string;
  at: string;
  elapsedMs: number;
  payload?: Record<string, unknown>;
};

type ViewerBootTelemetrySnapshot = {
  startedAtIso: string | null;
  startedAtEpochMs: number | null;
  shellReady: boolean;
  lastRouteMarker: string | null;
  events: ViewerBootTelemetryEvent[];
};

type ViewerFailureClassification =
  | 'boot_failure'
  | 'asset_failure'
  | 'runtime_crash'
  | 'route_never_visible'
  | 'player_failure_after_shell'
  | 'playback_failure'
  | 'unknown';

type ViewerFailurePhase = 'boot' | 'route' | 'player' | 'playback' | 'unknown';

type ViewerResult = {
  viewerId: number;
  email: string;
  viewport: 'desktop' | 'mobile';
  ok: boolean;
  stage: number;
  currentTimeStart: number | null;
  currentTimeEnd: number | null;
  maxCurrentTimeObserved: number | null;
  progressedSeconds: number | null;
  firstFrameReached: boolean;
  startupDelayMs: number | null;
  manifestRequests: number;
  manifestFailures: number;
  segmentRequests: number;
  segmentFailures: number;
  playbackConflictCount: number;
  screenshots: string[];
  consoleErrors: string[];
  pageErrors: string[];
  networkFailures: Array<{ status: number; url: string }>;
  videoEventsPath?: string;
  navigationSnapshotsPath?: string;
  failureSourcePath?: string;
  bootTelemetryPath?: string;
  deliveryPath: RecordedDeliveryPath | null;
  midStreamEvidence?: {
    screenshotPath: string;
    currentTime: number | null;
    duration: number | null;
    paused: boolean | null;
    readyState: number | null;
    playbackConflictVisible: boolean;
    unavailableVisible: boolean;
  } | null;
  failureClassification: ViewerFailureClassification | null;
  failurePhase: ViewerFailurePhase | null;
  activeVideoDebug?: {
    videoCount: number;
    activeVideoIndex: number | null;
  };
  error?: string;
};

type StageSummary = {
  viewers: number;
  startedAt: string;
  completedAt?: string;
  ok: boolean;
  successCount: number;
  failureCount: number;
  failureBreakdown: Record<ViewerFailureClassification, number>;
  deliveryPathBreakdown: Record<RecordedDeliveryPath, number>;
  manifestFailures: number;
  segmentFailures: number;
  playbackConflicts: number;
  averageStartupDelayMs: number | null;
  averageProgressSeconds: number | null;
  p95StartupDelayMs: number | null;
  p99StartupDelayMs: number | null;
  p95ProgressSeconds: number | null;
  p99ProgressSeconds: number | null;
  midStreamRequirementSatisfied: boolean;
  midStreamEvidence: {
    desktopScreenshots: string[];
    mobileScreenshots: string[];
  };
  resultsPath: string;
  screenshotDir: string;
};

type RunSummary = {
  baseUrl: string;
  lessonUrl: string;
  manifestPath: string;
  stages: StageSummary[];
  realBrowserUsers: number;
  watchWindowMs: number;
  stageConcurrencyCap: number;
  captureMidStreamScreenshots: boolean;
  overallOk: boolean;
  notes: string[];
};

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || config.baseUrl).replace(/\/+$/, '');
const manifestPath = process.env.PLATFORM_LOAD_USERS_FILE || process.env.COURSE_LOAD_USERS_FILE || '';
const courseId = String(process.env.QA_COURSE_ID || process.env.PLATFORM_LOAD_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2').trim();
const lessonId = String(process.env.QA_LESSON_ID || process.env.PLATFORM_LOAD_LESSON_ID || 'video_1780146736089_8d3b641cf7').trim();
const courseText = String(process.env.QA_COURSE_TEXT || 'SSC').trim();
const lessonText = String(process.env.QA_LESSON_TEXT || 'INTRODUCTION').trim();
const watchWindowMs = Math.max(20_000, Number(process.env.QA_VIDEO_BROWSER_WATCH_WINDOW_MS || 75_000));
const videoReadyTimeoutMs = Math.max(20_000, Number(process.env.QA_VIDEO_BROWSER_READY_TIMEOUT_MS || 45_000));
const playbackActivationTimeoutMs = Math.max(15_000, Number(process.env.QA_VIDEO_BROWSER_PLAY_TIMEOUT_MS || 30_000));
const firstFrameTimeoutMs = Math.max(20_000, Number(process.env.QA_VIDEO_BROWSER_FIRST_FRAME_TIMEOUT_MS || 45_000));
const firstFrameRetryTimeoutMs = Math.max(8_000, Number(process.env.QA_VIDEO_BROWSER_FIRST_FRAME_RETRY_TIMEOUT_MS || 20_000));
const stageViewerCounts = String(process.env.QA_VIDEO_BROWSER_STAGES || '1,3,10,15,25,50')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const screenshotSample = Math.max(1, Number(process.env.QA_VIDEO_BROWSER_SCREENSHOT_SAMPLE || 5));
const stageConcurrencyCap = Math.max(1, Number(process.env.QA_VIDEO_BROWSER_STAGE_CONCURRENCY || 50));
const mobileRatio = Math.max(0, Math.min(1, Number(process.env.QA_VIDEO_BROWSER_MOBILE_RATIO || 0.4)));
const separateBrowserPerViewer = process.env.QA_VIDEO_BROWSER_SEPARATE_BROWSER === '1';
const preparedUserPassword = String(process.env.PLATFORM_LOAD_USER_PASSWORD || process.env.QA_LOGIN_PASSWORD || 'Student@123').trim();
const screenshotTimeoutMs = Math.max(5_000, Number(process.env.QA_VIDEO_BROWSER_SCREENSHOT_TIMEOUT_MS || 20_000));
const viewerLaunchStaggerMs = Math.max(0, Number(process.env.QA_VIDEO_BROWSER_VIEWER_STAGGER_MS || 250));
const viewerSetupRetries = Math.max(0, Number(process.env.QA_VIDEO_BROWSER_SETUP_RETRIES || 1));
const captureMidStreamScreenshots = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_VIDEO_BROWSER_CAPTURE_MID_STREAM_SCREENSHOTS || '').toLowerCase());
const hlsPattern = /\/backend\/api\/course-manifests\/|\/backend\/api\/courses\/stream\/|\.m3u8(?:\?|$)|\.(?:ts|m4s|mp4)(?:\?|$)/i;
const nonEssentialResourceTypes = new Set(['image', 'font']);

const percentile = (values: number[], target: number) => {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values: number[]) => {
  if (!values.length) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
};

const createFailureBreakdown = (): Record<ViewerFailureClassification, number> => ({
  boot_failure: 0,
  asset_failure: 0,
  runtime_crash: 0,
  route_never_visible: 0,
  player_failure_after_shell: 0,
  playback_failure: 0,
  unknown: 0,
});

const extractDeliveryPathFromVideoEvents = (videoEvents: ViewerVideoEvent[]): RecordedDeliveryPath | null => {
  for (const event of videoEvents) {
    const extra = event.extra || {};
    const explicit = normalizeRecordedDeliveryPath(extra.deliveryPath);
    if (explicit) {
      return explicit;
    }

    const classified = classifyRecordedDeliveryPath({
      deliveryProfile: typeof extra.deliveryProfile === 'string' ? extra.deliveryProfile : null,
      streamFormat: typeof extra.streamFormat === 'string' ? extra.streamFormat : null,
      src: typeof extra.src === 'string' ? extra.src : null,
      fallbackActive: Boolean(extra.fallbackActive),
      drmEnabled: Boolean(extra.drmEnabled),
    });
    if (classified !== 'unknown') {
      return classified;
    }
  }

  return null;
};

const extractDeliveryPathFromNetwork = (samples: ViewerNetworkSample[]): RecordedDeliveryPath | null => {
  for (const sample of samples) {
    const classified = classifyRecordedDeliveryPath({
      src: sample.url,
      streamFormat: /\.m3u8(?:\?|$)/i.test(sample.url) ? 'hls' : /\.(?:mp4|webm|mov)(?:\?|$)/i.test(sample.url) ? 'source' : null,
    });
    if (classified !== 'unknown') {
      return classified;
    }
  }

  return null;
};

const criticalAssetPattern = /(?:loading chunk|failed to fetch dynamically imported module|javascript-or-wasm module script|module script|stylesheet|\/assets\/.+\.(?:js|css))/i;

const hasCriticalAssetLoadFailure = (bootTelemetry: ViewerBootTelemetrySnapshot | null) =>
  Boolean(
    bootTelemetry?.events?.some((event) => {
      if (event.name !== 'asset_load_failure') {
        return false;
      }
      const payload = event.payload || {};
      const tagName = String(payload.tagName || '').toLowerCase();
      const url = String(payload.url || '');
      return tagName === 'script'
        || tagName === 'link'
        || /\/assets\/.+\.(?:js|css)(?:\?|$)/i.test(url)
        || /\.(?:js|css)(?:\?|$)/i.test(url);
    }),
  );

const hasCriticalAssetConsoleFailure = (consoleErrors: string[]) =>
  consoleErrors.some((message) => criticalAssetPattern.test(message));

const hasBootTelemetryEvent = (
  bootTelemetry: ViewerBootTelemetrySnapshot | null,
  eventName: string,
) => Boolean(bootTelemetry?.events?.some((event) => event.name === eventName));

const classifyViewerFailure = (params: {
  bootTelemetry: ViewerBootTelemetrySnapshot | null;
  navigationSnapshots: ViewerNavigationSnapshot[];
  consoleErrors: string[];
  pageErrors: string[];
  errorMessage?: string;
  firstFrameReached?: boolean;
}) => {
  const latestSnapshot = params.navigationSnapshots[params.navigationSnapshots.length - 1] || null;
  const bodyText = String(latestSnapshot?.bodyTextSnippet || '').toLowerCase();
  const shellVisible = Boolean(latestSnapshot?.shellVisible || params.bootTelemetry?.shellReady);
  const routeVisible = Boolean(
    latestSnapshot?.shellVisible
    || latestSnapshot?.coursesVisible
    || latestSnapshot?.playerVisible
    || hasBootTelemetryEvent(params.bootTelemetry, 'route_visible')
    || (params.bootTelemetry?.lastRouteMarker && params.bootTelemetry.lastRouteMarker !== 'unknown'),
  );

  if (
    hasCriticalAssetLoadFailure(params.bootTelemetry)
    || hasCriticalAssetConsoleFailure(params.consoleErrors)
  ) {
    return {
      failureClassification: 'asset_failure' as const,
      failurePhase: 'boot' as const,
    };
  }

  if (
    hasBootTelemetryEvent(params.bootTelemetry, 'runtime_error')
    || hasBootTelemetryEvent(params.bootTelemetry, 'unhandled_rejection')
    || params.pageErrors.length > 0
  ) {
    return {
      failureClassification: 'runtime_crash' as const,
      failurePhase: 'boot' as const,
    };
  }

  if (hasBootTelemetryEvent(params.bootTelemetry, 'empty_root_timeout')) {
    return {
      failureClassification: 'boot_failure' as const,
      failurePhase: 'boot' as const,
    };
  }

  if (!routeVisible) {
    return {
      failureClassification: 'route_never_visible' as const,
      failurePhase: 'route' as const,
    };
  }

  if (shellVisible && !params.firstFrameReached) {
    return {
      failureClassification: 'player_failure_after_shell' as const,
      failurePhase: 'player' as const,
    };
  }

  if (/another tab|another device|playback stopped|lesson video unavailable|could not/i.test(bodyText)) {
    return {
      failureClassification: 'playback_failure' as const,
      failurePhase: 'playback' as const,
    };
  }

  if (params.errorMessage && /first frame|progression|video/i.test(params.errorMessage.toLowerCase())) {
    return {
      failureClassification: 'playback_failure' as const,
      failurePhase: shellVisible ? 'playback' as const : 'player' as const,
    };
  }

  return {
    failureClassification: shellVisible ? 'player_failure_after_shell' as const : 'unknown' as const,
    failurePhase: shellVisible ? 'player' as const : 'unknown' as const,
  };
};

const lessonUrl = `${baseUrl}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`;
const apiOrigin = new URL(baseUrl).origin;

const loadUsers = async () => {
  if (!manifestPath) {
    throw new Error('PLATFORM_LOAD_USERS_FILE or COURSE_LOAD_USERS_FILE is required.');
  }
  const users = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PreparedUser[];
  if (!Array.isArray(users) || !users.length) {
    throw new Error(`Prepared user manifest is empty: ${manifestPath}`);
  }
  return users;
};

const loginPreparedUser = async (email: string, viewerId: number) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: preparedUserPassword,
      device: `QA Browser Concurrency ${viewerId}`,
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(`Unable to refresh QA browser session for ${email}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return String(payload.token);
};

const getViewport = (viewerId: number): 'desktop' | 'mobile' => {
  if (mobileRatio <= 0) {
    return 'desktop';
  }
  const mobileEvery = Math.max(1, Math.round(1 / Math.max(mobileRatio, 0.01)));
  return viewerId % mobileEvery === 0 ? 'mobile' : 'desktop';
};

const setPreparedSession = async (page: Page, token: string) => {
  await page.evaluateOnNewDocument((authToken) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
  }, token);
};

const waitForSelectorOptional = async (page: Page, selector: string, timeoutMs: number) => page
  .waitForSelector(selector, { timeout: timeoutMs })
  .then(() => true)
  .catch(() => false);

const readNavigationSnapshot = async (
  page: Page,
  label: string,
  note?: string,
): Promise<ViewerNavigationSnapshot> => page.evaluate((payload) => {
  const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const loginNode = document.querySelector(payload.selectors.loginEmail) as HTMLElement | null;
  const shellNode = document.querySelector(payload.selectors.shell) as HTMLElement | null;
  const coursesNode = document.querySelector(payload.selectors.courses) as HTMLElement | null;
  const playerNode = document.querySelector(payload.selectors.player) as HTMLElement | null;

  const loginVisible = Boolean(loginNode && (() => {
    const rect = loginNode.getBoundingClientRect();
    const style = window.getComputedStyle(loginNode);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  })());
  const shellVisible = Boolean(shellNode && (() => {
    const rect = shellNode.getBoundingClientRect();
    const style = window.getComputedStyle(shellNode);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  })());
  const coursesVisible = Boolean(coursesNode && (() => {
    const rect = coursesNode.getBoundingClientRect();
    const style = window.getComputedStyle(coursesNode);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  })());
  const playerVisible = Boolean(playerNode && (() => {
    const rect = playerNode.getBoundingClientRect();
    const style = window.getComputedStyle(playerNode);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  })());

  return {
    label: payload.label,
    at: new Date().toISOString(),
    url: window.location.href,
    title: document.title || '',
    readyState: document.readyState || null,
    bodyTextSnippet: bodyText.slice(0, 1000),
    loginVisible,
    shellVisible,
    coursesVisible,
    playerVisible,
    playerUnavailableVisible: /lesson video unavailable|not available|could not/i.test(bodyText),
    videoCount: document.querySelectorAll('video').length,
    domContentLoadedMs: navigationEntry ? Math.round(navigationEntry.domContentLoadedEventEnd) : null,
    loadEventMs: navigationEntry ? Math.round(navigationEntry.loadEventEnd) : null,
    note: payload.note,
  };
}, {
  label,
  note,
  selectors: {
    loginEmail: selectors.loginEmail,
    shell: `${selectors.shellReady}, ${selectors.courseFigmaPage}, ${selectors.overviewDashboard}, ${selectors.navCourses}`,
    courses: `${selectors.courseCatalogCard}, ${selectors.courseLessonOpen}, ${selectors.navCourses}`,
    player: `${selectors.coursePlayerFullscreen}, ${selectors.courseLessonView}, ${selectors.coursePlayerShell}, video`,
  },
});

const readBootTelemetrySnapshot = async (page: Page): Promise<ViewerBootTelemetrySnapshot | null> =>
  page.evaluate(() => {
    const telemetry = (window as Window & {
      __edumasterBootTelemetry?: {
        startedAtIso?: string;
        startedAtEpochMs?: number;
        shellReady?: boolean;
        lastRouteMarker?: string | null;
        events?: ViewerBootTelemetryEvent[];
      };
    }).__edumasterBootTelemetry;

    if (!telemetry) {
      return null;
    }

    return {
      startedAtIso: typeof telemetry.startedAtIso === 'string' ? telemetry.startedAtIso : null,
      startedAtEpochMs: typeof telemetry.startedAtEpochMs === 'number' ? telemetry.startedAtEpochMs : null,
      shellReady: Boolean(telemetry.shellReady),
      lastRouteMarker: typeof telemetry.lastRouteMarker === 'string' ? telemetry.lastRouteMarker : null,
      events: Array.isArray(telemetry.events) ? telemetry.events.slice(-80) : [],
    };
  }).catch(() => null);

const waitForUsefulPageState = async (page: Page, timeoutMs: number) => page.waitForFunction((payload) => {
  const selectorsToCheck = [payload.loginEmail, payload.shell, payload.courses, payload.player];
  for (const selector of selectorsToCheck) {
    const node = document.querySelector(selector) as HTMLElement | null;
    if (!node) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
      return true;
    }
  }
  return false;
}, {
  timeout: timeoutMs,
}, {
  loginEmail: selectors.loginEmail,
  shell: `${selectors.shellReady}, ${selectors.courseFigmaPage}, ${selectors.overviewDashboard}, ${selectors.navCourses}`,
  courses: `${selectors.courseCatalogCard}, ${selectors.courseLessonOpen}, ${selectors.navCourses}`,
  player: `${selectors.coursePlayerFullscreen}, ${selectors.courseLessonView}, ${selectors.coursePlayerShell}, video`,
}).then(() => true).catch(() => false);

const gotoWithRecovery = async (
  page: Page,
  url: string,
  navigationSnapshots: ViewerNavigationSnapshot[],
  label: string,
  timeoutMs = 60_000,
) => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    navigationSnapshots.push(await readNavigationSnapshot(page, label));
    return { timedOut: false, recovered: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Navigation timeout/i.test(message)) {
      throw error;
    }

    const recovered = await waitForUsefulPageState(page, 15_000);
    const snapshot = await readNavigationSnapshot(
      page,
      label,
      recovered ? 'recovered_after_navigation_timeout' : 'navigation_timeout_unrecovered',
    );
    navigationSnapshots.push(snapshot);

    if (!recovered && !snapshot.bodyTextSnippet && !snapshot.loginVisible && !snapshot.shellVisible && !snapshot.coursesVisible && !snapshot.playerVisible) {
      throw error;
    }

    return { timedOut: true, recovered };
  }
};

const loginIfNeeded = async (page: Page, email: string) => {
  const loginVisible = await waitForSelectorOptional(page, selectors.loginEmail, 10_000);
  if (!loginVisible) {
    return false;
  }

  await page.locator(selectors.loginEmail).fill(email);
  await page.locator(selectors.loginPassword).fill(preparedUserPassword);
  await page.locator(selectors.loginSubmit).click();
  const olderDevicePromptVisible = await page.waitForFunction(() => {
    const bodyText = document.body?.innerText || '';
    return /log out older device/i.test(bodyText);
  }, { timeout: 10_000 }).then(() => true).catch(() => false);
  if (olderDevicePromptVisible) {
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) =>
        /log out older device/i.test((node.textContent || '').trim()),
      ) as HTMLButtonElement | undefined;
      button?.click();
    }).catch(() => undefined);
  }
  await page.waitForSelector(`${selectors.shellReady}, ${selectors.courseFigmaPage}, ${selectors.overviewDashboard}, ${selectors.navCourses}`, {
    timeout: 45_000,
  });
  return true;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string) => {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const takeShot = async (page: Page, root: string, label: string) => {
  const target = artifactPath(root, 'course-video-browser-concurrency', label, 'png');
  await withTimeout(
    page.screenshot({ path: target, fullPage: true }),
    screenshotTimeoutMs,
    `Screenshot ${label}`,
  );
  return target;
};

const takeShotBestEffort = async (
  page: Page,
  root: string,
  label: string,
  warnings: string[],
) => {
  try {
    return await takeShot(page, root, label);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return '';
  }
};

const openCourseFromCatalog = async (page: Page, text: string) => {
  await page.waitForSelector(selectors.courseCatalogCard, { timeout: 30_000 });
  const clicked = await page.evaluate((cardSelector, courseLabel) => {
    const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(courseLabel.toLowerCase())) || cards[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, text);
  if (!clicked) {
    throw new Error('No course card was available for the browser video concurrency run.');
  }
};

const openLessonFromCourse = async (page: Page, text: string) => {
  await page.waitForSelector(selectors.courseLessonOpen, { timeout: 30_000 });
  const clicked = await page.evaluate((lessonSelector, lessonLabel) => {
    const buttons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const target = buttons.find((button) => (button.textContent || '').toLowerCase().includes(lessonLabel.toLowerCase())) || buttons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, text);
  if (!clicked) {
    throw new Error('No lesson entry was available for the browser video concurrency run.');
  }
};

const waitForVideo = async (page: Page) => {
  await page.waitForSelector(`${selectors.coursePlayerFullscreen}, ${selectors.courseLessonView}, ${selectors.coursePlayerShell}, video`, {
    timeout: videoReadyTimeoutMs,
  });
  await page.waitForSelector('video', { timeout: videoReadyTimeoutMs });
};

const installVideoEventProbe = async (page: Page) => {
  const events: ViewerVideoEvent[] = [];
  await page.exposeFunction('__recordQaConcurrencyVideoEvent', (event: ViewerVideoEvent) => {
    events.push(event);
  }).catch(() => undefined);
  await page.evaluateOnNewDocument(() => {
    (window as unknown as { __qaVideoProbeInstalled?: boolean }).__qaVideoProbeInstalled = false;
  });
  const installSource = `
    (() => {
      const record = (type, extra = {}) => {
        const videos = Array.from(document.querySelectorAll('video'));
        const video = videos.reduce((best, current) => {
          const bestScore = best ? ((best.currentTime || 0) * 1000) + ((best.readyState || 0) * 100) : -1;
          const currentScore = ((current.currentTime || 0) * 1000) + ((current.readyState || 0) * 100);
          return currentScore > bestScore ? current : best;
        }, null);
        const buffered = [];
        if (video && video.buffered) {
          for (let index = 0; index < video.buffered.length; index += 1) {
            buffered.push([video.buffered.start(index), video.buffered.end(index)]);
          }
        }
        if (window.__recordQaConcurrencyVideoEvent) {
          window.__recordQaConcurrencyVideoEvent({
            type,
            at: Date.now(),
            currentTime: video ? Number(video.currentTime || 0) : null,
            duration: video && Number.isFinite(video.duration) ? Number(video.duration) : null,
            paused: video ? Boolean(video.paused) : null,
            readyState: video ? Number(video.readyState || 0) : null,
            networkState: video ? Number(video.networkState || 0) : null,
            buffered,
            extra,
          });
        }
      };
      const install = () => {
        const videos = Array.from(document.querySelectorAll('video'));
        const video = videos.reduce((best, current) => {
          const bestScore = best ? ((best.currentTime || 0) * 1000) + ((best.readyState || 0) * 100) : -1;
          const currentScore = ((current.currentTime || 0) * 1000) + ((current.readyState || 0) * 100);
          return currentScore > bestScore ? current : best;
        }, null);
        if (!video) {
          record('probe_missing_video');
          return false;
        }
        if (video.dataset.qaConcurrencyProbeInstalled === 'true') {
          record('probe_reused');
          return true;
        }
        video.dataset.qaConcurrencyProbeInstalled = 'true';
        [
          'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked',
          'timeupdate', 'error', 'ended', 'loadedmetadata', 'loadeddata', 'canplay',
          'canplaythrough', 'durationchange', 'ratechange', 'volumechange'
        ].forEach((eventName) => {
          video.addEventListener(eventName, () => record(eventName), { passive: true });
        });
        document.addEventListener('visibilitychange', () => record('visibilitychange', { hidden: document.hidden }), { passive: true });
        document.addEventListener('fullscreenchange', () => record('fullscreenchange', { fullscreen: Boolean(document.fullscreenElement) }), { passive: true });
        window.addEventListener('edumaster:hls-metric', (event) => {
          const detail = event instanceof CustomEvent ? event.detail : {};
          record('metric:' + String((detail && detail.type) || 'unknown'), detail || {});
        });
        record('probe_installed');
        return true;
      };
      if (!install()) {
        const interval = window.setInterval(() => {
          if (install()) {
            window.clearInterval(interval);
          }
        }, 500);
        window.setTimeout(() => window.clearInterval(interval), 30000);
      }
    })();
  `;
  const attach = async () => {
    await page.evaluate((source) => {
      window.eval(source);
    }, installSource).catch(() => undefined);
  };
  page.on('framenavigated', () => {
    void attach();
  });
  await attach();
  return events;
};

const getActiveVideoIndex = async (page: Page) =>
  page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    if (!videos.length) {
      return null;
    }

    let bestIndex = 0;
    let bestScore = -1;
    videos.forEach((video, index) => {
      const rect = video.getBoundingClientRect();
      const style = window.getComputedStyle(video);
      const visible = rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0;
      const area = visible ? rect.width * rect.height : 0;
      const score = area + ((video.currentTime || 0) * 1000) + ((video.readyState || 0) * 100);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return bestIndex;
  });

const clickActiveVideoSurface = async (page: Page, activeVideoIndex: number) => {
  const box = await page.evaluate((index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    if (!video) {
      return null;
    }
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    return {
      x: rect.left + (rect.width / 2),
      y: rect.top + (rect.height / 2),
    };
  }, activeVideoIndex);

  if (!box) {
    return false;
  }

  await page.mouse.click(box.x, box.y);
  return true;
};

const openPlayableLesson = async (page: Page, navigationSnapshots: ViewerNavigationSnapshot[]) => {
  const playerReachedDirectly = await waitForSelectorOptional(page, `${selectors.coursePlayerFullscreen}, ${selectors.courseLessonView}, ${selectors.coursePlayerShell}, video`, 20_000);
  const directState = playerReachedDirectly ? await readVideoState(page) : null;
  if (playerReachedDirectly && !directState?.unavailableVisible) {
    await page.waitForFunction(() => {
      const hasVideo = Boolean(document.querySelector('video'));
      const lessonCompleted = /lesson completed|rewatch lesson|replay available/i.test(document.body?.innerText || '');
      return hasVideo || lessonCompleted;
    }, { timeout: 45_000 });
    navigationSnapshots.push(await readNavigationSnapshot(page, 'lesson-ready'));
    return;
  }

  await gotoWithRecovery(page, `${baseUrl}/?tab=courses`, navigationSnapshots, 'courses-catalog');
  await openCourseFromCatalog(page, courseText);
  await openLessonFromCourse(page, lessonText);
  await page.waitForFunction(() => {
    const hasVideo = Boolean(document.querySelector('video'));
    const lessonCompleted = /lesson completed|rewatch lesson|replay available/i.test(document.body?.innerText || '');
    return hasVideo || lessonCompleted;
  }, { timeout: videoReadyTimeoutMs });
  navigationSnapshots.push(await readNavigationSnapshot(page, 'lesson-ready-via-catalog'));
};

const startPlayback = async (page: Page) => {
  const activeVideoIndex = await getActiveVideoIndex(page);
  if (activeVideoIndex === null) {
    throw new Error('No active video element was available for playback start.');
  }

  await page.waitForFunction((index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    return Boolean(
      video
      && Number.isFinite(video.duration)
      && video.duration > 0
      && video.readyState >= 1,
    );
  }, { timeout: videoReadyTimeoutMs }, activeVideoIndex);

  await page.evaluate((index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    if (!video) {
      return;
    }

    video.muted = true;
    video.volume = 0;
    video.playsInline = true;

    const playOverlay = video.closest('[data-testid="course-player-shell"], [data-course-view="lesson"], [data-testid="course-figma-player"]');
    if (playOverlay instanceof HTMLElement) {
      playOverlay.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, activeVideoIndex);

  // Prefer a real visible click like a student would do.
  await clickActiveVideoSurface(page, activeVideoIndex).catch(() => false);
  await sleep(750);

  // If the click path did not activate playback yet, retry once after canplay
  // and only then use play() as a diagnostic fallback.
  const playbackActivated = await page.waitForFunction((index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    return Boolean(
      video
      && (
        (!video.paused && video.readyState >= 2)
        || video.currentTime > 0.25
      ),
    );
  }, { timeout: 5_000 }, activeVideoIndex).then(() => true).catch(() => false);

  if (playbackActivated) {
    return;
  }

  await clickActiveVideoSurface(page, activeVideoIndex).catch(() => false);
  await sleep(500);

  await page.evaluate(async (index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    if (!video || ((!video.paused && video.readyState >= 2) || video.currentTime > 0.25)) {
      return;
    }

    try {
      const promise = video.play();
      if (promise && typeof promise.then === 'function') {
        await promise;
      }
    } catch {
      // Let the caller decide from observed playback state.
    }
  }, activeVideoIndex);

  await page.waitForFunction((index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    return Boolean(
      video
      && (
        (!video.paused && video.readyState >= 2)
        || video.currentTime > 0.25
      ),
    );
  }, { timeout: playbackActivationTimeoutMs }, activeVideoIndex).catch(() => undefined);
};

const waitForFirstFrame = async (page: Page, timeoutMs: number) => {
  await page.waitForFunction(() => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    return videos.some((video) => Boolean(video && video.currentTime > 1));
  }, { timeout: timeoutMs });
};

const recoverFirstFrame = async (page: Page) => {
  await startPlayback(page);
  await sleep(1_000);
  await page.evaluate(async () => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos.reduce<HTMLVideoElement | null>((best, current) => {
      const bestScore = best ? ((best.currentTime || 0) * 1000) + ((best.readyState || 0) * 100) : -1;
      const currentScore = ((current.currentTime || 0) * 1000) + ((current.readyState || 0) * 100);
      return currentScore > bestScore ? current : best;
    }, null);
    if (!video) {
      return;
    }
    if (video.paused || Number(video.currentTime || 0) < 0.25) {
      try {
        const promise = video.play();
        if (promise && typeof promise.then === 'function') {
          await promise;
        }
      } catch {
        // Let the follow-up wait decide whether playback actually recovered.
      }
    }
  });
  await waitForFirstFrame(page, firstFrameRetryTimeoutMs);
};

const readVideoState = async (page: Page) =>
  page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const activeVideoIndex = videos.length
      ? videos.reduce((bestIndex, currentVideo, index) => {
        const rect = currentVideo.getBoundingClientRect();
        const style = window.getComputedStyle(currentVideo);
        const visible = rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || '1') > 0;
        const currentScore = (visible ? rect.width * rect.height : 0)
          + ((currentVideo.currentTime || 0) * 1000)
          + ((currentVideo.readyState || 0) * 100);
        const bestVideo = videos[bestIndex];
        const bestRect = bestVideo.getBoundingClientRect();
        const bestStyle = window.getComputedStyle(bestVideo);
        const bestVisible = bestRect.width > 0
          && bestRect.height > 0
          && bestStyle.display !== 'none'
          && bestStyle.visibility !== 'hidden'
          && Number(bestStyle.opacity || '1') > 0;
        const bestScore = (bestVisible ? bestRect.width * bestRect.height : 0)
          + ((bestVideo.currentTime || 0) * 1000)
          + ((bestVideo.readyState || 0) * 100);
        return currentScore > bestScore ? index : bestIndex;
      }, 0)
      : null;
    const video = activeVideoIndex !== null ? videos[activeVideoIndex] || null : null;
    const bodyText = document.body?.innerText || '';
    return {
      videoCount: videos.length,
      activeVideoIndex,
      currentTime: video ? Number(video.currentTime || 0) : null,
      duration: video && Number.isFinite(video.duration) ? Number(video.duration) : null,
      currentSrc: video?.currentSrc || null,
      paused: video?.paused ?? null,
      readyState: video?.readyState ?? null,
      networkState: video?.networkState ?? null,
      error: video?.error ? {
        code: video.error.code,
        message: video.error.message,
      } : null,
      playbackConflictVisible: /another device active|log out older device|active session/i.test(bodyText),
      unavailableVisible: /lesson video unavailable|not available|could not/i.test(bodyText),
    };
  });

const getObservedVideoCurrentTimes = (videoEvents: ViewerVideoEvent[]) =>
  videoEvents
    .map((event) => event.currentTime)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

const getPlaybackEvidenceEvent = (videoEvents: ViewerVideoEvent[]) =>
  videoEvents.find((event) =>
    typeof event.currentTime === 'number'
    && event.currentTime > 1
    && (
      event.type === 'playing'
      || event.type === 'timeupdate'
      || event.type === 'metric:timeupdate'
      || event.type === 'canplay'
      || event.type === 'canplaythrough'
      || event.type === 'loadeddata'
      || event.type === 'metric:startup_progress'
    ));

const seekVideo = async (page: Page, deltaSeconds: number) => {
  await page.evaluate(async (delta) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos.reduce<HTMLVideoElement | null>((best, current) => {
      const bestScore = best ? ((best.currentTime || 0) * 1000) + ((best.readyState || 0) * 100) : -1;
      const currentScore = ((current.currentTime || 0) * 1000) + ((current.readyState || 0) * 100);
      return currentScore > bestScore ? current : best;
    }, null);
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return;
    }
    const nextTime = Math.min(Math.max(video.currentTime + delta, 1), Math.max(video.duration - 1, 1));
    video.currentTime = nextTime;
    try {
      const promise = video.play();
      if (promise && typeof promise.then === 'function') {
        await promise;
      }
    } catch {
      // Let post-seek state inspection decide whether playback actually recovered.
    }
  }, deltaSeconds);

  const activeVideoIndex = await getActiveVideoIndex(page);
  if (activeVideoIndex === null) {
    return;
  }

  const resumed = await page.waitForFunction((index) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos[index] || null;
    return Boolean(video && !video.paused && video.readyState >= 2);
  }, { timeout: 4_000 }, activeVideoIndex).then(() => true).catch(() => false);

  if (!resumed) {
    await clickActiveVideoSurface(page, activeVideoIndex).catch(() => false);
  }
};

const hasLessonCompletionState = async (page: Page) =>
  page.evaluate(() => /lesson completed|rewatch lesson|replay available/i.test(document.body?.innerText || ''));

const toggleVideoPlayback = async (page: Page, shouldPause: boolean) => {
  await page.evaluate(async (pauseRequested) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const video = videos.reduce<HTMLVideoElement | null>((best, current) => {
      const bestScore = best ? ((best.currentTime || 0) * 1000) + ((best.readyState || 0) * 100) : -1;
      const currentScore = ((current.currentTime || 0) * 1000) + ((current.readyState || 0) * 100);
      return currentScore > bestScore ? current : best;
    }, null);
    if (!video) {
      return;
    }
    if (pauseRequested) {
      video.pause();
      return;
    }
    try {
      const promise = video.play();
      if (promise && typeof promise.then === 'function') {
        await promise;
      }
    } catch {
      // Let post-action inspection decide whether playback recovered.
    }
  }, shouldPause);
};

const refreshLessonAndResume = async (
  page: Page,
  user: PreparedUser,
  navigationSnapshots: ViewerNavigationSnapshot[],
) => {
  const beforeRefreshState = await readVideoState(page);
  const previousTime = typeof beforeRefreshState.currentTime === 'number'
    ? beforeRefreshState.currentTime
    : 0;

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  navigationSnapshots.push(await readNavigationSnapshot(page, 'after-refresh'));

  const usedInteractiveLogin = await loginIfNeeded(page, user.email);
  if (usedInteractiveLogin) {
    navigationSnapshots.push(await readNavigationSnapshot(page, 'after-refresh-login'));
    await gotoWithRecovery(page, lessonUrl, navigationSnapshots, 'lesson-direct-after-refresh-login');
  }

  await openPlayableLesson(page, navigationSnapshots);
  if (await hasLessonCompletionState(page)) {
    return;
  }
  await startPlayback(page);
  await page.waitForFunction((resumeFloor) => {
    const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
    const lessonCompleted = /lesson completed|rewatch lesson|replay available/i.test(document.body?.innerText || '');
    return lessonCompleted || videos.some((video) => Boolean(
      video
      && !video.paused
      && video.readyState >= 2
      && video.currentTime >= resumeFloor,
    ));
  }, { timeout: Math.max(firstFrameTimeoutMs, 30_000) }, Math.max(previousTime - 10, 1)).catch(() => undefined);
};

const runViewer = async (
  browser: Browser | null,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  user: PreparedUser,
  viewerId: number,
  stage: number,
): Promise<ViewerResult> => {
  const viewport = getViewport(viewerId);
  const ownedBrowser = browser ? null : await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-renderer-backgrounding',
      '--mute-audio',
    ],
  });
  const activeBrowser = browser || ownedBrowser;
  if (!activeBrowser) {
    throw new Error('Browser instance was not available for viewer run.');
  }
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const networkFailures: Array<{ status: number; url: string }> = [];
  const networkSamples: ViewerNetworkSample[] = [];
  const navigationSnapshots: ViewerNavigationSnapshot[] = [];
  let videoEvents: ViewerVideoEvent[] = [];
  let bootTelemetry: ViewerBootTelemetrySnapshot | null = null;
  const videoEventsPath = path.join(ctx.logDir, `course-video-browser-stage-${stage}-viewer-${viewerId}-video-events.json`);
  const navigationSnapshotsPath = path.join(ctx.logDir, `course-video-browser-stage-${stage}-viewer-${viewerId}-navigation.json`);
  const bootTelemetryPath = path.join(ctx.logDir, `course-video-browser-stage-${stage}-viewer-${viewerId}-boot.json`);
  const failureSourcePath = path.join(ctx.sourceDir, `course-video-browser-stage-${stage}-viewer-${viewerId}-failure.html`);
  const startedAt = new Map<string, number>();
  const screenshots: string[] = [];
  const shouldCapture = viewerId <= screenshotSample;
  let playStartedAt: number | null = null;
  let midStreamEvidence: ViewerResult['midStreamEvidence'] = null;

  try {
    if (viewerLaunchStaggerMs > 0 && viewerId > 1) {
      await sleep((viewerId - 1) * viewerLaunchStaggerMs);
    }

    for (let attempt = 0; attempt <= viewerSetupRetries; attempt += 1) {
      try {
        context = await activeBrowser.createBrowserContext();
        page = await context.newPage();
        break;
      } catch (error) {
        if (attempt >= viewerSetupRetries) {
          throw error;
        }
        await context?.close().catch(() => undefined);
        context = null;
        page = null;
        await sleep(Math.min(5_000, 1_000 * (attempt + 1)));
      }
    }

    if (!page) {
      throw new Error('Browser page was not available for viewer run.');
    }

    if (viewport === 'mobile') {
      await page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    } else {
      await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    }
    await page.setRequestInterception(true);

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error instanceof Error ? error.message : String(error));
    });
    page.on('request', (request: HTTPRequest) => {
      if (nonEssentialResourceTypes.has(request.resourceType())) {
        void request.abort().catch(() => undefined);
        return;
      }
      if (hlsPattern.test(request.url())) {
        startedAt.set(request.url(), Date.now());
      }
      void request.continue().catch(() => undefined);
    });
    page.on('requestfailed', (request: HTTPRequest) => {
      networkFailures.push({ status: 0, url: request.url() });
      consoleErrors.push(`requestfailed: ${request.resourceType()} ${request.url()} ${request.failure()?.errorText || 'unknown'}`);
    });
    page.on('response', (response: HTTPResponse) => {
      const url = response.url();
      if (!hlsPattern.test(url)) {
        if (response.status() >= 400) {
          networkFailures.push({ status: response.status(), url });
        }
        return;
      }
      networkSamples.push({
        url,
        status: response.status(),
        durationMs: Math.max(Date.now() - (startedAt.get(url) || Date.now()), 0),
        contentType: response.headers()['content-type'] || '',
      });
      if (response.status() >= 400) {
        networkFailures.push({ status: response.status(), url });
      }
    });

    const freshToken = await loginPreparedUser(user.email, viewerId);
    await setPreparedSession(page, freshToken);
    videoEvents = await installVideoEventProbe(page);
    await gotoWithRecovery(page, lessonUrl, navigationSnapshots, 'lesson-direct');
    const usedInteractiveLogin = await loginIfNeeded(page, user.email);
    if (usedInteractiveLogin) {
      navigationSnapshots.push(await readNavigationSnapshot(page, 'after-login'));
      await gotoWithRecovery(page, lessonUrl, navigationSnapshots, 'lesson-direct-after-login');
    }
    await openPlayableLesson(page, navigationSnapshots);
    if (shouldCapture) {
      screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-loaded`, consoleErrors));
    }

    playStartedAt = Date.now();
    await startPlayback(page);
    let firstFrameReached = false;
    let startupDelayMs: number | null = null;
    try {
      await waitForFirstFrame(page, firstFrameTimeoutMs);
      firstFrameReached = true;
      startupDelayMs = Date.now() - playStartedAt;
    } catch {
      try {
        await recoverFirstFrame(page);
        firstFrameReached = true;
        startupDelayMs = Date.now() - playStartedAt;
      } catch {
        firstFrameReached = false;
      }
    }

    const initialState = await readVideoState(page);
    let maxCurrentTimeObserved = typeof initialState.currentTime === 'number' ? initialState.currentTime : null;
    if (shouldCapture) {
      if (firstFrameReached) {
        screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-first-frame`, consoleErrors));
      }
      screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-playing-start`, consoleErrors));
    }

    if (firstFrameReached) {
      const midStreamDelayMs = captureMidStreamScreenshots
        ? Math.max(5_000, Math.min(30_000, Math.round(watchWindowMs / 2)))
        : Math.round(watchWindowMs / 3);
      await sleep(midStreamDelayMs);
      const firstProgressState = await readVideoState(page);
      if (typeof firstProgressState.currentTime === 'number') {
        maxCurrentTimeObserved = Math.max(maxCurrentTimeObserved || 0, firstProgressState.currentTime);
      }
      if (captureMidStreamScreenshots && shouldCapture) {
        const midStreamScreenshotPath = await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-mid-stream`, consoleErrors);
        if (midStreamScreenshotPath) {
          midStreamEvidence = {
            screenshotPath: midStreamScreenshotPath,
            currentTime: firstProgressState.currentTime,
            duration: firstProgressState.duration,
            paused: firstProgressState.paused,
            readyState: firstProgressState.readyState,
            playbackConflictVisible: firstProgressState.playbackConflictVisible,
            unavailableVisible: firstProgressState.unavailableVisible,
          };
          screenshots.push(midStreamScreenshotPath);
        }
      }
      await seekVideo(page, 45);
      if (shouldCapture) {
        screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-seek-forward`, consoleErrors));
      }
      await sleep(Math.round(watchWindowMs / 3));
      const secondProgressState = await readVideoState(page);
      if (typeof secondProgressState.currentTime === 'number') {
        maxCurrentTimeObserved = Math.max(maxCurrentTimeObserved || 0, secondProgressState.currentTime);
      }
      await seekVideo(page, -30);
      if (shouldCapture) {
        screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-seek-backward`, consoleErrors));
      }
      await sleep(Math.max(2_000, Math.round(watchWindowMs / 8)));

      await toggleVideoPlayback(page, true);
      await sleep(1_000);
      if (shouldCapture) {
        screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-paused`, consoleErrors));
      }

      const beforePauseResumeState = await readVideoState(page);
      const beforePauseResumeTime = typeof beforePauseResumeState.currentTime === 'number'
        ? beforePauseResumeState.currentTime
        : 0;
      await toggleVideoPlayback(page, false);
      await page.waitForFunction((resumeFloor) => {
        const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
        return videos.some((video) => Boolean(
          video
          && !video.paused
          && video.readyState >= 2
          && video.currentTime >= resumeFloor,
        ));
      }, { timeout: 15_000 }, Math.max(beforePauseResumeTime, 1)).catch(() => undefined);
      if (shouldCapture) {
        screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-resumed`, consoleErrors));
      }

      await sleep(Math.max(2_000, Math.round(watchWindowMs / 8)));

      await refreshLessonAndResume(page, user, navigationSnapshots);
      if (shouldCapture) {
        screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-after-refresh`, consoleErrors));
      }

      await sleep(Math.max(5_000, watchWindowMs - Math.round((watchWindowMs / 3) * 2)));
    }

    const finalState = await readVideoState(page);
    if (typeof finalState.currentTime === 'number') {
      maxCurrentTimeObserved = Math.max(maxCurrentTimeObserved || 0, finalState.currentTime);
    }
    if (shouldCapture) {
      screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-watch-window-end`, consoleErrors));
    }

    bootTelemetry = await readBootTelemetrySnapshot(page);

    const observedCurrentTimes = getObservedVideoCurrentTimes(videoEvents);
    const playbackEvidenceEvent = getPlaybackEvidenceEvent(videoEvents);
    const fallbackCurrentTimeStart = observedCurrentTimes.length > 0 ? observedCurrentTimes[0] : null;
    const fallbackCurrentTimeEnd = observedCurrentTimes.length > 0 ? observedCurrentTimes[observedCurrentTimes.length - 1] : null;
    const normalizedCurrentTimeStart = initialState.currentTime ?? fallbackCurrentTimeStart;
    const normalizedCurrentTimeEnd = finalState.currentTime ?? fallbackCurrentTimeEnd;

    if (!firstFrameReached && playbackEvidenceEvent) {
      firstFrameReached = true;
      startupDelayMs = startupDelayMs ?? Math.max(playbackEvidenceEvent.at - (playStartedAt ?? playbackEvidenceEvent.at), 0);
    }
    if (observedCurrentTimes.length > 0) {
      maxCurrentTimeObserved = Math.max(
        maxCurrentTimeObserved ?? 0,
        ...observedCurrentTimes,
      );
    }

    const manifestSamples = networkSamples.filter((entry) => /\.m3u8(?:\?|$)/i.test(entry.url) || /course-manifests/i.test(entry.url));
    const segmentSamples = networkSamples.filter((entry) => /\.(?:ts|m4s|mp4)(?:\?|$)/i.test(entry.url));
    const playbackConflictCount = Number(initialState.playbackConflictVisible) + Number(finalState.playbackConflictVisible);
    const stateDeliveryPath = classifyRecordedDeliveryPath({
      src: String(finalState.currentSrc || initialState.currentSrc || ''),
      streamFormat: /\.m3u8(?:\?|$)/i.test(String(finalState.currentSrc || initialState.currentSrc || '')) ? 'hls' : null,
    });
    const deliveryPath = extractDeliveryPathFromVideoEvents(videoEvents)
      || (stateDeliveryPath !== 'unknown' ? stateDeliveryPath : null)
      || extractDeliveryPathFromNetwork(networkSamples)
      || 'unknown';
    const progressedSeconds = normalizedCurrentTimeStart != null && maxCurrentTimeObserved != null
      ? Number((maxCurrentTimeObserved - normalizedCurrentTimeStart).toFixed(2))
      : null;
    const sustainedPlayback = typeof progressedSeconds === 'number'
      ? progressedSeconds >= 20
      : false;
    const ok = firstFrameReached && sustainedPlayback && !finalState.unavailableVisible && !finalState.error && playbackConflictCount === 0;
    const errorMessage = !firstFrameReached
      ? 'First frame was not reached in time.'
      : !sustainedPlayback
        ? `Playback did not sustain beyond the minimum progression window. maxCurrentTimeObserved=${maxCurrentTimeObserved}`
        : undefined;
    const failure = ok
      ? { failureClassification: null, failurePhase: null }
      : classifyViewerFailure({
        bootTelemetry,
        navigationSnapshots,
        consoleErrors,
        pageErrors,
        errorMessage,
        firstFrameReached,
      });

    await writeJson(videoEventsPath, videoEvents);
    return {
      viewerId,
      email: user.email,
      viewport,
      ok,
      stage,
      currentTimeStart: normalizedCurrentTimeStart,
      currentTimeEnd: normalizedCurrentTimeEnd,
      maxCurrentTimeObserved,
      progressedSeconds,
      firstFrameReached,
      startupDelayMs,
      manifestRequests: manifestSamples.length,
      manifestFailures: manifestSamples.filter((entry) => entry.status >= 400).length,
      segmentRequests: segmentSamples.length,
      segmentFailures: segmentSamples.filter((entry) => entry.status >= 400).length,
      playbackConflictCount,
      screenshots: screenshots.filter(Boolean),
      consoleErrors,
      pageErrors,
      networkFailures,
      videoEventsPath,
      navigationSnapshotsPath,
      failureSourcePath,
      bootTelemetryPath,
      deliveryPath,
      midStreamEvidence,
      failureClassification: failure.failureClassification,
      failurePhase: failure.failurePhase,
      activeVideoDebug: {
        videoCount: initialState.videoCount,
        activeVideoIndex: initialState.activeVideoIndex,
      },
      error: errorMessage,
    };
  } catch (error) {
    if (page) {
      screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `stage-${stage}-viewer-${viewerId}-failure`, consoleErrors));
    }
    const failureState = page
      ? await readVideoState(page).catch(() => ({
        videoCount: 0,
        activeVideoIndex: null,
        currentSrc: null,
      }))
      : {
        videoCount: 0,
        activeVideoIndex: null,
        currentSrc: null,
      };
    navigationSnapshots.push(page
      ? await readNavigationSnapshot(page, 'failure').catch(() => ({
        label: 'failure',
        at: new Date().toISOString(),
        url: page.url(),
        title: '',
        readyState: null,
        bodyTextSnippet: '',
        loginVisible: false,
        shellVisible: false,
        coursesVisible: false,
        playerVisible: false,
        playerUnavailableVisible: false,
        videoCount: 0,
        domContentLoadedMs: null,
        loadEventMs: null,
        note: 'failed_to_capture_navigation_snapshot',
      }))
      : {
        label: 'failure',
        at: new Date().toISOString(),
        url: lessonUrl,
        title: '',
        readyState: null,
        bodyTextSnippet: '',
        loginVisible: false,
        shellVisible: false,
        coursesVisible: false,
        playerVisible: false,
        playerUnavailableVisible: false,
        videoCount: 0,
        domContentLoadedMs: null,
        loadEventMs: null,
        note: 'page_setup_failed_before_navigation',
      });
    bootTelemetry = page ? await readBootTelemetrySnapshot(page) : null;
    if (page) {
      await writeText(failureSourcePath, await page.content().catch(() => ''));
    } else {
      await writeText(failureSourcePath, '');
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const observedCurrentTimes = getObservedVideoCurrentTimes(videoEvents);
    const playbackEvidenceEvent = getPlaybackEvidenceEvent(videoEvents);
    const maxObservedCurrentTime = observedCurrentTimes.length > 0 ? Math.max(...observedCurrentTimes) : null;
    const currentTimeStart = observedCurrentTimes.length > 0 ? observedCurrentTimes[0] : null;
    const currentTimeEnd = observedCurrentTimes.length > 0 ? observedCurrentTimes[observedCurrentTimes.length - 1] : null;
    const firstFrameReached = Boolean(playbackEvidenceEvent);
    const startupDelayMs = playbackEvidenceEvent ? Math.max(playbackEvidenceEvent.at - (playStartedAt ?? playbackEvidenceEvent.at), 0) : null;
    const failureStateDeliveryPath = classifyRecordedDeliveryPath({
      src: String(failureState.currentSrc || ''),
      streamFormat: /\.m3u8(?:\?|$)/i.test(String(failureState.currentSrc || '')) ? 'hls' : null,
    });
    const deliveryPath = extractDeliveryPathFromVideoEvents(videoEvents)
      || (failureStateDeliveryPath !== 'unknown' ? failureStateDeliveryPath : null)
      || extractDeliveryPathFromNetwork(networkSamples)
      || 'unknown';
    const failure = classifyViewerFailure({
      bootTelemetry,
      navigationSnapshots,
      consoleErrors,
      pageErrors,
      errorMessage,
      firstFrameReached,
    });
    return {
      viewerId,
      email: user.email,
      viewport,
      ok: false,
      stage,
      currentTimeStart,
      currentTimeEnd,
      maxCurrentTimeObserved: maxObservedCurrentTime,
      progressedSeconds: currentTimeStart != null && maxObservedCurrentTime != null
        ? Number((maxObservedCurrentTime - currentTimeStart).toFixed(2))
        : null,
      firstFrameReached,
      startupDelayMs,
      manifestRequests: 0,
      manifestFailures: 0,
      segmentRequests: 0,
      segmentFailures: 0,
      playbackConflictCount: 0,
      screenshots: screenshots.filter(Boolean),
      consoleErrors,
      pageErrors,
      networkFailures,
      videoEventsPath,
      navigationSnapshotsPath,
      failureSourcePath,
      bootTelemetryPath,
      deliveryPath,
      midStreamEvidence,
      failureClassification: failure.failureClassification,
      failurePhase: failure.failurePhase,
      activeVideoDebug: {
        videoCount: failureState.videoCount ?? 0,
        activeVideoIndex: failureState.activeVideoIndex ?? null,
      },
      error: errorMessage,
    };
  } finally {
    const loggedDeliveryPath = extractDeliveryPathFromVideoEvents(videoEvents)
      || extractDeliveryPathFromNetwork(networkSamples)
      || 'unknown';
    await writeJson(path.join(ctx.logDir, `course-video-browser-stage-${stage}-viewer-${viewerId}.json`), {
      viewerId,
      email: user.email,
      viewport,
      deliveryPath: loggedDeliveryPath,
      midStreamEvidence,
      consoleErrors,
      pageErrors,
      networkFailures,
      networkSamples,
      navigationSnapshots,
      videoEvents,
      bootTelemetry,
    });
    await writeJson(navigationSnapshotsPath, navigationSnapshots).catch(() => undefined);
    await writeJson(videoEventsPath, videoEvents).catch(() => undefined);
    await writeJson(bootTelemetryPath, bootTelemetry).catch(() => undefined);
    await context?.close().catch(() => undefined);
    if (ownedBrowser) {
      await ownedBrowser.close().catch(() => undefined);
    }
  }
};

const runStage = async (
  browser: Browser,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  users: PreparedUser[],
  viewers: number,
): Promise<StageSummary> => {
  const stageStartedAt = new Date().toISOString();
  const stageUsers = users.slice(0, viewers);
  const queue = stageUsers.map((user, index) => ({ user, viewerId: index + 1 }));
  const results: ViewerResult[] = [];

  const worker = async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      results.push(await runViewer(browser, ctx, next.user, next.viewerId, viewers));
    }
  };

  await Promise.all(Array.from({ length: Math.min(stageConcurrencyCap, viewers) }, worker));

  const resultsPath = path.join(ctx.analysisDir, `course-video-browser-stage-${viewers}-results.json`);
  await writeJson(resultsPath, results);

  const successes = results.filter((result) => result.ok);
  const startupDelays = successes.map((result) => result.startupDelayMs).filter((value): value is number => typeof value === 'number');
  const progressedSeconds = successes.map((result) => result.progressedSeconds).filter((value): value is number => typeof value === 'number');
  const manifestFailures = results.reduce((sum, result) => sum + result.manifestFailures, 0);
  const segmentFailures = results.reduce((sum, result) => sum + result.segmentFailures, 0);
  const playbackConflicts = results.reduce((sum, result) => sum + result.playbackConflictCount, 0);
  const failureBreakdown = results.reduce((summary, result) => {
    if (!result.failureClassification) {
      return summary;
    }
    summary[result.failureClassification] += 1;
    return summary;
  }, createFailureBreakdown());
  const deliveryPathBreakdown = results.reduce((summary, result) => {
    summary[result.deliveryPath || 'unknown'] += 1;
    return summary;
  }, createDeliveryPathBreakdown());
  const desktopMidStreamScreenshots = results
    .filter((result) =>
      result.viewport === 'desktop'
      && Boolean(result.midStreamEvidence?.screenshotPath)
      && Number(result.midStreamEvidence?.currentTime || 0) > 0
      && !result.midStreamEvidence?.playbackConflictVisible
      && !result.midStreamEvidence?.unavailableVisible
      && result.midStreamEvidence?.paused === false,
    )
    .map((result) => String(result.midStreamEvidence?.screenshotPath || ''))
    .filter(Boolean);
  const mobileMidStreamScreenshots = results
    .filter((result) =>
      result.viewport === 'mobile'
      && Boolean(result.midStreamEvidence?.screenshotPath)
      && Number(result.midStreamEvidence?.currentTime || 0) > 0
      && !result.midStreamEvidence?.playbackConflictVisible
      && !result.midStreamEvidence?.unavailableVisible
      && result.midStreamEvidence?.paused === false,
    )
    .map((result) => String(result.midStreamEvidence?.screenshotPath || ''))
    .filter(Boolean);
  const midStreamRequirementSatisfied = !captureMidStreamScreenshots
    || (desktopMidStreamScreenshots.length > 0 && mobileMidStreamScreenshots.length > 0);

  return {
    viewers,
    startedAt: stageStartedAt,
    completedAt: new Date().toISOString(),
    ok: results.every((result) => result.ok) && midStreamRequirementSatisfied,
    successCount: successes.length,
    failureCount: results.length - successes.length,
    failureBreakdown,
    deliveryPathBreakdown,
    manifestFailures,
    segmentFailures,
    playbackConflicts,
    averageStartupDelayMs: average(startupDelays),
    averageProgressSeconds: average(progressedSeconds),
    p95StartupDelayMs: percentile(startupDelays, 95),
    p99StartupDelayMs: percentile(startupDelays, 99),
    p95ProgressSeconds: percentile(progressedSeconds, 95),
    p99ProgressSeconds: percentile(progressedSeconds, 99),
    midStreamRequirementSatisfied,
    midStreamEvidence: {
      desktopScreenshots: desktopMidStreamScreenshots,
      mobileScreenshots: mobileMidStreamScreenshots,
    },
    resultsPath,
    screenshotDir: ctx.screenshotDir,
  };
};

const main = async () => {
  const users = await loadUsers();
  const ctx = await createRunContext();
  const notes: string[] = [];
  const browser = separateBrowserPerViewer ? null : await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-renderer-backgrounding',
      '--mute-audio',
    ],
  });

  const stages: StageSummary[] = [];
  try {
    for (const stage of stageViewerCounts) {
      if (stage > users.length) {
        notes.push(`Skipped stage ${stage}: only ${users.length} prepared users available.`);
        continue;
      }
      const summary = await runStage(browser, ctx, users, stage);
      stages.push(summary);
      if (!summary.ok) {
        notes.push(`Stopped after failing stage ${stage}.`);
        break;
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const overallOk = stages.length > 0 && stages.every((stage) => stage.ok);
  const summary: RunSummary = {
    baseUrl,
    lessonUrl,
    manifestPath,
    stages,
    realBrowserUsers: stages.length ? Math.max(...stages.map((stage) => stage.viewers)) : 0,
    watchWindowMs,
    stageConcurrencyCap,
    captureMidStreamScreenshots,
    overallOk,
    notes,
  };

  await writeJson(path.join(ctx.analysisDir, 'course-video-browser-concurrency-summary.json'), summary);
  await writeText(
    path.join(ctx.analysisDir, 'course-video-browser-concurrency-summary.md'),
    [
      '# Course Video Browser Concurrency Summary',
      '',
      `- Base URL: ${baseUrl}`,
      `- Lesson URL: ${lessonUrl}`,
      `- Manifest: ${manifestPath}`,
      `- Real browser viewers reached: ${summary.realBrowserUsers}`,
      `- Watch window: ${watchWindowMs} ms`,
      `- Video ready timeout: ${videoReadyTimeoutMs} ms`,
      `- Playback activation timeout: ${playbackActivationTimeoutMs} ms`,
      `- First-frame timeout: ${firstFrameTimeoutMs} ms`,
      `- Stage concurrency cap: ${stageConcurrencyCap}`,
      `- Mid-stream screenshots enabled: ${captureMidStreamScreenshots ? 'yes' : 'no'}`,
      `- Separate browser per viewer: ${separateBrowserPerViewer ? 'yes' : 'no'}`,
      `- Overall result: ${overallOk ? 'passed' : 'failed'}`,
      '',
      ...stages.map((stage) => [
        `## Stage ${stage.viewers}`,
        `- Result: ${stage.ok ? 'passed' : 'failed'}`,
        `- Success/failure: ${stage.successCount}/${stage.failureCount}`,
        `- Failure breakdown: ${Object.entries(stage.failureBreakdown).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`,
        `- Manifest failures: ${stage.manifestFailures}`,
        `- Segment failures: ${stage.segmentFailures}`,
        `- Playback conflicts: ${stage.playbackConflicts}`,
        `- Startup delay avg/p95/p99: ${stage.averageStartupDelayMs ?? 'n/a'} / ${stage.p95StartupDelayMs ?? 'n/a'} / ${stage.p99StartupDelayMs ?? 'n/a'} ms`,
        `- Progress avg/p95/p99: ${stage.averageProgressSeconds ?? 'n/a'} / ${stage.p95ProgressSeconds ?? 'n/a'} / ${stage.p99ProgressSeconds ?? 'n/a'} s`,
        `- Mid-stream evidence requirement: ${stage.midStreamRequirementSatisfied ? 'satisfied' : 'missing'}`,
        `- Mid-stream desktop screenshots: ${stage.midStreamEvidence.desktopScreenshots.length ? stage.midStreamEvidence.desktopScreenshots.join(', ') : 'none'}`,
        `- Mid-stream mobile screenshots: ${stage.midStreamEvidence.mobileScreenshots.length ? stage.midStreamEvidence.mobileScreenshots.join(', ') : 'none'}`,
        `- Results: ${stage.resultsPath}`,
      ].join('\n')),
      '',
      'Notes:',
      ...(notes.length ? notes.map((note) => `- ${note}`) : ['- none']),
    ].join('\n'),
  );

  console.log(JSON.stringify(summary, null, 2));
  if (!overallOk) {
    process.exitCode = 1;
  }
};

if (process.argv[1]?.endsWith('course-video-browser-concurrency-review.ts')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
