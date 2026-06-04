const DEFAULT_CHUNK_SECONDS = 10;
const COURSE_VIDEO_TYPE = 'course';
const EXPLANATION_VIDEO_TYPE = 'explanation';
const EDITORIAL_VIDEO_TYPE = 'editorial';
const MAX_SUPPORTED_PLAYBACK_RATE = 2;
const DEFAULT_HEARTBEAT_GRACE_SECONDS = 3;
const DEFAULT_MAX_HEARTBEAT_GAP_SECONDS = 45;
const DEFAULT_END_STABILITY_WINDOW_SECONDS = 6;
const MAX_END_STABILITY_WINDOW_SECONDS = 12;
const MIN_COMPLETION_CLOSE_TOLERANCE_SECONDS = 1;
const MAX_COMPLETION_CLOSE_TOLERANCE_SECONDS = 3;

const VIDEO_TYPE_POLICIES = {
  [COURSE_VIDEO_TYPE]: {
    fullWatchThresholdPercentage: 95,
    allowedFullWatches: 2,
    revisionBufferPercentage: 50,
  },
  [EXPLANATION_VIDEO_TYPE]: {
    fullWatchThresholdPercentage: 95,
    allowedFullWatches: 1,
    revisionBufferPercentage: 50,
  },
  [EDITORIAL_VIDEO_TYPE]: {
    fullWatchThresholdPercentage: 95,
    allowedFullWatches: 1,
    revisionBufferPercentage: 50,
  },
};

const LEGACY_VIDEO_TYPE_POLICIES = {
  [COURSE_VIDEO_TYPE]: {
    fullWatchThresholdPercentage: 90,
  },
  [EXPLANATION_VIDEO_TYPE]: {
    fullWatchThresholdPercentage: 95,
  },
  [EDITORIAL_VIDEO_TYPE]: {
    fullWatchThresholdPercentage: 90,
  },
};

const clamp = (value, min, max) => Math.min(Math.max(Number(value || 0), min), max);

const roundSeconds = (value) => Math.max(0, Number(Number(value || 0).toFixed(3)));
const hasFiniteNumber = (value) => Number.isFinite(Number(value));

const normalizeVideoType = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === EXPLANATION_VIDEO_TYPE
    || normalized === 'test-explanation'
    || normalized === 'cbt-explanation'
    || normalized === 'mock-explanation'
    || normalized === 'test'
  ) {
    return EXPLANATION_VIDEO_TYPE;
  }

  if (normalized === EDITORIAL_VIDEO_TYPE || normalized === 'weekly-editorial') {
    return EDITORIAL_VIDEO_TYPE;
  }

  return COURSE_VIDEO_TYPE;
};

const getPolicyOptionsFromState = (state, options = {}) => ({
  ...options,
  allowedFullWatches: state?.allowedFullWatches ?? options.allowedFullWatches,
  fullWatchThresholdPercentage: hasFiniteNumber(state?.fullWatchThresholdPercentage)
    ? Number(state.fullWatchThresholdPercentage)
    : options.fullWatchThresholdPercentage,
  stateFullWatchThresholdPercentage: hasFiniteNumber(state?.fullWatchThresholdPercentage)
    ? Number(state.fullWatchThresholdPercentage)
    : options.stateFullWatchThresholdPercentage,
});

const resolveStoredThresholdPercentage = ({ normalizedVideoType, value, baseThresholdPercentage }) => {
  if (!hasFiniteNumber(value)) {
    return null;
  }
  const numericValue = Number(value);
  const legacyDefault = Number(LEGACY_VIDEO_TYPE_POLICIES[normalizedVideoType]?.fullWatchThresholdPercentage || baseThresholdPercentage);
  if (
    Math.abs(numericValue - legacyDefault) < 0.001
    && baseThresholdPercentage > legacyDefault
  ) {
    return null;
  }
  return numericValue;
};

