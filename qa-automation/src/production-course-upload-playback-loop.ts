import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
dotenv.config({ path: path.join(rootDir, '.env') });
const artifactRoot = path.join(rootDir, 'qa-automation', 'artifacts');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(artifactRoot, `production-course-upload-playback-${runId}`);

const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const apiBaseUrl = (process.env.QA_API_BASE_URL || `${baseUrl}/backend/api`).replace(/\/+$/, '');
const videoPath = path.resolve(rootDir, process.env.QA_UPLOAD_VIDEO_PATH || 'uploads/live-fallback.mp4');
const uploadCount = Math.max(1, Number(process.env.QA_UPLOAD_COUNT || 2));
const hlsWaitMs = Math.max(60_000, Number(process.env.QA_HLS_WAIT_MS || 12 * 60_000));
const browserWaitMs = Math.max(10_000, Number(process.env.QA_BROWSER_WAIT_MS || 30_000));
const directVideoUploadLimitBytes = 90 * 1024 * 1024;
const defaultMultipartPartSizeBytes = 20 * 1024 * 1024;
const edgeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
const adminForceLogoutOtherSessions = ['1', 'true', 'yes', 'on'].includes(String(process.env.ADMIN_FORCE_LOGOUT_OTHER_SESSIONS || 'false').toLowerCase());
const adminTakeoverOnSessionActive = !['0', 'false', 'no', 'off'].includes(String(process.env.ADMIN_TAKEOVER_ON_SESSION_ACTIVE || 'true').toLowerCase());
type JsonRecord = Record<string, any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();
const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const uniqueDigits = (length: number) => {
  let value = '';
  while (value.length < length) {
    value += `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  }
  return value.slice(-length);
};

const readEnvFile = async (filePath: string) => {
  const values: Record<string, string> = {};
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
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

const requestJson = async <T = any>(input: string, init: RequestInit = {}): Promise<{ data: T; res: Response; text: string }> => {
  const res = await fetch(input, init);
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${data?.message || data?.error || text.slice(0, 200)}`);
  }
  return { data, res, text };
};

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

const buildAdminLoginPayload = (email: string, password: string, forceLogoutOtherSessions: boolean) => ({
  email,
  identifier: email,
  password,
  device: `production-upload-playback-loop-${runId}`,
  forceLogoutOtherSessions,
});

const isSessionReplacementError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('401') && message.toLowerCase().includes('replaced by a newer login');
};

const buildApprovedPlaybackHeaders = (token: string, deviceId: string) => ({
  ...authHeaders(token),
  accept: 'application/json',
  'user-agent': edgeUserAgent,
  'x-edumaster-app': 'web',
  'x-edumaster-client-platform': 'windows',
  'x-edumaster-client-browser': 'edge',
  'x-edumaster-device-id': deviceId,
});

const loginAdmin = async (env: Record<string, string>) => {
  const email = process.env.ADMIN_EMAIL || env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required for production QA.');
  }
  let data: JsonRecord;
  try {
    ({ data } = await requestJson(`${apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAdminLoginPayload(email, password, adminForceLogoutOtherSessions)),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!adminForceLogoutOtherSessions && adminTakeoverOnSessionActive && message.includes('409') && message.includes('already active on another device')) {
      ({ data } = await requestJson(`${apiBaseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildAdminLoginPayload(email, password, true)),
      }));
    } else {
      throw error;
    }
  }
  const token = data.token || data.accessToken || data.data?.token;
  if (!token) {
    throw new Error('Admin login succeeded but did not return a token.');
  }
  return { token, user: data.user || data.data?.user || null };
};

const createAdminSessionManager = async (env: Record<string, string>) => {
  let current = await loginAdmin(env);
  return {
    get token() {
      return String(current.token);
    },
    get user() {
      return current.user;
    },
    async refresh() {
      current = await loginAdmin(env);
      return current;
    },
    async run<T>(operation: (token: string) => Promise<T>) {
      try {
        return await operation(String(current.token));
      } catch (error) {
        if (!isSessionReplacementError(error)) {
          throw error;
        }
        current = await loginAdmin(env);
        return operation(String(current.token));
      }
    },
  };
};

const createCourse = async (token: string) => {
  const title = `QA Playback ${runId}`;
  const { data } = await requestJson(`${apiBaseUrl}/courses`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description: 'Automated production QA course for upload, HLS packaging, and playback verification.',
      category: 'QA',
      exam: 'Playback QA',
      subject: 'Video Streaming',
      instructor: 'Automation',
      level: 'Full Course',
      price: 1500,
      validityDays: 365,
    }),
  });
  return data;
};

