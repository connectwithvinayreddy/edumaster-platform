// analyticsCache.js
// MongoDB-based cache for analytics aggregation

const mongoose = require('mongoose');

const analyticsCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g., 'user:<userId>' or 'platform'
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now, index: true },
}, { collection: 'analytics_cache' });

const AnalyticsCache = mongoose.model('AnalyticsCache', analyticsCacheSchema);

async function getCachedAnalytics(key, maxAgeMs = 5 * 60 * 1000) {
  const entry = await AnalyticsCache.findOne({ key });
  if (!entry) return null;
  if (Date.now() - entry.updatedAt.getTime() > maxAgeMs) return null;
  return entry.data;
}

async function setCachedAnalytics(key, data) {
  await AnalyticsCache.findOneAndUpdate(
    { key },
    { data, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

module.exports = {
  getCachedAnalytics,
  setCachedAnalytics,
};
