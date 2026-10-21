const EventEmitter = require('events');
const services = require('./services');

const POLL_INTERVAL_MS = 5000;

class ServiceEventWatcher extends EventEmitter {
  constructor() {
    super();
    this.lastStatuses = new Map(); // key: `${type}:${name}` -> status
  }

  start() {
    setInterval(() => this.poll().catch((err) => console.error('[events] poll error:', err.message)), POLL_INTERVAL_MS);
  }

  async poll() {
    const list = await services.listAll();
    for (const item of list) {
      const key = `${item.type}:${item.name}`;
      const prev = this.lastStatuses.get(key);
      if (prev !== undefined && prev !== item.status) {
        this.emit('change', {
          type: item.type,
          name: item.name,
          previousStatus: prev,
          status: item.status,
          timestamp: Date.now(),
        });
      }
      this.lastStatuses.set(key, item.status);
    }
  }
}

module.exports = new ServiceEventWatcher();
