import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type SampleState = 'active' | 'manual_grant' | 'disabled' | 'blocked';

type SampleUser = PreparedUser & {
  expectedState: SampleState;
  resolvedStudentId?: string | null;
};

type LoginRun = {
  email: string;
  expectedState: SampleState;
  viewport: 'desktop' | 'mobile';
  result: 'passed' | 'failed';
  loginStatus?: number | null;
  loginPayload?: unknown;
  pageTextSnippet?: string;
  dashboardVisible?: boolean;
  timings?: Record<string, number | null>;
  screenshots: Record<string, string>;
  consoleErrors: string[];
  networkErrors: Array<{ status: number; url: string }>;
  pageErrors: string[];
  failure?: string;
};

type BrowserLoginSummary = {
  baseUrl: string;
  manifestPath: string;
  sampleSize: number;
  courseId: string | null;
  startedAt: string;
  completedAt?: string;
  states: Array<{ email: string; state: SampleState }>;
  results: LoginRun[];
  restoredUsers: string[];
  refreshedManifestTokens: string[];
  skippedStates: string[];
  restoreFailures?: Array<{ email: string; error: string }>;
  refreshFailures?: Array<{ email: string; error: string }>;
  setupFailures?: Array<{ email: string; error: string }>;
  failedCases?: Array<{ email: string; expectedState: SampleState; failure: string }>;
  result: 'pending' | 'passed' | 'failed';
};

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const manifestPath = process.env.PLATFORM_LOAD_USERS_FILE || process.env.ACTIVE_100_USERS_FILE || '';
const userPassword = process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123';
const sampleSize = Math.max(4, Number(process.env.QA_BROWSER_LOGIN_SAMPLE_SIZE || 25));
const courseId = String(process.env.PLATFORM_LOAD_COURSE_ID || '').trim();
const authMinIntervalMs = Math.max(0, Number(process.env.QA_BROWSER_AUTH_MIN_INTERVAL_MS || 1100));

const fetchJson = async <T = Record<string, unknown>>(pathname: string, init: RequestInit = {}) => {
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

let nextAuthAt = 0;
const withAuthPacing = async <T>(work: () => Promise<T>) => {
  const waitMs = Math.max(0, nextAuthAt - Date.now());
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  try {
    return await work();
  } finally {
    nextAuthAt = Date.now() + authMinIntervalMs;
  }
};

const loginApi = async (email: string, password: string, device: string) =>
  withAuthPacing(() => fetchJson<{ token: string; user: { _id: string } }>('/backend/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device,
      forceLogoutOtherSessions: true,
    }),
  }));

const adminFetch = async <T = Record<string, unknown>>(token: string, pathname: string, init: RequestInit = {}) =>
  fetchJson<T>(pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });

const clickVisible = async (page: puppeteer.Page, selectorList: string[], timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectorList) {
      const element = await page.$(selector);
      if (!element) {
        continue;
      }
      const visible = await element.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node as Element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }).catch(() => false);
      if (!visible) {
        continue;
      }
      await element.click().catch(async () => {
        await page.evaluate((targetSelector) => {
          (document.querySelector(targetSelector) as HTMLElement | null)?.click();
        }, selector);
      });
      return selector;
    }
    await sleep(250);
  }
  throw new Error(`Unable to find visible selector: ${selectorList.join(', ')}`);
};

const readBodyText = async (page: puppeteer.Page) =>
  page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000));

const resolveSessionConflictIfVisible = async (page: puppeteer.Page) => {
  const bodyText = await readBodyText(page);
  if (!/Log out older device/i.test(bodyText)) {
    return false;
  }

  const clicked = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      /Log out older device/i.test((node.textContent || '').trim()),
    ) as HTMLButtonElement | undefined;
    if (!button) {
      return false;
    }
    button.click();
    return true;
  });
  if (!clicked) {
    return false;
  }
  return true;
};

const waitForShellOrOutcome = async (page: puppeteer.Page, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shellVisible = await page.$(selectors.shellReady);
    if (shellVisible) {
      return { shellVisible: true, resolvedConflict: false };
    }

    const resolvedConflict = await resolveSessionConflictIfVisible(page);
    if (resolvedConflict) {
      await sleep(1500);
      continue;
    }

    const bodyText = await readBodyText(page);
    if (/Invalid credentials|contact support|disabled|blocked/i.test(bodyText)) {
      return { shellVisible: false, resolvedConflict: false };
    }

    await sleep(500);
  }

  return { shellVisible: false, resolvedConflict: false };
};

