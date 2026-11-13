// Mainline DHT (BEP 5): Kademlia routing table + KRPC over UDP.
// Supports ping, find_node, get_peers and announce_peer, both as client and server.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { encode, decode, text } from '../engine/bencode.js';
import { decodeCompactPeers, encodeCompactPeers } from '../engine/wire.js';

const K = 8;
const ID_BITS = 160;

export const xor = (a, b) => { const o = Buffer.alloc(20); for (let i = 0; i < 20; i++) o[i] = a[i] ^ b[i]; return o; };
export const cmp = (a, b) => Buffer.compare(a, b);

/** Common-prefix length in bits; determines the bucket a node lands in. */
export function prefixLen(a, b) {
  for (let i = 0; i < 20; i++) {
    const x = a[i] ^ b[i];
    if (x) return i * 8 + Math.clz32(x) - 24;
  }
  return ID_BITS;
}

export class RoutingTable {
  constructor(selfId) {
    this.self = selfId;
    this.buckets = Array.from({ length: ID_BITS + 1 }, () => []);
  }
  bucketFor(id) { return this.buckets[prefixLen(this.self, id)]; }

  /** Insert or refresh. Full buckets keep their oldest good nodes (Kademlia favours long-lived peers). */
  add(node) {
    if (node.id.equals(this.self)) return false;
    const b = this.bucketFor(node.id);
    const i = b.findIndex((n) => n.id.equals(node.id));
    if (i >= 0) { const [n] = b.splice(i, 1); n.seen = Date.now(); n.addr = node.addr; b.push(n); return true; }
    if (b.length < K) { b.push({ ...node, seen: Date.now(), fails: 0 }); return true; }
    const stale = b.findIndex((n) => n.fails >= 2 || Date.now() - n.seen > 15 * 60_000);
    if (stale >= 0) { b.splice(stale, 1); b.push({ ...node, seen: Date.now(), fails: 0 }); return true; }
    return false;
  }
  remove(id) { const b = this.bucketFor(id); const i = b.findIndex((n) => n.id.equals(id)); if (i >= 0) b.splice(i, 1); }
  markFailed(id) { const n = this.bucketFor(id).find((x) => x.id.equals(id)); if (n && ++n.fails >= 3) this.remove(id); }

  closest(target, count = K) {
    return this.all().sort((a, b) => cmp(xor(a.id, target), xor(b.id, target))).slice(0, count);
  }
  all() { return this.buckets.flat(); }
  size() { return this.buckets.reduce((n, b) => n + b.length, 0); }
}

function encodeNodes(nodes) {
  return Buffer.concat(nodes.map((n) => Buffer.concat([n.id, encodeCompactPeers([n.addr])])).filter((b) => b.length === 26));
}
function decodeNodes(buf) {
  const out = [];
  if (!Buffer.isBuffer(buf)) return out;
  for (let i = 0; i + 26 <= buf.length; i += 26) out.push({ id: Buffer.from(buf.subarray(i, i + 20)), addr: decodeCompactPeers(buf.subarray(i + 20, i + 26))[0] });
  return out;
}

export class DHT extends EventEmitter {
  constructor({ port = 6881, nodeId, bootstrap = [], host = '0.0.0.0' } = {}) {
    super();
    this.port = port; this.host = host;
    this.id = nodeId ? Buffer.from(nodeId, 'hex') : randomBytes(20);
    this.table = new RoutingTable(this.id);
    this.bootstrapNodes = bootstrap;
    this.pending = new Map();
    this.peerStore = new Map(); // infoHash hex -> Map(addr -> seen)
    this.secret = randomBytes(16); this.prevSecret = this.secret;
    this.running = false;
    this.stats = { queriesIn: 0, queriesOut: 0, responses: 0, timeouts: 0 };
  }

