import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { config } from './config.js';
import { qaFetch } from './network.js';

type Json = Record<string, unknown>;

type Metric = {
  name: string;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  durationMs: number;
  user?: string;
  error?: string;
};

type LoadUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const rootDir = path.resolve(process.cwd());
const resolveRootEnvPath = () => {
  const workspaceRoot = path.resolve(rootDir, path.basename(rootDir) === 'qa-automation' ? '..' : '.');
  const requestedEnvFile = String(process.env.ENV_FILE || '').trim();
  if (requestedEnvFile) {
    return path.isAbsolute(requestedEnvFile)
      ? requestedEnvFile
      : path.resolve(workspaceRoot, requestedEnvFile);
  }
  return path.join(workspaceRoot, '.env');
};
dotenv.config({ path: resolveRootEnvPath() });
const reportDir = path.join(rootDir, 'reports', `phase2-student-load-${runId}`);
const configuredBaseUrl = process.env.QA_BASE_URL || config.baseUrl || 'http://127.0.0.1:3300';
const apiOrigin = (() => {
  const url = new URL(configuredBaseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();
const apiBase = `${apiOrigin}/backend/api`;

const VUS = Math.max(1, Number(process.env.PHASE2_LOAD_USERS || 100));
const SETUP_CONCURRENCY = Math.max(1, Number(process.env.PHASE2_LOAD_SETUP_CONCURRENCY || 25));
const ACTIVE_CONCURRENCY = Math.max(1, Number(process.env.PHASE2_LOAD_ACTIVE_CONCURRENCY || VUS));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.PHASE2_LOAD_TIMEOUT_MS || 30000));
const USER_PASSWORD = process.env.PHASE2_LOAD_USER_PASSWORD || 'Student@123';
const EXISTING_USERS_FILE = process.env.PHASE2_LOAD_USERS_FILE || '';
const PARTIAL_REPORT_INTERVAL_MS = Math.max(5000, Number(process.env.PHASE2_LOAD_PARTIAL_REPORT_MS || 15000));
const SYNTHETIC_USER_EMAIL_PREFIX = 'phase2_load_';
const TRANSIENT_GET_RETRIES = Math.max(0, Number(process.env.PHASE2_LOAD_TRANSIENT_GET_RETRIES || 2));
const IDEMPOTENT_POST_RETRIES = Math.max(0, Number(process.env.PHASE2_LOAD_IDEMPOTENT_POST_RETRIES || 2));

const metrics: Metric[] = [];
const progress = {
  phase: 'initializing',
  preparedUsers: 0,
  startedJourneys: 0,
  completedJourneys: 0,
  successfulJourneys: 0,
};

const percentile = (values: number[], target: number) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values: number[]) =>
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

const pickId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Record<string, unknown>;
  return item._id || item.id ? String(item._id || item.id) : null;
};

const recordMetric = (metric: Metric) => {
  metrics.push(metric);
};

const request = async <T = unknown>(
  name: string,
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  user?: string,
): Promise<T | null> => {
  const normalizedMethod = method.toUpperCase();
  const idempotentPost = normalizedMethod === 'POST' && route === '/auth/logout';
  const attempts = normalizedMethod === 'GET'
    ? TRANSIENT_GET_RETRIES + 1
    : idempotentPost
      ? IDEMPOTENT_POST_RETRIES + 1
      : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = performance.now();
    let status = 0;

    try {
      const response = await qaFetch(`${apiBase}${route}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      status = response.status;
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      recordMetric({
        name,
        method,
        path: route,
        status,
        ok: response.ok,
        durationMs: Math.round(performance.now() - started),
        user,
      });

      if (!response.ok) {
        const detail = typeof payload === 'string'
          ? payload.slice(0, 120)
          : `${status}`;
        throw Object.assign(new Error(`${method} ${route} failed with ${status}: ${detail}`), { status, payload });
      }
      return payload as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = attempt + 1 < attempts && status === 0 && /aborted|timeout|fetch failed|econnreset|econnrefused/i.test(message);
      if (isRetryable) {
        continue;
      }
      recordMetric({
        name,
        method,
        path: route,
        status,
        ok: false,
        durationMs: Math.round(performance.now() - started),
        user,
        error: message,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Request failed without terminal response: ${method} ${route}`);
};

const runPool = async <T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) => {
  const results: R[] = [];
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(runners);
  return results;
};

const summarizeByName = () => {
  const grouped = new Map<string, Metric[]>();
  metrics.forEach((metric) => {
    const list = grouped.get(metric.name) || [];
    list.push(metric);
    grouped.set(metric.name, list);
  });

  return Array.from(grouped.entries()).map(([name, list]) => {
    const durations = list.map((metric) => metric.durationMs);
    const failures = list.filter((metric) => !metric.ok);
    return {
      name,
      requests: list.length,
      failures: failures.length,
      errorRate: list.length ? Number(((failures.length / list.length) * 100).toFixed(2)) : 0,
      avgMs: average(durations),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
    };
  }).sort((left, right) => right.p95Ms - left.p95Ms);
};

const currentSummary = (extra: Json = {}) => ({
  runId,
  baseUrl: apiOrigin,
  usersRequested: VUS,
  setupConcurrency: SETUP_CONCURRENCY,
  activeConcurrency: ACTIVE_CONCURRENCY,
  progress: { ...progress },
  totalRequests: metrics.length,
  failedRequests: metrics.filter((metric) => !metric.ok).length,
  failedRequestSamples: metrics.filter((metric) => !metric.ok).slice(0, 20),
  endpointSummary: summarizeByName(),
  ...extra,
});

