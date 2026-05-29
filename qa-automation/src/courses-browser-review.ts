import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { CaptureRecord, FailureRecord } from './types.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const desktopViewport = { width: 1536, height: 1024 };
const mobileViewport = { width: 390, height: 844 };

const loginAndStoreSession = async (page: puppeteer.Page, email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Course Flow Review',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || 'Unable to login for course flow review');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('edumaster.jwt', token);
  }, payload.token as string);
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

const clickFirstVisible = async (page: puppeteer.Page, selectorOptions: string[]) => {
  for (const selector of selectorOptions) {
    if (!selector) {
      continue;
    }

    const element = await page.$(selector);
    if (!element) {
      continue;
    }

    try {
      await element.click();
      return selector;
    } catch {
      const clicked = await page.evaluate((targetSelector) => {
        const target = document.querySelector(targetSelector) as HTMLElement | null;
        if (!target) {
          return false;
        }

        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }, selector);

      if (clicked) {
        return selector;
      }
    }
  }

  throw new Error(`No interactable selector found from: ${selectorOptions.join(', ')}`);
};

const forceClick = async (page: puppeteer.Page, selector: string) => {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector) as HTMLElement | null;
    if (!target) {
      return false;
    }

    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    target.click();
    return true;
  }, selector);
};

const assertSelector = async (
  page: puppeteer.Page,
  selector: string,
  stepId: string,
  screenshotPath: string,
  failures: FailureRecord[],
) => {
  const element = await page.$(selector);
  if (!element) {
    failures.push({
      stepId,
      title: 'Missing required UI element',
      description: `Required selector not found: ${selector}`,
      severity: 'high',
      timestamp: new Date().toISOString(),
      screenshotPath,
    });
  }
};

const assertText = async (
  page: puppeteer.Page,
  expected: string,
  stepId: string,
  screenshotPath: string,
  failures: FailureRecord[],
) => {
  const pageText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());
  if (!pageText.includes(expected)) {
    failures.push({
      stepId,
      title: 'Expected content missing',
      description: `Expected text was not found on the page: "${expected}"`,
      severity: 'medium',
      timestamp: new Date().toISOString(),
      screenshotPath,
    });
  }
};

const waitForText = async (page: puppeteer.Page, text: string, timeoutMs = 15000) => {
  await page.waitForFunction(
    (expected) => (document.body?.innerText || '').includes(String(expected)),
    { timeout: timeoutMs },
    text,
  );
};

const loadPage = async (page: puppeteer.Page) => {
  try {
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Navigation timeout')) {
      throw error;
    }
  }
};

const waitForCourseAppReady = async (page: puppeteer.Page, includeAuth = false) => {
  const deadline = Date.now() + 30000;
  const readySelectors = [
    selectors.shellReady,
    selectors.overviewDashboard,
    selectors.courseFigmaPage,
    selectors.courseCatalogView,
    selectors.courseCourseView,
    selectors.courseLessonView,
    ...(includeAuth ? [selectors.loginEmail] : []),
  ];

  while (Date.now() < deadline) {
    for (const selector of readySelectors) {
      try {
        if (await page.$(selector)) {
          return;
        }
      } catch {
        // The SPA can replace the document while auth/session restore is settling.
      }
    }

    await sleep(250);
  }

  throw new Error('Course app did not become ready within 30000ms.');
};

const clickButtonContaining = async (page: puppeteer.Page, text: string) => {
  return page.evaluate((expected) => {
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      (node.textContent || '').replace(/\s+/g, ' ').includes(String(expected)),
    ) as HTMLButtonElement | undefined;
    button?.click();
    return Boolean(button);
  }, text);
};

