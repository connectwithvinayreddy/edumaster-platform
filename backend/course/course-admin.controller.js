// Course Admin Controller - Edit, Delete, Update functionality
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

const getFlattenedLessons = (course) =>
  (course.modules || []).flatMap((module) => [
    ...((Array.isArray(module.lessons) ? module.lessons : [])),
    ...((Array.isArray(module.chapters) ? module.chapters : []).flatMap((chapter) =>
      (Array.isArray(chapter.lessons) ? chapter.lessons : []))),
  ]);
const isLocalUploadPath = (value) => typeof value === 'string' && value.startsWith('/uploads/videos/');
const { deleteStoredPrivateVideo } = require('../lib/private-video-storage.js');
const { deleteProcessedHlsAssets } = require('../lib/video-processing.js');

const cleanupLessons = async (lessons = []) => {
  const fs = require('fs');
  const path = require('path');

  await Promise.all((Array.isArray(lessons) ? lessons : []).map(async (lesson) => {
    if (isLocalUploadPath(lesson.videoUrl)) {
      try {
        const videoPath = path.join(__dirname, '../../', lesson.videoUrl);
        if (fs.existsSync(videoPath)) {
          fs.unlinkSync(videoPath);
        }
      } catch (err) {
        console.error(`Failed to delete video file: ${lesson.videoUrl}`, err);
      }
    }

    if (lesson.storagePath) {
      try {
        await deleteStoredPrivateVideo({
          storageProvider: lesson.storageProvider,
          storagePath: lesson.storagePath,
        });
      } catch (err) {
        console.error(`Failed to delete private video file: ${lesson.storagePath}`, err);
      }
    }

    if (lesson.hlsManifestPath) {
      try {
        await deleteProcessedHlsAssets(lesson.hlsManifestPath, lesson.hlsStorageProvider || null);
      } catch (err) {
        console.error(`Failed to delete processed HLS assets: ${lesson.hlsManifestPath}`, err);
      }
    }
  }));
};

const loadCourseOrThrow = async (courseId) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  return course;
};

const loadModuleOrThrow = (course, moduleId) => {
  const module = course.modules?.find((entry) => entry.id === moduleId);
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

const findLessonContainerOrThrow = (module, lessonId, chapterId = '') => {
  if (chapterId) {
    const chapter = module.chapters.find((entry) => entry.id === chapterId);
    if (!chapter) {
      throw new ApiError(404, 'Chapter not found', { code: 'CHAPTER_NOT_FOUND' });
    }
    if (!Array.isArray(chapter.lessons)) {
      chapter.lessons = [];
    }
    return chapter.lessons;
  }

  const directLessonIndex = module.lessons.findIndex((lesson) => lesson.id === lessonId);
  if (directLessonIndex >= 0) {
    return module.lessons;
  }

  for (const chapter of module.chapters) {
    const chapterLessonIndex = (chapter.lessons || []).findIndex((lesson) => lesson.id === lessonId);
    if (chapterLessonIndex >= 0) {
      return chapter.lessons;
    }
  }

  throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
};

const attachLessonCbt = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const lessonId = requireString(req.params.lessonId, 'lesson id');
  const title = requireString(req.body?.title, 'CBT title', { maxLength: 160 });
  const durationMinutes = optionalNumber(req.body?.durationMinutes, 30, { min: 1, max: 5000, integer: true });
  const negativeMarking = optionalNumber(req.body?.negativeMarking, 0, { min: 0, max: 10 });
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });
  const questions = Array.isArray(req.body?.questions) ? req.body.questions : [];

  if (questions.length === 0) {
    throw new ApiError(400, 'CBT questions are required', { code: 'CBT_QUESTIONS_REQUIRED' });
  }

  const normalizedQuestions = questions.map((question, index) => {
    const questionText = requireString(question?.questionText, `question ${index + 1}`, { maxLength: 3000 });
    const options = Array.isArray(question?.options)
      ? question.options.map((option) => String(option || '').trim()).filter(Boolean)
      : [];
    if (options.length < 2) {
      throw new ApiError(400, `Question ${index + 1} needs at least two options`, { code: 'CBT_OPTIONS_REQUIRED' });
    }

    const correctOptions = Array.isArray(question?.correctOptions) && question.correctOptions.length > 0
      ? [...new Set(question.correctOptions.map((option) => Number(option)).filter((option) => Number.isInteger(option) && option >= 0))].sort((left, right) => left - right)
      : Number.isFinite(Number(question?.correctOption))
        ? [Number(question.correctOption)]
        : [0];

    if (correctOptions.length === 0 || correctOptions.some((optionIndex) => optionIndex >= options.length)) {
      throw new ApiError(400, `Question ${index + 1} needs one or more valid correct options`, { code: 'CBT_CORRECT_OPTIONS_REQUIRED' });
    }

    return {
      id: String(question?.id || `cbt_${Date.now()}_${index + 1}`),
      questionText,
      options,
      correctOption: correctOptions[0],
      correctOptions,
      explanation: optionalString(question?.explanation, '', { maxLength: 3000 }),
      marks: Number(question?.marks || 1),
      topic: optionalString(question?.topic, title, { maxLength: 160 }),
    };
  });

  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const lessons = findLessonContainerOrThrow(module, lessonId, chapterId);
  const lesson = lessons.find((entry) => entry.id === lessonId);
  if (!lesson) {
    throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
  }

  lesson.cbt = {
    title,
    durationMinutes,
    negativeMarking,
    questions: normalizedQuestions,
    updatedAt: new Date().toISOString(),
    updatedBy: req.user?.id || 'admin',
  };
  course.updated_at = new Date().toISOString();
  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);

  return ok(res, {
    message: 'Lesson CBT attached successfully',
    lesson,
    course: updatedCourse,
  });
});

