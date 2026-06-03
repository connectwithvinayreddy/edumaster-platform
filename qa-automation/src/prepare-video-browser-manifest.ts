import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  assertMutationAllowed,
  certificationModeSummary,
  isProdSafeExistingDataMode,
  requireValueInProdSafeMode,
} from './certification-mode.js';

const workspaceRoot = path.resolve(process.cwd(), path.basename(process.cwd()) === 'qa-automation' ? '..' : '.');
dotenv.config({ path: path.join(workspaceRoot, '.env') });

type AdminStudent = {
  studentId: string;
  name: string;
  email: string;
  accountStatus?: string | null;
  activeCourseAccessCount?: number;
  createdAt?: string | null;
};

type AdminCourseAccessRecord = {
  studentId?: string | null;
  courseId?: string | null;
  accessStatus?: string | null;
  validUntil?: string | null;
};

type PreparedUser = {
  index: number;
  email: string;
  token: string;
  userId: string | null;
  name: string;
};

type PaginatedItemsResponse<TItem> = {
  items?: TItem[];
  pagination?: {
    page?: number;
    pageSize?: number;
    total?: number;
    totalPages?: number;
  };
};

const baseUrl = (process.env.QA_BASE_URL || 'https://app.varonenglishapp.in').replace(/\/+$/, '');
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const userPassword = process.env.PLATFORM_LOAD_USER_PASSWORD || 'Student@123';
const courseId = String(process.env.QA_COURSE_ID || process.env.PLATFORM_LOAD_COURSE_ID || 'course_d6cb25587e594d3bbb75b58597770ff2').trim();
const requestedUsers = Math.max(1, Number(process.env.QA_VIDEO_BROWSER_MANIFEST_USERS || 50));
const preparationConcurrency = Math.max(1, Number(process.env.QA_VIDEO_BROWSER_MANIFEST_CONCURRENCY || 8));
const adminPreparationConcurrency = Math.max(1, Number(process.env.QA_VIDEO_BROWSER_ADMIN_CONCURRENCY || 1));
const adminListPageSize = Math.max(25, Math.min(100, Number(process.env.QA_VIDEO_BROWSER_ADMIN_PAGE_SIZE || 100)));
const outputPath = path.resolve(process.cwd(), process.env.QA_VIDEO_BROWSER_MANIFEST_PATH || `reports/video-browser-manifest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const syntheticUserPrefix = String(process.env.QA_VIDEO_BROWSER_USER_PREFIX || 'qa.video.browser.').trim().toLowerCase();
const syntheticUserDomain = String(process.env.QA_VIDEO_BROWSER_USER_DOMAIN || 'edumaster.local').trim().toLowerCase();
const existingUsersFile = String(
  process.env.QA_VIDEO_BROWSER_EXISTING_USERS_FILE
  || process.env.PLATFORM_LOAD_USERS_FILE
  || process.env.COURSE_LOAD_USERS_FILE
  || process.env.ACTIVE_100_USERS_FILE
  || '',
).trim();
const refreshExistingTokens = String(
  process.env.QA_VIDEO_BROWSER_REFRESH_EXISTING_TOKENS
  || (isProdSafeExistingDataMode() ? 'false' : 'true'),
).toLowerCase() !== 'false';
const skipPasswordReset = String(process.env.QA_VIDEO_BROWSER_SKIP_PASSWORD_RESET || 'false').toLowerCase() === 'true';
const skipLoginPhase = String(process.env.QA_VIDEO_BROWSER_SKIP_LOGIN || 'false').toLowerCase() === 'true';
const loginRetryMax = Math.max(0, Number(process.env.QA_VIDEO_BROWSER_LOGIN_RETRY_MAX || 5));
const forceLogoutOtherSessions = String(
  process.env.QA_VIDEO_BROWSER_FORCE_LOGOUT_OTHER_SESSIONS
  || (isProdSafeExistingDataMode() ? 'false' : 'true'),
).toLowerCase() === 'true';

const isSafeSyntheticEmail = (email: string) => /^(qa\.|automation\.|platform_load_)/i.test(String(email || '').trim())
  || /@edumaster\.local$/i.test(String(email || '').trim());

const syntheticEmailForIndex = (index: number) =>
  `${syntheticUserPrefix}${String(index + 1).padStart(4, '0')}@${syntheticUserDomain}`;

const normalizeEmail = (value: string) => String(value || '').trim().toLowerCase();

const buildSyntheticMobileNumber = (index: number, attempt = 0) => {
  const baseSeed = BigInt(Date.now()) + BigInt(index * 17) + BigInt(attempt * 1009);
  const digits = String(baseSeed).replace(/\D/g, '').slice(-9).padStart(9, '0');
  return `9${digits}`;
};

const fetchJson = async <T = unknown>(pathname: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, baseUrl), init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`${pathname} failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`) as Error & {
      status?: number;
      payload?: unknown;
    };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload as T;
};

const loginAdmin = async () => {
  if (!adminEmail || !adminPassword) {
    throw new Error('QA_ADMIN_EMAIL and QA_ADMIN_PASSWORD are required.');
  }
  const payload = await fetchJson<{ token: string }>('/backend/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      device: 'qa-video-browser-manifest-admin',
      forceLogoutOtherSessions: true,
    }),
  });
  return payload.token;
};

let activeAdminToken = '';
let adminTokenRefreshPromise: Promise<string> | null = null;

const refreshAdminToken = async () => {
  if (!adminTokenRefreshPromise) {
    adminTokenRefreshPromise = loginAdmin()
      .then((token) => {
        activeAdminToken = token;
        return token;
      })
      .finally(() => {
        adminTokenRefreshPromise = null;
      });
  }
  return adminTokenRefreshPromise;
};

const getAdminToken = async () => {
  if (!activeAdminToken) {
    return refreshAdminToken();
  }
  return activeAdminToken;
};

const adminFetch = async <T = unknown>(pathname: string, init: RequestInit = {}) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = await getAdminToken();
    try {
      return await fetchJson<T>(pathname, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: number }).status || 0) : 0;
      if (status === 401 && attempt < 2) {
        await refreshAdminToken();
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Unable to complete admin request for ${pathname}`);
};

