const { ApiError } = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const { getRedisJson, setRedisJson } = require('../lib/redis.js');
const {
  normalizeLiveStatus,
  assertLiveStatusTransition,
} = require('./live-state-machine.js');

const localSessions = new Map();
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const LIVE_STATE_TTL_SECONDS = 60 * 60 * 24;
const nowIso = () => new Date().toISOString();

const clone = (value) => JSON.parse(JSON.stringify(value));

const getSessionKey = (liveClassId) => `live:class:${String(liveClassId)}:session`;
const getLiveStateKey = (liveClassId) => `live:class:${String(liveClassId)}:state`;

const sanitizeParticipant = (participant) => ({
  userId: String(participant.userId),
  name: participant.name || 'Participant',
  role: participant.role || 'student',
  joinedAt: participant.joinedAt || nowIso(),
  lastSeenAt: participant.lastSeenAt || nowIso(),
  micMuted: Boolean(participant.micMuted),
  videoEnabled: Boolean(participant.videoEnabled),
  handRaised: Boolean(participant.handRaised),
  handStatus: participant.handStatus || 'idle',
  canSpeak: Boolean(participant.canSpeak),
  isScreenSharing: Boolean(participant.isScreenSharing),
  isPresenting: Boolean(participant.isPresenting),
  removed: Boolean(participant.removed),
});

const sortParticipants = (participants) => participants
  .filter((participant) => !participant.removed)
  .sort((left, right) => {
    if (left.role !== right.role) {
      return left.role === 'admin' ? -1 : 1;
    }
    return Date.parse(left.joinedAt) - Date.parse(right.joinedAt);
  });

const sanitizeSession = (session) => ({
  liveClassId: String(session.liveClassId),
  status: normalizeLiveStatus(session.status),
  roomName: session.roomName || null,
  startedAt: session.startedAt || null,
  endedAt: session.endedAt || null,
  activePresenterId: session.activePresenterId || null,
  version: Number(session.version || 1),
  updatedAt: session.updatedAt || nowIso(),
  participants: sortParticipants(
    Array.isArray(session.participants) ? session.participants.map(sanitizeParticipant) : [],
  ),
});

const buildBaseSession = (liveClass, overrides = {}) => {
  const timestamp = nowIso();
  const status = normalizeLiveStatus(overrides.status || liveClass.status || 'scheduled');
  return {
    liveClassId: String(liveClass._id),
    status,
    roomName: String(
      overrides.roomName
        || liveClass.roomName
        || liveClass.liveRoomName
        || `edumaster-live-${String(liveClass._id)}`,
    ),
    startedAt: overrides.startedAt === undefined
      ? (status === 'live' ? timestamp : null)
      : overrides.startedAt,
    endedAt: overrides.endedAt === undefined ? null : overrides.endedAt,
    activePresenterId: overrides.activePresenterId || null,
    version: Number(overrides.version || 1),
    createdAt: timestamp,
    updatedAt: timestamp,
    participants: Array.isArray(overrides.participants) ? overrides.participants.map(sanitizeParticipant) : [],
  };
};

const sanitizeLiveState = (state, liveClassId = null) => ({
  liveClassId: String(state.liveClassId || liveClassId || ''),
  title: state.title || 'Live class',
  status: normalizeLiveStatus(state.status),
  deliveryMode: state.deliveryMode || 'managed-hls',
  interactiveMode: state.interactiveMode || 'livekit-room',
  provider: state.provider || null,
  mode: state.mode || 'live',
  roomName: state.roomName || null,
  playbackUrl: state.playbackUrl || null,
  playbackType: state.playbackType || null,
  playbackReadyAt: state.playbackReadyAt || null,
  startedAt: state.startedAt || null,
  endedAt: state.endedAt || null,
  courseId: state.courseId || null,
  requiresEnrollment: Boolean(state.requiresEnrollment),
  chatEnabled: state.chatEnabled !== false,
  doubtSolving: state.doubtSolving !== false,
  replayAvailable: state.replayAvailable !== false,
  replayCourseId: state.replayCourseId || null,
  replayLessonId: state.replayLessonId || null,
  recordingUrl: state.recordingUrl || null,
  recordingStorageProvider: state.recordingStorageProvider || null,
  recordingStoragePath: state.recordingStoragePath || null,
  recordingPublishedAt: state.recordingPublishedAt || null,
  recordingState: state.recordingState || null,
  replayState: state.replayState || null,
  version: Number(state.version || 1),
  updatedAt: state.updatedAt || nowIso(),
});

