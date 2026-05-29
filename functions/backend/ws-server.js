// Phase 1: WebSocket server for real-time chat (MVP)
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { appConfig } = require('./lib/config.js');
const { logger } = require('./lib/logger.js');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// In-memory user<->socket mapping (replace with Redis for scale)
const userSockets = new Map();

wss.on('connection', (ws, req) => {
  let userId = null;
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth' && data.token) {
        const decoded = jwt.verify(data.token, appConfig.jwtSecret);
        userId = decoded.id;
        userSockets.set(userId, ws);
        ws.send(JSON.stringify({ type: 'auth_ok', userId }));
      } else if (data.type === 'chat' && userId) {
        // Broadcast to all (MVP); later: room-based
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'chat',
              userId,
              message: data.message,
              ts: Date.now(),
            }));
          }
        });
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });
  ws.on('close', () => {
    if (userId) userSockets.delete(userId);
  });
});

const PORT = process.env.WS_PORT || 6001;
server.listen(PORT, () => {
  logger.info(`[ws-server] WebSocket server running on port ${PORT}`);
});
