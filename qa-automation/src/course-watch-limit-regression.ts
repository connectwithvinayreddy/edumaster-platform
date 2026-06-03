import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { classifyRecordedDeliveryPath } from './recorded-delivery-path.js';
import { selectors } from './selectors.js';

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
const requestedEnvFile = String(process.env.ENV_FILE || '').trim();
const resolvedEnvPath = requestedEnvFile
  ? (path.isAbsolute(requestedEnvFile) ? requestedEnvFile : path.resolve(rootDir, requestedEnvFile))
  : path.join(rootDir, '.env');
dotenv.config({ path: resolvedEnvPath });

const baseUrl = (process.env.QA_BASE_URL || 'http://localhost:3300').replace(/\/+$/, '');
const apiBaseUrl = (process.env.QA_API_BASE_URL || `${baseUrl}/backend/api`).replace(/\/+$/, '');
const shouldDisableContentProtectionForQa = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl);
const adminEmail = String(process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglish.com').trim();
const adminPassword = String(process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const studentPassword = String(process.env.QA_STUDENT_PASSWORD || 'Student@123').trim();
const watchLimitCourseId = String(process.env.QA_WATCH_LIMIT_COURSE_ID || '').trim();
const watchLimitLessonId = String(process.env.QA_WATCH_LIMIT_LESSON_ID || '').trim();
const watchLimitCourseText = String(process.env.QA_WATCH_LIMIT_COURSE_TEXT || '').trim();
const watchLimitLessonText = String(process.env.QA_WATCH_LIMIT_LESSON_TEXT || '').trim();
const cleanupMode = String(process.env.QA_AUTOMATION_CLEANUP_MODE || 'execute').trim().toLowerCase();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const artifactDir = path.join(rootDir, 'qa-automation', 'artifacts', `course-watch-limit-regression-${runId}`);
const approvedUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
const desktopEdgeUserAgent = approvedUserAgent;
const mobileChromeUserAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const playbackTabId = `qa-watch-limit-tab-${runId}`;
const deviceId = `qa-watch-limit-device-${runId}`;
const defaultWatchCompletionSeekRatio = Math.max(0.9, Math.min(0.99, Number(process.env.QA_WATCH_LIMIT_SEEK_RATIO || 0.96)));

const isSafeSyntheticEmail = (email: string) => /^(qa\.|automation\.|platform_load_)/i.test(String(email || '').trim())
  || /@edumaster\.local$/i.test(String(email || '').trim());

type AuthSession = {
  token: string;
  user: {
    _id: string;
    email: string;
    role: string;
    name: string;
  };
};

type AuditLesson = {
  id: string;
  title: string;
  hlsProcessingStatus?: string | null;
  hlsPlaybackPath?: string | null;
  duration?: string | number | null;
};

type PlayerPayload = {
  resumeSeconds: number;
  playbackSessionId?: string | null;
  streamUrl?: string | null;
  streamFormat?: string | null;
  deliveryProfile?: string | null;
  duration?: string | number | null;
  durationSeconds?: number | null;
  videoDurationSeconds?: number | null;
  watchState?: {
    completedFullWatches: number;
    locked: boolean;
    currentCycleUniqueWatchedSeconds: number;
    remainingRevisionBufferSeconds?: number;
    graceRemainingSeconds?: number;
    graceUsedSeconds?: number;
    graceTotalSeconds?: number;
    replayState?: string | null;
    completionProofSatisfied?: boolean;
    completionThresholdPercentage?: number;
    endStabilityWindowSeconds?: number;
    endStabilitySatisfied?: boolean;
    stableEndWindowWatchedSeconds?: number;
    playbackStatus?: string | null;
  } | null;
  watchLimit?: number | null;
  watchCompletionPercent?: number | null;
  playbackStatus?: string | null;
  code?: string;
  message?: string;
};

type NetworkLogEntry = {
  url: string;
  status: number;
  contentType: string | null;
  bodySample?: string;
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

type PlayerPayloadSnapshot = ReturnType<typeof summarizePlayerPayload>;

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

type PlaybackBootstrapSummary = {
  lessonOpenReached: boolean;
  playerVisible: boolean;
  playbackBootstrapReached: boolean;
  currentPlaybackTime: number | null;
  visiblePlayerStateText: string | null;
  playerPayloadSnapshot: PlayerPayloadSnapshot | null;
  manifestProbe: BrowserManifestProbe | null;
  failureCode: BootstrapFailureCode | null;
  failurePhase: BootstrapFailurePhase | null;
};

type StudentDetailsPayload = {
  student?: {
    _id?: string;
    email?: string;
  };
  watchProgress?: Array<{
    stateId: string;
    courseId: string;
    lessonId: string | null;
    videoId: string;
    videoType: string;
    completedFullWatches: number;
    allowedFullWatches: number;
    progressSeconds: number;
    lastHeartbeatAt: string | null;
    activeSessionStatus: string;
    deviceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    locked: boolean;
    updatedAt: string | null;
  }>;
};

type CourseCatalogItem = {
  _id?: string;
  title?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureDir = async () => {
  await fs.mkdir(artifactDir, { recursive: true });
};

const isUnauthorizedError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^401\b/.test(message.trim());
};

const writeJson = async (fileName: string, payload: unknown) => {
  await fs.writeFile(path.join(artifactDir, fileName), JSON.stringify(payload, null, 2), 'utf8');
};

const requestJson = async <T = any>(input: string, init: RequestInit = {}) => {
  const res = await fetch(input, init);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { res, data: data as T, text };
};

const assertOk = async <T = any>(input: string, init: RequestInit = {}) => {
  const result = await requestJson<T>(input, init);
  if (!result.res.ok) {
    const payload = result.data as any;
    throw new Error(`${result.res.status} ${payload?.message || payload?.error || result.text.slice(0, 200)}`);
  }
  return result;
};

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
});

const playbackHeaders = (
  token: string,
  {
    nextDeviceId = deviceId,
    nextPlaybackTabId = playbackTabId,
  }: {
    nextDeviceId?: string;
    nextPlaybackTabId?: string;
  } = {},
) => ({
  ...authHeaders(token),
  accept: 'application/json',
  'user-agent': approvedUserAgent,
  'x-edumaster-app': 'web',
  'x-edumaster-client-platform': 'windows',
  'x-edumaster-client-browser': 'edge',
  'x-edumaster-device-id': nextDeviceId,
  'x-edumaster-playback-tab-id': nextPlaybackTabId,
  'x-edumaster-browser-tab-id': nextPlaybackTabId,
});

const login = async (email: string, password: string, device: string) => {
  const result = await assertOk<AuthSession>(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      identifier: email,
      password,
      device,
      forceLogoutOtherSessions: true,
    }),
  });
  return result.data;
};

