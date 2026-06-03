const { ApiError } = require('../lib/http.js');

const normalizeExpressError = (error) => {
  if (error instanceof ApiError) {
    return error;
  }

  if (error?.type === 'entity.parse.failed') {
    return new ApiError(400, 'Malformed JSON body', { code: 'INVALID_JSON' });
  }

  if (error?.type === 'entity.too.large') {
    return new ApiError(413, 'Request body is too large', { code: 'PAYLOAD_TOO_LARGE' });
  }

  if (error?.type === 'encoding.unsupported') {
    return new ApiError(415, 'Unsupported request encoding', { code: 'UNSUPPORTED_ENCODING' });
  }

  return error;
};

const notFoundHandler = (_req, res) => {
  res.status(404).json({
    message: 'Route not found',
    code: 'ROUTE_NOT_FOUND',
  });
};

const errorHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const normalizedError = normalizeExpressError(error);
  const status = normalizedError instanceof ApiError
    ? normalizedError.status
    : Number(normalizedError?.status || normalizedError?.statusCode || 500);
  const message = normalizedError instanceof ApiError
    ? normalizedError.message
    : normalizedError?.message || 'Internal server error';
  const code = normalizedError instanceof ApiError
    ? normalizedError.code
    : normalizedError?.code || 'INTERNAL_SERVER_ERROR';
  const requestId = req?.requestId || null;

  if (status >= 500) {
    console.error('[http-error]', {
      requestId,
      method: req?.method,
      path: req?.originalUrl || req?.url,
      status,
      code,
      message,
      handled: normalizedError instanceof ApiError,
      stack: normalizedError?.stack || null,
    });
  }

  res.status(status).json({
    message,
    code,
    requestId,
    ...(normalizedError instanceof ApiError && normalizedError.details ? { details: normalizedError.details } : {}),
  });
};

module.exports = {
  notFoundHandler,
  errorHandler,
};
