const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COURSE_VIDEO_TYPE,
  applyPlaybackHeartbeat,
  deriveProtectedReplayState,
  getDefaultVideoWatchState,
  normalizeVideoWatchState,
} = require('../lib/video-watch-limits.js');

const buildHeartbeat = (overrides = {}) => ({
  courseId: 'course-1',
  lessonId: 'lesson-1',
  videoId: 'video-1',
  videoType: COURSE_VIDEO_TYPE,
  playbackSessionId: 'playback-1',
  previousPositionSeconds: 0,
  currentPositionSeconds: 0,
  durationSeconds: 100,
  isPlaying: true,
  isPaused: false,
  isBuffering: false,
  playbackRate: 2,
  timestamp: new Date(Number(overrides.serverNowMs || 0)).toISOString(),
  ...overrides,
});

const completeWatchCycle = (initialState, {
  playbackSessionId = 'playback-1',
  startMs = 0,
} = {}) => {
  const warmup = applyPlaybackHeartbeat(initialState, buildHeartbeat({
    playbackSessionId,
    previousPositionSeconds: 0,
    currentPositionSeconds: 2,
    serverNowMs: startMs + 1_000,
  }), { serverNowMs: startMs + 1_000 });
  const nearEnd = applyPlaybackHeartbeat(warmup.state, buildHeartbeat({
    playbackSessionId,
    previousPositionSeconds: 2,
    currentPositionSeconds: 95,
    serverNowMs: startMs + 49_000,
  }), { serverNowMs: startMs + 49_000 });
  const stabilize = applyPlaybackHeartbeat(nearEnd.state, buildHeartbeat({
    playbackSessionId,
    previousPositionSeconds: 95,
    currentPositionSeconds: 100,
    serverNowMs: startMs + 52_000,
  }), { serverNowMs: startMs + 52_000 });
  return {
    warmup,
    nearEnd,
    stabilize,
  };
};

test('course videos restart from zero after a counted completion', () => {
  const initialState = getDefaultVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  });

  const completed = completeWatchCycle(initialState).stabilize;

  assert.equal(completed.state.completedFullWatches, 1);
  assert.equal(completed.state.lastPositionSeconds, 0);
  assert.equal(deriveProtectedReplayState(completed.state), 'restart_new_cycle');
  assert.equal(completed.state.revisionBufferSeconds, 50);
  assert.equal(completed.state.isLocked, false);
});

test('partial watches across sessions never count as a completed watch', () => {
  const initialState = getDefaultVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  });

  const warmup = applyPlaybackHeartbeat(initialState, buildHeartbeat({
    playbackSessionId: 'playback-1',
    previousPositionSeconds: 0,
    currentPositionSeconds: 0,
    serverNowMs: 1_000,
  }), { serverNowMs: 1_000 });
  const firstShortWatch = applyPlaybackHeartbeat(warmup.state, buildHeartbeat({
    playbackSessionId: 'playback-1',
    previousPositionSeconds: 0,
    currentPositionSeconds: 20,
    serverNowMs: 11_000,
  }), { serverNowMs: 11_000 });
  const reopenedWarmup = applyPlaybackHeartbeat(firstShortWatch.state, buildHeartbeat({
    playbackSessionId: 'playback-2',
    previousPositionSeconds: 20,
    currentPositionSeconds: 20,
    serverNowMs: 20_000,
  }), { serverNowMs: 20_000 });
  const secondShortWatch = applyPlaybackHeartbeat(reopenedWarmup.state, buildHeartbeat({
    playbackSessionId: 'playback-2',
    previousPositionSeconds: 20,
    currentPositionSeconds: 40,
    serverNowMs: 30_000,
  }), { serverNowMs: 30_000 });

  assert.equal(secondShortWatch.state.completedFullWatches, 0);
  assert.equal(secondShortWatch.outcome.completedFullWatch, false);
});

test('reaching the 95 percent threshold without the stable end window does not count a watch', () => {
  const initialState = getDefaultVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  });

  const warmup = applyPlaybackHeartbeat(initialState, buildHeartbeat({
    previousPositionSeconds: 0,
    currentPositionSeconds: 0,
    serverNowMs: 1_000,
  }), { serverNowMs: 1_000 });
  const nearEndOnly = applyPlaybackHeartbeat(warmup.state, buildHeartbeat({
    previousPositionSeconds: 0,
    currentPositionSeconds: 95,
    serverNowMs: 49_000,
  }), { serverNowMs: 49_000 });

  assert.equal(nearEndOnly.state.completedFullWatches, 0);
  assert.equal(nearEndOnly.outcome.completedFullWatch, false);
  assert.equal(nearEndOnly.outcome.completionProofSatisfied, false);
});

