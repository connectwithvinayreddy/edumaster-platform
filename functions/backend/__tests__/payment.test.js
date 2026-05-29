// Jest + SuperTest: Payment API tests (Stripe integration)
console.log('ENV DEBUG STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY);
console.log('ENV DEBUG VITE_STRIPE_PUBLISHABLE_KEY:', process.env.VITE_STRIPE_PUBLISHABLE_KEY);
const request = require('supertest');
const { app } = require('../server.cjs');

let authToken;

beforeAll(async () => {
  // Login as admin to get JWT
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@edumaster.local', password: 'Admin@123' });
  authToken = res.body.token;
});

describe('Payment API', () => {
  it('should reject payment without auth', async () => {
    const res = await request(app)
      .post('/api/payment/checkout')
      .send({ amount: 100 });
    expect(res.statusCode).toBe(401);
  });

  it('should create a Stripe checkout session with auth', async () => {
    const res = await request(app)
      .post('/api/payment/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ amount: 100, currency: 'INR', item: 'Test Course' });
    expect(res.statusCode).toBe(200);
    expect(res.body.sessionUrl).toMatch(/^https:\/\/checkout.stripe.com\//);
    expect(res.body.paymentId).toBeDefined();
  });

  // Webhook test (simulated, does not hit real Stripe)
  it('should reject webhook with invalid signature', async () => {
    const res = await request(app)
      .post('/api/payment/webhook')
      .set('stripe-signature', 'invalid')
      .send({});
    expect(res.statusCode).toBe(400);
  });
});