const writePartialReport = async (reason: string) => {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'partial-report.json'), JSON.stringify(currentSummary({ partial: true, reason }), null, 2));
};

const login = async (email: string, password: string, device: string) => {
  const payload = await request<{ token: string; user: Json }>('auth.login', 'POST', '/auth/login', {
    email,
    password,
    device,
    forceLogoutOtherSessions: true,
  }, undefined, email);
  if (!payload?.token) {
    throw new Error(`Login did not return token for ${email}`);
  }
  return payload;
};

const registerAndLoginSyntheticUser = async (email: string, index: number, mobileSeed: string) => {
  try {
    await request('auth.register', 'POST', '/auth/register', {
      name: `Phase2 Load User ${index + 1}`,
      email,
      password: USER_PASSWORD,
      mobileNumber: `9${mobileSeed}${String(index).padStart(4, '0')}`.slice(0, 10),
    }, undefined, email);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /aborted|fetch failed|timeout/i.test(message);
    if (!retryable) {
      throw error;
    }
    try {
      return await login(email, USER_PASSWORD, `phase2-load-recover-${index + 1}`);
    } catch {
      await request('auth.register', 'POST', '/auth/register', {
        name: `Phase2 Load User ${index + 1}`,
        email,
        password: USER_PASSWORD,
        mobileNumber: `9${mobileSeed}${String(index).padStart(4, '0')}`.slice(0, 10),
      }, undefined, email);
    }
  }
  return login(email, USER_PASSWORD, `phase2-load-${index + 1}`);
};

const prepareUsers = async (): Promise<LoadUser[]> => {
  if (EXISTING_USERS_FILE) {
    const loaded = JSON.parse(await fs.readFile(EXISTING_USERS_FILE, 'utf8')) as LoadUser[];
    const unsafeUser = loaded.find((user) => !String(user.email || '').startsWith(SYNTHETIC_USER_EMAIL_PREFIX));
    if (unsafeUser) {
      throw new Error(`Refusing to use non-synthetic account in load test: ${unsafeUser.email}`);
    }
    progress.preparedUsers = Math.min(loaded.length, VUS);
    return loaded.slice(0, VUS);
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mobileSeed = String(Date.now()).slice(-5);
  const indexes = Array.from({ length: VUS }, (_, index) => index);
  return runPool(indexes, SETUP_CONCURRENCY, async (index) => {
    const email = `phase2_load_${suffix}_${index}@edumaster.local`;
    const loginPayload = await registerAndLoginSyntheticUser(email, index, mobileSeed);
    progress.preparedUsers += 1;
    return {
      index,
      email,
      token: loginPayload.token,
      userId: pickId(loginPayload.user),
      name: `Phase2 Load User ${index + 1}`,
    };
  });
};

const warmPublicCourseTargets = async () => {
  const courses = await request<Json[]>('public.courses', 'GET', '/courses');
  const firstCourseId = Array.isArray(courses) && courses.length > 0 ? pickId(courses[0]) : null;
  return { firstCourseId };
};

const runUserJourney = async (user: LoadUser, targets: { firstCourseId: string | null }) => {
  const token = (await login(user.email, USER_PASSWORD, `phase2-load-run-${user.index + 1}`)).token;
  const courseId = targets.firstCourseId;

  const steps: Array<() => Promise<unknown>> = [
    () => request('platform.overview', 'GET', '/platform/overview', undefined, token, user.email),
    () => request('courses.list', 'GET', '/courses', undefined, token, user.email),
    () => courseId ? request('courses.detail', 'GET', `/courses/${courseId}`, undefined, token, user.email) : Promise.resolve(null),
    () => courseId ? request('courses.lessons', 'GET', `/courses/${courseId}/lessons`, undefined, token, user.email) : Promise.resolve(null),
    () => request('notifications.list', 'GET', '/notifications?limit=10', undefined, token, user.email),
    () => request('users.analytics', 'GET', '/users/analytics', undefined, token, user.email),
    () => request('auth.session', 'GET', '/auth/session', undefined, token, user.email),
    () => request('auth.logout', 'POST', '/auth/logout', {}, token, user.email),
  ];

  for (const step of steps) {
    await step();
  }
};

const main = async () => {
  await fs.mkdir(reportDir, { recursive: true });
  const partialTimer = setInterval(() => {
    void writePartialReport('periodic');
  }, PARTIAL_REPORT_INTERVAL_MS);

  try {
    progress.phase = 'preparing-users';
    const users = await prepareUsers();
    await fs.writeFile(path.join(reportDir, 'prepared-users.json'), JSON.stringify(users, null, 2));

    progress.phase = 'warming-targets';
    const targets = await warmPublicCourseTargets();

    progress.phase = 'running-load';
    await runPool(users, ACTIVE_CONCURRENCY, async (user) => {
      progress.startedJourneys += 1;
      try {
        await runUserJourney(user, targets);
        progress.successfulJourneys += 1;
      } catch {
        // Keep the regression running so the final artifact shows complete failure distribution.
      } finally {
        progress.completedJourneys += 1;
      }
    });

    progress.phase = 'completed';
    const summary = currentSummary({
      artifacts: {
        reportDir,
        reportJson: path.join(reportDir, 'full-automation-test-report.json'),
      },
    });
    await fs.writeFile(path.join(reportDir, 'full-automation-test-report.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    clearInterval(partialTimer);
  }
};

main().catch(async (error) => {
  const summary = currentSummary({
    crashed: true,
    error: error instanceof Error ? error.message : String(error),
  });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'full-automation-test-report.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exit(1);
});
