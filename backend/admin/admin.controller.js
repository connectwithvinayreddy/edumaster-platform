const {
  usersRepository,
  coursesRepository,
  testsRepository,
  adminRepository,
  sanitizeUser,
} = require('../lib/repositories.js');
const {
  asyncHandler,
  ok,
  created,
  requireString,
  optionalString,
} = require('../lib/http.js');
const adminManagement = require('./admin-management.service.js');

const getRequestContext = (req) => ({
  ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
  userAgent: req.headers['user-agent'] || null,
});

const getUsers = asyncHandler(async (_req, res) => {
  ok(res, await usersRepository.listSafe());
});

const getCourses = asyncHandler(async (_req, res) => {
  ok(res, await coursesRepository.list());
});

const getTests = asyncHandler(async (_req, res) => {
  ok(res, await testsRepository.list());
});

const getAnalytics = asyncHandler(async (_req, res) => {
  ok(res, await adminRepository.getPlatformAnalytics());
});

const getDashboard = asyncHandler(async (_req, res) => {
  ok(res, await adminManagement.getDashboardSummary(_req.query || {}));
});

const getStudentLiveMetrics = asyncHandler(async (_req, res) => {
  ok(res, await adminManagement.getStudentLiveMetricsSummary());
});

const uploadQuestions = asyncHandler(async (req, res) => {
  const result = await adminRepository.uploadQuestions(req.body || {});
  ok(res, {
    message: 'Questions uploaded',
    ...result,
  });
});

const listStudents = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listStudents(req.query || {}));
});

const listLoginSessions = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listLoginSessions(req.query || {}));
});

const createStudent = asyncHandler(async (req, res) => {
  const name = requireString(req.body?.name, 'name', { maxLength: 80 });
  const email = requireString(req.body?.email, 'email', { maxLength: 160 }).toLowerCase();
  const mobileNumber = optionalString(req.body?.mobileNumber, '', { maxLength: 20 });
  const password = requireString(req.body?.password, 'password', { minLength: 8, maxLength: 128 });
  const student = await adminManagement.createStudent({
    name,
    email,
    mobileNumber,
    password,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  });
  created(res, sanitizeUser(student));
});

const getStudentDetails = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.getStudentDetails(req.params.id));
});

const updateStudent = asyncHandler(async (req, res) => {
  const payload = {};
  if (req.body?.name !== undefined) {
    payload.name = requireString(req.body.name, 'name', { maxLength: 80 });
  }
  if (req.body?.email !== undefined) {
    payload.email = requireString(req.body.email, 'email', { maxLength: 160 }).toLowerCase();
  }
  if (req.body?.mobileNumber !== undefined) {
    payload.mobileNumber = optionalString(req.body.mobileNumber, '', { maxLength: 20 });
  }
  ok(res, sanitizeUser(await adminManagement.updateStudent(req.params.id, payload, {
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  })));
});

const updateStudentStatus = asyncHandler(async (req, res) => {
  const status = requireString(req.body?.status, 'status', { maxLength: 20 }).toLowerCase();
  ok(res, await adminManagement.updateStudentStatus({
    studentId: req.params.id,
    status,
    note: optionalString(req.body?.note, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const resetStudentPassword = asyncHandler(async (req, res) => {
  const newPassword = requireString(req.body?.newPassword, 'newPassword', { minLength: 8, maxLength: 128 });
  ok(res, await adminManagement.resetStudentPassword({
    studentId: req.params.id,
    newPassword,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
    reason: optionalString(req.body?.reason, '', { maxLength: 500 }),
  }));
});

const forceLogoutStudent = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.forceLogoutStudent({
    studentId: req.params.id,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
    reason: 'admin_force_logout',
  }));
});

const clearPlaybackSessions = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.clearPlaybackSessions({
    studentId: req.params.id,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const resetWatchProgress = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.resetWatchProgress({
    studentId: req.params.id,
    stateId: req.params.stateId,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
    reason: optionalString(req.body?.reason, '', { maxLength: 500 }),
    action: optionalString(req.body?.action, '', { maxLength: 40 }),
  }));
});

const getStudentAuditLog = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.getAuditLogsForUser(req.params.id, 200));
});

