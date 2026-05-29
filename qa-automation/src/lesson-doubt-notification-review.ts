import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { createRunContext, artifactPath, sleep, writeJson, writeText } from './utils.js';
import type { CaptureRecord, FailureRecord } from './types.js';

const chromeExecutable = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/$/, '');
const authOrigin = new URL(baseUrl).origin;
const desktopViewport = { width: 1536, height: 1024 };
const androidViewport = { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const iphoneViewport = { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const androidUserAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36';
const iphoneChromeUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/136.0.7103.113 Mobile/15E148 Safari/604.1';

type LessonTarget = {
  courseId: string;
  courseTitle: string;
  moduleTitle: string;
  chapterTitle: string;
  lessonId: string;
  lessonTitle: string;
};

type LoginPayload = {
  token: string;
  user: { _id: string; role: string; email: string; name: string };
};

type NotificationItem = {
  _id: string;
  title: string;
  message: string;
  actionUrl?: string | null;
  payload?: Record<string, unknown> | null;
};

const parseEnvFile = async (filePath: string) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        if (separatorIndex < 0) {
          return null;
        }
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
      })
      .filter(Boolean) as Array<readonly [string, string]>;
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
};

const loadAdminCredentials = async () => {
  const fileEnv = await parseEnvFile(path.resolve(process.cwd(), '.env.production'));
  const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || fileEnv.ADMIN_EMAIL || '';
  const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || fileEnv.ADMIN_PASSWORD || '';
  if (!adminEmail || !adminPassword) {
    throw new Error('Admin credentials are missing. Set QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD or define ADMIN_EMAIL / ADMIN_PASSWORD in .env.production.');
  }
  return { adminEmail, adminPassword };
};

const apiRequest = async <T>(endpoint: string, options: RequestInit = {}) => {
  const response = await fetch(new URL(endpoint, authOrigin), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String((payload as Record<string, unknown>)?.message || (payload as Record<string, unknown>)?.error || `Request failed: ${response.status}`));
  }
  return payload as T;
};

const apiLogin = async (email: string, password: string, device: string): Promise<LoginPayload> => apiRequest<LoginPayload>(
  '/backend/api/auth/login',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device,
      forceLogoutOtherSessions: true,
    }),
  },
);

const apiRegisterStudent = async (email: string, password: string, name: string) => {
  try {
    await apiRequest('/backend/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        password,
        mobileNumber: '',
        device: 'QA Lesson Doubt Student',
      }),
    });
  } catch (error) {
    if (!(error instanceof Error) || !/already exists/i.test(error.message)) {
      throw error;
    }
  }

  return apiLogin(email, password, 'QA Lesson Doubt Student');
};

const getLessonTarget = async (adminToken: string): Promise<LessonTarget> => {
  const overview = await apiRequest<{ courses?: Array<Record<string, any>> }>(
    '/backend/api/platform/overview',
    {
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    },
  );

  for (const course of overview.courses || []) {
    for (const module of course.modules || []) {
      if (String(module.title || '').trim().toLowerCase() !== 'english') {
        continue;
      }
      for (const chapter of module.chapters || []) {
        if (String(chapter.title || '').trim().toLowerCase() !== 'aggressive') {
          continue;
        }
        for (const lesson of chapter.lessons || []) {
          if (String(lesson.title || '').trim().toLowerCase() !== 'demo') {
            continue;
          }
          return {
            courseId: String(course._id),
            courseTitle: String(course.title || ''),
            moduleTitle: String(module.title || ''),
            chapterTitle: String(chapter.title || ''),
            lessonId: String(lesson.id),
            lessonTitle: String(lesson.title || ''),
          };
        }
      }
    }
  }

  throw new Error('Unable to find Bank -> English -> Aggressive -> demo in production overview.');
};

