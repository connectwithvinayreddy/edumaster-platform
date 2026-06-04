export type DeviceClass = 'desktop' | 'mobile';

export type VideoViewerPersona =
  | 'standard_auto'
  | 'speed_1_5'
  | 'quality_high'
  | 'quality_low'
  | 'seek_middle'
  | 'pause_resume'
  | 'refresh_resume'
  | 'partial_rewatch'
  | 'end_seek_rewatch';

export type MixedJourneyPersona =
  | 'browse_read'
  | 'video_active'
  | 'auth_session'
  | 'light_write';

type PersonaDistribution<TPersona extends string> = Array<{
  persona: TPersona;
  weight: number;
}>;

const VIDEO_PERSONA_DISTRIBUTION: PersonaDistribution<VideoViewerPersona> = [
  { persona: 'standard_auto', weight: 30 },
  { persona: 'speed_1_5', weight: 15 },
  { persona: 'quality_high', weight: 10 },
  { persona: 'quality_low', weight: 10 },
  { persona: 'seek_middle', weight: 10 },
  { persona: 'pause_resume', weight: 10 },
  { persona: 'refresh_resume', weight: 5 },
  { persona: 'partial_rewatch', weight: 5 },
  { persona: 'end_seek_rewatch', weight: 5 },
];

const MIXED_JOURNEY_DISTRIBUTION: PersonaDistribution<MixedJourneyPersona> = [
  { persona: 'browse_read', weight: 70 },
  { persona: 'video_active', weight: 15 },
  { persona: 'auth_session', weight: 10 },
  { persona: 'light_write', weight: 5 },
];

const normalizedBucket = (ordinalIndex: number) => {
  const next = Number.isFinite(ordinalIndex) ? Math.max(0, Math.trunc(ordinalIndex)) : 0;
  return next % 100;
};

const pickPersonaFromDistribution = <TPersona extends string>(
  ordinalIndex: number,
  distribution: PersonaDistribution<TPersona>,
) => {
  const bucket = normalizedBucket(ordinalIndex);
  let cursor = 0;
  for (const entry of distribution) {
    cursor += entry.weight;
    if (bucket < cursor) {
      return entry.persona;
    }
  }
  return distribution[distribution.length - 1]?.persona || distribution[0].persona;
};

export const assignVideoViewerPersona = (ordinalIndex: number) =>
  pickPersonaFromDistribution(ordinalIndex, VIDEO_PERSONA_DISTRIBUTION);

export const assignMixedJourneyPersona = (ordinalIndex: number) =>
  pickPersonaFromDistribution(ordinalIndex, MIXED_JOURNEY_DISTRIBUTION);

export const assignDeviceClass = (
  ordinalIndex: number,
  mobileRatio = 0.4,
): DeviceClass => {
  const boundedRatio = Math.max(0, Math.min(1, mobileRatio));
  if (boundedRatio <= 0) {
    return 'desktop';
  }
  if (boundedRatio >= 1) {
    return 'mobile';
  }
  return normalizedBucket(ordinalIndex) < Math.round(boundedRatio * 100) ? 'mobile' : 'desktop';
};

export const describeVideoPersona = (persona: VideoViewerPersona) => {
  switch (persona) {
    case 'standard_auto':
      return 'Watch at 1x with auto quality';
    case 'speed_1_5':
      return 'Watch at 1.5x';
    case 'quality_high':
      return 'Force highest available quality';
    case 'quality_low':
      return 'Force lowest available quality';
    case 'seek_middle':
      return 'Seek to the middle after startup';
    case 'pause_resume':
      return 'Pause and resume during playback';
    case 'refresh_resume':
      return 'Refresh and resume';
    case 'partial_rewatch':
      return 'Partially rewatch from the beginning after progress';
    case 'end_seek_rewatch':
      return 'Seek near end, complete, and reopen replay';
    default:
      return persona;
  }
};

export const describeMixedJourneyPersona = (persona: MixedJourneyPersona) => {
  switch (persona) {
    case 'browse_read':
      return 'Dashboard, courses, and test read flow';
    case 'video_active':
      return 'Recorded-video active watcher';
    case 'auth_session':
      return 'Login/session/notifications/profile-read flow';
    case 'light_write':
      return 'Profile write plus light reads';
    default:
      return persona;
  }
};
