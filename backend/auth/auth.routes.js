const express = require('express');
const {
  register,
  login,
  socialLogin,
  firebaseLogin,
  getSession,
  logout,
} = require('./auth.controller.js');
const { requireAuth } = require('../middleware/auth.js');
const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/firebase', firebaseLogin);
router.post('/social', socialLogin);
router.get('/session', requireAuth, getSession);
router.post('/logout', requireAuth, logout);

module.exports = router;
