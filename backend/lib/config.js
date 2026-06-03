const path = require('path');

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isPlaceholderValue = (value) => /your-|replace|example\.com|example\.net|placeholder|<[^>]+>/i.test(String(value || '').trim());

const isLiveKitConfiguredValue = (value) => {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }

  return !/your-livekit-host|replace_me/i.test(text);
};

const isConfiguredRuntimeValue = (value) => {
  const text = String(value || '').trim();
  return Boolean(text) && !isPlaceholderValue(text);
};

const DEFAULT_ADMIN_EMAIL = 'admin@local.edumaster';
const DEFAULT_ADMIN_PASSWORD = 'AdminChangeMe_2026';
const DEFAULT_JWT_SECRET = 'dev-only-secret';

const appConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  serviceName: process.env.SERVICE_NAME || 'edumaster-platform',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  host: process.env.HOST || '0.0.0.0',
  port: toNumber(process.env.PORT, 5000),
  logLevel: process.env.LOG_LEVEL || 'info',
  trustProxy: toBool(process.env.TRUST_PROXY, true),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '1mb',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  frontendDistDir: path.join(process.cwd(), 'dist'),
  rateLimitWindowMs: toNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMax: toNumber(process.env.RATE_LIMIT_MAX, 300),
  rateLimitAuthMax: toNumber(process.env.RATE_LIMIT_AUTH_MAX, 120),
  rateLimitAuthIpMax: toNumber(process.env.RATE_LIMIT_AUTH_IP_MAX, 60),
  rateLimitAuthenticatedMax: toNumber(process.env.RATE_LIMIT_AUTHENTICATED_MAX, 1200),
  rateLimitReadMax: toNumber(process.env.RATE_LIMIT_READ_MAX, 1800),
  rateLimitWriteMax: toNumber(process.env.RATE_LIMIT_WRITE_MAX, 900),
  authPasswordHashRounds: toNumber(process.env.AUTH_PASSWORD_HASH_ROUNDS, 10),
  authRegisterMaxConcurrent: toNumber(process.env.AUTH_REGISTER_MAX_CONCURRENT, 4),
  authRegisterMaxQueue: toNumber(process.env.AUTH_REGISTER_MAX_QUEUE, 100),
  authRegisterDbTimeoutMs: toNumber(process.env.AUTH_REGISTER_DB_TIMEOUT_MS, 5_000),
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  adminName: process.env.ADMIN_NAME || 'Platform Admin',
  adminEmail: process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL,
  adminPassword: process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  mongoUri: process.env.MONGODB_URI || '',
  postgresUrl: process.env.POSTGRES_URL || '',
  postgresPoolMax: toNumber(process.env.POSTGRES_POOL_MAX, 20),
  postgresIdleTimeoutMillis: toNumber(process.env.POSTGRES_IDLE_TIMEOUT_MS, 30_000),
  postgresConnectionTimeoutMillis: toNumber(process.env.POSTGRES_CONNECTION_TIMEOUT_MS, 10_000),
  postgresStatementTimeoutMillis: toNumber(process.env.POSTGRES_STATEMENT_TIMEOUT_MS, 15_000),
  platformReadyCacheTtlMs: toNumber(process.env.PLATFORM_READY_CACHE_TTL_MS, 60_000),
  platformDataCacheTtlMs: toNumber(process.env.PLATFORM_DATA_CACHE_TTL_MS, 30_000),
  courseCacheTtlMs: toNumber(process.env.COURSE_CACHE_TTL_MS, 15_000),
  cachePrefix: process.env.CACHE_PREFIX || 'varonenglish',
  testsCacheTtlMs: toNumber(process.env.TESTS_CACHE_TTL_MS, 15_000),
  analyticsCacheTtlMs: toNumber(process.env.ANALYTICS_CACHE_TTL_MS, 5_000),
  userAnalyticsCacheTtlMs: toNumber(process.env.USER_ANALYTICS_CACHE_TTL_MS, 10_000),
  watchProgressCacheInvalidationIntervalMs: toNumber(process.env.WATCH_PROGRESS_CACHE_INVALIDATION_INTERVAL_MS, 300_000),
  watchProgressCacheInvalidationPercentStep: toNumber(process.env.WATCH_PROGRESS_CACHE_INVALIDATION_PERCENT_STEP, 25),
  quizCacheTtlMs: toNumber(process.env.QUIZ_CACHE_TTL_MS, 3_000),
  notificationsCacheTtlMs: toNumber(process.env.NOTIFICATIONS_CACHE_TTL_MS, 10_000),
  firebaseStateStorage: toBool(process.env.FIREBASE_STATE_STORAGE, false),
  firebaseStateDatabaseId: process.env.FIREBASE_STATE_DATABASE_ID || '',
  firebaseStateCollection: process.env.FIREBASE_STATE_COLLECTION || 'app_state',
  firebaseStateDocument: process.env.FIREBASE_STATE_DOCUMENT || 'primary',
  redisUrl: process.env.REDIS_URL || '',
  storageBucket: process.env.S3_BUCKET || '',
  storageRegion: process.env.S3_REGION || '',
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  s3ForcePathStyle: toBool(process.env.S3_FORCE_PATH_STYLE, false),
  privateVideoStorageKeyPrefix: String(process.env.PRIVATE_VIDEO_STORAGE_KEY_PREFIX || '').trim(),
  stagingAllowSharedProdStorage: toBool(process.env.STAGING_ALLOW_SHARED_PROD_STORAGE, false),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripePublishableKey: process.env.VITE_STRIPE_PUBLISHABLE_KEY || '',
  aiProvider: process.env.AI_PROVIDER || 'auto',
  aiModel: process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  aiApiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
  aiBaseUrl: process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
  allowMemoryFallback: toBool(
    process.env.ALLOW_MEMORY_FALLBACK,
    !(process.env.MONGODB_URI || process.env.POSTGRES_URL),
  ),
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  youtubeUploadRefreshToken: process.env.YOUTUBE_UPLOAD_REFRESH_TOKEN || '',
  privateVideoTokenSecret: process.env.PRIVATE_VIDEO_TOKEN_SECRET || process.env.JWT_SECRET || 'dev-only-secret',
  privateVideoTokenTtlSeconds: toNumber(process.env.PRIVATE_VIDEO_TOKEN_TTL_SECONDS, 900),
  privateVideoDeliveryUrlTtlSeconds: toNumber(process.env.PRIVATE_VIDEO_DELIVERY_URL_TTL_SECONDS, 900),
  privateVideoHlsManifestCacheSeconds: toNumber(process.env.PRIVATE_VIDEO_HLS_MANIFEST_CACHE_SECONDS, 8),
  privateVideoHlsSegmentCacheSeconds: toNumber(process.env.PRIVATE_VIDEO_HLS_SEGMENT_CACHE_SECONDS, 31_536_000),
  privateVideoHlsSegmentTokenTtlSeconds: toNumber(process.env.PRIVATE_VIDEO_HLS_SEGMENT_TOKEN_TTL_SECONDS, 900),
  privateVideoHlsAesEncryptionEnabled: toBool(process.env.PRIVATE_VIDEO_HLS_AES_ENCRYPTION_ENABLED, true),
  privateVideoHlsCacheWarmBaseUrl: process.env.PRIVATE_VIDEO_HLS_CACHE_WARM_BASE_URL || '',
  privateVideoHlsChildManifestWarmAsync: toBool(process.env.PRIVATE_VIDEO_HLS_CHILD_MANIFEST_WARM_ASYNC, true),
  privateVideoHlsEagerHttpWarmEnabled: toBool(process.env.PRIVATE_VIDEO_HLS_EAGER_HTTP_WARM_ENABLED, false),
  privateVideoDrmEnabled: toBool(process.env.PRIVATE_VIDEO_DRM_ENABLED, false),
  privateVideoDrmManifestBaseUrl: process.env.PRIVATE_VIDEO_DRM_MANIFEST_BASE_URL || '',
  privateVideoDrmManifestFileName: process.env.PRIVATE_VIDEO_DRM_MANIFEST_FILE_NAME || 'master.mpd',
  privateVideoDrmManifestFormat: process.env.PRIVATE_VIDEO_DRM_MANIFEST_FORMAT || 'dash',
  privateVideoDrmPreferredKeySystem: process.env.PRIVATE_VIDEO_DRM_PREFERRED_KEY_SYSTEM || '',
  privateVideoDrmWidevineLicenseUrl: process.env.PRIVATE_VIDEO_DRM_WIDEVINE_LICENSE_URL || '',
  privateVideoDrmFairplayLicenseUrl: process.env.PRIVATE_VIDEO_DRM_FAIRPLAY_LICENSE_URL || '',
  privateVideoDrmFairplayCertificateUrl: process.env.PRIVATE_VIDEO_DRM_FAIRPLAY_CERTIFICATE_URL || '',
  privateVideoDrmPlayreadyLicenseUrl: process.env.PRIVATE_VIDEO_DRM_PLAYREADY_LICENSE_URL || '',
  privateVideoRequireDrmForPaidPlayback: toBool(
    process.env.PRIVATE_VIDEO_REQUIRE_DRM_FOR_PAID_PLAYBACK,
    false,
  ),
  privateVideoStrictPlatformRestriction: toBool(process.env.PRIVATE_VIDEO_STRICT_PLATFORM_RESTRICTION, false),
  privateVideoStorageProvider: process.env.PRIVATE_VIDEO_STORAGE_PROVIDER || 's3',
  privateVideoLegacyLessonWatchLimit: toNumber(process.env.PRIVATE_VIDEO_LEGACY_LESSON_WATCH_LIMIT, 2),
  privateVideoNewUploadWatchLimit: toNumber(process.env.PRIVATE_VIDEO_NEW_UPLOAD_WATCH_LIMIT, 1),
  videoWatchCompletionThresholdPercent: toNumber(process.env.VIDEO_WATCH_COMPLETION_THRESHOLD_PERCENT, 90),
  videoWatchChunkSeconds: toNumber(process.env.VIDEO_WATCH_CHUNK_SECONDS, 10),
  videoPlaybackHeartbeatGraceSeconds: toNumber(process.env.VIDEO_PLAYBACK_HEARTBEAT_GRACE_SECONDS, 8),
  videoPlaybackReconnectGraceSeconds: toNumber(process.env.VIDEO_PLAYBACK_RECONNECT_GRACE_SECONDS, 60),
  videoPlaybackSessionTtlSeconds: toNumber(process.env.VIDEO_PLAYBACK_SESSION_TTL_SECONDS, 120),
  videoPlaybackMaxHeartbeatGapSeconds: toNumber(process.env.VIDEO_PLAYBACK_MAX_HEARTBEAT_GAP_SECONDS, 90),
  videoPlaybackMaxRate: toNumber(process.env.VIDEO_PLAYBACK_MAX_RATE, 2),
  courseVideoAccessMode: String(process.env.COURSE_VIDEO_ACCESS_MODE || 'free_order').trim().toLowerCase() === 'sequential'
    ? 'sequential'
    : 'free_order',
  videoHlsStorageProvider: process.env.VIDEO_HLS_STORAGE_PROVIDER || process.env.PRIVATE_VIDEO_STORAGE_PROVIDER || 's3',
  videoProcessingProvider: process.env.VIDEO_PROCESSING_PROVIDER || 'local-hls',
  cloudflareStreamAccountId: process.env.CLOUDFLARE_STREAM_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareStreamApiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN || '',
  cloudflareStreamCustomerCode: process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE || '',
  cloudflareStreamWebhookSecret: process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET || '',
  cloudflareStreamAllowedOrigins: (process.env.CLOUDFLARE_STREAM_ALLOWED_ORIGINS || process.env.APP_URL || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  cloudflareStreamSignedPlaybackRequired: toBool(process.env.CLOUDFLARE_STREAM_SIGNED_PLAYBACK_REQUIRED, false),
  cloudflareStreamDirectUploadExpiryMinutes: toNumber(process.env.CLOUDFLARE_STREAM_DIRECT_UPLOAD_EXPIRY_MINUTES, 180),
  cloudflareStreamDefaultMaxDurationSeconds: toNumber(process.env.CLOUDFLARE_STREAM_DEFAULT_MAX_DURATION_SECONDS, 6 * 60 * 60),
  cloudflareStreamMaxUploadDurationSeconds: toNumber(process.env.CLOUDFLARE_STREAM_MAX_UPLOAD_DURATION_SECONDS, 10 * 60 * 60),
  cloudflareStreamUploadDurationSafetySeconds: toNumber(process.env.CLOUDFLARE_STREAM_UPLOAD_DURATION_SAFETY_SECONDS, 30 * 60),
  cloudflareStreamStatusPollInitialDelayMs: toNumber(process.env.CLOUDFLARE_STREAM_STATUS_POLL_INITIAL_DELAY_MS, 30_000),
  cloudflareStreamStatusPollMaxAttempts: toNumber(process.env.CLOUDFLARE_STREAM_STATUS_POLL_MAX_ATTEMPTS, 36),
  courseDefaultValidityDays: toNumber(process.env.COURSE_DEFAULT_VALIDITY_DAYS, 365),
  enableVideoTranscoding: toBool(process.env.ENABLE_VIDEO_TRANSCODING, true),
  sourcePlaybackFallbackEnabled: toBool(process.env.SOURCE_PLAYBACK_FALLBACK_ENABLED, true),
  videoDeliveryProfile: process.env.VIDEO_DELIVERY_PROFILE || 'r2-private-hls',
  videoTargetRenditions: (process.env.VIDEO_TARGET_RENDITIONS || '240p,360p,480p,720p')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
  videoHlsSegmentDurationSeconds: toNumber(process.env.VIDEO_HLS_SEGMENT_DURATION_SECONDS, 4),
  videoTranscodingConcurrency: Math.max(1, Math.floor(toNumber(process.env.VIDEO_TRANSCODING_CONCURRENCY, 1))),
  videoTranscodingJobTimeoutMs: toNumber(process.env.VIDEO_TRANSCODING_JOB_TIMEOUT_MS, 45 * 60 * 1000),
  videoProcessingStaleAfterMs: toNumber(process.env.VIDEO_PROCESSING_STALE_AFTER_MS, 20 * 60 * 1000),
  videoProcessingRecoveryPollMs: toNumber(process.env.VIDEO_PROCESSING_RECOVERY_POLL_MS, 15 * 1000),
  videoLocalQueueStaleAfterMs: toNumber(process.env.VIDEO_LOCAL_QUEUE_STALE_AFTER_MS, 45 * 1000),
  videoKeepSourceAfterProcessing: toBool(process.env.VIDEO_KEEP_SOURCE_AFTER_PROCESSING, true),
  videoReplayViewLimitEnabled: toBool(process.env.VIDEO_REPLAY_VIEW_LIMIT_ENABLED, true),
  videoReplayMaxViews: toNumber(process.env.VIDEO_REPLAY_MAX_VIEWS, 2),
  videoReplayRetentionDays: toNumber(process.env.VIDEO_REPLAY_RETENTION_DAYS, 365),
  maxVideoUploadMb: toNumber(process.env.MAX_VIDEO_UPLOAD_MB, 2048),
  environmentLabel: process.env.ENVIRONMENT_LABEL || 'local',
  exposeSampleCredentials: toBool(process.env.EXPOSE_SAMPLE_CREDENTIALS, false),
  jitsiMeetDomain: process.env.JITSI_MEET_DOMAIN || 'meet.jit.si',
  liveHlsInternalBaseUrl: process.env.LIVE_HLS_INTERNAL_BASE_URL || '',
  liveHlsPublicBaseUrl: process.env.LIVE_HLS_PUBLIC_BASE_URL || process.env.VITE_LIVE_HLS_BASE_URL || '',
  liveHlsDevSourcePath: process.env.LIVE_HLS_DEV_SOURCE_PATH || '',
  liveHlsDevFallbackPlaybackUrl: process.env.LIVE_HLS_DEV_FALLBACK_PLAYBACK_URL || '',
  liveIngestStreamBaseUrl: process.env.LIVE_INGEST_STREAM_BASE_URL || '',
  liveIngestPublisherSecret: process.env.LIVE_INGEST_PUBLISHER_SECRET || '',
  livekitUrl: process.env.LIVEKIT_URL || '',
  livekitApiKey: process.env.LIVEKIT_API_KEY || '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET || '',
  livekitRoomPrefix: process.env.LIVEKIT_ROOM_PREFIX || 'edumaster-live',
  livekitTokenTtlSeconds: toNumber(process.env.LIVEKIT_TOKEN_TTL_SECONDS, 600),
  liveClassMaxAttendees: toNumber(process.env.LIVE_CLASS_MAX_ATTENDEES, 2500),
  liveClassesEnabled: toBool(process.env.LIVE_CLASSES_ENABLED, false),
};

