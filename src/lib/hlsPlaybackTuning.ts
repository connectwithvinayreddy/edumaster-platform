import Hls, { ErrorDetails, ErrorTypes } from 'hls.js';

export type ConnectionStrength = 'strong' | 'moderate' | 'weak' | 'unknown';
export type RecordedVideoQualityOption = {
  label: string;
  level: number;
  height: number;
};

export const RECORDED_VIDEO_ALLOWED_HEIGHTS = [240, 360, 480, 720] as const;

export const getConnectionStrength = (): ConnectionStrength => {
  if (typeof navigator === 'undefined') {
    return 'unknown';
  }

  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } }).connection;
  if (!connection) {
    return 'unknown';
  }

  const effectiveType = String(connection.effectiveType || '').toLowerCase();
  const downlink = Number(connection.downlink || 0);

  if (effectiveType === '4g' && downlink >= 4) {
    return 'strong';
  }

  if (effectiveType === '3g' || downlink >= 1.5) {
    return 'moderate';
  }

  return 'weak';
};

const pickPreferredLevel = (
  levels: Array<{ height?: number }>,
  maxHeight: number,
) => {
  const lowToHigh = levels
    .map((level, index) => ({ index, height: Number(level.height || 0) }))
    .sort((left, right) => left.height - right.height);

  const preferred = lowToHigh.find((level) => level.height > 0 && level.height <= maxHeight) || lowToHigh[0];
  return preferred ? preferred.index : -1;
};

export const getPreferredStartupLevelIndex = (
  levels: Array<{ height?: number }>,
  connectionStrength = getConnectionStrength(),
) => {
  if (!levels.length) {
    return -1;
  }

  if (connectionStrength === 'weak') {
    return pickPreferredLevel(levels, 360);
  }

  if (connectionStrength === 'moderate') {
    return pickPreferredLevel(levels, 480);
  }

  return pickPreferredLevel(levels, 480);
};

export const createProtectedVodHlsConfig = () => {
  const connectionStrength = getConnectionStrength();
  const weakConnection = connectionStrength === 'weak';
  const moderateConnection = connectionStrength === 'moderate';

  return {
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: weakConnection ? 6 : moderateConnection ? 8 : 10,
    backBufferLength: 10,
    maxBufferSize: weakConnection ? 10 * 1000 * 1000 : 16 * 1000 * 1000,
    maxMaxBufferLength: weakConnection ? 10 : 14,
    maxBufferHole: 0.5,
    highBufferWatchdogPeriod: 1,
    nudgeOffset: 0.1,
    nudgeMaxRetry: 6,
    fragLoadingMaxRetry: 5,
    manifestLoadingMaxRetry: 5,
    levelLoadingMaxRetry: 5,
    fragLoadingRetryDelay: weakConnection ? 500 : 750,
    manifestLoadingRetryDelay: 350,
    levelLoadingRetryDelay: 350,
    abrEwmaFastVod: weakConnection ? 1.5 : 2,
    abrEwmaSlowVod: weakConnection ? 4 : 6,
    testBandwidth: !weakConnection,
    startFragPrefetch: true,
    startLevel: -1,
    autoStartLoad: true,
    capLevelToPlayerSize: true,
  };
};

export const applyPreferredStartupLevel = (
  hls: Hls,
  levels: Array<{ height?: number }>,
) => {
  const connectionStrength = getConnectionStrength();
  const preferredLevel = getPreferredStartupLevelIndex(levels, connectionStrength);

  hls.startLevel = preferredLevel >= 0 ? preferredLevel : -1;
  hls.nextLevel = preferredLevel >= 0 ? preferredLevel : -1;
  hls.autoLevelCapping = connectionStrength === 'strong' ? -1 : preferredLevel;

  return {
    connectionStrength,
    preferredLevel,
  };
};

export const scheduleAutoLevelRelease = (hls: Hls, delayMs = 1500) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const timer = window.setTimeout(() => {
    try {
      hls.nextLevel = -1;
      hls.currentLevel = -1;
      hls.autoLevelCapping = -1;
    } catch {
      // Ignore teardown races after startup.
    }
  }, Math.max(250, delayMs));

  return () => window.clearTimeout(timer);
};

export const getRecordedVideoQualityOptions = (
  levels: Array<{ height?: number }>,
  allowedHeights: readonly number[] = RECORDED_VIDEO_ALLOWED_HEIGHTS,
): RecordedVideoQualityOption[] => {
  const allowed = new Set(allowedHeights);
  const optionsByHeight = new Map<number, RecordedVideoQualityOption>();

  levels.forEach((level, index) => {
    const height = Number(level.height || 0);
    if (!allowed.has(height) || optionsByHeight.has(height)) {
      return;
    }

    optionsByHeight.set(height, {
      label: `${height}p`,
      level: index,
      height,
    });
  });

  return Array.from(optionsByHeight.values()).sort((left, right) => left.height - right.height);
};

export const getRecordedVideoQualityLevel = (
  options: RecordedVideoQualityOption[],
  targetHeight: number,
) => options.find((option) => option.height === targetHeight)?.level ?? -1;

export const getDefaultRecordedVideoQualityHeight = (
  options: RecordedVideoQualityOption[],
  preferredHeight = 480,
) => {
  if (!options.length) {
    return preferredHeight;
  }

  const exactMatch = options.find((option) => option.height === preferredHeight);
  if (exactMatch) {
    return exactMatch.height;
  }

  const nearestHigher = options.find((option) => option.height >= preferredHeight);
  return nearestHigher?.height ?? options[options.length - 1].height;
};

export const shouldFallbackToSourceFromHlsError = (data: {
  fatal?: boolean;
  type?: string | null;
  details?: string | null;
}) => Boolean(
  data?.fatal
  || data?.type === ErrorTypes.NETWORK_ERROR
  || data?.details === ErrorDetails.MANIFEST_LOAD_ERROR
  || data?.details === ErrorDetails.MANIFEST_LOAD_TIMEOUT
  || data?.details === ErrorDetails.MANIFEST_PARSING_ERROR
  || data?.details === ErrorDetails.LEVEL_LOAD_ERROR
  || data?.details === ErrorDetails.LEVEL_LOAD_TIMEOUT
  || data?.details === ErrorDetails.FRAG_LOAD_ERROR
  || data?.details === ErrorDetails.FRAG_LOAD_TIMEOUT
);
