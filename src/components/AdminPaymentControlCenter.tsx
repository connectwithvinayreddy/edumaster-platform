import React, { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, Search, ShieldCheck, UserCircle2, Wallet } from 'lucide-react';
import { EduService } from '../EduService';
import {
  AdminAuditLogRecord,
  AdminBulkRazorpaySyncResult,
  AdminCourseAccessRecord,
  AdminCourseAccessSummary,
  AdminDashboardSummary,
  AdminLoginSessionRecord,
  AdminLoginSessionSummary,
  AdminManualReviewRecord,
  AdminManualReviewSummary,
  AdminPagination,
  AdminPaymentRangeParams,
  AdminPaymentReconciliationReport,
  AdminStudentDetails,
  AdminStudentLiveMetricsSummary,
  AdminStudentSummary,
  AdminSystemHealthSummary,
  AdminTransactionRecord,
  CourseCard,
} from '../types';

export type AdminControlCenterSection =
  | 'overview'
  | 'students'
  | 'login-sessions'
  | 'payments'
  | 'course-access'
  | 'manual-review'
  | 'system-health'
  | 'audit-logs';

interface AdminPaymentControlCenterProps {
  section: AdminControlCenterSection;
  courses: CourseCard[];
}

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const emptyPagination: AdminPagination = { page: 1, pageSize: 25, total: 0, totalPages: 1 };
const todayDateInput = new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
const buildSectionStorageKey = (section: AdminControlCenterSection) => `edumaster.admin.control-center.${section}`;

type AdminActionDialogMode =
  | 'grant-access'
  | 'revoke-access'
  | 'extend-validity'
  | 'disable-access'
  | 'repair-access'
  | 'sync-payment'
  | 'manual-review'
  | 'block-student'
  | 'reset-password'
  | 'bulk-sync';

type AdminActionDialogState = {
  mode: AdminActionDialogMode;
  studentId?: string | null;
  studentLabel?: string;
  courseId?: string | null;
  courseLabel?: string;
  reference?: string | null;
  currentValidity?: string | null;
  paymentId?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  transactionId?: string | null;
  nextStatus?: 'blocked' | 'active';
};

type AdminActionFormState = {
  courseId: string;
  validUntil: string;
  note: string;
  password: string;
  maxRecords: string;
};

type AdminStudentQuickFilter = 'all' | 'verified-paid' | 'online' | 'active-access' | 'needs-review';
type AdminStudentSortBy = 'newest' | 'name' | 'online-first' | 'verified-payments' | 'active-access';

const formatDateTime = (value?: string | null) => {
  if (!value) return 'NA';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'NA';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

const toDateTimeInputValue = (value?: string | null) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
};