const getVideoWatchPolicy = (videoType, durationSeconds, options = {}) => {
  const normalizedVideoType = normalizeVideoType(videoType);
  const base = VIDEO_TYPE_POLICIES[normalizedVideoType] || VIDEO_TYPE_POLICIES[COURSE_VIDEO_TYPE];
  const safeDurationSeconds = Math.max(Math.ceil(Number(durationSeconds || 0)), 1);
  const chunkSeconds = Math.max(Number(options.chunkSeconds || DEFAULT_CHUNK_SECONDS), 1);
  const explicitThresholdPercentage = hasFiniteNumber(options.fullWatchThresholdPercentage)
    ? Number(options.fullWatchThresholdPercentage)
    : null;
  const storedThresholdPercentage = resolveStoredThresholdPercentage({
    normalizedVideoType,
    value: options.stateFullWatchThresholdPercentage,
    baseThresholdPercentage: base.fullWatchThresholdPercentage,
  });
  const fullWatchThresholdPercentage = clamp(
    explicitThresholdPercentage ?? storedThresholdPercentage ?? base.fullWatchThresholdPercentage,
    50,
    100,
  );
  const allowedFullWatches = Math.max(
    1,
    Math.floor(
      Number.isFinite(Number(options.allowedFullWatches))
        ? Number(options.allowedFullWatches)
        : base.allowedFullWatches,
    ),
  );

  return {
    videoType: normalizedVideoType,
    videoDurationSeconds: safeDurationSeconds,
    chunkSeconds,
    fullWatchThresholdPercentage,
    fullWatchThresholdSeconds: roundSeconds(safeDurationSeconds * (fullWatchThresholdPercentage / 100)),
    allowedFullWatches,
    revisionBufferSeconds: roundSeconds(safeDurationSeconds * (base.revisionBufferPercentage / 100)),
    revisionBufferPercentage: base.revisionBufferPercentage,
    endStabilityWindowSeconds: clamp(
      Math.ceil(Number(options.endStabilityWindowSeconds || (safeDurationSeconds * 0.05) || DEFAULT_END_STABILITY_WINDOW_SECONDS)),
      DEFAULT_END_STABILITY_WINDOW_SECONDS,
      MAX_END_STABILITY_WINDOW_SECONDS,
    ),
    completionCloseToleranceSeconds: clamp(
      Number(options.completionCloseToleranceSeconds || 0) || Math.max(
        MIN_COMPLETION_CLOSE_TOLERANCE_SECONDS,
        Math.min(MAX_COMPLETION_CLOSE_TOLERANCE_SECONDS, Math.ceil(safeDurationSeconds * 0.01)),
      ),
      MIN_COMPLETION_CLOSE_TOLERANCE_SECONDS,
      MAX_COMPLETION_CLOSE_TOLERANCE_SECONDS,
    ),
    maxPlaybackRate: Math.max(Number(options.maxPlaybackRate || MAX_SUPPORTED_PLAYBACK_RATE), 1),
    heartbeatGraceSeconds: Math.max(Number(options.heartbeatGraceSeconds || DEFAULT_HEARTBEAT_GRACE_SECONDS), 0),
    maxHeartbeatGapSeconds: Math.max(Number(options.maxHeartbeatGapSeconds || DEFAULT_MAX_HEARTBEAT_GAP_SECONDS), 5),
  };
};

const getCompletionWindow = (policy) => ({
  endStabilityWindowSeconds: policy.endStabilityWindowSeconds,
  endWindowStartSeconds: Math.max(policy.videoDurationSeconds - policy.endStabilityWindowSeconds, 0),
  completionCloseToleranceSeconds: policy.completionCloseToleranceSeconds,
});

const getIntervalOverlapSeconds = (startSeconds, endSeconds, overlapStart, overlapEnd) => {
  const start = Math.max(Number(startSeconds || 0), Number(overlapStart || 0));
  const end = Math.min(Number(endSeconds || 0), Number(overlapEnd || 0));
  return roundSeconds(Math.max(end - start, 0));
};

const getStableEndWindowWatchedSeconds = (state, policy) => clamp(
  state?.stableEndWindowWatchedSeconds,
  0,
  policy.endStabilityWindowSeconds,
);

const isEndStabilitySatisfied = (state, policy) =>
  getStableEndWindowWatchedSeconds(state, policy) >= roundSeconds(policy.endStabilityWindowSeconds - 0.001);

