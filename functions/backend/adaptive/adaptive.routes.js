const express = require('express');
const { generateAdaptivePlan } = require('../lib/adaptive-engine.js');
const { attachAuthIfPresent } = require('../middleware/auth.js');
const router = express.Router();

// GET /api/adaptive/plan?userId=<id>
router.get('/plan', attachAuthIfPresent, async (req, res) => {
  try {
    const requestedUserId = req.query.userId || null;
    const userId = req.user?.role === 'admin'
      ? requestedUserId || req.user?.id
      : req.user?.id || null;
    if (!userId) {
      return res.status(401).json({ message: 'Authorization required' });
    }
    const plan = await generateAdaptivePlan(userId);
    res.json(plan);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
