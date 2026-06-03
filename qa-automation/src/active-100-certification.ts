import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { automationRoot, config } from './config.js';
import { createRunContext, writeJson, writeText } from './utils.js';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type ScriptResult = {
  name: string;
  command: string[];
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
  reportDir: string | null;
  summaryPath: string | null;
};

const rootDir = path.resolve(automationRoot, '..');
const qaDir = automationRoot;
const baseUrl = process.env.QA_BASE_URL || config.baseUrl || 'https://app.varonenglishapp.in';
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const manifestPath = process.env.ACTIVE_100_USERS_FILE || process.env.PLATFORM_LOAD_USERS_FILE || '';
const courseId = String(process.env.PLATFORM_LOAD_COURSE_ID || '').trim();
const lessonId = String(process.env.PLATFORM_LOAD_LESSON_ID || '').trim();
const users = Math.max(1, Number(process.env.PLATFORM_LOAD_USERS || 100));
const activeConcurrency = Math.max(1, Number(process.env.PLATFORM_LOAD_ACTIVE_CONCURRENCY || users));
const logoutFraction = String(process.env.PLATFORM_LOAD_LOGOUT_FRACTION || '0.3');
const skipDbBoundChecks = ['1', 'true', 'yes', 'on'].includes(String(process.env.ACTIVE_100_SKIP_DB_BOUND || '').toLowerCase())
  || !String(process.env.POSTGRES_URL || '').trim();
const allowUnsafeLoadPaths = ['1', 'true', 'yes', 'on'].includes(String(process.env.ACTIVE_100_ALLOW_UNSAFE_PATHS || '').toLowerCase());
const enableLive = allowUnsafeLoadPaths ? String(process.env.PLATFORM_LOAD_ENABLE_LIVE || 'false') : 'false';
const enableVideoProgress = allowUnsafeLoadPaths ? String(process.env.PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS || 'false') : 'false';
const enableEnroll = allowUnsafeLoadPaths ? String(process.env.PLATFORM_LOAD_ENABLE_ENROLL || 'false') : 'false';
const enableProfileUpdate = String(process.env.PLATFORM_LOAD_ENABLE_PROFILE_UPDATE || 'false');
const enablePaymentCheckout = allowUnsafeLoadPaths ? String(process.env.PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT || 'false') : 'false';

const execCommand = async (command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdoutPath: string; stderrPath: string }) => {
  await fs.mkdir(path.dirname(options.stdoutPath), { recursive: true });
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd || rootDir,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  await fs.writeFile(options.stdoutPath, Buffer.concat(stdoutChunks));
  await fs.writeFile(options.stderrPath, Buffer.concat(stderrChunks));
  return exitCode;
};

const latestReportDir = async (prefix: string) => {
  const reportsRoot = path.join(qaDir, 'reports');
  const entries = await fs.readdir(reportsRoot, { withFileTypes: true }).catch(() => []);
  const matches = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return matches.length ? path.join(reportsRoot, matches[0]) : null;
};

const runNpmScript = async (
  ctxRoot: string,
  name: string,
  scriptName: string,
  env: NodeJS.ProcessEnv,
  reportPrefix?: string,
) => {
  const stdoutPath = path.join(ctxRoot, 'logs', `${name}.stdout.log`);
  const stderrPath = path.join(ctxRoot, 'logs', `${name}.stderr.log`);
  const beforeReport = reportPrefix ? await latestReportDir(reportPrefix) : null;
  const exitCode = await execCommand(['npm', '--prefix', qaDir, 'run', scriptName], {
    cwd: rootDir,
    env,
    stdoutPath,
    stderrPath,
  });
  const afterReport = reportPrefix ? await latestReportDir(reportPrefix) : null;
  const reportDir = afterReport && afterReport !== beforeReport ? afterReport : afterReport;
  const summaryPath = reportDir ? path.join(reportDir, 'full-automation-test-report.json') : null;
  return {
    name,
    command: ['npm', '--prefix', qaDir, 'run', scriptName],
    exitCode,
    stdoutPath,
    stderrPath,
    reportDir,
    summaryPath,
  } satisfies ScriptResult;
};

const runNodeScript = async (
  ctxRoot: string,
  name: string,
  relativeScriptPath: string,
  env: NodeJS.ProcessEnv,
) => {
  const stdoutPath = path.join(ctxRoot, 'logs', `${name}.stdout.log`);
  const stderrPath = path.join(ctxRoot, 'logs', `${name}.stderr.log`);
  const exitCode = await execCommand(['node', '--import', 'tsx', relativeScriptPath], {
    cwd: qaDir,
    env,
    stdoutPath,
    stderrPath,
  });
  return {
    name,
    command: ['node', '--import', 'tsx', relativeScriptPath],
    exitCode,
    stdoutPath,
    stderrPath,
    reportDir: null,
    summaryPath: null,
  } satisfies ScriptResult;
};