const listPurchases = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listPurchases(req.query || {}));
});

const listCourseAccess = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listCourseAccess(req.query || {}));
});

const listCourseAccessRules = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listCourseAccessRules(req.query || {}));
});

const upsertCourseAccessRule = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.upsertCourseAccessRule({
    courseId: requireString(req.body?.courseId, 'courseId'),
    studentScope: optionalString(req.body?.studentScope, '', { maxLength: 20 }) || undefined,
    studentId: optionalString(req.body?.studentId, '', { maxLength: 160 }) || undefined,
    contentScope: optionalString(req.body?.contentScope, '', { maxLength: 20 }) || undefined,
    moduleId: optionalString(req.body?.moduleId, '', { maxLength: 160 }) || undefined,
    chapterId: optionalString(req.body?.chapterId, '', { maxLength: 160 }) || undefined,
    lessonId: optionalString(req.body?.lessonId, '', { maxLength: 160 }) || undefined,
    access: optionalString(req.body?.access, '', { maxLength: 10 }) || undefined,
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }) || undefined,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const deleteCourseAccessRule = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.deleteCourseAccessRule({
    ruleId: req.params.id,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const listStudentLessonWatchOverrides = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listStudentLessonWatchOverrides(req.query || {}));
});

const upsertStudentLessonWatchOverride = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.upsertStudentLessonWatchOverride({
    courseId: requireString(req.body?.courseId, 'courseId'),
    studentId: requireString(req.body?.studentId, 'studentId'),
    moduleId: optionalString(req.body?.moduleId, '', { maxLength: 160 }) || undefined,
    chapterId: optionalString(req.body?.chapterId, '', { maxLength: 160 }) || undefined,
    lessonId: optionalString(req.body?.lessonId, '', { maxLength: 160 }) || undefined,
    allowedFullWatches: req.body?.allowedFullWatches,
    watchCompletionPercent: req.body?.watchCompletionPercent,
    bulkScope: optionalString(req.body?.bulkScope, '', { maxLength: 20 }) || undefined,
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }) || undefined,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const deleteStudentLessonWatchOverride = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.deleteStudentLessonWatchOverride({
    overrideId: req.params.id,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const assignCourse = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.assignCourse({
    studentId: requireString(req.body?.studentId, 'studentId'),
    courseId: requireString(req.body?.courseId, 'courseId'),
    validUntil: optionalString(req.body?.validUntil, '', { maxLength: 80 }) || null,
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const updatePurchase = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.updatePurchase({
    purchaseId: req.params.id,
    accessStatus: optionalString(req.body?.accessStatus, '', { maxLength: 30 }) || undefined,
    validUntil: optionalString(req.body?.validUntil, '', { maxLength: 80 }) || undefined,
    paymentStatus: optionalString(req.body?.paymentStatus, '', { maxLength: 30 }) || undefined,
    transactionId: optionalString(req.body?.transactionId, '', { maxLength: 160 }) || undefined,
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }) || undefined,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const removeCourseAccess = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.removeCourseAccess({
    studentId: requireString(req.body?.studentId, 'studentId'),
    courseId: requireString(req.body?.courseId, 'courseId'),
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const diagnoseCourseAccess = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.diagnoseCourseAccess({
    studentId: requireString(req.query?.studentId, 'studentId'),
    courseId: optionalString(req.query?.courseId, '', { maxLength: 160 }),
    transactionId: optionalString(req.query?.transactionId, '', { maxLength: 160 }),
  }));
});

const repairCourseAccess = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.repairCourseAccess({
    studentId: requireString(req.body?.studentId, 'studentId'),
    courseId: optionalString(req.body?.courseId, '', { maxLength: 160 }),
    transactionId: optionalString(req.body?.transactionId, '', { maxLength: 160 }),
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const listTransactions = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listTransactions(req.query || {}));
});

const listManualReviewQueue = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listManualReviewQueue(req.query || {}));
});

