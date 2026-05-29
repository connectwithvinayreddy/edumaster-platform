const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const GOOGLE_SECURETOKEN_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CERT_CACHE_MIN_TTL_MS = 60_000;

let cachedProjectId = null;
let cachedCerts = null;
let cachedCertsExpiresAt = 0;

const loadFirebaseProjectId = () => {
  if (cachedProjectId) {
    return cachedProjectId;
  }

  const explicitProjectId = String(
    process.env.FIREBASE_WEB_PROJECT_ID
    || process.env.VITE_FIREBASE_PROJECT_ID
    || process.env.FIREBASE_PROJECT_ID
    || '',
  ).trim();
  if (explicitProjectId) {
    cachedProjectId = explicitProjectId;
    return cachedProjectId;
  }

  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    return '';
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    cachedProjectId = String(parsed?.projectId || '').trim();
    return cachedProjectId;
  } catch (error) {
    return '';
  }
};

const parseMaxAgeMs = (cacheControl) => {
  const matched = String(cacheControl || '').match(/max-age=(\d+)/i);
  if (!matched) {
    return 3_600_000;
  }
  const seconds = Number(matched[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 3_600_000;
  }
  return seconds * 1000;
};

const loadGoogleSecureTokenCerts = async () => {
  if (cachedCerts && Date.now() < cachedCertsExpiresAt) {
    return cachedCerts;
  }

  const response = await fetch(GOOGLE_SECURETOKEN_CERTS_URL);
  if (!response.ok) {
    throw new Error(`Unable to load Firebase auth certificates (${response.status})`);
  }

  const payload = await response.json();
  const maxAgeMs = Math.max(parseMaxAgeMs(response.headers.get('cache-control')), CERT_CACHE_MIN_TTL_MS);
  cachedCerts = payload;
  cachedCertsExpiresAt = Date.now() + maxAgeMs;
  return cachedCerts;
};

const verifyFirebaseIdToken = async (idToken) => {
  const token = String(idToken || '').trim();
  if (!token) {
    throw new Error('Missing Firebase ID token');
  }

  const projectId = loadFirebaseProjectId();
  if (!projectId) {
    throw new Error('Firebase project ID is not configured');
  }

  const decodedHeader = jwt.decode(token, { complete: true });
  const keyId = decodedHeader?.header?.kid;
  const algorithm = decodedHeader?.header?.alg;
  if (!keyId || algorithm !== 'RS256') {
    throw new Error('Invalid Firebase token header');
  }

  const certs = await loadGoogleSecureTokenCerts();
  const certificate = certs?.[keyId];
  if (!certificate) {
    throw new Error('Unable to find Firebase certificate for token');
  }

  const payload = jwt.verify(token, certificate, {
    algorithms: ['RS256'],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });

  if (!payload?.sub || typeof payload.sub !== 'string') {
    throw new Error('Firebase token subject is missing');
  }

  return payload;
};

module.exports = {
  verifyFirebaseIdToken,
  loadFirebaseProjectId,
};
