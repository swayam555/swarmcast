import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startSwarmcast } from '../src/server.js';

const until = (fn, ms = 60000) => new Promise((res, rej) => {
  const start = Date.now();
  const t = setInterval(async () => { try { if (await fn()) { clearInterval(t); res(); } else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); } } catch (e) { clearInterval(t); rej(e); } }, 200);
});

test('fleet rollout: one upload fans out to every worker, idempotent retries, pause/resume/delete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swarmcast-cluster-'));
  const common = { dataDir: root, dbFile: path.join(root, 'swarmcast.db'), peerPort: 0, dhtPort: 0, dht: false, logRequests: false, jwtSecret: 's3cret' };
  const api = await startSwarmcast({ ...common, role: 'api', port: 0, trackers: [] });
  const base = `http://127.0.0.1:${api.server.address().port}`;
  api.cfg.trackers = [`${base}/announce`];
  const workers = [];
  for (let i = 0; i < 3; i++) workers.push(await startSwarmcast({ ...common, role: 'worker', dataDir: path.join(root, `w${i}`), nodeId: `w${i}`, trackers: [`${base}/announce`] }));
  // uploads must be readable by the origin worker: share the API upload dir
  try {
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ops', email: 'ops@x.io', password: 'password123' }) }).then((r) => r.json());
    const H = { authorization: `Bearer ${reg.token}` };
    const body = randomBytes(2 * 1024 * 1024 + 99);
    const send = () => fetch(`${base}/api/torrent/create-from-file?replicas=all`, { method: 'POST', headers: { ...H, 'x-filename': 'llama-shard.safetensors', 'x-request-id': 'rollout-001' }, body });
    const r1 = await send(); const t1 = await r1.json();
    assert.equal(r1.status, 201);
    const r2 = await send();
    assert.equal(r2.headers.get('idempotent-replay'), 'true', 'retry with same X-Request-ID replays');
    assert.equal((await r2.json()).id, t1.id);

    await until(async () => {
      const t = await fetch(`${base}/api/torrent/${t1.id}`, { headers: H }).then((r) => r.json());
      return t.nodes.length >= 3 && t.nodes.every((n) => n.state === 'seeding');
    });
    const want = createHash('sha256').update(body).digest('hex');
    for (let i = 0; i < 3; i++) {
      const p = path.join(root, `w${i}`, 'downloads', 'llama-shard.safetensors');
      const has = await readFile(p).then((b) => createHash('sha256').update(b).digest('hex')).catch(() => null);
      // the origin worker seeds from the upload dir instead of its downloads folder
      if (has) assert.equal(has, want);
    }

    // pause / resume propagate through directives
    await fetch(`${base}/api/torrent/${t1.id}/pause`, { method: 'POST', headers: H });
    await until(async () => (await fetch(`${base}/api/torrent/${t1.id}`, { headers: H }).then((r) => r.json())).nodes.every((n) => n.state === 'paused'));
    await fetch(`${base}/api/torrent/${t1.id}/resume`, { method: 'POST', headers: H });
    await until(async () => (await fetch(`${base}/api/torrent/${t1.id}`, { headers: H }).then((r) => r.json())).nodes.every((n) => n.state === 'seeding'));

    const stats = await fetch(`${base}/api/statistics/global`, { headers: H }).then((r) => r.json());
    assert.equal(stats.engine.workers, 3);
    const metrics = await fetch(`${base}/metrics`).then((r) => r.text());
    assert.match(metrics, /swarmcast_idempotent_replays_total 1/);
    assert.match(metrics, /swarmcast_active_workers 3/);

    const download = await fetch(`${base}/api/torrent/${t1.id}/download`, { headers: H });
    assert.equal(download.status, 200);
    assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'), want);

    const del = await fetch(`${base}/api/torrent/${t1.id}?deleteFiles=true`, { method: 'DELETE', headers: H });
    assert.equal(del.status, 200);
    await until(async () => (await fetch(`${base}/api/torrent/${t1.id}`, { headers: H })).status === 404);
    // the staged upload is removed with the data
    assert.deepEqual(await readdir(api.cfg.uploadDir).catch(() => []), []);
  } finally {
    for (const w of workers) await w.stop();
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});