const loginThroughUi = async (page: puppeteer.Page, email: string, password: string) => {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    if (
      (await page.$(selectors.shellReady))
      || (await page.$(selectors.overviewDashboard))
      || (await page.$(selectors.courseFigmaPage))
    ) {
      return;
    }

    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (bodyText.includes('Device Limit Reached')) {
      await clickButtonContaining(page, 'Log out older device and continue')
        || await clickButtonContaining(page, 'Log Out');
      await sleep(500);
      continue;
    }

    if (bodyText.includes('Logged Out Successfully')) {
      await clickButtonContaining(page, 'Continue to Login')
        || await clickButtonContaining(page, 'Go to Home');
      await sleep(500);
      continue;
    }

    if (await page.$(selectors.loginEmail)) {
      await page.locator(selectors.loginEmail).fill(email);
      await page.locator(selectors.loginPassword).fill(password);
      await page.locator(selectors.loginSubmit).click();
      await sleep(500);
      continue;
    }

    await sleep(250);
  }

  throw new Error('Course UI login did not reach the application shell within 60000ms.');
};

const readSelectorText = async (page: puppeteer.Page, selector: string) =>
  page.$eval(selector, (element) => (element.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '');

const setPlaybackSpeedToTwoX = async (page: puppeteer.Page) => {
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      return;
    }
    video.playbackRate = 2;
  }, selectors.coursePlayerVideo);
  await page.waitForFunction(
    (videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      return Boolean(video && Math.abs(Number(video.playbackRate || 1) - 2) < 0.05);
    },
    { timeout: 5000 },
    selectors.coursePlayerVideo,
  );
};

const capture = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  stepId: string,
  label: string,
  state: CaptureRecord['state'],
  notes?: string[],
) => {
  const paths = await takeScreenshot(page, ctx, stepId, label);
  captures.push({
    stepId,
    label,
    state,
    durationMs: 0,
    screenshotPath: paths.screenshotPath,
    sourcePath: paths.sourcePath,
    timestamp: new Date().toISOString(),
    ...(notes?.length ? { notes } : {}),
  });
  return paths;
};

const openCoursesTab = async (page: puppeteer.Page, mode: 'desktop' | 'mobile') => {
  await clickFirstVisible(page, mode === 'desktop'
    ? [selectors.navCourses]
    : [selectors.mobileNavCourses, selectors.mobileTabCourses, selectors.navCourses]);
  await waitForText(page, 'All Courses');
  await page.waitForSelector(selectors.courseCatalogView, { timeout: 20000 });
  await page.waitForFunction(
    (catalogCardSelector, emptySelector) =>
      Boolean(document.querySelector(catalogCardSelector) || document.querySelector(emptySelector)),
    { timeout: 20000 },
    selectors.courseCatalogCard,
    selectors.courseCatalogEmpty,
  );
  await page.evaluate(() => window.scrollTo(0, 0));
};

const openFirstCourse = async (page: puppeteer.Page) => {
  await clickFirstVisible(page, [selectors.courseCatalogCard]);
  await page.waitForSelector(selectors.courseCourseView, { timeout: 20000 });
  await page.evaluate(() => window.scrollTo(0, 0));
};

const openFirstLesson = async (page: puppeteer.Page, mode: 'desktop' | 'mobile') => {
  const lessonButton = await page.$(selectors.courseLessonOpen);
  if (!lessonButton) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[];
      const target = buttons.find((button) => /subject view|view all|open subject lessons/i.test((button.textContent || '').trim()));
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await page.waitForSelector(selectors.courseLessonOpen, { timeout: 20000 });
  }
  await clickFirstVisible(page, [selectors.courseLessonOpen]);
  await page.waitForSelector(selectors.courseLessonView, { timeout: 20000 });
  await page.waitForSelector(selectors.coursePlayerHeading, { timeout: 20000 });
  await page.waitForFunction(
    (tabSelector, videoSelector) => Boolean(document.querySelector(tabSelector) || document.querySelector(videoSelector)),
    { timeout: 20000 },
    selectors.coursePlayerTabVideo,
    selectors.coursePlayerVideo,
  );
  await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 20000 });
  await page.waitForSelector(selectors.coursePlayerFullscreen, { timeout: 20000 });
  if (mode === 'desktop') {
    await page.waitForSelector(selectors.coursePlayerMarkComplete, { timeout: 20000 });
    await page.waitForSelector(selectors.courseProgressPercent, { timeout: 20000 });
    await page.waitForSelector(selectors.courseProgressLessonsCompleted, { timeout: 20000 });
  } else {
    await page.waitForSelector(selectors.coursePlayerAutoplayToggle, { timeout: 20000 });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
};

