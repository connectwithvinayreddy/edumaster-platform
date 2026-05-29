const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { appConfig } = require('./config.js');

const privateVideosRoot = path.join(process.cwd(), 'private_uploads', 'videos');
const privateHlsRoot = path.join(process.cwd(), 'private_uploads', 'hls');
const HLS_ACCESS_COOKIE_NAME = 'edumaster_hls';

const ensurePrivateVideoRoot = () => {
  if (!fs.existsSync(privateVideosRoot)) {
    fs.mkdirSync(privateVideosRoot, { recursive: true });
  }

  if (!fs.existsSync(privateHlsRoot)) {
    fs.mkdirSync(privateHlsRoot, { recursive: true });
  }
};

const toBase64Url = (value) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value) => Buffer.from(value, 'base64url').toString('utf8');
const getSigningSecret = () => appConfig.privateVideoTokenSecret || appConfig.jwtSecret;
const signEncodedPayload = (encodedPayload) => crypto
  .createHmac('sha256', getSigningSecret())
  .update(encodedPayload)
  .digest('base64url');
const signCompactAssetPayload = (payload) => crypto
  .createHmac('sha256', getSigningSecret())
  .update(String(payload || ''))
  .digest('base64url');

const createStorageFileName = (lessonId, originalName = '') => {
  const extension = path.extname(String(originalName || '')).slice(0, 12) || '.mp4';
  return `${lessonId}${extension}`;
};

const buildPrivateVideoStorageKey = ({ courseId, moduleId, lessonId, originalName }) => {
  const safeCourseId = String(courseId || 'course').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeModuleId = String(moduleId || 'module').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = createStorageFileName(lessonId, originalName);
  return path.posix.join(safeCourseId, safeModuleId, fileName);
};

const buildPrivateVideoStoragePath = ({ courseId, moduleId, lessonId, originalName }) => {
  ensurePrivateVideoRoot();
  return path.join(privateVideosRoot, buildPrivateVideoStorageKey({
    courseId,
    moduleId,
    lessonId,
    originalName,
  }));
};

const buildPrivateHlsAssetKey = ({ courseId, moduleId, lessonId, assetName = 'master.m3u8' }) => {
  const safeCourseId = String(courseId || 'course').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeModuleId = String(moduleId || 'module').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeLessonId = String(lessonId || 'lesson').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeAssetName = String(assetName || 'master.m3u8').replace(/[^a-zA-Z0-9._/-]/g, '_');
  return path.posix.join(safeCourseId, safeModuleId, safeLessonId, safeAssetName);
};

