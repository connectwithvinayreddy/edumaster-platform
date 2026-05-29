const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { startServer } = require('./server.cjs');
const { appConfig } = require('./lib/config.js');
const {
  usersRepository,
  coursesRepository,
  platformRepository,
  paymentRepository,
} = require('./lib/repositories.js');
const { getPool } = require('./lib/postgres.js');

const VIEWERS = Math.max(1, Number(process.env.AUDIT_VIEWERS || 500));
const MIXED_COURSES = Math.max(2, Number(process.env.AUDIT_MIXED_COURSES || 5));
const ENROLL_RACE_REQUESTS = Math.max(2, Number(process.env.AUDIT_ENROLL_RACE_REQUESTS || 50));
const PLAYER_RACE_REQUESTS = Math.max(2, Number(process.env.AUDIT_PLAYER_RACE_REQUESTS || 25));
const PROGRESS_RACE_REQUESTS = Math.max(2, Number(process.env.AUDIT_PROGRESS_RACE_REQUESTS || 20));
const PAYMENT_RETRY_REQUESTS = Math.max(2, Number(process.env.AUDIT_PAYMENT_RETRY_REQUESTS || 20));
const STREAM_VIEWERS = Math.max(1, Number(process.env.AUDIT_STREAM_VIEWERS || 200));
const STREAM_CONCURRENCY = Math.max(1, Number(process.env.AUDIT_STREAM_CONCURRENCY || STREAM_VIEWERS));
const REPLAY_MAX_VIEWS = Math.max(0, Number(appConfig.videoReplayMaxViews || 0));
const STREAM_CYCLES = Math.max(
  1,
  Number(process.env.AUDIT_STREAM_CYCLES || ((appConfig.videoReplayViewLimitEnabled && REPLAY_MAX_VIEWS > 0) ? REPLAY_MAX_VIEWS : 3)),
);
const STREAM_RANGE = process.env.AUDIT_STREAM_RANGE || 'bytes=0-65535';
const TARGET_PREP_TIMEOUT_MS = Number(process.env.AUDIT_TARGET_PREP_TIMEOUT_MS || 180000);
const REPORT_ROOT = path.join(process.cwd(), 'reports');

let baseUrl = null;

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const percentile = (values, target) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values) => values.length
  ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  : 0;

const timed = async (fn) => {
  const started = Date.now();
  const result = await fn();
  return {
    ms: Date.now() - started,
    result,
  };
};

const authTokenFor = (user) => jwt.sign(
  {
    id: user._id,
    role: user.role,
    session: user.session,
    email: user.email,
    name: user.name,
  },
  appConfig.jwtSecret,
  { expiresIn: '7d' },
);

const parseCookieHeader = (headers) => {
  if (!headers?.get) {
    return null;
  }

  const raw = headers.get('set-cookie');
  if (!raw) {
    return null;
  }

  const firstChunk = String(raw).split(/,(?=[^;]+?=)/)[0] || '';
  return firstChunk.split(';')[0] || null;
};

