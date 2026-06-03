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
const orderId = process.env.QA_ORDER_ID || 'order_Svwn6scflb9T2I';
const gatewayPaymentId = process.env.QA_GATEWAY_PAYMENT_ID || 'pay_SvwnRM6UShYWJ3';
const studentEmail = process.env.QA_STUDENT_EMAIL || 'saiarun760@gmail.com';
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
    device: 'qa-production-razorpay-sync',
    forceLogoutOtherSessions: true,
  }),
}) as Promise<{ token: string }>;

const setSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.evaluate((sessionToken) => {
    window.localStorage.setItem('edumaster.jwt', sessionToken);
  }, token);
};

const waitForShell = async (page: puppeteer.Page) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
};

const screenshot = async (page: puppeteer.Page, filePath: string) => {
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const readPageText = async (page: puppeteer.Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const clickByText = async (page: puppeteer.Page, selector: string, text: string) => {
  const clicked = await page.evaluate(({ nodeSelector, needle }) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(nodeSelector));
    const target = elements.find((element) => (element.innerText || element.textContent || '').includes(needle));
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, { nodeSelector: selector, needle: text });
  if (!clicked) {
    throw new Error(`Unable to click ${selector} with text ${text}`);
  }
};

const searchAdmin = async (page: puppeteer.Page, value: string) => {
  await page.waitForSelector('input[placeholder*="Search"]', { timeout: 20_000 });
  await page.click('input[placeholder*="Search"]', { clickCount: 3 });
  await page.type('input[placeholder*="Search"]', value);
  await sleep(1500);
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
    orderId,
    gatewayPaymentId,
    result: 'pending',
    screenshots: {},
    assertions: {},
    consoleErrors: [],
    networkErrors: [],
    pageErrors: [],
  };

  let adminPage: puppeteer.Page | null = null;
  let studentPage: puppeteer.Page | null = null;

  try {
    const admin = await loginAdmin();
    adminPage = await browser.newPage();
    studentPage = await browser.newPage();

    for (const page of [adminPage, studentPage]) {
      page.on('console', (message) => {
        if (message.type() === 'error') {
          (summary.consoleErrors as string[]).push(message.text());
        }
      });
      page.on('response', (response) => {
        if (response.status() >= 400) {
          (summary.networkErrors as Array<{ status: number; url: string }>).push({
            status: response.status(),
            url: response.url(),
          });
        }
      });
      page.on('pageerror', (error) => {
        (summary.pageErrors as string[]).push(error.message);
      });
    }

    await setSessionToken(adminPage, admin.token);
    await waitForShell(adminPage);
    await adminPage.click(selectors.navAdmin);
    await adminPage.waitForSelector('[data-testid="admin-section-transactions"]', { timeout: 30_000 });
    await adminPage.click('[data-testid="admin-section-transactions"]');
    await adminPage.waitForFunction(
      () => (document.body?.innerText || '').includes('Transaction management'),
      { timeout: 30_000 },
    );
    await searchAdmin(adminPage, orderId);
    await adminPage.waitForFunction(
      (needle, paymentNeedle) => {
        const text = document.body?.innerText || '';
        return text.includes(needle) || text.includes(paymentNeedle);
      },
      { timeout: 30_000 },
      orderId,
      gatewayPaymentId,
    );

    const adminTransactionShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'admin-transaction', 'png');
    await screenshot(adminPage, adminTransactionShot);
    (summary.screenshots as Record<string, string>).adminTransaction = adminTransactionShot;

    await adminPage.click('[data-testid="admin-section-purchases"]');
    await adminPage.waitForFunction(
      () => (document.body?.innerText || '').includes('Course purchases and access'),
      { timeout: 30_000 },
    );
    await searchAdmin(adminPage, studentEmail);
    await adminPage.waitForFunction(
      (emailNeedle, courseNeedle) => {
        const text = document.body?.innerText || '';
        return text.includes(emailNeedle) && text.includes(courseNeedle);
      },
      { timeout: 30_000 },
      studentEmail,
      courseName,
    );
    const adminPurchaseShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'admin-purchase', 'png');
    await screenshot(adminPage, adminPurchaseShot);
    (summary.screenshots as Record<string, string>).adminPurchase = adminPurchaseShot;

    if (!studentToken) {
      throw new Error('QA_STUDENT_TOKEN is required for student-side verification.');
    }

    await setSessionToken(studentPage, studentToken);
    await waitForShell(studentPage);
    await studentPage.click(selectors.navCourses);
    await studentPage.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    await studentPage.waitForFunction(
      (title, label) => {
        const text = document.body?.innerText || '';
        return text.includes(title) && text.includes(label);
      },
      { timeout: 30_000 },
      courseName,
      'Continue Learning',
    );
    const studentCourseCardShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'student-course-card', 'png');
    await screenshot(studentPage, studentCourseCardShot);
    (summary.screenshots as Record<string, string>).studentCourseCard = studentCourseCardShot;

    await clickByText(studentPage, '[data-testid^="course-catalog-card-"]', courseName);
    await studentPage.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    const courseOpenShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'student-course-open', 'png');
    await screenshot(studentPage, courseOpenShot);
    (summary.screenshots as Record<string, string>).studentCourseOpen = courseOpenShot;

    await studentPage.waitForSelector(selectors.courseLessonOpen, { timeout: 30_000 });
    await studentPage.click(selectors.courseLessonOpen);
    await studentPage.waitForSelector(`${selectors.courseLessonView}, ${selectors.coursePlayerShell}`, { timeout: 30_000 });
    const lessonOpenShot = artifactPath(ctx.screenshotDir, 'production-razorpay-sync', 'student-lesson-open', 'png');
    await screenshot(studentPage, lessonOpenShot);
    (summary.screenshots as Record<string, string>).studentLessonOpen = lessonOpenShot;

    const adminText = await readPageText(adminPage);
    const studentText = await readPageText(studentPage);
    const assertions = {
      adminShowsCaptured: adminText.includes('PAID') || adminText.includes('paid'),
      adminShowsGatewayPaymentId: adminText.includes(gatewayPaymentId),
      purchasesShowEnabledAccess: adminText.includes('enabled') || adminText.includes('Active'),
      studentShowsContinueLearning: studentText.includes('Continue Learning'),
      studentCanOpenCourse: studentText.includes(courseName),
    };
    summary.assertions = assertions;
    summary.result = Object.values(assertions).every(Boolean) ? 'passed' : 'failed';

    if (summary.result !== 'passed') {
      throw new Error(`Production Razorpay sync review failed: ${JSON.stringify(assertions)}`);
    }
  } finally {
    if (adminPage) {
      const htmlPath = artifactPath(ctx.sourceDir, 'production-razorpay-sync-admin', 'page-source', 'html');
      await writeText(htmlPath, await adminPage.content().catch(() => ''));
      (summary as Record<string, unknown>).adminPageSource = htmlPath;
    }
    if (studentPage) {
      const htmlPath = artifactPath(ctx.sourceDir, 'production-razorpay-sync-student', 'page-source', 'html');
      await writeText(htmlPath, await studentPage.content().catch(() => ''));
      (summary as Record<string, unknown>).studentPageSource = htmlPath;
    }
    await browser.close();
    const summaryPath = path.join(ctx.rootDir, 'production-razorpay-sync-summary.json');
    const notesPath = path.join(ctx.rootDir, 'production-razorpay-sync-summary.md');
    await writeJson(summaryPath, summary);
    await writeText(
      notesPath,
      [
        `Base URL: ${baseUrl}`,
        `Result: ${summary.result}`,
        `Order ID: ${orderId}`,
        `Gateway payment ID: ${gatewayPaymentId}`,
        `Screenshots: ${JSON.stringify(summary.screenshots, null, 2)}`,
        `Assertions: ${JSON.stringify(summary.assertions, null, 2)}`,
      ].join('\n'),
    );
    console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots, assertions: summary.assertions }, null, 2));
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