const listAllStudentsForPrefix = async () => {
  const students = new Map<string, AdminStudent>();
  let page = 1;
  let totalPages = 1;

  do {
    const payload = await adminFetch<PaginatedItemsResponse<AdminStudent>>(
      `/backend/api/admin/students?page=${page}&pageSize=${adminListPageSize}&search=${encodeURIComponent(syntheticUserPrefix)}`,
    );
    for (const item of payload.items || []) {
      const email = normalizeEmail(item.email || '');
      if (!email.startsWith(syntheticUserPrefix) || !email.endsWith(`@${syntheticUserDomain}`)) {
        continue;
      }
      students.set(email, {
        ...item,
        email,
        studentId: String(item.studentId || ''),
        name: String(item.name || ''),
      });
    }
    totalPages = Math.max(1, Number(payload.pagination?.totalPages || 1));
    page += 1;
  } while (page <= totalPages);

  return students;
};

const listEnabledCourseAccessStudentIds = async () => {
  const enabledStudentIds = new Set<string>();
  let page = 1;
  let totalPages = 1;

  do {
    const payload = await adminFetch<PaginatedItemsResponse<AdminCourseAccessRecord>>(
      `/backend/api/admin/course-access?page=${page}&pageSize=${adminListPageSize}&courseId=${encodeURIComponent(courseId)}`,
    );
    for (const item of payload.items || []) {
      if (String(item.courseId || '') !== courseId) {
        continue;
      }
      if (String(item.accessStatus || '').toLowerCase() !== 'enabled') {
        continue;
      }
      const studentId = String(item.studentId || '').trim();
      if (studentId) {
        enabledStudentIds.add(studentId);
      }
    }
    totalPages = Math.max(1, Number(payload.pagination?.totalPages || 1));
    page += 1;
  } while (page <= totalPages);

  return enabledStudentIds;
};

