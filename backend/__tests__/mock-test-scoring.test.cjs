const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSubmittedAnswers,
  scoreMockTestAttempt,
  buildAttemptSolutions,
  deriveTopicStrengths,
} = require('../test/mock-test-attempts.js');

test('mock-test scoring helpers support single-answer, multi-answer, negative marking, and topic strengths', () => {
  const mockTest = {
    negativeMarking: 1,
    questions: [
      {
        id: 'q1',
        questionText: 'Single answer',
        correctOption: 1,
        marks: 3,
        topic: 'Maths',
        explanation: 'Math explanation',
      },
      {
        id: 'q2',
        questionText: 'Multi answer',
        correctOptions: [0, 2],
        marks: 3,
        topic: 'Reasoning',
        explanation: 'Reasoning explanation',
      },
      {
        id: 'q3',
        questionText: 'Left blank',
        correctOption: 3,
        marks: 3,
        topic: 'English',
        explanation: 'English explanation',
      },
    ],
  };

  const normalized = normalizeSubmittedAnswers({
    q1: 1,
    q2: [2, 0, 2],
    q3: '',
  });

  assert.deepEqual(normalized, {
    q1: [1],
    q2: [0, 2],
    q3: [],
  });

  const score = scoreMockTestAttempt(mockTest, normalized);
  assert.equal(score.score, 6);
  assert.equal(score.correctCount, 2);
  assert.equal(score.incorrectCount, 0);
  assert.equal(score.unattemptedCount, 1);

  const incorrectScore = scoreMockTestAttempt(mockTest, normalizeSubmittedAnswers({
    q1: 0,
    q2: [0, 3],
    q3: '',
  }));
  assert.equal(incorrectScore.score, -2);
  assert.equal(incorrectScore.correctCount, 0);
  assert.equal(incorrectScore.incorrectCount, 2);
  assert.equal(incorrectScore.unattemptedCount, 1);

  const topicStrengths = deriveTopicStrengths(incorrectScore.topicStats);
  assert.deepEqual(topicStrengths.weakTopics.sort(), ['Maths', 'Reasoning']);
  assert.deepEqual(topicStrengths.strongTopics, []);

  const solutions = buildAttemptSolutions(mockTest, normalized);
  assert.equal(solutions.length, 3);
  assert.deepEqual(solutions[1].selectedOptions, [0, 2]);
  assert.deepEqual(solutions[1].correctOptions, [0, 2]);
  assert.equal(solutions[2].selectedOption, null);
});
