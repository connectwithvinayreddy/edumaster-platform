const { publishRedisMessage, subscribeRedisChannel } = require('../lib/redis.js');

const LIVE_EVENTS_CHANNEL = 'live:events:broadcast';
const localListeners = new Set();
const instanceId = `${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
let subscription = null;

const emitLocal = (message) => {
  localListeners.forEach((listener) => {
    try {
      listener(message);
    } catch (error) {
      console.error('[live-event-bus] listener failed', error);
    }
  });
};

const startLiveEventBus = () => {
  if (subscription) {
    return subscription;
  }

  subscription = subscribeRedisChannel({
    channel: LIVE_EVENTS_CHANNEL,
    onMessage: (payload) => {
      try {
        const parsed = JSON.parse(payload);
        if (!parsed || parsed.instanceId === instanceId || !parsed.message) {
          return;
        }
        emitLocal(parsed.message);
      } catch (error) {
        console.error('[live-event-bus] unable to parse redis event', error);
      }
    },
    onError: (error) => {
      console.error('[live-event-bus] redis subscription error', error);
    },
  });

  return subscription;
};

const stopLiveEventBus = () => {
  if (!subscription) {
    return;
  }
  subscription.close();
  subscription = null;
};

const subscribeLiveEvents = (listener) => {
  localListeners.add(listener);
  return () => {
    localListeners.delete(listener);
  };
};

const broadcastLiveEvent = async (message) => {
  emitLocal(message);
  try {
    await publishRedisMessage(LIVE_EVENTS_CHANNEL, JSON.stringify({
      instanceId,
      message,
    }));
  } catch (error) {
    console.error('[live-event-bus] publish failed', error);
  }
};

module.exports = {
  broadcastLiveEvent,
  startLiveEventBus,
  stopLiveEventBus,
  subscribeLiveEvents,
};
