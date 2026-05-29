const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendEndListToMediaManifest } = require('./hls-manifest.js');
const {
  getPrivateStorageObjectJson,
  getPrivateStorageObjectText,
  uploadPrivateStorageFile,
} = require('./private-video-storage.js');
const { resolvePrivateHlsPath, ensureStorageDirectory } = require('./private-video.js');
const { getRedisJson, setRedisJson } = require('./redis.js');

const bundleMemoryCache = new Map();
const bundleLoadInFlight = new Map();

const BUNDLE_CACHE_TTL_SECONDS = 300;
const BUNDLE_REDIS_TTL_SECONDS = 86400;

const buildManifestBundleStorageKey = (manifestKey) => path.posix.join(
  path.posix.dirname(String(manifestKey || '')),
  'manifest.bundle.json',
);

const buildManifestBundleCacheKey = ({ storageProvider, bundlePath, version }) => [
  'edumaster',
  'manifest-bundle',
  'v1',
  String(storageProvider || 'local'),
  String(bundlePath || ''),
  String(version || 'v1'),
].join(':');

const getMemoryEntry = (cacheKey) => {
  const cached = bundleMemoryCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (cached.expiresAtMs <= Date.now()) {
    bundleMemoryCache.delete(cacheKey);
    return null;
  }
  return cached.value;
};

const setMemoryEntry = (cacheKey, value, ttlSeconds = BUNDLE_CACHE_TTL_SECONDS) => {
  bundleMemoryCache.set(cacheKey, {
    value,
    expiresAtMs: Date.now() + (Math.max(1, Number(ttlSeconds || BUNDLE_CACHE_TTL_SECONDS)) * 1000),
  });
  return value;
};

const collectManifestFiles = (directoryPath, rootDirectory, manifests) => {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      collectManifestFiles(fullPath, rootDirectory, manifests);
      return;
    }

    if (path.extname(entry.name).toLowerCase() !== '.m3u8') {
      return;
    }

    const relativePath = path.relative(rootDirectory, fullPath).split(path.sep).join(path.posix.sep);
    const manifestText = fs.readFileSync(fullPath, 'utf8');
    manifests[relativePath] = appendEndListToMediaManifest(manifestText);
  });
};

const createManifestBundleFromDirectory = ({
  outputDirectory,
  manifestKey,
  storageProvider,
  version,
}) => {
  const manifests = {};
  collectManifestFiles(outputDirectory, outputDirectory, manifests);

  return {
    version: String(version || Date.now()),
    generatedAt: new Date().toISOString(),
    storageProvider: String(storageProvider || 'local'),
    bundlePath: path.posix.dirname(String(manifestKey || '')),
    masterManifest: 'master.m3u8',
    manifests,
  };
};

const parseManifestReferences = (manifestText) => String(manifestText || '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .filter((line) => line.toLowerCase().endsWith('.m3u8'));

const createManifestBundleFromStorage = async ({
  storageProvider,
  manifestPath,
  version,
}) => {
  const bundlePath = path.posix.dirname(String(manifestPath || ''));
  const manifests = {};
  const queue = ['master.m3u8'];
  const visited = new Set();

  while (queue.length > 0) {
    const relativePath = queue.shift();
    if (!relativePath || visited.has(relativePath)) {
      continue;
    }
    visited.add(relativePath);

    const storagePath = path.posix.join(bundlePath, relativePath);
    const manifestText = await getPrivateStorageObjectText({
      storageProvider,
      storagePath,
    });
    if (!manifestText) {
      continue;
    }

    manifests[relativePath] = appendEndListToMediaManifest(manifestText);
    parseManifestReferences(manifestText).forEach((reference) => {
      const childPath = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), reference));
      if (!visited.has(childPath)) {
        queue.push(childPath);
      }
    });
  }

  return {
    version: String(version || 'legacy'),
    generatedAt: new Date().toISOString(),
    storageProvider: String(storageProvider || 'local'),
    bundlePath,
    masterManifest: 'master.m3u8',
    manifests,
  };
};

const writeManifestBundleToDirectory = ({ outputDirectory, bundle }) => {
  fs.writeFileSync(
    path.join(outputDirectory, 'manifest.bundle.json'),
    JSON.stringify(bundle, null, 2),
  );
};

const storeManifestBundle = async ({
  storageProvider,
  bundlePath,
  bundle,
}) => {
  const storagePath = path.posix.join(String(bundlePath || ''), 'manifest.bundle.json');
  if (String(storageProvider || 'local') !== 's3') {
    const localPath = resolvePrivateHlsPath(storagePath);
    if (!localPath) {
      throw new Error('Unable to resolve local manifest bundle path.');
    }
    ensureStorageDirectory(localPath);
    fs.writeFileSync(localPath, JSON.stringify(bundle, null, 2));
    return storagePath;
  }

  const tempFilePath = path.join(os.tmpdir(), `manifest-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(tempFilePath, JSON.stringify(bundle, null, 2));
  try {
    await uploadPrivateStorageFile({
      storageProvider,
      storagePath,
      localFilePath: tempFilePath,
      contentType: 'application/json',
      cacheControl: 'private, max-age=300, stale-while-revalidate=3600',
    });
  } finally {
    fs.unlinkSync(tempFilePath);
  }
  return storagePath;
};

const loadManifestBundle = async ({
  storageProvider,
  bundlePath,
  version,
}) => {
  const cacheKey = buildManifestBundleCacheKey({ storageProvider, bundlePath, version });
  const memoryCached = getMemoryEntry(cacheKey);
  if (memoryCached) {
    return { bundle: memoryCached, cacheStatus: 'memory' };
  }

  try {
    const redisCached = await getRedisJson(cacheKey);
    if (redisCached) {
      return {
        bundle: setMemoryEntry(cacheKey, redisCached),
        cacheStatus: 'redis',
      };
    }
  } catch {
    // Ignore Redis read failures and fall through to storage.
  }

  if (bundleLoadInFlight.has(cacheKey)) {
    return bundleLoadInFlight.get(cacheKey);
  }

  const pendingLoad = (async () => {
    const manifestBundlePath = path.posix.join(String(bundlePath || ''), 'manifest.bundle.json');
    const bundle = await getPrivateStorageObjectJson({
      storageProvider,
      storagePath: manifestBundlePath,
    });
    if (!bundle) {
      return { bundle: null, cacheStatus: 'miss' };
    }

    setMemoryEntry(cacheKey, bundle);
    try {
      await setRedisJson(cacheKey, bundle, {
        ttlSeconds: BUNDLE_REDIS_TTL_SECONDS,
      });
    } catch {
      // Ignore Redis write failures.
    }

    return { bundle, cacheStatus: 'storage' };
  })().finally(() => {
    bundleLoadInFlight.delete(cacheKey);
  });

  bundleLoadInFlight.set(cacheKey, pendingLoad);
  return pendingLoad;
};

module.exports = {
  buildManifestBundleStorageKey,
  createManifestBundleFromDirectory,
  createManifestBundleFromStorage,
  writeManifestBundleToDirectory,
  storeManifestBundle,
  loadManifestBundle,
};
