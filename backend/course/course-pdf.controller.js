const fs = require('fs');
const path = require('path');
const { coursesRepository, usersRepository } = require('../lib/repositories.js');
const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
} = require('../lib/http.js');

const normalizeScope = (value) => {
  const normalized = String(value || 'module').trim().toLowerCase();
  return ['module', 'chapter', 'lesson'].includes(normalized) ? normalized : 'module';
};

const ensureAttachmentArray = (entity) => {
  if (!Array.isArray(entity.attachments)) {
    entity.attachments = [];
  }
  return entity.attachments;
};

const sanitizeAttachment = (attachment) => ({
  id: attachment.id,
  title: attachment.title,
  fileName: attachment.fileName || null,
  mimeType: attachment.mimeType || 'application/pdf',
  fileSize: Number(attachment.fileSize || 0) || 0,
  premium: Boolean(attachment.premium),
  scope: attachment.scope || 'module',
  uploadedAt: attachment.uploadedAt || null,
  uploadedBy: attachment.uploadedBy || null,
});

const loadCourseOrThrow = async (courseId) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }
  return course;
};

const loadModuleOrThrow = (course, moduleId) => {
  const module = (course.modules || []).find((entry) => entry.id === String(moduleId));
  if (!module) {
    throw new ApiError(404, 'Module not found', { code: 'MODULE_NOT_FOUND' });
  }
  if (!Array.isArray(module.chapters)) {
    module.chapters = [];
  }
  if (!Array.isArray(module.lessons)) {
    module.lessons = [];
  }
  return module;
};

const loadChapterOrThrow = (module, chapterId) => {
  const chapter = (module.chapters || []).find((entry) => entry.id === String(chapterId));
  if (!chapter) {
    throw new ApiError(404, 'Chapter not found', { code: 'CHAPTER_NOT_FOUND' });
  }
  if (!Array.isArray(chapter.lessons)) {
    chapter.lessons = [];
  }
  return chapter;
};

const loadLessonOrThrow = (module, lessonId, chapterId = '') => {
  if (chapterId) {
    const chapter = loadChapterOrThrow(module, chapterId);
    const chapterLesson = (chapter.lessons || []).find((entry) => entry.id === String(lessonId));
    if (!chapterLesson) {
      throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
    }
    return chapterLesson;
  }

  const directLesson = (module.lessons || []).find((entry) => entry.id === String(lessonId));
  if (directLesson) {
    return directLesson;
  }

  for (const chapter of module.chapters || []) {
    const chapterLesson = (chapter.lessons || []).find((entry) => entry.id === String(lessonId));
    if (chapterLesson) {
      return chapterLesson;
    }
  }

  throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
};

const getAttachmentContainerOrThrow = ({ module, scope, chapterId, lessonId }) => {
  if (scope === 'chapter') {
    if (!chapterId) {
      throw new ApiError(400, 'chapterId is required for chapter attachments', { code: 'CHAPTER_ID_REQUIRED' });
    }
    return loadChapterOrThrow(module, chapterId);
  }

  if (scope === 'lesson') {
    if (!lessonId) {
      throw new ApiError(400, 'lessonId is required for lesson attachments', { code: 'LESSON_ID_REQUIRED' });
    }
    return loadLessonOrThrow(module, lessonId, chapterId);
  }

  return module;
};

const findAttachmentInCourse = (course, attachmentId) => {
  for (const module of course.modules || []) {
    for (const attachment of module.attachments || []) {
      if (attachment.id === String(attachmentId)) {
        return { attachment, scope: 'module', moduleId: module.id, chapterId: null, lessonId: null };
      }
    }

    for (const chapter of module.chapters || []) {
      for (const attachment of chapter.attachments || []) {
        if (attachment.id === String(attachmentId)) {
          return { attachment, scope: 'chapter', moduleId: module.id, chapterId: chapter.id, lessonId: null };
        }
      }

      for (const lesson of chapter.lessons || []) {
        for (const attachment of lesson.attachments || []) {
          if (attachment.id === String(attachmentId)) {
            return { attachment, scope: 'lesson', moduleId: module.id, chapterId: chapter.id, lessonId: lesson.id };
          }
        }
      }
    }

    for (const lesson of module.lessons || []) {
      for (const attachment of lesson.attachments || []) {
        if (attachment.id === String(attachmentId)) {
          return { attachment, scope: 'lesson', moduleId: module.id, chapterId: null, lessonId: lesson.id };
        }
      }
    }
  }

  return null;
};

