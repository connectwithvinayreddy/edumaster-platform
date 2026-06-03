import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = process.env.QA_BASE_URL || config.baseUrl.replace('10.0.2.2', '127.0.0.1').replace(':3000', ':3300');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const studentToken = process.env.QA_STUDENT_TOKEN || '';
const studentEmail = process.env.QA_STUDENT_EMAIL || 'saiarun760@gmail.com';
const orderId = process.env.QA_ORDER_ID || 'order_Svwn6scflb9T2I';
const courseName = process.env.QA_COURSE_NAME || 'Bank';

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
    device: 'qa-production-razorpay-snapshots',
    forceLogoutOtherSessions: true,
  }),
}) as Promise<{ token: string }>;

const setTokenAndLoad = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.evaluate((sessionToken) => {
    window.localStorage.setItem('edumaster.jwt', sessionToken);
  }, token);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
};

const searchUi = async (page: puppeteer.Page, value: string) => {
  await page.waitForSelector('input[placeholder*="Search"]', { timeout: 20_000 });
  await page.click('input[placeholder*="Search"]', { clickCount: 3 });
  await page.type('input[placeholder*="Search"]', value);
  await sleep(2000);
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
    result: 'pending',
    screenshots: {},
  };

  try {
    const admin = await loginAdmin();
    const adminPage = await browser.newPage();
    await setTokenAndLoad(adminPage, admin.token);
    await adminPage.click(selectors.navAdmin);
    await adminPage.waitForSelector('[data-testid="admin-section-transactions"]', { timeout: 30_000 });

    await adminPage.click('[data-testid="admin-section-transactions"]');
    await adminPage.waitForFunction(() => (document.body?.innerText || '').includes('Transaction management'), { timeout: 30_000 });
    await searchUi(adminPage, orderId);
    const adminTransactionShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'admin-transaction-final', 'png');
    await adminPage.screenshot({ path: adminTransactionShot, fullPage: true });
    (summary.screenshots as Record<string, string>).adminTransaction = adminTransactionShot;

    await adminPage.click('[data-testid="admin-section-purchases"]');
    await adminPage.waitForFunction(() => (document.body?.innerText || '').includes('Course purchases and access'), { timeout: 30_000 });
    await searchUi(adminPage, studentEmail);
    const adminPurchaseShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'admin-purchase-final', 'png');
    await adminPage.screenshot({ path: adminPurchaseShot, fullPage: true });
    (summary.screenshots as Record<string, string>).adminPurchase = adminPurchaseShot;

    if (!studentToken) {
      throw new Error('QA_STUDENT_TOKEN is required.');
    }

    const studentPage = await browser.newPage();
    await setTokenAndLoad(studentPage, studentToken);
    await studentPage.click(selectors.navCourses);
    await studentPage.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await studentPage.waitForFunction(
      (title) => (document.body?.innerText || '').includes(title),
      { timeout: 30_000 },
      courseName,
    );
    await sleep(2500);
    const studentShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'student-course-card-final', 'png');
    await studentPage.screenshot({ path: studentShot, fullPage: true });
    (summary.screenshots as Record<string, string>).studentCourseCard = studentShot;

    summary.result = 'passed';
  } finally {
    await browser.close();
    const summaryPath = path.join(ctx.rootDir, 'production-razorpay-sync-snapshots-summary.json');
    const notesPath = path.join(ctx.rootDir, 'production-razorpay-sync-snapshots-summary.md');
    await writeJson(summaryPath, summary);
    await writeText(notesPath, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots }, null, 2));
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
