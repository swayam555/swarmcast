#!/usr/bin/env node
// Thundering-herd benchmark: N nodes pull the same artifact at once from one
// origin. Reports how many bytes the origin had to send (the "egress" you'd pay
// an object store for) versus N × size for a naive pull-from-origin rollout.
//   node test/load/herd.js [--nodes 20] [--size-mb 64] [--origin-limit-mb 0]
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../../src/engine/engine.js';
import { toMagnet } from '../../src/engine/metainfo.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('--nodes', 20); const SIZE = arg('--size-mb', 64) * 1024 * 1024; const LIMIT = arg('--origin-limit-mb', 0) * 1024 * 1024;

const root = await mkdtemp(path.join(os.tmpdir(), 'swarmcast-herd-'));
const file = path.join(root, 'checkpoint.safetensors');
await writeFile(file, randomBytes(SIZE));
const origin = await new Engine({ dataDir: path.join(root, 'origin'), port: 0, dht: false, uploadLimit: LIMIT }).start();
const t0 = await origin.seed(file);
while (t0.state !== 'seeding') await new Promise((r) => setTimeout(r, 50));

const nodes = [];
for (let i = 0; i < N; i++) nodes.push(await new Engine({ dataDir: path.join(root, `n${i}`), port: 0, dht: false }).start());
// Every node knows the origin plus a few random fleet-mates (what the registry/tracker would hand out).
const start = Date.now();
const transfers = nodes.map((n, i) => {
  const mates = [...new Set(Array.from({ length: 4 }, () => nodes[Math.floor(Math.random() * N)]).filter((m) => m !== n))];
  const magnet = `${toMagnet(t0)}&x.pe=127.0.0.1:${origin.port}${mates.map((m) => `&x.pe=127.0.0.1:${m.port}`).join('')}`;
  return n.add(magnet);
});
const finish = new Array(N).fill(0);
await new Promise((resolve) => {
  const iv = setInterval(() => {
    transfers.forEach((t, i) => { if (!finish[i] && t.state === 'seeding') finish[i] = Date.now() - start; });
    const done = finish.filter(Boolean).length;
    process.stderr.write(`\r${done}/${N} done  origin sent ${(t0.uploaded / SIZE).toFixed(2)}× artifact  `);
    if (done === N) { clearInterval(iv); resolve(); }
  }, 200);
});
const sorted = [...finish].sort((a, b) => a - b);
const report = {
  nodes: N, artifactMiB: SIZE / 2 ** 20,
  originEgressMiB: +(t0.uploaded / 2 ** 20).toFixed(1),
  naiveEgressMiB: (N * SIZE) / 2 ** 20,
  egressSaved: `${(100 * (1 - t0.uploaded / (N * SIZE))).toFixed(1)}%`,
  peerBytesMiB: +(transfers.reduce((n, t) => n + t.uploaded, 0) / 2 ** 20).toFixed(1),
  wastedMiB: +(transfers.reduce((n, t) => n + t.wasted, 0) / 2 ** 20).toFixed(1),
  wastedMiB: +(transfers.reduce((n, t) => n + t.wasted, 0) / 2 ** 20).toFixed(1),
  receivedMiB: +(transfers.reduce((n, t) => n + t.downloaded, 0) / 2 ** 20).toFixed(1),
  p50Ms: sorted[Math.floor(N * 0.5)], p95Ms: sorted[Math.min(N - 1, Math.floor(N * 0.95))], maxMs: sorted[N - 1],
};
console.log(`\n${JSON.stringify(report, null, 2)}`);
await writeFile(path.join(path.dirname(new URL(import.meta.url).pathname), 'herd-report.json'), JSON.stringify(report, null, 2));
for (const n of [origin, ...nodes]) await n.stop();
await rm(root, { recursive: true, force: true });
process.exit(0);
