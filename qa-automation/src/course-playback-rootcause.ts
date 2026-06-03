import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import {
  classifyRecordedDeliveryPath,
  normalizeRecordedDeliveryPath,
  type RecordedDeliveryPath,
} from './recorded-delivery-path.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson } from './utils.js';

type EnvMap = Record<string, string>;
type PlaybackMetric = {
  type: string;
  at: number;
  [key: string]: unknown;
};

type RegressionFlags = {
  falseConflictVisible: boolean;
  seekForwardRecovered: boolean;
  seekBackwardRecovered: boolean;
  pauseResumeRecovered: boolean;
  refreshResumePreserved: boolean;
  unexpectedBackwardJumpDetected: boolean;
};

type VideoDiagnostics = {
  currentTime: number | null;
  duration: number | null;
  paused: boolean | null;
  readyState: number | null;
  networkState: number | null;
  currentSrc: string | null;
  bufferedRanges: Array<{ start: number; end: number }>;
  error: { code: number; message: string } | null;
  visibleTextFlags: {
    reconnecting: boolean;
    retry: boolean;
    playbackStopped: boolean;
    anotherTabOrDevice: boolean;
    preparing: boolean;
    unavailable: boolean;
  };
  bodyTextSnippet: string;
};

type PlayerPayload = {
  playbackSessionId?: string | null;
  streamUrl?: string | null;
  streamFormat?: string | null;
  deliveryProfile?: string | null;
  watchLimit?: number | null;
  watchCompletionPercent?: number | null;
  playbackStatus?: string | null;
  resumeSeconds?: number | null;
  durationSeconds?: number | null;
  videoDurationSeconds?: number | null;
  duration?: string | number | null;
  watchState?: {
    completedFullWatches?: number;
    locked?: boolean;
    replayState?: string | null;
    completionProofSatisfied?: boolean;
    completionThresholdPercentage?: number;
    endStabilityWindowSeconds?: number;
    endStabilitySatisfied?: boolean;
    stableEndWindowWatchedSeconds?: number;
    graceRemainingSeconds?: number;
    graceTotalSeconds?: number;
  } | null;
  code?: string | null;
  message?: string | null;
};

type InteractionSnapshot = {
  label: string;
  diagnostics: VideoDiagnostics;
  screenshotPath: string;
  sourcePath: string;
  at: string;
};
type TitleProbe = {
  candidates: string[];
  matchedCandidate: string;
  bodyMatch: string;
  normalizedExpected: string;
};

type StreamFetchProbe = {
  ok: boolean;
  status: number | null;
  contentType: string | null;
  resolvedUrl: string | null;
  sample: string | null;
};

type BrowserManifestProbe = {
  manifest: StreamFetchProbe;
  nextResource: StreamFetchProbe | null;
  error: string | null;
};

type PlayerPayloadSnapshot = {
  playbackSessionId: string | null;
  streamUrl: string | null;
  streamFormat: string | null;
  deliveryProfile: string | null;
  watchLimit: number | null;
  watchCompletionPercent: number | null;
  playbackStatus: string | null;
  resumeSeconds: number | null;
  durationSeconds: string | number | null;
  code: string | null;
  message: string | null;
  watchState: PlayerPayload['watchState'] | null | undefined;
};

type BootstrapFailureCode =
  | 'PLAYER_API_FAILED'
  | 'MANIFEST_FETCH_FAILED'
  | 'SEGMENT_FETCH_FAILED'
  | 'HLS_ATTACH_TIMEOUT'
  | 'PLAYBACK_ADVANCE_TIMEOUT'
  | 'STREAM_BOOTSTRAP_FAILED';

type BootstrapFailurePhase =
  | 'player-api'
  | 'lesson-open'
  | 'manifest-fetch'
  | 'next-resource-fetch'
  | 'hls-attach'
  | 'playback-advance';

const shouldRequireManifestProbe = (playerPayloadSnapshot: PlayerPayloadSnapshot | null) => {
  const deliveryPath = classifyRecordedDeliveryPath({
    deliveryProfile: playerPayloadSnapshot?.deliveryProfile || null,
    streamFormat: playerPayloadSnapshot?.streamFormat || null,
    src: playerPayloadSnapshot?.streamUrl || null,
  });
  return deliveryPath === 'protected_hls_gateway';
};

const normalizeLabel = (value: string) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[–—-]+/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const matchesNormalizedLabel = (candidate: string, expected: string) => {
  const normalizedCandidate = normalizeLabel(candidate);
  const normalizedExpected = normalizeLabel(expected);
  if (!normalizedExpected) {
    return true;
  }
  return normalizedCandidate.includes(normalizedExpected) || normalizedExpected.includes(normalizedCandidate);
};