const deleteLessonCbt = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const lessonId = requireString(req.params.lessonId, 'lesson id');
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });

  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const lessons = findLessonContainerOrThrow(module, lessonId, chapterId);
  const lesson = lessons.find((entry) => entry.id === lessonId);
  if (!lesson) {
    throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
  }

  lesson.cbt = null;
  course.updated_at = new Date().toISOString();
  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);

  return ok(res, {
    message: 'Lesson CBT deleted successfully',
    lesson,
    course: updatedCourse,
  });
});

const updateLessonSettings = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const lessonId = requireString(req.params.lessonId, 'lesson id');
  const chapterId = optionalString(req.body?.chapterId, '', { maxLength: 120 });

  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const lessons = findLessonContainerOrThrow(module, lessonId, chapterId);
  const lesson = lessons.find((entry) => entry.id === lessonId);
  if (!lesson) {
    throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
  }

  if (req.body.watchLimit !== undefined) {
    lesson.watchLimit = optionalNumber(req.body.watchLimit, lesson.watchLimit || 2, {
      min: 1,
      max: 20,
      integer: true,
    });
  }

  if (req.body.watchCompletionPercent !== undefined) {
    lesson.watchCompletionPercent = optionalNumber(
      req.body.watchCompletionPercent,
      lesson.watchCompletionPercent || 90,
      {
        min: 50,
        max: 100,
        integer: true,
      },
    );
  }

  lesson.updatedAt = new Date().toISOString();
  lesson.updatedBy = req.user?.id || 'admin';
  course.updated_at = new Date().toISOString();

  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);

  return ok(res, {
    message: 'Lesson playback settings updated successfully',
    lesson,
    course: updatedCourse,
  });
});

