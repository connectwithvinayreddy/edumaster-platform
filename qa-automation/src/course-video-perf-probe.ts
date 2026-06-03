import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer, { type HTTPRequest, type HTTPResponse } from 'puppeteer-core';
import { config } from './config.js';
import { selectors } from './selectors.js';
import { artifactPath, createRunContext, writeJson, writeText } from './utils.js';

type PlaybackMetric = {
  type: string;
  at: number;
  startupDelayMs?: number;
  totalBufferMs?: number;
  [key: string]: unknown;
};

type NetworkSample = {
  url: string;
  status: number;
  durationMs: number;
  cacheStatus: string;
  contentType: string;
};

type ScreenshotArtifact = {
  screenshotPath: string | null;
  sourcePath: string | null;
  error?: string | null;
};

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const courseId = process.env.QA_COURSE_ID || 'course_1899470118af44b4b9447b35fd296761';
const lessonId = process.env.QA_LESSON_ID || 'video_1778758229576';
const courseText = process.env.QA_COURSE_TEXT || 'SSC';
const lessonText = process.env.QA_LESSON_TEXT || 'INTRODUCTION';
const watchWindowMs = Math.max(10_000, Number(process.env.QA_WATCH_WINDOW_MS || 20_000));
const hlsPattern = /\/backend\/api\/course-manifests\/|\/backend\/api\/courses\/stream\/|\.m3u8(?:\?|$)|\.(?:ts|m4s|mp4)(?:\?|$)/i;

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const login = async () => {
  const response = await fetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.QA_LOGIN_EMAIL || config.loginEmail,
      password: process.env.QA_LOGIN_PASSWORD || config.loginPassword,
      device: 'QA Course Video Perf Probe',
      forceLogoutOtherSessions: true,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.message || payload?.error || 'Unable to login for course video perf probe.');
  }

  return payload.token as string;
};

const waitForSelectorOptional = async (page: puppeteer.Page, selector: string, timeoutMs: number) => page
  .waitForSelector(selector, { timeout: timeoutMs })
  .then(() => true)
  .catch(() => false);

