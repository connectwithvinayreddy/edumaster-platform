const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSubmittedAnswers,
  scoreMockTestAttempt,
  buildAttemptSolutions,
  deriveTopicStrengths,
} = require('../test/mock-test-attempts.js');

const sampleTest = {
  negativeMarking: 0.5,
  questions: [
    {
      id: 'q1',
      questionText: 'Single answer',
      correctOption: 1,
      marks: 2,
      topic: 'Algebra',
      explanation: 'Use elimination.',
    },
    {
      id: 'q2',
      questionText: 'Multi answer',
      correctOptions: [0, 2],
      marks: 3,
      topic: 'Geometry',
      explanation: 'Both statements are true.',
    },
    {
      id: 'q3',
      questionText: 'Skipped',
      correctOption: 3,
      marks: 1,
      topic: 'Geometry',
      explanation: 'Check the diagram.',
    },
  ],
};

test('normalizeSubmittedAnswers normalizes single and multi-select input', () => {
  const normalized = normalizeSubmittedAnswers({
    q1: '1',
    q2: [2, 0, 2, '0'],
    q3: null,
  });

  assert.deepEqual(normalized, {
    q1: [1],
    q2: [0, 2],
    q3: [],
  });
});

test('scoreMockTestAttempt handles correct, incorrect, and unanswered questions', () => {
  const normalizedAnswers = normalizeSubmittedAnswers({
    q1: 1,
    q2: [2, 1],
  });

  const result = scoreMockTestAttempt(sampleTest, normalizedAnswers);

  assert.equal(result.score, 1.5);
  assert.equal(result.correctCount, 1);
  assert.equal(result.incorrectCount, 1);
  assert.equal(result.unattemptedCount, 1);
});

test('buildAttemptSolutions and deriveTopicStrengths preserve explanations and topic outcomes', () => {
  const normalizedAnswers = normalizeSubmittedAnswers({
    q1: 1,
    q2: [2, 1],
  });

  const scoreResult = scoreMockTestAttempt(sampleTest, normalizedAnswers);
  const { weakTopics, strongTopics } = deriveTopicStrengths(scoreResult.topicStats);
  const solutions = buildAttemptSolutions(sampleTest, normalizedAnswers);

  assert.deepEqual(weakTopics, ['Geometry']);
  assert.deepEqual(strongTopics, ['Algebra']);
  assert.equal(solutions[0].selectedOption, 1);
  assert.deepEqual(solutions[1].selectedOptions, [1, 2]);
  assert.equal(solutions[2].selectedOption, null);
  assert.equal(solutions[2].explanation, 'Check the diagram.');
});