const logPdfAccessEvent = (level, event, details = {}) => {
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  logger('[course-pdf]', JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...details,
  }));
};

const removeAttachmentFile = (storagePath) => {
  const normalizedStoragePath = String(storagePath || '').trim();
  if (!normalizedStoragePath) {
    return;
  }

  const filePath = path.isAbsolute(normalizedStoragePath)
    ? normalizedStoragePath
    : path.join(process.cwd(), normalizedStoragePath);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

const listCoursePdfAttachments = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const scope = normalizeScope(req.query?.scope);
  const chapterId = optionalString(req.query?.chapterId, '', { maxLength: 120 });
  const lessonId = optionalString(req.query?.lessonId, '', { maxLength: 120 });

  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const container = getAttachmentContainerOrThrow({ module, scope, chapterId, lessonId });
  const attachments = ensureAttachmentArray(container).map(sanitizeAttachment);

  return ok(res, { attachments });
});

const uploadCoursePdfAttachment = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const scope = normalizeScope(req.body?.scope);
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });
  const lessonId = optionalString(req.body?.lessonId, '', { maxLength: 120 });
  const title = requireString(req.body?.title, 'PDF title', { maxLength: 160 });
  const premium = String(req.body?.premium || '').trim().toLowerCase() === 'true';

  if (!req.file) {
    throw new ApiError(400, 'PDF file is required', { code: 'PDF_REQUIRED' });
  }

  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const container = getAttachmentContainerOrThrow({ module, scope, chapterId, lessonId });
  const attachments = ensureAttachmentArray(container);

  const attachment = {
    id: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    title,
    fileName: req.file.originalname || req.file.filename,
    mimeType: 'application/pdf',
    fileSize: Number(req.file.size || 0),
    premium,
    scope,
    storagePath: path.join('private_uploads', 'course-pdfs', req.file.filename),
    storageProvider: 'local',
    uploadedAt: new Date().toISOString(),
    uploadedBy: req.user?.id || 'admin',
  };

  attachments.push(attachment);
  course.updated_at = new Date().toISOString();
  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);

  return created(res, {
    message: 'PDF uploaded successfully',
    attachment: sanitizeAttachment(attachment),
    course: updatedCourse,
  });
});

const deleteCoursePdfAttachment = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const attachmentId = requireString(req.params.attachmentId, 'attachment id');
  const scope = normalizeScope(req.query?.scope);
  const chapterId = optionalString(req.query?.chapterId, '', { maxLength: 120 });
  const lessonId = optionalString(req.query?.lessonId, '', { maxLength: 120 });

  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const container = getAttachmentContainerOrThrow({ module, scope, chapterId, lessonId });
  const attachments = ensureAttachmentArray(container);
  const attachmentIndex = attachments.findIndex((entry) => entry.id === attachmentId);
  if (attachmentIndex === -1) {
    throw new ApiError(404, 'PDF attachment not found', { code: 'PDF_ATTACHMENT_NOT_FOUND' });
  }

  const [attachment] = attachments.splice(attachmentIndex, 1);
  removeAttachmentFile(attachment.storagePath);
  course.updated_at = new Date().toISOString();
  await coursesRepository.updateCourseModule(courseId, course);

  return ok(res, {
    message: 'PDF attachment deleted successfully',
    attachmentId,
  });
});

