import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { qaFetch } from './network.js';
import { writeJson, writeText } from './utils.js';
import { maybeStartLiveTestPublisher } from './live-publisher.js';
const require = createRequire(import.meta.url);
const jwt = require('../../backend/node_modules/jsonwebtoken');
const dotenv = require('dotenv');

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

type Viewer = {
  index: number;
  email: string;
  token: string;
};

type LoadSummary = {
  runId: string;
  baseUrl: string;
  apiBase: string;
  liveClassId: string | null;
  preparedUsersFile: string | null;
  viewersRequested: number;
  setupConcurrency: number;
  activeConcurrency: number;
  totalRequests: number;
  failedRequests: number;
  accessTypeCounts: Record<string, number>;
  metrics: Metric[];
  sampleErrors: string[];
  createdLiveClass?: Record<string, unknown> | null;
  crashed: boolean;
  crash?: string | null;
  soakDurationMs?: number;
  soakIntervalMs?: number;
};

type ViewerMode = 'livekit-room' | 'live-stream';
const livePlaybackMode = String(process.env.QA_LIVE_CERT_PLAYBACK_MODE || process.env.LIVE_LOAD_PLAYBACK_MODE || 'live-stream').trim().toLowerCase() === 'livekit'
  ? 'livekit'
  : 'live-stream';

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const rootDir = process.cwd();
const reportDir = path.join(rootDir, 'reports', `live-1000-${runId}`);
const viewersRequested = Math.max(1, Number(process.env.LIVE_LOAD_VIEWERS || 1000));
const setupConcurrency = Math.max(1, Number(process.env.LIVE_LOAD_SETUP_CONCURRENCY || 50));
const activeConcurrency = Math.max(1, Number(process.env.LIVE_LOAD_CONCURRENCY || 100));
const requestTimeoutMs = Math.max(5000, Number(process.env.LIVE_LOAD_TIMEOUT_MS || 30000));
const soakDurationMs = Math.max(0, Number(process.env.LIVE_LOAD_SOAK_MS || 0) || (Math.max(0, Number(process.env.LIVE_LOAD_SOAK_MINUTES || 0)) * 60_000));
const soakIntervalMs = Math.max(10_000, Number(process.env.LIVE_LOAD_SOAK_INTERVAL_MS || 60_000));
const adminEmail = process.env.LIVE_LOAD_ADMIN_EMAIL || process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || config.loginEmail || 'admin@local.edumaster';
const adminPassword = process.env.LIVE_LOAD_ADMIN_PASSWORD || process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'AdminChangeMe_2026';
const explicitUsersFile = process.env.LIVE_LOAD_USERS_FILE || '';
const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();
const apiBase = `${apiOrigin}/backend/api`;
const resolvedJwtSecret = (() => {
  if (process.env.LIVE_LOAD_JWT_SECRET) {
    return process.env.LIVE_LOAD_JWT_SECRET;
  }
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  const candidates = [
    path.join(rootDir, '.env.production'),
    path.join(rootDir, '..', '.env.production'),
  ];

  for (const candidate of candidates) {
    try {
      if (!fsSync.existsSync(candidate)) {
        continue;
      }
      const parsed = dotenv.parse(fsSync.readFileSync(candidate, 'utf8'));
      if (parsed.JWT_SECRET) {
        return parsed.JWT_SECRET;
      }
    } catch {
      // Ignore env parsing issues and fall through to the local default.
    }
  }

  return 'dev-only-secret';
})();

const metrics: Metric[] = [];

const percentile = (values: number[], target: number) => {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values: number[]) => (
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0
);

