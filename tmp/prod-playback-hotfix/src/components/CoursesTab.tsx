import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { BookOpen, CalendarClock, ChevronLeft, ChevronRight, Clock3, FileText, LoaderCircle, Lock, Maximize2, MessageSquare, Minimize2, PlayCircle, Radio, Search, Sparkles, Video, Wallet, X } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { ProtectedLivePlayback } from './ProtectedLivePlayback';
import { ResilientHlsVideo } from './ResilientHlsVideo';
import { EduService } from '../EduService';
import { openRazorpayCheckout } from '../lib/razorpayCheckout';
import { LIVE_CLASSES_ENABLED } from '../lib/featureFlags';
import { cn } from '../lib/utils';
import { wireHlsPlaybackMetrics } from '../lib/hlsPlaybackMetrics';
import {
  createProtectedVodHlsConfig,
  getDefaultRecordedVideoQualityHeight,
  getRecordedVideoQualityLevel,
  getRecordedVideoQualityOptions,
  type RecordedVideoQualityOption,
  scheduleAutoLevelRelease,
  shouldFallbackToSourceFromHlsError,
} from '../lib/hlsPlaybackTuning';
import { CourseCard, CourseLesson, CoursePdfAttachment, LiveClass, LiveClassAccess, PlatformOverview, ProtectedLessonPlayback } from '../types';

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const getDiscountedCoursePrice = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 1);
  const offerPercentage = Math.min(Math.max(Number(course.offerPercentage || 0), 0), 100);
  const discountedPrice = basePrice * (1 - (offerPercentage / 100));
  return Math.max(Number(discountedPrice.toFixed(2)), 1);
};

const getCoursePriceSummary = (course: CourseCard) => {
  const finalPrice = getDiscountedCoursePrice(course);
  const offerPercentage = Number(course.offerPercentage || 0);
  return offerPercentage > 0
    ? `${currency.format(finalPrice)} • ${offerPercentage}% off`
    : currency.format(finalPrice);
};

const getCourseFeeSummary = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 1);
  const finalPrice = getDiscountedCoursePrice(course);
  const offerPercentage = Number(course.offerPercentage || 0);

  return offerPercentage > 0
    ? `Course fee ${currency.format(basePrice)} • ${offerPercentage}% off • Pay ${currency.format(finalPrice)}`
    : `Course fee ${currency.format(basePrice)}`;
};

const getCourseSavingsSummary = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 1);
  const finalPrice = getDiscountedCoursePrice(course);
  const savings = Math.max(basePrice - finalPrice, 0);
  const offerPercentage = Number(course.offerPercentage || 0);

  if (offerPercentage <= 0 || savings <= 0) {
    return null;
  }

  return `You save ${currency.format(savings)} on this offer`;
};

const getCoursePricingMeta = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 1);
  const finalPrice = getDiscountedCoursePrice(course);
  const offerPercentage = Number(course.offerPercentage || 0);
  const savings = Math.max(basePrice - finalPrice, 0);
  const hasOffer = offerPercentage > 0 && savings > 0 && finalPrice < basePrice;

  return {
    basePrice,
    finalPrice,
    offerPercentage,
    savings,
    hasOffer,
  };
};

const formatPlaybackTime = (seconds: number) => {
  const safeSeconds = Math.max(Math.floor(seconds || 0), 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

const getCoursePurchaseLabel = (course: CourseCard) =>
  `Buy course for ${getCoursePriceSummary(course)}`;

const hasActiveCourseAccess = (course?: CourseCard | null) =>
  Boolean(course && (course.canAccessCourse ?? course.enrolled));

const getCourseAccessStatus = (course?: CourseCard | null) => {
  if (!course) {
    return 'not_purchased';
  }
  if (course.accessStatus) {
    return String(course.accessStatus).toLowerCase();
  }
  if (hasActiveCourseAccess(course)) {
    return 'enabled';
  }
  return course.isPurchased ? 'pending_access' : 'not_purchased';
};

const getCoursePrimaryActionLabel = (course: CourseCard, progressPercent = 0) => {
  if (hasActiveCourseAccess(course)) {
    return progressPercent > 0 ? 'Continue Learning' : 'Start Course';
  }
  const accessStatus = getCourseAccessStatus(course);
  if (accessStatus === 'expired') {
    return 'Renew Course';
  }
  if (accessStatus === 'disabled') {
    return 'Contact Support';
  }
  return 'Buy Course';
};

const shouldShowCoursePaymentButton = (course?: CourseCard | null) => {
  if (!course || hasActiveCourseAccess(course)) {
    return false;
  }
  const accessStatus = getCourseAccessStatus(course);
  return accessStatus !== 'disabled';
};

const getCourseAccessHint = (course?: CourseCard | null) => {
  if (!course) {
    return '';
  }
  if (hasActiveCourseAccess(course)) {
    return 'Tap to open subjects and lessons';
  }
  return course.accessBlockReason
    || (shouldShowCoursePaymentButton(course)
      ? 'Tap to preview details and complete payment.'
      : 'Access is not active yet. Review the status before trying again.');
};

const getCourseAccessBadgeText = (course: CourseCard) => {
  if (hasActiveCourseAccess(course)) {
    return 'Active';
  }
  const accessStatus = getCourseAccessStatus(course);
  if (accessStatus === 'expired') {
    return 'Expired';
  }
  if (accessStatus === 'disabled') {
    return 'Disabled';
  }
  if (accessStatus === 'pending_access') {
    return getCoursePriceSummary(course);
  }
  return getCoursePriceSummary(course);
};

let youtubeIframeApiPromise: Promise<void> | null = null;

const loadYouTubeIframeApi = () => {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  if ((window as any).YT?.Player) {
    return Promise.resolve();
  }

  if (youtubeIframeApiPromise) {
    return youtubeIframeApiPromise;
  }

  youtubeIframeApiPromise = new Promise<void>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-varonenglish-youtube-api="true"]');
    if (existing) {
      const previous = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.varonenglishYoutubeApi = 'true';

    const previous = (window as any).onYouTubeIframeAPIReady;
    (window as any).onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };

    document.body.appendChild(script);
  });

  return youtubeIframeApiPromise;
};

const getYouTubeVideoIdFromEmbedUrl = (embedUrl?: string | null) => {
  if (!embedUrl) {
    return null;
  }

  try {
    const url = new URL(embedUrl);
    const candidate = url.pathname.split('/').filter(Boolean).pop();
    return candidate || null;
  } catch {
    return null;
  }
};

const isDemoPreviewLesson = (lesson?: CourseLesson | null) =>
  Boolean(
    lesson
    && !lesson.locked
    && !lesson.premium
    && ['youtube', 'private-video', 'video'].includes(String(lesson.type || '')),
  );

const buildSequentialAccessMap = (
  course: CourseCard | null,
  lessonProgressMap: Map<string, ResumeRecord>,
  hasCourseAccess: boolean,
) => {
  const accessMap = new Map<string, { unlocked: boolean; reason: string | null }>();
  const lessonEntries = getModuleLessonEntries(course);
  const accessMode = String(course?.courseVideoAccessMode || 'free_order').toLowerCase();

  lessonEntries.forEach((entry, index) => {
    if (!hasCourseAccess) {
      if (isDemoPreviewLesson(entry.lesson)) {
        accessMap.set(entry.lesson.id, {
          unlocked: true,
          reason: 'Demo preview available before purchase.',
        });
        return;
      }

      accessMap.set(entry.lesson.id, {
        unlocked: false,
        reason: 'Enroll in this course to access the lesson player.',
      });
      return;
    }

    if (accessMode !== 'sequential') {
      accessMap.set(entry.lesson.id, { unlocked: true, reason: null });
      return;
    }

    if (index === 0) {
      accessMap.set(entry.lesson.id, { unlocked: true, reason: null });
      return;
    }

    const currentProgress = lessonProgressMap.get(entry.lesson.id);
    if (currentProgress?.completed) {
      accessMap.set(entry.lesson.id, { unlocked: true, reason: null });
      return;
    }

    const previousLessonId = lessonEntries[index - 1]?.lesson.id;
    const previousProgress = previousLessonId ? lessonProgressMap.get(previousLessonId) : null;
    const previousUnlocked = Boolean(previousProgress?.completed || Number(previousProgress?.progressPercent || 0) >= 90);
    accessMap.set(entry.lesson.id, {
      unlocked: previousUnlocked,
      reason: previousUnlocked ? null : 'Finish the previous topic to unlock this lesson.',
    });
  });

  return accessMap;
};

const ProtectedYouTubePlayer = ({
  embedUrl,
  lessonId,
  title,
  playbackSpeed,
  resumeSeconds,
  onProgress,
}: {
  embedUrl: string;
  lessonId: string;
  title: string;
  playbackSpeed: number;
  resumeSeconds: number;
  onProgress: (progressSeconds: number, durationSeconds: number, completed: boolean) => void;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const progressIntervalRef = useRef<number | null>(null);
  const onProgressRef = useRef(onProgress);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    const videoId = getYouTubeVideoIdFromEmbedUrl(embedUrl);
    if (!containerRef.current || !videoId) {
      return;
    }

    let cancelled = false;

    const clearProgressInterval = () => {
      if (progressIntervalRef.current !== null) {
        window.clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };

    const startProgressInterval = () => {
      clearProgressInterval();
      progressIntervalRef.current = window.setInterval(() => {
        const player = playerRef.current;
        if (!player?.getCurrentTime || !player?.getDuration) {
          return;
        }

        const progressSeconds = Number(player.getCurrentTime() || 0);
        const durationSeconds = Number(player.getDuration() || 0);
        onProgressRef.current(progressSeconds, durationSeconds, false);
      }, 10000);
    };

    void loadYouTubeIframeApi().then(() => {
      if (cancelled || !containerRef.current) {
        return;
      }

      playerRef.current = new (window as any).YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          iv_load_policy: 3,
          disablekb: 1,
          fs: 0,
          controls: 1,
          cc_load_policy: 1,
          start: Math.max(Math.floor(resumeSeconds || 0), 0),
        },
        events: {
          onReady: (event: any) => {
            try {
              if (resumeSeconds > 0) {
                event.target.seekTo(resumeSeconds, true);
              }
              event.target.setPlaybackRate(playbackSpeed);
            } catch {
              // Ignore player readiness race conditions.
            }
          },
          onStateChange: (event: any) => {
            const player = event.target;
            const playerState = (window as any).YT?.PlayerState;

            if (event.data === playerState?.PLAYING) {
              startProgressInterval();
              return;
            }

            if (event.data === playerState?.PAUSED) {
              clearProgressInterval();
              onProgressRef.current(Number(player.getCurrentTime?.() || 0), Number(player.getDuration?.() || 0), false);
              return;
            }

            if (event.data === playerState?.ENDED) {
              clearProgressInterval();
              onProgressRef.current(Number(player.getDuration?.() || 0), Number(player.getDuration?.() || 0), true);
              return;
            }

            if (event.data === playerState?.BUFFERING) {
              return;
            }

            clearProgressInterval();
          },
        },
      });
    });

    return () => {
      cancelled = true;
      clearProgressInterval();

      const player = playerRef.current;
      if (player?.getCurrentTime && player?.getDuration) {
        onProgressRef.current(Number(player.getCurrentTime() || 0), Number(player.getDuration() || 0), false);
      }

      try {
        player?.destroy?.();
      } catch {
        // Ignore destroy errors during fast navigation.
      }
      playerRef.current = null;
    };
  }, [embedUrl, lessonId, resumeSeconds]);

  useEffect(() => {
    try {
      playerRef.current?.setPlaybackRate?.(playbackSpeed);
    } catch {
      // Ignore unsupported playback rate updates.
    }
  }, [playbackSpeed]);

  return (
    <div className="relative aspect-video w-full bg-black">
      <div ref={containerRef} className="h-full w-full" aria-label={title} />
    </div>
  );
};

const SectionHeader = ({ title, caption }: { title: string; caption: string }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--ink-soft)]">{caption}</p>
      <h2 className="mt-2 text-xl font-semibold text-[var(--ink)] sm:text-2xl">{title}</h2>
    </div>
  </div>
);

const FilterChip = ({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      'rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition',
      active
        ? 'border-[var(--accent-rust)] bg-[#fff1e7] text-[var(--accent-rust)] shadow-[0_10px_20px_rgba(201,106,43,0.12)]'
        : 'border-white/80 bg-white/82 text-[var(--ink-soft)] hover:border-[var(--accent-rust)]/30 hover:text-[var(--ink)]',
    )}
  >
    {label}
  </button>
);

const StudyMetric = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) => (
  <div className="rounded-[22px] border border-white/75 bg-white/88 p-4 shadow-[0_16px_30px_rgba(15,23,42,0.05)] backdrop-blur">
    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{label}</p>
    <p className="mt-3 text-2xl font-semibold text-[var(--ink)]">{value}</p>
    <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{hint}</p>
  </div>
);

const QuickActionTile = ({
  title,
  description,
  icon: Icon,
  onClick,
  accent = false,
  testId,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  accent?: boolean;
  testId?: string;
}) => (
  <button
    onClick={onClick}
    data-testid={testId}
    className={cn(
      'flex w-full items-start justify-between gap-4 rounded-[22px] border p-4 text-left transition duration-200 hover:-translate-y-0.5',
      accent
        ? 'border-[var(--accent-rust)]/20 bg-[linear-gradient(135deg,#fff6ee_0%,#fffdf9_100%)] shadow-[0_18px_30px_rgba(201,106,43,0.10)]'
        : 'border-[var(--line)] bg-white hover:border-[var(--accent-rust)]/25 hover:shadow-[0_16px_28px_rgba(15,23,42,0.06)]',
    )}
  >
    <div className="min-w-0">
      <p className="text-base font-semibold text-[var(--ink)]">{title}</p>
      <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{description}</p>
    </div>
    <div className={cn(
      'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl',
      accent ? 'bg-[var(--accent-rust)] text-white' : 'bg-[var(--accent-cream)] text-[var(--accent-rust)]',
    )}>
      <Icon className="h-5 w-5" />
    </div>
  </button>
);

const buildResumeStorageKey = (userId: string, courseId: string) => `varonenglish.resume.${userId}.${courseId}`;

type ResumeRecord = {
  lessonId: string;
  progressPercent: number;
  progressSeconds: number;
  completed: boolean;
  updatedAt: string;
};

type WindowWithProgressFlush = Window & {
  __varonenglishFlushProgress?: () => Promise<void>;
};

type PlaybackSnapshot = {
  lesson: CourseLesson | null;
  courseId: string | null;
  canAccess: boolean;
  progressSeconds: number;
  mediaDurationSeconds: number;
  completed: boolean;
};

const readResumeCache = (userId: string, courseId: string) => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(buildResumeStorageKey(userId, courseId));
    return raw ? JSON.parse(raw) as Record<string, ResumeRecord> : {};
  } catch {
    return {};
  }
};

const writeResumeCache = (
  userId: string,
  courseId: string,
  value: Record<string, ResumeRecord>,
) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(buildResumeStorageKey(userId, courseId), JSON.stringify(value));
  } catch {
    // Ignore storage write failures and rely on backend progress.
  }
};

const seekHostedVideoToResume = (
  media: HTMLVideoElement,
  lessonId: string,
  resumeSeconds: number,
  appliedResumeRef: React.MutableRefObject<Record<string, number>>,
) => {
  const safeResumeSeconds = Math.max(Math.floor(resumeSeconds || 0), 0);
  if (!lessonId || safeResumeSeconds <= 0) {
    return;
  }

  const mediaDuration = Number.isFinite(media.duration) ? media.duration : 0;
  const maxSeekTarget = mediaDuration > 2 ? mediaDuration - 1 : mediaDuration;
  const targetSeconds = mediaDuration > 0
    ? Math.min(safeResumeSeconds, Math.max(maxSeekTarget, 0))
    : safeResumeSeconds;

  if (targetSeconds <= 0) {
    return;
  }

  const previouslyApplied = appliedResumeRef.current[lessonId] || 0;
  if (Math.abs(previouslyApplied - targetSeconds) < 1 && Math.abs(media.currentTime - targetSeconds) < 1) {
    return;
  }

  const applySeek = () => {
    try {
      if (Math.abs(media.currentTime - targetSeconds) > 1) {
        media.currentTime = targetSeconds;
      }
      appliedResumeRef.current[lessonId] = targetSeconds;
    } catch {
      // Ignore transient seek failures until metadata is ready enough.
    }
  };

  applySeek();
  window.requestAnimationFrame(applySeek);
  window.setTimeout(applySeek, 120);
  window.setTimeout(applySeek, 400);
};

const getModuleLessonEntries = (course: CourseCard | null) =>
  (course?.modules || []).flatMap((module) => ([
    ...(module.lessons || []).map((lesson) => ({
      lesson,
      moduleTitle: module.title,
      chapterTitle: null as string | null,
    })),
    ...((module.chapters || []).flatMap((chapter) =>
      (chapter.lessons || []).map((lesson) => ({
        lesson,
        moduleTitle: module.title,
        chapterTitle: chapter.title,
      })))),
  ]));

const buildLegacyNotesAttachment = (lesson: CourseLesson): CoursePdfAttachment | null =>
  lesson.notesUrl
    ? {
      id: `legacy-notes:${lesson.id}`,
      title: 'Lesson notes PDF',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      fileSize: null,
      premium: Boolean(lesson.premium),
      scope: 'lesson',
    }
    : null;

const getCourseProgressSnapshot = (
  course: CourseCard,
  overrides: Record<string, ResumeRecord> = {},
) => {
  const lessonEntries = getModuleLessonEntries(course);
  const totalLessons = lessonEntries.length;
  const mergedProgress = new Map<string, ResumeRecord>();

  (course.lessonProgress || []).forEach((entry) => {
    mergedProgress.set(entry.lessonId, entry);
  });

  Object.values(overrides).forEach((entry) => {
    mergedProgress.set(entry.lessonId, entry);
  });

  const completedLessons = lessonEntries.filter((entry) => mergedProgress.get(entry.lesson.id)?.completed).length;
  const progressPercent = totalLessons === 0
    ? 0
    : Math.round(
      lessonEntries.reduce((sum, entry) => sum + Number(mergedProgress.get(entry.lesson.id)?.progressPercent || 0), 0) / totalLessons,
    );

  return {
    totalLessons,
    completedLessons,
    progressPercent,
  };
};

