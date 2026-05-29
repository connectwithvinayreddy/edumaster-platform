import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { connectDatabase } = require('../lib/database.js');
const { coursesRepository } = require('../lib/repositories.js');
const {
  createManifestBundleFromStorage,
  storeManifestBundle,
} = require('../lib/manifest-bundle.js');

const FORCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.HLS_MANIFEST_BUNDLE_FORCE || '').toLowerCase());
const TARGET_COURSE_ID = String(process.env.HLS_MANIFEST_BUNDLE_COURSE_ID || '').trim();
const TARGET_LESSON_ID = String(process.env.HLS_MANIFEST_BUNDLE_LESSON_ID || '').trim();

const collectLessons = (course) => (course.modules || []).flatMap((module) => ([
  ...(module.lessons || []).map((lesson) => ({ ...lesson, moduleId: module.id || lesson.moduleId || 'module' })),
  ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => ({
    ...lesson,
    moduleId: module.id || lesson.moduleId || 'module',
    chapterId: chapter.id || lesson.chapterId || null,
  })))),
]));

const main = async () => {
  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const courses = TARGET_COURSE_ID
    ? [await coursesRepository.findById(TARGET_COURSE_ID)].filter(Boolean)
    : await coursesRepository.list();

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  for (const course of courses) {
    const lessons = collectLessons(course)
      .filter((lesson) => lesson?.deliveryStrategy === 'hls' && lesson?.hlsProcessingStatus === 'ready' && lesson?.hlsManifestPath);

    for (const lesson of lessons) {
      if (TARGET_LESSON_ID && String(lesson.id) !== TARGET_LESSON_ID) {
        continue;
      }

      processed += 1;
      const hasBundle = lesson.hlsManifestBundlePath && lesson.hlsManifestRootPath && lesson.hlsManifestVersion;
      if (hasBundle && !FORCE) {
        skipped += 1;
        continue;
      }

      const manifestVersion = hasBundle && lesson.hlsManifestVersion && !FORCE
        ? String(lesson.hlsManifestVersion)
        : 'legacy';
      const storageProvider = lesson.hlsStorageProvider || lesson.storageProvider || 'local';
      const bundle = await createManifestBundleFromStorage({
        storageProvider,
        manifestPath: lesson.hlsManifestPath,
        version: manifestVersion,
      });

      if (!bundle || !bundle.manifests || !bundle.manifests['master.m3u8']) {
        console.warn(`[manifest-backfill] skipped ${course._id}/${lesson.id}: master manifest unavailable`);
        skipped += 1;
        continue;
      }

      const bundleStoragePath = await storeManifestBundle({
        storageProvider,
        bundlePath: bundle.bundlePath,
        bundle,
      });

      await coursesRepository.updateLesson(course._id, lesson.id, (current) => ({
        ...current,
        hlsManifestBundlePath: bundleStoragePath,
        hlsManifestRootPath: bundle.bundlePath,
        hlsManifestVersion: bundle.version,
      }));
      updated += 1;
      console.log(`[manifest-backfill] updated ${course._id}/${lesson.id} -> ${bundleStoragePath}`);
    }
  }

  console.log(JSON.stringify({
    processed,
    updated,
    skipped,
    force: FORCE,
    targetCourseId: TARGET_COURSE_ID || null,
    targetLessonId: TARGET_LESSON_ID || null,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