const viewCoursePdfAttachment = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'course id');
  const attachmentId = requireString(req.params.attachmentId, 'attachment id');
  const userId = req.user?.id || null;
  const user = userId ? await usersRepository.findSafeById(userId) : null;
  const requestId = String(req.requestId || req.headers['x-request-id'] || req.headers['cf-ray'] || '').trim() || null;
  if (!user) {
    logPdfAccessEvent('warn', 'pdf_auth_required', {
      requestId,
      courseId,
      attachmentId,
      userId,
      code: 'AUTH_REQUIRED',
      status: 401,
    });
    throw new ApiError(401, 'Authorization token required', { code: 'AUTH_REQUIRED' });
  }

  const rawCourse = await loadCourseOrThrow(courseId);
  const rawMatch = findAttachmentInCourse(rawCourse, attachmentId);
  if (!rawMatch) {
    logPdfAccessEvent('warn', 'pdf_attachment_not_found', {
      requestId,
      courseId,
      attachmentId,
      userId,
      role: user.role,
      code: 'PDF_ATTACHMENT_NOT_FOUND',
      status: 404,
      rawCourseFound: Boolean(rawCourse),
      rawAttachmentFound: false,
    });
    throw new ApiError(404, 'PDF attachment not found', { code: 'PDF_ATTACHMENT_NOT_FOUND' });
  }

  if (user.role !== 'admin') {
    const visibleCourse = await coursesRepository.findVisibleById(courseId, userId);
    const visibleMatch = visibleCourse ? findAttachmentInCourse(visibleCourse, attachmentId) : null;
    if (!visibleCourse || !visibleMatch || visibleMatch.attachment?.locked) {
      logPdfAccessEvent('warn', 'pdf_access_denied', {
        requestId,
        courseId,
        attachmentId,
        userId,
        role: user.role,
        code: 'PDF_ACCESS_DENIED',
        status: 403,
        rawAttachmentFound: true,
        rawAttachmentScope: rawMatch.scope,
        rawAttachmentPremium: Boolean(rawMatch.attachment?.premium),
        visibleCourseFound: Boolean(visibleCourse),
        visibleAttachmentFound: Boolean(visibleMatch),
        visibleAttachmentLocked: Boolean(visibleMatch?.attachment?.locked),
        enrolled: Boolean(visibleCourse?.enrolled),
        canAccessCourse: Boolean(visibleCourse?.canAccessCourse),
        accessReason: visibleMatch?.attachment?.accessBlockReason || visibleCourse?.accessReason || null,
      });
      throw new ApiError(403, visibleMatch?.attachment?.accessBlockReason || 'You do not have access to this PDF', { code: 'PDF_ACCESS_DENIED' });
    }
  }

  const storagePath = String(rawMatch.attachment.storagePath || '').trim();
  if (!storagePath) {
    logPdfAccessEvent('warn', 'pdf_storage_path_missing', {
      requestId,
      courseId,
      attachmentId,
      userId,
      role: user.role,
      code: 'PDF_STORAGE_PATH_MISSING',
      status: 404,
      rawAttachmentFound: true,
      rawAttachmentScope: rawMatch.scope,
    });
    throw new ApiError(404, 'Stored PDF file not found', { code: 'PDF_STORAGE_PATH_MISSING' });
  }

  const filePath = path.isAbsolute(storagePath)
    ? storagePath
    : path.join(process.cwd(), storagePath);
  if (!fs.existsSync(filePath)) {
    logPdfAccessEvent('warn', 'pdf_file_not_found', {
      requestId,
      courseId,
      attachmentId,
      userId,
      role: user.role,
      code: 'PDF_FILE_NOT_FOUND',
      status: 404,
      storagePath,
      resolvedFilePath: filePath,
    });
    throw new ApiError(404, 'Stored PDF file not found', { code: 'PDF_FILE_NOT_FOUND' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const rangeHeader = String(req.headers.range || '').trim();
  const safeFileName = path.basename(rawMatch.attachment.fileName || 'notes.pdf').replace(/"/g, '');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${safeFileName}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Robots-Tag', 'noindex, noarchive, nosnippet');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (!rangeHeader) {
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!rangeMatch) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    res.end();
    return;
  }

  let start = rangeMatch[1] ? Number.parseInt(rangeMatch[1], 10) : 0;
  let end = rangeMatch[2] ? Number.parseInt(rangeMatch[2], 10) : fileSize - 1;

  if (!rangeMatch[1] && rangeMatch[2]) {
    const suffixLength = Math.max(0, Number.parseInt(rangeMatch[2], 10));
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  }

  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || end < start
    || start >= fileSize
  ) {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    res.end();
    return;
  }

  end = Math.min(end, fileSize - 1);
  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', chunkSize);
  fs.createReadStream(filePath, { start, end }).pipe(res);
});

module.exports = {
  listCoursePdfAttachments,
  uploadCoursePdfAttachment,
  deleteCoursePdfAttachment,
  viewCoursePdfAttachment,
};
