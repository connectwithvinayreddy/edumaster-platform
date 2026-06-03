const express = require('express');
const { requireAuth } = require('../middleware/auth.js');
const { createRazorpayOrder, verifyRazorpayPayment, webhook } = require('./payment.controller.js');

const router = express.Router();

router.post('/create-order', requireAuth, createRazorpayOrder);
router.post('/verify-payment', requireAuth, verifyRazorpayPayment);
router.post('/webhook', webhook);

module.exports = router;
