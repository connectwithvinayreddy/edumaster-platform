const express = require('express');
const { getNotifications, sendNotification } = require('./notifications.controller.js');
const { requireAuth } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/admin.js');
const router = express.Router();

router.get('/', requireAuth, getNotifications);
router.post('/send', requireAuth, requireAdmin, sendNotification);

module.exports = router;
