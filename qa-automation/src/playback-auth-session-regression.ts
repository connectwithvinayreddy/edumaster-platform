import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

type AuthPayload = {
  token: string;
  user?: {
    _id?: string;
    id?: string;
    email?: string;
  };
};

type ConsoleEntry = {
  type: string;
  text: string;
};

type NetworkEntry = {
  url: string;
  status: number;
  contentType: string | null;
  bodySample?: string;
};

type PlaybackMetric = {
  type: string;
  at: number;
  [key: string]: unknown;
};

type BrowserCheckResult = {
  label: string;
  pageUrl: string;
  authSessionStatus: number | null;
  playerStatus: number | null;
  shellReady: boolean;
  loginVisible: boolean;
  playbackStoppedVisible: boolean;
  anotherDeviceVisible: boolean;
  retryVisible: boolean;
  currentTime: number;
  paused: boolean | null;
  readyState: number | null;
  networkState: number | null;
  screenshotPath: string;
  sourcePath: string;
  consoleEntries: ConsoleEntry[];
  networkEntries: NetworkEntry[];
  playbackMetrics: PlaybackMetric[];
};

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const courseId = process.env.QA_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2';
const lessonId = process.env.QA_LESSON_ID || 'video_1780146736089_8d3b641cf7';
const lessonTitle = process.env.QA_LESSON_TEXT || 'INTRODUCTION';
const playbackWaitMs = Math.max(20_000, Number(process.env.QA_PLAYBACK_WAIT_MS || 35_000));

const qaEmail = `qa.playback.session.${Date.now()}@example.com`;
const qaPassword = process.env.QA_STUDENT_PASSWORD || 'Student@1234';
const qaName = 'QA Playback Session Student';

const requestJson = async <T>(pathname: string, init: RequestInit): Promise<T> => {
  const response = await fetch(new URL(pathname, apiOrigin), init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as Record<string, unknown>)?.message as string || `Request failed: ${pathname}`);
  }
  return payload as T;
};

const registerStudent = () => requestJson<AuthPayload>('/backend/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: qaName,
    email: qaEmail,
    password: qaPassword,
    device: 'QA Playback Session Register',
  }),
});

const loginStudent = (forceLogoutOtherSessions: boolean, device: string) => requestJson<AuthPayload>('/backend/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: qaEmail,
    password: qaPassword,
    device,
    forceLogoutOtherSessions,
  }),
});

const exactLessonUrl = `${config.baseUrl}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`;

