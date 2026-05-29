const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { appConfig } = require('./config.js');

const parseRedisTarget = () => {
  if (!appConfig.redisUrl) {
    return null;
  }

  try {
    const url = new URL(appConfig.redisUrl);
    return {
      host: url.hostname,
      port: Number(url.port || 6379),
      username: url.username ? decodeURIComponent(url.username) : null,
      password: url.password || null,
      secure: url.protocol === 'rediss:',
    };
  } catch {
    return null;
  }
};

const writeResp = (socket, commandParts) => {
  const payload = [`*${commandParts.length}`];
  commandParts.forEach((part) => {
    const value = String(part);
    payload.push(`$${Buffer.byteLength(value)}`);
    payload.push(value);
  });
  socket.write(`${payload.join('\r\n')}\r\n`);
};

const parseResp = (buffer, offset = 0) => {
  if (offset >= buffer.length) {
    return null;
  }

  const type = String.fromCharCode(buffer[offset]);
  const findCrlf = (start) => buffer.indexOf('\r\n', start, 'utf8');
  const lineEnd = findCrlf(offset);

  if (lineEnd === -1) {
    return null;
  }

  if (type === '+') {
    return {
      value: buffer.toString('utf8', offset + 1, lineEnd),
      bytesConsumed: lineEnd + 2 - offset,
    };
  }

  if (type === '-') {
    return {
      error: new Error(buffer.toString('utf8', offset + 1, lineEnd)),
      bytesConsumed: lineEnd + 2 - offset,
    };
  }

  if (type === ':') {
    return {
      value: Number(buffer.toString('utf8', offset + 1, lineEnd)),
      bytesConsumed: lineEnd + 2 - offset,
    };
  }

  if (type === '$') {
    const length = Number(buffer.toString('utf8', offset + 1, lineEnd));
    if (length === -1) {
      return {
        value: null,
        bytesConsumed: lineEnd + 2 - offset,
      };
    }

    const bodyStart = lineEnd + 2;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd + 2) {
      return null;
    }

    return {
      value: buffer.toString('utf8', bodyStart, bodyEnd),
      bytesConsumed: bodyEnd + 2 - offset,
    };
  }

  if (type === '*') {
    const length = Number(buffer.toString('utf8', offset + 1, lineEnd));
    let cursor = lineEnd + 2;
    const values = [];

    for (let index = 0; index < length; index += 1) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) {
        return null;
      }

      if (parsed.error) {
        return parsed;
      }

      values.push(parsed.value);
      cursor += parsed.bytesConsumed;
    }

    return {
      value: values,
      bytesConsumed: cursor - offset,
    };
  }

  return {
    error: new Error(`Unsupported Redis response type: ${type}`),
    bytesConsumed: buffer.length - offset,
  };
};

const createRedisSocket = () => {
  const target = parseRedisTarget();
  if (!target) {
    return null;
  }

  return target.secure
    ? tls.connect({ host: target.host, port: target.port, servername: target.host })
    : net.createConnection({ host: target.host, port: target.port });
};

const REDIS_COMMAND_POOL_SIZE = Math.max(1, Number(process.env.REDIS_COMMAND_POOL_SIZE || 8));
let redisCommandPool = [];
let redisCommandPoolTargetKey = null;
let redisCommandPoolCursor = 0;