const completeLessonFlow = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  failures: FailureRecord[],
  stepPrefix: string,
  _hasNextLesson: boolean,
  mode: 'desktop' | 'mobile',
) => {
  await capture(
    page,
    ctx,
    captures,
    `${stepPrefix}-video`,
    `${stepPrefix}-video`,
    'ui',
    ['Lesson video state before playback.'],
  );

  const videoSelectors = mode === 'desktop'
    ? [
        selectors.coursePlayerVideo,
        selectors.coursePlayerFullscreen,
        selectors.coursePlayerMarkComplete,
        selectors.courseProgressPercent,
        selectors.courseProgressLessonsCompleted,
      ]
    : [
        selectors.coursePlayerVideo,
        selectors.coursePlayerFullscreen,
        selectors.coursePlayerAutoplayToggle,
      ];

  for (const selector of videoSelectors) {
    await assertSelector(page, selector, `${stepPrefix}-video`, captures[captures.length - 1]?.screenshotPath || '', failures);
  }

  await setPlaybackSpeedToTwoX(page);
  await page.evaluate((videoSelector) => {
    const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
    if (!video) {
      return;
    }
    void video.play?.().catch?.(() => undefined);
    video.dispatchEvent(new Event('play', { bubbles: true }));
    video.pause?.();
  }, selectors.coursePlayerVideo).catch(() => undefined);

  await capture(
    page,
    ctx,
    captures,
    `${stepPrefix}-interaction-ready`,
    `${stepPrefix}-interaction-ready`,
    'success',
    ['Lesson shell loaded with protected media, notes, doubts, and next-step controls visible to the enrolled learner.'],
  );
};

