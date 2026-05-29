// Course Controller
const fs = require('fs');
const path = require('path');
const { coursesRepository, sessionRepository } = require('../lib/repositories.js');
const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
  optionalNumber,
} = require('../lib/http.js');
const {
  HLS_ACCESS_COOKIE_NAME,
  issuePlaybackToken,
  issueCompactAssetSignature,
  verifyPlaybackToken,
  verifyCompactAssetSignature,
  resolvePrivateVideoPath,
  resolvePrivateHlsPath,
  getProtectedAssetStorageRoot,
} = require('../lib/private-video.js');
const {
  getSignedPrivateVideoUrl,
  getPrivateStorageObjectBuffer,
  isS3Provider,
} = require('../lib/private-video-storage.js');
const { getRedisValue, setRedisValue } = require('../lib/redis.js');
const {
  getHlsAssetMimeType,
  rewriteHlsManifestUris,
} = require('../lib/hls-manifest.js');
const { appConfig } = require('../lib/config.js');
const {
  buildSecurePlaybackClientContext,
} = require('../lib/secure-playback.js');

const defaultCourseValidityDays = appConfig.courseDefaultValidityDays || 183;
const HLS_SEGMENT_EXTENSIONS = new Set(['.ts', '.m4s', '.mp4', '.aac', '.vtt', '.webvtt', '.key']);
const sourceManifestFetchInFlight = new Map();
const sharedManifestRewriteInFlight = new Map();
const childManifestWarmInFlight = new Map();
const sharedHttpCacheWarmInFlight = new Map();
const sourceManifestMemoryCache = new Map();
const rewrittenManifestMemoryCache = new Map();
const COMPACT_HLS_ROUTE_BASE = '/backend/api/courses/h';
const HLS_ACCESS_COOKIE_PATH = '/backend/api/';

const parseRequestCookies = (req) => String(req.headers.cookie || '')
  .split(';')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .reduce((accumulator, entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      return accumulator;
    }

    const name = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    accumulator[name] = decodeURIComponent(value);
    return accumulator;
  }, {});

