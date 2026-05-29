const express = require('express');
const { getProfile, updateProfile, getProgress, getAnalytics } = require('./user.controller.js');
const { requireAuth } = require('../middleware/auth.js');
const router = express.Router();

router.get('/profile', requireAuth, getProfile);
router.patch('/profile', requireAuth, updateProfile);
router.get('/progress', requireAuth, getProgress);
router.get('/analytics', requireAuth, getAnalytics);

module.exports = router;