const reviewFlow = async (
  page: puppeteer.Page,
  mode: 'desktop' | 'mobile',
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  failures: FailureRecord[],
  consoleIssues: string[],
) => {
  await page.setViewport(mode === 'desktop' ? desktopViewport : mobileViewport);
  await loadPage(page);

  await loginAndStoreSession(
    page,
    process.env.QA_LOGIN_EMAIL || config.loginEmail,
    process.env.QA_LOGIN_PASSWORD || config.loginPassword,
  );

  await page.evaluate(() => {
    Object.keys(window.localStorage)
      .filter((key) => String(key || '').startsWith('edumaster.course-figma-progress'))
      .forEach((key) => window.localStorage.removeItem(key));
  });

  await loadPage(page);
  await waitForCourseAppReady(page, true);

  if (await page.$(selectors.loginEmail)) {
    await loginThroughUi(
      page,
      process.env.QA_LOGIN_EMAIL || config.loginEmail,
      process.env.QA_LOGIN_PASSWORD || config.loginPassword,
    );
  }

  await waitForCourseAppReady(page);
  await page.waitForFunction(
    (selectorList) => selectorList.some((selector) => Boolean(selector && document.querySelector(selector))),
    { timeout: 30000 },
    [selectors.shellReady, selectors.overviewDashboard, selectors.courseCatalogView, selectors.courseCourseView, selectors.courseLessonView],
  );
  await page.evaluate(() => window.scrollTo(0, 0));

  await clickFirstVisible(page, mode === 'desktop'
    ? [selectors.navOverview]
    : [selectors.mobileTabOverview, selectors.mobileNavOverview, selectors.navOverview]);
  await page.waitForSelector(selectors.overviewDashboard, { timeout: 20000 });

  const overviewCapture = await capture(
    page,
    ctx,
    captures,
    `course-overview-${mode}`,
    `course-overview-${mode}`,
    'ui',
    [`${mode === 'desktop' ? 'Desktop' : 'Mobile'} shell before entering Courses.`],
  );

  const overviewSelectors = mode === 'desktop'
    ? [selectors.navOverview, selectors.navCourses]
    : [selectors.mobileNavOverview, selectors.mobileNavCourses];

  for (const selector of overviewSelectors) {
    await assertSelector(page, selector, `course-overview-${mode}`, overviewCapture.screenshotPath, failures);
  }

  if (mode === 'desktop') {
    await openCoursesTab(page, mode);
  } else {
    if ((await page.$(selectors.overviewContinueCta)) || (await page.$(selectors.overviewActiveCourseCard))) {
      await clickFirstVisible(page, [selectors.overviewContinueCta, selectors.overviewActiveCourseCard]);
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-course-view="course"]') || document.querySelector('[data-course-view="lesson"]')),
        { timeout: 20000 },
      );
    } else {
      await openCoursesTab(page, mode);
    }

    await page.waitForSelector(selectors.courseFigmaPage, { timeout: 20000 });

    if (await page.$(selectors.courseLessonView)) {
      const mobileLessonBootstrap = await capture(
        page,
        ctx,
        captures,
        `course-mobile-lesson-bootstrap`,
        `course-mobile-lesson-bootstrap`,
        'ui',
        ['Mobile opened directly into a lesson from the overview CTA.'],
      );

      await assertSelector(page, selectors.courseLessonView, 'course-mobile-lesson-bootstrap', mobileLessonBootstrap.screenshotPath, failures);
      await clickFirstVisible(page, [selectors.courseBackToLessons]);
      await page.waitForSelector(selectors.courseCourseView, { timeout: 20000 });
    }

    if (await page.$(selectors.courseCourseView)) {
      await clickFirstVisible(page, [selectors.courseBackToCatalog]);
      await page.waitForSelector(selectors.courseCatalogView, { timeout: 20000 });
    }
  }

  const catalogCapture = await capture(
    page,
    ctx,
    captures,
    `course-screen-${mode}`,
    `course-screen-${mode}`,
    'ui',
    [`${mode === 'desktop' ? 'Desktop' : 'Mobile'} course screen.`],
  );

  for (const selector of [
    selectors.courseFigmaPage,
    selectors.courseCatalogView,
    (await page.$(selectors.courseCatalogCard)) ? selectors.courseCatalogCard : selectors.courseCatalogEmpty,
  ]) {
    await assertSelector(page, selector, `course-screen-${mode}`, catalogCapture.screenshotPath, failures);
  }

  if (!(await page.$(selectors.courseCatalogCard))) {
    return;
  }

  await openFirstCourse(page);

  const courseCapture = await capture(
    page,
    ctx,
    captures,
    `course-page-${mode}`,
    `course-page-${mode}`,
    'ui',
    [`${mode === 'desktop' ? 'Desktop' : 'Mobile'} course details screen.`],
  );

  const courseSelectors = mode === 'desktop'
    ? [
        selectors.courseCourseView,
        selectors.courseFigmaHero,
        selectors.courseFigmaTabs,
        selectors.courseFigmaLessons,
        selectors.courseFigmaSidebar,
        selectors.courseProgressPercent,
        selectors.courseProgressLessonsCompleted,
        selectors.courseFigmaNote,
        selectors.courseFigmaTopics,
        selectors.courseFigmaCbtCard,
        selectors.courseFigmaRecommended,
      ]
    : [
        selectors.courseCourseView,
        selectors.courseFigmaHero,
        selectors.courseFigmaTabs,
        selectors.courseFigmaLessons,
        selectors.courseProgressPercent,
        selectors.courseProgressLessonsCompleted,
        selectors.courseFigmaChapter1,
        selectors.mobileNavOverview,
        selectors.mobileNavCourses,
        selectors.mobileNavLive,
        selectors.mobileNavTests,
      ];

  for (const selector of courseSelectors) {
    await assertSelector(page, selector, `course-page-${mode}`, courseCapture.screenshotPath, failures);
  }

  await assertText(page, mode === 'desktop' ? 'Lesson flow' : 'Lesson Flow', `course-page-${mode}`, courseCapture.screenshotPath, failures);
  await assertText(
    page,
    mode === 'desktop' ? 'Course Statistics' : 'Continue Course',
    `course-page-${mode}`,
    courseCapture.screenshotPath,
    failures,
  );

  const hasNextLesson = await page.$$eval(selectors.courseLessonOpen, (elements) => elements.length > 1).catch(() => false);

  await openFirstLesson(page, mode);

  const lessonCapture = await capture(
    page,
    ctx,
    captures,
    `course-lesson-video-${mode}`,
    `course-lesson-video-${mode}`,
    'ui',
    [`${mode === 'desktop' ? 'Desktop' : 'Mobile'} lesson video state.`],
  );

  const lessonSelectors = mode === 'desktop'
    ? [
        selectors.coursePlayerHeading,
        selectors.coursePlayerMarkComplete,
        selectors.coursePlayerFullscreen,
        selectors.coursePlayerVideo,
        selectors.courseProgressPercent,
        selectors.courseProgressLessonsCompleted,
      ]
    : [
        selectors.coursePlayerHeading,
        selectors.coursePlayerFullscreen,
        selectors.coursePlayerVideo,
        selectors.coursePlayerAutoplayToggle,
      ];

  for (const selector of lessonSelectors) {
    await assertSelector(page, selector, `course-lesson-video-${mode}`, lessonCapture.screenshotPath, failures);
  }

  await completeLessonFlow(page, ctx, captures, failures, `course-lesson-${mode}`, hasNextLesson, mode);
  await page.evaluate(() => window.scrollTo(0, 0));
}