const setPlaybackCookie = (res, token, expiresAtIso) => {
  const expiresAtMs = Number(new Date(expiresAtIso || '').getTime() || 0);
  const maxAgeSeconds = expiresAtMs > Date.now()
    ? Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000))
    : Math.max(Number(appConfig.privateVideoHlsSegmentTokenTtlSeconds || 21_600), 300);
  const cookieParts = [
    `${HLS_ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${HLS_ACCESS_COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (appConfig.nodeEnv === 'production') {
    cookieParts.push('Secure');
  }

  res.append('Set-Cookie', cookieParts.join('; '));
};

const requestMatchesPlaybackContext = (req, payload = {}) => {
  if (!payload?.userAgentHash) {
    return true;
  }

  const requestContext = buildSecurePlaybackClientContext(req);
  return String(requestContext.userAgentHash || '') === String(payload.userAgentHash || '');
};

const getValidHlsGrantFromRequest = async (req, storageRoot) => {
  const cookieToken = parseRequestCookies(req)[HLS_ACCESS_COOKIE_NAME] || '';
  const payload = verifyPlaybackToken(cookieToken);
  if (!payload || payload.kind !== 'course-hls-grant' || String(payload.storageRoot || '') !== String(storageRoot || '')) {
    return null;
  }

  if (payload.sessionId && payload.userId) {
    const activeSessionId = await sessionRepository.getActiveSessionId(String(payload.userId), String(payload.sessionId));
    if (activeSessionId !== payload.sessionId) {
      return null;
    }
  }

  if (!requestMatchesPlaybackContext(req, payload)) {
    return null;
  }

  return payload;
};

const getStorageRootFromPlayerStreamUrl = (streamUrl) => {
  const rawUrl = String(streamUrl || '');
  const manifestBundlePath = rawUrl.split('/course-manifests/b/')[1]?.split('/_p/')[0] || '';
  if (manifestBundlePath) {
    return getProtectedAssetStorageRoot(manifestBundlePath);
  }

  const compactAssetPath = rawUrl.split(`${COMPACT_HLS_ROUTE_BASE}/`)[1]?.split('?')[0] || '';
  if (compactAssetPath) {
    return getProtectedAssetStorageRoot(decodeCompactAssetPath(compactAssetPath));
  }

  return '';
};

const getExtension = (value) => path.extname(String(value || '')).toLowerCase();

const isHlsManifestPath = (value) => getExtension(value) === '.m3u8';

const isHlsSegmentPath = (value) => HLS_SEGMENT_EXTENSIONS.has(getExtension(value));

const getSharedSegmentTokenExpiresAt = () => {
  const ttlMs = Math.max(Number(appConfig.privateVideoHlsSegmentTokenTtlSeconds || 3600), 300) * 1000;
  return Math.ceil((Date.now() + 1000) / ttlMs) * ttlMs;
};

const isMediaManifestText = (manifestText) => {
  const text = String(manifestText || '');
  return /#EXTINF:|#EXT-X-TARGETDURATION:|#EXT-X-MAP:|#EXT-X-PART:/.test(text)
    && !/#EXT-X-STREAM-INF:/.test(text);
};

const parseHlsManifestEntries = (manifestText) => String(manifestText || '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const getSharedManifestRewriteCacheKey = (payload) => {
  if (!payload?.storagePath) {
    return null;
  }

  return [
    'edumaster',
    'hls-manifest',
    'v3',
    'shared',
    String(payload.storagePath),
    String(getSharedSegmentTokenExpiresAt()),
  ].join(':');
};

const getSharedManifestRewriteCacheTtlSeconds = () => {
  const remainingSeconds = Math.max(1, Math.floor((getSharedSegmentTokenExpiresAt() - Date.now()) / 1000) - 1);
  return Math.max(
    Number(appConfig.privateVideoHlsManifestCacheSeconds || 8),
    Math.min(300, remainingSeconds),
  );
};

const getSourceManifestCacheKey = (storageProvider, storagePath) => {
  if (!storagePath) {
    return null;
  }

  return [
    'edumaster',
    'hls-manifest',
    'source',
    String(storageProvider || 'local'),
    String(storagePath),
  ].join(':');
};

const getSourceManifestCacheTtlSeconds = () => Math.max(
  Number(appConfig.privateVideoHlsManifestCacheSeconds || 8),
  300,
);

const getMemoryCacheValue = (cache, key) => {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return cached.value;
};

const setMemoryCacheValue = (cache, key, value, ttlSeconds) => {
  cache.set(key, {
    value,
    expiresAtMs: Date.now() + (Math.max(1, Number(ttlSeconds || 1)) * 1000),
  });
  return value;
};

const getSharedManifestTokenExpiresAt = () => {
  const ttlMs = Math.max(Number(appConfig.privateVideoHlsSegmentTokenTtlSeconds || 3600), 300) * 1000;
  return Math.ceil((Date.now() + 1000) / ttlMs) * ttlMs;
};

const encodeCompactAssetPath = (assetPath) => String(assetPath || '')
  .split('/')
  .filter(Boolean)
  .map((segment) => encodeURIComponent(segment))
  .join('/');

const decodeCompactAssetPath = (value) => String(value || '')
  .split('/')
  .filter(Boolean)
  .map((segment) => decodeURIComponent(segment))
  .join('/');

const setHlsCacheHeaders = (res, assetPath, payload = {}, options = {}) => {
  const cacheScope = payload.cacheScope || '';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Accept-Encoding');

  if (isHlsManifestPath(assetPath)) {
    if (cacheScope === 'shared-hls-manifest') {
      const ttl = Math.max(Number(appConfig.privateVideoHlsManifestCacheSeconds || 8), 60);
      res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 6}`);
      res.setHeader('X-Edumaster-Cache-Policy', 'hls-manifest-shared');
      return;
    }

    const ttl = Math.max(Number(appConfig.privateVideoHlsManifestCacheSeconds || 8), 1);
    res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 6}`);
    res.setHeader('X-Edumaster-Cache-Policy', 'hls-manifest-short');
    return;
  }

  if (cacheScope === 'shared-hls-segment' || isHlsSegmentPath(assetPath)) {
    const segmentTtl = Math.max(Number(appConfig.privateVideoHlsSegmentCacheSeconds || 31_536_000), 300);
    const redirectTtl = Math.max(Number(appConfig.privateVideoDeliveryUrlTtlSeconds || 900) - 60, 60);
    const ttl = options.redirect ? Math.min(segmentTtl, redirectTtl) : segmentTtl;
    const immutable = options.redirect ? '' : ', immutable';
    res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=86400${immutable}`);
    res.setHeader('X-Edumaster-Cache-Policy', options.redirect ? 'hls-segment-redirect-shared' : 'hls-segment-shared');
    return;
  }

  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  res.setHeader('X-Edumaster-Cache-Policy', 'hls-private-fallback');
};

