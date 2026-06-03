import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { CaptureRecord, FailureRecord, StepDefinition } from './types.js';
import { artifactPath, createRunContext, writeJson, writeText } from './utils.js';

const baseUrl = process.env.QA_BASE_URL || config.baseUrl;

const apiOrigin = (() => {
  const url = new URL(baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const step: StepDefinition = {
  id: 'overview-dashboard',
  label: 'overview-dashboard',
  requiredSelectors: [
    selectors.overviewDashboard,
    selectors.overviewTopbar,
    selectors.overviewActionQueue,
    selectors.overviewActiveCourses,
    selectors.overviewSignals,
    selectors.overviewStreak,
    selectors.overviewScoreSummary,
    selectors.overviewScoreCard,
    selectors.overviewUpcomingTests,
  ],
  expectedTexts: [
    'Welcome back',
    'Performance Overview',
    'Learning Activity',
    'Tests',
    'Latest Result',
  ],
};

const loginAndStoreSession = async (page: puppeteer.Page, email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Overview Review',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || 'Unable to login for overview review');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('edumaster.jwt', token);
  }, payload.token as string);
};

const takeScreenshot = async (page: puppeteer.Page, ctx: Awaited<ReturnType<typeof createRunContext>>, label: string) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, step.id, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, step.id, label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

const clickFirstVisible = async (page: puppeteer.Page, selectorOptions: string[]) => {
  for (const selector of selectorOptions) {
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

const waitForOverviewAppReady = async (page: puppeteer.Page, includeAuth = false) => {
  const deadline = Date.now() + 45000;
  const readySelectors = [
    selectors.shellReady,
    selectors.overviewDashboard,
    selectors.navOverview,
    selectors.mobileNavOverview,
    ...(includeAuth ? [selectors.loginEmail] : []),
  ];

  while (Date.now() < deadline) {
    for (const selector of readySelectors) {
      try {
        if (await page.$(selector)) {
          return;
        }
      } catch {
        // The SPA may swap frames during auth restore; keep polling the new document.
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Overview app did not become ready within 45000ms.');
};

const loadPage = async (page: puppeteer.Page) => {
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Navigation timeout')) {
      throw error;
    }
  }
};

const gotoOverview = async (page: puppeteer.Page) => {
  await loadPage(page);
  await waitForOverviewAppReady(page);
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
  await page.locator(selectors.loginEmail).fill(email);
  await page.locator(selectors.loginPassword).fill(password);
  await page.locator(selectors.loginSubmit).click();

  await waitForOverviewAppReady(page, true);
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  if (bodyText.includes('Device Limit Reached')) {
    await clickButtonContaining(page, 'Log out older device and continue')
      || await clickButtonContaining(page, 'Log Out');
  }
};

export const runOverviewReview = async (): Promise<{ captures: CaptureRecord[]; failures: FailureRecord[] }> => {
  const ctx = await createRunContext();
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];

  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    defaultViewport: { width: 1536, height: 1024 },
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--window-size=1536,1024',
    ],
  });

  const page = await browser.newPage();

  try {
    await loadPage(page);

    const email = process.env.QA_LOGIN_EMAIL || config.loginEmail;
    const password = process.env.QA_LOGIN_PASSWORD || config.loginPassword;
    await loginAndStoreSession(page, email, password);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async (error) => {
      if (!(error instanceof Error) || !error.message.includes('Navigation timeout')) {
        throw error;
      }
    });
    await waitForOverviewAppReady(page, true);
    if (await page.$(selectors.loginEmail)) {
      await loginThroughUi(page, email, password);
    }
    await waitForOverviewAppReady(page);

    const variants = [
      {
        label: 'overview-dashboard-desktop',
        viewport: { width: 1536, height: 1024, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        extraSelectors: [
          selectors.overviewHero,
          selectors.overviewRecommendation,
        ] as string[],
        extraTexts: [
          'Active Courses',
          'Quick Revision',
          'Recommended Track',
        ] as string[],
      },
      {
        label: 'overview-dashboard-mobile',
        viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        extraSelectors: [
          selectors.mobileNavOverview,
          selectors.mobileNavCourses,
          selectors.mobileNavTests,
        ] as string[],
        extraTexts: [
          'View all',
          'Open Courses',
          'View all tests',
        ] as string[],
      },
    ] as const;

    for (const variant of variants) {
      await page.setViewport(variant.viewport);
      await gotoOverview(page);
      if (!await page.$(selectors.overviewDashboard)) {
        await clickFirstVisible(
          page,
          variant.label.endsWith('mobile')
            ? [selectors.mobileNavOverview, selectors.mobileTabOverview, selectors.navOverview]
            : [selectors.navOverview, selectors.mobileNavOverview],
        );
      }
      await page.waitForSelector(selectors.overviewDashboard, { timeout: 30000 });
      await page.evaluate(() => window.scrollTo(0, 0));

      const { screenshotPath, sourcePath } = await takeScreenshot(page, ctx, variant.label);
      const pageText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());
      const now = new Date().toISOString();

      captures.push({
        stepId: step.id,
        label: variant.label,
        state: 'ui',
        durationMs: 0,
        screenshotPath,
        sourcePath,
        timestamp: now,
      });

      for (const selector of [...(step.requiredSelectors || []), ...variant.extraSelectors].filter(Boolean)) {
        const element = await page.$(selector);
        if (!element) {
          failures.push({
            stepId: step.id,
            title: 'Missing required UI element',
            description: `Required selector not found: ${selector}`,
            severity: 'high',
            timestamp: now,
            screenshotPath,
          });
        }
      }

      for (const text of [...(step.expectedTexts || []), ...variant.extraTexts]) {
        if (!pageText.includes(text)) {
          failures.push({
            stepId: step.id,
            title: 'Expected content missing',
            description: `Expected text was not found on the page: "${text}"`,
            severity: 'medium',
            timestamp: now,
            screenshotPath,
          });
        }
      }

      const activeCourseCount = await page.$$eval('[data-testid^="overview-active-course-card-"]', (items) => items.length);
      const hasActiveCourseEmptyState = pageText.includes('No active courses');
      if (activeCourseCount < 1 && !hasActiveCourseEmptyState) {
        failures.push({
          stepId: step.id,
          title: 'Missing active course cards or empty state',
          description: 'Overview dashboard should surface active course cards or a clear empty state.',
          severity: 'high',
          timestamp: now,
          screenshotPath,
        });
      }
    }

    await writeJson(path.join(ctx.analysisDir, 'summary.json'), { captures, failures });
    await writeText(
      path.join(ctx.logDir, 'run.log'),
      `Run ${ctx.runId}\nCaptures: ${captures.length}\nFailures: ${failures.length}\nScreenshot: ${captures[captures.length - 1]?.screenshotPath || 'n/a'}\n`,
    );

    if (failures.length > 0) {
      throw new Error(failures.map((failure) => `${failure.title}: ${failure.description}`).join('\n'));
    }

    return { captures, failures };
  } finally {
    await writeJson(path.join(ctx.analysisDir, 'summary.json'), { captures, failures }).catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
};

if (process.argv[1]?.endsWith('overview-figma-review.ts')) {
  runOverviewReview()
    .then((summary) => {
      console.log(`Overview review complete: ${summary.captures.length} captures, ${summary.failures.length} failures.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