const resolvePrivateHlsPath = (assetPath) => {
  if (!assetPath) {
    return null;
  }

  const rawValue = String(assetPath);
  const candidate = path.isAbsolute(rawValue)
    ? rawValue
    : path.join(privateHlsRoot, rawValue);
  const resolved = path.resolve(candidate);
  const allowedRoot = path.resolve(privateHlsRoot);
  const normalizedRoot = `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(normalizedRoot)) {
    return null;
  }

  return resolved;
};

const ensureStorageDirectory = (filePath) => {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
};

const issuePlaybackToken = (payload, options = {}) => {
  const ttlSeconds = Number(options.ttlSeconds || appConfig.privateVideoTokenTtlSeconds);
  const requestedExpiresAt = Number(options.expiresAtMs || 0);
  const expiresAt = Number.isFinite(requestedExpiresAt) && requestedExpiresAt > Date.now()
    ? requestedExpiresAt
    : Date.now() + (ttlSeconds * 1000);
  const tokenPayload = {
    ...payload,
    exp: expiresAt,
  };
  const encodedPayload = toBase64Url(JSON.stringify(tokenPayload));
  const signature = signEncodedPayload(encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

const buildCompactAssetSignaturePayload = ({
  storageProvider,
  storagePath,
  cacheScope,
  exp,
}) => [
  'v1',
  String(storageProvider || ''),
  String(storagePath || ''),
  String(cacheScope || ''),
  String(exp || ''),
].join('|');

const issueCompactAssetSignature = (payload, options = {}) => {
  const ttlSeconds = Number(options.ttlSeconds || appConfig.privateVideoTokenTtlSeconds);
  const requestedExpiresAt = Number(options.expiresAtMs || 0);
  const expiresAt = Number.isFinite(requestedExpiresAt) && requestedExpiresAt > Date.now()
    ? requestedExpiresAt
    : Date.now() + (ttlSeconds * 1000);
  const signaturePayload = buildCompactAssetSignaturePayload({
    ...payload,
    exp: expiresAt,
  });

  return {
    exp: expiresAt,
    sig: signCompactAssetPayload(signaturePayload),
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

const buildManifestBundleSignaturePayload = ({
  storageProvider,
  bundlePath,
  version,
  exp,
}) => [
  'v2-manifest-bundle',
  String(storageProvider || ''),
  String(bundlePath || ''),
  String(version || ''),
  String(exp || ''),
].join('|');

const issueManifestBundleSignature = (payload, options = {}) => {
  const ttlSeconds = Number(options.ttlSeconds || appConfig.privateVideoHlsSegmentTokenTtlSeconds || appConfig.privateVideoTokenTtlSeconds);
  const requestedExpiresAt = Number(options.expiresAtMs || 0);
  const expiresAt = Number.isFinite(requestedExpiresAt) && requestedExpiresAt > Date.now()
    ? requestedExpiresAt
    : Date.now() + (ttlSeconds * 1000);
  const signaturePayload = buildManifestBundleSignaturePayload({
    ...payload,
    exp: expiresAt,
  });

  return {
    exp: expiresAt,
    sig: signCompactAssetPayload(signaturePayload),
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

const encodeCompactAssetPath = (assetPath) => String(assetPath || '')
  .split('/')
  .filter(Boolean)
  .map((segment) => encodeURIComponent(segment))
  .join('/');

const decodeCompactAssetPath = (assetPath) => String(assetPath || '')
  .split('/')
  .filter(Boolean)
  .map((segment) => decodeURIComponent(segment))
  .join('/');

const getSharedCompactAssetExpiresAt = (ttlSeconds = appConfig.privateVideoHlsSegmentTokenTtlSeconds) => {
  const ttlMs = Math.max(Number(ttlSeconds || 3600), 300) * 1000;
  return Math.ceil((Date.now() + 1000) / ttlMs) * ttlMs;
};

const buildCompactAssetUrl = (payload, options = {}) => {
  const routeBase = String(options.routeBase || '/backend/api/courses/h').replace(/\/+$/, '');
  const issued = issueCompactAssetSignature(payload, {
    ttlSeconds: options.ttlSeconds,
    expiresAtMs: options.expiresAtMs || getSharedCompactAssetExpiresAt(options.ttlSeconds),
  });
  const params = new URLSearchParams({
    e: String(issued.exp),
    s: issued.sig,
  });
  if (payload.storageProvider) {
    params.set('p', String(payload.storageProvider));
  }

  return {
    url: `${routeBase}/${encodeCompactAssetPath(payload.storagePath)}?${params.toString()}`,
    expiresAt: issued.expiresAt,
    exp: issued.exp,
    sig: issued.sig,
  };
};

const buildManifestBundleUrl = (payload, options = {}) => {
  const routeBase = String(options.routeBase || '/backend/api/course-manifests/b').replace(/\/+$/, '');
  const assetPath = String(options.assetPath || payload.assetPath || 'master.m3u8');
  const issued = issueManifestBundleSignature(payload, {
    ttlSeconds: options.ttlSeconds,
    expiresAtMs: options.expiresAtMs || getSharedCompactAssetExpiresAt(options.ttlSeconds),
  });
  const encodedBundlePath = encodeCompactAssetPath(payload.bundlePath);
  const encodedAssetPath = encodeCompactAssetPath(assetPath);
  const encodedVersion = encodeURIComponent(String(payload.version || 'v1'));
  const encodedProvider = encodeURIComponent(String(payload.storageProvider || 'local'));

  return {
    url: `${routeBase}/${encodedBundlePath}/_p/${encodedProvider}/_v/${encodedVersion}/_e/${issued.exp}/_s/${issued.sig}/${encodedAssetPath}`,
    expiresAt: issued.expiresAt,
    exp: issued.exp,
    sig: issued.sig,
  };
};

const verifyPlaybackToken = (token) => {
  const [encodedPayload, providedSignature] = String(token || '').split('.');
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signEncodedPayload(encodedPayload);

  if (providedSignature.length !== expectedSignature.length) {
    return null;
  }

  const signaturesMatch = crypto.timingSafeEqual(
    Buffer.from(providedSignature),
    Buffer.from(expectedSignature),
  );

  if (!signaturesMatch) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload));
    if (!payload?.exp || Number(payload.exp) < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

const verifyCompactAssetSignature = (payload, exp, sig) => {
  const expiresAt = Number(exp || 0);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !sig) {
    return false;
  }

  const expectedSignature = signCompactAssetPayload(buildCompactAssetSignaturePayload({
    ...payload,
    exp: expiresAt,
  }));

  if (String(sig).length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(String(sig)),
    Buffer.from(expectedSignature),
  );
};

const verifyManifestBundleSignature = (payload, exp, sig) => {
  const expiresAt = Number(exp || 0);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !sig) {
    return false;
  }

  const expectedSignature = signCompactAssetPayload(buildManifestBundleSignaturePayload({
    ...payload,
    exp: expiresAt,
  }));

  if (String(sig).length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(String(sig)),
    Buffer.from(expectedSignature),
  );
};

const resolvePrivateVideoPath = (storagePath) => {
  if (!storagePath) {
    return null;
  }

  const rawValue = String(storagePath);
  const candidate = path.isAbsolute(rawValue)
    ? rawValue
    : path.join(privateVideosRoot, rawValue);
  const resolved = path.resolve(candidate);
  const allowedRoot = path.resolve(privateVideosRoot);
  const normalizedRoot = `${allowedRoot}${path.sep}`;
  if (resolved !== allowedRoot && !resolved.startsWith(normalizedRoot)) {
    return null;
  }

  return resolved;
};

const getProtectedAssetStorageRoot = (assetPath) => String(assetPath || '')
  .split('/')
  .filter(Boolean)
  .slice(0, 3)
  .join('/');

module.exports = {
  HLS_ACCESS_COOKIE_NAME,
  privateVideosRoot,
  privateHlsRoot,
  ensurePrivateVideoRoot,
  buildPrivateVideoStorageKey,
  buildPrivateVideoStoragePath,
  buildPrivateHlsAssetKey,
  ensureStorageDirectory,
  issuePlaybackToken,
  issueCompactAssetSignature,
  issueManifestBundleSignature,
  buildCompactAssetUrl,
  buildManifestBundleUrl,
  verifyPlaybackToken,
  verifyCompactAssetSignature,
  verifyManifestBundleSignature,
  encodeCompactAssetPath,
  decodeCompactAssetPath,
  getProtectedAssetStorageRoot,
  resolvePrivateVideoPath,
  resolvePrivateHlsPath,
};
