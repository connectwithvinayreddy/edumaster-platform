const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { randomUUID } = require('crypto');

dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const { appConfig, getProductionConfigDiagnostics } = require('./lib/config.js');
const { getHealthSnapshot } = require('./lib/health.js');
const { securityHeaders, basicRateLimit } = require('./middleware/security.js');
const { notFoundHandler, errorHandler } = require('./middleware/error-handler.js');
const paymentRoutes = require('./payment/payment.routes.js');
const razorpayRoutes = require('./payment/razorpay.routes.js');
const engagementRoutes = require('./engagement/engagement.routes.js');
const trackRoutes = require('./track/track.routes.js');
const notificationsRoutes = require('./notifications/notifications.routes.js');
const adminRoutes = require('./admin/admin.routes.js');
const analyticsRoutes = require('./analytics/analytics.routes.js');
const userRoutes = require('./user/user.routes.js');
const courseRoutes = require('./course/course.routes.js');
const testRoutes = require('./test/test.routes.js');
const quizRoutes = require('./quiz/quiz.routes.js');
const authRoutes = require('./auth/auth.routes.js');
const platformRoutes = require('./platform/platform.routes.js');
const liveRoutes = require('./live/live.routes.js');
const { startLiveEventBus } = require('./live/live-event-bus.js');
const { ensureReplayImporterWorker } = require('./live/live-replay.worker.js');
const { startMockTestRankingWorker, recoverPendingMockTestRankJobs } = require('./test/mock-test-ranking.worker.js');
const { connectDatabase, getDatabaseMode } = require('./lib/database.js');
const { isFirestoreStateEnabled, getStateDocumentRef } = require('./lib/firebase-state.js');
const { resetState, serializeState } = require('./lib/store.js');
const { recoverPendingCourseVideoProcessingJobs, startVideoProcessingRecoveryLoop } = require('./lib/video-processing.js');

const parseCorsOrigin = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '*') {
    return true;
  }

  const origins = normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return origins.length <= 1 ? origins[0] : origins;
};

const app = express();
app.set('trust proxy', appConfig.trustProxy);
app.disable('x-powered-by');
app.use(cors({ origin: parseCorsOrigin(appConfig.corsOrigin) }));
app.use((req, res, next) => {
  const requestId = String(req.headers['x-request-id'] || req.headers['cf-ray'] || randomUUID());
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});
app.use(express.json({
  limit: appConfig.jsonBodyLimit,
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(securityHeaders);
app.use(basicRateLimit);

if (isFirestoreStateEnabled()) {
  app.use(async (_req, res, next) => {
    try {
      const stateRef = await getStateDocumentRef();
      const snapshot = stateRef ? await stateRef.get() : null;
      resetState(snapshot?.exists ? snapshot.data() : {});

      res.on('finish', async () => {
        try {
          const latestRef = await getStateDocumentRef();
          if (latestRef) {
            await latestRef.set(serializeState(), { merge: true });
          }
        } catch (error) {
          console.error('[firestore-state] Failed to persist request state', error);
        }
      });

      next();
    } catch (error) {
      next(error);
    }
  });
}

app.get(['/api/health', '/backend/api/health'], async (_req, res) => {
  const snapshot = await getHealthSnapshot();
  res.status(snapshot.status === 'degraded' ? 503 : 200).json(snapshot);
});

app.get(['/api/ready', '/backend/api/ready'], async (_req, res) => {
  const snapshot = await getHealthSnapshot();
  const ready = ['ok', 'bootstrapped'].includes(snapshot.status);
  res.status(ready ? 200 : 503).json({
    ready,
    status: snapshot.status,
    mode: snapshot.mode,
    dependencies: snapshot.dependencies,
  });
});

app.get(['/api/live', '/backend/api/live'], (_req, res) => {
  res.json({
    alive: true,
    mode: getDatabaseMode(),
    timestamp: new Date().toISOString(),
  });
});

['/api', '/backend/api'].forEach((prefix) => {
  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/courses`, courseRoutes);
  app.use(`${prefix}/tests`, testRoutes);
  app.use(`${prefix}/quiz`, quizRoutes);
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/analytics`, analyticsRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
  app.use(`${prefix}/notifications`, notificationsRoutes);
  app.use(`${prefix}/engagement`, engagementRoutes);
  app.use(`${prefix}/track`, trackRoutes);
  app.use(`${prefix}/payment`, paymentRoutes);
  app.use(`${prefix}/razorpay`, razorpayRoutes);
  app.use(`${prefix}/platform`, platformRoutes);
  if (appConfig.liveClassesEnabled) {
    app.use(`${prefix}/live-classes`, liveRoutes);
  }
});

const PORT = appConfig.port;
const HOST = process.env.HOST || '127.0.0.1';
const enableBackgroundWorkers = String(process.env.ENABLE_BACKGROUND_WORKERS || 'true').toLowerCase() !== 'false';

app.use(notFoundHandler);
app.use(errorHandler);

const startServer = async (options = {}) => {
  const diagnostics = getProductionConfigDiagnostics();
  if (diagnostics.errors.length > 0) {
    throw new Error(`Production configuration invalid:\n- ${diagnostics.errors.join('\n- ')}`);
  }

  diagnostics.warnings.forEach((warning) => {
    console.warn(`[config] ${warning}`);
  });

  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    if (!appConfig.allowMemoryFallback) {
      throw new Error(`Persistent database unavailable: ${databaseState.reason}`);
    }

    console.warn(`Database unavailable, starting in memory mode: ${databaseState.reason}`);
  }

  const port = options.port ?? PORT;
  const host = options.host ?? HOST;
  if (enableBackgroundWorkers) {
    startLiveEventBus();
    ensureReplayImporterWorker();
    startMockTestRankingWorker();
    recoverPendingCourseVideoProcessingJobs({ forceRestartRecovery: true })
      .then((result) => {
        console.log(`[video-processing] ${JSON.stringify({
          event: 'startup-recovery-complete',
          scannedLessons: result.scanned,
          scheduledJobs: result.scheduled,
          at: new Date().toISOString(),
        })}`);
      })
      .catch((error) => {
        console.error('[video-processing] failed to recover pending course video jobs', error);
      });
    recoverPendingMockTestRankJobs()
      .then((result) => {
        console.log(`[mock-test-ranking] ${JSON.stringify({
          event: 'startup-recovery-complete',
          scannedTests: result.scanned,
          scheduledJobs: result.scheduled,
          at: new Date().toISOString(),
        })}`);
      })
      .catch((error) => {
        console.error('[mock-test-ranking] failed to recover pending rank jobs', error);
      });
    startVideoProcessingRecoveryLoop();
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      console.log(`Server running on ${host}:${resolvedPort} (${databaseState.mode})`);
      resolve({ server, databaseState });
    });

    server.on('error', reject);
  });
};

if (require.main === module) {
  process.on('unhandledRejection', (error) => {
    console.error('[process] unhandledRejection', error);
  });
  process.on('uncaughtException', (error) => {
    console.error('[process] uncaughtException', error);
  });
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
};
