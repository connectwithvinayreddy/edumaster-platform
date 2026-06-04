export type UnexpectedProtectedHlsPauseInput = {
  protectedHlsStabilityMode: boolean;
  activeDeliveryPath?: string | null;
  firstFrameReached: boolean;
  stableFirstFrameReached?: boolean;
  currentTimeSeconds: number;
  stableCurrentTimeSeconds?: number;
  ended: boolean;
  bufferedAheadSeconds: number;
  readyState: number;
  hasHlsRuntime: boolean;
  playbackBlocked: boolean;
  terminalPlaybackError: boolean;
  shouldBeActivelyPlaying: boolean;
  expectedPauseActive: boolean;
  recentUserPlaybackIntent: boolean;
};

const READY_STATE_HAVE_FUTURE_DATA = 3;
const STARTUP_FIRST_FRAME_THRESHOLD_SECONDS = 0.35;

export const shouldTreatProtectedHlsPauseAsUnexpected = (
  input: UnexpectedProtectedHlsPauseInput,
) => {
  const meaningfulProgress = Boolean(
    input.firstFrameReached
      || input.stableFirstFrameReached
      || Math.max(
        Number(input.currentTimeSeconds || 0),
        Number(input.stableCurrentTimeSeconds || 0),
        0,
      ) >= STARTUP_FIRST_FRAME_THRESHOLD_SECONDS,
  );
  const isProtectedHls = Boolean(
    input.protectedHlsStabilityMode
      || String(input.activeDeliveryPath || '').trim().toLowerCase() === 'protected_hls_gateway',
  );
  const hasRecoverableMedia = Boolean(
    Number(input.bufferedAheadSeconds || 0) > 0.25
      || Number(input.readyState || 0) >= READY_STATE_HAVE_FUTURE_DATA
      || input.hasHlsRuntime,
  );

  return Boolean(
    isProtectedHls
      && meaningfulProgress
      && !input.ended
      && !input.playbackBlocked
      && !input.terminalPlaybackError
      && input.shouldBeActivelyPlaying
      && !input.expectedPauseActive
      && !input.recentUserPlaybackIntent
      && hasRecoverableMedia,
  );
};
