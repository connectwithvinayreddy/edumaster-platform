// Phase 1: Sentry integration for error tracking
const Sentry = require('@sentry/node');
const { appConfig } = require('./config.js');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: appConfig.nodeEnv,
    tracesSampleRate: 0.1,
  });
}

module.exports = Sentry;
