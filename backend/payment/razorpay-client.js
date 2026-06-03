const crypto = require('crypto');
const { appConfig } = require('../lib/config.js');
const { ApiError } = require('../lib/http.js');

const getRazorpayAuthHeader = () => {
  if (!appConfig.razorpayKeyId || !appConfig.razorpayKeySecret) {
    throw new ApiError(503, 'Razorpay is not configured on the server', { code: 'RAZORPAY_NOT_CONFIGURED' });
  }

  return `Basic ${Buffer.from(`${appConfig.razorpayKeyId}:${appConfig.razorpayKeySecret}`).toString('base64')}`;
};

const callRazorpayApi = async (pathname) => {
  const response = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    headers: {
      authorization: getRazorpayAuthHeader(),
      accept: 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status || 502, String(
      payload?.error?.description
      || payload?.description
      || payload?.message
      || 'Razorpay request failed.',
    ), {
      code: response.status === 401 ? 'RAZORPAY_AUTH_FAILED' : 'RAZORPAY_API_FAILED',
    });
  }

  return payload;
};

const fetchRazorpayPayment = async (paymentId) => {
  const normalizedPaymentId = String(paymentId || '').trim();
  if (!normalizedPaymentId) {
    throw new ApiError(400, 'Razorpay payment ID is required', { code: 'RAZORPAY_PAYMENT_ID_REQUIRED' });
  }
  return callRazorpayApi(`/payments/${encodeURIComponent(normalizedPaymentId)}`);
};

const fetchRazorpayOrder = async (orderId) => {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) {
    throw new ApiError(400, 'Razorpay order ID is required', { code: 'RAZORPAY_ORDER_ID_REQUIRED' });
  }
  return callRazorpayApi(`/orders/${encodeURIComponent(normalizedOrderId)}`);
};

const fetchRazorpayOrderPayments = async (orderId) => {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) {
    throw new ApiError(400, 'Razorpay order ID is required', { code: 'RAZORPAY_ORDER_ID_REQUIRED' });
  }
  const payload = await callRazorpayApi(`/orders/${encodeURIComponent(normalizedOrderId)}/payments`);
  return Array.isArray(payload?.items) ? payload.items : [];
};

const fetchRazorpayPaymentsByDateRange = async ({ from, to, count = 100, skip = 0 }) => {
  const fromUnix = Number(from);
  const toUnix = Number(to);
  const pageSize = Math.max(1, Math.min(100, Number(count) || 100));
  const pageSkip = Math.max(0, Number(skip) || 0);
  if (!Number.isFinite(fromUnix) || !Number.isFinite(toUnix) || fromUnix <= 0 || toUnix <= 0 || toUnix <= fromUnix) {
    throw new ApiError(400, 'Valid Razorpay from/to timestamps are required', { code: 'RAZORPAY_RANGE_REQUIRED' });
  }
  return callRazorpayApi(`/payments?from=${encodeURIComponent(String(fromUnix))}&to=${encodeURIComponent(String(toUnix))}&count=${encodeURIComponent(String(pageSize))}&skip=${encodeURIComponent(String(pageSkip))}`);
};

const verifyRazorpayCheckoutSignature = ({ orderId, paymentId, signature }) => {
  if (!appConfig.razorpayKeySecret) {
    throw new ApiError(503, 'Razorpay is not configured on the server', { code: 'RAZORPAY_NOT_CONFIGURED' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', appConfig.razorpayKeySecret)
    .update(`${String(orderId || '')}|${String(paymentId || '')}`)
    .digest('hex');

  return expectedSignature === String(signature || '');
};

const getRazorpayWebhookSecret = () => String(
  process.env.RAZORPAY_WEBHOOK_SECRET
  || process.env.RAZORPAY_PAYMENT_WEBHOOK_SECRET
  || appConfig.razorpayKeySecret
  || '',
).trim();

const verifyRazorpayWebhookSignature = ({ rawBody, signature }) => {
  const secret = getRazorpayWebhookSecret();
  if (!secret) {
    throw new ApiError(503, 'Razorpay webhook secret is not configured on the server', {
      code: 'RAZORPAY_WEBHOOK_NOT_CONFIGURED',
    });
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const actual = Buffer.from(String(signature || ''), 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

module.exports = {
  fetchRazorpayOrder,
  fetchRazorpayPayment,
  fetchRazorpayOrderPayments,
  fetchRazorpayPaymentsByDateRange,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
};
