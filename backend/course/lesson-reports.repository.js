const { randomUUID } = require('crypto');
const { ApiError } = require('../lib/http.js');
const { appConfig } = require('../lib/config.js');
const { queryPostgres, isPostgresReady } = require('../lib/postgres.js');
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
          videoId: String(lesson.id),
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
            videoId: String(lesson.id),
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

const buildPathLabel = (context) => [
  context.courseTitle,
  context.moduleTitle,
  context.chapterTitle,
  context.lessonTitle,
].filter(Boolean).join(' -> ');

const buildNotificationActionUrl = ({ courseId, lessonId, reportId }) => {
  const appUrl = String(appConfig.appUrl || '').replace(/\/$/, '');
  const params = new URLSearchParams({
    tab: 'courses',
    courseId: String(courseId),
    lessonId: String(lessonId),
    reportId: String(reportId),
    supportPanel: 'report',
  });
  return appUrl ? `${appUrl}/?${params.toString()}` : null;
};

const mapReportRow = (row) => ({
  _id: row.id,
  userId: row.user_id,
  courseId: row.course_id,
  lessonId: row.lesson_id,
  videoId: row.video_id || null,
  userName: row.user_name || 'Learner',
  userEmail: row.user_email || null,
  courseTitle: row.course_title,
  moduleTitle: row.module_title || null,
  chapterTitle: row.chapter_title || null,
  lessonTitle: row.lesson_title,
  issueType: row.issue_type || 'other',
  description: row.description || '',
  status: row.status || 'open',
  screenshotUrl: row.screenshot_url || null,
  attachmentMeta: typeof row.attachment_meta === 'object' && row.attachment_meta ? row.attachment_meta : {},
  attachments: normalizeAttachments(row.attachment_meta?.attachments || []),
  adminAttachments: normalizeAttachments(row.admin_attachment_meta?.attachments || []),
  adminNote: row.admin_note || null,
  adminReply: row.admin_reply || null,
  source: row.source || 'video_player',
  pageUrl: row.page_url || null,
  userAgent: row.user_agent || null,
  createdAt: toIso(row.created_at) || nowIso(),
  updatedAt: toIso(row.updated_at) || nowIso(),
  pathLabel: buildPathLabel({
    courseTitle: row.course_title,
    moduleTitle: row.module_title || null,
    chapterTitle: row.chapter_title || null,
    lessonTitle: row.lesson_title,
  }),
});

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
    throw new ApiError(403, course.accessBlockReason || 'Course access required for lesson reports.', {
      code: 'LESSON_REPORT_ACCESS_DENIED',
      details: {
        courseId: String(courseId),
        lessonId: String(lessonId),
        accessStatus: course.accessStatus || 'not_purchased',
      },
    });
  }
};

const createAdminNotificationsForReport = async ({ report }) => {
  const admins = (await usersRepository.listSafe())
    .filter((user) => String(user.role) === 'admin')
    .map((user) => String(user._id));
  const actionUrl = buildNotificationActionUrl({
    courseId: report.courseId,
    lessonId: report.lessonId,
    reportId: report._id,
  });
  const preview = report.description.length > 120 ? `${report.description.slice(0, 117)}...` : report.description;
  const notifications = await Promise.all(admins.map((adminUserId) =>
    notificationsRepository.create({
      _id: createId('lesson_report_admin'),
      userId: adminUserId,
      title: `New video report from ${report.userName}`,
      message: `${report.pathLabel}: ${preview}`,
      type: 'course-lesson-report',
      entityId: report._id,
      actionUrl,
      actionLabel: 'Open report',
      payload: {
        tab: 'admin',
        adminSection: 'reports',
        reportId: report._id,
        courseId: report.courseId,
        lessonId: report.lessonId,
      },
    })));
  return notifications.length;
};

const createStudentNotificationForReportUpdate = async ({ report }) => {
  return notificationsRepository.create({
    _id: createId('lesson_report_student'),
    userId: report.userId,
    title: `Report ${report.status.replace(/_/g, ' ')}`,
    message: `${report.pathLabel}: ${report.adminReply || report.adminNote || 'Your video report was updated.'}`,
    type: 'course-lesson-report-update',
    entityId: report._id,
    actionUrl: buildNotificationActionUrl({
      courseId: report.courseId,
      lessonId: report.lessonId,
      reportId: report._id,
    }),
    actionLabel: 'View report',
    payload: {
      tab: 'courses',
      courseId: report.courseId,
      lessonId: report.lessonId,
      reportId: report._id,
      supportPanel: 'report',
    },
  });
};

