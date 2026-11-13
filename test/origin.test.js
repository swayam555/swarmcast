import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startShoal } from '../src/server.js';
import { createTorrent } from '../src/engine/metainfo.js';
import { rangesFor } from '../src/engine/origin.js';

const until = (fn, ms = 60000) => new Promise((res, rej) => {
  const start = Date.now();
  const t = setInterval(async () => { try { if (await fn()) { clearInterval(t); res(); } else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); } } catch (e) { clearInterval(t); rej(e); } }, 200);
});
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A tiny object store: serves files with Range support and counts the bytes it sent. */
function objectStore(files) {
  const stats = { bytes: 0, full: 0, ranged: 0 };
  const server = http.createServer((req, res) => {
    const body = files[decodeURIComponent(new URL(req.url, 'http://x').pathname)];
    if (!body) { res.writeHead(404).end(); return; }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m) {
      const [a, b] = [Number(m[1]), Math.min(Number(m[2]), body.length - 1)];
      stats.ranged++; stats.bytes += b - a + 1;
      res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1 }).end(body.subarray(a, b + 1));
    } else {
      stats.full++; stats.bytes += body.length;
      res.writeHead(200, { 'content-length': body.length }).end(body);
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, stats, base: `http://127.0.0.1:${server.address().port}` })));
}

test('origin byte ranges map onto the files of a multi-file torrent', () => {
  const meta = { name: 'pack', files: [{ path: 'pack/a.bin', length: 10, offset: 0 }, { path: 'pack/sub/b c.bin', length: 5, offset: 10 }] };
  assert.deepEqual(rangesFor(meta, 'https://s3.example/bucket/pack/', 8, 4), [
    { url: 'https://s3.example/bucket/pack/a.bin', from: 8, to: 10 },
    { url: 'https://s3.example/bucket/pack/sub/b%20c.bin', from: 0, to: 2 },
  ]);
  const single = { name: 'w.bin', files: [{ path: 'w.bin', length: 100, offset: 0 }] };
  assert.deepEqual(rangesFor(single, 'https://x/presigned?sig=1', 50, 10), [{ url: 'https://x/presigned?sig=1', from: 50, to: 60 }]);
});

test('cold start from an HTTP origin: pull once from a URL, or fill a seedless swarm from it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shoal-origin-'));
  const coldFile = randomBytes(1024 * 1024 + 17);
  const seedless = randomBytes(1536 * 1024 + 5);
  const store = await objectStore({ '/models/cold.bin': coldFile, '/models/seedless.bin': seedless, '/models/wrong.bin': randomBytes(seedless.length) });
  const common = { dataDir: root, dbFile: path.join(root, 'shoal.db'), peerPort: 0, dhtPort: 0, dht: false, logRequests: false, jwtSecret: 's3cret' };
  const api = await startShoal({ ...common, role: 'api', port: 0, trackers: [] });
  const base = `http://127.0.0.1:${api.server.address().port}`;
  api.cfg.trackers = [`${base}/announce`];
  const workers = [];
  for (let i = 0; i < 2; i++) workers.push(await startShoal({ ...common, role: 'worker', dataDir: path.join(root, `w${i}`), nodeId: `w${i}`, trackers: [`${base}/announce`] }));
  const json = { 'content-type': 'application/json' };
  const post = (p, H, body) => fetch(`${base}${p}`, { method: 'POST', headers: { ...json, ...H }, body: JSON.stringify(body) });
  try {
    const admin = await post('/api/auth/register', {}, { username: 'ops', email: 'ops@x.io', password: 'password123' }).then((r) => r.json());
    const user = await post('/api/auth/register', {}, { username: 'dev', email: 'dev@x.io', password: 'password123' }).then((r) => r.json());
    const H = { authorization: `Bearer ${admin.token}` };
    const get = (id) => fetch(`${base}/api/torrent/${id}`, { headers: H }).then((r) => r.json());

    // only admins may make the fleet fetch URLs, and only http(s) without inline credentials
    assert.equal((await post('/api/torrent/create-from-url', { authorization: `Bearer ${user.token}` }, { url: `${store.base}/models/cold.bin` })).status, 403);
    assert.equal((await post('/api/torrent/create-from-url', H, { url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await post('/api/torrent/create-from-url', H, { url: `http://a:b@127.0.0.1/x` })).status, 400);
    assert.equal((await post('/api/torrent/create-from-url', H, { url: `${store.base}/models/missing.bin` })).status, 502);

    // 1. a brand-new artifact straight from object storage, rolled out to every worker
    const r1 = await post('/api/torrent/create-from-url', H, { url: `${store.base}/models/cold.bin`, replicas: 'all' });
    assert.equal(r1.status, 201);
    const t1 = await r1.json();
    assert.equal(t1.name, 'cold.bin');
    assert.equal(t1.origin, new URL(store.base).host);
    await until(async () => { const t = await get(t1.id); return t.nodes.length >= 2 && t.nodes.every((n) => n.state === 'seeding'); });
    const dl1 = await fetch(`${base}/api/torrent/${t1.id}/download`, { headers: H });
    assert.equal(sha(Buffer.from(await dl1.arrayBuffer())), sha(coldFile));
    assert.equal(store.stats.full, 1, 'the object store was read once; the second worker got the file from the swarm');

    // 2. a .torrent nobody seeds yet: workers fall back to the origin, then share with each other
    const src = path.join(root, 'elsewhere'); await mkdir(src);
    await writeFile(path.join(src, 'seedless.bin'), seedless);
    const meta = await createTorrent(path.join(src, 'seedless.bin'), { announce: [] });
    const before = store.stats.bytes;
    const r2 = await fetch(`${base}/api/torrent/upload?replicas=all&originUrl=${encodeURIComponent(`${store.base}/models/seedless.bin`)}`, { method: 'POST', headers: H, body: meta.torrent });
    assert.equal(r2.status, 201);
    const t2 = await r2.json();
    await until(async () => { const t = await get(t2.id); return t.nodes.length >= 2 && t.nodes.every((n) => n.state === 'seeding'); });
    const t2done = await get(t2.id);
    assert.ok(t2done.originBytes >= seedless.length, 'pieces came from the origin');
    assert.ok(store.stats.bytes - before <= 2 * seedless.length, 'no piece was fetched more than once per worker');
    const dl2 = await fetch(`${base}/api/torrent/${t2.id}/download`, { headers: H });
    assert.equal(sha(Buffer.from(await dl2.arrayBuffer())), sha(seedless));

    // 3. an origin with the wrong bytes never gets written: every piece fails its hash check
    await writeFile(path.join(src, 'other.bin'), randomBytes(256 * 1024));
    const other = await createTorrent(path.join(src, 'other.bin'), { announce: [] });
    const r3 = await fetch(`${base}/api/torrent/upload?originUrl=${encodeURIComponent(`${store.base}/models/wrong.bin`)}`, { method: 'POST', headers: H, body: other.torrent });
    assert.equal(r3.status, 201);
    const t3 = await r3.json();
    await new Promise((r) => setTimeout(r, 6500));
    const t3now = await get(t3.id);
    assert.equal(t3now.completedPieces, 0);
    assert.notEqual(t3now.status, 'seeding');
  } finally {
    for (const w of workers) await w.stop();
    await api.stop();
    store.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
