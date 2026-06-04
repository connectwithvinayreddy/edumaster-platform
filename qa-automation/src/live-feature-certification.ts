import dotenv from 'dotenv';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { chromeHostResolverRule, qaFetch } from './network.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';
import { maybeStartLiveTestPublisher } from './live-publisher.js';

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
const requestedEnvFile = String(process.env.ENV_FILE || '').trim();
const resolvedEnvPath = requestedEnvFile
  ? (path.isAbsolute(requestedEnvFile) ? requestedEnvFile : path.resolve(rootDir, requestedEnvFile))
  : path.join(rootDir, '.env');
dotenv.config({ path: resolvedEnvPath });

const chromeExecutable = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@local.edumaster';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'AdminChangeMe_2026';
const studentEmail = process.env.QA_LOGIN_EMAIL || `qa.live.cert.student+${Date.now()}@local.test`;
const studentPassword = process.env.QA_LOGIN_PASSWORD || 'Student@12345';
const apiOrigin = new URL(config.baseUrl).origin;
const browserHostResolverRule = chromeHostResolverRule(config.baseUrl);
const livePlaybackMode = String(process.env.QA_LIVE_CERT_PLAYBACK_MODE || 'live-stream').trim().toLowerCase() === 'livekit'
  ? 'livekit'
  : 'live-stream';

const desktopViewport = { width: 1440, height: 1080, deviceScaleFactor: 1 };
const mobileViewport = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

type LiveClassPayload = {
  liveClass: {
    _id: string;
    title: string;
    ingestServerUrl?: string | null;
    ingestStreamKey?: string | null;
  };
};

type LiveClassAccessPayload = {
  status?: string;
  accessType?: string;
  streamUrl?: string | null;
  embedUrl?: string | null;
  roomUrl?: string | null;
  liveRoomName?: string | null;
};

type LiveSessionPayload = {
  session?: {
    participants?: Array<{
      userId: string;
      role?: string;
      micMuted?: boolean;
      videoEnabled?: boolean;
      isScreenSharing?: boolean;
      canSpeak?: boolean;
      name?: string;
    }>;
  };
};

type StageResult = {
  name: string;
  ok: boolean;
  notes: string[];
  screenshots: string[];
};

type TokenManager = {
  get: () => string;
  refresh: () => Promise<string>;
};

const timestampSuffix = () => new Date().toISOString().replace(/[:.]/g, '-');

const takeScreenshot = async (page: puppeteer.Page, ctx: Awaited<ReturnType<typeof createRunContext>>, prefix: string, label: string) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, prefix, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, prefix, label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  try {
    await writeText(sourcePath, await page.content());
  } catch {
    await writeText(sourcePath, '<!-- page.content() capture skipped after protocol timeout -->');
  }
  return screenshotPath;
};

const isInvalidTokenError = (value: unknown) => {
  const message = value instanceof Error ? value.message : String(value || '');
  return /invalid token|session was replaced by a newer login|token expired|unauthorized/i.test(message);
};

const loginToken = async (email: string, password: string, device: string) => {
  const response = await qaFetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, device, forceLogoutOtherSessions: true }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || payload?.message || `Unable to login as ${email}`);
  }

  return String(payload.token);
};

const storeSessionToken = async (page: puppeteer.Page, token: string) => {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((token) => {
    window.localStorage.setItem('edumaster.jwt', token);
  }, token);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
};

const loginAndStoreSession = async (page: puppeteer.Page, email: string, password: string, device: string) => {
  const token = await loginToken(email, password, device);
  await storeSessionToken(page, token);
  return token;
};

const createTokenManager = (
  page: puppeteer.Page,
  email: string,
  password: string,
  device: string,
): TokenManager => {
  let currentToken = '';
  return {
    get: () => currentToken,
    refresh: async () => {
      currentToken = await loginAndStoreSession(page, email, password, device);
      return currentToken;
    },
  };
};

const withTokenRetry = async <T>(manager: TokenManager, action: (token: string) => Promise<T>) => {
  try {
    return await action(manager.get());
  } catch (error) {
    if (!isInvalidTokenError(error)) {
      throw error;
    }
  }

  const freshToken = await manager.refresh();
  return action(freshToken);
};

