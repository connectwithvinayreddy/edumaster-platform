const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const { appConfig } = require('./lib/config.js');
const { securityHeaders } = require('./middleware/security.js');
const { notFoundHandler, errorHandler } = require('./middleware/error-handler.js');
const {
  HLS_ACCESS_COOKIE_NAME,
  verifyPlaybackToken,
  verifyManifestBundleSignature,
  decodeCompactAssetPath,
  resolvePrivateHlsPath,
  getProtectedAssetStorageRoot,
} = require('./lib/private-video.js');
const { sessionRepository } = require('./lib/repositories.js');
const {
  getPrivateStorageObjectBuffer,
  isS3Provider,
} = require('./lib/private-video-storage.js');
const { getHlsAssetMimeType } = require('./lib/hls-manifest.js');
const { loadManifestBundle } = require('./lib/manifest-bundle.js');
const {
  beginManifestRequest,
  recordBundleCacheStatus,
  recordAuthFailure,
  getManifestServiceMetricsSnapshot,
} = require('./lib/manifest-service-metrics.js');

const parseCorsOrigin = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '*') {
    return true;
  }
  const origins = normalized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return origins.length <= 1 ? origins[0] : origins;
};

const MANIFEST_ROUTE_PREFIX = '/course-manifests/b/';

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

  return payload;
};

const parseBundleRequest = (capturedPath) => {
  const segments = String(capturedPath || '')
    .split('/')
    .filter(Boolean);
  const providerMarkerIndex = segments.indexOf('_p');
  const versionMarkerIndex = segments.indexOf('_v');
  const expiresMarkerIndex = segments.indexOf('_e');
  const signatureMarkerIndex = segments.indexOf('_s');

  if (
    providerMarkerIndex <= 0
    || versionMarkerIndex !== providerMarkerIndex + 2
    || expiresMarkerIndex !== versionMarkerIndex + 2
    || signatureMarkerIndex !== expiresMarkerIndex + 2
    || signatureMarkerIndex + 2 >= segments.length
  ) {
    return null;
  }

  const bundlePath = decodeCompactAssetPath(segments.slice(0, providerMarkerIndex).join('/'));
  const storageProvider = decodeURIComponent(segments[providerMarkerIndex + 1] || '');
  const version = decodeURIComponent(segments[versionMarkerIndex + 1] || '');
  const exp = Number(segments[expiresMarkerIndex + 1] || 0);
  const sig = String(segments[signatureMarkerIndex + 1] || '');
  const assetPath = decodeCompactAssetPath(segments.slice(signatureMarkerIndex + 2).join('/'));

  if (!bundlePath || !storageProvider || !version || !assetPath) {
    return null;
  }

  return {
    bundlePath,
    storageProvider,
    version,
    exp,
    sig,
    assetPath,
  };
};

const setManifestCacheHeaders = (res, assetPath, cacheStatus) => {
  const isManifest = path.extname(String(assetPath || '')).toLowerCase() === '.m3u8';
  res.setHeader('X-Manifest-Bundle-Cache', cacheStatus || (isManifest ? 'miss' : 'n/a'));
  res.setHeader('X-Cache-Status', cacheStatus || (isManifest ? 'miss' : 'n/a'));
  res.setHeader('X-Cache-Detail', isManifest ? 'manifest-bundle' : 'manifest-segment');
  res.setHeader('X-Manifest-Asset-Kind', isManifest ? 'manifest' : 'segment');
  if (isManifest) {
    const ttl = Math.max(Number(appConfig.privateVideoHlsManifestCacheSeconds || 60), 60);
    res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 10}, stale-if-error=86400`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return;
  }

  const ttl = Math.max(Number(appConfig.privateVideoHlsSegmentCacheSeconds || 31_536_000), 300);
  res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=86400, stale-if-error=86400, immutable`);
  res.setHeader('Content-Type', getHlsAssetMimeType(assetPath));
};

const app = express();
app.set('trust proxy', appConfig.trustProxy);
app.disable('x-powered-by');
app.use(cors({ origin: parseCorsOrigin(appConfig.corsOrigin) }));
app.use(securityHeaders);

