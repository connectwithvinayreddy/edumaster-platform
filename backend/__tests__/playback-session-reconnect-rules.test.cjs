const test = require('node:test');
const assert = require('node:assert/strict');

const { resetState } = require('../lib/store.js');
const { videoPlaybackRepository } = require('../lib/repositories.js');

const baseNowMs = new Date('2026-06-03T10:00:00.000Z').getTime();

const withFakeNow = async (nowMs, run) => {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await run();
  } finally {
    Date.now = originalNow;
  }
};

const requestContextFor = (deviceId, playbackTabId, userAgentHash = 'ua-same') => ({
  deviceId,
  playbackTabId,
  userAgentHash,
  userAgent: 'Mozilla/5.0 QA',
  browser: 'chrome',
  platform: 'windows',
  appMode: 'web',
});

const heartbeatPayload = (overrides = {}) => ({
  currentPositionSeconds: 5,
  previousPositionSeconds: 0,
  durationSeconds: 100,
  isPlaying: true,
  isPaused: false,
  isBuffering: false,
  playbackRate: 1,
  timestamp: new Date(Number(overrides.serverNowMs || baseNowMs)).toISOString(),
  ...overrides,
});

test.beforeEach(async () => {
  resetState({});
  await videoPlaybackRepository.clearActivePlaybackSession('student-reconnect');
  await videoPlaybackRepository.clearActivePlaybackSession('student-grace-expire');
  await videoPlaybackRepository.clearActivePlaybackSession('student-lesson-switch');
});

test('same device reconnect within 60 seconds reuses the active playback session and resume point', async () => {
  const first = await withFakeNow(baseNowMs, () => videoPlaybackRepository.startPlaybackSession({
    userId: 'student-reconnect',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-1'),
  }));

  await withFakeNow(baseNowMs + 5_000, () => videoPlaybackRepository.recordHeartbeat({
    userId: 'student-reconnect',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    playbackSessionId: first.playbackSession.playbackSessionId,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-1'),
    heartbeatPayload: heartbeatPayload({ serverNowMs: baseNowMs + 5_000 }),
  }));

  const reconnected = await withFakeNow(baseNowMs + 35_000, () => videoPlaybackRepository.startPlaybackSession({
    userId: 'student-reconnect',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-2'),
  }));

  assert.equal(reconnected.playbackSession.playbackSessionId, first.playbackSession.playbackSessionId);
  assert.equal(reconnected.watchState.lastPositionSeconds, 5);
});

test('active lesson session expires after 60 seconds and a new session starts cleanly', async () => {
  const first = await withFakeNow(baseNowMs, () => videoPlaybackRepository.startPlaybackSession({
    userId: 'student-grace-expire',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-1'),
  }));

  await withFakeNow(baseNowMs + 5_000, () => videoPlaybackRepository.recordHeartbeat({
    userId: 'student-grace-expire',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    playbackSessionId: first.playbackSession.playbackSessionId,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-1'),
    heartbeatPayload: heartbeatPayload({ serverNowMs: baseNowMs + 5_000 }),
  }));

  const restarted = await withFakeNow(baseNowMs + 66_000, () => videoPlaybackRepository.startPlaybackSession({
    userId: 'student-grace-expire',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-2'),
  }));

  assert.notEqual(restarted.playbackSession.playbackSessionId, first.playbackSession.playbackSessionId);
});

test('same device starting another lesson replaces the old active session instead of leaving it behind', async () => {
  const first = await withFakeNow(baseNowMs, () => videoPlaybackRepository.startPlaybackSession({
    userId: 'student-lesson-switch',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    videoId: 'video-1',
    videoType: 'course',
    videoDurationSeconds: 100,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-1'),
  }));

  const second = await withFakeNow(baseNowMs + 10_000, () => videoPlaybackRepository.startPlaybackSession({
    userId: 'student-lesson-switch',
    courseId: 'course-1',
    lessonId: 'lesson-2',
    videoId: 'video-2',
    videoType: 'course',
    videoDurationSeconds: 100,
    authSessionId: 'auth-1',
    requestContext: requestContextFor('device-1', 'tab-1'),
  }));

  const active = await withFakeNow(baseNowMs + 10_000, () => videoPlaybackRepository.getActivePlaybackSession('student-lesson-switch'));

  assert.notEqual(second.playbackSession.playbackSessionId, first.playbackSession.playbackSessionId);
  assert.equal(active.videoId, 'video-2');
  assert.equal(active.lessonId, 'lesson-2');
  assert.equal(active.playbackSessionId, second.playbackSession.playbackSessionId);
});
