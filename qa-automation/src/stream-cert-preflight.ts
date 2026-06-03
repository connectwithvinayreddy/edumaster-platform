import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createRunContext, writeJson } from './utils.js';
import { classifyRecordedDeliveryPath } from './recorded-delivery-path.js';
import { getStreamCertTargetSelection } from './stream-cert-targets.js';

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type PlayerPayload = {
  playbackSessionId?: string | null;
  streamUrl?: string | null;
  streamFormat?: string | null;
  deliveryProfile?: string | null;
  durationSeconds?: number | null;
  duration?: number | string | null;
  message?: string | null;
  code?: string | null;
};

type CourseAttachment = {
  id: string;
  title?: string | null;
};

type CourseLesson = {
  id: string;
  title: string;
  attachments?: CourseAttachment[];
  notesUrl?: string | null;
};

type CourseChapter = {
  id: string;
  title: string;
  attachments?: CourseAttachment[];
  lessons?: CourseLesson[];
};

type CourseModule = {
  id: string;
  title: string;
  attachments?: CourseAttachment[];
  lessons?: CourseLesson[];
  chapters?: CourseChapter[];
};

type CourseRecord = {
  _id: string;
  title: string;
  modules?: CourseModule[];
};

type TestRecord = {
  _id?: string;
  id?: string;
  title?: string | null;
};

const baseUrl = (process.env.QA_BASE_URL || config.baseUrl).replace(/\/+$/, '');
const apiBase = `${new URL(baseUrl).origin}/backend/api`;
const manifestPathValue = String(
  process.env.QA_STREAM_CERT_PREPARED_USERS_FILE
    || process.env.PLATFORM_LOAD_USERS_FILE
    || process.env.COURSE_LOAD_USERS_FILE
    || '',
).trim();
const manifestPath = manifestPathValue
  ? path.resolve(process.cwd(), manifestPathValue)
  : '';
const userPassword = String(process.env.PLATFORM_LOAD_USER_PASSWORD || process.env.QA_LOGIN_PASSWORD || 'Student@123').trim();
const isPlaceholderValue = (value: string) => /^(replace-with-|your-|example\.com|example\.net|placeholder|<[^>]+>)/i.test(String(value || '').trim());

const playbackHeaders = (token: string, label: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'x-edumaster-app': 'web',
  'x-edumaster-client-platform': 'windows',
  'x-edumaster-client-browser': 'chrome',
  'x-edumaster-device-id': `stream-cert-${label}`,
  'x-edumaster-playback-tab-id': `stream-cert-${label}`,
  'x-edumaster-browser-tab-id': `stream-cert-${label}`,
});

const readPreparedUsers = async () => {
  if (!manifestPath) {
    throw new Error('QA_STREAM_CERT_PREPARED_USERS_FILE or PLATFORM_LOAD_USERS_FILE is required for stream certification preflight.');
  }
  const users = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PreparedUser[];
  if (!Array.isArray(users) || !users.length) {
    throw new Error(`Prepared users manifest is empty: ${manifestPath}`);
  }
  return users;
};

