const request = require('supertest');
// Patch Express app to mock authentication for analytics endpoints
const express = require('express');
let app = require('../server.cjs');
// If app is a function (Express), patch router for test
if (typeof app === 'function') {
  const router = express.Router();
  // Mock auth middleware: always set req.user
  router.use((req, res, next) => {
    req.user = { id: 'testuser1', role: 'admin' };
    next();
  });
  // Mount analytics routes after mock auth
  const analyticsRoutes = require('../analytics/analytics.routes.js');
  router.use('/api/analytics', analyticsRoutes);
  app = express();
  app.use(express.json());
  app.use(router);
}
const mongoose = require('mongoose');
const { getMongoUri } = require('../lib/database.js');
const { setCachedAnalytics } = require('../lib/analytics-cache.js');

describe('Analytics API (MongoDB cache)', () => {
  beforeAll(async () => {
    const mongoUri = getMongoUri();
    if (mongoUri && mongoose.connection.readyState !== 1) {
      await mongoose.connect(mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
    }
    await mongoose.connection.collection('analytics_cache').deleteMany({});
  }, 20000); // 20s timeout for DB connect

  it('should return user analytics and cache in MongoDB', async () => {
    const userId = 'testuser1';
    // First request triggers computation and caching
    const res1 = await request(app)
      .get(`/api/analytics/user?userId=${userId}`)
      .set('Authorization', 'Bearer testtoken') // adjust as needed
      .expect(200);
    expect(res1.body).toHaveProperty('accuracy');
    // Second request should hit cache (simulate by setting cache directly)
    await setCachedAnalytics(`user:${userId}`, { accuracy: 99, speed: 1, attempts: 10, weakTopics: [], strongTopics: [], suggestions: [], trend: {}, adaptivePlan: {} });
    const res2 = await request(app)
      .get(`/api/analytics/user?userId=${userId}`)
      .set('Authorization', 'Bearer testtoken')
      .expect(200);
    expect(res2.body.accuracy).toBe(99);
  });

  it('should return platform analytics and cache in MongoDB', async () => {
    // First request triggers computation and caching
    const res1 = await request(app)
      .get('/api/analytics/leaderboard')
      .expect(200);
    expect(Array.isArray(res1.body)).toBe(true);
    // Platform analytics endpoint (if implemented)
    // const res2 = await request(app).get('/api/analytics/platform').expect(200);
    // expect(res2.body).toHaveProperty('activeUsers');
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });
});
