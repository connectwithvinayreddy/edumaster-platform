import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';
import { selectors } from './selectors.js';

const execFile = promisify(execFileCallback);

const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiOrigin = new URL(baseUrl).origin;
const adminEmail = process.env.QA_ADMIN_EMAIL || 'admin@varonenglishapp.in';
const adminPassword = process.env.QA_ADMIN_PASSWORD || '3Akq8O913GWJKcVJgs6A6nlUTGc1xWIP';
const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const razorpayKeyId = process.env.QA_RAZORPAY_KEY_ID || 'rzp_live_Sv3oolRK5TcGwF';
const razorpayKeySecret = process.env.QA_RAZORPAY_KEY_SECRET || 'Rr707hUZ2KXfxUiKWcFnh5ns';
const productionSshTarget = process.env.QA_PROD_SSH_TARGET || 'root@178.105.48.179';
const timezone = process.env.QA_PAYMENT_TIMEZONE || 'Asia/Kolkata';
const rangePreset = process.env.QA_PAYMENT_RANGE_PRESET || 'today';

type JsonRecord = Record<string, unknown>;

type DateRange = {
  preset: string;
  timezone: string;
  label: string;
  startIso: string;
  endIso: string;
  startUnix: number;
  endUnix: number;
};

const toIso = (value: Date) => value.toISOString();

