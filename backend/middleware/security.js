const { appConfig } = require('../lib/config.js');
const { incrementRedisCounter } = require('../lib/redis.js');
const { createHash } = require('crypto');

const requestBuckets = new Map();

const buildMediaPermissionsPolicy = () => {
  const allowedOrigins = [`https://${appConfig.jitsiMeetDomain}`];

  if (appConfig.livekitUrl) {
    try {
      const livekitUrl = new URL(appConfig.livekitUrl);
      if (livekitUrl.protocol === 'wss:') {
        livekitUrl.protocol = 'https:';
      } else if (livekitUrl.protocol === 'ws:') {
        livekitUrl.protocol = 'http:';
      }
      const livekitOrigin = livekitUrl.origin;
      if (livekitOrigin.startsWith('https://')) {
        allowedOrigins.push(livekitOrigin);
      }
    } catch {
      // Ignore malformed optional LiveKit URL.
    }
  }

  const originList = Array.from(new Set(allowedOrigins)).map((origin) => `"${origin}"`).join(' ');
  return [
    `camera=(self ${originList})`,
    `microphone=(self ${originList})`,
    `display-capture=(self ${originList})`,
    `speaker-selection=(self ${originList})`,
    `fullscreen=(self ${originList})`,
    `autoplay=(self ${originList})`,
    'geolocation=()',
  ].join(', ');
};

const securityHeaders = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', buildMediaPermissionsPolicy());
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
};

const cleanupBuckets = (now) => {
  requestBuckets.forEach((bucket, key) => {
    if (now - bucket.windowStart > appConfig.rateLimitWindowMs * 2) {
      requestBuckets.delete(key);
    }
  });
};

const isProtectedMediaStreamRequest = (req) => {
  const requestPath = String(req.path || '');
  return requestPath.startsWith('/api/courses/stream/')
    || requestPath.startsWith('/api/courses/h/')
    || requestPath.startsWith('/api/courses/hls/')
    || requestPath.startsWith('/api/course-manifests/b/')
    || /^\/api\/courses\/[^/]+\/pdf-attachments\/[^/]+\/view$/.test(requestPath)
    || requestPath.startsWith('/api/live-classes/stream/');
};

const hashKeyPart = (value) => createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);

const getAuthTokenKey = (req) => {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? `token:${hashKeyPart(match[1])}` : null;
};

const getLoginSubjectKey = (req) => {
  const subject = req.body?.email || req.body?.mobileNumber || req.body?.mobile || '';
  return subject ? `subject:${hashKeyPart(String(subject).trim().toLowerCase())}` : null;
};

const getRateLimitPolicy = (req) => {
  const requestPath = String(req.path || '');

  if (/^\/api\/auth\/(login|register|signup|social)/.test(requestPath)) {
    const ipIdentity = `ip:${req.ip || 'unknown'}`;
    if (getLoginSubjectKey(req)) {
      return {
        name: 'auth-subject',
        max: Math.max(1, Number(appConfig.rateLimitAuthMax || 30)),
        identity: getLoginSubjectKey(req),
        secondary: {
          name: 'auth-ip',
          max: Math.max(1, Number(appConfig.rateLimitAuthIpMax || appConfig.rateLimitAuthMax || 30)),
          identity: ipIdentity,
        },
      };
    }
    return {
      name: 'auth',
      max: Math.max(1, Number(appConfig.rateLimitAuthMax || 30)),
      identity: ipIdentity,
    };
  }

  const tokenKey = getAuthTokenKey(req);
  if (tokenKey) {
    return {
      name: 'authenticated',
      max: Math.max(1, Number(appConfig.rateLimitAuthenticatedMax || appConfig.rateLimitReadMax || appConfig.rateLimitWriteMax)),
      identity: tokenKey,
    };
  }

  return {
    name: 'ip',
    max: Math.max(1, Number(appConfig.rateLimitMax || 300)),
    identity: `ip:${req.ip || 'unknown'}`,
  };
};

const normalizeRateLimitPath = (req) => {
  const requestPath = String(req.path || '/');
  if (requestPath.startsWith('/api/courses/')) {
    return '/api/courses/:id';
  }
  if (requestPath.startsWith('/api/tests/')) {
    return '/api/tests/:id';
  }
  if (requestPath.startsWith('/api/live-classes/')) {
    return '/api/live-classes/:id';
  }
  return requestPath;
};

const buildRateLimitKey = (req, policy) => [
  policy.name,
  policy.identity,
  req.method,
  normalizeRateLimitPath(req),
].join(':');

const applyHeadersAndCheckLimit = (res, count, limit, windowMs = appConfig.rateLimitWindowMs) => {
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(limit - count, 0)));

  if (count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil(Number(windowMs || appConfig.rateLimitWindowMs) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ message: 'Too many requests. Please retry shortly.' });
  }

  return null;
};

const basicRateLimit = async (req, res, next) => {
  if (isProtectedMediaStreamRequest(req)) {
    return next();
  }

  const now = Date.now();
  const policy = getRateLimitPolicy(req);
  const applyPolicy = async (activePolicy) => {
    const key = buildRateLimitKey(req, activePolicy);

    try {
      const redisCount = await incrementRedisCounter(`ratelimit:${key}`, Math.ceil(appConfig.rateLimitWindowMs / 1000));
      if (redisCount !== null) {
        const limited = applyHeadersAndCheckLimit(res, redisCount, activePolicy.max);
        if (limited) {
          return limited;
        }

        return null;
      }
    } catch {
      // Fall back to in-memory limiting if Redis is unavailable.
    }

    const bucket = requestBuckets.get(key) || { count: 0, windowStart: now };
    if (now - bucket.windowStart > appConfig.rateLimitWindowMs) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count += 1;
    requestBuckets.set(key, bucket);

    const limited = applyHeadersAndCheckLimit(res, bucket.count, activePolicy.max);
    if (limited) {
      return limited;
    }

    return null;
  };

  const primaryLimited = await applyPolicy(policy);
  if (primaryLimited) {
    return primaryLimited;
  }
  if (policy.secondary) {
    const secondaryLimited = await applyPolicy(policy.secondary);
    if (secondaryLimited) {
      return secondaryLimited;
    }
  }

  if (requestBuckets.size > 5000) {
    cleanupBuckets(now);
  }

  return next();
};

module.exports = {
  securityHeaders,
  basicRateLimit,
};
