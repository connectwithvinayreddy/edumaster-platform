const {
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
} = require('../lib/http.js');
const { listLessonDoubts, addLessonDoubtMessage } = require('./lesson-doubts.repository.js');

const getLessonDoubts = asyncHandler(async (req, res) => {
  const courseId = requireString(req.params.id, 'courseId');
  const lessonId = requireString(req.params.lessonId, 'lessonId');
  const result = await listLessonDoubts({
    courseId,
    lessonId,
    userId: req.user.id,
    role: req.user.role,
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
};
