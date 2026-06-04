import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core';
import { config } from './config.js';
import {
  assignDeviceClass,
  assignMixedJourneyPersona,
  assignVideoViewerPersona,
  describeMixedJourneyPersona,
  describeVideoPersona,
  type DeviceClass,
  type MixedJourneyPersona,
  type VideoViewerPersona,
} from './browser-load-personas.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
  deviceClass?: DeviceClass;
  journeyPersona?: MixedJourneyPersona;
  videoPersona?: VideoViewerPersona;
  shardId?: string | null;
};

type MixedJourneyResult = {
  viewerId: number;
  email: string;
  viewport: DeviceClass;
  journeyPersona: MixedJourneyPersona;
  journeyDescription: string;
  videoPersona: VideoViewerPersona | null;
  videoPersonaDescription: string | null;
  shardId: string | null;
  ok: boolean;
  stage: number;
  screenshots: string[];
  timingsMs: Record<string, number | null>;
  consoleErrors: string[];
  pageErrors: string[];
  failureClassification: 'route_failure' | 'playback_failure' | 'auth_failure' | 'write_failure' | 'unknown' | null;
  error?: string;
};

type MixedStageSummary = {
  viewers: number;
  workerLabel: string;
  shardId: string | null;
  startedAt: string;
  completedAt?: string;
  ok: boolean;
  successCount: number;
  failureCount: number;
  journeyBreakdown: Record<MixedJourneyPersona, number>;
  failureBreakdown: Record<string, number>;
  resultsPath: string;
  artifactManifestPath: string;
  screenshotDir: string;
};

type MixedRunSummary = {
  baseUrl: string;
  manifestPath: string;
  courseId: string;
  lessonId: string;
  stages: MixedStageSummary[];
  workerLabel: string;
  shardId: string | null;
  overallOk: boolean;
};

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || config.baseUrl).replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const manifestPath = process.env.PLATFORM_LOAD_USERS_FILE || process.env.COURSE_LOAD_USERS_FILE || '';
const courseId = String(process.env.QA_COURSE_ID || process.env.PLATFORM_LOAD_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2').trim();
const lessonId = String(process.env.QA_LESSON_ID || process.env.PLATFORM_LOAD_LESSON_ID || 'video_1780146736089_8d3b641cf7').trim();
const courseText = String(process.env.QA_COURSE_TEXT || 'SSC').trim();
const lessonText = String(process.env.QA_LESSON_TEXT || 'INTRODUCTION').trim();
const preparedUserPassword = String(process.env.PLATFORM_LOAD_USER_PASSWORD || process.env.QA_LOGIN_PASSWORD || 'Student@123').trim();
const stageViewerCounts = String(process.env.QA_MIXED_BROWSER_STAGES || process.env.PLATFORM_LADDER_STAGES || '250,500,1000,1500,2000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const stageConcurrencyCap = Math.max(1, Number(process.env.QA_MIXED_BROWSER_STAGE_CONCURRENCY || 50));
const mobileRatio = Math.max(0, Math.min(1, Number(process.env.QA_MIXED_BROWSER_MOBILE_RATIO || 0.4)));
const screenshotSample = Math.max(1, Number(process.env.QA_MIXED_BROWSER_SCREENSHOT_SAMPLE || 5));
const screenshotAllViewers = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_MIXED_BROWSER_SCREENSHOT_ALL || '').toLowerCase());
const watchWindowMs = Math.max(10_000, Number(process.env.QA_MIXED_BROWSER_WATCH_WINDOW_MS || 25_000));
const forceLoginRefresh = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_MIXED_BROWSER_FORCE_LOGIN_REFRESH || '').toLowerCase());
const fullPageScreenshots = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_BROWSER_FULL_PAGE_SCREENSHOTS || '').toLowerCase());
const workerLabel = String(process.env.QA_BROWSER_WORKER_LABEL || process.env.HOSTNAME || 'local-worker').trim() || 'local-worker';
const shardId = String(process.env.QA_BROWSER_SHARD_ID || '').trim() || null;
const preparedSessionTokenCache = new Map<string, string>();

