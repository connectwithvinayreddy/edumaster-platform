import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { createRunContext, sleep, writeJson, writeText } from './utils.js';

const desktopViewport = { width: 1536, height: 1024 };
const targetTestTitle = String(process.env.QA_TEST_TITLE || '').trim();

const apiOrigin = (() => {
  const url = new URL(process.env.QA_BASE_URL || config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const loginAndStoreSession = async (page: puppeteer.Page, email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Pause Flow Review',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || 'Unable to login for tests pause review');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('edumaster.jwt', token);
  }, payload.token as string);
};

const waitForAnySelector = async (page: puppeteer.Page, selectorList: string[], timeout = 30000) => {
  await page.waitForFunction(
    (selectorsToCheck) => selectorsToCheck.some((selector) => Boolean(document.querySelector(selector))),
    { timeout },
    selectorList,
  );
};

const clickVisible = async (page: puppeteer.Page, selector: string) => {
  await page.waitForSelector(selector, { timeout: 30000 });
  const clicked = await page.evaluate((targetSelector) => {
    const nodes = [...document.querySelectorAll(targetSelector)] as HTMLElement[];
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      node.click();
      return true;
    }
    return false;
  }, selector);

  if (!clicked) {
    throw new Error(`Unable to click visible selector: ${selector}`);
  }
};

const clickButtonMatching = async (page: puppeteer.Page, matcher: RegExp) => {
  const clicked = await page.evaluate((pattern) => {
    const regex = new RegExp(pattern, 'i');
    const nodes = [...document.querySelectorAll('button, a')] as HTMLElement[];
    for (const node of nodes) {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (!regex.test((node.textContent || '').trim())) {
        continue;
      }
      node.click();
      return true;
    }
    return false;
  }, matcher.source);

  if (!clicked) {
    throw new Error(`Unable to click button matching ${matcher}`);
  }
};

const clickTestByTitle = async (page: puppeteer.Page, title: string) => page.evaluate((targetTitle) => {
  const normalizedTarget = targetTitle.toLowerCase().trim();
  const nodes = [...document.querySelectorAll('button')] as HTMLElement[];
  for (const node of nodes) {
    const text = (node.textContent || '').toLowerCase();
    if (!text.includes(normalizedTarget)) {
      continue;
    }

    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    node.click();
    return true;
  }

  return false;
}, title);

const ensureChecked = async (page: puppeteer.Page, selector: string) => {
  await page.waitForSelector(selector, { timeout: 30000 });
  await page.evaluate((targetSelector) => {
    const label = document.querySelector(targetSelector) as HTMLElement | null;
    label?.click();
  }, selector);
};

const setLanguageAndBegin = async (page: puppeteer.Page) => {
  await page.waitForSelector(selectors.testsConfirmationLanguageDesktop, { timeout: 30000 });
  await page.select(selectors.testsConfirmationLanguageDesktop, 'English');
  await ensureChecked(page, selectors.testsConfirmationCheckboxDesktop);
  await page.waitForFunction(
    (targetSelector) => {
      const button = document.querySelector(targetSelector) as HTMLButtonElement | null;
      return Boolean(button && !button.disabled);
    },
    { timeout: 5000 },
    selectors.testsConfirmationBeginDesktop,
  );
  await clickVisible(page, selectors.testsConfirmationBeginDesktop);
};

const takeScreenshot = async (page: puppeteer.Page, filePath: string) => {
  await page.screenshot({ path: filePath, fullPage: false });
};

const run = async () => {
  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  const summary = {
    runId: ctx.runId,
    screenshots: {} as Record<string, string>,
    findings: [] as string[],
  };

  try {
    const page = await browser.newPage();
    await page.setViewport(desktopViewport);
    const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:3000';
    const email = process.env.QA_LOGIN_EMAIL || config.loginEmail || 'student@edumaster.local';
    const password = process.env.QA_LOGIN_PASSWORD || config.loginPassword || 'Student@123';

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await loginAndStoreSession(page, email, password);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(selectors.shellReady, { timeout: 30000 });

    await clickVisible(page, selectors.navTests);
    await waitForAnySelector(page, [selectors.testsFigmaPage, selectors.testsHomeDesktop]);
    await sleep(700);

    const clickedTargetTest = targetTestTitle ? await clickTestByTitle(page, targetTestTitle) : false;
    if (!clickedTargetTest) {
      await clickVisible(page, selectors.testsOpenPrimary);
    }
    await sleep(700);

    if (await page.$(selectors.testsDetailDesktop)) {
      await clickVisible(page, selectors.testsOpenInstructions);
      await sleep(500);
    }

    await waitForSelectorAndCapture(page, selectors.testsInstructionsDesktop);
    await clickVisible(page, selectors.testsInstructionsNextDesktop);
    await waitForAnySelector(page, [selectors.testsConfirmationDesktop]);
    await setLanguageAndBegin(page);

    await page.waitForSelector(selectors.testsExamDesktop, { timeout: 30000 });
    await page.waitForSelector(selectors.testsPauseTrigger, { timeout: 30000 });
    await sleep(600);

    await clickVisible(page, selectors.testsPauseTrigger);
    await page.waitForSelector(selectors.testsPauseConfirm, { timeout: 30000 });
    const confirmShot = path.join(ctx.screenshotDir, 'tests-pause-confirm-desktop.png');
    await takeScreenshot(page, confirmShot);
    summary.screenshots.pauseConfirm = confirmShot;

    await clickVisible(page, selectors.testsPauseConfirmYes);
    await page.waitForSelector(selectors.testsPauseSummary, { timeout: 30000 });
    await sleep(400);
    const summaryShot = path.join(ctx.screenshotDir, 'tests-pause-summary-desktop.png');
    await takeScreenshot(page, summaryShot);
    summary.screenshots.pauseSummary = summaryShot;

    await clickVisible(page, selectors.testsPauseSummaryTests);
    await page.waitForSelector(selectors.testsDetailDesktop, { timeout: 30000 });
    await sleep(500);
    const backShot = path.join(ctx.screenshotDir, 'tests-pause-back-to-series-desktop.png');
    await takeScreenshot(page, backShot);
    summary.screenshots.backToSeries = backShot;

    summary.findings.push('Pause confirm rendered successfully.');
    summary.findings.push('Pause summary rendered successfully.');
    summary.findings.push('Go to Tests returned to the desktop test series detail screen.');

    await writeJson(path.join(ctx.analysisDir, 'tests-pause-flow-summary.json'), summary);
    await writeText(
      path.join(ctx.logDir, 'tests-pause-flow.log'),
      [
        `Run ${ctx.runId}`,
        `pauseConfirm=${summary.screenshots.pauseConfirm}`,
        `pauseSummary=${summary.screenshots.pauseSummary}`,
        `backToSeries=${summary.screenshots.backToSeries}`,
      ].join('\n'),
    );

    console.log(JSON.stringify(summary, null, 2));
    await page.close();
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const waitForSelectorAndCapture = async (page: puppeteer.Page, selector: string) => {
  await page.waitForSelector(selector, { timeout: 30000 });
};

if (process.argv[1]?.endsWith('tests-pause-flow-review.ts')) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
