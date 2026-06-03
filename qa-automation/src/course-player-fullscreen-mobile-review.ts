import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, writeJson } from './utils.js';

type EnvMap = Record<string, string>;

type PlayerDiagnostics = {
  viewport: { width: number; height: number };
  fullscreenElement: string | null;
  playerRect: { x: number; y: number; width: number; height: number };
  videoRect: { x: number; y: number; width: number; height: number };
  visibleText: {
    reconnecting: boolean;
    unavailable: boolean;
  };
  video: {
    currentTime: number | null;
    duration: number | null;
    readyState: number | null;
    networkState: number | null;
    error: { code: number; message: string } | null;
  };
  contentProtection: {
    overlayPresent: boolean;
    message: string | null;
  };
};

type CourseUiState = {
  speedOptions: string[];
  qualityOptions: string[];
  controlsVisible: boolean;
  settingsTriggerVisible: boolean;
  settingsPanelVisible: boolean;
  speedTriggerVisible: boolean;
  qualityTriggerVisible: boolean;
  playerFormat: string | null;
  playerDeliveryPath: string | null;
  playerQualityCount: number | null;
  qualitySelectionSupported: boolean;
  settingsBodyScrollable: boolean;
  qualityStatusText: string | null;
};

type PlaybackControlProbe = {
  selectedSpeed: string | null;
  playbackRate: number | null;
  selectedQuality: string | null;
  availableQualities: string[];
};

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
const localEnvPath = path.join(rootDir, '.env');
const productionEnvPath = path.join(rootDir, '.env.production');
const fixturePrefix = 'QA Mobile Player Controls';
const fixtureModuleId = 'module_mobile_player_controls';
const fixtureVideoCandidates = [
  path.join(rootDir, 'uploads', 'live-fallback.mp4'),
  path.join(rootDir, 'uploads', 'videos', 'video_1774975487399.mp4'),
  path.join(rootDir, 'uploads', 'videos', 'video_1774974320379.mov'),
];

const readEnvFile = async (): Promise<EnvMap> => {
  const values: EnvMap = {};
  for (const envPath of [productionEnvPath, localEnvPath]) {
    try {
      const text = await fs.readFile(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const index = trimmed.indexOf('=');
        if (index > 0) {
          values[trimmed.slice(0, index)] = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, '');
        }
      }
    } catch {
      // Environment variables remain the primary input in CI.
    }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const playerVideoSelector = `${selectors.coursePlayerVideo}, [data-testid="course-figma-player"] video, video`;
let resolvedCourseId = process.env.QA_COURSE_ID || '';
let resolvedLessonId = process.env.QA_LESSON_ID || '';
const shouldDisableContentProtectionForQa = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(config.baseUrl);

type FixtureTarget = {
  courseId: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  sourceVideoPath: string;
};

const isVisibleSelector = async (page: puppeteer.Page, selector: string) =>
  page.$eval(selector, (element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    const style = window.getComputedStyle(target);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && Number(style.opacity || 1) > 0;
  }).catch(() => false);

const gotoApp = async (page: puppeteer.Page, url: string) => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ERR_ABORTED/i.test(message)) {
      throw error;
    }
    await page.waitForFunction(
      () => document.readyState === 'interactive' || document.readyState === 'complete',
      { timeout: 10_000 },
    ).catch(() => undefined);
  }
};

const withQaParams = (url: string) => {
  if (!shouldDisableContentProtectionForQa) {
    return url;
  }
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('qaDisableContentProtection', '1');
  return nextUrl.toString();
};

const loginForToken = async (email: string, password: string, device = 'QA Fullscreen Mobile Review') => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device,
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message || payload?.error || `Unable to login: ${response.status}`);
  }
  return String(payload.token);
};

const fetchJson = async <T>(
  relativePath: string,
  options: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: BodyInit;
  } = {},
): Promise<T> => {
  const response = await fetch(new URL(relativePath, apiOrigin), {
    method: options.method || 'GET',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `${options.method || 'GET'} ${relativePath} failed with ${response.status}`);
  }
  return payload as T;
};

const pickFixtureVideoPath = async () => {
  for (const candidate of fixtureVideoCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error(`No local sample video file was found for QA playback review. Checked: ${fixtureVideoCandidates.join(', ')}`);
};

const collectLessons = (course: Record<string, any>) => {
  const modules = Array.isArray(course?.modules) ? course.modules : [];
  return modules.flatMap((moduleEntry: Record<string, any>) => ([
    ...(Array.isArray(moduleEntry?.lessons) ? moduleEntry.lessons.map((lesson: Record<string, any>) => ({
      moduleId: moduleEntry.id,
      lesson,
    })) : []),
    ...(Array.isArray(moduleEntry?.chapters)
      ? moduleEntry.chapters.flatMap((chapter: Record<string, any>) =>
        (Array.isArray(chapter?.lessons) ? chapter.lessons : []).map((lesson: Record<string, any>) => ({
          moduleId: moduleEntry.id,
          chapterId: chapter.id,
          lesson,
        })))
      : []),
  ]));
};

const waitForFixtureLesson = async (token: string, courseId: string, lessonId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    const course = await fetchJson<Record<string, any>>(`/backend/api/courses/admin/details/${courseId}`, {
      token,
    }).catch(() => null);
    const lessonEntry = course ? collectLessons(course).find((entry) => String(entry.lesson?.id || '') === String(lessonId)) : null;
    if (lessonEntry) {
      const player = await fetchJson<Record<string, any>>(`/backend/api/courses/${courseId}/lessons/${lessonId}/player`, {
        token,
      }).catch(() => null);
      if (player?.streamUrl || player?.statusMessage || player?.playbackStatus === 'ready') {
        return {
          lesson: lessonEntry.lesson,
          player,
        };
      }
    }
    await sleep(4_000);
  }
  throw new Error(`Timed out waiting for fixture lesson ${lessonId} to become playable.`);
};

