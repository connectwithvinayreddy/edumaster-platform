import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type JsonRecord = Record<string, unknown>;

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const syntheticPassword = process.env.QA_SYNTHETIC_PASSWORD || 'Student@123';
const courseId = process.env.QA_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2';
const fallbackLessonId = process.env.QA_LESSON_ID || 'video_1780143993163_242f4d6dd3';

const fetchJson = async <T = JsonRecord>(pathname: string, init: RequestInit = {}) => {
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
    const error = new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
    Object.assign(error, { status: response.status, payload });
    throw error;
  }
  return payload as T;
};

const adminFetch = async <T = JsonRecord>(token: string, pathname: string, init: RequestInit = {}) =>
  fetchJson<T>(pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

const loginApi = async (email: string, password: string, device: string) =>
  fetchJson<{ token: string; user: { _id: string; email: string } }>('/backend/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device,
      forceLogoutOtherSessions: true,
    }),
  });

const registerStudent = async (email: string) => {
  const stamp = String(Date.now());
  return fetchJson<{ token?: string; user?: { _id: string } }>('/backend/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `QA Chat Student ${stamp.slice(-4)}`,
      email,
      password: syntheticPassword,
      mobileNumber: `9${stamp.slice(-9)}`.slice(0, 10),
    }),
  });
};

const setSessionToken = async (page: puppeteer.Page, token: string, url = baseUrl) => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate((authToken) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
  }, token);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
};

const screenshot = async (page: puppeteer.Page, root: string, label: string) => {
  const filePath = artifactPath(root, 'course-chat-report-navigation-review', label, 'png');
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
};

const captureSource = async (page: puppeteer.Page, root: string, label: string) => {
  const filePath = artifactPath(root, 'course-chat-report-navigation-review', label, 'html');
  await writeText(filePath, await page.content());
  return filePath;
};

const attachPageTelemetry = (
  page: puppeteer.Page,
  summary: JsonRecord,
  key: 'student' | 'admin' | 'mobile',
) => {
  const consoleEntries: Array<JsonRecord> = [];
  const networkEntries: Array<JsonRecord> = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleEntries.push({
        type: message.type(),
        text: message.text(),
      });
    }
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    if (
      status >= 400
      || /\/backend\/api\/courses\/.*\/doubts/.test(url)
      || /m3u8|\.ts(\?|$)|segment/i.test(url)
    ) {
      networkEntries.push({
        status,
        url,
      });
    }
  });

  summary[`${key}Console`] = consoleEntries;
  summary[`${key}Network`] = networkEntries;
  summary[`${key}PageErrors`] = pageErrors;
};

const waitForVisible = async (page: puppeteer.Page, selector: string, timeoutMs = 30_000) => {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  await page.waitForFunction((targetSelector) => {
    const node = document.querySelector(targetSelector) as HTMLElement | null;
    if (!node) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }, { timeout: timeoutMs }, selector);
};

const clickVisible = async (page: puppeteer.Page, selectorsToTry: string[], timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectorsToTry) {
      const handle = await page.$(selector);
      if (!handle) {
        continue;
      }
      const visible = await handle.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node as Element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).catch(() => false);
      if (!visible) {
        continue;
      }
      await handle.click().catch(async () => {
        await page.evaluate((targetSelector) => {
          (document.querySelector(targetSelector) as HTMLElement | null)?.click();
        }, selector);
      });
      return selector;
    }
    await sleep(250);
  }
  throw new Error(`Unable to click visible selector from: ${selectorsToTry.join(', ')}`);
};

const firstVisibleHandle = async (page: puppeteer.Page, selector: string) => {
  const handles = await page.$$(selector);
  for (const handle of handles) {
    const visible = await handle.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node as Element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).catch(() => false);
    if (visible) {
      return handle;
    }
  }
  return null;
};

