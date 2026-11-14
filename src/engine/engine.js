// The data plane in one process: a TCP listener shared by every swarm, a queue
// that caps concurrently active transfers, global throttles, CAS and the DHT.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { PeerWire } from './wire.js';
import { Transfer } from './transfer.js';
import { CasStore } from './storage.js';
import { Throttle, Meter, SpeedHistory } from './rate.js';
import { parseMagnet, parseTorrent, createTorrent } from './metainfo.js';
import { DHT } from '../dht/dht.js';

export class Engine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.dataDir = opts.dataDir || path.resolve('data');
    this.settings = {
      downloadPath: opts.downloadPath || path.join(this.dataDir, 'downloads'),
      maxActiveTorrents: opts.maxActiveTorrents ?? 5,
      port: opts.port ?? 6881,
      announceHost: opts.announceHost || null,
      dht: { enabled: opts.dht !== false, port: opts.dhtPort ?? 6881, bootstrap: opts.dhtBootstrap || [] },
      speedLimits: { download: opts.downloadLimit || 0, upload: opts.uploadLimit || 0 },
      trackers: opts.trackers || [],
    };
    this.peerId = Buffer.concat([Buffer.from('-SH0100-'), randomBytes(12)]);
    this.transfers = new Map();
    this.queue = [];
    this.downThrottle = new Throttle(this.settings.speedLimits.download);
    this.upThrottle = new Throttle(this.settings.speedLimits.upload);
    this.down = new Meter(); this.up = new Meter();
    this.history = new SpeedHistory();
    this.registry = opts.registry || null; // cluster peer registry (other workers)
    this.metrics = opts.metrics || null;
  }

  async start() {
    await mkdir(this.settings.downloadPath, { recursive: true });
    this.cas = await new CasStore(path.join(this.dataDir, 'cas')).init();
    this.server = net.createServer((sock) => this.onIncoming(sock));
    await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(this.settings.port, res); });
    this.port = this.server.address().port;
    if (this.settings.dht.enabled) {
      try {
        this.dht = await new DHT({ port: this.settings.dht.port, bootstrap: this.settings.dht.bootstrap }).start();
      } catch (e) { this.emit('warning', `DHT disabled: ${e.message}`); this.dht = null; }
    }
    this.historyTimer = setInterval(() => this.history.push(this.down.rate(), this.up.rate()), this.history.intervalMs);
    this.historyTimer.unref();
    return this;
  }

  async stop() {
    clearInterval(this.historyTimer);
    for (const t of this.transfers.values()) await t.stop();
    this.dht?.stop();
    await this.cas?.close();
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  onBytes(dir, n) {
    (dir === 'down' ? this.down : this.up).add(n);
    this.metrics?.inc(dir === 'down' ? 'swarmcast_bytes_downloaded_total' : 'swarmcast_bytes_uploaded_total', n);
  }

  isSelf(addr) {
    const [host, port] = [addr.slice(0, addr.lastIndexOf(':')), Number(addr.slice(addr.lastIndexOf(':') + 1))];
    if (port !== this.port) return false;
    if (host === '127.0.0.1' || host === 'localhost' || host === this.settings.announceHost) return true;
    return Object.values(os.networkInterfaces()).flat().some((i) => i?.address === host);
  }

  extraTrackers() { return this.settings.trackers; }
  localPeers(infoHash) { return this.registry ? this.registry.peersFor(infoHash) : []; }

  onIncoming(sock) {
    const wire = new PeerWire(sock);
    const timer = setTimeout(() => wire.destroy(), 10_000);
    wire.once('handshake', ({ infoHash }) => {
      clearTimeout(timer);
      const t = this.transfers.get(infoHash);
      if (!t) return wire.destroy();
      t.acceptIncoming(wire);
    });
    wire.on('error', () => {});
  }

  // ---------------------------------------------------------------- transfers
  /**
   * Add a transfer from a magnet URI, a .torrent buffer or a parsed meta.
   * Options: { autoStart, downloadPath, selected, bitfieldHex, peers }.
   */
  add(source, opts = {}) {
    let infoHash, meta = null, name, announce = [], peers = [];
    if (typeof source === 'string') {
      const m = parseMagnet(source); infoHash = m.infoHash; name = m.name; announce = m.announce; peers = m.peers;
    } else if (Buffer.isBuffer(source)) {
      meta = parseTorrent(source); infoHash = meta.infoHash;
    } else if (source?.infoHash && source.pieces) {
      meta = source; infoHash = meta.infoHash;
    } else throw new Error('expected a magnet URI or .torrent data');

    const existing = this.transfers.get(infoHash);
    if (existing) return existing;
    const t = new Transfer(this, {
      infoHash, meta, name, announce, peers: [...peers, ...(opts.peers || [])],
      downloadPath: opts.downloadPath || this.settings.downloadPath,
      selected: opts.selected, bitfieldHex: opts.bitfieldHex, originUrl: opts.originUrl,
    });
    this.transfers.set(infoHash, t);
    for (const ev of ['state', 'progress', 'piece', 'complete', 'metadata', 'warning', 'peer:connected', 'peer:disconnected', 'peer:banned', 'verify:progress', 'files:selected']) {
      t.on(ev, (...args) => this.emit('transfer', ev, t, ...args));
    }
    t.on('state', () => this.schedule());
    if (opts.autoStart !== false) this.enqueue(t);
    return t;
  }

  /** Hash local files and start seeding them. */
  async seed(srcPath, opts = {}) {
    // The torrent name must equal the on-disk name, or the seeder would look for data in the wrong place.
    const meta = await createTorrent(srcPath, { announce: opts.announce || this.settings.trackers });
    const downloadPath = path.dirname(path.resolve(srcPath));
    const t = this.add(meta, { ...opts, downloadPath, autoStart: true });
    return t;
  }

  activeCount() { return [...this.transfers.values()].filter((t) => ['checking', 'fetching_metadata', 'downloading'].includes(t.state)).length; }

  enqueue(t) {
    if (!this.queue.includes(t)) this.queue.push(t);
    if (t.state === 'stopped' || t.state === 'paused' || t.state === 'error') t.setState('queued');
    this.emit('queue:add', t.infoHash);
    this.schedule();
  }

  /** Seeding doesn't count toward the active cap: fleets should always share what they have. */
  schedule() {
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.state !== 'queued') { this.queue.shift(); continue; }
      const seedOnly = next.meta && next.restoredBitfield && next.isDone();
      if (!seedOnly && this.activeCount() >= this.settings.maxActiveTorrents) break;
      this.queue.shift();
      this.emit('queue:start', next.infoHash);
      next.start();
    }
  }

  async pause(infoHash) {
    const t = this.get(infoHash);
    this.queue = this.queue.filter((q) => q !== t);
    await t.stop({ paused: true });
    this.schedule();
    return t;
  }
  async resume(infoHash) { const t = this.get(infoHash); this.enqueue(t); return t; }

  async remove(infoHash, { deleteFiles = false } = {}) {
    const t = this.get(infoHash);
    this.queue = this.queue.filter((q) => q !== t);
    await t.stop();
    if (deleteFiles && t.storage) await t.storage.remove();
    this.transfers.delete(infoHash);
    this.schedule();
  }

  get(infoHash) {
    const t = this.transfers.get(infoHash);
    if (!t) { const e = new Error('transfer not found'); e.status = 404; throw e; }
    return t;
  }

  // ---------------------------------------------------------------- settings
  setSpeedLimits({ download, upload }) {
    if (download !== undefined) { this.settings.speedLimits.download = Math.max(0, Number(download) || 0); this.downThrottle.setLimit(this.settings.speedLimits.download); }
    if (upload !== undefined) { this.settings.speedLimits.upload = Math.max(0, Number(upload) || 0); this.upThrottle.setLimit(this.settings.speedLimits.upload); }
    this.emit('limit:changed', this.settings.speedLimits);
    return this.settings.speedLimits;
  }
  setMaxActive(n) { this.settings.maxActiveTorrents = Math.max(1, Math.min(100, Number(n) || 1)); this.schedule(); }

  stats() {
    const list = [...this.transfers.values()];
    return {
      totalDownloadSpeed: this.down.rate(), totalUploadSpeed: this.up.rate(),
      activeTorrents: list.filter((t) => ['downloading', 'seeding', 'checking', 'fetching_metadata'].includes(t.state)).length,
      totalTorrents: list.length,
      totalDownloaded: this.down.total, totalUploaded: this.up.total,
      queued: this.queue.length,
      peers: list.reduce((n, t) => n + t.peers.size, 0),
      port: this.port,
    };
  }

  dhtStatus() {
    return this.dht ? this.dht.status() : { enabled: this.settings.dht.enabled, running: false, nodes: 0, port: this.settings.dht.port };
  }
}