const updateCourse = asyncHandler(async (req, res) => {
  const id = requireString(req.params.id, 'course id');
  const course = await loadCourseOrThrow(id);

  if (req.body.title !== undefined) course.title = requireString(req.body.title, 'title', { maxLength: 160 });
  if (req.body.description !== undefined) course.description = optionalString(req.body.description, '', { maxLength: 3000 });
  if (req.body.category !== undefined) course.category = optionalString(req.body.category, 'SSC JE', { maxLength: 80 });
  if (req.body.exam !== undefined) course.exam = optionalString(req.body.exam, course.category || 'SSC JE', { maxLength: 80 });
  if (req.body.subject !== undefined) course.subject = optionalString(req.body.subject, 'General', { maxLength: 120 });
  if (req.body.instructor !== undefined) course.instructor = optionalString(req.body.instructor, 'VARONENGLISH Faculty', { maxLength: 120 });
  if (req.body.officialChannelUrl !== undefined) course.officialChannelUrl = optionalString(req.body.officialChannelUrl, '', { maxLength: 500 }) || null;
  if (req.body.price !== undefined) course.price = optionalNumber(req.body.price, course.price || 1, { min: 1 });
  if (req.body.offerPercentage !== undefined) course.offerPercentage = optionalNumber(req.body.offerPercentage, course.offerPercentage || 0, { min: 0, max: 100 });
  if (req.body.validityDays !== undefined) course.validityDays = optionalNumber(req.body.validityDays, 365, { min: 1, max: 3650, integer: true });
  if (req.body.level !== undefined) course.level = optionalString(req.body.level, 'Full Course', { maxLength: 80 });
  if (req.body.thumbnailUrl !== undefined) course.thumbnailUrl = optionalString(req.body.thumbnailUrl, '', { maxLength: 500 });

  course.updated_at = new Date().toISOString();
  course.lastEditedBy = req.user?.id || 'admin';

  const updatedCourse = await coursesRepository.updateCourseModule(id, course);
  return ok(res, {
    message: 'Course updated successfully',
    course: updatedCourse,
  });
});

const deleteCourse = asyncHandler(async (req, res) => {
  const id = requireString(req.params.id, 'course id');
  const course = await loadCourseOrThrow(id);

  const fs = require('fs');
  const path = require('path');
  const courseVideosPath = path.join(__dirname, `../../uploads/videos/course_${id}`);
  if (fs.existsSync(courseVideosPath)) {
    fs.rmSync(courseVideosPath, { recursive: true, force: true });
  }

  const privateVideoDeletes = getFlattenedLessons(course)
    .filter((lesson) => Boolean(lesson.storagePath))
    .map((lesson) => deleteStoredPrivateVideo({
      storageProvider: lesson.storageProvider,
      storagePath: lesson.storagePath,
    }).catch((err) => {
      console.error(`Failed to delete private video file: ${lesson.storagePath}`, err);
    }));
  await Promise.all(privateVideoDeletes);

  await coursesRepository.delete(id);

  return ok(res, {
    message: 'Course deleted successfully',
    courseId: id,
  });
});

const addModule = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const title = requireString(req.body?.title, 'module title', { maxLength: 160 });
  const description = optionalString(req.body?.description, '', { maxLength: 1500 });
  const course = await loadCourseOrThrow(courseId);

  if (!Array.isArray(course.modules)) {
    course.modules = [];
  }

  const newModule = {
    id: `module_${Date.now()}`,
    title,
    description,
    order: optionalNumber(req.body?.order, course.modules.length + 1, { min: 1, max: 10000, integer: true }),
    lessons: [],
    createdAt: new Date().toISOString(),
    createdBy: req.user?.id || 'admin',
  };

  course.modules.push(newModule);
  course.updated_at = new Date().toISOString();

  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);
  return created(res, {
    message: 'Module added successfully',
    module: newModule,
    course: updatedCourse,
  });
});

const updateModule = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);

  if (req.body.title !== undefined) module.title = requireString(req.body.title, 'module title', { maxLength: 160 });
  if (req.body.description !== undefined) module.description = optionalString(req.body.description, '', { maxLength: 1500 });
  if (req.body.order !== undefined) module.order = optionalNumber(req.body.order, module.order || 1, { min: 1, max: 10000, integer: true });

  module.updatedAt = new Date().toISOString();
  module.updatedBy = req.user?.id || 'admin';
  course.updated_at = new Date().toISOString();

  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);
  return ok(res, {
    message: 'Module updated successfully',
    module,
    course: updatedCourse,
  });
});

const addChapter = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const title = requireString(req.body?.title, 'chapter title', { maxLength: 160 });
  const description = optionalString(req.body?.description, '', { maxLength: 1500 });
  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);

  const newChapter = {
    id: `chapter_${Date.now()}`,
    title,
    description,
    order: optionalNumber(req.body?.order, module.chapters.length + 1, { min: 1, max: 10000, integer: true }),
    lessons: [],
    createdAt: new Date().toISOString(),
    createdBy: req.user?.id || 'admin',
  };

  module.chapters.push(newChapter);
  course.updated_at = new Date().toISOString();

  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);
  return created(res, {
    message: 'Chapter added successfully',
    chapter: newChapter,
    course: updatedCourse,
  });
});

