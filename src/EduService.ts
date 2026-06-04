import {
  AdminAccessDiagnosis,
  AdminAuditLogRecord,
  AdminDashboardSummary,
  AdminBulkRazorpaySyncResult,
  AdminCourseAccessRecord,
  AdminCourseContentAccessRule,
  AdminCourseAccessSummary,
  AdminLoginSessionRecord,
  AdminLoginSessionSummary,
  AdminManualReviewRecord,
  AdminManualReviewSummary,
  AdminPagination,
  AdminPaymentRangeParams,
  AdminPaymentReconciliationReport,
  AdminPurchaseRecord,
  AdminRepairResult,
  AdminRazorpaySyncResult,
  AdminStudentDetails,
  AdminStudentLessonWatchOverride,
  AdminStudentLiveMetricsSummary,
  AdminStudentSummary,
  AdminSystemHealthSummary,
  AdminTransactionRecord,
  AdminLessonDoubtListResponse,
  AdminLessonReportListResponse,
  AiResponse,
  AuthResponse,
  AuthUser,
  CourseCard,
  CourseLesson,
  CoursePdfAttachment,
  DailyQuizResult,
  GeneratedAssessmentDraft,
  LessonDoubtThread,
  LessonReportRecord,
  LiveClass,
  LiveClassAccess,
  LiveClassChatMessage,
  LiveClassEventPayload,
  LiveClassResource,
  LiveClassSessionState,
  LiveTeacherProfile,
  MockTest,
  NotificationItem,
  PlatformOverview,
  ProtectedLessonPlayback,
  RegisterPayload,
  SupportAttachment,
  TestAttemptResult,
} from './types';
import { LIVE_CLASSES_ENABLED } from './lib/featureFlags';

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '');
const trimLeadingSlash = (value: string) => value.replace(/^\/+/, '');
const isAbsoluteUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//');
const env = import.meta.env as Record<string, string | undefined>;
const configuredAppOrigin = trimTrailingSlash(
  String(env.VITE_PUBLIC_APP_URL || env.VITE_APP_URL || '').trim(),
);
const configuredApiBase = trimTrailingSlash(String(env.VITE_API_BASE_URL || '').trim());
const runtimeHttpOrigin = (() => {
  if (typeof window === 'undefined') {
    return '';
  }
  const origin = String(window.location.origin || '').trim();
  return /^https?:\/\//i.test(origin) ? trimTrailingSlash(origin) : '';
})();
const APP_ORIGIN = configuredAppOrigin || runtimeHttpOrigin;
const API_BASE = configuredApiBase || (APP_ORIGIN ? `${APP_ORIGIN}/backend/api` : '/backend/api');
const ROOT_BASE = APP_ORIGIN || '';
const VIDEO_UPLOAD_CHUNK_SIZE_BYTES = 20 * 1024 * 1024;
const DIRECT_VIDEO_UPLOAD_LIMIT_BYTES = 90 * 1024 * 1024;
const TOKEN_KEY = 'edumaster.jwt';
const AUTH_EVENT_KEY = 'edumaster.auth.event';
const AUTH_SESSION_META_KEY = 'edumaster.auth.session';
const DEVICE_ID_KEY = 'edumaster.device.id';
const PLAYBACK_TAB_ID_KEY = 'edumaster.playback.tab.id';

const toSearchParams = <T extends object>(params: T) => {
  const searchParams = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  return searchParams;
};

let authToken: string | null = null;
let deviceIdCache: string | null = null;
let playbackTabIdCache: string | null = null;
const authRequestInflight = new Map<string, Promise<unknown>>();
const protectedLessonPlaybackCache = new Map<string, { expiresAt: number; value: ProtectedLessonPlayback }>();
const protectedLessonPlaybackInflight = new Map<string, Promise<ProtectedLessonPlayback>>();
const PROTECTED_LESSON_PLAYBACK_CACHE_TTL_MS = 20_000;

type RequestOptions = RequestInit & {
  includeAuth?: boolean;
  expireSessionOn401?: boolean;
};

type LoginOptions = {
  forceLogoutOtherSessions?: boolean;
};

type FirebaseAuthProvider = 'password' | 'google' | 'apple';

type AuthSessionMeta = {
  userId: string | null;
  sessionId: string | null;
  issuedAt: string;
};

export class ApiRequestError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(message: string, { status, code, details }: { status: number; code: string; details?: any }) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
  }
}

const resolveAbsoluteUrl = (value?: string | null) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return normalized;
  }
  if (isAbsoluteUrl(normalized)) {
    return normalized;
  }
  const baseOrigin = APP_ORIGIN || runtimeHttpOrigin;
  if (!baseOrigin) {
    return normalized;
  }
  return `${baseOrigin}/${trimLeadingSlash(normalized)}`;
};

const resolveRootPath = (path: string) => {
  if (isAbsoluteUrl(path)) {
    return path;
  }
  if (!path.startsWith('/')) {
    return path;
  }
  return ROOT_BASE ? `${ROOT_BASE}${path}` : path;
};