const isCompletionProofSatisfied = (state, policy) => {
  const window = getCompletionWindow(policy);
  return (
    Number(state?.currentCycleUniqueWatchedSeconds || 0) >= policy.fullWatchThresholdSeconds
    && isEndStabilitySatisfied(state, policy)
    && Number(state?.lastPositionSeconds || 0) >= roundSeconds(policy.videoDurationSeconds - window.completionCloseToleranceSeconds)
  );
};

const getChunkCount = (durationSeconds, chunkSeconds = DEFAULT_CHUNK_SECONDS) =>
  Math.max(1, Math.ceil(Math.max(Number(durationSeconds || 0), 1) / Math.max(Number(chunkSeconds || DEFAULT_CHUNK_SECONDS), 1)));

const getChunkDurationSeconds = (chunkIndex, durationSeconds, chunkSeconds = DEFAULT_CHUNK_SECONDS) => {
  const safeChunkSeconds = Math.max(Number(chunkSeconds || DEFAULT_CHUNK_SECONDS), 1);
  const safeDurationSeconds = Math.max(Number(durationSeconds || 0), 1);
  const chunkStart = Math.max(Number(chunkIndex || 0), 0) * safeChunkSeconds;
  return Math.max(0, Math.min(safeChunkSeconds, safeDurationSeconds - chunkStart));
};

const sanitizeChunkIndexes = (chunks, durationSeconds, chunkSeconds = DEFAULT_CHUNK_SECONDS) => {
  const maxIndex = getChunkCount(durationSeconds, chunkSeconds) - 1;
  return [...new Set((Array.isArray(chunks) ? chunks : [])
    .map((chunk) => Number(chunk))
    .filter((chunk) => Number.isInteger(chunk) && chunk >= 0 && chunk <= maxIndex))]
    .sort((left, right) => left - right);
};

const computeCoveredSecondsFromChunks = (chunks, durationSeconds, chunkSeconds = DEFAULT_CHUNK_SECONDS) =>
  sanitizeChunkIndexes(chunks, durationSeconds, chunkSeconds)
    .reduce((total, chunkIndex) => total + getChunkDurationSeconds(chunkIndex, durationSeconds, chunkSeconds), 0);

const getChunkIndexesForInterval = (startSeconds, endSeconds, durationSeconds, chunkSeconds = DEFAULT_CHUNK_SECONDS) => {
  const safeDurationSeconds = Math.max(Number(durationSeconds || 0), 1);
  const safeChunkSeconds = Math.max(Number(chunkSeconds || DEFAULT_CHUNK_SECONDS), 1);
  const start = clamp(startSeconds, 0, safeDurationSeconds);
  const end = clamp(endSeconds, 0, safeDurationSeconds);

  if (end <= start) {
    return [];
  }

  const firstChunk = Math.floor(start / safeChunkSeconds);
  const lastChunk = Math.max(firstChunk, Math.ceil(end / safeChunkSeconds) - 1);
  const indexes = [];
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    indexes.push(index);
  }
  return sanitizeChunkIndexes(indexes, safeDurationSeconds, safeChunkSeconds);
};

const getDefaultVideoWatchState = ({
  userId = null,
  courseId = null,
  lessonId = null,
  videoId,
  videoType,
  videoDurationSeconds,
  chunkSeconds = DEFAULT_CHUNK_SECONDS,
  allowedFullWatches,
  fullWatchThresholdPercentage,
}) => {
  const policy = getVideoWatchPolicy(videoType, videoDurationSeconds, {
    chunkSeconds,
    allowedFullWatches,
    fullWatchThresholdPercentage,
  });

  return {
    _id: null,
    userId: userId ? String(userId) : null,
    courseId: courseId ? String(courseId) : null,
    lessonId: lessonId ? String(lessonId) : null,
    videoId: String(videoId),
    videoType: policy.videoType,
    videoDurationSeconds: policy.videoDurationSeconds,
    allowedFullWatches: policy.allowedFullWatches,
    completedFullWatches: 0,
    fullWatchThresholdPercentage: policy.fullWatchThresholdPercentage,
    watchedSegments: [],
    currentCycleUniqueWatchedSeconds: 0,
    totalUniqueWatchedSeconds: 0,
    repeatWatchedSeconds: 0,
    revisionBufferSeconds: policy.revisionBufferSeconds,
    revisionBufferUsedSeconds: 0,
    remainingRevisionBufferSeconds: policy.revisionBufferSeconds,
    stableEndWindowWatchedSeconds: 0,
    completionProofSatisfiedAt: null,
    lastPositionSeconds: 0,
    playbackSessionId: null,
    activeSessionStatus: 'idle',
    deviceId: null,
    ipAddress: null,
    userAgent: null,
    isLocked: false,
    lockedAt: null,
    lastHeartbeatAt: null,
    createdAt: null,
    updatedAt: null,
  };
};

