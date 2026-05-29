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
}

export interface CourseChapter {
  id: string;
  title: string;
  description?: string;
  order?: number;
  lessons: CourseLesson[];
}

export interface CourseModule {
  id: string;
  title: string;
  description?: string;
  order?: number;
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
  enrolled?: boolean;
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
  watchLimit?: number | null;
  watchCompletionPercent?: number | null;
  playbackGrantExpiresAt?: string | null;
  playbackGrantRemainingViews?: number | null;
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
  title: string;
  message: string;
  type: string;
  entityId?: string | null;
  actionUrl?: string | null;
  actionLabel?: string | null;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface LessonDoubtMessage {
  _id: string;
  threadId: string;
  userId: string;
  role: 'student' | 'admin' | string;
  userName: string;
  message: string;
  createdAt: string;
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
