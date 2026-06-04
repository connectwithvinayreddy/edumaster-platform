import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type GridUser = {
  index: number;
  email: string;
  userId?: string | null;
  name?: string;
  cohort?: string;
  scenario?: string;
  viewport?: 'desktop' | 'mobile';
};

type GridManifest = {
  generatedAt?: string;
  profile?: {
    questions?: number;
    durationMinutes?: number;
    marksPerQuestion?: number;
    negativeMarking?: number;
    titlePrefix?: string;
  };
  course?: {
    id?: string;
  };
  test: {
    id?: string;
    title: string;
  };
  auth?: {
    password?: string;
  };
  shard?: {
    index: number;
    totalShards: number;
    userCount: number;
  };
  users: GridUser[];
};

type BrowserEvidence = {
  label: string;
  screenshotPath: string;
  sourcePath: string;
};

type LearnerResult = {
  email: string;
  index: number;
  ok: boolean;
  viewport: 'desktop' | 'mobile';
  scenario: string;
  startedAt: string;
  completedAt?: string;
  timingsMs: Record<string, number>;
  screenshots: BrowserEvidence[];
  rankStatus: 'pending' | 'ready' | 'failed' | 'unknown';
  rankText: string | null;
  percentileText: string | null;
  failureClassification: string | null;
  error?: string;
};

type WorkerSummary = {
  generatedAt: string;
  baseUrl: string;
  manifestPath: string;
  reportPath: string;
  shard: {
    index: number;
    totalShards: number;
    userCount: number;
  };
  profile: GridManifest['profile'];
  test: GridManifest['test'];
  concurrency: number;
  startStaggerMs: number;
  screenshotSample: number;
  successCount: number;
  failureCount: number;
  failureBreakdown: Record<string, number>;
  rankStatusBreakdown: Record<string, number>;
  learnerResults: LearnerResult[];
};

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const manifestPath = path.resolve(process.cwd(), process.env.QA_MOCK_TEST_GRID_SHARD_PATH || process.env.QA_MOCK_TEST_GRID_MANIFEST_PATH || '');
const reportPath = path.resolve(process.cwd(), process.env.QA_MOCK_TEST_GRID_WORKER_REPORT_PATH || `reports/mock-test-browser-grid-worker-${Date.now()}.json`);
const concurrency = Math.max(1, Number(process.env.QA_MOCK_TEST_GRID_BROWSERS_PER_WORKER || process.env.QA_MOCK_TEST_GRID_CONCURRENCY || 10));
const startStaggerMs = Math.max(0, Number(process.env.QA_MOCK_TEST_GRID_START_STAGGER_MS || 150));
const screenshotSample = Math.max(1, Number(process.env.QA_MOCK_TEST_GRID_SCREENSHOT_SAMPLE || 8));
const rankReadyTimeoutMs = Math.max(5_000, Number(process.env.QA_MOCK_TEST_GRID_RANK_READY_TIMEOUT_MS || 20_000));
const autoSubmitOverrideSeconds = Math.max(0, Number(process.env.QA_MOCK_TEST_GRID_AUTO_SUBMIT_SECONDS || 0));
const workerScenario = String(process.env.QA_MOCK_TEST_GRID_SCENARIO || 'mixed-realistic').trim().toLowerCase();
const desktopViewport = { width: 1440, height: 1024, deviceScaleFactor: 1 };
const mobileViewport = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const nowIso = () => new Date().toISOString();

const pickSampleIndexes = (total: number, sampleCount: number) => {
  const picked = new Set<number>();
  if (total <= 0) {
    return picked;
  }
  picked.add(0);
  picked.add(total - 1);
  const targetCount = Math.min(total, sampleCount);
  for (let slot = 1; picked.size < targetCount && slot < targetCount - 1; slot += 1) {
    const ratio = slot / Math.max(1, targetCount - 1);
    picked.add(Math.min(total - 1, Math.round(ratio * (total - 1))));
  }
  return picked;
};

const average = (values: number[]) => values.length
  ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  : 0;