const buildHlsAssetUrl = (payload, assetPath, mimeType) => {
  const isSegment = isHlsSegmentPath(assetPath);
  const cacheScope = isSegment ? 'shared-hls-segment' : 'shared-hls-manifest';
  const issued = issueCompactAssetSignature({
    storageProvider: payload.storageProvider || appConfig.privateVideoStorageProvider || 'local',
    storagePath: assetPath,
    cacheScope,
  }, {
    ttlSeconds: appConfig.privateVideoHlsSegmentTokenTtlSeconds,
    expiresAtMs: isSegment ? getSharedSegmentTokenExpiresAt() : getSharedManifestTokenExpiresAt(),
  });
  const params = new URLSearchParams({
    e: String(issued.exp),
    s: issued.sig,
    p: String(payload.storageProvider || appConfig.privateVideoStorageProvider || 'local'),
  });
  return `${COMPACT_HLS_ROUTE_BASE}/${encodeCompactAssetPath(assetPath)}?${params.toString()}`;
};

const rewriteHlsManifest = (manifestText, payload) => rewriteHlsManifestUris(manifestText, (assetReference) => {
  const resolvedAssetPath = path.posix.join(path.posix.dirname(payload.storagePath), assetReference);
  const mimeType = getHlsAssetMimeType(resolvedAssetPath);
  return buildHlsAssetUrl(
    {
      ...payload,
      storagePath: resolvedAssetPath,
    },
    resolvedAssetPath,
    mimeType,
  );
});

