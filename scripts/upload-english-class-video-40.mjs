import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.production' });

const apiBaseUrl = (process.env.UPLOAD_API_BASE_URL || 'https://app.varonenglishapp.in/backend/api').replace(/\/+$/, '');
const videoPath = process.env.UPLOAD_VIDEO_PATH || '/Users/anudeepreddypolu/Downloads/InShot_20260522_202208186.mp4';
const courseTitle = process.env.UPLOAD_COURSE_TITLE || 'Bank';
const moduleTitle = process.env.UPLOAD_MODULE_TITLE || 'English';
const totalClasses = Number(process.env.UPLOAD_TOTAL_CLASSES || 40);
const chunkSizeBytes = Number(process.env.UPLOAD_CHUNK_SIZE_BYTES || 20 * 1024 * 1024);
const durationMinutes = Number(process.env.UPLOAD_DURATION_MINUTES || 40);
const artifactPath = process.env.UPLOAD_ARTIFACT_PATH || path.resolve('qa-automation/artifacts/english-40-upload-report.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const slugify = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const requestJson = async (input, init = {}) => {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed: ${response.status}`);
  }
  return payload;
};

const login = async () => {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required in .env.production');
  }

  return requestJson(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      device: 'english-class-video-40-uploader',
      forceLogoutOtherSessions: true,
    }),
  });
};

const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

const getAdminCourses = (token) => requestJson(`${apiBaseUrl}/courses/admin/list`, {
  headers: authHeaders(token),
});

const addChapter = (token, courseId, moduleId, title, order) => requestJson(
  `${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(moduleId)}/chapters`,
  {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title,
      description: `${title} video class.`,
      order,
    }),
  },
);

const findTarget = async (token) => {
  const courses = await getAdminCourses(token);
  const course = courses.find((entry) => String(entry.title || '').trim().toLowerCase() === courseTitle.toLowerCase());
  if (!course) {
    throw new Error(`Course "${courseTitle}" not found.`);
  }

  const moduleEntry = (course.modules || []).find((entry) => String(entry.title || '').trim().toLowerCase() === moduleTitle.toLowerCase());
  if (!moduleEntry) {
    throw new Error(`Module "${moduleTitle}" not found in course "${courseTitle}".`);
  }

  return { course, moduleEntry };
};

const ensureFortyChapters = async (token) => {
  let { course, moduleEntry } = await findTarget(token);
  const existing = Array.isArray(moduleEntry.chapters) ? moduleEntry.chapters : [];

  for (let index = existing.length; index < totalClasses; index += 1) {
    const classNumber = index + 1;
    const title = `English Class ${String(classNumber).padStart(2, '0')}`;
    console.log(`[chapters] creating ${title}`);
    await addChapter(token, course._id, moduleEntry.id, title, classNumber);
    await sleep(500);
    ({ course, moduleEntry } = await findTarget(token));
  }

  const chapters = [...(moduleEntry.chapters || [])]
    .slice(0, totalClasses)
    .map((chapter, index) => ({ ...chapter, classNumber: index + 1 }));

  if (chapters.length !== totalClasses) {
    throw new Error(`Expected ${totalClasses} chapters/classes, found ${chapters.length}.`);
  }

  return { course, moduleEntry, chapters };
};

const readChunk = async (handle, start, length) => {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return buffer.subarray(0, bytesRead);
};

