import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  Bell,
  Bookmark,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Filter,
  FileText,
  LayoutGrid,
  List,
  Lock,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoreVertical,
  Pause,
  Play,
  Search,
  Send,
  MessageSquare,
  Sparkles,
  Star,
  AlertTriangle,
  Video,
  Wallet,
} from 'lucide-react';
import {
  CourseCard,
  CourseLesson,
  LessonDoubtMessage,
  LessonDoubtThread,
  LessonReportRecord,
  MockTest,
  PlatformOverview,
  ProtectedLessonPlayback,
} from '../types';
import { cn } from '../lib/utils';
import { wireHlsPlaybackMetrics } from '../lib/hlsPlaybackMetrics';
import { openRazorpayCheckout } from '../lib/razorpayCheckout';
import { ResilientHlsVideo, type ResilientHlsVideoHandle } from './ResilientHlsVideo';
import {
  createProtectedVodHlsConfig,
  getDefaultRecordedVideoQualityHeight,
  getRecordedVideoQualityLevel,
  getRecordedVideoQualityOptions,
  type RecordedVideoQualityOption,
  scheduleAutoLevelRelease,
  shouldFallbackToSourceFromHlsError,
} from '../lib/hlsPlaybackTuning';
import { useAuth } from '../AuthContext';
import { EduService } from '../EduService';

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const WATERMARK_VISIBLE_DURATION_MS = 5000;
const WATERMARK_HIDDEN_INTERVAL_MS = 10000;
const LESSON_DOUBT_POLL_INTERVAL_MS = 10000;
const LESSON_REPORT_ISSUE_OPTIONS: Array<{ value: LessonReportIssueType; label: string }> = [
  { value: 'video_not_playing', label: 'Video not playing' },
  { value: 'audio_issue', label: 'Audio issue' },
  { value: 'video_buffering', label: 'Video buffering' },
  { value: 'wrong_lesson', label: 'Wrong lesson' },
  { value: 'fullscreen_issue', label: 'Fullscreen issue' },
  { value: 'seek_progress_issue', label: 'Seek/progress issue' },
  { value: 'payment_access_issue', label: 'Payment/access issue' },
  { value: 'other', label: 'Other' },
];

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
    ? `Fee ${currency.format(basePrice)} • ${offerPercentage}% off • Pay ${currency.format(finalPrice)}`
    : `Fee ${currency.format(basePrice)}`;
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
    return progressPercent > 0 ? 'Continue Course' : 'Start Course';
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

type CourseFigmaTabProps = {
  overview: PlatformOverview;
  onRefresh: () => Promise<void>;
  initialCourseId?: string | null;
  initialLessonId?: string | null;
  initialDoubtThreadId?: string | null;
  initialReportId?: string | null;
  initialSupportPanel?: 'doubts' | 'report' | null;
  onResumeNavigationHandled?: () => void;
  savedTopicIds: string[];
  onToggleSavedTopic: (courseId: string, lessonId: string) => void;
  onImmersiveModeChange?: (immersive: boolean) => void;
  onOpenCbtExam?: (test: MockTest, onSubmitted?: () => void) => void;
};


type Screen = 'catalog' | 'course' | 'lesson';
type CourseTab = 'Lessons';
type LessonTab = 'Video' | 'CBT Exam' | 'Explanation';
type LessonSupportPanel = 'notes' | 'doubts' | 'report' | null;
type MobileSupportTab = 'notes' | 'doubts';
type MobileWatchPanel = 'rating' | 'chat' | 'report' | null;
type LessonReportIssueType = 'video_not_playing' | 'audio_issue' | 'video_buffering' | 'wrong_lesson' | 'fullscreen_issue' | 'seek_progress_issue' | 'payment_access_issue' | 'other';
type LessonStage = 'video' | 'exam' | 'explanation';
type MobileLessonStage = 'watch' | 'completed' | 'exam' | 'exam-complete' | 'explanation' | 'explanation-complete';
type CatalogTone = 'blue' | 'teal' | 'orange' | 'purple';
type WatermarkPosition = {
  top: string;
  left: string;
  rotate: string;
};

const createRandomWatermarkPosition = (): WatermarkPosition => ({
  top: `${12 + Math.random() * 64}%`,
  left: `${14 + Math.random() * 68}%`,
  rotate: `${-20 + Math.random() * 40}deg`,
});

type StoredProgress = {
  lessonId: string;
  progressPercent: number;
  progressSeconds: number;
  completed: boolean;
  lessonStage?: LessonStage;
  examSubmitted?: boolean;
  examSelectedOption?: number | null;
  explanationSeconds?: number;
  videoWatchCount?: number;
  explanationWatchCount?: number;
  updatedAt: string;
};

type StoredProgressPatch = Partial<StoredProgress> & Pick<StoredProgress, 'lessonId'>;

type CourseLessonEntry = {
  lesson: CourseLesson;
  moduleId: string;
  moduleTitle: string;
  chapterId: string | null;
  chapterTitle: string | null;
  sectionId: string;
  sectionLabel: string;
  sectionTitle: string;
  sectionIndex: number;
  lessonIndex: number;
};

type CourseSection = {
  id: string;
  label: string;
  title: string;
  moduleId: string;
  chapterId: string | null;
  lessons: CourseLessonEntry[];
};

type LessonCopy = {
  heading: string;
  summary: string;
  about: string;
  takeaways: string[];
  notes: Array<{ title: string; body: string }>;
  quiz: {
    title: string;
    prompt: string;
    options: string[];
    answerIndex: number;
    explanation: string;
    totalQuestions: number;
    durationMinutes: number;
  };
  discussionPrompt: string;
  quickTip: string;
};

const uiFontStyle = {
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as React.CSSProperties;

const PLAYER_STORAGE_PREFIX = 'edumaster.course-figma-progress';
const PLAYER_TICK_MS = 320;
const PLAYER_TICK_STEP_SECONDS = 18;
const AUTOPLAY_COUNTDOWN_SECONDS = 3;
const VIDEO_STAGE_PROGRESS = 34;
const EXAM_STAGE_PROGRESS = 67;
const EXPLANATION_DURATION_SECONDS = 120;
const MAX_VIDEO_WATCHES = 2;
const MAX_EXPLANATION_WATCHES = 1;
const VIDEO_COMPLETION_MIN_WATCH_RATIO = 0.9;

const courseTabs: CourseTab[] = ['Lessons'];
const lessonTabs: LessonTab[] = ['Video'];
const mobileLessonTabLabels: Record<LessonTab, string> = {
  Video: 'Video',
  'CBT Exam': 'Quiz',
  Explanation: 'Discussion',
};

const buildLessonDoubtDraftKey = (lessonId: string, threadId?: string | null) =>
  `${String(lessonId)}::${String(threadId || 'compose')}`;

const formatLessonDoubtTime = (value?: string | null) => {
  const target = value ? new Date(value) : null;
  if (!target || Number.isNaN(target.getTime())) {
    return 'Now';
  }

  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(target);
};

const toneStyles: Record<CatalogTone, {
  surface: string;
  chip: string;
  button: string;
  progress: string;
  sidebar: string;
}> = {
  blue: {
    surface: 'bg-[linear-gradient(180deg,#dce9ff_0%,#edf4ff_30%,#ffffff_100%)]',
    chip: 'bg-[#5a98f5] text-white',
    button: 'bg-[linear-gradient(180deg,#4285f4_0%,#2d6ee5_100%)] shadow-[0_14px_28px_rgba(45,110,229,0.24)]',
    progress: 'bg-[linear-gradient(90deg,#58a3ff_0%,#7bb8ff_100%)]',
    sidebar: 'bg-[#edf4ff]',
  },
  teal: {
    surface: 'bg-[linear-gradient(180deg,#d8f0f7_0%,#eef8fd_30%,#ffffff_100%)]',
    chip: 'bg-[#60c0d5] text-white',
    button: 'bg-[linear-gradient(180deg,#5bc3da_0%,#45aac4_100%)] shadow-[0_14px_28px_rgba(69,170,196,0.22)]',
    progress: 'bg-[linear-gradient(90deg,#5ebfe1_0%,#7fd0e7_100%)]',
    sidebar: 'bg-[#eef8fb]',
  },
  orange: {
    surface: 'bg-[linear-gradient(180deg,#ffe6d5_0%,#fff3eb_30%,#ffffff_100%)]',
    chip: 'bg-[#f6a04d] text-white',
    button: 'bg-[linear-gradient(180deg,#f7a348_0%,#f18f32_100%)] shadow-[0_14px_28px_rgba(241,143,50,0.24)]',
    progress: 'bg-[linear-gradient(90deg,#f6a455_0%,#f4b56d_100%)]',
    sidebar: 'bg-[#fff5ee]',
  },
  purple: {
    surface: 'bg-[linear-gradient(180deg,#efe5ff_0%,#f7f1ff_30%,#ffffff_100%)]',
    chip: 'bg-[#9b6cf2] text-white',
    button: 'bg-[linear-gradient(180deg,#9b67f0_0%,#8351e6_100%)] shadow-[0_14px_28px_rgba(131,81,230,0.24)]',
    progress: 'bg-[linear-gradient(90deg,#a57cf6_0%,#be9bff_100%)]',
    sidebar: 'bg-[#f4edff]',
  },
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const formatDurationLabel = (minutes: number) => `${minutes} min${minutes === 1 ? '' : 's'}`;

const mobileCatalogPriority: Record<string, number> = {
  'rrb je civil fast track': 0,
  'ssc je 2026 electrical power track': 1,
  'ssc je general awareness revision vault': 2,
};

const mobileDisplayTitleMap: Record<string, string> = {
  'ssc je general awareness revision vault': 'SSC JE General Awareness Vault',
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

const buildInitials = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'EM';

const normalize = (value?: string | null) => String(value || '').trim().toLowerCase();

const getMobileCoursePriority = (course: CourseCard) => mobileCatalogPriority[normalize(course.title)] ?? 99;

const getMobileCatalogTone = (course: CourseCard): CatalogTone => {
  const title = normalize(course.title);
  if (title === 'rrb je civil fast track') {
    return 'blue';
  }
  if (title === 'ssc je general awareness revision vault') {
    return 'purple';
  }
  if (title === 'ssc je 2026 electrical power track') {
    return 'teal';
  }
  return getCatalogTone(course, 0);
};

const getMobileCourseTitle = (course?: CourseCard | null) => {
  const title = String(course?.title || '');
  return mobileDisplayTitleMap[normalize(title)] || title;
};

const buildStorageKey = (courseId: string) => `${PLAYER_STORAGE_PREFIX}.${courseId}`;
const getLessonStagePriority = (stage?: LessonStage | null) => {
  switch (stage) {
    case 'explanation':
      return 3;
    case 'exam':
      return 2;
    case 'video':
      return 1;
    default:
      return 0;
  }
};

const mergeStoredProgress = (
  existing?: StoredProgress | null,
  incoming?: StoredProgress | null,
): StoredProgress | null => {
  if (!existing && !incoming) {
    return null;
  }

  if (!existing) {
    return incoming || null;
  }

  if (!incoming) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
    lessonId: incoming.lessonId || existing.lessonId,
    progressPercent: Math.max(Number(existing.progressPercent || 0), Number(incoming.progressPercent || 0)),
    progressSeconds: Math.max(Number(existing.progressSeconds || 0), Number(incoming.progressSeconds || 0)),
    completed: Boolean(existing.completed) || Boolean(incoming.completed),
    lessonStage: getLessonStagePriority(existing.lessonStage) >= getLessonStagePriority(incoming.lessonStage)
      ? existing.lessonStage
      : incoming.lessonStage,
    examSubmitted: Boolean(existing.examSubmitted) || Boolean(incoming.examSubmitted),
    examSelectedOption: incoming.examSelectedOption ?? existing.examSelectedOption ?? null,
    explanationSeconds: Math.max(Number(existing.explanationSeconds || 0), Number(incoming.explanationSeconds || 0)),
    videoWatchCount: Math.max(Number(existing.videoWatchCount || 0), Number(incoming.videoWatchCount || 0)),
    explanationWatchCount: Math.max(Number(existing.explanationWatchCount || 0), Number(incoming.explanationWatchCount || 0)),
    updatedAt: incoming.updatedAt || existing.updatedAt,
  };
};

const readStoredProgress = (courseId: string) => {
  if (typeof window === 'undefined' || !courseId) {
    return {} as Record<string, StoredProgress>;
  }

  try {
    const raw = window.localStorage.getItem(buildStorageKey(courseId));
    return raw ? JSON.parse(raw) as Record<string, StoredProgress> : {};
  } catch {
    return {};
  }
};

const writeStoredProgress = (courseId: string, progress: Record<string, StoredProgress>) => {
  if (typeof window === 'undefined' || !courseId) {
    return;
  }

  try {
    window.localStorage.setItem(buildStorageKey(courseId), JSON.stringify(progress));
  } catch {
    // Ignore local storage write failures and keep UI responsive.
  }
};

const findCourseIdForLesson = (courses: CourseCard[], lessonId?: string | null) => {
  if (!lessonId) {
    return null;
  }

  for (const course of courses) {
    for (const module of course.modules || []) {
      if ((module.lessons || []).some((lesson) => lesson.id === lessonId)) {
        return course._id;
      }
      for (const chapter of module.chapters || []) {
        if ((chapter.lessons || []).some((lesson) => lesson.id === lessonId)) {
          return course._id;
        }
      }
    }
  }

  return null;
};

const getCatalogTone = (course: CourseCard | null | undefined, index: number): CatalogTone => {
  const exam = normalize(course?.exam);
  const subject = normalize(course?.subject);

  if (exam.includes('rrb')) {
    return 'teal';
  }

  if (subject.includes('general') || subject.includes('reasoning')) {
    return 'orange';
  }

  return (['blue', 'teal', 'orange'] as CatalogTone[])[index % 3];
};

const buildCourseSections = (course: CourseCard | null): CourseSection[] => {
  if (!course) {
    return [];
  }

  const sections: CourseSection[] = [];
  let sectionCount = 0;
  let lessonCount = 0;

  (course.modules || []).forEach((module) => {
    if ((module.lessons || []).length > 0) {
      sectionCount += 1;
      const sectionId = `${module.id}::module`;
      const lessons: CourseLessonEntry[] = (module.lessons || []).map((lesson) => {
        lessonCount += 1;
        return {
          lesson,
          moduleId: module.id,
          moduleTitle: module.title,
          chapterId: null,
          chapterTitle: null,
          sectionId,
          sectionLabel: `Chapter ${sectionCount}`,
          sectionTitle: module.title,
          sectionIndex: sectionCount,
          lessonIndex: lessonCount,
        };
      });

      sections.push({
        id: sectionId,
        label: `Chapter ${sectionCount}`,
        title: module.title,
        moduleId: module.id,
        chapterId: null,
        lessons,
      });
    }

    (module.chapters || []).forEach((chapter) => {
      sectionCount += 1;
      const sectionId = `${module.id}::${chapter.id}`;
      const lessons: CourseLessonEntry[] = (chapter.lessons || []).map((lesson) => {
        lessonCount += 1;
        return {
          lesson,
          moduleId: module.id,
          moduleTitle: module.title,
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          sectionId,
          sectionLabel: `Chapter ${sectionCount}`,
          sectionTitle: chapter.title,
          sectionIndex: sectionCount,
          lessonIndex: lessonCount,
        };
      });

      sections.push({
        id: sectionId,
        label: `Chapter ${sectionCount}`,
        title: chapter.title,
        moduleId: module.id,
        chapterId: chapter.id,
        lessons,
      });
    });
  });

  return sections;
};

const buildProgressMap = (
  course: CourseCard | null,
  localProgress: Record<string, StoredProgress>,
  transientProgress?: StoredProgress | null,
) => {
  const progressMap = new Map<string, StoredProgress>();

  (course?.lessonProgress || []).forEach((entry) => {
    progressMap.set(entry.lessonId, mergeStoredProgress(progressMap.get(entry.lessonId), entry as StoredProgress) as StoredProgress);
  });

  Object.values(localProgress || {}).forEach((entry) => {
    progressMap.set(entry.lessonId, mergeStoredProgress(progressMap.get(entry.lessonId), entry) as StoredProgress);
  });

  if (transientProgress?.lessonId) {
    progressMap.set(transientProgress.lessonId, mergeStoredProgress(progressMap.get(transientProgress.lessonId), transientProgress) as StoredProgress);
  }

  return progressMap;
};

const buildCourseSnapshot = (
  course: CourseCard,
  localProgress: Record<string, StoredProgress>,
  transientProgress?: StoredProgress | null,
) => {
  const sections = buildCourseSections(course);
  const lessons = sections.flatMap((section) => section.lessons);
  const progressMap = buildProgressMap(course, localProgress, transientProgress);
  const totalLessons = lessons.length;
  const completedLessons = lessons.filter((entry) => hasLessonVideoMilestone(progressMap.get(entry.lesson.id))).length;
  const progressPercent = totalLessons === 0
    ? 0
    : Math.round(
      lessons.reduce((sum, entry) => sum + Number(progressMap.get(entry.lesson.id)?.progressPercent || 0), 0) / totalLessons,
    );

  return {
    totalLessons,
    completedLessons,
    progressPercent,
  };
};

const isDemoPreviewLesson = (lesson?: CourseLesson | null) =>
  Boolean(
    lesson
    && !lesson.locked
    && !lesson.premium
    && ['youtube', 'private-video', 'video'].includes(String(lesson.type || '')),
  );

const buildUnlockMap = (course: CourseCard | null, progressMap: Map<string, StoredProgress>, hasCourseAccessOverride = false) => {
  const sections = buildCourseSections(course);
  const lessons = sections.flatMap((section) => section.lessons);
  const accessMap = new Map<string, { unlocked: boolean; reason: string | null }>();
  const hasCourseAccess = Boolean(
    hasCourseAccessOverride
    || hasActiveCourseAccess(course),
  );

  lessons.forEach((entry) => {
    if (entry.lesson.locked) {
      accessMap.set(entry.lesson.id, {
        unlocked: false,
        reason: 'This lesson is locked in the current course setup.',
      });
      return;
    }

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
        reason: 'Unlock the course to watch lessons and sync progress.',
      });
      return;
    }

    accessMap.set(entry.lesson.id, {
      unlocked: true,
      reason: null,
    });
  });

  return accessMap;
};

const hasLessonVideoMilestone = (progress?: StoredProgress | null) =>
  Boolean(
    progress
    && (
      progress.lessonStage === 'exam'
      || progress.lessonStage === 'explanation'
      || progress.completed
      || Number(progress.progressPercent || 0) >= VIDEO_STAGE_PROGRESS
    ),
  );

const hasLessonCbtContent = (lesson?: CourseLesson | null) => {
  const cbt = lesson?.cbt as (CourseLesson['cbt'] & {
    published?: boolean | null;
    enabled?: boolean | null;
    deleted?: boolean | null;
    lessonId?: string | null;
    courseId?: string | null;
  }) | null | undefined;
  if (!cbt || !Array.isArray(cbt.questions) || cbt.questions.length === 0) {
    return false;
  }

  if (cbt.deleted === true || cbt.enabled === false || cbt.published === false) {
    return false;
  }

  return true;
};

const getVideoWatchCount = (progress?: StoredProgress | null) => {
  if (!progress) {
    return 0;
  }

  if (typeof progress.videoWatchCount === 'number') {
    return progress.videoWatchCount;
  }

  return 0;
};

const getExplanationWatchCount = (progress?: StoredProgress | null) => {
  if (!progress) {
    return 0;
  }

  if (typeof progress.explanationWatchCount === 'number') {
    return progress.explanationWatchCount;
  }

  return progress.completed ? 1 : 0;
};

const getPlayedSeconds = (video: HTMLVideoElement) => {
  const ranges = video.played;
  if (!ranges || ranges.length === 0) {
    return 0;
  }

  let totalSeconds = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    totalSeconds += Math.max(Number(ranges.end(index) || 0) - Number(ranges.start(index) || 0), 0);
  }

  return totalSeconds;
};

const buildLessonCopy = (entry: CourseLessonEntry | null, course: CourseCard | null): LessonCopy => {
  const lesson = entry?.lesson;
  const lessonTitle = String(lesson?.title || 'Untitled lesson').trim();
  const courseTitle = String(course?.title || 'This course').trim();
  const courseSubject = String(course?.subject || course?.exam || 'the course').trim();
  const lessonSection = [entry?.moduleTitle, entry?.chapterTitle].filter(Boolean).join(' / ') || 'Course lesson';
  const lessonTypeLabel = String(lesson?.type || 'lesson')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const attachedCbt = lesson?.cbt;
  const attachedQuestion = attachedCbt?.questions?.[0];
  const attachedQuiz = attachedQuestion ? {
    title: attachedCbt?.title || `${lessonTitle} CBT`,
    prompt: attachedQuestion.questionText,
    options: attachedQuestion.options || [],
    answerIndex: Number(attachedQuestion.correctOption || 0),
    explanation: attachedQuestion.explanation || 'Explanation will appear after the CBT author adds it.',
    totalQuestions: attachedCbt?.questions?.length || 1,
    durationMinutes: attachedCbt?.durationMinutes || lesson?.durationMinutes || 30,
  } : null;

  return {
    heading: lessonTitle,
    summary: course?.description?.trim() || `${lessonTitle} is part of ${courseTitle}. Study the lesson, complete the linked practice, and track progress here.`,
    about: `${lessonTitle} belongs to ${lessonSection} in ${courseTitle}. This lesson view keeps the video, progress, notes, doubts, and lesson-linked assessment together so the learning flow stays consistent.`,
    takeaways: [
      `Focus on the main concept of ${lessonTitle} before moving to the next topic in ${courseSubject}.`,
      attachedCbt?.questions?.length
        ? 'Complete the linked CBT after the lesson video so the explanation step and progress unlock correctly.'
        : 'Use notes and doubts to capture the important parts of this lesson before continuing.',
      'Keep progress accurate here so sequential unlocks, continue learning, and revision all stay aligned.',
    ],
    notes: [
      {
        title: 'Lesson Context',
        body: `${lessonTitle} is part of ${lessonSection} in ${courseTitle}.`,
      },
      {
        title: 'Lesson Format',
        body: `${lessonTypeLabel} lesson • ${formatDurationLabel(lesson?.durationMinutes || 0)}${lesson?.requiresSecurePlayback ? ' • protected playback enabled' : ''}.`,
      },
      {
        title: 'Next Step',
        body: attachedCbt?.questions?.length
          ? 'Finish the lesson-linked CBT, then review the explanation before moving to the next lesson.'
          : 'Review this topic, save key notes, and continue to the next unlocked lesson.',
      },
    ],
    quiz: {
      title: attachedQuiz?.title || `${lessonTitle} CBT`,
      prompt: attachedQuiz?.prompt || `Use the linked CBT for ${lessonTitle} to continue this lesson flow.`,
      options: attachedQuiz?.options || [
        'Start the lesson CBT from this screen',
        'Skip the CBT and unlock the explanation immediately',
        'Jump to the next lesson without finishing this one',
        'Reset all course progress',
      ],
      answerIndex: attachedQuiz?.answerIndex ?? 0,
      explanation: attachedQuiz?.explanation || 'Finish the linked CBT to unlock the explanation step and keep the lesson flow complete.',
      totalQuestions: attachedQuiz?.totalQuestions || 1,
      durationMinutes: attachedQuiz?.durationMinutes || lesson?.durationMinutes || 30,
    },
    discussionPrompt: `Ask about ${lessonTitle}, the CBT result, or any part of the explanation that still feels unclear.`,
    quickTip: `Capture one clean note from ${lessonTitle} before moving on so revision stays lightweight and useful.`,
  };
};

const buildCourseHeroArt = () => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 240" fill="none">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="960" y2="240" gradientUnits="userSpaceOnUse">
          <stop stop-color="#dbe9ff"/>
          <stop offset="0.55" stop-color="#bed7ff"/>
          <stop offset="1" stop-color="#eef5ff"/>
        </linearGradient>
      </defs>
      <rect width="960" height="240" fill="url(#bg)"/>
      <path d="M0 168C140 146 270 141 394 150C557 162 682 180 960 156V240H0V168Z" fill="#e8f1ff"/>
      <path d="M0 184C180 169 332 168 510 179C709 191 812 194 960 182V240H0V184Z" fill="#f4f8ff"/>
      <g stroke="#8ba7d4" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.82">
        <path d="M760 34l-20 140h40L760 34Z" fill="#8ba7d4" stroke="none"/>
        <path d="M760 34l-58 46h116L760 34Zm-58 46-30 24h176l-30-24m-116 0-22 18m116-18 22 18"/>
        <path d="M844 54l-15 120h30L844 54Z" fill="#8ba7d4" stroke="none"/>
        <path d="M844 54l-44 34h88L844 54Zm-44 34-22 18h132l-22-18"/>
        <path d="M640 148c64-38 132-46 240-39"/>
      </g>
      <circle cx="790" cy="72" r="112" fill="#ffffff" opacity="0.32"/>
      <circle cx="266" cy="66" r="42" fill="#ffffff" opacity="0.26"/>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

