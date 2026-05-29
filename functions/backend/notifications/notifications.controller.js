// Notifications Controller
const { notificationsRepository } = require('../lib/repositories.js');

const getNotifications = async (req, res) => {
  try {
    const requestedUserId = req.user?.role === 'admin' && req.query.userId
      ? req.query.userId
      : req.user?.id;
    const notifications = await notificationsRepository.list(requestedUserId);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const sendNotification = async (req, res) => {
  try {
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
      return res.status(400).json({ message: 'userId or audience=all is required' });
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
    res.json({
      message: userId ? 'Notification sent' : 'Announcement sent',
      notification: notifications[0] || null,
      notificationsSent: notifications.length,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  getNotifications,
  sendNotification
};
