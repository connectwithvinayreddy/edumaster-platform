import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { artifactPath, createRunContext, writeJson } from './utils.js';

type CourseRecord = {
  _id: string;
  title: string;
  modules?: Array<{
    id: string;
    title: string;
    lessons?: LessonRecord[];
    chapters?: Array<{
      id: string;
      title: string;
      lessons?: LessonRecord[];
    }>;
  }>;
};

type LessonRecord = {
  id: string;
  title: string;
  attachments?: Array<{ id: string; title?: string }>;
  notesUrl?: string | null;
};

type PdfTarget = {
  attachmentId: string;
  title: string;
  source: 'lesson' | 'chapter';
};

type AttachmentProbe = {
  scope: 'module' | 'chapter' | 'lesson';
  title: string;
};

type UserDiagnosis = {
  label: string;
  email: string;
  courseStatus: number;
  attachmentVisibleInCourse: boolean;
  attachmentLocation: AttachmentProbe | null;
  enrolled: boolean | null;
  canAccessCourse: boolean | null;
  accessReason: string | null;
  pdfStatus: number;
  pdfOk: boolean;
  pdfContentType: string;
  pdfContentRange: string | null;
  pdfBytesRead: number;
};

type BrowserIssue = {
  kind: 'console' | 'pageerror';
  text: string;
};

type EnvMap = Record<string, string>;

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const readEnvFile = async (): Promise<EnvMap> => {
  const values: EnvMap = {};
  try {
    const text = await fs.readFile(path.join(rootDir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        values[trimmed.slice(0, index)] = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Explicit QA env vars remain the primary input.
  }
  return values;
};

const login = async (email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      forceLogoutOtherSessions: true,
      device: 'QA PDF Editorial Smoke',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message || `Unable to login for PDF/editorial smoke: ${response.status}`);
  }
  return String(payload.token);
};

const apiGet = async <T>(pathname: string, token: string) => {
  const response = await fetch(new URL(pathname, apiOrigin), {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || `GET ${pathname} failed: ${response.status}`);
  }
  return payload as T;
};

