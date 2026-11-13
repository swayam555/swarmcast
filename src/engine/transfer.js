// One swarm: metadata, peers, piece selection, verification, seeding.
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Bitfield } from './bitfield.js';
import { PeerWire, encodeCompactPeers, decodeCompactPeers, splitAddr } from './wire.js';
import { TorrentStorage } from './storage.js';
import { fromInfoBuffer, pieceSize, sha1, toMagnet } from './metainfo.js';
import { announce as trackerAnnounce } from './tracker.js';
import { Meter } from './rate.js';

const BLOCK = 16 * 1024;
const META_PIECE = 16 * 1024;
const MAX_PEERS = 40;
const PIPELINE = 24;
const UPLOAD_SLOTS = 8;
const REQUEST_TIMEOUT = 20_000;

export const STATES = ['queued', 'checking', 'fetching_metadata', 'downloading', 'seeding', 'paused', 'error', 'stopped'];

export class Transfer extends EventEmitter {
  /**
   * @param engine owning Engine (peer id, listen port, throttles, CAS, DHT)
   * @param opts { infoHash, meta?, name?, announce?, peers?, downloadPath, selected?, bitfieldHex?, seedOnly? }
   */
  constructor(engine, opts) {
    super();
    this.engine = engine;
    this.infoHash = opts.infoHash;
    this.meta = opts.meta || null;
    this.displayName = opts.name;
    this.announceList = [...new Set([...(opts.announce || []), ...(this.meta?.announce || [])])];
    this.downloadPath = opts.downloadPath;
    this.selectedInit = opts.selected;
    this.restoredBitfield = opts.bitfieldHex;
    this.state = 'stopped';
    this.error = null;
    this.peers = new Map();          // addr -> PeerState
    this.known = new Set(opts.peers || []);
    this.failedAddrs = new Map();
    this.down = new Meter(); this.up = new Meter();
    this.downloaded = 0; this.uploaded = 0; this.wasted = 0; this.dedupBytes = 0;
    this.addedAt = new Date();
    this.completedAt = null;
    this.metadataParts = null;
    if (this.meta) this.initPieces();
  }

  get name() { return this.meta?.name || this.displayName || this.infoHash.slice(0, 12); }
  get magnet() { return toMagnet({ infoHash: this.infoHash, name: this.name, announce: this.announceList, length: this.meta?.length }); }

  initPieces() {
    const n = this.meta.pieces.length;
    this.have = this.restoredBitfield ? Bitfield.fromHex(n, this.restoredBitfield) : new Bitfield(n);
    this.availability = new Uint16Array(n);
    this.inflight = new Map();          // piece -> { blocks: Map(begin -> {peer, at}), received: Map(begin->buf), length }
    this.storage = new TorrentStorage(this.meta, this.downloadPath, { selected: this.selectedInit });
    this.wanted = new Bitfield(n);
    this.recomputeWanted();
  }

  recomputeWanted() {
    for (let i = 0; i < this.meta.pieces.length; i++) this.wanted.set(i, this.storage.pieceWanted(i));
  }

  selectedFiles() { return this.storage?.selected || []; }

  setSelection(indices) {
    if (!this.meta) throw new Error('metadata not available yet');
    const set = new Set(indices.map(Number));
    this.storage.selected = this.meta.files.map((_, i) => set.has(i));
    this.recomputeWanted();
    this.emit('files:selected', indices);
    if (this.state === 'seeding' && !this.isDone()) this.setState('downloading');
    this.maybeComplete();
    this.pump();
  }

  remainingWanted() {
    if (!this.meta) return Infinity;
    let left = 0;
    for (let i = 0; i < this.meta.pieces.length; i++) if (this.wanted.get(i) && !this.have.get(i)) left += pieceSize(this.meta, i);
    return left;
  }
  isDone() { return this.meta && this.remainingWanted() === 0; }
  bytesHave() {
    if (!this.meta) return 0;
    let n = 0; for (let i = 0; i < this.meta.pieces.length; i++) if (this.have.get(i)) n += pieceSize(this.meta, i);
    return n;
  }

