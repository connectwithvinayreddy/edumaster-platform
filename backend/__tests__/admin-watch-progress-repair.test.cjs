const test = require('node:test');
const assert = require('node:assert/strict');

const adminManagement = require('../admin/admin-management.service.js');
const { state, resetState } = require('../lib/store.js');

test.beforeEach(() => {
  resetState({
    videoWatchStates: [
      {
        _id: 'watch_1',
        userId: 'student-1',
        courseId: 'course-1',
        lessonId: 'lesson-1',
        videoId: 'video-1',
        videoType: 'course',
        videoDurationSeconds: 100,
        allowedFullWatches: 2,
        completedFullWatches: 2,
        fullWatchThresholdPercentage: 95,
        watchedSegments: [],
        currentCycleUniqueWatchedSeconds: 0,
        totalUniqueWatchedSeconds: 100,
        repeatWatchedSeconds: 50,
        revisionBufferSeconds: 50,
        revisionBufferUsedSeconds: 25,
        stableEndWindowWatchedSeconds: 0,
        completionProofSatisfiedAt: '2026-06-03T00:00:00.000Z',
        lastPositionSeconds: 14,
        playbackSessionId: 'playback-1',
        activeSessionStatus: 'locked',
        isLocked: true,
        lockedAt: '2026-06-03T00:10:00.000Z',
        updatedAt: '2026-06-03T00:10:00.000Z',
      },
      {
        _id: 'watch_2',
        userId: 'student-1',
        courseId: 'course-1',
        lessonId: 'lesson-2',
        videoId: 'video-2',
        videoType: 'course',
        videoDurationSeconds: 100,
        allowedFullWatches: 2,
        completedFullWatches: 1,
        fullWatchThresholdPercentage: 95,
        watchedSegments: [0, 1],
        currentCycleUniqueWatchedSeconds: 20,
        totalUniqueWatchedSeconds: 20,
        repeatWatchedSeconds: 0,
        revisionBufferSeconds: 50,
        revisionBufferUsedSeconds: 0,
        stableEndWindowWatchedSeconds: 0,
        completionProofSatisfiedAt: null,
        lastPositionSeconds: 20,
        playbackSessionId: 'playback-2',
        activeSessionStatus: 'active',
        isLocked: false,
        lockedAt: null,
        updatedAt: '2026-06-03T00:10:00.000Z',
      },
    ],
  });
});

test('grace unlock only repairs the targeted watch state', async () => {
  await adminManagement.resetWatchProgress({
    studentId: 'student-1',
    stateId: 'watch_1',
    adminUserId: 'admin-1',
    action: 'grace_unlock',
    reason: 'repair false lock',
  });

  const repaired = state.videoWatchStates.find((entry) => entry._id === 'watch_1');
  const untouched = state.videoWatchStates.find((entry) => entry._id === 'watch_2');

  assert.equal(repaired.completedFullWatches, 2);
  assert.equal(repaired.revisionBufferUsedSeconds, 0);
  assert.equal(repaired.isLocked, false);
  assert.equal(repaired.lockedAt, null);
  assert.equal(untouched.completedFullWatches, 1);
  assert.equal(untouched.lastPositionSeconds, 20);
});

test('completed watch repair clears only the counted-watch lock state for the targeted lesson', async () => {
  await adminManagement.resetWatchProgress({
    studentId: 'student-1',
    stateId: 'watch_1',
    adminUserId: 'admin-1',
    action: 'completed_watches',
    reason: 'repair false completion',
  });

  const repaired = state.videoWatchStates.find((entry) => entry._id === 'watch_1');

  assert.equal(repaired.completedFullWatches, 0);
  assert.equal(repaired.revisionBufferUsedSeconds, 0);
  assert.equal(repaired.totalUniqueWatchedSeconds, 100);
  assert.equal(repaired.lastPositionSeconds, 14);
  assert.equal(repaired.isLocked, false);
  assert.equal(repaired.completionProofSatisfiedAt, null);
});
