import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:3000';
const apiBaseUrl = process.env.QA_API_BASE_URL || `${baseUrl.replace(/\/+$/, '')}/backend/api`;
const chromeExecutable = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const adminEmail = process.env.ADMIN_EMAIL || process.env.QA_LOGIN_EMAIL || '';
const adminPassword = process.env.ADMIN_PASSWORD || process.env.QA_LOGIN_PASSWORD || '';
const videoPath = path.resolve(process.cwd(), 'uploads/live-fallback.mp4');
const artifactRoot = path.resolve(process.cwd(), 'qa-automation/artifacts');

const courseTitle = 'English';
const moduleTitle = 'English Foundation';
const chapterSpecs = Array.from({ length: 40 }, (_, index) => {
  const chapterNumber = index + 1;
  const padded = String(chapterNumber).padStart(2, '0');
  if (chapterNumber === 1) {
    return { title: 'Chapter 1 - Basics', lessonTitle: 'English Short Video 1' };
  }
  if (chapterNumber === 2) {
    return { title: 'Chapter 2 - Grammar', lessonTitle: 'English Short Video 2' };
  }
  if (chapterNumber === 3) {
    return { title: 'Chapter 3 - Vocabulary', lessonTitle: 'English Short Video 3' };
  }
  return {
    title: `Chapter ${padded} - English Practice ${padded}`,
    lessonTitle: `English Short Video ${chapterNumber}`,
  };
});

type AuthPayload = { token: string };
type Course = {
  _id: string;
  title: string;
  modules?: Array<{
    id: string;
    title: string;
    chapters?: Array<{
      id: string;
      title: string;
      lessons?: Array<{ id: string; title: string }>;
    }>;
    lessons?: Array<{ id: string; title: string }>;
  }>;
};

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureDir = async (target: string) => {
  await fs.mkdir(target, { recursive: true });
};

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const requestJson = async <T>(input: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload as any)?.message || (payload as any)?.error || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
};

const login = async () => {
  if (!adminEmail || !adminPassword) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be available in the environment.');
  }

  return requestJson<AuthPayload>(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      device: 'english-course-seed-and-verify',
      forceLogoutOtherSessions: true,
    }),
  });
};

const authHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
});

const getCourses = async (token: string) =>
  requestJson<Course[]>(`${apiBaseUrl}/courses`, {
    headers: authHeaders(token),
  });

const createCourse = async (token: string) =>
  requestJson<Course>(`${apiBaseUrl}/courses`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: courseTitle,
      description: 'English course created by QA automation for chapter upload verification.',
      category: 'Language',
      exam: 'Spoken English',
      subject: 'English',
      instructor: 'VARONENGLISH Faculty',
      level: 'Full Course',
      price: 1500,
      validityDays: 365,
    }),
  });

const addModule = async (token: string, courseId: string) =>
  requestJson<{ course: Course; module: { id: string; title: string } }>(`${apiBaseUrl}/courses/${courseId}/modules`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: moduleTitle,
      description: 'Subject tree for automated English course verification.',
      order: 1,
    }),
  });

const addChapter = async (token: string, courseId: string, moduleId: string, title: string, order: number) =>
  requestJson<{ course: Course; chapter: { id: string; title: string } }>(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/chapters`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description: `${title} created by QA automation.`,
      order,
    }),
  });

const uploadLessonVideo = async (
  token: string,
  courseId: string,
  moduleId: string,
  chapterId: string,
  lessonTitle: string,
) => {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const buffer = await fs.readFile(videoPath);
      const file = new File([buffer], path.basename(videoPath), { type: 'video/mp4' });
      const formData = new FormData();
      formData.append('video', file);
      formData.append('lessonTitle', lessonTitle);
      formData.append('durationMinutes', '1');
      formData.append('isPremium', 'true');
      formData.append('lessonType', 'video');
      formData.append('chapterId', chapterId);

      return await requestJson<{ message: string; video: { id: string; title: string } }>(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos`, {
        method: 'POST',
        headers: authHeaders(token),
        body: formData,
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 4) {
        await sleep(1500 * attempt);
      }
    }
  }

  throw lastError || new Error(`Upload failed for ${lessonTitle}`);
};

const waitForServer = async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the app is ready.
    }
    await sleep(1000);
  }
  throw new Error(`App did not become ready at ${baseUrl} within 90 seconds.`);
};

