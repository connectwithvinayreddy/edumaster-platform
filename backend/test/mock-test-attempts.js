const normalizeOptionIndexes = (value) => {
  if (Array.isArray(value)) {
    return [...new Set(
      value
        .map((option) => Number(option))
        .filter((option) => Number.isInteger(option) && option >= 0),
    )].sort((left, right) => left - right);
  }

  if (value === undefined || value === null || value === '') {
    return [];
  }

  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? [normalized] : [];
};

const getCorrectOptionIndexes = (question) => {
  if (Array.isArray(question?.correctOptions) && question.correctOptions.length > 0) {
    return normalizeOptionIndexes(question.correctOptions);
  }

  return normalizeOptionIndexes(question?.correctOption ?? question?.answer);
};

const normalizeSubmittedAnswers = (answers = {}) => {
  const normalized = {};
  Object.entries(answers || {}).forEach(([questionId, value]) => {
    normalized[String(questionId)] = normalizeOptionIndexes(value);
  });
  return normalized;
};

const scoreMockTestAttempt = (test, normalizedAnswers) => {
  let score = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unattemptedCount = 0;
  const topicStats = new Map();

  (test?.questions || []).forEach((question) => {
    const submittedOptionIndexes = normalizedAnswers[String(question.id)] || [];
    const correctOptionIndexes = getCorrectOptionIndexes(question);
    const topic = question.topic || 'General Practice';
    const currentStats = topicStats.get(topic) || { correct: 0, incorrect: 0 };

    if (submittedOptionIndexes.length === 0) {
      unattemptedCount += 1;
    } else if (
      submittedOptionIndexes.length === correctOptionIndexes.length
      && submittedOptionIndexes.every((option, optionIndex) => option === correctOptionIndexes[optionIndex])
    ) {
      correctCount += 1;
      score += Number(question.marks || 1);
      currentStats.correct += 1;
    } else {
      incorrectCount += 1;
      score -= Number(test?.negativeMarking || 0);
      currentStats.incorrect += 1;
    }

    topicStats.set(topic, currentStats);
  });

  return {
    score: Number(score.toFixed(2)),
    correctCount,
    incorrectCount,
    unattemptedCount,
    topicStats,
  };
};

const deriveTopicStrengths = (topicStats) => {
  const weakTopics = [];
  const strongTopics = [];

  topicStats.forEach((stats, topic) => {
    if (stats.incorrect > stats.correct) {
      weakTopics.push(topic);
    } else if (stats.correct > 0) {
      strongTopics.push(topic);
    }
  });

  return {
    weakTopics,
    strongTopics,
  };
};

const buildAttemptSolutions = (test, normalizedAnswers) => (
  (test?.questions || []).map((question) => {
    const selectedOptions = normalizedAnswers[String(question.id)] || [];
    const correctOptions = getCorrectOptionIndexes(question);
    return {
      questionId: question.id,
      questionText: question.questionText,
      selectedOption: selectedOptions.length <= 1 ? (selectedOptions[0] ?? null) : null,
      selectedOptions,
      correctOption: correctOptions[0] ?? 0,
      correctOptions,
      explanation: question.explanation || '',
      topic: question.topic || 'General Practice',
    };
  })
);

const rankMockTestAttempts = (attempts = []) => {
  const sorted = [...attempts].sort((left, right) => {
    if (Number(right.score || 0) !== Number(left.score || 0)) {
      return Number(right.score || 0) - Number(left.score || 0);
    }

    const completedAtDiff = Date.parse(String(left.completedAt || 0)) - Date.parse(String(right.completedAt || 0));
    if (completedAtDiff !== 0) {
      return completedAtDiff;
    }

    return String(left._id || '').localeCompare(String(right._id || ''));
  });

  const totalAttempts = sorted.length;
  return sorted.map((attempt, index) => ({
    ...attempt,
    rank: index + 1,
    percentile: totalAttempts <= 1
      ? 100
      : Number((((totalAttempts - (index + 1)) / totalAttempts) * 100).toFixed(2)),
    rankStatus: 'ready',
    rankComputedAt: new Date().toISOString(),
  }));
};

module.exports = {
  normalizeSubmittedAnswers,
  scoreMockTestAttempt,
  buildAttemptSolutions,
  deriveTopicStrengths,
  rankMockTestAttempts,
};