  async start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (m, rinfo) => this.onMessage(m, rinfo));
    this.sock.on('error', (e) => this.emit('warning', e));
    await new Promise((res, rej) => { this.sock.once('error', rej); this.sock.bind(this.port, this.host, res); });
    this.port = this.sock.address().port;
    this.running = true;
    this.rotate = setInterval(() => { this.prevSecret = this.secret; this.secret = randomBytes(16); }, 5 * 60_000);
    this.rotate.unref();
    this.refreshTimer = setInterval(() => this.lookup(randomBytes(20)).catch(() => {}), 10 * 60_000);
    this.refreshTimer.unref();
    await this.bootstrap();
    this.emit('ready');
    return this;
  }

  async bootstrap() {
    for (const addr of this.bootstrapNodes) {
      try { await this.query(addr, 'ping', {}); } catch { /* unreachable bootstrap node */ }
    }
    if (this.table.size()) await this.lookup(this.id).catch(() => {});
  }

  stop() {
    this.running = false;
    clearInterval(this.rotate); clearInterval(this.refreshTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('dht stopped')); }
    this.pending.clear();
    this.sock?.close();
  }

  status() { return { enabled: true, running: this.running, nodes: this.table.size(), port: this.port, nodeId: this.id.toString('hex'), ...this.stats }; }

  // ---------------------------------------------------------- transport
  query(addr, q, args, timeoutMs = 4000) {
    const [host, port] = splitAddr(addr);
    const t = randomBytes(2);
    const key = t.toString('hex');
    const msg = encode({ t, y: 'q', q, a: { id: this.id, ...args } });
    this.stats.queriesOut++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key); this.stats.timeouts++;
        reject(new Error(`dht ${q} timeout ${addr}`));
      }, timeoutMs);
      this.pending.set(key, { resolve, reject, timer, addr });
      this.sock.send(msg, port, host, (err) => { if (err) { clearTimeout(timer); this.pending.delete(key); reject(err); } });
    });
  }

  onMessage(buf, rinfo) {
    let msg;
    try { msg = decode(buf); } catch { return; }
    const addr = `${rinfo.address}:${rinfo.port}`;
    const y = text(msg.y);
    if (y === 'r' || y === 'e') {
      const key = Buffer.isBuffer(msg.t) ? msg.t.toString('hex') : '';
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key); clearTimeout(p.timer);
      if (y === 'e') return p.reject(new Error(`dht error ${msg.e}`));
      this.stats.responses++;
      const r = msg.r || {};
      if (Buffer.isBuffer(r.id) && r.id.length === 20) this.table.add({ id: Buffer.from(r.id), addr });
      return p.resolve(r);
    }
    if (y === 'q') return this.onQuery(msg, addr, rinfo);
  }

  reply(msg, rinfo, r) { this.sock.send(encode({ t: msg.t, y: 'r', r: { id: this.id, ...r } }), rinfo.port, rinfo.address); }
  error(msg, rinfo, code, m) { this.sock.send(encode({ t: msg.t, y: 'e', e: [code, m] }), rinfo.port, rinfo.address); }

  token(ip, secret = this.secret) { return createHash('sha1').update(Buffer.concat([Buffer.from(ip), secret])).digest().subarray(0, 8); }

  onQuery(msg, addr, rinfo) {
    this.stats.queriesIn++;
    const q = text(msg.q); const a = msg.a || {};
    if (!Buffer.isBuffer(a.id) || a.id.length !== 20) return this.error(msg, rinfo, 203, 'bad id');
    this.table.add({ id: Buffer.from(a.id), addr });
    switch (q) {
      case 'ping': return this.reply(msg, rinfo, {});
      case 'find_node': return this.reply(msg, rinfo, { nodes: encodeNodes(this.table.closest(a.target)) });
      case 'get_peers': {
        const ih = a.info_hash.toString('hex');
        const token = this.token(rinfo.address);
        const peers = [...(this.peerStore.get(ih)?.keys() || [])];
        if (peers.length) return this.reply(msg, rinfo, { token, values: peers.slice(0, 50).map((p) => encodeCompactPeers([p])) });
        return this.reply(msg, rinfo, { token, nodes: encodeNodes(this.table.closest(a.info_hash)) });
      }
      case 'announce_peer': {
        const tok = a.token;
        if (!Buffer.isBuffer(tok) || !(tok.equals(this.token(rinfo.address)) || tok.equals(this.token(rinfo.address, this.prevSecret)))) {
          return this.error(msg, rinfo, 203, 'bad token');
        }
        const port = Number(a.implied_port) ? rinfo.port : Number(a.port);
        const ih = a.info_hash.toString('hex');
        if (!this.peerStore.has(ih)) this.peerStore.set(ih, new Map());
        this.peerStore.get(ih).set(`${rinfo.address}:${port}`, Date.now());
        this.emit('announce', ih, `${rinfo.address}:${port}`);
        return this.reply(msg, rinfo, {});
      }
      default: return this.error(msg, rinfo, 204, 'method unknown');
    }
  }

  // ---------------------------------------------------------- iterative lookups
  /**
   * Iterative Kademlia lookup. With infoHash, uses get_peers and collects peers + tokens.
   * Returns { nodes, peers, tokens }.
   */
  async lookup(target, { infoHash = false, alpha = 3, maxRounds = 8 } = {}) {
    const t = Buffer.isBuffer(target) ? target : Buffer.from(target, 'hex');
    const seen = new Set(); const peers = new Set(); const tokens = new Map();
    let shortlist = this.table.closest(t, K);
    for (let round = 0; round < maxRounds; round++) {
      const batch = shortlist.filter((n) => !seen.has(n.addr)).slice(0, alpha);
      if (!batch.length) break;
      await Promise.all(batch.map(async (n) => {
        seen.add(n.addr);
        try {
          const r = infoHash ? await this.query(n.addr, 'get_peers', { info_hash: t }) : await this.query(n.addr, 'find_node', { target: t });
          if (r.token) tokens.set(n.addr, r.token);
          if (Array.isArray(r.values)) for (const v of r.values) for (const p of decodeCompactPeers(v)) peers.add(p);
          for (const nn of decodeNodes(r.nodes)) { this.table.add(nn); shortlist.push(nn); }
        } catch { this.table.markFailed(n.id); }
      }));
      const uniq = new Map(); for (const n of shortlist) uniq.set(n.addr, n);
      shortlist = [...uniq.values()].sort((a, b) => cmp(xor(a.id, t), xor(b.id, t))).slice(0, K);
    }
    return { nodes: shortlist, peers: [...peers], tokens };
  }

  async getPeers(infoHashHex) {
    const local = [...(this.peerStore.get(infoHashHex)?.keys() || [])];
    const { peers, tokens } = await this.lookup(infoHashHex, { infoHash: true });
    return { peers: [...new Set([...local, ...peers])], tokens };
  }

  async announce(infoHashHex, port) {
    const { peers, tokens } = await this.getPeers(infoHashHex);
    await Promise.all([...tokens].map(([addr, token]) => this.query(addr, 'announce_peer', { info_hash: Buffer.from(infoHashHex, 'hex'), port, token, implied_port: 0 }).catch(() => {})));
    return peers;
  }
}

function splitAddr(a) { const i = a.lastIndexOf(':'); return [a.slice(0, i), Number(a.slice(i + 1))]; }
