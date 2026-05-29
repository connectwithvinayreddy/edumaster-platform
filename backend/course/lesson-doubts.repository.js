const { randomUUID } = require('crypto');
const { ApiError } = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const { queryPostgres, runInTransaction, isPostgresReady } = require('../lib/postgres.js');
const { state, clone, nowIso } = require('../lib/store.js');
const { coursesRepository, notificationsRepository, usersRepository } = require('../lib/repositories.js');

const createId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`;

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
  createdAt: toIso(row.created_at) || nowIso(),
});

const sortNewestFirst = (left, right, field) => new Date(right[field] || 0).getTime() - new Date(left[field] || 0).getTime();
const sortOldestFirst = (left, right, field) => new Date(left[field] || 0).getTime() - new Date(right[field] || 0).getTime();

const hydrateThreadsWithMessages = (threads, messages) => {
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
      messages: (messageGroups.get(thread._id) || []).slice().sort((left, right) => sortOldestFirst(left, right, 'createdAt')),
    }))
    .sort((left, right) => sortNewestFirst(left, right, 'lastMessageAt'));
};

const getPgThreads = async ({ courseId, lessonId, userId, role }) => {
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
    'SELECT * FROM lesson_doubt_messages WHERE thread_id = ANY($1::text[]) ORDER BY created_at ASC',
    [threads.map((thread) => thread._id)],
  );
  const messages = messageResult.rows.map(mapMessageRow);
  return hydrateThreadsWithMessages(threads, messages);
};

const getMemoryThreads = ({ courseId, lessonId, userId, role }) => {
  const threads = state.lessonDoubtThreads
    .filter((thread) =>
      thread.courseId === String(courseId)
      && thread.lessonId === String(lessonId)
      && (role === 'admin' || thread.studentUserId === String(userId)))
    .map((thread) => clone(thread));

  const messages = state.lessonDoubtMessages
    .filter((message) => threads.some((thread) => thread._id === message.threadId))
    .map((message) => clone(message));

  return hydrateThreadsWithMessages(threads, messages);
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

const listLessonDoubts = async ({ courseId, lessonId, userId, role }) => {
  const context = await buildLessonContext(courseId, lessonId);
  const threads = isPostgresReady()
    ? await getPgThreads({ courseId, lessonId, userId, role })
    : getMemoryThreads({ courseId, lessonId, userId, role });

  return {
    viewerRole: role === 'admin' ? 'admin' : 'student',
    lessonPath: buildPathParts(context),
    threads,
  };
};

const addLessonDoubtMessage = async ({ courseId, lessonId, message, threadId, userId, role }) => {
  const user = await usersRepository.findSafeById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  const context = await buildLessonContext(courseId, lessonId);
  const trimmedMessage = String(message || '').trim();
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
            id, thread_id, user_id, user_role, user_name, message, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        `,
        [
          createId('lesson_doubt_message'),
          resolvedThread._id,
          String(user._id),
          role === 'admin' ? 'admin' : 'student',
          String(user.name || user.email || 'Learner'),
          trimmedMessage,
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

      const refreshedThreads = await getPgThreads({
        courseId,
        lessonId,
        userId: role === 'admin' ? null : user._id,
        role,
      });
      return refreshedThreads.find((item) => item._id === resolvedThread._id) || resolvedThread;
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

module.exports = {
  listLessonDoubts,
  addLessonDoubtMessage,
};
