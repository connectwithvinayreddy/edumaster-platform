// User Controller
const bcrypt = require('bcryptjs');
const {
  usersRepository,
  analyticsRepository,
  sanitizeUser,
  sessionRepository,
} = require('../lib/repositories.js');
const { ApiError, asyncHandler, ok, requireString } = require('../lib/http.js');

const validateNewPassword = (value) => {
  const password = requireString(value, 'newPassword', { minLength: 8, maxLength: 128 });
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new ApiError(400, 'newPassword must include at least one letter and one number', {
      code: 'VALIDATION_ERROR',
    });
  }
  return password;
};

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
  const requestedMobileNumber = String(req.body?.mobileNumber || '').trim();

  const currentUser = await usersRepository.findById(req.user.id);
  if (!currentUser) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  let mobileNumber = currentUser.mobileNumber || null;
  if (requestedMobileNumber) {
    const normalizedDigits = requestedMobileNumber.replace(/\D/g, '');
    if (normalizedDigits.length < 10 || normalizedDigits.length > 15) {
      throw new ApiError(400, 'Enter a valid mobile number', {
        code: 'INVALID_MOBILE_NUMBER',
      });
    }

    const existingUser = await usersRepository.findByMobileNumber(requestedMobileNumber);
    if (existingUser && String(existingUser._id) !== String(currentUser._id)) {
      throw new ApiError(409, 'This mobile number is already linked to another account', {
        code: 'MOBILE_NUMBER_IN_USE',
      });
    }

    mobileNumber = requestedMobileNumber;
  }

  const updatedUser = await usersRepository.update(req.user.id, {
    name,
    mobileNumber,
  });

  return ok(res, { user: sanitizeUser(updatedUser) });
});

const changePassword = asyncHandler(async (req, res) => {
  const currentPassword = requireString(req.body?.currentPassword, 'currentPassword', { minLength: 8, maxLength: 128 });
  const newPassword = validateNewPassword(req.body?.newPassword);
  const confirmPassword = requireString(req.body?.confirmPassword, 'confirmPassword', { minLength: 8, maxLength: 128 });

  if (newPassword !== confirmPassword) {
    throw new ApiError(400, 'New password and confirm password must match', {
      code: 'PASSWORD_CONFIRM_MISMATCH',
    });
  }

  const currentUser = await usersRepository.findById(req.user.id);
  if (!currentUser) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  const passwordMatches = await bcrypt.compare(currentPassword, currentUser.password || '');
  if (!passwordMatches) {
    throw new ApiError(401, 'Current password is incorrect', { code: 'INVALID_CURRENT_PASSWORD' });
  }

  const isSamePassword = await bcrypt.compare(newPassword, currentUser.password || '');
  if (isSamePassword) {
    throw new ApiError(400, 'New password must be different from the current password', {
      code: 'PASSWORD_UNCHANGED',
    });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await usersRepository.update(req.user.id, {
    password: passwordHash,
  });

  await sessionRepository.recordLogout({
    userId: req.user.id,
    sessionId: req.user.session || null,
    device: null,
    reason: 'password_change',
  });

  return ok(res, {
    success: true,
    message: 'Password changed successfully. Please sign in again.',
  });
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

module.exports = { getProfile, updateProfile, changePassword, getProgress, getAnalytics };