const uploadVideoToChapter = async ({ token, courseId, moduleId, chapterId, classNumber, chapterTitle, stats }) => {
  const fileName = path.basename(videoPath);
  const lessonTitle = `${String(classNumber).padStart(2, '0')} - ${chapterTitle} - ${fileName.replace(/\.mp4$/i, '')}`;
  const uploadId = `english40-${slugify(chapterId)}-${Date.now()}`;
  const totalChunks = Math.ceil(stats.size / chunkSizeBytes);
  const handle = await fs.open(videoPath, 'r');

  try {
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * chunkSizeBytes;
      const end = Math.min(start + chunkSizeBytes, stats.size);
      const chunk = await readChunk(handle, start, end - start);
      let lastError = null;

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const formData = new FormData();
          formData.append('chunk', new Blob([chunk], { type: 'video/mp4' }), fileName);
          formData.append('lessonTitle', lessonTitle);
          formData.append('durationMinutes', String(durationMinutes));
          formData.append('isPremium', 'true');
          formData.append('lessonType', 'video');
          formData.append('chapterId', chapterId);
          formData.append('uploadId', uploadId);
          formData.append('chunkIndex', String(chunkIndex));
          formData.append('totalChunks', String(totalChunks));
          formData.append('originalFilename', fileName);
          formData.append('mimeType', 'video/mp4');
          formData.append('fileSize', String(stats.size));

          await requestJson(
            `${apiBaseUrl}/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(moduleId)}/videos/chunked`,
            {
              method: 'POST',
              headers: authHeaders(token),
              body: formData,
            },
          );

          const percent = Math.round(((chunkIndex + 1) / totalChunks) * 100);
          console.log(`[upload] class ${classNumber}/${totalClasses} chunk ${chunkIndex + 1}/${totalChunks} ${percent}%`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.warn(`[upload] retry class ${classNumber} chunk ${chunkIndex + 1}, attempt ${attempt}: ${lastError.message}`);
          await sleep(1500 * attempt);
        }
      }

      if (lastError) {
        throw lastError;
      }
    }
  } finally {
    await handle.close();
  }

  return { lessonTitle, uploadId };
};

const main = async () => {
  const stats = await fs.stat(videoPath);
  if (!stats.isFile()) {
    throw new Error(`Video path is not a file: ${videoPath}`);
  }

  const { token } = await login();
  const startedAt = nowIso();
  const results = [];
  const { course, moduleEntry, chapters } = await ensureFortyChapters(token);

  for (const chapter of chapters) {
    const expectedLessonTitle = `${String(chapter.classNumber).padStart(2, '0')} - ${chapter.title} - ${path.basename(videoPath).replace(/\.mp4$/i, '')}`;
    const alreadyUploaded = (chapter.lessons || []).some((lesson) => String(lesson.title || '').trim().toLowerCase() === expectedLessonTitle.toLowerCase());
    if (alreadyUploaded) {
      console.log(`[skip] class ${chapter.classNumber}/${totalClasses} already has ${expectedLessonTitle}`);
      results.push({
        classNumber: chapter.classNumber,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        uploaded: false,
        skipped: true,
        lessonTitle: expectedLessonTitle,
      });
      continue;
    }

    console.log(`[upload] starting class ${chapter.classNumber}/${totalClasses}: ${chapter.title}`);
    const uploaded = await uploadVideoToChapter({
      token,
      courseId: course._id,
      moduleId: moduleEntry.id,
      chapterId: chapter.id,
      classNumber: chapter.classNumber,
      chapterTitle: chapter.title,
      stats,
    });
    results.push({
      classNumber: chapter.classNumber,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      uploaded: true,
      skipped: false,
      lessonTitle: uploaded.lessonTitle,
      uploadId: uploaded.uploadId,
    });
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, JSON.stringify({ startedAt, updatedAt: nowIso(), videoPath, courseTitle, moduleTitle, results }, null, 2));
    await sleep(1500);
  }

  const final = await findTarget(token);
  const finalChapters = (final.moduleEntry.chapters || []).slice(0, totalClasses);
  const missing = results.filter((result) => {
    const chapter = finalChapters.find((entry) => entry.id === result.chapterId);
    return !(chapter?.lessons || []).some((lesson) => String(lesson.title || '') === String(result.lessonTitle || ''));
  });

  const report = {
    startedAt,
    completedAt: nowIso(),
    videoPath,
    videoSizeBytes: stats.size,
    apiBaseUrl,
    courseId: course._id,
    courseTitle,
    moduleId: moduleEntry.id,
    moduleTitle,
    totalClasses,
    uploadedCount: results.filter((result) => result.uploaded).length,
    skippedCount: results.filter((result) => result.skipped).length,
    missing,
    results,
  };

  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, JSON.stringify(report, null, 2));

  if (missing.length > 0) {
    throw new Error(`Upload verification failed for ${missing.length} classes. See ${artifactPath}`);
  }

  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