const createStudent = async (index: number) => {
  assertMutationAllowed('Creating synthetic browser-manifest students');
  const email = syntheticEmailForIndex(index);
  const name = `QA Video Browser ${String(index + 1).padStart(4, '0')}`;
  let payload: AdminStudent | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      payload = await adminFetch<AdminStudent>('/backend/api/admin/students', {
        method: 'POST',
        body: JSON.stringify({
          name,
          email,
          mobileNumber: buildSyntheticMobileNumber(index, attempt),
          password: userPassword,
        }),
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/MOBILE_EXISTS/i.test(message) && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
  if (!payload) {
    throw new Error(`Unable to create synthetic student after retries: ${email}`);
  }
  return {
    studentId: String((payload as any)._id || (payload as any).studentId || ''),
    name: String((payload as any).name || name),
    email,
    accountStatus: 'active',
  } satisfies AdminStudent;
};

const ensureActiveStudent = async (student: AdminStudent) => {
  if (!isSafeSyntheticEmail(student.email)) {
    throw new Error(`Refusing to prepare non-synthetic user for browser load: ${student.email}`);
  }

  if ((student.accountStatus || 'active') !== 'active') {
    assertMutationAllowed('Activating existing students for browser-manifest preparation');
    await adminFetch(`/backend/api/admin/students/${encodeURIComponent(student.studentId)}/status`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'active',
        note: 'QA browser video cohort activation',
      }),
    });
  }

  if (!skipPasswordReset) {
    assertMutationAllowed('Resetting passwords for browser-manifest preparation');
    await adminFetch(`/backend/api/admin/students/${encodeURIComponent(student.studentId)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({
        newPassword: userPassword,
        reason: 'QA browser video cohort password reset',
      }),
    });
  }

  return {
    ...student,
    accountStatus: 'active',
  } satisfies AdminStudent;
};

const ensureSyntheticStudents = async (
  existingStudentsByEmail: Map<string, AdminStudent>,
) => mapWithConcurrency(
  Array.from({ length: requestedUsers }, (_, index) => index),
  adminPreparationConcurrency,
  async (index) => {
    const email = syntheticEmailForIndex(index);
    const existing = existingStudentsByEmail.get(normalizeEmail(email)) || null;
    const student = existing || await createStudent(index);
    const activated = await ensureActiveStudent(student);
    if (!activated?.studentId) {
      throw new Error(`Unable to verify synthetic student after preparation: ${email}`);
    }
    existingStudentsByEmail.set(normalizeEmail(email), activated);
    if ((index + 1) % 25 === 0 || index + 1 === requestedUsers) {
      console.log(`[prepare] ensured ${index + 1}/${requestedUsers} synthetic students`);
    }
    return activated;
  },
);

const ensureCourseAccess = async (
  student: AdminStudent,
  enabledStudentIds: Set<string>,
) => {
  if (enabledStudentIds.has(student.studentId)) {
    return;
  }
  assertMutationAllowed('Granting course access for browser-manifest preparation');
  await adminFetch('/backend/api/admin/purchases/assign-course', {
    method: 'POST',
    body: JSON.stringify({
      studentId: student.studentId,
      courseId,
      adminNote: 'QA browser video cohort access grant',
    }),
  });
  enabledStudentIds.add(student.studentId);
};

const loginStudent = async (student: AdminStudent) => {
  const attemptLogin = async (logoutOthers: boolean) => fetchJson<{ token: string; user?: { _id?: string } }>('/backend/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: student.email,
      password: userPassword,
      device: 'qa-video-browser-manifest-student',
      forceLogoutOtherSessions: logoutOthers,
    }),
  });

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= loginRetryMax; attempt += 1) {
    try {
      const payload = await attemptLogin(forceLogoutOtherSessions);
      return {
        email: student.email,
        token: payload.token,
        userId: payload.user?._id || student.studentId,
        name: student.name,
      };
    } catch (error) {
      lastError = error;
      let status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: number }).status || 0) : 0;
      let message = error instanceof Error ? error.message : String(error);
      const payloadCode = typeof error === 'object' && error && 'payload' in error
        ? String((error as { payload?: { code?: string } }).payload?.code || '')
        : '';
      if (status === 409 && payloadCode === 'SESSION_ACTIVE' && !forceLogoutOtherSessions) {
        try {
          const payload = await attemptLogin(true);
          return {
            email: student.email,
            token: payload.token,
            userId: payload.user?._id || student.studentId,
            name: student.name,
          };
        } catch (forcedLoginError) {
          lastError = forcedLoginError;
          status = typeof forcedLoginError === 'object' && forcedLoginError && 'status' in forcedLoginError
            ? Number((forcedLoginError as { status?: number }).status || 0)
            : 0;
          message = forcedLoginError instanceof Error ? forcedLoginError.message : String(forcedLoginError);
        }
      }
      const retryable = attempt < loginRetryMax && (status === 429 || /too many requests|fetch failed|timeout|network/i.test(message));
      if (!retryable) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, status === 429 ? 2_000 * (attempt + 1) : 750 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to login synthetic student ${student.email}`);
};