const buildLiveStateFromClass = (liveClass, overrides = {}) => sanitizeLiveState({
  liveClassId: String(liveClass._id),
  title: liveClass.title,
  status: overrides.status || liveClass.status || 'scheduled',
  deliveryMode: overrides.deliveryMode
    || (String(overrides.playbackType || liveClass.livePlaybackType || '').toLowerCase() === 'livekit'
      ? 'livekit-room'
      : 'managed-hls'),
  interactiveMode: overrides.interactiveMode || 'livekit-room',
  provider: overrides.provider || liveClass.provider || null,
  mode: liveClass.mode || 'live',
  roomName: overrides.roomName || liveClass.roomName || liveClass.liveRoomName || `edumaster-live-${String(liveClass._id)}`,
  playbackUrl: overrides.playbackUrl === undefined ? liveClass.livePlaybackUrl || null : overrides.playbackUrl,
  playbackType: overrides.playbackType || liveClass.livePlaybackType || null,
  playbackReadyAt: overrides.playbackReadyAt || null,
  startedAt: overrides.startedAt === undefined ? null : overrides.startedAt,
  endedAt: overrides.endedAt === undefined ? null : overrides.endedAt,
  courseId: liveClass.courseId || null,
  requiresEnrollment: liveClass.requiresEnrollment !== false,
  chatEnabled: liveClass.chatEnabled !== false,
  doubtSolving: liveClass.doubtSolving !== false,
  replayAvailable: liveClass.replayAvailable !== false,
  replayCourseId: liveClass.replayCourseId || null,
  replayLessonId: liveClass.replayLessonId || null,
  recordingUrl: liveClass.recordingUrl || null,
  recordingStorageProvider: liveClass.recordingStorageProvider || null,
  recordingStoragePath: liveClass.recordingStoragePath || null,
  recordingPublishedAt: liveClass.recordingPublishedAt || null,
  recordingState: overrides.recordingState || (liveClass.replayAvailable !== false ? 'pending' : 'disabled'),
  replayState: overrides.replayState || (liveClass.replayAvailable !== false ? 'pending' : 'disabled'),
  version: Number(overrides.version || 1),
  updatedAt: nowIso(),
});

const isRedisEnabled = () => Boolean(appConfig.redisUrl);

const readSession = async (liveClassId) => {
  if (isRedisEnabled()) {
    const session = await getRedisJson(getSessionKey(liveClassId));
    return session ? sanitizeSession(session) : null;
  }

  const session = localSessions.get(String(liveClassId)) || null;
  return session ? sanitizeSession(session) : null;
};

const readLiveState = async (liveClassId) => {
  if (isRedisEnabled()) {
    const liveState = await getRedisJson(getLiveStateKey(liveClassId));
    return liveState ? sanitizeLiveState(liveState, liveClassId) : null;
  }

  const liveState = localSessions.get(`state:${String(liveClassId)}`) || null;
  return liveState ? sanitizeLiveState(liveState, liveClassId) : null;
};

const writeSession = async (session) => {
  const normalized = sanitizeSession(session);
  if (isRedisEnabled()) {
    await setRedisJson(getSessionKey(normalized.liveClassId), normalized, {
      ttlSeconds: SESSION_TTL_SECONDS,
    });
  } else {
    localSessions.set(String(normalized.liveClassId), clone(normalized));
  }
  return normalized;
};

const writeLiveState = async (state) => {
  const normalized = sanitizeLiveState(state, state.liveClassId);
  if (isRedisEnabled()) {
    await setRedisJson(getLiveStateKey(normalized.liveClassId), normalized, {
      ttlSeconds: LIVE_STATE_TTL_SECONDS,
    });
  } else {
    localSessions.set(`state:${String(normalized.liveClassId)}`, clone(normalized));
  }
  return normalized;
};

