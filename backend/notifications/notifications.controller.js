// Notifications Controller
const { notificationsRepository } = require('../lib/repositories.js');
const { ApiError, asyncHandler, ok, requireString } = require('../lib/http.js');

const getNotifications = asyncHandler(async (req, res) => {
  const requestedUserId = req.user?.role === 'admin' && req.query.userId
    ? req.query.userId
    : req.user?.id;
  const requestedLimit = Number(req.query.limit || 0);
  const notifications = await notificationsRepository.list(requestedUserId, {
    limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : null,
  });
  return ok(res, notifications);
});

const sendNotification = asyncHandler(async (req, res) => {
  const {
    userId,
    title,
    message,
    type,
    entityId,
    actionUrl,
    actionLabel,
    payload,
    audience,
  } = req.body || {};
  if (!userId && audience !== 'all') {
    throw new ApiError(400, 'userId or audience=all is required', { code: 'VALIDATION_ERROR' });
  }

  const notifications = await notificationsRepository.notifyAnnouncement({
    userId,
    title,
    message,
    type,
    entityId,
    actionUrl,
    actionLabel,
    payload,
  });
  return ok(res, {
    message: userId ? 'Notification sent' : 'Announcement sent',
    notification: notifications[0] || null,
    notificationsSent: notifications.length,
  });
});

const markNotificationRead = asyncHandler(async (req, res) => {
  const notificationId = requireString(req.params.id, 'notificationId');
  const notification = await notificationsRepository.markRead(req.user.id, notificationId);
  if (!notification) {
    throw new ApiError(404, 'Notification not found', { code: 'NOTIFICATION_NOT_FOUND' });
  }
  return ok(res, { message: 'Notification marked as read', notification });
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
  const updated = await notificationsRepository.markAllRead(req.user.id);
  return ok(res, {
    message: 'Notifications marked as read',
    updated,
  });
});

module.exports = {
  getNotifications,
  sendNotification,
  markNotificationRead,
  markAllNotificationsRead,
};