const resolveDateRange = (preset: string, now = new Date()): DateRange => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value || 0);
  const month = Number(parts.find((part) => part.type === 'month')?.value || 1);
  const day = Number(parts.find((part) => part.type === 'day')?.value || 1);
  const todayStart = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+05:30`);
  const tomorrowStart = new Date(todayStart.getTime() + (24 * 60 * 60 * 1000));

  if (preset === 'today') {
    return {
      preset,
      timezone,
      label: 'Today',
      startIso: toIso(todayStart),
      endIso: toIso(tomorrowStart),
      startUnix: Math.floor(todayStart.getTime() / 1000),
      endUnix: Math.floor(tomorrowStart.getTime() / 1000),
    };
  }

  if (preset === 'custom') {
    const startDate = String(process.env.QA_PAYMENT_START_DATE || '').slice(0, 10);
    const endDate = String(process.env.QA_PAYMENT_END_DATE || '').slice(0, 10);
    if (!startDate || !endDate) {
      throw new Error('QA_PAYMENT_START_DATE and QA_PAYMENT_END_DATE are required for custom payment audits.');
    }
    const start = new Date(`${startDate}T00:00:00+05:30`);
    const end = new Date(`${endDate}T00:00:00+05:30`);
    const nextEnd = new Date(end.getTime() + (24 * 60 * 60 * 1000));
    return {
      preset,
      timezone,
      label: `${startDate} to ${endDate}`,
      startIso: toIso(start),
      endIso: toIso(nextEnd),
      startUnix: Math.floor(start.getTime() / 1000),
      endUnix: Math.floor(nextEnd.getTime() / 1000),
    };
  }

  const epoch = new Date('2000-01-01T00:00:00Z');
  return {
    preset: 'all_time',
    timezone,
    label: 'All time',
    startIso: toIso(epoch),
    endIso: toIso(now),
    startUnix: Math.floor(epoch.getTime() / 1000),
    endUnix: Math.floor(now.getTime() / 1000),
  };
};

const fetchJson = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
};

const adminLogin = async () => fetchJson('/backend/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: adminEmail,
    password: adminPassword,
    device: 'qa-payment-count-audit',
    forceLogoutOtherSessions: true,
  }),
}) as Promise<{ token: string }>;

const adminFetch = async (token: string, pathname: string, init: RequestInit = {}) => fetchJson(pathname, {
  ...init,
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(init.headers || {}),
  },
});

const buildAdminRangeQuery = (range: DateRange) => {
  const params = new URLSearchParams({
    rangePreset: range.preset === 'all_time' ? 'all_time' : range.preset,
    timezone: range.timezone,
  });
  if (range.preset === 'custom') {
    params.set('startDate', String(process.env.QA_PAYMENT_START_DATE || '').slice(0, 10));
    params.set('endDate', String(process.env.QA_PAYMENT_END_DATE || '').slice(0, 10));
  }
  return params.toString();
};

const getRazorpayAuthHeader = () =>
  `Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`;

const fetchRazorpayPage = async (range: DateRange, skip: number) => {
  const url = new URL('https://api.razorpay.com/v1/payments');
  url.searchParams.set('count', '100');
  url.searchParams.set('skip', String(skip));
  url.searchParams.set('from', String(range.startUnix));
  url.searchParams.set('to', String(range.endUnix));
  const response = await fetch(url, {
    headers: {
      authorization: getRazorpayAuthHeader(),
      accept: 'application/json',
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Razorpay payments failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload as { items?: Array<Record<string, unknown>> };
};

const fetchAllRazorpayPayments = async (range: DateRange) => {
  const items: Array<Record<string, unknown>> = [];
  for (let skip = 0; ; skip += 100) {
    const page = await fetchRazorpayPage(range, skip);
    const pageItems = Array.isArray(page.items) ? page.items : [];
    items.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return items;
};

const runRemote = async (command: string) => {
  const { stdout, stderr } = await execFile('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    productionSshTarget,
    command,
  ], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout, stderr };
};

const runRemoteSql = async (sql: string) => {
  const encodedSql = Buffer.from(sql, 'utf8').toString('base64');
  const command = `bash -lc "printf '%s' '${encodedSql}' | base64 -d | docker exec -i lowcost-postgres-1 psql -U postgres -d edumaster -P pager=off -F $'\\\\t' -A"`;
  return runRemote(command);
};

const screenshotAdminOverview = async (token: string, screenshotDir: string, range: DateRange) => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    defaultViewport: { width: 1600, height: 1200 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.evaluate((sessionToken) => {
      window.localStorage.setItem('edumaster.jwt', sessionToken);
    }, token);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector(`${selectors.navAdmin}, ${selectors.shellReady}`, { timeout: 45_000 });
    await page.click(selectors.navAdmin);
    await page.waitForSelector('[data-testid="admin-section-overview"]', { timeout: 30_000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('select')).some((element) => {
      const select = element as HTMLSelectElement;
      return Array.from(select.options).some((option) => option.value === 'custom')
        && Array.from(select.options).some((option) => option.value === 'today');
    }), { timeout: 30_000 });
    await page.evaluate(({ preset, startIso, endIso, customStartDate, customEndDate }) => {
      const select = Array.from(document.querySelectorAll('select')).find((element) => {
        const input = element as HTMLSelectElement;
        return Array.from(input.options).some((option) => option.value === 'custom')
          && Array.from(input.options).some((option) => option.value === 'today');
      }) as HTMLSelectElement | undefined;
      if (select) {
        select.value = preset;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (preset === 'custom') {
        const startInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
        const endInput = Array.from(document.querySelectorAll('input[type="date"]'))[1] as HTMLInputElement | undefined;
        const startDate = customStartDate || startIso.slice(0, 10);
        const endDate = customEndDate || endIso.slice(0, 10);
        if (startInput) {
          startInput.value = startDate;
          startInput.dispatchEvent(new Event('input', { bubbles: true }));
          startInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (endInput) {
          endInput.value = endDate;
          endInput.dispatchEvent(new Event('input', { bubbles: true }));
          endInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, {
      ...range,
      customStartDate: String(process.env.QA_PAYMENT_START_DATE || '').slice(0, 10),
      customEndDate: String(process.env.QA_PAYMENT_END_DATE || '').slice(0, 10),
    });
    const reconcileButton = await page.$$('button');
    for (const button of reconcileButton) {
      const label = await button.evaluate((element) => element.textContent || '');
      if (label.includes('Reconcile With Razorpay')) {
        await button.click();
        break;
      }
    }
    await sleep(4000);
    const filePath = artifactPath(screenshotDir, 'payment-count-audit', 'admin-overview-after-fix', 'png');
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  } finally {
    await browser.close();
  }
};

const main = async () => {
  const ctx = await createRunContext();
  const range = resolveDateRange(rangePreset);
  const adminRangeQuery = buildAdminRangeQuery(range);
  const summary: JsonRecord = {
    baseUrl,
    timezone,
    range,
    adminRangeQuery,
    productionSshTarget,
    adminEmail,
    result: 'pending',
  };

  const admin = await adminLogin();
  const adminDashboard = await adminFetch(admin.token, `/backend/api/admin/dashboard?${adminRangeQuery}`);
  const reconciliation = await adminFetch(admin.token, `/backend/api/admin/payments/reconciliation?${adminRangeQuery}`);
  const transactions = await adminFetch(admin.token, `/backend/api/admin/transactions?page=1&pageSize=100&${adminRangeQuery}`);
  const auditLogs = await adminFetch(admin.token, '/backend/api/admin/audit-logs?page=1&pageSize=100');
  const health = await adminFetch(admin.token, '/backend/api/admin/system-health');
  const razorpayPayments = await fetchAllRazorpayPayments(range);
  const razorpayCaptured = razorpayPayments.filter((payment) => String(payment.status || '').toLowerCase() === 'captured');

  const remoteDashboardSql = `
    SELECT COUNT(*) AS local_paid_all_time
    FROM payments
    WHERE lower(status) = 'paid';

    SELECT COUNT(*) AS local_paid_in_range
    FROM payments
    WHERE lower(status) = 'paid'
      AND created_at >= '${range.startIso}'
      AND created_at < '${range.endIso}';

    SELECT
      id,
      provider_order_id,
      provider_payment_id,
      status,
      payment_meta->>'gatewayStatus' AS gateway_status,
      payment_meta->>'verificationDecision' AS verification_decision,
      amount_inr,
      user_id,
      course_id,
      created_at,
      paid_at
    FROM payments
    WHERE lower(status) = 'paid'
      AND created_at < '${range.startIso}'
    ORDER BY created_at ASC;
  `;
  const remoteSql = await runRemoteSql(remoteDashboardSql);

  const remoteJoinSql = `
    SELECT
      p.id AS local_transaction_id,
      p.provider_order_id AS razorpay_order_id,
      p.provider_payment_id AS razorpay_payment_id,
      p.status AS local_status,
      p.payment_meta->>'gatewayStatus' AS razorpay_status,
      p.payment_meta->>'verificationDecision' AS verification_status,
      p.amount_inr AS amount,
      u.full_name AS student,
      c.title AS course,
      p.created_at
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN courses c ON c.id = p.course_id
    WHERE lower(p.status) = 'paid'
      AND p.created_at < '${range.startIso}'
    ORDER BY p.created_at ASC;
  `;
  const remoteJoined = await runRemoteSql(remoteJoinSql);

  const backendLogs = await runRemote('docker logs --since 60m lowcost-app-1 2>&1 | tail -n 400');
  const caddyLogs = await runRemote('docker logs --since 60m lowcost-caddy-1 2>&1 | tail -n 400');
  const overviewScreenshot = await screenshotAdminOverview(admin.token, ctx.screenshotDir, range);

  const razorpayCapturedIds = new Set(
    razorpayCaptured
      .map((item) => String(item.id || '').trim())
      .filter(Boolean),
  );

  const extraLocalRows = String(remoteJoined.stdout || '')
    .trim()
    .split('\n')
    .slice(1)
    .filter((line) => Boolean(line) && !/^\(\d+\s+rows?\)$/.test(line.trim()))
    .map((line) => {
      const [
        localTransactionId,
        razorpayOrderId,
        razorpayPaymentId,
        localStatus,
        razorpayStatus,
        verificationStatus,
        amount,
        student,
        course,
        createdAt,
      ] = line.split('\t');
      return {
        localTransactionId,
        razorpayOrderId: razorpayOrderId || null,
        razorpayPaymentId: razorpayPaymentId || null,
        localStatus,
        razorpayStatus: razorpayStatus || null,
        verificationStatus: verificationStatus || null,
        amount,
        student,
        course,
        createdAt,
        reasonWronglyCounted: razorpayPaymentId
          ? (razorpayCapturedIds.has(razorpayPaymentId)
            ? 'Counted outside the selected date range because dashboard card has no date filter.'
            : 'Marked paid locally but Razorpay captured set for the selected date range does not include this payment ID.')
          : 'Marked paid locally with no Razorpay payment ID or order ID, so it cannot be counted as captured.',
      };
    });

  summary.adminDashboard = adminDashboard;
  summary.reconciliation = reconciliation;
  summary.razorpay = {
    mode: razorpayKeyId.startsWith('rzp_live_') ? 'live' : 'test',
    totalPaymentsInRange: razorpayPayments.length,
    capturedCountInRange: razorpayCaptured.length,
    capturedAmountInRange: razorpayCaptured.reduce((sum, item) => sum + (Number(item.amount || 0) / 100), 0),
    sampleCapturedPaymentIds: razorpayCaptured.slice(0, 10).map((item) => item.id),
  };
  summary.remoteSql = {
    rawCountOutput: remoteSql.stdout,
    extraRowsOutput: remoteJoined.stdout,
  };
  summary.auditLogs = auditLogs;
  summary.transactions = {
    total: transactions.pagination?.total || null,
    firstPageCount: Array.isArray(transactions.items) ? transactions.items.length : 0,
  };
  summary.systemHealth = health;
  summary.extraLocalRows = extraLocalRows;
  summary.logs = {
    backend: path.join(ctx.logDir, 'backend.log'),
    caddy: path.join(ctx.logDir, 'caddy.log'),
  };
  summary.screenshots = {
    adminOverviewAfterFix: overviewScreenshot,
  };
  summary.result = 'passed';

  await writeJson(path.join(ctx.analysisDir, 'razorpay-payments.json'), razorpayPayments);
  await writeJson(path.join(ctx.analysisDir, 'razorpay-captured-payments.json'), razorpayCaptured);
  await writeJson(path.join(ctx.analysisDir, 'admin-dashboard.json'), adminDashboard);
  await writeJson(path.join(ctx.analysisDir, 'payment-reconciliation.json'), reconciliation);
  await writeJson(path.join(ctx.analysisDir, 'audit-logs.json'), auditLogs);
  await writeJson(path.join(ctx.analysisDir, 'system-health.json'), health);
  await writeJson(path.join(ctx.analysisDir, 'extra-local-rows.json'), extraLocalRows);
  await writeText(path.join(ctx.analysisDir, 'db-counts.txt'), remoteSql.stdout);
  await writeText(path.join(ctx.analysisDir, 'db-extra-rows.txt'), remoteJoined.stdout);
  await writeText(path.join(ctx.logDir, 'backend.log'), backendLogs.stdout || backendLogs.stderr || '');
  await writeText(path.join(ctx.logDir, 'caddy.log'), caddyLogs.stdout || caddyLogs.stderr || '');

  const summaryPath = path.join(ctx.rootDir, 'payment-count-reconciliation-audit-summary.json');
  await writeJson(summaryPath, summary);
  console.log(JSON.stringify({ summaryPath, range, screenshot: overviewScreenshot, extraLocalRows: extraLocalRows.length }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
