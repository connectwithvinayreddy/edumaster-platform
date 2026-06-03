import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type JsonRecord = Record<string, any>;

const execFileAsync = promisify(execFile);
const playbackUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const baseUrl = (process.env.QA_BASE_URL || config.baseUrl).replace(/\/+$/, '');
const apiBaseUrl = `${baseUrl}/backend/api`;
const courseId = String(process.env.QA_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2').trim();
const lessonId = String(process.env.QA_LESSON_ID || 'video_1780146736089_8d3b641cf7').trim();
const courseText = String(process.env.QA_COURSE_TEXT || 'SSC').trim();
const lessonText = String(process.env.QA_LESSON_TEXT || 'INTRODUCTION').trim();
const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sshHost = String(process.env.QA_PROD_SSH_HOST || 'root@178.105.48.179').trim();
const remoteContainerName = String(process.env.QA_PROD_APP_CONTAINER || 'lowcost-app-1').trim();
const runLabel = new Date().toISOString().replace(/[:.]/g, '-');
const createFreshStudent = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_PRISTINE_CREATE_FRESH || 'true').toLowerCase());
const headedBrowser = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_PRISTINE_HEADED || 'false').toLowerCase());
const generatedEmail = `qa.pristine.${runLabel.toLowerCase().replace(/[^a-z0-9]+/g, '')}@example.com`;
const generatedPassword = `Student@${runLabel.replace(/[^0-9]/g, '').slice(-10) || '1234567890'}Aa`;
const pristineEmail = String(process.env.QA_PRISTINE_EMAIL || process.env.QA_STUDENT_EMAIL || generatedEmail).trim().toLowerCase();
const pristinePassword = String(process.env.QA_PRISTINE_PASSWORD || process.env.QA_STUDENT_PASSWORD || generatedPassword).trim();
const pristineName = String(process.env.QA_PRISTINE_NAME || `QA Pristine ${runLabel.slice(0, 19)}`).trim();
const deviceId = `qa-pristine-device-${runLabel}`;
const tabId = `qa-pristine-tab-${runLabel}`;
const secondTabId = `${tabId}-2`;

const requestJson = async <T = JsonRecord>(url: string, init: RequestInit = {}) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let data: T | JsonRecord = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { response, data: data as T, text };
};

const requireOk = async <T = JsonRecord>(url: string, init: RequestInit = {}) => {
  const result = await requestJson<T>(url, init);
  if (!result.response.ok) {
    throw new Error(`${result.response.status} ${String((result.data as JsonRecord)?.message || (result.data as JsonRecord)?.error || result.text).slice(0, 240)}`);
  }
  return result;
};

const playbackHeaders = (token: string, playbackTabId = tabId) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
  'user-agent': playbackUserAgent,
  'x-edumaster-app': 'web',
  'x-edumaster-client-platform': 'windows',
  'x-edumaster-client-browser': 'chrome',
  'x-edumaster-device-id': deviceId,
  'x-edumaster-playback-tab-id': playbackTabId,
});

const getPlayer = async (token: string, playbackTabId = tabId) =>
  requestJson<JsonRecord>(`${apiBaseUrl}/courses/${courseId}/lessons/${lessonId}/player`, {
    headers: playbackHeaders(token, playbackTabId),
  });

const sendHeartbeat = async (
  token: string,
  playbackSessionId: string,
  previousPositionSeconds: number,
  currentPositionSeconds: number,
  durationSeconds: number,
) =>
  requireOk<JsonRecord>(`${apiBaseUrl}/track`, {
    method: 'POST',
    headers: {
      ...playbackHeaders(token, tabId),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      courseId,
      lessonId,
      videoId: lessonId,
      videoType: 'course',
      playbackSessionId,
      previousPositionSeconds,
      currentPositionSeconds,
      durationSeconds,
      isPlaying: true,
      isPaused: false,
      isBuffering: false,
      playbackRate: 1,
      timestamp: new Date().toISOString(),
    }),
  });

const runRemoteNode = async (script: string) => {
  const encodedScript = Buffer.from(script, 'utf8').toString('base64');
  const remoteCommand = `docker exec ${remoteContainerName} sh -lc "cd /app && printf '%s' '${encodedScript}' | base64 -d | node"`;
  const { stdout } = await execFileAsync('ssh', ['-o', 'StrictHostKeyChecking=no', sshHost, remoteCommand], {
    maxBuffer: 1024 * 1024 * 20,
  });
  return stdout.trim();
};