const toIsoDateTime = (value?: string) => {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

const pillClass = (value?: string | null) => {
  const normalized = String(value || '').toLowerCase();
  if (['active', 'enabled', 'success', 'paid', 'online', 'verified_captured_activated', 'ok', 'up', 'matched'].includes(normalized)) {
    return 'bg-[var(--success-soft)] text-[var(--success)]';
  }
  if (['pending', 'pending_access', 'gateway_pending'].includes(normalized)) {
    return 'bg-[#fff6dd] text-[#9a6b00]';
  }
  if (['failed', 'disabled', 'expired', 'offline', 'blocked', 'degraded', 'down', 'refunded_or_chargeback'].includes(normalized)) {
    return 'bg-[#fff0f0] text-[#c94b4b]';
  }
  if (['manual_review_required', 'amount_mismatch', 'order_mismatch', 'user_mismatch', 'course_mismatch', 'local_transaction_not_found', 'refunded'].includes(normalized)) {
    return 'bg-[#fff1f3] text-[#b42344]';
  }
  return 'bg-slate-100 text-slate-600';
};

const StatusPill = ({ value }: { value?: string | null }) => (
  <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${pillClass(value)}`}>{value || 'NA'}</span>
);

const SectionCard = ({
  title,
  value,
  hint,
  icon: Icon,
  onClick,
  selected = false,
}: {
  title: string;
  value: string | number;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  selected?: boolean;
}) => (
  <div
    onClick={onClick}
    className={`rounded-[22px] border bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)] ${selected ? 'border-[var(--ink)]' : 'border-[var(--line)]'} ${onClick ? 'cursor-pointer transition hover:-translate-y-[1px] hover:border-[var(--ink-soft)]' : ''}`}
    role={onClick ? 'button' : undefined}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick();
      }
    } : undefined}
  >
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-soft)]">{title}</p>
        <p className="mt-2 text-2xl font-semibold text-[var(--ink)]">{value}</p>
      </div>
      <div className="rounded-[16px] bg-[var(--accent-cream)] p-3 text-[var(--ink)]">
        <Icon className="h-5 w-5" />
      </div>
    </div>
    <p className="mt-3 text-sm text-[var(--ink-soft)]">{hint}</p>
  </div>
);

const ActionMenu: React.FC<{
  label?: string;
  children: React.ReactNode;
}> = ({ label = 'Manage', children }) => (
  <details className="group relative">
    <summary className="list-none cursor-pointer rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)] transition hover:bg-[#f7faff]">
      {label}
    </summary>
    <div className="absolute right-0 z-20 mt-2 flex min-w-[220px] flex-col gap-2 rounded-[16px] border border-[var(--line)] bg-white p-3 shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
      {children}
    </div>
  </details>
);

export const AdminPaymentControlCenter: React.FC<AdminPaymentControlCenterProps> = ({ section, courses }) => {
  const storedState = (() => {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      const raw = window.sessionStorage.getItem(buildSectionStorageKey(section));
      return raw ? JSON.parse(raw) as Partial<{
        search: string;
        statusFilter: string;
        paymentRangePreset: AdminPaymentRangeParams['rangePreset'];
        customStartDate: string;
        customEndDate: string;
      }> : null;
    } catch {
      return null;
    }
  })();
  const [dashboard, setDashboard] = useState<AdminDashboardSummary | null>(null);
  const [studentLiveMetrics, setStudentLiveMetrics] = useState<AdminStudentLiveMetricsSummary | null>(null);
  const [paymentReconciliation, setPaymentReconciliation] = useState<AdminPaymentReconciliationReport | null>(null);
  const [students, setStudents] = useState<AdminStudentSummary[]>([]);
  const [studentDetails, setStudentDetails] = useState<AdminStudentDetails | null>(null);
  const [loginSummary, setLoginSummary] = useState<AdminLoginSessionSummary | null>(null);
  const [loginSessions, setLoginSessions] = useState<AdminLoginSessionRecord[]>([]);
  const [payments, setPayments] = useState<AdminTransactionRecord[]>([]);
  const [courseAccessSummary, setCourseAccessSummary] = useState<AdminCourseAccessSummary | null>(null);
  const [courseAccess, setCourseAccess] = useState<AdminCourseAccessRecord[]>([]);
  const [manualReviewSummary, setManualReviewSummary] = useState<AdminManualReviewSummary | null>(null);
  const [manualReviewItems, setManualReviewItems] = useState<AdminManualReviewRecord[]>([]);
  const [systemHealth, setSystemHealth] = useState<AdminSystemHealthSummary | null>(null);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLogRecord[]>([]);
  const [bulkSyncResult, setBulkSyncResult] = useState<AdminBulkRazorpaySyncResult | null>(null);
  const [pagination, setPagination] = useState<AdminPagination>(emptyPagination);
  const [search, setSearch] = useState(storedState?.search || '');
  const [searchInput, setSearchInput] = useState(storedState?.search || '');
  const [statusFilter, setStatusFilter] = useState(storedState?.statusFilter || '');
  const [paymentRangePreset, setPaymentRangePreset] = useState<AdminPaymentRangeParams['rangePreset']>(storedState?.paymentRangePreset || 'today');
  const [customStartDate, setCustomStartDate] = useState(storedState?.customStartDate || todayDateInput);
  const [customEndDate, setCustomEndDate] = useState(storedState?.customEndDate || todayDateInput);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [studentQuickFilter, setStudentQuickFilter] = useState<AdminStudentQuickFilter>('all');
  const [studentSortBy, setStudentSortBy] = useState<AdminStudentSortBy>('newest');
  const [actionDialog, setActionDialog] = useState<AdminActionDialogState | null>(null);
  const [actionForm, setActionForm] = useState<AdminActionFormState>({
    courseId: '',
    validUntil: '',
    note: '',
    password: '',
    maxRecords: '500',
  });
  const autoRefreshPaused = Boolean(
    searchInput.trim()
    || search.trim()
    || statusFilter
    || studentDetails
    || actionDialog,
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.sessionStorage.setItem(buildSectionStorageKey(section), JSON.stringify({
      search,
      statusFilter,
      paymentRangePreset,
      customStartDate,
      customEndDate,
    }));
  }, [section, search, statusFilter, paymentRangePreset, customStartDate, customEndDate]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearch(searchInput);
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  const paymentRangeParams: AdminPaymentRangeParams = {
    rangePreset: paymentRangePreset,
    timezone: 'Asia/Kolkata',
    ...(paymentRangePreset === 'custom' ? {
      startDate: customStartDate,
      endDate: customEndDate,
    } : {}),
  };

  const refreshDashboard = async () => {
    try {
      const summary = await EduService.getAdminDashboard(paymentRangeParams);
      setDashboard(summary);
      setStudentLiveMetrics((current) => current || {
        onlineNow: summary.loggedInStudentsNow || 0,
        loggedOutToday: summary.loggedOutStudentsToday || 0,
        activeNow: summary.activeStudentsNow || 0,
        refreshedAt: new Date().toISOString(),
      });
    } catch {
      // Keep the control center usable even if summary metrics fail.
    }
  };

  const refreshStudentLiveMetrics = async () => {
    try {
      setStudentLiveMetrics(await EduService.getAdminStudentLiveMetrics());
    } catch {
      // Keep the list stable even if live metrics are temporarily unavailable.
    }
  };

  const refreshPaymentReconciliation = async () => {
    try {
      setPaymentReconciliation(await EduService.getAdminPaymentReconciliation(paymentRangeParams));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to reconcile with Razorpay right now.');
    }
  };

  const loadSection = async (page = 1) => {
    setLoading(true);
    setMessage(null);
    try {
      if (section === 'students') {
        const result = await EduService.listAdminStudents({
          page,
          pageSize: pagination.pageSize || 25,
          search,
          status: statusFilter,
          quickFilter: studentQuickFilter,
          sortBy: studentSortBy,
        });
        setStudents(result.items);
        setPagination(result.pagination);
      } else if (section === 'login-sessions') {
        const result = await EduService.listAdminLoginSessions({ page, pageSize: pagination.pageSize || 25, search, status: statusFilter });
        setLoginSummary(result.summary);
        setLoginSessions(result.items);
        setPagination(result.pagination);
      } else if (section === 'payments') {
        const result = await EduService.listAdminTransactions({ ...paymentRangeParams, page, pageSize: pagination.pageSize || 25, search, paymentStatus: statusFilter });
        setPayments(result.items);
        setPagination(result.pagination);
      } else if (section === 'course-access') {
        const result = await EduService.listAdminCourseAccess({ page, pageSize: pagination.pageSize || 25, search, accessStatus: statusFilter });
        setCourseAccessSummary(result.summary);
        setCourseAccess(result.items);
        setPagination(result.pagination);
      } else if (section === 'manual-review') {
        const result = await EduService.listAdminManualReviewQueue({ page, pageSize: pagination.pageSize || 25, search });
        setManualReviewSummary(result.summary);
        setManualReviewItems(result.items);
        setPagination(result.pagination);
      } else if (section === 'system-health') {
        setSystemHealth(await EduService.getAdminSystemHealth());
        setPagination(emptyPagination);
      } else if (section === 'audit-logs') {
        const result = await EduService.listAdminAuditLogs({ page, pageSize: pagination.pageSize || 25, search, actionType: statusFilter });
        setAuditLogs(result.items);
        setPagination(result.pagination);
      } else {
        setPagination(emptyPagination);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load admin data right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPagination((current) => ({ ...emptyPagination, pageSize: current.pageSize || 25 }));
    setSearch('');
    setSearchInput('');
    setStatusFilter('');
    setStudentQuickFilter('all');
    setStudentSortBy('newest');
    setStudentDetails(null);
    setBulkSyncResult(null);
    void Promise.all([
      refreshDashboard(),
      section === 'overview' || section === 'payments' ? refreshPaymentReconciliation() : Promise.resolve(),
    ]);
  }, [section]);

  useEffect(() => {
    void loadSection(1);
  }, [section, search, statusFilter, paymentRangePreset, customStartDate, customEndDate]);

  useEffect(() => {
    if (section !== 'students') {
      return;
    }
    void loadSection(1);
  }, [studentQuickFilter, studentSortBy]);

  useEffect(() => {
    void refreshDashboard();
    if (section === 'overview' || section === 'payments') {
      void refreshPaymentReconciliation();
    }
  }, [paymentRangePreset, customStartDate, customEndDate]);

  useEffect(() => {
    if (typeof window === 'undefined' || section !== 'students' || autoRefreshPaused) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      if (busy || loading) {
        return;
      }
      void refreshStudentLiveMetrics();
    }, 10000);
    return () => window.clearInterval(intervalId);
  }, [section, busy, loading, autoRefreshPaused]);

  useEffect(() => {
    if (typeof window === 'undefined' || section !== 'login-sessions' || autoRefreshPaused) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      if (busy || loading) {
        return;
      }
      void Promise.all([
        refreshDashboard(),
        loadSection(pagination.page || 1),
      ]);
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [section, pagination.page, busy, loading, autoRefreshPaused]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await Promise.all([
        refreshDashboard(),
        loadSection(pagination.page || 1),
        section === 'overview' || section === 'payments' ? refreshPaymentReconciliation() : Promise.resolve(),
      ]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Admin action failed.');
    } finally {
      setBusy(false);
    }
  };

  const openStudent = async (studentId: string) => {
    try {
      setStudentDetails(await EduService.getAdminStudentDetails(studentId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load student details.');
    }
  };

  const updateActionForm = <K extends keyof AdminActionFormState>(key: K, value: AdminActionFormState[K]) => {
    setActionForm((current) => ({ ...current, [key]: value }));
  };

  const openActionDialog = (dialog: AdminActionDialogState, overrides: Partial<AdminActionFormState> = {}) => {
    setActionForm({
      courseId: dialog.courseId || '',
      validUntil: toDateTimeInputValue(dialog.currentValidity),
      note: dialog.reference ? `Payment reference: ${dialog.reference}` : '',
      password: '',
      maxRecords: '500',
      ...overrides,
    });
    setActionDialog(dialog);
  };

  const closeActionDialog = () => {
    if (busy) return;
    setActionDialog(null);
  };

  const confirmAction = (messageText: string) => {
    if (typeof window === 'undefined') {
      return true;
    }
    return window.confirm(messageText);
  };

  const forceLogoutStudent = async (studentId: string) => runAction(async () => {
    if (!confirmAction('Force logout this student now?')) {
      return;
    }
    await EduService.forceLogoutAdminStudent(studentId);
    setMessage('Student was logged out successfully.');
  });

  const manageStudentContentAccess = async (studentId: string, studentLabel: string, courseId?: string | null, courseLabel?: string | null) => runAction(async () => {
    if (!courseId) {
      throw new Error('Choose a course first before managing student content access.');
    }
    const course = courses.find((entry) => entry._id === courseId) || null;
    if (!course) {
      throw new Error('Course details are not loaded in the admin workspace.');
    }
    const scope = String(window.prompt(`Access scope for ${studentLabel} in ${courseLabel || course.title}: course, chapter, or lesson`, 'lesson') || '').trim().toLowerCase();
    if (!['course', 'chapter', 'lesson'].includes(scope)) {
      throw new Error('Enter course, chapter, or lesson.');
    }
    let chapterId = '';
    let lessonId = '';
    let moduleId = '';
    if (scope === 'chapter') {
      const chapterOptions = (course.modules || []).flatMap((module) => (module.chapters || []).map((chapter) => `${chapter.id} -> ${module.title} • ${chapter.title}`));
      chapterId = String(window.prompt(`Enter chapter ID.\n\n${chapterOptions.join('\n')}`, '') || '').trim();
      if (!chapterId) {
        throw new Error('Chapter ID is required.');
      }
    }
    if (scope === 'lesson') {
      const lessonOptions = (course.modules || []).flatMap((module) => [
        ...(module.lessons || []).map((lesson) => `${lesson.id} -> ${module.title} • ${lesson.title}`),
        ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => `${lesson.id} -> ${module.title} • ${chapter.title} • ${lesson.title}`))),
      ]);
      lessonId = String(window.prompt(`Enter lesson ID.\n\n${lessonOptions.join('\n')}`, '') || '').trim();
      if (!lessonId) {
        throw new Error('Lesson ID is required.');
      }
      for (const module of course.modules || []) {
        const directLesson = (module.lessons || []).find((lesson) => lesson.id === lessonId);
        if (directLesson) {
          moduleId = module.id;
          break;
        }
        for (const chapter of module.chapters || []) {
          const chapterLesson = (chapter.lessons || []).find((lesson) => lesson.id === lessonId);
          if (chapterLesson) {
            moduleId = module.id;
            chapterId = chapter.id;
            break;
          }
        }
        if (moduleId) {
          break;
        }
      }
    }
    const access = String(window.prompt('Access action: allow or block', 'allow') || '').trim().toLowerCase();
    if (!['allow', 'block'].includes(access)) {
      throw new Error('Enter allow or block.');
    }
    const adminNote = String(window.prompt('Optional admin note shown when blocked', '') || '').trim();
    await EduService.upsertAdminCourseAccessRule({
      courseId,
      studentScope: 'student',
      studentId,
      contentScope: scope,
      moduleId: moduleId || undefined,
      chapterId: chapterId || undefined,
      lessonId: lessonId || undefined,
      access,
      adminNote: adminNote || undefined,
    });
    setMessage('Student content access rule saved.');
  });

  const manageStudentWatchOverride = async (studentId: string, studentLabel: string, courseId?: string | null, courseLabel?: string | null) => runAction(async () => {
    if (!courseId) {
      throw new Error('Choose a course first before managing student watch overrides.');
    }
    const course = courses.find((entry) => entry._id === courseId) || null;
    if (!course) {
      throw new Error('Course details are not loaded in the admin workspace.');
    }
    const scope = String(window.prompt(`Watch override scope for ${studentLabel} in ${courseLabel || course.title}: lesson, chapter, or course`, 'lesson') || '').trim().toLowerCase();
    if (!['lesson', 'chapter', 'course'].includes(scope)) {
      throw new Error('Enter lesson, chapter, or course.');
    }
    const allowedFullWatches = Number(window.prompt('Allowed full watches', '3') || '0');
    if (!Number.isFinite(allowedFullWatches) || allowedFullWatches < 1) {
      throw new Error('Allowed full watches must be 1 or more.');
    }
    const watchCompletionPercentRaw = String(window.prompt('Completion threshold percentage (50-100, optional)', '90') || '').trim();
    const watchCompletionPercent = watchCompletionPercentRaw ? Number(watchCompletionPercentRaw) : undefined;
    let chapterId = '';
    let lessonId = '';
    let moduleId = '';
    if (scope === 'chapter') {
      const chapterOptions = (course.modules || []).flatMap((module) => (module.chapters || []).map((chapter) => `${chapter.id} -> ${module.title} • ${chapter.title}`));
      chapterId = String(window.prompt(`Enter chapter ID.\n\n${chapterOptions.join('\n')}`, '') || '').trim();
      if (!chapterId) {
        throw new Error('Chapter ID is required.');
      }
    }
    if (scope === 'lesson') {
      const lessonOptions = (course.modules || []).flatMap((module) => [
        ...(module.lessons || []).map((lesson) => `${lesson.id} -> ${module.title} • ${lesson.title}`),
        ...((module.chapters || []).flatMap((chapter) => (chapter.lessons || []).map((lesson) => `${lesson.id} -> ${module.title} • ${chapter.title} • ${lesson.title}`))),
      ]);
      lessonId = String(window.prompt(`Enter lesson ID.\n\n${lessonOptions.join('\n')}`, '') || '').trim();
      if (!lessonId) {
        throw new Error('Lesson ID is required.');
      }
      for (const module of course.modules || []) {
        const directLesson = (module.lessons || []).find((lesson) => lesson.id === lessonId);
        if (directLesson) {
          moduleId = module.id;
          break;
        }
        for (const chapter of module.chapters || []) {
          const chapterLesson = (chapter.lessons || []).find((lesson) => lesson.id === lessonId);
          if (chapterLesson) {
            moduleId = module.id;
            chapterId = chapter.id;
            break;
          }
        }
        if (moduleId) {
          break;
        }
      }
    }
    const adminNote = String(window.prompt('Optional admin note for this watch override', '') || '').trim();
    await EduService.upsertAdminStudentLessonWatchOverride({
      courseId,
      studentId,
      moduleId: moduleId || undefined,
      chapterId: chapterId || undefined,
      lessonId: lessonId || undefined,
      bulkScope: scope === 'course' || scope === 'chapter' ? scope : undefined,
      allowedFullWatches,
      watchCompletionPercent: Number.isFinite(Number(watchCompletionPercent)) ? watchCompletionPercent : undefined,
      adminNote: adminNote || undefined,
    });
    setMessage('Student watch override saved.');
  });

  const submitActionDialog = async () => {
    if (!actionDialog) return;
    const resolvedStudentId = actionDialog.studentId || studentDetails?.student?._id || null;
    const resolvedCourseId = actionForm.courseId || actionDialog.courseId || null;
    await runAction(async () => {
      if (actionDialog.mode === 'block-student') {
        if (!resolvedStudentId || !actionDialog.nextStatus) return;
        await EduService.updateAdminStudentStatus(resolvedStudentId, {
          status: actionDialog.nextStatus,
          note: actionForm.note || undefined,
        });
        setMessage(`Student marked ${actionDialog.nextStatus}.`);
      } else if (actionDialog.mode === 'reset-password') {
        if (!resolvedStudentId || !actionForm.password) {
          throw new Error('Enter a new password before submitting.');
        }
        await EduService.resetAdminStudentPassword(resolvedStudentId, {
          newPassword: actionForm.password,
          reason: actionForm.note || 'Admin reset from payment control center',
        });
        setMessage('Password reset completed.');
      } else if (actionDialog.mode === 'grant-access') {
        if (!resolvedStudentId || !resolvedCourseId) {
          throw new Error('Choose the course to grant before submitting.');
        }
        await EduService.assignAdminCourse({
          studentId: resolvedStudentId,
          courseId: resolvedCourseId,
          validUntil: toIsoDateTime(actionForm.validUntil),
          adminNote: actionForm.note || undefined,
        });
        setMessage('Manual course access granted.');
      } else if (actionDialog.mode === 'revoke-access') {
        if (!resolvedStudentId || !resolvedCourseId) return;
        await EduService.removeAdminCourseAccess({
          studentId: resolvedStudentId,
          courseId: resolvedCourseId,
          adminNote: actionForm.note || undefined,
        });
        setMessage('Course access revoked.');
      } else if (actionDialog.mode === 'extend-validity') {
        if (!resolvedStudentId || !resolvedCourseId) return;
        const validUntil = toIsoDateTime(actionForm.validUntil);
        if (!validUntil) {
          throw new Error('Choose the new expiry date and time before submitting.');
        }
        const purchases = await EduService.listAdminPurchases({ page: 1, pageSize: 100, studentId: resolvedStudentId, courseId: resolvedCourseId });
        const purchase = purchases.items[0];
        if (!purchase) {
          throw new Error('No purchase/access record found for this student and course.');
        }
        await EduService.updateAdminPurchase(purchase.purchaseId, {
          validUntil,
          adminNote: actionForm.note || 'Validity extended from admin payment control center',
        });
        setMessage('Access validity updated.');
      } else if (actionDialog.mode === 'disable-access') {
        if (!resolvedStudentId || !resolvedCourseId) return;
        const purchases = await EduService.listAdminPurchases({ page: 1, pageSize: 100, studentId: resolvedStudentId, courseId: resolvedCourseId });
        const purchase = purchases.items[0];
        if (!purchase) {
          throw new Error('No purchase/access record found for this student and course.');
        }
        await EduService.updateAdminPurchase(purchase.purchaseId, {
          accessStatus: 'disabled',
          adminNote: actionForm.note || 'Access disabled from admin payment control center',
        });
        setMessage('Access disabled.');
      } else if (actionDialog.mode === 'repair-access') {
        if (!resolvedStudentId) return;
        await EduService.repairAdminCourseAccess({
          studentId: resolvedStudentId,
          courseId: resolvedCourseId || undefined,
          transactionId: actionDialog.transactionId || undefined,
          adminNote: actionForm.note || undefined,
        });
        setMessage('Access repair completed.');
      } else if (actionDialog.mode === 'sync-payment') {
        await EduService.syncAdminRazorpayPayment({
          paymentId: actionDialog.paymentId || undefined,
          transactionId: actionDialog.gatewayPaymentId || undefined,
          orderId: actionDialog.gatewayOrderId || undefined,
          studentId: resolvedStudentId || undefined,
          courseId: resolvedCourseId || undefined,
          adminNote: actionForm.note || undefined,
        });
        setMessage('Single Razorpay sync completed.');
      } else if (actionDialog.mode === 'manual-review') {
        if (!actionDialog.paymentId) return;
        await EduService.updateAdminTransaction(actionDialog.paymentId, {
          manualReviewRequired: true,
          verificationDecision: 'MANUAL_REVIEW_REQUIRED',
          verificationReason: actionForm.note || 'Flagged for manual review',
          adminNote: actionForm.note || 'Flagged for manual review',
        });
        setMessage('Payment moved to manual review.');
      } else if (actionDialog.mode === 'bulk-sync') {
        const maxRecords = Number(actionForm.maxRecords || '500');
        const result = await EduService.syncAllAdminPendingRazorpayPayments({
          maxRecords: Number.isFinite(maxRecords) ? maxRecords : 500,
          adminNote: actionForm.note || undefined,
        });
        setBulkSyncResult(result);
        setMessage(`Bulk sync checked ${result.totalChecked} payments.`);
      }
      setActionDialog(null);
    });
  };

  const approveManualGrant = async (item: AdminManualReviewRecord) => {
    if (!confirmAction('Approve this review with a manual access grant?')) {
      return;
    }
    await runAction(async () => {
      await EduService.assignAdminCourse({
        studentId: item.studentId,
        courseId: item.courseId || '',
        adminNote: `Manual review approval. Payment reference: ${item.razorpayPaymentId || item.localOrderId}`,
      });
      await EduService.updateAdminTransaction(item.paymentId, {
        manualReviewRequired: false,
        verificationDecision: item.verificationDecision || 'MANUAL_REVIEW_REQUIRED',
        verificationReason: 'Manual access granted by admin after review',
        adminNote: 'Manual access granted by admin after review',
      });
      setMessage('Manual review approved with manual access grant.');
    });
  };

  const paymentOverview = dashboard?.paymentOverview;
  const displayedStudents = students;
  const dialogCourseOptions = courses
    .map((course) => ({ id: course._id, title: course.title }))
    .sort((left, right) => left.title.localeCompare(right.title));
  const selectedDialogCourseLabel = actionDialog?.courseLabel
    || dialogCourseOptions.find((course) => course.id === actionForm.courseId)?.title
    || 'Not selected';
  const dialogPrimaryLabel = actionDialog?.mode === 'grant-access' ? 'Grant access'
    : actionDialog?.mode === 'revoke-access' ? 'Revoke access'
      : actionDialog?.mode === 'extend-validity' ? 'Save new expiry'
        : actionDialog?.mode === 'disable-access' ? 'Disable access'
          : actionDialog?.mode === 'repair-access' ? 'Run repair'
            : actionDialog?.mode === 'sync-payment' ? 'Sync payment'
              : actionDialog?.mode === 'manual-review' ? 'Move to review'
                : actionDialog?.mode === 'block-student' ? (actionDialog.nextStatus === 'blocked' ? 'Block student' : 'Unblock student')
                  : actionDialog?.mode === 'reset-password' ? 'Reset password'
                    : actionDialog?.mode === 'bulk-sync' ? 'Start bulk sync'
                      : 'Submit';
  const dialogTitle = actionDialog?.mode === 'grant-access' ? 'Grant course access'
    : actionDialog?.mode === 'revoke-access' ? 'Revoke course access'
      : actionDialog?.mode === 'extend-validity' ? 'Extend course validity'
        : actionDialog?.mode === 'disable-access' ? 'Disable course access'
          : actionDialog?.mode === 'repair-access' ? 'Repair payment-linked access'
            : actionDialog?.mode === 'sync-payment' ? 'Sync with Razorpay'
              : actionDialog?.mode === 'manual-review' ? 'Move payment to manual review'
                : actionDialog?.mode === 'block-student' ? (actionDialog.nextStatus === 'blocked' ? 'Block student account' : 'Unblock student account')
                  : actionDialog?.mode === 'reset-password' ? 'Reset student password'
                    : actionDialog?.mode === 'bulk-sync' ? 'Bulk sync pending Razorpay payments'
                      : '';
  const dialogDescription = actionDialog?.mode === 'grant-access'
    ? 'Use this only for manual admin access. This does not mark a payment as successful.'
    : actionDialog?.mode === 'revoke-access'
      ? 'This removes the selected course access for the student.'
      : actionDialog?.mode === 'extend-validity'
        ? 'Update the expiry for the selected course access.'
        : actionDialog?.mode === 'disable-access'
          ? 'Disable the selected course access without changing payment history.'
          : actionDialog?.mode === 'repair-access'
            ? 'Repair access only when a valid payment should already have unlocked the course.'
            : actionDialog?.mode === 'sync-payment'
              ? 'Fetch Razorpay data again and re-check status, amount, user, and course mapping.'
              : actionDialog?.mode === 'manual-review'
                ? 'Flag this payment for a safer manual review lane instead of auto-activating it.'
                : actionDialog?.mode === 'block-student'
                  ? 'Add a clear reason so other admins understand why this account changed state.'
                  : actionDialog?.mode === 'reset-password'
                    ? 'Enter the new password and an optional reason for the reset.'
                    : actionDialog?.mode === 'bulk-sync'
                      ? 'Run a controlled sync for pending Razorpay payments in the current environment.'
                      : '';
  const overviewCards = dashboard && paymentOverview ? [
    ['Total students', dashboard.totalStudents, 'Registered student accounts', UserCircle2],
    ['Active students now', dashboard.activeStudentsNow || 0, 'Recent activity within the current window', RefreshCw],
    ['Logged in now', dashboard.loggedInStudentsNow || 0, 'Students with an active recent session', ShieldCheck],
    ['Logged out today', dashboard.loggedOutStudentsToday || 0, 'Logout events recorded today', RefreshCw],
    ['Razorpay captured payments', paymentOverview.razorpayCapturedPayments, 'Verified from Razorpay for the selected range', Wallet],
    ['Local successful transactions', paymentOverview.localSuccessfulTransactions, 'Unique local paid rows in the selected range', Wallet],
    ['Captured but pending locally', paymentOverview.capturedButPendingLocally, 'Captured at Razorpay but not fully repaired locally', Wallet],
    ['Local success not verified', paymentOverview.localSuccessButNotVerifiedInRazorpay, 'Local success rows without matching captured proof', AlertTriangle],
    ['Pending payments', paymentOverview.pendingPayments, 'Still awaiting verification or capture', Wallet],
    ['Failed payments', paymentOverview.failedPayments, 'Gateway or local failure state', AlertTriangle],
    ['Refunded payments', paymentOverview.refundedPayments, 'Refunded or chargeback-linked records', AlertTriangle],
    ['Manual review payments', paymentOverview.manualReviewPayments, 'Unsafe or mismatched transactions', AlertTriangle],
    ['Admin granted access', paymentOverview.adminGrantedAccess, 'Manual grants kept separate from payment success', ShieldCheck],
    ['Active course access', paymentOverview.activeCourseAccess, 'Access enabled and not expired', Wallet],
    ['Backend health', dashboard.backendHealth || 'unknown', 'Current backend health state', ShieldCheck],
    ['DB health', dashboard.dbHealth || 'unknown', 'Current database health state', ShieldCheck],
  ] as const : [];

  return (
    <div className="space-y-6">
      <section className="rounded-[30px] border border-white/70 bg-white/92 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.07)]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--ink-soft)]">Payments and access control</p>
            <h3 className="mt-3 text-3xl font-semibold text-[var(--ink)]">Keep payment verification, student access, sessions, and audit trails in one production admin lane.</h3>
            <p className="mt-3 text-sm leading-7 text-[var(--ink-soft)]">This control center stays focused on payments, course access, student monitoring, manual review, system health, and audit visibility only.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" data-testid="admin-refresh-dashboard" onClick={() => void Promise.all([refreshDashboard(), loadSection(1)])} disabled={busy || loading} className="inline-flex items-center gap-2 rounded-[16px] border border-[var(--line)] px-4 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-60">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            {section === 'payments' && (
              <button type="button" data-testid="admin-sync-all-pending" onClick={() => openActionDialog({ mode: 'bulk-sync' }, { maxRecords: '500' })} disabled={busy || loading} className="inline-flex items-center gap-2 rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
                <Wallet className="h-4 w-4" />
                Sync All Pending Razorpay Payments
              </button>
            )}
          </div>
        </div>
        {message && (
          <div className="mt-5 rounded-[18px] border border-[var(--line)] bg-[var(--accent-cream)] px-4 py-3 text-sm text-[var(--ink)]">
            {message}
          </div>
        )}
      </section>

      {(section === 'overview' || section === 'payments') && (
      <section className="rounded-[26px] border border-[var(--line)] bg-white p-5 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
        <div className="grid gap-4 xl:grid-cols-[220px_220px_220px_1fr_auto]">
          <label className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Date range</span>
            <select data-testid="admin-payment-range" value={paymentRangePreset} onChange={(event) => setPaymentRangePreset(event.target.value as AdminPaymentRangeParams['rangePreset'])} className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none">
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="last_7_days">Last 7 days</option>
              <option value="last_30_days">Last 30 days</option>
              <option value="current_month">Current month</option>
              <option value="custom">Custom date range</option>
              <option value="all_time">All time</option>
            </select>
          </label>
          {paymentRangePreset === 'custom' && (
            <>
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Start date</span>
                <input data-testid="admin-payment-start-date" type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none" />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">End date</span>
                <input data-testid="admin-payment-end-date" type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none" />
              </label>
            </>
          )}
          <div className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Range proof</p>
            <p className="mt-2 text-sm text-[var(--ink)]">Razorpay: {dashboard?.paymentDateRange?.razorpayStartIso || 'NA'} to {dashboard?.paymentDateRange?.razorpayEndIso || 'NA'}</p>
            <p className="mt-1 text-sm text-[var(--ink)]">DB: {dashboard?.paymentDateRange?.dbStartIso || 'NA'} to {dashboard?.paymentDateRange?.dbEndIso || 'NA'}</p>
            <p className="mt-1 text-sm text-[var(--ink)]">Timezone: {dashboard?.paymentDateRange?.timezone || 'Asia/Kolkata'} | Mode: {dashboard?.paymentDateRange?.paymentMode || 'live'}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <button type="button" data-testid="admin-reconcile-razorpay" onClick={() => void refreshPaymentReconciliation()} disabled={busy || loading} className="inline-flex items-center gap-2 rounded-[16px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
              <Wallet className="h-4 w-4" />
              Reconcile With Razorpay
            </button>
          </div>
        </div>
        {paymentReconciliation && (
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <div className="rounded-[18px] border border-[var(--line)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Last reconciliation</p>
              <p className="mt-2 text-sm text-[var(--ink)]">{formatDateTime(paymentReconciliation.lastReconciledAt)}</p>
            </div>
            <div className="rounded-[18px] border border-[var(--line)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Matched captured</p>
              <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{paymentReconciliation.matchedCapturedPayments.length}</p>
            </div>
            <div className="rounded-[18px] border border-[var(--line)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Difference</p>
              <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{paymentReconciliation.cards.differenceCount}</p>
            </div>
            <div className="rounded-[18px] border border-[var(--line)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Wrong date/timezone</p>
              <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{paymentReconciliation.wrongDateTimezoneRecords.length}</p>
            </div>
            <div className="rounded-[18px] border border-[var(--line)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Local success not verified</p>
              <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{paymentReconciliation.localSuccessButNotVerifiedInRazorpay.length}</p>
            </div>
            <div className="rounded-[18px] border border-[var(--line)] px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Duplicate local success</p>
              <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{paymentReconciliation.duplicateLocalSuccessfulTransactions.length}</p>
            </div>
          </div>
        )}
      </section>
      )}

      {section === 'overview' && overviewCards.length > 0 && (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {overviewCards.map(([title, value, hint, Icon]) => (
            <SectionCard key={title} title={title} value={value} hint={hint} icon={Icon} />
          ))}
        </section>
      )}

      {bulkSyncResult && section === 'payments' && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-5 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <p className="text-lg font-semibold text-[var(--ink)]">Last bulk sync result</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[
              ['Checked', bulkSyncResult.totalChecked],
              ['Activated', bulkSyncResult.verifiedCapturedActivated || 0],
              ['Still pending', bulkSyncResult.stillPending],
              ['Failed', bulkSyncResult.failed],
              ['Refunded', bulkSyncResult.refunded],
              ['Manual review', bulkSyncResult.manualReviewRequired || 0],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">{label}</p>
                <p className="mt-2 text-xl font-semibold text-[var(--ink)]">{value}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {paymentReconciliation && (section === 'overview' || section === 'payments') && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-[var(--ink)]">Reconciliation report</p>
              <p className="mt-1 text-sm text-[var(--ink-soft)]">If counts diverge, this report shows the exact records instead of hiding the mismatch.</p>
            </div>
            <StatusPill value={paymentReconciliation.cards.differenceCount === 0 ? 'matched' : 'manual_review_required'} />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SectionCard title="Captured but pending" value={paymentReconciliation.capturedButPendingLocally.length} hint="Captured in Razorpay but not fully repaired locally" icon={Wallet} />
            <SectionCard title="Outside selected range" value={paymentReconciliation.wrongDateTimezoneRecords.length} hint="Rows that caused the legacy all-time mismatch" icon={AlertTriangle} />
            <SectionCard title="Amount mismatch" value={paymentReconciliation.amountMismatchRecords.length} hint="Expected and received amounts differ" icon={AlertTriangle} />
            <SectionCard title="Order mismatch" value={paymentReconciliation.orderMismatchRecords.length} hint="Gateway order does not match local order mapping" icon={AlertTriangle} />
          </div>
          {(paymentReconciliation.localSuccessButNotVerifiedInRazorpay.length > 0 || paymentReconciliation.wrongDateTimezoneRecords.length > 0) && (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[var(--ink-soft)]">
                  <tr>
                    <th className="pb-3 pr-4">Local transaction</th>
                    <th className="pb-3 pr-4">Razorpay payment</th>
                    <th className="pb-3 pr-4">Student</th>
                    <th className="pb-3 pr-4">Course</th>
                    <th className="pb-3 pr-4">Created</th>
                    <th className="pb-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {[...paymentReconciliation.localSuccessButNotVerifiedInRazorpay, ...paymentReconciliation.wrongDateTimezoneRecords].slice(0, 12).map((item, index) => (
                    <tr key={`${item.localTransactionId || item.razorpayPaymentId || 'mismatch'}-${index}`} className="border-t border-[var(--line)] align-top">
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{item.localTransactionId || 'NA'}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{item.razorpayPaymentId || item.razorpayOrderId || 'NA'}</td>
                      <td className="py-3 pr-4 text-[var(--ink)]">{item.student || 'NA'}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{item.course || 'NA'}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(item.createdAt)}</td>
                      <td className="py-3 text-[var(--ink-soft)]">{item.reason || 'Mismatch'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {section !== 'overview' && section !== 'system-health' && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-5 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <div className="grid gap-4 lg:grid-cols-[1fr_220px]">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-soft)]" />
              <input data-testid="admin-section-search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search by student, email, mobile, course, transaction, or action" className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-[#f9fbff] pl-11 pr-4 text-sm text-[var(--ink)] outline-none" />
            </label>
            <select data-testid="admin-section-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-12 rounded-[16px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none">
              <option value="">All statuses</option>
              {section === 'students' && ['active', 'blocked', 'disabled'].map((value) => <option key={value} value={value}>{value}</option>)}
              {section === 'login-sessions' && ['online', 'offline', 'active', 'ended'].map((value) => <option key={value} value={value}>{value}</option>)}
              {section === 'payments' && ['paid', 'pending', 'failed', 'refunded'].map((value) => <option key={value} value={value}>{value}</option>)}
              {section === 'course-access' && ['enabled', 'disabled', 'expired', 'pending_access'].map((value) => <option key={value} value={value}>{value}</option>)}
              {section === 'audit-logs' && ['single_razorpay_sync', 'bulk_razorpay_sync', 'course_assigned_manually', 'course_removed', 'course_access_repaired', 'student_force_logout', 'student_status_updated', 'student_password_reset'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        </section>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-3 rounded-[26px] border border-[var(--line)] bg-white px-6 py-12 text-sm text-[var(--ink-soft)]">
          <LoaderCircle className="h-5 w-5 animate-spin" />
          Loading admin payment data...
        </div>
      )}

      {!loading && section === 'overview' && dashboard && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <p className="text-lg font-semibold text-[var(--ink)]">Recent payment activity</p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="pb-3 pr-4">Student</th>
                  <th className="pb-3 pr-4">Course</th>
                  <th className="pb-3 pr-4">Amount</th>
                  <th className="pb-3 pr-4">Local status</th>
                  <th className="pb-3 pr-4">Verification</th>
                  <th className="pb-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recentTransactions.map((item) => (
                  <tr key={item.paymentId} className="border-t border-[var(--line)] align-top">
                    <td className="py-3 pr-4">
                      <p className="font-semibold text-[var(--ink)]">{item.studentName}</p>
                      <p className="text-[var(--ink-soft)]">{item.studentEmail || item.studentMobile || 'NA'}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--ink)]">{item.courseName || 'NA'}</td>
                    <td className="py-3 pr-4 text-[var(--ink)]">{currency.format(item.amount || 0)}</td>
                    <td className="py-3 pr-4"><StatusPill value={item.paymentStatus} /></td>
                    <td className="py-3 pr-4"><StatusPill value={item.verificationDecision} /></td>
                    <td className="py-3 text-[var(--ink-soft)]">{formatDateTime(item.lastSyncedAt || item.paymentDateTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && section === 'students' && (
        <>
          {dashboard && paymentOverview && (
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
              <SectionCard title="Total students" value={dashboard.totalStudents} hint="All student accounts" icon={UserCircle2} />
              <SectionCard title="Online now" value={studentLiveMetrics?.onlineNow ?? (dashboard.loggedInStudentsNow || 0)} hint="Live card only. Student table stays stable." icon={ShieldCheck} onClick={() => setStudentQuickFilter('online')} selected={studentQuickFilter === 'online'} />
              <SectionCard title="Logged out today" value={studentLiveMetrics?.loggedOutToday ?? (dashboard.loggedOutStudentsToday || 0)} hint="Live logout count without reloading the list" icon={RefreshCw} />
              <SectionCard title="Active now" value={studentLiveMetrics?.activeNow ?? (dashboard.activeStudentsNow || 0)} hint="Recent student activity in the last 5 minutes" icon={RefreshCw} />
              <SectionCard title="Verified payments" value={paymentOverview.localSuccessfulTransactions} hint="Click to filter students with verified payment rows" icon={Wallet} onClick={() => {
                setStudentSortBy('verified-payments');
                setStudentQuickFilter('verified-paid');
              }} selected={studentQuickFilter === 'verified-paid'} />
              <SectionCard title="Active course access" value={paymentOverview.activeCourseAccess} hint="Click to filter students with active course access" icon={Wallet} onClick={() => {
                setStudentSortBy('verified-payments');
                setStudentQuickFilter('active-access');
              }} selected={studentQuickFilter === 'active-access'} />
            </section>
          )}

          <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
            <div className="mb-4 flex flex-col gap-3 text-sm text-[var(--ink-soft)] md:flex-row md:items-center md:justify-between">
              <p>
                {autoRefreshPaused
                  ? 'Live refresh is paused while search, filters, details, or actions are open so the list stays stable.'
                  : 'Only the small live cards refresh in the background. The student table does not auto-reload.'}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <p>Showing {displayedStudents.length} of {pagination.total} students</p>
                <button
                  type="button"
                  onClick={() => void loadSection(Math.max(1, pagination.page - 1))}
                  disabled={busy || loading || pagination.page <= 1}
                  className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span>Page {pagination.page} / {pagination.totalPages}</span>
                <button
                  type="button"
                  onClick={() => void loadSection(Math.min(pagination.totalPages, pagination.page + 1))}
                  disabled={busy || loading || pagination.page >= pagination.totalPages}
                  className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
            <div className="mb-4 grid gap-3 lg:grid-cols-[220px_1fr]">
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Sort by</span>
                <select value={studentSortBy} onChange={(event) => setStudentSortBy(event.target.value as AdminStudentSortBy)} className="h-11 rounded-[14px] border border-[var(--line)] bg-[#f9fbff] px-4 text-sm text-[var(--ink)] outline-none">
                  <option value="newest">Newest first</option>
                  <option value="name">Name A-Z</option>
                  <option value="online-first">Online first</option>
                  <option value="verified-payments">Verified payments</option>
                  <option value="active-access">Active access</option>
                </select>
              </label>
              <div className="flex flex-wrap items-end gap-2">
                {[
                  ['all', 'All students'],
                  ['verified-paid', 'Verified paid'],
                  ['online', 'Online now'],
                  ['active-access', 'Active access'],
                  ['needs-review', 'Needs review'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      const nextFilter = value as AdminStudentQuickFilter;
                      setStudentQuickFilter(nextFilter);
                      if (nextFilter === 'verified-paid' || nextFilter === 'active-access') {
                        setStudentSortBy('verified-payments');
                      } else if (nextFilter === 'online') {
                        setStudentSortBy('online-first');
                      } else if (nextFilter === 'all' && studentSortBy !== 'name') {
                        setStudentSortBy('newest');
                      }
                    }}
                    className={`rounded-full px-4 py-2 text-sm font-semibold ${studentQuickFilter === value ? 'bg-[var(--ink)] text-white' : 'border border-[var(--line)] text-[var(--ink)]'}`}
                  >
                    {label}
                  </button>
                ))}
                {(studentQuickFilter !== 'all' || statusFilter || searchInput.trim()) && (
                  <button type="button" onClick={() => {
                    setStudentQuickFilter('all');
                    setStudentSortBy('newest');
                    setStatusFilter('');
                    setSearch('');
                    setSearchInput('');
                  }} className="rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--ink)]">
                    Clear filters
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="pb-3 pr-4">Student</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3 pr-4">Latest payment</th>
                  <th className="pb-3 pr-4">Access</th>
                  <th className="pb-3 pr-4">Device now</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedStudents.map((student) => (
                  <tr key={student.studentId} className="border-t border-[var(--line)] align-top">
                    <td className="py-3 pr-4">
                      <p className="font-semibold text-[var(--ink)]">{student.name}</p>
                      <p className="text-[var(--ink-soft)]">{student.email}</p>
                      <p className="text-[var(--ink-soft)]">{student.mobileNumber || 'NA'}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <StatusPill value={student.accountStatus} />
                      <div className="mt-2">
                        <StatusPill value={student.loggedInNow ? 'online' : 'offline'} />
                      </div>
                      <p className="mt-2 text-[var(--ink-soft)]">Last active: {formatDateTime(student.lastActiveAt)}</p>
                      <p className="mt-2 text-[var(--ink-soft)]">Last login: {formatDateTime(student.lastLoginAt)}</p>
                      <p className="text-[var(--ink-soft)]">Last logout: {formatDateTime(student.lastLogoutAt)}</p>
                      <p className="text-[var(--ink-soft)]">{student.statusNote || 'No account note'}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">
                      <p className="font-semibold text-[var(--ink)]">{student.latestPaymentCourseName || 'No payment yet'}</p>
                      {student.latestPaymentStatus ? (
                        <div className="mt-2">
                          <StatusPill value={student.latestPaymentStatus} />
                        </div>
                      ) : null}
                      <p className="mt-2">Verification: {student.latestPaymentVerificationStatus || 'NA'}</p>
                      <p>Txn: {student.latestPaymentTransactionId || 'NA'}</p>
                      <p>Order: {student.latestPaymentOrderId || 'NA'}</p>
                      <p>Gateway: {student.latestPaymentGatewayPaymentId || 'NA'}</p>
                      <p>Updated: {formatDateTime(student.latestPaymentCreatedAt)}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">
                      <p>Courses: {student.enrolledCoursesCount}</p>
                      <p>Active: {student.activeCourseAccessCount || 0}</p>
                      <p>Verified: {student.paymentSummary.successful}</p>
                      <p>Failed: {student.paymentSummary.failed}</p>
                      <p>Needs sync: {student.paymentSummary.pending}</p>
                      <p>Needs review: {student.manualReviewCount || 0}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">
                      <p>{student.latestDeviceLabel || 'No recent device'}</p>
                      <p className="mt-2">Devices seen: {student.deviceCount || 0}</p>
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void openStudent(student.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">View</button>
                        <ActionMenu label="Manage">
                          <button type="button" onClick={() => void forceLogoutStudent(student.studentId)} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Force logout</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'block-student', studentId: student.studentId, studentLabel: student.name, nextStatus: student.accountStatus === 'blocked' ? 'active' : 'blocked' })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">{student.accountStatus === 'blocked' ? 'Unblock student' : 'Block student'}</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'reset-password', studentId: student.studentId, studentLabel: student.name })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Reset password</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'grant-access', studentId: student.studentId, studentLabel: student.name })} disabled={busy} className="rounded-[12px] bg-[var(--ink)] px-3 py-2 text-left font-semibold text-white disabled:opacity-60">Grant course access</button>
                          <button type="button" onClick={() => setMessage('Open the student record first, then use a purchase row to manage content rules or watch overrides for a specific course.')} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">How to manage content</button>
                        </ActionMenu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 text-sm text-[var(--ink-soft)]">
            <button
              type="button"
              onClick={() => void loadSection(Math.max(1, pagination.page - 1))}
              disabled={busy || loading || pagination.page <= 1}
              className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Previous
            </button>
            <span>Page {pagination.page} / {pagination.totalPages}</span>
            <button
              type="button"
              onClick={() => void loadSection(Math.min(pagination.totalPages, pagination.page + 1))}
              disabled={busy || loading || pagination.page >= pagination.totalPages}
              className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Next
            </button>
          </div>
          </section>
        </>
      )}

      {!loading && section === 'login-sessions' && (
        <>
          {loginSummary && (
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <SectionCard title="Logged in now" value={loginSummary.loggedInNow} hint="Recent active student sessions" icon={ShieldCheck} />
              <SectionCard title="Recent logins" value={loginSummary.recentLogins} hint="Session records in the current page scope" icon={UserCircle2} />
              <SectionCard title="Recent logouts" value={loginSummary.recentLogouts} hint="Logout records in the current page scope" icon={RefreshCw} />
              <SectionCard title="Failed login attempts" value={loginSummary.failedLoginAttempts} hint="Currently instrumented failures" icon={AlertTriangle} />
              <SectionCard title="Multiple devices" value={loginSummary.multipleDeviceLoginCount} hint="Users with more than one visible active session" icon={ShieldCheck} />
            </section>
          )}
          <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
            <div className="mb-4 flex flex-col gap-3 text-sm text-[var(--ink-soft)] md:flex-row md:items-center md:justify-between">
              <p>Showing {loginSessions.length} of {pagination.total} session records</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadSection(Math.max(1, pagination.page - 1))}
                  disabled={busy || loading || pagination.page <= 1}
                  className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span>Page {pagination.page} / {pagination.totalPages}</span>
                <button
                  type="button"
                  onClick={() => void loadSection(Math.min(pagination.totalPages, pagination.page + 1))}
                  disabled={busy || loading || pagination.page >= pagination.totalPages}
                  className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[var(--ink-soft)]">
                  <tr>
                    <th className="pb-3 pr-4">Student</th>
                    <th className="pb-3 pr-4">Login</th>
                    <th className="pb-3 pr-4">Logout</th>
                    <th className="pb-3 pr-4">Last active</th>
                    <th className="pb-3 pr-4">Device</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loginSessions.map((session) => (
                    <tr key={`${session.studentId}-${session.sessionId}`} className="border-t border-[var(--line)] align-top">
                      <td className="py-3 pr-4">
                        <p className="font-semibold text-[var(--ink)]">{session.studentName}</p>
                        <p className="text-[var(--ink-soft)]">{session.email || session.mobileNumber || 'NA'}</p>
                      </td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(session.loginTime)}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(session.logoutTime)}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(session.lastActiveTime)}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">
                        <p>{session.deviceId || 'NA'}</p>
                        <p>{session.browser || 'NA'} / {session.os || 'NA'}</p>
                      </td>
                      <td className="py-3 pr-4"><StatusPill value={session.sessionStatus} /></td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => void forceLogoutStudent(session.studentId)} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Force logout</button>
                          <button type="button" onClick={() => void openStudent(session.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">View student</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'block-student', studentId: session.studentId, studentLabel: session.studentName, nextStatus: 'blocked' })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Block</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!loading && section === 'payments' && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="pb-3 pr-4">Transaction</th>
                  <th className="pb-3 pr-4">Student</th>
                  <th className="pb-3 pr-4">Course</th>
                  <th className="pb-3 pr-4">Amount</th>
                  <th className="pb-3 pr-4">Statuses</th>
                  <th className="pb-3 pr-4">Gateway refs</th>
                  <th className="pb-3 pr-4">Access</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.paymentId} className="border-t border-[var(--line)] align-top">
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">
                      <p className="font-semibold text-[var(--ink)]">{payment.paymentId}</p>
                      <p>Created: {formatDateTime(payment.paymentDateTime)}</p>
                      <p>Synced: {formatDateTime(payment.lastSyncedAt)}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <p className="font-semibold text-[var(--ink)]">{payment.studentName}</p>
                      <p className="text-[var(--ink-soft)]">{payment.studentEmail || payment.studentMobile || 'NA'}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">{payment.courseName || 'NA'}</td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">
                      <p>{currency.format(payment.amount || 0)}</p>
                      <p>{payment.paymentMethod || 'NA'}</p>
                      <p>{payment.bankRrn || 'No RRN'}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex flex-col gap-2">
                        <StatusPill value={payment.paymentStatus} />
                        <StatusPill value={payment.gatewayStatus} />
                        <StatusPill value={payment.verificationDecision} />
                      </div>
                      <p className="mt-2 text-[var(--ink-soft)]">{payment.verificationReason || payment.failureReason || 'No mismatch reason'}</p>
                    </td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">
                      <p>Order: {payment.gatewayOrderId || 'NA'}</p>
                      <p>Payment: {payment.gatewayPaymentId || 'NA'}</p>
                    </td>
                    <td className="py-3 pr-4">
                      <StatusPill value={payment.accessStatus} />
                      <p className="mt-2 text-[var(--ink-soft)]">{payment.courseAccessLabel || 'NA'}</p>
                    </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => openActionDialog({ mode: 'sync-payment', paymentId: payment.paymentId, gatewayOrderId: payment.gatewayOrderId, gatewayPaymentId: payment.gatewayPaymentId, studentId: payment.studentId, studentLabel: payment.studentName, courseId: payment.courseId, courseLabel: payment.courseName || undefined })} disabled={busy} className="rounded-[12px] bg-[var(--ink)] px-3 py-2 font-semibold text-white">Sync Razorpay Payment</button>
                        <ActionMenu label="Payment actions">
                          <button type="button" onClick={() => openActionDialog({ mode: 'sync-payment', paymentId: payment.paymentId, gatewayOrderId: payment.gatewayOrderId, gatewayPaymentId: payment.gatewayPaymentId, studentId: payment.studentId, studentLabel: payment.studentName, courseId: payment.courseId, courseLabel: payment.courseName || undefined })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Verify payment</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'repair-access', studentId: payment.studentId, studentLabel: payment.studentName, courseId: payment.courseId, courseLabel: payment.courseName || undefined, transactionId: payment.transactionId })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Repair course access</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'manual-review', paymentId: payment.paymentId, studentId: payment.studentId, studentLabel: payment.studentName, courseId: payment.courseId, courseLabel: payment.courseName || undefined })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Move to manual review</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'grant-access', studentId: payment.studentId, studentLabel: payment.studentName, courseId: payment.courseId, courseLabel: payment.courseName || undefined, reference: payment.gatewayPaymentId || payment.gatewayOrderId || payment.transactionId })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Grant course access</button>
                          <button type="button" onClick={() => void manageStudentContentAccess(payment.studentId, payment.studentName, payment.courseId, payment.courseName || undefined)} disabled={busy || !payment.courseId} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Manage content access</button>
                          <button type="button" onClick={() => void manageStudentWatchOverride(payment.studentId, payment.studentName, payment.courseId, payment.courseName || undefined)} disabled={busy || !payment.courseId} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Manage watch override</button>
                          <button type="button" onClick={() => void openStudent(payment.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)]">View student</button>
                        </ActionMenu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && section === 'course-access' && (
        <>
          {courseAccessSummary && (
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <SectionCard title="Active access" value={courseAccessSummary.activeAccessCount} hint="Enabled and not expired" icon={ShieldCheck} />
              <SectionCard title="Expired access" value={courseAccessSummary.expiredAccessCount} hint="Validity elapsed" icon={AlertTriangle} />
              <SectionCard title="Disabled access" value={courseAccessSummary.disabledAccessCount} hint="Admin or payment disabled" icon={AlertTriangle} />
              <SectionCard title="Manual grants" value={courseAccessSummary.manuallyGrantedAccessCount} hint="Granted without faking payment success" icon={ShieldCheck} />
              <SectionCard title="Payment linked" value={courseAccessSummary.paymentLinkedAccessCount} hint="Access tied to payment records" icon={Wallet} />
            </section>
          )}
          <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[var(--ink-soft)]">
                  <tr>
                    <th className="pb-3 pr-4">Student</th>
                    <th className="pb-3 pr-4">Course</th>
                    <th className="pb-3 pr-4">Access source</th>
                    <th className="pb-3 pr-4">Status</th>
                    <th className="pb-3 pr-4">Validity</th>
                    <th className="pb-3 pr-4">Payment</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {courseAccess.map((item) => (
                    <tr key={`${item.studentId}-${item.courseId}-${item.paymentId || item.accessSource}`} className="border-t border-[var(--line)] align-top">
                      <td className="py-3 pr-4">
                        <p className="font-semibold text-[var(--ink)]">{item.studentName}</p>
                        <p className="text-[var(--ink-soft)]">{item.email || item.mobileNumber || 'NA'}</p>
                      </td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{item.courseName}</td>
                      <td className="py-3 pr-4"><StatusPill value={item.accessSource} /></td>
                      <td className="py-3 pr-4">
                        <StatusPill value={item.accessStatus} />
                        <p className="mt-2 text-[var(--ink-soft)]">{item.canAccessCourse ? 'canAccessCourse = true' : `Blocked: ${item.accessBlockReason || 'unknown'}`}</p>
                      </td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(item.validUntil)}</td>
                      <td className="py-3 pr-4">
                        <StatusPill value={item.paymentStatus} />
                        <p className="mt-2 text-[var(--ink-soft)]">{item.verificationStatus || 'Verification state tracked on payment row'}</p>
                      </td>
                    <td className="py-3">
                      <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => void openStudent(item.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">View</button>
                          <ActionMenu label="Manage access">
                            <button type="button" onClick={() => openActionDialog({ mode: 'grant-access', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId, courseLabel: item.courseName, reference: item.gatewayPaymentId || item.gatewayOrderId })} disabled={busy} className="rounded-[12px] bg-[var(--ink)] px-3 py-2 text-left font-semibold text-white disabled:opacity-60">Grant access</button>
                            <button type="button" onClick={() => openActionDialog({ mode: 'revoke-access', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId, courseLabel: item.courseName })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Revoke access</button>
                            <button type="button" onClick={() => openActionDialog({ mode: 'extend-validity', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId, courseLabel: item.courseName, currentValidity: item.validUntil })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Extend validity</button>
                            <button type="button" onClick={() => openActionDialog({ mode: 'disable-access', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId, courseLabel: item.courseName })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Disable access</button>
                            <button type="button" onClick={() => openActionDialog({ mode: 'repair-access', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId, courseLabel: item.courseName, transactionId: item.gatewayPaymentId || item.paymentId || undefined })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 text-left font-semibold text-[var(--ink)] disabled:opacity-60">Repair access</button>
                          </ActionMenu>
                      </div>
                    </td>
                  </tr>
                ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!loading && section === 'manual-review' && (
        <>
          {manualReviewSummary && (
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
              <SectionCard title="Manual review total" value={manualReviewSummary.total} hint="Unsafe or mismatched cases" icon={AlertTriangle} />
              <SectionCard title="Amount mismatch" value={manualReviewSummary.amountMismatch} hint="Expected vs received amount conflict" icon={AlertTriangle} />
              <SectionCard title="Order mismatch" value={manualReviewSummary.orderMismatch} hint="Gateway order mismatch" icon={AlertTriangle} />
              <SectionCard title="User mismatch" value={manualReviewSummary.userMismatch} hint="Student identity mismatch" icon={AlertTriangle} />
              <SectionCard title="Course mismatch" value={manualReviewSummary.courseMismatch} hint="Course mapping mismatch" icon={AlertTriangle} />
              <SectionCard title="Refund/dispute" value={manualReviewSummary.refundedOrDisputed} hint="Refunded or disputed records" icon={AlertTriangle} />
            </section>
          )}
          <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-[var(--ink-soft)]">
                  <tr>
                    <th className="pb-3 pr-4">Student</th>
                    <th className="pb-3 pr-4">Course</th>
                    <th className="pb-3 pr-4">Expected</th>
                    <th className="pb-3 pr-4">Received</th>
                    <th className="pb-3 pr-4">Gateway refs</th>
                    <th className="pb-3 pr-4">Decision</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {manualReviewItems.map((item) => (
                    <tr key={item.paymentId} className="border-t border-[var(--line)] align-top">
                      <td className="py-3 pr-4">
                        <p className="font-semibold text-[var(--ink)]">{item.studentName}</p>
                        <p className="text-[var(--ink-soft)]">{item.email || item.mobileNumber || 'NA'}</p>
                      </td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{item.courseName || 'NA'}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{currency.format(item.amountExpected || 0)}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">{currency.format(item.amountReceived || 0)}</td>
                      <td className="py-3 pr-4 text-[var(--ink-soft)]">
                        <p>Order: {item.razorpayOrderId || 'NA'}</p>
                        <p>Payment: {item.razorpayPaymentId || 'NA'}</p>
                      </td>
                      <td className="py-3 pr-4">
                        <StatusPill value={item.verificationDecision} />
                        <p className="mt-2 text-[var(--ink-soft)]">{item.reason || item.adminNote || 'Needs review'}</p>
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => void approveManualGrant(item)} disabled={busy} className="rounded-[12px] bg-[var(--ink)] px-3 py-2 font-semibold text-white">Approve manually</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'manual-review', paymentId: item.paymentId, studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId || null, courseLabel: item.courseName || undefined })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Keep pending</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'revoke-access', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId || null, courseLabel: item.courseName || undefined })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Reject</button>
                          <button type="button" onClick={() => openActionDialog({ mode: 'grant-access', studentId: item.studentId, studentLabel: item.studentName, courseId: item.courseId || null, courseLabel: item.courseName || undefined, reference: item.razorpayPaymentId || item.localOrderId })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Grant manual access</button>
                          <button type="button" onClick={() => void openStudent(item.studentId)} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">View details</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!loading && section === 'system-health' && systemHealth && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SectionCard title="Backend status" value={systemHealth.backendStatus} hint="Overall backend dependency health" icon={ShieldCheck} />
            <SectionCard title="Replica 1" value={systemHealth.appReplica1Health} hint="Per-replica visibility needs external instrumentation" icon={ShieldCheck} />
            <SectionCard title="Replica 2" value={systemHealth.appReplica2Health} hint="Per-replica visibility needs external instrumentation" icon={ShieldCheck} />
            <SectionCard title="DB status" value={systemHealth.dbStatus} hint="Postgres health summary" icon={Wallet} />
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-[22px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink)]">
              <p className="font-semibold">DB connections</p>
              <p className="mt-2">Total: {systemHealth.dbConnections.total ?? 'NA'}</p>
              <p>Idle: {systemHealth.dbConnections.idle ?? 'NA'}</p>
              <p>Waiting: {systemHealth.dbConnections.waiting ?? 'NA'}</p>
            </div>
            <div className="rounded-[22px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink)]">
              <p className="font-semibold">Rates and latency</p>
              <p className="mt-2">API error rate: {systemHealth.apiErrorRate ?? 'Unavailable'}</p>
              <p>P95: {systemHealth.p95Latency ?? 'Unavailable'}</p>
              <p>P99: {systemHealth.p99Latency ?? 'Unavailable'}</p>
            </div>
            <div className="rounded-[22px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink)]">
              <p className="font-semibold">Edge failures</p>
              <p className="mt-2">502: {systemHealth.status502Count ?? 'Unavailable'}</p>
              <p>503: {systemHealth.status503Count ?? 'Unavailable'}</p>
              <p>504: {systemHealth.status504Count ?? 'Unavailable'}</p>
              <p className="mt-2">Last bulk sync: {formatDateTime(systemHealth.lastSuccessfulBulkSyncTime)}</p>
            </div>
          </div>
        </section>
      )}

      {!loading && section === 'audit-logs' && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[var(--ink-soft)]">
                <tr>
                  <th className="pb-3 pr-4">Timestamp</th>
                  <th className="pb-3 pr-4">Action</th>
                  <th className="pb-3 pr-4">Admin</th>
                  <th className="pb-3 pr-4">Student</th>
                  <th className="pb-3 pr-4">Course</th>
                  <th className="pb-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => (
                  <tr key={log._id} className="border-t border-[var(--line)] align-top">
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(log.createdAt)}</td>
                    <td className="py-3 pr-4"><StatusPill value={log.actionType} /></td>
                    <td className="py-3 pr-4 text-[var(--ink)]">{log.adminUserName || log.adminUserId}</td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">{log.targetUserName || log.targetUserId || 'NA'}</td>
                    <td className="py-3 pr-4 text-[var(--ink-soft)]">{log.courseName || log.courseId || 'NA'}</td>
                    <td className="py-3 text-[var(--ink-soft)]">{log.reason || 'No reason captured'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!loading && studentDetails && section === 'students' && (
        <section className="rounded-[26px] border border-[var(--line)] bg-white p-6 shadow-[0_12px_40px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-lg font-semibold text-[var(--ink)]">{studentDetails.student.name}</p>
              <p className="text-sm text-[var(--ink-soft)]">{studentDetails.student.email} • {studentDetails.student.mobileNumber || 'NA'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void forceLogoutStudent(studentDetails.student._id)} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Force logout</button>
              <button type="button" onClick={() => openActionDialog({ mode: 'grant-access', studentId: studentDetails.student._id, studentLabel: studentDetails.student.name })} disabled={busy} className="rounded-[12px] bg-[var(--ink)] px-3 py-2 font-semibold text-white">Grant access</button>
            </div>
          </div>
          <div className="mt-5 grid gap-4 xl:grid-cols-3">
            <div className="rounded-[18px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink)]">
              <p className="font-semibold">Sessions</p>
              <p className="mt-2">Last login: {formatDateTime(studentDetails.student.lastLoginAt)}</p>
              <p>Session records: {studentDetails.sessions.length}</p>
            </div>
            <div className="rounded-[18px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink)]">
              <p className="font-semibold">Purchases</p>
              <p className="mt-2">Access records: {studentDetails.purchases.length}</p>
              <p>Audit entries: {studentDetails.auditLog.length}</p>
            </div>
            <div className="rounded-[18px] bg-[var(--accent-cream)] p-4 text-sm text-[var(--ink)]">
              <p className="font-semibold">Devices</p>
              <p className="mt-2">Recent activity: {studentDetails.deviceActivity.length}</p>
              <p>Account status: {studentDetails.student.accountStatus}</p>
            </div>
          </div>
          <div className="mt-5 rounded-[18px] border border-[var(--line)] bg-white p-4">
            <div>
              <p className="text-base font-semibold text-[var(--ink)]">Support issues</p>
              <p className="text-sm text-[var(--ink-soft)]">Track this student's lesson doubts and video reports in one place.</p>
            </div>
            {studentDetails.supportIssues.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-[var(--ink-soft)]">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">Type</th>
                      <th className="py-2 pr-4 font-semibold">Path</th>
                      <th className="py-2 pr-4 font-semibold">Student issue</th>
                      <th className="py-2 pr-4 font-semibold">Admin update</th>
                      <th className="py-2 pr-4 font-semibold">Status</th>
                      <th className="py-2 pr-4 font-semibold">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentDetails.supportIssues.map((issue) => (
                      <tr key={`${issue.issueType}-${issue.issueId}`} className="border-t border-[var(--line)] align-top">
                        <td className="py-3 pr-4">
                          <StatusPill value={issue.issueType === 'lesson_doubt' ? 'lesson_doubt' : 'video_report'} />
                        </td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{issue.pathLabel}</td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{issue.studentMessage || 'No student message captured'}</td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{issue.adminReply || issue.adminNote || 'No admin reply yet'}</td>
                        <td className="py-3 pr-4"><StatusPill value={issue.status} /></td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(issue.updatedAt || issue.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 text-sm text-[var(--ink-soft)]">No lesson doubts or video reports found for this student.</p>
            )}
          </div>
          <div className="mt-5 rounded-[18px] border border-[var(--line)] bg-[var(--accent-cream)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-[var(--ink)]">Bought Courses</p>
                <p className="text-sm text-[var(--ink-soft)]">Razorpay/payment-linked access and current expiry.</p>
              </div>
            </div>
            {studentDetails.purchases.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-[var(--ink-soft)]">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">Course</th>
                      <th className="py-2 pr-4 font-semibold">Payment</th>
                      <th className="py-2 pr-4 font-semibold">Verification</th>
                      <th className="py-2 pr-4 font-semibold">Access</th>
                      <th className="py-2 pr-4 font-semibold">Expiry</th>
                      <th className="py-2 pr-4 font-semibold">Gateway IDs</th>
                      <th className="py-2 pr-4 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentDetails.purchases.map((purchase) => (
                      <tr key={purchase.purchaseId} className="border-t border-[var(--line)] align-top">
                        <td className="py-3 pr-4 text-[var(--ink)]">
                          <p className="font-semibold">{purchase.courseName || 'NA'}</p>
                          <p className="text-[var(--ink-soft)]">Source: {purchase.accessSource || 'payment'}</p>
                        </td>
                        <td className="py-3 pr-4">
                          <StatusPill value={purchase.paymentStatus} />
                          <p className="mt-2 text-[var(--ink-soft)]">{purchase.paymentAmount ? currency.format(purchase.paymentAmount) : 'Amount NA'}</p>
                        </td>
                        <td className="py-3 pr-4">
                          <StatusPill value={purchase.verificationStatus || 'NA'} />
                          <p className="mt-2 text-[var(--ink-soft)]">{purchase.gatewayStatus || 'Gateway NA'}</p>
                        </td>
                        <td className="py-3 pr-4">
                          <StatusPill value={purchase.accessStatus} />
                          <p className="mt-2 text-[var(--ink-soft)]">{purchase.accessStatus === 'expired' ? 'Expired' : purchase.accessStatus === 'enabled' ? 'Can access' : 'Restricted'}</p>
                        </td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">
                          <p>{formatDateTime(purchase.validUntil)}</p>
                        </td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">
                          <p>Order: {purchase.gatewayOrderId || 'NA'}</p>
                          <p>Payment: {purchase.gatewayPaymentId || 'NA'}</p>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={() => openActionDialog({ mode: 'extend-validity', studentId: studentDetails.student._id, studentLabel: studentDetails.student.name, courseId: purchase.courseId, courseLabel: purchase.courseName, currentValidity: purchase.validUntil })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Extend</button>
                            <button type="button" onClick={() => openActionDialog({ mode: 'revoke-access', studentId: studentDetails.student._id, studentLabel: studentDetails.student.name, courseId: purchase.courseId, courseLabel: purchase.courseName })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Revoke</button>
                            <button type="button" onClick={() => openActionDialog({ mode: 'disable-access', studentId: studentDetails.student._id, studentLabel: studentDetails.student.name, courseId: purchase.courseId, courseLabel: purchase.courseName })} disabled={busy} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Disable</button>
                            <button type="button" onClick={() => void manageStudentContentAccess(studentDetails.student._id, studentDetails.student.name, purchase.courseId, purchase.courseName)} disabled={busy || !purchase.courseId} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Content</button>
                            <button type="button" onClick={() => void manageStudentWatchOverride(studentDetails.student._id, studentDetails.student.name, purchase.courseId, purchase.courseName)} disabled={busy || !purchase.courseId} className="rounded-[12px] border border-[var(--line)] px-3 py-2 font-semibold text-[var(--ink)]">Watch override</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 text-sm text-[var(--ink-soft)]">No purchase or access record found for this student.</p>
            )}
          </div>
          <div className="mt-5 rounded-[18px] border border-[var(--line)] bg-white p-4">
            <div>
              <p className="text-base font-semibold text-[var(--ink)]">Recent devices and sessions</p>
              <p className="text-sm text-[var(--ink-soft)]">Latest device usage for this student in one place.</p>
            </div>
            {studentDetails.sessions.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-[var(--ink-soft)]">
                    <tr>
                      <th className="py-2 pr-4 font-semibold">Status</th>
                      <th className="py-2 pr-4 font-semibold">Device</th>
                      <th className="py-2 pr-4 font-semibold">Created</th>
                      <th className="py-2 pr-4 font-semibold">Last seen</th>
                      <th className="py-2 pr-4 font-semibold">Ended</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentDetails.sessions.slice(0, 8).map((session) => (
                      <tr key={session.sessionId} className="border-t border-[var(--line)] align-top">
                        <td className="py-3 pr-4"><StatusPill value={session.status} /></td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{typeof session.device === 'string' ? session.device : JSON.stringify(session.device || {})}</td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(session.createdAt)}</td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(session.lastSeenAt)}</td>
                        <td className="py-3 pr-4 text-[var(--ink-soft)]">{formatDateTime(session.endedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 text-sm text-[var(--ink-soft)]">No session records found for this student.</p>
            )}
          </div>
        </section>
      )}

      {actionDialog && (
        <div data-testid="admin-action-dialog" className="fixed inset-0 z-[95] flex items-center justify-center bg-[rgba(8,16,30,0.62)] px-4 py-6 backdrop-blur-[4px]">
          <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-[28px] border border-white/70 bg-[linear-gradient(180deg,#ffffff_0%,#f8fbff_100%)] p-6 shadow-[0_30px_90px_rgba(15,23,42,0.28)]">
            <div className="flex flex-col gap-3 border-b border-[var(--line)] pb-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--ink-soft)]">Admin action</p>
                <h4 className="mt-2 text-2xl font-semibold text-[var(--ink)]">{dialogTitle}</h4>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">{dialogDescription}</p>
              </div>
              <button type="button" onClick={closeActionDialog} disabled={busy} className="rounded-[14px] border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-50">
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <div className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Student</p>
                <p className="mt-2 text-sm font-semibold text-[var(--ink)]">{actionDialog.studentLabel || studentDetails?.student.name || 'Not selected'}</p>
              </div>
              <div className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Course</p>
                <p className="mt-2 text-sm font-semibold text-[var(--ink)]">{selectedDialogCourseLabel}</p>
              </div>
              <div className="rounded-[18px] bg-[var(--accent-cream)] px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Reference</p>
                <p className="mt-2 break-all text-sm font-semibold text-[var(--ink)]">{actionDialog.reference || actionDialog.gatewayPaymentId || actionDialog.gatewayOrderId || actionDialog.paymentId || 'NA'}</p>
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {(actionDialog.mode === 'grant-access' || actionDialog.mode === 'revoke-access' || actionDialog.mode === 'extend-validity' || actionDialog.mode === 'disable-access' || actionDialog.mode === 'repair-access') && (
                <label className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Course</span>
                  <select
                    value={actionForm.courseId}
                    onChange={(event) => updateActionForm('courseId', event.target.value)}
                    disabled={busy || actionDialog.mode === 'revoke-access' || actionDialog.mode === 'extend-validity' || actionDialog.mode === 'disable-access' || actionDialog.mode === 'repair-access'}
                    className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-white px-4 text-sm text-[var(--ink)] outline-none disabled:bg-slate-100"
                  >
                    <option value="">Select course</option>
                    {dialogCourseOptions.map((course) => (
                      <option key={course.id} value={course.id}>{course.title}</option>
                    ))}
                  </select>
                </label>
              )}

              {(actionDialog.mode === 'grant-access' || actionDialog.mode === 'extend-validity') && (
                <label className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">
                    {actionDialog.mode === 'grant-access' ? 'Expiry date and time' : 'New expiry date and time'}
                  </span>
                  <input
                    type="datetime-local"
                    value={actionForm.validUntil}
                    onChange={(event) => updateActionForm('validUntil', event.target.value)}
                    disabled={busy}
                    className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-white px-4 text-sm text-[var(--ink)] outline-none"
                  />
                </label>
              )}

              {actionDialog.mode === 'reset-password' && (
                <label className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">New password</span>
                  <input
                    type="text"
                    value={actionForm.password}
                    onChange={(event) => updateActionForm('password', event.target.value)}
                    disabled={busy}
                    placeholder="Enter the new student password"
                    className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-white px-4 text-sm text-[var(--ink)] outline-none"
                  />
                </label>
              )}

              {actionDialog.mode === 'bulk-sync' && (
                <label className="space-y-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Max records</span>
                  <input
                    type="number"
                    min={1}
                    max={5000}
                    value={actionForm.maxRecords}
                    onChange={(event) => updateActionForm('maxRecords', event.target.value)}
                    disabled={busy}
                    className="h-12 w-full rounded-[16px] border border-[var(--line)] bg-white px-4 text-sm text-[var(--ink)] outline-none"
                  />
                </label>
              )}

              <label className={`space-y-2 ${actionDialog.mode === 'bulk-sync' ? 'md:col-span-2' : ''}`}>
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ink-soft)]">Admin note</span>
                <textarea
                  rows={actionDialog.mode === 'grant-access' ? 5 : 4}
                  value={actionForm.note}
                  onChange={(event) => updateActionForm('note', event.target.value)}
                  disabled={busy}
                  placeholder={
                    actionDialog.mode === 'grant-access'
                      ? 'Why are you granting access? Example: verified support proof, but do not mark payment success here.'
                      : 'Add a short reason for this admin action.'
                  }
                  className="w-full rounded-[18px] border border-[var(--line)] bg-white px-4 py-3 text-sm text-[var(--ink)] outline-none"
                />
              </label>
            </div>

            {actionDialog.mode === 'grant-access' && (
              <div className="mt-4 rounded-[18px] border border-[#d7e3ff] bg-[#f4f8ff] px-4 py-3 text-sm text-[var(--ink)]">
                This action creates or updates course access only. It does not mark a payment successful and it does not change Razorpay verification.
              </div>
            )}

            {(actionDialog.mode === 'sync-payment' || actionDialog.mode === 'manual-review') && (
              <div className="mt-4 rounded-[18px] border border-[#d7e3ff] bg-[#f4f8ff] px-4 py-3 text-sm text-[var(--ink)]">
                {actionDialog.mode === 'sync-payment'
                  ? 'The sync will re-read Razorpay payment and order details for this record and then refresh admin counts.'
                  : 'Use manual review for unsafe or incomplete payment records instead of forcing access blindly.'}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
              <button type="button" onClick={closeActionDialog} disabled={busy} className="rounded-[14px] border border-[var(--line)] px-4 py-3 text-sm font-semibold text-[var(--ink)] disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={() => void submitActionDialog()} disabled={busy} className="rounded-[14px] bg-[var(--ink)] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
                {dialogPrimaryLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