const addModule = async (token: string, courseId: string) => {
  const { data } = await requestJson(`${apiBaseUrl}/courses/${courseId}/modules`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'QA Video Module',
      description: 'Created by automated playback QA.',
      order: 1,
    }),
  });
  return data.module;
};

const addChapter = async (token: string, courseId: string, moduleId: string) => {
  const { data } = await requestJson(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/chapters`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: 'QA Chapter 1',
      description: 'Created by automated playback QA.',
      order: 1,
    }),
  });
  return data.chapter;
};

const uploadLesson = async (token: string, courseId: string, moduleId: string, chapterId: string, index: number) => {
  const fileName = path.basename(videoPath) || `${safe(`qa-playback-${index}`)}.mp4`;
  const lessonTitle = `QA Playback Lesson ${String(index).padStart(2, '0')}`;
  const stat = await fs.stat(videoPath);
  if (stat.size <= directVideoUploadLimitBytes) {
    const buffer = await fs.readFile(videoPath);
    const file = new File([buffer], fileName, { type: 'video/mp4' });
    const formData = new FormData();
    formData.append('video', file);
    formData.append('lessonTitle', lessonTitle);
    formData.append('durationMinutes', '1');
    formData.append('isPremium', 'true');
    formData.append('lessonType', 'private-video');
    formData.append('chapterId', chapterId);

    const { data } = await requestJson(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos`, {
      method: 'POST',
      headers: authHeaders(token),
      body: formData,
    });
    return data.video;
  }

  const { data: initData } = await requestJson<{
    uploadSessionId: string;
    partSizeBytes?: number;
    recommendedConcurrency?: number;
  }>(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos/multipart/initiate`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      lessonTitle,
      durationMinutes: 1,
      isPremium: true,
      lessonType: 'private-video',
      chapterId,
      originalFilename: fileName,
      mimeType: 'video/mp4',
      fileSize: stat.size,
    }),
  });

  const uploadSessionId = String(initData.uploadSessionId || '').trim();
  if (!uploadSessionId) {
    throw new Error('Multipart upload init did not return an upload session id.');
  }

  const partSizeBytes = Math.max(Number(initData.partSizeBytes || defaultMultipartPartSizeBytes), 5 * 1024 * 1024);
  const totalParts = Math.max(1, Math.ceil(stat.size / partSizeBytes));
  const concurrency = Math.max(1, Math.min(Number(initData.recommendedConcurrency || 4), 6));
  const fileHandle = await fs.open(videoPath, 'r');

  try {
    let nextPartNumber = 1;
    const uploadPartWorker = async () => {
      while (true) {
        const currentPartNumber = nextPartNumber;
        nextPartNumber += 1;
        if (currentPartNumber > totalParts) {
          return;
        }

        const offset = (currentPartNumber - 1) * partSizeBytes;
        const bytesToRead = Math.min(partSizeBytes, stat.size - offset);
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
        const payload = bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);

        const { data: partData } = await requestJson<{ uploadUrl: string }>(
          `${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos/multipart/${encodeURIComponent(uploadSessionId)}/part-url`,
          {
            method: 'POST',
            headers: {
              ...authHeaders(token),
              'content-type': 'application/json',
            },
            body: JSON.stringify({ partNumber: currentPartNumber }),
          },
        );

        if (!partData.uploadUrl) {
          throw new Error(`Missing multipart upload URL for part ${currentPartNumber}.`);
        }

        const partResponse = await fetch(partData.uploadUrl, {
          method: 'PUT',
          body: payload,
        });
        if (!partResponse.ok) {
          const bodyText = await partResponse.text().catch(() => '');
          throw new Error(`Multipart upload failed for part ${currentPartNumber}: ${partResponse.status} ${bodyText.slice(0, 200)}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, totalParts) }, () => uploadPartWorker()));

    const { data: completeData } = await requestJson<JsonRecord>(
      `${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos/multipart/${encodeURIComponent(uploadSessionId)}/complete`,
      {
        method: 'POST',
        headers: authHeaders(token),
      },
    );
    return completeData.video;
  } catch (error) {
    await fetch(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos/multipart/${encodeURIComponent(uploadSessionId)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }).catch(() => undefined);
    throw error;
  } finally {
    await fileHandle.close();
  }
};

