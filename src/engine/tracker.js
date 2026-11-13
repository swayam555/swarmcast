// Tracker client (HTTP BEP 3/23 and UDP BEP 15) plus a small in-process HTTP
// tracker that the control plane mounts at /announce for private fleets.
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { decode, encode, text } from './bencode.js';
import { decodeCompactPeers, encodeCompactPeers } from './wire.js';

const pct = (buf) => Array.from(buf).map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');

export async function announce(url, p) {
  if (url.startsWith('udp://')) return announceUdp(url, p);
  if (url.startsWith('http://') || url.startsWith('https://')) return announceHttp(url, p);
  throw new Error(`unsupported tracker ${url}`);
}

async function announceHttp(url, { infoHash, peerId, port, uploaded = 0, downloaded = 0, left = 0, event, numwant = 50 }) {
  const qs = [
    `info_hash=${pct(Buffer.from(infoHash, 'hex'))}`, `peer_id=${pct(Buffer.from(peerId))}`,
    `port=${port}`, `uploaded=${uploaded}`, `downloaded=${downloaded}`, `left=${left}`,
    'compact=1', `numwant=${numwant}`, event ? `event=${event}` : '',
  ].filter(Boolean).join('&');
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}${qs}`, { signal: AbortSignal.timeout(10_000) });
  const body = decode(Buffer.from(await res.arrayBuffer()));
  if (body['failure reason']) throw new Error(`tracker: ${text(body['failure reason'])}`);
  let peers = [];
  if (Buffer.isBuffer(body.peers)) peers = decodeCompactPeers(body.peers);
  else if (Array.isArray(body.peers)) peers = body.peers.map((x) => `${text(x.ip)}:${x.port}`);
  return { interval: Number(body.interval) || 60, peers, complete: Number(body.complete) || 0, incomplete: Number(body.incomplete) || 0 };
}

const EVENTS = { completed: 1, started: 2, stopped: 3 };
function announceUdp(url, { infoHash, peerId, port, uploaded = 0, downloaded = 0, left = 0, event, numwant = 50 }) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const done = (err, v) => { clearTimeout(timer); sock.close(); err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => done(new Error('udp tracker timeout')), 10_000);
    let tx = randomBytes(4);
    const connect = Buffer.alloc(16);
    connect.writeBigUInt64BE(0x41727101980n, 0); connect.writeUInt32BE(0, 8); tx.copy(connect, 12);
    sock.on('error', (e) => done(e));
    sock.on('message', (msg) => {
      const action = msg.readUInt32BE(0);
      if (!msg.subarray(4, 8).equals(tx)) return;
      if (action === 3) return done(new Error(`tracker: ${msg.subarray(8).toString()}`));
      if (action === 0) {
        const conn = msg.subarray(8, 16);
        tx = randomBytes(4);
        const a = Buffer.alloc(98);
        conn.copy(a, 0); a.writeUInt32BE(1, 8); tx.copy(a, 12);
        Buffer.from(infoHash, 'hex').copy(a, 16); Buffer.from(peerId).copy(a, 36);
        a.writeBigUInt64BE(BigInt(downloaded), 56); a.writeBigUInt64BE(BigInt(left), 64); a.writeBigUInt64BE(BigInt(uploaded), 72);
        a.writeUInt32BE(EVENTS[event] || 0, 80); a.writeUInt32BE(0, 84); randomBytes(4).copy(a, 88);
        a.writeInt32BE(numwant, 92); a.writeUInt16BE(port, 96);
        return sock.send(a, Number(u.port), u.hostname);
      }
      if (action === 1) {
        done(null, { interval: msg.readUInt32BE(8), incomplete: msg.readUInt32BE(12), complete: msg.readUInt32BE(16), peers: decodeCompactPeers(msg.subarray(20)) });
      }
    });
    sock.send(connect, Number(u.port), u.hostname);
  });
}

/**
 * Minimal HTTP tracker. Swarms are kept in memory; peers expire after
 * 2× the announce interval. Mounted by the control plane as GET /announce.
 */
export class TrackerServer {
  constructor({ interval = 30 } = {}) { this.interval = interval; this.swarms = new Map(); }

  handle(query, remoteIp) {
    const raw = query.rawInfoHash;
    if (!raw || raw.length !== 20) return encode({ 'failure reason': 'invalid info_hash' });
    const key = raw.toString('hex');
    const swarm = this.swarms.get(key) || new Map();
    this.swarms.set(key, swarm);
    const now = Date.now();
    for (const [id, p] of swarm) if (now - p.seen > this.interval * 2000) swarm.delete(id);

    const ip = (query.ip || remoteIp || '').replace(/^::ffff:/, '');
    const id = `${ip}:${query.port}`;
    if (query.event === 'stopped') swarm.delete(id);
    else swarm.set(id, { addr: id, left: Number(query.left) || 0, seen: now });

    const want = Math.min(Number(query.numwant) || 50, 200);
    const others = [...swarm.values()].filter((p) => p.addr !== id).slice(0, want).map((p) => p.addr);
    const complete = [...swarm.values()].filter((p) => p.left === 0).length;
    return encode({ interval: this.interval, complete, incomplete: swarm.size - complete, peers: encodeCompactPeers(others) });
  }

  stats() { return { swarms: this.swarms.size, peers: [...this.swarms.values()].reduce((n, s) => n + s.size, 0) }; }
}

/** Express handler: parse info_hash bytes from the raw query string (it is not UTF-8). */
export function trackerMiddleware(server) {
  return (req, res) => {
    const rawQs = req.originalUrl.split('?')[1] || '';
    const q = {};
    for (const part of rawQs.split('&')) {
      const [k, v = ''] = part.split('=');
      if (k === 'info_hash') q.rawInfoHash = Buffer.from(unescapeBytes(v));
      else if (k === 'peer_id') q.peerId = Buffer.from(unescapeBytes(v));
      else { try { q[k] = decodeURIComponent(v); } catch { q[k] = v; } }
    }
    res.set('Content-Type', 'text/plain').send(server.handle(q, req.socket.remoteAddress));
  };
}

function unescapeBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else if (s[i] === '+') out.push(0x20);
    else out.push(s.charCodeAt(i));
  }
  return out;
}
