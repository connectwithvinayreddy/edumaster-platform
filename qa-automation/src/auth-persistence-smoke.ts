import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { artifactPath, createRunContext, writeJson, writeText } from './utils.js';

const chromeExecutable = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || config.baseUrl || 'http://127.0.0.1:3300').replace(/\/+$/, '');
const email = process.env.QA_LOGIN_EMAIL || process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const password = process.env.QA_LOGIN_PASSWORD || process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || config.loginPassword || 'Student@123';
const courseId = String(process.env.QA_COURSE_ID || process.env.PLATFORM_LOAD_COURSE_ID || '').trim();
const targetUrl = courseId
  ? `${baseUrl}/?tab=courses&courseId=${encodeURIComponent(courseId)}`
  : `${baseUrl}/?tab=courses`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForAuthOrShell = async (page: puppeteer.Page, timeout = 45_000) => {
  await page.waitForFunction(
    () => Boolean(
      document.querySelector('[data-testid="auth-login-email"]')
      || document.querySelector('[data-testid="shell-ready"]')
      || document.querySelector('[data-testid="mobile-nav-overview"]')
      || document.querySelector('[data-testid="nav-overview"]'),
    ),
    { timeout },
  );
};

const isShellVisible = async (page: puppeteer.Page) =>
  page.evaluate(() => Boolean(
    document.querySelector('[data-testid="shell-ready"]')
    || document.querySelector('[data-testid="mobile-nav-overview"]')
    || document.querySelector('[data-testid="nav-overview"]'),
  ));

const isLoginVisible = async (page: puppeteer.Page) =>
  page.evaluate(() => Boolean(document.querySelector('[data-testid="auth-login-email"]')));

const loginApi = async () => {
  const response = await fetch(`${baseUrl}/backend/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'qa-auth-persistence-smoke',
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await response.json() as {
    token?: string;
    user?: { _id?: string; session?: string | null };
    message?: string;
  };
  if (!response.ok || !payload.token || !payload.user?._id) {
    throw new Error(`Unable to seed auth session (${response.status}): ${payload.message || 'unknown login error'}`);
  }
  return payload as { token: string; user: { _id: string; session?: string | null } };
};

const seedBrowserSession = async (page: puppeteer.Page) => {
  const payload = await loginApi();
  await page.evaluate((session) => {
    window.localStorage.setItem('edumaster.jwt', session.token);
    window.localStorage.setItem('edumaster.auth.session', JSON.stringify({
      userId: session.user._id,
      sessionId: session.user.session || null,
      issuedAt: new Date().toISOString(),
    }));
  }, payload);
};

const takeArtifact = async (page: puppeteer.Page, ctx: Awaited<ReturnType<typeof createRunContext>>, label: string) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, 'auth-persistence-smoke', label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, 'auth-persistence-smoke', label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

const readSessionState = async (page: puppeteer.Page) =>
  page.evaluate(() => {
    const token = window.localStorage.getItem('edumaster.jwt');
    const metaRaw = window.localStorage.getItem('edumaster.auth.session');
    let meta: { userId?: string | null; sessionId?: string | null } | null = null;
    try {
      meta = metaRaw ? JSON.parse(metaRaw) : null;
    } catch {
      meta = null;
    }
    return {
      hasToken: Boolean(token),
      userId: meta?.userId || null,
      sessionId: meta?.sessionId || null,
      path: window.location.pathname,
      search: window.location.search,
    };
  });

const main = async () => {
  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const summary: Record<string, unknown> = {
    baseUrl,
    targetUrl,
    email,
    courseId: courseId || null,
    startedAt: new Date().toISOString(),
    screenshots: {},
    result: 'pending',
  };

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(45_000);
    await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await seedBrowserSession(page);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForAuthOrShell(page);
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="shell-ready"]')), { timeout: 45_000 });

    const afterLogin = await readSessionState(page);
    if (!afterLogin.hasToken || await isLoginVisible(page)) {
      throw new Error('Login did not persist after opening the direct course URL.');
    }
    (summary.screenshots as Record<string, string>).afterLogin = (await takeArtifact(page, ctx, 'after-login-direct-course')).screenshotPath;
    summary.afterLogin = afterLogin;

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitForAuthOrShell(page);
    await sleep(1500);
    const afterReload = await readSessionState(page);
    if (!afterReload.hasToken || await isLoginVisible(page)) {
      throw new Error('Session returned to login after direct course URL refresh.');
    }
    (summary.screenshots as Record<string, string>).afterReload = (await takeArtifact(page, ctx, 'after-refresh')).screenshotPath;
    summary.afterReload = afterReload;

    const staleTab = await browser.newPage();
    await staleTab.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await staleTab.evaluate(() => {
      window.localStorage.setItem('edumaster.auth.event', JSON.stringify({
        type: 'logout',
        userId: 'stale-user',
        sessionId: 'stale-session',
        issuedAt: new Date().toISOString(),
      }));
      window.localStorage.removeItem('edumaster.auth.event');
    });
    await sleep(1200);
    const afterStaleLogout = await readSessionState(page);
    if (!afterStaleLogout.hasToken || await isLoginVisible(page)) {
      throw new Error('Current session was logged out by a stale cross-tab logout event.');
    }
    (summary.screenshots as Record<string, string>).afterStaleLogout = (await takeArtifact(page, ctx, 'after-stale-logout-event')).screenshotPath;
    summary.afterStaleLogout = afterStaleLogout;
    summary.result = 'passed';
  } catch (error) {
    summary.result = 'failed';
    summary.failure = error instanceof Error ? error.message : String(error);
    const pages = await browser.pages();
    const failurePage = pages[pages.length - 1];
    if (failurePage) {
      summary.failureBodyText = await failurePage.evaluate(() => document.body?.innerText || '').catch(() => '');
      (summary.screenshots as Record<string, string>).failure = (await takeArtifact(failurePage, ctx, 'failure')).screenshotPath;
    }
    throw error;
  } finally {
    summary.completedAt = new Date().toISOString();
    const jsonPath = path.join(ctx.analysisDir, 'auth-persistence-smoke-summary.json');
    const notesPath = path.join(ctx.analysisDir, 'auth-persistence-smoke-summary.md');
    await writeJson(jsonPath, summary);
    await writeText(notesPath, JSON.stringify(summary, null, 2));
    await browser.close();
    console.log(`Auth persistence smoke summary: ${jsonPath}`);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