const normalizeVideoWatchState = (state, options = {}) => {
  const base = {
    ...getDefaultVideoWatchState({
      userId: state?.userId || null,
      courseId: state?.courseId || null,
      lessonId: state?.lessonId || null,
      videoId: state?.videoId || options.videoId || '',
      videoType: state?.videoType || options.videoType || COURSE_VIDEO_TYPE,
      videoDurationSeconds: state?.videoDurationSeconds || options.videoDurationSeconds || 1,
      chunkSeconds: options.chunkSeconds || DEFAULT_CHUNK_SECONDS,
      allowedFullWatches: state?.allowedFullWatches ?? options.allowedFullWatches,
      fullWatchThresholdPercentage: options.fullWatchThresholdPercentage,
    }),
    ...(state || {}),
  };

  const policy = getVideoWatchPolicy(base.videoType, base.videoDurationSeconds, {
    chunkSeconds: options.chunkSeconds || DEFAULT_CHUNK_SECONDS,
    allowedFullWatches: base.allowedFullWatches ?? options.allowedFullWatches,
    fullWatchThresholdPercentage: options.fullWatchThresholdPercentage,
    stateFullWatchThresholdPercentage: base.fullWatchThresholdPercentage,
  });

  const watchedSegments = sanitizeChunkIndexes(base.watchedSegments, policy.videoDurationSeconds, policy.chunkSeconds);
  const completedFullWatches = Math.max(0, Math.floor(Number(base.completedFullWatches || 0)));
  const revisionBufferUsedSeconds = clamp(base.revisionBufferUsedSeconds, 0, policy.revisionBufferSeconds);
  const remainingRevisionBufferSeconds = roundSeconds(policy.revisionBufferSeconds - revisionBufferUsedSeconds);
  const graceCycleReached = completedFullWatches >= policy.allowedFullWatches;
  const canonicalWatchedSegments = graceCycleReached ? [] : watchedSegments;
  const currentCycleUniqueWatchedSeconds = graceCycleReached
    ? 0
    : computeCoveredSecondsFromChunks(
      canonicalWatchedSegments,
      policy.videoDurationSeconds,
      policy.chunkSeconds,
    );
  const stableEndWindowWatchedSeconds = graceCycleReached
    ? 0
    : getStableEndWindowWatchedSeconds(base, policy);
  const locked = (
    completedFullWatches >= policy.allowedFullWatches
    && remainingRevisionBufferSeconds <= 0
  );

  return {
    ...base,
    videoType: policy.videoType,
    videoDurationSeconds: policy.videoDurationSeconds,
    allowedFullWatches: policy.allowedFullWatches,
    fullWatchThresholdPercentage: policy.fullWatchThresholdPercentage,
    watchedSegments: canonicalWatchedSegments,
    currentCycleUniqueWatchedSeconds,
    totalUniqueWatchedSeconds: Math.max(Number(base.totalUniqueWatchedSeconds || 0), currentCycleUniqueWatchedSeconds),
    repeatWatchedSeconds: Math.max(Number(base.repeatWatchedSeconds || 0), 0),
    revisionBufferSeconds: policy.revisionBufferSeconds,
    revisionBufferUsedSeconds,
    remainingRevisionBufferSeconds,
    stableEndWindowWatchedSeconds,
    completionProofSatisfiedAt: base.completionProofSatisfiedAt || null,
    lastPositionSeconds: clamp(base.lastPositionSeconds, 0, policy.videoDurationSeconds),
    completedFullWatches,
    isLocked: locked,
    lockedAt: locked ? (base.lockedAt || new Date().toISOString()) : null,
  };
};