const ensureFixtureTarget = async (token: string): Promise<FixtureTarget> => {
  if (resolvedCourseId && resolvedLessonId) {
    return {
      courseId: resolvedCourseId,
      lessonId: resolvedLessonId,
      lessonTitle: process.env.QA_LESSON_TEXT || 'QA lesson',
      courseTitle: process.env.QA_COURSE_TEXT || 'QA course',
      sourceVideoPath: '',
    };
  }

  const adminCourses = await fetchJson<Array<Record<string, any>>>('/backend/api/courses/admin/list', {
    token,
  }).catch(() => []);
  const matchingCourse = adminCourses.find((course) => String(course?.title || '').startsWith(fixturePrefix)) || null;
  if (matchingCourse?._id) {
    const detail = await fetchJson<Record<string, any>>(`/backend/api/courses/admin/details/${matchingCourse._id}`, { token }).catch(() => null);
    const lessonEntry = detail ? collectLessons(detail).find((entry) => String(entry.lesson?.title || '').startsWith(fixturePrefix)) : null;
    if (lessonEntry?.lesson?.id) {
      resolvedCourseId = String(matchingCourse._id);
      resolvedLessonId = String(lessonEntry.lesson.id);
      await waitForFixtureLesson(token, resolvedCourseId, resolvedLessonId);
      return {
        courseId: resolvedCourseId,
        lessonId: resolvedLessonId,
        lessonTitle: String(lessonEntry.lesson.title || 'QA lesson'),
        courseTitle: String(matchingCourse.title || 'QA course'),
        sourceVideoPath: '',
      };
    }
  }

  const sourceVideoPath = await pickFixtureVideoPath();
  const fixtureStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const courseTitle = `${fixturePrefix} ${fixtureStamp}`;
  const lessonTitle = `${fixturePrefix} Lesson`;
  const coursePayload = {
    title: courseTitle,
    description: 'Auto-generated QA fixture for mobile playback controls verification.',
    category: 'QA',
    exam: 'QA',
    subject: 'Playback',
    level: 'QA Course',
    price: 1,
    validityDays: 30,
    instructor: 'QA Automation',
    modules: [{
      id: fixtureModuleId,
      title: 'QA Playback Module',
      description: 'Auto-generated playback module',
      lessons: [],
      chapters: [],
    }],
  };
  const createdCourse = await fetchJson<Record<string, any>>('/backend/api/courses', {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(coursePayload),
  });
  const videoBuffer = await fs.readFile(sourceVideoPath);
  const form = new FormData();
  form.append('lessonTitle', lessonTitle);
  form.append('lessonType', 'private-video');
  form.append('durationMinutes', '5');
  form.append('moduleName', 'QA Playback Module');
  form.append('moduleDescription', 'Auto-generated playback module');
  form.append('isPremium', 'false');
  form.append('video', new Blob([videoBuffer], { type: 'video/mp4' }), path.basename(sourceVideoPath));
  const uploadResult = await fetchJson<Record<string, any>>(`/backend/api/courses/${createdCourse._id}/modules/${fixtureModuleId}/videos`, {
    method: 'POST',
    token,
    body: form,
  });
  const uploadedLessonId = String(uploadResult?.video?.id || '');
  if (!uploadedLessonId) {
    throw new Error('Fixture video upload did not return a lesson id.');
  }
  resolvedCourseId = String(createdCourse._id);
  resolvedLessonId = uploadedLessonId;
  await waitForFixtureLesson(token, resolvedCourseId, resolvedLessonId);
  return {
    courseId: resolvedCourseId,
    lessonId: resolvedLessonId,
    lessonTitle,
    courseTitle,
    sourceVideoPath,
  };
};

const clickBySelector = async (page: puppeteer.Page, selector: string, timeoutMs = 30_000) => {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  const handles = await page.$$(selector);
  for (const element of handles) {
    const visible = await element.evaluate((target) => {
      const rect = target.getBoundingClientRect();
      const style = window.getComputedStyle(target);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.bottom >= 0
        && rect.right >= 0
        && rect.top <= window.innerHeight
        && rect.left <= window.innerWidth;
    });
    if (!visible) {
      continue;
    }
    const rect = await element.evaluate((target) => {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const nextRect = target.getBoundingClientRect();
      return {
        x: nextRect.x,
        y: nextRect.y,
        width: nextRect.width,
        height: nextRect.height,
      };
    });
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return;
  }
  throw new Error(`No visible element found for selector: ${selector}`);
};

