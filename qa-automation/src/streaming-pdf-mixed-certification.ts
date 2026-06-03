import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  certificationModeSummary,
  isProdSafeExistingDataMode,
  requireValueInProdSafeMode,
} from './certification-mode.js';
import { loadStreamCertTargets, type StreamCertTarget } from './stream-cert-targets.js';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type StageRecord = {
  label: string;
  kind: 'single' | 'parallel';
  ok: boolean;
  logs: string[];
  details?: Record<string, unknown>;
};

const workspaceRoot = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
const qaRoot = path.join(workspaceRoot, 'qa-automation');
const reportRoot = path.join(workspaceRoot, 'reports');
const latestReportDir = path.join(reportRoot, 'streaming-pdf-mixed-certification', 'latest');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.join(reportRoot, `streaming-pdf-mixed-certification-${runId}`);
const envFile = String(process.env.ENV_FILE || path.join(workspaceRoot, '.env.staging.private-mirror')).trim();
const baseUrl = String(process.env.QA_BASE_URL || '').trim();
const PROD_SAFE_MODE = isProdSafeExistingDataMode();
const userPassword = String(process.env.PLATFORM_LOAD_USER_PASSWORD || process.env.QA_LOGIN_PASSWORD || 'Student@123').trim();
const browserStageCounts = String(
  process.env.QA_STREAM_CERT_BROWSER_STAGES
  || process.env.QA_STREAM_CERT_STAGES
  || (PROD_SAFE_MODE ? '1,3' : '100,200'),
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const syntheticTotalStageCounts = String(
  process.env.QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES
  || (PROD_SAFE_MODE ? '' : '1000,2000'),
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const backgroundRatio = Math.max(0, Number(process.env.QA_STREAM_BACKGROUND_RATIO || 1));
const screenshotSample = Math.max(6, Number(process.env.QA_VIDEO_BROWSER_SCREENSHOT_SAMPLE || 6));
const requestedTargetKey = String(process.env.QA_STREAM_CERT_TARGET_KEY || '').trim().toLowerCase();
const requestedTargetIndex = String(process.env.QA_STREAM_CERT_TARGET_INDEX || '').trim();
const syntheticVideoPercent = Math.max(0, Math.min(100, Number(process.env.QA_STREAM_CERT_SYNTHETIC_VIDEO_PERCENT || 70)));
const syntheticPdfPercent = Math.max(0, Math.min(100, Number(process.env.QA_STREAM_CERT_SYNTHETIC_PDF_PERCENT || 16)));
const syntheticAuthPercent = Math.max(0, Math.min(100, Number(process.env.QA_STREAM_CERT_SYNTHETIC_AUTH_PERCENT || 4)));
const syntheticTestPercent = Math.max(0, Math.min(100, Number(process.env.QA_STREAM_CERT_SYNTHETIC_TEST_PERCENT || 10)));
const existingBrowserManifestPath = String(process.env.QA_STREAM_CERT_BROWSER_USERS_FILE || process.env.COURSE_LOAD_USERS_FILE || process.env.PLATFORM_LOAD_USERS_FILE || '').trim();
const existingBackgroundManifestPath = String(process.env.QA_STREAM_CERT_BACKGROUND_USERS_FILE || process.env.PLATFORM_LOAD_USERS_FILE || '').trim();
const existingSyntheticVideoManifestPath = String(process.env.QA_STREAM_CERT_SYNTHETIC_VIDEO_USERS_FILE || process.env.COURSE_LOAD_USERS_FILE || '').trim();

const ensureDir = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true });
};

