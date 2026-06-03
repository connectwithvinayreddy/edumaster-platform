const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const { appConfig } = require('../lib/config.js');
const {
  usersRepository,
  sanitizeUser,
  sessionRepository,
  platformRepository,
  videoPlaybackRepository,
} = require('../lib/repositories.js');
const { getPool } = require('../lib/postgres.js');
const { verifyFirebaseIdToken } = require('../lib/auth-social.js');
const { ApiError, asyncHandler, ok, created, requireString, optionalString, requireBoolean } = require('../lib/http.js');

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const normalizeMobileNumber = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.replace(/[^\d+]/g, '');
  if (!normalized) {
    return '';
  }
  const digitsOnly = normalized.replace(/\D/g, '');
  if (!digitsOnly) {
    return '';
  }
  if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    return digitsOnly.slice(-10);
  }
  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    return digitsOnly.slice(-10);
  }
  if (normalized.startsWith('+')) {
    return `+${digitsOnly}`;
  }
  return digitsOnly;
};

const registerGateState = {
  active: 0,
  queue: [],
};

const AUTH_HASH_ROUNDS = Math.max(4, Number(appConfig.authPasswordHashRounds || 10));
const AUTH_REGISTER_MAX_CONCURRENT = Math.max(1, Number(appConfig.authRegisterMaxConcurrent || 4));
const AUTH_REGISTER_MAX_QUEUE = Math.max(0, Number(appConfig.authRegisterMaxQueue || 100));
const AUTH_REGISTER_DB_TIMEOUT_MS = Math.max(500, Number(appConfig.authRegisterDbTimeoutMs || 5_000));

const maskEmail = (value) => {
  const normalized = normalizeEmail(value);
  if (!normalized || !normalized.includes('@')) {
    return '';
  }
  const [local, domain] = normalized.split('@');
  const visibleLocal = local.slice(0, 2);
  return `${visibleLocal}${'*'.repeat(Math.max(0, local.length - visibleLocal.length))}@${domain}`;
};

const maskMobile = (value) => {
  const normalized = normalizeMobileNumber(value);
  if (!normalized) {
    return '';
  }
  const digits = normalized.replace(/\D/g, '');
  if (digits.length <= 4) {
    return digits;
  }
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
};

const getDbPoolSnapshot = () => {
  const pool = getPool();
  if (!pool) {
    return { total: null, idle: null, waiting: null };
  }
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
};

const logRegisterEvent = (context, stage, extra = {}) => {
  const memory = process.memoryUsage();
  console.log('[auth-register]', JSON.stringify({
    request_id: context.requestId,
    container_name: process.env.HOSTNAME || appConfig.serviceName || 'unknown',
    masked_email: context.maskedEmail,
    masked_mobile: context.maskedMobile,
    request_ip: context.requestIp,
    user_agent: context.userAgent,
    stage,
    duration_ms: Math.round(performance.now() - context.startedAt),
    hash_duration_ms: context.hashDurationMs,
    db_duration_ms: context.dbDurationMs,
    response_status: extra.responseStatus ?? null,
    error_code: extra.errorCode ?? null,
    handled: extra.handled ?? true,
    pool: getDbPoolSnapshot(),
    memory: {
      rss_mb: Math.round(memory.rss / 1024 / 1024),
      heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
    },
    ...extra,
  }));
};

const createRegisterContext = (req) => ({
  requestId: req.requestId || randomUUID(),
  startedAt: performance.now(),
  hashDurationMs: 0,
  dbDurationMs: 0,
  maskedEmail: maskEmail(req.body?.email),
  maskedMobile: maskMobile(req.body?.mobileNumber),
  requestIp: req.ip || req.headers['x-forwarded-for'] || null,
  userAgent: req.headers['user-agent'] || null,
});

const requireTypedString = (value, fieldName, { minLength = 1, maxLength = null } = {}) => {
  if (typeof value !== 'string') {
    throw new ApiError(400, `${fieldName} must be a string`, { code: 'VALIDATION_ERROR' });
  }
  return requireString(value, fieldName, { minLength, maxLength });
};

const optionalTypedString = (value, fallback = '', { maxLength = null } = {}) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, 'Value must be a string', { code: 'VALIDATION_ERROR' });
  }
  return optionalString(value, fallback, { maxLength });
};