const warmSharedHttpCache = async (assetUrlPath) => {
  const baseUrl = String(appConfig.privateVideoHlsCacheWarmBaseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !assetUrlPath) {
    return;
  }

  const targetUrl = `${baseUrl}${assetUrlPath.startsWith('/') ? assetUrlPath : `/${assetUrlPath}`}`;
  if (sharedHttpCacheWarmInFlight.has(targetUrl)) {
    return sharedHttpCacheWarmInFlight.get(targetUrl);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const pendingWarm = fetch(targetUrl, {
    method: 'GET',
    signal: controller.signal,
    headers: {
      accept: 'application/vnd.apple.mpegurl,*/*',
      'user-agent': 'edumaster-hls-cache-warmer/1.0',
      'x-qa-client-profile': 'cache-warmer',
    },
  }).catch(() => {
    // Best-effort cache warming only.
  }).finally(() => {
    clearTimeout(timeout);
    sharedHttpCacheWarmInFlight.delete(targetUrl);
  });

  sharedHttpCacheWarmInFlight.set(targetUrl, pendingWarm);
  return pendingWarm;
};

const getRewrittenHlsManifest = async (manifestText, payload) => {
  const cacheKey = getSharedManifestRewriteCacheKey(payload);
  if (!cacheKey) {
    return rewriteHlsManifest(manifestText, payload);
  }

  const memoryCached = getMemoryCacheValue(rewrittenManifestMemoryCache, cacheKey);
  if (memoryCached) {
    return memoryCached;
  }

  try {
    const cached = await getRedisValue(cacheKey);
    if (cached) {
      return setMemoryCacheValue(
        rewrittenManifestMemoryCache,
        cacheKey,
        cached,
        getSharedManifestRewriteCacheTtlSeconds(),
      );
    }
  } catch (error) {
    // Ignore Redis read failures and regenerate the manifest inline.
  }

  if (sharedManifestRewriteInFlight.has(cacheKey)) {
    return sharedManifestRewriteInFlight.get(cacheKey);
  }

  const pendingRewrite = (async () => {
    const rewritten = rewriteHlsManifest(manifestText, payload);
    setMemoryCacheValue(
      rewrittenManifestMemoryCache,
      cacheKey,
      rewritten,
      getSharedManifestRewriteCacheTtlSeconds(),
    );
    try {
      await setRedisValue(cacheKey, rewritten, {
        ttlSeconds: getSharedManifestRewriteCacheTtlSeconds(),
      });
    } catch (error) {
      // Ignore Redis write failures and serve the rewritten manifest anyway.
    }
    return rewritten;
  })().finally(() => {
    sharedManifestRewriteInFlight.delete(cacheKey);
  });

  sharedManifestRewriteInFlight.set(cacheKey, pendingRewrite);
  return pendingRewrite;
};

const warmChildMediaManifests = async (manifestText, payload) => {
  if (isMediaManifestText(manifestText) || !payload?.storagePath) {
    return;
  }

  const childEntries = parseHlsManifestEntries(manifestText)
    .filter((entry) => entry.toLowerCase().endsWith('.m3u8'));
  if (!childEntries.length) {
    return;
  }

  const warmKey = [
    'edumaster',
    'hls-manifest',
    'warm',
    String(payload.storagePath),
    String(getSharedSegmentTokenExpiresAt()),
  ].join(':');

  if (childManifestWarmInFlight.has(warmKey)) {
    return childManifestWarmInFlight.get(warmKey);
  }

  const pendingWarm = Promise.all(childEntries.map(async (entry) => {
    const childStoragePath = path.posix.join(path.posix.dirname(payload.storagePath), entry);
    const childPayload = {
      ...payload,
      storagePath: childStoragePath,
      cacheScope: 'shared-hls-manifest',
      mimeType: getHlsAssetMimeType(childStoragePath),
    };
    const childManifestText = await getSourceHlsManifestText(childPayload);
    await getRewrittenHlsManifest(childManifestText, childPayload);
    if (appConfig.privateVideoHlsEagerHttpWarmEnabled) {
      void warmSharedHttpCache(buildHlsAssetUrl(childPayload, childStoragePath, childPayload.mimeType));
    }
  })).catch(() => {
    // Ignore warm-up failures and let on-demand delivery handle the request path.
  }).finally(() => {
    childManifestWarmInFlight.delete(warmKey);
  });

  childManifestWarmInFlight.set(warmKey, pendingWarm);
  return pendingWarm;
};

const scheduleChildManifestWarmup = (manifestText, payload) => {
  const runWarmup = () => warmChildMediaManifests(manifestText, payload).catch((error) => {
    console.warn('[course-video] Failed to warm child HLS manifests', {
      error: error instanceof Error ? error.message : String(error),
      storagePath: payload?.storagePath || null,
    });
  });

  if (!appConfig.privateVideoHlsChildManifestWarmAsync) {
    return runWarmup();
  }

  setImmediate(() => {
    void runWarmup();
  });

  return null;
};

const getSourceHlsManifestText = async (payload) => {
  const cacheKey = getSourceManifestCacheKey(payload?.storageProvider, payload?.storagePath);
  if (cacheKey) {
    const memoryCached = getMemoryCacheValue(sourceManifestMemoryCache, cacheKey);
    if (memoryCached) {
      return memoryCached;
    }

    try {
      const cached = await getRedisValue(cacheKey);
      if (cached) {
        return setMemoryCacheValue(
          sourceManifestMemoryCache,
          cacheKey,
          cached,
          getSourceManifestCacheTtlSeconds(),
        );
      }
    } catch (error) {
      // Ignore Redis read failures and fall through to storage.
    }

    if (sourceManifestFetchInFlight.has(cacheKey)) {
      return sourceManifestFetchInFlight.get(cacheKey);
    }
  }

  const pendingFetch = (async () => {
    const manifestBuffer = await getPrivateStorageObjectBuffer({
      storageProvider: payload.storageProvider,
      storagePath: payload.storagePath,
    });

    if (!manifestBuffer) {
      throw new ApiError(404, 'Protected HLS manifest could not be delivered', { code: 'PRIVATE_HLS_MANIFEST_UNAVAILABLE' });
    }

    const manifestText = manifestBuffer.toString('utf8');
    if (cacheKey) {
      setMemoryCacheValue(
        sourceManifestMemoryCache,
        cacheKey,
        manifestText,
        getSourceManifestCacheTtlSeconds(),
      );
      try {
        await setRedisValue(cacheKey, manifestText, {
          ttlSeconds: getSourceManifestCacheTtlSeconds(),
        });
      } catch (error) {
        // Ignore Redis write failures and serve the source manifest anyway.
      }
    }

    return manifestText;
  })().finally(() => {
    if (cacheKey) {
      sourceManifestFetchInFlight.delete(cacheKey);
    }
  });

  if (cacheKey) {
    sourceManifestFetchInFlight.set(cacheKey, pendingFetch);
  }

  return pendingFetch;
};

const getCourses = asyncHandler(async (req, res) => {
  const courses = await coursesRepository.listForViewer(req.user?.id || null);
  return ok(res, courses);
});

const getCourse = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'course id');
  const course = await coursesRepository.findVisibleById(courseId, req.user?.id || null);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  return ok(res, course);
});

