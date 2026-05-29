const express = require('express');
const { getTests, getTest, getMyTestAttempts, createTest, updateTest, deleteTest, submitTest } = require('./test.controller.js');
const {
  uploadTestVideo,
  getTestVideoMetadata,
  deleteTestVideo,
  getProtectedTestVideoPlayer,
  streamProtectedTestVideo,
} = require('./test-video.controller.js');
const { requireAuth, attachAuthIfPresent } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/admin.js');
const upload = require('../lib/multer-config.js');
const router = express.Router();

router.get('/', attachAuthIfPresent, getTests);
router.get('/attempts/me', requireAuth, getMyTestAttempts);
router.get('/stream/:token', streamProtectedTestVideo);
router.get('/:id/video/player', requireAuth, getProtectedTestVideoPlayer);
router.get('/:id/video', requireAuth, requireAdmin, getTestVideoMetadata);
router.post('/:id/video', requireAuth, requireAdmin, upload.single('video'), uploadTestVideo);
router.delete('/:id/video', requireAuth, requireAdmin, deleteTestVideo);
router.get('/:id', attachAuthIfPresent, getTest);
router.post('/:id/submit', requireAuth, submitTest);
router.post('/', requireAuth, requireAdmin, createTest);
router.put('/:id', requireAuth, requireAdmin, updateTest);
router.delete('/:id', requireAuth, requireAdmin, deleteTest);

module.exports = router;
