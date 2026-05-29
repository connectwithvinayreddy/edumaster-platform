const express = require('express');
const controller = require('./live.controller.js');
const { requireAuth, attachUserFromToken } = require('../middleware/auth.js');
const uploadLiveImage = require('../lib/live-image-upload.js');

const router = express.Router();

const requireAuthFromQuery = async (req, res, next) => {
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : '';
  const headerToken = String(req.headers.authorization || '').startsWith('Bearer ')
    ? String(req.headers.authorization || '').slice('Bearer '.length).trim()
    : '';
  const token = headerToken || queryToken;
  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  const attached = await attachUserFromToken(req, token);
  if (!attached) {
    return res.status(401).json({ message: 'Invalid token' });
  }
  return next();
};

router.get('/', controller.listLiveClasses);
router.get('/ingest/on-publish', controller.validateIngestPublish);
router.post('/ingest/on-publish', controller.validateIngestPublish);
router.get('/stream/:token', controller.streamProtectedLiveAsset);
router.get('/admin', requireAuth, controller.listAdminLiveClasses);
router.post('/assets/poster', requireAuth, uploadLiveImage.single('image'), controller.uploadLiveImageAsset);
router.post('/', requireAuth, controller.createLiveClass);
router.patch('/:liveClassId', requireAuth, controller.updateLiveClass);
router.put('/:liveClassId', requireAuth, controller.updateLiveClass);
router.delete('/:liveClassId', requireAuth, controller.deleteLiveClass);
router.post('/:liveClassId/start', requireAuth, controller.startLiveClass);
router.post('/:liveClassId/end', requireAuth, controller.endLiveClass);

router.get('/:liveClassId/access', requireAuth, controller.getLiveClassAccess);
router.get('/:liveClassId/chat', requireAuth, controller.getLiveClassChat);
router.post('/:liveClassId/chat', requireAuth, controller.postLiveClassChat);

router.get('/:liveClassId/session', requireAuth, controller.getSessionState);
router.post('/:liveClassId/session/join', requireAuth, controller.joinSession);
router.post('/:liveClassId/session/leave', requireAuth, controller.leaveSession);
router.post('/:liveClassId/session/heartbeat', requireAuth, controller.heartbeat);
router.post('/:liveClassId/session/media', requireAuth, controller.updateMedia);
router.post('/:liveClassId/session/raise-hand', requireAuth, controller.updateRaisedHand);
router.post('/:liveClassId/poll/vote', requireAuth, controller.submitPollVote);
router.post('/:liveClassId/session/participants/:participantUserId/approval', requireAuth, controller.updateSpeakerApproval);
router.post('/:liveClassId/session/participants/:participantUserId/mute', requireAuth, controller.updateParticipantMute);
router.post('/:liveClassId/session/participants/:participantUserId/remove', requireAuth, controller.removeParticipant);
router.get('/:liveClassId/events', requireAuthFromQuery, controller.streamEvents);

module.exports = router;
