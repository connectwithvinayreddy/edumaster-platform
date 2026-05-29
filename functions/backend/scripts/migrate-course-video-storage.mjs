import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { connectDatabase } = require('../lib/database.js');
const { coursesRepository } = require('../lib/repositories.js');
const {
  uploadPrivateStorageFile,
  getPrivateVideoStorageProvider,
} = require('../lib/private-video-storage.js');
const {
  resolvePrivateVideoPath,
  resolvePrivateHlsPath,
} = require('../lib/private-video.js');
const {
  createManifestBundleFromStorage,
  storeManifestBundle,
} = require('../lib/manifest-bundle.js');

const TARGET_COURSE_ID = String(process.env.MIGRATE_COURSE_ID || '').trim();
const TARGET_LESSON_ID = String(process.env.MIGRATE_LESSON_ID || '').trim();
const INCLUDE_SOURCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_INCLUDE_SOURCE || 'true').toLowerCase());
const DELETE_LOCAL_AFTER_UPLOAD = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_DELETE_LOCAL || '').toLowerCase());
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes(String(process.env.MIGRATE_DRY_RUN || '').toLowerCase());

const collectLessons = (course) => (course.modules || []).flatMap((module) => ([
  ...(module.lessons || []).map((lesson) => ({ ...lesson, moduleId: module.id || lesson.moduleId || 'module' })),
  ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => ({
    ...lesson,
    moduleId: module.id || lesson.moduleId || 'module',
    chapterId: chapter.id || lesson.chapterId || null,
  })))),
]));

const walkFiles = (directoryPath, rootDirectory, files) => {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  entries.forEach((entry) => {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, rootDirectory, files);
      return;
    }

    const relativePath = path.relative(rootDirectory, fullPath).split(path.sep).join(path.posix.sep);
    files.push({
      fullPath,
      relativePath,
    });
  });
};

const detectContentType = (assetPath) => {
  const extension = path.extname(String(assetPath || '')).toLowerCase();
  if (extension === '.m3u8') {
    return 'application/vnd.apple.mpegurl';
  }
  if (extension === '.ts') {
    return 'video/mp2t';
  }
  if (extension === '.m4s') {
    return 'video/iso.segment';
  }
  if (extension === '.mp4') {
    return 'video/mp4';
  }
  if (extension === '.json') {
    return 'application/json';
  }
  return 'application/octet-stream';
};

const uploadDirectoryToS3 = async ({ localRootDirectory, storageRootPath }) => {
  const files = [];
  walkFiles(localRootDirectory, localRootDirectory, files);

  for (const file of files) {
    await uploadPrivateStorageFile({
      storageProvider: 's3',
      storagePath: path.posix.join(storageRootPath, file.relativePath),
      localFilePath: file.fullPath,
      contentType: detectContentType(file.relativePath),
      cacheControl: file.relativePath.endsWith('.m3u8')
        ? 'private, max-age=60, stale-while-revalidate=600'
        : 'private, max-age=31536000, immutable',
    });
  }
};

