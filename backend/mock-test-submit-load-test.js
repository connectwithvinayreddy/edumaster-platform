const fs = require('node:fs/promises');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { startServer } = require('./server.cjs');
const { appConfig } = require('./lib/config.js');
const { getHealthSnapshot } = require('./lib/health.js');
const { queryPostgres } = require('./lib/postgres.js');
const { state } = require('./lib/store.js');
const {
  usersRepository,
  coursesRepository,
  testsRepository,
  platformRepository,
} = require('./lib/repositories.js');

const MODE = String(process.env.MOCK_TEST_CERT_MODE || 'certify').trim().toLowerCase();
const TITLE_PREFIX = String(process.env.MOCK_TEST_CERT_TITLE_PREFIX || 'Mock Test 2K Certification').trim();
const USERS = Math.max(1, Number(process.env.MOCK_TEST_LOAD_USERS || 2000));
const SETUP_CONCURRENCY = Math.max(1, Number(process.env.MOCK_TEST_LOAD_SETUP_CONCURRENCY || 75));
const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.MOCK_TEST_LOAD_CONCURRENCY || 250));
const QUESTION_COUNT = Math.max(100, Number(process.env.MOCK_TEST_QUESTION_COUNT || 120));
const DURATION_MINUTES = Math.max(120, Number(process.env.MOCK_TEST_DURATION_MINUTES || 120));
const MARKS_PER_QUESTION = Math.max(1, Number(process.env.MOCK_TEST_MARKS_PER_QUESTION || 3));
const NEGATIVE_MARKING = Math.max(0, Number(process.env.MOCK_TEST_NEGATIVE_MARKING || 1));
const RANK_TIMEOUT_MS = Math.max(5000, Number(process.env.MOCK_TEST_RANK_TIMEOUT_MS || 30000));
const REPORT_PATH = String(process.env.MOCK_TEST_CERT_OUTPUT_PATH || '').trim();
const BROWSER_USER_PASSWORD = String(process.env.MOCK_TEST_BROWSER_PASSWORD || 'Student@123');
const BROWSER_GRID_USERS = Math.max(1, Number(process.env.MOCK_TEST_BROWSER_GRID_USERS || USERS));
const BROWSER_GRID_MANIFEST_PATH = String(process.env.MOCK_TEST_BROWSER_GRID_MANIFEST_PATH || '').trim();
const SELECTED_STAGE_IDS = String(
  process.env.MOCK_TEST_CERT_STAGES
  || 'warmup-100,warmup-250,warmup-500,scale-1000,scale-1500,scale-2000,burst-2000,duplicate-2000,timeout-500',
)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const STAGE_LIBRARY = {
  'warmup-100': { id: 'warmup-100', users: 100, concurrency: 50, scenario: 'all-correct', label: 'Warm-up 100' },
  'warmup-250': { id: 'warmup-250', users: 250, concurrency: 75, scenario: 'mixed-realistic', label: 'Warm-up 250' },
  'warmup-500': { id: 'warmup-500', users: 500, concurrency: 100, scenario: 'mostly-unanswered', label: 'Warm-up 500' },
  'scale-1000': { id: 'scale-1000', users: 1000, concurrency: 150, scenario: 'mixed-realistic', label: 'Scale 1000' },
  'scale-1500': { id: 'scale-1500', users: 1500, concurrency: 200, scenario: 'rank-backlog-burst', label: 'Scale 1500' },
  'scale-2000': { id: 'scale-2000', users: 2000, concurrency: DEFAULT_CONCURRENCY, scenario: 'mixed-realistic', label: 'Scale 2000' },
  'burst-2000': { id: 'burst-2000', users: 2000, concurrency: USERS, scenario: 'last-minute-submit', label: 'Burst 2000' },
  'duplicate-2000': { id: 'duplicate-2000', users: 2000, concurrency: DEFAULT_CONCURRENCY, scenario: 'duplicate-submit-retry', label: 'Duplicate Retry 2000' },
  'timeout-500': { id: 'timeout-500', users: 500, concurrency: 125, scenario: 'timeout-auto-submit', label: 'Timeout 500' },
};

const selectedStages = SELECTED_STAGE_IDS
  .map((stageId) => STAGE_LIBRARY[stageId])
  .filter(Boolean);

const percentile = (values, target) => {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values) => values.length
  ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  : 0;

const nowIso = () => new Date().toISOString();

const authTokenFor = (user) => jwt.sign(
  {
    id: user._id,
    role: user.role,
    session: user.session,
    email: user.email,
    name: user.name,
  },
  appConfig.jwtSecret,
  { expiresIn: '7d' },
);