const fetchText = async (url: string) => {
  const response = await fetch(url);
  const body = await response.text();
  return { status: response.status, ok: response.ok, body: body.slice(0, 2000) };
};

const captureProdDiagnostics = async (ctxRoot: string, label: string) => {
  const outputDir = path.join(ctxRoot, 'analysis', label);
  await fs.mkdir(outputDir, { recursive: true });
  const apiOrigin = new URL(baseUrl).origin;
  const health = {
    root: await fetchText(apiOrigin),
    live: await fetchText(`${apiOrigin}/backend/api/live`),
    ready: await fetchText(`${apiOrigin}/backend/api/ready`),
    health: await fetchText(`${apiOrigin}/backend/api/health`),
  };
  await writeJson(path.join(outputDir, 'public-health.json'), health);

  const diagnostics: Record<string, string> = {};
  const commands: Array<[string, string[]]> = [
    ['docker-ps', ['ssh', 'root@178.105.48.179', 'docker ps --format "table {{.Names}}\\t{{.Status}}"']],
    ['docker-stats', ['ssh', 'root@178.105.48.179', 'docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}"']],
    ['docker-health', ['ssh', 'root@178.105.48.179', 'docker inspect lowcost-app-1 lowcost-app-2-1 --format "{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}"']],
    ['caddy-errors', ['ssh', 'root@178.105.48.179', 'docker logs --since 10m lowcost-caddy-1 2>&1 | egrep -i "502|503|504|connection refused|reset by peer|no upstream|server misbehaving" || true']],
    ['app-1-errors', ['ssh', 'root@178.105.48.179', 'docker logs --since 10m lowcost-app-1 2>&1 | tail -n 200']],
    ['app-2-errors', ['ssh', 'root@178.105.48.179', 'docker logs --since 10m lowcost-app-2-1 2>&1 | tail -n 200']],
  ];

  for (const [name, command] of commands) {
    const stdoutPath = path.join(outputDir, `${name}.log`);
    const stderrPath = path.join(outputDir, `${name}.err.log`);
    const exitCode = await execCommand(command, { stdoutPath, stderrPath, cwd: rootDir });
    diagnostics[name] = `exitCode=${exitCode}; stdout=${stdoutPath}; stderr=${stderrPath}`;
  }

  await writeJson(path.join(outputDir, 'diagnostics.json'), diagnostics);
  return { health, diagnostics };
};