  setState(s, err) {
    if (this.state === s && !err) return;
    this.state = s;
    if (err) this.error = err.message || String(err);
    this.emit('state', s, this.error);
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    if (['downloading', 'seeding', 'checking', 'fetching_metadata'].includes(this.state)) return;
    this.error = null;
    this.stopping = false;
    try {
      if (this.meta) await this.check();
      else this.setState('fetching_metadata');
      if (this.stopping) return;
      if (this.meta) this.setState(this.isDone() ? 'seeding' : 'downloading');
      this.discoverTimer = setInterval(() => this.discover(), 30_000);
      this.tickTimer = setInterval(() => this.tick(), 1000);
      this.chokeTimer = setInterval(() => this.rechoke(), 10_000);
      this.pexTimer = setInterval(() => this.sendPex(), 60_000);
      for (const t of [this.discoverTimer, this.tickTimer, this.chokeTimer, this.pexTimer]) t.unref?.();
      this.discover('started');
      this.emit('started');
    } catch (err) {
      this.setState('error', err);
    }
  }

  /** Verify existing data, then try to satisfy missing pieces from the CAS before touching the network. */
  async check() {
    this.setState('checking');
    await this.storage.preallocate();
    if (!this.restoredBitfield) {
      this.emit('verify:start');
      const ok = await this.storage.verify((done, total) => this.emit('verify:progress', done, total));
      for (const i of ok) this.have.set(i);
      this.emit('verify:complete', ok.length);
    }
    await this.fillFromCas();
  }

  async fillFromCas() {
    const cas = this.engine.cas;
    if (!cas) return;
    for (let i = 0; i < this.meta.pieces.length; i++) {
      if (this.have.get(i) || !this.wanted.get(i)) continue;
      const data = await cas.get(this.meta.pieces[i].toString('hex'));
      if (!data) continue;
      await this.storage.writePiece(i, data);
      this.have.set(i);
      this.dedupBytes += data.length;
      this.engine.metrics?.inc('shoal_cas_dedup_bytes_total', data.length);
    }
  }

  async stop({ paused = false } = {}) {
    this.stopping = true;
    for (const t of [this.discoverTimer, this.tickTimer, this.chokeTimer, this.pexTimer]) clearInterval(t);
    for (const p of this.peers.values()) p.wire.destroy();
    this.peers.clear();
    if (this.meta) this.inflight.clear();
    this.discover('stopped');
    await this.storage?.close();
    this.setState(paused ? 'paused' : 'stopped');
  }

  // ---------------------------------------------------------------- discovery
  async discover(event) {
    if (this.stopping && event !== 'stopped') return;
    const left = this.meta ? this.remainingWanted() : 1;
    const params = { infoHash: this.infoHash, peerId: this.engine.peerId, port: this.engine.port, uploaded: this.uploaded, downloaded: this.downloaded, left: Number.isFinite(left) ? left : 1, event };
    const urls = [...new Set([...this.announceList, ...(this.meta?.private ? [] : this.engine.extraTrackers())])];
    await Promise.all(urls.map(async (url) => {
      try {
        const r = await trackerAnnounce(url, params);
        this.trackerStats = { url, seeds: r.complete, leeches: r.incomplete, at: Date.now() };
        r.peers.forEach((p) => this.addPeer(p, 'tracker'));
      } catch (e) { this.emit('warning', `tracker ${url}: ${e.message}`); }
    }));
    if (event === 'stopped') return;
    if (this.engine.dht && !this.meta?.private) {
      this.engine.dht.announce(this.infoHash, this.engine.port).then((ps) => ps.forEach((p) => this.addPeer(p, 'dht'))).catch(() => {});
    }
    for (const p of this.engine.localPeers(this.infoHash)) this.addPeer(p, 'registry');
    for (const p of this.known) this.addPeer(p, 'manual');
  }

  addPeer(addr, source = 'manual') {
    if (!addr || this.stopping) return;
    if (this.engine.isSelf(addr)) return;
    this.known.add(addr);
    const failed = this.failedAddrs.get(addr);
    if (failed && Date.now() - failed < 60_000) return;
    if (this.peers.has(addr) || this.peers.size >= MAX_PEERS) return;
    const [host, port] = splitAddr(addr);
    if (!port) return;
    const sock = net.connect({ host, port });
    sock.setTimeout(15_000, () => sock.destroy());
    sock.once('connect', () => sock.setTimeout(0));
    const wire = new PeerWire(sock, { address: addr });
    wire.source = source;
    wire.once('error', () => this.failedAddrs.set(addr, Date.now()));
    this.attach(wire, true);
    wire.handshake(this.infoHash, this.engine.peerId);
  }

