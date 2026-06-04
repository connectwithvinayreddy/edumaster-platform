import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldTreatProtectedHlsPauseAsUnexpected } from './unexpectedPauseRecovery.js';

const createBaseInput = () => ({
  protectedHlsStabilityMode: true,
  activeDeliveryPath: 'protected_hls_gateway',
  firstFrameReached: true,
  stableFirstFrameReached: true,
  currentTimeSeconds: 38.359,
  stableCurrentTimeSeconds: 38.359,
  ended: false,
  bufferedAheadSeconds: 8,
  readyState: 4,
  hasHlsRuntime: true,
  playbackBlocked: false,
  terminalPlaybackError: false,
  shouldBeActivelyPlaying: true,
  expectedPauseActive: false,
  recentUserPlaybackIntent: false,
});

test('treats protected hls pause after meaningful progress as unexpected', () => {
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected(createBaseInput()),
    true,
  );
});

test('does not treat explicit user pause as unexpected', () => {
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected({
      ...createBaseInput(),
      expectedPauseActive: true,
    }),
    false,
  );
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected({
      ...createBaseInput(),
      recentUserPlaybackIntent: true,
    }),
    false,
  );
});

test('does not treat ended playback as unexpected', () => {
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected({
      ...createBaseInput(),
      ended: true,
    }),
    false,
  );
});

test('does not auto recover when playback is blocked or terminally failed', () => {
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected({
      ...createBaseInput(),
      playbackBlocked: true,
    }),
    false,
  );
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected({
      ...createBaseInput(),
      terminalPlaybackError: true,
    }),
    false,
  );
});

test('does not auto recover if there is no buffered or attached hls media to resume', () => {
  assert.equal(
    shouldTreatProtectedHlsPauseAsUnexpected({
      ...createBaseInput(),
      bufferedAheadSeconds: 0,
      readyState: 1,
      hasHlsRuntime: false,
    }),
    false,
  );
});
