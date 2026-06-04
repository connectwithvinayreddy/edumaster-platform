const test = require('node:test');
const assert = require('node:assert/strict');

const { appConfig } = require('../lib/config.js');
const { state, resetState } = require('../lib/store.js');
const { getRedisJson } = require('../lib/redis.js');
const {
  recomputeMockTestRanksForTest,
} = require('../test/mock-test-ranking.worker.js');

const CACHE_PREFIX = String(appConfig.cachePrefix || 'varonenglish').replace(/[:\s]+/g, '-');
const leaderboardCacheKey = (testId) => `${CACHE_PREFIX}:test-leaderboard:${String(testId)}`;

test.afterEach(() => {
  resetState({});
});

test('recomputeMockTestRanksForTest ranks attempts per test and refreshes leaderboard cache', async () => {
  resetState({
    testAttempts: [
      {
        _id: 'attempt_a',
        userId: 'user_1',
        testId: 'test_alpha',
        score: 90,
        totalMarks: 100,
        correctCount: 45,
        incorrectCount: 5,
        unattemptedCount: 0,
        percentile: null,
        rank: null,
        rankStatus: 'pending',
        answers: {},
        weakTopics: [],
        strongTopics: [],
        solutions: [],
        startedAt: '2026-06-04T10:00:00.000Z',
        completedAt: '2026-06-04T10:30:00.000Z',
      },
      {
        _id: 'attempt_b',
        userId: 'user_2',
        testId: 'test_alpha',
        score: 90,
        totalMarks: 100,
        correctCount: 45,
        incorrectCount: 5,
        unattemptedCount: 0,
        percentile: null,
        rank: null,
        rankStatus: 'pending',
        answers: {},
        weakTopics: [],
        strongTopics: [],
        solutions: [],
        startedAt: '2026-06-04T10:01:00.000Z',
        completedAt: '2026-06-04T10:31:00.000Z',
      },
      {
        _id: 'attempt_c',
        userId: 'user_3',
        testId: 'test_alpha',
        score: 70,
        totalMarks: 100,
        correctCount: 35,
        incorrectCount: 10,
        unattemptedCount: 5,
        percentile: null,
        rank: null,
        rankStatus: 'pending',
        answers: {},
        weakTopics: [],
        strongTopics: [],
        solutions: [],
        startedAt: '2026-06-04T10:02:00.000Z',
        completedAt: '2026-06-04T10:32:00.000Z',
      },
      {
        _id: 'attempt_other',
        userId: 'user_4',
        testId: 'test_beta',
        score: 99,
        totalMarks: 100,
        correctCount: 49,
        incorrectCount: 1,
        unattemptedCount: 0,
        percentile: null,
        rank: null,
        rankStatus: 'pending',
        answers: {},
        weakTopics: [],
        strongTopics: [],
        solutions: [],
        startedAt: '2026-06-04T10:03:00.000Z',
        completedAt: '2026-06-04T10:33:00.000Z',
      },
    ],
  });

  const result = await recomputeMockTestRanksForTest('test_alpha');
  const rankedAlpha = result.attempts;

  assert.equal(rankedAlpha.length, 3);
  assert.equal(rankedAlpha[0]._id, 'attempt_a');
  assert.equal(rankedAlpha[0].rank, 1);
  assert.equal(rankedAlpha[0].percentile, 66.67);
  assert.equal(rankedAlpha[1]._id, 'attempt_b');
  assert.equal(rankedAlpha[1].rank, 2);
  assert.equal(rankedAlpha[1].rankStatus, 'ready');
  assert.equal(rankedAlpha[2].rank, 3);
  assert.equal(
    state.testAttempts.find((attempt) => attempt._id === 'attempt_other')?.rankStatus,
    'pending',
  );

  const cachedLeaderboard = await getRedisJson(leaderboardCacheKey('test_alpha'));
  assert.equal(cachedLeaderboard.testId, 'test_alpha');
  assert.equal(cachedLeaderboard.attempts.length, 3);
});