test('refreshing near the end still requires a fresh stable end window before counting a watch', () => {
  const initialState = getDefaultVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  });

  const warmup = applyPlaybackHeartbeat(initialState, buildHeartbeat({
    playbackSessionId: 'playback-1',
    previousPositionSeconds: 0,
    currentPositionSeconds: 0,
    serverNowMs: 1_000,
  }), { serverNowMs: 1_000 });
  const firstNearEnd = applyPlaybackHeartbeat(warmup.state, buildHeartbeat({
    playbackSessionId: 'playback-1',
    previousPositionSeconds: 0,
    currentPositionSeconds: 95,
    serverNowMs: 49_000,
  }), { serverNowMs: 49_000 });
  const reopenedWarmup = applyPlaybackHeartbeat(firstNearEnd.state, buildHeartbeat({
    playbackSessionId: 'playback-2',
    previousPositionSeconds: 95,
    currentPositionSeconds: 95,
    serverNowMs: 50_500,
  }), { serverNowMs: 50_500 });
  const resumedNearEnd = applyPlaybackHeartbeat(reopenedWarmup.state, buildHeartbeat({
    playbackSessionId: 'playback-2',
    previousPositionSeconds: 95,
    currentPositionSeconds: 100,
    serverNowMs: 53_500,
  }), { serverNowMs: 53_500 });

  assert.equal(resumedNearEnd.state.completedFullWatches, 0);
  assert.equal(resumedNearEnd.outcome.completedFullWatch, false);
});

test('duplicate end heartbeats do not double count a completed watch', () => {
  const initialState = getDefaultVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  });

  const { stabilize } = completeWatchCycle(initialState);
  const duplicateEndHeartbeat = applyPlaybackHeartbeat(stabilize.state, buildHeartbeat({
    playbackSessionId: 'playback-1',
    previousPositionSeconds: 95,
    currentPositionSeconds: 100,
    serverNowMs: 54_000,
  }), { serverNowMs: 54_000 });

  assert.equal(stabilize.state.completedFullWatches, 1);
  assert.equal(duplicateEndHeartbeat.state.completedFullWatches, 1);
  assert.equal(duplicateEndHeartbeat.outcome.completedFullWatch, false);
});

test('legacy locked course states unlock into grace replay under the safer policy', () => {
  const normalized = normalizeVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
    completedFullWatches: 2,
    revisionBufferUsedSeconds: 0,
    isLocked: true,
    lockedAt: '2026-06-02T00:00:00.000Z',
  });

  assert.equal(normalized.isLocked, false);
  assert.equal(normalized.remainingRevisionBufferSeconds, 50);
  assert.equal(deriveProtectedReplayState(normalized), 'grace_cycle');
});

test('seek-forward heartbeats do not become the next protected resume position during grace replay', () => {
  const graceState = normalizeVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
    completedFullWatches: 2,
    revisionBufferUsedSeconds: 10,
    lastPositionSeconds: 12,
    lastHeartbeatAt: new Date(1_000).toISOString(),
  });

  const result = applyPlaybackHeartbeat(graceState, buildHeartbeat({
    previousPositionSeconds: 12,
    currentPositionSeconds: 90,
    serverNowMs: 5_000,
    timestamp: new Date(5_000).toISOString(),
  }), { serverNowMs: 5_000 });

  assert.equal(result.heartbeat.reason, 'seek-forward');
  assert.equal(result.outcome.accepted, false);
  assert.equal(result.state.lastPositionSeconds, 12);
  assert.equal(result.state.revisionBufferUsedSeconds, 10);
  assert.equal(deriveProtectedReplayState(result.state), 'grace_cycle');
});

test('course videos lock only after the grace window is exhausted', () => {
  const almostLocked = normalizeVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
    completedFullWatches: 2,
    revisionBufferUsedSeconds: 49,
    lastPositionSeconds: 10,
    lastHeartbeatAt: new Date(1_000).toISOString(),
  });

  const result = applyPlaybackHeartbeat(almostLocked, buildHeartbeat({
    previousPositionSeconds: 10,
    currentPositionSeconds: 12,
    serverNowMs: 3_000,
    timestamp: new Date(3_000).toISOString(),
  }), { serverNowMs: 3_000 });

  assert.equal(result.outcome.accepted, true);
  assert.equal(result.state.revisionBufferUsedSeconds, 50);
  assert.equal(result.state.remainingRevisionBufferSeconds, 0);
  assert.equal(result.state.isLocked, true);
  assert.equal(deriveProtectedReplayState(result.state), 'locked');
});

test('the final counted watch enters grace replay instead of locking immediately', () => {
  const firstCycle = completeWatchCycle(getDefaultVideoWatchState({
    userId: 'user-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  }), { playbackSessionId: 'playback-1', startMs: 0 }).stabilize.state;

  const secondCycle = completeWatchCycle(firstCycle, {
    playbackSessionId: 'playback-2',
    startMs: 60_000,
  }).stabilize;

  assert.equal(secondCycle.state.completedFullWatches, 2);
  assert.equal(secondCycle.state.isLocked, false);
  assert.equal(secondCycle.state.remainingRevisionBufferSeconds, 50);
  assert.equal(deriveProtectedReplayState(secondCycle.state), 'grace_cycle');
});