  /** Called by the engine for inbound connections whose handshake named our info hash. */
  acceptIncoming(wire) {
    if (this.stopping || this.state === 'paused' || this.peers.size >= MAX_PEERS + 10) { wire.destroy(); return; }
    this.attach(wire, false);
    wire.handshake(this.infoHash, this.engine.peerId);
    this.onHandshake(wire);
  }

  attach(wire, outgoing) {
    const addr = wire.address;
    const prior = this.peers.get(addr);
    if (prior) prior.wire.destroy();
    const peer = { wire, addr, outgoing, have: null, requests: 0, down: new Meter(10_000), up: new Meter(10_000), connectedAt: Date.now(), client: null };
    this.peers.set(addr, peer);
    wire.peer = peer;

    if (outgoing) wire.once('handshake', (h) => {
      if (h.infoHash !== this.infoHash) return wire.destroy();
      if (Buffer.from(h.peerId).equals(this.engine.peerId)) return wire.destroy();
      this.onHandshake(wire);
    });
    wire.on('bitfield', (buf) => {
      if (!this.meta) { peer.pendingBitfield = buf; return; }
      peer.have = new Bitfield(this.meta.pieces.length, buf);
      for (let i = 0; i < peer.have.size; i++) if (peer.have.get(i)) this.availability[i]++;
      this.updateInterest(peer);
    });
    wire.on('have', (i) => {
      if (!this.meta) { (peer.pendingHaves ||= []).push(i); return; }
      if (!peer.have) peer.have = new Bitfield(this.meta.pieces.length);
      if (!peer.have.get(i)) { peer.have.set(i); this.availability[i]++; }
      this.updateInterest(peer);
    });
    wire.on('unchoke', () => this.pump());
    wire.on('choke', () => this.releasePeer(peer));
    wire.on('interested', () => this.rechoke());
    wire.on('not_interested', () => this.rechoke());
    wire.on('piece', (i, begin, block) => this.onBlock(peer, i, begin, block));
    wire.on('request', (i, begin, len) => this.onRequest(peer, i, begin, len));
    wire.on('extended_handshake', (d) => this.onExtHandshake(peer, d));
    wire.on('metadata', (m, payload) => this.onMetadataMsg(peer, m, payload));
    wire.on('pex', (d) => { if (Buffer.isBuffer(d.added)) decodeCompactPeers(d.added).forEach((a) => this.addPeer(a, 'pex')); });
    wire.on('port', (p) => { if (this.engine.dht) this.engine.dht.query(`${splitAddr(addr)[0]}:${p}`, 'ping', {}).catch(() => {}); });
    wire.on('error', () => {});
    wire.on('close', () => {
      this.releasePeer(peer);
      if (peer.have && this.meta) for (let i = 0; i < peer.have.size; i++) if (peer.have.get(i) && this.availability[i]) this.availability[i]--;
      if (this.peers.get(addr) === peer) this.peers.delete(addr);
      this.emit('peer:disconnected', addr);
    });
  }

  onHandshake(wire) {
    const peer = wire.peer;
    if (wire.supportsExtensions) wire.extendedHandshake(this.meta ? { metadata_size: this.meta.infoBuffer.length } : {});
    if (this.meta && this.have.count()) wire.bitfield(this.have.toBuffer());
    if (this.engine.dht) wire.port(this.engine.dht.port);
    this.emit('peer:connected', peer.addr);
    this.rechoke();
  }

  updateInterest(peer) {
    if (!this.meta || !peer.have) return;
    let want = false;
    for (let i = 0; i < this.meta.pieces.length && !want; i++) if (peer.have.get(i) && !this.have.get(i) && this.wanted.get(i)) want = true;
    if (want) peer.wire.interested(); else peer.wire.notInterested();
    if (want) this.pump();
  }

  // ---------------------------------------------------------------- metadata (BEP 9)
  onExtHandshake(peer, d) {
    peer.client = d.v ? String(d.v) : null;
    if (this.meta || !d.metadata_size || !peer.wire.remoteExt.ut_metadata) return;
    const size = Number(d.metadata_size);
    if (size <= 0 || size > 16 * 1024 * 1024) return;
    if (!this.metadataParts) this.metadataParts = { size, parts: new Array(Math.ceil(size / META_PIECE)).fill(null) };
    this.requestMetadata(peer);
  }

