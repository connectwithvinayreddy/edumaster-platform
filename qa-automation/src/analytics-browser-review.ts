import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { CaptureRecord, FailureRecord, StepDefinition } from './types.js';
import { artifactPath, createRunContext, writeJson, writeText } from './utils.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const step: StepDefinition = {
  id: 'analytics-dashboard',
  label: 'analytics-dashboard',
  requiredSelectors: [
    selectors.analyticsPage,
    selectors.analyticsSummary,
    selectors.analyticsWeaknessMap,
    selectors.analyticsAiCoach,
  ],
  expectedTexts: [
    'Performance analytics',
    'Weakest concepts right now',
    'Section and chapter weakness map',
    'AI coach',
  ],
};

const loginAndStoreSession = async (page: puppeteer.Page, email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Analytics Review',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || 'Unable to login for analytics review');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('edumaster.jwt', token);
  }, payload.token as string);
};

const waitForReady = async (page: puppeteer.Page, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.$(selectors.shellReady)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Shell did not become ready within 30000ms.');
};

const takeScreenshot = async (page: puppeteer.Page, ctx: Awaited<ReturnType<typeof createRunContext>>, label: string) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, step.id, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, step.id, label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

const assertSelector = async (page: puppeteer.Page, selector: string, screenshotPath: string, failures: FailureRecord[]) => {
  if (!await page.$(selector)) {
    failures.push({
      stepId: step.id,
      severity: 'high',
      message: `Missing selector: ${selector}`,
      screenshotPath,
    });
  }
};

const assertText = async (page: puppeteer.Page, expectedText: string, screenshotPath: string, failures: FailureRecord[]) => {
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  if (!bodyText.includes(expectedText)) {
    failures.push({
      stepId: step.id,
      severity: 'medium',
      message: `Missing text: ${expectedText}`,
      screenshotPath,
    });
  }
};

const openAnalyticsDesktop = async (page: puppeteer.Page) => {
  await page.locator(selectors.navAnalytics).click();
  await page.waitForSelector(selectors.analyticsPage, { timeout: 15000 });
};

const openAnalyticsMobile = async (page: puppeteer.Page) => {
  await page.locator(selectors.mobileNavMore).click();
  await page.waitForSelector(selectors.mobileMoreAnalytics, { timeout: 15000 });
  await page.locator(selectors.mobileMoreAnalytics).click();
  await page.waitForSelector(selectors.analyticsPage, { timeout: 15000 });
};

export const runAnalyticsReview = async (): Promise<{ captures: CaptureRecord[]; failures: FailureRecord[]; runId: string }> => {
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
    const email = process.env.QA_LOGIN_EMAIL || config.loginEmail;
    const password = process.env.QA_LOGIN_PASSWORD || config.loginPassword;
    if (!email || !password) {
      throw new Error('QA login credentials are required for analytics review.');
    }

    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await loginAndStoreSession(page, email, password);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
    await waitForReady(page);

    const variants = [
      {
        label: 'analytics-desktop',
        viewport: { width: 1536, height: 1024, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
        open: openAnalyticsDesktop,
      },
      {
        label: 'analytics-mobile',
        viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
        open: openAnalyticsMobile,
      },
    ] as const;

    for (const variant of variants) {
      await page.setViewport(variant.viewport);
      await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
      await waitForReady(page);
      await variant.open(page);
      await sleep(600);
      const { screenshotPath, sourcePath } = await takeScreenshot(page, ctx, variant.label);
      captures.push({
        stepId: step.id,
        screenshotPath,
        sourcePath,
        label: variant.label,
      });

      for (const selector of step.requiredSelectors) {
        await assertSelector(page, selector, screenshotPath, failures);
      }

      for (const text of step.expectedTexts) {
        await assertText(page, text, screenshotPath, failures);
      }
    }
  } finally {
    await browser.close();
  }

  await writeJson(`${ctx.analysisDir}/summary.json`, {
    runId: ctx.runId,
    captures,
    failures,
  });
  await writeText(`${ctx.logDir}/analytics-review.txt`, `Run ${ctx.runId}\nCaptures: ${captures.length}\nFailures: ${failures.length}\n`);

  return { captures, failures, runId: ctx.runId };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runAnalyticsReview()
    .then(({ captures, failures, runId }) => {
      console.log(`Run ${runId}`);
      console.log(`Captures: ${captures.length}`);
      console.log(`Failures: ${failures.length}`);
      if (failures.length > 0) {
        failures.forEach((failure) => console.error(`${failure.severity.toUpperCase()}: ${failure.message}`));
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