const summarizeByName = () => {
  const buckets = new Map<string, Metric[]>();

  for (const metric of metrics) {
    const bucket = buckets.get(metric.name) || [];
    bucket.push(metric);
    buckets.set(metric.name, bucket);
  }

  return Array.from(buckets.entries()).map(([name, rows]) => {
    const durations = rows.map((row) => row.durationMs);
    return {
      name,
      requests: rows.length,
      failures: rows.filter((row) => !row.ok).length,
      successRate: Number(((rows.filter((row) => row.ok).length / Math.max(rows.length, 1)) * 100).toFixed(2)),
      avgMs: average(durations),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      maxMs: durations.length ? Math.max(...durations) : 0,
      statuses: rows.reduce((acc, row) => {
        const key = String(row.status || 0);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      sampleErrors: rows.filter((row) => row.error).slice(0, 3).map((row) => row.error as string),
    };
  });
};

const request = async <T = unknown>(
  name: string,
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const started = performance.now();
  let status = 0;

  try {
    const response = await qaFetch(`${apiBase}${route}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
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
        payload = { message: text };
      }
    }
    const durationMs = Math.round(performance.now() - started);
    metrics.push({ name, method, path: route, status, ok: response.ok, durationMs });

    if (!response.ok) {
      const message = typeof payload === 'object' && payload
        ? String((payload as Record<string, unknown>).message || (payload as Record<string, unknown>).error || status)
        : String(status);
      throw Object.assign(new Error(`${method} ${route} failed with ${status}: ${message}`), {
        status,
        payload,
      });
    }

    return payload as T;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    metrics.push({ name, method, path: route, status, ok: false, durationMs, error: message, user: token ? 'viewer' : undefined });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const requestAbsolute = async (
  name: string,
  method: string,
  url: string,
  token?: string,
  headers: Record<string, string> = {},
  options: { suppressFailureMetric?: boolean } = {},
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const started = performance.now();
  let status = 0;

  try {
    const response = await qaFetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: controller.signal,
    });
    status = response.status;
    await response.text();
    const durationMs = Math.round(performance.now() - started);
    metrics.push({ name, method, path: url, status, ok: response.ok, durationMs });

    if (!response.ok) {
      throw new Error(`${method} ${url} failed with ${status}`);
    }
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const message = error instanceof Error ? error.message : String(error);
    if (!options.suppressFailureMetric) {
      metrics.push({ name, method, path: url, status, ok: false, durationMs, error: message, user: token ? 'viewer' : undefined });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const requestAbsoluteWithRetry = async (
  name: string,
  method: string,
  url: string,
  token?: string,
  attempts = 4,
) => {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await requestAbsolute(name, method, url, token);
      return;
    } catch (error) {
      lastError = error;
      const status = typeof error === 'object' && error && 'message' in error
        ? String((error as Error).message)
        : '';
      const retryable = /failed with (502|503|504)/i.test(status);
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await sleep(attempt * 1000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unknown absolute request failure'));
};

const shouldUseViewerAuthForAbsoluteUrl = (targetUrl: string) => {
  try {
    const target = new URL(targetUrl);
    const base = new URL(apiOrigin);
    return target.origin === base.origin;
  } catch {
    return true;
  }
};

const waitForStreamReady = async (manifestUrl: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await requestAbsolute('GET stream readiness', 'GET', manifestUrl, undefined, {}, {
        suppressFailureMetric: true,
      });
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /failed with (404|502|503|504)/i.test(message);
      if (!retryable) {
        throw error;
      }
      await sleep(2000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Stream did not become ready within ${timeoutMs}ms`);
};

const findPreparedUsersFile = async () => {
  if (explicitUsersFile) {
    return explicitUsersFile;
  }

  const reportsDir = path.join(rootDir, 'reports');
  try {
    const entries = await fs.readdir(reportsDir, { withFileTypes: true });
    const candidates: Array<{ file: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      for (const file of [
        path.join(reportsDir, entry.name, 'prepared-users.json'),
        path.join(reportsDir, entry.name, 'prepared-viewers.json'),
      ]) {
        try {
          const stat = await fs.stat(file);
          candidates.push({ file, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore missing manifests.
        }
      }
    }

    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return candidates[0]?.file || '';
  } catch {
    return '';
  }
};

const runPool = async <T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) => {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
};

const login = async (email: string, password: string, device: string) => {
  const response = await request<{ token: string }>('/auth/login', 'POST', '/auth/login', {
    email,
    password,
    device,
    forceLogoutOtherSessions: true,
  });
  return response.token;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runViewerSoak = async ({
  liveClassId,
  viewers,
  viewerMode,
}: {
  liveClassId: string;
  viewers: Viewer[];
  viewerMode: ViewerMode;
}) => {
  if (soakDurationMs <= 0) {
    return;
  }

  const deadline = Date.now() + soakDurationMs;
  let cycle = 0;

  while (Date.now() < deadline) {
    cycle += 1;
    await runPool(
      viewers,
      activeConcurrency,
      async (viewer) => {
        if (viewerMode === 'livekit-room') {
          await request(
            `POST /live-classes/${liveClassId}/session/heartbeat [cycle ${cycle}]`,
            'POST',
            `/live-classes/${liveClassId}/session/heartbeat`,
            {},
            viewer.token,
          );
        }

        const access = await request<Record<string, unknown>>(
          `GET /live-classes/${liveClassId}/access [cycle ${cycle}]`,
          'GET',
          `/live-classes/${liveClassId}/access`,
          undefined,
          viewer.token,
        );

        if (viewerMode === 'live-stream' && typeof access.streamUrl === 'string' && access.streamUrl) {
          const manifestUrl = new URL(access.streamUrl, apiOrigin).toString();
          await requestAbsoluteWithRetry(
            `GET stream ${liveClassId} [cycle ${cycle}]`,
            'GET',
            manifestUrl,
            shouldUseViewerAuthForAbsoluteUrl(manifestUrl) ? viewer.token : undefined,
          );
        }

        await request(
          `GET /live-classes/${liveClassId}/session [cycle ${cycle}]`,
          'GET',
          `/live-classes/${liveClassId}/session`,
          undefined,
          viewer.token,
        );
      },
    );

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(soakIntervalMs, remainingMs));
    }
  }
};

const publishManagedHls = async (streamKey: string) => {
  const [streamName, queryString = ''] = String(streamKey || '').split('?');
  const query = new URLSearchParams(queryString);
  const secret = query.get('secret') || '';
  if (!streamName || !secret) {
    return false;
  }

  await request(
    'POST /live-classes/ingest/on-publish',
    'POST',
    '/live-classes/ingest/on-publish',
    {
      action: 'publish',
      protocol: 'rtmp',
      name: streamName,
      secret,
    },
    undefined,
  );
  return true;
};

const seedViewerAccounts = async (viewerSeeds: Array<Pick<Viewer, 'index' | 'email'>>) => viewerSeeds.map((viewer) => {
  const userId = `live_viewer_${runId}_${viewer.index}`;
  const sessionId = Math.random().toString(36).slice(2, 14);
  return {
    index: viewer.index,
    email: viewer.email,
    token: jwt.sign(
      { id: userId, role: 'student', session: sessionId, email: viewer.email, name: `Live Viewer ${viewer.index + 1}` },
      resolvedJwtSecret,
      { expiresIn: '7d' },
    ),
  };
});

const ensureReportDir = async () => {
  await fs.mkdir(reportDir, { recursive: true });
};

const buildMarkdownReport = (summary: LoadSummary) => {
  const rows = summarizeByName();
  const lines = [
    '# Live 1,000-Viewer Load Report',
    '',
    `Run: ${summary.runId}`,
    `Base URL: ${summary.baseUrl}`,
    `Live class: ${summary.liveClassId || 'n/a'}`,
    `Viewers requested: ${summary.viewersRequested}`,
    `Setup concurrency: ${summary.setupConcurrency}`,
    `Active concurrency: ${summary.activeConcurrency}`,
    `Soak duration ms: ${summary.soakDurationMs || 0}`,
    `Soak interval ms: ${summary.soakIntervalMs || 0}`,
    '',
    '## Summary',
    `- Total requests: ${summary.totalRequests}`,
    `- Failed requests: ${summary.failedRequests}`,
    `- Crashed: ${summary.crashed ? 'yes' : 'no'}`,
    '',
    '## Endpoint Summary',
    '| Endpoint | Requests | Failures | Success | Avg ms | P95 ms | P99 ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.name} | ${row.requests} | ${row.failures} | ${row.successRate}% | ${row.avgMs} | ${row.p95Ms} | ${row.p99Ms} |`),
    '',
    '## Notes',
    '- This scenario is isolated to one live class and one viewer cohort.',
    '- If the class uses LiveKit, the script validates access, join, heartbeat, media state, and admin controls.',
    '- If the class uses managed HLS, the script validates protected stream fetches in addition to access and session state.',
  ];

  if (summary.sampleErrors.length) {
    lines.push('', '## Sample Errors', ...summary.sampleErrors.map((error) => `- ${error}`));
  }

  return lines.join('\n');
};

const main = async () => {
  await ensureReportDir();

  const summary: LoadSummary = {
    runId,
    baseUrl: apiOrigin,
    apiBase,
    liveClassId: null,
    preparedUsersFile: null,
    viewersRequested,
    setupConcurrency,
    activeConcurrency,
    totalRequests: 0,
    failedRequests: 0,
    accessTypeCounts: {},
    metrics,
    sampleErrors: [],
    createdLiveClass: null,
    crashed: false,
    crash: null,
  };
  let stopPublisher = async () => undefined;

  try {
    const adminToken = await login(adminEmail, adminPassword, 'live-load-admin');
    const preparedUsersFile = await findPreparedUsersFile();
    summary.preparedUsersFile = preparedUsersFile || null;

    let viewerSeeds: Array<Pick<Viewer, 'index' | 'email'>> = [];
    if (preparedUsersFile) {
      try {
        const raw = await fs.readFile(preparedUsersFile, 'utf8');
        const loaded = JSON.parse(raw) as Viewer[];
        viewerSeeds = loaded.slice(0, viewersRequested).map((viewer) => ({ index: viewer.index, email: viewer.email }));
        console.log(`Loaded ${viewerSeeds.length} prepared viewer seeds from ${preparedUsersFile}`);
      } catch {
        console.warn(`Failed to load prepared viewers from ${preparedUsersFile}; falling back to fresh viewer seeding.`);
        summary.preparedUsersFile = null;
      }
    }

    if (viewerSeeds.length < viewersRequested) {
      const existingEmails = new Set(viewerSeeds.map((viewer) => viewer.email));
      const startIndex = viewerSeeds.length;
      const fallbackSeeds = Array.from({ length: viewersRequested - viewerSeeds.length }, (_, offset) => {
        const index = startIndex + offset;
        let email = `live_viewer_${runId}_${index}@edumaster.local`;
        while (existingEmails.has(email)) {
          email = `live_viewer_${runId}_${index}_${Math.random().toString(36).slice(2, 8)}@edumaster.local`;
        }
        existingEmails.add(email);
        return {
          index,
          email,
        };
      });

      viewerSeeds = [...viewerSeeds, ...fallbackSeeds];
    }

    if (!viewerSeeds.length) {
      viewerSeeds = Array.from({ length: viewersRequested }, (_, index) => ({
        index,
        email: `live_viewer_${runId}_${index}@edumaster.local`,
      }));
    }

    const viewers = await seedViewerAccounts(viewerSeeds);

    const createResponse = await request<{ liveClass: Record<string, unknown> }>(
      'POST /live-classes',
      'POST',
      '/live-classes',
      {
        title: `Live Load Class ${Date.now()}`,
        startTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        durationMinutes: 120,
        provider: 'Live Load Runner',
        status: 'scheduled',
        attendees: 0,
        maxAttendees: viewersRequested,
        requiresEnrollment: false,
        chatEnabled: true,
        doubtSolving: true,
        replayAvailable: false,
        description: 'Dedicated live load scenario for 1,000 viewers.',
        livePlaybackType: livePlaybackMode,
        activePoll: {
          question: 'Which tool are you using today?',
          status: 'live',
          options: [
            { text: 'Mobile' },
            { text: 'Desktop' },
            { text: 'Tablet' },
          ],
        },
      },
      adminToken,
    );

    const liveClass = createResponse.liveClass;
    const liveClassId = String(liveClass._id || liveClass.id || '');
    summary.liveClassId = liveClassId;
    summary.createdLiveClass = liveClass;

    await request(
      'PATCH /live-classes/:id',
      'PATCH',
      `/live-classes/${liveClassId}`,
      {
        activePoll: {
          question: 'Which area should be optimized first?',
          status: 'live',
          options: [
            { text: 'Live playback' },
            { text: 'Chat/heartbeat' },
            { text: 'Admin controls' },
          ],
        },
      },
      adminToken,
    );

    await request('POST /live-classes/:id/start', 'POST', `/live-classes/${liveClassId}/start`, {}, adminToken);
    stopPublisher = await maybeStartLiveTestPublisher({
      ingestServerUrl: String(liveClass.ingestServerUrl || ''),
      ingestStreamKey: String(liveClass.ingestStreamKey || ''),
      envPrefix: 'LIVE_LOAD',
      runId,
    });
    await publishManagedHls(String(liveClass.ingestStreamKey || '')).catch(() => false);

    let adminAccess = await request<Record<string, unknown>>('GET /live-classes/:id/access', 'GET', `/live-classes/${liveClassId}/access`, undefined, adminToken);
    if (String(adminAccess.accessType || '') === 'live-stream' && !adminAccess.streamUrl) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await sleep(2000);
        adminAccess = await request<Record<string, unknown>>('GET /live-classes/:id/access', 'GET', `/live-classes/${liveClassId}/access`, undefined, adminToken);
        if (adminAccess.streamUrl) {
          break;
        }
      }
    }
    const viewerMode = String(adminAccess.accessType || 'unknown') as ViewerMode;
    summary.accessTypeCounts[viewerMode] = (summary.accessTypeCounts[viewerMode] || 0) + 1;
    if (!['livekit-room', 'live-stream'].includes(viewerMode)) {
      throw new Error(`Unsupported access type for live load: ${String(adminAccess.accessType || 'unknown')}`);
    }

    if (viewerMode === 'live-stream' && typeof adminAccess.streamUrl === 'string' && adminAccess.streamUrl) {
      const manifestUrl = new URL(adminAccess.streamUrl, apiOrigin).toString();
      await waitForStreamReady(manifestUrl);
    }

    if (viewerMode === 'livekit-room') {
      await request('POST /live-classes/:id/session/join', 'POST', `/live-classes/${liveClassId}/session/join`, {}, adminToken);
      await request('POST /live-classes/:id/session/media', 'POST', `/live-classes/${liveClassId}/session/media`, {
        micMuted: false,
        videoEnabled: true,
        isScreenSharing: true,
      }, adminToken);
      await request('POST /live-classes/:id/session/media', 'POST', `/live-classes/${liveClassId}/session/media`, {
        micMuted: false,
        videoEnabled: true,
        isScreenSharing: false,
      }, adminToken);
    }
    await request('PATCH /live-classes/:id', 'PATCH', `/live-classes/${liveClassId}`, {
      activePoll: {
        question: 'What should we revise next?',
        status: 'live',
        options: [
          { text: 'Numericals' },
          { text: 'Concepts' },
          { text: 'PYQs' },
        ],
      },
    }, adminToken);
    await request('GET /live-classes/:id/session', 'GET', `/live-classes/${liveClassId}/session`, undefined, adminToken);

    const started = Date.now();
    const results = await runPool(
      viewers,
      activeConcurrency,
      async (viewer) => {
        const access = await request<Record<string, unknown>>(
          `GET /live-classes/${liveClassId}/access`,
          'GET',
          `/live-classes/${liveClassId}/access`,
          undefined,
          viewer.token,
        );
        const accessType = String(access.accessType || 'unknown') as ViewerMode;
        summary.accessTypeCounts[accessType] = (summary.accessTypeCounts[accessType] || 0) + 1;

        if (!['livekit-room', 'live-stream'].includes(accessType)) {
          throw new Error(`Unsupported access type for live load: ${accessType}`);
        }

        if (
          livePlaybackMode === 'live-stream'
          && accessType === 'live-stream'
          && (typeof access.streamUrl !== 'string' || !access.streamUrl || /\/backend\/api\/live-classes\/stream\//.test(access.streamUrl))
        ) {
          throw new Error(`Live broadcast load certification requires a public live-domain HLS URL, received: ${String(access.streamUrl || 'none')}`);
        }

        if (accessType === 'livekit-room') {
          await request(
            `POST /live-classes/${liveClassId}/session/join`,
            'POST',
            `/live-classes/${liveClassId}/session/join`,
            {},
            viewer.token,
          );
          await request(
            `POST /live-classes/${liveClassId}/session/heartbeat`,
            'POST',
            `/live-classes/${liveClassId}/session/heartbeat`,
            {},
            viewer.token,
          );
        } else if (typeof access.streamUrl === 'string' && access.streamUrl) {
          const manifestUrl = new URL(access.streamUrl, apiOrigin).toString();
          await requestAbsoluteWithRetry(
            `GET stream ${liveClassId}`,
            'GET',
            manifestUrl,
            shouldUseViewerAuthForAbsoluteUrl(manifestUrl) ? viewer.token : undefined,
          );
        }
        await request(
          `GET /live-classes/${liveClassId}/session`,
          'GET',
          `/live-classes/${liveClassId}/session`,
          undefined,
          viewer.token,
        );

        return accessType;
      },
    );
    const totalMs = Date.now() - started;

    await runViewerSoak({
      liveClassId,
      viewers,
      viewerMode,
    });

    summary.totalRequests = metrics.length;
    summary.failedRequests = metrics.filter((metric) => !metric.ok).length;
    summary.sampleErrors = metrics.filter((metric) => metric.error).slice(0, 10).map((metric) => `${metric.name}: ${metric.error}`);

    const report: LoadSummary = {
      ...summary,
      crashed: false,
      crash: null,
      soakDurationMs,
      soakIntervalMs,
    };

    await writeJson(path.join(reportDir, 'full-automation-test-report.json'), {
      ...report,
      wallClockMs: totalMs,
      endpointSummary: summarizeByName(),
      viewerAccessTypes: results.reduce((acc, accessType) => {
        acc[accessType] = (acc[accessType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });
    await writeText(path.join(reportDir, 'full-automation-test-report.md'), buildMarkdownReport(report));
    await writeJson(path.join(reportDir, 'prepared-viewers.json'), viewers);

    console.log(JSON.stringify({
      runId: report.runId,
      liveClassId: report.liveClassId,
      viewers: viewersRequested,
      totalRequests: report.totalRequests,
      failedRequests: report.failedRequests,
      accessTypeCounts: report.accessTypeCounts,
      summary: summarizeByName(),
      reportDir,
    }, null, 2));
  } catch (error) {
    summary.crashed = true;
    summary.crash = error instanceof Error ? error.stack || error.message : String(error);
    summary.totalRequests = metrics.length;
    summary.failedRequests = metrics.filter((metric) => !metric.ok).length;
    summary.sampleErrors = metrics.filter((metric) => metric.error).slice(0, 10).map((metric) => `${metric.name}: ${metric.error}`);
    await writeJson(path.join(reportDir, 'full-automation-test-report.json'), summary);
    await writeText(path.join(reportDir, 'full-automation-test-report.md'), buildMarkdownReport(summary));
    throw error;
  } finally {
    await stopPublisher().catch(() => undefined);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