const openLesson = async (
  page: puppeteer.Page,
  token: string,
  courseText: string,
  lessonText?: string,
  credentials?: { email: string; password: string },
) => {
  if (resolvedCourseId && resolvedLessonId) {
    const lessonUrl = withQaParams(`${config.baseUrl.replace(/\/$/, '')}/?tab=courses&courseId=${encodeURIComponent(resolvedCourseId)}&lessonId=${encodeURIComponent(resolvedLessonId)}`);
    await page.evaluateOnNewDocument((authToken, disableContentProtectionForQa) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
      if (disableContentProtectionForQa) {
        window.localStorage.setItem('edumaster.qa.disableContentProtection', 'true');
      }
    }, token, shouldDisableContentProtectionForQa);
    await gotoApp(page, lessonUrl);
    await page.waitForSelector(`${selectors.shellReady}, ${selectors.loginEmail}`, { timeout: 45_000 });
    if (await isVisibleSelector(page, selectors.loginEmail)) {
      if (!credentials) {
        throw new Error('Production auth token was not accepted by the browser.');
      }
      await page.type(selectors.loginEmail, credentials.email);
      await page.type(selectors.loginPassword, credentials.password);
      await clickBySelector(page, selectors.loginSubmit);
      await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
      await gotoApp(page, lessonUrl);
    }
    await page.waitForSelector(`${selectors.courseLessonView}, ${selectors.coursePlayerFullscreen}`, { timeout: 30_000 });
    await page.waitForSelector(playerVideoSelector, { timeout: 30_000 });
    await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      void video?.play?.().catch(() => undefined);
    }, playerVideoSelector);
    await page.waitForFunction(
      (videoSelector) => {
        const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
        if (!video) {
          return false;
        }
        return video.readyState >= 3 || video.currentTime > 0 || Boolean(video.error);
      },
      { timeout: Number(process.env.QA_PLAYER_WAIT_MS || 15_000) },
      playerVideoSelector,
    ).catch(() => undefined);
    await sleep(1_000);
    return;
  }

  await page.evaluateOnNewDocument((authToken, disableContentProtectionForQa) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
    if (disableContentProtectionForQa) {
      window.localStorage.setItem('edumaster.qa.disableContentProtection', 'true');
    }
  }, token, shouldDisableContentProtectionForQa);
  await gotoApp(page, withQaParams(config.baseUrl));
  await page.waitForSelector(`${selectors.shellReady}, ${selectors.loginEmail}`, { timeout: 45_000 });

  if (await isVisibleSelector(page, selectors.loginEmail)) {
    if (!credentials) {
      throw new Error('Production auth token was not accepted by the browser.');
    }
    await page.type(selectors.loginEmail, credentials.email);
    await page.type(selectors.loginPassword, credentials.password);
    await clickBySelector(page, selectors.loginSubmit);
    await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
  }

  await clickBySelector(page, [
    selectors.navCourses,
    selectors.mobileNavCourses,
    selectors.mobileTabCourses,
  ].join(', '));
  await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
  const openedCourse = await page.evaluate((cardSelector, expectedText) => {
    const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(expectedText.toLowerCase())) || cards[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, courseText);
  if (!openedCourse) {
    throw new Error('No course card was available.');
  }

  await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
  await page.waitForSelector(`${selectors.courseLessonOpen}, ${selectors.courseChapterToggle}`, { timeout: 30_000 });
  const locateLesson = async () => page.evaluate((lessonSelector, expectedText) => {
    const lessons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const expected = String(expectedText || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[–—-]+/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const target = lessons.find((lesson) => {
      const normalized = (lesson.textContent || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return expected ? normalized.includes(expected) || expected.includes(normalized) : true;
    }) || lessons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return {
      clicked: Boolean(target),
      candidates: lessons.map((lesson) => (lesson.textContent || '').trim()).filter(Boolean),
    };
  }, selectors.courseLessonOpen, lessonText || '');
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
    throw new Error(`No lesson button was available. Visible lesson entries: ${lessonLookup.candidates.join(' | ') || '(none)'}`);
  }

  await page.waitForSelector(`${selectors.courseLessonView}, ${selectors.coursePlayerFullscreen}`, { timeout: 30_000 });
  await page.waitForSelector(playerVideoSelector, { timeout: 30_000 });
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    void video?.play?.().catch(() => undefined);
  }, playerVideoSelector);
  await page.waitForFunction(
    (videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      if (!video) {
        return false;
      }
      return video.readyState >= 3 || video.currentTime > 0 || Boolean(video.error);
    },
    { timeout: Number(process.env.QA_PLAYER_WAIT_MS || 15_000) },
    playerVideoSelector,
  ).catch(() => undefined);
  await sleep(1_000);
};

const getDiagnostics = async (page: puppeteer.Page): Promise<PlayerDiagnostics> =>
  page.evaluate((playerSelector, videoSelector) => {
    const player = document.querySelector(playerSelector) as HTMLElement | null;
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    const playerRect = player?.getBoundingClientRect();
    const videoRect = video?.getBoundingClientRect();
    const bodyText = document.body?.innerText || '';
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fullscreenElement: document.fullscreenElement
        ? ((document.fullscreenElement as HTMLElement).dataset?.testid || document.fullscreenElement.tagName.toLowerCase())
        : null,
      playerRect: {
        x: playerRect?.x ?? 0,
        y: playerRect?.y ?? 0,
        width: playerRect?.width ?? 0,
        height: playerRect?.height ?? 0,
      },
      videoRect: {
        x: videoRect?.x ?? 0,
        y: videoRect?.y ?? 0,
        width: videoRect?.width ?? 0,
        height: videoRect?.height ?? 0,
      },
      visibleText: {
        reconnecting: /reconnecting/i.test(bodyText),
        unavailable: /unavailable|not available|could not/i.test(bodyText),
      },
      contentProtection: {
        overlayPresent: Boolean(document.querySelector('.app-content-protection-overlay')),
        message: document.querySelector('.app-content-protection-message')?.textContent?.trim() || null,
      },
      video: {
        currentTime: video?.currentTime ?? null,
        duration: Number.isFinite(video?.duration) ? video?.duration : null,
        readyState: video?.readyState ?? null,
        networkState: video?.networkState ?? null,
        error: video?.error ? {
          code: video.error.code,
          message: video.error.message,
        } : null,
      },
    };
  }, '[data-testid="course-figma-player"]', playerVideoSelector);