const ensureLiveState = async (liveClass, overrides = {}) => {
  const existing = await readLiveState(liveClass._id);
  if (!existing) {
    return writeLiveState(buildLiveStateFromClass(liveClass, overrides));
  }

  return writeLiveState({
    ...existing,
    ...sanitizeLiveState({
      ...existing,
      ...overrides,
      liveClassId: String(liveClass._id),
      title: liveClass.title || existing.title,
      provider: overrides.provider || existing.provider || liveClass.provider || null,
      mode: liveClass.mode || existing.mode || 'live',
      courseId: liveClass.courseId || existing.courseId || null,
      requiresEnrollment: liveClass.requiresEnrollment !== false,
      chatEnabled: liveClass.chatEnabled !== false,
      doubtSolving: liveClass.doubtSolving !== false,
      replayAvailable: liveClass.replayAvailable !== false,
      replayCourseId: liveClass.replayCourseId || existing.replayCourseId || null,
      replayLessonId: liveClass.replayLessonId || existing.replayLessonId || null,
      recordingUrl: liveClass.recordingUrl || existing.recordingUrl || null,
      recordingStorageProvider: liveClass.recordingStorageProvider || existing.recordingStorageProvider || null,
      recordingStoragePath: liveClass.recordingStoragePath || existing.recordingStoragePath || null,
      recordingPublishedAt: liveClass.recordingPublishedAt || existing.recordingPublishedAt || null,
      recordingState: overrides.recordingState || existing.recordingState || (liveClass.replayAvailable !== false ? 'pending' : 'disabled'),
      replayState: overrides.replayState || existing.replayState || (liveClass.replayAvailable !== false ? 'pending' : 'disabled'),
      version: Number(existing.version || 1) + 1,
      updatedAt: nowIso(),
    }, liveClass._id),
  });
};

const ensureSession = async (liveClass, overrides = {}) => {
  const liveClassId = String(liveClass._id);
  const existing = await readSession(liveClassId);
  if (!existing) {
    return writeSession(buildBaseSession(liveClass, overrides));
  }

  const merged = {
    ...existing,
    liveClassId,
    status: normalizeLiveStatus(overrides.status || existing.status || liveClass.status || 'scheduled'),
    roomName: overrides.roomName || existing.roomName || liveClass.roomName || liveClass.liveRoomName || `edumaster-live-${liveClassId}`,
    startedAt: overrides.startedAt === undefined ? existing.startedAt || null : overrides.startedAt,
    endedAt: overrides.endedAt === undefined ? existing.endedAt || null : overrides.endedAt,
    activePresenterId: overrides.activePresenterId === undefined ? existing.activePresenterId || null : overrides.activePresenterId,
    version: Number(existing.version || 1),
    updatedAt: nowIso(),
    participants: Array.isArray(existing.participants) ? existing.participants.map(sanitizeParticipant) : [],
  };

  return writeSession(merged);
};

const getSessionOrThrow = async (liveClassId) => {
  const session = await readSession(liveClassId);
  if (!session) {
    throw new ApiError(404, 'Live session not found', { code: 'LIVE_SESSION_NOT_FOUND' });
  }
  return session;
};

const updateSession = async (liveClassId, updater) => {
  const current = await getSessionOrThrow(liveClassId);
  const next = await updater(clone(current));
  return writeSession({
    ...current,
    ...next,
    liveClassId: String(current.liveClassId),
    version: Number(current.version || 1) + 1,
    updatedAt: nowIso(),
  });
};

const syncStatus = async (liveClass, nextStatus, overrides = {}) => {
  const ensured = await ensureSession(liveClass, {
    roomName: overrides.roomName || liveClass.roomName || liveClass.liveRoomName || null,
  });

  assertLiveStatusTransition(ensured.status, nextStatus);

  const normalizedNextStatus = normalizeLiveStatus(nextStatus);
  const timestamp = nowIso();

  return updateSession(liveClass._id, (session) => {
    const participants = Array.isArray(session.participants) ? session.participants.map(sanitizeParticipant) : [];
    if (normalizedNextStatus === 'ended') {
      participants.forEach((participant) => {
        participant.canSpeak = false;
        participant.handRaised = false;
        participant.handStatus = 'idle';
        participant.isScreenSharing = false;
        participant.isPresenting = false;
      });
    }

    return {
      status: normalizedNextStatus,
      roomName: overrides.roomName || session.roomName,
      startedAt: normalizedNextStatus === 'live'
        ? (session.startedAt || timestamp)
        : session.startedAt || null,
      endedAt: normalizedNextStatus === 'ended'
        ? timestamp
        : normalizedNextStatus === 'live'
          ? null
          : session.endedAt || null,
      activePresenterId: normalizedNextStatus === 'ended' ? null : session.activePresenterId || null,
      participants,
    };
  });
};