const clickByText = async (page: puppeteer.Page, selector: string, text: string) => {
  const clicked = await page.evaluate(
    ({ targetSelector, expected }) => {
      const nodes = Array.from(document.querySelectorAll(targetSelector));
      const target = nodes.find((node) => (node.textContent || '').replace(/\s+/g, ' ').includes(expected)) as HTMLElement | undefined;
      if (!target) {
        return false;
      }
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.click();
      return true;
    },
    { targetSelector: selector, expected: text },
  );
  if (!clicked) {
    throw new Error(`Unable to click "${text}" using selector ${selector}`);
  }
};

const screenshot = async (page: puppeteer.Page, targetPath: string) => {
  await page.screenshot({ path: targetPath, fullPage: true });
};

const selectOptionByText = async (page: puppeteer.Page, selector: string, text: string) => {
  let optionValue: string | null = null;
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline && !optionValue) {
    optionValue = await page.$eval(
      selector,
      (selectElement, expectedText) => {
        const options = Array.from((selectElement as HTMLSelectElement).options);
        const match = options.find((option) => option.textContent?.trim() === String(expectedText).trim());
        return match?.value || null;
      },
      text,
    );

    if (!optionValue) {
      await sleep(500);
    }
  }

  if (!optionValue) {
    throw new Error(`Unable to find option "${text}" for selector ${selector}`);
  }

  await page.select(selector, optionValue);
  await sleep(750);
  return optionValue;
};

const selectLabeledOption = async (page: puppeteer.Page, labelText: string, optionText: string, occurrence = 0) => {
  const selector = await page.evaluate(({ expectedLabel, expectedOccurrence }) => {
    const labels = Array.from(document.querySelectorAll('label'));
    const matchingLabels = labels.filter((node) => (node.textContent || '').replace(/\s+/g, ' ').includes(String(expectedLabel)));
    const label = matchingLabels[Number(expectedOccurrence) || 0];
    if (!label) {
      return null;
    }
    const scope = label.parentElement;
    const select = scope?.querySelector('select');
    if (!select) {
      return null;
    }
    if (!select.id) {
      select.id = `qa-select-${String(expectedLabel).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    }
    return `#${select.id}`;
  }, { expectedLabel: labelText, expectedOccurrence: occurrence });

  if (!selector) {
    throw new Error(`Unable to locate select for label "${labelText}"`);
  }

  return selectOptionByText(page, selector, optionText);
};

const waitForAppOrLogin = async (page: puppeteer.Page, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shellReady = await page.$('[data-testid="shell-ready"]');
    if (shellReady) {
      return 'shell';
    }
    const loginEmailInput = await page.$('[data-testid="auth-login-email"]');
    if (loginEmailInput) {
      return 'login';
    }
    await sleep(500);
  }
  return 'timeout';
};

