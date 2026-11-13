// Transfer API. The control plane never runs swarms itself: it records desired
// state, publishes a directive, and reads progress that workers write back.
import { Router, raw } from 'express';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { parseMagnet, parseTorrent, createTorrent, toMagnet } from '../engine/metainfo.js';
import { now, uuid, logActivity } from '../store/db.js';
import { tarStream } from './tar.js';
import { checkOriginUrl, httpGet } from '../engine/origin.js';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const HEX40 = /^[0-9a-f]{40}$/i;

/** Merge per-node placements into one transfer view (what the console shows). */
export function view(db, tr, userId, { detail = false } = {}) {
  const pl = db.all(`SELECT p.*, n.host, n.status AS node_status FROM placements p LEFT JOIN nodes n ON n.id = p.node_id WHERE p.transfer_id = ?`, tr.id);
  const rank = { downloading: 6, fetching_metadata: 5, checking: 4, seeding: 3, queued: 2, paused: 1, error: 0, stopped: 0 };
  const primary = [...pl].sort((a, b) => (rank[b.state] ?? 0) - (rank[a.state] ?? 0) || b.progress - a.progress)[0];
  const sum = (k) => pl.reduce((n, p) => n + (p[k] || 0), 0);
  let status = primary?.state || (tr.desired === 'paused' ? 'paused' : 'pending');
  if (tr.desired === 'paused' && !pl.some((p) => ['downloading', 'seeding'].includes(p.state))) status = 'paused';
  if (tr.desired === 'removed') status = 'removing';
  const fleetProgress = pl.length ? pl.reduce((n, p) => n + p.progress, 0) / pl.length : 0;
  const d = primary?.detail ? JSON.parse(primary.detail) : {};
  const out = {
    _id: tr.id, id: tr.id, name: tr.name, infoHash: tr.info_hash, magnetURI: tr.magnet, size: tr.size,
    status, desired: tr.desired, replicas: tr.replicas, error: primary?.error || null,
    progress: Math.round((primary ? primary.progress : 0) * 100) / 100,
    fleetProgress: Math.round(fleetProgress * 100) / 100,
    downloadSpeed: sum('download_speed'), uploadSpeed: sum('upload_speed'),
    downloaded: sum('downloaded'), uploaded: sum('uploaded'), dedupBytes: sum('dedup_bytes'),
    eta: primary?.eta ?? -1,
    seeds: Math.max(0, ...pl.map((p) => p.seeds)), leeches: Math.max(0, ...pl.map((p) => p.leeches)),
    peers: { connected: sum('peers'), total: (d.peers || []).length },
    completedPieces: primary?.completed_pieces || 0, totalPieces: tr.piece_count,
    files: d.files || [], trackers: tr.torrent ? safeTrackers(tr.torrent) : parseMagnetSafe(tr.magnet),
    addedAt: tr.created_at, createdAt: tr.created_at, completedAt: primary?.completed_at || null,
    isOwner: tr.owner_id === userId, hasSource: Boolean(tr.source_path),
    // a pre-signed URL is a secret: show only where it points
    origin: tr.origin_url ? new URL(tr.origin_url).host : null,
    originBytes: pl.reduce((n, p) => n + (p.detail ? JSON.parse(p.detail).originBytes || 0 : 0), 0),
    uploadedBy: tr.owner_id ? { _id: tr.owner_id, username: tr.owner_name || 'unknown' } : null,
    nodes: pl.map((p) => ({ nodeId: p.node_id, host: p.host, nodeStatus: p.node_status, state: p.state, progress: p.progress, downloadSpeed: p.download_speed, uploadSpeed: p.upload_speed, peers: p.peers, dedupBytes: p.dedup_bytes, updatedAt: p.updated_at })),
    downloadable: pl.some((p) => p.progress >= 100 && p.data_path && p.state !== 'lost'),
  };
  if (detail) {
    out.detail = {
      infoHash: tr.info_hash, name: tr.name, size: tr.size, downloaded: out.downloaded, total: tr.size,
      percentage: out.progress, downloadSpeed: out.downloadSpeed, uploadSpeed: out.uploadSpeed, eta: out.eta, state: status,
      peers: out.peers, seeds: out.seeds, leeches: out.leeches, pieceCount: tr.piece_count, completedPieces: out.completedPieces,
      activePieces: d.activePieces || 0, pendingRequests: d.pendingRequests || 0, wasted: d.wasted || 0,
      bitfield: expand(d.pieceMap || []), peerList: d.peers || [], nodes: out.nodes,
    };
  }
  return out;
}

