import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const smokeStudentName = process.env.QA_STUDENT_NAME || 'GUGULOTHU ARUN SAI';
const smokeStudentEmail = process.env.QA_STUDENT_EMAIL || 'saiarun760@gmail.com';
const smokeStudentMobile = process.env.QA_STUDENT_MOBILE || '+91 7893193816';
const smokeCourseName = process.env.QA_COURSE_NAME || 'Bank';
const smokeAmount = Number(process.env.QA_PAYMENT_AMOUNT_INR || '1499');
const smokeOrderId = process.env.QA_ORDER_ID || 'order_Svwn6scflb9T2I';
const smokeGatewayPaymentId = process.env.QA_GATEWAY_PAYMENT_ID || 'pay_SvwnRM6UShYWJ3';
const smokeBankRrn = process.env.QA_BANK_RRN || '267931609950';

type JsonRecord = Record<string, unknown>;

const fetchJson = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
};

const loginAdmin = async () => fetchJson('/backend/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: adminEmail,
    password: adminPassword,
    device: 'qa-payment-admin-control-center',
    forceLogoutOtherSessions: true,
  }),
}) as Promise<{ token: string; user: { _id: string; email: string; role: string } }>;

const adminFetch = async (token: string, pathname: string, init: RequestInit = {}) => fetchJson(pathname, {
  ...init,
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(init.headers || {}),
  },
});

const runCommand = async (command: string[]) => {
  const child = spawn(command[0], command.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
};

const setSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.evaluate((sessionToken) => {
    window.localStorage.setItem('edumaster.jwt', sessionToken);
  }, token);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
};

const clickAdminSection = async (page: puppeteer.Page, sectionId: string) => {
  const selector = `[data-testid="admin-section-${sectionId}"]`;
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.click(selector);
  await page.waitForFunction(
    (buttonSelector) => {
      const button = document.querySelector(buttonSelector);
      return Boolean(button && /bg-white/.test(button.className));
    },
    { timeout: 45_000 },
    selector,
  );
  await sleep(2200);
};

const fillSearch = async (page: puppeteer.Page, value: string) => {
  const selector = '[data-testid="admin-section-search"], input[placeholder*="Search"]';
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, value);
  await sleep(1800);
};