const getCourseLessons = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'course id');
  const lessons = await coursesRepository.listLessons(courseId, req.user?.id || null);
  return ok(res, lessons);
});

const appendPlaybackGrantCookieIfNeeded = (req, res, player) => {
  if (!(player?.streamFormat === 'hls' && player?.streamUrl)) {
    return;
  }

  const storageRoot = getStorageRootFromPlayerStreamUrl(player.streamUrl);

  if (!storageRoot) {
    return;
  }

  const issuedGrant = issuePlaybackToken({
    kind: 'course-hls-grant',
    userId: req.user?.id || null,
    sessionId: req.user?.session || null,
    storageRoot,
    userAgentHash: buildSecurePlaybackClientContext(req).userAgentHash,
  }, {
    expiresAtMs: Number(new Date(player.tokenExpiresAt || '').getTime() || 0) || undefined,
    ttlSeconds: appConfig.privateVideoHlsSegmentTokenTtlSeconds,
  });
  setPlaybackCookie(res, issuedGrant.token, issuedGrant.expiresAt);
};

const getProtectedLessonPlayer = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'course id');
  const lessonId = requireString(req.params.lessonId, 'lesson id');
  const player = await coursesRepository.getProtectedLessonPlayback({
    userId: req.user?.id || null,
    courseId,
    lessonId,
    requestContext: buildSecurePlaybackClientContext(req),
  });

  appendPlaybackGrantCookieIfNeeded(req, res, player);

  return ok(res, player);
});