const resolveRecordedDeliveryPath = (
  playbackMetrics: PlaybackMetric[],
  currentSrc: string | null,
  responses: Array<{ url: string }>,
): RecordedDeliveryPath => {
  for (const metric of playbackMetrics) {
    const explicit = normalizeRecordedDeliveryPath(metric.deliveryPath);
    if (explicit) {
      return explicit;
    }
    const classified = classifyRecordedDeliveryPath({
      deliveryProfile: typeof metric.deliveryProfile === 'string' ? metric.deliveryProfile : null,
      streamFormat: typeof metric.streamFormat === 'string' ? metric.streamFormat : null,
      src: typeof metric.src === 'string' ? metric.src : null,
      fallbackActive: Boolean(metric.fallbackActive),
      drmEnabled: Boolean(metric.drmEnabled),
    });
    if (classified !== 'unknown') {
      return classified;
    }
  }

  const currentSrcPath = classifyRecordedDeliveryPath({
    src: currentSrc,
    streamFormat: /\.m3u8(?:\?|$)/i.test(String(currentSrc || '')) ? 'hls' : null,
  });
  if (currentSrcPath !== 'unknown') {
    return currentSrcPath;
  }

  for (const response of responses) {
    const classified = classifyRecordedDeliveryPath({
      src: response.url,
      streamFormat: /\.m3u8(?:\?|$)/i.test(response.url) ? 'hls' : null,
    });
    if (classified !== 'unknown') {
      return classified;
    }
  }

  return 'unknown';
};

const resolveRootEnvPath = () => {
  const workspaceRoot = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
  const requestedEnvFile = String(process.env.ENV_FILE || '').trim();
  if (requestedEnvFile) {
    return path.isAbsolute(requestedEnvFile)
      ? requestedEnvFile
      : path.resolve(workspaceRoot, requestedEnvFile);
  }
  return path.join(workspaceRoot, '.env.production');
};

const readRootEnv = async (): Promise<EnvMap> => {
  const envPath = resolveRootEnvPath();
  const values: EnvMap = {};
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }
      values[trimmed.slice(0, separatorIndex)] = trimmed.slice(separatorIndex + 1);
    }
  } catch {
    // Environment variables remain the primary input in CI.
  }
  return values;
};

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const apiBaseUrl = `${apiOrigin.replace(/\/$/, '')}/backend/api`;
const browserPlaybackDeviceId = 'qa-rootcause-device';
const browserPlaybackTabId = 'qa-rootcause-tab';
const shouldDisableContentProtectionForQa = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(config.baseUrl);

const playbackHeaders = (
  token: string,
  {
    deviceId = browserPlaybackDeviceId,
    playbackTabId = browserPlaybackTabId,
  }: {
    deviceId?: string;
    playbackTabId?: string;
  } = {},
) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  'x-edumaster-app': 'web',
  'x-edumaster-client-platform': 'windows',
  'x-edumaster-client-browser': 'edge',
  'x-edumaster-device-id': deviceId,
  'x-edumaster-playback-tab-id': playbackTabId,
  'x-edumaster-browser-tab-id': playbackTabId,
});

const primeBrowserPlaybackIdentity = async (page: puppeteer.Page, token?: string | null) => {
  await page.evaluateOnNewDocument((authToken, nextDeviceId, nextPlaybackTabId, disableContentProtectionForQa) => {
    if (authToken) {
      window.localStorage.setItem('edumaster.jwt', authToken);
    }
    window.localStorage.setItem('edumaster.device.id', nextDeviceId);
    window.sessionStorage.setItem('edumaster.playback.tab.id', nextPlaybackTabId);
    if (disableContentProtectionForQa) {
      window.localStorage.setItem('edumaster.qa.disableContentProtection', 'true');
    }
  }, token || null, browserPlaybackDeviceId, browserPlaybackTabId, shouldDisableContentProtectionForQa);
};

const loginForToken = async (email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Playback Root Cause',
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message || payload?.error || 'Unable to login for playback root-cause automation.');
  }
  return String(payload.token);
};

const getPlayerPayload = async (token: string, courseId: string, lessonId: string) => {
  const response = await fetch(`${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/player`, {
    headers: playbackHeaders(token),
  });
  const text = await response.text();
  let payload: PlayerPayload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {
      message: text.slice(0, 500),
    };
  }
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
};

const summarizePlayerPayload = (payload: PlayerPayload | null | undefined): PlayerPayloadSnapshot => ({
  playbackSessionId: payload?.playbackSessionId || null,
  streamUrl: payload?.streamUrl || null,
  streamFormat: payload?.streamFormat || null,
  deliveryProfile: payload?.deliveryProfile || null,
  watchLimit: payload?.watchLimit ?? null,
  watchCompletionPercent: payload?.watchCompletionPercent ?? null,
  playbackStatus: payload?.playbackStatus || null,
  resumeSeconds: payload?.resumeSeconds ?? null,
  durationSeconds: payload?.durationSeconds ?? payload?.videoDurationSeconds ?? payload?.duration ?? null,
  code: payload?.code || null,
  message: payload?.message || null,
  watchState: payload?.watchState || null,
});