  requestMetadata(peer) {
    const m = this.metadataParts;
    if (!m) return;
    m.parts.forEach((p, i) => { if (!p) peer.wire.extended('ut_metadata', { msg_type: 0, piece: i }); });
  }

  onMetadataMsg(peer, m, payload) {
    const type = Number(m.msg_type);
    const piece = Number(m.piece);
    if (type === 0) {
      if (!this.meta) return peer.wire.extended('ut_metadata', { msg_type: 2, piece });
      const start = piece * META_PIECE;
      if (start >= this.meta.infoBuffer.length) return peer.wire.extended('ut_metadata', { msg_type: 2, piece });
      return peer.wire.extended('ut_metadata', { msg_type: 1, piece, total_size: this.meta.infoBuffer.length }, this.meta.infoBuffer.subarray(start, start + META_PIECE));
    }
    if (type !== 1 || this.meta || !this.metadataParts) return;
    const mp = this.metadataParts;
    if (piece >= mp.parts.length) return;
    mp.parts[piece] = Buffer.from(payload);
    if (mp.parts.every(Boolean)) {
      const info = Buffer.concat(mp.parts).subarray(0, mp.size);
      if (sha1(info).toString('hex') !== this.infoHash) { this.metadataParts = null; this.emit('warning', 'metadata hash mismatch, retrying'); return; }
      this.onMetadata(info).catch((e) => this.setState('error', e));
    }
  }

  async onMetadata(infoBuf) {
    this.meta = fromInfoBuffer(infoBuf, { trackers: this.announceList });
    this.metadataParts = null;
    this.initPieces();
    this.emit('metadata', this.meta);
    await this.check();
    for (const peer of this.peers.values()) {
      if (peer.pendingBitfield) peer.have = new Bitfield(this.meta.pieces.length, peer.pendingBitfield);
      if (peer.pendingHaves) { peer.have ||= new Bitfield(this.meta.pieces.length); peer.pendingHaves.forEach((i) => peer.have.set(i)); }
      if (peer.have) for (let i = 0; i < peer.have.size; i++) if (peer.have.get(i)) this.availability[i]++;
      if (this.have.count()) peer.wire.bitfield(this.have.toBuffer());
      this.updateInterest(peer);
    }
    this.setState(this.isDone() ? 'seeding' : 'downloading');
    this.maybeComplete();
    this.pump();
  }

  // ---------------------------------------------------------------- downloading
  /** Rarest-first among wanted pieces this peer has; endgame duplicates the last blocks. */
  pickBlocks(peer, budget) {
    const out = [];
    if (!peer.have) return out;
    // 1. continue partially requested pieces
    for (const [i, st] of this.inflight) {
      if (!peer.have.get(i)) continue;
      for (const b of st.missing()) {
        if (out.length >= budget) return out;
        if (!st.requested.has(b)) out.push([i, b]);
      }
    }
    // 2. start new pieces, rarest first
    const candidates = [];
    for (let i = 0; i < this.meta.pieces.length; i++) {
      if (this.have.get(i) || !this.wanted.get(i) || !peer.have.get(i) || this.inflight.has(i)) continue;
      candidates.push(i);
    }
    candidates.sort((a, b) => this.availability[a] - this.availability[b] || Math.random() - 0.5);
    for (const i of candidates) {
      if (out.length >= budget) break;
      const st = this.pieceState(i);
      for (const b of st.missing()) { if (out.length >= budget) break; out.push([i, b]); }
    }
    // 3. endgame: everything is requested somewhere, ask this peer too
    if (!out.length && this.remainingWanted() <= this.meta.pieceLength * 4) {
      for (const [i, st] of this.inflight) {
        if (!peer.have.get(i)) continue;
        for (const b of st.missing()) { if (out.length >= budget) break; if (!st.requested.get(b)?.has(peer.addr)) out.push([i, b]); }
      }
    }
    return out;
  }

  pieceState(i) {
    let st = this.inflight.get(i);
    if (st) return st;
    const length = pieceSize(this.meta, i);
    const blocks = Math.ceil(length / BLOCK);
    st = {
      length,
      received: new Map(),
      requested: new Map(), // begin -> Set(addr)
      missing() { const m = []; for (let b = 0; b < blocks; b++) if (!this.received.has(b * BLOCK)) m.push(b * BLOCK); return m; },
    };
    this.inflight.set(i, st);
    return st;
  }