const listLessonReportsForUser = async ({ courseId, lessonId, userId, role }) => {
  await buildLessonContext(courseId, lessonId);
  await assertLessonSupportAccess({ courseId, lessonId, userId, role });

  if (isPostgresReady()) {
    const rows = await queryPostgres(
      `
        SELECT *
        FROM lesson_reports
        WHERE course_id = $1 AND lesson_id = $2 AND user_id = $3
        ORDER BY created_at DESC
      `,
      [String(courseId), String(lessonId), String(userId)],
    );
    return rows.rows.map(mapReportRow);
  }

  return state.lessonReports
    .filter((report) =>
      String(report.courseId) === String(courseId)
      && String(report.lessonId) === String(lessonId)
      && String(report.userId) === String(userId))
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
    .map((report) => clone(report));
};

const createLessonReport = async ({
  courseId,
  lessonId,
  userId,
  role,
  issueType,
  description,
  pageUrl = null,
  userAgent = null,
  screenshotUrl = null,
  attachmentMeta = {},
}) => {
  const user = await usersRepository.findSafeById(userId);
  if (!user) {
    throw new ApiError(404, 'User not found', { code: 'USER_NOT_FOUND' });
  }

  const context = await buildLessonContext(courseId, lessonId);
  await assertLessonSupportAccess({ courseId, lessonId, userId, role });

  const normalizedAttachmentMeta = attachmentMeta && typeof attachmentMeta === 'object' ? attachmentMeta : {};
  const normalizedAttachments = normalizeAttachments(normalizedAttachmentMeta.attachments || []);
  const report = {
    _id: createId('lesson_report'),
    userId: String(user._id),
    courseId: context.courseId,
    lessonId: context.lessonId,
    videoId: context.videoId,
    userName: String(user.name || user.email || 'Learner'),
    userEmail: user.email || null,
    courseTitle: context.courseTitle,
    moduleTitle: context.moduleTitle || null,
    chapterTitle: context.chapterTitle || null,
    lessonTitle: context.lessonTitle,
    issueType: String(issueType || 'other'),
    description: String(description || '').trim(),
    status: 'open',
    screenshotUrl: screenshotUrl || null,
    attachmentMeta: {
      ...normalizedAttachmentMeta,
      attachments: normalizedAttachments,
    },
    attachments: normalizedAttachments,
    adminAttachments: [],
    adminNote: null,
    adminReply: null,
    source: 'video_player',
    pageUrl: pageUrl || null,
    userAgent: userAgent || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    pathLabel: buildPathLabel(context),
  };

  if (isPostgresReady()) {
    const rows = await queryPostgres(
      `
        INSERT INTO lesson_reports (
          id, user_id, course_id, lesson_id, video_id, user_name, user_email,
          course_title, module_title, chapter_title, lesson_title, issue_type,
          description, status, screenshot_url, attachment_meta, admin_attachment_meta, admin_note, admin_reply,
          source, page_url, user_agent, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24)
        RETURNING *
      `,
      [
        report._id,
        report.userId,
        report.courseId,
        report.lessonId,
        report.videoId,
        report.userName,
        report.userEmail,
        report.courseTitle,
        report.moduleTitle,
        report.chapterTitle,
        report.lessonTitle,
        report.issueType,
        report.description,
        report.status,
        report.screenshotUrl,
        JSON.stringify(report.attachmentMeta || {}),
        JSON.stringify({ attachments: [] }),
        null,
        null,
        report.source,
        report.pageUrl,
        report.userAgent,
        report.createdAt,
        report.updatedAt,
      ],
    );
    const persisted = mapReportRow(rows.rows[0]);
    await createAdminNotificationsForReport({ report: persisted });
    return persisted;
  }

  state.lessonReports.push(report);
  await createAdminNotificationsForReport({ report });
  return clone(report);
};

