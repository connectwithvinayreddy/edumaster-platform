import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson } from './utils.js';

type EnvMap = Record<string, string>;

const readRootEnv = async (): Promise<EnvMap> => {
  const envPath = path.resolve(process.cwd(), '..', '.env.production');
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
    const target = lessonButtons.find((button) => (button.textContent || '').toLowerCase().includes(text.toLowerCase()))
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
  const courseText = process.env.QA_COURSE_TEXT || 'SSC';
  const lessonText = process.env.QA_LESSON_TEXT || 'Demo';
  if (!email || !password) {
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
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 2000, height: 1300 });
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      consoleIssues.push(error.stack || error.message);
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

    const token = await loginForToken(email, password);
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.evaluate((authToken) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
    }, token);
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector([
      selectors.shellReady,
      selectors.courseFigmaPage,
      selectors.overviewDashboard,
      selectors.loginEmail,
    ].join(', '), { timeout: 45_000 });

    if (await page.$(selectors.loginEmail)) {
      await page.locator(selectors.loginEmail).fill(email);
      await page.locator(selectors.loginPassword).fill(password);
      await page.locator(selectors.loginSubmit).click();
      await page.waitForSelector(`${selectors.shellReady}, ${selectors.courseFigmaPage}, ${selectors.overviewDashboard}`, { timeout: 45_000 });
    }

    await clickBySelector(page, selectors.navCourses);
    await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await clickCourseByText(page, courseText);
    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    await clickLessonByText(page, lessonText);
    await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });

    await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      void video?.play?.().catch(() => undefined);
    }, selectors.coursePlayerVideo);

    await sleep(Number(process.env.QA_PLAYBACK_WAIT_MS || 18_000));

    const screenshotPath = artifactPath(ctx.screenshotDir, 'course-playback-rootcause', 'player', 'png');
    const sourcePath = artifactPath(ctx.sourceDir, 'course-playback-rootcause', 'player', 'html');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.writeFile(sourcePath, await page.content(), 'utf8');

    const diagnostics = await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      const bodyText = document.body?.innerText || '';
      return {
        currentTime: video?.currentTime ?? null,
        duration: Number.isFinite(video?.duration) ? video?.duration : null,
        paused: video?.paused ?? null,
        readyState: video?.readyState ?? null,
        networkState: video?.networkState ?? null,
        currentSrc: video?.currentSrc || null,
        error: video?.error ? {
          code: video.error.code,
          message: video.error.message,
        } : null,
        visibleTextFlags: {
          reconnecting: /reconnecting/i.test(bodyText),
          preparing: /preparing protected lesson player/i.test(bodyText),
          unavailable: /unavailable|could not|not available/i.test(bodyText),
        },
      };
    }, selectors.coursePlayerVideo);

    const failedResponses = responses.filter((entry) => entry.status >= 400);
    const playable = Number(diagnostics.currentTime || 0) > 0.5
      || Number(diagnostics.readyState || 0) >= 3;
    const summary = {
      ok: playable && failedResponses.length === 0 && !diagnostics.visibleTextFlags.reconnecting,
      baseUrl: config.baseUrl,
      courseText,
      lessonText,
      diagnostics,
      failedResponses,
      responses,
      consoleIssues,
      screenshotPath,
      sourcePath,
    };
    await writeJson(path.join(ctx.analysisDir, 'course-playback-rootcause.json'), summary);
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
      await writeJson(path.join(ctx.analysisDir, 'course-playback-rootcause-failure.json'), {
        message: error instanceof Error ? error.message : String(error),
        bodyText,
        responses,
        consoleIssues,
        screenshotPath,
        sourcePath,
      });
      console.error(`Failure screenshot: ${screenshotPath}`);
    }
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