const requestJson = async <T>(pathname: string, token: string) => {
  const response = await fetch(new URL(pathname, apiOrigin), {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload: payload as T };
};

const findLessonWithPdf = (course: CourseRecord) => {
  for (const module of course.modules || []) {
    for (const lesson of module.lessons || []) {
      if ((lesson.attachments || []).length > 0 || lesson.notesUrl) {
        return lesson;
      }
    }
    for (const chapter of module.chapters || []) {
      for (const lesson of chapter.lessons || []) {
        if ((lesson.attachments || []).length > 0 || lesson.notesUrl) {
          return lesson;
        }
      }
    }
  }
  return null;
};

const findPdfTarget = (course: CourseRecord): PdfTarget | null => {
  for (const module of course.modules || []) {
    for (const lesson of module.lessons || []) {
      const attachment = (lesson.attachments || [])[0];
      if (attachment?.id) {
        return { attachmentId: attachment.id, title: lesson.title, source: 'lesson' };
      }
    }
    for (const chapter of module.chapters || []) {
      const chapterAttachment = ((chapter as { attachments?: Array<{ id: string; title?: string }> }).attachments || [])[0];
      if (chapterAttachment?.id) {
        return { attachmentId: chapterAttachment.id, title: chapter.title, source: 'chapter' };
      }
      for (const lesson of chapter.lessons || []) {
        const lessonAttachment = (lesson.attachments || [])[0];
        if (lessonAttachment?.id) {
          return { attachmentId: lessonAttachment.id, title: lesson.title, source: 'lesson' };
        }
      }
    }
  }
  return null;
};

const findPdfTargetById = (course: CourseRecord, attachmentId: string): PdfTarget | null => {
  const expectedAttachmentId = String(attachmentId || '').trim();
  if (!expectedAttachmentId) {
    return null;
  }

  for (const module of course.modules || []) {
    for (const lesson of module.lessons || []) {
      const attachment = (lesson.attachments || []).find((entry) => entry.id === expectedAttachmentId);
      if (attachment?.id) {
        return {
          attachmentId: attachment.id,
          title: attachment.title || lesson.title,
          source: 'lesson',
        };
      }
    }
    for (const chapter of module.chapters || []) {
      const chapterAttachment = (((chapter as { attachments?: Array<{ id: string; title?: string }> }).attachments) || [])
        .find((entry) => entry.id === expectedAttachmentId);
      if (chapterAttachment?.id) {
        return {
          attachmentId: chapterAttachment.id,
          title: chapterAttachment.title || chapter.title,
          source: 'chapter',
        };
      }
      for (const lesson of chapter.lessons || []) {
        const lessonAttachment = (lesson.attachments || []).find((entry) => entry.id === expectedAttachmentId);
        if (lessonAttachment?.id) {
          return {
            attachmentId: lessonAttachment.id,
            title: lessonAttachment.title || lesson.title,
            source: 'lesson',
          };
        }
      }
    }
  }

  return null;
};

const findSectionWithPdf = (course: CourseRecord) => {
  for (const module of course.modules || []) {
    for (const chapter of module.chapters || []) {
      const attachments = (chapter as { attachments?: Array<{ id: string; title?: string }> }).attachments || [];
      if (attachments.length > 0) {
        return { id: chapter.id, title: chapter.title, attachmentCount: attachments.length };
      }
    }
  }
  return null;
};

const findAttachmentInCourse = (course: CourseRecord | null | undefined, attachmentId: string): AttachmentProbe | null => {
  if (!course) {
    return null;
  }
  for (const module of course.modules || []) {
    for (const attachment of (module as { attachments?: Array<{ id: string; title?: string }> }).attachments || []) {
      if (attachment.id === attachmentId) {
        return { scope: 'module', title: attachment.title || module.title || 'Module PDF' };
      }
    }
    for (const lesson of module.lessons || []) {
      for (const attachment of lesson.attachments || []) {
        if (attachment.id === attachmentId) {
          return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF' };
        }
      }
    }
    for (const chapter of module.chapters || []) {
      for (const attachment of ((chapter as { attachments?: Array<{ id: string; title?: string }> }).attachments || [])) {
        if (attachment.id === attachmentId) {
          return { scope: 'chapter', title: attachment.title || chapter.title || 'Chapter PDF' };
        }
      }
      for (const lesson of chapter.lessons || []) {
        for (const attachment of lesson.attachments || []) {
          if (attachment.id === attachmentId) {
            return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF' };
          }
        }
      }
    }
  }
  return null;
};

const screenshot = async (page: puppeteer.Page, root: string, label: string) => {
  const screenshotPath = artifactPath(root, 'course-pdf-editorial', label, 'png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
};

const attachBrowserIssueCapture = (page: puppeteer.Page, issues: BrowserIssue[]) => {
  page.on('console', (message) => {
    const text = message.text();
    if (/Promise\.withResolvers|toHex|PDF could not be rendered/i.test(text)) {
      issues.push({ kind: 'console', text });
    }
  });
  page.on('pageerror', (error) => {
    const text = error instanceof Error ? error.message : String(error);
    if (/Promise\.withResolvers|toHex|PDF could not be rendered/i.test(text)) {
      issues.push({ kind: 'pageerror', text });
    }
  });
};

const validatePdfRange = async (courseId: string, attachmentId: string, token: string) => {
  const url = new URL(`/backend/api/courses/${courseId}/pdf-attachments/${attachmentId}/view`, apiOrigin);
  const first = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      range: 'bytes=0-65535',
      'x-edumaster-client-platform': 'web',
      'x-edumaster-client-browser': 'chrome',
      'x-edumaster-app': 'web',
    },
  });
  const firstBytes = await first.arrayBuffer();
  if (first.status !== 206) {
    throw new Error(`Expected first PDF range to return 206, got ${first.status}`);
  }
  if (!/^bytes 0-\d+\/\d+$/.test(first.headers.get('content-range') || '')) {
    throw new Error(`First PDF range returned invalid Content-Range: ${first.headers.get('content-range') || '(missing)'}`);
  }
  if ((first.headers.get('accept-ranges') || '').toLowerCase() !== 'bytes') {
    throw new Error('First PDF range did not advertise Accept-Ranges: bytes.');
  }
  if (firstBytes.byteLength <= 0 || firstBytes.byteLength > 65_536) {
    throw new Error(`First PDF range returned unexpected byte length: ${firstBytes.byteLength}`);
  }

  const second = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      range: 'bytes=65536-131071',
      'x-edumaster-client-platform': 'web',
      'x-edumaster-client-browser': 'chrome',
      'x-edumaster-app': 'web',
    },
  });
  if (![206, 416].includes(second.status)) {
    throw new Error(`Expected follow-up PDF range to return 206 or 416 for tiny PDFs, got ${second.status}`);
  }

  return {
    firstStatus: first.status,
    firstContentRange: first.headers.get('content-range'),
    firstBytes: firstBytes.byteLength,
    secondStatus: second.status,
    secondContentRange: second.headers.get('content-range'),
  };
};

