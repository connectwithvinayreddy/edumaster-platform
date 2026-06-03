import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const baseUrl = process.env.QA_BASE_URL || config.baseUrl.replace('10.0.2.2', '127.0.0.1').replace(':3000', ':3300');
const apiOrigin = new URL(baseUrl).origin;

const fetchJson = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
};

const login = async (email: string, password: string, device: string) => fetchJson('/backend/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email,
    password,
    device,
    forceLogoutOtherSessions: true,
  }),
}) as Promise<{ token: string; user: { _id: string; email: string; name: string } }>;

const setSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.evaluate((sessionToken) => {
    window.localStorage.setItem('edumaster.jwt', sessionToken);
  }, token);
};

const waitForShell = async (page: puppeteer.Page) => {
  await page.goto(baseUrl, { waitUntil: 'networkidle2' });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
};

const readPageText = async (page: puppeteer.Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const screenshot = async (page: puppeteer.Page, filePath: string) => {
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const clickAndWaitForAdmin = async (page: puppeteer.Page) => {
  await page.click(selectors.navAdmin);
  await page.waitForSelector('[data-testid="admin-section-overview"]', { timeout: 30_000 });
  await sleep(1500);
};

const clickSection = async (page: puppeteer.Page, selector: string, expectedText: string) => {
  await page.click(selector);
  await page.waitForFunction(
    (text) => (document.body?.innerText || '').includes(text),
    { timeout: 30_000 },
    expectedText,
  );
  await sleep(1200);
};

const clickSectionAndWait = async (
  page: puppeteer.Page,
  selector: string,
  loadedSelector: string,
  expectedTexts: string[],
) => {
  await page.click(selector);
  await page.waitForSelector(loadedSelector, { timeout: 30_000 });
  if (expectedTexts.length > 0) {
    await page.waitForFunction(
      (texts) => texts.some((text: string) => (document.body?.innerText || '').includes(text)),
      { timeout: 30_000 },
      expectedTexts,
    );
  }
  await sleep(1200);
};

const main = async () => {
  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    defaultViewport: { width: 1600, height: 1200 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const summary: Record<string, unknown> = {
    baseUrl,
    adminEmail,
    result: 'pending',
    screenshots: {},
    consoleErrors: [],
    networkErrors: [],
    pageErrors: [],
  };

  let page: puppeteer.Page | null = null;

  try {
    const admin = await login(adminEmail, adminPassword, 'qa-admin-tab-smoke');
    page = await browser.newPage();

    page.on('console', (message) => {
      if (message.type() === 'error') {
        (summary.consoleErrors as string[]).push(message.text());
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        const bucket = summary.networkErrors as Array<{ status: number; url: string }> | undefined;
        if (bucket) {
          bucket.push({ status: response.status(), url: response.url() });
        }
      }
    });
    page.on('pageerror', (error) => {
      (summary.pageErrors as string[]).push(error.message);
    });

    await setSessionToken(page, admin.token);
    await waitForShell(page);

    const beforeShot = artifactPath(ctx.screenshotDir, 'admin-tab', 'before-click', 'png');
    await screenshot(page, beforeShot);
    (summary.screenshots as Record<string, string>).beforeClick = beforeShot;

    await clickAndWaitForAdmin(page);

    const adminText = await readPageText(page);
    const afterShot = artifactPath(ctx.screenshotDir, 'admin-tab', 'after-click', 'png');
    await screenshot(page, afterShot);
    (summary.screenshots as Record<string, string>).afterClick = afterShot;
    summary.adminText = adminText;

    await clickSectionAndWait(page, '[data-testid="admin-section-students"]', '[data-testid="admin-students-loaded"]', ['Student', 'Force logout', 'Grant access']);
    const studentsText = await readPageText(page);
    const studentsShot = artifactPath(ctx.screenshotDir, 'admin-tab', 'students-section', 'png');
    await screenshot(page, studentsShot);
    (summary.screenshots as Record<string, string>).studentsSection = studentsShot;
    summary.studentsText = studentsText;

    await clickSectionAndWait(page, '[data-testid="admin-section-login-sessions"]', '[data-testid="admin-login-sessions-loaded"]', ['Recent device activity', 'Login sessions and device events', 'Force logout']);
    const sessionsText = await readPageText(page);
    const sessionsShot = artifactPath(ctx.screenshotDir, 'admin-tab', 'sessions-section', 'png');
    await screenshot(page, sessionsShot);
    (summary.screenshots as Record<string, string>).sessionsSection = sessionsShot;
    summary.sessionsText = sessionsText;

    await clickSectionAndWait(page, '[data-testid="admin-section-payments"]', '[data-testid="admin-payments-loaded"]', ['Transaction', 'Gateway refs', 'Access']);
    const paymentsText = await readPageText(page);
    const paymentsShot = artifactPath(ctx.screenshotDir, 'admin-tab', 'payments-section', 'png');
    await screenshot(page, paymentsShot);
    (summary.screenshots as Record<string, string>).paymentsSection = paymentsShot;
    summary.paymentsText = paymentsText;

    await clickSectionAndWait(page, '[data-testid="admin-section-course-access"]', '[data-testid="admin-course-access-loaded"]', ['Grant access', 'Revoke']);
    const courseAccessText = await readPageText(page);
    const courseAccessShot = artifactPath(ctx.screenshotDir, 'admin-tab', 'course-access-section', 'png');
    await screenshot(page, courseAccessShot);
    (summary.screenshots as Record<string, string>).courseAccessSection = courseAccessShot;
    summary.courseAccessText = courseAccessText;

    const finalText = await readPageText(page);
    summary.finalAdminText = finalText;

    const hasErrorBoundary = finalText.includes('Something went wrong') || finalText.includes('Minified React error #31');
    const hasAdminWorkspace = adminText.includes('ADMIN WORKSPACE') || adminText.includes('Operate the platform in focused lanes');
    const hasOverviewSection = adminText.includes('Reconciliation report') || adminText.includes('Recent payment activity') || adminText.includes('Active users');
    const hasStudentsSection = studentsText.includes('Force logout') || studentsText.includes('Grant access');
    const hasSessionsSection = sessionsText.includes('Recent device activity') || sessionsText.includes('LOGGED IN NOW') || sessionsText.includes('Recent logins');
    const hasPaymentsSection = paymentsText.includes('Transaction') || paymentsText.includes('Gateway refs') || paymentsText.includes('Repair Course Access');
    const hasCourseAccessSection = courseAccessText.includes('Grant access') || courseAccessText.includes('Revoke');

    summary.assertions = {
      hasErrorBoundary,
      hasAdminWorkspace,
      hasOverviewSection,
      hasStudentsSection,
      hasSessionsSection,
      hasPaymentsSection,
      hasCourseAccessSection,
    };

    if (hasErrorBoundary || !hasAdminWorkspace || !hasStudentsSection || !hasSessionsSection || !hasPaymentsSection || !hasCourseAccessSection) {
      throw new Error(`Admin tab smoke failed: errorBoundary=${hasErrorBoundary}, adminWorkspace=${hasAdminWorkspace}, students=${hasStudentsSection}, sessions=${hasSessionsSection}, payments=${hasPaymentsSection}, courseAccess=${hasCourseAccessSection}`);
    }

    summary.result = 'passed';
  } finally {
    if (page) {
      const htmlPath = artifactPath(ctx.sourceDir, 'admin-tab', 'page-source', 'html');
      const pageContent = await page.content().catch(() => '');
      if (pageContent) {
        await writeText(htmlPath, pageContent);
        (summary as Record<string, unknown>).pageSource = htmlPath;
      }
    }

    await browser.close();
    const summaryPath = path.join(ctx.rootDir, 'admin-tab-smoke-summary.json');
    const notesPath = path.join(ctx.rootDir, 'admin-tab-smoke-summary.md');
    await writeJson(summaryPath, summary);
    await writeText(
      notesPath,
      [
        `Base URL: ${baseUrl}`,
        `Result: ${summary.result}`,
        `Screenshots: ${JSON.stringify(summary.screenshots, null, 2)}`,
        `Assertions: ${JSON.stringify(summary.assertions || {}, null, 2)}`,
      ].join('\n'),
    );
    console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots, assertions: summary.assertions }, null, 2));
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