const listAuditLogs = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.listAuditLogs(req.query || {}));
});

const getSystemHealth = asyncHandler(async (_req, res) => {
  ok(res, await adminManagement.getSystemHealthSummary());
});

const updateTransaction = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.updateTransaction({
    paymentId: req.params.id,
    status: optionalString(req.body?.status, '', { maxLength: 30 }) || undefined,
    transactionId: optionalString(req.body?.transactionId, '', { maxLength: 160 }) || undefined,
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }) || undefined,
    manualReviewRequired: req.body?.manualReviewRequired === undefined ? undefined : Boolean(req.body.manualReviewRequired),
    verificationDecision: optionalString(req.body?.verificationDecision, '', { maxLength: 80 }) || undefined,
    verificationReason: optionalString(req.body?.verificationReason, '', { maxLength: 500 }) || undefined,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const syncRazorpayPayment = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.syncRazorpayPayment({
    paymentId: optionalString(req.body?.paymentId, '', { maxLength: 160 }),
    transactionId: optionalString(req.body?.transactionId, '', { maxLength: 160 }),
    orderId: optionalString(req.body?.orderId, '', { maxLength: 160 }),
    studentId: optionalString(req.body?.studentId, '', { maxLength: 160 }),
    courseId: optionalString(req.body?.courseId, '', { maxLength: 160 }),
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const syncAllPendingRazorpayPayments = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.syncAllPendingRazorpayPayments({
    maxRecords: req.body?.maxRecords,
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const getPaymentReconciliation = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.getPaymentReconciliationReport(req.query || {}));
});

const getUnverifiedLocalPaidRows = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.getUnverifiedLocalPaidRowsReport({
    rangePreset: optionalString(req.query?.rangePreset, '', { maxLength: 40 }),
    startDate: optionalString(req.query?.startDate, '', { maxLength: 20 }),
    endDate: optionalString(req.query?.endDate, '', { maxLength: 20 }),
    timezone: optionalString(req.query?.timezone, '', { maxLength: 80 }),
    paymentMode: optionalString(req.query?.paymentMode, '', { maxLength: 20 }),
    limit: req.query?.limit,
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const previewAutomationCleanup = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.previewAutomationCleanup({
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

const executeAutomationCleanup = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.executeAutomationCleanup({
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
    confirmToken: requireString(req.body?.confirmToken, 'confirmToken', { maxLength: 128 }),
  }));
});

const repairUnverifiedLocalPaidRows = asyncHandler(async (req, res) => {
  ok(res, await adminManagement.repairUnverifiedLocalPaidRows({
    rangePreset: optionalString(req.body?.rangePreset, '', { maxLength: 40 }),
    startDate: optionalString(req.body?.startDate, '', { maxLength: 20 }),
    endDate: optionalString(req.body?.endDate, '', { maxLength: 20 }),
    timezone: optionalString(req.body?.timezone, '', { maxLength: 80 }),
    paymentMode: optionalString(req.body?.paymentMode, '', { maxLength: 20 }),
    limit: req.body?.limit,
    dryRun: req.body?.dryRun === undefined ? true : Boolean(req.body.dryRun),
    adminNote: optionalString(req.body?.adminNote, '', { maxLength: 500 }),
    adminUserId: req.user.id,
    requestContext: getRequestContext(req),
  }));
});

module.exports = {
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
  updateTransaction,
  syncRazorpayPayment,
  syncAllPendingRazorpayPayments,
  getPaymentReconciliation,
  getUnverifiedLocalPaidRows,
  previewAutomationCleanup,
  executeAutomationCleanup,
  repairUnverifiedLocalPaidRows,
};