const createRedisCommandClient = (target) => {
  let socket = null;
  let buffer = Buffer.alloc(0);
  let connected = false;
  let authenticated = !target.password;
  let connectPromise = null;
  let currentCommand = null;
  let queue = Promise.resolve();

  const resetState = () => {
    connected = false;
    authenticated = !target.password;
    connectPromise = null;
    buffer = Buffer.alloc(0);
    if (currentCommand) {
      currentCommand.reject(new Error('Redis connection closed'));
      currentCommand = null;
    }
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
      socket = null;
    }
  };

  const awaitSingleResponse = () => new Promise((resolve, reject) => {
    currentCommand = { resolve, reject };
  });

  const flushBuffer = () => {
    while (buffer.length > 0 && currentCommand) {
      const parsed = parseResp(buffer);
      if (!parsed) {
        return;
      }

      buffer = buffer.slice(parsed.bytesConsumed);
      const pending = currentCommand;
      currentCommand = null;

      if (parsed.error) {
        pending.reject(parsed.error);
        return;
      }

      pending.resolve(parsed.value);
    }
  };

  const ensureConnected = async () => {
    if (connected && authenticated && socket) {
      return;
    }

    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = new Promise((resolve, reject) => {
      const nextSocket = target.secure
        ? tls.connect({ host: target.host, port: target.port, servername: target.host })
        : net.createConnection({ host: target.host, port: target.port });

      socket = nextSocket;
      socket.setTimeout(30_000);

      const fail = (error) => {
        resetState();
        reject(error);
      };

      socket.on('connect', async () => {
        connected = true;
        try {
          if (target.password) {
            writeResp(
              socket,
              target.username
                ? ['AUTH', target.username, target.password]
                : ['AUTH', target.password],
            );
            await awaitSingleResponse();
            authenticated = true;
          }
          resolve();
        } catch (error) {
          fail(error);
        } finally {
          connectPromise = null;
        }
      });

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        flushBuffer();
      });

      socket.on('timeout', () => fail(new Error('Redis connection timed out')));
      socket.on('error', (error) => {
        if (connectPromise) {
          fail(error);
          return;
        }
        resetState();
      });
      socket.on('close', () => {
        resetState();
      });
    });

    return connectPromise;
  };

  const run = (commandParts) => {
    queue = queue.then(async () => {
      await ensureConnected();
      writeResp(socket, commandParts);
      return await awaitSingleResponse();
    });

    return queue.catch((error) => {
      queue = Promise.resolve();
      throw error;
    });
  };

  return {
    run,
    close: resetState,
  };
};

const getRedisCommandPool = (target) => {
  const targetKey = `${target.secure ? 'rediss' : 'redis'}://${target.host}:${target.port}:${target.username || ''}`;
  if (redisCommandPoolTargetKey !== targetKey || redisCommandPool.length === 0) {
    redisCommandPool.forEach((client) => client.close());
    redisCommandPool = Array.from({ length: REDIS_COMMAND_POOL_SIZE }, () => createRedisCommandClient(target));
    redisCommandPoolTargetKey = targetKey;
    redisCommandPoolCursor = 0;
  }

  return redisCommandPool;
};

const executeRedisCommand = async (commandParts) => {
  const target = parseRedisTarget();
  if (!target) {
    return null;
  }

  const pool = getRedisCommandPool(target);
  const client = pool[redisCommandPoolCursor % pool.length];
  redisCommandPoolCursor = (redisCommandPoolCursor + 1) % pool.length;
  return client.run(commandParts);
};

const getRedisValue = async (key) => {
  if (!parseRedisTarget()) {
    return null;
  }

  return executeRedisCommand(['GET', key]);
};

const setRedisValue = async (key, value, options = {}) => {
  if (!parseRedisTarget()) {
    return false;
  }

  const command = ['SET', key, value];
  if (Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0) {
    command.push('EX', String(options.ttlSeconds));
  }

  await executeRedisCommand(command);
  return true;
};

const deleteRedisKey = async (key) => {
  if (!parseRedisTarget()) {
    return false;
  }

  await executeRedisCommand(['DEL', key]);
  return true;
};

const addRedisSetMember = async (key, member) => {
  if (!parseRedisTarget()) {
    return false;
  }

  await executeRedisCommand(['SADD', key, member]);
  return true;
};

const removeRedisSetMember = async (key, member) => {
  if (!parseRedisTarget()) {
    return false;
  }

  await executeRedisCommand(['SREM', key, member]);
  return true;
};

const getRedisSetMembers = async (key) => {
  if (!parseRedisTarget()) {
    return [];
  }

  const members = await executeRedisCommand(['SMEMBERS', key]);
  return Array.isArray(members) ? members : [];
};

