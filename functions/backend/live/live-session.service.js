const {
  ensureSession: ensureStoredSession,
  readSession,
  syncStatus: syncStoredStatus,
  joinParticipant,
  leaveParticipant,
  heartbeat: updateHeartbeat,
  updateParticipant,
  sanitizeParticipant,
} = require('./live-state.repository.js');
const { broadcastLiveEvent, subscribeLiveEvents } = require('./live-event-bus.js');

const streamConnections = new Map();
const nowIso = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

subscribeLiveEvents((message) => {
  const listeners = streamConnections.get(String(message.liveClassId)) || new Set();
  listeners.forEach((res) => {
    res.write(`event: ${message.event}\n`);
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  });
});

const publish = async (liveClassId, event, payload = {}) => {
  const message = {
    event,
    liveClassId: String(liveClassId),
    timestamp: nowIso(),
    ...payload,
  };

  await broadcastLiveEvent(message);
};

const ensureSession = async (liveClass, overrides = {}) => ensureStoredSession(liveClass, overrides);

const getSessionSnapshot = async (liveClass) => {
  const session = await ensureStoredSession(liveClass);
  return clone(session);
};

const syncStatus = async (liveClass, nextStatus) => {
  const session = await syncStoredStatus(liveClass, nextStatus);
  await publish(session.liveClassId, 'session.updated', { session });
  return session;
};

const joinSession = async (liveClass, user) => {
  const participant = await joinParticipant(liveClass, user);
  const session = await readSession(liveClass._id);
  await publish(liveClass._id, 'participant.joined', {
    participant: sanitizeParticipant(participant),
    session,
  });
  return sanitizeParticipant(participant);
};

const leaveSession = async (liveClassId, userId) => {
  const session = await leaveParticipant(liveClassId, userId);
  const participant = session.participants.find((entry) => entry.userId === String(userId)) || null;
  if (participant) {
    await publish(liveClassId, 'participant.left', {
      participant: sanitizeParticipant(participant),
      session,
    });
  }
  return session;
};

const heartbeat = async (liveClassId, userId) => updateHeartbeat(liveClassId, userId);

const updateParticipantMedia = async (liveClassId, userId, payload = {}) => {
  const result = await updateParticipant(liveClassId, userId, (participant) => ({
    ...participant,
    micMuted: typeof payload.micMuted === 'boolean' ? payload.micMuted : participant.micMuted,
    videoEnabled: typeof payload.videoEnabled === 'boolean' ? payload.videoEnabled : participant.videoEnabled,
    isScreenSharing: typeof payload.isScreenSharing === 'boolean' ? payload.isScreenSharing : participant.isScreenSharing,
    isPresenting: typeof payload.isScreenSharing === 'boolean'
      ? payload.isScreenSharing || participant.isPresenting
      : participant.isPresenting,
    lastSeenAt: nowIso(),
  }));

  await publish(liveClassId, 'participant.media-updated', {
    participant: result.participant,
    session: result.session,
  });
  return result.participant;
};

const setRaisedHand = async (liveClassId, userId, raised) => {
  const result = await updateParticipant(liveClassId, userId, (participant) => ({
    ...participant,
    handRaised: Boolean(raised),
    handStatus: raised ? 'pending' : 'idle',
    canSpeak: raised ? participant.canSpeak : participant.role === 'admin' ? true : false,
    lastSeenAt: nowIso(),
  }));

  await publish(liveClassId, 'participant.hand-updated', {
    participant: result.participant,
    session: result.session,
  });
  return result.participant;
};

const setSpeakerApproval = async (liveClassId, targetUserId, approved) => {
  const result = await updateParticipant(
    liveClassId,
    targetUserId,
    (participant) => ({
      ...participant,
      canSpeak: Boolean(approved),
      handRaised: false,
      handStatus: approved ? 'approved' : 'rejected',
      micMuted: approved ? participant.micMuted : true,
      lastSeenAt: nowIso(),
    }),
    'LIVE_PARTICIPANT_NOT_FOUND',
    404,
  );

  await publish(liveClassId, 'participant.speaking-updated', {
    participant: result.participant,
    session: result.session,
  });
  return result.participant;
};

const setParticipantMuted = async (liveClassId, targetUserId, muted) => {
  const result = await updateParticipant(
    liveClassId,
    targetUserId,
    (participant) => ({
      ...participant,
      micMuted: Boolean(muted),
      lastSeenAt: nowIso(),
    }),
    'LIVE_PARTICIPANT_NOT_FOUND',
    404,
  );

  await publish(liveClassId, 'participant.mute-updated', {
    participant: result.participant,
    session: result.session,
  });
  return result.participant;
};

const removeParticipant = async (liveClassId, targetUserId) => {
  const result = await updateParticipant(
    liveClassId,
    targetUserId,
    (participant) => ({
      ...participant,
      removed: true,
      canSpeak: false,
      micMuted: true,
      videoEnabled: false,
      isPresenting: false,
      isScreenSharing: false,
      lastSeenAt: nowIso(),
    }),
    'LIVE_PARTICIPANT_NOT_FOUND',
    404,
  );

  await publish(liveClassId, 'participant.removed', {
    participant: result.participant,
    session: result.session,
  });
  return result.participant;
};

const publishChat = async (liveClassId, chatMessage) => {
  await publish(liveClassId, 'chat.message', { message: clone(chatMessage) });
};

const registerStream = (liveClassId, res) => {
  const key = String(liveClassId);
  const listeners = streamConnections.get(key) || new Set();
  listeners.add(res);
  streamConnections.set(key, listeners);
};

const unregisterStream = (liveClassId, res) => {
  const key = String(liveClassId);
  const listeners = streamConnections.get(key);
  if (!listeners) {
    return;
  }
  listeners.delete(res);
  if (listeners.size === 0) {
    streamConnections.delete(key);
  }
};

module.exports = {
  ensureSession,
  getSessionSnapshot,
  syncStatus,
  joinSession,
  leaveSession,
  heartbeat,
  updateParticipantMedia,
  setRaisedHand,
  setSpeakerApproval,
  setParticipantMuted,
  removeParticipant,
  publishChat,
  registerStream,
  unregisterStream,
};
