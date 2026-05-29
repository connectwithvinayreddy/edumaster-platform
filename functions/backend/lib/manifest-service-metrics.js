const { monitorEventLoopDelay } = require('perf_hooks');

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const counters = {
  requests: 0,
  manifestRequests: 0,
  segmentRequests: 0,
  authFailures: 0,
  bundleMisses: 0,
  bundleMemoryHits: 0,
  bundleRedisHits: 0,
  bundleStorageHits: 0,
  staleServed: 0,
};

const concurrent = {
  current: 0,
  max: 0,
};

const samples = {
  requestLatencyMs: [],
  bundleLoadLatencyMs: [],
  authLatencyMs: [],
};

const cappedPush = (bucket, value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return;
  }
  bucket.push(numeric);
  if (bucket.length > 1024) {
    bucket.shift();
  }
};

const percentile = (values, p) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
};

const average = (values) => {
  if (!values.length) {
    return 0;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
};

const beginManifestRequest = ({ assetKind }) => {
  counters.requests += 1;
  if (assetKind === 'manifest') {
    counters.manifestRequests += 1;
  } else {
    counters.segmentRequests += 1;
  }
  concurrent.current += 1;
  concurrent.max = Math.max(concurrent.max, concurrent.current);
  const startedAt = process.hrtime.bigint();
  return {
    finish({ requestLatencyMs, authLatencyMs, bundleLoadLatencyMs } = {}) {
      concurrent.current = Math.max(0, concurrent.current - 1);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      cappedPush(samples.requestLatencyMs, requestLatencyMs ?? elapsedMs);
      cappedPush(samples.authLatencyMs, authLatencyMs);
      cappedPush(samples.bundleLoadLatencyMs, bundleLoadLatencyMs);
    },
  };
};

const recordBundleCacheStatus = (status) => {
  if (status === 'memory') {
    counters.bundleMemoryHits += 1;
  } else if (status === 'redis') {
    counters.bundleRedisHits += 1;
  } else if (status === 'storage') {
    counters.bundleStorageHits += 1;
  } else if (status === 'stale') {
    counters.staleServed += 1;
  } else {
    counters.bundleMisses += 1;
  }
};

const recordAuthFailure = () => {
  counters.authFailures += 1;
};

const getManifestServiceMetricsSnapshot = () => {
  const cpuUsage = process.cpuUsage();
  const memory = process.memoryUsage();
  const bundleLookups = counters.bundleMemoryHits + counters.bundleRedisHits + counters.bundleStorageHits + counters.bundleMisses;
  const cacheHits = counters.bundleMemoryHits + counters.bundleRedisHits;
  const cacheHitRatio = bundleLookups > 0 ? Number(((cacheHits / bundleLookups) * 100).toFixed(2)) : 0;

  return {
    timestamp: new Date().toISOString(),
    counters: { ...counters },
    concurrent: { ...concurrent },
    latencies: {
      requestAvgMs: average(samples.requestLatencyMs),
      requestP95Ms: percentile(samples.requestLatencyMs, 95),
      authAvgMs: average(samples.authLatencyMs),
      authP95Ms: percentile(samples.authLatencyMs, 95),
      bundleLoadAvgMs: average(samples.bundleLoadLatencyMs),
      bundleLoadP95Ms: percentile(samples.bundleLoadLatencyMs, 95),
    },
    cache: {
      hitRatioPercent: cacheHitRatio,
      bundleLookups,
    },
    runtime: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      cpuUserMs: Math.round(cpuUsage.user / 1000),
      cpuSystemMs: Math.round(cpuUsage.system / 1000),
      eventLoopLagMeanMs: Math.round(loopDelay.mean / 1_000_000),
      eventLoopLagP95Ms: Math.round(loopDelay.percentile(95) / 1_000_000),
      eventLoopLagMaxMs: Math.round(loopDelay.max / 1_000_000),
    },
  };
};

module.exports = {
  beginManifestRequest,
  recordBundleCacheStatus,
  recordAuthFailure,
  getManifestServiceMetricsSnapshot,
};
