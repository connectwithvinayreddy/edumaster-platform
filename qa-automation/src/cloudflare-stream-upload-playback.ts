import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, sleep, writeJson } from './utils.js';

type EnvMap = Record<string, string>;

type ApiResult<T> = {
  status: number;
  payload: T;
};

type Course = {
  _id: string;
  title: string;
};

type Module = {
  id: string;
  title: string;
};

type Chapter = {
  id: string;
  title: string;
};

type UploadSession = {
  upload: {
    uid: string;
    uploadURL: string;
    method: 'tus' | 'direct-post' | string;
    maxDurationSeconds?: number | null;
  };
  video: {
    id: string;
    title: string;
  };
};

type PlaybackPayload = {
  streamUrl?: string;
  hlsManifestUrl?: string;
  playbackUrl?: string;
  deliveryProfile?: string;
  playback?: {
    hls?: string;
  };
};

const rootDir = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');

const readEnvFile = async (): Promise<EnvMap> => {
  const candidates = [
    path.join(rootDir, '.env.production'),
    path.resolve(process.cwd(), '..', '.env.production'),
  ];
  const values: EnvMap = {};
  for (const envPath of candidates) {
    try {
      const text = await fs.readFile(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex <= 0) {
          continue;
        }
        const key = trimmed.slice(0, separatorIndex).trim();
        const rawValue = trimmed.slice(separatorIndex + 1).trim();
        values[key] = rawValue.replace(/^['"]|['"]$/g, '');
      }
      return values;
    } catch {
      // Try the next candidate.
    }
  }
  return values;
};

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const edgeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';

const apiUrl = (pathName: string) => new URL(pathName, apiOrigin).toString();

const readResponseBody = async (response: Response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

const isVisibleSelector = async (page: puppeteer.Page, selector: string) =>
  page.$eval(selector, (element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    const style = window.getComputedStyle(target);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && Number(style.opacity || 1) > 0;
  }).catch(() => false);

const loginForToken = async (email: string, password: string) => {
  const response = await fetch(apiUrl('/backend/api/auth/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device: 'QA Cloudflare Stream Upload Playback',
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await readResponseBody(response);
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message || payload?.error || `Login failed with ${response.status}`);
  }
  return String(payload.token);
};

const apiRequest = async <T>(
  token: string,
  pathName: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> => {
  const response = await fetch(apiUrl(pathName), {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': edgeUserAgent,
      ...(init.headers || {}),
    },
  });
  const payload = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `${pathName} failed with ${response.status}`);
  }
  return { status: response.status, payload: payload as T };
};

const headTusOffset = async (uploadURL: string) => {
  const response = await fetch(uploadURL, {
    method: 'HEAD',
    headers: {
      'Tus-Resumable': '1.0.0',
    },
  });
  if (!response.ok) {
    throw new Error(`Cloudflare TUS HEAD failed with ${response.status}`);
  }
  return Number(response.headers.get('upload-offset') || '0');
};

const uploadTusFile = async (uploadURL: string, filePath: string) => {
  const file = await fs.readFile(filePath);
  const totalBytes = file.byteLength;
  const chunkSize = Number(process.env.QA_STREAM_UPLOAD_CHUNK_BYTES || 8 * 1024 * 1024);
  let offset = await headTusOffset(uploadURL);
  const chunks: Array<{ offset: number; bytes: number; status: number }> = [];

  while (offset < totalBytes) {
    const end = Math.min(offset + chunkSize, totalBytes);
    const chunk = file.subarray(offset, end);
    const response = await fetch(uploadURL, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: chunk,
    });

    if (response.status === 409) {
      offset = await headTusOffset(uploadURL);
      continue;
    }

    if (!response.ok && response.status !== 204) {
      const body = await response.text().catch(() => '');
      throw new Error(`Cloudflare TUS PATCH failed with ${response.status}: ${body.slice(0, 160)}`);
    }

    const nextOffset = Number(response.headers.get('upload-offset') || end);
    chunks.push({ offset, bytes: chunk.byteLength, status: response.status });
    offset = nextOffset;
  }

  return {
    totalBytes,
    uploadedBytes: offset,
    chunks,
  };
};

