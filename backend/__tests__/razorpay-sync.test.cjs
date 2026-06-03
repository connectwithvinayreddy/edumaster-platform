const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_sync';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_secret_sync';

const { resetState, state } = require('../lib/store.js');
const { paymentRepository } = require('../lib/repositories.js');

const originalFetch = global.fetch;

const buildFetchMock = ({
  payment,
  order = null,
}) => async (url) => {
  if (String(url).includes('/orders/') && String(url).includes('/payments')) {
    return {
      ok: true,
      json: async () => ({ items: payment ? [payment] : [] }),
    };
  }

  if (String(url).includes('/orders/')) {
    return {
      ok: true,
      json: async () => (order || {
        id: payment?.order_id || 'order_unknown',
        amount: payment?.amount || 0,
        currency: payment?.currency || 'INR',
        status: 'paid',
        notes: {
          userId: 'student_1',
          courseId: 'course_bank',
        },
      }),
    };
  }

  return {
    ok: true,
    json: async () => payment,
  };
};

const seedBaseState = () => {
  resetState({
    users: [
      {
        _id: 'student_1',
        name: 'GUGULOTHU ARUN SAI',
        email: 'saiarun760@gmail.com',
        mobileNumber: '+917893193816',
        role: 'student',
        accountStatus: 'active',
        created_at: new Date('2026-05-31T10:00:00.000Z').toISOString(),
      },
    ],
    courses: [
      {
        _id: 'course_bank',
        title: 'Bank',
        price: 1499,
        offerPercentage: 0,
        validityDays: 365,
      },
    ],
    payments: [
      {
        _id: 'payment_1',
        userId: 'student_1',
        courseId: 'course_bank',
        amount: 1499,
        currency: 'INR',
        provider: 'razorpay',
        providerOrderId: 'order_Svwn6scflb9T2I',
        providerPaymentId: null,
        providerSignature: null,
        receipt: 'course-course_bank-1',
        item: 'Course Purchase: Bank',
        status: 'pending',
        attemptCount: 1,
        retryable: true,
        lastError: null,
        meta: {
          expectedAmountPaise: 149900,
        },
        createdAt: new Date('2026-05-31T10:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-05-31T10:00:00.000Z').toISOString(),
      },
    ],
  });
};

test.afterEach(() => {
  global.fetch = originalFetch;
  resetState({});
});

test('syncRazorpayPayment marks captured payments paid and creates access exactly once', async () => {
  seedBaseState();

  global.fetch = buildFetchMock({
    payment: {
      id: 'pay_SvwnRM6UShYWJ3',
      order_id: 'order_Svwn6scflb9T2I',
      status: 'captured',
      captured: true,
      amount: 149900,
      currency: 'INR',
      created_at: 1780225271,
      method: 'upi',
      email: 'saiarun760@gmail.com',
      contact: '+917893193816',
      acquirer_data: {
        rrn: '267931609950',
      },
    },
  });

  const first = await paymentRepository.syncRazorpayPayment({
    paymentId: 'payment_1',
    syncSource: 'admin_sync',
    actorId: 'admin_1',
    reason: 'incident repair',
  });

  assert.equal(first.payment.status, 'paid');
  assert.equal(first.verificationDecision, 'VERIFIED_CAPTURED_ACTIVATED');
  assert.equal(first.payment.providerPaymentId, 'pay_SvwnRM6UShYWJ3');
  assert.equal(first.payment.meta.gatewayStatus, 'captured');
  assert.equal(first.payment.meta.paymentMethod, 'upi');
  assert.equal(first.payment.meta.bankRrn, '267931609950');
  assert.equal(first.enrollment.userId, 'student_1');
  assert.equal(first.enrollment.courseId, 'course_bank');
  assert.equal(first.enrollment.accessStatus, 'enabled');
  assert.equal(state.enrollments.length, 1);

  const firstExpiry = state.enrollments[0].expiresAt;
  const second = await paymentRepository.syncRazorpayPayment({
    paymentId: 'payment_1',
    syncSource: 'admin_sync',
    actorId: 'admin_1',
    reason: 'incident repair rerun',
  });

  assert.equal(second.payment.status, 'paid');
  assert.equal(second.verificationDecision, 'VERIFIED_CAPTURED_ACTIVATED');
  assert.equal(state.enrollments.length, 1);
  assert.equal(state.enrollments[0].expiresAt, firstExpiry);
});