const registerStudent = async () => {
  const email = `qa.watch.limit.${Date.now()}@edumaster.local`;
  const mobileNumber = `9${String(Date.now()).slice(-9)}`;
  const result = await assertOk<AuthSession>(`${apiBaseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'QA Watch Limit Student',
      email,
      mobileNumber,
      password: studentPassword,
      device: `qa-watch-limit-${runId}`,
    }),
  });
  return {
    ...result.data,
    email,
    password: studentPassword,
  };
};

const assignCourseToStudent = async (token: string, studentId: string, courseId: string) =>
  assertOk(`${apiBaseUrl}/admin/purchases/assign-course`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      studentId,
      courseId,
      adminNote: 'QA browser-first watch-limit regression',
    }),
  });

const getStudentDetails = async (token: string, studentId: string) =>
  assertOk<StudentDetailsPayload>(`${apiBaseUrl}/admin/students/${encodeURIComponent(studentId)}`, {
    headers: authHeaders(token),
  });

const getCourses = async (token: string) =>
  assertOk<CourseCatalogItem[]>(`${apiBaseUrl}/courses`, {
    headers: authHeaders(token),
  });

const getCourseLessons = async (token: string, courseId: string) =>
  assertOk<AuditLesson[]>(`${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/lessons`, {
    headers: authHeaders(token),
  });

const getPlayer = async (token: string, courseId: string, lessonId: string) =>
  requestJson<PlayerPayload>(`${apiBaseUrl}/courses/${courseId}/lessons/${lessonId}/player`, {
    headers: playbackHeaders(token),
  });

const classifyDeliveryPathFromSrc = (src: string | null | undefined) => classifyRecordedDeliveryPath({
  src: src || null,
  streamFormat: /\.m3u8(?:\?|$)/i.test(String(src || '')) ? 'hls' : null,
});

const postWatchProgress = async (token: string, payload: {
  courseId: string;
  lessonId: string;
  progressPercent: number;
  progressSeconds: number;
  completed?: boolean;
  durationSeconds: number;
  eventType?: string;
  requestTimestamp?: string;
}) =>
  requestJson(`${apiBaseUrl}/platform/watch-progress`, {
    method: 'POST',
    headers: {
      ...playbackHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      courseId: payload.courseId,
      lessonId: payload.lessonId,
      progressPercent: payload.progressPercent,
      progressSeconds: payload.progressSeconds,
      completed: Boolean(payload.completed),
      lessonStage: 'video',
      durationSeconds: payload.durationSeconds,
      eventType: payload.eventType || 'progress',
      playbackTabId,
      requestTimestamp: payload.requestTimestamp || new Date().toISOString(),
    }),
  });

const trackHeartbeat = async (token: string, payload: {
  courseId: string;
  lessonId: string;
  playbackSessionId: string;
  previousPositionSeconds: number;
  currentPositionSeconds: number;
  durationSeconds: number;
  playbackRate?: number;
  timestamp?: string;
}) =>
  assertOk(`${apiBaseUrl}/track`, {
    method: 'POST',
    headers: {
      ...playbackHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      courseId: payload.courseId,
      lessonId: payload.lessonId,
      videoId: payload.lessonId,
      videoType: 'course',
      playbackSessionId: payload.playbackSessionId,
      previousPositionSeconds: payload.previousPositionSeconds,
      currentPositionSeconds: payload.currentPositionSeconds,
      durationSeconds: payload.durationSeconds,
      isPlaying: true,
      isPaused: false,
      isBuffering: false,
      playbackRate: payload.playbackRate || 1,
      timestamp: payload.timestamp || new Date().toISOString(),
    }),
  });

const extractPlayerWatchState = (payload: any) => payload?.watchState || payload?.details?.watchState || null;

const waitForPlayerWatchState = async (
  token: string,
  courseId: string,
  lessonId: string,
  predicate: (
    state: NonNullable<ReturnType<typeof extractPlayerWatchState>>,
    result: { status: number; data: PlayerPayload },
  ) => boolean,
  timeoutMs = 30_000,
) => {
  const deadline = Date.now() + timeoutMs;
  let latest: { status: number; data: PlayerPayload; watchState: ReturnType<typeof extractPlayerWatchState> } | null = null;
  while (Date.now() < deadline) {
    const result = await getPlayer(token, courseId, lessonId);
    const watchState = extractPlayerWatchState(result.data);
    latest = {
      status: result.res.status,
      data: result.data,
      watchState,
    };
    if (watchState && predicate(watchState, latest)) {
      return latest;
    }
    await sleep(1500);
  }
  return latest;
};

const summarizePlayerPayload = (payload: PlayerPayload | null | undefined) => {
  const watchState = extractPlayerWatchState(payload);
  return {
    playbackSessionId: payload?.playbackSessionId || null,
    streamUrl: payload?.streamUrl || null,
    streamFormat: payload?.streamFormat || null,
    deliveryProfile: payload?.deliveryProfile || null,
    playbackStatus: payload?.playbackStatus || watchState?.playbackStatus || null,
    watchLimit: payload?.watchLimit ?? null,
    watchCompletionPercent: payload?.watchCompletionPercent ?? null,
    durationSeconds: payload?.durationSeconds ?? payload?.videoDurationSeconds ?? payload?.duration ?? null,
    code: payload?.code || null,
    message: payload?.message || null,
    watchState,
  };
};

const getGraceRemainingSeconds = (watchState: ReturnType<typeof extractPlayerWatchState> | null | undefined) =>
  Math.max(
    Number(
      watchState?.graceRemainingSeconds
      ?? watchState?.remainingRevisionBufferSeconds
      ?? 0,
    ),
    0,
  );

const getRemoteWatchState = async (token: string, studentId: string, courseId: string, lessonId: string) => {
  const details = await getStudentDetails(token, studentId);
  const match = (details.data.watchProgress || []).find((entry) =>
    String(entry.courseId) === String(courseId)
    && String(entry.lessonId || entry.videoId) === String(lessonId),
  );
  return {
    details: details.data,
    watchState: match || null,
  };
};

const resetRemoteWatchState = async (token: string, studentId: string, stateId: string) =>
  assertOk(`${apiBaseUrl}/admin/students/${encodeURIComponent(studentId)}/watch-progress/${encodeURIComponent(stateId)}/reset`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      reason: 'QA production-course watch-limit certification reset',
    }),
  });

const removeCourseAccess = async (token: string, studentId: string, courseId: string) =>
  assertOk(`${apiBaseUrl}/admin/purchases/remove-course`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      studentId,
      courseId,
      adminNote: 'QA production-course watch-limit cleanup',
    }),
  });

const clearPlaybackSessions = async (token: string, studentId: string) =>
  assertOk(`${apiBaseUrl}/admin/students/${encodeURIComponent(studentId)}/playback-sessions/clear`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      reason: 'QA production-course watch-limit cleanup',
    }),
  });

const updateStudentStatus = async (token: string, studentId: string, status: 'active' | 'disabled') =>
  assertOk(`${apiBaseUrl}/admin/students/${encodeURIComponent(studentId)}/status`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      status,
      note: 'QA production-course watch-limit cleanup',
    }),
  });

const parseDurationSeconds = (value: string | number | null | undefined) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  const raw = String(value || '').trim();
  if (!raw) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }
  return 0;
};

const withQaParams = (url: string) => {
  if (!shouldDisableContentProtectionForQa) {
    return url;
  }
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('qaDisableContentProtection', '1');
  return nextUrl.toString();
};

const lessonUrl = (courseId: string, lessonId: string) =>
  withQaParams(`${baseUrl.replace(/\/$/, '')}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`);

const clickBySelector = async (page: puppeteer.Page, selector: string, timeoutMs = 20_000) => {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector) as HTMLElement | null;
    element?.scrollIntoView({ block: 'center', inline: 'nearest' });
    element?.click();
  }, selector);
};

const clickCourseByText = async (page: puppeteer.Page, expectedText: string) => {
  const clicked = await page.evaluate((cardSelector, text) => {
    const cards = [
      ...Array.from(document.querySelectorAll(cardSelector)),
      ...Array.from(document.querySelectorAll('[data-testid^="overview-active-course-card-"]')),
    ] as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(String(text || '').toLowerCase())) || cards[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, expectedText);
  if (!clicked) {
    throw new Error(`No course card was available for text: ${expectedText}`);
  }
};

const clickAnyButtonByText = async (page: puppeteer.Page, expectedText: string) => {
  const clicked = await page.evaluate((text) => {
    const normalizedExpected = String(text || '').toLowerCase().trim();
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLElement[];
    const target = buttons.find((button) =>
      (button.textContent || '').toLowerCase().includes(normalizedExpected),
    ) || null;
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, expectedText);
  return clicked;
};

const clickLessonByText = async (page: puppeteer.Page, expectedText: string) => {
  await page.waitForSelector(selectors.courseLessonOpen, { timeout: 20_000 });
  const clicked = await page.evaluate((lessonSelector, text) => {
    const expected = String(text || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const lessonButtons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
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
    }) || lessonButtons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, expectedText);
  if (!clicked) {
    throw new Error(`No lesson button was available for text: ${expectedText}`);
  }
};

const ensureBrowserDirs = async () => {
  await fs.mkdir(path.join(artifactDir, 'screenshots'), { recursive: true });
  await fs.mkdir(path.join(artifactDir, 'sources'), { recursive: true });
};

const screenshotPathFor = (label: string) => path.join(artifactDir, 'screenshots', `${label}.png`);
const sourcePathFor = (label: string) => path.join(artifactDir, 'sources', `${label}.html`);

const takeBrowserArtifacts = async (page: puppeteer.Page, label: string) => {
  const screenshotPath = screenshotPathFor(label);
  const sourcePath = sourcePathFor(label);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

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

const shellOrCourseSelector = [
  selectors.shellReady,
  selectors.overviewDashboard,
  selectors.courseFigmaPage,
  selectors.courseCatalogView,
  selectors.courseCourseView,
  selectors.courseLessonView,
  selectors.navCourses,
].join(', ');

const waitForSelectorOptional = async (page: puppeteer.Page, selector: string, timeoutMs: number) => page
  .waitForSelector(selector, { timeout: timeoutMs })
  .then(() => true)
  .catch(() => false);

const hasBlockedWatchLimitUi = async (page: puppeteer.Page) => page.evaluate(() => {
  const bodyText = document.body?.innerText || '';
  return /video watch limit reached|lesson video unavailable|maximum lesson video rewatch limit reached|maximum limit reached|rewatch limit/i.test(bodyText);
});

const readBrowserState = async (page: puppeteer.Page) => page.evaluate((videoSelector) => {
  const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
  const bodyText = document.body?.innerText || '';
  const watchCountMatch = bodyText.match(/(\d+\s*\/\s*\d+(?:\s*watches?\s*used)?)/i);
  return {
    currentTime: video?.currentTime ?? null,
    duration: Number.isFinite(video?.duration) ? Number(video?.duration) : null,
    currentSrc: video?.currentSrc || null,
    paused: video?.paused ?? null,
    ended: video?.ended ?? null,
    readyState: video?.readyState ?? null,
    playbackStopped: /playback stopped/i.test(bodyText),
    anotherDevice: /another tab or device/i.test(bodyText),
    retryVisible: /retry/i.test(bodyText),
    watchCountText: watchCountMatch ? watchCountMatch[1] : null,
    rewatchAvailable: /rewatch lesson|rewatch available|grace replay available/i.test(bodyText),
    rewatchBlocked: /maximum lesson video rewatch limit reached|maximum limit reached|video watch limit reached|lesson video unavailable|video limit reached|allowed 2 watches|2\/2|rewatch limit/i.test(bodyText),
    bodyTextSnippet: bodyText.slice(0, 4000),
  };
}, selectors.coursePlayerVideo);

const classifyBootstrapFailure = ({
  lessonOpenReached,
  playerVisible,
  playerPayloadSnapshot,
  manifestProbe,
  browserState,
  playbackAdvanced,
}: {
  lessonOpenReached: boolean;
  playerVisible: boolean;
  playerPayloadSnapshot: PlayerPayloadSnapshot | null;
  manifestProbe: BrowserManifestProbe | null;
  browserState: Awaited<ReturnType<typeof readBrowserState>>;
  playbackAdvanced: boolean;
}): { failureCode: BootstrapFailureCode | null; failurePhase: BootstrapFailurePhase | null } => {
  if (!playerPayloadSnapshot) {
    return {
      failureCode: 'PLAYER_API_FAILED',
      failurePhase: 'player-api',
    };
  }
  if (!lessonOpenReached) {
    return {
      failureCode: 'STREAM_BOOTSTRAP_FAILED',
      failurePhase: 'lesson-open',
    };
  }
  const requireManifestProbe = shouldRequireManifestProbe(playerPayloadSnapshot);
  if (requireManifestProbe && (manifestProbe?.error || (manifestProbe?.manifest.status != null && !manifestProbe.manifest.ok))) {
    return {
      failureCode: 'MANIFEST_FETCH_FAILED',
      failurePhase: 'manifest-fetch',
    };
  }
  if (requireManifestProbe && manifestProbe?.nextResource && manifestProbe.nextResource.status != null && !manifestProbe.nextResource.ok) {
    return {
      failureCode: 'SEGMENT_FETCH_FAILED',
      failurePhase: 'next-resource-fetch',
    };
  }
  if (!playerVisible || (!browserState.currentSrc && Number(browserState.readyState || 0) <= 0)) {
    return {
      failureCode: 'HLS_ATTACH_TIMEOUT',
      failurePhase: 'hls-attach',
    };
  }
  if (!playbackAdvanced) {
    return {
      failureCode: 'PLAYBACK_ADVANCE_TIMEOUT',
      failurePhase: 'playback-advance',
    };
  }
  return {
    failureCode: null,
    failurePhase: null,
  };
};

const primeBrowserPlaybackIdentity = async (page: puppeteer.Page, token?: string | null) => {
  await page.evaluateOnNewDocument((authToken, nextDeviceId, nextPlaybackTabId, disableContentProtectionForQa) => {
    try {
      window.localStorage.setItem('edumaster.device.id', nextDeviceId);
    } catch {
      // Ignore storage failures and let the app fall back to runtime generation.
    }
    try {
      window.sessionStorage.setItem('edumaster.playback.tab.id', nextPlaybackTabId);
    } catch {
      // Ignore storage failures and let the app fall back to runtime generation.
    }
    if (authToken) {
      try {
        window.localStorage.setItem('edumaster.jwt', authToken);
      } catch {
        // Ignore storage failures and let the normal login flow continue.
      }
    }
    if (disableContentProtectionForQa) {
      try {
        window.localStorage.setItem('edumaster.qa.disableContentProtection', 'true');
      } catch {
        // Ignore storage failures in locked-down browsers.
      }
    }
  }, token || null, deviceId, playbackTabId, shouldDisableContentProtectionForQa);
};

const loginInBrowser = async (page: puppeteer.Page, email: string, password: string, token?: string | null) => {
  await page.goto(withQaParams(baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (token) {
    await page.evaluate((authToken, nextDeviceId, nextPlaybackTabId, disableContentProtectionForQa) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
      window.localStorage.setItem('edumaster.device.id', nextDeviceId);
      window.sessionStorage.setItem('edumaster.playback.tab.id', nextPlaybackTabId);
      if (disableContentProtectionForQa) {
        window.localStorage.setItem('edumaster.qa.disableContentProtection', 'true');
      }
    }, token, deviceId, playbackTabId, shouldDisableContentProtectionForQa);
    await page.goto(withQaParams(baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  try {
    await page.waitForSelector(`${selectors.loginEmail}, ${shellOrCourseSelector}`, { timeout: 45_000 });
  } catch (error) {
    if (token) {
      return;
    }
    throw error;
  }
  if (await page.$(selectors.loginEmail) === null) {
    return;
  }
  if (token) {
    const restoredFromProvidedToken = await waitForSelectorOptional(page, shellOrCourseSelector, 15_000);
    if (restoredFromProvidedToken && await page.$(selectors.loginEmail) === null) {
      return;
    }
  }
  await page.type(selectors.loginEmail, email);
  await page.type(selectors.loginPassword, password);
  await page.click(selectors.loginSubmit);
  await page.waitForSelector(shellOrCourseSelector, { timeout: 45_000 });
};

const openLessonInBrowser = async (
  page: puppeteer.Page,
  viewport: 'desktop' | 'mobile',
  targetCourseId: string,
  targetLessonId: string,
  targetCourseTitle: string,
  targetLessonTitle: string,
  {
    allowBlockedView = false,
  }: {
    allowBlockedView?: boolean;
  } = {},
) => {
  const blockedLessonSelectors = `${selectors.coursePlayerRewatchLimit}, ${selectors.coursePlayerRewatchVideo}`;
  const lessonReadySelector = allowBlockedView
    ? `${selectors.courseLessonView}, ${selectors.coursePlayerShell}, ${selectors.coursePlayerVideo}, ${blockedLessonSelectors}`
    : `${selectors.courseLessonView}, ${selectors.coursePlayerShell}, ${selectors.coursePlayerVideo}`;
  await page.goto(lessonUrl(targetCourseId, targetLessonId), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const directReached = await waitForSelectorOptional(page, lessonReadySelector, 30_000);
  const videoReachedDirectly = directReached
    ? await waitForSelectorOptional(page, selectors.coursePlayerVideo, allowBlockedView ? 5_000 : 15_000)
    : false;
  const blockedReachedDirectly = allowBlockedView
    ? (await waitForSelectorOptional(page, blockedLessonSelectors, 2_000) || await hasBlockedWatchLimitUi(page))
    : false;
  if (!directReached || (!videoReachedDirectly && !blockedReachedDirectly)) {
    await waitForSelectorOptional(page, shellOrCourseSelector, 15_000);
    const openedFromCurrentPage = await clickAnyButtonByText(page, targetCourseTitle);
    if (!openedFromCurrentPage) {
      const coursesNavSelector = viewport === 'mobile'
        ? `${selectors.mobileNavCourses}, ${selectors.mobileTabCourses}, ${selectors.navCourses}`
        : selectors.navCourses;
      if (!await waitForSelectorOptional(page, coursesNavSelector, 10_000)) {
        await page.goto(withQaParams(baseUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForSelector(shellOrCourseSelector, { timeout: 45_000 });
      }
      await clickBySelector(page, coursesNavSelector, 20_000);
      await page.waitForSelector(`${selectors.courseCatalogView}, ${selectors.courseCatalogCard}`, { timeout: 30_000 });
      await clickCourseByText(page, targetCourseTitle);
    }
    await page.waitForSelector(`${selectors.courseCourseView}, ${selectors.courseLessonOpen}`, { timeout: 30_000 });
    await clickLessonByText(page, targetLessonTitle);
  }
  await page.waitForSelector(lessonReadySelector, { timeout: 45_000 });
  const playerVisible = await waitForSelectorOptional(page, selectors.coursePlayerVideo, allowBlockedView ? 5_000 : 45_000);
  const blockedVisible = allowBlockedView
    ? (await waitForSelectorOptional(page, blockedLessonSelectors, 2_000) || await hasBlockedWatchLimitUi(page))
    : false;

  if (!playerVisible && !(allowBlockedView && blockedVisible)) {
    throw new Error(`Lesson opened without an active player or blocked replay UI for ${targetLessonTitle}.`);
  }

  return {
    playerVisible,
    blockedVisible,
  };
};

const startPlayback = async (page: puppeteer.Page) => {
  const playButtonVisible = await waitForSelectorOptional(page, selectors.coursePlayerVideoPlay, 5_000);
  if (playButtonVisible) {
    await page.click(selectors.coursePlayerVideoPlay).catch(() => undefined);
  }

  const videoHandle = await page.$(selectors.coursePlayerVideo);
  if (videoHandle) {
    const box = await videoHandle.boundingBox();
    if (box) {
      await page.mouse.click(box.x + (box.width / 2), box.y + (box.height / 2)).catch(() => undefined);
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

const waitForPlaybackAdvance = async (page: puppeteer.Page, timeoutMs = 30_000) => {
  await page.waitForFunction((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      return false;
    }
    return Number(video.currentTime || 0) > 1;
  }, { timeout: timeoutMs }, selectors.coursePlayerVideo);
};

const pausePlayback = async (page: puppeteer.Page) => {
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      return;
    }
    video.pause?.();
  }, selectors.coursePlayerVideo);
};

const simulateThresholdWatch = async (
  token: string,
  courseId: string,
  lessonId: string,
  playbackSessionId: string,
  durationSeconds: number,
  {
    startingPositionSeconds = 0,
    completionThresholdPercentage = 95,
    endStabilityWindowSeconds = 12,
  }: {
    startingPositionSeconds?: number;
    completionThresholdPercentage?: number;
    endStabilityWindowSeconds?: number;
  } = {},
) => {
  const heartbeatDelayMs = Math.max(200, Number(process.env.QA_WATCH_LIMIT_HEARTBEAT_DELAY_MS || 250));
  const heartbeatStepSeconds = Math.max(4, Math.min(8, Number(process.env.QA_WATCH_LIMIT_HEARTBEAT_STEP || 6)));
  const playbackRate = Math.max(1, Math.min(2, Number(process.env.QA_WATCH_LIMIT_HEARTBEAT_PLAYBACK_RATE || 2)));
  const events: any[] = [];
  const safeDurationSeconds = Math.max(Number(durationSeconds || 0), 1);
  const safeThresholdPercentage = Math.max(
    1,
    Math.min(100, Number(completionThresholdPercentage || 95) || 95),
  );
  const safeEndStabilityWindowSeconds = Math.max(
    1,
    Math.min(safeDurationSeconds, Number(endStabilityWindowSeconds || 12) || 12),
  );
  const thresholdTargetSeconds = Math.max(
    2,
    Math.min(
      safeDurationSeconds,
      Math.ceil(safeDurationSeconds * (safeThresholdPercentage / 100)),
    ),
  );
  const endWindowStartSeconds = Math.max(
    0,
    safeDurationSeconds - safeEndStabilityWindowSeconds,
  );
  const nearEndAnchorSeconds = Math.max(
    thresholdTargetSeconds,
    endWindowStartSeconds,
  );
  let previousPositionSeconds = Math.max(
    0,
    Math.min(Number(startingPositionSeconds || 0), safeDurationSeconds),
  );
  let simulatedTimestampMs = Date.now();

  const sendHeartbeat = async (currentPositionSeconds: number, timestampMs = simulatedTimestampMs) => {
    const heartbeat = await trackHeartbeat(token, {
      courseId,
      lessonId,
      playbackSessionId,
      previousPositionSeconds,
      currentPositionSeconds,
      durationSeconds: safeDurationSeconds,
      playbackRate,
      timestamp: new Date(timestampMs).toISOString(),
    });
    events.push(heartbeat.data);
    previousPositionSeconds = currentPositionSeconds;
  };

  await sendHeartbeat(previousPositionSeconds);

  while (previousPositionSeconds < nearEndAnchorSeconds) {
    const nextPositionSeconds = Math.min(
      nearEndAnchorSeconds,
      previousPositionSeconds + heartbeatStepSeconds,
    );
    const deltaSeconds = Math.max(nextPositionSeconds - previousPositionSeconds, 0);
    simulatedTimestampMs += Math.max(
      heartbeatDelayMs,
      Math.ceil((deltaSeconds / Math.max(playbackRate, 1)) * 1000) + heartbeatDelayMs,
    );
    await sleep(heartbeatDelayMs);
    await sendHeartbeat(nextPositionSeconds, simulatedTimestampMs);
  }

  if (previousPositionSeconds < safeDurationSeconds) {
    simulatedTimestampMs += Math.max(
      heartbeatDelayMs,
      Math.ceil(((safeDurationSeconds - previousPositionSeconds) / Math.max(playbackRate, 1)) * 1000) + heartbeatDelayMs,
    );
    await sleep(heartbeatDelayMs);
    await sendHeartbeat(safeDurationSeconds, simulatedTimestampMs);
  }

  return events;
};

const simulateGraceExhaustion = async (
  token: string,
  courseId: string,
  lessonId: string,
  playbackSessionId: string,
  durationSeconds: number,
  remainingGraceSeconds: number,
  startingPositionSeconds = 0,
) => {
  const heartbeatStepSeconds = Math.max(4, Math.min(8, Number(process.env.QA_WATCH_LIMIT_HEARTBEAT_STEP || 6)));
  const heartbeatDelayMs = Math.max(200, Number(process.env.QA_WATCH_LIMIT_HEARTBEAT_DELAY_MS || 250));
  const playbackRate = Math.max(1, Math.min(2, Number(process.env.QA_WATCH_LIMIT_HEARTBEAT_PLAYBACK_RATE || 2)));
  const graceTargetSeconds = Math.max(1, Math.ceil(remainingGraceSeconds + 1));
  const events: any[] = [];
  let consumedGraceSeconds = 0;
  let previousPositionSeconds = Math.max(0, Math.floor(startingPositionSeconds));

  events.push((await trackHeartbeat(token, {
    courseId,
    lessonId,
    playbackSessionId,
    previousPositionSeconds,
    currentPositionSeconds: previousPositionSeconds,
    durationSeconds,
    playbackRate,
  })).data);

  while (consumedGraceSeconds < graceTargetSeconds) {
    const nextDeltaSeconds = Math.min(heartbeatStepSeconds, graceTargetSeconds - consumedGraceSeconds);
    const currentPositionSeconds = Math.min(durationSeconds, previousPositionSeconds + nextDeltaSeconds);
    if (currentPositionSeconds <= previousPositionSeconds) {
      break;
    }

    const heartbeat = await trackHeartbeat(token, {
      courseId,
      lessonId,
      playbackSessionId,
      previousPositionSeconds,
      currentPositionSeconds,
      durationSeconds,
      playbackRate,
    });
    events.push(heartbeat.data);
    consumedGraceSeconds += currentPositionSeconds - previousPositionSeconds;
    previousPositionSeconds = currentPositionSeconds;

    if (consumedGraceSeconds < graceTargetSeconds) {
      await sleep(heartbeatDelayMs);
    }
  }

  return {
    events,
    consumedGraceSeconds,
  };
};

const configureViewport = async (page: puppeteer.Page, viewport: 'desktop' | 'mobile') => {
  if (viewport === 'mobile') {
    await page.setUserAgent(mobileChromeUserAgent);
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    return;
  }

  await page.setUserAgent(desktopEdgeUserAgent);
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
};

const launchBrowser = async () => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await puppeteer.launch({
        executablePath: chromePath,
        headless: 'new' as any,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
      });
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(1500);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unknown browser launch failure'));
};

const collectNetworkLogs = (page: puppeteer.Page, bucket: NetworkLogEntry[]) => {
  page.on('response', async (response) => {
    const url = response.url();
    if (/\/player|course-manifests|\.m3u8|videodelivery\.net|cloudflarestream\.com|\.ts(?:\?|$)|\.m4s(?:\?|$)|\.mp4(?:\?|$)/i.test(url)) {
      const entry: NetworkLogEntry = {
        url,
        status: response.status(),
        contentType: response.headers()['content-type'] || null,
      };
      if (response.status() >= 400) {
        try {
          entry.bodySample = (await response.text()).slice(0, 500);
        } catch {
          entry.bodySample = '(unavailable)';
        }
      }
      bucket.push(entry);
    }
  });
};

const runBrowserWatchPhase = async ({
  viewport,
  email,
  password,
  token,
  targetCourseId,
  targetLessonId,
  targetCourseTitle,
  targetLessonTitle,
  label,
  expectedBlocked = false,
  expectedCompletedFullWatches = 1,
  expectLockedAfterThreshold = false,
  targetDurationSeconds = 0,
}: {
  viewport: 'desktop' | 'mobile';
  email: string;
  password: string;
  token?: string | null;
  targetCourseId: string;
  targetLessonId: string;
  targetCourseTitle: string;
  targetLessonTitle: string;
  label: string;
  expectedBlocked?: boolean;
  expectedCompletedFullWatches?: number;
  expectLockedAfterThreshold?: boolean;
  targetDurationSeconds?: number;
}) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const network: NetworkLogEntry[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warn') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });
  collectNetworkLogs(page, network);

  try {
    await configureViewport(page, viewport);
    await primeBrowserPlaybackIdentity(page, token);
    await takeBrowserArtifacts(page, `${label}-${viewport}-before-login`);
    await loginInBrowser(page, email, password, token);
    await takeBrowserArtifacts(page, `${label}-${viewport}-shell`);
    let lessonOpenResult: { playerVisible: boolean; blockedVisible: boolean } | null = null;
    try {
      lessonOpenResult = await openLessonInBrowser(
        page,
        viewport,
        targetCourseId,
        targetLessonId,
        targetCourseTitle,
        targetLessonTitle,
        { allowBlockedView: expectedBlocked },
      );
    } catch (error) {
      await takeBrowserArtifacts(page, `${label}-${viewport}-lesson-open-failure`).catch(() => undefined);
      throw error;
    }
    await takeBrowserArtifacts(page, `${label}-${viewport}-lesson-open`);
    const preflightPlayer = token
      ? await getPlayer(token, targetCourseId, targetLessonId)
      : null;
    const playerPayloadSnapshot = preflightPlayer ? summarizePlayerPayload(preflightPlayer.data) : null;
    const manifestProbe = playerPayloadSnapshot?.streamUrl
      ? await probeProtectedStreamFromBrowser(page, playerPayloadSnapshot.streamUrl)
      : null;
    if (lessonOpenResult?.playerVisible) {
      await startPlayback(page);
    }

    const started = await waitForSelectorOptional(page, selectors.coursePlayerVideo, lessonOpenResult?.playerVisible ? 10_000 : 2_000)
      .then(async () => {
        try {
          await waitForPlaybackAdvance(page, expectedBlocked ? 10_000 : 30_000);
          return true;
        } catch {
          return false;
        }
      });

    const firstState = await readBrowserState(page);
    const bootstrapFailure = classifyBootstrapFailure({
      lessonOpenReached: Boolean(lessonOpenResult),
      playerVisible: Boolean(lessonOpenResult?.playerVisible),
      playerPayloadSnapshot,
      manifestProbe,
      browserState: firstState,
      playbackAdvanced: started,
    });
    const bootstrapSummary: PlaybackBootstrapSummary = {
      lessonOpenReached: Boolean(lessonOpenResult),
      playerVisible: Boolean(lessonOpenResult?.playerVisible),
      playbackBootstrapReached: started,
      currentPlaybackTime: Number(firstState.currentTime ?? 0) || null,
      visiblePlayerStateText: firstState.bodyTextSnippet || null,
      playerPayloadSnapshot,
      manifestProbe,
      failureCode: bootstrapFailure.failureCode,
      failurePhase: bootstrapFailure.failurePhase,
    };
    await takeBrowserArtifacts(page, `${label}-${viewport}-after-play`);

    if (expectedBlocked) {
      const blockedApi = token
        ? await getPlayer(token, targetCourseId, targetLessonId)
        : null;
      const blockedByApi = Boolean(
        blockedApi
        && blockedApi.res.status === 403
        && String(blockedApi.data?.code || '') === 'VIDEO_WATCH_LIMIT_REACHED',
      );
      return {
        ok: blockedByApi
          && !started
          && Boolean(
            lessonOpenResult?.blockedVisible
            || firstState.rewatchBlocked
            || !lessonOpenResult?.playerVisible,
          ),
        viewport,
        started,
        lessonOpenResult,
        firstState,
        playbackBootstrapReached: started,
        failureCode: bootstrapSummary.failureCode,
        failurePhase: bootstrapSummary.failurePhase,
        playerPayloadSnapshot,
        bootstrapSummary,
        blockedApi: blockedApi
          ? {
            status: blockedApi.res.status,
            data: summarizePlayerPayload(blockedApi.data),
          }
          : null,
        consoleErrors,
        pageErrors,
        network,
      };
    }

    if (!started) {
      return {
        ok: false,
        viewport,
        started,
        firstState,
        playbackBootstrapReached: false,
        failureCode: bootstrapSummary.failureCode || 'STREAM_BOOTSTRAP_FAILED',
        failurePhase: bootstrapSummary.failurePhase || 'playback-advance',
        playerPayloadSnapshot,
        bootstrapSummary,
        consoleErrors,
        pageErrors,
        network,
      };
    }

    if (!token) {
      throw new Error(`Token is required for threshold-proof watch phase: ${label}`);
    }

    await pausePlayback(page);
    await takeBrowserArtifacts(page, `${label}-${viewport}-pre-threshold`);

    const preThresholdPlayer = await getPlayer(token, targetCourseId, targetLessonId);
    if (!preThresholdPlayer.res.ok) {
      throw new Error(`Pre-threshold /player failed: ${preThresholdPlayer.res.status} ${preThresholdPlayer.data?.message || ''}`);
    }

    const thresholdSessionId = String(preThresholdPlayer.data.playbackSessionId || '').trim();
    if (!thresholdSessionId) {
      throw new Error(`Pre-threshold /player did not return playbackSessionId for ${label}.`);
    }

    const effectiveDurationSeconds = Math.max(
      targetDurationSeconds,
      parseDurationSeconds(preThresholdPlayer.data.durationSeconds),
      parseDurationSeconds(preThresholdPlayer.data.videoDurationSeconds),
      parseDurationSeconds(preThresholdPlayer.data.duration),
      parseDurationSeconds(firstState.duration),
    );
    if (effectiveDurationSeconds <= 0) {
      throw new Error(`Could not resolve a positive duration for threshold proof in ${label}.`);
    }

    const thresholdEvents = await simulateThresholdWatch(
      token,
      targetCourseId,
      targetLessonId,
      thresholdSessionId,
      effectiveDurationSeconds,
      {
        startingPositionSeconds: Number(firstState.currentTime || 0),
        completionThresholdPercentage: Number(
          preThresholdPlayer.data.watchCompletionPercent
          ?? preThresholdPlayer.data.watchState?.completionThresholdPercentage
          ?? preThresholdPlayer.data.watchState?.fullWatchThresholdPercentage
          ?? 95,
        ),
        endStabilityWindowSeconds: Number(
          preThresholdPlayer.data.watchState?.endStabilityWindowSeconds
          ?? 12,
        ),
      },
    );
    const postThresholdPlayer = await waitForPlayerWatchState(
      token,
      targetCourseId,
      targetLessonId,
      (state, result) => Number(state.completedFullWatches || 0) >= expectedCompletedFullWatches
        && (expectLockedAfterThreshold ? (Boolean(state.locked) || result.status === 403) : true),
      45_000,
    );
    const postThresholdWatchState = postThresholdPlayer?.watchState || null;
    const finalState = await readBrowserState(page);
    await takeBrowserArtifacts(page, `${label}-${viewport}-post-threshold`);

    const thresholdSatisfied = Boolean(
      postThresholdWatchState
      && Number(postThresholdWatchState.completedFullWatches || 0) >= expectedCompletedFullWatches
      && (!expectLockedAfterThreshold || Boolean(postThresholdWatchState.locked)),
    );

    return {
      ok: thresholdSatisfied
        && !firstState.playbackStopped
        && !firstState.anotherDevice
        && !firstState.retryVisible
        && !finalState.playbackStopped
        && !finalState.anotherDevice,
      viewport,
      started,
      lessonOpenResult,
      firstState,
      finalState,
      preThresholdPlayer: {
        status: preThresholdPlayer.res.status,
        data: summarizePlayerPayload(preThresholdPlayer.data),
      },
      thresholdSessionId,
      thresholdEvents,
      playbackBootstrapReached: true,
      failureCode: null,
      failurePhase: null,
      playerPayloadSnapshot,
      bootstrapSummary,
      postThresholdPlayer: postThresholdPlayer
        ? {
          status: postThresholdPlayer.status,
          data: summarizePlayerPayload(postThresholdPlayer.data),
        }
        : null,
      postThresholdWatchState,
      effectiveDurationSeconds,
      consoleErrors,
      pageErrors,
      network,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const runBrowserPartialWatchRefreshPhase = async ({
  viewport,
  email,
  password,
  token,
  targetCourseId,
  targetLessonId,
  targetCourseTitle,
  targetLessonTitle,
  label,
}: {
  viewport: 'desktop' | 'mobile';
  email: string;
  password: string;
  token?: string | null;
  targetCourseId: string;
  targetLessonId: string;
  targetCourseTitle: string;
  targetLessonTitle: string;
  label: string;
}) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const network: NetworkLogEntry[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warn') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });
  collectNetworkLogs(page, network);

  try {
    await configureViewport(page, viewport);
    await primeBrowserPlaybackIdentity(page, token);
    await takeBrowserArtifacts(page, `${label}-${viewport}-before-login`);
    await loginInBrowser(page, email, password, token);
    await takeBrowserArtifacts(page, `${label}-${viewport}-shell`);
    try {
      await openLessonInBrowser(page, viewport, targetCourseId, targetLessonId, targetCourseTitle, targetLessonTitle);
    } catch (error) {
      await takeBrowserArtifacts(page, `${label}-${viewport}-lesson-open-failure`).catch(() => undefined);
      throw error;
    }
    await takeBrowserArtifacts(page, `${label}-${viewport}-lesson-open`);
    const preflightPlayer = token
      ? await getPlayer(token, targetCourseId, targetLessonId)
      : null;
    const playerPayloadSnapshot = preflightPlayer ? summarizePlayerPayload(preflightPlayer.data) : null;
    const manifestProbe = playerPayloadSnapshot?.streamUrl
      ? await probeProtectedStreamFromBrowser(page, playerPayloadSnapshot.streamUrl)
      : null;
    await startPlayback(page);
    let playbackAdvanced = false;
    try {
      await waitForPlaybackAdvance(page, 30_000);
      playbackAdvanced = true;
    } catch {
      playbackAdvanced = false;
    }
    await sleep(6_000);

    const partialState = await readBrowserState(page);
    const bootstrapFailure = classifyBootstrapFailure({
      lessonOpenReached: true,
      playerVisible: true,
      playerPayloadSnapshot,
      manifestProbe,
      browserState: partialState,
      playbackAdvanced,
    });
    const bootstrapSummary: PlaybackBootstrapSummary = {
      lessonOpenReached: true,
      playerVisible: true,
      playbackBootstrapReached: playbackAdvanced,
      currentPlaybackTime: Number(partialState.currentTime ?? 0) || null,
      visiblePlayerStateText: partialState.bodyTextSnippet || null,
      playerPayloadSnapshot,
      manifestProbe,
      failureCode: bootstrapFailure.failureCode,
      failurePhase: bootstrapFailure.failurePhase,
    };
    await takeBrowserArtifacts(page, `${label}-${viewport}-partial-watch`);

    if (!playbackAdvanced) {
      return {
        ok: false,
        viewport,
        partialState,
        refreshedState: null,
        playbackBootstrapReached: false,
        failureCode: bootstrapSummary.failureCode || 'STREAM_BOOTSTRAP_FAILED',
        failurePhase: bootstrapSummary.failurePhase || 'playback-advance',
        playerPayloadSnapshot,
        bootstrapSummary,
        consoleErrors,
        pageErrors,
        network,
      };
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(shellOrCourseSelector, { timeout: 45_000 });
    await openLessonInBrowser(page, viewport, targetCourseId, targetLessonId, targetCourseTitle, targetLessonTitle);
    await startPlayback(page);
    await waitForPlaybackAdvance(page, 30_000).catch(() => undefined);
    const refreshedState = await readBrowserState(page);
    await takeBrowserArtifacts(page, `${label}-${viewport}-after-refresh`);

    return {
      ok: !partialState.playbackStopped
        && !partialState.anotherDevice
        && !partialState.retryVisible
        && !refreshedState.playbackStopped
        && !refreshedState.anotherDevice
        && !refreshedState.rewatchBlocked,
      viewport,
      partialState,
      refreshedState,
      playbackBootstrapReached: true,
      failureCode: null,
      failurePhase: null,
      playerPayloadSnapshot,
      bootstrapSummary,
      consoleErrors,
      pageErrors,
      network,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const main = async () => {
  if (!adminPassword) {
    throw new Error('QA_ADMIN_PASSWORD or ADMIN_PASSWORD must be set.');
  }
  if (!watchLimitCourseId || !watchLimitLessonId) {
    throw new Error('QA_WATCH_LIMIT_COURSE_ID and QA_WATCH_LIMIT_LESSON_ID must be set for production-course-only certification.');
  }

  await ensureDir();
  await ensureBrowserDirs();

  let admin = await login(adminEmail, adminPassword, `qa-watch-limit-admin-${runId}`);
  const student = await registerStudent();
  let cleanupPlan: any = null;
  let cleanupExecution: any = null;
  let createdStudentId: string | null = student.user._id;
  let finalReport: Record<string, unknown> | null = null;
  const withAdminSession = async <T>(operation: (token: string) => Promise<T>) => {
    try {
      return await operation(admin.token);
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }
      admin = await login(adminEmail, adminPassword, `qa-watch-limit-admin-refresh-${runId}`);
      return await operation(admin.token);
    }
  };

  try {
    await withAdminSession((token) => assignCourseToStudent(token, student.user._id, watchLimitCourseId));
    student.token = (await login(student.email, student.password, `qa-watch-limit-student-${runId}`)).token;

    const courses = (await getCourses(student.token)).data || [];
    const lessons = (await getCourseLessons(student.token, watchLimitCourseId)).data || [];
    const courseEntry = courses.find((entry) => String(entry._id || '') === watchLimitCourseId) || null;
    const lessonEntry = lessons.find((entry) => String(entry.id || '') === watchLimitLessonId) || null;

    if (!courseEntry) {
      throw new Error(`Assigned production course ${watchLimitCourseId} was not visible to the QA student.`);
    }
    if (!lessonEntry) {
      throw new Error(`Production lesson ${watchLimitLessonId} was not found in course ${watchLimitCourseId}.`);
    }

    const targetCourseTitle = watchLimitCourseText || String(courseEntry.title || '').trim();
    const targetLessonTitle = watchLimitLessonText || String(lessonEntry.title || '').trim();
    let targetDurationSeconds = parseDurationSeconds(lessonEntry.duration);
    if (!targetCourseTitle) {
      throw new Error(`Could not resolve a visible course title for ${watchLimitCourseId}.`);
    }
    if (!targetLessonTitle) {
      throw new Error(`Could not resolve a visible lesson title for ${watchLimitLessonId}.`);
    }

    const staleState = await withAdminSession((token) =>
      getRemoteWatchState(token, student.user._id, watchLimitCourseId, watchLimitLessonId),
    );
    const staleStateId = staleState.watchState?.stateId || null;
    if (staleStateId) {
      await withAdminSession((token) =>
        resetRemoteWatchState(token, student.user._id, staleStateId),
      );
    }

    const staleProbeDurationSeconds = Math.max(targetDurationSeconds || 0, 300);
    const advancedProgressSeconds = Math.min(90, Math.max(60, Math.floor(staleProbeDurationSeconds * 0.2)));
    const advancedRequestTimestamp = new Date(Date.now() + 1000).toISOString();
    const staleRequestTimestamp = new Date(Date.now() - 60_000).toISOString();
    const advancedProgress = await postWatchProgress(student.token, {
      courseId: watchLimitCourseId,
      lessonId: watchLimitLessonId,
      progressPercent: Math.min(99, Math.round((advancedProgressSeconds / Math.max(staleProbeDurationSeconds, 1)) * 100)),
      progressSeconds: advancedProgressSeconds,
      completed: false,
      durationSeconds: staleProbeDurationSeconds,
      eventType: 'progress',
      requestTimestamp: advancedRequestTimestamp,
    });
    if (!advancedProgress.res.ok) {
      throw new Error(`Advanced progress update failed: ${advancedProgress.res.status} ${advancedProgress.data?.message || ''}`);
    }

    const staleProgress = await postWatchProgress(student.token, {
      courseId: watchLimitCourseId,
      lessonId: watchLimitLessonId,
      progressPercent: 12,
      progressSeconds: Math.min(30, advancedProgressSeconds),
      completed: false,
      durationSeconds: staleProbeDurationSeconds,
      eventType: 'progress',
      requestTimestamp: staleRequestTimestamp,
    });
    if (!staleProgress.res.ok) {
      throw new Error(`Stale progress regression probe failed: ${staleProgress.res.status} ${staleProgress.data?.message || ''}`);
    }

    if (Number(staleProgress.data?.progressSeconds || 0) + 3 < advancedProgressSeconds) {
      throw new Error(`Stale progress update regressed saved progress response: ${JSON.stringify(staleProgress.data || null)}`);
    }
    if (Boolean(staleProgress.data?.completed) || Number(staleProgress.data?.videoWatchCount || 0) > 0) {
      throw new Error(`Stale progress probe should not complete or increment watch count: ${JSON.stringify(staleProgress.data || null)}`);
    }

    const partialWatch = await runBrowserPartialWatchRefreshPhase({
      viewport: 'mobile',
      email: student.email,
      password: student.password,
      token: student.token,
      targetCourseId: watchLimitCourseId,
      targetLessonId: watchLimitLessonId,
      targetCourseTitle,
      targetLessonTitle,
      label: 'partial-watch-refresh',
    });
    if (!partialWatch.ok) {
      finalReport = {
        ok: false,
        runId,
        baseUrl,
        apiBaseUrl,
        courseId: watchLimitCourseId,
        lessonId: watchLimitLessonId,
        lessonUrl: lessonUrl(watchLimitCourseId, watchLimitLessonId),
        targetCourseTitle,
        targetLessonTitle,
        student: {
          email: student.email,
          userId: student.user._id,
        },
        failureCode: partialWatch.failureCode || 'STREAM_BOOTSTRAP_FAILED',
        failurePhase: partialWatch.failurePhase || 'partial-watch-refresh',
        playbackBootstrapReached: partialWatch.playbackBootstrapReached || false,
        playerPayloadSnapshot: partialWatch.playerPayloadSnapshot || null,
        bootstrapSummary: partialWatch.bootstrapSummary || null,
        partialWatch,
      };
      await writeJson('report.json', finalReport).catch(() => undefined);
      throw new Error(`Partial watch refresh regression failed: ${JSON.stringify(partialWatch.refreshedState || partialWatch.partialState || partialWatch)}`);
    }

    const initialDeliveryPath = classifyDeliveryPathFromSrc(
      partialWatch.partialState.currentSrc || partialWatch.refreshedState.currentSrc || null,
    );

    if (targetDurationSeconds <= 0) {
      targetDurationSeconds = parseDurationSeconds(lessonEntry.duration)
        || parseDurationSeconds(partialWatch.partialState.duration)
        || parseDurationSeconds(partialWatch.refreshedState.duration);
    }
    if (targetDurationSeconds <= 0) {
      throw new Error(`Could not resolve a positive lesson duration for ${watchLimitLessonId} from lesson metadata, player payload, or browser video state.`);
    }

    const afterPartialWatchPlayer = await getPlayer(student.token, watchLimitCourseId, watchLimitLessonId);
    const afterPartialWatchPlayerState = extractPlayerWatchState(afterPartialWatchPlayer.data);
    if (!afterPartialWatchPlayer.res.ok) {
      throw new Error(`Partial watch follow-up /player failed: ${afterPartialWatchPlayer.res.status} ${afterPartialWatchPlayer.data?.message || ''}`);
    }
    if (Number(afterPartialWatchPlayerState?.completedFullWatches || 0) > 0 || Boolean(afterPartialWatchPlayerState?.locked)) {
      throw new Error(`Partial watch should not complete or lock the lesson: ${JSON.stringify(afterPartialWatchPlayerState || null)}`);
    }
    await withAdminSession((token) => clearPlaybackSessions(token, student.user._id));

    const firstWatch = await runBrowserWatchPhase({
      viewport: 'mobile',
      email: student.email,
      password: student.password,
      token: student.token,
      targetCourseId: watchLimitCourseId,
      targetLessonId: watchLimitLessonId,
      targetCourseTitle,
      targetLessonTitle,
      label: 'first-watch',
      expectedCompletedFullWatches: 1,
      targetDurationSeconds,
    });
    if (!firstWatch.ok) {
      throw new Error(`First threshold watch proof failed: ${JSON.stringify(firstWatch.postThresholdWatchState || firstWatch.firstState || firstWatch)}`);
    }

    await withAdminSession((token) => clearPlaybackSessions(token, student.user._id));
    const reopenAfterFirstCompletion = await getPlayer(student.token, watchLimitCourseId, watchLimitLessonId);
    if (!reopenAfterFirstCompletion.res.ok) {
      throw new Error(`Reopen after first browser completion failed: ${reopenAfterFirstCompletion.res.status} ${reopenAfterFirstCompletion.data?.message || ''}`);
    }
    const reopenAfterFirstWatchState = extractPlayerWatchState(reopenAfterFirstCompletion.data);
    if (Number(reopenAfterFirstWatchState?.completedFullWatches || 0) !== 1) {
      throw new Error(`Expected completedFullWatches=1 after first threshold proof, got ${reopenAfterFirstWatchState?.completedFullWatches}`);
    }
    if (Boolean(reopenAfterFirstWatchState?.locked)) {
      throw new Error(`Lesson should not be locked after the first threshold proof: ${JSON.stringify(reopenAfterFirstWatchState || null)}`);
    }
    if (String(reopenAfterFirstWatchState?.replayState || '') !== 'restart_new_cycle') {
      throw new Error(`Expected replayState=restart_new_cycle after first completion, got ${reopenAfterFirstWatchState?.replayState || 'unknown'}`);
    }
    if (Number(reopenAfterFirstCompletion.data.resumeSeconds || 0) > 1) {
      throw new Error(`Expected replay after first completion to restart near zero, got resumeSeconds=${reopenAfterFirstCompletion.data.resumeSeconds}`);
    }
    await withAdminSession((token) => clearPlaybackSessions(token, student.user._id));

    const secondWatch = await runBrowserWatchPhase({
      viewport: 'desktop',
      email: student.email,
      password: student.password,
      token: student.token,
      targetCourseId: watchLimitCourseId,
      targetLessonId: watchLimitLessonId,
      targetCourseTitle,
      targetLessonTitle,
      label: 'second-watch',
      expectedCompletedFullWatches: 2,
      expectLockedAfterThreshold: false,
      targetDurationSeconds,
    });
    if (!secondWatch.ok) {
      throw new Error(`Second threshold watch proof failed: ${JSON.stringify(secondWatch.postThresholdWatchState || secondWatch.finalState || secondWatch)}`);
    }
    const secondWatchState = secondWatch.postThresholdWatchState || null;
    if (Number(secondWatchState?.completedFullWatches || 0) !== 2) {
      throw new Error(`Expected completedFullWatches=2 after second threshold proof, got ${secondWatchState?.completedFullWatches}`);
    }
    if (Boolean(secondWatchState?.locked)) {
      throw new Error(`Lesson should enter grace replay instead of locking after the final counted watch: ${JSON.stringify(secondWatchState || null)}`);
    }
    if (String(secondWatchState?.replayState || '') !== 'grace_cycle') {
      throw new Error(`Expected replayState=grace_cycle after final counted watch, got ${secondWatchState?.replayState || 'unknown'}`);
    }
    const secondWatchGraceRemainingSeconds = getGraceRemainingSeconds(secondWatchState);
    if (secondWatchGraceRemainingSeconds <= 0) {
      throw new Error(`Expected positive grace remaining seconds after final counted watch: ${JSON.stringify(secondWatchState || null)}`);
    }
    await withAdminSession((token) => clearPlaybackSessions(token, student.user._id));

    const graceRefresh = await runBrowserPartialWatchRefreshPhase({
      viewport: 'mobile',
      email: student.email,
      password: student.password,
      token: student.token,
      targetCourseId: watchLimitCourseId,
      targetLessonId: watchLimitLessonId,
      targetCourseTitle,
      targetLessonTitle,
      label: 'grace-refresh',
    });
    if (!graceRefresh.ok) {
      throw new Error(`Grace refresh regression failed: ${JSON.stringify(graceRefresh.refreshedState || graceRefresh.partialState || graceRefresh)}`);
    }

    const graceResumePlayer = await getPlayer(student.token, watchLimitCourseId, watchLimitLessonId);
    if (!graceResumePlayer.res.ok) {
      throw new Error(`Grace replay /player failed: ${graceResumePlayer.res.status} ${graceResumePlayer.data?.message || ''}`);
    }
    const graceResumeWatchState = extractPlayerWatchState(graceResumePlayer.data);
    if (String(graceResumeWatchState?.replayState || '') !== 'grace_cycle') {
      throw new Error(`Expected grace replay state after grace refresh, got ${graceResumeWatchState?.replayState || 'unknown'}`);
    }
    if (Boolean(graceResumeWatchState?.locked)) {
      throw new Error(`Grace replay should still be available before exhaustion: ${JSON.stringify(graceResumeWatchState || null)}`);
    }
    if (Number(graceResumePlayer.data.resumeSeconds || 0) <= 0) {
      throw new Error(`Grace replay refresh should resume from progress inside the grace cycle, got resumeSeconds=${graceResumePlayer.data.resumeSeconds}`);
    }
    if (getGraceRemainingSeconds(graceResumeWatchState) >= secondWatchGraceRemainingSeconds) {
      throw new Error(`Grace replay should consume grace seconds before exhaustion: ${JSON.stringify(graceResumeWatchState || null)}`);
    }
    await withAdminSession((token) => clearPlaybackSessions(token, student.user._id));

    const graceExhaustionPlayer = await getPlayer(student.token, watchLimitCourseId, watchLimitLessonId);
    if (!graceExhaustionPlayer.res.ok) {
      throw new Error(`Grace exhaustion /player failed: ${graceExhaustionPlayer.res.status} ${graceExhaustionPlayer.data?.message || ''}`);
    }
    const graceExhaustionWatchState = extractPlayerWatchState(graceExhaustionPlayer.data);
    const graceExhaustionSessionId = String(graceExhaustionPlayer.data.playbackSessionId || '').trim();
    if (!graceExhaustionSessionId) {
      throw new Error('Grace exhaustion proof did not receive a playbackSessionId.');
    }
    const graceExhaustionRemainingSeconds = getGraceRemainingSeconds(graceExhaustionWatchState);
    if (graceExhaustionRemainingSeconds <= 0) {
      throw new Error(`Grace exhaustion proof expected remaining grace before lock: ${JSON.stringify(graceExhaustionWatchState || null)}`);
    }
    const graceExhaustion = await simulateGraceExhaustion(
      student.token,
      watchLimitCourseId,
      watchLimitLessonId,
      graceExhaustionSessionId,
      Math.max(
        targetDurationSeconds,
        parseDurationSeconds(graceExhaustionPlayer.data.durationSeconds),
        parseDurationSeconds(graceExhaustionPlayer.data.videoDurationSeconds),
        parseDurationSeconds(graceExhaustionPlayer.data.duration),
      ),
      graceExhaustionRemainingSeconds,
      Number(graceExhaustionPlayer.data.resumeSeconds || 0),
    );
    const lockedAfterGrace = await waitForPlayerWatchState(
      student.token,
      watchLimitCourseId,
      watchLimitLessonId,
      (state, result) =>
        (Boolean(state.locked) && String(state.replayState || '') === 'locked')
        || result.status === 403,
      45_000,
    );
    if (!lockedAfterGrace || !(Boolean(lockedAfterGrace.watchState?.locked) || lockedAfterGrace.status === 403)) {
      throw new Error(`Expected the lesson to lock only after grace exhaustion: ${JSON.stringify(lockedAfterGrace || null)}`);
    }
    await withAdminSession((token) => clearPlaybackSessions(token, student.user._id));

    const blockedAfterGraceMobile = await runBrowserWatchPhase({
      viewport: 'mobile',
      email: student.email,
      password: student.password,
      token: student.token,
      targetCourseId: watchLimitCourseId,
      targetLessonId: watchLimitLessonId,
      targetCourseTitle,
      targetLessonTitle,
      label: 'blocked-after-grace-mobile',
      expectedBlocked: true,
    });
    const blockedAfterGraceDesktop = await runBrowserWatchPhase({
      viewport: 'desktop',
      email: student.email,
      password: student.password,
      token: student.token,
      targetCourseId: watchLimitCourseId,
      targetLessonId: watchLimitLessonId,
      targetCourseTitle,
      targetLessonTitle,
      label: 'blocked-after-grace-desktop',
      expectedBlocked: true,
    });
    if (!blockedAfterGraceMobile.ok || !blockedAfterGraceDesktop.ok) {
      throw new Error(`Blocked replay proof failed after grace exhaustion: ${JSON.stringify({
        mobile: blockedAfterGraceMobile,
        desktop: blockedAfterGraceDesktop,
      })}`);
    }

    const blockedOpen = await getPlayer(student.token, watchLimitCourseId, watchLimitLessonId);
    if (blockedOpen.res.status !== 403) {
      throw new Error(`Expected replay after grace exhaustion to be blocked with 403, got ${blockedOpen.res.status}`);
    }
    if (String(blockedOpen.data.code || '') !== 'VIDEO_WATCH_LIMIT_REACHED') {
      throw new Error(`Expected VIDEO_WATCH_LIMIT_REACHED after grace exhaustion, got ${blockedOpen.data.code || 'unknown'}`);
    }

    const report = {
      runId,
      baseUrl,
      apiBaseUrl,
      courseId: watchLimitCourseId,
      lessonId: watchLimitLessonId,
      lessonUrl: lessonUrl(watchLimitCourseId, watchLimitLessonId),
      targetCourseTitle,
      targetLessonTitle,
      targetDurationSeconds,
      student: {
        email: student.email,
        userId: student.user._id,
      },
      deliveryPath: initialDeliveryPath,
      partialWatch,
      afterPartialWatchPlayer: {
        status: afterPartialWatchPlayer.res.status,
        data: summarizePlayerPayload(afterPartialWatchPlayer.data),
      },
      staleProgressGuard: {
        advancedProgress: {
          status: advancedProgress.res.status,
          data: advancedProgress.data,
        },
        staleProgress: {
          status: staleProgress.res.status,
          data: staleProgress.data,
        },
      },
      firstWatch,
      reopenAfterFirstCompletion: {
        status: reopenAfterFirstCompletion.res.status,
        data: summarizePlayerPayload(reopenAfterFirstCompletion.data),
      },
      secondWatch,
      graceRefresh,
      graceResumePlayer: {
        status: graceResumePlayer.res.status,
        data: summarizePlayerPayload(graceResumePlayer.data),
      },
      graceExhaustion: {
        playbackSessionId: graceExhaustionSessionId,
        remainingGraceSeconds: graceExhaustionRemainingSeconds,
        consumedGraceSeconds: graceExhaustion.consumedGraceSeconds,
        events: graceExhaustion.events,
      },
      lockedAfterGrace: lockedAfterGrace
        ? {
          status: lockedAfterGrace.status,
          data: summarizePlayerPayload(lockedAfterGrace.data),
        }
        : null,
      blockedAfterGraceMobile,
      blockedAfterGraceDesktop,
      blockedOpen: {
        status: blockedOpen.res.status,
        data: {
          ...blockedOpen.data,
          watchState: extractPlayerWatchState(blockedOpen.data),
        },
      },
      cleanupPlan,
      cleanupExecution,
    };

    finalReport = report;
    await writeJson('report.json', report);
    console.log(JSON.stringify({
      ok: true,
      courseId: watchLimitCourseId,
      lessonId: watchLimitLessonId,
      firstBrowserWatchOk: firstWatch.ok,
      secondBrowserWatchOk: secondWatch.ok,
      graceRefreshOk: graceRefresh.ok,
      blockedAfterGraceMobile: blockedAfterGraceMobile.ok,
      blockedAfterGraceDesktop: blockedAfterGraceDesktop.ok,
      completedFullWatchesAfterFirstCompletion: reopenAfterFirstWatchState?.completedFullWatches || 0,
      completedFullWatchesAfterSecondCompletion: secondWatchState?.completedFullWatches || 0,
      graceRemainingSecondsAfterSecondCompletion: secondWatchGraceRemainingSeconds,
      blockedOpenStatus: blockedOpen.res.status,
      blockedOpenCode: blockedOpen.data.code || null,
      artifactDir,
    }, null, 2));
  } finally {
    const latestState = createdStudentId
      ? await withAdminSession((token) =>
        getRemoteWatchState(token, createdStudentId, watchLimitCourseId, watchLimitLessonId),
      ).catch(() => null)
      : null;
    cleanupPlan = {
      mode: cleanupMode,
      targetStudentId: createdStudentId,
      targetStudentEmail: student.email,
      safeSyntheticEmail: isSafeSyntheticEmail(student.email),
      courseId: watchLimitCourseId,
      lessonId: watchLimitLessonId,
      watchStateId: latestState?.watchState?.stateId || null,
      actions: [
        'reset watch-progress for created QA student only',
        'clear playback sessions for created QA student only',
        'remove assigned course access for created QA student only',
        'disable created QA student account only',
      ],
    };
    if (cleanupMode === 'execute' && createdStudentId && isSafeSyntheticEmail(student.email)) {
      cleanupExecution = {
        resetWatchProgress: null,
        clearPlaybackSessions: null,
        removeCourseAccess: null,
        disableStudent: null,
      };
      const latestStateId = latestState?.watchState?.stateId || null;
      if (latestStateId) {
        cleanupExecution.resetWatchProgress = await withAdminSession((token) =>
          resetRemoteWatchState(
            token,
            createdStudentId,
            latestStateId,
          ),
        ).then((result) => result.data).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      cleanupExecution.clearPlaybackSessions = await withAdminSession((token) => clearPlaybackSessions(token, createdStudentId))
        .then((result) => result.data)
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      cleanupExecution.removeCourseAccess = await withAdminSession((token) => removeCourseAccess(token, createdStudentId, watchLimitCourseId))
        .then((result) => result.data)
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
      cleanupExecution.disableStudent = await withAdminSession((token) => updateStudentStatus(token, createdStudentId, 'disabled'))
        .then((result) => result.data)
        .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    }
    await writeJson('cleanup.json', {
      mode: cleanupMode,
      createdStudentId,
      cleanupPlan,
      cleanupExecution,
    });
    if (finalReport && !(await fs.access(path.join(artifactDir, 'report.json')).then(() => true).catch(() => false))) {
      await writeJson('report.json', finalReport).catch(() => undefined);
    }
  }
};

main().catch(async (error) => {
  await ensureDir().catch(() => undefined);
  const reportPath = path.join(artifactDir, 'report.json');
  const hasExistingReport = await fs.access(reportPath).then(() => true).catch(() => false);
  if (!hasExistingReport) {
    await writeJson('report.json', {
      ok: false,
      runId,
      baseUrl,
      apiBaseUrl,
      courseId: watchLimitCourseId,
      lessonId: watchLimitLessonId,
      failureCode: 'STREAM_BOOTSTRAP_FAILED',
      failurePhase: 'unknown',
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
  await fs.writeFile(
    path.join(artifactDir, 'error.txt'),
    String(error instanceof Error ? `${error.message}\n${error.stack || ''}` : error),
    'utf8',
  ).catch(() => undefined);
  process.exitCode = 1;
});
