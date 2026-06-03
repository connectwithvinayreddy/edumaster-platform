import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  assertMutationAllowed,
  certificationModeSummary,
  isProdSafeExistingDataMode,
  requireValueInProdSafeMode,
} from './certification-mode.js';
import { config } from './config.js';
import { qaFetch } from './network.js';
import { selectors } from './selectors.js';
import { CaptureRecord, FailureRecord } from './types.js';
import { artifactPath, createRunContext, sleep, writeJson, writeText } from './utils.js';

const apiOrigin = (() => {
  const url = new URL(config.baseUrl);
  if (url.hostname === '10.0.2.2') {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
})();

const chromePath = process.env.QA_CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const adminEmail = process.env.QA_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@varoonenglish.com';
const adminPassword = process.env.QA_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const PROD_SAFE_MODE = isProdSafeExistingDataMode();
const existingLockedEmail = String(process.env.QA_MOCK_ACCESS_LOCKED_EMAIL || '').trim();
const existingLockedPassword = String(process.env.QA_MOCK_ACCESS_LOCKED_PASSWORD || process.env.QA_LOGIN_PASSWORD || '').trim();
const existingEnrolledEmail = String(process.env.QA_MOCK_ACCESS_ENROLLED_EMAIL || '').trim();
const existingEnrolledPassword = String(process.env.QA_MOCK_ACCESS_ENROLLED_PASSWORD || process.env.QA_LOGIN_PASSWORD || '').trim();
const existingCourseId = String(process.env.QA_MOCK_ACCESS_COURSE_ID || '').trim();
const existingTestId = String(process.env.QA_MOCK_ACCESS_TEST_ID || '').trim();

type AuthSession = {
  token: string;
  user: { _id: string; email: string; role: string; name: string };
};

type CourseRecord = {
  _id: string;
  title: string;
  category?: string;
  exam?: string;
  subject?: string;
  price?: number;
  offerPercentage?: number;
};

type TestRecord = {
  _id: string;
  title: string;
  type?: string;
  course?: string | null;
  questions?: Array<{ id?: string }>;
};

const registerStudent = async (label: string) => {
  assertMutationAllowed('Registering synthetic mock access review students');
  const email = `qa.${label}+${Date.now()}@local.test`;
  const response = await qaFetch(new URL('/backend/api/auth/register', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `QA ${label} Student`,
      email,
      password: 'Student@123',
      device: `qa-${label}`,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.token) {
    throw new Error(`Unable to register ${label} student: ${JSON.stringify(payload)}`);
  }
  return payload as AuthSession;
};

const login = async (email: string, password: string, device: string) => {
  const response = await qaFetch(new URL('/backend/api/auth/login', apiOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      device,
      forceLogoutOtherSessions: true,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.token) {
    throw new Error(`Unable to login ${email}: ${JSON.stringify(payload)}`);
  }
  return payload as AuthSession;
};

const apiRequest = async <T>(pathname: string, token: string, init: RequestInit = {}) => {
  const response = await qaFetch(new URL(pathname, apiOrigin), {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload: payload as T };
};

const ensurePaidCourse = async (token: string) => {
  const { response, payload } = await apiRequest<CourseRecord[]>('/backend/api/courses/admin/list', token);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error('Unable to load admin course list for mock access review.');
  }

  if (PROD_SAFE_MODE) {
    requireValueInProdSafeMode('QA_MOCK_ACCESS_COURSE_ID', existingCourseId);
  }

  const paidCourse = existingCourseId
    ? payload.find((course) => course._id === existingCourseId)
    : payload.find((course) => Number(course.price || 0) > 0);
  if (!paidCourse) {
    throw new Error('No paid course is available for mock access review.');
  }

  return paidCourse;
};

const ensureLinkedMockTest = async (token: string, course: CourseRecord) => {
  const { response, payload } = await apiRequest<TestRecord[]>('/backend/api/tests', token);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error('Unable to load tests for mock access review.');
  }

  if (PROD_SAFE_MODE) {
    requireValueInProdSafeMode('QA_MOCK_ACCESS_TEST_ID', existingTestId);
  }

  const existing = existingTestId
    ? payload.find((test) => test._id === existingTestId)
    : payload.find((test) => test.course === course._id && String(test.type || '').includes('full'));
  if (existing) {
    if (existing.course && existing.course !== course._id) {
      throw new Error(`QA_MOCK_ACCESS_TEST_ID=${existing._id} is not linked to QA_MOCK_ACCESS_COURSE_ID=${course._id}.`);
    }
    return existing;
  }

  assertMutationAllowed('Creating linked mock tests for mock access review');
  const createResponse = await apiRequest<TestRecord>('/backend/api/tests', token, {
    method: 'POST',
    body: JSON.stringify({
      title: `${course.title} Mock Test QA`,
      description: `QA mock linked to ${course.title}`,
      category: course.category || course.exam || 'SSC JE',
      type: 'full-length',
      durationMinutes: 10,
      totalMarks: 1,
      negativeMarking: 0.25,
      course: course._id,
      questions: [
        {
          id: 'qa-question-1',
          question: 'Capital of India?',
          options: ['Delhi', 'Mumbai', 'Kolkata', 'Chennai'],
          correctOption: 0,
          marks: 1,
          explanation: 'Delhi is the capital.',
        },
      ],
    }),
  });

  if (!createResponse.response.ok || !createResponse.payload?._id) {
    throw new Error(`Unable to create linked mock test: ${JSON.stringify(createResponse.payload)}`);
  }

  return createResponse.payload;
};

const grantCourseAccess = async (adminToken: string, studentId: string, courseId: string) => {
  assertMutationAllowed('Granting course access for mock access review');
  const { response, payload } = await apiRequest('/backend/api/admin/purchases/assign-course', adminToken, {
    method: 'POST',
    body: JSON.stringify({
      studentId,
      courseId,
      adminNote: 'QA mock course access review manual grant',
    }),
  });

  if (!response.ok) {
    throw new Error(`Unable to grant QA student course access: ${JSON.stringify(payload)}`);
  }
};

const takeScreenshot = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  stepId: string,
  label: string,
) => {
  const screenshotPath = artifactPath(ctx.screenshotDir, stepId, label, 'png');
  const sourcePath = artifactPath(ctx.sourceDir, stepId, label, 'html');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(sourcePath, await page.content(), 'utf8');
  return { screenshotPath, sourcePath };
};

const storeAuthToken = async (page: puppeteer.Page, token: string) => {
  await page.evaluateOnNewDocument((jwt) => window.localStorage.setItem('edumaster.jwt', jwt), token);
};

const storeSessionAndLoadShell = async (page: puppeteer.Page, token: string) => {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
  await storeAuthToken(page, token);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
  await page.waitForSelector(selectors.shellReady, { timeout: 30000 });
};

const clickFirstVisible = async (page: puppeteer.Page, selectorOptions: string[]) => {
  for (const selector of selectorOptions) {
    const clicked = await page.evaluate((targetSelector) => {
      const elements = [...document.querySelectorAll(targetSelector)] as HTMLElement[];
      for (const element of elements) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
          continue;
        }

        element.scrollIntoView({ block: 'center', inline: 'nearest' });
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    }, selector);

    if (clicked) {
      return;
    }
  }

  throw new Error(`No interactable selector found from: ${selectorOptions.join(', ')}`);
};

