const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

process.env.RATE_LIMIT_AUTH_MAX = process.env.RATE_LIMIT_AUTH_MAX || '1000';
process.env.RATE_LIMIT_AUTH_IP_MAX = process.env.RATE_LIMIT_AUTH_IP_MAX || '1000';
process.env.ALLOW_MEMORY_FALLBACK = process.env.ALLOW_MEMORY_FALLBACK || 'true';
process.env.ENABLE_BACKGROUND_WORKERS = 'false';

const { startServer } = require('../server.cjs');
const { getPool } = require('../lib/postgres.js');

let baseUrl = null;
let serverHandle = null;

const uniqueEmail = () => `content_protection_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;

const requestJson = async (pathName, { method = 'GET', token = '', body, headers = {} } = {}) => {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-edumaster-device-id': 'test-device-content-protection',
      'x-edumaster-playback-tab-id': 'test-tab-content-protection',
      'x-edumaster-client-platform': 'windows',
      'x-edumaster-client-browser': 'edge',
      'x-edumaster-app': 'web',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text ? JSON.parse(text) : null,
  };
};

test.before(async () => {
  const { server } = await startServer({ port: 0, host: '127.0.0.1' });
  serverHandle = server;
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    if (!serverHandle) {
      resolve();
      return;
    }
    serverHandle.close((error) => (error ? reject(error) : resolve()));
  });
  const pool = getPool();
  await pool?.end?.().catch(() => undefined);
});

test('suspicious protected-content endpoint requires auth and accepts authenticated events', async () => {
  const anonymous = await requestJson('/api/track/suspicious', {
    method: 'POST',
    body: {
      eventName: 'print-shortcut',
      source: 'test',
    },
  });
  assert.equal(anonymous.status, 401);

  const register = await requestJson('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Content Protection Student',
      email: uniqueEmail(),
      mobileNumber: `9${String(Date.now()).slice(-9)}`.slice(0, 10),
      password: 'Student@123',
    },
  });
  assert.equal(register.status, 201);
  assert.equal(typeof register.body.token, 'string');

  const logged = await requestJson('/api/track/suspicious', {
    method: 'POST',
    token: register.body.token,
    body: {
      eventName: 'print-shortcut',
      source: 'browser-content-protection',
      courseId: 'course-test',
      lessonId: 'lesson-test',
      timestamp: new Date().toISOString(),
    },
  });
  assert.equal(logged.status, 200);
  assert.equal(logged.body.accepted, true);
});

test('private uploads are not publicly served', async () => {
  const relativePath = path.join('private_uploads', 'course-pdfs', `public-bypass-${Date.now()}.pdf`);
  const absolutePath = path.join(process.cwd(), relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, '%PDF-1.4\n% protected test fixture\n');

  try {
    const response = await fetch(`${baseUrl}/${relativePath.replace(/\\/g, '/')}`);
    assert.equal(response.status, 404);
  } finally {
    await fs.unlink(absolutePath).catch(() => undefined);
  }
});
