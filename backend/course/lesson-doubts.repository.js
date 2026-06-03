const { randomUUID } = require('crypto');
const { ApiError } = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const { queryPostgres, runInTransaction, isPostgresReady } = require('../lib/postgres.js');
const { state, clone, nowIso } = require('../lib/store.js');
const { coursesRepository, notificationsRepository, usersRepository, platformRepository } = require('../lib/repositories.js');

const createId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`;
const normalizeAttachments = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry === 'object' && entry.url)
    .map((entry) => ({
      id: String(entry.id || createId('support_attachment')),
      kind: String(entry.kind || 'file'),
      url: String(entry.url),
      fileName: String(entry.fileName || 'attachment'),
      mimeType: entry.mimeType ? String(entry.mimeType) : null,
      fileSize: Number(entry.fileSize || 0) || 0,
      uploadedAt: entry.uploadedAt ? toIso(entry.uploadedAt) : nowIso(),
      uploadedByRole: entry.uploadedByRole ? String(entry.uploadedByRole) : null,
    }));
};

const toIso = (value) => {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value.toISOString === 'function') {
    return value.toISOString();
  }
  return String(value);
};

const buildLessonContext = async (courseId, lessonId) => {
  const course = await coursesRepository.findById(courseId);
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }

  for (const module of course.modules || []) {
    for (const lesson of module.lessons || []) {
      if (String(lesson.id) === String(lessonId)) {
        return {
          courseId: String(course._id),
          lessonId: String(lessonId),
          courseTitle: course.title,
          moduleTitle: module.title || null,
          chapterTitle: null,
          lessonTitle: lesson.title || 'Lesson',
        };
      }
    }

    for (const chapter of module.chapters || []) {
      for (const lesson of chapter.lessons || []) {
        if (String(lesson.id) === String(lessonId)) {
          return {
            courseId: String(course._id),
            lessonId: String(lessonId),
            courseTitle: course.title,
            moduleTitle: module.title || null,
            chapterTitle: chapter.title || null,
            lessonTitle: lesson.title || 'Lesson',
          };
        }
      }
    }
  }

  throw new ApiError(404, 'Lesson not found', { code: 'LESSON_NOT_FOUND' });
};

const buildPathParts = (context) => [
  context.courseTitle,
  context.moduleTitle,
  context.chapterTitle,
  context.lessonTitle,
].filter(Boolean);

const buildPathLabel = (context) => buildPathParts(context).join(' -> ');

const buildNotificationActionUrl = ({ courseId, lessonId, threadId }) => {
  const appUrl = String(appConfig.appUrl || '').replace(/\/$/, '');
  const params = new URLSearchParams({
    tab: 'courses',
    courseId: String(courseId),
    lessonId: String(lessonId),
    doubtThreadId: String(threadId),
  });
  return appUrl ? `${appUrl}/?${params.toString()}` : null;
};

const assertLessonSupportAccess = async ({ courseId, lessonId, userId, role }) => {
  if (role === 'admin') {
    return;
  }

  const overview = await platformRepository.getOverview(String(userId));
  const course = (overview.courses || []).find((entry) => String(entry._id) === String(courseId));
  if (!course) {
    throw new ApiError(404, 'Course not found', { code: 'COURSE_NOT_FOUND' });
  }
  if (!course.canAccessCourse || !course.canPlayReleasedVideos) {
    throw new ApiError(403, course.accessBlockReason || 'Course access required for lesson doubts.', {
      code: 'LESSON_SUPPORT_ACCESS_DENIED',
      details: {
        courseId: String(courseId),
        lessonId: String(lessonId),
        accessStatus: course.accessStatus || 'not_purchased',
      },
    });
  }
};

const mapThreadRow = (row) => ({
  _id: row.id,
  courseId: row.course_id,
  lessonId: row.lesson_id,
  studentUserId: row.student_user_id,
  studentName: row.student_name,
  studentEmail: row.student_email || null,
  courseTitle: row.course_title,
  moduleTitle: row.module_title || null,
  chapterTitle: row.chapter_title || null,
  lessonTitle: row.lesson_title,
  status: row.status || 'open',
  lastMessagePreview: row.last_message_preview || '',
  lastMessageAt: toIso(row.last_message_at) || nowIso(),
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
  messages: [],
  pathLabel: buildPathLabel({
    courseTitle: row.course_title,
    moduleTitle: row.module_title || null,
    chapterTitle: row.chapter_title || null,
    lessonTitle: row.lesson_title,
  }),
});

const mapMessageRow = (row) => ({
  _id: row.id,
  threadId: row.thread_id,
  userId: row.user_id,
  role: row.user_role || 'student',
  userName: row.user_name || 'Learner',
  message: row.message || '',
  attachments: normalizeAttachments(row.attachment_meta?.attachments || []),
  createdAt: toIso(row.created_at) || nowIso(),
});

const sortNewestFirst = (left, right, field) => new Date(right[field] || 0).getTime() - new Date(left[field] || 0).getTime();
const sortOldestFirst = (left, right, field) => new Date(left[field] || 0).getTime() - new Date(right[field] || 0).getTime();

const hydrateThreadsWithMessages = (threads, messages, messageLimitPerThread = null) => {
  const messageGroups = new Map();
  messages.forEach((message) => {
    if (!messageGroups.has(message.threadId)) {
      messageGroups.set(message.threadId, []);
    }
    messageGroups.get(message.threadId).push(message);
  });

  return threads
    .map((thread) => ({
      ...thread,
      messages: (messageGroups.get(thread._id) || [])
        .slice(messageLimitPerThread ? -messageLimitPerThread : undefined)
        .sort((left, right) => sortOldestFirst(left, right, 'createdAt')),
    }))
    .sort((left, right) => sortNewestFirst(left, right, 'lastMessageAt'));
};

const getPgThreads = async ({ courseId, lessonId, userId, role, messageLimitPerThread = 50 }) => {
  const params = [String(courseId), String(lessonId)];
  let sql = `
    SELECT *
    FROM lesson_doubt_threads
    WHERE course_id = $1 AND lesson_id = $2
  `;

  if (role !== 'admin') {
    sql += ' AND student_user_id = $3';
    params.push(String(userId));
  }

  sql += ' ORDER BY last_message_at DESC';
  const threadResult = await queryPostgres(sql, params);
  const threads = threadResult.rows.map(mapThreadRow);
  if (!threads.length) {
    return [];
  }

  const messageResult = await queryPostgres(
    `
      SELECT id, thread_id, user_id, user_role, user_name, message, attachment_meta, created_at
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) AS row_num
        FROM lesson_doubt_messages
        WHERE thread_id = ANY($1::text[])
      ) ranked_messages
      WHERE row_num <= $2
      ORDER BY created_at ASC
    `,
    [threads.map((thread) => thread._id), Math.max(1, Number(messageLimitPerThread || 50))],
  );
  const messages = messageResult.rows.map(mapMessageRow);
  return hydrateThreadsWithMessages(threads, messages, messageLimitPerThread);
};

const getMemoryThreads = ({ courseId, lessonId, userId, role, messageLimitPerThread = 50 }) => {
  const threads = state.lessonDoubtThreads
    .filter((thread) =>
      thread.courseId === String(courseId)
      && thread.lessonId === String(lessonId)
      && (role === 'admin' || thread.studentUserId === String(userId)))
    .map((thread) => clone(thread));

  const messages = state.lessonDoubtMessages
    .filter((message) => threads.some((thread) => thread._id === message.threadId))
    .map((message) => clone(message));

  return hydrateThreadsWithMessages(threads, messages, messageLimitPerThread);
};

const createNotificationsForStudentQuestion = async ({ context, thread, studentName, message }) => {
  const admins = (await usersRepository.listSafe())
    .filter((user) => String(user.role) === 'admin')
    .map((user) => String(user._id));
  const notificationPath = buildPathLabel(context);
  const preview = message.length > 120 ? `${message.slice(0, 117)}...` : message;
  const actionUrl = buildNotificationActionUrl({
    courseId: context.courseId,
    lessonId: context.lessonId,
    threadId: thread._id,
  });

  const notifications = await Promise.all(admins.map((adminUserId) =>
    notificationsRepository.create({
      _id: createId('lesson_doubt_question'),
      userId: adminUserId,
      title: `New lesson doubt from ${studentName}`,
      message: `${notificationPath}: ${preview}`,
      type: 'course-lesson-doubt-question',
      entityId: thread._id,
      actionUrl,
      actionLabel: 'Reply now',
      payload: {
        tab: 'courses',
        courseId: context.courseId,
        lessonId: context.lessonId,
        doubtThreadId: thread._id,
        courseTitle: context.courseTitle,
        moduleTitle: context.moduleTitle,
        chapterTitle: context.chapterTitle,
        lessonTitle: context.lessonTitle,
        studentUserId: thread.studentUserId,
      },
    })));

  return notifications.length;
};

const createNotificationForAdminReply = async ({ context, thread, adminName, message }) => {
  const preview = message.length > 120 ? `${message.slice(0, 117)}...` : message;
  const actionUrl = buildNotificationActionUrl({
    courseId: context.courseId,
    lessonId: context.lessonId,
    threadId: thread._id,
  });

  await notificationsRepository.create({
    _id: `lesson_doubt_reply_${thread._id}_${createId('reply')}`,
    userId: thread.studentUserId,
    title: `Reply from ${adminName}`,
    message: `${buildPathLabel(context)}: ${preview}`,
    type: 'course-lesson-doubt-reply',
    entityId: thread._id,
    actionUrl,
    actionLabel: 'Open doubt chat',
    payload: {
      tab: 'courses',
      courseId: context.courseId,
      lessonId: context.lessonId,
      doubtThreadId: thread._id,
      courseTitle: context.courseTitle,
      moduleTitle: context.moduleTitle,
      chapterTitle: context.chapterTitle,
      lessonTitle: context.lessonTitle,
    },
  });

  return 1;
};

const upsertPgStudentThread = async ({ courseId, lessonId, user, context }, client) => {
  const existingResult = await queryPostgres(
    `
      SELECT *
      FROM lesson_doubt_threads
      WHERE course_id = $1 AND lesson_id = $2 AND student_user_id = $3
      LIMIT 1
    `,
    [String(courseId), String(lessonId), String(user._id)],
    client,
  );

  if (existingResult.rows[0]) {
    return mapThreadRow(existingResult.rows[0]);
  }

  const thread = {
    _id: createId('lesson_doubt_thread'),
    courseId: String(courseId),
    lessonId: String(lessonId),
    studentUserId: String(user._id),
    studentName: String(user.name || user.email || 'Learner'),
    studentEmail: user.email || null,
    courseTitle: context.courseTitle,
    moduleTitle: context.moduleTitle || null,
    chapterTitle: context.chapterTitle || null,
    lessonTitle: context.lessonTitle,
    status: 'open',
    lastMessagePreview: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastMessageAt: nowIso(),
  };

  const insertResult = await queryPostgres(
    `
      INSERT INTO lesson_doubt_threads (
        id, course_id, lesson_id, student_user_id, student_name, student_email,
        course_title, module_title, chapter_title, lesson_title, status,
        last_message_preview, created_at, updated_at, last_message_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `,
    [
      thread._id,
      thread.courseId,
      thread.lessonId,
      thread.studentUserId,
      thread.studentName,
      thread.studentEmail,
      thread.courseTitle,
      thread.moduleTitle,
      thread.chapterTitle,
      thread.lessonTitle,
      thread.status,
      '',
      thread.createdAt,
      thread.updatedAt,
      thread.lastMessageAt,
    ],
    client,
  );

  return mapThreadRow(insertResult.rows[0]);
};

const getPgThreadById = async (threadId, client) => {
  const result = await queryPostgres('SELECT * FROM lesson_doubt_threads WHERE id = $1 LIMIT 1', [String(threadId)], client);
  return result.rows[0] ? mapThreadRow(result.rows[0]) : null;
};

const getPgHydratedThreadById = async (threadId, client, messageLimitPerThread = 50) => {
  const thread = await getPgThreadById(threadId, client);
  if (!thread) {
    return null;
  }

  const messages = await queryPostgres(
    `
      SELECT id, thread_id, user_id, user_role, user_name, message, attachment_meta, created_at
      FROM lesson_doubt_messages
      WHERE thread_id = $1
      ORDER BY created_at ASC
    `,
    [thread._id],
    client,
  );

  return hydrateThreadsWithMessages(
    [thread],
    messages.rows.map(mapMessageRow),
    messageLimitPerThread,
  )[0] || null;
};

const buildThreadFromMemory = ({ courseId, lessonId, user, context }) => {
  const existing = state.lessonDoubtThreads.find((thread) =>
    thread.courseId === String(courseId)
    && thread.lessonId === String(lessonId)
    && thread.studentUserId === String(user._id));
  if (existing) {
    return existing;
  }

  const thread = {
    _id: createId('lesson_doubt_thread'),
    courseId: String(courseId),
    lessonId: String(lessonId),
    studentUserId: String(user._id),
    studentName: String(user.name || user.email || 'Learner'),
    studentEmail: user.email || null,
    courseTitle: context.courseTitle,
    moduleTitle: context.moduleTitle || null,
    chapterTitle: context.chapterTitle || null,
    lessonTitle: context.lessonTitle,
    status: 'open',
    lastMessagePreview: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastMessageAt: nowIso(),
  };
  state.lessonDoubtThreads.push(thread);
  return thread;
};

const listLessonDoubts = async ({ courseId, lessonId, userId, role, messageLimitPerThread = 50 }) => {
  const context = await buildLessonContext(courseId, lessonId);
  await assertLessonSupportAccess({ courseId, lessonId, userId, role });
  const threads = isPostgresReady()
    ? await getPgThreads({ courseId, lessonId, userId, role, messageLimitPerThread })
    : getMemoryThreads({ courseId, lessonId, userId, role, messageLimitPerThread });

  return {
    viewerRole: role === 'admin' ? 'admin' : 'student',
    lessonPath: buildPathParts(context),
    threads,
  };
};

const addLessonDoubtMessage = async ({ courseId, lessonId, message, threadId, userId, role, attachments = [] }) => {
  const user = await usersRepository.findSafeById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  const context = await buildLessonContext(courseId, lessonId);
  await assertLessonSupportAccess({ courseId, lessonId, userId, role });
  const trimmedMessage = String(message || '').trim();
  const normalizedAttachments = normalizeAttachments(attachments);
  const threadStatus = role === 'admin' ? 'answered' : 'open';
  const preview = trimmedMessage.length > 160 ? `${trimmedMessage.slice(0, 157)}...` : trimmedMessage;
  const now = nowIso();

  let notificationsSent = 0;

  if (isPostgresReady()) {
    const thread = await runInTransaction(async (client) => {
      const resolvedThread = role === 'admin'
        ? await getPgThreadById(threadId, client)
        : await upsertPgStudentThread({ courseId, lessonId, user, context }, client);

      if (!resolvedThread) {
        throw new ApiError(404, 'Doubt thread not found', { code: 'LESSON_DOUBT_THREAD_NOT_FOUND' });
      }
      if (role !== 'admin' && resolvedThread.studentUserId !== String(user._id)) {
        throw new ApiError(403, 'You can only post to your own lesson doubt thread.', { code: 'LESSON_DOUBT_FORBIDDEN' });
      }
      if (role === 'admin' && (resolvedThread.courseId !== String(courseId) || resolvedThread.lessonId !== String(lessonId))) {
        throw new ApiError(400, 'Thread does not belong to this lesson.', { code: 'LESSON_DOUBT_THREAD_MISMATCH' });
      }

      await queryPostgres(
        `
          INSERT INTO lesson_doubt_messages (
            id, thread_id, user_id, user_role, user_name, message, attachment_meta, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        `,
        [
          createId('lesson_doubt_message'),
          resolvedThread._id,
          String(user._id),
          role === 'admin' ? 'admin' : 'student',
          String(user.name || user.email || 'Learner'),
          trimmedMessage,
          JSON.stringify({ attachments: normalizedAttachments }),
          now,
        ],
        client,
      );

      await queryPostgres(
        `
          UPDATE lesson_doubt_threads
          SET status = $2,
              last_message_preview = $3,
              updated_at = $4,
              last_message_at = $4
          WHERE id = $1
        `,
        [resolvedThread._id, threadStatus, preview, now],
        client,
      );

      return await getPgHydratedThreadById(resolvedThread._id, client) || resolvedThread;
    });

    notificationsSent = role === 'admin'
      ? await createNotificationForAdminReply({ context, thread, adminName: String(user.name || 'Admin'), message: trimmedMessage })
      : await createNotificationsForStudentQuestion({ context, thread, studentName: String(user.name || 'Learner'), message: trimmedMessage });

    return {
      thread,
      notificationsSent,
    };
  }

  const resolvedThread = role === 'admin'
    ? state.lessonDoubtThreads.find((item) => item._id === String(threadId))
    : buildThreadFromMemory({ courseId, lessonId, user, context });

  if (!resolvedThread) {
    throw new ApiError(404, 'Doubt thread not found', { code: 'LESSON_DOUBT_THREAD_NOT_FOUND' });
  }
  if (role !== 'admin' && resolvedThread.studentUserId !== String(user._id)) {
    throw new ApiError(403, 'You can only post to your own lesson doubt thread.', { code: 'LESSON_DOUBT_FORBIDDEN' });
  }
  if (role === 'admin' && (resolvedThread.courseId !== String(courseId) || resolvedThread.lessonId !== String(lessonId))) {
    throw new ApiError(400, 'Thread does not belong to this lesson.', { code: 'LESSON_DOUBT_THREAD_MISMATCH' });
  }

  const messageEntry = {
    _id: createId('lesson_doubt_message'),
    threadId: resolvedThread._id,
    userId: String(user._id),
    role: role === 'admin' ? 'admin' : 'student',
    userName: String(user.name || user.email || 'Learner'),
    message: trimmedMessage,
    attachments: normalizedAttachments,
    createdAt: now,
  };
  state.lessonDoubtMessages.push(messageEntry);
  resolvedThread.status = threadStatus;
  resolvedThread.lastMessagePreview = preview;
  resolvedThread.updatedAt = now;
  resolvedThread.lastMessageAt = now;

  const threads = getMemoryThreads({ courseId, lessonId, userId: role === 'admin' ? null : user._id, role });
  const thread = threads.find((item) => item._id === resolvedThread._id) || {
    ...clone(resolvedThread),
    messages: [messageEntry],
    pathLabel: buildPathLabel(context),
  };

  notificationsSent = role === 'admin'
    ? await createNotificationForAdminReply({ context, thread, adminName: String(user.name || 'Admin'), message: trimmedMessage })
    : await createNotificationsForStudentQuestion({ context, thread, studentName: String(user.name || 'Learner'), message: trimmedMessage });

  return {
    thread,
    notificationsSent,
  };
};

const listAdminLessonDoubtThreads = async ({ search = '', status = '', courseId = '', lessonId = '', page = 1, pageSize = 25 }) => {
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const normalizedCourseId = String(courseId || '').trim();
  const normalizedLessonId = String(lessonId || '').trim();
  const safePage = Math.max(1, Number(page || 1));
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize || 25)));
  const offset = (safePage - 1) * safePageSize;

  if (isPostgresReady()) {
    const params = [];
    const filters = ['1=1'];
    if (normalizedSearch) {
      params.push(`%${normalizedSearch}%`);
      filters.push(`(
        LOWER(COALESCE(student_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(student_email, '')) LIKE $${params.length}
        OR LOWER(COALESCE(course_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(module_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(chapter_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(lesson_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(last_message_preview, '')) LIKE $${params.length}
      )`);
    }
    if (normalizedStatus) {
      params.push(normalizedStatus);
      filters.push(`LOWER(COALESCE(status, 'open')) = $${params.length}`);
    }
    if (normalizedCourseId) {
      params.push(normalizedCourseId);
      filters.push(`course_id = $${params.length}`);
    }
    if (normalizedLessonId) {
      params.push(normalizedLessonId);
      filters.push(`lesson_id = $${params.length}`);
    }
    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const totalResult = await queryPostgres(
      `SELECT COUNT(*)::int AS total FROM lesson_doubt_threads ${whereSql}`,
      params,
    );
    const rows = await queryPostgres(
      `
        SELECT *
        FROM lesson_doubt_threads
        ${whereSql}
        ORDER BY last_message_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, safePageSize, offset],
    );
    const threads = rows.rows.map(mapThreadRow);
    if (!threads.length) {
      return {
        items: [],
        pagination: { page: safePage, pageSize: safePageSize, total: Number(totalResult.rows[0]?.total || 0), totalPages: Math.max(1, Math.ceil(Number(totalResult.rows[0]?.total || 0) / safePageSize)) },
      };
    }
    const messages = await queryPostgres(
      `
        SELECT id, thread_id, user_id, user_role, user_name, message, attachment_meta, created_at
        FROM lesson_doubt_messages
        WHERE thread_id = ANY($1::text[])
        ORDER BY created_at ASC
      `,
      [threads.map((thread) => thread._id)],
    );
    const hydrated = hydrateThreadsWithMessages(threads, messages.rows.map(mapMessageRow));
    const total = Number(totalResult.rows[0]?.total || 0);
    return {
      items: hydrated,
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / safePageSize)),
      },
    };
  }

  const items = hydrateThreadsWithMessages(
    state.lessonDoubtThreads
      .filter((thread) => !normalizedStatus || String(thread.status || 'open').toLowerCase() === normalizedStatus)
      .filter((thread) => !normalizedCourseId || String(thread.courseId) === normalizedCourseId)
      .filter((thread) => !normalizedLessonId || String(thread.lessonId) === normalizedLessonId)
      .filter((thread) => !normalizedSearch || JSON.stringify(thread).toLowerCase().includes(normalizedSearch))
      .map((thread) => clone(thread)),
    state.lessonDoubtMessages.map((message) => clone(message)),
  );
  return {
    items: items.slice(offset, offset + safePageSize),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / safePageSize)),
    },
  };
};