const deriveProtectedReplayState = (stateInput, options = {}) => {
  const state = normalizeVideoWatchState(stateInput, options);
  if (state.isLocked) {
    return 'locked';
  }

  if (state.completedFullWatches >= state.allowedFullWatches) {
    return 'grace_cycle';
  }

  if (
    Number(state.currentCycleUniqueWatchedSeconds || 0) > 0
    || Number(state.lastPositionSeconds || 0) > 0
  ) {
    return 'resume_current_cycle';
  }

  return 'restart_new_cycle';
};

const normalizeHeartbeatPayload = (payload, state, options = {}) => {
  const durationSeconds = Math.max(Number(payload?.durationSeconds || state?.videoDurationSeconds || options.videoDurationSeconds || 0), 1);
  const videoType = normalizeVideoType(payload?.videoType || state?.videoType || options.videoType);
  const playbackRate = Math.max(Number(payload?.playbackRate || 1), 0);
  const serverNowMs = Number(options.serverNowMs ?? Date.now());
  const clientTimestampMs = Number(new Date(payload?.timestamp || '').getTime() || 0);

  return {
    userId: payload?.userId ? String(payload.userId) : null,
    courseId: payload?.courseId ? String(payload.courseId) : null,
    lessonId: payload?.lessonId ? String(payload.lessonId) : null,
    videoId: String(payload?.videoId || state?.videoId || options.videoId || ''),
    videoType,
    playbackSessionId: payload?.playbackSessionId ? String(payload.playbackSessionId) : null,
    currentPositionSeconds: clamp(payload?.currentPositionSeconds, 0, durationSeconds),
    previousPositionSeconds: clamp(
      payload?.previousPositionSeconds ?? state?.lastPositionSeconds ?? 0,
      0,
      durationSeconds,
    ),
    durationSeconds,
    isPlaying: Boolean(payload?.isPlaying),
    isPaused: Boolean(payload?.isPaused),
    isBuffering: Boolean(payload?.isBuffering),
    playbackRate,
    timestamp: clientTimestampMs ? new Date(clientTimestampMs).toISOString() : new Date(serverNowMs).toISOString(),
    serverNowMs,
    deviceId: payload?.deviceId ? String(payload.deviceId) : null,
    userAgent: payload?.userAgent ? String(payload.userAgent) : null,
    ipAddress: payload?.ipAddress ? String(payload.ipAddress) : null,
  };
};

const validatePlaybackHeartbeat = (state, payload, options = {}) => {
  const policy = getVideoWatchPolicy(
    state.videoType,
    state.videoDurationSeconds,
    getPolicyOptionsFromState(state, options),
  );
  const heartbeat = normalizeHeartbeatPayload(payload, state, options);
  const suspiciousReasons = [];

  if (!heartbeat.isPlaying || heartbeat.isPaused || heartbeat.isBuffering) {
    return {
      ...heartbeat,
      accepted: false,
      countableSeconds: 0,
      intervalStartSeconds: heartbeat.previousPositionSeconds,
      intervalEndSeconds: heartbeat.previousPositionSeconds,
      reason: heartbeat.isBuffering ? 'buffering' : heartbeat.isPaused ? 'paused' : 'not-playing',
      suspiciousReasons,
    };
  }

  const playbackRate = heartbeat.playbackRate > 0 ? heartbeat.playbackRate : 1;
  if (playbackRate > policy.maxPlaybackRate) {
    suspiciousReasons.push('abnormal-playback-rate');
  }

  const lastHeartbeatMs = Number(new Date(state.lastHeartbeatAt || 0).getTime() || 0);
  const wallDeltaSeconds = lastHeartbeatMs > 0
    ? clamp((heartbeat.serverNowMs - lastHeartbeatMs) / 1000, 0, policy.maxHeartbeatGapSeconds)
    : null;
  const rawProgressDeltaSeconds = Number(
    (heartbeat.currentPositionSeconds - heartbeat.previousPositionSeconds).toFixed(3),
  );

  if (rawProgressDeltaSeconds <= 0) {
    return {
      ...heartbeat,
      accepted: false,
      countableSeconds: 0,
      intervalStartSeconds: heartbeat.previousPositionSeconds,
      intervalEndSeconds: heartbeat.previousPositionSeconds,
      reason: rawProgressDeltaSeconds < 0 ? 'seek-backward' : 'no-progress',
      suspiciousReasons,
    };
  }

  const progressDeltaSeconds = roundSeconds(rawProgressDeltaSeconds);

  if (wallDeltaSeconds === null) {
    return {
      ...heartbeat,
      accepted: false,
      countableSeconds: 0,
      intervalStartSeconds: heartbeat.previousPositionSeconds,
      intervalEndSeconds: heartbeat.previousPositionSeconds,
      reason: 'warmup-heartbeat',
      suspiciousReasons,
    };
  }

  const effectiveRate = Math.min(playbackRate, policy.maxPlaybackRate);
  const maxCountableDelta = roundSeconds((wallDeltaSeconds * effectiveRate) + policy.heartbeatGraceSeconds);
  if (progressDeltaSeconds > maxCountableDelta) {
    suspiciousReasons.push('seek-forward');
    return {
      ...heartbeat,
      accepted: false,
      countableSeconds: 0,
      intervalStartSeconds: heartbeat.previousPositionSeconds,
      intervalEndSeconds: heartbeat.previousPositionSeconds,
      reason: 'seek-forward',
      suspiciousReasons,
    };
  }

  const countableSeconds = roundSeconds(Math.min(progressDeltaSeconds, maxCountableDelta));
  const intervalEndSeconds = clamp(heartbeat.previousPositionSeconds + countableSeconds, 0, policy.videoDurationSeconds);

  return {
    ...heartbeat,
    accepted: countableSeconds > 0,
    countableSeconds,
    intervalStartSeconds: heartbeat.previousPositionSeconds,
    intervalEndSeconds,
    reason: countableSeconds > 0 ? 'counted' : 'no-progress',
    suspiciousReasons,
  };
};

