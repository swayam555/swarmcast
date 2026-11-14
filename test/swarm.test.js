import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine/engine.js';
import { toMagnet } from '../src/engine/metainfo.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const until = (fn, ms = 30000) => new Promise((res, rej) => {
  const start = Date.now();
  const t = setInterval(() => { if (fn()) { clearInterval(t); res(); } else if (Date.now() - start > ms) { clearInterval(t); rej(new Error('timeout')); } }, 50);
});

test('magnet download from a seed, then a third peer fetches from both', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'swarmcast-swarm-'));
  const src = path.join(root, 'seed', 'model');
  await mkdir(src, { recursive: true });
  const a = randomBytes(3 * 1024 * 1024 + 777); const b = randomBytes(512 * 1024 + 3);
  await writeFile(path.join(src, 'weights.bin'), a);
  await mkdir(path.join(src, 'cfg'));
  await writeFile(path.join(src, 'cfg', 'config.json'), b);

  const mk = (name) => new Engine({ dataDir: path.join(root, name), port: 0, dht: false }).start();
  const seeder = await mk('n1'); const leech = await mk('n2'); const third = await mk('n3');
  try {
    const t1 = await seeder.seed(src);
    await until(() => t1.state === 'seeding');
    const magnet = toMagnet({ infoHash: t1.infoHash, name: t1.name }) + `&x.pe=127.0.0.1:${seeder.port}`;

    const t2 = leech.add(magnet);
    await until(() => t2.state === 'seeding', 60000);
    const got = await readFile(path.join(leech.settings.downloadPath, 'model', 'weights.bin'));
    assert.equal(sha(got), sha(a));
    assert.equal(sha(await readFile(path.join(leech.settings.downloadPath, 'model', 'cfg', 'config.json'))), sha(b));

    const t3 = third.add(magnet + `&x.pe=127.0.0.1:${leech.port}`);
    await until(() => t3.state === 'seeding', 60000);
    assert.equal(sha(await readFile(path.join(third.settings.downloadPath, 'model', 'weights.bin'))), sha(a));
    assert.ok(t2.uploaded > 0 || t1.uploaded > t2.downloaded, 'second peer should have contributed or seed carried all');
  } finally {
    await Promise.all([seeder.stop(), leech.stop(), third.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
