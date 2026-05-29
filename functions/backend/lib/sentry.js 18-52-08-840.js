// Sentry error tracking setup
const Sentry = require('@sentry/node');
const { appConfig } = require('./config.js');

function initSentry() {
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: appConfig.nodeEnv,
      tracesSampleRate: 0.1,
    });
    return Sentry;
  }
  return null;
}

module.exports = { Sentry, initSentry };