const captureLearnerState = async (
  page: puppeteer.Page,
  ctx: Awaited<ReturnType<typeof createRunContext>>,
  captures: CaptureRecord[],
  label: string,
  token: string,
) => {
  await page.setViewport({ width: 1536, height: 1024, deviceScaleFactor: 1 });
  await storeSessionAndLoadShell(page, token);
  await page.waitForSelector(selectors.overviewDashboard, { timeout: 30000 });
  const overviewPaths = await takeScreenshot(page, ctx, `${label}-overview`, `${label}-overview`);
  captures.push({
    stepId: `${label}-overview`,
    label: `${label}-overview`,
    state: 'ui',
    durationMs: 0,
    screenshotPath: overviewPaths.screenshotPath,
    sourcePath: overviewPaths.sourcePath,
    timestamp: new Date().toISOString(),
  });

  await clickFirstVisible(page, [selectors.navTests, selectors.mobileNavTests]);
  await sleep(1000);
  const testPaths = await takeScreenshot(page, ctx, `${label}-tests`, `${label}-tests`);
  captures.push({
    stepId: `${label}-tests`,
    label: `${label}-tests`,
    state: 'ui',
    durationMs: 0,
    screenshotPath: testPaths.screenshotPath,
    sourcePath: testPaths.sourcePath,
    timestamp: new Date().toISOString(),
  });
};