const clickButtonByText = async (page: puppeteer.Page, label: string) => {
  const clicked = await page.evaluate((buttonLabel) => {
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent || '').replace(/\s+/g, ' ').trim() === buttonLabel,
    ) as HTMLButtonElement | undefined;
    if (!button) {
      return false;
    }
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  }, label);
  if (!clicked) {
    throw new Error(`Button not found: ${label}`);
  }
};

const selectNativeValue = async (page: puppeteer.Page, selector: string, value: string) => {
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page.select(selector, value);
  await page.evaluate((targetSelector) => {
    const node = document.querySelector(targetSelector) as HTMLSelectElement | null;
    node?.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
};

const openAdminSection = async (page: puppeteer.Page, section: 'lesson-doubts' | 'reports') => {
  await page.goto(`${baseUrl}/?tab=admin`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForVisible(page, selectors.shellReady, 45_000);
  const sectionSelector = section === 'lesson-doubts' ? selectors.adminSectionLessonDoubts : selectors.adminSectionReports;
  const loadedSelector = section === 'lesson-doubts' ? selectors.adminLessonDoubtsLoaded : selectors.adminReportsLoaded;
  await waitForVisible(page, sectionSelector, 30_000);
  await page.click(sectionSelector);
  await waitForVisible(page, loadedSelector, 45_000);
};

const fillInput = async (page: puppeteer.Page, selector: string, value: string) => {
  await page.waitForSelector(selector, { timeout: 20_000 });
  await page.locator(selector).fill(value);
};

const submitReport = async (page: puppeteer.Page, resolvedCourseId: string, resolvedLessonId: string, issueType: string, description: string) => {
  await clickVisible(page, [selectors.lessonReportOpenButton], 20_000);
  await waitForVisible(page, selectors.lessonReportPanel, 20_000);
  await selectNativeValue(page, '[data-testid="lesson-report-issue-type"]', issueType);
  await fillInput(page, selectors.lessonReportDescription, description);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes(`/backend/api/courses/${resolvedCourseId}/lessons/${resolvedLessonId}/reports`) && response.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.click(selectors.lessonReportSubmitButton);
  const response = await responsePromise;
  const payload = await response.json().catch(() => ({}));
  await waitForVisible(page, '[data-testid="lesson-report-success"]', 20_000);
  await page.waitForSelector('[data-testid="lesson-report-row"]', { timeout: 20_000 });
  return payload as JsonRecord;
};

const lessonUrl = (
  resolvedCourseId: string,
  resolvedLessonId: string,
  threadId?: string | null,
  reportId?: string | null,
  supportPanel?: 'doubts' | 'report' | null,
) => {
  const params = new URLSearchParams({
    tab: 'courses',
    courseId: resolvedCourseId,
    lessonId: resolvedLessonId,
  });
  if (threadId) {
    params.set('doubtThreadId', threadId);
  }
  if (reportId) {
    params.set('reportId', reportId);
  }
  if (supportPanel) {
    params.set('supportPanel', supportPanel);
  }
  return `${baseUrl}/?${params.toString()}`;
};

const courseUrl = (resolvedCourseId = courseId) => `${baseUrl}/?${new URLSearchParams({ tab: 'courses', courseId: resolvedCourseId }).toString()}`;
const overviewUrl = () => `${baseUrl}/?tab=overview`;

const openLessonUi = async (page: puppeteer.Page) => {
  await page.goto(courseUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector(selectors.courseCourseView, { timeout: 45_000 });
  await waitForVisible(page, selectors.courseLessonOpen, 45_000);
  const resolvedLessonId = await page.evaluate((lessonTarget, targetLessonId) => {
    const candidates = Array.from(document.querySelectorAll(lessonTarget)) as HTMLElement[];
    const openTarget = candidates.find((node) => (node.getAttribute('data-testid') || '').includes(String(targetLessonId)))
      || candidates[0];
    const testId = openTarget?.getAttribute('data-testid') || '';
    openTarget?.scrollIntoView({ block: 'center', inline: 'nearest' });
    openTarget?.click();
    return testId.replace('course-lesson-open-', '') || null;
  }, selectors.courseLessonOpen, fallbackLessonId);
  await page.waitForSelector(selectors.courseLessonView, { timeout: 45_000 });
  await waitForVisible(page, selectors.coursePlayerHeading, 45_000);
  return {
    courseId,
    lessonId: resolvedLessonId || fallbackLessonId,
  };
};

const expandDoubts = async (page: puppeteer.Page) => {
  await waitForVisible(page, selectors.courseLessonDoubtsSection, 45_000);
  const state = await page.$eval(selectors.courseLessonDoubtsSection, (node) => node.getAttribute('data-state'));
  if (state !== 'expanded') {
    await page.evaluate((selector) => {
      const nodes = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      const target = nodes.find((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }) || nodes[0];
      target?.scrollIntoView({ block: 'center', inline: 'nearest' });
      target?.click();
    }, selectors.lessonDoubtOpenButton);
    await waitForVisible(page, selectors.lessonDoubtInput, 15_000);
  }
};

const typeDoubtAndSend = async (page: puppeteer.Page, message: string, resolvedCourseId: string, resolvedLessonId: string) => {
  await expandDoubts(page);
  await waitForVisible(page, selectors.lessonDoubtInput, 15_000);
  await page.locator(selectors.lessonDoubtInput).fill(message);
  await page.waitForFunction((selector) => {
    const button = document.querySelector(selector) as HTMLButtonElement | null;
    return Boolean(button && !button.disabled);
  }, { timeout: 10_000 }, selectors.courseLessonDoubtSend);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes(`/backend/api/courses/${resolvedCourseId}/lessons/${resolvedLessonId}/doubts`) && response.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.click(selectors.courseLessonDoubtSend);
  await responsePromise;
};

const waitForText = async (page: puppeteer.Page, text: string, timeoutMs = 20_000) => {
  await page.waitForFunction((targetText) => {
    return (document.body?.innerText || '').includes(targetText);
  }, { timeout: timeoutMs }, text);
};

const openNotifications = async (page: puppeteer.Page) => {
  await clickVisible(page, [selectors.overviewNotificationButton, '[aria-label="Open notifications"]'], 20_000);
  await page.waitForFunction(() => {
    return (document.body?.innerText || '').includes('Notifications');
  }, { timeout: 20_000 });
};

const clickFirstNotificationContaining = async (page: puppeteer.Page, text: string) => {
  const clicked = await page.evaluate((snippet) => {
    const buttons = Array.from(document.querySelectorAll('[data-testid="notification-row-unread"], [data-testid="notification-row-read"], button'));
    const target = buttons.find((node) => (node.textContent || '').includes(snippet)) as HTMLButtonElement | undefined;
    if (!target) {
      return false;
    }
    target.click();
    return true;
  }, text);
  if (!clicked) {
    throw new Error(`Notification containing "${text}" not found`);
  }
};

const currentUrl = async (page: puppeteer.Page) => page.url();

const main = async () => {
  const ctx = await createRunContext();
  const summary: JsonRecord = {
    baseUrl,
    courseId,
    lessonId: fallbackLessonId,
    startedAt: new Date().toISOString(),
    screenshots: {},
    sources: {},
    apiResponses: {},
    supported: {
      lessonDoubts: true,
      notifications: true,
      reportWorkflow: true,
      adminSupportPage: true,
      notificationMarkRead: true,
    },
    skipped: [],
    issues: [],
    result: 'pending',
  };

  const adminSession = await loginApi(adminEmail, adminPassword, 'qa-chat-review-admin');
  const syntheticEmail = `qa_video_chat_${Date.now()}@edumaster.local`;
  await registerStudent(syntheticEmail);
  const studentSession = await loginApi(syntheticEmail, syntheticPassword, 'qa-chat-review-student');

  await adminFetch(adminSession.token, '/backend/api/admin/purchases/assign-course', {
    method: 'POST',
    body: JSON.stringify({
      studentId: studentSession.user._id,
      courseId,
      adminNote: 'QA course chat/report/navigation review access grant',
    }),
  });

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1440, height: 1080 },
  });

  const studentPage = await browser.newPage();
  const adminPage = await browser.newPage();
  const mobilePage = await browser.newPage();
  await mobilePage.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });

  attachPageTelemetry(studentPage, summary, 'student');
  attachPageTelemetry(adminPage, summary, 'admin');
  attachPageTelemetry(mobilePage, summary, 'mobile');

  try {
    console.log('[qa-extra] student shell');
    await setSessionToken(studentPage, studentSession.token, overviewUrl());
    await waitForVisible(studentPage, selectors.shellReady);
    (summary.screenshots as JsonRecord).studentLoginPage = await screenshot(studentPage, ctx.screenshotDir, 'student-login-restored');
    (summary.screenshots as JsonRecord).studentDashboard = await screenshot(studentPage, ctx.screenshotDir, 'student-dashboard');

    console.log('[qa-extra] open lesson');
    const resolvedLessonState = await openLessonUi(studentPage);
    const resolvedCourseId = resolvedLessonState.courseId;
    const resolvedLessonId = resolvedLessonState.lessonId;
    summary.courseId = resolvedCourseId;
    summary.lessonId = resolvedLessonId;
    (summary.screenshots as JsonRecord).courseBeforeVideo = await screenshot(studentPage, ctx.screenshotDir, 'course-before-video');
    await captureSource(studentPage, ctx.sourceDir, 'course-before-video');

    const studentMessage = `Need clarity on Thevenin equivalent at ${new Date().toISOString()}`;
    console.log('[qa-extra] student send doubt');
    await typeDoubtAndSend(studentPage, studentMessage, resolvedCourseId, resolvedLessonId);
    await waitForVisible(studentPage, '[data-testid="lesson-doubt-success-toast"]', 20_000);
    await waitForText(studentPage, studentMessage, 20_000);
    (summary.screenshots as JsonRecord).studentDoubtSent = await screenshot(studentPage, ctx.screenshotDir, 'student-doubt-sent');

    console.log('[qa-extra] admin fetch doubts');
    const doubtData = await adminFetch<{ items: Array<{ _id: string; messages: Array<{ message: string }>; status: string; studentName: string }>; pagination: JsonRecord }>(
      adminSession.token,
      `/backend/api/courses/admin/lesson-doubts?search=${encodeURIComponent(syntheticEmail)}`,
    );
    (summary.apiResponses as JsonRecord).adminDoubtsAfterStudentPost = {
      threadCount: doubtData.items.length,
      latestThreadId: doubtData.items[0]?._id || null,
      latestStatus: doubtData.items[0]?.status || null,
    };
    const doubtThreadId = doubtData.items[0]?._id || null;
    if (!doubtThreadId) {
      throw new Error('Admin doubt list did not return a thread after student post');
    }

    console.log('[qa-extra] student refresh');
    await studentPage.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    await waitForText(studentPage, studentMessage, 20_000);
    (summary.screenshots as JsonRecord).studentDoubtAfterRefresh = await screenshot(studentPage, ctx.screenshotDir, 'student-doubt-after-refresh');

    console.log('[qa-extra] admin support doubts');
    await setSessionToken(adminPage, adminSession.token, `${baseUrl}/?tab=admin`);
    await openAdminSection(adminPage, 'lesson-doubts');
    await fillInput(adminPage, '[data-testid="admin-lesson-doubts-search"]', syntheticEmail);
    await clickButtonByText(adminPage, 'Refresh');
    await waitForVisible(adminPage, selectors.adminLessonDoubtsTable, 20_000);
    await pageWaitForText(adminPage, syntheticEmail, 20_000);
    (summary.screenshots as JsonRecord).adminDoubtsList = await screenshot(adminPage, ctx.screenshotDir, 'admin-doubts-list');
    await adminPage.evaluate((threadId) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="admin-lesson-doubt-row"]')) as HTMLElement[];
      const target = rows.find((node) => (node.innerText || '').includes(String(threadId))) || rows[0];
      target?.click();
    }, doubtThreadId);
    await waitForVisible(adminPage, '[data-testid="admin-lesson-doubt-reply-input"]', 20_000);
    await waitForText(adminPage, studentMessage, 20_000);
    (summary.screenshots as JsonRecord).adminDoubtVisible = await screenshot(adminPage, ctx.screenshotDir, 'admin-doubt-visible');

    const adminReply = `Admin reply received at ${new Date().toISOString()}`;
    await fillInput(adminPage, '[data-testid="admin-lesson-doubt-reply-input"]', adminReply);
    const adminReplyResponse = adminPage.waitForResponse(
      (response) => response.url().includes(`/backend/api/courses/admin/lesson-doubts/${doubtThreadId}/reply`) && response.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await adminPage.click('[data-testid="admin-lesson-doubt-reply-send-button"]');
    await adminReplyResponse;
    await waitForText(adminPage, adminReply, 20_000);
    (summary.screenshots as JsonRecord).adminReplySent = await screenshot(adminPage, ctx.screenshotDir, 'admin-reply-sent');
    await selectNativeValue(adminPage, '[data-testid="admin-lesson-doubt-status-select"]', 'resolved');
    await waitForText(adminPage, 'resolved', 20_000);
    (summary.screenshots as JsonRecord).adminDoubtResolved = await screenshot(adminPage, ctx.screenshotDir, 'admin-doubt-resolved');

    console.log('[qa-extra] student notifications');
    await studentPage.goto(overviewUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.shellReady, 45_000);
    await openNotifications(studentPage);
    await waitForText(studentPage, 'Reply from', 20_000);
    (summary.screenshots as JsonRecord).studentNotificationUnread = await screenshot(studentPage, ctx.screenshotDir, 'student-notification-unread');
    (summary.screenshots as JsonRecord).studentNotificationList = await screenshot(studentPage, ctx.screenshotDir, 'student-notification-list');
    await clickFirstNotificationContaining(studentPage, 'Reply from');
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    await waitForText(studentPage, adminReply, 20_000);
    (summary.screenshots as JsonRecord).studentReplyAfterNotification = await screenshot(studentPage, ctx.screenshotDir, 'student-reply-after-notification');
    const notificationsAfterOpen = await adminFetch<Array<JsonRecord>>(studentSession.token, '/backend/api/notifications');
    const replyNotification = notificationsAfterOpen.find((entry) =>
      String((entry as JsonRecord).title || '').includes('Reply from')
      && String((entry as JsonRecord).message || '').includes(studentMessage.slice(0, 20).split(' at ')[0]),
    ) as JsonRecord | undefined;
    (summary.apiResponses as JsonRecord).replyNotificationAfterOpen = replyNotification || null;

    console.log('[qa-extra] student report submit');
    await studentPage.goto(lessonUrl(resolvedCourseId, resolvedLessonId, doubtThreadId), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    const reportDescription = `Video buffering repro ${new Date().toISOString()} on lesson report automation.`;
    const reportPayload = await submitReport(studentPage, resolvedCourseId, resolvedLessonId, 'video_buffering', reportDescription);
    (summary.apiResponses as JsonRecord).studentReportSubmit = reportPayload;
    (summary.screenshots as JsonRecord).studentReportForm = await screenshot(studentPage, ctx.screenshotDir, 'student-report-form');
    await waitForText(studentPage, reportDescription, 20_000);
    (summary.screenshots as JsonRecord).studentReportSubmitted = await screenshot(studentPage, ctx.screenshotDir, 'student-report-submitted');
    const reportId = String((reportPayload.report as JsonRecord | undefined)?._id || '');
    if (!reportId) {
      throw new Error('Report submission did not return a report id');
    }
    await studentPage.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    await waitForText(studentPage, reportId, 20_000);
    (summary.screenshots as JsonRecord).studentReportAfterRefresh = await screenshot(studentPage, ctx.screenshotDir, 'student-report-after-refresh');

    console.log('[qa-extra] admin support reports');
    await openAdminSection(adminPage, 'reports');
    await fillInput(adminPage, '[data-testid="admin-reports-search"]', syntheticEmail);
    await clickButtonByText(adminPage, 'Refresh');
    await waitForVisible(adminPage, selectors.adminReportsTable, 20_000);
    await pageWaitForText(adminPage, reportId, 20_000).catch(() => undefined);
    (summary.screenshots as JsonRecord).adminReportsList = await screenshot(adminPage, ctx.screenshotDir, 'admin-reports-list');
    await adminPage.evaluate((targetReportId) => {
      const rows = Array.from(document.querySelectorAll('[data-testid="admin-lesson-report-row"]')) as HTMLElement[];
      const target = rows.find((node) => (node.innerText || '').includes(String(targetReportId))) || rows[0];
      target?.click();
    }, reportId);
    await waitForVisible(adminPage, '[data-testid="admin-report-detail"]', 20_000);
    await fillInput(adminPage, '[data-testid="admin-lesson-report-note-input"]', 'QA internal note for buffered playback report');
    await fillInput(adminPage, '[data-testid="admin-lesson-report-reply-input"]', 'Please clear cache and retry. We have marked this report in progress.');
    const reportUpdateResponse = adminPage.waitForResponse(
      (response) => response.url().includes(`/backend/api/courses/admin/reports/${reportId}`) && response.request().method() === 'PATCH',
      { timeout: 20_000 },
    );
    await adminPage.click('[data-testid="admin-lesson-report-update-button"]');
    await reportUpdateResponse;
    (summary.screenshots as JsonRecord).adminReportOpened = await screenshot(adminPage, ctx.screenshotDir, 'admin-report-opened');
    await clickButtonByText(adminPage, 'Mark resolved');
    await waitForText(adminPage, 'resolved', 20_000);
    (summary.screenshots as JsonRecord).adminReportResolved = await screenshot(adminPage, ctx.screenshotDir, 'admin-report-resolved');

    console.log('[qa-extra] student report update notification');
    await studentPage.goto(overviewUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.shellReady, 45_000);
    await openNotifications(studentPage);
    await waitForText(studentPage, 'Report resolved', 20_000);
    (summary.screenshots as JsonRecord).studentReportNotification = await screenshot(studentPage, ctx.screenshotDir, 'student-report-notification');
    await clickFirstNotificationContaining(studentPage, 'Report resolved');
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    await waitForText(studentPage, reportId, 20_000);
    (summary.screenshots as JsonRecord).studentReportAfterNotification = await screenshot(studentPage, ctx.screenshotDir, 'student-report-after-notification');
    await studentPage.goto(overviewUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.shellReady, 45_000);
    await openNotifications(studentPage);
    await studentPage.click(selectors.notificationsReadAll);
    await sleep(1000);
    const notificationsAfterReadAll = await adminFetch<Array<JsonRecord>>(studentSession.token, '/backend/api/notifications');
    (summary.apiResponses as JsonRecord).notificationsAfterReadAll = notificationsAfterReadAll.slice(0, 10);
    (summary.screenshots as JsonRecord).notificationsAfterReadAll = await screenshot(studentPage, ctx.screenshotDir, 'notifications-after-read-all');

    console.log('[qa-extra] back forward');
    await studentPage.goto(courseUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseCourseView, 45_000);
    (summary.screenshots as JsonRecord).coursePageBeforeVideo = await screenshot(studentPage, ctx.screenshotDir, 'course-page-before-video');
    await openLessonUi(studentPage);
    (summary.screenshots as JsonRecord).videoPageBeforeBack = await screenshot(studentPage, ctx.screenshotDir, 'video-page-before-back');
    await studentPage.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseCourseView, 45_000);
    (summary.screenshots as JsonRecord).courseBackProof = await screenshot(studentPage, ctx.screenshotDir, 'course-back-proof');
    await studentPage.goForward({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    (summary.screenshots as JsonRecord).videoForwardProof = await screenshot(studentPage, ctx.screenshotDir, 'video-forward-proof');
    await clickVisible(studentPage, [selectors.lessonDoubtOpenButton], 20_000).catch(() => undefined);
    (summary.screenshots as JsonRecord).doubtBeforeBack = await screenshot(studentPage, ctx.screenshotDir, 'doubt-before-back');
    await studentPage.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseCourseView, 45_000);
    (summary.screenshots as JsonRecord).doubtBackProof = await screenshot(studentPage, ctx.screenshotDir, 'doubt-back-proof');
    await studentPage.goForward({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForVisible(studentPage, selectors.courseLessonView, 45_000);
    (summary.screenshots as JsonRecord).doubtForwardProof = await screenshot(studentPage, ctx.screenshotDir, 'doubt-forward-proof');

    await studentPage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await clickVisible(studentPage, ['[aria-label="Open profile editor"]', 'button[aria-label="Open profile editor"]'], 20_000).catch(() => undefined);
    await studentPage.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);

    console.log('[qa-extra] mobile report and navigation');
    await setSessionToken(mobilePage, studentSession.token, lessonUrl(resolvedCourseId, resolvedLessonId, doubtThreadId));
    await waitForVisible(mobilePage, selectors.courseLessonView, 45_000);
    await clickVisible(mobilePage, [selectors.lessonReportOpenButton], 20_000);
    await waitForVisible(mobilePage, selectors.lessonReportPanel, 20_000);
    (summary.screenshots as JsonRecord).mobileReportPanel = await screenshot(mobilePage, ctx.screenshotDir, 'mobile-report-panel');
    await mobilePage.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await mobilePage.goForward({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await waitForVisible(mobilePage, selectors.courseLessonView, 45_000);
    (summary.screenshots as JsonRecord).mobileForwardProof = await screenshot(mobilePage, ctx.screenshotDir, 'mobile-forward-proof');

    (summary.apiResponses as JsonRecord).studentNotifications = await adminFetch(studentSession.token, '/backend/api/notifications');
    (summary.apiResponses as JsonRecord).adminReports = await adminFetch(adminSession.token, `/backend/api/courses/admin/reports?search=${encodeURIComponent(syntheticEmail)}`);
    summary.result = 'passed';
  } finally {
    await Promise.all([
      captureSource(studentPage, ctx.sourceDir, 'student-final').catch(() => undefined),
      captureSource(adminPage, ctx.sourceDir, 'admin-final').catch(() => undefined),
      captureSource(mobilePage, ctx.sourceDir, 'mobile-final').catch(() => undefined),
    ]);
    await browser.close();
  }

  const summaryPath = path.join(ctx.rootDir, 'course-chat-report-navigation-review-summary.json');
  const notesPath = path.join(ctx.rootDir, 'course-chat-report-navigation-review-summary.md');
  await writeJson(summaryPath, summary);
  await writeText(
    notesPath,
      [
      `Base URL: ${baseUrl}`,
      `Result: ${String(summary.result)}`,
      `Course: ${String(summary.courseId)}`,
      `Lesson: ${String(summary.lessonId)}`,
      `Skipped: ${JSON.stringify(summary.skipped, null, 2)}`,
    ].join('\n'),
  );
  console.log(JSON.stringify({ summaryPath, notesPath, screenshots: summary.screenshots, result: summary.result }, null, 2));
};

const pageWaitForText = waitForText;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