const joinParticipant = async (liveClass, user) => {
  await ensureSession(liveClass);

  return updateSession(liveClass._id, (session) => {
    const participants = Array.isArray(session.participants) ? session.participants.map(sanitizeParticipant) : [];
    const participantUserId = String(user._id);
    const existing = participants.find((participant) => participant.userId === participantUserId) || null;
    const participant = sanitizeParticipant({
      userId: participantUserId,
      name: user.name,
      role: user.role,
      joinedAt: existing?.joinedAt || nowIso(),
      lastSeenAt: nowIso(),
      micMuted: existing?.micMuted ?? (user.role !== 'admin'),
      videoEnabled: existing?.videoEnabled ?? (user.role === 'admin'),
      handRaised: false,
      handStatus: existing?.handStatus || 'idle',
      canSpeak: existing?.canSpeak ?? (user.role === 'admin'),
      isScreenSharing: existing?.isScreenSharing ?? false,
      isPresenting: existing?.isPresenting ?? (user.role === 'admin'),
      removed: false,
    });

    const filtered = participants.filter((entry) => entry.userId !== participantUserId);
    filtered.push(participant);

    return {
      participants: filtered,
      activePresenterId: participant.isPresenting || participant.isScreenSharing
        ? participant.userId
        : session.activePresenterId || null,
    };
  });
};

const leaveParticipant = async (liveClassId, userId) => updateSession(liveClassId, (session) => {
  const participants = Array.isArray(session.participants) ? session.participants.map(sanitizeParticipant) : [];
  const participantUserId = String(userId);
  const nextParticipants = participants.map((participant) => {
    if (participant.userId !== participantUserId) {
      return participant;
    }
    return sanitizeParticipant({
      ...participant,
      lastSeenAt: nowIso(),
      videoEnabled: false,
      isPresenting: false,
      isScreenSharing: false,
    });
  });

  return {
    participants: nextParticipants,
    activePresenterId: session.activePresenterId === participantUserId ? null : session.activePresenterId || null,
  };
});

const getParticipantOrThrow = (session, userId) => {
  const participant = (Array.isArray(session.participants) ? session.participants : [])
    .map(sanitizeParticipant)
    .find((entry) => entry.userId === String(userId));
  if (!participant || participant.removed) {
    throw new ApiError(403, 'Participant is not active in this session', { code: 'LIVE_PARTICIPANT_INACTIVE' });
  }
  return participant;
};

const heartbeat = async (liveClassId, userId) => {
  let nextParticipant = null;
  await updateSession(liveClassId, (session) => {
    const participants = Array.isArray(session.participants) ? session.participants.map(sanitizeParticipant) : [];
    const participant = getParticipantOrThrow(session, userId);
    nextParticipant = sanitizeParticipant({
      ...participant,
      lastSeenAt: nowIso(),
    });

    return {
      participants: participants.map((entry) => (entry.userId === String(userId) ? nextParticipant : entry)),
    };
  });
  return nextParticipant;
};

const updateParticipant = async (liveClassId, userId, mutator, missingCode = 'LIVE_PARTICIPANT_INACTIVE', missingStatus = 403) => {
  let nextParticipant = null;
  const nextSession = await updateSession(liveClassId, (session) => {
    const participants = Array.isArray(session.participants) ? session.participants.map(sanitizeParticipant) : [];
    const participant = participants.find((entry) => entry.userId === String(userId) && !entry.removed);
    if (!participant) {
      throw new ApiError(missingStatus, missingStatus === 404 ? 'Participant not found' : 'Participant is not active in this session', { code: missingCode });
    }

    nextParticipant = sanitizeParticipant(mutator(participant, session));
    return {
      participants: participants.map((entry) => (entry.userId === String(userId) ? nextParticipant : entry)),
      activePresenterId: nextParticipant.isPresenting || nextParticipant.isScreenSharing
        ? nextParticipant.userId
        : session.activePresenterId === String(userId) && !nextParticipant.isPresenting && !nextParticipant.isScreenSharing
          ? null
          : session.activePresenterId || null,
    };
  });

  return {
    participant: nextParticipant,
    session: nextSession,
  };
};

module.exports = {
  ensureSession,
  ensureLiveState,
  getSessionOrThrow,
  readLiveState,
  readSession,
  sanitizeParticipant,
  sanitizeSession,
  syncStatus,
  joinParticipant,
  leaveParticipant,
  heartbeat,
  updateParticipant,
  writeLiveState,
  buildLiveStateFromClass,
};
