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
const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sshHost = String(process.env.QA_PROD_SSH_HOST || 'root@178.105.48.179').trim();
const remoteContainerName = String(process.env.QA_PROD_APP_CONTAINER || 'lowcost-app-1').trim();
const headedBrowser = ['1', 'true', 'yes', 'on'].includes(String(process.env.PLAYBACK_QA_HEADED || 'false').toLowerCase());
const runLabel = new Date().toISOString().replace(/[:.]/g, '-');
const runSeed = runLabel.toLowerCase().replace(/[^a-z0-9]+/g, '');
const courseId = String(process.env.QA_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2').trim();
const courseText = String(process.env.QA_COURSE_TEXT || 'SSC').trim();
const shortWatchSeconds = 2;
const secondShortWatchSeconds = 1;

const buildStudentProfile = (prefix: string) => ({
  email: `${prefix}.${runSeed}@example.com`,
  password: `Student@${runLabel.replace(/[^0-9]/g, '').slice(-10) || '1234567890'}Aa`,
  name: `QA ${prefix.replace(/[^a-z]/gi, ' ')} ${runLabel.slice(0, 19)}`.trim(),
});

const purchasedProfile = buildStudentProfile('freeorder.purchased');
const expiredProfile = buildStudentProfile('freeorder.expired');
const blockedProfile = buildStudentProfile('freeorder.blocked');

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
    throw new Error(`${result.response.status} ${String((result.data as JsonRecord)?.message || (result.data as JsonRecord)?.error || result.text).slice(0, 300)}`);
  }
  return result;
};

const execSsh = async (command: string) => {
  const result = await execFileAsync('ssh', ['-o', 'StrictHostKeyChecking=no', sshHost, command], {
    maxBuffer: 1024 * 1024 * 30,
  });
  return result.stdout.trim();
};

const runRemoteNode = async (script: string) => {
  const encodedScript = Buffer.from(script, 'utf8').toString('base64');
  const remoteCommand = `docker exec ${remoteContainerName} sh -lc "cd /app && printf '%s' '${encodedScript}' | base64 -d | node"`;
  const stdout = await execSsh(remoteCommand);
  return JSON.parse(stdout || '{}');
};

