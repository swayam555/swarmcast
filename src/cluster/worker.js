// Data-plane worker. Crash-only: everything it needs to resume lives in the DB
// (placements + bitfield checkpoints) and on its own disk, so it can be killed
// at any point and a restart (or another worker) picks the work back up.
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Engine } from '../engine/engine.js';
import { parseMagnet } from '../engine/metainfo.js';
import { now, getSettings, logActivity } from '../store/db.js';

const LEASE_TTL = 15_000;

export class Worker {
  constructor({ db, bus, leases, dataDir, host, peerPort = 0, dhtPort = 0, dht = true, dhtBootstrap = [], trackers = [], metrics, logger = console, nodeId }) {
    this.db = db; this.bus = bus; this.leases = leases; this.metrics = metrics; this.log = logger;
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.id = nodeId || this.loadNodeId();
    this.host = host || process.env.SWARMCAST_ADVERTISE_HOST || '127.0.0.1';
    this.held = new Map(); // transferId -> { slot, fence, transfer }
    this.engineOpts = { dataDir: this.dataDir, port: peerPort, dhtPort, dht, dhtBootstrap, trackers, announceHost: this.host, metrics };
  }

  loadNodeId() {
    const f = path.join(this.dataDir, 'node-id');
    if (existsSync(f)) return readFileSync(f, 'utf8').trim();
    const id = `node-${os.hostname().slice(0, 16)}-${randomBytes(3).toString('hex')}`;
    writeFileSync(f, id);
    return id;
  }