const validateEmail = (value) => {
  const normalized = normalizeEmail(requireTypedString(value, 'email', { maxLength: 160 }));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ApiError(400, 'email must be a valid email address', { code: 'VALIDATION_ERROR' });
  }
  return normalized;
};

const validateMobileNumber = (value) => {
  const normalized = normalizeMobileNumber(optionalTypedString(value, '', { maxLength: 20 }));
  if (!normalized) {
    return '';
  }
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new ApiError(400, 'mobileNumber must be a valid mobile number', { code: 'VALIDATION_ERROR' });
  }
  return normalized;
};

const validatePassword = (password) => {
  const normalized = requireTypedString(password, 'password', { minLength: 8, maxLength: 128 });
  if (!/[A-Za-z]/.test(normalized) || !/\d/.test(normalized)) {
    throw new ApiError(400, 'password must include at least one letter and one number', { code: 'VALIDATION_ERROR' });
  }

  return normalized;
};

const withTimeout = async (label, promiseFactory, timeoutMs) => {
  let timeoutHandle;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new ApiError(503, `${label} timed out`, { code: 'DB_TIMEOUT' }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const acquireRegisterSlot = async () => {
  if (registerGateState.active < AUTH_REGISTER_MAX_CONCURRENT) {
    registerGateState.active += 1;
    return () => {
      registerGateState.active = Math.max(0, registerGateState.active - 1);
      const next = registerGateState.queue.shift();
      if (next) {
        registerGateState.active += 1;
        next(resolveRegisterRelease());
      }
    };
  }

  if (registerGateState.queue.length >= AUTH_REGISTER_MAX_QUEUE) {
    throw new ApiError(503, 'Registration service is busy. Please retry shortly.', {
      code: 'AUTH_REGISTER_BUSY',
      details: {
        maxConcurrent: AUTH_REGISTER_MAX_CONCURRENT,
        maxQueue: AUTH_REGISTER_MAX_QUEUE,
      },
    });
  }

  return new Promise((resolve) => {
    registerGateState.queue.push(resolve);
  });
};

const resolveRegisterRelease = () => () => {
  registerGateState.active = Math.max(0, registerGateState.active - 1);
  const next = registerGateState.queue.shift();
  if (next) {
    registerGateState.active += 1;
    next(resolveRegisterRelease());
  }
};

const mapRegisterError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.code === '23505') {
    const detail = String(error?.detail || '');
    if (/email/i.test(detail)) {
      return new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
    }
    if (/mobile_number/i.test(detail) || /mobile/i.test(detail)) {
      return new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
    }
    return new ApiError(409, 'User already exists', { code: 'USER_EXISTS' });
  }

  if (error?.code === 11000) {
    const keyValue = JSON.stringify(error?.keyValue || {});
    if (/email/i.test(keyValue)) {
      return new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
    }
    if (/mobile/i.test(keyValue)) {
      return new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
    }
    return new ApiError(409, 'User already exists', { code: 'USER_EXISTS' });
  }

  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(String(error?.code || ''))) {
    return new ApiError(503, 'Database temporarily unavailable', { code: 'DB_UNAVAILABLE' });
  }

  if (/timeout/i.test(String(error?.message || ''))) {
    return new ApiError(503, 'Database temporarily unavailable', { code: 'DB_TIMEOUT' });
  }

  return new ApiError(500, 'Internal server error', { code: 'INTERNAL_SERVER_ERROR' });
};