const remoteCourseAndUserState = async (action: 'prepare' | 'snapshot') => runRemoteNode(`
const bcrypt = require('./backend/node_modules/bcryptjs');
const { usersRepository, coursesRepository, platformRepository, videoPlaybackRepository } = require('./backend/lib/repositories.js');
const { initializePostgres, queryPostgres } = require('./backend/lib/postgres.js');
const { getRedisJson, deleteRedisKey } = require('./backend/lib/redis.js');
const { appConfig } = require('./backend/lib/config.js');

const payload = ${JSON.stringify({
  courseId,
  action,
  users: {
    purchased: purchasedProfile,
    expired: expiredProfile,
    blocked: blockedProfile,
  },
})};

const CACHE_PREFIX = String(appConfig.cachePrefix || 'varonenglish').replace(/[:\\s]+/g, '-');
const activeKey = (userId) => \`\${CACHE_PREFIX}:video-playback-active:\${String(userId)}\`;

const flattenLessons = (course) => {
  const lessons = [];
  for (const moduleEntry of course?.modules || []) {
    for (const lesson of moduleEntry?.lessons || []) {
      lessons.push({
        ...lesson,
        moduleId: moduleEntry.id,
        moduleTitle: moduleEntry.title,
        chapterId: null,
        chapterTitle: null,
      });
    }
    for (const chapter of moduleEntry?.chapters || []) {
      for (const lesson of chapter?.lessons || []) {
        lessons.push({
          ...lesson,
          moduleId: moduleEntry.id,
          moduleTitle: moduleEntry.title,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
        });
      }
    }
  }
  return lessons;
};

const releaseStatus = (lesson) => {
  const releaseAt = lesson?.releaseAt || lesson?.availableAt || lesson?.publishedAt || null;
  if (!releaseAt) {
    return 'released';
  }
  const releaseMs = Date.parse(releaseAt);
  return Number.isFinite(releaseMs) && releaseMs > Date.now() ? 'unreleased' : 'released';
};

const ensureStudent = async (profile, mode) => {
  let user = await usersRepository.findByEmail(profile.email);
  if (!user) {
    const hashed = await bcrypt.hash(profile.password, 10);
    user = await usersRepository.create({
      name: profile.name,
      email: profile.email,
      password: hashed,
      role: 'student',
    });
  }

  await queryPostgres('DELETE FROM watch_history WHERE user_id = $1 AND course_id = $2', [String(user._id), String(payload.courseId)]);
  await queryPostgres('DELETE FROM video_watch_states WHERE user_id = $1 AND course_id = $2', [String(user._id), String(payload.courseId)]);
  await queryPostgres('DELETE FROM video_access_grants WHERE user_id = $1 AND course_id = $2', [String(user._id), String(payload.courseId)]);
  await deleteRedisKey(activeKey(user._id));

  if (mode === 'purchased' || mode === 'expired') {
    await platformRepository.enroll({
      userId: String(user._id),
      courseId: payload.courseId,
      source: 'qa-free-order-certification',
      accessType: 'course',
    });
    await queryPostgres(
      mode === 'expired'
        ? "UPDATE enrollments SET expires_at = now() - interval '1 day' WHERE user_id = $1 AND course_id = $2"
        : "UPDATE enrollments SET expires_at = now() + interval '365 day' WHERE user_id = $1 AND course_id = $2",
      [String(user._id), String(payload.courseId)],
    );
  } else {
    await queryPostgres('DELETE FROM enrollments WHERE user_id = $1 AND course_id = $2', [String(user._id), String(payload.courseId)]);
  }

  const enrollments = (await queryPostgres(
    'SELECT id, user_id, course_id, access_type, source, enrolled_at, expires_at, view_count FROM enrollments WHERE user_id = $1 AND course_id = $2 ORDER BY enrolled_at ASC',
    [String(user._id), String(payload.courseId)],
  )).rows;
  const watchStates = (await queryPostgres(
    'SELECT * FROM video_watch_states WHERE user_id = $1 AND course_id = $2 ORDER BY updated_at DESC',
    [String(user._id), String(payload.courseId)],
  )).rows;

  return {
    id: String(user._id),
    email: String(user.email || ''),
    role: String(user.role || ''),
    enrollment: enrollments[0] || null,
    watchStates,
    activePlaybackSession: await getRedisJson(activeKey(user._id)),
  };
};

const loadStudent = async (profile) => {
  const user = await usersRepository.findByEmail(profile.email);
  if (!user) {
    throw new Error(\`QA user not found for snapshot: \${profile.email}\`);
  }
  const enrollments = (await queryPostgres(
    'SELECT id, user_id, course_id, access_type, source, enrolled_at, expires_at, view_count FROM enrollments WHERE user_id = $1 AND course_id = $2 ORDER BY enrolled_at ASC',
    [String(user._id), String(payload.courseId)],
  )).rows;
  const watchStates = (await queryPostgres(
    'SELECT * FROM video_watch_states WHERE user_id = $1 AND course_id = $2 ORDER BY updated_at DESC',
    [String(user._id), String(payload.courseId)],
  )).rows;
  return {
    id: String(user._id),
    email: String(user.email || ''),
    role: String(user.role || ''),
    enrollment: enrollments[0] || null,
    watchStates,
    activePlaybackSession: await getRedisJson(activeKey(user._id)),
  };
};

(async () => {
  await initializePostgres();
  const course = await coursesRepository.findById(payload.courseId);
  if (!course) {
    throw new Error(\`Course not found: \${payload.courseId}\`);
  }
  const lessons = flattenLessons(course);
  const releasedLessons = lessons.filter((lesson) => releaseStatus(lesson) === 'released');
  const unreleasedLesson = lessons.find((lesson) => releaseStatus(lesson) === 'unreleased') || null;

  const purchased = payload.action === 'prepare'
    ? await ensureStudent(payload.users.purchased, 'purchased')
    : await loadStudent(payload.users.purchased);
  const expired = payload.action === 'prepare'
    ? await ensureStudent(payload.users.expired, 'expired')
    : await loadStudent(payload.users.expired);
  const blocked = payload.action === 'prepare'
    ? await ensureStudent(payload.users.blocked, 'blocked')
    : await loadStudent(payload.users.blocked);

  console.log(JSON.stringify({
    course: {
      id: String(course._id),
      title: String(course.title || ''),
      courseVideoAccessMode: String(course.courseVideoAccessMode || course.videoAccessMode || course.settings?.courseVideoAccessMode || 'free_order'),
      releasedLessons: releasedLessons.map((lesson, index) => ({
        index,
        id: String(lesson.id || ''),
        title: String(lesson.title || ''),
        releaseStatus: releaseStatus(lesson),
      })),
      unreleasedLesson: unreleasedLesson ? {
        id: String(unreleasedLesson.id || ''),
        title: String(unreleasedLesson.title || ''),
        releaseStatus: releaseStatus(unreleasedLesson),
      } : null,
    },
    users: { purchased, expired, blocked },
  }, null, 2));
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
`);