const HeaderTools = ({
  searchValue,
  onSearchChange,
  placeholder,
  testId,
}: {
  searchValue: string;
  onSearchChange: (value: string) => void;
  placeholder: string;
  testId?: string;
}) => (
  <div className="flex w-full">
    <label
      className="flex h-[42px] min-w-0 flex-1 items-center gap-[10px] rounded-[14px] border border-[#d8e0ef] bg-white px-[14px] text-[15px] text-[#7a8dab] shadow-[0_8px_22px_rgba(60,86,134,0.05)] sm:max-w-[280px]"
      data-testid={testId}
    >
      <Search className="h-[16px] w-[16px]" />
      <input
        value={searchValue}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[#263b63] outline-none placeholder:text-[#93a1ba]"
      />
    </label>
  </div>
);

const ProgressDonut = ({
  percent,
  title,
  size = 118,
  testId,
}: {
  percent: number;
  title: string;
  size?: number;
  testId?: string;
}) => {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const outerStyle = {
    width: size,
    height: size,
    background: `conic-gradient(#9bc5ff 0deg ${clamped * 3.6}deg, #dfe8f9 ${clamped * 3.6}deg 360deg)`,
  } as React.CSSProperties;
  const isCompact = size <= 80;
  const isMedium = size > 80 && size <= 100;
  const innerSize = Math.max(size - (isCompact ? 16 : 22), isCompact ? 48 : 56);

  return (
    <div className="flex items-center justify-center" data-testid={testId}>
      <div style={outerStyle} className="relative flex items-center justify-center rounded-full">
        <div
          style={{ width: innerSize, height: innerSize }}
          className="flex flex-col items-center justify-center rounded-full bg-white text-center"
        >
          <span className={cn(
            'leading-none text-[#1c2d4c]',
            isCompact ? 'text-[14px] font-semibold' : isMedium ? 'text-[22px] font-semibold' : 'text-[34px]',
          )}
          >
            {clamped}%
          </span>
          <span className={cn(
            'text-[#5d7092]',
            isCompact ? 'mt-[2px] text-[8px] font-medium' : isMedium ? 'mt-[3px] text-[11px]' : 'mt-[4px] text-[15px]',
          )}
          >
            {title}
          </span>
        </div>
      </div>
    </div>
  );
};

const ToggleSwitch = ({
  checked,
  onToggle,
  testId,
}: {
  checked: boolean;
  onToggle: () => void;
  testId?: string;
}) => (
  <button
    type="button"
    onClick={onToggle}
    data-testid={testId}
    aria-checked={checked}
    className={cn(
      'relative inline-flex h-[28px] w-[50px] shrink-0 items-center rounded-full border p-[2px] transition-all duration-200',
      checked
        ? 'border-[#2d6ee5] bg-[linear-gradient(180deg,#2f6ef0_0%,#3d80ff_100%)] shadow-[0_6px_14px_rgba(45,110,229,0.18)]'
        : 'border-[#d8e3f4] bg-[#edf3ff]',
    )}
  >
    <span
      className={cn(
        'block h-[22px] w-[22px] rounded-full bg-white shadow-[0_6px_12px_rgba(17,24,39,0.14)] transition-transform duration-200',
        checked ? 'translate-x-[22px]' : 'translate-x-0',
      )}
    />
  </button>
);

const CatalogCourseCard = ({
  course,
  tone,
  snapshot,
  onOpen,
}: {
  course: CourseCard;
  tone: CatalogTone;
  snapshot: {
    totalLessons: number;
    completedLessons: number;
    progressPercent: number;
  };
  onOpen: () => void;
}) => {
  const styles = toneStyles[tone];
  const actionLabel = getCoursePrimaryActionLabel(course, snapshot.progressPercent);
  const chipLabel = course.exam || course.category || 'Course';
  const pricing = getCoursePricingMeta(course);

  return (
    <button
      type="button"
      data-testid={`course-catalog-card-${slugify(course._id)}`}
      onClick={onOpen}
      className={cn(
        'group relative flex min-h-[320px] flex-col overflow-hidden rounded-[22px] border border-white/70 px-[18px] pb-[16px] pt-[14px] text-left shadow-[0_18px_40px_rgba(45,68,117,0.10)] transition hover:-translate-y-0.5',
        styles.surface,
      )}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_24%_14%,rgba(255,255,255,0.48),transparent_40%),linear-gradient(180deg,rgba(255,255,255,0)_24%,rgba(255,255,255,0.86)_100%)]" />
      <div className="relative flex h-full flex-col">
        <span className={cn('inline-flex w-fit rounded-[7px] px-[12px] py-[4px] text-[11px] font-semibold tracking-[0.02em]', styles.chip)}>
          {chipLabel}
        </span>

        <div className="mt-[16px] min-h-[64px]">
          <p className="text-[20px] font-semibold leading-[1.1] tracking-[-0.02em] text-[#142140]">{course.title}</p>
          <p className="mt-[6px] line-clamp-2 text-[15px] leading-[1.18] text-[#32466c]">{course.subject}</p>
        </div>

        {!hasActiveCourseAccess(course) && shouldShowCoursePaymentButton(course) && (
          <div className="mt-[4px] rounded-[16px] border border-[#ffd9b6] bg-[linear-gradient(135deg,rgba(255,247,237,0.96)_0%,rgba(255,255,255,0.98)_100%)] px-[14px] py-[12px] shadow-[0_12px_26px_rgba(201,106,43,0.10)]">
            <div className="flex items-start justify-between gap-[10px]">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#c96a2b]">Offer price</p>
                <p className="mt-[4px] text-[24px] font-bold leading-none text-[#17233d]">{currency.format(pricing.finalPrice)}</p>
              </div>
              {pricing.offerPercentage > 0 && (
                <span className="rounded-full bg-[#ffedd5] px-[10px] py-[6px] text-[11px] font-bold text-[#c96a2b]">
                  {pricing.offerPercentage}% OFF
                </span>
              )}
            </div>
            <div className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[11px]">
              <span className="font-semibold text-[#7a8aa7] line-through decoration-[#c96a2b]/55">
                {currency.format(pricing.basePrice)}
              </span>
              {pricing.savings > 0 && (
                <span className="rounded-full bg-[#fff3e6] px-[8px] py-[3px] font-semibold text-[#c96a2b]">
                  Save {currency.format(pricing.savings)}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="mt-[12px] flex items-end justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-none text-[#2d3d62]">{snapshot.progressPercent}% Completed</p>
            <div className="mt-[11px] h-[8px] w-full max-w-[162px] overflow-hidden rounded-full bg-[#d8e4f7]">
              <div className={cn('h-full rounded-full', styles.progress)} style={{ width: `${snapshot.progressPercent}%` }} />
            </div>
          </div>
          <span className={cn('inline-flex h-[40px] shrink-0 items-center rounded-[10px] px-[18px] text-[15px] font-semibold text-white', styles.button)}>
            {actionLabel}
          </span>
        </div>

        <div className="mt-[16px] border-t border-[#dde6f4]" />

        <div className="mt-[12px] grid grid-cols-3 gap-[8px] text-[#31456a]">
          <div>
            <p className="text-[13px] leading-[1.1]">{snapshot.totalLessons} Lessons</p>
            <p className="mt-[6px] text-[11px] text-[#8193b0]">Course flow</p>
          </div>
          <div>
            <p className="text-[13px] leading-[1.1]">{snapshot.completedLessons} Done</p>
            <p className="mt-[6px] text-[11px] text-[#8193b0]">Completed lessons</p>
          </div>
          <div>
            <p className="text-[13px] leading-[1.1]">{snapshot.progressPercent}%</p>
            <p className="mt-[6px] text-[11px] text-[#8193b0]">Progress</p>
          </div>
        </div>
      </div>
    </button>
  );
};

const LessonRow = ({
  entry,
  active,
  completed,
  unlocked,
  onOpen,
  showButton,
  testId,
}: {
  entry: CourseLessonEntry;
  active: boolean;
  completed: boolean;
  unlocked: boolean;
  onOpen: () => void;
  showButton?: boolean;
  testId?: string;
}) => (
  <button
    type="button"
    data-testid={testId}
    onClick={unlocked ? onOpen : undefined}
    className={cn(
      'flex w-full items-center gap-4 border-b border-[#e3eaf7] px-[18px] py-[14px] text-left last:border-b-0',
      active ? 'bg-[linear-gradient(90deg,rgba(64,125,233,0.10)_0%,rgba(255,255,255,0.98)_100%)]' : 'bg-white',
      unlocked ? 'cursor-pointer' : 'cursor-not-allowed',
    )}
  >
    <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-[#d1ddf4] bg-[#edf3fe] text-[#7092c8]">
      {unlocked ? <Play className="ml-[1px] h-[15px] w-[15px] fill-current" /> : <Lock className="h-[14px] w-[14px]" />}
    </div>
    <div className="min-w-0 flex-1">
      <p className={cn('text-[15px] leading-[1.18] text-[#223356]', active && 'font-semibold text-[#1b49d6]')}>{entry.lesson.title}</p>
      <p className="mt-[4px] text-[13px] text-[#6e80a1]">{formatDurationLabel(entry.lesson.durationMinutes)}</p>
    </div>
    {completed ? (
      <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-[#22b573]" />
    ) : showButton && unlocked ? (
      <span className="inline-flex h-[34px] shrink-0 items-center rounded-[10px] bg-[linear-gradient(180deg,#4688f4_0%,#2d6ee5_100%)] px-[16px] text-[14px] font-semibold text-white shadow-[0_10px_24px_rgba(45,110,229,0.18)]">
        Open
      </span>
    ) : !unlocked ? (
      <Lock className="h-[16px] w-[16px] shrink-0 text-[#8fa2c3]" />
    ) : null}
  </button>
);

export const CourseFigmaTab = ({
  overview,
  onRefresh,
  initialCourseId,
  initialLessonId,
  initialDoubtThreadId,
  initialReportId,
  initialSupportPanel,
  onResumeNavigationHandled,
  savedTopicIds,
  onToggleSavedTopic,
  onImmersiveModeChange,
  onOpenCbtExam,
}: CourseFigmaTabProps) => {
  const { user } = useAuth();
  const defaultCourseId = overview.courses[0]?._id || null;
  const initialResolvedCourseId = initialCourseId || findCourseIdForLesson(overview.courses, initialLessonId) || defaultCourseId;
  const [screen, setScreen] = useState<Screen>(initialLessonId ? 'lesson' : initialCourseId ? 'course' : 'catalog');
  const [activeCourseTab, setActiveCourseTab] = useState<CourseTab>('Lessons');
  const [activeLessonTab, setActiveLessonTab] = useState<LessonTab>('Video');
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(initialResolvedCourseId);
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(initialLessonId || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unlocked' | 'progress' | 'completed' | 'not-started'>('all');
  const [sortBy, setSortBy] = useState<'latest' | 'progress' | 'title'>('latest');
  const [mobileCatalogLayout, setMobileCatalogLayout] = useState<'list' | 'grid'>('list');
  const [mobileCourseTab, setMobileCourseTab] = useState<'Content' | 'Syllabus' | 'Resources'>('Content');
  const [expandedSectionsByCourse, setExpandedSectionsByCourse] = useState<Record<string, string[]>>({});
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null);
  const [videoPlaybackSeconds, setVideoPlaybackSeconds] = useState(0);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [explanationPlaybackSeconds, setExplanationPlaybackSeconds] = useState(0);
  const [isExplanationPlaying, setIsExplanationPlaying] = useState(false);
  const [isVideoReplayMode, setIsVideoReplayMode] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [completedVideoPlaybackKey, setCompletedVideoPlaybackKey] = useState<string | null>(null);
  const [isWatermarkVisible, setIsWatermarkVisible] = useState(false);
  const [watermarkPosition, setWatermarkPosition] = useState<WatermarkPosition>(() => createRandomWatermarkPosition());
  const [watermarkTimestamp, setWatermarkTimestamp] = useState(() => new Date().toLocaleString('en-IN'));
  const [mobileLessonStageOverride, setMobileLessonStageOverride] = useState<MobileLessonStage | null>(null);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [quizSelections, setQuizSelections] = useState<Record<string, number | null>>({});
  const [quizSubmitted, setQuizSubmitted] = useState<Record<string, boolean>>({});
  const [lessonDoubtDrafts, setLessonDoubtDrafts] = useState<Record<string, string>>({});
  const [lessonDoubtThreads, setLessonDoubtThreads] = useState<LessonDoubtThread[]>([]);
  const [lessonDoubtViewerRole, setLessonDoubtViewerRole] = useState<'student' | 'admin'>(() =>
    user?.role === 'admin' ? 'admin' : 'student');
  const [selectedLessonDoubtThreadId, setSelectedLessonDoubtThreadId] = useState<string | null>(null);
  const [loadingLessonDoubts, setLoadingLessonDoubts] = useState(false);
  const [sendingLessonDoubt, setSendingLessonDoubt] = useState(false);
  const [lessonDoubtError, setLessonDoubtError] = useState<string | null>(null);
  const [lessonDoubtSuccess, setLessonDoubtSuccess] = useState<string | null>(null);
  const [lessonRatings, setLessonRatings] = useState<Record<string, number>>({});
  const [lessonReportDrafts, setLessonReportDrafts] = useState<Record<string, string>>({});
  const [lessonReportIssueTypes, setLessonReportIssueTypes] = useState<Record<string, LessonReportIssueType>>({});
  const [lessonReportsByLesson, setLessonReportsByLesson] = useState<Record<string, LessonReportRecord[]>>({});
  const [loadingLessonReports, setLoadingLessonReports] = useState(false);
  const [sendingLessonReport, setSendingLessonReport] = useState(false);
  const [lessonReportError, setLessonReportError] = useState<string | null>(null);
  const [lessonReportSuccess, setLessonReportSuccess] = useState<string | null>(null);
  const [busyCourseId, setBusyCourseId] = useState<string | null>(null);
  const [courseAccessMessage, setCourseAccessMessage] = useState<string | null>(null);
  const [expandedSupportPanel, setExpandedSupportPanel] = useState<LessonSupportPanel>(null);
  const [mobileSupportTab, setMobileSupportTab] = useState<MobileSupportTab>('notes');
  const [mobileWatchPanel, setMobileWatchPanel] = useState<MobileWatchPanel>(null);
  const [protectedLessonPlayback, setProtectedLessonPlayback] = useState<ProtectedLessonPlayback | null>(null);
  const [loadingProtectedLesson, setLoadingProtectedLesson] = useState(false);
  const [protectedLessonError, setProtectedLessonError] = useState<string | null>(null);
  const [useProtectedSourceFallback, setUseProtectedSourceFallback] = useState(false);
  const [privateVideoQualityOptions, setPrivateVideoQualityOptions] = useState<RecordedVideoQualityOption[]>([]);
  const [selectedPrivateVideoQuality, setSelectedPrivateVideoQuality] = useState<number>(480);
  const [localProgressByCourse, setLocalProgressByCourse] = useState<Record<string, Record<string, StoredProgress>>>(() =>
    overview.courses.reduce<Record<string, Record<string, StoredProgress>>>((accumulator, course) => {
      accumulator[course._id] = readStoredProgress(course._id);
      return accumulator;
    }, {}),
  );
  const playerViewportRef = useRef<HTMLDivElement | null>(null);
  const autoplayHandledRef = useRef<string | null>(null);
  const handledResumeNavigationRef = useRef<string | null>(null);
  const pendingLessonDoubtThreadIdRef = useRef<string | null>(initialDoubtThreadId || null);
  const pendingLessonReportIdRef = useRef<string | null>(initialReportId || null);
  const lessonVideoRef = useRef<HTMLVideoElement | null>(null);
  const protectedLessonVideoRef = useRef<ResilientHlsVideoHandle | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const updateLayout = () => {
      setIsMobileLayout(window.matchMedia('(max-width: 1023px)').matches);
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);

    return () => {
      window.removeEventListener('resize', updateLayout);
    };
  }, []);

  useEffect(() => {
    const nextImmersive = isMobileLayout && screen === 'lesson';
    onImmersiveModeChange?.(nextImmersive);
    return () => onImmersiveModeChange?.(false);
  }, [isMobileLayout, onImmersiveModeChange, screen]);

  useEffect(() => {
    setLocalProgressByCourse((current) => {
      const nextState = { ...current };
      let mutated = false;

      overview.courses.forEach((course) => {
        if (!nextState[course._id]) {
          nextState[course._id] = readStoredProgress(course._id);
          mutated = true;
        }
      });

      return mutated ? nextState : current;
    });
  }, [overview.courses]);

  useEffect(() => {
    if (selectedCourseId && overview.courses.some((course) => course._id === selectedCourseId)) {
      return;
    }
    setSelectedCourseId(defaultCourseId);
  }, [defaultCourseId, overview.courses, selectedCourseId]);

  useEffect(() => {
    const resumeKey = `${initialCourseId || ''}::${initialLessonId || ''}::${initialDoubtThreadId || ''}::${initialReportId || ''}::${initialSupportPanel || ''}`;
    if ((!initialCourseId && !initialLessonId && !initialDoubtThreadId && !initialReportId && !initialSupportPanel) || handledResumeNavigationRef.current === resumeKey) {
      return;
    }

    const targetCourseId = initialCourseId || findCourseIdForLesson(overview.courses, initialLessonId) || defaultCourseId;
    if (targetCourseId) {
      setSelectedCourseId(targetCourseId);
      setScreen(initialLessonId ? 'lesson' : 'course');
      setSearchQuery('');
      setActiveCourseTab('Lessons');
      setActiveLessonTab('Video');
    }

    if (initialLessonId) {
      setSelectedLessonId(initialLessonId);
    }
    if (initialDoubtThreadId) {
      pendingLessonDoubtThreadIdRef.current = initialDoubtThreadId;
      setExpandedSupportPanel('doubts');
      setMobileSupportTab('doubts');
    }
    if (initialReportId) {
      pendingLessonReportIdRef.current = initialReportId;
      setExpandedSupportPanel('report');
      setMobileWatchPanel('report');
    } else if (initialSupportPanel === 'report') {
      setExpandedSupportPanel('report');
      setMobileWatchPanel('report');
    } else if (initialSupportPanel === 'doubts') {
      setExpandedSupportPanel('doubts');
      setMobileSupportTab('doubts');
    }

    handledResumeNavigationRef.current = resumeKey;
    onResumeNavigationHandled?.();
  }, [defaultCourseId, initialCourseId, initialDoubtThreadId, initialLessonId, initialReportId, initialSupportPanel, onResumeNavigationHandled, overview.courses]);

  const selectedCourse = useMemo(
    () => overview.courses.find((course) => course._id === selectedCourseId) || overview.courses[0] || null,
    [overview.courses, selectedCourseId],
  );

  const selectedCourseSections = useMemo(
    () => buildCourseSections(selectedCourse),
    [selectedCourse],
  );

  useEffect(() => {
    if (!selectedCourse?._id || selectedCourseSections.length === 0) {
      return;
    }

    setExpandedSectionsByCourse((current) => {
      if (current[selectedCourse._id]?.length) {
        return current;
      }

      return {
        ...current,
        [selectedCourse._id]: [selectedCourseSections[0].id],
      };
    });
  }, [selectedCourse?._id, selectedCourseSections]);

  const localProgress = selectedCourse ? localProgressByCourse[selectedCourse._id] || {} : {};
  const selectedCourseEntries = selectedCourseSections.flatMap((section) => section.lessons);

  useEffect(() => {
    if (!selectedCourse) {
      setSelectedLessonId(null);
      return;
    }

    if (selectedLessonId && selectedCourseEntries.some((entry) => entry.lesson.id === selectedLessonId)) {
      return;
    }

    const continueEntry = selectedCourseEntries.find((entry) => entry.lesson.id === selectedCourse.continueLesson?.id)
      || selectedCourseEntries[0]
      || null;
    setSelectedLessonId(continueEntry?.lesson.id || null);
  }, [selectedCourse, selectedCourseEntries, selectedLessonId]);

  const selectedLessonEntry = useMemo(
    () => selectedCourseEntries.find((entry) => entry.lesson.id === selectedLessonId) || selectedCourseEntries[0] || null,
    [selectedCourseEntries, selectedLessonId],
  );

  const selectedLessonHasCbt = hasLessonCbtContent(selectedLessonEntry?.lesson);
  const selectedLessonHasExplanation = selectedLessonHasCbt;
  const selectedLessonVideoDurationSeconds = Math.max((selectedLessonEntry?.lesson.durationMinutes || 1) * 60, 60);
  const selectedLessonExplanationDurationSeconds = EXPLANATION_DURATION_SECONDS;
  const getCurrentLessonDurationSeconds = useCallback(() => {
    const protectedDuration = protectedLessonVideoRef.current?.getDuration() || 0;
    const nativeDuration = Number(lessonVideoRef.current?.duration || 0);
    return Math.max(protectedDuration, nativeDuration, selectedLessonVideoDurationSeconds, 1);
  }, [selectedLessonVideoDurationSeconds]);
  const seekCurrentLessonVideo = useCallback((seconds: number) => {
    const nextTime = Math.max(Number(seconds || 0), 0);
    if (protectedLessonVideoRef.current) {
      protectedLessonVideoRef.current.seekTo(nextTime);
      setVideoPlaybackSeconds(nextTime);
      return;
    }

    if (lessonVideoRef.current) {
      const duration = Math.max(Number(lessonVideoRef.current.duration || 0), 0);
      lessonVideoRef.current.currentTime = duration > 0 ? Math.min(nextTime, duration) : nextTime;
      setVideoPlaybackSeconds(lessonVideoRef.current.currentTime || nextTime);
    }
  }, []);
  const selectedLessonStoredProgress = selectedLessonEntry ? localProgress[selectedLessonEntry.lesson.id] || null : null;
  const selectedLessonExamSelectedOption = selectedLessonEntry
    ? quizSelections[selectedLessonEntry.lesson.id] ?? selectedLessonStoredProgress?.examSelectedOption ?? null
    : null;
  const selectedLessonExamSubmitted = selectedLessonEntry
    ? selectedLessonHasCbt && Boolean(quizSubmitted[selectedLessonEntry.lesson.id] ?? selectedLessonStoredProgress?.examSubmitted)
    : false;
  const selectedLessonVideoWatchLimit = Math.max(
    Number(
      protectedLessonPlayback?.watchLimit
      ?? selectedLessonEntry?.lesson.watchLimit
      ?? MAX_VIDEO_WATCHES,
    ),
    1,
  );
  const selectedLessonWatchCompletionPercent = Math.min(
    Math.max(
      Number(
        protectedLessonPlayback?.watchCompletionPercent
        ?? selectedLessonEntry?.lesson.watchCompletionPercent
        ?? (VIDEO_COMPLETION_MIN_WATCH_RATIO * 100),
      ),
      50,
    ),
    100,
  );
  const selectedLessonCompletionRatio = selectedLessonWatchCompletionPercent / 100;
  const selectedLessonVideoWatchCount = getVideoWatchCount(selectedLessonStoredProgress);
  const selectedLessonExplanationWatchCount = getExplanationWatchCount(selectedLessonStoredProgress);
  const hasCompletedLessonVideo = selectedLessonVideoWatchCount > 0 || hasLessonVideoMilestone(selectedLessonStoredProgress);
  const canRewatchLessonVideo = selectedLessonVideoWatchCount > 0 && selectedLessonVideoWatchCount < selectedLessonVideoWatchLimit;
  const hasReachedLessonVideoWatchLimit = selectedLessonVideoWatchCount >= selectedLessonVideoWatchLimit;
  const hasReachedExplanationWatchLimit = selectedLessonExplanationWatchCount >= MAX_EXPLANATION_WATCHES;
  const canWatchExplanation = selectedLessonHasExplanation && selectedLessonExamSubmitted && !hasReachedExplanationWatchLimit;
  const selectedLessonStage: LessonStage = selectedLessonStoredProgress?.lessonStage
    || (selectedLessonStoredProgress?.completed ? 'explanation' : selectedLessonExamSubmitted ? 'exam' : 'video');
  const lessonProgressTab: LessonTab = activeLessonTab;
  const transientProgress = selectedLessonEntry
    ? (() => {
      let progressPercent = selectedLessonStoredProgress?.progressPercent || 0;
      let progressSeconds = selectedLessonStoredProgress?.progressSeconds || 0;
      let completed = Boolean(selectedLessonStoredProgress?.completed);
      let lessonStage: LessonStage = selectedLessonStage;

      if (lessonProgressTab === 'Video') {
        progressPercent = Math.min(VIDEO_STAGE_PROGRESS, Math.round((videoPlaybackSeconds / selectedLessonVideoDurationSeconds) * VIDEO_STAGE_PROGRESS));
        progressSeconds = Math.min(videoPlaybackSeconds, selectedLessonVideoDurationSeconds);
        completed = false;
        lessonStage = 'video';
      } else if (lessonProgressTab === 'CBT Exam') {
        progressPercent = selectedLessonExamSubmitted ? EXAM_STAGE_PROGRESS : VIDEO_STAGE_PROGRESS;
        progressSeconds = selectedLessonVideoDurationSeconds;
        completed = false;
        lessonStage = selectedLessonExamSubmitted ? 'explanation' : 'exam';
      } else if (lessonProgressTab === 'Explanation') {
        const explanationProgress = Math.min(
          33,
          Math.round((explanationPlaybackSeconds / selectedLessonExplanationDurationSeconds) * 33),
        );
        progressPercent = selectedLessonExamSubmitted ? EXAM_STAGE_PROGRESS + explanationProgress : VIDEO_STAGE_PROGRESS;
        progressSeconds = explanationPlaybackSeconds;
        completed = selectedLessonExamSubmitted && explanationPlaybackSeconds >= selectedLessonExplanationDurationSeconds;
        lessonStage = completed ? 'explanation' : 'explanation';
        if (completed) {
          progressPercent = 100;
        }
      }

      return {
        lessonId: selectedLessonEntry.lesson.id,
        progressPercent,
        progressSeconds,
        completed,
        lessonStage,
        examSubmitted: selectedLessonExamSubmitted,
        examSelectedOption: selectedLessonExamSelectedOption,
        explanationSeconds: lessonProgressTab === 'Explanation' ? explanationPlaybackSeconds : 0,
        videoWatchCount: selectedLessonVideoWatchCount,
        explanationWatchCount: selectedLessonExplanationWatchCount,
        updatedAt: new Date().toISOString(),
      };
    })()
    : null;

  const selectedCourseProgressMap = useMemo(
    () => buildProgressMap(selectedCourse, localProgress, screen === 'lesson' ? transientProgress : null),
    [localProgress, screen, selectedCourse, transientProgress],
  );
  const selectedCourseHasAccess = Boolean(
    user?.role === 'admin'
    || hasActiveCourseAccess(selectedCourse),
  );
  const selectedLesson = selectedLessonEntry?.lesson || null;
  const selectedLessonHasSecurePlayback = Boolean(
    selectedLesson
    && (selectedLesson.requiresSecurePlayback || ['youtube', 'private-video'].includes(String(selectedLesson.type || ''))),
  );
  const selectedLessonDirectVideoUrl = selectedLesson?.type === 'video' ? selectedLesson.videoUrl || null : null;
  const currentPlaybackWatermarkText = [
    user?.name,
    user?.email,
    user?.mobileNumber,
    user?._id,
    watermarkTimestamp,
  ].filter(Boolean).join(' • ');

  useEffect(() => {
    if (!currentPlaybackWatermarkText) {
      setIsWatermarkVisible(false);
      return undefined;
    }

    const timeoutIds: number[] = [];
    const showWatermark = () => {
      setWatermarkPosition(createRandomWatermarkPosition());
      setWatermarkTimestamp(new Date().toLocaleString('en-IN'));
      setIsWatermarkVisible(true);
      const hideId = window.setTimeout(() => {
        setIsWatermarkVisible(false);
      }, WATERMARK_VISIBLE_DURATION_MS);
      timeoutIds.push(hideId);
    };

    showWatermark();
    const intervalId = window.setInterval(() => {
      showWatermark();
    }, WATERMARK_HIDDEN_INTERVAL_MS + WATERMARK_VISIBLE_DURATION_MS);

    return () => {
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      window.clearInterval(intervalId);
    };
  }, [selectedLesson?.id, user?._id]);

  const unlockMap = useMemo(
    () => buildUnlockMap(selectedCourse, selectedCourseProgressMap, selectedCourseHasAccess),
    [selectedCourse, selectedCourseHasAccess, selectedCourseProgressMap],
  );
  const selectedLessonUnlocked = Boolean(
    selectedLesson
    && unlockMap.get(selectedLesson.id)?.unlocked,
  );

  const selectedCourseSnapshot = useMemo(
    () => selectedCourse
      ? buildCourseSnapshot(selectedCourse, localProgress, screen === 'lesson' ? transientProgress : null)
      : { totalLessons: 0, completedLessons: 0, progressPercent: 0 },
    [localProgress, screen, selectedCourse, transientProgress],
  );

  const selectedCourseExamAttempts = useMemo(
    () => selectedCourseEntries.filter((entry) => Boolean(selectedCourseProgressMap.get(entry.lesson.id)?.examSubmitted)).length,
    [selectedCourseEntries, selectedCourseProgressMap],
  );
  const selectedCourseCbtEligibleCount = useMemo(
    () => selectedCourseEntries.filter((entry) => hasLessonCbtContent(entry.lesson)).length,
    [selectedCourseEntries],
  );
  const selectedCourseVideoCompletedCount = useMemo(
    () => selectedCourseEntries.filter((entry) => hasLessonVideoMilestone(selectedCourseProgressMap.get(entry.lesson.id))).length,
    [selectedCourseEntries, selectedCourseProgressMap],
  );
  const selectedCourseVideoCompletedDisplayCount = useMemo(() => {
    if (!selectedLessonEntry) {
      return selectedCourseVideoCompletedCount;
    }

    const otherLessonsCompleted = selectedCourseEntries.filter((entry) =>
      entry.lesson.id !== selectedLessonEntry.lesson.id
      && hasLessonVideoMilestone(selectedCourseProgressMap.get(entry.lesson.id))).length;

    const currentLessonProgress = transientProgress ?? selectedLessonStoredProgress;
    return otherLessonsCompleted + (hasLessonVideoMilestone(currentLessonProgress) ? 1 : 0);
  }, [
    selectedCourseEntries,
    selectedCourseProgressMap,
    selectedCourseVideoCompletedCount,
    selectedLessonEntry,
    selectedLessonStoredProgress,
    transientProgress,
  ]);
  const currentExpandedSections = selectedCourse?._id ? expandedSectionsByCourse[selectedCourse._id] || [] : [];
  const selectedLessonCopy = useMemo(
    () => buildLessonCopy(selectedLessonEntry, selectedCourse),
    [selectedLessonEntry, selectedCourse],
  );
  const selectedCourseVisual = selectedCourse?.thumbnailUrl?.trim() || buildCourseHeroArt();
  const selectedLessonLabels = [
    selectedCourse?.exam || null,
    selectedCourse?.subject || null,
    selectedLessonEntry?.sectionLabel || null,
    selectedLesson ? String(selectedLesson.type).replace(/-/g, ' ') : null,
  ].filter(Boolean).slice(0, 4);

  const activeLessonDoubtThread = useMemo(() => {
    if (!lessonDoubtThreads.length) {
      return null;
    }

    if (selectedLessonDoubtThreadId) {
      return lessonDoubtThreads.find((thread) => thread._id === selectedLessonDoubtThreadId) || lessonDoubtThreads[0];
    }

    return lessonDoubtThreads[0] || null;
  }, [lessonDoubtThreads, selectedLessonDoubtThreadId]);

  const activeLessonDoubtDraftKey = selectedLessonEntry
    ? buildLessonDoubtDraftKey(
      selectedLessonEntry.lesson.id,
      activeLessonDoubtThread?._id || (lessonDoubtViewerRole === 'admin' ? 'admin' : 'student'),
    )
    : '';
  const activeLessonDoubtDraft = activeLessonDoubtDraftKey ? lessonDoubtDrafts[activeLessonDoubtDraftKey] || '' : '';
  const activeLessonReports = selectedLessonEntry ? (lessonReportsByLesson[selectedLessonEntry.lesson.id] || []) : [];

  const loadLessonDoubts = useCallback(async (options: { silent?: boolean } = {}) => {
    if (screen !== 'lesson' || !selectedCourse?._id || !selectedLessonEntry?.lesson.id) {
      setLessonDoubtThreads([]);
      setSelectedLessonDoubtThreadId(null);
      setLessonDoubtError(null);
      setLoadingLessonDoubts(false);
      return;
    }

    if (!options.silent) {
      setLoadingLessonDoubts(true);
    }

    try {
      const response = await EduService.listLessonDoubts(selectedCourse._id, selectedLessonEntry.lesson.id);
      setLessonDoubtViewerRole(response.viewerRole);
      setLessonDoubtThreads(response.threads || []);
      setLessonDoubtError(null);
      setSelectedLessonDoubtThreadId((current) => {
        const pendingThreadId = pendingLessonDoubtThreadIdRef.current;
        if (pendingThreadId && response.threads.some((thread) => thread._id === pendingThreadId)) {
          pendingLessonDoubtThreadIdRef.current = null;
          return pendingThreadId;
        }

        if (current && response.threads.some((thread) => thread._id === current)) {
          return current;
        }

        return response.threads[0]?._id || null;
      });
    } catch (error) {
      setLessonDoubtError(error instanceof Error ? error.message : 'Unable to load lesson discussion.');
    } finally {
      if (!options.silent) {
        setLoadingLessonDoubts(false);
      }
    }
  }, [screen, selectedCourse?._id, selectedLessonEntry?.lesson.id]);

  const loadLessonReports = useCallback(async (options: { silent?: boolean } = {}) => {
    if (screen !== 'lesson' || !selectedCourse?._id || !selectedLessonEntry?.lesson.id) {
      setLessonReportError(null);
      setLoadingLessonReports(false);
      return;
    }

    if (!options.silent) {
      setLoadingLessonReports(true);
    }

    try {
      const response = await EduService.listLessonReports(selectedCourse._id, selectedLessonEntry.lesson.id);
      setLessonReportsByLesson((current) => ({
        ...current,
        [selectedLessonEntry.lesson.id]: response.items || [],
      }));
      setLessonReportError(null);
    } catch (error) {
      setLessonReportError(error instanceof Error ? error.message : 'Unable to load lesson reports.');
    } finally {
      if (!options.silent) {
        setLoadingLessonReports(false);
      }
    }
  }, [screen, selectedCourse?._id, selectedLessonEntry?.lesson.id]);

  useEffect(() => {
    if (!selectedLessonEntry) {
      return;
    }

    const lessonId = selectedLessonEntry.lesson.id;
    const pendingThreadId = pendingLessonDoubtThreadIdRef.current;
    const draftKey = buildLessonDoubtDraftKey(
      lessonId,
      pendingThreadId || (lessonDoubtViewerRole === 'admin' ? 'admin' : 'student'),
    );

    setLessonDoubtDrafts((current) => (
      Object.prototype.hasOwnProperty.call(current, draftKey)
        ? current
        : { ...current, [draftKey]: '' }
    ));
  }, [lessonDoubtViewerRole, selectedLessonEntry]);

  useEffect(() => {
    if (pendingLessonDoubtThreadIdRef.current) {
      setMobileSupportTab('doubts');
      setExpandedSupportPanel('doubts');
      return;
    }
    if (pendingLessonReportIdRef.current || initialSupportPanel === 'report') {
      setExpandedSupportPanel('report');
      setMobileWatchPanel('report');
      return;
    }

    setMobileSupportTab('notes');
    setExpandedSupportPanel(null);
  }, [initialSupportPanel, selectedLessonEntry?.lesson.id]);

  useEffect(() => {
    void loadLessonDoubts();
  }, [loadLessonDoubts]);

  useEffect(() => {
    void loadLessonReports();
  }, [loadLessonReports]);

  useEffect(() => {
    if (screen !== 'lesson' || !selectedCourse?._id || !selectedLessonEntry?.lesson.id) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void loadLessonDoubts({ silent: true });
    }, LESSON_DOUBT_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [loadLessonDoubts, screen, selectedCourse?._id, selectedLessonEntry?.lesson.id]);

  const reloadProtectedLessonPlayback = useCallback((forceRefresh = true) => {
    if (!selectedCourse?._id || !selectedLesson?.id) {
      return () => undefined;
    }

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      console.warn('[video-playback] player bootstrap timed out', {
        courseId: selectedCourse._id,
        lessonId: selectedLesson.id,
        userId: user?._id || null,
      });
      setLoadingProtectedLesson(false);
      setProtectedLessonError('Video is taking longer than expected to prepare. Please retry.');
    }, 15_000);

    setLoadingProtectedLesson(true);
    setProtectedLessonError(null);
    if (forceRefresh) {
      setProtectedLessonPlayback((current) => (
        String(current?.videoId || '') === String(selectedLesson.id || '')
          ? current
          : null
      ));
    }

    void EduService.getProtectedLessonPlayback(selectedCourse._id, selectedLesson.id, { forceRefresh })
      .then((payload) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        console.info('[video-playback] player payload', {
          courseId: selectedCourse._id,
          lessonId: selectedLesson.id,
          userId: user?._id || null,
          videoId: payload.videoId || null,
          playerType: payload.playerType,
          streamFormat: payload.streamFormat || null,
          playbackStatus: payload.playbackStatus || null,
          streamUrl: payload.streamUrl || null,
          drmManifestUrl: payload.drmConfig?.manifestUrl || null,
        });
        setProtectedLessonPlayback(payload);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        console.warn('[video-playback] player bootstrap failed', {
          courseId: selectedCourse._id,
          lessonId: selectedLesson.id,
          userId: user?._id || null,
          message: error instanceof Error ? error.message : String(error),
        });
        setProtectedLessonError(error instanceof Error ? error.message : 'Unable to prepare lesson playback.');
      })
      .finally(() => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeoutId);
        }
        setLoadingProtectedLesson(false);
      });

    return () => {
      settled = true;
      window.clearTimeout(timeoutId);
    };
  }, [selectedCourse?._id, selectedLesson?.id, user?._id]);

  useEffect(() => {
    const shouldLoadProtectedLesson = Boolean(
      screen === 'lesson'
      && activeLessonTab === 'Video'
      && selectedCourse?._id
      && selectedLesson?.id
      && selectedLessonUnlocked
      && selectedLessonHasSecurePlayback,
    );

    if (!shouldLoadProtectedLesson) {
      setProtectedLessonPlayback(null);
      setProtectedLessonError(null);
      setLoadingProtectedLesson(false);
      return;
    }

    return reloadProtectedLessonPlayback(true);
  }, [activeLessonTab, reloadProtectedLessonPlayback, screen, selectedLessonHasSecurePlayback, selectedLessonUnlocked]);

  useEffect(() => {
    if (
      screen !== 'lesson'
      || activeLessonTab !== 'Video'
      || !selectedCourse?._id
      || !selectedLesson?.id
      || selectedLesson.type !== 'private-video'
      || !selectedLessonUnlocked
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
      reloadProtectedLessonPlayback(true);
    }, 4000);

    return () => window.clearTimeout(timer);
  }, [
    activeLessonTab,
    protectedLessonPlayback,
    reloadProtectedLessonPlayback,
    screen,
    selectedCourse?._id,
    selectedLesson?.id,
    selectedLesson?.type,
    selectedLessonUnlocked,
  ]);

  useEffect(() => {
    setUseProtectedSourceFallback(false);
  }, [selectedLesson?.id, protectedLessonPlayback?.streamUrl, protectedLessonPlayback?.fallbackStreamUrl]);

  const selectedLessonIndex = selectedCourseEntries.findIndex((entry) => entry.lesson.id === selectedLessonEntry?.lesson.id);
  const nextLessonEntry = selectedLessonIndex >= 0 && selectedLessonIndex < selectedCourseEntries.length - 1
    ? selectedCourseEntries[selectedLessonIndex + 1]
    : null;

  const filteredCourseSections = useMemo(() => {
    const query = normalize(searchQuery);

    if (!query) {
      return selectedCourseSections;
    }

    return selectedCourseSections
      .map((section) => ({
        ...section,
        lessons: section.lessons.filter((entry) => normalize(entry.lesson.title).includes(query)),
      }))
      .filter((section) => section.lessons.length > 0 || normalize(section.title).includes(query));
  }, [searchQuery, selectedCourseSections]);

  const categories = useMemo(
    () => ['all', ...Array.from(new Set(overview.courses.map((course) => course.exam || course.category).filter(Boolean)))],
    [overview.courses],
  );

  const courseSnapshots = useMemo(
    () => overview.courses.reduce<Record<string, { totalLessons: number; completedLessons: number; progressPercent: number }>>((accumulator, course) => {
      accumulator[course._id] = buildCourseSnapshot(
        course,
        localProgressByCourse[course._id] || {},
        course._id === selectedCourse?._id && screen === 'lesson' ? transientProgress : null,
      );
      return accumulator;
    }, {}),
    [localProgressByCourse, overview.courses, screen, selectedCourse?._id, transientProgress],
  );

  const filteredCourses = useMemo(() => {
    const query = normalize(searchQuery);

    return [...overview.courses]
      .filter((course) => {
        const snapshot = courseSnapshots[course._id] || { totalLessons: 0, completedLessons: 0, progressPercent: 0 };
        const matchesQuery = !query || [
          course.title,
          course.subject,
          course.category,
          course.exam,
          course.instructor,
        ].some((value) => normalize(value).includes(query));
        const matchesCategory = categoryFilter === 'all' || normalize(course.exam || course.category) === normalize(categoryFilter);
        const matchesStatus = statusFilter === 'all'
          || (statusFilter === 'unlocked' && hasActiveCourseAccess(course))
          || (statusFilter === 'progress' && snapshot.progressPercent > 0 && snapshot.progressPercent < 100)
          || (statusFilter === 'completed' && snapshot.progressPercent >= 100)
          || (statusFilter === 'not-started' && snapshot.progressPercent === 0);

        return matchesQuery && matchesCategory && matchesStatus;
      })
      .sort((left, right) => {
        const leftSnapshot = courseSnapshots[left._id] || { totalLessons: 0, completedLessons: 0, progressPercent: 0 };
        const rightSnapshot = courseSnapshots[right._id] || { totalLessons: 0, completedLessons: 0, progressPercent: 0 };

        if (sortBy === 'title') {
          return left.title.localeCompare(right.title);
        }

        if (sortBy === 'progress') {
          return rightSnapshot.progressPercent - leftSnapshot.progressPercent || left.title.localeCompare(right.title);
        }

        return Number(hasActiveCourseAccess(right)) - Number(hasActiveCourseAccess(left))
          || rightSnapshot.progressPercent - leftSnapshot.progressPercent
          || left.title.localeCompare(right.title);
      });
  }, [categoryFilter, courseSnapshots, overview.courses, searchQuery, sortBy, statusFilter]);

  const mobileCatalogCourses = useMemo(
    () => [...filteredCourses].sort((left, right) => {
      const priorityDelta = getMobileCoursePriority(left) - getMobileCoursePriority(right);
      return priorityDelta || left.title.localeCompare(right.title);
    }),
    [filteredCourses],
  );

  const recommendedTopics = useMemo(() => {
    const lessonTitles = selectedCourseSections.flatMap((section) => section.lessons.map((entry) => entry.lesson.title));
    return Array.from(
      new Set([
        ...lessonTitles,
        ...overview.dashboard.strongTopics,
        ...overview.dashboard.weakTopics,
      ]),
    ).slice(0, 4);
  }, [overview.dashboard.strongTopics, overview.dashboard.weakTopics, selectedCourseSections]);
  const selectedLessonSaved = Boolean(selectedCourse && selectedLessonEntry && savedTopicIds.includes(`${selectedCourse._id}:${selectedLessonEntry.lesson.id}`));

  const derivedMobileLessonStage: MobileLessonStage = useMemo(() => {
    if (!selectedLessonEntry) {
      return 'watch';
    }

    if (isVideoReplayMode) {
      return 'watch';
    }

    if (selectedLessonStoredProgress?.completed) {
      return 'completed';
    }

    if (selectedLessonExamSubmitted && selectedLessonStoredProgress?.lessonStage === 'explanation') {
      return explanationPlaybackSeconds > 0 ? 'explanation' : 'exam-complete';
    }

    if (selectedLessonStoredProgress?.lessonStage === 'exam') {
      return 'completed';
    }

    if (selectedLessonStoredProgress?.lessonStage === 'explanation') {
      return 'explanation';
    }

    return 'watch';
  }, [
    explanationPlaybackSeconds,
    hasReachedLessonVideoWatchLimit,
    isVideoReplayMode,
    selectedLessonEntry,
    selectedLessonExamSubmitted,
    selectedLessonStoredProgress?.completed,
    selectedLessonStoredProgress?.lessonStage,
  ]);

  const mobileLessonStage = mobileLessonStageOverride || derivedMobileLessonStage;
  const isLessonReadyForExam = selectedLessonHasCbt && hasCompletedLessonVideo;
  const isExplanationUnlocked = canWatchExplanation;
  const isLessonFlowComplete = Boolean(selectedLessonStoredProgress?.completed);

  useEffect(() => {
    setMobileLessonStageOverride(null);
    setIsVideoReplayMode(false);
    setCompletedVideoPlaybackKey(null);
  }, [selectedLessonEntry?.lesson.id, selectedCourse?._id]);

  useEffect(() => {
    setExpandedSupportPanel(null);
  }, [selectedLessonEntry?.lesson.id, selectedCourse?._id]);

  useEffect(() => {
    if (!selectedLessonHasCbt && activeLessonTab !== 'Video') {
      setActiveLessonTab('Video');
      setMobileLessonStageOverride(null);
      setIsExplanationPlaying(false);
    }
  }, [activeLessonTab, selectedLessonHasCbt]);

  useEffect(() => {
    setMobileCourseTab('Content');
  }, [selectedCourse?._id, screen]);

  useEffect(() => {
    if (!selectedLessonEntry) {
      setVideoPlaybackSeconds(0);
      setExplanationPlaybackSeconds(0);
      setIsVideoPlaying(false);
      setIsExplanationPlaying(false);
      setAutoplayCountdown(null);
      return;
    }

    const isCompletionState = Boolean(
      selectedLessonStoredProgress?.completed || selectedLessonStoredProgress?.lessonStage === 'explanation',
    );

    autoplayHandledRef.current = null;
    setIsVideoPlaying(false);
    setIsExplanationPlaying(false);
    if (!isCompletionState) {
      setAutoplayCountdown(null);
    }
    setPlaybackSpeed(1);
    setVideoPlaybackSeconds(
      selectedLessonStoredProgress?.lessonStage === 'video' || !selectedLessonStoredProgress?.lessonStage
        ? selectedLessonStoredProgress?.progressSeconds || 0
        : selectedLessonStoredProgress?.completed
          ? selectedLessonVideoDurationSeconds
          : 0,
    );
    setExplanationPlaybackSeconds(selectedLessonStoredProgress?.explanationSeconds || 0);

    if (isMobileLayout) {
      setActiveLessonTab('Video');
      return;
    }

    if (selectedLessonStoredProgress?.lessonStage === 'exam') {
      setActiveLessonTab('Video');
      return;
    }

    if (selectedLessonStoredProgress?.completed) {
      setActiveLessonTab('Video');
      return;
    }

    if (selectedLessonStoredProgress?.lessonStage === 'explanation') {
      setActiveLessonTab('CBT Exam');
      return;
    }

    setActiveLessonTab('Video');
  }, [isMobileLayout, selectedLessonEntry?.lesson.id, selectedLessonStoredProgress, selectedLessonVideoDurationSeconds]);

  useEffect(() => {
    if (screen !== 'lesson' || !selectedLessonEntry || autoplayCountdown !== null) {
      return;
    }

    const shouldTickExplanation = lessonProgressTab === 'Explanation' && isExplanationPlaying;

    if (!shouldTickExplanation) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const delta = Math.max(Math.round(PLAYER_TICK_STEP_SECONDS * playbackSpeed), 8);
      if (shouldTickExplanation) {
        setExplanationPlaybackSeconds((current) => Math.min(current + delta, selectedLessonExplanationDurationSeconds));
      }
    }, PLAYER_TICK_MS);

    return () => window.clearInterval(intervalId);
  }, [
    autoplayCountdown,
    explanationPlaybackSeconds,
    isExplanationPlaying,
    lessonProgressTab,
    playbackSpeed,
    screen,
    selectedLessonEntry,
    selectedLessonExplanationDurationSeconds,
  ]);

  const persistProgress = (courseId: string, lessonId: string, nextRecord: StoredProgressPatch) => {
    const targetCourse = overview.courses.find((course) => course._id === courseId);
    const targetEntry = buildCourseSections(targetCourse).flatMap((section) => section.lessons).find((item) => item.lesson.id === lessonId);

    if (!targetCourse || !targetEntry) {
      return;
    }

    const serverProgress = (targetCourse.lessonProgress || []).find((entry) => entry.lessonId === lessonId) as StoredProgress | undefined;
    const localProgress = localProgressByCourse[courseId]?.[lessonId];
    const baselineRecord = mergeStoredProgress(serverProgress || null, localProgress || null);
    const mergedRecord = mergeStoredProgress(baselineRecord, {
      lessonId,
      progressPercent: Number(nextRecord.progressPercent ?? baselineRecord?.progressPercent ?? 0),
      progressSeconds: Number(nextRecord.progressSeconds ?? baselineRecord?.progressSeconds ?? 0),
      completed: Boolean(nextRecord.completed ?? baselineRecord?.completed ?? false),
      lessonStage: nextRecord.lessonStage ?? baselineRecord?.lessonStage,
      examSubmitted: nextRecord.examSubmitted ?? baselineRecord?.examSubmitted ?? false,
      examSelectedOption: Object.prototype.hasOwnProperty.call(nextRecord, 'examSelectedOption')
        ? nextRecord.examSelectedOption ?? null
        : baselineRecord?.examSelectedOption ?? null,
      explanationSeconds: nextRecord.explanationSeconds ?? baselineRecord?.explanationSeconds ?? 0,
      videoWatchCount: nextRecord.videoWatchCount ?? baselineRecord?.videoWatchCount ?? 0,
      explanationWatchCount: nextRecord.explanationWatchCount ?? baselineRecord?.explanationWatchCount ?? 0,
      updatedAt: nextRecord.updatedAt || new Date().toISOString(),
    });

    if (!mergedRecord) {
      return;
    }

    setLocalProgressByCourse((current) => {
      const nextCourseProgress = {
        ...(current[courseId] || {}),
        [lessonId]: mergedRecord,
      };
      writeStoredProgress(courseId, nextCourseProgress);
      return {
        ...current,
        [courseId]: nextCourseProgress,
      };
    });

    if (!user?._id) {
      return;
    }

    void EduService.updateWatchProgress(
      courseId,
      lessonId,
      Math.max(Math.min(Number(mergedRecord.progressPercent || 0), 100), 0),
      Math.max(Number(mergedRecord.progressSeconds || 0), 0),
      Boolean(mergedRecord.completed),
      {
        lessonStage: mergedRecord.lessonStage ?? null,
        examSubmitted: mergedRecord.examSubmitted ?? null,
        examSelectedOption: mergedRecord.examSelectedOption ?? null,
        explanationSeconds: mergedRecord.explanationSeconds ?? 0,
        videoWatchCount: mergedRecord.videoWatchCount ?? 0,
        explanationWatchCount: mergedRecord.explanationWatchCount ?? 0,
      },
    ).catch((error) => {
      console.error('Failed to sync course figma progress:', error);
    });
  };

  const startLessonVideoReplay = () => {
    if (!selectedLessonEntry || !canRewatchLessonVideo) {
      return;
    }

    autoplayHandledRef.current = null;
    setAutoplayCountdown(null);
    setIsVideoReplayMode(true);
    setActiveLessonTab('Video');
    setMobileLessonStageOverride('watch');
    setVideoPlaybackSeconds(0);
    setIsVideoPlaying(false);
    setIsExplanationPlaying(false);
  };

  useEffect(() => {
    if (!selectedCourse || !selectedLessonEntry || screen !== 'lesson') {
      return;
    }

    const autoplayKey = `${selectedLessonEntry.lesson.id}::${lessonProgressTab}`;
    if (autoplayHandledRef.current === autoplayKey) {
      return;
    }

    if (lessonProgressTab === 'Video') {
      if (!completedVideoPlaybackKey || !completedVideoPlaybackKey.startsWith(`${selectedLessonEntry.lesson.id}::`)) {
        return;
      }

      if (!isVideoReplayMode && hasCompletedLessonVideo) {
        autoplayHandledRef.current = autoplayKey;
        setIsVideoPlaying(false);
        setCompletedVideoPlaybackKey(null);
        if (isMobileLayout) {
          setMobileLessonStageOverride('completed');
        } else {
          setActiveLessonTab('Video');
        }
        return;
      }

      const nextVideoWatchCount = Math.min(selectedLessonVideoWatchCount + 1, selectedLessonVideoWatchLimit);
      const preserveCompletion = Boolean(selectedLessonStoredProgress?.completed);
      const nextLessonStage: LessonStage = selectedLessonExamSubmitted || preserveCompletion ? 'explanation' : 'exam';
      const nextProgressPercent = preserveCompletion
        ? 100
        : selectedLessonExamSubmitted
          ? EXAM_STAGE_PROGRESS
          : VIDEO_STAGE_PROGRESS;

      autoplayHandledRef.current = autoplayKey;
      setIsVideoPlaying(false);
      setIsVideoReplayMode(false);
      setCompletedVideoPlaybackKey(null);
      persistProgress(selectedCourse._id, selectedLessonEntry.lesson.id, {
        lessonId: selectedLessonEntry.lesson.id,
        progressSeconds: preserveCompletion ? selectedLessonExplanationDurationSeconds : selectedLessonVideoDurationSeconds,
        progressPercent: nextProgressPercent,
        completed: preserveCompletion,
        lessonStage: nextLessonStage,
        examSubmitted: selectedLessonExamSubmitted,
        examSelectedOption: selectedLessonExamSelectedOption,
        explanationSeconds: selectedLessonStoredProgress?.explanationSeconds || 0,
        videoWatchCount: nextVideoWatchCount,
        explanationWatchCount: selectedLessonExplanationWatchCount,
        updatedAt: new Date().toISOString(),
      });

      if (isMobileLayout) {
        setMobileLessonStageOverride('completed');
      } else {
        setActiveLessonTab('Video');
      }
      return;
    }

    if (lessonProgressTab === 'Explanation' && explanationPlaybackSeconds >= selectedLessonExplanationDurationSeconds) {
      autoplayHandledRef.current = autoplayKey;
      setIsExplanationPlaying(false);
      persistProgress(selectedCourse._id, selectedLessonEntry.lesson.id, {
        lessonId: selectedLessonEntry.lesson.id,
        progressSeconds: selectedLessonExplanationDurationSeconds,
        progressPercent: 100,
        completed: true,
        lessonStage: 'explanation',
        examSubmitted: true,
        examSelectedOption: selectedLessonExamSelectedOption,
        explanationSeconds: selectedLessonExplanationDurationSeconds,
        videoWatchCount: selectedLessonVideoWatchCount,
        explanationWatchCount: MAX_EXPLANATION_WATCHES,
        updatedAt: new Date().toISOString(),
      });

      if (isMobileLayout) {
        if (autoplayEnabled && nextLessonEntry) {
          openNextLesson(true);
          return;
        }
        setActiveLessonTab('Video');
        setMobileLessonStageOverride('explanation-complete');
        return;
      }

      if (!isMobileLayout && autoplayEnabled && nextLessonEntry) {
        setAutoplayCountdown(AUTOPLAY_COUNTDOWN_SECONDS);
      }
    }
  }, [
    autoplayEnabled,
    explanationPlaybackSeconds,
    lessonProgressTab,
    nextLessonEntry,
    isMobileLayout,
    isVideoReplayMode,
    hasCompletedLessonVideo,
    completedVideoPlaybackKey,
    selectedLessonExplanationWatchCount,
    screen,
    selectedCourse,
    selectedLessonExamSelectedOption,
    selectedLessonExamSubmitted,
    selectedLessonExplanationDurationSeconds,
    selectedLessonEntry,
    selectedLessonStoredProgress?.completed,
    selectedLessonStoredProgress?.lessonStage,
    selectedLessonStoredProgress?.explanationSeconds,
    selectedLessonVideoDurationSeconds,
    selectedLessonVideoWatchCount,
  ]);

  useEffect(() => {
    const currentVideo = lessonVideoRef.current;
    if (!currentVideo) {
      return;
    }

    currentVideo.playbackRate = playbackSpeed;
  }, [
    playbackSpeed,
    protectedLessonPlayback?.fallbackStreamUrl,
    protectedLessonPlayback?.streamUrl,
    selectedLessonDirectVideoUrl,
    selectedLesson?.id,
    useProtectedSourceFallback,
  ]);

  useEffect(() => {
    setPrivateVideoQualityOptions([]);
    setSelectedPrivateVideoQuality(480);
  }, [selectedLesson?.id, protectedLessonPlayback?.streamUrl, protectedLessonPlayback?.fallbackStreamUrl]);

  useEffect(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const currentVideo = lessonVideoRef.current;
    const fallbackStreamUrl = protectedLessonPlayback?.fallbackStreamUrl || null;
    const streamUrl = useProtectedSourceFallback && fallbackStreamUrl
      ? fallbackStreamUrl
      : protectedLessonPlayback?.streamUrl || null;
    const streamFormat = useProtectedSourceFallback && fallbackStreamUrl
      ? protectedLessonPlayback?.fallbackStreamFormat || 'source'
      : protectedLessonPlayback?.streamFormat || null;
    if (!currentVideo || !streamUrl || streamFormat !== 'hls') {
      return;
    }

    const trySourceFallback = () => {
      if (!fallbackStreamUrl || useProtectedSourceFallback) {
        return false;
      }
      setUseProtectedSourceFallback(true);
      return true;
    };

    const canUseHlsJs = Hls.isSupported();
    if (!canUseHlsJs) {
      if (currentVideo.canPlayType('application/vnd.apple.mpegurl')) {
        setPrivateVideoQualityOptions([]);
        currentVideo.src = streamUrl;
        const cleanupMetrics = wireHlsPlaybackMetrics({
          video: currentVideo,
          src: streamUrl,
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
    hls.loadSource(streamUrl);
    hls.attachMedia(currentVideo);
    const cleanupMetrics = wireHlsPlaybackMetrics({
      video: currentVideo,
      hls,
      src: streamUrl,
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
    activeLessonTab,
    protectedLessonPlayback?.fallbackStreamUrl,
    isMobileLayout,
    mobileLessonStageOverride,
    protectedLessonPlayback?.streamFormat,
    protectedLessonPlayback?.streamUrl,
    screen,
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

  useEffect(() => {
    if (autoplayCountdown === null) {
      return;
    }

    if (autoplayCountdown <= 0) {
      if (nextLessonEntry) {
        setSelectedLessonId(nextLessonEntry.lesson.id);
        setActiveLessonTab('Video');
        setVideoPlaybackSeconds(0);
        setExplanationPlaybackSeconds(0);
      }
      setAutoplayCountdown(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAutoplayCountdown((current) => (current === null ? null : current - 1));
    }, 1000);

    return () => window.clearTimeout(timeoutId);
  }, [autoplayCountdown, nextLessonEntry]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === playerViewportRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!playerViewportRef.current) {
      return;
    }

    if (document.fullscreenElement === playerViewportRef.current) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    await playerViewportRef.current.requestFullscreen?.().catch(() => undefined);
  };

  const submitLessonExam = (advanceToExplanation: boolean) => {
    if (!selectedCourse || !selectedLessonEntry) {
      return;
    }

    setQuizSubmitted((current) => ({ ...current, [selectedLessonEntry.lesson.id]: true }));
    persistProgress(selectedCourse._id, selectedLessonEntry.lesson.id, {
      lessonId: selectedLessonEntry.lesson.id,
      progressSeconds: selectedLessonVideoDurationSeconds,
      progressPercent: EXAM_STAGE_PROGRESS,
      completed: false,
      lessonStage: 'explanation',
      examSubmitted: true,
      examSelectedOption: selectedLessonExamSelectedOption,
      explanationSeconds: explanationPlaybackSeconds,
      updatedAt: new Date().toISOString(),
    });

    if (isMobileLayout) {
      setMobileLessonStageOverride(advanceToExplanation ? 'explanation' : 'exam-complete');
      setIsExplanationPlaying(false);
      setIsVideoReplayMode(false);
      return;
    }

    setActiveLessonTab('CBT Exam');
    setIsExplanationPlaying(false);
    setIsVideoReplayMode(false);
  };

  const buildSelectedLessonCbtTest = () => {
    if (!selectedLessonEntry?.lesson.cbt) {
      return null;
    }

    const attachedCbt = selectedLessonEntry.lesson.cbt;
    const questions = attachedCbt.questions || [];
    const totalMarks = questions.reduce((sum, question) => sum + Number(question.marks || 1), 0);
    const sectionMap = new Map<string, number>();

    questions.forEach((question) => {
      const topic = question.topic || selectedLessonEntry.lesson.title;
      sectionMap.set(topic, (sectionMap.get(topic) || 0) + 1);
    });

    return {
      _id: `lesson-cbt:${selectedCourse?._id || 'course'}:${selectedLessonEntry.lesson.id}`,
      title: attachedCbt.title || `${selectedLessonEntry.lesson.title} CBT`,
      description: `${selectedCourse?.title || 'Course'} • ${selectedLessonEntry.moduleTitle}${selectedLessonEntry.chapterTitle ? ` • ${selectedLessonEntry.chapterTitle}` : ''} • ${selectedLessonEntry.lesson.title}`,
      category: 'CBT',
      course: selectedCourse?.title || null,
      type: 'cbt',
      durationMinutes: attachedCbt.durationMinutes || 60,
      totalMarks,
      negativeMarking: attachedCbt.negativeMarking ?? 0,
      sectionBreakup: Array.from(sectionMap.entries()).map(([name, questionCount]) => ({ name, questions: questionCount })),
      questions,
    } satisfies MockTest;
  };

  const startLessonExam = () => {
    if (!selectedLessonHasCbt || !isLessonReadyForExam) {
      return;
    }

    const test = buildSelectedLessonCbtTest();
    if (test && onOpenCbtExam) {
      onOpenCbtExam(test, () => submitLessonExam(true));
      return;
    }

    if (isMobileLayout) {
      setActiveLessonTab('CBT Exam');
      setMobileLessonStageOverride('exam');
      setIsVideoReplayMode(false);
      return;
    }

    setActiveLessonTab('CBT Exam');
    setIsVideoReplayMode(false);
  };

  const openLessonExplanation = () => {
    if (!selectedLessonHasExplanation || !canWatchExplanation) {
      return;
    }

    if (isMobileLayout) {
      setActiveLessonTab('Explanation');
      setMobileLessonStageOverride('explanation');
      setIsExplanationPlaying(false);
      setIsVideoReplayMode(false);
      return;
    }

    setActiveLessonTab('Explanation');
    setIsExplanationPlaying(false);
    setIsVideoReplayMode(false);
  };

  const completeMobileLessonAndAdvance = () => {
    if (selectedCourse && selectedLessonEntry) {
      persistProgress(selectedCourse._id, selectedLessonEntry.lesson.id, {
        lessonId: selectedLessonEntry.lesson.id,
        progressSeconds: selectedLessonExplanationDurationSeconds,
        progressPercent: 100,
        completed: true,
        lessonStage: 'explanation',
        examSubmitted: true,
        examSelectedOption: selectedLessonExamSelectedOption,
        explanationSeconds: selectedLessonExplanationDurationSeconds,
        videoWatchCount: selectedLessonVideoWatchCount,
        explanationWatchCount: MAX_EXPLANATION_WATCHES,
        updatedAt: new Date().toISOString(),
      });
    }

    openNextLesson(true);
  };

  const openCourse = (courseId: string, nextScreen: Screen = 'course') => {
    const targetCourse = overview.courses.find((course) => course._id === courseId);
    if (!targetCourse) {
      return;
    }

    const sections = buildCourseSections(targetCourse);
    const nextLesson = sections.flatMap((section) => section.lessons).find((entry) => entry.lesson.id === targetCourse.continueLesson?.id)
      || sections.flatMap((section) => section.lessons)[0]
      || null;

    setSelectedCourseId(courseId);
    setSelectedLessonId(nextLesson?.lesson.id || null);
    setScreen(nextScreen);
    setActiveCourseTab('Lessons');
    setActiveLessonTab('Video');
    setMobileLessonStageOverride(null);
    setSearchQuery('');
    setCourseAccessMessage(null);
    setAutoplayCountdown(null);
    setIsVideoPlaying(false);
    setIsExplanationPlaying(false);
    setExpandedSectionsByCourse((current) => ({
      ...current,
      [courseId]: current[courseId]?.length ? current[courseId] : sections[0] ? [sections[0].id] : [],
    }));
  };

  const handleUnlockCourse = async (course: CourseCard) => {
    if (!user) {
      setCourseAccessMessage('Login is required before enrolling in this course.');
      return;
    }

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
      setCourseAccessMessage('Payment confirmed. Course access is active.');
    } catch (error) {
      setCourseAccessMessage(error instanceof Error ? error.message : 'Unable to unlock this course right now.');
    } finally {
      setBusyCourseId(null);
    }
  };

  const renderCourseAccessActions = (course: CourseCard, variant: 'mobile' | 'desktop') => {
    if (user?.role === 'admin' || hasActiveCourseAccess(course)) {
      return (
        <span className={cn(
          'inline-flex items-center justify-center font-semibold',
          variant === 'mobile'
            ? 'h-[30px] rounded-[10px] bg-[#e8f7ef] px-[8px] text-[9.5px] text-[#16824a]'
            : 'h-[42px] rounded-[12px] bg-[#e8f7ef] px-[16px] text-[13px] text-[#16824a]',
        )}>
          Access active
        </span>
      );
    }

    if (!shouldShowCoursePaymentButton(course)) {
      return (
        <span className={cn(
          'inline-flex items-center justify-center font-semibold',
          variant === 'mobile'
            ? 'h-[30px] rounded-[10px] bg-[#eef2f8] px-[8px] text-[9.5px] text-[#6c7b93]'
            : 'h-[42px] rounded-[12px] bg-[#eef2f8] px-[16px] text-[13px] text-[#6c7b93]',
        )}>
          {getCoursePrimaryActionLabel(course)}
        </span>
      );
    }

    return (
      <button
        type="button"
        onClick={() => handleUnlockCourse(course)}
        disabled={busyCourseId === course._id}
        className={cn(
          'inline-flex items-center justify-center gap-[8px] rounded-[12px] bg-[#2f6fe4] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)] disabled:opacity-60',
          variant === 'mobile' ? 'h-[30px] px-[8px] text-[9.5px]' : 'h-[42px] px-[16px] text-[13px]',
        )}
      >
        {busyCourseId === course._id ? <LoaderCircle className="h-[14px] w-[14px] animate-spin" /> : <Wallet className="h-[14px] w-[14px]" />}
        {getCoursePrimaryActionLabel(course)}
      </button>
    );
  };

  const openLesson = (lessonId: string, forceOpen = false) => {
    if (!selectedCourse) {
      return;
    }

    const targetEntry = selectedCourseEntries.find((entry) => entry.lesson.id === lessonId);
    if (!targetEntry || (!forceOpen && !unlockMap.get(lessonId)?.unlocked)) {
      return;
    }

    setExpandedSectionsByCourse((current) => ({
      ...current,
      [selectedCourse._id]: Array.from(new Set([...(current[selectedCourse._id] || []), targetEntry.sectionId])),
    }));
    setSelectedLessonId(lessonId);
    setScreen('lesson');
    setActiveLessonTab('Video');
    setMobileLessonStageOverride(null);
    setSearchQuery('');
    setVideoPlaybackSeconds(0);
    setExplanationPlaybackSeconds(0);
    setIsVideoPlaying(false);
    setIsExplanationPlaying(false);
    setIsVideoReplayMode(false);
  };

  const toggleSection = (sectionId: string) => {
    if (!selectedCourse) {
      return;
    }

    setExpandedSectionsByCourse((current) => {
      const existing = current[selectedCourse._id] || [];
      const next = existing.includes(sectionId)
        ? existing.filter((item) => item !== sectionId)
        : [...existing, sectionId];

      return {
        ...current,
        [selectedCourse._id]: next,
      };
    });
  };

  const handlePrimaryLessonAction = () => {
    if (!selectedLessonEntry) {
      return;
    }

    if (activeLessonTab === 'Video') {
      if (!isLessonReadyForExam) {
        setActiveLessonTab('Video');
        if (isVideoPlaying) {
          protectedLessonVideoRef.current?.pause();
          setIsVideoPlaying(false);
          return;
        }
        void protectedLessonVideoRef.current?.play().then((started) => {
          if (started) {
            setIsVideoPlaying(true);
          }
        });
        return;
      }

      if (!selectedLessonExamSubmitted) {
        startLessonExam();
        return;
      }

      if (!isLessonFlowComplete) {
        openLessonExplanation();
        return;
      }

      openNextLesson();
      return;
    }

    if (activeLessonTab === 'CBT Exam') {
      if (!selectedLessonExamSubmitted) {
        if (selectedLessonExamSelectedOption === null) {
          return;
        }
        submitLessonExam(false);
        return;
      }
      openLessonExplanation();
      return;
    }

    if (activeLessonTab === 'Explanation') {
      if (explanationPlaybackSeconds >= selectedLessonExplanationDurationSeconds) {
        openNextLesson();
        return;
      }
      setIsExplanationPlaying((current) => !current);
    }
  };

  const openNextLesson = (forceOpen = false) => {
    if (!nextLessonEntry || (!forceOpen && !unlockMap.get(nextLessonEntry.lesson.id)?.unlocked)) {
      return;
    }
    setAutoplayCountdown(null);
    setIsVideoReplayMode(false);
    openLesson(nextLessonEntry.lesson.id, forceOpen);
  };

  const isLessonTabUnlocked = (tab: LessonTab) => {
    if (tab === 'CBT Exam') {
      return selectedLessonHasCbt && isLessonReadyForExam;
    }

    if (tab === 'Explanation') {
      return selectedLessonHasExplanation && isExplanationUnlocked;
    }

    return true;
  };

  const handleLessonTabSelect = (tab: LessonTab) => {
    if (!isLessonTabUnlocked(tab)) {
      return;
    }

    if (tab === 'CBT Exam' && !selectedLessonExamSubmitted && isLessonReadyForExam && onOpenCbtExam) {
      startLessonExam();
      return;
    }

    setActiveLessonTab(tab);
    if (tab !== 'Video') {
      setIsVideoReplayMode(false);
    } else {
      setIsVideoReplayMode(false);
      setMobileLessonStageOverride(null);
    }

    if (!isMobileLayout) {
      if (tab === 'Explanation') {
        setIsExplanationPlaying(false);
      }
      return;
    }

    if (tab === 'CBT Exam') {
      setMobileLessonStageOverride(selectedLessonExamSubmitted ? 'exam-complete' : 'exam');
      return;
    }

    if (tab === 'Explanation') {
      setMobileLessonStageOverride('explanation');
      setIsExplanationPlaying(false);
      return;
    }

    if (tab === 'Video') {
      setMobileLessonStageOverride(null);
      return;
    }

    setMobileLessonStageOverride(null);
  };

  const nextStepDescriptor = useMemo(() => {
    if (!selectedLessonEntry) {
      return null;
    }

    if (!selectedLessonHasCbt) {
      if (nextLessonEntry) {
        return {
          kind: 'next-lesson' as const,
          title: nextLessonEntry.lesson.title,
          subtitle: 'This lesson has no linked CBT or explanation. Continue directly to the next lesson when you are ready.',
          badge: 'Next lesson',
          actionLabel: 'Open Next Lesson',
          onClick: () => openNextLesson(true),
          disabled: false,
        };
      }

      return {
        kind: 'course-complete' as const,
        title: selectedLessonEntry.lesson.title,
        subtitle: 'This lesson has no linked CBT or explanation. Return to the course list and continue with any unlocked lesson.',
        badge: 'Video only',
        actionLabel: 'Back to Lessons',
        onClick: () => setScreen('course'),
        disabled: false,
      };
    }

    if (!selectedLessonExamSubmitted) {
      return {
        kind: 'cbt' as const,
        title: selectedLessonEntry.lesson.cbt?.title || `${selectedLessonEntry.lesson.title} CBT`,
        subtitle: isLessonReadyForExam
          ? 'Take the one-time chapter based test before the explanation unlocks.'
          : 'Finish this lesson video first to unlock the chapter test.',
        badge: isLessonReadyForExam ? 'Ready' : 'Lesson required',
        actionLabel: isLessonReadyForExam ? 'Start CBT Exam' : 'Finish lesson first',
        onClick: isLessonReadyForExam ? startLessonExam : undefined,
        disabled: !isLessonReadyForExam,
      };
    }

    if (!isLessonFlowComplete) {
      return {
        kind: 'explanation' as const,
        title: 'Lesson Explanation',
        subtitle: 'Watch the explanation once before the next lesson unlocks.',
        badge: 'One-time watch',
        actionLabel: 'Watch Explanation',
        onClick: canWatchExplanation ? openLessonExplanation : undefined,
        disabled: !canWatchExplanation,
      };
    }

    if (nextLessonEntry) {
      return {
        kind: 'lesson' as const,
        title: nextLessonEntry.lesson.title,
        subtitle: formatDurationLabel(nextLessonEntry.lesson.durationMinutes),
        badge: autoplayCountdown !== null ? `Autoplay in ${autoplayCountdown}s` : 'Ready',
        actionLabel: 'Open Next Lesson',
        onClick: openNextLesson,
        disabled: false,
      };
    }

    return {
      kind: 'complete' as const,
      title: 'Lesson sequence complete',
      subtitle: 'You have completed this lesson path.',
      badge: 'Done',
      actionLabel: 'Completed',
      onClick: undefined,
      disabled: true,
    };
  }, [
    autoplayCountdown,
    isExplanationUnlocked,
    isLessonFlowComplete,
    isLessonReadyForExam,
    nextLessonEntry,
    canWatchExplanation,
    openNextLesson,
    openLessonExplanation,
    selectedLessonEntry,
    selectedLessonHasCbt,
    selectedLessonExamSubmitted,
    startLessonExam,
  ]);

  const primaryLessonActionLabel = activeLessonTab === 'Explanation'
    ? explanationPlaybackSeconds >= selectedLessonExplanationDurationSeconds
      ? 'Next Lesson'
      : isExplanationPlaying
        ? 'Pause Explanation'
        : 'Play Explanation'
    : activeLessonTab === 'CBT Exam'
      ? selectedLessonExamSubmitted
        ? 'Watch Explanation'
        : 'Submit CBT'
      : isVideoReplayMode || !isLessonReadyForExam
        ? (isVideoPlaying ? 'Pause Lesson' : 'Resume Lesson')
        : !selectedLessonExamSubmitted
          ? 'Start CBT Exam'
          : !isLessonFlowComplete
            ? 'Watch Explanation'
            : 'Open Next Lesson';

  const primaryLessonActionDisabled = activeLessonTab === 'CBT Exam'
    ? !selectedLessonExamSubmitted && selectedLessonExamSelectedOption === null
    : false;

  const renderNextStepCard = (variant: 'desktop' | 'mobile') => {
    if (!nextStepDescriptor) {
      return null;
    }

    const isMobileCard = variant === 'mobile';
    const Icon = nextStepDescriptor.kind === 'cbt'
      ? ClipboardCheck
      : nextStepDescriptor.kind === 'explanation'
        ? Video
        : nextStepDescriptor.kind === 'lesson'
          ? Play
          : CheckCircle2;

    return (
      <section
        data-testid="course-up-next"
        className={cn(
          isMobileCard
            ? 'rounded-[16px] border border-[#dbe4f3] bg-white px-[13px] py-[11px] shadow-[0_12px_24px_rgba(54,78,123,0.04)]'
            : 'rounded-[22px] bg-white px-[18px] py-[16px] shadow-[0_16px_34px_rgba(54,78,123,0.08)]',
        )}
      >
        <div className="flex items-center justify-between gap-[12px]">
          <p className={cn(isMobileCard ? 'text-[13px]' : 'text-[17px]', 'font-semibold text-[#17233f]')}>Up Next</p>
          <span className={cn(isMobileCard ? 'text-[11px]' : 'text-[13px]', 'font-medium text-[#2d6ee5]')}>
            {nextStepDescriptor.badge}
          </span>
        </div>

        <div
          className={cn(
            'mt-[12px] rounded-[16px] border border-[#e7edf7] bg-[#fbfdff]',
            isMobileCard ? 'px-[11px] py-[11px]' : 'px-[14px] py-[14px]',
          )}
        >
          <div className="flex items-start gap-[12px]">
            <div
              className={cn(
                'flex shrink-0 items-center justify-center rounded-[14px] bg-[#e8f0ff] text-[#2d6ee5]',
                isMobileCard ? 'h-[38px] w-[38px]' : 'h-[44px] w-[44px]',
              )}
            >
              <Icon className={cn(nextStepDescriptor.kind === 'lesson' ? 'ml-[1px]' : '', isMobileCard ? 'h-[16px] w-[16px]' : 'h-[19px] w-[19px]', nextStepDescriptor.kind === 'lesson' && 'fill-current')} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn(isMobileCard ? 'text-[13px]' : 'text-[15px]', 'font-semibold leading-[1.22] text-[#23385f]')}>
                {nextStepDescriptor.title}
              </p>
              <p className={cn(isMobileCard ? 'mt-[3px] text-[11px]' : 'mt-[5px] text-[13px]', 'leading-[1.4] text-[#6e80a1]')}>
                {nextStepDescriptor.subtitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid={
              nextStepDescriptor.kind === 'cbt'
                ? 'course-player-start-cbt'
                : nextStepDescriptor.kind === 'explanation'
                  ? 'course-player-watch-explanation'
                  : nextStepDescriptor.kind === 'lesson'
                    ? 'course-player-continue-next-lesson'
                    : undefined
            }
            onClick={() => nextStepDescriptor.onClick?.()}
            disabled={nextStepDescriptor.disabled}
            className={cn(
              'mt-[14px] inline-flex w-full items-center justify-center rounded-[10px] text-center font-semibold transition',
              isMobileCard ? 'h-[36px] text-[12px]' : 'h-[42px] text-[14px]',
              nextStepDescriptor.disabled
                ? 'cursor-not-allowed border border-[#d7e1f0] bg-[#f2f6fd] text-[#8aa0c2]'
                : 'bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-white shadow-[0_12px_24px_rgba(45,110,229,0.20)]',
            )}
          >
            {nextStepDescriptor.actionLabel}
          </button>
        </div>
      </section>
    );
  };

  const userName = overview.user?.name || 'Edu Master';
  const notificationCount = overview.notificationCount ?? overview.notifications.length;
  const selectedTone = getCatalogTone(selectedCourse || overview.courses[0], 0);
  const selectedToneStyles = toneStyles[selectedTone];
  const breadcrumbLabel = selectedLessonEntry
    ? ['Courses', selectedCourse?.title, selectedLessonEntry.sectionLabel, selectedLessonEntry.lesson.title].filter(Boolean).join(' / ')
    : ['Courses', selectedCourse?.title].filter(Boolean).join(' / ');

  const renderMovingWatermark = (variant: 'mobile' | 'desktop') => {
    if (!currentPlaybackWatermarkText || !isWatermarkVisible) {
      return null;
    }

    return (
      <div
        className={cn(
          'pointer-events-none absolute z-20 rounded-full bg-black/58 px-4 py-2 font-semibold uppercase tracking-[0.14em] text-white/84 shadow-[0_8px_22px_rgba(0,0,0,0.28)] transition-all duration-500',
          variant === 'mobile' ? 'text-[9px]' : 'text-xs',
        )}
        style={{
          top: watermarkPosition.top,
          left: watermarkPosition.left,
          transform: `translate(-50%, -50%) rotate(${watermarkPosition.rotate})`,
          maxWidth: variant === 'mobile' ? '78%' : '68%',
        }}
      >
        <span className="block truncate">{currentPlaybackWatermarkText}</span>
      </div>
    );
  };

  const renderActualLessonMedia = (variant: 'mobile' | 'desktop') => {
    if (!selectedLesson) {
      return null;
    }

    const playerDrmConfig = selectedLesson?.type === 'private-video' ? protectedLessonPlayback?.drmConfig || null : null;
    const drmManifestUrl = playerDrmConfig?.enabled ? playerDrmConfig.manifestUrl || null : null;
    const playerUrl = drmManifestUrl || selectedLessonDirectVideoUrl
      || (useProtectedSourceFallback && protectedLessonPlayback?.fallbackStreamUrl
        ? protectedLessonPlayback.fallbackStreamUrl
        : protectedLessonPlayback?.streamUrl || null);
    const playerFormat = useProtectedSourceFallback && protectedLessonPlayback?.fallbackStreamUrl
      ? protectedLessonPlayback?.fallbackStreamFormat || 'source'
      : protectedLessonPlayback?.streamFormat || null;
    const isYouTube = selectedLesson.type === 'youtube';
    const isPrivateVideo = selectedLesson.type === 'private-video';
    const isHostedVideo = selectedLesson.type === 'video';
    const shouldUseHlsPlayer = Boolean(
      drmManifestUrl
      || (playerUrl && playerFormat === 'hls'),
    );

    if (loadingProtectedLesson && selectedLessonHasSecurePlayback) {
      return (
        <div className={cn('flex items-center justify-center gap-3 bg-[#0f1726] px-6 text-center text-white', variant === 'mobile' ? 'h-full' : 'min-h-[260px]')}>
          <LoaderCircle className="h-5 w-5 animate-spin text-white/64" />
          <span className="text-[13px] font-medium text-white/58">Loading video...</span>
        </div>
      );
    }

    if (protectedLessonError) {
      return (
        <div className="flex min-h-[260px] items-center justify-center bg-[#0f1726] px-6 text-center">
          <div className="max-w-[460px]">
            <p className="text-base font-semibold text-white">Lesson video unavailable</p>
            <p className="mt-2 text-sm leading-6 text-white/72">
              {protectedLessonError}
            </p>
            <button
              type="button"
              onClick={() => {
                void reloadProtectedLessonPlayback(true);
              }}
              className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#0f1726] transition hover:bg-white/90"
            >
              Retry video
            </button>
          </div>
        </div>
      );
    }

    if (isPrivateVideo && protectedLessonPlayback?.statusMessage && !playerUrl && user?.role === 'admin') {
      return (
        <div className={cn('flex flex-col items-center justify-center gap-3 bg-[#0f1726] px-6 text-center text-white', variant === 'mobile' ? 'h-full' : 'min-h-[260px]')}>
          <LoaderCircle className="h-5 w-5 animate-spin text-white/64" />
          <div>
            <p className="text-base font-semibold text-white">Video is still preparing</p>
            <p className="mt-2 text-sm leading-6 text-white/72">{protectedLessonPlayback.statusMessage}</p>
          </div>
        </div>
      );
    }

    if (isYouTube && protectedLessonPlayback?.embedUrl) {
      return (
        <div className="aspect-video w-full bg-black">
          <iframe
            title={selectedLesson.title}
            src={protectedLessonPlayback.embedUrl}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="h-full w-full border-0"
          />
        </div>
      );
    }

    if ((isPrivateVideo || isHostedVideo) && playerUrl) {
      return (
        <div className={cn('relative bg-black', variant === 'mobile' && 'h-full')}>
          {shouldUseHlsPlayer ? (
            <ResilientHlsVideo
              ref={protectedLessonVideoRef}
              key={`${selectedLesson.id}:${drmManifestUrl || playerUrl}`}
              src={drmManifestUrl || playerUrl || ''}
              drmConfig={playerDrmConfig}
              title={selectedLesson.title}
              watermarkText={currentPlaybackWatermarkText}
              trackVideoId={selectedLesson.id}
              trackCourseId={selectedCourse._id}
              trackLessonId={selectedLesson.id}
              trackVideoType={protectedLessonPlayback?.videoType || 'course'}
              playbackSessionId={protectedLessonPlayback?.playbackSessionId || null}
              streamFormat={playerDrmConfig?.manifestFormat || playerFormat || 'hls'}
              resumeSeconds={protectedLessonPlayback?.resumeSeconds ?? selectedLessonStoredProgress?.progressSeconds ?? 0}
              defaultQualityHeight={480}
              selectedQualityHeight={selectedPrivateVideoQuality}
              onQualityOptionsChange={(options) => {
                setPrivateVideoQualityOptions(options);
                setSelectedPrivateVideoQuality((current) => getDefaultRecordedVideoQualityHeight(options, current));
              }}
              className={cn(
                'w-full bg-black',
                isFullscreen
                  ? 'h-screen min-h-0 rounded-none border-0 object-contain'
                  : variant === 'mobile'
                  ? 'h-full min-h-0 object-cover'
                  : 'aspect-video min-h-[420px] object-contain',
              )}
              onReady={() => setIsVideoPlaying(false)}
              onProgress={(progressSeconds, durationSeconds, completed) => {
                const safeDurationSeconds = Math.max(Number(durationSeconds || selectedLessonVideoDurationSeconds || 0), 1);
                setVideoPlaybackSeconds(progressSeconds || 0);
                setIsVideoPlaying(!completed);
                if (completed) {
                  const minimumWatchedSeconds = Math.min(
                    safeDurationSeconds,
                    Math.max(60, safeDurationSeconds * selectedLessonCompletionRatio),
                  );
                  if ((progressSeconds || 0) >= minimumWatchedSeconds) {
                    setCompletedVideoPlaybackKey(`${selectedLesson.id}::${Date.now()}`);
                  }
                }
              }}
            />
          ) : (
            <video
              key={`${selectedLesson.id}:${playerUrl}`}
              ref={lessonVideoRef}
              data-testid="course-player-video"
              src={playerFormat === 'source' || isHostedVideo ? playerUrl : undefined}
              controls
              controlsList="nodownload noremoteplayback"
              playsInline
              disablePictureInPicture
              disableRemotePlayback
              className={cn(
                'w-full bg-black',
                isFullscreen
                  ? 'h-screen min-h-0 object-contain'
                  : variant === 'mobile'
                  ? 'h-full min-h-0 object-cover'
                  : 'aspect-video min-h-[420px] object-contain',
              )}
              onPlay={() => setIsVideoPlaying(true)}
              onPause={() => setIsVideoPlaying(false)}
              onLoadedMetadata={(event) => {
                const resumeSeconds = protectedLessonPlayback?.resumeSeconds ?? selectedLessonStoredProgress?.progressSeconds ?? 0;
                if (resumeSeconds > 0) {
                  event.currentTarget.currentTime = resumeSeconds;
                }
                setVideoPlaybackSeconds(event.currentTarget.currentTime || 0);
              }}
              onCanPlay={(event) => {
                const resumeSeconds = protectedLessonPlayback?.resumeSeconds ?? selectedLessonStoredProgress?.progressSeconds ?? 0;
                if (resumeSeconds > 0 && event.currentTarget.currentTime < 1) {
                  event.currentTarget.currentTime = resumeSeconds;
                }
              }}
              onTimeUpdate={(event) => {
                setVideoPlaybackSeconds(event.currentTarget.currentTime || 0);
              }}
              onEnded={(event) => {
                const durationSeconds = Math.max(Number(event.currentTarget.duration || selectedLessonVideoDurationSeconds || 0), 1);
                const playedSeconds = getPlayedSeconds(event.currentTarget);
                const minimumWatchedSeconds = Math.min(
                  durationSeconds,
                  Math.max(60, durationSeconds * selectedLessonCompletionRatio),
                );
                setIsVideoPlaying(false);
                setVideoPlaybackSeconds(event.currentTarget.duration || selectedLessonVideoDurationSeconds);
                if (playedSeconds >= minimumWatchedSeconds) {
                  setCompletedVideoPlaybackKey(`${selectedLesson.id}::${Date.now()}`);
                }
              }}
            />
          )}
          {!drmManifestUrl ? renderMovingWatermark(variant) : null}
          {isPrivateVideo && playerFormat === 'hls' && privateVideoQualityOptions.length > 0 ? (
            <div className="flex items-center justify-end gap-3 border-t border-white/10 bg-[#0f1726] px-4 py-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/58">Quality</span>
              <select
                value={String(selectedPrivateVideoQuality)}
                onChange={(event) => setSelectedPrivateVideoQuality(Number(event.target.value))}
                className="rounded-xl border border-white/12 bg-white/8 px-3 py-2 text-sm text-white outline-none"
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
      );
    }

    return null;
  };

  const renderLessonMediaUnavailable = (variant: 'mobile' | 'desktop') => (
    <div
      className={cn(
        'flex items-center justify-center bg-[#0f1726] px-6 text-center text-white',
        variant === 'mobile' ? 'min-h-[260px]' : 'min-h-[420px]',
      )}
    >
      <div className="max-w-[420px]">
        <div className="mx-auto flex h-[56px] w-[56px] items-center justify-center rounded-full bg-white/10 text-white/88">
          <Video className="h-[24px] w-[24px]" />
        </div>
        <p className="mt-[16px] text-[18px] font-semibold">Lesson video is not available yet</p>
        <p className="mt-[8px] text-[14px] leading-[1.6] text-white/72">
          This lesson does not have a published video source right now. Upload or publish the lesson video from Admin to make playback available here.
        </p>
      </div>
    </div>
  );

  const renderCatalogView = () => (
    isMobileLayout ? (
      <div
        data-testid="course-figma-page"
        data-course-view="catalog"
        className="mobile-safe-screen min-h-[100dvh] overflow-x-hidden bg-[#f4f7ff] pb-[76px]"
      >
          <div className="mobile-safe-content mx-auto pb-[10px] pt-[10px]" style={uiFontStyle}>

            <header>
            <div className="flex items-center justify-between gap-[12px]">
              <h1 className="text-[19px] font-semibold leading-none tracking-[-0.02em] text-[#1c2844]">All Courses</h1>
            </div>

            <label
              data-testid="course-catalog-search"
              className="mt-[12px] flex h-[42px] items-center gap-[10px] rounded-[14px] border border-[#d9e3f2] bg-white px-[13px] text-[13px] text-[#7f8fb0] shadow-[0_8px_18px_rgba(28,41,61,0.04)]"
            >
              <Search className="h-[17px] w-[17px]" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search courses..."
                className="w-full bg-transparent text-[#1f2d4e] outline-none placeholder:text-[#9aa7bc]"
              />
            </label>
          </header>

          <div className="mt-[14px] space-y-[8px]">
            {mobileCatalogCourses.map((course, index) => {
              const tone = getMobileCatalogTone(course);
              const styles = toneStyles[tone];
              const snapshot = courseSnapshots[course._id] || { totalLessons: 0, completedLessons: 0, progressPercent: 0 };
              const actionLabel = getCoursePrimaryActionLabel(course, snapshot.progressPercent);
              const icon = index % 3 === 0
                ? <BookOpen className="h-[26px] w-[26px]" />
                : index % 3 === 1
                  ? <FileText className="h-[26px] w-[26px]" />
                  : <ClipboardCheck className="h-[26px] w-[26px]" />;

              return (
                <button
                  key={course._id}
                  type="button"
                  data-testid={`course-catalog-card-${slugify(course._id)}`}
                  onClick={() => openCourse(course._id, 'course')}
                  className="w-full overflow-hidden rounded-[18px] border border-[#dee7f4] bg-white px-[11px] py-[10px] text-left shadow-[0_10px_24px_rgba(28,41,61,0.06)]"
                >
                  <div className="flex items-start gap-[10px]">
                    <div className={cn('flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-[14px]', styles.sidebar, styles.chip.replace('text-white', 'text-current'))}>
                      {React.cloneElement(icon, { className: 'h-[22px] w-[22px]' })}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-[8px]">
                        <div className="min-w-0">
                          <span className={cn('inline-flex rounded-full px-[10px] py-[3px] text-[10px] font-semibold uppercase tracking-[0.03em]', styles.chip)}>
                            {course.exam || course.category || 'Course'}
                          </span>
                          <p className="mt-[6px] text-[13px] font-semibold leading-[1.16] text-[#1f2d4e]">{getMobileCourseTitle(course)}</p>
                          <p className="mt-[2px] text-[11px] text-[#6d7c93]">{course.subject || course.category || 'Competitive Exam'}</p>
                          {!hasActiveCourseAccess(course) && shouldShowCoursePaymentButton(course) && (
                            <p className="mt-[4px] text-[10px] font-semibold text-[#cf7a21]">{getCourseFeeSummary(course)}</p>
                          )}
                        </div>
                        <MoreVertical className="h-[17px] w-[17px] shrink-0 text-[#7f8fb0]" />
                      </div>

                      <div className="mt-[8px] flex items-center gap-[8px]">
                        <p className="shrink-0 text-[11px] font-medium text-[#5e7397]">{snapshot.progressPercent}% Completed</p>
                        <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-[#e8eef7]">
                          <div className={cn('h-full rounded-full', styles.progress)} style={{ width: `${Math.max(snapshot.progressPercent, 4)}%` }} />
                        </div>
                        <span className={cn('inline-flex h-[30px] shrink-0 items-center rounded-[10px] px-[11px] text-[11px] font-semibold text-white', styles.button)}>
                          {actionLabel}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-[10px] grid grid-cols-3 gap-[6px] border-t border-[#eef2f8] pt-[8px]">
                    <div className="text-center">
                      <p className="text-[13px] font-semibold text-[#1f2d4e]">{snapshot.totalLessons}</p>
                      <p className="mt-[2px] text-[10px] text-[#7b879d]">Course flow</p>
                    </div>
                    <div className="border-x border-[#eef2f8] text-center">
                      <p className="text-[13px] font-semibold text-[#1f2d4e]">{snapshot.completedLessons}</p>
                      <p className="mt-[2px] text-[10px] text-[#7b879d]">Completed</p>
                    </div>
                    <div className="text-center">
                      <p className="text-[13px] font-semibold text-[#1f2d4e]">{snapshot.progressPercent}%</p>
                      <p className="mt-[2px] text-[10px] text-[#7b879d]">Progress</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    ) : (
    <div
      data-testid="course-figma-page"
      data-course-view="catalog"
      className="overflow-hidden rounded-[30px] border border-white/70 bg-[linear-gradient(180deg,#f9fbff_0%,#eef3ff_100%)] shadow-[0_30px_90px_rgba(33,51,97,0.13)]"
    >
      <header className="flex flex-col gap-[18px] border-b border-[#dde5f5] bg-[linear-gradient(180deg,#ffffff_0%,#f7faff_100%)] px-[24px] py-[20px] lg:flex-row lg:items-center lg:justify-between">
        <h1 className="text-[24px] font-semibold leading-none tracking-[-0.03em] text-[#1c2844]">All Courses</h1>
        <HeaderTools
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          placeholder="Search courses..."
          testId="course-catalog-search"
        />
      </header>

      <div className="flex flex-col gap-[16px] border-b border-[#dde5f5] bg-[linear-gradient(180deg,#f2f6ff_0%,#eef3ff_100%)] px-[24px] py-[18px] xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-[10px]">
          <label className="relative">
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              className="h-[42px] min-w-[170px] appearance-none rounded-[12px] border border-[#d7dfef] bg-white px-[16px] pr-[38px] text-[15px] text-[#27385c] shadow-[0_8px_18px_rgba(64,89,142,0.05)] outline-none"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category === 'all' ? 'Category' : category}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-[12px] top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#5f7297]" />
          </label>

          <label className="relative">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              className="h-[42px] min-w-[170px] appearance-none rounded-[12px] border border-[#d7dfef] bg-white px-[16px] pr-[38px] text-[15px] text-[#27385c] shadow-[0_8px_18px_rgba(64,89,142,0.05)] outline-none"
            >
              <option value="all">Status</option>
              <option value="unlocked">Unlocked</option>
              <option value="progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="not-started">Not Started</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-[12px] top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#5f7297]" />
          </label>

          <button
            type="button"
            onClick={() => {
              setCategoryFilter('all');
              setStatusFilter('all');
              setSortBy('latest');
              setSearchQuery('');
            }}
            className="flex h-[42px] items-center gap-[8px] rounded-[12px] border border-[#d7dfef] bg-white px-[16px] text-[15px] text-[#516786] shadow-[0_8px_18px_rgba(64,89,142,0.05)]"
          >
            <Sparkles className="h-[15px] w-[15px]" />
            Reset Filter
          </button>
        </div>

        <label className="relative">
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
            className="h-[42px] min-w-[190px] appearance-none rounded-[12px] border border-[#d7dfef] bg-white px-[16px] pr-[38px] text-[15px] text-[#27385c] shadow-[0_8px_18px_rgba(64,89,142,0.05)] outline-none"
          >
            <option value="latest">Latest</option>
            <option value="progress">Progress</option>
            <option value="title">Title</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-[12px] top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#5f7297]" />
        </label>
      </div>

      <div className="bg-[radial-gradient(circle_at_12%_12%,rgba(255,255,255,0.88),transparent_22%),linear-gradient(180deg,#eaf1ff_0%,#e7efff_100%)] px-[24px] py-[22px]">
        {filteredCourses.length === 0 ? (
          <div className="rounded-[24px] border border-dashed border-[#d8e1f1] bg-white/90 px-[24px] py-[32px] text-center text-[15px] text-[#607089]">
            No courses match the current search and filters.
          </div>
        ) : (
          <div className="grid gap-[18px] xl:grid-cols-3">
            {filteredCourses.map((course, index) => (
              <CatalogCourseCard
                key={course._id}
                course={course}
                tone={getCatalogTone(course, index)}
                snapshot={courseSnapshots[course._id] || { totalLessons: 0, completedLessons: 0, progressPercent: 0 }}
                onOpen={() => openCourse(course._id, 'course')}
              />
            ))}
          </div>
        )}
      </div>
    </div>
    )
  );

  const renderLessonsTab = () => (
    <div className="space-y-[14px]">
      <div data-testid="course-figma-lessons" className="overflow-hidden rounded-[18px] border border-[#dbe4f3] bg-white shadow-[0_12px_24px_rgba(54,78,123,0.06)]">
        {filteredCourseSections.length === 0 ? (
          <div className="px-[20px] py-[26px] text-[15px] text-[#607089]">No lessons match the current search.</div>
        ) : (
          filteredCourseSections.map((section, index) => {
            const expanded = currentExpandedSections.includes(section.id);
            return (
              <div
                key={section.id}
                data-testid={index === 0 ? 'course-figma-chapter-1' : undefined}
                className={cn(index > 0 && 'border-t border-[#e4ebf8]')}
              >
                <button
                  type="button"
                  data-testid={`course-figma-chapter-${index + 1}-toggle`}
                  aria-expanded={expanded}
                  onClick={() => toggleSection(section.id)}
                  className="flex h-[62px] w-full items-center justify-between px-[20px] text-left"
                >
                  <div className="flex items-center gap-[12px]">
                    <p className="text-[16px] font-semibold text-[#1b2d50]">{section.label}</p>
                    <p className="text-[16px] text-[#44597f]">{section.title}</p>
                  </div>
                  <ChevronDown className={cn('h-[18px] w-[18px] text-[#7c8eae] transition', expanded ? 'rotate-180' : '')} />
                </button>

                {expanded && (
                  <div
                    data-testid={`course-figma-chapter-${index + 1}-panel`}
                    className={cn(index === 0 ? 'border-l-[4px] border-l-[#4a8ef5]' : 'border-l-[4px] border-l-transparent')}
                  >
                    {section.lessons.map((entry) => {
                      const completed = Boolean(selectedCourseProgressMap.get(entry.lesson.id)?.completed);
                      const unlocked = Boolean(unlockMap.get(entry.lesson.id)?.unlocked);
                      return (
                        <LessonRow
                          key={entry.lesson.id}
                          entry={entry}
                          active={selectedLessonEntry?.lesson.id === entry.lesson.id}
                          completed={completed}
                          unlocked={unlocked}
                          onOpen={() => openLesson(entry.lesson.id)}
                          showButton
                          testId={`course-lesson-open-${entry.lesson.id}`}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {selectedLessonHasCbt ? (
        <div
          data-testid="course-figma-cbt-card"
          className={cn(
            'rounded-[18px] border border-[#dbe4f3] bg-white shadow-[0_12px_24px_rgba(54,78,123,0.05)]',
            isMobileLayout ? 'px-[16px] py-[16px]' : 'px-[20px] py-[18px]',
          )}
        >
          <div className="flex items-start gap-[12px]">
            <div className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[12px] bg-[linear-gradient(180deg,#d9e7fb_0%,#bad2f3_100%)] text-[#3e7fea]">
              <ClipboardCheck className="h-[20px] w-[20px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn(isMobileLayout ? 'text-[17px]' : 'text-[16px]', 'font-semibold leading-[1.1] text-[#1b2d50]')}>Lesson flow</p>
              <p className={cn(isMobileLayout ? 'text-[14px]' : 'text-[15px]', 'mt-[4px] leading-[1.5] text-[#5d6f8e]')}>
                Finish the lesson video, take the one-time CBT, then unlock the explanation video to complete this lesson flow.
              </p>
            </div>
          </div>

          <div className="mt-[14px] flex flex-wrap gap-[8px]">
            <span className="inline-flex items-center gap-[7px] rounded-full bg-[#eef4ff] px-[12px] py-[7px] text-[12px] font-medium text-[#46658f]">
              <Play className="ml-[1px] h-[12px] w-[12px] fill-current text-[#4a8ef5]" />
              Lesson video
            </span>
            <span className="inline-flex items-center gap-[7px] rounded-full bg-[#eef4ff] px-[12px] py-[7px] text-[12px] font-medium text-[#46658f]">
              <ClipboardCheck className="h-[12px] w-[12px] text-[#4a8ef5]" />
              One CBT attempt
            </span>
            <span className="inline-flex items-center gap-[7px] rounded-full bg-[#eef4ff] px-[12px] py-[7px] text-[12px] font-medium text-[#46658f]">
              <Video className="h-[12px] w-[12px] text-[#4a8ef5]" />
              Explanation once
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );

  const renderCourseView = () => (
    isMobileLayout ? (
      <div
        data-testid="course-figma-page"
        data-course-view="course"
        className="mobile-safe-screen min-h-[100dvh] overflow-x-hidden bg-[#f4f7ff] pb-[82px]"
        style={uiFontStyle}
      >
        <div className="mobile-safe-content mx-auto pb-[8px] pt-[9px]">

          <header>
            <div className="flex items-center justify-between gap-[12px]">
              <button
                type="button"
                data-testid="course-back-to-catalog"
                onClick={() => {
                  setScreen('catalog');
                  setSearchQuery('');
                }}
                className="flex h-[32px] w-[32px] items-center justify-center text-[#1f2d4e]"
              >
                <ChevronLeft className="h-[22px] w-[22px]" />
              </button>

              <h1 className="text-center text-[14px] font-semibold leading-[1.15] tracking-[-0.02em] text-[#1f2d4e]">
                {getMobileCourseTitle(selectedCourse)}
              </h1>

              <button
                type="button"
                className="flex h-[32px] w-[32px] items-center justify-center text-[#1f2d4e]"
              >
                <Search className="h-[19px] w-[19px]" />
              </button>
            </div>

            <div data-testid="course-figma-tabs" className="mt-[8px] grid grid-cols-3 border-b border-[#dde5f5] text-center">
              {(['Content', 'Syllabus', 'Resources'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setMobileCourseTab(tab)}
                  className={cn(
                    'relative py-[9px] text-[11.5px] font-medium text-[#5b6f98]',
                    mobileCourseTab === tab && 'font-semibold text-[#1b49d6]',
                  )}
                >
                  {tab}
                  {mobileCourseTab === tab && <span className="absolute bottom-0 left-[18px] right-[18px] h-[3px] rounded-full bg-[#2d6ee5]" />}
                </button>
              ))}
            </div>
          </header>

          <section
            data-testid="course-figma-hero"
            className="mt-[10px] rounded-[18px] border border-[#dbe4f3] bg-white px-[10px] py-[9px] shadow-[0_12px_24px_rgba(54,78,123,0.06)]"
          >
            {selectedCourse && !selectedCourseHasAccess ? (() => {
              const pricing = getCoursePricingMeta(selectedCourse);
              return (
                <div className="mb-[10px] rounded-[16px] border border-[#ffd9b6] bg-[linear-gradient(135deg,rgba(255,247,237,0.96)_0%,rgba(255,255,255,0.98)_100%)] px-[12px] py-[12px] shadow-[0_12px_26px_rgba(201,106,43,0.10)]">
                  <div className="flex items-start justify-between gap-[10px]">
                    <div>
                      {pricing.hasOffer ? (
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#c96a2b]">Offer price</p>
                      ) : null}
                      <p className="mt-[4px] text-[26px] font-bold leading-none text-[#17233d]">{currency.format(pricing.finalPrice)}</p>
                    </div>
                    {pricing.hasOffer && (
                      <span className="rounded-full bg-[#ffedd5] px-[10px] py-[6px] text-[11px] font-bold text-[#c96a2b]">
                        {pricing.offerPercentage}% OFF
                      </span>
                    )}
                  </div>
                  {pricing.hasOffer ? (
                    <div className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[11px]">
                      <span className="font-semibold text-[#7a8aa7] line-through decoration-[#c96a2b]/55">
                        {currency.format(pricing.basePrice)}
                      </span>
                      <span className="rounded-full bg-[#fff3e6] px-[8px] py-[3px] font-semibold text-[#c96a2b]">
                        Save {currency.format(pricing.savings)}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })() : null}
            <div className="grid grid-cols-[52px_repeat(3,minmax(0,1fr))_96px] items-center gap-[1px]">
              <div className="shrink-0">
                <ProgressDonut
                  percent={selectedCourseSnapshot.progressPercent}
                  title="Completed"
                  size={52}
                  testId="course-progress-percent"
                />
              </div>
              <div className="min-w-0 text-center">
                <p className="text-[14px] font-semibold leading-none text-[#1f2d4e]">{selectedCourseSnapshot.totalLessons}</p>
                <p className="mt-[2px] text-[8px] leading-none text-[#7b879d]">Lessons</p>
              </div>
              <div className="min-w-0 text-center">
                <p data-testid="course-progress-lessons-completed" className="text-[14px] font-semibold leading-none text-[#1f2d4e]">{selectedCourseVideoCompletedDisplayCount}</p>
                <p className="mt-[2px] text-[8px] leading-none text-[#7b879d]">Done</p>
              </div>
              <div className="min-w-0 text-center">
                <p className="text-[14px] font-semibold leading-none text-[#1f2d4e]">{Math.max(selectedCourseEntries.length - selectedCourseVideoCompletedDisplayCount, 0)}</p>
                <p className="mt-[2px] text-[8px] leading-none text-[#7b879d]">Left</p>
              </div>
              {selectedCourseHasAccess ? (
                <button
                  type="button"
                  onClick={() => selectedLessonEntry && openLesson(selectedLessonEntry.lesson.id)}
                  className="inline-flex h-[30px] w-full items-center justify-center rounded-[10px] bg-[#2f6fe4] px-[7px] text-[9.5px] font-semibold whitespace-nowrap text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
                >
                  {getCoursePrimaryActionLabel(selectedCourse, selectedCourseSnapshot.progressPercent)}
                </button>
              ) : (
                <span className="inline-flex h-[30px] w-full items-center justify-center rounded-[10px] bg-[#eef2f8] px-[7px] text-[9.5px] font-semibold whitespace-nowrap text-[#8a9ab3]">
                  Locked
                </span>
              )}
            </div>
            {selectedCourse && !selectedCourseHasAccess && (
              <div className="mt-[8px] flex justify-end">
                {renderCourseAccessActions(selectedCourse, 'mobile')}
              </div>
            )}
            {(courseAccessMessage || (!selectedCourseHasAccess && selectedCourse?.accessBlockReason)) && (
              <p className="mt-[8px] rounded-[10px] bg-[#f7faff] px-[9px] py-[7px] text-[10px] leading-5 text-[#516786]">
                {courseAccessMessage || selectedCourse?.accessBlockReason}
              </p>
            )}
          </section>

          {selectedLessonHasCbt ? (
            <div className="mt-[7px] flex items-center gap-[5px] overflow-x-auto px-[2px] pb-[2px] text-[9px] whitespace-nowrap text-[#516786] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="font-semibold text-[#1f2d4e]">Lesson Flow:</span>
              <span className="inline-flex items-center gap-[4px]"><Play className="h-[10px] w-[10px] fill-current text-[#2d6ee5]" /> Watch Video</span>
              <span className="text-[#9aabbe]">→</span>
              <span className="inline-flex items-center gap-[4px]"><ClipboardCheck className="h-[10px] w-[10px] text-[#2d6ee5]" /> Take CBT (1 Attempt)</span>
              <span className="text-[#9aabbe]">→</span>
              <span className="inline-flex items-center gap-[4px]"><Video className="h-[10px] w-[10px] text-[#2d6ee5]" /> View Explanation</span>
            </div>
          ) : null}

          {mobileCourseTab === 'Content' && (
            <div data-testid="course-figma-lessons" className="mt-[8px] space-y-[7px]">
              {filteredCourseSections.map((section, index) => {
                const expanded = currentExpandedSections.includes(section.id);
                const completedCount = section.lessons.filter((entry) => Boolean(selectedCourseProgressMap.get(entry.lesson.id)?.completed)).length;

                return (
                  <section
                    key={section.id}
                    data-testid={index === 0 ? 'course-figma-chapter-1' : undefined}
                    className="overflow-hidden rounded-[16px] border border-[#dbe4f3] bg-white shadow-[0_12px_24px_rgba(54,78,123,0.05)]"
                  >
                    <button
                      type="button"
                      data-testid={`course-figma-chapter-${index + 1}-toggle`}
                      onClick={() => toggleSection(section.id)}
                      className="flex w-full items-center justify-between gap-[10px] px-[11px] py-[10px] text-left"
                    >
                      <div className="min-w-0 flex items-center gap-[8px]">
                        <p className="text-[12.5px] font-semibold text-[#1f2d4e]">{section.label}</p>
                        <p className="truncate text-[11.5px] text-[#516786]">{section.title}</p>
                        </div>
                      <div className="flex shrink-0 items-center gap-[5px] text-[9px] text-[#5f7297]">
                        <span>{completedCount}/{section.lessons.length} Lessons</span>
                        <ChevronDown className={cn('h-[14px] w-[14px] transition', expanded ? 'rotate-180' : '')} />
                      </div>
                    </button>

                    {expanded && (
                      <div className="border-t border-[#edf2f8] px-[7px] py-[1px]">
                        {section.lessons.map((entry) => {
                          const progress = selectedCourseProgressMap.get(entry.lesson.id);
                          const unlocked = Boolean(unlockMap.get(entry.lesson.id)?.unlocked);
                          const lessonDone = hasLessonVideoMilestone(progress);
                          const lessonHasCbt = hasLessonCbtContent(entry.lesson);
                          const examDone = lessonHasCbt && Boolean(progress?.examSubmitted);
                          const explanationDone = lessonHasCbt && Boolean(progress?.completed || getExplanationWatchCount(progress) >= MAX_EXPLANATION_WATCHES);
                          const rows = [
                            {
                              key: `${entry.lesson.id}-lesson`,
                              icon: <Play className="ml-[1px] h-[16px] w-[16px] fill-current" />,
                              iconClass: 'text-[#2d6ee5]',
                              title: entry.lesson.title,
                              subtitle: formatDurationLabel(entry.lesson.durationMinutes),
                              status: explanationDone || lessonDone ? 'Completed' : unlocked ? 'Ready' : 'Locked',
                              onClick: unlocked ? () => openLesson(entry.lesson.id) : undefined,
                            },
                            ...(lessonHasCbt ? [{
                              key: `${entry.lesson.id}-cbt`,
                              icon: <ClipboardCheck className="h-[16px] w-[16px]" />,
                              iconClass: 'text-[#5b6f98]',
                              title: `CBT - ${section.label} (One Attempt)`,
                              subtitle: `${entry.lesson.cbt?.questions?.length || 0} Questions`,
                              status: examDone ? 'Completed' : lessonDone ? 'Ready' : 'Locked',
                              onClick: undefined,
                            }, {
                              key: `${entry.lesson.id}-explanation`,
                              icon: <Video className="h-[16px] w-[16px]" />,
                              iconClass: 'text-[#5b6f98]',
                              title: 'Explanation Video',
                              subtitle: '18 mins',
                              status: explanationDone ? 'Completed' : examDone ? 'Ready' : 'Locked',
                              onClick: undefined,
                            }] : []),
                          ] as const;

                          return rows.map((row, rowIndex) => (
                            <div key={row.key} className={cn('flex gap-[8px] px-[1px] py-[5px]', !(entry === section.lessons[section.lessons.length - 1] && rowIndex === rows.length - 1) && 'border-b border-[#eef2f8]')}>
                              <div className="flex w-[12px] flex-col items-center pt-[3px]">
                                <span
                                  className={cn(
                                    'h-[8px] w-[8px] rounded-full',
                                    row.status === 'Completed'
                                      ? 'bg-[#25ba74]'
                                      : row.status === 'Ready'
                                        ? 'bg-[#2d6ee5]'
                                        : 'bg-[#d2dceb]',
                                  )}
                                />
                              </div>

                              <button
                                type="button"
                                data-testid={row.onClick ? `course-lesson-open-${entry.lesson.id}` : undefined}
                                disabled={!row.onClick}
                                onClick={row.onClick}
                                className={cn(
                                  'flex min-w-0 flex-1 items-center gap-[8px] rounded-[14px] px-[2px] py-[2px] text-left',
                                  row.onClick ? 'cursor-pointer' : 'cursor-default',
                                )}
                              >
                                <div className={cn('flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full border border-[#dbe4f3] bg-[#f5f8fe]', row.iconClass)}>
                                  {row.icon}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-[11px] font-medium leading-[1.12] text-[#1f2d4e]">{row.title}</p>
                                  <p className="mt-[1px] text-[9px] text-[#7b879d]">{row.subtitle}</p>
                                </div>
                                <span
                                  className={cn(
                                    'inline-flex h-[20px] shrink-0 items-center rounded-full px-[6px] text-[8px] font-semibold',
                                    row.status === 'Completed'
                                      ? 'bg-[#e9f8ee] text-[#28a45e]'
                                      : row.status === 'Ready'
                                        ? 'bg-[#eef4ff] text-[#2d6ee5]'
                                        : 'bg-[#f1f4f9] text-[#8a9bb6]',
                                  )}
                                >
                                  {row.status}
                                </span>
                              </button>
                            </div>
                          ));
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}

          {mobileCourseTab === 'Syllabus' && (
            <div className="mt-[16px] space-y-[12px]">
              {selectedCourseSections.map((section) => (
                <section key={section.id} className="rounded-[18px] border border-[#dbe4f3] bg-white px-[16px] py-[16px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
                  <div className="flex items-center justify-between gap-[10px]">
                    <p className="text-[16px] font-semibold text-[#1f2d4e]">{section.label} {section.title}</p>
                    <span className="text-[13px] text-[#6f84ab]">{section.lessons.length} lessons</span>
                  </div>
                  <div className="mt-[10px] space-y-[8px]">
                    {section.lessons.map((entry) => (
                      <p key={entry.lesson.id} className="text-[14px] text-[#516786]">{entry.lesson.title}</p>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {mobileCourseTab === 'Resources' && (
            <div className="mt-[16px] space-y-[12px]">
              <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[16px] py-[16px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
                <p className="text-[16px] font-semibold text-[#1f2d4e]">Resources</p>
                <p className="mt-[8px] text-[14px] leading-[1.6] text-[#5d6f8e]">
                  Open any lesson in this course whenever you want. Resources stay aligned to the lesson you are viewing.
                </p>
              </section>
            </div>
          )}

          <section className="mt-[6px] rounded-[14px] border border-[#dbe4f3] bg-[#eef4ff] px-[10px] py-[8px] text-[10px] text-[#4b658f]">
            <div className="flex items-center gap-[8px]">
              <div className="flex h-[16px] w-[16px] items-center justify-center rounded-full border border-[#2d6ee5] text-[10px] text-[#2d6ee5]">i</div>
              <p>{selectedCourseHasAccess ? 'You can open any lesson directly from the course list.' : 'Unlock this course to watch lessons and sync progress.'}</p>
            </div>
          </section>
        </div>
      </div>
    ) : (
    <div
      data-testid="course-figma-page"
      data-course-view="course"
      className="overflow-hidden rounded-[26px] border border-white/70 bg-[linear-gradient(180deg,#f9fbff_0%,#eef3ff_100%)] shadow-[0_30px_90px_rgba(33,51,97,0.13)] xl:rounded-[30px]"
    >
      <header className="flex flex-col gap-[14px] border-b border-[#dde5f5] bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] px-[16px] py-[16px] xl:flex-row xl:items-center xl:justify-between xl:px-[24px] xl:py-[20px]">
        <button
          type="button"
          data-testid="course-back-to-catalog"
          onClick={() => {
            setScreen('catalog');
            setSearchQuery('');
          }}
          className="flex items-center gap-[10px] text-left text-[14px] text-[#5e7397] xl:text-[15px]"
        >
          <ChevronLeft className="h-[18px] w-[18px]" />
          <span>{['Courses', selectedCourse?.title].filter(Boolean).join(' / ')}</span>
        </button>
        <HeaderTools
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          placeholder="Search lessons..."
        />
      </header>

      <div className="grid gap-[14px] px-[14px] py-[14px] xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-[18px] xl:px-[24px] xl:py-[20px]">
        <div className="min-w-0">
          <section className="overflow-hidden rounded-[20px] border border-[#dbe4f3] bg-white shadow-[0_16px_34px_rgba(54,78,123,0.08)] xl:rounded-[24px]">
            <div
              data-testid="course-figma-hero"
              className={cn(
                'relative h-[160px] overflow-hidden xl:h-[220px]',
                selectedCourse && !selectedCourseHasAccess && 'xl:h-[290px]',
              )}
            >
              <img alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" src={selectedCourseVisual} />
              <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.18)_0%,rgba(255,255,255,0.06)_55%,rgba(255,255,255,0)_100%)]" />
              <div className="relative h-full px-[18px] pt-[18px] text-[#16264a] xl:px-[30px] xl:pt-[32px]">
                <h2 className="max-w-[280px] text-[24px] font-semibold leading-[1.08] tracking-[-0.03em] xl:max-w-[560px] xl:text-[32px] xl:leading-[1.12]">
                  {selectedCourse?.title}
                </h2>
                <div className="mt-[10px] flex items-center gap-[10px] text-[14px] text-[#24355a] xl:mt-[14px] xl:gap-[14px] xl:text-[16px]">
                  <span>{selectedCourseSnapshot.progressPercent}% Complete</span>
                  <div className="h-[8px] w-[138px] overflow-hidden rounded-full bg-[#cfdcf2] xl:h-[10px] xl:w-[180px]">
                    <div className={cn('h-full rounded-full', selectedToneStyles.progress)} style={{ width: `${selectedCourseSnapshot.progressPercent}%` }} />
                  </div>
                </div>
                {selectedCourse && !selectedCourseHasAccess ? (() => {
                  const pricing = getCoursePricingMeta(selectedCourse);
                  return (
                    <div className="mt-[16px] max-w-[360px] rounded-[16px] border border-[#ffd9b6] bg-[linear-gradient(135deg,rgba(255,247,237,0.94)_0%,rgba(255,255,255,0.96)_100%)] px-[14px] py-[12px] shadow-[0_12px_26px_rgba(201,106,43,0.10)] xl:mt-[18px]">
                      <div className="flex items-start justify-between gap-[10px]">
                        <div>
                          {pricing.hasOffer ? (
                            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#c96a2b]">Offer price</p>
                          ) : null}
                          <p className="mt-[4px] text-[28px] font-bold leading-none text-[#17233d]">{currency.format(pricing.finalPrice)}</p>
                        </div>
                        {pricing.hasOffer && (
                          <span className="rounded-full bg-[#ffedd5] px-[10px] py-[6px] text-[11px] font-bold text-[#c96a2b]">
                            {pricing.offerPercentage}% OFF
                          </span>
                        )}
                      </div>
                      {pricing.hasOffer ? (
                        <div className="mt-[8px] flex flex-wrap items-center gap-[8px] text-[11px]">
                          <span className="font-semibold text-[#7a8aa7] line-through decoration-[#c96a2b]/55">
                            {currency.format(pricing.basePrice)}
                          </span>
                          <span className="rounded-full bg-[#fff3e6] px-[8px] py-[3px] font-semibold text-[#c96a2b]">
                            Save {currency.format(pricing.savings)}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
                        {renderCourseAccessActions(selectedCourse, 'desktop')}
                        <span className="text-[11px] font-medium text-[#6c7f9f]">
                          Unlock this course to start lessons and linked mock tests.
                        </span>
                      </div>
                    </div>
                  );
                })() : null}
                <div className="mt-[16px] flex flex-wrap items-center gap-[10px] xl:mt-[28px]">
                  {selectedCourseHasAccess ? (
                    <button
                      type="button"
                      onClick={() => selectedLessonEntry && openLesson(selectedLessonEntry.lesson.id)}
                      className="inline-flex h-[38px] items-center gap-[8px] rounded-[11px] bg-[linear-gradient(180deg,#4487f4_0%,#2d6ee5_100%)] px-[16px] text-[13px] font-semibold text-white shadow-[0_14px_28px_rgba(45,110,229,0.24)] xl:h-[46px] xl:gap-[10px] xl:rounded-[12px] xl:px-[22px] xl:text-[15px]"
                    >
                      {getCoursePrimaryActionLabel(selectedCourse, selectedCourseSnapshot.progressPercent)}
                      <ChevronRight className="h-[16px] w-[16px]" />
                    </button>
                  ) : null}
                </div>
                {(courseAccessMessage || (!selectedCourseHasAccess && selectedCourse?.accessBlockReason)) && (
                  <p className="mt-[10px] inline-flex max-w-[520px] rounded-[12px] bg-white/82 px-[12px] py-[8px] text-[12px] leading-5 text-[#41597d]">
                    {courseAccessMessage || selectedCourse?.accessBlockReason}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-[10px] border-b border-[#e0e8f6] bg-white px-[14px] py-[14px] xl:flex-row xl:items-end xl:justify-between xl:px-[20px] xl:py-[18px]">
              <div data-testid="course-figma-tabs" className="flex gap-[20px] overflow-x-auto xl:gap-[26px]">
                {courseTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActiveCourseTab(tab)}
                    className={cn(
                      'relative pb-[8px] text-[15px] text-[#4c6086] xl:pb-[10px] xl:text-[16px]',
                      activeCourseTab === tab ? 'font-semibold text-[#16264a]' : 'font-medium',
                    )}
                  >
                    {tab}
                    {activeCourseTab === tab && <span className="absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-[#3c83ef]" />}
                  </button>
                ))}
              </div>

              {selectedCourseCbtEligibleCount > 0 ? (
                <div className="inline-flex h-[36px] items-center gap-[7px] rounded-[10px] border border-[#dbe4f3] bg-[#f7faff] px-[12px] text-[13px] text-[#5e7397] xl:h-[40px] xl:gap-[8px] xl:px-[14px] xl:text-[15px]">
                  <ClipboardCheck className="h-[15px] w-[15px]" />
                  {selectedCourseExamAttempts}/{selectedCourseCbtEligibleCount} CBT attempts
                </div>
              ) : null}
            </div>

            <div className="bg-[linear-gradient(180deg,#f6f9ff_0%,#eef4ff_100%)] px-[12px] py-[12px] xl:px-[14px] xl:py-[14px]">
              {activeCourseTab === 'Lessons' && renderLessonsTab()}
            </div>
          </section>
        </div>

        <aside data-testid="course-figma-sidebar" className="space-y-[12px]">
          <section data-testid="course-figma-stats" className="rounded-[18px] bg-white px-[16px] pb-[14px] pt-[14px] shadow-[0_16px_34px_rgba(54,78,123,0.08)] xl:rounded-[22px] xl:px-[18px] xl:pb-[14px] xl:pt-[16px]">
            <p className="text-[16px] font-medium text-[#1c2d4c] xl:text-[17px]">Course Statistics</p>
            <div className="mt-[14px] flex justify-center">
              <ProgressDonut percent={selectedCourseSnapshot.progressPercent} title="Completed" size={isMobileLayout ? 100 : 118} testId="course-progress-percent" />
            </div>
            <div className="mt-[14px] grid grid-cols-2 gap-y-[8px] px-[2px] text-[13px] text-[#5d7092] xl:px-[6px] xl:text-[14px]">
              <span data-testid="course-progress-lessons-completed">{selectedCourseVideoCompletedDisplayCount} Lessons</span>
              {selectedCourseCbtEligibleCount > 0 ? <span>{selectedCourseExamAttempts} CBT Done</span> : <span>Video only</span>}
              {selectedCourseCbtEligibleCount > 0 ? <span>{Math.max(selectedCourseCbtEligibleCount - selectedCourseExamAttempts, 0)} CBT Left</span> : <span>No CBT linked</span>}
              <span className="text-[#7a90b7]">{selectedCourseSnapshot.totalLessons} Total</span>
            </div>
          </section>

          <section data-testid="course-figma-note" className="rounded-[18px] bg-[#fbf3e5] px-[16px] py-[14px] shadow-[0_16px_34px_rgba(54,78,123,0.06)] xl:rounded-[22px] xl:px-[18px]">
            <div className="flex items-center gap-[8px] text-[14px] text-[#bf8646] xl:text-[15px]">
              <BookOpen className="h-[14px] w-[14px]" />
              <span>Pinned Note</span>
            </div>
            <h3 className="mt-[10px] text-[15px] font-medium leading-[1.24] text-[#202833] xl:text-[16px]">
              Basic concepts build the foundation
            </h3>
            <p className="mt-[8px] text-[13px] leading-[1.5] text-[#747980] xl:text-[14px] xl:leading-[1.42]">
              Use this course page to expand chapters, choose the next topic, and carry progress cleanly into the player without losing context.
            </p>
          </section>

          <section data-testid="course-figma-topics" className="rounded-[18px] bg-white px-[16px] py-[14px] shadow-[0_16px_34px_rgba(54,78,123,0.08)] xl:rounded-[22px] xl:px-[18px]">
            <p className="text-[15px] font-medium text-[#1c2d4c] xl:text-[16px]">Recommended Topics</p>
            <div className="mt-[12px] space-y-[10px]">
              {recommendedTopics.slice(0, 3).map((topic) => (
                <button
                  key={topic}
                  type="button"
                  onClick={() => selectedLessonEntry && openLesson(selectedLessonEntry.lesson.id)}
                  className="flex w-full items-center gap-[10px] text-left"
                >
                  <div className="flex h-[24px] w-[24px] items-center justify-center rounded-[7px] bg-[#dfeafb] text-[#4b86ea]">
                    <BookOpen className="h-[12px] w-[12px]" />
                  </div>
                  <p className="text-[14px] leading-[1.24] text-[#34486f] xl:text-[15px] xl:leading-[1.18]">{topic}</p>
                </button>
              ))}
            </div>
          </section>

          {!isMobileLayout && selectedLessonHasCbt && (
            <section data-testid="course-figma-recommended" className="overflow-hidden rounded-[22px] bg-white shadow-[0_16px_34px_rgba(54,78,123,0.08)]">
            <div className="flex h-[40px] items-center justify-between border-b border-[#edf2fb] px-[18px]">
              <div className="flex items-center gap-[8px] text-[15px] text-[#1c2d4c]">
                <span className="h-[14px] w-[14px] rounded-[4px] bg-[#62c2a4]" />
                <span>Recommended</span>
              </div>
              <div className="flex items-center gap-[6px]">
                <span className="h-[8px] w-[8px] rounded-full bg-[#d8e0f2]" />
                <span className="h-[8px] w-[8px] rounded-full bg-[#3d83ef]" />
                <span className="h-[8px] w-[8px] rounded-full bg-[#d8e0f2]" />
              </div>
            </div>
            <div className="px-[18px] py-[12px]">
              <p className="text-[15px] leading-[1.28] text-[#273852]">
                {selectedLessonCopy.quiz.prompt}
              </p>
              <div className="mt-[10px] flex items-center justify-between text-[13px] text-[#677b9e]">
                <div className="flex items-center gap-[6px]">
                  <Clock3 className="h-[13px] w-[13px]" />
                  <span>{Math.max(Math.round(selectedLessonVideoDurationSeconds / 60), 1)} mins{selectedLessonHasCbt ? ' + CBT' : ''}</span>
                </div>
                <button
                  type="button"
                  onClick={startLessonExam}
                  disabled={!isLessonReadyForExam}
                  className={cn(
                    'rounded-full px-[12px] py-[4px] text-[12px]',
                    isLessonReadyForExam
                      ? 'bg-[#e2ebfb] text-[#7086ab]'
                      : 'cursor-not-allowed bg-[#eef3fb] text-[#9caac1]',
                  )}
                >
                  Open CBT
                </button>
              </div>
            </div>
          </section>
          )}
        </aside>
      </div>
    </div>
    )
  );

  const renderDesktopFlowCompletePanel = () => (
    <div className="space-y-[18px]">
      <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-[58px] w-[58px] items-center justify-center rounded-full bg-[#18ad73] text-white shadow-[0_10px_20px_rgba(24,173,115,0.22)]">
            <CheckCircle2 className="h-[32px] w-[32px]" />
          </div>
          <p className="mt-[14px] text-[20px] font-semibold text-[#17233f]">Lesson Flow Completed</p>
          <p className="mt-[8px] max-w-[480px] text-[14px] leading-[1.48] text-[#5d7092]">
            Video, chapter CBT, and explanation are all completed for {selectedLessonEntry?.lesson.title}.
          </p>
        </div>

        <div className="mt-[18px] grid gap-[14px] lg:grid-cols-2">
          <div className="rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[16px] py-[16px]">
            <p className="text-[14px] font-semibold text-[#17305c]">Lesson Replay</p>
            <p className="mt-[6px] text-[13px] leading-[1.45] text-[#5d7092]">
              {hasReachedLessonVideoWatchLimit
                ? 'Maximum lesson video rewatch limit reached.'
                : `${selectedLessonVideoWatchCount}/${selectedLessonVideoWatchLimit} watches used. Replay remains available until the limit is reached.`}
            </p>
            {canRewatchLessonVideo ? (
              <button
                type="button"
                data-testid="course-player-rewatch-video"
                onClick={startLessonVideoReplay}
                className="mt-[14px] inline-flex h-[40px] w-full items-center justify-center rounded-[10px] border border-[#d7e3f5] bg-white text-[14px] font-semibold text-[#2d6ee5]"
              >
                Rewatch Lesson
              </button>
            ) : (
              <div data-testid="course-player-rewatch-limit" className="mt-[14px] inline-flex h-[34px] items-center rounded-full bg-[#eef3fb] px-[12px] text-[12px] font-medium text-[#7287a8]">
                Maximum limit reached
              </div>
            )}
          </div>

          <div className="rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[16px] py-[16px]">
            <p className="text-[14px] font-semibold text-[#17305c]">Explanation Status</p>
            <p className="mt-[6px] text-[13px] leading-[1.45] text-[#5d7092]">
              {hasReachedExplanationWatchLimit
                ? 'Explanation video watched once. Rewatch is no longer available.'
                : 'Explanation video is ready to watch once after the CBT.'}
            </p>
            <div className="mt-[14px] inline-flex h-[34px] items-center rounded-full bg-[#eef4ff] px-[12px] text-[12px] font-medium text-[#4b658f]">
              {hasReachedExplanationWatchLimit ? 'Maximum limit reached' : 'One-time watch'}
            </div>
          </div>
        </div>

        <div className="mt-[14px] rounded-[16px] border border-[#e3ebf6] bg-white px-[16px] py-[16px]">
          <div className="flex items-start gap-[10px]">
            <div className="mt-[2px] flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
              <Sparkles className="h-[14px] w-[14px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[#17305c]">What&apos;s Next?</p>
              <p className="mt-[4px] text-[14px] leading-[1.42] text-[#5d7092]">
                {nextLessonEntry
                  ? `Move to ${nextLessonEntry.lesson.title} and continue the same lesson → CBT → explanation sequence.`
                  : 'You have completed this lesson flow. Return to the course page and open any lesson you want.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="course-player-continue-next-lesson"
            onClick={() => {
              if (nextLessonEntry) {
                openNextLesson();
                return;
              }
              setScreen('course');
            }}
            className="mt-[16px] inline-flex h-[42px] w-full items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[14px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
          >
            {nextLessonEntry ? 'Open Next Lesson' : 'Back to Lessons'}
          </button>
        </div>
      </section>
    </div>
  );

  const renderDesktopCompletionPanel = () => (
    <div className="space-y-[18px]">
      <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
        <div className="flex flex-col items-center text-center">
          <div className="flex h-[58px] w-[58px] items-center justify-center rounded-full bg-[#18ad73] text-white shadow-[0_10px_20px_rgba(24,173,115,0.22)]">
            <CheckCircle2 className="h-[32px] w-[32px]" />
          </div>
          <p className="mt-[14px] text-[20px] font-semibold text-[#17233f]">Lesson Completed!</p>
          <p className="mt-[8px] max-w-[420px] text-[14px] leading-[1.48] text-[#5d7092]">
            Great job! You&apos;ve completed {selectedLessonEntry?.lesson.title}.
          </p>
        </div>

        <div className="mt-[18px] rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[16px] py-[16px]">
          <div className="flex items-start gap-[10px]">
            <div className="mt-[2px] flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
              <Sparkles className="h-[14px] w-[14px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[#17305c]">What&apos;s Next?</p>
              <p className="mt-[4px] text-[14px] leading-[1.42] text-[#5d7092]">
                {selectedLessonHasCbt
                  ? 'Take a CBT (Chapter Based Test) to test your understanding.'
                  : nextLessonEntry
                    ? `Open ${nextLessonEntry.lesson.title} when you are ready to continue.`
                    : 'Return to the lesson list and continue with any released lesson.'}
              </p>
            </div>
          </div>
          {selectedLessonHasCbt ? (
            <>
              <button
                type="button"
                data-testid="course-player-start-cbt"
                onClick={startLessonExam}
                className="mt-[16px] inline-flex h-[42px] w-full items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[14px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
              >
                Start CBT Exam
              </button>
              <div className="mt-[10px] flex items-center justify-center gap-[6px] text-[13px] text-[#6f84ab]">
                <span>One Attempt Only</span>
                <Clock3 className="h-[12px] w-[12px]" />
              </div>
            </>
          ) : (
            <button
              type="button"
              data-testid="course-player-continue-next-lesson"
              onClick={() => {
                if (nextLessonEntry) {
                  openNextLesson(true);
                  return;
                }
                setScreen('course');
              }}
              className="mt-[16px] inline-flex h-[42px] w-full items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[14px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
            >
              {nextLessonEntry ? 'Open Next Lesson' : 'Back to Lessons'}
            </button>
          )}

          <div className="mt-[14px] border-t border-[#e6edf8] pt-[14px]">
            <div className="flex items-start justify-between gap-[14px]">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-[#17305c]">Lesson Replay</p>
                <p className="mt-[4px] text-[13px] leading-[1.45] text-[#5d7092]">
                  {hasReachedLessonVideoWatchLimit
                    ? 'Maximum lesson video rewatch limit reached.'
                    : `${selectedLessonVideoWatchCount}/${selectedLessonVideoWatchLimit} watches used. Rewatch is still available before the limit is reached.`}
                </p>
              </div>
              {canRewatchLessonVideo ? (
                <button
                  type="button"
                  data-testid="course-player-rewatch-video"
                  onClick={startLessonVideoReplay}
                  className="inline-flex h-[38px] shrink-0 items-center justify-center rounded-[10px] border border-[#d7e3f5] bg-white px-[14px] text-[13px] font-semibold text-[#2d6ee5]"
                >
                  Rewatch Lesson
                </button>
              ) : (
                <span data-testid="course-player-rewatch-limit" className="inline-flex h-[32px] shrink-0 items-center rounded-full bg-[#eef3fb] px-[12px] text-[12px] font-medium text-[#7287a8]">
                  Limit reached
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-[14px] rounded-[16px] border border-[#e3ebf6] bg-white px-[16px] py-[16px]">
          <div className="flex items-center justify-between">
            <p className="text-[15px] font-semibold text-[#17233f]">Lesson Progress</p>
            <span className="text-[14px] font-medium text-[#2d6ee5]">100%</span>
          </div>
          <p className="mt-[6px] text-[14px] text-[#5d7092]">
            {selectedCourseVideoCompletedCount} of {selectedCourseSnapshot.totalLessons} lessons completed
          </p>
          <div className="mt-[10px] h-[6px] overflow-hidden rounded-full bg-[#d8e4f7]">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,#57a4ff_0%,#7ab8ff_100%)]"
              style={{ width: '100%' }}
            />
          </div>
        </div>
      </section>
    </div>
  );

  const renderVideoPanel = () => {
    const actualLessonMedia = renderActualLessonMedia('desktop');

    if (!isVideoReplayMode && selectedLessonStoredProgress?.completed) {
      return renderDesktopFlowCompletePanel();
    }

    if (!isVideoReplayMode && hasCompletedLessonVideo) {
      return renderDesktopCompletionPanel();
    }

    return (
    <div className="space-y-[18px]">
      <section
        ref={playerViewportRef}
        data-testid="course-figma-player"
        className={cn(
          'relative overflow-hidden rounded-[18px] border border-[#dde7f5] bg-[#d8e8ff] shadow-[0_12px_28px_rgba(46,67,111,0.08)]',
          isFullscreen && 'h-screen w-screen rounded-none border-0 bg-black shadow-none',
        )}
      >
        {actualLessonMedia ? (
          <div className={cn('bg-black', isFullscreen && 'flex h-full w-full items-center justify-center')}>
            {actualLessonMedia}
          </div>
        ) : (
          renderLessonMediaUnavailable('desktop')
        )}
        <button
          type="button"
          data-testid="course-player-fullscreen"
          onClick={() => void toggleFullscreen()}
          className="absolute right-[16px] top-[16px] inline-flex items-center gap-[8px] rounded-full border border-white/16 bg-black/52 px-[14px] py-[10px] text-[12px] font-semibold text-white shadow-[0_12px_30px_rgba(0,0,0,0.28)] backdrop-blur-sm transition hover:bg-black/68"
        >
          {isFullscreen ? <Minimize2 className="h-[14px] w-[14px]" /> : <Maximize2 className="h-[14px] w-[14px]" />}
          {isFullscreen ? 'Exit full screen' : 'Expand'}
        </button>
      </section>

      {renderLessonSupportSections('desktop')}

      <section className="grid gap-[14px] xl:grid-cols-[minmax(0,1.1fr)_260px]">
        <div className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[16px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#1b2d50]">About this lesson</p>
          <p className="mt-[10px] text-[15px] leading-[1.55] text-[#516786]">{selectedLessonCopy.about}</p>
        </div>
        <div className="grid gap-[12px] rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[16px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <div className="flex items-center gap-[10px] text-[15px] text-[#516786]">
            <Clock3 className="h-[18px] w-[18px] text-[#7a90b7]" />
            <span>{formatDurationLabel(selectedLessonEntry?.lesson.durationMinutes || 0)}</span>
          </div>
          <div className="flex items-center gap-[10px] text-[15px] text-[#516786]">
            <Video className="h-[18px] w-[18px] text-[#7a90b7]" />
            <span>{selectedCourse?.level || selectedLessonLabels[0] || 'Course Lesson'}</span>
          </div>
        </div>
      </section>

      <section className="grid gap-[14px] xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.7fr)]">
        <div className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[16px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#1b2d50]">Key Takeaways</p>
          <div className="mt-[14px] space-y-[10px]">
            {selectedLessonCopy.takeaways.map((point) => (
              <div key={point} className="flex items-start gap-[10px] text-[15px] leading-[1.48] text-[#32466c]">
                <CheckCircle2 className="mt-[2px] h-[18px] w-[18px] shrink-0 text-[#2d6ee5]" />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[16px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#1b2d50]">Need Help?</p>
          <p className="mt-[10px] text-[15px] leading-[1.55] text-[#516786]">
            {selectedLessonHasCbt
              ? 'Complete the lesson CBT after the video, then open the explanation to finish the lesson flow.'
              : 'This lesson currently has no linked CBT or explanation. Use the lesson video, notes, and doubts for this topic.'}
          </p>
          <div className="mt-[16px] flex flex-wrap gap-[10px]">
            {selectedLessonHasCbt ? (
              <>
                <button
                  type="button"
                  data-testid="course-player-start-cbt"
                  onClick={startLessonExam}
                  disabled={!isLessonReadyForExam}
                  className={cn(
                    'rounded-[10px] px-[16px] py-[10px] text-[14px] font-semibold transition',
                    isLessonReadyForExam
                      ? 'bg-[#2d6ee5] text-white'
                      : 'cursor-not-allowed border border-[#dbe4f3] bg-[#eef3fb] text-[#91a4c2]',
                  )}
                >
                  Open CBT Exam
                </button>
                <button
                  type="button"
                  data-testid="course-player-watch-explanation"
                  onClick={openLessonExplanation}
                  disabled={!isExplanationUnlocked}
                  className={cn(
                    'rounded-[10px] px-[16px] py-[10px] text-[14px] font-semibold transition',
                    isExplanationUnlocked
                      ? 'bg-[#103b91] text-white'
                      : 'cursor-not-allowed border border-[#dbe4f3] bg-[#eef3fb] text-[#91a4c2]',
                  )}
                >
                  Watch Explanation
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => scrollToLessonSection('course-lesson-doubts-section')}
              className="rounded-[10px] border border-[#dbe4f3] bg-white px-[16px] py-[10px] text-[14px] font-semibold text-[#2d6ee5]"
            >
              Ask Doubts
            </button>
          </div>
        </div>
      </section>
    </div>
  );
  };

  const renderQuizPanel = () => {
    return (
      <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[16px] font-semibold text-[#1b2d50]">{selectedLessonCopy.quiz.title}</p>
          <div className="flex gap-2 text-[12px] font-semibold text-[#607394]">
            <span className="rounded-full bg-[#eef4ff] px-3 py-1">{selectedLessonCopy.quiz.totalQuestions} Questions</span>
            <span className="rounded-full bg-[#eef4ff] px-3 py-1">{selectedLessonCopy.quiz.durationMinutes} Mins</span>
          </div>
        </div>
        <p className="mt-[10px] text-[15px] leading-[1.52] text-[#516786]">
          {selectedLessonExamSubmitted
            ? 'This CBT is already completed. Continue with the explanation step to finish the lesson flow.'
            : 'Start the CBT to open the full mock-test exam interface with instructions, declaration, timer, palette, and result flow.'}
        </p>

        <div className="mt-[18px] rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[16px] py-[16px]">
          <div className="flex items-start gap-[10px]">
            <div className="mt-[2px] flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
              <ClipboardCheck className="h-[14px] w-[14px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[#17305c]">
                {selectedLessonExamSubmitted ? 'CBT Submitted' : 'Open Full CBT Flow'}
              </p>
              <p className="mt-[4px] text-[14px] leading-[1.45] text-[#5d7092]">
                {selectedLessonExamSubmitted
                  ? 'Your attempt is recorded for this lesson path. Watch the explanation to complete the sequence.'
                  : 'This launches the same exam UI used by the full-length mock tests.'}
              </p>
            </div>
          </div>
          <div className="mt-[16px] flex flex-wrap gap-[10px]">
            {!selectedLessonExamSubmitted ? (
              <button
                type="button"
                data-testid="course-player-start-cbt"
                onClick={startLessonExam}
                disabled={!isLessonReadyForExam}
                className={cn(
                  'inline-flex h-[42px] items-center justify-center rounded-[10px] px-[16px] text-[14px] font-semibold',
                  isLessonReadyForExam
                    ? 'bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]'
                    : 'cursor-not-allowed border border-[#dbe4f3] bg-[#eef3fb] text-[#91a4c2]',
                )}
              >
                Start CBT Exam
              </button>
            ) : (
              <button
                type="button"
                data-testid="course-player-watch-explanation"
                onClick={openLessonExplanation}
                disabled={!canWatchExplanation}
                className={cn(
                  'inline-flex h-[42px] items-center justify-center rounded-[10px] px-[16px] text-[14px] font-semibold',
                  canWatchExplanation
                    ? 'bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]'
                    : 'cursor-not-allowed border border-[#dbe4f3] bg-[#eef3fb] text-[#91a4c2]',
                )}
              >
                Watch Explanation
              </button>
            )}
          </div>
        </div>
      </section>
    );
  };

  const renderExplanationPanel = () => {
    if (!selectedLessonExamSubmitted) {
      return (
        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[20px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#1b2d50]">Lesson Explanation</p>
          <p className="mt-[8px] text-[15px] leading-[1.55] text-[#516786]">
            Submit the chapter CBT to unlock the explanation video for this lesson.
          </p>
          <button
            type="button"
            onClick={startLessonExam}
            className="mt-[16px] inline-flex h-[42px] items-center gap-[8px] rounded-[12px] bg-[#2d6ee5] px-[16px] text-[14px] font-semibold text-white"
          >
            Open CBT Exam
          </button>
        </section>
      );
    }

    return (
      <div className="space-y-[14px]">
        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#1b2d50]">Lesson Explanation</p>
          <p className="mt-[6px] text-[14px] text-[#5d6f8e]">
            Review the answer and watch the explanation before moving to the next lesson.
          </p>
        </section>

        <section className="overflow-hidden rounded-[18px] border border-[#dbe4f3] bg-white shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <div className="relative min-h-[320px] bg-[#d8e8ff]">
            <img
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover"
              src={selectedCourseVisual}
            />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.12)_0%,rgba(14,35,72,0.66)_100%)]" />
            <div className="relative flex min-h-[320px] flex-col justify-between px-[20px] py-[18px] text-white">
              <div className="max-w-[420px]">
                <p className="text-[16px] font-semibold uppercase tracking-[0.18em] text-white/72">Explanation video</p>
                <h3 className="mt-[10px] text-[20px] font-semibold leading-[1.12] tracking-[-0.03em]">{selectedLessonCopy.quiz.explanation}</h3>
                <p className="mt-[10px] text-[15px] leading-[1.55] text-white/88">
                  The explanation is tied directly to the CBT attempt so the lesson ends with review, not a dead end.
                </p>
              </div>
              <div className="flex items-center justify-between gap-[12px] rounded-[16px] bg-black/20 px-[14px] py-[12px] backdrop-blur">
                <button
                  type="button"
                  data-testid="course-player-explanation-play"
                  onClick={() => setIsExplanationPlaying((current) => !current)}
                  className="flex h-[48px] w-[48px] items-center justify-center rounded-full bg-white text-[#1b49d6]"
                >
                  {isExplanationPlaying ? <Pause className="h-[22px] w-[22px] fill-current" /> : <Play className="ml-[2px] h-[22px] w-[22px] fill-current" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="h-[6px] overflow-hidden rounded-full bg-white/28">
                    <div
                      className="h-full rounded-full bg-[#69a6ff]"
                      style={{ width: `${Math.min((explanationPlaybackSeconds / selectedLessonExplanationDurationSeconds) * 100, 100)}%` }}
                    />
                  </div>
                  <div className="mt-[8px] flex items-center justify-between text-[13px] text-white/82">
                    <span>{formatPlaybackTime(explanationPlaybackSeconds)}</span>
                    <span>{formatPlaybackTime(selectedLessonExplanationDurationSeconds)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[18px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#1b2d50]">Why this answer is right</p>
          <div className="mt-[12px] space-y-[10px]">
            {selectedLessonCopy.takeaways.map((point) => (
              <div key={point} className="flex items-start gap-[10px] text-[15px] leading-[1.48] text-[#32466c]">
                <CheckCircle2 className="mt-[2px] h-[18px] w-[18px] shrink-0 text-[#2d6ee5]" />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  };

  const scrollToLessonSection = (sectionId: string) => {
    if (typeof document === 'undefined') {
      return;
    }

    const section = document.getElementById(sectionId);
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submitLessonDoubt = async () => {
    if (!selectedCourse?._id || !selectedLessonEntry) {
      return;
    }

    const message = activeLessonDoubtDraft.trim();
    if (!message || sendingLessonDoubt) {
      return;
    }

    setSendingLessonDoubt(true);
    setLessonDoubtError(null);
    setLessonDoubtSuccess(null);

    try {
      const response = await EduService.postLessonDoubtMessage(selectedCourse._id, selectedLessonEntry.lesson.id, {
        message,
        threadId: lessonDoubtViewerRole === 'admin' ? activeLessonDoubtThread?._id || null : null,
      });

      setLessonDoubtThreads((current) => {
        const remaining = current.filter((thread) => thread._id !== response.thread._id);
        return [response.thread, ...remaining].sort(
          (left, right) => new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime(),
        );
      });
      setSelectedLessonDoubtThreadId(response.thread._id);
      setLessonDoubtDrafts((current) => ({
        ...current,
        [activeLessonDoubtDraftKey]: '',
      }));
      setLessonDoubtSuccess(response.message || 'Question sent successfully');
      void onRefresh();
    } catch (error) {
      setLessonDoubtError(error instanceof Error ? error.message : 'Unable to send this message right now.');
    } finally {
      setSendingLessonDoubt(false);
    }
  };

  const submitLessonReport = async () => {
    if (!selectedCourse?._id || !selectedLessonEntry || sendingLessonReport) {
      return;
    }

    const lessonId = selectedLessonEntry.lesson.id;
    const description = String(lessonReportDrafts[lessonId] || '').trim();
    const issueType = lessonReportIssueTypes[lessonId] || 'other';
    if (!description) {
      setLessonReportError('Please describe the issue before sending the report.');
      setLessonReportSuccess(null);
      return;
    }

    setSendingLessonReport(true);
    setLessonReportError(null);
    setLessonReportSuccess(null);

    try {
      const response = await EduService.postLessonReport(selectedCourse._id, lessonId, {
        issueType,
        description,
        pageUrl: typeof window !== 'undefined' ? window.location.href : null,
      });
      setLessonReportsByLesson((current) => ({
        ...current,
        [lessonId]: [response.report, ...(current[lessonId] || []).filter((item) => item._id !== response.report._id)],
      }));
      pendingLessonReportIdRef.current = response.report._id;
      setLessonReportDrafts((current) => ({ ...current, [lessonId]: '' }));
      setLessonReportSuccess(`Report submitted successfully. Ticket ${response.report._id}`);
      void onRefresh();
    } catch (error) {
      setLessonReportError(error instanceof Error ? error.message : 'Unable to submit this report right now.');
    } finally {
      setSendingLessonReport(false);
    }
  };

  const toggleSupportPanel = (panel: Exclude<LessonSupportPanel, null>) => {
    setExpandedSupportPanel((current) => (current === panel ? null : panel));
  };

  const renderLessonNotesSection = (layout: 'desktop' | 'mobile') => {
    if (!selectedLessonEntry) {
      return null;
    }

    const isDesktop = layout === 'desktop';
    const isExpanded = expandedSupportPanel === 'notes';

    return (
      <section
        id="course-lesson-notes-section"
        data-testid="course-lesson-notes-section"
        data-state={isExpanded ? 'expanded' : 'collapsed'}
        className={cn(
          'rounded-[18px] border bg-white shadow-[0_12px_24px_rgba(54,78,123,0.05)] transition',
          isExpanded ? 'border-[#bdd2fb] bg-[#fbfdff]' : 'border-[#dbe4f3]',
          isDesktop ? 'px-[18px] py-[18px]' : 'px-[14px] py-[14px]',
        )}
      >
        <button
          type="button"
          onClick={() => toggleSupportPanel('notes')}
          className="flex w-full items-start justify-between gap-[10px] text-left"
        >
        <div className="flex items-start gap-[10px]">
          <div className="mt-[2px] flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
            <FileText className="h-[14px] w-[14px]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className={cn(isDesktop ? 'text-[16px]' : 'text-[14px]', 'font-semibold text-[#17305c]')}>Notes</p>
            <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'mt-[4px] leading-[1.45] text-[#5d7092]')}>
              {isExpanded ? 'Revision notes are open under the video.' : 'Expand notes only when you want a quick recap.'}
            </p>
          </div>
        </div>
          <span className="rounded-full border border-[#dbe4f3] bg-white px-[12px] py-[6px] text-[11px] font-semibold text-[#2d6ee5]">
            {isExpanded ? 'Collapse' : 'Expand'}
          </span>
        </button>

        {isExpanded && (
          <>
            <div className={cn('mt-[14px]', isDesktop ? 'space-y-[10px]' : 'space-y-[8px]')}>
              {selectedLessonCopy.notes.map((note) => (
                <div
                  key={note.title}
                  className={cn(
                    'rounded-[14px] bg-[#fbfdff]',
                    isDesktop ? 'px-[14px] py-[14px]' : 'px-[12px] py-[12px]',
                  )}
                >
                  <p className={cn(isDesktop ? 'text-[14px]' : 'text-[13px]', 'font-semibold text-[#1b2d50]')}>{note.title}</p>
                  <p className={cn(isDesktop ? 'text-[14px]' : 'text-[12px]', 'mt-[6px] leading-[1.55] text-[#516786]')}>
                    {note.body}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-[14px] rounded-[14px] border border-[#e3ebf6] bg-[#f6f9ff] px-[14px] py-[12px]">
              <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'font-semibold text-[#17305c]')}>Quick Tip</p>
              <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'mt-[4px] leading-[1.5] text-[#5d7092]')}>
                {selectedLessonCopy.quickTip}
              </p>
            </div>
          </>
        )}
      </section>
    );
  };

  const renderLessonDoubtsSection = (layout: 'desktop' | 'mobile') => {
    if (!selectedLessonEntry) {
      return null;
    }

    const isDesktop = layout === 'desktop';
    const isExpanded = expandedSupportPanel === 'doubts';
    const isAdminViewer = lessonDoubtViewerRole === 'admin';
    const threadList = lessonDoubtThreads;
    const activeThread = activeLessonDoubtThread;
    const draft = activeLessonDoubtDraft;
    const canSend = Boolean(draft.trim()) && !sendingLessonDoubt && (!isAdminViewer || Boolean(activeThread));
    const threadTitle = isAdminViewer ? 'Student Questions' : 'Lesson Clarification';

    return (
      <section
        id="course-lesson-doubts-section"
        data-testid="course-lesson-doubts-section"
        data-state={isExpanded ? 'expanded' : 'collapsed'}
        className={cn(
          'rounded-[18px] border bg-white shadow-[0_12px_24px_rgba(54,78,123,0.05)] transition',
          isExpanded ? 'border-[#bdd2fb] bg-[#fbfdff]' : 'border-[#dbe4f3]',
          isDesktop ? 'px-[18px] py-[18px]' : 'px-[14px] py-[14px]',
        )}
      >
        <button
          type="button"
          data-testid="lesson-doubt-open-button"
          onClick={() => toggleSupportPanel('doubts')}
          className="flex w-full items-start justify-between gap-[10px] text-left"
        >
        <div className="flex items-start gap-[10px]">
          <div className="mt-[2px] flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
            <MessageSquare className="h-[14px] w-[14px]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className={cn(isDesktop ? 'text-[16px]' : 'text-[14px]', 'font-semibold text-[#17305c]')}>{threadTitle}</p>
            <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'mt-[4px] leading-[1.45] text-[#5d7092]')}>
              {isExpanded
                ? isAdminViewer
                  ? 'Select a learner thread and reply right from this lesson.'
                  : selectedLessonCopy.discussionPrompt
                : 'Open the lesson question thread only when you need it.'}
            </p>
          </div>
        </div>
          <span className="rounded-full border border-[#dbe4f3] bg-white px-[12px] py-[6px] text-[11px] font-semibold text-[#2d6ee5]">
            {isExpanded ? 'Collapse' : 'Expand'}
          </span>
        </button>

        {isExpanded && (
          <>
            {isAdminViewer && threadList.length > 0 && (
              <div data-testid="lesson-doubt-thread-list" className={cn('mt-[14px] grid gap-[10px]', isDesktop ? 'grid-cols-2' : 'grid-cols-1')}>
                {threadList.map((thread) => {
                  const active = thread._id === activeThread?._id;
                  return (
                    <button
                      key={thread._id}
                      type="button"
                      data-testid="admin-lesson-doubt-row"
                      onClick={() => setSelectedLessonDoubtThreadId(thread._id)}
                      className={cn(
                        'rounded-[14px] border px-[14px] py-[12px] text-left transition',
                        active
                          ? 'border-[#b9cdf7] bg-[#eef5ff] shadow-[0_12px_24px_rgba(45,110,229,0.08)]'
                          : 'border-[#dbe4f3] bg-white hover:border-[#c9daf8] hover:bg-[#f8fbff]',
                      )}
                    >
                      <div className="flex items-center justify-between gap-[10px]">
                        <p className="text-[13px] font-semibold text-[#17305c]">{thread.studentName}</p>
                        <span className="rounded-full bg-white/80 px-[10px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#2d6ee5]">
                          {thread.status}
                        </span>
                      </div>
                      <p className="mt-[6px] text-[12px] leading-[1.5] text-[#607394] line-clamp-2">{thread.lastMessagePreview || 'Open this thread to reply.'}</p>
                      <p className="mt-[6px] text-[10px] font-medium uppercase tracking-[0.08em] text-[#8aa0b8]">{thread.pathLabel}</p>
                    </button>
                  );
                })}
              </div>
            )}

            <div data-testid="lesson-doubt-message-list" className={cn('mt-[14px]', isDesktop ? 'space-y-[10px]' : 'space-y-[8px]')}>
              {loadingLessonDoubts && threadList.length === 0 && (
                <div data-testid="lesson-doubt-loading" className="flex items-center gap-[8px] rounded-[14px] border border-[#dbe4f3] bg-[#f9fbff] px-[14px] py-[12px] text-[13px] text-[#5d7092]">
                  <LoaderCircle className="h-[16px] w-[16px] animate-spin text-[#2d6ee5]" />
                  Loading lesson conversation...
                </div>
              )}

              {!loadingLessonDoubts && !activeThread && (
                <div data-testid="lesson-doubt-empty-state" className="rounded-[14px] border border-dashed border-[#dbe4f3] bg-[#fbfdff] px-[14px] py-[12px] text-[13px] leading-[1.55] text-[#607394]">
                  {isAdminViewer
                    ? 'No student questions have been posted for this video yet.'
                    : 'Ask your first question and the admin will get notified with this lesson path.'}
                </div>
              )}

              {activeThread?.messages.map((message) => {
                const isSelf = String(message.userId || '') === String(user?._id || '');
                return (
                  <div
                    key={message._id}
                    data-testid={message.role === 'admin' ? 'lesson-doubt-admin-reply' : 'lesson-doubt-user-message'}
                    className={cn(
                      'rounded-[14px] px-[14px] py-[12px]',
                      isSelf ? 'ml-auto bg-[#edf7ff]' : 'bg-[#f6f9ff]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-[10px]">
                      <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'font-semibold text-[#1f2d4e]')}>
                        {message.userName}{message.role === 'admin' ? ' • Admin' : ''}
                      </p>
                      <span className={cn(isDesktop ? 'text-[11px]' : 'text-[10px]', 'text-[#8aa0b8]')}>
                        {formatLessonDoubtTime(message.createdAt)}
                      </span>
                    </div>
                    <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'mt-[6px] leading-[1.55] text-[#5c708d]')}>
                      {message.message}
                    </p>
                  </div>
                );
              })}
            </div>

            {lessonDoubtError && (
              <div data-testid="lesson-doubt-error" className="mt-[12px] rounded-[14px] border border-[#ffd2d2] bg-[#fff6f6] px-[14px] py-[12px] text-[12px] leading-[1.5] text-[#b24141]">
                {lessonDoubtError}
              </div>
            )}
            {lessonDoubtSuccess && (
              <div data-testid="lesson-doubt-success-toast" className="mt-[12px] rounded-[14px] border border-[#cdecd8] bg-[#f4fff7] px-[14px] py-[12px] text-[12px] leading-[1.5] text-[#227a42]">
                {lessonDoubtSuccess}
              </div>
            )}

            <div data-testid="lesson-doubt-panel" className="mt-[14px] flex items-center gap-[8px] rounded-[14px] border border-[#dbe4f3] bg-[#f9fbff] px-[12px] py-[10px]">
              <input
                data-testid="lesson-doubt-input"
                type="text"
                value={draft}
                onChange={(event) => setLessonDoubtDrafts((current) => ({
                  ...current,
                  [activeLessonDoubtDraftKey]: event.target.value,
                }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitLessonDoubt();
                  }
                }}
                placeholder={isAdminViewer ? 'Reply to this learner...' : 'Type your doubt...'}
                disabled={sendingLessonDoubt || (isAdminViewer && !activeThread)}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[#20314b] outline-none placeholder:text-[#8aa0b8]"
              />
              <button
                type="button"
                data-testid="lesson-doubt-send-button"
                onClick={() => void submitLessonDoubt()}
                disabled={!canSend}
                className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-[#2d6ee5] text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sendingLessonDoubt ? <LoaderCircle className="h-[15px] w-[15px] animate-spin" /> : <Send className="h-[15px] w-[15px]" />}
              </button>
            </div>
            {activeThread?._id && (
              <div data-testid="lesson-doubt-thread-id" className="sr-only">{activeThread._id}</div>
            )}
          </>
        )}
      </section>
    );
  };

  const renderLessonReportSection = (layout: 'desktop' | 'mobile') => {
    if (!selectedLessonEntry) {
      return null;
    }

    const isDesktop = layout === 'desktop';
    const lessonId = selectedLessonEntry.lesson.id;
    const draft = lessonReportDrafts[lessonId] || '';
    const issueType = lessonReportIssueTypes[lessonId] || 'other';
    const isExpanded = expandedSupportPanel === 'report';

    return (
      <section
        data-testid="lesson-report-panel"
        data-state={isExpanded ? 'expanded' : 'collapsed'}
        className={cn(
          'rounded-[18px] border bg-white shadow-[0_12px_24px_rgba(54,78,123,0.05)] transition',
          isExpanded ? 'border-[#bdd2fb] bg-[#fbfdff]' : 'border-[#dbe4f3]',
          isDesktop ? 'px-[18px] py-[18px]' : 'px-[14px] py-[14px]',
        )}
      >
        <button
          type="button"
          data-testid="lesson-report-open-button"
          onClick={() => toggleSupportPanel('report')}
          className="flex w-full items-start justify-between gap-[10px] text-left"
        >
          <div className="flex items-start gap-[10px]">
            <div className="mt-[2px] flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-[#fff3ea] text-[#d46b23]">
              <AlertTriangle className="h-[14px] w-[14px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn(isDesktop ? 'text-[16px]' : 'text-[14px]', 'font-semibold text-[#17305c]')}>Report Issue</p>
              <p className={cn(isDesktop ? 'text-[13px]' : 'text-[12px]', 'mt-[4px] leading-[1.45] text-[#5d7092]')}>
                Flag playback, audio, lesson, or access issues with a persistent ticket.
              </p>
            </div>
          </div>
          <span className="rounded-full border border-[#dbe4f3] bg-white px-[12px] py-[6px] text-[11px] font-semibold text-[#d46b23]">
            {isExpanded ? 'Collapse' : 'Expand'}
          </span>
        </button>

        {isExpanded && (
          <div className="mt-[14px] space-y-[12px]">
            <select
              data-testid="lesson-report-issue-type"
              value={issueType}
              onChange={(event) => setLessonReportIssueTypes((current) => ({ ...current, [lessonId]: event.target.value as LessonReportIssueType }))}
              className="h-[44px] w-full rounded-[14px] border border-[#d7e3f2] bg-[#f8fbff] px-[12px] text-[13px] text-[#17233d] outline-none"
            >
              {LESSON_REPORT_ISSUE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <textarea
              data-testid="lesson-report-description"
              value={draft}
              onChange={(event) => {
                setLessonReportSuccess(null);
                setLessonReportDrafts((current) => ({ ...current, [lessonId]: event.target.value }));
              }}
              placeholder="Describe the issue in detail..."
              className="h-[110px] w-full resize-none rounded-[14px] border border-[#d7e3f2] bg-[#f8fbff] px-[12px] py-[10px] text-[13px] leading-5 text-[#17233d] outline-none placeholder:text-[#8ba0bb]"
            />
            {lessonReportError && (
              <div data-testid="lesson-report-error" className="rounded-[14px] border border-[#ffd2d2] bg-[#fff6f6] px-[14px] py-[12px] text-[12px] text-[#b24141]">
                {lessonReportError}
              </div>
            )}
            {lessonReportSuccess && (
              <div data-testid="lesson-report-success" className="rounded-[14px] border border-[#cdecd8] bg-[#f4fff7] px-[14px] py-[12px] text-[12px] text-[#227a42]">
                {lessonReportSuccess}
              </div>
            )}
            <button
              type="button"
              data-testid="lesson-report-submit-button"
              onClick={() => void submitLessonReport()}
              disabled={!draft.trim() || sendingLessonReport}
              className="flex h-[42px] w-full items-center justify-center rounded-[14px] bg-[#2f6fe4] text-[13px] font-bold text-white shadow-[0_10px_20px_rgba(47,111,228,0.20)] disabled:cursor-not-allowed disabled:bg-[#b8c6d8]"
            >
              {sendingLessonReport ? <LoaderCircle data-testid="lesson-report-loading" className="h-[15px] w-[15px] animate-spin" /> : 'Submit report'}
            </button>
            <div data-testid="lesson-report-my-list" className="space-y-[8px]">
              {activeLessonReports.length === 0 ? (
                <div className="rounded-[14px] border border-dashed border-[#dbe4f3] bg-[#fbfdff] px-[14px] py-[12px] text-[12px] leading-[1.5] text-[#607394]">
                  No reports have been submitted for this lesson by this learner yet.
                </div>
              ) : activeLessonReports.map((report) => (
                <div key={report._id} data-testid="lesson-report-row" className="rounded-[14px] border border-[#e7edf7] bg-[#fbfdff] px-[14px] py-[12px]">
                  <div className="flex items-center justify-between gap-[10px]">
                    <p data-testid="lesson-report-ticket-id" className="text-[12px] font-semibold text-[#17305c]">{report._id}</p>
                    <span className="rounded-full bg-white px-[10px] py-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#d46b23]">{report.status}</span>
                  </div>
                  <p className="mt-[6px] text-[12px] leading-[1.5] text-[#607394]">{report.description}</p>
                  {report.adminReply && <p className="mt-[6px] text-[12px] font-medium text-[#227a42]">Reply: {report.adminReply}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    );
  };

  const renderLessonSupportSections = (layout: 'desktop' | 'mobile') => (
    <div
      className={cn(
        'grid gap-[14px]',
        layout === 'desktop' ? 'xl:grid-cols-3' : 'grid-cols-1',
      )}
    >
      {renderLessonNotesSection(layout)}
      {renderLessonDoubtsSection(layout)}
      {renderLessonReportSection(layout)}
    </div>
  );

  const renderMobileSupportTabs = () => {
    if (!selectedLessonEntry) {
      return null;
    }

    const isAdminViewer = lessonDoubtViewerRole === 'admin';
    const thread = activeLessonDoubtThread?.messages || [];
    const draft = activeLessonDoubtDraft;
    return (
      <section className="overflow-hidden rounded-[20px] border border-[#dfe7f4] bg-white shadow-[0_14px_28px_rgba(54,78,123,0.06)]">
        <div className="grid grid-cols-2 border-b border-[#e7edf7]">
          {([
            ['notes', 'Notes', FileText],
            ['doubts', 'Doubts', MessageSquare],
          ] as const).map(([tabId, label, Icon]) => {
            const active = mobileSupportTab === tabId;
            return (
              <button
                key={tabId}
                type="button"
                onClick={() => setMobileSupportTab(tabId)}
                className={cn(
                  'relative flex h-[56px] items-center justify-center gap-[8px] text-[14px] font-semibold transition',
                  active ? 'text-[#1f6fff]' : 'text-[#7d8eac]',
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span>{label}</span>
                {active && <span className="absolute inset-x-[20px] bottom-0 h-[3px] rounded-full bg-[#2f7ef7]" />}
              </button>
            );
          })}
        </div>

        <div
          id="course-lesson-notes-section"
          data-testid="course-lesson-notes-section"
          data-state={mobileSupportTab === 'notes' ? 'expanded' : 'collapsed'}
          className={cn('px-[14px] py-[14px]', mobileSupportTab !== 'notes' && 'hidden')}
        >
          <div className="space-y-[10px]">
            {selectedLessonCopy.notes.map((note, index) => (
              <div
                key={note.title}
                className="flex items-start gap-[12px] rounded-[16px] border border-[#edf2fa] bg-[#fcfdff] px-[12px] py-[12px]"
              >
                <div
                  className={cn(
                    'mt-[2px] flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[14px]',
                    index % 2 === 0 ? 'bg-[#edf4ff] text-[#2d6ee5]' : 'bg-[#ecfbf2] text-[#1fa45d]',
                  )}
                >
                  <FileText className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold leading-[1.35] text-[#17233f]">{note.title}</p>
                  <p className="mt-[4px] text-[12px] leading-[1.55] text-[#607394]">{note.body}</p>
                  <p className="mt-[6px] text-[11px] font-medium text-[#7a8faf]">Available for this lesson</p>
                </div>
              </div>
            ))}
          </div>

        </div>

        <div
          id="course-lesson-doubts-section"
          data-testid="course-lesson-doubts-section"
          data-state={mobileSupportTab === 'doubts' ? 'expanded' : 'collapsed'}
          className={cn('px-[14px] py-[14px]', mobileSupportTab !== 'doubts' && 'hidden')}
        >
          {isAdminViewer && lessonDoubtThreads.length > 0 && (
            <div data-testid="lesson-doubt-thread-list" className="mb-[12px] space-y-[8px]">
              {lessonDoubtThreads.map((threadItem) => {
                const active = threadItem._id === activeLessonDoubtThread?._id;
                return (
                  <button
                    key={threadItem._id}
                    type="button"
                    data-testid="admin-lesson-doubt-row"
                    onClick={() => setSelectedLessonDoubtThreadId(threadItem._id)}
                    className={cn(
                      'w-full rounded-[14px] border px-[12px] py-[10px] text-left',
                      active ? 'border-[#cfe0ff] bg-[#eef5ff]' : 'border-[#e2ebf6] bg-[#fbfdff]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-[10px]">
                      <p className="text-[13px] font-semibold text-[#17305c]">{threadItem.studentName}</p>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#2f6fe4]">{threadItem.status}</span>
                    </div>
                    <p className="mt-[4px] text-[11px] leading-[1.45] text-[#607394] line-clamp-2">{threadItem.lastMessagePreview}</p>
                  </button>
                );
              })}
            </div>
          )}
          <div data-testid="lesson-doubt-message-list" className="max-h-[240px] space-y-[10px] overflow-y-auto pr-[4px]">
            {loadingLessonDoubts && !activeLessonDoubtThread && (
              <div data-testid="lesson-doubt-loading" className="flex items-center gap-[8px] rounded-[16px] border border-[#dce7f6] bg-[#f8fbff] px-[12px] py-[12px] text-[13px] leading-6 text-[#607394]">
                <LoaderCircle className="h-[15px] w-[15px] animate-spin text-[#2f6fe4]" />
                Loading discussion...
              </div>
            )}
            {!loadingLessonDoubts && thread.length === 0 && (
              <div data-testid="lesson-doubt-empty-state" className="rounded-[16px] border border-dashed border-[#dce7f6] bg-[#f8fbff] px-[12px] py-[12px] text-[13px] leading-6 text-[#607394]">
                {isAdminViewer
                  ? 'No student questions have been posted for this lesson yet.'
                  : 'No doubts have been posted for this lesson yet.'}
              </div>
            )}
            {thread.map((message) => (
              <div
                key={message._id}
                data-testid={message.role === 'admin' ? 'lesson-doubt-admin-reply' : 'lesson-doubt-user-message'}
                className={cn(
                  'rounded-[16px] border px-[12px] py-[12px]',
                  String(message.userId || '') === String(user?._id || '')
                    ? 'ml-[22px] border-[#d8e7ff] bg-[#eef5ff]'
                    : 'border-[#edf2fa] bg-[#fcfdff]',
                )}
              >
                <div className="flex items-center justify-between gap-[12px]">
                  <p className="text-[13px] font-semibold text-[#1f2d4e]">{message.userName}{message.role === 'admin' ? ' • Admin' : ''}</p>
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[#8ca0bc]">{formatLessonDoubtTime(message.createdAt)}</span>
                </div>
                <p className="mt-[6px] text-[12px] leading-[1.55] text-[#607394]">{message.message}</p>
              </div>
            ))}
          </div>

          {lessonDoubtError && (
            <div data-testid="lesson-doubt-error" className="mt-[12px] rounded-[16px] border border-[#ffd2d2] bg-[#fff6f6] px-[12px] py-[12px] text-[12px] leading-5 text-[#b24141]">
              {lessonDoubtError}
            </div>
          )}
          {lessonDoubtSuccess && (
            <div data-testid="lesson-doubt-success-toast" className="mt-[12px] rounded-[16px] border border-[#cdecd8] bg-[#f4fff7] px-[12px] py-[12px] text-[12px] leading-5 text-[#227a42]">
              {lessonDoubtSuccess}
            </div>
          )}

          <div data-testid="lesson-doubt-panel" className="mt-[12px] rounded-[16px] border border-[#dbe4f3] bg-[#f9fbff] px-[12px] py-[12px]">
            <p className="text-[12px] font-semibold text-[#17305c]">{isAdminViewer ? 'Reply in this thread' : 'Ask a quick doubt'}</p>
            <div className="mt-[10px] flex items-center gap-[8px]">
              <input
                data-testid="lesson-doubt-input"
                type="text"
                value={draft}
                onChange={(event) => setLessonDoubtDrafts((current) => ({
                  ...current,
                  [activeLessonDoubtDraftKey]: event.target.value,
                }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitLessonDoubt();
                  }
                }}
                placeholder={isAdminViewer ? 'Reply to this learner...' : 'Type your doubt...'}
                disabled={sendingLessonDoubt || (isAdminViewer && !activeLessonDoubtThread)}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[#20314b] outline-none placeholder:text-[#8aa0b8]"
              />
              <button
                type="button"
                data-testid="lesson-doubt-send-button"
                onClick={() => void submitLessonDoubt()}
                disabled={!draft.trim() || sendingLessonDoubt || (isAdminViewer && !activeLessonDoubtThread)}
                className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-[#2d6ee5] text-white shadow-[0_8px_18px_rgba(45,110,229,0.24)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sendingLessonDoubt ? <LoaderCircle className="h-[16px] w-[16px] animate-spin" /> : <Send className="h-[16px] w-[16px]" />}
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  };

  const renderMobileLessonView = () => {
    const mobileMode: MobileLessonStage =
      activeLessonTab === 'CBT Exam'
        ? mobileLessonStageOverride || 'exam'
        : activeLessonTab === 'Explanation'
          ? mobileLessonStageOverride || 'explanation'
          : 'watch';
    const actualLessonMedia = renderActualLessonMedia('mobile');

    const renderMobileVideoPill = () => (
      <div className="flex items-center justify-between gap-[10px]">
        <button
          type="button"
          data-testid="course-player-tab-video"
          onClick={() => handleLessonTabSelect('Video')}
          className={cn(
            'inline-flex h-[30px] items-center rounded-full px-[12px] text-[12px] font-semibold transition',
            activeLessonTab === 'Video'
              ? 'bg-[#e8f0ff] text-[#2d6ee5]'
              : 'border border-[#dbe4f3] bg-white text-[#5e7397]',
          )}
        >
          Video
        </button>
        <span className="text-[11px] font-medium text-[#6f84ab]">
          {hasReachedLessonVideoWatchLimit ? 'Video limit reached' : canRewatchLessonVideo ? 'Rewatch available' : 'Ready to watch'}
        </span>
      </div>
    );

    const renderWatchCard = () => (
      <section
        ref={playerViewportRef}
        data-testid="course-figma-player"
        className={cn(
          'relative h-[238px] overflow-hidden rounded-[22px] border border-[#c9d9ee] bg-white shadow-[0_18px_38px_rgba(47,111,228,0.12)]',
          isFullscreen && 'h-screen w-screen rounded-none border-0 bg-black shadow-none',
        )}
      >
        {actualLessonMedia ? (
          <div className="h-full w-full bg-black">
            {actualLessonMedia}
          </div>
        ) : (
          renderLessonMediaUnavailable('mobile')
        )}
        <button
          type="button"
          data-testid="course-player-fullscreen"
          onClick={() => void toggleFullscreen()}
          className="absolute right-[12px] top-[12px] inline-flex h-[42px] min-w-[42px] items-center justify-center gap-[6px] rounded-full border border-white/16 bg-black/62 px-[12px] text-white shadow-[0_12px_24px_rgba(0,0,0,0.24)] backdrop-blur-sm"
          aria-label={isFullscreen ? 'Exit full screen' : 'Open full screen'}
        >
          {isFullscreen ? <Minimize2 className="h-[18px] w-[18px]" /> : <Maximize2 className="h-[18px] w-[18px]" />}
        </button>
      </section>
    );

    const renderMobilePlaybackMeta = () => (
      <section className="rounded-[16px] border border-[#d7e3f2] bg-white px-[14px] py-[14px] shadow-[0_14px_30px_rgba(47,111,228,0.08)]">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#2f6fe4]">
          {selectedLessonEntry?.sectionLabel || 'Lesson'}
        </p>
        <p className="mt-[6px] text-[18px] font-extrabold leading-[1.18] tracking-[-0.02em] text-[#17233d]">
          {selectedLessonEntry?.lesson.title || 'Lesson'}
        </p>
        <p className="mt-[6px] text-[12px] text-[#53647d]">
          By {selectedCourse?.instructor || userName}
        </p>
      </section>
    );

    const renderMobileSeekBar = () => {
      const durationSeconds = getCurrentLessonDurationSeconds();
      const clampedProgressSeconds = Math.max(Math.min(videoPlaybackSeconds, durationSeconds), 0);
      const bufferedPercent = durationSeconds > 0
        ? Math.min((clampedProgressSeconds / durationSeconds) * 100, 100)
        : 0;

      return (
        <section className="rounded-[16px] border border-[#d7e3f2] bg-white px-[14px] py-[14px] shadow-[0_14px_30px_rgba(47,111,228,0.08)]">
          <div className="flex items-center justify-between gap-[10px] text-[12px] font-semibold text-[#32466c]">
            <span>{formatPlaybackTime(clampedProgressSeconds)}</span>
            <span>{formatPlaybackTime(durationSeconds)}</span>
          </div>
          <div className="mt-[10px]">
            <div className="pointer-events-none mb-[8px] h-[5px] overflow-hidden rounded-full bg-[#e9f0fb]">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#2f6ef0_0%,#69a7ff_100%)]"
                style={{ width: `${bufferedPercent}%` }}
              />
            </div>
            <input
              data-testid="course-player-mobile-seek"
              type="range"
              min={0}
              max={Math.max(durationSeconds, 1)}
              step={1}
              value={Math.round(clampedProgressSeconds)}
              onChange={(event) => seekCurrentLessonVideo(Number(event.currentTarget.value))}
              className="h-[34px] w-full accent-[#2f6fe4]"
              aria-label="Seek lesson video"
            />
          </div>
        </section>
      );
    };

    const renderWatchActionRow = () => {
      const openWatchPanel = (panel: Exclude<MobileWatchPanel, null>) => {
        setMobileWatchPanel((current) => (current === panel ? null : panel));
      };

      const actions = [
        {
          label: 'Save',
          icon: <Bookmark className={cn('h-[27px] w-[27px]', selectedLessonSaved && 'fill-current')} />,
          tone: 'text-[#5f9cff]',
          onClick: () => selectedCourse && selectedLessonEntry && onToggleSavedTopic(selectedCourse._id, selectedLessonEntry.lesson.id),
        },
        {
          label: 'Rate',
          icon: <Star className="h-[28px] w-[28px]" />,
          tone: 'text-[#5f9cff]',
          onClick: () => openWatchPanel('rating'),
        },
        {
          label: 'Chat Replay',
          testId: 'lesson-doubt-open-button',
          icon: <MessageSquare className="h-[27px] w-[27px]" />,
          tone: 'text-[#5f9cff]',
          onClick: () => openWatchPanel('chat'),
        },
        {
          label: 'Report Issue',
          testId: 'lesson-report-open-button',
          icon: <AlertTriangle className="h-[28px] w-[28px]" />,
          tone: 'text-[#f47171]',
          onClick: () => openWatchPanel('report'),
        },
      ];

      return (
        <section className="grid grid-cols-4 overflow-hidden rounded-[16px] border border-[#d7e3f2] bg-white shadow-[0_14px_30px_rgba(47,111,228,0.08)]">
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              data-testid={action.testId}
              aria-label={action.label}
              onClick={action.onClick}
              className={cn(
                'flex h-[72px] min-w-0 flex-col items-center justify-center gap-[6px] px-[6px] text-center',
                index > 0 && 'border-l border-[#e2ebf6]',
              )}
            >
              <span className={action.tone}>{action.icon}</span>
              <span className="!font-sans text-[12px] font-semibold leading-[1.15] text-[#17233d]">{action.label}</span>
            </button>
          ))}
        </section>
      );
    };

    const renderWatchPanel = () => {
      if (!selectedLessonEntry || !mobileWatchPanel) {
        return null;
      }

      const lessonId = selectedLessonEntry.lesson.id;
      const thread = activeLessonDoubtThread?.messages || [];
      const draft = lessonDoubtDrafts[activeLessonDoubtDraftKey] || '';
      const isAdminViewer = lessonDoubtViewerRole === 'admin';
      const rating = lessonRatings[lessonId] || 0;
      const reportDraft = lessonReportDrafts[lessonId] || '';

      if (mobileWatchPanel === 'rating') {
        return (
          <section data-testid="course-player-rating-panel" className="rounded-[16px] border border-[#d7e3f2] bg-white px-[14px] py-[14px] shadow-[0_14px_30px_rgba(47,111,228,0.08)]">
            <div className="flex items-center justify-between gap-[12px]">
              <div>
                <p className="text-[14px] font-extrabold text-[#17233d]">Rate this lesson</p>
                <p className="mt-[3px] text-[12px] leading-[1.4] text-[#53647d]">{rating ? `${rating}/5 saved for this device.` : 'Tap a star to save your rating.'}</p>
              </div>
              <button type="button" onClick={() => setMobileWatchPanel(null)} className="text-[12px] font-semibold text-[#2f6fe4]">Close</button>
            </div>
            <div className="mt-[14px] flex items-center gap-[9px]">
              {Array.from({ length: 5 }).map((_, index) => {
                const value = index + 1;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-label={`Rate ${value} stars`}
                    onClick={() => setLessonRatings((current) => ({ ...current, [lessonId]: value }))}
                    className={cn('text-[#b8c6d8] transition', value <= rating && 'text-[#2f6fe4]')}
                  >
                    <Star className={cn('h-[30px] w-[30px]', value <= rating && 'fill-current')} />
                  </button>
                );
              })}
            </div>
          </section>
        );
      }

      if (mobileWatchPanel === 'chat') {
        return (
          <section data-testid="lesson-doubt-panel" className="rounded-[16px] border border-[#d7e3f2] bg-white px-[14px] py-[14px] shadow-[0_14px_30px_rgba(47,111,228,0.08)]">
            <div className="flex items-center justify-between gap-[12px]">
              <div>
                <p className="text-[14px] font-extrabold text-[#17233d]">Chat Replay</p>
                <p className="mt-[3px] text-[12px] text-[#53647d]">Lesson conversation stays scrollable.</p>
              </div>
              <button type="button" onClick={() => setMobileWatchPanel(null)} className="text-[12px] font-semibold text-[#2f6fe4]">Close</button>
            </div>
            <div data-testid="lesson-doubt-message-list" className="mt-[12px] max-h-[210px] space-y-[10px] overflow-y-auto pr-[4px]">
              {thread.length === 0 && (
                <div data-testid="lesson-doubt-empty-state" className="rounded-[14px] border border-dashed border-[#d7e3f2] bg-[#f8fbff] px-[12px] py-[12px] text-[12px] leading-5 text-[#53647d]">
                  No chat replay yet. Ask a lesson question to start this thread.
                </div>
              )}
              {thread.map((message) => (
                <div
                  key={message._id}
                  data-testid={message.role === 'admin' ? 'lesson-doubt-admin-reply' : 'lesson-doubt-user-message'}
                  className={cn(
                    'rounded-[14px] border px-[12px] py-[10px]',
                    String(message.userId || '') === String(user?._id || '')
                      ? 'ml-[22px] border-[#cfe0ff] bg-[#eef5ff]'
                      : 'border-[#e7edf7] bg-[#fbfdff]',
                  )}
                >
                  <div className="flex items-center justify-between gap-[10px]">
                    <p className="text-[12px] font-bold text-[#17233d]">{message.userName}{message.role === 'admin' ? ' • Admin' : ''}</p>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7b8da6]">{formatLessonDoubtTime(message.createdAt)}</span>
                  </div>
                  <p className="mt-[5px] text-[12px] leading-[1.5] text-[#53647d]">{message.message}</p>
                </div>
              ))}
            </div>
            <div className="mt-[12px] flex items-center gap-[8px] rounded-[14px] border border-[#d7e3f2] bg-[#f8fbff] px-[10px] py-[9px]">
              <input
                data-testid="lesson-doubt-input"
                type="text"
                value={draft}
                onChange={(event) => setLessonDoubtDrafts((current) => ({ ...current, [activeLessonDoubtDraftKey]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitLessonDoubt();
                  }
                }}
                placeholder="Add message..."
                disabled={sendingLessonDoubt || (isAdminViewer && !activeLessonDoubtThread)}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[#17233d] outline-none placeholder:text-[#8ba0bb]"
              />
              <button
                type="button"
                data-testid="lesson-doubt-send-button"
                aria-label="Send chat replay message"
                onClick={() => void submitLessonDoubt()}
                disabled={!draft.trim() || sendingLessonDoubt || (isAdminViewer && !activeLessonDoubtThread)}
                className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-[#2f6fe4] text-white shadow-[0_8px_18px_rgba(47,111,228,0.22)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sendingLessonDoubt ? <LoaderCircle className="h-[15px] w-[15px] animate-spin" /> : <Send className="h-[15px] w-[15px]" />}
              </button>
            </div>
          </section>
        );
      }

      return (
        <section data-testid="lesson-report-panel" className="rounded-[16px] border border-[#d7e3f2] bg-white px-[14px] py-[14px] shadow-[0_14px_30px_rgba(47,111,228,0.08)]">
          <div className="flex items-center justify-between gap-[12px]">
            <div>
              <p className="text-[14px] font-extrabold text-[#17233d]">Report Issue</p>
              <p className="mt-[3px] text-[12px] text-[#53647d]">{lessonReportSuccess ? lessonReportSuccess : 'Tell us what went wrong.'}</p>
            </div>
            <button type="button" onClick={() => setMobileWatchPanel(null)} className="text-[12px] font-semibold text-[#2f6fe4]">Close</button>
          </div>
          <select
            data-testid="lesson-report-issue-type"
            value={lessonReportIssueTypes[lessonId] || 'other'}
            onChange={(event) => setLessonReportIssueTypes((current) => ({ ...current, [lessonId]: event.target.value as LessonReportIssueType }))}
            className="mt-[12px] h-[42px] w-full rounded-[14px] border border-[#d7e3f2] bg-[#f8fbff] px-[12px] text-[13px] text-[#17233d] outline-none"
          >
            {LESSON_REPORT_ISSUE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <textarea
            data-testid="lesson-report-description"
            value={reportDraft}
            onChange={(event) => {
              setLessonReportSuccess(null);
              setLessonReportDrafts((current) => ({ ...current, [lessonId]: event.target.value }));
            }}
            placeholder="Video not playing, audio issue, wrong lesson..."
            className="mt-[12px] h-[92px] w-full resize-none rounded-[14px] border border-[#d7e3f2] bg-[#f8fbff] px-[12px] py-[10px] text-[13px] leading-5 text-[#17233d] outline-none placeholder:text-[#8ba0bb] focus:border-[#2f6fe4]"
          />
          {lessonReportError && (
            <div data-testid="lesson-report-error" className="mt-[10px] rounded-[12px] border border-[#ffd2d2] bg-[#fff6f6] px-[12px] py-[10px] text-[12px] text-[#b24141]">
              {lessonReportError}
            </div>
          )}
          {lessonReportSuccess && (
            <div data-testid="lesson-report-success" className="mt-[10px] rounded-[12px] border border-[#cdecd8] bg-[#f4fff7] px-[12px] py-[10px] text-[12px] text-[#227a42]">
              {lessonReportSuccess}
            </div>
          )}
          <button
            type="button"
            data-testid="lesson-report-submit-button"
            onClick={() => void submitLessonReport()}
            disabled={!reportDraft.trim()}
            className="mt-[10px] flex h-[38px] w-full items-center justify-center rounded-[12px] bg-[#2f6fe4] text-[13px] font-bold text-white shadow-[0_10px_20px_rgba(47,111,228,0.20)] disabled:cursor-not-allowed disabled:bg-[#b8c6d8]"
          >
            {sendingLessonReport ? <LoaderCircle data-testid="lesson-report-loading" className="h-[15px] w-[15px] animate-spin" /> : 'Submit report'}
          </button>
          <div data-testid="lesson-report-my-list" className="mt-[12px] space-y-[8px]">
            {activeLessonReports.map((report) => (
              <div key={report._id} data-testid="lesson-report-row" className="rounded-[14px] border border-[#e7edf7] bg-[#fbfdff] px-[12px] py-[10px]">
                <div className="flex items-center justify-between gap-[10px]">
                  <p data-testid="lesson-report-ticket-id" className="text-[12px] font-bold text-[#17233d]">{report._id}</p>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#2f6fe4]">{report.status}</span>
                </div>
                <p className="mt-[4px] text-[11px] text-[#607394]">{report.description}</p>
                {report.adminReply && <p className="mt-[4px] text-[11px] font-medium text-[#227a42]">Reply: {report.adminReply}</p>}
              </div>
            ))}
          </div>
        </section>
      );
    };

    const renderWatchUpNext = () => {
      const previewTitle = nextLessonEntry?.lesson.title || (isLessonReadyForExam ? selectedLessonCopy.quiz.title : 'Course completed');
      const previewSubtitle = nextLessonEntry
        ? `By ${selectedCourse?.instructor || userName}`
        : isLessonReadyForExam
          ? 'Chapter CBT is ready'
          : 'Finish this video to unlock the next step';
      const previewMeta = nextLessonEntry
        ? formatDurationLabel(nextLessonEntry.lesson.durationMinutes)
        : isLessonReadyForExam
          ? `${selectedLessonCopy.quiz.totalQuestions} questions`
          : 'Locked';

      return (
        <section className="border-t border-[#d7e3f2] pt-[18px]">
          <div className="flex items-center justify-between gap-[14px]">
            <h2 className="!font-sans text-[18px] font-extrabold tracking-[-0.02em] text-[#17233d]">Up Next</h2>
            <div className="flex items-center gap-[10px]">
              <span className="!font-sans text-[13px] font-semibold text-[#53647d]">Autoplay</span>
              <ToggleSwitch checked={autoplayEnabled} onToggle={() => setAutoplayEnabled((current) => !current)} testId="course-player-autoplay-toggle" />
            </div>
          </div>

          <button
            type="button"
            data-testid={nextLessonEntry ? 'course-player-continue-next-lesson' : isLessonReadyForExam ? 'course-player-start-cbt' : undefined}
            onClick={() => {
              if (nextLessonEntry) {
                openNextLesson();
                return;
              }
              if (isLessonReadyForExam) {
                startLessonExam();
              }
            }}
            disabled={!nextLessonEntry && !isLessonReadyForExam}
            className="mt-[16px] grid w-full grid-cols-[142px_1fr_20px] items-center gap-[12px] text-left disabled:opacity-70"
          >
            <div className="relative h-[78px] overflow-hidden rounded-[14px] border border-[#d7e3f2] bg-[#eef6ff] shadow-[0_10px_22px_rgba(47,111,228,0.10)]">
              <img alt="" aria-hidden="true" src={selectedCourseVisual} className="h-full w-full object-cover opacity-58" />
              <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(4,10,20,0.82),rgba(4,10,20,0.18))]" />
              <span className="absolute left-[10px] top-[9px] flex h-[26px] w-[26px] items-center justify-center rounded-full border border-white/24 bg-[#17233d]/86 text-[13px] font-bold text-white">
                {nextLessonEntry?.lessonIndex || selectedLessonEntry?.lessonIndex || 1}
              </span>
              <span className="absolute bottom-[9px] right-[9px] text-[12px] font-bold text-white">{previewMeta}</span>
              <div className="absolute bottom-0 left-0 h-[4px] w-[52%] rounded-r-full bg-[#2f6fe4]" />
            </div>
            <div className="min-w-0">
              <p className="!font-sans line-clamp-2 text-[16px] font-extrabold leading-[1.14] tracking-[-0.015em] text-[#17233d]">{previewTitle}</p>
              <p className="!font-sans mt-[7px] text-[13px] leading-none text-[#53647d]">{previewSubtitle}</p>
              <p className="!font-sans mt-[12px] text-[12px] text-[#7b8da6]">{nextLessonEntry ? 'Next lesson' : isLessonReadyForExam ? 'Next step' : 'Complete current video'}</p>
            </div>
            <MoreVertical className="h-[20px] w-[20px] text-[#7b8da6]" />
          </button>
        </section>
      );
    };

    const renderCompletionCard = () => {
      const lessonsCompletedLabel = selectedCourseVideoCompletedDisplayCount;

      if (isLessonFlowComplete) {
        return (
          <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[16px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-[54px] w-[54px] items-center justify-center rounded-full bg-[#18ad73] text-white shadow-[0_10px_20px_rgba(24,173,115,0.22)]">
                <CheckCircle2 className="h-[30px] w-[30px]" />
              </div>
              <p className="mt-[12px] text-[17px] font-semibold leading-none text-[#17233f]">Lesson Flow Completed</p>
              <p className="mt-[7px] max-w-[230px] text-[13px] leading-[1.42] text-[#5d7092]">
                Video, CBT, and explanation are all complete for {selectedLessonEntry?.lesson.title}.
              </p>
            </div>

            <div className="mt-[18px] rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[14px] py-[14px]">
              <div className="flex items-start gap-[10px]">
                <div className="mt-[2px] flex h-[28px] w-[28px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
                  <Sparkles className="h-[14px] w-[14px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-[#17305c]">What&apos;s Next?</p>
                  <p className="mt-[4px] text-[12px] leading-[1.4] text-[#5d7092]">
                    {nextLessonEntry
                      ? `Continue with ${nextLessonEntry.lesson.title}.`
                      : 'You have completed this lesson sequence.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="course-player-continue-next-lesson"
                onClick={() => {
                  if (nextLessonEntry) {
                    openNextLesson();
                    return;
                  }
                  setScreen('course');
                }}
                className="mt-[14px] inline-flex h-[40px] w-full items-center justify-center rounded-[8px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
              >
                {nextLessonEntry ? 'Open Next Lesson' : 'Back to Lessons'}
              </button>
            </div>

            <div className="mt-[12px] grid gap-[12px]">
              <div className="rounded-[16px] border border-[#e3ebf6] bg-white px-[14px] py-[14px]">
                <p className="text-[12px] font-semibold text-[#17305c]">Lesson Replay</p>
                <p className="mt-[4px] text-[11px] leading-[1.42] text-[#5d7092]">
                  {hasReachedLessonVideoWatchLimit
                    ? 'Maximum lesson video rewatch limit reached.'
                    : `${selectedLessonVideoWatchCount}/${selectedLessonVideoWatchLimit} watches used. Replay remains available until the limit is reached.`}
                </p>
                {canRewatchLessonVideo ? (
                  <button
                    type="button"
                    data-testid="course-player-rewatch-video"
                    onClick={startLessonVideoReplay}
                    className="mt-[12px] inline-flex h-[32px] items-center justify-center rounded-[10px] border border-[#d7e3f5] bg-white px-[12px] text-[11px] font-semibold text-[#2d6ee5]"
                  >
                    Rewatch Lesson
                  </button>
                ) : (
                  <div data-testid="course-player-rewatch-limit" className="mt-[12px] inline-flex h-[26px] items-center rounded-full bg-[#eef3fb] px-[10px] text-[10px] font-medium text-[#7287a8]">
                    Maximum limit reached
                  </div>
                )}
              </div>

              <div className="rounded-[16px] border border-[#e3ebf6] bg-white px-[14px] py-[14px]">
                <p className="text-[12px] font-semibold text-[#17305c]">Explanation Status</p>
                <p className="mt-[4px] text-[11px] leading-[1.42] text-[#5d7092]">
                  {hasReachedExplanationWatchLimit
                    ? 'Explanation video already watched once. Rewatch is not available.'
                    : 'Explanation video is still pending.'}
                </p>
                <div className="mt-[12px] inline-flex h-[26px] items-center rounded-full bg-[#eef4ff] px-[10px] text-[10px] font-medium text-[#4b658f]">
                  {hasReachedExplanationWatchLimit ? 'Maximum limit reached' : 'One-time watch'}
                </div>
              </div>
            </div>

            <div className="mt-[14px] rounded-[16px] border border-[#e3ebf6] bg-white px-[14px] py-[14px]">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-semibold text-[#17233f]">Lesson Progress</p>
                <span className="text-[12px] font-medium text-[#2d6ee5]">100%</span>
              </div>
              <p className="mt-[5px] text-[12px] text-[#5d7092]">
                {lessonsCompletedLabel} of {selectedCourseSnapshot.totalLessons} lessons completed
              </p>
              <div className="mt-[10px] h-[6px] overflow-hidden rounded-full bg-[#d8e4f7]">
                <div
                  className="h-full rounded-full bg-[linear-gradient(90deg,#57a4ff_0%,#7ab8ff_100%)]"
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </section>
        );
      }

      return (
        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[16px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-[54px] w-[54px] items-center justify-center rounded-full bg-[#18ad73] text-white shadow-[0_10px_20px_rgba(24,173,115,0.22)]">
              <CheckCircle2 className="h-[30px] w-[30px]" />
            </div>
            <p className="mt-[12px] text-[17px] font-semibold leading-none text-[#17233f]">Lesson Completed!</p>
            <p className="mt-[7px] max-w-[210px] text-[13px] leading-[1.42] text-[#5d7092]">
              Great job! You&apos;ve completed {selectedLessonEntry?.lesson.title}.
            </p>
          </div>

          <div className="mt-[18px] rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[14px] py-[14px]">
            <div className="flex items-start gap-[10px]">
              <div className="mt-[2px] flex h-[28px] w-[28px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
                <Sparkles className="h-[14px] w-[14px]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[#17305c]">What&apos;s Next?</p>
                <p className="mt-[4px] text-[12px] leading-[1.4] text-[#5d7092]">
                  {selectedLessonHasCbt
                    ? 'Take a CBT (Chapter Based Test) to test your understanding.'
                    : nextLessonEntry
                      ? `Open ${nextLessonEntry.lesson.title} when you are ready to continue.`
                      : 'Return to the lesson list and continue with any released lesson.'}
                </p>
              </div>
            </div>
            {selectedLessonHasCbt ? (
              <>
                <button
                  type="button"
                  data-testid="course-player-start-cbt"
                  onClick={startLessonExam}
                  className="mt-[14px] inline-flex h-[40px] w-full items-center justify-center rounded-[8px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
                >
                  Start CBT Exam
                </button>
                <div className="mt-[10px] flex items-center justify-center gap-[6px] text-[11px] text-[#6f84ab]">
                  <span>One Attempt Only</span>
                  <Clock3 className="h-[12px] w-[12px]" />
                </div>
              </>
            ) : (
              <button
                type="button"
                data-testid="course-player-continue-next-lesson"
                onClick={() => {
                  if (nextLessonEntry) {
                    openNextLesson(true);
                    return;
                  }
                  setScreen('course');
                }}
                className="mt-[14px] inline-flex h-[40px] w-full items-center justify-center rounded-[8px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
              >
                {nextLessonEntry ? 'Open Next Lesson' : 'Back to Lessons'}
              </button>
            )}

            <div className="mt-[12px] border-t border-[#e6edf8] pt-[12px]">
              <div className="flex items-start justify-between gap-[10px]">
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-[#17305c]">Lesson Replay</p>
                  <p className="mt-[4px] text-[11px] leading-[1.42] text-[#5d7092]">
                    {hasReachedLessonVideoWatchLimit
                      ? 'Maximum lesson video rewatch limit reached.'
                      : `${selectedLessonVideoWatchCount}/${selectedLessonVideoWatchLimit} watches used. Replay remains available until the limit is reached.`}
                  </p>
                </div>
                {canRewatchLessonVideo ? (
                <button
                  type="button"
                  data-testid="course-player-rewatch-video"
                  onClick={startLessonVideoReplay}
                  className="inline-flex h-[32px] shrink-0 items-center justify-center rounded-[10px] border border-[#d7e3f5] bg-white px-[12px] text-[11px] font-semibold text-[#2d6ee5]"
                >
                  Rewatch
                </button>
              ) : (
                <span data-testid="course-player-rewatch-limit" className="inline-flex h-[26px] shrink-0 items-center rounded-full bg-[#eef3fb] px-[10px] text-[10px] font-medium text-[#7287a8]">
                  Limit reached
                </span>
              )}
              </div>
            </div>
          </div>

          <div className="mt-[14px] rounded-[16px] border border-[#e3ebf6] bg-white px-[14px] py-[14px]">
            <div className="flex items-center justify-between">
              <p className="text-[13px] font-semibold text-[#17233f]">Lesson Progress</p>
              <span className="text-[12px] font-medium text-[#2d6ee5]">100%</span>
            </div>
            <p className="mt-[5px] text-[12px] text-[#5d7092]">
              {lessonsCompletedLabel} of {selectedCourseSnapshot.totalLessons} lessons completed
            </p>
            <div className="mt-[10px] h-[6px] overflow-hidden rounded-full bg-[#d8e4f7]">
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#57a4ff_0%,#7ab8ff_100%)]"
                style={{ width: '100%' }}
              />
            </div>
          </div>
        </section>
      );
    };

    const renderExamCard = () => {
      const selectedOption = selectedLessonExamSelectedOption;
      const prompt = selectedLessonCopy.quiz.prompt;
      return (
        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[14px] py-[14px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <div className="flex items-center justify-between border-b border-[#e4ebf8] pb-[10px]">
            <button type="button" className="border-b-[2px] border-[#2d6ee5] pb-[6px] text-[14px] font-semibold text-[#1b49d6]">
              CBT Exam
            </button>
            <button type="button" className="text-[12px] font-medium text-[#ff8a00]">
              One Attempt Only &gt;
            </button>
          </div>

          <div className="mt-[12px] flex items-center justify-between text-[13px] text-[#7a90b7]">
            <div>
              <p className="uppercase tracking-[0.04em]">Time Left</p>
              <p className="mt-[4px] text-[16px] font-semibold text-[#17233f]">
                {formatPlaybackTime(Math.max(selectedLessonVideoDurationSeconds - 315, 0))}
              </p>
            </div>
            <div className="text-right">
              <p className="uppercase tracking-[0.04em]">Question</p>
              <p className="mt-[4px] text-[16px] font-semibold text-[#17233f]">1 / 10</p>
            </div>
          </div>

          <div className="mt-[14px] rounded-[16px] border border-[#e1e9f6] bg-[#fbfdff] px-[14px] py-[14px]">
            <p className="text-[16px] font-semibold leading-[1.35] text-[#17233f]">Q1. {prompt}</p>
            <div className="mt-[14px] space-y-[10px]">
              {selectedLessonCopy.quiz.options.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  data-testid={`course-player-cbt-option-${index}`}
                  disabled={selectedLessonExamSubmitted}
                  onClick={() => {
                    if (selectedLessonExamSubmitted) {
                      return;
                    }
                    setQuizSelections((current) => ({ ...current, [selectedLessonEntry?.lesson.id || '']: index }));
                  }}
                  className={cn(
                    'flex w-full items-center gap-[10px] rounded-[12px] border px-[12px] py-[12px] text-left',
                    selectedOption === index ? 'border-[#8fbdf7] bg-[#eef5ff] text-[#1b49d6]' : 'border-[#dbe4f3] bg-white text-[#516786]',
                    selectedLessonExamSubmitted && selectedOption !== index && 'opacity-70',
                  )}
                >
                  <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-current text-[10px] font-semibold">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span className="text-[14px] leading-[1.35]">{option}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-[14px] flex items-center gap-[10px]">
            <button
              type="button"
              onClick={() => {
                if (!selectedLessonEntry) {
                  return;
                }
                setQuizSelections((current) => ({ ...current, [selectedLessonEntry.lesson.id]: null }));
              }}
              className="inline-flex h-[40px] flex-1 items-center justify-center rounded-[10px] border border-[#dbe4f3] bg-white text-[14px] font-medium text-[#5e7397]"
            >
              Clear Answer
            </button>
            <button
              type="button"
              data-testid="course-player-cbt-submit"
              disabled={selectedOption === null}
              onClick={() => submitLessonExam(false)}
              className="inline-flex h-[40px] flex-1 items-center justify-center rounded-[10px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[14px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)] disabled:opacity-60"
            >
              Next
            </button>
          </div>
        </section>
      );
    };

    const renderExamCompleteCard = () => {
      const selectedOption = selectedLessonExamSelectedOption;
      const correct = selectedOption === selectedLessonCopy.quiz.answerIndex;
      const totalQuestions = Math.max(selectedLessonCopy.quiz.totalQuestions || 1, 1);
      const correctAnswers = correct ? 1 : 0;
      const wrongAnswers = selectedOption !== null && !correct ? 1 : 0;
      const score = `${correctAnswers} / ${totalQuestions}`;
      const percent = Math.round((correctAnswers / totalQuestions) * 100);

      return (
        <section className="space-y-[14px]">
          <div className="rounded-[18px] border border-[#dbe4f3] bg-white px-[16px] py-[18px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-[#18ad73] text-white shadow-[0_10px_20px_rgba(24,173,115,0.22)]">
                <CheckCircle2 className="h-[28px] w-[28px]" />
              </div>
              <p className="mt-[12px] text-[17px] font-semibold text-[#17233f]">CBT Completed!</p>
              <p className="mt-[6px] text-[12px] text-[#6f84ab]">You have used your 1 attempt.</p>
            </div>

            <div className="mt-[16px] rounded-[16px] border border-[#e3ebf6] bg-white px-[14px] py-[14px]">
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-[12px] text-[#6f84ab]">Your Score</p>
                  <p className="mt-[2px] text-[16px] font-semibold text-[#17233f]">{score}</p>
                </div>
                <span className="text-[15px] font-semibold text-[#18ad73]">{percent}%</span>
              </div>
              <div className="mt-[12px] grid grid-cols-2 gap-[12px] border-t border-[#e8edf7] pt-[12px] text-[12px] text-[#5d7092]">
                <div>
                  <p>Correct Answers</p>
                  <p className="mt-[4px] text-[15px] font-semibold text-[#17233f]">{correctAnswers}</p>
                </div>
                <div>
                  <p>Wrong Answers</p>
                  <p className="mt-[4px] text-[15px] font-semibold text-[#17233f]">{wrongAnswers}</p>
                </div>
              </div>
            </div>

            <div className="mt-[14px] rounded-[16px] border border-[#e3ebf6] bg-[#fbfdff] px-[14px] py-[14px]">
              <div className="flex items-start gap-[10px]">
                <div className="mt-[2px] flex h-[28px] w-[28px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[#2d6ee5]">
                  <Sparkles className="h-[14px] w-[14px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-[#17305c]">What&apos;s Next?</p>
                  <p className="mt-[4px] text-[12px] leading-[1.4] text-[#5d7092]">
                    {hasReachedExplanationWatchLimit
                      ? nextLessonEntry
                        ? `Explanation is complete. Continue with ${nextLessonEntry.lesson.title}.`
                        : 'Explanation is complete. Continue from the lesson list.'
                      : 'Watch the explanation video to understand the correct answers.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                data-testid="course-player-watch-explanation"
                onClick={hasReachedExplanationWatchLimit
                  ? () => {
                    if (nextLessonEntry) {
                      openNextLesson();
                      return;
                    }
                    setScreen('course');
                  }
                  : openLessonExplanation}
                className="mt-[14px] inline-flex h-[40px] w-full items-center justify-center rounded-[8px] bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]"
              >
                {hasReachedExplanationWatchLimit ? (nextLessonEntry ? 'Open Next Lesson' : 'Back to Lessons') : 'Watch Explanation'}
              </button>
            </div>

            <div className="mt-[14px] rounded-[16px] border border-[#e3ebf6] bg-[#eef4ff] px-[14px] py-[12px] text-[12px] text-[#4b658f]">
              <div className="flex items-center gap-[8px]">
                <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-[#2d6ee5] text-[11px] text-[#2d6ee5]">i</div>
                <p>{hasReachedExplanationWatchLimit ? 'Explanation watch limit reached for this lesson.' : 'You cannot retake this CBT.'}</p>
              </div>
            </div>
          </div>
        </section>
      );
    };

    const renderExplanationMobile = () => (
      <div className="space-y-[14px]">
        <section className="overflow-hidden rounded-[18px] border border-[#dbe4f3] bg-[#20314b] shadow-[0_12px_24px_rgba(54,78,123,0.08)]">
          <div className="relative min-h-[268px] bg-[#20314b]">
            <img alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-30" src={selectedCourseVisual} />
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,25,40,0.14)_0%,rgba(15,25,40,0.78)_100%)]" />
            <div className="relative flex min-h-[268px] flex-col px-[18px] py-[18px] text-center text-white">
              <div className="flex flex-1 flex-col items-center justify-center">
                <p className="text-[16px] font-medium">CBT Explanation</p>
                <button
                  type="button"
                  data-testid="course-player-explanation-play"
                  onClick={() => {
                    setActiveLessonTab('Explanation');
                    setMobileLessonStageOverride('explanation');
                    setIsExplanationPlaying((current) => !current);
                  }}
                  className="mt-[14px] flex h-[60px] w-[60px] items-center justify-center rounded-full border border-white/28 bg-white/10 text-white backdrop-blur"
                >
                  {isExplanationPlaying ? <Pause className="h-[24px] w-[24px] fill-current" /> : <Play className="ml-[2px] h-[24px] w-[24px] fill-current" />}
                </button>
              </div>
              <div className="mt-auto rounded-[12px] bg-[linear-gradient(180deg,rgba(0,0,0,0.06)_0%,rgba(0,0,0,0.42)_100%)] px-[10px] py-[10px]">
                <div className="h-[4px] overflow-hidden rounded-full bg-white/24">
                  <div
                    className="h-full rounded-full bg-[#8db7ff]"
                    style={{ width: `${Math.min((explanationPlaybackSeconds / selectedLessonExplanationDurationSeconds) * 100, 100)}%` }}
                  />
                </div>
                <div className="mt-[8px] flex items-center justify-between text-[12px] text-white/86">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveLessonTab('Explanation');
                      setMobileLessonStageOverride('explanation');
                      setIsExplanationPlaying((current) => !current);
                    }}
                  >
                    {isExplanationPlaying ? <Pause className="h-[16px] w-[16px] fill-current" /> : <Play className="h-[16px] w-[16px] fill-current" />}
                  </button>
                  <span>{formatPlaybackTime(explanationPlaybackSeconds)} / {formatPlaybackTime(selectedLessonExplanationDurationSeconds)}</span>
                  <span>1x</span>
                  <Maximize2 className="h-[14px] w-[14px]" />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[14px] py-[14px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[16px] font-semibold text-[#17233f]">Explanation Summary</p>
          <p className="mt-[8px] text-[14px] leading-[1.52] text-[#5d7092]">
            In this video, we explain each question in detail with the correct concepts and solutions.
          </p>
        </section>

        <section className="rounded-[18px] border border-[#dbe4f3] bg-white px-[14px] py-[14px] shadow-[0_12px_24px_rgba(54,78,123,0.05)]">
          <p className="text-[14px] leading-[1.5] text-[#5d7092]">
            {autoplayCountdown !== null && nextLessonEntry
              ? `Starting ${nextLessonEntry.lesson.title} in ${autoplayCountdown}s.`
              : 'After watching, you can continue to the next lesson.'}
          </p>
          <button
            type="button"
            data-testid="course-player-continue-next-lesson"
            onClick={completeMobileLessonAndAdvance}
            disabled={explanationPlaybackSeconds < selectedLessonExplanationDurationSeconds || autoplayCountdown !== null}
            className={cn(
              'mt-[14px] inline-flex h-[42px] w-full items-center justify-center rounded-[8px] text-[14px] font-semibold transition',
              explanationPlaybackSeconds >= selectedLessonExplanationDurationSeconds && autoplayCountdown === null
                ? 'bg-[linear-gradient(180deg,#2f6ef0_0%,#2660e3_100%)] text-white shadow-[0_12px_24px_rgba(45,110,229,0.2)]'
                : 'cursor-not-allowed border border-[#dbe4f3] bg-[#eef3fb] text-[#90a4c3]',
            )}
          >
            {autoplayCountdown !== null ? 'Opening Next Lesson...' : 'Continue to Next Lesson'}
          </button>
        </section>
      </div>
    );

    const mobileContent = (() => {
      if (mobileMode === 'exam') {
        return renderExamCard();
      }
      if (mobileMode === 'exam-complete') {
        return renderExamCompleteCard();
      }
      if (mobileMode === 'explanation' || mobileMode === 'explanation-complete') {
        return renderExplanationMobile();
      }
      if (mobileMode === 'completed') {
        return renderCompletionCard();
      }
      return (
        <div className="space-y-[24px]">
          {renderWatchCard()}
          {renderMobilePlaybackMeta()}
          {renderMobileSeekBar()}
          {renderWatchActionRow()}
          {renderWatchPanel()}
          {renderWatchUpNext()}

        </div>
      );
    })();

    return (
      <div
        data-testid="course-figma-page"
        data-course-view="lesson"
        className="mobile-safe-screen h-[100dvh] overflow-x-hidden overflow-y-auto bg-[linear-gradient(180deg,#f8fbff_0%,#edf4ff_48%,#f8fbff_100%)] !px-0"
        style={uiFontStyle}
      >
        <div className="mobile-safe-content mx-auto pt-[18px]">

          <div className="flex h-[46px] items-center justify-between gap-[10px]">
            <button
              type="button"
              data-testid="course-back-to-lessons"
              onClick={() => setScreen('course')}
              className="flex h-[42px] w-[42px] items-center justify-center text-[#17233d]"
            >
              <ChevronLeft className="h-[32px] w-[32px]" />
            </button>
            <h1 data-testid="course-player-heading" className="!font-sans max-w-[214px] text-center text-[22px] font-extrabold leading-none tracking-[-0.02em] text-[#17233d]">
              {selectedLessonEntry?.lessonIndex || 1}
            </h1>
            <button
              type="button"
              data-testid="course-player-bookmark"
              onClick={() => selectedCourse && selectedLessonEntry && onToggleSavedTopic(selectedCourse._id, selectedLessonEntry.lesson.id)}
              className="flex h-[42px] w-[42px] items-center justify-center text-[#2f6fe4]"
            >
              <Bookmark className={cn('h-[28px] w-[28px]', selectedLessonSaved && 'fill-current')} />
            </button>
          </div>
        </div>

        <div className="px-[14px] pb-[42px] pt-[18px]">
          {mobileContent}
        </div>
      </div>
    );
  };

  const renderLessonView = () => {
    if (isMobileLayout) {
      return renderMobileLessonView();
    }

    return (
    <div
      data-testid="course-figma-page"
      data-course-view="lesson"
      className="overflow-hidden rounded-[30px] border border-white/70 bg-[linear-gradient(180deg,#f9fbff_0%,#eef3ff_100%)] shadow-[0_30px_90px_rgba(33,51,97,0.13)]"
    >
      <header className="flex flex-col gap-[18px] border-b border-[#dde5f5] bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] px-[24px] py-[20px] xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-[10px] text-[15px] text-[#5e7397]">
          <button type="button" onClick={() => setScreen('course')} className="flex items-center gap-[10px]">
            <ChevronLeft className="h-[18px] w-[18px]" />
          </button>
          <span>{breadcrumbLabel}</span>
        </div>
        <HeaderTools
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          placeholder="Search playlist..."
        />
      </header>

      <div className="grid gap-[18px] px-[24px] py-[20px] xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="flex flex-col gap-[16px]">
            <div className="flex flex-col gap-[12px] xl:flex-row xl:items-center xl:justify-between">
              <h1 data-testid="course-player-heading" className="text-[24px] font-semibold tracking-[-0.03em] text-[#1c2d4c]">
                {selectedLessonEntry?.lesson.title}
              </h1>
            </div>

            <div className="flex flex-col gap-[12px] border-b border-[#e0e8f6] pb-[12px] xl:flex-row xl:items-end xl:justify-between">
              <div className="flex items-center gap-[10px]">
                <button
                  type="button"
                  data-testid="course-player-tab-video"
                  onClick={() => handleLessonTabSelect('Video')}
                  className={cn(
                    'relative inline-flex items-center rounded-full px-[12px] py-[8px] text-[15px] transition',
                    activeLessonTab === 'Video'
                      ? 'bg-[#e8f0ff] font-semibold text-[#1b49d6]'
                      : 'border border-[#dbe4f3] bg-white font-medium text-[#4c6086]',
                  )}
                >
                  Video
                  {activeLessonTab === 'Video' && <span className="absolute bottom-0 left-[10px] right-[10px] h-[3px] rounded-full bg-[#3c83ef]" />}
                </button>
                <span className="text-[13px] text-[#6d7c93]">
                  {hasReachedLessonVideoWatchLimit ? 'Video limit reached' : canRewatchLessonVideo ? 'Rewatch available' : 'Video lesson'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-[12px]">
                <button
                  type="button"
                  data-testid="course-player-mark-complete"
                  onClick={handlePrimaryLessonAction}
                  disabled={primaryLessonActionDisabled}
                  className={cn(
                    'inline-flex h-[40px] items-center gap-[8px] rounded-[12px] border px-[16px] text-[15px] font-medium transition',
                    primaryLessonActionDisabled
                      ? 'cursor-not-allowed border-[#dbe4f3] bg-[#f2f6fd] text-[#90a4c3]'
                      : 'border-[#dbe4f3] bg-[#ffffff] text-[#2d6ee5]',
                  )}
                >
                  <ClipboardCheck className="h-[16px] w-[16px]" />
                  {primaryLessonActionLabel}
                </button>
                <button
                  type="button"
                  data-testid="course-player-bookmark"
                  onClick={() => selectedCourse && selectedLessonEntry && onToggleSavedTopic(selectedCourse._id, selectedLessonEntry.lesson.id)}
                  className="flex h-[40px] w-[40px] items-center justify-center rounded-[12px] border border-[#dbe4f3] bg-white text-[#2d6ee5]"
                >
                  <Bookmark className={cn('h-[18px] w-[18px]', selectedLessonSaved && 'fill-current')} />
                </button>
              </div>
            </div>

            {activeLessonTab === 'Video' && renderVideoPanel()}
            {activeLessonTab === 'CBT Exam' && renderQuizPanel()}
            {activeLessonTab === 'Explanation' && renderExplanationPanel()}
          </div>
        </div>

        <aside className="space-y-[12px]">
          <button
            type="button"
            data-testid="course-back-to-lessons"
            onClick={() => setScreen('course')}
            className="inline-flex items-center gap-[8px] rounded-[12px] bg-[#eef4ff] px-[16px] py-[12px] text-[15px] font-medium text-[#2d6ee5]"
          >
            <ChevronLeft className="h-[16px] w-[16px]" />
            Back to Lessons
          </button>

          <section className="rounded-[22px] bg-white px-[18px] py-[16px] shadow-[0_16px_34px_rgba(54,78,123,0.08)]">
            <p className="text-[16px] font-medium text-[#1c2d4c]">Course Progress</p>
            <div className="mt-[16px]">
              <ProgressDonut percent={selectedCourseSnapshot.progressPercent} title="Completed" testId="course-progress-percent" />
            </div>
            <div className="mt-[14px] grid grid-cols-2 gap-y-[8px] text-[14px] text-[#5d7092]">
              <span data-testid="course-progress-lessons-completed">{selectedCourseVideoCompletedDisplayCount} Lessons Completed</span>
              {selectedCourseCbtEligibleCount > 0 ? <span>{selectedCourseExamAttempts} CBT Done</span> : <span>Video only</span>}
              {selectedCourseCbtEligibleCount > 0 ? <span>{Math.max(selectedCourseCbtEligibleCount - selectedCourseExamAttempts, 0)} CBT Left</span> : <span>No CBT linked</span>}
              <span className="text-[#7a90b7]">{selectedCourseSnapshot.totalLessons} Total</span>
            </div>
          </section>

          <section className="rounded-[22px] bg-white px-[18px] py-[16px] shadow-[0_16px_34px_rgba(54,78,123,0.08)]">
            <div className="flex items-center justify-between gap-[12px]">
              <div>
                <p className="text-[16px] font-medium text-[#1c2d4c]">Auto play next video</p>
                <p className="mt-[6px] text-[14px] leading-[1.45] text-[#5d7092]">Automatically play the next lesson when the current one ends.</p>
              </div>
              <ToggleSwitch checked={autoplayEnabled} onToggle={() => setAutoplayEnabled((current) => !current)} testId="course-player-autoplay-toggle" />
            </div>
          </section>

          {nextStepDescriptor && renderNextStepCard('desktop')}

          <section className="rounded-[22px] bg-white px-[14px] py-[14px] shadow-[0_16px_34px_rgba(54,78,123,0.08)]">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-[8px] text-[16px] font-medium text-[#1c2d4c]">
                <FileText className="h-[16px] w-[16px] text-[#7a90b7]" />
                <span>Lesson Playlist</span>
              </div>
            </div>
            <div className="mt-[12px] space-y-[8px]">
              {filteredCourseSections.map((section, index) => {
                const expanded = currentExpandedSections.includes(section.id);
                return (
                  <div key={section.id} className="overflow-hidden rounded-[16px] border border-[#e7edf7]">
                    <button
                      type="button"
                      onClick={() => toggleSection(section.id)}
                      className="flex h-[48px] w-full items-center justify-between px-[12px] text-left"
                    >
                      <div className="flex items-center gap-[6px]">
                        <span className="text-[15px] font-semibold text-[#1b2d50]">{section.label}:</span>
                        <span className="text-[15px] text-[#44597f]">{section.title}</span>
                      </div>
                      <ChevronDown className={cn('h-[16px] w-[16px] text-[#7a8eae] transition', expanded ? 'rotate-180' : '')} />
                    </button>
                    {expanded && (
                      <div className={cn(index === 0 ? 'border-l-[4px] border-l-[#4a8ef5]' : 'border-l-[4px] border-l-transparent')}>
                        {section.lessons.map((entry) => {
                          const completed = Boolean(selectedCourseProgressMap.get(entry.lesson.id)?.completed);
                          const unlocked = Boolean(unlockMap.get(entry.lesson.id)?.unlocked);
                          return (
                            <button
                              key={entry.lesson.id}
                              type="button"
                              onClick={() => unlocked && openLesson(entry.lesson.id)}
                              className={cn(
                                'flex w-full items-center gap-[10px] px-[10px] py-[10px] text-left',
                                selectedLessonEntry?.lesson.id === entry.lesson.id ? 'bg-[linear-gradient(90deg,rgba(64,125,233,0.09)_0%,rgba(255,255,255,0.96)_100%)]' : 'bg-white',
                              )}
                            >
                              <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[#d1ddf4] bg-[#eef3fe] text-[#7092c8]">
                                {unlocked ? <Play className="ml-[1px] h-[15px] w-[15px] fill-current" /> : <Lock className="h-[13px] w-[13px]" />}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className={cn('truncate text-[14px] leading-[1.15]', selectedLessonEntry?.lesson.id === entry.lesson.id ? 'font-medium text-[#1b49d6]' : 'text-[#23385f]')}>
                                  {entry.lesson.title}
                                </p>
                                <p className="mt-[4px] text-[12px] text-[#6e80a1]">{formatDurationLabel(entry.lesson.durationMinutes)}</p>
                              </div>
                              {completed ? (
                                <CheckCircle2 className="h-[16px] w-[16px] shrink-0 text-[#26c085]" />
                              ) : !unlocked ? (
                                <Lock className="h-[14px] w-[14px] shrink-0 text-[#8fa2c3]" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

        </aside>
      </div>
    </div>
    );
  };

  const renderEmptyCoursesView = () => {
    if (isMobileLayout) {
      return (
        <div
          data-testid="course-figma-page"
          data-course-view="catalog"
          className="mobile-safe-screen min-h-[100dvh] overflow-x-hidden bg-[#f4f7ff] pb-[92px]"
        >
          <div className="mobile-safe-content mx-auto pb-[10px] pt-[10px]" style={uiFontStyle}>

            <header>
              <div className="flex items-center justify-between gap-[12px]">
                <h1 className="text-[18px] font-semibold leading-none text-[#1c2844]">All Courses</h1>
              </div>

              <label
                data-testid="course-catalog-search"
                className="mt-[12px] flex h-[40px] min-w-0 items-center gap-[10px] rounded-[14px] border border-[#d9e3f2] bg-white px-[13px] text-[13px] text-[#7f8fb0] shadow-[0_8px_18px_rgba(28,41,61,0.04)]"
              >
                <Search className="h-[17px] w-[17px]" />
                <input
                  disabled
                  placeholder="Search courses..."
                  className="w-full bg-transparent text-[#1f2d4e] outline-none placeholder:text-[#9aa7bc] disabled:opacity-100"
                />
              </label>
            </header>

            <section
              data-testid="course-catalog-empty"
              className="mt-[14px] overflow-hidden rounded-[18px] border border-[#dce6f5] bg-white shadow-[0_10px_24px_rgba(28,41,61,0.06)]"
            >
              <div className="bg-[#eaf1ff] px-[14px] py-[15px]">
                <div className="flex h-[48px] w-[48px] items-center justify-center rounded-[16px] bg-white text-[#2f6fe4] shadow-[0_8px_18px_rgba(47,111,228,0.14)]">
                  <BookOpen className="h-[22px] w-[22px]" />
                </div>
                <h2 className="mt-[12px] text-[18px] font-semibold leading-[1.18] text-[#172033]">No courses available</h2>
                <p className="mt-[7px] text-[12px] leading-[1.55] text-[#52637f]">
                  Published courses will appear here as soon as the catalog is ready.
                </p>
              </div>

              <div className="grid grid-cols-3 divide-x divide-[#edf2f9] border-t border-[#edf2f9] text-center">
                {[
                  ['0', 'Courses'],
                  ['0', 'Lessons'],
                  ['0', 'Tests'],
                ].map(([value, label]) => (
                  <div key={label} className="px-[8px] py-[10px]">
                    <p className="text-[15px] font-semibold leading-none text-[#1f2d4e]">{value}</p>
                    <p className="mt-[5px] text-[10px] font-medium text-[#71819c]">{label}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="course-figma-page"
        data-course-view="catalog"
        className="overflow-hidden rounded-[26px] border border-white/70 bg-white px-[24px] py-[28px] text-center shadow-[0_30px_90px_rgba(33,51,97,0.13)]"
      >
        <div
          data-testid="course-catalog-empty"
          className="mx-auto flex h-[54px] w-[54px] items-center justify-center rounded-[18px] bg-[#eef4ff] text-[#2f6fe4]"
        >
          <BookOpen className="h-[24px] w-[24px]" />
        </div>
        <h2 className="mt-[16px] text-[24px] font-semibold text-[#172033]">No courses available</h2>
        <p className="mx-auto mt-[8px] max-w-[520px] text-[14px] leading-6 text-[#607394]">
          Published courses will appear here as soon as the catalog is ready.
        </p>
      </div>
    );
  };

  return (
    <div className={cn('w-full bg-[#d7def1] p-[14px] lg:p-[18px]', isMobileLayout && overview.courses.length === 0 && 'bg-[#f4f7ff] p-0')} style={uiFontStyle}>
      <div className="mx-auto w-full max-w-[1440px]">
        {overview.courses.length === 0 ? renderEmptyCoursesView() : screen === 'catalog' && renderCatalogView()}
        {screen === 'course' && selectedCourse && renderCourseView()}
        {screen === 'lesson' && selectedCourse && selectedLessonEntry && renderLessonView()}
      </div>
    </div>
  );
};