const runConcurrent = async <TItem, TResult>(
  items: TItem[],
  worker: (item: TItem, index: number) => Promise<TResult>,
  limit: number,
) => {
  const results: TResult[] = [];
  const queue = items.map((item, index) => ({ item, index }));
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      results.push(await worker(next.item, next.index));
    }
  });
  await Promise.all(runners);
  return results;
};

const takeEvidence = async (
  page: Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  prefix: string,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, prefix, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, prefix, label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await writeText(sourcePath, await page.content());
  return { label, screenshotPath, sourcePath };
};

const waitForAnySelector = async (page: Page, selectorList: string[], timeout = 30_000) => {
  await page.waitForFunction(
    (selectorsToCheck) => selectorsToCheck.some((selector) => Boolean(document.querySelector(selector))),
    { timeout },
    selectorList,
  );
};

const clickFirstAvailable = async (page: Page, selectorList: string[], textMatchers: RegExp[] = []) => {
  for (const selector of selectorList) {
    const clicked = await page.evaluate((targetSelector) => {
      const elements = Array.from(document.querySelectorAll(targetSelector)) as HTMLElement[];
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        element.click();
        return true;
      }
      return false;
    }, selector);
    if (clicked) {
      return true;
    }
  }

  if (!textMatchers.length) {
    return false;
  }

  return page.evaluate((patterns) => {
    const regexes = patterns.map((pattern) => new RegExp(pattern, 'i'));
    const elements = Array.from(document.querySelectorAll('button, a')) as HTMLElement[];
    for (const element of elements) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      if (!regexes.some((regex) => regex.test((element.textContent || '').trim()))) {
        continue;
      }
      element.click();
      return true;
    }
    return false;
  }, textMatchers.map((entry) => entry.source));
};

const clickTestByTitle = async (page: Page, title: string) => page.evaluate((targetTitle) => {
  const normalizedTarget = targetTitle.toLowerCase().trim();
  const candidates = Array.from(document.querySelectorAll('button')) as HTMLElement[];
  for (const candidate of candidates) {
    const text = (candidate.textContent || '').toLowerCase();
    if (!text.includes(normalizedTarget)) {
      continue;
    }
    const style = window.getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    candidate.click();
    return true;
  }
  return false;
}, title);

const openTestsTab = async (page: Page) => {
  const clickedPreferred = await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector) as HTMLElement | null;
    if (!element) {
      return false;
    }
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, selectors.navTests);

  if (clickedPreferred) {
    return;
  }

  await page.evaluate(() => {
    const candidate = Array.from(document.querySelectorAll('button')).find((button) =>
      /(mock tests|tests)/i.test((button.textContent || '').trim()),
    ) as HTMLButtonElement | undefined;
    candidate?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const ensureChecked = async (page: Page, selector: string) => {
  const clicked = await page.evaluate((targetSelector) => {
    const node = document.querySelector(targetSelector) as HTMLElement | null;
    const checkbox = node instanceof HTMLInputElement ? node : node?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox?.checked) {
      return true;
    }
    node?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return Boolean(checkbox || node);
  }, selector);
  if (!clicked) {
    throw new Error(`Unable to check declaration ${selector}`);
  }
};

const getVisibleBodyText = async (page: Page) => page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());

const getVisibleText = async (page: Page, selector: string) => page.evaluate((targetSelector) => {
  const nodes = Array.from(document.querySelectorAll(targetSelector)) as HTMLElement[];
  for (const node of nodes) {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    return (node.textContent || '').trim();
  }
  return '';
}, selector);

const getVisibleQuestionCount = async (page: Page, prefix: string) => page.evaluate((value) => {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${value}"]`));
  return nodes.filter((node) => {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
  }).length;
}, prefix);

const jumpToQuestion = async (page: Page, selector: string) => page.evaluate((targetSelector) => {
  const node = document.querySelector(targetSelector) as HTMLElement | null;
  node?.click();
  return Boolean(node);
}, selector);

const selectFirstVisibleAnswer = async (page: Page) => page.evaluate(() => {
  const optionLabels = Array.from(document.querySelectorAll('label')) as HTMLElement[];
  for (const label of optionLabels) {
    const input = label.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLInputElement | null;
    if (!input) {
      continue;
    }
    const style = window.getComputedStyle(label);
    const rect = label.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    label.click();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
});

const loginToken = async (email: string, password: string) => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Mock Test Browser Grid',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || `Unable to login as ${email}`);
  }
  return String(payload.token);
};