const diagnoseUserVisibility = async ({
  label,
  email,
  password,
  courseId,
  attachmentId,
}: {
  label: string;
  email: string;
  password: string;
  courseId: string;
  attachmentId: string;
}): Promise<UserDiagnosis> => {
  const token = await login(email, password);
  const courseResponse = await requestJson<CourseRecord & {
    enrolled?: boolean;
    canAccessCourse?: boolean;
    accessReason?: string | null;
  }>(`/backend/api/courses/${encodeURIComponent(courseId)}`, token);
  const attachmentLocation = courseResponse.ok ? findAttachmentInCourse(courseResponse.payload, attachmentId) : null;
  const pdfProbe = await fetch(new URL(`/backend/api/courses/${encodeURIComponent(courseId)}/pdf-attachments/${encodeURIComponent(attachmentId)}/view`, apiOrigin), {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/pdf',
      range: 'bytes=0-65535',
      'x-edumaster-app': 'web',
      'x-edumaster-client-platform': 'windows',
      'x-edumaster-client-browser': 'chrome',
      'x-edumaster-device-id': `pdf-diag-${label}`,
      'x-edumaster-playback-tab-id': `pdf-diag-tab-${label}`,
      'x-edumaster-browser-tab-id': `pdf-diag-tab-${label}`,
    },
  });
  const buffer = await pdfProbe.arrayBuffer();

  return {
    label,
    email,
    courseStatus: courseResponse.status,
    attachmentVisibleInCourse: Boolean(attachmentLocation),
    attachmentLocation,
    enrolled: typeof courseResponse.payload?.enrolled === 'boolean' ? courseResponse.payload.enrolled : null,
    canAccessCourse: typeof courseResponse.payload?.canAccessCourse === 'boolean' ? courseResponse.payload.canAccessCourse : null,
    accessReason: courseResponse.payload?.accessReason || null,
    pdfStatus: pdfProbe.status,
    pdfOk: pdfProbe.ok || pdfProbe.status === 206,
    pdfContentType: pdfProbe.headers.get('content-type') || '',
    pdfContentRange: pdfProbe.headers.get('content-range'),
    pdfBytesRead: buffer.byteLength,
  };
};

