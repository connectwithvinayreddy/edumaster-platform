let logger;

try {
  const { createLogger, format, transports } = require('winston');
  logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: format.combine(
      format.timestamp(),
      format.errors({ stack: true }),
      format.splat(),
      format.json(),
    ),
    defaultMeta: { service: 'edumaster-backend' },
    transports: [
      new transports.Console(),
    ],
  });
} catch (error) {
  const write = (level, message, meta) => {
    const payload = {
      level,
      message,
      ...(meta && typeof meta === 'object' ? meta : {}),
      timestamp: new Date().toISOString(),
      service: 'edumaster-backend',
    };
    const line = JSON.stringify(payload);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  logger = {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}

module.exports = logger;