const login = async (email: string, password: string, device: string) => {
  const result = await requireOk<{ token: string; user: JsonRecord }>(`${apiBaseUrl}/auth/login`, {
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
  const token = String(result.data?.token || '');
  if (!token) {
    throw new Error('Login succeeded without a token.');
  }
  return { token, user: result.data.user };
};

const playbackHeaders = (token: string, deviceId: string, playbackTabId: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
  'user-agent': playbackUserAgent,
  'x-edumaster-app': 'web',
  'x-edumaster-client-platform': 'windows',
  'x-edumaster-client-browser': 'chrome',
  'x-edumaster-device-id': deviceId,
  'x-edumaster-playback-tab-id': playbackTabId,
});

const getPlayer = async (token: string, lessonId: string, deviceId: string, playbackTabId: string) =>
  requestJson<JsonRecord>(`${apiBaseUrl}/courses/${courseId}/lessons/${lessonId}/player`, {
    headers: playbackHeaders(token, deviceId, playbackTabId),
  });

const sendHeartbeat = async (
  token: string,
  lessonId: string,
  playbackSessionId: string,
  previousPositionSeconds: number,
  currentPositionSeconds: number,
  durationSeconds: number,
  deviceId: string,
  playbackTabId: string,
) => requireOk<JsonRecord>(`${apiBaseUrl}/track`, {
  method: 'POST',
  headers: {
    ...playbackHeaders(token, deviceId, playbackTabId),
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

const clickSelector = async (page: puppeteer.Page, selector: string, timeoutMs = 30_000) => {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  await page.evaluate((targetSelector) => {
    const node = document.querySelector(targetSelector) as HTMLElement | null;
    node?.scrollIntoView({ block: 'center', inline: 'nearest' });
    node?.click();
  }, selector);
};

const setAuthSession = async (page: puppeteer.Page, token: string, deviceId: string, tabId: string) => {
  await page.evaluateOnNewDocument((authToken, nextDeviceId, nextTabId) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
    window.localStorage.setItem('edumaster.device.id', nextDeviceId);
    window.sessionStorage.setItem('edumaster.playback.tab.id', nextTabId);
  }, token, deviceId, tabId);
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

const openLessonByText = async (page: puppeteer.Page, lessonText: string) => {
  const locateLesson = () => page.evaluate((lessonSelector, text) => {
    const buttons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const expected = text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const candidates = buttons.map((button) => ({
      text: (button.textContent || '').trim(),
      normalized: (button.textContent || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }));
    const target = buttons.find((button) => {
      const normalized = (button.textContent || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return normalized.includes(expected) || expected.includes(normalized);
    });
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return {
      clicked: Boolean(target),
      candidates,
    };
  }, selectors.courseLessonOpen, lessonText);

  await page.waitForSelector(`${selectors.courseLessonOpen}, ${selectors.courseChapterToggle}`, { timeout: 30_000 });
  let lessonLookup = await locateLesson();
  if (!lessonLookup.clicked) {
    const toggleCount = await page.$$eval(selectors.courseChapterToggle, (elements) => elements.length).catch(() => 0);
    for (let toggleIndex = 0; toggleIndex < toggleCount && !lessonLookup.clicked; toggleIndex += 1) {
      await page.evaluate((toggleSelector, index) => {
        const toggles = Array.from(document.querySelectorAll(toggleSelector)) as HTMLElement[];
        const target = toggles[index] || null;
        target?.scrollIntoView({ block: 'center', inline: 'nearest' });
        target?.click();
      }, selectors.courseChapterToggle, toggleIndex);
      await sleep(250);
      lessonLookup = await locateLesson();
    }
  }

  if (!lessonLookup.clicked) {
    const visibleLessons = lessonLookup.candidates.map((entry: { text: string }) => entry.text).filter(Boolean).join(' | ');
    throw new Error(`No lesson entry matched "${lessonText}". Visible lesson entries: ${visibleLessons || '(none)'}`);
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
        unavailable: /lesson video unavailable|not available yet|not released yet/i.test(bodyText),
        expired: /course validity expired/i.test(bodyText),
        blockedPurchase: /please purchase course to watch/i.test(bodyText),
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

const summarizeWatchState = (payload: JsonRecord | null | undefined) => ({
  playbackSessionId: payload?.playbackSessionId || null,
  playbackStatus: payload?.playbackStatus || null,
  streamFormat: payload?.streamFormat || null,
  streamUrlPresent: Boolean(payload?.streamUrl),
  resumeSeconds: payload?.resumeSeconds ?? null,
  watchLimit: payload?.watchLimit ?? null,
  watchCompletionPercent: payload?.watchCompletionPercent ?? null,
  currentCycleUniqueWatchedSeconds: payload?.watchState?.currentCycleUniqueWatchedSeconds ?? null,
  totalUniqueWatchedSeconds: payload?.watchState?.totalUniqueWatchedSeconds ?? null,
  repeatWatchedSeconds: payload?.watchState?.repeatWatchedSeconds ?? null,
  completedFullWatches: payload?.watchState?.completedFullWatches ?? null,
  locked: payload?.watchState?.locked ?? payload?.watchState?.isLocked ?? null,
  watchedSegments: payload?.watchState?.watchedSegments ?? null,
});

const summarizeHeartbeat = (payload: JsonRecord | null | undefined) => ({
  accepted: payload?.accepted ?? null,
  reason: payload?.reason || payload?.outcome?.reason || null,
  sessionStatus: payload?.sessionStatus || null,
  suspiciousReasons: payload?.outcome?.suspiciousReasons || [],
  completedFullWatches: payload?.watchState?.completedFullWatches ?? null,
  currentCycleUniqueWatchedSeconds: payload?.watchState?.currentCycleUniqueWatchedSeconds ?? null,
  totalUniqueWatchedSeconds: payload?.watchState?.totalUniqueWatchedSeconds ?? null,
  repeatWatchedSeconds: payload?.watchState?.repeatWatchedSeconds ?? null,
});

const labelToSafe = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const openLessonAndCapture = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  lesson: { id: string; title: string },
  screenshotLabel: string,
) => {
  await openLessonByText(page, lesson.title);
  await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
  await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
  const screenshotPath = artifactPath(ctx.screenshotDir, 'free-order-video', screenshotLabel, 'png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
};

const main = async () => {
  const ctx = await createRunContext();
  const analysisPath = path.join(ctx.analysisDir, 'course-video-free-order-certification.json');
  const reportPath = path.join(ctx.analysisDir, 'course-video-free-order-certification.md');
  const consoleIssues: string[] = [];
  const networkEvents: Array<Record<string, any>> = [];

  const remoteState = await remoteCourseAndUserState('prepare');
  const releasedLessons = Array.isArray(remoteState?.course?.releasedLessons) ? remoteState.course.releasedLessons : [];
  if (!releasedLessons[0] || !releasedLessons[1]) {
    throw new Error(`Target course does not contain enough released lessons for the requested certification. Released lessons found: ${releasedLessons.length}`);
  }

  const selectedLessons = {
    video1: releasedLessons[0],
    video2: releasedLessons[1],
    video5: releasedLessons[4] || releasedLessons[2] || releasedLessons[1],
    video10: releasedLessons[9] || null,
    unreleased: remoteState?.course?.unreleasedLesson || null,
  };

  const beforeDbState = {
    purchasedUser: remoteState?.users?.purchased || null,
    expiredUser: remoteState?.users?.expired || null,
    blockedUser: remoteState?.users?.blocked || null,
    course: remoteState?.course || null,
    selectedLessons,
  };
  await writeJson(path.join(ctx.analysisDir, 'before-db-state.json'), beforeDbState);

  const purchasedDeviceId = `qa-free-order-device-${runSeed}`;
  const purchasedTabId = `qa-free-order-tab-${runSeed}`;
  const secondTabId = `${purchasedTabId}-2`;
  const purchasedLogin = await login(purchasedProfile.email, purchasedProfile.password, `qa-free-order-login-${runSeed}`);

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
    await setAuthSession(page, purchasedLogin.token, purchasedDeviceId, purchasedTabId);

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
      if (!/\/player|\/track|\/watch-progress|\.m3u8|\.m4s|\.ts(\?|$)|\.mp4(\?|$)|course-manifests|\/courses\/h\//i.test(url)) {
        return;
      }
      const event: Record<string, any> = {
        url,
        status: response.status(),
        method: response.request().method(),
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
    const loginScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '01-login-dashboard', 'png');
    await page.screenshot({ path: loginScreenshot, fullPage: true });

    await clickSelector(page, selectors.navCourses);
    await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await openCourseFromCatalog(page);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    const courseScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '02-course-page', 'png');
    await page.screenshot({ path: courseScreenshot, fullPage: true });

    const playlistScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '03-playlist', 'png');
    await page.screenshot({ path: playlistScreenshot, fullPage: true });

    const apiProof: JsonRecord = {
      lessonSelection: selectedLessons,
      purchasedUserId: remoteState?.users?.purchased?.id || purchasedLogin.user?._id || null,
      courseVideoAccessMode: remoteState?.course?.courseVideoAccessMode || null,
    };

    await openLessonAndCapture(page, ctx, selectedLessons.video1, '04-video-1-player');
    await page.click(selectors.coursePlayerVideo);
    const video1PlayingState = await waitForProgress(page, 2, 20_000);
    const video1PlayingScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '05-video-1-playing', 'png');
    await page.screenshot({ path: video1PlayingScreenshot, fullPage: true });
    apiProof.video1 = {
      lessonId: selectedLessons.video1.id,
      title: selectedLessons.video1.title,
      player: summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord),
      state: video1PlayingState,
    };

    if (selectedLessons.video10) {
      await clickSelector(page, selectors.courseBackToLessons);
      await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
      await openLessonAndCapture(page, ctx, selectedLessons.video10, '06-video-10-direct-player');
      await page.click(selectors.coursePlayerVideo);
      const video10PlayingState = await waitForProgress(page, 2, 20_000);
      const video10PlayingScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '07-video-10-direct-playing', 'png');
      await page.screenshot({ path: video10PlayingScreenshot, fullPage: true });
      apiProof.video10 = {
        lessonId: selectedLessons.video10.id,
        title: selectedLessons.video10.title,
        player: summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video10.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord),
        state: video10PlayingState,
      };
    } else {
      apiProof.video10 = {
        skipped: true,
        blockedReason: 'Target course does not have a 10th released lesson in this environment.',
      };
    }

    const randomOrderResults: JsonRecord[] = [];
    const randomOrderLessons = [selectedLessons.video5, selectedLessons.video2, selectedLessons.video10].filter(Boolean);
    for (const [index, lesson] of randomOrderLessons.entries()) {
      await clickSelector(page, selectors.courseBackToLessons);
      await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
      await openLessonAndCapture(page, ctx, lesson, `08-random-order-${index + 1}-${labelToSafe(lesson.title)}`);
      await page.click(selectors.coursePlayerVideo);
      const state = await waitForProgress(page, 1, 15_000);
      randomOrderResults.push({
        lessonId: lesson.id,
        title: lesson.title,
        state,
      });
    }
    const randomPlayingScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '09-random-video-playing', 'png');
    await page.screenshot({ path: randomPlayingScreenshot, fullPage: true });
    apiProof.randomOrder = randomOrderResults;

    await clickSelector(page, selectors.courseBackToLessons);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await openLessonByText(page, selectedLessons.video1.title);
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    await page.click(selectors.coursePlayerVideo);
    await waitForProgress(page, 1, 15_000);
    await sleep(shortWatchSeconds * 1000);
    await clickSelector(page, selectors.courseBackToLessons);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    const afterShortWatchScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '10-after-short-watch-not-locked', 'png');
    await page.screenshot({ path: afterShortWatchScreenshot, fullPage: true });
    apiProof.afterShortWatch = summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord);

    await openLessonByText(page, selectedLessons.video1.title);
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    await page.click(selectors.coursePlayerVideo);
    await waitForProgress(page, 1, 15_000);
    await sleep(secondShortWatchSeconds * 1000);
    await clickSelector(page, selectors.courseBackToLessons);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    apiProof.afterSecondShortWatch = summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord);

    await openLessonByText(page, selectedLessons.video1.title);
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    await page.click(selectors.coursePlayerVideo);
    const preSeekState = await waitForProgress(page, 1, 15_000);
    const currentPlayback = await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId);
    const seekSessionId = String((currentPlayback.data as JsonRecord)?.playbackSessionId || '');
    const seekDuration = Math.max(Number((currentPlayback.data as JsonRecord)?.durationSeconds || preSeekState.duration || 0), 60);
    await seekVideo(page, Math.max(seekDuration - 5, 10));
    const seekHeartbeat = await sendHeartbeat(
      purchasedLogin.token,
      selectedLessons.video1.id,
      seekSessionId,
      Math.max(Number(preSeekState.currentTime || 0), 0),
      Math.max(seekDuration - 5, 10),
      seekDuration,
      purchasedDeviceId,
      purchasedTabId,
    );
    const afterSeekState = await waitForProgress(page, 1, 10_000);
    const afterSeekScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '11-after-seek-still-playing', 'png');
    await page.screenshot({ path: afterSeekScreenshot, fullPage: true });
    apiProof.afterSeek = {
      player: summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord),
      heartbeat: summarizeHeartbeat(seekHeartbeat.data as JsonRecord),
      state: afterSeekState,
    };

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    await page.click(selectors.coursePlayerVideo);
    const afterReloadState = await waitForProgress(page, 1, 15_000);
    const afterRefreshScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '12-after-refresh-still-playing', 'png');
    await page.screenshot({ path: afterRefreshScreenshot, fullPage: true });
    apiProof.afterRefresh = {
      player: summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord),
      state: afterReloadState,
    };

    await clickSelector(page, selectors.courseBackToLessons);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await openLessonByText(page, selectedLessons.video1.title);
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    await page.click(selectors.coursePlayerVideo);
    await waitForProgress(page, 1, 15_000);
    const sameTabScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '13-same-tab-reopen-no-conflict', 'png');
    await page.screenshot({ path: sameTabScreenshot, fullPage: true });
    apiProof.sameTabReopen = summarizeWatchState((await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, purchasedTabId)).data as JsonRecord);

    const secondPage = await browser.newPage();
    await secondPage.setViewport({ width: 1440, height: 1100 });
    await secondPage.setUserAgent(playbackUserAgent);
    await setAuthSession(secondPage, purchasedLogin.token, purchasedDeviceId, secondTabId);
    await secondPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await secondPage.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 45_000 });
    await clickSelector(secondPage, selectors.navCourses);
    await secondPage.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await openCourseFromCatalog(secondPage);
    await secondPage.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await openLessonByText(secondPage, selectedLessons.video1.title);
    await secondPage.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await secondPage.waitForFunction(
      () => /another tab|another device/i.test(document.body?.innerText || ''),
      { timeout: 20_000 },
    ).catch(() => undefined);
    const differentTabScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '14-real-different-tab-conflict', 'png');
    await secondPage.screenshot({ path: differentTabScreenshot, fullPage: true });
    apiProof.differentTabConflict = {
      response: {
        status: (await getPlayer(purchasedLogin.token, selectedLessons.video1.id, purchasedDeviceId, secondTabId)).response.status,
      },
    };
    await secondPage.close().catch(() => undefined);

    const blockedLogin = await login(blockedProfile.email, blockedProfile.password, `qa-free-order-blocked-${runSeed}`);
    const blockedPage = await browser.newPage();
    await blockedPage.setViewport({ width: 1440, height: 1100 });
    await blockedPage.setUserAgent(playbackUserAgent);
    await setAuthSession(blockedPage, blockedLogin.token, `qa-free-order-blocked-device-${runSeed}`, `qa-free-order-blocked-tab-${runSeed}`);
    await blockedPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await blockedPage.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 45_000 });
    await clickSelector(blockedPage, selectors.navCourses);
    await blockedPage.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await openCourseFromCatalog(blockedPage);
    await blockedPage.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await openLessonByText(blockedPage, selectedLessons.video1.title);
    await blockedPage.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await blockedPage.waitForFunction(
      () => /please purchase course to watch/i.test(document.body?.innerText || ''),
      { timeout: 20_000 },
    ).catch(() => undefined);
    const blockedScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '15-not-purchased-message', 'png');
    await blockedPage.screenshot({ path: blockedScreenshot, fullPage: true });
    apiProof.notPurchased = await getPlayer(
      blockedLogin.token,
      selectedLessons.video1.id,
      `qa-free-order-blocked-device-${runSeed}`,
      `qa-free-order-blocked-tab-${runSeed}`,
    );
    await blockedPage.close().catch(() => undefined);

    const expiredLogin = await login(expiredProfile.email, expiredProfile.password, `qa-free-order-expired-${runSeed}`);
    const expiredPage = await browser.newPage();
    await expiredPage.setViewport({ width: 1440, height: 1100 });
    await expiredPage.setUserAgent(playbackUserAgent);
    await setAuthSession(expiredPage, expiredLogin.token, `qa-free-order-expired-device-${runSeed}`, `qa-free-order-expired-tab-${runSeed}`);
    await expiredPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await expiredPage.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 45_000 });
    await clickSelector(expiredPage, selectors.navCourses);
    await expiredPage.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await openCourseFromCatalog(expiredPage);
    await expiredPage.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await openLessonByText(expiredPage, selectedLessons.video1.title);
    await expiredPage.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await expiredPage.waitForFunction(
      () => /course validity expired/i.test(document.body?.innerText || ''),
      { timeout: 20_000 },
    ).catch(() => undefined);
    const expiredScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '16-expired-course-message', 'png');
    await expiredPage.screenshot({ path: expiredScreenshot, fullPage: true });
    apiProof.expired = await getPlayer(
      expiredLogin.token,
      selectedLessons.video1.id,
      `qa-free-order-expired-device-${runSeed}`,
      `qa-free-order-expired-tab-${runSeed}`,
    );
    await expiredPage.close().catch(() => undefined);

    if (selectedLessons.unreleased) {
      await clickSelector(page, selectors.courseBackToLessons);
      await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
      await openLessonByText(page, selectedLessons.unreleased.title);
      await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
      await page.waitForFunction(
        () => /not released yet/i.test(document.body?.innerText || ''),
        { timeout: 20_000 },
      ).catch(() => undefined);
      const unreleasedScreenshot = artifactPath(ctx.screenshotDir, 'free-order-video', '17-unreleased-video-message', 'png');
      await page.screenshot({ path: unreleasedScreenshot, fullPage: true });
      apiProof.unreleased = await getPlayer(
        purchasedLogin.token,
        selectedLessons.unreleased.id,
        purchasedDeviceId,
        purchasedTabId,
      );
    }

    const afterDbState = await remoteCourseAndUserState('snapshot');

    const hlsManifestEvents = networkEvents.filter((entry) => /\.m3u8(?:\?|$)|course-manifests/i.test(entry.url));
    const hlsSegmentEvents = networkEvents.filter((entry) => /\.(?:ts|m4s|mp4)(?:\?|$)/i.test(entry.url));
    const summary = {
      baseUrl,
      apiBaseUrl,
      courseId,
      courseText,
      runId: ctx.runId,
      selectedLessons,
      beforeDbState,
      afterDbState,
      apiProof: {
        ...apiProof,
        notPurchased: {
          status: apiProof.notPurchased?.response?.status || null,
          data: apiProof.notPurchased?.data || null,
        },
        expired: {
          status: apiProof.expired?.response?.status || null,
          data: apiProof.expired?.data || null,
        },
        unreleased: apiProof.unreleased ? {
          status: apiProof.unreleased.response?.status || null,
          data: apiProof.unreleased.data || null,
        } : null,
      },
      network: {
        totalObserved: networkEvents.length,
        playerRequests: networkEvents.filter((entry) => /\/player/.test(entry.url)),
        trackRequests: networkEvents.filter((entry) => /\/track/.test(entry.url)),
        hlsManifestEvents,
        hlsSegmentEvents,
      },
      consoleIssues,
      certificationBlockers: selectedLessons.video10 ? [] : [
        'Target environment does not currently expose a 10th released lesson, so direct "video 10" browser certification could not be executed.',
      ],
      certified: Boolean(
        apiProof.video1?.state?.currentTime >= 2
        && randomOrderResults.every((entry) => Number(entry.state?.currentTime || 0) >= 1)
        && Number(apiProof.afterShortWatch?.completedFullWatches ?? 0) === 0
        && Number(apiProof.afterSecondShortWatch?.completedFullWatches ?? 0) === 0
        && apiProof.afterSeek?.heartbeat?.reason === 'seek-forward'
        && !apiProof.afterSeek?.state?.flags?.anotherTab
        && !apiProof.afterRefresh?.state?.flags?.anotherTab
        && apiProof.differentTabConflict?.response?.status === 409
        && apiProof.notPurchased?.response?.status === 403
        && apiProof.expired?.response?.status === 403
        && hlsManifestEvents.some((entry) => entry.status === 200)
        && hlsSegmentEvents.some((entry) => entry.status === 200)
        && consoleIssues.length === 0
        && Boolean(selectedLessons.video10)
        && apiProof.video10?.state?.currentTime >= 2
      ),
    };

    const report = [
      '# Course Video Free-Order Browser Certification',
      '',
      `- Base URL: ${baseUrl}`,
      `- Course ID: ${courseId}`,
      `- Course video access mode: ${String(remoteState?.course?.courseVideoAccessMode || 'unknown')}`,
      `- Video 1 direct playback: ${apiProof.video1?.state?.currentTime >= 2 ? 'pass' : 'fail'}`,
      `- Video 10 direct playback: ${selectedLessons.video10 ? (apiProof.video10?.state?.currentTime >= 2 ? 'pass' : 'fail') : 'blocked by missing 10th released lesson in target environment'}`,
      `- Random order playback: ${randomOrderResults.every((entry) => Number(entry.state?.currentTime || 0) >= 1) ? 'pass' : 'fail'}`,
      `- Short watch remains uncounted: ${Number(apiProof.afterShortWatch?.completedFullWatches ?? 0) === 0 && Number(apiProof.afterSecondShortWatch?.completedFullWatches ?? 0) === 0 ? 'pass' : 'fail'}`,
      `- Seek-forward counted as skip only: ${apiProof.afterSeek?.heartbeat?.reason === 'seek-forward' ? 'pass' : 'fail'}`,
      `- Refresh same tab no false conflict: ${apiProof.afterRefresh?.state?.flags?.anotherTab ? 'fail' : 'pass'}`,
      `- Real different-tab conflict: ${apiProof.differentTabConflict?.response?.status === 409 ? 'pass' : 'fail'}`,
      `- Not-purchased message: ${apiProof.notPurchased?.response?.status === 403 ? 'pass' : 'fail'}`,
      `- Expired-course message: ${apiProof.expired?.response?.status === 403 ? 'pass' : 'fail'}`,
      `- Unreleased-video message: ${selectedLessons.unreleased ? (apiProof.unreleased?.response?.status === 403 ? 'pass' : 'fail') : 'not available in target course'}`,
      `- HLS manifest 200 observed: ${hlsManifestEvents.some((entry) => entry.status === 200) ? 'yes' : 'no'}`,
      `- HLS segment 200 observed: ${hlsSegmentEvents.some((entry) => entry.status === 200) ? 'yes' : 'no'}`,
      `- Console errors observed: ${consoleIssues.length > 0 ? 'yes' : 'no'}`,
      `- Certification blockers: ${summary.certificationBlockers.length > 0 ? summary.certificationBlockers.join('; ') : 'none'}`,
      `- Certified: ${summary.certified ? 'yes' : 'no'}`,
      '',
      `Screenshots: ${ctx.screenshotDir}`,
      `Analysis JSON: ${analysisPath}`,
    ].join('\n');

    await writeJson(analysisPath, summary);
    await writeText(reportPath, report);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close().catch(() => undefined);
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