const runBrowserCheck = async ({
  label,
  token,
  deviceId,
  playbackTabId,
  runContext,
}: {
  label: string;
  token: string;
  deviceId: string;
  playbackTabId: string;
  runContext: Awaited<ReturnType<typeof createRunContext>>;
}): Promise<BrowserCheckResult> => {
  const consoleEntries: ConsoleEntry[] = [];
  const networkEntries: NetworkEntry[] = [];
  const playbackMetrics: PlaybackMetric[] = [];

  const browser = await puppeteer.launch({
    executablePath: process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932, isMobile: true, hasTouch: true });
    await page.exposeFunction('__recordPlaybackSessionMetric', (metric: PlaybackMetric) => {
      playbackMetrics.push(metric);
    });
    await page.evaluateOnNewDocument((authToken, nextDeviceId, nextTabId) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
      window.localStorage.setItem('edumaster.device.id', nextDeviceId);
      window.sessionStorage.setItem('edumaster.playback.tab.id', nextTabId);
      window.addEventListener('edumaster:hls-metric', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : {};
        void (window as unknown as {
          __recordPlaybackSessionMetric?: (metric: PlaybackMetric) => Promise<void>;
        }).__recordPlaybackSessionMetric?.(detail as PlaybackMetric);
      });
    }, token, deviceId, playbackTabId);

    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleEntries.push({ type: message.type(), text: message.text() });
      }
    });
    page.on('pageerror', (error) => {
      consoleEntries.push({ type: 'pageerror', text: error.stack || error.message });
    });
    page.on('response', async (response) => {
      const url = response.url();
      if (!/\/auth\/session|\/player|course-manifests|\.m3u8|\.ts|videodelivery\.net|cloudflarestream\.com/i.test(url)) {
        return;
      }
      const record: NetworkEntry = {
        url,
        status: response.status(),
        contentType: response.headers()['content-type'] || null,
      };
      if (response.status() >= 400) {
        try {
          record.bodySample = (await response.text()).slice(0, 400);
        } catch {
          record.bodySample = '(unavailable)';
        }
      }
      networkEntries.push(record);
    });

    await page.goto(exactLessonUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(playbackWaitMs);

    const authSessionStatus = await page.evaluate(async () => {
      const tokenValue = window.localStorage.getItem('edumaster.jwt') || '';
      try {
        const response = await fetch('/backend/api/auth/session', {
          headers: tokenValue ? { authorization: `Bearer ${tokenValue}` } : {},
        });
        return response.status;
      } catch {
        return null;
      }
    });

    const playerStatus = await page.evaluate(async (targetCourseId, targetLessonId) => {
      const tokenValue = window.localStorage.getItem('edumaster.jwt') || '';
      try {
        const response = await fetch(`/backend/api/courses/${encodeURIComponent(targetCourseId)}/lessons/${encodeURIComponent(targetLessonId)}/player`, {
          headers: tokenValue ? { authorization: `Bearer ${tokenValue}` } : {},
        });
        return response.status;
      } catch {
        return null;
      }
    }, courseId, lessonId);

    const pageState = await page.evaluate((expectedLessonTitle) => {
      const bodyText = document.body?.innerText || '';
      const video = document.querySelector('video') as HTMLVideoElement | null;
      const titleCandidates = Array.from(document.querySelectorAll([
        '[data-testid="course-player-heading"]',
        '[data-testid="course-player-title"]',
        '[data-testid="course-lesson-title"]',
        'h1',
        'h2',
      ].join(',')))
        .map((node) => (node.textContent || '').trim())
        .filter(Boolean);

      const normalizedExpected = String(expectedLessonTitle || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const lessonMatch = titleCandidates.some((text) => {
        const normalized = String(text || '')
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[–—-]+/g, ' ')
          .replace(/[^a-z0-9]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return normalized.includes(normalizedExpected) || normalizedExpected.includes(normalized);
      }) || String(bodyText || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[–—-]+/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .includes(normalizedExpected);

      return {
        bodyText,
        lessonMatch,
        shellReady: Boolean(document.querySelector('[data-testid="shell-ready"]')),
        loginVisible: Boolean(
          document.querySelector('[data-testid="auth-login-email"]')
          || /login|sign in/i.test(bodyText),
        ),
        playbackStoppedVisible: /playback stopped/i.test(bodyText),
        anotherDeviceVisible: /another tab or device/i.test(bodyText),
        retryVisible: /retry to try again/i.test(bodyText),
        currentTime: video ? Number(video.currentTime || 0) : 0,
        paused: video ? Boolean(video.paused) : null,
        readyState: video ? Number(video.readyState || 0) : null,
        networkState: video ? Number(video.networkState || 0) : null,
      };
    }, lessonTitle);

    const screenshotPath = artifactPath(runContext.screenshotDir, 'playback-auth-session', label, 'png');
    const sourcePath = artifactPath(runContext.sourceDir, 'playback-auth-session', label, 'html');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.writeFile(sourcePath, await page.content(), 'utf8');

    if (!pageState.lessonMatch && pageState.shellReady) {
      consoleEntries.push({
        type: 'warning',
        text: `Expected lesson title ${lessonTitle} was not confirmed in browser DOM.`,
      });
    }

    return {
      label,
      pageUrl: page.url(),
      authSessionStatus,
      playerStatus,
      shellReady: pageState.shellReady,
      loginVisible: pageState.loginVisible,
      playbackStoppedVisible: pageState.playbackStoppedVisible,
      anotherDeviceVisible: pageState.anotherDeviceVisible,
      retryVisible: pageState.retryVisible,
      currentTime: pageState.currentTime,
      paused: pageState.paused,
      readyState: pageState.readyState,
      networkState: pageState.networkState,
      screenshotPath,
      sourcePath,
      consoleEntries,
      networkEntries,
      playbackMetrics,
    };
  } finally {
    await browser.close();
  }
};

const main = async () => {
  const runContext = await createRunContext();

  const registration = await registerStudent();
  const firstToken = String(registration.token);
  const secondLogin = await loginStudent(true, 'QA Playback Session Device 2');
  const secondToken = String(secondLogin.token);

  const replacedSessionResult = await runBrowserCheck({
    label: 'replaced-token',
    token: firstToken,
    deviceId: 'qa-playback-session-device-1',
    playbackTabId: 'qa-playback-session-tab-1',
    runContext,
  });

  const activeSessionResult = await runBrowserCheck({
    label: 'active-token',
    token: secondToken,
    deviceId: 'qa-playback-session-device-2',
    playbackTabId: 'qa-playback-session-tab-2',
    runContext,
  });

  const summary = {
    generatedStudent: qaEmail,
    exactLessonUrl,
    courseId,
    lessonId,
    replacedTokenAccepted: replacedSessionResult.authSessionStatus === 200 && replacedSessionResult.playerStatus === 200,
    activeTokenAccepted: activeSessionResult.authSessionStatus === 200 && activeSessionResult.playerStatus === 200,
    replacedSessionResult,
    activeSessionResult,
  };

  const summaryPath = path.join(runContext.analysisDir, 'playback-auth-session-regression.json');
  await writeJson(summaryPath, summary);
  await writeText(path.join(runContext.rootDir, 'report.txt'), [
    `Generated student: ${qaEmail}`,
    `Exact lesson URL: ${exactLessonUrl}`,
    `Replaced token accepted: ${summary.replacedTokenAccepted}`,
    `Active token accepted: ${summary.activeTokenAccepted}`,
    `Summary: ${summaryPath}`,
  ].join('\n'));

  console.log(JSON.stringify({
    summaryPath,
    replacedTokenAccepted: summary.replacedTokenAccepted,
    activeTokenAccepted: summary.activeTokenAccepted,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