const enrollStudent = async (studentToken: string, courseId: string) => {
  await apiRequest('/backend/api/platform/enroll', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${studentToken}`,
    },
    body: JSON.stringify({
      courseId,
      source: 'qa-lesson-doubt-notification-review',
      accessType: 'course',
    }),
  }).catch((error) => {
    if (!(error instanceof Error) || !/already/i.test(error.message)) {
      throw error;
    }
  });
};

const fetchNotifications = async (token: string) => apiRequest<NotificationItem[]>(
  '/backend/api/notifications',
  { headers: { authorization: `Bearer ${token}` } },
);

const buildLessonUrl = (target: LessonTarget, doubtThreadId?: string | null) => {
  const params = new URLSearchParams({
    tab: 'courses',
    courseId: target.courseId,
    lessonId: target.lessonId,
  });
  if (doubtThreadId) {
    params.set('doubtThreadId', doubtThreadId);
  }
  return `${baseUrl}/?${params.toString()}`;
};

const takeScreenshot = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  stepId: string,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, stepId, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, stepId, label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

const recordCapture = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  stepId: string,
  label: string,
  state: CaptureRecord['state'],
  notes?: string[],
) => {
  const { screenshotPath, sourcePath } = await takeScreenshot(page, ctx, stepId, label);
  captures.push({
    stepId,
    label,
    state,
    durationMs: 0,
    screenshotPath,
    sourcePath,
    timestamp: new Date().toISOString(),
    ...(notes?.length ? { notes } : {}),
  });
  return screenshotPath;
};

const setSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.evaluate((nextToken) => {
    window.localStorage.setItem('edumaster.jwt', nextToken);
  }, token);
};

const shellReadySelector = '[data-testid="shell-ready"], [data-testid="course-figma-page"], [data-course-view="lesson"]';

const waitForShell = async (page: puppeteer.Page, timeout = 45000) => {
  const startedAt = Date.now();
  let lastBodySnapshot = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const remaining = Math.max(5_000, timeout - (Date.now() - startedAt));
    try {
      await page.waitForSelector(shellReadySelector, { timeout: remaining });
      return;
    } catch (error) {
      lastBodySnapshot = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2_000)).catch(() => '');
      const onLoginScreen = /welcome back|create your account|email address|continue with google/i.test(lastBodySnapshot);
      const hasStoredToken = await page.evaluate(() => Boolean(window.localStorage.getItem('edumaster.jwt'))).catch(() => false);

      if (attempt >= 3) {
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            `Last body snapshot: ${lastBodySnapshot || '[empty]'}`,
            `On login screen: ${onLoginScreen}`,
            `Stored token present: ${hasStoredToken}`,
          ].join('\n'),
        );
      }

      if (hasStoredToken) {
        if (onLoginScreen) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
        } else {
          await page.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
        }
      }

      await sleep(2_500);
    }
  }
};

const waitForNotificationText = async (page: puppeteer.Page, text: string, timeout = 35000) => {
  await page.waitForFunction(
    (expected) => (document.body?.innerText || '').includes(String(expected)),
    { timeout },
    text,
  );
};

const openLessonWithToken = async (page: puppeteer.Page, token: string, target: LessonTarget, doubtThreadId?: string | null) => {
  await setSessionToken(page, token);
  await page.goto(buildLessonUrl(target, doubtThreadId), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForShell(page);
  await page.waitForSelector('[data-course-view="lesson"]', { timeout: 45000 });
};

const expandLessonDoubtsSection = async (page: puppeteer.Page) => {
  await page.waitForSelector('[data-testid="course-lesson-doubts-section"]', { timeout: 30000 });
  await page.evaluate(() => {
    const section = document.querySelector('[data-testid="course-lesson-doubts-section"]') as HTMLElement | null;
    section?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  const state = await page.$eval('[data-testid="course-lesson-doubts-section"]', (element) => element.getAttribute('data-state')).catch(() => null);
  if (state !== 'expanded') {
    await page.$eval('[data-testid="course-lesson-doubts-section"] > button', (button) => (button as HTMLButtonElement).click());
  }
  await page.waitForSelector('[data-testid="course-lesson-doubt-send"]', { timeout: 20000 });
};

const submitLessonDoubt = async (page: puppeteer.Page, message: string, role: 'student' | 'admin') => {
  await expandLessonDoubtsSection(page);
  const placeholder = role === 'admin' ? 'Reply to this learner...' : 'Type your doubt...';
  await page.locator(`input[placeholder="${placeholder}"]`).fill(message);
  await page.locator('[data-testid="course-lesson-doubt-send"]').click();
  await page.waitForFunction(
    (expected) => (document.body?.innerText || '').includes(String(expected)),
    { timeout: 30000 },
    message,
  );
};

const waitForToastAndOpen = async (page: puppeteer.Page, titleSnippet: string, timeout = 35000) => {
  await waitForNotificationText(page, titleSnippet, timeout);
  await page.evaluate((expected) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((button) => (button.textContent || '').includes(String(expected))) as HTMLButtonElement | undefined;
    target?.click();
  }, titleSnippet);
};

const openNotificationSheet = async (page: puppeteer.Page) => {
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((node) => (node.getAttribute('aria-label') || '').includes('Open notifications')) as HTMLButtonElement | undefined;
    button?.click();
  });
};

const verifyNotificationSheetText = async (page: puppeteer.Page, expected: string) => {
  await openNotificationSheet(page);
  await waitForNotificationText(page, expected, 20000);
};

const createPage = async (
  browser: puppeteer.Browser,
  options: {
    viewport: puppeteer.Viewport;
    userAgent?: string;
  },
) => {
  const page = await browser.newPage();
  await page.setViewport(options.viewport);
  if (options.userAgent) {
    await page.setUserAgent(options.userAgent);
  }
  return page;
};

const checkNativeAutomationAvailability = async () => {
  const appiumPortOpen = await fetch('http://127.0.0.1:4723/status').then((response) => response.ok).catch(() => false);
  return {
    appiumPortOpen,
  };
};

const main = async () => {
  const ctx = await createRunContext();
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];
  const consoleIssues: string[] = [];
  const nativeAvailability = await checkNativeAutomationAvailability();
  const { adminEmail, adminPassword } = await loadAdminCredentials();
  const adminLogin = await apiLogin(adminEmail, adminPassword, 'QA Lesson Doubt Admin');
  const target = await getLessonTarget(adminLogin.token);

  const runIdSuffix = Date.now();
  const studentEmail = `qa.lesson.doubt.${runIdSuffix}@local.test`;
  const studentName = `QA Notify Student ${runIdSuffix}`;
  const studentPassword = 'Student@12345';
  const studentLogin = await apiRegisterStudent(studentEmail, studentPassword, studentName);
  await enrollStudent(studentLogin.token, target.courseId);

  const studentQuestion = `QA question ${runIdSuffix}: please explain this video again.`;
  const adminReply = `QA reply ${runIdSuffix}: clarified by admin.`;
  const notificationPathText = `${target.courseTitle} -> ${target.moduleTitle} -> ${target.chapterTitle} -> ${target.lessonTitle}`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromeExecutable,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  try {
    const adminDesktop = await createPage(browser, { viewport: desktopViewport });
    const studentDesktop = await createPage(browser, { viewport: desktopViewport });

    for (const page of [adminDesktop, studentDesktop]) {
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().includes('401')) {
          consoleIssues.push(message.text());
        }
      });
      page.on('pageerror', (error) => {
        consoleIssues.push(error.stack || error.message);
      });
    }

    await openLessonWithToken(adminDesktop, adminLogin.token, target);
    await recordCapture(adminDesktop, ctx, captures, 'admin-desktop-ready', 'admin-desktop-ready', 'ui', [
      'Admin desktop opened directly on the target lesson before any student question.',
    ]);

    await openLessonWithToken(studentDesktop, studentLogin.token, target);
    await expandLessonDoubtsSection(studentDesktop);
    await recordCapture(studentDesktop, ctx, captures, 'student-desktop-before-question', 'student-desktop-before-question', 'ui', [
      'Student desktop lesson doubt panel before sending a question.',
    ]);

    await submitLessonDoubt(studentDesktop, studentQuestion, 'student');
    await recordCapture(studentDesktop, ctx, captures, 'student-desktop-question-sent', 'student-desktop-question-sent', 'success', [
      'Student question posted into the lesson thread.',
    ]);

    await waitForToastAndOpen(adminDesktop, `New lesson doubt from ${studentName}`, 40000);
    await pageWaitForLessonReplyTarget(adminDesktop, studentQuestion);
    await recordCapture(adminDesktop, ctx, captures, 'admin-desktop-toast-opened', 'admin-desktop-toast-opened', 'success', [
      `Admin toast arrived with path ${notificationPathText} and opened the correct lesson thread.`,
    ]);

    await submitLessonDoubt(adminDesktop, adminReply, 'admin');
    await recordCapture(adminDesktop, ctx, captures, 'admin-desktop-replied', 'admin-desktop-replied', 'success', [
      'Admin reply posted from the lesson thread.',
    ]);

    await waitForNotificationText(studentDesktop, `Reply from ${adminLogin.user.name || 'Admin'}`, 40000);
    await waitForNotificationText(studentDesktop, adminReply, 40000);
    await recordCapture(studentDesktop, ctx, captures, 'student-desktop-reply-toast', 'student-desktop-reply-toast', 'success', [
      'Student desktop received the admin reply notification and the reply became visible in-thread.',
    ]);

    const adminNotifications = await fetchNotifications(adminLogin.token);
    const studentNotifications = await fetchNotifications(studentLogin.token);
    const adminNotification = adminNotifications.find((notification) =>
      notification.title.includes(`New lesson doubt from ${studentName}`)
      && notification.message.includes(notificationPathText),
    );
    const studentNotification = studentNotifications.find((notification) =>
      notification.title.includes('Reply from')
      && notification.message.includes(notificationPathText),
    );

    if (!adminNotification) {
      failures.push({
        stepId: 'admin-notification-record',
        title: 'Admin notification not persisted',
        description: 'The admin notification list did not contain the lesson doubt notification with the expected path.',
        severity: 'high',
        timestamp: new Date().toISOString(),
        screenshotPath: captures[captures.length - 1]?.screenshotPath,
      });
    }
    if (!studentNotification) {
      failures.push({
        stepId: 'student-notification-record',
        title: 'Student notification not persisted',
        description: 'The student notification list did not contain the admin reply notification with the expected path.',
        severity: 'high',
        timestamp: new Date().toISOString(),
        screenshotPath: captures[captures.length - 1]?.screenshotPath,
      });
    }

    const studentAndroid = await createPage(browser, { viewport: androidViewport, userAgent: androidUserAgent });
    await openLessonWithToken(studentAndroid, studentLogin.token, target, studentNotification?.payload?.doubtThreadId ? String(studentNotification.payload.doubtThreadId) : null);
    await verifyNotificationSheetText(studentAndroid, 'Reply from');
    await recordCapture(studentAndroid, ctx, captures, 'student-android-notifications', 'student-android-notifications', 'success', [
      'Android-sized Chrome emulation showed the student notification center entry.',
    ]);
    await waitForNotificationText(studentAndroid, adminReply, 20000);
    await recordCapture(studentAndroid, ctx, captures, 'student-android-thread', 'student-android-thread', 'success', [
      'Android-sized Chrome emulation showed the reply inside the lesson discussion.',
    ]);

    const studentIosChrome = await createPage(browser, { viewport: iphoneViewport, userAgent: iphoneChromeUserAgent });
    await openLessonWithToken(studentIosChrome, studentLogin.token, target, studentNotification?.payload?.doubtThreadId ? String(studentNotification.payload.doubtThreadId) : null);
    await verifyNotificationSheetText(studentIosChrome, 'Reply from');
    await recordCapture(studentIosChrome, ctx, captures, 'student-ios-chrome-notifications', 'student-ios-chrome-notifications', 'success', [
      'iPhone-sized Chrome emulation showed the student notification center entry.',
    ]);
    await waitForNotificationText(studentIosChrome, adminReply, 20000);
    await recordCapture(studentIosChrome, ctx, captures, 'student-ios-chrome-thread', 'student-ios-chrome-thread', 'success', [
      'iPhone-sized Chrome emulation showed the reply inside the lesson discussion.',
    ]);

    if (consoleIssues.length) {
      failures.push({
        stepId: 'browser-console',
        title: 'Browser console errors detected',
        description: consoleIssues.join('\n'),
        severity: 'medium',
        timestamp: new Date().toISOString(),
        screenshotPath: captures[captures.length - 1]?.screenshotPath,
      });
    }

    await writeJson(path.join(ctx.analysisDir, 'summary.json'), {
      captures,
      failures,
      nativeAvailability,
      target,
      verification: {
        notificationPathText,
        adminNotificationPersisted: Boolean(adminNotification),
        studentNotificationPersisted: Boolean(studentNotification),
      },
      coverage: {
        desktopAdmin: true,
        desktopStudent: true,
        androidChromeEmulation: true,
        iosChromeEmulation: true,
        nativeAndroidAppium: nativeAvailability.appiumPortOpen,
        note: nativeAvailability.appiumPortOpen
          ? 'Appium server is reachable, but this run used browser automation paths for the lesson-doubt flow.'
          : 'No Appium server/device stack was reachable during this run, so native Android automation was not executed.',
      },
    });
    await writeText(
      path.join(ctx.logDir, 'run.log'),
      [
        `Run: ${ctx.runId}`,
        `Target: ${notificationPathText}`,
        `Student email: ${studentEmail}`,
        `Admin notification persisted: ${Boolean(adminNotification)}`,
        `Student notification persisted: ${Boolean(studentNotification)}`,
        `Appium reachable: ${nativeAvailability.appiumPortOpen}`,
      ].join('\n'),
    );

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `${failure.title}: ${failure.description}`).join('\n'));
    }

    console.log(JSON.stringify({
      ok: true,
      runId: ctx.runId,
      screenshotDir: ctx.screenshotDir,
      coverage: {
        desktopAdmin: true,
        desktopStudent: true,
        androidChromeEmulation: true,
        iosChromeEmulation: true,
        nativeAndroidAppium: nativeAvailability.appiumPortOpen,
      },
    }, null, 2));
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const pageWaitForLessonReplyTarget = async (page: puppeteer.Page, messageText: string) => {
  await page.waitForSelector('[data-course-view="lesson"]', { timeout: 30000 });
  await expandLessonDoubtsSection(page);
  await page.waitForFunction(
    (expected) => (document.body?.innerText || '').includes(String(expected)),
    { timeout: 30000 },
    messageText,
  );
};

if (process.argv[1]?.endsWith('lesson-doubt-notification-review.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
