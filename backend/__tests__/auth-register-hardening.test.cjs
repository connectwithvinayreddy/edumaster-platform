const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RATE_LIMIT_AUTH_MAX = process.env.RATE_LIMIT_AUTH_MAX || '1000';
process.env.RATE_LIMIT_AUTH_IP_MAX = process.env.RATE_LIMIT_AUTH_IP_MAX || '1000';
process.env.ALLOW_MEMORY_FALLBACK = process.env.ALLOW_MEMORY_FALLBACK || 'true';
process.env.ENABLE_BACKGROUND_WORKERS = 'false';

const { startServer } = require('../server.cjs');
const { getPool } = require('../lib/postgres.js');

let baseUrl = null;
let serverHandle = null;

const uniqueEmail = (label) => `register_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
const validPayload = (label) => ({
  name: `Register ${label}`,
  email: uniqueEmail(label),
  mobileNumber: `9${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`.slice(0, 10),
  password: 'Student@123',
});

const requestJson = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
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

test('valid register returns 201 JSON with requestId', async () => {
  const res = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validPayload('success')),
  });

  assert.equal(res.status, 201);
  assert.equal(typeof res.body.requestId, 'string');
  assert.equal(typeof res.headers['x-request-id'], 'string');
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.user.email.includes('@example.com'), true);
});

test('duplicate email returns 409 JSON', async () => {
  const payload = validPayload('duplicate-email');
  const first = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 201);

  const second = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      mobileNumber: validPayload('mobile-shift').mobileNumber,
    }),
  });

  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'EMAIL_EXISTS');
  assert.equal(typeof second.body.requestId, 'string');
});

test('duplicate email with different casing returns 409 JSON', async () => {
  const payload = validPayload('duplicate-case');
  const first = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 201);

  const second = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      email: payload.email.toUpperCase(),
      mobileNumber: validPayload('mobile-shift-case').mobileNumber,
    }),
  });

  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'EMAIL_EXISTS');
});

test('duplicate mobile with country-code variation returns 409 JSON', async () => {
  const baseMobile = `9${String(Date.now()).slice(-9)}`.slice(0, 10);
  const first = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validPayload('duplicate-mobile'),
      mobileNumber: baseMobile,
    }),
  });
  assert.equal(first.status, 201);

  const second = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validPayload('duplicate-mobile-second'),
      mobileNumber: `+91 ${baseMobile.slice(0, 5)} ${baseMobile.slice(5)}`,
    }),
  });

  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'MOBILE_EXISTS');
});

test('ten concurrent requests with same email produce one success and controlled duplicates only', async () => {
  const payload = validPayload('concurrent-same-email');
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => requestJson('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })),
  );

  const statuses = responses.map((res) => res.status);
  const successCount = statuses.filter((status) => status === 201).length;
  const duplicateCount = statuses.filter((status) => status === 409).length;
  const unexpected = responses.filter((res) => ![201, 409].includes(res.status));

  assert.equal(successCount, 1);
  assert.equal(duplicateCount, 9);
  assert.equal(unexpected.length, 0);
  responses.forEach((res) => assert.equal(typeof res.body.requestId, 'string'));
});

test('empty body returns controlled 400 JSON', async () => {
  const res = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(typeof res.body.requestId, 'string');
});

test('malformed JSON returns controlled 400 JSON', async () => {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"Broken"',
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_JSON');
  assert.equal(typeof body.requestId, 'string');
});

test('text/plain payload returns controlled 400 JSON', async () => {
  const res = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'plain-text-body',
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_CONTENT_TYPE');
  assert.equal(typeof res.body.requestId, 'string');
});

test('array payload returns controlled 400 JSON', async () => {
  const res = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([validPayload('array')]),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('number and boolean fields are rejected with controlled 400 JSON', async () => {
  const res = await requestJson('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: true,
      email: 123,
      mobileNumber: false,
      password: 987654321,
    }),
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});
