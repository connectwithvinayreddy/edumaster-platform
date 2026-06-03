const fs = require('fs');
const path = require('path');
const { coursesRepository } = require('../lib/repositories.js');
const {
  ApiError,
  asyncHandler,
  created,
  ok,
  requireString,
  optionalString,
  optionalNumber,
} = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const { storePrivateVideoUpload } = require('../lib/private-video-storage.js');
const { buildSecurePlaybackClientContext } = require('../lib/secure-playback.js');

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

const removeTempFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

const uploadCourseEditorialVideo = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const title = requireString(req.body?.title, 'title', { maxLength: 160 });
  const description = optionalString(req.body?.description, '', { maxLength: 1000 });
  const weekLabel = optionalString(req.body?.weekLabel, '', { maxLength: 80 });
  const editorialDate = optionalString(req.body?.editorialDate, '', { maxLength: 40 });
  const durationMinutes = optionalNumber(req.body?.durationMinutes, 0, { min: 0, max: 5000 });

  if (!req.file) {
    throw new ApiError(400, 'Editorial video file is required', { code: 'EDITORIAL_VIDEO_REQUIRED' });
  }

  const extension = path.extname(req.file.originalname || '').toLowerCase();
  if (!validVideoTypes.includes(req.file.mimetype) && !validVideoExtensions.has(extension)) {
    removeTempFile(req.file.path);
    throw new ApiError(400, 'Invalid video format. Supported: MP4, WebM, OGG, MOV, MKV', { code: 'INVALID_VIDEO_FORMAT' });
  }

  if (req.file.size > maxSize) {
    removeTempFile(req.file.path);
    throw new ApiError(400, `Video file too large. Max ${appConfig.maxVideoUploadMb}MB allowed`, { code: 'VIDEO_TOO_LARGE' });
  }

  const editorialId = `editorial_${Date.now()}`;
  const storedVideo = await storePrivateVideoUpload({
    tempFilePath: req.file.path,
    courseId,
    moduleId: 'editorials',
    lessonId: editorialId,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
  });

  const editorial = await coursesRepository.addEditorialVideo(courseId, {
    id: editorialId,
    title,
    description,
    weekLabel: weekLabel || null,
    editorialDate: editorialDate || new Date().toISOString().slice(0, 10),
    durationMinutes,
    storagePath: storedVideo.storagePath,
    storageProvider: storedVideo.storageProvider,
    originalFilename: req.file.originalname || null,
    fileSize: req.file.size || 0,
    mimeType: req.file.mimetype || null,
    accessPolicy: storedVideo.accessPolicy,
    published: true,
    uploadedBy: req.user?.id || 'admin',
    uploadedAt: new Date().toISOString(),
  });

  return created(res, {
    message: 'Editorial video uploaded successfully',
    editorial,
  });
});

const deleteCourseEditorialVideo = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const editorialId = requireString(req.params.editorialId, 'editorial id');
  await coursesRepository.deleteEditorialVideo(courseId, editorialId);
  return ok(res, {
    message: 'Editorial video deleted successfully',
    editorialId,
  });
});

const getProtectedEditorialPlayer = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const editorialId = requireString(req.params.editorialId, 'editorial id');
  const player = await coursesRepository.getProtectedEditorialPlayback({
    userId: req.user?.id || null,
    courseId,
    editorialId,
    user: req.user?.profile || req.user || null,
    requestContext: buildSecurePlaybackClientContext(req),
  });
  return ok(res, player);
});

module.exports = {
  uploadCourseEditorialVideo,
  deleteCourseEditorialVideo,
  getProtectedEditorialPlayer,
};