const main = async () => {
  if (!manifestPath) {
    throw new Error('ACTIVE_100_USERS_FILE or PLATFORM_LOAD_USERS_FILE is required.');
  }
  if (!courseId || !lessonId) {
    throw new Error('PLATFORM_LOAD_COURSE_ID and PLATFORM_LOAD_LESSON_ID are required for active certification.');
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PreparedUser[];
  if (!manifest.length) {
    throw new Error(`Prepared users manifest is empty: ${manifestPath}`);
  }

  const ctx = await createRunContext();
  const summary: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    baseUrl,
    manifestPath,
    courseId,
    lessonId,
    users,
    activeConcurrency,
    logoutFraction,
    scripts: [],
  };

  await captureProdDiagnostics(ctx.rootDir, 'before');

  const commonEnv = {
    QA_BASE_URL: baseUrl,
    QA_ADMIN_EMAIL: adminEmail,
    QA_ADMIN_PASSWORD: adminPassword,
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
  };

  const activeLoad = await runNpmScript(
    ctx.rootDir,
    'active-platform-load',
    'load:platform',
    {
      ...commonEnv,
      PLATFORM_LOAD_USERS_FILE: manifestPath,
      PLATFORM_LOAD_USERS: String(users),
      PLATFORM_LOAD_ACTIVE_CONCURRENCY: String(activeConcurrency),
      PLATFORM_LOAD_TIMEOUT_MS: String(process.env.PLATFORM_LOAD_TIMEOUT_MS || 60000),
      PLATFORM_LOAD_COURSE_ID: courseId,
      PLATFORM_LOAD_LESSON_ID: lessonId,
      PLATFORM_LOAD_LOGOUT_FRACTION: logoutFraction,
      PLATFORM_LOAD_ENABLE_LIVE: enableLive,
      PLATFORM_LOAD_ENABLE_VIDEO_PROGRESS: enableVideoProgress,
      PLATFORM_LOAD_ENABLE_ENROLL: enableEnroll,
      PLATFORM_LOAD_ENABLE_PROFILE_UPDATE: enableProfileUpdate,
      PLATFORM_LOAD_ENABLE_PAYMENT_CHECKOUT: enablePaymentCheckout,
    },
    'platform-1000-',
  );
  (summary.scripts as ScriptResult[]).push(activeLoad);

  const sentinelUser = manifest[manifest.length - 1];
  const overviewReview = await runNodeScript(
    ctx.rootDir,
    'overview-review',
    'src/overview-figma-review.ts',
    {
      ...commonEnv,
      QA_BASE_URL: baseUrl,
      QA_LOGIN_EMAIL: sentinelUser.email,
      QA_LOGIN_PASSWORD: process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123',
    },
  );
  (summary.scripts as ScriptResult[]).push(overviewReview);

  const studentShellReview = await runNodeScript(
    ctx.rootDir,
    'student-shell-review',
    'src/student-shell-review.ts',
    {
      ...commonEnv,
      QA_BASE_URL: baseUrl,
      QA_LOGIN_EMAIL: sentinelUser.email,
      QA_LOGIN_PASSWORD: process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123',
    },
  );
  (summary.scripts as ScriptResult[]).push(studentShellReview);

  const adminTabSmoke = await runNodeScript(
    ctx.rootDir,
    'admin-tab-smoke',
    'src/admin-tab-smoke-review.ts',
    commonEnv,
  );
  (summary.scripts as ScriptResult[]).push(adminTabSmoke);

  const paymentControl = await runNodeScript(
    ctx.rootDir,
    'payment-admin-control',
    'src/payment-admin-control-center-review.ts',
    {
      ...commonEnv,
      QA_SKIP_BULK_SYNC: process.env.QA_SKIP_BULK_SYNC || 'true',
    },
  );
  (summary.scripts as ScriptResult[]).push(paymentControl);

  const mobileSentinelUser = manifest[Math.max(0, manifest.length - 2)] || sentinelUser;
  const coursePlayerReview = await runNodeScript(
    ctx.rootDir,
    'course-player-review',
    'src/course-player-fullscreen-mobile-review.ts',
    {
      ...commonEnv,
      QA_BASE_URL: baseUrl,
      QA_LOGIN_EMAIL: sentinelUser.email,
      QA_LOGIN_PASSWORD: process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123',
      QA_MOBILE_LOGIN_EMAIL: mobileSentinelUser.email,
      QA_MOBILE_LOGIN_PASSWORD: process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123',
      QA_COURSE_TEXT: process.env.QA_COURSE_TEXT || 'SSC',
      QA_LESSON_TEXT: process.env.QA_LESSON_TEXT || '',
    },
  );
  (summary.scripts as ScriptResult[]).push(coursePlayerReview);

  if (!skipDbBoundChecks) {
    const paidRepair = await runNodeScript(
      ctx.rootDir,
      'admin-paid-repair',
      'src/admin-ops-paid-repair-review.ts',
      {
        ...commonEnv,
        POSTGRES_URL: process.env.POSTGRES_URL || '',
      },
    );
    (summary.scripts as ScriptResult[]).push(paidRepair);
  }

  await captureProdDiagnostics(ctx.rootDir, 'after');

  summary.completedAt = new Date().toISOString();
  summary.failedScripts = (summary.scripts as ScriptResult[]).filter((item) => item.exitCode !== 0).map((item) => item.name);
  summary.skippedChecks = skipDbBoundChecks ? ['admin-paid-repair'] : [];
  summary.result = (summary.failedScripts as string[]).length === 0 ? 'passed' : 'failed';

  const summaryPath = path.join(ctx.rootDir, 'active-100-certification-summary.json');
  const notesPath = path.join(ctx.rootDir, 'active-100-certification-summary.md');
  await writeJson(summaryPath, summary);
  await writeText(
    notesPath,
    [
      `Base URL: ${baseUrl}`,
      `Manifest: ${manifestPath}`,
      `Users: ${users}`,
      `Active concurrency: ${activeConcurrency}`,
      `Result: ${summary.result}`,
      `Failed scripts: ${JSON.stringify(summary.failedScripts)}`,
      `Summary: ${summaryPath}`,
    ].join('\n'),
  );
  console.log(JSON.stringify({ summaryPath, notesPath, result: summary.result, failedScripts: summary.failedScripts }, null, 2));

  if ((summary.failedScripts as string[]).length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
