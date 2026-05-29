const state = {
  users: [],
  courses: [],
  tests: [],
  testAttempts: [],
  quizzes: [],
  enrollments: [],
  watchHistory: [],
  videoAccessGrants: [],
  liveReplayAccessGrants: [],
  liveClasses: [],
  liveChatMessages: [],
  subscriptions: [],
  userSubscriptions: [],
  aiMessages: [],
  loginSessions: [],
  deviceActivities: [],
  notifications: [],
  lessonDoubtThreads: [],
  lessonDoubtMessages: [],
  referrals: [],
  uploads: [],
  payments: [],
  webhooks: [],
};

const counters = new Map();
const COLLECTION_KEYS = Object.keys(state);

const clone = (value) => JSON.parse(JSON.stringify(value));

const nextId = (prefix) => {
  const nextValue = (counters.get(prefix) || 0) + 1;
  counters.set(prefix, nextValue);
  return `${prefix}_${nextValue}`;
};

const nowIso = () => new Date().toISOString();

const serializeCounters = () => Object.fromEntries(counters.entries());

const inferCountersFromSnapshot = (snapshot = {}) => {
  const inferred = new Map();

  COLLECTION_KEYS.forEach((key) => {
    const entries = Array.isArray(snapshot[key]) ? snapshot[key] : [];
    entries.forEach((entry) => {
      const identifier = typeof entry?._id === 'string' ? entry._id : null;
      const match = identifier?.match(/^(.*)_(\d+)$/);
      if (!match) {
        return;
      }

      const prefix = match[1];
      const parsedValue = Number(match[2]);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        return;
      }

      inferred.set(prefix, Math.max(inferred.get(prefix) || 0, parsedValue));
    });
  });

  return inferred;
};

const hydrateCounters = (snapshot = {}) => {
  counters.clear();

  inferCountersFromSnapshot(snapshot).forEach((value, key) => {
    counters.set(key, value);
  });

  Object.entries(snapshot || {}).forEach(([key, value]) => {
    if (key !== '__counters') {
      return;
    }

    Object.entries(value || {}).forEach(([counterKey, counterValue]) => {
      const parsed = Number(counterValue);
      if (Number.isFinite(parsed) && parsed >= 0) {
        counters.set(counterKey, Math.max(counters.get(counterKey) || 0, parsed));
      }
    });
  });
};

const resetState = (snapshot = {}) => {
  COLLECTION_KEYS.forEach((key) => {
    state[key] = Array.isArray(snapshot[key]) ? clone(snapshot[key]) : [];
  });

  hydrateCounters(snapshot.__counters ? snapshot : {
    ...snapshot,
    __counters: {},
  });
};

const serializeState = () => ({
  ...clone(state),
  __counters: serializeCounters(),
});

module.exports = {
  state,
  clone,
  nextId,
  nowIso,
  resetState,
  serializeState,
};