const registerStudent = async (label: string) => {
  const email = `qa.playback.student.${safe(label)}.${runId}@example.com`;
  const password = process.env.QA_STUDENT_PASSWORD || 'Student@123';
  const mobileNumber = `9${uniqueDigits(9)}`;
  const { data } = await requestJson(`${apiBaseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `QA Playback Student ${label}`,
      email,
      mobileNumber,
      password,
      device: `production-upload-playback-student-${safe(label)}-${runId}`,
    }),
  });
  const token = data.token || data.accessToken || data.data?.token;
  const user = data.user || data.data?.user || null;
  if (!token || !user?._id) {
    throw new Error(`Student registration succeeded but response was incomplete: ${JSON.stringify(data)}`);
  }
  return { token: String(token), user, email, password };
};

const assignCourseAccess = async (adminToken: string, userId: string, courseId: string) => {
  await requestJson(`${apiBaseUrl}/admin/purchases/assign-course`, {
    method: 'POST',
    headers: {
      ...authHeaders(adminToken),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      studentId: userId,
      courseId,
      adminNote: `Granted by production-course-upload-playback-loop ${runId}`,
    }),
  });
};

const findLessons = async (token: string, courseId: string, moduleId: string) => {
  const { data } = await requestJson<any>(`${apiBaseUrl}/courses/${courseId}/modules/${moduleId}/videos`, {
    headers: authHeaders(token),
  });
  if (Array.isArray(data)) {
    return data;
  }
  const moduleEntry = data?.module || data;
  return [
    ...((Array.isArray(moduleEntry?.lessons) ? moduleEntry.lessons : [])),
    ...((Array.isArray(moduleEntry?.chapters) ? moduleEntry.chapters : []).flatMap((chapter: JsonRecord) =>
      Array.isArray(chapter.lessons) ? chapter.lessons : [])),
  ];
};

const listVisibleStudentLessons = async (token: string, courseId: string) => {
  const { data } = await requestJson<JsonRecord[]>(`${apiBaseUrl}/courses/${courseId}/lessons`, {
    headers: authHeaders(token),
  });
  return Array.isArray(data) ? data : [];
};

const getPlayer = async (token: string, courseId: string, lessonId: string, deviceId = 'qa-api-player-device') =>
  requestJson(`${apiBaseUrl}/courses/${courseId}/lessons/${lessonId}/player`, {
    headers: buildApprovedPlaybackHeaders(token, deviceId),
  });

const waitForLessonsReady = async (token: string, courseId: string, moduleId: string, lessonIds: string[]) => {
  const startedAt = Date.now();
  const snapshots: JsonRecord[] = [];
  while (Date.now() - startedAt < hlsWaitMs) {
    const lessons = await findLessons(token, courseId, moduleId);
    const selected = lessons.filter((lesson) => lessonIds.includes(lesson.id));
    snapshots.push({
      at: iso(),
      lessons: selected.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        hlsProcessingStatus: lesson.hlsProcessingStatus,
        hlsProcessingError: lesson.hlsProcessingError,
        hlsPlaybackPath: lesson.hlsPlaybackPath,
        hlsManifestBundlePath: lesson.hlsManifestBundlePath,
      })),
    });

    const allReady = selected.length === lessonIds.length
      && selected.every((lesson) => lesson.hlsProcessingStatus === 'ready' && lesson.hlsPlaybackPath);
    if (allReady) {
      return { lessons: selected, snapshots };
    }
    const failed = selected.find((lesson) => lesson.hlsProcessingStatus === 'failed');
    if (failed) {
      throw new Error(`HLS processing failed for ${failed.id}: ${failed.hlsProcessingError || 'unknown error'}`);
    }
    await sleep(8_000);
  }
  await fs.writeFile(path.join(runDir, 'hls-wait-snapshots.json'), JSON.stringify(snapshots, null, 2));
  throw new Error(`HLS processing did not finish within ${Math.round(hlsWaitMs / 1000)} seconds.`);
};

const extractCookie = (res: Response) => {
  const values = typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie') || ''];
  return values
    .map((value: string) => String(value).split(';')[0])
    .filter((value: string) => value.startsWith('edumaster_hls='))
    .join('; ');
};

const verifyPlaybackApi = async (token: string, courseId: string, lessonId: string) => {
  const deviceId = `qa-api-playback-${lessonId}`;
  const playerResult = await getPlayer(token, courseId, lessonId, deviceId);
  const player = playerResult.data as JsonRecord;
  const streamUrl = String(player.streamUrl || '');
  if (player.playbackStatus !== 'ready' || player.streamFormat !== 'hls' || !streamUrl) {
    throw new Error(`Player not ready for ${lessonId}: ${JSON.stringify({
      playbackStatus: player.playbackStatus,
      streamFormat: player.streamFormat,
      hasStreamUrl: Boolean(streamUrl),
      statusMessage: player.statusMessage,
    })}`);
  }

  const cookie = extractCookie(playerResult.res);
  if (!cookie) {
    throw new Error(`Player did not issue HLS grant cookie for ${lessonId}.`);
  }

  const manifestUrl = streamUrl.startsWith('http') ? streamUrl : `${baseUrl}${streamUrl.startsWith('/') ? '' : '/'}${streamUrl}`;
  const manifestResponse = await fetch(manifestUrl, {
    headers: {
      cookie,
      ...buildApprovedPlaybackHeaders(token, deviceId),
    },
  });
  const manifestText = await manifestResponse.text();
  if (!manifestResponse.ok || !manifestText.startsWith('#EXTM3U')) {
    throw new Error(`Master manifest failed for ${lessonId}: ${manifestResponse.status} ${manifestText.slice(0, 120)}`);
  }

  const childLine = manifestText.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  if (!childLine) {
    throw new Error(`Master manifest has no child rendition for ${lessonId}.`);
  }

  const childUrl = new URL(childLine, manifestUrl).toString();
  const childResponse = await fetch(childUrl, {
    headers: {
      cookie,
      ...buildApprovedPlaybackHeaders(token, deviceId),
    },
  });
  const childText = await childResponse.text();
  if (!childResponse.ok || !childText.includes('#EXTINF')) {
    throw new Error(`Child manifest failed for ${lessonId}: ${childResponse.status} ${childText.slice(0, 120)}`);
  }

  const keyLine = childText.match(/URI="([^"]+)"/)?.[1] || '';
  const segmentLine = childText.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#') && !line.endsWith('.m3u8'));
  const keyStatus = keyLine
    ? (await fetch(new URL(keyLine, childUrl), {
      headers: {
        cookie,
        ...buildApprovedPlaybackHeaders(token, deviceId),
      },
      redirect: 'manual',
    })).status
    : null;
  const segmentStatus = segmentLine
    ? (await fetch(new URL(segmentLine, childUrl), {
      headers: {
        cookie,
        range: 'bytes=0-127',
        ...buildApprovedPlaybackHeaders(token, deviceId),
      },
      redirect: 'manual',
    })).status
    : null;

  return {
    player: {
      playbackStatus: player.playbackStatus,
      streamFormat: player.streamFormat,
      watchLimit: player.watchLimit,
      remainingViews: player.remainingViews ?? null,
      tokenExpiresAt: player.tokenExpiresAt || null,
    },
    manifest: {
      status: manifestResponse.status,
      contentType: manifestResponse.headers.get('content-type'),
      firstLines: manifestText.split('\n').slice(0, 12),
    },
    childManifest: {
      status: childResponse.status,
      firstLines: childText.split('\n').slice(0, 10),
      keyStatus,
      segmentStatus,
    },
  };
};

const saveScreenshot = async (page: Page, name: string) => {
  const screenshotPath = path.join(runDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
};

const verifyBrowserPlayback = async (token: string, courseId: string, lessonId: string) => {
  const browser = await chromium.launch({ headless: process.env.QA_HEADED !== 'true' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    userAgent: edgeUserAgent,
    recordVideo: { dir: path.join(runDir, 'browser-video') },
  });
  const consoleMessages: JsonRecord[] = [];
  const pageErrors: JsonRecord[] = [];
  const failedRequests: JsonRecord[] = [];
  const page = await context.newPage();
  const browserDeviceId = `qa-browser-playback-${lessonId}`;

  await context.route('**/backend/api/**', async (route) => {
    const request = route.request();
    await route.continue({
      headers: {
        ...request.headers(),
        'x-edumaster-app': 'web',
        'x-edumaster-client-platform': 'windows',
        'x-edumaster-client-browser': 'edge',
        'x-edumaster-device-id': browserDeviceId,
      },
    });
  });

  page.on('console', (message) => {
    consoleMessages.push({ at: iso(), type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    pageErrors.push({ at: iso(), message: error.message, stack: error.stack });
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({ at: iso(), url: request.url(), method: request.method(), failure: request.failure()?.errorText || '' });
  });

  await page.addInitScript((storedToken) => {
    try {
      Object.defineProperty(window.navigator, 'platform', {
        configurable: true,
        get: () => 'Win32',
      });
    } catch {
      // Ignore platform override failures.
    }

    try {
      Object.defineProperty(window.navigator, 'userAgentData', {
        configurable: true,
        get: () => ({
          platform: 'Windows',
        }),
      });
    } catch {
      // Ignore userAgentData override failures.
    }

    try {
      Object.defineProperty(window, 'Capacitor', {
        configurable: true,
        get: () => undefined,
      });
    } catch {
      // Ignore Capacitor override failures.
    }

    window.localStorage.setItem('edumaster.jwt', storedToken);
  }, token);

  const targetUrl = `${baseUrl}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  const courseScreenshot = await saveScreenshot(page, '01-course-route-loaded');

  await page.waitForFunction(() => {
    const hasVideoElement = Boolean(document.querySelector('video'));
    const text = String(document.body.textContent || '');
    return hasVideoElement
      || text.includes('Video is still preparing')
      || text.includes('Lesson video unavailable');
  }, { timeout: 60_000 });
  const playerScreenshot = await saveScreenshot(page, '02-player-visible');

  const clickTargets = [
    page.getByRole('button', { name: /resume lesson/i }),
    page.getByRole('button', { name: /play/i }),
    page.locator('video'),
  ];
  for (const target of clickTargets) {
    await target.click({ timeout: 5_000 }).catch(() => undefined);
  }

  await page.evaluate(() => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (video) {
      video.muted = true;
      video.controls = true;
      void video.play().catch(() => undefined);
    }
  });

  const deadline = Date.now() + browserWaitMs;
  let state: JsonRecord = {};
  let maxCurrentTime = 0;
  while (Date.now() < deadline) {
    state = await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      const preparing = document.body.textContent?.includes('Video is still preparing') || false;
      const unsupported = document.body.textContent?.includes('protected course videos can be played only') || false;
      const unavailable = document.body.textContent?.includes('Lesson video unavailable') || false;
      return {
        hasVideo: Boolean(video),
        preparing,
        unsupported,
        unavailable,
        currentTime: video?.currentTime || 0,
        duration: video?.duration || 0,
        readyState: video?.readyState || 0,
        networkState: video?.networkState || 0,
        paused: video?.paused ?? null,
        visible: Boolean(video && !!(video.offsetWidth || video.offsetHeight || video.getClientRects().length)),
        videoWidth: video?.videoWidth || 0,
        videoHeight: video?.videoHeight || 0,
        error: video?.error ? {
          code: video.error.code,
          message: video.error.message,
        } : null,
      };
    });
    maxCurrentTime = Math.max(
      maxCurrentTime,
      typeof state.currentTime === 'number' ? Number(state.currentTime) : 0,
    );
    if (state.hasVideo && !state.preparing && !state.unsupported && !state.unavailable && state.readyState >= 2 && maxCurrentTime >= 1) {
      break;
    }
    if (state.unavailable) {
      break;
    }
    if (state.hasVideo && state.paused !== false) {
      await page.locator('video').click({ timeout: 2_000 }).catch(() => undefined);
      await page.keyboard.press('Space').catch(() => undefined);
      await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement | null;
        if (video) {
          video.muted = true;
          video.controls = true;
          void video.play().catch(() => undefined);
        }
      });
    }
    await sleep(1_000);
  }

  const playingScreenshot = await saveScreenshot(page, '03-player-after-play-attempt');
  const startState = state;
  const playbackDuration = typeof startState.duration === 'number' && Number.isFinite(startState.duration)
    ? Number(startState.duration)
    : 0;
  const completionDeadline = Date.now() + Math.max(30_000, Math.ceil(playbackDuration * 1_000) + 20_000);
  let endState: JsonRecord = startState;
  let maxObservedCurrentTime = maxCurrentTime;
  while (Date.now() < completionDeadline) {
    endState = await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      const preparing = document.body.textContent?.includes('Video is still preparing') || false;
      const unsupported = document.body.textContent?.includes('protected course videos can be played only') || false;
      const unavailable = document.body.textContent?.includes('Lesson video unavailable') || false;
      return {
        hasVideo: Boolean(video),
        preparing,
        unsupported,
        unavailable,
        currentTime: video?.currentTime || 0,
        duration: video?.duration || 0,
        readyState: video?.readyState || 0,
        networkState: video?.networkState || 0,
        paused: video?.paused ?? null,
        ended: video?.ended ?? false,
        videoWidth: video?.videoWidth || 0,
        videoHeight: video?.videoHeight || 0,
        error: video?.error ? {
          code: video.error.code,
          message: video.error.message,
        } : null,
      };
    });
    maxObservedCurrentTime = Math.max(
      maxObservedCurrentTime,
      typeof endState.currentTime === 'number' ? Number(endState.currentTime) : 0,
    );

    const ended = endState.ended === true;
    const duration = typeof endState.duration === 'number' ? Number(endState.duration) : 0;
    const currentTime = typeof endState.currentTime === 'number' ? Number(endState.currentTime) : 0;
    if (ended || (duration > 0 && maxObservedCurrentTime >= Math.max(0, duration - 0.75))) {
      break;
    }
    if (endState.unavailable) {
      break;
    }
    if (endState.hasVideo && endState.paused !== false) {
      await page.locator('video').click({ timeout: 2_000 }).catch(() => undefined);
      await page.keyboard.press('Space').catch(() => undefined);
      await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement | null;
        if (video) {
          video.muted = true;
          video.controls = true;
          void video.play().catch(() => undefined);
        }
      });
    }
    await sleep(1_000);
  }

  const endedScreenshot = await saveScreenshot(page, '04-player-ended');
  await fs.writeFile(path.join(runDir, 'browser-console.json'), JSON.stringify(consoleMessages, null, 2));
  await fs.writeFile(path.join(runDir, 'browser-page-errors.json'), JSON.stringify(pageErrors, null, 2));
  await fs.writeFile(path.join(runDir, 'browser-failed-requests.json'), JSON.stringify(failedRequests, null, 2));
  await fs.writeFile(path.join(runDir, 'browser-player-state.json'), JSON.stringify({
    startState,
    endState,
    maxObservedCurrentTime,
  }, null, 2));
  await fs.writeFile(path.join(runDir, 'browser-page-content.html'), await page.content());

  await context.close();
  await browser.close();

  if (!startState.hasVideo || startState.preparing || startState.unsupported || startState.unavailable || startState.readyState < 2 || startState.currentTime <= 0) {
    throw new Error(`Browser playback did not start: ${JSON.stringify(startState)}`);
  }

  const ended = endState.ended === true;
  const endDuration = typeof endState.duration === 'number' ? Number(endState.duration) : 0;
  if (!ended && !(endDuration > 0 && maxObservedCurrentTime >= Math.max(0, endDuration - 0.75))) {
    throw new Error(`Browser playback did not complete: ${JSON.stringify({ endState, maxObservedCurrentTime })}`);
  }

  return {
    targetUrl,
    screenshots: [courseScreenshot, playerScreenshot, playingScreenshot, endedScreenshot],
    state: startState,
    endState,
    maxObservedCurrentTime,
    consoleMessages,
    pageErrors,
    failedRequests,
  };
};