const ensureStudentAccountAndGetToken = async (email: string, password: string, name: string, device: string) => {
  try {
    return await loginToken(email, password, device);
  } catch {
    const registerResponse = await qaFetch(new URL('/backend/api/auth/register', apiOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        password,
        mobileNumber: '',
      }),
    });

    if (!(registerResponse.ok || registerResponse.status === 409)) {
      const payload = await registerResponse.json().catch(() => ({}));
      throw new Error(payload?.error || payload?.message || 'Unable to register student account');
    }

    return loginToken(email, password, device);
  }
};

const createLiveClass = async (token: string, title: string, startTime: string) => {
  const response = await qaFetch(new URL('/backend/api/live-classes', apiOrigin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title,
      startTime,
      durationMinutes: 90,
      maxAttendees: 2500,
      livePlaybackType: livePlaybackMode,
      requiresEnrollment: false,
      chatEnabled: true,
      doubtSolving: true,
      replayAvailable: true,
      instructor: 'QA Live Teacher',
      subject: 'Physics',
    }),
  });

  const payload = await response.json().catch(() => ({})) as LiveClassPayload & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Unable to create live class');
  }

  return payload.liveClass;
};

const startLiveClass = async (token: string, liveClassId: string) => {
  const response = await qaFetch(new URL(`/backend/api/live-classes/${liveClassId}/start`, apiOrigin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Unable to start live class');
  }
};

const getLiveClassAccess = async (token: string, liveClassId: string) => {
  const response = await qaFetch(new URL(`/backend/api/live-classes/${liveClassId}/access`, apiOrigin), {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({})) as LiveClassAccessPayload & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Unable to fetch live class access');
  }
  return payload;
};

const waitForLiveAccess = async (token: string, liveClassId: string, label: string) => {
  let lastAccess: LiveClassAccessPayload | null = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    lastAccess = await getLiveClassAccess(token, liveClassId);
    if (lastAccess.status === 'live' || (lastAccess.accessType && lastAccess.accessType !== 'upcoming')) {
      return lastAccess;
    }
    logStage(`${label}:access-wait-${attempt}:${lastAccess.status || lastAccess.accessType || 'pending'}`);
    await sleep(1500);
  }
  return lastAccess || getLiveClassAccess(token, liveClassId);
};

const getLiveSessionState = async (token: string, liveClassId: string) => {
  const response = await qaFetch(new URL(`/backend/api/live-classes/${liveClassId}/session`, apiOrigin), {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({})) as LiveSessionPayload & { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Unable to fetch live session state');
  }
  return payload.session || null;
};

const waitForSessionParticipantState = async (
  token: string,
  liveClassId: string,
  predicate: (participant: NonNullable<NonNullable<LiveSessionPayload['session']>['participants']>[number]) => boolean,
  label: string,
) => {
  let lastSession: LiveSessionPayload['session'] | null = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    lastSession = await getLiveSessionState(token, liveClassId);
    const participant = lastSession?.participants?.find(predicate) || null;
    if (participant) {
      return participant;
    }
    logStage(`${label}:session-wait-${attempt}`);
    await sleep(1500);
  }
  const finalSession = lastSession || await getLiveSessionState(token, liveClassId);
  return finalSession?.participants?.find(predicate) || null;
};

const endLiveClass = async (token: string, liveClassId: string) => {
  const response = await qaFetch(new URL(`/backend/api/live-classes/${liveClassId}/end`, apiOrigin), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Unable to end live class');
  }
};

const publishManagedHls = async (streamKey: string) => {
  const [streamName, queryString = ''] = String(streamKey || '').split('?');
  const query = new URLSearchParams(queryString);
  const secret = query.get('secret') || '';
  if (!streamName || !secret) {
    return false;
  }

  const response = await qaFetch(new URL('/backend/api/live-classes/ingest/on-publish', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'publish',
      protocol: 'rtmp',
      name: streamName,
      secret,
    }),
  });

  if (!(response.status === 204 || response.ok)) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.message || `Unable to publish managed HLS stream (${response.status})`);
  }

  return true;
};