const storeSessionToken = async (page: Page, token: string, overrideSeconds = 0) => {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate(({ authToken, timerOverride }) => {
    window.localStorage.setItem('edumaster.jwt', authToken);
    if (timerOverride > 0) {
      window.localStorage.setItem('qa.mock_test_timer_override_seconds', String(timerOverride));
    } else {
      window.localStorage.removeItem('qa.mock_test_timer_override_seconds');
    }
  }, { authToken: token, timerOverride: overrideSeconds });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
};

const classifyFailure = (error: unknown, stage: string) => {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/login|token|unauthorized/i.test(message)) {
    return 'browser harness issue';
  }
  if (/pending rank never became ready|rank/i.test(message)) {
    return 'ranking worker / Redis bug';
  }
  if (/timer|auto-submit/i.test(message)) {
    return 'UI/timer flow bug';
  }
  if (/duplicate|already submitted/i.test(message)) {
    return 'submit-path idempotency bug';
  }
  if (/question|duration|confirmation|result|solutions/i.test(message)) {
    return stage === 'confirmation' || stage === 'exam' ? 'UI/timer flow bug' : 'browser harness issue';
  }
  return 'browser harness issue';
};

const waitForRankReady = async (page: Page) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < rankReadyTimeoutMs) {
    const rankText = await getVisibleText(page, `${selectors.testsResultRankDesktop}, ${selectors.testsResultRankMobile}`);
    const percentileText = await getVisibleText(page, `${selectors.testsResultPercentileDesktop}, ${selectors.testsResultPercentileMobile}`);
    if (rankText.startsWith('#') || /\d+(\.\d+)?%/.test(percentileText)) {
      return {
        rankStatus: 'ready' as const,
        rankText,
        percentileText,
      };
    }
    if (rankText && !/pending/i.test(rankText)) {
      return {
        rankStatus: /failed/i.test(rankText) ? 'failed' as const : 'unknown' as const,
        rankText,
        percentileText,
      };
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await sleep(1_000);
  }

  const rankText = await getVisibleText(page, `${selectors.testsResultRankDesktop}, ${selectors.testsResultRankMobile}`);
  const percentileText = await getVisibleText(page, `${selectors.testsResultPercentileDesktop}, ${selectors.testsResultPercentileMobile}`);
  return {
    rankStatus: /pending/i.test(rankText) ? 'pending' as const : 'unknown' as const,
    rankText,
    percentileText,
  };
};

