import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { LoaderCircle } from 'lucide-react';
import { ApiRequestError, EduService } from '../EduService';
import { loadHlsRuntime, type HlsRuntimeInstance, type HlsRuntimeLevel } from '../lib/hlsRuntime';
import {
  classifyRecordedVideoDeliveryPath,
  type RecordedVideoDeliveryPath,
} from '../lib/recordedVideoDelivery';
import { cn } from '../lib/utils';
import { type ProtectedPlaybackDrmConfig } from '../types';
import {
  applyPreferredStartupLevel,
  createProtectedVodHlsConfig,
  getDefaultRecordedVideoQualityHeight,
  getConnectionStrength,
  getRecordedVideoQualityLevel,
  getRecordedVideoQualityOptions,
  scheduleAutoLevelRelease,
  shouldFallbackToSourceFromHlsError,
  type RecordedVideoQualityOption,
} from '../lib/hlsPlaybackTuning';

type ResilientHlsVideoProps = {
  src: string;
  title: string;
  watermarkText?: string | null;
  streamFormat?: 'source' | 'hls' | string | null;
  deliveryProfile?: string | null;
  deliveryPathHint?: RecordedVideoDeliveryPath | null;
  drmConfig?: ProtectedPlaybackDrmConfig | null;
  trackVideoId?: string | null;
  trackCourseId?: string | null;
  trackLessonId?: string | null;
  trackVideoType?: 'course' | 'explanation' | string | null;
  playbackSessionId?: string | null;
  className?: string;
  autoPlay?: boolean;
  resumeSeconds?: number;
  playbackSpeed?: number;
  selectedQualityHeight?: number;
  defaultQualityHeight?: number;
  nativeControls?: boolean;
  onQualityOptionsChange?: (options: RecordedVideoQualityOption[]) => void;
  onProgress?: (progressSeconds: number, durationSeconds: number, completed: boolean) => void;
  onReady?: () => void;
  onPlaybackStateChange?: (state: { playing: boolean; ended?: boolean; waiting?: boolean }) => void;
};

export type ResilientHlsVideoHandle = {
  play: () => Promise<boolean>;
  pause: () => void;
  retry: () => void;
  seekTo: (seconds: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
};

type FragmentLoadStats = {
  loaded?: number;
  loading?: {
    start?: number;
    end?: number;
  };
};

type FragmentWithOptionalStats = {
  url?: string;
  level?: number;
  duration?: number;
  stats?: FragmentLoadStats;
};

type ShakaPlayerInstance = {
  destroy(): Promise<unknown>;
  getNetworkingEngine(): {
    registerRequestFilter: (
      filter: (_type: unknown, request: { headers?: Record<string, string> }) => void,
    ) => void;
  } | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  configure(config: Record<string, unknown>): void;
  load(source: string): Promise<unknown>;
};

type ShakaRuntimeModule = {
  default: {
    polyfill: {
      installAll(): void;
    };
    Player: {
      new(video: HTMLMediaElement): ShakaPlayerInstance;
      isBrowserSupported(): boolean;
    };
  };
};

type StablePlaybackSnapshot = {
  currentTime: number;
  durationSeconds: number;
  selectedQualityHeight: number | null;
  deliveryPath: RecordedVideoDeliveryPath | null;
  deliveryProfile: string | null;
  firstFrameReached: boolean;
  updatedAt: number;
};

const RETRY_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 30_000;
const STARTUP_TIMEOUT_MS = 35_000;
const STARTUP_TIMEOUT_PROGRESS_GRACE_MS = 12_000;
const STARTUP_TIMEOUT_DEFER_MS = 10_000;
const STARTUP_FIRST_FRAME_THRESHOLD_SECONDS = 0.35;
const MAX_AUTO_RETRIES = 3;
const MAX_HLS_NATIVE_RECOVERY_ATTEMPTS = 2;
const MAX_PROTECTED_SESSION_REBOOTSTRAPS = 1;
const PROTECTED_HLS_WARMUP_MS = 15_000;
const READY_STATE_HAVE_FUTURE_DATA = 3;
const LIVE_RESUME_PERSIST_EPSILON_SECONDS = 1;
const LIVE_RESUME_PERSIST_STEP_SECONDS = 5;
const HLS_BUFFER_STALLED_ERROR = 'bufferStalledError';
const HLS_MEDIA_ERROR = 'mediaError';
const HLS_NETWORK_ERROR = 'networkError';

let shakaRuntimePromise: Promise<ShakaRuntimeModule> | null = null;

const isDirectVideoSource = (value: string) => {
  const normalized = String(value || '').toLowerCase();
  return /\.(mp4|webm|mov)(\?|$)/.test(normalized);
};

const loadShakaRuntime = () => {
  if (!shakaRuntimePromise) {
    shakaRuntimePromise = import('shaka-player') as Promise<ShakaRuntimeModule>;
  }
  return shakaRuntimePromise;
};

const getClientPlatform = () => {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform();
  }

  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'android';
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'macos';
  if (ua.includes('windows')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
};

const getClientBrowser = () => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'opera';
  if (ua.includes('firefox/') || ua.includes('fxios/')) return 'firefox';
  if (ua.includes('crios/') || ua.includes('chrome/')) return 'chrome';
  if (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('crios/') && !ua.includes('android')) return 'safari';
  return 'unknown';
};

const getProtectedPlaybackHeaders = () => {
  const playbackTabId = EduService.getPlaybackTabId();
  return {
    'x-edumaster-device-id': EduService.getPersistentDeviceId(),
    'x-edumaster-playback-tab-id': playbackTabId,
    'x-edumaster-browser-tab-id': playbackTabId,
    'x-edumaster-client-platform': getClientPlatform(),
    'x-edumaster-client-browser': getClientBrowser(),
    'x-edumaster-app': Capacitor.isNativePlatform() ? 'capacitor' : 'web',
  };
};

const buildPlaybackResumeKey = (params: {
  trackCourseId?: string | null;
  trackLessonId?: string | null;
  trackVideoId?: string | null;
  src: string;
}) => {
  const stableIdentityParts = [
    params.trackCourseId || '',
    params.trackLessonId || '',
    params.trackVideoId || '',
  ].filter(Boolean);
  const stableParts = stableIdentityParts.length
    ? stableIdentityParts
    : [params.src || 'no-src'];
  return `edumaster.playback.live-resume.${stableParts.join('::')}`;
};

const buildDrmConfigSignature = (drmConfig?: ProtectedPlaybackDrmConfig | null) => {
  if (!drmConfig?.enabled) {
    return 'drm:disabled';
  }

  const sortedLicenseServers = Object.entries(drmConfig.licenseServers || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join('|');

  return JSON.stringify({
    enabled: true,
    provider: drmConfig.provider || null,
    manifestUrl: drmConfig.manifestUrl || null,
    manifestFormat: drmConfig.manifestFormat || null,
    preferredKeySystem: drmConfig.preferredKeySystem || null,
    fairplayCertificateUrl: drmConfig.fairplayCertificateUrl || null,
    licenseServers: sortedLicenseServers,
  });
};

const getBufferedAheadSeconds = (video: HTMLVideoElement | null) => {
  if (!video || !video.buffered || video.buffered.length <= 0) {
    return 0;
  }

  const currentTime = Math.max(Number(video.currentTime || 0), 0);
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = Number(video.buffered.start(index) || 0);
    const end = Number(video.buffered.end(index) || 0);
    if (currentTime >= Math.max(start - 0.25, 0) && currentTime <= end) {
      return Math.max(end - currentTime, 0);
    }
  }

  return 0;
};

