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
};

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');

const readEnvFile = async (): Promise<EnvMap> => {
  const values: EnvMap = {};
  try {
    const text = await fs.readFile(path.join(rootDir, '.env.production'), 'utf8');
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

const openLesson = async (page: puppeteer.Page, token: string, courseText: string, lessonText: string) => {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.evaluate((authToken) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
  }, token);
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector(`${selectors.shellReady}, ${selectors.loginEmail}`, { timeout: 45_000 });

  if (await isVisibleSelector(page, selectors.loginEmail)) {
    throw new Error('Production auth token was not accepted by the browser.');
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
  const openedLesson = await page.evaluate((lessonSelector, expectedText) => {
    const lessons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const target = lessons.find((lesson) => (lesson.textContent || '').toLowerCase().includes(expectedText.toLowerCase())) || lessons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, lessonText);
  if (!openedLesson) {
    throw new Error('No lesson button was available.');
  }

  await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
  await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    void video?.play?.().catch(() => undefined);
  }, selectors.coursePlayerVideo);
  await sleep(Number(process.env.QA_PLAYER_WAIT_MS || 8_000));
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
  }, '[data-testid="course-figma-player"]', selectors.coursePlayerVideo);

const assertPlayable = (label: string, diagnostics: PlayerDiagnostics) => {
  const ready = Number(diagnostics.video.readyState || 0) >= 3;
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

const main = async () => {
  const env = await readEnvFile();
  const email = process.env.QA_LOGIN_EMAIL || process.env.ADMIN_EMAIL || env.ADMIN_EMAIL || config.loginEmail;
  const password = process.env.QA_LOGIN_PASSWORD || process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || config.loginPassword;
  const courseText = process.env.QA_COURSE_TEXT || 'SSC';
  const lessonText = process.env.QA_LESSON_TEXT || 'Demo';
  if (!email || !password) {
    throw new Error('QA_LOGIN_EMAIL/QA_LOGIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD is required.');
  }

  const ctx = await createRunContext();
  const desktopToken = await loginForToken(email, password, 'QA Fullscreen Desktop Review');
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
    await desktopPage.setViewport({ width: 2000, height: 1300 });
    await openLesson(desktopPage, desktopToken, courseText, lessonText);
    const desktopPath = artifactPath(ctx.screenshotDir, 'course-player-review', 'desktop', 'png');
    await desktopPage.screenshot({ path: desktopPath, fullPage: true });
    const desktopDiagnostics = await getDiagnostics(desktopPage);
    assertPlayable('desktop', desktopDiagnostics);

    await clickFullscreenControl(desktopPage);
    await sleep(2_000);
    const fullscreenDiagnostics = await getDiagnostics(desktopPage);
    assertPlayable('fullscreen', fullscreenDiagnostics);
    assertFullscreenFit(fullscreenDiagnostics);
    const fullscreenPath = artifactPath(ctx.screenshotDir, 'course-player-review', 'fullscreen', 'png');
    await desktopPage.screenshot({ path: fullscreenPath, fullPage: false });

    await desktopPage.keyboard.press('Escape').catch(() => undefined);
    await desktopPage.close();

    const mobileToken = await loginForToken(email, password, 'QA Fullscreen Mobile Review');
    const mobilePage = await browser.newPage();
    await mobilePage.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await mobilePage.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');
    await openLesson(mobilePage, mobileToken, courseText, lessonText);
    const mobilePath = artifactPath(ctx.screenshotDir, 'course-player-review', 'mobile', 'png');
    await mobilePage.screenshot({ path: mobilePath, fullPage: true });
    const mobileDiagnostics = await getDiagnostics(mobilePage);
    assertPlayable('mobile', mobileDiagnostics);
    if (mobileDiagnostics.videoRect.width < 300 || mobileDiagnostics.videoRect.height < 160) {
      throw new Error(`Mobile video is under-sized: ${JSON.stringify(mobileDiagnostics)}`);
    }
    await mobilePage.close();

    const summary = {
      ok: true,
      baseUrl: config.baseUrl,
      courseText,
      lessonText,
      screenshots: {
        desktop: desktopPath,
        fullscreen: fullscreenPath,
        mobile: mobilePath,
      },
      diagnostics: {
        desktop: desktopDiagnostics,
        fullscreen: fullscreenDiagnostics,
        mobile: mobileDiagnostics,
      },
    };
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