const runLearner = async (
  browser: Browser,
  user: GridUser,
  sampleUserIndexes: Set<number>,
  manifest: GridManifest,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
) => {
  const startedAt = nowIso();
  const timingsMs: Record<string, number> = {};
  const screenshots: BrowserEvidence[] = [];
  const isSampled = sampleUserIndexes.has(user.index);
  const scenario = String(user.scenario || workerScenario || 'mixed-realistic');
  const viewport = user.viewport === 'mobile' ? 'mobile' : 'desktop';
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  let currentStage = 'boot';

  try {
    await page.setViewport(viewport === 'mobile' ? mobileViewport : desktopViewport);
    const loginStartedAt = Date.now();
    const token = await loginToken(user.email, manifest.auth?.password || config.loginPassword);
    timingsMs.login = Date.now() - loginStartedAt;

    const sessionStartedAt = Date.now();
    await storeSessionToken(page, token, scenario === 'timeout-auto-submit' ? Math.max(2, autoSubmitOverrideSeconds || 3) : 0);
    await page.waitForSelector(selectors.shellReady, { timeout: 30_000 });
    timingsMs.session = Date.now() - sessionStartedAt;

    currentStage = 'navigation';
    const navigationStartedAt = Date.now();
    await openTestsTab(page);
    await waitForAnySelector(page, [selectors.testsFigmaPage, selectors.firstTestCard], 30_000);
    await sleep(500);
    const clickedTargetTest = await clickTestByTitle(page, manifest.test.title);
    if (!clickedTargetTest) {
      throw new Error(`Unable to find target test "${manifest.test.title}"`);
    }
    await sleep(700);
    await clickFirstAvailable(page, [selectors.testsOpenInstructions], [/resume now/i, /start now/i, /go to test series/i, /paper/i]);
    await waitForAnySelector(page, [selectors.testsInstructionsDesktop, selectors.testsInstructionsMobile], 30_000);
    await clickFirstAvailable(page, [selectors.testsInstructionsNextDesktop, selectors.testsInstructionsNextMobile], [/^next$/i]);
    await waitForAnySelector(page, [selectors.testsConfirmationDesktop, selectors.testsConfirmationMobile, 'input[type="checkbox"]'], 30_000);
    timingsMs.navigation = Date.now() - navigationStartedAt;

    currentStage = 'confirmation';
    const confirmationText = await getVisibleBodyText(page);
    if (manifest.profile?.questions && !new RegExp(`\\b${manifest.profile.questions}\\b`).test(confirmationText)) {
      throw new Error(`Expected ${manifest.profile.questions} questions on confirmation`);
    }
    if (manifest.profile?.durationMinutes && !new RegExp(`\\b${manifest.profile.durationMinutes}\\b`).test(confirmationText)) {
      throw new Error(`Expected ${manifest.profile.durationMinutes} minutes on confirmation`);
    }
    const timerBeforeBegin = await page.$(`${selectors.testsExamTimerDesktop}, ${selectors.testsExamTimerMobile}`);
    if (timerBeforeBegin) {
      throw new Error('Timer appeared before begin');
    }
    if (isSampled) {
      screenshots.push(await takeEvidence(page, ctx, `grid-user-${user.index + 1}`, 'confirmation'));
    }

    await ensureChecked(page, viewport === 'mobile' ? selectors.testsConfirmationCheckboxMobile : selectors.testsConfirmationCheckboxDesktop);
    await clickFirstAvailable(
      page,
      [viewport === 'mobile' ? selectors.testsConfirmationBeginMobile : selectors.testsConfirmationBeginDesktop],
      [/i am ready to begin/i, /ready to begin/i],
    );
    await waitForAnySelector(page, [selectors.testsExamDesktop, selectors.testsExamMobile, selectors.testsExamSubmitDesktop, selectors.testsExamSubmitMobile], 30_000);
    await page.waitForSelector(viewport === 'mobile' ? selectors.testsExamTimerMobile : selectors.testsExamTimerDesktop, { timeout: 5_000 });
    if (isSampled) {
      screenshots.push(await takeEvidence(page, ctx, `grid-user-${user.index + 1}`, 'after-begin'));
    }

    currentStage = 'exam';
    const examStartedAt = Date.now();
    const questionPrefix = viewport === 'mobile' ? 'tests-mobile-jump-' : 'tests-desktop-jump-';
    const questionCount = await getVisibleQuestionCount(page, questionPrefix);
    if ((manifest.profile?.questions || 0) >= 100 && questionCount >= 100) {
      await jumpToQuestion(page, `[data-testid="${questionPrefix}60"]`);
      await sleep(250);
      await jumpToQuestion(page, `[data-testid="${questionPrefix}${questionCount}"]`);
      await sleep(250);
    }
    for (let step = 0; step < 4; step += 1) {
      await selectFirstVisibleAnswer(page);
      await sleep(150);
      await clickFirstAvailable(page, [], [/save & next/i, /mark review/i]);
      await sleep(250);
    }
    if (isSampled) {
      screenshots.push(await takeEvidence(page, ctx, `grid-user-${user.index + 1}`, 'mid-exam'));
    }
    timingsMs.exam = Date.now() - examStartedAt;

    currentStage = 'submit';
    const submitStartedAt = Date.now();
    if (scenario === 'timeout-auto-submit') {
      await page.waitForSelector(`${selectors.testsResultDesktop}, ${selectors.testsResultMobile}`, { timeout: 15_000 });
    } else {
      await clickFirstAvailable(page, [selectors.testsExamSubmitDesktop, selectors.testsExamSubmitMobile], [/submit test/i, /submit/i]);
      await page.waitForSelector(`${selectors.testsResultDesktop}, ${selectors.testsResultMobile}`, { timeout: 20_000 });
    }
    timingsMs.submit = Date.now() - submitStartedAt;
    if (isSampled) {
      screenshots.push(await takeEvidence(page, ctx, `grid-user-${user.index + 1}`, 'result'));
    }

    currentStage = 'result';
    const rankSnapshot = await waitForRankReady(page);
    await clickFirstAvailable(page, [selectors.testsViewSolutionsDesktop, selectors.testsViewSolutions], [/view solutions/i, /view analysis/i, /solutions/i]);
    await waitForAnySelector(page, [selectors.testsSolutionsDesktop, selectors.testsSolutionsMobile], 20_000);
    if (isSampled) {
      screenshots.push(await takeEvidence(page, ctx, `grid-user-${user.index + 1}`, 'solutions'));
    }

    return {
      email: user.email,
      index: user.index,
      ok: true,
      viewport,
      scenario,
      startedAt,
      completedAt: nowIso(),
      timingsMs,
      screenshots,
      rankStatus: rankSnapshot.rankStatus,
      rankText: rankSnapshot.rankText,
      percentileText: rankSnapshot.percentileText,
      failureClassification: null,
    } satisfies LearnerResult;
  } catch (error) {
    if (isSampled) {
      screenshots.push(await takeEvidence(page, ctx, `grid-user-${user.index + 1}`, `failed-${currentStage}`).catch(() => ({
        label: `failed-${currentStage}`,
        screenshotPath: '',
        sourcePath: '',
      })));
    }
    return {
      email: user.email,
      index: user.index,
      ok: false,
      viewport,
      scenario,
      startedAt,
      completedAt: nowIso(),
      timingsMs,
      screenshots,
      rankStatus: 'unknown',
      rankText: null,
      percentileText: null,
      failureClassification: classifyFailure(error, currentStage),
      error: error instanceof Error ? error.message : String(error),
    } satisfies LearnerResult;
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
};

const main = async () => {
  if (!manifestPath) {
    throw new Error('QA_MOCK_TEST_GRID_SHARD_PATH or QA_MOCK_TEST_GRID_MANIFEST_PATH is required');
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as GridManifest;
  if (!Array.isArray(manifest.users) || !manifest.users.length) {
    throw new Error(`Browser grid manifest has no users: ${manifestPath}`);
  }

  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  try {
    const sampleUserIndexes = pickSampleIndexes(manifest.users.length, screenshotSample);
    const learnerResults = await runConcurrent(manifest.users, async (user, localIndex) => {
      if (startStaggerMs > 0) {
        await sleep(localIndex * startStaggerMs);
      }
      return runLearner(browser, user, sampleUserIndexes, manifest, ctx);
    }, concurrency);

    const failureBreakdown = learnerResults.reduce<Record<string, number>>((accumulator, result) => {
      const key = result.failureClassification || 'pass';
      accumulator[key] = (accumulator[key] || 0) + 1;
      return accumulator;
    }, {});
    const rankStatusBreakdown = learnerResults.reduce<Record<string, number>>((accumulator, result) => {
      accumulator[result.rankStatus] = (accumulator[result.rankStatus] || 0) + 1;
      return accumulator;
    }, {});
    const timings = learnerResults.flatMap((result) => Object.values(result.timingsMs));

    const summary = {
      generatedAt: nowIso(),
      baseUrl: config.baseUrl,
      manifestPath,
      reportPath,
      shard: {
        index: Number(manifest.shard?.index || 0),
        totalShards: Number(manifest.shard?.totalShards || 1),
        userCount: manifest.users.length,
      },
      profile: manifest.profile || {},
      test: manifest.test,
      concurrency,
      startStaggerMs,
      screenshotSample,
      successCount: learnerResults.filter((result) => result.ok).length,
      failureCount: learnerResults.filter((result) => !result.ok).length,
      failureBreakdown,
      rankStatusBreakdown,
      averageTimingMs: average(timings),
      learnerResults,
    } satisfies WorkerSummary & { averageTimingMs: number };

    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await writeJson(reportPath, summary);
    await writeText(path.join(ctx.logDir, `mock-test-browser-grid-worker-${summary.shard.index}.log`), JSON.stringify(summary, null, 2));

    if (summary.failureCount > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