const requestJson = async <T>(pathname: string, init: RequestInit) => {
  const response = await fetch(`${apiBase}${pathname}`, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { response, data: data as T };
};

const loginPreparedUser = async (email: string) => {
  const { response, data } = await requestJson<{ token?: string; message?: string }>('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: userPassword,
      device: 'QA stream certification preflight',
      forceLogoutOtherSessions: true,
    }),
  });
  if (!response.ok || !data?.token) {
    throw new Error(`Unable to refresh prepared user token for ${email}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return String(data.token);
};

const findAttachmentInCourse = (course: CourseRecord, attachmentId: string) => {
  for (const module of course.modules || []) {
    for (const attachment of module.attachments || []) {
      if (attachment.id === attachmentId) {
        return { scope: 'module', title: attachment.title || module.title || 'Module PDF' };
      }
    }
    for (const lesson of module.lessons || []) {
      for (const attachment of lesson.attachments || []) {
        if (attachment.id === attachmentId) {
          return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF' };
        }
      }
    }
    for (const chapter of module.chapters || []) {
      for (const attachment of chapter.attachments || []) {
        if (attachment.id === attachmentId) {
          return { scope: 'chapter', title: attachment.title || chapter.title || 'Chapter PDF' };
        }
      }
      for (const lesson of chapter.lessons || []) {
        for (const attachment of lesson.attachments || []) {
          if (attachment.id === attachmentId) {
            return { scope: 'lesson', title: attachment.title || lesson.title || 'Lesson PDF' };
          }
        }
      }
    }
  }
  return null;
};

const normalizeId = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  return String(record._id || record.id || '').trim();
};

const fetchPdfProbe = async (token: string, courseId: string, attachmentId: string, label: string) => {
  const response = await fetch(`${apiBase}/courses/${encodeURIComponent(courseId)}/pdf-attachments/${encodeURIComponent(attachmentId)}/view`, {
    headers: {
      ...playbackHeaders(token, label),
      accept: 'application/pdf',
      range: 'bytes=0-65535',
    },
  });
  const reader = response.body?.getReader?.();
  let bytesRead = 0;
  if (reader) {
    try {
      while (bytesRead < 65_536) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        bytesRead += chunk.value?.byteLength || 0;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } else {
    const buffer = await response.arrayBuffer();
    bytesRead = buffer.byteLength;
  }
  return {
    status: response.status,
    ok: response.ok || response.status === 206,
    bytesRead,
    contentType: response.headers.get('content-type') || '',
    contentRange: response.headers.get('content-range') || null,
  };
};

const main = async () => {
  const ctx = await createRunContext();
  const { target, index, targets } = await getStreamCertTargetSelection();
  const users = await readPreparedUsers();
  const firstUser = users[0];
  const token = await loginPreparedUser(firstUser.email);

  const courseResult = await requestJson<CourseRecord>(`/courses/${encodeURIComponent(target.courseId)}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  if (!courseResult.response.ok) {
    throw new Error(`Unable to load course ${target.courseId} for preflight: ${courseResult.response.status}`);
  }

  const pdfConfigured = !isPlaceholderValue(target.pdfAttachmentId);
  const testConfigured = !isPlaceholderValue(target.testId);
  const attachmentMatch = pdfConfigured ? findAttachmentInCourse(courseResult.data, target.pdfAttachmentId) : null;
  if (pdfConfigured && !attachmentMatch) {
    throw new Error(`Target PDF attachment ${target.pdfAttachmentId} is not visible to the prepared student in course ${target.courseId}.`);
  }

  const playerResult = await requestJson<PlayerPayload>(`/courses/${encodeURIComponent(target.courseId)}/lessons/${encodeURIComponent(target.lessonId)}/player`, {
    method: 'GET',
    headers: playbackHeaders(token, `${target.key}-player`),
  });
  if (!playerResult.response.ok) {
    throw new Error(`Player bootstrap failed for ${target.courseText} / ${target.lessonText}: ${playerResult.response.status} ${JSON.stringify(playerResult.data).slice(0, 300)}`);
  }

  const deliveryPath = classifyRecordedDeliveryPath({
    deliveryProfile: playerResult.data.deliveryProfile || null,
    streamFormat: playerResult.data.streamFormat || null,
    src: playerResult.data.streamUrl || null,
  });
  const streamUrl = String(playerResult.data.streamUrl || '');
  if (deliveryPath !== target.expectedDeliveryPath) {
    throw new Error(`Expected ${target.expectedDeliveryPath} but /player resolved to ${deliveryPath} for ${target.courseText} / ${target.lessonText}.`);
  }
  if (/cloudflarestream\.com|videodelivery\.net/i.test(streamUrl)) {
    throw new Error(`Target lesson still resolves to direct Cloudflare Stream: ${streamUrl}`);
  }
  if (!playerResult.data.playbackSessionId) {
    throw new Error(`Target lesson did not return playbackSessionId for ${target.courseText} / ${target.lessonText}.`);
  }

  const pdfProbe = pdfConfigured
    ? await fetchPdfProbe(token, target.courseId, target.pdfAttachmentId, `${target.key}-pdf`)
    : {
        status: null,
        ok: true,
        bytesRead: 0,
        contentType: '',
        contentRange: null,
        skipped: true,
      };
  if (pdfConfigured && !pdfProbe.ok) {
    throw new Error(`Protected PDF probe failed for ${target.courseText}: status=${pdfProbe.status}`);
  }
  if (pdfConfigured && !/application\/pdf/i.test(pdfProbe.contentType)) {
    throw new Error(`Protected PDF probe did not return application/pdf for ${target.courseText}; got ${pdfProbe.contentType || '(none)'}`);
  }

  const testsListResult = testConfigured
    ? await requestJson<TestRecord[]>('/tests', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
      })
    : null;
  if (testConfigured && !testsListResult?.response.ok) {
    throw new Error(`Unable to load tests list for ${target.courseText}: ${testsListResult?.response.status}`);
  }
  const testsList = Array.isArray(testsListResult?.data) ? testsListResult.data : [];
  const listMatch = testConfigured
    ? testsList.find((entry) => normalizeId(entry) === target.testId) || null
    : null;

  const testDetailResult = testConfigured
    ? await requestJson<TestRecord>(`/tests/${encodeURIComponent(target.testId)}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
      })
    : null;
  if (testConfigured && !testDetailResult?.response.ok) {
    throw new Error(`Target test ${target.testId} is not accessible to the prepared student in ${target.courseText}.`);
  }
  const resolvedTestTitle = String(
    testDetailResult?.data?.title
      || listMatch?.title
      || target.testTitle
      || 'Mock Test',
  ).trim();

  const summary = {
    ok: true,
    manifestPath,
    selectedTargetIndex: index,
    selectedTargetKey: target.key,
    targetCount: targets.length,
    preparedUserEmail: firstUser.email,
    course: {
      id: target.courseId,
      title: target.courseText,
    },
    lesson: {
      id: target.lessonId,
      title: target.lessonText,
    },
    pdf: {
      attachmentId: target.pdfAttachmentId,
      configured: pdfConfigured,
      title: target.pdfAttachmentTitle || attachmentMatch?.title || null,
      scope: attachmentMatch?.scope || null,
      probe: pdfProbe,
    },
    test: {
      id: target.testId,
      configured: testConfigured,
      title: resolvedTestTitle,
      listed: Boolean(listMatch),
      detailStatus: testDetailResult?.response.status ?? null,
    },
    player: {
      playbackSessionId: playerResult.data.playbackSessionId || null,
      streamUrl,
      streamFormat: playerResult.data.streamFormat || null,
      deliveryProfile: playerResult.data.deliveryProfile || null,
      deliveryPath,
      durationSeconds: playerResult.data.durationSeconds ?? playerResult.data.duration ?? null,
    },
  };

  await writeJson(path.join(ctx.analysisDir, 'stream-cert-preflight.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