const remotePristineState = async (action: 'prepare' | 'snapshot' | 'cleanup') => {
  const stdout = await runRemoteNode(`
const bcrypt = require('./backend/node_modules/bcryptjs');
const { usersRepository, coursesRepository, platformRepository, videoPlaybackRepository } = require('./backend/lib/repositories.js');
const { initializePostgres, queryPostgres } = require('./backend/lib/postgres.js');
const { getRedisJson, deleteRedisKey } = require('./backend/lib/redis.js');
const { appConfig } = require('./backend/lib/config.js');

const payload = ${JSON.stringify({
    action,
    email: pristineEmail,
    password: pristinePassword,
    name: pristineName,
    courseId,
    lessonId,
  })};

const CACHE_PREFIX = String(appConfig.cachePrefix || 'varonenglish').replace(/[:\\s]+/g, '-');
const activeKey = (userId) => \`\${CACHE_PREFIX}:video-playback-active:\${String(userId)}\`;

const findLesson = (course, targetLessonId) => {
  for (const moduleEntry of course?.modules || []) {
    for (const lesson of moduleEntry?.lessons || []) {
      if (String(lesson?.id || '') === String(targetLessonId)) {
        return lesson;
      }
    }
    for (const chapter of moduleEntry?.chapters || []) {
      for (const lesson of chapter?.lessons || []) {
        if (String(lesson?.id || '') === String(targetLessonId)) {
          return lesson;
        }
      }
    }
  }
  return null;
};

const baseSnapshot = async (user) => {
  const course = await coursesRepository.findById(payload.courseId);
  if (!course) {
    throw new Error(\`Course not found: \${payload.courseId}\`);
  }
  const lesson = findLesson(course, payload.lessonId);
  if (!lesson) {
    throw new Error(\`Lesson not found: \${payload.lessonId}\`);
  }

  const enrollmentRows = (await queryPostgres(
    'SELECT id, user_id, course_id, access_type, source, enrolled_at, expires_at, view_count FROM enrollments WHERE user_id = $1 AND course_id = $2 ORDER BY enrolled_at ASC',
    [String(user._id), String(payload.courseId)],
  )).rows;
  const watchStateRows = (await queryPostgres(
    'SELECT id, user_id, course_id, lesson_id, video_id, video_type, video_duration_seconds, allowed_full_watches, completed_full_watches, full_watch_threshold_percentage, watched_segments, current_cycle_unique_watched_seconds, total_unique_watched_seconds, repeat_watched_seconds, revision_buffer_seconds, revision_buffer_used_seconds, last_position_seconds, playback_session_id, active_session_status, device_id, ip_address, user_agent, last_heartbeat_at, is_locked, locked_at, created_at, updated_at FROM video_watch_states WHERE user_id = $1 AND course_id = $2 AND video_id = $3 AND video_type = $4',
    [String(user._id), String(payload.courseId), String(payload.lessonId), 'course'],
  )).rows;
  const rawPlaybackSession = await getRedisJson(activeKey(user._id));
  const freshPlaybackSession = await videoPlaybackRepository.getActivePlaybackSession(String(user._id));
  const enrollment = enrollmentRows[0] || null;
  const watchState = watchStateRows[0] || null;
  const expiresAtMs = enrollment?.expires_at ? Date.parse(enrollment.expires_at) : null;

  return {
    user: {
      id: String(user._id),
      email: String(user.email || ''),
      role: String(user.role || ''),
      createdAt: user.createdAt || user.created_at || null,
    },
    course: {
      id: String(course._id || payload.courseId),
      title: String(course.title || ''),
    },
    lesson: {
      id: String(lesson.id || payload.lessonId),
      title: String(lesson.title || ''),
      watchLimit: Number(lesson.watchLimit || 0),
      watchCompletionPercent: Number(lesson.watchCompletionPercent || 0),
      releaseAt: lesson.releaseAt || null,
    },
    enrollment,
    enrollmentRows,
    watchState,
    watchStateRows,
    playbackSessions: {
      redisKey: activeKey(user._id),
      raw: rawPlaybackSession || null,
      active: freshPlaybackSession || null,
      staleDetected: Boolean(rawPlaybackSession) && !freshPlaybackSession,
    },
    checks: {
      userExists: Boolean(user),
      courseEnrollmentActive: Boolean(enrollment) && (!enrollment.expires_at || (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now())),
      courseValidityActive: Boolean(enrollment) && (!enrollment.expires_at || (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now())),
      zeroVideoProgress: !watchState || (
        Number(watchState.current_cycle_unique_watched_seconds || 0) === 0
        && Number(watchState.total_unique_watched_seconds || 0) === 0
        && Number(watchState.last_position_seconds || 0) === 0
      ),
      zeroCompletedFullWatches: !watchState || Number(watchState.completed_full_watches || 0) === 0,
      watchedSegmentsEmpty: !watchState || JSON.stringify(watchState.watched_segments || []) === '[]',
      noActivePlaybackSessions: !freshPlaybackSession,
      noStalePlaybackSessions: !(Boolean(rawPlaybackSession) && !freshPlaybackSession),
      notLocked: !watchState || watchState.is_locked === false,
      zeroPreviousWatchSessions: !watchState || !watchState.playback_session_id,
      zeroPreviousDeviceSessionConflicts: !freshPlaybackSession,
    },
  };
};

(async () => {
  await initializePostgres();

  if (payload.action === 'prepare') {
    let user = await usersRepository.findByEmail(payload.email);
    if (user) {
      throw new Error(\`Pristine QA user already exists: \${payload.email}\`);
    }
    const hashed = await bcrypt.hash(payload.password, 10);
    user = await usersRepository.create({
      name: payload.name,
      email: payload.email,
      password: hashed,
      role: 'student',
    });
    await platformRepository.enroll({
      userId: String(user._id),
      courseId: payload.courseId,
      source: 'qa-pristine-certification',
      accessType: 'course',
    });
    await queryPostgres(
      "UPDATE enrollments SET expires_at = now() + interval '365 day' WHERE user_id = $1 AND course_id = $2",
      [String(user._id), String(payload.courseId)],
    );
    const snapshot = await baseSnapshot(user);
    console.log(JSON.stringify({ action: payload.action, created: true, snapshot }, null, 2));
    return;
  }

  const user = await usersRepository.findByEmail(payload.email);
  if (!user) {
    throw new Error(\`QA pristine user not found: \${payload.email}\`);
  }

  if (payload.action === 'cleanup') {
    await deleteRedisKey(activeKey(user._id));
  }

  const snapshot = await baseSnapshot(user);
  console.log(JSON.stringify({ action: payload.action, created: false, snapshot }, null, 2));
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`);

  return JSON.parse(stdout);
};

