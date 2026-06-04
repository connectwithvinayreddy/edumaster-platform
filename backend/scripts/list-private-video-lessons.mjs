import { createRequire } from 'node:module';
import { connectDatabase } from '../lib/database.js';

const require = createRequire(import.meta.url);
const { coursesRepository } = require('../lib/repositories.js');

const TARGET_COURSE_ID = String(process.env.VIDEO_AUDIT_COURSE_ID || process.env.MIGRATE_COURSE_ID || '').trim();
const TARGET_LESSON_ID = String(process.env.VIDEO_AUDIT_LESSON_ID || process.env.MIGRATE_LESSON_ID || '').trim();
const MAX_LESSONS = Math.max(Number(process.env.VIDEO_AUDIT_MAX_LESSONS || process.env.MIGRATE_MAX_LESSONS || 0), 0);

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

const normalize = (value) => String(value || '').trim();

const classifyProvider = (lesson) => {
  const providerHints = [
    lesson?.storageProvider,
    lesson?.streamProvider,
    lesson?.hlsStorageProvider,
    lesson?.deliveryProfile,
    lesson?.deliveryStrategy,
    lesson?.streamUrl,
    lesson?.hlsPlaybackPath,
    lesson?.hlsManifestPath,
  ]
    .map((value) => normalize(value).toLowerCase())
    .filter(Boolean);

  if (
    providerHints.some((value) => value.includes('cloudflare-stream'))
    || providerHints.some((value) => cloudflareHostPattern.test(value))
    || normalize(lesson?.cloudflareStreamUid)
  ) {
    return 'cloudflare-stream';
  }

  if (providerHints.some((value) => value.includes('r2-private-hls') || value.includes('private-hls'))) {
    return 'r2-private-hls';
  }

  if (providerHints.some((value) => value.includes('private-source') || value.includes('source_fallback'))) {
    return 'private-source';
  }

  return 'unknown';
};

const main = async () => {
  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const allCourses = TARGET_COURSE_ID
    ? [await coursesRepository.findById(TARGET_COURSE_ID)].filter(Boolean)
    : await coursesRepository.list();

  const lessons = [];
  for (const course of allCourses) {
    const privateLessons = collectLessons(course)
      .filter((lesson) => lesson?.type === 'private-video')
      .filter((lesson) => !TARGET_LESSON_ID || String(lesson.id) === TARGET_LESSON_ID);

    for (const lesson of privateLessons) {
      lessons.push({
        courseId: normalize(course._id),
        courseTitle: normalize(course.title),
        moduleId: normalize(lesson.moduleId),
        moduleTitle: normalize(lesson.moduleTitle),
        chapterId: normalize(lesson.chapterId) || null,
        chapterTitle: normalize(lesson.chapterTitle) || null,
        lessonId: normalize(lesson.id),
        lessonTitle: normalize(lesson.title),
        provider: classifyProvider(lesson),
        deliveryProfile: normalize(lesson.deliveryProfile) || null,
        deliveryStrategy: normalize(lesson.deliveryStrategy) || null,
        storageProvider: normalize(lesson.storageProvider) || null,
        streamProvider: normalize(lesson.streamProvider) || null,
        hlsStorageProvider: normalize(lesson.hlsStorageProvider) || null,
        hlsManifestPath: normalize(lesson.hlsManifestPath) || null,
        hlsPlaybackPath: normalize(lesson.hlsPlaybackPath) || null,
        hlsManifestRootPath: normalize(lesson.hlsManifestRootPath) || null,
        hlsManifestBundlePath: normalize(lesson.hlsManifestBundlePath) || null,
        sourceFileKey: normalize(lesson.sourceFileKey) || null,
        storagePath: normalize(lesson.storagePath) || normalize(lesson.sourceFileKey) || null,
        streamUrl: normalize(lesson.streamUrl) || null,
        dashStreamUrl: normalize(lesson.dashStreamUrl) || null,
        cloudflareStreamUid: normalize(lesson.cloudflareStreamUid) || null,
        hlsProcessingStatus: normalize(lesson.hlsProcessingStatus) || null,
        playbackReady: Boolean(lesson.playbackReady),
        sourceFallbackAllowed: lesson.sourceFallbackAllowed !== false,
      });
    }
  }

  const limitedLessons = MAX_LESSONS > 0 ? lessons.slice(0, MAX_LESSONS) : lessons;
  const providerCounts = limitedLessons.reduce((summary, lesson) => {
    const key = String(lesson.provider || 'unknown');
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});

  console.log(JSON.stringify({
    count: limitedLessons.length,
    providerCounts,
    firstLesson: limitedLessons[0] || null,
    lessons: limitedLessons,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
