// Video Upload Controller
const fs = require('fs');
const { randomUUID } = require('crypto');
const path = require('path');
const { coursesRepository } = require('../lib/repositories.js');
const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
  optionalNumber,
} = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const uploadConfig = require('../lib/multer-config.js');
const {
  storePrivateVideoUpload,
  deleteStoredPrivateVideo,
} = require('../lib/private-video-storage.js');
const { createInitialVideoDeliveryState, scheduleVideoProcessing, deleteProcessedHlsAssets } = require('../lib/video-processing.js');
const {
  isCloudflareStreamEnabled,
  isCloudflareStreamConfigured,
  createDirectUpload,
  createTusUpload,
  scheduleCloudflareStreamStatusPolling,
  syncCloudflareStreamVideoStatus,
  normalizeStreamState,
  updateLessonFromCloudflareState,
  verifyCloudflareStreamWebhookSignature,
  deleteCloudflareStreamVideo,
} = require('../lib/cloudflare-stream.js');

const validVideoTypes = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-matroska',
  'application/x-matroska',
];
const validVideoExtensions = new Set(['.mp4', '.webm', '.ogg', '.mov', '.mkv']);
const maxSize = appConfig.maxVideoUploadMb * 1024 * 1024;
const uploadRootDirectory = uploadConfig.uploadDir || path.join(__dirname, '../../uploads/videos');
const chunkUploadRoot = path.join(path.dirname(uploadRootDirectory), 'video-chunks');

if (!fs.existsSync(chunkUploadRoot)) {
  fs.mkdirSync(chunkUploadRoot, { recursive: true });
}

const deleteFileIfExists = (targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
};

const deleteDirectoryIfExists = (targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
};

const normalizeChunkUploadId = (value) => {
  const normalized = requireString(value, 'uploadId', { maxLength: 120 });
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new ApiError(400, 'uploadId contains invalid characters', { code: 'VALIDATION_ERROR' });
  }
  return normalized;
};

const assertVideoInputLooksValid = ({ sourcePath, originalName, mimeType, fileSize }) => {
  const extension = path.extname(originalName || '').toLowerCase();
  const effectiveMimeType = String(mimeType || '').trim();

  if (!validVideoTypes.includes(effectiveMimeType) && !validVideoExtensions.has(extension)) {
    deleteFileIfExists(sourcePath);
    throw new ApiError(400, 'Invalid video format. Supported: MP4, WebM, OGG, MOV, MKV', { code: 'INVALID_VIDEO_FORMAT' });
  }

  if (Number(fileSize || 0) > maxSize) {
    deleteFileIfExists(sourcePath);
    throw new ApiError(400, `Video file too large. Max ${appConfig.maxVideoUploadMb}MB allowed`, { code: 'VIDEO_TOO_LARGE' });
  }
};

