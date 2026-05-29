// Winston logger setup
const { createLogger, format, transports } = require('winston');
const uuidv4 = require('uuid').v4;

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'edumaster-backend' },
  transports: [
    new transports.Console(),
    // Add file or cloud transports as needed
  ],
});

// Middleware to add correlation ID to each request
function correlationIdMiddleware(req, res, next) {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}

module.exports = { logger, correlationIdMiddleware };
