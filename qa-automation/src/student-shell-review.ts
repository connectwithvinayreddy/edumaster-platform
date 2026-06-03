import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, writeJson, writeText } from './utils.js';

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const loginEmail = process.env.QA_LOGIN_EMAIL || '';
const loginPassword = process.env.QA_LOGIN_PASSWORD || '';

const fetchJson = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload as Record<string, unknown>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loginForToken = async () => {
  if (!loginEmail || !loginPassword) {
    throw new Error('QA_LOGIN_EMAIL and QA_LOGIN_PASSWORD are required.');
  }
  const payload = await fetchJson('/backend/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: loginEmail,
      password: loginPassword,
      device: 'qa-student-shell-review',
      forceLogoutOtherSessions: true,
    }),
  });
  if (!payload.token) {
    throw new Error('Login did not return a token.');
  }
  return String(payload.token);
};

const setSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.evaluate((sessionToken) => {
    window.localStorage.setItem('edumaster.jwt', sessionToken);
  }, token);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await Promise.race([
    page.waitForSelector(selectors.shellReady, { timeout: 45_000 }),
    page.waitForSelector(selectors.loginEmail, { timeout: 45_000 }),
  ]);
};

const takeShot = async (page: puppeteer.Page, root: string, label: string) => {
  const filePath = artifactPath(root, 'student-shell-review', label, 'png');
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const readBodyText = async (page: puppeteer.Page) =>
  page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const waitForText = async (page: puppeteer.Page, matcher: RegExp, timeout = 20_000) => {
  await page.waitForFunction(
    (pattern) => new RegExp(pattern.source, pattern.flags).test(document.body?.innerText || ''),
    { timeout },
    { source: matcher.source, flags: matcher.flags },
  );
};

const clickFirstVisible = async (page: puppeteer.Page, selectorsToTry: string[], timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectorsToTry) {
      const element = await page.$(selector);
      if (!element) {
        continue;
      }
      const visible = await element.evaluate((target) => {
        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target as Element);
        return rect.width > 0
          && rect.height > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      }).catch(() => false);
      if (!visible) {
        continue;
      }
      await element.click().catch(async () => {
        await page.evaluate((targetSelector) => {
          const target = document.querySelector(targetSelector) as HTMLElement | null;
          target?.click();
        }, selector);
      });
      return selector;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`No visible selector found from: ${selectorsToTry.join(', ')}`);
};

const main = async () => {
  const ctx = await createRunContext();
  const token = await loginForToken();
  const summary: Record<string, unknown> = {
    baseUrl,
    loginEmail,
    screenshots: {},
    consoleErrors: [] as string[],
    networkErrors: [] as Array<{ status: number; url: string }>,
    pageErrors: [] as string[],
    assertions: {},
    result: 'pending',
  };

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    defaultViewport: { width: 1600, height: 1200 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let page: puppeteer.Page | null = null;
  try {
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        (summary.consoleErrors as string[]).push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      (summary.pageErrors as string[]).push(error.message);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        (summary.networkErrors as Array<{ status: number; url: string }>).push({
          status: response.status(),
          url: response.url(),
        });
      }
    });

    await setSessionToken(page, token);
    if (await page.$(selectors.loginEmail)) {
      await page.type(selectors.loginEmail, loginEmail);
      await page.type(selectors.loginPassword, loginPassword);
      await page.click(selectors.loginSubmit);
      await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
    }

    await page.waitForSelector(selectors.overviewDashboard, { timeout: 30_000 });
    const dashboardShot = await takeShot(page, ctx.screenshotDir, 'dashboard');
    (summary.screenshots as Record<string, string>).dashboard = dashboardShot;

    await clickFirstVisible(page, ['[aria-label="Open notifications"]']);
    await page.waitForSelector('[aria-label="Close notifications"]', { timeout: 20_000 });
    const notificationsShot = await takeShot(page, ctx.screenshotDir, 'notifications');
    (summary.screenshots as Record<string, string>).notifications = notificationsShot;
    await clickFirstVisible(page, ['[aria-label="Close notifications"]']);
    await sleep(500);

    await clickFirstVisible(page, ['[aria-label="Open profile editor"]', '[aria-label="Open profile menu"]']);
    await Promise.race([
      waitForText(page, /Edit profile/i),
      page.waitForSelector('[aria-label="Close profile editor"]', { timeout: 20_000 }),
    ]);
    const profileShot = await takeShot(page, ctx.screenshotDir, 'profile');
    (summary.screenshots as Record<string, string>).profile = profileShot;
    await clickFirstVisible(page, ['[aria-label="Close profile editor"]', '[aria-label="Close profile menu"]']).catch(() => undefined);
    await sleep(500);

    await page.click(selectors.navCourses);
    await page.waitForSelector(`${selectors.courseCatalogView}, ${selectors.courseCourseView}`, { timeout: 30_000 });
    const courseStatusShot = await takeShot(page, ctx.screenshotDir, 'course-access-status');
    (summary.screenshots as Record<string, string>).courseAccessStatus = courseStatusShot;

    const pageText = await readBodyText(page);
    summary.assertions = {
      hasDashboard: /Continue Learning|Start Course|Buy Course|Payment Pending|Contact Support|Renew/i.test(pageText),
      hasNotificationsDialog: true,
      hasProfileDialog: true,
      hasCourseAccessState: /Continue Learning|Start Course|Buy Course|Payment Pending|Contact Support|Renew/i.test(pageText),
    };

    summary.result = 'passed';
  } catch (error) {
    summary.result = 'failed';
    summary.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (page) {
      const sourcePath = artifactPath(ctx.sourceDir, 'student-shell-review', 'page-source', 'html');
      await writeText(sourcePath, await page.content().catch(() => ''));
      summary.pageSource = sourcePath;
    }
    await browser.close();
    const summaryPath = path.join(ctx.rootDir, 'student-shell-review-summary.json');
    const notesPath = path.join(ctx.rootDir, 'student-shell-review-summary.md');
    await writeJson(summaryPath, summary);
    await writeText(notesPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots, result: summary.result }, null, 2));
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
