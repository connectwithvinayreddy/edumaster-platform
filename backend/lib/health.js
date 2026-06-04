const { appConfig, getConfigSummary, getProductionConfigDiagnostics } = require('./config.js');
const { checkPostgresHealth } = require('./postgres.js');
const { checkRedisHealth } = require('./redis.js');
const { getMongoUri, isMongoConnected, getDatabaseMode } = require('./database.js');
const { isFirestoreStateEnabled } = require('./firebase-state.js');
const { getMockTestRankingWorkerSnapshot } = require('../test/mock-test-ranking.worker.js');

const startedAt = Date.now();

const getMongoHealth = () => ({
  enabled: Boolean(getMongoUri()),
  status: isMongoConnected() ? 'up' : getMongoUri() ? 'down' : 'disabled',
  detail: isMongoConnected()
    ? 'mongoose-connected'
    : getMongoUri()
      ? 'connection-unavailable'
      : 'MONGODB_URI not configured',
});

const getDependencyHealth = async () => {
  const [postgres, redis] = await Promise.all([
    checkPostgresHealth(),
    checkRedisHealth(),
  ]);

  return {
    mongodb: getMongoHealth(),
    firestore: {
      enabled: isFirestoreStateEnabled(),
      status: isFirestoreStateEnabled() ? 'configured' : 'disabled',
      detail: isFirestoreStateEnabled()
        ? `${appConfig.firebaseStateDatabaseId || '(default)'}/${appConfig.firebaseStateCollection}/${appConfig.firebaseStateDocument}`
        : 'FIREBASE_STATE_STORAGE disabled',
    },
    postgres,
    redis,
    storage: {
      enabled: appConfig.privateVideoStorageProvider === 's3'
        ? Boolean(appConfig.storageBucket && appConfig.storageRegion && appConfig.s3AccessKeyId && appConfig.s3SecretAccessKey)
        : true,
      status: appConfig.privateVideoStorageProvider === 's3'
        ? appConfig.storageBucket && appConfig.storageRegion && appConfig.s3AccessKeyId && appConfig.s3SecretAccessKey ? 'configured' : 'down'
        : 'configured',
      detail: appConfig.storageBucket
        ? `${appConfig.privateVideoStorageProvider}:${appConfig.storageBucket} (${appConfig.storageRegion || 'region-missing'})`
        : `storage-provider:${appConfig.privateVideoStorageProvider}`,
    },
    payments: {
      enabled: Boolean(appConfig.stripeSecretKey && appConfig.stripePublishableKey),
      status: appConfig.stripeSecretKey && appConfig.stripePublishableKey ? 'configured' : 'disabled',
      detail: appConfig.stripeSecretKey ? 'stripe-secret-present' : 'STRIPE_SECRET_KEY not configured',
    },
  };
};

const getHealthSnapshot = async () => {
  const dependencies = await getDependencyHealth();
  const dependencyStatuses = Object.values(dependencies).map((entry) => entry.status);
  const overallStatus = dependencyStatuses.includes('down')
    ? 'degraded'
    : dependencyStatuses.some((status) => status === 'up' || status === 'configured')
      ? 'ok'
      : 'bootstrapped';

  return {
    status: overallStatus,
    service: appConfig.serviceName,
    environment: appConfig.environmentLabel,
    mode: getDatabaseMode(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    config: getConfigSummary(),
    diagnostics: getProductionConfigDiagnostics(),
    dependencies,
    workers: {
      mockTestRanking: getMockTestRankingWorkerSnapshot(),
    },
    timestamp: new Date().toISOString(),
  };
};

module.exports = {
  getHealthSnapshot,
};
