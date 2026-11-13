#!/usr/bin/env node
// shoal — CLI for pipelines and operators.
//   shoal login <email>                    (prompts for password, stores token)
//   shoal push <file|dir> [--replicas all] [--request-id id]
//   shoal add <magnet> [--replicas n] [--request-id id]
//   shoal ls | status <id> | pause <id> | resume <id> | rm <id> [--delete-files]
//   shoal wait <id> [--timeout 600]        (exit 0 when every placement is seeding)
//   shoal pull <id> [-o out]               (download a finished artifact)
//   shoal create <path> [-o x.torrent] [--tracker url]   (offline .torrent creation)
//   shoal seed <path> | get <magnet> [-o dir]            (standalone peer, no server)
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const CONF = path.join(os.homedir(), '.config', 'shoal', 'cli.json');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

const human = (n) => { const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; };
const die = (m) => { console.error(`shoal: ${m}`); process.exit(1); };

async function conf() { try { return JSON.parse(await readFile(CONF, 'utf8')); } catch { return {}; } }
async function api(method, p, { body, headers = {}, raw } = {}) {
  const c = await conf();
  const base = process.env.SHOAL_URL || c.url || 'http://localhost:3029';
  const token = process.env.SHOAL_TOKEN || c.token;
  const res = await fetch(`${base}${p}`, {
    method, body: raw ?? (body ? JSON.stringify(body) : undefined), duplex: raw ? 'half' : undefined,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  });
  if (res.headers.get('content-type')?.includes('json')) {
    const data = await res.json();
    if (!res.ok) die(`${res.status} ${data.error || res.statusText}`);
    return { data, res };
  }
  if (!res.ok) die(`${res.status} ${res.statusText}`);
  return { res };
}

const row = (t) => `${t.id.slice(0, 8)}  ${t.status.padEnd(17)} ${String(t.progress.toFixed(1)).padStart(5)}%  ${human(t.size).padStart(10)}  ↓${human(t.downloadSpeed)}/s ↑${human(t.uploadSpeed)}/s  nodes:${t.nodes.length}  ${t.name}`;
const resolveId = async (prefix) => {
  if (!prefix) die('missing transfer id');
  if (prefix.length >= 36 || /^[0-9a-f]{40}$/i.test(prefix)) return prefix;
  const { data } = await api('GET', '/api/torrent');
  const hit = data.filter((t) => t.id.startsWith(prefix));
  if (hit.length !== 1) die(hit.length ? 'ambiguous id prefix' : `no transfer matching ${prefix}`);
  return hit[0].id;
};