const updateLessonDoubtThreadStatus = async ({ threadId, status }) => {
  const nextStatus = String(status || '').trim().toLowerCase() || 'open';
  const now = nowIso();

  if (isPostgresReady()) {
    const result = await queryPostgres(
      `
        UPDATE lesson_doubt_threads
        SET status = $2,
            updated_at = $3
        WHERE id = $1
        RETURNING *
      `,
      [String(threadId), nextStatus, now],
    );
    if (!result.rows[0]) {
      throw new ApiError(404, 'Doubt thread not found', { code: 'LESSON_DOUBT_THREAD_NOT_FOUND' });
    }
    const thread = mapThreadRow(result.rows[0]);
    const messages = await queryPostgres(
      `SELECT id, thread_id, user_id, user_role, user_name, message, attachment_meta, created_at FROM lesson_doubt_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
      [thread._id],
    );
    return hydrateThreadsWithMessages([thread], messages.rows.map(mapMessageRow))[0];
  }

  const thread = state.lessonDoubtThreads.find((entry) => entry._id === String(threadId));
  if (!thread) {
    throw new ApiError(404, 'Doubt thread not found', { code: 'LESSON_DOUBT_THREAD_NOT_FOUND' });
  }
  thread.status = nextStatus;
  thread.updatedAt = now;
  return hydrateThreadsWithMessages([clone(thread)], state.lessonDoubtMessages.map((message) => clone(message)))[0];
};

const getAdminLessonDoubtThreadById = async (threadId) => {
  if (isPostgresReady()) {
    const rows = await queryPostgres(`SELECT * FROM lesson_doubt_threads WHERE id = $1 LIMIT 1`, [String(threadId)]);
    if (!rows.rows[0]) {
      return null;
    }
    const thread = mapThreadRow(rows.rows[0]);
    const messages = await queryPostgres(
      `SELECT id, thread_id, user_id, user_role, user_name, message, attachment_meta, created_at FROM lesson_doubt_messages WHERE thread_id = $1 ORDER BY created_at ASC`,
      [thread._id],
    );
    return hydrateThreadsWithMessages([thread], messages.rows.map(mapMessageRow))[0] || null;
  }

  const thread = state.lessonDoubtThreads.find((entry) => entry._id === String(threadId));
  if (!thread) {
    return null;
  }
  return hydrateThreadsWithMessages([clone(thread)], state.lessonDoubtMessages.map((message) => clone(message)))[0] || null;
};

module.exports = {
  listLessonDoubts,
  addLessonDoubtMessage,
  listAdminLessonDoubtThreads,
  getAdminLessonDoubtThreadById,
  updateLessonDoubtThreadStatus,
};
