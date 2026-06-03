const express = require('express');
const { requireAuth } = require('../middleware/auth.js');
const { trackHeartbeat, trackSuspiciousActivity } = require('./track.controller.js');

const router = express.Router();

router.post('/', requireAuth, trackHeartbeat);
router.post('/suspicious', requireAuth, trackSuspiciousActivity);

module.exports = router;
