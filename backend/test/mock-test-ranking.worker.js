const { appConfig } = require('../lib/config.js');
const { queryPostgres } = require('../lib/postgres.js');
const {
  addRedisSetMember,
  removeRedisSetMember,
  getRedisSetMembers,
  setRedisValue,
  deleteRedisKey,
  setRedisJson,
  subscribeRedisChannel,
} = require('../lib/redis.js');
const { state } = require('../lib/store.js');
const { rankMockTestAttempts } = require('./mock-test-attempts.js');

const CACHE_PREFIX = String(appConfig.cachePrefix || 'varonenglish').replace(/[:\s]+/g, '-');
const cacheKey = (name, suffix) => `${CACHE_PREFIX}:${name}:${suffix}`;
const MOCK_TEST_RANK_CHANNEL = cacheKey('test-rank-jobs', 'channel');
const MOCK_TEST_RANK_PENDING_SET_KEY = cacheKey('test-rank-jobs', 'pending');
const MOCK_TEST_RANK_LOCK_TTL_SECONDS = Math.max(15, Number(process.env.MOCK_TEST_RANK_LOCK_TTL_SECONDS || 120));
const MOCK_TEST_RANK_CONCURRENCY = Math.max(1, Number(process.env.MOCK_TEST_RANK_CONCURRENCY || 1));
const MOCK_TEST_LEADERBOARD_TTL_SECONDS = Math.max(30, Number(process.env.MOCK_TEST_LEADERBOARD_TTL_SECONDS || 120));
const MOCK_TEST_RANK_DEBOUNCE_MS = Math.max(0, Number(process.env.MOCK_TEST_RANK_DEBOUNCE_MS || 750));

let subscriber = null;
let started = false;
const localQueuedTestIds = new Set();
const localActiveTestIds = new Set();
const localRerunRequestedTestIds = new Set();
const localDebounceTimers = new Map();
const localQueue = [];
const metrics = {
  pendingJobs: 0,
  activeJobs: 0,
  completedJobs: 0,
  failedJobs: 0,
  coalescedJobs: 0,
  degradedLocalOnly: !appConfig.redisUrl,
  lastJobCompletedAt: null,
  lastQueuedAt: null,
  lastError: null,
  subscriberStatus: appConfig.redisUrl ? 'idle' : 'disabled',
};

const nowIso = () => new Date().toISOString();
const isRedisEnabled = () => Boolean(appConfig.redisUrl);
const getJobLockKey = (testId) => cacheKey('test-rank-lock', String(testId));
const getLeaderboardCacheKey = (testId) => cacheKey('test-leaderboard', String(testId));
const getDebounceKey = (testId) => cacheKey('test-rank-debounce', String(testId));