const main = async () => {
  await waitForServer();
  const loginPayload = await login();
  const token = loginPayload.token;
  const runDir = path.join(artifactRoot, `english-course-seed-${nowStamp()}`);
  await ensureDir(runDir);

  let courses = await getCourses(token);
  let course = courses.find((entry) => String(entry.title || '').trim().toLowerCase() === courseTitle.toLowerCase()) || null;
  if (!course) {
    course = await createCourse(token);
  }

  let moduleEntry = (course.modules || []).find((entry) => String(entry.title || '').trim().toLowerCase() === moduleTitle.toLowerCase()) || null;
  if (!moduleEntry) {
    await addModule(token, course._id);
    courses = await getCourses(token);
    course = courses.find((entry) => entry._id === course!._id) || course;
    moduleEntry = (course.modules || []).find((entry) => String(entry.title || '').trim().toLowerCase() === moduleTitle.toLowerCase()) || null;
  }
  if (!moduleEntry) {
    throw new Error('Module creation succeeded but the module could not be reloaded.');
  }

  const uploadResults: Array<{ chapterTitle: string; lessonTitle: string; uploaded: boolean }> = [];
  for (const [index, chapterSpec] of chapterSpecs.entries()) {
    let chapterEntry = (moduleEntry.chapters || []).find((entry) => String(entry.title || '').trim().toLowerCase() === chapterSpec.title.toLowerCase()) || null;
    if (!chapterEntry) {
      await addChapter(token, course._id, moduleEntry.id, chapterSpec.title, index + 1);
      courses = await getCourses(token);
      course = courses.find((entry) => entry._id === course!._id) || course;
      moduleEntry = (course.modules || []).find((entry) => entry.id === moduleEntry!.id) || moduleEntry;
      chapterEntry = (moduleEntry.chapters || []).find((entry) => String(entry.title || '').trim().toLowerCase() === chapterSpec.title.toLowerCase()) || null;
    }
    if (!chapterEntry) {
      throw new Error(`Chapter "${chapterSpec.title}" could not be created.`);
    }

    const lessonExists = (chapterEntry.lessons || []).some((lesson) => String(lesson.title || '').trim().toLowerCase() === chapterSpec.lessonTitle.toLowerCase());
    if (!lessonExists) {
      await uploadLessonVideo(token, course._id, moduleEntry.id, chapterEntry.id, chapterSpec.lessonTitle);
      uploadResults.push({ chapterTitle: chapterSpec.title, lessonTitle: chapterSpec.lessonTitle, uploaded: true });
      await sleep(1500);
      courses = await getCourses(token);
      course = courses.find((entry) => entry._id === course!._id) || course;
      moduleEntry = (course.modules || []).find((entry) => entry.id === moduleEntry!.id) || moduleEntry;
    } else {
      uploadResults.push({ chapterTitle: chapterSpec.title, lessonTitle: chapterSpec.lessonTitle, uploaded: false });
    }
  }

  const finalCourse = (await getCourses(token)).find((entry) => entry._id === course._id);
  if (!finalCourse) {
    throw new Error('Final course verification failed because the course could not be reloaded.');
  }

  for (const chapterSpec of chapterSpecs) {
    const chapter = ((finalCourse.modules || []).find((entry) => entry.id === moduleEntry.id)?.chapters || [])
      .find((entry) => String(entry.title || '').trim().toLowerCase() === chapterSpec.title.toLowerCase());
    if (!chapter) {
      throw new Error(`Final verification failed: chapter "${chapterSpec.title}" is missing.`);
    }
    const lesson = (chapter.lessons || []).find((entry) => String(entry.title || '').trim().toLowerCase() === chapterSpec.lessonTitle.toLowerCase());
    if (!lesson) {
      throw new Error(`Final verification failed: lesson "${chapterSpec.lessonTitle}" is missing inside "${chapterSpec.title}".`);
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromeExecutable,
    defaultViewport: { width: 1440, height: 2200 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.evaluate((jwtToken) => {
      window.localStorage.setItem('edumaster.jwt', jwtToken);
    }, token);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    const appState = await waitForAppOrLogin(page, 60_000);
    if (appState === 'login') {
      await page.type('[data-testid="auth-login-email"]', adminEmail);
      await page.type('[data-testid="auth-login-password"]', adminPassword);
      await page.click('[data-testid="auth-login-submit"]');
      await page.waitForSelector('[data-testid="shell-ready"]', { timeout: 60_000 });
    } else if (appState !== 'shell') {
      await screenshot(page, path.join(runDir, '00-app-load-failure.png'));
      throw new Error('The course app did not reach the shell or login screen in time.');
    }

    await page.click('[data-testid="nav-admin"]');
    await page.waitForSelector('[data-testid="admin-section-curriculum"]', { timeout: 30_000 });
    await page.click('[data-testid="admin-section-curriculum"]');
    await page.waitForFunction(
      () => (document.body?.innerText || '').includes('Subject, Chapter & Topic Structure')
        && (document.body?.innerText || '').includes('Video Upload Manager'),
      { timeout: 30_000 },
    );

    await selectLabeledOption(page, 'Select Course', courseTitle, 0);
    await sleep(1200);
    await screenshot(page, path.join(runDir, `01-${slugify(courseTitle)}-curriculum-structure.png`));

    let bodyText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());
    if (!bodyText.includes(moduleTitle)) {
      throw new Error(`UI verification failed: module title "${moduleTitle}" was not visible in admin curriculum view.`);
    }
    for (const chapterSpec of chapterSpecs) {
      if (!bodyText.includes(chapterSpec.title)) {
        throw new Error(`UI verification failed: chapter title "${chapterSpec.title}" was not visible in admin curriculum view.`);
      }
    }

    await screenshot(page, path.join(runDir, `02-${slugify(courseTitle)}-admin-curriculum.png`));
  } finally {
    await browser.close();
  }

  const summary = {
    verifiedAt: new Date().toISOString(),
    baseUrl,
    apiBaseUrl,
    courseTitle: finalCourse.title,
    courseId: finalCourse._id,
    moduleTitle,
    moduleId: moduleEntry.id,
    chapters: chapterSpecs,
    uploads: uploadResults,
    artifactDirectory: runDir,
  };

  await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