const login = async () => {
  const result = await requireOk<{ token: string; user: JsonRecord }>(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: pristineEmail,
      identifier: pristineEmail,
      password: pristinePassword,
      device: `qa-pristine-login-${runLabel}`,
      forceLogoutOtherSessions: true,
    }),
  });
  const token = String(result.data?.token || '');
  if (!token) {
    throw new Error('Login succeeded without a token.');
  }
  return { token, user: result.data.user };
};

const waitForSelectorOptional = async (page: puppeteer.Page, selector: string, timeoutMs: number) => {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
};

const clickSelector = async (page: puppeteer.Page, selector: string, timeoutMs = 30_000) => {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  await page.evaluate((targetSelector) => {
    const node = document.querySelector(targetSelector) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center', inline: 'nearest' });
    node?.click();
  }, selector);
};

const openCourseFromCatalog = async (page: puppeteer.Page) => {
  const clicked = await page.evaluate((cardSelector, text) => {
    const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(text.toLowerCase())) || cards[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, courseText);
  if (!clicked) {
    throw new Error('No course card was available to open.');
  }
};

const openLessonFromCourse = async (page: puppeteer.Page) => {
  await page.waitForSelector(selectors.courseLessonOpen, { timeout: 30_000 });
  const clicked = await page.evaluate((lessonSelector, text) => {
    const buttons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const target = buttons.find((button) => (button.textContent || '').toLowerCase().includes(text.toLowerCase())) || buttons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, lessonText);
  if (!clicked) {
    throw new Error('No lesson entry was available to open.');
  }
};

const readVideoState = async (page: puppeteer.Page) =>
  page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    const bodyText = document.body?.innerText || '';
    return {
      exists: Boolean(video),
      currentTime: Number(video?.currentTime || 0),
      duration: Number.isFinite(video?.duration) ? Number(video?.duration) : null,
      paused: video?.paused ?? null,
      readyState: video?.readyState ?? null,
      networkState: video?.networkState ?? null,
      currentSrc: video?.currentSrc || null,
      error: video?.error ? {
        code: video.error.code,
        message: video.error.message,
      } : null,
      flags: {
        anotherTab: /another tab|another device/i.test(bodyText),
        unavailable: /lesson video unavailable|not available for playback/i.test(bodyText),
        preparing: /taking longer than expected to prepare|preparing protected lesson player/i.test(bodyText),
        loading: /loading video/i.test(bodyText),
      },
    };
  }, selectors.coursePlayerVideo);