const publishLatestArtifacts = async (summary: Record<string, unknown>) => {
  await ensureDir(latestReportDir);
  await fs.writeFile(
    path.join(latestReportDir, 'streaming-pdf-mixed-certification-summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
};

const validateEnvironment = () => {
  if (!baseUrl) {
    throw new Error('QA_BASE_URL is required for streaming/PDF mixed certification.');
  }
  if (!PROD_SAFE_MODE && !/(^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$))|(\.nip\.io(?:\/|$))/i.test(baseUrl)) {
    throw new Error(`QA_BASE_URL must point at localhost or the private mirror nip.io host. Got: ${baseUrl}`);
  }
  if (browserStageCounts.length === 0) {
    throw new Error('QA_STREAM_CERT_BROWSER_STAGES must contain at least one positive stage size.');
  }
  if (!PROD_SAFE_MODE && syntheticTotalStageCounts.length === 0) {
    throw new Error('QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES must contain at least one positive stage size.');
  }
  const totalWeight = syntheticVideoPercent + syntheticPdfPercent + syntheticAuthPercent + syntheticTestPercent;
  if (Math.abs(totalWeight - 100) > 0.01) {
    throw new Error(`Synthetic mixed percent split must total 100. Got ${totalWeight}.`);
  }
  if (PROD_SAFE_MODE) {
    requireValueInProdSafeMode('QA_STREAM_CERT_BROWSER_USERS_FILE', existingBrowserManifestPath);
    requireValueInProdSafeMode('QA_STREAM_CERT_BACKGROUND_USERS_FILE', existingBackgroundManifestPath);
    if (syntheticTotalStageCounts.length > 0) {
      throw new Error('QA_STREAM_CERT_SYNTHETIC_VIDEO_STAGES is not allowed in prod-safe mode.');
    }
  }
};

const readPreparedUsers = async (filePath: string) => {
  const users = JSON.parse(await fs.readFile(filePath, 'utf8')) as PreparedUser[];
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error(`Prepared user manifest is empty: ${filePath}`);
  }
  return users;
};

const resolveManifestPath = (value: string) =>
  path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);

const buildBaseEnv = (target: StreamCertTarget) => ({
  ...process.env,
  ENV_FILE: envFile,
  QA_BASE_URL: baseUrl,
  QA_COURSE_ID: target.courseId,
  QA_LESSON_ID: target.lessonId,
  QA_COURSE_TEXT: target.courseText,
  QA_LESSON_TEXT: target.lessonText,
  QA_WATCH_LIMIT_COURSE_ID: target.courseId,
  QA_WATCH_LIMIT_LESSON_ID: target.lessonId,
  QA_WATCH_LIMIT_COURSE_TEXT: target.courseText,
  QA_WATCH_LIMIT_LESSON_TEXT: target.lessonText,
  QA_PDF_ATTACHMENT_ID: target.pdfAttachmentId,
  QA_PDF_ATTACHMENT_TITLE: target.pdfAttachmentTitle || '',
  QA_VIDEO_BROWSER_CAPTURE_MID_STREAM_SCREENSHOTS: 'true',
  QA_VIDEO_BROWSER_SCREENSHOT_SAMPLE: String(screenshotSample),
  QA_STREAM_CERT_TARGETS_FILE: process.env.QA_STREAM_CERT_TARGETS_FILE || '',
  QA_STREAM_CERT_TARGET_KEY: target.key,
});