appConfig.hasLiveKit = isLiveKitConfiguredValue(appConfig.livekitUrl)
  && isLiveKitConfiguredValue(appConfig.livekitApiKey)
  && isLiveKitConfiguredValue(appConfig.livekitApiSecret);
appConfig.hasManagedLiveHls = isConfiguredRuntimeValue(appConfig.liveHlsInternalBaseUrl)
  && isConfiguredRuntimeValue(appConfig.liveIngestStreamBaseUrl);
appConfig.preferredLivePlaybackType = appConfig.hasManagedLiveHls
  ? 'hls'
  : appConfig.hasLiveKit
    ? 'livekit'
    : 'jitsi';

const isDefaultJwtSecret = appConfig.jwtSecret === DEFAULT_JWT_SECRET;

if (appConfig.nodeEnv === 'production' && isDefaultJwtSecret) {
  throw new Error('JWT_SECRET must be set in production.');
}

if (appConfig.nodeEnv !== 'production' && isDefaultJwtSecret) {
  console.warn('[config] Using fallback JWT secret for non-production environment.');
}

const getConfigSummary = () => ({
  nodeEnv: appConfig.nodeEnv,
  serviceName: appConfig.serviceName,
  environmentLabel: appConfig.environmentLabel,
  appUrl: appConfig.appUrl,
  hasMongo: Boolean(appConfig.mongoUri),
  hasPostgres: Boolean(appConfig.postgresUrl),
  hasFirebaseStateStorage: appConfig.firebaseStateStorage,
  allowMemoryFallback: appConfig.allowMemoryFallback,
  hasRedis: Boolean(appConfig.redisUrl),
  hasStripe: Boolean(appConfig.stripeSecretKey && appConfig.stripePublishableKey),
  hasRazorpay: Boolean(appConfig.razorpayKeyId && appConfig.razorpayKeySecret),
  hasAiProvider: Boolean(appConfig.aiApiKey),
  aiProvider: appConfig.aiProvider,
  aiModel: appConfig.aiModel,
  hasGemini: Boolean(appConfig.geminiApiKey),
  geminiModel: appConfig.geminiModel,
  hasS3: Boolean(appConfig.storageBucket && appConfig.storageRegion),
  hasLiveKit: appConfig.hasLiveKit,
  hasManagedLiveHls: appConfig.hasManagedLiveHls,
  preferredLivePlaybackType: appConfig.preferredLivePlaybackType,
  liveClassesEnabled: appConfig.liveClassesEnabled,
  s3EndpointConfigured: Boolean(appConfig.s3Endpoint),
  hasYouTubeUpload: Boolean(
    appConfig.googleOauthClientId
    && appConfig.googleOauthClientSecret
    && appConfig.youtubeUploadRefreshToken,
  ),
  hasPrivateVideoSigning: Boolean(appConfig.privateVideoTokenSecret),
  privateVideoDrmEnabled: appConfig.privateVideoDrmEnabled,
  privateVideoRequireDrmForPaidPlayback: appConfig.privateVideoRequireDrmForPaidPlayback,
  privateVideoStrictPlatformRestriction: appConfig.privateVideoStrictPlatformRestriction,
  privateVideoDrmManifestBaseUrlConfigured: Boolean(appConfig.privateVideoDrmManifestBaseUrl),
  privateVideoStorageProvider: appConfig.privateVideoStorageProvider,
  privateVideoStorageKeyPrefix: appConfig.privateVideoStorageKeyPrefix,
  stagingAllowSharedProdStorage: appConfig.stagingAllowSharedProdStorage,
  videoHlsStorageProvider: appConfig.videoHlsStorageProvider,
  videoProcessingProvider: appConfig.videoProcessingProvider,
  courseVideoAccessMode: appConfig.courseVideoAccessMode,
  hasCloudflareStream: Boolean(appConfig.cloudflareStreamAccountId && appConfig.cloudflareStreamApiToken),
  cloudflareStreamCustomerCodeConfigured: Boolean(appConfig.cloudflareStreamCustomerCode),
  courseDefaultValidityDays: appConfig.courseDefaultValidityDays,
  enableVideoTranscoding: appConfig.enableVideoTranscoding,
  videoDeliveryProfile: appConfig.videoDeliveryProfile,
  privateVideoLegacyLessonWatchLimit: appConfig.privateVideoLegacyLessonWatchLimit,
  privateVideoNewUploadWatchLimit: appConfig.privateVideoNewUploadWatchLimit,
  videoWatchCompletionThresholdPercent: appConfig.videoWatchCompletionThresholdPercent,
  videoReplayMaxViews: appConfig.videoReplayMaxViews,
  videoReplayViewLimitEnabled: appConfig.videoReplayViewLimitEnabled,
  videoReplayRetentionDays: appConfig.videoReplayRetentionDays,
  maxVideoUploadMb: appConfig.maxVideoUploadMb,
  liveClassMaxAttendees: appConfig.liveClassMaxAttendees,
});

