import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BookOpen,
  CalendarDays,
  ChevronDown,
  Check,
  Clock3,
  Copy,
  FileText,
  Menu,
  Mic,
  MicOff,
  MessageSquare,
  MoreHorizontal,
  MonitorUp,
  PhoneOff,
  Plus,
  Radio,
  Search,
  Send,
  Share2,
  Settings,
  ImageIcon,
  Loader2,
  Maximize2,
  UserRound,
  Users,
  Upload,
  Video,
  VideoOff,
  Hand,
  X,
} from 'lucide-react';
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import { EduService } from '../EduService';
import {
  LiveClass,
  LiveClassAccess,
  LiveClassChatMessage,
  LiveClassEventPayload,
  LiveClassPoll,
  LiveClassResource,
  LiveClassSessionState,
  LiveTeacherProfile,
  PlatformOverview,
} from '../types';
import { cn } from '../lib/utils';
import { useAuth } from '../AuthContext';
import { ResilientHlsVideo } from './ResilientHlsVideo';

const LIVE_ROOM_STORAGE_KEY = 'edumaster.live.active-room';

const getErrorMessage = (error: unknown) => (
  error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown media error'
);

const normalizeLiveUiErrorMessage = (error: unknown, fallback: string) => {
  const message = getErrorMessage(error);
  if (/could not establish signal connection|failed to fetch|websocket|connection was lost|not connected/i.test(message)) {
    return 'Live media connection was lost. Re-open the classroom if audio or video does not recover.';
  }
  return message || fallback;
};

const readActiveLiveRoom = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = window.sessionStorage.getItem(LIVE_ROOM_STORAGE_KEY) || window.localStorage.getItem(LIVE_ROOM_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored) as { liveClassId?: string | null } | null;
    return parsed?.liveClassId ? parsed : null;
  } catch {
    return null;
  }
};

const rememberActiveLiveRoom = (liveClassId: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  const payload = JSON.stringify({
    liveClassId,
    updatedAt: new Date().toISOString(),
  });

  window.sessionStorage.setItem(LIVE_ROOM_STORAGE_KEY, payload);
  window.localStorage.setItem(LIVE_ROOM_STORAGE_KEY, payload);
};

const clearActiveLiveRoom = () => {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.removeItem(LIVE_ROOM_STORAGE_KEY);
  window.localStorage.removeItem(LIVE_ROOM_STORAGE_KEY);
};

const isLiveKitRoomConnected = (room?: Room | null) => (
  Boolean(room && room.state === ConnectionState.Connected)
);

const supportsDisplayCapture = () => (
  typeof navigator !== 'undefined'
  && Boolean(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices)
);

const sanitizeLiveClasses = (items: Array<LiveClass | null | undefined> | null | undefined): LiveClass[] => (
  (items || []).filter((item): item is LiveClass => Boolean(item))
);

const getLiveStatusValue = (liveClass: LiveClass | null | undefined) => String(liveClass?.status || 'scheduled').toLowerCase();
const getLiveStatusLabel = (liveClass: LiveClass | null | undefined) => String(liveClass?.status || 'scheduled');

const EMPTY_LIVE_CLASS: LiveClass = {
  _id: '',
  title: '',
  instructor: '',
  startTime: '',
  durationMinutes: 0,
  provider: 'livekit',
  mode: 'live',
  status: 'scheduled',
  chatEnabled: true,
  doubtSolving: false,
  replayAvailable: false,
  attendees: 0,
  topicTags: [],
  sessionNotes: [],
  resources: [],
  activePoll: null,
  teacherProfile: null,
};

type LiveKitTrackEntry = {
  trackSid: string;
  participantIdentity: string;
  participantName: string;
  source: Track.Source;
  kind: Track.Kind;
  isLocal: boolean;
  isMuted: boolean;
  track: Track;
};

const formatTime = (value: string) => {
  try {
    const formatted = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    return Number.isNaN(new Date(value).getTime()) ? '' : formatted;
  } catch {
    return '';
  }
};

const splitTimeLabel = (value: string) => {
  const label = formatTime(value);
  const [time = '', meridiem = ''] = label.split(' ');
  return { time, meridiem };
};

const formatFullDate = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

