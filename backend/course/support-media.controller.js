const path = require('path');
const {
  ApiError,
  asyncHandler,
  created,
  requireString,
} = require('../lib/http.js');
const { coursesRepository, platformRepository } = require('../lib/repositories.js');

const buildLessonContext = async (courseId, lessonId) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  for (const module of course.modules || []) {
    for (const lesson of module.lessons || []) {
      if (String(lesson.id) === String(lessonId)) {
        return lesson;
      }
    }
    for (const chapter of module.chapters || []) {
      for (const lesson of chapter.lessons || []) {
        if (String(lesson.id) === String(lessonId)) {
          return lesson;
        }
      }
    }
  }

  throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
};

const assertLessonSupportAccess = async ({ courseId, lessonId, userId, role }) => {
  if (role === 'admin') {
    return;
  }

  const overview = await platformRepository.getOverview(String(userId));
  const course = (overview.courses || []).find((entry) => String(entry._id) === String(courseId));
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }
  if (!course.canAccessCourse || !course.canPlayReleasedVideos) {
    throw new ApiError(403, course.accessBlockReason || 'Course access required for support uploads.', {
      code: 'LESSON_SUPPORT_UPLOAD_ACCESS_DENIED',
      details: {
        courseId: String(courseId),
        lessonId: String(lessonId),
        accessStatus: course.accessStatus || 'not_purchased',
      },
    });
  }
};

const inferAttachmentKind = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('image/')) {
    return 'image';
  }
  if (normalized.startsWith('video/')) {
    return 'video';
  }
  if (normalized.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
};

const uploadLessonSupportMedia = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'courseId');
  const lessonId = requireString(req.params.lessonId, 'lessonId');
  await buildLessonContext(courseId, lessonId);
  await assertLessonSupportAccess({
    courseId,
    lessonId,
    userId: req.user?.id,
    role: req.user?.role,
  });

  if (!req.file) {
    throw new ApiError(400, 'Support media file is required', { code: 'SUPPORT_MEDIA_FILE_REQUIRED' });
  }

  const relativeUrl = `/uploads/support-media/${path.basename(req.file.filename)}`;
  const attachment = {
    id: `support_media_${Date.now()}_${Math.round(Math.random() * 1e9)}`,
    kind: inferAttachmentKind(req.file.mimetype),
    url: relativeUrl,
    fileName: req.file.originalname || path.basename(req.file.filename),
    mimeType: req.file.mimetype || 'application/octet-stream',
    fileSize: Number(req.file.size || 0),
    uploadedAt: new Date().toISOString(),
    uploadedByRole: req.user?.role || 'student',
  };

  return created(res, {
    message: 'Support media uploaded successfully',
    attachment,
  });
});

module.exports = {
  uploadLessonSupportMedia,
};