const getRedisJson = async (key) => {
  const raw = await getRedisValue(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const setRedisJson = async (key, value, options = {}) => {
  return setRedisValue(key, JSON.stringify(value), options);
};

const incrementRedisCounter = async (key, ttlSeconds) => {
  if (!parseRedisTarget()) {
    return null;
  }

  const count = await executeRedisCommand(['INCR', key]);
  if (Number(count) === 1 && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    await executeRedisCommand(['EXPIRE', key, String(ttlSeconds)]);
  }

  return Number(count);
};

const publishRedisMessage = async (channel, message) => {
  if (!parseRedisTarget()) {
    return 0;
  }

  const listeners = await executeRedisCommand(['PUBLISH', String(channel), String(message)]);
  return Number(listeners || 0);
};

const subscribeRedisChannel = ({ channel, onMessage, onError, onStatus }) => {
  const target = parseRedisTarget();
  if (!target) {
    return {
      close() {},
    };
  }

  let socket = null;
  let buffer = Buffer.alloc(0);
  let authPending = Boolean(target.password);
  let closed = false;
  let reconnectTimer = null;

  const connect = () => {
    if (closed) {
      return;
    }

    socket = createRedisSocket();
    if (!socket) {
      return;
    }

    socket.setTimeout(0);

    socket.on('connect', () => {
      if (typeof onStatus === 'function') {
        onStatus('connected');
      }
      if (target.password) {
        writeResp(
          socket,
          target.username
            ? ['AUTH', target.username, target.password]
            : ['AUTH', target.password],
        );
      } else {
        writeResp(socket, ['SUBSCRIBE', String(channel)]);
      }
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length > 0) {
        const parsed = parseResp(buffer);
        if (!parsed) {
          return;
        }
        buffer = buffer.slice(parsed.bytesConsumed);

        if (parsed.error) {
          if (typeof onError === 'function') {
            onError(parsed.error);
          }
          return;
        }

        if (authPending) {
          authPending = false;
          writeResp(socket, ['SUBSCRIBE', String(channel)]);
          continue;
        }

        const value = parsed.value;
        if (Array.isArray(value) && value[0] === 'message' && value[1] === String(channel)) {
          if (typeof onMessage === 'function') {
            onMessage(String(value[2] || ''));
          }
        }
      }
    });

    socket.on('error', (error) => {
      if (typeof onError === 'function') {
        onError(error);
      }
    });

    socket.on('close', () => {
      if (typeof onStatus === 'function') {
        onStatus('closed');
      }
      if (closed) {
        return;
      }
      authPending = Boolean(target.password);
      buffer = Buffer.alloc(0);
      reconnectTimer = setTimeout(connect, 1000);
    });
  };

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        socket.destroy();
      }
    },
  };
};

const checkRedisHealth = async () => {
  const target = parseRedisTarget();
  if (!target) {
    return {
      enabled: false,
      status: 'disabled',
      detail: 'REDIS_URL not configured',
    };
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let settled = false;

    const finish = (status, detail) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve({
        enabled: true,
        status,
        detail,
      });
    };

    socket.setTimeout(5_000);

    socket.on('connect', () => {
      if (target.password) {
        writeResp(socket, ['AUTH', target.password]);
      }
      writeResp(socket, ['PING']);
    });

    socket.on('data', (data) => {
      const response = data.toString('utf8');
      if (response.includes('+PONG')) {
        finish('up', `${target.host}:${target.port}`);
      } else if (response.startsWith('-ERR')) {
        finish('down', response.trim());
      }
    });

    socket.on('timeout', () => finish('down', 'Redis connection timed out'));
    socket.on('error', (error) => finish('down', error.message));
  });
};

module.exports = {
  checkRedisHealth,
  getRedisValue,
  setRedisValue,
  deleteRedisKey,
  addRedisSetMember,
  removeRedisSetMember,
  getRedisSetMembers,
  getRedisJson,
  setRedisJson,
  incrementRedisCounter,
  publishRedisMessage,
  subscribeRedisChannel,
};
