import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startShoal } from '../src/server.js';
import { Engine } from '../src/engine/engine.js';
import { toMagnet } from '../src/engine/metainfo.js';

const until = (fn, ms = 60000) => new Promise((res, rej) => {
  const start = Date.now();
  const t = setInterval(async () => { try { if (await fn()) { clearInterval(t); res(); } else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); } } catch (e) { clearInterval(t); rej(e); } }, 250);
});

test('a crashed worker\'s lease expires and another worker takes the transfer over', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shoal-failover-'));
  const seedDir = path.join(root, 'external'); await mkdir(seedDir);
  await writeFile(path.join(seedDir, 'dataset.parquet'), randomBytes(1024 * 1024));
  const external = await new Engine({ dataDir: path.join(root, 'ext'), port: 0, dht: false }).start();
  const seed = await external.seed(path.join(seedDir, 'dataset.parquet'));
  const common = { dataDir: root, dbFile: path.join(root, 'shoal.db'), peerPort: 0, dhtPort: 0, dht: false, logRequests: false, jwtSecret: 'x', trackers: [] };
  const api = await startShoal({ ...common, role: 'api', port: 0 });
  const base = `http://127.0.0.1:${api.server.address().port}`;
  const w1 = await startShoal({ ...common, role: 'worker', dataDir: path.join(root, 'w1'), nodeId: 'w1' });
  try {
    const { token } = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ops', email: 'o@x.io', password: 'password123' }) }).then((r) => r.json());
    const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const magnet = `${toMagnet(seed)}&x.pe=127.0.0.1:${external.port}`;
    const t = await fetch(`${base}/api/torrent/create`, { method: 'POST', headers: H, body: JSON.stringify({ magnetURI: magnet }) }).then((r) => r.json());
    await until(async () => (await fetch(`${base}/api/torrent/${t.id}`, { headers: H }).then((r) => r.json())).nodes[0]?.nodeId === 'w1');

    // Simulate an OOM-kill: timers stop, nothing is released.
    clearInterval(w1.worker.heartbeatTimer); clearInterval(w1.worker.reconcileTimer); clearInterval(w1.worker.progressTimer);
    await w1.worker.engine.stop();
    await w1.bus.close();

    const w2 = await startShoal({ ...common, role: 'worker', dataDir: path.join(root, 'w2'), nodeId: 'w2' });
    try {
      await until(async () => {
        const v = await fetch(`${base}/api/torrent/${t.id}`, { headers: H }).then((r) => r.json());
        return v.nodes.some((n) => n.nodeId === "w2" && n.state === "seeding");
      }, 60000);
      await until(async () => (await fetch(`${base}/api/statistics/nodes`, { headers: H }).then((r) => r.json())).find((n) => n.id === 'w1').status === 'down', 30000);
      const act = await fetch(`${base}/api/torrent/${t.id}/activity`, { headers: H }).then((r) => r.json());
      assert.ok(act.some((a) => a.event === 'transfer.assigned' && a.nodeId === 'w2'));
    } finally { await w2.stop(); }
  } finally {
    await api.stop(); await external.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('CAS: a second artifact that shares pieces is filled from disk, not the network', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shoal-cas-'));
  const shared = randomBytes(16384 * 8);
  await mkdir(path.join(root, 'v1')); await mkdir(path.join(root, 'v2'));
  await writeFile(path.join(root, 'v1', 'model.bin'), shared);
  await writeFile(path.join(root, 'v2', 'model.bin'), Buffer.concat([shared, randomBytes(16384 * 2)]));
  const seeder = await new Engine({ dataDir: path.join(root, 's'), port: 0, dht: false }).start();
  const node = await new Engine({ dataDir: path.join(root, 'n'), port: 0, dht: false }).start();
  try {
    const a = await seeder.seed(path.join(root, 'v1'));
    const b = await seeder.seed(path.join(root, 'v2'));
    await until(() => a.state === 'seeding' && b.state === 'seeding');
    const x = node.add(`${toMagnet(a)}&x.pe=127.0.0.1:${seeder.port}`);
    await until(() => x.state === 'seeding');
    // force identical piece size so v2's first 8 pieces equal v1's
    assert.equal(a.meta.pieceLength, b.meta.pieceLength);
    const y = node.add(`${toMagnet(b)}&x.pe=127.0.0.1:${seeder.port}`);
    await until(() => y.state === 'seeding');
    assert.equal(y.dedupBytes, shared.length, 'all shared pieces came from CAS');
    assert.equal(y.downloaded, 16384 * 2, 'only the new pieces crossed the network');
  } finally {
    await seeder.stop(); await node.stop();
    await rm(root, { recursive: true, force: true });
  }
});
