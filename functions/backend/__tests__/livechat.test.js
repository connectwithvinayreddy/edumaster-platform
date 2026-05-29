// Jest + SuperTest: Live chat WebSocket test (MVP)
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { appConfig } = require('../lib/config.js');

describe('WebSocket Chat', () => {
  let ws;
  const token = jwt.sign({ id: 'testuser' }, appConfig.jwtSecret);

  beforeAll((done) => {
    ws = new WebSocket('ws://localhost:6001');
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      done();
    });
  });

  afterAll(() => {
    ws.close();
  });

  it('should authenticate and send/receive chat', (done) => {
    ws.on('message', (msg) => {
      const data = JSON.parse(msg);
      if (data.type === 'auth_ok') {
        ws.send(JSON.stringify({ type: 'chat', message: 'Hello world!' }));
      }
      if (data.type === 'chat' && data.message === 'Hello world!') {
        expect(data.userId).toBe('testuser');
        done();
      }
    });
  });
});