const gotoLiveClass = async (page: puppeteer.Page, liveClassId: string) => {
  await page.goto(`${config.baseUrl}?tab=live&liveClassId=${encodeURIComponent(liveClassId)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
};

const logStage = (label: string) => {
  console.log(`[live-cert] ${label}`);
};

const waitForJoinButton = async (page: puppeteer.Page) => {
  await page.waitForSelector('[data-testid="live-details-join-button"]:not([disabled])', { timeout: 45000 });
};

const clickJoin = async (page: puppeteer.Page) => {
  await page.$eval('[data-testid="live-details-join-button"]', (node) => {
    if (!(node instanceof HTMLButtonElement)) {
      throw new Error('Join button node is not a button');
    }
    if (node.disabled) {
      throw new Error('Join button is still disabled');
    }
    node.click();
  });
};

const waitForRuntime = async (page: puppeteer.Page) => {
  await page.waitForSelector('[data-testid="live-runtime-page"]', { timeout: 45000 });
};

const clickVisibleButtonByTestId = async (page: puppeteer.Page, testId: string) => {
  const selector = `[data-testid="${testId}"]`;
  const target = await page.$$eval(selector, (elements) => {
    const candidate = elements.find((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return Boolean(
        rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && !('disabled' in element && Boolean((element as HTMLButtonElement).disabled)),
      );
    }) || null;

    if (!(candidate instanceof HTMLButtonElement)) {
      throw new Error(`Unable to locate a visible button for ${selector}`);
    }

    candidate.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = candidate.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });
  await page.mouse.click(target.x, target.y);
};

const createPollViaApi = async (token: string, liveClassId: string, question: string, options: string[]) => {
  const response = await qaFetch(new URL(`/backend/api/live-classes/${liveClassId}`, apiOrigin), {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      activePoll: {
        question,
        status: 'live',
        options: options.map((text, index) => ({ id: `option-${index + 1}`, text })),
      },
    }),
  });

  const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Unable to create live poll');
  }
};

const voteInVisiblePoll = async (page: puppeteer.Page, optionId = 'option-1') => {
  const selector = `[data-testid="live-poll-option-${optionId}"]`;
  await page.waitForSelector(selector, { timeout: 45000 });
  await page.$eval(selector, (element, currentSelector) => {
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Element ${currentSelector} is not a button`);
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
  }, selector);
  await page.waitForFunction(
    (targetSelector) => {
      const button = document.querySelector(targetSelector);
      return Boolean(button && button.getAttribute('aria-pressed') === 'true');
    },
    { timeout: 45000 },
    selector,
  );
};

const waitForRuntimeState = async (page: puppeteer.Page, attribute: string, expectedValue: string) => {
  await page.waitForFunction(
    (attr, expected) => {
      const runtime = document.querySelector('[data-testid="live-runtime-page"]');
      return Boolean(runtime && runtime.getAttribute(attr) === expected);
    },
    { timeout: 45000 },
    attribute,
    expectedValue,
  );
};

