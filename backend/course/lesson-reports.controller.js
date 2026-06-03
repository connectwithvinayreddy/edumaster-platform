const {
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
} = require('../lib/http.js');
const {
  listLessonReportsForUser,
  createLessonReport,
  listAdminLessonReports,
  updateAdminLessonReport,
} = require('./lesson-reports.repository.js');
const { createAuditLog } = require('../admin/admin-management.service.js');

const getRequestContext = (req) => ({
  ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
  userAgent: req.headers['user-agent'] || null,
});

const getLessonReportsForCurrentUser = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'courseId');
  const lessonId = requireString(req.params.lessonId, 'lessonId');
  const reports = await listLessonReportsForUser({
    courseId,
    lessonId,
    userId: req.user.id,
    role: req.user.role,
  });
  return ok(res, { items: reports });
});

const postLessonReport = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'courseId');
  const lessonId = requireString(req.params.lessonId, 'lessonId');
  const issueType = requireString(req.body?.issueType, 'issueType', { maxLength: 60 });
  const description = requireString(req.body?.description, 'description', { minLength: 5, maxLength: 4000 });
  const report = await createLessonReport({
    courseId,
    lessonId,
    userId: req.user.id,
    role: req.user.role,
    issueType,
    description,
    pageUrl: optionalString(req.body?.pageUrl, '', { maxLength: 1000 }) || null,
    userAgent: req.headers['user-agent'] || null,
    screenshotUrl: optionalString(req.body?.screenshotUrl, '', { maxLength: 1000 }) || null,
    attachmentMeta: req.body?.attachmentMeta && typeof req.body.attachmentMeta === 'object' ? req.body.attachmentMeta : {},
  });
  return created(res, {
    message: 'Report submitted successfully',
    report,
  });
});

const getAdminLessonReports = asyncHandler(async (req, res) => {
  return ok(res, await listAdminLessonReports(req.query || {}));
});

const patchAdminLessonReport = asyncHandler(async (req, res) => {
  const reportId = requireString(req.params.reportId, 'reportId');
  const status = req.body?.status === undefined ? undefined : requireString(req.body?.status, 'status', { maxLength: 40 });
  const adminNote = req.body?.adminNote === undefined ? undefined : optionalString(req.body?.adminNote, '', { maxLength: 4000 });
  const adminReply = req.body?.adminReply === undefined ? undefined : optionalString(req.body?.adminReply, '', { maxLength: 4000 });
  const result = await updateAdminLessonReport({
    reportId,
    status,
    adminNote,
    adminReply,
    adminAttachments: Array.isArray(req.body?.adminAttachments) ? req.body.adminAttachments : undefined,
  });
  await createAuditLog({
    adminUserId: req.user.id,
    actionType: 'lesson_report_update',
    targetUserId: result.report.userId,
    courseId: result.report.courseId,
    transactionId: result.report._id,
    oldValue: {
      status: result.previous.status,
      adminNote: result.previous.adminNote,
      adminReply: result.previous.adminReply,
    },
    newValue: {
      status: result.report.status,
      adminNote: result.report.adminNote,
      adminReply: result.report.adminReply,
    },
    reason: optionalString(req.body?.reason, '', { maxLength: 500 }) || 'Admin updated lesson report',
    ...getRequestContext(req),
  });
  return ok(res, {
    message: 'Lesson report updated',
    report: result.report,
  });
});

module.exports = {
  getLessonReportsForCurrentUser,
  postLessonReport,
  getAdminLessonReports,
  patchAdminLessonReport,
};