const assertPlayable = (label: string, diagnostics: PlayerDiagnostics) => {
  const ready = Number(diagnostics.video.readyState || 0) >= 3
    || Number(diagnostics.video.currentTime || 0) > 1;
  if (!ready || diagnostics.video.error || diagnostics.visibleText.reconnecting || diagnostics.visibleText.unavailable) {
    throw new Error(`${label} playback is not ready: ${JSON.stringify(diagnostics)}`);
  }
};

const assertFullscreenFit = (diagnostics: PlayerDiagnostics) => {
  const viewportArea = diagnostics.viewport.width * diagnostics.viewport.height;
  const videoArea = diagnostics.videoRect.width * diagnostics.videoRect.height;
  const coverage = viewportArea > 0 ? videoArea / viewportArea : 0;
  const widthCoverage = diagnostics.videoRect.width / Math.max(diagnostics.viewport.width, 1);
  if (!diagnostics.fullscreenElement || coverage < 0.55 || widthCoverage < 0.82) {
    throw new Error(`Fullscreen video is under-sized: ${JSON.stringify({ coverage, widthCoverage, diagnostics })}`);
  }
};

const revealPlayerControls = async (page: puppeteer.Page) => {
  await page.waitForSelector(playerVideoSelector, { timeout: 15_000 });
  const target = await page.$(playerVideoSelector);
  if (!target) {
    throw new Error('Player video element not found while revealing controls.');
  }
  const box = await target.boundingBox();
  if (!box) {
    throw new Error('Player video bounding box unavailable.');
  }
  const x = box.x + Math.min(box.width * 0.5, Math.max(box.width - 24, 16));
  const y = box.y + Math.min(box.height * 0.5, Math.max(box.height - 24, 16));
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await sleep(200);
};

const openPlayerSettingsMenu = async (page: puppeteer.Page) => {
  await revealPlayerControls(page);
  const alreadyOpen = await isVisibleSelector(page, selectors.coursePlayerSettingsPanel);
  if (alreadyOpen) {
    return;
  }
  await page.waitForSelector(selectors.coursePlayerSettingsTrigger, { timeout: 15_000 });
  await page.evaluate((selector) => {
    const button = document.querySelector(selector) as HTMLElement | null;
    button?.click();
  }, selectors.coursePlayerSettingsTrigger);
  await page.waitForFunction((selector) => {
    const panel = document.querySelector(selector) as HTMLElement | null;
    if (!panel) {
      return false;
    }
    const rect = panel.getBoundingClientRect();
    const style = window.getComputedStyle(panel);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && Number(style.opacity || 1) > 0;
  }, { timeout: 15_000 }, selectors.coursePlayerSettingsPanel);
};

const ensurePlaybackStarted = async (page: puppeteer.Page) => {
  await revealPlayerControls(page);
  const hasAdvanced = await page.waitForFunction((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    return Boolean(
      video
      && !video.paused
      && (
        video.readyState >= 2
        || video.currentTime > 0.25
      ),
    );
  }, { timeout: 4_000 }, playerVideoSelector).then(() => true).catch(() => false);

  if (hasAdvanced) {
    return;
  }

  await page.evaluate((toggleSelector, videoSelector) => {
    const toggle = document.querySelector(toggleSelector) as HTMLElement | null;
    toggle?.click();
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    void video?.play?.().catch(() => undefined);
  }, selectors.coursePlayerToggle, playerVideoSelector);

  await page.waitForFunction((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    return Boolean(
      video
      && !video.paused
      && (
        video.readyState >= 2
        || video.currentTime > 0.25
      ),
    );
  }, { timeout: 12_000 }, playerVideoSelector);
};

const openSettingsSubmenu = async (page: puppeteer.Page, triggerSelector: string, viewTestId: string) => {
  await page.waitForSelector(triggerSelector, { timeout: 15_000 });
  await page.evaluate((selector) => {
    const button = document.querySelector(selector) as HTMLElement | null;
    button?.click();
  }, triggerSelector);
  await page.waitForFunction((selector) => {
    const panel = document.querySelector(selector) as HTMLElement | null;
    if (!panel) {
      return false;
    }
    const rect = panel.getBoundingClientRect();
    const style = window.getComputedStyle(panel);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && Number(style.opacity || 1) > 0;
  }, { timeout: 15_000 }, `[data-testid="${viewTestId}"]`);
};

const clickSettingsOption = async (page: puppeteer.Page, selector: string) => {
  await page.waitForSelector(selector, { timeout: 15_000 });
  await page.evaluate((targetSelector) => {
    const button = document.querySelector(targetSelector) as HTMLElement | null;
    button?.scrollIntoView({ block: 'center', inline: 'nearest' });
    button?.click();
  }, selector);
  await sleep(350);
};