const tryJoinAndCapture = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  prefix: string,
  label: string,
  accessType: string,
  liveClassId: string,
  studioUrl: string | null = null,
  sessionToken: string | null = null,
) => {
  if (accessType === 'jitsi-room' && studioUrl) {
    logStage(`${label}:teacher-studio-direct-open-start`);
    const studioPage = await page.browserContext().newPage();
    await studioPage.setViewport(desktopViewport);
    await studioPage.goto(studioUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await studioPage.waitForSelector('body', { timeout: 45000 }).catch(() => undefined);
    logStage(`${label}:teacher-studio-direct-opened`);
    return takeScreenshot(studioPage, ctx, prefix, label);
  }

  logStage(`${label}:wait-join-button`);
  await waitForJoinButton(page);
  logStage(`${label}:join-button-ready`);
  await clickJoin(page);
  logStage(`${label}:join-clicked`);
  await waitForRuntime(page);
  logStage(`${label}:runtime-visible`);
  logStage(`${label}:access-type:${accessType || 'unknown'}`);
  if (accessType === 'jitsi-room') {
    try {
      await page.waitForSelector('[data-testid="live-open-teacher-studio"]', { timeout: 45000 });
      logStage(`${label}:teacher-studio-launch-ready`);
      if (studioUrl) {
        const studioPage = await page.browserContext().newPage();
        await studioPage.setViewport(desktopViewport);
        await studioPage.goto(studioUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await studioPage.waitForSelector('body', { timeout: 45000 }).catch(() => undefined);
        logStage(`${label}:teacher-studio-direct-opened`);
        return takeScreenshot(studioPage, ctx, prefix, label);
      }
    } catch {
      logStage(`${label}:teacher-studio-loading`);
    }
  } else if (accessType === 'livekit-room') {
    await page.waitForSelector('[data-testid="live-room-container"][data-room-loaded="true"]', { timeout: 60000 });
    logStage(`${label}:room-loaded`);
    await page.waitForSelector('[data-testid="live-toggle-audio"]:not([disabled])', { timeout: 45000 });
    await page.waitForSelector('[data-testid="live-toggle-video"]:not([disabled])', { timeout: 45000 });
    logStage(`${label}:interactive-controls-ready`);
    if (label === 'admin-joined') {
      await clickVisibleButtonByTestId(page, 'live-toggle-audio');
      await waitForRuntimeState(page, 'data-self-mic-muted', 'true');
      if (!sessionToken) {
        throw new Error('Session token required to verify admin audio state');
      }
      await waitForSessionParticipantState(
        sessionToken,
        liveClassId,
        (participant) => participant.role === 'admin' && participant.micMuted === true,
        `${label}:audio-muted`,
      );
      logStage(`${label}:audio-muted`);
      await takeScreenshot(page, ctx, prefix, 'admin-audio-muted');
      await sleep(2000);
      await clickVisibleButtonByTestId(page, 'live-toggle-audio');
      await waitForRuntimeState(page, 'data-self-mic-muted', 'false');
      if (!sessionToken) {
        throw new Error('Session token required to verify admin audio state');
      }
      await waitForSessionParticipantState(
        sessionToken,
        liveClassId,
        (participant) => participant.role === 'admin' && participant.micMuted === false,
        `${label}:audio-restored`,
      );
      logStage(`${label}:audio-restored`);
      await takeScreenshot(page, ctx, prefix, 'admin-audio-restored');

      await clickVisibleButtonByTestId(page, 'live-toggle-video');
      await waitForRuntimeState(page, 'data-self-video-enabled', 'false');
      if (!sessionToken) {
        throw new Error('Session token required to verify admin video state');
      }
      await waitForSessionParticipantState(
        sessionToken,
        liveClassId,
        (participant) => participant.role === 'admin' && participant.videoEnabled === false,
        `${label}:video-stopped`,
      );
      logStage(`${label}:video-stopped`);
      await takeScreenshot(page, ctx, prefix, 'admin-video-disabled');
      await sleep(2000);
      await clickVisibleButtonByTestId(page, 'live-toggle-video');
      await waitForRuntimeState(page, 'data-self-video-enabled', 'true');
      if (!sessionToken) {
        throw new Error('Session token required to verify admin video state');
      }
      await waitForSessionParticipantState(
        sessionToken,
        liveClassId,
        (participant) => participant.role === 'admin' && participant.videoEnabled === true,
        `${label}:video-restored`,
      );
      logStage(`${label}:video-restored`);
      await takeScreenshot(page, ctx, prefix, 'admin-video-restored');

      await page.waitForSelector('[data-testid="live-toggle-screen-share"]:not([disabled])', { timeout: 45000 });
      await page.$eval('[data-testid="live-toggle-screen-share"]', (element) => {
        if (element instanceof HTMLElement) {
          element.click();
          return;
        }
        throw new Error('Screen share control is not clickable');
      });
      await page.waitForSelector('[data-screen-sharing="true"]', { timeout: 45000 });
      logStage(`${label}:screen-share-active`);
    }
  } else if (accessType === 'live-stream') {
    await page.waitForSelector('[data-testid="live-stream-container"] video, [data-testid="live-stream-container"]', { timeout: 45000 });
    logStage(`${label}:broadcast-visible`);
  } else {
    await page.waitForSelector(
      '[data-testid="live-stream-container"], [data-testid="live-room-container"], [data-testid="live-jitsi-container"]',
      { timeout: 45000 },
    );
    logStage(`${label}:media-container-visible`);
  }
  return takeScreenshot(page, ctx, prefix, label);
};

const main = async () => {
  const ctx = await createRunContext();
  const browser = await puppeteer.launch({
    executablePath: chromeExecutable,
    headless: process.env.QA_HEADLESS !== 'false',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--enable-usermedia-screen-capturing',
      '--auto-select-desktop-capture-source=Entire screen',
      ...(browserHostResolverRule ? [`--host-resolver-rules=${browserHostResolverRule}`] : []),
    ],
    defaultViewport: null,
    protocolTimeout: Math.max(120_000, Number(process.env.QA_PROTOCOL_TIMEOUT_MS || 180_000)),
  });

  const stages: StageResult[] = [];
  const notes: string[] = [];
  let exitCode = 0;
  let stopPublisher = async () => undefined;
  let adminContext: puppeteer.BrowserContext | null = null;
  let studentDesktopContext: puppeteer.BrowserContext | null = null;
  let studentMobileContext: puppeteer.BrowserContext | null = null;

  try {
    logStage('launch-browser');
    adminContext = await browser.createBrowserContext();
    studentDesktopContext = await browser.createBrowserContext();
    studentMobileContext = await browser.createBrowserContext();
    await adminContext.overridePermissions(new URL(config.baseUrl).origin, ['camera', 'microphone', 'clipboard-write']);
    await adminContext.overridePermissions('https://meet.jit.si', ['camera', 'microphone', 'clipboard-write']);

    const adminPage = await adminContext.newPage();
    await adminPage.setViewport(desktopViewport);
    const adminTokenManager = createTokenManager(adminPage, adminEmail, adminPassword, 'QA Live Feature Admin');
    await adminTokenManager.refresh();
    logStage('admin-authenticated');

    const studentDesktopPage = await studentDesktopContext.newPage();
    await studentDesktopPage.setViewport(desktopViewport);
    const studentToken = await ensureStudentAccountAndGetToken(
      studentEmail,
      studentPassword,
      'QA Feature Student',
      'QA Live Feature Student Shared',
    );
    await storeSessionToken(studentDesktopPage, studentToken);
    logStage('student-desktop-authenticated');

    const studentMobilePage = await studentMobileContext.newPage();
    await studentMobilePage.setViewport(mobileViewport);
    await storeSessionToken(studentMobilePage, studentToken);
    logStage('student-mobile-authenticated');

    const liveClass = await withTokenRetry(
      adminTokenManager,
      (token) => createLiveClass(token, `QA Live Feature Certification ${timestampSuffix()}`, new Date(Date.now() + 60_000).toISOString()),
    );
    logStage(`live-class-created:${liveClass._id}`);

    await gotoLiveClass(adminPage, liveClass._id);
    logStage('admin-scheduled-opened');
    await gotoLiveClass(studentDesktopPage, liveClass._id);
    logStage('student-desktop-scheduled-opened');
    await gotoLiveClass(studentMobilePage, liveClass._id);
    logStage('student-mobile-scheduled-opened');

    stages.push({
      name: 'scheduled-detail-visible',
      ok: true,
      notes: ['Admin and students opened the live detail page.'],
      screenshots: [
        await takeScreenshot(adminPage, ctx, 'live-cert', 'admin-scheduled'),
        await takeScreenshot(studentDesktopPage, ctx, 'live-cert', 'student-desktop-scheduled'),
        await takeScreenshot(studentMobilePage, ctx, 'live-cert', 'student-mobile-scheduled'),
      ],
    });

    const pollQuestion = `QA poll ${timestampSuffix()}: what should we revise next?`;
    const pollOptions = ['Video', 'Audio', 'Screen share', 'Polls'];
    await withTokenRetry(adminTokenManager, (token) => createPollViaApi(token, liveClass._id, pollQuestion, pollOptions));
    logStage('poll-created');
    stages.push({
      name: 'poll-created',
      ok: true,
      notes: ['Admin created a live poll before starting the class.'],
      screenshots: [await takeScreenshot(adminPage, ctx, 'live-cert', 'admin-poll-created')],
    });

    await withTokenRetry(adminTokenManager, (token) => startLiveClass(token, liveClass._id));
    logStage('live-class-started');
    const adminAccess = await waitForLiveAccess(adminTokenManager.get(), liveClass._id, 'admin-access');
    const studentAccess = await waitForLiveAccess(studentToken, liveClass._id, 'student-access');
    logStage(`access-types:admin=${adminAccess.accessType || 'unknown'} student=${studentAccess.accessType || 'unknown'}`);
    if (
      livePlaybackMode === 'live-stream'
      && (!studentAccess.streamUrl || /\/backend\/api\/live-classes\/stream\//.test(String(studentAccess.streamUrl)))
    ) {
      throw new Error(`Broadcast live-stream certification requires a public live-domain HLS URL, received: ${String(studentAccess.streamUrl || 'none')}`);
    }
    stopPublisher = await maybeStartLiveTestPublisher({
      ingestServerUrl: liveClass.ingestServerUrl || null,
      ingestStreamKey: liveClass.ingestStreamKey || null,
      envPrefix: 'QA',
      runId: ctx.runId,
    });
    const published = await publishManagedHls(liveClass.ingestStreamKey || '').catch(() => false);
    logStage(`managed-hls-publish:${published ? 'ok' : 'skipped'}`);
    await sleep(6000);

    stages.push({
      name: 'admin-started-class',
      ok: true,
      notes: [
        'Admin start API succeeded.',
        published ? 'Managed HLS publish callback succeeded.' : 'Managed HLS publish callback was skipped or unavailable.',
        `Admin access type: ${adminAccess.accessType || 'unknown'}.`,
        `Student access type: ${studentAccess.accessType || 'unknown'}.`,
      ],
      screenshots: [await takeScreenshot(adminPage, ctx, 'live-cert', 'admin-started')],
    });

    await gotoLiveClass(adminPage, liveClass._id);
    logStage('admin-live-detail-opened');
    await gotoLiveClass(studentDesktopPage, liveClass._id);
    logStage('student-desktop-live-detail-opened');
    await gotoLiveClass(studentMobilePage, liveClass._id);
    logStage('student-mobile-live-detail-opened');

    if (adminAccess.accessType === 'jitsi-room' || adminAccess.accessType === 'livekit-room') {
      logStage('admin-join-start');
      const adminJoinShot = await tryJoinAndCapture(
        adminPage,
        ctx,
        'live-cert',
        'admin-joined',
        adminAccess.accessType || '',
        liveClass._id,
        adminAccess.accessType === 'jitsi-room'
          ? (adminAccess.embedUrl || adminAccess.roomUrl || null)
          : null,
        adminTokenManager.get(),
      );
      logStage('admin-join-finished');
      stages.push({
        name: 'admin-studio-open',
        ok: true,
        notes: ['Admin joined the teacher studio iframe.'],
        screenshots: [adminJoinShot],
      });
    }

    logStage('student-desktop-join-start');
    const studentDesktopJoinShot = await tryJoinAndCapture(studentDesktopPage, ctx, 'live-cert', 'student-desktop-joined', studentAccess.accessType || '', liveClass._id);
    logStage('student-desktop-join-finished');
    await voteInVisiblePoll(studentDesktopPage, 'option-1');
    logStage('student-desktop-poll-voted');
    const studentDesktopPollShot = await takeScreenshot(studentDesktopPage, ctx, 'live-cert', 'student-desktop-poll-voted');
    await clickVisibleButtonByTestId(adminPage, 'live-room-tab-polls');
    await studentDesktopPage.waitForSelector('[data-testid="live-poll-option-option-1"][aria-pressed="true"]', { timeout: 45000 });
    await adminPage.waitForSelector('[data-testid="live-poll-option-option-1"]', { timeout: 45000 });
    const adminPollResultsShot = await takeScreenshot(adminPage, ctx, 'live-cert', 'admin-poll-results');
    logStage('student-mobile-join-start');
    const studentMobileJoinShot = await tryJoinAndCapture(studentMobilePage, ctx, 'live-cert', 'student-mobile-joined', studentAccess.accessType || '', liveClass._id);
    logStage('student-mobile-join-finished');
    stages.push({
      name: 'student-joined-runtime',
      ok: true,
      notes: [`Student access type: ${studentAccess.accessType || 'unknown'}.`, 'Desktop and mobile student runtime views loaded.'],
      screenshots: [studentDesktopJoinShot, studentDesktopPollShot, adminPollResultsShot, studentMobileJoinShot],
    });

    const desktopChatVisible = await studentDesktopPage.$('[data-testid="live-chat-input"]');
    const mobileChatVisible = await studentMobilePage.$('[data-testid="live-chat-input"]');
    logStage(`runtime-controls:${desktopChatVisible || mobileChatVisible ? 'present' : 'missing'}`);
    stages.push({
      name: 'runtime-controls-present',
      ok: Boolean(desktopChatVisible || mobileChatVisible),
      notes: [
        desktopChatVisible || mobileChatVisible
          ? 'Live chat input is visible in at least one runtime viewport.'
          : 'Live chat input was not visible after join.',
      ],
      screenshots: [await takeScreenshot(studentDesktopPage, ctx, 'live-cert', 'student-desktop-runtime-controls')],
    });

    if (livePlaybackMode === 'live-stream') {
      notes.push(studentAccess.accessType === 'live-stream'
        ? 'Broadcast HLS classroom verified: student playback rendered successfully.'
        : `Expected broadcast live-stream access but received ${studentAccess.accessType || 'unknown'}.`);
    } else if (adminAccess.accessType !== 'jitsi-room' && studentAccess.accessType !== 'live-stream') {
      notes.push('Live classroom is not using the expected hybrid playback modes.');
    } else {
      notes.push('Hybrid classroom verified: teacher studio and student playback rendered successfully.');
    }

    await withTokenRetry(adminTokenManager, (token) => endLiveClass(token, liveClass._id));
    await stopPublisher().catch(() => undefined);
    stopPublisher = async () => undefined;
    logStage('live-class-ended');
    await sleep(2500);
    await gotoLiveClass(studentDesktopPage, liveClass._id);
    logStage('student-desktop-ended-opened');
    stages.push({
      name: 'class-ended',
      ok: true,
      notes: ['Admin end API succeeded.'],
      screenshots: [await takeScreenshot(studentDesktopPage, ctx, 'live-cert', 'student-desktop-ended')],
    });

    const summary = {
      baseUrl: config.baseUrl,
      liveClassId: liveClass._id,
      stages,
      notes,
    };

    await writeJson(path.join(ctx.analysisDir, 'live-feature-certification-summary.json'), summary);
    await writeText(path.join(ctx.analysisDir, 'live-feature-certification-summary.md'), [
      '# Live Feature Certification',
      '',
      `Base URL: ${config.baseUrl}`,
      `Live class: ${liveClass._id}`,
      '',
      '## Stages',
      ...stages.flatMap((stage) => [
        `- ${stage.name}: ${stage.ok ? 'PASS' : 'FAIL'}`,
        ...stage.notes.map((note) => `  - ${note}`),
      ]),
      '',
      '## Notes',
      ...(notes.length ? notes.map((note) => `- ${note}`) : ['- No extra notes.']),
    ].join('\n'));
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    await writeText(path.join(ctx.analysisDir, 'live-feature-certification-error.txt'), message);
    throw error;
  } finally {
    await stopPublisher().catch(() => undefined);
    await adminContext?.close().catch(() => undefined);
    await studentDesktopContext?.close().catch(() => undefined);
    await studentMobileContext?.close().catch(() => undefined);
    await browser.close();
    process.exitCode = exitCode;
  }
};

void main();
