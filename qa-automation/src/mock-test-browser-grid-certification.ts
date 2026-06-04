import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { createRunContext, ensureDir, writeJson } from './utils.js';

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
  users: GridUser[];
};

type WorkerReport = {
  generatedAt: string;
  manifestPath: string;
  reportPath: string;
  shard: {
    index: number;
    totalShards: number;
    userCount: number;
  };
  test: {
    id?: string;
    title: string;
  };
  successCount: number;
  failureCount: number;
  failureBreakdown: Record<string, number>;
  rankStatusBreakdown: Record<string, number>;
  learnerResults: Array<{
    ok: boolean;
    screenshots: Array<{ screenshotPath: string; sourcePath: string }>;
  }>;
};

const manifestPath = path.resolve(process.cwd(), process.env.QA_MOCK_TEST_GRID_MANIFEST_PATH || '');
const reportPath = path.resolve(process.cwd(), process.env.QA_MOCK_TEST_GRID_REPORT_PATH || `reports/mock-test-2k-browser-cert-${Date.now()}.json`);
const workerCount = Math.max(1, Number(process.env.QA_MOCK_TEST_GRID_WORKER_COUNT || process.env.QA_MOCK_TEST_GRID_TOTAL_SHARDS || 20));
const browsersPerWorker = Math.max(1, Number(process.env.QA_MOCK_TEST_GRID_BROWSERS_PER_WORKER || 10));
const localRun = ['1', 'true', 'yes', 'on'].includes(String(process.env.QA_MOCK_TEST_GRID_LOCAL_RUN || '').toLowerCase());
const screenshotSample = Math.max(1, Number(process.env.QA_MOCK_TEST_GRID_SCREENSHOT_SAMPLE || 12));
const startStaggerMs = Math.max(0, Number(process.env.QA_MOCK_TEST_GRID_START_STAGGER_MS || 150));
const scenario = String(process.env.QA_MOCK_TEST_GRID_SCENARIO || 'mixed-realistic').trim().toLowerCase();

const nowIso = () => new Date().toISOString();

const chunkUsers = <T>(items: T[], parts: number) => {
  const chunked: T[][] = Array.from({ length: parts }, () => []);
  items.forEach((item, index) => {
    chunked[index % parts].push(item);
  });
  return chunked.filter((chunk) => chunk.length > 0);
};

const aggregateBreakdown = (reports: WorkerReport[], key: 'failureBreakdown' | 'rankStatusBreakdown') => {
  const result: Record<string, number> = {};
  reports.forEach((report) => {
    Object.entries(report[key] || {}).forEach(([name, count]) => {
      result[name] = (result[name] || 0) + Number(count || 0);
    });
  });
  return result;
};

const runWorker = async ({
  shardPath,
  workerReportPath,
}: {
  shardPath: string;
  workerReportPath: string;
}) => new Promise<void>((resolve, reject) => {
  const child = spawn('node', ['--import', 'tsx', 'src/mock-test-browser-grid-worker.ts'], {
    cwd: path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '.' : 'qa-automation'),
    env: {
      ...process.env,
      QA_BASE_URL: config.baseUrl,
      QA_MOCK_TEST_GRID_SHARD_PATH: shardPath,
      QA_MOCK_TEST_GRID_WORKER_REPORT_PATH: workerReportPath,
      QA_MOCK_TEST_GRID_BROWSERS_PER_WORKER: String(browsersPerWorker),
      QA_MOCK_TEST_GRID_SCREENSHOT_SAMPLE: String(screenshotSample),
      QA_MOCK_TEST_GRID_START_STAGGER_MS: String(startStaggerMs),
      QA_MOCK_TEST_GRID_SCENARIO: scenario,
    },
    stdio: 'inherit',
  });

  child.on('error', reject);
  child.on('exit', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(`Worker failed for ${shardPath} with exit code ${code}`));
  });
});