app.get(['/api/course-manifests/health', '/backend/api/course-manifests/health'], (_req, res) => {
  res.json({
    status: 'ok',
    service: 'course-manifest-service',
    timestamp: new Date().toISOString(),
  });
});

app.get(['/api/course-manifests/metrics', '/backend/api/course-manifests/metrics'], (_req, res) => {
  res.json(getManifestServiceMetricsSnapshot());
});

app.get(['/api/course-manifests/b/*', '/backend/api/course-manifests/b/*'], async (req, res, next) => {
  const relativePath = String(req.path || '').split(MANIFEST_ROUTE_PREFIX)[1] || req.params[0] || '';
  const parsed = parseBundleRequest(relativePath);
  const assetKind = path.extname(String(parsed?.assetPath || '')).toLowerCase() === '.m3u8' ? 'manifest' : 'segment';
  const requestTracker = beginManifestRequest({ assetKind });
  const authStarted = process.hrtime.bigint();
  let finished = false;
  const finish = (payload = {}) => {
    if (finished) {
      return;
    }
    finished = true;
    requestTracker.finish(payload);
  };

  try {
    if (!parsed || !verifyManifestBundleSignature({
      storageProvider: parsed.storageProvider,
      bundlePath: parsed.bundlePath,
      version: parsed.version,
    }, parsed.exp, parsed.sig)) {
      recordAuthFailure();
      res.status(401).json({ message: 'Manifest bundle signature is invalid or expired.' });
      finish();
      return;
    }
    const authLatencyMs = Number(process.hrtime.bigint() - authStarted) / 1_000_000;
    const storageRoot = getProtectedAssetStorageRoot(parsed.bundlePath);
    const hlsGrant = await getValidHlsGrantFromRequest(req, storageRoot);
    if (!hlsGrant) {
      recordAuthFailure();
      res.status(401).json({ message: 'Playback grant is missing or expired.' });
      finish({ authLatencyMs });
      return;
    }

    if (assetKind === 'manifest') {
      const bundleStarted = process.hrtime.bigint();
      const { bundle, cacheStatus } = await loadManifestBundle({
        storageProvider: parsed.storageProvider,
        bundlePath: parsed.bundlePath,
        version: parsed.version,
      });
      const bundleLoadLatencyMs = Number(process.hrtime.bigint() - bundleStarted) / 1_000_000;
      recordBundleCacheStatus(cacheStatus);

      if (!bundle || String(bundle.version || '') !== String(parsed.version || '')) {
        res.status(404).json({ message: 'Manifest bundle is unavailable.' });
        finish({ authLatencyMs, bundleLoadLatencyMs });
        return;
      }

      const manifestText = bundle.manifests?.[parsed.assetPath];
      if (!manifestText) {
        res.status(404).json({ message: 'Manifest asset not found.' });
        finish({ authLatencyMs, bundleLoadLatencyMs });
        return;
      }

      setManifestCacheHeaders(res, parsed.assetPath, cacheStatus);
      res.send(manifestText);
      finish({ authLatencyMs, bundleLoadLatencyMs });
      return;
    }

    const storagePath = path.posix.join(parsed.bundlePath, parsed.assetPath);
    if (isS3Provider(parsed.storageProvider)) {
      const assetBuffer = await getPrivateStorageObjectBuffer({
        storageProvider: parsed.storageProvider,
        storagePath,
      });

      if (!assetBuffer) {
        res.status(404).json({ message: 'HLS segment is unavailable.' });
        finish({ authLatencyMs });
        return;
      }

      setManifestCacheHeaders(res, parsed.assetPath, 'segment-proxy');
      res.send(assetBuffer);
      finish({ authLatencyMs });
      return;
    }

    const localAssetPath = resolvePrivateHlsPath(storagePath);
    if (!localAssetPath || !fs.existsSync(localAssetPath)) {
      res.status(404).json({ message: 'HLS segment not found.' });
      finish({ authLatencyMs });
      return;
    }

    setManifestCacheHeaders(res, parsed.assetPath, 'local');
    res.sendFile(localAssetPath);
    finish({ authLatencyMs });
  } catch (error) {
    finish();
    next(error);
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = Number(process.env.MANIFEST_PORT || 5001);
const HOST = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Manifest service running on ${HOST}:${PORT}`);
  });
}

module.exports = { app };
