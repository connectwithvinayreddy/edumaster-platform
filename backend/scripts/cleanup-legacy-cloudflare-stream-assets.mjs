import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { connectDatabase } = require('../lib/database.js');
const { coursesRepository } = require('../lib/repositories.js');
const { deleteCloudflareStreamVideo, isCloudflareStreamConfigured } = require('../lib/cloudflare-stream.js');

const TARGET_COURSE_ID = String(process.env.MIGRATE_COURSE_ID || '').trim();
const TARGET_LESSON_ID = String(process.env.MIGRATE_LESSON_ID || '').trim();
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_DRY_RUN || '').toLowerCase());
const FORCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_FORCE_CLEANUP || '').toLowerCase());

const collectLessons = (course) => (course.modules || []).flatMap((module) => ([
  ...(module.lessons || []).map((lesson) => ({ ...lesson, moduleId: module.id || lesson.moduleId || 'module' })),
  ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => ({
    ...lesson,
    moduleId: module.id || lesson.moduleId || 'module',
    chapterId: chapter.id || lesson.chapterId || null,
  })))),
]));

const shouldCleanupLesson = (lesson) => {
  const legacy = lesson?.legacyCloudflareStream || null;
  const uid = String(legacy?.uid || '').trim();
  if (!uid) {
    return false;
  }
  if (legacy?.deletedAt) {
    return false;
  }
  if (FORCE) {
    return true;
  }
  const deleteAfter = Date.parse(legacy?.rollbackDeleteAfter || 0);
  return Number.isFinite(deleteAfter) && deleteAfter > 0 && deleteAfter <= Date.now();
};

const main = async () => {
  if (!isCloudflareStreamConfigured()) {
    throw new Error('Cloudflare Stream credentials are required to clean up legacy Stream assets.');
  }

  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const courses = TARGET_COURSE_ID
    ? [await coursesRepository.findById(TARGET_COURSE_ID)].filter(Boolean)
    : await coursesRepository.list();

  const results = [];
  for (const course of courses) {
    const lessons = collectLessons(course)
      .filter((lesson) => lesson?.type === 'private-video')
      .filter((lesson) => !TARGET_LESSON_ID || String(lesson.id) === TARGET_LESSON_ID)
      .filter(shouldCleanupLesson);

    for (const lesson of lessons) {
      const uid = String(lesson?.legacyCloudflareStream?.uid || '').trim();
      const deletedAt = new Date().toISOString();
      if (!DRY_RUN) {
        await deleteCloudflareStreamVideo(uid).catch((error) => {
          throw new Error(`Failed to delete Cloudflare Stream video ${uid}: ${error instanceof Error ? error.message : String(error)}`);
        });
        await coursesRepository.updateLesson(course._id, lesson.id, (current) => ({
          ...current,
          legacyCloudflareStream: {
            ...(current?.legacyCloudflareStream || lesson.legacyCloudflareStream || {}),
            deletedAt,
          },
        }));
      }

      results.push({
        courseId: course._id,
        lessonId: lesson.id,
        cloudflareStreamUid: uid,
        rollbackDeleteAfter: lesson?.legacyCloudflareStream?.rollbackDeleteAfter || null,
        deletedAt: DRY_RUN ? null : deletedAt,
        dryRun: DRY_RUN,
      });
    }
  }

  console.log(JSON.stringify({
    dryRun: DRY_RUN,
    force: FORCE,
    targetCourseId: TARGET_COURSE_ID || null,
    targetLessonId: TARGET_LESSON_ID || null,
    cleaned: results.length,
    results,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
