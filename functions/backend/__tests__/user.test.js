// Jest + SuperTest: User API tests (MVP)
const request = require('supertest');
const { app } = require('../server.cjs');

describe('User API', () => {
  it('should get user profile (unauthenticated)', async () => {
    const res = await request(app).get('/api/user/profile');
    expect([401, 403, 404]).toContain(res.statusCode); // Should be protected
  });
});