const applyPlaybackHeartbeat = (stateInput, payload, options = {}) => {
  const state = normalizeVideoWatchState(stateInput, options);
  const policyOptions = getPolicyOptionsFromState(state, options);
  const policy = getVideoWatchPolicy(state.videoType, state.videoDurationSeconds, policyOptions);
  const heartbeat = validatePlaybackHeartbeat(state, payload, policyOptions);
  const completionWindow = getCompletionWindow(policy);
  const playbackSessionChanged = Boolean(
    state.playbackSessionId
    && heartbeat.playbackSessionId
    && String(state.playbackSessionId) !== String(heartbeat.playbackSessionId),
  );
  const shouldPersistHeartbeatPosition = heartbeat.accepted
    && !['seek-forward', 'no-progress', 'buffering', 'paused', 'not-playing', 'warmup-heartbeat'].includes(String(heartbeat.reason || ''));
  const nextState = {
    ...state,
    lastPositionSeconds: shouldPersistHeartbeatPosition
      ? clamp(heartbeat.currentPositionSeconds, 0, policy.videoDurationSeconds)
      : state.lastPositionSeconds,
    playbackSessionId: heartbeat.playbackSessionId || state.playbackSessionId || null,
    activeSessionStatus: state.isLocked ? 'locked' : (heartbeat.isPlaying ? 'active' : 'idle'),
    deviceId: heartbeat.deviceId || state.deviceId || null,
    ipAddress: heartbeat.ipAddress || state.ipAddress || null,
    userAgent: heartbeat.userAgent || state.userAgent || null,
    lastHeartbeatAt: new Date(heartbeat.serverNowMs).toISOString(),
    updatedAt: new Date(heartbeat.serverNowMs).toISOString(),
    stableEndWindowWatchedSeconds: state.stableEndWindowWatchedSeconds || 0,
    completionProofSatisfiedAt: state.completionProofSatisfiedAt || null,
  };

  const outcome = {
    accepted: heartbeat.accepted,
    reason: heartbeat.reason,
    countableSeconds: heartbeat.countableSeconds,
    uniqueSecondsAdded: 0,
    repeatSecondsAdded: 0,
    revisionBufferSecondsAdded: 0,
    completedFullWatch: false,
    endStabilitySatisfied: isEndStabilitySatisfied(nextState, policy),
    completionProofSatisfied: isCompletionProofSatisfied(nextState, policy),
    locked: state.isLocked,
    suspiciousReasons: heartbeat.suspiciousReasons,
  };

  if (state.isLocked) {
    nextState.activeSessionStatus = 'locked';
    nextState.stableEndWindowWatchedSeconds = 0;
    return { state: nextState, heartbeat, outcome };
  }

  if (!heartbeat.accepted || heartbeat.countableSeconds <= 0) {
    if (
      playbackSessionChanged
      || ['seek-backward', 'seek-forward', 'no-progress', 'buffering', 'paused', 'not-playing', 'warmup-heartbeat'].includes(String(heartbeat.reason || ''))
    ) {
      nextState.stableEndWindowWatchedSeconds = 0;
    }
    outcome.endStabilitySatisfied = isEndStabilitySatisfied(nextState, policy);
    outcome.completionProofSatisfied = isCompletionProofSatisfied(nextState, policy);
    return { state: nextState, heartbeat, outcome };
  }

  if (nextState.completedFullWatches >= policy.allowedFullWatches) {
    nextState.watchedSegments = [];
    nextState.currentCycleUniqueWatchedSeconds = 0;
    nextState.stableEndWindowWatchedSeconds = 0;
    const remainingRevisionBufferSeconds = Math.max(policy.revisionBufferSeconds - nextState.revisionBufferUsedSeconds, 0);
    const consumedRevisionSeconds = roundSeconds(Math.min(remainingRevisionBufferSeconds, heartbeat.countableSeconds));
    nextState.revisionBufferUsedSeconds = roundSeconds(nextState.revisionBufferUsedSeconds + consumedRevisionSeconds);
    nextState.remainingRevisionBufferSeconds = roundSeconds(Math.max(policy.revisionBufferSeconds - nextState.revisionBufferUsedSeconds, 0));
    nextState.repeatWatchedSeconds = roundSeconds(nextState.repeatWatchedSeconds + heartbeat.countableSeconds);
    outcome.repeatSecondsAdded = heartbeat.countableSeconds;
    outcome.revisionBufferSecondsAdded = consumedRevisionSeconds;
  } else {
    const existingChunks = new Set(nextState.watchedSegments);
    const intervalChunks = getChunkIndexesForInterval(
      heartbeat.intervalStartSeconds,
      heartbeat.intervalEndSeconds,
      policy.videoDurationSeconds,
      policy.chunkSeconds,
    );
    const uniqueChunksAdded = [];
    const repeatChunks = [];

    intervalChunks.forEach((chunkIndex) => {
      if (existingChunks.has(chunkIndex)) {
        repeatChunks.push(chunkIndex);
        return;
      }
      existingChunks.add(chunkIndex);
      uniqueChunksAdded.push(chunkIndex);
    });

    nextState.watchedSegments = [...existingChunks].sort((left, right) => left - right);
    outcome.uniqueSecondsAdded = computeCoveredSecondsFromChunks(
      uniqueChunksAdded,
      policy.videoDurationSeconds,
      policy.chunkSeconds,
    );
    outcome.repeatSecondsAdded = computeCoveredSecondsFromChunks(
      repeatChunks,
      policy.videoDurationSeconds,
      policy.chunkSeconds,
    );
    nextState.totalUniqueWatchedSeconds = roundSeconds(nextState.totalUniqueWatchedSeconds + outcome.uniqueSecondsAdded);
    nextState.repeatWatchedSeconds = roundSeconds(nextState.repeatWatchedSeconds + outcome.repeatSecondsAdded);
    nextState.currentCycleUniqueWatchedSeconds = computeCoveredSecondsFromChunks(
      nextState.watchedSegments,
      policy.videoDurationSeconds,
      policy.chunkSeconds,
    );

    const overlapInEndWindowSeconds = getIntervalOverlapSeconds(
      heartbeat.intervalStartSeconds,
      heartbeat.intervalEndSeconds,
      completionWindow.endWindowStartSeconds,
      policy.videoDurationSeconds,
    );
    if (overlapInEndWindowSeconds > 0) {
      const priorStableEndWindowWatchedSeconds = playbackSessionChanged
        ? 0
        : getStableEndWindowWatchedSeconds(nextState, policy);
      nextState.stableEndWindowWatchedSeconds = roundSeconds(Math.min(
        policy.endStabilityWindowSeconds,
        priorStableEndWindowWatchedSeconds + overlapInEndWindowSeconds,
      ));
    } else if (nextState.stableEndWindowWatchedSeconds > 0) {
      nextState.stableEndWindowWatchedSeconds = 0;
    }

    if (
      isCompletionProofSatisfied(nextState, policy)
      && nextState.completedFullWatches < policy.allowedFullWatches
    ) {
      nextState.completedFullWatches += 1;
      nextState.completionProofSatisfiedAt = new Date(heartbeat.serverNowMs).toISOString();
      nextState.watchedSegments = [];
      nextState.currentCycleUniqueWatchedSeconds = 0;
      nextState.stableEndWindowWatchedSeconds = 0;
      nextState.lastPositionSeconds = 0;
      outcome.completedFullWatch = true;
    }

    nextState.remainingRevisionBufferSeconds = roundSeconds(
      Math.max(policy.revisionBufferSeconds - nextState.revisionBufferUsedSeconds, 0),
    );
  }

  const shouldLock = nextState.completedFullWatches >= policy.allowedFullWatches
    && nextState.remainingRevisionBufferSeconds <= 0;

  if (shouldLock) {
    nextState.isLocked = true;
    nextState.lockedAt = nextState.lockedAt || new Date(heartbeat.serverNowMs).toISOString();
    nextState.activeSessionStatus = 'locked';
    outcome.locked = true;
  } else {
    outcome.locked = false;
  }

  outcome.endStabilitySatisfied = isEndStabilitySatisfied(nextState, policy);
  outcome.completionProofSatisfied = isCompletionProofSatisfied(nextState, policy);

  return { state: nextState, heartbeat, outcome };
};