test('syncRazorpayPayment disables payment-linked access when Razorpay confirms failure', async () => {
  seedBaseState();
  state.enrollments.push({
    _id: 'enrollment_1',
    userId: 'student_1',
    courseId: 'course_bank',
    accessType: 'course',
    source: 'razorpay',
    accessStatus: 'enabled',
    adminNote: null,
    enrolledAt: new Date('2026-05-31T10:05:00.000Z').toISOString(),
    expiresAt: new Date('2027-05-31T10:05:00.000Z').toISOString(),
    viewCount: 0,
    updatedAt: new Date('2026-05-31T10:05:00.000Z').toISOString(),
  });

  global.fetch = buildFetchMock({
    payment: {
      id: 'pay_failed_1',
      order_id: 'order_Svwn6scflb9T2I',
      status: 'failed',
      captured: false,
      amount: 149900,
      currency: 'INR',
      created_at: 1780225271,
      method: 'upi',
      acquirer_data: {},
      error_description: 'Payment failed',
    },
  });

  const result = await paymentRepository.syncRazorpayPayment({
    paymentId: 'payment_1',
    syncSource: 'admin_sync',
    actorId: 'admin_1',
    reason: 'incident verification',
  });

  assert.equal(result.payment.status, 'failed');
  assert.equal(result.verificationDecision, 'GATEWAY_FAILED');
  assert.equal(state.enrollments.length, 1);
  assert.equal(state.enrollments[0].accessStatus, 'disabled');
  assert.match(String(state.enrollments[0].adminNote || ''), /incident verification|failure/i);
});

test('syncRazorpayPayment keeps amount mismatches in manual review without activating access', async () => {
  seedBaseState();

  global.fetch = buildFetchMock({
    payment: {
      id: 'pay_amount_mismatch_1',
      order_id: 'order_Svwn6scflb9T2I',
      status: 'captured',
      captured: true,
      amount: 99900,
      currency: 'INR',
      created_at: 1780225271,
      method: 'upi',
      email: 'saiarun760@gmail.com',
      contact: '+917893193816',
      acquirer_data: {},
    },
  });

  const result = await paymentRepository.syncRazorpayPayment({
    paymentId: 'payment_1',
    syncSource: 'admin_sync',
    actorId: 'admin_1',
    reason: 'amount mismatch review',
  });

  assert.equal(result.payment.status, 'pending');
  assert.equal(result.verificationDecision, 'AMOUNT_MISMATCH');
  assert.equal(result.manualReviewRequired, true);
  assert.equal(state.enrollments.length, 0);
});

test('syncRazorpayPayment keeps order mismatches in manual review without activating access', async () => {
  seedBaseState();

  global.fetch = buildFetchMock({
    payment: {
      id: 'pay_order_mismatch_1',
      order_id: 'order_other_1',
      status: 'captured',
      captured: true,
      amount: 149900,
      currency: 'INR',
      created_at: 1780225271,
      method: 'upi',
      email: 'saiarun760@gmail.com',
      contact: '+917893193816',
      acquirer_data: {},
    },
    order: {
      id: 'order_Svwn6scflb9T2I',
      amount: 149900,
      currency: 'INR',
      status: 'paid',
      notes: {
        userId: 'student_1',
        courseId: 'course_bank',
      },
    },
  });

  const result = await paymentRepository.syncRazorpayPayment({
    paymentId: 'payment_1',
    syncSource: 'admin_sync',
    actorId: 'admin_1',
    reason: 'order mismatch review',
  });

  assert.equal(result.payment.status, 'pending');
  assert.equal(result.verificationDecision, 'ORDER_MISMATCH');
  assert.equal(result.manualReviewRequired, true);
  assert.equal(state.enrollments.length, 0);
});

test('syncRazorpayPayment keeps gateway pending transactions pending with no access', async () => {
  seedBaseState();

  global.fetch = buildFetchMock({
    payment: {
      id: 'pay_pending_1',
      order_id: 'order_Svwn6scflb9T2I',
      status: 'authorized',
      captured: false,
      amount: 149900,
      currency: 'INR',
      created_at: 1780225271,
      method: 'upi',
      email: 'saiarun760@gmail.com',
      contact: '+917893193816',
      acquirer_data: {},
    },
  });

  const result = await paymentRepository.syncRazorpayPayment({
    paymentId: 'payment_1',
    syncSource: 'admin_sync',
    actorId: 'admin_1',
    reason: 'gateway pending check',
  });

  assert.equal(result.payment.status, 'pending');
  assert.equal(result.verificationDecision, 'GATEWAY_PENDING');
  assert.equal(state.enrollments.length, 0);
});