const formatCompactCount = (value: number) => {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}K`;
  }
  return String(value);
};

const getInitials = (name: string) => (
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'LC'
);

const getDisplayLiveClassTitle = (liveClass: LiveClass | null) => {
  const rawTitle = String(liveClass?.title || '').trim();
  if (!rawTitle) {
    return 'Electrostatics';
  }

  return rawTitle
    .replace(/\s+\d{4}-\d{2}-\d{2}T[\d:-]+(?:\.\d+)?Z?$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

const liveMetadataTagPrefixes = {
  subject: 'subject:',
  category: 'category:',
  level: 'level:',
  language: 'language:',
  reminder: 'reminder:',
  visibility: 'visibility:',
  price: 'price:',
  certificate: 'certificate:',
} as const;

const readLiveMetadataTag = (
  liveClass: LiveClass | null,
  key: keyof typeof liveMetadataTagPrefixes,
) => {
  const prefix = liveMetadataTagPrefixes[key];
  const match = (liveClass?.topicTags || []).find((tag) => String(tag || '').toLowerCase().startsWith(prefix));
  return match ? String(match).slice(prefix.length).trim() : '';
};

const withLiveMetadataTag = (tags: string[], key: keyof typeof liveMetadataTagPrefixes, value: string) => {
  const prefix = liveMetadataTagPrefixes[key];
  const sanitizedValue = String(value || '').trim();
  const next = tags.filter((tag) => !String(tag || '').toLowerCase().startsWith(prefix));
  if (!sanitizedValue) {
    return next;
  }
  return [...next, `${prefix}${sanitizedValue}`];
};

const getLiveSubject = (liveClass: LiveClass | null) => readLiveMetadataTag(liveClass, 'subject') || getCleanLiveClassTags(liveClass)[0] || 'General';
const getLiveCategory = (liveClass: LiveClass | null) => readLiveMetadataTag(liveClass, 'category') || '';
const getLiveLevel = (liveClass: LiveClass | null) => readLiveMetadataTag(liveClass, 'level') || '';
const getLiveLanguage = (liveClass: LiveClass | null) => readLiveMetadataTag(liveClass, 'language') || 'English';
const getLiveVisibility = (liveClass: LiveClass | null) => readLiveMetadataTag(liveClass, 'visibility') || 'Immediately';
const getLiveCertificate = (liveClass: LiveClass | null) => readLiveMetadataTag(liveClass, 'certificate') || 'No Certificate';
const getLiveReminderLeadMinutes = (liveClass: LiveClass | null) => Number(readLiveMetadataTag(liveClass, 'reminder') || 15);
const getLiveClassPriceLabel = (liveClass: LiveClass | null) => {
  const rawValue = readLiveMetadataTag(liveClass, 'price');
  if (!rawValue || rawValue === '0' || rawValue.toLowerCase() === 'free') {
    return 'Free';
  }
  return rawValue.startsWith('₹') ? rawValue : `₹${rawValue}`;
};

const getCleanLiveClassTags = (liveClass: LiveClass | null) => (
  (liveClass?.topicTags || [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean)
    .filter((tag) => !/^class\s*\d+/i.test(tag))
    .filter((tag) => !/^session\b/i.test(tag))
    .filter((tag) => !/^[a-z-]+:.*$/i.test(tag))
    .filter((tag) => !/automation|smoke|mock-test|test_/i.test(tag))
);

const getLiveClassTopicLine = (liveClass: LiveClass | null) => (
  [getLiveCategory(liveClass), ...getCleanLiveClassTags(liveClass).slice(0, 2)].filter(Boolean).join(' • ') || 'Important Concepts & PYQs'
);

const getPrimaryTopic = (liveClass: LiveClass | null) => (
  getLiveSubject(liveClass)
);

const getLiveMetaLine = (liveClass: LiveClass | null) => {
  const subject = getLiveSubject(liveClass);
  const level = getLiveLevel(liveClass);
  return [subject, level].filter(Boolean).join(' • ') || 'Live Session';
};

const getLivePreviewResource = (liveClass: LiveClass | null) => (
  (liveClass?.resources || []).find((resource) => String(resource.type || '').toLowerCase() === 'preview-video') || null
);

const getLiveAttachmentResource = (liveClass: LiveClass | null) => (
  (liveClass?.resources || []).find((resource) => String(resource.type || '').toLowerCase() === 'attachment') || null
);

const formatDateInputValue = (value: string) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  const offset = parsed.getTimezoneOffset();
  const local = new Date(parsed.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
};

const formatTimeInputValue = (value: string) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const buildDateTimeValue = (datePart: string, timePart: string) => (
  datePart && timePart ? `${datePart}T${timePart}` : ''
);

const calculateDurationMinutes = (startDateTime: string, endTime: string, fallbackMinutes: number) => {
  if (!startDateTime || !endTime) {
    return fallbackMinutes;
  }
  const start = new Date(startDateTime);
  if (Number.isNaN(start.getTime())) {
    return fallbackMinutes;
  }
  const [endHours, endMinutes] = String(endTime || '').split(':').map((entry) => Number(entry));
  if (!Number.isFinite(endHours) || !Number.isFinite(endMinutes)) {
    return fallbackMinutes;
  }
  const end = new Date(start);
  end.setHours(endHours, endMinutes, 0, 0);
  if (end.getTime() <= start.getTime()) {
    end.setDate(end.getDate() + 1);
  }
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return Math.max(durationMinutes, 15);
};

const formatCountdown = (startTime: string) => {
  const delta = Math.max(Date.parse(startTime) - Date.now(), 0);
  const totalSeconds = Math.floor(delta / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return {
    hours: String(hours).padStart(2, '0'),
    minutes: String(minutes).padStart(2, '0'),
    seconds: String(seconds).padStart(2, '0'),
  };
};

const getStatusTone = (status: string) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'live') {
    return 'bg-[#fff5f5] text-[#d23b3b] border border-[#ffd6d6]';
  }
  if (normalized === 'ended') {
    return 'bg-[#eef4ff] text-[#2b63df] border border-[#dbe8ff]';
  }
  if (normalized === 'upcoming') {
    return 'bg-[#f3fbf4] text-[#1fa05c] border border-[#e6f6ea]';
  }
  return 'bg-[#f6fbff] text-[#1765f5] border border-[#dceaff]';
};

const getTopicColor = (index: number) => (
  [
    'from-[#f3fbf4] to-[#e5f8ea] text-[#1fa05c]',
    'from-[#f7f1ff] to-[#efe5ff] text-[#7e47eb]',
    'from-[#fff7eb] to-[#fff0d7] text-[#f29b22]',
    'from-[#eef4ff] to-[#e5ecff] text-[#2b63df]',
  ][index % 4]
);

const quickActionCards = [
  { id: 'all-live', title: 'All Live Classes', subtitle: 'Browse all', accent: 'bg-[#fff1f1] text-[#ff5b5b]', icon: Video },
  { id: 'schedule', title: 'Schedule', subtitle: 'View timetable', accent: 'bg-[#f4efff] text-[#8d52ff]', icon: CalendarDays },
  { id: 'my-classes', title: 'My Classes', subtitle: 'Joined classes', accent: 'bg-[#eefcf2] text-[#31b25f]', icon: Check },
  { id: 'notifications', title: 'Notifications', subtitle: 'Stay updated', accent: 'bg-[#fff7e8] text-[#f4ab24]', icon: Bell },
] as const;

const MobileStatusBar = () => null;

const classInfoRows = [
  { label: 'Topics to be covered', value: '5 Topics', icon: CalendarDays, tone: 'bg-[#eef4ff] text-[#2b63df]' },
  { label: 'Class Notes', value: 'Will be shared after the class', icon: Check, tone: 'bg-[#f5edff] text-[#8d52ff]' },
  { label: 'Homework', value: 'Practice questions (10 Qs)', icon: ArrowRight, tone: 'bg-[#edfbf1] text-[#26a55a]' },
  { label: 'Recording', value: 'Available after 2 hours', icon: Video, tone: 'bg-[#fff1f1] text-[#ff6d5b]' },
] as const;

const liveFigmaReference = {
  featured: {
    badge: 'LIVE NOW',
    status: 'live',
    title: 'Electrostatics',
    subtitle: 'Important Concepts & PYQs',
    meta: 'Physics • Class 12',
    teacher: 'Rahul Sharma',
    audience: '12.6K watching',
    audienceWithStudents: '12.6K Students watching',
    primaryTopic: 'Physics',
  },
  today: [
    {
      time: '07:00',
      meridiem: 'PM',
      topic: 'Mathematics',
      title: 'Differential Equations',
      meta: 'Class 12 • Session 2024-25',
      teacher: 'Aman Verma',
      status: 'upcoming',
      statusLabel: 'UPCOMING',
      attendees: '1.2K going',
      colorIndex: 0,
    },
    {
      time: '08:30',
      meridiem: 'PM',
      topic: 'Chemistry',
      title: 'Chemical Kinetics',
      meta: 'Class 12 • Session 2024-25',
      teacher: 'Neha Agarwal',
      status: 'upcoming',
      statusLabel: 'UPCOMING',
      attendees: '856 going',
      colorIndex: 1,
    },
    {
      time: '10:00',
      meridiem: 'PM',
      topic: 'Physics',
      title: 'Current Electricity',
      meta: 'Class 12 • Session 2024-25',
      teacher: 'Rahul Sharma',
      status: 'upcoming',
      statusLabel: 'UPCOMING',
      attendees: '1.5K going',
      colorIndex: 2,
    },
  ],
  tomorrow: {
    time: '11:00',
    meridiem: 'AM',
    topic: 'Biology',
    title: 'Human Reproduction',
    meta: 'Class 12 • Session 2024-25',
    teacher: 'Rahul Sharma',
    status: 'upcoming',
    statusLabel: 'UPCOMING',
    attendees: '942 going',
    colorIndex: 3,
  },
  detail: {
    badge: 'LIVE NOW',
    status: 'live',
    title: 'Electrostatics',
    subtitle: 'Important Concepts & PYQs',
    meta: 'Physics • Class 12',
    teacher: 'Rahul Sharma',
    audience: '12.6K Students watching',
    startedAt: '07:00 PM',
    duration: '120 min',
    students: '12.6K',
    earlyTitle: 'You’ve joined 5 min early',
    earlyBody: 'The class will start shortly. Stay tuned!',
    about: 'In this session, we will cover the important concepts of Electrostatics along with PYQs',
    topics: '5 Topics',
    notes: 'Will be shared after the class',
    homework: 'Practice questions (10 Qs)',
    recording: 'Available after 2 hours',
    teacherRole: 'Physics Expert',
    teacherExperience: '8+ Years of Teaching Experience',
    countdown: { hours: '00', minutes: '18', seconds: '32' },
  },
  room: {
    title: 'Electrostatics – Important Concepts',
    meta: 'Physics • Class 12',
    badge: 'LIVE',
    viewers: '312',
    presenter: 'Rahul Sharma is presenting',
    participants: [
      { name: 'Rahul Sharma', muted: false, kind: 'portrait' },
      { name: 'Priya Singh', muted: true, kind: 'portrait' },
      { name: 'AM', muted: true, kind: 'initials' },
      { name: '+308', muted: false, kind: 'count' },
    ],
    chatMessages: [
      {
        id: 'ref-chat-1',
        name: 'Ankit Verma',
        initial: 'AV',
        time: '9:41 AM',
        role: null,
        message: 'Sir, why is electric field radial in nature for a point charge?',
        likes: 12,
      },
      {
        id: 'ref-chat-2',
        name: 'Rahul Sharma',
        initial: null,
        time: '9:42 AM',
        role: 'Teacher',
        message: 'Good question Ankit! Because the force on a positive test charge will always be along the line joining it with the source charge.',
        likes: 24,
      },
      {
        id: 'ref-chat-3',
        name: 'Neha Agarwal',
        initial: 'NA',
        time: '9:43 AM',
        role: null,
        message: 'Can we say the field is stronger near the charge?',
        likes: null,
      },
    ],
  },
} as const;

const liveUiFontStyle = {
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;

type LiveUtilityPanel = 'menu' | 'schedule' | 'my-classes' | 'notifications' | 'teacher' | 'help' | 'participants' | null;
type LiveDetailTabKey = 'overview' | 'chat' | 'notes' | 'polls' | 'resources';
type LiveRoomTabKey = 'chat' | 'notes' | 'polls' | 'resources';

const liveResourceLibrary = [
  {
    id: 'class-notes',
    title: 'Class Notes',
    meta: 'PDF • 2.4 MB',
    lines: ['Session summary', 'Electrostatics concept map', 'Key derivations', 'Revision pointers'],
  },
  {
    id: 'important-formulas',
    title: 'Important Formulas',
    meta: 'PDF • 1.1 MB',
    lines: ['Coulomb law', 'Electric field intensity', 'Potential relation', 'Capacitance formulas'],
  },
  {
    id: 'previous-year-pyqs',
    title: 'Previous Year PYQs',
    meta: 'PDF • 3.2 MB',
    lines: ['PYQ set 1', 'PYQ set 2', 'Marking hints', 'Difficulty tagging'],
  },
  {
    id: 'practice-questions',
    title: 'Practice Questions',
    meta: 'PDF • 2.8 MB',
    lines: ['Topic drills', 'Numerical practice', 'Assertion reasoning', 'Homework checkpoint'],
  },
] as const;

const normalizeLiveTeacherProfile = (liveClass: LiveClass | null): LiveTeacherProfile => ({
  name: liveClass?.teacherProfile?.name || liveClass?.instructor || 'Live Faculty',
  role: liveClass?.teacherProfile?.role || '',
  experience: liveClass?.teacherProfile?.experience || '',
  bio: liveClass?.teacherProfile?.bio || '',
  avatarUrl: liveClass?.teacherProfile?.avatarUrl || null,
});

const buildLivePollFromForm = (question: string, optionsText: string): LiveClassPoll | null => {
  const normalizedQuestion = question.trim();
  const options = String(optionsText || '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((text, index) => ({ id: `option-${index + 1}`, text }));
  if (!normalizedQuestion || options.length === 0) {
    return null;
  }
  return {
    question: normalizedQuestion,
    status: 'live',
    options,
  };
};

const isValidLiveAssetUrl = (value: string) => {
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  if (normalized.startsWith('/')) {
    return true;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const getPollOptionCount = (value: string) => String(value || '').split('\n').map((entry) => entry.trim()).filter(Boolean).length;

const TeacherAvatar = ({ name, photoUrl, size = 'md', online = false }: { name: string; photoUrl?: string | null; size?: 'sm' | 'md' | 'lg'; online?: boolean }) => {
  const sizeClass = size === 'sm' ? 'h-9 w-9 text-[12px]' : size === 'lg' ? 'h-14 w-14 text-base' : 'h-11 w-11 text-sm';
  return (
    <div className="relative">
      {photoUrl ? (
        <img
          src={photoUrl}
          alt={name}
          className={cn('rounded-full object-cover shadow-[0_8px_18px_rgba(30,61,119,0.16)]', sizeClass)}
        />
      ) : (
        <div className={cn('flex items-center justify-center rounded-full bg-[linear-gradient(180deg,#dce7ff_0%,#90b0ff_100%)] font-semibold text-[#1a2d57] shadow-[0_8px_18px_rgba(30,61,119,0.16)]', sizeClass)}>
          {getInitials(name)}
        </div>
      )}
      {online && <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-[#23c267]" />}
    </div>
  );
};

const ReferenceTeacherAvatar = ({ size = 'md', online = false }: { size?: 'sm' | 'md' | 'lg'; online?: boolean }) => {
  const shellClass = size === 'sm' ? 'h-9 w-9' : size === 'lg' ? 'h-14 w-14' : 'h-11 w-11';
  const svgClass = size === 'sm' ? 'h-9 w-9' : size === 'lg' ? 'h-14 w-14' : 'h-11 w-11';
  const suffix = size;

  return (
    <div className="relative">
      <div className={cn('relative overflow-hidden rounded-full border border-white/65 bg-[linear-gradient(180deg,#edf3ff_0%,#a3bbff_100%)] shadow-[0_10px_20px_rgba(30,61,119,0.18)]', shellClass)}>
        <svg viewBox="0 0 64 64" className={svgClass} aria-hidden="true">
          <defs>
            <linearGradient id={`portrait-bg-${suffix}`} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#eef3ff" />
              <stop offset="55%" stopColor="#d8e4ff" />
              <stop offset="100%" stopColor="#9cb6ff" />
            </linearGradient>
            <linearGradient id={`portrait-shirt-${suffix}`} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#3a568e" />
              <stop offset="100%" stopColor="#1a2b4d" />
            </linearGradient>
            <radialGradient id={`portrait-face-${suffix}`} cx="0.4" cy="0.34" r="0.72">
              <stop offset="0%" stopColor="#f5d6bf" />
              <stop offset="100%" stopColor="#e6b896" />
            </radialGradient>
          </defs>
          <rect width="64" height="64" rx="32" fill={`url(#portrait-bg-${suffix})`} />
          <ellipse cx="23" cy="18" rx="19" ry="10" fill="#ffffff" opacity="0.45" />
          <ellipse cx="32" cy="55" rx="20" ry="12" fill="#24375d" opacity="0.13" />
          <path d="M18 59c1-9 7-15 14-16h1c7 1 13 7 15 16" fill={`url(#portrait-shirt-${suffix})`} />
          <path d="M23 46c2 3 5 6 9 6s7-3 9-6l3 2c-2 5-6 10-12 10-5 0-10-5-12-10Z" fill="#22375f" />
          <path d="M23 38c3 2 6 4 9 4s6-2 9-4v8c-2 4-5 6-9 6s-7-2-9-6Z" fill="#ddb18d" />
          <ellipse cx="32" cy="25" rx="11.5" ry="13" fill={`url(#portrait-face-${suffix})`} />
          <path d="M20 26c0-9 6-15 13-15 6 0 11 4 13 11-2-1-4-1-6-2-3-1-7-1-11-1-3 0-6 1-9 3Z" fill="#172746" />
          <path d="M21 24c2-7 7-12 14-12 5 0 10 3 12 9-3 0-5-1-8-2-4 0-8 0-12 1-2 1-4 2-6 4Z" fill="#152441" />
          <path d="M25.5 27.8c.8-.7 1.9-1 3-1s2.2.3 3 1M35.5 27.8c.8-.7 1.9-1 3-1s2.2.3 3 1" stroke="#7f563f" strokeWidth="1.1" strokeLinecap="round" opacity="0.56" />
          <circle cx="28.8" cy="31.1" r="0.9" fill="#4b352d" />
          <circle cx="35.2" cy="31.1" r="0.9" fill="#4b352d" />
          <path d="M31 35.2c.3.6 1 .9 1.8.9.8 0 1.5-.3 1.8-.9" stroke="#b46f60" strokeWidth="1.2" strokeLinecap="round" />
          <path d="M27 38.6c1.8 1.4 8.2 1.4 10 0" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" opacity="0.55" />
          <path d="M24 46c2.2 2.8 5.1 4.2 8 4.2s5.8-1.4 8-4.2" stroke="#d9a584" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
          <path d="M30.2 43h3.6" stroke="#dca88b" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M24 53c2.1-1 5.3-1.6 8-1.6 2.8 0 5.8.6 8.1 1.6" stroke="#516ea9" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
        </svg>
      </div>
      {online && <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-white bg-[#23c267]" />}
    </div>
  );
};

const LiveBoardArtwork = ({ dark = false }: { dark?: boolean }) => (
  <div className={cn('relative overflow-hidden rounded-[20px]', dark ? 'bg-[linear-gradient(180deg,#162544_0%,#121c33_100%)]' : 'bg-[linear-gradient(180deg,#eff5ff_0%,#f6f9ff_100%)]')}>
    <svg viewBox="0 0 320 210" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id={`hero-bg-${dark ? 'dark' : 'light'}`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor={dark ? '#152443' : '#eef4ff'} />
          <stop offset="100%" stopColor={dark ? '#10172c' : '#f8fbff'} />
        </linearGradient>
        <linearGradient id={`board-shell-${dark ? 'dark' : 'light'}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={dark ? '#cad9ff' : '#d9e6ff'} />
          <stop offset="100%" stopColor={dark ? '#879bd1' : '#bfd2ff'} />
        </linearGradient>
        <linearGradient id={`board-face-${dark ? 'dark' : 'light'}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor={dark ? '#eff4ff' : '#eef5ff'} />
        </linearGradient>
        <linearGradient id={`book-blue-${dark ? 'dark' : 'light'}`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#9fc0ff" />
          <stop offset="100%" stopColor="#4d83ee" />
        </linearGradient>
        <linearGradient id={`book-pale-${dark ? 'dark' : 'light'}`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#edf3ff" />
          <stop offset="100%" stopColor="#acc4ff" />
        </linearGradient>
        <linearGradient id={`pot-${dark ? 'dark' : 'light'}`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#7fa2f0" />
          <stop offset="100%" stopColor="#4d77d4" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="320" height="210" fill={`url(#hero-bg-${dark ? 'dark' : 'light'})`} />
      <ellipse cx="206" cy="182" rx="116" ry="10" fill={dark ? 'rgba(0,0,0,0.32)' : 'rgba(180,200,244,0.44)'} />
      <ellipse cx="92" cy="179" rx="42" ry="6" fill={dark ? 'rgba(0,0,0,0.2)' : 'rgba(180,200,244,0.24)'} />
      <ellipse cx="272" cy="181" rx="28" ry="5" fill={dark ? 'rgba(0,0,0,0.2)' : 'rgba(180,200,244,0.24)'} />

      <rect x="110" y="18" width="190" height="146" rx="20" fill="none" stroke={dark ? 'rgba(190,210,255,0.16)' : '#dae6ff'} strokeWidth="2.2" />
      <rect x="118" y="26" width="174" height="132" rx="17" fill={`url(#board-shell-${dark ? 'dark' : 'light'})`} />
      <rect x="123" y="31" width="164" height="122" rx="15" fill={`url(#board-face-${dark ? 'dark' : 'light'})`} stroke={dark ? '#c0d3ff' : '#cad8ff'} strokeWidth="1.6" />

      <g stroke={dark ? '#5b92ff' : '#467bf0'} strokeWidth="2.4" strokeLinecap="round" fill="none">
        <path d="M154 79h106" />
        <circle cx="181" cy="79" r="14" fill="rgba(255,255,255,0.98)" />
        <circle cx="232" cy="79" r="14" fill="rgba(255,255,255,0.98)" />
        <path d="M177 79h8M181 75v8" />
        <path d="M228 79h8" />
        <path d="M156 64c-10-8-16-18-17-31" opacity="0.74" />
        <path d="M168 59c-8-8-13-18-14-29" opacity="0.74" />
        <path d="M180 60c-2-9-2-18 1-29" opacity="0.74" />
        <path d="M189 59c7-8 12-18 14-29" opacity="0.74" />
        <path d="M203 63c10-8 16-18 17-31" opacity="0.74" />
        <path d="M220 60c0-10 4-20 10-28" opacity="0.74" />
        <path d="M234 59c10-7 19-11 29-13" opacity="0.74" />
        <path d="M242 60c8-8 13-18 15-29" opacity="0.74" />
        <path d="M160 96c-11 9-17 19-18 32" opacity="0.74" />
        <path d="M174 96c-7 8-11 18-11 29" opacity="0.74" />
        <path d="M181 95v32" opacity="0.74" />
        <path d="M195 95c7 8 11 18 11 29" opacity="0.74" />
        <path d="M232 95v32" opacity="0.74" />
        <path d="M248 97c8 8 13 16 15 26" opacity="0.74" />
        <path d="M146 91h18" opacity="0.72" />
        <path d="M201 91h14" opacity="0.72" />
        <path d="M248 91h18" opacity="0.72" />
      </g>

      <g stroke={dark ? '#4d72b8' : '#8aa2d4'} strokeWidth="1.8" strokeLinecap="round" opacity="0.86">
        <path d="M172 124h17" />
        <path d="M224 124h17" />
        <path d="M180 132v11" />
        <path d="M232 132v11" />
      </g>
      <text x="208" y="139" fill={dark ? '#2b4f94' : '#294f94'} fontSize="15.4" fontWeight="600" textAnchor="middle">F = 1</text>
      <text x="216" y="154" fill={dark ? '#2b4f94' : '#294f94'} fontSize="14.6" fontWeight="600" textAnchor="middle">4πε₀     q₁q₂</text>
      <path d="M214 158h34" stroke={dark ? '#2b4f94' : '#294f94'} strokeWidth="1.8" />
      <text x="232" y="171" fill={dark ? '#2b4f94' : '#294f94'} fontSize="14.2" fontWeight="600" textAnchor="middle">r²</text>

      <g transform="translate(72 144)">
        <rect x="6" y="24" width="38" height="13" rx="6.5" fill={`url(#book-blue-${dark ? 'dark' : 'light'})`} />
        <rect x="28" y="11" width="46" height="14" rx="7" fill={`url(#book-pale-${dark ? 'dark' : 'light'})`} />
        <rect x="16" y="19" width="54" height="14" rx="7" fill={`url(#book-blue-${dark ? 'dark' : 'light'})`} />
        <path d="M43 -1l8 21" stroke="#9ab7ff" strokeWidth="4" strokeLinecap="round" />
        <path d="M51 -3l4 17" stroke="#5a84ea" strokeWidth="4" strokeLinecap="round" />
        <path d="M14 33h56" stroke={dark ? '#d5e1ff' : '#eff4ff'} strokeWidth="1.2" opacity="0.76" />
      </g>

      <g transform="translate(254 137)">
        <path d="M0 23h34v17H0z" fill={`url(#pot-${dark ? 'dark' : 'light'})`} />
        <path d="M6 2c7 6 13 16 13 24-8 1-14-3-17-9-3-6-1-11 4-15Z" fill="#87d98a" />
        <path d="M23 5c8 5 14 13 15 22-8 1-14-2-18-9-3-5-1-10 3-13Z" fill="#6ecf7a" />
        <path d="M16 2c1 12 1 24 0 38" stroke="#4b9a64" strokeWidth="2" />
      </g>
    </svg>
  </div>
);

const LivePosterEmptyState = ({ compact = false, dark = false, message = 'Upload a class poster' }: { compact?: boolean; dark?: boolean; message?: string }) => (
  <div className={cn(
    'flex h-full w-full flex-col items-center justify-center gap-3 rounded-[18px] border border-dashed text-center',
    compact ? 'min-h-[140px] p-4' : 'min-h-[220px] p-6',
    dark
      ? 'border-white/12 bg-[linear-gradient(180deg,rgba(15,23,42,0.96)_0%,rgba(16,24,40,0.92)_100%)] text-white/78'
      : 'border-[#d7e3fb] bg-[linear-gradient(180deg,#f8fbff_0%,#eef4ff_100%)] text-[#5e7091]',
  )}>
    <div className={cn(
      'flex items-center justify-center rounded-full',
      compact ? 'h-10 w-10' : 'h-12 w-12',
      dark ? 'bg-white/8 text-white/82' : 'bg-white text-[#2f6fe4] shadow-[0_8px_18px_rgba(47,111,228,0.08)]',
    )}>
      <ImageIcon className={compact ? 'h-5 w-5' : 'h-6 w-6'} />
    </div>
    <div>
      <p className={cn('font-semibold', compact ? 'text-[12px]' : 'text-[14px]')}>{message}</p>
      <p className={cn('mt-1', compact ? 'text-[11px]' : 'text-[12px]', dark ? 'text-white/56' : 'text-[#7b88a8]')}>No image uploaded yet.</p>
    </div>
  </div>
);

const LiveNotesArtwork = () => (
  <div className="relative h-[128px] w-full overflow-hidden rounded-[18px] bg-[linear-gradient(180deg,#f4f7ff_0%,#eef4ff_100%)] md:h-[150px]">
    <svg viewBox="0 0 164 124" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="notes-bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#f5f8ff" />
          <stop offset="100%" stopColor="#edf3ff" />
        </linearGradient>
        <linearGradient id="notes-clip" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#4d7eeb" />
          <stop offset="100%" stopColor="#6fa0ff" />
        </linearGradient>
      </defs>
      <rect width="164" height="124" rx="18" fill="url(#notes-bg)" />
      <ellipse cx="116" cy="108" rx="32" ry="7" fill="rgba(155,182,245,0.18)" />
      <ellipse cx="82" cy="112" rx="58" ry="8" fill="rgba(155,182,245,0.16)" />
      <circle cx="127" cy="39" r="34" fill="rgba(255,255,255,0.56)" />
      <rect x="101" y="22" width="50" height="70" rx="16" fill="rgba(255,255,255,0.74)" />
      <rect x="96" y="18" width="52" height="72" rx="16" fill="#fbfcff" stroke="url(#notes-clip)" strokeWidth="4" />
      <rect x="113" y="11" width="19" height="13" rx="5.5" fill="#8fb2ff" />
      <rect x="104" y="40" width="5" height="5" rx="2.5" fill="none" stroke="#7aa0f7" strokeWidth="2" />
      <rect x="104" y="55" width="5" height="5" rx="2.5" fill="none" stroke="#7aa0f7" strokeWidth="2" />
      <rect x="104" y="70" width="5" height="5" rx="2.5" fill="none" stroke="#7aa0f7" strokeWidth="2" />
      <path d="M116 42h18M116 57h18M116 72h14" stroke="#a8bcf0" strokeWidth="2.3" strokeLinecap="round" />
      <path d="M137 62l9 7-6 10" fill="none" stroke="#4a7df0" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="30" y="95" width="13" height="15" rx="6.5" fill="#90d793" />
      <path d="M38 80c5 4 8 10 8 16-5 1-9-2-11-5-2-4-1-7 3-11Z" fill="#7ed487" />
      <path d="M30 81c-4 4-6 9-6 14 5 1 8-1 10-4 2-3 1-7-4-10Z" fill="#66c671" />
      <path d="M34 79v30" stroke="#4a9662" strokeWidth="1.8" />
    </svg>
  </div>
);

const LiveRoomStageArtwork = () => (
  <div className="relative h-[206px] w-full overflow-hidden rounded-[16px] bg-[#fbfcff]">
    <svg viewBox="0 0 328 248" className="h-full w-full" aria-hidden="true">
      <rect width="328" height="248" rx="16" fill="#FBFCFF" />
      <path d="M0 0h328v248H0z" fill="url(#roomStageGlow)" opacity="0.36" />
      <defs>
        <radialGradient id="roomStageGlow" cx="0.24" cy="0.16" r="0.9">
          <stop offset="0%" stopColor="#eef2ff" />
          <stop offset="100%" stopColor="#ffffff" />
        </radialGradient>
      </defs>

      <text x="166" y="40" fill="#20222A" fontSize="15" fontWeight="500" textAnchor="middle">Electric Field due to</text>
      <text x="166" y="63" fill="#20222A" fontSize="15" fontWeight="500" textAnchor="middle">Point Charge</text>

      <g transform="translate(30 82)">
        <circle cx="48" cy="56" r="18" fill="#fff7f6" stroke="#ff6b5d" strokeWidth="2.4" />
        <path d="M48 27v-21M48 127v-21M18 56H-4M100 56h20M26 34 10 18M69 34 86 18M26 78 10 94M69 78 86 94" stroke="#2d78ff" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M48 17 43 28M48 17l5 11M48 95l-5-11M48 95l5-11M5 56l11-5M5 56l11 5M91 56l-11-5M91 56l-11 5M15 23l8 9M15 23l11 2M15 89l8-9M15 89l11-2M81 23l-8 9M81 23l-11 2M81 89l-8-9M81 89l-11-2" stroke="#2d78ff" strokeWidth="2.1" strokeLinecap="round" />
        <circle cx="48" cy="56" r="42" fill="none" stroke="#b5bfd2" strokeDasharray="5 5" strokeWidth="1.5" />
        <text x="41" y="61" fill="#ff6b5d" fontSize="18" fontWeight="600">+</text>
      </g>

      <path d="M118 136h34" stroke="#171a23" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M152 136l-10-5M152 136l-10 5" stroke="#171a23" strokeWidth="2.4" strokeLinecap="round" />
      <text x="162" y="131" fill="#171a23" fontSize="14" fontWeight="500">r</text>

      <g transform="translate(182 68)">
        <rect x="0" y="0" width="112" height="66" rx="8" fill="#ffffff" stroke="#2d78ff" strokeWidth="2.2" />
        <text x="15" y="38" fill="#24304f" fontSize="24" fontWeight="500">E</text>
        <text x="29" y="29" fill="#24304f" fontSize="14" fontWeight="500">→</text>
        <path d="M47 22h37" stroke="#24304f" strokeWidth="1.8" />
        <text x="59" y="18" fill="#24304f" fontSize="12">1</text>
        <text x="56" y="47" fill="#24304f" fontSize="18">4πε₀</text>
        <text x="93" y="22" fill="#24304f" fontSize="12">q</text>
        <path d="M92 26v18" stroke="#24304f" strokeWidth="1.4" />
        <text x="91" y="45" fill="#24304f" fontSize="14">r²</text>
        <text x="103" y="34" fill="#24304f" fontSize="16">r̂</text>
      </g>

      <g fill="#2d78ff" fontSize="12">
        <text x="181" y="160" textDecoration="underline">Where,</text>
      </g>
      <g fill="#1b2233" fontSize="11.5">
        <text x="181" y="178">q  =  point charge</text>
        <text x="181" y="194">r  =  distance from charge</text>
        <text x="181" y="210">ε₀ =  permittivity of free space</text>
      </g>
    </svg>
  </div>
);

const initialCreateForm = {
  title: '',
  subject: '',
  category: '',
  classLevel: '',
  instructor: '',
  language: 'English',
  startTime: '',
  durationMinutes: 90,
  posterUrl: '',
  previewVideoUrl: '',
  attachmentTitle: '',
  attachmentUrl: '',
  classDescription: '',
  teacherRole: '',
  teacherExperience: '',
  teacherBio: '',
  teacherAvatarUrl: '',
  sessionNotesText: '',
  reminderLeadMinutes: 15,
  visibleToStudents: 'Immediately',
  maxAttendees: 500,
  priceLabel: 'Free',
  certificateLabel: 'No Certificate',
  allowLiveChat: true,
  allowQa: true,
  enableClassRecording: true,
  pollQuestion: '',
  pollOptionsText: '',
  linkageType: 'standalone' as 'standalone' | 'course' | 'mock-test',
  courseId: '',
  moduleId: '',
  chapterId: '',
  mockTestId: '',
};

type Props = {
  overview: PlatformOverview;
  onRefresh: () => Promise<void>;
  onMobileModeChange?: (mode: 'list' | 'detail' | 'room') => void;
  initialLiveClassId?: string | null;
  onInitialLiveClassHandled?: () => void;
};

const liveCreationSteps = [
  { id: 'info', label: 'Class Info' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'details', label: 'Details' },
  { id: 'settings', label: 'Settings' },
  { id: 'review', label: 'Review & Publish' },
] as const;

export const LiveClassesFigmaTab = ({ overview, onRefresh, onMobileModeChange, initialLiveClassId, onInitialLiveClassHandled }: Props) => {
  const { user, isAdmin } = useAuth();
  const [liveClasses, setLiveClasses] = useState<LiveClass[]>(sanitizeLiveClasses(overview.liveClasses));
  const [selectedLiveClassId, setSelectedLiveClassId] = useState<string>(sanitizeLiveClasses(overview.liveClasses)[0]?._id || '');
  const [view, setView] = useState<'list' | 'detail' | 'room'>('list');
  const [access, setAccess] = useState<LiveClassAccess | null>(null);
  const [session, setSession] = useState<LiveClassSessionState | null>(null);
  const [messages, setMessages] = useState<LiveClassChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingLiveClassId, setEditingLiveClassId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState(initialCreateForm);
  const [createStep, setCreateStep] = useState(0);
  const [uploadingPoster, setUploadingPoster] = useState(false);
  const [uploadingTeacherPhoto, setUploadingTeacherPhoto] = useState(false);
  const [localMicMuted, setLocalMicMuted] = useState(!isAdmin);
  const [localVideoEnabled, setLocalVideoEnabled] = useState(Boolean(isAdmin));
  const [localScreenSharing, setLocalScreenSharing] = useState(false);
  const [roomLoaded, setRoomLoaded] = useState(false);
  const [roomMountNonce, setRoomMountNonce] = useState(0);
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const [mediaWarning, setMediaWarning] = useState<string | null>(null);
  const [roomStartHelpVisible, setRoomStartHelpVisible] = useState(false);
  const [liveKitTrackVersion, setLiveKitTrackVersion] = useState(0);
  const [mobileRoomMenuOpen, setMobileRoomMenuOpen] = useState(false);
  const [copiedIngestField, setCopiedIngestField] = useState<string | null>(null);
  const [utilityPanel, setUtilityPanel] = useState<LiveUtilityPanel>(null);
  const [detailTab, setDetailTab] = useState<LiveDetailTabKey>('overview');
  const [roomPanelTab, setRoomPanelTab] = useState<LiveRoomTabKey>('chat');
  const [remindersEnabled, setRemindersEnabled] = useState(false);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const [participantSearch, setParticipantSearch] = useState('');
  const [selectedPollOption, setSelectedPollOption] = useState<string | null>(null);
  const liveKitRoomRef = useRef<Room | null>(null);
  const mobileLiveKitStageRef = useRef<HTMLVideoElement | null>(null);
  const desktopLiveKitStageRef = useRef<HTMLVideoElement | null>(null);
  const mobileLiveKitLocalPreviewRef = useRef<HTMLVideoElement | null>(null);
  const desktopLiveKitLocalPreviewRef = useRef<HTMLVideoElement | null>(null);
  const mobileLiveKitAudioSinkRef = useRef<HTMLDivElement | null>(null);
  const desktopLiveKitAudioSinkRef = useRef<HTMLDivElement | null>(null);
  const liveKitAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const viewRef = useRef(view);
  const accessRef = useRef(access);
  const localMediaRef = useRef({
    micMuted: !isAdmin,
    videoEnabled: Boolean(isAdmin),
    isScreenSharing: false,
    roomLoaded: false,
  });
  const desiredMediaStateRef = useRef({
    micMuted: !isAdmin,
    videoEnabled: Boolean(isAdmin),
    isScreenSharing: false,
    canSpeak: Boolean(isAdmin),
  });
  const liveKitReconcileInFlightRef = useRef({
    camera: false,
    microphone: false,
    screenShare: false,
  });
  const intentionalExitRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const liveKitRetryTimerRef = useRef<number | null>(null);
  const syncTimerRef = useRef<number | null>(null);
  const shareToggleTimerRef = useRef<number | null>(null);
  const overviewRefreshTimerRef = useRef<number | null>(null);
  const lastOverviewRefreshAtRef = useRef(0);
  const activeJoinAttemptRef = useRef(0);
  const wantedScreenShareStateRef = useRef<boolean | null>(null);
  const cameraBeforeScreenShareRef = useRef(Boolean(isAdmin));
  const todaySectionRef = useRef<HTMLDivElement | null>(null);
  const tomorrowSectionRef = useRef<HTMLDivElement | null>(null);
  const remindersSectionRef = useRef<HTMLDivElement | null>(null);
  const mobileDetailContentRef = useRef<HTMLDivElement | null>(null);
  const desktopDetailContentRef = useRef<HTMLDivElement | null>(null);
  const mobileRoomStageRef = useRef<HTMLDivElement | null>(null);
  const desktopRoomStageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    viewRef.current = view;
    if (view !== 'room') {
      setMobileRoomMenuOpen(false);
    }
    onMobileModeChange?.(view);
  }, [onMobileModeChange, view]);

  useEffect(() => {
    accessRef.current = access;
  }, [access]);

  useEffect(() => {
    localMediaRef.current = {
      micMuted: localMicMuted,
      videoEnabled: localVideoEnabled,
      isScreenSharing: localScreenSharing,
      roomLoaded,
    };
  }, [localMicMuted, localVideoEnabled, localScreenSharing, roomLoaded]);

  useEffect(() => () => {
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    if (liveKitRetryTimerRef.current) {
      window.clearTimeout(liveKitRetryTimerRef.current);
    }
    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
    }
    if (shareToggleTimerRef.current) {
      window.clearTimeout(shareToggleTimerRef.current);
    }
    if (overviewRefreshTimerRef.current) {
      window.clearTimeout(overviewRefreshTimerRef.current);
    }
    disposeLiveKit();
  }, []);

  useEffect(() => {
    const sanitizedLiveClasses = sanitizeLiveClasses(overview.liveClasses);
    setLiveClasses(sanitizedLiveClasses);
    if (!selectedLiveClassId && sanitizedLiveClasses[0]?._id) {
      setSelectedLiveClassId(sanitizedLiveClasses[0]._id);
    }
  }, [overview.liveClasses, selectedLiveClassId]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    void EduService.getAdminLiveClasses()
      .then((response) => {
        setLiveClasses(sanitizeLiveClasses(response.liveClasses));
      })
      .catch(() => undefined);
  }, [isAdmin, overview.liveClasses]);

  useEffect(() => {
    if (!initialLiveClassId) {
      return;
    }

    void openLiveClass(initialLiveClassId).then(() => {
      setView('detail');
      onInitialLiveClassHandled?.();
    });
  }, [initialLiveClassId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setRemindersEnabled(window.localStorage.getItem('edumaster.live.reminders') === 'true');
  }, []);

  useEffect(() => {
    if (!uiNotice || typeof window === 'undefined') {
      return;
    }
    const timer = window.setTimeout(() => setUiNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [uiNotice]);

  const isReferenceMode = useMemo(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return new URLSearchParams(window.location.search).get('liveReferenceMode') === 'figma';
  }, []);

  const orderedLiveClasses = useMemo(() => {
    const rank = (status?: string | null) => {
      const value = String(status || '').toLowerCase();
      if (value === 'live') return 0;
      if (value === 'scheduled' || value === 'upcoming') return 1;
      if (value === 'ended') return 3;
      return 2;
    };

    return sanitizeLiveClasses(liveClasses).sort((left, right) => {
      const statusDelta = rank(left?.status) - rank(right?.status);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      return Date.parse(left?.startTime || '') - Date.parse(right?.startTime || '');
    });
  }, [liveClasses]);

  const selectedLiveClass = useMemo(
    () => liveClasses.find((item) => item._id === selectedLiveClassId) || orderedLiveClasses[0] || EMPTY_LIVE_CLASS,
    [liveClasses, orderedLiveClasses, selectedLiveClassId],
  );
  const hasSelectedLiveClass = Boolean(selectedLiveClass?._id);

  const featuredLiveClass = useMemo(
    () => orderedLiveClasses.find((item) => getLiveStatusValue(item) === 'live')
      || orderedLiveClasses.find((item) => ['scheduled', 'upcoming'].includes(getLiveStatusValue(item)))
      || orderedLiveClasses[0]
      || null,
    [orderedLiveClasses],
  );
  const referenceClassBindings = useMemo(() => {
    const fallbackId = selectedLiveClassId || orderedLiveClasses[0]?._id || overview.liveClasses?.[0]?._id || '';
    return {
      featuredId: orderedLiveClasses[0]?._id || fallbackId,
      todayIds: [0, 1, 2].map((index) => orderedLiveClasses[index]?._id || fallbackId),
      tomorrowId: orderedLiveClasses[3]?._id || orderedLiveClasses[1]?._id || fallbackId,
    };
  }, [orderedLiveClasses, overview.liveClasses, selectedLiveClassId]);
  const selfParticipant = useMemo(
    () => session?.participants.find((entry) => entry.userId === user?._id) || null,
    [session?.participants, user?._id],
  );
  const liveKitJoinKey = (
    view === 'room'
    && access?.accessType === 'livekit-room'
    && access.liveClassId
    && access.liveKitUrl
    && access.liveKitToken
  )
    ? `${access.liveClassId}:${access.liveKitUrl}`
    : '';
  const isInteractiveLiveRoom = access?.accessType === 'livekit-room';
  const isBroadcastLiveStream = access?.accessType === 'live-stream';
  const showInteractiveRoomControls = isInteractiveLiveRoom;
  const showRaiseHandControl = isInteractiveLiveRoom && !isAdmin;
  const showPresenterScreenShareControl = isInteractiveLiveRoom && isAdmin;
  const broadcastModeNotice = isBroadcastLiveStream
    ? 'This class is running in broadcast mode for scale. Camera, microphone, and screen sharing stay with the teacher studio.'
    : null;
  const liveLifecycleMessage = useMemo(() => {
    const currentAccess = access;
    const currentClass = selectedLiveClass;
    const replayReady = Boolean(currentClass?.replayReady);
    const replayState = String(currentAccess?.replayState || currentClass?.replayState || '').toLowerCase();
    const recordingState = String(currentAccess?.recordingState || currentClass?.recordingState || '').toLowerCase();
    const currentStatus = String(currentAccess?.status || currentClass?.status || '').toLowerCase();
    const statusMessage = String(currentAccess?.statusMessage || '').trim();

    if (currentStatus === 'live' && statusMessage) {
      return statusMessage;
    }
    if (replayReady || replayState === 'replay_ready') {
      return 'Replay is ready and available for protected playback.';
    }
    if (recordingState === 'recording') {
      return 'The class is being recorded while it is live.';
    }
    if (recordingState === 'processing' || replayState === 'processing') {
      return 'Recording is processing. Replay will appear here after upload finishes.';
    }
    if (currentStatus === 'ended') {
      return 'This live class has ended. Replay will appear here once processing completes.';
    }
    return statusMessage || null;
  }, [access, selectedLiveClass]);

  const queueOverviewRefresh = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const elapsed = Date.now() - lastOverviewRefreshAtRef.current;
    const runRefresh = () => {
      overviewRefreshTimerRef.current = null;
      lastOverviewRefreshAtRef.current = Date.now();
      void onRefresh();
    };

    if (elapsed >= 1600) {
      runRefresh();
      return;
    }

    if (overviewRefreshTimerRef.current) {
      return;
    }

    overviewRefreshTimerRef.current = window.setTimeout(runRefresh, 1600 - elapsed);
  }, [onRefresh]);

  const syncLiveClassFromAccess = useCallback((liveClassId: string, accessResponse: LiveClassAccess) => {
    setLiveClasses((current) => sanitizeLiveClasses(current).map((liveClass) => {
      if (liveClass?._id !== liveClassId) {
        return liveClass;
      }
      return {
        ...liveClass,
        status: accessResponse.status || liveClass?.status,
        livePlaybackType: accessResponse.accessType === 'live-stream'
          ? 'live-stream'
          : accessResponse.accessType === 'livekit-room'
            ? 'livekit'
            : liveClass.livePlaybackType,
        livePlaybackUrl: accessResponse.streamUrl || liveClass.livePlaybackUrl || null,
        roomName: accessResponse.liveRoomName || liveClass.roomName || null,
        roomUrl: accessResponse.roomUrl || liveClass.roomUrl || null,
        embedUrl: accessResponse.embedUrl || liveClass.embedUrl || null,
      };
    }));
  }, []);

  const refreshDetailState = useCallback(async (
    liveClassId: string,
    options?: {
      includeAccess?: boolean;
      includeChat?: boolean;
      includeSession?: boolean;
    },
  ) => {
    if (options?.includeAccess !== false || options?.includeChat || options?.includeSession) {
      setError(null);
    }
    try {
      const tasks: Array<Promise<void>> = [];

      if (options?.includeAccess !== false) {
        tasks.push(
          EduService.getLiveClassAccess(liveClassId).then((accessResponse) => {
            setAccess(accessResponse);
            syncLiveClassFromAccess(liveClassId, accessResponse);
          }),
        );
      }

      if (options?.includeSession) {
        tasks.push(
          EduService.getLiveSessionState(liveClassId).then((sessionResponse) => {
            setSession(sessionResponse.session || null);
          }),
        );
      }

      if (options?.includeChat) {
        tasks.push(
          EduService.getLiveClassChat(liveClassId).then((chatResponse) => {
            setMessages(chatResponse.messages || []);
          }),
        );
      }

      await Promise.all(tasks);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load this live class.');
    }
  }, [syncLiveClassFromAccess]);

  useEffect(() => {
    if (!selectedLiveClass?._id || !user || view !== 'detail') {
      return;
    }

    void refreshDetailState(selectedLiveClass._id, {
      includeAccess: true,
      includeChat: detailTab === 'chat',
      includeSession: false,
    });

    const selectedStatusValue = getLiveStatusValue(selectedLiveClass);
    if (selectedStatusValue === 'ended') {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshDetailState(selectedLiveClass._id, {
        includeAccess: true,
        includeChat: false,
        includeSession: false,
      });
    }, 7000);

    return () => window.clearInterval(interval);
  }, [detailTab, refreshDetailState, selectedLiveClass?._id, selectedLiveClass?.status, user, view]);

  useEffect(() => {
    if (!selectedLiveClass?._id || !user || view !== 'room') {
      return;
    }
    void refreshDetailState(selectedLiveClass._id, {
      includeAccess: false,
      includeChat: view === 'room' || detailTab === 'chat',
      includeSession: true,
    });
  }, [detailTab, refreshDetailState, selectedLiveClass?._id, user, view]);

  const logMedia = (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => {
    const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    if (meta !== undefined) {
      logger(`[LiveMedia] ${message}`, meta);
      return;
    }
    logger(`[LiveMedia] ${message}`);
  };

  const clearShareToggleTimeout = () => {
    if (shareToggleTimerRef.current) {
      window.clearTimeout(shareToggleTimerRef.current);
      shareToggleTimerRef.current = null;
    }
  };

  const clearLiveKitRetryTimer = () => {
    if (liveKitRetryTimerRef.current) {
      window.clearTimeout(liveKitRetryTimerRef.current);
      liveKitRetryTimerRef.current = null;
    }
  };

  const isTransientLiveKitPublishError = (error: unknown) => {
    const message = getErrorMessage(error).toLowerCase();
    return (
      message.includes('engine not connected')
      || message.includes('not connected within timeout')
      || message.includes('client initiated disconnect')
      || message.includes('connection error')
      || message.includes('reconnecting')
    );
  };

  const scheduleLiveKitMediaRetry = (reason: string, delay = 650) => {
    if (typeof window === 'undefined') {
      return;
    }

    clearLiveKitRetryTimer();
    liveKitRetryTimerRef.current = window.setTimeout(() => {
      liveKitRetryTimerRef.current = null;
      if (
        viewRef.current !== 'room'
        || accessRef.current?.accessType !== 'livekit-room'
        || !isLiveKitRoomConnected(liveKitRoomRef.current)
      ) {
        return;
      }
      applyDesiredMediaState(reason);
    }, delay);
  };

  const disposeLiveKitAudio = () => {
    liveKitAudioElementsRef.current.forEach((element) => {
      try {
        element.pause();
      } catch {
        // Ignore pause failures during cleanup.
      }
      element.remove();
    });
    liveKitAudioElementsRef.current.clear();
  };

  const disposeLiveKit = () => {
    const room = liveKitRoomRef.current;
    clearLiveKitRetryTimer();
    liveKitReconcileInFlightRef.current.camera = false;
    liveKitReconcileInFlightRef.current.microphone = false;
    liveKitReconcileInFlightRef.current.screenShare = false;
    if (room) {
      room.disconnect(true);
      liveKitRoomRef.current = null;
    }
    disposeLiveKitAudio();
    setLiveKitTrackVersion((current) => current + 1);
  };

  const collectLiveKitTracks = () => {
    const room = liveKitRoomRef.current;
    if (!room) {
      return [] as LiveKitTrackEntry[];
    }

    const entries: LiveKitTrackEntry[] = [];
    const pushParticipantTracks = (participant: any, isLocal: boolean) => {
      participant.trackPublications.forEach((publication: any) => {
        if (!publication?.track) {
          return;
        }
        entries.push({
          trackSid: publication.trackSid || publication.track.sid || `${participant.identity}-${publication.source}-${publication.kind}`,
          participantIdentity: participant.identity,
          participantName: participant.name || participant.identity,
          source: publication.source,
          kind: publication.kind,
          isLocal,
          isMuted: Boolean(publication.isMuted),
          track: publication.track,
        });
      });
    };

    pushParticipantTracks(room.localParticipant, true);
    room.remoteParticipants.forEach((participant) => pushParticipantTracks(participant, false));
    return entries;
  };

  const getPreferredStageTrack = (tracks: LiveKitTrackEntry[]) => {
    const selfIdentity = access?.liveKitIdentity || user?._id || '';
    const screenShareTrack = tracks.find((entry) => entry.kind === Track.Kind.Video && entry.source === Track.Source.ScreenShare && !entry.isMuted);
    if (screenShareTrack) {
      return screenShareTrack;
    }

    const remoteCameraTrack = tracks.find((entry) =>
      entry.kind === Track.Kind.Video
      && entry.source === Track.Source.Camera
      && !entry.isMuted
      && !entry.isLocal);
    if (remoteCameraTrack) {
      return remoteCameraTrack;
    }

    const localCameraTrack = tracks.find((entry) =>
      entry.kind === Track.Kind.Video
      && entry.source === Track.Source.Camera
      && !entry.isMuted
      && entry.participantIdentity === selfIdentity);
    if (localCameraTrack) {
      return localCameraTrack;
    }

    const remoteVideoTrack = tracks.find((entry) =>
      entry.kind === Track.Kind.Video
      && !entry.isMuted
      && !entry.isLocal);
    if (remoteVideoTrack) {
      return remoteVideoTrack;
    }

    const localVideoTrack = tracks.find((entry) =>
      entry.kind === Track.Kind.Video
      && !entry.isMuted
      && entry.participantIdentity === selfIdentity);
    if (localVideoTrack) {
      return localVideoTrack;
    }

    return null;
  };

  const getLocalPreviewTrack = (tracks: LiveKitTrackEntry[]) => (
    tracks.find((entry) =>
      entry.kind === Track.Kind.Video
      && entry.source === Track.Source.Camera
      && !entry.isMuted
      && entry.isLocal)
    || tracks.find((entry) =>
      entry.kind === Track.Kind.Video
      && !entry.isMuted
      && entry.isLocal)
    || null
  );

  const syncLiveKitTrackState = () => {
    setLiveKitTrackVersion((current) => current + 1);
  };

  useEffect(() => {
    if (view !== 'room' || !isInteractiveLiveRoom) {
      setRoomStartHelpVisible(false);
      setMediaWarning((current) => (
        current === 'The live room has not fully connected yet. Wait for the classroom to finish joining before using camera, mic, or screen share.'
          ? null
          : current
      ));
      return;
    }

    if (roomLoaded) {
      setRoomStartHelpVisible(false);
      return;
    }

    const timer = window.setTimeout(() => {
      if (!localMediaRef.current.roomLoaded) {
        setRoomStartHelpVisible(true);
        setMediaWarning('The live room has not fully connected yet. Wait for the classroom to finish joining before using camera, mic, or screen share.');
      }
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [isInteractiveLiveRoom, view, roomLoaded]);

  const ensureMediaPermissions = async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return;
    }

    const wantsVideo = Boolean(isAdmin || selfParticipant?.videoEnabled);
    const wantsAudio = Boolean(isAdmin || selfParticipant?.canSpeak || !isAdmin);
    if (!wantsVideo && !wantsAudio) {
      return;
    }

    setMediaNotice('Checking camera and microphone permissions...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: wantsAudio,
        video: wantsVideo,
      });
      stream.getTracks().forEach((track) => track.stop());
      setMediaNotice(null);
      setMediaWarning(null);
      logMedia('info', 'Browser media permissions granted.', { wantsAudio, wantsVideo });
    } catch (nextError) {
      const message = getErrorMessage(nextError);
      logMedia('warn', 'Browser media permission preflight failed.', { wantsAudio, wantsVideo, error: message });
      setMediaNotice(null);
      setMediaWarning(
        isAdmin
          ? 'Camera or microphone access was blocked. Allow browser media permissions to publish live audio and video.'
          : 'Microphone access is blocked. You can keep watching, but speaking will stay unavailable until permission is granted.',
      );
    }
  };

  const requestRoomRemount = (reason: string) => {
    if (viewRef.current !== 'room' || !accessRef.current?.liveClassId) {
      return;
    }

    if (reconnectAttemptsRef.current >= 2) {
      setRoomLoaded(false);
      setMediaNotice(null);
      setMediaWarning('Live media connection was lost. Please re-open the classroom if audio or video does not recover.');
      logMedia('error', 'Maximum live media reconnect attempts reached.', { reason, liveClassId: accessRef.current.liveClassId });
      return;
    }

    reconnectAttemptsRef.current += 1;
    setRoomLoaded(false);
    setMediaNotice('Reconnecting live media...');
    setMediaWarning(null);
    logMedia('warn', 'Re-mounting live classroom media.', {
      reason,
      attempt: reconnectAttemptsRef.current,
      liveClassId: accessRef.current.liveClassId,
    });
    disposeLiveKit();
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    reconnectTimerRef.current = window.setTimeout(() => {
      setRoomMountNonce((current) => current + 1);
    }, 1200 * reconnectAttemptsRef.current);
  };

  const applyDesiredMediaState = (reason: string) => {
    const liveKitRoom = liveKitRoomRef.current;
    if (accessRef.current?.accessType === 'livekit-room' && liveKitRoom) {
      if (!isLiveKitRoomConnected(liveKitRoom)) {
        logMedia('info', 'Skipping LiveKit media reconciliation until the room is connected.', {
          reason,
          connectionState: liveKitRoom.state,
        });
        return;
      }
      const desired = desiredMediaStateRef.current;
      const local = localMediaRef.current;
      logMedia('info', 'Reconciling LiveKit media state.', { reason, desired, local });

      if (Boolean(desired.videoEnabled) !== Boolean(local.videoEnabled) && !liveKitReconcileInFlightRef.current.camera) {
        liveKitReconcileInFlightRef.current.camera = true;
        void liveKitRoom.localParticipant.setCameraEnabled(Boolean(desired.videoEnabled))
          .catch((nextError) => {
            if (isTransientLiveKitPublishError(nextError)) {
              logMedia('info', 'Retrying LiveKit camera publish after a transient connection delay.', nextError);
              scheduleLiveKitMediaRetry('camera-retry');
              return;
            }
            logMedia('warn', 'Unable to reconcile LiveKit camera state.', nextError);
          })
          .finally(() => {
            liveKitReconcileInFlightRef.current.camera = false;
          });
      }

      const shouldEnableMic = Boolean(!desired.micMuted && (isAdmin || desired.canSpeak));
      if (Boolean(!local.micMuted) !== shouldEnableMic && !liveKitReconcileInFlightRef.current.microphone) {
        liveKitReconcileInFlightRef.current.microphone = true;
        void liveKitRoom.localParticipant.setMicrophoneEnabled(shouldEnableMic)
          .catch((nextError) => {
            if (isTransientLiveKitPublishError(nextError)) {
              logMedia('info', 'Retrying LiveKit microphone publish after a transient connection delay.', nextError);
              scheduleLiveKitMediaRetry('microphone-retry');
              return;
            }
            logMedia('warn', 'Unable to reconcile LiveKit microphone state.', nextError);
          })
          .finally(() => {
            liveKitReconcileInFlightRef.current.microphone = false;
          });
      }

      if (
        isAdmin
        && desired.isScreenSharing !== local.isScreenSharing
        && !liveKitReconcileInFlightRef.current.screenShare
      ) {
        liveKitReconcileInFlightRef.current.screenShare = true;
        void liveKitRoom.localParticipant.setScreenShareEnabled(Boolean(desired.isScreenSharing))
          .catch((nextError) => {
            if (isTransientLiveKitPublishError(nextError)) {
              logMedia('info', 'Retrying LiveKit screen share publish after a transient connection delay.', nextError);
              scheduleLiveKitMediaRetry('screen-share-retry', 900);
              return;
            }
            logMedia('warn', 'Unable to reconcile LiveKit screen share state.', nextError);
            setMediaWarning(desired.isScreenSharing
              ? 'Screen sharing was blocked or cancelled. Allow display capture and try again.'
              : 'Screen sharing could not be stopped cleanly. Please try again.');
          })
          .finally(() => {
            liveKitReconcileInFlightRef.current.screenShare = false;
          });
      }
      return;
    }

    return;
  };

  useEffect(() => {
    if (!selectedLiveClass?._id || !user || view === 'list') {
      return;
    }

    const source = EduService.createLiveEventsStream(selectedLiveClass._id);
    const handleEvent = (rawEvent: MessageEvent) => {
      const payload = JSON.parse(rawEvent.data) as LiveClassEventPayload;
      if (payload.session) {
        setSession(payload.session);
      }
      if (payload.message) {
        setMessages((current) => {
          if (current.some((entry) => entry._id === payload.message?._id)) {
            return current;
          }
          return [...current, payload.message as LiveClassChatMessage];
        });
      }
      if (
        payload.liveClass
        && payload.liveClassId === selectedLiveClass._id
        && payload.event.startsWith('live-class.')
      ) {
        setLiveClasses((current) => sanitizeLiveClasses(current).map((item) => (
          item?._id === payload.liveClassId
            ? ({
              ...item,
              ...payload.liveClass,
              activePoll: payload.liveClass?.activePoll ?? item.activePoll,
            } as LiveClass)
            : item
        )));
        void refreshDetailState(selectedLiveClass._id, {
          includeAccess: true,
          includeSession: true,
          includeChat: false,
        }).catch(() => undefined);
        queueOverviewRefresh();
      }
      if (payload.event === 'session.updated' || payload.event === 'session.snapshot') {
        if (accessRef.current?.accessType === 'livekit-room') {
          void EduService.getLiveClassAccess(selectedLiveClass._id)
            .then(setAccess)
            .catch(() => undefined);
        }
        queueOverviewRefresh();
      }
      if (payload.event === 'participant.removed' && payload.participant?.userId === user._id) {
        intentionalExitRef.current = true;
        clearActiveLiveRoom();
        setError('You were removed from this class by the admin.');
        setView('detail');
        liveKitRoomRef.current?.disconnect(true);
      }
    };

    source.onmessage = handleEvent;
    [
      'session.snapshot',
      'session.updated',
      'participant.joined',
      'participant.left',
      'participant.media-updated',
      'participant.hand-updated',
      'participant.speaking-updated',
      'participant.mute-updated',
      'participant.removed',
      'chat.message',
    ].forEach((eventName) => source.addEventListener(eventName, handleEvent as EventListener));

    return () => source.close();
  }, [queueOverviewRefresh, selectedLiveClass?._id, user?._id, view]);

  useEffect(() => {
    if (access?.accessType === 'livekit-room' && isAdmin) {
      if (view !== 'room' || !roomLoaded) {
        return;
      }

      if (syncTimerRef.current) {
        window.clearTimeout(syncTimerRef.current);
      }
      syncTimerRef.current = window.setTimeout(() => {
        applyDesiredMediaState('session-update');
      }, 200);
      return;
    }

    desiredMediaStateRef.current = {
      micMuted: selfParticipant?.micMuted ?? !isAdmin,
      videoEnabled: selfParticipant?.videoEnabled ?? Boolean(isAdmin),
      isScreenSharing: selfParticipant?.isScreenSharing ?? false,
      canSpeak: selfParticipant?.canSpeak ?? Boolean(isAdmin),
    };

    if (view !== 'room' || !roomLoaded) {
      return;
    }

    if (syncTimerRef.current) {
      window.clearTimeout(syncTimerRef.current);
    }
    syncTimerRef.current = window.setTimeout(() => {
      applyDesiredMediaState('session-update');
    }, 200);
  }, [
    selfParticipant?.micMuted,
    selfParticipant?.videoEnabled,
    selfParticipant?.isScreenSharing,
    selfParticipant?.canSpeak,
    isAdmin,
    view,
    roomLoaded,
  ]);

  useEffect(() => {
    if (view !== 'room' || !selectedLiveClass?._id) {
      return;
    }

    const interval = window.setInterval(() => {
      void EduService.heartbeatLiveSession(selectedLiveClass._id).catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(interval);
  }, [view, selectedLiveClass?._id]);

  useEffect(() => {
    const participant = session?.participants.find((entry) => entry.userId === user?._id) || null;
    if (!participant) {
      return;
    }

    if (access?.accessType === 'livekit-room') {
      applyDesiredMediaState('participant-state-sync');
      return;
    }

  }, [access?.accessType, session, user?._id, localMicMuted]);

  useEffect(() => {
    const currentStatus = session?.status || access?.status;
    if (view !== 'room' || String(currentStatus).toLowerCase() !== 'ended') {
      return;
    }

    intentionalExitRef.current = true;
    clearActiveLiveRoom();
    setMediaNotice(null);
    setMediaWarning('The live class has ended.');
    liveKitRoomRef.current?.disconnect(true);
    setView('detail');
  }, [session?.status, access?.status, view]);

  useEffect(() => {
    if (
      !liveKitJoinKey
      || !user
    ) {
      return;
    }
    let cancelled = false;
    const room = new Room();
    liveKitRoomRef.current = room;
    setMediaWarning(null);
    setMediaNotice('Connecting to the live classroom...');
    setRoomLoaded(false);

    const refreshTracks = () => {
      if (cancelled) {
        return;
      }
      syncLiveKitTrackState();
    };

    const scheduleTrackRefreshBurst = () => {
      [250, 700, 1400, 2400, 3600].forEach((delay) => {
        window.setTimeout(() => {
          if (!cancelled) {
            refreshTracks();
          }
        }, delay);
      });
    };

    room
      .on(RoomEvent.Connected, async () => {
        reconnectAttemptsRef.current = 0;
        clearLiveKitRetryTimer();
        setRoomLoaded(true);
        setMediaWarning(null);
        setMediaNotice('Connected to the live classroom.');
        rememberActiveLiveRoom(access.liveClassId);
        refreshTracks();
        scheduleTrackRefreshBurst();
        window.setTimeout(() => {
          if (!cancelled) {
            applyDesiredMediaState('room-connected');
          }
        }, 180);
        try {
          await room.startAudio();
        } catch (nextError) {
          logMedia('warn', 'LiveKit audio autoplay needs user interaction.', nextError);
          setMediaWarning('Audio playback is blocked by the browser. Tap anywhere in the classroom and try again if you cannot hear the class.');
        }
        window.setTimeout(() => {
          setMediaNotice(null);
        }, 500);
      })
      .on(RoomEvent.Reconnecting, () => {
        clearLiveKitRetryTimer();
        setRoomLoaded(false);
        setMediaNotice('Reconnecting live media...');
        refreshTracks();
      })
      .on(RoomEvent.Reconnected, async () => {
        clearLiveKitRetryTimer();
        setRoomLoaded(true);
        setMediaWarning(null);
        setMediaNotice('Reconnected to the live classroom.');
        refreshTracks();
        scheduleTrackRefreshBurst();
        window.setTimeout(() => {
          if (!cancelled) {
            applyDesiredMediaState('room-reconnected');
          }
        }, 180);
        try {
          await room.startAudio();
        } catch {
          // Ignore autoplay retries here and keep the warning from the initial attempt.
        }
        window.setTimeout(() => {
          setMediaNotice(null);
        }, 500);
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        clearLiveKitRetryTimer();
        setRoomLoaded(false);
        refreshTracks();
        if (cancelled || intentionalExitRef.current || viewRef.current !== 'room') {
          setMediaNotice(null);
          return;
        }
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
          clearActiveLiveRoom();
          setError('You were removed from this class by the admin.');
          setView('detail');
          return;
        }
        if (reason === DisconnectReason.ROOM_DELETED) {
          clearActiveLiveRoom();
          setMediaWarning('The live class has ended.');
          setView('detail');
          return;
        }
        requestRoomRemount(`livekit-disconnected:${String(reason || 'unknown')}`);
      })
      .on(RoomEvent.TrackSubscribed, refreshTracks)
      .on(RoomEvent.TrackUnsubscribed, refreshTracks)
      .on(RoomEvent.TrackMuted, refreshTracks)
      .on(RoomEvent.TrackUnmuted, refreshTracks)
      .on(RoomEvent.LocalTrackPublished, refreshTracks)
      .on(RoomEvent.LocalTrackUnpublished, refreshTracks)
      .on(RoomEvent.ParticipantConnected, refreshTracks)
      .on(RoomEvent.ParticipantDisconnected, refreshTracks)
      .on(RoomEvent.MediaDevicesError, (nextError: Error) => {
        logMedia('warn', 'LiveKit media device error.', nextError);
        setMediaWarning(getErrorMessage(nextError));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (!room.canPlaybackAudio) {
          setMediaWarning('Browser audio playback is blocked. Interact with the page to allow classroom audio.');
        }
      })
      .on(RoomEvent.VideoPlaybackStatusChanged, () => {
        refreshTracks();
      });

    const connect = async () => {
      await ensureMediaPermissions();
      if (cancelled) {
        return;
      }
      await room.connect(access.liveKitUrl as string, access.liveKitToken as string, {
        autoSubscribe: true,
      });
      if (cancelled) {
        room.disconnect(true);
        return;
      }

      const shouldEnableMic = Boolean(!desiredMediaStateRef.current.micMuted && (isAdmin || desiredMediaStateRef.current.canSpeak));
      const shouldEnableVideo = Boolean(desiredMediaStateRef.current.videoEnabled);

      setLocalVideoEnabled(shouldEnableVideo);
      setLocalMicMuted(!shouldEnableMic);

      if (access.liveClassId) {
        void EduService.updateLiveMediaState(access.liveClassId, {
          micMuted: !shouldEnableMic,
          videoEnabled: shouldEnableVideo,
        }).catch((nextError) => {
          logMedia('warn', 'Unable to sync initial LiveKit media state to the live session.', nextError);
        });
      }

      refreshTracks();
      scheduleTrackRefreshBurst();
      window.setTimeout(() => {
        if (!cancelled) {
          applyDesiredMediaState('post-connect-sync');
        }
      }, 240);
    };

    void connect().catch((nextError) => {
      if (cancelled) {
        return;
      }
      logMedia('error', 'Unable to start the LiveKit classroom.', nextError);
      setMediaNotice(null);
      setError(nextError instanceof Error ? nextError.message : 'Unable to start classroom.');
      requestRoomRemount('livekit-mount-failed');
    });

    return () => {
      cancelled = true;
      room.removeAllListeners();
      room.disconnect(true);
      if (liveKitRoomRef.current === room) {
        liveKitRoomRef.current = null;
      }
      disposeLiveKitAudio();
      setRoomLoaded(false);
      syncLiveKitTrackState();
    };
  }, [
    isAdmin,
    liveKitJoinKey,
    roomMountNonce,
    user?._id,
  ]);

  const liveKitTracks = useMemo(() => collectLiveKitTracks(), [liveKitTrackVersion]);
  const liveKitStageTrack = useMemo(() => getPreferredStageTrack(liveKitTracks), [liveKitTracks]);
  const liveKitLocalPreviewTrack = useMemo(() => getLocalPreviewTrack(liveKitTracks), [liveKitTracks]);
  const liveKitActiveStageTrack = liveKitStageTrack || liveKitLocalPreviewTrack;

  useEffect(() => {
    if (access?.accessType !== 'livekit-room') {
      return;
    }

    const localMicrophoneTrack = liveKitTracks.find((entry) => entry.isLocal && entry.source === Track.Source.Microphone);
    const localCameraTrack = liveKitTracks.find((entry) =>
      entry.isLocal
      && entry.kind === Track.Kind.Video
      && (
        entry.source === Track.Source.Camera
        || entry.source === Track.Source.ScreenShare
        || entry.source === Track.Source.Unknown
      ));
    const localScreenTrack = liveKitTracks.find((entry) => entry.isLocal && entry.source === Track.Source.ScreenShare);

    const nextMicMuted = !localMicrophoneTrack || localMicrophoneTrack.isMuted;
    const nextVideoEnabled = Boolean(localCameraTrack && !localCameraTrack.isMuted);
    const nextScreenSharing = Boolean(localScreenTrack && !localScreenTrack.isMuted);

    setLocalMicMuted(nextMicMuted);
    setLocalVideoEnabled(nextVideoEnabled);
    setLocalScreenSharing(nextScreenSharing);
  }, [access?.accessType, liveKitTracks]);

  useEffect(() => {
    const stageElements = [mobileLiveKitStageRef.current, desktopLiveKitStageRef.current].filter(Boolean) as HTMLVideoElement[];
    if (stageElements.length === 0) {
      return;
    }

    stageElements.forEach((stageElement) => {
      stageElement.muted = Boolean(liveKitActiveStageTrack?.isLocal);
      stageElement.playsInline = true;
      stageElement.autoplay = true;

      if (!liveKitActiveStageTrack) {
        stageElement.pause();
        stageElement.srcObject = null;
      }
    });

    if (!liveKitActiveStageTrack) {
      return;
    }

    stageElements.forEach((stageElement) => {
      liveKitActiveStageTrack.track.attach(stageElement);
      void stageElement.play().catch(() => undefined);
    });
    return () => {
      stageElements.forEach((stageElement) => {
        liveKitActiveStageTrack.track.detach(stageElement);
      });
    };
  }, [liveKitActiveStageTrack]);

  useEffect(() => {
    const previewElements = [mobileLiveKitLocalPreviewRef.current, desktopLiveKitLocalPreviewRef.current].filter(Boolean) as HTMLVideoElement[];
    if (previewElements.length === 0) {
      return;
    }

    previewElements.forEach((previewElement) => {
      previewElement.muted = true;
      previewElement.playsInline = true;
      previewElement.autoplay = true;

      if (!liveKitLocalPreviewTrack || liveKitLocalPreviewTrack.trackSid === liveKitActiveStageTrack?.trackSid) {
        previewElement.pause();
        previewElement.srcObject = null;
      }
    });

    if (!liveKitLocalPreviewTrack || liveKitLocalPreviewTrack.trackSid === liveKitActiveStageTrack?.trackSid) {
      return;
    }

    previewElements.forEach((previewElement) => {
      liveKitLocalPreviewTrack.track.attach(previewElement);
      void previewElement.play().catch(() => undefined);
    });
    return () => {
      previewElements.forEach((previewElement) => {
        liveKitLocalPreviewTrack.track.detach(previewElement);
      });
    };
  }, [liveKitLocalPreviewTrack, liveKitActiveStageTrack?.trackSid]);

  useEffect(() => {
    if (
      access?.accessType !== 'livekit-room'
      || view !== 'room'
      || !roomLoaded
      || !isAdmin
      || !selectedLiveClass?._id
      || liveKitActiveStageTrack
      || !liveKitRoomRef.current
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (!isLiveKitRoomConnected(liveKitRoomRef.current)) {
        return;
      }
      desiredMediaStateRef.current = {
        ...desiredMediaStateRef.current,
        videoEnabled: true,
      };
      setLocalVideoEnabled(true);
      void liveKitRoomRef.current?.localParticipant.setCameraEnabled(true)
        .then(() => EduService.updateLiveMediaState(selectedLiveClass._id, { videoEnabled: true }))
        .catch((nextError) => {
          logMedia('warn', 'Automatic LiveKit camera recovery failed.', nextError);
        });
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [
    access?.accessType,
    isAdmin,
    liveKitActiveStageTrack,
    roomLoaded,
    selectedLiveClass?._id,
    view,
  ]);

  useEffect(() => {
    const audioSink = mobileLiveKitAudioSinkRef.current || desktopLiveKitAudioSinkRef.current;
    if (!audioSink) {
      return;
    }

    const audioTracks = liveKitTracks.filter((entry) => entry.kind === Track.Kind.Audio && !entry.isLocal && !entry.isMuted);
    const activeTrackIds = new Set(audioTracks.map((entry) => entry.trackSid));

    liveKitAudioElementsRef.current.forEach((element, trackSid) => {
      if (!activeTrackIds.has(trackSid)) {
        element.pause();
        element.remove();
        liveKitAudioElementsRef.current.delete(trackSid);
      }
    });

    audioTracks.forEach((entry) => {
      const existing = liveKitAudioElementsRef.current.get(entry.trackSid);
      if (existing) {
        return;
      }
      const element = document.createElement('audio');
      element.autoplay = true;
      element.dataset.trackSid = entry.trackSid;
      audioSink.appendChild(element);
      entry.track.attach(element);
      liveKitAudioElementsRef.current.set(entry.trackSid, element);
      void element.play().catch((nextError) => {
        logMedia('warn', 'Remote LiveKit audio playback failed.', nextError);
      });
    });
  }, [liveKitTracks]);

  useEffect(() => {
    if (view !== 'room') {
      return;
    }

    if (access?.accessType !== 'livekit-room' || !access.liveRoomName || !user) {
      setRoomLoaded(false);
      return;
    }

    setMediaNotice(reconnectAttemptsRef.current > 0 ? 'Reconnecting live media...' : 'Connecting to the live classroom...');
    setMediaWarning(null);
  }, [view, access?.accessType, access?.liveRoomName, user]);

  const openLiveClass = async (liveClassId: string) => {
    setSelectedLiveClassId(liveClassId);
    setAccess(null);
    setSession(null);
    setMessages([]);
    setView('detail');
  };

  const beginEditLiveClass = (liveClass: LiveClass) => {
    const teacherProfile = normalizeLiveTeacherProfile(liveClass);
    const previewResource = getLivePreviewResource(liveClass);
    const attachmentResource = getLiveAttachmentResource(liveClass);
    setUtilityPanel(null);
    setEditingLiveClassId(liveClass._id);
    setCreateForm({
      title: getDisplayLiveClassTitle(liveClass),
      subject: getLiveSubject(liveClass),
      category: getLiveCategory(liveClass),
      classLevel: getLiveLevel(liveClass),
      instructor: teacherProfile.name || liveClass.instructor || '',
      language: getLiveLanguage(liveClass),
      startTime: liveClass.startTime ? new Date(liveClass.startTime).toISOString().slice(0, 16) : '',
      durationMinutes: Number(liveClass.durationMinutes || 90),
      posterUrl: liveClass.posterUrl || '',
      previewVideoUrl: previewResource?.url || '',
      attachmentTitle: attachmentResource?.title || '',
      attachmentUrl: attachmentResource?.url || '',
      classDescription: liveClass.description || '',
      teacherRole: teacherProfile.role || '',
      teacherExperience: teacherProfile.experience || '',
      teacherBio: teacherProfile.bio || '',
      teacherAvatarUrl: teacherProfile.avatarUrl || '',
      sessionNotesText: (liveClass.sessionNotes || []).join('\n'),
      reminderLeadMinutes: getLiveReminderLeadMinutes(liveClass),
      visibleToStudents: getLiveVisibility(liveClass),
      maxAttendees: Number(liveClass.maxAttendees || 500),
      priceLabel: getLiveClassPriceLabel(liveClass),
      certificateLabel: getLiveCertificate(liveClass),
      allowLiveChat: liveClass.chatEnabled !== false,
      allowQa: liveClass.doubtSolving !== false,
      enableClassRecording: liveClass.replayAvailable !== false,
      pollQuestion: liveClass.activePoll?.question || '',
      pollOptionsText: (liveClass.activePoll?.options || []).map((option) => option.text).join('\n'),
      linkageType: (liveClass.linkageType as 'standalone' | 'course' | 'mock-test') || 'standalone',
      courseId: liveClass.courseId || '',
      moduleId: liveClass.moduleId || '',
      chapterId: liveClass.chapterId || '',
      mockTestId: liveClass.mockTestId || '',
    });
    setCreateStep(0);
    setCreateOpen(true);
  };

  const resetLiveClassEditor = () => {
    setEditingLiveClassId(null);
    setCreateOpen(false);
    setCreateForm(initialCreateForm);
    setCreateStep(0);
  };

  const handleLiveImageUpload = async (kind: 'poster' | 'teacher-avatar', file: File | null) => {
    if (!file) {
      return;
    }

    if (kind === 'poster') {
      setUploadingPoster(true);
    } else {
      setUploadingTeacherPhoto(true);
    }
    setError(null);

    try {
      const response = await EduService.uploadLiveClassImage(file);
      setCreateForm((current) => ({
        ...current,
        ...(kind === 'poster'
          ? { posterUrl: response.asset.url }
          : { teacherAvatarUrl: response.asset.url }),
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to upload image.');
    } finally {
      if (kind === 'poster') {
        setUploadingPoster(false);
      } else {
        setUploadingTeacherPhoto(false);
      }
    }
  };

  const validateLiveClassForm = () => {
    if (!createForm.title.trim()) {
      return 'Add a live class title.';
    }
    if (!createForm.subject.trim()) {
      return 'Select or enter a subject for this live class.';
    }
    if (!createForm.instructor.trim()) {
      return 'Add a teacher name for the live class.';
    }
    if (!createForm.startTime) {
      return 'Select the live class date and time.';
    }
    if (!Number.isFinite(Number(createForm.durationMinutes)) || Number(createForm.durationMinutes) < 15) {
      return 'Duration should be at least 15 minutes.';
    }
    if (!isValidLiveAssetUrl(createForm.posterUrl)) {
      return 'Poster URL must be a valid http(s) URL or app-relative path.';
    }
    if (!isValidLiveAssetUrl(createForm.teacherAvatarUrl)) {
      return 'Teacher photo URL must be a valid http(s) URL or app-relative path.';
    }
    if (!isValidLiveAssetUrl(createForm.previewVideoUrl)) {
      return 'Preview video URL must be a valid http(s) URL or app-relative path.';
    }
    if (!isValidLiveAssetUrl(createForm.attachmentUrl)) {
      return 'Attachment URL must be a valid http(s) URL or app-relative path.';
    }
    if (createForm.pollQuestion.trim() && getPollOptionCount(createForm.pollOptionsText) < 2) {
      return 'Add at least two poll options when a poll question is provided.';
    }
    return null;
  };

  const deleteLiveClassById = async (liveClassId: string) => {
    const target = liveClasses.find((liveClass) => liveClass._id === liveClassId) || selectedLiveClass || null;
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(`Delete "${target?.title || 'this live class'}"? This cannot be undone.`);
      if (!confirmed) {
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      await EduService.deleteLiveClass(liveClassId);
      await onRefresh();
      if (editingLiveClassId === liveClassId) {
        resetLiveClassEditor();
      }
      if (selectedLiveClassId === liveClassId) {
        setSelectedLiveClassId(null);
        setAccess(null);
        setSession(null);
        setMessages([]);
        setParticipantSearch('');
        setUtilityPanel(null);
        setView('list');
      }
      setUiNotice('Live class deleted.');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to delete live class.');
    } finally {
      setBusy(false);
    }
  };

  const toggleNewLiveClassEditor = () => {
    if (createOpen) {
      resetLiveClassEditor();
      return;
    }
    setEditingLiveClassId(null);
    setCreateForm(initialCreateForm);
    setCreateStep(0);
    setCreateOpen(true);
  };

  const handleCreateLiveClass = async () => {
    const validationError = validateLiveClassForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const selectedCourse = overview.courses.find((course) => course._id === createForm.courseId) || null;
      const selectedModule = selectedCourse?.modules.find((module) => module.id === createForm.moduleId) || null;
      const selectedChapter = selectedModule?.chapters?.find((chapter) => chapter.id === createForm.chapterId) || null;
      const selectedMockTest = overview.testSeries.find((test) => test._id === createForm.mockTestId) || null;
      let nextTopicTags = withLiveMetadataTag([], 'subject', createForm.subject);
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'category', createForm.category);
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'level', createForm.classLevel);
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'language', createForm.language);
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'reminder', String(createForm.reminderLeadMinutes || 15));
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'visibility', createForm.visibleToStudents);
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'certificate', createForm.certificateLabel);
      nextTopicTags = withLiveMetadataTag(nextTopicTags, 'price', createForm.priceLabel);
      const nextResources: LiveClassResource[] = [
        createForm.previewVideoUrl.trim()
          ? {
            id: 'preview-video',
            title: 'Class Preview',
            type: 'preview-video',
            url: createForm.previewVideoUrl.trim(),
            description: 'Preview link for the live class card and detail view.',
            lines: [],
          }
          : null,
        createForm.attachmentUrl.trim()
          ? {
            id: 'attachment',
            title: createForm.attachmentTitle.trim() || 'Class Attachment',
            type: 'attachment',
            url: createForm.attachmentUrl.trim(),
            description: 'Reference material for enrolled students.',
            lines: [],
          }
          : null,
      ].filter(Boolean) as LiveClassResource[];
      const payload = {
        title: createForm.title,
        instructor: createForm.instructor || user?.name || 'Live Faculty',
        startTime: createForm.startTime,
        durationMinutes: Number(createForm.durationMinutes || 90),
        linkageType: createForm.linkageType,
        topicTags: nextTopicTags,
        courseId: createForm.linkageType === 'course' ? createForm.courseId || null : selectedMockTest?.course || null,
        moduleId: createForm.linkageType === 'course' ? selectedModule?.id || null : null,
        moduleTitle: createForm.linkageType === 'course' ? selectedModule?.title || null : null,
        chapterId: createForm.linkageType === 'course' ? selectedChapter?.id || null : null,
        chapterTitle: createForm.linkageType === 'course' ? selectedChapter?.title || null : null,
        mockTestId: createForm.linkageType === 'mock-test' ? selectedMockTest?._id || null : null,
        mockTestTitle: createForm.linkageType === 'mock-test' ? selectedMockTest?.title || null : null,
        requiresEnrollment: createForm.linkageType === 'course' || Boolean(selectedMockTest?.course),
        posterUrl: createForm.posterUrl.trim() || null,
        description: createForm.classDescription.trim() || null,
        teacherProfile: {
          name: createForm.instructor || user?.name || 'Live Faculty',
          role: createForm.teacherRole.trim() || null,
          experience: createForm.teacherExperience.trim() || null,
          bio: createForm.teacherBio.trim() || null,
          avatarUrl: createForm.teacherAvatarUrl.trim() || null,
        },
        sessionNotes: createForm.sessionNotesText.split('\n').map((entry) => entry.trim()).filter(Boolean),
        resources: nextResources,
        activePoll: buildLivePollFromForm(createForm.pollQuestion, createForm.pollOptionsText),
        maxAttendees: Number(createForm.maxAttendees || 500),
        chatEnabled: createForm.allowLiveChat,
        doubtSolving: createForm.allowQa,
        replayAvailable: createForm.enableClassRecording,
      };
      const response = editingLiveClassId
        ? await EduService.updateLiveClass(editingLiveClassId, payload)
        : await EduService.createLiveClass(payload);
      await onRefresh();
      resetLiveClassEditor();
      await openLiveClass(response.liveClass._id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `Unable to ${editingLiveClassId ? 'update' : 'create'} live class.`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteLiveClass = async () => {
    if (!editingLiveClassId) {
      return;
    }
    await deleteLiveClassById(editingLiveClassId);
  };

  const handleSaveActivePoll = async () => {
    if (!selectedLiveClass?._id) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await EduService.updateLiveClass(selectedLiveClass._id, {
        activePoll: buildLivePollFromForm(createForm.pollQuestion, createForm.pollOptionsText),
      });
      if (response.liveClass?._id) {
        setLiveClasses((current) => sanitizeLiveClasses(current).map((liveClass) => (
          liveClass?._id === response.liveClass._id
            ? ({
              ...liveClass,
              ...response.liveClass,
            } as LiveClass)
            : liveClass
        )));
      }
      await refreshDetailState(selectedLiveClass._id, {
        includeAccess: true,
        includeSession: false,
        includeChat: false,
      });
      await onRefresh();
      setUiNotice('Live poll updated.');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to update live poll.');
    } finally {
      setBusy(false);
    }
  };

  const handleStartLiveClass = async () => {
    if (!selectedLiveClass?._id) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await EduService.startLiveClass(selectedLiveClass._id);
      setAccess(await EduService.getLiveClassAccess(selectedLiveClass._id));
      setSession(response.session);
      await onRefresh();
      await handleJoinLiveClass();
    } catch (nextError) {
      const nextMessage = normalizeLiveUiErrorMessage(nextError, 'Unable to start live class.');
      if (/Live media connection was lost/i.test(nextMessage)) {
        setMediaWarning(nextMessage);
        setError(null);
      } else {
        setError(nextMessage);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleEndLiveClass = async () => {
    if (!selectedLiveClass?._id) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      intentionalExitRef.current = true;
      clearActiveLiveRoom();
      await EduService.endLiveClass(selectedLiveClass._id);
      setView('detail');
      await refreshDetailState(selectedLiveClass._id);
      await onRefresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to end live class.');
    } finally {
      setBusy(false);
    }
  };

  const handleJoinLiveClass = async () => {
    if (!selectedLiveClass?._id) {
      return;
    }
    const joinAttemptId = activeJoinAttemptRef.current + 1;
    activeJoinAttemptRef.current = joinAttemptId;

    if (isReferenceMode) {
      setError(null);
      setMediaNotice(null);
      setMediaWarning(null);
      setMobileRoomMenuOpen(false);
      setRoomPanelTab('chat');
      setAccess({
        liveClassId: selectedLiveClass._id,
        title: selectedLiveClass.title,
        provider: 'figma-reference',
        mode: 'reference',
        status: 'live',
        accessType: 'livekit-room',
        streamUrl: null,
        streamFormat: null,
        embedUrl: null,
        roomUrl: null,
        liveRoomName: 'figma-reference-room',
        liveKitUrl: null,
        liveKitToken: null,
        liveKitIdentity: user?._id || 'reference-student',
        replayPlayback: null,
        replayExternalUrl: null,
        replayCourseId: null,
        replayLessonId: null,
        tokenExpiresAt: null,
        watermarkText: null,
        statusMessage: 'Reference mode active',
      });
      setSession({
        liveClassId: selectedLiveClass._id,
        status: 'live',
        roomName: 'figma-reference-room',
        startedAt: new Date().toISOString(),
        endedAt: null,
        activePresenterId: 'teacher-reference',
        participants: [
          {
            userId: 'teacher-reference',
            name: 'Rahul Sharma',
            role: 'admin',
            joinedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            micMuted: false,
            videoEnabled: true,
            handRaised: false,
            handStatus: 'idle',
            canSpeak: true,
            isScreenSharing: true,
            isPresenting: true,
            removed: false,
          },
          {
            userId: user?._id || 'student-reference',
            name: user?.name || 'Ankit Verma',
            role: 'student',
            joinedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            micMuted: true,
            videoEnabled: false,
            handRaised: false,
            handStatus: 'idle',
            canSpeak: false,
            isScreenSharing: false,
            isPresenting: false,
            removed: false,
          },
        ],
      });
      setView('room');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      intentionalExitRef.current = false;
      const accessResponse = await EduService.getLiveClassAccess(selectedLiveClass._id);
      if (activeJoinAttemptRef.current !== joinAttemptId) {
        return;
      }
      setAccess(accessResponse);
      rememberActiveLiveRoom(selectedLiveClass._id);
      setMediaNotice('Connecting to the live classroom...');
      setView('room');

      if (accessResponse.accessType === 'live-stream') {
        setMediaNotice('Viewing the live stream.');
        void EduService.getLiveSessionState(selectedLiveClass._id)
          .then((sessionResponse) => {
            if (activeJoinAttemptRef.current !== joinAttemptId) {
              return;
            }
            setSession(sessionResponse.session || null);
          })
          .catch(() => undefined);
        return;
      }

      if (accessResponse.accessType === 'jitsi-room') {
        await EduService.joinLiveSession(selectedLiveClass._id);
        const sessionResponse = await EduService.getLiveSessionState(selectedLiveClass._id);
        if (activeJoinAttemptRef.current !== joinAttemptId) {
          return;
        }
        setSession(sessionResponse.session);
        setMediaNotice('Teacher studio opened. Use the embedded room toolbar for camera, microphone, and screen sharing.');
        return;
      }

      if (
        accessResponse.accessType === 'livekit-room'
        && (!accessResponse.liveKitUrl || !accessResponse.liveKitToken)
      ) {
        throw new Error(
          accessResponse.statusMessage
          || 'Interactive classroom is selected, but the LiveKit server is not fully configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET, or start this class with managed HLS for large audience playback.',
        );
      }

      await EduService.joinLiveSession(selectedLiveClass._id);
      const sessionResponse = await EduService.getLiveSessionState(selectedLiveClass._id);
      if (activeJoinAttemptRef.current !== joinAttemptId) {
        return;
      }
      setSession(sessionResponse.session);
      if (accessResponse.accessType !== 'livekit-room') {
        throw new Error('This live class is not configured for the interactive classroom yet. Recreate it with LiveKit to enable audio, video, screen sharing, chat, polls, and hand-raise.');
      }
    } catch (nextError) {
      clearActiveLiveRoom();
      setMediaNotice(null);
      setView('detail');
      const nextMessage = normalizeLiveUiErrorMessage(nextError, 'Unable to join the live classroom.');
      if (/Live media connection was lost/i.test(nextMessage)) {
        setMediaWarning(nextMessage);
        setError(null);
      } else {
        setError(nextMessage);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLeaveRoom = async () => {
    if (!selectedLiveClass?._id) {
      return;
    }
    activeJoinAttemptRef.current += 1;
    intentionalExitRef.current = true;
    clearActiveLiveRoom();
    try {
      await EduService.leaveLiveSession(selectedLiveClass._id);
    } catch {
      // Ignore leave failures and still return to detail view.
    }
    liveKitRoomRef.current?.disconnect(true);
    setView('detail');
  };

  const sendChat = async () => {
    if (!selectedLiveClass?._id || !chatInput.trim()) {
      return;
    }
    const message = chatInput.trim();
    setChatInput('');
    try {
      await EduService.postLiveClassChat(selectedLiveClass._id, message);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to send message.');
    }
  };

  const handlePollVote = async (optionId: string) => {
    if (!selectedLiveClass?._id || !activePoll) {
      return;
    }

    setSelectedPollOption(optionId);
    setError(null);
    try {
      const response = await EduService.submitLivePollVote(selectedLiveClass._id, optionId);
      if (response.liveClass?._id) {
        setLiveClasses((current) => sanitizeLiveClasses(current).map((liveClass) => (
          liveClass?._id === response.liveClass._id
            ? ({
              ...liveClass,
              ...response.liveClass,
              activePoll: response.liveClass.activePoll ?? response.activePoll ?? liveClass.activePoll,
            } as LiveClass)
            : liveClass
        )));
      }
      await refreshDetailState(selectedLiveClass._id, {
        includeAccess: true,
        includeSession: true,
        includeChat: false,
      });
      setUiNotice('Poll vote submitted.');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to submit poll vote.');
    }
  };

  const countdown = selectedLiveClass?.startTime ? formatCountdown(selectedLiveClass.startTime) : null;
  const joinedCount = session?.participants.length || selectedLiveClass?.attendees || 0;
  const accessStatus = access?.liveClassId === selectedLiveClass?._id
    ? String(access.status || '').toLowerCase()
    : '';
  const selectedStatus = accessStatus || String(selectedLiveClass?.status || '').toLowerCase();
  const detailStatus = isReferenceMode ? liveFigmaReference.detail.status : selectedStatus;
  const notificationItems = overview.notifications.slice(0, 4);
  const filteredParticipants = useMemo(() => {
    const query = participantSearch.trim().toLowerCase();
    if (!query) {
      return session?.participants || [];
    }
    return (session?.participants || []).filter((participant) =>
      participant.name.toLowerCase().includes(query),
    );
  }, [participantSearch, session?.participants]);

  const scrollToSection = (target: React.RefObject<HTMLDivElement | null>) => {
    target.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const scrollToDetailContent = () => {
    const target = mobileDetailContentRef.current && mobileDetailContentRef.current.offsetParent !== null
      ? mobileDetailContentRef.current
      : desktopDetailContentRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggleReminders = () => {
    const next = !remindersEnabled;
    setRemindersEnabled(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('edumaster.live.reminders', next ? 'true' : 'false');
    }
    setUiNotice(next ? 'Live class reminders enabled.' : 'Live class reminders paused.');
  };

  const buildPdfDataUri = (title: string, lines: readonly string[]) => {
    const escapePdf = (value: string) => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const contentLines = [
      'BT',
      '/F1 22 Tf',
      '1 0 0 1 50 760 Tm',
      `(${escapePdf(title)}) Tj`,
      '/F1 12 Tf',
      ...lines.map((line, index) => `1 0 0 1 50 ${728 - (index * 22)} Tm (${escapePdf(line)}) Tj`),
      'ET',
    ];
    const stream = contentLines.join('\n');
    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      `5 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object) => {
      offsets.push(pdf.length);
      pdf += `${object}\n`;
    });
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return `data:application/pdf;base64,${btoa(pdf)}`;
  };

  const openPdfResource = (title: string, lines: readonly string[]) => {
    if (typeof window === 'undefined') {
      return;
    }
    const dataUri = buildPdfDataUri(title, lines);
    const opened = window.open(dataUri, '_blank', 'noopener,noreferrer');
    if (!opened) {
      const anchor = document.createElement('a');
      anchor.href = dataUri;
      anchor.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
      anchor.click();
    }
  };

  const handleQuickAction = (actionId: typeof quickActionCards[number]['id']) => {
    if (actionId === 'all-live' || actionId === 'schedule') {
      scrollToSection(todaySectionRef);
      setUtilityPanel(actionId === 'schedule' ? 'schedule' : null);
      return;
    }
    if (actionId === 'my-classes') {
      scrollToSection(todaySectionRef);
      setUtilityPanel('my-classes');
      return;
    }
    setUtilityPanel('notifications');
    scrollToSection(remindersSectionRef);
  };

  const selectDetailTab = (tab: LiveDetailTabKey) => {
    setDetailTab(tab);
    scrollToDetailContent();
  };

  const buildLiveShareUrl = () => {
    if (typeof window === 'undefined') {
      return '';
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('tab', 'live');
    if (selectedLiveClass?._id) {
      nextUrl.searchParams.set('liveClassId', selectedLiveClass._id);
    }
    if (isReferenceMode) {
      nextUrl.searchParams.set('liveReferenceMode', 'figma');
    } else {
      nextUrl.searchParams.delete('liveReferenceMode');
    }
    return nextUrl.toString();
  };

  const handleShareCurrentView = async () => {
    if (typeof window === 'undefined') {
      return;
    }

    const shareUrl = buildLiveShareUrl();
    const shareTitle = selectedLiveClass ? getDisplayLiveClassTitle(selectedLiveClass) : 'Live Classes';

    try {
      if (navigator.share) {
        await navigator.share({
          title: shareTitle,
          text: selectedLiveClass ? `Join ${shareTitle} on EduMaster.` : 'Open the Live Classes workspace on EduMaster.',
          url: shareUrl,
        });
        setUiNotice('Share sheet opened.');
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        setUiNotice('Live class link copied to clipboard.');
        return;
      }
    } catch (error) {
      if (getErrorMessage(error).toLowerCase().includes('abort')) {
        return;
      }
    }

    const shareWindow = window.open(shareUrl, '_blank', 'noopener,noreferrer');
    setUiNotice(shareWindow ? 'Live class link opened in a new tab.' : 'Unable to open a new tab right now.');
  };

  const renderDetailResources = (compact = false) => (
    <div className={cn('space-y-3', compact && 'space-y-2')}>
      {activeResources.length > 0 ? activeResources.map((resource) => (
        <button
          key={resource.id}
          type="button"
          onClick={() => openPdfResource(resource.title, resource.lines || [resource.description || resource.url || 'Reference material'])}
          className="flex w-full items-center justify-between gap-3 rounded-[16px] border border-[#e5ebf7] bg-white px-[14px] py-[14px] text-left shadow-[0_8px_18px_rgba(28,41,61,0.04)]"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-[42px] w-[42px] items-center justify-center rounded-[12px] bg-[#eef4ff] text-[#2f6fe4]">
              <FileText className="h-[18px] w-[18px]" />
            </div>
            <div>
              <p className="text-[14px] font-semibold text-[#1f2d4e]">{resource.title}</p>
              <p className="mt-[4px] text-[13px] text-[#7283a0]">{resource.type || 'PDF'}{resource.url ? ' • Ready to open' : ''}</p>
            </div>
          </div>
          <ArrowRight className="h-[18px] w-[18px] text-[#7b8ead]" />
        </button>
      )) : (
        <div className="rounded-[16px] border border-dashed border-[#dbe4f4] bg-white px-[14px] py-[14px] text-[13px] leading-[1.55] text-[#7283a0]">
          No resources added yet. The teacher can attach PDFs, formula sheets, and homework files here.
        </div>
      )}
      {activeResources.length > 0 && (
        <button
          type="button"
          onClick={() => activeResources.forEach((resource) => openPdfResource(resource.title, resource.lines || [resource.description || resource.url || 'Reference material']))}
          className="inline-flex h-[46px] w-full items-center justify-center rounded-[14px] bg-[#2f6fe4] px-[16px] text-[16px] font-semibold text-white shadow-[0_14px_28px_rgba(47,111,228,0.22)]"
        >
          Download All
        </button>
      )}
    </div>
  );

  const renderDetailChat = (dark = false) => (
    <div className={cn('rounded-[18px] border p-[16px]', dark ? 'border-white/10 bg-white/5' : 'border-[#e5ebf7] bg-white')}>
      <div className="space-y-3">
        {messages.length > 0 ? messages.map((message) => (
          <div
            key={message._id}
            className={cn('max-w-[92%] rounded-[14px] px-[14px] py-[12px]', message.userId === user?._id ? (dark ? 'ml-auto bg-[#1f3f78]' : 'ml-auto bg-[#eef4ff]') : (dark ? 'bg-[#162338]' : 'bg-[#f4f7ff]'))}
          >
            <div className={cn('flex items-center gap-2 text-[13px]', dark ? 'text-white/64' : 'text-[#7283a0]')}>
              <span className={cn('font-semibold', dark ? 'text-[#9fc2ff]' : 'text-[#2f6fe4]')}>{message.userName}</span>
              <span>{formatTime(message.createdAt)}</span>
            </div>
            <p className={cn('mt-2 text-[14px] leading-[1.55]', dark ? 'text-white/86' : 'text-[#1f2d4e]')}>{message.message}</p>
          </div>
        )) : (
          <div className={cn('rounded-[14px] border border-dashed px-4 py-4 text-[13px]', dark ? 'border-white/12 text-white/54' : 'border-[#dbe4f4] text-[#7283a0]')}>
            Chat is ready. Messages sent here appear for everyone in real time.
          </div>
        )}
      </div>
      <div className={cn('mt-4 flex items-center gap-3 rounded-[14px] border px-4 py-2.5', dark ? 'border-white/10 bg-white/6' : 'border-[#dbe4f4] bg-[#fbfcff]')}>
        <input
          data-testid={dark ? 'live-chat-input' : 'live-chat-input-inline'}
          value={chatInput}
          onChange={(event) => setChatInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void sendChat();
            }
          }}
          placeholder="Type your message..."
          className={cn('min-w-0 flex-1 bg-transparent outline-none', dark ? 'text-white placeholder:text-white/40' : 'text-[#1f2d4e] placeholder:text-[#8da0bd]')}
        />
        <button data-testid={dark ? 'live-chat-send' : 'live-chat-send-inline'} type="button" onClick={() => void sendChat()} className="inline-flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#2f6fe4] text-white">
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  const renderDetailPolls = (dark = false) => (
    <div className={cn('rounded-[18px] border p-[16px]', dark ? 'border-white/10 bg-white/5' : 'border-[#e5ebf7] bg-white')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn('text-[15px] font-semibold', dark ? 'text-white' : 'text-[#1f2d4e]')}>Quick Poll</p>
          <p className={cn('mt-[6px] text-[13px]', dark ? 'text-white/62' : 'text-[#7283a0]')}>
            {activePoll?.question || 'No live poll is running right now.'}
          </p>
        </div>
        <span className={cn('rounded-full px-3 py-1 text-[11px] font-semibold', dark ? 'bg-white/10 text-white/72' : 'bg-[#eef4ff] text-[#2f6fe4]')}>
          {activePoll?.totalVotes ? `${activePoll.totalVotes} votes` : 'Live'}
        </span>
      </div>
      {!isReferenceMode && isAdmin && (
        <div className="mt-4 grid gap-3">
          <input data-testid="live-poll-question-input" value={createForm.pollQuestion} onChange={(event) => setCreateForm((current) => ({ ...current, pollQuestion: event.target.value }))} placeholder="Poll question" className={cn('rounded-[14px] border px-4 py-3 outline-none', dark ? 'border-white/10 bg-white/4 text-white placeholder:text-white/36' : 'border-[#dbe4f4] bg-[#fbfcff] text-[#1f2d4e] placeholder:text-[#8da0bd]')} />
          <textarea data-testid="live-poll-options-input" value={createForm.pollOptionsText} onChange={(event) => setCreateForm((current) => ({ ...current, pollOptionsText: event.target.value }))} placeholder="Poll options, one per line" rows={3} className={cn('rounded-[14px] border px-4 py-3 outline-none', dark ? 'border-white/10 bg-white/4 text-white placeholder:text-white/36' : 'border-[#dbe4f4] bg-[#fbfcff] text-[#1f2d4e] placeholder:text-[#8da0bd]')} />
          <button data-testid="live-poll-save" type="button" onClick={() => void handleSaveActivePoll()} className="w-fit rounded-[12px] bg-[#2f6fe4] px-4 py-2.5 text-[13px] font-semibold text-white">
            Save Poll
          </button>
        </div>
      )}
      <div className="mt-4 space-y-2.5">
        {activePoll ? activePoll.options.map((option) => (
          <button
            key={option.id}
            data-testid={`live-poll-option-${option.id}`}
            type="button"
            onClick={() => {
              if (isAdmin) {
                setSelectedPollOption(option.id);
                setUiNotice(`${option.text} selected.`);
                return;
              }
              void handlePollVote(option.id);
            }}
            aria-pressed={selectedPollOption === option.id}
            className={cn(
              'flex w-full items-center justify-between rounded-[14px] border px-[14px] py-[12px] text-left text-[14px] font-medium',
              selectedPollOption === option.id
                ? dark
                  ? 'border-[#6d8dff] bg-[#17325f] text-white'
                  : 'border-[#bfd3ff] bg-[#eef4ff] text-[#1f2d4e]'
                  : dark
                    ? 'border-white/10 bg-white/4 text-white/84'
                    : 'border-[#dbe4f4] bg-[#fbfcff] text-[#1f2d4e]',
            )}
          >
            <span className="min-w-0 flex-1">{option.text}</span>
            <span className={cn('ml-3 inline-flex min-w-[72px] justify-end text-[12px] font-semibold', dark ? 'text-white/62' : 'text-[#7283a0]')}>
              {typeof option.votes === 'number' ? `${option.votes} vote${option.votes === 1 ? '' : 's'}` : '0 votes'}
            </span>
            <Check className={cn('h-4 w-4', selectedPollOption === option.id ? (dark ? 'text-[#b9ccff]' : 'text-[#2f6fe4]') : (dark ? 'text-white/48' : 'text-[#9cb0cc]'))} />
          </button>
        )) : (
          <div className={cn('rounded-[14px] border border-dashed px-4 py-4 text-[13px]', dark ? 'border-white/12 text-white/54' : 'border-[#dbe4f4] text-[#7283a0]')}>
            Polls created by the teacher will appear here during the class.
          </div>
        )}
      </div>
    </div>
  );

  const renderDetailNotes = (dark = false) => (
    <div className={cn('rounded-[18px] border p-[16px]', dark ? 'border-white/10 bg-white/5' : 'border-[#e5ebf7] bg-white')}>
      <p className={cn('text-[15px] font-semibold', dark ? 'text-white' : 'text-[#1f2d4e]')}>Session Notes</p>
      <div className="mt-4 space-y-3">
        {activeNotes.length > 0 ? activeNotes.map((item) => (
          <div key={item} className={cn('rounded-[14px] px-[14px] py-[12px] text-[14px] leading-[1.55]', dark ? 'bg-white/4 text-white/82' : 'bg-[#f4f7ff] text-[#516786]')}>
            {item}
          </div>
        )) : (
          <div className={cn('rounded-[14px] border border-dashed px-[14px] py-[12px] text-[13px]', dark ? 'border-white/12 text-white/54' : 'border-[#dbe4f4] text-[#7283a0]')}>
            No session notes added yet. The teacher can add revision bullets or lesson talking points here.
          </div>
        )}
      </div>
    </div>
  );
  const renderUtilityPanel = () => {
    if (!utilityPanel) {
      return null;
    }

    return (
      <div className="rounded-[18px] border border-[#dfe7f5] bg-white p-[16px] shadow-[0_8px_18px_rgba(28,41,61,0.05)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[15px] font-semibold text-[#1f2d4e]">
              {utilityPanel === 'menu' && 'Live Quick Menu'}
              {utilityPanel === 'schedule' && 'Live Schedule'}
              {utilityPanel === 'my-classes' && 'My Classes'}
              {utilityPanel === 'notifications' && 'Notifications'}
              {utilityPanel === 'teacher' && 'Teacher Profile'}
              {utilityPanel === 'help' && 'Support'}
              {utilityPanel === 'participants' && 'Participants'}
            </p>
            <p className="mt-[6px] text-[13px] text-[#7283a0]">
              {utilityPanel === 'menu' && 'Jump to the main live sections and keep everything within one clean sheet.'}
              {utilityPanel === 'schedule' && 'Track upcoming sessions and jump into the next class quickly.'}
              {utilityPanel === 'my-classes' && 'Classes connected to your teacher or joined study flow.'}
              {utilityPanel === 'notifications' && 'Recent reminders and action items from the platform.'}
              {utilityPanel === 'teacher' && 'Faculty summary and class ownership details.'}
              {utilityPanel === 'help' && 'Fast ways to recover if audio, video, or joining gets blocked.'}
              {utilityPanel === 'participants' && 'Current classroom members and speaking access at a glance.'}
            </p>
          </div>
          <button type="button" onClick={() => setUtilityPanel(null)} className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] border border-[#dbe4f4] text-[#7b8ead]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {utilityPanel === 'menu' && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            {[
              { key: 'all-live' as const, title: 'All Live Classes' },
              { key: 'schedule' as const, title: 'Schedule' },
              { key: 'my-classes' as const, title: 'My Classes' },
              { key: 'notifications' as const, title: 'Notifications' },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setUtilityPanel(null);
                  handleQuickAction(item.key);
                }}
                className="rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[13px] text-left"
              >
                <p className="text-[14px] font-semibold text-[#1f2d4e]">{item.title}</p>
                <p className="mt-[4px] text-[12px] text-[#7283a0]">Open this live section</p>
              </button>
            ))}
          </div>
        )}

        {utilityPanel === 'schedule' && (
          <div className="mt-4 space-y-3">
            {scheduleCards.map((item, index) => (
              <button key={`${item.title}-${index}`} type="button" onClick={() => item.liveClassId ? void openLiveClass(item.liveClassId) : undefined} className="flex w-full items-center justify-between rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px] text-left">
                <div>
                  <p className="text-[14px] font-semibold text-[#1f2d4e]">{item.title}</p>
                  <p className="mt-[4px] text-[13px] text-[#7283a0]">{item.topic} • {item.time} {item.meridiem}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
              </button>
            ))}
          </div>
        )}

        {utilityPanel === 'my-classes' && (
          <div className="mt-4 space-y-3">
            {myClassCards.map((item, index) => (
              <button key={`${item.title}-${index}`} type="button" onClick={() => item.liveClassId ? void openLiveClass(item.liveClassId) : undefined} className="flex w-full items-center justify-between rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px] text-left">
                <div>
                  <p className="text-[14px] font-semibold text-[#1f2d4e]">{item.title}</p>
                  <p className="mt-[4px] text-[13px] text-[#7283a0]">{item.teacher} • {item.attendees}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
              </button>
            ))}
          </div>
        )}

        {utilityPanel === 'notifications' && (
          <div className="mt-4 space-y-3">
            {notificationItems.length > 0 ? notificationItems.map((item) => (
              <div key={item._id} className="rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px]">
                <p className="text-[14px] font-semibold text-[#1f2d4e]">{item.title}</p>
                <p className="mt-[4px] text-[13px] leading-[1.5] text-[#7283a0]">{item.message}</p>
              </div>
            )) : (
              <div className="rounded-[14px] border border-dashed border-[#dbe4f4] px-[14px] py-[12px] text-[13px] text-[#7283a0]">
                No new notifications right now. Reminders and class updates will appear here.
              </div>
            )}
          </div>
        )}

        {utilityPanel === 'teacher' && (
          <div className="mt-4 flex items-center gap-4 rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px]">
            {isReferenceMode ? <ReferenceTeacherAvatar size="lg" /> : <TeacherAvatar name={detailDisplay.teacher} photoUrl={selectedTeacherProfile.avatarUrl} size="lg" />}
            <div>
              <p className="text-[15px] font-semibold text-[#1f2d4e]">{detailDisplay.teacher}</p>
              <p className="mt-[4px] text-[13px] text-[#7283a0]">{detailDisplay.teacherRole}</p>
              <p className="mt-[4px] text-[13px] text-[#7283a0]">{detailDisplay.teacherExperience}</p>
              {selectedTeacherProfile.bio && <p className="mt-[6px] text-[13px] leading-[1.55] text-[#516786]">{selectedTeacherProfile.bio}</p>}
            </div>
          </div>
        )}

        {utilityPanel === 'help' && (
          <div className="mt-4 space-y-3">
            <button
              type="button"
              onClick={() => void ensureMediaPermissions()}
              className="flex w-full items-center justify-between rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px] text-left"
            >
              <div>
                <p className="text-[14px] font-semibold text-[#1f2d4e]">Run audio and video check</p>
                <p className="mt-[4px] text-[13px] leading-[1.55] text-[#516786]">Refresh browser permissions and prime the device media flow.</p>
              </div>
              <Settings className="h-4 w-4 text-[#7b8ead]" />
            </button>
            <button
              type="button"
              onClick={() => {
                selectDetailTab('resources');
                setUtilityPanel(null);
              }}
              className="flex w-full items-center justify-between rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px] text-left"
            >
              <div>
                <p className="text-[14px] font-semibold text-[#1f2d4e]">Open notes and resources</p>
                <p className="mt-[4px] text-[13px] leading-[1.55] text-[#516786]">Keep revision material available while the stream reconnects.</p>
              </div>
              <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
            </button>
            <button
              type="button"
              onClick={() => void handleShareCurrentView()}
              className="flex w-full items-center justify-between rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px] text-left"
            >
              <div>
                <p className="text-[14px] font-semibold text-[#1f2d4e]">Share the class link</p>
                <p className="mt-[4px] text-[13px] leading-[1.55] text-[#516786]">Send the current class page if someone needs the exact session link.</p>
              </div>
              <Share2 className="h-4 w-4 text-[#7b8ead]" />
            </button>
          </div>
        )}

        {utilityPanel === 'participants' && (
          <div className="mt-4 space-y-3">
            {(session?.participants || []).length > 0 ? filteredParticipants.map((participant) => {
              const isOnline = !participant.removed && (!participant.lastSeenAt || (Date.now() - Date.parse(participant.lastSeenAt)) < 5 * 60 * 1000);
              return (
                <div key={participant.userId} className="flex items-center justify-between gap-3 rounded-[14px] border border-[#e5ebf7] bg-[#fbfcff] px-[14px] py-[12px]">
                  <div className="flex min-w-0 items-center gap-3">
                    <TeacherAvatar name={participant.name} size="sm" online={isOnline && !participant.micMuted} />
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-[#1f2d4e]">{participant.name}</p>
                      <p className="mt-[4px] text-[12px] text-[#7283a0]">
                        {participant.canSpeak ? 'Can speak' : 'Listening only'} {participant.handRaised ? '• Hand raised' : ''}
                      </p>
                    </div>
                  </div>
                  <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase', isOnline ? 'bg-[#eefcf2] text-[#1fa05c]' : 'bg-[#f4f7ff] text-[#7b8ead]')}>
                    {isOnline ? 'Online' : 'Offline'}
                  </span>
                </div>
              );
            }) : (
              <div className="rounded-[14px] border border-dashed border-[#dbe4f4] px-[14px] py-[12px] text-[13px] text-[#7283a0]">
                Participant details will appear here once the live room syncs.
              </div>
            )}
          </div>
        )}
      </div>
    );
  };
  const selectedTeacherProfile = isReferenceMode
    ? {
      name: liveFigmaReference.detail.teacher,
      role: liveFigmaReference.detail.teacherRole,
      experience: liveFigmaReference.detail.teacherExperience,
      bio: '',
      avatarUrl: null,
    }
    : normalizeLiveTeacherProfile(selectedLiveClass);
  const activeResources = isReferenceMode
    ? liveResourceLibrary.map((resource) => ({
      id: resource.id,
      title: resource.title,
      type: 'PDF',
      url: null,
      description: resource.lines[0] || '',
      lines: [...resource.lines],
    }))
    : (selectedLiveClass?.resources || []);
  const activeNotes = isReferenceMode
    ? [
      'Electric field lines around positive and negative charges',
      'Force relation between charges using Coulomb law',
      'Most asked PYQ patterns and simplification shortcuts',
    ]
    : (selectedLiveClass?.sessionNotes || []);
  const activePoll = isReferenceMode
    ? {
      question: 'Which concept should the teacher revise before ending the class?',
      status: 'live',
      options: [
        { id: 'poll-1', text: 'Numericals' },
        { id: 'poll-2', text: 'Formula recap' },
        { id: 'poll-3', text: 'PYQ walkthrough' },
        { id: 'poll-4', text: 'Doubt solving' },
      ],
    }
    : (selectedLiveClass?.activePoll || null);
  useEffect(() => {
    if (!user?._id) {
      setSelectedPollOption(null);
      return;
    }
    const pollSelection = activePoll?.responses?.[user._id] || null;
    setSelectedPollOption(pollSelection);
  }, [activePoll, user?._id]);
  const featuredTeacherProfile = normalizeLiveTeacherProfile(featuredLiveClass);

  const detailDisplay = isReferenceMode ? {
    title: liveFigmaReference.detail.title,
    subtitle: liveFigmaReference.detail.subtitle,
    meta: liveFigmaReference.detail.meta,
    teacher: liveFigmaReference.detail.teacher,
    audience: liveFigmaReference.detail.audience,
    badge: liveFigmaReference.detail.badge,
    startedAt: liveFigmaReference.detail.startedAt,
    duration: liveFigmaReference.detail.duration,
    students: liveFigmaReference.detail.students,
    earlyTitle: liveFigmaReference.detail.earlyTitle,
    earlyBody: liveFigmaReference.detail.earlyBody,
    about: liveFigmaReference.detail.about,
    topics: liveFigmaReference.detail.topics,
    teacherRole: liveFigmaReference.detail.teacherRole,
    teacherExperience: liveFigmaReference.detail.teacherExperience,
    countdown: liveFigmaReference.detail.countdown,
  } : {
    title: getDisplayLiveClassTitle(selectedLiveClass),
    subtitle: getLiveClassTopicLine(selectedLiveClass),
    meta: getLiveMetaLine(selectedLiveClass),
    teacher: selectedTeacherProfile.name || selectedLiveClass?.instructor || 'Live Faculty',
    audience: Math.max(selectedLiveClass?.attendees || 0, joinedCount) > 0
      ? `${formatCompactCount(Math.max(selectedLiveClass?.attendees || 0, joinedCount))} Students watching`
      : 'Open for enrolled students',
    badge: selectedStatus === 'live' ? 'Live now' : String(selectedLiveClass?.status || 'scheduled'),
    startedAt: selectedLiveClass?.startTime ? formatTime(selectedLiveClass.startTime) : '--:--',
    duration: `${selectedLiveClass?.durationMinutes || 0} min`,
    students: formatCompactCount(Math.max(joinedCount, selectedLiveClass?.attendees || 0)),
    earlyTitle: selectedStatus === 'live' ? 'You can join right now' : 'You’ve joined 5 min early',
    earlyBody: selectedStatus === 'live'
      ? 'Enter the room with chat, notes, participants, and live media already synced.'
      : 'The class will start shortly. Stay tuned!',
    about: selectedLiveClass?.description?.trim()
      || `In this session, we will cover the important concepts of ${getDisplayLiveClassTitle(selectedLiveClass)} along with PYQs, guided discussion, and the complete live class toolkit.`,
    topics: `${Math.max(activeNotes.length, selectedLiveClass?.topicTags?.length || 0, 1)} Topics`,
    teacherRole: selectedTeacherProfile.role || 'Faculty Mentor',
    teacherExperience: selectedTeacherProfile.experience || 'Live classroom instructor',
    countdown,
  };
  const detailInfoRows = isReferenceMode
    ? classInfoRows
    : [
      { label: 'Topics to be covered', value: detailDisplay.topics, icon: CalendarDays, tone: 'bg-[#eef4ff] text-[#2b63df]' },
      { label: 'Class Notes', value: activeResources.length ? `${activeResources.length} shared resources` : 'Will be shared in class', icon: FileText, tone: 'bg-[#f5edff] text-[#8d52ff]' },
      { label: 'Recording', value: selectedLiveClass?.replayAvailable ? 'Available after class ends' : 'Recording disabled', icon: Video, tone: 'bg-[#fff1f1] text-[#ff6d5b]' },
      { label: 'Language', value: getLiveLanguage(selectedLiveClass), icon: Radio, tone: 'bg-[#edfbf1] text-[#26a55a]' },
    ];
  const mobileFeaturedDisplay = isReferenceMode ? {
    liveClassId: referenceClassBindings.featuredId,
    status: liveFigmaReference.featured.status,
    badge: liveFigmaReference.featured.badge,
    title: liveFigmaReference.featured.title,
    subtitle: liveFigmaReference.featured.subtitle,
    meta: liveFigmaReference.featured.meta,
    teacher: liveFigmaReference.featured.teacher,
    teacherAvatarUrl: null,
    posterUrl: null,
    audience: liveFigmaReference.featured.audience,
    buttonLabel: 'Join Live Class',
  } : (
    featuredLiveClass ? {
      liveClassId: featuredLiveClass._id,
      status: getLiveStatusValue(featuredLiveClass),
      badge: getLiveStatusValue(featuredLiveClass) === 'live' ? 'LIVE NOW' : getLiveStatusLabel(featuredLiveClass),
      title: getDisplayLiveClassTitle(featuredLiveClass),
      subtitle: getLiveClassTopicLine(featuredLiveClass),
      meta: getLiveMetaLine(featuredLiveClass),
      teacher: featuredTeacherProfile.name || featuredLiveClass.instructor || 'Live Faculty',
      teacherAvatarUrl: featuredTeacherProfile.avatarUrl || null,
      posterUrl: featuredLiveClass.posterUrl || null,
      audience: Math.max(featuredLiveClass.attendees || 0, joinedCount) > 0
        ? `${formatCompactCount(Math.max(featuredLiveClass.attendees || 0, joinedCount))} watching`
        : 'Open for students',
      buttonLabel: getLiveStatusValue(featuredLiveClass) === 'live' ? 'Join Live Class' : 'View Details',
    } : null
  );
  const mobileTodayCards = isReferenceMode
    ? liveFigmaReference.today.map((card, index) => ({ ...card, liveClassId: referenceClassBindings.todayIds[index] || referenceClassBindings.featuredId }))
    : orderedLiveClasses.map((liveClass, index) => ({
      liveClassId: liveClass._id,
      ...splitTimeLabel(liveClass.startTime),
      topic: getPrimaryTopic(liveClass) || 'Live Session',
      title: getDisplayLiveClassTitle(liveClass),
      meta: [getLiveLevel(liveClass), getLiveLanguage(liveClass)].filter(Boolean).join(' • ') || 'Upcoming Session',
      teacher: normalizeLiveTeacherProfile(liveClass).name || liveClass.instructor || 'Live Faculty',
      teacherAvatarUrl: normalizeLiveTeacherProfile(liveClass).avatarUrl || null,
      status: getLiveStatusValue(liveClass),
      statusLabel: getLiveStatusLabel(liveClass).toUpperCase(),
      attendees: Math.max(liveClass.attendees || 0, 0) > 0 ? `${formatCompactCount(Math.max(liveClass.attendees || 0, 0))} going` : 'Open',
      colorIndex: index,
    }));
  const mobileTomorrowCard = isReferenceMode
    ? { ...liveFigmaReference.tomorrow, liveClassId: referenceClassBindings.tomorrowId }
    : ((orderedLiveClasses[1] || orderedLiveClasses[0]) ? {
      liveClassId: (orderedLiveClasses[1] || orderedLiveClasses[0])._id,
      ...splitTimeLabel((orderedLiveClasses[1] || orderedLiveClasses[0]).startTime),
      topic: getPrimaryTopic(orderedLiveClasses[1] || orderedLiveClasses[0]) || 'Biology',
      title: getDisplayLiveClassTitle(orderedLiveClasses[1] || orderedLiveClasses[0]),
      meta: [getLiveLevel(orderedLiveClasses[1] || orderedLiveClasses[0]), getLiveLanguage(orderedLiveClasses[1] || orderedLiveClasses[0])].filter(Boolean).join(' • ') || 'Upcoming Session',
      teacher: normalizeLiveTeacherProfile(orderedLiveClasses[1] || orderedLiveClasses[0]).name || (orderedLiveClasses[1] || orderedLiveClasses[0]).instructor || 'Live Faculty',
      teacherAvatarUrl: normalizeLiveTeacherProfile(orderedLiveClasses[1] || orderedLiveClasses[0]).avatarUrl || null,
      status: 'upcoming',
      statusLabel: 'UPCOMING',
      attendees: Math.max((orderedLiveClasses[1] || orderedLiveClasses[0]).attendees || 0, 0) > 0
        ? `${formatCompactCount(Math.max((orderedLiveClasses[1] || orderedLiveClasses[0]).attendees || 0, 0))} going`
        : 'Open',
      colorIndex: 3,
    } : null);
  const scheduleCards = [...mobileTodayCards, ...(mobileTomorrowCard ? [mobileTomorrowCard] : [])];
  const myClassTeacher = isReferenceMode ? liveFigmaReference.featured.teacher : (selectedLiveClass?.instructor || '');
  const myClassCards = scheduleCards.filter((item) => item.teacher === myClassTeacher).length > 0
    ? scheduleCards.filter((item) => item.teacher === myClassTeacher)
    : scheduleCards.slice(0, 2);
  const calendarBaseDate = orderedLiveClasses[0]?.startTime ? new Date(orderedLiveClasses[0].startTime) : new Date();
  const calendarYear = calendarBaseDate.getFullYear();
  const calendarMonth = calendarBaseDate.getMonth();
  const calendarMonthLabel = calendarBaseDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const firstDayOfMonth = new Date(calendarYear, calendarMonth, 1);
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const monthLeadingSlots = (firstDayOfMonth.getDay() + 6) % 7;
  const liveDaysInMonth = new Set(
    orderedLiveClasses
      .map((liveClass) => new Date(liveClass.startTime))
      .filter((date) => !Number.isNaN(date.getTime()) && date.getFullYear() === calendarYear && date.getMonth() === calendarMonth)
      .map((date) => date.getDate()),
  );
  const liveCalendarCells = [
    ...Array.from({ length: monthLeadingSlots }, (_, index) => ({
      key: `leading-${index}`,
      label: '',
      muted: true,
      hasClass: false,
      isToday: false,
    })),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const isToday = (() => {
        const now = new Date();
        return now.getFullYear() === calendarYear && now.getMonth() === calendarMonth && now.getDate() === day;
      })();
      return {
        key: `day-${day}`,
        label: String(day),
        muted: false,
        hasClass: liveDaysInMonth.has(day),
        isToday,
      };
    }),
  ];

  const copyIngestValue = async (field: string, value?: string | null) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedIngestField(field);
      window.setTimeout(() => setCopiedIngestField((current) => (current === field ? null : current)), 1800);
    } catch {
      setError('Unable to copy. Select the value and copy it manually.');
    }
  };

  const renderIngestSetupCard = (className = '') => {
    if (!isAdmin || !selectedLiveClass?.ingestServerUrl || !selectedLiveClass?.ingestStreamKey) {
      return null;
    }

    const rows = [
      { key: 'server', label: 'Server', value: selectedLiveClass.ingestServerUrl },
      { key: 'stream-key', label: 'Stream key', value: selectedLiveClass.ingestStreamKey },
    ];

    return (
      <div className={cn('rounded-[22px] border border-[#d9e4ff] bg-white/95 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.06)]', className)}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#eef4ff] text-[#1765f5]">
            <MonitorUp className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[1rem] font-semibold text-[#122444]">OBS ingest</h3>
            <p className="text-[12px] font-medium text-[#6a7a96]">Teacher stream source</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {rows.map((row) => (
            <div key={row.key} className="rounded-[16px] border border-[#edf2fb] bg-[#f8fbff] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#6a7a96]">{row.label}</p>
                <button
                  type="button"
                  onClick={() => void copyIngestValue(row.key, row.value)}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[10px] bg-white px-2.5 text-[12px] font-semibold text-[#1765f5] shadow-[inset_0_0_0_1px_rgba(205,218,255,0.9)]"
                >
                  {copiedIngestField === row.key ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedIngestField === row.key ? 'Copied' : 'Copy'}
                </button>
              </div>
              <code className="block max-h-24 overflow-auto break-all rounded-[12px] bg-white px-3 py-2 text-[12px] leading-5 text-[#122444]">
                {row.value}
              </code>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const toggleAudio = () => {
    if (access?.accessType === 'livekit-room') {
      if (!roomLoaded) {
        setMediaWarning('The live room is still connecting. Wait for the room to finish joining before toggling audio.');
        return;
      }
      if (!selfParticipant?.canSpeak && !isAdmin) {
        setError('Raise your hand and wait for admin approval before speaking.');
        return;
      }
      const nextMuted = !localMicMuted;
      desiredMediaStateRef.current = {
        ...desiredMediaStateRef.current,
        micMuted: nextMuted,
      };
      setLocalMicMuted(nextMuted);
      setMediaWarning(null);
      void EduService.updateLiveMediaState(selectedLiveClass._id, { micMuted: nextMuted }).catch((nextError) => {
        logMedia('warn', 'Unable to sync LiveKit microphone state to the live session.', nextError);
      });
      void liveKitRoomRef.current.localParticipant.setMicrophoneEnabled(!nextMuted)
        .catch((nextError) => {
          logMedia('warn', 'Unable to toggle LiveKit microphone.', nextError);
          setLocalMicMuted(!nextMuted);
          desiredMediaStateRef.current = {
            ...desiredMediaStateRef.current,
            micMuted: !nextMuted,
          };
          void EduService.updateLiveMediaState(selectedLiveClass._id, { micMuted: !nextMuted }).catch((syncError) => {
            logMedia('warn', 'Unable to restore LiveKit microphone state after a toggle failure.', syncError);
          });
          setMediaWarning('Microphone permission was blocked or the microphone is unavailable.');
        });
      return;
    }
    setMediaWarning('Interactive audio is only available in LiveKit classrooms. Recreate this live class with LiveKit to enable microphone control.');
  };

  const toggleVideo = () => {
    if (access?.accessType === 'livekit-room') {
      if (!roomLoaded) {
        setMediaWarning('The live room is still connecting. Wait for the room to finish joining before toggling video.');
        return;
      }
      const nextEnabled = !localVideoEnabled;
      desiredMediaStateRef.current = {
        ...desiredMediaStateRef.current,
        videoEnabled: nextEnabled,
      };
      setLocalVideoEnabled(nextEnabled);
      setMediaWarning(null);
      void EduService.updateLiveMediaState(selectedLiveClass._id, { videoEnabled: nextEnabled }).catch((nextError) => {
        logMedia('warn', 'Unable to sync LiveKit camera state to the live session.', nextError);
      });
      void liveKitRoomRef.current.localParticipant.setCameraEnabled(nextEnabled)
        .catch((nextError) => {
          logMedia('warn', 'Unable to toggle LiveKit camera.', nextError);
          setLocalVideoEnabled(!nextEnabled);
          desiredMediaStateRef.current = {
            ...desiredMediaStateRef.current,
            videoEnabled: !nextEnabled,
          };
          void EduService.updateLiveMediaState(selectedLiveClass._id, { videoEnabled: !nextEnabled }).catch((syncError) => {
            logMedia('warn', 'Unable to restore LiveKit camera state after a toggle failure.', syncError);
          });
          setMediaWarning('Camera permission was blocked or the camera is unavailable.');
        });
      return;
    }
    setMediaWarning('Interactive video is only available in LiveKit classrooms. Recreate this live class with LiveKit to enable camera control.');
  };

  const toggleScreenShare = () => {
    if (access?.accessType === 'livekit-room') {
      if (!roomLoaded || !isLiveKitRoomConnected(liveKitRoomRef.current)) {
        setMediaWarning('The live room is still connecting. Wait for the room to finish joining before starting screen share.');
        return;
      }
      if (!isAdmin) {
        return;
      }
      const nextSharing = !localScreenSharing;
      if (nextSharing && !supportsDisplayCapture()) {
        setMediaWarning('This mobile browser or WebView does not expose screen sharing. Enable display capture in the native app WebView or use Chrome/Edge.');
        return;
      }
      desiredMediaStateRef.current = {
        ...desiredMediaStateRef.current,
        isScreenSharing: nextSharing,
      };
      setMediaWarning(null);
      void liveKitRoomRef.current.localParticipant.setScreenShareEnabled(nextSharing)
        .then(() => {
          setLocalScreenSharing(nextSharing);
          return EduService.updateLiveMediaState(selectedLiveClass._id, { isScreenSharing: nextSharing });
        })
        .catch((nextError) => {
          logMedia('warn', 'Unable to toggle LiveKit screen share.', nextError);
          desiredMediaStateRef.current = {
            ...desiredMediaStateRef.current,
            isScreenSharing: !nextSharing,
          };
          setMediaWarning('Screen sharing was blocked or cancelled. Allow display capture and try again.');
        });
      return;
    }
    setMediaWarning('Screen sharing is only available in LiveKit classrooms. Recreate this live class with LiveKit to enable screen sharing.');
  };

  const createStartDate = formatDateInputValue(createForm.startTime);
  const createStartClock = formatTimeInputValue(createForm.startTime);
  const createEndClock = (() => {
    if (!createForm.startTime) {
      return '';
    }
    const end = new Date(new Date(createForm.startTime).getTime() + Number(createForm.durationMinutes || 90) * 60000);
    const hours = String(end.getHours()).padStart(2, '0');
    const minutes = String(end.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  })();
  const createPreviewTeacher = createForm.instructor.trim() || user?.name || 'Live Faculty';
  const createPreviewRole = createForm.teacherRole.trim() || 'Teacher';
  const createPreviewMeta = [createForm.subject.trim(), createForm.classLevel.trim()].filter(Boolean).join(' • ') || 'Live Session';
  const createLearningPoints = createForm.sessionNotesText.split('\n').map((entry) => entry.trim()).filter(Boolean);
  const createSectionCardClassName = 'rounded-[20px] border border-[#e6ecf7] bg-white p-4 shadow-[0_10px_22px_rgba(16,24,40,0.04)] md:p-5';
  const createFieldClassName = 'h-[46px] w-full rounded-[12px] border border-[#dbe4f4] bg-white px-4 text-[14px] text-[#162340] outline-none transition focus:border-[#4f46e5] focus:ring-2 focus:ring-[#dcd8ff]';
  const createTextAreaClassName = 'w-full rounded-[12px] border border-[#dbe4f4] bg-white px-4 py-3 text-[14px] text-[#162340] outline-none transition focus:border-[#4f46e5] focus:ring-2 focus:ring-[#dcd8ff]';

  const toggleLiveRoomFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      await (desktopRoomStageRef.current || mobileRoomStageRef.current || document.documentElement).requestFullscreen();
    } catch (fullscreenError) {
      setUiNotice('Fullscreen is not available on this device. Rotate your phone for a larger live class view.');
    }
  };

  const teacherStudioUrl = access?.embedUrl || access?.roomUrl || null;
  const openTeacherStudio = () => {
    const studioUrl = teacherStudioUrl;
    if (!studioUrl || typeof window === 'undefined') {
      return;
    }

    window.open(studioUrl, '_blank', 'noopener,noreferrer');
  };

  const updateCreateFormDateTime = (patch: { date?: string; time?: string; endTime?: string }) => {
    const nextDate = patch.date ?? createStartDate ?? '';
    const nextTime = patch.time ?? createStartClock ?? '';
    const resolvedDate = nextDate || new Date().toISOString().slice(0, 10);
    const resolvedTime = nextTime || '10:00';
    const nextStartTime = buildDateTimeValue(resolvedDate, resolvedTime);
    const nextDuration = patch.endTime
      ? calculateDurationMinutes(nextStartTime, patch.endTime, Number(createForm.durationMinutes || 90))
      : createForm.durationMinutes;
    setCreateForm((current) => ({
      ...current,
      startTime: nextStartTime,
      durationMinutes: nextDuration,
    }));
  };

  const renderCreateField = (
    label: string,
    control: React.ReactNode,
    options?: { required?: boolean; hint?: string },
  ) => (
    <label className="block">
      <span className="mb-2 block text-[12px] font-semibold text-[#233256]">
        {label}
        {options?.required ? <span className="ml-1 text-[#ef4444]">*</span> : null}
      </span>
      {control}
      {options?.hint ? <span className="mt-1 block text-[11px] text-[#7b88a8]">{options.hint}</span> : null}
    </label>
  );

  const renderCreatePreviewCard = (mobile = false) => (
    <aside className={cn(createSectionCardClassName, mobile ? '' : 'sticky top-6')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[15px] font-semibold text-[#13244a]">Live Class Preview</p>
          <p className="mt-1 text-[12px] text-[#7283a0]">Real student-facing summary</p>
        </div>
        <span className="rounded-full bg-[#fff1f1] px-2.5 py-1 text-[11px] font-semibold text-[#ef4444]">
          {editingLiveClassId ? 'UPDATE' : 'LIVE'}
        </span>
      </div>
      <div className="mt-4 overflow-hidden rounded-[18px] border border-[#e7ecf8] bg-[#0f172a]">
        <div className="aspect-[16/9] overflow-hidden bg-[radial-gradient(circle_at_top,#2a58d8_0%,#13203b_55%,#0f172a_100%)]">
          {createForm.posterUrl.trim() ? (
            <img src={createForm.posterUrl.trim()} alt={createForm.title || 'Live class poster'} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full p-6">
              <LivePosterEmptyState dark message="Upload a class poster to preview the live card" />
            </div>
          )}
        </div>
        <div className="space-y-3 px-4 py-4 text-white">
          <span className="inline-flex rounded-full bg-[#fff5f5] px-2.5 py-1 text-[11px] font-semibold text-[#ef4444]">LIVE NOW</span>
          <div>
            <h3 className="text-[18px] font-semibold leading-[1.2]">{createForm.title.trim() || 'Enter class title'}</h3>
            <p className="mt-1 text-[13px] text-white/75">{createForm.classDescription.trim() || 'Class description will appear here for students.'}</p>
          </div>
          <p className="text-[12px] font-medium text-white/70">{createPreviewMeta}</p>
          <div className="flex items-center gap-3">
            <TeacherAvatar name={createPreviewTeacher} photoUrl={createForm.teacherAvatarUrl.trim() || null} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold">{createPreviewTeacher}</p>
              <p className="truncate text-[12px] text-white/70">{createPreviewRole}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[12px] text-white/75">
            <div className="rounded-[12px] bg-white/10 px-3 py-2"><p>Date</p><p className="mt-1 font-semibold text-white">{createStartDate || 'Select date'}</p></div>
            <div className="rounded-[12px] bg-white/10 px-3 py-2"><p>Time</p><p className="mt-1 font-semibold text-white">{createStartClock || 'Select time'}</p></div>
            <div className="rounded-[12px] bg-white/10 px-3 py-2"><p>Duration</p><p className="mt-1 font-semibold text-white">{createForm.durationMinutes || 0} min</p></div>
            <div className="rounded-[12px] bg-white/10 px-3 py-2"><p>Students</p><p className="mt-1 font-semibold text-white">Max {createForm.maxAttendees || 0}</p></div>
          </div>
        </div>
      </div>
      {createLearningPoints.length > 0 && (
        <div className="mt-4 rounded-[16px] border border-[#ecf0f8] bg-[#fbfcff] p-4">
          <p className="text-[13px] font-semibold text-[#13244a]">What students will learn</p>
          <ul className="mt-3 space-y-2">
            {createLearningPoints.slice(0, 4).map((point) => (
              <li key={point} className="flex items-start gap-2 text-[12px] text-[#4a5c7a]">
                <Check className="mt-0.5 h-4 w-4 text-[#4f46e5]" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );

  const renderCreateStepContent = () => {
    switch (createStep) {
      case 0:
        return (
          <div className="grid gap-4 md:grid-cols-2">
            {renderCreateField('Class Title', <input data-testid="live-create-title" value={createForm.title} onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))} placeholder="Enter class title" className={createFieldClassName} />, { required: true })}
            {renderCreateField('Subject', <input data-testid="live-create-subject" value={createForm.subject} onChange={(event) => setCreateForm((current) => ({ ...current, subject: event.target.value }))} placeholder="Physics" className={createFieldClassName} />, { required: true })}
            {renderCreateField('Class Category', <input value={createForm.category} onChange={(event) => setCreateForm((current) => ({ ...current, category: event.target.value }))} placeholder="Important Concepts & PYQs" className={createFieldClassName} />)}
            {renderCreateField('Class Level', <input value={createForm.classLevel} onChange={(event) => setCreateForm((current) => ({ ...current, classLevel: event.target.value }))} placeholder="Class 12" className={createFieldClassName} />)}
            {renderCreateField('Teacher / Instructor', <input data-testid="live-create-instructor" value={createForm.instructor} onChange={(event) => setCreateForm((current) => ({ ...current, instructor: event.target.value }))} placeholder="Rahul Sharma" className={createFieldClassName} />, { required: true })}
            {renderCreateField('Language', (
              <select value={createForm.language} onChange={(event) => setCreateForm((current) => ({ ...current, language: event.target.value }))} className={createFieldClassName}>
                <option value="English">English</option>
                <option value="Hindi">Hindi</option>
                <option value="Bilingual">Bilingual</option>
              </select>
            ))}
            <div className="md:col-span-2">
              {renderCreateField('Hero Image', (
                <div className="rounded-[16px] border border-dashed border-[#d7e3fb] bg-[#fbfcff] p-4">
                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                    <label className="flex min-h-[124px] cursor-pointer flex-col items-center justify-center rounded-[14px] border border-dashed border-[#cddbfb] bg-white px-4 py-5 text-center transition hover:border-[#2f6fe4] hover:bg-[#f9fbff]">
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => void handleLiveImageUpload('poster', event.target.files?.[0] || null)} />
                      {uploadingPoster ? <Loader2 className="h-5 w-5 animate-spin text-[#2f6fe4]" /> : <Upload className="h-5 w-5 text-[#2f6fe4]" />}
                      <span className="mt-3 text-[13px] font-semibold text-[#1f2d4e]">{uploadingPoster ? 'Uploading poster...' : 'Upload poster image'}</span>
                      <span className="mt-1 text-[11px] text-[#7b88a8]">PNG, JPG, or WEBP up to 10 MB</span>
                    </label>
                    <div className="overflow-hidden rounded-[14px] border border-[#dfe7f5] bg-white">
                      {createForm.posterUrl.trim() ? (
                        <img src={createForm.posterUrl.trim()} alt={createForm.title || 'Poster preview'} className="h-full min-h-[124px] w-full object-cover" />
                      ) : (
                        <LivePosterEmptyState compact message="No poster uploaded" />
                      )}
                    </div>
                  </div>
                </div>
              ), { hint: 'Upload the live class poster used in the student list and detail views.' })}
            </div>
          </div>
        );
      case 1:
        return (
          <div className="space-y-4">
            <input
              data-testid="live-create-start-datetime"
              type="datetime-local"
              value={createForm.startTime}
              onChange={(event) => setCreateForm((current) => ({ ...current, startTime: event.target.value }))}
              className="sr-only"
              aria-hidden="true"
              tabIndex={-1}
            />
            <div className="grid gap-4 md:grid-cols-2">
              {renderCreateField('Date', <input data-testid="live-create-date" type="date" value={createStartDate} onChange={(event) => updateCreateFormDateTime({ date: event.target.value })} className={createFieldClassName} />, { required: true })}
              {renderCreateField('Start Time', <input data-testid="live-create-start-time" type="time" value={createStartClock} onChange={(event) => updateCreateFormDateTime({ time: event.target.value })} className={createFieldClassName} />, { required: true })}
              {renderCreateField('End Time', <input data-testid="live-create-end-time" type="time" value={createEndClock} onChange={(event) => updateCreateFormDateTime({ endTime: event.target.value })} className={createFieldClassName} />)}
              {renderCreateField('Duration', <input data-testid="live-create-duration" type="number" min={15} step={5} value={createForm.durationMinutes} onChange={(event) => setCreateForm((current) => ({ ...current, durationMinutes: Number(event.target.value) }))} className={createFieldClassName} />, { required: true, hint: 'Minutes' })}
            </div>
            <div className="rounded-[16px] border border-[#d9e4ff] bg-[#f6f8ff] px-4 py-3 text-[12px] text-[#4d5f82]"><span className="font-semibold text-[#3c57d8]">Tip:</span> Students will receive a reminder before the class starts.</div>
            <div className="grid gap-4 md:grid-cols-2">
              {renderCreateField('Link this live class to', (
                <select data-testid="live-create-linkage-type" value={createForm.linkageType} onChange={(event) => setCreateForm((current) => ({ ...current, linkageType: event.target.value as typeof current.linkageType, courseId: '', moduleId: '', chapterId: '', mockTestId: '' }))} className={createFieldClassName}>
                  <option value="standalone">Standalone live class</option>
                  <option value="course">Course subject / chapter</option>
                  <option value="mock-test">Mock test explanation</option>
                </select>
              ))}
              {createForm.linkageType === 'mock-test' ? renderCreateField('Mock Test', (
                <select value={createForm.mockTestId} onChange={(event) => setCreateForm((current) => ({ ...current, mockTestId: event.target.value }))} className={createFieldClassName}>
                  <option value="">Select mock test</option>
                  {overview.testSeries.map((test) => <option key={test._id} value={test._id}>{test.title}</option>)}
                </select>
              )) : <div />}
              {createForm.linkageType === 'course' && renderCreateField('Course', (
                <select value={createForm.courseId} onChange={(event) => setCreateForm((current) => ({ ...current, courseId: event.target.value, moduleId: '', chapterId: '' }))} className={createFieldClassName}>
                  <option value="">Select course</option>
                  {overview.courses.map((course) => <option key={course._id} value={course._id}>{course.title}</option>)}
                </select>
              ))}
              {createForm.linkageType === 'course' && createForm.courseId && renderCreateField('Subject / Module', (
                <select value={createForm.moduleId} onChange={(event) => setCreateForm((current) => ({ ...current, moduleId: event.target.value, chapterId: '' }))} className={createFieldClassName}>
                  <option value="">Select subject / module</option>
                  {(overview.courses.find((course) => course._id === createForm.courseId)?.modules || []).map((module) => <option key={module.id} value={module.id}>{module.title}</option>)}
                </select>
              ))}
              {createForm.linkageType === 'course' && createForm.moduleId && renderCreateField('Chapter', (
                <select value={createForm.chapterId} onChange={(event) => setCreateForm((current) => ({ ...current, chapterId: event.target.value }))} className={createFieldClassName}>
                  <option value="">Whole module</option>
                  {(overview.courses.find((course) => course._id === createForm.courseId)?.modules.find((module) => module.id === createForm.moduleId)?.chapters || []).map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
                </select>
              ))}
            </div>
          </div>
        );
      case 2:
        return (
          <div className="space-y-4">
            {renderCreateField('Short Description', <textarea value={createForm.classDescription} onChange={(event) => setCreateForm((current) => ({ ...current, classDescription: event.target.value }))} rows={4} placeholder="Describe what students should expect from this class." className={createTextAreaClassName} />, { required: true })}
            {renderCreateField('What students will learn', <textarea value={createForm.sessionNotesText} onChange={(event) => setCreateForm((current) => ({ ...current, sessionNotesText: event.target.value }))} rows={5} placeholder={'Add one learning point per line'} className={createTextAreaClassName} />, { hint: 'One point per line.' })}
            <div className="grid gap-4 md:grid-cols-2">
              {renderCreateField('Teacher Role / Qualification', <input value={createForm.teacherRole} onChange={(event) => setCreateForm((current) => ({ ...current, teacherRole: event.target.value }))} placeholder="Physics Expert" className={createFieldClassName} />)}
              {renderCreateField('Experience', <input value={createForm.teacherExperience} onChange={(event) => setCreateForm((current) => ({ ...current, teacherExperience: event.target.value }))} placeholder="8+ Years" className={createFieldClassName} />)}
              <div className="md:col-span-2">
                {renderCreateField('Teacher Bio', <textarea value={createForm.teacherBio} onChange={(event) => setCreateForm((current) => ({ ...current, teacherBio: event.target.value }))} rows={4} placeholder="Short instructor introduction" className={createTextAreaClassName} />)}
              </div>
              {renderCreateField('Teacher Photo', (
                <div className="rounded-[16px] border border-dashed border-[#d7e3fb] bg-[#fbfcff] p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3">
                      <TeacherAvatar name={createForm.instructor || 'Teacher'} photoUrl={createForm.teacherAvatarUrl.trim() || null} size="lg" />
                      <div>
                        <p className="text-[13px] font-semibold text-[#1f2d4e]">{createForm.instructor.trim() || 'Teacher photo'}</p>
                        <p className="mt-1 text-[11px] text-[#7b88a8]">Shown on class cards and details.</p>
                      </div>
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-[12px] border border-[#dbe4f4] bg-white px-4 py-2.5 text-[13px] font-semibold text-[#2f6fe4]">
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => void handleLiveImageUpload('teacher-avatar', event.target.files?.[0] || null)} />
                      {uploadingTeacherPhoto ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      <span>{uploadingTeacherPhoto ? 'Uploading...' : 'Upload photo'}</span>
                    </label>
                  </div>
                </div>
              ))}
              {renderCreateField('Preview Video URL', <input value={createForm.previewVideoUrl} onChange={(event) => setCreateForm((current) => ({ ...current, previewVideoUrl: event.target.value }))} placeholder="https://..." className={createFieldClassName} />, { hint: 'Optional teaser or preview clip.' })}
              {renderCreateField('Attachment Title', <input value={createForm.attachmentTitle} onChange={(event) => setCreateForm((current) => ({ ...current, attachmentTitle: event.target.value }))} placeholder="Electrostatics formula sheet" className={createFieldClassName} />)}
              {renderCreateField('Attachment URL', <input value={createForm.attachmentUrl} onChange={(event) => setCreateForm((current) => ({ ...current, attachmentUrl: event.target.value }))} placeholder="https://..." className={createFieldClassName} />)}
            </div>
          </div>
        );
      case 3:
        return (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {renderCreateField('Reminder', (
                <select value={String(createForm.reminderLeadMinutes)} onChange={(event) => setCreateForm((current) => ({ ...current, reminderLeadMinutes: Number(event.target.value) }))} className={createFieldClassName}>
                  <option value="15">15 min before</option>
                  <option value="30">30 min before</option>
                  <option value="60">1 hour before</option>
                </select>
              ))}
              {renderCreateField('Visible to Students', (
                <select value={createForm.visibleToStudents} onChange={(event) => setCreateForm((current) => ({ ...current, visibleToStudents: event.target.value }))} className={createFieldClassName}>
                  <option value="Immediately">Immediately</option>
                  <option value="After Publish">After publish</option>
                </select>
              ))}
              {renderCreateField('Max Students', <input type="number" min={1} value={createForm.maxAttendees} onChange={(event) => setCreateForm((current) => ({ ...current, maxAttendees: Number(event.target.value) }))} className={createFieldClassName} />)}
              {renderCreateField('Class Price', <input value={createForm.priceLabel} onChange={(event) => setCreateForm((current) => ({ ...current, priceLabel: event.target.value }))} placeholder="Free" className={createFieldClassName} />)}
              {renderCreateField('Certificate', (
                <select value={createForm.certificateLabel} onChange={(event) => setCreateForm((current) => ({ ...current, certificateLabel: event.target.value }))} className={createFieldClassName}>
                  <option value="No Certificate">No Certificate</option>
                  <option value="Completion Certificate">Completion Certificate</option>
                </select>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {[
                { key: 'allowLiveChat', label: 'Allow Live Chat' },
                { key: 'allowQa', label: 'Allow Q&A' },
                { key: 'enableClassRecording', label: 'Enable Class Recording' },
              ].map((option) => (
                <label key={option.key} className="flex items-center justify-between rounded-[16px] border border-[#e5ebf7] bg-[#fbfcff] px-4 py-3">
                  <span className="text-[13px] font-semibold text-[#1f2d4e]">{option.label}</span>
                  <button
                    type="button"
                    onClick={() => setCreateForm((current) => ({ ...current, [option.key]: !current[option.key as keyof typeof current] }))}
                    className={cn('relative h-7 w-12 rounded-full transition', createForm[option.key as keyof typeof createForm] ? 'bg-[#4f46e5]' : 'bg-[#d7deec]')}
                  >
                    <span className={cn('absolute top-1 h-5 w-5 rounded-full bg-white transition', createForm[option.key as keyof typeof createForm] ? 'left-6' : 'left-1')} />
                  </button>
                </label>
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {renderCreateField('Poll Question', <input value={createForm.pollQuestion} onChange={(event) => setCreateForm((current) => ({ ...current, pollQuestion: event.target.value }))} placeholder="Optional live poll question" className={createFieldClassName} />)}
              <div className="md:col-span-2">
                {renderCreateField('Poll Options', <textarea value={createForm.pollOptionsText} onChange={(event) => setCreateForm((current) => ({ ...current, pollOptionsText: event.target.value }))} rows={3} placeholder={'One option per line'} className={createTextAreaClassName} />, { hint: 'Only needed when you want a poll in the live room.' })}
              </div>
            </div>
          </div>
        );
      default:
        return (
          <div className="space-y-4">
            <div className="rounded-[20px] border border-[#e5ebf7] bg-[#fbfcff] p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#7283a0]">Basic Info</p>
                  <div className="mt-3 space-y-2 text-[14px] text-[#1f2d4e]">
                    <p><span className="font-semibold">Title:</span> {createForm.title || 'Pending'}</p>
                    <p><span className="font-semibold">Subject:</span> {createForm.subject || 'Pending'}</p>
                    <p><span className="font-semibold">Teacher:</span> {createPreviewTeacher}</p>
                    <p><span className="font-semibold">Language:</span> {createForm.language}</p>
                  </div>
                </div>
                <div>
                  <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#7283a0]">Schedule & Settings</p>
                  <div className="mt-3 space-y-2 text-[14px] text-[#1f2d4e]">
                    <p><span className="font-semibold">Date:</span> {createStartDate || 'Pending'}</p>
                    <p><span className="font-semibold">Start:</span> {createStartClock || 'Pending'}</p>
                    <p><span className="font-semibold">Duration:</span> {createForm.durationMinutes} min</p>
                    <p><span className="font-semibold">Max students:</span> {createForm.maxAttendees}</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="rounded-[20px] border border-[#e5ebf7] bg-white p-4">
              <p className="text-[15px] font-semibold text-[#13244a]">Ready to publish</p>
              <p className="mt-1 text-[13px] text-[#7283a0]">Review the preview and publish this live class for students.</p>
            </div>
          </div>
        );
    }
  };

  const renderCreateStepper = (mobile = false) => (
    <div className={cn('rounded-[18px] border border-[#e5ebf7] bg-white', mobile ? 'px-3 py-3' : 'px-4 py-3')}>
      <div className={cn('flex flex-wrap items-center', mobile ? 'gap-x-3 gap-y-2' : 'gap-2 md:gap-3')}>
        {liveCreationSteps.map((step, index) => (
          <button
            key={step.id}
            type="button"
            onClick={() => setCreateStep(index)}
            className={cn(
              'group inline-flex items-center rounded-full text-left',
              mobile ? 'gap-1.5 px-0 py-0.5' : 'gap-2 px-2 py-1',
            )}
          >
            <span className={cn(
              'flex items-center justify-center rounded-full text-[12px] font-semibold',
              mobile ? 'h-7 w-7' : 'h-7 w-7',
              index === createStep
                ? 'bg-[#4f46e5] text-white'
                : index < createStep
                  ? 'bg-[#eef4ff] text-[#3557d4]'
                  : 'bg-[#f4f6fb] text-[#7b88a8]',
            )}>
              {index + 1}
            </span>
            <span className={cn('font-medium', mobile ? 'text-[11px]' : 'text-[13px]', index === createStep ? 'text-[#2a3e69]' : 'text-[#7b88a8]')}>
              {step.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  const renderCreateActions = (mobile = false) => (
    <div className={cn('flex items-center justify-between gap-3', mobile && 'pb-[calc(env(safe-area-inset-bottom,0px)+4px)]')}>
      <button
        type="button"
        onClick={() => setCreateStep((current) => Math.max(current - 1, 0))}
        disabled={createStep === 0}
        className={cn(
          'rounded-[12px] border border-[#d8e2f4] bg-white font-semibold text-[#35507b] disabled:opacity-50',
          mobile ? 'px-4 py-3 text-[14px]' : 'px-4 py-2 text-[13px]',
        )}
      >
        Back
      </button>
      <div className="flex items-center gap-2">
        {editingLiveClassId && !mobile && (
          <button type="button" onClick={() => void handleDeleteLiveClass()} className="rounded-[12px] border border-[#ffd8d8] bg-[#fff5f5] px-4 py-2 text-[13px] font-semibold text-[#cf3f3f]">
            Delete
          </button>
        )}
        <button
          type="button"
          onClick={resetLiveClassEditor}
          className={cn(
            'rounded-[12px] border border-[#d8e2f4] bg-white font-semibold text-[#35507b]',
            mobile ? 'px-4 py-3 text-[14px]' : 'px-4 py-2 text-[13px]',
          )}
        >
          Cancel
        </button>
        {createStep < liveCreationSteps.length - 1 ? (
          <button
            type="button"
            data-testid="live-create-next"
            onClick={() => setCreateStep((current) => Math.min(current + 1, liveCreationSteps.length - 1))}
            className={cn(
              'rounded-[12px] bg-[#4f46e5] font-semibold text-white',
              mobile ? 'px-5 py-3 text-[14px]' : 'px-4 py-2 text-[13px]',
            )}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            data-testid="live-create-submit"
            disabled={busy}
            onClick={() => void handleCreateLiveClass()}
            className={cn(
              'rounded-[12px] bg-[#4f46e5] font-semibold text-white disabled:opacity-60',
              mobile ? 'px-5 py-3 text-[14px]' : 'px-5 py-2.5 text-[13px]',
            )}
          >
            {busy ? (editingLiveClassId ? 'Saving...' : 'Publishing...') : (editingLiveClassId ? 'Save Changes' : 'Publish Live Class')}
          </button>
        )}
      </div>
    </div>
  );

  const renderCreateBuilder = (mobile = false) => {
    if (mobile) {
      return (
        <div data-testid="live-create-form" className="fixed inset-0 z-[90] bg-[#f6f8ff]">
          <div className="mx-auto flex h-full max-w-[430px] flex-col">
            <div className="border-b border-[#e7edf8] bg-[#f6f8ff] px-4 pb-4 pt-4">
              <div className="flex items-center justify-between">
                <button type="button" onClick={resetLiveClassEditor} className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[#dde6f6] bg-white text-[#1f2d4e] shadow-[0_8px_18px_rgba(28,41,61,0.06)]">
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div className="text-center">
                  <h3 className="text-[20px] font-semibold tracking-[-0.03em] text-[#13244a]">{editingLiveClassId ? 'Update Live Class' : 'Create Live Class'}</h3>
                </div>
                <div className="h-10 w-10" />
              </div>
              <p className="mt-3 text-[13px] text-[#7283a0]">Fill in the details below to schedule your live class.</p>
              <div className="mt-4">
                {renderCreateStepper(true)}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="space-y-4">
                <div className="rounded-[24px] border border-[#dde6f6] bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.07)]">
                  <div className="mb-4">
                    <h4 className="text-[18px] font-semibold text-[#13244a]">{liveCreationSteps[createStep].label}</h4>
                    <p className="mt-1 text-[13px] text-[#7283a0]">Guide the admin through one clear stage at a time.</p>
                  </div>
                  {renderCreateStepContent()}
                </div>
                {createStep === liveCreationSteps.length - 1 ? renderCreatePreviewCard(true) : null}
              </div>
            </div>

            <div className="border-t border-[#e7edf8] bg-[#f6f8ff] px-4 py-3">
              {renderCreateActions(true)}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        data-testid="live-create-form"
        className="mt-5 grid gap-4 rounded-[26px] border border-[#dde6f6] bg-[#f8fbff] p-4 shadow-[0_18px_40px_rgba(15,23,42,0.06)] xl:grid-cols-[minmax(0,1.65fr)_340px]"
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[24px] font-semibold tracking-[-0.03em] text-[#13244a]">{editingLiveClassId ? 'Update Live Class' : 'Create Live Class'}</h3>
              <p className="mt-1 text-[13px] text-[#7283a0]">Fill in the details below to schedule your live class.</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={resetLiveClassEditor} className="rounded-[12px] border border-[#d8e2f4] bg-white px-4 py-2 text-[13px] font-semibold text-[#35507b]">Save as Draft</button>
              <button type="button" data-testid="live-create-next-header" onClick={() => setCreateStep((current) => Math.min(current + 1, liveCreationSteps.length - 1))} className="rounded-[12px] bg-[#4f46e5] px-4 py-2 text-[13px] font-semibold text-white">Next Step</button>
            </div>
          </div>
          {renderCreateStepper(false)}
          <div className={createSectionCardClassName}>
            <div className="mb-4">
              <h4 className="text-[18px] font-semibold text-[#13244a]">{liveCreationSteps[createStep].label}</h4>
              <p className="mt-1 text-[13px] text-[#7283a0]">Guide the admin through one clear stage at a time.</p>
            </div>
            {renderCreateStepContent()}
          </div>
          {renderCreateActions(false)}
        </div>
        {renderCreatePreviewCard(false)}
      </div>
    );
  };

  if (!selectedLiveClass) {
    return (
      <div data-testid="live-classes-page" className="rounded-[32px] border border-white/70 bg-white/90 p-8 text-[var(--ink-soft)] shadow-[0_24px_70px_rgba(15,23,42,0.08)]">
        {error && (
          <div className="mb-5 rounded-[18px] border border-[#ffd2d2] bg-[#fff5f5] px-4 py-3 text-sm text-[#c93636]">
            {error}
          </div>
        )}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-[1.6rem] font-semibold tracking-[-0.04em] text-[#13244a]">Live Classes</h2>
            <p className="mt-1 text-[14px] text-[#7384a5]">No live classes are available yet.</p>
          </div>
          {isAdmin && (
            <button
              type="button"
              data-testid="live-create-toggle"
              onClick={toggleNewLiveClassEditor}
              className="inline-flex items-center justify-center gap-2 rounded-[14px] bg-[#125df4] px-4 py-3 text-[14px] font-semibold text-white shadow-[0_12px_22px_rgba(18,93,244,0.2)]"
            >
              <Plus className="h-4 w-4" />
              Create Live Class
            </button>
          )}
        </div>

        {createOpen && isAdmin && renderCreateBuilder(false)}
      </div>
    );
  }

  return (
    <div className={cn('space-y-5', view === 'room' && 'space-y-3')} style={liveUiFontStyle}>
      {error && view !== 'room' && (
        <div className="rounded-[18px] border border-[#ffd2d2] bg-[#fff5f5] px-4 py-3 text-sm text-[#c93636]">
          {error}
        </div>
      )}
      {uiNotice && !isReferenceMode && (
        <div className="rounded-[16px] border border-[#d9e4ff] bg-[#eef4ff] px-4 py-3 text-[13px] font-medium text-[#2f6fe4]">
          {uiNotice}
        </div>
      )}

      {view === 'list' && (
        <div
          data-testid="live-classes-page"
          className={cn(
            'mobile-safe-screen grid min-h-[100dvh] gap-4 overflow-x-hidden bg-[#f4f7ff] pb-[96px] xl:grid-cols-[minmax(0,1.72fr)_328px]',
            isReferenceMode && 'relative -mx-4 bg-white px-4 pt-2 sm:mx-0 sm:px-0 sm:pt-0',
          )}
        >
          <section className={cn('mobile-safe-content mx-auto space-y-[12px] pb-[8px] pt-[10px] sm:max-w-none sm:px-0 sm:pt-0', isReferenceMode && 'pt-[10px]')}>
            {isReferenceMode && (
              <div className="md:hidden">
                <MobileStatusBar />
              </div>
            )}
            <div data-testid="live-hero-card" className={cn('rounded-[18px] border border-[#dfe7f5] bg-white p-[12px] shadow-[0_8px_18px_rgba(28,41,61,0.05)] md:rounded-[24px] md:p-5', isReferenceMode && 'rounded-none border-0 bg-transparent p-0 shadow-none')}>
              <div className="md:hidden">
                <h2 className="text-[18px] font-semibold leading-none tracking-[-0.02em] text-[#1f2d4e]">Live Classes</h2>
              </div>
              <div className="flex items-start justify-between gap-4">
                <div className="hidden md:block">
                  <h2 className="text-[1.75rem] font-semibold tracking-[-0.04em] text-[#13244a] md:text-[2.1rem]">Live Classes</h2>
                  <p className="mt-1 text-[13px] text-[#7384a5] md:text-[14px]">Learn live from expert faculty and stay ahead.</p>
                </div>
                {isAdmin && (
                  <button
                    type="button"
                    data-testid="live-create-toggle"
                    onClick={toggleNewLiveClassEditor}
                    className="hidden items-center gap-2 rounded-[14px] bg-[#125df4] px-3.5 py-2 text-[13px] font-semibold text-white shadow-[0_12px_22px_rgba(18,93,244,0.2)] md:inline-flex"
                  >
                    <Plus className="h-4 w-4" />
                    Create Live Class
                  </button>
                )}
              </div>

              {mobileFeaturedDisplay && (
                <button
                  type="button"
                  data-testid="live-featured-card"
                  onClick={() => mobileFeaturedDisplay.liveClassId ? void openLiveClass(mobileFeaturedDisplay.liveClassId) : undefined}
                  className={cn(
                    'mt-[14px] grid w-full gap-[10px] rounded-[18px] border border-[#dfe7f5] bg-[#eef4ff] px-[12px] py-[12px] text-left shadow-[0_12px_24px_rgba(28,41,61,0.07)] md:grid-cols-[1fr_320px] md:gap-4 md:rounded-[20px] md:p-5',
                    isReferenceMode ? 'grid-cols-[minmax(0,1fr)_136px] gap-[8px]' : 'grid-cols-[minmax(0,1fr)_120px]',
                  )}
                >
                  <div className="min-w-0">
                    <span className={cn('inline-flex items-center gap-[5px] rounded-full px-[9px] py-[5px] text-[10px] font-semibold uppercase tracking-[0.08em]', mobileFeaturedDisplay.status === 'live' ? 'bg-[#fff0f0] text-[#d23b3b]' : getStatusTone(mobileFeaturedDisplay.status || 'scheduled'))}>
                      {mobileFeaturedDisplay.badge}
                    </span>
                    <h3 className={cn('mt-[9px] line-clamp-2 leading-[1.16] tracking-[-0.01em] text-[#1a2f57] md:text-[1.95rem]', isReferenceMode ? 'text-[16px] font-semibold md:max-w-[320px] md:text-[18px]' : 'text-[16px] font-semibold')}>
                      {mobileFeaturedDisplay.title}
                    </h3>
                    <p className={cn('mt-[6px] line-clamp-2 leading-[1.35] text-[#5b6f93] md:text-[14px]', isReferenceMode ? 'text-[12px] md:max-w-[320px]' : 'text-[12px]')}>{mobileFeaturedDisplay.subtitle}</p>
                    <p className="mt-[5px] text-[11px] text-[#7283a0] md:text-[13px]">{mobileFeaturedDisplay.meta}</p>
                    <div className="mt-[8px] flex items-center gap-[8px] text-[#4b6288]">
                      {isReferenceMode ? <ReferenceTeacherAvatar size="sm" /> : <TeacherAvatar name={mobileFeaturedDisplay.teacher} photoUrl={mobileFeaturedDisplay.teacherAvatarUrl} size="sm" />}
                      <div className="min-w-0">
                        <p className={cn('truncate font-semibold text-[#1f2d4e] md:text-[15px]', isReferenceMode ? 'text-[13px]' : 'text-[13px]')}>{mobileFeaturedDisplay.teacher}</p>
                        <p className="truncate text-[12px] text-[#6d7c93] md:text-[13px]">{mobileFeaturedDisplay.audience}</p>
                      </div>
                    </div>
                    <div className={cn('mt-[10px]', isReferenceMode && 'mt-[10px]')}>
                      <div className={cn('inline-flex h-[36px] min-w-[132px] items-center justify-between rounded-[11px] bg-[#1f6ff2] px-[13px] text-[13px] font-semibold text-white shadow-[0_10px_20px_rgba(31,111,242,0.2)]', isReferenceMode ? 'w-[138px] max-w-full whitespace-nowrap' : 'w-[138px] gap-2')}>
                        <span className="md:hidden">
                          {mobileFeaturedDisplay.buttonLabel}
                        </span>
                        <span className="hidden md:inline">
                          {mobileFeaturedDisplay.buttonLabel}
                        </span>
                        <ArrowRight className="h-[18px] w-[18px] md:h-5 md:w-5" />
                      </div>
                    </div>
                  </div>
                  <div className={cn('overflow-hidden rounded-[16px] border border-[#d9e5ff] bg-white/78 p-1 shadow-[inset_0_0_0_1px_rgba(199,214,255,0.45)]', isReferenceMode ? 'flex h-[116px] items-center justify-center rounded-[14px] border-0 bg-transparent p-0 shadow-none' : 'self-center')}>
                    {isReferenceMode ? (
                      <div className="origin-center scale-[1.02] translate-y-[3px]">
                        <LiveBoardArtwork />
                      </div>
                    ) : mobileFeaturedDisplay.posterUrl ? (
                      <img src={mobileFeaturedDisplay.posterUrl} alt={mobileFeaturedDisplay.title} className="h-[108px] w-full rounded-[14px] object-cover" />
                    ) : (
                      <div className="flex h-[108px] w-full flex-col items-center justify-center rounded-[14px] border border-dashed border-[#d4dff7] bg-[#f7faff] px-3 text-center">
                        <div className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-white text-[#4b83f6] shadow-[0_8px_18px_rgba(75,131,246,0.12)]">
                          <ImageIcon className="h-5 w-5" />
                        </div>
                        <p className="mt-3 text-[12px] font-semibold text-[#5a7099]">Poster pending</p>
                      </div>
                    )}
                  </div>
                </button>
              )}

              <div className={cn('mt-[14px] grid grid-cols-4 gap-[7px]', isReferenceMode && 'mt-[14px] gap-[7px]')}>
                {quickActionCards.map(({ id, title, subtitle, accent, icon: Icon }) => (
                  <button key={title} data-testid={`live-quick-action-${id}`} type="button" onClick={() => handleQuickAction(id)} className={cn('flex min-h-[68px] flex-col items-center rounded-[14px] border border-[#e5ebf7] bg-white px-[6px] py-[7px] text-center shadow-[0_6px_14px_rgba(28,41,61,0.04)]', isReferenceMode && 'min-h-[68px]')}>
                    <div className={cn('flex h-[34px] w-[34px] items-center justify-center rounded-[10px]', accent)}>
                      <Icon className="h-[16px] w-[16px] text-current" />
                    </div>
                    <p className={cn('mt-[4px] text-[10.5px] font-semibold leading-[1.18] text-[#1f2d4e] md:text-[13px]', isReferenceMode && 'text-[10.5px]')}>{title}</p>
                    <p className="mt-1 hidden text-[12px] text-[#6b7b9a] md:block">{subtitle}</p>
                  </button>
                ))}
              </div>
              {renderUtilityPanel()}

              {isAdmin && (
                <button
                  type="button"
                  data-testid="live-create-toggle-mobile"
                  onClick={toggleNewLiveClassEditor}
                  className="fixed bottom-[88px] right-4 z-20 inline-flex h-[56px] w-[56px] items-center justify-center rounded-full bg-[#125df4] text-white shadow-[0_18px_30px_rgba(18,93,244,0.28)] md:hidden"
                  aria-label="Create Live Class"
                >
                  <Plus className="h-5 w-5" />
                </button>
              )}

              {createOpen && isAdmin && renderCreateBuilder(true)}

              {isAdmin && !isReferenceMode && orderedLiveClasses.length > 0 && (
                <div className="mt-5 hidden rounded-[22px] border border-[#dfe7f5] bg-white p-4 shadow-[0_8px_18px_rgba(28,41,61,0.05)] md:block">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-semibold text-[#1f2d4e]">Manage Live Classes</h3>
                      <p className="mt-1 text-[12px] text-[#7283a0]">Edit schedule, teacher profile, poster, and class content from one place.</p>
                    </div>
                    <span className="rounded-full bg-[#eef4ff] px-3 py-1 text-[11px] font-semibold text-[#2f6fe4]">{orderedLiveClasses.length} total</span>
                  </div>
                  <div className="mt-4 space-y-3">
                    {orderedLiveClasses.slice(0, 6).map((liveClass) => {
                      const teacherProfile = normalizeLiveTeacherProfile(liveClass);
                      return (
                        <div key={liveClass._id} className="flex items-center gap-3 rounded-[18px] border border-[#e5ebf7] bg-[#fbfcff] p-3">
                          <div className="h-[56px] w-[56px] overflow-hidden rounded-[14px] border border-[#d9e5ff] bg-white shadow-[0_6px_14px_rgba(28,41,61,0.06)]">
                            {liveClass.posterUrl ? (
                              <img src={liveClass.posterUrl} alt={liveClass.title} className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(180deg,#eef4ff_0%,#f7faff_100%)]">
                                <CalendarDays className="h-5 w-5 text-[#2f6fe4]" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[14px] font-semibold text-[#1f2d4e]">{getDisplayLiveClassTitle(liveClass)}</p>
                            <p className="mt-1 truncate text-[12px] text-[#7283a0]">{formatFullDate(liveClass.startTime)}</p>
                            <div className="mt-2 flex items-center gap-2">
                              <TeacherAvatar name={teacherProfile.name} photoUrl={teacherProfile.avatarUrl} size="sm" />
                              <span className="truncate text-[12px] text-[#516786]">{teacherProfile.name || liveClass.instructor}</span>
                            </div>
                          </div>
                          <div className="flex flex-col gap-2">
                            <button type="button" onClick={() => void openLiveClass(liveClass._id)} className="rounded-[12px] border border-[#dbe4f4] bg-white px-3 py-2 text-[12px] font-semibold text-[#31486d]">
                              View
                            </button>
                            <button type="button" onClick={() => beginEditLiveClass(liveClass)} className="rounded-[12px] bg-[#125df4] px-3 py-2 text-[12px] font-semibold text-white">
                              Edit
                            </button>
                            <button type="button" disabled={busy} onClick={() => void deleteLiveClassById(liveClass._id)} className="rounded-[12px] border border-[#ffd6d6] bg-[#fff5f5] px-3 py-2 text-[12px] font-semibold text-[#c93636] disabled:opacity-60">
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div ref={todaySectionRef} data-testid="live-class-list" className="border-0 bg-transparent p-0 shadow-none md:rounded-[24px] md:border md:border-white/80 md:bg-white/92 md:p-5 md:shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-[15px] font-semibold text-[#1f2d4e] md:text-[1.28rem]">Today&apos;s Live Classes</h3>
                <button type="button" data-testid="live-view-schedule" onClick={() => setUtilityPanel('schedule')} className="text-[13px] font-semibold text-[#1765f5] md:text-[13px]">View Schedule</button>
              </div>
              <div className="mt-[10px] space-y-[8px]">
                {mobileTodayCards.map((liveClass, index) => (
                  <button
                    key={`${liveClass.liveClassId || liveClass.title}-${index}`}
                    type="button"
                    data-testid={`live-card-${liveClass.liveClassId || index}`}
                    onClick={() => liveClass.liveClassId ? void openLiveClass(liveClass.liveClassId) : undefined}
                    className={cn(
                      'grid w-full grid-cols-[58px_minmax(0,1fr)_54px_10px] gap-[7px] rounded-[14px] border border-[#e5ebf7] bg-white px-[9px] py-[7px] text-left shadow-[0_6px_14px_rgba(28,41,61,0.045)] md:grid-cols-[92px_1fr_120px] md:rounded-[18px] md:p-4',
                      isReferenceMode && 'grid-cols-[58px_minmax(0,1fr)_54px_10px]',
                      index >= 3 && 'hidden md:grid',
                    )}
                  >
                    <div className={cn('flex flex-col items-center justify-center rounded-[12px] p-[6px] text-center font-semibold', getTopicColor(index), isReferenceMode && 'rounded-[12px]')}>
                      <span className="text-[13px] font-semibold leading-none tracking-[-0.01em] text-current md:text-[1.35rem]">{liveClass.time}</span>
                      <span className="mt-[3px] text-[9px] uppercase md:text-[0.92rem]">{liveClass.meridiem}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold text-[#38a15d]">{liveClass.topic}</p>
                      <h4 className={cn('mt-[2px] line-clamp-2 text-[12.25px] font-semibold leading-[1.18] tracking-[-0.01em] text-[#1f2d4e] md:text-[1.08rem]', isReferenceMode && 'text-[12.25px]')}>{liveClass.title}</h4>
                      <p className="mt-[2px] truncate text-[10.5px] text-[#7283a0]">{liveClass.meta}</p>
                      <div className="mt-[4px] flex items-center gap-[6px] text-[10.5px] text-[#516786]">
                        {isReferenceMode ? <ReferenceTeacherAvatar size="sm" /> : <TeacherAvatar name={liveClass.teacher} photoUrl={liveClass.teacherAvatarUrl} size="sm" />}
                        <span className="truncate">{liveClass.teacher}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end justify-center gap-[6px] pr-0.5">
                      <span className={cn('rounded-full px-[7px] py-[4px] text-[8.5px] font-semibold uppercase', getStatusTone(liveClass.status || 'scheduled'))}>
                        {liveClass.statusLabel}
                      </span>
                      <span className="whitespace-nowrap text-[10.5px] text-[#5b7297] md:text-[13px]">{liveClass.attendees}</span>
                    </div>
                    <div className="flex items-center justify-end">
                      <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div ref={tomorrowSectionRef} className="rounded-[24px] border-0 bg-transparent p-0 shadow-none md:border md:border-white/80 md:bg-white/92 md:p-5 md:shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-[15px] font-semibold text-[#1f2d4e] md:text-[1.28rem]">Tomorrow&apos;s Schedule</h3>
                <button type="button" onClick={() => setUtilityPanel('schedule')} className="text-[13px] font-semibold text-[#1765f5] md:text-[14px]">View All</button>
              </div>
              {mobileTomorrowCard && (
                <button
                  type="button"
                  onClick={() => mobileTomorrowCard.liveClassId ? void openLiveClass(mobileTomorrowCard.liveClassId) : undefined}
                  className={cn('mt-[10px] grid w-full grid-cols-[58px_minmax(0,1fr)_54px_10px] gap-[7px] rounded-[14px] border border-[#e5ebf7] bg-white px-[9px] py-[7px] text-left shadow-[0_6px_14px_rgba(28,41,61,0.045)] md:grid-cols-[92px_1fr_120px] md:rounded-[18px]', isReferenceMode && 'grid-cols-[58px_minmax(0,1fr)_54px_10px]')}
                >
                  <div className={cn('flex flex-col items-center justify-center rounded-[14px] bg-gradient-to-br p-[7px] text-center font-semibold', getTopicColor(mobileTomorrowCard.colorIndex), isReferenceMode && 'rounded-[14px]')}>
                    <span className="text-[15px] font-semibold leading-none tracking-[-0.02em]">{mobileTomorrowCard.time}</span>
                    <span className="mt-[3px] text-[10px] uppercase">{mobileTomorrowCard.meridiem}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-[#2b63df]">{mobileTomorrowCard.topic}</p>
                    <h4 className={cn('mt-[2px] line-clamp-2 text-[13.25px] font-semibold leading-[1.18] tracking-[-0.02em] text-[#1f2d4e]', isReferenceMode && 'text-[13px]')}>{mobileTomorrowCard.title}</h4>
                    <p className="mt-[3px] truncate text-[11.5px] text-[#7283a0]">{mobileTomorrowCard.meta}</p>
                  </div>
                  <div className="flex flex-col items-end justify-center gap-[7px] pr-0.5">
                    <span className={cn('rounded-full px-2 py-[5px] text-[9px] font-semibold uppercase', getStatusTone(mobileTomorrowCard.status))}>
                      {mobileTomorrowCard.statusLabel}
                    </span>
                    <span className="whitespace-nowrap text-[11.5px] text-[#5b7297] md:text-[13px]">{mobileTomorrowCard.attendees}</span>
                  </div>
                  <div className="flex items-center justify-end">
                    <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
                  </div>
                </button>
              )}
            </div>

            <div ref={remindersSectionRef} className="rounded-[18px] border border-[#dfe7f5] bg-[#eef4ff] px-[14px] py-[14px] shadow-[0_8px_18px_rgba(28,41,61,0.05)] md:flex md:items-center md:justify-between">
              <div className="grid grid-cols-[minmax(0,1fr)_128px] items-center gap-3">
                <div className="flex items-start gap-[12px]">
                <div className="flex h-[40px] w-[40px] items-center justify-center rounded-[12px] bg-[#e7efff] text-[#2b63df]">
                  <Bell className="h-[20px] w-[20px]" />
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold leading-[1.28] text-[#1f2d4e] md:text-[1.08rem]">Never miss a class!</h3>
                  <p className="mt-[4px] text-[12px] leading-[1.45] text-[#7283a0]">Get reminders before every live class.</p>
                </div>
              </div>
                <button type="button" data-testid="live-reminders-toggle" onClick={toggleReminders} className="inline-flex h-[38px] w-full items-center justify-center whitespace-nowrap rounded-[12px] border border-[#cddaff] bg-white px-[8px] text-[12px] font-semibold text-[#2f6fe4] md:mt-0 md:w-auto md:min-w-[200px] md:py-2.5 md:text-sm">
                  {remindersEnabled ? 'Reminders Enabled' : 'Enable Reminders'}
                </button>
              </div>
            </div>
          </section>

          <aside className="hidden space-y-4 xl:block">
            <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[1.05rem] font-semibold text-[#122444]">Calendar</h3>
                  <p className="mt-1 text-[12px] text-[#6a7a96]">{calendarMonthLabel}</p>
                </div>
                <button type="button" onClick={() => setUtilityPanel('schedule')} className="text-[13px] font-semibold text-[#1765f5]">View All</button>
              </div>
              <div className="mt-4 grid grid-cols-7 gap-2 text-center text-[12px] text-[#6a7a96]">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}
                {liveCalendarCells.map((cell) => (
                  <span
                    key={cell.key}
                    className={cn(
                      'relative flex h-8 items-center justify-center rounded-full font-medium',
                      cell.muted && 'text-transparent',
                      !cell.muted && !cell.isToday && 'text-[#183259]',
                      cell.isToday && 'bg-[#6b52ff] text-white',
                    )}
                  >
                    {cell.label}
                    {cell.hasClass && !cell.isToday && (
                      <span className="absolute bottom-[5px] h-1.5 w-1.5 rounded-full bg-[#1765f5]" />
                    )}
                  </span>
                ))}
              </div>
              {orderedLiveClasses.length > 0 && (
                <div className="mt-4 space-y-2">
                  {orderedLiveClasses.slice(0, 3).map((liveClass) => (
                    <button
                      key={liveClass._id}
                      type="button"
                      onClick={() => void openLiveClass(liveClass._id)}
                      className="flex w-full items-center justify-between rounded-[14px] bg-[#f7faff] px-3 py-2.5 text-left"
                    >
                      <div>
                        <p className="text-[13px] font-semibold text-[#122444]">{getDisplayLiveClassTitle(liveClass)}</p>
                        <p className="mt-1 text-[12px] text-[#6a7a96]">{formatFullDate(liveClass.startTime)}</p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
              <div className="flex items-center justify-between">
                <h3 className="text-[1.05rem] font-semibold text-[#122444]">Upcoming Live Class</h3>
                <button type="button" onClick={() => setUtilityPanel('schedule')} className="text-[13px] font-semibold text-[#1765f5]">View Schedule</button>
              </div>
              {featuredLiveClass && (
                <button type="button" onClick={() => void openLiveClass(featuredLiveClass._id)} className="mt-4 w-full rounded-[16px] bg-[linear-gradient(135deg,#f9fbff_0%,#eef3ff_100%)] p-3.5 text-left">
                  <span className={cn('inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]', getStatusTone(getLiveStatusLabel(featuredLiveClass)))}>
                    {getLiveStatusLabel(featuredLiveClass)}
                  </span>
                  <h4 className="mt-2.5 text-[1.05rem] font-semibold tracking-[-0.02em] text-[#122444]">{getDisplayLiveClassTitle(featuredLiveClass)}</h4>
                  <p className="mt-1 text-[13px] text-[#5c7295]">{getLiveClassTopicLine(featuredLiveClass)}</p>
                  <div className="mt-2.5 flex items-center gap-2 text-[13px] text-[#31486d]">
                    <Clock3 className="h-4 w-4" />
                    {formatFullDate(featuredLiveClass.startTime)}
                  </div>
                </button>
              )}
            </div>

            <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
              <h3 className="text-[1.05rem] font-semibold text-[#122444]">Quick Links</h3>
              <div className="mt-3 space-y-3">
                {[
                  ['Class Notes', 'Access notes after the class', 'resources'],
                  ['Doubts', 'Ask or view your doubts', 'help'],
                  ['Recordings', 'Watch previous live classes', 'resources'],
                ].map(([title, subtitle, action]) => (
                  <button key={title} type="button" onClick={() => action === 'resources' ? selectDetailTab('resources') : setUtilityPanel('help')} className="flex w-full items-center justify-between gap-4 rounded-[14px] border border-[#edf2fb] bg-[#fbfcff] px-4 py-3 text-left">
                    <div>
                      <p className="text-[14px] font-semibold text-[#142848]">{title}</p>
                      <p className="mt-1 text-[12px] text-[#7b8ead]">{subtitle}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-[#7b8ead]" />
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      )}

      {view === 'detail' && hasSelectedLiveClass && (
        <div
          data-testid="live-class-detail-page"
          data-live-class-id={selectedLiveClass._id}
          className={cn('mobile-safe-screen min-h-[100dvh] space-y-3 overflow-x-hidden bg-[#f4f7ff] pb-[96px]', isReferenceMode && 'relative -mx-4 bg-white px-4 pt-2 sm:mx-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0')}
        >
          <div className="mobile-safe-content mx-auto space-y-3 pt-[10px] md:hidden">
            {isReferenceMode && (
              <div className="px-[14px] pt-[10px]">
                <MobileStatusBar />
              </div>
            )}
            <div className="flex items-center justify-between">
              <button type="button" onClick={() => setView('list')} className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-full border border-[#dfe7f5] bg-white text-[#1f2d4e] shadow-[0_8px_18px_rgba(28,41,61,0.06)]">
                <ArrowLeft className="h-[18px] w-[18px]" />
              </button>
              <h2 className="text-[18px] font-semibold leading-none tracking-[-0.02em] text-[#1f2d4e]">Live Class Details</h2>
              <button type="button" onClick={() => void handleShareCurrentView()} className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-full border border-[#dfe7f5] bg-white text-[#1f2d4e] shadow-[0_8px_18px_rgba(28,41,61,0.06)]">
                <Share2 className="h-[18px] w-[18px]" />
              </button>
            </div>

            <div data-testid="live-class-detail-hero" className={cn('overflow-hidden rounded-[18px] border border-[#1c2f53] bg-[linear-gradient(135deg,#0d1530_0%,#13254a_52%,#0d1630_100%)] px-[13px] py-[13px] text-white shadow-[0_14px_30px_rgba(9,16,32,0.16)]', isReferenceMode && 'rounded-[18px] shadow-[0_14px_28px_rgba(9,16,32,0.15)]')}>
              <div className={cn('grid gap-3', isReferenceMode ? 'grid-cols-[minmax(0,1fr)_132px]' : 'grid-cols-[minmax(0,1fr)_128px]')}>
                <div className="min-w-0">
                  <span className={cn('inline-flex items-center rounded-[11px] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]', detailStatus === 'live' ? 'bg-[#fff0f0] text-[#ff4b4b]' : getStatusTone(getLiveStatusLabel(selectedLiveClass)))}>
                    {detailDisplay.badge}
                  </span>
                  <h2
                    data-testid="live-selected-title"
                    className={cn('mt-[10px] font-semibold leading-[1.14] tracking-[-0.01em] text-white', isReferenceMode ? 'text-[16px]' : 'text-[16px]')}
                    style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                  >
                    {detailDisplay.title}
                  </h2>
                  <p className={cn('mt-[7px] line-clamp-2 text-[12px] font-medium leading-[1.35] text-white/88')}>{detailDisplay.subtitle}</p>
                  <p className="mt-[7px] text-[12px] text-white/64">{detailDisplay.meta}</p>

                  <div className="mt-4 flex items-center gap-[9px]">
                    {isReferenceMode ? <ReferenceTeacherAvatar size="lg" online /> : <TeacherAvatar name={detailDisplay.teacher} photoUrl={selectedTeacherProfile.avatarUrl} size="lg" online />}
                    <div>
                      <p className="text-[12px] font-semibold leading-[1.15] text-white">{detailDisplay.teacher}</p>
                      <p className="text-[11px] leading-[1.32] text-white/78">{detailDisplay.audience}</p>
                    </div>
                  </div>
                </div>

                <div className={cn('relative self-start pt-2', isReferenceMode && 'pt-0.5')}>
                  <div className="absolute right-1 top-1 z-10 flex h-8 w-8 items-center justify-center rounded-[11px] bg-[#1c2740]/88 text-white shadow-[0_8px_18px_rgba(0,0,0,0.24)]">
                    <ArrowRight className="h-4 w-4 -rotate-45" />
                  </div>
                  <div className={cn('overflow-hidden rounded-[16px]', isReferenceMode && 'rounded-[14px]')}>
                      {isReferenceMode ? (
                        <div className="origin-top-left scale-[0.96] translate-y-[2px]">
                          <LiveBoardArtwork dark />
                        </div>
                      ) : selectedLiveClass?.posterUrl ? (
                        <img src={selectedLiveClass.posterUrl} alt={detailDisplay.title} className="h-full w-full rounded-[18px] object-cover" />
                      ) : (
                        <LivePosterEmptyState compact dark message="Poster pending" />
                      )}
                    </div>
                  </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/12 pt-3">
                {[
                  { icon: Clock3, label: 'Started at', value: detailDisplay.startedAt },
                  { icon: CalendarDays, label: 'Duration', value: detailDisplay.duration },
                  { icon: Users, label: 'Students', value: detailDisplay.students },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="min-w-0 border-r border-white/12 pr-2 last:border-r-0 last:pr-0">
                    <div className="mb-2 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-white/8 text-white/88">
                      <Icon className="h-[15px] w-[15px]" />
                    </div>
                    <p className="text-[10.5px] text-white/56">{label}</p>
                    <p className="mt-[5px] text-[12px] font-semibold text-white">{value}</p>
                  </div>
                ))}
              </div>

              <div className="mt-[14px] grid grid-cols-1 gap-[9px] min-[390px]:grid-cols-[minmax(0,1fr)_142px]">
                <button
                  type="button"
                  data-testid="live-details-join-button"
                  disabled={busy || detailStatus !== 'live'}
                  onClick={() => void handleJoinLiveClass()}
                  className="inline-flex h-[42px] items-center justify-center gap-[8px] whitespace-nowrap rounded-[12px] bg-[#1f6ff2] px-[12px] text-[13px] font-semibold text-white shadow-[0_10px_20px_rgba(31,111,242,0.2)] disabled:cursor-not-allowed disabled:bg-[#9aa8bd] disabled:shadow-none"
                >
                  {detailStatus === 'live' ? 'Enter Live Class' : 'Waiting to Start'}
                  <Video className="h-[18px] w-[18px]" />
                </button>
                <button type="button" onClick={() => void ensureMediaPermissions()} className="inline-flex h-[42px] items-center justify-center gap-[7px] whitespace-nowrap rounded-[12px] border border-white/14 bg-white/8 px-[10px] text-[12px] font-semibold text-white backdrop-blur">
                  <Settings className="h-[18px] w-[18px]" />
                  Test Audio/Video
                </button>
              </div>
              {liveLifecycleMessage && (
                <div data-testid="live-status-message" className="mt-3 rounded-[12px] border border-white/12 bg-white/8 px-3 py-2.5 text-[11px] leading-5 text-white/82 backdrop-blur">
                  {liveLifecycleMessage}
                </div>
              )}

            </div>

            {renderIngestSetupCard('mx-4')}

            <div className="rounded-[16px] border border-[#d9f0dc] bg-[linear-gradient(180deg,#f3fff6_0%,#edfdf0_100%)] px-[12px] py-[11px] text-[#1f9b57] shadow-[0_8px_18px_rgba(31,155,87,0.07)]">
              <div className="grid grid-cols-1 items-center gap-3 min-[390px]:grid-cols-[minmax(0,1fr)_108px]">
                <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-white">
                  <BookOpen className="h-[18px] w-[18px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold leading-[1.2]">
                    {detailDisplay.earlyTitle}
                  </p>
                  <p className="mt-1 text-[11.5px] leading-[1.42] text-[#4e8b65]">
                    {detailDisplay.earlyBody}
                  </p>
                </div>
                </div>
                <button type="button" data-testid="live-detail-class-info" onClick={() => selectDetailTab('overview')} className="inline-flex h-[38px] w-full items-center justify-center whitespace-nowrap rounded-[11px] border border-[#b8ebc7] bg-white px-[10px] text-[12px] font-semibold text-[#1f9b57]">
                  View Class Info
                </button>
              </div>
            </div>

            <div className="rounded-[16px] border border-[#e5ebf7] bg-white p-0 shadow-[0_8px_18px_rgba(28,41,61,0.05)]">
              <div className="grid grid-cols-5 gap-1 border-b border-[#dde5f5] px-2 pt-[8px] text-center">
                {[
                  { label: 'Overview', icon: BookOpen, key: 'overview' as const },
                  { label: 'Live Chat', icon: MessageSquare, key: 'chat' as const },
                  { label: 'Notes', icon: FileText, key: 'notes' as const },
                  { label: 'Polls', icon: Users, key: 'polls' as const },
                  { label: 'Resources', icon: Copy, key: 'resources' as const },
                ].map(({ label, icon: Icon, key }) => (
                  <button type="button" data-testid={`live-detail-tab-${key}`} key={label} onClick={() => selectDetailTab(key)} className={cn('relative flex flex-col items-center gap-[6px] px-1 pb-[9px] text-[11.5px] font-medium text-[#5b6f98]', detailTab === key && 'font-semibold text-[#1b49d6] after:absolute after:bottom-0 after:left-[18px] after:right-[18px] after:h-[3px] after:rounded-full after:bg-[#2d6ee5]')}>
                    <Icon className="h-[16px] w-[16px]" />
                    <span className="leading-[1.2]">{label}</span>
                  </button>
                ))}
              </div>
              <div ref={mobileDetailContentRef} className="p-[16px]">
                {detailTab === 'overview' && (
                  <>
                    <div className={cn('grid gap-3', isReferenceMode ? 'grid-cols-[minmax(0,1fr)_106px]' : 'grid-cols-[minmax(0,1fr)_132px]')}>
                      <div className="min-w-0">
                        <h3 className="text-[15px] font-semibold text-[#1f2d4e]">About this class</h3>
                        <p className={cn('mt-3 leading-7 text-[#6a7a96]', isReferenceMode ? 'max-w-[226px] text-[12px] leading-[1.68]' : 'text-[12.5px]')}>
                          {detailDisplay.about}
                        </p>
                        <button type="button" onClick={() => selectDetailTab('notes')} className="mt-[14px] text-[14px] font-semibold text-[#2f6fe4]">View More</button>
                      </div>
                      <div className={cn('self-start', isReferenceMode ? 'pt-2' : 'pt-1')}>
                        <div className={cn(isReferenceMode && 'origin-top-right scale-[0.92]')}>
                          <LiveNotesArtwork />
                        </div>
                      </div>
                    </div>

                    <div className="mt-[16px] divide-y divide-[#edf2fb] rounded-[18px] border border-[#edf2fb] bg-[#fbfcff]">
                      {detailInfoRows.map(({ label, value, icon: Icon, tone }, index) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => {
                            if (label === 'Class Notes') selectDetailTab('resources');
                            if (label === 'Homework') selectDetailTab('polls');
                            if (label === 'Recording') setUiNotice('Recording becomes available after the class ends.');
                          }}
                          className="flex w-full items-center justify-between gap-4 px-[15px] py-[14px] text-left"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className={cn('flex h-[42px] w-[42px] items-center justify-center rounded-[12px]', tone)}>
                              <Icon className="h-[18px] w-[18px]" />
                            </div>
                            <p className="text-[14px] text-[#1f2d4e]">{label}</p>
                          </div>
                          <p className="max-w-[148px] text-right text-[13px] leading-[1.45] text-[#7283a0]">{value}</p>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {detailTab === 'chat' && renderDetailChat()}
                {detailTab === 'notes' && renderDetailNotes()}
                {detailTab === 'polls' && renderDetailPolls()}
                {detailTab === 'resources' && renderDetailResources()}
              </div>
            </div>

            {isAdmin && (
              <div className="mx-[14px] rounded-[18px] border border-[#e5ebf7] bg-white p-[14px] shadow-[0_8px_18px_rgba(28,41,61,0.05)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[15px] font-semibold text-[#1f2d4e]">Manage live class</h3>
                    <p className="mt-1 text-[12px] text-[#7283a0]">Update the schedule or control the live session without crowding the learner view.</p>
                  </div>
                  <span className="rounded-full bg-[#eef4ff] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#2f6fe4]">Admin</span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => selectedLiveClass && beginEditLiveClass(selectedLiveClass)} className="rounded-[14px] border border-[#dbe4f4] bg-white px-3.5 py-3 text-[13px] font-semibold text-[#2f6fe4]">
                    Edit Details
                  </button>
                  {selectedStatus !== 'live' && selectedStatus !== 'ended' && (
                    <button type="button" data-testid="live-admin-start" disabled={busy} onClick={() => void handleStartLiveClass()} className="rounded-[14px] bg-[#1765f5] px-3.5 py-3 text-[13px] font-semibold text-white shadow-[0_12px_20px_rgba(23,101,245,0.18)]">
                      Start Class
                    </button>
                  )}
                  {selectedStatus === 'live' && (
                    <button type="button" data-testid="live-admin-end" disabled={busy} onClick={() => void handleEndLiveClass()} className="rounded-[14px] bg-[#ea4335] px-3.5 py-3 text-[13px] font-semibold text-white shadow-[0_12px_20px_rgba(234,67,53,0.18)]">
                      End Class
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="mx-[14px] rounded-[18px] border border-[#e5ebf7] bg-white p-[14px] shadow-[0_8px_18px_rgba(28,41,61,0.05)]">
              <h3 className="text-[15px] font-semibold text-[#1f2d4e]">Meet your teacher</h3>
                <div className="mt-4 grid grid-cols-[minmax(0,1fr)_102px] items-center gap-3">
                <div className="flex min-w-0 items-center gap-4">
                  {isReferenceMode ? <ReferenceTeacherAvatar size="md" /> : <TeacherAvatar name={detailDisplay.teacher} photoUrl={selectedTeacherProfile.avatarUrl} size="lg" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-[#1f2d4e]">{detailDisplay.teacher}</p>
                    <p className="text-[13px] text-[#7283a0]">{detailDisplay.teacherRole}</p>
                    <p className="mt-[4px] text-[13px] leading-[1.45] text-[#7283a0]">{detailDisplay.teacherExperience}</p>
                  </div>
                </div>
                <button type="button" data-testid="live-detail-view-profile" onClick={() => setUtilityPanel('teacher')} className="inline-flex h-[40px] w-full items-center justify-center whitespace-nowrap rounded-[12px] border border-[#dbe4f4] bg-white px-[10px] text-[13px] font-semibold text-[#2f6fe4]">
                  View Profile
                </button>
              </div>
            </div>

            {detailDisplay.countdown && (
              <div className="mx-[14px] rounded-[18px] border border-[#e5ebf7] bg-white p-[14px] shadow-[0_8px_18px_rgba(28,41,61,0.05)]">
                <div className="grid grid-cols-[82px_minmax(0,1fr)] items-center gap-3">
                  <h3 className="text-[15px] font-semibold leading-[1.15] text-[#1f2d4e]">Class starts in</h3>
                  <div className="flex items-center justify-between gap-2">
                    {[detailDisplay.countdown.hours, detailDisplay.countdown.minutes, detailDisplay.countdown.seconds].map((value, index) => (
                      <React.Fragment key={`${value}-${index}`}>
                        <div className="flex-1 rounded-[16px] bg-[#f4f7ff] px-2 py-[11px] text-center">
                          <p className="text-[14px] font-semibold leading-none text-[#2f6fe4] sm:text-[18px]">{value}</p>
                          <p className="mt-[8px] text-[10px] uppercase tracking-[0.14em] text-[#7b879d]">{index === 0 ? 'hrs' : index === 1 ? 'mins' : 'secs'}</p>
                        </div>
                        {index < 2 && <span className="px-0.5 text-[1.1rem] font-semibold text-[#7b8ead]">:</span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="mx-[14px] rounded-[18px] border border-[#e5ebf7] bg-white p-[14px] shadow-[0_8px_18px_rgba(28,41,61,0.05)]">
              <div className="grid grid-cols-[minmax(0,1fr)_106px] items-center gap-2">
                <div className="flex min-w-0 items-start gap-4">
                <div className="flex h-[42px] w-[42px] items-center justify-center rounded-[12px] bg-[#eef4ff] text-[#1765f5]">
                  <Bell className="h-[20px] w-[20px]" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[15px] font-semibold leading-[1.22] text-[#1f2d4e]">Having trouble joining the class?</h3>
                  <p className="mt-[6px] text-[13px] leading-[1.4] text-[#7283a0]">Get help from our support team.</p>
                </div>
                </div>
                <button type="button" data-testid="live-detail-get-help" onClick={() => setUtilityPanel('help')} className="inline-flex h-[40px] w-full items-center justify-center gap-[8px] whitespace-nowrap rounded-[12px] border border-[#d9e4ff] bg-white px-[8px] text-[13px] font-semibold text-[#2f6fe4]">
                  <Bell className="h-[18px] w-[18px]" />
                  Get Help
                </button>
              </div>
            </div>
            <div className="mx-[14px]">
              {renderUtilityPanel()}
            </div>
          </div>

          <div className="hidden gap-4 md:grid xl:grid-cols-[minmax(0,1.58fr)_300px]">
            <section className="space-y-4">
              <div data-testid="live-class-detail-hero" className="rounded-[24px] border border-[#203356] bg-[linear-gradient(135deg,#0e1730_0%,#122243_52%,#0d1630_100%)] p-4 text-white shadow-[0_18px_48px_rgba(9,16,32,0.2)]">
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setView('list')} className="inline-flex h-9 w-9 items-center justify-center rounded-[13px] bg-white/10 text-white shadow-[0_8px_16px_rgba(4,10,20,0.18)]">
                    <ArrowLeft className="h-4.5 w-4.5" />
                  </button>
                  <div className="flex items-center gap-3">
                    {isAdmin && (
                      <button type="button" onClick={() => selectedLiveClass && beginEditLiveClass(selectedLiveClass)} className="rounded-[12px] border border-white/14 bg-white/8 px-3.5 py-2 text-[13px] font-semibold text-white">
                        Edit Details
                      </button>
                    )}
                    {isAdmin && selectedStatus !== 'live' && selectedStatus !== 'ended' && (
                      <button type="button" data-testid="live-admin-start" disabled={busy} onClick={() => void handleStartLiveClass()} className="rounded-[12px] bg-[#1765f5] px-3.5 py-2 text-[13px] font-semibold text-white shadow-[0_12px_20px_rgba(23,101,245,0.24)]">
                        Start Class
                      </button>
                    )}
                    {isAdmin && selectedStatus === 'live' && (
                      <button type="button" data-testid="live-admin-end" disabled={busy} onClick={() => void handleEndLiveClass()} className="rounded-[12px] bg-[#ea4335] px-3.5 py-2 text-[13px] font-semibold text-white shadow-[0_12px_20px_rgba(234,67,53,0.24)]">
                        End Class
                      </button>
                    )}
                    <button type="button" onClick={() => void handleShareCurrentView()} className="inline-flex h-9 w-9 items-center justify-center rounded-[13px] bg-white/10 text-white">
                      <ArrowRight className="h-4.5 w-4.5 -rotate-45" />
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="min-w-0">
                    <span className={cn('inline-flex items-center rounded-[10px] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]', detailStatus === 'live' ? 'bg-[#fff0f0] text-[#ff4b4b]' : getStatusTone(getLiveStatusLabel(selectedLiveClass)))}>
                      {detailDisplay.badge}
                    </span>
                    <h2 data-testid="live-selected-title" className="mt-3 max-w-[480px] font-serif text-[1.9rem] font-semibold leading-[1.02] tracking-[-0.05em] md:text-[2.1rem]">
                      {detailDisplay.title}
                    </h2>
                    <p className="mt-1.5 text-[14px] font-medium text-white/88 md:text-[15px]">{detailDisplay.subtitle}</p>
                    <p className="mt-1 text-[13px] text-white/60">{detailDisplay.meta}</p>

                    <div className="mt-4 flex items-center gap-3">
                      {isReferenceMode ? <ReferenceTeacherAvatar size="lg" online /> : <TeacherAvatar name={detailDisplay.teacher} photoUrl={selectedTeacherProfile.avatarUrl} size="lg" online />}
                      <div>
                        <p className="text-[15px] font-semibold text-white">{detailDisplay.teacher}</p>
                        <p className="text-[13px] text-white/76">{detailDisplay.audience}</p>
                      </div>
                    </div>

                    <div className="mt-5 grid gap-3 border-t border-white/12 pt-4 md:grid-cols-3 md:gap-0 md:divide-x md:divide-white/12 md:border-0 md:pt-0">
                      {[
                        { icon: Clock3, label: 'Started at', value: detailDisplay.startedAt },
                        { icon: CalendarDays, label: 'Duration', value: detailDisplay.duration },
                        { icon: Users, label: 'Students', value: detailDisplay.students },
                      ].map(({ icon: Icon, label, value }) => (
                        <div key={label} className="flex items-center gap-3 md:px-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-white/88">
                            <Icon className="h-4 w-4" />
                          </div>
                          <div>
                            <p className="text-[12px] text-white/56">{label}</p>
                            <p className="text-[14px] font-semibold text-white">{value}</p>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_210px]">
                      <button
                        type="button"
                        data-testid="live-details-join-button"
                        disabled={busy || detailStatus !== 'live'}
                        onClick={() => void handleJoinLiveClass()}
                        className="inline-flex items-center justify-center gap-3 rounded-[16px] bg-[linear-gradient(180deg,#2176ff_0%,#165cf3_100%)] px-5 py-3.5 text-[15px] font-semibold text-white shadow-[0_14px_24px_rgba(23,101,245,0.24)] disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {detailStatus === 'live' ? 'Enter Live Class' : 'Waiting for Admin to Start'}
                        <Video className="h-4.5 w-4.5" />
                      </button>
                      <button type="button" onClick={() => void ensureMediaPermissions()} className="inline-flex items-center justify-center gap-3 rounded-[16px] border border-white/14 bg-white/8 px-5 py-3.5 text-[15px] font-semibold text-white backdrop-blur">
                        <Settings className="h-4.5 w-4.5" />
                        Test Audio/Video
                      </button>
                    </div>
                    {liveLifecycleMessage && (
                      <div data-testid="live-status-message" className="mt-3 rounded-[16px] border border-white/12 bg-white/8 px-4 py-3 text-[13px] leading-6 text-white/82 backdrop-blur">
                        {liveLifecycleMessage}
                      </div>
                    )}
                  </div>

                  <div className="relative">
                    <div className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-[12px] bg-[#111b33] text-white shadow-[0_8px_18px_rgba(0,0,0,0.24)]">
                      <ArrowRight className="h-4 w-4 -rotate-45" />
                    </div>
                    {selectedLiveClass.posterUrl && !isReferenceMode ? (
                      <div className="overflow-hidden rounded-[22px] border border-white/10 bg-[#0e1730] p-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
                        <img src={selectedLiveClass.posterUrl} alt={detailDisplay.title} className="h-full min-h-[220px] w-full rounded-[18px] object-cover" />
                      </div>
                    ) : (
                      <LivePosterEmptyState compact dark message="Poster pending" />
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-[20px] border border-[#d9f0dc] bg-[linear-gradient(180deg,#f3fff6_0%,#edfdf0_100%)] p-4 text-[#1f9b57] shadow-[0_12px_24px_rgba(31,155,87,0.07)]">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-start gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-white">
                      <BookOpen className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-[1rem] font-semibold">{detailDisplay.earlyTitle}</p>
                      <p className="mt-1 text-[13px] text-[#4e8b65]">{detailDisplay.earlyBody}</p>
                    </div>
                  </div>
                  <button type="button" onClick={() => selectDetailTab('overview')} className="rounded-[14px] border border-[#b8ebc7] bg-white px-5 py-2.5 text-sm font-semibold text-[#1f9b57]">
                    View Class Info
                  </button>
                </div>
              </div>

              <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                <div className="flex gap-6 overflow-x-auto border-b border-[#edf2fb] pb-3 text-[13px] font-semibold text-[#7488a9]">
                  {[
                    ['Overview', 'overview'],
                    ['Live Chat', 'chat'],
                    ['Notes', 'notes'],
                    ['Polls', 'polls'],
                    ['Resources', 'resources'],
                  ].map(([tab, key]) => (
                    <button key={tab} type="button" data-testid={`live-detail-tab-${key}`} onClick={() => selectDetailTab(key as LiveDetailTabKey)} className={cn('relative whitespace-nowrap pb-1', detailTab === key && 'text-[#1765f5] after:absolute after:inset-x-0 after:-bottom-3 after:h-[2px] after:rounded-full after:bg-[#1765f5]')}>
                      {tab}
                    </button>
                  ))}
                </div>
                <div ref={desktopDetailContentRef} className="mt-5">
                  {detailTab === 'overview' && (
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
                      <div>
                        <h3 className="text-[1.14rem] font-semibold text-[#122444]">About this class</h3>
                        <p className="mt-2.5 text-[14px] leading-6 text-[#6a7a96]">{detailDisplay.about}</p>
                        <button type="button" onClick={() => selectDetailTab('notes')} className="mt-4 text-[14px] font-semibold text-[#1765f5]">View More</button>
                        <div className="mt-5 divide-y divide-[#edf2fb] rounded-[18px] border border-[#edf2fb] bg-[#fbfcff]">
                          {detailInfoRows.map(({ label, value, icon: Icon, tone }) => (
                            <button
                              key={label}
                              type="button"
                              onClick={() => {
                                if (label === 'Class Notes') selectDetailTab('resources');
                                if (label === 'Homework') selectDetailTab('polls');
                                if (label === 'Recording') setUiNotice('Recording becomes available after the class ends.');
                              }}
                              className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left"
                            >
                              <div className="flex items-center gap-3">
                                <div className={cn('flex h-9 w-9 items-center justify-center rounded-[12px]', tone)}>
                                  <Icon className="h-4 w-4" />
                                </div>
                                <p className="text-[14px] text-[#122444]">{label}</p>
                              </div>
                              <p className="text-right text-[13px] text-[#6a7a96]">{value}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center justify-center rounded-[20px] bg-[linear-gradient(180deg,#f4f7ff_0%,#eef4ff_100%)]">
                        <div className="w-full max-w-[220px] p-5">
                          <LiveNotesArtwork />
                        </div>
                      </div>
                    </div>
                  )}
                  {detailTab === 'chat' && renderDetailChat()}
                  {detailTab === 'notes' && renderDetailNotes()}
                  {detailTab === 'polls' && renderDetailPolls()}
                  {detailTab === 'resources' && renderDetailResources()}
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              {renderIngestSetupCard()}

              <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                <h3 className="text-[1.05rem] font-semibold text-[#122444]">Meet your teacher</h3>
                <div className="mt-5 flex items-center gap-4">
                  {isReferenceMode ? <ReferenceTeacherAvatar size="lg" /> : <TeacherAvatar name={detailDisplay.teacher} photoUrl={selectedTeacherProfile.avatarUrl} size="lg" />}
                  <div>
                    <p className="text-[15px] font-semibold text-[#122444]">{detailDisplay.teacher}</p>
                    <p className="text-[13px] text-[#6a7a96]">{detailDisplay.teacherRole}</p>
                    <p className="mt-1 text-[13px] text-[#6a7a96]">{detailDisplay.teacherExperience}</p>
                  </div>
                </div>
                <button type="button" onClick={() => setUtilityPanel('teacher')} className="mt-4 w-full rounded-[16px] border border-[#dbe4f4] bg-white px-5 py-3 text-sm font-semibold text-[#1765f5]">
                  View Profile
                </button>
              </div>

              {detailDisplay.countdown && (
                <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                  <h3 className="text-[1.05rem] font-semibold text-[#122444]">Class starts in</h3>
                  <div className="mt-4 flex items-center justify-between gap-2">
                    {[detailDisplay.countdown.hours, detailDisplay.countdown.minutes, detailDisplay.countdown.seconds].map((value, index) => (
                      <React.Fragment key={`${value}-${index}`}>
                        <div className="flex-1 rounded-[14px] bg-[#f4f7ff] px-3 py-3 text-center">
                          <p className="text-[1.7rem] font-semibold text-[#1765f5]">{value}</p>
                          <p className="mt-1.5 text-[10px] uppercase tracking-[0.14em] text-[#6a7a96]">{index === 0 ? 'hrs' : index === 1 ? 'mins' : 'secs'}</p>
                        </div>
                        {index < 2 && <span className="px-1 text-[1.25rem] font-semibold text-[#7b8ead]">:</span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#eef4ff] text-[#1765f5]">
                    <Bell className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-[1rem] font-semibold text-[#122444]">Having trouble joining the class?</h3>
                    <p className="mt-1.5 text-[13px] text-[#6a7a96]">Get help from our support team.</p>
                  </div>
                </div>
                <button type="button" onClick={() => setUtilityPanel('help')} className="mt-4 inline-flex w-full items-center justify-center gap-3 rounded-[16px] border border-[#d9e4ff] bg-white px-5 py-3 text-sm font-semibold text-[#1765f5]">
                  <Bell className="h-4.5 w-4.5" />
                  Get Help
                </button>
              </div>

              <div className="rounded-[24px] border border-white/80 bg-white/92 p-4 shadow-[0_16px_40px_rgba(15,23,42,0.05)]">
                <h3 className="text-[1.05rem] font-semibold text-[#122444]">Class participants</h3>
                <p className="mt-1.5 text-[13px] text-[#6a7a96]">{formatCompactCount(joinedCount)} students joined</p>
                <div className="mt-4 flex items-center">
                  {(session?.participants || []).slice(0, 5).map((participant, index) => (
                    <div key={participant.userId} className={cn(index > 0 && '-ml-3')}>
                      <TeacherAvatar name={participant.name} size="md" />
                    </div>
                  ))}
                  <div className="-ml-3 flex h-10 w-10 items-center justify-center rounded-full border-4 border-white bg-[#edf3ff] text-[12px] font-semibold text-[#3d5ea7]">
                    +{Math.max(joinedCount - 5, 0)}
                  </div>
                </div>
                <button type="button" onClick={() => setUtilityPanel('participants')} className="mt-5 inline-flex w-full items-center justify-center gap-3 rounded-[14px] bg-white px-5 py-2.5 text-sm font-semibold text-[#1765f5] shadow-[inset_0_0_0_1px_rgba(205,218,255,0.9)]">
                  View all participants
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
              {renderUtilityPanel()}
            </aside>
          </div>
        </div>
      )}

      {view === 'room' && hasSelectedLiveClass && access && (
        <div
          data-testid="live-runtime-page"
          data-self-mic-muted={localMicMuted ? 'true' : 'false'}
          data-self-video-enabled={localVideoEnabled ? 'true' : 'false'}
          data-self-mic-server-muted={selfParticipant?.micMuted ? 'true' : 'false'}
          data-self-video-server-enabled={selfParticipant?.videoEnabled ? 'true' : 'false'}
          data-self-can-speak={selfParticipant?.canSpeak ? 'true' : 'false'}
          data-self-hand-status={selfParticipant?.handStatus || 'idle'}
          data-screen-sharing={localScreenSharing ? 'true' : 'false'}
          data-room-loaded={roomLoaded ? 'true' : 'false'}
          data-livekit-track-count={String(liveKitTracks.length)}
          data-stage-track-source={liveKitActiveStageTrack?.source || 'none'}
          data-stage-track-owner={liveKitActiveStageTrack?.participantIdentity || 'none'}
          data-stage-track-local={liveKitActiveStageTrack?.isLocal ? 'true' : 'false'}
        >
          <div className="md:hidden">
            {isReferenceMode ? (
              <div data-testid="live-room-reference-page" className="mobile-safe-screen relative min-h-[100dvh] overflow-x-hidden bg-[#0f172a] pb-[24px] text-white">

                <div className="mobile-safe-content mx-auto pt-[10px]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <button type="button" data-testid="live-room-back" onClick={() => setView('detail')} className="inline-flex h-[32px] w-[32px] items-center justify-center text-white">
                      <ArrowLeft className="h-[20px] w-[20px]" />
                    </button>
                    <div className="min-w-0">
                      <h2 className="max-w-[214px] text-[15px] font-semibold leading-[1.22] tracking-[-0.02em] text-white">{liveFigmaReference.room.title}</h2>
                      <div className="mt-[4px] flex items-center gap-2 text-[11px] text-white/76">
                        <span>{liveFigmaReference.room.meta}</span>
                        <span>•</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-[12px] w-[12px]" /> {liveFigmaReference.room.viewers}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="inline-flex items-center gap-[6px] rounded-[16px] bg-[#ef4444] px-[10px] py-[7px] text-[11px] font-semibold uppercase tracking-[0.08em] text-white">
                      <span className="h-[7px] w-[7px] rounded-full bg-white" />
                      {liveFigmaReference.room.badge}
                    </span>
                    <button type="button" onClick={() => setMobileRoomMenuOpen((current) => !current)} className="inline-flex h-[32px] w-[32px] items-center justify-center text-white">
                      <MoreHorizontal className="h-[18px] w-[18px]" />
                    </button>
                  </div>
                </div>

                <div ref={mobileRoomStageRef} className="mt-[12px] rounded-[18px] border border-white/8 bg-[#111827] p-[5px] shadow-[0_18px_32px_rgba(0,0,0,0.3)]">
                  <div className="relative overflow-hidden rounded-[16px]">
                    <div className="absolute left-[12px] top-[10px] z-10 rounded-[8px] bg-black/58 px-[10px] py-[6px] text-[10px] font-medium text-white shadow-[0_10px_18px_rgba(0,0,0,0.22)]">
                      {liveFigmaReference.room.presenter}
                    </div>
                    <button
                      type="button"
                      data-testid="live-room-maximize"
                      onClick={() => void toggleLiveRoomFullscreen()}
                      className="absolute right-[10px] top-[10px] z-10 flex h-[32px] w-[32px] items-center justify-center rounded-[9px] bg-black/78 text-white"
                      aria-label="Maximize live class"
                    >
                      <Maximize2 className="h-[15px] w-[15px]" />
                    </button>
                    <LiveRoomStageArtwork />
                  </div>
                </div>

                <div className="mt-[6px] grid grid-cols-4 gap-[5px]">
                  {liveFigmaReference.room.participants.map((participant) => (
                    <div key={participant.name} className="overflow-hidden rounded-[10px] border border-white/8 bg-[#162034] shadow-[0_6px_14px_rgba(0,0,0,0.16)]">
                      <div className="flex h-[50px] items-center justify-center bg-[linear-gradient(180deg,#28344d_0%,#141b2c_100%)]">
                        {participant.kind === 'portrait' ? (
                          <ReferenceTeacherAvatar size="md" />
                        ) : (
                          <div className={cn('flex h-[36px] w-[36px] items-center justify-center rounded-full text-[15px] font-semibold', participant.kind === 'count' ? 'bg-[#0d1524] text-white' : 'bg-[linear-gradient(180deg,#7248ff_0%,#5d39de_100%)] text-white')}>
                            {participant.name}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-1 px-[7px] py-[6px]">
                        <p className="truncate text-[8.75px] font-medium text-white">{participant.name}</p>
                        {participant.muted ? <MicOff className="h-[12px] w-[12px] text-white/48" /> : <Mic className="h-[12px] w-[12px] text-[#21c668]" />}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-[8px] overflow-hidden rounded-[14px] border border-white/8 bg-[#111827] shadow-[0_18px_42px_rgba(9,16,32,0.18)]">
                  <div className="flex items-center justify-between gap-3 border-b border-white/8 px-[12px] py-[7px] text-[11px] font-medium text-white/76">
                    {[
                      { label: 'Chat', key: 'chat' as const, icon: MessageSquare },
                      { label: 'Notes', key: 'notes' as const, icon: FileText },
                      { label: 'Polls', key: 'polls' as const, icon: Users },
                      { label: 'Resources', key: 'resources' as const, icon: Copy },
                    ].map(({ label, key, icon: Icon }) => (
                      <button
                        key={label}
                        type="button"
                        data-testid={`live-room-tab-${key}`}
                        onClick={() => setRoomPanelTab(key)}
                        className={cn('relative flex items-center gap-[6px] pb-[6px]', roomPanelTab === key && 'text-[#a970ff] after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:rounded-full after:bg-[#8b5cf6]')}
                      >
                        <Icon className="h-[14px] w-[14px]" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="px-[12px] py-[9px]">
                    {roomPanelTab === 'chat' ? (
                      <>
                        <h3 className="mb-[8px] text-[14px] font-semibold text-white">Live Chat</h3>
                        <div className="space-y-[10px]">
                          {liveFigmaReference.room.chatMessages.map((message) => (
                            <div key={message.id} className="flex items-start gap-[10px]">
                              {message.initial ? (
                                <div className={cn('flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white', message.initial === 'AV' ? 'bg-[#15a56d]' : 'bg-[#8b5cf6]')}>
                                  {message.initial}
                                </div>
                              ) : (
                                <div className="shrink-0 pt-[2px]">
                                  <ReferenceTeacherAvatar size="sm" />
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-[8px] text-[11px] text-white/54">
                                  <span className="font-semibold text-white">{message.name}</span>
                                  {message.role && <span className="rounded-[6px] bg-[#2563eb] px-[5px] py-[1px] text-[9px] font-semibold text-white">{message.role}</span>}
                                  <span>{message.time}</span>
                                </div>
                                <div className={cn('mt-[5px] rounded-[12px] border px-[12px] py-[9px] text-[12px] leading-[1.55]', message.role ? 'border-[#223657] bg-[#172236] text-white/88' : 'border-transparent bg-transparent px-0 py-0 text-white/88')}>
                                  {message.message}
                                </div>
                                {typeof message.likes === 'number' && (
                                  <div className="mt-[8px] inline-flex items-center gap-[6px] rounded-full bg-white/6 px-[8px] py-[4px] text-[11px] text-white/76">
                                    <span>❤️</span>
                                    <span>{message.likes}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-[10px] flex items-center gap-2 rounded-[12px] border border-white/8 bg-white/4 px-[12px] py-[8px]">
                          <input
                            data-testid="live-chat-input"
                            value={chatInput}
                            onChange={(event) => setChatInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void sendChat();
                              }
                            }}
                            placeholder="Type a message..."
                            className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-white/34"
                          />
                          <button data-testid="live-chat-send" type="button" onClick={() => void sendChat()} className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-full bg-[#7c3aed] text-white">
                            <Send className="h-[14px] w-[14px]" />
                          </button>
                        </div>
                      </>
                    ) : roomPanelTab === 'notes' ? renderDetailNotes(true) : roomPanelTab === 'polls' ? renderDetailPolls(true) : renderDetailResources(true)}
                  </div>
                </div>
                </div>

                <div className="mt-[9px] grid grid-cols-5 items-end gap-[4px] px-[2px]">
                  <button data-testid="live-toggle-audio" type="button" onClick={toggleAudio} className="flex min-w-0 flex-col items-center justify-center gap-[8px] text-white">
                    <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-[#143322] text-[#32d072] shadow-[0_12px_18px_rgba(0,0,0,0.24)]"><Mic className="h-[16px] w-[16px]" /></span>
                    <span className="text-[10.5px] font-medium">Unmute</span>
                  </button>
                  <button data-testid="live-toggle-video" type="button" onClick={toggleVideo} className="flex min-w-0 flex-col items-center justify-center gap-[8px] text-white">
                    <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-[#2f1620] text-[#ff5959] shadow-[0_12px_18px_rgba(0,0,0,0.24)]"><VideoOff className="h-[16px] w-[16px]" /></span>
                    <span className="text-[10.5px] font-medium">Start Video</span>
                  </button>
                  <button data-testid="live-raise-hand" type="button" onClick={() => void EduService.updateLiveRaisedHand(selectedLiveClass._id, !Boolean(selfParticipant?.handRaised))} className="flex min-w-0 flex-col items-center justify-center gap-[8px] text-white">
                    <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-white/10 shadow-[0_12px_18px_rgba(0,0,0,0.24)]"><Hand className="h-[16px] w-[16px]" /></span>
                    <span className="text-[10.5px] font-medium">Raise Hand</span>
                  </button>
                  <button type="button" onClick={() => setMobileRoomMenuOpen((current) => !current)} className="flex min-w-0 flex-col items-center justify-center gap-[8px] text-white">
                    <span className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-white/10 shadow-[0_12px_18px_rgba(0,0,0,0.24)]"><MoreHorizontal className="h-[16px] w-[16px]" /></span>
                    <span className="text-[10.5px] font-medium">More</span>
                  </button>
                  <button data-testid="live-leave-class" type="button" onClick={() => void handleLeaveRoom()} className="flex min-w-0 flex-col items-center justify-center gap-[8px] text-white">
                    <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[16px] bg-[#ef4444] shadow-[0_14px_22px_rgba(239,68,68,0.28)]"><PhoneOff className="h-[18px] w-[18px]" /></span>
                    <span className="text-[10.5px] font-medium">Leave</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-[30px] bg-[linear-gradient(180deg,#08111f_0%,#0d1728_100%)] px-3 pb-4 pt-3 text-white shadow-[0_18px_42px_rgba(4,10,20,0.22)]">
                <div className="flex items-start justify-between gap-3 px-1">
                  <div className="flex min-w-0 items-start gap-3">
                    <button type="button" data-testid="live-room-back" onClick={() => setView('detail')} className="mt-1 inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-transparent text-white">
                      <ArrowLeft className="h-5 w-5" />
                    </button>
                    <div className="min-w-0">
                      <h2
                        className="max-w-[238px] text-[16px] font-semibold leading-[1.2] tracking-[-0.02em]"
                        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                      >
                        {getDisplayLiveClassTitle(selectedLiveClass)}
                      </h2>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-white/68">
                        <span>{getLiveMetaLine(selectedLiveClass)}</span>
                        <span>•</span>
                        <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {formatCompactCount(joinedCount)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="relative flex shrink-0 items-center gap-2 pt-1">
                    <div className="inline-flex items-center overflow-hidden rounded-[14px] border border-white/8 bg-black/24 shadow-[0_12px_20px_rgba(0,0,0,0.22)]">
                      <span className="bg-[#ef4b43] px-4 py-2 text-[12px] font-semibold uppercase">Live</span>
                    </div>
                    <button type="button" onClick={() => setMobileRoomMenuOpen((current) => !current)} className="inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-transparent text-white">
                      <MoreHorizontal className="h-4.5 w-4.5" />
                    </button>
                    {mobileRoomMenuOpen && (
                      <div className="absolute right-0 top-14 z-30 w-[170px] rounded-[16px] border border-white/10 bg-[#121d31] p-2 shadow-[0_18px_36px_rgba(0,0,0,0.32)]">
                        {isAdmin && (
                          <button type="button" data-testid="live-admin-end" onClick={() => void handleEndLiveClass()} className="flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] font-semibold text-[#ffb8bf] hover:bg-white/6">
                            End Class
                            <X className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setMobileRoomMenuOpen(false);
                            setView('detail');
                            setUtilityPanel('help');
                          }}
                          className="flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] font-semibold text-white hover:bg-white/6"
                        >
                          Get Help
                          <Bell className="h-4 w-4" />
                        </button>
                        <button type="button" data-testid="live-leave-class" onClick={() => void handleLeaveRoom()} className="flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[13px] font-semibold text-white hover:bg-white/6">
                          Leave Class
                          <PhoneOff className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="overflow-hidden rounded-[22px] border border-white/8 bg-[#101a2b] shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
                  <div>
                    {access.accessType === 'jitsi-room' ? (
                      <div data-testid="live-jitsi-container" className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-4 bg-[#0d1422] px-6 text-center text-white/82">
                        <div className="rounded-full bg-[#1a2740] p-4 text-[#7ea7ff]">
                          <MonitorUp className="h-9 w-9" />
                        </div>
                        <div className="max-w-[520px]">
                          <p className="text-[18px] font-semibold text-white">Teacher studio is ready in a separate tab</p>
                          <p className="mt-2 text-[13px] leading-6 text-white/58">
                            Open the studio to use camera, microphone, and screen sharing with full browser media support.
                          </p>
                        </div>
                        {teacherStudioUrl ? (
                          <a
                            data-testid="live-open-teacher-studio"
                            href={teacherStudioUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-[14px] bg-[#215df5] px-4 py-3 text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(33,93,245,0.28)]"
                          >
                            Open teacher studio
                          </a>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className="cursor-not-allowed rounded-[14px] bg-white/10 px-4 py-3 text-[13px] font-semibold text-white/40"
                          >
                            Teacher studio unavailable
                          </button>
                        )}
                        <p className="text-[12px] text-white/48">
                          The classroom remains on this page while the studio opens in a new tab.
                        </p>
                      </div>
                    ) : access.accessType === 'livekit-room' ? (
                      <div
                        data-testid="live-room-container"
                        data-room-loaded={roomLoaded ? 'true' : 'false'}
                        data-room-name={access.liveRoomName || ''}
                        className="relative aspect-[16/9] w-full overflow-hidden bg-[#0d1422]"
                      >
                        <div className="absolute inset-0">
                          <video ref={mobileLiveKitStageRef} className={cn('h-full w-full object-cover', !liveKitActiveStageTrack && 'hidden')} playsInline autoPlay />
                          {!liveKitActiveStageTrack && (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center text-white/72">
                              <Video className="h-9 w-9 text-[#7ea7ff]" />
                              <div>
                                <p className="text-[15px] font-semibold text-white">Preparing live video...</p>
                                <p className="mt-2 text-[12px] leading-5 text-white/58">The classroom feed will appear here as soon as camera, screen share, or a participant video track is available.</p>
                              </div>
                            </div>
                          )}
                        </div>
                        <div ref={mobileLiveKitAudioSinkRef} className="hidden" aria-hidden="true" />
                      </div>
                    ) : access.accessType === 'live-stream' ? (
                      <div className="space-y-4">
                        <div data-testid="live-stream-container" className="relative aspect-[16/9] w-full overflow-hidden bg-[#0d1422]">
                          {access.streamUrl ? (
                            <ResilientHlsVideo
                              src={new URL(access.streamUrl, window.location.origin).toString()}
                              title={detailDisplay.title}
                              playbackMode="live"
                              streamFormat={access.streamFormat || 'hls'}
                              watermarkText={access.watermarkText || null}
                              className="h-full w-full"
                              autoPlay
                            />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 text-center text-white/72">
                              <MonitorUp className="h-9 w-9 text-[#7ea7ff]" />
                              <div>
                                <p className="text-[15px] font-semibold text-white">Preparing live playback...</p>
                                <p className="mt-2 text-[12px] leading-5 text-white/58">The stream will appear here once the teacher starts broadcasting.</p>
                              </div>
                            </div>
                          )}
                        </div>
                        {selectedLiveClass?.activePoll && renderDetailPolls(true)}
                      </div>
                    ) : (
                      <div className="flex aspect-[16/9] w-full flex-col items-center justify-center gap-4 bg-white px-5 text-center">
                        <MonitorUp className="h-10 w-10 text-[#5f87ff]" />
                        <div>
                          <p className="text-[15px] font-semibold text-[#1f2d4e]">This live class is not connected to an interactive LiveKit room yet.</p>
                          <p className="mt-2 text-[12px] leading-5 text-[#6e80a1]">Recreate or start the class with LiveKit to enable audio, microphone, video, screen sharing, polls, hand raise, and live chat.</p>
                        </div>
                      </div>
                    )}
                    {(mediaNotice || mediaWarning || broadcastModeNotice) && (
                      <div className={cn('border-t px-4 py-3 text-[12px]', mediaWarning ? 'border-[#5b2b2b] bg-[#251317] text-[#ffc6ce]' : 'border-white/8 bg-[#0f1728] text-white/72')}>
                        {mediaWarning || mediaNotice || broadcastModeNotice}
                      </div>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                  <div className="flex min-w-max gap-2">
                    {(session?.participants || []).slice(0, 3).map((participant) => (
                      <div key={participant.userId} className="w-[86px] overflow-hidden rounded-[16px] border border-white/8 bg-[#111b2d] shadow-[0_10px_22px_rgba(0,0,0,0.18)]">
                        <div className="relative flex h-[88px] items-center justify-center bg-[linear-gradient(180deg,#3a312d_0%,#151d2b_100%)]">
                          <TeacherAvatar name={participant.name} size="md" online={!participant.micMuted} />
                          <div className="absolute right-1.5 top-1.5 rounded-full bg-black/38 p-1">
                            {participant.micMuted ? <MicOff className="h-3 w-3 text-white/62" /> : <Mic className="h-3 w-3 text-[#28d17c]" />}
                          </div>
                        </div>
                        <div className="px-2 py-2">
                          <p className="truncate text-[10.5px] font-semibold text-white">{participant.name}</p>
                        </div>
                      </div>
                    ))}
                    <div className="flex w-[86px] flex-col justify-between rounded-[16px] border border-white/8 bg-[#111b2d] px-2 py-2 text-white shadow-[0_10px_22px_rgba(0,0,0,0.18)]">
                      <div className="flex h-[88px] items-center justify-center rounded-[12px] bg-[#0b1220] text-[22px] font-semibold">+{Math.max(joinedCount - 3, 0)}</div>
                      <p className="pt-2 text-center text-[10.5px] font-medium text-white/78">Participants</p>
                    </div>
                  </div>
                </div>

                <div className="overflow-hidden rounded-[22px] border border-white/8 bg-[#111b2d] text-white shadow-[0_18px_42px_rgba(9,16,32,0.18)]">
                  <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3.5 text-[12px] font-semibold text-white/70">
                    {[
                      ['Chat', 'chat'],
                      ['Notes', 'notes'],
                      ['Polls', 'polls'],
                      ['Resources', 'resources'],
                    ].map(([tab, key]) => (
                      <button
                        key={tab}
                        type="button"
                        data-testid={`live-room-tab-${key}`}
                        onClick={() => setRoomPanelTab(key as LiveRoomTabKey)}
                        className={cn('relative whitespace-nowrap pb-2', roomPanelTab === key && 'text-[#a45fff] after:absolute after:inset-x-0 after:-bottom-4 after:h-[2px] after:rounded-full after:bg-[#a45fff]')}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1">
                    {roomPanelTab === 'chat' && (
                      <div className="px-4 py-4">
                        <div className="mb-3 flex items-center gap-2">
                          <h3 className="text-[15px] font-semibold text-white">Live Chat</h3>
                        </div>
                        <div className="max-h-[245px] space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:#7a4dff_transparent]">
                          {messages.map((message) => (
                            <div data-testid={`live-chat-message-${message._id}`} key={message._id} className="space-y-2">
                              <div className="flex items-center gap-2 text-[11px] text-white/52">
                                <span className="font-semibold text-white">{message.userName}</span>
                                <span>{formatTime(message.createdAt)}</span>
                              </div>
                              <div className={cn('rounded-[16px] border px-3.5 py-3 text-[12px] leading-6', message.userId === user?._id ? 'border-[#223b70] bg-[#16294a] text-white' : 'border-white/8 bg-[#111827] text-white/88')}>
                                {message.message}
                              </div>
                            </div>
                          ))}
                          {messages.length === 0 && (
                            <div className="rounded-[14px] border border-dashed border-white/10 px-4 py-4 text-[12px] leading-6 text-white/52">
                              Chat is ready. Messages sent here appear for everyone in real time.
                            </div>
                          )}
                        </div>
                        <div className="mt-4 flex items-center gap-3 rounded-[16px] border border-white/10 bg-white/4 px-4 py-2.5">
                          <input
                            data-testid="live-chat-input"
                            value={chatInput}
                            onChange={(event) => setChatInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void sendChat();
                              }
                            }}
                            placeholder="Type your message..."
                            className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-white/36"
                          />
                          <button data-testid="live-chat-send" type="button" onClick={() => void sendChat()} className="inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#7a4dff] text-white shadow-[0_12px_20px_rgba(122,77,255,0.24)]">
                            <Send className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )}
                    {roomPanelTab === 'notes' && renderDetailNotes(true)}
                    {roomPanelTab === 'polls' && renderDetailPolls(true)}
                    {roomPanelTab === 'resources' && renderDetailResources(true)}
                  </div>
                </div>

                <div className={cn('px-1 pt-1', showInteractiveRoomControls ? 'grid grid-cols-5 items-end gap-2' : 'flex justify-center')}>
                  {showInteractiveRoomControls ? (
                    <>
                      <button data-testid="live-toggle-audio" type="button" disabled={!roomLoaded} onClick={toggleAudio} className={cn('flex min-w-0 flex-col items-center justify-center gap-2', !roomLoaded ? 'text-white/34' : 'text-white')}>
                        <span className={cn('flex h-[56px] w-[56px] items-center justify-center rounded-full shadow-[0_14px_22px_rgba(0,0,0,0.18)]', !roomLoaded ? 'bg-white/6' : 'bg-[#143c2b] text-[#91f1b9]')}>{localMicMuted ? <MicOff className="h-4.5 w-4.5" /> : <Mic className="h-4.5 w-4.5" />}</span>
                        <span className="text-[11px] font-semibold">{localMicMuted ? 'Unmute' : 'Mute'}</span>
                      </button>
                      <button data-testid="live-toggle-video" type="button" disabled={!roomLoaded} onClick={toggleVideo} className={cn('flex min-w-0 flex-col items-center justify-center gap-2', !roomLoaded ? 'text-white/34' : 'text-white')}>
                        <span className={cn('flex h-[56px] w-[56px] items-center justify-center rounded-full shadow-[0_14px_22px_rgba(0,0,0,0.18)]', !roomLoaded ? 'bg-white/6' : 'bg-[#3f1c2c] text-[#ffb8cb]')}>{localVideoEnabled ? <VideoOff className="h-4.5 w-4.5" /> : <Video className="h-4.5 w-4.5" />}</span>
                        <span className="text-[11px] font-semibold">{localVideoEnabled ? 'Stop Video' : 'Start Video'}</span>
                      </button>
                      <button type="button" data-testid="live-raise-hand" disabled={!showRaiseHandControl} onClick={() => void EduService.updateLiveRaisedHand(selectedLiveClass._id, !Boolean(selfParticipant?.handRaised))} className={cn('flex min-w-0 flex-col items-center justify-center gap-2', showRaiseHandControl ? 'text-white' : 'text-white/34')}>
                        <span className={cn('flex h-[56px] w-[56px] items-center justify-center rounded-full shadow-[0_14px_22px_rgba(0,0,0,0.18)]', showRaiseHandControl ? 'bg-white/10' : 'bg-white/6')}><Hand className="h-4.5 w-4.5" /></span>
                        <span className="text-[11px] font-semibold">{selfParticipant?.handRaised ? 'Lower Hand' : 'Raise Hand'}</span>
                      </button>
                      {showPresenterScreenShareControl ? (
                        <button data-testid="live-toggle-screen-share" type="button" disabled={!roomLoaded} onClick={toggleScreenShare} className={cn('flex min-w-0 flex-col items-center justify-center gap-2', !roomLoaded ? 'text-white/34' : 'text-white')}>
                          <span className={cn('flex h-[56px] w-[56px] items-center justify-center rounded-full shadow-[0_14px_22px_rgba(0,0,0,0.18)]', !roomLoaded ? 'bg-white/6' : 'bg-[#215df5] text-white')}>
                            <MonitorUp className="h-4.5 w-4.5" />
                          </span>
                          <span className="text-[11px] font-semibold">{localScreenSharing ? 'Stop Share' : 'Share'}</span>
                        </button>
                      ) : (
                        <button type="button" onClick={() => setMobileRoomMenuOpen((current) => !current)} className="flex min-w-0 flex-col items-center justify-center gap-2 text-white">
                          <span className="flex h-[56px] w-[56px] items-center justify-center rounded-full bg-white/10 shadow-[0_14px_22px_rgba(0,0,0,0.18)]"><MoreHorizontal className="h-4.5 w-4.5" /></span>
                          <span className="text-[11px] font-semibold">More</span>
                        </button>
                      )}
                      <button data-testid="live-leave-class" type="button" onClick={() => void handleLeaveRoom()} className="flex min-w-0 flex-col items-center justify-center gap-2">
                        <span className="flex h-[66px] w-[66px] items-center justify-center rounded-[20px] bg-[#ea4335] text-white shadow-[0_14px_24px_rgba(234,67,53,0.22)]"><PhoneOff className="h-5 w-5" /></span>
                        <span className="text-[11px] font-semibold text-white">Leave</span>
                      </button>
                    </>
                  ) : (
                    <button data-testid="live-leave-class" type="button" onClick={() => void handleLeaveRoom()} className="flex min-w-0 flex-col items-center justify-center gap-2">
                      <span className="flex h-[66px] w-[66px] items-center justify-center rounded-[20px] bg-[#ea4335] text-white shadow-[0_14px_24px_rgba(234,67,53,0.22)]"><PhoneOff className="h-5 w-5" /></span>
                      <span className="text-[11px] font-semibold text-white">Leave stream</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="hidden rounded-[24px] border border-[#16233b] bg-[linear-gradient(180deg,#08111f_0%,#0d1728_100%)] p-3 text-white shadow-[0_20px_54px_rgba(4,10,20,0.36)] md:block lg:p-4">
            <div className="flex flex-col gap-3 border-b border-white/8 pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setView('detail')} className="inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-white/8 md:h-9 md:w-9 md:rounded-[12px]">
                  <ChevronDown className="h-4.5 w-4.5" />
                </button>
                <div className="inline-flex items-center overflow-hidden rounded-[12px] border border-white/8 bg-black/24 shadow-[0_12px_20px_rgba(0,0,0,0.22)]">
                  <span className="bg-[#ef4b43] px-3 py-2 text-[13px] font-semibold uppercase">Live</span>
                  <span className="px-3 py-2 text-[15px] font-medium">00:18:45</span>
                </div>
                <div>
                  <h2 className="max-w-[230px] text-[1.08rem] font-semibold tracking-[-0.03em] md:max-w-none md:text-[1.15rem]">{getDisplayLiveClassTitle(selectedLiveClass)}</h2>
                  <p className="text-[13px] text-white/62">{getLiveMetaLine(selectedLiveClass)}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[13px] text-white/82">
                <span className="inline-flex items-center gap-2"><Users className="h-4 w-4" /> {formatCompactCount(joinedCount)}</span>
                <span className="hidden items-center gap-2 md:inline-flex"><MessageSquare className="h-4 w-4" /> {messages.length}</span>
                <Bell className="hidden h-4.5 w-4.5 md:block" />
                <Settings className="hidden h-4.5 w-4.5 md:block" />
                <div className="hidden h-7 w-px bg-white/10 md:block" />
                <div className="hidden items-center gap-3 md:flex">
                  <TeacherAvatar name={user?.name || 'Learner'} size="sm" online />
                  <div>
                    <p className="text-[13px] font-semibold text-white">{user?.name || 'Learner'}</p>
                    <p className="text-xs text-white/56">{isAdmin ? 'Teacher' : 'Aspirant'}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.56fr)_286px]">
              <div className="space-y-4">
                <div className="overflow-hidden rounded-[20px] border border-white/8 bg-[#101a2b] shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
                    {access.accessType === 'jitsi-room' ? (
                      <div ref={desktopRoomStageRef} data-testid="live-jitsi-container" className="flex h-[430px] w-full flex-col items-center justify-center gap-5 bg-[#0d1422] px-6 text-center text-white/82">
                        <div className="rounded-full bg-[#1a2740] p-5 text-[#7ea7ff]">
                          <MonitorUp className="h-12 w-12" />
                        </div>
                        <div className="max-w-[560px]">
                          <p className="text-[18px] font-semibold text-white">Teacher studio is ready in a separate tab</p>
                          <p className="mt-2 text-[13px] leading-6 text-white/58">
                            Open the studio to use camera, microphone, and screen sharing with full browser media support.
                          </p>
                        </div>
                        {teacherStudioUrl ? (
                          <a
                            data-testid="live-open-teacher-studio"
                            href={teacherStudioUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-[14px] bg-[#215df5] px-4 py-3 text-[13px] font-semibold text-white shadow-[0_12px_24px_rgba(33,93,245,0.28)]"
                          >
                            Open teacher studio
                          </a>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className="cursor-not-allowed rounded-[14px] bg-white/10 px-4 py-3 text-[13px] font-semibold text-white/40"
                          >
                            Teacher studio unavailable
                          </button>
                        )}
                        <p className="text-[12px] text-white/48">
                          The classroom stays here while the studio opens in a new tab.
                        </p>
                      </div>
                    ) : access.accessType === 'livekit-room' ? (
                    <div ref={desktopRoomStageRef} data-testid="live-room-container" data-room-loaded={roomLoaded ? 'true' : 'false'} data-room-name={access.liveRoomName || ''} className="relative h-[430px] w-full overflow-hidden bg-[#0d1422]">
                      <div className="absolute inset-0">
                        <video ref={desktopLiveKitStageRef} className={cn('h-full w-full object-cover', !liveKitActiveStageTrack && 'hidden')} playsInline autoPlay />
                        {!liveKitActiveStageTrack && (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center text-white/72">
                            <Video className="h-12 w-12 text-[#7ea7ff]" />
                            <div>
                              <p className="text-[18px] font-semibold text-white">Preparing the live classroom feed...</p>
                              <p className="mt-2 text-[13px] text-white/58">Camera, microphone, screen share, and remote participant video will appear here as soon as the room finishes connecting.</p>
                            </div>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        data-testid="live-room-maximize"
                        onClick={() => void toggleLiveRoomFullscreen()}
                        className="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-black/55 text-white shadow-[0_10px_24px_rgba(0,0,0,0.24)]"
                        aria-label="Maximize live class"
                      >
                        <Maximize2 className="h-4.5 w-4.5" />
                      </button>
                      {liveKitActiveStageTrack && (
                        <div className="pointer-events-none absolute left-4 top-4 rounded-[14px] bg-black/48 px-3.5 py-2.5 text-[13px] font-semibold text-white shadow-[0_10px_24px_rgba(0,0,0,0.26)]">
                          {liveKitActiveStageTrack.participantName}
                          {liveKitActiveStageTrack.source === Track.Source.ScreenShare ? ' is presenting' : ' is live'}
                        </div>
                      )}
                      <div className="absolute bottom-4 left-4 rounded-[14px] bg-black/52 px-3.5 py-2.5 text-[13px] text-white shadow-[0_10px_24px_rgba(0,0,0,0.24)]">
                        Rahul Sharma is presenting
                      </div>
                      <div className="absolute bottom-4 right-4 overflow-hidden rounded-[14px] border border-white/12 bg-black/45 shadow-[0_14px_32px_rgba(0,0,0,0.3)]">
                        <video ref={desktopLiveKitLocalPreviewRef} className={cn('h-24 w-36 object-cover', !liveKitLocalPreviewTrack || liveKitLocalPreviewTrack.trackSid === liveKitActiveStageTrack?.trackSid ? 'hidden' : '')} playsInline autoPlay muted />
                      </div>
                      <div ref={desktopLiveKitAudioSinkRef} className="hidden" aria-hidden="true" />
                      </div>
                    ) : access.accessType === 'live-stream' ? (
                      <div className="space-y-4">
                        <div data-testid="live-stream-container" className="relative h-[430px] w-full overflow-hidden bg-[#0d1422]">
                          {access.streamUrl ? (
                            <ResilientHlsVideo
                              src={new URL(access.streamUrl, window.location.origin).toString()}
                              title={detailDisplay.title}
                              playbackMode="live"
                              streamFormat={access.streamFormat || 'hls'}
                              watermarkText={access.watermarkText || null}
                              className="h-full w-full"
                              autoPlay
                            />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0d1422] px-6 text-center text-white/72">
                              <MonitorUp className="h-12 w-12 text-[#7ea7ff]" />
                              <div>
                                <p className="text-[18px] font-semibold text-white">Preparing live playback...</p>
                                <p className="mt-2 text-[13px] text-white/58">The stream will appear here once the teacher starts broadcasting.</p>
                              </div>
                            </div>
                          )}
                        </div>
                        {selectedLiveClass?.activePoll && renderDetailPolls(true)}
                      </div>
                    ) : (
                    <div ref={desktopRoomStageRef} className="relative flex h-[430px] w-full flex-col items-center justify-center gap-4 bg-[#0d1422] px-6 text-center">
                      <button
                        type="button"
                        data-testid="live-room-maximize"
                        onClick={() => void toggleLiveRoomFullscreen()}
                        className="absolute right-4 top-4 z-10 inline-flex h-10 w-10 items-center justify-center rounded-[14px] bg-black/55 text-white shadow-[0_10px_24px_rgba(0,0,0,0.24)]"
                        aria-label="Maximize live class"
                      >
                        <Maximize2 className="h-4.5 w-4.5" />
                      </button>
                      <MonitorUp className="h-12 w-12 text-[#7ea7ff]" />
                      <div>
                        <p className="text-[18px] font-semibold text-white">This live class is not connected to an interactive LiveKit room yet.</p>
                        <p className="mt-2 text-[13px] text-white/62">Recreate or start the class with LiveKit to enable audio, video, screen sharing, polls, hand raise, live chat, and admin controls.</p>
                      </div>
                    </div>
                  )}
                  {(mediaNotice || mediaWarning || broadcastModeNotice) && (
                    <div className={cn('border-t px-4 py-3 text-[13px]', mediaWarning ? 'border-[#5b2b2b] bg-[#251317] text-[#ffc6ce]' : 'border-white/8 bg-[#0f1728] text-white/72')}>
                      {mediaWarning || mediaNotice || broadcastModeNotice}
                    </div>
                  )}
                </div>
              </div>
              <aside className="space-y-3">
                <div className="rounded-[20px] border border-white/8 bg-[#101a2b] p-3.5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[1rem] font-semibold">Video</h3>
                    <div className="flex items-center gap-2 text-white/62">
                      <div className="rounded-[10px] bg-[#233251] p-2"><Users className="h-4 w-4" /></div>
                      <div className="rounded-[10px] bg-[#233251] p-2"><BookOpen className="h-4 w-4" /></div>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2.5">
                    {(session?.participants || []).slice(0, 3).map((participant, index) => (
                      <div key={participant.userId} className={cn('relative overflow-hidden rounded-[14px] border p-2.5', index === 0 ? 'border-[#356eff] bg-[linear-gradient(180deg,#1a2742_0%,#152033_100%)]' : 'border-white/8 bg-white/4')}>
                        <div className="flex h-[92px] items-center justify-center rounded-[12px] bg-[linear-gradient(180deg,#3a2f2b_0%,#1a1f29_100%)]">
                          <TeacherAvatar name={participant.name} size="lg" online={!participant.micMuted} />
                        </div>
                        <div className="mt-2.5 flex items-center justify-between gap-3">
                          <p className="text-[14px] font-semibold text-white">{participant.name}</p>
                          {participant.micMuted ? <MicOff className="h-4 w-4 text-white/60" /> : <Mic className="h-4 w-4 text-[#31d57c]" />}
                        </div>
                      </div>
                    ))}
                    <div className="rounded-[14px] border border-white/8 bg-white/4 px-4 py-4 text-center">
                      <p className="text-[1.25rem] font-semibold text-white">+{Math.max(joinedCount - 3, 0)}</p>
                      <p className="mt-1 text-[13px] text-white/72">Students</p>
                    </div>
                  </div>
                </div>
              </aside>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.04fr)_300px_256px]">
              <div className="rounded-[20px] border border-white/8 bg-[#101a2b]">
                <div className="flex items-center gap-6 border-b border-white/8 px-4 py-3 text-[13px] font-semibold text-white/72">
                  {[
                    ['Live Chat', 'chat'],
                    ['Notes', 'notes'],
                    ['Polls', 'polls'],
                    ['Resources', 'resources'],
                  ].map(([tab, key]) => (
                    <button key={tab} type="button" onClick={() => setRoomPanelTab(key as LiveRoomTabKey)} className={cn('relative', roomPanelTab === key && 'text-[#4e8dff] after:absolute after:inset-x-0 after:-bottom-3 after:h-[2px] after:rounded-full after:bg-[#4e8dff]')}>
                      {tab}
                    </button>
                  ))}
                </div>
                <div className="max-h-[350px] overflow-y-auto px-4 py-4 [scrollbar-width:thin] [scrollbar-color:#5c7cff_transparent]">
                  {roomPanelTab === 'chat' && renderDetailChat(true)}
                  {roomPanelTab === 'notes' && renderDetailNotes(true)}
                  {roomPanelTab === 'polls' && renderDetailPolls(true)}
                  {roomPanelTab === 'resources' && renderDetailResources(true)}
                </div>
              </div>

              <div className="rounded-[20px] border border-white/8 bg-[#101a2b] p-4">
                <h3 className="text-[1rem] font-semibold">Participants ({joinedCount})</h3>
                <div className="mt-3 flex items-center gap-3 rounded-[14px] border border-white/8 bg-white/4 px-4 py-2.5 text-white/62">
                  <Search className="h-4 w-4" />
                  <input value={participantSearch} onChange={(event) => setParticipantSearch(event.target.value)} className="w-full bg-transparent outline-none placeholder:text-white/38" placeholder="Search participants" />
                </div>
                <div className="mt-3 space-y-2.5">
                  {filteredParticipants.map((participant) => (
                    <div
                      data-testid={`live-participant-${participant.userId}`}
                      data-user-id={participant.userId}
                      data-role={participant.role}
                      data-mic-muted={participant.micMuted ? 'true' : 'false'}
                      data-video-enabled={participant.videoEnabled ? 'true' : 'false'}
                      data-screen-sharing={participant.isScreenSharing ? 'true' : 'false'}
                      data-can-speak={participant.canSpeak ? 'true' : 'false'}
                      data-hand-status={participant.handStatus}
                      data-hand-raised={participant.handRaised ? 'true' : 'false'}
                      key={participant.userId}
                      className="rounded-[14px] border border-white/8 bg-white/4 p-3.5"
                    >
                      <div className="flex items-start gap-3">
                        <TeacherAvatar name={participant.name} size="sm" online={!participant.micMuted} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[14px] font-semibold text-white">{participant.name}</p>
                            {participant.role === 'admin' && <span className="rounded-full bg-[#325aa7] px-2 py-0.5 text-[10px] font-semibold text-white">Teacher</span>}
                          </div>
                          <p className="mt-1 text-[12px] text-white/58">
                            {participant.role === 'admin'
                              ? 'Teacher'
                              : participant.handStatus === 'pending'
                                ? 'Raised hand'
                                : participant.canSpeak
                                  ? 'Approved to speak'
                                  : 'Listening'}
                          </p>
                        </div>
                        <div className="mt-1 flex flex-col items-center gap-3 text-white/62">
                          {participant.micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4 text-[#31d57c]" />}
                          {participant.videoEnabled ? <Video className="h-4 w-4 text-[#4e8dff]" /> : <VideoOff className="h-4 w-4" />}
                        </div>
                      </div>
                      {showInteractiveRoomControls && isAdmin && participant.role !== 'admin' && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button data-testid={`live-admin-toggle-mute-${participant.userId}`} type="button" onClick={() => void EduService.muteLiveParticipant(selectedLiveClass._id, participant.userId, !participant.micMuted)} className="rounded-[10px] bg-white/8 px-3 py-1.5 text-[11px] font-semibold">
                            {participant.micMuted ? 'Unmute' : 'Mute'}
                          </button>
                          {participant.handStatus === 'pending' ? (
                            <>
                              <button data-testid={`live-admin-approve-${participant.userId}`} type="button" onClick={() => void EduService.approveLiveParticipant(selectedLiveClass._id, participant.userId, true)} className="rounded-[10px] bg-[#153e84] px-3 py-1.5 text-[11px] font-semibold text-[#9fc2ff]">
                                Approve Speak
                              </button>
                              <button data-testid={`live-admin-reject-${participant.userId}`} type="button" onClick={() => void EduService.approveLiveParticipant(selectedLiveClass._id, participant.userId, false)} className="rounded-[10px] bg-[#5a3a11] px-3 py-1.5 text-[11px] font-semibold text-[#ffd48b]">
                                Reject
                              </button>
                            </>
                          ) : (
                            <button data-testid={`live-admin-toggle-approval-${participant.userId}`} type="button" onClick={() => void EduService.approveLiveParticipant(selectedLiveClass._id, participant.userId, !participant.canSpeak)} className="rounded-[10px] bg-[#153e84] px-3 py-1.5 text-[11px] font-semibold text-[#9fc2ff]">
                              {participant.canSpeak ? 'Revoke Speak' : 'Approve Speak'}
                            </button>
                          )}
                          <button data-testid={`live-admin-remove-${participant.userId}`} type="button" onClick={() => void EduService.removeLiveParticipant(selectedLiveClass._id, participant.userId)} className="rounded-[10px] bg-[#5a1921] px-3 py-1.5 text-[11px] font-semibold text-[#ffb4bf]">
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {filteredParticipants.length === 0 && (
                    <div className="rounded-[14px] border border-dashed border-white/10 px-4 py-4 text-[13px] text-white/54">
                      No participants match this search yet.
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => setUiNotice('Participant list is already expanded in this panel.')} className="mt-4 w-full rounded-[12px] bg-white/6 px-4 py-3 text-center text-[14px] font-semibold text-[#6d8dff]">
                  View all
                </button>
              </div>

              <div className="rounded-[20px] border border-white/8 bg-[#101a2b] p-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[1rem] font-semibold">Class Resources</h3>
                  <MoreHorizontal className="h-5 w-5 text-white/54" />
                </div>
                <div className="mt-3 space-y-2.5">
                  {activeResources.map((resource) => (
                    <button key={resource.id} type="button" onClick={() => openPdfResource(resource.title, resource.lines || [resource.description || resource.url || 'Reference material'])} className="flex w-full items-center justify-between gap-3 rounded-[12px] border border-white/8 bg-white/4 px-3.5 py-3.5 text-left">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-white text-[#2b63df]">
                          <FileText className="h-4.5 w-4.5" />
                        </div>
                        <div>
                          <p className="text-[14px] font-semibold text-white">{resource.title}</p>
                          <p className="text-[12px] text-white/54">{resource.type || 'PDF'}</p>
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-white/54" />
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => activeResources.forEach((resource) => openPdfResource(resource.title, resource.lines || [resource.description || resource.url || 'Reference material']))} className="mt-4 w-full rounded-[12px] bg-[linear-gradient(90deg,#5b35db_0%,#7a4dff_100%)] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_14px_24px_rgba(91,53,219,0.22)]">
                  Download All
                </button>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-3 border-t border-white/8 pt-4 lg:justify-between">
              <div className="flex flex-wrap items-center justify-center gap-3">
                {showInteractiveRoomControls && (
                  <>
                    <button data-testid="live-toggle-audio" type="button" disabled={!roomLoaded} onClick={toggleAudio} className={cn('flex h-[64px] w-[64px] flex-col items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_14px_22px_rgba(0,0,0,0.18)]', !roomLoaded ? 'bg-white/6 text-white/34' : 'bg-[#143c2b] text-[#91f1b9]')}>
                      {localMicMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                      <span className="mt-1.5">{localMicMuted ? 'Unmute' : 'Mute'}</span>
                    </button>
                    <button data-testid="live-toggle-video" type="button" disabled={!roomLoaded} onClick={toggleVideo} className={cn('flex h-[64px] w-[64px] flex-col items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_14px_22px_rgba(0,0,0,0.18)]', !roomLoaded ? 'bg-white/6 text-white/34' : 'bg-[#3f1c2c] text-[#ffb8cb]')}>
                      {localVideoEnabled ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
                      <span className="mt-1.5">{localVideoEnabled ? 'Stop Video' : 'Start Video'}</span>
                    </button>
                    <button type="button" data-testid="live-raise-hand" disabled={!showRaiseHandControl} onClick={() => void EduService.updateLiveRaisedHand(selectedLiveClass._id, !Boolean(selfParticipant?.handRaised))} className={cn('flex h-[64px] w-[64px] flex-col items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_14px_22px_rgba(0,0,0,0.18)]', showRaiseHandControl ? 'bg-white/10 text-white' : 'bg-white/6 text-white/34')}>
                      <Hand className="h-5 w-5" />
                      <span className="mt-1.5">{selfParticipant?.handRaised ? 'Lower Hand' : 'Raise Hand'}</span>
                    </button>
                    <button data-testid="live-toggle-screen-share" type="button" disabled={!showPresenterScreenShareControl || !roomLoaded} onClick={toggleScreenShare} className={cn('flex h-[64px] w-[64px] flex-col items-center justify-center rounded-full text-[11px] font-semibold shadow-[0_14px_22px_rgba(0,0,0,0.18)]', showPresenterScreenShareControl && roomLoaded ? 'bg-[#215df5] text-white' : 'bg-white/6 text-white/34')}>
                      <MonitorUp className="h-5 w-5" />
                      <span className="mt-1.5">{localScreenSharing ? 'Stop' : 'Share'}</span>
                    </button>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {showInteractiveRoomControls && isAdmin && (
                  <button data-testid="live-admin-end" type="button" onClick={() => void handleEndLiveClass()} className="inline-flex min-w-[148px] items-center justify-center gap-3 rounded-[16px] bg-[#7a2430] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_14px_24px_rgba(122,36,48,0.22)]">
                    <X className="h-4.5 w-4.5" />
                    End Class
                  </button>
                )}
                <button data-testid="live-leave-class" type="button" onClick={() => void handleLeaveRoom()} className="inline-flex min-w-[156px] items-center justify-center gap-3 rounded-[16px] bg-[#ea4335] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_14px_24px_rgba(234,67,53,0.22)]">
                  <PhoneOff className="h-4.5 w-4.5" />
                  Leave Class
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