const cmds = {
  async login(email) {
    if (!email) die('usage: shoal login <email>');
    const url = flag('--url', process.env.SHOAL_URL || 'http://localhost:3029');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const password = process.env.SHOAL_PASSWORD || await new Promise((r) => rl.question('Password: ', r));
    rl.close();
    const res = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) die(data.error);
    await mkdir(path.dirname(CONF), { recursive: true });
    await writeFile(CONF, JSON.stringify({ url, token: data.token }), { mode: 0o600 });
    console.log(`Logged in as ${data.user.username} → ${url}`);
  },
  async push(file) {
    if (!file) die('usage: shoal push <file>');
    const st = await stat(file).catch(() => die(`no such file ${file}`));
    if (!st.isFile()) die('push takes a single file; for folders use `shoal create` and `shoal add`');
    const replicas = flag('--replicas', '1'); const rid = flag('--request-id');
    const { data } = await api('POST', `/api/torrent/create-from-file?replicas=${encodeURIComponent(replicas)}`, {
      raw: Readable.toWeb(createReadStream(file)), headers: { 'x-filename': encodeURIComponent(path.basename(file)), 'content-length': String(st.size), ...(rid ? { 'x-request-id': rid } : {}) },
    });
    console.log(row(data)); console.log(data.magnetURI);
  },
  async add(magnet) {
    if (!magnet) die('usage: shoal add <magnet>');
    const replicas = flag('--replicas', '1'); const rid = flag('--request-id');
    const { data, res } = await api('POST', '/api/torrent/create', { body: { magnetURI: magnet, replicas }, headers: rid ? { 'x-request-id': rid } : {} });
    if (res.headers.get('idempotent-replay')) console.error('(replayed: this request id was already processed)');
    console.log(row(data));
  },
  async ls() { const { data } = await api('GET', '/api/torrent'); if (!data.length) console.log('no transfers'); data.forEach((t) => console.log(row(t))); },
  async status(id) {
    const { data } = await api('GET', `/api/torrent/${await resolveId(id)}`);
    console.log(row(data));
    for (const n of data.nodes) console.log(`  ${n.nodeId.padEnd(28)} ${n.state.padEnd(17)} ${n.progress.toFixed(1)}%  peers:${n.peers}  dedup:${human(n.dedupBytes)}`);
  },
  async pause(id) { const { data } = await api('POST', `/api/torrent/${await resolveId(id)}/pause`); console.log(row(data)); },
  async resume(id) { const { data } = await api('POST', `/api/torrent/${await resolveId(id)}/resume`); console.log(row(data)); },
  async rm(id) { const del = bool('--delete-files'); const { data } = await api('DELETE', `/api/torrent/${await resolveId(id)}?deleteFiles=${del}`); console.log(data.message); },
  async wait(id) {
    const timeout = Number(flag('--timeout', '600')) * 1000; const start = Date.now(); const tid = await resolveId(id);
    for (;;) {
      const { data } = await api('GET', `/api/torrent/${tid}`);
      process.stderr.write(`\r${row(data)}   `);
      if (data.nodes.length && data.nodes.every((n) => n.state === 'seeding')) { process.stderr.write('\n'); return; }
      if (data.status === 'error') die(`\ntransfer failed: ${data.error}`);
      if (Date.now() - start > timeout) die('\ntimed out');
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
  async pull(id) {
    const tid = await resolveId(id);
    const { res } = await api('GET', `/api/torrent/${tid}/download`);
    const name = decodeURIComponent((res.headers.get('content-disposition') || '').split("''")[1] || tid);
    const out = flag('-o', name);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
    console.log(`saved ${out}`);
  },
  async create(src) {
    if (!src) die('usage: shoal create <path> [-o file.torrent] [--tracker url]');
    const { createTorrent, toMagnet } = await import('../src/engine/metainfo.js');
    const trackers = []; let t; while ((t = flag('--tracker'))) trackers.push(t);
    const meta = await createTorrent(src, { announce: trackers });
    const out = flag('-o', `${meta.name}.torrent`);
    await writeFile(out, meta.torrent);
    console.log(`${out}  ${meta.pieces.length} pieces × ${human(meta.pieceLength)}  ${human(meta.length)}`);
    console.log(toMagnet(meta));
  },
  async seed(src) {
    if (!src) die('usage: shoal seed <path>');
    const { Engine } = await import('../src/engine/engine.js');
    const { toMagnet } = await import('../src/engine/metainfo.js');
    const e = await new Engine({ dataDir: path.join(os.tmpdir(), 'shoal-cli'), port: Number(flag('--port', '0')) }).start();
    const t = await e.seed(src);
    console.log(`${toMagnet(t)}&x.pe=${flag('--host', '127.0.0.1')}:${e.port}`);
    setInterval(() => process.stderr.write(`\r${t.state}  peers:${t.peers.size}  ↑${human(t.up.rate())}/s  sent ${human(t.uploaded)}   `), 1000);
  },
  async get(magnet) {
    if (!magnet) die('usage: shoal get <magnet> [-o dir]');
    const { Engine } = await import('../src/engine/engine.js');
    const out = path.resolve(flag('-o', '.'));
    const e = await new Engine({ dataDir: path.join(os.tmpdir(), 'shoal-cli'), downloadPath: out, port: 0 }).start();
    const t = e.add(magnet);
    const timer = setInterval(async () => {
      const s = t.snapshot();
      process.stderr.write(`\r${s.state.padEnd(17)} ${s.percentage.toFixed(1)}%  peers:${s.peers.connected}  ↓${human(s.downloadSpeed)}/s   `);
      if (s.state === 'seeding') { clearInterval(timer); process.stderr.write(`\nsaved to ${path.join(out, t.name)}\n`); await e.stop(); process.exit(0); }
    }, 500);
  },
};

const [cmd, ...rest] = args;
if (!cmd || !cmds[cmd]) {
  console.log('usage: shoal <login|push|add|ls|status|pause|resume|rm|wait|pull|create|seed|get> …');
  process.exit(cmd ? 1 : 0);
}
await cmds[cmd](...rest);