const probeProtectedStreamFromBrowser = async (page: puppeteer.Page, streamUrl: string) => page.evaluate(async (targetUrl) => {
  try {
    const manifestResponse = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
    const manifestText = await manifestResponse.text().catch(() => '');
    const manifest = {
      ok: manifestResponse.ok,
      status: manifestResponse.status,
      contentType: manifestResponse.headers.get('content-type'),
      resolvedUrl: manifestResponse.url || targetUrl,
      sample: manifestText.slice(0, 800),
    };
    if (!manifest.ok) {
      return {
        manifest,
        nextResource: null,
        error: null,
      };
    }

    const manifestLines = String(manifest.sample || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const nextPath = manifestLines[0] || null;
    if (!nextPath) {
      return {
        manifest,
        nextResource: null,
        error: null,
      };
    }

    const nextUrl = new URL(nextPath, manifest.resolvedUrl || targetUrl).toString();
    const nextResponse = await fetch(nextUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
    const nextText = await nextResponse.text().catch(() => '');
    const nextResource = {
      ok: nextResponse.ok,
      status: nextResponse.status,
      contentType: nextResponse.headers.get('content-type'),
      resolvedUrl: nextResponse.url || nextUrl,
      sample: nextText.slice(0, 800),
    };
    return {
      manifest,
      nextResource,
      error: null,
    };
  } catch (error) {
    return {
      manifest: {
        ok: false,
        status: null,
        contentType: null,
        resolvedUrl: targetUrl,
        sample: null,
      },
      nextResource: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}, streamUrl) as Promise<BrowserManifestProbe>;

const clickBySelector = async (page: puppeteer.Page, selector: string, timeoutMs = 20_000) => {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector) as HTMLElement | null;
    element?.scrollIntoView({ block: 'center', inline: 'nearest' });
    element?.click();
  }, selector);
};

const waitForOptionalSelector = async (page: puppeteer.Page, selector: string, timeoutMs = 10_000) => page
  .waitForSelector(selector, { timeout: timeoutMs })
  .then(() => true)
  .catch(() => false);

const readVideoDiagnostics = async (page: puppeteer.Page) =>
  page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    const bodyText = document.body?.innerText || '';
    return {
      currentTime: video?.currentTime ?? null,
      duration: Number.isFinite(video?.duration) ? video?.duration : null,
      paused: video?.paused ?? null,
      readyState: video?.readyState ?? null,
      networkState: video?.networkState ?? null,
      currentSrc: video?.currentSrc || null,
      bufferedRanges: video
        ? Array.from({ length: video.buffered.length }, (_, index) => ({
          start: video.buffered.start(index),
          end: video.buffered.end(index),
        }))
        : [],
      error: video?.error ? {
        code: video.error.code,
        message: video.error.message,
      } : null,
      visibleTextFlags: {
        reconnecting: /reconnecting/i.test(bodyText),
        retry: /retry/i.test(bodyText),
        playbackStopped: /playback stopped/i.test(bodyText),
        anotherTabOrDevice: /another tab or device/i.test(bodyText),
        preparing: /preparing protected lesson player/i.test(bodyText),
        unavailable: /unavailable|could not|not available/i.test(bodyText),
      },
      bodyTextSnippet: bodyText.slice(0, 4000),
    };
  }, selectors.coursePlayerVideo) as Promise<VideoDiagnostics>;

const captureSnapshot = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, 'course-playback-rootcause', label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, 'course-playback-rootcause', label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  const diagnostics = await readVideoDiagnostics(page);
  return {
    label,
    diagnostics,
    screenshotPath,
    sourcePath,
    at: new Date().toISOString(),
  } satisfies InteractionSnapshot;
};