const logRankEvent = (level, event, details = {}) => {
  const payload = {
    scope: 'mock-test-ranking',
    event,
    at: nowIso(),
    ...details,
  };
  const line = `[mock-test-ranking] ${JSON.stringify(payload)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const asArray = (value) => (Array.isArray(value) ? cloneJson(value) : []);
const asObject = (value) => (value && typeof value === 'object' ? cloneJson(value) : {});
const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const mapTestAttemptRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  testId: row.test_id,
  score: toNumber(row.score),
  totalMarks: toNumber(row.total_marks),
  correctCount: Number(row.correct_count || 0),
  incorrectCount: Number(row.incorrect_count || 0),
  unattemptedCount: Number(row.unattempted_count || 0),
  percentile: row.percentile === null || row.percentile === undefined ? null : toNumber(row.percentile),
  rank: row.all_india_rank === null || row.all_india_rank === undefined ? null : Number(row.all_india_rank || 0),
  rankStatus: row.rank_status || 'pending',
  rankComputedAt: row.rank_computed_at ? new Date(row.rank_computed_at).toISOString() : null,
  answers: asObject(row.answers),
  weakTopics: asArray(row.weak_topics),
  strongTopics: asArray(row.strong_topics),
  solutions: asArray(row.solutions),
  startedAt: row.started_at ? new Date(row.started_at).toISOString() : nowIso(),
  completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : nowIso(),
});

const setPendingMetricCount = () => {
  metrics.pendingJobs = localQueue.length;
  metrics.activeJobs = localActiveTestIds.size;
};

const updateCachedLeaderboard = async (testId, attempts) => {
  const leaderboard = {
    testId: String(testId),
    attempts: attempts.slice(0, 100),
    updatedAt: nowIso(),
  };
  await setRedisJson(getLeaderboardCacheKey(testId), leaderboard, {
    ttlSeconds: MOCK_TEST_LEADERBOARD_TTL_SECONDS,
  });
};

const markTestRanksFailed = async (testId, error) => {
  if (appConfig.postgresUrl) {
    await queryPostgres(
      `
        UPDATE test_attempts
        SET rank_status = 'failed'
        WHERE test_id = $1 AND rank_status = 'pending'
      `,
      [String(testId)],
    );
  } else {
    state.testAttempts.forEach((attempt) => {
      if (attempt.testId === String(testId) && attempt.rankStatus === 'pending') {
        attempt.rankStatus = 'failed';
      }
    });
  }

  metrics.failedJobs += 1;
  metrics.lastError = error instanceof Error ? error.message : String(error);
};

const recomputeMockTestRanksForTest = async (testId) => {
  if (appConfig.postgresUrl) {
    const result = await queryPostgres(
      `
        WITH ranked AS (
          SELECT
            id,
            ROW_NUMBER() OVER (
              ORDER BY score DESC, completed_at ASC, id ASC
            ) AS next_rank,
            COUNT(*) OVER () AS total_attempts
          FROM test_attempts
          WHERE test_id = $1
        ),
        updated AS (
          UPDATE test_attempts AS attempts
          SET
            all_india_rank = ranked.next_rank,
            percentile = CASE
              WHEN ranked.total_attempts <= 1 THEN 100
              ELSE ROUND((((ranked.total_attempts - ranked.next_rank)::numeric / ranked.total_attempts::numeric) * 100), 2)
            END,
            rank_status = 'ready',
            rank_computed_at = now()
          FROM ranked
          WHERE attempts.id = ranked.id
          RETURNING attempts.*
        )
        SELECT * FROM updated
        ORDER BY all_india_rank ASC, completed_at ASC, id ASC
      `,
      [String(testId)],
    );

    const attempts = result.rows.map(mapTestAttemptRow);
    await updateCachedLeaderboard(testId, attempts);
    return {
      attempts,
      source: 'postgres',
    };
  }

  const nextAttempts = rankMockTestAttempts(
    state.testAttempts.filter((attempt) => attempt.testId === String(testId)),
  );
  const rankedById = new Map(nextAttempts.map((attempt) => [String(attempt._id), attempt]));
  state.testAttempts = state.testAttempts.map((attempt) => rankedById.get(String(attempt._id)) || attempt);
  await updateCachedLeaderboard(testId, nextAttempts);
  return {
    attempts: nextAttempts,
    source: 'memory',
  };
};

const enqueueLocal = (testId) => {
  const normalizedTestId = String(testId || '').trim();
  if (!normalizedTestId) {
    return false;
  }

  if (localActiveTestIds.has(normalizedTestId)) {
    localRerunRequestedTestIds.add(normalizedTestId);
    return false;
  }

  if (localQueuedTestIds.has(normalizedTestId)) {
    return false;
  }

  localQueuedTestIds.add(normalizedTestId);
  localQueue.push(normalizedTestId);
  setPendingMetricCount();
  return true;
};

const clearLocalDebounceTimer = (testId) => {
  const timer = localDebounceTimers.get(String(testId));
  if (timer) {
    clearTimeout(timer);
    localDebounceTimers.delete(String(testId));
  }
};

const runRankJob = async (testId) => {
  const normalizedTestId = String(testId);
  let lockAcquired = false;

  try {
    if (isRedisEnabled()) {
      await removeRedisSetMember(MOCK_TEST_RANK_PENDING_SET_KEY, normalizedTestId).catch(() => undefined);
      lockAcquired = await setRedisValue(getJobLockKey(normalizedTestId), nowIso(), {
        ttlSeconds: MOCK_TEST_RANK_LOCK_TTL_SECONDS,
        onlyIfMissing: true,
      }).catch(() => false);

      if (!lockAcquired) {
        logRankEvent('info', 'rank-job-deduped', { testId: normalizedTestId });
        return;
      }
    }

    const { attempts, source } = await recomputeMockTestRanksForTest(normalizedTestId);
    metrics.completedJobs += 1;
    metrics.lastJobCompletedAt = nowIso();
    metrics.lastError = null;
    logRankEvent('info', 'rank-job-completed', {
      testId: normalizedTestId,
      attemptCount: attempts.length,
      source,
    });
  } catch (error) {
    await markTestRanksFailed(normalizedTestId, error).catch(() => undefined);
    logRankEvent('error', 'rank-job-failed', {
      testId: normalizedTestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (lockAcquired) {
      await deleteRedisKey(getJobLockKey(normalizedTestId)).catch(() => undefined);
    }

    if (localRerunRequestedTestIds.has(normalizedTestId)) {
      localRerunRequestedTestIds.delete(normalizedTestId);
      enqueueLocal(normalizedTestId);
    }
  }
};

const pumpLocalQueue = () => {
  while (localActiveTestIds.size < MOCK_TEST_RANK_CONCURRENCY && localQueue.length > 0) {
    const testId = localQueue.shift();
    if (!testId) {
      continue;
    }

    localQueuedTestIds.delete(testId);
    if (localActiveTestIds.has(testId)) {
      continue;
    }

    localActiveTestIds.add(testId);
    setPendingMetricCount();
    void runRankJob(testId).finally(() => {
      localActiveTestIds.delete(testId);
      setPendingMetricCount();
      pumpLocalQueue();
    });
  }
};

const scheduleMockTestRankRecompute = async ({ testId, reason = 'submit' }) => {
  const normalizedTestId = String(testId || '').trim();
  if (!normalizedTestId) {
    return { queued: false, degraded: !isRedisEnabled() };
  }

  if (isRedisEnabled()) {
    await addRedisSetMember(MOCK_TEST_RANK_PENDING_SET_KEY, normalizedTestId).catch(() => undefined);
  }

  let queuedLocally = false;
  let coalesced = false;

  if (!isRedisEnabled() || !started) {
    if (localActiveTestIds.has(normalizedTestId) || localQueuedTestIds.has(normalizedTestId)) {
      localRerunRequestedTestIds.add(normalizedTestId);
      coalesced = true;
    } else if (MOCK_TEST_RANK_DEBOUNCE_MS > 0) {
      const existingTimer = localDebounceTimers.get(normalizedTestId);
      if (existingTimer) {
        coalesced = true;
      } else {
        const timer = setTimeout(() => {
          localDebounceTimers.delete(normalizedTestId);
          if (enqueueLocal(normalizedTestId)) {
            pumpLocalQueue();
          }
        }, MOCK_TEST_RANK_DEBOUNCE_MS);
        localDebounceTimers.set(normalizedTestId, timer);
        queuedLocally = true;
      }
    } else {
      queuedLocally = enqueueLocal(normalizedTestId);
      if (!queuedLocally) {
        coalesced = true;
      }
    }
  }

  let queuedViaRedis = false;
  if (isRedisEnabled()) {
    if (MOCK_TEST_RANK_DEBOUNCE_MS > 0) {
      queuedViaRedis = await setRedisValue(getDebounceKey(normalizedTestId), nowIso(), {
        ttlSeconds: Math.max(1, Math.ceil(MOCK_TEST_RANK_DEBOUNCE_MS / 1000)),
        onlyIfMissing: true,
      }).catch(() => true);
      if (!queuedViaRedis) {
        coalesced = true;
      }
    } else {
      queuedViaRedis = true;
    }
  }

  if (queuedLocally && MOCK_TEST_RANK_DEBOUNCE_MS === 0) {
    pumpLocalQueue();
  }
  const queued = Boolean(queuedViaRedis || queuedLocally);

  if (isRedisEnabled()) {
    await setRedisValue(cacheKey('test-rank-last-scheduled', normalizedTestId), nowIso(), {
      ttlSeconds: MOCK_TEST_RANK_LOCK_TTL_SECONDS,
    }).catch(() => undefined);
  }

  if (queued) {
    metrics.lastQueuedAt = nowIso();
  }
  if (coalesced) {
    metrics.coalescedJobs += 1;
  }

  logRankEvent('info', queued ? 'rank-job-queued' : coalesced ? 'rank-job-coalesced' : 'rank-job-deduped', {
    testId: normalizedTestId,
    reason,
    debounceMs: MOCK_TEST_RANK_DEBOUNCE_MS,
    degraded: !isRedisEnabled(),
  });

  return {
    queued,
    coalesced,
    degraded: !isRedisEnabled(),
  };
};

const recoverPendingMockTestRankJobs = async () => {
  const scheduledTestIds = new Set();

  if (appConfig.postgresUrl) {
    const result = await queryPostgres(
      `
        SELECT DISTINCT test_id
        FROM test_attempts
        WHERE rank_status = 'pending'
      `,
    );
    result.rows.forEach((row) => {
      if (row?.test_id) {
        scheduledTestIds.add(String(row.test_id));
      }
    });
  } else {
    state.testAttempts.forEach((attempt) => {
      if (attempt.rankStatus === 'pending' && attempt.testId) {
        scheduledTestIds.add(String(attempt.testId));
      }
    });
  }

  if (isRedisEnabled()) {
    const pendingMembers = await getRedisSetMembers(MOCK_TEST_RANK_PENDING_SET_KEY).catch(() => []);
    pendingMembers.forEach((testId) => scheduledTestIds.add(String(testId)));
  }

  let scheduled = 0;
  for (const testId of scheduledTestIds) {
    const result = await scheduleMockTestRankRecompute({ testId, reason: 'startup-recovery' });
    if (isRedisEnabled()) {
      await notifyMockTestRankWorkers({ testId }).catch(() => undefined);
    }
    if (result.queued) {
      scheduled += 1;
    }
  }

  return {
    scanned: scheduledTestIds.size,
    scheduled,
  };
};

const startMockTestRankingWorker = () => {
  if (started) {
    return;
  }

  started = true;
  if (isRedisEnabled()) {
    subscriber = subscribeRedisChannel({
      channel: MOCK_TEST_RANK_CHANNEL,
      onStatus: (status) => {
        metrics.subscriberStatus = status;
      },
      onError: (error) => {
        metrics.lastError = error instanceof Error ? error.message : String(error);
      },
      onMessage: (message) => {
        enqueueLocal(message);
        pumpLocalQueue();
      },
    });
  }
};

const notifyMockTestRankWorkers = async ({ testId }) => {
  if (!isRedisEnabled()) {
    return;
  }

  await setRedisValue(cacheKey('test-rank-notify', String(testId)), nowIso(), {
    ttlSeconds: MOCK_TEST_RANK_LOCK_TTL_SECONDS,
  }).catch(() => undefined);

  const { publishRedisMessage } = require('../lib/redis.js');
  await publishRedisMessage(MOCK_TEST_RANK_CHANNEL, String(testId)).catch(() => undefined);
};

const queueMockTestRankRecompute = async ({ testId, reason = 'submit' }) => {
  const result = await scheduleMockTestRankRecompute({ testId, reason });
  if (result.queued) {
    await notifyMockTestRankWorkers({ testId }).catch(() => undefined);
  }
  return result;
};

const getMockTestRankingWorkerSnapshot = () => ({
  enabled: true,
  redisBacked: isRedisEnabled(),
  pendingJobs: metrics.pendingJobs,
  activeJobs: metrics.activeJobs,
  completedJobs: metrics.completedJobs,
  failedJobs: metrics.failedJobs,
  coalescedJobs: metrics.coalescedJobs,
  debounceMs: MOCK_TEST_RANK_DEBOUNCE_MS,
  degradedLocalOnly: metrics.degradedLocalOnly,
  lastJobCompletedAt: metrics.lastJobCompletedAt,
  lastQueuedAt: metrics.lastQueuedAt,
  lastError: metrics.lastError,
  subscriberStatus: metrics.subscriberStatus,
});

module.exports = {
  queueMockTestRankRecompute,
  recomputeMockTestRanksForTest,
  startMockTestRankingWorker,
  recoverPendingMockTestRankJobs,
  getMockTestRankingWorkerSnapshot,
};
