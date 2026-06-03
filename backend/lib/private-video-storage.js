const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { appConfig } = require('./config.js');
const {
  buildPrivateVideoStorageKey,
  resolvePrivateVideoPath,
  resolvePrivateHlsPath,
  ensureStorageDirectory,
} = require('./private-video.js');

let s3Client = null;
const signedPrivateUrlCache = new Map();
const signedPrivateUrlInFlight = new Map();

const hasS3Credentials = () => Boolean(
  appConfig.storageBucket
  && appConfig.storageRegion
  && appConfig.s3AccessKeyId
  && appConfig.s3SecretAccessKey,
);

const assertS3StorageConfigured = () => {
  if (!hasS3Credentials()) {
    throw new Error('Cloudflare R2 / S3-compatible object storage is not fully configured.');
  }
};

const inferStorageProvider = ({ storageProvider, storagePath }) => {
  if (storageProvider) {
    return storageProvider;
  }

  if (storagePath && path.isAbsolute(String(storagePath))) {
    return 'local';
  }

  return getPrivateVideoStorageProvider();
};

const getPrivateVideoStorageProvider = () => (
  appConfig.privateVideoStorageProvider === 's3' ? 's3' : 'local'
);

const isS3Provider = (value) => String(value || '').toLowerCase() === 's3';

const getS3Client = () => {
  if (s3Client) {
    return s3Client;
  }

  s3Client = new S3Client({
    region: appConfig.storageRegion,
    endpoint: appConfig.s3Endpoint || undefined,
    forcePathStyle: Boolean(appConfig.s3ForcePathStyle),
    credentials: {
      accessKeyId: appConfig.s3AccessKeyId,
      secretAccessKey: appConfig.s3SecretAccessKey,
    },
  });

  return s3Client;
};

const getSharedSignedUrlExpiresAtMs = () => {
  const ttlMs = Math.max(Number(appConfig.privateVideoDeliveryUrlTtlSeconds || 900), 60) * 1000;
  return Math.ceil((Date.now() + 1000) / ttlMs) * ttlMs;
};

const getSignedPrivateUrlCacheKey = ({ storagePath, mimeType }) => [
  String(storagePath || ''),
  String(mimeType || 'video/mp4'),
  String(getSharedSignedUrlExpiresAtMs()),
].join('|');

const buildStorageKeyFromUpload = ({ courseId, moduleId, lessonId, originalName }) =>
  buildPrivateVideoStorageKey({ courseId, moduleId, lessonId, originalName });

const storePrivateVideoUpload = async ({
  tempFilePath,
  courseId,
  moduleId,
  lessonId,
  originalName,
  mimeType,
}) => {
  const storageKey = buildStorageKeyFromUpload({
    courseId,
    moduleId,
    lessonId,
    originalName,
  });
  const provider = getPrivateVideoStorageProvider();

  if (provider === 's3') {
    assertS3StorageConfigured();
    await getS3Client().send(new PutObjectCommand({
      Bucket: appConfig.storageBucket,
      Key: storageKey,
      Body: fs.createReadStream(tempFilePath),
      ContentType: mimeType || 'video/mp4',
    }));
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    return {
      storageProvider: 's3',
      storagePath: storageKey,
      accessPolicy: {
        type: 'signed-object-url',
        drmReady: Boolean(appConfig.privateVideoDrmEnabled),
      },
    };
  }

  const localPath = resolvePrivateVideoPath(storageKey);
  if (!localPath) {
    throw new Error('Local private video path could not be resolved');
  }
  ensureStorageDirectory(localPath);
  fs.renameSync(tempFilePath, localPath);

  return {
    storageProvider: 'local',
    storagePath: storageKey,
    accessPolicy: {
      type: 'signed-stream',
      drmReady: Boolean(appConfig.privateVideoDrmEnabled),
    },
  };
};