const uploadDirectPostFile = async (uploadURL: string, filePath: string) => {
  const file = await fs.readFile(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([file], { type: 'video/mp4' }), path.basename(filePath));
  const response = await fetch(uploadURL, {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Cloudflare direct upload failed with ${response.status}: ${body.slice(0, 160)}`);
  }
  return {
    totalBytes: file.byteLength,
    uploadedBytes: file.byteLength,
    chunks: [{ offset: 0, bytes: file.byteLength, status: response.status }],
  };
};

const getManifestUrl = (payload: PlaybackPayload) =>
  payload.streamUrl
  || payload.hlsManifestUrl
  || payload.playbackUrl
  || payload.playback?.hls
  || '';

const waitForPlaybackReady = async ({
  token,
  courseId,
  moduleId,
  uid,
  lessonId,
}: {
  token: string;
  courseId: string;
  moduleId: string;
  uid: string;
  lessonId: string;
}) => {
  const attempts: Array<{
    attempt: number;
    completeStatus?: string;
    readyToStream?: boolean;
    playerStatus?: number;
    manifestStatus?: number;
    note?: string;
  }> = [];
  const deadline = Date.now() + Number(process.env.QA_STREAM_READY_TIMEOUT_MS || 8 * 60_000);
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const statusEntry: (typeof attempts)[number] = { attempt };
    const completeResponse = await apiRequest<{
      status: string;
      readyToStream: boolean;
    }>(token, `/backend/api/courses/${courseId}/modules/${moduleId}/videos/cloudflare/complete`, {
      method: 'POST',
      body: JSON.stringify({ uid, lessonId }),
    }).catch((error) => {
      statusEntry.note = `complete failed: ${error instanceof Error ? error.message : String(error)}`;
      return null;
    });
    statusEntry.completeStatus = completeResponse?.payload?.status;
    statusEntry.readyToStream = completeResponse?.payload?.readyToStream;

    const playerResponse = await fetch(apiUrl(`/backend/api/courses/${courseId}/lessons/${lessonId}/player`), {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': edgeUserAgent,
      },
    });
    statusEntry.playerStatus = playerResponse.status;
    const playerPayload = await readResponseBody(playerResponse) as PlaybackPayload & { message?: string };

    if (playerResponse.ok) {
      const manifestUrl = getManifestUrl(playerPayload);
      if (manifestUrl) {
        const manifestResponse = await fetch(manifestUrl, {
          headers: {
            'user-agent': edgeUserAgent,
          },
        });
        statusEntry.manifestStatus = manifestResponse.status;
        attempts.push(statusEntry);
        if (manifestResponse.ok) {
          return {
            playerPayload,
            manifestStatus: manifestResponse.status,
            attempts,
          };
        }
      } else {
        statusEntry.note = 'player response did not contain a manifest url';
      }
    } else {
      statusEntry.note = playerPayload?.message || playerPayload?.['error'] || `player not ready: ${playerResponse.status}`;
    }

    attempts.push(statusEntry);
    await sleep(Number(process.env.QA_STREAM_READY_POLL_MS || 15_000));
  }

  throw new Error(`Uploaded Cloudflare Stream lesson was not playback-ready after ${attempt} checks.`);
};

const openUploadedLessonInBrowser = async ({
  token,
  email,
  password,
  courseTitle,
  lessonTitle,
  screenshotDir,
  sourceDir,
}: {
  token: string;
  email: string;
  password: string;
  courseTitle: string;
  lessonTitle: string;
  screenshotDir: string;
  sourceDir: string;
}) => {
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

  let page: puppeteer.Page | null = null;
  const checkpoints: string[] = [];
  try {
    page = await browser.newPage();
    await page.setUserAgent(edgeUserAgent);
    await page.setViewport({ width: 2000, height: 1300 });
    checkpoints.push('new-page');
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    checkpoints.push('initial-load');
    await page.evaluate((authToken) => {
      window.localStorage.setItem('edumaster.jwt', authToken);
    }, token);
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    checkpoints.push('authenticated-load');
    await page.waitForSelector(`${selectors.shellReady}, ${selectors.overviewDashboard}, ${selectors.loginEmail}`, { timeout: 45_000 });
    checkpoints.push('shell-ready');

    if (await isVisibleSelector(page, selectors.loginEmail)) {
      await page.locator(selectors.loginEmail).fill(email);
      await page.locator(selectors.loginPassword).fill(password);
      await page.locator(selectors.loginSubmit).click();
      await page.waitForSelector(`${selectors.shellReady}, ${selectors.overviewDashboard}`, { timeout: 45_000 });
      checkpoints.push('ui-login-recovered');
    }

    await page.evaluate((targetSelector) => {
      const element = document.querySelector(targetSelector) as HTMLElement | null;
      element?.click();
    }, selectors.navCourses);
    await page.waitForSelector(selectors.courseCatalogView, { timeout: 30_000 });
    checkpoints.push('course-catalog');
    let courseVisible = await page.evaluate((cardSelector, expectedTitle) => {
      const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
      return cards.some((card) => (card.textContent || '').includes(expectedTitle));
    }, selectors.courseCatalogCard, courseTitle);
    if (!courseVisible && await page.$(selectors.courseCatalogSearch)) {
      await page.evaluate((searchSelector, value) => {
        const input = document.querySelector(searchSelector) as HTMLInputElement | null;
        if (!input) {
          return;
        }
        input.focus();
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, selectors.courseCatalogSearch, courseTitle);
      await sleep(800);
      checkpoints.push('course-search-filled');
      courseVisible = await page.evaluate((cardSelector, expectedTitle) => {
        const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
        return cards.some((card) => (card.textContent || '').includes(expectedTitle));
      }, selectors.courseCatalogCard, courseTitle);
    }

    const openedCourse = courseVisible && await page.evaluate((cardSelector, expectedTitle) => {
      const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
      const target = cards.find((card) => (card.textContent || '').includes(expectedTitle));
      target?.scrollIntoView({ block: 'center', inline: 'nearest' });
      target?.click();
      return Boolean(target);
    }, selectors.courseCatalogCard, courseTitle);
    if (!openedCourse) {
      throw new Error(`Uploaded QA course was not visible in the course catalog: ${courseTitle}`);
    }

    await page.waitForSelector(selectors.courseCourseView, { timeout: 30_000 });
    checkpoints.push('course-opened');
    const openedLesson = await page.evaluate((lessonSelector, expectedTitle) => {
      const buttons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
      const target = buttons.find((button) => (button.textContent || '').includes(expectedTitle));
      target?.scrollIntoView({ block: 'center', inline: 'nearest' });
      target?.click();
      return Boolean(target);
    }, selectors.courseLessonOpen, lessonTitle);
    if (!openedLesson) {
      throw new Error(`Uploaded QA lesson was not visible in the course page: ${lessonTitle}`);
    }

    await page.waitForSelector(selectors.courseLessonView, { timeout: 30_000 });
    checkpoints.push('lesson-opened');
    await page.waitForSelector(selectors.coursePlayerVideo, { timeout: 30_000 });
    checkpoints.push('video-found');
    await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      void video?.play?.().catch(() => undefined);
    }, selectors.coursePlayerVideo);
    await sleep(Number(process.env.QA_STREAM_BROWSER_WAIT_MS || 15_000));

    const screenshotPath = artifactPath(screenshotDir, 'cloudflare-stream-upload-playback', 'browser', 'png');
    const sourcePath = artifactPath(sourceDir, 'cloudflare-stream-upload-playback', 'browser', 'html');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.writeFile(sourcePath, await page.content(), 'utf8');

    const diagnostics = await page.evaluate((videoSelector) => {
      const video = document.querySelector(videoSelector) as HTMLVideoElement | null;
      const bodyText = document.body?.innerText || '';
      return {
        currentTime: video?.currentTime ?? null,
        duration: Number.isFinite(video?.duration) ? video?.duration : null,
        readyState: video?.readyState ?? null,
        networkState: video?.networkState ?? null,
        currentSrc: video?.currentSrc || null,
        error: video?.error ? {
          code: video.error.code,
          message: video.error.message,
        } : null,
        reconnectingVisible: /reconnecting/i.test(bodyText),
      };
    }, selectors.coursePlayerVideo);

    const playable = Number(diagnostics.currentTime || 0) > 0.25 || Number(diagnostics.readyState || 0) >= 3;
    if (!playable || diagnostics.reconnectingVisible || diagnostics.error) {
      throw new Error(`Uploaded lesson browser playback failed: ${JSON.stringify(diagnostics)}`);
    }

    return {
      diagnostics,
      checkpoints,
      screenshotPath,
      sourcePath,
    };
  } catch (error) {
    if (page) {
      const screenshotPath = artifactPath(screenshotDir, 'cloudflare-stream-upload-playback', 'browser-failure', 'png');
      const sourcePath = artifactPath(sourceDir, 'cloudflare-stream-upload-playback', 'browser-failure', 'html');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await fs.writeFile(sourcePath, await page.content(), 'utf8').catch(() => undefined);
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
      const diagnosticPath = path.join(path.dirname(sourcePath), 'cloudflare-stream-upload-playback-browser-failure.json');
      await writeJson(diagnosticPath, {
        message: error instanceof Error ? error.message : String(error),
        checkpoints,
        bodyText,
        screenshotPath,
        sourcePath,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
  }
};

const deleteCloudflareVideo = async (env: EnvMap, uid: string) => {
  const accountId = process.env.CLOUDFLARE_STREAM_ACCOUNT_ID || env.CLOUDFLARE_STREAM_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_STREAM_API_TOKEN || env.CLOUDFLARE_STREAM_API_TOKEN;
  if (!accountId || !token || !uid) {
    return false;
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/stream/${encodeURIComponent(uid)}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
  );
  return response.ok || response.status === 404;
};

const main = async () => {
  const env = await readEnvFile();
  const email = process.env.QA_LOGIN_EMAIL || process.env.ADMIN_EMAIL || env.ADMIN_EMAIL || config.loginEmail;
  const password = process.env.QA_LOGIN_PASSWORD || process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || config.loginPassword;
  const uploadFilePath = path.resolve(rootDir, process.env.QA_STREAM_UPLOAD_FILE || 'uploads/live-fallback.mp4');
  const declaredDurationMinutes = Number(process.env.QA_STREAM_DECLARED_DURATION_MINUTES || 1);
  if (!email || !password) {
    throw new Error('QA_LOGIN_EMAIL/QA_LOGIN_PASSWORD or ADMIN_EMAIL/ADMIN_PASSWORD is required.');
  }

  const ctx = await createRunContext();
  const runSuffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const courseTitle = `QA Cloudflare Stream ${runSuffix}`;
  const moduleTitle = 'QA Stream Module';
  const chapterTitle = 'QA Stream Chapter';
  const lessonTitle = `QA Upload ${runSuffix}`;
  const cleanup = process.env.QA_STREAM_KEEP_COURSE !== 'true';
  const token = await loginForToken(email, password);
  let createdCourseId: string | null = null;
  let createdModuleId: string | null = null;
  let streamUid: string | null = null;

  try {
    const stat = await fs.stat(uploadFilePath);
    const courseResponse = await apiRequest<Course>(token, '/backend/api/courses', {
      method: 'POST',
      body: JSON.stringify({
        title: courseTitle,
        description: 'Temporary QA course for Cloudflare Stream upload and playback verification.',
        category: 'QA',
        exam: 'QA',
        subject: 'Cloudflare Stream',
        instructor: 'QA Automation',
        level: 'Production smoke',
        price: 1500,
        offerPercentage: 0,
        validityDays: 365,
        modules: [],
      }),
    });
    createdCourseId = courseResponse.payload._id;

    const moduleResponse = await apiRequest<{ module: Module }>(token, `/backend/api/courses/${createdCourseId}/modules`, {
      method: 'POST',
      body: JSON.stringify({
        title: moduleTitle,
        description: 'Cloudflare upload smoke module.',
      }),
    });
    createdModuleId = moduleResponse.payload.module.id;

    const chapterResponse = await apiRequest<{ chapter: Chapter }>(
      token,
      `/backend/api/courses/${createdCourseId}/modules/${createdModuleId}/chapters`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: chapterTitle,
          description: 'Cloudflare upload smoke chapter.',
        }),
      },
    );
    const chapterId = chapterResponse.payload.chapter.id;

    const uploadSessionResponse = await apiRequest<UploadSession>(
      token,
      `/backend/api/courses/${createdCourseId}/modules/${createdModuleId}/videos/cloudflare/direct-upload`,
      {
        method: 'POST',
        body: JSON.stringify({
          lessonTitle,
          lessonType: 'video',
          durationMinutes: Number.isFinite(declaredDurationMinutes) ? declaredDurationMinutes : 1,
          isPremium: false,
          chapterId,
          originalFilename: path.basename(uploadFilePath),
          mimeType: 'video/mp4',
          fileSize: stat.size,
        }),
      },
    );
    const uploadSession = uploadSessionResponse.payload;
    streamUid = uploadSession.upload.uid;

    const uploadResult = uploadSession.upload.method === 'direct-post'
      ? await uploadDirectPostFile(uploadSession.upload.uploadURL, uploadFilePath)
      : await uploadTusFile(uploadSession.upload.uploadURL, uploadFilePath);

    await apiRequest(token, `/backend/api/courses/${createdCourseId}/modules/${createdModuleId}/videos/cloudflare/complete`, {
      method: 'POST',
      body: JSON.stringify({
        uid: uploadSession.upload.uid,
        lessonId: uploadSession.video.id,
      }),
    });

    const playback = await waitForPlaybackReady({
      token,
      courseId: createdCourseId,
      moduleId: createdModuleId,
      uid: uploadSession.upload.uid,
      lessonId: uploadSession.video.id,
    });

    const browserPlayback = await openUploadedLessonInBrowser({
      token,
      email,
      password,
      courseTitle,
      lessonTitle,
      screenshotDir: ctx.screenshotDir,
      sourceDir: ctx.sourceDir,
    });

    const summary = {
      ok: true,
      baseUrl: config.baseUrl,
      courseTitle,
      lessonTitle,
      upload: {
        method: uploadSession.upload.method,
        uid: uploadSession.upload.uid,
        maxDurationSeconds: uploadSession.upload.maxDurationSeconds ?? null,
        declaredDurationMinutes,
        totalBytes: uploadResult.totalBytes,
        uploadedBytes: uploadResult.uploadedBytes,
        chunks: uploadResult.chunks.length,
      },
      playback: {
        deliveryProfile: playback.playerPayload.deliveryProfile || null,
        manifestStatus: playback.manifestStatus,
        attempts: playback.attempts,
      },
      browserPlayback,
      cleanup,
    };
    await writeJson(path.join(ctx.analysisDir, 'cloudflare-stream-upload-playback.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    const cleanupResults: Record<string, boolean | string> = {};
    if (cleanup && createdCourseId) {
      try {
        await apiRequest(token, `/backend/api/courses/${createdCourseId}`, { method: 'DELETE' });
        cleanupResults.courseDeleted = true;
      } catch (error) {
        cleanupResults.courseDeleted = error instanceof Error ? error.message : String(error);
      }
    }
    if (cleanup && streamUid) {
      try {
        cleanupResults.streamDeleted = await deleteCloudflareVideo(env, streamUid);
      } catch (error) {
        cleanupResults.streamDeleted = error instanceof Error ? error.message : String(error);
      }
    }
    if (Object.keys(cleanupResults).length > 0) {
      await writeJson(path.join(ctx.analysisDir, 'cloudflare-stream-upload-cleanup.json'), cleanupResults);
    }
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