const getLiveRecordingGroups = (course: CourseCard | null, liveClasses: LiveClass[]) => {
  if (!course) {
    return [];
  }

  const grouped = new Map<string, {
    key: string;
    moduleId: string | null;
    moduleTitle: string;
    chapterId: string | null;
    chapterTitle: string | null;
    recordings: LiveClass[];
  }>();

  liveClasses
    .filter((liveClass) => {
      const status = String(liveClass.status || '').toLowerCase();
      return liveClass.courseId === course._id
        && ['ended', 'replay'].includes(status || 'ended');
    })
    .forEach((liveClass) => {
      const key = `${liveClass.moduleId || 'course'}::${liveClass.chapterId || 'root'}`;
      const group = grouped.get(key) || {
        key,
        moduleId: liveClass.moduleId || null,
        moduleTitle: liveClass.moduleTitle || course.subject || 'Course recordings',
        chapterId: liveClass.chapterId || null,
        chapterTitle: liveClass.chapterTitle || null,
        recordings: [],
      };
      group.recordings.push(liveClass);
      grouped.set(key, group);
    });

  return Array.from(grouped.values()).sort((left, right) => left.moduleTitle.localeCompare(right.moduleTitle));
};

const formatSessionDateTime = (value?: string | null) => {
  if (!value) {
    return 'Schedule pending';
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
};

const getLiveClassState = (liveClass: LiveClass) => String(liveClass.status || liveClass.mode || '').toLowerCase();

const getLiveClassLabel = (liveClass: LiveClass) => {
  const state = getLiveClassState(liveClass);

  if (state === 'live') {
    return 'Live now';
  }

  if (state === 'scheduled') {
    return 'Upcoming';
  }

  if (liveClass.replayReady) {
    return 'Recording ready';
  }

  return 'Recording';
};

const getLiveClassChipClasses = (liveClass: LiveClass) => {
  const state = getLiveClassState(liveClass);

  if (state === 'live') {
    return 'bg-[#fde8e8] text-[#d94141]';
  }

  if (state === 'scheduled') {
    return 'bg-[#f4f7fb] text-[#607089]';
  }

  return 'bg-[#eef7ff] text-[#2484d8]';
};

const getLiveClassContextLabel = (liveClass: LiveClass, fallback: string) =>
  [liveClass.moduleTitle, liveClass.chapterTitle].filter(Boolean).join(' • ')
  || liveClass.topicTags?.[0]
  || fallback;

const getLiveClassFilter = (liveClass: LiveClass): 'live' | 'upcoming' | 'recorded' => {
  const state = getLiveClassState(liveClass);
  if (state === 'live') {
    return 'live';
  }
  if (state === 'scheduled') {
    return 'upcoming';
  }
  return 'recorded';
};

const getLiveClassActionLabel = (liveClass: LiveClass | null) => {
  if (!liveClass) {
    return 'Open session';
  }

  const state = getLiveClassState(liveClass);
  if (state === 'live') {
    return 'Join live class';
  }
  if (state === 'scheduled') {
    return 'View schedule';
  }
  return 'Watch recording';
};

const formatSessionDuration = (durationMinutes?: number | null) => {
  if (!durationMinutes) {
    return 'Duration pending';
  }

  return `${durationMinutes} min${durationMinutes === 1 ? '' : 's'}`;
};

const getStandaloneModuleLessonEntries = (module: CourseCard['modules'][number] | null) =>
  module
    ? [
      ...(module.lessons || []).map((lesson) => ({
        lesson,
        chapterTitle: null as string | null,
      })),
      ...((module.chapters || []).flatMap((chapter) =>
        (chapter.lessons || []).map((lesson) => ({
          lesson,
          chapterTitle: chapter.title,
        })))),
    ]
    : [];

const getModuleProgressSnapshot = (
  module: CourseCard['modules'][number] | null,
  lessonProgressMap: Map<string, ResumeRecord>,
) => {
  const entries = getStandaloneModuleLessonEntries(module);
  const totalLessons = entries.length;
  const completedLessons = entries.filter((entry) => lessonProgressMap.get(entry.lesson.id)?.completed).length;
  const progressPercent = totalLessons === 0
    ? 0
    : Math.round(entries.reduce((sum, entry) => sum + Number(lessonProgressMap.get(entry.lesson.id)?.progressPercent || 0), 0) / totalLessons);

  return {
    totalLessons,
    completedLessons,
    progressPercent,
  };
};

const findLessonLocation = (course: CourseCard | null, lessonId: string | null) => {
  if (!course || !lessonId) {
    return null;
  }

  for (const module of course.modules || []) {
    const directLesson = (module.lessons || []).find((lesson) => lesson.id === lessonId);
    if (directLesson) {
      return {
        module,
        chapter: null,
        lesson: directLesson,
      };
    }

    for (const chapter of module.chapters || []) {
      const chapterLesson = (chapter.lessons || []).find((lesson) => lesson.id === lessonId);
      if (chapterLesson) {
        return {
          module,
          chapter,
          lesson: chapterLesson,
        };
      }
    }
  }

  return null;
};

const CourseLessonItem = ({
  lesson,
  selected,
  isSaved,
  isCompleted,
  isLastWatched,
  lessonProgressPercent,
  lessonAccessReason,
  lessonSequentiallyUnlocked,
  onSelect,
  onSave,
}: {
  lesson: CourseLesson;
  selected: boolean;
  isSaved: boolean;
  isCompleted: boolean;
  isLastWatched: boolean;
  lessonProgressPercent: number;
  lessonAccessReason: string | null;
  lessonSequentiallyUnlocked: boolean;
  onSelect: () => void;
  onSave: () => void;
}) => {
  const actionLabel = lesson.locked
    ? 'Locked'
    : ['youtube', 'private-video'].includes(lesson.type) && !lessonSequentiallyUnlocked
      ? 'Unlock next'
      : isCompleted
        ? 'Rewatch'
        : 'Open';

  const lessonKindLabel = ['youtube', 'private-video', 'video'].includes(lesson.type) ? 'Video' : 'Practice';
  const isSelectable = !lesson.locked || lessonSequentiallyUnlocked;

  return (
    <div className={cn(
      'rounded-[20px] border px-4 py-4 transition',
      selected
        ? 'border-[#8ec5ff] bg-[#edf5ff] shadow-[0_10px_28px_rgba(58,112,173,0.12)]'
        : 'border-[#e4ebf3] bg-white hover:border-[#bfd0e2]',
    )}>
      <div className="flex items-start gap-3">
        <button
          onClick={onSelect}
          data-testid={`course-topic-${lesson.id}`}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-3 text-left',
            !isSelectable && 'opacity-90',
          )}
        >
          <div className={cn(
            'flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px] text-xs font-semibold text-white',
            lessonKindLabel === 'Video'
              ? 'bg-[linear-gradient(135deg,#ff8b8b,#e85d75)]'
              : 'bg-[linear-gradient(135deg,#7cb9ff,#5b7cff)]',
          )}>
            {lessonKindLabel}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {['youtube', 'private-video'].includes(lesson.type) ? <PlayCircle className="h-4 w-4 text-[#4b76b3]" /> : lesson.premium ? <Lock className="h-4 w-4 text-[#4b76b3]" /> : <BookOpen className="h-4 w-4 text-[#4b76b3]" />}
              <p className="line-clamp-2 text-[1rem] font-semibold leading-6 text-[#172033]">{lesson.title}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[#6e7e95]">
              <span>{lesson.durationMinutes} mins</span>
              <span className="text-[#bcc8d5]">•</span>
              <span>{actionLabel}</span>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#dfe9f3]">
                <div
                  className={cn('h-full rounded-full', isCompleted ? 'bg-[var(--success)]' : 'bg-[#2d8cff]')}
                  style={{ width: `${Math.min(Math.max(lessonProgressPercent, 0), 100)}%` }}
                />
              </div>
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6e7e95]">{lessonProgressPercent}%</span>
            </div>
          </div>
        </button>
        <button
          onClick={onSave}
          className="shrink-0 rounded-full border border-[#d1dce8] bg-white px-3 py-2 text-xs font-semibold text-[#172033] transition hover:border-[#4b76b3]"
        >
          {isSaved ? 'Saved' : 'Save'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isCompleted && <span className="rounded-full bg-[#dcfce7] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0f8a43]">Completed</span>}
        {!isCompleted && isLastWatched && <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#172033]">Resume</span>}
        {!lessonSequentiallyUnlocked && lessonAccessReason && !lesson.locked && (
          <span className="rounded-full bg-[#fff0ea] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--accent-rust)]">
            Locked next
          </span>
        )}
      </div>

      {!lessonSequentiallyUnlocked && lessonAccessReason && !lesson.locked && (
        <p className="mt-3 text-xs leading-5 text-[var(--accent-rust)]">{lessonAccessReason}</p>
      )}
    </div>
  );
};