  async start() {
    const s = getSettings(this.db);
    this.engine = await new Engine({
      ...this.engineOpts,
      maxActiveTorrents: s.maxActiveTorrents,
      downloadLimit: s.speedLimits.download, uploadLimit: s.speedLimits.upload,
      registry: { peersFor: (ih) => this.fleetPeers(ih) },
    }).start();
    this.engine.on('transfer', (ev, t, ...args) => this.onTransferEvent(ev, t, args));
    this.engine.on('warning', (m) => this.log.warn?.(`[${this.id}] ${m}`));

    const t = now();
    this.db.run(`INSERT INTO nodes(id, host, peer_port, dht_port, status, capacity, started_at, heartbeat_at) VALUES (?,?,?,?, 'up', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host = excluded.host, peer_port = excluded.peer_port, dht_port = excluded.dht_port, status = 'up', started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
    this.id, this.host, this.engine.port, this.engine.dht?.port ?? null, s.maxActiveTorrents, t, t);
    logActivity(this.db, { nodeId: this.id, event: 'node.up', detail: { host: this.host, port: this.engine.port } });

    await this.bus.subscribe((d) => this.onDirective(d));
    this.heartbeatTimer = setInterval(() => this.heartbeat().catch((e) => this.log.error?.(e)), 3000);
    this.reconcileTimer = setInterval(() => this.reconcile().catch((e) => this.log.error?.(e)), 2000);
    this.progressTimer = setInterval(() => this.writeProgress(), 1000);
    await this.reconcile();
    this.log.info?.(`[${this.id}] worker up: peer port ${this.engine.port}, dht ${this.engine.dht?.port ?? 'off'}, leases ${this.leases.kind}, bus ${this.bus.kind}`);
    return this;
  }

  async stop() {
    clearInterval(this.heartbeatTimer); clearInterval(this.reconcileTimer); clearInterval(this.progressTimer);
    this.writeProgress();
    for (const [tid, h] of this.held) await this.leases.release(this.leaseKey(tid, h.slot), this.id, h.fence);
    await this.engine?.stop();
    this.db.run("UPDATE nodes SET status = 'down', heartbeat_at = ? WHERE id = ?", now(), this.id);
  }

  leaseKey(tid, slot) { return `placement:${tid}:${slot}`; }

  /** Peers on other workers that hold (part of) this artifact — East-West discovery without a tracker. */
  fleetPeers(infoHash) {
    return this.db.all(`SELECT n.host, n.peer_port FROM placements p JOIN transfers t ON t.id = p.transfer_id JOIN nodes n ON n.id = p.node_id
      WHERE t.info_hash = ? AND p.node_id != ? AND n.status = 'up' AND p.state IN ('downloading','seeding')`, infoHash, this.id)
      .map((r) => `${r.host}:${r.peer_port}`);
  }

  async heartbeat() {
    const stats = this.engine.stats();
    this.db.run('UPDATE nodes SET heartbeat_at = ?, status = ?, stats = ? WHERE id = ?', now(), 'up', JSON.stringify({ ...stats, dht: this.engine.dhtStatus(), held: this.held.size }), this.id);
    for (const [tid, h] of this.held) {
      const ok = await this.leases.renew(this.leaseKey(tid, h.slot), this.id, h.fence, LEASE_TTL);
      if (!ok) {
        // Fenced out: someone else owns this placement now. Stop touching it.
        this.log.warn?.(`[${this.id}] lost lease on ${tid}, stopping`);
        this.metrics?.inc('swarmcast_lease_lost_total');
        await this.drop(tid, { keepRow: true });
      }
    }
    this.metrics?.set('swarmcast_worker_leases_held', this.held.size, { node: this.id });
  }

  async onDirective({ type, payload, requestId }) {
    this.metrics?.inc('swarmcast_directives_consumed_total', 1, { type });
    if (type === 'SETTINGS_CHANGED') {
      const s = getSettings(this.db);
      this.engine.setSpeedLimits(s.speedLimits);
      this.engine.setMaxActive(s.maxActiveTorrents);
      return;
    }
    if (type === 'JOB_ASSIGNED' || type === 'JOB_UPDATED') return this.reconcile(requestId);
  }

  /** Make the engine match desired state in the DB. Idempotent; safe to run any time. */
  async reconcile(requestId) {
    if (this.reconciling) { this.again = true; return; }
    this.reconciling = true;
    try {
      const transfers = this.db.all('SELECT * FROM transfers');
      const settings = getSettings(this.db);
      for (const tr of transfers) {
        const mine = this.held.get(tr.id);
        if (tr.desired === 'removed') { if (mine) await this.drop(tr.id, { deleteFiles: true }); continue; }
        if (!mine) {
          const slot = await this.claimSlot(tr, settings);
          if (slot) await this.adopt(tr, slot, requestId);
          continue;
        }
        const t = mine.transfer;
        if (tr.desired === 'paused' && !['paused', 'stopped'].includes(t.state)) { await this.engine.pause(t.infoHash); logActivity(this.db, { transferId: tr.id, nodeId: this.id, event: 'transfer.paused', requestId }); }
        if (tr.desired === 'running' && ['paused', 'stopped', 'error'].includes(t.state)) { await this.engine.resume(t.infoHash); logActivity(this.db, { transferId: tr.id, nodeId: this.id, event: 'transfer.resumed', requestId }); }
        const sel = tr.selected ? JSON.parse(tr.selected) : null;
        if (sel && t.meta && JSON.stringify(sel) !== JSON.stringify(mine.selected)) { t.setSelection(sel); mine.selected = sel; }
      }
      // clean up removed transfers that no longer have any placement
      this.db.run("DELETE FROM transfers WHERE desired = 'removed' AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.transfer_id = transfers.id)");
    } finally {
      this.reconciling = false;
      if (this.again) { this.again = false; setImmediate(() => this.reconcile()); }
    }
  }

  /** Decide whether this worker should host the transfer, and grab a lease for it. */
  async claimSlot(tr, settings) {
    const busy = [...this.held.values()].filter((h) => !['seeding', 'paused'].includes(h.transfer.state)).length;
    const canRead = tr.source_path && existsSync(tr.source_path);
    // An uploaded artifact must be seeded by a worker that can read the original file.
    if (canRead) { const fence = await this.leases.acquire(this.leaseKey(tr.id, 'origin'), this.id, LEASE_TTL); if (fence) return { slot: 'origin', fence }; }
    if (tr.source_path && !canRead && tr.replicas === '1') return null;
    if (busy >= settings.maxActiveTorrents * 2) return null;
    const slots = tr.replicas === 'all' ? [this.id] : Array.from({ length: Math.max(1, Number(tr.replicas) || 1) }, (_, i) => `r${i}`);
    for (const slot of slots) {
      if (tr.source_path && tr.replicas === '1') break; // origin slot is the single replica
      const fence = await this.leases.acquire(this.leaseKey(tr.id, slot), this.id, LEASE_TTL);
      if (fence) return { slot, fence };
    }
    return null;
  }

  async adopt(tr, { slot, fence }, requestId) {
    const prev = this.db.get('SELECT bitfield FROM placements WHERE transfer_id = ? AND node_id = ?', tr.id, this.id);
    const selected = tr.selected ? JSON.parse(tr.selected) : null;
    let hints = [];
    try { hints = parseMagnet(tr.magnet).peers; } catch { /* stored magnet without peer hints */ }
    const opts = { autoStart: tr.desired === 'running', bitfieldHex: prev?.bitfield || undefined, peers: hints, originUrl: tr.origin_url || undefined };
    if (slot === 'origin') opts.downloadPath = path.dirname(tr.source_path);
    let t;
    try {
      t = this.engine.add(tr.torrent ? Buffer.from(tr.torrent) : tr.magnet, opts);
    } catch (e) {
      await this.leases.release(this.leaseKey(tr.id, slot), this.id, fence);
      logActivity(this.db, { transferId: tr.id, nodeId: this.id, event: 'transfer.error', detail: { message: e.message } });
      return;
    }
    if (selected && t.meta) t.setSelection(selected);
    const ts = now();
    this.db.run(`INSERT INTO placements(transfer_id, node_id, state, fence, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(transfer_id, node_id) DO UPDATE SET fence = excluded.fence, state = excluded.state, updated_at = excluded.updated_at`, tr.id, this.id, t.state, fence, ts);
    this.held.set(tr.id, { slot, fence, transfer: t, selected });
    t.transferId = tr.id;
    if (tr.desired === 'paused') await this.engine.pause(t.infoHash);
    logActivity(this.db, { transferId: tr.id, nodeId: this.id, event: 'transfer.assigned', detail: { slot, fence, resumed: Boolean(prev?.bitfield) }, requestId });
    this.metrics?.inc('swarmcast_lease_acquired_total');
  }

  async drop(tid, { deleteFiles = false, keepRow = false } = {}) {
    const h = this.held.get(tid);
    if (!h) return;
    this.held.delete(tid);
    try { await this.engine.remove(h.transfer.infoHash, { deleteFiles: deleteFiles && h.slot !== 'origin' }); } catch { /* already gone */ }
    await this.leases.release(this.leaseKey(tid, h.slot), this.id, h.fence);
    if (!keepRow) this.db.run('DELETE FROM placements WHERE transfer_id = ? AND node_id = ? AND fence = ?', tid, this.id, h.fence);
    logActivity(this.db, { transferId: tid, nodeId: this.id, event: keepRow ? 'transfer.fenced' : 'transfer.removed' });
  }

  writeProgress() {
    for (const [tid, h] of this.held) {
      const t = h.transfer; const s = t.snapshot();
      const dataPath = t.meta ? path.join(t.downloadPath, t.meta.files.length > 1 ? t.meta.name : t.meta.files[0].path) : null;
      // Fenced write: a stale worker's update matches zero rows.
      this.db.run(`UPDATE placements SET state = ?, error = ?, progress = ?, have_bytes = ?, downloaded = ?, uploaded = ?, download_speed = ?, upload_speed = ?,
        peers = ?, seeds = ?, leeches = ?, eta = ?, completed_pieces = ?, dedup_bytes = ?, bitfield = ?, data_path = ?, detail = ?, updated_at = ?,
        completed_at = COALESCE(completed_at, ?) WHERE transfer_id = ? AND node_id = ? AND fence = ?`,
      s.state, s.error, s.percentage, s.have, s.downloaded, s.uploaded, s.downloadSpeed, s.uploadSpeed,
      s.peers.connected, s.seeds, s.leeches, s.eta, s.completedPieces, s.dedupBytes,
      t.have && ['downloading', 'seeding', 'paused'].includes(t.state) ? t.have.toHex() : null, dataPath,
      JSON.stringify({ pieceMap: compressMap(t.pieceMap()), peers: t.peerList(), files: t.fileList(), activePieces: s.activePieces, pendingRequests: s.pendingRequests, pieceCount: s.pieceCount, wasted: s.wasted, originBytes: s.originBytes, total: s.size }),
      now(), t.completedAt ? t.completedAt.toISOString() : null, tid, this.id, h.fence);
    }
  }

  onTransferEvent(ev, t, args) {
    const tid = t.transferId;
    if (!tid) return;
    if (ev === 'metadata') {
      this.db.run('UPDATE transfers SET name = ?, size = ?, piece_count = ?, torrent = COALESCE(torrent, ?), updated_at = ? WHERE id = ?', t.meta.name, t.meta.length, t.meta.pieces.length, t.meta.torrent, now(), tid);
      logActivity(this.db, { transferId: tid, nodeId: this.id, event: 'transfer.metadata', detail: { name: t.meta.name, size: t.meta.length } });
    }
    if (ev === 'complete') { logActivity(this.db, { transferId: tid, nodeId: this.id, event: 'transfer.completed', detail: { downloaded: t.downloaded, dedupBytes: t.dedupBytes } }); this.metrics?.inc('swarmcast_transfers_completed_total'); }
    if (ev === 'state' && args[0] === 'error') logActivity(this.db, { transferId: tid, nodeId: this.id, event: 'transfer.error', detail: { message: args[1] } });
    if (ev === 'peer:banned') logActivity(this.db, { transferId: tid, nodeId: this.id, event: 'peer.banned', detail: { peer: args[0] } });
    if (ev === 'piece') this.metrics?.inc('swarmcast_pieces_verified_total');
  }
}

/** Run-length encode a 0/1/2 piece map so large torrents stay cheap to store. */
function compressMap(arr) {
  const out = [];
  for (const v of arr) { const last = out[out.length - 1]; if (last && last[0] === v) last[1]++; else out.push([v, 1]); }
  return out;
}