const journeyBreakdownTemplate = (): Record<MixedJourneyPersona, number> => ({
  browse_read: 0,
  video_active: 0,
  auth_session: 0,
  light_write: 0,
});

const shouldCaptureViewerScreenshots = (viewerId: number) =>
  screenshotAllViewers || viewerId <= screenshotSample;

const selectStageUsers = <T>(users: T[], viewers: number) => {
  if (viewers >= users.length) {
    return users.slice(0, viewers);
  }
  if (viewers <= 1) {
    return users.slice(0, viewers);
  }

  const selected: T[] = [];
  const usedIndexes = new Set<number>();
  const maxIndex = users.length - 1;
  for (let ordinal = 0; ordinal < viewers; ordinal += 1) {
    const rawIndex = Math.round((ordinal * maxIndex) / (viewers - 1));
    let index = Math.max(0, Math.min(maxIndex, rawIndex));
    while (usedIndexes.has(index) && index < maxIndex) {
      index += 1;
    }
    while (usedIndexes.has(index) && index > 0) {
      index -= 1;
    }
    if (usedIndexes.has(index)) {
      continue;
    }
    usedIndexes.add(index);
    selected.push(users[index]);
  }

  if (selected.length === viewers) {
    return selected;
  }

  for (let index = 0; index < users.length && selected.length < viewers; index += 1) {
    if (usedIndexes.has(index)) {
      continue;
    }
    usedIndexes.add(index);
    selected.push(users[index]);
  }

  return selected;
};

const loadUsers = async () => {
  if (!manifestPath) {
    throw new Error('PLATFORM_LOAD_USERS_FILE or COURSE_LOAD_USERS_FILE is required.');
  }
  const users = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PreparedUser[];
  if (!Array.isArray(users) || !users.length) {
    throw new Error(`Prepared user manifest is empty: ${manifestPath}`);
  }
  return users.map((user, index) => {
    const stableOrdinal = Number.isFinite(Number(user.index)) ? Number(user.index) : index;
    return ({
    ...user,
    deviceClass: user.deviceClass || assignDeviceClass(stableOrdinal, mobileRatio),
    journeyPersona: user.journeyPersona || assignMixedJourneyPersona(stableOrdinal),
    videoPersona: user.videoPersona || assignVideoViewerPersona(stableOrdinal),
    shardId: user.shardId || shardId,
    });
  });
};

