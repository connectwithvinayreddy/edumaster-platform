const jwt = require('jsonwebtoken');
const { appConfig } = require('../lib/config.js');
const { sessionRepository, usersRepository } = require('../lib/repositories.js');

const getTokenFromHeader = (header) => {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length).trim();
};

const buildAuthFailure = (code, message, details = {}) => ({
  code,
  message,
  details,
});

const attachUserFromToken = async (req, token) => {
  try {
    if (!token) {
      return buildAuthFailure('AUTH_TOKEN_MISSING', 'Authorization token required');
    }

    const decoded = jwt.verify(token, appConfig.jwtSecret);
    const persistedSessionId = decoded.session || null;
    const activeSessionId = appConfig.nodeEnv === 'production'
      ? await sessionRepository.getActiveSessionId(String(decoded.id), null)
      : persistedSessionId;

    if (appConfig.nodeEnv === 'production') {
      if (!persistedSessionId) {
        console.warn('[auth-session]', JSON.stringify({
          user_id: decoded?.id ? String(decoded.id) : null,
          reason: 'missing_session_claim',
        }));
        return buildAuthFailure('AUTH_SESSION_MISSING', 'Session is missing from token.', {
          reason: 'missing_session_claim',
        });
      }

      if (!activeSessionId || String(activeSessionId) !== String(persistedSessionId)) {
        console.warn('[auth-session]', JSON.stringify({
          user_id: decoded?.id ? String(decoded.id) : null,
          token_session_id: String(persistedSessionId),
          active_session_id: activeSessionId ? String(activeSessionId) : null,
          reason: 'replaced_or_inactive_session_token',
        }));
        return buildAuthFailure('AUTH_SESSION_REPLACED', 'This login session was replaced by a newer login.', {
          reason: 'replaced_or_inactive_session_token',
          activeSessionId: activeSessionId ? String(activeSessionId) : null,
        });
      }
    }

    req.user = {
      id: String(decoded.id),
      role: decoded.role || 'student',
      session: persistedSessionId,
      profile: {
        _id: String(decoded.id),
        email: decoded.email || null,
        name: decoded.name || null,
        role: decoded.role || 'student',
        session: persistedSessionId,
      },
    };

    const currentUser = await usersRepository.findSafeById(String(decoded.id)).catch(() => null);
    if (currentUser && String(currentUser.accountStatus || 'active').toLowerCase() !== 'active') {
      return buildAuthFailure('ACCOUNT_DISABLED', 'This account is no longer active.', {
        accountStatus: String(currentUser.accountStatus || 'disabled').toLowerCase(),
      });
    }

    return null;
  } catch (error) {
    return buildAuthFailure('AUTH_TOKEN_INVALID', 'Invalid token');
  }
};

const requireAuth = async (req, res, next) => {
  const token = getTokenFromHeader(req.headers.authorization || '');
  if (!token) {
    return res.status(401).json({
      message: 'Authorization token required',
      code: 'AUTH_TOKEN_MISSING',
    });
  }

  const failure = await attachUserFromToken(req, token);
  if (failure) {
    return res.status(401).json(failure);
  }

  return next();
};

const attachAuthIfPresent = async (req, _res, next) => {
  const token = getTokenFromHeader(req.headers.authorization || '');
  await attachUserFromToken(req, token);
  return next();
};

module.exports = {
  requireAuth,
  attachAuthIfPresent,
  attachUserFromToken,
};