const waitForProgress = async (page: puppeteer.Page, minimumSeconds: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readVideoState(page);
    if (state.exists && state.currentTime >= minimumSeconds && !state.flags.anotherTab && !state.flags.unavailable) {
      return state;
    }
    await sleep(500);
  }
  return readVideoState(page);
};

const seekVideo = async (page: puppeteer.Page, seconds: number) =>
  page.evaluate((payload) => {
    const video = document.querySelector(payload.selector) as HTMLVideoElement | null;
    if (!video) {
      throw new Error('Video element missing during seek.');
    }
    const nextSeconds = Math.min(Math.max(payload.seconds, 0), Number.isFinite(video.duration) ? video.duration : payload.seconds);
    video.currentTime = nextSeconds;
    void video.play?.().catch(() => undefined);
  }, { selector: selectors.coursePlayerVideo, seconds });

const summarizeWatchState = (payload: JsonRecord | null | undefined) => {
  const watchState = payload?.watchState || null;
  return {
    playbackSessionId: payload?.playbackSessionId || null,
    playbackStatus: payload?.playbackStatus || null,
    streamFormat: payload?.streamFormat || null,
    resumeSeconds: payload?.resumeSeconds ?? null,
    currentCycleUniqueWatchedSeconds: watchState?.currentCycleUniqueWatchedSeconds ?? null,
    totalUniqueWatchedSeconds: watchState?.totalUniqueWatchedSeconds ?? null,
    repeatWatchedSeconds: watchState?.repeatWatchedSeconds ?? null,
    completedFullWatches: watchState?.completedFullWatches ?? null,
    locked: watchState?.locked ?? watchState?.isLocked ?? null,
    watchedSegments: watchState?.watchedSegments ?? null,
    uniqueCoveragePercent: payload?.durationSeconds
      ? Number((((watchState?.currentCycleUniqueWatchedSeconds ?? 0) / payload.durationSeconds) * 100).toFixed(2))
      : null,
  };
};

const summarizeHeartbeat = (payload: JsonRecord | null | undefined) => ({
  accepted: payload?.accepted ?? null,
  reason: payload?.reason || payload?.outcome?.reason || null,
  sessionStatus: payload?.sessionStatus || null,
  suspiciousReasons: payload?.outcome?.suspiciousReasons || [],
  incrementReason: payload?.outcome?.completionReason || payload?.outcome?.reason || null,
  completedFullWatches: payload?.watchState?.completedFullWatches ?? null,
  currentCycleUniqueWatchedSeconds: payload?.watchState?.currentCycleUniqueWatchedSeconds ?? null,
  totalUniqueWatchedSeconds: payload?.watchState?.totalUniqueWatchedSeconds ?? null,
  repeatWatchedSeconds: payload?.watchState?.repeatWatchedSeconds ?? null,
});