const takeShot = async (page: puppeteer.Page, root: string, label: string) => {
  const target = artifactPath(root, 'browser-login-manifest-review', label, 'png');
  await page.screenshot({ path: target, fullPage: true });
  return target;
};

const persistSummary = async (ctx: Awaited<ReturnType<typeof createRunContext>>, summary: BrowserLoginSummary) => {
  const summaryPath = path.join(ctx.rootDir, 'browser-login-manifest-review-summary.json');
  const notesPath = path.join(ctx.rootDir, 'browser-login-manifest-review-summary.md');
  await writeJson(summaryPath, summary);
  await writeText(notesPath, JSON.stringify(summary, null, 2));
  return { summaryPath, notesPath };
};

const chooseSamples = (users: PreparedUser[]) => {
  const selected = users.slice(0, sampleSize);
  const disabledCount = Math.min(3, Math.floor(selected.length / 8));
  const blockedCount = Math.min(2, Math.floor(selected.length / 10));
  const manualGrantCount = courseId ? Math.min(5, Math.floor(selected.length / 4)) : 0;
  return selected.map((user, index) => {
    let expectedState: SampleState = 'active';
    if (index < manualGrantCount) {
      expectedState = 'manual_grant';
    } else if (index < manualGrantCount + disabledCount) {
      expectedState = 'disabled';
    } else if (index < manualGrantCount + disabledCount + blockedCount) {
      expectedState = 'blocked';
    }
    return { ...user, expectedState } satisfies SampleUser;
  });
};

const applyState = async (adminToken: string, user: SampleUser) => {
  if (!user.resolvedStudentId) {
    throw new Error(`Resolved student id missing for ${user.email}`);
  }

  await adminFetch(adminToken, `/backend/api/admin/students/${encodeURIComponent(user.resolvedStudentId)}/status`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'active',
      note: 'QA browser login sample restore baseline',
    }),
  });

  if (courseId) {
    await adminFetch(adminToken, '/backend/api/admin/purchases/remove-course', {
      method: 'POST',
      body: JSON.stringify({
        studentId: user.resolvedStudentId,
        courseId,
        adminNote: 'QA browser login baseline cleanup',
      }),
    }).catch(() => undefined);
  }

  if (user.expectedState === 'manual_grant' && courseId) {
    await adminFetch(adminToken, '/backend/api/admin/purchases/assign-course', {
      method: 'POST',
      body: JSON.stringify({
        studentId: user.resolvedStudentId,
        courseId,
        adminNote: 'QA browser login manual grant sample',
      }),
    });
    return;
  }

  if (user.expectedState === 'disabled' || user.expectedState === 'blocked') {
    await adminFetch(adminToken, `/backend/api/admin/students/${encodeURIComponent(user.resolvedStudentId)}/status`, {
      method: 'POST',
      body: JSON.stringify({
        status: user.expectedState,
        note: 'QA browser login negative-path sample',
      }),
    });
  }
};

const restoreState = async (adminToken: string, user: SampleUser) => {
  if (!user.resolvedStudentId) {
    return;
  }

  await adminFetch(adminToken, `/backend/api/admin/students/${encodeURIComponent(user.resolvedStudentId)}/status`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'active',
      note: 'QA browser login sample restore',
    }),
  }).catch(() => undefined);

  if (courseId) {
    await adminFetch(adminToken, '/backend/api/admin/purchases/remove-course', {
      method: 'POST',
      body: JSON.stringify({
        studentId: user.resolvedStudentId,
        courseId,
        adminNote: 'QA browser login sample cleanup',
      }),
    }).catch(() => undefined);
  }
};