const expand = (rle) => rle.flatMap(([v, n]) => Array(n).fill(v));
function safeTrackers(buf) { try { return parseTorrent(Buffer.from(buf)).announce; } catch { return []; } }
function parseMagnetSafe(m) { try { return parseMagnet(m).announce; } catch { return []; } }

export function transferRoutes({ cfg, db, bus, metrics }) {
  const r = Router();
  const owned = (req) => {
    const tr = db.get('SELECT t.*, u.username AS owner_name FROM transfers t LEFT JOIN users u ON u.id = t.owner_id WHERE t.id = ? OR t.info_hash = ?', req.params.id, req.params.id.toLowerCase());
    if (!tr) { const e = new Error('Transfer not found'); e.status = 404; throw e; }
    return tr;
  };
  const canWrite = (req, tr) => req.user.role === 'admin' || tr.owner_id === req.user.id || !tr.owner_id;
  const dispatch = async (type, tr, req, extra = {}) => {
    await bus.publish(type, { transferId: tr.id, infoHash: tr.info_hash, desired: tr.desired, ...extra }, { requestId: req.id });
    metrics.inc('shoal_directives_published_total', 1, { type });
  };

  /** An HTTP origin makes workers fetch URLs, so only admins (and the service token) may set one. */
  const originFor = (req, value) => {
    const url = checkOriginUrl(value);
    if (url && req.user.role !== 'admin' && req.user.id !== 'service') throw Object.assign(new Error('Only admins can set an HTTP origin'), { status: 403 });
    return url;
  };

  /** Insert a transfer (or return the existing one for the same info hash). */
  async function register(req, { infoHash, name, magnet, torrent = null, size = 0, pieces = 0, sourcePath = null, originUrl = null }) {
    const existing = db.get('SELECT * FROM transfers WHERE info_hash = ?', infoHash);
    if (existing) {
      if (existing.desired === 'removed') { const e = new Error('This artifact is still being removed, try again in a moment'); e.status = 409; throw e; }
      return { tr: existing, created: false };
    }
    const replicas = String(req.body?.replicas ?? req.query.replicas ?? '1');
    if (!/^(all|[1-9]\d{0,2})$/.test(replicas)) { const e = new Error('replicas must be a number or "all"'); e.status = 400; throw e; }
    const autoStart = (req.body?.autoStart ?? req.query.autoStart) !== false && (req.body?.autoStart ?? req.query.autoStart) !== 'false';
    const tr = { id: uuid(), info_hash: infoHash, name, magnet, torrent, size, piece_count: pieces, source_path: sourcePath, origin_url: originUrl, desired: autoStart ? 'running' : 'paused', replicas, owner_id: req.user.id === 'service' ? null : req.user.id, request_id: req.id, created_at: now(), updated_at: now() };
    db.run(`INSERT INTO transfers(id, info_hash, name, magnet, torrent, size, piece_count, source_path, origin_url, desired, replicas, owner_id, request_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, tr.id, tr.info_hash, tr.name, tr.magnet, tr.torrent, tr.size, tr.piece_count, tr.source_path, tr.origin_url, tr.desired, tr.replicas, tr.owner_id, tr.request_id, tr.created_at, tr.updated_at);
    logActivity(db, { transferId: tr.id, userId: tr.owner_id, event: 'transfer.created', detail: { name, size, replicas }, requestId: req.id });
    await dispatch('JOB_ASSIGNED', tr, req);
    return { tr, created: true };
  }

  const respond = (req, res, { tr, created }) => res.status(created ? 201 : 200).json(view(db, { ...tr, owner_name: req.user.username }, req.user.id));

  r.get('/', (req, res) => {
    const scope = req.query.scope === 'all' || req.user.role === 'admin' ? '' : 'WHERE t.owner_id = ? OR t.owner_id IS NULL';
    const rows = db.all(`SELECT t.*, u.username AS owner_name FROM transfers t LEFT JOIN users u ON u.id = t.owner_id ${scope} ORDER BY t.created_at DESC`, ...(scope ? [req.user.id] : []));
    res.json(rows.map((t) => view(db, t, req.user.id)));
  });

  r.get('/search', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const rows = db.all(`SELECT t.*, u.username AS owner_name FROM transfers t LEFT JOIN users u ON u.id = t.owner_id WHERE t.name LIKE ? OR t.info_hash LIKE ? ORDER BY t.created_at DESC LIMIT 50`, q, q);
    res.json(rows.map((t) => view(db, t, req.user.id)));
  });

  r.get('/engine/stats', (req, res) => res.json(fleetStats(db)));

  // magnet link (CI/CD entry point)
  r.post('/create', async (req, res, next) => {
    try {
      const magnetURI = req.body?.magnetURI || req.body?.magnet;
      if (!magnetURI) return res.status(400).json({ error: 'magnetURI is required' });
      let m;
      try { m = parseMagnet(magnetURI); } catch (e) { return res.status(400).json({ error: e.message }); }
      const originUrl = originFor(req, req.body?.originUrl);
      const magnet = toMagnet({ infoHash: m.infoHash, name: m.name, announce: [...m.announce, ...cfg.trackers], length: m.length }) + m.peers.map((p) => `&x.pe=${p}`).join('');
      respond(req, res, await register(req, { infoHash: m.infoHash, name: m.name || m.infoHash, magnet, size: m.length || 0, originUrl }));
    } catch (e) { next(e); }
  });

  // .torrent upload (raw body)
  r.post('/upload', raw({ type: () => true, limit: '10mb' }), async (req, res, next) => {
    try {
      if (!req.body?.length) return res.status(400).json({ error: 'Send the .torrent file as the request body' });
      let meta;
      try { meta = parseTorrent(req.body); } catch (e) { return res.status(400).json({ error: `Not a valid .torrent: ${e.message}` }); }
      const originUrl = originFor(req, req.query.originUrl);
      const magnet = toMagnet({ infoHash: meta.infoHash, name: meta.name, announce: [...meta.announce, ...cfg.trackers], length: meta.length });
      respond(req, res, await register(req, { infoHash: meta.infoHash, name: meta.name, magnet, torrent: meta.torrent, size: meta.length, pieces: meta.pieces.length, originUrl }));
    } catch (e) { next(e); }
  });

  // Share any file: the API stores it, hashes it, and a worker seeds it.
  r.post('/create-from-file', raw({ type: () => true, limit: cfg.maxUpload }), async (req, res, next) => {
    try {
      const filename = path.basename(decodeURIComponent(req.get('x-filename') || req.query.filename || '')).replace(/[\0/\\]/g, '_');
      if (!filename || filename === '.' || filename === '..') return res.status(400).json({ error: 'Missing file name (X-Filename header)' });
      if (!req.body?.length) return res.status(400).json({ error: 'Empty file' });
      const dir = path.join(cfg.uploadDir, uuid());
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, filename);
      await writeFile(file, req.body);
      const meta = await createTorrent(file, { announce: cfg.trackers, comment: `shared via Shoal by ${req.user.username}` });
      const magnet = toMagnet({ infoHash: meta.infoHash, name: meta.name, announce: meta.announce, length: meta.length });
      const result = await register(req, { infoHash: meta.infoHash, name: meta.name, magnet, torrent: meta.torrent, size: meta.length, pieces: meta.pieces.length, sourcePath: file });
      if (!result.created) await rm(dir, { recursive: true, force: true }); // same file shared again: keep the first copy only
      respond(req, res, result);
    } catch (e) { next(e); }
  });

  // Cold start from object storage: the API pulls the URL once (e.g. an S3 pre-signed URL), hashes it
  // and a worker seeds it. The URL is kept as the transfer's origin, so it stays a fallback source.
  r.post('/create-from-url', async (req, res, next) => {
    let dir;
    try {
      const url = originFor(req, req.body?.url);
      if (!url) return res.status(400).json({ error: 'url is required' });
      const fromUrl = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      const filename = path.basename(String(req.body?.name || fromUrl || 'artifact')).replace(/[\0/\\]/g, '_');
      if (!filename || filename === '.' || filename === '..') return res.status(400).json({ error: 'Give the artifact a name' });
      const upstream = await httpGet(url, { timeoutMs: 120_000 }).catch((e) => { throw Object.assign(new Error(`Could not reach the URL: ${e.code || e.message}`), { status: 502 }); });
      if (upstream.statusCode < 200 || upstream.statusCode > 299) { upstream.destroy(); return res.status(502).json({ error: `The URL answered HTTP ${upstream.statusCode}` }); }
      const cap = bytes(cfg.maxUpload);
      if (Number(upstream.headers['content-length']) > cap) { upstream.destroy(); return res.status(413).json({ error: `Larger than the ${cfg.maxUpload} limit` }); }
      dir = path.join(cfg.uploadDir, uuid());
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, filename);
      let seen = 0;
      const limit = new Transform({ transform(chunk, _enc, cb) { seen += chunk.length; cb(seen > cap ? Object.assign(new Error(`Larger than the ${cfg.maxUpload} limit`), { status: 413 }) : null, chunk); } });
      await pipeline(upstream, limit, createWriteStream(file));
      if (!seen) throw Object.assign(new Error('The URL returned an empty file'), { status: 400 });
      const meta = await createTorrent(file, { announce: cfg.trackers, comment: `pulled by Shoal for ${req.user.username}` });
      const magnet = toMagnet({ infoHash: meta.infoHash, name: meta.name, announce: meta.announce, length: meta.length });
      const result = await register(req, { infoHash: meta.infoHash, name: meta.name, magnet, torrent: meta.torrent, size: meta.length, pieces: meta.pieces.length, sourcePath: file, originUrl: url });
      if (!result.created) await rm(dir, { recursive: true, force: true }); // already known: keep the first copy only
      respond(req, res, result);
    } catch (e) {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      next(e);
    }
  });

  r.get('/:id', (req, res) => res.json(view(db, owned(req), req.user.id)));
  r.get('/:id/stats', (req, res) => res.json(view(db, owned(req), req.user.id, { detail: true }).detail));
  r.get('/:id/activity', (req, res) => {
    const tr = owned(req);
    res.json(db.all('SELECT id, event, node_id AS nodeId, detail, request_id AS requestId, at FROM activity WHERE transfer_id = ? ORDER BY id DESC LIMIT 200', tr.id)
      .map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null })));
  });
  r.get('/:id/torrent', (req, res) => {
    const tr = owned(req);
    if (!tr.torrent) return res.status(409).json({ error: 'Metadata not fetched yet' });
    res.set({ 'Content-Type': 'application/x-bittorrent', 'Content-Disposition': `attachment; filename="${encodeURIComponent(tr.name)}.torrent"` }).send(Buffer.from(tr.torrent));
  });

  const setDesired = (desired, type, verb) => async (req, res) => {
    const tr = owned(req);
    if (!canWrite(req, tr)) return res.status(403).json({ error: `Only the owner can ${verb} this transfer` });
    db.run('UPDATE transfers SET desired = ?, updated_at = ? WHERE id = ?', desired, now(), tr.id);
    logActivity(db, { transferId: tr.id, userId: req.user.id === 'service' ? null : req.user.id, event: `transfer.${verb}`, requestId: req.id });
    await dispatch(type, { ...tr, desired }, req);
    res.json(view(db, { ...tr, desired }, req.user.id));
  };
  r.post('/:id/start', setDesired('running', 'JOB_UPDATED', 'start'));
  r.post('/:id/resume', setDesired('running', 'JOB_UPDATED', 'resume'));
  r.post('/:id/pause', setDesired('paused', 'JOB_UPDATED', 'pause'));

  r.get('/:id/files', (req, res) => {
    const v = view(db, owned(req), req.user.id);
    const files = v.files.map((f) => ({ index: f.index, name: f.name, path: f.path, length: f.length, selected: f.selected, progress: f.progress }));
    res.json({ files, selectedCount: files.filter((f) => f.selected).length, totalCount: files.length });
  });
  r.post('/:id/files/select', async (req, res) => {
    const tr = owned(req);
    if (!canWrite(req, tr)) return res.status(403).json({ error: 'Only the owner can change file selection' });
    const v = view(db, tr, req.user.id);
    const all = req.body?.all === true;
    const idx = all ? v.files.map((f) => f.index) : (req.body?.fileIndices || []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < (v.files.length || Infinity));
    if (!idx.length) return res.status(400).json({ error: 'Select at least one file' });
    db.run('UPDATE transfers SET selected = ?, updated_at = ? WHERE id = ?', JSON.stringify(idx), now(), tr.id);
    await dispatch('JOB_UPDATED', tr, req);
    const files = v.files.map((f) => ({ ...f, selected: idx.includes(f.index) }));
    res.json({ files, selectedCount: idx.length, totalCount: files.length });
  });

  r.put('/:id', async (req, res) => {
    const tr = owned(req);
    if (!canWrite(req, tr)) return res.status(403).json({ error: 'Only the owner can edit this transfer' });
    const { name, replicas } = req.body || {};
    if (replicas !== undefined && !/^(all|[1-9]\d{0,2})$/.test(String(replicas))) return res.status(400).json({ error: 'replicas must be a number or "all"' });
    db.run('UPDATE transfers SET name = COALESCE(?, name), replicas = COALESCE(?, replicas), updated_at = ? WHERE id = ?', name?.trim() || null, replicas !== undefined ? String(replicas) : null, now(), tr.id);
    await dispatch('JOB_UPDATED', tr, req);
    res.json(view(db, owned(req), req.user.id));
  });

  r.delete('/:id', async (req, res) => {
    const tr = owned(req);
    if (!canWrite(req, tr)) return res.status(403).json({ error: 'Only the owner can delete this transfer' });
    const deleteFiles = req.query.deleteFiles === 'true' || req.body?.deleteFiles === true;
    db.run("UPDATE transfers SET desired = 'removed', updated_at = ? WHERE id = ?", now(), tr.id);
    // With no live placement nobody else will clean up, so do it here.
    const live = db.get("SELECT COUNT(*) AS n FROM placements p JOIN nodes n ON n.id = p.node_id WHERE p.transfer_id = ? AND n.status = 'up'", tr.id).n;
    if (!live) db.run('DELETE FROM transfers WHERE id = ?', tr.id);
    logActivity(db, { transferId: tr.id, userId: req.user.id === 'service' ? null : req.user.id, event: 'transfer.deleted', detail: { deleteFiles }, requestId: req.id });
    await dispatch('JOB_UPDATED', { ...tr, desired: 'removed' }, req, { deleteFiles });
    // A shared file is seeded straight from its upload folder; that copy is ours to remove too.
    const uploads = path.resolve(cfg.uploadDir) + path.sep;
    if (deleteFiles && tr.source_path && path.resolve(tr.source_path).startsWith(uploads)) {
      await rm(path.dirname(path.resolve(tr.source_path)), { recursive: true, force: true }).catch(() => {});
    }
    res.json({ message: deleteFiles ? 'Transfer and downloaded data deleted' : 'Transfer removed' });
  });

  return r;
}

/** GET /api/torrent/:id/download — stream a finished artifact (single file, or a tar of a folder). */
export function downloadRoute({ db }) {
  return async (req, res, next) => {
    try {
      const tr = db.get('SELECT * FROM transfers WHERE id = ? OR info_hash = ?', req.params.id, String(req.params.id).toLowerCase());
      if (!tr) return res.status(404).json({ error: 'Transfer not found' });
      // Any placement holding a complete copy will do, including paused ones.
      const pl = db.get("SELECT data_path FROM placements WHERE transfer_id = ? AND progress >= 100 AND data_path IS NOT NULL AND state != 'lost' ORDER BY updated_at DESC LIMIT 1", tr.id);
      const p = pl?.data_path || tr.source_path;
      if (!p) return res.status(409).json({ error: 'Not downloaded yet' });
      const st = await stat(p).catch(() => null);
      if (!st) return res.status(410).json({ error: 'Data is no longer on disk' });
      const name = path.basename(p);
      if (st.isFile()) {
        res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
        return createReadStream(p).pipe(res);
      }
      res.set({ 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.tar` });
      await tarStream(p, res);
    } catch (e) { next(e); }
  };
}

export function fleetStats(db) {
  const nodes = db.all("SELECT * FROM nodes WHERE status = 'up'");
  const agg = { totalDownloadSpeed: 0, totalUploadSpeed: 0, activeTorrents: 0, totalTorrents: 0, totalDownloaded: 0, totalUploaded: 0, peers: 0, queued: 0 };
  for (const n of nodes) {
    const s = n.stats ? JSON.parse(n.stats) : {};
    for (const k of Object.keys(agg)) agg[k] += s[k] || 0;
  }
  return { ...agg, workers: nodes.length };
}

/** "2gb" / "500mb" / "1048576" → bytes */
function bytes(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i.exec(String(v).trim());
  if (!m) return 2 * 1024 ** 3;
  return Math.floor(Number(m[1]) * 1024 ** ['b', 'kb', 'mb', 'gb', 'tb'].indexOf((m[2] || 'b').toLowerCase()));
}