const PlayerRailLessonItem = ({
  lesson,
  chapterTitle,
  selected,
  completed,
  order,
  onSelect,
}: {
  lesson: CourseLesson;
  chapterTitle?: string | null;
  selected: boolean;
  completed: boolean;
  order: number;
  onSelect: () => void;
}) => (
  <button
    onClick={onSelect}
    data-testid={`course-lesson-${lesson.id}`}
    className={cn(
      'w-full border-b border-[#eef2f7] px-4 py-4 text-left transition',
      selected ? 'bg-[#edf5ff]' : 'bg-white hover:bg-[#f8fbff]',
    )}
  >
    <div className="flex items-start gap-3">
      <div className={cn(
        'mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        completed ? 'bg-[#22c55e] text-white' : selected ? 'bg-[#22c7f2] text-white' : 'bg-[#f3f6fb] text-[#607089]',
      )}>
        {order}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-base font-semibold leading-6 text-[#172033]">{lesson.title}</p>
        <p className="mt-1 text-sm text-[#7b8ba2]">{lesson.durationMinutes} mins</p>
        {chapterTitle && <p className="mt-1 text-xs font-medium uppercase tracking-[0.14em] text-[#9aa9bb]">{chapterTitle}</p>}
      </div>
    </div>
  </button>
);

export const CoursesTab = ({
  overview,
  onRefresh,
  initialCourseId,
  initialLessonId,
  onResumeNavigationHandled,
  savedTopicIds,
  onToggleSavedTopic,
}: {
  overview: PlatformOverview;
  onRefresh: () => Promise<void>;
  initialCourseId?: string | null;
  initialLessonId?: string | null;
  onResumeNavigationHandled?: () => void;
  savedTopicIds: string[];
  onToggleSavedTopic: (courseId: string, lessonId: string) => void;
}) => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const enrolledCourses = useMemo(
    () => overview.courses.filter((course) => hasActiveCourseAccess(course)),
    [overview.courses],
  );
  const enrolledCourseCount = useMemo(
    () => enrolledCourses.length,
    [enrolledCourses],
  );
  const defaultCourseId = initialCourseId || null;
  const [lessonProgressOverrides, setLessonProgressOverrides] = useState<Record<string, {
    lessonId: string;
    progressPercent: number;
    progressSeconds: number;
    completed: boolean;
    updatedAt: string;
  }>>({});
  const [courseView, setCourseView] = useState<'my' | 'catalog'>(enrolledCourseCount > 0 ? 'my' : 'catalog');
  const [courseQuery, setCourseQuery] = useState('');
  const [accessFilter, setAccessFilter] = useState<'all' | 'unlocked' | 'premium'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(defaultCourseId);
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(initialLessonId || null);
  const [courseWorkspaceTab, setCourseWorkspaceTab] = useState<'dashboard' | 'subjects' | 'player' | 'sessions'>(initialLessonId ? 'player' : 'dashboard');
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [busyCourseId, setBusyCourseId] = useState<string | null>(null);
  const [courseAccessMessage, setCourseAccessMessage] = useState<string | null>(null);
  const [lessonDoubt, setLessonDoubt] = useState('');
  const [lessonDoubtAnswer, setLessonDoubtAnswer] = useState<string | null>(null);
  const [askingLessonDoubt, setAskingLessonDoubt] = useState(false);
  const [protectedLessonPlayback, setProtectedLessonPlayback] = useState<ProtectedLessonPlayback | null>(null);
  const [loadingProtectedLesson, setLoadingProtectedLesson] = useState(false);
  const [protectedLessonError, setProtectedLessonError] = useState<string | null>(null);
  const [useProtectedSourceFallback, setUseProtectedSourceFallback] = useState(false);
  const [privateVideoQualityOptions, setPrivateVideoQualityOptions] = useState<RecordedVideoQualityOption[]>([]);
  const [selectedPrivateVideoQuality, setSelectedPrivateVideoQuality] = useState<number>(480);
  const [courseCaptureWarning, setCourseCaptureWarning] = useState('');
  const [coursePrivacyShieldActive, setCoursePrivacyShieldActive] = useState(false);
  const [selectedRecordingId, setSelectedRecordingId] = useState<string | null>(null);
  const [selectedRecordingAccess, setSelectedRecordingAccess] = useState<LiveClassAccess | null>(null);
  const [loadingRecordingAccess, setLoadingRecordingAccess] = useState(false);
  const [recordingAccessError, setRecordingAccessError] = useState<string | null>(null);
  const [securityBlocked, setSecurityBlocked] = useState(false);
  const [studySidebarTab, setStudySidebarTab] = useState<'notes' | 'assistant'>('notes');
  const [activePdfAttachment, setActivePdfAttachment] = useState<CoursePdfAttachment | null>(null);
  const [activePdfUrl, setActivePdfUrl] = useState<string | null>(null);
  const [loadingPdfId, setLoadingPdfId] = useState<string | null>(null);
  const [pdfViewerError, setPdfViewerError] = useState<string | null>(null);
  const [sessionViewFilter, setSessionViewFilter] = useState<'all' | 'live' | 'upcoming' | 'recorded'>('all');
  const [showReplayPlayer, setShowReplayPlayer] = useState(false);
  const [isPlayerFullscreen, setIsPlayerFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerViewportRef = useRef<HTMLDivElement | null>(null);
  const courseWorkspaceSectionRef = useRef<HTMLDivElement | null>(null);
  const pendingWorkspaceScrollRef = useRef(false);
  const hlsRef = useRef<Hls | null>(null);
  const lastProgressSyncRef = useRef<Record<string, number>>({});
  const appliedResumeRef = useRef<Record<string, number>>({});
  const activeCourseIdRef = useRef<string | null>(selectedCourseId);
  const playbackSnapshotRef = useRef<PlaybackSnapshot>({
    lesson: null,
    courseId: null,
    canAccess: false,
    progressSeconds: 0,
    mediaDurationSeconds: 0,
    completed: false,
  });
  const latestPersistRef = useRef<{
    persist: ((
      courseId: string,
      canAccess: boolean,
      lesson: CourseLesson,
      progressSeconds: number,
      completed: boolean,
      force?: boolean,
      mediaDurationSeconds?: number,
    ) => Promise<void>) | null;
  }>({ persist: null });
  const latestSelectionRef = useRef<{
    lesson: CourseLesson | null;
    courseId: string | null;
    canAccess: boolean;
  }>({ lesson: null, courseId: null, canAccess: false });
  const deferredCourseQuery = useDeferredValue(courseQuery);
  const categories = useMemo(
    () => ['all', ...Array.from(new Set(overview.courses.map((course) => course.category).filter(Boolean)))],
    [overview.courses],
  );
  const visibleCoursePool = useMemo(
    () => {
      if (courseView === 'catalog') {
        return overview.courses;
      }

      if (!isAdmin) {
        return enrolledCourses;
      }

      const focusedCourse = selectedCourseId
        ? overview.courses.find((course) => course._id === selectedCourseId)
        : null;

      if (focusedCourse && !hasActiveCourseAccess(focusedCourse) && !enrolledCourses.some((course) => course._id === focusedCourse._id)) {
        return [focusedCourse, ...enrolledCourses];
      }

      return enrolledCourses;
    },
    [courseView, enrolledCourses, isAdmin, overview.courses, selectedCourseId],
  );
  const filteredCourses = useMemo(() => {
    const normalizedQuery = deferredCourseQuery.trim().toLowerCase();

    return visibleCoursePool.filter((course) => {
      const matchesQuery = !normalizedQuery || [
        course.title,
        course.subject,
        course.category,
        course.exam,
        course.instructor,
      ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));

      const matchesAccess = courseView === 'my'
        ? true
        : accessFilter === 'all'
        || (accessFilter === 'unlocked' && hasActiveCourseAccess(course))
        || (accessFilter === 'premium' && !hasActiveCourseAccess(course) && course.price > 0);

      const matchesCategory = courseView === 'my' || categoryFilter === 'all' || course.category === categoryFilter;

      return matchesQuery && matchesAccess && matchesCategory;
    });
  }, [visibleCoursePool, deferredCourseQuery, courseView, accessFilter, categoryFilter]);
  const studentPreviewCourse = useMemo(() => {
    if (isAdmin || !initialCourseId || selectedCourseId !== initialCourseId) {
      return null;
    }

    const previewCourse = overview.courses.find((course) => course._id === selectedCourseId) || null;
    return previewCourse && !hasActiveCourseAccess(previewCourse) ? previewCourse : null;
  }, [initialCourseId, isAdmin, overview.courses, selectedCourseId]);
  const isStudentCoursePreview = !isAdmin && Boolean(studentPreviewCourse);
  const courseCards = useMemo(
    () => (filteredCourses.length > 0 ? filteredCourses : studentPreviewCourse ? [studentPreviewCourse] : []),
    [filteredCourses, studentPreviewCourse],
  );
  const selectedCourse = useMemo(
    () => studentPreviewCourse || filteredCourses.find((course) => course._id === selectedCourseId) || filteredCourses[0] || null,
    [filteredCourses, selectedCourseId, studentPreviewCourse],
  );
  const selectedModule = useMemo(
    () => selectedCourse?.modules.find((module) => module.id === selectedModuleId) || selectedCourse?.modules[0] || null,
    [selectedCourse, selectedModuleId],
  );
  const selectedLessonMeta = useMemo(() => {
    if (!selectedCourse) {
      return null;
    }

    const lessons = getModuleLessonEntries(selectedCourse);

    return lessons.find((entry) => entry.lesson.id === selectedLessonId)
      || lessons.find((entry) => entry.lesson.id === selectedCourse.continueLesson?.id)
      || lessons[0]
      || null;
  }, [selectedCourse, selectedLessonId]);
  const visibleLiveClasses = LIVE_CLASSES_ENABLED ? (overview.liveClasses || []) : [];
  const selectedCourseRecordingGroups = useMemo(
    () => getLiveRecordingGroups(selectedCourse, visibleLiveClasses),
    [selectedCourse, visibleLiveClasses],
  );
  const selectedCourseRecordings = useMemo(
    () => selectedCourseRecordingGroups.flatMap((group) => group.recordings),
    [selectedCourseRecordingGroups],
  );
  const selectedCourseLiveSessions = useMemo(
    () => visibleLiveClasses.filter((liveClass) =>
      liveClass.courseId === selectedCourse?._id && getLiveClassState(liveClass) === 'live'),
    [visibleLiveClasses, selectedCourse?._id],
  );
  const selectedCourseUpcomingSessions = useMemo(
    () => visibleLiveClasses.filter((liveClass) =>
      liveClass.courseId === selectedCourse?._id && getLiveClassState(liveClass) === 'scheduled'),
    [visibleLiveClasses, selectedCourse?._id],
  );
  const selectedCourseSessions = useMemo(
    () => [...selectedCourseLiveSessions, ...selectedCourseUpcomingSessions, ...selectedCourseRecordings],
    [selectedCourseLiveSessions, selectedCourseUpcomingSessions, selectedCourseRecordings],
  );
  const filteredCourseSessions = useMemo(
    () => sessionViewFilter === 'all'
      ? selectedCourseSessions
      : selectedCourseSessions.filter((session) => getLiveClassFilter(session) === sessionViewFilter),
    [selectedCourseSessions, sessionViewFilter],
  );
  const selectedCourseSession = useMemo(
    () => selectedCourseSessions.find((item) => item._id === selectedRecordingId) || selectedCourseSessions[0] || null,
    [selectedCourseSessions, selectedRecordingId],
  );
  useEffect(() => {
    if (!LIVE_CLASSES_ENABLED && courseWorkspaceTab === 'sessions') {
      setCourseWorkspaceTab('dashboard');
    }
  }, [courseWorkspaceTab]);
  const selectedModuleEntries = useMemo(
    () => getStandaloneModuleLessonEntries(selectedModule),
    [selectedModule],
  );



  useEffect(() => {
    if (initialCourseId) {
      const targetCourse = overview.courses.find((course) => course._id === initialCourseId) || null;
      if (targetCourse) {
        setCourseView(hasActiveCourseAccess(targetCourse) ? 'my' : 'catalog');
      }
      setSelectedCourseId(initialCourseId);
    }
    if (initialLessonId) {
      setSelectedLessonId(initialLessonId);
      setCourseWorkspaceTab('player');
      setStudySidebarTab('notes');
    }
    if (initialCourseId || initialLessonId) {
      onResumeNavigationHandled?.();
    }
  }, [initialCourseId, initialLessonId, onResumeNavigationHandled, overview.courses]);

  useEffect(() => {
    if (courseView === 'my' && enrolledCourseCount === 0) {
      setCourseView('catalog');
    }
  }, [courseView, enrolledCourseCount]);

  useEffect(() => {
    if (!selectedCourse) {
      return;
    }

    const lessonIds = getModuleLessonEntries(selectedCourse).map((entry) => entry.lesson.id);
    if (selectedLessonId && lessonIds.includes(selectedLessonId)) {
      return;
    }

    setSelectedLessonId(selectedCourse.continueLesson?.id || lessonIds[0] || null);
  }, [selectedCourse, selectedLessonId]);

  useEffect(() => {
    if (!selectedCourse) {
      setSelectedModuleId(null);
      return;
    }

    const lessonLocation = findLessonLocation(selectedCourse, selectedLessonId);
    setSelectedModuleId((currentModuleId) => {
      if (currentModuleId && selectedCourse.modules.some((module) => module.id === currentModuleId)) {
        return currentModuleId;
      }

      return lessonLocation?.module.id || selectedCourse.modules[0]?.id || null;
    });
  }, [selectedCourse, selectedLessonId]);

  useEffect(() => {
    if (selectedCourseSessions.length === 0) {
      setSelectedRecordingId(null);
      setSelectedRecordingAccess(null);
      setRecordingAccessError(null);
      setLoadingRecordingAccess(false);
      return;
    }

    if (!selectedRecordingId || !selectedCourseSessions.some((item) => item._id === selectedRecordingId)) {
      setSelectedRecordingId(selectedCourseSessions[0]._id);
    }
  }, [selectedCourseSessions, selectedRecordingId]);

  useEffect(() => {
    setShowReplayPlayer(false);
  }, [selectedRecordingId, courseWorkspaceTab, selectedCourse?._id, selectedLessonId]);

  useEffect(() => {
    closePdfViewer();
  }, [selectedCourse?._id, selectedLessonId]);

  useEffect(() => () => {
    if (activePdfUrl) {
      window.URL.revokeObjectURL(activePdfUrl);
    }
  }, [activePdfUrl]);

  function closePdfViewer() {
    if (activePdfUrl) {
      window.URL.revokeObjectURL(activePdfUrl);
    }
    setActivePdfUrl(null);
    setActivePdfAttachment(null);
    setPdfViewerError(null);
    setLoadingPdfId(null);
  }

  const openPdfAttachment = async (attachment: CoursePdfAttachment) => {
    if (!selectedCourse || !selectedLesson) {
      return;
    }

    setPdfViewerError(null);
    setLoadingPdfId(attachment.id);
    try {
      if (attachment.id.startsWith('legacy-notes:') && selectedLesson.notesUrl) {
        setActivePdfAttachment(attachment);
        setActivePdfUrl(`${selectedLesson.notesUrl}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`);
        return;
      }

      const blob = await EduService.fetchProtectedCoursePdf(selectedCourse._id, attachment.id);
      if (activePdfUrl) {
        window.URL.revokeObjectURL(activePdfUrl);
      }
      const objectUrl = window.URL.createObjectURL(blob);
      setActivePdfAttachment(attachment);
      setActivePdfUrl(`${objectUrl}#toolbar=0&navpanes=0&scrollbar=1&view=FitH`);
    } catch (error) {
      setPdfViewerError(error instanceof Error ? error.message : 'Unable to open this PDF right now.');
    } finally {
      setLoadingPdfId(null);
    }
  };

  const handleUnlock = async (course: CourseCard) => {
    if (!user) {
      return;
    }

    const openUnlockedCourse = (targetCourse: CourseCard) => {
      const firstLessonEntry = getModuleLessonEntries(targetCourse)[0] || null;
      const firstLessonLocation = firstLessonEntry ? findLessonLocation(targetCourse, firstLessonEntry.lesson.id) : null;

      pendingWorkspaceScrollRef.current = true;
      setSelectedCourseId(targetCourse._id);
      setShowReplayPlayer(false);
      setStudySidebarTab('notes');

      if (firstLessonEntry) {
        setSelectedModuleId(firstLessonLocation?.module.id || targetCourse.modules[0]?.id || null);
        setSelectedLessonId(firstLessonEntry.lesson.id);
        setCourseWorkspaceTab('player');
        return;
      }

      setSelectedModuleId(targetCourse.modules[0]?.id || null);
      setCourseWorkspaceTab('subjects');
    };

    setBusyCourseId(course._id);
    setCourseAccessMessage(null);
    try {
      const checkout = await EduService.unlockCourse(course);
      const keyId = String(import.meta.env.VITE_RAZORPAY_KEY_ID || '').trim();
      const orderId = String(checkout.order_id || '').trim();
      const amount = Number(checkout.amount || 0);
      const currencyCode = String(checkout.currency || 'INR').trim();

      if (!keyId) {
        throw new Error('Razorpay key is missing from the frontend environment.');
      }

      if (!orderId || !amount || !currencyCode) {
        throw new Error('Razorpay order details are incomplete.');
      }

      const result = await openRazorpayCheckout({
        key: keyId,
        orderId,
        amount,
        currency: currencyCode,
        courseId: course._id,
        courseTitle: course.title,
        prefill: {
          name: user.name,
          email: user.email,
          contact: user.mobileNumber || '',
        },
      });

      await EduService.verifyRazorpayCoursePayment({
        courseId: course._id,
        paymentId: checkout.paymentId,
        razorpay_order_id: result.razorpay_order_id,
        razorpay_payment_id: result.razorpay_payment_id,
        razorpay_signature: result.razorpay_signature,
      });

      await onRefresh();
      openUnlockedCourse(course);
      setCourseAccessMessage('Payment confirmed. Course access is active.');
    } catch (error) {
      setCourseAccessMessage(error instanceof Error ? error.message : 'Unable to unlock this course right now.');
    } finally {
      setBusyCourseId(null);
    }
  };

  const selectedLesson = selectedLessonMeta?.lesson || null;
  const selectedLessonLocation = useMemo(
    () => findLessonLocation(selectedCourse, selectedLesson?.id || null),
    [selectedCourse, selectedLesson?.id],
  );
  const lessonEntries = useMemo(
    () => getModuleLessonEntries(selectedCourse),
    [selectedCourse],
  );
  const selectedLessonIndex = useMemo(
    () => lessonEntries.findIndex((entry) => entry.lesson.id === selectedLesson?.id),
    [lessonEntries, selectedLesson?.id],
  );
  const previousLessonEntry = selectedLessonIndex > 0 ? lessonEntries[selectedLessonIndex - 1] : null;
  const nextLessonEntry = selectedLessonIndex >= 0 && selectedLessonIndex < lessonEntries.length - 1
    ? lessonEntries[selectedLessonIndex + 1]
    : null;
  const hasCourseAccess = Boolean(user && (user.role === 'admin' || hasActiveCourseAccess(selectedCourse)));
  const hostedVideoUrl = selectedLesson?.type === 'video' ? selectedLesson.videoUrl || null : null;
  const privateVideoFallbackUrl = selectedLesson?.type === 'private-video' ? protectedLessonPlayback?.fallbackStreamUrl || null : null;
  const privateVideoDrmConfig = selectedLesson?.type === 'private-video' ? protectedLessonPlayback?.drmConfig || null : null;
  const privateVideoDrmManifestUrl = privateVideoDrmConfig?.enabled ? privateVideoDrmConfig.manifestUrl || null : null;
  const privateVideoStreamUrl = selectedLesson?.type === 'private-video'
    ? (useProtectedSourceFallback && privateVideoFallbackUrl
      ? privateVideoFallbackUrl
      : protectedLessonPlayback?.streamUrl || null)
    : null;
  const privateVideoStreamFormat = selectedLesson?.type === 'private-video'
    ? (useProtectedSourceFallback && privateVideoFallbackUrl
      ? protectedLessonPlayback?.fallbackStreamFormat || 'source'
      : protectedLessonPlayback?.streamFormat || null)
    : null;
  const effectiveLessonProgress = useMemo(() => {
    const merged = new Map<string, ResumeRecord>();

    (selectedCourse?.lessonProgress || []).forEach((entry) => {
      merged.set(entry.lessonId, entry);
    });

    Object.values(lessonProgressOverrides).forEach((entry) => {
      merged.set(entry.lessonId, entry);
    });

    return Array.from(merged.values());
  }, [lessonProgressOverrides, selectedCourse?.lessonProgress]);
  const lessonProgressMap = useMemo(
    () => new Map(effectiveLessonProgress.map((entry) => [entry.lessonId, entry])),
    [effectiveLessonProgress],
  );
  const lastWatchedLessonId = useMemo(() => {
    const history = [...effectiveLessonProgress].sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );
    return history[0]?.lessonId || null;
  }, [effectiveLessonProgress]);
  const selectedLessonProgress = selectedLesson ? lessonProgressMap.get(selectedLesson.id) : null;
  const sequentialAccessMap = useMemo(
    () => buildSequentialAccessMap(selectedCourse, lessonProgressMap, hasCourseAccess),
    [selectedCourse, lessonProgressMap, hasCourseAccess],
  );
  const selectedLessonAccess = selectedLesson ? sequentialAccessMap.get(selectedLesson.id) : null;
  const canAccessLesson = Boolean(
    selectedLesson
      && !selectedLesson.locked
      && (
        isDemoPreviewLesson(selectedLesson)
        || (
          hasCourseAccess
          && (!['youtube', 'private-video'].includes(selectedLesson.type) || selectedLessonAccess?.unlocked)
        )
      ),
  );
  const selectedCourseSnapshot = useMemo(
    () => selectedCourse ? getCourseProgressSnapshot(selectedCourse, lessonProgressOverrides) : { totalLessons: 0, completedLessons: 0, progressPercent: 0 },
    [selectedCourse, lessonProgressOverrides],
  );
  const selectedModuleSnapshot = useMemo(
    () => getModuleProgressSnapshot(selectedModule, lessonProgressMap),
    [selectedModule, lessonProgressMap],
  );
  const savedTopicSet = useMemo(() => new Set(savedTopicIds), [savedTopicIds]);
  const selectedLessonSaved = Boolean(selectedCourse && selectedLesson && savedTopicSet.has(`${selectedCourse._id}:${selectedLesson.id}`));
  const lessonAttachments = useMemo(() => {
    if (!selectedLesson) {
      return [];
    }
    const items = [...(selectedLesson.attachments || [])];
    const legacyNotes = buildLegacyNotesAttachment(selectedLesson);
    if (legacyNotes) {
      items.unshift(legacyNotes);
    }
    return items;
  }, [selectedLesson]);
  const chapterAttachments = useMemo(
    () => selectedLessonLocation?.chapter?.attachments || [],
    [selectedLessonLocation?.chapter?.attachments],
  );
  const moduleAttachments = useMemo(
    () => selectedLessonLocation?.module?.attachments || [],
    [selectedLessonLocation?.module?.attachments],
  );
  const selectedCourseSavedCount = useMemo(
    () => selectedCourse ? savedTopicIds.filter((entry) => entry.startsWith(`${selectedCourse._id}:`)).length : 0,
    [savedTopicIds, selectedCourse],
  );
  const selectedCourseSessionState = selectedCourseSession ? getLiveClassState(selectedCourseSession) : null;
  const immersiveCourseView = Boolean(selectedCourse && courseWorkspaceTab === 'player');
  const firstAccessibleLessonEntry = useMemo(
    () => lessonEntries.find((entry) => {
      if (entry.lesson.locked) {
        return false;
      }

      if (isDemoPreviewLesson(entry.lesson)) {
        return true;
      }

      if (!hasCourseAccess) {
        return false;
      }

      if (!['youtube', 'private-video'].includes(entry.lesson.type)) {
        return true;
      }

      return Boolean(sequentialAccessMap.get(entry.lesson.id)?.unlocked);
    }) || null,
    [lessonEntries, hasCourseAccess, sequentialAccessMap],
  );
  const suggestedLessonEntries = useMemo(() => {
    const incompleteEntries = lessonEntries.filter((entry) => !lessonProgressMap.get(entry.lesson.id)?.completed);
    return (incompleteEntries.length ? incompleteEntries : lessonEntries).slice(0, 4);
  }, [lessonEntries, lessonProgressMap]);
  const continueLessonEntry = useMemo(() => {
    if (!selectedCourse) {
      return null;
    }

    return lessonEntries.find((entry) => entry.lesson.id === selectedCourse.continueLesson?.id)
      || suggestedLessonEntries[0]
      || lessonEntries[0]
      || null;
  }, [lessonEntries, selectedCourse, suggestedLessonEntries]);

  useEffect(() => {
    activeCourseIdRef.current = selectedCourse?._id || null;
  }, [selectedCourse?._id]);

  useEffect(() => {
    playbackSnapshotRef.current = {
      lesson: selectedLesson,
      courseId: selectedCourse?._id || null,
      canAccess: canAccessLesson,
      progressSeconds: selectedLessonProgress?.progressSeconds || 0,
      mediaDurationSeconds: videoRef.current?.duration || 0,
      completed: Boolean(selectedLessonProgress?.completed),
    };
  }, [selectedLesson, selectedCourse?._id, canAccessLesson, selectedLessonProgress?.progressSeconds, selectedLessonProgress?.completed]);

  useEffect(() => {
    latestSelectionRef.current = {
      lesson: selectedLesson,
      courseId: selectedCourse?._id || null,
      canAccess: canAccessLesson,
    };
  }, [selectedLesson, selectedCourse?._id, canAccessLesson]);

  useEffect(() => {
    setUseProtectedSourceFallback(false);
  }, [selectedLesson?.id, protectedLessonPlayback?.streamUrl, protectedLessonPlayback?.fallbackStreamUrl]);

  useEffect(() => {
    if (!selectedLesson || !['youtube', 'private-video'].includes(selectedLesson.type) || !selectedCourse?._id) {
      setProtectedLessonPlayback(null);
      setProtectedLessonError(null);
      setLoadingProtectedLesson(false);
      return;
    }

    if (!canAccessLesson) {
      setProtectedLessonPlayback(null);
      setProtectedLessonError(selectedLessonAccess?.reason || 'Course access is required to watch this lesson.');
      setLoadingProtectedLesson(false);
      return;
    }

    let cancelled = false;
    setLoadingProtectedLesson(true);
    setProtectedLessonError(null);
    setProtectedLessonPlayback((current) => (
      String(current?.videoId || '') === String(selectedLesson.id || '')
        ? current
        : null
    ));

    void EduService.getProtectedLessonPlayback(selectedCourse._id, selectedLesson.id, { forceRefresh: true })
      .then((payload) => {
        if (cancelled) {
          return;
        }

        setProtectedLessonPlayback(payload);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setProtectedLessonError(error instanceof Error ? error.message : 'Unable to prepare protected playback.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingProtectedLesson(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedCourse?._id, selectedLesson?.id, selectedLesson?.type, selectedLessonAccess?.reason, canAccessLesson]);

  useEffect(() => {
    if (
      !selectedCourse?._id
      || !selectedLesson?.id
      || selectedLesson.type !== 'private-video'
      || !canAccessLesson
      || !protectedLessonPlayback
    ) {
      return undefined;
    }

    const playbackStatus = String(protectedLessonPlayback.playbackStatus || '').toLowerCase();
    const shouldRetry = !protectedLessonPlayback.streamUrl
      && !protectedLessonPlayback.drmConfig?.manifestUrl
      && ['queued', 'processing'].includes(playbackStatus);
    if (!shouldRetry) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setLoadingProtectedLesson(true);
      setProtectedLessonError(null);
      void EduService.getProtectedLessonPlayback(selectedCourse._id, selectedLesson.id, { forceRefresh: true })
        .then((payload) => {
          setProtectedLessonPlayback(payload);
        })
        .catch((error) => {
          setProtectedLessonError(error instanceof Error ? error.message : 'Unable to prepare protected playback.');
        })
        .finally(() => {
          setLoadingProtectedLesson(false);
        });
    }, 4000);

    return () => window.clearTimeout(timer);
  }, [
    canAccessLesson,
    protectedLessonPlayback,
    selectedCourse?._id,
    selectedLesson?.id,
    selectedLesson?.type,
  ]);

  useEffect(() => {
    if (courseWorkspaceTab !== 'sessions' || !selectedRecordingId || !user) {
      setSelectedRecordingAccess(null);
      setRecordingAccessError(null);
      setLoadingRecordingAccess(false);
      return;
    }

    let cancelled = false;
    setLoadingRecordingAccess(true);
    setRecordingAccessError(null);
    setSelectedRecordingAccess(null);

    void EduService.getLiveClassAccess(selectedRecordingId)
      .then((payload) => {
        if (!cancelled) {
          setSelectedRecordingAccess(payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRecordingAccessError(error instanceof Error ? error.message : 'Unable to prepare recording playback.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRecordingAccess(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRecordingId, courseWorkspaceTab, user]);

  useEffect(() => {
    setLessonProgressOverrides({});
    lastProgressSyncRef.current = {};
  }, [selectedCourse?._id]);

  useEffect(() => {
    if (!user?._id || !selectedCourse?._id) {
      return;
    }

    const cached = readResumeCache(user._id, selectedCourse._id);
    setLessonProgressOverrides(cached);
    lastProgressSyncRef.current = Object.values(cached).reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.lessonId] = entry.progressSeconds || 0;
      return accumulator;
    }, {});
  }, [user?._id, selectedCourse?._id]);

  useEffect(() => {
    setPrivateVideoQualityOptions([]);
    setSelectedPrivateVideoQuality(480);
  }, [selectedLesson?.id, privateVideoStreamUrl]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed, hostedVideoUrl, privateVideoStreamUrl]);

  useEffect(() => {
    if (!selectedLesson || !['youtube', 'private-video', 'video'].includes(String(selectedLesson.type || ''))) {
      return;
    }

    let timeoutId: number | null = null;
    const showCaptureWarning = (message: string) => {
      setCourseCaptureWarning(message);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        setCourseCaptureWarning('');
        timeoutId = null;
      }, 2600);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = String(event.key || '').toLowerCase();
      const isPrintScreen = key === 'printscreen';
      const isMacCaptureCombo = (event.metaKey || event.ctrlKey) && event.shiftKey && ['3', '4', '5'].includes(key);
      const isSaveCombo = (event.metaKey || event.ctrlKey) && key === 's';
      const isDevtoolsCombo = event.key === 'F12' || ((event.metaKey || event.ctrlKey) && event.shiftKey && ['i', 'j', 'c'].includes(key));

      if (isPrintScreen || isMacCaptureCombo || isSaveCombo || isDevtoolsCombo) {
        event.preventDefault();
        event.stopPropagation();
        showCaptureWarning('Protected course video shortcuts are disabled during playback.');
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    const handleVisibilityProtection = () => {
      if (document.hidden) {
        setCoursePrivacyShieldActive(true);
        showCaptureWarning('Protected course playback was hidden while the page was not active.');
        return;
      }
      setCoursePrivacyShieldActive(false);
    };
    const handleWindowBlur = () => {
      setCoursePrivacyShieldActive(true);
    };
    const handleWindowFocus = () => {
      setCoursePrivacyShieldActive(false);
    };

    document.addEventListener('visibilitychange', handleVisibilityProtection);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('visibilitychange', handleVisibilityProtection);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [selectedLesson?.id, selectedLesson?.type]);

  useEffect(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const currentVideo = videoRef.current;
    if (!currentVideo || !privateVideoStreamUrl || privateVideoStreamFormat !== 'hls') {
      return;
    }

    const trySourceFallback = () => {
      if (!privateVideoFallbackUrl || useProtectedSourceFallback) {
        return false;
      }
      setUseProtectedSourceFallback(true);
      return true;
    };

    const canUseHlsJs = Hls.isSupported();
    if (!canUseHlsJs) {
      if (currentVideo.canPlayType('application/vnd.apple.mpegurl')) {
        setPrivateVideoQualityOptions([]);
        currentVideo.src = privateVideoStreamUrl;
        const cleanupMetrics = wireHlsPlaybackMetrics({
          video: currentVideo,
          src: privateVideoStreamUrl,
          title: selectedLesson?.title || 'Recorded lesson',
          trackVideoId: selectedLesson?.id || null,
        });
        const handleNativeError = () => {
          if (trySourceFallback()) {
            currentVideo.pause();
            currentVideo.removeAttribute('src');
            currentVideo.load();
          }
        };
        currentVideo.addEventListener('error', handleNativeError);
        return () => {
          currentVideo.removeEventListener('error', handleNativeError);
          cleanupMetrics();
        };
      }

      trySourceFallback();
      return;
    }

    const hls = new Hls(createProtectedVodHlsConfig());
    hlsRef.current = hls;
    let releaseAutoLevel = () => undefined;
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      const qualityOptions = getRecordedVideoQualityOptions(data.levels || []);
      setPrivateVideoQualityOptions(qualityOptions);
      setSelectedPrivateVideoQuality((current) => getDefaultRecordedVideoQualityHeight(qualityOptions, current));
      releaseAutoLevel();
      releaseAutoLevel = scheduleAutoLevelRelease(hls);
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (shouldFallbackToSourceFromHlsError(data) && trySourceFallback()) {
        hls.destroy();
        if (hlsRef.current === hls) {
          hlsRef.current = null;
        }
      }
    });
    hls.loadSource(privateVideoStreamUrl);
    hls.attachMedia(currentVideo);
    const cleanupMetrics = wireHlsPlaybackMetrics({
      video: currentVideo,
      hls,
      src: privateVideoStreamUrl,
      title: selectedLesson?.title || 'Recorded lesson',
      trackVideoId: selectedLesson?.id || null,
    });

    return () => {
      releaseAutoLevel();
      cleanupMetrics();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [
    privateVideoFallbackUrl,
    privateVideoStreamFormat,
    privateVideoStreamUrl,
    selectedLesson?.id,
    selectedLesson?.title,
    useProtectedSourceFallback,
  ]);

  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls) {
      return;
    }

    const selectedLevel = getRecordedVideoQualityLevel(privateVideoQualityOptions, selectedPrivateVideoQuality);
    if (selectedLevel < 0) {
      return;
    }

    hls.currentLevel = selectedLevel;
    hls.nextLevel = selectedLevel;
    hls.autoLevelCapping = selectedLevel;
  }, [privateVideoQualityOptions, selectedPrivateVideoQuality]);

  const persistLessonProgress = async (
    courseId: string,
    canAccess: boolean,
    lesson: CourseLesson,
    progressSeconds: number,
    completed: boolean,
    force = false,
    mediaDurationSeconds?: number,
  ) => {
    if (!user || !courseId || !canAccess) {
      return;
    }

    const safeSeconds = Math.max(Math.floor(progressSeconds || 0), 0);
    const normalizedMediaDuration = Number.isFinite(mediaDurationSeconds || NaN)
      ? Math.max(Math.floor(mediaDurationSeconds || 0), 0)
      : 0;
    const configuredDurationSeconds = Math.max(Math.round((lesson.durationMinutes || 0) * 60), 0);
    const durationSeconds = Math.max(normalizedMediaDuration, configuredDurationSeconds, safeSeconds, 1);
    const derivedCompleted = completed || (normalizedMediaDuration > 0 && safeSeconds >= Math.max(normalizedMediaDuration - 2, 1));
    const progressPercent = derivedCompleted ? 100 : Math.min(99, Math.max(0, Math.round((safeSeconds / durationSeconds) * 100)));
    const progressKey = `${courseId}:${lesson.id}`;
    const alreadyCompleted = courseId === activeCourseIdRef.current
      ? Boolean(lessonProgressMap.get(lesson.id)?.completed)
      : false;
    const nextRecord = {
      lessonId: lesson.id,
      progressPercent,
      progressSeconds: safeSeconds,
      completed: derivedCompleted,
      updatedAt: new Date().toISOString(),
    };

    if (user?._id) {
      const cached = readResumeCache(user._id, courseId);
      const nextState = {
        ...cached,
        [lesson.id]: nextRecord,
      };
      writeResumeCache(user._id, courseId, nextState);

      if (activeCourseIdRef.current === courseId) {
        setLessonProgressOverrides(nextState);
      }
    }

    const previousSynced = lastProgressSyncRef.current[progressKey] || 0;
    if (!force && Math.abs(safeSeconds - previousSynced) < 15 && !derivedCompleted) {
      return;
    }

    lastProgressSyncRef.current[progressKey] = safeSeconds;
    try {
      await EduService.updateWatchProgress(
        courseId,
        lesson.id,
        progressPercent,
        safeSeconds,
        derivedCompleted,
        {},
        force ? { keepalive: true } : {},
      );
      if (derivedCompleted && !alreadyCompleted) {
        void onRefresh();
      }
    } catch (error) {
      console.error('Failed to sync lesson progress:', error);
    }
  };

  const flushTrackedPlayback = async () => {
    const snapshot = playbackSnapshotRef.current;
    if (!snapshot.lesson || !snapshot.courseId || !snapshot.canAccess) {
      return;
    }

    if (snapshot.progressSeconds <= 0 && !snapshot.completed) {
      return;
    }

    await persistLessonProgress(
      snapshot.courseId,
      snapshot.canAccess,
      snapshot.lesson,
      snapshot.progressSeconds,
      snapshot.completed,
      true,
      snapshot.mediaDurationSeconds,
    );
  };

  useEffect(() => {
    latestPersistRef.current.persist = persistLessonProgress;
  }, [persistLessonProgress]);

  useEffect(() => {
    const syncCurrentPlayback = async () => {
      const currentVideo = videoRef.current;
      const latestSelection = latestSelectionRef.current;
      const isCurrentVideoForSelectedLesson = Boolean(
        currentVideo
        && hostedVideoUrl
        && currentVideo.currentSrc
        && (currentVideo.currentSrc === hostedVideoUrl || currentVideo.currentSrc.includes(hostedVideoUrl)),
      );

      if (!isCurrentVideoForSelectedLesson || !latestSelection.lesson || !latestSelection.courseId || !latestSelection.canAccess) {
        await flushTrackedPlayback();
        return;
      }

      playbackSnapshotRef.current = {
        lesson: latestSelection.lesson,
        courseId: latestSelection.courseId,
        canAccess: latestSelection.canAccess,
        progressSeconds: currentVideo.currentTime,
        mediaDurationSeconds: currentVideo.duration || 0,
        completed: currentVideo.ended || currentVideo.currentTime >= Math.max(currentVideo.duration - 2, 0),
      };

      await persistLessonProgress(
        latestSelection.courseId,
        latestSelection.canAccess,
        latestSelection.lesson,
        currentVideo.currentTime,
        currentVideo.ended || currentVideo.currentTime >= Math.max(currentVideo.duration - 2, 0),
        true,
        currentVideo.duration,
      );
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        void syncCurrentPlayback();
      }
    };

    const handlePageHide = () => {
      void syncCurrentPlayback();
    };

    window.addEventListener('beforeunload', syncCurrentPlayback);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      window.removeEventListener('beforeunload', syncCurrentPlayback);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      void syncCurrentPlayback();
    };
  }, [selectedCourse?._id, selectedLesson?.id, canAccessLesson]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const globalWindow = window as WindowWithProgressFlush;
    globalWindow.__varonenglishFlushProgress = async () => {
      await flushTrackedPlayback();
    };

    return () => {
      if (globalWindow.__varonenglishFlushProgress) {
        delete globalWindow.__varonenglishFlushProgress;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      void flushTrackedPlayback();
    };
  }, [selectedLesson?.id, selectedCourse?._id]);

  useEffect(() => {
    if (!hostedVideoUrl || !selectedLesson?.id || !selectedLessonProgress?.progressSeconds || !videoRef.current) {
      return;
    }

    seekHostedVideoToResume(
      videoRef.current,
      selectedLesson.id,
      selectedLessonProgress.progressSeconds,
      appliedResumeRef,
    );
  }, [hostedVideoUrl, selectedLesson?.id, selectedLessonProgress?.progressSeconds]);

  useEffect(() => {
    if (!selectedLesson || !canAccessLesson) {
      setSecurityBlocked(false);
      return;
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const blockedShortcut = event.key === 'F12'
        || (event.ctrlKey && event.shiftKey && ['I', 'J', 'C'].includes(event.key.toUpperCase()));

      if (blockedShortcut) {
        event.preventDefault();
        setSecurityBlocked(true);
      }
    };

    const inspectDevTools = () => {
      const widthGap = Math.abs(window.outerWidth - window.innerWidth);
      const heightGap = Math.abs(window.outerHeight - window.innerHeight);
      setSecurityBlocked(widthGap > 160 || heightGap > 160);
    };

    document.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown);
    inspectDevTools();
    const intervalId = window.setInterval(inspectDevTools, 1500);

    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown);
      window.clearInterval(intervalId);
    };
  }, [selectedLesson?.id, canAccessLesson]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsPlayerFullscreen(document.fullscreenElement === playerViewportRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!pendingWorkspaceScrollRef.current || !courseWorkspaceSectionRef.current || typeof window === 'undefined') {
      return;
    }

    const target = courseWorkspaceSectionRef.current;
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      pendingWorkspaceScrollRef.current = false;
    });
  }, [selectedCourse?._id, courseWorkspaceTab]);

  const handleSelectCourse = (courseId: string) => {
    void flushTrackedPlayback();
    pendingWorkspaceScrollRef.current = true;
    setSelectedCourseId(courseId);
    setCourseWorkspaceTab('dashboard');
    setStudySidebarTab('notes');
    setShowReplayPlayer(false);
  };

  const handleSelectLesson = (lessonId: string) => {
    void flushTrackedPlayback();
    setSelectedLessonId(lessonId);
    setCourseWorkspaceTab('player');
    setStudySidebarTab('notes');
    setShowReplayPlayer(false);
    const lessonLocation = findLessonLocation(selectedCourse, lessonId);
    if (lessonLocation) {
      setSelectedModuleId(lessonLocation.module.id);
    }
  };

  const togglePlayerFullscreen = async () => {
    const playerViewport = playerViewportRef.current;
    if (!playerViewport) {
      return;
    }

    if (document.fullscreenElement === playerViewport) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    await playerViewport.requestFullscreen?.().catch(() => undefined);
  };

  const markLessonComplete = async () => {
    if (!selectedCourse || !selectedLesson) {
      return;
    }

    await persistLessonProgress(
      selectedCourse._id,
      true,
      selectedLesson,
      Math.max(
        Math.round((selectedLesson.durationMinutes || 0) * 60),
        protectedLessonPlayback?.resumeSeconds || 0,
        selectedLessonProgress?.progressSeconds || 0,
      ),
      true,
      true,
      Math.round((selectedLesson.durationMinutes || 0) * 60),
    );
    await onRefresh();
  };

  const askLessonDoubt = async () => {
    if (!selectedCourse || !selectedLesson || !lessonDoubt.trim()) {
      return;
    }

    setAskingLessonDoubt(true);
    try {
      const response = await EduService.askAi(
        `Student doubt for ${selectedCourse.title} > ${selectedLesson.title}: ${lessonDoubt.trim()}`,
      );
      setLessonDoubtAnswer(response.answer);
    } finally {
      setAskingLessonDoubt(false);
    }
  };

  useEffect(() => {
    setLessonDoubt('');
    setLessonDoubtAnswer(null);
  }, [selectedCourse?._id, selectedLesson?.id]);

  return (
    <div className="space-y-5">
      {!selectedCourse ? (
        <section className={cn(
          'overflow-hidden rounded-[34px] border border-[var(--line)] bg-white shadow-[0_22px_70px_rgba(15,23,42,0.07)]',
          immersiveCourseView
            ? 'p-4'
            : 'bg-[radial-gradient(circle_at_top_right,rgba(201,106,43,0.18),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(22,32,51,0.08),transparent_22%),linear-gradient(180deg,#fffaf2_0%,#fffdf8_100%)] p-6',
        )}>
        <div className={cn('grid gap-5', immersiveCourseView ? 'xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.85fr)]' : 'xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.9fr)]')}>
          <div>
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <SectionHeader
                title={immersiveCourseView ? 'Switch course' : isStudentCoursePreview ? 'Course preview' : courseView === 'my' ? 'My courses' : 'All courses'}
                caption={immersiveCourseView
                  ? 'Change course without losing your place'
                  : isStudentCoursePreview
                    ? 'Review the full course structure here. Buy or unlock it to start the lesson videos.'
                    : courseView === 'my'
                      ? 'Open the courses you already unlocked and jump back into the right lesson.'
                      : 'Browse every course, apply filters, and buy what you need without leaving this tab.'}
              />
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setCourseView('my')}
                    className={cn(
                      'rounded-full px-4 py-2 text-sm font-semibold transition',
                      courseView === 'my' ? 'bg-[var(--card-dark)] text-white' : 'bg-[var(--accent-cream)] text-[var(--ink-soft)]',
                    )}
                  >
                    My courses ({enrolledCourseCount})
                  </button>
                  <button
                    onClick={() => setCourseView('catalog')}
                    className={cn(
                      'rounded-full px-4 py-2 text-sm font-semibold transition',
                      courseView === 'catalog' ? 'bg-[var(--card-dark)] text-white' : 'bg-[var(--accent-cream)] text-[var(--ink-soft)]',
                    )}
                  >
                    All courses ({overview.courses.length})
                  </button>
                </div>
                {isStudentCoursePreview && (
                  <div className="rounded-full bg-white/80 px-4 py-2 text-sm font-semibold text-[var(--accent-rust)] shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
                    Previewing this course
                  </div>
                )}
              </div>
            </div>

            <div className={cn('grid gap-3', immersiveCourseView ? 'mt-4 lg:grid-cols-[minmax(0,1.5fr)_200px_200px]' : 'mt-5 lg:grid-cols-[minmax(0,1.5fr)_220px_220px]')}>
              <label className="flex items-center gap-3 rounded-[22px] border border-[var(--line)] bg-white px-4 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition focus-within:border-[var(--accent-rust)]">
                <Search className="h-4 w-4 text-[var(--ink-soft)]" />
                <input
                  value={courseQuery}
                  onChange={(event) => setCourseQuery(event.target.value)}
                  placeholder={courseView === 'my' ? 'Search your courses or subjects' : 'Search all courses, subjects, or teachers'}
                  className="w-full bg-transparent text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]/85"
                />
              </label>
              {courseView === 'catalog' ? (
                <>
                  <select
                    value={accessFilter}
                    onChange={(event) => setAccessFilter(event.target.value as typeof accessFilter)}
                    className="rounded-[22px] border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none shadow-[0_8px_20px_rgba(15,23,42,0.04)]"
                  >
                    <option value="all">All access types</option>
                    <option value="unlocked">Unlocked</option>
                    <option value="premium">Premium</option>
                  </select>
                  <select
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                    className="rounded-[22px] border border-[var(--line)] bg-white px-4 py-3 text-[var(--ink)] outline-none shadow-[0_8px_20px_rgba(15,23,42,0.04)]"
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category === 'all' ? 'All categories' : category}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <div className="rounded-[22px] border border-[var(--line)] bg-white px-4 py-3 text-sm text-[var(--ink-soft)] shadow-[0_8px_20px_rgba(15,23,42,0.04)] lg:col-span-2">
                  {isStudentCoursePreview
                    ? 'You are previewing this course. Complete payment to unlock lesson videos.'
                    : 'Switch to All courses to browse, filter, and buy from this same screen.'}
                </div>
              )}
            </div>

            {!immersiveCourseView && courseView === 'catalog' && categories.length > 1 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {categories.slice(0, 6).map((category) => (
                  <FilterChip
                    key={category}
                    active={categoryFilter === category}
                    label={category === 'all' ? 'All categories' : category}
                    onClick={() => setCategoryFilter(category)}
                  />
                ))}
              </div>
            )}
          </div>

          {!immersiveCourseView && selectedCourse && (
            <div className="rounded-[30px] border border-[#22324b] bg-[linear-gradient(135deg,#172033_0%,#22324b_100%)] p-5 text-white shadow-[0_24px_44px_rgba(15,23,42,0.16)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60">Course overview</p>
              <h3 className="mt-3 text-2xl font-semibold leading-tight">{selectedCourse.title}</h3>
              <p className="mt-2 text-sm text-white/74">{selectedCourse.subject} • {selectedCourse.instructor}</p>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/12">
                <div className="h-full rounded-full bg-[#72ff9b]" style={{ width: `${selectedCourseSnapshot.progressPercent}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-white/74">
                <span className="rounded-full bg-white/10 px-3 py-2">{selectedCourseSnapshot.progressPercent}% complete</span>
                <span className="rounded-full bg-white/10 px-3 py-2">{selectedCourseSnapshot.completedLessons}/{selectedCourseSnapshot.totalLessons} topics done</span>
                <span className="rounded-full bg-white/10 px-3 py-2">{selectedCourseSavedCount} saved</span>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                <button
                  type="button"
                  onClick={() => continueLessonEntry && handleSelectLesson(continueLessonEntry.lesson.id)}
                  disabled={!continueLessonEntry}
                  className="rounded-[18px] bg-white px-4 py-3 text-sm font-semibold text-[#172033] disabled:opacity-50"
                >
                  {selectedCourse.continueLesson ? 'Continue lesson' : 'Start lesson'}
                </button>
                <button
                  type="button"
                  onClick={() => setCourseWorkspaceTab('subjects')}
                  className="rounded-[18px] border border-white/18 bg-white/10 px-4 py-3 text-sm font-semibold text-white"
                >
                  Open subjects
                </button>
                {LIVE_CLASSES_ENABLED ? (
                  <button
                    type="button"
                    onClick={() => setCourseWorkspaceTab('sessions')}
                    className="rounded-[18px] border border-white/18 bg-white/10 px-4 py-3 text-sm font-semibold text-white"
                  >
                    Live & replays
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {courseCards.length === 0 ? (
          <div className="mt-6 rounded-[24px] border border-dashed border-[var(--line)] bg-white/70 p-6 text-center text-[var(--ink-soft)]">
            {courseView === 'my'
              ? 'You have not unlocked any courses yet. Switch to All courses to browse and buy from here.'
              : 'No courses match your current search and filters. Try a different keyword or category.'}
          </div>
        ) : (
          immersiveCourseView ? (
            <div className="mt-4 overflow-x-auto pb-2">
              <div className="grid grid-flow-col auto-cols-[minmax(260px,82vw)] gap-3 lg:grid-flow-row lg:auto-cols-auto lg:grid-cols-2 2xl:grid-cols-3">
                {courseCards.map((course) => (
                  <button
                    key={course._id}
                    onClick={() => handleSelectCourse(course._id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-[24px] border px-4 py-4 text-left transition sm:w-auto',
                      selectedCourse?._id === course._id
                        ? 'border-[var(--accent-rust)] bg-[var(--accent-cream)] text-[var(--ink)]'
                        : 'border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent-rust)]/40',
                    )}
                  >
                    <img src={course.thumbnailUrl} alt={course.title} className="h-12 w-12 shrink-0 rounded-[16px] object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-semibold leading-5">{course.title}</p>
                      <p className="mt-1 truncate text-xs">{course.subject}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-6 overflow-x-auto pb-2 lg:overflow-visible">
              <div className={cn(
                'grid gap-4',
                (isAdmin || courseView === 'catalog' || isStudentCoursePreview)
                  ? 'grid-flow-col auto-cols-[minmax(300px,86vw)] lg:grid-flow-row lg:auto-cols-auto lg:grid-cols-2 2xl:grid-cols-3'
                  : 'grid-flow-row auto-cols-auto md:grid-cols-2 2xl:grid-cols-3',
              )}>
                {courseCards.map((course) => {
                  const courseSnapshot = getCourseProgressSnapshot(course, lessonProgressOverrides);
                  const accessActive = hasActiveCourseAccess(course);
                  const paymentButtonVisible = shouldShowCoursePaymentButton(course);
                  return (
                    <button
                      key={course._id}
                      onClick={() => handleSelectCourse(course._id)}
                      className={cn(
                        'rounded-[28px] border p-4 text-left transition duration-200 hover:-translate-y-0.5 lg:min-h-[372px]',
                        selectedCourse?._id === course._id
                          ? 'border-[var(--accent-rust)] bg-[var(--accent-cream)] shadow-[0_16px_30px_rgba(201,106,43,0.12)]'
                          : 'border-[var(--line)] bg-white hover:border-[var(--accent-rust)]/35',
                      )}
                    >
                      <div className="flex gap-4">
                        <img src={course.thumbnailUrl} alt={course.title} className="h-20 w-20 shrink-0 rounded-[20px] object-cover shadow-[0_14px_28px_rgba(15,23,42,0.12)]" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--ink-soft)]">{course.category}</p>
                            <span className={cn(
                              'rounded-full px-3 py-1 text-xs font-semibold',
                              accessActive
                                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                                : getCourseAccessStatus(course) === 'disabled'
                                  ? 'bg-[#fff0f0] text-[#c94b4b]'
                                  : getCourseAccessStatus(course) === 'pending_access'
                                    ? 'bg-[#fff6dd] text-[#9a6b00]'
                                    : 'bg-[#fff3eb] text-[var(--accent-rust)]',
                            )}>
                              {getCourseAccessBadgeText(course)}
                            </span>
                          </div>
                          <h3 className="mt-2 line-clamp-2 text-lg font-semibold text-[var(--ink)]">{course.title}</h3>
                          <p className="mt-2 text-sm text-[var(--ink-soft)]">{course.subject}</p>
                          <p className="mt-3 text-xs font-medium text-[var(--ink-soft)]/80">{course.lessonCount || 0} topics • {course.instructor}</p>
                        </div>
                      </div>

                      {accessActive ? (
                        <div className="mt-4 rounded-[18px] bg-white/80 px-4 py-4">
                          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Progress</p>
                          <div className="mt-2 flex items-center justify-between gap-3">
                            <p className="text-lg font-semibold text-[var(--ink)]">{courseSnapshot.progressPercent}% done</p>
                            <p className="text-sm text-[var(--ink-soft)]">{courseSnapshot.completedLessons}/{courseSnapshot.totalLessons}</p>
                          </div>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--line)]">
                            <div className="h-full rounded-full bg-[var(--accent-rust)]" style={{ width: `${courseSnapshot.progressPercent}%` }} />
                          </div>
                        </div>
                      ) : (
                        <div className="mt-4 rounded-[20px] border border-[#ffd8b4] bg-[linear-gradient(135deg,#fff8ef_0%,#ffffff_100%)] px-4 py-4 shadow-[0_12px_28px_rgba(201,106,43,0.08)]">
                          {(() => {
                            const pricing = getCoursePricingMeta(course);
                            return (
                              <>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              {paymentButtonVisible && pricing.hasOffer ? (
                                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--accent-rust)]">Course offer</p>
                              ) : !paymentButtonVisible ? (
                                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Access status</p>
                              ) : null}
                              <p className="mt-2 text-[22px] font-bold leading-none text-[var(--ink)]">
                                {paymentButtonVisible ? currency.format(pricing.finalPrice) : getCoursePrimaryActionLabel(course, courseSnapshot.progressPercent)}
                              </p>
                            </div>
                            {paymentButtonVisible && pricing.hasOffer && (
                              <span className="rounded-full bg-[#ffedd5] px-3 py-1 text-[11px] font-bold text-[#c96a2b] shadow-[0_6px_16px_rgba(201,106,43,0.10)]">
                                {pricing.offerPercentage}% OFF
                              </span>
                            )}
                          </div>
                          {paymentButtonVisible && pricing.hasOffer ? (
                            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                              <span className="rounded-full bg-white px-3 py-1 font-semibold text-[var(--ink-soft)] line-through decoration-[#c96a2b]/55">
                                {currency.format(pricing.basePrice)}
                              </span>
                              <span className="rounded-full bg-[#fff1e4] px-3 py-1 font-semibold text-[#c96a2b]">
                                Save {currency.format(pricing.savings)}
                              </span>
                            </div>
                          ) : null}
                          <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
                            {getCourseAccessHint(course)}
                          </p>
                              </>
                            );
                          })()}
                        </div>
                      )}

                      <div className="mt-5 flex items-center justify-between gap-3">
                        <span className="text-sm text-[var(--ink-soft)]">
                          {getCourseAccessHint(course)}
                        </span>
                        <span className="rounded-full bg-[#172033] px-4 py-2 text-sm font-semibold text-white">
                          {selectedCourse?._id === course._id
                            ? 'Opened'
                            : hasActiveCourseAccess(course)
                              ? 'Open'
                              : getCoursePrimaryActionLabel(course, courseSnapshot.progressPercent)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )
        )}
      </section>

      ) : (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setSelectedCourseId(null)}
              className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-white px-4 py-2 text-sm font-semibold text-[var(--ink-soft)] transition hover:border-[var(--ink)] hover:text-[var(--ink)]"
            >
              ← Back to courses
            </button>
          </div>
        <section
          ref={courseWorkspaceSectionRef}
          className="overflow-hidden rounded-[34px] border border-[var(--line)] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.07)]"
        >
          <div className={cn(
            'text-white',
            immersiveCourseView
              ? 'bg-[linear-gradient(135deg,#1f2937_0%,#162033_100%)] px-5 py-5'
              : 'bg-[linear-gradient(135deg,#1a253b_0%,#22324b_100%)] px-5 py-5 sm:px-6',
          )}>
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/72">Course workspace</p>
                <h2 className={cn('font-semibold', immersiveCourseView ? 'mt-2 text-2xl' : 'mt-2 text-2xl sm:text-[2rem]')}>{selectedCourse.title}</h2>
                <p className="mt-2 text-sm text-white/78">
                  {selectedCourse.subject} • {selectedCourse.instructor} • {selectedCourse.validityDays} day access
                </p>
                {!hasActiveCourseAccess(selectedCourse) && shouldShowCoursePaymentButton(selectedCourse) && (
                  <p className="mt-2 text-sm font-semibold text-[#ffd58a]">
                    {getCourseFeeSummary(selectedCourse)}
                  </p>
                )}
                <div className={cn('h-2 w-full max-w-[420px] overflow-hidden rounded-full bg-white/15', immersiveCourseView ? 'mt-4' : 'mt-5')}>
                  <div className="h-full rounded-full bg-[#72ff9b]" style={{ width: `${selectedCourseSnapshot.progressPercent}%` }} />
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-sm text-white/85">
                  <span>Your progress {selectedCourseSnapshot.progressPercent}%</span>
                  <span>•</span>
                  <span>{selectedCourseSnapshot.completedLessons}/{selectedCourseSnapshot.totalLessons} topics completed</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {hasActiveCourseAccess(selectedCourse) ? (
                  <span className="rounded-full bg-white/12 px-4 py-3 text-sm font-semibold text-white">Access active</span>
                ) : shouldShowCoursePaymentButton(selectedCourse) ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleUnlock(selectedCourse)}
                      disabled={busyCourseId === selectedCourse._id}
                      className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 font-semibold text-[#2638d8] transition hover:bg-white/90 disabled:opacity-60"
                    >
                      {busyCourseId === selectedCourse._id ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
                      {getCoursePrimaryActionLabel(selectedCourse, selectedCourseSnapshot.progressPercent)}
                    </button>
                  </div>
                ) : (
                  <span className="rounded-full bg-white/12 px-4 py-3 text-sm font-semibold text-white">
                    {getCoursePrimaryActionLabel(selectedCourse, selectedCourseSnapshot.progressPercent)}
                  </span>
                )}
                {selectedCourse.officialChannelUrl && (
                  <a
                    href={selectedCourse.officialChannelUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border border-white/25 px-4 py-3 text-sm font-medium text-white transition hover:bg-white/10"
                  >
                    Official channel
                  </a>
                )}
              </div>
            </div>
            {(courseAccessMessage || (!hasActiveCourseAccess(selectedCourse) && selectedCourse?.accessBlockReason)) && (
              <p className="mt-3 text-sm text-[#ffd58a]">{courseAccessMessage || selectedCourse?.accessBlockReason}</p>
            )}
          </div>

          <div className="border-b border-[var(--line)] bg-white px-4 sm:px-6">
            <div className="flex gap-5 overflow-x-auto">
              {[
                { key: 'dashboard', label: 'Home' },
                { key: 'subjects', label: 'Subjects' },
                { key: 'player', label: 'Lesson' },
                ...(LIVE_CLASSES_ENABLED ? [{ key: 'sessions', label: 'Live & replays' }] : []),
              ].map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setCourseWorkspaceTab(tab.key as typeof courseWorkspaceTab)}
                  data-testid={`course-workspace-${tab.key}`}
                  className={cn(
                    'shrink-0 border-b-2 px-2 py-4 text-sm font-semibold transition',
                    courseWorkspaceTab === tab.key
                      ? 'border-[var(--accent-rust)] text-[var(--accent-rust)]'
                      : 'border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {courseWorkspaceTab === 'dashboard' ? (
            <div className="space-y-5 bg-[var(--accent-cream)]/35 p-4 sm:p-6">
              <section className="overflow-hidden rounded-[30px] border border-[var(--line)] bg-[linear-gradient(135deg,#fffdfa_0%,#fff5e6_100%)] p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Course home</p>
                    <h3 className="mt-3 text-2xl font-semibold text-[var(--ink)]">
                      {continueLessonEntry?.lesson.title || selectedCourse.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                      {continueLessonEntry
                        ? [continueLessonEntry.moduleTitle, continueLessonEntry.chapterTitle, `${continueLessonEntry.lesson.durationMinutes} mins`].filter(Boolean).join(' • ')
                        : 'Choose a subject and open the first lesson. This screen keeps the next move obvious.'}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-[var(--ink-soft)]">
                        {selectedCourseSnapshot.progressPercent}% course progress
                      </span>
                      <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-[var(--ink-soft)]">
                        {selectedCourseSavedCount} saved topics
                      </span>
                      {LIVE_CLASSES_ENABLED ? (
                        <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-[var(--ink-soft)]">
                          {selectedCourseSessions.length} live & replay session{selectedCourseSessions.length === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid w-full gap-3 sm:grid-cols-2 lg:max-w-[360px]">
                    <button
                      type="button"
                      onClick={() => continueLessonEntry && handleSelectLesson(continueLessonEntry.lesson.id)}
                      disabled={!continueLessonEntry}
                      className="rounded-[18px] bg-[var(--accent-rust)] px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(201,106,43,0.22)] disabled:opacity-50"
                    >
                      {selectedCourse.continueLesson ? 'Continue lesson' : 'Start lesson'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setCourseWorkspaceTab('subjects')}
                      className="rounded-[18px] border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)]"
                    >
                      Open subjects
                    </button>
                    <button
                      type="button"
                      onClick={() => setCourseWorkspaceTab('player')}
                      className="rounded-[18px] border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)]"
                    >
                      Lesson player
                    </button>
                    {LIVE_CLASSES_ENABLED ? (
                      <button
                        type="button"
                        onClick={() => setCourseWorkspaceTab('sessions')}
                        className="rounded-[18px] border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)]"
                      >
                        Live & replays
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <div className="rounded-[24px] border border-[var(--line)] bg-white p-4 shadow-[0_16px_30px_rgba(15,23,42,0.04)]">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Course progress</p>
                  <p className="mt-3 text-3xl font-semibold text-[var(--ink)]">{selectedCourseSnapshot.progressPercent}%</p>
                  <p className="mt-2 text-sm text-[var(--ink-soft)]">{selectedCourseSnapshot.completedLessons}/{selectedCourseSnapshot.totalLessons} topics completed</p>
                </div>
                <div className="rounded-[24px] border border-[var(--line)] bg-white p-4 shadow-[0_16px_30px_rgba(15,23,42,0.04)]">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Subjects</p>
                  <p className="mt-3 text-3xl font-semibold text-[var(--ink)]">{selectedCourse.modules.length}</p>
                  <p className="mt-2 text-sm text-[var(--ink-soft)]">Subjects available in this course</p>
                </div>
                {LIVE_CLASSES_ENABLED ? (
                  <div className="rounded-[24px] border border-[var(--line)] bg-white p-4 shadow-[0_16px_30px_rgba(15,23,42,0.04)]">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Live & replays</p>
                    <p className="mt-3 text-3xl font-semibold text-[var(--ink)]">{selectedCourseLiveSessions.length + selectedCourseUpcomingSessions.length}</p>
                    <p className="mt-2 text-sm text-[var(--ink-soft)]">Live or upcoming classes in this course</p>
                  </div>
                ) : null}
              </section>

              <section className="rounded-[30px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Subjects</p>
                    <h3 className="mt-2 text-2xl font-semibold text-[var(--ink)]">Choose a subject and continue</h3>
                    <p className="mt-2 text-sm text-[var(--ink-soft)]">Keep the first screen short. Open a subject, then open a lesson.</p>
                  </div>
                  <button
                    onClick={() => setCourseWorkspaceTab('subjects')}
                    className="rounded-full border border-[var(--line)] bg-white px-4 py-2 text-sm font-semibold text-[var(--accent-rust)]"
                  >
                    View all subjects
                  </button>
                </div>

                <div className="mt-5 grid gap-3 lg:grid-cols-2">
                  {selectedCourse.modules.slice(0, 4).map((module) => {
                    const snapshot = getModuleProgressSnapshot(module, lessonProgressMap);
                    const nextEntry = getStandaloneModuleLessonEntries(module).find((entry) => !lessonProgressMap.get(entry.lesson.id)?.completed)
                      || getStandaloneModuleLessonEntries(module)[0];

                    return (
                      <div key={module.id} className="rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)]/45 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-base font-semibold text-[var(--ink)]">{module.title}</p>
                            <p className="mt-1 text-sm text-[var(--ink-soft)]">
                              {snapshot.completedLessons}/{snapshot.totalLessons} lessons completed
                            </p>
                          </div>
                          <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-[var(--accent-rust)]">
                            {snapshot.progressPercent}%
                          </span>
                        </div>

                        <div className="mt-4 rounded-[18px] bg-white px-4 py-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Next lesson</p>
                          <p className="mt-2 text-sm font-semibold text-[var(--ink)]">{nextEntry?.lesson.title || 'No lesson available yet'}</p>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            onClick={() => {
                              setSelectedModuleId(module.id);
                              setCourseWorkspaceTab('subjects');
                            }}
                            className="rounded-full border border-[var(--line)] bg-white px-4 py-2 text-sm font-semibold text-[var(--ink)]"
                          >
                            Open subject
                          </button>
                          {nextEntry && (
                            <button
                              onClick={() => handleSelectLesson(nextEntry.lesson.id)}
                              className="rounded-full bg-[var(--accent-rust)] px-4 py-2 text-sm font-semibold text-white"
                            >
                              Continue lesson
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {selectedCourse.modules.length > 4 && (
                  <p className="mt-4 text-sm text-[var(--ink-soft)]">
                    {selectedCourse.modules.length - 4} more subject{selectedCourse.modules.length - 4 === 1 ? '' : 's'} are available in the Subjects tab.
                  </p>
                )}
              </section>
            </div>
          ) : courseWorkspaceTab === 'subjects' ? (
            <div className="grid gap-5 bg-[var(--accent-cream)]/35 p-4 sm:p-6 lg:grid-cols-[300px_minmax(0,1fr)]">
              <aside className="rounded-[26px] border border-[var(--line)] bg-white shadow-[0_18px_35px_rgba(15,23,42,0.04)] lg:sticky lg:top-6 lg:self-start">
                <div className="border-b border-[var(--line)] px-5 py-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Subjects</p>
                  <p className="mt-2 text-lg font-semibold text-[var(--ink)]">Choose a subject</p>
                </div>
                <div className="space-y-1 p-3">
                  {selectedCourse.modules.map((module) => {
                    const snapshot = getModuleProgressSnapshot(module, lessonProgressMap);
                    return (
                      <button
                        key={module.id}
                        onClick={() => setSelectedModuleId(module.id)}
                        className={cn(
                          'w-full rounded-[18px] px-4 py-4 text-left transition',
                          selectedModule?.id === module.id ? 'bg-[var(--card-dark)] text-white' : 'bg-white hover:bg-[var(--accent-cream)]',
                        )}
                      >
                        <p className="text-base font-semibold">{module.title}</p>
                        <p className={cn('mt-1 text-sm', selectedModule?.id === module.id ? 'text-white/85' : 'text-[var(--ink-soft)]')}>
                          {snapshot.completedLessons}/{snapshot.totalLessons} lessons • {snapshot.progressPercent}% progress
                        </p>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <div className="space-y-5">
                <div className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Subject view</p>
                      <h3 className="mt-2 text-3xl font-semibold text-[var(--ink)]">{selectedModule?.title || 'Select a subject'}</h3>
                      <p className="mt-2 text-sm text-[var(--ink-soft)]">{selectedModuleSnapshot.completedLessons}/{selectedModuleSnapshot.totalLessons} lessons completed in this subject</p>
                    </div>
                    {selectedModuleEntries[0] && (
                      <button
                        onClick={() => handleSelectLesson(selectedModuleEntries[0].lesson.id)}
                        className="rounded-[16px] bg-[var(--accent-rust)] px-6 py-3 text-sm font-semibold text-white"
                      >
                        Open first lesson
                      </button>
                    )}
                  </div>
                </div>

                <div className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                  {selectedModule ? (
                    <div className="space-y-4">
                      {(selectedModule.lessons || []).map((lesson) => {
                        const lessonProgress = lessonProgressMap.get(lesson.id);
                        const lessonAccess = sequentialAccessMap.get(lesson.id);
                        return (
                          <CourseLessonItem
                            key={lesson.id}
                            lesson={lesson}
                            selected={selectedLesson?.id === lesson.id}
                            isSaved={savedTopicSet.has(`${selectedCourse._id}:${lesson.id}`)}
                            isCompleted={Boolean(lessonProgress?.completed)}
                            isLastWatched={lastWatchedLessonId === lesson.id}
                            lessonProgressPercent={lessonProgress?.progressPercent || 0}
                            lessonAccessReason={lessonAccess?.reason || null}
                            lessonSequentiallyUnlocked={Boolean(lessonAccess?.unlocked)}
                            onSelect={() => handleSelectLesson(lesson.id)}
                            onSave={() => onToggleSavedTopic(selectedCourse._id, lesson.id)}
                          />
                        );
                      })}

                      {(selectedModule.chapters || []).map((chapter) => (
                        <div key={chapter.id} className="rounded-[22px] border border-[var(--line)] bg-[var(--accent-cream)] p-4">
                          <div className="mb-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Chapter</p>
                            <p className="mt-1 text-lg font-semibold text-[var(--ink)]">{chapter.title}</p>
                          </div>
                          <div className="space-y-3">
                            {(chapter.lessons || []).map((lesson) => {
                              const lessonProgress = lessonProgressMap.get(lesson.id);
                              const lessonAccess = sequentialAccessMap.get(lesson.id);
                              return (
                                <CourseLessonItem
                                  key={lesson.id}
                                  lesson={lesson}
                                  selected={selectedLesson?.id === lesson.id}
                                  isSaved={savedTopicSet.has(`${selectedCourse._id}:${lesson.id}`)}
                                  isCompleted={Boolean(lessonProgress?.completed)}
                                  isLastWatched={lastWatchedLessonId === lesson.id}
                                  lessonProgressPercent={lessonProgress?.progressPercent || 0}
                                  lessonAccessReason={lessonAccess?.reason || null}
                                  lessonSequentiallyUnlocked={Boolean(lessonAccess?.unlocked)}
                                  onSelect={() => handleSelectLesson(lesson.id)}
                                  onSave={() => onToggleSavedTopic(selectedCourse._id, lesson.id)}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-[var(--ink-soft)]">Select a subject to browse modules and lessons.</div>
                  )}
                </div>
              </div>
            </div>
          ) : courseWorkspaceTab === 'sessions' ? (
            <div className="grid gap-5 bg-[var(--accent-cream)]/35 p-4 sm:p-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
              <div className="space-y-5">
                <section className="rounded-[28px] border border-[var(--line)] bg-[linear-gradient(135deg,#172033_0%,#2a3b58_100%)] p-5 text-white shadow-[0_20px_45px_rgba(15,23,42,0.16)]">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">Course sessions</p>
                      <h3 className="mt-3 text-2xl font-semibold">Live classes, upcoming schedule, and replay archive</h3>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-white/78">
                        Keep recorded sessions separate from lesson study so students can quickly decide whether they want to join live, check the plan, or watch a replay.
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-3 sm:min-w-[280px]">
                      <div className="rounded-[18px] bg-white/10 p-4">
                        <p className="text-xs uppercase tracking-[0.16em] text-white/65">Live</p>
                        <p className="mt-2 text-2xl font-semibold">{selectedCourseLiveSessions.length}</p>
                      </div>
                      <div className="rounded-[18px] bg-white/10 p-4">
                        <p className="text-xs uppercase tracking-[0.16em] text-white/65">Upcoming</p>
                        <p className="mt-2 text-2xl font-semibold">{selectedCourseUpcomingSessions.length}</p>
                      </div>
                      <div className="rounded-[18px] bg-white/10 p-4">
                        <p className="text-xs uppercase tracking-[0.16em] text-white/65">Recordings</p>
                        <p className="mt-2 text-2xl font-semibold">{selectedCourseRecordings.length}</p>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Browse archive</p>
                      <h3 className="mt-2 text-xl font-semibold text-[var(--ink)]">Find the right session fast</h3>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {([
                        ['all', 'All sessions'],
                        ['live', 'Live now'],
                        ['upcoming', 'Upcoming'],
                        ['recorded', 'Recordings'],
                      ] as const).map(([filter, label]) => (
                        <button
                          key={filter}
                          onClick={() => setSessionViewFilter(filter)}
                          className={cn(
                            'rounded-full px-4 py-2 text-sm font-semibold transition',
                            sessionViewFilter === filter
                              ? 'bg-[var(--card-dark)] text-white'
                              : 'bg-[var(--accent-cream)] text-[var(--ink-soft)]',
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                {filteredCourseSessions.length === 0 ? (
                  <div className="rounded-[24px] border border-dashed border-[var(--line)] bg-white p-6 text-sm text-[var(--ink-soft)]">
                    No sessions match this filter yet. Try another view or schedule a live class from admin.
                  </div>
                ) : (
                  <div className="space-y-5">
                    {(sessionViewFilter === 'all' || sessionViewFilter === 'live') && selectedCourseLiveSessions.length > 0 && (
                      <section className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                        <div className="flex items-center gap-3">
                          <Radio className="h-5 w-5 text-[var(--accent-rust)]" />
                          <div>
                            <p className="text-lg font-semibold text-[var(--ink)]">Live now</p>
                            <p className="text-sm text-[var(--ink-soft)]">Enter the ongoing class directly from the course hub.</p>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {selectedCourseLiveSessions.map((session) => (
                            <button
                              key={session._id}
                              onClick={() => setSelectedRecordingId(session._id)}
                              data-testid={`course-session-${session._id}`}
                              className={cn(
                                'w-full rounded-[22px] border p-4 text-left transition',
                                selectedRecordingId === session._id
                                  ? 'border-[#8ec5ff] bg-[#eef6ff]'
                                  : 'border-[#e2ebf4] bg-white hover:border-[#c8d8ea]',
                              )}
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={cn('rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]', getLiveClassChipClasses(session))}>
                                      {getLiveClassLabel(session)}
                                    </span>
                                    <span className="rounded-full bg-[var(--accent-cream)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                                      {formatSessionDuration(session.durationMinutes)}
                                    </span>
                                  </div>
                                  <p className="mt-3 text-lg font-semibold text-[var(--ink)]">{session.title}</p>
                                  <p className="mt-1 text-sm text-[var(--ink-soft)]">{session.instructor} • {formatSessionDateTime(session.startTime)}</p>
                                  <p className="mt-2 text-xs font-medium uppercase tracking-[0.12em] text-[#8a9ab0]">
                                    {getLiveClassContextLabel(session, selectedCourse?.subject || 'Course session')}
                                  </p>
                                </div>
                                <ChevronRight className="h-5 w-5 text-[var(--accent-rust)]" />
                              </div>
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {(sessionViewFilter === 'all' || sessionViewFilter === 'upcoming') && selectedCourseUpcomingSessions.length > 0 && (
                      <section className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                        <div className="flex items-center gap-3">
                          <CalendarClock className="h-5 w-5 text-[var(--accent-rust)]" />
                          <div>
                            <p className="text-lg font-semibold text-[var(--ink)]">Upcoming sessions</p>
                            <p className="text-sm text-[var(--ink-soft)]">Students can see what is next without digging through the lesson player.</p>
                          </div>
                        </div>
                        <div className="mt-4 space-y-3">
                          {selectedCourseUpcomingSessions.map((session) => (
                            <button
                              key={session._id}
                              onClick={() => setSelectedRecordingId(session._id)}
                              data-testid={`course-session-${session._id}`}
                              className={cn(
                                'w-full rounded-[22px] border p-4 text-left transition',
                                selectedRecordingId === session._id
                                  ? 'border-[#8ec5ff] bg-[#eef6ff]'
                                  : 'border-[#e2ebf4] bg-white hover:border-[#c8d8ea]',
                              )}
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className={cn('rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]', getLiveClassChipClasses(session))}>
                                      {getLiveClassLabel(session)}
                                    </span>
                                    <span className="rounded-full bg-[var(--accent-cream)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                                      {formatSessionDuration(session.durationMinutes)}
                                    </span>
                                  </div>
                                  <p className="mt-3 text-lg font-semibold text-[var(--ink)]">{session.title}</p>
                                  <p className="mt-1 text-sm text-[var(--ink-soft)]">{session.instructor} • {formatSessionDateTime(session.startTime)}</p>
                                  <p className="mt-2 text-xs font-medium uppercase tracking-[0.12em] text-[#8a9ab0]">
                                    {getLiveClassContextLabel(session, selectedCourse?.subject || 'Course session')}
                                  </p>
                                </div>
                                <ChevronRight className="h-5 w-5 text-[var(--accent-rust)]" />
                              </div>
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {(sessionViewFilter === 'all' || sessionViewFilter === 'recorded') && selectedCourseRecordingGroups.length > 0 && (
                      <section className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                        <div className="flex items-center gap-3">
                          <Video className="h-5 w-5 text-[var(--accent-rust)]" />
                          <div>
                            <p className="text-lg font-semibold text-[var(--ink)]">Recorded session archive</p>
                            <p className="text-sm text-[var(--ink-soft)]">Grouped by subject and chapter so replay browsing feels organized.</p>
                          </div>
                        </div>
                        <div className="mt-4 space-y-4">
                          {selectedCourseRecordingGroups.map((group) => (
                            <div key={group.key} className="rounded-[22px] bg-[var(--accent-cream)] p-4">
                              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                  <p className="text-base font-semibold text-[var(--ink)]">{group.moduleTitle}</p>
                                  <p className="text-sm text-[var(--ink-soft)]">{group.chapterTitle || 'Course-wide sessions'} • {group.recordings.length} replay{group.recordings.length === 1 ? '' : 's'}</p>
                                </div>
                              </div>
                              <div className="mt-3 space-y-3">
                                {group.recordings.map((session) => (
                                  <button
                                    key={session._id}
                                    onClick={() => setSelectedRecordingId(session._id)}
                                    data-testid={`course-session-${session._id}`}
                                    className={cn(
                                      'w-full rounded-[18px] border p-4 text-left transition',
                                      selectedRecordingId === session._id
                                        ? 'border-[#8ec5ff] bg-[#eef6ff]'
                                        : 'border-white/60 bg-white hover:border-[#c8d8ea]',
                                    )}
                                  >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className={cn('rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]', getLiveClassChipClasses(session))}>
                                            {getLiveClassLabel(session)}
                                          </span>
                                          <span className="rounded-full bg-[var(--accent-cream)] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                                            {formatSessionDuration(session.durationMinutes)}
                                          </span>
                                        </div>
                                        <p className="mt-3 text-base font-semibold text-[var(--ink)]">{session.title}</p>
                                        <p className="mt-1 text-sm text-[var(--ink-soft)]">{session.instructor} • {formatSessionDateTime(session.startTime)}</p>
                                      </div>
                                      <ChevronRight className="h-5 w-5 text-[var(--accent-rust)]" />
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                )}
              </div>

              <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
                <div className="rounded-[28px] border border-[var(--line)] bg-white p-5 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Selected session</p>
                  {selectedCourseSession ? (
                    <div className="mt-4 space-y-4">
                      <div className="rounded-[22px] bg-[var(--accent-cream)] p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn('rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]', getLiveClassChipClasses(selectedCourseSession))}>
                            {getLiveClassLabel(selectedCourseSession)}
                          </span>
                          <span className="rounded-full bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                            {formatSessionDuration(selectedCourseSession.durationMinutes)}
                          </span>
                        </div>
                        <h3 className="mt-3 text-xl font-semibold text-[var(--ink)]">{selectedCourseSession.title}</h3>
                        <p className="mt-2 text-sm text-[var(--ink-soft)]">{selectedCourseSession.instructor} • {formatSessionDateTime(selectedCourseSession.startTime)}</p>
                        <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
                          {getLiveClassContextLabel(selectedCourseSession, selectedCourse?.subject || 'Course session')}
                        </p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Attend</p>
                          <p className="mt-2 text-sm font-semibold text-[#172033]">{selectedCourseSession.attendees} learners joined</p>
                        </div>
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Format</p>
                          <p className="mt-2 text-sm font-semibold text-[#172033]">{selectedCourseSession.provider} • {selectedCourseSession.mode}</p>
                        </div>
                      </div>

                      {!user ? (
                        <div className="rounded-[18px] border border-dashed border-[#dbe4ef] p-4 text-sm text-[#607089]">
                          Log in to open this protected session inside the course archive.
                        </div>
                      ) : loadingRecordingAccess ? (
                        <div className="flex items-center gap-3 rounded-[18px] border border-[#dbe4ef] p-4 text-sm text-[#607089]">
                          <LoaderCircle className="h-5 w-5 animate-spin" />
                          Preparing secure session access…
                        </div>
                      ) : recordingAccessError ? (
                        <div className="rounded-[18px] border border-dashed border-[#dbe4ef] p-4 text-sm text-[#607089]">
                          {recordingAccessError}
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {selectedCourseSessionState === 'scheduled' ? (
                            <div className="rounded-[18px] bg-[#f8fbff] p-4 text-sm leading-6 text-[#607089]">
                              Starts {formatSessionDateTime(selectedCourseSession.startTime)}. Students should see this schedule clearly even before playback is available.
                            </div>
                          ) : !selectedCourseSession.replayReady && selectedCourseSessionState !== 'live' ? (
                            <div className="rounded-[18px] bg-[#f8fbff] p-4 text-sm leading-6 text-[#607089]">
                              Recording is being prepared. Keep the detail panel visible so this state feels intentional, not broken.
                            </div>
                          ) : (
                            <button
                              onClick={() => setShowReplayPlayer(true)}
                              disabled={!selectedRecordingAccess}
                              data-testid="course-session-primary-action"
                              className="inline-flex w-full items-center justify-center gap-2 rounded-[16px] bg-[#172033] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                            >
                              {getLiveClassActionLabel(selectedCourseSession)}
                            </button>
                          )}

                          {(selectedRecordingAccess?.replayLessonId || selectedCourseSession.replayLessonId) && (
                            <button
                              onClick={() => {
                                const targetLessonId = selectedRecordingAccess?.replayLessonId || selectedCourseSession.replayLessonId;
                                if (targetLessonId) {
                                  handleSelectLesson(targetLessonId);
                                  setCourseWorkspaceTab('player');
                                  setStudySidebarTab('notes');
                                }
                              }}
                              className="inline-flex w-full items-center justify-center gap-2 rounded-[16px] border border-[#dbe4ef] bg-white px-4 py-3 text-sm font-semibold text-[#172033]"
                            >
                              Open linked lesson topic
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[18px] border border-dashed border-[#dbe4ef] p-4 text-sm text-[#607089]">
                      Choose a live class or recording to inspect the details here.
                    </div>
                  )}
                </div>

                {showReplayPlayer && selectedRecordingAccess && (
                  <div className="overflow-hidden rounded-[28px] border border-[var(--line)] bg-white p-3 shadow-[0_18px_35px_rgba(15,23,42,0.04)]">
                    <div className="rounded-[22px] bg-[#172033] p-4 text-white">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/65">Session player</p>
                      <p className="mt-2 text-lg font-semibold">{selectedCourseSession?.title || selectedRecordingAccess.title}</p>
                    </div>
                    <div className="mt-3 overflow-hidden rounded-[20px]">
                      <ProtectedLivePlayback access={selectedRecordingAccess} />
                    </div>
                  </div>
                )}
              </aside>
            </div>
          ) : selectedLesson ? (
            <div className="grid gap-0 xl:grid-cols-[300px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)_320px]">
              <aside className="border-b border-[#e7edf5] bg-white xl:border-b-0 xl:border-r xl:sticky xl:top-0 xl:h-screen">
                <div className="border-b border-[#edf2f7] px-4 py-4">
                  <button
                    onClick={() => setCourseWorkspaceTab('subjects')}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-[#22a8d4]"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Back to subjects
                  </button>
                  <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-[#8a9ab0]">Current module</p>
                  <h3 className="mt-2 text-xl font-semibold text-[#172033]">{selectedModule?.title || selectedCourse.title}</h3>
                </div>
                <div className="max-h-[calc(100vh-220px)] overflow-y-auto xl:max-h-[calc(100vh-120px)]">
                  {selectedModuleEntries.map((entry, index) => (
                    <PlayerRailLessonItem
                      key={entry.lesson.id}
                      lesson={entry.lesson}
                      chapterTitle={entry.chapterTitle}
                      selected={selectedLesson.id === entry.lesson.id}
                      completed={Boolean(lessonProgressMap.get(entry.lesson.id)?.completed)}
                      order={index + 1}
                      onSelect={() => handleSelectLesson(entry.lesson.id)}
                    />
                  ))}
                </div>
              </aside>

              <main className="min-w-0 bg-[#fbfcff] p-4 md:p-5">
                <div className="rounded-[24px] border border-[#e1eaf3] bg-white">
                  <div className="flex flex-col gap-4 border-b border-[#edf2f7] px-5 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <button
                        onClick={() => setCourseWorkspaceTab('subjects')}
                        className="inline-flex items-center gap-2 text-sm font-semibold text-[#22a8d4]"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Back to subjects
                      </button>
                      <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#8a9ab0]">
                        {[selectedCourse.title, selectedLessonMeta?.moduleTitle, selectedLessonMeta?.chapterTitle].filter(Boolean).join(' • ')}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className="rounded-full bg-[#f4f7fb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#607089]">
                          {selectedLesson.durationMinutes} min
                        </span>
                        <span className="rounded-full bg-[#f4f7fb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#607089]">
                          {selectedLesson.type}
                        </span>
                        <span className="rounded-full bg-[#f4f7fb] px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#607089]">
                          {selectedLessonProgress?.completed ? 'Completed' : `${selectedLessonProgress?.progressPercent || 0}% watched`}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void togglePlayerFullscreen()}
                        className="inline-flex items-center gap-2 rounded-full border border-[#dbe4ef] bg-[#f8fbff] px-4 py-2 text-sm font-semibold text-[#172033]"
                      >
                        {isPlayerFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                        {isPlayerFullscreen ? 'Exit full screen' : 'Expand player'}
                      </button>
                    </div>
                  </div>

                  <div className="p-5">
                    <div
                      ref={playerViewportRef}
                      className={cn(
                        'relative overflow-hidden rounded-[20px] bg-black',
                        isPlayerFullscreen && 'flex h-screen items-center justify-center rounded-none border-0 bg-black',
                      )}
                      onContextMenu={(event) => {
                        if (selectedLesson && ['youtube', 'private-video', 'video'].includes(String(selectedLesson.type || ''))) {
                          event.preventDefault();
                          setCourseCaptureWarning('Protected course video options are disabled during playback.');
                        }
                      }}
                    >
                      <div className={cn('w-full', isPlayerFullscreen && 'flex h-full items-center justify-center')}>
                        {securityBlocked ? (
                          <div className="flex aspect-video flex-col items-center justify-center gap-4 px-6 text-center text-white">
                            <Lock className="h-10 w-10 text-[var(--accent-rust)]" />
                            <div>
                              <p className="text-lg font-semibold">Protected player paused</p>
                              <p className="mt-2 text-sm leading-7 text-white/68">Developer tools and inspection shortcuts are blocked during lesson playback. Close them to continue learning.</p>
                            </div>
                          </div>
                        ) : canAccessLesson && ['youtube', 'private-video'].includes(selectedLesson.type) && loadingProtectedLesson ? (
                          <div className="flex aspect-video items-center justify-center gap-3 text-white">
                            <LoaderCircle className="h-6 w-6 animate-spin text-white/75" />
                            <span className="text-sm text-white/75">Preparing protected lesson player...</span>
                          </div>
                        ) : canAccessLesson && selectedLesson.type === 'youtube' && protectedLessonPlayback?.embedUrl ? (
                          <ProtectedYouTubePlayer
                            embedUrl={protectedLessonPlayback.embedUrl}
                            lessonId={selectedLesson.id}
                            title={selectedLesson.title}
                            playbackSpeed={playbackSpeed}
                            resumeSeconds={protectedLessonPlayback.resumeSeconds}
                            onProgress={(progressSeconds, durationSeconds, completed) => {
                              playbackSnapshotRef.current = {
                                lesson: selectedLesson,
                                courseId: selectedCourse._id,
                                canAccess: canAccessLesson,
                                progressSeconds,
                                mediaDurationSeconds: durationSeconds,
                                completed,
                              };
                              void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, progressSeconds, completed, completed, durationSeconds);
                            }}
                          />
                        ) : canAccessLesson && selectedLesson.type === 'private-video' && (privateVideoDrmManifestUrl || privateVideoStreamUrl) ? (
                          <div>
                            {privateVideoDrmManifestUrl ? (
                              <ResilientHlsVideo
                                key={`${selectedLesson.id}:${privateVideoDrmManifestUrl}`}
                                src={privateVideoDrmManifestUrl}
                                drmConfig={privateVideoDrmConfig}
                                title={selectedLesson.title}
                                trackVideoId={selectedLesson.id}
                                trackCourseId={selectedCourse._id}
                                trackLessonId={selectedLesson.id}
                                trackVideoType={protectedLessonPlayback?.videoType || 'course'}
                                playbackSessionId={protectedLessonPlayback?.playbackSessionId || null}
                                streamFormat={privateVideoDrmConfig?.manifestFormat || privateVideoStreamFormat || 'hls'}
                                resumeSeconds={protectedLessonPlayback?.resumeSeconds ?? selectedLessonProgress?.progressSeconds ?? 0}
                                defaultQualityHeight={480}
                                selectedQualityHeight={selectedPrivateVideoQuality}
                                onQualityOptionsChange={(options) => {
                                  setPrivateVideoQualityOptions(options);
                                  setSelectedPrivateVideoQuality((current) => getDefaultRecordedVideoQualityHeight(options, current));
                                }}
                                className={cn(
                                  'w-full bg-black',
                                  isPlayerFullscreen ? 'h-screen rounded-none border-0' : 'aspect-video',
                                )}
                                onProgress={(progressSeconds, durationSeconds, completed) => {
                                  playbackSnapshotRef.current = {
                                    lesson: selectedLesson,
                                    courseId: selectedCourse._id,
                                    canAccess: canAccessLesson,
                                    progressSeconds,
                                    mediaDurationSeconds: durationSeconds || 0,
                                    completed,
                                  };
                                  void persistLessonProgress(
                                    selectedCourse._id,
                                    canAccessLesson,
                                    selectedLesson,
                                    progressSeconds,
                                    completed,
                                    completed,
                                    durationSeconds,
                                  );
                                }}
                              />
                            ) : (
                              <video
                                key={`${selectedLesson.id}:${privateVideoStreamUrl}`}
                                ref={videoRef}
                                src={privateVideoStreamFormat === 'source' ? privateVideoStreamUrl : undefined}
                                onLoadedMetadata={(event) => {
                                  const resumeSeconds = protectedLessonPlayback?.resumeSeconds ?? selectedLessonProgress?.progressSeconds ?? 0;
                                  if (resumeSeconds > 0) {
                                    seekHostedVideoToResume(event.currentTarget, selectedLesson.id, resumeSeconds, appliedResumeRef);
                                  }
                                }}
                                onCanPlay={(event) => {
                                  const resumeSeconds = protectedLessonPlayback?.resumeSeconds ?? selectedLessonProgress?.progressSeconds ?? 0;
                                  if (resumeSeconds > 0) {
                                    seekHostedVideoToResume(event.currentTarget, selectedLesson.id, resumeSeconds, appliedResumeRef);
                                  }
                                }}
                                onTimeUpdate={(event) => {
                                  playbackSnapshotRef.current = {
                                    lesson: selectedLesson,
                                    courseId: selectedCourse._id,
                                    canAccess: canAccessLesson,
                                    progressSeconds: event.currentTarget.currentTime,
                                    mediaDurationSeconds: event.currentTarget.duration || 0,
                                    completed: false,
                                  };
                                  void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, event.currentTarget.currentTime, false, false, event.currentTarget.duration);
                                }}
                                onPause={(event) => {
                                  playbackSnapshotRef.current = {
                                    lesson: selectedLesson,
                                    courseId: selectedCourse._id,
                                    canAccess: canAccessLesson,
                                    progressSeconds: event.currentTarget.currentTime,
                                    mediaDurationSeconds: event.currentTarget.duration || 0,
                                    completed: false,
                                  };
                                  void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, event.currentTarget.currentTime, false, true, event.currentTarget.duration);
                                }}
                                onEnded={(event) => {
                                  playbackSnapshotRef.current = {
                                    lesson: selectedLesson,
                                    courseId: selectedCourse._id,
                                    canAccess: canAccessLesson,
                                    progressSeconds: event.currentTarget.currentTime,
                                    mediaDurationSeconds: event.currentTarget.duration || 0,
                                    completed: true,
                                  };
                                  void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, event.currentTarget.currentTime, true, true, event.currentTarget.duration);
                                }}
                                controls
                                controlsList="nodownload noplaybackrate"
                                disablePictureInPicture
                                playsInline
                                preload="metadata"
                                className={cn(
                                  'w-full bg-black object-contain',
                                  isPlayerFullscreen ? 'h-screen' : 'aspect-video',
                                )}
                              />
                            )}
                            {privateVideoStreamFormat === 'hls' && privateVideoQualityOptions.length > 0 ? (
                              <div className="flex items-center justify-end gap-3 border-t border-[var(--line)] bg-[var(--panel)] px-4 py-3">
                                <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Quality</span>
                                <select
                                  value={String(selectedPrivateVideoQuality)}
                                  onChange={(event) => setSelectedPrivateVideoQuality(Number(event.target.value))}
                                  className="rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm text-[var(--ink)]"
                                >
                                  {privateVideoQualityOptions.map((option) => (
                                    <option key={option.height} value={String(option.height)}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : null}
                          </div>
                        ) : canAccessLesson && hostedVideoUrl ? (
                          <video
                            key={`${selectedLesson.id}:${hostedVideoUrl}`}
                            ref={videoRef}
                            src={hostedVideoUrl}
                            onLoadedMetadata={(event) => {
                              const resumeSeconds = selectedLessonProgress?.progressSeconds || 0;
                              if (resumeSeconds > 0) {
                                seekHostedVideoToResume(event.currentTarget, selectedLesson.id, resumeSeconds, appliedResumeRef);
                              }
                            }}
                            onCanPlay={(event) => {
                              const resumeSeconds = selectedLessonProgress?.progressSeconds || 0;
                              if (resumeSeconds > 0) {
                                seekHostedVideoToResume(event.currentTarget, selectedLesson.id, resumeSeconds, appliedResumeRef);
                              }
                            }}
                            onTimeUpdate={(event) => {
                              playbackSnapshotRef.current = {
                                lesson: selectedLesson,
                                courseId: selectedCourse._id,
                                canAccess: canAccessLesson,
                                progressSeconds: event.currentTarget.currentTime,
                                mediaDurationSeconds: event.currentTarget.duration || 0,
                                completed: false,
                              };
                              void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, event.currentTarget.currentTime, false, false, event.currentTarget.duration);
                            }}
                            onPause={(event) => {
                              playbackSnapshotRef.current = {
                                lesson: selectedLesson,
                                courseId: selectedCourse._id,
                                canAccess: canAccessLesson,
                                progressSeconds: event.currentTarget.currentTime,
                                mediaDurationSeconds: event.currentTarget.duration || 0,
                                completed: false,
                              };
                              void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, event.currentTarget.currentTime, false, true, event.currentTarget.duration);
                            }}
                            onEnded={(event) => {
                              playbackSnapshotRef.current = {
                                lesson: selectedLesson,
                                courseId: selectedCourse._id,
                                canAccess: canAccessLesson,
                                progressSeconds: event.currentTarget.currentTime,
                                mediaDurationSeconds: event.currentTarget.duration || 0,
                                completed: true,
                              };
                              void persistLessonProgress(selectedCourse._id, canAccessLesson, selectedLesson, event.currentTarget.currentTime, true, true, event.currentTarget.duration);
                            }}
                            controls
                            controlsList="nodownload"
                            playsInline
                            preload="metadata"
                            className={cn(
                              'w-full bg-black object-contain',
                              isPlayerFullscreen ? 'h-screen' : 'aspect-video',
                            )}
                          />
                        ) : canAccessLesson && selectedLesson.type === 'private-video' && protectedLessonPlayback?.statusMessage ? (
                          <div className="flex aspect-video flex-col items-center justify-center gap-4 px-6 text-center text-white">
                            <LoaderCircle className="h-10 w-10 animate-spin text-white/70" />
                            <div>
                              <p className="text-lg font-semibold">Video is still preparing</p>
                              <p className="mt-2 text-sm leading-7 text-white/68">{protectedLessonPlayback.statusMessage}</p>
                            </div>
                          </div>
                        ) : canAccessLesson && ['youtube', 'private-video'].includes(selectedLesson.type) && protectedLessonError ? (
                          <div className="flex aspect-video flex-col items-center justify-center gap-4 px-6 text-center text-white">
                            <Lock className="h-10 w-10 text-[var(--accent-rust)]" />
                            <div>
                              <p className="text-lg font-semibold">Protected lesson unavailable</p>
                              <p className="mt-2 text-sm leading-7 text-white/68">{protectedLessonError}</p>
                            </div>
                          </div>
                        ) : canAccessLesson ? (
                          <div className="flex aspect-video flex-col items-center justify-center gap-4 px-6 text-center text-white">
                            <p className="text-lg font-semibold">Video will appear here</p>
                            <p className="max-w-2xl text-sm leading-7 text-white/68">This topic is available, but the secure player could not be rendered from the current lesson type.</p>
                          </div>
                        ) : (
                          <div className="flex aspect-video flex-col items-center justify-center gap-4 px-6 text-center text-white">
                            <Lock className="h-10 w-10 text-[var(--accent-rust)]" />
                            <div>
                              <p className="text-lg font-semibold">Lesson locked</p>
                              <p className="mt-2 text-sm leading-7 text-white/68">{selectedLessonAccess?.reason || 'Enroll in this course to unlock protected video playback, notes, and tracked progress for this topic.'}</p>
                            </div>
                          </div>
                        )}
                        {coursePrivacyShieldActive ? (
                          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black text-white">
                            <div className="flex max-w-[420px] flex-col items-center gap-3 px-6 text-center">
                              <p className="text-lg font-semibold">Protected playback hidden</p>
                              <p className="text-sm text-white/72">Return to the active player window to continue watching this lesson.</p>
                            </div>
                          </div>
                        ) : null}
                        {courseCaptureWarning ? (
                          <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
                            <div className="rounded-full bg-[#111827]/88 px-4 py-2 text-xs font-semibold text-white shadow-[0_10px_24px_rgba(0,0,0,0.26)]">
                              {courseCaptureWarning}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {!canAccessLesson && (
                      <div className="mt-4 rounded-[20px] border border-[#ffe2d5] bg-[#fff8f3] p-4">
                        <p className="text-sm font-semibold text-[#a6521a]">This topic is not ready to play yet</p>
                        <p className="mt-2 text-sm leading-6 text-[#8a5a34]">
                          {selectedLessonAccess?.reason || 'Unlock the course to access protected playback, notes, and synced progress.'}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-3">
                          {shouldShowCoursePaymentButton(selectedCourse) && (
                            <button
                              onClick={() => handleUnlock(selectedCourse)}
                              disabled={busyCourseId === selectedCourse._id}
                              className="inline-flex items-center gap-2 rounded-full bg-[var(--accent-rust)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                            >
                              {busyCourseId === selectedCourse._id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                              {getCoursePrimaryActionLabel(selectedCourse, selectedCourseSnapshot.progressPercent)}
                            </button>
                          )}
                          {previousLessonEntry && (
                            <button
                              onClick={() => handleSelectLesson(previousLessonEntry.lesson.id)}
                              className="rounded-full border border-[#d7e5f1] bg-white px-4 py-2 text-sm font-semibold text-[#172033]"
                            >
                              Open previous topic
                            </button>
                          )}
                          {!previousLessonEntry && firstAccessibleLessonEntry && firstAccessibleLessonEntry.lesson.id !== selectedLesson.id && (
                            <button
                              onClick={() => handleSelectLesson(firstAccessibleLessonEntry.lesson.id)}
                              className="rounded-full border border-[#d7e5f1] bg-white px-4 py-2 text-sm font-semibold text-[#172033]"
                            >
                              Open first available topic
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf2f7] pt-4">
                      <div className="flex flex-wrap gap-2">
                        {canAccessLesson && lessonAttachments.length > 0 && (
                          <button
                            type="button"
                            onClick={() => void openPdfAttachment(lessonAttachments[0])}
                            disabled={loadingPdfId === lessonAttachments[0].id}
                            className="inline-flex items-center gap-2 rounded-full bg-[#f4f7fb] px-4 py-2 text-sm font-semibold text-[#172033] disabled:opacity-60"
                          >
                            {loadingPdfId === lessonAttachments[0].id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                            View notes PDF
                          </button>
                        )}
                        {canAccessLesson && !selectedLessonProgress?.completed && (
                          <button
                            onClick={() => void markLessonComplete()}
                            className="rounded-full bg-[#f4f7fb] px-4 py-2 text-sm font-semibold text-[#172033]"
                          >
                            Mark complete
                          </button>
                        )}
                        <button
                          onClick={() => onToggleSavedTopic(selectedCourse._id, selectedLesson.id)}
                          className="rounded-full bg-[#f4f7fb] px-4 py-2 text-sm font-semibold text-[#172033]"
                        >
                          {selectedLessonSaved ? 'Saved topic' : 'Save topic'}
                        </button>
                        <button
                          className="rounded-full bg-[#f4f7fb] px-4 py-2 text-sm font-semibold text-[#172033]"
                          type="button"
                        >
                          Report issue
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-3 text-sm text-[#607089]">
                        <span>{selectedLessonProgress?.completed ? 'Completed' : `${selectedLessonProgress?.progressPercent || 0}% watched`}</span>
                        <span>Resume {formatPlaybackTime(selectedLessonProgress?.progressSeconds || 0)}</span>
                      </div>
                    </div>

                    <div className="mt-5 flex flex-col gap-5 border-t border-[#edf2f7] pt-5">
                      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex items-center gap-4">
                          <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-[20px] bg-[linear-gradient(135deg,#172033,#334867)] text-white shadow-[0_18px_32px_rgba(23,32,51,0.18)]">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/68">Topic</span>
                            <span className="mt-1 text-2xl font-semibold leading-none">{selectedLessonIndex + 1}</span>
                          </div>
                          <div>
                            <p className="text-2xl font-semibold text-[#172033]">{selectedLesson.title}</p>
                            <p className="mt-1 text-sm text-[#607089]">{selectedCourse.instructor}</p>
                            <p className="mt-1 text-sm text-[#90a0b4]">{selectedCourse.subject} • {selectedCourse.level}</p>
                          </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <button
                            onClick={() => previousLessonEntry && handleSelectLesson(previousLessonEntry.lesson.id)}
                            disabled={!previousLessonEntry}
                            className="inline-flex items-center justify-between rounded-[18px] border border-[#dbe4ef] bg-white px-4 py-3 text-left text-sm font-medium text-[#172033] disabled:opacity-45"
                          >
                            <span className="inline-flex items-center gap-2">
                              <ChevronLeft className="h-4 w-4" />
                              Previous topic
                            </span>
                          </button>
                          <button
                            onClick={() => nextLessonEntry && handleSelectLesson(nextLessonEntry.lesson.id)}
                            disabled={!nextLessonEntry}
                            className="inline-flex items-center justify-between rounded-[18px] border border-[#dbe4ef] bg-white px-4 py-3 text-left text-sm font-medium text-[#172033] disabled:opacity-45"
                          >
                            <span className="inline-flex items-center gap-2">
                              Next topic
                              <ChevronRight className="h-4 w-4" />
                            </span>
                          </button>
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-3">
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Lesson path</p>
                          <p className="mt-2 text-sm font-semibold leading-6 text-[#172033]">
                            {[selectedLessonMeta?.moduleTitle, selectedLessonMeta?.chapterTitle, selectedLesson.title].filter(Boolean).join(' > ')}
                          </p>
                        </div>
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Access</p>
                          <p className="mt-2 text-sm font-semibold text-[#172033]">{hasActiveCourseAccess(selectedCourse) ? 'Unlocked course access' : getCoursePrimaryActionLabel(selectedCourse, selectedCourseSnapshot.progressPercent)}</p>
                        </div>
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Continue learning</p>
                          <p className="mt-2 text-sm font-semibold text-[#172033]">{selectedCourse.continueLesson?.title || selectedLesson.title}</p>
                        </div>
                      </div>

                      {canAccessLesson && (lessonAttachments.length > 0 || chapterAttachments.length > 0 || moduleAttachments.length > 0) && (
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="rounded-[18px] border border-[#e4ecf5] bg-white p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Lesson PDFs</p>
                            <div className="mt-3 space-y-2">
                              {lessonAttachments.length > 0 ? lessonAttachments.map((attachment) => (
                                <button
                                  key={attachment.id}
                                  type="button"
                                  onClick={() => void openPdfAttachment(attachment)}
                                  disabled={loadingPdfId === attachment.id}
                                  className="flex w-full items-center justify-between rounded-[14px] bg-[#f8fbff] px-3 py-3 text-left text-sm font-semibold text-[#172033] disabled:opacity-60"
                                >
                                  <span className="truncate">{attachment.title}</span>
                                  {loadingPdfId === attachment.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-[#4b76b3]" />}
                                </button>
                              )) : <p className="text-sm text-[#607089]">No lesson PDFs yet.</p>}
                            </div>
                          </div>

                          <div className="rounded-[18px] border border-[#e4ecf5] bg-white p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Chapter PDFs</p>
                            <div className="mt-3 space-y-2">
                              {chapterAttachments.length > 0 ? chapterAttachments.map((attachment) => (
                                <button
                                  key={attachment.id}
                                  type="button"
                                  onClick={() => void openPdfAttachment(attachment)}
                                  disabled={loadingPdfId === attachment.id}
                                  className="flex w-full items-center justify-between rounded-[14px] bg-[#f8fbff] px-3 py-3 text-left text-sm font-semibold text-[#172033] disabled:opacity-60"
                                >
                                  <span className="truncate">{attachment.title}</span>
                                  {loadingPdfId === attachment.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-[#4b76b3]" />}
                                </button>
                              )) : <p className="text-sm text-[#607089]">No chapter PDFs yet.</p>}
                            </div>
                          </div>

                          <div className="rounded-[18px] border border-[#e4ecf5] bg-white p-4">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Subject PDFs</p>
                            <div className="mt-3 space-y-2">
                              {moduleAttachments.length > 0 ? moduleAttachments.map((attachment) => (
                                <button
                                  key={attachment.id}
                                  type="button"
                                  onClick={() => void openPdfAttachment(attachment)}
                                  disabled={loadingPdfId === attachment.id}
                                  className="flex w-full items-center justify-between rounded-[14px] bg-[#f8fbff] px-3 py-3 text-left text-sm font-semibold text-[#172033] disabled:opacity-60"
                                >
                                  <span className="truncate">{attachment.title}</span>
                                  {loadingPdfId === attachment.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-[#4b76b3]" />}
                                </button>
                              )) : <p className="text-sm text-[#607089]">No subject PDFs yet.</p>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </main>

              <aside className="border-t border-[#e7edf5] bg-white xl:col-span-2 2xl:col-span-1 2xl:border-l 2xl:border-t-0 2xl:sticky 2xl:top-0 2xl:h-screen">
                <div className="grid grid-cols-2 border-b border-[#edf2f7]">
                  {[
                    { key: 'notes', label: 'Notes', icon: BookOpen },
                    { key: 'assistant', label: 'AI Help', icon: MessageSquare },
                  ].map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => setStudySidebarTab(tab.key as typeof studySidebarTab)}
                        className={cn(
                          'flex items-center justify-center gap-2 px-3 py-4 text-sm font-semibold transition',
                          studySidebarTab === tab.key
                            ? 'border-b-2 border-[#22c7f2] text-[#22c7f2]'
                            : 'text-[#7b8ba2]',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="hidden sm:inline">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="max-h-[calc(100vh-220px)] overflow-y-auto p-5 2xl:max-h-[calc(100vh-76px)]">
                  {LIVE_CLASSES_ENABLED ? (
                    <div className="mb-4 rounded-[18px] border border-[#e2ebf4] bg-[#f8fbff] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-[#172033]">Session archive</p>
                          <p className="mt-2 text-sm leading-6 text-[#607089]">
                            Open live classes and replays without leaving the lesson screen.
                          </p>
                        </div>
                        <Clock3 className="mt-1 h-5 w-5 text-[#22a8d4]" />
                      </div>
                      <button
                        onClick={() => setCourseWorkspaceTab('sessions')}
                        className="mt-4 inline-flex w-full items-center justify-center rounded-[14px] bg-[#172033] px-4 py-3 text-sm font-semibold text-white"
                      >
                        Open sessions workspace
                      </button>
                    </div>
                  ) : null}

                  {studySidebarTab === 'notes' && (
                    <div className="space-y-4">
                      <div className="rounded-[18px] bg-[#f8fbff] p-4">
                        <p className="text-sm font-semibold text-[#172033]">Current topic</p>
                        <p className="mt-2 text-xl font-semibold text-[#172033]">{selectedLesson.title}</p>
                        <p className="mt-3 text-sm leading-6 text-[#607089]">
                          {[selectedLessonMeta?.moduleTitle, selectedLessonMeta?.chapterTitle, selectedLesson.title].filter(Boolean).join(' > ')}
                        </p>
                      </div>

                      {canAccessLesson && (lessonAttachments.length > 0 || chapterAttachments.length > 0 || moduleAttachments.length > 0) ? (
                        <div className="space-y-3">
                          {[
                            { label: 'Lesson PDFs', items: lessonAttachments },
                            { label: 'Chapter PDFs', items: chapterAttachments },
                            { label: 'Subject PDFs', items: moduleAttachments },
                          ].map((group) => (
                            <div key={group.label} className="rounded-[18px] border border-[#dbe4ef] bg-white p-4">
                              <p className="text-sm font-semibold text-[#172033]">{group.label}</p>
                              <div className="mt-3 space-y-2">
                                {group.items.map((attachment) => (
                                  <button
                                    key={attachment.id}
                                    type="button"
                                    onClick={() => void openPdfAttachment(attachment)}
                                    disabled={loadingPdfId === attachment.id}
                                    className="flex w-full items-center justify-between rounded-[14px] bg-[#f8fbff] px-3 py-3 text-left text-sm font-semibold text-[#172033] disabled:opacity-60"
                                  >
                                    <span className="truncate">{attachment.title}</span>
                                    {loadingPdfId === attachment.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-[#4b76b3]" />}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-[18px] border border-dashed border-[#dbe4ef] p-4 text-sm text-[#607089]">
                          {canAccessLesson
                            ? 'No protected PDFs are attached for this topic path yet.'
                            : 'Unlock this topic to access notes and other study resources.'}
                        </div>
                      )}

                      <div className="grid gap-3">
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Topic progress</p>
                          <p className="mt-2 text-2xl font-semibold text-[#172033]">{selectedLessonProgress?.completed ? 'Completed' : `${selectedLessonProgress?.progressPercent || 0}% watched`}</p>
                        </div>
                        <div className="rounded-[18px] bg-[#f8fbff] p-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Resume point</p>
                          <p className="mt-2 text-2xl font-semibold text-[#172033]">{formatPlaybackTime(selectedLessonProgress?.progressSeconds || 0)}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {studySidebarTab === 'assistant' && (
                    <div className="space-y-4">
                      <div className="rounded-[18px] bg-[#f8fbff] p-4">
                        <p className="text-sm font-semibold text-[#172033]">Ask a topic doubt</p>
                        <p className="mt-2 text-sm leading-6 text-[#607089]">Ask for concept clarity, shortcuts, or exam-oriented explanations for this topic.</p>
                      </div>
                      <textarea
                        value={lessonDoubt}
                        onChange={(event) => setLessonDoubt(event.target.value)}
                        placeholder={`Ask about ${selectedLesson.title}...`}
                        className="h-32 w-full rounded-[18px] border border-[#dbe4ef] bg-[#fbfdff] px-4 py-4 text-sm outline-none transition focus:border-[#8cb4dd]"
                      />
                      <button
                        onClick={() => void askLessonDoubt()}
                        disabled={askingLessonDoubt || !lessonDoubt.trim()}
                        className="w-full rounded-[16px] bg-[#172033] px-5 py-3 font-semibold text-white disabled:opacity-55"
                      >
                        {askingLessonDoubt ? 'Thinking...' : 'Ask AI doubt helper'}
                      </button>
                      {lessonDoubtAnswer && (
                        <div className="rounded-[18px] border border-[#e2ebf4] bg-white p-4 text-sm leading-7 text-[#607089]">
                          {lessonDoubtAnswer}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </aside>
            </div>
          ) : (
            <div className="p-8 text-[#607089]">
              Select a topic from the course to open the lesson player.
            </div>
          )}
        </section>
        </div>
      )}

      {(activePdfAttachment || pdfViewerError) && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[#06111fcc] px-4 py-6">
          <div className="flex h-full max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-[28px] bg-white shadow-[0_28px_80px_rgba(0,0,0,0.32)]">
            <div className="flex items-center justify-between gap-4 border-b border-[#e7edf5] px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a9ab0]">Protected PDF Viewer</p>
                <p className="mt-1 text-lg font-semibold text-[#172033]">{activePdfAttachment?.title || 'PDF viewer'}</p>
              </div>
              <button
                type="button"
                onClick={closePdfViewer}
                className="inline-flex items-center gap-2 rounded-full border border-[#d7e5f1] px-4 py-2 text-sm font-semibold text-[#172033]"
              >
                <X className="h-4 w-4" />
                Close
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-[#eef3f8] bg-[#f8fbff] px-5 py-3 text-sm text-[#607089]">
              <p>Best-effort protection: no public link, inline viewer only, and no visible download action in the app UI.</p>
              <p className="hidden sm:block">Download, print, and open actions are intentionally omitted here.</p>
            </div>

            <div className="min-h-0 flex-1 bg-[#dfe8f3]">
              {pdfViewerError ? (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div>
                    <p className="text-lg font-semibold text-[#172033]">PDF could not be opened</p>
                    <p className="mt-2 text-sm leading-6 text-[#607089]">{pdfViewerError}</p>
                  </div>
                </div>
              ) : activePdfUrl ? (
                <iframe
                  title={activePdfAttachment?.title || 'Protected PDF'}
                  src={activePdfUrl}
                  className="h-full w-full border-0"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <LoaderCircle className="h-8 w-8 animate-spin text-[#4b76b3]" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