const getProtectedLessonBootstrap = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'course id');
  const lessonId = requireString(req.params.lessonId, 'lesson id');
  const bootstrap = await coursesRepository.getProtectedLessonBootstrap({
    userId: req.user?.id || null,
    courseId,
    lessonId,
    requestContext: buildSecurePlaybackClientContext(req),
  });

  appendPlaybackGrantCookieIfNeeded(req, res, bootstrap.player);
  return ok(res, bootstrap);
});

const streamCompactProtectedLessonAsset = asyncHandler(async (req, res) => {
  const storagePath = decodeCompactAssetPath(req.params[0] || '');
  const storageRoot = getProtectedAssetStorageRoot(storagePath);
  const storageProvider = String(req.query.p || appConfig.privateVideoStorageProvider || 'local');
  const cacheScope = isHlsSegmentPath(storagePath) ? 'shared-hls-segment' : 'shared-hls-manifest';
  const exp = Number(req.query.e || 0);
  const sig = String(req.query.s || '');

  if (!storagePath || !verifyCompactAssetSignature({
    storageProvider,
    storagePath,
    cacheScope,
  }, exp, sig)) {
    throw new ApiError(401, 'Playback asset signature is invalid or expired', { code: 'PLAYBACK_ASSET_INVALID' });
  }

  const hlsGrant = await getValidHlsGrantFromRequest(req, storageRoot);
  if (!hlsGrant) {
    throw new ApiError(401, 'Playback grant is missing or expired', { code: 'PLAYBACK_GRANT_INVALID' });
  }

  const payload = {
    storageProvider,
    storagePath,
    cacheScope,
    assetKind: 'hls',
    mimeType: getHlsAssetMimeType(storagePath),
  };

  if (isS3Provider(storageProvider)) {
    if (isHlsManifestPath(storagePath)) {
      const manifestText = await getSourceHlsManifestText(payload);
      scheduleChildManifestWarmup(manifestText, payload);
      setHlsCacheHeaders(res, storagePath, payload);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(await getRewrittenHlsManifest(manifestText, payload));
      return;
    }

    const signedUrl = await getSignedPrivateVideoUrl({
      storagePath,
      mimeType: payload.mimeType,
    });

    if (!signedUrl) {
      throw new ApiError(404, 'Protected HLS asset could not be delivered', { code: 'PRIVATE_HLS_URL_UNAVAILABLE' });
    }

    setHlsCacheHeaders(res, storagePath, payload, { redirect: true });
    res.redirect(307, signedUrl);
    return;
  }

  const assetPath = resolvePrivateHlsPath(storagePath);
  if (!assetPath || !fs.existsSync(assetPath)) {
    throw new ApiError(404, 'Protected HLS asset not found', { code: 'PRIVATE_HLS_NOT_FOUND' });
  }

  const extension = path.extname(assetPath).toLowerCase();
  setHlsCacheHeaders(res, storagePath, payload);
  res.setHeader('Content-Type', payload.mimeType);

  if (extension === '.m3u8') {
    const rawManifest = fs.readFileSync(assetPath, 'utf8');
    res.send(await getRewrittenHlsManifest(rawManifest, payload));
    return;
  }

  res.sendFile(assetPath);
});