const runCommand = async (
  label: string,
  args: string[],
  env: Record<string, string>,
) => {
  const logPath = path.join(reportDir, `${label}.log`);
  await ensureDir(path.dirname(logPath));
  const child = spawn(args[0], args.slice(1), {
    cwd: workspaceRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const chunks: string[] = [];
  child.stdout.on('data', (data) => chunks.push(String(data)));
  child.stderr.on('data', (data) => chunks.push(String(data)));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });

  await fs.writeFile(logPath, chunks.join(''), 'utf8');
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}. See ${logPath}`);
  }

  return logPath;
};

const runParallelStage = async (
  label: string,
  left: { args: string[]; env: Record<string, string>; logSuffix: string },
  right: { args: string[]; env: Record<string, string>; logSuffix: string },
) => {
  const runOne = async (entry: typeof left) => {
    const logPath = path.join(reportDir, `${label}-${entry.logSuffix}.log`);
    const child = spawn(entry.args[0], entry.args.slice(1), {
      cwd: workspaceRoot,
      env: entry.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout.on('data', (data) => chunks.push(String(data)));
    child.stderr.on('data', (data) => chunks.push(String(data)));

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });

    await fs.writeFile(logPath, chunks.join(''), 'utf8');
    if (exitCode !== 0) {
      throw new Error(`${label}/${entry.logSuffix} failed with exit code ${exitCode}. See ${logPath}`);
    }
    return logPath;
  };

  const logs = await Promise.all([runOne(left), runOne(right)]);
  return logs;
};

const npmRun = (script: string) => ['npm', '--prefix', 'qa-automation', 'run', script];

const computeSyntheticMix = (totalUsers: number) => {
  const videoUsers = Math.max(1, Math.round(totalUsers * (syntheticVideoPercent / 100)));
  const pdfUsers = Math.max(0, Math.round(totalUsers * (syntheticPdfPercent / 100)));
  const authUsers = Math.max(0, Math.round(totalUsers * (syntheticAuthPercent / 100)));
  let testUsers = Math.max(0, totalUsers - videoUsers - pdfUsers - authUsers);

  if (testUsers < 0) {
    testUsers = 0;
  }

  const backgroundUsers = pdfUsers + authUsers + testUsers;
  const backgroundTotal = Math.max(1, backgroundUsers);
  return {
    totalUsers,
    videoUsers,
    backgroundUsers,
    authUsers,
    pdfUsers,
    testUsers,
    authPercent: (authUsers / backgroundTotal) * 100,
    pdfPercent: (pdfUsers / backgroundTotal) * 100,
    testPercent: (testUsers / backgroundTotal) * 100,
  };
};

const buildBackgroundLoadEnv = (
  target: StreamCertTarget,
  backgroundManifestPath: string,
  mixOrUserCount: number | {
    backgroundUsers: number;
    authPercent: number;
    pdfPercent: number;
    testPercent: number;
  },
) => {
  const mix = typeof mixOrUserCount === 'number'
    ? {
        backgroundUsers: mixOrUserCount,
        authPercent: 40,
        pdfPercent: 40,
        testPercent: 20,
      }
    : mixOrUserCount;

  return ({
  PLATFORM_LOAD_TRAFFIC_MODEL: 'streaming-pdf-mixed',
  PLATFORM_LOAD_USERS: String(mix.backgroundUsers),
  PLATFORM_LOAD_ACTIVE_CONCURRENCY: String(mix.backgroundUsers),
  PLATFORM_LOAD_USERS_FILE: backgroundManifestPath,
  PLATFORM_LOAD_REUSE_EXISTING_USERS: 'true',
  PLATFORM_LOAD_TOP_UP_EXISTING_USERS: 'false',
  PLATFORM_LOAD_REFRESH_EXISTING_TOKENS: 'false',
  PLATFORM_LOAD_LOGOUT_FRACTION: '0',
  PLATFORM_LOAD_BROWSE_READ_PERCENT: '0',
  PLATFORM_LOAD_VIDEO_ACTIVE_PERCENT: '0',
  PLATFORM_LOAD_LIGHT_WRITE_PERCENT: '0',
  PLATFORM_LOAD_AUTH_SESSION_PERCENT: String(mix.authPercent),
  PLATFORM_LOAD_PDF_READ_PERCENT: String(mix.pdfPercent),
  PLATFORM_LOAD_TEST_READ_PERCENT: String(mix.testPercent),
  PLATFORM_LOAD_PDF_ATTACHMENT_ID: target.pdfAttachmentId,
  PLATFORM_LOAD_TEST_ID: target.testId,
  PLATFORM_LOAD_COURSE_ID: target.courseId,
  PLATFORM_LOAD_LESSON_ID: target.lessonId,
  });
};

const prepareManifest = async (
  target: StreamCertTarget,
  cohort: 'browser' | 'background' | 'synthetic-video',
  userCount: number,
) => {
  const existingManifestByCohort = {
    browser: existingBrowserManifestPath,
    background: existingBackgroundManifestPath,
    'synthetic-video': existingSyntheticVideoManifestPath,
  } as const;

  const existingManifest = existingManifestByCohort[cohort];
  if (PROD_SAFE_MODE) {
    if (!existingManifest) {
      throw new Error(`Existing manifest is required for ${cohort} cohort in prod-safe mode.`);
    }
    const manifestPath = resolveManifestPath(existingManifest);
    return { manifestPath, logPath: null as string | null };
  }

  const manifestPath = path.join(reportDir, `${target.key}-${cohort}-users.json`);
  const env = {
    ...buildBaseEnv(target),
    QA_VIDEO_BROWSER_MANIFEST_USERS: String(userCount),
    QA_VIDEO_BROWSER_MANIFEST_PATH: manifestPath,
    QA_VIDEO_BROWSER_USER_PREFIX: `qa.stream.cert.${target.key}.${cohort}.`,
  };
  const logPath = await runCommand(
    `${target.key}-${cohort}-prepare`,
    npmRun('browser:prepare-video-browser-manifest'),
    env,
  );
  return { manifestPath, logPath };
};

const runTargetMatrix = async (target: StreamCertTarget): Promise<StageRecord[]> => {
  const records: StageRecord[] = [];
  const maxBrowserStage = Math.max(...browserStageCounts);
  const maxSyntheticTotalStage = syntheticTotalStageCounts.length > 0 ? Math.max(...syntheticTotalStageCounts) : 0;
  const maxSyntheticMix = computeSyntheticMix(maxSyntheticTotalStage);
  const maxBrowserBackgroundUsers = Math.max(1, Math.round(maxBrowserStage * backgroundRatio));
  const browserManifest = await prepareManifest(target, 'browser', maxBrowserStage);
  const backgroundManifest = await prepareManifest(
    target,
    'background',
    Math.max(maxBrowserBackgroundUsers, maxSyntheticMix.backgroundUsers),
  );
  const syntheticVideoManifest = syntheticTotalStageCounts.length > 0
    ? await prepareManifest(target, 'synthetic-video', maxSyntheticMix.videoUsers)
    : null;
  const browserUsers = await readPreparedUsers(browserManifest.manifestPath);
  const loginEmail = browserUsers[0]?.email || '';
  if (!loginEmail) {
    throw new Error(`No prepared browser user was available for ${target.key}.`);
  }

  const baseEnv = buildBaseEnv(target);

  const runSingleStage = async (
    label: string,
    script: string,
    extraEnv: Record<string, string>,
  ) => {
    const logPath = await runCommand(
      `${target.key}-${label}`,
      npmRun(script),
      {
        ...baseEnv,
        ...extraEnv,
      },
    );
    records.push({ label, kind: 'single', ok: true, logs: [logPath] });
  };

  const runMixedStage = async (stageUsers: number) => {
    const backgroundStageUsers = Math.max(1, Math.round(stageUsers * backgroundRatio));
    const logs = await runParallelStage(
      `${target.key}-mixed-${stageUsers}`,
      {
        args: npmRun('browser:course-video-browser-concurrency'),
        env: {
          ...baseEnv,
          QA_VIDEO_BROWSER_STAGES: String(stageUsers),
          QA_VIDEO_BROWSER_STAGE_CONCURRENCY: String(stageUsers),
          PLATFORM_LOAD_USERS_FILE: browserManifest.manifestPath,
          COURSE_LOAD_USERS_FILE: browserManifest.manifestPath,
        },
        logSuffix: 'browser',
      },
      {
        args: npmRun('load:platform'),
        env: {
          ...baseEnv,
          ...buildBackgroundLoadEnv(target, backgroundManifest.manifestPath, backgroundStageUsers),
        },
        logSuffix: 'background',
      },
    );
    records.push({
      label: `mixed-${stageUsers}-plus-${backgroundStageUsers}`,
      kind: 'parallel',
      ok: true,
      logs,
      details: {
        browserUsers: stageUsers,
        backgroundUsers: backgroundStageUsers,
      },
    });
  };

  const runSyntheticMixedStage = async (totalUsers: number) => {
    if (!syntheticVideoManifest) {
      throw new Error('Synthetic video manifest was not prepared for synthetic mixed stage.');
    }
    const mix = computeSyntheticMix(totalUsers);
    const logs = await runParallelStage(
      `${target.key}-synthetic-${totalUsers}`,
      {
        args: npmRun('load:course-video'),
        env: {
          ...baseEnv,
          COURSE_LOAD_USERS: String(mix.videoUsers),
          COURSE_LOAD_ACTIVE_CONCURRENCY: String(mix.videoUsers),
          COURSE_LOAD_USERS_FILE: syntheticVideoManifest.manifestPath,
          COURSE_LOAD_REPORT_PREFIX: `${target.key}-synthetic-video-${totalUsers}`,
        },
        logSuffix: 'video',
      },
      {
        args: npmRun('load:platform'),
        env: {
          ...baseEnv,
          ...buildBackgroundLoadEnv(target, backgroundManifest.manifestPath, mix),
          PLATFORM_LOAD_REPORT_PREFIX: `${target.key}-synthetic-background-${totalUsers}`,
        },
        logSuffix: 'background',
      },
    );
    records.push({
      label: `synthetic-total-${totalUsers}`,
      kind: 'parallel',
      ok: true,
      logs,
      details: {
        totalUsers: mix.totalUsers,
        videoUsers: mix.videoUsers,
        backgroundUsers: mix.backgroundUsers,
        authUsers: mix.authUsers,
        pdfUsers: mix.pdfUsers,
        testUsers: mix.testUsers,
      },
    });
  };

  await runSingleStage('preflight', 'browser:stream-cert-preflight', {
    QA_STREAM_CERT_PREPARED_USERS_FILE: browserManifest.manifestPath,
  });
  await runSingleStage('pdf-smoke', 'browser:course-pdf-editorial', {
    QA_LOGIN_EMAIL: loginEmail,
    QA_LOGIN_PASSWORD: userPassword,
  });
  await runSingleStage('rootcause-desktop', 'browser:course-playback-rootcause', {
    QA_LOGIN_EMAIL: loginEmail,
    QA_LOGIN_PASSWORD: userPassword,
  });
  await runSingleStage('rootcause-mobile', 'browser:course-playback-rootcause', {
    QA_LOGIN_EMAIL: loginEmail,
    QA_LOGIN_PASSWORD: userPassword,
    QA_MOBILE_MODE: 'true',
  });
  if (!PROD_SAFE_MODE) {
    await runSingleStage('watch-limit', 'browser:course-watch-limit-regression', {});
  }

  for (const stageUsers of browserStageCounts) {
    await runSingleStage(`stream-only-${stageUsers}`, 'browser:course-video-browser-concurrency', {
      QA_VIDEO_BROWSER_STAGES: String(stageUsers),
      QA_VIDEO_BROWSER_STAGE_CONCURRENCY: String(stageUsers),
      PLATFORM_LOAD_USERS_FILE: browserManifest.manifestPath,
      COURSE_LOAD_USERS_FILE: browserManifest.manifestPath,
    });
    await runMixedStage(stageUsers);
  }

  for (const totalUsers of syntheticTotalStageCounts) {
    await runSyntheticMixedStage(totalUsers);
  }

  return records;
};

const main = async () => {
  validateEnvironment();
  await ensureDir(reportDir);
  const allTargets = await loadStreamCertTargets();
  const targets = (() => {
    if (requestedTargetKey) {
      const filtered = allTargets.filter((target) => target.key === requestedTargetKey);
      if (!filtered.length) {
        throw new Error(`QA_STREAM_CERT_TARGET_KEY=${requestedTargetKey} was not found in ${process.env.QA_STREAM_CERT_TARGETS_FILE || 'the target manifest'}.`);
      }
      return filtered;
    }
    if (requestedTargetIndex) {
      const index = Number(requestedTargetIndex);
      if (!Number.isFinite(index) || index < 0 || index >= allTargets.length) {
        throw new Error(`QA_STREAM_CERT_TARGET_INDEX=${requestedTargetIndex} is out of range for ${allTargets.length} targets.`);
      }
      return [allTargets[index]];
    }
    return allTargets;
  })();
  const summary: Record<string, unknown> = {
    ok: true,
    certificationMode: certificationModeSummary(),
    envFile,
    baseUrl,
    browserStageCounts,
    syntheticTotalStageCounts,
    backgroundRatio,
    syntheticMixPercentages: {
      video: syntheticVideoPercent,
      pdf: syntheticPdfPercent,
      auth: syntheticAuthPercent,
      test: syntheticTestPercent,
    },
    requestedTargetKey: requestedTargetKey || null,
    requestedTargetIndex: requestedTargetIndex || null,
    targets: [] as Array<Record<string, unknown>>,
    reportDir,
  };

  for (const target of targets) {
    const records = await runTargetMatrix(target);
    (summary.targets as Array<Record<string, unknown>>).push({
      key: target.key,
      courseId: target.courseId,
      courseText: target.courseText,
      lessonId: target.lessonId,
      lessonText: target.lessonText,
      pdfAttachmentId: target.pdfAttachmentId,
      testId: target.testId,
      records,
    });
  }

  const executedTargetKeys = (summary.targets as Array<Record<string, unknown>>).map((target) => String(target.key || ''));
  const ranFullMatrix = !requestedTargetKey && !requestedTargetIndex && executedTargetKeys.length === allTargets.length;
  const includesRequiredBrowserStages = (PROD_SAFE_MODE ? [1, 3] : [100, 200]).every((requiredStage) => browserStageCounts.includes(requiredStage));
  const includesRequiredSyntheticStages = PROD_SAFE_MODE
    ? syntheticTotalStageCounts.length === 0
    : [1000, 2000].every((requiredStage) => syntheticTotalStageCounts.includes(requiredStage));
  const synthetic2kMix = computeSyntheticMix(2000);
  const includesRequiredSyntheticMix = PROD_SAFE_MODE
    ? true
    : synthetic2kMix.videoUsers >= 1400
      && synthetic2kMix.backgroundUsers >= 600
      && synthetic2kMix.pdfUsers >= 320
      && synthetic2kMix.authUsers >= 80
      && synthetic2kMix.testUsers >= 200;
  summary.readyForProductionDeploy = PROD_SAFE_MODE
    ? false
    : Boolean(summary.ok)
      && ranFullMatrix
      && includesRequiredBrowserStages
      && includesRequiredSyntheticStages
      && includesRequiredSyntheticMix;
  summary.executedTargetKeys = executedTargetKeys;
  summary.expectedTargetKeys = allTargets.map((target) => target.key);
  summary.requiredBrowserStageCounts = PROD_SAFE_MODE ? [1, 3] : [100, 200];
  summary.requiredSyntheticTotalUserStages = PROD_SAFE_MODE ? [] : [1000, 2000];
  summary.requiredSyntheticMix = {
    totalUsers: 2000,
    videoUsers: 1400,
    backgroundUsers: 600,
    pdfUsers: 320,
    authUsers: 80,
    testUsers: 200,
  };
  summary.deployBlockers = [
    ...(ranFullMatrix ? [] : ['full_target_matrix_not_run']),
    ...(includesRequiredBrowserStages ? [] : ['required_browser_stages_100_200_missing']),
    ...(includesRequiredSyntheticStages ? [] : ['required_synthetic_stages_1000_2000_missing']),
    ...(includesRequiredSyntheticMix ? [] : ['synthetic_2k_mixed_shape_not_satisfied']),
    ...(PROD_SAFE_MODE ? ['prod_safe_smoke_only_not_deploy_certification'] : []),
  ];

  await fs.writeFile(path.join(reportDir, 'streaming-pdf-mixed-certification-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  await publishLatestArtifacts(summary);
  console.log(JSON.stringify(summary, null, 2));
};

void main().catch(async (error) => {
  const failureSummary = {
    ok: false,
    readyForProductionDeploy: false,
    envFile,
    baseUrl,
    browserStageCounts,
    syntheticTotalStageCounts,
    backgroundRatio,
    syntheticMixPercentages: {
      video: syntheticVideoPercent,
      pdf: syntheticPdfPercent,
      auth: syntheticAuthPercent,
      test: syntheticTestPercent,
    },
    reportDir,
    error: error instanceof Error ? error.message : String(error),
  };
  await ensureDir(reportDir).catch(() => undefined);
  await fs.writeFile(
    path.join(reportDir, 'streaming-pdf-mixed-certification-summary.json'),
    JSON.stringify(failureSummary, null, 2),
    'utf8',
  ).catch(() => undefined);
  await publishLatestArtifacts(failureSummary).catch(() => undefined);
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