const openAndAssertPdfReader = async (page: puppeteer.Page, root: string, label: string) => {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="course-pdf-open-button"]').length > 0,
    { timeout: 20_000 },
  );
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('[data-testid="course-pdf-open-button"]'))
      .find((entry) => entry instanceof HTMLButtonElement) as HTMLButtonElement | undefined;
    button?.click();
  });
  await page.waitForSelector('[data-testid="course-pdf-scroll-container"]', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const canvases = document.querySelectorAll('[data-testid="course-pdf-page"] canvas').length;
    const counter = document.querySelector('[data-testid="course-pdf-page-count"]');
    return canvases > 1 && /Page\s+\d+\s+\/\s+\d+/.test(counter?.textContent || '');
  }, { timeout: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const state = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="course-pdf-scroll-container"]') as HTMLElement | null;
    const pages = Array.from(document.querySelectorAll('[data-testid="course-pdf-page"]')) as HTMLElement[];
    const canvases = Array.from(document.querySelectorAll('[data-testid="course-pdf-page"] canvas')) as HTMLCanvasElement[];
    const pageCountText = document.querySelector('[data-testid="course-pdf-page-count"]')?.textContent || '';
    const pageCountMatch = pageCountText.match(/\/\s*(\d+)/);
    const declaredPageCount = pageCountMatch ? Number(pageCountMatch[1]) : 0;
    const maxCanvasWidth = canvases.reduce((max, canvas) => Math.max(max, canvas.getBoundingClientRect().width), 0);
    const scrollWidth = scroll?.scrollWidth || 0;
    const clientWidth = scroll?.clientWidth || 0;
    return {
      pageCountText,
      declaredPageCount,
      renderedPageCount: pages.length,
      scrollHeight: scroll?.scrollHeight || 0,
      clientHeight: scroll?.clientHeight || 0,
      scrollWidth,
      clientWidth,
      maxCanvasWidth,
      horizontalOverflow: scrollWidth > clientWidth + 4 || maxCanvasWidth > clientWidth + 4,
    };
  });
  if (state.declaredPageCount <= 1 || state.renderedPageCount <= 1) {
    throw new Error(`Expected multi-page PDF render, got ${JSON.stringify(state)}`);
  }
  if (state.scrollHeight <= state.clientHeight) {
    throw new Error(`Expected PDF reader to scroll vertically, got ${JSON.stringify(state)}`);
  }
  if (state.horizontalOverflow) {
    throw new Error(`Expected PDF reader to fit width without clipping, got ${JSON.stringify(state)}`);
  }
  const screenshotPath = await screenshot(page, root, label);
  await page.evaluate(() => {
    const close = Array.from(document.querySelectorAll('button')).find((button) => /close/i.test(button.textContent || '')) as HTMLButtonElement | undefined;
    close?.click();
  });
  await page.waitForSelector('[data-testid="course-pdf-scroll-container"]', { hidden: true, timeout: 15_000 }).catch(() => undefined);
  return { ...state, screenshotPath };
};

