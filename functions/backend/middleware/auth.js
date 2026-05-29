const jwt = require('jsonwebtoken');
const { appConfig } = require('../lib/config.js');
const { sessionRepository } = require('../lib/repositories.js');

const getTokenFromHeader = (header) => {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length).trim();
};

const attachUserFromToken = async (req, token) => {
  try {
    if (!token) {
      return false;
    }

    const decoded = jwt.verify(token, appConfig.jwtSecret);
    const persistedSessionId = decoded.session || null;
    const activeSessionId = appConfig.nodeEnv === 'production'
      ? await sessionRepository.getActiveSessionId(String(decoded.id), persistedSessionId)
      : persistedSessionId;

    if (appConfig.nodeEnv === 'production' && decoded.session) {
      const validSessionIds = [activeSessionId, persistedSessionId].filter(Boolean);
      if (validSessionIds.length > 0 && !validSessionIds.includes(decoded.session)) {
        return false;
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

    return true;
  } catch (error) {
    return false;
  }
};

const requireAuth = async (req, res, next) => {
  const token = getTokenFromHeader(req.headers.authorization || '');
  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  const attached = await attachUserFromToken(req, token);
  if (!attached) {
    return res.status(401).json({ message: 'Invalid token' });
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