const classifyBootstrapFailure = ({
  playerPayloadSnapshot,
  manifestProbe,
  diagnostics,
  playbackAdvanced,
  lessonOpenReached,
}: {
  playerPayloadSnapshot: PlayerPayloadSnapshot | null;
  manifestProbe: BrowserManifestProbe | null;
  diagnostics: VideoDiagnostics;
  playbackAdvanced: boolean;
  lessonOpenReached: boolean;
}): { failureCode: BootstrapFailureCode | null; failurePhase: BootstrapFailurePhase | null } => {
  if (!playerPayloadSnapshot) {
    return { failureCode: 'PLAYER_API_FAILED', failurePhase: 'player-api' };
  }
  if (!lessonOpenReached) {
    return { failureCode: 'STREAM_BOOTSTRAP_FAILED', failurePhase: 'lesson-open' };
  }
  const requireManifestProbe = shouldRequireManifestProbe(playerPayloadSnapshot);
  if (requireManifestProbe && (manifestProbe?.error || (manifestProbe?.manifest.status != null && !manifestProbe.manifest.ok))) {
    return { failureCode: 'MANIFEST_FETCH_FAILED', failurePhase: 'manifest-fetch' };
  }
  if (requireManifestProbe && manifestProbe?.nextResource && manifestProbe.nextResource.status != null && !manifestProbe.nextResource.ok) {
    return { failureCode: 'SEGMENT_FETCH_FAILED', failurePhase: 'next-resource-fetch' };
  }
  if ((!diagnostics.currentSrc && Number(diagnostics.readyState || 0) <= 0) || diagnostics.visibleTextFlags.preparing) {
    return { failureCode: 'HLS_ATTACH_TIMEOUT', failurePhase: 'hls-attach' };
  }
  if (!playbackAdvanced) {
    return { failureCode: 'PLAYBACK_ADVANCE_TIMEOUT', failurePhase: 'playback-advance' };
  }
  return { failureCode: null, failurePhase: null };
};

const readNavigationTiming = async (page: puppeteer.Page) =>
  page.evaluate(() => {
    const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (!navigationEntry) {
      return null;
    }
    return {
      domContentLoadedMs: Number(navigationEntry.domContentLoadedEventEnd || 0),
      loadEventMs: Number(navigationEntry.loadEventEnd || 0),
      responseEndMs: Number(navigationEntry.responseEnd || 0),
    };
  });

const ensurePlaybackStarted = async (page: puppeteer.Page) => {
  if (await waitForOptionalSelector(page, selectors.coursePlayerVideoPlay, 5_000)) {
    await clickBySelector(page, selectors.coursePlayerVideoPlay, 5_000).catch(() => undefined);
  }
  await page.$eval(selectors.coursePlayerVideo, (video) => {
    (video as HTMLVideoElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  }).catch(() => undefined);
  const videoHandle = await page.$(selectors.coursePlayerVideo);
  if (videoHandle) {
    const box = await videoHandle.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
    }
  }
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      return;
    }
    video.muted = true;
    video.volume = 0;
    void video.play?.().catch(() => undefined);
  }, selectors.coursePlayerVideo);
};

const waitForCurrentTime = async (
  page: puppeteer.Page,
  predicate: (currentTime: number, diagnostics: VideoDiagnostics) => boolean,
  timeoutMs: number,
) => {
  const deadline = Date.now() + timeoutMs;
  let latest = await readVideoDiagnostics(page);
  while (Date.now() < deadline) {
    latest = await readVideoDiagnostics(page);
    const currentTime = Number(latest.currentTime || 0);
    if (predicate(currentTime, latest)) {
      return latest;
    }
    await sleep(300);
  }
  return latest;
};

const seekVideoTo = async (page: puppeteer.Page, nextSeconds: number) => {
  await page.evaluate(({ videoSelector, nextSeconds: desiredSeconds }) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      throw new Error('Video element missing during seek.');
    }
    const bounded = Math.min(
      Math.max(Number(desiredSeconds || 0), 0),
      Number.isFinite(video.duration) ? video.duration : Number(desiredSeconds || 0),
    );
    video.currentTime = bounded;
    void video.play?.().catch(() => undefined);
  }, {
    videoSelector: selectors.coursePlayerVideo,
    nextSeconds,
  });
};

const togglePausePlay = async (page: puppeteer.Page, shouldPause: boolean) => {
  await page.evaluate(({ videoSelector, shouldPause: pauseRequested }) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      throw new Error('Video element missing during pause/play.');
    }
    if (pauseRequested) {
      video.pause();
      return;
    }
    void video.play?.().catch(() => undefined);
  }, {
    videoSelector: selectors.coursePlayerVideo,
    shouldPause,
  });
};