export const ResilientHlsVideo = forwardRef<ResilientHlsVideoHandle, ResilientHlsVideoProps>(({
  src,
  title,
  watermarkText: _watermarkText = null,
  streamFormat = null,
  deliveryProfile = null,
  deliveryPathHint = null,
  drmConfig = null,
  trackVideoId = null,
  trackCourseId = null,
  trackLessonId = null,
  trackVideoType = 'course',
  playbackSessionId = null,
  className,
  autoPlay = false,
  resumeSeconds = 0,
  playbackSpeed = 1,
  selectedQualityHeight,
  defaultQualityHeight = 480,
  nativeControls = true,
  onQualityOptionsChange,
  onProgress,
  onReady,
  onPlaybackStateChange,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<HlsRuntimeInstance | null>(null);
  const shakaPlayerRef = useRef<ShakaPlayerInstance | null>(null);
  const mediaCleanupRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);
  const startupTimeoutRef = useRef<number | null>(null);
  const attachGenerationRef = useRef(0);
  const isMountedRef = useRef(false);
  const isPlayingRef = useRef(false);
  const lastHeartbeatPositionRef = useRef<number>(Math.max(Number(resumeSeconds || 0), 0));
  const startupStartedAtRef = useRef(0);
  const startupReportedRef = useRef(false);
  const bufferingStartedAtRef = useRef<number | null>(null);
  const totalBufferMsRef = useRef(0);
  const startupProgressAtRef = useRef(0);
  const startupProgressPhaseRef = useRef<string>('idle');
  const firstFrameReachedRef = useRef(false);
  const startupNativeRecoveryCountRef = useRef(0);
  const startupNativeRecoveryInFlightRef = useRef(false);
  const startupFullReconnectCountRef = useRef(0);
  const lastProgressAtRef = useRef<number>(0);
  const lastCurrentTimeRef = useRef<number>(0);
  const lastObservedPlaybackPositionRef = useRef<number>(Math.max(Number(resumeSeconds || 0), 0));
  const lastResumeSourceRef = useRef<string>(src);
  const lastResumeStorageKeyRef = useRef<string>(buildPlaybackResumeKey({
    trackCourseId,
    trackLessonId,
    trackVideoId,
    src,
  }));
  const lastPersistedResumeFloorRef = useRef<number>(Math.max(Number(resumeSeconds || 0), 0));
  const playbackSessionIdRef = useRef<string | null>(playbackSessionId || null);
  const onProgressRef = useRef(onProgress);
  const onReadyRef = useRef(onReady);
  const onPlaybackStateChangeRef = useRef(onPlaybackStateChange);
  const onQualityOptionsChangeRef = useRef(onQualityOptionsChange);
  const pendingResumeRef = useRef<number>(Math.max(Number(resumeSeconds || 0), 0));
  const autoRetryCountRef = useRef(0);
  const qualityOptionsRef = useRef<RecordedVideoQualityOption[]>([]);
  const lastAttachedConfigSignatureRef = useRef<string | null>(null);
  const lastTimeUpdateMetricSecondRef = useRef(-1);
  const sessionRecoveryPromiseRef = useRef<Promise<boolean> | null>(null);
  const retryPreservesPlayerRef = useRef(false);
  const scheduledRetryReasonRef = useRef<string | null>(null);
  const hlsNetworkRecoveryCountRef = useRef(0);
  const hlsMediaRecoveryCountRef = useRef(0);
  const protectedSessionRebootstrapCountRef = useRef(0);
  const stablePlaybackSnapshotRef = useRef<StablePlaybackSnapshot>({
    currentTime: Math.max(Number(resumeSeconds || 0), 0),
    durationSeconds: 0,
    selectedQualityHeight: Number.isFinite(Number(selectedQualityHeight || 0))
      ? Number(selectedQualityHeight || 0)
      : null,
    deliveryPath: null,
    deliveryProfile: deliveryProfile || null,
    firstFrameReached: false,
    updatedAt: 0,
  });
  const [isReconnecting, setIsReconnecting] = useState(true);
  const [loadMessage, setLoadMessage] = useState<string>('Connecting to stream…');
  const [playbackBlockedMessage, setPlaybackBlockedMessage] = useState('');
  const [terminalPlaybackError, setTerminalPlaybackError] = useState('');
  const activeDeliveryPath = deliveryPathHint || classifyRecordedVideoDeliveryPath({
    deliveryProfile,
    streamFormat,
    src,
    fallbackActive: streamFormat === 'source' && !drmConfig?.enabled,
    drmEnabled: Boolean(drmConfig?.enabled),
  });
  const normalizedStreamFormat = String(drmConfig?.manifestFormat || streamFormat || '').trim().toLowerCase();
  const protectedHlsStabilityMode = activeDeliveryPath === 'protected_hls_gateway'
    && (normalizedStreamFormat === 'hls' || /\.m3u8(\?|$)/.test(String(src || '').toLowerCase()));

  const emitPlaybackMetric = (type: string, detail: Record<string, unknown> = {}) => {
    if (typeof window === 'undefined') {
      return;
    }

    const video = videoRef.current;
    const performanceWithMemory = performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    };

    window.dispatchEvent(new CustomEvent('edumaster:hls-metric', {
      detail: {
        type,
        src,
        title,
        trackVideoId,
        at: Date.now(),
        currentTimeSeconds: video ? Math.max(Number(video.currentTime || 0), 0) : 0,
        durationSeconds: video ? Math.max(Number(video.duration || 0), 0) : 0,
        totalBufferMs: totalBufferMsRef.current,
        connectionStrength: getConnectionStrength(),
        deliveryProfile,
        deliveryPath: activeDeliveryPath,
        usedJSHeapSize: performanceWithMemory.memory?.usedJSHeapSize || null,
        totalJSHeapSize: performanceWithMemory.memory?.totalJSHeapSize || null,
        jsHeapSizeLimit: performanceWithMemory.memory?.jsHeapSizeLimit || null,
        ...detail,
      },
    }));
  };

  const getCurrentSelectedQualityHeight = () => {
    const levels = hlsRef.current?.levels || [];
    const currentLevelIndex = Number(hlsRef.current?.currentLevel ?? -1);
    if (currentLevelIndex >= 0 && levels[currentLevelIndex]?.height) {
      return Number(levels[currentLevelIndex]?.height || 0) || null;
    }
    if (Number.isFinite(Number(selectedQualityHeight || 0)) && Number(selectedQualityHeight || 0) > 0) {
      return Number(selectedQualityHeight || 0);
    }
    const qualityOptions = qualityOptionsRef.current;
    const fallbackHeight = qualityOptions[0]?.height || defaultQualityHeight;
    return Number.isFinite(Number(fallbackHeight || 0)) && Number(fallbackHeight || 0) > 0
      ? Number(fallbackHeight)
      : null;
  };

  const captureStablePlaybackSnapshot = () => {
    const video = videoRef.current;
    const nextCurrentTime = Math.max(
      Number(video?.currentTime || 0),
      Number(lastObservedPlaybackPositionRef.current || 0),
      Number(lastCurrentTimeRef.current || 0),
      Number(lastHeartbeatPositionRef.current || 0),
      Number(stablePlaybackSnapshotRef.current.currentTime || 0),
      0,
    );
    const nextDurationSeconds = Math.max(
      Number(video?.duration || 0),
      Number(stablePlaybackSnapshotRef.current.durationSeconds || 0),
      0,
    );

    stablePlaybackSnapshotRef.current = {
      currentTime: nextCurrentTime,
      durationSeconds: nextDurationSeconds,
      selectedQualityHeight: getCurrentSelectedQualityHeight(),
      deliveryPath: activeDeliveryPath,
      deliveryProfile: deliveryProfile || null,
      firstFrameReached: firstFrameReachedRef.current || stablePlaybackSnapshotRef.current.firstFrameReached,
      updatedAt: Date.now(),
    };
  };

  const getStallDiagnostic = (detail: Record<string, unknown> = {}) => {
    const video = videoRef.current;
    const stableSnapshot = stablePlaybackSnapshotRef.current;
    const currentLevelIndex = Number(hlsRef.current?.currentLevel ?? -1);
    const currentLevel = currentLevelIndex >= 0 ? hlsRef.current?.levels?.[currentLevelIndex] : null;
    return {
      currentPlaybackTimeSeconds: Math.max(
        Number(video?.currentTime || 0),
        Number(stableSnapshot.currentTime || 0),
        0,
      ),
      lastKnownDurationSeconds: Math.max(
        Number(video?.duration || 0),
        Number(stableSnapshot.durationSeconds || 0),
        0,
      ),
      currentQualityHeight: Number(currentLevel?.height || 0) || stableSnapshot.selectedQualityHeight || null,
      bufferedAheadSeconds: getBufferedAheadSeconds(video),
      retryCount: autoRetryCountRef.current,
      firstFrameReached: firstFrameReachedRef.current,
      wasPlayingBeforeStall: isPlayingRef.current,
      deliveryPath: activeDeliveryPath,
      deliveryProfile: deliveryProfile || null,
      ...detail,
    };
  };

  const classifyPlaybackFailure = (detail: {
    fatal?: boolean;
    type?: string | null;
    details?: string | null;
    reasonCode?: string | null;
    hardStop?: boolean;
  }) => {
    if (detail.hardStop) {
      return 'hard_playback_stop';
    }
    if (detail.reasonCode === 'PLAYBACK_SESSION_INVALID') {
      return 'midstream_session_rebootstrap';
    }

    const normalizedDetails = String(detail.details || '').toLowerCase();
    const normalizedType = String(detail.type || '').toLowerCase();
    const beforeFirstFrame = !firstFrameReachedRef.current;

    if (beforeFirstFrame) {
      if (
        normalizedDetails.includes('manifest')
        || normalizedDetails.includes('level')
        || normalizedType.includes('manifest')
      ) {
        return 'startup_manifest_failure';
      }
      if (
        normalizedDetails.includes('frag')
        || normalizedDetails.includes('segment')
        || normalizedDetails.includes('buffer')
      ) {
        return 'startup_segment_failure';
      }
    }

    return 'midstream_buffer_stall';
  };

  const clearTimer = (timerRef: React.MutableRefObject<number | null>) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const readStoredResumeFloor = () => {
    if (typeof window === 'undefined') {
      return 0;
    }
    const storageKey = lastResumeStorageKeyRef.current;
    try {
      const rawValue = window.sessionStorage.getItem(storageKey);
      const parsed = Number(rawValue || 0);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    } catch {
      // Ignore storage access failures.
    }
    return 0;
  };

  const writeStoredResumeFloor = (seconds: number) => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.sessionStorage.setItem(lastResumeStorageKeyRef.current, String(seconds));
    } catch {
      // Ignore storage access failures.
    }
  };

  const rememberResumeFloor = (
    seconds: number,
    reason: string,
    options: { forcePersist?: boolean } = {},
  ) => {
    const candidate = Math.max(Number(seconds || 0), 0);
    if (!Number.isFinite(candidate) || candidate <= 0) {
      return lastPersistedResumeFloorRef.current;
    }
    const previous = Math.max(Number(lastPersistedResumeFloorRef.current || 0), 0);
    const nextFloor = Math.max(
      candidate,
      Number(lastObservedPlaybackPositionRef.current || 0),
      Number(lastCurrentTimeRef.current || 0),
      Number(lastHeartbeatPositionRef.current || 0),
      previous,
      0,
    );
    const shouldPersist = Boolean(
      options.forcePersist
      || nextFloor > previous + LIVE_RESUME_PERSIST_STEP_SECONDS
      || previous <= 0,
    );
    lastPersistedResumeFloorRef.current = nextFloor;
    if (shouldPersist) {
      writeStoredResumeFloor(nextFloor);
      emitPlaybackMetric('resume_floor_persisted', {
        reason,
        previousResumeFloorSeconds: previous,
        nextResumeFloorSeconds: nextFloor,
      });
    }
    return nextFloor;
  };

  const getPlaybackSnapshot = () => {
    const video = videoRef.current;
    const stableSnapshot = stablePlaybackSnapshotRef.current;
    const currentTime = Math.max(Number(video?.currentTime || 0), 0);
    const durationSeconds = Math.max(Number(video?.duration || 0), 0);
    const shouldUseStableFallback = protectedHlsStabilityMode
      && (firstFrameReachedRef.current || stableSnapshot.firstFrameReached);
    return {
      currentTime: shouldUseStableFallback && currentTime <= 0
        ? Math.max(Number(stableSnapshot.currentTime || 0), 0)
        : currentTime,
      durationSeconds: shouldUseStableFallback && durationSeconds <= 0
        ? Math.max(Number(stableSnapshot.durationSeconds || 0), 0)
        : durationSeconds,
      paused: Boolean(video?.paused),
      readyState: Number(video?.readyState || 0),
      networkState: Number(video?.networkState || 0),
    };
  };

  const preserveLiveResumePoint = (reason: string) => {
    captureStablePlaybackSnapshot();
    const snapshot = getPlaybackSnapshot();
    const nextResumeSeconds = Math.max(
      snapshot.currentTime,
      Number(lastCurrentTimeRef.current || 0),
      Number(lastObservedPlaybackPositionRef.current || 0),
      Number(pendingResumeRef.current || 0),
      Number(lastHeartbeatPositionRef.current || 0),
      Number(lastPersistedResumeFloorRef.current || 0),
      0,
    );
    pendingResumeRef.current = nextResumeSeconds;
    lastObservedPlaybackPositionRef.current = nextResumeSeconds;
    rememberResumeFloor(nextResumeSeconds, reason, { forcePersist: true });
    emitPlaybackMetric('resume_point_preserved', {
      reason,
      currentTimeSeconds: snapshot.currentTime,
      durationSeconds: snapshot.durationSeconds,
      paused: snapshot.paused,
      readyState: snapshot.readyState,
      networkState: snapshot.networkState,
      nextResumeSeconds,
    });
  };

  const markStartupProgress = (phase: string, detail: Record<string, unknown> = {}) => {
    startupProgressAtRef.current = Date.now();
    if (phase !== 'attach_started') {
      startupNativeRecoveryInFlightRef.current = false;
    }
    if (startupProgressPhaseRef.current === phase) {
      return;
    }

    startupProgressPhaseRef.current = phase;
    emitPlaybackMetric('startup_progress', {
      phase,
      ...detail,
    });
  };

  const stopHeartbeat = () => {
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const stopWatchdog = () => {
    if (watchdogTimerRef.current !== null) {
      window.clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  };

  const cancelScheduledRetry = (reason: string, detail: Record<string, unknown> = {}) => {
    if (retryTimerRef.current === null) {
      return;
    }

    clearTimer(retryTimerRef);
    scheduledRetryReasonRef.current = null;
    retryPreservesPlayerRef.current = false;
    emitPlaybackMetric('reconnect_cancelled', {
      reason,
      ...detail,
    });
  };

  const destroyPlayer = () => {
    captureStablePlaybackSnapshot();
    stopHeartbeat();
    stopWatchdog();
    clearTimer(startupTimeoutRef);
    clearTimer(retryTimerRef);
    scheduledRetryReasonRef.current = null;
    retryPreservesPlayerRef.current = false;
    mediaCleanupRef.current?.();
    mediaCleanupRef.current = null;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (shakaPlayerRef.current) {
      void shakaPlayerRef.current.destroy().catch(() => undefined);
      shakaPlayerRef.current = null;
    }
  };

  const blockPlayback = (message: string) => {
    const video = videoRef.current;
    preserveLiveResumePoint('playback-blocked');
    clearTimer(retryTimerRef);
    scheduledRetryReasonRef.current = null;
    retryPreservesPlayerRef.current = false;
    setPlaybackBlockedMessage(message);
    setIsReconnecting(false);
    setLoadMessage(message);
    isPlayingRef.current = false;
    stopHeartbeat();
    stopWatchdog();
    emitPlaybackMetric('playback_stopped_banner_visible', {
      message,
      playbackSessionId: playbackSessionIdRef.current,
    });
    if (video) {
      try {
        video.pause();
      } catch {
        // Ignore pause failures during teardown.
      }
    }
  };

  const failPlayback = (message: string, detail: Record<string, unknown> = {}) => {
    console.warn('[video-playback] terminal error', {
      title,
      src,
      trackVideoId,
      trackCourseId,
      trackLessonId,
      trackVideoType,
      playbackSessionId,
      message,
      ...detail,
    });
    setTerminalPlaybackError(message);
    setLoadMessage(message);
    setIsReconnecting(false);
    scheduledRetryReasonRef.current = null;
    retryPreservesPlayerRef.current = false;
    emitPlaybackMetric('playback_failure_classified', {
      failureClass: classifyPlaybackFailure({ hardStop: true }),
      ...getStallDiagnostic(detail),
    });
    destroyPlayer();
  };

  const recoverPlaybackSession = async (reasonCode: string) => {
    if (!trackCourseId || !trackLessonId) {
      return false;
    }

    if (sessionRecoveryPromiseRef.current) {
      return sessionRecoveryPromiseRef.current;
    }

    const recoveryPromise = (async () => {
      const previousPlaybackSessionId = playbackSessionIdRef.current;
      preserveLiveResumePoint('session-recovery-started');
      emitPlaybackMetric('playback_session_recovery_started', {
        reasonCode,
        previousPlaybackSessionId,
        trackCourseId,
        trackLessonId,
        trackVideoId,
      });

      try {
        const refreshed = await EduService.getProtectedLessonPlayback(trackCourseId, trackLessonId, { forceRefresh: true });
        const nextPlaybackSessionId = String(refreshed?.playbackSessionId || '').trim();
        const refreshedSource = String(refreshed?.drmConfig?.manifestUrl || refreshed?.streamUrl || '').trim();
        const refreshedVideoId = String(refreshed?.videoId || '').trim();
        const currentVideoId = String(trackVideoId || '').trim();

        if (!nextPlaybackSessionId) {
          emitPlaybackMetric('playback_session_recovery_failed', {
            reasonCode,
            failure: 'missing_playback_session_id',
          });
          return false;
        }

        if (currentVideoId && refreshedVideoId && currentVideoId !== refreshedVideoId) {
          emitPlaybackMetric('playback_session_recovery_failed', {
            reasonCode,
            failure: 'different_video_returned',
            currentVideoId,
            refreshedVideoId,
          });
          return false;
        }

        playbackSessionIdRef.current = nextPlaybackSessionId;
        lastHeartbeatPositionRef.current = Math.max(
          Number(videoRef.current?.currentTime || 0),
          Number(lastHeartbeatPositionRef.current || 0),
          0,
        );
        emitPlaybackMetric('playback_session_recovered', {
          reasonCode,
          previousPlaybackSessionId,
          nextPlaybackSessionId,
          streamSourceChanged: Boolean(refreshedSource && refreshedSource !== String(drmConfig?.manifestUrl || src || '').trim()),
        });
        cancelScheduledRetry('playback-session-recovered', {
          reasonCode,
        });
        if (
          protectedHlsStabilityMode
          && firstFrameReachedRef.current
          && reasonCode === 'PLAYBACK_SESSION_INVALID'
          && protectedSessionRebootstrapCountRef.current < MAX_PROTECTED_SESSION_REBOOTSTRAPS
        ) {
          protectedSessionRebootstrapCountRef.current += 1;
          emitPlaybackMetric('playback_failure_classified', {
            failureClass: classifyPlaybackFailure({ reasonCode }),
            ...getStallDiagnostic({
              reasonCode,
              silentRebootstrap: true,
              silentRebootstrapAttempt: protectedSessionRebootstrapCountRef.current,
            }),
          });
          setLoadMessage('Refreshing protected session…');
          setIsReconnecting(true);
          window.setTimeout(() => {
            if (!isMountedRef.current) {
              return;
            }
            attachPlayer('playback-session-rebootstrap');
          }, 80);
          return true;
        }
        setIsReconnecting(false);
        setLoadMessage('Stream ready');
        return true;
      } catch (recoveryError) {
        emitPlaybackMetric('playback_session_recovery_failed', {
          reasonCode,
          failure: recoveryError instanceof Error ? recoveryError.message : 'unknown_recovery_error',
        });
        return false;
      } finally {
        sessionRecoveryPromiseRef.current = null;
      }
    })();

    sessionRecoveryPromiseRef.current = recoveryPromise;
    return recoveryPromise;
  };

  const sendHeartbeat = async (
    currentTimeSeconds: number,
    durationSeconds: number,
    _completed: boolean,
    overrides: {
      isPlaying?: boolean;
      isPaused?: boolean;
      isBuffering?: boolean;
      playbackRate?: number;
    } = {},
  ) => {
    const effectivePlaybackSessionId = playbackSessionIdRef.current;
    if (!trackVideoId || !effectivePlaybackSessionId) {
      return;
    }

    try {
      const response = await EduService.trackPlaybackHeartbeat({
        videoId: trackVideoId,
        courseId: trackCourseId,
        lessonId: trackLessonId,
        videoType: trackVideoType,
        playbackSessionId: effectivePlaybackSessionId,
        currentPositionSeconds: currentTimeSeconds,
        previousPositionSeconds: lastHeartbeatPositionRef.current,
        durationSeconds,
        isPlaying: overrides.isPlaying ?? isPlayingRef.current,
        isPaused: overrides.isPaused ?? Boolean(videoRef.current?.paused),
        isBuffering: overrides.isBuffering ?? (bufferingStartedAtRef.current !== null),
        playbackRate: overrides.playbackRate ?? Number(videoRef.current?.playbackRate || playbackSpeed || 1),
        timestamp: new Date().toISOString(),
      });
      emitPlaybackMetric('heartbeat_sent', {
        currentTimeSeconds,
        durationSeconds,
        completed: Boolean(_completed),
        sessionStatus: response?.sessionStatus || 'active',
      });
      const nextPlaybackSessionId = String(response?.playbackSessionId || '').trim();
      if (nextPlaybackSessionId && nextPlaybackSessionId !== effectivePlaybackSessionId) {
        playbackSessionIdRef.current = nextPlaybackSessionId;
        emitPlaybackMetric('heartbeat_session_rollover_synced', {
          previousPlaybackSessionId: effectivePlaybackSessionId,
          nextPlaybackSessionId,
        });
      }
      lastHeartbeatPositionRef.current = currentTimeSeconds;

      if (response?.watchState?.locked || String(response?.sessionStatus || '').toLowerCase() === 'locked') {
        blockPlayback('This video is locked because the watch limit has been reached.');
      }
    } catch (error) {
      emitPlaybackMetric('heartbeat_failed', {
        currentTimeSeconds,
        durationSeconds,
        completed: Boolean(_completed),
        code: error instanceof ApiRequestError ? error.code : null,
        message: error instanceof Error ? error.message : 'Unknown heartbeat failure',
      });
      if (error instanceof ApiRequestError) {
        if (error.code === 'VIDEO_WATCH_LIMIT_REACHED') {
          blockPlayback('This video is locked because the watch limit has been reached.');
          return;
        }

        if (error.code === 'PLAYBACK_SESSION_INVALID' || error.code === 'PLAYBACK_SESSION_CONFLICT') {
          const recovered = await recoverPlaybackSession(error.code);
          if (recovered) {
            return;
          }

          if (error.code === 'PLAYBACK_SESSION_CONFLICT') {
            blockPlayback('Playback stopped because this lesson is active in another tab or device.');
            return;
          }

          scheduleRetry('Playback session expired. Reconnecting…', {
            phase: firstFrameReachedRef.current ? 'general' : 'startup',
          });
          return;
        }
      }

      // Ignore transient heartbeat failures so playback is not interrupted by
      // brief connectivity problems between browser and API.
    }
  };

  const scheduleRetry = (
    reason: string,
    options: {
      destroyImmediately?: boolean;
      phase?: 'startup' | 'general';
    } = {},
  ) => {
    if (!isMountedRef.current) {
      return;
    }

    if (retryTimerRef.current !== null) {
      emitPlaybackMetric('reconnect_already_scheduled', {
        reason,
        scheduledReason: scheduledRetryReasonRef.current,
      });
      return;
    }

    const destroyImmediately = options.destroyImmediately ?? false;
    const phase = options.phase ?? 'general';
    if (phase === 'startup' && !firstFrameReachedRef.current) {
      if (startupFullReconnectCountRef.current >= 1) {
        failPlayback(`${reason} Please tap Retry to try again.`, {
          phase,
          retryCount: autoRetryCountRef.current,
          startupReconnectCount: startupFullReconnectCountRef.current,
        });
        return;
      }
      startupFullReconnectCountRef.current += 1;
    }
    autoRetryCountRef.current += 1;
    if (autoRetryCountRef.current > MAX_AUTO_RETRIES) {
      failPlayback(`${reason} Please tap Retry to try again.`, {
        retryCount: autoRetryCountRef.current,
      });
      return;
    }

    clearTimer(retryTimerRef);
    scheduledRetryReasonRef.current = reason;
    retryPreservesPlayerRef.current = !destroyImmediately;
    emitPlaybackMetric('playback_failure_classified', {
      failureClass: classifyPlaybackFailure({
        details: reason,
      }),
      ...getStallDiagnostic({
        reason,
        destroyImmediately,
      }),
    });
    emitPlaybackMetric('reconnect_scheduled', {
      reason,
      retryDelayMs: RETRY_DELAY_MS,
      destroyImmediately,
    });
    if (destroyImmediately) {
      preserveLiveResumePoint('retry-scheduled');
      destroyPlayer();
      setLoadMessage(reason);
      setIsReconnecting(true);
    }
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      scheduledRetryReasonRef.current = null;
      retryPreservesPlayerRef.current = false;
      if (!isMountedRef.current) {
        return;
      }

      preserveLiveResumePoint('retry-timer-fired');
      destroyPlayer();
      setLoadMessage('Reconnecting…');
      setIsReconnecting(true);
      attachPlayer('retry-timer');
    }, RETRY_DELAY_MS);
  };

  const attachPlayer = (reason: string = 'manual') => {
    const video = videoRef.current;
    if (!video || !src) {
      return;
    }

    const configSignature = JSON.stringify({
      src,
      autoPlay: Boolean(autoPlay),
      streamFormat: String(streamFormat || '').trim().toLowerCase(),
      drm: buildDrmConfigSignature(drmConfig),
    });
    const shouldSkipSameConfigEffectAttach = reason === 'effect'
      && lastAttachedConfigSignatureRef.current === configSignature
      && Boolean(video.currentSrc || hlsRef.current || shakaPlayerRef.current || mediaCleanupRef.current);
    if (shouldSkipSameConfigEffectAttach) {
      emitPlaybackMetric('attach_skipped_same_config', {
        reason,
        configSignature,
        playbackSessionId: playbackSessionIdRef.current,
      });
      return;
    }

    const attachAttemptId = attachGenerationRef.current + 1;
    attachGenerationRef.current = attachAttemptId;
    const isStaleAttach = () => (
      !isMountedRef.current
      || attachGenerationRef.current !== attachAttemptId
      || videoRef.current !== video
    );

    destroyPlayer();
    emitPlaybackMetric('reconnect_started', {
      reason,
      retryCount: autoRetryCountRef.current,
    });
    const storageKey = buildPlaybackResumeKey({
      trackCourseId,
      trackLessonId,
      trackVideoId,
      src,
    });
    const storageKeyChanged = lastResumeStorageKeyRef.current !== storageKey;
    lastResumeStorageKeyRef.current = storageKey;
    if (storageKeyChanged) {
      lastPersistedResumeFloorRef.current = Math.max(Number(resumeSeconds || 0), 0);
    }
    const storedResumeFloor = readStoredResumeFloor();
    lastPersistedResumeFloorRef.current = Math.max(lastPersistedResumeFloorRef.current, storedResumeFloor);
    startupStartedAtRef.current = performance.now();
    startupReportedRef.current = false;
    bufferingStartedAtRef.current = null;
    totalBufferMsRef.current = 0;
    startupProgressAtRef.current = Date.now();
    startupProgressPhaseRef.current = 'attach_started';
    const sourceChangedSinceLastAttach = lastResumeSourceRef.current !== src;
    const sourceChangedResumeSeed = Math.max(
      Number(pendingResumeRef.current || 0),
      Number(lastCurrentTimeRef.current || 0),
      Number(lastObservedPlaybackPositionRef.current || 0),
      Number(lastHeartbeatPositionRef.current || 0),
      Number(lastPersistedResumeFloorRef.current || 0),
      Number(resumeSeconds || 0),
      0,
    );
    const nextResumeSeed = sourceChangedSinceLastAttach
      ? sourceChangedResumeSeed
      : Math.max(
        Number(pendingResumeRef.current || 0),
        Number(lastObservedPlaybackPositionRef.current || 0),
        Number(lastCurrentTimeRef.current || 0),
        Number(lastPersistedResumeFloorRef.current || 0),
        0,
      );
    pendingResumeRef.current = nextResumeSeed;
    lastHeartbeatPositionRef.current = nextResumeSeed;
    lastObservedPlaybackPositionRef.current = nextResumeSeed;
    lastPersistedResumeFloorRef.current = Math.max(lastPersistedResumeFloorRef.current, nextResumeSeed);
    const previousSource = lastResumeSourceRef.current;
    lastResumeSourceRef.current = src;
    lastAttachedConfigSignatureRef.current = configSignature;
    firstFrameReachedRef.current = false;
    startupNativeRecoveryInFlightRef.current = false;
    const shouldResetStartupRecoveryBudget = sourceChangedSinceLastAttach
      || reason === 'manual'
      || reason === 'imperative-retry'
      || reason === 'manual-retry-button';
    startupNativeRecoveryCountRef.current = shouldResetStartupRecoveryBudget ? 0 : startupNativeRecoveryCountRef.current;
    startupFullReconnectCountRef.current = shouldResetStartupRecoveryBudget ? 0 : startupFullReconnectCountRef.current;
    protectedSessionRebootstrapCountRef.current = shouldResetStartupRecoveryBudget ? 0 : protectedSessionRebootstrapCountRef.current;
    if (sourceChangedSinceLastAttach || shouldResetStartupRecoveryBudget) {
      stablePlaybackSnapshotRef.current = {
        currentTime: nextResumeSeed,
        durationSeconds: 0,
        selectedQualityHeight: getCurrentSelectedQualityHeight(),
        deliveryPath: activeDeliveryPath,
        deliveryProfile: deliveryProfile || null,
        firstFrameReached: false,
        updatedAt: Date.now(),
      };
    }
    emitPlaybackMetric('attach_player', {
      reason,
      configSignature,
      sourceChangedSinceLastAttach,
      playerRemounted: Boolean(lastAttachedConfigSignatureRef.current),
      storedResumeFloorSeconds: storedResumeFloor,
      resumeSeconds,
      nextResumeSeed,
      playbackSessionId: playbackSessionIdRef.current,
      stabilizationMode: protectedHlsStabilityMode,
    });
    if (sourceChangedSinceLastAttach) {
      emitPlaybackMetric('source_changed', {
        reason,
        previousSource,
        nextSource: src,
      });
    }
    setPlaybackBlockedMessage('');
    setTerminalPlaybackError('');
    setIsReconnecting(true);
    setLoadMessage('Connecting to stream…');
    clearTimer(startupTimeoutRef);
    const markFirstFrameReached = (trigger: string) => {
      if (firstFrameReachedRef.current) {
        return;
      }

      firstFrameReachedRef.current = true;
      startupNativeRecoveryInFlightRef.current = false;
      startupNativeRecoveryCountRef.current = 0;
      startupFullReconnectCountRef.current = 0;
      autoRetryCountRef.current = 0;
      hlsNetworkRecoveryCountRef.current = 0;
      hlsMediaRecoveryCountRef.current = 0;
      protectedSessionRebootstrapCountRef.current = 0;
      captureStablePlaybackSnapshot();
      clearTimer(startupTimeoutRef);
      emitPlaybackMetric('first_frame_reached', {
        trigger,
        startupDelayMs: startupStartedAtRef.current > 0
          ? Math.round(performance.now() - startupStartedAtRef.current)
          : null,
        currentTimeSeconds: Math.max(Number(video.currentTime || 0), 0),
        readyState: Number(video.readyState || 0),
      });
    };
    const scheduleStartupTimeoutCheck = (delayMs: number) => {
      clearTimer(startupTimeoutRef);
      startupTimeoutRef.current = window.setTimeout(() => {
        if (
          !isMountedRef.current
          || attachGenerationRef.current !== attachAttemptId
          || videoRef.current !== video
        ) {
          return;
        }

        const currentTime = Math.max(Number(video.currentTime || 0), 0);
        const readyState = Number(video.readyState || 0);
        const bufferedAheadSeconds = getBufferedAheadSeconds(video);
        if (
          firstFrameReachedRef.current
          || currentTime > STARTUP_FIRST_FRAME_THRESHOLD_SECONDS
          || (readyState >= READY_STATE_HAVE_FUTURE_DATA && bufferedAheadSeconds > 0.5)
        ) {
          return;
        }

        const startupProgressAgeMs = startupProgressAtRef.current > 0
          ? Date.now() - startupProgressAtRef.current
          : null;
        const hasRecentStartupProgress = Boolean(
          startupProgressAgeMs !== null
          && startupProgressPhaseRef.current !== 'attach_started'
          && startupProgressAgeMs < STARTUP_TIMEOUT_PROGRESS_GRACE_MS
        );

        if (hasRecentStartupProgress) {
          emitPlaybackMetric('startup_timeout_deferred', {
            currentTime,
            readyState,
            bufferedAheadSeconds,
            startupProgressAgeMs,
            startupProgressPhase: startupProgressPhaseRef.current,
            nextDelayMs: STARTUP_TIMEOUT_DEFER_MS,
          });
          scheduleStartupTimeoutCheck(STARTUP_TIMEOUT_DEFER_MS);
          return;
        }

        const hls = hlsRef.current;
        if (hls && !firstFrameReachedRef.current && !startupNativeRecoveryInFlightRef.current && startupNativeRecoveryCountRef.current < MAX_HLS_NATIVE_RECOVERY_ATTEMPTS) {
          const restartPositionSeconds = Math.max(
            currentTime,
            Number(lastObservedPlaybackPositionRef.current || 0),
            Number(pendingResumeRef.current || 0),
            0,
          );
          startupNativeRecoveryCountRef.current += 1;
          startupNativeRecoveryInFlightRef.current = true;
          preserveLiveResumePoint('startup-timeout-native-recovery');
          emitPlaybackMetric('startup_native_recovery_started', {
            reason: 'startup-timeout',
            attempt: startupNativeRecoveryCountRef.current,
            restartPositionSeconds,
            startupProgressPhase: startupProgressPhaseRef.current,
          });
          try {
            hls.startLoad(restartPositionSeconds);
            setLoadMessage('Reconnecting to stream…');
            scheduleStartupTimeoutCheck(STARTUP_TIMEOUT_DEFER_MS);
            return;
          } catch (nativeRecoveryError) {
            startupNativeRecoveryInFlightRef.current = false;
            emitPlaybackMetric('startup_native_recovery_failed', {
              reason: 'startup-timeout',
              attempt: startupNativeRecoveryCountRef.current,
              message: nativeRecoveryError instanceof Error ? nativeRecoveryError.message : 'unknown_startup_recovery_error',
            });
          }
        }

        emitPlaybackMetric('startup_timeout', {
          currentTime,
          readyState,
          bufferedAheadSeconds,
          startupProgressAgeMs,
          startupProgressPhase: startupProgressPhaseRef.current,
        });
        scheduleRetry('Video is taking longer than expected to start. Reconnecting…', {
          phase: 'startup',
        });
      }, delayMs);
    };
    scheduleStartupTimeoutCheck(STARTUP_TIMEOUT_MS);

    const setupMediaEvents = () => {
      const applyPendingResume = () => {
        const pendingResumeSeconds = pendingResumeRef.current;
        if (!Number.isFinite(pendingResumeSeconds) || pendingResumeSeconds <= 0) {
          return;
        }

        if (video.readyState < 1) {
          return;
        }

        const durationSeconds = Number(video.duration || 0);
        const safeResumeSeconds = durationSeconds > 0
          ? Math.min(pendingResumeSeconds, Math.max(durationSeconds - 2, 0))
          : pendingResumeSeconds;

        try {
          if (Math.abs(Number(video.currentTime || 0) - safeResumeSeconds) > 1) {
            video.currentTime = Math.max(safeResumeSeconds, 0);
          }
          emitPlaybackMetric('resume_seconds_used', {
            pendingResumeSeconds,
            safeResumeSeconds,
          });
          rememberResumeFloor(safeResumeSeconds, 'apply-pending-resume', { forcePersist: true });
          pendingResumeRef.current = 0;
        } catch {
          // Ignore early seek races until metadata is ready.
        }
      };

      const handlePlay = () => {
        if (retryPreservesPlayerRef.current) {
          cancelScheduledRetry('playback-resumed-on-play', {
            currentTimeSeconds: Math.max(Number(video.currentTime || 0), 0),
          });
        }
        isPlayingRef.current = true;
        lastProgressAtRef.current = Date.now();
        lastHeartbeatPositionRef.current = Math.max(Number(video.currentTime || 0), 0);
        lastObservedPlaybackPositionRef.current = Math.max(Number(video.currentTime || 0), 0);
        rememberResumeFloor(Math.max(Number(video.currentTime || 0), 0), 'play-started');
        captureStablePlaybackSnapshot();
        setIsReconnecting(false);
        onPlaybackStateChangeRef.current?.({ playing: true, ended: false, waiting: false });
        emitPlaybackMetric('play');
        emitPlaybackMetric('reconnect_completed', {
          reason: 'play-event',
          retryCount: autoRetryCountRef.current,
        });
        stopHeartbeat();
        heartbeatTimerRef.current = window.setInterval(() => {
          if (!videoRef.current || !isPlayingRef.current) {
            return;
          }

          const currentTimeSeconds = Math.max(Number(videoRef.current.currentTime || 0), 0);
          const durationSeconds = Math.max(Number(videoRef.current.duration || 0), 0);
          const completed = videoRef.current.ended || currentTimeSeconds >= Math.max(durationSeconds - 1, 1);
          void sendHeartbeat(currentTimeSeconds, durationSeconds, completed);
        }, HEARTBEAT_INTERVAL_MS);
      };

      const handlePause = () => {
        const { currentTime, durationSeconds } = getPlaybackSnapshot();
        captureStablePlaybackSnapshot();
        rememberResumeFloor(currentTime, 'pause', { forcePersist: true });
        void sendHeartbeat(
          currentTime,
          durationSeconds,
          Boolean(video.ended),
          {
            isPlaying: false,
            isPaused: true,
            isBuffering: false,
          },
        );
        isPlayingRef.current = false;
        stopHeartbeat();
        onPlaybackStateChangeRef.current?.({ playing: false, ended: false, waiting: false });
        emitPlaybackMetric('pause', {
          currentTimeSeconds: currentTime,
          durationSeconds,
        });
      };

      const handleTimeUpdate = () => {
        lastCurrentTimeRef.current = Number(video.currentTime || 0);
        lastObservedPlaybackPositionRef.current = Math.max(Number(video.currentTime || 0), 0);
        captureStablePlaybackSnapshot();
        rememberResumeFloor(lastObservedPlaybackPositionRef.current, 'timeupdate');
        lastProgressAtRef.current = Date.now();
        if (retryPreservesPlayerRef.current && lastObservedPlaybackPositionRef.current > 0.5) {
          cancelScheduledRetry('playback-progressed-before-reconnect', {
            currentTimeSeconds: lastObservedPlaybackPositionRef.current,
          });
        }
        const wholeSecond = Math.floor(lastObservedPlaybackPositionRef.current);
        if (lastObservedPlaybackPositionRef.current >= STARTUP_FIRST_FRAME_THRESHOLD_SECONDS) {
          markFirstFrameReached('timeupdate');
        }
        if (wholeSecond !== lastTimeUpdateMetricSecondRef.current) {
          lastTimeUpdateMetricSecondRef.current = wholeSecond;
          emitPlaybackMetric('timeupdate', {
            currentTimeSeconds: lastObservedPlaybackPositionRef.current,
            durationSeconds: Math.max(Number(video.duration || 0), 0),
          });
        }
        onProgressRef.current?.(
          Math.max(Number(video.currentTime || 0), 0),
          Math.max(Number(video.duration || 0), 0),
          Boolean(video.ended),
        );
      };

      const handleEnded = () => {
        captureStablePlaybackSnapshot();
        const endedAtSeconds = Math.max(Number(video.currentTime || 0), 0);
        const durationSeconds = Math.max(Number(video.duration || 0), 0);
        onProgressRef.current?.(endedAtSeconds, durationSeconds, true);
        void sendHeartbeat(
          endedAtSeconds,
          durationSeconds,
          true,
          {
            isPlaying: true,
            isPaused: false,
            isBuffering: false,
          },
        );
        isPlayingRef.current = false;
        stopHeartbeat();
        stopWatchdog();
        onPlaybackStateChangeRef.current?.({ playing: false, ended: true, waiting: false });
        emitPlaybackMetric('ended');
      };

      const handleError = () => {
        console.warn('[video-playback] media error', {
          title,
          src,
          code: video.error?.code || null,
          message: video.error?.message || null,
        });
        emitPlaybackMetric('media_error', {
          code: video.error?.code || null,
          message: video.error?.message || null,
        });
        emitPlaybackMetric('playback_failure_classified', {
          failureClass: classifyPlaybackFailure({
            type: 'media',
            details: video.error?.message || null,
          }),
          ...getStallDiagnostic({
            mediaErrorCode: video.error?.code || null,
            mediaErrorMessage: video.error?.message || null,
          }),
        });
        scheduleRetry('Stream interrupted. Reconnecting…', {
          phase: firstFrameReachedRef.current ? 'general' : 'startup',
        });
      };

      const handleReady = () => {
        markStartupProgress('media_ready', {
          readyState: video.readyState,
        });
        if (retryPreservesPlayerRef.current) {
          cancelScheduledRetry('playback-ready-before-reconnect', {
            readyState: video.readyState,
            currentTimeSeconds: Math.max(Number(video.currentTime || 0), 0),
          });
        }
        applyPendingResume();
        lastObservedPlaybackPositionRef.current = Math.max(Number(video.currentTime || 0), 0);
        captureStablePlaybackSnapshot();
        setIsReconnecting(false);
        setLoadMessage('Stream ready');
        if (!startupReportedRef.current && startupStartedAtRef.current > 0) {
          startupReportedRef.current = true;
          emitPlaybackMetric('startup_ready', {
            startupDelayMs: Math.round(performance.now() - startupStartedAtRef.current),
            readyState: video.readyState,
          });
        }
        emitPlaybackMetric('reconnect_completed', {
          reason: 'media-ready',
          retryCount: autoRetryCountRef.current,
        });
        onReadyRef.current?.();
      };

      const handleWaiting = () => {
        onPlaybackStateChangeRef.current?.({ playing: false, ended: false, waiting: true });
        if (bufferingStartedAtRef.current === null) {
          const { currentTime, durationSeconds, readyState, networkState } = getPlaybackSnapshot();
          if (isPlayingRef.current) {
            void sendHeartbeat(
              currentTime,
              durationSeconds,
              Boolean(video.ended),
              {
                isPlaying: true,
                isPaused: false,
                isBuffering: true,
              },
            );
          }
          bufferingStartedAtRef.current = performance.now();
          captureStablePlaybackSnapshot();
          emitPlaybackMetric('buffering_start', {
            currentTimeSeconds: currentTime,
            durationSeconds,
            readyState,
            networkState,
          });
        }
      };

      const handlePlaying = () => {
        onPlaybackStateChangeRef.current?.({ playing: true, ended: false, waiting: false });
        markStartupProgress('playing', {
          currentTimeSeconds: Math.max(Number(video.currentTime || 0), 0),
        });
        if (Math.max(Number(video.currentTime || 0), 0) >= STARTUP_FIRST_FRAME_THRESHOLD_SECONDS) {
          markFirstFrameReached('playing');
        }
        captureStablePlaybackSnapshot();
        if (retryPreservesPlayerRef.current) {
          cancelScheduledRetry('buffering-resolved-before-reconnect', {
            currentTimeSeconds: Math.max(Number(video.currentTime || 0), 0),
          });
        }
        const { currentTime, durationSeconds, readyState, networkState } = getPlaybackSnapshot();
        if (bufferingStartedAtRef.current !== null) {
          const bufferMs = Math.round(performance.now() - bufferingStartedAtRef.current);
          bufferingStartedAtRef.current = null;
          totalBufferMsRef.current += bufferMs;
          emitPlaybackMetric('buffering_end', {
            bufferMs,
            currentTimeSeconds: currentTime,
            durationSeconds,
            readyState,
            networkState,
          });
        }
      };

      const handleSeeking = () => {
        const { currentTime, durationSeconds, readyState, networkState } = getPlaybackSnapshot();
        lastObservedPlaybackPositionRef.current = currentTime;
        captureStablePlaybackSnapshot();
        emitPlaybackMetric('seeking', {
          currentTimeSeconds: currentTime,
          durationSeconds,
          readyState,
          networkState,
          previousHeartbeatPositionSeconds: lastHeartbeatPositionRef.current,
        });
      };

      const handleSeeked = () => {
        const { currentTime, durationSeconds, readyState, networkState } = getPlaybackSnapshot();
        lastHeartbeatPositionRef.current = currentTime;
        lastObservedPlaybackPositionRef.current = currentTime;
        captureStablePlaybackSnapshot();
        rememberResumeFloor(currentTime, 'seeked', { forcePersist: true });
        emitPlaybackMetric('seeked', {
          currentTimeSeconds: currentTime,
          durationSeconds,
          readyState,
          networkState,
        });
      };

      const handleStalled = () => {
        const { currentTime, durationSeconds, readyState, networkState } = getPlaybackSnapshot();
        emitPlaybackMetric('playback_failure_classified', {
          failureClass: classifyPlaybackFailure({
            details: 'stalled',
          }),
          ...getStallDiagnostic({
            readyState,
            networkState,
          }),
        });
        emitPlaybackMetric('stalled', {
          currentTimeSeconds: currentTime,
          durationSeconds,
          readyState,
          networkState,
        });
      };

      const handleLoadedData = () => {
        emitPlaybackMetric('loadeddata');
        markFirstFrameReached('loadeddata');
        handleReady();
      };

      const handleLoadedMetadata = () => {
        emitPlaybackMetric('loadedmetadata');
        handleReady();
      };

      const handleCanPlay = () => {
        emitPlaybackMetric('canplay');
        handleReady();
      };

      const handleCanPlayThrough = () => emitPlaybackMetric('canplaythrough');
      const handleDurationChange = () => {
        captureStablePlaybackSnapshot();
        emitPlaybackMetric('durationchange');
      };
      const handleRateChange = () => emitPlaybackMetric('ratechange', {
        playbackRate: Number(video.playbackRate || 1),
      });

      video.addEventListener('play', handlePlay);
      video.addEventListener('pause', handlePause);
      video.addEventListener('timeupdate', handleTimeUpdate);
      video.addEventListener('ended', handleEnded);
      video.addEventListener('error', handleError);
      video.addEventListener('loadeddata', handleLoadedData);
      video.addEventListener('loadedmetadata', handleLoadedMetadata);
      video.addEventListener('canplay', handleCanPlay);
      video.addEventListener('canplaythrough', handleCanPlayThrough);
      video.addEventListener('durationchange', handleDurationChange);
      video.addEventListener('ratechange', handleRateChange);
      video.addEventListener('waiting', handleWaiting);
      video.addEventListener('playing', handlePlaying);
      video.addEventListener('seeking', handleSeeking);
      video.addEventListener('seeked', handleSeeked);
      video.addEventListener('stalled', handleStalled);

      watchdogTimerRef.current = window.setInterval(() => {
        if (!isPlayingRef.current || video.paused || video.ended) {
          return;
        }

        const currentTime = Number(video.currentTime || 0);
        const durationSeconds = Number(video.duration || 0);
        const stalledFor = Date.now() - lastProgressAtRef.current;
        const bufferedAheadSeconds = getBufferedAheadSeconds(video);

        if (
          stalledFor >= STALL_THRESHOLD_MS
          && currentTime === lastCurrentTimeRef.current
          && durationSeconds > 0
          && Number(video.readyState || 0) < READY_STATE_HAVE_FUTURE_DATA
          && bufferedAheadSeconds <= 0.25
        ) {
          emitPlaybackMetric('watchdog_stall', {
            stalledForMs: stalledFor,
            bufferedAheadSeconds,
            readyState: Number(video.readyState || 0),
            networkState: Number(video.networkState || 0),
          });
          scheduleRetry('Playback stalled. Reconnecting…', {
            phase: 'general',
          });
        }
      }, WATCHDOG_INTERVAL_MS);

      return () => {
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('timeupdate', handleTimeUpdate);
        video.removeEventListener('ended', handleEnded);
        video.removeEventListener('error', handleError);
        video.removeEventListener('loadeddata', handleLoadedData);
        video.removeEventListener('loadedmetadata', handleLoadedMetadata);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('canplaythrough', handleCanPlayThrough);
        video.removeEventListener('durationchange', handleDurationChange);
        video.removeEventListener('ratechange', handleRateChange);
        video.removeEventListener('waiting', handleWaiting);
        video.removeEventListener('playing', handlePlaying);
        video.removeEventListener('seeking', handleSeeking);
        video.removeEventListener('seeked', handleSeeked);
        video.removeEventListener('stalled', handleStalled);
      };
    };

    const preferredStreamFormat = String(streamFormat || '').trim().toLowerCase();
    const drmManifestUrl = drmConfig?.enabled ? String(drmConfig.manifestUrl || '').trim() : '';
    const shouldUseDirectSource = preferredStreamFormat === 'source' || isDirectVideoSource(src);
    const finalizeInitialPlaybackSetup = () => {
      if (isStaleAttach()) {
        return;
      }

      if (autoPlay) {
        void video.play().catch(() => undefined);
      }

      try {
        video.playbackRate = playbackSpeed;
        if (pendingResumeRef.current > 0 && video.readyState >= 1) {
          video.currentTime = pendingResumeRef.current;
          pendingResumeRef.current = 0;
        }
      } catch {
        // Ignore seeking/playback rate races while the video initializes.
      }
    };

    void (async () => {
      if (drmManifestUrl) {
        const shakaRuntime = await loadShakaRuntime();
        if (isStaleAttach()) {
          return;
        }

        const Shaka = shakaRuntime.default;
        Shaka.polyfill.installAll();
        if (!Shaka.Player.isBrowserSupported()) {
          setLoadMessage('This browser does not support protected playback.');
          emitPlaybackMetric('drm_unsupported_browser', {
            manifestUrl: drmManifestUrl,
            preferredKeySystem: drmConfig?.preferredKeySystem || null,
          });
          return;
        }

        const player = new Shaka.Player(video);
        if (isStaleAttach()) {
          void player.destroy().catch(() => undefined);
          return;
        }

        shakaPlayerRef.current = player;
        player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
          request.headers = {
            ...(request.headers || {}),
            ...getProtectedPlaybackHeaders(),
          };
        });

        player.addEventListener('error', (event: Event) => {
          const errorDetail = (event as CustomEvent<{ detail?: { code?: number; message?: string } }>).detail;
          console.warn('[video-playback] drm error', {
            title,
            src,
            code: errorDetail?.detail?.code || null,
            message: errorDetail?.detail?.message || null,
          });
          emitPlaybackMetric('drm_error', {
            code: errorDetail?.detail?.code || null,
            message: errorDetail?.detail?.message || null,
            manifestUrl: drmManifestUrl,
          });
          emitPlaybackMetric('playback_failure_classified', {
            failureClass: classifyPlaybackFailure({
              details: errorDetail?.detail?.message || null,
            }),
            ...getStallDiagnostic({
              drmErrorCode: errorDetail?.detail?.code || null,
              drmErrorMessage: errorDetail?.detail?.message || null,
            }),
          });
          scheduleRetry('Protected playback interrupted. Reconnecting…', {
            phase: firstFrameReachedRef.current ? 'general' : 'startup',
          });
        });

        const drmConfiguration: Record<string, unknown> = {
          servers: drmConfig?.licenseServers || {},
        };

        if (drmConfig?.preferredKeySystem) {
          drmConfiguration.preferredKeySystems = [drmConfig.preferredKeySystem];
        }

        if (drmConfig?.fairplayCertificateUrl) {
          drmConfiguration.advanced = {
            'com.apple.fps': {
              serverCertificateUri: drmConfig.fairplayCertificateUrl,
            },
          };
        }

        player.configure({
          drm: drmConfiguration,
          streaming: {
            retryParameters: {
              maxAttempts: 3,
              baseDelay: 800,
              backoffFactor: 2,
              fuzzFactor: 0.5,
              timeout: 30000,
              stallTimeout: 10000,
              connectionTimeout: 15000,
            },
          },
        });

        mediaCleanupRef.current = setupMediaEvents();
        finalizeInitialPlaybackSetup();
        void player.load(drmManifestUrl)
          .then(() => {
            if (isStaleAttach()) {
              return;
            }
            setIsReconnecting(false);
            setLoadMessage('Protected playback ready');
            emitPlaybackMetric('drm_manifest_loaded', {
              manifestUrl: drmManifestUrl,
              manifestFormat: drmConfig?.manifestFormat || null,
              preferredKeySystem: drmConfig?.preferredKeySystem || null,
              licenseServerCount: Object.keys(drmConfig?.licenseServers || {}).length,
            });
            onReadyRef.current?.();
            if (autoPlay || video.readyState >= READY_STATE_HAVE_FUTURE_DATA) {
              void video.play().catch(() => undefined);
            }
          })
          .catch((error: unknown) => {
            if (isStaleAttach()) {
              return;
            }
            emitPlaybackMetric('drm_load_failed', {
              manifestUrl: drmManifestUrl,
              message: error instanceof Error ? error.message : 'Unknown DRM playback error',
            });
            scheduleRetry('Protected playback could not be opened. Reconnecting…', {
              phase: firstFrameReachedRef.current ? 'general' : 'startup',
            });
          });
        return;
      }

      if (shouldUseDirectSource) {
        if (isStaleAttach()) {
          return;
        }
        mediaCleanupRef.current = setupMediaEvents();
        video.src = src;
        video.load();
        finalizeInitialPlaybackSetup();
        return;
      }

      const hlsRuntime = await loadHlsRuntime();
      if (isStaleAttach()) {
        return;
      }

      const Hls = hlsRuntime.default;
      if (Hls.isSupported()) {
        const hls = new Hls(createProtectedVodHlsConfig());
        if (isStaleAttach()) {
          hls.destroy();
          return;
        }

        hlsRef.current = hls;
        hlsNetworkRecoveryCountRef.current = 0;
        hlsMediaRecoveryCountRef.current = 0;
        let cleanupAutoLevelRelease: (() => void) | null = null;
        const applyManualQualitySelection = () => {
          const qualityOptions = qualityOptionsRef.current;
          if (!qualityOptions.length) {
            return;
          }

          const requestedHeight = Number(
            selectedQualityHeight
            ?? getDefaultRecordedVideoQualityHeight(qualityOptions, defaultQualityHeight),
          );
          const selectedLevel = getRecordedVideoQualityLevel(qualityOptions, requestedHeight);
          if (selectedLevel < 0) {
            return;
          }

          hls.currentLevel = selectedLevel;
          hls.nextLevel = selectedLevel;
          hls.autoLevelCapping = selectedLevel;
        };

        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data: { levels?: HlsRuntimeLevel[] }) => {
          markStartupProgress('manifest_parsed', {
            levelCount: data.levels?.length || 0,
          });
          const connectionStrength = getConnectionStrength();
          const qualityOptions = getRecordedVideoQualityOptions(data.levels || []);
          qualityOptionsRef.current = qualityOptions;
          onQualityOptionsChangeRef.current?.(qualityOptions);
          cleanupAutoLevelRelease?.();
          cleanupAutoLevelRelease = null;
          if (
            !protectedHlsStabilityMode
            && Number.isFinite(Number(selectedQualityHeight || 0))
            && Number(selectedQualityHeight || 0) > 0
          ) {
            applyManualQualitySelection();
          } else {
            const startupLevel = applyPreferredStartupLevel(hls, data.levels || []);
            cleanupAutoLevelRelease = scheduleAutoLevelRelease(
              hls,
              protectedHlsStabilityMode ? PROTECTED_HLS_WARMUP_MS : 3500,
            );
            emitPlaybackMetric('startup_level_selected', {
              connectionStrength: startupLevel.connectionStrength,
              preferredLevel: startupLevel.preferredLevel,
              stabilizationMode: protectedHlsStabilityMode,
            });
          }
          captureStablePlaybackSnapshot();
          setLoadMessage(connectionStrength === 'weak' ? 'Saving mobile data with lower bitrate…' : 'Stream ready');
          setIsReconnecting(false);
          emitPlaybackMetric('manifest_parsed', {
            levelCount: data.levels?.length || 0,
            selectedQualityHeight: selectedQualityHeight ?? defaultQualityHeight,
            levels: (data.levels || []).map((level: HlsRuntimeLevel) => ({
              height: level.height || null,
              bitrate: level.bitrate || null,
            })),
          });
          emitPlaybackMetric('hlsManifestLoaded', {
            levelCount: data.levels?.length || 0,
          });
          onReadyRef.current?.();
          if (autoPlay || video.readyState >= READY_STATE_HAVE_FUTURE_DATA) {
            void video.play().catch(() => undefined);
          }
        });

        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data: { level: number }) => {
          const level = hls.levels?.[data.level];
          captureStablePlaybackSnapshot();
          emitPlaybackMetric('level_switched', {
            level: data.level,
            height: level?.height || null,
            bitrate: level?.bitrate || null,
          });
        });

        hls.on(Hls.Events.FRAG_LOADED, (_event, data: { frag?: FragmentWithOptionalStats }) => {
          markStartupProgress('segment_loaded', {
            level: data.frag?.level ?? null,
          });
          const frag = data.frag as FragmentWithOptionalStats | undefined;
          const stats = frag?.stats;
          const loading = stats?.loading;
          const start = Number(loading?.start || 0);
          const end = Number(loading?.end || 0);
          emitPlaybackMetric('segment_loaded', {
            url: frag?.url || null,
            level: frag?.level ?? null,
            durationSeconds: frag?.duration || null,
            loadMs: start > 0 && end >= start ? Math.round(end - start) : null,
            sizeBytes: Number(stats?.loaded || 0) || null,
          });
          emitPlaybackMetric('hlsFragLoaded', {
            url: frag?.url || null,
            level: frag?.level ?? null,
          });
        });
        hls.on(Hls.Events.FRAG_LOADING, (_event, data: { frag?: FragmentWithOptionalStats }) => {
          markStartupProgress('segment_loading', {
            level: data.frag?.level ?? null,
          });
          const frag = data.frag as FragmentWithOptionalStats | undefined;
          emitPlaybackMetric('hlsFragLoading', {
            url: frag?.url || null,
            level: frag?.level ?? null,
            durationSeconds: frag?.duration || null,
          });
        });

        hls.on(Hls.Events.ERROR, (_event, data: {
          fatal?: boolean;
          type?: string | null;
          details?: string | null;
        }) => {
          console.warn('[video-playback] hls error', {
            title,
            src,
            fatal: Boolean(data?.fatal),
            type: data?.type || null,
            details: data?.details || null,
          });
          emitPlaybackMetric('hls_error', {
            fatal: Boolean(data?.fatal),
            type: data?.type || null,
            details: data?.details || null,
          });
          emitPlaybackMetric('playback_failure_classified', {
            failureClass: classifyPlaybackFailure({
              fatal: Boolean(data?.fatal),
              type: data?.type || null,
              details: data?.details || null,
            }),
            ...getStallDiagnostic({
              fatal: Boolean(data?.fatal),
              type: data?.type || null,
              details: data?.details || null,
            }),
          });
          emitPlaybackMetric(Boolean(data?.fatal) ? 'hlsFatalError' : 'hlsError', {
            fatal: Boolean(data?.fatal),
            type: data?.type || null,
            details: data?.details || null,
          });
          const isBufferStallOnly = data?.details === HLS_BUFFER_STALLED_ERROR && !data?.fatal;
          if (isBufferStallOnly) {
            emitPlaybackMetric('buffer_stall_observed', {
              type: data?.type || null,
              details: data?.details || null,
            });
            return;
          }

          const startupTimeoutLikeError = !firstFrameReachedRef.current && (
            data?.details === 'manifestLoadTimeOut'
            || data?.details === 'levelLoadTimeOut'
            || data?.details === 'fragLoadTimeOut'
          );
          if (startupTimeoutLikeError) {
            if (startupNativeRecoveryInFlightRef.current) {
              emitPlaybackMetric('startup_native_recovery_pending', {
                reason: data?.details || 'hls_startup_timeout',
                attempt: startupNativeRecoveryCountRef.current,
              });
              return;
            }
            if (startupNativeRecoveryCountRef.current < MAX_HLS_NATIVE_RECOVERY_ATTEMPTS) {
              startupNativeRecoveryCountRef.current += 1;
              startupNativeRecoveryInFlightRef.current = true;
              const restartPositionSeconds = Math.max(
                Number(video.currentTime || 0),
                Number(lastObservedPlaybackPositionRef.current || 0),
                Number(pendingResumeRef.current || 0),
                0,
              );
              preserveLiveResumePoint('hls-startup-error-native-recovery');
              emitPlaybackMetric('startup_native_recovery_started', {
                reason: data?.details || 'hls_startup_timeout',
                attempt: startupNativeRecoveryCountRef.current,
                restartPositionSeconds,
              });
              try {
                hls.startLoad(restartPositionSeconds);
                setLoadMessage('Reconnecting to stream…');
                scheduleStartupTimeoutCheck(STARTUP_TIMEOUT_DEFER_MS);
                return;
              } catch (nativeRecoveryError) {
                startupNativeRecoveryInFlightRef.current = false;
                emitPlaybackMetric('startup_native_recovery_failed', {
                  reason: data?.details || 'hls_startup_timeout',
                  attempt: startupNativeRecoveryCountRef.current,
                  message: nativeRecoveryError instanceof Error ? nativeRecoveryError.message : 'unknown_startup_recovery_error',
                });
              }
            }
          }

          if (Boolean(data?.fatal) && data?.type === HLS_NETWORK_ERROR && hlsNetworkRecoveryCountRef.current < MAX_HLS_NATIVE_RECOVERY_ATTEMPTS) {
            hlsNetworkRecoveryCountRef.current += 1;
            const restartPositionSeconds = Math.max(
              Number(video.currentTime || 0),
              Number(lastObservedPlaybackPositionRef.current || 0),
              0,
            );
            emitPlaybackMetric('hls_native_network_recovery', {
              attempt: hlsNetworkRecoveryCountRef.current,
              restartPositionSeconds,
            });
            try {
              hls.startLoad(restartPositionSeconds);
              return;
            } catch (nativeRecoveryError) {
              emitPlaybackMetric('hls_native_network_recovery_failed', {
                attempt: hlsNetworkRecoveryCountRef.current,
                message: nativeRecoveryError instanceof Error ? nativeRecoveryError.message : 'unknown_network_recovery_error',
              });
            }
          }

          if (Boolean(data?.fatal) && data?.type === HLS_MEDIA_ERROR && hlsMediaRecoveryCountRef.current < MAX_HLS_NATIVE_RECOVERY_ATTEMPTS) {
            hlsMediaRecoveryCountRef.current += 1;
            emitPlaybackMetric('hls_native_media_recovery', {
              attempt: hlsMediaRecoveryCountRef.current,
              currentTimeSeconds: Math.max(Number(video.currentTime || 0), 0),
            });
            try {
              hls.recoverMediaError();
              return;
            } catch (nativeRecoveryError) {
              emitPlaybackMetric('hls_native_media_recovery_failed', {
                attempt: hlsMediaRecoveryCountRef.current,
                message: nativeRecoveryError instanceof Error ? nativeRecoveryError.message : 'unknown_media_recovery_error',
              });
            }
          }

          if (shouldFallbackToSourceFromHlsError({
            fatal: Boolean(data?.fatal),
            type: data?.type || null,
            details: data?.details || null,
          })) {
            scheduleRetry('Reconnecting…', {
              phase: firstFrameReachedRef.current ? 'general' : 'startup',
            });
          }
        });

        const cleanupMediaEvents = setupMediaEvents();
        mediaCleanupRef.current = () => {
          cleanupAutoLevelRelease?.();
          cleanupAutoLevelRelease = null;
          cleanupMediaEvents?.();
        };
        hls.loadSource(src);
        hls.attachMedia(video);
        finalizeInitialPlaybackSetup();
        return;
      }

      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        mediaCleanupRef.current = setupMediaEvents();
        video.src = src;
        video.load();
        finalizeInitialPlaybackSetup();
        return;
      }

      setLoadMessage('This browser cannot play the stream.');
    })().catch((error) => {
      if (isStaleAttach()) {
        return;
      }

      emitPlaybackMetric('player_runtime_load_failed', {
        reason,
        streamFormat: preferredStreamFormat || null,
        drmEnabled: Boolean(drmManifestUrl),
        message: error instanceof Error ? error.message : 'Unknown runtime load failure',
      });
      scheduleRetry('Video player could not be prepared. Reconnecting…', {
        phase: firstFrameReachedRef.current ? 'general' : 'startup',
      });
    });
  };

  const playVideo = async () => {
    const video = videoRef.current;
    if (!video) {
      return false;
    }

    try {
      const promise = video.play();
      if (promise && typeof promise.then === 'function') {
        await promise;
      }
      setTerminalPlaybackError('');
      setPlaybackBlockedMessage('');
      setIsReconnecting(false);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Playback could not be started.';
      console.warn('[video-playback] play() rejected', {
        title,
        src,
        trackVideoId,
        message,
      });
      setLoadMessage(message);
      return false;
    }
  };

  const pauseVideo = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    try {
      video.pause();
    } catch {
      // Ignore pause races during teardown.
    }
  };

  useImperativeHandle(ref, () => ({
    play: playVideo,
    pause: pauseVideo,
    retry: () => {
      autoRetryCountRef.current = 0;
      attachPlayer('imperative-retry');
    },
    seekTo: (seconds: number) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      const nextTime = Math.max(Number(seconds || 0), 0);
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(nextTime, video.duration);
        return;
      }

      video.currentTime = nextTime;
    },
    getCurrentTime: () => Math.max(
      Number(videoRef.current?.currentTime || 0),
      Number(stablePlaybackSnapshotRef.current.currentTime || 0),
      0,
    ),
    getDuration: () => Math.max(
      Number(videoRef.current?.duration || 0),
      Number(stablePlaybackSnapshotRef.current.durationSeconds || 0),
      0,
    ),
  }));

  const drmConfigSignature = buildDrmConfigSignature(drmConfig);

  useEffect(() => {
    isMountedRef.current = true;
    emitPlaybackMetric('player_remounted', {
      source: src,
      playbackSessionId: playbackSessionIdRef.current,
    });

    return () => {
      isMountedRef.current = false;
      destroyPlayer();
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, []);

  useEffect(() => {
    const previousPlaybackSessionId = playbackSessionIdRef.current;
    const nextPlaybackSessionId = playbackSessionId || null;
    playbackSessionIdRef.current = nextPlaybackSessionId;
    if (
      previousPlaybackSessionId
      && nextPlaybackSessionId
      && previousPlaybackSessionId !== nextPlaybackSessionId
    ) {
      emitPlaybackMetric('playback_session_rollover', {
        previousPlaybackSessionId,
        nextPlaybackSessionId,
      });
    }
  }, [playbackSessionId]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      emitPlaybackMetric('visibilitychange', {
        visibilityState: document.visibilityState,
      });
    };
    const handleFullscreenChange = () => {
      emitPlaybackMetric('fullscreenchange', {
        fullscreenElement: Boolean(document.fullscreenElement),
      });
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    attachPlayer('effect');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, autoPlay, streamFormat, drmConfigSignature]);

  useEffect(() => {
    const nextResumeSeconds = Math.max(Number(resumeSeconds || 0), 0);
    const sourceChanged = lastResumeSourceRef.current !== src;
    lastResumeSourceRef.current = src;
    const storedResumeFloor = readStoredResumeFloor();
    lastPersistedResumeFloorRef.current = Math.max(lastPersistedResumeFloorRef.current, storedResumeFloor);

    if (sourceChanged) {
      const sourceChangedSeed = Math.max(nextResumeSeconds, storedResumeFloor, 0);
      pendingResumeRef.current = sourceChangedSeed;
      lastHeartbeatPositionRef.current = sourceChangedSeed;
      lastObservedPlaybackPositionRef.current = Math.max(lastObservedPlaybackPositionRef.current, sourceChangedSeed);
      emitPlaybackMetric('resume_seed_updated', {
        reason: 'source-changed',
        resumeSeconds: sourceChangedSeed,
        externalResumeSeconds: nextResumeSeconds,
        storedResumeFloorSeconds: storedResumeFloor,
      });
      return;
    }

    const video = videoRef.current;
    const currentTime = Math.max(Number(video?.currentTime || 0), 0);
    const lastObservedSeconds = Math.max(Number(lastObservedPlaybackPositionRef.current || 0), 0);
    const lastLiveResumeSeconds = Math.max(
      currentTime,
      Number(lastCurrentTimeRef.current || 0),
      lastObservedSeconds,
      Number(pendingResumeRef.current || 0),
      Number(lastPersistedResumeFloorRef.current || 0),
      0,
    );
    const activelyPlaying = Boolean(
      video
      && (isPlayingRef.current || (!video.paused && currentTime > 0.5) || currentTime > 2),
    );

    if (activelyPlaying) {
      emitPlaybackMetric('resume_seed_ignored', {
        reason: 'active-playback',
        resumeSeconds: nextResumeSeconds,
        currentTimeSeconds: currentTime,
        previousHeartbeatPositionSeconds: lastHeartbeatPositionRef.current,
      });
      return;
    }

    if (lastLiveResumeSeconds > nextResumeSeconds + LIVE_RESUME_PERSIST_EPSILON_SECONDS) {
      emitPlaybackMetric('resume_seed_ignored', {
        reason: 'stale-external-resume',
        resumeSeconds: nextResumeSeconds,
        currentTimeSeconds: currentTime,
        lastObservedSeconds,
        preservedResumeSeconds: lastLiveResumeSeconds,
        storedResumeFloorSeconds: storedResumeFloor,
      });
      pendingResumeRef.current = lastLiveResumeSeconds;
      return;
    }

    const idleSeed = Math.max(nextResumeSeconds, storedResumeFloor, 0);
    pendingResumeRef.current = idleSeed;
    lastHeartbeatPositionRef.current = Math.max(currentTime, idleSeed);
    lastObservedPlaybackPositionRef.current = Math.max(lastObservedSeconds, currentTime, idleSeed);
    lastPersistedResumeFloorRef.current = Math.max(lastPersistedResumeFloorRef.current, idleSeed);
    emitPlaybackMetric('resume_seed_updated', {
      reason: 'idle-player',
      resumeSeconds: idleSeed,
      externalResumeSeconds: nextResumeSeconds,
      storedResumeFloorSeconds: storedResumeFloor,
      currentTimeSeconds: currentTime,
    });
  }, [playbackSessionId, resumeSeconds, src, trackCourseId, trackLessonId, trackVideoId]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onPlaybackStateChangeRef.current = onPlaybackStateChange;
  }, [onPlaybackStateChange]);

  useEffect(() => {
    onQualityOptionsChangeRef.current = onQualityOptionsChange;
  }, [onQualityOptionsChange]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    try {
      video.playbackRate = playbackSpeed;
    } catch {
      // Ignore unsupported playback rate updates.
    }
  }, [playbackSpeed]);

  useEffect(() => {
    const hls = hlsRef.current;
    const qualityOptions = qualityOptionsRef.current;
    if (!hls || !qualityOptions.length || protectedHlsStabilityMode) {
      return;
    }

    const requestedHeight = Number(
      selectedQualityHeight
      ?? getDefaultRecordedVideoQualityHeight(qualityOptions, defaultQualityHeight),
    );
    const selectedLevel = getRecordedVideoQualityLevel(qualityOptions, requestedHeight);
    if (selectedLevel < 0) {
      return;
    }

    hls.currentLevel = selectedLevel;
    hls.nextLevel = selectedLevel;
    hls.autoLevelCapping = selectedLevel;
  }, [defaultQualityHeight, protectedHlsStabilityMode, selectedQualityHeight]);

  useEffect(() => {
    return () => {
      stopHeartbeat();
      stopWatchdog();
      clearTimer(startupTimeoutRef);
      clearTimer(retryTimerRef);
    };
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      emitPlaybackMetric('fullscreen_change', {
        fullscreen: Boolean(document.fullscreenElement),
        currentTimeSeconds: Math.max(Number(videoRef.current?.currentTime || 0), 0),
      });
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  return (
    <div className={cn('relative overflow-hidden rounded-[28px] border border-[var(--line)] bg-black', className)}>
      {(isReconnecting || !src) && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 text-white">
          <div className="flex flex-col items-center gap-3 text-center">
            <LoaderCircle className="h-7 w-7 animate-spin" />
            <p className="text-sm font-semibold">{loadMessage}</p>
          </div>
        </div>
      )}
      {(playbackBlockedMessage || terminalPlaybackError) && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/92 text-white">
          <div className="flex max-w-[420px] flex-col items-center gap-3 px-6 text-center">
            <p className="text-lg font-semibold">Playback stopped</p>
            <p className="text-sm text-white/72">{playbackBlockedMessage || terminalPlaybackError}</p>
            {terminalPlaybackError && !playbackBlockedMessage ? (
              <button
                type="button"
                onClick={() => {
                  autoRetryCountRef.current = 0;
                  attachPlayer('manual-retry-button');
                }}
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-white/90"
              >
                Retry
              </button>
            ) : null}
          </div>
        </div>
      )}
      <video
        ref={videoRef}
        data-testid="resilient-hls-video"
        className="h-full min-h-[220px] w-full bg-black object-contain"
        controls={nativeControls}
        playsInline
        preload="auto"
        controlsList="nodownload noplaybackrate noremoteplayback"
        disablePictureInPicture
        disableRemotePlayback
        onContextMenu={(event) => event.preventDefault()}
        aria-label={title}
      />
    </div>
  );
});

ResilientHlsVideo.displayName = 'ResilientHlsVideo';