const deleteStoredPrivateVideo = async ({ storageProvider, storagePath }) => {
  if (!storagePath) {
    return;
  }

  const provider = inferStorageProvider({ storageProvider, storagePath });
  if (provider === 's3' && hasS3Credentials()) {
    await getS3Client().send(new DeleteObjectCommand({
      Bucket: appConfig.storageBucket,
      Key: storagePath,
    }));
    return;
  }

  const localPath = resolvePrivateVideoPath(storagePath);
  if (localPath && fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
  }
};

const deleteStoredPrivateVideoPrefix = async ({ storageProvider, storagePathPrefix }) => {
  if (!storagePathPrefix) {
    return;
  }

  const provider = inferStorageProvider({ storageProvider, storagePath: storagePathPrefix });
  if (provider === 's3' && hasS3Credentials()) {
    let continuationToken;

    do {
      const response = await getS3Client().send(new ListObjectsV2Command({
        Bucket: appConfig.storageBucket,
        Prefix: String(storagePathPrefix),
        ContinuationToken: continuationToken,
      }));

      const keys = (response.Contents || [])
        .map((entry) => entry.Key)
        .filter(Boolean);

      await Promise.all(keys.map((key) => getS3Client().send(new DeleteObjectCommand({
        Bucket: appConfig.storageBucket,
        Key: key,
      }))));

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return;
  }

  const localPath = resolvePrivateVideoPath(storagePathPrefix);
  if (localPath && fs.existsSync(localPath)) {
    fs.rmSync(localPath, { recursive: true, force: true });
  }
};

const uploadPrivateStorageFile = async ({
  storageProvider,
  storagePath,
  localFilePath,
  contentType,
  cacheControl,
}) => {
  const provider = inferStorageProvider({ storageProvider, storagePath });
  if (provider !== 's3' || !hasS3Credentials()) {
    throw new Error('S3-compatible private storage is not configured.');
  }

  await getS3Client().send(new PutObjectCommand({
    Bucket: appConfig.storageBucket,
    Key: storagePath,
    Body: fs.createReadStream(localFilePath),
    ContentType: contentType || 'application/octet-stream',
    CacheControl: cacheControl || 'private, max-age=0, no-store',
  }));
};

const privateStorageObjectExists = async ({ storageProvider, storagePath }) => {
  const provider = inferStorageProvider({ storageProvider, storagePath });
  if (provider !== 's3' || !hasS3Credentials()) {
    if (provider === 's3') {
      throw new Error('Cloudflare R2 / S3-compatible object storage is not fully configured.');
    }
    const localVideoPath = resolvePrivateVideoPath(storagePath);
    const localHlsPath = resolvePrivateHlsPath(storagePath);
    return Boolean(
      (localVideoPath && fs.existsSync(localVideoPath))
      || (localHlsPath && fs.existsSync(localHlsPath)),
    );
  }

  try {
    await getS3Client().send(new HeadObjectCommand({
      Bucket: appConfig.storageBucket,
      Key: storagePath,
    }));
    return true;
  } catch (error) {
    const statusCode = Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
    const name = String(error?.name || error?.Code || '').toLowerCase();
    if (statusCode === 404 || name === 'notfound' || name === 'nosuchkey') {
      return false;
    }
    throw error;
  }
};

const getPrivateStorageObjectBuffer = async ({ storageProvider, storagePath }) => {
  const provider = inferStorageProvider({ storageProvider, storagePath });
  if (provider !== 's3' || !hasS3Credentials()) {
    if (provider === 's3') {
      throw new Error('Cloudflare R2 / S3-compatible object storage is not fully configured.');
    }
    const localVideoPath = resolvePrivateVideoPath(storagePath);
    const localHlsPath = resolvePrivateHlsPath(storagePath);
    const localPath = (localVideoPath && fs.existsSync(localVideoPath))
      ? localVideoPath
      : ((localHlsPath && fs.existsSync(localHlsPath)) ? localHlsPath : null);
    if (!localPath) {
      return null;
    }
    return fs.readFileSync(localPath);
  }

  const response = await getS3Client().send(new GetObjectCommand({
    Bucket: appConfig.storageBucket,
    Key: storagePath,
  }));

  if (!response.Body) {
    return null;
  }

  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

const downloadPrivateStorageObjectToFile = async ({ storageProvider, storagePath, destinationPath }) => {
  const provider = inferStorageProvider({ storageProvider, storagePath });
  if (!destinationPath) {
    throw new Error('Destination path is required for object download.');
  }

  ensureStorageDirectory(destinationPath);

  if (provider !== 's3' || !hasS3Credentials()) {
    if (provider === 's3') {
      throw new Error('Cloudflare R2 / S3-compatible object storage is not fully configured.');
    }
    const localVideoPath = resolvePrivateVideoPath(storagePath);
    const localHlsPath = resolvePrivateHlsPath(storagePath);
    const localPath = (localVideoPath && fs.existsSync(localVideoPath))
      ? localVideoPath
      : ((localHlsPath && fs.existsSync(localHlsPath)) ? localHlsPath : null);
    if (!localPath) {
      return false;
    }
    fs.copyFileSync(localPath, destinationPath);
    return true;
  }

  const response = await getS3Client().send(new GetObjectCommand({
    Bucket: appConfig.storageBucket,
    Key: storagePath,
  }));

  if (!response.Body) {
    return false;
  }

  await pipeline(response.Body, fs.createWriteStream(destinationPath));
  return true;
};

const getPrivateStorageObjectText = async ({ storageProvider, storagePath, encoding = 'utf8' }) => {
  const buffer = await getPrivateStorageObjectBuffer({ storageProvider, storagePath });
  return buffer ? buffer.toString(encoding) : null;
};

const getPrivateStorageObjectJson = async ({ storageProvider, storagePath }) => {
  const text = await getPrivateStorageObjectText({ storageProvider, storagePath, encoding: 'utf8' });
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const getSignedPrivateVideoUrl = async ({ storagePath, mimeType }) => {
  if (!storagePath) {
    return null;
  }

  if (getPrivateVideoStorageProvider() !== 's3' || !hasS3Credentials()) {
    if (getPrivateVideoStorageProvider() === 's3') {
      throw new Error('Cloudflare R2 / S3-compatible object storage is not fully configured.');
    }
    return null;
  }

  const cacheKey = getSignedPrivateUrlCacheKey({ storagePath, mimeType });
  const cached = signedPrivateUrlCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.url;
  }

  if (signedPrivateUrlInFlight.has(cacheKey)) {
    return signedPrivateUrlInFlight.get(cacheKey);
  }

  const pendingSignedUrl = getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: appConfig.storageBucket,
      Key: storagePath,
      ResponseContentType: mimeType || 'video/mp4',
    }),
    { expiresIn: appConfig.privateVideoDeliveryUrlTtlSeconds },
  ).then((url) => {
    signedPrivateUrlCache.set(cacheKey, {
      url,
      expiresAtMs: getSharedSignedUrlExpiresAtMs() - 1000,
    });
    return url;
  }).finally(() => {
    signedPrivateUrlInFlight.delete(cacheKey);
  });

  signedPrivateUrlInFlight.set(cacheKey, pendingSignedUrl);

  return pendingSignedUrl;
};

module.exports = {
  isS3Provider,
  getPrivateVideoStorageProvider,
  buildStorageKeyFromUpload,
  storePrivateVideoUpload,
  deleteStoredPrivateVideo,
  deleteStoredPrivateVideoPrefix,
  uploadPrivateStorageFile,
  privateStorageObjectExists,
  downloadPrivateStorageObjectToFile,
  getPrivateStorageObjectBuffer,
  getPrivateStorageObjectText,
  getPrivateStorageObjectJson,
  getSignedPrivateVideoUrl,
};