const clickCourseByText = async (page: puppeteer.Page, expectedText: string) => {
  const clicked = await page.evaluate((cardSelector, text) => {
    const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(text.toLowerCase())) || cards[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, expectedText);
  if (!clicked) {
    throw new Error('No course card was available to open.');
  }
};

const clickLessonByText = async (page: puppeteer.Page, expectedText: string) => {
  await page.waitForSelector(selectors.courseLessonOpen, { timeout: 20_000 });
  const clicked = await page.evaluate((lessonSelector, text) => {
    const lessonButtons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const expected = String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const target = lessonButtons.find((button) => {
      const normalized = (button.textContent || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return expected ? normalized.includes(expected) || expected.includes(normalized) : true;
    })
      || lessonButtons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, expectedText);
  if (!clicked) {
    throw new Error('No lesson button was available to open.');
  }
};

const main = async () => {
  const rootEnv = await readRootEnv();
  const email = process.env.QA_LOGIN_EMAIL || process.env.ADMIN_EMAIL || rootEnv.ADMIN_EMAIL || config.loginEmail;
  const password = process.env.QA_LOGIN_PASSWORD || process.env.ADMIN_PASSWORD || rootEnv.ADMIN_PASSWORD || config.loginPassword;
  const courseId = String(process.env.QA_COURSE_ID || '').trim();
  const lessonId = String(process.env.QA_LESSON_ID || '').trim();
  const courseText = process.env.QA_COURSE_TEXT || 'SSC';
  const lessonText = process.env.QA_LESSON_TEXT || (lessonId ? '' : 'Demo');
  const mobileMode = String(process.env.QA_MOBILE_MODE || 'false').toLowerCase() === 'true';
  const playbackWaitMs = Math.max(10_000, Number(process.env.QA_PLAYBACK_WAIT_MS || 18_000));
  const interactionEnabled = String(process.env.QA_ENABLE_INTERACTIONS || 'true').toLowerCase() !== 'false';
  const targetCurrentTimeSeconds = Math.max(10, Number(process.env.QA_TARGET_CURRENT_TIME_SECONDS || 588));
  const postSeekWatchMs = Math.max(5_000, Number(process.env.QA_POST_SEEK_WATCH_MS || 20_000));
  const refreshResumeTargetSeconds = Math.max(1, Number(process.env.QA_REFRESH_RESUME_TARGET_SECONDS || 2));
  const viewport = mobileMode
    ? { width: 430, height: 932, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { width: 2000, height: 1300, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
  const providedToken = process.env.QA_AUTH_TOKEN || '';
  if (!providedToken && (!email || !password)) {
    throw new Error('QA_LOGIN_EMAIL/QA_LOGIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD is required.');
  }

  const ctx = await createRunContext();
  const responses: Array<{
    url: string;
    status: number;
    contentType: string | null;
    bodySample?: string;
  }> = [];
  const consoleIssues: string[] = [];
  const playbackMetrics: PlaybackMetric[] = [];
  const interactionSnapshots: InteractionSnapshot[] = [];
  const summaryPath = path.join(ctx.analysisDir, 'course-playback-rootcause.json');
  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  let page: puppeteer.Page | null = null;
  let token: string | null = null;
  let directLessonUrl: string | null = null;
  let playerPayloadSnapshot: PlayerPayloadSnapshot | null = null;
  let manifestProbe: BrowserManifestProbe | null = null;
  let finalSummary: Record<string, unknown> | null = null;
  try {
    page = await browser.newPage();
    await page.exposeFunction('__recordPlaybackRootcauseMetric', (metric: PlaybackMetric) => {
      playbackMetrics.push(metric);
    });
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('edumaster:hls-metric', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : {};
        void (window as unknown as {
          __recordPlaybackRootcauseMetric?: (metric: PlaybackMetric) => Promise<void>;
        }).__recordPlaybackRootcauseMetric?.(detail as PlaybackMetric);
      });
    });
    await page.setViewport(viewport);
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      if (error instanceof Error) {
        consoleIssues.push(error.stack || error.message);
        return;
      }
      consoleIssues.push(String(error));
    });
    page.on('response', async (response) => {
      const url = response.url();
      if (!/\/player|course-manifests|cloudflarestream\.com|\.m3u8|\.ts|enc\.key/.test(url)) {
        return;
      }
      const record = {
        url,
        status: response.status(),
        contentType: response.headers()['content-type'] || null,
      };
      if (response.status() >= 400) {
        try {
          Object.assign(record, { bodySample: (await response.text()).slice(0, 500) });
        } catch {
          Object.assign(record, { bodySample: '(unavailable)' });
        }
      }
      responses.push(record);
    });

    token = providedToken || await loginForToken(email, password);
    await primeBrowserPlaybackIdentity(page, token);
    await page.goto(withQaParams(config.baseUrl), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.evaluate((authToken, nextDeviceId, nextPlaybackTabId, disableContentProtectionForQa) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
      window.localStorage.setItem('edumaster.device.id', nextDeviceId);
      window.sessionStorage.setItem('edumaster.playback.tab.id', nextPlaybackTabId);
      if (disableContentProtectionForQa) {
        window.localStorage.setItem('edumaster.qa.disableContentProtection', 'true');
      }
    }, token, browserPlaybackDeviceId, browserPlaybackTabId, shouldDisableContentProtectionForQa);
    await page.goto(withQaParams(config.baseUrl), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const authenticatedShellSelector = [
      selectors.shellReady,
      selectors.courseFigmaPage,
      selectors.overviewDashboard,
    ].join(', ');
    await page.waitForSelector([
      authenticatedShellSelector,
      selectors.loginEmail,
    ].join(', '), { timeout: 45_000 });

    if (await page.$(selectors.loginEmail)) {
      if (providedToken) {
        const restoredFromProvidedToken = await waitForOptionalSelector(page, authenticatedShellSelector, 15_000);
        if (!restoredFromProvidedToken && await page.$(selectors.loginEmail)) {
          throw new Error('Provided QA_AUTH_TOKEN did not restore the browser session before the login screen became interactive.');
        }
      }
    }

    if (await page.$(selectors.loginEmail)) {
      await page.locator(selectors.loginEmail).fill(email);
      await page.locator(selectors.loginPassword).fill(password);
      await page.locator(selectors.loginSubmit).click();
      await page.waitForSelector(authenticatedShellSelector, { timeout: 45_000 });
    }

    directLessonUrl = courseId && lessonId
      ? withQaParams(`${config.baseUrl.replace(/\/$/, '')}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`)
      : '';
    if (token && courseId && lessonId) {
      const playerPreflight = await getPlayerPayload(token, courseId, lessonId);
      playerPayloadSnapshot = summarizePlayerPayload(playerPreflight.payload);
    }
    let playerReachedDirectly = false;
    if (directLessonUrl) {
      await page.goto(directLessonUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      playerReachedDirectly = await waitForOptionalSelector(page, `${selectors.courseLessonView}, ${selectors.coursePlayerVideo}`, 20_000);
    }
    if (!playerReachedDirectly) {
      const coursesNavSelector = mobileMode ? `${selectors.mobileNavCourses}, ${selectors.mobileTabCourses}, ${selectors.navCourses}` : selectors.navCourses;
      await clickBySelector(page, coursesNavSelector);
      await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
      await clickCourseByText(page, courseText);
      await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
      await clickLessonByText(page, lessonText);
    }
    await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    if (playerPayloadSnapshot?.streamUrl) {
      manifestProbe = await probeProtectedStreamFromBrowser(page, playerPayloadSnapshot.streamUrl);
      await writeJson(path.join(ctx.analysisDir, 'course-playback-rootcause-player-preflight.json'), {
        playerPayloadSnapshot,
        manifestProbe,
      });
    }
    const navigationTiming = await readNavigationTiming(page);
    interactionSnapshots.push(await captureSnapshot(page, ctx, 'before-play'));
    const playerVisibleAt = Date.now();
    await ensurePlaybackStarted(page);
    const firstProgressState = await waitForCurrentTime(page, (currentTime) => currentTime >= 1, 20_000);
    const firstProgressAt = Date.now();
    interactionSnapshots.push(await captureSnapshot(page, ctx, 'playing-normally'));
    await sleep(playbackWaitMs);

    const titleProbe = await page.evaluate((expectedLessonText) => {
      const expected = String(expectedLessonText || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const candidates = Array.from(document.querySelectorAll([
        '[data-testid="course-player-heading"]',
        '[data-testid="course-player-course-title"]',
        '[data-testid="course-lesson-page"] h1',
        '[data-testid="course-lesson-page"] h2',
        '[data-testid="course-lesson-page"] h3',
        '[data-testid^="course-playlist-lesson-"]',
        '[data-testid="course-player-shell"] h1',
        '[data-testid="course-player-shell"] h2',
      ].join(', ')))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean);
      const matchedCandidate = candidates.find((candidate) => {
        const normalized = String(candidate || '')
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[–—-]+/g, ' ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return expected && (normalized.includes(expected) || expected.includes(normalized));
      }) || '';

      const bodyText = document.body?.innerText || '';
      const bodyLines = bodyText
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const bodyMatch = bodyLines.find((line) => {
        const normalized = String(line || '')
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[–—-]+/g, ' ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return expected && (normalized.includes(expected) || expected.includes(normalized));
      }) || '';

      return {
        candidates,
        matchedCandidate,
        bodyMatch,
        normalizedExpected: expected,
      };
    }, lessonText);
    const displayedLessonTitle = titleProbe.matchedCandidate || titleProbe.bodyMatch || titleProbe.candidates[0] || '';
    interactionSnapshots.push(await captureSnapshot(page, ctx, 'after-long-watch'));

    const interactionTimings: Record<string, number | null> = {
      pageDomContentLoadedMs: navigationTiming?.domContentLoadedMs ?? null,
      pageLoadEventMs: navigationTiming?.loadEventMs ?? null,
      playerVisibleToFirstProgressMs: firstProgressAt - playerVisibleAt,
      seekForwardRecoveryMs: null,
      seekBackwardRecoveryMs: null,
      pauseResumeRecoveryMs: null,
      refreshResumeRecoveryMs: null,
    };
    let atTargetState: VideoDiagnostics | null = null;
    let afterSeekForwardState: VideoDiagnostics | null = null;
    let afterSeekBackwardState: VideoDiagnostics | null = null;
    let afterPauseResumeState: VideoDiagnostics | null = null;
    let afterRefreshResumeState: VideoDiagnostics | null = null;
    let beforeRefreshCurrentTime = 0;

    if (interactionEnabled) {
      const preInteractionState = await readVideoDiagnostics(page);
      const duration = Number(preInteractionState.duration || 0);
      const seekForwardTarget = duration > targetCurrentTimeSeconds + 120
        ? targetCurrentTimeSeconds + 120
        : Math.max(Number(preInteractionState.currentTime || 0) + 60, targetCurrentTimeSeconds);
      const seekBackwardTarget = Math.max(10, seekForwardTarget - 90);

      await seekVideoTo(page, targetCurrentTimeSeconds);
      atTargetState = await waitForCurrentTime(page, (currentTime) => currentTime >= Math.max(targetCurrentTimeSeconds - 3, 1), 25_000);
      interactionSnapshots.push(await captureSnapshot(page, ctx, 'around-target-time'));
      await sleep(postSeekWatchMs);

      const seekForwardStartedAt = Date.now();
      await seekVideoTo(page, seekForwardTarget);
      afterSeekForwardState = await waitForCurrentTime(page, (currentTime) => currentTime >= Math.max(seekForwardTarget - 3, 1), 25_000);
      interactionTimings.seekForwardRecoveryMs = Date.now() - seekForwardStartedAt;
      interactionSnapshots.push(await captureSnapshot(page, ctx, 'after-seek-forward'));
      await sleep(postSeekWatchMs);

      const seekBackwardStartedAt = Date.now();
      await seekVideoTo(page, seekBackwardTarget);
      afterSeekBackwardState = await waitForCurrentTime(page, (currentTime) => currentTime >= Math.max(seekBackwardTarget - 3, 1), 25_000);
      interactionTimings.seekBackwardRecoveryMs = Date.now() - seekBackwardStartedAt;
      interactionSnapshots.push(await captureSnapshot(page, ctx, 'after-seek-backward'));

      await sleep(3_000);
      const pauseStartedAt = Date.now();
      await togglePausePlay(page, true);
      await sleep(1_000);
      await togglePausePlay(page, false);
      afterPauseResumeState = await waitForCurrentTime(
        page,
        (currentTime) => currentTime > Number(afterSeekBackwardState?.currentTime || 0) + refreshResumeTargetSeconds,
        20_000,
      );
      interactionTimings.pauseResumeRecoveryMs = Date.now() - pauseStartedAt;
      interactionSnapshots.push(await captureSnapshot(page, ctx, 'after-pause-resume'));

      beforeRefreshCurrentTime = Number(afterPauseResumeState.currentTime || afterSeekBackwardState?.currentTime || atTargetState?.currentTime || 0);
      const refreshStartedAt = Date.now();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
      await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
      await ensurePlaybackStarted(page);
      afterRefreshResumeState = await waitForCurrentTime(
        page,
        (currentTime) => currentTime >= Math.max(beforeRefreshCurrentTime - 10, 1),
        30_000,
      );
      interactionTimings.refreshResumeRecoveryMs = Date.now() - refreshStartedAt;
      interactionSnapshots.push(await captureSnapshot(page, ctx, 'after-refresh-resume'));
    }

    const diagnostics = await readVideoDiagnostics(page);
    const finalSnapshot = await captureSnapshot(page, ctx, 'player');

    const failedResponses = responses.filter((entry) => entry.status >= 400);
    const playableProbeSeconds = Math.max(
      Number(diagnostics.currentTime || 0),
      Number(firstProgressState.currentTime || 0),
      Number(atTargetState?.currentTime || 0),
      Number(afterSeekForwardState?.currentTime || 0),
      Number(afterSeekBackwardState?.currentTime || 0),
      Number(afterPauseResumeState?.currentTime || 0),
      Number(afterRefreshResumeState?.currentTime || 0),
    );
    const playable = playableProbeSeconds > 1;
    const bootstrapFailure = classifyBootstrapFailure({
      playerPayloadSnapshot,
      manifestProbe,
      diagnostics: firstProgressState,
      playbackAdvanced: playable,
      lessonOpenReached: true,
    });
    const deliveryPath = resolveRecordedDeliveryPath(playbackMetrics, diagnostics.currentSrc, responses);
    const deliveryProfile = playbackMetrics.find((metric) => typeof metric.deliveryProfile === 'string')?.deliveryProfile || null;
    const regressionFlags: RegressionFlags = {
      falseConflictVisible: interactionSnapshots.some((snapshot) => snapshot.diagnostics.visibleTextFlags.anotherTabOrDevice),
      seekForwardRecovered: !interactionEnabled || Number(afterSeekForwardState?.currentTime || 0) >= Math.max(targetCurrentTimeSeconds, 1),
      seekBackwardRecovered: !interactionEnabled || Number(afterSeekBackwardState?.currentTime || 0) >= 1,
      pauseResumeRecovered: !interactionEnabled || Number(afterPauseResumeState?.currentTime || 0) > Number(afterSeekBackwardState?.currentTime || 0),
      refreshResumePreserved: !interactionEnabled || Number(afterRefreshResumeState?.currentTime || 0) >= Math.max(beforeRefreshCurrentTime - 10, 1),
      unexpectedBackwardJumpDetected: Boolean(
        interactionEnabled
        && beforeRefreshCurrentTime > 0
        && Number(afterRefreshResumeState?.currentTime || 0) + 10 < beforeRefreshCurrentTime
      ),
    };
    const summary = {
      ok: playable
        && failedResponses.length === 0
        && !diagnostics.visibleTextFlags.reconnecting
        && !diagnostics.visibleTextFlags.retry
        && !diagnostics.visibleTextFlags.playbackStopped
        && !diagnostics.visibleTextFlags.anotherTabOrDevice
        && !regressionFlags.unexpectedBackwardJumpDetected
        && !regressionFlags.falseConflictVisible
        && regressionFlags.seekForwardRecovered
        && regressionFlags.seekBackwardRecovered
        && regressionFlags.pauseResumeRecovered
        && regressionFlags.refreshResumePreserved
        && (!lessonText || matchesNormalizedLabel(displayedLessonTitle, lessonText)),
      baseUrl: config.baseUrl,
      directLessonUrl: directLessonUrl || null,
      courseText,
      lessonText,
      failureCode: bootstrapFailure.failureCode,
      failurePhase: bootstrapFailure.failurePhase,
      playbackBootstrapReached: playable,
      playerPayloadSnapshot,
      manifestProbe,
      displayedLessonTitle,
      deliveryPath,
      deliveryProfile,
      mobileMode,
      viewport,
      titleProbe,
      interactionTimings,
      regressionFlags,
      playableProbeSeconds,
      diagnostics,
      interactionSnapshots,
      failedResponses,
      responses,
      consoleIssues,
      playbackMetrics,
      screenshotPath: finalSnapshot.screenshotPath,
      sourcePath: finalSnapshot.sourcePath,
    };
    finalSummary = summary;
    await writeJson(summaryPath, summary);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (page) {
      const screenshotPath = artifactPath(ctx.screenshotDir, 'course-playback-rootcause', 'failure', 'png');
      const sourcePath = artifactPath(ctx.sourceDir, 'course-playback-rootcause', 'failure', 'html');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await fs.writeFile(sourcePath, await page.content(), 'utf8').catch(() => undefined);
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)).catch(() => '');
      const diagnostics = await readVideoDiagnostics(page).catch(() => null);
      const bootstrapFailure = classifyBootstrapFailure({
        playerPayloadSnapshot,
        manifestProbe,
        diagnostics: diagnostics || {
          currentTime: null,
          duration: null,
          paused: null,
          readyState: null,
          networkState: null,
          currentSrc: null,
          bufferedRanges: [],
          error: null,
          visibleTextFlags: {
            reconnecting: false,
            retry: false,
            playbackStopped: false,
            anotherTabOrDevice: false,
            preparing: false,
            unavailable: false,
          },
          bodyTextSnippet: bodyText,
        },
        playbackAdvanced: Boolean(Number(diagnostics?.currentTime || 0) > 1),
        lessonOpenReached: Boolean(page),
      });
      const failureSummary = {
        ok: false,
        baseUrl: config.baseUrl,
        directLessonUrl: directLessonUrl || null,
        courseText,
        lessonText,
        failureCode: bootstrapFailure.failureCode || 'STREAM_BOOTSTRAP_FAILED',
        failurePhase: bootstrapFailure.failurePhase || 'playback-advance',
        playbackBootstrapReached: Boolean(Number(diagnostics?.currentTime || 0) > 1),
        playerPayloadSnapshot,
        manifestProbe,
        diagnostics,
        bodyText,
        responses,
        consoleIssues,
        playbackMetrics,
        interactionSnapshots,
        screenshotPath,
        sourcePath,
        message: error instanceof Error ? error.message : String(error),
      };
      finalSummary = failureSummary;
      await writeJson(path.join(ctx.analysisDir, 'course-playback-rootcause-failure.json'), {
        message: error instanceof Error ? error.message : String(error),
        bodyText,
        responses,
        consoleIssues,
        playerPayloadSnapshot,
        manifestProbe,
        screenshotPath,
        sourcePath,
      });
      await writeJson(summaryPath, failureSummary);
      console.error(`Failure screenshot: ${screenshotPath}`);
    }
    throw error;
  } finally {
    if (finalSummary && !(await fs.access(summaryPath).then(() => true).catch(() => false))) {
      await writeJson(summaryPath, finalSummary).catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
const withQaParams = (url: string) => {
  if (!shouldDisableContentProtectionForQa) {
    return url;
  }
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('qaDisableContentProtection', '1');
  return nextUrl.toString();
};