const issueAuthSession = async ({ user, device, forceLogoutOtherSessions = false }) => {
  const userId = String(user._id);
  const accountStatus = String(user.accountStatus || 'active').toLowerCase();
  if (accountStatus !== 'active') {
    throw new ApiError(403, `This account is ${accountStatus}. Please contact support.`, {
      code: 'ACCOUNT_DISABLED',
      details: {
        accountStatus,
      },
    });
  }
  const activeSessionId = await sessionRepository.getActiveSessionId(userId, user.session || null);
  if (activeSessionId && !forceLogoutOtherSessions) {
    const recentSessions = await sessionRepository.getRecentSessions(userId).catch(() => []);
    const activeSessions = recentSessions
      .filter((session) => session.status === 'active')
      .map((session) => ({
        sessionId: session.sessionId,
        device: session.device || 'Active device',
        lastSeenAt: session.lastSeenAt || session.createdAt || null,
      }));
    const primaryActiveSession = activeSessions.find((session) => session.sessionId === activeSessionId) || activeSessions[0] || null;
    throw new ApiError(409, 'This account is already active on another device.', {
      code: 'SESSION_ACTIVE',
      details: {
        activeDevice: primaryActiveSession?.device || user.device || 'another device',
        activeSessions,
        sessionLimit: 1,
      },
    });
  }

  if (activeSessionId) {
    await sessionRepository.recordLogout({
      userId,
      sessionId: activeSessionId,
      device: user.device || device || null,
      reason: 'replaced',
    });
    await videoPlaybackRepository.clearActivePlaybackSession(userId);
  }

  const sessionId = Math.random().toString(36).substring(2);
  const updatedUser = await usersRepository.update(userId, {
    session: sessionId,
    device: device || null,
    lastLoginAt: new Date().toISOString(),
  });
  await sessionRepository.recordLogin({
    userId,
    sessionId,
    device: device || null,
  });

  const token = jwt.sign(
    { id: user._id, role: user.role, session: sessionId, email: user.email, name: user.name },
    appConfig.jwtSecret,
    { expiresIn: '7d' },
  );

  return { token, user: sanitizeUser(updatedUser || user) };
};

const buildFirebasePlaceholderPassword = ({ provider, providerUid }) => `firebase-${provider}-${providerUid}-${randomUUID()}`;

const upsertFirebaseUser = async ({ name, email, mobileNumber, provider, providerUid }) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new ApiError(400, `${provider} account did not provide a usable email address.`, { code: 'FIREBASE_EMAIL_REQUIRED' });
  }

  const normalizedMobileNumber = normalizeMobileNumber(mobileNumber || '');
  const existingMobileUser = normalizedMobileNumber
    ? await usersRepository.findByMobileNumber(normalizedMobileNumber)
    : null;

  const existingUser = await usersRepository.findByEmail(normalizedEmail);
  if (existingUser) {
    const patch = {};
    if (!existingUser.name && name) {
      patch.name = name;
    }
    if (normalizedMobileNumber && !existingUser.mobileNumber) {
      if (existingMobileUser && String(existingMobileUser._id) !== String(existingUser._id)) {
        throw new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
      }
      patch.mobileNumber = normalizedMobileNumber;
    }
    if (Object.keys(patch).length > 0) {
      return usersRepository.update(existingUser._id, patch);
    }
    return existingUser;
  }

  if (existingMobileUser) {
    throw new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
  }

  const passwordHash = await bcrypt.hash(buildFirebasePlaceholderPassword({ provider, providerUid }), 10);
  return usersRepository.create({
    name: name || 'Student',
    email: normalizedEmail,
    mobileNumber: normalizedMobileNumber || undefined,
    password: passwordHash,
    role: 'student',
  });
};

const resolveFirebaseProvider = (firebasePayload) => {
  const signInProvider = firebasePayload?.firebase?.sign_in_provider;
  return Array.isArray(signInProvider) ? signInProvider[0] : signInProvider;
};

const assertFirebaseProviderMatches = ({ provider, firebaseProvider }) => {
  if (provider === 'google' && firebaseProvider !== 'google.com') {
    throw new ApiError(401, 'Google login token did not come from Google provider.', { code: 'SOCIAL_PROVIDER_MISMATCH' });
  }
  if (provider === 'apple' && firebaseProvider !== 'apple.com') {
    throw new ApiError(401, 'Apple login token did not come from Apple provider.', { code: 'SOCIAL_PROVIDER_MISMATCH' });
  }
  if (provider === 'password' && firebaseProvider !== 'password') {
    throw new ApiError(401, 'Email/password login token did not come from Firebase password auth.', { code: 'PASSWORD_PROVIDER_MISMATCH' });
  }
};