const loginPreparedUser = async (email: string, viewerId: number) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: preparedUserPassword,
      device: `QA Mixed Browser ${viewerId}`,
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(`Unable to refresh QA browser session for ${email}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return String(payload.token);
};

const ensurePreparedUserToken = async (user: PreparedUser, viewerId: number) => {
  const email = String(user.email || '').trim();
  const cachedToken = preparedSessionTokenCache.get(email);
  if (cachedToken && !forceLoginRefresh) {
    return cachedToken;
  }

  const candidateToken = !forceLoginRefresh ? String(user.token || '').trim() : '';
  if (candidateToken) {
    const response = await fetch(new URL('/backend/api/auth/session', apiOrigin), {
      headers: {
        authorization: `Bearer ${candidateToken}`,
      },
    }).catch(() => null);
    if (response?.ok) {
      preparedSessionTokenCache.set(email, candidateToken);
      return candidateToken;
    }
  }

  const freshToken = await loginPreparedUser(email, viewerId);
  preparedSessionTokenCache.set(email, freshToken);
  return freshToken;
};

const setPreparedSession = async (page: Page, token: string) => {
  await page.evaluateOnNewDocument((authToken) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
  }, token);
  await page.evaluate((authToken) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
  }, token).catch(() => undefined);
};

const hasAuthSessionFailure = (consoleErrors: string[]) =>
  consoleErrors.some((entry) => /status of 401/i.test(entry) && /auth\/session/i.test(entry));

const takeShot = async (page: Page, root: string, label: string) => {
  const target = artifactPath(root, 'browser-mixed-feature', label, 'png');
  await page.screenshot({ path: target, fullPage: fullPageScreenshots });
  return target;
};

const takeShotBestEffort = async (page: Page, root: string, label: string, warnings: string[]) => {
  try {
    return await takeShot(page, root, label);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return '';
  }
};

const waitForSelectorOptional = async (page: Page, selector: string, timeoutMs: number) => page
  .waitForSelector(selector, { timeout: timeoutMs })
  .then(() => true)
  .catch(() => false);

const gotoPage = async (page: Page, url: string) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout|ERR_ABORTED/i.test(message)) {
      throw error;
    }
    await page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete', { timeout: 15_000 }).catch(() => undefined);
  });
};

const loginIfNeeded = async (page: Page, email: string) => {
  const loginVisible = await waitForSelectorOptional(page, selectors.loginEmail, 12_000);
  if (!loginVisible) {
    return false;
  }
  await page.locator(selectors.loginEmail).fill(email);
  await page.locator(selectors.loginPassword).fill(preparedUserPassword);
  await page.locator(selectors.loginSubmit).click();
  await page.waitForSelector(`${selectors.shellReady}, ${selectors.courseFigmaPage}, ${selectors.overviewDashboard}, ${selectors.navCourses}`, {
    timeout: 45_000,
  });
  return true;
};

const clickVisible = async (page: Page, selectorList: string[], timeoutMs = 20_000) => {
  for (const selector of selectorList) {
    const visible = await waitForSelectorOptional(page, selector, timeoutMs);
    if (!visible) {
      continue;
    }
    await page.locator(selector).click().catch(() => undefined);
    return true;
  }
  return false;
};

const openCourseCard = async (page: Page, text: string) => {
  await page.waitForSelector(selectors.courseCatalogCard, { timeout: 30_000 });
  const clicked = await page.evaluate((selector, label) => {
    const cards = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(label.toLowerCase())) || cards[0];
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, text);
  if (!clicked) {
    throw new Error('No course card was available.');
  }
};

const openLessonCard = async (page: Page, text: string) => {
  await page.waitForSelector(selectors.courseLessonOpen, { timeout: 30_000 });
  const clicked = await page.evaluate((selector, label) => {
    const buttons = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    const target = buttons.find((button) => (button.textContent || '').toLowerCase().includes(label.toLowerCase())) || buttons[0];
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, text);
  if (!clicked) {
    throw new Error('No lesson entry was available.');
  }
};

const applyVideoSpeed = async (page: Page, speedValue: string) => {
  await page.evaluate((value, speedSelector) => {
    const select = document.querySelector(speedSelector) as HTMLSelectElement | null;
    const video = Array.from(document.querySelectorAll('video')).find(Boolean) as HTMLVideoElement | undefined;
    if (select && Array.from(select.options).some((option) => option.value === value)) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (video) {
      video.playbackRate = Number(value) || 1;
    }
  }, speedValue, selectors.coursePlayerSpeed);
  await sleep(400);
};

const applyVideoQuality = async (page: Page, strategy: 'highest' | 'lowest') => {
  await page.evaluate((qualitySelector, selectionStrategy) => {
    const select = document.querySelector(qualitySelector) as HTMLSelectElement | null;
    if (!select || select.options.length <= 1) {
      return;
    }
    const options = Array.from(select.options)
      .map((option) => ({
        value: option.value,
        numeric: Number(option.value || option.textContent || 0) || 0,
      }))
      .filter((option) => option.value);
    if (!options.length) {
      return;
    }
    options.sort((left, right) => left.numeric - right.numeric);
    const target = selectionStrategy === 'highest' ? options[options.length - 1] : options[0];
    select.value = target.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, selectors.coursePlayerQuality, strategy);
  await sleep(900);
};

const startPlayback = async (page: Page) => {
  await page.waitForSelector('video', { timeout: 45_000 });
  await page.evaluate(async () => {
    const video = Array.from(document.querySelectorAll('video')).find(Boolean) as HTMLVideoElement | undefined;
    if (!video) {
      return;
    }
    video.muted = true;
    video.volume = 0;
    try {
      const promise = video.play();
      if (promise && typeof promise.then === 'function') {
        await promise;
      }
    } catch {
      // allow caller to validate
    }
  });
  await page.waitForFunction(() => {
    const video = Array.from(document.querySelectorAll('video')).find(Boolean) as HTMLVideoElement | undefined;
    return Boolean(video && !video.paused && video.readyState >= 2);
  }, { timeout: 20_000 });
};

const runBrowseRead = async (page: Page, viewerId: number, screenshotDir: string, screenshots: string[]) => {
  await gotoPage(page, `${baseUrl}/?tab=overview`);
  await page.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 30_000 });
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-overview`));
  }
  await clickVisible(page, [selectors.navCourses, selectors.mobileNavCourses, selectors.mobileTabCourses]);
  await page.waitForFunction(() => /all courses/i.test(document.body?.innerText || '') || Boolean(document.querySelector('[data-testid^="course-catalog-card-"]')), { timeout: 30_000 });
  await openCourseCard(page, courseText);
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-course-open`));
  }
  await clickVisible(page, [selectors.navTests, selectors.mobileNavTests, selectors.mobileTabTests]);
  await page.waitForSelector(`${selectors.testsHomeDesktop}, ${selectors.testsHomeMobile}, ${selectors.testsFigmaPage}`, { timeout: 30_000 });
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-tests-read`));
  }
};

