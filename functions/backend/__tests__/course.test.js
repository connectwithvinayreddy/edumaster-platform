// Jest + SuperTest: Course API tests (MVP)
const request = require('supertest');
const { app } = require('../server.cjs');

describe('Course API', () => {
  it('should list courses', async () => {
    const res = await request(app).get('/api/courses');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
