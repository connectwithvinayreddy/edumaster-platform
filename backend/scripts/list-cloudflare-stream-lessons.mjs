import { createRequire } from 'node:module';
import { connectDatabase } from '../lib/database.js';

const require = createRequire(import.meta.url);
const { coursesRepository } = require('../lib/repositories.js');

const TARGET_COURSE_ID = String(process.env.MIGRATE_COURSE_ID || '').trim();
const TARGET_LESSON_ID = String(process.env.MIGRATE_LESSON_ID || '').trim();
const MAX_LESSONS = Math.max(Number(process.env.MIGRATE_MAX_LESSONS || 0), 0);

const cloudflareHostPattern = /cloudflarestream\.com|videodelivery\.net/i;

const collectLessons = (course) => (course.modules || []).flatMap((module) => ([
  ...(module.lessons || []).map((lesson) => ({
    ...lesson,
    moduleId: module.id || lesson.moduleId || 'module',
    moduleTitle: module.title || '',
    chapterId: null,
    chapterTitle: null,
  })),
  ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => ({
    ...lesson,
    moduleId: module.id || lesson.moduleId || 'module',
    moduleTitle: module.title || '',
    chapterId: chapter.id || lesson.chapterId || null,
    chapterTitle: chapter.title || '',
  })))),
]));

const isCloudflareStreamLesson = (lesson) => {
  const provider = String(lesson?.storageProvider || lesson?.streamProvider || lesson?.hlsStorageProvider || '').toLowerCase();
  return provider === 'cloudflare-stream'
    || Boolean(String(lesson?.cloudflareStreamUid || '').trim())
    || cloudflareHostPattern.test(String(lesson?.hlsPlaybackPath || ''))
    || cloudflareHostPattern.test(String(lesson?.hlsManifestPath || ''))
    || cloudflareHostPattern.test(String(lesson?.streamUrl || ''));
};

const main = async () => {
  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const allCourses = TARGET_COURSE_ID
    ? [await coursesRepository.findById(TARGET_COURSE_ID)].filter(Boolean)
    : await coursesRepository.list();

  const candidates = [];
  for (const course of allCourses) {
    const lessons = collectLessons(course)
      .filter((lesson) => lesson?.type === 'private-video')
      .filter((lesson) => isCloudflareStreamLesson(lesson))
      .filter((lesson) => !TARGET_LESSON_ID || String(lesson.id) === TARGET_LESSON_ID);

    for (const lesson of lessons) {
      candidates.push({
        courseId: String(course._id || ''),
        courseTitle: String(course.title || ''),
        lessonId: String(lesson.id || ''),
        lessonTitle: String(lesson.title || ''),
        moduleId: String(lesson.moduleId || ''),
        moduleTitle: String(lesson.moduleTitle || ''),
        chapterId: lesson.chapterId ? String(lesson.chapterId) : null,
        chapterTitle: lesson.chapterTitle ? String(lesson.chapterTitle) : null,
        cloudflareStreamUid: String(lesson.cloudflareStreamUid || lesson.streamUid || '').trim() || null,
        deliveryProfile: String(lesson.deliveryProfile || '').trim() || null,
        storageProvider: String(lesson.storageProvider || '').trim() || null,
        streamProvider: String(lesson.streamProvider || '').trim() || null,
        hlsStorageProvider: String(lesson.hlsStorageProvider || '').trim() || null,
        hlsPlaybackPath: String(lesson.hlsPlaybackPath || '').trim() || null,
        hlsManifestPath: String(lesson.hlsManifestPath || '').trim() || null,
        streamUrl: String(lesson.streamUrl || '').trim() || null,
        dashStreamUrl: String(lesson.dashStreamUrl || '').trim() || null,
      });
    }
  }

  const limitedCandidates = MAX_LESSONS > 0 ? candidates.slice(0, MAX_LESSONS) : candidates;
  console.log(JSON.stringify({
    count: limitedCandidates.length,
    firstCandidate: limitedCandidates[0] || null,
    candidates: limitedCandidates,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