  pump() {
    if (!this.meta || this.state !== 'downloading' || this.stopping) return;
    for (const peer of this.peers.values()) {
      if (peer.wire.peerChoking || !peer.wire.amInterested) continue;
      const budget = PIPELINE - peer.requests;
      if (budget <= 0) continue;
      for (const [i, begin] of this.pickBlocks(peer, budget)) {
        const st = this.pieceState(i);
        const len = Math.min(BLOCK, st.length - begin);
        const who = st.requested.get(begin) || new Set();
        who.add(peer.addr); st.requested.set(begin, who);
        (peer.pending ||= new Map()).set(`${i}:${begin}`, Date.now());
        peer.requests++;
        this.engine.downThrottle.take(len).then(() => { if (!peer.wire.closed) peer.wire.request(i, begin, len); });
      }
    }
  }

  releasePeer(peer) {
    if (!peer.pending || !this.meta) return;
    for (const key of peer.pending.keys()) {
      const [i, begin] = key.split(':').map(Number);
      const st = this.inflight.get(i);
      const who = st?.requested.get(begin);
      if (who) { who.delete(peer.addr); if (!who.size) st.requested.delete(begin); }
    }
    peer.pending.clear(); peer.requests = 0;
  }

  async onBlock(peer, i, begin, block) {
    const key = `${i}:${begin}`;
    if (peer.pending?.delete(key)) peer.requests = Math.max(0, peer.requests - 1);
    peer.down.add(block.length); this.down.add(block.length); this.downloaded += block.length;
    this.engine.onBytes('down', block.length);
    const st = this.inflight.get(i);
    if (!st || this.have.get(i) || st.received.has(begin)) { this.wasted += block.length; this.pump(); return; }
    st.received.set(begin, block);
    // endgame: cancel duplicates elsewhere
    const who = st.requested.get(begin);
    if (who) for (const a of who) if (a !== peer.addr) this.peers.get(a)?.wire.cancel(i, begin, block.length);
    if (st.missing().length === 0) {
      this.inflight.delete(i);
      const data = Buffer.concat([...st.received.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]));
      if (!sha1(data).equals(this.meta.pieces[i])) {
        this.wasted += data.length;
        peer.badPieces = (peer.badPieces || 0) + 1;
        this.emit('warning', `piece ${i} failed hash check from ${peer.addr}`);
        if (peer.badPieces >= 3) { this.emit('peer:banned', peer.addr); this.failedAddrs.set(peer.addr, Date.now() + 3600_000); peer.wire.destroy(); }
      } else {
        await this.storage.writePiece(i, data);
        this.have.set(i);
        this.engine.cas?.put(this.meta.pieces[i].toString('hex'), data).catch(() => {});
        for (const p of this.peers.values()) p.wire.have(i);
        this.emit('piece', i);
        this.maybeComplete();
      }
    }
    this.pump();
  }

  maybeComplete() {
    if (this.meta && this.isDone() && this.state === 'downloading') {
      this.completedAt = new Date();
      this.setState('seeding');
      this.emit('complete');
      this.discover('completed');
      for (const p of this.peers.values()) this.updateInterest(p);
    }
  }

  // ---------------------------------------------------------------- uploading
  async onRequest(peer, i, begin, len) {
    if (!this.meta || peer.wire.amChoking || !this.have.get(i) || len > 128 * 1024) return;
    if (begin + len > pieceSize(this.meta, i)) return;
    try {
      await this.engine.upThrottle.take(len);
      if (peer.wire.closed || peer.wire.amChoking) return;
      const block = await this.storage.read(i, begin, len);
      peer.wire.piece(i, begin, block);
      peer.up.add(len); this.up.add(len); this.uploaded += len;
      this.engine.onBytes('up', len);
    } catch (e) { this.emit('warning', `upload failed: ${e.message}`); }
  }

  /** Tit-for-tat with one optimistic slot. Seeds rank by upload rate (spread bytes to fast peers first). */
  rechoke() {
    const interested = [...this.peers.values()].filter((p) => p.wire.peerInterested);
    const seeding = this.state === 'seeding';
    interested.sort((a, b) => (seeding ? b.up.rate() - a.up.rate() : b.down.rate() - a.down.rate()));
    const keep = new Set(interested.slice(0, UPLOAD_SLOTS - 1));
    const rest = interested.filter((p) => !keep.has(p));
    if (rest.length) keep.add(rest[Math.floor(Math.random() * rest.length)]);
    for (const p of this.peers.values()) { if (keep.has(p)) p.wire.unchoke(); else p.wire.choke(); }
  }

  sendPex() {
    const list = [...this.peers.values()].filter((p) => p.outgoing).map((p) => p.addr).slice(0, 50);
    if (!list.length) return;
    const added = encodeCompactPeers(list);
    for (const p of this.peers.values()) p.wire.extended('ut_pex', { added, 'added.f': Buffer.alloc(list.length) });
  }

  tick() {
    // time out stuck requests so another peer can take them
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (!peer.pending) continue;
      for (const [key, at] of peer.pending) {
        if (now - at < REQUEST_TIMEOUT) continue;
        peer.pending.delete(key); peer.requests = Math.max(0, peer.requests - 1);
        const [i, begin] = key.split(':').map(Number);
        this.inflight.get(i)?.requested.get(begin)?.delete(peer.addr);
      }
    }
    if (['downloading', 'fetching_metadata'].includes(this.state) && this.peers.size < 5) for (const a of this.known) { if (this.peers.size >= MAX_PEERS) break; this.addPeer(a); }
    if (this.state === 'fetching_metadata') for (const p of this.peers.values()) this.requestMetadata(p);
    this.pump();
    this.emit('progress', this.snapshot());
  }

  // ---------------------------------------------------------------- reporting
  snapshot() {
    const total = this.meta?.length || 0;
    const have = this.bytesHave();
    const wantedTotal = this.meta ? this.meta.files.reduce((n, f, i) => n + (this.storage.selected[i] ? f.length : 0), 0) : 0;
    const left = this.meta ? this.remainingWanted() : 0;
    const speed = this.down.rate();
    const peers = [...this.peers.values()];
    const seeds = peers.filter((p) => p.have && this.meta && p.have.complete()).length;
    return {
      infoHash: this.infoHash, name: this.name, state: this.state, error: this.error,
      size: total, downloaded: this.downloaded, uploaded: this.uploaded, have,
      wanted: wantedTotal,
      percentage: this.meta ? (wantedTotal ? Math.round(((wantedTotal - left) / wantedTotal) * 10000) / 100 : 100) : 0,
      downloadSpeed: speed, uploadSpeed: this.up.rate(),
      eta: speed > 0 && left > 0 ? Math.round(left / speed) : (left === 0 ? 0 : -1),
      peers: { connected: peers.length, total: this.known.size },
      seeds: Math.max(seeds, this.trackerStats?.seeds || 0), leeches: Math.max(peers.length - seeds, this.trackerStats?.leeches || 0),
      pieceCount: this.meta?.pieces.length || 0,
      completedPieces: this.have?.count() || 0,
      activePieces: this.inflight?.size || 0,
      pendingRequests: peers.reduce((n, p) => n + p.requests, 0),
      wasted: this.wasted, dedupBytes: this.dedupBytes,
      ratio: this.downloaded ? Math.round((this.uploaded / this.downloaded) * 100) / 100 : 0,
    };
  }

  /** 0 = missing, 1 = downloading, 2 = have */
  pieceMap() {
    if (!this.meta) return [];
    return Array.from({ length: this.meta.pieces.length }, (_, i) => (this.have.get(i) ? 2 : this.inflight.has(i) ? 1 : 0));
  }

  peerList() {
    return [...this.peers.values()].map((p) => ({
      address: p.addr, client: p.client, source: p.wire.source || (p.outgoing ? 'outgoing' : 'incoming'),
      downloadSpeed: p.down.rate(), uploadSpeed: p.up.rate(),
      progress: p.have ? Math.round((p.have.count() / p.have.size) * 1000) / 10 : 0,
      choked: p.wire.peerChoking, choking: p.wire.amChoking, interested: p.wire.peerInterested,
    }));
  }

  fileList() {
    if (!this.meta) return [];
    return this.meta.files.map((f, index) => {
      let have = 0;
      const first = Math.floor(f.offset / this.meta.pieceLength);
      const last = Math.floor((f.offset + Math.max(f.length, 1) - 1) / this.meta.pieceLength);
      for (let i = first; i <= last; i++) if (this.have.get(i)) have++;
      return { index, name: f.name, path: f.path, length: f.length, selected: this.storage.selected[index], progress: Math.round((have / (last - first + 1)) * 1000) / 10 };
    });
  }
}