const getCheckoutOrigin = () => ROOT_BASE || runtimeHttpOrigin || 'https://app.varoonenglish.com';
const buildVideoUploadId = () => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return `upload_${randomUuid.replace(/-/g, '')}`;
  }
  return `upload_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type VideoUploadProgress = {
  uploadedBytes: number;
  totalBytes: number;
  chunkIndex: number;
  totalChunks: number;
};

type CloudflareStreamUploadSession = {
  upload: {
    uid: string;
    uploadURL: string;
    method: 'direct-post' | 'tus' | string;
    expiresAt?: string | null;
  };
  video: CourseLesson;
  message?: string;
};

type MultipartVideoUploadSession = {
  uploadSessionId: string;
  lessonId: string;
  partSizeBytes: number;
  recommendedConcurrency?: number;
  processingProvider?: string;
  message?: string;
};

const extractUploadErrorMessage = (responseText: string, fallbackMessage: string) => {
  const normalizedText = String(responseText || '').trim();
  if (!normalizedText) {
    return fallbackMessage;
  }

  try {
    const payload = JSON.parse(normalizedText);
    const message = payload?.errors?.[0]?.message
      || payload?.messages?.[0]
      || payload?.message
      || payload?.error;
    if (message) {
      return String(message);
    }
  } catch {
    // Non-JSON response bodies fall back to plain text when available.
  }

  return normalizedText || fallbackMessage;
};

const uploadDirectPostToCloudflare = (
  uploadURL: string,
  file: File,
  onProgress?: (progress: VideoUploadProgress) => void,
) => new Promise<void>((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  const formData = new FormData();
  formData.append('file', file, file.name);

  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) {
      return;
    }
    onProgress?.({
      uploadedBytes: event.loaded,
      totalBytes: event.total || file.size,
      chunkIndex: 0,
      totalChunks: 1,
    });
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      onProgress?.({
        uploadedBytes: file.size,
        totalBytes: file.size,
        chunkIndex: 0,
        totalChunks: 1,
      });
      resolve();
      return;
    }
    reject(new Error(extractUploadErrorMessage(
      xhr.responseText,
      `Cloudflare Stream upload failed (${xhr.status})`,
    )));
  };
  xhr.onerror = () => reject(new Error('Cloudflare Stream upload failed'));
  xhr.open('POST', uploadURL);
  xhr.send(formData);
});

const patchTusChunk = (
  uploadURL: string,
  chunk: Blob,
  offset: number,
) => new Promise<number>((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.onload = () => {
    if (xhr.status === 204 || (xhr.status >= 200 && xhr.status < 300)) {
      const nextOffset = Number(xhr.getResponseHeader('Upload-Offset') || offset + chunk.size);
      resolve(Number.isFinite(nextOffset) ? nextOffset : offset + chunk.size);
      return;
    }
    const error = new Error(`Cloudflare Stream resumable upload failed (${xhr.status})`) as Error & {
      status?: number;
      uploadOffset?: number;
    };
    error.status = xhr.status;
    const responseOffset = Number(xhr.getResponseHeader('Upload-Offset'));
    if (Number.isFinite(responseOffset)) {
      error.uploadOffset = responseOffset;
    }
    reject(error);
  };
  xhr.onerror = () => reject(new Error('Cloudflare Stream resumable upload failed'));
  xhr.open('PATCH', uploadURL);
  xhr.setRequestHeader('Tus-Resumable', '1.0.0');
  xhr.setRequestHeader('Upload-Offset', String(offset));
  xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
  xhr.send(chunk);
});

const uploadBlobToSignedUrl = (
  uploadUrl: string,
  blob: Blob,
  onProgress?: (loadedBytes: number) => void,
) => new Promise<void>((resolve, reject) => {
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) {
      return;
    }
    onProgress?.(event.loaded);
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      onProgress?.(blob.size);
      resolve();
      return;
    }
    reject(new Error(extractUploadErrorMessage(
      xhr.responseText,
      `Multipart upload failed (${xhr.status})`,
    )));
  };
  xhr.onerror = () => reject(new Error('Multipart upload failed'));
  xhr.open('PUT', uploadUrl);
  xhr.send(blob);
});

const getTusUploadOffset = (uploadURL: string) => new Promise<number | null>((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.onload = () => {
    const offset = Number(xhr.getResponseHeader('Upload-Offset'));
    resolve(Number.isFinite(offset) ? offset : null);
  };
  xhr.onerror = () => resolve(null);
  xhr.open('HEAD', uploadURL);
  xhr.setRequestHeader('Tus-Resumable', '1.0.0');
  xhr.send();
});

const uploadTusToCloudflare = async (
  uploadURL: string,
  file: File,
  onProgress?: (progress: VideoUploadProgress) => void,
) => {
  const totalChunks = Math.ceil(file.size / VIDEO_UPLOAD_CHUNK_SIZE_BYTES);
  let offset = 0;

  for (let chunkIndex = 0; offset < file.size; chunkIndex += 1) {
    const end = Math.min(offset + VIDEO_UPLOAD_CHUNK_SIZE_BYTES, file.size);
    const chunk = file.slice(offset, end, file.type || 'application/octet-stream');
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        offset = await patchTusChunk(uploadURL, chunk, offset);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Cloudflare Stream resumable upload failed');
        const uploadError = lastError as Error & { status?: number; uploadOffset?: number };
        if (uploadError.status === 409) {
          const remoteOffset = Number.isFinite(uploadError.uploadOffset)
            ? Number(uploadError.uploadOffset)
            : await getTusUploadOffset(uploadURL);
          if (Number.isFinite(remoteOffset) && remoteOffset !== offset) {
            offset = Math.min(Math.max(Number(remoteOffset), 0), file.size);
            lastError = null;
            break;
          }
        }
        if (attempt < 2) {
          await delay(900 * (attempt + 1));
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    onProgress?.({
      uploadedBytes: Math.min(offset, file.size),
      totalBytes: file.size,
      chunkIndex,
      totalChunks,
    });
  }
};

const normalizeCourseLesson = (lesson: CourseLesson): CourseLesson => ({
  ...lesson,
  videoUrl: resolveAbsoluteUrl(lesson.videoUrl),
  notesUrl: resolveAbsoluteUrl(lesson.notesUrl),
  attachments: (lesson.attachments || []).map(normalizeCoursePdfAttachment),
});

const normalizeCoursePdfAttachment = (attachment: CoursePdfAttachment): CoursePdfAttachment => ({
  ...attachment,
});

const normalizeCourseCard = (course: CourseCard): CourseCard => ({
  ...course,
  offerPercentage: Number(course.offerPercentage || 0),
  thumbnailUrl: resolveAbsoluteUrl(course.thumbnailUrl),
  officialChannelUrl: resolveAbsoluteUrl(course.officialChannelUrl || null) || course.officialChannelUrl || null,
  continueLesson: course.continueLesson ? normalizeCourseLesson(course.continueLesson) : course.continueLesson,
  modules: (course.modules || []).map((module) => ({
    ...module,
    attachments: (module.attachments || []).map(normalizeCoursePdfAttachment),
    lessons: (module.lessons || []).map(normalizeCourseLesson),
    chapters: (module.chapters || []).map((chapter) => ({
      ...chapter,
      attachments: (chapter.attachments || []).map(normalizeCoursePdfAttachment),
      lessons: (chapter.lessons || []).map(normalizeCourseLesson),
    })),
  })),
});

const normalizeLiveTeacherProfile = (profile?: LiveTeacherProfile | null): LiveTeacherProfile | null =>
  profile
    ? {
      ...profile,
      avatarUrl: resolveAbsoluteUrl(profile.avatarUrl || null) || profile.avatarUrl || null,
    }
    : profile || null;

const normalizeLiveClassResource = (resource: LiveClassResource): LiveClassResource => ({
  ...resource,
  url: resolveAbsoluteUrl(resource.url || null) || resource.url || null,
});

const isPresent = <T,>(value: T | null | undefined): value is T => value != null;

const getDiscountedCoursePrice = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 0);
  const offerPercentage = Math.min(Math.max(Number(course.offerPercentage || 0), 0), 100);
  const discountedPrice = basePrice * (1 - (offerPercentage / 100));
  return Math.max(Number(discountedPrice.toFixed(2)), 1);
};

const normalizeLiveClass = (liveClass: LiveClass): LiveClass => ({
  ...liveClass,
  livePlaybackUrl: resolveAbsoluteUrl(liveClass.livePlaybackUrl || null) || liveClass.livePlaybackUrl || null,
  ingestServerUrl: resolveAbsoluteUrl(liveClass.ingestServerUrl || null) || liveClass.ingestServerUrl || null,
  embedUrl: resolveAbsoluteUrl(liveClass.embedUrl || null) || liveClass.embedUrl || null,
  roomUrl: resolveAbsoluteUrl(liveClass.roomUrl || null) || liveClass.roomUrl || null,
  recordingUrl: resolveAbsoluteUrl(liveClass.recordingUrl || null) || liveClass.recordingUrl || null,
  posterUrl: resolveAbsoluteUrl(liveClass.posterUrl || null) || liveClass.posterUrl || null,
  teacherProfile: normalizeLiveTeacherProfile(liveClass.teacherProfile),
  resources: (liveClass.resources || []).map(normalizeLiveClassResource),
});

const normalizeProtectedLessonPlayback = (playback: ProtectedLessonPlayback): ProtectedLessonPlayback => ({
  ...playback,
  embedUrl: resolveAbsoluteUrl(playback.embedUrl || null) || playback.embedUrl || null,
  streamUrl: resolveAbsoluteUrl(playback.streamUrl || null) || playback.streamUrl || null,
  fallbackStreamUrl: resolveAbsoluteUrl(playback.fallbackStreamUrl || null) || playback.fallbackStreamUrl || null,
  drmConfig: playback.drmConfig ? {
    ...playback.drmConfig,
    manifestUrl: resolveAbsoluteUrl(playback.drmConfig.manifestUrl || null) || playback.drmConfig.manifestUrl,
    fairplayCertificateUrl: resolveAbsoluteUrl(playback.drmConfig.fairplayCertificateUrl || null) || playback.drmConfig.fairplayCertificateUrl || null,
  } : playback.drmConfig ?? null,
});

const normalizeLiveClassAccess = (access: LiveClassAccess): LiveClassAccess => ({
  ...access,
  streamUrl: resolveAbsoluteUrl(access.streamUrl || null) || access.streamUrl || null,
  embedUrl: resolveAbsoluteUrl(access.embedUrl || null) || access.embedUrl || null,
  roomUrl: resolveAbsoluteUrl(access.roomUrl || null) || access.roomUrl || null,
  replayExternalUrl: resolveAbsoluteUrl(access.replayExternalUrl || null) || access.replayExternalUrl || null,
  replayPlayback: access.replayPlayback ? normalizeProtectedLessonPlayback(access.replayPlayback) : access.replayPlayback,
});

const getClientDeviceLabel = () => {
  if (typeof window === 'undefined') {
    return 'web-dashboard';
  }

  const platform = window.navigator.platform || 'desktop';
  const browser = window.navigator.userAgent.includes('Chrome')
    ? 'Chrome'
    : window.navigator.userAgent.includes('Safari')
      ? 'Safari'
      : window.navigator.userAgent.includes('Firefox')
        ? 'Firefox'
        : 'Browser';

  return `${browser} on ${platform}`;
};

const getPersistentDeviceId = () => {
  if (typeof window === 'undefined') {
    return 'server-device';
  }

  if (deviceIdCache) {
    return deviceIdCache;
  }

  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      deviceIdCache = existing;
      return existing;
    }
  } catch {
    // Fall back to an in-memory device id when storage is temporarily unavailable.
  }

  const next = globalThis.crypto?.randomUUID?.() || `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  deviceIdCache = next;
  try {
    window.localStorage.setItem(DEVICE_ID_KEY, next);
  } catch {
    // Keep the generated id in memory so the current browser/device stays stable.
  }
  return next;
};