const returnToRootSettingsMenu = async (page: puppeteer.Page) => {
  await page.waitForSelector(selectors.coursePlayerSettingsBack, { timeout: 15_000 });
  await page.evaluate((selector) => {
    const button = document.querySelector(selector) as HTMLElement | null;
    button?.click();
  }, selectors.coursePlayerSettingsBack);
  await page.waitForFunction((selector) => {
    const panel = document.querySelector(selector) as HTMLElement | null;
    if (!panel) {
      return false;
    }
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, { timeout: 15_000 }, '[data-testid="course-player-settings-view-root"]');
};

const getCourseUiState = async (page: puppeteer.Page): Promise<CourseUiState> =>
  page.evaluate((controlsSelector, speedSelector, qualitySelector, settingsTriggerSelector, settingsPanelSelector, speedTriggerSelector, qualityTriggerSelector, settingsBodySelector, qualityStatusSelector) => {
    const controls = document.querySelector(controlsSelector) as HTMLElement | null;
    const speedSelect = document.querySelector(speedSelector) as HTMLElement | null;
    const qualitySelect = document.querySelector(qualitySelector) as HTMLElement | null;
    const settingsTrigger = document.querySelector(settingsTriggerSelector) as HTMLElement | null;
    const settingsPanel = document.querySelector(settingsPanelSelector) as HTMLElement | null;
    const speedTrigger = document.querySelector(speedTriggerSelector) as HTMLElement | null;
    const qualityTrigger = document.querySelector(qualityTriggerSelector) as HTMLElement | null;
    const settingsBody = document.querySelector(settingsBodySelector) as HTMLElement | null;
    const qualityStatus = document.querySelector(qualityStatusSelector) as HTMLElement | null;
    const controlsRect = controls?.getBoundingClientRect();
    const controlsStyle = controls ? window.getComputedStyle(controls) : null;
    const settingsTriggerRect = settingsTrigger?.getBoundingClientRect();
    const settingsPanelRect = settingsPanel?.getBoundingClientRect();
    const speedTriggerRect = speedTrigger?.getBoundingClientRect();
    const qualityTriggerRect = qualityTrigger?.getBoundingClientRect();
    const settingsTriggerStyle = settingsTrigger ? window.getComputedStyle(settingsTrigger) : null;
    const settingsPanelStyle = settingsPanel ? window.getComputedStyle(settingsPanel) : null;
    const speedTriggerStyle = speedTrigger ? window.getComputedStyle(speedTrigger) : null;
    const qualityTriggerStyle = qualityTrigger ? window.getComputedStyle(qualityTrigger) : null;
    const speedOptions = Array.from((speedSelect as HTMLSelectElement | null)?.options || [])
      .map((option) => (option.textContent || option.value || '').trim())
      .filter(Boolean);
    const qualityOptions = Array.from((qualitySelect as HTMLSelectElement | null)?.options || [])
      .map((option) => (option.textContent || option.value || '').trim())
      .filter(Boolean);
    return {
      speedOptions,
      qualityOptions,
      controlsVisible: Boolean(
        controls
        && controlsRect
        && controlsStyle
        && controlsRect.width > 0
        && controlsRect.height > 0
        && controlsStyle.visibility !== 'hidden'
        && controlsStyle.display !== 'none'
        && Number(controlsStyle.opacity || 1) > 0,
      ),
      settingsTriggerVisible: Boolean(
        settingsTrigger
        && settingsTriggerRect
        && settingsTriggerStyle
        && settingsTriggerRect.width > 0
        && settingsTriggerRect.height > 0
        && settingsTriggerStyle.visibility !== 'hidden'
        && settingsTriggerStyle.display !== 'none'
        && Number(settingsTriggerStyle.opacity || 1) > 0,
      ),
      settingsPanelVisible: Boolean(
        settingsPanel
        && settingsPanelRect
        && settingsPanelStyle
        && settingsPanelRect.width > 0
        && settingsPanelRect.height > 0
        && settingsPanelStyle.visibility !== 'hidden'
        && settingsPanelStyle.display !== 'none'
        && Number(settingsPanelStyle.opacity || 1) > 0,
      ),
      speedTriggerVisible: Boolean(
        speedTrigger
        && speedTriggerRect
        && speedTriggerStyle
        && speedTriggerRect.width > 0
        && speedTriggerRect.height > 0
        && speedTriggerStyle.visibility !== 'hidden'
        && speedTriggerStyle.display !== 'none'
        && Number(speedTriggerStyle.opacity || 1) > 0,
      ),
      qualityTriggerVisible: Boolean(
        qualityTrigger
        && qualityTriggerRect
        && qualityTriggerStyle
        && qualityTriggerRect.width > 0
        && qualityTriggerRect.height > 0
        && qualityTriggerStyle.visibility !== 'hidden'
        && qualityTriggerStyle.display !== 'none'
        && Number(qualityTriggerStyle.opacity || 1) > 0,
      ),
      playerFormat: controls?.dataset.playerFormat || null,
      playerDeliveryPath: controls?.dataset.playerDeliveryPath || null,
      playerQualityCount: controls?.dataset.playerQualityCount ? Number(controls.dataset.playerQualityCount) : null,
      qualitySelectionSupported: controls?.dataset.playerQualitySupported === 'true',
      settingsBodyScrollable: Boolean(
        settingsBody
        && (settingsBody.scrollHeight > settingsBody.clientHeight || settingsBody.dataset.scrollable === 'true'),
      ),
      qualityStatusText: (qualityStatus?.textContent || '').trim() || null,
    };
  }, selectors.coursePlayerControls, selectors.coursePlayerSpeed, selectors.coursePlayerQuality, selectors.coursePlayerSettingsTrigger, selectors.coursePlayerSettingsPanel, selectors.coursePlayerSpeedTrigger, selectors.coursePlayerQualityTrigger, selectors.coursePlayerSettingsBody, selectors.coursePlayerQualityStatus);

const assertCourseUiState = (label: string, state: CourseUiState) => {
  if (!state.controlsVisible) {
    throw new Error(`${label} playback controls are not visible.`);
  }
  if (!state.settingsTriggerVisible) {
    throw new Error(`${label} settings trigger is not visible.`);
  }
  if (!state.settingsPanelVisible) {
    throw new Error(`${label} settings panel is not visible.`);
  }
  if (!state.speedOptions.some((option) => option === '1.5x')) {
    throw new Error(`${label} player speed options are missing 1.5x: ${state.speedOptions.join(', ') || '(none)'}`);
  }
  if (!state.speedOptions.some((option) => option === '2x')) {
    throw new Error(`${label} player speed options are missing 2x: ${state.speedOptions.join(', ') || '(none)'}`);
  }
  if (!state.settingsBodyScrollable) {
    throw new Error(`${label} settings sheet is not scroll-ready.`);
  }
};

const probePlaybackControls = async (
  page: puppeteer.Page,
  speedValue: string,
  qualityValue?: string,
): Promise<PlaybackControlProbe> =>
  page.evaluate((videoSelector, speedSelector, qualitySelector, nextSpeedValue, nextQualityValue) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    const speedSelect = document.querySelector(speedSelector) as HTMLSelectElement | null;
    const qualitySelect = document.querySelector(qualitySelector) as HTMLSelectElement | null;

    if (speedSelect) {
      speedSelect.value = nextSpeedValue;
      speedSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (qualitySelect && nextQualityValue) {
      qualitySelect.value = nextQualityValue;
      qualitySelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return {
      selectedSpeed: speedSelect?.value || null,
      playbackRate: video?.playbackRate ?? null,
      selectedQuality: qualitySelect?.value || null,
      availableQualities: Array.from(qualitySelect?.options || []).map((option) => (option.textContent || option.value || '').trim()).filter(Boolean),
    };
  }, playerVideoSelector, selectors.coursePlayerSpeed, selectors.coursePlayerQuality, speedValue, qualityValue);

const toSpeedOptionSelector = (speedValue: string) => `[data-testid="course-player-speed-option-${speedValue.replace(/\./g, '_')}"]`;
const toQualityOptionSelector = (qualityValue: string) => `[data-testid="course-player-quality-option-${qualityValue.replace(/\./g, '_')}"]`;

const clickFullscreenControl = async (page: puppeteer.Page) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = await page.evaluate((selector) => {
      const buttons = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible = rect.width > 0
          && rect.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && rect.bottom >= 0
          && rect.right >= 0
          && rect.top <= window.innerHeight
          && rect.left <= window.innerWidth;
        if (visible) {
          return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          };
        }
      }
      return null;
    }, selectors.coursePlayerFullscreen);

    if (!target) {
      await clickBySelector(page, selectors.coursePlayerFullscreen);
    } else {
      await page.mouse.move(target.x, target.y);
      await page.mouse.down();
      await page.mouse.up();
    }

    const entered = await page.waitForFunction(
      () => Boolean(document.fullscreenElement),
      { timeout: 2_000 },
    ).then(() => true).catch(() => false);
    if (entered) {
      return;
    }
  }

  throw new Error('Fullscreen control did not enter browser fullscreen after 3 real click attempts.');
};