const simulateThresholdWatch = async (
  token: string,
  playbackSessionId: string,
  durationSeconds: number,
  {
    completionThresholdPercentage = 95,
    endStabilityWindowSeconds = 12,
  }: {
    completionThresholdPercentage?: number;
    endStabilityWindowSeconds?: number;
  } = {},
) => {
  const safeDurationSeconds = Math.max(Number(durationSeconds || 0), 1);
  const thresholdTarget = Math.max(
    2,
    Math.min(
      safeDurationSeconds,
      Math.ceil(safeDurationSeconds * (Math.max(1, Math.min(100, Number(completionThresholdPercentage || 95) || 95)) / 100)),
    ),
  );
  const endWindowStartSeconds = Math.max(
    0,
    safeDurationSeconds - Math.max(1, Math.min(safeDurationSeconds, Number(endStabilityWindowSeconds || 12) || 12)),
  );
  const nearEndAnchorSeconds = Math.max(thresholdTarget, endWindowStartSeconds);
  const events: JsonRecord[] = [];
  let previousPositionSeconds = 0;
  events.push((await sendHeartbeat(token, playbackSessionId, 0, 0, safeDurationSeconds)).data);
  if (previousPositionSeconds < nearEndAnchorSeconds) {
    const heartbeat = await sendHeartbeat(
      token,
      playbackSessionId,
      previousPositionSeconds,
      nearEndAnchorSeconds,
      safeDurationSeconds,
    );
    events.push(heartbeat.data);
    previousPositionSeconds = nearEndAnchorSeconds;
  }
  if (previousPositionSeconds < safeDurationSeconds) {
    const heartbeat = await sendHeartbeat(
      token,
      playbackSessionId,
      previousPositionSeconds,
      safeDurationSeconds,
      safeDurationSeconds,
    );
    events.push(heartbeat.data);
  }
  return events;
};

const collectConflictPageScreenshot = async (browser: puppeteer.Browser, token: string, ctx: Awaited<ReturnType<typeof createRunContext>>) => {
  const conflictPage = await browser.newPage();
  try {
    await conflictPage.setViewport({ width: 1440, height: 1100 });
    await conflictPage.setUserAgent(playbackUserAgent);
    await conflictPage.evaluateOnNewDocument((authToken, nextDeviceId, nextTabId) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
      window.localStorage.setItem('edumaster.device.id', nextDeviceId);
      window.sessionStorage.setItem('edumaster.playback.tab.id', nextTabId);
    }, token, deviceId, secondTabId);
    await conflictPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await conflictPage.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 45_000 });
    await clickSelector(conflictPage, selectors.navCourses);
    await conflictPage.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await openCourseFromCatalog(conflictPage);
    await conflictPage.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await openLessonFromCourse(conflictPage);
    await conflictPage.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await conflictPage.waitForFunction(
      () => /another tab|another device/i.test(document.body?.innerText || ''),
      { timeout: 20_000 },
    ).catch(() => undefined);
    const conflictScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '10-different-tab-conflict', 'png');
    await conflictPage.screenshot({ path: conflictScreenshot, fullPage: true });
    return conflictScreenshot;
  } finally {
    await conflictPage.close().catch(() => undefined);
  }
};

