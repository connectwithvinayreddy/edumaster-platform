const test = require('node:test');
const assert = require('node:assert/strict');

const { resetState } = require('../lib/store.js');
const { coursesRepository, videoPlaybackRepository } = require('../lib/repositories.js');
const adminManagement = require('../admin/admin-management.service.js');

const seedState = () => {
  resetState({
    users: [
      {
        _id: 'student_1',
        name: 'Student One',
        email: 'student1@example.com',
        role: 'student',
        accountStatus: 'active',
        created_at: new Date('2026-06-01T00:00:00.000Z').toISOString(),
      },
      {
        _id: 'student_2',
        name: 'Student Two',
        email: 'student2@example.com',
        role: 'student',
        accountStatus: 'active',
        created_at: new Date('2026-06-01T00:00:00.000Z').toISOString(),
      },
    ],
    courses: [
      {
        _id: 'course_1',
        title: 'Protected Access Course',
        price: 999,
        offerPercentage: 0,
        validityDays: 365,
        modules: [
          {
            id: 'module_1',
            title: 'Subject 1',
            lessons: [
              {
                id: 'lesson_root',
                title: 'Root Lesson',
                type: 'youtube',
                durationMinutes: 10,
                premium: true,
                videoUrl: 'https://youtu.be/rootlesson1',
              },
            ],
            chapters: [
              {
                id: 'chapter_1',
                title: 'Chapter 1',
                lessons: [
                  {
                    id: 'lesson_1',
                    title: 'Lesson 1',
                    type: 'youtube',
                    durationMinutes: 10,
                    premium: true,
                    videoUrl: 'https://youtu.be/lesson11111',
                  },
                  {
                    id: 'lesson_2',
                    title: 'Lesson 2',
                    type: 'youtube',
                    durationMinutes: 10,
                    premium: true,
                    videoUrl: 'https://youtu.be/lesson22222',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    enrollments: [
      {
        _id: 'enrollment_1',
        userId: 'student_1',
        courseId: 'course_1',
        accessType: 'course',
        source: 'manual_admin_grant',
        accessStatus: 'enabled',
        adminNote: null,
        enrolledAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        expiresAt: new Date('2027-06-01T00:00:00.000Z').toISOString(),
        viewCount: 0,
        updatedAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
      },
      {
        _id: 'enrollment_2',
        userId: 'student_2',
        courseId: 'course_1',
        accessType: 'course',
        source: 'manual_admin_grant',
        accessStatus: 'enabled',
        adminNote: null,
        enrolledAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
        expiresAt: new Date('2027-06-01T00:00:00.000Z').toISOString(),
        viewCount: 0,
        updatedAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
      },
    ],
  });
};

test.beforeEach(() => {
  seedState();
});

test.after(() => {
  resetState({});
});

test('students keep full lesson visibility when no content access rule exists', async () => {
  const course = await coursesRepository.findVisibleById('course_1', 'student_1');
  const chapterLesson = course.modules[0].chapters[0].lessons.find((lesson) => lesson.id === 'lesson_1');

  assert.equal(chapterLesson?.locked, false);
  assert.equal(chapterLesson?.accessBlockReason || null, null);
});

test('all-students chapter block locks lessons but a student lesson allow overrides it', async () => {
  await coursesRepository.upsertContentAccessRule({
    courseId: 'course_1',
    studentScope: 'all_students',
    contentScope: 'chapter',
    chapterId: 'chapter_1',
    access: 'block',
    adminNote: 'Chapter paused for review',
    createdBy: 'admin_1',
    updatedBy: 'admin_1',
  });

  const blockedCourse = await coursesRepository.findVisibleById('course_1', 'student_2');
  const blockedLesson = blockedCourse.modules[0].chapters[0].lessons.find((lesson) => lesson.id === 'lesson_1');
  assert.equal(blockedLesson?.locked, true);
  assert.equal(blockedLesson?.accessBlockReason, 'Chapter paused for review');

  await coursesRepository.upsertContentAccessRule({
    courseId: 'course_1',
    studentScope: 'student',
    studentId: 'student_2',
    contentScope: 'lesson',
    moduleId: 'module_1',
    chapterId: 'chapter_1',
    lessonId: 'lesson_1',
    access: 'allow',
    adminNote: 'Temporary exception',
    createdBy: 'admin_1',
    updatedBy: 'admin_1',
  });

  const exceptionCourse = await coursesRepository.findVisibleById('course_1', 'student_2');
  const allowedLesson = exceptionCourse.modules[0].chapters[0].lessons.find((lesson) => lesson.id === 'lesson_1');
  const stillBlockedLesson = exceptionCourse.modules[0].chapters[0].lessons.find((lesson) => lesson.id === 'lesson_2');

  assert.equal(allowedLesson?.locked, false);
  assert.equal(stillBlockedLesson?.locked, true);
  assert.equal(stillBlockedLesson?.accessBlockReason, 'Chapter paused for review');
});

test('student-specific lesson watch override changes effective watch state', async () => {
  await coursesRepository.upsertStudentLessonWatchOverride({
    courseId: 'course_1',
    studentId: 'student_1',
    moduleId: 'module_1',
    chapterId: 'chapter_1',
    lessonId: 'lesson_1',
    allowedFullWatches: 5,
    watchCompletionPercent: 80,
    createdBy: 'admin_1',
    updatedBy: 'admin_1',
  });

  const watchState = await videoPlaybackRepository.getWatchState({
    userId: 'student_1',
    courseId: 'course_1',
    lessonId: 'lesson_1',
    videoId: 'lesson_1',
    videoType: 'course',
    videoDurationSeconds: 600,
  });

  assert.equal(watchState.allowedFullWatches, 5);
  assert.equal(watchState.fullWatchThresholdPercentage, 80);
});

test('chapter bulk watch override creates one override per lesson in that chapter', async () => {
  const result = await adminManagement.upsertStudentLessonWatchOverride({
    courseId: 'course_1',
    studentId: 'student_2',
    chapterId: 'chapter_1',
    bulkScope: 'chapter',
    allowedFullWatches: 4,
    watchCompletionPercent: 85,
    adminUserId: 'admin_1',
    requestContext: {},
  });

  assert.equal(result.savedCount, 2);

  const overrides = await coursesRepository.listStudentLessonWatchOverrides({
    courseId: 'course_1',
    studentId: 'student_2',
  });
  assert.equal(overrides.length, 2);
  assert.deepEqual(overrides.map((entry) => entry.lessonId).sort(), ['lesson_1', 'lesson_2']);
});