const getPlaybackTabId = () => {
  if (typeof window === 'undefined') {
    return 'server-playback-tab';
  }

  if (playbackTabIdCache) {
    return playbackTabIdCache;
  }

  try {
    const existing = window.sessionStorage.getItem(PLAYBACK_TAB_ID_KEY);
    if (existing) {
      playbackTabIdCache = existing;
      return existing;
    }
  } catch {
    // Fall back to an in-memory per-tab id when sessionStorage is not available.
  }

  const next = globalThis.crypto?.randomUUID?.() || `playback_tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  playbackTabIdCache = next;
  try {
    window.sessionStorage.setItem(PLAYBACK_TAB_ID_KEY, next);
  } catch {
    // Keep the generated id in memory for this tab so requests stay consistent.
  }
  return next;
};

const getClientPlatform = () => {
  if (typeof window === 'undefined') {
    return 'server';
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  const userAgentDataPlatform = (window.navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform?.toLowerCase() || '';
  const platform = String(window.navigator.platform || '').toLowerCase();
  const source = `${userAgentDataPlatform} ${platform} ${userAgent}`;

  if (source.includes('android')) return 'android';
  if (source.includes('iphone') || source.includes('ipad') || source.includes('ipod') || source.includes('ios')) return 'ios';
  if (source.includes('mac')) return 'macos';
  if (source.includes('win')) return 'windows';
  if (source.includes('linux')) return 'linux';
  return 'unknown';
};

const getClientBrowser = () => {
  if (typeof window === 'undefined') {
    return 'server';
  }

  const ua = window.navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\/|Opera/.test(ua)) return 'opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && !/Chrome\/|CriOS\/|Edg\//.test(ua)) return 'safari';
  return 'unknown';
};

const getClientAppMode = () => (typeof window !== 'undefined' && (window as Window & { Capacitor?: unknown }).Capacitor)
  ? 'native'
  : 'web';

const readStoredToken = () => {
  if (typeof window === 'undefined') {
    return authToken;
  }

  const persistedToken = window.localStorage.getItem(TOKEN_KEY);
  if (persistedToken) {
    authToken = persistedToken;
    return persistedToken;
  }

  const legacySessionToken = window.sessionStorage.getItem(TOKEN_KEY);
  if (legacySessionToken) {
    window.localStorage.setItem(TOKEN_KEY, legacySessionToken);
    window.sessionStorage.removeItem(TOKEN_KEY);
    authToken = legacySessionToken;
    return legacySessionToken;
  }

  return authToken;
};

const saveToken = (token: string | null) => {
  authToken = token;

  if (typeof window === 'undefined') {
    return;
  }

  if (token) {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.sessionStorage.removeItem(TOKEN_KEY);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
  }
};

const readAuthSessionMeta = (): AuthSessionMeta | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(AUTH_SESSION_META_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<AuthSessionMeta>;
    return {
      userId: parsed.userId ? String(parsed.userId) : null,
      sessionId: parsed.sessionId ? String(parsed.sessionId) : null,
      issuedAt: parsed.issuedAt ? String(parsed.issuedAt) : '',
    };
  } catch {
    return null;
  }
};

const saveAuthSessionMeta = (user?: AuthUser | null) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (!user) {
    window.localStorage.removeItem(AUTH_SESSION_META_KEY);
    return;
  }

  window.localStorage.setItem(AUTH_SESSION_META_KEY, JSON.stringify({
    userId: user._id || null,
    sessionId: user.session || null,
    issuedAt: new Date().toISOString(),
  }));
};

const emitAuthEvent = (event: { type: 'login' | 'logout'; userId?: string | null; sessionId?: string | null }) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({
      ...event,
      issuedAt: new Date().toISOString(),
    }));
    window.localStorage.removeItem(AUTH_EVENT_KEY);
  } catch {
    // Ignore storage event failures and rely on session polling fallback.
  }
};

const buildHeaders = (hasBody: boolean, includeAuth = true) => {
  const token = includeAuth ? readStoredToken() : null;
  const playbackTabId = getPlaybackTabId();

  return {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-edumaster-device-id': getPersistentDeviceId(),
    'x-edumaster-playback-tab-id': playbackTabId,
    'x-edumaster-browser-tab-id': playbackTabId,
    'x-edumaster-client-platform': getClientPlatform(),
    'x-edumaster-client-browser': getClientBrowser(),
    'x-edumaster-app': getClientAppMode(),
  };
};

const buildAuthHeaders = () => {
  const token = readStoredToken();
  const playbackTabId = getPlaybackTabId();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-edumaster-device-id': getPersistentDeviceId(),
    'x-edumaster-playback-tab-id': playbackTabId,
    'x-edumaster-browser-tab-id': playbackTabId,
    'x-edumaster-client-platform': getClientPlatform(),
    'x-edumaster-client-browser': getClientBrowser(),
    'x-edumaster-app': getClientAppMode(),
  };
};

const buildProtectedLessonPlaybackCacheKey = (courseId: string, lessonId: string) =>
  `${String(courseId)}::${String(lessonId)}`;

const readProtectedLessonPlaybackCache = (courseId: string, lessonId: string) => {
  const key = buildProtectedLessonPlaybackCacheKey(courseId, lessonId);
  const cached = protectedLessonPlaybackCache.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    protectedLessonPlaybackCache.delete(key);
    return null;
  }

  return cached.value;
};

const writeProtectedLessonPlaybackCache = (courseId: string, lessonId: string, value: ProtectedLessonPlayback) => {
  protectedLessonPlaybackCache.set(buildProtectedLessonPlaybackCacheKey(courseId, lessonId), {
    value,
    expiresAt: Date.now() + PROTECTED_LESSON_PLAYBACK_CACHE_TTL_MS,
  });
  return value;
};

const invalidateProtectedLessonPlaybackCache = (courseId?: string | null, lessonId?: string | null) => {
  if (!courseId || !lessonId) {
    return;
  }

  protectedLessonPlaybackCache.delete(buildProtectedLessonPlaybackCacheKey(courseId, lessonId));
};

const parsePayload = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const extractErrorMessage = (payload: any, path: string) =>
  payload?.error
  || payload?.message
  || payload?.details?.message
  || `Request failed for ${path}`;

const handleUnauthorized = (payload?: any) => {
  const activeMeta = readAuthSessionMeta();
  saveToken(null);
  saveAuthSessionMeta(null);

  if (typeof window !== 'undefined') {
    const detail = {
      code: payload?.code || 'AUTH_EXPIRED',
      message: payload?.message || 'Session expired. Please sign in again.',
      details: payload?.details || null,
      userId: activeMeta?.userId || null,
      sessionId: activeMeta?.sessionId || null,
    };
    console.warn('[auth-expired]', detail);
    window.dispatchEvent(new CustomEvent('edumaster:auth-expired', {
      detail,
    }));
  }
};

const runDedupedAuthRequest = async <T>(
  key: string,
  requestFn: () => Promise<T>,
): Promise<T> => {
  const existing = authRequestInflight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = requestFn().finally(() => {
    if (authRequestInflight.get(key) === promise) {
      authRequestInflight.delete(key);
    }
  });
  authRequestInflight.set(key, promise);
  return promise;
};

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...buildHeaders(Boolean(options.body), options.includeAuth !== false),
      ...(options.headers || {}),
    },
  });

  const payload = await parsePayload(response);

  if (!response.ok) {
    if (response.status === 401 && options.expireSessionOn401 !== false) {
      handleUnauthorized(payload);
      throw new Error('Session expired. Please sign in again.');
    }
    throw new ApiRequestError(extractErrorMessage(payload, path), {
      status: response.status,
      code: payload?.code || 'REQUEST_FAILED',
      details: payload?.details,
    });
  }

  return payload as T;
};

const rootRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const response = await fetch(resolveRootPath(path), {
    ...options,
    headers: {
      ...buildHeaders(Boolean(options.body), options.includeAuth !== false),
      ...(options.headers || {}),
    },
  });

  const payload = await parsePayload(response);

  if (!response.ok) {
    if (response.status === 401 && options.expireSessionOn401 !== false) {
      handleUnauthorized(payload);
      throw new Error('Session expired. Please sign in again.');
    }
    throw new ApiRequestError(extractErrorMessage(payload, path), {
      status: response.status,
      code: payload?.code || 'REQUEST_FAILED',
      details: payload?.details,
    });
  }

  return payload as T;
};

export const EduService = {
  getToken: () => readStoredToken(),
  getPersistentDeviceId,
  getPlaybackTabId,
  setToken: (token: string | null) => {
    saveToken(token);
    if (!token) {
      saveAuthSessionMeta(null);
    }
  },
  clearToken: () => {
    saveToken(null);
    saveAuthSessionMeta(null);
  },

  register: async (payload: RegisterPayload): Promise<AuthResponse> => {
    const normalizedEmail = String(payload.email || '').trim().toLowerCase();
    return runDedupedAuthRequest(`register:${normalizedEmail}`, async () => {
      const response = await request<AuthResponse>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          ...payload,
          role: 'student',
          device: getClientDeviceLabel(),
        }),
      });
      saveToken(response.token);
      emitAuthEvent({
        type: 'login',
        userId: response.user._id,
        sessionId: response.user.session || null,
      });
      return response;
    });
  },

  updateProfile: async (payload: { name: string; mobileNumber?: string | null }) => {
    return request<{ user: AuthUser }>('/users/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  changePassword: async (payload: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    return request<{ success: boolean; message: string }>('/users/profile/password', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  login: async (email: string, password: string, options: LoginOptions = {}): Promise<AuthResponse> => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const passwordKey = String(password || '');
    const forceLogoutOtherSessions = options.forceLogoutOtherSessions ?? false;
    const device = getClientDeviceLabel();
    return runDedupedAuthRequest(
      `login:${normalizedEmail}:${passwordKey}:${device}:${forceLogoutOtherSessions ? 'force' : 'single'}`,
      async () => {
        const response = await request<AuthResponse>('/auth/login', {
          method: 'POST',
          includeAuth: false,
          expireSessionOn401: false,
          body: JSON.stringify({
            identifier: email,
            password,
            device,
            forceLogoutOtherSessions,
          }),
        });

        saveToken(response.token);
        saveAuthSessionMeta(response.user);
        emitAuthEvent({
          type: 'login',
          userId: response.user._id,
          sessionId: response.user.session || null,
        });
        return response;
      },
    );
  },

  socialLogin: async (provider: 'google' | 'apple', idToken: string, options: LoginOptions = {}): Promise<AuthResponse> => {
    return EduService.firebaseLogin(provider, idToken, options);
  },

  firebaseLogin: async (
    provider: FirebaseAuthProvider,
    idToken: string,
    options: LoginOptions & { name?: string; mobileNumber?: string | null } = {},
  ): Promise<AuthResponse> => {
    const device = getClientDeviceLabel();
    const response = await request<AuthResponse>('/auth/firebase', {
      method: 'POST',
      includeAuth: false,
      expireSessionOn401: false,
      body: JSON.stringify({
        provider,
        idToken,
        device,
        forceLogoutOtherSessions: options.forceLogoutOtherSessions ?? false,
        name: options.name,
        mobileNumber: options.mobileNumber ?? undefined,
      }),
    });

    saveToken(response.token);
    saveAuthSessionMeta(response.user);
    emitAuthEvent({
      type: 'login',
      userId: response.user._id,
      sessionId: response.user.session || null,
    });
    return response;
  },


  restoreSession: async (): Promise<AuthUser | null> => {
    if (!readStoredToken()) {
      return null;
    }

    try {
      const response = await request<{ user: AuthUser }>('/auth/session', {
        expireSessionOn401: false,
      });
      saveAuthSessionMeta(response.user);
      return response.user;
    } catch (error) {
      if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) {
        handleUnauthorized({
          code: error.code || 'AUTH_SESSION_INVALID',
          message: error.message || 'Session expired. Please sign in again.',
          details: error.details || null,
        });
        return null;
      }

      console.warn('[auth-session-restore]', {
        code: error instanceof ApiRequestError ? error.code : 'RESTORE_SESSION_FAILED',
        status: error instanceof ApiRequestError ? error.status : null,
        message: error instanceof Error ? error.message : 'Unable to restore session',
      });
      return null;
    }
  },

  logout: async () => {
    try {
      if (readStoredToken()) {
        await request<{ message: string }>('/auth/logout', { method: 'POST' });
      }
    } finally {
      const activeMeta = readAuthSessionMeta();
      emitAuthEvent({
        type: 'logout',
        userId: activeMeta?.userId || null,
        sessionId: activeMeta?.sessionId || null,
      });
      saveToken(null);
      saveAuthSessionMeta(null);
    }
  },

  getPlatformOverview: async (options: RequestOptions = {}) => {
    const overview = await request<PlatformOverview>('/platform/overview', options);
    return {
      ...overview,
      courses: (overview.courses || []).map(normalizeCourseCard),
      liveClasses: LIVE_CLASSES_ENABLED
        ? (overview.liveClasses || []).filter(isPresent).map(normalizeLiveClass)
        : [],
      dashboard: {
        ...overview.dashboard,
        continueLearning: (overview.dashboard?.continueLearning || []).map(normalizeCourseCard),
      },
    };
  },

  getLiveClasses: async () => {
    if (!LIVE_CLASSES_ENABLED) {
      return { liveClasses: [] };
    }
    const response = await request<{ liveClasses: LiveClass[] }>('/live-classes');
    return { ...response, liveClasses: (response.liveClasses || []).filter(isPresent).map(normalizeLiveClass) };
  },

  getAdminLiveClasses: async () => {
    if (!LIVE_CLASSES_ENABLED) {
      return { liveClasses: [] };
    }
    const response = await request<{ liveClasses: LiveClass[] }>('/live-classes/admin');
    return { ...response, liveClasses: (response.liveClasses || []).filter(isPresent).map(normalizeLiveClass) };
  },

  sendAnnouncement: async (payload: {
    title: string;
    message: string;
    actionUrl?: string | null;
    actionLabel?: string | null;
    payload?: Record<string, unknown>;
  }) => request<{ message: string; notificationsSent: number }>('/notifications/send', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      type: 'announcement',
      audience: 'all',
    }),
  }),

  createLiveClass: async (payload: Partial<LiveClass>) => {
    return request<{ liveClass: LiveClass }>('/live-classes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  uploadLiveClassImage: async (file: File) => {
    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch(resolveRootPath('/backend/api/live-classes/assets/poster'), {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(),
      },
      body: formData,
    });

    const payload = await parsePayload(response);
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || 'Live class image upload failed');
    }

    return {
      ...payload,
      asset: payload?.asset ? { ...payload.asset, url: resolveAbsoluteUrl(payload.asset.url) || payload.asset.url } : payload?.asset,
    } as { asset: { url: string; name?: string | null; mimeType?: string | null; size?: number | null } };
  },

  updateLiveClass: async (liveClassId: string, payload: Partial<LiveClass>) => {
    return request<{ liveClass: LiveClass }>(`/live-classes/${liveClassId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  deleteLiveClass: async (liveClassId: string) => {
    return request<{ liveClassId: string; message: string }>(`/live-classes/${liveClassId}`, {
      method: 'DELETE',
    });
  },

  startLiveClass: async (liveClassId: string) => {
    return request<{ liveClass: LiveClass; session: LiveClassSessionState }>(`/live-classes/${liveClassId}/start`, {
      method: 'POST',
    });
  },

  endLiveClass: async (liveClassId: string) => {
    return request<{ liveClass: LiveClass; session: LiveClassSessionState }>(`/live-classes/${liveClassId}/end`, {
      method: 'POST',
    });
  },

  getLiveClassAccess: async (liveClassId: string) => {
    const access = await request<LiveClassAccess>(`/live-classes/${liveClassId}/access`);
    return normalizeLiveClassAccess(access);
  },

  getLiveClassChat: async (liveClassId: string) => {
    return request<{ messages: LiveClassChatMessage[] }>(`/live-classes/${liveClassId}/chat`);
  },

  postLiveClassChat: async (liveClassId: string, message: string, kind: 'chat' | 'doubt' = 'chat') => {
    return request<{ message: LiveClassChatMessage }>(`/live-classes/${liveClassId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message, kind }),
    });
  },

  getLiveSessionState: async (liveClassId: string) => {
    return request<{ session: LiveClassSessionState }>(`/live-classes/${liveClassId}/session`);
  },

  joinLiveSession: async (liveClassId: string) => {
    return request<{ participant: LiveClassSessionState['participants'][number]; session: LiveClassSessionState }>(`/live-classes/${liveClassId}/session/join`, {
      method: 'POST',
    });
  },

  leaveLiveSession: async (liveClassId: string) => {
    return request<{ session: LiveClassSessionState }>(`/live-classes/${liveClassId}/session/leave`, {
      method: 'POST',
    });
  },

  heartbeatLiveSession: async (liveClassId: string) => {
    return request<{ participant: LiveClassSessionState['participants'][number] }>(`/live-classes/${liveClassId}/session/heartbeat`, {
      method: 'POST',
    });
  },

  updateLiveMediaState: async (liveClassId: string, payload: {
    micMuted?: boolean;
    videoEnabled?: boolean;
    isScreenSharing?: boolean;
  }) => {
    return request<{ participant: LiveClassSessionState['participants'][number] }>(`/live-classes/${liveClassId}/session/media`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateLiveRaisedHand: async (liveClassId: string, raised: boolean) => {
    return request<{ participant: LiveClassSessionState['participants'][number] }>(`/live-classes/${liveClassId}/session/raise-hand`, {
      method: 'POST',
      body: JSON.stringify({ raised }),
    });
  },

  submitLivePollVote: async (liveClassId: string, optionId: string) => {
    return request<{ liveClass: LiveClass; activePoll: NonNullable<LiveClass['activePoll']>; selectedOptionId: string }>(`/live-classes/${liveClassId}/poll/vote`, {
      method: 'POST',
      body: JSON.stringify({ optionId }),
    });
  },

  approveLiveParticipant: async (liveClassId: string, participantUserId: string, approved: boolean) => {
    return request<{ participant: LiveClassSessionState['participants'][number] }>(`/live-classes/${liveClassId}/session/participants/${participantUserId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    });
  },

  muteLiveParticipant: async (liveClassId: string, participantUserId: string, muted: boolean) => {
    return request<{ participant: LiveClassSessionState['participants'][number] }>(`/live-classes/${liveClassId}/session/participants/${participantUserId}/mute`, {
      method: 'POST',
      body: JSON.stringify({ muted }),
    });
  },

  removeLiveParticipant: async (liveClassId: string, participantUserId: string) => {
    return request<{ participant: LiveClassSessionState['participants'][number] }>(`/live-classes/${liveClassId}/session/participants/${participantUserId}/remove`, {
      method: 'POST',
    });
  },

  createLiveEventsStream: (liveClassId: string) => {
    const token = readStoredToken();
    if (!token) {
      throw new Error('Authorization token required');
    }

    return new EventSource(`${API_BASE}/live-classes/${liveClassId}/events?token=${encodeURIComponent(token)}`);
  },

  submitDailyQuiz: async (quizId: string, answers: string[]) => {
    return request<DailyQuizResult>(`/quiz/submit`, {
      method: 'POST',
      body: JSON.stringify({ quizId, answers }),
    });
  },

  submitMockTest: async (testId: string, answers: Record<string, number | number[]>, startedAt: string) => {
    return request<TestAttemptResult>(`/tests/${testId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers, startedAt }),
    });
  },

  listMockTestAttempts: async () => {
    return request<TestAttemptResult[]>('/tests/attempts/me', {
      method: 'GET',
    });
  },

  unlockCourse: async (course: CourseCard) => {
    const endpoint = '/api/razorpay/create-order';
    return rootRequest<{
      order_id?: string;
      amount?: number;
      currency?: string;
      paymentId: string;
      provider: 'razorpay';
    }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        courseId: course._id,
        courseTitle: course.title,
        amount: Math.round(getDiscountedCoursePrice(course) * 100),
        currency: 'INR',
        receipt: `course-${course._id}-${Date.now()}`,
        origin: getCheckoutOrigin(),
      }),
    });
  },

  verifyRazorpayCoursePayment: async (payload: {
    courseId: string;
    paymentId: string;
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => {
    return rootRequest(`/api/razorpay/verify-payment`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  enrollInCourse: async (courseId: string, source = 'direct-access') => {
    return request(`/platform/enroll`, {
      method: 'POST',
      body: JSON.stringify({
        courseId,
        source,
        accessType: 'course',
      }),
    });
  },
  updateWatchProgress: async (
    courseId: string,
    lessonId: string,
    progressPercent: number,
    progressSeconds: number,
    completed: boolean,
    metadata: {
      lessonStage?: 'video' | 'exam' | 'explanation' | null;
      examSubmitted?: boolean | null;
      examSelectedOption?: number | null;
      explanationSeconds?: number | null;
      videoWatchCount?: number | null;
      explanationWatchCount?: number | null;
      durationSeconds?: number | null;
      eventType?: string | null;
      deviceId?: string | null;
      playbackTabId?: string | null;
      requestTimestamp?: string | null;
    } = {},
    requestOptions: RequestInit = {},
  ) => {
    const deviceId = metadata.deviceId ?? getPersistentDeviceId();
    const playbackTabId = metadata.playbackTabId ?? getPlaybackTabId();
    const response = await request(`/platform/watch-progress`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({
        courseId,
        lessonId,
        progressPercent,
        progressSeconds,
        completed,
        lessonStage: metadata.lessonStage ?? null,
        examSubmitted: metadata.examSubmitted ?? null,
        examSelectedOption: metadata.examSelectedOption ?? null,
        explanationSeconds: metadata.explanationSeconds ?? null,
        videoWatchCount: metadata.videoWatchCount ?? null,
        explanationWatchCount: metadata.explanationWatchCount ?? null,
        durationSeconds: metadata.durationSeconds ?? null,
        eventType: metadata.eventType ?? null,
        deviceId,
        playbackTabId,
        requestTimestamp: metadata.requestTimestamp ?? new Date().toISOString(),
      }),
    });

    invalidateProtectedLessonPlaybackCache(courseId, lessonId);
    return response;
  },

  trackPlaybackHeartbeat: async (payload: {
    videoId: string;
    courseId?: string | null;
    lessonId?: string | null;
    videoType?: 'course' | 'explanation' | string | null;
    playbackSessionId: string;
    currentPositionSeconds: number;
    previousPositionSeconds: number;
    durationSeconds: number;
    isPlaying: boolean;
    isPaused?: boolean;
    isBuffering?: boolean;
    playbackRate?: number;
    timestamp?: string;
  }) => {
    const response = await request<{
      message: string;
      accepted: boolean;
      reason: string;
      playbackSessionId?: string;
      outcome: {
        accepted: boolean;
        reason: string;
        countableSeconds: number;
        uniqueSecondsAdded: number;
        repeatSecondsAdded: number;
        revisionBufferSecondsAdded: number;
        completedFullWatch: boolean;
        locked: boolean;
        suspiciousReasons: string[];
      };
      watchState: ProtectedLessonPlayback['watchState'];
      sessionStatus: string;
    }>(`/track`, {
      method: 'POST',
      body: JSON.stringify({
        videoId: payload.videoId,
        courseId: payload.courseId || null,
        lessonId: payload.lessonId || null,
        videoType: payload.videoType || null,
        playbackSessionId: payload.playbackSessionId,
        currentPositionSeconds: payload.currentPositionSeconds,
        previousPositionSeconds: payload.previousPositionSeconds,
        durationSeconds: payload.durationSeconds,
        isPlaying: payload.isPlaying,
        isPaused: payload.isPaused ?? false,
        isBuffering: payload.isBuffering ?? false,
        playbackRate: payload.playbackRate ?? 1,
        timestamp: payload.timestamp || new Date().toISOString(),
      }),
    });

    const shouldInvalidatePlaybackCache = Boolean(
      response?.watchState?.locked
      || String(response?.sessionStatus || '').toLowerCase() === 'locked'
      || response?.outcome?.completedFullWatch,
    );
    if (shouldInvalidatePlaybackCache) {
      invalidateProtectedLessonPlaybackCache(payload.courseId || null, payload.lessonId || null);
    }
    return response;
  },

  trackSuspiciousProtectedContentEvent: async (payload: {
    eventName: string;
    source?: string;
    courseId?: string | null;
    lessonId?: string | null;
    videoId?: string | null;
    videoType?: string | null;
    playbackSessionId?: string | null;
    timestamp?: string;
  }) => {
    return request<{ message: string; accepted: boolean }>(`/track/suspicious`, {
      method: 'POST',
      expireSessionOn401: false,
      body: JSON.stringify({
        eventName: payload.eventName,
        source: payload.source || 'browser-content-protection',
        courseId: payload.courseId || null,
        lessonId: payload.lessonId || null,
        videoId: payload.videoId || null,
        videoType: payload.videoType || null,
        playbackSessionId: payload.playbackSessionId || null,
        timestamp: payload.timestamp || new Date().toISOString(),
      }),
    });
  },

  askAi: async (message: string) => {
    return request<AiResponse>(`/platform/ai/ask`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  },

  generateAssessmentDraft: async (payload: {
    provider?: string;
    contentType: 'mock-test' | 'daily-quiz';
    exam?: string;
    subject?: string;
    topic?: string;
    title?: string;
    type?: string;
    difficulty?: string;
    questionCount?: number;
    durationMinutes?: number;
    negativeMarking?: number;
    quizDate?: string;
    instructions?: string;
  }) => {
    return request<GeneratedAssessmentDraft>(`/platform/ai/generate-assessment`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  createCourse: async (course: Partial<CourseCard>) => {
    return request<CourseCard>(`/courses`, {
      method: 'POST',
      body: JSON.stringify(course),
    });
  },

  updateCourse: async (courseId: string, course: Partial<CourseCard>) => {
    return request<CourseCard>(`/courses/${courseId}`, {
      method: 'PUT',
      body: JSON.stringify(course),
    });
  },

  deleteCourse: async (courseId: string) => {
    return request<{ message: string; courseId: string }>(`/courses/${courseId}`, {
      method: 'DELETE',
    });
  },

  addModuleToCourse: async (
    courseId: string,
    payload: { title: string; description?: string; order?: number },
  ) => {
    return request<{ message: string; module: unknown; course: CourseCard }>(`/courses/${courseId}/modules`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateCourseModule: async (
    courseId: string,
    moduleId: string,
    payload: { title?: string; description?: string; order?: number },
  ) => {
    return request<{ message: string; module: unknown; course: CourseCard }>(`/courses/${courseId}/modules/${moduleId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteCourseModule: async (courseId: string, moduleId: string) => {
    return request<{ message: string; moduleId: string; course: CourseCard }>(`/courses/${courseId}/modules/${moduleId}`, {
      method: 'DELETE',
    });
  },

  addChapterToModule: async (
    courseId: string,
    moduleId: string,
    payload: { title: string; description?: string; order?: number },
  ) => {
    return request<{ message: string; chapter: unknown; course: CourseCard }>(`/courses/${courseId}/modules/${moduleId}/chapters`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateChapterInModule: async (
    courseId: string,
    moduleId: string,
    chapterId: string,
    payload: { title?: string; description?: string; order?: number },
  ) => {
    return request<{ message: string; chapter: unknown; course: CourseCard }>(`/courses/${courseId}/modules/${moduleId}/chapters/${chapterId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteChapterFromModule: async (courseId: string, moduleId: string, chapterId: string) => {
    return request<{ message: string; chapterId: string; course: CourseCard }>(`/courses/${courseId}/modules/${moduleId}/chapters/${chapterId}`, {
      method: 'DELETE',
    });
  },

  createMockTest: async (test: Partial<MockTest>) => {
    return request<MockTest>(`/tests`, {
      method: 'POST',
      body: JSON.stringify(test),
    });
  },

  updateMockTest: async (testId: string, test: Partial<MockTest>) => {
    return request<MockTest>(`/tests/${testId}`, {
      method: 'PUT',
      body: JSON.stringify(test),
    });
  },

  deleteMockTest: async (testId: string) => {
    return request<{ message: string; testId: string }>(`/tests/${testId}`, {
      method: 'DELETE',
    });
  },

  uploadMockTestVideo: async (
    testId: string,
    file: File,
    title: string,
    durationMinutes?: number,
  ) => {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', title);
    formData.append('durationMinutes', String(durationMinutes || 0));

    const response = await fetch(resolveRootPath(`/backend/api/tests/${testId}/video`), {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Upload failed');
    }

    return response.json();
  },

  deleteMockTestVideo: async (testId: string) => {
    return request<{ message: string }>(`/tests/${testId}/video`, {
      method: 'DELETE',
    });
  },

  getMockTestVideoMetadata: async (testId: string) => {
    return request<{ companionVideo: MockTest['companionVideo'] }>(`/tests/${testId}/video`, {
      method: 'GET',
    });
  },

  getProtectedMockTestVideoPlayback: async (testId: string) => {
    return request<ProtectedLessonPlayback>(`/tests/${testId}/video/player`, {
      method: 'GET',
    });
  },

  attachLessonCbt: async (
    courseId: string,
    moduleId: string,
    lessonId: string,
    payload: {
      chapterId?: string | null;
      title: string;
      durationMinutes: number;
      negativeMarking: number;
      questions: unknown[];
    },
  ) => {
    return request<{ message: string; lesson: CourseLesson; course: CourseCard }>(
      `/courses/${courseId}/modules/${moduleId}/lessons/${lessonId}/cbt`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  },

  deleteLessonCbt: async (
    courseId: string,
    moduleId: string,
    lessonId: string,
    payload?: {
      chapterId?: string | null;
    },
  ) => {
    return request<{ message: string; lesson: CourseLesson; course: CourseCard }>(
      `/courses/${courseId}/modules/${moduleId}/lessons/${lessonId}/cbt`,
      {
        method: 'DELETE',
        body: JSON.stringify(payload || {}),
      },
    );
  },

  updateLessonSettings: async (
    courseId: string,
    moduleId: string,
    lessonId: string,
    payload: {
      chapterId?: string | null;
      watchLimit?: number;
      watchCompletionPercent?: number;
    },
  ) => {
    return request<{ message: string; lesson: CourseLesson; course: CourseCard }>(
      `/courses/${courseId}/modules/${moduleId}/lessons/${lessonId}/settings`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    );
  },

  uploadCourseEditorialVideo: async (
    courseId: string,
    file: File,
    payload: {
      title: string;
      description?: string;
      weekLabel?: string;
      editorialDate?: string;
      durationMinutes?: number;
    },
  ) => {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', payload.title);
    formData.append('description', payload.description || '');
    formData.append('weekLabel', payload.weekLabel || '');
    formData.append('editorialDate', payload.editorialDate || '');
    formData.append('durationMinutes', String(payload.durationMinutes || 0));

    const response = await fetch(resolveRootPath(`/backend/api/courses/${courseId}/editorials`), {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'Editorial video upload failed');
    }

    return response.json();
  },

  deleteCourseEditorialVideo: async (courseId: string, editorialId: string) => {
    return request<{ message: string; editorialId: string }>(`/courses/${courseId}/editorials/${editorialId}`, {
      method: 'DELETE',
    });
  },

  getProtectedEditorialPlayback: async (courseId: string, editorialId: string) => {
    return request<ProtectedLessonPlayback>(`/courses/${courseId}/editorials/${editorialId}/player`, {
      method: 'GET',
    });
  },

  createQuiz: async (payload: {
    date: string;
    questions: {
      id?: string;
      prompt: string;
      options: string[];
      answer: string;
      explanation: string;
      topic: string;
    }[];
  }) => {
    return request(`/quiz/create`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  uploadQuestions: async (payload: {
    title: string;
    category: string;
    type: string;
    course?: string;
    questions: MockTest['questions'];
  }) => {
    return request(`/admin/upload-questions`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getAdminDashboard: async (params?: AdminPaymentRangeParams) => {
    const searchParams = toSearchParams(params || {});
    return request<AdminDashboardSummary>(`/admin/dashboard${searchParams.size ? `?${searchParams.toString()}` : ''}`);
  },

  getAdminStudentLiveMetrics: async () => request<AdminStudentLiveMetricsSummary>(`/admin/students/live-metrics`),

  listAdminStudents: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    quickFilter?: string;
    sortBy?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<{ items: AdminStudentSummary[]; pagination: AdminPagination }>(`/admin/students?${searchParams.toString()}`);
  },

  listAdminLoginSessions: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<{ summary: AdminLoginSessionSummary; items: AdminLoginSessionRecord[]; pagination: AdminPagination }>(`/admin/login-sessions?${searchParams.toString()}`);
  },

  createAdminStudent: async (payload: {
    name: string;
    email: string;
    mobileNumber?: string;
    password: string;
  }) => {
    return request<AuthUser>(`/admin/students`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getAdminStudentDetails: async (studentId: string) => {
    return request<AdminStudentDetails>(`/admin/students/${studentId}`);
  },

  updateAdminStudent: async (studentId: string, payload: {
    name?: string;
    email?: string;
    mobileNumber?: string;
  }) => {
    return request<AuthUser>(`/admin/students/${studentId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  updateAdminStudentStatus: async (studentId: string, payload: {
    status: string;
    note?: string;
  }) => {
    return request<{ success?: boolean }>(`/admin/students/${studentId}/status`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  resetAdminStudentPassword: async (studentId: string, payload: {
    newPassword: string;
    reason?: string;
  }) => {
    return request<{ success: boolean }>(`/admin/students/${studentId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  forceLogoutAdminStudent: async (studentId: string) => {
    return request<{ success: boolean }>(`/admin/students/${studentId}/force-logout`, {
      method: 'POST',
    });
  },

  clearAdminPlaybackSessions: async (studentId: string) => {
    return request<{ success: boolean }>(`/admin/students/${studentId}/playback-sessions/clear`, {
      method: 'POST',
    });
  },

  resetAdminWatchProgress: async (
    studentId: string,
    stateId: string,
    payload?: { reason?: string; action?: 'full_reset' | 'completed_watches' | 'grace_unlock' },
  ) => {
    return request<{ success: boolean }>(`/admin/students/${studentId}/watch-progress/${stateId}/reset`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  listAdminPurchases: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    studentId?: string;
    courseId?: string;
    paymentStatus?: string;
    accessStatus?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<{ items: AdminPurchaseRecord[]; pagination: AdminPagination }>(`/admin/purchases?${searchParams.toString()}`);
  },

  listAdminCourseAccess: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    studentId?: string;
    courseId?: string;
    paymentStatus?: string;
    accessStatus?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<{ summary: AdminCourseAccessSummary; items: AdminCourseAccessRecord[]; pagination: AdminPagination }>(`/admin/course-access?${searchParams.toString()}`);
  },

  listAdminCourseAccessRules: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    courseId?: string;
    studentId?: string;
    studentScope?: string;
    contentScope?: string;
  }) => {
    const searchParams = toSearchParams(params || {});
    return request<{ items: AdminCourseContentAccessRule[]; pagination: AdminPagination }>(`/admin/course-access/rules?${searchParams.toString()}`);
  },

  upsertAdminCourseAccessRule: async (payload: {
    courseId: string;
    studentScope?: string;
    studentId?: string;
    contentScope?: string;
    moduleId?: string;
    chapterId?: string;
    lessonId?: string;
    access?: string;
    adminNote?: string;
  }) => {
    return request<{ success: boolean; rule: AdminCourseContentAccessRule }>(`/admin/course-access/rules`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteAdminCourseAccessRule: async (ruleId: string) => {
    return request<{ success: boolean; rule: AdminCourseContentAccessRule }>(`/admin/course-access/rules/${ruleId}`, {
      method: 'DELETE',
    });
  },

  listAdminStudentLessonWatchOverrides: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    courseId?: string;
    studentId?: string;
    lessonId?: string;
  }) => {
    const searchParams = toSearchParams(params || {});
    return request<{ items: AdminStudentLessonWatchOverride[]; pagination: AdminPagination }>(`/admin/course-access/watch-overrides?${searchParams.toString()}`);
  },

  upsertAdminStudentLessonWatchOverride: async (payload: {
    courseId: string;
    studentId: string;
    moduleId?: string;
    chapterId?: string;
    lessonId?: string;
    allowedFullWatches: number;
    watchCompletionPercent?: number;
    bulkScope?: string;
    adminNote?: string;
  }) => {
    return request<{ success: boolean; overrides: AdminStudentLessonWatchOverride[]; savedCount: number }>(`/admin/course-access/watch-overrides`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteAdminStudentLessonWatchOverride: async (overrideId: string) => {
    return request<{ success: boolean; override: AdminStudentLessonWatchOverride }>(`/admin/course-access/watch-overrides/${overrideId}`, {
      method: 'DELETE',
    });
  },

  assignAdminCourse: async (payload: {
    studentId: string;
    courseId: string;
    validUntil?: string;
    adminNote?: string;
  }) => {
    return request<{ success: boolean }>(`/admin/purchases/assign-course`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateAdminPurchase: async (purchaseId: string, payload: {
    accessStatus?: string;
    validUntil?: string;
    paymentStatus?: string;
    transactionId?: string;
    adminNote?: string;
  }) => {
    return request<{ success: boolean }>(`/admin/purchases/${purchaseId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  removeAdminCourseAccess: async (payload: {
    studentId: string;
    courseId: string;
    adminNote?: string;
  }) => {
    return request<{ success: boolean }>(`/admin/purchases/remove-course`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  diagnoseAdminCourseAccess: async (params: {
    studentId: string;
    courseId?: string;
    transactionId?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<AdminAccessDiagnosis>(`/admin/access/diagnose?${searchParams.toString()}`);
  },

  repairAdminCourseAccess: async (payload: {
    studentId: string;
    courseId?: string;
    transactionId?: string;
    adminNote?: string;
  }) => {
    return request<AdminRepairResult>(`/admin/access/repair`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  listAdminTransactions: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    courseId?: string;
    paymentStatus?: string;
    manualReviewOnly?: boolean;
  } & AdminPaymentRangeParams) => {
    const searchParams = toSearchParams(params || {});
    return request<{ items: AdminTransactionRecord[]; pagination: AdminPagination }>(`/admin/transactions?${searchParams.toString()}`);
  },

  getAdminPaymentReconciliation: async (params?: AdminPaymentRangeParams) => {
    const searchParams = toSearchParams(params || {});
    return request<AdminPaymentReconciliationReport>(`/admin/payments/reconciliation?${searchParams.toString()}`);
  },

  listAdminManualReviewQueue: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<{ summary: AdminManualReviewSummary; items: AdminManualReviewRecord[]; pagination: AdminPagination }>(`/admin/manual-review?${searchParams.toString()}`);
  },

  listAdminAuditLogs: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    actionType?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<{ items: AdminAuditLogRecord[]; pagination: AdminPagination }>(`/admin/audit-logs?${searchParams.toString()}`);
  },

  getAdminSystemHealth: async () => {
    return request<AdminSystemHealthSummary>(`/admin/system-health`);
  },

  listAdminLessonDoubts: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    courseId?: string;
    lessonId?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<AdminLessonDoubtListResponse>(`/courses/admin/lesson-doubts?${searchParams.toString()}`);
  },

  replyAdminLessonDoubt: async (threadId: string, payload: { message: string; attachments?: SupportAttachment[] }) => {
    return request<{ message: string; thread: LessonDoubtThread; notificationsSent: number }>(`/courses/admin/lesson-doubts/${threadId}/reply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateAdminLessonDoubtStatus: async (threadId: string, payload: { status: string; reason?: string }) => {
    return request<{ message: string; thread: LessonDoubtThread }>(`/courses/admin/lesson-doubts/${threadId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  listAdminLessonReports: async (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    courseId?: string;
    lessonId?: string;
    issueType?: string;
  }) => {
    const searchParams = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    });
    return request<AdminLessonReportListResponse>(`/courses/admin/reports?${searchParams.toString()}`);
  },

  updateAdminLessonReport: async (reportId: string, payload: { status?: string; adminNote?: string; adminReply?: string; adminAttachments?: SupportAttachment[]; reason?: string }) => {
    return request<{ message: string; report: LessonReportRecord }>(`/courses/admin/reports/${reportId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  updateAdminTransaction: async (paymentId: string, payload: {
    status?: string;
    transactionId?: string;
    adminNote?: string;
    manualReviewRequired?: boolean;
    verificationDecision?: string;
    verificationReason?: string;
  }) => {
    return request<{ success: boolean }>(`/admin/transactions/${paymentId}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },

  syncAdminRazorpayPayment: async (payload: {
    paymentId?: string;
    transactionId?: string;
    orderId?: string;
    studentId?: string;
    courseId?: string;
    adminNote?: string;
  }) => {
    return request<AdminRazorpaySyncResult>(`/admin/transactions/sync-razorpay`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  syncAllAdminPendingRazorpayPayments: async (payload?: {
    maxRecords?: number;
    adminNote?: string;
  }) => {
    return request<AdminBulkRazorpaySyncResult>(`/admin/transactions/sync-razorpay-all`, {
      method: 'POST',
      body: JSON.stringify(payload || {}),
    });
  },

  retryPayment: async (paymentId: string) => {
    return request<{ _id: string; paymentUrl: string; status: string; attemptCount: number }>(`/payment/${paymentId}/retry`, {
      method: 'POST',
    });
  },

  // Video upload methods for admin
  uploadVideoToModule: async (
    courseId: string,
    moduleId: string,
    file: File,
    lessonTitle: string,
    durationMinutes?: number,
    isPremium?: boolean,
    chapterId?: string,
    options?: {
      onProgress?: (progress: VideoUploadProgress) => void;
    },
  ) => {
    const onProgress = options?.onProgress;
    const appendSharedFields = (target: FormData) => {
      target.append('lessonTitle', lessonTitle);
      target.append('durationMinutes', String(durationMinutes || 0));
      target.append('isPremium', String(Boolean(isPremium)));
      target.append('lessonType', 'video');
      if (chapterId) {
        target.append('chapterId', chapterId);
      }
    };

    if (file.size <= DIRECT_VIDEO_UPLOAD_LIMIT_BYTES) {
      const formData = new FormData();
      formData.append('video', file);
      appendSharedFields(formData);

      const response = await fetch(resolveRootPath(`/backend/api/courses/${courseId}/modules/${moduleId}/videos`), {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(),
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || 'Upload failed');
      }

      onProgress?.({
        uploadedBytes: file.size,
        totalBytes: file.size,
        chunkIndex: 0,
        totalChunks: 1,
      });

      return response.json();
    }

    const multipartInitResponse = await fetch(resolveRootPath(`/backend/api/courses/${courseId}/modules/${moduleId}/videos/multipart/initiate`), {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        lessonTitle,
        durationMinutes: Number(durationMinutes || 0),
        isPremium: Boolean(isPremium),
        lessonType: 'video',
        chapterId: chapterId || '',
        originalFilename: file.name,
        mimeType: file.type || 'video/mp4',
        fileSize: file.size,
      }),
    });

    if (!multipartInitResponse.ok) {
      const error = await multipartInitResponse.json().catch(() => ({}));
      throw new Error(error.message || 'Multipart upload initialization failed');
    }

    const multipartSession = await multipartInitResponse.json() as MultipartVideoUploadSession;
    const uploadSessionId = String(multipartSession.uploadSessionId || '').trim();
    const partSizeBytes = Math.max(Number(multipartSession.partSizeBytes || VIDEO_UPLOAD_CHUNK_SIZE_BYTES), 5 * 1024 * 1024);
    const totalParts = Math.ceil(file.size / partSizeBytes);
    const concurrency = Math.max(1, Math.min(Number(multipartSession.recommendedConcurrency || 4), 6));
    const uploadedBytesByPart = Array.from({ length: totalParts }, () => 0);
    const updateAggregateProgress = (partIndex: number, loadedBytes: number) => {
      uploadedBytesByPart[partIndex] = Math.min(Math.max(0, loadedBytes), file.slice(partIndex * partSizeBytes, Math.min((partIndex + 1) * partSizeBytes, file.size)).size);
      onProgress?.({
        uploadedBytes: uploadedBytesByPart.reduce((sum, current) => sum + current, 0),
        totalBytes: file.size,
        chunkIndex: partIndex,
        totalChunks: totalParts,
      });
    };

    if (!uploadSessionId) {
      throw new Error('Multipart upload initialization did not return an upload session id.');
    }

    try {
      let nextPartIndex = 0;
      const uploadPartWorker = async () => {
        while (nextPartIndex < totalParts) {
          const currentPartIndex = nextPartIndex;
          nextPartIndex += 1;
          const partNumber = currentPartIndex + 1;
          const start = currentPartIndex * partSizeBytes;
          const end = Math.min(start + partSizeBytes, file.size);
          const partBlob = file.slice(start, end, file.type || 'application/octet-stream');

          const partUrlResponse = await fetch(resolveRootPath(`/backend/api/courses/${courseId}/modules/${moduleId}/videos/multipart/${encodeURIComponent(uploadSessionId)}/part-url`), {
            method: 'POST',
            headers: {
              ...buildAuthHeaders(),
              'content-type': 'application/json',
            },
            body: JSON.stringify({ partNumber }),
          });

          if (!partUrlResponse.ok) {
            const error = await partUrlResponse.json().catch(() => ({}));
            throw new Error(error.message || `Failed to get upload URL for part ${partNumber}`);
          }

          const { uploadUrl } = await partUrlResponse.json() as { uploadUrl?: string };
          if (!uploadUrl) {
            throw new Error(`Upload URL missing for part ${partNumber}`);
          }

          await uploadBlobToSignedUrl(uploadUrl, partBlob, (loadedBytes) => {
            updateAggregateProgress(currentPartIndex, loadedBytes);
          });
          updateAggregateProgress(currentPartIndex, partBlob.size);
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, totalParts) }, () => uploadPartWorker()));

      const multipartCompleteResponse = await fetch(resolveRootPath(`/backend/api/courses/${courseId}/modules/${moduleId}/videos/multipart/${encodeURIComponent(uploadSessionId)}/complete`), {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(),
        },
      });

      if (!multipartCompleteResponse.ok) {
        const error = await multipartCompleteResponse.json().catch(() => ({}));
        throw new Error(error.message || 'Multipart upload completion failed');
      }

      onProgress?.({
        uploadedBytes: file.size,
        totalBytes: file.size,
        chunkIndex: totalParts - 1,
        totalChunks: totalParts,
      });

      return multipartCompleteResponse.json();
    } catch (error) {
      await fetch(resolveRootPath(`/backend/api/courses/${courseId}/modules/${moduleId}/videos/multipart/${encodeURIComponent(uploadSessionId)}`), {
        method: 'DELETE',
        headers: {
          ...buildAuthHeaders(),
        },
      }).catch(() => undefined);
      throw error;
    }
  },

  getProtectedLessonPlayback: async (courseId: string, lessonId: string, options: { forceRefresh?: boolean } = {}) => {
    const { forceRefresh = false } = options;
    const key = buildProtectedLessonPlaybackCacheKey(courseId, lessonId);

    if (!forceRefresh) {
      const cached = readProtectedLessonPlaybackCache(courseId, lessonId);
      if (cached) {
        return cached;
      }

      const inflight = protectedLessonPlaybackInflight.get(key);
      if (inflight) {
        return inflight;
      }
    }

    const playbackPromise = request<ProtectedLessonPlayback>(`/courses/${courseId}/lessons/${lessonId}/player`, {
      method: 'GET',
    })
      .then((playback) => writeProtectedLessonPlaybackCache(courseId, lessonId, normalizeProtectedLessonPlayback(playback)))
      .finally(() => {
        protectedLessonPlaybackInflight.delete(key);
      });

    protectedLessonPlaybackInflight.set(key, playbackPromise);
    return playbackPromise;
  },

  prefetchProtectedLessonPlayback: async (courseId: string, lessonId: string) => {
    try {
      await EduService.getProtectedLessonPlayback(courseId, lessonId);
    } catch {
      // Prefetch should stay best-effort.
    }
  },

  getProtectedLessonBootstrap: async (courseId: string, lessonId: string) => {
    const response = await request<{
      course: CourseCard;
      lessons: CourseLesson[];
      lesson: CourseLesson | null;
      player: ProtectedLessonPlayback;
    }>(`/courses/${courseId}/lessons/${lessonId}/bootstrap`, {
      method: 'GET',
    });

    return {
      course: normalizeCourseCard(response.course),
      lessons: Array.isArray(response.lessons) ? response.lessons.map(normalizeCourseLesson) : [],
      lesson: response.lesson ? normalizeCourseLesson(response.lesson) : null,
      player: normalizeProtectedLessonPlayback(response.player),
    };
  },

  listLessonDoubts: async (courseId: string, lessonId: string) => {
    return request<{
      viewerRole: 'student' | 'admin';
      lessonPath: string[];
      threads: LessonDoubtThread[];
    }>(`/courses/${courseId}/lessons/${lessonId}/doubts`, {
      method: 'GET',
    });
  },

  postLessonDoubtMessage: async (
    courseId: string,
    lessonId: string,
    payload: { message: string; threadId?: string | null; attachments?: SupportAttachment[] },
  ) => {
    return request<{
      message: string;
      thread: LessonDoubtThread;
      notificationsSent: number;
    }>(`/courses/${courseId}/lessons/${lessonId}/doubts`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  listLessonReports: async (courseId: string, lessonId: string) => {
    return request<{ items: LessonReportRecord[] }>(`/courses/${courseId}/lessons/${lessonId}/reports/my`, {
      method: 'GET',
    });
  },

  postLessonReport: async (
    courseId: string,
    lessonId: string,
    payload: {
      issueType: string;
      description: string;
      pageUrl?: string | null;
      screenshotUrl?: string | null;
      attachmentMeta?: Record<string, unknown>;
      attachments?: SupportAttachment[];
    },
  ) => {
    return request<{ message: string; report: LessonReportRecord }>(`/courses/${courseId}/lessons/${lessonId}/reports`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  uploadLessonSupportMedia: async (courseId: string, lessonId: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await fetch(resolveRootPath(`${API_BASE}/courses/${courseId}/lessons/${lessonId}/support-media`), {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(),
      },
      body: formData,
    });

    const payload = await parsePayload(response);

    if (!response.ok) {
      if (response.status === 401) {
        handleUnauthorized(payload);
        throw new Error('Session expired. Please sign in again.');
      }
      throw new ApiRequestError(extractErrorMessage(payload, `/courses/${courseId}/lessons/${lessonId}/support-media`), {
        status: response.status,
        code: payload?.code || 'REQUEST_FAILED',
        details: payload?.details,
      });
    }

    return payload as { message: string; attachment: SupportAttachment };
  },

  markNotificationRead: async (notificationId: string) => {
    return request<{ message: string; notification: NotificationItem }>(`/notifications/${notificationId}/read`, {
      method: 'PATCH',
    });
  },

  markAllNotificationsRead: async () => {
    return request<{ message: string; updated: number }>(`/notifications/read-all`, {
      method: 'PATCH',
    });
  },

  listVideosInModule: async (courseId: string, moduleId: string, chapterId?: string | null) => {
    const query = chapterId ? `?chapterId=${encodeURIComponent(chapterId)}` : '';
    return request(`/courses/${courseId}/modules/${moduleId}/videos${query}`, {
      method: 'GET',
    });
  },

  deleteVideoFromModule: async (courseId: string, moduleId: string, videoId: string) => {
    return request(`/courses/${courseId}/modules/${moduleId}/videos/${videoId}`, {
      method: 'DELETE',
    });
  },

  retryVideoProcessing: async (courseId: string, moduleId: string, videoId: string, chapterId?: string | null) => {
    const query = chapterId ? `?chapterId=${encodeURIComponent(chapterId)}` : '';
    return request(`/courses/${courseId}/modules/${moduleId}/videos/${videoId}/retry-processing${query}`, {
      method: 'POST',
    });
  },

  getVideoMetadata: async (courseId: string, moduleId: string, videoId: string) => {
    return request(`/courses/${courseId}/modules/${moduleId}/videos/${videoId}`, {
      method: 'GET',
    });
  },

  listCoursePdfAttachments: async (
    courseId: string,
    moduleId: string,
    options: {
      scope?: 'module' | 'chapter' | 'lesson';
      chapterId?: string | null;
      lessonId?: string | null;
    } = {},
  ) => {
    const searchParams = toSearchParams({
      scope: options.scope || 'module',
      chapterId: options.chapterId || '',
      lessonId: options.lessonId || '',
    });
    return request<{ attachments: CoursePdfAttachment[] }>(`/courses/${courseId}/modules/${moduleId}/pdfs?${searchParams.toString()}`, {
      method: 'GET',
    });
  },

  uploadCoursePdfAttachment: async (
    courseId: string,
    moduleId: string,
    file: File,
    payload: {
      title: string;
      scope: 'module' | 'chapter' | 'lesson';
      chapterId?: string | null;
      lessonId?: string | null;
      premium?: boolean;
    },
  ) => {
    const formData = new FormData();
    formData.append('pdf', file, file.name);
    formData.append('title', payload.title);
    formData.append('scope', payload.scope);
    if (payload.chapterId) {
      formData.append('chapterId', payload.chapterId);
    }
    if (payload.lessonId) {
      formData.append('lessonId', payload.lessonId);
    }
    formData.append('premium', payload.premium ? 'true' : 'false');

    const response = await fetch(resolveRootPath(`/backend/api/courses/${courseId}/modules/${moduleId}/pdfs`), {
      method: 'POST',
      headers: {
        ...(readStoredToken() ? { Authorization: `Bearer ${readStoredToken()}` } : {}),
      },
      body: formData,
    });

    const responseText = await response.text();
    let body: any = null;
    try {
      body = responseText ? JSON.parse(responseText) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(body?.error?.message || body?.message || 'PDF upload failed');
    }
    return body as { message: string; attachment: CoursePdfAttachment; course: CourseCard };
  },

  deleteCoursePdfAttachment: async (
    courseId: string,
    moduleId: string,
    attachmentId: string,
    options: {
      scope?: 'module' | 'chapter' | 'lesson';
      chapterId?: string | null;
      lessonId?: string | null;
    } = {},
  ) => {
    const searchParams = toSearchParams({
      scope: options.scope || 'module',
      chapterId: options.chapterId || '',
      lessonId: options.lessonId || '',
    });
    return request<{ message: string; attachmentId: string }>(`/courses/${courseId}/modules/${moduleId}/pdfs/${attachmentId}?${searchParams.toString()}`, {
      method: 'DELETE',
    });
  },

  getProtectedCoursePdfRequest: (courseId: string, attachmentId: string) => ({
    url: resolveRootPath(`/backend/api/courses/${courseId}/pdf-attachments/${attachmentId}/view`),
    headers: buildAuthHeaders(),
  }),
};