const request = async (baseUrl, method, requestPath, body = null, token = null) => {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`${method} ${requestPath} failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const runConcurrent = async (items, worker, concurrency) => {
  const queue = [...items];
  const results = [];
  const errors = [];

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) {
        return;
      }

      try {
        results.push(await worker(item));
      } catch (error) {
        errors.push(error);
      }
    }
  });

  await Promise.all(runners);
  return { results, errors };
};

const timed = async (fn) => {
  const startedAt = Date.now();
  const result = await fn();
  return {
    ms: Date.now() - startedAt,
    result,
  };
};

const buildQuestions = () => Array.from({ length: QUESTION_COUNT }, (_, index) => ({
  id: `q_${index + 1}`,
  questionText: `Certification Question ${index + 1}`,
  options: ['A', 'B', 'C', 'D'],
  correctOption: index % 4,
  marks: MARKS_PER_QUESTION,
  topic: ['Maths', 'Reasoning', 'General Awareness', 'English'][index % 4],
  explanation: `Explanation ${index + 1}`,
}));

const buildAnswerPayload = (questions, scenario, userIndex) => {
  const answers = {};

  questions.forEach((question, questionIndex) => {
    const correctOption = Number(question.correctOption || 0);
    const selector = (userIndex + questionIndex) % 10;

    if (scenario === 'all-correct') {
      answers[question.id] = correctOption;
      return;
    }

    if (scenario === 'mostly-unanswered') {
      if (selector <= 7) {
        return;
      }
      answers[question.id] = selector === 8 ? correctOption : (correctOption + 1) % 4;
      return;
    }

    if (scenario === 'rank-backlog-burst') {
      answers[question.id] = selector <= 6 ? correctOption : (correctOption + 2) % 4;
      return;
    }

    if (selector <= 4) {
      answers[question.id] = correctOption;
    } else if (selector <= 7) {
      answers[question.id] = (correctOption + 1) % 4;
    }
  });

  return answers;
};

const buildStartedAt = (scenario) => {
  const now = Date.now();
  if (scenario === 'last-minute-submit') {
    return new Date(now - ((DURATION_MINUTES - 1) * 60 * 1000)).toISOString();
  }
  if (scenario === 'timeout-auto-submit') {
    return new Date(now - (DURATION_MINUTES * 60 * 1000)).toISOString();
  }
  return new Date(now - Math.min(55, DURATION_MINUTES - 1) * 60 * 1000).toISOString();
};

const sanitizeError = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  status: Number(error?.status || 0) || null,
  payload: error?.payload || null,
});

const getAttemptStats = async (testId) => {
  if (appConfig.postgresUrl) {
    const result = await queryPostgres(
      `
        SELECT
          COUNT(*)::int AS total_attempts,
          COUNT(DISTINCT user_id)::int AS distinct_users,
          COALESCE(SUM(CASE WHEN rank_status = 'pending' THEN 1 ELSE 0 END), 0)::int AS pending_attempts,
          COALESCE(SUM(CASE WHEN rank_status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_attempts
        FROM test_attempts
        WHERE test_id = $1
      `,
      [String(testId)],
    );
    const row = result.rows[0] || {};
    return {
      totalAttempts: Number(row.total_attempts || 0),
      distinctUsers: Number(row.distinct_users || 0),
      duplicateAttempts: Math.max(0, Number(row.total_attempts || 0) - Number(row.distinct_users || 0)),
      pendingAttempts: Number(row.pending_attempts || 0),
      failedAttempts: Number(row.failed_attempts || 0),
    };
  }

  const attempts = state.testAttempts.filter((attempt) => String(attempt.testId) === String(testId));
  const distinctUsers = new Set(attempts.map((attempt) => String(attempt.userId))).size;
  return {
    totalAttempts: attempts.length,
    distinctUsers,
    duplicateAttempts: Math.max(0, attempts.length - distinctUsers),
    pendingAttempts: attempts.filter((attempt) => attempt.rankStatus === 'pending').length,
    failedAttempts: attempts.filter((attempt) => attempt.rankStatus === 'failed').length,
  };
};

const waitForRankConvergence = async (testId) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < RANK_TIMEOUT_MS) {
    const [attemptStats, health] = await Promise.all([
      getAttemptStats(testId),
      getHealthSnapshot(),
    ]);

    if (attemptStats.pendingAttempts === 0) {
      return {
        converged: true,
        convergenceMs: Date.now() - startedAt,
        attemptStats,
        worker: health.workers?.mockTestRanking || null,
        degradedRedis: health.dependencies?.redis?.status !== 'up',
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const [attemptStats, health] = await Promise.all([
    getAttemptStats(testId),
    getHealthSnapshot(),
  ]);

  return {
    converged: false,
    convergenceMs: Date.now() - startedAt,
    attemptStats,
    worker: health.workers?.mockTestRanking || null,
    degradedRedis: health.dependencies?.redis?.status !== 'up',
  };
};

const classifyStage = ({ failedSubmissions, duplicateAttempts, rankConverged, degradedRedis, sampleErrors, stage }) => {
  if (duplicateAttempts > 0) {
    return 'submit-path idempotency bug';
  }
  if (sampleErrors.some((entry) => entry.status === 403 || entry.status === 404)) {
    return 'seed-data issue';
  }
  if (sampleErrors.some((entry) => entry.status === 429)) {
    return 'database contention / query-shape issue';
  }
  if (sampleErrors.some((entry) => (entry.status || 0) >= 500)) {
    return 'submit-path idempotency bug';
  }
  if (!rankConverged || degradedRedis) {
    return 'ranking worker / Redis bug';
  }
  if (failedSubmissions > 0 && stage.scenario === 'timeout-auto-submit') {
    return 'timer / UI flow bug';
  }
  if (failedSubmissions > 0) {
    return 'harness issue';
  }
  return 'pass';
};

const buildStageReport = async ({ baseUrl, stage, courseId, stageIndex }) => {
  const test = await testsRepository.create({
    title: `${TITLE_PREFIX} ${stage.label}`,
    description: `${stage.label} synthetic certification mock`,
    category: 'SSC JE',
    exam: 'SSC JE',
    type: 'full-length',
    durationMinutes: DURATION_MINUTES,
    negativeMarking: NEGATIVE_MARKING,
    course: courseId,
    questions: buildQuestions(),
    totalMarks: QUESTION_COUNT * MARKS_PER_QUESTION,
    sectionBreakup: [{ name: 'PART-A', questions: QUESTION_COUNT }],
    createdBy: 'mock-test-certification',
  });

  const userIndexes = Array.from({ length: stage.users }, (_, index) => index);
  const timestampSeed = Date.now() + stageIndex;
  const setup = await runConcurrent(userIndexes, async (index) => {
    const user = await usersRepository.create({
      name: `Mock Cert ${stage.id} User ${index + 1}`,
      email: `mock_cert_${stage.id}_${timestampSeed}_${index}@edumaster.local`,
      password: BROWSER_USER_PASSWORD,
      role: 'student',
      device: `mock-cert-${stage.id}-${index + 1}`,
    });

    await platformRepository.enroll({
      userId: user._id,
      courseId,
      source: 'mock-test-certification',
      accessType: 'course',
    });

    return {
      userId: user._id,
      token: authTokenFor(user),
      userIndex: index,
    };
  }, SETUP_CONCURRENCY);

  if (setup.errors.length > 0) {
    throw setup.errors[0];
  }

  const healthBefore = await getHealthSnapshot();
  const startedAt = buildStartedAt(stage.scenario);
  const duplicateRetryUsers = new Set(
    stage.scenario === 'duplicate-submit-retry'
      ? setup.results.filter((entry) => entry.userIndex % 5 === 0).map((entry) => entry.userId)
      : [],
  );

  const submissions = await runConcurrent(setup.results, async (entry) => {
    const answers = buildAnswerPayload(test.questions || [], stage.scenario, entry.userIndex);
    const body = { answers, startedAt };

    if (duplicateRetryUsers.has(entry.userId)) {
      const started = Date.now();
      const [firstAttempt, secondAttempt] = await Promise.all([
        request(baseUrl, 'POST', `/tests/${test._id}/submit`, body, entry.token),
        request(baseUrl, 'POST', `/tests/${test._id}/submit`, body, entry.token),
      ]);
      return {
        ms: Date.now() - started,
        duplicateRetry: true,
        attemptId: firstAttempt?._id || secondAttempt?._id || null,
      };
    }

    const { ms, result } = await timed(() => request(
      baseUrl,
      'POST',
      `/tests/${test._id}/submit`,
      body,
      entry.token,
    ));

    return {
      ms,
      duplicateRetry: false,
      attemptId: result?._id || null,
    };
  }, stage.concurrency);

  const latencies = submissions.results.map((entry) => entry.ms);
  const attemptStats = await getAttemptStats(test._id);
  const convergence = await waitForRankConvergence(test._id);
  const healthAfter = await getHealthSnapshot();
  const sampleErrors = submissions.errors.slice(0, 5).map(sanitizeError);
  const classification = classifyStage({
    failedSubmissions: submissions.errors.length,
    duplicateAttempts: attemptStats.duplicateAttempts,
    rankConverged: convergence.converged,
    degradedRedis: convergence.degradedRedis,
    sampleErrors,
    stage,
  });

  return {
    id: stage.id,
    label: stage.label,
    scenario: stage.scenario,
    users: stage.users,
    concurrency: stage.concurrency,
    successfulSubmissions: submissions.results.length,
    failedSubmissions: submissions.errors.length,
    latencyMs: {
      avg: average(latencies),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    duplicateRetryRequests: submissions.results.filter((entry) => entry.duplicateRetry).length,
    duplicateAttempts: attemptStats.duplicateAttempts,
    pendingAttempts: convergence.attemptStats.pendingAttempts,
    failedAttempts: convergence.attemptStats.failedAttempts,
    rankConverged: convergence.converged,
    rankConvergenceMs: convergence.convergenceMs,
    degradedRedis: convergence.degradedRedis,
    healthBefore: {
      redis: healthBefore.dependencies?.redis?.status || 'unknown',
      postgres: healthBefore.dependencies?.postgres?.status || 'unknown',
      worker: healthBefore.workers?.mockTestRanking || null,
    },
    healthAfter: {
      redis: healthAfter.dependencies?.redis?.status || 'unknown',
      postgres: healthAfter.dependencies?.postgres?.status || 'unknown',
      worker: healthAfter.workers?.mockTestRanking || null,
    },
    sampleErrors,
    classification,
    test: {
      id: test._id,
      title: test.title,
    },
  };
};

const createBrowserProofUser = async (courseId, timestampSeed, suffix) => {
  const proofUser = await usersRepository.create({
    name: `Mock Cert ${suffix} Student`,
    email: `mock_cert_browser_${suffix}_${timestampSeed}@edumaster.local`,
    password: BROWSER_USER_PASSWORD,
    role: 'student',
    device: `mock-cert-browser-${suffix}`,
  });

  await platformRepository.enroll({
    userId: proofUser._id,
    courseId,
    source: 'mock-test-certification',
    accessType: 'course',
  });

  return proofUser;
};

const seedBrowserProof = async (courseId) => {
  const timestampSeed = Date.now();
  const [manualUser, pauseUser, timeoutUser] = await Promise.all([
    createBrowserProofUser(courseId, timestampSeed, 'manual'),
    createBrowserProofUser(courseId, timestampSeed, 'pause'),
    createBrowserProofUser(courseId, timestampSeed, 'timeout'),
  ]);

  const proofTest = await testsRepository.create({
    title: `${TITLE_PREFIX} Browser Proof`,
    description: 'Synthetic browser-proof certification mock',
    category: 'SSC JE',
    exam: 'SSC JE',
    type: 'full-length',
    durationMinutes: DURATION_MINUTES,
    negativeMarking: NEGATIVE_MARKING,
    course: courseId,
    questions: buildQuestions(),
    totalMarks: QUESTION_COUNT * MARKS_PER_QUESTION,
    sectionBreakup: [{ name: 'PART-A', questions: QUESTION_COUNT }],
    createdBy: 'mock-test-certification',
  });

  return {
    testId: proofTest._id,
    title: proofTest.title,
    manualStudentEmail: manualUser.email,
    pauseStudentEmail: pauseUser.email,
    timeoutStudentEmail: timeoutUser.email,
    studentPassword: BROWSER_USER_PASSWORD,
  };
};

const writeReport = async (report) => {
  if (!REPORT_PATH) {
    return;
  }

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
};

const writeBrowserGridManifest = async (manifest) => {
  if (!BROWSER_GRID_MANIFEST_PATH) {
    return null;
  }

  await fs.mkdir(path.dirname(BROWSER_GRID_MANIFEST_PATH), { recursive: true });
  await fs.writeFile(BROWSER_GRID_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  return BROWSER_GRID_MANIFEST_PATH;
};

const seedBrowserGrid = async (courseId) => {
  const timestampSeed = Date.now();
  const gridTest = await testsRepository.create({
    title: `${TITLE_PREFIX} Browser Grid`,
    description: 'Synthetic distributed browser certification mock',
    category: 'SSC JE',
    exam: 'SSC JE',
    type: 'full-length',
    durationMinutes: DURATION_MINUTES,
    negativeMarking: NEGATIVE_MARKING,
    course: courseId,
    questions: buildQuestions(),
    totalMarks: QUESTION_COUNT * MARKS_PER_QUESTION,
    sectionBreakup: [{ name: 'PART-A', questions: QUESTION_COUNT }],
    createdBy: 'mock-test-certification',
  });

  const userIndexes = Array.from({ length: BROWSER_GRID_USERS }, (_, index) => index);
  const setup = await runConcurrent(userIndexes, async (index) => {
    const user = await usersRepository.create({
      name: `Mock Grid User ${index + 1}`,
      email: `mock_cert_browser_grid_${timestampSeed}_${index}@edumaster.local`,
      password: BROWSER_USER_PASSWORD,
      role: 'student',
      device: `mock-cert-grid-${index + 1}`,
    });

    await platformRepository.enroll({
      userId: user._id,
      courseId,
      source: 'mock-test-browser-grid-certification',
      accessType: 'course',
    });

    return {
      index,
      email: user.email,
      userId: user._id,
      name: user.name,
      cohort: 'main-grid',
      scenario: 'mixed-realistic',
      viewport: index % 10 === 0 ? 'mobile' : 'desktop',
    };
  }, SETUP_CONCURRENCY);

  if (setup.errors.length > 0) {
    throw setup.errors[0];
  }

  const manifest = {
    generatedAt: nowIso(),
    profile: {
      questions: QUESTION_COUNT,
      durationMinutes: DURATION_MINUTES,
      marksPerQuestion: MARKS_PER_QUESTION,
      negativeMarking: NEGATIVE_MARKING,
      titlePrefix: TITLE_PREFIX,
    },
    course: {
      id: courseId,
    },
    test: {
      id: gridTest._id,
      title: gridTest.title,
    },
    auth: {
      password: BROWSER_USER_PASSWORD,
    },
    users: setup.results,
  };

  const manifestPath = await writeBrowserGridManifest(manifest);

  return {
    testId: gridTest._id,
    title: gridTest.title,
    totalUsers: setup.results.length,
    manifestPath,
    sampleUserEmails: setup.results.slice(0, 5).map((entry) => entry.email),
  };
};

const main = async () => {
  const { server } = await startServer({ port: 0, host: '127.0.0.1' });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : appConfig.port;
  const baseUrl = `http://127.0.0.1:${port}/backend/api`;

  try {
    const course = await coursesRepository.create({
      title: `${TITLE_PREFIX} Course ${Date.now()}`,
      description: 'Synthetic course for mock-test certification',
      category: 'SSC JE',
      exam: 'SSC JE',
      subject: 'Mock Test Certification',
      level: 'Full Course',
      price: 0,
      validityDays: 365,
      instructor: 'Load Bot',
      modules: [],
      createdBy: 'mock-test-certification',
    });

    const browserProof = await seedBrowserProof(course._id);
    const browserGrid = await seedBrowserGrid(course._id);
    const stages = [];

    if (MODE !== 'seed-only') {
      for (const [stageIndex, stage] of selectedStages.entries()) {
        stages.push(await buildStageReport({
          baseUrl,
          stage: {
            ...stage,
            users: Math.min(stage.users, USERS),
          },
          courseId: course._id,
          stageIndex,
        }));
      }
    }

    const health = await getHealthSnapshot();
    const degraded = health.dependencies?.redis?.status !== 'up';
    const hasFailures = stages.some((stage) => stage.failedSubmissions > 0 || stage.duplicateAttempts > 0 || !stage.rankConverged);
    const report = {
      generatedAt: nowIso(),
      mode: MODE,
      profile: {
        questions: QUESTION_COUNT,
        durationMinutes: DURATION_MINUTES,
        marksPerQuestion: MARKS_PER_QUESTION,
        negativeMarking: NEGATIVE_MARKING,
      },
      environment: {
        redisStatus: health.dependencies?.redis?.status || 'unknown',
        postgresStatus: health.dependencies?.postgres?.status || 'unknown',
        worker: health.workers?.mockTestRanking || null,
      },
      browserProof,
      browserGrid,
      course: {
        id: course._id,
        title: course.title,
      },
      stages,
      certification: {
        certified: MODE === 'seed-only' ? false : !degraded && !hasFailures,
        degraded,
        classification: degraded ? 'ranking worker / Redis bug' : hasFailures ? 'regression outside mock-test scope' : 'pass',
      },
    };

    await writeReport(report);
    console.log(JSON.stringify(report, null, 2));

    if (degraded || hasFailures) {
      process.exitCode = 1;
    }
  } finally {
    server.close();
  }
};

main()
  .then(() => {
    // This harness starts app infrastructure that can leave background handles open.
    // Force the CLI process to terminate after reports are flushed.
    setImmediate(() => process.exit(process.exitCode || 0));
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