const readBodyText = async (page: puppeteer.Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const takeShot = async (page: puppeteer.Page, root: string, label: string) => {
  const filePath = artifactPath(root, 'payment-admin-control-center', label, 'png');
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const main = async () => {
  const ctx = await createRunContext();
  const summary: JsonRecord = {
    baseUrl,
    adminEmail,
    deployedAt: new Date().toISOString(),
    endpoints: {},
    screenshots: {},
    consoleErrors: [],
    networkErrors: [],
    pageErrors: [],
    smokeTest: {},
    bulkSync: {},
    uiChecks: {},
    result: 'pending',
  };

  const endpoints = ['/','/backend/api/live','/backend/api/ready','/backend/api/health'];
  for (const pathname of endpoints) {
    const response = await fetch(new URL(pathname, apiOrigin), { method: 'GET' });
    const text = await response.text();
    (summary.endpoints as JsonRecord)[pathname] = {
      status: response.status,
      ok: response.ok,
      snippet: text.slice(0, 500),
    };
  }

  const admin = await loginAdmin();
  const beforeTransactions = await adminFetch(admin.token, `/backend/api/admin/transactions?page=1&pageSize=25&search=${encodeURIComponent(smokeOrderId)}`) as {
    items: Array<JsonRecord>;
    pagination: JsonRecord;
  };
  const singleSyncResult = await adminFetch(admin.token, '/backend/api/admin/transactions/sync-razorpay', {
    method: 'POST',
    body: JSON.stringify({
      transactionId: smokeGatewayPaymentId,
      orderId: smokeOrderId,
      adminNote: 'Production smoke verification from Codex payment/admin control center review',
    }),
  }) as JsonRecord;
  const afterTransactions = await adminFetch(admin.token, `/backend/api/admin/transactions?page=1&pageSize=25&search=${encodeURIComponent(smokeOrderId)}`) as {
    items: Array<JsonRecord>;
    pagination: JsonRecord;
  };
  const courseAccess = await adminFetch(admin.token, `/backend/api/admin/course-access?page=1&pageSize=25&search=${encodeURIComponent(smokeStudentEmail)}`) as {
    summary: JsonRecord;
    items: Array<JsonRecord>;
    pagination: JsonRecord;
  };
  const auditLogs = await adminFetch(admin.token, '/backend/api/admin/audit-logs?page=1&pageSize=50') as {
    items: Array<JsonRecord>;
    pagination: JsonRecord;
  };
  let bulkSyncResult: JsonRecord | null = null;
  let bulkSyncError: string | null = null;
  if (String(process.env.QA_SKIP_BULK_SYNC || 'false').toLowerCase() !== 'true') {
    try {
      bulkSyncResult = await adminFetch(admin.token, '/backend/api/admin/transactions/sync-razorpay-all', {
        method: 'POST',
        body: JSON.stringify({
          maxRecords: Number(process.env.QA_BULK_SYNC_MAX_RECORDS || '500'),
          adminNote: 'Production bulk pending Razorpay sync from Codex payment/admin control center review',
        }),
      }) as JsonRecord;
    } catch (error) {
      bulkSyncError = error instanceof Error ? error.message : String(error);
    }
  }
  const systemHealth = await adminFetch(admin.token, '/backend/api/admin/system-health') as JsonRecord;
  const manualReview = await adminFetch(admin.token, '/backend/api/admin/manual-review?page=1&pageSize=50') as {
    summary: JsonRecord;
    items: Array<JsonRecord>;
    pagination: JsonRecord;
  };
  const remoteDockerPs = await runCommand(['ssh', 'root@178.105.48.179', 'docker ps --format "{{.Names}}\\t{{.Status}}"']);
  const remoteDockerStats = await runCommand(['ssh', 'root@178.105.48.179', 'docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}"']);

  summary.smokeTest = {
    target: {
      studentName: smokeStudentName,
      studentEmail: smokeStudentEmail,
      studentMobile: smokeStudentMobile,
      courseName: smokeCourseName,
      amount: smokeAmount,
      orderId: smokeOrderId,
      gatewayPaymentId: smokeGatewayPaymentId,
      bankRrn: smokeBankRrn,
    },
    beforeTransactions,
    singleSyncResult,
    afterTransactions,
    courseAccess,
    relevantAuditLogs: auditLogs.items.filter((entry) => ['single_razorpay_sync', 'bulk_razorpay_sync', 'course_assigned_manually', 'course_access_repaired', 'transaction_updated'].includes(String(entry.actionType || ''))).slice(0, 20),
  };
  summary.bulkSync = {
    result: bulkSyncResult,
    error: bulkSyncError,
    manualReviewSummary: manualReview.summary,
  };
  summary.systemHealth = systemHealth;
  summary.runtimeDiagnostics = {
    dockerPs: remoteDockerPs,
    dockerStats: remoteDockerStats,
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
    await setSessionToken(page, admin.token);
    await page.click(selectors.navAdmin);
    await page.waitForSelector('[data-testid="admin-section-overview"]', { timeout: 30_000 });
    await sleep(1500);

    const overviewShot = await takeShot(page, ctx.screenshotDir, 'overview');
    (summary.screenshots as JsonRecord).overview = overviewShot;
    (summary.uiChecks as JsonRecord).overview = {
      text: (await readBodyText(page)).slice(0, 4000),
    };

    await clickAdminSection(page, 'students');
    await fillSearch(page, smokeStudentEmail);
    const studentsShot = await takeShot(page, ctx.screenshotDir, 'students');
    (summary.screenshots as JsonRecord).students = studentsShot;
    (summary.uiChecks as JsonRecord).students = {
      containsStudent: (await readBodyText(page)).includes(smokeStudentEmail),
    };

    await clickAdminSection(page, 'login-sessions');
    const loginSessionsShot = await takeShot(page, ctx.screenshotDir, 'login-sessions');
    (summary.screenshots as JsonRecord).loginSessions = loginSessionsShot;

    await clickAdminSection(page, 'payments');
    await fillSearch(page, smokeOrderId);
    const paymentsShot = await takeShot(page, ctx.screenshotDir, 'payments');
    (summary.screenshots as JsonRecord).payments = paymentsShot;

    await clickAdminSection(page, 'course-access');
    await fillSearch(page, smokeStudentEmail);
    const courseAccessShot = await takeShot(page, ctx.screenshotDir, 'course-access');
    (summary.screenshots as JsonRecord).courseAccess = courseAccessShot;

    await clickAdminSection(page, 'manual-review');
    const manualReviewShot = await takeShot(page, ctx.screenshotDir, 'manual-review');
    (summary.screenshots as JsonRecord).manualReview = manualReviewShot;

    await clickAdminSection(page, 'system-health');
    const systemHealthShot = await takeShot(page, ctx.screenshotDir, 'system-health');
    (summary.screenshots as JsonRecord).systemHealth = systemHealthShot;

    await clickAdminSection(page, 'audit-logs');
    const auditLogsShot = await takeShot(page, ctx.screenshotDir, 'audit-logs');
    (summary.screenshots as JsonRecord).auditLogs = auditLogsShot;

    summary.result = 'passed';
  } catch (error) {
    summary.result = 'failed';
    summary.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (page) {
      const pageSource = artifactPath(ctx.sourceDir, 'payment-admin-control-center', 'page-source', 'html');
      await writeText(pageSource, await page.content().catch(() => ''));
      (summary as JsonRecord).pageSource = pageSource;
    }
    await browser.close();
    const summaryPath = path.join(ctx.rootDir, 'payment-admin-control-center-summary.json');
    const notesPath = path.join(ctx.rootDir, 'payment-admin-control-center-summary.md');
    await writeJson(summaryPath, summary);
    await writeText(notesPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots, result: summary.result }, null, 2));
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
