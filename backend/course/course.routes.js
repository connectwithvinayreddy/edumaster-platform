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
  retryVideoProcessing,
  getVideoMetadata,
} = require('./video-upload.controller.js');
const {
  getLessonDoubts,
  postLessonDoubtMessage,
  listAdminLessonDoubts,
  replyAdminLessonDoubt,
  updateAdminLessonDoubtStatus,
} = require('./lesson-doubts.controller.js');
const {
  getLessonReportsForCurrentUser,
  postLessonReport,
  getAdminLessonReports,
  patchAdminLessonReport,
} = require('./lesson-reports.controller.js');
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
  updateLessonSettings,
} = require('./course-admin.controller.js');
const {
  listCoursePdfAttachments,
  uploadCoursePdfAttachment,
  deleteCoursePdfAttachment,
  viewCoursePdfAttachment,
} = require('./course-pdf.controller.js');
const {
  uploadCourseEditorialVideo,
  deleteCourseEditorialVideo,
  getProtectedEditorialPlayer,
} = require('./course-editorial.controller.js');
const { uploadLessonSupportMedia } = require('./support-media.controller.js');
const { requireAuth, attachAuthIfPresent } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/admin.js');
const upload = require('../lib/multer-config.js');
const pdfUpload = require('../lib/course-pdf-upload.js');
const supportMediaUpload = require('../lib/support-media-upload.js');
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
router.put('/:courseId/modules/:moduleId/lessons/:lessonId/settings', requireAuth, requireAdmin, updateLessonSettings);
router.get('/:courseId/modules/:moduleId/pdfs', requireAuth, requireAdmin, listCoursePdfAttachments);
router.post('/:courseId/modules/:moduleId/pdfs', requireAuth, requireAdmin, pdfUpload.single('pdf'), uploadCoursePdfAttachment);
router.delete('/:courseId/modules/:moduleId/pdfs/:attachmentId', requireAuth, requireAdmin, deleteCoursePdfAttachment);
router.post('/:courseId/editorials', requireAuth, requireAdmin, upload.single('video'), uploadCourseEditorialVideo);
router.delete('/:courseId/editorials/:editorialId', requireAuth, requireAdmin, deleteCourseEditorialVideo);
router.post('/:id/lessons/:lessonId/support-media', requireAuth, supportMediaUpload.single('file'), uploadLessonSupportMedia);

// Admin routes - video upload and management
router.post('/:courseId/modules/:moduleId/videos/cloudflare/direct-upload', requireAuth, requireAdmin, initiateCloudflareStreamUpload);
router.post('/:courseId/modules/:moduleId/videos/cloudflare/complete', requireAuth, requireAdmin, completeCloudflareStreamUpload);
router.post('/:courseId/modules/:moduleId/videos', requireAuth, requireAdmin, upload.single('video'), uploadVideoToModule);
router.post('/:courseId/modules/:moduleId/videos/chunked', requireAuth, requireAdmin, upload.chunkUpload.single('chunk'), uploadVideoChunkToModule);
router.post('/:courseId/modules/:moduleId/videos/:videoId/retry-processing', requireAuth, requireAdmin, retryVideoProcessing);
router.delete('/:courseId/modules/:moduleId/videos/:videoId', requireAuth, requireAdmin, deleteVideoFromModule);
router.get('/:courseId/modules/:moduleId/videos', requireAuth, requireAdmin, listVideosInModule);
router.get('/:courseId/modules/:moduleId/videos/:videoId', requireAuth, requireAdmin, getVideoMetadata);
router.get('/admin/lesson-doubts', requireAuth, requireAdmin, listAdminLessonDoubts);
router.post('/admin/lesson-doubts/:threadId/reply', requireAuth, requireAdmin, replyAdminLessonDoubt);
router.patch('/admin/lesson-doubts/:threadId/status', requireAuth, requireAdmin, updateAdminLessonDoubtStatus);
router.get('/admin/reports', requireAuth, requireAdmin, getAdminLessonReports);
router.patch('/admin/reports/:reportId', requireAuth, requireAdmin, patchAdminLessonReport);

router.post('/webhooks/cloudflare-stream', handleCloudflareStreamWebhook);

// Public routes
router.get('/', attachAuthIfPresent, getCourses);
router.get('/h/*', streamCompactProtectedLessonAsset);
router.get('/hls/*', streamCompactProtectedLessonAsset);
router.get('/stream/:token', streamProtectedLesson);
router.get('/:id/pdf-attachments/:attachmentId/view', requireAuth, viewCoursePdfAttachment);
router.get('/:courseId/editorials/:editorialId/player', requireAuth, getProtectedEditorialPlayer);
router.get('/:id/lessons/:lessonId/bootstrap', requireAuth, getProtectedLessonBootstrap);
router.get('/:id/lessons/:lessonId/player', requireAuth, getProtectedLessonPlayer);
router.post('/:id/lessons/:lessonId/drm/license/:provider', proxyProtectedDrmLicense);
router.get('/:id/lessons/:lessonId/drm/fairplay-certificate', proxyProtectedFairplayCertificate);
router.get('/:id/lessons/:lessonId/doubts', requireAuth, getLessonDoubts);
router.post('/:id/lessons/:lessonId/doubts', requireAuth, postLessonDoubtMessage);
router.get('/:id/lessons/:lessonId/reports/my', requireAuth, getLessonReportsForCurrentUser);
router.post('/:id/lessons/:lessonId/reports', requireAuth, postLessonReport);
router.get('/:id/lessons', attachAuthIfPresent, getCourseLessons);
router.get('/:id', attachAuthIfPresent, getCourse);

module.exports = router;