const migrateLesson = async (courseId, lesson) => {
  let changed = false;
  const patch = {};

  if (
    INCLUDE_SOURCE
    && lesson.storagePath
    && String(lesson.storageProvider || 'local') !== 's3'
  ) {
    const localSourcePath = resolvePrivateVideoPath(lesson.storagePath);
    if (!localSourcePath || !fs.existsSync(localSourcePath)) {
      console.warn(`[course-video-migrate] source missing for ${courseId}/${lesson.id}: ${lesson.storagePath}`);
    } else {
      console.log(`[course-video-migrate] uploading source ${courseId}/${lesson.id} -> ${lesson.storagePath}`);
      if (!DRY_RUN) {
        await uploadPrivateStorageFile({
          storageProvider: 's3',
          storagePath: lesson.storagePath,
          localFilePath: localSourcePath,
          contentType: lesson.mimeType || detectContentType(localSourcePath),
          cacheControl: 'private, max-age=0, no-store',
        });
      }
      patch.storageProvider = 's3';
      changed = true;

      if (DELETE_LOCAL_AFTER_UPLOAD && !DRY_RUN) {
        fs.unlinkSync(localSourcePath);
      }
    }
  }

  if (
    lesson.hlsManifestPath
    && String(lesson.hlsStorageProvider || 'local') !== 's3'
  ) {
    const localManifestPath = resolvePrivateHlsPath(lesson.hlsManifestPath);
    const localHlsDirectory = localManifestPath ? path.dirname(localManifestPath) : null;
    if (!localManifestPath || !localHlsDirectory || !fs.existsSync(localHlsDirectory)) {
      console.warn(`[course-video-migrate] hls directory missing for ${courseId}/${lesson.id}: ${lesson.hlsManifestPath}`);
    } else {
      const storageRootPath = path.posix.dirname(String(lesson.hlsManifestPath));
      console.log(`[course-video-migrate] uploading hls ${courseId}/${lesson.id} -> ${storageRootPath}`);
      if (!DRY_RUN) {
        await uploadDirectoryToS3({
          localRootDirectory: localHlsDirectory,
          storageRootPath,
        });
      }

      let bundle = null;
      if (!DRY_RUN) {
        bundle = await createManifestBundleFromStorage({
          storageProvider: 's3',
          manifestPath: lesson.hlsManifestPath,
          version: lesson.hlsManifestVersion || 'legacy',
        });
      }

      let bundleStoragePath = lesson.hlsManifestBundlePath || null;
      if (bundle && bundle.manifests?.['master.m3u8']) {
        bundleStoragePath = await storeManifestBundle({
          storageProvider: 's3',
          bundlePath: bundle.bundlePath,
          bundle,
        });
      }

      patch.hlsStorageProvider = 's3';
      if (bundleStoragePath) {
        patch.hlsManifestBundlePath = bundleStoragePath;
      }
      if (bundle?.bundlePath) {
        patch.hlsManifestRootPath = bundle.bundlePath;
      }
      if (bundle?.version) {
        patch.hlsManifestVersion = bundle.version;
      }
      changed = true;

      if (DELETE_LOCAL_AFTER_UPLOAD && !DRY_RUN) {
        fs.rmSync(localHlsDirectory, { recursive: true, force: true });
      }
    }
  }

  if (!changed) {
    return false;
  }

  if (DRY_RUN) {
    console.log(`[course-video-migrate] dry-run patch ${courseId}/${lesson.id}`, patch);
    return true;
  }

  await coursesRepository.updateLesson(courseId, lesson.id, (current) => ({
    ...current,
    ...patch,
  }));
  return true;
};

const main = async () => {
  if (getPrivateVideoStorageProvider() !== 's3') {
    throw new Error('PRIVATE_VIDEO_STORAGE_PROVIDER must resolve to s3 before running migration.');
  }

  const databaseState = await connectDatabase();
  if (!databaseState.connected) {
    throw new Error(`Database unavailable: ${databaseState.reason}`);
  }

  const courses = TARGET_COURSE_ID
    ? [await coursesRepository.findById(TARGET_COURSE_ID)].filter(Boolean)
    : await coursesRepository.list();

  let processed = 0;
  let migrated = 0;
  let skipped = 0;

  for (const course of courses) {
    const lessons = collectLessons(course).filter((lesson) => lesson?.type === 'private-video');
    for (const lesson of lessons) {
      if (TARGET_LESSON_ID && String(lesson.id) !== TARGET_LESSON_ID) {
        continue;
      }

      processed += 1;
      const changed = await migrateLesson(course._id, lesson);
      if (changed) {
        migrated += 1;
      } else {
        skipped += 1;
      }
    }
  }

  console.log(JSON.stringify({
    processed,
    migrated,
    skipped,
    dryRun: DRY_RUN,
    includeSource: INCLUDE_SOURCE,
    deleteLocalAfterUpload: DELETE_LOCAL_AFTER_UPLOAD,
    targetCourseId: TARGET_COURSE_ID || null,
    targetLessonId: TARGET_LESSON_ID || null,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
