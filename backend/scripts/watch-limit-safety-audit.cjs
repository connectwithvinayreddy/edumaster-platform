#!/usr/bin/env node

const {
  COURSE_VIDEO_TYPE,
  applyPlaybackHeartbeat,
  buildVideoWatchStateSummary,
  getDefaultVideoWatchState,
} = require('../lib/video-watch-limits.js');

const buildHeartbeat = (overrides = {}) => ({
  courseId: 'course-qa',
  lessonId: 'lesson-qa',
  videoId: 'video-qa',
  videoType: COURSE_VIDEO_TYPE,
  playbackSessionId: 'playback-1',
  previousPositionSeconds: 0,
  currentPositionSeconds: 0,
  durationSeconds: 100,
  isPlaying: true,
  isPaused: false,
  isBuffering: false,
  playbackRate: 1.5,
  timestamp: new Date(Number(overrides.serverNowMs || 0)).toISOString(),
  ...overrides,
});

const runScenario = (name, steps) => {
  let state = getDefaultVideoWatchState({
    userId: 'student-qa',
    courseId: 'course-qa',
    lessonId: 'lesson-qa',
    videoId: 'video-qa',
    videoType: COURSE_VIDEO_TYPE,
    videoDurationSeconds: 100,
  });

  const events = steps.map((step) => {
    const result = applyPlaybackHeartbeat(state, buildHeartbeat(step), { serverNowMs: step.serverNowMs });
    state = result.state;
    return {
      step,
      accepted: result.outcome.accepted,
      reason: result.outcome.reason,
      completedFullWatch: result.outcome.completedFullWatch,
      completedFullWatches: result.state.completedFullWatches,
      stableEndWindowWatchedSeconds: result.state.stableEndWindowWatchedSeconds,
      summary: buildVideoWatchStateSummary(result.state),
    };
  });

  return {
    name,
    events,
    finalSummary: buildVideoWatchStateSummary(state),
  };
};

const scenarios = [
  runScenario('watch-few-minutes-and-leave', [
    { previousPositionSeconds: 0, currentPositionSeconds: 5, serverNowMs: 2_000 },
    { previousPositionSeconds: 5, currentPositionSeconds: 18, serverNowMs: 12_000 },
  ]),
  runScenario('close-near-end-and-reopen', [
    { previousPositionSeconds: 0, currentPositionSeconds: 2, serverNowMs: 1_000 },
    { previousPositionSeconds: 2, currentPositionSeconds: 95, serverNowMs: 48_000 },
    { playbackSessionId: 'playback-2', previousPositionSeconds: 95, currentPositionSeconds: 95, serverNowMs: 50_000 },
    { playbackSessionId: 'playback-2', previousPositionSeconds: 95, currentPositionSeconds: 100, serverNowMs: 53_000 },
  ]),
  runScenario('true-near-end-completion', [
    { previousPositionSeconds: 0, currentPositionSeconds: 2, serverNowMs: 1_000 },
    { previousPositionSeconds: 2, currentPositionSeconds: 95, serverNowMs: 48_000 },
    { previousPositionSeconds: 95, currentPositionSeconds: 100, serverNowMs: 52_000 },
  ]),
  runScenario('duplicate-end-heartbeat', [
    { previousPositionSeconds: 0, currentPositionSeconds: 2, serverNowMs: 1_000 },
    { previousPositionSeconds: 2, currentPositionSeconds: 95, serverNowMs: 48_000 },
    { previousPositionSeconds: 95, currentPositionSeconds: 100, serverNowMs: 52_000 },
    { previousPositionSeconds: 95, currentPositionSeconds: 100, serverNowMs: 53_000 },
  ]),
];

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  scenarios,
}, null, 2));
