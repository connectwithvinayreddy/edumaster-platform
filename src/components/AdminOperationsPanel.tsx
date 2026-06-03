import React, { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, Search, ShieldCheck, UserPlus, Wallet } from 'lucide-react';
import { EduService } from '../EduService';
import {
  AdminAccessDiagnosis,
  AdminBulkRazorpaySyncResult,
  AdminDashboardSummary,
  AdminPagination,
  AdminPurchaseRecord,
  AdminRepairResult,
  AdminRazorpaySyncResult,
  AdminStudentDetails,
  AdminStudentSummary,
  AdminTransactionRecord,
  CourseCard,
} from '../types';

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

type AdminOperationsMode = 'students' | 'purchases' | 'transactions';

interface AdminOperationsPanelProps {
  mode: AdminOperationsMode;
  courses: CourseCard[];
}

const emptyPagination: AdminPagination = {
  page: 1,
  pageSize: 25,
  total: 0,
  totalPages: 1,
};

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return 'NA';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'NA';
  }
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

const formatSeconds = (value?: number | string | null) => {
  const totalSeconds = Math.max(0, Math.round(Number(value || 0)));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const formatPlaybackRate = (value?: number | string | null) => {
  const rate = Number(value || 1);
  return `${Number.isFinite(rate) ? rate.toFixed(rate % 1 === 0 ? 0 : 1) : '1'}x`;
};

const getPlaybackAuditForWatch = (details: AdminStudentDetails, entry: { courseId: string; lessonId?: string | null; videoId: string; videoType: string }) =>
  (details.deviceActivity || [])
    .filter((activity) => {
      const meta = activity.meta || {};
      const eventType = String(activity.eventType || '');
      return (
        ['video_playback_heartbeat', 'video_playback_suspicious', 'video_watch_locked'].includes(eventType)
        && String(meta.courseId || '') === String(entry.courseId || '')
        && String(meta.videoId || '') === String(entry.videoId || '')
        && String(meta.videoType || 'course') === String(entry.videoType || 'course')
        && (!entry.lessonId || String(meta.lessonId || '') === String(entry.lessonId || ''))
      );
    })
    .slice(0, 8);

const statusPill = (value: string) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'active' || normalized === 'enabled' || normalized === 'success' || normalized === 'paid') {
    return 'bg-[var(--success-soft)] text-[var(--success)]';
  }
  if (normalized === 'pending' || normalized === 'pending_access') {
    return 'bg-[#fff6dd] text-[#9a6b00]';
  }
  if (normalized === 'expired' || normalized === 'failed' || normalized === 'disabled' || normalized === 'removed') {
    return 'bg-[#fff0f0] text-[#c94b4b]';
  }
  if (normalized === 'blocked' || normalized === 'refunded') {
    return 'bg-[#eef2ff] text-[#485bd7]';
  }
  return 'bg-slate-100 text-slate-600';
};

