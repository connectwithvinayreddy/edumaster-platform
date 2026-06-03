import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const syntheticPassword = process.env.QA_SYNTHETIC_PASSWORD || 'Student@123';
const paymentRangeStart = process.env.QA_PAYMENT_RANGE_START || '2026-05-31';
const paymentRangeEnd = process.env.QA_PAYMENT_RANGE_END || '2026-05-31';
const allowCleanupExecute = process.env.QA_CLEANUP_EXECUTE === 'true';

type JsonRecord = Record<string, unknown>;

const fetchJson = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
};

const apiRequest = async (pathname: string, token: string, init: RequestInit = {}) => {
  return fetchJson(pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
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
}) as Promise<{ token: string; user: { _id: string; email: string; role: string } }>;

const registerSyntheticStudent = async (email: string) => {
  await fetchJson('/backend/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'QA Refresh Student',
      email,
      password: syntheticPassword,
      mobileNumber: `9${String(Date.now()).slice(-9)}`.slice(0, 10),
    }),
  });
};

const setSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate((sessionToken) => {
    window.localStorage.setItem('edumaster.jwt', sessionToken);
  }, token);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
};

const screenshot = async (page: puppeteer.Page, root: string, label: string) => {
  const filePath = artifactPath(root, 'payment-admin-refresh-buttons', label, 'png');
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const bodyText = async (page: puppeteer.Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const waitForAdminSectionLoaded = async (page: puppeteer.Page, sectionId: string) => {
  await page.waitForSelector(`[data-testid="admin-section-${sectionId}"]`, { timeout: 30_000 });
  await page.click(`[data-testid="admin-section-${sectionId}"]`);
  await page.waitForSelector(`[data-testid="admin-${sectionId}-loaded"]`, { timeout: 45_000 });
  await sleep(1500);
};
const reloadShell = async (page: puppeteer.Page, sectionId: string, loadedSelector: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
  await page.click(selectors.navAdmin);
  await page.waitForSelector(`[data-testid="admin-section-${sectionId}"]`, { timeout: 30_000 });
  await page.waitForSelector(loadedSelector, { timeout: 45_000 });
  await sleep(1500);
};

const collectButtons = async (page: puppeteer.Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('button'))
    .map((button) => ({
      text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
      disabled: (button as HTMLButtonElement).disabled,
      testId: button.getAttribute('data-testid'),
    }))
    .filter((button) => button.text),
);

const main = async () => {
  const ctx = await createRunContext();
  const summary: JsonRecord = {
    baseUrl,
    startedAt: new Date().toISOString(),
    screenshots: {},
    apiResponses: {},
    consoleErrors: [],
    pageErrors: [],
    networkErrors: [],
    buttonAudits: {},
    refreshChecks: {},
    cleanup: {},
    result: 'pending',
  };

  const admin = await login(adminEmail, adminPassword, 'qa-payment-admin-refresh-buttons');
  const syntheticEmail = `phase2_load_refresh_${Date.now()}@edumaster.local`;
  await registerSyntheticStudent(syntheticEmail);
  const synthetic = await login(syntheticEmail, syntheticPassword, 'qa-payment-admin-student-permission');

  const unauthorizedCheck = await fetch(new URL('/backend/api/admin/dashboard', apiOrigin), {
    headers: { authorization: `Bearer ${synthetic.token}` },
  });
  (summary.apiResponses as JsonRecord).unauthorizedAdminDashboard = {
    status: unauthorizedCheck.status,
    body: await unauthorizedCheck.text(),
  };

  (summary.apiResponses as JsonRecord).cleanupPreview = await apiRequest('/backend/api/admin/cleanup/preview', admin.token, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const cleanupPreview = (summary.apiResponses as JsonRecord).cleanupPreview as JsonRecord;
  const confirmToken = String(cleanupPreview.confirmToken || '');
  if (allowCleanupExecute && cleanupPreview.safeToExecute === true && confirmToken) {
    (summary.apiResponses as JsonRecord).cleanupExecute = await apiRequest('/backend/api/admin/cleanup/execute', admin.token, {
      method: 'POST',
      body: JSON.stringify({ confirmToken }),
    });
  }

  (summary.apiResponses as JsonRecord).unverifiedLocalPaidDryRun = await apiRequest(
    `/backend/api/admin/payments/unverified-local-paid?rangePreset=custom&startDate=${encodeURIComponent(paymentRangeStart)}&endDate=${encodeURIComponent(paymentRangeEnd)}&timezone=Asia%2FKolkata&paymentMode=live&limit=250`,
    admin.token,
  );
  (summary.apiResponses as JsonRecord).reconciliation = await apiRequest(
    `/backend/api/admin/payments/reconciliation?rangePreset=custom&startDate=${encodeURIComponent(paymentRangeStart)}&endDate=${encodeURIComponent(paymentRangeEnd)}&timezone=Asia%2FKolkata&paymentMode=live`,
    admin.token,
  );

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    defaultViewport: { width: 1600, height: 1200 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let page: puppeteer.Page | null = null;
  try {
    console.log('[qa] browser start');
    page = await browser.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        (summary.consoleErrors as Array<JsonRecord>).push({
          type: message.type(),
          text: message.text(),
        });
      }
    });
    page.on('pageerror', (error) => {
      (summary.pageErrors as string[]).push(error.message);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        (summary.networkErrors as Array<JsonRecord>).push({
          status: response.status(),
          url: response.url(),
        });
      }
    });

    await setSessionToken(page, admin.token);
    console.log('[qa] shell ready');
    await page.click(selectors.navAdmin);
    await page.waitForSelector('[data-testid="admin-section-overview"]', { timeout: 30_000 });
    await sleep(1500);

    (summary.screenshots as JsonRecord).overviewBeforeRefresh = await screenshot(page, ctx.screenshotDir, 'overview-before-refresh');
    (summary.buttonAudits as JsonRecord).overview = await collectButtons(page);

    (summary.refreshChecks as JsonRecord).overviewRange = {
      paymentRangeStart,
      paymentRangeEnd,
      rangePickerVisible: await page.$('[data-testid="admin-payment-range"]') !== null,
      reconcileButtonVisible: await page.$('[data-testid="admin-reconcile-razorpay"]') !== null,
      bodyIncludesReconciliationLanguage: (await bodyText(page)).includes('Reconciliation'),
    };

    console.log('[qa] overview reload');
    await reloadShell(page, 'overview', '[data-testid="admin-overview-loaded"]');
    (summary.screenshots as JsonRecord).overviewAfterRefresh = await screenshot(page, ctx.screenshotDir, 'overview-after-refresh');
    (summary.refreshChecks as JsonRecord).overviewAfterRefresh = await page.evaluate(() => ({
      activeSection: window.sessionStorage.getItem('edumaster.admin.active-section'),
      rangePreset: window.sessionStorage.getItem('edumaster.admin.overview.rangePreset'),
      startDate: window.sessionStorage.getItem('edumaster.admin.overview.startDate'),
      endDate: window.sessionStorage.getItem('edumaster.admin.overview.endDate'),
    }));

    console.log('[qa] payments section');
    await waitForAdminSectionLoaded(page, 'payments');
    await page.waitForSelector('input[placeholder*="Search"]', { timeout: 20_000 });
    await page.click('input[placeholder*="Search"]', { clickCount: 3 });
    await page.type('input[placeholder*="Search"]', 'order_');
    await sleep(1200);
    (summary.screenshots as JsonRecord).paymentsBeforeRefresh = await screenshot(page, ctx.screenshotDir, 'payments-before-refresh');
    (summary.buttonAudits as JsonRecord).payments = await collectButtons(page);
    console.log('[qa] payments reload');
    await reloadShell(page, 'payments', '[data-testid="admin-payments-loaded"]');
    (summary.screenshots as JsonRecord).paymentsAfterRefresh = await screenshot(page, ctx.screenshotDir, 'payments-after-refresh');
    (summary.refreshChecks as JsonRecord).paymentsAfterRefresh = await page.evaluate(() => ({
      activeSection: window.sessionStorage.getItem('edumaster.admin.active-section'),
      search: window.sessionStorage.getItem('edumaster.admin.payments.search'),
      statusFilter: window.sessionStorage.getItem('edumaster.admin.payments.statusFilter'),
    }));

    console.log('[qa] students section');
    await waitForAdminSectionLoaded(page, 'students');
    await page.click('input[placeholder*="Search"]', { clickCount: 3 });
    await page.type('input[placeholder*="Search"]', syntheticEmail);
    await sleep(1500);
    await page.evaluate(() => {
      (window as Window & { __qaConfirmMode?: string }).__qaConfirmMode = 'cancel';
      window.confirm = () => false;
    });
    const networkCountBeforeCancel = (summary.networkErrors as Array<JsonRecord>).length;
    const forceLogoutClicked = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((entry) => (entry.textContent || '').includes('Force logout')) as HTMLButtonElement | undefined;
      if (!button) {
        return false;
      }
      button.click();
      return true;
    });
    if (forceLogoutClicked) {
      await sleep(1000);
    }
    (summary.refreshChecks as JsonRecord).studentsConfirmCancel = {
      forceLogoutClicked,
      networkErrorCountBefore: networkCountBeforeCancel,
      networkErrorCountAfter: (summary.networkErrors as Array<JsonRecord>).length,
    };
    (summary.screenshots as JsonRecord).studentsSection = await screenshot(page, ctx.screenshotDir, 'students-section');
    (summary.buttonAudits as JsonRecord).students = await collectButtons(page);

    console.log('[qa] course-access section');
    await waitForAdminSectionLoaded(page, 'course-access');
    (summary.screenshots as JsonRecord).courseAccessSection = await screenshot(page, ctx.screenshotDir, 'course-access-section');
    (summary.buttonAudits as JsonRecord).courseAccess = await collectButtons(page);

    console.log('[qa] manual-review section');
    await waitForAdminSectionLoaded(page, 'manual-review');
    (summary.screenshots as JsonRecord).manualReviewSection = await screenshot(page, ctx.screenshotDir, 'manual-review-section');

    console.log('[qa] system-health section');
    await waitForAdminSectionLoaded(page, 'system-health');
    (summary.screenshots as JsonRecord).systemHealthSection = await screenshot(page, ctx.screenshotDir, 'system-health-section');

    console.log('[qa] audit-logs section');
    await waitForAdminSectionLoaded(page, 'audit-logs');
    (summary.screenshots as JsonRecord).auditLogsSection = await screenshot(page, ctx.screenshotDir, 'audit-logs-section');

    summary.result = 'passed';
  } finally {
    if (page) {
      const sourcePath = artifactPath(ctx.sourceDir, 'payment-admin-refresh-buttons', 'page-source', 'html');
      await writeText(sourcePath, await page.content().catch(() => ''));
      (summary as JsonRecord).pageSource = sourcePath;
    }
    await browser.close();
  }

  const summaryPath = path.join(ctx.rootDir, 'payment-admin-refresh-buttons-summary.json');
  const notesPath = path.join(ctx.rootDir, 'payment-admin-refresh-buttons-summary.md');
  await writeJson(summaryPath, summary);
  await writeText(
    notesPath,
    [
      `Base URL: ${baseUrl}`,
      `Result: ${summary.result}`,
      `Cleanup execute allowed: ${allowCleanupExecute}`,
      `Cleanup execute present: ${Boolean((summary.apiResponses as JsonRecord).cleanupExecute)}`,
      `Unverified local paid dry-run rows: ${JSON.stringify(((summary.apiResponses as JsonRecord).unverifiedLocalPaidDryRun as JsonRecord)?.summary || {}, null, 2)}`,
    ].join('\n'),
  );
  console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