const runLoginCheck = async (
  browser: puppeteer.Browser,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  sample: SampleUser,
  viewport: 'desktop' | 'mobile',
) => {
  const browserContext = await browser.createBrowserContext();
  const page = await browserContext.newPage();
  const result: LoginRun = {
    email: sample.email,
    expectedState: sample.expectedState,
    viewport,
    result: 'failed',
    screenshots: {},
    consoleErrors: [],
    networkErrors: [],
    pageErrors: [],
  };

  if (viewport === 'mobile') {
    await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  } else {
    await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  }

  const loginResponses: Array<{ status: number; payload: unknown }> = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      result.consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    result.pageErrors.push(error.message);
  });
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/backend/api/auth/login')) {
      const text = await response.text().catch(() => '');
      let payload: unknown = text;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      loginResponses.push({ status: response.status(), payload });
    } else if (response.status() >= 400) {
      result.networkErrors.push({ status: response.status(), url });
    }
  });

  try {
    const loginStarted = Date.now();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    result.screenshots.loginPage = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-login-page`);
    const initialOutcome = await Promise.race([
      page.waitForSelector(selectors.loginEmail, { timeout: 30_000 }).then(() => 'login'),
      page.waitForSelector(selectors.shellReady, { timeout: 30_000 }).then(() => 'shell'),
    ]);
    if (initialOutcome === 'shell') {
      throw new Error('Sample opened directly into authenticated shell before login UI appeared.');
    }
    await page.type(selectors.loginEmail, sample.email);
    await page.type(selectors.loginPassword, userPassword);
    await page.click(selectors.loginSubmit);
    const outcome = await waitForShellOrOutcome(page, 35_000);
    const dashboardVisible = outcome.shellVisible;
    result.dashboardVisible = dashboardVisible;
    result.loginStatus = loginResponses.at(-1)?.status ?? null;
    result.loginPayload = loginResponses.at(-1)?.payload ?? null;
    result.timings = {
      loginToShellMs: dashboardVisible ? Date.now() - loginStarted : null,
      refreshToShellMs: null,
    };

    if (sample.expectedState === 'disabled' || sample.expectedState === 'blocked') {
      result.pageTextSnippet = await readBodyText(page);
      result.screenshots.loginBlocked = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-blocked`);
      if (dashboardVisible) {
        throw new Error(`Expected blocked login for ${sample.expectedState}, but shell loaded.`);
      }
      if (!(result.loginStatus === 403 || /contact support|disabled|blocked/i.test(result.pageTextSnippet || ''))) {
        throw new Error(`Blocked login did not show controlled denial for ${sample.email}.`);
      }
      result.result = 'passed';
      return result;
    }

    if (!dashboardVisible) {
      result.pageTextSnippet = await readBodyText(page);
      throw new Error(`Dashboard did not load for ${sample.email}.`);
    }

    result.screenshots.dashboard = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-dashboard`);
    result.pageTextSnippet = await readBodyText(page);

    const refreshStarted = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(selectors.shellReady, { timeout: 30_000 });
    result.timings.refreshToShellMs = Date.now() - refreshStarted;
    result.screenshots.afterRefresh = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-after-refresh`);

    await clickVisible(page, ['[aria-label="Open profile editor"]', '[aria-label="Open profile menu"]'], 20_000);
    await page.waitForFunction(
      () => /Sign out/i.test(document.body?.innerText || ''),
      { timeout: 20_000 },
    );
    result.screenshots.profileMenu = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-profile-menu`);
    const signOutClicked = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('button')).find((node) =>
        /Sign out/i.test((node.textContent || '').trim()),
      ) as HTMLButtonElement | undefined;
      if (!button) {
        return false;
      }
      button.click();
      return true;
    });
    if (!signOutClicked) {
      throw new Error('Unable to find Sign out button.');
    }
    await page.waitForSelector(selectors.loginEmail, { timeout: 30_000 });
    result.screenshots.afterLogout = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-after-logout`);

    await page.type(selectors.loginEmail, sample.email);
    await page.type(selectors.loginPassword, userPassword);
    await page.click(selectors.loginSubmit);
    await page.waitForSelector(selectors.shellReady, { timeout: 30_000 });
    result.screenshots.afterRelogin = await takeShot(page, ctx.screenshotDir, `${viewport}-${sample.expectedState}-${sample.index}-after-relogin`);
    result.result = 'passed';
    return result;
  } finally {
    const sourcePath = artifactPath(ctx.sourceDir, 'browser-login-manifest-review', `${viewport}-${sample.expectedState}-${sample.index}-page-source`, 'html');
    await writeText(sourcePath, await page.content().catch(() => ''));
    await page.close().catch(() => undefined);
    await browserContext.close().catch(() => undefined);
  }
};

