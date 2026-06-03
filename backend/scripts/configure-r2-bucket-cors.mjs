import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(backendDir, '..');

const envFilePath = process.env.ENV_FILE
  ? path.resolve(rootDir, process.env.ENV_FILE)
  : path.resolve(rootDir, '.env');

const readEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Env file not found: ${filePath}`);
  }

  const values = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

const env = {
  ...readEnvFile(envFilePath),
  ...process.env,
};

const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_STREAM_ACCOUNT_ID || '').trim();
const bucketList = String(env.R2_MEDIA_CORS_BUCKETS || env.S3_BUCKET || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const endpoint = String(env.S3_ENDPOINT || '').trim()
  || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
const region = String(env.S3_REGION || 'auto').trim() || 'auto';
const accessKeyId = String(env.S3_ACCESS_KEY_ID || '').trim();
const secretAccessKey = String(env.S3_SECRET_ACCESS_KEY || '').trim();

const parseOrigins = (...valueSets) => {
  const values = [];
  for (const set of valueSets) {
    for (const raw of String(set || '').split(',')) {
      const value = raw.trim();
      if (!value || value === '*') {
        continue;
      }
      if (/^(https?|capacitor|ionic):\/\//i.test(value)) {
        values.push(value);
      }
    }
  }
  return [...new Set(values)];
};

const origins = parseOrigins(
  env.APP_URL,
  env.CORS_ORIGIN,
  env.VITE_API_URL,
  env.VITE_LIVE_HLS_BASE_URL,
);

if (!endpoint) {
  throw new Error('S3_ENDPOINT or CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_STREAM_ACCOUNT_ID is required.');
}
if (!bucketList.length) {
  throw new Error('S3_BUCKET or R2_MEDIA_CORS_BUCKETS must specify at least one bucket.');
}
if (!accessKeyId || !secretAccessKey) {
  throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.');
}
if (!origins.length) {
  throw new Error('No valid origins found. Set APP_URL or CORS_ORIGIN in the env file.');
}

const client = new S3Client({
  region,
  endpoint,
  forcePathStyle: false,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

const corsRule = {
  AllowedHeaders: ['*'],
  AllowedMethods: ['GET', 'HEAD'],
  AllowedOrigins: origins,
  ExposeHeaders: [
    'Accept-Ranges',
    'Content-Length',
    'Content-Range',
    'Content-Type',
    'ETag',
  ],
  MaxAgeSeconds: 86400,
};

const results = [];
for (const bucket of bucketList) {
  await client.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [corsRule],
    },
  }));

  const applied = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  results.push({
    bucket,
    endpoint,
    origins,
    corsRules: applied.CORSRules || [],
  });
}

console.log(JSON.stringify({
  envFilePath,
  endpoint,
  buckets: bucketList,
  origins,
  results,
}, null, 2));