const issueFirebaseSession = async ({
  idToken,
  provider,
  device,
  forceLogoutOtherSessions = false,
  profile = {},
}) => {
  let firebasePayload;
  try {
    firebasePayload = await verifyFirebaseIdToken(idToken);
  } catch (error) {
    throw new ApiError(401, error instanceof Error ? error.message : 'Invalid Firebase login token.', {
      code: 'FIREBASE_TOKEN_INVALID',
    });
  }

  const firebaseProvider = resolveFirebaseProvider(firebasePayload);
  assertFirebaseProviderMatches({ provider, firebaseProvider });

  const email = normalizeEmail(firebasePayload.email || profile.email || '');
  const name = String(profile.name || firebasePayload.name || '').trim();
  const mobileNumber = profile.mobileNumber || '';
  const user = await upsertFirebaseUser({
    name,
    email,
    mobileNumber,
    provider,
    providerUid: firebasePayload.user_id || firebasePayload.sub,
  });

  return issueAuthSession({ user, device, forceLogoutOtherSessions });
};

const register = asyncHandler(async (req, res) => {
  const context = createRegisterContext(req);
  let releaseSlot = null;
  let createdUser = null;

  try {
    logRegisterEvent(context, 'received');

    if (!req.is('application/json')) {
      throw new ApiError(400, 'Content-Type must be application/json', { code: 'INVALID_CONTENT_TYPE' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ApiError(400, 'Request body must be a JSON object', { code: 'VALIDATION_ERROR' });
    }

    releaseSlot = await acquireRegisterSlot();

    logRegisterEvent(context, 'validate_payload');
    const name = requireTypedString(req.body?.name, 'name', { maxLength: 80 });
    const email = validateEmail(req.body?.email);
    const mobileNumber = validateMobileNumber(req.body?.mobileNumber);
    const password = validatePassword(req.body?.password);
    const device = optionalTypedString(req.body?.device, 'web-dashboard', { maxLength: 120 });
    context.maskedEmail = maskEmail(email);
    context.maskedMobile = maskMobile(mobileNumber);

    if (req.body?.role && req.body.role !== 'student') {
      throw new ApiError(403, 'Self-service registration can only create student accounts', {
        code: 'ROLE_NOT_ALLOWED',
      });
    }

    logRegisterEvent(context, 'normalize_identity');
    const duplicateCheckStarted = performance.now();
    const [existingEmail, existingMobile] = await Promise.all([
      withTimeout('email duplicate check', () => usersRepository.findByEmail(email), AUTH_REGISTER_DB_TIMEOUT_MS),
      mobileNumber
        ? withTimeout('mobile duplicate check', () => usersRepository.findByMobileNumber(mobileNumber), AUTH_REGISTER_DB_TIMEOUT_MS)
        : Promise.resolve(null),
    ]);
    context.dbDurationMs += Math.round(performance.now() - duplicateCheckStarted);

    logRegisterEvent(context, 'check_duplicate');
    if (existingEmail) {
      throw new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
    }

    if (existingMobile) {
      throw new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
    }

    logRegisterEvent(context, 'hash_password');
    const hashStarted = performance.now();
    const hashed = await bcrypt.hash(password, AUTH_HASH_ROUNDS);
    context.hashDurationMs = Math.round(performance.now() - hashStarted);

    logRegisterEvent(context, 'db_insert_user');
    const insertStarted = performance.now();
    createdUser = await withTimeout('user creation', () => usersRepository.create({
      name,
      email,
      mobileNumber,
      password: hashed,
      role: 'student',
    }), AUTH_REGISTER_DB_TIMEOUT_MS);
    context.dbDurationMs += Math.round(performance.now() - insertStarted);

    logRegisterEvent(context, 'create_session');
    const responsePayload = await withTimeout('session creation', () => issueAuthSession({ user: createdUser, device }), AUTH_REGISTER_DB_TIMEOUT_MS);
    logRegisterEvent(context, 'response_sent', { responseStatus: 201, errorCode: null, handled: true });
    return created(res, {
      requestId: context.requestId,
      ...responsePayload,
    });
  } catch (error) {
    const mappedError = mapRegisterError(error);
    if (createdUser && mappedError.status >= 500) {
      await usersRepository.delete(createdUser._id).catch(() => undefined);
    }
    logRegisterEvent(context, 'response_sent', {
      responseStatus: mappedError.status,
      errorCode: mappedError.code,
      handled: mappedError instanceof ApiError,
    });
    throw mappedError;
  } finally {
    if (typeof releaseSlot === 'function') {
      releaseSlot();
    }
  }
});

const login = asyncHandler(async (req, res) => {
  await platformRepository.ensureReady().catch(() => undefined);

  const identifier = requireString(req.body?.email ?? req.body?.identifier, 'email', { maxLength: 160 });
  const password = requireString(req.body?.password, 'password', { minLength: 1, maxLength: 128 });
  const device = optionalString(req.body?.device, 'web-dashboard', { maxLength: 120 });
  const forceLogoutOtherSessions = req.body?.forceLogoutOtherSessions === undefined
    ? false
    : requireBoolean(req.body.forceLogoutOtherSessions, 'forceLogoutOtherSessions');

  const user = await usersRepository.findByLoginIdentifier(identifier);
  if (!user) {
    throw new ApiError(401, 'Invalid credentials', { code: 'INVALID_CREDENTIALS' });
  }
  if (String(user.accountStatus || 'active').toLowerCase() !== 'active') {
    throw new ApiError(403, `This account is ${String(user.accountStatus || 'disabled').toLowerCase()}. Please contact support.`, {
      code: 'ACCOUNT_DISABLED',
      details: {
        accountStatus: String(user.accountStatus || 'disabled').toLowerCase(),
      },
    });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    throw new ApiError(401, 'Invalid credentials', { code: 'INVALID_CREDENTIALS' });
  }

  return ok(res, await issueAuthSession({ user, device, forceLogoutOtherSessions }));
});

const socialLogin = asyncHandler(async (req, res) => {
  await platformRepository.ensureReady().catch(() => undefined);

  const idToken = requireString(req.body?.idToken, 'idToken', { maxLength: 8_192 });
  const provider = requireString(req.body?.provider, 'provider', { maxLength: 40 }).toLowerCase();
  const device = optionalString(req.body?.device, 'web-dashboard', { maxLength: 120 });
  const forceLogoutOtherSessions = req.body?.forceLogoutOtherSessions === undefined
    ? false
    : requireBoolean(req.body.forceLogoutOtherSessions, 'forceLogoutOtherSessions');

  if (!['google', 'apple'].includes(provider)) {
    throw new ApiError(400, 'Unsupported social login provider.', { code: 'SOCIAL_PROVIDER_UNSUPPORTED' });
  }

  return ok(res, await issueFirebaseSession({
    idToken,
    provider,
    device,
    forceLogoutOtherSessions,
  }));
});

const firebaseLogin = asyncHandler(async (req, res) => {
  await platformRepository.ensureReady().catch(() => undefined);

  const idToken = requireString(req.body?.idToken, 'idToken', { maxLength: 8_192 });
  const provider = requireString(req.body?.provider, 'provider', { maxLength: 40 }).toLowerCase();
  const device = optionalString(req.body?.device, 'web-dashboard', { maxLength: 120 });
  const forceLogoutOtherSessions = req.body?.forceLogoutOtherSessions === undefined
    ? false
    : requireBoolean(req.body.forceLogoutOtherSessions, 'forceLogoutOtherSessions');

  if (!['google', 'apple', 'password'].includes(provider)) {
    throw new ApiError(400, 'Unsupported Firebase login provider.', { code: 'FIREBASE_PROVIDER_UNSUPPORTED' });
  }

  const name = optionalString(req.body?.name, '', { maxLength: 80 });
  const mobileNumber = optionalString(req.body?.mobileNumber, '', { maxLength: 20 });

  return ok(res, await issueFirebaseSession({
    idToken,
    provider,
    device,
    forceLogoutOtherSessions,
    profile: {
      name,
      mobileNumber,
    },
  }));
});

const getSession = asyncHandler(async (req, res) => {
  const user = await usersRepository.findSafeById(req.user.id);
  if (!user) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  return ok(res, { user });
});

const logout = asyncHandler(async (req, res) => {
  const currentUser = await usersRepository.findById(req.user.id);
  await usersRepository.update(req.user.id, {
    session: null,
    device: null,
  });
  await sessionRepository.recordLogout({
    userId: req.user.id,
    sessionId: req.user.session,
    device: currentUser?.device || null,
    reason: 'logout',
  });

  return ok(res, { message: 'Logged out successfully' });
});

module.exports = {
  register,
  login,
  socialLogin,
  firebaseLogin,
  getSession,
  logout,
};