const listAdminLessonReports = async ({ search = '', status = '', courseId = '', lessonId = '', issueType = '', page = 1, pageSize = 25 }) => {
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const normalizedCourseId = String(courseId || '').trim();
  const normalizedLessonId = String(lessonId || '').trim();
  const normalizedIssueType = String(issueType || '').trim().toLowerCase();
  const safePage = Math.max(1, Number(page || 1));
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize || 25)));
  const offset = (safePage - 1) * safePageSize;

  if (isPostgresReady()) {
    const params = [];
    const filters = ['1=1'];
    if (normalizedSearch) {
      params.push(`%${normalizedSearch}%`);
      filters.push(`(
        LOWER(COALESCE(user_name, '')) LIKE $${params.length}
        OR LOWER(COALESCE(user_email, '')) LIKE $${params.length}
        OR LOWER(COALESCE(course_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(module_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(chapter_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(lesson_title, '')) LIKE $${params.length}
        OR LOWER(COALESCE(description, '')) LIKE $${params.length}
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
    if (normalizedIssueType) {
      params.push(normalizedIssueType);
      filters.push(`LOWER(COALESCE(issue_type, 'other')) = $${params.length}`);
    }
    const whereSql = `WHERE ${filters.join(' AND ')}`;
    const totalResult = await queryPostgres(`SELECT COUNT(*)::int AS total FROM lesson_reports ${whereSql}`, params);
    const rows = await queryPostgres(
      `
        SELECT *
        FROM lesson_reports
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, safePageSize, offset],
    );
    const total = Number(totalResult.rows[0]?.total || 0);
    return {
      items: rows.rows.map(mapReportRow),
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / safePageSize)),
      },
    };
  }

  const items = state.lessonReports
    .filter((report) => !normalizedStatus || String(report.status || 'open').toLowerCase() === normalizedStatus)
    .filter((report) => !normalizedCourseId || String(report.courseId) === normalizedCourseId)
    .filter((report) => !normalizedLessonId || String(report.lessonId) === normalizedLessonId)
    .filter((report) => !normalizedIssueType || String(report.issueType || 'other').toLowerCase() === normalizedIssueType)
    .filter((report) => !normalizedSearch || JSON.stringify(report).toLowerCase().includes(normalizedSearch))
    .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())
    .map((report) => clone(report));

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

const updateAdminLessonReport = async ({ reportId, status, adminNote, adminReply, adminAttachments }) => {
  const nextStatus = status ? String(status).trim().toLowerCase() : undefined;
  const nextNote = adminNote === undefined ? undefined : String(adminNote || '').trim() || null;
  const nextReply = adminReply === undefined ? undefined : String(adminReply || '').trim() || null;
  const nextAdminAttachmentMeta = adminAttachments === undefined
    ? undefined
    : { attachments: normalizeAttachments(adminAttachments) };
  const now = nowIso();

  if (isPostgresReady()) {
    const currentRows = await queryPostgres(`SELECT * FROM lesson_reports WHERE id = $1 LIMIT 1`, [String(reportId)]);
    if (!currentRows.rows[0]) {
      throw new ApiError(404, 'Lesson report not found', { code: 'LESSON_REPORT_NOT_FOUND' });
    }
    const current = mapReportRow(currentRows.rows[0]);
    const updatedRows = await queryPostgres(
      `
        UPDATE lesson_reports
        SET status = COALESCE($2, status),
            admin_note = CASE WHEN $3::boolean THEN $4 ELSE admin_note END,
            admin_reply = CASE WHEN $5::boolean THEN $6 ELSE admin_reply END,
            admin_attachment_meta = CASE WHEN $7::boolean THEN $8::jsonb ELSE admin_attachment_meta END,
            updated_at = $9
        WHERE id = $1
        RETURNING *
      `,
      [
        String(reportId),
        nextStatus || null,
        adminNote !== undefined,
        nextNote,
        adminReply !== undefined,
        nextReply,
        adminAttachments !== undefined,
        JSON.stringify(nextAdminAttachmentMeta || { attachments: [] }),
        now,
      ],
    );
    const updated = mapReportRow(updatedRows.rows[0]);
    if ((nextStatus && nextStatus !== current.status) || nextReply || nextNote) {
      await createStudentNotificationForReportUpdate({ report: updated });
    }
    return { previous: current, report: updated };
  }

  const report = state.lessonReports.find((entry) => entry._id === String(reportId));
  if (!report) {
    throw new ApiError(404, 'Lesson report not found', { code: 'LESSON_REPORT_NOT_FOUND' });
  }
  const previous = clone(report);
  if (nextStatus) {
    report.status = nextStatus;
  }
  if (adminNote !== undefined) {
    report.adminNote = nextNote;
  }
  if (adminReply !== undefined) {
    report.adminReply = nextReply;
  }
  if (adminAttachments !== undefined) {
    report.admin_attachment_meta = nextAdminAttachmentMeta;
    report.adminAttachments = normalizeAttachments(adminAttachments);
  }
  report.updatedAt = now;
  if ((nextStatus && nextStatus !== previous.status) || nextReply || nextNote) {
    await createStudentNotificationForReportUpdate({ report });
  }
  return { previous, report: clone(report) };
};

module.exports = {
  listLessonReportsForUser,
  createLessonReport,
  listAdminLessonReports,
  updateAdminLessonReport,
};