const runAuthSession = async (page: Page, viewerId: number, screenshotDir: string, screenshots: string[]) => {
  await gotoPage(page, `${baseUrl}/?tab=overview`);
  await page.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 30_000 });
  await clickVisible(page, [selectors.overviewNotificationButton]);
  await sleep(1_000);
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-notifications`));
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
  await page.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 30_000 });
  await clickVisible(page, ['[aria-label="Open profile editor"]', '[aria-label="Open profile menu"]']);
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-profile-read`));
  }
};

const runLightWrite = async (page: Page, viewerId: number, screenshotDir: string, screenshots: string[]) => {
  await gotoPage(page, `${baseUrl}/?tab=overview`);
  await page.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}`, { timeout: 30_000 });
  await clickVisible(page, ['[aria-label="Open profile editor"]', '[aria-label="Open profile menu"]'], 20_000);
  await page.waitForSelector('[placeholder="Enter your name"]', { timeout: 20_000 });
  await page.locator('[placeholder="Enter your name"]').fill(`QA Mixed Browser ${String(viewerId).padStart(4, '0')}`);
  await page.evaluate(() => {
    const saveButton = Array.from(document.querySelectorAll('button')).find((button) => /save profile/i.test((button.textContent || '').trim())) as HTMLButtonElement | undefined;
    saveButton?.click();
  });
  await sleep(1_500);
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-profile-write`));
  }
};

