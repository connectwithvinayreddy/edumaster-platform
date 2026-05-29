// Stripe client and helpers for EduMaster backend
const Stripe = require('stripe');
const { appConfig } = require('./config.js');
const { logger } = require('./logger.js');

if (!appConfig.stripeSecretKey) {
  logger.warn('[stripe] STRIPE_SECRET_KEY not set. Stripe integration is disabled.');
}

const stripe = appConfig.stripeSecretKey ? new Stripe(appConfig.stripeSecretKey, {
  apiVersion: '2023-10-16',
}) : null;

module.exports = {
  stripe,
};
