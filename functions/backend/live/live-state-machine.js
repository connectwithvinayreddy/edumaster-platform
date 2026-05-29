const { ApiError } = require('../lib/http.js');

const LIVE_STATUS_GRAPH = {
  scheduled: new Set(['scheduled', 'starting', 'ingest_connected', 'playback_ready', 'live', 'failed']),
  starting: new Set(['starting', 'ingest_connected', 'playback_ready', 'live', 'failed']),
  ingest_connected: new Set(['ingest_connected', 'playback_ready', 'live', 'failed']),
  playback_ready: new Set(['playback_ready', 'live', 'failed']),
  live: new Set(['live', 'ending', 'ended', 'failed']),
  ending: new Set(['ending', 'ended', 'failed']),
  ended: new Set(['ended', 'recording_processing', 'replay_ready', 'failed']),
  recording_processing: new Set(['recording_processing', 'replay_ready', 'failed']),
  replay_ready: new Set(['replay_ready', 'failed']),
  failed: new Set(['failed']),
};

const normalizeLiveStatus = (value, fallback = 'scheduled') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'upcoming') {
    return 'scheduled';
  }
  return normalized;
};

const canTransitionLiveStatus = (currentStatus, nextStatus) => {
  const current = normalizeLiveStatus(currentStatus);
  const next = normalizeLiveStatus(nextStatus);
  const allowed = LIVE_STATUS_GRAPH[current];
  if (!allowed) {
    return current === next;
  }
  return allowed.has(next);
};

const assertLiveStatusTransition = (currentStatus, nextStatus) => {
  if (canTransitionLiveStatus(currentStatus, nextStatus)) {
    return;
  }

  throw new ApiError(409, `Cannot transition live session from ${currentStatus || 'unknown'} to ${nextStatus || 'unknown'}`, {
    code: 'LIVE_STATUS_TRANSITION_INVALID',
    details: {
      currentStatus: normalizeLiveStatus(currentStatus),
      nextStatus: normalizeLiveStatus(nextStatus),
    },
  });
};

module.exports = {
  LIVE_STATUS_GRAPH,
  normalizeLiveStatus,
  canTransitionLiveStatus,
  assertLiveStatusTransition,
};
