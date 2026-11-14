// Runs only when KAFKA_BROKERS and REDIS_URL point at live services:
//   KAFKA_BROKERS=localhost:9092 REDIS_URL=redis://localhost:6379 node --test test/kafka-redis.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startSwarmcast } from '../src/server.js';
import { createLeases } from '../src/cluster/leases.js';

const live = process.env.KAFKA_BROKERS && process.env.REDIS_URL;
const until = (fn, ms = 60000) => new Promise((res, rej) => {
  const start = Date.now();
  const t = setInterval(async () => { try { if (await fn()) { clearInterval(t); res(); } else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); } } catch (e) { clearInterval(t); rej(e); } }, 300);
});

test('redis leases: exclusive, fenced', { skip: !live }, async () => {
  const L = createLeases({ driver: 'redis', redisUrl: process.env.REDIS_URL });
  const key = `t-${Date.now()}`;
  const f1 = await L.acquire(key, 'a', 300);
  assert.ok(f1); assert.equal(await L.acquire(key, 'b', 300), null);
  await new Promise((r) => setTimeout(r, 400));
  const f2 = await L.acquire(key, 'b', 5000);
  assert.ok(f2 > f1); assert.equal(await L.renew(key, 'a', f1, 5000), false); assert.equal(await L.renew(key, 'b', f2, 5000), true);
  await L.close();
});

test('kafka bus + redis leases: fleet rollout across two workers', { skip: !live }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swarmcast-kafka-'));
  const common = { dbFile: path.join(root, 'swarmcast.db'), peerPort: 0, dhtPort: 0, dht: false, logRequests: false, jwtSecret: 'k', busDriver: 'kafka', kafkaBrokers: process.env.KAFKA_BROKERS, leaseDriver: 'redis', redisUrl: process.env.REDIS_URL, trackers: [] };
  const api = await startSwarmcast({ ...common, dataDir: root, role: 'api', port: 0 });
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const w = [];
  for (const id of ['k1', 'k2']) w.push(await startSwarmcast({ ...common, dataDir: path.join(root, id), role: 'worker', nodeId: `${id}-${Date.now()}` }));
  try {
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kafka-ops', email: 'k@x.io', password: 'password123' }) }).then((r) => r.json());
    assert.ok(reg.token, JSON.stringify(reg));
    const H = { authorization: `Bearer ${reg.token}` };
    const t = await fetch(`${base}/api/torrent/create-from-file?replicas=all`, { method: 'POST', headers: { ...H, 'x-filename': 'k.bin' }, body: randomBytes(1 << 20) }).then((r) => r.json());
    assert.ok(t.id, JSON.stringify(t));
    await until(async () => { const v = await fetch(`${base}/api/torrent/${t.id}`, { headers: H }).then((r) => r.json()); return v.nodes.length === 2 && v.nodes.every((n) => n.state === 'seeding'); });
    const pause = Date.now();
    await fetch(`${base}/api/torrent/${t.id}/pause`, { method: 'POST', headers: H });
    await until(async () => (await fetch(`${base}/api/torrent/${t.id}`, { headers: H }).then((r) => r.json())).nodes.every((n) => n.state === 'paused'), 30000);
    console.log(`pause propagated over Kafka in ${Date.now() - pause} ms`);
    const ready = await fetch(`${base}/api/ready`).then((r) => r.json());
    assert.equal(ready.checks.bus, 'kafka'); assert.equal(ready.checks.leases, 'ok');
  } finally {
    for (const x of w) await x.stop();
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});
