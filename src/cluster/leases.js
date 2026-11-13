// Distributed leases with fencing tokens. A worker holds a lease per placement;
// the fence number only ever increases, so a worker that was paused (GC, network
// partition) and comes back cannot overwrite state written by its successor.
//
// Drivers: 'sqlite' (default, single host / shared volume) and 'redis' (SET NX PX).

export function createLeases({ driver = 'sqlite', db, redisUrl } = {}) {
  if (driver === 'redis') return new RedisLeases(redisUrl);
  return new SqliteLeases(db);
}

class SqliteLeases {
  constructor(db) { this.db = db; this.kind = 'sqlite'; }

  nextFence(key) {
    this.db.run('INSERT INTO fence_counter(key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1', key);
    return this.db.get('SELECT value FROM fence_counter WHERE key = ?', key).value;
  }

  /** Returns a fence token, or null if someone else holds a live lease. */
  async acquire(key, holder, ttlMs) {
    return this.db.tx(() => {
      const t = Date.now();
      const cur = this.db.get('SELECT holder, fence, expires_at FROM leases WHERE key = ?', key);
      if (cur && cur.expires_at > t && cur.holder !== holder) return null;
      if (cur && cur.holder === holder && cur.expires_at > t) {
        this.db.run('UPDATE leases SET expires_at = ? WHERE key = ?', t + ttlMs, key);
        return cur.fence;
      }
      const fence = this.nextFence(key);
      this.db.run('INSERT INTO leases(key, holder, fence, expires_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, fence = excluded.fence, expires_at = excluded.expires_at',
        key, holder, fence, t + ttlMs);
      return fence;
    });
  }

  /** Extend only if we still hold it with the same fence. */
  async renew(key, holder, fence, ttlMs) {
    const r = this.db.run('UPDATE leases SET expires_at = ? WHERE key = ? AND holder = ? AND fence = ?', Date.now() + ttlMs, key, holder, fence);
    return r.changes === 1;
  }

  async release(key, holder, fence) {
    this.db.run('DELETE FROM leases WHERE key = ? AND holder = ? AND fence = ?', key, holder, fence);
  }

  async holder(key) {
    const r = this.db.get('SELECT holder, fence, expires_at FROM leases WHERE key = ?', key);
    return r && r.expires_at > Date.now() ? r : null;
  }

  async expired() { return this.db.all('SELECT key, holder, fence FROM leases WHERE expires_at <= ?', Date.now()); }
  async sweep() { return this.db.run('DELETE FROM leases WHERE expires_at <= ?', Date.now()).changes; }
  async close() {}
}

class RedisLeases {
  constructor(url) { this.url = url; this.kind = 'redis'; }
  async client() {
    if (!this.redis) {
      const { default: Redis } = await import('ioredis');
      this.redis = new Redis(this.url || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 2, lazyConnect: false });
    }
    return this.redis;
  }
  async acquire(key, holder, ttlMs) {
    const r = await this.client();
    const fence = await r.incr(`shoal:fence:${key}`);
    const ok = await r.set(`shoal:lease:${key}`, `${holder}|${fence}`, 'PX', ttlMs, 'NX');
    if (ok) return fence;
    const cur = await r.get(`shoal:lease:${key}`);
    if (cur && cur.startsWith(`${holder}|`)) { await r.pexpire(`shoal:lease:${key}`, ttlMs); return Number(cur.split('|')[1]); }
    return null;
  }
  async renew(key, holder, fence, ttlMs) {
    const r = await this.client();
    // compare-and-extend atomically
    const res = await r.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", 1, `shoal:lease:${key}`, `${holder}|${fence}`, ttlMs);
    return res === 1;
  }
  async release(key, holder, fence) {
    const r = await this.client();
    await r.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, `shoal:lease:${key}`, `${holder}|${fence}`);
  }
  async holder(key) {
    const r = await this.client();
    const cur = await r.get(`shoal:lease:${key}`);
    if (!cur) return null;
    const [holder, fence] = cur.split('|');
    return { holder, fence: Number(fence) };
  }
  async expired() { return []; } // Redis expires keys itself
  async sweep() { return 0; }
  async close() { await this.redis?.quit().catch(() => {}); }
}
