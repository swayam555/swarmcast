import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/engine/bencode.js';
import { parseMagnet, toMagnet, createTorrent, parseTorrent, choosePieceLength } from '../src/engine/metainfo.js';
import { Bitfield } from '../src/engine/bitfield.js';
import { Throttle, Meter } from '../src/engine/rate.js';
import { TrackerServer, announce } from '../src/engine/tracker.js';
import { DHT, RoutingTable, prefixLen } from '../src/dht/dht.js';
import { openDb } from '../src/store/db.js';
import { createLeases } from '../src/cluster/leases.js';
import { signJwt, verifyJwt, hashPassword, checkPassword } from '../src/api/auth.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

test('bencode round trip keeps binary and sorts keys', () => {
  const v = { z: 1, a: [Buffer.from([0, 255]), 'hi', -42], m: { k: 'v' } };
  const enc = encode(v);
  assert.equal(enc.toString('latin1').slice(0, 5), 'd1:al');
  const d = decode(enc);
  assert.deepEqual([...d.a[0]], [0, 255]);
  assert.equal(d.a[1].toString(), 'hi');
  assert.equal(d.a[2], -42);
  assert.throws(() => decode(Buffer.from('i12')), /unterminated/);
  assert.throws(() => decode(Buffer.from('5:ab')), /overruns/);
});

test('magnet parse handles hex and base32 hashes', () => {
  const hex = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
  const m = parseMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=a%20b&tr=udp%3A%2F%2Ft%3A1&x.pe=1.2.3.4:5`);
  assert.equal(m.infoHash, hex); assert.equal(m.name, 'a b'); assert.deepEqual(m.announce, ['udp://t:1']); assert.deepEqual(m.peers, ['1.2.3.4:5']);
  const b32 = parseMagnet('magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK');
  assert.equal(b32.infoHash, hex);
  assert.equal(parseMagnet(toMagnet({ infoHash: hex, name: 'x', announce: ['http://a/announce'] })).announce[0], 'http://a/announce');
  assert.throws(() => parseMagnet('magnet:?dn=x'), /no btih/);
});

test('createTorrent output parses back with a stable info hash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shoal-meta-'));
  await writeFile(path.join(dir, 'f.bin'), randomBytes(100_000));
  const t = await createTorrent(path.join(dir, 'f.bin'), { announce: ['http://x/announce'], pieceLength: 16384 });
  assert.equal(t.pieces.length, Math.ceil(100_000 / 16384));
  const again = parseTorrent(t.torrent);
  assert.equal(again.infoHash, t.infoHash);
  assert.deepEqual(again.announce, ['http://x/announce']);
  assert.ok(choosePieceLength(70 * 2 ** 30) >= 32 * 2 ** 20 / 2);
  await rm(dir, { recursive: true });
});

test('bitfield counts and clears spare bits', () => {
  const b = Bitfield.full(10);
  assert.equal(b.count(), 10); assert.equal(b.toBuffer()[1], 0b11000000);
  b.set(3, false); assert.equal(b.get(3), false); assert.equal(b.count(), 9);
  assert.equal(Bitfield.fromHex(10, b.toHex()).count(), 9);
});

test('throttle paces bytes to the configured rate', async () => {
  const t = new Throttle(200_000); const start = Date.now();
  for (let i = 0; i < 6; i++) await t.take(100_000);
  const secs = (Date.now() - start) / 1000;
  assert.ok(secs >= 1.8 && secs < 4, `took ${secs}s`);
  const m = new Meter(); m.add(5000); assert.ok(m.rate() > 0);
});

test('built-in HTTP tracker hands out peers for a swarm', async () => {
  const tr = new TrackerServer();
  const { trackerMiddleware } = await import('../src/engine/tracker.js');
  const mw = trackerMiddleware(tr);
  const srv = http.createServer((req, res) => mw({ originalUrl: req.url, socket: req.socket }, { set: (k, v) => res.setHeader(k, v) && { send: (b) => res.end(b) } }));
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/announce`;
  const infoHash = randomBytes(20).toString('hex');
  await announce(url, { infoHash, peerId: randomBytes(20), port: 7001, left: 0, event: 'started' });
  const r = await announce(url, { infoHash, peerId: randomBytes(20), port: 7002, left: 10 });
  assert.deepEqual(r.peers, ['127.0.0.1:7001']); assert.equal(r.complete, 1);
  srv.close();
});

test('routing table buckets by shared prefix and returns closest nodes', () => {
  const self = Buffer.alloc(20); const rt = new RoutingTable(self);
  for (let i = 1; i <= 30; i++) { const id = Buffer.alloc(20); id[19] = i; rt.add({ id, addr: `10.0.0.${i}:1` }); }
  assert.equal(prefixLen(self, Buffer.from('80'.padEnd(40, '0'), 'hex')), 0);
  const target = Buffer.alloc(20); target[19] = 7;
  assert.equal(rt.closest(target, 1)[0].addr, '10.0.0.7:1');
});

test('three DHT nodes find each other and resolve announced peers', async () => {
  const a = await new DHT({ port: 0, host: '127.0.0.1' }).start();
  const b = await new DHT({ port: 0, host: '127.0.0.1', bootstrap: [`127.0.0.1:${a.port}`] }).start();
  const c = await new DHT({ port: 0, host: '127.0.0.1', bootstrap: [`127.0.0.1:${a.port}`] }).start();
  try {
    const ih = randomBytes(20).toString('hex');
    await b.announce(ih, 51413);
    const { peers } = await c.getPeers(ih);
    assert.ok(peers.includes('127.0.0.1:51413'), `peers: ${peers}`);
    assert.ok(a.table.size() >= 2);
  } finally { a.stop(); b.stop(); c.stop(); }
});

test('leases are exclusive and fencing rejects a stale holder', async () => {
  const db = openDb(':memory:'); const L = createLeases({ db });
  const f1 = await L.acquire('k', 'w1', 50);
  assert.ok(f1); assert.equal(await L.acquire('k', 'w2', 50), null);
  await new Promise((r) => setTimeout(r, 70));
  const f2 = await L.acquire('k', 'w2', 1000);
  assert.ok(f2 > f1);
  assert.equal(await L.renew('k', 'w1', f1, 1000), false, 'old holder is fenced out');
  assert.equal(await L.renew('k', 'w2', f2, 1000), true);
});

test('jwt and password helpers', () => {
  const t = signJwt({ sub: 'u1' }, 'k'); assert.equal(verifyJwt(t, 'k').sub, 'u1'); assert.equal(verifyJwt(t, 'other'), null);
  assert.equal(verifyJwt(signJwt({ sub: 'u' }, 'k', -10), 'k'), null);
  const h = hashPassword('hunter22'); assert.ok(checkPassword('hunter22', h)); assert.ok(!checkPassword('nope', h));
});