const main = async () => {
  if (!manifestPath) {
    throw new Error('PLATFORM_LOAD_USERS_FILE or ACTIVE_100_USERS_FILE is required.');
  }

  const users = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PreparedUser[];
  if (!users.length) {
    throw new Error(`Manifest is empty: ${manifestPath}`);
  }

  const ctx = await createRunContext();
  const admin = await loginApi(adminEmail, adminPassword, 'qa-browser-login-admin');
  const selected = chooseSamples(users);
  const summary: BrowserLoginSummary = {
    baseUrl,
    manifestPath,
    sampleSize: selected.length,
    courseId: courseId || null,
    startedAt: new Date().toISOString(),
    states: selected.map((user) => ({ email: user.email, state: user.expectedState })),
    results: [],
    restoredUsers: [],
    refreshedManifestTokens: [],
    skippedStates: courseId ? [] : ['manual_grant skipped because PLATFORM_LOAD_COURSE_ID is missing'],
    restoreFailures: [],
    refreshFailures: [],
    setupFailures: [],
    result: 'pending',
  };

  for (const sample of selected) {
    try {
      if (sample.userId) {
        sample.resolvedStudentId = sample.userId;
        continue;
      }
      const searchResult = await adminFetch<{ items?: Array<Record<string, unknown>> }>(
        admin.token,
        `/backend/api/admin/students?page=1&pageSize=5&search=${encodeURIComponent(sample.email)}`,
      );
      const match = (searchResult.items || []).find((item) =>
        String(item.email || '').trim().toLowerCase() === sample.email.trim().toLowerCase(),
      );
      sample.resolvedStudentId = match ? String(match.studentId || match._id || '') : null;
      if (!sample.resolvedStudentId) {
        throw new Error(`Unable to resolve student by email through admin search: ${sample.email}`);
      }
    } catch (error) {
      summary.setupFailures?.push({
        email: sample.email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const sample of selected) {
    try {
      if (!sample.resolvedStudentId) {
        throw new Error('Resolved student id missing before state setup.');
      }
      await applyState(admin.token, sample);
    } catch (error) {
      summary.setupFailures?.push({
        email: sample.email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const sample = selected[index];
      const viewport = index % 5 === 0 ? 'mobile' : 'desktop';
      if (!sample.resolvedStudentId) {
        (summary.results as LoginRun[]).push({
          email: sample.email,
          expectedState: sample.expectedState,
          viewport,
          result: 'failed',
          screenshots: {},
          consoleErrors: [],
          networkErrors: [],
          pageErrors: [],
          failure: 'Sample skipped because student resolution/setup failed.',
        });
        await persistSummary(ctx, summary);
        continue;
      }
      const result = await runLoginCheck(browser, ctx, sample, viewport).catch((error) => ({
        email: sample.email,
        expectedState: sample.expectedState,
        viewport,
        result: 'failed' as const,
        screenshots: {},
        consoleErrors: [],
        networkErrors: [],
        pageErrors: [],
        failure: error instanceof Error ? error.message : String(error),
      }));
      (summary.results as LoginRun[]).push(result);
      await persistSummary(ctx, summary);
      await sleep(900);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  for (const sample of selected) {
    try {
      await restoreState(admin.token, sample);
      summary.restoredUsers.push(sample.email);
    } catch (error) {
      summary.restoreFailures?.push({
        email: sample.email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await persistSummary(ctx, summary);
  }

  const manifestByEmail = new Map(users.map((user) => [user.email, user]));
  for (const sample of selected) {
    try {
      const refreshed = await loginApi(sample.email, userPassword, 'qa-browser-login-refresh-token');
      const target = manifestByEmail.get(sample.email);
      if (target) {
        target.token = refreshed.token;
        target.userId = refreshed.user?._id || target.userId;
        summary.refreshedManifestTokens.push(sample.email);
      }
    } catch (error) {
      summary.refreshFailures?.push({
        email: sample.email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await persistSummary(ctx, summary);
  }
  await fs.writeFile(manifestPath, JSON.stringify(Array.from(manifestByEmail.values()), null, 2), 'utf8');

  const failed = summary.results.filter((entry) => entry.result !== 'passed');
  summary.completedAt = new Date().toISOString();
  summary.result = failed.length ? 'failed' : 'passed';
  summary.failedCases = failed.map((entry) => ({
    email: entry.email,
    expectedState: entry.expectedState,
    failure: entry.failure || entry.pageTextSnippet || 'Unknown failure',
  }));

  const { summaryPath, notesPath } = await persistSummary(ctx, summary);
  console.log(JSON.stringify({ summaryPath, notesPath, result: summary.result, failedCases: summary.failedCases }, null, 2));

  if (failed.length) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