const streamProtectedLesson = asyncHandler(async (req, res) => {
  const token = requireString(req.params.token, 'playback token');
  const payload = verifyPlaybackToken(token);

  if (!payload) {
    throw new ApiError(401, 'Playback token is invalid or expired', { code: 'PLAYBACK_TOKEN_INVALID' });
  }

  const activeSessionId = payload.userId
    ? await sessionRepository.getActiveSessionId(String(payload.userId), payload.sessionId || null)
    : null;
  if (payload.sessionId && activeSessionId !== payload.sessionId) {
    throw new ApiError(401, 'Playback session is no longer active', { code: 'PLAYBACK_SESSION_INVALID' });
  }

  if (!requestMatchesPlaybackContext(req, payload)) {
    throw new ApiError(401, 'Playback token is not valid for this device or browser session', {
      code: 'PLAYBACK_CONTEXT_INVALID',
    });
  }

  if (isS3Provider(payload.storageProvider) && payload.assetKind === 'hls') {
    if (isHlsManifestPath(payload.storagePath)) {
      const manifestText = await getSourceHlsManifestText(payload);
      scheduleChildManifestWarmup(manifestText, payload);

      setHlsCacheHeaders(res, payload.storagePath, payload);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(await getRewrittenHlsManifest(manifestText, payload));
      return;
    }

    const signedUrl = await getSignedPrivateVideoUrl({
      storagePath: payload.storagePath,
      mimeType: payload.mimeType,
    });

    if (!signedUrl) {
      throw new ApiError(404, 'Protected HLS asset could not be delivered', { code: 'PRIVATE_HLS_URL_UNAVAILABLE' });
    }

    setHlsCacheHeaders(res, payload.storagePath, payload, { redirect: true });
    res.redirect(307, signedUrl);
    return;
  }

  if (isS3Provider(payload.storageProvider)) {
    const signedUrl = await getSignedPrivateVideoUrl({
      storagePath: payload.storagePath,
      mimeType: payload.mimeType,
    });

    if (!signedUrl) {
      throw new ApiError(404, 'Protected video could not be delivered', { code: 'PRIVATE_VIDEO_URL_UNAVAILABLE' });
    }

    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.redirect(307, signedUrl);
    return;
  }

  if (payload.assetKind === 'hls') {
    const assetPath = resolvePrivateHlsPath(payload.storagePath);
    if (!assetPath || !fs.existsSync(assetPath)) {
      throw new ApiError(404, 'Protected HLS asset not found', { code: 'PRIVATE_HLS_NOT_FOUND' });
    }

    const extension = path.extname(assetPath).toLowerCase();
    const mimeType = getHlsAssetMimeType(assetPath, payload.mimeType || 'application/octet-stream');
    setHlsCacheHeaders(res, payload.storagePath || assetPath, payload);
    res.setHeader('Content-Type', mimeType);

    if (extension === '.m3u8') {
      const rawManifest = fs.readFileSync(assetPath, 'utf8');
      const rewritten = rewriteHlsManifest(rawManifest, payload, assetPath);
      res.send(rewritten);
      return;
    }

    res.sendFile(assetPath);
    return;
  }

  const filePath = resolvePrivateVideoPath(payload.storagePath);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new ApiError(404, 'Protected video file not found', { code: 'PRIVATE_VIDEO_NOT_FOUND' });
  }

  const stat = fs.statSync(filePath);
  const mimeType = payload.mimeType || 'video/mp4';
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const [startText, endText] = String(range).replace(/bytes=/, '').split('-');
  const start = Number(startText || 0);
  const end = endText ? Number(endText) : stat.size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
    res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

const readRawRequestBody = async (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const getUpstreamDrmLicenseUrl = (provider) => {
  switch (String(provider || '').toLowerCase()) {
    case 'widevine':
      return String(appConfig.privateVideoDrmWidevineLicenseUrl || '').trim();
    case 'playready':
      return String(appConfig.privateVideoDrmPlayreadyLicenseUrl || '').trim();
    case 'fairplay':
      return String(appConfig.privateVideoDrmFairplayLicenseUrl || '').trim();
    case 'fairplay-cert':
      return String(appConfig.privateVideoDrmFairplayCertificateUrl || '').trim();
    default:
      return '';
  }
};

const proxyProtectedDrmLicense = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'course id');
  const lessonId = requireString(req.params.lessonId, 'lesson id');
  const provider = requireString(req.params.provider, 'DRM provider');
  const token = requireString(req.query.token, 'playback token');
  const payload = verifyPlaybackToken(token);

  if (!payload || payload.kind !== 'course-drm-license' || String(payload.provider || '') !== String(provider)) {
    throw new ApiError(401, 'DRM playback token is invalid or expired', { code: 'DRM_TOKEN_INVALID' });
  }

  const activeSessionId = payload.userId
    ? await sessionRepository.getActiveSessionId(String(payload.userId), payload.sessionId || null)
    : null;
  if (payload.sessionId && activeSessionId !== payload.sessionId) {
    throw new ApiError(401, 'Playback session is no longer active', { code: 'PLAYBACK_SESSION_INVALID' });
  }

  if (!requestMatchesPlaybackContext(req, payload)) {
    throw new ApiError(401, 'Playback token is not valid for this device or browser session', {
      code: 'PLAYBACK_CONTEXT_INVALID',
    });
  }

  const player = await coursesRepository.getProtectedLessonPlayback({
    userId: req.user?.id || payload.userId || null,
    user: req.user?.profile || null,
    courseId,
    lessonId,
    requestContext: buildSecurePlaybackClientContext(req),
  });

  if (!player?.drmEnabled) {
    throw new ApiError(403, 'DRM playback is not enabled for this lesson', { code: 'DRM_NOT_ENABLED' });
  }

  const upstreamUrl = getUpstreamDrmLicenseUrl(provider);
  if (!upstreamUrl) {
    throw new ApiError(503, 'DRM provider is not configured', { code: 'DRM_PROVIDER_NOT_CONFIGURED' });
  }

  const requestBody = await readRawRequestBody(req);
  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      ...(req.headers.accept ? { accept: req.headers.accept } : {}),
    },
    body: requestBody.length > 0 ? requestBody : undefined,
  });

  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.status(upstreamResponse.status);
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.send(responseBuffer);
});

