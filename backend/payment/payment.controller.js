// Payment Controller
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { appConfig } = require('../lib/config.js');
const { coursesRepository, paymentRepository } = require('../lib/repositories.js');
const { ApiError, asyncHandler, ok, requireNumber, requireString, optionalString } = require('../lib/http.js');

let razorpayClient = null;
const getRazorpayClient = () => {
  if (!appConfig.razorpayKeyId || !appConfig.razorpayKeySecret) {
    throw new ApiError(503, 'Razorpay is not configured on the server', { code: 'RAZORPAY_NOT_CONFIGURED' });
  }

  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: appConfig.razorpayKeyId,
      key_secret: appConfig.razorpayKeySecret,
    });
  }

  return razorpayClient;
};

const getCoursePayableAmountPaise = (course) => {
  const price = Math.max(0, Number(course?.price || 0));
  const offerPercentage = Math.min(100, Math.max(0, Number(course?.offerPercentage || 0)));
  const discountedPrice = price * (1 - (offerPercentage / 100));
  return Math.max(100, Math.round(Math.max(Number(discountedPrice.toFixed(2)), 1) * 100));
};

const checkout = asyncHandler(async (req, res) => {
  const payment = await paymentRepository.createCheckout({
    userId: req.user?.id,
    amount: requireNumber(req.body?.amount, 'amount', { min: 1 }),
    currency: optionalString(req.body?.currency, 'INR', { maxLength: 12 }),
    item: optionalString(req.body?.item, 'Course Purchase', { maxLength: 160 }),
  });
  return ok(res, payment);
});

const createRazorpayOrder = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const courseId = requireString(req.body?.courseId, 'courseId');
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  const amount = getCoursePayableAmountPaise(course);
  requireNumber(req.body?.amount ?? amount, 'amount', { min: 100, integer: true });
  const currency = optionalString(req.body?.currency, 'INR', { maxLength: 12 }) || 'INR';
  const receipt = optionalString(req.body?.receipt, `course-${courseId}-${Date.now()}`, { maxLength: 255 });
  const origin = optionalString(req.body?.origin, '', { maxLength: 255 }) || null;

  try {
    const order = await getRazorpayClient().orders.create({
      amount,
      currency,
      receipt,
      notes: {
        courseId,
        userId: String(userId),
      },
    });

    const payment = await paymentRepository.createRazorpayCourseOrder({
      userId,
      courseId,
      currency,
      receipt,
      origin,
      requestedAmountPaise: Number(req.body?.amount || amount),
      providerOrderId: order.id,
    });

    return ok(res, {
      provider: 'razorpay',
      paymentId: payment._id,
      order_id: order.id,
      amount: Number(order.amount || amount),
      currency: order.currency || currency,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const statusCode = Number(error?.statusCode || error?.status || 500);
    const description = String(
      error?.error?.description
      || error?.description
      || error?.message
      || 'Unable to create Razorpay order.',
    );
    throw new ApiError(statusCode === 401 ? 401 : 500, description, {
      code: statusCode === 401 ? 'RAZORPAY_AUTH_FAILED' : 'RAZORPAY_ORDER_FAILED',
    });
  }
});

const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const userId = req.user?.id || null;
  if (!userId) {
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const courseId = requireString(req.body?.courseId, 'courseId');
  const paymentId = requireString(req.body?.paymentId, 'paymentId');
  const razorpayOrderId = requireString(req.body?.razorpay_order_id, 'razorpay_order_id');
  const razorpayPaymentId = requireString(req.body?.razorpay_payment_id, 'razorpay_payment_id');
  const razorpaySignature = requireString(req.body?.razorpay_signature, 'razorpay_signature');

  if (!appConfig.razorpayKeySecret) {
    throw new ApiError(503, 'Razorpay is not configured on the server', { code: 'RAZORPAY_NOT_CONFIGURED' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', appConfig.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    throw new ApiError(400, 'Payment signature mismatch', { code: 'INVALID_PAYMENT_SIGNATURE' });
  }

  let remotePayment;
  try {
    remotePayment = await getRazorpayClient().payments.fetch(razorpayPaymentId);
  } catch (error) {
    const statusCode = Number(error?.statusCode || error?.status || 500);
    const description = String(
      error?.error?.description
      || error?.description
      || error?.message
      || 'Unable to verify payment status with Razorpay.',
    );
    throw new ApiError(statusCode === 401 ? 401 : 500, description, {
      code: statusCode === 401 ? 'RAZORPAY_AUTH_FAILED' : 'RAZORPAY_VERIFY_FAILED',
    });
  }

  const remoteOrderId = String(remotePayment?.order_id || '');
  const remoteStatus = String(remotePayment?.status || '').toLowerCase();
  if (remoteOrderId !== razorpayOrderId) {
    throw new ApiError(400, 'Razorpay payment is linked to a different order', { code: 'PAYMENT_ORDER_MISMATCH' });
  }
  if (!['authorized', 'captured'].includes(remoteStatus)) {
    throw new ApiError(400, 'Razorpay payment is not successful', { code: 'PAYMENT_NOT_SUCCESSFUL' });
  }

  const result = await paymentRepository.markRazorpayCoursePaymentPaid({
    userId,
    paymentId,
    courseId,
    providerOrderId: razorpayOrderId,
    providerPaymentId: razorpayPaymentId,
    providerSignature: razorpaySignature,
  });

  return ok(res, {
    success: true,
    payment: result.payment,
    enrollment: result.enrollment,
  });
});

const webhook = asyncHandler(async (req, res) => {
  const paymentId = requireString(req.body?.paymentId, 'paymentId');
  const status = requireString(req.body?.status, 'status');
  const webhookRecord = await paymentRepository.handleWebhook({
    ...req.body,
    paymentId,
    status,
    event: optionalString(req.body?.event, 'payment.updated', { maxLength: 120 }),
  });
  return ok(res, { message: 'Webhook received', webhook: webhookRecord });
});

const retryPayment = asyncHandler(async (req, res) => {
  const payment = await paymentRepository.retryPayment(requireString(req.params.paymentId, 'paymentId'), req.user?.id);
  if (payment === null) {
    throw new ApiError(404, 'Payment not found', { code: 'PAYMENT_NOT_FOUND' });
  }

  if (payment === false) {
    throw new ApiError(403, 'Cannot retry payment for another user', { code: 'PAYMENT_FORBIDDEN' });
  }

  return ok(res, payment);
});

module.exports = {
  checkout,
  createRazorpayOrder,
  verifyRazorpayPayment,
  webhook,
  retryPayment,
};
