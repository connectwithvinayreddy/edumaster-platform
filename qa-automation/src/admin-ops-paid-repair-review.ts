import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { Client } from 'pg';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varoonenglish.com';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '8rvVndTVz6NEk62s3DnqOeyhVtJr6nEp';
const postgresUrl = process.env.POSTGRES_URL || 'postgresql://postgres@127.0.0.1:15432/edumaster';
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

const clickTextButton = async (page: puppeteer.Page, text: string) => {
  const clicked = await page.evaluate((label) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((button) => (button.textContent || '').includes(label)) as HTMLButtonElement | undefined;
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, text);
  if (!clicked) {
    throw new Error(`Unable to find button containing "${text}"`);
  }
};

const clickCourseCardByTitle = async (page: puppeteer.Page, title: string) => {
  const clicked = await page.evaluate((courseTitle) => {
    const cards = Array.from(document.querySelectorAll('[data-testid^="course-card-"], [data-testid^="course-catalog-card-"]'));
    const target = cards.find((card) => (card.textContent || '').includes(courseTitle)) as HTMLElement | undefined;
    if (!target) {
      return false;
    }
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, title);
  if (!clicked) {
    throw new Error(`Unable to open course card for "${title}"`);
  }
};

const readPageText = async (page: puppeteer.Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const screenshot = async (page: puppeteer.Page, filePath: string) => {
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const setInputValue = async (page: puppeteer.Page, selector: string, value: string) => {
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.evaluate((targetSelector) => {
    const input = document.querySelector(targetSelector) as HTMLInputElement | null;
    if (!input) {
      return;
    }
    input.focus();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
  await page.type(selector, value);
};

const queryAll = async (client: Client, sql: string, params: unknown[] = []) => {
  const result = await client.query(sql, params);
  return result.rows;
};

const main = async () => {
  const ctx = await createRunContext();
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();

  const admin = await login(adminEmail, adminPassword, 'qa-admin-paid-repair-seed');
  const stamp = Date.now();
  const studentEmail = `qa.admin.repair.${stamp}@local.test`;
  const studentPassword = 'Student@123';

  const course = await fetchJson('/backend/api/courses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${admin.token}`,
    },
    body: JSON.stringify({
      title: `QA Admin Repair ${stamp}`,
      description: 'Admin repair verification course',
      category: 'SSC JE',
      exam: 'SSC JE',
      subject: 'Mathematics',
      level: 'Full Course',
      price: 1499,
      offerPercentage: 0,
      validityDays: 365,
      instructor: 'QA Repair Instructor',
      modules: [{
        id: `module_${stamp}`,
        title: 'Module 1',
        lessons: [{
          id: `lesson_${stamp}`,
          title: 'Paid Lesson 1',
          type: 'youtube',
          durationMinutes: 12,
          videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          premium: true,
        }],
      }],
    }),
  }) as { _id: string; title: string };

  const studentRegistration = await fetchJson('/backend/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'QA Admin Repair Student',
      email: studentEmail,
      password: studentPassword,
      mobileNumber: `91${String(stamp).slice(-8)}`,
      device: 'qa-admin-repair-student',
    }),
  }) as { user: { _id: string; email: string } };

  const studentId = studentRegistration.user._id;
  const paymentId = `payment_admin_repair_${stamp}`;
  const providerOrderId = `order_admin_repair_${stamp}`;
  const providerPaymentId = `txn_admin_repair_${stamp}`;

  const beforeDbState = {
    user: await queryAll(client, 'SELECT id, email, account_status, last_login_at FROM users WHERE id = $1', [studentId]),
    enrollments: await queryAll(client, 'SELECT id, user_id, course_id, source, access_status, expires_at FROM enrollments WHERE user_id = $1 AND course_id = $2', [studentId, course._id]),
  };

  await client.query(
    `
      INSERT INTO payments (
        id, user_id, amount_inr, currency, provider, provider_order_id, provider_payment_id,
        provider_signature, course_id, receipt, item, status, attempt_count, retryable, last_error,
        payment_meta, paid_at, created_at, updated_at
      ) VALUES (
        $1, $2, 1499, 'INR', 'razorpay', $3, $4, $5, $6, $7, $8, 'paid', 1, false, NULL,
        $9::jsonb, now(), now(), now()
      )
    `,
    [
      paymentId,
      studentId,
      providerOrderId,
      providerPaymentId,
      `sig_admin_repair_${stamp}`,
      course._id,
      `receipt_admin_repair_${stamp}`,
      `Course Purchase: ${course.title}`,
      JSON.stringify({ seededBy: 'admin-ops-paid-repair-review', scenario: 'paid_without_enrollment' }),
    ],
  );

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 960 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const summary: Record<string, unknown> = {
    baseUrl,
    courseId: course._id,
    courseTitle: course.title,
    studentId,
    studentEmail,
    paymentId,
    providerPaymentId,
    screenshots: {},
    beforeDbState,
  };

  let studentPage: puppeteer.Page | null = null;
  let adminPage: puppeteer.Page | null = null;

  try {
    const studentLogin = await login(studentEmail, studentPassword, 'qa-admin-repair-student-before');
    studentPage = await browser.newPage();
    await setSessionToken(studentPage, studentLogin.token);
    await waitForShell(studentPage);
    await studentPage.click(selectors.navCourses);
    await studentPage.waitForSelector(selectors.courseFigmaPage, { timeout: 30_000 });
    await setInputValue(studentPage, selectors.courseCatalogSearch, course.title);
    await sleep(800);
    await clickCourseCardByTitle(studentPage, course.title);
    await sleep(1500);
    const beforeText = await readPageText(studentPage);
    const studentBeforeShot = artifactPath(ctx.screenshotDir, 'admin-repair', 'student-before-repair', 'png');
    await screenshot(studentPage, studentBeforeShot);
    summary.screenshots = {
      ...(summary.screenshots as Record<string, string>),
      studentBeforeRepair: studentBeforeShot,
    };
    summary.studentBeforeText = beforeText;

    const diagnosisBefore = await fetchJson(`/backend/api/admin/access/diagnose?studentId=${encodeURIComponent(studentId)}&courseId=${encodeURIComponent(course._id)}&transactionId=${encodeURIComponent(providerPaymentId)}`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    summary.diagnosisBefore = diagnosisBefore;

    adminPage = await browser.newPage();
    await setSessionToken(adminPage, admin.token);
    await waitForShell(adminPage);
    await adminPage.click(selectors.navAdmin);
    await adminPage.waitForSelector('[data-testid="admin-section-purchases"]', { timeout: 30_000 });
    await adminPage.click('[data-testid="admin-section-purchases"]');
    await adminPage.waitForSelector('input[placeholder*="email"]', { timeout: 30_000 });
    await adminPage.type('input[placeholder*="email"]', studentEmail);
    await sleep(1000);
    const adminBeforeShot = artifactPath(ctx.screenshotDir, 'admin-repair', 'admin-purchases-before-repair', 'png');
    await screenshot(adminPage, adminBeforeShot);
    (summary.screenshots as Record<string, string>).adminPurchasesBeforeRepair = adminBeforeShot;

    await clickTextButton(adminPage, 'Diagnose');
    await sleep(1000);
    const adminDiagnosisShot = artifactPath(ctx.screenshotDir, 'admin-repair', 'admin-diagnosis-before-repair', 'png');
    await screenshot(adminPage, adminDiagnosisShot);
    (summary.screenshots as Record<string, string>).adminDiagnosisBeforeRepair = adminDiagnosisShot;

    adminPage.once('dialog', async (dialog) => {
      await dialog.accept('QA automated Repair Course Access');
    });
    await clickTextButton(adminPage, 'Repair Course Access');
    await sleep(2000);
    const adminAfterShot = artifactPath(ctx.screenshotDir, 'admin-repair', 'admin-after-repair', 'png');
    await screenshot(adminPage, adminAfterShot);
    (summary.screenshots as Record<string, string>).adminAfterRepair = adminAfterShot;

    const diagnosisAfter = await fetchJson(`/backend/api/admin/access/diagnose?studentId=${encodeURIComponent(studentId)}&courseId=${encodeURIComponent(course._id)}&transactionId=${encodeURIComponent(providerPaymentId)}`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    summary.diagnosisAfter = diagnosisAfter;

    await studentPage.close().catch(() => undefined);
    const studentAfterPage = await browser.newPage();
    const studentLoginAfter = await login(studentEmail, studentPassword, 'qa-admin-repair-student-after');
    await setSessionToken(studentAfterPage, studentLoginAfter.token);
    await waitForShell(studentAfterPage);
    await studentAfterPage.click(selectors.navCourses);
    await studentAfterPage.waitForSelector(selectors.courseFigmaPage, { timeout: 30_000 });
    await setInputValue(studentAfterPage, selectors.courseCatalogSearch, course.title);
    await sleep(800);
    await clickCourseCardByTitle(studentAfterPage, course.title);
    await sleep(1500);
    const afterText = await readPageText(studentAfterPage);
    const studentAfterShot = artifactPath(ctx.screenshotDir, 'admin-repair', 'student-after-repair', 'png');
    await screenshot(studentAfterPage, studentAfterShot);
    (summary.screenshots as Record<string, string>).studentAfterRepair = studentAfterShot;
    summary.studentAfterText = afterText;
    await studentAfterPage.close().catch(() => undefined);
    studentPage = null;

    summary.afterDbState = {
      enrollments: await queryAll(client, 'SELECT id, user_id, course_id, source, access_status, expires_at, admin_note, updated_at FROM enrollments WHERE user_id = $1 AND course_id = $2', [studentId, course._id]),
      payments: await queryAll(client, 'SELECT id, user_id, course_id, provider_order_id, provider_payment_id, status, paid_at FROM payments WHERE id = $1', [paymentId]),
      auditLogs: await queryAll(client, "SELECT action_type, target_user_id, course_id, transaction_id, reason, created_at FROM admin_audit_logs WHERE target_user_id = $1 ORDER BY created_at DESC LIMIT 10", [studentId]),
    };

    summary.assertions = {
      beforeShowsPay: beforeText.includes('Pay with Razorpay') || beforeText.includes('Premium course') || beforeText.includes('Pay'),
      beforeShowsAccessActive: beforeText.includes('Access active'),
      afterShowsAccessActive: afterText.includes('Access active') || afterText.includes('Unlocked course access'),
      afterShowsPay: afterText.includes('Pay with Razorpay'),
    };
  } finally {
    await studentPage?.close().catch(() => undefined);
    await adminPage?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await client.end().catch(() => undefined);
  }

  const summaryPath = path.join(ctx.rootDir, 'admin-ops-paid-repair-summary.json');
  const notesPath = path.join(ctx.rootDir, 'admin-ops-paid-repair-summary.md');
  await writeJson(summaryPath, summary);
  await writeText(notesPath, [
    `Base URL: ${baseUrl}`,
    `Course: ${course.title} (${course._id})`,
    `Student: ${studentEmail} (${studentId})`,
    `Payment: ${paymentId} / ${providerPaymentId}`,
    `Screenshots: ${JSON.stringify(summary.screenshots, null, 2)}`,
    `Assertions: ${JSON.stringify(summary.assertions, null, 2)}`,
  ].join('\n'));

  console.log(JSON.stringify({
    summaryPath,
    notesPath,
    screenshots: summary.screenshots,
    assertions: summary.assertions,
  }, null, 2));
};

await main();