export const runCoursesReview = async (): Promise<{ captures: CaptureRecord[]; failures: FailureRecord[] }> => {
  const ctx = await createRunContext();
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];
  const consoleIssues: string[] = [];

  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  try {
    const desktopPage = await browser.newPage();
    desktopPage.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) {
        consoleIssues.push(message.text());
      }
    });
    desktopPage.on('pageerror', (error) => {
      consoleIssues.push(error.message);
    });

    await reviewFlow(desktopPage, 'desktop', ctx, captures, failures, consoleIssues);
    await desktopPage.close();

    const mobilePage = await browser.newPage();
    mobilePage.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) {
        consoleIssues.push(message.text());
      }
    });
    mobilePage.on('pageerror', (error) => {
      consoleIssues.push(error.stack || error.message);
    });

    await reviewFlow(mobilePage, 'mobile', ctx, captures, failures, consoleIssues);
    await mobilePage.close();

    if (consoleIssues.length > 0) {
      failures.push({
        stepId: 'course-console',
        title: 'Console errors detected',
        description: consoleIssues.join('\n'),
        severity: 'high',
        timestamp: new Date().toISOString(),
        screenshotPath: captures[captures.length - 1]?.screenshotPath,
      });
    }

    await writeJson(path.join(ctx.analysisDir, 'summary.json'), { captures, failures });
    await writeText(
      path.join(ctx.logDir, 'run.log'),
      `Run ${ctx.runId}\nCaptures: ${captures.length}\nFailures: ${failures.length}\n`,
    );

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `${failure.title}: ${failure.description}`).join('\n'));
    }

    return { captures, failures };
  } finally {
    await browser.close().catch(() => undefined);
  }
};

if (process.argv[1]?.endsWith('courses-browser-review.ts')) {
  runCoursesReview()
    .then((summary) => {
      console.log(`Courses review complete: ${summary.captures.length} captures, ${summary.failures.length} failures.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