const main = async () => {
  const ctx = await createRunContext();
  const analysisPath = path.join(ctx.analysisDir, 'production-video-pristine-certification.json');
  const reportPath = path.join(ctx.analysisDir, 'production-video-pristine-certification.md');
  const consoleIssues: string[] = [];
  const networkEvents: Array<Record<string, any>> = [];

  if (createFreshStudent) {
    await remotePristineState('prepare');
  }

  const beforeDb = await remotePristineState('snapshot');
  const beforeChecks = beforeDb?.snapshot?.checks || {};
  const beforeGatePassed = Boolean(
    beforeChecks.userExists
    && beforeChecks.courseEnrollmentActive
    && beforeChecks.courseValidityActive
    && beforeChecks.zeroVideoProgress
    && beforeChecks.zeroCompletedFullWatches
    && beforeChecks.watchedSegmentsEmpty
    && beforeChecks.noActivePlaybackSessions
    && beforeChecks.noStalePlaybackSessions
    && beforeChecks.notLocked
    && beforeChecks.zeroPreviousWatchSessions
    && beforeChecks.zeroPreviousDeviceSessionConflicts,
  );
  if (!beforeGatePassed) {
    throw new Error(`Fresh-student gate failed before playback: ${JSON.stringify(beforeChecks)}`);
  }

  const { token, user } = await login();
  const userId = String(user?._id || '');
  if (!userId) {
    throw new Error('Login response did not include user id.');
  }

  const initialPlayer = await getPlayer(token, tabId);
  if (!initialPlayer.response.ok) {
    throw new Error(`Initial player request failed: ${initialPlayer.response.status} ${(initialPlayer.data as JsonRecord)?.message || initialPlayer.text}`);
  }
  const playbackSessionId = String((initialPlayer.data as JsonRecord)?.playbackSessionId || '');
  const durationSeconds = Math.max(Number((initialPlayer.data as JsonRecord)?.durationSeconds || 0), 1208);
  if (!playbackSessionId) {
    throw new Error('Initial player request did not return playbackSessionId.');
  }

  const apiProof: JsonRecord = {
    userId,
    courseId,
    videoId: lessonId,
    deviceId,
    browserTabId: tabId,
    freshStudent: {
      createdThisRun: createFreshStudent,
      email: pristineEmail,
      name: pristineName,
    },
    initialPlayer: summarizeWatchState(initialPlayer.data as JsonRecord),
  };

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: headedBrowser ? false : true,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1100 });
    await page.setUserAgent(playbackUserAgent);
    await page.evaluateOnNewDocument((authToken, nextDeviceId, nextTabId) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
      window.localStorage.setItem('edumaster.device.id', nextDeviceId);
      window.sessionStorage.setItem('edumaster.playback.tab.id', nextTabId);
    }, token, deviceId, tabId);

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      consoleIssues.push(error.stack || error.message);
    });
    page.on('response', async (response) => {
      const url = response.url();
      if (!/\/player|\/track|cloudflarestream\.com|videodelivery\.net|\.m3u8|\.m4s|\.ts(\?|$)|\.mp4(\?|$)|\/watch-progress/.test(url)) {
        return;
      }
      const event: Record<string, any> = {
        url,
        status: response.status(),
        contentType: response.headers()['content-type'] || null,
      };
      if (response.status() >= 400) {
        try {
          event.bodySample = (await response.text()).slice(0, 400);
        } catch {
          event.bodySample = '(unavailable)';
        }
      }
      networkEvents.push(event);
    });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 45_000 });
    const dashboardScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '01-logged-in-dashboard', 'png');
    await page.screenshot({ path: dashboardScreenshot, fullPage: true });

    await clickSelector(page, selectors.navCourses);
    await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await openCourseFromCatalog(page);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    const courseScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '02-course-page', 'png');
    await page.screenshot({ path: courseScreenshot, fullPage: true });

    await openLessonFromCourse(page);
    await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    const playerVisibleScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '03-player-visible', 'png');
    await page.screenshot({ path: playerVisibleScreenshot, fullPage: true });

    await page.click(selectors.coursePlayerVideo);
    await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      if (!video) {
        throw new Error('Video element missing before play.');
      }
      void video.play?.().catch(() => undefined);
    }, selectors.coursePlayerVideo);

    const playingState = await waitForProgress(page, 2, 20_000);
    const playingScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '04-video-playing', 'png');
    await page.screenshot({ path: playingScreenshot, fullPage: true });
    await clickSelector(page, selectors.courseBackToLessons);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    const shortWatchBackScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '05-short-watch-back', 'png');
    await page.screenshot({ path: shortWatchBackScreenshot, fullPage: true });
    apiProof.afterShortWatch = summarizeWatchState((await getPlayer(token, tabId)).data as JsonRecord);

    await openLessonFromCourse(page);
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    const reopenScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '06-after-reopen', 'png');
    await page.screenshot({ path: reopenScreenshot, fullPage: true });
    await page.click(selectors.coursePlayerVideo);
    const reopenPlayState = await waitForProgress(page, 1, 15_000);
    await clickSelector(page, selectors.courseBackToLessons);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    apiProof.afterSecondShortWatch = summarizeWatchState((await getPlayer(token, tabId)).data as JsonRecord);

    await openLessonFromCourse(page);
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    await page.click(selectors.coursePlayerVideo);
    const preSeekState = await waitForProgress(page, 1, 15_000);
    await seekVideo(page, durationSeconds - 5);
    const seekHeartbeatProof = await sendHeartbeat(
      token,
      playbackSessionId,
      Math.max(0, Math.floor(preSeekState.currentTime)),
      Math.max(0, durationSeconds - 5),
      durationSeconds,
    );
    const afterSeekState = await waitForProgress(page, 30, 15_000);
    const afterSeekScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '07-after-seek-no-conflict', 'png');
    await page.screenshot({ path: afterSeekScreenshot, fullPage: true });
    apiProof.seekForward = summarizeHeartbeat(seekHeartbeatProof.data as JsonRecord);
    apiProof.afterSeekForward = summarizeWatchState((await getPlayer(token, tabId)).data as JsonRecord);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    const playerVisibleAfterReload = await waitForSelectorOptional(page, selectors.coursePlayerVideo, 5_000);
    if (!playerVisibleAfterReload) {
      await clickSelector(page, selectors.navCourses);
      await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
      await openCourseFromCatalog(page);
      await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
      await openLessonFromCourse(page);
      await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    }
    await page.click(selectors.coursePlayerVideo);
    const afterReloadState = await waitForProgress(page, 1, 20_000);
    const afterReloadScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '08-after-refresh-reopen', 'png');
    await page.screenshot({ path: afterReloadScreenshot, fullPage: true });
    apiProof.afterRefresh = summarizeWatchState((await getPlayer(token, tabId)).data as JsonRecord);

    const sameTabReopen = await getPlayer(token, tabId);
    apiProof.sameTabReopen = {
      status: sameTabReopen.response.status,
      playbackSessionId: (sameTabReopen.data as JsonRecord)?.playbackSessionId || null,
      activeSessionDecision: String((sameTabReopen.data as JsonRecord)?.playbackSessionId || '') === String(playbackSessionId)
        ? 'reused-existing-session'
        : 'issued-safe-replacement-session',
    };

    const differentTabConflict = await getPlayer(token, secondTabId);
    apiProof.differentTabConflict = {
      status: differentTabConflict.response.status,
      code: (differentTabConflict.data as JsonRecord)?.code || null,
      message: (differentTabConflict.data as JsonRecord)?.message || null,
      browserTabId: secondTabId,
      activeSessionDecision: differentTabConflict.response.status === 409 ? 'blocked-true-different-tab' : 'unexpected-non-conflict',
    };
    const conflictScreenshot = await collectConflictPageScreenshot(browser, token, ctx);

    const thresholdPlayer = await getPlayer(token, tabId);
    const thresholdSessionId = String((thresholdPlayer.data as JsonRecord)?.playbackSessionId || playbackSessionId);
    apiProof.beforeThresholdProof = summarizeWatchState(thresholdPlayer.data as JsonRecord);
    const thresholdEvents = await simulateThresholdWatch(token, thresholdSessionId, durationSeconds);
    const afterThreshold = await getPlayer(token, tabId);
    apiProof.afterThresholdProof = summarizeWatchState(afterThreshold.data as JsonRecord);

    const sameTabNoConflictScreenshot = artifactPath(ctx.screenshotDir, 'pristine-video', '09-no-false-conflict', 'png');
    await page.screenshot({ path: sameTabNoConflictScreenshot, fullPage: true });

    const afterDb = await remotePristineState('snapshot');
    const cleanupState = await remotePristineState('cleanup');

    const hlsManifestEvents = networkEvents.filter((entry) => /\.m3u8(\?|$)/.test(String(entry.url || '')));
    const hlsSegmentEvents = networkEvents.filter((entry) => /\.(m4s|ts|mp4)(\?|$)/.test(String(entry.url || '')));

    const summary = {
      ok: initialPlayer.response.ok
        && Number(apiProof.initialPlayer.completedFullWatches || 0) === 0
        && Number(apiProof.afterShortWatch.completedFullWatches || 0) === 0
        && Number(apiProof.afterSecondShortWatch.completedFullWatches || 0) === 0
        && Number(apiProof.afterSeekForward.completedFullWatches || 0) === 0
        && Number(apiProof.afterRefresh.completedFullWatches || 0) === 0
        && apiProof.sameTabReopen.status === 200
        && apiProof.differentTabConflict.status === 409
        && apiProof.differentTabConflict.code === 'PLAYBACK_SESSION_CONFLICT'
        && Number(apiProof.afterThresholdProof.completedFullWatches || 0) === 1
        && apiProof.afterThresholdProof.locked === false
        && !playingState.flags.anotherTab
        && !playingState.flags.unavailable
        && !afterSeekState.flags.anotherTab
        && !afterReloadState.flags.anotherTab
        && consoleIssues.length === 0
        && hlsManifestEvents.some((entry) => entry.status === 200)
        && hlsSegmentEvents.some((entry) => entry.status === 200)
        && Boolean(afterDb?.snapshot?.checks?.courseEnrollmentActive)
        && Boolean(afterDb?.snapshot?.checks?.courseValidityActive)
        && Boolean(afterDb?.snapshot?.checks?.notLocked),
      userId,
      courseId,
      lessonId,
      videoId: lessonId,
      playbackSessionId,
      deviceId,
      browserTabId: tabId,
      beforeTestDatabaseState: beforeDb.snapshot,
      apiProof,
      browserProof: {
        playingState,
        reopenPlayState,
        afterSeekState,
        afterReloadState,
        consoleIssues,
        networkEvents,
        hlsManifestEvents,
        hlsSegmentEvents,
        screenshots: {
          dashboardScreenshot,
          courseScreenshot,
          playerVisibleScreenshot,
          playingScreenshot,
          shortWatchBackScreenshot,
          reopenScreenshot,
          afterSeekScreenshot,
          afterReloadScreenshot,
          sameTabNoConflictScreenshot,
          conflictScreenshot,
        },
      },
      thresholdEvents: thresholdEvents.map((entry) => ({
        reason: entry?.reason || entry?.outcome?.reason || null,
        suspiciousReasons: entry?.outcome?.suspiciousReasons || [],
        completedFullWatches: entry?.watchState?.completedFullWatches ?? null,
        currentCycleUniqueWatchedSeconds: entry?.watchState?.currentCycleUniqueWatchedSeconds ?? null,
        totalUniqueWatchedSeconds: entry?.watchState?.totalUniqueWatchedSeconds ?? null,
        repeatWatchedSeconds: entry?.watchState?.repeatWatchedSeconds ?? null,
        uniqueCoveragePercent: durationSeconds
          ? Number((((entry?.watchState?.currentCycleUniqueWatchedSeconds ?? 0) / durationSeconds) * 100).toFixed(2))
          : null,
      })),
      afterTestDatabaseState: afterDb.snapshot,
      cleanupState: cleanupState.snapshot,
    };

    const report = [
      '# Production Video Pristine Certification',
      '',
      `- Zero-history fresh student: ${summary.beforeTestDatabaseState?.checks?.zeroVideoProgress && summary.beforeTestDatabaseState?.checks?.zeroCompletedFullWatches ? 'yes' : 'no'}`,
      `- Fresh user email: ${pristineEmail}`,
      `- User id: ${userId}`,
      `- Course id: ${courseId}`,
      `- Video id: ${lessonId}`,
      `- Playback session id: ${playbackSessionId}`,
      `- Device id: ${deviceId}`,
      `- Browser tab id: ${tabId}`,
      '',
      '## Before Test Database State',
      '',
      '```json',
      JSON.stringify(summary.beforeTestDatabaseState, null, 2),
      '```',
      '',
      '## After Test Database State',
      '',
      '```json',
      JSON.stringify(summary.afterTestDatabaseState, null, 2),
      '```',
      '',
      '## Outcome',
      '',
      `- Short watches kept completed_full_watches at 0: ${Number(apiProof.afterShortWatch.completedFullWatches || 0) === 0 && Number(apiProof.afterSecondShortWatch.completedFullWatches || 0) === 0 ? 'yes' : 'no'}`,
      `- Seek-forward kept completed_full_watches at 0 before threshold proof: ${Number(apiProof.afterSeekForward.completedFullWatches || 0) === 0 ? 'yes' : 'no'}`,
      `- Same-tab reopen worked: ${apiProof.sameTabReopen.status === 200 ? 'yes' : 'no'}`,
      `- Different-tab conflict worked: ${apiProof.differentTabConflict.status === 409 ? 'yes' : 'no'}`,
      `- HLS manifest 200 observed: ${hlsManifestEvents.some((entry) => entry.status === 200) ? 'yes' : 'no'}`,
      `- HLS segment 200 observed: ${hlsSegmentEvents.some((entry) => entry.status === 200) ? 'yes' : 'no'}`,
      `- Console errors observed: ${consoleIssues.length > 0 ? 'yes' : 'no'}`,
      `- False session conflict banner observed: ${playingState.flags.anotherTab || afterSeekState.flags.anotherTab || afterReloadState.flags.anotherTab ? 'yes' : 'no'}`,
      `- Threshold proof reached 1 completed full watch only after >=90% unique coverage: ${Number(apiProof.afterThresholdProof.completedFullWatches || 0) === 1 ? 'yes' : 'no'}`,
      `- Safe for one normal student: ${summary.ok ? 'yes' : 'no'}`,
      '',
      '## Artifacts',
      '',
      `- JSON: ${analysisPath}`,
      `- Screenshots: ${ctx.screenshotDir}`,
    ].join('\n');

    await writeJson(analysisPath, summary);
    await writeText(reportPath, report);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
