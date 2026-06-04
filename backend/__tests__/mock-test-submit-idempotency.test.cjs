const test = require('node:test');
const assert = require('node:assert/strict');

const { resetState, state } = require('../lib/store.js');
const { testsRepository } = require('../lib/repositories.js');

const waitForAsyncQueue = () => new Promise((resolve) => setTimeout(resolve, 25));

const seedState = () => {
  resetState({
    users: [
      {
        _id: 'student_1',
        name: 'Student One',
        email: 'student1@example.com',
        role: 'student',
        points: 0,
        accountStatus: 'active',
        created_at: new Date('2026-06-04T09:00:00.000Z').toISOString(),
      },
    ],
    courses: [
      {
        _id: 'course_1',
        title: 'Mock Test Course',
        price: 0,
        validityDays: 365,
        created_at: new Date('2026-06-04T09:00:00.000Z').toISOString(),
      },
    ],
    enrollments: [
      {
        _id: 'enrollment_1',
        userId: 'student_1',
        courseId: 'course_1',
        accessType: 'course',
        source: 'seed',
        accessStatus: 'enabled',
        adminNote: null,
        enrolledAt: new Date('2026-06-04T09:05:00.000Z').toISOString(),
        expiresAt: new Date('2027-06-04T09:05:00.000Z').toISOString(),
        viewCount: 0,
        updatedAt: new Date('2026-06-04T09:05:00.000Z').toISOString(),
      },
    ],
    tests: [
      {
        _id: 'test_1',
        title: 'Concurrency Mock',
        description: 'Burst submit test',
        category: 'SSC JE',
        type: 'full-length',
        durationMinutes: 60,
        totalMarks: 4,
        negativeMarking: 1,
        course: 'course_1',
        sectionBreakup: [],
        questions: [
          {
            id: 'q1',
            questionText: 'Question 1',
            correctOption: 1,
            marks: 2,
            topic: 'Maths',
            explanation: 'Answer 1',
          },
          {
            id: 'q2',
            questionText: 'Question 2',
            correctOption: 0,
            marks: 2,
            topic: 'Science',
            explanation: 'Answer 0',
          },
        ],
        created_at: new Date('2026-06-04T09:10:00.000Z').toISOString(),
      },
    ],
  });
};

test.afterEach(async () => {
  await waitForAsyncQueue();
  resetState({});
});

test('submit deduplicates concurrent attempts and awards points once', async () => {
  seedState();

  const [first, second] = await Promise.all([
    testsRepository.submit('test_1', {
      userId: 'student_1',
      userRole: 'student',
      answers: { q1: 1, q2: 0 },
      startedAt: '2026-06-04T09:15:00.000Z',
    }),
    testsRepository.submit('test_1', {
      userId: 'student_1',
      userRole: 'student',
      answers: { q1: 1, q2: 0 },
      startedAt: '2026-06-04T09:15:00.000Z',
    }),
  ]);

  assert.equal(first._id, second._id);
  assert.equal(first.rankStatus, 'pending');
  assert.equal(state.testAttempts.length, 1);
  assert.equal(state.users[0].points, 4);
});
