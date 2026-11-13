// Speed measurement (sliding window) and token-bucket throttling.

export class Meter {
  constructor(windowMs = 5000) { this.windowMs = windowMs; this.samples = []; this.total = 0; }
  add(bytes) {
    const now = Date.now();
    this.total += bytes;
    const last = this.samples[this.samples.length - 1];
    if (last && now - last[0] < 250) last[1] += bytes; else this.samples.push([now, bytes]);
    this.trim(now);
  }
  trim(now = Date.now()) { while (this.samples.length && now - this.samples[0][0] > this.windowMs) this.samples.shift(); }
  /** bytes per second */
  rate() {
    const now = Date.now(); this.trim(now);
    if (!this.samples.length) return 0;
    const sum = this.samples.reduce((n, s) => n + s[1], 0);
    const span = Math.max(1000, now - this.samples[0][0]);
    return Math.round((sum * 1000) / span);
  }
}

/**
 * Token bucket. limit = bytes/sec, 0 means unlimited. take(n) resolves once n
 * bytes may be spent, so callers simply await it before sending or requesting.
 */
export class Throttle {
  constructor(limit = 0) { this.setLimit(limit); this.waiters = []; }
  setLimit(limit) {
    this.limit = Math.max(0, Number(limit) || 0);
    this.tokens = this.limit; this.updated = Date.now();
  }
  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.limit, this.tokens + ((now - this.updated) / 1000) * this.limit);
    this.updated = now;
  }
  async take(n) {
    if (!this.limit) return;
    for (;;) {
      this.refill();
      // Allow a single oversized request through once the bucket is full.
      if (this.tokens >= Math.min(n, this.limit)) { this.tokens -= n; return; }
      const need = Math.min(n, this.limit) - this.tokens;
      await new Promise((r) => setTimeout(r, Math.max(10, (need / this.limit) * 1000)));
    }
  }
}

export class SpeedHistory {
  constructor({ samples = 120, intervalMs = 1000 } = {}) { this.max = samples; this.intervalMs = intervalMs; this.list = []; }
  push(downloadSpeed, uploadSpeed) {
    this.list.push({ timestamp: Date.now(), downloadSpeed, uploadSpeed });
    if (this.list.length > this.max) this.list.shift();
  }
  toJSON() { return { history: this.list, maxSamples: this.max, intervalMs: this.intervalMs, timestamp: new Date().toISOString() }; }
}
