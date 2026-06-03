const express = require('express');
const {
  getUsers,
  getCourses,
  getTests,
  getAnalytics,
  getDashboard,
  getStudentLiveMetrics,
  uploadQuestions,
  listStudents,
  listLoginSessions,
  createStudent,
  getStudentDetails,
  updateStudent,
  updateStudentStatus,
  resetStudentPassword,
  forceLogoutStudent,
  clearPlaybackSessions,
  resetWatchProgress,
  getStudentAuditLog,
  listPurchases,
  listCourseAccess,
  listCourseAccessRules,
  upsertCourseAccessRule,
  deleteCourseAccessRule,
  listStudentLessonWatchOverrides,
  upsertStudentLessonWatchOverride,
  deleteStudentLessonWatchOverride,
  assignCourse,
  updatePurchase,
  removeCourseAccess,
  diagnoseCourseAccess,
  repairCourseAccess,
  listTransactions,
  listManualReviewQueue,
  listAuditLogs,
  getSystemHealth,
  getPaymentReconciliation,
  getUnverifiedLocalPaidRows,
  previewAutomationCleanup,
  executeAutomationCleanup,
  repairUnverifiedLocalPaidRows,
  updateTransaction,
  syncRazorpayPayment,
  syncAllPendingRazorpayPayments,
} = require('./admin.controller.js');
const { requireAuth } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/admin.js');
const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/dashboard', getDashboard);
router.get('/students/live-metrics', getStudentLiveMetrics);
router.get('/users', getUsers);
router.get('/courses', getCourses);
router.get('/tests', getTests);
router.get('/analytics', getAnalytics);
router.post('/upload-questions', uploadQuestions);
router.get('/students', listStudents);
router.get('/login-sessions', listLoginSessions);
router.post('/students', createStudent);
router.get('/students/:id', getStudentDetails);
router.patch('/students/:id', updateStudent);
router.post('/students/:id/status', updateStudentStatus);
router.post('/students/:id/reset-password', resetStudentPassword);
router.post('/students/:id/force-logout', forceLogoutStudent);
router.post('/students/:id/playback-sessions/clear', clearPlaybackSessions);
router.post('/students/:id/watch-progress/:stateId/reset', resetWatchProgress);
router.get('/students/:id/audit', getStudentAuditLog);
router.get('/purchases', listPurchases);
router.get('/course-access', listCourseAccess);
router.get('/course-access/rules', listCourseAccessRules);
router.put('/course-access/rules', upsertCourseAccessRule);
router.delete('/course-access/rules/:id', deleteCourseAccessRule);
router.get('/course-access/watch-overrides', listStudentLessonWatchOverrides);
router.put('/course-access/watch-overrides', upsertStudentLessonWatchOverride);
router.delete('/course-access/watch-overrides/:id', deleteStudentLessonWatchOverride);
router.post('/purchases/assign-course', assignCourse);
router.patch('/purchases/:id', updatePurchase);
router.post('/purchases/remove-course', removeCourseAccess);
router.get('/access/diagnose', diagnoseCourseAccess);
router.post('/access/repair', repairCourseAccess);
router.get('/transactions', listTransactions);
router.get('/payments/reconciliation', getPaymentReconciliation);
router.get('/payments/unverified-local-paid', getUnverifiedLocalPaidRows);
router.post('/payments/unverified-local-paid/repair', repairUnverifiedLocalPaidRows);
router.get('/manual-review', listManualReviewQueue);
router.get('/audit-logs', listAuditLogs);
router.get('/system-health', getSystemHealth);
router.post('/cleanup/preview', previewAutomationCleanup);
router.post('/cleanup/execute', executeAutomationCleanup);
router.post('/transactions/sync-razorpay', syncRazorpayPayment);
router.post('/transactions/sync-razorpay-all', syncAllPendingRazorpayPayments);
router.patch('/transactions/:id', updateTransaction);

module.exports = router;
