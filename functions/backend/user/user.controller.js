// User Controller
const { usersRepository, analyticsRepository, sanitizeUser } = require('../lib/repositories.js');
const { ApiError, asyncHandler, ok, requireString, optionalString } = require('../lib/http.js');

const getProfile = async (req, res) => {
  try {
    const user = await usersRepository.findSafeById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateProfile = asyncHandler(async (req, res) => {
  const name = requireString(req.body?.name, 'name', { maxLength: 80 });
  const email = requireString(req.body?.email, 'email', { maxLength: 160 }).toLowerCase();
  const mobileNumber = optionalString(req.body?.mobileNumber, '', { maxLength: 20 });

  const currentUser = await usersRepository.findById(req.user.id);
  if (!currentUser) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  if (email !== currentUser.email) {
    const existing = await usersRepository.findByEmail(email);
    if (existing && String(existing._id) !== String(req.user.id)) {
      throw new ApiError(409, 'Email already exists', { code: 'EMAIL_EXISTS' });
    }
  }

  const updatedUser = await usersRepository.update(req.user.id, {
    name,
    email,
    mobileNumber: mobileNumber || null,
  });

  return ok(res, { user: sanitizeUser(updatedUser) });
});

const getProgress = async (req, res) => {
  try {
    const progress = await analyticsRepository.getProgress(req.user.id);
    res.json(progress);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getAnalytics = async (req, res) => {
  try {
    const analytics = await analyticsRepository.getUserAnalytics(req.user.id);
    res.json(analytics);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getProfile, updateProfile, getProgress, getAnalytics };
