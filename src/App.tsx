import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BellRing,
  BookOpen,
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  EyeOff,
  Expand,
  Flame,
  Gauge,
  GraduationCap,
  Info,
  LayoutDashboard,
  LifeBuoy,
  LoaderCircle,
  Lock,
  LogOut,
  Mail,
  Menu,
  Mic,
  MicOff,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pause,
  Phone,
  PlayCircle,
  Plus,
  Radio,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Target,
  Trophy,
  Trash2,
  UserCircle2,
  Video,
  Wallet,
  X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from './AuthContext';
import { appleProvider, auth as firebaseAuth, googleProvider } from './firebase';
import { BrandLogo } from './components/BrandLogo';
import { ApiRequestError, EduService } from './EduService';
import { getRedirectResult, signInWithPopup, signInWithRedirect } from 'firebase/auth';
import {
  AiResponse,
  MockTest,
  MockQuestion,
  NotificationItem,
  PlatformOverview,
  ProtectedLessonPlayback,
  RegisterPayload,
  SavedTopic,
  TestAttemptResult,
} from './types';
import { cn } from './lib/utils';
import { LIVE_CLASSES_ENABLED } from './lib/featureFlags';

type TabKey = 'overview' | 'courses' | 'live' | 'tests' | 'revision' | 'analytics' | 'admin';

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const tabs: { id: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'courses', label: 'All Courses', icon: BookOpen },
  { id: 'live', label: 'Live Classes', icon: Radio },
  { id: 'tests', label: 'Mock Tests', icon: ClipboardCheck },
  { id: 'revision', label: 'Revision', icon: Brain },
  { id: 'analytics', label: 'Analytics', icon: Gauge },
  { id: 'admin', label: 'Admin', icon: ShieldCheck },
];

const LazyTestSeriesFigmaTab = lazy(() =>
  import('./components/TestSeriesFigmaTab').then((module) => ({ default: module.TestSeriesFigmaTab })),
);
const LazyCourseFigmaTab = lazy(() =>
  import('./components/CourseFigmaTab').then((module) => ({ default: module.CourseFigmaTab })),
);
const LazyOverviewFigmaTab = lazy(() =>
  import('./components/OverviewFigmaTab').then((module) => ({ default: module.OverviewFigmaTab })),
);
const LazyLiveClassesFigmaTab = lazy(() =>
  import('./components/LiveClassesFigmaTab').then((module) => ({ default: module.LiveClassesFigmaTab })),
);
const LazyAdminCourseManager = lazy(() =>
  import('./components/AdminCourseManager').then((module) => ({ default: module.AdminCourseManager })),
);
const LazyAdminModuleManager = lazy(() =>
  import('./components/AdminModuleManager').then((module) => ({ default: module.AdminModuleManager })),
);
const LazyAdminPdfUpload = lazy(() =>
  import('./components/AdminPdfUpload').then((module) => ({ default: module.AdminPdfUpload })),
);
const LazyAdminVideoUpload = lazy(() =>
  import('./components/AdminVideoUpload').then((module) => ({ default: module.AdminVideoUpload })),
);
const LazyAdminEditorialVideoUpload = lazy(() =>
  import('./components/AdminEditorialVideoUpload').then((module) => ({ default: module.AdminEditorialVideoUpload })),
);
const LazyAdminMockTestVideoUpload = lazy(() =>
  import('./components/AdminMockTestVideoUpload').then((module) => ({ default: module.AdminMockTestVideoUpload })),
);
const LazyAdminPaymentControlCenter = lazy(() =>
  import('./components/AdminPaymentControlCenter').then((module) => ({ default: module.AdminPaymentControlCenter })),
);
const LazyAdminSupportCenter = lazy(() =>
  import('./components/AdminSupportCenter').then((module) => ({ default: module.AdminSupportCenter })),
);
const LazyAnalyticsTrendChart = lazy(() =>
  import('./components/AnalyticsTrendChart').then((module) => ({ default: module.AnalyticsTrendChart })),
);

const mobilePrimaryTabIds: TabKey[] = ['overview', 'courses', 'live', 'tests'];
const enabledMobilePrimaryTabIds = LIVE_CLASSES_ENABLED
  ? mobilePrimaryTabIds
  : mobilePrimaryTabIds.filter((tabId) => tabId !== 'live');

const shellTabMeta: Record<TabKey, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: 'Overview',
    title: 'Your dashboard',
    description: 'Continue your prep with less noise.',
  },
  courses: {
    eyebrow: 'Courses workspace',
    title: 'Study without losing context',
    description: 'Move from subject selection to lesson playback with less scrolling, less noise, and faster recovery.',
  },
  live: {
    eyebrow: 'Live classes',
    title: 'Join the classroom the moment it starts',
    description: 'Live sessions, waiting rooms, classroom controls, chat, and participant sync now stay inside one connected flow.',
  },
  tests: {
    eyebrow: 'Practice zone',
    title: 'Attempt mocks with a cleaner runway',
    description: 'Keep timed practice, review, and progress signals focused so the test flow feels intentional.',
  },
  revision: {
    eyebrow: 'Revision center',
    title: 'Turn saved lessons into repeatable revision',
    description: 'Weak topics, saved lessons, and mistake recovery should feel like one connected workflow.',
  },
  analytics: {
    eyebrow: 'Progress analytics',
    title: 'Read performance without dashboard fatigue',
    description: 'Important trends should stand out first so students can act on them instead of decoding the screen.',
  },
  admin: {
    eyebrow: 'Admin',
    title: 'Administration',
    description: 'Manage platform content and operations.',
  },
};

const formatDateTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));

const formatTimeLeft = (seconds: number) => {
  const minutes = Math.max(Math.floor(seconds / 60), 0);
  const remainingSeconds = Math.max(seconds % 60, 0);
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
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

const formatDeviceLabel = (value: unknown) => {
  if (value && typeof value === 'object') {
    const device = value as Record<string, unknown>;
    const parts = [
      typeof device.app === 'string' ? device.app : '',
      typeof device.browser === 'string' ? device.browser : '',
      typeof device.platform === 'string' ? device.platform : '',
      typeof device.id === 'string' ? device.id : '',
    ].filter(Boolean);
    const objectLabel = parts.join(' • ');
    if (objectLabel) {
      return objectLabel;
    }
  }

  const label = String(value || '').trim();
  const normalized = label.toLowerCase();
  if (!label) {
    return 'Web Browser';
  }
  if (
    normalized.includes('chrome')
    || normalized.includes('safari')
    || normalized.includes('firefox')
    || normalized.includes('browser')
  ) {
    return 'Web Browser';
  }
  if (label.length > 22) {
    return `${label.slice(0, 22)}...`;
  }
  return label;
};

const DeferredPanelFallback = ({
  label,
  minHeightClass = 'min-h-[220px]',
}: {
  label: string;
  minHeightClass?: string;
}) => (
  <div
    aria-busy="true"
    className={cn(
      'flex items-center justify-center gap-3 rounded-[24px] border border-[var(--line)] bg-white/92 px-5 py-8 text-sm font-medium text-[var(--ink-soft)] shadow-[0_12px_30px_rgba(15,23,42,0.05)]',
      minHeightClass,
    )}
  >
    <LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent-rust)]" />
    <span>Loading {label}...</span>
  </div>
);

const CBT_BRAND_NAME = 'VaronEnglish';
const LIVE_FONT_STACK = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const SOCIAL_REDIRECT_PROVIDER_KEY = 'edumaster.social.redirect.provider';
const ADMIN_SECTION_STORAGE_KEY = 'edumaster.admin.active-section';
const BROWSER_ALERTS_ENABLED_STORAGE_KEY = 'edumaster.browser-alerts.enabled';
const NOTIFICATION_SERVICE_WORKER_PATH = '/notification-sw.js';
type BrowserAlertPermissionState = NotificationPermission | 'unsupported';

const getStoredBooleanPreference = (key: string, fallback = false) => {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
  if (raw === null) {
    return fallback;
  }

  return raw === 'true';
};

const setStoredBooleanPreference = (key: string, value: boolean) => {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(key, value ? 'true' : 'false');
};

const getBrowserAlertPermissionState = (): BrowserAlertPermissionState => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }

  return Notification.permission;
};

const resolveNotificationTargetUrl = (notification: NotificationItem) => {
  if (notification.actionUrl) {
    return notification.actionUrl;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  return `${window.location.origin}/?tab=overview`;
};

const playNotificationChime = async (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  if (typeof window === 'undefined') {
    return;
  }

  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  if (!audioContextRef.current) {
    audioContextRef.current = new AudioContextCtor();
  }

  const audioContext = audioContextRef.current;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(660, audioContext.currentTime + 0.18);
  gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.24);
};

const getInitials = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'VE';

const TeacherAvatar = ({ initials = 'RS' }: { initials?: string }) => (
  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(180deg,#d8edf9_0%,#5fb7d8_100%)] text-[12px] font-semibold text-white shadow-[0_8px_20px_rgba(14,27,42,0.08)]">
    {initials}
  </div>
);

const buildSavedTopicsKey = (userId: string) => `edumaster.saved-topics.${userId}`;

const flattenCourseLessons = (course: PlatformOverview['courses'][number]) =>
  (course.modules || []).flatMap((module) => ([
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

const formatEventLabel = (eventType: string) =>
  eventType
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

const formatShortDate = (value: Date | string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
  }).format(typeof value === 'string' ? new Date(value) : value);

const formatSessionLastUsed = (value?: string | null) => {
  if (!value) {
    return 'Recently active';
  }

  const target = new Date(value);
  if (Number.isNaN(target.getTime())) {
    return 'Recently active';
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfTarget.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays <= 0) {
    return 'Today';
  }

  if (diffDays === 1) {
    return 'Yesterday';
  }

  return `${diffDays} days ago`;
};

const getSessionDeviceIcon = (deviceLabel: string) => {
  const normalized = String(deviceLabel || '').toLowerCase();
  if (normalized.includes('iphone') || normalized.includes('android') || normalized.includes('mobile') || normalized.includes('phone')) {
    return Radio;
  }
  return LayoutDashboard;
};

const buildCourseFallbackArtwork = (title: string) => {
  const safeTitle = String(title || 'VaronEnglish Course').slice(0, 28);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240" fill="none">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="320" y2="240" gradientUnits="userSpaceOnUse">
          <stop stop-color="#17385d"/>
          <stop offset="1" stop-color="#1b8cb6"/>
        </linearGradient>
      </defs>
      <rect width="320" height="240" rx="28" fill="url(#g)"/>
      <circle cx="250" cy="64" r="42" fill="rgba(255,255,255,0.12)"/>
      <circle cx="78" cy="178" r="56" fill="rgba(255,255,255,0.08)"/>
      <text x="28" y="168" fill="#ffffff" font-size="28" font-family="Georgia, serif" font-weight="700">${safeTitle}</text>
      <text x="28" y="204" fill="rgba(255,255,255,0.72)" font-size="14" font-family="Arial, sans-serif">VaronEnglish course</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

const formatLargeMetric = (value: number) =>
  new Intl.NumberFormat('en-IN').format(Math.max(Math.round(value || 0), 0));

const buildInitials = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'VE';

const buildStudyArtwork = (label: string) => {
  const safeLabel = String(label || 'Study').slice(0, 18);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="280" height="180" viewBox="0 0 280 180" fill="none">
      <defs>
        <linearGradient id="bg" x1="16" y1="14" x2="252" y2="170" gradientUnits="userSpaceOnUse">
          <stop stop-color="#7dd1ff"/>
          <stop offset="0.55" stop-color="#6bb0ff"/>
          <stop offset="1" stop-color="#243e7a"/>
        </linearGradient>
        <radialGradient id="sun" cx="0" cy="0" r="1" gradientTransform="translate(168 84) rotate(90) scale(66)">
          <stop stop-color="#fff6b2"/>
          <stop offset="1" stop-color="#fff6b2" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="280" height="180" rx="28" fill="url(#bg)"/>
      <rect x="0" y="120" width="280" height="60" rx="0" fill="#7cb889"/>
      <rect x="0" y="136" width="280" height="44" rx="0" fill="#527d63"/>
      <circle cx="168" cy="84" r="64" fill="url(#sun)"/>
      <path d="M165 124c7-17 7-33 0-50 14 16 20 33 15 51 11-12 16-27 16-43 8 17 7 36-6 58 10-5 17-14 21-24-3 23-18 41-46 54-31-15-43-35-38-60 5 11 13 20 23 28-11-17-15-35-10-52 3 15 9 28 18 38 1-15 3-29 7-41z" fill="#fff1a1"/>
      <text x="18" y="28" fill="rgba(255,255,255,0.82)" font-size="14" font-family="Arial, sans-serif">${safeLabel}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

const buildCoachPortraitArtwork = (name: string) => {
  const safeName = String(name || 'Tutor').slice(0, 18);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180" fill="none">
      <defs>
        <linearGradient id="bg" x1="20" y1="12" x2="154" y2="166" gradientUnits="userSpaceOnUse">
          <stop stop-color="#dff4ff"/>
          <stop offset="1" stop-color="#83c9ff"/>
        </linearGradient>
      </defs>
      <rect width="180" height="180" rx="34" fill="url(#bg)"/>
      <circle cx="90" cy="72" r="30" fill="#f5c29b"/>
      <path d="M58 64c2-22 16-34 32-34 14 0 28 11 33 27-11-8-20-10-33-10-12 0-22 6-32 17z" fill="#244070"/>
      <path d="M49 154c7-28 23-41 41-41 20 0 36 14 41 41" fill="#2b4c85"/>
      <path d="M66 118l24 18 24-18" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/>
      <text x="90" y="168" fill="rgba(20,46,86,0.7)" font-size="12" font-family="Arial, sans-serif" text-anchor="middle">${safeName}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

type SearchTarget =
  | { id: string; kind: 'course'; title: string; subtitle: string; tab: TabKey; courseId: string; lessonId?: string | null }
  | { id: string; kind: 'lesson'; title: string; subtitle: string; tab: TabKey; courseId: string; lessonId: string }
  | { id: string; kind: 'test'; title: string; subtitle: string; tab: TabKey }
  | { id: string; kind: 'saved'; title: string; subtitle: string; tab: TabKey; courseId: string; lessonId: string };

type NotificationNavigationTarget = {
  tab: TabKey;
  liveClassId?: string | null;
  courseId?: string | null;
  lessonId?: string | null;
  doubtThreadId?: string | null;
  reportId?: string | null;
  supportPanel?: 'doubts' | 'report' | null;
};

type RevisionDayPlan = {
  dateLabel: string;
  title: string;
  summary: string;
  actions: string[];
};

type EditableAssessmentQuestion = {
  id: string;
  questionText: string;
  options: string[];
  correctOptions: number[];
  explanation: string;
  marks: number;
  topic: string;
};

const createEditableAssessmentQuestion = (seed?: Partial<MockQuestion>): EditableAssessmentQuestion => {
  const rawOptions = Array.isArray(seed?.options) ? seed.options.map((option) => String(option || '')) : [];
  const options = [...rawOptions];
  while (options.length < 4) {
    options.push('');
  }

  return {
    id: String(seed?.id || `question_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    questionText: String(seed?.questionText || ''),
    options,
    correctOptions: Array.isArray(seed?.correctOptions) && seed.correctOptions.length > 0
      ? seed.correctOptions
        .map((optionIndex) => Number(optionIndex))
        .filter((optionIndex) => Number.isInteger(optionIndex) && optionIndex >= 0)
      : Number.isFinite(Number(seed?.correctOption))
        ? [Number(seed?.correctOption)]
        : [0],
    explanation: String(seed?.explanation || ''),
    marks: Number(seed?.marks || 1),
    topic: String(seed?.topic || ''),
  };
};

const toEditableAssessmentQuestions = (questions: MockQuestion[] = []) =>
  questions.length > 0 ? questions.map((question) => createEditableAssessmentQuestion(question)) : [createEditableAssessmentQuestion()];

const searchKindLabels: Record<SearchTarget['kind'], string> = {
  course: 'Course',
  lesson: 'Lesson',
  test: 'Mock test',
  saved: 'Saved topic',
};

const readStringPayload = (payload: Record<string, unknown> | undefined, key: string) => {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const getNotificationNavigationTarget = (notification: NotificationItem): NotificationNavigationTarget | null => {
  const payload = notification.payload || {};
  const payloadTab = readStringPayload(payload, 'tab');
  const liveClassId = readStringPayload(payload, 'liveClassId') || notification.entityId || null;
  const courseId = readStringPayload(payload, 'courseId') || null;
  const lessonId = readStringPayload(payload, 'lessonId') || null;
  const doubtThreadId = readStringPayload(payload, 'doubtThreadId') || null;
  const reportId = readStringPayload(payload, 'reportId') || null;
  const supportPanel = readStringPayload(payload, 'supportPanel') as 'doubts' | 'report' | null;

  if (payloadTab && payloadTab in shellTabMeta) {
    return {
      tab: payloadTab as TabKey,
      liveClassId,
      courseId,
      lessonId,
      doubtThreadId,
      reportId,
      supportPanel,
    };
  }

  const actionUrl = String(notification.actionUrl || '').trim();
  if (actionUrl) {
    try {
      const parsedUrl = new URL(actionUrl, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
      const tab = parsedUrl.searchParams.get('tab');
      if (tab && tab in shellTabMeta) {
        return {
          tab: tab as TabKey,
          liveClassId: parsedUrl.searchParams.get('liveClassId') || liveClassId,
          courseId: parsedUrl.searchParams.get('courseId') || courseId,
          lessonId: parsedUrl.searchParams.get('lessonId') || lessonId,
          doubtThreadId: parsedUrl.searchParams.get('doubtThreadId') || doubtThreadId,
          reportId: parsedUrl.searchParams.get('reportId') || reportId,
          supportPanel: (parsedUrl.searchParams.get('supportPanel') as 'doubts' | 'report' | null) || supportPanel,
        };
      }
    } catch {
      // Fall through to type-based routing.
    }
  }

  if (String(notification.type || '').startsWith('live-class')) {
    return { tab: 'live', liveClassId };
  }
  if (courseId || String(notification.type || '').includes('course')) {
    return { tab: 'courses', courseId, lessonId, doubtThreadId, reportId, supportPanel };
  }
  if (String(notification.type || '').includes('test')) {
    return { tab: 'tests' };
  }
  if (String(notification.type || '').includes('revision')) {
    return { tab: 'revision' };
  }

  return null;
};

const HeaderInsightCard = ({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) => (
  <div className="rounded-[26px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-4 shadow-[0_20px_48px_rgba(15,23,42,0.08)]">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--ink-soft)]">{label}</p>
        <p className="mt-2 line-clamp-2 text-sm font-semibold leading-6 text-[var(--ink)] sm:text-base">{value}</p>
      </div>
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--accent-cream)_0%,#ffffff_100%)] text-[var(--accent-rust)] shadow-[0_12px_28px_rgba(22,152,212,0.16)] ring-1 ring-white/90">
        <Icon className="h-5 w-5" />
      </div>
    </div>
    <p className="mt-3 text-xs leading-6 text-[var(--ink-soft)]/95">{hint}</p>
  </div>
);

const SearchPanel = ({
  open,
  query,
  results,
  onSelect,
  onClose,
}: {
  open: boolean;
  query: string;
  results: SearchTarget[];
  onSelect: (target: SearchTarget) => void;
  onClose: () => void;
}) => (
  <AnimatePresence>
    {open && (
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="absolute left-0 right-0 top-[calc(100%+12px)] z-40 overflow-hidden rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.96)_100%)] shadow-[0_32px_96px_rgba(15,23,42,0.16)] backdrop-blur"
      >
        <div className="border-b border-[var(--line)] bg-[linear-gradient(180deg,rgba(255,255,255,1)_0%,rgba(234,247,255,0.96)_100%)] px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--ink-soft)]">
                {query.trim() ? 'Search results' : 'Suggested shortcuts'}
              </p>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">
                {query.trim()
                  ? `Jump to lessons, mocks, and saved topics from one place.`
                  : 'Start with the current lesson, a saved topic, or your next practice task.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--line)] bg-white text-[var(--ink-soft)] transition hover:border-[var(--accent-rust)]/30 hover:bg-[var(--accent-cream)] hover:text-[var(--ink)]"
              aria-label="Close search"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="max-h-[min(68vh,34rem)] overflow-y-auto px-3 py-3 sm:px-4">
          {results.length > 0 ? (
            <div className="space-y-2">
              {results.map((target) => (
                <button
                  key={target.id}
                  data-testid={`search-result-${target.kind}`}
                  onClick={() => onSelect(target)}
                  className="flex w-full items-start justify-between gap-4 rounded-[22px] border border-transparent px-4 py-4 text-left transition hover:border-[var(--accent-rust)]/16 hover:bg-[linear-gradient(180deg,#ffffff_0%,var(--accent-cream)_100%)]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[var(--accent-cream)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--accent-rust)]">
                        {searchKindLabels[target.kind]}
                      </span>
                    </div>
                    <p className="mt-3 text-sm font-semibold text-[var(--ink)] sm:text-base">{target.title}</p>
                    <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{target.subtitle}</p>
                  </div>
                  <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--accent-cream)_0%,#ffffff_100%)] text-[var(--accent-rust)] shadow-[0_10px_24px_rgba(22,152,212,0.12)]">
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-[24px] border border-dashed border-[var(--line)] px-5 py-6 text-sm leading-7 text-[var(--ink-soft)]">
              No matching items. Try an exam name, lesson topic, or mock title.
            </div>
          )}
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);

const MobileMoreSheet = ({
  open,
  tabs,
  activeTab,
  onSelect,
  onClose,
  onLogout,
  onOpenProfile,
  learnerName,
  learnerEmail,
  learnerPhone,
  learnerInitials,
}: {
  open: boolean;
  tabs: { id: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[];
  activeTab: TabKey;
  onSelect: (tab: TabKey) => void;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onOpenProfile: () => void;
  learnerName: string;
  learnerEmail: string;
  learnerPhone: string;
  learnerInitials: string;
}) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.button
          type="button"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-[#07111f]/62 backdrop-blur-[3px] lg:hidden"
          aria-label="Close profile menu"
        />
        <motion.div
          initial={{ x: '-104%' }}
          animate={{ x: 0 }}
          exit={{ x: '-104%' }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="fixed inset-y-0 left-0 z-50 flex w-[84vw] max-w-[384px] flex-col overflow-y-auto bg-[#fbfdff] text-[#17233f] shadow-[24px_0_70px_rgba(15,23,42,0.28)] lg:hidden"
        >
          <div className="border-b border-[#dbe5f5] bg-[linear-gradient(180deg,#eef5ff_0%,#dfe9f7_100%)] px-5 pb-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
            <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-4">
              <div className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-[22px] bg-[#20262c] text-[29px] font-bold text-white shadow-[0_14px_30px_rgba(15,23,42,0.20)]">
                {learnerInitials}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[20px] font-bold leading-[1.15] text-[#172033]">{learnerName}</p>
                <p className="mt-2 truncate text-[13px] leading-5 text-[#516786]">{learnerEmail}</p>
                {learnerPhone && <p className="mt-1 truncate text-[13px] leading-5 text-[#516786]">{learnerPhone}</p>}
                <button type="button" onClick={onOpenProfile} className="mt-2.5 text-[14px] font-bold text-[#2f6fe4]">
                  View Profile
                </button>
              </div>
            </div>
          </div>

          <div className="py-3">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-testid={`mobile-more-${tab.id}`}
                onClick={() => onSelect(tab.id)}
                className={cn(
                  'mx-3 flex min-h-[58px] w-[calc(100%-1.5rem)] items-center gap-4 rounded-[18px] px-4 text-left text-[15px] transition',
                  activeTab === tab.id
                    ? 'bg-[#eef4ff] font-bold text-[#1b5fe3] shadow-[0_10px_24px_rgba(45,110,229,0.10)]'
                    : 'font-semibold text-[#29364a] hover:bg-[#f3f7fc]',
                )}
              >
                <span
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px]',
                    activeTab === tab.id ? 'bg-white text-[#1b5fe3]' : 'bg-[#f1f5fb] text-[#53647d]',
                  )}
                >
                  <tab.icon className="h-[20px] w-[20px]" />
                </span>
                <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                <ChevronRight className={cn('h-5 w-5 shrink-0', activeTab === tab.id ? 'text-[#1b5fe3]' : 'text-[#8c9ab0]')} />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="mx-5 mb-6 mt-auto flex items-center gap-4 rounded-[18px] border border-[#dfe7f4] bg-white px-4 py-4 text-[15px] font-semibold text-[#29364a] shadow-[0_12px_28px_rgba(31,45,78,0.05)]"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </motion.div>
      </>
    )}
  </AnimatePresence>
);

const MobileNotificationSheet = ({
  open,
  notifications,
  onClose,
  onOpen,
  onMarkAllRead,
  browserAlertsSupported,
  browserAlertsEnabled,
  notificationPermission,
  notificationPermissionBusy,
  onEnableBrowserAlerts,
  onDisableBrowserAlerts,
  onTestBrowserAlert,
}: {
  open: boolean;
  notifications: NotificationItem[];
  onClose: () => void;
  onOpen: (notification: NotificationItem) => void;
  onMarkAllRead: () => void;
  browserAlertsSupported: boolean;
  browserAlertsEnabled: boolean;
  notificationPermission: BrowserAlertPermissionState;
  notificationPermissionBusy: boolean;
  onEnableBrowserAlerts: () => void;
  onDisableBrowserAlerts: () => void;
  onTestBrowserAlert: () => void;
}) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.button
          type="button"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
	          className="fixed inset-0 z-40 bg-[#071833]/48 backdrop-blur-[2px]"
          aria-label="Close notifications"
        />
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
	          className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+92px)] z-50 max-h-[70dvh] overflow-hidden rounded-[24px] border border-[#dbe6f6] bg-[#fbfdff] shadow-[0_28px_90px_rgba(15,34,68,0.26)] sm:left-auto sm:right-6 sm:top-24 sm:w-[420px] lg:w-[440px]"
          style={{ fontFamily: LIVE_FONT_STACK }}
        >
	          <div className="flex items-center justify-between border-b border-[#dfe8f6] bg-[linear-gradient(180deg,#f7fbff_0%,#eef5ff_100%)] px-5 py-4">
            <div>
	              <p className="text-[16px] font-bold text-[#17233f]">Notifications</p>
	              <p className="mt-1 text-[12px] text-[#687a99]">{notifications.length ? `${notifications.length} updates` : 'No updates right now'}</p>
	            </div>
            <div className="flex items-center gap-2">
              <button type="button" data-testid="notifications-read-all" onClick={onMarkAllRead} className="rounded-full border border-[#dbe6f6] bg-white px-3 py-2 text-[11px] font-semibold text-[#2f6fe4]">
                Read all
              </button>
	            <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-[#dbe6f6] bg-white text-[#53647d]" aria-label="Close notifications">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="max-h-[calc(70dvh-74px)] overflow-y-auto p-3">
            <div className="mb-3 rounded-[18px] border border-[#dbe6f6] bg-[linear-gradient(180deg,#f8fbff_0%,#eef5ff_100%)] px-4 py-4">
              <p className="text-[13px] font-semibold text-[#17233f]">Browser alerts</p>
              {!browserAlertsSupported && (
                <p className="mt-2 text-[12px] leading-5 text-[#607394]">
                  This browser does not support popup notifications here.
                </p>
              )}
              {browserAlertsSupported && notificationPermission === 'granted' && browserAlertsEnabled && (
                <>
                  <p className="mt-2 text-[12px] leading-5 text-[#607394]">
                    Popup alerts and sound are on. New doubts, reports, and replies will alert you while Chrome is open.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={onTestBrowserAlert}
                      className="rounded-full border border-[#dbe6f6] bg-white px-3 py-2 text-[11px] font-semibold text-[#2f6fe4]"
                    >
                      Test alert
                    </button>
                    <button
                      type="button"
                      onClick={onDisableBrowserAlerts}
                      className="rounded-full border border-[#dbe6f6] bg-white px-3 py-2 text-[11px] font-semibold text-[#53647d]"
                    >
                      Turn off
                    </button>
                  </div>
                </>
              )}
              {browserAlertsSupported && notificationPermission === 'default' && (
                <>
                  <p className="mt-2 text-[12px] leading-5 text-[#607394]">
                    Allow Chrome alerts so you can hear a sound and see a popup when a student raises a doubt or report.
                  </p>
                  <button
                    type="button"
                    onClick={onEnableBrowserAlerts}
                    disabled={notificationPermissionBusy}
                    className="mt-3 rounded-full border border-[#2f6fe4] bg-[#2f6fe4] px-3 py-2 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {notificationPermissionBusy ? 'Enabling…' : 'Enable alerts'}
                  </button>
                </>
              )}
              {browserAlertsSupported && notificationPermission === 'denied' && (
                <p className="mt-2 text-[12px] leading-5 text-[#607394]">
                  Chrome alerts are blocked. Allow notifications for this site in browser settings, then reopen this panel.
                </p>
              )}
            </div>
            {notifications.length > 0 ? notifications.map((notification) => (
              <button
                key={notification._id}
                data-testid={`notification-row-${notification.isRead ? 'read' : 'unread'}`}
                type="button"
                onClick={() => onOpen(notification)}
	                className={`flex w-full items-start gap-3 rounded-[16px] border px-3 py-3 text-left transition hover:border-[#dbe6f6] hover:bg-[#f4f8ff] ${notification.isRead ? 'border-transparent bg-white/80' : 'border-[#dbe6f6] bg-[#eef5ff]'}`}
	              >
	                <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[13px] bg-[#eef4ff] text-[#2f6fe4]">
	                  <BellRing className="h-4 w-4" />
	                </span>
	                <span className="min-w-0 flex-1">
	                  <span className="block text-[14px] font-semibold text-[#17233f]">{notification.title}</span>
	                  <span className="mt-1 block text-[13px] leading-5 text-[#607394]">{notification.message}</span>
	                  {notification.actionLabel && (
	                    <span className="mt-2 inline-flex text-[12px] font-semibold text-[#2f6fe4]">{notification.actionLabel}</span>
	                  )}
	                </span>
	                <ChevronRight className="mt-2 h-5 w-5 shrink-0 text-[#8b9ab3]" />
              </button>
            )) : (
	              <div className="rounded-[16px] border border-dashed border-[#d8e2f0] bg-white px-4 py-6 text-center text-[13px] text-[#64748b]">
                You are all caught up.
              </div>
            )}
          </div>
        </motion.div>
      </>
    )}
  </AnimatePresence>
);

const InAppNotificationToasts = ({
  notifications,
  onOpen,
  onDismiss,
}: {
  notifications: NotificationItem[];
  onOpen: (notification: NotificationItem) => void;
  onDismiss: (notificationId: string) => void;
}) => (
  <div className="pointer-events-none fixed right-4 top-[calc(env(safe-area-inset-top)+18px)] z-[80] flex w-[min(92vw,380px)] flex-col gap-3">
    <AnimatePresence>
      {notifications.map((notification) => (
        <motion.div
          key={notification._id}
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.96 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="pointer-events-auto overflow-hidden rounded-[20px] border border-[#dbe6f6] bg-white/98 shadow-[0_20px_48px_rgba(15,23,42,0.18)] backdrop-blur-md"
        >
          <div className="flex items-start gap-3 px-4 py-4">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#eef5ff] text-[#2f6fe4]">
              <BellRing className="h-4 w-4" />
            </span>
            <button
              type="button"
              onClick={() => onOpen(notification)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block text-[14px] font-semibold text-[#17233f]">{notification.title}</span>
              <span className="mt-1 block text-[12px] leading-5 text-[#607394]">{notification.message}</span>
              <span className="mt-2 inline-flex text-[11px] font-semibold uppercase tracking-[0.08em] text-[#2f6fe4]">
                Tap to open
              </span>
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDismiss(notification._id);
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#dbe6f6] bg-white text-[#607394]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  </div>
);

const ProfileEditorSheet = ({
  open,
  form,
  passwordForm,
  profileSaving,
  passwordSaving,
  profileError,
  passwordError,
  onProfileChange,
  onPasswordChange,
  onClose,
  onSaveProfile,
  onSavePassword,
}: {
  open: boolean;
  form: { name: string; email: string; mobileNumber: string };
  passwordForm: { currentPassword: string; newPassword: string; confirmPassword: string };
  profileSaving: boolean;
  passwordSaving: boolean;
  profileError: string | null;
  passwordError: string | null;
  onProfileChange: (field: 'name' | 'mobileNumber', value: string) => void;
  onPasswordChange: (field: 'currentPassword' | 'newPassword' | 'confirmPassword', value: string) => void;
  onClose: () => void;
  onSaveProfile: () => void;
  onSavePassword: () => void;
}) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.button
          type="button"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-[60] bg-slate-950/45 backdrop-blur-[2px]"
          aria-label="Close profile editor"
        />
        <motion.div
          initial={{ y: 28, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 28, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="fixed inset-x-3 bottom-3 z-[70] overflow-hidden rounded-[24px] bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)] sm:left-1/2 sm:right-auto sm:w-[430px] sm:-translate-x-1/2"
          style={{ fontFamily: LIVE_FONT_STACK }}
        >
          <div className="bg-[#f4f7fc] px-5 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[18px] font-bold text-[#20242d]">Edit profile</p>
                <p className="mt-1 text-[13px] leading-5 text-[#64748b]">Update the details shown in your account menu.</p>
              </div>
              <button type="button" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#e1e8f3] bg-white text-[#53647d]" aria-label="Close profile editor">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="space-y-4 px-5 py-5">
            <div className="space-y-4 rounded-[18px] border border-[#e2e8f5] bg-[#fbfdff] p-4">
              <div>
                <p className="text-[14px] font-bold text-[#20242d]">Profile details</p>
                <p className="mt-1 text-[12px] leading-5 text-[#64748b]">Email is locked after registration. You can update your mobile number here.</p>
              </div>

              <label className="block">
                <span className="text-[12px] font-semibold text-[#53647d]">Full name</span>
                <span className="mt-2 flex h-12 items-center gap-3 rounded-[14px] border border-[#d9e3f2] bg-white px-4 text-[#8a98ad] focus-within:border-[#2f6fe4]">
                  <UserCircle2 className="h-5 w-5 shrink-0" />
                  <input
                    value={form.name}
                    onChange={(event) => onProfileChange('name', event.target.value)}
                    placeholder="Enter your name"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-[#20242d] outline-none placeholder:text-[#9aa7bc]"
                  />
                </span>
              </label>

              <label className="block">
                <span className="text-[12px] font-semibold text-[#53647d]">Email</span>
                <span className="mt-2 flex h-12 items-center gap-3 rounded-[14px] border border-[#d9e3f2] bg-[#f8fafc] px-4 text-[#8a98ad]">
                  <Mail className="h-5 w-5 shrink-0" />
                  <input
                    data-testid="profile-email-input"
                    value={form.email}
                    readOnly
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-[#64748b] outline-none"
                  />
                  <Lock className="h-4 w-4 shrink-0 text-[#94a3b8]" />
                </span>
              </label>

              <label className="block">
                <span className="text-[12px] font-semibold text-[#53647d]">Mobile number</span>
                <span className="mt-2 flex h-12 items-center gap-3 rounded-[14px] border border-[#d9e3f2] bg-white px-4 text-[#8a98ad] focus-within:border-[#2f6fe4]">
                  <Phone className="h-5 w-5 shrink-0" />
                  <input
                    data-testid="profile-mobile-input"
                    value={form.mobileNumber}
                    onChange={(event) => onProfileChange('mobileNumber', event.target.value)}
                    placeholder="Enter your mobile number"
                    inputMode="tel"
                    autoComplete="tel"
                    className="min-w-0 flex-1 bg-transparent text-[16px] text-[#20242d] outline-none placeholder:text-[#9aa7bc]"
                  />
                </span>
              </label>

              {profileError && <p className="rounded-[12px] border border-[#fecaca] bg-[#fff1f2] px-3 py-2 text-[13px] text-[#b91c1c]">{profileError}</p>}

              <button
                type="button"
                onClick={onSaveProfile}
                disabled={profileSaving}
                className="flex h-12 w-full items-center justify-center rounded-[14px] bg-[#2f6fe4] text-[15px] font-bold text-white shadow-[0_14px_24px_rgba(47,111,228,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {profileSaving ? <LoaderCircle className="h-5 w-5 animate-spin" /> : 'Save profile'}
              </button>
            </div>

            <div className="space-y-4 rounded-[18px] border border-[#e2e8f5] bg-[#fbfdff] p-4">
              <div>
                <p className="text-[14px] font-bold text-[#20242d]">Change password</p>
                <p className="mt-1 text-[12px] leading-5 text-[#64748b]">You will be signed out after changing your password.</p>
              </div>

              {[
                ['currentPassword', 'Current password', 'Enter current password'],
                ['newPassword', 'New password', 'Enter new password'],
                ['confirmPassword', 'Confirm password', 'Re-enter new password'],
              ].map(([field, label, placeholder]) => (
                <label key={field} className="block">
                  <span className="text-[12px] font-semibold text-[#53647d]">{label}</span>
                  <span className="mt-2 flex h-12 items-center gap-3 rounded-[14px] border border-[#d9e3f2] bg-white px-4 text-[#8a98ad] focus-within:border-[#2f6fe4]">
                    <Lock className="h-5 w-5 shrink-0" />
                    <input
                      type="password"
                      value={passwordForm[field as keyof typeof passwordForm]}
                      onChange={(event) => onPasswordChange(field as 'currentPassword' | 'newPassword' | 'confirmPassword', event.target.value)}
                      placeholder={placeholder}
                      className="min-w-0 flex-1 bg-transparent text-[16px] text-[#20242d] outline-none placeholder:text-[#9aa7bc]"
                    />
                  </span>
                </label>
              ))}

              {passwordError && <p className="rounded-[12px] border border-[#fecaca] bg-[#fff1f2] px-3 py-2 text-[13px] text-[#b91c1c]">{passwordError}</p>}

              <button
                type="button"
                onClick={onSavePassword}
                disabled={passwordSaving}
                className="flex h-12 w-full items-center justify-center rounded-[14px] border border-[#d9e3f2] bg-white text-[15px] font-bold text-[#20242d] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {passwordSaving ? <LoaderCircle className="h-5 w-5 animate-spin" /> : 'Change password'}
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="flex h-12 w-full items-center justify-center rounded-[14px] border border-[#d9e3f2] bg-white text-[15px] font-bold text-[#53647d]"
            >
              Close
            </button>
          </div>
        </motion.div>
      </>
    )}
  </AnimatePresence>
);

const SectionHeader = ({ title, caption, action }: { title: string; caption: string; action?: React.ReactNode }) => (
  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--ink-soft)]/95">{caption}</p>
      <h2 className="mt-2 text-xl font-semibold leading-tight text-[var(--ink)] sm:text-2xl">{title}</h2>
    </div>
    {action}
  </div>
);

const SurfaceCard = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={cn('overflow-hidden rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,var(--surface-strong)_0%,rgba(244,249,255,0.94)_100%)] p-5 shadow-[0_24px_60px_rgba(15,23,42,0.08)] sm:p-6', className)}>
    {children}
  </div>
);

const MetricCard = ({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) => (
  <div className="rounded-[26px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(244,249,255,0.94)_100%)] p-4 shadow-[0_20px_48px_rgba(15,23,42,0.09)] backdrop-blur sm:rounded-[28px] sm:p-5 sm:shadow-[0_24px_60px_rgba(15,23,42,0.09)]">
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm text-[var(--ink-soft)]">{title}</p>
        <p className="mt-2 text-2xl font-semibold text-[var(--ink)] sm:text-3xl">{value}</p>
      </div>
      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--accent-cream)_0%,#ffffff_100%)] text-[var(--accent-rust)] shadow-[0_12px_24px_rgba(22,152,212,0.14)] sm:h-12 sm:w-12">
        <Icon className="h-5 w-5" />
      </div>
    </div>
    <p className="mt-3 text-xs leading-6 text-[var(--ink-soft)] sm:mt-4 sm:text-sm">{hint}</p>
  </div>
);

const AssessmentQuestionBuilder = ({
  title,
  caption,
  questions,
  onChange,
}: {
  title: string;
  caption: string;
  questions: EditableAssessmentQuestion[];
  onChange: (questions: EditableAssessmentQuestion[]) => void;
}) => {
  const updateQuestion = (questionId: string, patch: Partial<EditableAssessmentQuestion>) => {
    onChange(questions.map((question) => (
      question.id === questionId ? { ...question, ...patch } : question
    )));
  };

  const updateOption = (questionId: string, optionIndex: number, value: string) => {
    onChange(questions.map((question) => {
      if (question.id !== questionId) {
        return question;
      }

      const nextOptions = [...question.options];
      nextOptions[optionIndex] = value;
      return { ...question, options: nextOptions };
    }));
  };

  const addQuestion = () => {
    onChange([...questions, createEditableAssessmentQuestion()]);
  };

  const removeQuestion = (questionId: string) => {
    if (questions.length === 1) {
      onChange([createEditableAssessmentQuestion()]);
      return;
    }
    onChange(questions.filter((question) => question.id !== questionId));
  };

  const addOption = (questionId: string) => {
    onChange(questions.map((question) => (
      question.id === questionId ? { ...question, options: [...question.options, ''] } : question
    )));
  };

  const removeOption = (questionId: string, optionIndex: number) => {
    onChange(questions.map((question) => {
      if (question.id !== questionId) {
        return question;
      }

      if (question.options.length <= 2) {
        return question;
      }

      const nextOptions = question.options.filter((_, index) => index !== optionIndex);
      const nextCorrectOptions = question.correctOptions
        .filter((correctOptionIndex) => correctOptionIndex !== optionIndex)
        .map((correctOptionIndex) => (correctOptionIndex > optionIndex ? correctOptionIndex - 1 : correctOptionIndex));

      return {
        ...question,
        options: nextOptions,
        correctOptions: nextCorrectOptions.length > 0 ? nextCorrectOptions : [0],
      };
    }));
  };

  return (
    <div className="md:col-span-2 rounded-[24px] border border-[var(--line)] bg-[linear-gradient(180deg,#ffffff_0%,#f9fbff_100%)] p-4 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--ink)]">{title}</p>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">{caption}</p>
        </div>
        <button
          type="button"
          onClick={addQuestion}
          className="inline-flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--ink)]"
        >
          <Plus className="h-4 w-4" />
          Add question
        </button>
      </div>

      <div className="mt-4 space-y-4">
        {questions.map((question, questionIndex) => (
          <div key={question.id} className="rounded-[22px] border border-[var(--line)] bg-white p-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-[var(--ink)]">Question {questionIndex + 1}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.14em] text-[var(--ink-soft)]">
                  {question.options.filter((option) => option.trim()).length} options
                </p>
              </div>
              <button
                type="button"
                onClick={() => removeQuestion(question.id)}
                className="inline-flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold text-[var(--danger)]"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <input
                value={question.topic}
                onChange={(event) => updateQuestion(question.id, { topic: event.target.value })}
                placeholder="Topic"
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
              />
              <input
                type="number"
                min="1"
                value={question.marks}
                onChange={(event) => updateQuestion(question.id, { marks: Number(event.target.value) || 1 })}
                placeholder="Marks"
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
              />
              <textarea
                value={question.questionText}
                onChange={(event) => updateQuestion(question.id, { questionText: event.target.value })}
                placeholder="Question text"
                className="md:col-span-2 h-24 rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
              />
            </div>

            <div className="mt-4 rounded-[18px] border border-[var(--line)] bg-[#fbfdff] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[var(--ink)]">Options</p>
                <button
                  type="button"
                  onClick={() => addOption(question.id)}
                  className="inline-flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-3 py-2 text-xs font-semibold text-[var(--ink)]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add option
                </button>
              </div>

              <div className="mt-3 space-y-3">
                {question.options.map((option, optionIndex) => (
                  <div key={`${question.id}-option-${optionIndex}`} className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_150px_auto]">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--line)] bg-white text-sm font-semibold text-[var(--ink-soft)]">
                      {String.fromCharCode(65 + optionIndex)}
                    </div>
                    <input
                      value={option}
                      onChange={(event) => updateOption(question.id, optionIndex, event.target.value)}
                      placeholder={`Option ${String.fromCharCode(65 + optionIndex)}`}
                      className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 outline-none"
                    />
                    <label className="flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-sm text-[var(--ink)]">
                      <input
                        type="checkbox"
                        checked={question.correctOptions.includes(optionIndex)}
                        onChange={(event) => updateQuestion(question.id, {
                          correctOptions: event.target.checked
                            ? [...new Set([...question.correctOptions, optionIndex])].sort((left, right) => left - right)
                            : question.correctOptions.filter((correctOptionIndex) => correctOptionIndex !== optionIndex),
                        })}
                      />
                      Correct
                    </label>
                    <button
                      type="button"
                      onClick={() => removeOption(question.id, optionIndex)}
                      className="inline-flex items-center justify-center rounded-2xl border border-[var(--line)] bg-white px-3 py-3 text-[var(--danger)]"
                      aria-label={`Remove option ${optionIndex + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <textarea
              value={question.explanation}
              onChange={(event) => updateQuestion(question.id, { explanation: event.target.value })}
              placeholder="Explanation, optional"
              className="mt-4 h-24 w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
};

const builderSteps = ['Basic Info', 'Targeting', 'Questions', 'Review'] as const;

const BuilderStepper = ({
  activeStep = 0,
  onStepSelect,
}: {
  activeStep?: number;
  onStepSelect?: (index: number) => void;
}) => (
  <div className="flex flex-wrap items-center gap-3">
    {builderSteps.map((step, index) => {
      const isActive = index === activeStep;
      const isCompleted = index < activeStep;
      return (
        <button
          key={step}
          type="button"
          onClick={() => onStepSelect?.(index)}
          className="flex items-center gap-3 rounded-full transition hover:opacity-95"
        >
          <div className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold',
            isActive
              ? 'bg-[#2f6ef0] text-white shadow-[0_10px_22px_rgba(47,110,240,0.22)]'
              : isCompleted
                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                : 'bg-[#eef3fb] text-[var(--ink-soft)]',
          )}>
            {index + 1}
          </div>
          <span className={cn(
            'text-sm font-medium',
            isActive || isCompleted ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]',
          )}>
            {step}
          </span>
        </button>
      );
    })}
  </div>
);

const AssessmentPreviewCard = ({
  typeLabel,
  accent,
  title,
  subtitle,
  questionCount,
  totalMarks,
  durationMinutes,
  negativeMarking,
  topic,
}: {
  typeLabel: string;
  accent: 'blue' | 'green';
  title: string;
  subtitle: string;
  questionCount: number;
  totalMarks: number;
  durationMinutes: number;
  negativeMarking: number;
  topic: string;
}) => {
  const chipTone = accent === 'blue'
    ? 'bg-[#eef4ff] text-[#2f6ef0]'
    : 'bg-[#edf9f1] text-[#18995d]';

  const rows = [
    ['Questions', `${questionCount || 0}`],
    ['Total marks', `${totalMarks || 0}`],
    ['Duration', `${durationMinutes || 0} min`],
    ['Negative marking', `${negativeMarking || 0}`],
    ['Topic', topic || '--'],
  ];

  return (
    <div className="rounded-[24px] border border-[var(--line)] bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] p-5 shadow-[0_16px_42px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Live preview</p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--ink)]">{title || `Untitled ${typeLabel}`}</h3>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{subtitle || 'Preview updates as the admin fills the builder.'}</p>
        </div>
        <span className={cn('rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em]', chipTone)}>
          {typeLabel}
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 rounded-[16px] border border-[var(--line)] bg-white px-4 py-3">
            <span className="text-sm text-[var(--ink-soft)]">{label}</span>
            <span className="text-sm font-semibold text-[var(--ink)]">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const BuilderFrame = ({
  eyebrow,
  title,
  description,
  activeStep,
  onStepSelect,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  activeStep: number;
  onStepSelect: (index: number) => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="overflow-hidden rounded-[30px] border border-white/70 bg-white/92 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
    <div className="border-b border-[var(--line)] bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] px-6 py-5">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--ink-soft)]">{eyebrow}</p>
          <h3 className="mt-2 text-2xl font-semibold text-[var(--ink)]">{title}</h3>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-[var(--ink-soft)]">{description}</p>
        </div>
        {actions}
      </div>
      <div className="mt-5">
        <BuilderStepper activeStep={activeStep} onStepSelect={onStepSelect} />
      </div>
    </div>
    <div className="px-6 py-6">
      {children}
    </div>
  </section>
);

const LoadingShell = () => (
  <div className="min-h-screen bg-[var(--page-bg)]">
    <div className="flex min-h-screen">
      <aside className="hidden w-[306px] shrink-0 border-r border-white/50 bg-[linear-gradient(180deg,#142033_0%,#1b2942_100%)] px-5 py-6 lg:flex">
        <div className="w-full animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-2xl bg-white/10" />
            <div className="space-y-2">
              <div className="h-4 w-24 rounded-full bg-white/14" />
              <div className="h-3 w-20 rounded-full bg-white/10" />
            </div>
          </div>
          <div className="mt-8 rounded-[30px] border border-white/10 bg-white/8 p-5">
            <div className="h-3 w-24 rounded-full bg-white/10" />
            <div className="mt-4 flex items-center gap-3">
              <div className="h-12 w-12 rounded-2xl bg-white/12" />
              <div className="space-y-2">
                <div className="h-4 w-28 rounded-full bg-white/16" />
                <div className="h-3 w-16 rounded-full bg-white/10" />
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              {[0, 1].map((item) => (
                <div key={item} className="rounded-2xl bg-white/8 p-3">
                  <div className="h-3 w-12 rounded-full bg-white/10" />
                  <div className="mt-3 h-6 w-14 rounded-xl bg-white/14" />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-8 space-y-3">
            {[0, 1, 2, 3, 4].map((item) => (
              <div key={item} className="h-12 rounded-[22px] bg-white/10" />
            ))}
          </div>
        </div>
      </aside>

      <div className="flex-1">
        <div className="border-b border-white/60 bg-[var(--page-bg)]/88 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl animate-pulse">
            <div className="grid gap-4 xl:grid-cols-[1fr_620px]">
              <div>
                <div className="h-3 w-28 rounded-full bg-white/80" />
                <div className="mt-4 h-10 w-[380px] max-w-full rounded-3xl bg-white/90" />
                <div className="mt-4 h-4 w-[520px] max-w-full rounded-full bg-white/80" />
              </div>
              <div>
                <div className="h-14 rounded-[28px] bg-white/92" />
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="rounded-[24px] bg-white/92 p-4">
                      <div className="h-3 w-16 rounded-full bg-[var(--accent-cream)]" />
                      <div className="mt-3 h-4 w-28 rounded-full bg-[var(--accent-cream)]" />
                      <div className="mt-3 h-3 w-full rounded-full bg-[var(--accent-cream)]" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="animate-pulse">
            <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-[34px] bg-[var(--card-dark)]/95 p-8">
                <div className="h-4 w-32 rounded-full bg-white/15" />
                <div className="mt-5 h-12 w-full max-w-[560px] rounded-3xl bg-white/12" />
                <div className="mt-4 h-5 w-full max-w-[480px] rounded-2xl bg-white/10" />
                <div className="mt-8 grid gap-4 sm:grid-cols-3">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="rounded-[26px] bg-white/10 p-5">
                      <div className="h-3 w-20 rounded-full bg-white/18" />
                      <div className="mt-4 h-8 w-16 rounded-xl bg-white/18" />
                      <div className="mt-4 h-3 w-full rounded-full bg-white/12" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[34px] bg-white/92 p-6">
                <div className="h-4 w-24 rounded-full bg-[var(--accent-cream)]" />
                <div className="mt-4 h-8 w-48 rounded-2xl bg-[var(--accent-cream)]" />
                <div className="mt-6 space-y-4">
                  {[0, 1, 2].map((item) => (
                    <div key={item} className="rounded-[24px] bg-[var(--accent-cream)] p-5">
                      <div className="h-4 w-32 rounded-full bg-white" />
                      <div className="mt-3 h-3 w-full rounded-full bg-white/80" />
                      <div className="mt-2 h-3 w-3/4 rounded-full bg-white/80" />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              {[0, 1].map((item) => (
                <div key={item} className="rounded-[30px] bg-white/92 p-6">
                  <div className="h-4 w-28 rounded-full bg-[var(--accent-cream)]" />
                  <div className="mt-5 space-y-4">
                    {[0, 1, 2].map((row) => (
                      <div key={row} className="rounded-[24px] bg-[var(--accent-cream)] p-5">
                        <div className="h-4 w-36 rounded-full bg-white" />
                        <div className="mt-3 h-3 w-full rounded-full bg-white/80" />
                        <div className="mt-2 h-3 w-4/5 rounded-full bg-white/80" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const ReviewToggleButton = ({
  open,
  onClick,
  label = 'Solution',
}: {
  open: boolean;
  onClick: () => void;
  label?: string;
}) => (
  <button
    onClick={onClick}
    className={cn(
      'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition',
      open
        ? 'bg-[var(--ink)] text-white'
        : 'border border-[var(--line)] bg-white text-[var(--ink-soft)] hover:border-[var(--accent-rust)]/35',
    )}
  >
    {label}
    <ChevronRight className={cn('h-4 w-4 transition', open && 'rotate-90')} />
  </button>
);

const normalizeOptionIndexes = (value: unknown): number[] => {
  const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(
    list
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 0),
  )].sort((left, right) => left - right);
};

const getQuestionCorrectOptionIndexes = (question: Partial<MockQuestion> & { answer?: unknown }): number[] => {
  const explicitIndexes = normalizeOptionIndexes(question.correctOptions);
  if (explicitIndexes.length > 0) {
    return explicitIndexes;
  }

  const fallbackIndexes = normalizeOptionIndexes(question.correctOption ?? question.answer);
  return fallbackIndexes.length > 0 ? fallbackIndexes : [0];
};

const areOptionIndexesEqual = (left: number[], right: number[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isQuestionSelectionCorrect = (selectedOptionIndexes: number[], correctOptionIndexes: number[]) =>
  selectedOptionIndexes.length > 0 && areOptionIndexesEqual(selectedOptionIndexes, correctOptionIndexes);

const toggleSelectedOptionValue = (
  currentValue: number | number[] | undefined,
  optionIndex: number,
  allowMultipleAnswers: boolean,
): number | number[] => {
  const currentIndexes = normalizeOptionIndexes(currentValue);
  if (!allowMultipleAnswers) {
    return currentIndexes.length === 1 && currentIndexes[0] === optionIndex ? [] : optionIndex;
  }

  return currentIndexes.includes(optionIndex)
    ? currentIndexes.filter((value) => value !== optionIndex)
    : [...currentIndexes, optionIndex].sort((left, right) => left - right);
};

const formatOptionIndexLabel = (optionIndex: number) => String.fromCharCode(65 + optionIndex);

const formatOptionIndexLabels = (optionIndexes: number[]) =>
  optionIndexes.length > 0 ? optionIndexes.map((optionIndex) => formatOptionIndexLabel(optionIndex)).join(', ') : 'Skipped';

const getSolutionSelectedOptionIndexes = (solution: TestAttemptResult['solutions'][number]) => {
  const explicitIndexes = normalizeOptionIndexes(solution.selectedOptions);
  if (explicitIndexes.length > 0) {
    return explicitIndexes;
  }

  return solution.selectedOption === null ? [] : normalizeOptionIndexes(solution.selectedOption);
};

const getSolutionCorrectOptionIndexes = (solution: TestAttemptResult['solutions'][number]) => {
  const explicitIndexes = normalizeOptionIndexes(solution.correctOptions);
  if (explicitIndexes.length > 0) {
    return explicitIndexes;
  }

  return normalizeOptionIndexes(solution.correctOption);
};

const isSolutionCorrect = (solution: TestAttemptResult['solutions'][number]) =>
  isQuestionSelectionCorrect(getSolutionSelectedOptionIndexes(solution), getSolutionCorrectOptionIndexes(solution));

const MockSolutionCard = ({
  solution,
  index,
  open,
  onToggle,
}: {
  solution: TestAttemptResult['solutions'][number];
  index: number;
  open: boolean;
  onToggle: () => void;
}) => {
  const selectedOptionIndexes = getSolutionSelectedOptionIndexes(solution);
  const correctOptionIndexes = getSolutionCorrectOptionIndexes(solution);
  const status = selectedOptionIndexes.length === 0
    ? 'skipped'
    : isQuestionSelectionCorrect(selectedOptionIndexes, correctOptionIndexes)
      ? 'correct'
      : 'incorrect';

  return (
    <div className="rounded-[24px] border border-[var(--line)] bg-white p-4 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
              Question {index + 1}
            </span>
            <span className={cn(
              'rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em]',
              status === 'correct'
                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                : status === 'incorrect'
                  ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                  : 'bg-slate-100 text-slate-500',
            )}>
              {status}
            </span>
            <span className="rounded-full border border-[var(--line)] px-3 py-2 text-xs text-[var(--ink-soft)]">
              {solution.topic}
            </span>
          </div>
          <p className="mt-3 text-base font-semibold leading-7 text-[var(--ink)]">{solution.questionText}</p>
          <p className="mt-3 text-sm text-[var(--ink-soft)]">
            Your answer: <span className="font-semibold text-[var(--ink)]">{formatOptionIndexLabels(selectedOptionIndexes)}</span>
            {' '}• Correct: <span className="font-semibold text-[var(--success)]">{formatOptionIndexLabels(correctOptionIndexes)}</span>
          </p>
        </div>
        <ReviewToggleButton open={open} onClick={onToggle} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            className="overflow-hidden"
          >
            <div className="mt-4 rounded-[20px] bg-[var(--accent-cream)] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">AI explanation</p>
              <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">{solution.explanation}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

type AttemptEvaluationSnapshot = {
  score: number;
  totalMarks: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  percentile: number;
  weakTopics: string[];
  strongTopics: string[];
  solutions: TestAttemptResult['solutions'];
};

const buildAttemptEvaluationSnapshot = (
  test: MockTest,
  answers: Record<string, number | number[]>,
): AttemptEvaluationSnapshot => {
  let score = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unattemptedCount = 0;
  const topicStats = new Map<string, { correct: number; total: number }>();

  const solutions = test.questions.map((question) => {
    const selectedOptionIndexes = normalizeOptionIndexes(answers[question.id]);
    const correctOptionIndexes = getQuestionCorrectOptionIndexes(question);
    const marks = Number(question.marks || 1);
    const topic = question.topic || 'General Practice';
    const stats = topicStats.get(topic) || { correct: 0, total: 0 };
    stats.total += 1;

    if (selectedOptionIndexes.length === 0) {
      unattemptedCount += 1;
    } else if (isQuestionSelectionCorrect(selectedOptionIndexes, correctOptionIndexes)) {
      correctCount += 1;
      score += marks;
      stats.correct += 1;
    } else {
      incorrectCount += 1;
      score -= Number(test.negativeMarking || 0);
    }

    topicStats.set(topic, stats);

    return {
      questionId: question.id,
      questionText: question.questionText,
      selectedOption: selectedOptionIndexes.length === 1 ? selectedOptionIndexes[0] : null,
      selectedOptions: selectedOptionIndexes,
      correctOption: correctOptionIndexes[0] ?? 0,
      correctOptions: correctOptionIndexes,
      explanation: question.explanation || 'Explanation will appear here after review.',
      topic,
    };
  });

  const strongTopics: string[] = [];
  const weakTopics: string[] = [];
  topicStats.forEach((stats, topic) => {
    const accuracy = stats.total > 0 ? stats.correct / stats.total : 0;
    if (accuracy >= 0.75) {
      strongTopics.push(topic);
    } else {
      weakTopics.push(topic);
    }
  });

  return {
    score: Number(score.toFixed(2)),
    totalMarks: Number(test.totalMarks || test.questions.reduce((sum, question) => sum + Number(question.marks || 1), 0)),
    correctCount,
    incorrectCount,
    unattemptedCount,
    percentile: correctCount + incorrectCount + unattemptedCount > 0 ? Math.round((correctCount / Math.max(test.questions.length, 1)) * 100) : 0,
    weakTopics,
    strongTopics,
    solutions,
  };
};

const buildLocalTestAttemptResult = (
  test: MockTest,
  answers: Record<string, number | number[]>,
  startedAt?: string | null,
): TestAttemptResult => {
  const evaluation = buildAttemptEvaluationSnapshot(test, answers);

  return {
    _id: `local-attempt:${test._id}:${Date.now()}`,
    userId: 'local-user',
    testId: test._id,
    ...evaluation,
    rank: 1,
    completedAt: startedAt || new Date().toISOString(),
  };
};

const getSocialAuthProvider = (provider: 'google' | 'apple') =>
  provider === 'google' ? googleProvider : appleProvider;

const getSocialProviderFromFirebaseProviderId = (providerId?: string | null): 'google' | 'apple' | null => {
  if (providerId === 'google.com') {
    return 'google';
  }

  if (providerId === 'apple.com') {
    return 'apple';
  }

  return null;
};

const getSocialProviderLabel = (provider: 'google' | 'apple') =>
  provider === 'google' ? 'Google' : 'Apple';

const isPopupBlockedAuthError = (error: unknown) => {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code?: string }).code)
    : '';
  return code === 'auth/popup-blocked';
};

const AuthScreen = () => {
  const { login, register, refreshSession, requestPasswordReset } = useAuth();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot-password'>('login');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionConflict, setSessionConflict] = useState<{
    authMethod: 'password' | 'social';
    identifier: string;
    password: string;
    socialProvider?: 'google' | 'apple';
    socialIdToken?: string;
    activeDevice: string;
    activeSessions: Array<{
      sessionId: string;
      device: string;
      lastSeenAt: string | null;
    }>;
    sessionLimit: number;
  } | null>(null);
  const [takeoverSuccess, setTakeoverSuccess] = useState<{
    device: string;
    loggedOutAt: string;
  } | null>(null);
  const [loginForm, setLoginForm] = useState({ identifier: '', password: '' });
  const [registerForm, setRegisterForm] = useState<RegisterPayload & {
    mobileNumber: string;
    confirmPassword: string;
    agreeToTerms: boolean;
  }>({
    name: '',
    email: '',
    password: '',
    mobileNumber: '',
    confirmPassword: '',
    agreeToTerms: false,
  });
  const [rememberMe, setRememberMe] = useState(true);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showRegisterConfirmPassword, setShowRegisterConfirmPassword] = useState(false);
  const passwordStrength = useMemo(() => {
    const password = registerForm.password;
    if (!password) {
      return { label: 'Weak', tone: 'text-[#ef4444]', active: 0 };
    }

    let score = 0;
    if (password.length >= 8) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/\d/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password) || password.length >= 12) score += 1;

    if (score <= 1) {
      return { label: 'Weak', tone: 'text-[#ef4444]', active: 1 };
    }
    if (score === 2) {
      return { label: 'Fair', tone: 'text-[#f59e0b]', active: 2 };
    }
    if (score === 3) {
      return { label: 'Good', tone: 'text-[#8b5cf6]', active: 3 };
    }
    return { label: 'Strong', tone: 'text-[#22c55e]', active: 4 };
  }, [registerForm.password]);

  const takeOverDevice = sessionConflict?.activeSessions[0]?.device || sessionConflict?.activeDevice || 'another device';
  const isNativePlatform = Capacitor.isNativePlatform();
  const resetFeedback = () => {
    setError(null);
    setResetSentTo(null);
  };
  const switchMode = (nextMode: 'login' | 'register' | 'forgot-password') => {
    resetFeedback();
    setMode(nextMode);
  };
  const authPanelClassName = 'min-h-dvh overflow-hidden bg-[#f8fbff] shadow-[0_24px_70px_rgba(37,73,125,0.18)] sm:min-h-0 sm:rounded-[28px] sm:border sm:border-[#d8e5f5]';
  const authInputClassName = 'h-[48px] w-full rounded-[14px] border border-[#d7e3f2] bg-white px-12 text-[16px] font-medium text-[#17233d] outline-none transition placeholder:text-[#8b9bb2] focus:border-[#2f6fe4] focus:bg-white focus:shadow-[0_0_0_4px_rgba(47,111,228,0.10)] sm:h-[46px]';
  const socialButtonClassName = 'flex h-[48px] w-full items-center justify-center gap-3 rounded-[14px] border border-[#d7e3f2] bg-white px-4 text-[15px] font-bold text-[#17233d] shadow-[0_10px_24px_rgba(37,73,125,0.06)] transition hover:border-[#b9cbe3] hover:bg-[#f7fbff]';
  const primaryButtonClassName = 'relative flex h-[50px] w-full items-center justify-center gap-3 rounded-[14px] bg-[linear-gradient(90deg,#2f6fe4_0%,#1698d4_100%)] px-4 text-[16px] font-bold text-white shadow-[0_16px_32px_rgba(47,111,228,0.28)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60';
  const renderPhoneStatusBar = () => null;
  const submitLogin = async (
    identifier = loginForm.identifier,
    password = loginForm.password,
    options?: { forceLogoutOtherSessions?: boolean },
  ) => {
    setSubmitting(true);
    resetFeedback();
    try {
      await login(identifier, password, {
        ...options,
        rememberMe,
      });
      setSessionConflict(null);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SESSION_ACTIVE') {
        const activeDevice = typeof err.details?.activeDevice === 'string' ? err.details.activeDevice : 'another device';
        const activeSessions = Array.isArray(err.details?.activeSessions)
          ? err.details.activeSessions
            .map((session: any, index: number) => ({
              sessionId: typeof session?.sessionId === 'string' ? session.sessionId : `active-${index}`,
              device: typeof session?.device === 'string' ? session.device : activeDevice,
              lastSeenAt: typeof session?.lastSeenAt === 'string' ? session.lastSeenAt : null,
            }))
          : [{ sessionId: 'active-0', device: activeDevice, lastSeenAt: null }];
        setSessionConflict({
          authMethod: 'password',
          identifier,
          password,
          activeDevice,
          activeSessions,
          sessionLimit: Number(err.details?.sessionLimit || 1),
        });
        return;
      }

      setError(err instanceof Error ? err.message : 'Unable to log in');
    } finally {
      setSubmitting(false);
    }
  };

  const submitRegister = async () => {
    if (!registerForm.name.trim() || !registerForm.email.trim() || !registerForm.password) {
      setError('Please complete all required fields.');
      return;
    }
    if (registerForm.password !== registerForm.confirmPassword) {
      setError('Password and confirm password must match.');
      return;
    }
    if (!registerForm.agreeToTerms) {
      setError('Please accept the Terms & Conditions and Privacy Policy.');
      return;
    }
    setSubmitting(true);
    resetFeedback();
    try {
      await register({
        name: registerForm.name,
        email: registerForm.email,
        mobileNumber: registerForm.mobileNumber,
        password: registerForm.password,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create account');
    } finally {
      setSubmitting(false);
    }
  };

  const submitPasswordReset = async () => {
    const normalizedEmail = String(resetEmail || '').trim();
    if (!normalizedEmail) {
      setError('Enter your email address to receive a reset link.');
      return;
    }

    setSubmitting(true);
    resetFeedback();
    try {
      await requestPasswordReset(normalizedEmail);
      setResetSentTo(normalizedEmail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send reset email');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const storedPendingProvider = window.sessionStorage.getItem(SOCIAL_REDIRECT_PROVIDER_KEY);
    const pendingProvider = storedPendingProvider === 'google' || storedPendingProvider === 'apple'
      ? storedPendingProvider
      : null;
    if (!pendingProvider) {
      return undefined;
    }

    let cancelled = false;

    const completeNativeSocialLogin = async () => {
      setSubmitting(true);
      resetFeedback();
      let socialProvider: 'google' | 'apple' = pendingProvider;
      let socialIdentifier = pendingProvider;
      let socialIdToken = '';

      try {
        const credential = await getRedirectResult(firebaseAuth);
        if (!credential) {
          if (!cancelled) {
            setError(`${getSocialProviderLabel(pendingProvider)} sign-in was cancelled. Please try again.`);
          }
          return;
        }

        socialProvider = getSocialProviderFromFirebaseProviderId(credential.providerId) || pendingProvider;
        socialIdToken = await credential.user.getIdToken(true);
        socialIdentifier = credential.user.email || socialProvider;
        await EduService.socialLogin(socialProvider, socialIdToken);
        await refreshSession();
        setSessionConflict(null);
      } catch (err) {
        if (cancelled) {
          return;
        }

        if (err instanceof ApiRequestError && err.code === 'SESSION_ACTIVE') {
          const activeDevice = typeof err.details?.activeDevice === 'string' ? err.details.activeDevice : 'another device';
          const activeSessions = Array.isArray(err.details?.activeSessions)
            ? err.details.activeSessions
              .map((session: any, index: number) => ({
                sessionId: typeof session?.sessionId === 'string' ? session.sessionId : `active-${index}`,
                device: typeof session?.device === 'string' ? session.device : activeDevice,
                lastSeenAt: typeof session?.lastSeenAt === 'string' ? session.lastSeenAt : null,
              }))
            : [{ sessionId: 'active-0', device: activeDevice, lastSeenAt: null }];
          setSessionConflict({
            authMethod: 'social',
            identifier: socialIdentifier,
            password: '',
            socialProvider,
            socialIdToken,
            activeDevice,
            activeSessions,
            sessionLimit: Number(err.details?.sessionLimit || 1),
          });
          return;
        }

        const message = err instanceof Error ? err.message : `Unable to continue with ${getSocialProviderLabel(pendingProvider)}.`;
        setError(message);
      } finally {
        window.sessionStorage.removeItem(SOCIAL_REDIRECT_PROVIDER_KEY);
        if (!cancelled) {
          setSubmitting(false);
        }
      }
    };

    void completeNativeSocialLogin();

    return () => {
      cancelled = true;
    };
  }, [refreshSession]);

  const submitSocialLogin = async (provider: 'google' | 'apple') => {
    setSubmitting(true);
    resetFeedback();
    let socialIdToken = '';
    let socialIdentifier: string = provider;
    try {
      if (isNativePlatform) {
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(SOCIAL_REDIRECT_PROVIDER_KEY, provider);
        }
        await signInWithRedirect(firebaseAuth, getSocialAuthProvider(provider));
        return;
      }

      const credential = await signInWithPopup(firebaseAuth, getSocialAuthProvider(provider));
      socialIdToken = await credential.user.getIdToken(true);
      socialIdentifier = credential.user.email || provider;
      await EduService.socialLogin(provider, socialIdToken);
      await refreshSession();
    } catch (err) {
      if (!isNativePlatform && isPopupBlockedAuthError(err) && typeof window !== 'undefined') {
        window.sessionStorage.setItem(SOCIAL_REDIRECT_PROVIDER_KEY, provider);
        await signInWithRedirect(firebaseAuth, getSocialAuthProvider(provider));
        return;
      }
      if (err instanceof ApiRequestError && err.code === 'SESSION_ACTIVE') {
        const activeDevice = typeof err.details?.activeDevice === 'string' ? err.details.activeDevice : 'another device';
        const activeSessions = Array.isArray(err.details?.activeSessions)
          ? err.details.activeSessions
            .map((session: any, index: number) => ({
              sessionId: typeof session?.sessionId === 'string' ? session.sessionId : `active-${index}`,
              device: typeof session?.device === 'string' ? session.device : activeDevice,
              lastSeenAt: typeof session?.lastSeenAt === 'string' ? session.lastSeenAt : null,
            }))
          : [{ sessionId: 'active-0', device: activeDevice, lastSeenAt: null }];
        setSessionConflict({
          authMethod: 'social',
          identifier: socialIdentifier,
          password: '',
          socialProvider: provider,
          socialIdToken,
          activeDevice,
          activeSessions,
          sessionLimit: Number(err.details?.sessionLimit || 1),
        });
        return;
      }
      const message = err instanceof Error ? err.message : `Unable to continue with ${provider}.`;
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmTakeover = async () => {
    if (!sessionConflict) {
      return;
    }

    setSubmitting(true);
    resetFeedback();
    try {
      if (sessionConflict.authMethod === 'social') {
        if (!sessionConflict.socialProvider || !sessionConflict.socialIdToken) {
          throw new Error('Social login session expired. Please try again.');
        }
        await EduService.socialLogin(sessionConflict.socialProvider, sessionConflict.socialIdToken, { forceLogoutOtherSessions: true });
      } else {
        await login(sessionConflict.identifier, sessionConflict.password, {
          forceLogoutOtherSessions: true,
          rememberMe,
        });
      }
      setTakeoverSuccess({
        device: takeOverDevice,
        loggedOutAt: new Date().toISOString(),
      });
      setSessionConflict(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to log out the older device.');
    } finally {
      setSubmitting(false);
    }
  };

  const continueAfterTakeover = async () => {
    setSubmitting(true);
    resetFeedback();
    try {
      await refreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to continue the login session.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderAuthHeader = () => (
    <div className="relative overflow-hidden border-b border-[#e3ecf7] bg-[linear-gradient(180deg,#ffffff_0%,#f1f7ff_100%)] px-6 pb-5 pt-9 sm:px-8 sm:pb-7 sm:pt-8">
      <div className="absolute right-6 top-5 grid grid-cols-4 gap-2 opacity-70">
        {Array.from({ length: 12 }).map((_, index) => (
          <span key={index} className="h-1 w-1 rounded-full bg-[#2f6fe4]" />
        ))}
      </div>
      {mode !== 'login' && (
        <button
          type="button"
          onClick={() => {
            switchMode('login');
          }}
          className="absolute left-6 top-8 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#d7e3f2] bg-white text-[#17233d] shadow-[0_8px_18px_rgba(47,111,228,0.08)]"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      <BrandLogo size="lg" className="justify-center" />
    </div>
  );

  const renderLoginForm = () => (
    <>
      <div>
        <h1 className="!font-sans max-w-[300px] text-[24px] font-bold leading-[1.18] text-[#17233d] sm:max-w-none sm:text-[28px]">Welcome back</h1>
        <p className="mt-2 text-[14px] leading-6 text-[#53647d] sm:text-[15px]">Login to continue your exam preparation.</p>
      </div>

      <form
        className="mt-4 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submitLogin();
        }}
      >
        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Email Address</label>
          <div className="relative mt-2">
            <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-login-email"
              type="text"
              value={loginForm.identifier}
              onChange={(event) => setLoginForm((current) => ({ ...current, identifier: event.target.value }))}
              className={authInputClassName}
              placeholder="Enter your email address"
              autoComplete="username"
            />
          </div>
        </div>

        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Password</label>
          <div className="relative mt-2">
            <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-login-password"
              type={showLoginPassword ? 'text' : 'password'}
              value={loginForm.password}
              onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
              className={authInputClassName}
              placeholder="Enter your password"
              autoComplete="current-password"
            />
            <button
              type="button"
              aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowLoginPassword((current) => !current)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[#7b8da6]"
            >
              {showLoginPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
        </div>

        <label className="flex items-center gap-3 text-[13px] font-medium text-[#53647d]">
          <button
            type="button"
            aria-pressed={rememberMe}
            aria-label="Remember me"
            onClick={() => setRememberMe((current) => !current)}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-[6px] border transition',
              rememberMe ? 'border-[#2f6fe4] bg-[#2f6fe4] text-white' : 'border-[#c8d6ea] bg-white text-transparent',
            )}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          Remember me
        </label>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              setResetEmail(loginForm.identifier);
              switchMode('forgot-password');
            }}
            className="text-[13px] font-bold text-[#2f6fe4]"
          >
            Forgot password?
          </button>
        </div>

        <button
          data-testid="auth-login-submit"
          type="submit"
          disabled={submitting}
          className={primaryButtonClassName}
        >
          <span>{submitting ? <LoaderCircle className="h-5 w-5 animate-spin" /> : 'Login'}</span>
          {!submitting && <ArrowRight className="absolute right-6 h-5 w-5" />}
        </button>
      </form>

      <div className="my-4 flex items-center gap-4 text-[#7b8da6]">
        <div className="h-px flex-1 bg-[#dbe6f3]" />
        <span className="text-[13px] font-bold">OR</span>
        <div className="h-px flex-1 bg-[#dbe6f3]" />
      </div>

      <div className="space-y-2.5">
        <button type="button" disabled={submitting} onClick={() => void submitSocialLogin('google')} className={socialButtonClassName}>
          <span className="text-[24px] font-bold text-[#ea4335]">G</span>
          Continue with Google
        </button>
        <button type="button" disabled={submitting} onClick={() => void submitSocialLogin('apple')} className={socialButtonClassName}>
          <span className="text-[24px] leading-none text-[#111827]"></span>
          Continue with Apple
        </button>
      </div>

      <p className="mt-4 text-center text-[13px] font-medium text-[#657792]">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          onClick={() => {
            switchMode('register');
          }}
          className="font-bold text-[#2f6fe4]"
        >
          Sign Up
        </button>
      </p>
    </>
  );

  const renderRegisterForm = () => (
    <>
      <div>
        <h1 className="!font-sans max-w-[300px] text-[24px] font-bold leading-[1.18] text-[#17233d] sm:max-w-none sm:text-[28px]">Create your account</h1>
        <p className="mt-2 text-[14px] leading-6 text-[#53647d] sm:text-[15px]">Join VaronEnglish and start your preparation.</p>
      </div>

      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submitRegister();
        }}
      >
        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Full Name</label>
          <div className="relative mt-2">
            <UserCircle2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-register-name"
              type="text"
              value={registerForm.name}
              onChange={(event) => setRegisterForm((current) => ({ ...current, name: event.target.value }))}
              className={authInputClassName}
              placeholder="Enter your full name"
              autoComplete="name"
            />
          </div>
        </div>

        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Email Address</label>
          <div className="relative mt-2">
            <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-register-email"
              type="email"
              value={registerForm.email}
              onChange={(event) => setRegisterForm((current) => ({ ...current, email: event.target.value }))}
              className={authInputClassName}
              placeholder="Enter your email address"
              autoComplete="email"
            />
          </div>
        </div>

        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Password</label>
          <div className="relative mt-2">
            <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-register-password"
              type={showRegisterPassword ? 'text' : 'password'}
              value={registerForm.password}
              onChange={(event) => setRegisterForm((current) => ({ ...current, password: event.target.value }))}
              className={authInputClassName}
              placeholder="Create a password"
              autoComplete="new-password"
            />
            <button
              type="button"
              aria-label={showRegisterPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowRegisterPassword((current) => !current)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[#7b8da6]"
            >
              {showRegisterPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <span className="font-medium text-[#657792]">Strength</span>
            <div className="flex flex-1 gap-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <span
                  key={index}
                  className={cn(
                    'h-[2px] flex-1 rounded-full',
                    index < passwordStrength.active ? 'bg-current' : 'bg-[#dbe6f3]',
                    passwordStrength.tone,
                  )}
                />
              ))}
            </div>
            <span className={cn('font-medium', passwordStrength.tone)}>{passwordStrength.label}</span>
          </div>
        </div>

        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Confirm Password</label>
          <div className="relative mt-2">
            <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-register-confirm-password"
              type={showRegisterConfirmPassword ? 'text' : 'password'}
              value={registerForm.confirmPassword}
              onChange={(event) => setRegisterForm((current) => ({ ...current, confirmPassword: event.target.value }))}
              className={authInputClassName}
              placeholder="Confirm your password"
              autoComplete="new-password"
            />
            <button
              type="button"
              aria-label={showRegisterConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
              onClick={() => setShowRegisterConfirmPassword((current) => !current)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[#7b8da6]"
            >
              {showRegisterConfirmPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
        </div>

        <label className="flex items-start gap-3 text-[12px] leading-5 text-[#53647d]">
          <button
            type="button"
            aria-pressed={registerForm.agreeToTerms}
            aria-label="Accept terms and privacy policy"
            onClick={() => setRegisterForm((current) => ({ ...current, agreeToTerms: !current.agreeToTerms }))}
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border transition',
              registerForm.agreeToTerms ? 'border-[#2f6fe4] bg-[#2f6fe4] text-white' : 'border-[#c8d6ea] bg-white text-transparent',
            )}
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <span>
            I agree to the <button type="button" className="font-bold text-[#2f6fe4]">Terms &amp; Conditions</button> and <button type="button" className="font-bold text-[#2f6fe4]">Privacy Policy</button>
          </span>
        </label>

        <button
          data-testid="auth-register-submit"
          type="submit"
          disabled={submitting}
          className={primaryButtonClassName}
        >
          <span>{submitting ? <LoaderCircle className="h-5 w-5 animate-spin" /> : 'Create Account'}</span>
          {!submitting && <ArrowRight className="absolute right-6 h-5 w-5" />}
        </button>
      </form>

      <p className="mt-4 text-center text-[13px] font-medium text-[#657792]">
        Already have an account?{' '}
        <button
          type="button"
          onClick={() => {
            switchMode('login');
          }}
          className="font-bold text-[#2f6fe4]"
        >
          Login
        </button>
      </p>
    </>
  );

  const renderForgotPasswordForm = () => (
    <>
      <div>
        <h1 className="!font-sans max-w-[300px] text-[24px] font-bold leading-[1.18] text-[#17233d] sm:max-w-none sm:text-[28px]">Reset your password</h1>
        <p className="mt-2 text-[14px] leading-6 text-[#53647d] sm:text-[15px]">We&apos;ll send a secure reset link to your email address.</p>
      </div>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submitPasswordReset();
        }}
      >
        <div>
          <label className="text-[13px] font-bold text-[#17233d]">Email Address</label>
          <div className="relative mt-2">
            <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#7b8da6]" />
            <input
              data-testid="auth-reset-email"
              type="email"
              value={resetEmail}
              onChange={(event) => setResetEmail(event.target.value)}
              className={authInputClassName}
              placeholder="Enter your email address"
              autoComplete="email"
            />
          </div>
        </div>

        <button
          data-testid="auth-reset-submit"
          type="submit"
          disabled={submitting}
          className={primaryButtonClassName}
        >
          <span>{submitting ? <LoaderCircle className="h-5 w-5 animate-spin" /> : 'Send reset link'}</span>
          {!submitting && <ArrowRight className="absolute right-6 h-5 w-5" />}
        </button>
      </form>

      {resetSentTo && (
        <div className="mt-4 rounded-[14px] border border-[#ccebd7] bg-[#effcf4] px-4 py-3 text-[14px] font-medium text-[#116b43]">
          Password reset link sent to {resetSentTo}.
        </div>
      )}

      <p className="mt-4 text-center text-[13px] font-medium text-[#657792]">
        Remembered your password?{' '}
        <button
          type="button"
          onClick={() => {
            switchMode('login');
          }}
          className="font-bold text-[#2f6fe4]"
        >
          Back to login
        </button>
      </p>
    </>
  );

  return (
    <div className="relative min-h-dvh overflow-x-hidden overflow-y-auto bg-[#d3daec] text-[#17233d]" style={{ fontFamily: LIVE_FONT_STACK }}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_14%_8%,rgba(255,255,255,0.72),transparent_24%),radial-gradient(circle_at_85%_14%,rgba(47,111,228,0.13),transparent_22%),linear-gradient(180deg,#d3daec_0%,#edf4ff_58%,#d3daec_100%)]" />
      <div className="relative mx-auto flex min-h-dvh w-full max-w-7xl items-center justify-center px-0 py-0 sm:px-4 sm:py-6 lg:px-8">
        <div className="grid w-full max-w-[1260px] gap-8 lg:grid-cols-[0.86fr_1.14fr] lg:items-center">
          <section className="hidden lg:block">
            <div className="rounded-[28px] border border-[#d8e5f5] bg-white/88 p-8 shadow-[0_24px_70px_rgba(37,73,125,0.16)] backdrop-blur">
              <div className="flex items-center gap-5">
                <BrandLogo size="lg" />
              </div>

              <div className="mt-10 grid gap-4 text-sm text-[#53647d]">
                {[
                  ['Structured courses', 'Continue lessons, notes, and CBT practice from one clean workspace.'],
                  ['Mock test focus', 'Attempt practice papers with exam-style instructions and review.'],
                  ['Live class ready', 'Join active sessions and keep replay material close to courses.'],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-[18px] border border-[#dbe6f3] bg-[#f8fbff] p-5">
                    <p className="text-[15px] font-bold text-[#17233d]">{title}</p>
                    <p className="mt-2 leading-6 text-[#53647d]">{body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="mx-auto w-full max-w-none sm:max-w-[480px]">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              className={authPanelClassName}
            >
              {renderAuthHeader()}
              <div className="px-6 pb-6 pt-5 sm:px-8 sm:pb-8 sm:pt-7">
                {mode === 'login' && renderLoginForm()}
                {mode === 'register' && renderRegisterForm()}
                {mode === 'forgot-password' && renderForgotPasswordForm()}

                {error && (
                  <div className="mt-5 rounded-[14px] border border-[#fecaca] bg-[#fff1f2] px-4 py-3 text-[14px] font-medium text-[#b42318]">
                    {error}
                  </div>
                )}

                <div className="mt-6 hidden rounded-[18px] border border-[#dbe6f3] bg-[#f8fbff] p-4 text-[13px] text-[#53647d] lg:block">
                  <p className="font-bold uppercase tracking-[0.2em] text-[#2f6fe4]">Session behavior</p>
                  <div className="mt-3 space-y-2.5">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-[#22c55e]" />
                      Stay logged in after refresh or restart on the same device.
                    </div>
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 text-[#22c55e]" />
                      If your account is active elsewhere, we stop here and ask you before continuing.
                    </div>
                  </div>
                </div>

              </div>
            </motion.div>
          </section>
        </div>
      </div>

      <AnimatePresence>
        {sessionConflict && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 overflow-hidden bg-[linear-gradient(180deg,#0b0f19_0%,#0d1220_100%)] text-white"
          >
            <div className="mx-auto flex h-screen w-full max-w-[430px] flex-col px-5 pb-4 pt-5">
              {renderPhoneStatusBar()}
              <button
                type="button"
                onClick={() => setSessionConflict(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>

              <div className="mt-5 flex min-h-0 flex-1 flex-col">
                <div className="mx-auto flex h-[150px] w-full max-w-[260px] items-center justify-center">
                  <div className="relative h-[112px] w-full">
                    <div className="absolute left-[8%] top-[48%] h-[54px] w-[92px] rounded-[12px] border border-[#4b556a] bg-[linear-gradient(180deg,#242b39,#121824)]" />
                    <div className="absolute left-[28%] top-[6%] h-[88px] w-[156px] rounded-[14px] border border-[#4b556a] bg-[linear-gradient(180deg,#2a3242,#171d29)]" />
                    <div className="absolute right-[8%] top-[22%] flex h-[78px] w-[42px] items-center justify-center rounded-[12px] border border-[#4b556a] bg-[linear-gradient(180deg,#2a3242,#171d29)]">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#6366f1]/50 bg-[#6366f1]/10">
                        <AlertTriangle className="h-5 w-5 text-[#a5b4fc]" />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 text-center">
                  <h2 className="!font-sans text-[22px] font-semibold leading-[1.25] text-white">Login Pending, Device Limit Reached</h2>
                  <p className="mt-2 text-[14px] text-[#cbd5e1]">Your current plan supports 1 device only</p>
                </div>

                <div className="mt-7 rounded-[14px] border border-white/8 bg-white/[0.03] p-4">
                  <p className="text-[16px] font-semibold text-white">Logged In Device</p>
                  <div className="mt-5 flex items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] bg-[#1f2937] text-[#dbe3f3]">
                      {takeOverDevice.toLowerCase().includes('iphone') || takeOverDevice.toLowerCase().includes('android') || takeOverDevice.toLowerCase().includes('mobile')
                        ? <Smartphone className="h-6 w-6" />
                        : <Monitor className="h-6 w-6" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
                        <p className="truncate text-[15px] font-medium text-white">{formatDeviceLabel(takeOverDevice)}</p>
                      </div>
                      <p className="mt-1 text-[13px] text-[#94a3b8]">Last used : {formatSessionLastUsed(sessionConflict.activeSessions[0]?.lastSeenAt)}</p>
                    </div>
                    <span className="shrink-0 rounded-[6px] border border-[#7c3aed]/40 bg-[#7c3aed]/10 px-2 py-1 text-[10px] font-medium text-[#a78bfa]">
                      Current Device
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void confirmTakeover()}
                  disabled={submitting}
                  className="mt-7 flex h-12 w-full items-center justify-center gap-3 rounded-[12px] bg-[linear-gradient(90deg,#3b82f6_0%,#8b5cf6_100%)] text-[15px] font-semibold text-white shadow-[0_18px_40px_rgba(79,70,229,0.36)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <LogOut className="h-5 w-5" />}
                  Log out older device and continue
                </button>

                <div className="mt-6 flex items-center gap-4 text-[#94a3b8]">
                  <div className="h-px flex-1 bg-white/10" />
                  <span className="text-[14px]">Or Upgrade</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>

                <button
                  type="button"
                  onClick={() => setSessionConflict(null)}
                  className="mt-5 flex h-12 w-full items-center justify-center rounded-[12px] border border-[#8b5cf6]/70 text-[16px] font-medium text-white"
                >
                  Upgrade plan
                </button>

                <p className="mt-auto flex items-center justify-center gap-2 pt-4 text-[12px] text-[#8b97b0]">
                  <ShieldCheck className="h-4 w-4 text-[#7c63ff]" />
                  Your data is safe and secure with us.
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {takeoverSuccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-30 overflow-hidden bg-[linear-gradient(180deg,#0b0f19_0%,#0d1220_100%)] text-white"
          >
            <div className="mx-auto flex h-screen w-full max-w-[430px] flex-col px-5 pb-4 pt-5">
              {renderPhoneStatusBar()}
              <button
                type="button"
                onClick={() => setTakeoverSuccess(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-white"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>

              <div className="mt-5 flex min-h-0 flex-1 flex-col">
                <div className="mx-auto flex h-[122px] w-[122px] items-center justify-center rounded-full border border-[#7c3aed]/50 bg-[radial-gradient(circle,rgba(99,102,241,0.16),transparent_64%)]">
                  <CheckCircle2 className="h-14 w-14 text-[#22d3ee]" />
                </div>

                <div className="mt-6 text-center">
                  <h2 className="!font-sans text-[22px] font-semibold leading-[1.25] text-[#8b5cf6]">Logged Out Successfully</h2>
                  <p className="mt-2 text-[14px] text-[#cbd5e1]">You can now login on this device.</p>
                </div>

                <div className="mt-7 rounded-[14px] border border-white/8 bg-white/[0.03] p-4">
                  <p className="text-[16px] font-semibold text-white">Logged Out Device</p>
                  <div className="mt-5 flex items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] bg-[#1f2937] text-[#dbe3f3]">
                      {takeoverSuccess.device.toLowerCase().includes('iphone') || takeoverSuccess.device.toLowerCase().includes('android') || takeoverSuccess.device.toLowerCase().includes('mobile')
                        ? <Smartphone className="h-6 w-6" />
                        : <Monitor className="h-6 w-6" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
                        <p className="truncate text-[15px] font-medium text-white">{formatDeviceLabel(takeoverSuccess.device)}</p>
                      </div>
                      <p className="mt-1 text-[13px] text-[#94a3b8]">Logged out just now</p>
                    </div>
                    <span className="shrink-0 rounded-[6px] border border-[#22c55e]/30 bg-[#22c55e]/10 px-2 py-1 text-[10px] font-medium text-[#4ade80]">
                      Logged Out
                    </span>
                  </div>
                </div>

                <div className="mt-5 rounded-[14px] border border-[#334155] bg-[rgba(37,99,235,0.08)] px-4 py-4 text-[#cbd5e1]">
                  <div className="flex items-start gap-3">
                    <Info className="mt-0.5 h-5 w-5 text-[#6366f1]" />
                    <div>
                      <p className="text-[14px] font-medium text-white">You have successfully logged out from {takeoverSuccess.device}.</p>
                      <p className="mt-2 text-[13px] text-[#cbd5e1]">You can now continue on this device.</p>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void continueAfterTakeover()}
                  disabled={submitting}
                  className="mt-6 flex h-12 w-full items-center justify-center rounded-[12px] bg-[linear-gradient(90deg,#3b82f6_0%,#8b5cf6_100%)] text-[16px] font-semibold text-white shadow-[0_18px_40px_rgba(79,70,229,0.36)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? <LoaderCircle className="h-5 w-5 animate-spin" /> : 'Continue to Login'}
                </button>
                <button
                  type="button"
                  onClick={() => void continueAfterTakeover()}
                  disabled={submitting}
                  className="mt-4 flex h-12 w-full items-center justify-center rounded-[12px] border border-[#8b5cf6]/70 text-[16px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Go to Home
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const Shell = ({
  overview,
  activeTab,
  setActiveTab,
  onLogout,
  onRefresh,
  resumeTarget,
  onContinueLearningNavigate,
  onOpenNotification,
  onResumeNavigationHandled,
  savedTopicIds,
  savedTopics,
  onToggleSavedTopic,
}: {
  overview: PlatformOverview;
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
  onLogout: () => Promise<void>;
  onRefresh: () => Promise<void>;
  resumeTarget: { courseId: string; lessonId?: string | null; doubtThreadId?: string | null; reportId?: string | null; supportPanel?: 'doubts' | 'report' | null } | null;
  onContinueLearningNavigate: (courseId: string, lessonId?: string | null, doubtThreadId?: string | null, reportId?: string | null, supportPanel?: 'doubts' | 'report' | null) => void;
  onOpenNotification: (notification: NotificationItem) => void;
  onResumeNavigationHandled: () => void;
  savedTopicIds: string[];
  savedTopics: SavedTopic[];
  onToggleSavedTopic: (courseId: string, lessonId: string) => void;
}) => {
  const { user, isAdmin, updateProfile, changePassword } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isMobileMoreOpen, setIsMobileMoreOpen] = useState(false);
  const [isNotificationSheetOpen, setIsNotificationSheetOpen] = useState(false);
  const [isProfileEditorOpen, setIsProfileEditorOpen] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: '', email: '', mobileNumber: '' });
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [liveMobileMode, setLiveMobileMode] = useState<'list' | 'detail' | 'room'>('list');
  const [isImmersiveCoursePlayer, setIsImmersiveCoursePlayer] = useState(false);
  const [isImmersiveTestsFlow, setIsImmersiveTestsFlow] = useState(false);
  const [pendingLiveClassId, setPendingLiveClassId] = useState<string | null>(null);
  const [activeCourseCbtLaunch, setActiveCourseCbtLaunch] = useState<{ test: MockTest; onSubmitted?: () => void } | null>(null);
  const [toastNotifications, setToastNotifications] = useState<NotificationItem[]>([]);
  const [notificationPermission, setNotificationPermission] = useState<BrowserAlertPermissionState>(() => getBrowserAlertPermissionState());
  const [browserAlertsEnabled, setBrowserAlertsEnabled] = useState(() => getStoredBooleanPreference(BROWSER_ALERTS_ENABLED_STORAGE_KEY, false));
  const [notificationPermissionBusy, setNotificationPermissionBusy] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());
  const audioContextRef = useRef<AudioContext | null>(null);
  const serviceWorkerRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const visibleTabs = tabs.filter((tab) => {
    if (tab.id === 'live' && !LIVE_CLASSES_ENABLED) {
      return false;
    }
    return tab.id !== 'admin' || isAdmin;
  });
  const overviewSidebarTabs = useMemo(
    () => ['overview', 'courses', ...(LIVE_CLASSES_ENABLED ? ['live'] : []), 'tests', 'revision', 'analytics', ...(isAdmin ? ['admin'] : [])]
      .map((id) => tabs.find((tab) => tab.id === id))
      .filter((tab): tab is (typeof tabs)[number] => Boolean(tab)),
    [isAdmin],
  );
  const primaryNavTabs = enabledMobilePrimaryTabIds
    .map((tabId) => visibleTabs.find((tab) => tab.id === tabId))
    .filter((tab): tab is (typeof tabs)[number] => Boolean(tab));
  const utilityTabs = visibleTabs.filter((tab) => !enabledMobilePrimaryTabIds.includes(tab.id));
  const searchTargets = useMemo(() => buildSearchTargets(overview, savedTopics), [overview, savedTopics]);
  const filteredTargets = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return searchTargets.slice(0, 8);
    }

    return searchTargets
      .filter((target) => `${target.title} ${target.subtitle} ${target.kind}`.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [searchQuery, searchTargets]);
  const activeMeta = shellTabMeta[activeTab];
  const isOverviewWorkspace = activeTab === 'overview';
  const isCoursesWorkspace = activeTab === 'courses';
  const isTestsWorkspace = activeTab === 'tests';
  const isLiveWorkspace = activeTab === 'live';
  const isFigmaWorkspace = activeTab === 'courses' && isImmersiveCoursePlayer;
  const isImmersiveTestsWorkspace = activeTab === 'tests' && isImmersiveTestsFlow;
  const isImmersiveWorkspace = isFigmaWorkspace || isImmersiveTestsWorkspace;
  const hideMobileShellNav = isLiveWorkspace && liveMobileMode !== 'list';
  const shouldLockViewport = isOverviewWorkspace || isImmersiveWorkspace;
  const continueCourse = overview.dashboard.continueLearning[0] || null;
  const mobileNavLabels: Record<TabKey, string> = {
    overview: 'Home',
    courses: 'Courses',
    live: 'Live',
    tests: 'Tests',
    revision: 'Revision',
    analytics: 'Analytics',
    admin: 'Admin',
  };
  const showShellHeader = false;
  const rawLearnerName = user?.name?.trim() || overview.user?.name?.trim() || 'Learner';
  const learnerName = rawLearnerName.includes('@') ? rawLearnerName.split('@')[0] : rawLearnerName;
  const learnerLevel = isAdmin ? 'Admin' : (overview.dashboard.streak > 0 ? `${overview.dashboard.streak} day streak` : 'Aspirant');
  const enrolledCourseCount = overview.courses.filter((course) => course.enrolled).length;
  const sidebarStats = [
    { label: 'Courses', value: enrolledCourseCount || overview.courses.length },
    { label: 'Tests', value: overview.testSeries.length },
  ];
  const continueTitle = continueCourse?.continueLesson?.title || continueCourse?.title || 'Open your next study task.';
  const learnerEmail = user?.email || overview.user?.email || 'student@varonenglish.com';
  const learnerPhone = user?.mobileNumber || overview.user?.mobileNumber || '';

  useEffect(() => {
    setProfileForm({
      name: rawLearnerName,
      email: learnerEmail,
      mobileNumber: learnerPhone,
    });
  }, [learnerEmail, rawLearnerName, learnerPhone]);

  useEffect(() => {
    const handleWindowClick = (event: MouseEvent) => {
      if (!searchContainerRef.current?.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSearchOpen(false);
        setIsMobileMoreOpen(false);
      }
    };

    window.addEventListener('mousedown', handleWindowClick);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousedown', handleWindowClick);
      window.removeEventListener('keydown', handleEscape);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || !isMobileMoreOpen) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileMoreOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const syncPermission = () => {
      setNotificationPermission(getBrowserAlertPermissionState());
    };

    window.addEventListener('focus', syncPermission);
    document.addEventListener('visibilitychange', syncPermission);
    return () => {
      window.removeEventListener('focus', syncPermission);
      document.removeEventListener('visibilitychange', syncPermission);
    };
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    void navigator.serviceWorker.register(NOTIFICATION_SERVICE_WORKER_PATH)
      .then((registration) => {
        serviceWorkerRegistrationRef.current = registration;
      })
      .catch(() => {
        serviceWorkerRegistrationRef.current = null;
      });
  }, []);

  useEffect(() => {
    setStoredBooleanPreference(BROWSER_ALERTS_ENABLED_STORAGE_KEY, browserAlertsEnabled);
  }, [browserAlertsEnabled]);

  useEffect(() => {
    if (activeTab !== 'live') {
      setLiveMobileMode('list');
    }
  }, [activeTab]);

  useEffect(() => {
    if (typeof document === 'undefined' || !shouldLockViewport) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [shouldLockViewport]);

  useEffect(() => {
    if (activeTab !== 'courses') {
      setIsImmersiveCoursePlayer(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'tests') {
      setIsImmersiveTestsFlow(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const liveClassId = params.get('liveClassId');
    if (params.get('tab') === 'live' && liveClassId) {
      setPendingLiveClassId(liveClassId);
    }
  }, []);

  useEffect(() => {
    const incomingIds = new Set((overview.notifications || []).map((notification) => notification._id));
    const seenIds = seenNotificationIdsRef.current;

    if (seenIds.size === 0) {
      seenNotificationIdsRef.current = incomingIds;
      return;
    }

    const freshNotifications = (overview.notifications || [])
      .filter((notification) => !seenIds.has(notification._id))
      .slice(0, 4);

    if (freshNotifications.length > 0) {
      setToastNotifications((current) => {
        const existing = new Set(current.map((notification) => notification._id));
        return [...freshNotifications.filter((notification) => !existing.has(notification._id)), ...current].slice(0, 4);
      });

      if (browserAlertsEnabled) {
        void playNotificationChime(audioContextRef).catch(() => undefined);
      }

      if (browserAlertsEnabled && notificationPermission === 'granted') {
        freshNotifications.slice(0, 3).forEach((notification) => {
          const targetUrl = resolveNotificationTargetUrl(notification);
          const options: NotificationOptions = {
            body: notification.message,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: `edumaster-notification-${notification._id}`,
            requireInteraction: typeof document !== 'undefined' ? document.hidden : false,
            data: {
              url: targetUrl,
              notificationId: notification._id,
            },
          };

          if (serviceWorkerRegistrationRef.current) {
            void serviceWorkerRegistrationRef.current.showNotification(notification.title, options).catch(() => undefined);
            return;
          }

          if (typeof window !== 'undefined' && 'Notification' in window) {
            const browserNotification = new Notification(notification.title, options);
            browserNotification.onclick = () => {
              const nextTargetUrl = String(targetUrl || '').trim();
              window.focus();
              if (nextTargetUrl) {
                window.location.href = nextTargetUrl;
              }
              browserNotification.close();
            };
          }
        });
      }
    }

    seenNotificationIdsRef.current = incomingIds;
  }, [browserAlertsEnabled, notificationPermission, overview.notifications]);

  useEffect(() => {
    if (!toastNotifications.length) {
      return undefined;
    }

    const timers = toastNotifications.map((notification) =>
      window.setTimeout(() => {
        setToastNotifications((current) => current.filter((item) => item._id !== notification._id));
      }, 6000));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [toastNotifications]);

  const handleSearchTargetSelect = (target: SearchTarget) => {
    setSearchQuery('');
    setIsSearchOpen(false);
    setIsMobileMoreOpen(false);

    if (target.kind === 'course' || target.kind === 'lesson' || target.kind === 'saved') {
      setActiveTab('courses');
      onContinueLearningNavigate(target.courseId, target.lessonId || null, null, null, null);
      return;
    }

    setActiveTab(target.tab);
  };

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setIsSearchOpen(false);
    setIsMobileMoreOpen(false);
    setIsNotificationSheetOpen(false);
  };

  const openNotifications = () => {
    setIsSearchOpen(false);
    setIsMobileMoreOpen(false);
    setIsNotificationSheetOpen(true);
  };

  const enableBrowserAlerts = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }

    setNotificationPermissionBusy(true);
    try {
      const nextPermission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      setNotificationPermission(nextPermission);
      const enabled = nextPermission === 'granted';
      setBrowserAlertsEnabled(enabled);

      if (!enabled) {
        return;
      }

      await playNotificationChime(audioContextRef).catch(() => undefined);
      const targetUrl = typeof window !== 'undefined' ? `${window.location.origin}/?tab=overview` : '/';
      const options: NotificationOptions = {
        body: 'Chrome alerts are enabled. You will hear and see new learner updates here.',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'edumaster-alerts-enabled',
        data: { url: targetUrl },
      };

      if (serviceWorkerRegistrationRef.current) {
        await serviceWorkerRegistrationRef.current.showNotification('Browser alerts enabled', options);
        return;
      }

      const browserNotification = new Notification('Browser alerts enabled', options);
      browserNotification.onclick = () => {
        window.focus();
        window.location.href = targetUrl;
        browserNotification.close();
      };
    } finally {
      setNotificationPermissionBusy(false);
    }
  };

  const disableBrowserAlerts = () => {
    setBrowserAlertsEnabled(false);
  };

  const testBrowserAlert = async () => {
    if (notificationPermission !== 'granted' || !browserAlertsEnabled) {
      return;
    }

    await playNotificationChime(audioContextRef).catch(() => undefined);
    const targetUrl = typeof window !== 'undefined' ? `${window.location.origin}/?tab=overview` : '/';
    const options: NotificationOptions = {
      body: 'This is how new doubts, reports, and replies will alert you.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'edumaster-alert-test',
      data: { url: targetUrl },
    };

    if (serviceWorkerRegistrationRef.current) {
      await serviceWorkerRegistrationRef.current.showNotification('Test alert from VaronEnglish', options);
      return;
    }

    if (typeof window !== 'undefined' && 'Notification' in window) {
      const browserNotification = new Notification('Test alert from VaronEnglish', options);
      browserNotification.onclick = () => {
        window.focus();
        window.location.href = targetUrl;
        browserNotification.close();
      };
    }
  };

  const handleNotificationsReadAll = async () => {
    try {
      await EduService.markAllNotificationsRead();
      await onRefresh();
    } catch {
      // Keep sheet usable if read-all fails.
    }
  };

  const handleNotificationOpen = async (notification: NotificationItem) => {
    setIsNotificationSheetOpen(false);
    if (!notification.isRead) {
      try {
        await EduService.markNotificationRead(notification._id);
        await onRefresh();
      } catch {
        // Keep navigation best-effort even if mark-read fails.
      }
    }
    const target = getNotificationNavigationTarget(notification);
    if (target) {
      setIsSearchOpen(false);
      setIsMobileMoreOpen(false);
      if (target.tab === 'live' && !LIVE_CLASSES_ENABLED) {
        onOpenNotification(notification);
        return;
      }

      setActiveTab(target.tab);

      if (target.tab === 'live' && target.liveClassId) {
        setPendingLiveClassId(target.liveClassId);
      }

      if (target.tab === 'courses' && target.courseId) {
        onContinueLearningNavigate(
          target.courseId,
          target.lessonId || null,
          target.doubtThreadId || null,
          target.reportId || null,
          target.supportPanel || null,
        );
      }

      return;
    }

    onOpenNotification(notification);
  };

  const openProfileEditor = () => {
    setIsMobileMoreOpen(false);
    setProfileError(null);
    setPasswordError(null);
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setIsProfileEditorOpen(true);
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileError(null);
    try {
      await updateProfile({
        name: profileForm.name,
        mobileNumber: profileForm.mobileNumber,
      });
      await onRefresh();
      setIsProfileEditorOpen(false);
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : 'Unable to update profile');
    } finally {
      setProfileSaving(false);
    }
  };

  const savePassword = async () => {
    setPasswordSaving(true);
    setPasswordError(null);
    try {
      if (!passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword) {
        throw new Error('Fill in all password fields.');
      }
      if (passwordForm.newPassword !== passwordForm.confirmPassword) {
        throw new Error('New password and confirm password must match.');
      }
      await changePassword(passwordForm);
      setIsProfileEditorOpen(false);
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : 'Unable to change password');
    } finally {
      setPasswordSaving(false);
    }
  };

  const renderActiveTab = () => {
    if (activeTab === 'overview') {
      return (
        <Suspense fallback={<DeferredPanelFallback label="dashboard" minHeightClass="min-h-[320px]" />}>
          <LazyOverviewFigmaTab
            overview={overview}
            onContinueLearning={(courseId, lessonId) => {
              onContinueLearningNavigate(courseId, lessonId, null, null, null);
              setActiveTab('courses');
            }}
            onOpenNotification={(notification) => { void handleNotificationOpen(notification); }}
            onOpenLiveTab={LIVE_CLASSES_ENABLED ? () => setActiveTab('live') : undefined}
            onOpenTestsTab={() => setActiveTab('tests')}
            onOpenRevisionTab={() => setActiveTab('revision')}
            onOpenCoursesTab={() => setActiveTab('courses')}
          />
        </Suspense>
      );
    }

    if (activeTab === 'courses') {
      return (
        <Suspense fallback={<DeferredPanelFallback label="courses and lessons" minHeightClass="min-h-[360px]" />}>
          <LazyCourseFigmaTab
            overview={overview}
            onRefresh={onRefresh}
            initialCourseId={resumeTarget?.courseId}
            initialLessonId={resumeTarget?.lessonId || null}
            initialDoubtThreadId={resumeTarget?.doubtThreadId || null}
            initialReportId={resumeTarget?.reportId || null}
            initialSupportPanel={resumeTarget?.supportPanel || null}
            onResumeNavigationHandled={onResumeNavigationHandled}
            savedTopicIds={savedTopicIds}
            onToggleSavedTopic={onToggleSavedTopic}
            onImmersiveModeChange={setIsImmersiveCoursePlayer}
            onOpenCbtExam={(test, onSubmitted) => {
              setActiveCourseCbtLaunch({ test, onSubmitted });
            }}
          />
        </Suspense>
      );
    }

    if (activeTab === 'tests') {
      return (
        <Suspense fallback={<DeferredPanelFallback label="test series" minHeightClass="min-h-[320px]" />}>
          <LazyTestSeriesFigmaTab
            overview={overview}
            onRefresh={onRefresh}
            onImmersiveModeChange={setIsImmersiveTestsFlow}
            onOpenLiveClass={LIVE_CLASSES_ENABLED ? (liveClassId) => {
              setPendingLiveClassId(liveClassId);
              setActiveTab('live');
            } : undefined}
          />
        </Suspense>
      );
    }

    if (activeTab === 'live' && LIVE_CLASSES_ENABLED) {
      return (
        <Suspense fallback={<DeferredPanelFallback label="live classes" minHeightClass="min-h-[320px]" />}>
          <LazyLiveClassesFigmaTab
            overview={overview}
            onRefresh={onRefresh}
            onMobileModeChange={setLiveMobileMode}
            initialLiveClassId={pendingLiveClassId}
            onInitialLiveClassHandled={() => setPendingLiveClassId(null)}
          />
        </Suspense>
      );
    }

    if (activeTab === 'live') {
      return (
        <Suspense fallback={<DeferredPanelFallback label="dashboard" minHeightClass="min-h-[320px]" />}>
          <LazyOverviewFigmaTab
            overview={overview}
            onContinueLearning={(courseId, lessonId) => {
              onContinueLearningNavigate(courseId, lessonId, null, null, null);
              setActiveTab('courses');
            }}
            onOpenNotification={(notification) => { void handleNotificationOpen(notification); }}
            onOpenTestsTab={() => setActiveTab('tests')}
            onOpenRevisionTab={() => setActiveTab('revision')}
            onOpenCoursesTab={() => setActiveTab('courses')}
          />
        </Suspense>
      );
    }

    if (activeTab === 'revision') {
      return (
        <RevisionTab
          overview={overview}
          savedTopics={savedTopics}
          onContinueLearning={(courseId, lessonId) => {
            onContinueLearningNavigate(courseId, lessonId, null, null, null);
            setActiveTab('courses');
          }}
        />
      );
    }

    if (activeTab === 'analytics') {
      return <AnalyticsTab overview={overview} />;
    }

    if (activeTab === 'admin' && overview.adminOverview) {
      return <AdminTab overview={overview} onRefresh={onRefresh} />;
    }

    return null;
  };

  return (
    <div className="min-h-dvh bg-[var(--page-bg)]">
      <div className="flex min-h-dvh">
        {!isImmersiveWorkspace && (
          <aside
	            className={cn(
	              'hidden shrink-0 overflow-y-auto px-4 py-5 lg:flex lg:flex-col',
	              'w-[284px] border-r border-[#dfe8f6] bg-[linear-gradient(180deg,#fbfdff_0%,#f3f8ff_54%,#eef5ff_100%)] text-[#1f2d4e]',
	            )}
            style={{ fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
          >
            <div>
              <div className="px-2">
                <BrandLogo tone="light" size="sm" />
                <p className="mt-[4px] text-[11px] leading-none text-[#7b8cab]">Competitive exam platform</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={openProfileEditor}
                    className="flex items-center gap-2 rounded-[16px] border border-[#dbe5f4] bg-white px-3 py-2 text-left text-[#20335c] shadow-[0_10px_24px_rgba(31,45,78,0.05)] transition hover:border-[#bdd4f7]"
                    aria-label="Open profile editor"
                  >
                    <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[10px] bg-[#edf4ff] text-[11px] font-bold text-[#1b5fe3]">
                      {buildInitials(learnerName)}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[10px] uppercase tracking-[0.18em] text-[#8b9ab3]">Account</span>
                      <span className="block truncate text-[12px] font-semibold">Profile</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={openNotifications}
                    className="relative flex items-center gap-2 rounded-[16px] border border-[#dbe5f4] bg-white px-3 py-2 text-left text-[#20335c] shadow-[0_10px_24px_rgba(31,45,78,0.05)] transition hover:border-[#bdd4f7]"
                    aria-label="Open notifications"
                  >
                    <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[10px] bg-[#f5f8ff] text-[#53647d]">
                      <BellRing className="h-[15px] w-[15px]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[10px] uppercase tracking-[0.18em] text-[#8b9ab3]">Alerts</span>
                      <span className="block truncate text-[12px] font-semibold">
                        {(overview.notificationCount ?? overview.notifications.length) > 0 ? `${overview.notificationCount ?? overview.notifications.length} new` : 'All clear'}
                      </span>
                    </span>
                  </button>
                </div>
              </div>

              <div className="relative mt-5">
                <div className="flex h-[44px] items-center gap-3 rounded-[16px] border border-[#dfe8f5] bg-white px-3.5 text-[#7b8cab] shadow-[0_10px_24px_rgba(31,45,78,0.05)]">
                  <Search className="h-[17px] w-[17px] shrink-0 text-[#6f82a5]" />
                  <input
                    value={searchQuery}
                    onFocus={() => setIsSearchOpen(true)}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      setIsSearchOpen(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setIsSearchOpen(false);
                      }

                      if (event.key === 'Enter' && filteredTargets[0]) {
                        event.preventDefault();
                        handleSearchTargetSelect(filteredTargets[0]);
                      }
                    }}
                    placeholder="Search lessons, tests..."
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#20335c] outline-none placeholder:text-[#8b9ab3]"
                  />
                </div>
                <SearchPanel
                  open={isSearchOpen}
                  query={searchQuery}
                  results={filteredTargets}
                  onSelect={handleSearchTargetSelect}
                  onClose={() => setIsSearchOpen(false)}
                />
              </div>

              <div className="mt-5 rounded-[20px] border border-[#e3ebf7] bg-[linear-gradient(180deg,#f8fbff_0%,#eef5ff_100%)] px-[14px] py-[16px] shadow-[0_16px_34px_rgba(31,45,78,0.06)]">
                <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#8b9ab3]">Current learner</p>
                <p className="mt-[10px] truncate text-[14px] font-semibold text-[#20335c]">{learnerName}</p>
                <p className="mt-[2px] text-[12px] text-[#7b8cab]">{learnerLevel}</p>

                <div className="mt-[16px] grid grid-cols-2 gap-[10px] text-[11px]">
                  {sidebarStats.map((stat) => (
                    <div key={stat.label} className="rounded-[15px] border border-[#e7eef9] bg-white px-[12px] py-[10px] shadow-[0_8px_18px_rgba(31,45,78,0.04)]">
                      <p className="text-[#7b8cab]">{stat.label}</p>
                      <p className="mt-[6px] text-[16px] font-semibold text-[#20335c]">{stat.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-[18px]">
              <nav className="space-y-[5px]">
                {overviewSidebarTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      if (tab.id === 'admin' && !isAdmin) {
                        return;
                      }

                      handleTabChange(tab.id);
                    }}
                    data-testid={`nav-${tab.id}`}
                    className={cn(
                      'flex w-full items-center gap-[11px] rounded-[16px] px-[11px] py-[10px] text-left text-[13px] font-semibold transition',
                      activeTab === tab.id
                        ? 'bg-[#eef4ff] text-[#1b5fe3] shadow-[0_10px_22px_rgba(37,99,235,0.10)]'
                        : 'text-[#53647d] hover:bg-[#f3f7fc] hover:text-[#20335c]',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[13px]',
                        activeTab === tab.id ? 'bg-white text-[#1b5fe3]' : 'bg-[#f1f5fb] text-[#6f82a5]',
                      )}
                    >
                      <tab.icon className="h-[17px] w-[17px]" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                  </button>
                ))}
              </nav>
            </div>

            <div className="mt-auto space-y-[12px]">
              <div className="rounded-[20px] border border-[#e3ebf7] bg-white px-[14px] py-[16px] shadow-[0_14px_30px_rgba(31,45,78,0.05)]">
                <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#8b9ab3]">Next best move</p>
                <p className="mt-[12px] overflow-hidden text-[13px] leading-[1.6] text-[#53647d] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                  {continueTitle}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (continueCourse) {
                      onContinueLearningNavigate(continueCourse._id, continueCourse.continueLesson?.id || null, null, null, null);
                      setActiveTab('courses');
                      return;
                    }

                    handleTabChange('revision');
                  }}
                  className="mt-[14px] inline-flex h-[36px] items-center rounded-[12px] bg-[#1b5fe3] px-[15px] text-[12px] font-semibold text-white shadow-[0_12px_24px_rgba(37,99,235,0.18)] transition hover:bg-[#164fc2]"
                >
                  Resume now
                </button>
              </div>

              <div className="rounded-[18px] border border-[#e3ebf7] bg-white p-[8px] shadow-[0_10px_22px_rgba(31,45,78,0.04)]">
                <button
                  type="button"
                  onClick={onLogout}
                  className="flex w-full items-center gap-[10px] rounded-[13px] px-[12px] py-[11px] text-[13px] font-semibold text-[#53647d] transition hover:bg-[#f3f7fc] hover:text-[#20335c]"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              </div>
            </div>
          </aside>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden" data-testid="shell-ready">
          {!isImmersiveWorkspace && !hideMobileShellNav && (
	            <div
	              className="sticky top-0 z-30 border-b border-[#1f3766] bg-[linear-gradient(180deg,#17233f_0%,#15294f_100%)] px-5 pb-5 pt-[max(1.25rem,env(safe-area-inset-top))] lg:hidden"
              style={{ fontFamily: LIVE_FONT_STACK }}
            >
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  data-testid="mobile-nav-more"
                  onClick={() => {
                    setIsMobileMoreOpen(true);
                    setIsSearchOpen(false);
                  }}
	                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/24 bg-white/16 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]"
                  aria-label="Open profile menu"
                >
                  <Menu className="h-7 w-7" />
                </button>

                <div ref={searchContainerRef} className="relative min-w-0 flex-1">
	                  <div className="flex h-14 items-center gap-3 rounded-[14px] bg-[#24365f] px-4 text-[#afbdd5] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                    <Search className="h-6 w-6 shrink-0" />
                    <input
                      data-testid="mobile-global-search-input"
                      value={searchQuery}
                      onFocus={() => {
                        setIsSearchOpen(true);
                        setIsMobileMoreOpen(false);
                      }}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        setIsSearchOpen(true);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setIsSearchOpen(false);
                        }

                        if (event.key === 'Enter' && filteredTargets[0]) {
                          event.preventDefault();
                          handleSearchTargetSelect(filteredTargets[0]);
                        }
                      }}
                      placeholder="Search exams, tests and more"
	                      className="min-w-0 flex-1 bg-transparent text-[16px] text-white outline-none placeholder:text-[#afbdd5]"
                    />
                  </div>
                  <SearchPanel
                    open={isSearchOpen}
                    query={searchQuery}
                    results={filteredTargets}
                    onSelect={handleSearchTargetSelect}
                    onClose={() => setIsSearchOpen(false)}
                  />
                </div>

                <button
                  type="button"
                  onClick={openNotifications}
	                  className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/24 bg-white/16 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]"
                  aria-label="Open notifications"
                >
                  <BellRing className="h-7 w-7" />
                  {(overview.notificationCount ?? overview.notifications.length) > 0 && (
	                    <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#35d07f] px-1 text-[9px] font-bold text-[#092214]">
                      {overview.notificationCount ?? overview.notifications.length}
                    </span>
                  )}
                </button>
              </div>
            </div>
          )}

          {isLiveWorkspace && !isImmersiveWorkspace && (
            <div className="hidden border-b border-[#edf2fb] bg-white px-4 py-5 lg:block lg:px-8">
              <div className="mx-auto flex w-full max-w-[1460px] items-center gap-4">
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[18px] border border-[#e9eff8] bg-[#fbfcff] px-5 py-3 shadow-[0_10px_24px_rgba(15,23,42,0.04)] lg:max-w-[640px]">
                    <Search className="h-5 w-5 text-[#6f82a5]" />
                    <input
                      value={searchQuery}
                      onFocus={() => {
                        setIsSearchOpen(true);
                        setIsMobileMoreOpen(false);
                      }}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        setIsSearchOpen(true);
                      }}
                      placeholder="Search for tests, classes, notes..."
                      className="min-w-0 flex-1 bg-transparent text-[15px] text-[#31486d] outline-none placeholder:text-[#95a3bc]"
                    />
                    <span className="hidden rounded-[10px] border border-[#e5ebf6] bg-white px-2.5 py-1 text-[12px] font-semibold text-[#7b8cab] sm:inline-flex">
                      ⌘ K
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showShellHeader && (
            <header className="sticky top-0 z-20 border-b border-white/60 bg-[var(--page-bg)]/88 px-4 py-4 backdrop-blur-xl sm:px-6 lg:px-8">
              <div className="mx-auto flex w-full max-w-[1380px] flex-col gap-4">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="max-w-3xl">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--ink-soft)]">{activeMeta.eyebrow}</p>
                        <h1 className="mt-3 text-2xl font-semibold leading-tight text-[var(--ink)] sm:text-[2.2rem]">{activeMeta.title}</h1>
                        <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--ink-soft)] sm:text-base">{activeMeta.description}</p>
                      </div>
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/70 bg-white/85 shadow-sm lg:hidden">
                        <UserCircle2 className="h-5 w-5 text-[var(--accent-rust)]" />
                      </div>
                    </div>
                  </div>

                  <div className="w-full xl:max-w-[620px]">
                    <div ref={searchContainerRef} className="relative">
                      <div className={cn(
                        'flex items-center gap-3 rounded-[28px] border px-4 py-3.5 shadow-[0_16px_34px_rgba(15,23,42,0.07)]',
                        isSearchOpen ? 'border-[var(--accent-rust)]/24 bg-white' : 'border-white/70 bg-white/92',
                      )}>
                        <Search className="h-4 w-4 text-[var(--accent-rust)]" />
                        <input
                          data-testid="global-search-input"
                          value={searchQuery}
                          onFocus={() => {
                            setIsSearchOpen(true);
                            setIsMobileMoreOpen(false);
                          }}
                          onChange={(event) => {
                            setSearchQuery(event.target.value);
                            setIsSearchOpen(true);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setIsSearchOpen(false);
                            }

                            if (event.key === 'Enter' && filteredTargets[0]) {
                              event.preventDefault();
                              handleSearchTargetSelect(filteredTargets[0]);
                            }
                          }}
                          placeholder="Search lessons, mocks, and saved topics..."
                          className="w-full bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-soft)]"
                        />
                        <span className="hidden rounded-full bg-[var(--accent-cream)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent-rust)] md:inline-flex">
                          Search
                        </span>
                      </div>
                      <SearchPanel
                        open={isSearchOpen}
                        query={searchQuery}
                        results={filteredTargets}
                        onSelect={handleSearchTargetSelect}
                        onClose={() => setIsSearchOpen(false)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </header>
          )}

          <main className={cn(
            'mx-auto flex w-full flex-1 flex-col overflow-x-hidden overflow-y-auto lg:overflow-hidden',
            (isOverviewWorkspace || isCoursesWorkspace || isTestsWorkspace)
              ? 'max-w-none px-0 pb-0 pt-0'
              : isLiveWorkspace
                ? cn('max-w-[1460px] px-0 pt-0 sm:px-4 sm:pt-5 lg:px-7 lg:pb-10', hideMobileShellNav ? 'pb-6 sm:pb-8 lg:pb-10' : 'pb-28 sm:pb-36 lg:pb-10')
                : 'max-w-[1380px] px-4 pb-36 pt-4 sm:px-6 lg:px-8 lg:pb-10',
            showShellHeader && !isCoursesWorkspace && !isLiveWorkspace ? 'pt-6' : '',
          )} style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex flex-1 flex-col"
              >
                {renderActiveTab()}
              </motion.div>
            </AnimatePresence>
          </main>

          {activeCourseCbtLaunch && (
            <ExactCbtTestPlayer
              test={activeCourseCbtLaunch.test}
              onClose={() => setActiveCourseCbtLaunch(null)}
              onSubmitAttempt={async (test, answers, startedAt) => buildLocalTestAttemptResult(test, answers, startedAt)}
              onSubmitted={async () => {
                activeCourseCbtLaunch.onSubmitted?.();
                setActiveCourseCbtLaunch(null);
              }}
            />
          )}

          {!isImmersiveWorkspace && !isImmersiveTestsFlow && !hideMobileShellNav && (
            <>
              <MobileMoreSheet
                open={isMobileMoreOpen}
                tabs={utilityTabs}
                activeTab={activeTab}
                onSelect={handleTabChange}
                onClose={() => setIsMobileMoreOpen(false)}
                onLogout={onLogout}
                onOpenProfile={openProfileEditor}
                learnerName={learnerName}
                learnerEmail={learnerEmail}
                learnerPhone={learnerPhone}
                learnerInitials={buildInitials(learnerName)}
              />
              <MobileNotificationSheet
                open={isNotificationSheetOpen}
                notifications={overview.notifications}
                onClose={() => setIsNotificationSheetOpen(false)}
                onOpen={(notification) => { void handleNotificationOpen(notification); }}
                onMarkAllRead={() => { void handleNotificationsReadAll(); }}
                browserAlertsSupported={notificationPermission !== 'unsupported'}
                browserAlertsEnabled={browserAlertsEnabled}
                notificationPermission={notificationPermission}
                notificationPermissionBusy={notificationPermissionBusy}
                onEnableBrowserAlerts={() => { void enableBrowserAlerts(); }}
                onDisableBrowserAlerts={disableBrowserAlerts}
                onTestBrowserAlert={() => { void testBrowserAlert(); }}
              />
              <ProfileEditorSheet
                open={isProfileEditorOpen}
                form={profileForm}
                passwordForm={passwordForm}
                profileSaving={profileSaving}
                passwordSaving={passwordSaving}
                profileError={profileError}
                passwordError={passwordError}
                onProfileChange={(field, value) => setProfileForm((current) => ({ ...current, [field]: value }))}
                onPasswordChange={(field, value) => setPasswordForm((current) => ({ ...current, [field]: value }))}
                onClose={() => setIsProfileEditorOpen(false)}
                onSaveProfile={() => void saveProfile()}
                onSavePassword={() => void savePassword()}
              />
              <InAppNotificationToasts
                notifications={toastNotifications}
                onOpen={(notification) => {
                  setToastNotifications((current) => current.filter((item) => item._id !== notification._id));
                  void handleNotificationOpen(notification);
                }}
                onDismiss={(notificationId) => {
                  setToastNotifications((current) => current.filter((item) => item._id !== notificationId));
                }}
              />

              <div
                className="pointer-events-none fixed inset-x-0 bottom-0 z-30 border-t border-[#e5ebf4] bg-white px-5 pt-2 shadow-[0_-12px_34px_rgba(15,23,42,0.08)] lg:hidden"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)', fontFamily: LIVE_FONT_STACK }}
              >
                <div className="pointer-events-auto grid grid-cols-4 items-center gap-2">
                  {primaryNavTabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => handleTabChange(tab.id)}
                      data-testid={`mobile-nav-${tab.id}`}
                      className={cn(
                        'flex min-h-[68px] flex-col items-center justify-center gap-[4px] rounded-[30px] px-2 py-[8px] text-[13px] font-semibold transition',
                        activeTab === tab.id ? 'bg-[#eeeeef] text-[#2f6fe4]' : 'text-[#20242d]',
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-[30px] w-[30px] items-center justify-center rounded-[10px]',
                          activeTab === tab.id ? 'text-[#2f6fe4]' : 'text-[#8c94a3]',
                        )}
                      >
                        <tab.icon className="h-[19px] w-[19px]" />
                      </div>
                      {mobileNavLabels[tab.id]}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const OverviewTab = ({
  overview,
  onContinueLearning,
  onOpenNotification,
  savedTopics,
}: {
  overview: PlatformOverview;
  onContinueLearning: (courseId: string, lessonId?: string | null) => void;
  onOpenNotification: (notification: NotificationItem) => void;
  savedTopics: SavedTopic[];
}) => {
  const learnerName = overview.user?.name || 'Learner';
  const enrolledCourses = overview.courses.filter((course) => course.enrolled);
  const continueCourse = overview.dashboard.continueLearning[0] || enrolledCourses[0] || overview.courses[0] || null;
  const secondaryCourse = overview.dashboard.continueLearning[1] || enrolledCourses[1] || overview.courses[1] || null;
  const activeCourses = [continueCourse, secondaryCourse].filter(
    (course, index, items): course is NonNullable<typeof course> => Boolean(course) && items.findIndex((item) => item?._id === course?._id) === index,
  );
  const nextLiveClass = LIVE_CLASSES_ENABLED
    ? overview.liveClasses.find((liveClass) => {
      const state = `${liveClass.status || ''} ${liveClass.mode || ''}`.toLowerCase();
      return state.includes('live') || state.includes('scheduled') || state.includes('upcoming');
    }) || overview.liveClasses[0] || null
    : null;
  const nextTest = overview.dashboard.latestMockTest || overview.testSeries[0] || null;
  const scoreValue = overview.dashboard.latestMockTest?.score ?? Math.round(overview.analytics.accuracy || overview.dashboard.accuracy || 0);
  const rankValue = overview.dashboard.latestMockTest?.rank ?? null;
  const summaryStats = [
    { label: 'Accuracy', value: `${overview.dashboard.accuracy}%`, icon: Target },
    { label: 'Speed', value: `${overview.dashboard.speed}x`, icon: Gauge },
    { label: 'Streak', value: `${overview.dashboard.streak}d`, icon: Flame },
  ];
  const savedTopicCards = savedTopics.length > 0 ? savedTopics.slice(0, 2) : [];
  const focusTopics = overview.dashboard.weakTopics.slice(0, 2);
  const highlightTopic = focusTopics[0] || savedTopics[0]?.lessonTitle || continueCourse?.continueLesson?.title || continueCourse?.title || 'Weekly focus';
  const recommendation = continueCourse
    ? `Resume ${continueCourse.continueLesson?.title || continueCourse.title} and keep your current study rhythm intact.`
    : savedTopics[0]
      ? `Revisit ${savedTopics[0].lessonTitle} and rebuild the topic from the last saved checkpoint.`
      : 'Open one lesson, finish one block, and keep the dashboard moving with a small win.';
  const nextTestTitle = nextTest
    ? 'title' in nextTest
      ? nextTest.title
      : 'Mock test'
    : 'Mock Test 02';
  const nextTestSubtitle = nextTest
    ? 'category' in nextTest
      ? nextTest.category
      : 'SSC JE Electrical Power Track'
    : 'SSC JE Electrical Power Track';
  const nextTestDuration = nextTest
    ? 'durationMinutes' in nextTest
      ? nextTest.durationMinutes
      : 60
    : 60;

  return (
    <div
      data-testid="overview-dashboard"
      className="relative overflow-hidden rounded-[36px] border border-white/70 bg-[linear-gradient(180deg,#dfe8fb_0%,#edf2ff_42%,#e7edf9_100%)] px-4 py-5 shadow-[0_30px_100px_rgba(15,23,42,0.08)] sm:px-5 sm:py-6 lg:px-6"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_14%,rgba(255,255,255,0.92),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(117,166,255,0.24),transparent_20%),radial-gradient(circle_at_70%_84%,rgba(123,176,255,0.18),transparent_26%)] opacity-90" />
      <div className="relative mx-auto flex w-full max-w-[1400px] flex-col gap-5">
        <div data-testid="overview-topbar" className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/80 bg-white/68 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--ink-soft)] shadow-[0_10px_24px_rgba(15,23,42,0.06)] backdrop-blur">
              <LayoutDashboard className="h-3.5 w-3.5 text-[var(--accent-rust)]" />
              Overview dashboard
            </div>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[var(--ink)] sm:text-[3rem]">
              Good to see you, {learnerName}.
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[var(--ink-soft)] sm:text-base">
              {continueCourse
                ? `Continue ${continueCourse.exam} and keep the next lesson, revision queue, and practice flow connected.`
                : 'Start one lesson, then build revision around what you actually study.'}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/72 px-3 py-1.5 text-xs font-semibold text-[var(--accent-rust)] shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
                {overview.highlights.concurrencyTarget}
              </span>
              <span className="rounded-full bg-white/72 px-3 py-1.5 text-xs font-semibold text-[var(--ink-soft)] shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
                {overview.highlights.deploymentProfile}
              </span>
              {overview.highlights.modules.slice(0, 2).map((module) => (
                <span key={module} className="rounded-full bg-[rgba(255,255,255,0.66)] px-3 py-1.5 text-xs font-medium text-[var(--ink-soft)]">
                  {module}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 self-start lg:pt-1">
            <button
              type="button"
              data-testid="overview-search-pill"
              className="flex h-11 items-center gap-2 rounded-full border border-white/80 bg-white/72 px-4 text-sm text-[var(--ink-soft)] shadow-[0_10px_24px_rgba(15,23,42,0.07)] backdrop-blur transition hover:bg-white/86"
            >
              <Search className="h-4 w-4 text-[var(--accent-rust)]" />
              <span className="hidden sm:inline">Search...</span>
              <span className="sm:hidden">Search</span>
            </button>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]">
          <div className="space-y-5">
            <section
              data-testid="overview-hero"
              className="relative overflow-hidden rounded-[34px] border border-white/40 bg-[linear-gradient(135deg,#2f6fe4_0%,#3b82f6_50%,#7cb8ff_100%)] p-6 text-white shadow-[0_32px_110px_rgba(35,84,190,0.28)] sm:p-8"
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(255,255,255,0.18),transparent_24%),radial-gradient(circle_at_82%_62%,rgba(255,255,255,0.12),transparent_26%),linear-gradient(120deg,rgba(255,255,255,0.12),transparent_24%)]" />
              <div className="absolute -right-12 top-10 h-48 w-48 rounded-full bg-white/10 blur-3xl" />
              <div className="absolute bottom-0 right-0 h-32 w-64 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.22),transparent_65%)] blur-2xl" />
              <div className="relative max-w-3xl">
                <div className="flex items-center gap-3 text-sm font-semibold">
                  <span className="rounded-full bg-white/16 px-3 py-1.5 backdrop-blur">Continue Learning</span>
                  <span className="text-white/78">{continueCourse?.progressPercent || 0}%</span>
                </div>
                <h3 className="mt-4 max-w-2xl text-3xl font-semibold tracking-[-0.04em] sm:text-[2.7rem]">
                  {continueCourse?.title || 'No active course yet'}
                </h3>
                <p className="mt-4 max-w-2xl text-sm leading-8 text-white/78 sm:text-base">
                  {continueCourse
                    ? `Resume ${continueCourse.continueLesson?.title || 'the next lesson'} and build your revision around what you actually study.`
                    : overview.ai.headline}
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    data-testid="overview-continue-cta"
                    onClick={() => {
                      if (continueCourse) {
                        onContinueLearning(continueCourse._id, continueCourse.continueLesson?.id || null);
                      }
                    }}
                    className="inline-flex items-center gap-2 rounded-[18px] bg-white px-5 py-3 text-base font-semibold text-[var(--accent-rust)] shadow-[0_18px_30px_rgba(8,29,61,0.16)] transition hover:-translate-y-0.5"
                  >
                    Continue Learning
                    <ArrowRight className="h-5 w-5" />
                  </button>
                  <span className="rounded-full border border-white/24 bg-white/10 px-4 py-3 text-sm font-medium text-white/86 backdrop-blur">
                    {continueCourse?.exam || overview.highlights.modules[0] || 'Exam prep'}
                  </span>
                </div>
                <div className="mt-7 grid gap-3 sm:grid-cols-3">
                  {summaryStats.map((stat) => (
                    <div key={stat.label} className="rounded-[22px] border border-white/20 bg-white/10 p-4 backdrop-blur">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/70">{stat.label}</p>
                          <p className="mt-2 text-2xl font-semibold">{stat.value}</p>
                        </div>
                        <stat.icon className="h-5 w-5 text-white/80" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section data-testid="overview-active-courses" className="space-y-4">
              <SectionHeader title="Active Courses" caption="Your current track" />
              <div className="grid gap-4 lg:grid-cols-2">
                {activeCourses.length > 0 ? activeCourses.map((course, index) => (
                  <button
                    key={course._id}
                    type="button"
                    data-testid={`overview-active-course-card-${index}`}
                    onClick={() => onContinueLearning(course._id, course.continueLesson?.id || null)}
                    className="group rounded-[28px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(245,249,255,0.95)_100%)] p-5 text-left shadow-[0_20px_60px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_70px_rgba(15,23,42,0.12)]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="inline-flex rounded-full bg-[var(--accent-cream)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent-rust)]">
                          {course.exam}
                        </p>
                        <h4 className="mt-3 line-clamp-2 text-2xl font-semibold tracking-[-0.03em] text-[var(--ink)]">
                          {course.title}
                        </h4>
                        <p className="mt-1 text-base text-[var(--ink-soft)]">{course.subject}</p>
                      </div>
                      <div className="rounded-full bg-[linear-gradient(135deg,#e7eefc_0%,#ffffff_100%)] px-3 py-1.5 text-sm font-medium text-[var(--ink-soft)] shadow-inner">
                        {course.exam}
                      </div>
                    </div>

                    <div className="mt-5 flex items-center justify-between text-sm text-[var(--ink-soft)]">
                      <span>{course.progressPercent || 0}% Completed</span>
                      <span>{course.lessonCount || 0} lessons</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-[rgba(93,134,220,0.16)]">
                      <div
                        className="h-full rounded-full bg-[linear-gradient(90deg,#2f6fe4_0%,#5aa3ff_100%)]"
                        style={{ width: `${Math.min(course.progressPercent || 0, 100)}%` }}
                      />
                    </div>

                    <div className="mt-5 flex items-center justify-between gap-3">
                      <div className="grid grid-cols-3 gap-4 text-sm text-[var(--ink-soft)]">
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.16em]">Modules</p>
                          <p className="mt-1 font-semibold text-[var(--ink)]">{course.modules?.length || 0}</p>
                        </div>
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.16em]">Tests</p>
                          <p className="mt-1 font-semibold text-[var(--ink)]">{Math.max(1, Math.round((course.lessonCount || 0) / 24))}</p>
                        </div>
                        <div>
                          <p className="text-[11px] uppercase tracking-[0.16em]">Questions</p>
                          <p className="mt-1 font-semibold text-[var(--ink)]">{formatLargeMetric((course.lessonCount || 0) * 12)}</p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(47,111,228,0.24)]">
                        Continue
                        <ChevronRight className="h-4 w-4" />
                      </span>
                    </div>
                  </button>
                )) : (
                  <div className="rounded-[28px] border border-dashed border-[var(--line)] bg-white/70 p-6 text-sm text-[var(--ink-soft)]">
                    No active courses yet. Enroll in a course to fill this dashboard section.
                  </div>
                )}
              </div>
            </section>

            <section data-testid="overview-signals" className="space-y-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[var(--ink-soft)]">Signals</p>
                  <div className="mt-3 flex items-center gap-5 text-base font-medium text-[var(--ink-soft)] sm:text-lg">
                    <span className="border-b-2 border-[var(--accent-rust)] pb-2 text-[var(--ink)]">Signals</span>
                    <span>Saved</span>
                    <span>Focus</span>
                  </div>
                </div>
                <span className="hidden rounded-full bg-white/70 px-3 py-1.5 text-xs font-semibold text-[var(--ink-soft)] shadow-[0_10px_24px_rgba(15,23,42,0.05)] sm:inline-flex">
                  {overview.dashboard.weakTopics.length + savedTopics.length} items ready
                </span>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.16fr)_minmax(0,0.84fr)]">
                <div className="space-y-4">
                  <div
                    data-testid="overview-streak"
                    className="rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(247,250,255,0.94)_100%)] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-2xl">🔥 Keep the Streak On</p>
                        <p className="mt-2 text-sm text-[var(--ink-soft)]">
                          CBT practice, a short revision block, and one mock touchpoint keep your momentum alive.
                        </p>
                      </div>
                      <div className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3 text-right">
                        <p className="text-sm text-[var(--ink-soft)]">Current streak</p>
                        <p className="mt-1 text-3xl font-semibold text-[var(--ink)]">{overview.dashboard.streak} day{overview.dashboard.streak === 1 ? '' : 's'}</p>
                      </div>
                    </div>
                    <div className="mt-5 grid gap-3 sm:grid-cols-[1.2fr_0.8fr]">
                      <div className="rounded-[24px] bg-[var(--accent-cream)] p-4">
                        <p className="text-sm font-semibold text-[var(--ink)]">Today&apos;s focus</p>
                        <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">{highlightTopic}</p>
                      </div>
                      <button
                        type="button"
                        className="rounded-[24px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-5 py-4 text-left text-white shadow-[0_16px_32px_rgba(47,111,228,0.22)]"
                      >
                        <p className="text-sm font-semibold">Continue</p>
                        <p className="mt-2 text-sm text-white/80">Keep one clean study block moving forward.</p>
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    {savedTopicCards.length > 0 ? savedTopicCards.map((topic, index) => (
                      <button
                        key={`${topic.courseId}:${topic.lessonId}`}
                        type="button"
                        data-testid={`overview-saved-topic-${index}`}
                        onClick={() => onContinueLearning(topic.courseId, topic.lessonId)}
                        className="rounded-[26px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-4 text-left shadow-[0_18px_42px_rgba(15,23,42,0.07)] transition hover:-translate-y-0.5"
                      >
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{topic.exam}</p>
                        <h4 className="mt-2 text-lg font-semibold text-[var(--ink)]">{topic.lessonTitle}</h4>
                        <p className="mt-1 text-sm text-[var(--ink-soft)]">{topic.courseTitle}</p>
                        <div className="mt-4 flex items-center justify-between text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                          <span>{topic.moduleTitle || 'Saved topic'}</span>
                          <ChevronRight className="h-4 w-4" />
                        </div>
                      </button>
                    )) : (
                      <>
                        <div className="rounded-[26px] border border-dashed border-[var(--line)] bg-white/70 p-4 text-sm text-[var(--ink-soft)]">
                          Save topics while studying to pin them here for quick revision.
                        </div>
                        <div className="rounded-[26px] border border-dashed border-[var(--line)] bg-white/70 p-4 text-sm text-[var(--ink-soft)]">
                          Your saved lessons will appear here once you start bookmarking the material.
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div
                    data-testid="overview-recommendation"
                    className="rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
                  >
                    <p className="text-xl font-semibold tracking-[-0.03em] text-[var(--ink)]">Circuits & Network Reduction</p>
                    <p className="mt-1 text-sm text-[var(--ink-soft)]">Recommended Track</p>
                    <p className="mt-4 text-sm leading-7 text-[var(--ink-soft)]">
                      {recommendation}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        if (continueCourse) {
                          onContinueLearning(continueCourse._id, continueCourse.continueLesson?.id || null);
                        }
                      }}
                      className="mt-5 inline-flex items-center gap-2 rounded-[18px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_32px_rgba(47,111,228,0.22)]"
                    >
                      Review now
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div
                      data-testid="overview-score-summary"
                      className="rounded-[26px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-5 shadow-[0_18px_42px_rgba(15,23,42,0.07)]"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <p className="text-sm text-[var(--ink-soft)]">Score</p>
                        <p className="text-3xl font-semibold text-[var(--ink)]">{scoreValue}</p>
                      </div>
                      <div className="mt-4 h-2 rounded-full bg-[rgba(92,136,223,0.16)]">
                        <div className="h-full rounded-full bg-[linear-gradient(90deg,#2f6fe4_0%,#7cb8ff_100%)]" style={{ width: `${Math.min(scoreValue, 100)}%` }} />
                      </div>
                      <div className="mt-4 flex items-center justify-between text-sm text-[var(--ink-soft)]">
                        <span>Rank</span>
                        <span className="text-2xl font-semibold text-[var(--ink)]">{rankValue ? `#${rankValue}` : 'Ready'}</span>
                      </div>
                    </div>

                    <div
                      data-testid="overview-next-test-card"
                      className="rounded-[26px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-5 text-left shadow-[0_18px_42px_rgba(15,23,42,0.07)]"
                    >
                      <p className="text-sm text-[var(--ink-soft)]">Next test</p>
                      <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{nextTestTitle}</p>
                      <p className="mt-1 text-sm text-[var(--ink-soft)]">{nextTestSubtitle}</p>
                      <p className="mt-1 text-sm text-[var(--ink-soft)]">{nextTestDuration} minutes</p>
                      <button
                        type="button"
                        className="mt-5 inline-flex items-center gap-2 rounded-[18px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_32px_rgba(47,111,228,0.22)]"
                      >
                        Attempt now
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <aside className="space-y-5 xl:sticky xl:top-6">
            <div
              data-testid="overview-action-queue"
              className="rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
            >
              <SectionHeader
                title="Action Queue"
                caption="Right now"
                action={<div className="rounded-full bg-[var(--accent-cream)] p-2 text-[var(--accent-rust)]"><ChevronRight className="h-4 w-4 rotate-[-90deg]" /></div>}
              />
              <div className="mt-5 space-y-4">
                {LIVE_CLASSES_ENABLED ? (
                  <>
                    <div className="rounded-[26px] border border-[rgba(103,151,234,0.18)] bg-[linear-gradient(180deg,#ffffff_0%,#f1f7ff_100%)] p-4 shadow-[0_14px_28px_rgba(15,23,42,0.05)]">
                      <span className="inline-flex rounded-full bg-[#f7a6aa] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white">
                        Live
                      </span>
                      <p className="mt-3 text-lg font-semibold text-[var(--ink)]">
                        {nextLiveClass ? 'Next live session is in progress.' : 'No live class running right now.'}
                      </p>
                      <p className="mt-2 text-sm text-[var(--ink-soft)]">
                        {nextLiveClass
                          ? nextLiveClass.title
                          : 'Your next live class will appear here once it is scheduled.'}
                      </p>
                      <div className="mt-4 flex items-center justify-between gap-3 text-sm text-[var(--ink-soft)]">
                        <span>{nextLiveClass?.instructor || overview.highlights.modules[0] || 'VaronEnglish'}</span>
                        <span>{nextLiveClass ? formatDateTime(nextLiveClass.startTime) : 'Upcoming'}</span>
                      </div>
                      <button
                        type="button"
                        className="mt-4 inline-flex w-full items-center justify-center rounded-[18px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(47,111,228,0.22)]"
                      >
                        Join now
                      </button>
                    </div>

                    <div className="rounded-[26px] border border-[rgba(103,151,234,0.16)] bg-white/86 p-4">
                      <p className="text-xl font-semibold tracking-[-0.03em] text-[var(--ink)]">Upcoming Classes</p>
                      <div className="mt-4 rounded-[22px] border border-[var(--line)] bg-white p-4">
                        <div className="grid grid-cols-6 gap-2 text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">
                          {['M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                            <span key={`${day}-${index}`}>{day}</span>
                          ))}
                        </div>
                        <div className="mt-4 space-y-3">
                          {(overview.liveClasses.slice(0, 2).length > 0 ? overview.liveClasses.slice(0, 2) : [null]).map((liveClass, index) => (
                            <div key={liveClass?._id || `live-placeholder-${index}`} className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-sm font-semibold text-[var(--ink)]">
                                  {liveClass ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(liveClass.startTime)) : '3:00 PM'}
                                </p>
                                <p className="mt-1 text-sm text-[var(--ink-soft)]">{liveClass?.title || 'General Awareness'}</p>
                              </div>
                              <span className="rounded-full bg-[var(--accent-cream)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-rust)]">
                                {liveClass?.status || 'scheduled'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="mt-4 inline-flex w-full items-center justify-center rounded-[18px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(47,111,228,0.22)]"
                      >
                        View timetable
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            <div
              data-testid="overview-upcoming-tests"
              className="rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
            >
              <SectionHeader title="Upcoming Tests" caption="Practice queue" />
              <div className="mt-4 rounded-[24px] border border-[var(--line)] bg-white p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-cream)] text-[var(--accent-rust)]">
                    <ClipboardCheck className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold text-[var(--ink)]">{nextTestTitle}</p>
                    <p className="mt-1 text-sm text-[var(--ink-soft)]">{nextTestSubtitle}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-end justify-between gap-3">
                  <div>
                    <p className="text-sm text-[var(--ink-soft)]">Due soon</p>
                    <p className="mt-1 text-2xl font-semibold text-[var(--ink)]">{`${Math.max(1, Math.ceil(nextTestDuration / 45))} days`}</p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-[18px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(47,111,228,0.22)]"
                  >
                    Attempt now
                  </button>
                </div>
              </div>
            </div>

            <div
              data-testid="overview-score-card"
              className="rounded-[30px] border border-white/72 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(246,250,255,0.94)_100%)] p-5 shadow-[0_20px_60px_rgba(15,23,42,0.08)]"
            >
              <div className="flex items-center justify-between gap-4">
                <p className="text-xl font-semibold text-[var(--ink)]">Score</p>
                <p className="text-3xl font-semibold text-[var(--ink)]">{scoreValue}</p>
              </div>
              <div className="mt-4 h-2 rounded-full bg-[rgba(92,136,223,0.16)]">
                <div className="h-full rounded-full bg-[linear-gradient(90deg,#2f6fe4_0%,#7cb8ff_100%)]" style={{ width: `${Math.min(scoreValue, 100)}%` }} />
              </div>
              <div className="mt-4 flex items-center justify-between text-sm text-[var(--ink-soft)]">
                <span>Rank</span>
                <span className="text-2xl font-semibold text-[var(--ink)]">{rankValue ? `#${rankValue}` : '#96'}</span>
              </div>
              <button
                type="button"
                className="mt-5 inline-flex w-full items-center justify-center rounded-[18px] bg-[linear-gradient(135deg,#2f6fe4_0%,#3f82f7_100%)] px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(47,111,228,0.22)]"
              >
                Attempt now
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

const buildSearchTargets = (overview: PlatformOverview, savedTopics: SavedTopic[]): SearchTarget[] => {
  const searchableCourses = overview.user?.role === 'admin'
    ? overview.courses
    : overview.courses.filter((course) => course.enrolled);

  const courseTargets = searchableCourses.flatMap((course) => {
    const lessonTargets = flattenCourseLessons(course).map((entry) => ({
      id: `lesson:${course._id}:${entry.lesson.id}`,
      kind: 'lesson' as const,
      title: entry.lesson.title,
      subtitle: [course.title, entry.moduleTitle, entry.chapterTitle, `${entry.lesson.durationMinutes} min`].filter(Boolean).join(' • '),
      tab: 'courses' as const,
      courseId: course._id,
      lessonId: entry.lesson.id,
    }));

    return [
      {
        id: `course:${course._id}`,
        kind: 'course' as const,
        title: course.title,
        subtitle: [course.exam, course.subject, course.instructor].filter(Boolean).join(' • '),
        tab: 'courses' as const,
        courseId: course._id,
        lessonId: course.continueLesson?.id || null,
      },
      ...lessonTargets,
    ];
  });

  const testTargets = overview.testSeries.map((test) => ({
    id: `test:${test._id}`,
    kind: 'test' as const,
    title: test.title,
    subtitle: [test.category, `${test.durationMinutes} min`, `${test.questions.length} questions`].join(' • '),
    tab: 'tests' as const,
  }));

  const savedTargets = savedTopics.map((topic) => ({
    id: `saved:${topic.courseId}:${topic.lessonId}`,
    kind: 'saved' as const,
    title: topic.lessonTitle,
    subtitle: [topic.courseTitle, topic.moduleTitle, topic.chapterTitle, 'Saved topic'].filter(Boolean).join(' • '),
    tab: 'revision' as const,
    courseId: topic.courseId,
    lessonId: topic.lessonId,
  }));

  return [...savedTargets, ...courseTargets, ...testTargets];
};

const buildRevisionPlan = (overview: PlatformOverview, savedTopics: SavedTopic[]): RevisionDayPlan[] => {
  const today = new Date();
  const latestMock = overview.dashboard.latestMockTest;
  const weakTopics = overview.dashboard.weakTopics.slice(0, 3);
  const strongTopics = overview.dashboard.strongTopics.slice(0, 2);
  const continueCourse = overview.dashboard.continueLearning[0];
  const prioritySaved = savedTopics.slice(0, 3);
  const latestMistakes = latestMock?.solutions.filter((solution) => !isSolutionCorrect(solution)).slice(0, 3) || [];

  const templates = [
    {
      title: 'Recovery sprint',
      summary: weakTopics.length > 0 ? `Repair ${weakTopics.join(', ')} while the last mock is still fresh.` : 'Start with your weakest recent test areas and clear conceptual gaps first.',
      actions: [
        latestMistakes[0] ? `Rework ${latestMistakes[0].topic} mistakes from the latest mock.` : 'Reopen your latest mock and inspect incorrect answers.',
        weakTopics[0] ? `Watch one focused lesson on ${weakTopics[0]}.` : 'Watch one focused concept lesson.',
        'Finish with one short sectional practice set.',
      ],
    },
    {
      title: 'Concept consolidation',
      summary: continueCourse ? `Push ${continueCourse.title} forward instead of opening too many parallel topics.` : 'Use a disciplined single-subject session to build momentum.',
      actions: [
        continueCourse?.continueLesson?.title ? `Resume ${continueCourse.continueLesson.title}.` : 'Resume your most recently active lesson.',
        prioritySaved[0] ? `Revise saved topic ${prioritySaved[0].lessonTitle}.` : 'Save one important lesson for later revision.',
        'Make quick handwritten notes or formula points before closing.',
      ],
    },
    {
      title: 'Speed and accuracy day',
      summary: 'Balance timed practice with clean review so speed gains do not reduce accuracy.',
      actions: [
        'Attempt one lesson CBT without interruptions.',
        latestMock ? `Compare your pace against the latest mock score of ${latestMock.score}/${latestMock.totalMarks}.` : 'Attempt one timed mini-test.',
        weakTopics[1] ? `Close the day by revising ${weakTopics[1]}.` : 'Close the day with one weak-topic revision block.',
      ],
    },
    {
      title: 'Retention loop',
      summary: prioritySaved.length > 0 ? 'Bring saved lessons back before they become passive bookmarks.' : 'Turn active study into retained memory through repetition.',
      actions: [
        ...prioritySaved.slice(0, 2).map((topic) => `Revisit ${topic.lessonTitle} from ${topic.courseTitle}.`),
        'Test yourself without notes for 10 minutes.',
        'Update your saved list so only high-value revision items remain.',
      ],
    },
    {
      title: 'Mock readiness',
      summary: strongTopics.length > 0 ? `Lean on ${strongTopics.join(' and ')} while stabilizing weaker chapters.` : 'Use one medium-length mock block to judge readiness.',
      actions: [
        'Attempt one sectional or full mock under strict timing.',
        'Review only skipped and incorrect questions immediately after submission.',
        'Mark 3 topics that need another round this week.',
      ],
    },
  ];

  return templates.map((template, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);

    return {
      dateLabel: formatShortDate(date),
      title: template.title,
      summary: template.summary,
      actions: template.actions.slice(0, 3),
    };
  });
};

const RevisionTab = ({
  overview,
  savedTopics,
  onContinueLearning,
}: {
  overview: PlatformOverview;
  savedTopics: SavedTopic[];
  onContinueLearning: (courseId: string, lessonId?: string | null) => void;
}) => {
  const revisionPlan = useMemo(() => buildRevisionPlan(overview, savedTopics), [overview, savedTopics]);
  const latestMock = overview.dashboard.latestMockTest;
  const recoveryItems = latestMock?.solutions.filter((solution) => !isSolutionCorrect(solution)).slice(0, 6) || [];
  const completedSavedTopics = savedTopics.filter((topic) => topic.completed).length;

  return (
    <div className="space-y-6">
      <section className="grid gap-6 xl:grid-cols-[1.08fr_0.92fr]">
        <div className="rounded-[34px] bg-[linear-gradient(135deg,#101827,#12213b_44%,#1d3557_100%)] p-6 text-white shadow-[0_30px_120px_rgba(15,23,42,0.28)] sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/52">Revision center</p>
          <h2 className="mt-4 text-3xl font-semibold leading-tight sm:text-4xl">Turn saved lessons, weak topics, and mistakes into a daily recovery workflow.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-white/70 sm:text-base">
            This screen pulls together the real items that usually get lost after studying: unfinished lessons, bookmarked topics, and errors from your last mock.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <MetricCard title="Saved topics" value={`${savedTopics.length}`} hint="High-value lessons parked for revision" icon={BookOpen} />
            <MetricCard title="Recovered" value={`${completedSavedTopics}`} hint="Saved items already finished" icon={CheckCircle2} />
            <MetricCard title="Weak topics" value={`${overview.dashboard.weakTopics.length}`} hint="Topics currently needing active repair" icon={AlertTriangle} />
          </div>
        </div>

        <div className="rounded-[34px] border border-white/70 bg-white/92 p-6 shadow-[0_24px_90px_rgba(15,23,42,0.08)]">
          <SectionHeader title="Priority queue" caption="What deserves attention first" />
          <div className="mt-6 space-y-4">
            <div className="rounded-[24px] bg-[var(--accent-cream)] p-4">
              <p className="text-sm font-semibold text-[var(--ink)]">Next best action</p>
              <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">
                {latestMock
                  ? `Review skipped and incorrect questions from your last mock before attempting a new one. This prevents repeating the same errors.`
                  : `Use this tab to build a revision habit: reopen one saved lesson, solve one short test, and revisit one weak topic.`}
              </p>
            </div>
            <div className="rounded-[24px] border border-[var(--line)] p-4">
              <p className="text-sm font-semibold text-[var(--ink)]">Live repair topics</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(overview.dashboard.weakTopics.length > 0 ? overview.dashboard.weakTopics : ['Take one fresh mock to identify weak topics']).map((topic) => (
                  <span key={topic} className="rounded-full bg-[var(--accent-cream)] px-3 py-2 text-sm text-[var(--danger)]">
                    {topic}
                  </span>
                ))}
              </div>
            </div>
            {overview.dashboard.continueLearning[0] && (
              <button
                onClick={() => onContinueLearning(overview.dashboard.continueLearning[0]._id, overview.dashboard.continueLearning[0].continueLesson?.id || null)}
                className="w-full rounded-[24px] border border-[var(--line)] bg-white p-4 text-left transition hover:border-[var(--accent-rust)]"
              >
                <p className="text-sm font-semibold text-[var(--ink)]">Resume active course</p>
                <p className="mt-2 text-sm text-[var(--ink-soft)]">
                  {overview.dashboard.continueLearning[0].continueLesson?.title || overview.dashboard.continueLearning[0].title}
                </p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-rust)]">Open lesson</p>
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
        <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
          <SectionHeader title="Seven-day revision loop" caption="Practical plan" />
          <div className="mt-6 space-y-4">
            {revisionPlan.map((day) => (
              <div key={`${day.dateLabel}-${day.title}`} className="rounded-[24px] border border-[var(--line)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{day.dateLabel}</p>
                    <h3 className="mt-2 text-lg font-semibold text-[var(--ink)]">{day.title}</h3>
                  </div>
                  <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent-rust)]">
                    3 actions
                  </span>
                </div>
                <p className="mt-3 text-sm leading-7 text-[var(--ink-soft)]">{day.summary}</p>
                <div className="mt-4 grid gap-2">
                  {day.actions.map((action) => (
                    <div key={action} className="rounded-2xl bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink)]">
                      {action}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div data-testid="admin-recovery-section" className="space-y-6">
          <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
            <SectionHeader title="Mistake recovery" caption="Latest mock mistakes" />
            <div className="mt-6 space-y-3">
              {recoveryItems.length > 0 ? recoveryItems.map((item, index) => (
                <div key={`${item.questionId}-${index}`} className="rounded-[22px] bg-[var(--accent-cream)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-[var(--ink)]">{item.topic}</p>
                    <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--danger)]">
                      {getSolutionSelectedOptionIndexes(item).length === 0 ? 'Skipped' : 'Incorrect'}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">{item.questionText}</p>
                  <p className="mt-3 text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                    Correct option: {formatOptionIndexLabels(getSolutionCorrectOptionIndexes(item))}
                  </p>
                </div>
              )) : (
                <div className="rounded-[22px] border border-dashed border-[var(--line)] p-6 text-sm text-[var(--ink-soft)]">
                  Your latest mock recovery queue will appear here after you attempt a test.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
            <SectionHeader title="Saved topics" caption="Reopen in one tap" />
            <div className="mt-6 space-y-3">
              {savedTopics.length > 0 ? savedTopics.map((topic) => (
                <button
                  key={`${topic.courseId}:${topic.lessonId}`}
                  onClick={() => onContinueLearning(topic.courseId, topic.lessonId)}
                  className="w-full rounded-[22px] border border-[var(--line)] bg-white p-4 text-left transition hover:border-[var(--accent-rust)]"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">{topic.exam}</p>
                      <h3 className="mt-2 text-base font-semibold text-[var(--ink)]">{topic.lessonTitle}</h3>
                      <p className="mt-1 text-sm text-[var(--ink-soft)]">{topic.courseTitle}</p>
                    </div>
                    <span className={cn(
                      'rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em]',
                      topic.completed ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--accent-cream)] text-[var(--accent-rust)]',
                    )}>
                      {topic.completed ? 'Completed' : 'Pending'}
                    </span>
                  </div>
                </button>
              )) : (
                <div className="rounded-[22px] border border-dashed border-[var(--line)] p-6 text-sm text-[var(--ink-soft)]">
                  Save lessons from the course player and they will build your revision shelf automatically.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

type ExamStage = 'instructions' | 'declaration' | 'exam';
type ExamWorkspaceTab = 'question' | 'symbols' | 'calculator' | 'instructions' | 'summary';
type ExamQuestionState = 'unvisited' | 'unanswered' | 'answered' | 'review' | 'answered-review';
type ExamFamily = 'ssc' | 'rrb' | 'banking' | 'default';
type ExamSection = {
  name: string;
  questionCount: number;
  startIndex: number;
  endIndex: number;
};

const examWorkspaceTabs: { id: Exclude<ExamWorkspaceTab, 'question'>; label: string }[] = [
  { id: 'symbols', label: 'Symbols' },
  { id: 'calculator', label: 'Calculator' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'summary', label: 'Overall Test Summary' },
];

const questionStateLegend: { state: ExamQuestionState; label: string; description: string }[] = [
  { state: 'unvisited', label: 'Not Visited', description: 'You have not visited the question yet.' },
  { state: 'unanswered', label: 'Not Answered', description: 'You have not answered the question.' },
  { state: 'answered', label: 'Answered', description: 'You have answered the question.' },
  { state: 'review', label: 'Marked For Review', description: 'You have NOT answered the question, but have marked the question for review.' },
  { state: 'answered-review', label: 'Answered & Review', description: 'You have answered the question, but marked it for review.' },
];

const distributeSectionCounts = (totalQuestions: number, weights: number[]) => {
  if (totalQuestions <= 0 || weights.length === 0) {
    return [];
  }

  const safeWeights = weights.map((weight) => Math.max(weight, 1));
  const counts = new Array(safeWeights.length).fill(0);
  let remaining = totalQuestions;

  for (let index = 0; index < safeWeights.length && remaining > 0; index += 1) {
    counts[index] = 1;
    remaining -= 1;
  }

  if (remaining <= 0) {
    return counts;
  }

  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  const rawAllocations = safeWeights.map((weight) => (weight / totalWeight) * remaining);
  const floorAllocations = rawAllocations.map((value) => Math.floor(value));
  const remainders = rawAllocations.map((value, index) => ({
    index,
    remainder: value - floorAllocations[index],
  })).sort((left, right) => right.remainder - left.remainder);

  floorAllocations.forEach((value, index) => {
    counts[index] += value;
  });

  let stillRemaining = remaining - floorAllocations.reduce((sum, value) => sum + value, 0);

  for (let index = 0; index < remainders.length && stillRemaining > 0; index += 1) {
    counts[remainders[index].index] += 1;
    stillRemaining -= 1;
  }

  return counts;
};

const buildExamSections = (test: MockTest): ExamSection[] => {
  if (test.questions.length === 0) {
    return [];
  }

  const examSource = `${test.category} ${test.title} ${test.type}`.toLowerCase();
  const shouldForceJeThreePartLayout = examSource.includes('ssc je');

  const declaredSections = shouldForceJeThreePartLayout
    ? [
      { name: 'General Intelligence and Reasoning', questions: 1 },
      { name: 'General Awareness', questions: 1 },
      { name: 'General Engineering', questions: 2 },
    ]
    : test.sectionBreakup.length > 0
      ? test.sectionBreakup
      : [{ name: 'Section 1', questions: test.questions.length }];

  const declaredTotal = declaredSections.reduce((sum, section) => sum + Math.max(section.questions, 0), 0);

  const counts = declaredTotal === test.questions.length
    ? declaredSections.map((section) => Math.max(section.questions, 0))
    : distributeSectionCounts(
      test.questions.length,
      declaredSections.map((section) => Math.max(section.questions, 1)),
    );

  let cursor = 0;
  return declaredSections
    .map((section, index) => {
      const questionCount = counts[index] || 0;
      if (questionCount <= 0) {
        return null;
      }

      const startIndex = cursor;
      const endIndex = Math.min(cursor + questionCount - 1, test.questions.length - 1);
      cursor = endIndex + 1;

      return {
        name: section.name,
        questionCount: endIndex - startIndex + 1,
        startIndex,
        endIndex,
      };
    })
    .filter((section): section is ExamSection => Boolean(section));
};

const getExamFamily = (test: MockTest): ExamFamily => {
  const source = `${test.category} ${test.title} ${test.type}`.toLowerCase();

  if (source.includes('bank') || source.includes('ibps') || source.includes('sbi') || source.includes('clerk') || source.includes('po')) {
    return 'banking';
  }

  if (source.includes('rrb') || source.includes('railway')) {
    return 'rrb';
  }

  if (source.includes('ssc')) {
    return 'ssc';
  }

  return 'default';
};

const buildMockRollNumber = (userId: string | undefined, testId: string) => {
  const source = `${userId || 'candidate'}${testId}`;
  const digits = source
    .split('')
    .map((character) => String(character.charCodeAt(0) % 10))
    .join('');

  return digits.slice(0, 12).padEnd(12, '0');
};

const getExamFamilyLabel = (family: ExamFamily) => {
  if (family === 'ssc') {
    return 'SSC CBT Interface';
  }

  if (family === 'rrb') {
    return 'RRB CBT Interface';
  }

  if (family === 'banking') {
    return 'Banking CBT Interface';
  }

  return 'CBT Exam Interface';
};

const getExamFamilySupportCopy = (family: ExamFamily) => {
  if (family === 'ssc') {
    return 'Built to feel like a full SSC exam simulation with instructions, declaration, and a real question palette.';
  }

  if (family === 'rrb') {
    return 'Structured like a railway CBT experience so topic tests and full mocks feel operational, not generic.';
  }

  if (family === 'banking') {
    return 'Prepared for banking-style mocks with declaration, language selection, and a high-focus solving layout.';
  }

  return 'Prepared as a clean CBT workflow so learners move from instructions to declaration to the actual test environment.';
};

const getExamInstructionChecklist = (test: MockTest) => [
  `The exam timer starts only after you click "I am ready to begin" and runs continuously until submission or timeout.`,
  `This mock contains ${test.questions.length} questions for a maximum of ${test.totalMarks} marks in ${test.durationMinutes} minutes.`,
  `Use Save & Next to store your answer and move ahead. Use Mark for Review when you want to revisit a question before final submission.`,
  `You may move between questions through the palette at the right side. Status colors always update live while you attempt the paper.`,
  `Negative marking is ${test.negativeMarking} for every incorrect answer. Unattempted questions are not penalized.`,
  'The final scorecard and explanations will appear immediately after you submit the paper.',
];

const getDeclarationChecklist = (test: MockTest) => [
  `The test contains ${test.questions.length} total questions.`,
  `Each question carries its configured marks and uses the same negative marking settings as the real mock.`,
  `You are expected to complete the exam in ${test.durationMinutes} minutes without refreshing or closing the window.`,
  'Changing questions from the palette does not auto-save the current response unless you use Save & Next.',
  'Marked for review questions stay highlighted so you can revisit them before the timer ends.',
  'This exam can be submitted any time before the timer reaches zero.',
];

const getExamQuestionState = (
  questionId: string,
  answers: Record<string, number | number[]>,
  visitedQuestions: Record<string, boolean>,
  reviewQuestions: Record<string, boolean>,
): ExamQuestionState => {
  const isAnswered = answers[questionId] !== undefined;
  const isVisited = Boolean(visitedQuestions[questionId]);
  const isReview = Boolean(reviewQuestions[questionId]);

  if (isReview && isAnswered) {
    return 'answered-review';
  }

  if (isReview) {
    return 'review';
  }

  if (isAnswered) {
    return 'answered';
  }

  if (isVisited) {
    return 'unanswered';
  }

  return 'unvisited';
};

const getQuestionStateButtonClasses = (state: ExamQuestionState, active: boolean) => cn(
  'relative flex h-10 w-full min-w-[42px] items-center justify-center border text-sm font-semibold transition',
  active && 'ring-2 ring-[#2598e8] ring-offset-2 ring-offset-white',
  state === 'unvisited' && 'rounded-md border-slate-500 bg-white text-slate-700',
  state === 'unanswered' && 'rounded-[12px] border-[#c64a2f] bg-[#c64a2f] text-white',
  state === 'answered' && 'rounded-[12px] border-[#2dad5c] bg-[#2dad5c] text-white',
  state === 'review' && 'rounded-[999px] border-[#8c53d8] bg-[#8c53d8] text-white',
  state === 'answered-review' && 'rounded-[999px] border-[#8c53d8] bg-[#8c53d8] text-white',
);

const TestPlayer = ({
  test,
  onClose,
  onSubmitted,
}: {
  test: MockTest;
  onClose: () => void;
  onSubmitted: (result: TestAttemptResult) => void;
}) => {
  const { user } = useAuth();
  const stageContentRef = useRef<HTMLElement | null>(null);
  const examMainRef = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState<ExamStage>('instructions');
  const [workspaceTab, setWorkspaceTab] = useState<ExamWorkspaceTab>('question');
  const [answers, setAnswers] = useState<Record<string, number | number[]>>({});
  const [visitedQuestions, setVisitedQuestions] = useState<Record<string, boolean>>({});
  const [reviewQuestions, setReviewQuestions] = useState<Record<string, boolean>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(test.durationMinutes * 60);
  const [submitting, setSubmitting] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [selectedLanguage, setSelectedLanguage] = useState('English');
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  const [questionZoom, setQuestionZoom] = useState(1);
  const [calculatorExpression, setCalculatorExpression] = useState('');
  const [calculatorResult, setCalculatorResult] = useState('0');

  const examFamily = useMemo(() => getExamFamily(test), [test]);
  const examSections = useMemo(() => buildExamSections(test), [test]);
  const rollNumber = useMemo(() => buildMockRollNumber(user?._id, test._id), [test._id, user?._id]);
  const instructionChecklist = useMemo(() => getExamInstructionChecklist(test), [test]);
  const declarationChecklist = useMemo(() => getDeclarationChecklist(test), [test]);
  const currentQuestion = test.questions[currentIndex];
  const currentQuestionCorrectOptionIndexes = currentQuestion ? getQuestionCorrectOptionIndexes(currentQuestion) : [];
  const currentQuestionAllowsMultipleAnswers = currentQuestionCorrectOptionIndexes.length > 1;
  const questionTextClass = ['text-lg leading-8', 'text-xl leading-9', 'text-2xl leading-10'][questionZoom];

  const currentSection = useMemo(() => (
    examSections.find((section) => currentIndex >= section.startIndex && currentIndex <= section.endIndex)
    || examSections[0]
    || null
  ), [currentIndex, examSections]);

  const currentSectionIndex = currentSection ? examSections.findIndex((section) => section.name === currentSection.name) : 0;
  const currentSectionLabel = `PART-${String.fromCharCode(65 + Math.max(currentSectionIndex, 0))}`;
  const currentQuestionNumberInSection = currentSection ? (currentIndex - currentSection.startIndex + 1) : (currentIndex + 1);

  const questionStates = useMemo(() => test.questions.reduce<Record<string, ExamQuestionState>>((stateMap, question) => {
    stateMap[question.id] = getExamQuestionState(question.id, answers, visitedQuestions, reviewQuestions);
    return stateMap;
  }, {}), [answers, reviewQuestions, test.questions, visitedQuestions]);

  const statusCounts = useMemo(() => test.questions.reduce((counts, question) => {
    const state = questionStates[question.id];
    if (state === 'answered') {
      counts.answered += 1;
    } else if (state === 'answered-review') {
      counts.answeredReview += 1;
    } else if (state === 'review') {
      counts.review += 1;
    } else if (state === 'unanswered') {
      counts.unanswered += 1;
    } else {
      counts.unvisited += 1;
    }

    return counts;
  }, {
    answered: 0,
    answeredReview: 0,
    review: 0,
    unanswered: 0,
    unvisited: 0,
  }), [questionStates, test.questions]);

  const answeredCount = statusCounts.answered + statusCounts.answeredReview;
  const attentionCount = statusCounts.unanswered + statusCounts.review + statusCounts.unvisited;

  useEffect(() => {
    if (stage !== 'exam' || !currentQuestion) {
      return;
    }

    setVisitedQuestions((current) => (
      current[currentQuestion.id]
        ? current
        : { ...current, [currentQuestion.id]: true }
    ));
  }, [currentQuestion, stage]);

  useEffect(() => {
    if (stage !== 'exam' || submitting) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setTimeLeft((current) => (current > 0 ? current - 1 : 0));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [stage, submitting]);

  useEffect(() => {
    if (stage === 'exam' && timeLeft === 0 && !submitting) {
      void submitTest(true);
    }
  }, [stage, submitting, timeLeft]);

  useEffect(() => {
    stageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    examMainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [stage, workspaceTab, currentIndex]);

  const handleExit = () => {
    if (stage === 'exam' && startedAt && !submitting) {
      const confirmed = window.confirm('Exit this exam interface now? Your current mock progress will not be submitted.');
      if (!confirmed) {
        return;
      }
    }

    onClose();
  };

  const goToQuestion = (questionIndex: number) => {
    setCurrentIndex(Math.min(Math.max(questionIndex, 0), Math.max(test.questions.length - 1, 0)));
    setWorkspaceTab('question');
  };

  const saveCurrentResponse = () => {
    if (!currentQuestion) {
      return;
    }

    setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
  };

  const moveToNextQuestion = () => {
    if (currentIndex < test.questions.length - 1) {
      goToQuestion(currentIndex + 1);
    }
  };

  const submitTest = async (forced = false) => {
    if (!user || submitting) {
      return;
    }

    if (!forced) {
      const confirmed = window.confirm('Submit this mock test now? You will move to the scorecard immediately after submission.');
      if (!confirmed) {
        return;
      }
    }

    setSubmitting(true);
    try {
      const effectiveStartedAt = startedAt || new Date().toISOString();
      const result = await EduService.submitMockTest(test._id, answers, effectiveStartedAt);
      onSubmitted(result);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndNext = () => {
    saveCurrentResponse();

    if (currentIndex === test.questions.length - 1) {
      return;
    }

    moveToNextQuestion();
  };

  const handleToggleReview = () => {
    if (!currentQuestion) {
      return;
    }

    const isMarked = Boolean(reviewQuestions[currentQuestion.id]);
    setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
    setReviewQuestions((current) => {
      const nextState = { ...current };
      if (isMarked) {
        delete nextState[currentQuestion.id];
      } else {
        nextState[currentQuestion.id] = true;
      }
      return nextState;
    });

    if (!isMarked && currentIndex < test.questions.length - 1) {
      moveToNextQuestion();
    }
  };

  const handleClearResponse = () => {
    if (!currentQuestion) {
      return;
    }

    setAnswers((current) => {
      const nextAnswers = { ...current };
      delete nextAnswers[currentQuestion.id];
      return nextAnswers;
    });
    setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
  };

  const appendCalculatorValue = (value: string) => {
    setCalculatorExpression((current) => `${current}${value}`);
  };

  const evaluateCalculator = () => {
    const normalizedExpression = calculatorExpression
      .replace(/x/g, '*')
      .replace(/X/g, '*')
      .replace(/÷/g, '/');

    if (!normalizedExpression.trim()) {
      setCalculatorResult('0');
      return;
    }

    if (!/^[0-9+\-*/().\s]+$/.test(normalizedExpression)) {
      setCalculatorResult('Invalid');
      return;
    }

    try {
      const value = Function(`"use strict"; return (${normalizedExpression});`)();
      setCalculatorResult(Number.isFinite(value) ? String(value) : 'Invalid');
    } catch {
      setCalculatorResult('Invalid');
    }
  };

  const candidatePanel = (
    <aside className="border-l border-slate-200 bg-[#f5f8fc] p-6">
      <div className="rounded-[30px] bg-white p-6 text-center shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
        <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-full bg-sky-100 text-sky-600">
          <UserCircle2 className="h-16 w-16" />
        </div>
        <p className="mt-5 text-4xl font-semibold text-slate-900">{user?.name || 'Candidate'}</p>
        <p className="mt-2 text-sm font-medium uppercase tracking-[0.18em] text-slate-500">{test.category}</p>
        <div className="mt-6 grid gap-3 text-left">
          <div className="rounded-2xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Roll Number</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{rollNumber}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Duration</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{test.durationMinutes} mins</p>
          </div>
          <div className="rounded-2xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Sections</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{examSections.length || 1}</p>
          </div>
        </div>
      </div>
      <div className="mt-5 rounded-[28px] bg-white p-5 shadow-[0_24px_60px_rgba(15,23,42,0.06)]">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Interface style</p>
        <p className="mt-3 text-lg font-semibold text-slate-900">{getExamFamilyLabel(examFamily)}</p>
        <p className="mt-3 text-sm leading-7 text-slate-600">{getExamFamilySupportCopy(examFamily)}</p>
      </div>
    </aside>
  );

  const renderQuestionView = () => {
    if (!currentQuestion) {
      return (
        <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-slate-600">
          No questions are available in this mock test yet.
        </div>
      );
    }

    const currentQuestionState = questionStates[currentQuestion.id];

    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-lg bg-green-600 px-4 py-2 text-lg font-semibold text-white">{currentSectionLabel}</span>
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">{currentSection?.name || 'Section'}</p>
            <p className="mt-1 text-sm text-slate-600">
              Question {currentIndex + 1} of {test.questions.length}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleToggleReview}
            className="rounded-lg bg-[#2f69d9] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#275bbf]"
          >
            {currentQuestionState === 'review' || currentQuestionState === 'answered-review' ? 'Unmark Review' : 'Mark for Review'}
          </button>
          <button
            onClick={handleSaveAndNext}
            className="rounded-lg bg-[#2f69d9] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#275bbf]"
          >
            {currentIndex === test.questions.length - 1 ? 'Save Response' : 'Save & Next'}
          </button>
          <button
            onClick={() => void submitTest()}
            disabled={submitting}
            className="rounded-lg bg-[#2f69d9] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#275bbf] disabled:opacity-60"
          >
            {submitting ? 'Submitting...' : 'Submit Test'}
          </button>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white shadow-[0_18px_42px_rgba(15,23,42,0.06)]">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-3xl font-semibold text-slate-900">Question No. {currentIndex + 1}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span className="rounded-full bg-slate-100 px-3 py-2">{currentQuestion.topic}</span>
                <span className="rounded-full bg-slate-100 px-3 py-2">+{currentQuestion.marks} marks</span>
                <span className="rounded-full bg-slate-100 px-3 py-2">-{test.negativeMarking} negative</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-600">
                <span className="font-semibold">Select Language</span>
                <select
                  value={selectedLanguage}
                  onChange={(event) => setSelectedLanguage(event.target.value)}
                  className="bg-transparent outline-none"
                >
                  <option value="English">English</option>
                  <option value="Hindi">Hindi</option>
                </select>
              </div>
              <button className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600">
                Report
              </button>
            </div>
          </div>

          <div className="px-6 py-6">
            <div className="rounded-[28px] border border-slate-200">
              <div className="border-b border-slate-200 px-6 py-6">
                <p className={cn('font-medium text-slate-900', questionTextClass)}>{currentQuestion.questionText}</p>
              </div>

              <div className="divide-y divide-slate-200">
                {currentQuestion.options.map((option, optionIndex) => {
                  const selectedOptionIndexes = normalizeOptionIndexes(answers[currentQuestion.id]);
                  const isSelected = selectedOptionIndexes.includes(optionIndex);

                  return (
                    <button
                      key={`${currentQuestion.id}-${option}`}
                      onClick={() => {
                        setAnswers((current) => {
                          const nextValue = toggleSelectedOptionValue(current[currentQuestion.id], optionIndex, currentQuestionAllowsMultipleAnswers);
                          const nextAnswers = { ...current };
                          if (Array.isArray(nextValue) && nextValue.length === 0) {
                            delete nextAnswers[currentQuestion.id];
                          } else {
                            nextAnswers[currentQuestion.id] = nextValue;
                          }
                          return nextAnswers;
                        });
                        setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
                        setWorkspaceTab('question');
                      }}
                      className={cn(
                        'grid w-full grid-cols-[84px_minmax(0,1fr)] items-center text-left transition',
                        isSelected ? 'bg-sky-50' : 'bg-white hover:bg-slate-50',
                      )}
                    >
                      <div className="flex h-full items-center justify-center border-r border-slate-200 py-6">
                        <div className={cn(
                          currentQuestionAllowsMultipleAnswers
                            ? 'flex h-11 w-11 items-center justify-center rounded-[12px] border text-lg font-semibold'
                            : 'flex h-11 w-11 items-center justify-center rounded-full border text-lg font-semibold',
                          isSelected
                            ? 'border-sky-500 bg-sky-500 text-white'
                            : 'border-slate-300 bg-white text-slate-600',
                        )}>
                          {String.fromCharCode(65 + optionIndex)}
                        </div>
                      </div>
                      <div className="px-6 py-6 text-lg leading-8 text-slate-800">{option}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={() => goToQuestion(currentIndex - 1)}
            disabled={currentIndex === 0}
            className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            Previous
          </button>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleClearResponse}
              className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700"
            >
              Clear Response
            </button>
            <button
              onClick={handleSaveAndNext}
              className="rounded-lg bg-[#2f69d9] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#275bbf]"
            >
              {currentIndex === test.questions.length - 1 ? 'Save Response' : 'Save & Next'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSymbolsView = () => (
    <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Status legend</p>
          <h3 className="mt-2 text-3xl font-semibold text-slate-900">Question palette symbols</h3>
        </div>
        <button
          onClick={() => setWorkspaceTab('question')}
          className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
        >
          Return to question
        </button>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {questionStateLegend.map((item) => (
          <div key={item.state} className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-center gap-4">
              <div className={getQuestionStateButtonClasses(item.state, false)}>1</div>
              <div>
                <p className="text-lg font-semibold text-slate-900">{item.label}</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">{item.description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-[24px] bg-[#f6fbff] p-5">
        <p className="text-sm font-semibold text-slate-900">How to use the controls</p>
        <div className="mt-3 space-y-3 text-sm leading-7 text-slate-600">
          <p>Save & Next stores the current answer and moves you forward in the paper.</p>
          <p>Mark for Review flags the question so it stands out in the palette and summary before final submission.</p>
          <p>Total answered, unvisited, and review counts update in real time on the right panel.</p>
        </div>
      </div>
    </div>
  );

  const renderInstructionsView = () => (
    <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Exam guide</p>
          <h3 className="mt-2 text-3xl font-semibold text-slate-900">Instructions</h3>
        </div>
        <button
          onClick={() => setWorkspaceTab('question')}
          className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
        >
          Return to question
        </button>
      </div>

      <ol className="mt-6 space-y-4 pl-6 text-base leading-8 text-slate-700">
        {instructionChecklist.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>

      <div className="mt-6 rounded-[24px] bg-[#f9fbff] p-5">
        <p className="text-sm font-semibold text-slate-900">Sections in this paper</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {examSections.map((section) => (
            <span key={section.name} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700">
              {section.name} • {section.questionCount} questions
            </span>
          ))}
        </div>
      </div>
    </div>
  );

  const renderSummaryView = () => {
    const pendingQuestions = test.questions
      .map((question, index) => ({
        question,
        index,
        state: questionStates[question.id],
      }))
      .filter((item) => item.state !== 'answered' && item.state !== 'answered-review');

    return (
      <div className="space-y-6">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Review snapshot</p>
              <h3 className="mt-2 text-3xl font-semibold text-slate-900">Overall test summary</h3>
            </div>
            <button
              onClick={() => setWorkspaceTab('question')}
              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
            >
              Return to question
            </button>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-5">
            <div className="rounded-[24px] bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Answered</p>
              <p className="mt-2 text-3xl font-semibold text-emerald-600">{answeredCount}</p>
            </div>
            <div className="rounded-[24px] bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Not Answered</p>
              <p className="mt-2 text-3xl font-semibold text-orange-500">{statusCounts.unanswered}</p>
            </div>
            <div className="rounded-[24px] bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Review</p>
              <p className="mt-2 text-3xl font-semibold text-violet-600">{statusCounts.review + statusCounts.answeredReview}</p>
            </div>
            <div className="rounded-[24px] bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Unvisited</p>
              <p className="mt-2 text-3xl font-semibold text-slate-700">{statusCounts.unvisited}</p>
            </div>
            <div className="rounded-[24px] bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Attention</p>
              <p className="mt-2 text-3xl font-semibold text-rose-500">{attentionCount}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
            <p className="text-lg font-semibold text-slate-900">Section wise coverage</p>
            <div className="mt-5 space-y-4">
              {examSections.map((section, sectionIndex) => {
                const sectionQuestions = test.questions.slice(section.startIndex, section.endIndex + 1);
                const sectionAnswered = sectionQuestions.filter((question) => {
                  const state = questionStates[question.id];
                  return state === 'answered' || state === 'answered-review';
                }).length;

                return (
                  <div key={section.name} className="rounded-[24px] border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                          PART-{String.fromCharCode(65 + sectionIndex)}
                        </p>
                        <p className="mt-1 text-xl font-semibold text-slate-900">{section.name}</p>
                        <p className="mt-2 text-sm text-slate-600">{sectionAnswered}/{section.questionCount} answered</p>
                      </div>
                      <button
                        onClick={() => goToQuestion(section.startIndex)}
                        className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
                      >
                        Open section
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
            <p className="text-lg font-semibold text-slate-900">Questions needing attention</p>
            <div className="mt-5 space-y-3">
              {pendingQuestions.length > 0 ? pendingQuestions.map((item) => (
                <button
                  key={item.question.id}
                  onClick={() => goToQuestion(item.index)}
                  className="flex w-full items-center justify-between rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-4 text-left transition hover:border-sky-400 hover:bg-sky-50"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-900">Question {item.index + 1}</p>
                    <p className="mt-1 text-sm text-slate-600">{questionStateLegend.find((legend) => legend.state === item.state)?.label}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-slate-400" />
                </button>
              )) : (
                <div className="rounded-[20px] bg-emerald-50 px-4 py-5 text-sm font-medium text-emerald-700">
                  Every question has been attempted or saved for review. You are ready for final submission.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderCalculatorView = () => (
    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
      <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Exam utility</p>
            <h3 className="mt-2 text-3xl font-semibold text-slate-900">Calculator</h3>
          </div>
          <button
            onClick={() => setWorkspaceTab('question')}
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
          >
            Return to question
          </button>
        </div>

        <div className="mt-6 rounded-[26px] bg-slate-900 p-6 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60">Expression</p>
          <p className="mt-3 min-h-[56px] break-words text-2xl font-semibold">{calculatorExpression || '0'}</p>
          <div className="mt-5 border-t border-white/10 pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60">Result</p>
            <p className="mt-3 text-3xl font-semibold text-sky-300">{calculatorResult}</p>
          </div>
        </div>

        <p className="mt-5 text-sm leading-7 text-slate-600">
          This quick calculator stays inside the exam screen so learners do not need to leave the paper for rough arithmetic.
        </p>
      </div>

      <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_18px_42px_rgba(15,23,42,0.05)]">
        <div className="grid grid-cols-4 gap-3">
          {['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '(', ')'].map((item) => (
            <button
              key={item}
              onClick={() => appendCalculatorValue(item)}
              className="rounded-2xl bg-slate-100 px-4 py-4 text-lg font-semibold text-slate-900 transition hover:bg-slate-200"
            >
              {item}
            </button>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <button
            onClick={() => {
              setCalculatorExpression('');
              setCalculatorResult('0');
            }}
            className="rounded-2xl bg-rose-100 px-4 py-4 text-lg font-semibold text-rose-700 transition hover:bg-rose-200"
          >
            C
          </button>
          <button
            onClick={() => setCalculatorExpression((current) => current.slice(0, -1))}
            className="rounded-2xl bg-amber-100 px-4 py-4 text-lg font-semibold text-amber-700 transition hover:bg-amber-200"
          >
            DEL
          </button>
          <button
            onClick={() => appendCalculatorValue('+')}
            className="rounded-2xl bg-slate-100 px-4 py-4 text-lg font-semibold text-slate-900 transition hover:bg-slate-200"
          >
            +
          </button>
        </div>
        <button
          onClick={evaluateCalculator}
          className="mt-4 flex w-full items-center justify-center rounded-2xl bg-[#2f69d9] px-5 py-4 text-lg font-semibold text-white transition hover:bg-[#275bbf]"
        >
          =
        </button>
      </div>
    </div>
  );

  const renderWorkspace = () => {
    if (workspaceTab === 'symbols') {
      return renderSymbolsView();
    }

    if (workspaceTab === 'calculator') {
      return renderCalculatorView();
    }

    if (workspaceTab === 'instructions') {
      return renderInstructionsView();
    }

    if (workspaceTab === 'summary') {
      return renderSummaryView();
    }

    return renderQuestionView();
  };

  const examScreen = (
    <div className="flex h-full flex-col bg-[#f3f7fb]">
      <div className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_auto] xl:items-center">
          <div>
            <BrandLogo tone="light" size="sm" />
            <p className="mt-2 text-lg font-semibold text-slate-900">{test.title}</p>
          </div>
          <div className="text-center">
            <h3 className="text-[38px] font-semibold text-slate-900">{test.title}</h3>
            <p className="mt-2 text-xl font-semibold text-slate-700">Roll No : {rollNumber}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              onClick={() => setQuestionZoom((current) => Math.min(current + 1, 2))}
              className="rounded-xl bg-[#2f69d9] px-4 py-3 text-sm font-semibold text-white"
            >
              Zoom (+)
            </button>
            <button
              onClick={() => setQuestionZoom((current) => Math.max(current - 1, 0))}
              className="rounded-xl bg-[#2f69d9] px-4 py-3 text-sm font-semibold text-white"
            >
              Zoom (-)
            </button>
            <div className="rounded-[20px] bg-[#fff8bf] px-5 py-3 text-right">
              <p className="text-sm font-semibold text-slate-700">Time Left</p>
              <p className="text-4xl font-semibold text-red-600">{formatTimeLeft(timeLeft).replace(':', ' : ')}</p>
            </div>
            <button
              onClick={handleExit}
              className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700"
            >
              Exit Test
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex flex-wrap items-center gap-6">
          {examWorkspaceTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setWorkspaceTab(tab.id)}
              className={cn(
                'text-xl font-semibold underline-offset-4 transition',
                workspaceTab === tab.id ? 'text-[#c34b32] underline' : 'text-[#1f7ecb] hover:text-[#185d97]',
              )}
            >
              {tab.label.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="rounded-full bg-[#fff7ce] px-4 py-3 text-lg font-semibold text-slate-800">
          Total Questions Answered: <span className="text-[#ff2400]">{answeredCount}</span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <main className="overflow-y-auto px-6 py-6">
          {renderWorkspace()}
        </main>

        <aside className="border-l border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-5 py-5">
            <div className="flex flex-col items-center rounded-[28px] bg-[#f5f8fc] px-4 py-6 text-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-sky-100 text-sky-600">
                <UserCircle2 className="h-14 w-14" />
              </div>
              <p className="mt-4 text-4xl font-semibold text-slate-900">{user?.name || 'Candidate'}</p>
              <p className="mt-2 text-sm font-medium uppercase tracking-[0.18em] text-slate-500">{test.category}</p>
            </div>
          </div>

          <div className="h-[calc(100vh-212px)] overflow-y-auto px-5 py-5">
            <div className="rounded-[28px] border border-slate-200 bg-white p-4">
              <p className="text-3xl font-semibold text-slate-900">Question palette</p>
              <div className="mt-5 space-y-5">
                {examSections.map((section) => (
                  <div key={section.name}>
                    <div className="flex items-center gap-3">
                      <div className="h-0 w-0 border-y-[12px] border-y-transparent border-l-[18px] border-l-sky-500" />
                      <p className="text-lg font-semibold text-slate-900">{section.name}</p>
                    </div>
                    <div className="mt-4 grid grid-cols-4 gap-3">
                      {test.questions.slice(section.startIndex, section.endIndex + 1).map((question, sectionQuestionIndex) => {
                        const questionIndex = section.startIndex + sectionQuestionIndex;
                        const questionState = questionStates[question.id];

                        return (
                          <button
                            key={question.id}
                            onClick={() => goToQuestion(questionIndex)}
                            className={getQuestionStateButtonClasses(questionState, currentIndex === questionIndex)}
                          >
                            {questionIndex + 1}
                            {questionState === 'answered-review' && (
                              <CheckCircle2 className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-white text-emerald-500" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5 rounded-[28px] border border-slate-300 bg-white">
              <div className="border-b border-slate-300 bg-slate-100 px-4 py-3 text-center text-2xl font-semibold text-slate-900">
                Analysis
              </div>
              <div className="divide-y divide-slate-200 text-lg">
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-slate-700">Answered</span>
                  <span className="font-semibold text-[#ffb300]">{answeredCount}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-slate-700">Not Answered</span>
                  <span className="font-semibold text-[#ffb300]">{statusCounts.unanswered}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-slate-700">Mark for Review</span>
                  <span className="font-semibold text-[#ffb300]">{statusCounts.review}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-slate-700">Answered & Review</span>
                  <span className="font-semibold text-[#ffb300]">{statusCounts.answeredReview}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-slate-700">Not Visited</span>
                  <span className="font-semibold text-[#ffb300]">{statusCounts.unvisited}</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => void submitTest()}
              disabled={submitting}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-[20px] bg-[#2f69d9] px-5 py-4 text-lg font-semibold text-white transition hover:bg-[#275bbf] disabled:opacity-60"
            >
              {submitting ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <ClipboardCheck className="h-5 w-5" />}
              Submit Test
            </button>
          </div>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/70 px-3 py-3 backdrop-blur sm:px-5 sm:py-5">
      <div className="mx-auto flex h-full max-w-[1840px] flex-col overflow-hidden rounded-[32px] border border-white/20 bg-white shadow-[0_30px_120px_rgba(2,8,23,0.32)]">
        {stage === 'instructions' && (
          <div className="flex h-full flex-col bg-[#f3f7fb]">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-100 text-sky-600">
                  <ClipboardCheck className="h-7 w-7" />
                </div>
                <div>
                  <BrandLogo tone="light" size="sm" />
                  <p className="mt-1 text-sm font-medium uppercase tracking-[0.2em] text-slate-500">{getExamFamilyLabel(examFamily)}</p>
                </div>
              </div>
              <button
                onClick={handleExit}
                data-testid="test-player-close"
                className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
              >
                Go to tests
              </button>
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section className="overflow-y-auto px-6 py-6">
                <div className="rounded-[32px] border border-slate-200 bg-white p-8 shadow-[0_24px_60px_rgba(15,23,42,0.06)]">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">General instructions</p>
                  <h2 className="mt-3 text-5xl font-semibold text-slate-900">{test.title}</h2>
                  <div className="mt-6 grid gap-4 md:grid-cols-3">
                    <div className="rounded-[24px] bg-slate-50 p-5">
                      <p className="text-sm text-slate-500">Duration</p>
                      <p className="mt-2 text-3xl font-semibold text-slate-900">{test.durationMinutes} mins</p>
                    </div>
                    <div className="rounded-[24px] bg-slate-50 p-5">
                      <p className="text-sm text-slate-500">Maximum marks</p>
                      <p className="mt-2 text-3xl font-semibold text-slate-900">{test.totalMarks}</p>
                    </div>
                    <div className="rounded-[24px] bg-slate-50 p-5">
                      <p className="text-sm text-slate-500">Negative marking</p>
                      <p className="mt-2 text-3xl font-semibold text-slate-900">{test.negativeMarking}</p>
                    </div>
                  </div>

                  <ol className="mt-8 space-y-4 pl-6 text-lg leading-8 text-slate-700">
                    {instructionChecklist.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ol>

                  <div className="mt-8 rounded-[28px] border border-slate-200 bg-[#f8fbff] p-6">
                    <p className="text-lg font-semibold text-slate-900">Question palette meanings</p>
                    <div className="mt-5 space-y-4">
                      {questionStateLegend.map((item) => (
                        <div key={item.state} className="flex items-center gap-4">
                          <div className={getQuestionStateButtonClasses(item.state, false)}>1</div>
                          <p className="text-base text-slate-700">{item.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {candidatePanel}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-white px-6 py-4">
              <button
                onClick={handleExit}
                className="rounded-xl border border-slate-300 px-5 py-3 text-lg font-semibold text-slate-700"
              >
                Go to Tests
              </button>
              <button
                onClick={() => setStage('declaration')}
                className="rounded-xl bg-[#2f69d9] px-6 py-3 text-lg font-semibold text-white transition hover:bg-[#275bbf]"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {stage === 'declaration' && (
          <div className="flex h-full flex-col bg-[#f3f7fb]">
            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <section className="overflow-y-auto bg-white px-6 py-8">
                <div className="mx-auto max-w-6xl">
                  <div className="text-center">
                    <h2 className="text-6xl font-semibold text-slate-900">{test.title}</h2>
                  </div>

                  <div className="mt-8 flex flex-wrap items-center justify-between gap-4 text-2xl font-semibold text-slate-700">
                    <p>Duration: {test.durationMinutes} Mins</p>
                    <p>Maximum Marks: {test.totalMarks}</p>
                  </div>

                  <div className="mt-8">
                    <p className="text-3xl font-semibold text-slate-900">Read the following instructions carefully.</p>
                    <ol className="mt-5 space-y-4 pl-8 text-xl leading-9 text-slate-700">
                      {declarationChecklist.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                  </div>

                  <div className="mt-10 rounded-[28px] border border-slate-200 p-6">
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="text-2xl font-semibold text-slate-900">Choose your default language</label>
                      <select
                        value={selectedLanguage}
                        onChange={(event) => setSelectedLanguage(event.target.value)}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-xl text-slate-900 outline-none"
                      >
                        <option value="English">English</option>
                        <option value="Hindi">Hindi</option>
                      </select>
                    </div>
                    <p className="mt-4 text-xl leading-8 text-rose-600">
                      Questions currently appear in the selected app language. This selection can be changed later while you are inside the paper.
                    </p>
                  </div>

                  <div className="mt-8 border-t border-slate-200 pt-6">
                    <p className="text-2xl font-semibold text-slate-900">Declaration</p>
                    <label className="mt-5 flex items-start gap-4 text-xl leading-9 text-slate-700">
                      <input
                        type="checkbox"
                        checked={declarationAccepted}
                        onChange={(event) => setDeclarationAccepted(event.target.checked)}
                        className="mt-2 h-6 w-6 rounded border-slate-300"
                      />
                      <span>
                        I have read all the instructions carefully and I am ready to begin this mock test in the real exam-style interface.
                      </span>
                    </label>
                  </div>
                </div>
              </section>

              {candidatePanel}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 bg-white px-6 py-4">
              <button
                onClick={() => setStage('instructions')}
                className="rounded-xl border border-slate-300 px-5 py-3 text-lg font-semibold text-slate-700"
              >
                Previous
              </button>
              <button
                onClick={() => {
                  setStartedAt(new Date().toISOString());
                  setStage('exam');
                  setWorkspaceTab('question');
                }}
                disabled={!declarationAccepted}
                className="rounded-xl bg-[#79d7ef] px-6 py-3 text-lg font-semibold text-white transition hover:bg-[#56c9e7] disabled:cursor-not-allowed disabled:opacity-50"
              >
                I am ready to begin
              </button>
            </div>
          </div>
        )}

        {stage === 'exam' && examScreen}
      </div>
    </div>
  );
};

void TestPlayer;

const ExactCbtTestPlayer = ({
  test,
  onClose,
  onSubmitted,
  onSubmitAttempt,
}: {
  test: MockTest;
  onClose: () => void;
  onSubmitted: (result: TestAttemptResult) => void;
  onSubmitAttempt?: (test: MockTest, answers: Record<string, number | number[]>, startedAt: string) => Promise<TestAttemptResult>;
}) => {
  const { user } = useAuth();
  const stageContentRef = useRef<HTMLElement | null>(null);
  const examMainRef = useRef<HTMLElement | null>(null);
  const [stage, setStage] = useState<ExamStage>('instructions');
  const [workspaceTab, setWorkspaceTab] = useState<ExamWorkspaceTab>('question');
  const [answers, setAnswers] = useState<Record<string, number | number[]>>({});
  const [visitedQuestions, setVisitedQuestions] = useState<Record<string, boolean>>({});
  const [reviewQuestions, setReviewQuestions] = useState<Record<string, boolean>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [timeLeft, setTimeLeft] = useState(test.durationMinutes * 60);
  const [submitting, setSubmitting] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [defaultLanguage, setDefaultLanguage] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('English');
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  const [questionZoom, setQuestionZoom] = useState(1);
  const [examPaused, setExamPaused] = useState(false);
  const [calculatorExpression, setCalculatorExpression] = useState('');
  const [calculatorResult, setCalculatorResult] = useState('0');
  const [calculatorAngleMode, setCalculatorAngleMode] = useState<'deg' | 'rad'>('deg');
  const [calculatorMemory, setCalculatorMemory] = useState(0);
  const [calculatorPosition, setCalculatorPosition] = useState({ x: 300, y: 170 });
  const [draggingCalculator, setDraggingCalculator] = useState(false);
  const calculatorDragOffsetRef = useRef({ x: 0, y: 0 });
  const calculatorPanelRef = useRef<HTMLDivElement | null>(null);
  const paletteScrollRef = useRef<HTMLDivElement | null>(null);

  const examSections = useMemo(() => buildExamSections(test), [test]);
  const rollNumber = useMemo(() => buildMockRollNumber(user?._id, test._id), [test._id, user?._id]);
  const candidateName = user?.name || 'Candidate';
  const currentQuestion = test.questions[currentIndex];
  const currentQuestionCorrectOptionIndexes = currentQuestion ? getQuestionCorrectOptionIndexes(currentQuestion) : [];
  const currentQuestionAllowsMultipleAnswers = currentQuestionCorrectOptionIndexes.length > 1;
  const questionTextClass = ['text-[14px] leading-7', 'text-[16px] leading-8', 'text-[19px] leading-9'][questionZoom];
  const timerLabel = formatTimeLeft(timeLeft).replace(':', ' : ');

  const currentSection = useMemo(() => (
    examSections.find((section) => currentIndex >= section.startIndex && currentIndex <= section.endIndex)
    || examSections[0]
    || null
  ), [currentIndex, examSections]);

  const currentSectionIndex = currentSection ? examSections.findIndex((section) => section.name === currentSection.name) : 0;
  const currentSectionLabel = `PART-${String.fromCharCode(65 + Math.max(currentSectionIndex, 0))}`;
  const currentQuestionNumberInSection = currentSection ? (currentIndex - currentSection.startIndex + 1) : (currentIndex + 1);

  const questionStates = useMemo(() => test.questions.reduce<Record<string, ExamQuestionState>>((stateMap, question) => {
    stateMap[question.id] = getExamQuestionState(question.id, answers, visitedQuestions, reviewQuestions);
    return stateMap;
  }, {}), [answers, reviewQuestions, test.questions, visitedQuestions]);

  const overallCounts = useMemo(() => test.questions.reduce((counts, question) => {
    const state = questionStates[question.id];
    if (state === 'answered') {
      counts.answered += 1;
    } else if (state === 'answered-review') {
      counts.answeredReview += 1;
    } else if (state === 'review') {
      counts.review += 1;
    } else if (state === 'unanswered') {
      counts.unanswered += 1;
    } else {
      counts.unvisited += 1;
    }

    return counts;
  }, {
    answered: 0,
    answeredReview: 0,
    review: 0,
    unanswered: 0,
    unvisited: 0,
  }), [questionStates, test.questions]);

  const answeredCount = overallCounts.answered + overallCounts.answeredReview;
  const isCurrentQuestionMarkedForReview = currentQuestion ? Boolean(reviewQuestions[currentQuestion.id]) : false;
  const liveEvaluation = useMemo(() => buildAttemptEvaluationSnapshot(test, answers), [answers, test]);
  const liveAttemptedCount = liveEvaluation.correctCount + liveEvaluation.incorrectCount;
  const liveAccuracy = liveAttemptedCount > 0
    ? Math.round((liveEvaluation.correctCount / liveAttemptedCount) * 100)
    : 0;

  const currentSectionCounts = useMemo(() => {
    if (!currentSection) {
      return {
        answered: 0,
        unanswered: 0,
        review: 0,
        answeredReview: 0,
        unvisited: 0,
      };
    }

    return test.questions.slice(currentSection.startIndex, currentSection.endIndex + 1).reduce((counts, question) => {
      const state = questionStates[question.id];
      if (state === 'answered') {
        counts.answered += 1;
      } else if (state === 'answered-review') {
        counts.answeredReview += 1;
      } else if (state === 'review') {
        counts.review += 1;
      } else if (state === 'unanswered') {
        counts.unanswered += 1;
      } else {
        counts.unvisited += 1;
      }

      return counts;
    }, {
      answered: 0,
      unanswered: 0,
      review: 0,
      answeredReview: 0,
      unvisited: 0,
    });
  }, [currentSection, questionStates, test.questions]);

  useEffect(() => {
    if (stage !== 'exam' || !currentQuestion) {
      return;
    }

    setVisitedQuestions((current) => (
      current[currentQuestion.id]
        ? current
        : { ...current, [currentQuestion.id]: true }
    ));
  }, [currentQuestion, stage]);

  useEffect(() => {
    if (stage !== 'exam' || submitting || examPaused) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setTimeLeft((current) => (current > 0 ? current - 1 : 0));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [examPaused, stage, submitting]);

  useEffect(() => {
    if (stage === 'exam' && timeLeft === 0 && !submitting) {
      void submitTest(true);
    }
  }, [stage, submitting, timeLeft]);

  useEffect(() => {
    stageContentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    examMainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [stage, workspaceTab, currentIndex]);

  useEffect(() => {
    if (stage !== 'exam') {
      return;
    }

    const activePaletteItem = paletteScrollRef.current?.querySelector<HTMLElement>('[data-active-palette="true"]');
    activePaletteItem?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentIndex, currentSection?.name, stage]);

  const handleExit = () => {
    if (stage === 'exam' && startedAt && !submitting) {
      const confirmed = window.confirm('Exit this test now? Your progress will not be submitted.');
      if (!confirmed) {
        return;
      }
    }

    onClose();
  };

  const goToQuestion = (questionIndex: number) => {
    if (stage === 'exam' && currentQuestion) {
      setVisitedQuestions((current) => (
        current[currentQuestion.id]
          ? current
          : { ...current, [currentQuestion.id]: true }
      ));
    }

    setCurrentIndex(Math.min(Math.max(questionIndex, 0), Math.max(test.questions.length - 1, 0)));
    setWorkspaceTab((current) => (current === 'calculator' ? 'calculator' : 'question'));
  };

  const submitTest = async (forced = false) => {
    if (!user || submitting) {
      return;
    }

    if (!forced) {
      const confirmed = window.confirm('Submit this test now?');
      if (!confirmed) {
        return;
      }
    }

    setSubmitting(true);
    try {
      const effectiveStartedAt = startedAt || new Date().toISOString();
      const result = onSubmitAttempt
        ? await onSubmitAttempt(test, answers, effectiveStartedAt)
        : await EduService.submitMockTest(test._id, answers, effectiveStartedAt);
      onSubmitted(result);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndNext = () => {
    if (!currentQuestion) {
      return;
    }

    setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
    if (currentIndex < test.questions.length - 1) {
      goToQuestion(currentIndex + 1);
    }
  };

  const handleMarkForReview = () => {
    if (!currentQuestion) {
      return;
    }

    setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
    setReviewQuestions((current) => {
      const next = { ...current };
      if (next[currentQuestion.id]) {
        delete next[currentQuestion.id];
      } else {
        next[currentQuestion.id] = true;
      }
      return next;
    });
  };

  const handleClearResponse = () => {
    if (!currentQuestion) {
      return;
    }

    setAnswers((current) => {
      const next = { ...current };
      delete next[currentQuestion.id];
      return next;
    });
    setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
  };

  const appendCalculatorValue = (value: string) => {
    setCalculatorExpression((current) => `${current}${value}`);
  };

  const wrapCalculatorExpression = (token: string) => {
    setCalculatorExpression((current) => {
      const trimmed = current.trim();
      return trimmed ? `${token}(${trimmed})` : `${token}(`;
    });
  };

  const evaluateCalculator = () => {
    const normalizedExpression = calculatorExpression.trim();

    if (!normalizedExpression.trim()) {
      setCalculatorResult('0');
      return;
    }

    if (!/^[0-9A-Z_+\-*/%,().\s]+$/.test(normalizedExpression)) {
      setCalculatorResult('Invalid');
      return;
    }

    try {
      const toRadians = (value: number) => (calculatorAngleMode === 'deg' ? (value * Math.PI) / 180 : value);
      const fromRadians = (value: number) => (calculatorAngleMode === 'deg' ? (value * 180) / Math.PI : value);
      const factorial = (value: number) => {
        if (!Number.isInteger(value) || value < 0) {
          throw new Error('Invalid factorial');
        }

        let result = 1;
        for (let index = 2; index <= value; index += 1) {
          result *= index;
        }
        return result;
      };

      const scope = {
        PI: Math.PI,
        CONST_E: Math.E,
        SIN: (value: number) => Math.sin(toRadians(value)),
        COS: (value: number) => Math.cos(toRadians(value)),
        TAN: (value: number) => Math.tan(toRadians(value)),
        ASIN: (value: number) => fromRadians(Math.asin(value)),
        ACOS: (value: number) => fromRadians(Math.acos(value)),
        ATAN: (value: number) => fromRadians(Math.atan(value)),
        SINH: (value: number) => Math.sinh(value),
        COSH: (value: number) => Math.cosh(value),
        TANH: (value: number) => Math.tanh(value),
        ASINH: (value: number) => Math.asinh(value),
        ACOSH: (value: number) => Math.acosh(value),
        ATANH: (value: number) => Math.atanh(value),
        EXP: (value: number) => Math.exp(value),
        LN: (value: number) => Math.log(value),
        LOG10: (value: number) => Math.log10(value),
        LOG2: (value: number) => Math.log2(value),
        SQRT: (value: number) => Math.sqrt(value),
        CBRT: (value: number) => Math.cbrt(value),
        SQR: (value: number) => value ** 2,
        CUBE: (value: number) => value ** 3,
        RECIP: (value: number) => 1 / value,
        ABS: (value: number) => Math.abs(value),
        FACT: (value: number) => factorial(value),
        POW: (left: number, right: number) => left ** right,
        NEG: (value: number) => value * -1,
      };

      const evaluator = Function(
        ...Object.keys(scope),
        `"use strict"; return (${normalizedExpression});`,
      );
      const value = evaluator(...Object.values(scope));
      setCalculatorResult(Number.isFinite(value) ? String(value) : 'Invalid');
    } catch {
      setCalculatorResult('Invalid');
    }
  };

  const toggleFullscreen = async () => {
    if (typeof document === 'undefined') {
      return;
    }

    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      return;
    }
  };

  const renderBrandMark = (size: 'sm' | 'md' = 'sm') => {
    return (
      <div className="flex flex-col">
        <div className={cn('font-black leading-none text-[#1a4fe3]', size === 'md' ? 'text-[22px]' : 'text-[18px]')}>
          VaronEnglish
        </div>
        <div className={cn('mt-1 font-bold uppercase leading-none text-[#d59a00]', size === 'md' ? 'text-[8px] tracking-[0.26em]' : 'text-[7px] tracking-[0.22em]')}>
          For Competitive Exams
        </div>
      </div>
    );
  };

  const renderSidebarAvatar = () => (
    <div className="flex h-[136px] w-[136px] items-center justify-center rounded-full bg-[#34bddf] text-white">
      <svg viewBox="0 0 120 120" className="h-[78px] w-[78px] fill-current" aria-hidden="true">
        <path d="M60 18c10.1 0 18.3 8.2 18.3 18.3S70.1 54.6 60 54.6s-18.3-8.2-18.3-18.3S49.9 18 60 18Zm0 44.4c17.7 0 32.1 10.4 32.1 23.1V98H27.9V85.5C27.9 72.8 42.3 62.4 60 62.4Z" />
      </svg>
    </div>
  );

  const renderPhotoPlaceholder = (label: string) => (
    <div className="w-[78px] text-center">
      <div className="flex h-[58px] items-center justify-center bg-[#dfe6f1] text-[#99a5b9]">
        <svg viewBox="0 0 120 120" className="h-[42px] w-[42px] fill-current" aria-hidden="true">
          <path d="M60 16c12.4 0 22.4 10.2 22.4 22.8S72.4 61.6 60 61.6 37.6 51.4 37.6 38.8 47.6 16 60 16Zm0 52c22 0 39.9 13.2 39.9 29.5V108H20.1V97.5C20.1 81.2 38 68 60 68Z" />
        </svg>
      </div>
      <p className="mt-1 text-[9px] font-medium leading-[1.15] text-slate-600">{label}</p>
    </div>
  );

  const renderLegendBadge = (state: ExamQuestionState) => (
    <div className="relative flex h-6 w-6 items-center justify-center">
      {state === 'unvisited' && <div className="h-[20px] w-[20px] border border-[#6b7280] bg-white" />}
      {state === 'unanswered' && (
        <div
          className="h-[20px] w-[20px] bg-[#c54c31]"
          style={{ clipPath: 'polygon(0 0,100% 0,100% 64%,50% 100%,0 64%)' }}
        />
      )}
      {state === 'answered' && (
        <div
          className="h-[20px] w-[20px] bg-[#2daa59]"
          style={{ clipPath: 'polygon(0 40%,50% 0,100% 40%,100% 100%,0 100%)' }}
        />
      )}
      {state === 'review' && <div className="h-[20px] w-[20px] rounded-full bg-[#8f4ee2]" />}
      {state === 'answered-review' && (
        <>
          <div className="h-[20px] w-[20px] rounded-full bg-[#8f4ee2]" />
          <div className="absolute -right-[1px] -top-[1px] flex h-3 w-3 items-center justify-center rounded-full bg-white">
            <CheckCircle2 className="h-3 w-3 text-[#2daa59]" />
          </div>
        </>
      )}
    </div>
  );

  const renderPaletteBadge = (state: ExamQuestionState, label: string | number, active = false) => (
    <div className="relative inline-flex flex-col items-center">
      <div
        className={cn(
          'relative flex h-[28px] w-[38px] items-center justify-center rounded-[7px] border px-1 text-[11px] font-semibold leading-none transition',
          active && 'border-[#fff36d] bg-[#fff36d] text-[#111111]',
          !active && state === 'unvisited' && 'border-[#2237dd] bg-[#2237dd] text-white',
          !active && state === 'unanswered' && 'border-[#2237dd] bg-[#2237dd] text-white',
          !active && state === 'answered' && 'border-[#2dad5c] bg-[#2dad5c] text-white',
          !active && state === 'review' && 'border-[#ff1414] bg-[#ff1414] text-white',
          !active && state === 'answered-review' && 'border-[#2dad5c] bg-[#2dad5c] text-white',
        )}
      >
        {label}
        {state === 'answered-review' && (
          <CheckCircle2 className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full bg-white text-[#2dad5c]" />
        )}
      </div>
      {active && (
        <div className="absolute top-[29px] h-0 w-0 border-x-[5px] border-x-transparent border-t-[9px] border-t-black" />
      )}
    </div>
  );

  const renderInstructionBody = (compact = false) => (
    <div className={cn(compact ? 'space-y-4' : 'space-y-5', 'text-[13px] leading-[1.65] text-slate-800')}>
      <div>
        <p className="text-[14px] font-semibold text-slate-900">General Instructions:</p>
        <ol className="mt-3 list-decimal space-y-3 pl-7">
          <li>
            The clock will be set at the server. The countdown timer at the top right corner of screen will display the remaining time available for you
            to complete the examination. When the timer reaches zero, the examination will end by itself. You need not terminate the examination or submit
            your paper.
          </li>
          <li>
            The Question Palette displayed on the right side of screen will show the status of each question using one of the following symbols:
          </li>
        </ol>
      </div>

      <div className="ml-7 space-y-2.5">
        {questionStateLegend.map((item) => (
          <div key={item.state} className="flex items-center gap-3">
            {renderLegendBadge(item.state)}
            <p>{item.description}</p>
          </div>
        ))}
      </div>

      <p>
        <span className="font-semibold">The Mark For Review</span> status for a question simply indicates that you would like to look at that question again.
        If a question is answered, but marked for review, then the answer will be considered for evaluation unless the status is modified by the candidate.
      </p>

      <div>
        <p className="text-[14px] font-semibold text-slate-900">Navigating to a Question :</p>
        <ol start={3} className="mt-3 list-decimal space-y-3 pl-7">
          <li>
            To answer a question, do the following:
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>
                Click on the question number in the Question Palette at the right of your screen to go to that numbered question directly. Note that using
                this option does NOT save your answer to the current question.
              </li>
              <li>
                Click on <span className="font-semibold">Save &amp; Next</span> to save your answer for the current question and then go to the next question.
              </li>
              <li>
                Click on <span className="font-semibold">Mark for Review &amp; Next</span> to save your answer for the current question and also mark it for review,
                and then go to the next question.
              </li>
            </ol>
          </li>
        </ol>
      </div>

      <p>
        Note that your answer for the current question will not be saved, if you navigate to another question directly by clicking on a question number without
        saving the answer to the previous question.
      </p>

      <p>
        You can view all the questions by clicking on the <span className="font-semibold">Question Paper</span> button.
        <span className="ml-1 text-[#e5503f]">
          This feature is provided, so that if you want you can just see the entire question paper at a glance.
        </span>
      </p>

      <div>
        <p className="text-[14px] font-semibold text-slate-900">Answering a Question :</p>
        <ol start={4} className="mt-3 list-decimal space-y-3 pl-7">
          <li>
            Procedure for answering a multiple choice (MCQ) type question:
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>Choose one answer from the 4 options (A,B,C,D) given below the question, click on the bubble placed before the chosen option.</li>
              <li>To deselect your chosen answer, click on the bubble of the chosen option again or click on the <span className="font-semibold">Clear Response</span> button.</li>
              <li>To change your chosen answer, click on the bubble of another option.</li>
              <li>To save your answer, you MUST click on the <span className="font-semibold">Save &amp; Next</span> button.</li>
            </ol>
          </li>
          <li>
            Procedure for answering a numerical answer type question :
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>To enter a number as your answer, use the virtual numerical keypad.</li>
              <li>
                A fraction (e.g. -0.3 or -.3) can be entered as an answer with or without &apos;0&apos; before the decimal point.
                <span className="ml-1 text-[#e5503f]">
                  As many as four decimal points, e.g. 12.5435 or 0.003 or -932.6711 or 12.82 can be entered.
                </span>
              </li>
              <li>To clear your answer, click on the <span className="font-semibold">Clear Response</span> button.</li>
              <li>To save your answer, you MUST click on the <span className="font-semibold">Save &amp; Next</span> button.</li>
            </ol>
          </li>
          <li>
            To mark a question for review, click on the <span className="font-semibold">Mark for Review &amp; Next</span> button. If an answer is selected
            (for MCQ/MCAQ) entered (for numerical answer type) for a question that is <span className="font-semibold">Marked For Review</span>, that answer
            will be considered in the evaluation unless the status is modified by the candidate.
          </li>
          <li>
            To change your answer to a question that has already been answered, first select that question for answering and then follow the procedure for
            answering that type of question.
          </li>
          <li>
            Note that <span className="font-semibold">ONLY</span> questions for which answers are <span className="font-semibold">saved</span> or
            <span className="font-semibold"> marked for review after answering</span> will be considered for evaluation.
          </li>
          <li>
            Sections in this question paper are displayed on the top bar of the screen. Questions in a Section can be viewed by clicking on the name of that Section.
            The Section you are currently viewing will be highlighted.
          </li>
          <li>
            After clicking the <span className="font-semibold">Save &amp; Next</span> button for the last question in a Section, you will automatically be taken to
            the first question of the next Section in sequence.
          </li>
          <li>
            You can move the mouse cursor over the name of a Section to view the answering status for that Section.
          </li>
        </ol>
      </div>
    </div>
  );

  const renderExamRichText = (content: string, className: string, imageClassName?: string) => {
    const trimmed = String(content || '').trim();
    const isHtml = /<\/?[a-z][\s\S]*>/i.test(trimmed);
    const isStandaloneImage = /^(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg))(?:\?\S*)?$/i.test(trimmed);

    if (isStandaloneImage) {
      return <img src={trimmed} alt="" className={cn('max-w-full', imageClassName)} />;
    }

    if (isHtml) {
      return <div className={className} dangerouslySetInnerHTML={{ __html: trimmed }} />;
    }

    return <div className={cn(className, 'whitespace-pre-wrap')}>{trimmed}</div>;
  };

  const startCalculatorDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    const panel = calculatorPanelRef.current;
    if (!panel) {
      return;
    }

    const panelRect = panel.getBoundingClientRect();
    calculatorDragOffsetRef.current = {
      x: event.clientX - panelRect.left,
      y: event.clientY - panelRect.top,
    };
    setDraggingCalculator(true);
  };

  const renderQuestionView = () => {
    if (!currentQuestion) {
      return <div className="border border-slate-300 bg-white p-8 text-[13px] text-slate-600">No questions found.</div>;
    }

    return (
        <div className="space-y-4">
          <p className="text-[18px] font-semibold text-[#333333]">Question No. {currentQuestionNumberInSection}</p>

        <div className="border border-[#d6dde7] bg-white">
          <div className="flex items-center justify-end gap-5 border-b border-[#e3e8ef] px-[22px] py-[10px]">
            <label className="flex items-center gap-3 text-[12px] font-semibold text-slate-700">
              <span>Select Language</span>
              <select
                value={selectedLanguage}
                onChange={(event) => setSelectedLanguage(event.target.value)}
                className="h-[38px] min-w-[108px] border border-[#cad3de] bg-white px-3 text-[12px] font-normal text-slate-700 outline-none"
              >
                <option value="English">English</option>
                <option value="Hindi">Hindi</option>
              </select>
            </label>
            <button className="inline-flex items-center gap-1 text-[12px] font-medium text-slate-500">
              <AlertTriangle className="h-4 w-4" />
              Report
            </button>
          </div>

          <div className="cbt-scroll h-[calc(100vh-343px)] min-h-[555px] overflow-y-scroll">
            <div className="px-[14px] py-[14px]">
              <div className="border border-[#e2e7ee] bg-white">
                <div className="border-b border-[#e2e7ee] px-5 py-5">
                  {renderExamRichText(
                    currentQuestion.questionText,
                    cn('font-normal text-slate-900', questionTextClass),
                    'max-h-[340px] object-contain',
                  )}
                </div>

                <div className="divide-y divide-[#e2e7ee]">
                  {currentQuestion.options.map((option, optionIndex) => {
                    const selectedOptionIndexes = normalizeOptionIndexes(answers[currentQuestion.id]);
                    const isSelected = selectedOptionIndexes.includes(optionIndex);

                    return (
                      <button
                        key={`${currentQuestion.id}-${option}`}
                        onClick={() => {
                          setAnswers((current) => {
                            const nextValue = toggleSelectedOptionValue(current[currentQuestion.id], optionIndex, currentQuestionAllowsMultipleAnswers);
                            const nextAnswers = { ...current };
                            if (Array.isArray(nextValue) && nextValue.length === 0) {
                              delete nextAnswers[currentQuestion.id];
                            } else {
                              nextAnswers[currentQuestion.id] = nextValue;
                            }
                            return nextAnswers;
                          });
                          setVisitedQuestions((current) => ({ ...current, [currentQuestion.id]: true }));
                        }}
                        className="grid w-full grid-cols-[58px_minmax(0,1fr)] items-center text-left transition hover:bg-slate-50"
                      >
                        <div className="flex h-full items-center justify-center border-r border-[#e2e7ee] py-6">
                          <div className={cn(
                            currentQuestionAllowsMultipleAnswers
                              ? 'flex h-[19px] w-[19px] items-center justify-center rounded-[4px] border border-slate-400 bg-white'
                              : 'flex h-[19px] w-[19px] items-center justify-center rounded-full border border-slate-400 bg-white',
                            isSelected && 'border-[#1e88e5]',
                          )}>
                            {isSelected && (
                              <div className={cn(
                                currentQuestionAllowsMultipleAnswers ? 'h-[9px] w-[9px] rounded-[2px] bg-[#1e88e5]' : 'h-[8px] w-[8px] rounded-full bg-[#1e88e5]',
                              )} />
                            )}
                          </div>
                        </div>
                        <div className="px-[28px] py-[20px]">
                          {renderExamRichText(option, 'text-[14px] leading-[1.5] text-slate-800', 'max-h-[240px] object-contain')}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={handleClearResponse}
            className="h-[42px] min-w-[142px] rounded-[2px] bg-white px-5 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-300"
          >
            Clear Response
          </button>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => goToQuestion(currentIndex - 1)}
              disabled={currentIndex === 0}
              className="h-[42px] min-w-[112px] rounded-[2px] bg-white px-5 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-300 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={handleSaveAndNext}
              className="h-[42px] min-w-[142px] rounded-[2px] bg-[#2f69d9] px-5 text-[12px] font-semibold text-white"
            >
              Save &amp; Next
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSymbolsView = () => (
    <div className="border border-slate-300 bg-white p-5">
      <p className="text-[15px] font-semibold text-slate-900">Symbols</p>
      <div className="mt-4 space-y-3">
        {questionStateLegend.map((item) => (
          <div key={item.state} className="flex items-center gap-3">
            {renderLegendBadge(item.state)}
            <p className="text-[13px] leading-7 text-slate-800">{item.description}</p>
          </div>
        ))}
      </div>
    </div>
  );

  const renderInstructionsView = () => (
    <div className="border border-slate-300 bg-white p-5">
      {renderInstructionBody(true)}
    </div>
  );

  const renderSummaryView = () => {
    const unresolvedQuestions = test.questions
      .map((question, index) => ({
        question,
        index,
        state: questionStates[question.id],
      }))
      .filter((item) => item.state !== 'answered' && item.state !== 'answered-review');

    return (
      <div className="space-y-5">
        <div className="border border-slate-300 bg-white p-5">
          <p className="text-[15px] font-semibold text-slate-900">Overall Test Summary</p>
          <div className="mt-4 grid gap-3 md:grid-cols-5">
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Answered</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{answeredCount}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Not Answered</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{overallCounts.unanswered}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Review</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{overallCounts.review + overallCounts.answeredReview}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Not Visited</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{overallCounts.unvisited}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Time Left</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{timerLabel}</p>
            </div>
          </div>
        </div>

        <div className="border border-slate-300 bg-white p-5">
          <p className="text-[15px] font-semibold text-slate-900">Live Scoring</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Score</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{liveEvaluation.score} / {liveEvaluation.totalMarks}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Correct</p>
              <p className="mt-2 text-[18px] font-semibold text-emerald-600">{liveEvaluation.correctCount}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Incorrect</p>
              <p className="mt-2 text-[18px] font-semibold text-rose-600">{liveEvaluation.incorrectCount}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Attempted</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{liveAttemptedCount}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Unattempted</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{liveEvaluation.unattemptedCount}</p>
            </div>
            <div className="border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Accuracy</p>
              <p className="mt-2 text-[18px] font-semibold text-slate-900">{liveAccuracy}%</p>
            </div>
          </div>
        </div>

        <div className="border border-slate-300 bg-white p-5">
          <p className="text-[15px] font-semibold text-slate-900">Questions Needing Attention</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {unresolvedQuestions.length > 0 ? unresolvedQuestions.map((item) => (
              <button
                key={item.question.id}
                onClick={() => goToQuestion(item.index)}
                className="flex items-center justify-between border border-slate-200 bg-white px-4 py-3 text-left hover:bg-slate-50"
              >
                <div>
                  <p className="text-[13px] font-semibold text-slate-900">Question {item.index + 1}</p>
                  <p className="mt-1 text-[12px] text-slate-600">{questionStateLegend.find((legend) => legend.state === item.state)?.label}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-slate-400" />
              </button>
            )) : (
              <div className="border border-emerald-200 bg-emerald-50 px-4 py-4 text-[13px] font-medium text-emerald-700">
                Every question has been attempted or saved for review.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderCalculatorView = () => {
    const baseButtonClass = 'flex h-[34px] items-center justify-center rounded-[4px] border border-[#a7a7a7] bg-[#f3f3f3] px-2 text-[12px] font-semibold text-[#454545] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]';

    const scientificButtons = [
      [
        { label: 'sinh', onClick: () => appendCalculatorValue('SINH(') },
        { label: 'cosh', onClick: () => appendCalculatorValue('COSH(') },
        { label: 'tanh', onClick: () => appendCalculatorValue('TANH(') },
        { label: 'Exp', onClick: () => appendCalculatorValue('EXP(') },
        { label: '(', onClick: () => appendCalculatorValue('(') },
        { label: ')', onClick: () => appendCalculatorValue(')') },
        { label: '←', onClick: () => setCalculatorExpression((current) => current.slice(0, -1)), className: 'bg-[#e95d44] text-white' },
        { label: 'C', onClick: () => { setCalculatorExpression(''); setCalculatorResult('0'); }, className: 'bg-[#ef6841] text-white' },
        { label: '+/-', onClick: () => wrapCalculatorExpression('NEG'), className: 'bg-[#ef6841] text-white' },
        { label: '√', onClick: () => wrapCalculatorExpression('SQRT') },
      ],
      [
        { label: 'sinh⁻¹', onClick: () => appendCalculatorValue('ASINH(') },
        { label: 'cosh⁻¹', onClick: () => appendCalculatorValue('ACOSH(') },
        { label: 'tanh⁻¹', onClick: () => appendCalculatorValue('ATANH(') },
        { label: 'log₂x', onClick: () => appendCalculatorValue('LOG2(') },
        { label: 'ln', onClick: () => appendCalculatorValue('LN(') },
        { label: 'log', onClick: () => appendCalculatorValue('LOG10(') },
        { label: '7', onClick: () => appendCalculatorValue('7') },
        { label: '8', onClick: () => appendCalculatorValue('8') },
        { label: '9', onClick: () => appendCalculatorValue('9') },
        { label: '/', onClick: () => appendCalculatorValue('/') },
      ],
      [
        { label: 'π', onClick: () => appendCalculatorValue('PI') },
        { label: 'e', onClick: () => appendCalculatorValue('CONST_E') },
        { label: 'n!', onClick: () => wrapCalculatorExpression('FACT') },
        { label: 'logₓy', onClick: () => appendCalculatorValue('POW(') },
        { label: 'eˣ', onClick: () => wrapCalculatorExpression('EXP') },
        { label: '10ˣ', onClick: () => appendCalculatorValue('POW(10,') },
        { label: '4', onClick: () => appendCalculatorValue('4') },
        { label: '5', onClick: () => appendCalculatorValue('5') },
        { label: '6', onClick: () => appendCalculatorValue('6') },
        { label: '*', onClick: () => appendCalculatorValue('*') },
      ],
      [
        { label: 'sin', onClick: () => appendCalculatorValue('SIN(') },
        { label: 'cos', onClick: () => appendCalculatorValue('COS(') },
        { label: 'tan', onClick: () => appendCalculatorValue('TAN(') },
        { label: 'xʸ', onClick: () => appendCalculatorValue('POW(') },
        { label: 'x³', onClick: () => wrapCalculatorExpression('CUBE') },
        { label: 'x²', onClick: () => wrapCalculatorExpression('SQR') },
        { label: '1', onClick: () => appendCalculatorValue('1') },
        { label: '2', onClick: () => appendCalculatorValue('2') },
        { label: '3', onClick: () => appendCalculatorValue('3') },
        { label: '-', onClick: () => appendCalculatorValue('-') },
      ],
      [
        { label: 'sin⁻¹', onClick: () => appendCalculatorValue('ASIN(') },
        { label: 'cos⁻¹', onClick: () => appendCalculatorValue('ACOS(') },
        { label: 'tan⁻¹', onClick: () => appendCalculatorValue('ATAN(') },
        { label: '√x', onClick: () => wrapCalculatorExpression('SQRT') },
        { label: '∛', onClick: () => wrapCalculatorExpression('CBRT') },
        { label: '|x|', onClick: () => wrapCalculatorExpression('ABS') },
        { label: '0', onClick: () => appendCalculatorValue('0') },
        { label: '.', onClick: () => appendCalculatorValue('.') },
        { label: '+', onClick: () => appendCalculatorValue('+') },
        { label: '=', onClick: evaluateCalculator, className: 'bg-[#2bc56f] text-white' },
      ],
    ];

    return (
      <div
        ref={calculatorPanelRef}
        className="pointer-events-auto absolute z-20 w-[620px] max-w-[calc(100%-24px)] overflow-hidden border border-[#8d8d8d] bg-[#d7d7d7] shadow-[0_10px_24px_rgba(0,0,0,0.22)]"
        style={{ left: `${calculatorPosition.x}px`, top: `${calculatorPosition.y}px` }}
      >
        <div className="overflow-hidden">
          <div
            onMouseDown={startCalculatorDrag}
            className={cn(
              'flex cursor-move select-none items-center justify-between bg-[#4c8cf0] px-2 py-1.5 text-white',
              draggingCalculator && 'cursor-grabbing',
            )}
          >
            <p className="text-[12px] font-normal">Scientific Calculator</p>
            <div className="flex items-center gap-px">
              <button type="button" className="border border-[#437be8] bg-[#4c8cf0] px-3 py-0.5 text-[11px]">Help</button>
              <button type="button" onClick={() => setWorkspaceTab('question')} className="border border-[#437be8] bg-[#4c8cf0] px-3 py-0.5 text-[16px] leading-none">-</button>
              <button type="button" onClick={() => setWorkspaceTab('question')} className="border border-[#437be8] bg-[#4c8cf0] px-3 py-0.5 text-[16px] leading-none">x</button>
            </div>
          </div>

          <div className="bg-[#ececec] p-2">
            <div className="h-[38px] overflow-hidden border border-[#a0a0a0] bg-white px-2 py-1 text-right text-[16px] leading-[28px] text-[#4d4d4d]">
              {calculatorExpression || ''}
            </div>
            <div className="mt-2 h-[40px] overflow-hidden border border-[#a0a0a0] bg-white px-2 py-1 text-right text-[22px] leading-[28px] text-[#1f1f1f]">
              {calculatorResult}
            </div>

            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button onClick={() => appendCalculatorValue('%')} className={cn(baseButtonClass, 'h-[32px] px-3')}>mod</button>
                <label className="flex items-center gap-1 text-[11px] text-[#444]">
                  <input
                    type="radio"
                    checked={calculatorAngleMode === 'deg'}
                    onChange={() => setCalculatorAngleMode('deg')}
                    className="h-3 w-3"
                  />
                  Deg
                </label>
                <label className="flex items-center gap-1 text-[11px] text-[#444]">
                  <input
                    type="radio"
                    checked={calculatorAngleMode === 'rad'}
                    onChange={() => setCalculatorAngleMode('rad')}
                    className="h-3 w-3"
                  />
                  Rad
                </label>
              </div>

              <div className="grid grid-cols-5 gap-2">
                <button onClick={() => setCalculatorMemory(0)} className={baseButtonClass}>MC</button>
                <button onClick={() => appendCalculatorValue(String(calculatorMemory))} className={baseButtonClass}>MR</button>
                <button onClick={() => setCalculatorMemory(Number(calculatorResult) || 0)} className={baseButtonClass}>MS</button>
                <button onClick={() => setCalculatorMemory((current) => current + (Number(calculatorResult) || 0))} className={baseButtonClass}>M+</button>
                <button onClick={() => setCalculatorMemory((current) => current - (Number(calculatorResult) || 0))} className={baseButtonClass}>M-</button>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {scientificButtons.map((row, rowIndex) => (
                <div key={`row-${rowIndex}`} className="grid grid-cols-10 gap-2">
                  {row.map((button) => (
                    <button
                      type="button"
                      key={`${rowIndex}-${button.label}`}
                      onClick={button.onClick}
                      className={cn(baseButtonClass, button.className)}
                    >
                      {button.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderWorkspace = () => {
    if (workspaceTab === 'calculator') {
      return (
        <div className="relative">
          {renderQuestionView()}
          {renderCalculatorView()}
        </div>
      );
    }

    if (workspaceTab === 'symbols') {
      return renderSymbolsView();
    }

    if (workspaceTab === 'instructions') {
      return renderInstructionsView();
    }

    if (workspaceTab === 'summary') {
      return renderSummaryView();
    }

    return renderQuestionView();
  };

  const preExamHeader = (
    <div className="flex items-center gap-5 border-b border-slate-200 bg-white px-5 py-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
      <div className="flex items-center gap-3">
        {renderBrandMark('md')}
      </div>
      <p className="text-[13px] font-medium text-slate-800">{test.title}</p>
    </div>
  );

  const preExamSidebar = (
    <aside className="border-l border-slate-200 bg-[#f7f9fc] px-6 py-8">
      <div className="flex h-full flex-col items-center text-center">
        {renderSidebarAvatar()}
        <p className="mt-9 max-w-[190px] text-[24px] font-normal leading-tight text-[#343434]">{candidateName}</p>
      </div>
    </aside>
  );

  const examScreen = (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="grid gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.06)] lg:grid-cols-[290px_160px_minmax(0,1fr)_360px] lg:items-center">
        <div className="flex items-center gap-3">
          {renderBrandMark('md')}
          <div>
            <p className="mt-1 text-[10px] font-semibold leading-tight text-slate-900">{test.title}</p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 lg:justify-start">
          <button
            onClick={() => setQuestionZoom((current) => Math.min(current + 1, 2))}
            className="rounded-[14px] bg-[#2f69d9] px-4 py-2 text-[10px] font-semibold text-white"
          >
            Zoom (+)
          </button>
          <button
            onClick={() => setQuestionZoom((current) => Math.max(current - 1, 0))}
            className="rounded-[14px] bg-[#2f69d9] px-4 py-2 text-[10px] font-semibold text-white"
          >
            Zoom (-)
          </button>
        </div>

        <div className="text-center">
          <p className="text-[17px] font-semibold text-slate-900">{test.title}</p>
          <p className="mt-1 text-[11px] font-semibold text-slate-700">Roll No : {rollNumber}</p>
        </div>

        <div className="flex flex-wrap items-start justify-end gap-3">
          <button
            onClick={() => void toggleFullscreen()}
            className="flex h-11 w-11 items-center justify-center rounded-[4px] border border-[#37b3eb] bg-white text-[#37b3eb]"
          >
            <Expand className="h-4 w-4" />
          </button>
          <button
            onClick={() => setExamPaused((current) => !current)}
            className="flex h-11 w-11 items-center justify-center rounded-[4px] border border-[#37b3eb] bg-white text-[#37b3eb]"
          >
            {examPaused ? <PlayCircle className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </button>
          <div className="px-1 text-right">
            <p className="text-[11px] font-semibold text-slate-800">Time Left</p>
            <p className="mt-1 bg-[#fff36d] px-3 py-1 text-[17px] font-bold tracking-[0.08em] text-red-600">{timerLabel}</p>
          </div>
          <div className="flex gap-2">{renderPhotoPlaceholder('Registration Photo')}{renderPhotoPlaceholder('Captured Photo')}</div>
        </div>
      </div>

      <div className="grid border-b border-slate-200 lg:grid-cols-[minmax(0,1fr)_430px]">
        <div className="flex flex-wrap items-center gap-5 px-4 py-3">
          {examWorkspaceTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setWorkspaceTab(tab.id)}
              className={cn(
                'text-[11px] font-semibold uppercase underline underline-offset-4',
                tab.id === 'symbols' || tab.id === 'calculator' ? 'text-[#1f78c5]' : 'text-[#cc4b2a]',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="border-l border-slate-200 px-4 py-3 text-right">
          <p className="text-[12px] font-semibold text-slate-900">
            Total Questions Answered: <span className="bg-[#fff36d] px-1.5 py-0.5 text-[#ff1b00]">{answeredCount}</span>
          </p>
        </div>
      </div>

      <div className="grid border-b border-slate-200 lg:grid-cols-[minmax(0,1fr)_430px]">
        <div className="px-4 py-3">
          <div className="grid items-center gap-4 xl:grid-cols-[auto_1fr_auto]">
            <div className="flex flex-wrap gap-2">
              {examSections.map((section, sectionIndex) => {
                const sectionLabel = `PART-${String.fromCharCode(65 + sectionIndex)}`;
                const isActiveSection = currentSection?.name === section.name;

                return (
                  <button
                    key={section.name}
                    onClick={() => goToQuestion(section.startIndex)}
                    className={cn(
                      'rounded-[4px] px-4 py-[7px] text-[12px] font-semibold text-white',
                      isActiveSection ? 'bg-[#179b17]' : 'bg-[#2237dd]',
                    )}
                  >
                    {sectionLabel}
                  </button>
                );
              })}
            </div>

            <div className="flex justify-center">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  onClick={handleMarkForReview}
                  className={cn(
                    'min-w-[134px] rounded-[4px] px-4 py-[8px] text-[12px] font-semibold',
                    isCurrentQuestionMarkedForReview
                      ? 'bg-[#ece3c9] text-[#242424]'
                      : 'bg-[#2f69d9] text-white',
                  )}
                >
                  {isCurrentQuestionMarkedForReview ? 'Unmark Review' : 'Mark for Review'}
                </button>
                <button onClick={handleSaveAndNext} className="min-w-[122px] rounded-[4px] bg-[#2f69d9] px-4 py-[8px] text-[12px] font-semibold text-white">Save &amp; Next</button>
                <button
                  onClick={() => void submitTest()}
                  disabled={submitting}
                  className="min-w-[114px] rounded-[4px] bg-[#2f69d9] px-4 py-[8px] text-[12px] font-semibold text-white disabled:opacity-60"
                >
                  {submitting ? 'Submitting...' : 'Submit Test'}
                </button>
              </div>
            </div>

            <div />
          </div>
        </div>
        <div className="border-l border-slate-200 bg-white" />
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_430px]">
        <main ref={examMainRef} className="cbt-scroll min-h-0 overflow-y-scroll px-4 py-5">
          {renderWorkspace()}
        </main>

        <aside className="min-h-0 border-l border-slate-200 bg-white">
          <div className="flex h-full min-h-0 flex-col px-4 py-3">
            {currentSection && (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <div className="h-0 w-0 border-y-[10px] border-y-transparent border-l-[14px] border-l-[#31a8dd]" />
                  <p className="text-[13px] font-semibold text-slate-900">{currentSection.name}</p>
                </div>

                <div ref={paletteScrollRef} className="cbt-scroll mt-3 min-h-0 flex-1 overflow-y-scroll pr-1">
                  <div
                    className="grid grid-cols-4 justify-items-center gap-y-4 pb-2"
                  >
                    {test.questions.slice(currentSection.startIndex, currentSection.endIndex + 1).map((question, sectionQuestionIndex) => {
                      const questionIndex = currentSection.startIndex + sectionQuestionIndex;
                      const questionState = questionStates[question.id];

                      return (
                        <button
                          key={question.id}
                          data-active-palette={currentIndex === questionIndex ? 'true' : 'false'}
                          onClick={() => goToQuestion(questionIndex)}
                        >
                          {renderPaletteBadge(questionState, sectionQuestionIndex + 1, currentIndex === questionIndex)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 shrink-0 border border-slate-400 bg-white">
              <div className="border-b border-slate-400 bg-slate-100 px-3 py-[8px] text-center text-[13px] font-semibold text-slate-900">
                Live Scoring
              </div>
              <div className="grid grid-cols-2 gap-px bg-slate-200">
                <div className="bg-white px-3 py-3 text-center">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Score</p>
                  <p className="mt-1 text-[18px] font-semibold text-slate-900">{liveEvaluation.score}</p>
                </div>
                <div className="bg-white px-3 py-3 text-center">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Accuracy</p>
                  <p className="mt-1 text-[18px] font-semibold text-slate-900">{liveAccuracy}%</p>
                </div>
                <div className="bg-white px-3 py-3 text-center">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Correct</p>
                  <p className="mt-1 text-[18px] font-semibold text-emerald-600">{liveEvaluation.correctCount}</p>
                </div>
                <div className="bg-white px-3 py-3 text-center">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Incorrect</p>
                  <p className="mt-1 text-[18px] font-semibold text-rose-600">{liveEvaluation.incorrectCount}</p>
                </div>
              </div>
              <div className="divide-y divide-slate-200">
                <div className="grid grid-cols-[minmax(0,1fr)_52px] text-[12px]">
                  <span className="px-4 py-[9px] text-slate-700">Attempted</span>
                  <span className="flex items-center justify-center border-l border-slate-200 bg-[#fff36d] font-semibold text-[#ff1b00]">{liveAttemptedCount}</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_52px] text-[12px]">
                  <span className="px-4 py-[9px] text-slate-700">Unattempted</span>
                  <span className="flex items-center justify-center border-l border-slate-200 bg-[#fff36d] font-semibold text-[#ff1b00]">{liveEvaluation.unattemptedCount}</span>
                </div>
              </div>
            </div>

            <div className="mt-3 shrink-0 border border-slate-400 bg-white">
              <div className="border-b border-slate-400 bg-slate-100 px-3 py-[8px] text-center text-[13px] font-semibold text-slate-900">
                {currentSectionLabel} Analysis
              </div>
              <div className="divide-y divide-slate-200">
                <div className="grid grid-cols-[minmax(0,1fr)_40px] text-[12px]">
                  <span className="px-4 py-[9px] text-slate-700">Answered</span>
                  <span className="flex items-center justify-center border-l border-slate-200 bg-[#fff36d] font-semibold text-[#ff1b00]">{currentSectionCounts.answered + currentSectionCounts.answeredReview}</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_40px] text-[12px]">
                  <span className="px-4 py-[9px] text-slate-700">Not Answered</span>
                  <span className="flex items-center justify-center border-l border-slate-200 bg-[#fff36d] font-semibold text-[#ff1b00]">{currentSectionCounts.unanswered + currentSectionCounts.unvisited}</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_40px] text-[12px]">
                  <span className="px-4 py-[9px] text-slate-700">Mark for Review</span>
                  <span className="flex items-center justify-center border-l border-slate-200 bg-[#fff36d] font-semibold text-[#ff1b00]">{currentSectionCounts.review + currentSectionCounts.answeredReview}</span>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 bg-white text-slate-900 [font-family:Arial,_Helvetica,_sans-serif]">
      {stage === 'instructions' && (
        <div className="flex h-full flex-col bg-white">
          {preExamHeader}
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section ref={stageContentRef} className="cbt-scroll overflow-y-scroll px-5 py-6">
              {renderInstructionBody()}
            </section>
            {preExamSidebar}
          </div>

          <div className="grid border-t border-slate-200 bg-white lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex items-center justify-between px-5 py-3">
              <button
                onClick={handleExit}
                className="text-[13px] font-medium text-[#4a94cb]"
              >
                ← Go to Tests
              </button>
              <button
                onClick={() => setStage('declaration')}
                className="rounded-[3px] bg-[#7db3ec] px-8 py-2 text-[12px] font-semibold text-white"
              >
                Next
              </button>
            </div>
            <div className="border-l border-slate-200 bg-[#f7f9fc]" />
          </div>
        </div>
      )}

      {stage === 'declaration' && (
        <div className="flex h-full flex-col bg-white">
          {preExamHeader}
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section ref={stageContentRef} className="cbt-scroll overflow-y-scroll px-5 py-6">
              <div>
                <p className="text-center text-[21px] font-semibold text-slate-900">{test.title}</p>

                <div className="mt-8 flex flex-wrap items-center justify-between gap-4 text-[14px] font-semibold text-slate-800">
                  <p>Duration: {test.durationMinutes} Mins</p>
                  <p>Maximum Marks: {test.totalMarks}</p>
                </div>

                <p className="mt-6 text-[15px] font-semibold text-slate-900">Read the following instructions carefully.</p>
                <ol className="mt-4 list-decimal space-y-3 pl-6 text-[13px] leading-8 text-slate-800">
                  <li>The test contains {test.questions.length} total questions.</li>
                  <li>Each question has 4 Options out of which only one is correct.</li>
                  <li>You have to finish the test in {test.durationMinutes} minutes.</li>
                  <li>Try not to guess the answer as there is negative marking.</li>
                  <li>You will be awarded {test.questions[0]?.marks || 1} mark for each correct answer and {test.negativeMarking} will be deducted for each wrong answer.</li>
                  <li>There is no negative marking for the questions that you have not attempted.</li>
                  <li>You can write this test only once. Make sure that you complete the test before you submit the test and/or close the browser.</li>
                </ol>

                <div className="mt-8 border-y border-slate-200 py-6">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="text-[13px] font-semibold text-slate-900">Choose your default language:</label>
                    <select
                      value={defaultLanguage}
                      onChange={(event) => setDefaultLanguage(event.target.value)}
                      className="h-[35px] border border-slate-300 bg-white px-3 text-[12px] text-slate-900 outline-none"
                    >
                      <option value="">-- Select --</option>
                      <option value="English">English</option>
                      <option value="Hindi">Hindi</option>
                    </select>
                  </div>
                  <p className="mt-4 text-[13px] leading-7 text-[#e54d42]">
                    Please note all questions will appear in your default language. This language can be changed for a particular question later on.
                  </p>
                </div>

                <div className="mt-6">
                  <p className="text-[15px] font-semibold text-slate-900">Declaration:</p>
                  <label className="mt-3 flex items-start gap-3 text-[13px] leading-7 text-slate-800">
                    <input
                      type="checkbox"
                      checked={declarationAccepted}
                      onChange={(event) => setDeclarationAccepted(event.target.checked)}
                      className="mt-1 h-3.5 w-3.5 rounded-none border-slate-300"
                    />
                    <span>
                      I have read all the instructions carefully and have understood them. I agree not to cheat or use unfair means in this examination.
                      I understand that using unfair means of any sort for my own or someone else&apos;s advantage will lead to my immediate disqualification.
                      The decision of {CBT_BRAND_NAME} will be final in these matters and cannot be appealed.
                    </span>
                  </label>
                </div>
              </div>
            </section>
            {preExamSidebar}
          </div>

          <div className="grid border-t border-slate-200 bg-white lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid grid-cols-[auto_1fr_auto] items-center px-5 py-3">
              <button
                onClick={() => setStage('instructions')}
                className="rounded-[3px] bg-[#eef5ff] px-5 py-2 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-300"
              >
                Previous
              </button>
              <div className="flex justify-center">
                <button
                  onClick={() => {
                    setStartedAt(new Date().toISOString());
                    setExamPaused(false);
                    setSelectedLanguage(defaultLanguage || 'English');
                    setStage('exam');
                    setWorkspaceTab('question');
                  }}
                  disabled={!declarationAccepted}
                  className="rounded-[3px] bg-[#72d0e9] px-8 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
                >
                  I am ready to begin
                </button>
              </div>
              <div />
            </div>
            <div className="border-l border-slate-200 bg-[#f7f9fc]" />
          </div>
        </div>
      )}

      {stage === 'exam' && examScreen}
    </div>
  );
};

const TestsTab = ({ overview, onRefresh }: { overview: PlatformOverview; onRefresh: () => Promise<void> }) => {
  const [activeTest, setActiveTest] = useState<MockTest | null>(null);
  const [lastResult, setLastResult] = useState<TestAttemptResult | null>(null);
  const [solutionFilter, setSolutionFilter] = useState<'all' | 'correct' | 'incorrect' | 'skipped'>('all');
  const [openSolutions, setOpenSolutions] = useState<Record<string, boolean>>({});
  const filteredSolutions = (lastResult?.solutions || []).filter((solution) => {
    if (solutionFilter === 'all') {
      return true;
    }

    if (solutionFilter === 'skipped') {
      return getSolutionSelectedOptionIndexes(solution).length === 0;
    }

    const hasSelection = getSolutionSelectedOptionIndexes(solution).length > 0;
    const correct = isSolutionCorrect(solution);
    return solutionFilter === 'correct' ? correct : !correct && hasSelection;
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        title="CBT mock test series"
        caption="Instructions, declaration, live timer, palette, scorecard"
        action={lastResult ? (
          <div className="rounded-full bg-[var(--success-soft)] px-4 py-2 text-sm font-semibold text-[var(--success)]">
            Latest result: {lastResult.score}/{lastResult.totalMarks}
          </div>
        ) : undefined}
      />

      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        {overview.testSeries.map((test) => (
          <div key={test._id} className="rounded-[28px] border border-white/70 bg-white/92 p-5 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
            <div className="flex items-center justify-between gap-3">
              <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--accent-rust)]">
                {test.category}
              </span>
              <span className="text-sm text-[var(--ink-soft)]">{test.durationMinutes} min</span>
            </div>
            <h3 className="mt-4 text-xl font-semibold text-[var(--ink)]">{test.title}</h3>
            <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">{test.description}</p>
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl bg-[var(--accent-cream)] p-3">
                <p className="text-[var(--ink-soft)]">Marks</p>
                <p className="mt-1 font-semibold text-[var(--ink)]">{test.totalMarks}</p>
              </div>
              <div className="rounded-2xl bg-[var(--accent-cream)] p-3">
                <p className="text-[var(--ink-soft)]">Negative</p>
                <p className="mt-1 font-semibold text-[var(--danger)]">-{test.negativeMarking}</p>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {test.sectionBreakup.map((section) => (
                <span key={section.name} className="rounded-full border border-[var(--line)] px-3 py-2 text-xs text-[var(--ink-soft)]">
                  {section.name}: {section.questions}
                </span>
              ))}
            </div>
            <button
              onClick={() => setActiveTest(test)}
              data-testid={`test-open-${test._id}`}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--ink)] px-5 py-3 font-semibold text-white transition hover:bg-[var(--accent-rust)]"
            >
              Open exam instructions
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {lastResult && (
        <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
          <SectionHeader title="Scorecard" caption="Post-test analytics" />
          <div className="mt-6 grid gap-4 md:grid-cols-4">
            <MetricCard title="Score" value={`${lastResult.score}`} hint="Final score after negative marking" icon={Trophy} />
            <MetricCard
              title="Rank"
              value={lastResult.rankStatus === 'ready' && lastResult.rank !== null ? `#${lastResult.rank}` : 'Pending'}
              hint={lastResult.rankStatus === 'ready' ? 'All India style mock ranking' : 'Ranking is being finalized in the background'}
              icon={Target}
            />
            <MetricCard
              title="Percentile"
              value={lastResult.rankStatus === 'ready' && lastResult.percentile !== null ? `${lastResult.percentile}%` : 'Pending'}
              hint={lastResult.rankStatus === 'ready' ? 'Relative performance among attempts' : 'Percentile will appear once ranking completes'}
              icon={Gauge}
            />
            <MetricCard title="Accuracy band" value={`${lastResult.correctCount} correct`} hint={`${lastResult.incorrectCount} incorrect, ${lastResult.unattemptedCount} skipped`} icon={ClipboardCheck} />
          </div>
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-[24px] bg-[var(--accent-cream)] p-5">
              <p className="font-semibold text-[var(--ink)]">Weak topics</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {lastResult.weakTopics.map((topic) => (
                  <span key={topic} className="rounded-full bg-white px-3 py-2 text-sm text-[var(--danger)]">{topic}</span>
                ))}
              </div>
            </div>
            <div className="rounded-[24px] bg-[var(--accent-cream)] p-5">
              <p className="font-semibold text-[var(--ink)]">Strong topics</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {lastResult.strongTopics.map((topic) => (
                  <span key={topic} className="rounded-full bg-white px-3 py-2 text-sm text-[var(--success)]">{topic}</span>
                ))}
              </div>
            </div>
          </div>
          {lastResult.solutions.length > 0 && (
            <div className="mt-6 rounded-[24px] border border-[var(--line)] p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-lg font-semibold text-[var(--ink)]">Solutions with explanations</p>
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">Each explanation is already stored with the test and is revealed only when the learner opens it.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(['all', 'correct', 'incorrect', 'skipped'] as const).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setSolutionFilter(filter)}
                      className={cn(
                        'rounded-full px-4 py-2 text-sm font-semibold capitalize transition',
                        solutionFilter === filter
                          ? 'bg-[var(--ink)] text-white'
                          : 'bg-[var(--accent-cream)] text-[var(--ink-soft)]',
                      )}
                    >
                      {filter}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {filteredSolutions.map((solution) => {
                  const originalIndex = lastResult.solutions.findIndex((item) => item.questionId === solution.questionId);
                  return (
                    <MockSolutionCard
                      key={solution.questionId}
                      solution={solution}
                      index={originalIndex >= 0 ? originalIndex : 0}
                      open={Boolean(openSolutions[solution.questionId])}
                      onToggle={() => setOpenSolutions((current) => ({
                        ...current,
                        [solution.questionId]: !current[solution.questionId],
                      }))}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {activeTest && (
          <ExactCbtTestPlayer
            test={activeTest}
            onClose={() => setActiveTest(null)}
            onSubmitted={async (result) => {
              setLastResult(result);
              setActiveTest(null);
              await onRefresh();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

const AnalyticsTab = ({ overview }: { overview: PlatformOverview }) => {
  const { user } = useAuth();
  const [aiMessage, setAiMessage] = useState('');
  const [aiReply, setAiReply] = useState<AiResponse | null>(null);
  const [asking, setAsking] = useState(false);
  const seriesPerformance = overview.analytics.seriesPerformance || [];

  const statusTone = {
    weak: {
      badge: 'bg-[#fff1ef] text-[#d94832]',
      border: 'border-[#ffd8d2]',
      progress: 'bg-[#ef6b57]',
      panel: 'bg-[linear-gradient(180deg,#fff7f5_0%,#ffffff_100%)]',
    },
    watch: {
      badge: 'bg-[#fff7e8] text-[#bc6c00]',
      border: 'border-[#ffe1ae]',
      progress: 'bg-[#f2aa3b]',
      panel: 'bg-[linear-gradient(180deg,#fffaf0_0%,#ffffff_100%)]',
    },
    strong: {
      badge: 'bg-[#ecfbf2] text-[#16824a]',
      border: 'border-[#cbeed8]',
      progress: 'bg-[#2fb26a]',
      panel: 'bg-[linear-gradient(180deg,#f4fff8_0%,#ffffff_100%)]',
    },
  } as const;

  const weakestConcepts = useMemo(() => (
    seriesPerformance
      .flatMap((series) => series.focusConcepts.map((concept) => ({
        ...concept,
        seriesTitle: series.title,
      })))
      .sort((left, right) => {
        if (left.accuracy !== right.accuracy) {
          return left.accuracy - right.accuracy;
        }

        return right.totalQuestions - left.totalQuestions;
      })
      .slice(0, 8)
  ), [seriesPerformance]);

  const strongestConcepts = useMemo(() => (
    seriesPerformance
      .flatMap((series) => series.healthyConcepts.map((concept) => ({
        ...concept,
        seriesTitle: series.title,
      })))
      .sort((left, right) => {
        if (left.accuracy !== right.accuracy) {
          return right.accuracy - left.accuracy;
        }

        return right.totalQuestions - left.totalQuestions;
      })
      .slice(0, 6)
  ), [seriesPerformance]);

  const sendAi = async (message: string) => {
    if (!user || !message.trim()) {
      return;
    }

    setAsking(true);
    try {
      const response = await EduService.askAi(message);
      setAiReply(response);
      setAiMessage(message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div data-testid="analytics-page" className="space-y-6">
      <section data-testid="analytics-summary" className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
        <SectionHeader title="Performance analytics" caption="Real weak sections and concept gaps from linked test series" />
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard title="Accuracy" value={`${overview.analytics.accuracy}%`} hint="Across quizzes and mock test attempts" icon={Target} />
          <MetricCard title="Attempts" value={`${overview.analytics.attempts}`} hint="Practice sessions tracked in analytics" icon={ClipboardCheck} />
          <MetricCard title="Tracked series" value={`${seriesPerformance.length}`} hint="Course-linked test series with usable section analytics" icon={BookOpen} />
          <MetricCard title="Weak sections" value={`${seriesPerformance.reduce((sum, series) => sum + series.sections.filter((section) => section.status === 'weak').length, 0)}`} hint="Sections needing urgent revision" icon={AlertTriangle} />
        </div>

        <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[26px] border border-[var(--line)] bg-[linear-gradient(180deg,#fff8f4_0%,#ffffff_100%)] p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-[var(--ink)]">Weakest concepts right now</p>
                <p className="mt-1 text-sm text-[var(--ink-soft)]">Use these as the next revision order from your completed test series.</p>
              </div>
              <span className="rounded-full bg-[#fff0ea] px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#c25b2d]">
                Priority
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {weakestConcepts.length === 0 ? (
                <div className="rounded-[20px] border border-dashed border-[var(--line)] p-4 text-sm text-[var(--ink-soft)]">
                  Complete a linked mock test series to unlock section-wise and chapter-wise weakness analytics here.
                </div>
              ) : weakestConcepts.map((concept, index) => (
                <div key={`${concept.seriesTitle}-${concept.sectionName}-${concept.topic}-${index}`} className="rounded-[20px] border border-[#ffd8d2] bg-white px-4 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--ink)]">{concept.topic}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-[var(--ink-soft)]">{concept.seriesTitle} • {concept.sectionName}</p>
                      <p className="mt-2 text-sm text-[var(--ink-soft)]">{concept.pathLabel || concept.chapterTitle || concept.moduleTitle || 'Mapped from test-series topic performance'}</p>
                    </div>
                    <span className="rounded-full bg-[#fff1ef] px-3 py-2 text-sm font-semibold text-[#d94832]">
                      {concept.accuracy}%
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--ink-soft)]">
                    <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2">Correct {concept.correct}</span>
                    <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2">Wrong {concept.incorrect}</span>
                    <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2">Skipped {concept.unattempted}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-[26px] bg-[var(--card-dark)] p-5 text-white">
              <p className="text-sm font-semibold">Recommendation engine</p>
              <p className="mt-3 text-sm leading-7 text-white/75">{overview.analytics.suggestions[0] || 'Attempt one linked mock test series to unlock adaptive recommendations.'}</p>
            </div>
            <div className="rounded-[26px] border border-[var(--line)] bg-white p-5">
              <p className="text-sm font-semibold text-[var(--ink)]">Adaptive test difficulty</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2 text-sm text-[var(--ink)]">
                  Next: {overview.analytics.adaptivePlan.nextTestType}
                </span>
                <span className="rounded-full bg-[var(--accent-cream)] px-3 py-2 text-sm text-[var(--ink)]">
                  Difficulty: {overview.analytics.adaptivePlan.difficulty}
                </span>
              </div>
              <p className="mt-4 text-sm leading-7 text-[var(--ink-soft)]">{overview.analytics.adaptivePlan.reason}</p>
            </div>
            <div className="rounded-[26px] border border-[var(--line)] bg-[var(--accent-cream)] p-5">
              <p className="text-sm font-semibold text-[var(--ink)]">Strongest concepts</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {(strongestConcepts.length > 0 ? strongestConcepts : overview.analytics.strongTopics.map((topic) => ({
                  topic,
                  seriesTitle: 'Performance trend',
                  sectionName: 'Healthy area',
                  accuracy: 100,
                }))).map((concept, index) => (
                  <span key={`${concept.topic}-${index}`} className="rounded-full bg-white px-3 py-2 text-sm text-[var(--success)]">
                    {concept.topic}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section data-testid="analytics-weakness-map" className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
        <SectionHeader title="Section and chapter weakness map" caption="Built from linked test series -> section breakup -> topic performance" />
        <div className="mt-6 space-y-5">
          {seriesPerformance.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-[var(--line)] bg-[var(--accent-cream)] p-6 text-sm leading-7 text-[var(--ink-soft)]">
              No test-series analytics are available yet. Once a learner attempts linked mock tests, this area will show weak sections like GS, Reasoning, Technical and the exact chapter concepts where performance drops.
            </div>
          ) : seriesPerformance.map((series) => {
            const tone = statusTone[series.status];

            return (
              <div key={series.id} className={cn('rounded-[28px] border p-5 shadow-[0_16px_44px_rgba(15,23,42,0.05)]', tone.border, tone.panel)}>
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em]', tone.badge)}>
                        {series.status === 'weak' ? 'Needs recovery' : series.status === 'watch' ? 'Watchlist' : 'Healthy'}
                      </span>
                      {series.exam && (
                        <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">
                          {series.exam}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-3 text-2xl font-semibold text-[var(--ink)]">{series.title}</h3>
                    <p className="mt-2 text-sm leading-7 text-[var(--ink-soft)]">
                      {series.attempts} attempt{series.attempts === 1 ? '' : 's'} across {series.linkedTests} linked mock test{series.linkedTests === 1 ? '' : 's'}
                      {series.lastAttemptedAt ? ` • Last attempt ${formatDateTime(series.lastAttemptedAt)}` : ''}
                    </p>
                  </div>

                  <div className="grid shrink-0 grid-cols-2 gap-3 xl:min-w-[280px]">
                    <div className="rounded-[20px] bg-white/92 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">Overall accuracy</p>
                      <p className="mt-2 text-2xl font-bold text-[var(--ink)]">{series.overallAccuracy}%</p>
                    </div>
                    <div className="rounded-[20px] bg-white/92 p-4">
                      <p className="text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">Average score</p>
                      <p className="mt-2 text-2xl font-bold text-[var(--ink)]">{Math.round(series.averageScore)}/{Math.round(series.totalMarks)}</p>
                    </div>
                  </div>
                </div>

                <div className="mt-5 h-[10px] overflow-hidden rounded-full bg-white/80">
                  <div className={cn('h-full rounded-full', tone.progress)} style={{ width: `${Math.max(Math.min(series.overallAccuracy, 100), 0)}%` }} />
                </div>

                <div className="mt-6 grid gap-4 xl:grid-cols-3">
                  {series.sections.map((section) => {
                    const sectionTone = statusTone[section.status];

                    return (
                      <div key={`${series.id}-${section.name}`} className={cn('rounded-[22px] border bg-white/94 p-4', sectionTone.border)}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-lg font-semibold text-[var(--ink)]">{section.name}</p>
                            <p className="mt-1 text-sm text-[var(--ink-soft)]">
                              {section.correct} correct • {section.incorrect} wrong • {section.unattempted} skipped
                            </p>
                          </div>
                          <span className={cn('rounded-full px-3 py-2 text-sm font-semibold', sectionTone.badge)}>
                            {section.accuracy}%
                          </span>
                        </div>

                        <div className="mt-4 h-[8px] overflow-hidden rounded-full bg-[var(--accent-cream)]">
                          <div className={cn('h-full rounded-full', sectionTone.progress)} style={{ width: `${Math.max(Math.min(section.accuracy, 100), 0)}%` }} />
                        </div>

                        <div className="mt-4 space-y-3">
                          {section.weakConcepts.length === 0 ? (
                            <div className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]">
                              This section is stable right now.
                            </div>
                          ) : section.weakConcepts.map((concept) => (
                            <div key={`${section.name}-${concept.topic}`} className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-semibold text-[var(--ink)]">{concept.topic}</p>
                                <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', statusTone[concept.status].badge)}>
                                  {concept.accuracy}%
                                </span>
                              </div>
                              <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{concept.pathLabel || concept.chapterTitle || concept.moduleTitle || 'Linked concept from attempted questions'}</p>
                              <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--ink-soft)]">
                                <span className="rounded-full bg-white px-3 py-2">C {concept.correct}</span>
                                <span className="rounded-full bg-white px-3 py-2">W {concept.incorrect}</span>
                                <span className="rounded-full bg-white px-3 py-2">S {concept.unattempted}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section data-testid="analytics-ai-coach" className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_22px_70px_rgba(15,23,42,0.07)]">
        <SectionHeader title="AI coach" caption="Ask for a revision plan using the live analytics above" />
        <div className="mt-6 rounded-[24px] bg-[var(--accent-cream)] p-4">
          <p className="text-sm font-semibold text-[var(--ink)]">Performance trend</p>
          <div className="mt-4 h-64">
            <Suspense fallback={<DeferredPanelFallback label="analytics trend" minHeightClass="h-full min-h-0" />}>
              <LazyAnalyticsTrendChart data={overview.analytics.trend} />
            </Suspense>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {overview.ai.prompts.map((prompt) => (
            <button
              key={prompt}
              onClick={() => void sendAi(prompt)}
              className="rounded-full border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink-soft)] transition hover:border-[var(--accent-rust)]"
            >
              {prompt}
            </button>
          ))}
        </div>
        <textarea
          value={aiMessage}
          onChange={(event) => setAiMessage(event.target.value)}
          className="mt-6 h-40 w-full rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 text-sm outline-none transition focus:border-[var(--accent-rust)]"
          placeholder="Ask for a 7-day plan for GS weak areas, section-wise reasoning recovery, or a technical revision sequence."
        />
        <button
          onClick={() => void sendAi(aiMessage)}
          disabled={asking}
          className="mt-4 flex items-center gap-2 rounded-2xl bg-[var(--accent-rust)] px-5 py-3 font-semibold text-white"
        >
          {asking ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Bot className="h-5 w-5" />}
          Ask AI coach
        </button>
        {aiReply && (
          <div className="mt-6 rounded-[24px] border border-[var(--line)] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-cream)]">
                <Brain className="h-5 w-5 text-[var(--accent-rust)]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--ink)]">AI answer</p>
                <p className="text-xs uppercase tracking-[0.24em] text-[var(--ink-soft)]">{formatDateTime(aiReply.createdAt)}</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-7 text-[var(--ink-soft)]">{aiReply.answer}</p>
          </div>
        )}
      </section>
    </div>
  );
};

const AdminTab = ({ overview, onRefresh }: { overview: PlatformOverview; onRefresh: () => Promise<void> }) => {
  const getDiscountedCoursePrice = (price: number, offerPercentage: number) => {
    const safePrice = Math.max(Number(price || 0), 0);
    const safeOffer = Math.min(Math.max(Number(offerPercentage || 0), 0), 100);
    const discountedPrice = safePrice * (1 - (safeOffer / 100));
    return Math.max(Number(discountedPrice.toFixed(2)), 0);
  };
  const renderLazyAdminPanel = (content: React.ReactNode, label: string, minHeightClass = 'min-h-[260px]') => (
    <Suspense fallback={<DeferredPanelFallback label={label} minHeightClass={minHeightClass} />}>
      {content}
    </Suspense>
  );
  const [activeAdminSection, setActiveAdminSection] = useState<'overview' | 'students' | 'login-sessions' | 'payments' | 'course-access' | 'manual-review' | 'lesson-doubts' | 'reports' | 'system-health' | 'audit-logs' | 'courses' | 'curriculum' | 'assessments' | 'security'>(() => {
    if (typeof window === 'undefined') {
      return 'overview';
    }
    const saved = window.sessionStorage.getItem(ADMIN_SECTION_STORAGE_KEY);
    if (
      saved === 'overview'
      || saved === 'students'
      || saved === 'login-sessions'
      || saved === 'payments'
      || saved === 'course-access'
      || saved === 'manual-review'
      || saved === 'system-health'
      || saved === 'audit-logs'
      || saved === 'courses'
      || saved === 'curriculum'
      || saved === 'assessments'
      || saved === 'security'
    ) {
      return saved;
    }
    return 'overview';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(ADMIN_SECTION_STORAGE_KEY, activeAdminSection);
    }
  }, [activeAdminSection]);
  const [courseForm, setCourseForm] = useState({
    title: '',
    description: '',
    category: 'SSC JE',
    exam: 'SSC JE',
    subject: '',
    instructor: '',
    officialChannelUrl: '',
    price: 0,
    offerPercentage: 0,
    validityDays: 183,
    level: 'Full Course',
  });
  const [cbtForm, setCbtForm] = useState({
    title: '',
    category: 'CBT',
    type: 'cbt',
    durationMinutes: 60,
    negativeMarking: 0.25,
    topic: '',
    courseId: '',
    moduleId: '',
    chapterId: '',
    lessonId: '',
  });
  const [fullMockTestForm, setFullMockTestForm] = useState({
    title: '',
    category: 'Full Mock Test',
    type: 'full-test',
    durationMinutes: 60,
    negativeMarking: 0.25,
    topic: '',
    courseId: '',
  });
  const [cbtQuestions, setCbtQuestions] = useState<EditableAssessmentQuestion[]>(() => [createEditableAssessmentQuestion()]);
  const [fullMockQuestions, setFullMockQuestions] = useState<EditableAssessmentQuestion[]>(() => [createEditableAssessmentQuestion()]);
  const [cbtBuilderStep, setCbtBuilderStep] = useState(0);
  const [fullMockBuilderStep, setFullMockBuilderStep] = useState(0);
  const [announcementForm, setAnnouncementForm] = useState({
    title: '',
    message: '',
    targetTab: 'overview' as TabKey,
  });
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const aiProviderOptions = overview.ai.generation?.providers || [
    { id: 'auto', label: 'Auto', available: true, mode: 'fallback', description: 'Pick the best provider automatically.' },
    { id: 'mock', label: 'Local Fallback', available: true, mode: 'fallback', description: 'Generate local draft content without an external API.' },
  ];
  const defaultAiProvider = overview.ai.generation?.defaultProvider || 'auto';
  const [generatingCbt, setGeneratingCbt] = useState(false);
  const [generatingFullMock, setGeneratingFullMock] = useState(false);
  const [cbtAiForm, setCbtAiForm] = useState({
    provider: defaultAiProvider,
    subject: '',
    topic: '',
    difficulty: 'medium',
    questionCount: 20,
    durationMinutes: 60,
    instructions: '',
  });
  const [fullMockAiForm, setFullMockAiForm] = useState({
    provider: defaultAiProvider,
    subject: '',
    topic: '',
    difficulty: 'medium',
    questionCount: 20,
    durationMinutes: 60,
    instructions: '',
  });
  const [editingCbtKey, setEditingCbtKey] = useState<string | null>(null);
  const [editingFullMockId, setEditingFullMockId] = useState<string | null>(null);
  const selectedCbtCourse = overview.courses.find((course) => course._id === cbtForm.courseId) || null;
  const selectedCbtModule = selectedCbtCourse?.modules?.find((module) => module.id === cbtForm.moduleId) || null;
  const selectedCbtChapter = selectedCbtModule?.chapters?.find((chapter) => chapter.id === cbtForm.chapterId) || null;
  const selectedCbtLessons = selectedCbtChapter?.lessons || selectedCbtModule?.lessons || [];
  const selectedFullMockCourse = overview.courses.find((course) => course._id === fullMockTestForm.courseId) || null;
  const getCourseTitleById = (courseId?: string | null) =>
    overview.courses.find((course) => course._id === String(courseId || ''))?.title || null;
  const existingLessonCbts = useMemo(() => (
    overview.courses.flatMap((course) =>
      (course.modules || []).flatMap((module) => ([
        ...(module.lessons || [])
          .filter((lesson) => lesson.cbt?.questions?.length)
          .map((lesson) => ({
            key: `${course._id}:${lesson.id}`,
            courseId: course._id,
            courseTitle: course.title,
            moduleId: module.id,
            moduleTitle: module.title,
            chapterId: '',
            chapterTitle: null as string | null,
            lessonId: lesson.id,
            lessonTitle: lesson.title,
            cbt: lesson.cbt!,
          })),
        ...((module.chapters || []).flatMap((chapter) =>
          (chapter.lessons || [])
            .filter((lesson) => lesson.cbt?.questions?.length)
            .map((lesson) => ({
              key: `${course._id}:${lesson.id}`,
              courseId: course._id,
              courseTitle: course.title,
              moduleId: module.id,
              moduleTitle: module.title,
              chapterId: chapter.id,
              chapterTitle: chapter.title,
              lessonId: lesson.id,
              lessonTitle: lesson.title,
              cbt: lesson.cbt!,
            })))),
      ]))
    )
  ), [overview.courses]);
  const existingFullMockTests = useMemo(
    () => overview.testSeries.filter((test) => {
      const normalizedType = String(test.type || '').toLowerCase();
      return normalizedType.includes('full') || normalizedType.includes('mock');
    }),
    [overview.testSeries],
  );
  const unlinkedFullMockTests = useMemo(
    () => existingFullMockTests.filter((test) => !String(test.course || '').trim()),
    [existingFullMockTests],
  );

  const sendMajorAnnouncement = async () => {
    const title = announcementForm.title.trim();
    const message = announcementForm.message.trim();
    if (!title || !message) {
      setAdminMessage('Announcement title and message are required.');
      return;
    }

    setBusy(true);
    setAdminMessage(null);
    try {
      const actionUrl = `/?tab=${encodeURIComponent(announcementForm.targetTab)}`;
      const response = await EduService.sendAnnouncement({
        title,
        message,
        actionUrl,
        actionLabel: 'Open update',
        payload: { tab: announcementForm.targetTab },
      });
      setAnnouncementForm({ title: '', message: '', targetTab: 'overview' });
      setAdminMessage(`Announcement sent to ${response.notificationsSent} learner${response.notificationsSent === 1 ? '' : 's'}.`);
      await onRefresh();
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to send announcement.');
    } finally {
      setBusy(false);
    }
  };

  const createCourse = async () => {
    setBusy(true);
    try {
      await EduService.createCourse({
        ...courseForm,
        modules: [],
        thumbnailUrl: '',
      });
      setAdminMessage('Course created through the backend API.');
      await onRefresh();
      setCourseForm({
        title: '',
        description: '',
        category: 'SSC JE',
        exam: 'SSC JE',
        subject: '',
        instructor: '',
        officialChannelUrl: '',
        price: 0,
        offerPercentage: 0,
        validityDays: 183,
        level: 'Full Course',
      });
    } finally {
      setBusy(false);
    }
  };

  const parseAssessmentQuestions = (questions: EditableAssessmentQuestion[]) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('Add at least one real question before saving.');
    }

    return questions.map((question, index) => {
      const options = Array.isArray(question?.options)
        ? question.options.map((item: unknown) => String(item || '').trim()).filter(Boolean)
        : [];
      const correctOptions = normalizeOptionIndexes(question?.correctOptions);
      const marks = Number(question?.marks || 1);
      const questionText = String(question?.questionText || '').trim();
      const topic = String(question?.topic || '').trim();

      const hasValidCorrectOptions = correctOptions.length > 0 && correctOptions.every((correctOption) => correctOption >= 0 && correctOption < options.length);

      if (!questionText || options.length < 2 || !hasValidCorrectOptions || !topic) {
        throw new Error(`Question ${index + 1} must include questionText, at least two options, one or more valid correct options, and a topic.`);
      }

      return {
        id: String(question?.id || `question_${Date.now()}_${index + 1}`),
        questionText,
        options,
        correctOption: correctOptions[0],
        correctOptions,
        explanation: String(question?.explanation || '').trim(),
        marks: Number.isFinite(marks) && marks > 0 ? marks : 1,
        topic,
      };
    });
  };

  const clampBuilderStep = (value: number) => Math.max(0, Math.min(builderSteps.length - 1, value));

  const resetCbtForm = () => {
    setCbtForm({
      title: '',
      category: 'CBT',
      type: 'cbt',
      durationMinutes: 60,
      negativeMarking: 0.25,
      topic: '',
      courseId: '',
      moduleId: '',
      chapterId: '',
      lessonId: '',
    });
    setCbtQuestions([createEditableAssessmentQuestion()]);
    setCbtBuilderStep(0);
    setEditingCbtKey(null);
  };

  const resetFullMockForm = () => {
    setFullMockTestForm({
      title: '',
      category: 'Full Mock Test',
      type: 'full-test',
      durationMinutes: 60,
      negativeMarking: 0.25,
      topic: '',
      courseId: '',
    });
    setFullMockQuestions([createEditableAssessmentQuestion()]);
    setFullMockBuilderStep(0);
    setEditingFullMockId(null);
  };

  const createLessonCbt = async () => {
    setBusy(true);
    try {
      const questions = parseAssessmentQuestions(cbtQuestions);

      if (!cbtForm.courseId || !cbtForm.moduleId || !cbtForm.lessonId) {
        throw new Error('Select the course, subject, chapter if needed, and lesson where this CBT should appear.');
      }

      await EduService.attachLessonCbt(cbtForm.courseId, cbtForm.moduleId, cbtForm.lessonId, {
        chapterId: cbtForm.chapterId || null,
        title: cbtForm.title,
        durationMinutes: cbtForm.durationMinutes,
        negativeMarking: cbtForm.negativeMarking,
        questions,
      });
      setAdminMessage(editingCbtKey ? 'Lesson CBT updated successfully.' : 'Lesson CBT attached to the selected course lesson.');
      await onRefresh();
      resetCbtForm();
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to attach lesson CBT.');
    } finally {
      setBusy(false);
    }
  };

  const createFullLengthMockTest = async () => {
    setBusy(true);
    try {
      if (!fullMockTestForm.courseId) {
        throw new Error('Link this mock test to a course before publishing it. Only learners enrolled in that course will be able to access it.');
      }

      const questions = parseAssessmentQuestions(fullMockQuestions);
      const sectionMap = new Map<string, number>();
      let totalMarks = 0;
      questions.forEach((question) => {
        sectionMap.set(question.topic, (sectionMap.get(question.topic) || 0) + 1);
        totalMarks += Number(question.marks || 0);
      });

      const payload = {
        title: fullMockTestForm.title,
        description: fullMockTestForm.topic ? `${fullMockTestForm.topic} full-length mock test` : 'Full-length mock test',
        category: fullMockTestForm.category,
        course: fullMockTestForm.courseId || undefined,
        type: 'full-test',
        durationMinutes: fullMockTestForm.durationMinutes,
        negativeMarking: fullMockTestForm.negativeMarking,
        totalMarks,
        sectionBreakup: Array.from(sectionMap.entries()).map(([name, count]) => ({ name, questions: count })),
        questions,
      };

      if (editingFullMockId) {
        await EduService.updateMockTest(editingFullMockId, payload);
      } else {
        await EduService.createMockTest(payload);
      }

      setAdminMessage(editingFullMockId ? 'Full-length mock test updated successfully.' : 'Full-length mock test created successfully.');
      await onRefresh();
      resetFullMockForm();
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to create full-length mock test.');
    } finally {
      setBusy(false);
    }
  };

  const loadCbtForEdit = (entry: (typeof existingLessonCbts)[number]) => {
    setEditingCbtKey(entry.key);
    setCbtForm({
      title: entry.cbt.title || `${entry.lessonTitle} CBT`,
      category: 'CBT',
      type: 'cbt',
      durationMinutes: entry.cbt.durationMinutes || 60,
      negativeMarking: entry.cbt.negativeMarking ?? 0.25,
      topic: entry.cbt.questions?.[0]?.topic || '',
      courseId: entry.courseId,
      moduleId: entry.moduleId,
      chapterId: entry.chapterId || '',
      lessonId: entry.lessonId,
    });
    setCbtQuestions(toEditableAssessmentQuestions(entry.cbt.questions || []));
    setCbtBuilderStep(builderSteps.length - 1);
  };

  const deleteCbt = async (entry: (typeof existingLessonCbts)[number]) => {
    setBusy(true);
    try {
      await EduService.deleteLessonCbt(entry.courseId, entry.moduleId, entry.lessonId, {
        chapterId: entry.chapterId || null,
      });
      setAdminMessage('Lesson CBT deleted successfully.');
      await onRefresh();
      if (editingCbtKey === entry.key) {
        resetCbtForm();
      }
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to delete lesson CBT.');
    } finally {
      setBusy(false);
    }
  };

  const loadFullMockForEdit = (test: MockTest) => {
    setEditingFullMockId(test._id);
    setFullMockTestForm({
      title: test.title,
      category: test.category || 'Full Mock Test',
      type: 'full-test',
      durationMinutes: test.durationMinutes || 60,
      negativeMarking: test.negativeMarking ?? 0.25,
      topic: test.sectionBreakup?.[0]?.name || '',
      courseId: test.course || '',
    });
    setFullMockQuestions(toEditableAssessmentQuestions(test.questions || []));
    setFullMockBuilderStep(builderSteps.length - 1);
  };

  const deleteFullMock = async (testId: string) => {
    setBusy(true);
    try {
      await EduService.deleteMockTest(testId);
      setAdminMessage('Full-length mock test deleted successfully.');
      await onRefresh();
      if (editingFullMockId === testId) {
        resetFullMockForm();
      }
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to delete full-length mock test.');
    } finally {
      setBusy(false);
    }
  };

  const generateCbtDraft = async () => {
    setGeneratingCbt(true);
    setAdminMessage(null);
    try {
      const generated = await EduService.generateAssessmentDraft({
        provider: cbtAiForm.provider,
        contentType: 'mock-test',
        exam: cbtForm.category,
        subject: cbtAiForm.subject,
        topic: cbtAiForm.topic || cbtForm.topic,
        title: cbtForm.title,
        type: cbtForm.type,
        difficulty: cbtAiForm.difficulty,
        questionCount: cbtAiForm.questionCount,
        durationMinutes: cbtAiForm.durationMinutes,
        negativeMarking: cbtForm.negativeMarking,
        instructions: cbtAiForm.instructions,
      });

      if (!generated.mockTest) {
        throw new Error('CBT draft was not returned by the AI generator.');
      }

      setCbtForm((current) => ({
        ...current,
        title: generated.mockTest?.title || current.title,
        category: current.category,
        type: current.type,
        durationMinutes: generated.mockTest?.durationMinutes || current.durationMinutes,
        negativeMarking: generated.mockTest?.negativeMarking ?? current.negativeMarking,
        topic: generated.mockTest?.sectionBreakup?.[0]?.name || cbtAiForm.topic || current.topic,
      }));
      setCbtQuestions(toEditableAssessmentQuestions(generated.mockTest.questions || []));
      setCbtBuilderStep(2);
      setAdminMessage(`${generated.message} The CBT draft is loaded below for review.`);
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to generate CBT draft.');
    } finally {
      setGeneratingCbt(false);
    }
  };

  const generateFullMockTestDraft = async () => {
    setGeneratingFullMock(true);
    setAdminMessage(null);
    try {
      const generated = await EduService.generateAssessmentDraft({
        provider: fullMockAiForm.provider,
        contentType: 'mock-test',
        exam: fullMockTestForm.category,
        subject: fullMockAiForm.subject,
        topic: fullMockAiForm.topic || fullMockTestForm.topic,
        title: fullMockTestForm.title,
        type: fullMockTestForm.type,
        difficulty: fullMockAiForm.difficulty,
        questionCount: fullMockAiForm.questionCount,
        durationMinutes: fullMockAiForm.durationMinutes,
        negativeMarking: fullMockTestForm.negativeMarking,
        instructions: fullMockAiForm.instructions,
      });

      if (!generated.mockTest) {
        throw new Error('Full-length mock test draft was not returned by the AI generator.');
      }

      setFullMockTestForm((current) => ({
        ...current,
        title: generated.mockTest?.title || current.title,
        category: generated.mockTest?.category || current.category,
        type: 'full-test',
        durationMinutes: generated.mockTest?.durationMinutes || current.durationMinutes,
        negativeMarking: generated.mockTest?.negativeMarking ?? current.negativeMarking,
        topic: generated.mockTest?.sectionBreakup?.[0]?.name || fullMockAiForm.topic || current.topic,
      }));
      setFullMockQuestions(toEditableAssessmentQuestions(generated.mockTest.questions || []));
      setFullMockBuilderStep(2);
      setAdminMessage(`${generated.message} The full-length mock test draft is loaded below for review.`);
    } catch (error) {
      setAdminMessage(error instanceof Error ? error.message : 'Unable to generate full-length mock test draft.');
    } finally {
      setGeneratingFullMock(false);
    }
  };

  const cbtReviewPath = [
    selectedCbtCourse?.title,
    selectedCbtModule?.title,
    selectedCbtChapter?.title,
    selectedCbtLessons.find((lesson) => lesson.id === cbtForm.lessonId)?.title,
  ].filter(Boolean).join(' • ');

  const fullMockReviewPath = selectedFullMockCourse
    ? `${selectedFullMockCourse.title} • ${fullMockTestForm.title || 'New mock test'}`
    : 'Choose parent course';

  const renderBuilderSectionCard = ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle: string;
    children: React.ReactNode;
  }) => (
    <div className="rounded-[24px] border border-[var(--line)] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <p className="text-lg font-semibold text-[var(--ink)]">{title}</p>
      <p className="mt-1 text-sm leading-6 text-[var(--ink-soft)]">{subtitle}</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {children}
      </div>
    </div>
  );

  const renderBuilderFooter = ({
    step,
    onStepChange,
    onReset,
    onSubmit,
    submitLabel,
    cancelEditLabel,
    showCancelEdit,
  }: {
    step: number;
    onStepChange: (value: number) => void;
    onReset: () => void;
    onSubmit: () => void;
    submitLabel: string;
    cancelEditLabel: string;
    showCancelEdit: boolean;
  }) => (
    <div className="flex flex-col gap-3 rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)] p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-[var(--ink-soft)]">
        Step {step + 1} of {builderSteps.length}: <span className="font-semibold text-[var(--ink)]">{builderSteps[step]}</span>
      </div>
      <div className="flex flex-wrap gap-3">
        {showCancelEdit && (
          <button onClick={onReset} disabled={busy} className="rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)]">
            {cancelEditLabel}
          </button>
        )}
        {step > 0 && (
          <button
            type="button"
            onClick={() => onStepChange(step - 1)}
            className="inline-flex items-center gap-2 rounded-2xl border border-[var(--line)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)]"
          >
            <ChevronLeft className="h-4 w-4" />
            Back
          </button>
        )}
        {step < builderSteps.length - 1 ? (
          <button
            type="button"
            onClick={() => onStepChange(step + 1)}
            className="inline-flex items-center gap-2 rounded-2xl bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white"
          >
            Next Step
            <ArrowRight className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="rounded-2xl bg-[var(--ink)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
          >
            {submitLabel}
          </button>
        )}
      </div>
    </div>
  );

  const renderCbtBuilderContent = () => {
    switch (cbtBuilderStep) {
      case 0:
        return renderBuilderSectionCard({
          title: 'Basic CBT information',
          subtitle: 'Set the assessment identity first so the preview and AI draft stay aligned.',
          children: (
            <>
              <input value={cbtForm.title} onChange={(event) => setCbtForm((current) => ({ ...current, title: event.target.value }))} placeholder="CBT title" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input value={cbtForm.topic} onChange={(event) => setCbtForm((current) => ({ ...current, topic: event.target.value }))} placeholder="Topic / section" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input value={cbtForm.category} onChange={(event) => setCbtForm((current) => ({ ...current, category: event.target.value }))} placeholder="Category" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input value={cbtForm.type} disabled className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none opacity-70" />
              <input type="number" value={cbtForm.durationMinutes} onChange={(event) => setCbtForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} placeholder="Duration" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input type="number" step="0.01" value={cbtForm.negativeMarking} onChange={(event) => setCbtForm((current) => ({ ...current, negativeMarking: Number(event.target.value) }))} placeholder="Negative marking" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
            </>
          ),
        });
      case 1:
        return renderBuilderSectionCard({
          title: 'Attach CBT to the lesson path',
          subtitle: 'Choose the exact course, subject, optional chapter, and lesson where this CBT should appear.',
          children: (
            <>
              <select
                value={cbtForm.courseId}
                onChange={(event) => setCbtForm((current) => ({ ...current, courseId: event.target.value, moduleId: '', chapterId: '', lessonId: '' }))}
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
              >
                <option value="">Select course</option>
                {overview.courses.map((course) => <option key={course._id} value={course._id}>{course.title}</option>)}
              </select>
              <select
                value={cbtForm.moduleId}
                onChange={(event) => setCbtForm((current) => ({ ...current, moduleId: event.target.value, chapterId: '', lessonId: '' }))}
                disabled={!selectedCbtCourse}
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none disabled:opacity-60"
              >
                <option value="">Select subject</option>
                {(selectedCbtCourse?.modules || []).map((module) => <option key={module.id} value={module.id}>{module.title}</option>)}
              </select>
              <select
                value={cbtForm.chapterId}
                onChange={(event) => setCbtForm((current) => ({ ...current, chapterId: event.target.value, lessonId: '' }))}
                disabled={!selectedCbtModule}
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none disabled:opacity-60"
              >
                <option value="">Direct subject lessons</option>
                {(selectedCbtModule?.chapters || []).map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
              </select>
              <select
                value={cbtForm.lessonId}
                onChange={(event) => setCbtForm((current) => ({ ...current, lessonId: event.target.value }))}
                disabled={!selectedCbtModule}
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none disabled:opacity-60"
              >
                <option value="">Select lesson</option>
                {selectedCbtLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.title}</option>)}
              </select>
            </>
          ),
        });
      case 2:
        return (
          <div className="space-y-5">
            {renderBuilderSectionCard({
              title: 'Optional AI draft',
              subtitle: 'Generate a first pass if you want a head start, then keep editing manually below.',
              children: (
                <>
                  <select
                    value={cbtAiForm.provider}
                    onChange={(event) => setCbtAiForm((current) => ({ ...current, provider: event.target.value }))}
                    className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
                  >
                    {aiProviderOptions.map((provider) => (
                      <option key={provider.id} value={provider.id} disabled={!provider.available && provider.id !== 'auto'}>
                        {provider.label} {provider.available ? '' : '(Not configured)'}
                      </option>
                    ))}
                  </select>
                  <input value={cbtAiForm.subject} onChange={(event) => setCbtAiForm((current) => ({ ...current, subject: event.target.value }))} placeholder="AI subject" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <input value={cbtAiForm.topic} onChange={(event) => setCbtAiForm((current) => ({ ...current, topic: event.target.value }))} placeholder="AI topic focus" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <select value={cbtAiForm.difficulty} onChange={(event) => setCbtAiForm((current) => ({ ...current, difficulty: event.target.value }))} className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none">
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                  <input type="number" value={cbtAiForm.questionCount} onChange={(event) => setCbtAiForm((current) => ({ ...current, questionCount: Number(event.target.value) }))} placeholder="AI question count" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <input type="number" value={cbtAiForm.durationMinutes} onChange={(event) => setCbtAiForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} placeholder="AI duration" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <textarea
                    value={cbtAiForm.instructions}
                    onChange={(event) => setCbtAiForm((current) => ({ ...current, instructions: event.target.value }))}
                    placeholder="Optional AI instructions: exam style, chapter mix, calculation-heavy, difficulty balance."
                    className="md:col-span-2 h-24 rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
                  />
                  <div className="md:col-span-2">
                    <button onClick={() => void generateCbtDraft()} disabled={generatingCbt} className="rounded-2xl border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">
                      {generatingCbt ? 'Generating draft...' : 'Generate AI draft'}
                    </button>
                  </div>
                </>
              ),
            })}
            <AssessmentQuestionBuilder
              title="Manual CBT Builder"
              caption="Create your own questions, options, answers, marks, and explanations without touching JSON."
              questions={cbtQuestions}
              onChange={setCbtQuestions}
            />
          </div>
        );
      case 3:
      default:
        return (
          <div className="rounded-[24px] border border-[var(--line)] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
            <p className="text-lg font-semibold text-[var(--ink)]">Review lesson targeting</p>
            <p className="mt-1 text-sm leading-6 text-[var(--ink-soft)]">Confirm where this CBT will show up in the student journey before publishing it.</p>
            <div className="mt-5 grid gap-3">
              {[
                ['Course path', cbtReviewPath || '--'],
                ['Question count', `${cbtQuestions.length}`],
                ['Total marks', `${cbtQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0)}`],
                ['Duration', `${cbtForm.durationMinutes || 0} min`],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3">
                  <span className="text-sm text-[var(--ink-soft)]">{label}</span>
                  <span className="text-sm font-semibold text-[var(--ink)]">{value}</span>
                </div>
              ))}
            </div>
          </div>
        );
    }
  };

  const renderFullMockBuilderContent = () => {
    switch (fullMockBuilderStep) {
      case 0:
        return renderBuilderSectionCard({
          title: 'Choose parent course and mock basics',
          subtitle: 'Start by choosing the course this mock belongs to. Example: choose SSC, then create SSC Mock Test 1, SSC Mock Test 2, and so on under that same course.',
          children: (
            <>
              <select
                value={fullMockTestForm.courseId}
                onChange={(event) => setFullMockTestForm((current) => ({ ...current, courseId: event.target.value }))}
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
              >
                <option value="">Select parent course</option>
                {overview.courses.map((course) => <option key={course._id} value={course._id}>{course.title}</option>)}
              </select>
              <input value={fullMockTestForm.title} onChange={(event) => setFullMockTestForm((current) => ({ ...current, title: event.target.value }))} placeholder="Mock test title" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input value={fullMockTestForm.topic} onChange={(event) => setFullMockTestForm((current) => ({ ...current, topic: event.target.value }))} placeholder="Topic / section mix" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input value={fullMockTestForm.category} onChange={(event) => setFullMockTestForm((current) => ({ ...current, category: event.target.value }))} placeholder="Category" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input
                value={selectedFullMockCourse ? `${selectedFullMockCourse.title} -> ${fullMockTestForm.title || 'Mock Test 1'}` : ''}
                readOnly
                placeholder="Example: SSC -> SSC Mock Test 1"
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none opacity-70"
              />
              <input type="number" value={fullMockTestForm.durationMinutes} onChange={(event) => setFullMockTestForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} placeholder="Duration" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              <input type="number" step="0.01" value={fullMockTestForm.negativeMarking} onChange={(event) => setFullMockTestForm((current) => ({ ...current, negativeMarking: Number(event.target.value) }))} placeholder="Negative marking" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
            </>
          ),
        });
      case 1:
        return renderBuilderSectionCard({
          title: 'Confirm parent course access',
          subtitle: 'This course link controls access. Only students who bought the selected course will be able to see and attempt these mock tests.',
          children: (
            <>
              <select
                value={fullMockTestForm.courseId}
                onChange={(event) => setFullMockTestForm((current) => ({ ...current, courseId: event.target.value }))}
                className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
              >
                <option value="">Select parent course</option>
                {overview.courses.map((course) => <option key={course._id} value={course._id}>{course.title}</option>)}
              </select>
              <div className="rounded-[20px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 text-sm leading-6 text-[var(--ink-soft)]">
                {selectedFullMockCourse
                  ? `These mocks now belong under ${selectedFullMockCourse.title}. Create titles like ${selectedFullMockCourse.title} Mock Test 1, ${selectedFullMockCourse.title} Mock Test 2, and only learners enrolled in ${selectedFullMockCourse.title} will be able to open, attempt, and watch the companion video for them.`
                  : 'Choose a parent course. Full mock tests are course-locked and should be created under the exact course students need to buy first.'}
              </div>
            </>
          ),
        });
      case 2:
        return (
          <div className="space-y-5">
            {renderBuilderSectionCard({
              title: 'Optional AI draft',
              subtitle: 'Use AI for a first draft, then tune the questions manually before publishing.',
              children: (
                <>
                  <select
                    value={fullMockAiForm.provider}
                    onChange={(event) => setFullMockAiForm((current) => ({ ...current, provider: event.target.value }))}
                    className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
                  >
                    {aiProviderOptions.map((provider) => (
                      <option key={provider.id} value={provider.id} disabled={!provider.available && provider.id !== 'auto'}>
                        {provider.label} {provider.available ? '' : '(Not configured)'}
                      </option>
                    ))}
                  </select>
                  <input value={fullMockAiForm.subject} onChange={(event) => setFullMockAiForm((current) => ({ ...current, subject: event.target.value }))} placeholder="AI subject" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <input value={fullMockAiForm.topic} onChange={(event) => setFullMockAiForm((current) => ({ ...current, topic: event.target.value }))} placeholder="AI topic focus" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <select value={fullMockAiForm.difficulty} onChange={(event) => setFullMockAiForm((current) => ({ ...current, difficulty: event.target.value }))} className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none">
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                  <input type="number" value={fullMockAiForm.questionCount} onChange={(event) => setFullMockAiForm((current) => ({ ...current, questionCount: Number(event.target.value) }))} placeholder="AI question count" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <input type="number" value={fullMockAiForm.durationMinutes} onChange={(event) => setFullMockAiForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} placeholder="AI duration" className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                  <textarea
                    value={fullMockAiForm.instructions}
                    onChange={(event) => setFullMockAiForm((current) => ({ ...current, instructions: event.target.value }))}
                    placeholder="Optional AI instructions: exam coverage, section balance, difficulty spread, time pressure."
                    className="md:col-span-2 h-24 rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none"
                  />
                  <div className="md:col-span-2">
                    <button onClick={() => void generateFullMockTestDraft()} disabled={generatingFullMock} className="rounded-2xl border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">
                      {generatingFullMock ? 'Generating draft...' : 'Generate AI draft'}
                    </button>
                  </div>
                </>
              ),
            })}
            <AssessmentQuestionBuilder
              title="Manual Mock Test Builder"
              caption="Build full-length mock tests question by question with a proper authoring UI."
              questions={fullMockQuestions}
              onChange={setFullMockQuestions}
            />
          </div>
        );
      case 3:
      default:
        return (
          <div className="rounded-[24px] border border-[var(--line)] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
            <p className="text-lg font-semibold text-[var(--ink)]">Review mock test placement</p>
            <p className="mt-1 text-sm leading-6 text-[var(--ink-soft)]">Confirm the audience, scale, and scoring before the test goes live.</p>
            <div className="mt-5 grid gap-3">
              {[
                ['Visibility', fullMockReviewPath],
                ['Question count', `${fullMockQuestions.length}`],
                ['Total marks', `${fullMockQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0)}`],
                ['Duration', `${fullMockTestForm.durationMinutes || 0} min`],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 rounded-[16px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3">
                  <span className="text-sm text-[var(--ink-soft)]">{label}</span>
                  <span className="text-sm font-semibold text-[var(--ink)]">{value}</span>
                </div>
              ))}
            </div>
          </div>
        );
    }
  };

  const adminSections: Array<{
    id: 'overview' | 'students' | 'login-sessions' | 'payments' | 'course-access' | 'manual-review' | 'lesson-doubts' | 'reports' | 'system-health' | 'audit-logs' | 'courses' | 'curriculum' | 'assessments' | 'security';
    label: string;
    caption: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'overview', label: 'Overview', caption: 'Health, students, and payment readiness', icon: LayoutDashboard },
    { id: 'courses', label: 'Courses', caption: 'Create courses and manage catalog', icon: BookOpen },
    { id: 'curriculum', label: 'Curriculum', caption: 'Subjects, lectures, and video uploads', icon: GraduationCap },
    { id: 'assessments', label: 'Assessments', caption: 'CBT, mock tests, and mock-test video upload', icon: ClipboardCheck },
    { id: 'students', label: 'Students', caption: 'Profiles and admin account controls', icon: UserCircle2 },
    { id: 'login-sessions', label: 'Login Sessions', caption: 'Logged-in students and device activity', icon: ShieldCheck },
    { id: 'payments', label: 'Payments', caption: 'Razorpay sync and transaction status', icon: Wallet },
    { id: 'course-access', label: 'Course Access', caption: 'Enrollment and validity controls', icon: BookOpen },
    { id: 'manual-review', label: 'Manual Review', caption: 'Unsafe payment mismatches', icon: AlertTriangle },
    { id: 'lesson-doubts', label: 'Lesson Doubts', caption: 'Student questions from lessons', icon: MessageSquare },
    { id: 'reports', label: 'Video Reports', caption: 'Learner issue reports from the player', icon: AlertTriangle },
    { id: 'security', label: 'Security', caption: 'Recent device activity and security events', icon: Activity },
    { id: 'system-health', label: 'System Health', caption: 'Backend and DB visibility', icon: Activity },
    { id: 'audit-logs', label: 'Audit Logs', caption: 'Admin action history', icon: ClipboardCheck },
  ];

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[34px] border border-white/70 bg-[radial-gradient(circle_at_top_left,rgba(22,152,212,0.18),transparent_24%),radial-gradient(circle_at_bottom_right,rgba(255,186,73,0.16),transparent_22%),linear-gradient(135deg,#0f1d33_0%,#17385d_48%,#195f7f_100%)] p-6 text-white shadow-[0_26px_80px_rgba(15,23,42,0.22)] sm:p-8">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/58">Admin workspace</p>
            <h2 className="mt-4 text-3xl font-semibold sm:text-[2.6rem]">Operate the platform in focused lanes instead of one long page.</h2>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-white/74 sm:text-base">
              Courses, curriculum, assessments, and device security now live in separate tabs so admins can switch context fast without losing the current workflow.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:min-w-[360px]">
            <div className="rounded-[24px] border border-white/12 bg-white/10 p-4 backdrop-blur">
              <p className="text-xs uppercase tracking-[0.16em] text-white/58">Active users</p>
              <p className="mt-2 text-3xl font-semibold">{overview.adminOverview?.activeUsers || 0}</p>
              <p className="mt-2 text-sm text-white/68">Registered and available on the platform right now.</p>
            </div>
            <div className="rounded-[24px] border border-white/12 bg-white/10 p-4 backdrop-blur">
              <p className="text-xs uppercase tracking-[0.16em] text-white/58">Revenue</p>
              <p className="mt-2 text-3xl font-semibold">{currency.format(overview.adminOverview?.revenue || 0)}</p>
              <p className="mt-2 text-sm text-white/68">Paid collections flowing through the secured backend.</p>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          {adminSections.map(({ id, label, caption, icon: Icon }) => (
            <button
              key={id}
              type="button"
              data-testid={`admin-section-${id}`}
              onClick={() => setActiveAdminSection(id)}
              className={cn(
                'rounded-[22px] border px-4 py-4 text-left transition',
                activeAdminSection === id
                  ? 'border-white/30 bg-white text-[#10253c] shadow-[0_18px_40px_rgba(12,18,28,0.18)]'
                  : 'border-white/12 bg-white/8 text-white hover:bg-white/12',
              )}
            >
              <div className="flex items-center gap-3">
                <div className={cn(
                  'flex h-11 w-11 items-center justify-center rounded-2xl',
                  activeAdminSection === id ? 'bg-[var(--accent-cream)] text-[var(--accent-rust)]' : 'bg-white/12 text-white',
                )}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{label}</p>
                  <p className={cn('mt-1 text-xs', activeAdminSection === id ? 'text-[#607089]' : 'text-white/64')}>{caption}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {adminMessage && (
        <div className="rounded-[24px] border border-[var(--success)]/18 bg-[var(--success-soft)] px-5 py-4 text-sm text-[var(--success)]">
          {adminMessage}
        </div>
      )}

      {activeAdminSection === 'overview' && (
        <div data-testid="admin-overview-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="overview" courses={overview.courses || []} />,
            'admin overview',
          )}
        </div>
      )}

      {activeAdminSection === 'courses' && (
        <div className="space-y-6">
          <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
            <SectionHeader title="Create course" caption="Catalog, pricing, and publishing baseline" />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Course Title</span>
                <input value={courseForm.title} onChange={(event) => setCourseForm((current) => ({ ...current, title: event.target.value }))} placeholder="e.g. SSC JE Complete Batch 2026" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Subject</span>
                <input value={courseForm.subject} onChange={(event) => setCourseForm((current) => ({ ...current, subject: event.target.value }))} placeholder="e.g. Civil Engineering" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Instructor</span>
                <input value={courseForm.instructor} onChange={(event) => setCourseForm((current) => ({ ...current, instructor: event.target.value }))} placeholder="Teacher name shown to students" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Official Channel URL</span>
                <input value={courseForm.officialChannelUrl} onChange={(event) => setCourseForm((current) => ({ ...current, officialChannelUrl: event.target.value }))} placeholder="Optional YouTube or website link" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Course Fee (INR)</span>
                <input type="number" min="0" value={courseForm.price} onChange={(event) => setCourseForm((current) => ({ ...current, price: Number(event.target.value) }))} placeholder="Use 0 for a free course" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
                <span className="block text-xs text-[var(--ink-soft)]">Set `0` if students should access the course for free.</span>
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Offer Percentage</span>
                <input type="number" min="0" max="100" value={courseForm.offerPercentage} onChange={(event) => setCourseForm((current) => ({ ...current, offerPercentage: Number(event.target.value) }))} placeholder="Discount shown on paid courses" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Exam</span>
                <input value={courseForm.exam} onChange={(event) => setCourseForm((current) => ({ ...current, exam: event.target.value }))} placeholder="e.g. SSC JE, RRB JE" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Category</span>
                <input value={courseForm.category} onChange={(event) => setCourseForm((current) => ({ ...current, category: event.target.value }))} placeholder="e.g. Full course, crash course" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Level</span>
                <input value={courseForm.level} onChange={(event) => setCourseForm((current) => ({ ...current, level: event.target.value }))} placeholder="e.g. Beginner, Advanced, Full Course" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Validity (Days)</span>
                <input type="number" min="1" value={courseForm.validityDays} onChange={(event) => setCourseForm((current) => ({ ...current, validityDays: Number(event.target.value) }))} placeholder="How many days the course stays active after purchase" className="w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <label className="space-y-2 md:col-span-2">
                <span className="block text-sm font-semibold text-[var(--ink)]">Course Description</span>
                <textarea value={courseForm.description} onChange={(event) => setCourseForm((current) => ({ ...current, description: event.target.value }))} placeholder="Write what the learner will study in this course." className="h-32 w-full rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 outline-none" />
              </label>
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-4 text-sm text-[var(--ink-soft)] md:col-span-2">
                Learner payable price: <span className="font-semibold text-[var(--ink)]">{courseForm.price === 0 ? 'Free' : currency.format(getDiscountedCoursePrice(courseForm.price, courseForm.offerPercentage))}</span>
              </div>
              <div className="md:col-span-2">
                <button onClick={() => void createCourse()} disabled={busy} className="rounded-2xl bg-[var(--ink)] px-5 py-4 font-semibold text-white">
                  Create course
                </button>
              </div>
            </div>
          </section>

          {renderLazyAdminPanel(
            <LazyAdminCourseManager courses={overview.courses || []} onCoursesChanged={onRefresh} />,
            'course manager',
            'min-h-[320px]',
          )}
        </div>
      )}

      {activeAdminSection === 'students' && (
        <div data-testid="admin-students-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="students" courses={overview.courses || []} />,
            'student operations',
          )}
        </div>
      )}

      {activeAdminSection === 'login-sessions' && (
        <div data-testid="admin-login-sessions-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="login-sessions" courses={overview.courses || []} />,
            'login sessions',
          )}
        </div>
      )}

      {activeAdminSection === 'payments' && (
        <div data-testid="admin-payments-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="payments" courses={overview.courses || []} />,
            'payments',
          )}
        </div>
      )}

      {activeAdminSection === 'course-access' && (
        <div data-testid="admin-course-access-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="course-access" courses={overview.courses || []} />,
            'course access',
          )}
        </div>
      )}

      {activeAdminSection === 'manual-review' && (
        <div data-testid="admin-manual-review-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="manual-review" courses={overview.courses || []} />,
            'manual review',
          )}
        </div>
      )}

      {activeAdminSection === 'lesson-doubts' && (
        <div data-testid="admin-lesson-doubts-loaded">
          {renderLazyAdminPanel(
            <LazyAdminSupportCenter section="lesson-doubts" />,
            'lesson doubts',
          )}
        </div>
      )}

      {activeAdminSection === 'reports' && (
        <div data-testid="admin-reports-loaded">
          {renderLazyAdminPanel(
            <LazyAdminSupportCenter section="reports" />,
            'lesson reports',
          )}
        </div>
      )}

      {activeAdminSection === 'system-health' && (
        <div data-testid="admin-system-health-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="system-health" courses={overview.courses || []} />,
            'system health',
          )}
        </div>
      )}

      {activeAdminSection === 'audit-logs' && (
        <div data-testid="admin-audit-logs-loaded">
          {renderLazyAdminPanel(
            <LazyAdminPaymentControlCenter section="audit-logs" courses={overview.courses || []} />,
            'audit logs',
          )}
        </div>
      )}

      {activeAdminSection === 'curriculum' && (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
            <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
              <SectionHeader title="Curriculum flow" caption="Build in this order" />
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                {[
                  ['1', 'Create course', 'Define the catalog shell, pricing, and instructor details first.'],
                  ['2', 'Add subject tree', 'Build subject and chapter structure before you attach content.'],
                  ['3', 'Upload protected video', 'Attach topic videos into the exact subject or chapter path.'],
                ].map(([step, title, text]) => (
                  <div key={step} className="rounded-[22px] bg-[var(--accent-cream)] p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">Step {step}</p>
                    <p className="mt-2 text-lg font-semibold text-[var(--ink)]">{title}</p>
                    <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{text}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
              <SectionHeader title="Content estate" caption="Current platform size" />
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <MetricCard title="Courses" value={`${overview.courses.length}`} hint="Catalog entries now live" icon={BookOpen} />
                <MetricCard title="Subjects" value={`${overview.courses.reduce((sum, course) => sum + (course.modules?.length || 0), 0)}`} hint="Subject nodes across all courses" icon={GraduationCap} />
                <MetricCard title="Topics" value={`${overview.courses.reduce((sum, course) => sum + ((course.lessonCount || 0) || 0), 0)}`} hint="Lesson topics available to learners" icon={Video} />
              </div>
            </section>
          </div>

          {renderLazyAdminPanel(
            <LazyAdminModuleManager courses={overview.courses || []} onModulesChanged={onRefresh} />,
            'curriculum manager',
            'min-h-[320px]',
          )}
          {renderLazyAdminPanel(
            <LazyAdminPdfUpload courses={overview.courses || []} onPdfUploaded={onRefresh} />,
            'pdf uploads',
            'min-h-[280px]',
          )}
          {renderLazyAdminPanel(
            <LazyAdminVideoUpload courses={overview.courses || []} onVideoUploaded={onRefresh} />,
            'video uploads',
            'min-h-[280px]',
          )}
          {renderLazyAdminPanel(
            <LazyAdminEditorialVideoUpload courses={overview.courses || []} onVideoUploaded={onRefresh} />,
            'editorial video uploads',
            'min-h-[280px]',
          )}
        </div>
      )}

      {activeAdminSection === 'assessments' && (
        <div className="space-y-6">
          <BuilderFrame
            eyebrow="CBT Creation"
            title="Lesson CBT Builder"
            description="Build lesson-linked CBTs in a guided flow. The admin can fill the basics, target the exact lesson path, write questions manually, or let AI draft and then review it."
            actions={(
              <div className="flex flex-wrap gap-3">
                <button onClick={resetCbtForm} disabled={busy} className="rounded-2xl border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">
                  New CBT
                </button>
                <div className="rounded-2xl bg-[var(--accent-cream)] px-4 py-3 text-sm font-semibold text-[var(--ink)]">
                  {builderSteps[cbtBuilderStep]}
                </div>
              </div>
            )}
            activeStep={cbtBuilderStep}
            onStepSelect={(index) => setCbtBuilderStep(clampBuilderStep(index))}
          >
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_340px]">
              <div className="space-y-5">
                {renderCbtBuilderContent()}
                {renderBuilderFooter({
                  step: cbtBuilderStep,
                  onStepChange: (value) => setCbtBuilderStep(clampBuilderStep(value)),
                  onReset: resetCbtForm,
                  onSubmit: () => void createLessonCbt(),
                  submitLabel: editingCbtKey ? 'Update lesson CBT' : 'Publish lesson CBT',
                  cancelEditLabel: 'Cancel edit',
                  showCancelEdit: Boolean(editingCbtKey),
                })}
              </div>
              <div className="space-y-4">
                <AssessmentPreviewCard
                  typeLabel="CBT"
                  accent="green"
                  title={cbtForm.title}
                  subtitle={cbtReviewPath}
                  questionCount={cbtQuestions.length}
                  totalMarks={cbtQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0)}
                  durationMinutes={cbtForm.durationMinutes}
                  negativeMarking={cbtForm.negativeMarking}
                  topic={cbtForm.topic}
                />
                <div className="rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)] p-4 text-sm leading-7 text-[var(--ink-soft)]">
                  This builder now behaves as a guided sequence, so admins can focus on one decision at a time and still keep the live preview in view.
                </div>
              </div>
            </div>
          </BuilderFrame>

          <BuilderFrame
            eyebrow="Mock Test Creation"
            title="Full-Length Mock Builder"
            description="Create full mock tests with the same guided structure and link each one to a course so only enrolled learners can access it."
            actions={(
              <div className="flex flex-wrap gap-3">
                <button onClick={resetFullMockForm} disabled={busy} className="rounded-2xl border border-[var(--line)] bg-white px-5 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">
                  New Mock Test
                </button>
                <div className="rounded-2xl bg-[var(--accent-cream)] px-4 py-3 text-sm font-semibold text-[var(--ink)]">
                  {builderSteps[fullMockBuilderStep]}
                </div>
              </div>
            )}
            activeStep={fullMockBuilderStep}
            onStepSelect={(index) => setFullMockBuilderStep(clampBuilderStep(index))}
          >
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_340px]">
              <div className="space-y-5">
                {unlinkedFullMockTests.length > 0 && (
                  <div className="rounded-[24px] border border-[#f3d3a1] bg-[#fff7e8] px-5 py-4 text-sm leading-6 text-[#7a4b00]">
                    {unlinkedFullMockTests.length} existing full mock test{unlinkedFullMockTests.length === 1 ? '' : 's'} still ha{unlinkedFullMockTests.length === 1 ? 's' : 've'} no course link.
                    Edit and assign a course so students only get access after buying the related course.
                  </div>
                )}
                {renderFullMockBuilderContent()}
                {renderBuilderFooter({
                  step: fullMockBuilderStep,
                  onStepChange: (value) => setFullMockBuilderStep(clampBuilderStep(value)),
                  onReset: resetFullMockForm,
                  onSubmit: () => void createFullLengthMockTest(),
                  submitLabel: editingFullMockId ? 'Update full-length mock test' : 'Publish full-length mock test',
                  cancelEditLabel: 'Cancel edit',
                  showCancelEdit: Boolean(editingFullMockId),
                })}
              </div>
              <div className="space-y-4">
                <AssessmentPreviewCard
                  typeLabel="Full Mock Test"
                  accent="blue"
                  title={fullMockTestForm.title}
                  subtitle={fullMockReviewPath}
                  questionCount={fullMockQuestions.length}
                  totalMarks={fullMockQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0)}
                  durationMinutes={fullMockTestForm.durationMinutes}
                  negativeMarking={fullMockTestForm.negativeMarking}
                  topic={fullMockTestForm.topic}
                />
                <div className="rounded-[24px] border border-[var(--line)] bg-[var(--accent-cream)] p-4 text-sm leading-7 text-[var(--ink-soft)]">
                  Full mocks stay separate from lesson CBTs, so the admin can understand where the test will surface before publishing it.
                </div>
              </div>
            </div>
          </BuilderFrame>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
              <SectionHeader title="Manage lesson CBTs" caption="Edit or delete attached CBT assessments" />
              <div className="mt-6 space-y-3">
                {existingLessonCbts.length > 0 ? existingLessonCbts.map((entry) => (
                  <div key={entry.key} className="rounded-[22px] border border-[var(--line)] bg-white p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-[var(--ink)]">{entry.cbt.title || `${entry.lessonTitle} CBT`}</p>
                        <p className="mt-1 text-sm text-[var(--ink-soft)]">
                          {entry.courseTitle} • {entry.moduleTitle}{entry.chapterTitle ? ` • ${entry.chapterTitle}` : ''} • {entry.lessonTitle}
                        </p>
                        <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[var(--ink-soft)]">
                          {entry.cbt.questions.length} questions • {entry.cbt.durationMinutes} min • negative {entry.cbt.negativeMarking}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => loadCbtForEdit(entry)} disabled={busy} className="rounded-2xl border border-[var(--line)] bg-white px-4 py-2 text-sm font-semibold text-[var(--ink)]">
                          Edit
                        </button>
                        <button onClick={() => void deleteCbt(entry)} disabled={busy} className="rounded-2xl bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white">
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="rounded-[22px] border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-soft)]">
                    No lesson CBTs are attached yet.
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
              <SectionHeader title="Manage full-length mock tests" caption="Edit or delete published mock tests" />
              <div className="mt-6 space-y-3">
                {existingFullMockTests.length > 0 ? existingFullMockTests.map((test) => (
                  <div key={test._id} className="rounded-[22px] border border-[var(--line)] bg-white p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-[var(--ink)]">{test.title}</p>
                        <p className="mt-1 text-sm text-[var(--ink-soft)]">
                          {(getCourseTitleById(test.course) || 'Course link required')} • {test.category} • {test.questions.length} questions • {test.durationMinutes} min
                        </p>
                        <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[var(--ink-soft)]">
                          Parent course: {getCourseTitleById(test.course) || 'Course link required'} • negative {test.negativeMarking}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => loadFullMockForEdit(test)} disabled={busy} className="rounded-2xl border border-[var(--line)] bg-white px-4 py-2 text-sm font-semibold text-[var(--ink)]">
                          Edit
                        </button>
                        <button onClick={() => void deleteFullMock(test._id)} disabled={busy} className="rounded-2xl bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white">
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="rounded-[22px] border border-dashed border-[var(--line)] p-5 text-sm text-[var(--ink-soft)]">
                    No full-length mock tests are published yet.
                  </div>
                )}
              </div>
            </section>
          </div>

          {renderLazyAdminPanel(
            <LazyAdminMockTestVideoUpload tests={existingFullMockTests} onVideoUploaded={onRefresh} />,
            'mock test video uploads',
            'min-h-[280px]',
          )}
        </div>
      )}

      {activeAdminSection === 'security' && (
        <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
          <SectionHeader title="Recent device activity" caption="Login sessions and device events" />
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            {(overview.adminOverview?.recentDeviceActivity || []).map((activity) => (
              <div key={activity._id} className="rounded-[22px] bg-[var(--accent-cream)] p-4">
                <p className="text-sm font-semibold text-[var(--ink)]">{formatEventLabel(activity.eventType)}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-[var(--ink-soft)]">{formatDeviceLabel(activity.device)}</p>
                <p className="mt-3 text-sm text-[var(--ink-soft)]">User: {activity.userId}</p>
                <p className="mt-1 text-sm text-[var(--ink-soft)]">{formatDateTime(activity.createdAt)}</p>
              </div>
            ))}
            {(overview.adminOverview?.recentDeviceActivity || []).length === 0 && (
              <div className="rounded-[22px] border border-dashed border-[var(--line)] p-6 text-sm text-[var(--ink-soft)]">
                No device events are available yet.
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

const AppContent = () => {
  const { user, loading, logout } = useAuth();
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [resumeTarget, setResumeTarget] = useState<{ courseId: string; lessonId?: string | null; doubtThreadId?: string | null; reportId?: string | null; supportPanel?: 'doubts' | 'report' | null } | null>(null);
  const [savedTopicIds, setSavedTopicIds] = useState<string[]>([]);
  const overviewRequestRef = useRef<Promise<PlatformOverview | null> | null>(null);
  const shouldPollOverviewInBackground = activeTab === 'overview';

  const refreshOverview = async (background = true) => {
    if (!background) {
      setLoadingOverview(true);
    }
    try {
      if (!user && !EduService.getToken()) {
        setOverview(null);
        return null;
      }

      if (!overviewRequestRef.current) {
        overviewRequestRef.current = EduService.getPlatformOverview()
          .then((nextOverview) => {
            setOverview(nextOverview);
            return nextOverview;
          })
          .finally(() => {
            overviewRequestRef.current = null;
          });
      }

      return await overviewRequestRef.current;
    } finally {
      if (!background) {
        setLoadingOverview(false);
      }
    }
  };

  useEffect(() => {
    if (!EduService.getToken()) {
      setLoadingOverview(false);
      return;
    }

    void refreshOverview(false);
  }, []);

  useEffect(() => {
    if (loading) {
      return;
    }

    if (!user) {
      setOverview(null);
      setLoadingOverview(false);
      return;
    }

    if (!overview) {
      void refreshOverview(false);
    }
  }, [loading, overview, user]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    const courseId = params.get('courseId');
    const lessonId = params.get('lessonId');
    const doubtThreadId = params.get('doubtThreadId');

    if (tab === 'live' && !LIVE_CLASSES_ENABLED) {
      setActiveTab('overview');
    } else if (tab && tab in shellTabMeta) {
      setActiveTab(tab as TabKey);
    }

    if (tab === 'courses' && courseId) {
      setResumeTarget({ courseId, lessonId: lessonId || null, doubtThreadId: doubtThreadId || null, reportId: params.get('reportId') || null, supportPanel: (params.get('supportPanel') as 'doubts' | 'report' | null) || null });
    }
  }, []);

  useEffect(() => {
    if (!user || typeof window === 'undefined') {
      return undefined;
    }

    if (!shouldPollOverviewInBackground) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void refreshOverview(true);
    }, 20000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldPollOverviewInBackground, user]);

  useEffect(() => {
    if (!user || !shouldPollOverviewInBackground) {
      return;
    }

    void refreshOverview(true);
  }, [shouldPollOverviewInBackground, user]);

  useEffect(() => {
    if (!user?._id || typeof window === 'undefined') {
      setSavedTopicIds([]);
      return;
    }

    try {
      const raw = window.localStorage.getItem(buildSavedTopicsKey(user._id));
      const parsed = raw ? JSON.parse(raw) as string[] : [];
      setSavedTopicIds(Array.isArray(parsed) ? parsed : []);
    } catch {
      setSavedTopicIds([]);
    }
  }, [user?._id]);

  const savedTopics = useMemo(() => {
    if (!overview || !savedTopicIds.length) {
      return [];
    }

    const savedTopicSet = new Set(savedTopicIds);
    return overview.courses.flatMap((course) =>
      flattenCourseLessons(course)
        .filter((entry) => savedTopicSet.has(`${course._id}:${entry.lesson.id}`))
        .map((entry) => {
          const progress = (course.lessonProgress || []).find((item) => item.lessonId === entry.lesson.id);
          return {
            courseId: course._id,
            lessonId: entry.lesson.id,
            savedAt: '',
            courseTitle: course.title,
            lessonTitle: entry.lesson.title,
            exam: course.exam,
            thumbnailUrl: course.thumbnailUrl,
            moduleTitle: entry.moduleTitle,
            chapterTitle: entry.chapterTitle,
            progressSeconds: progress?.progressSeconds || 0,
            completed: progress?.completed || false,
          } as SavedTopic;
        }))
      .sort((left, right) => savedTopicIds.indexOf(`${left.courseId}:${left.lessonId}`) - savedTopicIds.indexOf(`${right.courseId}:${right.lessonId}`));
  }, [overview, savedTopicIds]);

  const toggleSavedTopic = (courseId: string, lessonId: string) => {
    if (!user?._id || typeof window === 'undefined') {
      return;
    }

    setSavedTopicIds((current) => {
      const topicKey = `${courseId}:${lessonId}`;
      const next = current.includes(topicKey)
        ? current.filter((item) => item !== topicKey)
        : [topicKey, ...current];
      window.localStorage.setItem(buildSavedTopicsKey(user._id), JSON.stringify(next));
      return next;
    });
  };

  const openNotification = (notification: NotificationItem) => {
    if (notification.actionUrl && typeof window !== 'undefined') {
      window.location.href = notification.actionUrl;
    }
  };

  if (loading || loadingOverview || (user && !overview)) {
    return <LoadingShell />;
  }

  if (!user) {
    return <AuthScreen />;
  }

  if (!overview) {
    return <LoadingShell />;
  }

  return (
    <Shell
      overview={overview}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      onLogout={logout}
      onRefresh={async () => {
        await refreshOverview(true);
      }}
      resumeTarget={resumeTarget}
      onContinueLearningNavigate={(courseId, lessonId, doubtThreadId, reportId, supportPanel) => setResumeTarget({ courseId, lessonId, doubtThreadId, reportId, supportPanel })}
      onOpenNotification={openNotification}
      onResumeNavigationHandled={() => setResumeTarget(null)}
      savedTopicIds={savedTopicIds}
      savedTopics={savedTopics}
      onToggleSavedTopic={toggleSavedTopic}
    />
  );
};

export default function App() {
  return <AppContent />;
}
