import path from 'node:path';
import { createRunContext, writeJson, writeText } from './utils.js';

const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const paymentRangeStart = process.env.QA_PAYMENT_RANGE_START || '2026-05-31';
const paymentRangeEnd = process.env.QA_PAYMENT_RANGE_END || '2026-05-31';

type JsonRecord = Record<string, unknown>;

const fetchJson = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
};

const login = async () => fetchJson('/backend/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: adminEmail,
    password: adminPassword,
    device: 'qa-historical-paid-row-repair',
    forceLogoutOtherSessions: true,
  }),
}) as Promise<{ token: string }>;

const adminRequest = async (token: string, pathname: string, init: RequestInit = {}) => {
  return fetchJson(pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
};

const main = async () => {
  const ctx = await createRunContext();
  const summary: JsonRecord = {
    baseUrl,
    startedAt: new Date().toISOString(),
  };

  const { token } = await login();
  const payload = {
    rangePreset: 'custom',
    startDate: paymentRangeStart,
    endDate: paymentRangeEnd,
    timezone: 'Asia/Kolkata',
    paymentMode: 'live',
    limit: 250,
    adminNote: 'Automation review for historical paid row repair',
  };

  const before = await adminRequest(token, `/backend/api/admin/payments/unverified-local-paid?rangePreset=custom&startDate=${encodeURIComponent(paymentRangeStart)}&endDate=${encodeURIComponent(paymentRangeEnd)}&timezone=Asia%2FKolkata&paymentMode=live&limit=250`);
  const dryRun = await adminRequest(token, '/backend/api/admin/payments/unverified-local-paid/repair', {
    method: 'POST',
    body: JSON.stringify({ ...payload, dryRun: true }),
  });
  const execute = await adminRequest(token, '/backend/api/admin/payments/unverified-local-paid/repair', {
    method: 'POST',
    body: JSON.stringify({ ...payload, dryRun: false }),
  });
  const after = await adminRequest(token, `/backend/api/admin/payments/unverified-local-paid?rangePreset=custom&startDate=${encodeURIComponent(paymentRangeStart)}&endDate=${encodeURIComponent(paymentRangeEnd)}&timezone=Asia%2FKolkata&paymentMode=live&limit=250`);
  const reconciliationAfter = await adminRequest(token, `/backend/api/admin/payments/reconciliation?rangePreset=custom&startDate=${encodeURIComponent(paymentRangeStart)}&endDate=${encodeURIComponent(paymentRangeEnd)}&timezone=Asia%2FKolkata&paymentMode=live`);

  Object.assign(summary, {
    before,
    dryRun,
    execute,
    after,
    reconciliationAfter,
  });

  const summaryPath = path.join(ctx.rootDir, 'historical-paid-row-repair-summary.json');
  const notesPath = path.join(ctx.rootDir, 'historical-paid-row-repair-summary.md');
  await writeJson(summaryPath, summary);
  await writeText(
    notesPath,
    [
      `Base URL: ${baseUrl}`,
      `Before unverified rows: ${JSON.stringify((before as JsonRecord).summary || {}, null, 2)}`,
      `Dry run: ${JSON.stringify((dryRun as JsonRecord).executionSummary || {}, null, 2)}`,
      `Execute: ${JSON.stringify((execute as JsonRecord).executionSummary || {}, null, 2)}`,
      `After unverified rows: ${JSON.stringify((after as JsonRecord).summary || {}, null, 2)}`,
      `Reconciliation cards after repair: ${JSON.stringify((reconciliationAfter as JsonRecord).cards || {}, null, 2)}`,
    ].join('\n'),
  );
  console.log(JSON.stringify({ summaryPath, notesPath }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