const updateChapter = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const chapterId = requireString(req.params.chapterId, 'chapter id');
  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const chapter = module.chapters.find((entry) => entry.id === chapterId);

  if (!chapter) {
    throw new ApiError(404, 'Chapter not found', { code: 'CHAPTER_NOT_FOUND' });
  }

  if (req.body.title !== undefined) chapter.title = requireString(req.body.title, 'chapter title', { maxLength: 160 });
  if (req.body.description !== undefined) chapter.description = optionalString(req.body.description, '', { maxLength: 1500 });
  if (req.body.order !== undefined) chapter.order = optionalNumber(req.body.order, chapter.order || 1, { min: 1, max: 10000, integer: true });
  chapter.updatedAt = new Date().toISOString();
  chapter.updatedBy = req.user?.id || 'admin';
  course.updated_at = new Date().toISOString();

  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);
  return ok(res, {
    message: 'Chapter updated successfully',
    chapter,
    course: updatedCourse,
  });
});

const deleteChapter = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const chapterId = requireString(req.params.chapterId, 'chapter id');
  const course = await loadCourseOrThrow(courseId);
  const module = loadModuleOrThrow(course, moduleId);
  const chapterIndex = module.chapters.findIndex((entry) => entry.id === chapterId);

  if (chapterIndex === -1) {
    throw new ApiError(404, 'Chapter not found', { code: 'CHAPTER_NOT_FOUND' });
  }

  await cleanupLessons(module.chapters[chapterIndex]?.lessons || []);
  module.chapters.splice(chapterIndex, 1);
  course.updated_at = new Date().toISOString();
  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);

  return ok(res, {
    message: 'Chapter deleted successfully',
    chapterId,
    course: updatedCourse,
  });
});

const deleteModule = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.courseId, 'course id');
  const moduleId = requireString(req.params.moduleId, 'module id');
  const course = await loadCourseOrThrow(courseId);

  const moduleIndex = course.modules?.findIndex((m) => m.id === moduleId);
  if (moduleIndex === undefined || moduleIndex === -1) {
    throw new ApiError(404, 'Module not found', { code: 'MODULE_NOT_FOUND' });
  }

  const deletedModule = course.modules[moduleIndex];
  await cleanupLessons(deletedModule.lessons || []);
  await Promise.all((deletedModule.chapters || []).map((chapter) => cleanupLessons(chapter.lessons || [])));

  course.modules.splice(moduleIndex, 1);
  course.updated_at = new Date().toISOString();

  const updatedCourse = await coursesRepository.updateCourseModule(courseId, course);
  return ok(res, {
    message: 'Module deleted successfully',
    moduleId,
    course: updatedCourse,
  });
});

const getCourseDetails = asyncHandler(async (req, res) => {
  const id = requireString(req.params.id, 'course id');
  const course = await loadCourseOrThrow(id);

  const stats = {
    totalModules: course.modules?.length || 0,
    totalLessons: getFlattenedLessons(course).length,
    totalVideos: getFlattenedLessons(course).filter((lesson) => lesson.type === 'video').length,
    totalEnrollments: course.enrollmentCount || 0,
  };

  return ok(res, {
    ...course,
    stats,
  });
});

const listCoursesAdmin = asyncHandler(async (_req, res) => {
  const courses = await coursesRepository.list();
  const enrichedCourses = courses.map((course) => ({
    ...course,
    stats: {
      totalModules: course.modules?.length || 0,
      totalLessons: getFlattenedLessons(course).length,
      totalEnrollments: course.enrollmentCount || 0,
    },
  }));

  return ok(res, enrichedCourses);
});

module.exports = {
  updateCourse,
  deleteCourse,
  addModule,
  updateModule,
  addChapter,
  updateChapter,
  deleteChapter,
  deleteModule,
  getCourseDetails,
  listCoursesAdmin,
  attachLessonCbt,
  deleteLessonCbt,
  updateLessonSettings,
};
