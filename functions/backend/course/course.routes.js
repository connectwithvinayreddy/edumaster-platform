const express = require('express');
const {
  getCourses,
  getCourse,
  getCourseLessons,
  getProtectedLessonBootstrap,
  getProtectedLessonPlayer,
  proxyProtectedDrmLicense,
  proxyProtectedFairplayCertificate,
  streamProtectedLesson,
  streamCompactProtectedLessonAsset,
  createCourse,
} = require('./course.controller.js');
const {
  uploadVideoToModule,
  uploadVideoChunkToModule,
  initiateCloudflareStreamUpload,
  completeCloudflareStreamUpload,
  handleCloudflareStreamWebhook,
  deleteVideoFromModule,
  listVideosInModule,
  getVideoMetadata,
} = require('./video-upload.controller.js');
const {
  getLessonDoubts,
  postLessonDoubtMessage,
} = require('./lesson-doubts.controller.js');
const {
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
} = require('./course-admin.controller.js');
const { requireAuth, attachAuthIfPresent } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/admin.js');
const upload = require('../lib/multer-config.js');
const router = express.Router();

// Admin routes - course management
router.get('/admin/details/:id', requireAuth, requireAdmin, getCourseDetails);
router.get('/admin/list', requireAuth, requireAdmin, listCoursesAdmin);
router.post('/', requireAuth, requireAdmin, createCourse);
router.put('/:id', requireAuth, requireAdmin, updateCourse);
router.delete('/:id', requireAuth, requireAdmin, deleteCourse);

// Admin routes - module management
router.post('/:courseId/modules', requireAuth, requireAdmin, addModule);
router.put('/:courseId/modules/:moduleId', requireAuth, requireAdmin, updateModule);
router.delete('/:courseId/modules/:moduleId', requireAuth, requireAdmin, deleteModule);
router.post('/:courseId/modules/:moduleId/chapters', requireAuth, requireAdmin, addChapter);
router.put('/:courseId/modules/:moduleId/chapters/:chapterId', requireAuth, requireAdmin, updateChapter);
router.delete('/:courseId/modules/:moduleId/chapters/:chapterId', requireAuth, requireAdmin, deleteChapter);
router.put('/:courseId/modules/:moduleId/lessons/:lessonId/cbt', requireAuth, requireAdmin, attachLessonCbt);
router.delete('/:courseId/modules/:moduleId/lessons/:lessonId/cbt', requireAuth, requireAdmin, deleteLessonCbt);

// Admin routes - video upload and management
router.post('/:courseId/modules/:moduleId/videos/cloudflare/direct-upload', requireAuth, requireAdmin, initiateCloudflareStreamUpload);
router.post('/:courseId/modules/:moduleId/videos/cloudflare/complete', requireAuth, requireAdmin, completeCloudflareStreamUpload);
router.post('/:courseId/modules/:moduleId/videos', requireAuth, requireAdmin, upload.single('video'), uploadVideoToModule);
router.post('/:courseId/modules/:moduleId/videos/chunked', requireAuth, requireAdmin, upload.chunkUpload.single('chunk'), uploadVideoChunkToModule);
router.delete('/:courseId/modules/:moduleId/videos/:videoId', requireAuth, requireAdmin, deleteVideoFromModule);
router.get('/:courseId/modules/:moduleId/videos', requireAuth, requireAdmin, listVideosInModule);
router.get('/:courseId/modules/:moduleId/videos/:videoId', requireAuth, requireAdmin, getVideoMetadata);

router.post('/webhooks/cloudflare-stream', handleCloudflareStreamWebhook);

// Public routes
router.get('/', attachAuthIfPresent, getCourses);
router.get('/h/*', streamCompactProtectedLessonAsset);
router.get('/hls/*', streamCompactProtectedLessonAsset);
router.get('/stream/:token', streamProtectedLesson);
router.get('/:id/lessons/:lessonId/bootstrap', requireAuth, getProtectedLessonBootstrap);
router.get('/:id/lessons/:lessonId/player', requireAuth, getProtectedLessonPlayer);
router.post('/:id/lessons/:lessonId/drm/license/:provider', proxyProtectedDrmLicense);
router.get('/:id/lessons/:lessonId/drm/fairplay-certificate', proxyProtectedFairplayCertificate);
router.get('/:id/lessons/:lessonId/doubts', requireAuth, getLessonDoubts);
router.post('/:id/lessons/:lessonId/doubts', requireAuth, postLessonDoubtMessage);
router.get('/:id/lessons', attachAuthIfPresent, getCourseLessons);
router.get('/:id', attachAuthIfPresent, getCourse);

module.exports = router;