const requestDetailed = async (method, requestPath, body = null, token = null, isForm = false) => {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(!isForm && body ? { 'content-type': 'application/json' } : {}),
    },
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`${method} ${requestPath} failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return {
    payload,
    headers: response.headers,
    status: response.status,
    cookieHeader: parseCookieHeader(response.headers),
  };
};

const request = async (method, requestPath, body = null, token = null, isForm = false) =>
  (await requestDetailed(method, requestPath, body, token, isForm)).payload;

const runConcurrent = async (items, worker, concurrency = items.length) => {
  const queue = [...items];
  const results = [];
  const errors = [];

  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) {
        return;
      }

      try {
        results.push(await worker(item));
      } catch (error) {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          status: error?.status || null,
          payload: error?.payload || null,
        });
      }
    }
  });

  await Promise.all(runners);
  return { results, errors };
};

const createSyntheticUser = async ({ suffix, passwordHash, role = 'student' }) => {
  const user = await usersRepository.create({
    name: `Audit User ${suffix}`,
    email: `audit_${suffix}_${Date.now()}@edumaster.local`,
    password: passwordHash,
    role,
    session: `session_${suffix}_${Date.now()}`,
    device: `audit-device-${suffix}`,
  });

  return {
    ...user,
    token: authTokenFor(user),
  };
};

const buildYoutubeLesson = ({ lessonId, title, moduleId, order = 1 }) => ({
  id: lessonId,
  title,
  type: 'youtube',
  videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  durationMinutes: 30,
  order,
  moduleId,
  chapterId: null,
  isPreview: false,
});

const createCourseWithLessons = async ({ title, lessonIds, price = 0 }) => {
  const moduleId = `module_${Math.random().toString(36).slice(2, 10)}`;
  const course = await coursesRepository.create({
    title,
    description: 'Synthetic course for concurrency audit',
    category: 'SSC JE',
    exam: 'SSC JE',
    subject: 'Concurrency Audit',
    level: 'Full Course',
    price,
    validityDays: 365,
    instructor: 'Audit Bot',
    createdBy: 'concurrency-audit',
    modules: [{
      id: moduleId,
      title: 'Audit Module',
      description: 'Synthetic load module',
      chapters: [],
      lessons: lessonIds.map((lessonId, index) => buildYoutubeLesson({
        lessonId,
        title: `Lesson ${index + 1}`,
        moduleId,
        order: index + 1,
      })),
    }],
  });

  return {
    course,
    lessonIds,
  };
};

const findSampleVideoPath = () => {
  const candidates = [
    path.join(process.cwd(), 'uploads', 'videos'),
    path.join(process.cwd(), '..', 'uploads', 'videos'),
  ];

  for (const directory of candidates) {
    if (!fs.existsSync(directory)) {
      continue;
    }

    const match = fs.readdirSync(directory)
      .find((entry) => /\.(mp4|mov|mkv|webm)$/i.test(entry));
    if (match) {
      return path.join(directory, match);
    }
  }

  throw new Error('No sample video found in uploads/videos for private-video stream audit.');
};

const createPrivateVideoCourseTarget = async (adminToken, lessonTitle) => {
  const course = await request('POST', '/courses', {
    title: `Audit Stream Course ${Date.now()}`,
    description: 'Synthetic private-video stream audit course',
    category: 'SSC JE',
    exam: 'SSC JE',
    subject: 'Stream Audit',
    level: 'Full Course',
    price: 0,
    validityDays: 365,
    instructor: 'Audit Bot',
  }, adminToken);

  const sampleVideoPath = findSampleVideoPath();
  const fileBuffer = await fsp.readFile(sampleVideoPath);
  const fileName = path.basename(sampleVideoPath);
  const extension = path.extname(fileName).toLowerCase();
  const mimeType = extension === '.mkv'
    ? 'video/x-matroska'
    : extension === '.mov'
      ? 'video/quicktime'
      : extension === '.webm'
        ? 'video/webm'
        : 'video/mp4';

  const formData = new FormData();
  formData.append('lessonTitle', lessonTitle);
  formData.append('lessonType', 'private-video');
  formData.append('moduleName', 'Audit Stream Module');
  formData.append('durationMinutes', '180');
  formData.append('video', new Blob([fileBuffer], { type: mimeType }), fileName);

  const uploaded = await request(
    'POST',
    `/courses/${course._id}/modules/module_load/videos`,
    formData,
    adminToken,
    true,
  );

  return {
    courseId: course._id,
    lessonId: uploaded.video.id,
  };
};

const waitForStableLessonTarget = async ({ courseId, lessonId }) => {
  const started = Date.now();

  while (Date.now() - started < TARGET_PREP_TIMEOUT_MS) {
    const course = await coursesRepository.findById(courseId);
    const lesson = course
      ? (course.modules || [])
        .flatMap((module) => ([
          ...(module.lessons || []),
          ...((module.chapters || []).flatMap((chapter) => chapter.lessons || [])),
        ]))
        .find((entry) => String(entry.id) === String(lessonId))
      : null;

    if (!lesson) {
      throw new Error(`Audit private-video lesson ${lessonId} not found during preparation.`);
    }

    const hlsReady = lesson.deliveryStrategy === 'hls'
      && lesson.hlsProcessingStatus === 'ready'
      && lesson.hlsPlaybackPath;
    const sourceReady = Boolean(lesson.storagePath);
    const failedButUsable = lesson.hlsProcessingStatus === 'failed' && sourceReady;

    if (hlsReady || failedButUsable || (!lesson.hlsProcessingStatus && sourceReady)) {
      return lesson;
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for private-video lesson ${lessonId} to become playable.`);
};

const queryValue = async (sql, params = []) => {
  const pool = getPool();
  const result = await pool.query(sql, params);
  return result.rows;
};

const measurePlayerCall = async ({ token, courseId, lessonId }) => {
  const timedResult = await timed(() =>
    request('GET', `/courses/${courseId}/lessons/${lessonId}/player`, null, token));
  return {
    ms: timedResult.ms,
    result: timedResult.result,
  };
};

