export interface AuthUser {
  _id: string;
  name: string;
  email: string;
  mobileNumber?: string | null;
  role: 'student' | 'admin';
  device?: string | null;
  session?: string | null;
  streak?: number;
  points?: number;
  badges?: { code: string; label: string }[];
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface CourseLesson {
  id: string;
  title: string;
  type: 'youtube' | 'premium' | 'pdf' | 'video' | 'private-video' | string;
  durationMinutes: number;
  cbt?: {
    title?: string;
    durationMinutes?: number;
    negativeMarking?: number;
    questions: MockQuestion[];
  } | null;
  videoUrl?: string;
  notesUrl?: string;
  premium?: boolean;
  locked?: boolean;
  requiresSecurePlayback?: boolean;
  sequentialLocked?: boolean;
  sequentialUnlockReason?: string | null;
  deliveryProfile?: string | null;
  deliveryStrategy?: 'source' | 'hls' | string | null;
  hlsProcessingStatus?: 'queued' | 'processing' | 'ready' | 'failed' | string | null;
  hlsProcessingError?: string | null;
  playbackReady?: boolean;
  streamProvider?: 'cloudflare-stream' | string | null;
  cloudflareStreamUid?: string | null;
  cloudflareStreamStatus?: string | null;
  cloudflareStreamPctComplete?: number | null;
  cloudflareStreamReadyToStream?: boolean | null;
  sourceFallbackAllowed?: boolean;
  targetQualities?: string[];
  watchLimit?: number;
  watchCompletionPercent?: number;
  releaseAt?: string | null;
  securePlaybackRequired?: boolean;
  accessBlockReason?: string | null;
  attachments?: CoursePdfAttachment[];
}

export interface CoursePdfAttachment {
  id: string;
  title: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  premium?: boolean;
  locked?: boolean;
  accessBlockReason?: string | null;
  scope?: 'module' | 'chapter' | 'lesson' | string;
  uploadedAt?: string | null;
  uploadedBy?: string | null;
}

export interface CourseEditorialVideo {
  id: string;
  title: string;
  description?: string | null;
  weekLabel?: string | null;
  editorialDate?: string | null;
  durationMinutes?: number;
  published?: boolean;
  uploadedAt?: string | null;
  uploadedBy?: string | null;
  playbackReady?: boolean;
  hlsProcessingStatus?: string | null;
  watchLimit?: number;
  watchCompletionPercent?: number;
  locked?: boolean;
}

export interface CourseChapter {
  id: string;
  title: string;
  description?: string;
  order?: number;
  locked?: boolean;
  accessBlockReason?: string | null;
  attachments?: CoursePdfAttachment[];
  lessons: CourseLesson[];
}

export interface CourseModule {
  id: string;
  title: string;
  description?: string;
  order?: number;
  attachments?: CoursePdfAttachment[];
  chapters?: CourseChapter[];
  lessons: CourseLesson[];
}

export interface CourseCard {
  _id: string;
  title: string;
  description: string;
  category: string;
  exam: string;
  subject: string;
  level: string;
  price: number;
  offerPercentage?: number;
  validityDays: number;
  thumbnailUrl: string;
  instructor: string;
  officialChannelUrl?: string | null;
  modules: CourseModule[];
  editorials?: CourseEditorialVideo[];
  enrolled?: boolean;
  isPurchased?: boolean;
  paymentStatus?: 'success' | 'failed' | 'pending' | 'refunded' | 'manual' | 'none' | string;
  enrollmentStatus?: 'active' | 'expired' | 'disabled' | 'missing' | string;
  accessStatus?: 'enabled' | 'disabled' | 'expired' | 'pending_access' | 'not_purchased' | string;
  validUntil?: string | null;
  isExpired?: boolean;
  canAccessCourse?: boolean;
  canPlayReleasedVideos?: boolean;
  accessBlockReason?: string | null;
  transactionId?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  gatewayStatus?: string | null;
  verificationStatus?: string | null;
  verificationReason?: string | null;
  expectedAmount?: number | null;
  receivedAmount?: number | null;
  currency?: string | null;
  manualReviewRequired?: boolean;
  accessSource?: string | null;
  courseAccessLabel?: string | null;
  courseVideoAccessMode?: 'free_order' | 'sequential' | string;
  progressPercent?: number;
  continueLesson?: (CourseLesson & { moduleTitle?: string; chapterTitle?: string }) | null;
  continueProgressSeconds?: number;
  lessonCount?: number;
  lessonProgress?: {
    lessonId: string;
    progressPercent: number;
    progressSeconds: number;
    completed: boolean;
    lessonStage?: 'video' | 'exam' | 'explanation';
    examSubmitted?: boolean;
    examSelectedOption?: number | null;
    explanationSeconds?: number;
    videoWatchCount?: number;
    explanationWatchCount?: number;
    updatedAt: string;
  }[];
}

export interface ProtectedLessonPlayback {
  playerType: 'youtube' | 'private-video';
  embedUrl: string | null;
  streamUrl: string | null;
  drmConfig?: ProtectedPlaybackDrmConfig | null;
  fallbackStreamUrl?: string | null;
  fallbackStreamFormat?: 'source' | 'hls' | string | null;
  fallbackReason?: string | null;
  streamFormat?: 'source' | 'hls' | string | null;
  playbackStatus?: 'queued' | 'processing' | 'ready' | 'failed' | string | null;
  deliveryProfile?: string | null;
  availableQualities?: string[];
  statusMessage?: string | null;
  watermarkText: string;
  resumeSeconds: number;
  completed: boolean;
  tokenExpiresAt: string | null;
  drmEnabled: boolean;
  courseId?: string | null;
  videoId?: string | null;
  playbackSessionId?: string | null;
  videoType?: 'course' | 'explanation' | string | null;
  watchLimit?: number | null;
  watchCompletionPercent?: number | null;
  watchState?: VideoWatchStateSummary | null;
  playbackGrantExpiresAt?: string | null;
  playbackGrantRemainingViews?: number | null;
}

export interface VideoWatchStateSummary {
  videoType: 'course' | 'explanation' | string;
  allowedFullWatches: number;
  completedFullWatches: number;
  fullWatchThresholdPercentage: number;
  completionThresholdPercentage?: number;
  currentCycleUniqueWatchedSeconds: number;
  totalUniqueWatchedSeconds: number;
  repeatWatchedSeconds: number;
  revisionBufferSeconds: number;
  revisionBufferUsedSeconds: number;
  remainingRevisionBufferSeconds: number;
  stableEndWindowWatchedSeconds?: number;
  completionProofSatisfied?: boolean;
  completionProofSatisfiedAt?: string | null;
  endStabilityWindowSeconds?: number;
  endStabilitySatisfied?: boolean;
  graceTotalSeconds?: number;
  graceUsedSeconds?: number;
  graceRemainingSeconds?: number;
  replayState?: 'resume_current_cycle' | 'restart_new_cycle' | 'grace_cycle' | 'locked' | string | null;
  locked: boolean;
  lockedAt?: string | null;
}

export interface ProtectedPlaybackDrmConfig {
  enabled: boolean;
  provider: string;
  manifestUrl: string;
  manifestFormat?: 'dash' | 'hls' | string | null;
  licenseServers: Record<string, string>;
  fairplayCertificateUrl?: string | null;
  preferredKeySystem?: string | null;
  captureProtection?: 'drm' | string | null;
}

export interface MockQuestion {
  id: string;
  questionText: string;
  options: string[];
  correctOption?: number;
  correctOptions?: number[];
  explanation?: string;
  marks: number;
  topic: string;
}

export interface TestSeriesCompanionVideo {
  id?: string | null;
  title: string;
  type?: 'private-video' | string;
  durationMinutes?: number;
  uploadedAt?: string | null;
  deliveryProfile?: string | null;
  deliveryStrategy?: 'source' | 'hls' | string | null;
  hlsProcessingStatus?: 'queued' | 'processing' | 'ready' | 'failed' | string | null;
  hlsProcessingError?: string | null;
  sourceFallbackAllowed?: boolean;
  targetQualities?: string[];
  available?: boolean;
}

export interface MockTest {
  _id: string;
  title: string;
  description: string;
  category: string;
  course?: string;
  type: string;
  durationMinutes: number;
  totalMarks: number;
  negativeMarking: number;
  sectionBreakup: { name: string; questions: number }[];
  questions: MockQuestion[];
  companionVideo?: TestSeriesCompanionVideo | null;
}

export interface TestAttemptResult {
  _id: string;
  userId: string;
  testId: string;
  score: number;
  totalMarks: number;
  correctCount: number;
  incorrectCount: number;
  unattemptedCount: number;
  percentile: number;
  rank: number;
  weakTopics: string[];
  strongTopics: string[];
  solutions: {
    questionId: string;
    questionText: string;
    selectedOption: number | null;
    selectedOptions?: number[];
    correctOption: number;
    correctOptions?: number[];
    explanation: string;
    topic: string;
  }[];
  completedAt: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  answer?: string;
  explanation?: string;
  topic: string;
}

export interface DailyQuiz {
  _id: string;
  date: string;
  questions: QuizQuestion[];
}

export interface LeaderboardEntry {
  userId: string;
  name?: string;
  score: number;
  total: number;
  submittedAt: string;
  attempts?: number;
}

export interface QuizReviewItem {
  questionId: string;
  prompt: string;
  selectedAnswer: string;
  correctAnswer: string;
  explanation: string;
  topic: string;
}

export interface DailyQuizState {
  quiz: DailyQuiz;
  leaderboard: LeaderboardEntry[];
  weeklyLeaderboard: LeaderboardEntry[];
  streak: number;
}

export interface LiveClass {
  _id: string;
  linkageType?: 'standalone' | 'course' | 'mock-test' | string | null;
  courseId?: string | null;
  moduleId?: string | null;
  moduleTitle?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  mockTestId?: string | null;
  mockTestTitle?: string | null;
  title: string;
  instructor: string;
  startTime: string;
  durationMinutes: number;
  provider: string;
  mode: 'live' | 'replay' | string;
  status?: 'scheduled' | 'live' | 'ended' | 'cancelled' | string;
  livePlaybackUrl?: string | null;
  livePlaybackType?: 'hls' | 'iframe' | 'source' | 'webrtc' | 'livekit' | 'jitsi' | string | null;
  ingestServerUrl?: string | null;
  ingestStreamKey?: string | null;
  roomName?: string | null;
  embedUrl?: string | null;
  roomUrl?: string | null;
  recordingUrl?: string | null;
  recordingStorageProvider?: string | null;
  recordingStoragePath?: string | null;
  recordingPublishedAt?: string | null;
  recordingExpiresAt?: string | null;
  recordingDurationMinutes?: number | null;
  recordingState?: 'pending' | 'recording' | 'processing' | 'published' | 'disabled' | 'failed' | string | null;
  replayState?: 'pending' | 'processing' | 'replay_ready' | 'disabled' | 'failed' | string | null;
  replayCourseId?: string | null;
  replayLessonId?: string | null;
  chatEnabled: boolean;
  doubtSolving: boolean;
  replayAvailable: boolean;
  attendees: number;
  maxAttendees?: number;
  requiresEnrollment?: boolean;
  joinEnabled?: boolean;
  replayReady?: boolean;
  topicTags: string[];
  posterUrl?: string | null;
  description?: string | null;
  teacherProfile?: LiveTeacherProfile | null;
  sessionNotes?: string[];
  resources?: LiveClassResource[];
  activePoll?: LiveClassPoll | null;
}

export interface LiveTeacherProfile {
  name?: string | null;
  role?: string | null;
  experience?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}

export interface LiveClassResource {
  id: string;
  title: string;
  type?: string | null;
  url?: string | null;
  description?: string | null;
  lines?: string[];
}

export interface LiveClassPollOption {
  id: string;
  text: string;
  votes?: number;
}

export interface LiveClassPoll {
  question: string;
  status?: 'draft' | 'live' | 'closed' | string;
  options: LiveClassPollOption[];
  responses?: Record<string, string>;
  totalVotes?: number;
}

export interface LiveClassChatMessage {
  _id: string;
  liveClassId: string;
  userId: string;
  userName: string;
  kind: 'chat' | 'doubt' | string;
  message: string;
  createdAt: string;
}

export interface LiveSessionParticipant {
  userId: string;
  name: string;
  role: 'student' | 'admin' | string;
  joinedAt: string;
  lastSeenAt: string | null;
  micMuted: boolean;
  videoEnabled: boolean;
  handRaised: boolean;
  handStatus: 'idle' | 'pending' | 'approved' | 'rejected' | string;
  canSpeak: boolean;
  isScreenSharing: boolean;
  isPresenting: boolean;
  removed: boolean;
}

export interface LiveClassSessionState {
  liveClassId: string;
  status: 'scheduled' | 'live' | 'ended' | 'cancelled' | string;
  roomName: string;
  startedAt: string | null;
  endedAt: string | null;
  activePresenterId: string | null;
  participants: LiveSessionParticipant[];
}

export interface LiveClassEventPayload {
  event: string;
  liveClassId: string;
  timestamp: string;
  session?: LiveClassSessionState;
  participant?: LiveSessionParticipant;
  message?: LiveClassChatMessage;
  liveClass?: {
    _id?: string;
    title?: string;
    status?: string | null;
    livePlaybackType?: string | null;
    roomUrl?: string | null;
    embedUrl?: string | null;
    roomName?: string | null;
    provider?: string | null;
    activePoll?: LiveClassPoll | null;
    replayAvailable?: boolean;
  };
}

export interface LiveClassAccess {
  liveClassId: string;
  title: string;
  provider: string;
  mode: string;
  status: string;
  accessType: 'live-stream' | 'embedded-room' | 'jitsi-room' | 'replay-lesson' | 'recording-link' | 'webrtc-live' | 'livekit-room' | 'upcoming' | string;
  streamUrl: string | null;
  streamFormat: 'hls' | 'source' | string | null;
  embedUrl: string | null;
  roomUrl: string | null;
  liveRoomName?: string | null;
  liveKitUrl?: string | null;
  liveKitToken?: string | null;
  liveKitIdentity?: string | null;
  replayPlayback: ProtectedLessonPlayback | null;
  replayExternalUrl: string | null;
  replayCourseId: string | null;
  replayLessonId: string | null;
  recordingState?: 'pending' | 'recording' | 'processing' | 'published' | 'disabled' | 'failed' | string | null;
  replayState?: 'pending' | 'processing' | 'replay_ready' | 'disabled' | 'failed' | string | null;
  tokenExpiresAt: string | null;
  watermarkText: string | null;
  statusMessage: string;
  playbackGrantRemainingViews?: number | null;
  recordingExpiresAt?: string | null;
}

export interface LiveBroadcastSignal {
  id: string;
  type?: string;
  sdp?: string;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
  createdAt: string;
}

export interface LiveBroadcastViewerState {
  viewerId: string;
  offer: LiveBroadcastSignal | null;
  answer: LiveBroadcastSignal | null;
  adminCandidates: LiveBroadcastSignal[];
  status: string;
  lastSeenAt: string | null;
}

export interface LiveBroadcastAdminState {
  liveClassId: string;
  status: string;
  viewers: Array<{
    viewerId: string;
    userId: string;
    createdAt: string;
    offer: LiveBroadcastSignal | null;
    answer: LiveBroadcastSignal | null;
    adminCandidates: LiveBroadcastSignal[];
    viewerCandidates: LiveBroadcastSignal[];
    lastSeenAt: string | null;
  }>;
}

export interface LiveKitParticipantTrackSummary {
  sid: string;
  name: string;
  type: string;
  muted: boolean;
  source?: string | null;
}

export interface LiveKitParticipantSummary {
  identity: string;
  name: string;
  metadata: string | null;
  attributes: Record<string, string>;
  permission: Record<string, unknown> | null;
  tracks: LiveKitParticipantTrackSummary[];
}

export interface LiveKitParticipantListResponse {
  liveClassId: string;
  roomName: string;
  participants: LiveKitParticipantSummary[];
}

export interface LiveRecordingAdminState {
  liveClassId: string;
  liveClassStatus: string;
  recordingDetails?: {
    recordingUrl: string | null;
    recordingStorageProvider: string | null;
    recordingStoragePath: string | null;
    recordingPublishedAt: string | null;
    recordingExpiresAt: string | null;
    recordingDurationMinutes: number | null;
    replayCourseId: string | null;
    replayLessonId: string | null;
  } | null;
  recording: {
    liveClassId: string;
    status: 'recording' | 'finalizing' | 'published' | 'failed' | string;
    sourceUrl: string | null;
    startedAt: string | null;
    stoppedAt: string | null;
    published: boolean;
    publishedResult: {
      published: boolean;
      reason?: string;
      courseId?: string;
      lessonId?: string;
      storagePath?: string;
      storageProvider?: string;
    } | null;
    exitCode: number | null;
    error: string | null;
    hasOutput: boolean;
  } | null;
}

export interface LiveChatMessage {
  _id: string;
  liveClassId: string;
  userId: string;
  userName: string;
  kind: 'chat' | 'doubt' | string;
  message: string;
  createdAt: string;
}

export interface LiveRoomParticipant {
  participantId: string;
  userId: string;
  userName: string;
  role: 'student' | 'admin' | string;
  connected: boolean;
  microphoneOn: boolean;
  videoOn: boolean;
  handRaised: boolean;
  screenSharing: boolean;
  isMutedByHost: boolean;
  joinedAt: string;
  lastSeenAt: string;
  connectionCount: number;
}

export interface LiveRoomSnapshot {
  liveClassId: string;
  status: string;
  version: number;
  updatedAt: string;
  participantCount: number;
  handRaisedCount: number;
  participants: LiveRoomParticipant[];
  recentMessages: LiveChatMessage[];
}

export interface LiveRoomEvent {
  type: 'room_snapshot' | 'class_started' | 'class_ended' | 'user_joined' | 'user_left' | 'participant_state' | 'chat_message' | string;
  liveClassId: string;
  version?: number;
  createdAt?: string;
  actorId?: string | null;
  actorName?: string | null;
  participant?: Partial<LiveRoomParticipant> | null;
  participantId?: string | null;
  message?: LiveChatMessage | null;
  snapshot?: LiveRoomSnapshot | null;
}

export interface SubscriptionPlan {
  _id: string;
  title: string;
  description: string;
  price: number;
  billingCycle: string;
  accessType?: string;
  active?: boolean;
  features: string[];
}

export interface NotificationItem {
  _id: string;
  userId?: string;
  title: string;
  message: string;
  type: string;
  entityId?: string | null;
  actionUrl?: string | null;
  actionLabel?: string | null;
  payload?: Record<string, unknown>;
  isRead?: boolean;
  readAt?: string | null;
  createdAt: string;
}

export interface LessonDoubtMessage {
  _id: string;
  threadId: string;
  userId: string;
  role: 'student' | 'admin' | string;
  userName: string;
  message: string;
  attachments?: SupportAttachment[];
  createdAt: string;
}

export interface SupportAttachment {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file' | string;
  url: string;
  fileName: string;
  mimeType?: string | null;
  fileSize?: number | null;
  uploadedAt?: string | null;
  uploadedByRole?: 'student' | 'admin' | string;
}

export interface LessonDoubtThread {
  _id: string;
  courseId: string;
  lessonId: string;
  studentUserId: string;
  studentName: string;
  studentEmail?: string | null;
  courseTitle: string;
  moduleTitle?: string | null;
  chapterTitle?: string | null;
  lessonTitle: string;
  status: 'open' | 'answered' | string;
  lastMessagePreview: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  pathLabel: string;
  messages: LessonDoubtMessage[];
}

export interface LessonReportRecord {
  _id: string;
  userId: string;
  courseId: string;
  lessonId: string;
  videoId?: string | null;
  userName: string;
  userEmail?: string | null;
  courseTitle: string;
  moduleTitle?: string | null;
  chapterTitle?: string | null;
  lessonTitle: string;
  issueType: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'rejected' | string;
  screenshotUrl?: string | null;
  attachmentMeta?: Record<string, unknown>;
  attachments?: SupportAttachment[];
  adminAttachments?: SupportAttachment[];
  adminNote?: string | null;
  adminReply?: string | null;
  source?: string | null;
  pageUrl?: string | null;
  userAgent?: string | null;
  pathLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminLessonDoubtListResponse {
  items: LessonDoubtThread[];
  pagination: AdminPagination;
}

export interface AdminLessonReportListResponse {
  items: LessonReportRecord[];
  pagination: AdminPagination;
}

export interface AnalyticsSnapshot {
  accuracy: number;
  speed: number;
  attempts: number;
  weakTopics: string[];
  strongTopics: string[];
  suggestions: string[];
  seriesPerformance: AnalyticsSeriesPerformance[];
  trend: {
    label: string;
    score: number;
    accuracy: number;
  }[];
  adaptivePlan: {
    nextTestType: string;
    difficulty: string;
    reason: string;
  };
}

export interface AnalyticsConceptPerformance {
  topic: string;
  sectionName: string;
  accuracy: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  totalQuestions: number;
  attempts: number;
  status: 'weak' | 'watch' | 'strong';
  subjectTitle?: string | null;
  moduleTitle?: string | null;
  chapterTitle?: string | null;
  lessonTitle?: string | null;
  pathLabel?: string | null;
}

export interface AnalyticsSectionPerformance {
  name: string;
  accuracy: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  totalQuestions: number;
  attempts: number;
  status: 'weak' | 'watch' | 'strong';
  weakConcepts: AnalyticsConceptPerformance[];
  strongConcepts: AnalyticsConceptPerformance[];
}

export interface AnalyticsSeriesPerformance {
  id: string;
  title: string;
  courseId?: string | null;
  courseTitle?: string | null;
  exam?: string | null;
  attempts: number;
  linkedTests: number;
  lastAttemptedAt: string | null;
  overallAccuracy: number;
  averageScore: number;
  totalMarks: number;
  correct: number;
  incorrect: number;
  unattempted: number;
  status: 'weak' | 'watch' | 'strong';
  sections: AnalyticsSectionPerformance[];
  focusConcepts: AnalyticsConceptPerformance[];
  healthyConcepts: AnalyticsConceptPerformance[];
}

export interface DeviceActivity {
  _id: string;
  userId: string;
  sessionId: string | null;
  device: string | null;
  eventType: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface LoginSession {
  _id: string;
  userId: string;
  sessionId: string;
  device: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
  lastSeenAt: string;
  endedAt: string | null;
}

export interface AdminOverview {
  activeUsers: number;
  activeSessions: number;
  totalCourses: number;
  totalTests: number;
  liveClasses: number;
  notificationsSent: number;
  referralCount: number;
  paymentCount: number;
  testParticipation: number;
  revenue: number;
  concurrentCapacityTarget: string;
  recentDeviceActivity: DeviceActivity[];
}

export interface AdminPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminStudentSummary {
  studentId: string;
  name: string;
  email: string;
  mobileNumber?: string | null;
  accountStatus: 'active' | 'disabled' | 'blocked' | string;
  statusNote?: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastActiveAt?: string | null;
  lastLogoutAt?: string | null;
  loggedInNow?: boolean;
  deviceSessionStatus: 'active' | 'inactive' | string;
  enrolledCoursesCount: number;
  activeCourseAccessCount?: number;
  testAttemptsCount: number;
  manualReviewCount?: number;
  deviceCount?: number;
  latestPaymentId?: string | null;
  latestPaymentStatus?: string | null;
  latestPaymentTransactionId?: string | null;
  latestPaymentOrderId?: string | null;
  latestPaymentGatewayPaymentId?: string | null;
  latestPaymentCourseName?: string | null;
  latestPaymentVerificationStatus?: string | null;
  latestPaymentCreatedAt?: string | null;
  latestDeviceLabel?: string | null;
  paymentSummary: {
    successful: number;
    failed: number;
    pending: number;
  };
}

export interface AdminPurchaseRecord {
  purchaseId: string;
  paymentId?: string | null;
  studentId: string | null;
  studentName: string;
  studentEmail: string | null;
  studentMobile?: string | null;
  courseId: string | null;
  courseName: string;
  transactionId?: string | null;
  paymentGatewayName?: string | null;
  paymentAmount?: number | null;
  courseFee?: number | null;
  paymentStatus: 'success' | 'failed' | 'pending' | 'refunded' | 'manual' | string;
  purchaseDate: string | null;
  courseStartDate?: string | null;
  validUntil?: string | null;
  accessStatus: 'enabled' | 'disabled' | 'expired' | 'pending_access' | 'removed' | string;
  paymentProof?: string | null;
  accessSource?: string | null;
  createdAt: string | null;
  updatedAt?: string | null;
  adminNote?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  gatewayStatus?: string | null;
  verificationStatus?: string | null;
  verificationReason?: string | null;
}

export interface AdminTransactionRecord {
  paymentId: string;
  transactionId: string;
  studentId: string;
  studentName: string;
  studentEmail: string | null;
  studentMobile?: string | null;
  courseId?: string | null;
  courseName?: string | null;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentGatewayResponse: Record<string, unknown>;
  paymentStatus: 'paid' | 'failed' | 'pending' | 'refunded' | string;
  paymentDateTime: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  gatewayStatus?: string | null;
  verificationDecision?: string | null;
  verificationReason?: string | null;
  expectedAmount?: number | null;
  receivedAmount?: number | null;
  bankRrn?: string | null;
  capturedAt?: string | null;
  signatureVerified: boolean;
  failureReason?: string | null;
  refundStatus?: string | null;
  disputeStatus?: string | null;
  accessSource?: string | null;
  manualReviewRequired?: boolean;
  lastSyncedAt?: string | null;
  accessStatus?: string | null;
  validUntil?: string | null;
  courseAccessLabel?: string | null;
}

export interface AdminLoginSessionRecord {
  sessionId: string;
  studentId: string;
  studentName: string;
  email?: string | null;
  mobileNumber?: string | null;
  loginTime?: string | null;
  logoutTime?: string | null;
  lastActiveTime?: string | null;
  deviceId?: string | null;
  browser?: string | null;
  os?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionStatus: 'online' | 'offline' | string;
  rawStatus?: string | null;
  reason?: string | null;
}

export interface AdminLoginSessionSummary {
  loggedInNow: number;
  recentLogins: number;
  recentLogouts: number;
  failedLoginAttempts: number;
  multipleDeviceLoginCount: number;
}

export interface AdminCourseAccessRecord {
  studentId: string | null;
  studentName: string;
  email?: string | null;
  mobileNumber?: string | null;
  courseId: string | null;
  courseName: string;
  accessSource: string;
  accessStatus: string;
  validUntil?: string | null;
  paymentStatus: string;
  verificationStatus?: string | null;
  canAccessCourse: boolean;
  accessBlockReason?: string | null;
  adminNote?: string | null;
  paymentId?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
}

export interface AdminCourseAccessSummary {
  activeAccessCount: number;
  expiredAccessCount: number;
  disabledAccessCount: number;
  manuallyGrantedAccessCount: number;
  paymentLinkedAccessCount: number;
}

export interface AdminCourseContentAccessRule {
  ruleId: string;
  courseId: string;
  courseTitle: string;
  studentScope: 'all_students' | 'student' | string;
  studentId?: string | null;
  studentName?: string | null;
  studentEmail?: string | null;
  contentScope: 'course' | 'chapter' | 'lesson' | string;
  moduleId?: string | null;
  moduleTitle?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  lessonId?: string | null;
  lessonTitle?: string | null;
  access: 'allow' | 'block' | string;
  adminNote?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AdminStudentLessonWatchOverride {
  overrideId: string;
  courseId: string;
  courseTitle: string;
  studentId: string;
  studentName?: string | null;
  studentEmail?: string | null;
  moduleId: string;
  moduleTitle?: string | null;
  chapterId?: string | null;
  chapterTitle?: string | null;
  lessonId: string;
  lessonTitle?: string | null;
  allowedFullWatches: number;
  watchCompletionPercent?: number | null;
  adminNote?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AdminManualReviewRecord {
  paymentId: string;
  studentId: string;
  studentName: string;
  email?: string | null;
  mobileNumber?: string | null;
  courseId?: string | null;
  courseName?: string | null;
  amountExpected: number;
  amountReceived: number;
  localOrderId: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  verificationDecision?: string | null;
  reason?: string | null;
  adminNote?: string | null;
  createdTime?: string | null;
  refundStatus?: string | null;
  disputeStatus?: string | null;
  status: string;
}

export interface AdminManualReviewSummary {
  total: number;
  amountMismatch: number;
  orderMismatch: number;
  userMismatch: number;
  courseMismatch: number;
  localTransactionNotFound: number;
  refundedOrDisputed: number;
}

export interface AdminRazorpaySyncResult {
  success: boolean;
  summary: {
    paymentFound: boolean;
    paymentId?: string | null;
    transactionId?: string | null;
    orderId?: string | null;
    gatewayStatus?: string | null;
    localStatus?: string | null;
    verificationDecision?: string | null;
    verificationReason?: string | null;
    method?: string | null;
    expectedAmount?: number | null;
    receivedAmount?: number | null;
    currency?: string | null;
    bankRrn?: string | null;
    enrollmentCreated: boolean;
    accessEnabled: boolean;
    validityUpdated: boolean;
    cacheRefreshed: boolean;
    manualReviewRequired?: boolean;
    courseAccessLabel?: string | null;
  };
  diagnosis?: AdminAccessDiagnosis | null;
}

export interface AdminBulkRazorpaySyncResult {
  totalChecked: number;
  capturedFixed: number;
  verifiedCapturedActivated?: number;
  stillPending: number;
  failed: number;
  refunded: number;
  amountMismatch?: number;
  orderMismatch?: number;
  userMismatch?: number;
  courseMismatch?: number;
  manualReviewRequired?: number;
  enrollmentCreated: number;
  accessEnabled: number;
  cacheRefreshed: number;
  errors: Array<{
    paymentId?: string | null;
    orderId?: string | null;
    message: string;
  }>;
  items: Array<{
    paymentId?: string | null;
    orderId?: string | null;
    gatewayPaymentId?: string | null;
    status: string;
    verificationDecision?: string | null;
    courseId?: string | null;
    userId?: string | null;
  }>;
}

export interface AdminAuditLogRecord {
  _id: string;
  adminUserId: string;
  adminUserName?: string;
  actionType: string;
  targetUserId?: string | null;
  targetUserName?: string | null;
  courseId?: string | null;
  courseName?: string | null;
  transactionId?: string | null;
  oldValue: Record<string, unknown>;
  newValue: Record<string, unknown>;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface AdminWatchProgressRecord {
  stateId: string;
  courseId: string;
  courseTitle: string;
  lessonId?: string | null;
  videoId: string;
  videoType: string;
  completedFullWatches: number;
  allowedFullWatches: number;
  currentCycleUniqueWatchedSeconds?: number;
  totalUniqueWatchedSeconds?: number;
  repeatWatchedSeconds?: number;
  revisionBufferUsedSeconds?: number;
  remainingRevisionBufferSeconds?: number;
  stableEndWindowWatchedSeconds?: number;
  completionThresholdPercentage?: number;
  completionProofSatisfied?: boolean;
  completionProofSatisfiedAt?: string | null;
  endStabilityWindowSeconds?: number;
  endStabilitySatisfied?: boolean;
  progressSeconds: number;
  lastHeartbeatAt?: string | null;
  activeSessionStatus: string;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  locked: boolean;
  updatedAt?: string | null;
}

export interface AdminTestAttemptSummary {
  attemptId: string;
  testId: string;
  testName: string;
  score: number;
  totalMarks: number;
  correctCount: number;
  wrongCount: number;
  skippedCount: number;
  status: string;
  startedAt?: string | null;
  submittedAt?: string | null;
  analysisAvailable: boolean;
}

export interface AdminStudentSupportIssueSummary {
  issueId: string;
  issueType: 'lesson_doubt' | 'video_report';
  courseId?: string | null;
  lessonId?: string | null;
  pathLabel: string;
  status: string;
  studentMessage?: string | null;
  adminReply?: string | null;
  adminNote?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AdminStudentDetails {
  student: AuthUser & {
    accountStatus: string;
    statusNote?: string | null;
    lastLoginAt?: string | null;
    created_at?: string;
  };
  purchases: AdminPurchaseRecord[];
  watchProgress: AdminWatchProgressRecord[];
  testAttempts: AdminTestAttemptSummary[];
  supportIssues: AdminStudentSupportIssueSummary[];
  sessions: Array<{
    sessionId: string;
    status: string;
    device?: string | Record<string, unknown> | null;
    reason?: string | null;
    createdAt?: string | null;
    lastSeenAt?: string | null;
    endedAt?: string | null;
  }>;
  deviceActivity: Array<{
    _id: string;
    eventType: string;
    device?: string | Record<string, unknown> | null;
    meta?: Record<string, unknown>;
    createdAt?: string | null;
  }>;
  auditLog: AdminAuditLogRecord[];
}

export interface AdminDashboardSummary {
  totalStudents: number;
  activeStudents: number;
  disabledStudents: number;
  blockedStudents?: number;
  activeStudentsNow?: number;
  loggedInStudentsNow?: number;
  loggedOutStudentsToday?: number;
  totalCoursePurchases: number;
  successfulPayments: number;
  failedPayments: number;
  pendingPayments: number;
  refundedPayments?: number;
  manualReviewPayments?: number;
  capturedInGatewayPendingLocally?: number;
  activeCourseAccessCount: number;
  expiredCourseAccessCount: number;
  studentsCurrentlyWatchingVideos?: number;
  activePlaybackSessions?: number;
  adminGrantedAccessCount?: number;
  backendHealth?: string;
  dbHealth?: string;
  recentTransactions: AdminTransactionRecord[];
  paymentDateRange?: {
    preset: string;
    label: string;
    timezone: string;
    startIso: string;
    endIso: string;
    dbStartIso: string;
    dbEndIso: string;
    razorpayStartIso: string;
    razorpayEndIso: string;
    paymentMode: 'live' | 'test' | string;
    lastReconciliationTime?: string | null;
  };
  paymentOverview?: {
    razorpayCapturedPayments: number;
    localSuccessfulTransactions: number;
    capturedButPendingLocally: number;
    localSuccessButNotVerifiedInRazorpay: number;
    pendingPayments: number;
    failedPayments: number;
    refundedPayments: number;
    manualReviewPayments: number;
    adminGrantedAccess: number;
    activeCourseAccess: number;
    differenceCount: number;
    localVerifiedSuccessfulTransactions?: number;
  };
  paymentReconciliationPreview?: {
    differenceCount: number;
    matchedCapturedPayments: number;
    capturedButPendingLocally: number;
    localSuccessButNotVerifiedInRazorpay: number;
    duplicateLocalSuccessfulTransactions: number;
    wrongDateTimezoneRecords: number;
  };
}

export interface AdminStudentLiveMetricsSummary {
  onlineNow: number;
  loggedOutToday: number;
  activeNow: number;
  refreshedAt: string;
}

export interface AdminPaymentRangeParams {
  rangePreset?: 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'current_month' | 'custom' | 'all_time';
  startDate?: string;
  endDate?: string;
  timezone?: string;
  paymentMode?: 'live' | 'test' | string;
}

export interface AdminPaymentReconciliationRow {
  localTransactionId?: string | null;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  localStatus?: string | null;
  razorpayStatus?: string | null;
  verificationStatus?: string | null;
  amountExpected?: number | null;
  amountReceived?: number | null;
  currency?: string | null;
  student?: string | null;
  course?: string | null;
  createdAt?: string | null;
  capturedAt?: string | null;
  reason?: string | null;
}

export interface AdminPaymentReconciliationReport {
  range: {
    preset: string;
    label: string;
    timezone: string;
    startIso: string;
    endIso: string;
  };
  paymentMode: string;
  lastReconciledAt: string;
  cards: NonNullable<AdminDashboardSummary['paymentOverview']>;
  matchedCapturedPayments: AdminPaymentReconciliationRow[];
  capturedButPendingLocally: AdminPaymentReconciliationRow[];
  localSuccessButNotVerifiedInRazorpay: AdminPaymentReconciliationRow[];
  duplicateLocalSuccessfulTransactions: Array<{
    razorpayPaymentId: string;
    localRows: AdminPaymentReconciliationRow[];
  }>;
  manualGrantsWronglyCountedAsPayments: AdminPaymentReconciliationRow[];
  refundedOrDisputedRecords: AdminPaymentReconciliationRow[];
  wrongDateTimezoneRecords: AdminPaymentReconciliationRow[];
  testModeLiveModeMismatchRecords: AdminPaymentReconciliationRow[];
  amountMismatchRecords: AdminPaymentReconciliationRow[];
  orderMismatchRecords: AdminPaymentReconciliationRow[];
  userMismatchRecords: AdminPaymentReconciliationRow[];
  courseMismatchRecords: AdminPaymentReconciliationRow[];
  localTransactionNotFoundRecords: AdminPaymentReconciliationRow[];
}

export interface AdminSystemHealthSummary {
  backendStatus: string;
  appReplica1Health: string;
  appReplica2Health: string;
  dbStatus: string;
  dbConnections: {
    total: number | null;
    idle: number | null;
    waiting: number | null;
  };
  apiErrorRate: number | null;
  paymentSyncErrorRate: number | null;
  adminActionFailureRate: number | null;
  p95Latency: number | null;
  p99Latency: number | null;
  status502Count: number | null;
  status503Count: number | null;
  status504Count: number | null;
  lastSuccessfulBulkSyncTime?: string | null;
  dependencies?: Record<string, unknown>;
  checkedAt?: string | null;
}

export interface AdminAccessDiagnosis {
  studentId: string;
  studentName: string;
  studentEmail?: string | null;
  studentMobile?: string | null;
  studentAccountStatus?: string | null;
  studentCreatedAt?: string | null;
  studentLastLoginAt?: string | null;
  courseId?: string | null;
  courseName?: string | null;
  paymentSuccess: boolean;
  enrollmentExists: boolean;
  accessEnabled: boolean;
  validityActive: boolean;
  courseIdMatched: boolean;
  userIdMatched: boolean;
  frontendPurchaseFlagExpected: boolean;
  shouldShowBuyButton: boolean;
  shouldShowStartCourse: boolean;
  accessBlockReason?: string | null;
  courseAccessLabel?: string | null;
  reasonStudentSeesBuyButton?: string | null;
  duplicateAccounts: Array<{
    studentId: string;
    name: string;
    email: string;
    mobileNumber?: string | null;
  }>;
  payment?: {
    paymentId: string;
    transactionId?: string | null;
    providerOrderId?: string | null;
    status: string;
    amount: number;
    courseId?: string | null;
    userId?: string | null;
    meta: Record<string, unknown>;
  } | null;
  enrollment?: {
    enrollmentId: string;
    accessStatus: string;
    expiresAt?: string | null;
    source?: string | null;
    adminNote?: string | null;
  } | null;
}

export interface AdminRepairResult {
  success: boolean;
  actions: string[];
  diagnosisBefore: AdminAccessDiagnosis;
  diagnosisAfter: AdminAccessDiagnosis;
  repairSummary: {
    paymentFound: boolean;
    transactionId?: string | null;
    courseName?: string | null;
    enrollmentCreated: boolean;
    accessEnabled: boolean;
    validityUpdated: boolean;
    cacheRefreshed: boolean;
    finalAccessStatus: string;
    studentShouldNowSee: 'Start Course' | 'Continue Learning' | 'Buy' | 'Expired' | 'Access Disabled' | 'Payment Pending' | string;
    repairNote?: string | null;
  };
}

export interface PlatformOverview {
  user: AuthUser | null;
  highlights: {
    concurrencyTarget: string;
    deploymentProfile: string;
    modules: string[];
  };
  dashboard: {
    streak: number;
    points: number;
    accuracy: number;
    speed: number;
    weakTopics: string[];
    strongTopics: string[];
    continueLearning: CourseCard[];
    latestMockTest: TestAttemptResult | null;
  };
  dailyQuiz: DailyQuizState | null;
  courses: CourseCard[];
  testSeries: MockTest[];
  liveClasses: LiveClass[];
  subscriptions: SubscriptionPlan[];
  notifications: NotificationItem[];
  notificationCount?: number;
  analytics: AnalyticsSnapshot;
  ai: {
    headline: string;
    prompts: string[];
    generation?: {
      defaultProvider: string;
      providers: AiGenerationProviderOption[];
    };
  };
  sessionActivity: {
    activeSessions: number;
    recentSessions: LoginSession[];
    recentDeviceActivity: DeviceActivity[];
  } | null;
  adminOverview: AdminOverview | null;
}

export interface SavedTopic {
  courseId: string;
  lessonId: string;
  savedAt: string;
  courseTitle: string;
  lessonTitle: string;
  exam: string;
  thumbnailUrl: string;
  moduleTitle?: string | null;
  chapterTitle?: string | null;
  progressSeconds?: number;
  completed?: boolean;
}

export interface AiResponse {
  _id: string;
  userId: string;
  message: string;
  answer: string;
  createdAt: string;
}

export interface AiGenerationProviderOption {
  id: 'auto' | 'gemini' | 'openai' | 'mock' | string;
  label: string;
  available: boolean;
  mode: 'live' | 'fallback' | 'unavailable' | string;
  description: string;
}

export interface GeneratedAssessmentDraft {
  provider: string;
  model: string;
  mode: 'live' | 'fallback' | string;
  requestedProvider: string;
  contentType: 'mock-test' | 'daily-quiz';
  message: string;
  mockTest: MockTest | null;
  dailyQuiz: {
    date: string;
    questions: {
      id?: string;
      prompt: string;
      options: string[];
      answer: string;
      explanation: string;
      topic: string;
    }[];
  } | null;
}

export interface DailyQuizResult {
  score: number;
  total: number;
  review: QuizReviewItem[];
}

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  mobileNumber?: string;
}