const runCompatibilityReaderProof = async ({
  token,
  courseId,
  screenshotDir,
}: {
  token: string;
  courseId: string;
  screenshotDir: string;
}) => {
  const browserIssues: BrowserIssue[] = [];
  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    attachBrowserIssueCapture(page, browserIssues);
    await page.evaluateOnNewDocument((jwt) => {
      window.localStorage.setItem('edumaster.jwt', jwt);
    }, token);
    await page.evaluateOnNewDocument(() => {
      try {
        delete (Promise as PromiseConstructor & { withResolvers?: unknown }).withResolvers;
      } catch {
        (Promise as PromiseConstructor & { withResolvers?: unknown }).withResolvers = undefined;
      }

      try {
        delete (Uint8Array.prototype as Uint8Array['prototype'] & { toHex?: unknown }).toHex;
      } catch {
        (Uint8Array.prototype as Uint8Array['prototype'] & { toHex?: unknown }).toHex = undefined;
      }
    });
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 12; SM-A127F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36');
    await page.setViewport({ width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${config.baseUrl.replace(/\/$/, '')}/?tab=courses&courseId=${encodeURIComponent(courseId)}`, {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="course-figma-page"]')),
      { timeout: 60_000 },
    );
    await page.evaluate(() => {
      const toggles = Array.from(document.querySelectorAll('[data-testid^="course-figma-chapter-"][data-testid$="-toggle"]')) as HTMLButtonElement[];
      toggles.filter((toggle) => toggle.getAttribute('aria-expanded') !== 'true').forEach((toggle) => toggle.click());
    });
    const readerState = await openAndAssertPdfReader(page, screenshotDir, 'android-compatibility-pdf-reader');
    const failingIssues = browserIssues.filter((issue) => /Promise\.withResolvers|toHex/.test(issue.text));
    if (failingIssues.length > 0) {
      throw new Error(`Android compatibility proof still saw runtime issues: ${JSON.stringify(failingIssues)}`);
    }
    return {
      ok: true,
      userAgent: await page.evaluate(() => navigator.userAgent),
      browserIssues,
      readerState,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const main = async () => {
  const env = await readEnvFile();
  const email = process.env.QA_ADMIN_EMAIL || process.env.QA_LOGIN_EMAIL || env.ADMIN_EMAIL || '';
  const password = process.env.QA_ADMIN_PASSWORD || process.env.QA_LOGIN_PASSWORD || env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    throw new Error('QA_ADMIN_EMAIL/QA_ADMIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD is required.');
  }

  const token = await login(email, password);
  const expectedCourseId = String(process.env.QA_COURSE_ID || '').trim();
  const expectedCourseText = String(process.env.QA_COURSE_TEXT || '').toLowerCase();
  const expectedPdfAttachmentId = String(process.env.QA_PDF_ATTACHMENT_ID || '').trim();
  const expectedPdfAttachmentTitle = String(process.env.QA_PDF_ATTACHMENT_TITLE || '').trim();

  const course = expectedCourseId
    ? await apiGet<CourseRecord>(`/backend/api/courses/${encodeURIComponent(expectedCourseId)}`, token)
    : null;
  const courses = expectedCourseId
    ? [course]
    : await apiGet<CourseRecord[]>('/backend/api/courses/admin/list', token);
  const selectedCourse = expectedCourseId
    ? course
    : courses.find((entry) => expectedCourseId && entry._id === expectedCourseId)
      || courses.find((entry) => expectedCourseText && entry.title.toLowerCase().includes(expectedCourseText))
      || courses.find((entry) => expectedPdfAttachmentId && Boolean(findPdfTargetById(entry, expectedPdfAttachmentId)))
      || courses.find((entry) => findLessonWithPdf(entry) || findSectionWithPdf(entry))
      || courses[0];
  if (!selectedCourse) {
    throw new Error('No course is available for PDF/editorial smoke.');
  }
  const lessonWithPdf = findLessonWithPdf(selectedCourse);
  const sectionWithPdf = findSectionWithPdf(selectedCourse);
  const pdfTarget = expectedPdfAttachmentId
    ? findPdfTargetById(selectedCourse, expectedPdfAttachmentId)
    : findPdfTarget(selectedCourse);
  if ((expectedCourseId || expectedCourseText || expectedPdfAttachmentId) && !pdfTarget) {
    throw new Error(`Selected course ${selectedCourse.title} does not expose the expected PDF attachment for the current user.`);
  }
  if (pdfTarget && expectedPdfAttachmentTitle) {
    const normalizedResolvedTitle = String(pdfTarget.title || '').trim().toLowerCase();
    const normalizedExpectedTitle = expectedPdfAttachmentTitle.toLowerCase();
    if (normalizedResolvedTitle && normalizedResolvedTitle !== normalizedExpectedTitle) {
      throw new Error(`Expected PDF title "${expectedPdfAttachmentTitle}" but resolved "${pdfTarget.title}".`);
    }
  }

  const rangeState = pdfTarget ? await validatePdfRange(selectedCourse._id, pdfTarget.attachmentId, token) : null;

  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    const browserIssues: BrowserIssue[] = [];
    attachBrowserIssueCapture(page, browserIssues);
    await page.evaluateOnNewDocument((jwt) => {
      window.localStorage.setItem('edumaster.jwt', jwt);
    }, token);
    await page.setViewport({ width: 1536, height: 1024, deviceScaleFactor: 1 });
    await page.goto(`${config.baseUrl.replace(/\/$/, '')}/?tab=courses&courseId=${encodeURIComponent(selectedCourse._id)}`, {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="course-figma-page"]')),
      { timeout: 60_000 },
    );
    await page.waitForSelector('[data-testid="course-figma-tabs"] button', { timeout: 15_000 });
    await page.evaluate(() => {
      const toggles = Array.from(document.querySelectorAll('[data-testid^="course-figma-chapter-"][data-testid$="-toggle"]')) as HTMLButtonElement[];
      toggles.filter((toggle) => toggle.getAttribute('aria-expanded') !== 'true').forEach((toggle) => toggle.click());
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="course-pdf-open-button"]').length > 0
        || document.querySelectorAll('[data-testid="lesson-pdf-list"]').length > 0
        || document.body.textContent?.includes('No PDFs have been uploaded yet.'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const desktopPath = await screenshot(page, ctx.screenshotDir, 'desktop-lessons');
    const desktopState = await page.evaluate((lessonTitle) => {
      const text = document.body.textContent || '';
      const tabs = Array.from(document.querySelectorAll('[data-testid="course-figma-tabs"] button'))
        .map((button) => (button.textContent || '').trim());
      const lessonCards = Array.from(document.querySelectorAll('[data-testid="lesson-pdf-list"]')) as HTMLElement[];
      const lessonPdfTexts = lessonCards.map((card) => card.textContent || '');
      return {
        tabs,
        hasLessonsTab: tabs.some((tab) => /^lessons$/i.test(tab)),
        hasEditorialTab: tabs.some((tab) => /^editorial$/i.test(tab)),
        hasCourseWideUploadedPdfPanel: /Uploaded PDFs/i.test(text),
        pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
        lessonPdfListCount: lessonCards.length,
        lessonPdfUnderExpectedLesson: lessonTitle
          ? lessonPdfTexts.some((entry) => entry.toLowerCase().includes(String(lessonTitle).toLowerCase()) || /lesson pdf/i.test(entry))
          : lessonCards.length > 0,
      };
    }, lessonWithPdf?.title || '');

    if (!desktopState.hasLessonsTab || !desktopState.hasEditorialTab) {
      throw new Error(`Desktop course tabs are wrong: ${desktopState.tabs.join(', ') || '(none)'}`);
    }
    if (desktopState.hasCourseWideUploadedPdfPanel) {
      throw new Error('Desktop course page still shows a broad Uploaded PDFs panel.');
    }
    if ((lessonWithPdf || sectionWithPdf) && desktopState.lessonPdfListCount <= 0) {
      throw new Error(`PDF for ${lessonWithPdf?.title || sectionWithPdf?.title} is not rendered inline under the lesson/chapter.`);
    }
    const desktopPdfReaderState = desktopState.pdfButtonCount > 0
      ? await openAndAssertPdfReader(page, ctx.screenshotDir, 'desktop-pdf-reader')
      : null;

    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[data-testid="course-figma-tabs"] button')) as HTMLElement[];
      tabs.find((tab) => /editorial/i.test(tab.textContent || ''))?.click();
    });
    await page.waitForSelector('[data-testid="course-editorial-tab"]', { timeout: 15_000 });
    const desktopEditorialPath = await screenshot(page, ctx.screenshotDir, 'desktop-editorial');
    const editorialState = await page.evaluate(() => ({
      text: document.body.textContent || '',
      pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
      editorialOpenButtonCount: document.querySelectorAll('[data-testid="course-editorial-open-button"]').length,
    }));
    if (/Uploaded PDFs/i.test(editorialState.text) || editorialState.pdfButtonCount > 0) {
      throw new Error('Editorial tab still contains PDF resources; it must contain editorial videos only.');
    }

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="course-figma-page"]')),
      { timeout: 60_000 },
    );
    await page.evaluate(() => {
      const toggles = Array.from(document.querySelectorAll('[data-testid^="course-figma-chapter-"][data-testid$="-toggle"]')) as HTMLButtonElement[];
      toggles.filter((toggle) => toggle.getAttribute('aria-expanded') !== 'true').forEach((toggle) => toggle.click());
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="course-pdf-open-button"]').length > 0
        || document.querySelectorAll('[data-testid="lesson-pdf-list"]').length > 0
        || document.body.textContent?.includes('No PDFs have been uploaded yet.'),
      { timeout: 20_000 },
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const mobileContentPath = await screenshot(page, ctx.screenshotDir, 'mobile-content');
    const mobileContentState = await page.evaluate(() => ({
      pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
    }));
    const mobilePdfReaderState = mobileContentState.pdfButtonCount > 0
      ? await openAndAssertPdfReader(page, ctx.screenshotDir, 'mobile-pdf-reader')
      : null;
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[data-testid="course-figma-tabs"] button')) as HTMLElement[];
      tabs.find((tab) => /editorial/i.test(tab.textContent || ''))?.click();
    });
    await page.waitForSelector('[data-testid="course-editorial-tab"]', { timeout: 15_000 });
    const mobileEditorialPath = await screenshot(page, ctx.screenshotDir, 'mobile-editorial');
    const mobileEditorialState = await page.evaluate(() => ({
      text: document.body.textContent || '',
      pdfButtonCount: document.querySelectorAll('[data-testid="course-pdf-open-button"]').length,
      uploadInputCount: document.querySelectorAll('[data-testid="lesson-doubt-file-input"], [data-testid="lesson-report-file-input"]').length,
    }));
    if (/Uploaded PDFs/i.test(mobileEditorialState.text) || mobileEditorialState.pdfButtonCount > 0) {
      throw new Error('Mobile Editorial tab still contains PDF resources.');
    }
    if (mobileEditorialState.uploadInputCount > 0) {
      throw new Error('Removed student support upload inputs are still visible.');
    }

    const crossUserDiagnosis = pdfTarget ? await Promise.all(
      [
        { label: 'admin', email, password },
        {
          label: 'student_working',
          email: process.env.QA_STUDENT_WORKING_EMAIL || '',
          password: process.env.QA_STUDENT_WORKING_PASSWORD || '',
        },
        {
          label: 'student_affected',
          email: process.env.QA_STUDENT_AFFECTED_EMAIL || '',
          password: process.env.QA_STUDENT_AFFECTED_PASSWORD || '',
        },
      ]
        .filter((entry) => entry.email && entry.password)
        .map((entry) => diagnoseUserVisibility({
          ...entry,
          courseId: selectedCourse._id,
          attachmentId: pdfTarget.attachmentId,
        })),
    ) : [];

    const compatibilityProof = pdfTarget
      ? await runCompatibilityReaderProof({
          token,
          courseId: selectedCourse._id,
          screenshotDir: ctx.screenshotDir,
        })
      : null;

    const summary = {
      ok: true,
      course: { id: selectedCourse._id, title: selectedCourse.title },
      lessonWithPdf: lessonWithPdf ? { id: lessonWithPdf.id, title: lessonWithPdf.title } : null,
      sectionWithPdf,
      pdfTarget,
      rangeState,
      crossUserDiagnosis,
      browserIssues,
      compatibilityProof,
      desktopState,
      desktopPdfReaderState,
      mobileContentState,
      mobilePdfReaderState,
      editorialState,
      mobileEditorialState,
      screenshots: {
        desktopLessons: desktopPath,
        desktopEditorial: desktopEditorialPath,
        mobileContent: mobileContentPath,
        mobileEditorial: mobileEditorialPath,
      },
    };
    await writeJson(path.join(ctx.analysisDir, 'course-pdf-editorial-smoke.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