const getProductionConfigDiagnostics = () => {
  const errors = [];
  const warnings = [];
  const isProduction = appConfig.nodeEnv === 'production';
  const hasPersistentDatabase = Boolean(appConfig.mongoUri || appConfig.postgresUrl || appConfig.firebaseStateStorage);
  const usingObjectStorage = appConfig.privateVideoStorageProvider === 's3';

  if (isProduction && appConfig.allowMemoryFallback) {
    errors.push('ALLOW_MEMORY_FALLBACK must be disabled in production.');
  }

  if (isProduction && !usingObjectStorage) {
    errors.push('PRIVATE_VIDEO_STORAGE_PROVIDER must be set to s3 for production recorded video storage.');
  }

  if (isProduction && appConfig.exposeSampleCredentials) {
    errors.push('EXPOSE_SAMPLE_CREDENTIALS must be disabled in production.');
  }

  if (isProduction && appConfig.adminEmail === DEFAULT_ADMIN_EMAIL) {
    errors.push('ADMIN_EMAIL must be changed from the local default in production.');
  }

  if (isProduction && appConfig.adminPassword === DEFAULT_ADMIN_PASSWORD) {
    errors.push('ADMIN_PASSWORD must be changed from the local default in production.');
  }

  if (isProduction && !hasPersistentDatabase) {
    errors.push('Production requires MONGODB_URI, POSTGRES_URL, or FIREBASE_STATE_STORAGE=true.');
  }

  if (isProduction && appConfig.corsOrigin === '*') {
    errors.push('CORS_ORIGIN cannot be "*" in production.');
  }

  [
    ['APP_URL', appConfig.appUrl],
    ['CORS_ORIGIN', appConfig.corsOrigin],
    ['ADMIN_EMAIL', appConfig.adminEmail],
  ].forEach(([name, value]) => {
    if (isProduction && isPlaceholderValue(value)) {
      errors.push(`${name} must be changed from placeholder/example value in production.`);
    }
  });

  [
    ['JWT_SECRET', appConfig.jwtSecret],
    ['PRIVATE_VIDEO_TOKEN_SECRET', appConfig.privateVideoTokenSecret],
    ['ADMIN_PASSWORD', appConfig.adminPassword],
  ].forEach(([name, value]) => {
    if (isProduction && (!value || isPlaceholderValue(value) || String(value).length < 24)) {
      errors.push(`${name} must be a real strong production secret.`);
    }
  });

  if (isProduction && appConfig.privateVideoStorageProvider === 'local') {
    warnings.push('PRIVATE_VIDEO_STORAGE_PROVIDER=local keeps protected recordings on the app server. Prefer S3-compatible object storage for production.');
  }

  if (isProduction && appConfig.videoHlsStorageProvider === 'local') {
    warnings.push('VIDEO_HLS_STORAGE_PROVIDER=local keeps processed lesson HLS assets on the app server. Prefer S3-compatible object storage for production.');
  }

  if (isProduction && appConfig.enableVideoTranscoding) {
    warnings.push('ENABLE_VIDEO_TRANSCODING is on. Make sure ffmpeg is available in the runtime image for replay processing.');
  }

  if (isProduction && appConfig.videoProcessingProvider !== 'local-hls') {
    warnings.push('VIDEO_PROCESSING_PROVIDER is not local-hls. Recorded uploads will stay on the legacy provider until the environment is switched to the low-cost HLS pipeline.');
  }

  if (isProduction && appConfig.videoProcessingProvider === 'cloudflare-stream') {
    warnings.push('VIDEO_PROCESSING_PROVIDER=cloudflare-stream is a legacy mode. Prefer local-hls with r2-private-hls delivery for the lower-cost recorded video pipeline.');
    if (!appConfig.cloudflareStreamAccountId) {
      errors.push('CLOUDFLARE_STREAM_ACCOUNT_ID is required when VIDEO_PROCESSING_PROVIDER=cloudflare-stream.');
    }

    if (!appConfig.cloudflareStreamApiToken) {
      errors.push('CLOUDFLARE_STREAM_API_TOKEN is required when VIDEO_PROCESSING_PROVIDER=cloudflare-stream.');
    }

    if (!appConfig.cloudflareStreamCustomerCode) {
      errors.push('CLOUDFLARE_STREAM_CUSTOMER_CODE is required to build Cloudflare Stream HLS playback URLs.');
    }

    [
      ['CLOUDFLARE_STREAM_ACCOUNT_ID', appConfig.cloudflareStreamAccountId],
      ['CLOUDFLARE_STREAM_API_TOKEN', appConfig.cloudflareStreamApiToken],
      ['CLOUDFLARE_STREAM_CUSTOMER_CODE', appConfig.cloudflareStreamCustomerCode],
      ['CLOUDFLARE_STREAM_WEBHOOK_SECRET', appConfig.cloudflareStreamWebhookSecret],
    ].forEach(([name, value]) => {
      if (value && isPlaceholderValue(value)) {
        errors.push(`${name} must be changed from placeholder/example value in production.`);
      }
    });

    if (!appConfig.cloudflareStreamWebhookSecret) {
      warnings.push('CLOUDFLARE_STREAM_WEBHOOK_SECRET is missing. Status polling will work, but signed Cloudflare webhook verification should be enabled for production.');
    }
  }

  if (
    isProduction
    && appConfig.videoProcessingProvider !== 'cloudflare-stream'
    && appConfig.cloudflareStreamAccountId
    && appConfig.cloudflareStreamApiToken
  ) {
    warnings.push('Cloudflare Stream credentials are still configured, but local-hls is active. Keep them only for legacy migration or cleanup tasks.');
  }

  if (isProduction && appConfig.privateVideoRequireDrmForPaidPlayback) {
    warnings.push('PRIVATE_VIDEO_REQUIRE_DRM_FOR_PAID_PLAYBACK is enabled, but paid recorded web playback no longer uses DRM as a platform gate. Leave it false unless DRM is being reintroduced deliberately.');
  }

  if (isProduction && appConfig.liveClassesEnabled && appConfig.hasManagedLiveHls && !appConfig.liveIngestPublisherSecret) {
    errors.push('Managed HLS ingest is configured, but LIVE_INGEST_PUBLISHER_SECRET is missing. Protect the RTMP publish callback before launch.');
  }

  [
    ['LIVE_HLS_INTERNAL_BASE_URL', appConfig.liveHlsInternalBaseUrl],
    ['LIVE_INGEST_STREAM_BASE_URL', appConfig.liveIngestStreamBaseUrl],
    ['LIVE_INGEST_PUBLISHER_SECRET', appConfig.liveIngestPublisherSecret],
  ].forEach(([name, value]) => {
    if (isProduction && value && isPlaceholderValue(value)) {
      errors.push(`${name} must be changed from placeholder/example value in production.`);
    }
  });

  if (isProduction && appConfig.liveClassesEnabled && appConfig.hasManagedLiveHls && appConfig.liveClassMaxAttendees < 1000) {
    warnings.push('LIVE_CLASS_MAX_ATTENDEES is below 1000. Increase it before running large batches.');
  }

  if (isProduction && appConfig.courseDefaultValidityDays < 180) {
    warnings.push('COURSE_DEFAULT_VALIDITY_DAYS is below 180. Your requested 6-month course access may expire too early.');
  }

  if (isProduction && appConfig.videoReplayViewLimitEnabled) {
    warnings.push('VIDEO_REPLAY_VIEW_LIMIT_ENABLED=true can block students before the 6-month course ends. Keep it false for unlimited replay during entitlement.');
  }

  if (isProduction && appConfig.liveClassesEnabled && !appConfig.hasLiveKit && !appConfig.hasManagedLiveHls) {
    errors.push('No LiveKit or managed HLS live stack is configured. Production live classes must use a real media backend.');
  }

  if (isProduction && !appConfig.redisUrl) {
    errors.push('REDIS_URL is required in production for playback heartbeats, mock-test session safety, and high-concurrency counters.');
  }

  if (isProduction && !appConfig.postgresUrl && !appConfig.firebaseStateStorage) {
    warnings.push('Use PostgreSQL/Supabase for 1k-student production traffic. Mongo/local fallback is not the recommended production path.');
  }

  if (isProduction && usingObjectStorage) {
    if (!appConfig.storageBucket) {
      errors.push('S3-compatible private storage is enabled, but S3_BUCKET is missing.');
    }

    if (!appConfig.storageRegion) {
      errors.push('S3-compatible private storage is enabled, but S3_REGION is missing.');
    }

    if (!appConfig.s3AccessKeyId || !appConfig.s3SecretAccessKey) {
      errors.push('S3-compatible private storage is enabled, but S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing.');
    }

    [
      ['S3_BUCKET', appConfig.storageBucket],
      ['S3_ENDPOINT', appConfig.s3Endpoint],
      ['S3_ACCESS_KEY_ID', appConfig.s3AccessKeyId],
      ['S3_SECRET_ACCESS_KEY', appConfig.s3SecretAccessKey],
    ].forEach(([name, value]) => {
      if (isPlaceholderValue(value)) {
        errors.push(`${name} must be changed from placeholder/example value in production.`);
      }
    });
  }

  if (isProduction && appConfig.videoHlsStorageProvider === 's3') {
    if (!appConfig.storageBucket) {
      errors.push('VIDEO_HLS_STORAGE_PROVIDER=s3 requires S3_BUCKET.');
    }

    if (!appConfig.storageRegion) {
      errors.push('VIDEO_HLS_STORAGE_PROVIDER=s3 requires S3_REGION.');
    }

    if (!appConfig.s3AccessKeyId || !appConfig.s3SecretAccessKey) {
      errors.push('VIDEO_HLS_STORAGE_PROVIDER=s3 requires S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
    }
  }

  return { errors, warnings };
};

module.exports = {
  appConfig,
  getConfigSummary,
  getProductionConfigDiagnostics,
};
