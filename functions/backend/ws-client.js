const { logger } = require('./lib/logger.js');

// Phase 1: WebSocket client utility for frontend integration
export class EduWsClient {
  constructor({ url, token, onMessage }) {
    this.url = url;
    this.token = token;
    this.onMessage = onMessage;
    this.ws = null;
  }
  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: 'auth', token: this.token }));
    };
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (this.onMessage) this.onMessage(data);
    };
    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 2000); // auto-reconnect
    };
  }
  sendChat(message) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'chat', message }));
    }
  }
}