export const runMockCourseAccessReview = async (): Promise<{ captures: CaptureRecord[]; failures: FailureRecord[] }> => {
  if (!adminPassword) {
    throw new Error('QA_ADMIN_PASSWORD or ADMIN_PASSWORD must be set for mock access review.');
  }
  if (PROD_SAFE_MODE) {
    requireValueInProdSafeMode('QA_MOCK_ACCESS_LOCKED_EMAIL', existingLockedEmail);
    requireValueInProdSafeMode('QA_MOCK_ACCESS_LOCKED_PASSWORD', existingLockedPassword);
    requireValueInProdSafeMode('QA_MOCK_ACCESS_ENROLLED_EMAIL', existingEnrolledEmail);
    requireValueInProdSafeMode('QA_MOCK_ACCESS_ENROLLED_PASSWORD', existingEnrolledPassword);
    requireValueInProdSafeMode('QA_MOCK_ACCESS_COURSE_ID', existingCourseId);
    requireValueInProdSafeMode('QA_MOCK_ACCESS_TEST_ID', existingTestId);
  }

  const ctx = await createRunContext();
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];

  const admin = await login(adminEmail, adminPassword, 'qa-admin-mock-access');
  const paidCourse = await ensurePaidCourse(admin.token);
  const linkedMock = await ensureLinkedMockTest(admin.token, paidCourse);

  const lockedStudent = PROD_SAFE_MODE
    ? await login(existingLockedEmail, existingLockedPassword, 'qa-mock-access-locked')
    : await registerStudent('locked');
  const enrolledStudent = PROD_SAFE_MODE
    ? await login(existingEnrolledEmail, existingEnrolledPassword, 'qa-mock-access-enrolled')
    : await registerStudent('enrolled');
  if (!PROD_SAFE_MODE) {
    await grantCourseAccess(admin.token, enrolledStudent.user._id, paidCourse._id);
  }

  const lockedTests = await apiRequest<TestRecord[]>('/backend/api/tests', lockedStudent.token);
  const enrolledTests = await apiRequest<TestRecord[]>('/backend/api/tests', enrolledStudent.token);
  const lockedDetail = await apiRequest(`/backend/api/tests/${linkedMock._id}`, lockedStudent.token);
  const enrolledDetail = await apiRequest(`/backend/api/tests/${linkedMock._id}`, enrolledStudent.token);

  if ((lockedTests.payload || []).some((test) => test._id === linkedMock._id)) {
    failures.push({
      stepId: 'locked-backend-tests',
      title: 'Locked learner can see linked mock test',
      description: `The locked learner ${lockedStudent.user.email} received ${linkedMock.title} in GET /backend/api/tests before buying ${paidCourse.title}.`,
      severity: 'critical',
      timestamp: new Date().toISOString(),
    });
  }

  if (!(enrolledTests.payload || []).some((test) => test._id === linkedMock._id)) {
    failures.push({
      stepId: 'enrolled-backend-tests',
      title: 'Enrolled learner cannot see linked mock test',
      description: `The enrolled learner ${enrolledStudent.user.email} did not receive ${linkedMock.title} in GET /backend/api/tests after enrollment in ${paidCourse.title}.`,
      severity: 'critical',
      timestamp: new Date().toISOString(),
    });
  }

  if (lockedDetail.response.status === 200) {
    failures.push({
      stepId: 'locked-backend-detail',
      title: 'Locked learner can open linked mock test directly',
      description: `GET /backend/api/tests/${linkedMock._id} returned 200 for locked learner ${lockedStudent.user.email}.`,
      severity: 'critical',
      timestamp: new Date().toISOString(),
    });
  }

  if (enrolledDetail.response.status !== 200) {
    failures.push({
      stepId: 'enrolled-backend-detail',
      title: 'Enrolled learner cannot open linked mock test directly',
      description: `GET /backend/api/tests/${linkedMock._id} returned ${enrolledDetail.response.status} for enrolled learner ${enrolledStudent.user.email}.`,
      severity: 'critical',
      timestamp: new Date().toISOString(),
    });
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  try {
    const lockedPage = await browser.newPage();
    await captureLearnerState(lockedPage, ctx, captures, 'locked-learner', lockedStudent.token);
    await lockedPage.close();

    const enrolledPage = await browser.newPage();
    await captureLearnerState(enrolledPage, ctx, captures, 'enrolled-learner', enrolledStudent.token);
    await enrolledPage.close();
  } finally {
    await browser.close().catch(() => undefined);
  }

  await writeJson(path.join(ctx.analysisDir, 'summary.json'), {
    certificationMode: certificationModeSummary(),
    captures,
    failures,
    evidence: {
      paidCourse: {
        id: paidCourse._id,
        title: paidCourse.title,
        price: paidCourse.price,
        offerPercentage: paidCourse.offerPercentage || 0,
      },
      linkedMock: {
        id: linkedMock._id,
        title: linkedMock.title,
        courseId: linkedMock.course,
      },
      lockedLearner: {
        email: lockedStudent.user.email,
        testsVisible: Array.isArray(lockedTests.payload) ? lockedTests.payload.length : null,
        detailStatus: lockedDetail.response.status,
      },
      enrolledLearner: {
        email: enrolledStudent.user.email,
        testsVisible: Array.isArray(enrolledTests.payload) ? enrolledTests.payload.length : null,
        detailStatus: enrolledDetail.response.status,
      },
    },
  });
  await writeText(
    path.join(ctx.logDir, 'run.log'),
    [
      `Run ${ctx.runId}`,
      `Paid course: ${paidCourse.title} (${paidCourse._id})`,
      `Linked mock: ${linkedMock.title} (${linkedMock._id})`,
      `Locked learner: ${lockedStudent.user.email}`,
      `Enrolled learner: ${enrolledStudent.user.email}`,
      `Failures: ${failures.length}`,
    ].join('\n'),
  );

  if (failures.length > 0) {
    throw new Error(failures.map((failure) => `${failure.title}: ${failure.description}`).join('\n'));
  }

  return { captures, failures };
};

if (process.argv[1]?.endsWith('mock-course-access-review.ts')) {
  runMockCourseAccessReview()
    .then((summary) => {
      console.log(`Mock access review complete: ${summary.captures.length} captures, ${summary.failures.length} failures.`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
