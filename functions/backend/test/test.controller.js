// Test Controller
const { testsRepository } = require('../lib/repositories.js');
const { ApiError, requireString } = require('../lib/http.js');

const getAttemptViewer = (req) => ({
  userId: req.user?.id || null,
  userRole: req.user?.role || 'guest',
});

const sendRepositoryError = (res, err) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      message: err.message,
      code: err.code,
      details: err.details,
    });
  }

  return res.status(500).json({ message: err.message });
};

const getTests = async (req, res) => {
  try {
    const tests = await testsRepository.listForAttempt(getAttemptViewer(req));
    res.json(tests);
  } catch (err) {
    sendRepositoryError(res, err);
  }
};

const getTest = async (req, res) => {
  try {
    const test = await testsRepository.findAttemptById(req.params.id, getAttemptViewer(req));
    if (!test) return res.status(404).json({ message: 'Test not found' });
    res.json(test);
  } catch (err) {
    if (err instanceof ApiError) {
      return sendRepositoryError(res, err);
    }
    res.status(400).json({ message: 'Invalid test id' });
  }
};

const getMyTestAttempts = async (req, res) => {
  try {
    const attempts = await testsRepository.listAttempts(req.user?.id);
    return res.json(attempts);
  } catch (err) {
    return sendRepositoryError(res, err);
  }
};

const createTest = async (req, res) => {
  try {
    if (!req.body?.title) {
      return res.status(400).json({ message: 'title is required' });
    }

    const test = await testsRepository.create({
      ...req.body,
      createdBy: req.user?.id || req.body?.createdBy || null,
    });
    res.status(201).json(test);
  } catch (err) {
    sendRepositoryError(res, err);
  }
};

const updateTest = async (req, res) => {
  try {
    const testId = requireString(req.params.id, 'test id');
    if (!req.body?.title) {
      return res.status(400).json({ message: 'title is required' });
    }

    const test = await testsRepository.update(testId, {
      ...req.body,
      _id: testId,
      updatedBy: req.user?.id || null,
    });

    if (!test) {
      return res.status(404).json({ message: 'Test not found' });
    }

    return res.json(test);
  } catch (err) {
    return sendRepositoryError(res, err);
  }
};

const deleteTest = async (req, res) => {
  try {
    const testId = requireString(req.params.id, 'test id');
    const deleted = await testsRepository.delete(testId);
    if (!deleted) {
      return res.status(404).json({ message: 'Test not found' });
    }

    return res.json({ message: 'Test deleted successfully', testId });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

const submitTest = async (req, res) => {
  try {
    const { answers, startedAt } = req.body || {};
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ message: 'answers object is required' });
    }

    const attempt = await testsRepository.submit(req.params.id, {
      userId: req.user?.id,
      userRole: req.user?.role || 'student',
      answers,
      startedAt,
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Test not found' });
    }

    return res.json(attempt);
  } catch (err) {
    return sendRepositoryError(res, err);
  }
};

module.exports = { getTests, getTest, getMyTestAttempts, createTest, updateTest, deleteTest, submitTest };