const persistUploadedLessonVideo = async ({
  courseId,
  moduleId,
  lessonTitle,
  lessonType,
  durationMinutes,
  moduleName,
  moduleDescription,
  chapterId,
  chapterTitle,
  chapterDescription,
  originalFilename,
  mimeType,
  fileSize,
  sourcePath,
  uploadedBy,
  isPremium,
}) => {
  const lessonId = `video_${Date.now()}`;
  const storedVideo = await storePrivateVideoUpload({
    tempFilePath: sourcePath,
    courseId,
    moduleId,
    lessonId,
    originalName: originalFilename,
    mimeType,
  });
  const initialDeliveryState = createInitialVideoDeliveryState();

  const videoMetadata = {
    id: lessonId,
    title: lessonTitle,
    type: lessonType === 'video' ? 'private-video' : lessonType,
    moduleId,
    chapterId: chapterId || null,
    videoUrl: null,
    storagePath: storedVideo.storagePath,
    storageProvider: storedVideo.storageProvider,
    originalFilename: originalFilename || null,
    fileSize: fileSize || 0,
    mimeType: mimeType || null,
    uploadedAt: new Date().toISOString(),
    uploadedBy,
    durationMinutes,
    premium: Boolean(isPremium),
    watchLimit: Math.max(Number(appConfig.privateVideoNewUploadWatchLimit || 1), 1),
    watchCompletionPercent: Math.max(Number(appConfig.videoWatchCompletionThresholdPercent || 90), 50),
    releaseAt: new Date().toISOString(),
    securePlaybackRequired: true,
    accessPolicy: storedVideo.accessPolicy,
    ...initialDeliveryState,
  };

  const course = await coursesRepository.findById(courseId);
  if (!course) {
    await deleteStoredPrivateVideo({
      storageProvider: storedVideo.storageProvider,
      storagePath: storedVideo.storagePath,
    });
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  let targetModule = course.modules?.find((m) => m.id === moduleId);
  if (!targetModule) {
    if (!Array.isArray(course.modules)) {
      course.modules = [];
    }
    targetModule = {
      id: moduleId,
      title: moduleName,
      description: moduleDescription,
      lessons: [],
    };
    course.modules.push(targetModule);
  }

  let lessonContainer = targetModule;
  if (chapterId) {
    if (!Array.isArray(targetModule.chapters)) {
      targetModule.chapters = [];
    }

    let targetChapter = targetModule.chapters.find((chapter) => chapter.id === chapterId);
    if (!targetChapter) {
      targetChapter = {
        id: chapterId,
        title: chapterTitle,
        description: chapterDescription,
        lessons: [],
      };
      targetModule.chapters.push(targetChapter);
    }

    if (!Array.isArray(targetChapter.lessons)) {
      targetChapter.lessons = [];
    }

    lessonContainer = targetChapter;
  } else if (!Array.isArray(targetModule.lessons)) {
    targetModule.lessons = [];
  }

  lessonContainer.lessons.push(videoMetadata);
  course.updated_at = new Date().toISOString();
  await coursesRepository.updateCourseModule(courseId, course);
  scheduleVideoProcessing({ courseId, lessonId });

  return {
    message: 'Video uploaded successfully. Private adaptive HLS encoding has started and the topic will appear for students after processing completes.',
    processingProvider: 'local-hls',
    video: videoMetadata,
    course,
  };
};

const generateLessonVideoId = () => `video_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

const findOrCreateLessonContainer = ({
  course,
  moduleId,
  moduleName,
  moduleDescription,
  chapterId,
  chapterTitle,
  chapterDescription,
}) => {
  let targetModule = course.modules?.find((m) => m.id === moduleId);
  if (!targetModule) {
    if (!Array.isArray(course.modules)) {
      course.modules = [];
    }
    targetModule = {
      id: moduleId,
      title: moduleName,
      description: moduleDescription,
      lessons: [],
    };
    course.modules.push(targetModule);
  }

  let lessonContainer = targetModule;
  if (chapterId) {
    if (!Array.isArray(targetModule.chapters)) {
      targetModule.chapters = [];
    }

    let targetChapter = targetModule.chapters.find((chapter) => chapter.id === chapterId);
    if (!targetChapter) {
      targetChapter = {
        id: chapterId,
        title: chapterTitle,
        description: chapterDescription,
        lessons: [],
      };
      targetModule.chapters.push(targetChapter);
    }

    if (!Array.isArray(targetChapter.lessons)) {
      targetChapter.lessons = [];
    }

    lessonContainer = targetChapter;
  } else if (!Array.isArray(targetModule.lessons)) {
    targetModule.lessons = [];
  }

  return lessonContainer;
};

const persistCloudflareStreamLesson = async ({
  courseId,
  moduleId,
  lessonId,
  lessonTitle,
  lessonType,
  durationMinutes,
  moduleName,
  moduleDescription,
  chapterId,
  chapterTitle,
  chapterDescription,
  originalFilename,
  mimeType,
  fileSize,
  uploadedBy,
  isPremium,
  cloudflareUpload,
}) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  const now = new Date().toISOString();
  const videoMetadata = {
    id: lessonId,
    title: lessonTitle,
    type: lessonType === 'video' ? 'private-video' : lessonType,
    moduleId,
    chapterId: chapterId || null,
    videoUrl: null,
    storagePath: null,
    storageProvider: 'cloudflare-stream',
    streamProvider: 'cloudflare-stream',
    cloudflareStreamUid: cloudflareUpload.uid,
    cloudflareStreamUploadMethod: cloudflareUpload.method,
    cloudflareStreamUploadUrlExpiresAt: cloudflareUpload.expiresAt || null,
    cloudflareStreamMaxDurationSeconds: cloudflareUpload.maxDurationSeconds || null,
    cloudflareStreamStatus: 'upload-pending',
    cloudflareStreamPctComplete: 0,
    cloudflareStreamReadyToStream: false,
    cloudflareStreamLastCheckedAt: null,
    originalFilename: originalFilename || null,
    fileSize: fileSize || 0,
    mimeType: mimeType || null,
    uploadedAt: now,
    uploadedBy,
    durationMinutes,
    premium: Boolean(isPremium),
    watchLimit: Math.max(Number(appConfig.privateVideoNewUploadWatchLimit || 1), 1),
    watchCompletionPercent: Math.max(Number(appConfig.videoWatchCompletionThresholdPercent || 90), 50),
    releaseAt: null,
    playbackReady: false,
    securePlaybackRequired: true,
    accessPolicy: {
      type: 'cloudflare-stream',
      signedPlaybackRequired: Boolean(appConfig.cloudflareStreamSignedPlaybackRequired),
    },
    deliveryProfile: 'cloudflare-stream',
    deliveryStrategy: 'cloudflare-stream',
    sourceFallbackAllowed: false,
    targetQualities: ['adaptive'],
    hlsStorageProvider: 'cloudflare-stream',
    hlsProcessingStatus: 'queued',
    hlsProcessingQueuedAt: now,
    hlsProcessingStartedAt: null,
    hlsProcessingCompletedAt: null,
    hlsProcessingError: null,
    hlsManifestPath: null,
    hlsPlaybackPath: null,
    hlsManifestBundlePath: null,
    hlsManifestRootPath: null,
    hlsManifestVersion: null,
  };

  const lessonContainer = findOrCreateLessonContainer({
    course,
    moduleId,
    moduleName,
    moduleDescription,
    chapterId,
    chapterTitle,
    chapterDescription,
  });
  lessonContainer.lessons.push(videoMetadata);
  course.updated_at = now;
  await coursesRepository.updateCourseModule(courseId, course);
  scheduleCloudflareStreamStatusPolling({ uid: cloudflareUpload.uid });

  return {
    message: 'Video upload session created. Cloudflare Stream will encode the lesson before students can access it.',
    processingProvider: 'cloudflare-stream',
    video: videoMetadata,
    course,
  };
};

const concatenateFiles = async (inputPaths, outputPath) =>
  new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    let cursor = 0;

    writer.on('error', reject);
    writer.on('finish', resolve);

    const pipeNext = () => {
      if (cursor >= inputPaths.length) {
        writer.end();
        return;
      }

      const currentPath = inputPaths[cursor];
      const reader = fs.createReadStream(currentPath);
      reader.on('error', reject);
      reader.on('end', () => {
        cursor += 1;
        pipeNext();
      });
      reader.pipe(writer, { end: false });
    };

    pipeNext();
  });

const uploadVideoToModule = asyncHandler(async (req, res) => {
  const lessonTitle = requireString(req.body?.lessonTitle, 'lessonTitle', { maxLength: 160 });
  const lessonType = optionalString(req.body?.lessonType, 'private-video', { maxLength: 40 });
  const durationMinutes = optionalNumber(req.body?.durationMinutes, 0, { min: 0, max: 5000 });
  const moduleName = optionalString(req.body?.moduleName, 'Untitled Module', { maxLength: 160 });
  const moduleDescription = optionalString(req.body?.moduleDescription, '', { maxLength: 1500 });
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });
  const chapterTitle = optionalString(req.body?.chapterTitle, 'Untitled Chapter', { maxLength: 160 });
  const chapterDescription = optionalString(req.body?.chapterDescription, '', { maxLength: 1500 });
  const courseId = requireString(req.params.courseId, 'courseId');
  const moduleId = requireString(req.params.moduleId, 'moduleId');
  const originalFilename = optionalString(req.body?.originalFilename, '', { maxLength: 255 });
  const fileSize = optionalNumber(req.body?.fileSize, 0, { min: 0, max: maxSize });
  const mimeType = optionalString(req.body?.mimeType, '', { maxLength: 120 });

  if (!req.file) {
    throw new ApiError(400, 'No video file provided', { code: 'VIDEO_REQUIRED' });
  }

  assertVideoInputLooksValid({
    sourcePath: req.file.path,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    fileSize: req.file.size,
  });

  const payload = await persistUploadedLessonVideo({
    courseId,
    moduleId,
    lessonTitle,
    lessonType,
    durationMinutes,
    moduleName,
    moduleDescription,
    chapterId,
    chapterTitle,
    chapterDescription,
    originalFilename: req.file.originalname || originalFilename || null,
    mimeType: req.file.mimetype || mimeType || null,
    fileSize: req.file.size || fileSize || 0,
    sourcePath: req.file.path,
    uploadedBy: req.user?.id || 'admin',
    isPremium: req.body?.isPremium === 'true' || req.body?.isPremium === true,
  });

  return created(res, payload);
});

const initiateCloudflareStreamUpload = asyncHandler(async (req, res) => {
  if (!isCloudflareStreamEnabled() || !isCloudflareStreamConfigured()) {
    throw new ApiError(503, 'Cloudflare Stream upload pipeline is not configured on this environment.', {
      code: 'CLOUDFLARE_STREAM_NOT_CONFIGURED',
    });
  }

  const lessonTitle = requireString(req.body?.lessonTitle, 'lessonTitle', { maxLength: 160 });
  const lessonType = optionalString(req.body?.lessonType, 'private-video', { maxLength: 40 });
  const durationMinutes = optionalNumber(req.body?.durationMinutes, 0, { min: 0, max: 5000 });
  const moduleName = optionalString(req.body?.moduleName, 'Untitled Module', { maxLength: 160 });
  const moduleDescription = optionalString(req.body?.moduleDescription, '', { maxLength: 1500 });
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });
  const chapterTitle = optionalString(req.body?.chapterTitle, 'Untitled Chapter', { maxLength: 160 });
  const chapterDescription = optionalString(req.body?.chapterDescription, '', { maxLength: 1500 });
  const courseId = requireString(req.params.courseId, 'courseId');
  const moduleId = requireString(req.params.moduleId, 'moduleId');
  const originalFilename = requireString(req.body?.originalFilename, 'originalFilename', { maxLength: 255 });
  const fileSize = optionalNumber(req.body?.fileSize, 0, { min: 1, max: maxSize });
  const mimeType = optionalString(req.body?.mimeType, 'video/mp4', { maxLength: 120 });
  const lessonId = generateLessonVideoId();

  assertVideoInputLooksValid({
    sourcePath: null,
    originalName: originalFilename,
    mimeType,
    fileSize,
  });

  const metadata = {
    name: lessonTitle,
    courseId,
    moduleId,
    lessonId,
    chapterId: chapterId || '',
    environment: appConfig.environmentLabel || appConfig.nodeEnv,
  };
  const creator = req.user?.id || 'admin';
  const cloudflareUpload = await createTusUpload({
    fileSize,
    lessonTitle,
    durationMinutes,
    mimeType,
    creator,
    metadata,
  });

  let payload;
  try {
    payload = await persistCloudflareStreamLesson({
      courseId,
      moduleId,
      lessonId,
      lessonTitle,
      lessonType,
      durationMinutes,
      moduleName,
      moduleDescription,
      chapterId,
      chapterTitle,
      chapterDescription,
      originalFilename,
      mimeType,
      fileSize,
      uploadedBy: creator,
      isPremium: req.body?.isPremium === 'true' || req.body?.isPremium === true,
      cloudflareUpload,
    });
  } catch (error) {
    await deleteCloudflareStreamVideo(cloudflareUpload.uid).catch(() => undefined);
    throw error;
  }

  return created(res, {
    ...payload,
    upload: cloudflareUpload,
  });
});

const completeCloudflareStreamUpload = asyncHandler(async (req, res) => {
  const uid = requireString(req.body?.uid || req.params.uid, 'uid', { maxLength: 80 });
  const state = await syncCloudflareStreamVideoStatus({ uid, source: 'upload-complete' }).catch((error) => {
    scheduleCloudflareStreamStatusPolling({ uid, attempt: 0, delayMs: 5_000 });
    console.warn('[cloudflare-stream] initial status sync after upload failed', {
      uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  if (!state || (!state.fullyReady && !state.hasError)) {
    scheduleCloudflareStreamStatusPolling({ uid, attempt: 0, delayMs: 5_000 });
  }

  return ok(res, {
    message: state?.fullyReady
      ? 'Cloudflare Stream video is ready for playback.'
      : 'Cloudflare Stream upload received. Encoding status tracking is active.',
    processingProvider: 'cloudflare-stream',
    uid,
    status: state?.state || 'processing',
    pctComplete: state?.pctComplete ?? null,
    readyToStream: Boolean(state?.readyToStream),
  });
});

const handleCloudflareStreamWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const signature = req.get('Webhook-Signature') || '';
  if (!verifyCloudflareStreamWebhookSignature(rawBody, signature)) {
    throw new ApiError(401, 'Invalid Cloudflare Stream webhook signature', {
      code: 'CLOUDFLARE_STREAM_WEBHOOK_SIGNATURE_INVALID',
    });
  }

  const payload = req.body && Object.keys(req.body).length > 0
    ? req.body
    : JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '{}'));
  const uid = requireString(payload?.uid, 'uid', { maxLength: 80 });
  const state = normalizeStreamState(payload);
  await updateLessonFromCloudflareState({ uid, state, source: 'webhook' });

  if (!state.fullyReady && !state.hasError) {
    scheduleCloudflareStreamStatusPolling({ uid });
  }

  return ok(res, { received: true });
});

const uploadVideoChunkToModule = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'No video chunk provided', { code: 'VIDEO_CHUNK_REQUIRED' });
  }

  const lessonTitle = requireString(req.body?.lessonTitle, 'lessonTitle', { maxLength: 160 });
  const lessonType = optionalString(req.body?.lessonType, 'private-video', { maxLength: 40 });
  const durationMinutes = optionalNumber(req.body?.durationMinutes, 0, { min: 0, max: 5000 });
  const moduleName = optionalString(req.body?.moduleName, 'Untitled Module', { maxLength: 160 });
  const moduleDescription = optionalString(req.body?.moduleDescription, '', { maxLength: 1500 });
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });
  const chapterTitle = optionalString(req.body?.chapterTitle, 'Untitled Chapter', { maxLength: 160 });
  const chapterDescription = optionalString(req.body?.chapterDescription, '', { maxLength: 1500 });
  const courseId = requireString(req.params.courseId, 'courseId');
  const moduleId = requireString(req.params.moduleId, 'moduleId');
  const uploadId = normalizeChunkUploadId(req.body?.uploadId);
  const chunkIndex = optionalNumber(req.body?.chunkIndex, -1, { min: 0, max: 200000, integer: true });
  const totalChunks = optionalNumber(req.body?.totalChunks, 0, { min: 1, max: 200000, integer: true });
  const originalFilename = optionalString(req.body?.originalFilename, req.file.originalname || 'video.mp4', { maxLength: 255 });
  const mimeType = optionalString(req.body?.mimeType, req.file.mimetype || 'video/mp4', { maxLength: 120 });
  const expectedFileSize = optionalNumber(req.body?.fileSize, 0, { min: 0, max: maxSize });

  assertVideoInputLooksValid({
    sourcePath: req.file.path,
    originalName: originalFilename,
    mimeType,
    fileSize: expectedFileSize || req.file.size,
  });

  const sessionDirectory = path.join(chunkUploadRoot, uploadId);
  if (!fs.existsSync(sessionDirectory)) {
    fs.mkdirSync(sessionDirectory, { recursive: true });
  }

  const chunkFileName = `${String(chunkIndex).padStart(6, '0')}.part`;
  const finalChunkPath = path.join(sessionDirectory, chunkFileName);
  if (fs.existsSync(finalChunkPath)) {
    fs.unlinkSync(finalChunkPath);
  }
  fs.renameSync(req.file.path, finalChunkPath);

  if (chunkIndex < totalChunks - 1) {
    return ok(res, {
      message: 'Chunk received',
      uploadId,
      chunkIndex,
      totalChunks,
      complete: false,
      uploadedBytesEstimate: Math.min((chunkIndex + 1) * req.file.size, expectedFileSize || (chunkIndex + 1) * req.file.size),
    });
  }

  const chunkPaths = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunkPath = path.join(sessionDirectory, `${String(index).padStart(6, '0')}.part`);
    if (!fs.existsSync(chunkPath)) {
      throw new ApiError(400, `Upload is missing chunk ${index + 1} of ${totalChunks}`, { code: 'VIDEO_CHUNK_MISSING' });
    }
    chunkPaths.push(chunkPath);
  }

  const assembledPath = path.join(uploadRootDirectory, `${uploadId}${path.extname(originalFilename || '').toLowerCase() || '.mp4'}`);

  try {
    await concatenateFiles(chunkPaths, assembledPath);
    const assembledSize = fs.statSync(assembledPath).size;

    const payload = await persistUploadedLessonVideo({
      courseId,
      moduleId,
      lessonTitle,
      lessonType,
      durationMinutes,
      moduleName,
      moduleDescription,
      chapterId,
      chapterTitle,
      chapterDescription,
      originalFilename,
      mimeType,
      fileSize: expectedFileSize || assembledSize,
      sourcePath: assembledPath,
      uploadedBy: req.user?.id || 'admin',
      isPremium: req.body?.isPremium === 'true' || req.body?.isPremium === true,
    });

    return created(res, {
      ...payload,
      uploadId,
      totalChunks,
      complete: true,
    });
  } finally {
    deleteFileIfExists(assembledPath);
    deleteDirectoryIfExists(sessionDirectory);
  }
});

const findVideoInModule = (targetModule, videoId) => {
  const directIndex = (targetModule.lessons || []).findIndex((lesson) => lesson.id === videoId);
  if (directIndex >= 0) {
    return {
      video: targetModule.lessons[directIndex],
      lessons: targetModule.lessons,
      index: directIndex,
      chapter: null,
    };
  }

  for (const chapter of targetModule.chapters || []) {
    const chapterIndex = (chapter.lessons || []).findIndex((lesson) => lesson.id === videoId);
    if (chapterIndex >= 0) {
      return {
        video: chapter.lessons[chapterIndex],
        lessons: chapter.lessons,
        index: chapterIndex,
        chapter,
      };
    }
  }

  return null;
};

const shouldRefreshCloudflareStreamVideo = (video) => {
  if (!video || video.playbackReady) {
    return false;
  }

  const uid = video.cloudflareStreamUid || video.streamUid;
  if (!uid) {
    return false;
  }

  const storageProvider = String(video.storageProvider || video.streamProvider || '').toLowerCase();
  const streamStatus = String(video.cloudflareStreamStatus || '').toLowerCase();
  const processingStatus = String(video.hlsProcessingStatus || '').toLowerCase();
  return storageProvider === 'cloudflare-stream'
    && streamStatus !== 'failed'
    && processingStatus !== 'failed';
};

const refreshPendingCloudflareStreamVideos = async (videos = []) => {
  const pendingVideos = (videos || []).filter(shouldRefreshCloudflareStreamVideo).slice(0, 8);
  if (pendingVideos.length === 0) {
    return false;
  }

  await Promise.allSettled(pendingVideos.map((video) =>
    syncCloudflareStreamVideoStatus({
      uid: video.cloudflareStreamUid || video.streamUid,
      source: 'admin-list',
    })));

  return true;
};

const getModuleVideoSelection = (course, moduleId, chapterId = '') => {
  const targetModule = course.modules?.find((m) => m.id === moduleId);
  if (!targetModule) {
    throw new ApiError(404, 'Module not found', { code: 'MODULE_NOT_FOUND' });
  }

  if (chapterId) {
    const targetChapter = (targetModule.chapters || []).find((chapter) => chapter.id === chapterId);
    if (!targetChapter) {
      throw new ApiError(404, 'Chapter not found', { code: 'CHAPTER_NOT_FOUND' });
    }

    return {
      module: targetModule,
      chapter: targetChapter,
      videos: targetChapter.lessons || [],
    };
  }

  return {
    module: targetModule,
    chapter: null,
    videos: targetModule.lessons || [],
  };
};

const deleteVideoFromModule = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'courseId');
  const moduleId = requireString(req.params.moduleId, 'moduleId');
  const videoId = requireString(req.params.videoId, 'videoId');

  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  const targetModule = course.modules?.find((m) => m.id === moduleId);
  if (!targetModule) {
    throw new ApiError(404, 'Module not found', { code: 'MODULE_NOT_FOUND' });
  }

  const videoLocation = findVideoInModule(targetModule, videoId);
  if (!videoLocation) {
    throw new ApiError(404, 'Video not found', { code: 'VIDEO_NOT_FOUND' });
  }

  const video = videoLocation.video;
  if (String(video.storageProvider || '').toLowerCase() === 'cloudflare-stream' || video.cloudflareStreamUid) {
    await deleteCloudflareStreamVideo(video.cloudflareStreamUid || video.streamUid).catch((error) => {
      console.warn('[cloudflare-stream] failed to delete Stream video', {
        uid: video.cloudflareStreamUid || video.streamUid || null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    await deleteStoredPrivateVideo({
      storageProvider: video.storageProvider,
      storagePath: video.storagePath,
    });
    await deleteProcessedHlsAssets(video.hlsManifestPath, video.hlsStorageProvider || null);
  }

  videoLocation.lessons.splice(videoLocation.index, 1);
  await coursesRepository.updateCourseModule(courseId, course);
  return ok(res, { message: 'Video deleted successfully' });
});

const listVideosInModule = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'courseId');
  const moduleId = requireString(req.params.moduleId, 'moduleId');
  const chapterId = optionalString(req.query?.chapterId, '', { maxLength: 120 });

  let course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  let selection = getModuleVideoSelection(course, moduleId, chapterId);
  const refreshed = await refreshPendingCloudflareStreamVideos(selection.videos);
  if (refreshed) {
    course = await coursesRepository.findById(courseId) || course;
    selection = getModuleVideoSelection(course, moduleId, chapterId);
  }

  if (chapterId) {
    return ok(res, {
      module: selection.module,
      chapter: selection.chapter,
      videos: selection.videos,
    });
  }

  return ok(res, {
    module: selection.module,
    videos: selection.videos,
  });
});

const getVideoMetadata = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'courseId');
  const moduleId = requireString(req.params.moduleId, 'moduleId');
  const videoId = requireString(req.params.videoId, 'videoId');

  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  const targetModule = course.modules?.find((m) => m.id === moduleId);
  if (!targetModule) {
    throw new ApiError(404, 'Module not found', { code: 'MODULE_NOT_FOUND' });
  }

  const videoLocation = findVideoInModule(targetModule, videoId);
  if (!videoLocation) {
    throw new ApiError(404, 'Video not found', { code: 'VIDEO_NOT_FOUND' });
  }

  return ok(res, {
    ...videoLocation.video,
    chapterId: videoLocation.chapter?.id || videoLocation.video.chapterId || null,
  });
});

module.exports = {
  uploadVideoToModule,
  uploadVideoChunkToModule,
  initiateCloudflareStreamUpload,
  completeCloudflareStreamUpload,
  handleCloudflareStreamWebhook,
  deleteVideoFromModule,
  listVideosInModule,
  getVideoMetadata,
};
