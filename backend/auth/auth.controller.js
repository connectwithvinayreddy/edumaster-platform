const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { appConfig } = require('../lib/config.js');
const { usersRepository, sanitizeUser, sessionRepository, platformRepository } = require('../lib/repositories.js');
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
  if (normalized.startsWith('+')) {
    return `+${normalized.slice(1).replace(/\D/g, '')}`;
  }
  return normalized.replace(/\D/g, '');
};

const validatePassword = (password) => {
  const normalized = requireString(password, 'password', { minLength: 8, maxLength: 128 });
  if (!/[A-Za-z]/.test(normalized) || !/\d/.test(normalized)) {
    throw new ApiError(400, 'password must include at least one letter and one number', { code: 'VALIDATION_ERROR' });
  }

  return normalized;
};

const issueAuthSession = async ({ user, device, forceLogoutOtherSessions = false }) => {
  const userId = String(user._id);
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
  }

  const sessionId = Math.random().toString(36).substring(2);
  const updatedUser = await usersRepository.update(userId, {
    session: sessionId,
    device: device || null,
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
  const name = requireString(req.body?.name, 'name', { maxLength: 80 });
  const email = requireString(req.body?.email, 'email', { maxLength: 160 }).toLowerCase();
  const mobileNumber = optionalString(req.body?.mobileNumber, '', { maxLength: 20 });
  const password = validatePassword(req.body?.password);
  const device = optionalString(req.body?.device, 'web-dashboard', { maxLength: 120 });

  if (req.body?.role && req.body.role !== 'student') {
    throw new ApiError(403, 'Self-service registration can only create student accounts', {
      code: 'ROLE_NOT_ALLOWED',
    });
  }

  const existingEmail = await usersRepository.findByEmail(email);
  if (existingEmail) {
    throw new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
  }

  if (mobileNumber) {
    const existingMobile = await usersRepository.findByMobileNumber(mobileNumber);
    if (existingMobile) {
      throw new ApiError(409, 'Mobile number already exists', { code: 'MOBILE_EXISTS' });
    }
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await usersRepository.create({
    name,
    email,
    mobileNumber,
    password: hashed,
    role: 'student',
  });

  return created(res, await issueAuthSession({ user, device }));
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