const captureDebugState = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, 'course-player-review', label, 'png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const sourcePath = artifactPath(ctx.sourceDir, 'course-player-review', label, 'html');
  await fs.writeFile(sourcePath, await page.content().catch(() => ''), 'utf8').catch(() => undefined);
  return { screenshotPath, sourcePath };
};

const captureStepScreenshot = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, 'course-player-review', label, 'png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  return screenshotPath;
};

const main = async () => {
  const env = await readEnvFile();
  const email = process.env.QA_LOGIN_EMAIL || process.env.ADMIN_EMAIL || env.ADMIN_EMAIL || config.loginEmail;
  const password = process.env.QA_LOGIN_PASSWORD || process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || config.loginPassword;
  const mobileEmail = process.env.QA_MOBILE_LOGIN_EMAIL || email;
  const mobilePassword = process.env.QA_MOBILE_LOGIN_PASSWORD || password;
  const courseText = process.env.QA_COURSE_TEXT || 'SSC';
  const lessonText = process.env.QA_LESSON_TEXT || '';
  if (!email || !password || !mobileEmail || !mobilePassword) {
    throw new Error('QA_LOGIN_EMAIL/QA_LOGIN_PASSWORD and optional QA_MOBILE_LOGIN_EMAIL/QA_MOBILE_LOGIN_PASSWORD are required.');
  }

  const ctx = await createRunContext();
  const desktopToken = await loginForToken(email, password, 'QA Fullscreen Desktop Review');
  const fixtureTarget = await ensureFixtureTarget(desktopToken);
  const summary: Record<string, unknown> = {
    ok: false,
    baseUrl: config.baseUrl,
    courseText: fixtureTarget.courseTitle || courseText,
    lessonText: fixtureTarget.lessonTitle || lessonText,
    resolvedTarget: {
      courseId: fixtureTarget.courseId,
      lessonId: fixtureTarget.lessonId,
      sourceVideoPath: fixtureTarget.sourceVideoPath || null,
    },
    screenshots: {},
    diagnostics: {},
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    networkErrors: [] as Array<{ status: number; url: string }>,
  };
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

  try {
    const desktopPage = await browser.newPage();
    desktopPage.on('console', (message) => {
      if (message.type() === 'error') {
        (summary.consoleErrors as string[]).push(`[desktop] ${message.text()}`);
      }
    });
    desktopPage.on('pageerror', (error) => {
      (summary.pageErrors as string[]).push(`[desktop] ${error instanceof Error ? error.message : String(error)}`);
    });
    desktopPage.on('response', (response) => {
      if (response.status() >= 400) {
        (summary.networkErrors as Array<{ status: number; url: string }>).push({
          status: response.status(),
          url: response.url(),
        });
      }
    });
    await desktopPage.setViewport({ width: 2000, height: 1300 });
    try {
      await openLesson(desktopPage, desktopToken, courseText, lessonText, { email, password });
    } catch (error) {
      await captureDebugState(desktopPage, ctx, 'desktop-open-failure');
      throw error;
    }
    await ensurePlaybackStarted(desktopPage);
    const desktopPath = await captureStepScreenshot(desktopPage, ctx, 'desktop-before-controls');
    const desktopDiagnostics = await getDiagnostics(desktopPage);
    await openPlayerSettingsMenu(desktopPage);
    const desktopUiState = await getCourseUiState(desktopPage);
    assertPlayable('desktop', desktopDiagnostics);
    assertCourseUiState('desktop', desktopUiState);
    await openSettingsSubmenu(desktopPage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await returnToRootSettingsMenu(desktopPage);
    if (desktopUiState.qualityTriggerVisible && desktopUiState.qualitySelectionSupported) {
      await openSettingsSubmenu(desktopPage, selectors.coursePlayerQualityTrigger, 'course-player-settings-view-quality');
      await returnToRootSettingsMenu(desktopPage);
    }
    await openPlayerSettingsMenu(desktopPage);
    await openSettingsSubmenu(desktopPage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await clickSettingsOption(desktopPage, toSpeedOptionSelector('1.5'));
    const desktopProbe15 = await probePlaybackControls(desktopPage, '1.5');
    if (Math.abs(Number(desktopProbe15.playbackRate || 0) - 1.5) > 0.05) {
      throw new Error(`desktop playback rate did not switch to 1.5x: ${JSON.stringify(desktopProbe15)}`);
    }
    const desktopSpeed15Path = await captureStepScreenshot(desktopPage, ctx, 'desktop-speed-1-5x');
    await openPlayerSettingsMenu(desktopPage);
    await openSettingsSubmenu(desktopPage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await clickSettingsOption(desktopPage, toSpeedOptionSelector('2'));
    const desktopProbe20 = await probePlaybackControls(desktopPage, '2');
    if (Math.abs(Number(desktopProbe20.playbackRate || 0) - 2) > 0.05) {
      throw new Error(`desktop playback rate did not switch to 2x: ${JSON.stringify(desktopProbe20)}`);
    }
    const desktopSpeed20Path = await captureStepScreenshot(desktopPage, ctx, 'desktop-speed-2x');
    let desktopQualityChangePath: string | null = null;
    let desktopQualityProbe: PlaybackControlProbe | null = null;
    if (desktopUiState.qualityTriggerVisible && desktopUiState.qualitySelectionSupported) {
      await openPlayerSettingsMenu(desktopPage);
      const desktopAlternateQuality = await desktopPage.$eval(selectors.coursePlayerQuality, (element) => {
        const select = element as HTMLSelectElement;
        return Array.from(select.options).map((option) => option.value).find((value) => value !== select.value) || null;
      }).catch(() => null);
      if (desktopAlternateQuality) {
        await openSettingsSubmenu(desktopPage, selectors.coursePlayerQualityTrigger, 'course-player-settings-view-quality');
        await clickSettingsOption(desktopPage, toQualityOptionSelector(desktopAlternateQuality));
        desktopQualityProbe = await probePlaybackControls(desktopPage, '2', desktopAlternateQuality);
        desktopQualityChangePath = await captureStepScreenshot(desktopPage, ctx, 'desktop-quality-change');
      }
    }

    await clickFullscreenControl(desktopPage);
    await sleep(2_000);
    const fullscreenDiagnostics = await getDiagnostics(desktopPage);
    assertPlayable('fullscreen', fullscreenDiagnostics);
    assertFullscreenFit(fullscreenDiagnostics);
    const fullscreenPath = artifactPath(ctx.screenshotDir, 'course-player-review', 'fullscreen', 'png');
    await desktopPage.screenshot({ path: fullscreenPath, fullPage: false });

    await desktopPage.close();

    const mobileToken = await loginForToken(mobileEmail, mobilePassword, 'QA Fullscreen Mobile Review');
    const mobilePage = await browser.newPage();
    mobilePage.on('console', (message) => {
      if (message.type() === 'error') {
        (summary.consoleErrors as string[]).push(`[mobile] ${message.text()}`);
      }
    });
    mobilePage.on('pageerror', (error) => {
      (summary.pageErrors as string[]).push(`[mobile] ${error instanceof Error ? error.message : String(error)}`);
    });
    mobilePage.on('response', (response) => {
      if (response.status() >= 400) {
        (summary.networkErrors as Array<{ status: number; url: string }>).push({
          status: response.status(),
          url: response.url(),
        });
      }
    });
    await mobilePage.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await mobilePage.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    try {
      await openLesson(mobilePage, mobileToken, courseText, lessonText, { email: mobileEmail, password: mobilePassword });
    } catch (error) {
      await captureDebugState(mobilePage, ctx, 'mobile-open-failure');
      throw error;
    }
    await ensurePlaybackStarted(mobilePage);
    const mobilePath = await captureStepScreenshot(mobilePage, ctx, 'mobile-before-controls');
    const mobileDiagnostics = await getDiagnostics(mobilePage);
    await openPlayerSettingsMenu(mobilePage);
    const mobileUiState = await getCourseUiState(mobilePage);
    assertPlayable('mobile', mobileDiagnostics);
    assertCourseUiState('mobile', mobileUiState);
    await openSettingsSubmenu(mobilePage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await returnToRootSettingsMenu(mobilePage);
    if (mobileUiState.qualityTriggerVisible && mobileUiState.qualitySelectionSupported) {
      await openSettingsSubmenu(mobilePage, selectors.coursePlayerQualityTrigger, 'course-player-settings-view-quality');
      await returnToRootSettingsMenu(mobilePage);
    }
    if (mobileDiagnostics.videoRect.width < 300 || mobileDiagnostics.videoRect.height < 160) {
      throw new Error(`Mobile video is under-sized: ${JSON.stringify(mobileDiagnostics)}`);
    }
    await openPlayerSettingsMenu(mobilePage);
    await openSettingsSubmenu(mobilePage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await clickSettingsOption(mobilePage, toSpeedOptionSelector('1.5'));
    const mobileProbe15 = await probePlaybackControls(mobilePage, '1.5');
    if (Math.abs(Number(mobileProbe15.playbackRate || 0) - 1.5) > 0.05) {
      throw new Error(`mobile playback rate did not switch to 1.5x: ${JSON.stringify(mobileProbe15)}`);
    }
    const mobileSpeed15Path = await captureStepScreenshot(mobilePage, ctx, 'mobile-speed-1-5x');
    await openPlayerSettingsMenu(mobilePage);
    await openSettingsSubmenu(mobilePage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await clickSettingsOption(mobilePage, toSpeedOptionSelector('2'));
    const mobileProbe20 = await probePlaybackControls(mobilePage, '2');
    if (Math.abs(Number(mobileProbe20.playbackRate || 0) - 2) > 0.05) {
      throw new Error(`mobile playback rate did not switch to 2x: ${JSON.stringify(mobileProbe20)}`);
    }
    const mobileSpeed20Path = await captureStepScreenshot(mobilePage, ctx, 'mobile-speed-2x');
    let mobileQualityChangePath: string | null = null;
    let mobileQualityProbe: PlaybackControlProbe | null = null;
    if (mobileUiState.qualityTriggerVisible && mobileUiState.qualitySelectionSupported) {
      await openPlayerSettingsMenu(mobilePage);
      const mobileAlternateQuality = await mobilePage.$eval(selectors.coursePlayerQuality, (element) => {
        const select = element as HTMLSelectElement;
        return Array.from(select.options).map((option) => option.value).find((value) => value !== select.value) || null;
      }).catch(() => null);
      if (mobileAlternateQuality) {
        await openSettingsSubmenu(mobilePage, selectors.coursePlayerQualityTrigger, 'course-player-settings-view-quality');
        await clickSettingsOption(mobilePage, toQualityOptionSelector(mobileAlternateQuality));
        mobileQualityProbe = await probePlaybackControls(mobilePage, '2', mobileAlternateQuality);
        mobileQualityChangePath = await captureStepScreenshot(mobilePage, ctx, 'mobile-quality-change');
      }
    }
    await clickFullscreenControl(mobilePage);
    await sleep(2_000);
    await openPlayerSettingsMenu(mobilePage);
    const mobileFullscreenDiagnostics = await getDiagnostics(mobilePage);
    const mobileFullscreenUiState = await getCourseUiState(mobilePage);
    assertPlayable('mobile-fullscreen', mobileFullscreenDiagnostics);
    assertFullscreenFit(mobileFullscreenDiagnostics);
    assertCourseUiState('mobile-fullscreen', mobileFullscreenUiState);
    await openSettingsSubmenu(mobilePage, selectors.coursePlayerSpeedTrigger, 'course-player-settings-view-speed');
    await returnToRootSettingsMenu(mobilePage);
    if (mobileFullscreenUiState.qualityTriggerVisible && mobileFullscreenUiState.qualitySelectionSupported) {
      await openSettingsSubmenu(mobilePage, selectors.coursePlayerQualityTrigger, 'course-player-settings-view-quality');
      await returnToRootSettingsMenu(mobilePage);
    }
    const mobileFullscreenPath = artifactPath(ctx.screenshotDir, 'course-player-review', 'mobile-fullscreen', 'png');
    await mobilePage.screenshot({ path: mobileFullscreenPath, fullPage: false });
    await mobilePage.close();

    Object.assign(summary, {
      ok: true,
      notes: [
        desktopDiagnostics.contentProtection.overlayPresent || mobileDiagnostics.contentProtection.overlayPresent
          ? 'Screenshots may appear black because app content-protection overlay is active. DOM/media-state probes are the source of truth for this run.'
          : 'Screenshots and DOM/media-state probes were both available for this run.',
      ],
      screenshots: {
        desktopBeforeControls: desktopPath,
        desktopSpeed15x: desktopSpeed15Path,
        desktopSpeed2x: desktopSpeed20Path,
        desktopQualityChange: desktopQualityChangePath,
        fullscreen: fullscreenPath,
        mobileBeforeControls: mobilePath,
        mobileSpeed15x: mobileSpeed15Path,
        mobileSpeed2x: mobileSpeed20Path,
        mobileQualityChange: mobileQualityChangePath,
        mobileFullscreen: mobileFullscreenPath,
      },
      diagnostics: {
        desktop: desktopDiagnostics,
        fullscreen: fullscreenDiagnostics,
        mobile: mobileDiagnostics,
        mobileFullscreen: mobileFullscreenDiagnostics,
      },
      uiState: {
        desktop: desktopUiState,
        mobile: mobileUiState,
        mobileFullscreen: mobileFullscreenUiState,
      },
      playbackProbes: {
        desktop: {
          speed15x: desktopProbe15,
          speed2x: desktopProbe20,
          qualityChange: desktopQualityProbe,
        },
        mobile: {
          speed15x: mobileProbe15,
          speed2x: mobileProbe20,
          qualityChange: mobileQualityProbe,
        },
      },
    });
    await writeJson(path.join(ctx.analysisDir, 'course-player-fullscreen-mobile-review.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await writeJson(path.join(ctx.analysisDir, 'course-player-fullscreen-mobile-review-failure.json'), {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