const fetchPrivateVideoPlayback = async ({ token, courseId, lessonId, userLabel = 'stream-user' }) => {
  const playerTimed = await timed(() =>
    requestDetailed('GET', `/courses/${courseId}/lessons/${lessonId}/player`, null, token));
  const player = playerTimed.result.payload;
  const cookieHeader = playerTimed.result.cookieHeader;
  const streamUrl = String(player?.streamUrl || '');

  if (!streamUrl) {
    throw new Error('Private video player did not return streamUrl');
  }

  if (player.streamFormat === 'hls') {
    const masterResponse = await timed(async () => {
      const response = await fetch(new URL(streamUrl, baseUrl.replace(/\/api$/, '')).toString(), {
        headers: {
          authorization: `Bearer ${token}`,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
      });
      if (!response.ok) {
        throw new Error(`Master manifest failed with ${response.status}`);
      }
      return await response.text();
    });

    const manifestEntries = String(masterResponse.result || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const mediaEntry = manifestEntries.find((entry) => entry.endsWith('.m3u8')) || manifestEntries[0];
    if (!mediaEntry) {
      throw new Error(`No media manifest found for ${userLabel}`);
    }

    const mediaUrl = new URL(mediaEntry, new URL(streamUrl, baseUrl.replace(/\/api$/, ''))).toString();
    const mediaResponse = await timed(async () => {
      const response = await fetch(mediaUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
      });
      if (!response.ok) {
        throw new Error(`Media manifest failed with ${response.status}`);
      }
      return await response.text();
    });

    const segmentEntry = String(mediaResponse.result || '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#') && !line.endsWith('.m3u8'));
    if (!segmentEntry) {
      throw new Error(`No media segment found for ${userLabel}`);
    }

    const segmentUrl = new URL(segmentEntry, mediaUrl).toString();
    const segmentResponse = await timed(async () => {
      const response = await fetch(segmentUrl, {
        headers: {
          authorization: `Bearer ${token}`,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
      });
      if (!response.ok && response.status !== 206) {
        throw new Error(`Segment fetch failed with ${response.status}`);
      }
      await response.arrayBuffer();
      return response.status;
    });

    return {
      playerMs: playerTimed.ms,
      manifestMs: masterResponse.ms + mediaResponse.ms,
      streamMs: segmentResponse.ms,
      streamStatus: segmentResponse.result,
      streamFormat: 'hls',
    };
  }

  const normalizedStreamPath = streamUrl.replace('/backend', '');
  const streamTimed = await timed(async () => {
    const response = await fetch(`${baseUrl.replace(/\/api$/, '')}${normalizedStreamPath}`, {
      headers: {
        authorization: `Bearer ${token}`,
        range: STREAM_RANGE,
      },
    });

    if (!response.ok && response.status !== 206) {
      const text = await response.text();
      throw new Error(`Source stream failed with ${response.status}: ${text}`);
    }

    await response.arrayBuffer();
    return response.status;
  });

  return {
    playerMs: playerTimed.ms,
    manifestMs: 0,
    streamMs: streamTimed.ms,
    streamStatus: streamTimed.result,
    streamFormat: 'source',
  };
};

const createReportDir = async () => {
  const reportDir = path.join(REPORT_ROOT, `concurrency-audit-${nowStamp()}`);
  await fsp.mkdir(reportDir, { recursive: true });
  return reportDir;
};

const summarizeLatency = (results) => {
  const durations = results.map((entry) => entry.ms);
  return {
    count: durations.length,
    avgMs: average(durations),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
  };
};

const addFinding = (findings, severity, title, details) => {
  findings.push({ severity, title, details });
};

const runAudit = async () => {
  const reportDir = await createReportDir();
  const findings = [];
  const summary = {
    generatedAt: new Date().toISOString(),
    config: {
      viewers: VIEWERS,
      mixedCourses: MIXED_COURSES,
      enrollRaceRequests: ENROLL_RACE_REQUESTS,
      playerRaceRequests: PLAYER_RACE_REQUESTS,
      progressRaceRequests: PROGRESS_RACE_REQUESTS,
      paymentRetryRequests: PAYMENT_RETRY_REQUESTS,
      streamViewers: STREAM_VIEWERS,
      streamConcurrency: STREAM_CONCURRENCY,
      streamCycles: STREAM_CYCLES,
    },
    cases: {},
    findings,
  };

  let serverHandle = null;

  try {
    const { server, databaseState } = await startServer({ port: 0, host: '127.0.0.1' });
    serverHandle = server;
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}/api`;
    summary.database = databaseState;

    const passwordHash = await bcrypt.hash('Student@123', 10);
    const adminLogin = await request('POST', '/auth/login', {
      email: appConfig.adminEmail,
      password: appConfig.adminPassword,
      device: 'audit-admin',
      forceLogoutOtherSessions: true,
    });

    const hotCourseSetup = await createCourseWithLessons({
      title: `Audit Hot Course ${Date.now()}`,
      lessonIds: ['audit_hot_lesson_1'],
    });

    const mixedCourseSetups = await Promise.all(
      Array.from({ length: MIXED_COURSES }, (_, index) =>
        createCourseWithLessons({
          title: `Audit Mixed Course ${Date.now()}_${index + 1}`,
          lessonIds: [`audit_mixed_lesson_${index + 1}`],
        })),
    );

    const sharedLessonId = `audit_shared_lesson_${Date.now()}`;
    const sharedLessonCourses = await Promise.all([
      createCourseWithLessons({
        title: `Audit Shared Lesson Course A ${Date.now()}`,
        lessonIds: [sharedLessonId],
      }),
      createCourseWithLessons({
        title: `Audit Shared Lesson Course B ${Date.now()}`,
        lessonIds: [sharedLessonId],
      }),
    ]);

    const enrollRaceUser = await createSyntheticUser({ suffix: 'enroll-race', passwordHash });
    const samePlayerUser = await createSyntheticUser({ suffix: 'player-race', passwordHash });
    const progressRaceUser = await createSyntheticUser({ suffix: 'progress-race', passwordHash });
    const sharedLessonUser = await createSyntheticUser({ suffix: 'shared-lesson', passwordHash });
    const paymentUser = await createSyntheticUser({ suffix: 'payment-race', passwordHash });
    const unauthorizedUser = await createSyntheticUser({ suffix: 'unauthorized', passwordHash });
    const sequentialUser = await createSyntheticUser({ suffix: 'sequential', passwordHash });

    const sequentialCourseSetup = await createCourseWithLessons({
      title: `Audit Sequential Course ${Date.now()}`,
      lessonIds: [`sequential_intro_${Date.now()}`, `sequential_locked_${Date.now()}`],
    });
    await platformRepository.enroll({
      userId: sequentialUser._id,
      courseId: sequentialCourseSetup.course._id,
      source: 'audit-setup',
    });

    const streamTarget = await createPrivateVideoCourseTarget(adminLogin.token, 'Audit Stream Lesson 1');
    await waitForStableLessonTarget(streamTarget);
    const streamUsers = await Promise.all(
      Array.from({ length: STREAM_VIEWERS }, (_, index) => createSyntheticUser({
        suffix: `stream-${index + 1}`,
        passwordHash,
      })),
    );
    await runConcurrent(streamUsers, (user) => platformRepository.enroll({
      userId: user._id,
      courseId: streamTarget.courseId,
      source: 'audit-setup',
    }), 25);
    const replayRuleUser = await createSyntheticUser({
      suffix: 'replay-rule',
      passwordHash,
    });
    await platformRepository.enroll({
      userId: replayRuleUser._id,
      courseId: streamTarget.courseId,
      source: 'audit-setup',
    });

    await platformRepository.enroll({
      userId: samePlayerUser._id,
      courseId: hotCourseSetup.course._id,
      source: 'audit-setup',
    });
    await platformRepository.enroll({
      userId: progressRaceUser._id,
      courseId: hotCourseSetup.course._id,
      source: 'audit-setup',
    });
    await platformRepository.enroll({
      userId: sharedLessonUser._id,
      courseId: sharedLessonCourses[0].course._id,
      source: 'audit-setup',
    });
    await platformRepository.enroll({
      userId: sharedLessonUser._id,
      courseId: sharedLessonCourses[1].course._id,
      source: 'audit-setup',
    });

    const hotUsers = await Promise.all(
      Array.from({ length: VIEWERS }, (_, index) => createSyntheticUser({
        suffix: `hot-${index + 1}`,
        passwordHash,
      })),
    );
    await runConcurrent(hotUsers, (user) => platformRepository.enroll({
      userId: user._id,
      courseId: hotCourseSetup.course._id,
      source: 'audit-setup',
    }), 25);

    const mixedUsers = await Promise.all(
      Array.from({ length: VIEWERS }, (_, index) => createSyntheticUser({
        suffix: `mixed-${index + 1}`,
        passwordHash,
      })),
    );
    const mixedEnrollAssignments = mixedUsers.map((user, index) => ({
      user,
      target: mixedCourseSetups[index % mixedCourseSetups.length],
    }));
    await runConcurrent(mixedEnrollAssignments, ({ user, target }) => {
      return platformRepository.enroll({
        userId: user._id,
        courseId: target.course._id,
        source: 'audit-setup',
      });
    }, 25);

    const enrollRaceAttempts = Array.from({ length: ENROLL_RACE_REQUESTS }, (_, index) => ({ index }));
    const enrollRace = await runConcurrent(
      enrollRaceAttempts,
      () => request('POST', '/platform/enroll', {
        courseId: hotCourseSetup.course._id,
        source: 'direct-access',
      }, enrollRaceUser.token),
      ENROLL_RACE_REQUESTS,
    );
    const enrollRows = await queryValue(
      'SELECT COUNT(*)::int AS count FROM enrollments WHERE user_id = $1 AND course_id = $2',
      [String(enrollRaceUser._id), String(hotCourseSetup.course._id)],
    );
    summary.cases.sameUserSameCourseEnrollRace = {
      requestCount: ENROLL_RACE_REQUESTS,
      successes: enrollRace.results.length,
      failures: enrollRace.errors,
      enrollmentRowCount: Number(enrollRows[0]?.count || 0),
    };
    if (Number(enrollRows[0]?.count || 0) !== 1) {
      addFinding(findings, 'high', 'Duplicate enrollment rows created under concurrent same-user enroll requests', summary.cases.sameUserSameCourseEnrollRace);
    }

    const samePlayerRace = await runConcurrent(
      Array.from({ length: PLAYER_RACE_REQUESTS }, (_, index) => ({ index })),
      () => measurePlayerCall({
        token: samePlayerUser.token,
        courseId: hotCourseSetup.course._id,
        lessonId: hotCourseSetup.lessonIds[0],
      }),
      PLAYER_RACE_REQUESTS,
    );
    const samePlayerGrantRows = await queryValue(
      'SELECT COUNT(*)::int AS count, MAX(used_views)::int AS max_used_views FROM video_access_grants WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
      [String(samePlayerUser._id), String(hotCourseSetup.course._id), String(hotCourseSetup.lessonIds[0])],
    );
    summary.cases.sameUserSameLessonPlayerRace = {
      requestCount: PLAYER_RACE_REQUESTS,
      successes: samePlayerRace.results.length,
      failures: samePlayerRace.errors,
      latency: summarizeLatency(samePlayerRace.results),
      grantRowCount: Number(samePlayerGrantRows[0]?.count || 0),
      maxUsedViews: Number(samePlayerGrantRows[0]?.max_used_views || 0),
    };
    if (samePlayerRace.errors.length > 0) {
      addFinding(findings, 'high', 'Concurrent same-user player requests produced failures', summary.cases.sameUserSameLessonPlayerRace);
    }

    const replayAuditUser = replayRuleUser;
    const replayAuditFirstOpen = await measurePlayerCall({
      token: replayAuditUser.token,
      courseId: streamTarget.courseId,
      lessonId: streamTarget.lessonId,
    });
    const replayAuditSecondOpenBeforeCompletion = await measurePlayerCall({
      token: replayAuditUser.token,
      courseId: streamTarget.courseId,
      lessonId: streamTarget.lessonId,
    });
    await request('POST', '/platform/watch-progress', {
      courseId: streamTarget.courseId,
      lessonId: streamTarget.lessonId,
      progressPercent: 100,
      progressSeconds: 60,
      completed: true,
      lessonStage: 'exam',
      videoWatchCount: 1,
    }, replayAuditUser.token);
    const replayAuditSecondWatchOpen = await measurePlayerCall({
      token: replayAuditUser.token,
      courseId: streamTarget.courseId,
      lessonId: streamTarget.lessonId,
    });
    await request('POST', '/platform/watch-progress', {
      courseId: streamTarget.courseId,
      lessonId: streamTarget.lessonId,
      progressPercent: 100,
      progressSeconds: 60,
      completed: true,
      lessonStage: 'exam',
      videoWatchCount: 2,
    }, replayAuditUser.token);
    let replayBlockedAfterSecondCompletion = null;
    try {
      await measurePlayerCall({
        token: replayAuditUser.token,
        courseId: streamTarget.courseId,
        lessonId: streamTarget.lessonId,
      });
      replayBlockedAfterSecondCompletion = { blocked: false };
    } catch (error) {
      replayBlockedAfterSecondCompletion = {
        blocked: true,
        status: error.status || null,
        code: error.payload?.code || null,
      };
    }
    const replayAuditGrantRows = await queryValue(
      'SELECT used_views, max_views, last_completed_at FROM video_access_grants WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
      [String(replayAuditUser._id), String(streamTarget.courseId), String(streamTarget.lessonId)],
    );
    summary.cases.replayCompletionRule = {
      firstOpenRemainingViews: replayAuditFirstOpen.result.playbackGrantRemainingViews,
      secondOpenBeforeCompletionRemainingViews: replayAuditSecondOpenBeforeCompletion.result.playbackGrantRemainingViews,
      secondWatchOpenRemainingViews: replayAuditSecondWatchOpen.result.playbackGrantRemainingViews,
      blockedAfterSecondCompletion: replayBlockedAfterSecondCompletion,
      grantRow: replayAuditGrantRows[0] || null,
    };
    if (
      Number(replayAuditFirstOpen.result.playbackGrantRemainingViews ?? REPLAY_MAX_VIEWS) !== REPLAY_MAX_VIEWS
      || Number(replayAuditSecondOpenBeforeCompletion.result.playbackGrantRemainingViews ?? REPLAY_MAX_VIEWS) !== REPLAY_MAX_VIEWS
      || Number(replayAuditGrantRows[0]?.used_views || 0) !== REPLAY_MAX_VIEWS
      || !replayBlockedAfterSecondCompletion?.blocked
    ) {
      addFinding(findings, 'high', 'Replay access was not enforced as two completed watches before restriction', summary.cases.replayCompletionRule);
    }

    const progressPayloads = Array.from({ length: PROGRESS_RACE_REQUESTS }, (_, index) => ({
      progressPercent: index % 2 === 0 ? 95 - index : index * 2,
      progressSeconds: index % 2 === 0 ? 950 - (index * 10) : index * 15,
      completed: index % 3 === 0,
    }));
    const progressRace = await runConcurrent(
      progressPayloads,
      (payload) => request('POST', '/platform/watch-progress', {
        courseId: hotCourseSetup.course._id,
        lessonId: hotCourseSetup.lessonIds[0],
        ...payload,
      }, progressRaceUser.token),
      PROGRESS_RACE_REQUESTS,
    );
    const progressRows = await queryValue(
      'SELECT progress_percent, progress_seconds, completed, updated_at FROM watch_history WHERE user_id = $1 AND course_id = $2 AND lesson_id = $3',
      [String(progressRaceUser._id), String(hotCourseSetup.course._id), String(hotCourseSetup.lessonIds[0])],
    );
    const expectedMaxProgressSeconds = Math.max(...progressPayloads.map((entry) => entry.progressSeconds));
    const finalProgressSeconds = Number(progressRows[0]?.progress_seconds || 0);
    summary.cases.sameUserProgressRace = {
      requestCount: PROGRESS_RACE_REQUESTS,
      successes: progressRace.results.length,
      failures: progressRace.errors,
      expectedMaxProgressSeconds,
      finalProgressSeconds,
      finalRow: progressRows[0] || null,
    };
    if (finalProgressSeconds < expectedMaxProgressSeconds) {
      addFinding(findings, 'medium', 'Watch progress regressed under concurrent updates for the same user and lesson', summary.cases.sameUserProgressRace);
    }

    try {
      await request('GET', `/courses/${hotCourseSetup.course._id}/lessons/${hotCourseSetup.lessonIds[0]}/player`, null, unauthorizedUser.token);
      summary.cases.accessWithoutEnrollment = {
        status: 'unexpected-success',
      };
      addFinding(findings, 'high', 'Lesson playback succeeded without enrollment', summary.cases.accessWithoutEnrollment);
    } catch (error) {
      summary.cases.accessWithoutEnrollment = {
        status: error.status || null,
        code: error.payload?.code || null,
      };
    }

    try {
      await request('GET', `/courses/${sequentialCourseSetup.course._id}/lessons/${sequentialCourseSetup.lessonIds[1]}/player`, null, sequentialUser.token);
      summary.cases.sequentialUnlock = {
        status: 'unexpected-success',
      };
      addFinding(findings, 'high', 'Sequential lesson lock did not block the locked lesson', summary.cases.sequentialUnlock);
    } catch (error) {
      summary.cases.sequentialUnlock = {
        status: error.status || null,
        code: error.payload?.code || null,
      };
    }

    await request('POST', '/platform/watch-progress', {
      courseId: sharedLessonCourses[0].course._id,
      lessonId: sharedLessonId,
      progressPercent: 80,
      progressSeconds: 800,
      completed: false,
    }, sharedLessonUser.token);
    await sleep(50);
    await request('POST', '/platform/watch-progress', {
      courseId: sharedLessonCourses[1].course._id,
      lessonId: sharedLessonId,
      progressPercent: 20,
      progressSeconds: 200,
      completed: false,
    }, sharedLessonUser.token);
    const sharedWatchRows = await queryValue(
      'SELECT course_id, lesson_id, progress_seconds FROM watch_history WHERE user_id = $1 AND lesson_id = $2 ORDER BY updated_at ASC',
      [String(sharedLessonUser._id), String(sharedLessonId)],
    );
    const sharedResumeA = await measurePlayerCall({
      token: sharedLessonUser.token,
      courseId: sharedLessonCourses[0].course._id,
      lessonId: sharedLessonId,
    });
    const sharedResumeB = await measurePlayerCall({
      token: sharedLessonUser.token,
      courseId: sharedLessonCourses[1].course._id,
      lessonId: sharedLessonId,
    });
    summary.cases.sameLessonIdDifferentCourses = {
      watchHistoryRows: sharedWatchRows,
      playerResumeCourseA: sharedResumeA.result.resumeSeconds,
      playerResumeCourseB: sharedResumeB.result.resumeSeconds,
    };
    if (sharedWatchRows.length !== 2
      || Number(sharedResumeA.result.resumeSeconds || 0) !== 800
      || Number(sharedResumeB.result.resumeSeconds || 0) !== 200) {
      addFinding(findings, 'high', 'Same lesson id across different courses shares watch progress in Postgres', summary.cases.sameLessonIdDifferentCourses);
    }

    const payment = await paymentRepository.createCheckout({
      userId: paymentUser._id,
      amount: 499,
      currency: 'INR',
      item: 'Audit Purchase',
    });
    await paymentRepository.handleWebhook({
      paymentId: payment._id,
      status: 'failed',
      event: 'payment.failed',
      errorMessage: 'Synthetic failure for retry audit',
    });
    const paymentRetryRace = await runConcurrent(
      Array.from({ length: PAYMENT_RETRY_REQUESTS }, (_, index) => ({ index })),
      () => request('POST', `/payment/${payment._id}/retry`, null, paymentUser.token),
      PAYMENT_RETRY_REQUESTS,
    );
    const paymentRows = await queryValue(
      'SELECT id, attempt_count, status, retryable FROM payments WHERE id = $1',
      [String(payment._id)],
    );
    const finalAttemptCount = Number(paymentRows[0]?.attempt_count || 0);
    summary.cases.paymentRetryRace = {
      requestCount: PAYMENT_RETRY_REQUESTS,
      successes: paymentRetryRace.results.length,
      failures: paymentRetryRace.errors,
      expectedAttemptCount: PAYMENT_RETRY_REQUESTS + 1,
      finalAttemptCount,
      finalRow: paymentRows[0] || null,
    };
    if (finalAttemptCount !== PAYMENT_RETRY_REQUESTS + 1) {
      addFinding(findings, 'high', 'Concurrent payment retries lost increments on attempt_count', summary.cases.paymentRetryRace);
    }

    const webhookOrderingPayment = await paymentRepository.createCheckout({
      userId: paymentUser._id,
      amount: 799,
      currency: 'INR',
      item: 'Webhook Ordering Audit',
    });
    await paymentRepository.handleWebhook({
      paymentId: webhookOrderingPayment._id,
      status: 'paid',
      event: 'payment.paid',
    });
    await paymentRepository.handleWebhook({
      paymentId: webhookOrderingPayment._id,
      status: 'failed',
      event: 'payment.failed',
      errorMessage: 'Late failure should not overwrite paid state',
    });
    const webhookOrderingRows = await queryValue(
      'SELECT id, attempt_count, status, retryable, last_error FROM payments WHERE id = $1',
      [String(webhookOrderingPayment._id)],
    );
    summary.cases.paymentWebhookOrdering = {
      finalRow: webhookOrderingRows[0] || null,
    };
    if (String(webhookOrderingRows[0]?.status || '') !== 'paid') {
      addFinding(findings, 'high', 'A later failed webhook can overwrite an already paid payment', summary.cases.paymentWebhookOrdering);
    }

    const privateVideoAssignments = streamUsers.flatMap((user) =>
      Array.from({ length: STREAM_CYCLES }, (_, cycleIndex) => ({
        user,
        cycleIndex: cycleIndex + 1,
      })),
    );
    const privateVideoTraffic = await runConcurrent(
      privateVideoAssignments,
      ({ user, cycleIndex }) => fetchPrivateVideoPlayback({
        token: user.token,
        courseId: streamTarget.courseId,
        lessonId: streamTarget.lessonId,
        userLabel: `${user.email}:cycle-${cycleIndex}`,
      }),
      STREAM_CONCURRENCY,
    );
    summary.cases.privateVideoContinuousSameLesson = {
      viewers: STREAM_VIEWERS,
      cyclesPerViewer: STREAM_CYCLES,
      totalPlaybackRuns: privateVideoAssignments.length,
      successes: privateVideoTraffic.results.length,
      failures: privateVideoTraffic.errors,
      playerLatency: summarizeLatency(privateVideoTraffic.results.map((entry) => ({ ms: entry.playerMs }))),
      manifestLatency: summarizeLatency(privateVideoTraffic.results.map((entry) => ({ ms: entry.manifestMs }))),
      streamLatency: summarizeLatency(privateVideoTraffic.results.map((entry) => ({ ms: entry.streamMs }))),
      streamFormats: privateVideoTraffic.results.reduce((acc, entry) => {
        acc[entry.streamFormat] = Number(acc[entry.streamFormat] || 0) + 1;
        return acc;
      }, {}),
    };
    if (privateVideoTraffic.errors.length > 0) {
      addFinding(findings, 'high', 'Continuous same-lesson private-video playback produced failures', summary.cases.privateVideoContinuousSameLesson);
    }

    const hotCourseTraffic = await runConcurrent(
      hotUsers,
      (user) => measurePlayerCall({
        token: user.token,
        courseId: hotCourseSetup.course._id,
        lessonId: hotCourseSetup.lessonIds[0],
      }),
      VIEWERS,
    );
    summary.cases.hotCoursePeak = {
      usersRequested: VIEWERS,
      successes: hotCourseTraffic.results.length,
      failures: hotCourseTraffic.errors,
      latency: summarizeLatency(hotCourseTraffic.results),
    };
    if (hotCourseTraffic.errors.length > 0) {
      addFinding(findings, 'high', 'Peak same-course same-lesson traffic produced request failures', summary.cases.hotCoursePeak);
    }

    const mixedAssignments = mixedUsers.map((user, index) => ({
      user,
      target: mixedCourseSetups[index % mixedCourseSetups.length],
    }));
    const mixedTraffic = await runConcurrent(
      mixedAssignments,
      ({ user, target }) => measurePlayerCall({
        token: user.token,
        courseId: target.course._id,
        lessonId: target.lessonIds[0],
      }),
      VIEWERS,
    );
    summary.cases.mixedCoursePeak = {
      usersRequested: VIEWERS,
      successes: mixedTraffic.results.length,
      failures: mixedTraffic.errors,
      latency: summarizeLatency(mixedTraffic.results),
    };
    if (mixedTraffic.errors.length > 0) {
      addFinding(findings, 'high', 'Peak mixed-course traffic produced request failures', summary.cases.mixedCoursePeak);
    }

    summary.overall = {
      findingCount: findings.length,
      highSeverityCount: findings.filter((entry) => entry.severity === 'high').length,
      mediumSeverityCount: findings.filter((entry) => entry.severity === 'medium').length,
    };

    const markdown = [
      '# Concurrency Audit',
      '',
      `Generated: ${summary.generatedAt}`,
      `Base URL: ${baseUrl}`,
      `Database mode: ${summary.database?.mode || 'unknown'}`,
      '',
      '## Findings',
      ...(findings.length
        ? findings.map((finding, index) => `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`)
        : ['1. No automated failures were captured in this run.']),
      '',
      '## Key Metrics',
      `- Hot course peak: ${summary.cases.hotCoursePeak.successes}/${VIEWERS} succeeded, p95=${summary.cases.hotCoursePeak.latency.p95Ms}ms`,
      `- Mixed course peak: ${summary.cases.mixedCoursePeak.successes}/${VIEWERS} succeeded, p95=${summary.cases.mixedCoursePeak.latency.p95Ms}ms`,
      `- Private-video continuous playback: ${summary.cases.privateVideoContinuousSameLesson.successes}/${summary.cases.privateVideoContinuousSameLesson.totalPlaybackRuns} succeeded, stream p95=${summary.cases.privateVideoContinuousSameLesson.streamLatency.p95Ms}ms`,
      `- Same-user player race failures: ${summary.cases.sameUserSameLessonPlayerRace.failures.length}`,
      `- Payment retry final attempt count: ${summary.cases.paymentRetryRace.finalAttemptCount}/${summary.cases.paymentRetryRace.expectedAttemptCount}`,
      '',
    ].join('\n');

    await fsp.writeFile(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await fsp.writeFile(path.join(reportDir, 'summary.md'), markdown);

    console.log(JSON.stringify({
      reportDir,
      overall: summary.overall,
      hotCoursePeak: summary.cases.hotCoursePeak,
      mixedCoursePeak: summary.cases.mixedCoursePeak,
      sameUserSameLessonPlayerRace: summary.cases.sameUserSameLessonPlayerRace,
      sameLessonIdDifferentCourses: summary.cases.sameLessonIdDifferentCourses,
      paymentRetryRace: summary.cases.paymentRetryRace,
      paymentWebhookOrdering: summary.cases.paymentWebhookOrdering,
      privateVideoContinuousSameLesson: summary.cases.privateVideoContinuousSameLesson,
    }, null, 2));
  } finally {
    if (serverHandle) {
      await new Promise((resolve) => serverHandle.close(resolve));
    }
    const pool = getPool();
    if (pool) {
      await pool.end().catch(() => undefined);
    }
  }
};

runAudit().catch((error) => {
  console.error(error);
  process.exit(1);
});