const main = async () => {
  if (!manifestPath) {
    throw new Error('QA_MOCK_TEST_GRID_MANIFEST_PATH is required');
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as GridManifest;
  if (!Array.isArray(manifest.users) || !manifest.users.length) {
    throw new Error(`Browser grid manifest has no users: ${manifestPath}`);
  }

  const ctx = await createRunContext();
  const shardDir = path.join(ctx.analysisDir, 'mock-test-browser-grid-shards');
  const workerReportDir = path.join(ctx.analysisDir, 'mock-test-browser-grid-worker-reports');
  await Promise.all([ensureDir(shardDir), ensureDir(workerReportDir)]);

  const shards = chunkUsers(manifest.users, workerCount).map((users, index, allShards) => ({
    index,
    path: path.join(shardDir, `mock-test-browser-grid-shard-${String(index + 1).padStart(2, '0')}.json`),
    reportPath: path.join(workerReportDir, `mock-test-browser-grid-worker-${String(index + 1).padStart(2, '0')}.json`),
    manifest: {
      ...manifest,
      users,
      usersCount: users.length,
      shard: {
        index: index + 1,
        totalShards: allShards.length,
        userCount: users.length,
      },
    },
  }));

  await Promise.all(shards.map((shard) => writeJson(shard.path, shard.manifest)));

  const launchedWorkers: Array<{ shardPath: string; reportPath: string; ok: boolean; error?: string }> = [];
  if (localRun) {
    for (const shard of shards) {
      try {
        await runWorker({ shardPath: shard.path, workerReportPath: shard.reportPath });
        launchedWorkers.push({ shardPath: shard.path, reportPath: shard.reportPath, ok: true });
      } catch (error) {
        launchedWorkers.push({
          shardPath: shard.path,
          reportPath: shard.reportPath,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const workerReports = await Promise.all(shards.map(async (shard) => {
    try {
      return JSON.parse(await fs.readFile(shard.reportPath, 'utf8')) as WorkerReport;
    } catch {
      return null;
    }
  }));

  const completedReports = workerReports.filter(Boolean) as WorkerReport[];
  const report = {
    generatedAt: nowIso(),
    mode: localRun ? 'local-run' : 'prepare-only',
    baseUrl: config.baseUrl,
    manifestPath,
    reportPath,
    test: manifest.test,
    profile: manifest.profile || {},
    requestedUsers: manifest.users.length,
    workerCount,
    browsersPerWorker,
    startStaggerMs,
    screenshotSample,
    scenario,
    localRun,
    shards: shards.map((shard) => ({
      index: shard.manifest.shard.index,
      userCount: shard.manifest.shard.userCount,
      shardPath: shard.path,
      reportPath: shard.reportPath,
      completed: completedReports.some((entry) => entry.reportPath === shard.reportPath),
    })),
    launchedWorkers,
    completedWorkerReports: completedReports.length,
    successCount: completedReports.reduce((sum, entry) => sum + Number(entry.successCount || 0), 0),
    failureCount: completedReports.reduce((sum, entry) => sum + Number(entry.failureCount || 0), 0),
    failureBreakdown: aggregateBreakdown(completedReports, 'failureBreakdown'),
    rankStatusBreakdown: aggregateBreakdown(completedReports, 'rankStatusBreakdown'),
    screenshotPaths: completedReports.flatMap((entry) => entry.learnerResults.flatMap((result) => result.screenshots.map((shot) => shot.screenshotPath))).slice(0, 100),
    classification: !localRun
      ? 'prepared-for-distributed-run'
      : launchedWorkers.some((entry) => !entry.ok)
        ? 'infrastructure/browser-capacity issue'
        : completedReports.some((entry) => entry.failureCount > 0)
          ? 'UI/timer flow bug'
          : 'pass',
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));

  if (localRun && (report.failureCount > 0 || report.launchedWorkers.some((entry) => !entry.ok))) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