const proxyProtectedFairplayCertificate = asyncHandler(async (req, res) => {
  req.params.provider = 'fairplay-cert';
  return proxyProtectedDrmLicense(req, res);
});

const createCourse = asyncHandler(async (req, res) => {
  const title = requireString(req.body?.title, 'title', { maxLength: 160 });
  const description = optionalString(req.body?.description, '', { maxLength: 3000 });
  const category = optionalString(req.body?.category, 'SSC JE', { maxLength: 80 });
  const exam = optionalString(req.body?.exam, category, { maxLength: 80 });
  const subject = optionalString(req.body?.subject, 'General', { maxLength: 120 });
  const instructor = optionalString(req.body?.instructor, 'VARONENGLISH Faculty', { maxLength: 120 });
  const officialChannelUrl = optionalString(req.body?.officialChannelUrl, '', { maxLength: 500 }) || null;
  const level = optionalString(req.body?.level, 'Full Course', { maxLength: 80 });
  const thumbnailUrl = optionalString(req.body?.thumbnailUrl, '', { maxLength: 500 });
  const price = optionalNumber(req.body?.price, 1, { min: 1 });
  const offerPercentage = optionalNumber(req.body?.offerPercentage, 0, { min: 0, max: 100 });
  const validityDays = optionalNumber(req.body?.validityDays, defaultCourseValidityDays, { min: 1, max: 3650, integer: true });
  const modules = Array.isArray(req.body?.modules) ? req.body.modules : [];

  const course = await coursesRepository.create({
    title,
    description,
    category,
    exam,
    subject,
    instructor,
    officialChannelUrl,
    level,
    thumbnailUrl,
    price,
    offerPercentage,
    validityDays,
    modules,
    createdBy: req.user?.id || req.body?.createdBy || null,
  });
  return created(res, course);
});

module.exports = {
  getCourses,
  getCourse,
  getCourseLessons,
  getProtectedLessonBootstrap,
  getProtectedLessonPlayer,
  proxyProtectedDrmLicense,
  proxyProtectedFairplayCertificate,
  streamProtectedLesson,
  streamCompactProtectedLessonAsset,
  createCourse,
};