const mapWithConcurrency = async <TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
) => {
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));

  return results;
};

const loadExistingPreparedUsers = async (): Promise<PreparedUser[]> => {
  requireValueInProdSafeMode('QA_VIDEO_BROWSER_EXISTING_USERS_FILE', existingUsersFile);
  if (!existingUsersFile) {
    throw new Error('QA_VIDEO_BROWSER_EXISTING_USERS_FILE, PLATFORM_LOAD_USERS_FILE, or COURSE_LOAD_USERS_FILE is required to reuse existing browser-manifest users.');
  }
  const resolvedPath = path.isAbsolute(existingUsersFile)
    ? existingUsersFile
    : path.resolve(process.cwd(), existingUsersFile);
  const payload = JSON.parse(await fs.readFile(resolvedPath, 'utf8')) as PreparedUser[];
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`Existing browser-manifest user file is empty: ${resolvedPath}`);
  }
  if (payload.length < requestedUsers) {
    throw new Error(`Existing browser-manifest user file has ${payload.length} users, but ${requestedUsers} were requested.`);
  }

  const selected = payload.slice(0, requestedUsers);
  if (!refreshExistingTokens) {
    return selected;
  }

  return mapWithConcurrency(selected, preparationConcurrency, async (user, index) => {
    const loginPayload = await fetchJson<{ token: string; user?: { _id?: string } }>('/backend/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        password: userPassword,
        device: `qa-video-browser-manifest-existing-${index + 1}`,
        forceLogoutOtherSessions,
      }),
    });
    return {
      ...user,
      token: loginPayload.token,
      userId: loginPayload.user?._id || user.userId,
    };
  });
};

const main = async () => {
  const prepared = isProdSafeExistingDataMode()
    ? await loadExistingPreparedUsers()
    : await (async () => {
      activeAdminToken = await loginAdmin();
      const [existingStudentsByEmail, enabledStudentIds] = await Promise.all([
        listAllStudentsForPrefix(),
        listEnabledCourseAccessStudentIds(),
      ]);
      const students = await ensureSyntheticStudents(existingStudentsByEmail);
      const preparedStudents = await mapWithConcurrency(students, adminPreparationConcurrency, async (student, index) => {
        await ensureCourseAccess(student, enabledStudentIds);
        if ((index + 1) % 25 === 0 || index + 1 === students.length) {
          console.log(`[prepare] granted course access ${index + 1}/${students.length}`);
        }
        return {
          index,
          student,
        };
      });
      if (skipLoginPhase) {
        return preparedStudents.map(({ index, student }) => ({
          index,
          email: student.email,
          token: '',
          userId: student.studentId,
          name: student.name,
        } satisfies PreparedUser));
      }
      return mapWithConcurrency(preparedStudents, preparationConcurrency, async ({ index, student }) => {
        const loginPayload = await loginStudent(student);
        if ((index + 1) % 25 === 0 || index + 1 === preparedStudents.length) {
          console.log(`[prepare] logged in ${index + 1}/${preparedStudents.length} students`);
        }
        return {
          index,
          ...loginPayload,
        } satisfies PreparedUser;
      });
    })();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(prepared, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    ...certificationModeSummary(),
    requestedUsers,
    preparedUsers: prepared.length,
    courseId,
    outputPath,
    sampleEmail: prepared[0]?.email || null,
    userPrefix: syntheticUserPrefix,
    concurrency: preparationConcurrency,
    adminPreparationConcurrency,
    reusedExistingUsersFile: existingUsersFile || null,
    refreshExistingTokens,
    skipPasswordReset,
    skipLoginPhase,
    forceLogoutOtherSessions,
  }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