const runVideoActive = async (
  page: Page,
  viewerId: number,
  screenshotDir: string,
  screenshots: string[],
  videoPersona: VideoViewerPersona,
) => {
  await gotoPage(page, `${baseUrl}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`);
  await page.waitForSelector(`${selectors.courseLessonView}, ${selectors.coursePlayerShell}, video`, { timeout: 45_000 });
  await startPlayback(page);
  if (videoPersona === 'speed_1_5') {
    await applyVideoSpeed(page, '1.5');
  } else if (videoPersona === 'quality_high') {
    await applyVideoQuality(page, 'highest');
  } else if (videoPersona === 'quality_low') {
    await applyVideoQuality(page, 'lowest');
  } else if (videoPersona === 'seek_middle') {
    await page.evaluate(() => {
      const video = Array.from(document.querySelectorAll('video')).find(Boolean) as HTMLVideoElement | undefined;
      if (video && Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(5, Math.min(video.duration / 2, video.duration - 5));
      }
    });
  } else if (videoPersona === 'pause_resume') {
    await page.evaluate(() => {
      const video = Array.from(document.querySelectorAll('video')).find(Boolean) as HTMLVideoElement | undefined;
      video?.pause();
    });
    await sleep(800);
    await startPlayback(page);
  }
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-video-start`));
  }
  await sleep(Math.max(5_000, Math.round(watchWindowMs / 2)));
  if (shouldCaptureViewerScreenshots(viewerId)) {
    screenshots.push(await takeShot(page, screenshotDir, `mixed-viewer-${viewerId}-video-end`));
  }
};

const runViewer = async (
  browser: Browser,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  user: PreparedUser,
  viewerId: number,
  stage: number,
): Promise<MixedJourneyResult> => {
  const journeyPersona = user.journeyPersona || assignMixedJourneyPersona(Math.max(0, viewerId - 1));
  const videoPersona = journeyPersona === 'video_active'
    ? (user.videoPersona || assignVideoViewerPersona(Math.max(0, viewerId - 1)))
    : null;
  const viewport = user.deviceClass || assignDeviceClass(Math.max(0, viewerId - 1), mobileRatio);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const screenshots: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const timingsMs: Record<string, number | null> = {
    shellReady: null,
    primaryAction: null,
  };

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error));
  });

  try {
    if (viewport === 'mobile') {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    } else {
      await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    }

    const preparedToken = await ensurePreparedUserToken(user, viewerId);
    await setPreparedSession(page, preparedToken);

    const shellStartedAt = Date.now();
    await gotoPage(page, `${baseUrl}/?tab=overview`);
    let usedInteractiveLogin = await loginIfNeeded(page, user.email);
    if (usedInteractiveLogin) {
      await gotoPage(page, `${baseUrl}/?tab=overview`);
    } else if (hasAuthSessionFailure(consoleErrors)) {
      const freshToken = await loginPreparedUser(user.email, viewerId);
      await setPreparedSession(page, freshToken);
      await gotoPage(page, `${baseUrl}/?tab=overview`);
      usedInteractiveLogin = await loginIfNeeded(page, user.email);
      if (usedInteractiveLogin) {
        await gotoPage(page, `${baseUrl}/?tab=overview`);
      }
    }
    await page.waitForSelector(`${selectors.overviewDashboard}, ${selectors.shellReady}, ${selectors.courseFigmaPage}`, { timeout: 45_000 });
    timingsMs.shellReady = Date.now() - shellStartedAt;

    const actionStartedAt = Date.now();
    if (journeyPersona === 'browse_read') {
      await runBrowseRead(page, viewerId, ctx.screenshotDir, screenshots);
    } else if (journeyPersona === 'auth_session') {
      await runAuthSession(page, viewerId, ctx.screenshotDir, screenshots);
    } else if (journeyPersona === 'light_write') {
      await runLightWrite(page, viewerId, ctx.screenshotDir, screenshots);
    } else {
      await runVideoActive(page, viewerId, ctx.screenshotDir, screenshots, videoPersona || 'standard_auto');
    }
    timingsMs.primaryAction = Date.now() - actionStartedAt;

    return {
      viewerId,
      email: user.email,
      viewport,
      journeyPersona,
      journeyDescription: describeMixedJourneyPersona(journeyPersona),
      videoPersona,
      videoPersonaDescription: videoPersona ? describeVideoPersona(videoPersona) : null,
      shardId: user.shardId || shardId,
      ok: true,
      stage,
      screenshots: screenshots.filter(Boolean),
      timingsMs,
      consoleErrors,
      pageErrors,
      failureClassification: null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (shouldCaptureViewerScreenshots(viewerId)) {
      screenshots.push(await takeShotBestEffort(page, ctx.screenshotDir, `mixed-viewer-${viewerId}-failure`, consoleErrors));
      await writeText(path.join(ctx.sourceDir, `mixed-viewer-${viewerId}-failure.html`), await page.content().catch(() => ''));
    }
    const failureClassification = /login|auth/i.test(errorMessage)
      ? 'auth_failure'
      : /video|player|playback/i.test(errorMessage)
        ? 'playback_failure'
        : /save profile|profile/i.test(errorMessage)
          ? 'write_failure'
          : /selector|route|course|tests|overview/i.test(errorMessage)
            ? 'route_failure'
            : 'unknown';
    return {
      viewerId,
      email: user.email,
      viewport,
      journeyPersona,
      journeyDescription: describeMixedJourneyPersona(journeyPersona),
      videoPersona,
      videoPersonaDescription: videoPersona ? describeVideoPersona(videoPersona) : null,
      shardId: user.shardId || shardId,
      ok: false,
      stage,
      screenshots: screenshots.filter(Boolean),
      timingsMs,
      consoleErrors,
      pageErrors,
      failureClassification,
      error: errorMessage,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
};

const runStage = async (
  browser: Browser,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  users: PreparedUser[],
  viewers: number,
): Promise<MixedStageSummary> => {
  const stageUsers = selectStageUsers(users, viewers);
  const queue = stageUsers.map((user, index) => ({ user, viewerId: index + 1 }));
  const results: MixedJourneyResult[] = [];
  const startedAt = new Date().toISOString();

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

  const resultsPath = path.join(ctx.analysisDir, `browser-mixed-stage-${viewers}-results.json`);
  const artifactManifestPath = path.join(ctx.analysisDir, `browser-mixed-stage-${viewers}-artifact-manifest.json`);
  await writeJson(resultsPath, results);
  await writeJson(artifactManifestPath, {
    stage: viewers,
    workerLabel,
    shardId,
    users: results.map((result) => ({
      viewerId: result.viewerId,
      email: result.email,
      journeyPersona: result.journeyPersona,
      videoPersona: result.videoPersona,
      viewport: result.viewport,
      shardId: result.shardId,
      ok: result.ok,
      screenshots: result.screenshots,
      resultsPath,
    })),
  });

  const journeyBreakdown = results.reduce((summary, result) => {
    summary[result.journeyPersona] += 1;
    return summary;
  }, journeyBreakdownTemplate());
  const failureBreakdown = results.reduce<Record<string, number>>((summary, result) => {
    if (!result.failureClassification) {
      return summary;
    }
    summary[result.failureClassification] = (summary[result.failureClassification] || 0) + 1;
    return summary;
  }, {});

  return {
    viewers,
    workerLabel,
    shardId,
    startedAt,
    completedAt: new Date().toISOString(),
    ok: results.every((result) => result.ok),
    successCount: results.filter((result) => result.ok).length,
    failureCount: results.filter((result) => !result.ok).length,
    journeyBreakdown,
    failureBreakdown,
    resultsPath,
    artifactManifestPath,
    screenshotDir: ctx.screenshotDir,
  };
};

const main = async () => {
  const users = await loadUsers();
  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
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

  const stages: MixedStageSummary[] = [];
  try {
    for (const stage of stageViewerCounts) {
      if (stage > users.length) {
        break;
      }
      const summary = await runStage(browser, ctx, users, stage);
      stages.push(summary);
      if (!summary.ok) {
        break;
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const summary: MixedRunSummary = {
    baseUrl,
    manifestPath,
    courseId,
    lessonId,
    stages,
    workerLabel,
    shardId,
    overallOk: stages.length > 0 && stages.every((stage) => stage.ok),
  };
  await writeJson(path.join(ctx.analysisDir, 'browser-mixed-feature-concurrency-summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.overallOk) {
    process.exitCode = 1;
  }
};

if (process.argv[1]?.endsWith('browser-mixed-feature-concurrency-review.ts')) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