const openCourseFromCatalog = async (page: puppeteer.Page, text: string) => {
  const clicked = await page.evaluate((cardSelector, courseLabel) => {
    const cards = Array.from(document.querySelectorAll(cardSelector)) as HTMLElement[];
    const target = cards.find((card) => (card.textContent || '').toLowerCase().includes(courseLabel.toLowerCase())) || cards[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseCatalogCard, text);
  if (!clicked) {
    throw new Error('No course card was available for the video perf probe.');
  }
};

const openLessonFromCourse = async (page: puppeteer.Page, text: string) => {
  await page.waitForSelector(selectors.courseLessonOpen, { timeout: 30_000 });
  const clicked = await page.evaluate((lessonSelector, lessonLabel) => {
    const buttons = Array.from(document.querySelectorAll(lessonSelector)) as HTMLElement[];
    const target = buttons.find((button) => (button.textContent || '').toLowerCase().includes(lessonLabel.toLowerCase())) || buttons[0];
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    target?.click();
    return Boolean(target);
  }, selectors.courseLessonOpen, text);
  if (!clicked) {
    throw new Error('No lesson entry was available for the video perf probe.');
  }
};

const screenshot = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  stepId: string,
  label: string,
) : Promise<ScreenshotArtifact> => {
  const screenshotPath = artifactPath(ctx.screenshotDir, stepId, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, stepId, label, 'html');
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false, captureBeyondViewport: false });
    await fs.writeFile(sourcePath, await page.content(), 'utf8');
    return { screenshotPath, sourcePath, error: null };
  } catch (error) {
    return {
      screenshotPath: null,
      sourcePath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const main = async () => {
  const ctx = await createRunContext();
  const token = await login();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const metrics: PlaybackMetric[] = [];
  const network: NetworkSample[] = [];
  const consoleLogs: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const artifactWarnings: string[] = [];
  const requestStartedAt = new Map<string, number>();

  try {
    const page = await browser.newPage();
    await page.exposeFunction('__recordCourseMetric', (metric: PlaybackMetric) => {
      metrics.push(metric);
    });
    await page.evaluateOnNewDocument((authToken) => {
      localStorage.setItem('edumaster.jwt', authToken);
      window.addEventListener('edumaster:hls-metric', (event) => {
        const detail = event instanceof CustomEvent ? event.detail : {};
        void (window as unknown as { __recordCourseMetric?: (metric: PlaybackMetric) => Promise<void> })
          .__recordCourseMetric?.(detail as PlaybackMetric);
      });
    }, token);

    page.on('console', (message) => {
      consoleLogs.push({ type: message.type(), text: message.text() });
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('request', (request: HTTPRequest) => {
      if (hlsPattern.test(request.url())) {
        requestStartedAt.set(request.url(), Date.now());
      }
    });
    page.on('response', (response: HTTPResponse) => {
      const url = response.url();
      if (!hlsPattern.test(url)) {
        return;
      }

      network.push({
        url,
        status: response.status(),
        durationMs: Math.max(Date.now() - (requestStartedAt.get(url) || Date.now()), 0),
        cacheStatus: response.headers()['x-recorded-hls-cache'] || response.headers()['x-cache-status'] || '',
        contentType: response.headers()['content-type'] || '',
      });
    });

    const lessonUrl = `${config.baseUrl.replace(/\/$/, '')}/?tab=courses&courseId=${encodeURIComponent(courseId)}&lessonId=${encodeURIComponent(lessonId)}`;
    const startedAt = Date.now();
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const loginVisible = await waitForSelectorOptional(page, selectors.loginEmail, 8_000);
    if (loginVisible) {
      await page.type(selectors.loginEmail, process.env.QA_LOGIN_EMAIL || config.loginEmail);
      await page.type(selectors.loginPassword, process.env.QA_LOGIN_PASSWORD || config.loginPassword);
      await page.click(selectors.loginSubmit);
      await page.waitForSelector(selectors.shellReady, { timeout: 45_000 });
      await page.goto(lessonUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }

    const playerReachedDirectly = await waitForSelectorOptional(page, `${selectors.coursePlayerHeading}, ${selectors.coursePlayerFullscreen}, video`, 20_000);
    if (!playerReachedDirectly) {
      await page.goto(`${config.baseUrl.replace(/\/$/, '')}/?tab=courses`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector(selectors.courseCatalogCard, { timeout: 30_000 });
      await openCourseFromCatalog(page, courseText);
      await openLessonFromCourse(page, lessonText);
      await page.waitForSelector(`${selectors.coursePlayerHeading}, ${selectors.coursePlayerFullscreen}, video`, { timeout: 30_000 });
    }

    const headingReadyMs = Date.now() - startedAt;
    const shellShot = await screenshot(page, ctx, '01', 'lesson-shell');
    if (shellShot.error) {
      artifactWarnings.push(`lesson-shell screenshot: ${shellShot.error}`);
    }

    await page.waitForSelector('video', { timeout: 30_000 });
    const videoElementReadyMs = Date.now() - startedAt;
    const videoShot = await screenshot(page, ctx, '02', 'video-visible');
    if (videoShot.error) {
      artifactWarnings.push(`video-visible screenshot: ${videoShot.error}`);
    }

    await page.click(selectors.coursePlayerVideoPlay).catch(() => undefined);
    await page.$eval('video', (video) => {
      (video as HTMLVideoElement).scrollIntoView({ block: 'center', inline: 'nearest' });
    }).catch(() => undefined);
    const videoHandle = await page.$('video');
    if (videoHandle) {
      const box = await videoHandle.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
      }
    }
    await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      if (!video) {
        return;
      }

      video.muted = true;
      video.volume = 0;
      void video.play().catch(() => undefined);
    });

    let firstFrameReached = false;
    try {
      await page.waitForFunction(() => {
        const video = document.querySelector('video') as HTMLVideoElement | null;
        return Boolean(video && video.currentTime > 1);
      }, { timeout: 30_000 });
      firstFrameReached = true;
    } catch {
      firstFrameReached = false;
    }

    const playbackShot = await screenshot(page, ctx, '03', firstFrameReached ? 'playback-started' : 'playback-failed');
    if (playbackShot.error) {
      artifactWarnings.push(`playback screenshot: ${playbackShot.error}`);
    }

    if (firstFrameReached) {
      await new Promise((resolve) => setTimeout(resolve, watchWindowMs));
      const watchShot = await screenshot(page, ctx, '04', 'watch-window');
      if (watchShot.error) {
        artifactWarnings.push(`watch-window screenshot: ${watchShot.error}`);
      }
    }

    const playerState = page.isClosed()
      ? null
      : await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement | null;
        return video ? {
          currentTime: Number(video.currentTime || 0),
          duration: Number.isFinite(video.duration) ? Number(video.duration) : null,
          paused: video.paused,
          ended: video.ended,
          readyState: video.readyState,
          networkState: video.networkState,
          currentSrc: video.currentSrc,
          error: video.error ? {
            code: video.error.code,
            message: video.error.message,
          } : null,
        } : null;
      });

    const manifestSamples = network.filter((entry) => /\.m3u8(?:\?|$)/i.test(entry.url) || /course-manifests/i.test(entry.url));
    const segmentSamples = network.filter((entry) => /\.(?:ts|m4s|mp4)(?:\?|$)/i.test(entry.url));
    const summary = {
      lessonUrl,
      measuredAt: new Date().toISOString(),
      headingReadyMs,
      videoElementReadyMs,
      firstFrameReached,
      firstFrameMs: metrics.find((entry) => entry.type === 'startup_ready')?.startupDelayMs || null,
      totalBufferMs: Math.max(...metrics.map((entry) => Number(entry.totalBufferMs || 0)), 0),
      bufferingEvents: metrics.filter((entry) => entry.type === 'buffering_end').length,
      manifestRequests: manifestSamples.length,
      manifestFailures: manifestSamples.filter((entry) => entry.status >= 400).length,
      segmentRequests: segmentSamples.length,
      segmentFailures: segmentSamples.filter((entry) => entry.status >= 400).length,
      averageManifestLatencyMs: manifestSamples.length
        ? Math.round(manifestSamples.reduce((sum, entry) => sum + entry.durationMs, 0) / manifestSamples.length)
        : null,
      averageSegmentLatencyMs: segmentSamples.length
        ? Math.round(segmentSamples.reduce((sum, entry) => sum + entry.durationMs, 0) / segmentSamples.length)
        : null,
      playerState,
      screenshots: [
        shellShot.screenshotPath,
        videoShot.screenshotPath,
        playbackShot.screenshotPath,
      ].filter(Boolean),
      artifactWarnings,
    };

    const markdown = [
      '# Course Video Perf Probe',
      '',
      `- Lesson URL: ${lessonUrl}`,
      `- Heading ready: ${headingReadyMs} ms`,
      `- Video element visible: ${videoElementReadyMs} ms`,
      `- First frame reached: ${firstFrameReached ? 'yes' : 'no'}`,
      `- First frame delay: ${summary.firstFrameMs ?? 'n/a'} ms`,
      `- Total buffered wait: ${summary.totalBufferMs} ms`,
      `- Manifest failures: ${summary.manifestFailures}/${summary.manifestRequests}`,
      `- Segment failures: ${summary.segmentFailures}/${summary.segmentRequests}`,
      playerState?.error ? `- Player error: ${playerState.error.message || `code ${playerState.error.code}`}` : '- Player error: none',
      ...artifactWarnings.map((warning) => `- Artifact warning: ${warning}`),
      '',
      '## Recent Console',
      '',
      ...consoleLogs.slice(-10).map((entry) => `- [console:${entry.type}] ${entry.text}`),
      ...pageErrors.slice(-10).map((entry) => `- [pageerror] ${entry}`),
    ].join('\n');

    await writeJson(path.join(ctx.analysisDir, 'course-video-perf-summary.json'), summary);
    await writeJson(path.join(ctx.logDir, 'course-video-perf-metrics.json'), metrics);
    await writeJson(path.join(ctx.logDir, 'course-video-perf-network.json'), network);
    await writeJson(path.join(ctx.logDir, 'course-video-perf-console.json'), consoleLogs);
    await writeJson(path.join(ctx.logDir, 'course-video-perf-page-errors.json'), pageErrors);
    await writeText(path.join(ctx.analysisDir, 'course-video-perf-summary.md'), markdown);

    console.log(JSON.stringify({ rootDir: ctx.rootDir, summary }, null, 2));
  } finally {
    await browser.close();
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
