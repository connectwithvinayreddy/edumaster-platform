const {
  ApiError,
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
} = require('../lib/http.js');
const {
  listLessonDoubts,
  addLessonDoubtMessage,
  listAdminLessonDoubtThreads,
  getAdminLessonDoubtThreadById,
  updateLessonDoubtThreadStatus,
} = require('./lesson-doubts.repository.js');
const { createAuditLog } = require('../admin/admin-management.service.js');

const getRequestContext = (req) => ({
  ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
  userAgent: req.headers['user-agent'] || null,
});

const getLessonDoubts = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'courseId');
  const lessonId = requireString(req.params.lessonId, 'lessonId');
  const requestedMessageLimit = Number(req.query.messageLimit || 50);
  const result = await listLessonDoubts({
    courseId,
    lessonId,
    userId: req.user.id,
    role: req.user.role,
    messageLimitPerThread: Number.isFinite(requestedMessageLimit)
      ? Math.max(1, Math.min(Math.floor(requestedMessageLimit), 100))
      : 50,
  });
  return ok(res, result);
});

const postLessonDoubtMessage = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'courseId');
  const lessonId = requireString(req.params.lessonId, 'lessonId');
  const message = requireString(req.body?.message, 'message', { maxLength: 4000 });
  const threadId = optionalString(req.body?.threadId, '', { maxLength: 120 }) || null;
  const result = await addLessonDoubtMessage({
    courseId,
    lessonId,
    message,
    threadId,
    userId: req.user.id,
    role: req.user.role,
    attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
  });

  return created(res, {
    message: req.user.role === 'admin' ? 'Reply sent successfully' : 'Question sent successfully',
    thread: result.thread,
    notificationsSent: result.notificationsSent,
  });
});

module.exports = {
  getLessonDoubts,
  postLessonDoubtMessage,
  listAdminLessonDoubts: asyncHandler(async (req, res) => {
    return ok(res, await listAdminLessonDoubtThreads(req.query || {}));
  }),
  replyAdminLessonDoubt: asyncHandler(async (req, res) => {
    const threadId = requireString(req.params.threadId, 'threadId');
    const message = requireString(req.body?.message, 'message', { maxLength: 4000 });
    const target = await getAdminLessonDoubtThreadById(threadId);
    if (!target) {
      throw new ApiError(404, 'Lesson doubt thread not found', { code: 'LESSON_DOUBT_THREAD_NOT_FOUND' });
    }
    const result = await addLessonDoubtMessage({
      courseId: target.courseId,
      lessonId: target.lessonId,
      message,
      threadId,
      userId: req.user.id,
      role: 'admin',
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    });
    await createAuditLog({
      adminUserId: req.user.id,
      actionType: 'lesson_doubt_reply',
      targetUserId: result.thread.studentUserId,
      courseId: result.thread.courseId,
      transactionId: result.thread._id,
      newValue: { threadId: result.thread._id, status: result.thread.status },
      reason: 'Admin replied to lesson doubt thread',
      ...getRequestContext(req),
    });
    return created(res, {
      message: 'Reply sent successfully',
      thread: result.thread,
      notificationsSent: result.notificationsSent,
    });
  }),
  updateAdminLessonDoubtStatus: asyncHandler(async (req, res) => {
    const threadId = requireString(req.params.threadId, 'threadId');
    const status = requireString(req.body?.status, 'status', { maxLength: 40 });
    const thread = await updateLessonDoubtThreadStatus({ threadId, status });
    await createAuditLog({
      adminUserId: req.user.id,
      actionType: 'lesson_doubt_status_update',
      targetUserId: thread.studentUserId,
      courseId: thread.courseId,
      transactionId: thread._id,
      newValue: { threadId: thread._id, status: thread.status },
      reason: optionalString(req.body?.reason, '', { maxLength: 500 }) || 'Admin updated lesson doubt status',
      ...getRequestContext(req),
    });
    return ok(res, {
      message: 'Lesson doubt status updated',
      thread,
    });
  }),
};