export const AdminOperationsPanel: React.FC<AdminOperationsPanelProps> = ({ mode, courses }) => {
  const [dashboard, setDashboard] = useState<AdminDashboardSummary | null>(null);
  const [students, setStudents] = useState<AdminStudentSummary[]>([]);
  const [purchases, setPurchases] = useState<AdminPurchaseRecord[]>([]);
  const [transactions, setTransactions] = useState<AdminTransactionRecord[]>([]);
  const [studentDetails, setStudentDetails] = useState<AdminStudentDetails | null>(null);
  const [diagnosis, setDiagnosis] = useState<AdminAccessDiagnosis | null>(null);
  const [repairResult, setRepairResult] = useState<AdminRepairResult | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<AdminRazorpaySyncResult | null>(null);
  const [lastBulkSyncResult, setLastBulkSyncResult] = useState<AdminBulkRazorpaySyncResult | null>(null);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [pagination, setPagination] = useState<AdminPagination>(emptyPagination);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadDashboard = async () => {
    try {
      const result = await EduService.getAdminDashboard();
      setDashboard(result);
    } catch {
      // Keep the panel usable even if dashboard metrics fail.
    }
  };

  const loadMode = async (page = 1) => {
    setLoading(true);
    setMessage(null);
    try {
      if (mode === 'students') {
        const result = await EduService.listAdminStudents({
          page,
          pageSize: pagination.pageSize || 25,
          search,
          status: statusFilter,
        });
        setStudents(result.items);
        setPagination(result.pagination);
      } else if (mode === 'purchases') {
        const result = await EduService.listAdminPurchases({
          page,
          pageSize: pagination.pageSize || 25,
          search,
          paymentStatus: statusFilter,
          courseId: courseFilter,
        });
        setPurchases(result.items);
        setPagination(result.pagination);
      } else {
        const result = await EduService.listAdminTransactions({
          page,
          pageSize: pagination.pageSize || 25,
          search,
          paymentStatus: statusFilter,
          courseId: courseFilter,
        });
        setTransactions(result.items);
        setPagination(result.pagination);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load admin records right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPagination((current) => ({ ...emptyPagination, pageSize: current.pageSize || 25 }));
    setSelectedStudentId(null);
    setStudentDetails(null);
    setDiagnosis(null);
    setRepairResult(null);
    setLastSyncResult(null);
    setLastBulkSyncResult(null);
    void loadDashboard();
  }, [mode]);

  useEffect(() => {
    void loadMode(1);
  }, [mode, search, statusFilter, courseFilter]);

  const openStudent = async (studentId: string) => {
    setDetailLoading(true);
    setSelectedStudentId(studentId);
    try {
      const result = await EduService.getAdminStudentDetails(studentId);
      setStudentDetails(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load student details.');
    } finally {
      setDetailLoading(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    setActionBusy(true);
    setMessage(null);
    try {
      await action();
      await Promise.all([loadDashboard(), loadMode(pagination.page)]);
      if (selectedStudentId) {
        await openStudent(selectedStudentId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setActionBusy(false);
    }
  };

  const repairWatchProgress = async (
    stateId: string,
    action: 'full_reset' | 'completed_watches' | 'grace_unlock',
    successMessage: string,
  ) => {
    if (!selectedStudentId) {
      return;
    }
    await runAction(async () => {
      await EduService.resetAdminWatchProgress(selectedStudentId, stateId, {
        action,
        reason: `Admin ${action.replace(/_/g, ' ')} from detail panel`,
      });
      setMessage(successMessage);
      const refreshed = await EduService.getAdminStudentDetails(selectedStudentId);
      setStudentDetails(refreshed);
    });
  };

  const createStudent = async () => {
    const name = window.prompt('Student name');
    if (!name) return;
    const email = window.prompt('Student email');
    if (!email) return;
    const mobileNumber = window.prompt('Student mobile number') || '';
    const password = window.prompt('Temporary password (min 8 chars, never shown again)');
    if (!password) return;
    await runAction(async () => {
      await EduService.createAdminStudent({ name, email, mobileNumber, password });
      setMessage('Student created successfully.');
    });
  };

  const updateStudentStatus = async (studentId: string, status: string) => {
    const note = window.prompt(`Reason for marking this account ${status}`, '') || '';
    await runAction(async () => {
      await EduService.updateAdminStudentStatus(studentId, { status, note });
      setMessage(`Student marked ${status}.`);
    });
  };

  const resetPassword = async (studentId: string) => {
    const newPassword = window.prompt('Enter a new password for this student');
    if (!newPassword) return;
    await runAction(async () => {
      await EduService.resetAdminStudentPassword(studentId, { newPassword, reason: 'Admin reset from admin panel' });
      setMessage('Password reset and student logged out from active sessions.');
    });
  };

  const assignCourse = async (studentId?: string, prefilledCourseId?: string, prefilledPaymentReference?: string) => {
    const resolvedStudentId = studentId || selectedStudentId;
    if (!resolvedStudentId) return;
    const courseId = window.prompt('Enter course ID to assign', prefilledCourseId || '');
    if (!courseId) return;
    const validUntil = window.prompt('Validity end date in ISO format (optional)', '') || undefined;
    const paymentReference = window.prompt('Optional payment reference / order note', prefilledPaymentReference || '') || '';
    const adminNoteInput = window.prompt('Admin note (optional)', '') || '';
    const adminNote = [adminNoteInput.trim(), paymentReference.trim() ? `Payment reference: ${paymentReference.trim()}` : '']
      .filter(Boolean)
      .join(' | ') || undefined;
    await runAction(async () => {
      await EduService.assignAdminCourse({ studentId: resolvedStudentId, courseId, validUntil, adminNote });
      setMessage('Course assigned successfully.');
    });
  };

  const extendValidity = async (purchase: AdminPurchaseRecord) => {
    const validUntil = window.prompt('Enter new validity date in ISO format', purchase.validUntil || '') || '';
    if (!validUntil) return;
    const adminNote = window.prompt('Admin note (optional)', purchase.adminNote || '') || undefined;
    await runAction(async () => {
      await EduService.updateAdminPurchase(purchase.purchaseId, { validUntil, adminNote });
      setMessage('Course validity updated.');
    });
  };

  const updatePurchaseAccess = async (purchase: AdminPurchaseRecord, accessStatus: string) => {
    const adminNote = window.prompt('Admin note (optional)', purchase.adminNote || '') || undefined;
    await runAction(async () => {
      await EduService.updateAdminPurchase(purchase.purchaseId, { accessStatus, adminNote });
      setMessage(`Course access marked ${accessStatus}.`);
    });
  };

  const removeCourse = async (purchase: AdminPurchaseRecord) => {
    if (!purchase.studentId || !purchase.courseId) return;
    const adminNote = window.prompt('Reason for removing course access', purchase.adminNote || '') || undefined;
    await runAction(async () => {
      await EduService.removeAdminCourseAccess({
        studentId: purchase.studentId,
        courseId: purchase.courseId,
        adminNote,
      });
      setMessage('Course access removed.');
    });
  };

  const diagnoseAccess = async (purchase: AdminPurchaseRecord) => {
    if (!purchase.studentId) return;
    setActionBusy(true);
    setMessage(null);
    try {
      const result = await EduService.diagnoseAdminCourseAccess({
        studentId: purchase.studentId,
        courseId: purchase.courseId || undefined,
        transactionId: purchase.transactionId || undefined,
      });
      setDiagnosis(result);
      setRepairResult(null);
      setMessage(result.frontendPurchaseFlagExpected
        ? 'Access looks active. If the student still sees Buy, check for a stale session or duplicate account.'
        : result.accessBlockReason || 'Access review completed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to diagnose course access.');
    } finally {
      setActionBusy(false);
    }
  };

  const repairAccess = async (purchase: AdminPurchaseRecord) => {
    if (!purchase.studentId) return;
    const adminNote = window.prompt('Admin note for Repair Course Access', purchase.adminNote || '') || undefined;
    await runAction(async () => {
      const result = await EduService.repairAdminCourseAccess({
        studentId: purchase.studentId!,
        courseId: purchase.courseId || undefined,
        transactionId: purchase.transactionId || undefined,
        adminNote,
      });
      setDiagnosis(result.diagnosisAfter);
      setRepairResult(result);
      setMessage(`Repair completed: ${result.repairSummary.studentShouldNowSee}`);
    });
  };

  const syncRazorpayForPurchase = async (purchase: AdminPurchaseRecord) => {
    const adminNote = window.prompt('Admin note for Razorpay sync', purchase.adminNote || '') || undefined;
    await runAction(async () => {
      const result = await EduService.syncAdminRazorpayPayment({
        paymentId: purchase.paymentId || undefined,
        transactionId: purchase.gatewayPaymentId || purchase.transactionId || undefined,
        orderId: purchase.gatewayOrderId || undefined,
        studentId: purchase.studentId || undefined,
        courseId: purchase.courseId || undefined,
        adminNote,
      });
      setLastSyncResult(result);
      if (result.diagnosis) {
        setDiagnosis(result.diagnosis);
      }
      setMessage(`Razorpay sync complete: ${result.summary.localStatus || 'pending'} • ${result.summary.courseAccessLabel || 'Buy Course'}`);
    });
  };

  const updateTransaction = async (transaction: AdminTransactionRecord) => {
    const status = window.prompt('Set payment status: paid / failed / pending / refunded', transaction.paymentStatus) || '';
    if (!status) return;
    const transactionId = window.prompt('Gateway payment / transaction ID', transaction.gatewayPaymentId || transaction.transactionId) || undefined;
    const adminNote = window.prompt('Admin note (optional)', '') || undefined;
    await runAction(async () => {
      await EduService.updateAdminTransaction(transaction.paymentId, { status, transactionId, adminNote });
      setMessage('Transaction updated.');
    });
  };

  const syncRazorpayForTransaction = async (transaction: AdminTransactionRecord) => {
    const adminNote = window.prompt('Admin note for Razorpay sync', '') || undefined;
    await runAction(async () => {
      const result = await EduService.syncAdminRazorpayPayment({
        paymentId: transaction.paymentId,
        transactionId: transaction.gatewayPaymentId || transaction.transactionId,
        orderId: transaction.gatewayOrderId || undefined,
        studentId: transaction.studentId || undefined,
        courseId: transaction.courseId || undefined,
        adminNote,
      });
      setLastSyncResult(result);
      if (result.diagnosis) {
        setDiagnosis(result.diagnosis);
      }
      setMessage(`Razorpay sync complete: ${result.summary.localStatus || 'pending'} • ${result.summary.courseAccessLabel || 'Buy Course'}`);
    });
  };

  const viewGatewayDetails = (transaction: AdminTransactionRecord) => {
    window.alert(JSON.stringify({
      paymentId: transaction.paymentId,
      localTransactionId: transaction.transactionId,
      gatewayOrderId: transaction.gatewayOrderId,
      gatewayPaymentId: transaction.gatewayPaymentId,
      gatewayStatus: transaction.gatewayStatus,
      paymentMethod: transaction.paymentMethod,
      bankRrn: transaction.bankRrn,
      signatureVerified: transaction.signatureVerified,
      gatewayResponse: transaction.paymentGatewayResponse,
    }, null, 2));
  };

  const syncAllPendingRazorpayPayments = async () => {
    const maxRecordsRaw = window.prompt('How many pending Razorpay payments should be checked?', '500') || '500';
    const adminNote = window.prompt('Admin note for bulk sync', 'Bulk sync for pending Razorpay payments') || undefined;
    const maxRecords = Number(maxRecordsRaw || 500);
    await runAction(async () => {
      const result = await EduService.syncAllAdminPendingRazorpayPayments({
        maxRecords: Number.isFinite(maxRecords) ? maxRecords : 500,
        adminNote,
      });
      setLastBulkSyncResult(result);
      setMessage(`Checked ${result.totalChecked} pending payments • fixed ${result.capturedFixed} captured • pending ${result.stillPending} • failed ${result.failed}`);
    });
  };

  const renderDashboard = () => {
    if (!dashboard) return null;
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        {[
          { label: 'Students', value: dashboard.totalStudents, icon: ShieldCheck },
          { label: 'Active access', value: dashboard.activeCourseAccessCount, icon: Wallet },
          { label: 'Successful payments', value: dashboard.successfulPayments, icon: Wallet },
          { label: 'Pending payments', value: dashboard.pendingPayments, icon: Wallet },
          { label: 'Watching now', value: dashboard.studentsCurrentlyWatchingVideos, icon: RefreshCw },
          { label: 'Playback sessions', value: dashboard.activePlaybackSessions, icon: RefreshCw },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-[22px] border border-[var(--line)] bg-white px-5 py-4 shadow-[0_10px_28px_rgba(15,23,42,0.05)]">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[var(--ink)]">{label}</p>
              <Icon className="h-4 w-4 text-[var(--accent-rust)]" />
            </div>
            <p className="mt-3 text-2xl font-semibold text-[var(--ink)]">{value}</p>
          </div>
        ))}
      </div>
    );
  };

  return (
    <section className="space-y-6">
      {renderDashboard()}

      <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h3 className="text-2xl font-semibold text-[var(--ink)]">
              {mode === 'students' ? 'Student management' : mode === 'purchases' ? 'Course purchases and access' : 'Transaction management'}
            </h3>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">
              {mode === 'students'
                ? 'Search students, inspect their access, and take account actions without exposing passwords.'
                : mode === 'purchases'
                  ? 'See payment, transaction, and access status in one place and repair paid-but-no-access issues safely.'
                  : 'Review payment history, update payment status carefully, and trace gateway details.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {mode === 'students' && (
              <button type="button" onClick={() => void createStudent()} disabled={actionBusy} className="inline-flex items-center gap-2 rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
                <UserPlus className="h-4 w-4" />
                Create Student
              </button>
            )}
            {mode === 'transactions' && (
              <button type="button" onClick={() => void syncAllPendingRazorpayPayments()} disabled={actionBusy || loading} className="inline-flex items-center gap-2 rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
                <RefreshCw className="h-4 w-4" />
                Sync All Pending Razorpay
              </button>
            )}
            <button type="button" onClick={() => void loadMode(pagination.page)} disabled={loading || actionBusy} className="inline-flex items-center gap-2 rounded-[16px] border border-[var(--line)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">
              {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </button>
          </div>
        </div>

        {message && (
          <div className="mt-5 rounded-[18px] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]">
            {message}
          </div>
        )}

        {mode === 'transactions' && lastBulkSyncResult && (
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              ['Checked', lastBulkSyncResult.totalChecked],
              ['Captured fixed', lastBulkSyncResult.capturedFixed],
              ['Still pending', lastBulkSyncResult.stillPending],
              ['Failed', lastBulkSyncResult.failed],
              ['Enrollments created', lastBulkSyncResult.enrollmentCreated],
              ['Access enabled', lastBulkSyncResult.accessEnabled],
              ['Cache refreshed', lastBulkSyncResult.cacheRefreshed],
              ['Errors', lastBulkSyncResult.errors.length],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-[18px] bg-[#f9fbff] px-4 py-3 text-sm">
                <p className="text-[var(--ink-soft)]">{label}</p>
                <p className="mt-1 font-semibold text-[var(--ink)]">{String(value)}</p>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 grid gap-3 lg:grid-cols-[1.2fr_0.75fr_0.75fr]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-soft)]" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === 'students' ? 'Search by name, email, or mobile' : 'Search by email, mobile, course, or transaction'} className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-[#f9fbff] pl-11 pr-4 text-sm text-[var(--ink)] outline-none" />
          </label>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-12 rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none">
            <option value="">All statuses</option>
            {mode === 'students' && (
              <>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
                <option value="blocked">Blocked</option>
              </>
            )}
            {mode !== 'students' && (
              <>
                <option value="success">Success</option>
                <option value="paid">Paid</option>
                <option value="failed">Failed</option>
                <option value="pending">Pending</option>
                <option value="refunded">Refunded</option>
              </>
            )}
          </select>
          {mode !== 'students' ? (
            <select value={courseFilter} onChange={(event) => setCourseFilter(event.target.value)} className="h-12 rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none">
              <option value="">All courses</option>
              {courses.map((course) => (
                <option key={course._id} value={course._id}>{course.title}</option>
              ))}
            </select>
          ) : (
            <div className="flex items-center rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink-soft)]">
              Page size: {pagination.pageSize}
            </div>
          )}
        </div>

        <div className="mt-6 overflow-x-auto">
          {mode === 'students' && (
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="px-3 py-3">Student</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Courses</th>
                  <th className="px-3 py-3">Attempts</th>
                  <th className="px-3 py-3">Last login</th>
                  <th className="px-3 py-3">Payments</th>
                  <th className="px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {students.map((student) => (
                  <tr key={student.studentId} className="border-t border-[var(--line)] align-top">
                    <td className="px-3 py-4">
                      <p className="font-semibold text-[var(--ink)]">{student.name}</p>
                      <p className="text-[var(--ink-soft)]">{student.email}</p>
                      <p className="text-[var(--ink-soft)]">{student.mobileNumber || 'No mobile'}</p>
                    </td>
                    <td className="px-3 py-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${statusPill(student.accountStatus)}`}>{student.accountStatus}</span>
                    </td>
                    <td className="px-3 py-4 text-[var(--ink)]">{student.enrolledCoursesCount}</td>
                    <td className="px-3 py-4 text-[var(--ink)]">{student.testAttemptsCount}</td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">{formatDateTime(student.lastLoginAt)}</td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">
                      S {student.paymentSummary.successful} / F {student.paymentSummary.failed} / P {student.paymentSummary.pending}
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void openStudent(student.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">View</button>
                        <button type="button" onClick={() => void updateStudentStatus(student.studentId, student.accountStatus === 'active' ? 'disabled' : 'active')} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Toggle</button>
                        <button type="button" onClick={() => void resetPassword(student.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Reset Password</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {mode === 'purchases' && (
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="px-3 py-3">Student</th>
                  <th className="px-3 py-3">Course</th>
                  <th className="px-3 py-3">Transaction</th>
                  <th className="px-3 py-3">Payment</th>
                  <th className="px-3 py-3">Access</th>
                  <th className="px-3 py-3">Validity</th>
                  <th className="px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((purchase) => (
                  <tr key={purchase.purchaseId} className="border-t border-[var(--line)] align-top">
                    <td className="px-3 py-4">
                      <p className="font-semibold text-[var(--ink)]">{purchase.studentName}</p>
                      <p className="text-[var(--ink-soft)]">{purchase.studentEmail || 'No email'}</p>
                      <p className="text-[var(--ink-soft)]">{purchase.studentMobile || 'No mobile'}</p>
                    </td>
                    <td className="px-3 py-4">
                      <p className="font-semibold text-[var(--ink)]">{purchase.courseName}</p>
                      <p className="text-[var(--ink-soft)]">{purchase.courseId || 'No course id'}</p>
                      <p className="text-[var(--ink-soft)]">Purchased {formatDateTime(purchase.purchaseDate)}</p>
                    </td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">
                      <p>{purchase.transactionId || 'Manual / none'}</p>
                      <p>Local payment: {purchase.paymentId || 'NA'}</p>
                      <p>Order: {purchase.gatewayOrderId || 'NA'}</p>
                      <p>Gateway: {purchase.gatewayPaymentId || 'NA'}</p>
                    </td>
                    <td className="px-3 py-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${statusPill(purchase.paymentStatus)}`}>{purchase.paymentStatus}</span>
                      <p className="mt-2 text-[var(--ink-soft)]">{purchase.paymentAmount != null ? currency.format(purchase.paymentAmount) : 'NA'}</p>
                      <p className="mt-1 text-[var(--ink-soft)]">Fee {purchase.courseFee != null ? currency.format(purchase.courseFee) : 'NA'}</p>
                    </td>
                    <td className="px-3 py-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${statusPill(purchase.accessStatus)}`}>{purchase.accessStatus}</span>
                      <p className="mt-2 text-[var(--ink-soft)]">Source {purchase.accessSource || 'payment'}</p>
                    </td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">{formatDateTime(purchase.validUntil)}</td>
                    <td className="px-3 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void updatePurchaseAccess(purchase, purchase.accessStatus === 'enabled' ? 'disabled' : 'enabled')} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Enable / Disable</button>
                        <button type="button" onClick={() => void extendValidity(purchase)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Extend</button>
                          <button type="button" onClick={() => void syncRazorpayForPurchase(purchase)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Sync Razorpay</button>
                          <button type="button" onClick={() => void diagnoseAccess(purchase)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Diagnose</button>
                        <button type="button" onClick={() => void repairAccess(purchase)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Repair Course Access</button>
                        <button type="button" onClick={() => void removeCourse(purchase)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Remove</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {mode === 'transactions' && (
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="px-3 py-3">Transaction</th>
                  <th className="px-3 py-3">Student</th>
                  <th className="px-3 py-3">Course</th>
                  <th className="px-3 py-3">Amount</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Gateway IDs</th>
                  <th className="px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((transaction) => (
                  <tr key={transaction.paymentId} className="border-t border-[var(--line)] align-top">
                    <td className="px-3 py-4">
                      <p className="font-semibold text-[var(--ink)]">{transaction.paymentId}</p>
                      <p className="text-[var(--ink-soft)]">Gateway txn: {transaction.gatewayPaymentId || 'NA'}</p>
                      <p className="text-[var(--ink-soft)]">{formatDateTime(transaction.paymentDateTime)}</p>
                    </td>
                    <td className="px-3 py-4">
                      <p className="font-semibold text-[var(--ink)]">{transaction.studentName}</p>
                      <p className="text-[var(--ink-soft)]">{transaction.studentEmail || 'No email'}</p>
                    </td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">{transaction.courseName || 'No course'}</td>
                    <td className="px-3 py-4 text-[var(--ink)]">{currency.format(transaction.amount || 0)}</td>
                    <td className="px-3 py-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${statusPill(transaction.paymentStatus)}`}>{transaction.paymentStatus}</span>
                      <p className="mt-2 text-[var(--ink-soft)]">Gateway {transaction.gatewayStatus || 'NA'}</p>
                      <p className="mt-1 text-[var(--ink-soft)]">Access {transaction.courseAccessLabel || transaction.accessStatus || 'NA'}</p>
                    </td>
                    <td className="px-3 py-4 text-[var(--ink-soft)]">
                      <p>Order: {transaction.gatewayOrderId || 'NA'}</p>
                      <p>Gateway: {transaction.gatewayPaymentId || 'NA'}</p>
                      <p>Method: {transaction.paymentMethod || 'NA'}</p>
                      <p>RRN: {transaction.bankRrn || 'NA'}</p>
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void syncRazorpayForTransaction(transaction)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Sync Razorpay</button>
                        {transaction.studentId && transaction.courseId && (
                          <button type="button" onClick={() => void repairAccess({
                            purchaseId: transaction.paymentId,
                            paymentId: transaction.paymentId,
                            studentId: transaction.studentId,
                            studentName: transaction.studentName,
                            studentEmail: transaction.studentEmail,
                            studentMobile: transaction.studentMobile,
                            courseId: transaction.courseId || null,
                            courseName: transaction.courseName || 'Course',
                            transactionId: transaction.gatewayPaymentId || transaction.transactionId,
                            paymentGatewayName: transaction.paymentMethod,
                            paymentAmount: transaction.amount,
                            paymentStatus: transaction.paymentStatus,
                            purchaseDate: transaction.paymentDateTime,
                            validUntil: transaction.validUntil,
                            accessStatus: transaction.accessStatus || 'disabled',
                            createdAt: transaction.paymentDateTime,
                            gatewayOrderId: transaction.gatewayOrderId,
                            gatewayPaymentId: transaction.gatewayPaymentId,
                          })} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Repair Access</button>
                        )}
                        <button type="button" onClick={() => viewGatewayDetails(transaction)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">View Gateway</button>
                        <button type="button" onClick={() => void updateTransaction(transaction)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Update</button>
                        {transaction.studentId && transaction.courseId && (
                          <button type="button" onClick={() => void assignCourse(transaction.studentId, transaction.courseId || undefined, transaction.gatewayPaymentId || transaction.gatewayOrderId || undefined)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Grant Access</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {!loading && ((mode === 'students' && students.length === 0) || (mode === 'purchases' && purchases.length === 0) || (mode === 'transactions' && transactions.length === 0)) && (
            <div className="rounded-[20px] border border-dashed border-[var(--line)] px-5 py-10 text-center text-sm text-[var(--ink-soft)]">
              No records match the current filters.
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-4">
          <p className="text-sm text-[var(--ink-soft)]">
            Page {pagination.page} of {pagination.totalPages} • {pagination.total} total records
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void loadMode(Math.max(1, pagination.page - 1))} disabled={pagination.page <= 1 || loading} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-50">Previous</button>
            <button type="button" onClick={() => void loadMode(Math.min(pagination.totalPages, pagination.page + 1))} disabled={pagination.page >= pagination.totalPages || loading} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>

      {mode === 'students' && selectedStudentId && (
        <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h4 className="text-xl font-semibold text-[var(--ink)]">
                {studentDetails?.student.name || 'Student details'}
              </h4>
              <p className="mt-1 text-sm text-[var(--ink-soft)]">
                {studentDetails?.student.email || 'Loading student details'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void assignCourse()} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)]">Assign Course</button>
              <button type="button" onClick={() => void runAction(async () => { await EduService.forceLogoutAdminStudent(selectedStudentId); setMessage('Student logged out from all sessions.'); })} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)]">Force Logout</button>
              <button type="button" onClick={() => void runAction(async () => { await EduService.clearAdminPlaybackSessions(selectedStudentId); setMessage('Playback sessions cleared.'); })} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)]">Clear Playback</button>
              <button type="button" onClick={() => void updateStudentStatus(selectedStudentId, 'blocked')} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)]">Block</button>
            </div>
          </div>

          {detailLoading && (
            <div className="mt-6 flex items-center gap-3 text-sm text-[var(--ink-soft)]">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading student profile
            </div>
          )}

          {studentDetails && !detailLoading && (
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              <div className="space-y-4">
                <div className="rounded-[20px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink-soft)]">
                  <p><span className="font-semibold text-[var(--ink)]">Account status:</span> {studentDetails.student.accountStatus}</p>
                  <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Last login:</span> {formatDateTime(studentDetails.student.lastLoginAt)}</p>
                  <p className="mt-2"><span className="font-semibold text-[var(--ink)]">Created:</span> {formatDateTime(studentDetails.student.created_at)}</p>
                </div>

                <div className="rounded-[20px] border border-[var(--line)] p-4">
                  <p className="text-sm font-semibold text-[var(--ink)]">Course access</p>
                  <div className="mt-3 space-y-3">
                    {studentDetails.purchases.slice(0, 8).map((purchase) => (
                      <div key={purchase.purchaseId} className="rounded-[16px] bg-[#f9fbff] p-3 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-semibold text-[var(--ink)]">{purchase.courseName}</p>
                          <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${statusPill(purchase.accessStatus)}`}>{purchase.accessStatus}</span>
                        </div>
                        <p className="mt-1 text-[var(--ink-soft)]">Transaction: {purchase.transactionId || 'Manual'}</p>
                        <p className="mt-1 text-[var(--ink-soft)]">Valid until: {formatDateTime(purchase.validUntil)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-[20px] border border-[var(--line)] p-4">
                  <p className="text-sm font-semibold text-[var(--ink)]">Video watch progress</p>
                  <div className="mt-3 space-y-3">
                    {studentDetails.watchProgress.slice(0, 8).map((entry) => {
                      const playbackAudit = getPlaybackAuditForWatch(studentDetails, entry);
                      return (
                        <div key={entry.stateId} className="rounded-[16px] bg-[#f9fbff] p-3 text-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold text-[var(--ink)]">{entry.courseTitle}</p>
                              <p className="mt-1 text-[var(--ink-soft)]">Video {entry.videoId}</p>
                              <p className="mt-1 text-[var(--ink-soft)]">
                                Watches {entry.completedFullWatches}/{entry.allowedFullWatches} • Last {formatDateTime(entry.lastHeartbeatAt || entry.updatedAt)}
                              </p>
                              <p className="mt-1 text-[var(--ink-soft)]">
                                Unique {formatSeconds(entry.totalUniqueWatchedSeconds)} • Cycle {formatSeconds(entry.currentCycleUniqueWatchedSeconds)} • Repeat {formatSeconds(entry.repeatWatchedSeconds)}
                              </p>
                              <p className="mt-1 text-[var(--ink-soft)]">
                                Position {formatSeconds(entry.progressSeconds)} • {entry.activeSessionStatus || 'idle'}{entry.locked ? ' • locked' : ''}{entry.ipAddress ? ` • ${entry.ipAddress}` : ''}
                              </p>
                              <p className="mt-1 text-[var(--ink-soft)]">
                                Completion proof {entry.completionProofSatisfied ? 'ready' : 'pending'} • Threshold {Math.round(Number(entry.completionThresholdPercentage || 0))}% • End buffer {formatSeconds(entry.stableEndWindowWatchedSeconds)}/{formatSeconds(entry.endStabilityWindowSeconds)}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button type="button" onClick={() => void repairWatchProgress(entry.stateId, 'completed_watches', 'Completed watch count reset.')} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--ink)]">Reset Count</button>
                              <button type="button" onClick={() => void repairWatchProgress(entry.stateId, 'grace_unlock', 'Grace replay unlocked.')} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--ink)]">Unlock Grace</button>
                              <button type="button" onClick={() => void repairWatchProgress(entry.stateId, 'full_reset', 'Watch progress fully reset.')} disabled={actionBusy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--ink)]">Full Reset</button>
                            </div>
                          </div>

                          {playbackAudit.length > 0 && (
                            <div className="mt-3 rounded-[14px] border border-[var(--line)] bg-white p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Recent playback evidence</p>
                              <div className="mt-2 space-y-2">
                                {playbackAudit.map((activity) => {
                                  const meta = activity.meta || {};
                                  const reasons = Array.isArray(meta.suspiciousReasons) ? meta.suspiciousReasons.join(', ') : '';
                                  return (
                                    <div key={activity._id} className="rounded-[12px] bg-[#f7f9fd] p-2 text-xs text-[var(--ink-soft)]">
                                      <p className="font-semibold text-[var(--ink)]">
                                        {activity.eventType.replace(/^video_playback_/, '').replace(/_/g, ' ')} • {formatDateTime(activity.createdAt)}
                                      </p>
                                      <p className="mt-1">
                                        {formatSeconds(meta.previousPositionSeconds as number)} to {formatSeconds(meta.currentPositionSeconds as number)}
                                        {' '}• {formatPlaybackRate(meta.playbackRate as number)}
                                        {' '}• {String(meta.reason || (reasons ? 'suspicious' : 'tracked'))}
                                      </p>
                                      <p className="mt-1">
                                        Counted {formatSeconds(meta.countableSeconds as number)}
                                        {' '}• Unique +{formatSeconds(meta.uniqueSecondsAdded as number)}
                                        {' '}• Repeat +{formatSeconds(meta.repeatSecondsAdded as number)}
                                        {reasons ? ` • ${reasons}` : ''}
                                      </p>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-[20px] border border-[var(--line)] p-4">
                  <p className="text-sm font-semibold text-[var(--ink)]">Test attempts</p>
                  <div className="mt-3 space-y-3">
                    {studentDetails.testAttempts.slice(0, 6).map((attempt) => (
                      <div key={attempt.attemptId} className="rounded-[16px] bg-[#f9fbff] p-3 text-sm">
                        <p className="font-semibold text-[var(--ink)]">{attempt.testName}</p>
                        <p className="mt-1 text-[var(--ink-soft)]">Score {attempt.score}/{attempt.totalMarks} • Correct {attempt.correctCount} • Wrong {attempt.wrongCount}</p>
                        <p className="mt-1 text-[var(--ink-soft)]">Submitted {formatDateTime(attempt.submittedAt)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-[20px] border border-[var(--line)] p-4">
                  <p className="text-sm font-semibold text-[var(--ink)]">Session and audit activity</p>
                  <div className="mt-3 space-y-3">
                    {studentDetails.auditLog.slice(0, 6).map((entry) => (
                      <div key={entry._id} className="rounded-[16px] bg-[#f9fbff] p-3 text-sm">
                        <p className="font-semibold text-[var(--ink)]">{entry.actionType}</p>
                        <p className="mt-1 text-[var(--ink-soft)]">{entry.reason || 'No reason provided'}</p>
                        <p className="mt-1 text-[var(--ink-soft)]">{formatDateTime(entry.createdAt)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {mode === 'purchases' && diagnosis && (
        <div className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
          <h4 className="text-xl font-semibold text-[var(--ink)]">Paid-but-no-access repair</h4>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">{diagnosis.studentName} • {diagnosis.courseName || diagnosis.courseId || 'Course'}</p>
          <div className="mt-5 grid gap-4 xl:grid-cols-4">
            <div className="rounded-[18px] bg-[#f9fbff] p-4 text-sm">
              <p className="font-semibold text-[var(--ink)]">Student</p>
              <p className="mt-2 text-[var(--ink-soft)]">ID: {diagnosis.studentId}</p>
              <p className="text-[var(--ink-soft)]">{diagnosis.studentEmail || 'No email'}</p>
              <p className="text-[var(--ink-soft)]">{diagnosis.studentMobile || 'No mobile'}</p>
              <p className="text-[var(--ink-soft)]">Status: {diagnosis.studentAccountStatus || 'active'}</p>
              <p className="text-[var(--ink-soft)]">Last login: {formatDateTime(diagnosis.studentLastLoginAt)}</p>
            </div>
            <div className="rounded-[18px] bg-[#f9fbff] p-4 text-sm">
              <p className="font-semibold text-[var(--ink)]">Purchase</p>
              <p className="mt-2 text-[var(--ink-soft)]">Course: {diagnosis.courseName || 'Unknown course'}</p>
              <p className="text-[var(--ink-soft)]">Course ID: {diagnosis.courseId || 'NA'}</p>
              <p className="text-[var(--ink-soft)]">Payment status: {diagnosis.payment?.status || 'NA'}</p>
              <p className="text-[var(--ink-soft)]">Amount: {diagnosis.payment?.amount != null ? currency.format(diagnosis.payment.amount) : 'NA'}</p>
              <p className="text-[var(--ink-soft)]">Source: {diagnosis.enrollment?.source || 'payment'}</p>
            </div>
            <div className="rounded-[18px] bg-[#f9fbff] p-4 text-sm">
              <p className="font-semibold text-[var(--ink)]">Transaction</p>
              <p className="mt-2 text-[var(--ink-soft)]">Transaction ID: {diagnosis.payment?.transactionId || 'NA'}</p>
              <p className="text-[var(--ink-soft)]">Order ID: {diagnosis.payment?.providerOrderId || 'NA'}</p>
              <p className="text-[var(--ink-soft)]">Gateway status: {diagnosis.payment?.status || 'NA'}</p>
              <p className="text-[var(--ink-soft)]">Verification: {diagnosis.paymentSuccess ? 'Verified/paid' : 'Not verified'}</p>
            </div>
            <div className="rounded-[18px] bg-[#f9fbff] p-4 text-sm">
              <p className="font-semibold text-[var(--ink)]">Student app</p>
              <p className="mt-2 text-[var(--ink-soft)]">Should show Buy: {diagnosis.shouldShowBuyButton ? 'Yes' : 'No'}</p>
              <p className="text-[var(--ink-soft)]">Should show Start Course: {diagnosis.shouldShowStartCourse ? 'Yes' : 'No'}</p>
              <p className="text-[var(--ink-soft)]">Access label: {diagnosis.courseAccessLabel || 'Buy'}</p>
              <p className="text-[var(--ink-soft)]">Block reason: {diagnosis.accessBlockReason || 'No block detected'}</p>
            </div>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              ['Payment success', diagnosis.paymentSuccess],
              ['Enrollment exists', diagnosis.enrollmentExists],
              ['Access enabled', diagnosis.accessEnabled],
              ['Validity active', diagnosis.validityActive],
              ['Course ID matched', diagnosis.courseIdMatched],
              ['User ID matched', diagnosis.userIdMatched],
              ['Student should see Start Course', diagnosis.shouldShowStartCourse],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-[18px] bg-[#f9fbff] px-4 py-3 text-sm">
                <p className="text-[var(--ink-soft)]">{label}</p>
                <p className="mt-1 font-semibold text-[var(--ink)]">{value ? 'Yes' : 'No'}</p>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-[18px] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink-soft)]">
            {diagnosis.accessBlockReason || 'No blocking access issue detected.'}
          </div>
          {diagnosis.duplicateAccounts.length > 0 && (
            <div className="mt-4 rounded-[18px] border border-[var(--line)] p-4 text-sm text-[var(--ink-soft)]">
              <p className="font-semibold text-[var(--ink)]">Duplicate accounts to review</p>
              <div className="mt-2 space-y-2">
                {diagnosis.duplicateAccounts.map((entry) => (
                  <p key={entry.studentId}>{entry.name} • {entry.email} • {entry.mobileNumber || 'No mobile'} • {entry.studentId}</p>
                ))}
              </div>
            </div>
          )}
          {repairResult && (
            <div className="mt-5 rounded-[20px] border border-[var(--line)] bg-white p-4">
              <p className="text-sm font-semibold text-[var(--ink)]">Repair result</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {[
                  ['Payment found', repairResult.repairSummary.paymentFound ? 'Yes' : 'No'],
                  ['Transaction ID', repairResult.repairSummary.transactionId || 'NA'],
                  ['Course', repairResult.repairSummary.courseName || 'NA'],
                  ['Enrollment created', repairResult.repairSummary.enrollmentCreated ? 'Yes' : 'No'],
                  ['Access enabled', repairResult.repairSummary.accessEnabled ? 'Yes' : 'No'],
                  ['Validity updated', repairResult.repairSummary.validityUpdated ? 'Yes' : 'No'],
                  ['Cache refreshed', repairResult.repairSummary.cacheRefreshed ? 'Yes' : 'No'],
                  ['Final access status', repairResult.repairSummary.finalAccessStatus],
                  ['Student should now see', repairResult.repairSummary.studentShouldNowSee],
                  ['Repair note', repairResult.repairSummary.repairNote || 'NA'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-[16px] bg-[#f9fbff] px-4 py-3 text-sm">
                    <p className="text-[var(--ink-soft)]">{label}</p>
                    <p className="mt-1 font-semibold text-[var(--ink)]">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {lastSyncResult && (
            <div className="mt-5 rounded-[20px] border border-[var(--line)] bg-white p-4">
              <p className="text-sm font-semibold text-[var(--ink)]">Razorpay sync result</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {[
                  ['Payment found', lastSyncResult.summary.paymentFound ? 'Yes' : 'No'],
                  ['Transaction ID', lastSyncResult.summary.transactionId || 'NA'],
                  ['Order ID', lastSyncResult.summary.orderId || 'NA'],
                  ['Gateway status', lastSyncResult.summary.gatewayStatus || 'NA'],
                  ['Local status', lastSyncResult.summary.localStatus || 'NA'],
                  ['Method', lastSyncResult.summary.method || 'NA'],
                  ['Bank RRN', lastSyncResult.summary.bankRrn || 'NA'],
                  ['Enrollment created', lastSyncResult.summary.enrollmentCreated ? 'Yes' : 'No'],
                  ['Access enabled', lastSyncResult.summary.accessEnabled ? 'Yes' : 'No'],
                  ['Validity updated', lastSyncResult.summary.validityUpdated ? 'Yes' : 'No'],
                  ['Cache refreshed', lastSyncResult.summary.cacheRefreshed ? 'Yes' : 'No'],
                  ['Student should see', lastSyncResult.summary.courseAccessLabel || 'NA'],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-[16px] bg-[#f9fbff] px-4 py-3 text-sm">
                    <p className="text-[var(--ink-soft)]">{label}</p>
                    <p className="mt-1 font-semibold text-[var(--ink)]">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