const run = async () => {
  await fs.mkdir(runDir, { recursive: true });
  const env = await readEnvFile(path.join(rootDir, '.env.production'));
  const issues: string[] = [];
  const report: JsonRecord = {
    runId,
    baseUrl,
    apiBaseUrl,
    videoPath,
    uploadCount,
    startedAt: iso(),
    course: null,
    module: null,
    chapter: null,
    uploads: [],
    hls: null,
    apiPlayback: [],
    browserPlayback: null,
    issues,
    screenshots: [],
  };

  try {
    const admin = await createAdminSessionManager(env);
    const apiStudent = await registerStudent('api');
    const browserStudent = await registerStudent('browser');
    const course = await admin.run((token) => createCourse(token));
    const courseId = course._id || course.id;
    const moduleEntry = await admin.run((token) => addModule(token, courseId));
    const chapter = await admin.run((token) => addChapter(token, courseId, moduleEntry.id));

    report.course = { id: courseId, title: course.title };
    report.module = moduleEntry;
    report.chapter = chapter;
    report.student = {
      api: {
        id: apiStudent.user._id,
        email: apiStudent.email,
      },
      browser: {
        id: browserStudent.user._id,
        email: browserStudent.email,
      },
    };
    await fs.writeFile(path.join(runDir, '01-created-course.json'), JSON.stringify(report, null, 2));

    const uploadedLessons = [];
    for (let index = 1; index <= uploadCount; index += 1) {
      const lesson = await admin.run((token) => uploadLesson(token, courseId, moduleEntry.id, chapter.id, index));
      uploadedLessons.push(lesson);
      report.uploads.push({
        at: iso(),
        lessonId: lesson.id,
        title: lesson.title,
        storageProvider: lesson.storageProvider,
        storagePath: lesson.storagePath,
      });
      await fs.writeFile(path.join(runDir, `02-upload-${index}.json`), JSON.stringify(lesson, null, 2));
    }

    await admin.run((token) => assignCourseAccess(token, apiStudent.user._id, courseId));
    await admin.run((token) => assignCourseAccess(token, browserStudent.user._id, courseId));

    const lessonIds = uploadedLessons.map((lesson) => lesson.id);
    const apiStudentLessonsBeforeReady = await listVisibleStudentLessons(apiStudent.token, courseId);
    const browserStudentLessonsBeforeReady = await listVisibleStudentLessons(browserStudent.token, courseId);
    const visibleBeforeReady = lessonIds.filter((lessonId) =>
      apiStudentLessonsBeforeReady.some((lesson) => lesson.id === lessonId)
      || browserStudentLessonsBeforeReady.some((lesson) => lesson.id === lessonId));
    if (visibleBeforeReady.length > 0) {
      throw new Error(`New lesson(s) became visible to students before HLS was ready: ${visibleBeforeReady.join(', ')}`);
    }

    const hlsReady = await admin.run((token) => waitForLessonsReady(token, courseId, moduleEntry.id, lessonIds));
    report.hls = {
      readyAt: iso(),
      lessons: hlsReady.lessons.map((lesson: JsonRecord) => ({
        id: lesson.id,
        title: lesson.title,
        hlsProcessingStatus: lesson.hlsProcessingStatus,
        hlsPlaybackPath: lesson.hlsPlaybackPath,
        hlsManifestBundlePath: lesson.hlsManifestBundlePath,
      })),
      snapshots: hlsReady.snapshots,
    };
    const apiStudentLessonsAfterReady = await listVisibleStudentLessons(apiStudent.token, courseId);
    const missingAfterReady = lessonIds.filter((lessonId) =>
      !apiStudentLessonsAfterReady.some((lesson) => lesson.id === lessonId));
    if (missingAfterReady.length > 0) {
      throw new Error(`Ready lesson(s) stayed hidden from students after HLS completed: ${missingAfterReady.join(', ')}`);
    }

    for (const lessonId of lessonIds) {
      const apiPlayback = await verifyPlaybackApi(apiStudent.token, courseId, lessonId);
      report.apiPlayback.push({ lessonId, ...apiPlayback });
    }

    const browserPlayback = await verifyBrowserPlayback(browserStudent.token, courseId, lessonIds[0]);
    report.browserPlayback = browserPlayback;
    report.screenshots = browserPlayback.screenshots;
    report.finishedAt = iso();
    report.status = 'passed';
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    issues.push(message);
    report.finishedAt = iso();
    report.status = 'failed';
    await fs.writeFile(path.join(runDir, 'error.txt'), message);
  }

  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    `# Production Course Upload Playback QA`,
    ``,
    `- Status: ${report.status}`,
    `- Run: ${runId}`,
    `- Base URL: ${baseUrl}`,
    `- Course: ${report.course?.title || 'not created'} (${report.course?.id || 'n/a'})`,
    `- Uploads: ${report.uploads.length}`,
    `- Screenshots:`,
    ...((report.screenshots || []).map((shot: string) => `  - ${shot}`)),
    ``,
    `## Issues`,
    ...(issues.length ? issues.map((issue) => `- ${issue.split('\n')[0]}`) : ['- None found in this run.']),
  ].join('\n');
  await fs.writeFile(path.join(runDir, 'report.md'), md);

  console.log(JSON.stringify({
    status: report.status,
    runDir,
    course: report.course,
    uploads: report.uploads.map((entry: JsonRecord) => ({ lessonId: entry.lessonId, title: entry.title })),
    screenshots: report.screenshots,
    issues: issues.map((issue) => issue.split('\n')[0]),
  }, null, 2));

  if (report.status !== 'passed') {
    process.exitCode = 1;
  }
};

void run();