const buildVideoWatchStateSummary = (stateInput, options = {}) => {
  const state = normalizeVideoWatchState(stateInput, options);
  const replayState = deriveProtectedReplayState(state, options);
  const policy = getVideoWatchPolicy(state.videoType, state.videoDurationSeconds, {
    chunkSeconds: options.chunkSeconds || DEFAULT_CHUNK_SECONDS,
    allowedFullWatches: state.allowedFullWatches,
    stateFullWatchThresholdPercentage: state.fullWatchThresholdPercentage,
  });
  return {
    videoType: state.videoType,
    allowedFullWatches: state.allowedFullWatches,
    completedFullWatches: state.completedFullWatches,
    fullWatchThresholdPercentage: state.fullWatchThresholdPercentage,
    completionThresholdPercentage: state.fullWatchThresholdPercentage,
    currentCycleUniqueWatchedSeconds: state.currentCycleUniqueWatchedSeconds,
    totalUniqueWatchedSeconds: state.totalUniqueWatchedSeconds,
    repeatWatchedSeconds: state.repeatWatchedSeconds,
    revisionBufferSeconds: state.revisionBufferSeconds,
    revisionBufferUsedSeconds: state.revisionBufferUsedSeconds,
    remainingRevisionBufferSeconds: state.remainingRevisionBufferSeconds,
    stableEndWindowWatchedSeconds: state.stableEndWindowWatchedSeconds || 0,
    completionProofSatisfied: isCompletionProofSatisfied(state, policy),
    completionProofSatisfiedAt: state.completionProofSatisfiedAt || null,
    endStabilityWindowSeconds: policy.endStabilityWindowSeconds,
    endStabilitySatisfied: isEndStabilitySatisfied(state, policy),
    graceTotalSeconds: state.revisionBufferSeconds,
    graceUsedSeconds: state.revisionBufferUsedSeconds,
    graceRemainingSeconds: state.remainingRevisionBufferSeconds,
    replayState,
    locked: Boolean(state.isLocked),
    lockedAt: state.lockedAt || null,
  };
};

module.exports = {
  COURSE_VIDEO_TYPE,
  EXPLANATION_VIDEO_TYPE,
  EDITORIAL_VIDEO_TYPE,
  DEFAULT_CHUNK_SECONDS,
  MAX_SUPPORTED_PLAYBACK_RATE,
  normalizeVideoType,
  getVideoWatchPolicy,
  getChunkCount,
  getChunkIndexesForInterval,
  computeCoveredSecondsFromChunks,
  getDefaultVideoWatchState,
  normalizeVideoWatchState,
  normalizeHeartbeatPayload,
  validatePlaybackHeartbeat,
  applyPlaybackHeartbeat,
  deriveProtectedReplayState,
  buildVideoWatchStateSummary,
};
