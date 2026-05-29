import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import Hls from 'hls.js';
import shaka from 'shaka-player';
import { LoaderCircle } from 'lucide-react';
import { EduService } from '../EduService';
import { cn } from '../lib/utils';
import { type ProtectedPlaybackDrmConfig } from '../types';
import {
  createProtectedVodHlsConfig,
  getDefaultRecordedVideoQualityHeight,
  getConnectionStrength,
  getRecordedVideoQualityLevel,
  getRecordedVideoQualityOptions,
  type RecordedVideoQualityOption,
} from '../lib/hlsPlaybackTuning';

type ResilientHlsVideoProps = {
  src: string;
  title: string;
  watermarkText?: string | null;
  streamFormat?: 'source' | 'hls' | string | null;
  drmConfig?: ProtectedPlaybackDrmConfig | null;
  trackVideoId?: string | null;
  trackCourseId?: string | null;
  trackLessonId?: string | null;
  className?: string;
  autoPlay?: boolean;
  resumeSeconds?: number;
  playbackSpeed?: number;
  selectedQualityHeight?: number;
  defaultQualityHeight?: number;
  onQualityOptionsChange?: (options: RecordedVideoQualityOption[]) => void;
  onProgress?: (progressSeconds: number, durationSeconds: number, completed: boolean) => void;
  onReady?: () => void;
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

const RETRY_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 12_000;
const READY_STATE_HAVE_FUTURE_DATA = 3;

const isDirectVideoSource = (value: string) => {
  const normalized = String(value || '').toLowerCase();
  return /\.(mp4|webm|mov)(\?|$)/.test(normalized);
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

const getProtectedPlaybackHeaders = () => ({
  'x-edumaster-device-id': window.localStorage.getItem('edumaster.device.id') || '',
  'x-edumaster-client-platform': getClientPlatform(),
  'x-edumaster-client-browser': getClientBrowser(),
  'x-edumaster-app': Capacitor.isNativePlatform() ? 'capacitor' : 'web',
});

export const ResilientHlsVideo = ({
  src,
  title,
  streamFormat = null,
  drmConfig = null,
  trackVideoId = null,
  trackCourseId = null,
  trackLessonId = null,
  className,
  autoPlay = false,
  resumeSeconds = 0,
  playbackSpeed = 1,
  selectedQualityHeight,
  defaultQualityHeight = 480,
  onQualityOptionsChange,
  onProgress,
  onReady,
}: ResilientHlsVideoProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shakaPlayerRef = useRef<shaka.Player | null>(null);
  const mediaCleanupRef = useRef<(() => void) | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const watchdogTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(false);
  const isPlayingRef = useRef(false);
  const startupStartedAtRef = useRef(0);
  const startupReportedRef = useRef(false);
  const bufferingStartedAtRef = useRef<number | null>(null);
  const totalBufferMsRef = useRef(0);
  const lastProgressAtRef = useRef<number>(0);
  const lastCurrentTimeRef = useRef<number>(0);
  const onProgressRef = useRef(onProgress);
  const onReadyRef = useRef(onReady);
  const onQualityOptionsChangeRef = useRef(onQualityOptionsChange);
  const pendingResumeRef = useRef<number>(Math.max(Number(resumeSeconds || 0), 0));
  const captureWarningTimeoutRef = useRef<number | null>(null);
  const qualityOptionsRef = useRef<RecordedVideoQualityOption[]>([]);
  const [isReconnecting, setIsReconnecting] = useState(true);
  const [loadMessage, setLoadMessage] = useState<string>('Connecting to stream…');
  const [captureWarning, setCaptureWarning] = useState('');
  const [privacyShieldActive, setPrivacyShieldActive] = useState(false);

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
        usedJSHeapSize: performanceWithMemory.memory?.usedJSHeapSize || null,
        totalJSHeapSize: performanceWithMemory.memory?.totalJSHeapSize || null,
        jsHeapSizeLimit: performanceWithMemory.memory?.jsHeapSizeLimit || null,
        ...detail,
      },
    }));
  };

  const clearTimer = (timerRef: React.MutableRefObject<number | null>) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const showCaptureWarning = (message: string) => {
    setCaptureWarning(message);
    if (captureWarningTimeoutRef.current !== null) {
      window.clearTimeout(captureWarningTimeoutRef.current);
    }
    captureWarningTimeoutRef.current = window.setTimeout(() => {
      setCaptureWarning('');
      captureWarningTimeoutRef.current = null;
    }, 2600);
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

  const destroyPlayer = () => {
    stopHeartbeat();
    stopWatchdog();
    clearTimer(retryTimerRef);
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

  const sendHeartbeat = async (currentTimeSeconds: number, durationSeconds: number, completed: boolean) => {
    if (!trackVideoId) {
      return;
    }

    try {
      await EduService.trackPlaybackHeartbeat({
        videoId: trackVideoId,
        courseId: trackCourseId,
        lessonId: trackLessonId,
        currentTimeSeconds,
        durationSeconds,
        isPlaying: isPlayingRef.current,
        completed,
      });
    } catch {
      // Heartbeats should never interrupt playback.
    }
  };

  const scheduleRetry = (reason: string) => {
    if (!isMountedRef.current) {
      return;
    }

    clearTimer(retryTimerRef);
    destroyPlayer();
    emitPlaybackMetric('reconnect_scheduled', { reason, retryDelayMs: RETRY_DELAY_MS });
    setLoadMessage(reason);
    setIsReconnecting(true);
    retryTimerRef.current = window.setTimeout(() => {
      if (!isMountedRef.current) {
        return;
      }

      setLoadMessage('Reconnecting…');
      attachPlayer();
    }, RETRY_DELAY_MS);
  };

  const attachPlayer = () => {
    const video = videoRef.current;
    if (!video || !src) {
      return;
    }

    destroyPlayer();
    startupStartedAtRef.current = performance.now();
    startupReportedRef.current = false;
    bufferingStartedAtRef.current = null;
    totalBufferMsRef.current = 0;
    setIsReconnecting(true);
    setLoadMessage('Connecting to stream…');

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
          pendingResumeRef.current = 0;
        } catch {
          // Ignore early seek races until metadata is ready.
        }
      };

      const handlePlay = () => {
        isPlayingRef.current = true;
        lastProgressAtRef.current = Date.now();
        setIsReconnecting(false);
        emitPlaybackMetric('play');
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
        isPlayingRef.current = false;
        stopHeartbeat();
        emitPlaybackMetric('pause');
        void sendHeartbeat(
          Math.max(Number(video.currentTime || 0), 0),
          Math.max(Number(video.duration || 0), 0),
          Boolean(video.ended),
        );
      };

      const handleTimeUpdate = () => {
        lastCurrentTimeRef.current = Number(video.currentTime || 0);
        lastProgressAtRef.current = Date.now();
        onProgressRef.current?.(
          Math.max(Number(video.currentTime || 0), 0),
          Math.max(Number(video.duration || 0), 0),
          Boolean(video.ended || video.currentTime >= Math.max(Number(video.duration || 0) - 1, 1)),
        );
      };

      const handleEnded = () => {
        isPlayingRef.current = false;
        stopHeartbeat();
        stopWatchdog();
        emitPlaybackMetric('ended');
        void sendHeartbeat(
          Math.max(Number(video.currentTime || 0), 0),
          Math.max(Number(video.duration || 0), 0),
          true,
        );
      };

      const handleError = () => {
        emitPlaybackMetric('media_error', {
          code: video.error?.code || null,
          message: video.error?.message || null,
        });
        scheduleRetry('Stream interrupted. Reconnecting…');
      };

      const handleReady = () => {
        applyPendingResume();
        setIsReconnecting(false);
        setLoadMessage('Stream ready');
        if (!startupReportedRef.current && startupStartedAtRef.current > 0) {
          startupReportedRef.current = true;
          emitPlaybackMetric('startup_ready', {
            startupDelayMs: Math.round(performance.now() - startupStartedAtRef.current),
            readyState: video.readyState,
          });
        }
        onReadyRef.current?.();
      };

      const handleWaiting = () => {
        if (bufferingStartedAtRef.current === null) {
          bufferingStartedAtRef.current = performance.now();
          emitPlaybackMetric('buffering_start');
        }
      };

      const handlePlaying = () => {
        if (bufferingStartedAtRef.current !== null) {
          const bufferMs = Math.round(performance.now() - bufferingStartedAtRef.current);
          bufferingStartedAtRef.current = null;
          totalBufferMsRef.current += bufferMs;
          emitPlaybackMetric('buffering_end', { bufferMs });
        }
      };

      video.addEventListener('play', handlePlay);
      video.addEventListener('pause', handlePause);
      video.addEventListener('timeupdate', handleTimeUpdate);
      video.addEventListener('ended', handleEnded);
      video.addEventListener('error', handleError);
      video.addEventListener('loadeddata', handleReady);
      video.addEventListener('loadedmetadata', handleReady);
      video.addEventListener('canplay', handleReady);
      video.addEventListener('waiting', handleWaiting);
      video.addEventListener('playing', handlePlaying);

      watchdogTimerRef.current = window.setInterval(() => {
        if (!isPlayingRef.current || video.paused || video.ended) {
          return;
        }

        const currentTime = Number(video.currentTime || 0);
        const durationSeconds = Number(video.duration || 0);
        const stalledFor = Date.now() - lastProgressAtRef.current;

        if (stalledFor >= STALL_THRESHOLD_MS && currentTime === lastCurrentTimeRef.current && durationSeconds > 0) {
          emitPlaybackMetric('watchdog_stall', { stalledForMs: stalledFor });
          scheduleRetry('Playback stalled. Reconnecting…');
        }
      }, WATCHDOG_INTERVAL_MS);

      return () => {
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('timeupdate', handleTimeUpdate);
        video.removeEventListener('ended', handleEnded);
        video.removeEventListener('error', handleError);
        video.removeEventListener('loadeddata', handleReady);
        video.removeEventListener('loadedmetadata', handleReady);
        video.removeEventListener('canplay', handleReady);
        video.removeEventListener('waiting', handleWaiting);
        video.removeEventListener('playing', handlePlaying);
      };
    };

    const preferredStreamFormat = String(streamFormat || '').trim().toLowerCase();
    const drmManifestUrl = drmConfig?.enabled ? String(drmConfig.manifestUrl || '').trim() : '';
    const shouldUseDirectSource = preferredStreamFormat === 'source' || isDirectVideoSource(src);

    if (drmManifestUrl) {
      void shaka.polyfill.installAll();
      if (!shaka.Player.isBrowserSupported()) {
        setLoadMessage('This browser does not support protected playback.');
        emitPlaybackMetric('drm_unsupported_browser', {
          manifestUrl: drmManifestUrl,
          preferredKeySystem: drmConfig?.preferredKeySystem || null,
        });
        return;
      }

      const player = new shaka.Player(video);
      shakaPlayerRef.current = player;
      player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
        request.headers = {
          ...(request.headers || {}),
          ...getProtectedPlaybackHeaders(),
        };
      });

      player.addEventListener('error', (event: Event) => {
        const errorDetail = (event as CustomEvent<{ detail?: { code?: number; message?: string } }>).detail;
        emitPlaybackMetric('drm_error', {
          code: errorDetail?.detail?.code || null,
          message: errorDetail?.detail?.message || null,
          manifestUrl: drmManifestUrl,
        });
        scheduleRetry('Protected playback interrupted. Reconnecting…');
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
      void player.load(drmManifestUrl)
        .then(() => {
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
          emitPlaybackMetric('drm_load_failed', {
            manifestUrl: drmManifestUrl,
            message: error instanceof Error ? error.message : 'Unknown DRM playback error',
          });
          scheduleRetry('Protected playback could not be opened. Reconnecting…');
        });
    } else if (shouldUseDirectSource) {
      mediaCleanupRef.current = setupMediaEvents();
      video.src = src;
      video.load();
    } else if (Hls.isSupported()) {
      const hls = new Hls(createProtectedVodHlsConfig());
      hlsRef.current = hls;
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

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        const connectionStrength = getConnectionStrength();
        const qualityOptions = getRecordedVideoQualityOptions(data.levels || []);
        qualityOptionsRef.current = qualityOptions;
        onQualityOptionsChangeRef.current?.(qualityOptions);
        applyManualQualitySelection();
        setLoadMessage(connectionStrength === 'weak' ? 'Saving mobile data with lower bitrate…' : 'Stream ready');
        setIsReconnecting(false);
        emitPlaybackMetric('manifest_parsed', {
          levelCount: data.levels?.length || 0,
          selectedQualityHeight: selectedQualityHeight ?? defaultQualityHeight,
          levels: (data.levels || []).map((level) => ({
            height: level.height || null,
            bitrate: level.bitrate || null,
          })),
        });
        onReadyRef.current?.();
        if (autoPlay || video.readyState >= READY_STATE_HAVE_FUTURE_DATA) {
          void video.play().catch(() => undefined);
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        const level = hls.levels?.[data.level];
        emitPlaybackMetric('level_switched', {
          level: data.level,
          height: level?.height || null,
          bitrate: level?.bitrate || null,
        });
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
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
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        emitPlaybackMetric('hls_error', {
          fatal: Boolean(data?.fatal),
          type: data?.type || null,
          details: data?.details || null,
        });
        const fatalOrRecoverableNetworkError = Boolean(
          data?.fatal
          || data?.type === Hls.ErrorTypes.NETWORK_ERROR
          || data?.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
          || data?.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR
          || data?.details === Hls.ErrorDetails.FRAG_LOAD_ERROR
          || data?.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR,
        );

        if (fatalOrRecoverableNetworkError) {
          scheduleRetry('Reconnecting…');
        }
      });

      mediaCleanupRef.current = setupMediaEvents();
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      mediaCleanupRef.current = setupMediaEvents();
      video.src = src;
      video.load();
    } else {
      setLoadMessage('This browser cannot play the stream.');
    }

    if (autoPlay) {
      void video.play().catch(() => undefined);
    }

    try {
      video.playbackRate = playbackSpeed;
      pendingResumeRef.current = Math.max(Number(resumeSeconds || 0), 0);
      if (pendingResumeRef.current > 0 && video.readyState >= 1) {
        video.currentTime = pendingResumeRef.current;
        pendingResumeRef.current = 0;
      }
    } catch {
      // Ignore seeking/playback rate races while the video initializes.
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    attachPlayer();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, autoPlay, streamFormat, JSON.stringify(drmConfig || null)]);

  useEffect(() => {
    pendingResumeRef.current = Math.max(Number(resumeSeconds || 0), 0);
  }, [resumeSeconds, src]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

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
    if (!hls || !qualityOptions.length) {
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
  }, [defaultQualityHeight, selectedQualityHeight]);

  useEffect(() => {
    return () => {
      stopHeartbeat();
      stopWatchdog();
      clearTimer(retryTimerRef);
      if (captureWarningTimeoutRef.current !== null) {
        window.clearTimeout(captureWarningTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = String(event.key || '').toLowerCase();
      const isPrintScreen = key === 'printscreen';
      const isMacCaptureCombo = (event.metaKey || event.ctrlKey) && event.shiftKey && ['3', '4', '5'].includes(key);
      const isSaveCombo = (event.metaKey || event.ctrlKey) && key === 's';
      const isDevtoolsCombo = event.key === 'F12' || ((event.metaKey || event.ctrlKey) && event.shiftKey && ['i', 'j', 'c'].includes(key));

      if (isPrintScreen || isMacCaptureCombo || isSaveCombo || isDevtoolsCombo) {
        event.preventDefault();
        event.stopPropagation();
        showCaptureWarning('Protected video shortcuts are disabled during playback.');
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        setPrivacyShieldActive(true);
        showCaptureWarning('Protected playback was hidden while the page was not active.');
        return;
      }
      setPrivacyShieldActive(false);
    };

    const handleWindowBlur = () => {
      setPrivacyShieldActive(true);
    };

    const handleWindowFocus = () => {
      setPrivacyShieldActive(false);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
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
      {privacyShieldActive && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black text-white">
          <div className="flex max-w-[420px] flex-col items-center gap-3 px-6 text-center">
            <p className="text-lg font-semibold">Protected playback hidden</p>
            <p className="text-sm text-white/72">Return to the active player window to continue watching.</p>
          </div>
        </div>
      )}
      {captureWarning && (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
          <div className="rounded-full bg-[#111827]/88 px-4 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,0,0,0.26)]">
            {captureWarning}
          </div>
        </div>
      )}
      <video
        ref={videoRef}
        data-testid="resilient-hls-video"
        className="h-full min-h-[220px] w-full bg-black object-contain"
        controls
        playsInline
        preload="auto"
        controlsList="nodownload noplaybackrate noremoteplayback nofullscreen"
        disablePictureInPicture
        disableRemotePlayback
        onContextMenu={(event) => event.preventDefault()}
        aria-label={title}
      />
    </div>
  );
};
