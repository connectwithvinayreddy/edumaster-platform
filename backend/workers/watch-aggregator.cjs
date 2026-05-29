const { platformRepository } = require('../lib/repositories.js');
const {
  getRedisSetMembers,
  getRedisJson,
  setRedisJson,
  deleteRedisKey,
  removeRedisSetMember,
} = require('../lib/redis.js');
const { ACTIVE_TRACK_SET, HEARTBEAT_TTL_SECONDS } = require('../track/track.controller.js');

const AGGREGATION_INTERVAL_MS = Number(process.env.TRACK_AGGREGATION_INTERVAL_MS || 60_000);
const STALE_SESSION_MS = Number(process.env.TRACK_STALE_SESSION_MS || 120_000);
const WATCH_COMPLETION_THRESHOLD = Math.min(
  Math.max(Number(process.env.VIDEO_WATCH_COMPLETION_THRESHOLD_PERCENT || 90) / 100, 0.5),
  1,
);

const nowIso = () => new Date().toISOString();

const finalizeSession = async (key, session, reason = 'completed') => {
  await removeRedisSetMember(ACTIVE_TRACK_SET, key);
  await deleteRedisKey(key);
  console.log(`[watch-aggregator] finalized ${key} (${reason})`);
};

const processSession = async (key) => {
  const session = await getRedisJson(key);
  if (!session) {
    await removeRedisSetMember(ACTIVE_TRACK_SET, key);
    return;
  }

  const lastSeenAt = Date.parse(session.lastSeenAt || session.startedAt || '');
  if (!Number.isFinite(lastSeenAt)) {
    await finalizeSession(key, session, 'invalid-timestamp');
    return;
  }

  const watchSeconds = Math.max(
    Number(session.watchSeconds || 0),
    Number(session.currentTimeSeconds || 0),
  );
  const durationSeconds = Math.max(
    Number(session.durationSeconds || 0),
    Number(session.currentTimeSeconds || 0),
    1,
  );

  const stale = (Date.now() - lastSeenAt) > STALE_SESSION_MS;
  const shouldCount = !session.viewCountedAt && watchSeconds >= (durationSeconds * WATCH_COMPLETION_THRESHOLD);

  if (shouldCount) {
    session.viewCountedAt = nowIso();
    await setRedisJson(key, session, { ttlSeconds: HEARTBEAT_TTL_SECONDS });
    if (session.lessonId) {
      await platformRepository.recordCompletedVideoWatch({
        userId: session.userId,
        courseId: session.courseId,
        lessonId: session.lessonId,
        progressSeconds: watchSeconds,
        durationSeconds,
        sessionId: session.sessionId || null,
        device: session.device || null,
      });
    } else {
      await platformRepository.incrementEnrollmentViewCount({
        userId: session.userId,
        courseId: session.courseId,
      });
    }
    await removeRedisSetMember(ACTIVE_TRACK_SET, key);
    await deleteRedisKey(key);
    console.log(`[watch-aggregator] counted view for ${session.userId}/${session.courseId}`);
    return;
  }

  if (stale) {
    await finalizeSession(key, session, 'stale');
    return;
  }

  session.watchSeconds = watchSeconds;
  await setRedisJson(key, session, { ttlSeconds: HEARTBEAT_TTL_SECONDS });
};

const runAggregationPass = async () => {
  const keys = await getRedisSetMembers(ACTIVE_TRACK_SET);
  if (!keys.length) {
    return;
  }

  await Promise.allSettled(keys.map((key) => processSession(key)));
};

if (require.main === module) {
  console.log(`[watch-aggregator] starting, interval=${AGGREGATION_INTERVAL_MS}ms`);

  const loop = async () => {
    try {
      await runAggregationPass();
    } catch (error) {
      console.error('[watch-aggregator] pass failed', error);
    }
  };

  void loop();
  const timer = setInterval(loop, AGGREGATION_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  runAggregationPass,
};
