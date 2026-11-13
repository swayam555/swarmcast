// Control-plane HTTP app: middleware chain, routes, error handling.
import express, { Router } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { authRoutes, userRoutes, requireAuth } from './auth.js';
import { transferRoutes, downloadRoute, fleetStats, view } from './transfers.js';
import { httpMetrics } from '../obs/metrics.js';
import { tracing } from '../obs/tracing.js';
import { TrackerServer, trackerMiddleware } from '../engine/tracker.js';
import { getSettings, putSetting, logActivity } from '../store/db.js';

/** X-Request-ID: accept the caller's (CI retries reuse it) or mint one; echo it back. */
function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-ID', req.id);
    next();
  };
}

/**
 * Idempotency for mutating calls: the first response for (X-Request-ID, method, path, user)
 * is stored for 24h; a retry with the same ID gets the stored response instead of
 * repeating the side effect. Only applies when the client supplied the ID.
 */
function idempotency(db, metrics) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method) || !req.get('x-request-id')) return next();
    const key = `${req.user?.id || 'anon'}:${req.id}`;
    db.run('DELETE FROM idempotency WHERE created_at < ?', Date.now() - 24 * 3600_000);
    const hit = db.get('SELECT * FROM idempotency WHERE key = ?', key);
    if (hit) {
      if (hit.method !== req.method || hit.path !== req.originalUrl.split('?')[0]) {
        return res.status(422).json({ error: 'X-Request-ID was already used for a different request' });
      }
      if (hit.status == null) return res.status(409).json({ error: 'A request with this X-Request-ID is still in progress' });
      metrics.inc('shoal_idempotent_replays_total');
      res.set('Idempotent-Replay', 'true');
      return res.status(hit.status).type('application/json').send(hit.body);
    }
    db.run('INSERT INTO idempotency(key, method, path, user_id, created_at) VALUES (?,?,?,?,?)', key, req.method, req.originalUrl.split('?')[0], req.user?.id || null, Date.now());
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 500) db.run('UPDATE idempotency SET status = ?, body = ? WHERE key = ?', res.statusCode, JSON.stringify(body), key);
      else db.run('DELETE FROM idempotency WHERE key = ?', key);
      return json(body);
    };
    next();
  };
}

export function createApp({ cfg, db, bus, metrics, leases, started = Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const tracker = new TrackerServer({ interval: cfg.trackerInterval });
  app.locals.tracker = tracker;

  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin))) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-ID, X-Filename, traceparent', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'X-Request-ID, Idempotent-Replay, traceparent' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(requestId());
  app.use(tracing());
  app.use(httpMetrics(metrics));
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => { if (!req.path.startsWith('/announce') && cfg.logRequests) console.log(JSON.stringify({ level: 'info', msg: 'http', method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - t, requestId: req.id, traceId: req.span?.traceId })); });
    next();
  });

  // ---- unauthenticated
  app.get('/announce', trackerMiddleware(tracker));
  app.get(['/metrics', '/api/metrics'], async (req, res) => res.type('text/plain; version=0.0.4').send(await metrics.render()));
  const health = Router();
  health.get('/health', (req, res) => res.json({ status: 'ok', uptime: Math.round((Date.now() - started) / 1000), timestamp: new Date().toISOString() }));
  health.get('/ready', async (req, res) => {
    const checks = {};
    try { db.get('SELECT 1'); checks.database = 'ok'; } catch (e) { checks.database = e.message; }
    try { await leases.holder('readiness-probe'); checks.leases = 'ok'; } catch (e) { checks.leases = e.message; }
    checks.bus = bus.kind;
    const workers = db.get("SELECT COUNT(*) AS n FROM nodes WHERE status = 'up'").n;
    checks.workers = workers;
    const ok = checks.database === 'ok' && checks.leases === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
  });
  health.get('/startup', (req, res) => res.json({ status: 'started', startedAt: new Date(started).toISOString() }));
  app.use('/api', health);

  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes(cfg, db));

  // ---- authenticated
  const auth = requireAuth(cfg, db);
  app.get('/api/torrent/:id/download', auth, downloadRoute({ db }));
  app.use('/api/user', auth, userRoutes(cfg, db));
  app.use('/api/torrent', auth, idempotency(db, metrics), transferRoutes({ cfg, db, bus, metrics }));

  const stats = Router();
  stats.get('/', (req, res) => res.json(globalStats(db, tracker)));
  stats.get('/global', (req, res) => res.json(globalStats(db, tracker)));
  stats.get('/engine', (req, res) => res.json(fleetStats(db)));
  stats.get('/speed-history', (req, res) => res.json(app.locals.history.toJSON()));
  stats.get('/dht', (req, res) => res.json(dhtStatus(db)));
  stats.get('/nodes', (req, res) => res.json(db.all('SELECT * FROM nodes ORDER BY started_at DESC').map((n) => ({ ...n, stats: n.stats ? JSON.parse(n.stats) : null }))));
  stats.get('/user', (req, res) => {
    const list = db.all('SELECT * FROM transfers WHERE owner_id = ?', req.user.id).map((t) => view(db, t, req.user.id));
    const byStatus = { pending: 0, downloading: 0, seeding: 0, paused: 0, completed: 0, error: 0, queued: 0, checking: 0, fetching_metadata: 0 };
    for (const t of list) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    res.json({
      totalTorrents: list.length, byStatus, totalSize: list.reduce((n, t) => n + t.size, 0), totalDownloaded: list.reduce((n, t) => n + t.downloaded, 0),
      live: { activeTorrents: list.filter((t) => ['downloading', 'seeding'].includes(t.status)).length, totalDownloadSpeed: list.reduce((n, t) => n + t.downloadSpeed, 0), totalUploadSpeed: list.reduce((n, t) => n + t.uploadSpeed, 0) },
      timestamp: new Date().toISOString(),
    });
  });
  stats.get('/activity', (req, res) => res.json(db.all(`SELECT a.id, a.event, a.detail, a.at, a.node_id AS nodeId, a.request_id AS requestId, t.name FROM activity a LEFT JOIN transfers t ON t.id = a.transfer_id ORDER BY a.id DESC LIMIT ?`, Math.min(500, Number(req.query.limit) || 50)).map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null }))));
  app.use('/api/statistics', auth, stats);

  const settings = Router();
  const settingsView = () => {
    const s = getSettings(db);
    return { downloadPath: cfg.dataDir, maxActiveTorrents: s.maxActiveTorrents, maxConcurrent: s.maxActiveTorrents, port: cfg.peerPort, dht: dhtStatus(db), speedLimits: s.speedLimits, trackers: cfg.trackers, bus: bus.kind, leases: leases.kind };
  };
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only admins can change fleet settings' }));
  settings.get('/', (req, res) => res.json(settingsView()));
  settings.put('/', adminOnly, async (req, res) => {
    const { maxActiveTorrents, maxConcurrent, speedLimits } = req.body || {};
    const n = maxActiveTorrents ?? maxConcurrent;
    if (n !== undefined) {
      if (!Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 100) return res.status(400).json({ error: 'maxActiveTorrents must be between 1 and 100' });
      putSetting(db, 'maxActiveTorrents', Number(n));
    }
    if (speedLimits) { const e = validLimits(speedLimits); if (e) return res.status(400).json({ error: e }); putSetting(db, 'speedLimits', { download: Number(speedLimits.download) || 0, upload: Number(speedLimits.upload) || 0 }); }
    await bus.publish('SETTINGS_CHANGED', {}, { requestId: req.id });
    logActivity(db, { userId: req.user.id, event: 'settings.updated', detail: req.body, requestId: req.id });
    res.json({ message: 'Settings saved', settings: settingsView() });
  });
  settings.post('/speed-limits', adminOnly, async (req, res) => {
    const e = validLimits(req.body || {}); if (e) return res.status(400).json({ error: e });
    const limits = { download: Number(req.body.download) || 0, upload: Number(req.body.upload) || 0 };
    putSetting(db, 'speedLimits', limits);
    await bus.publish('SETTINGS_CHANGED', {}, { requestId: req.id });
    res.json({ message: 'Speed limits applied', speedLimits: limits });
  });
  settings.get('/dht', (req, res) => res.json(dhtStatus(db)));
  app.use('/api/settings', auth, settings);

  // Serve the built console from the same origin when it exists (single-service deploys).
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../console/dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|ws|announce|metrics).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (req, res) => res.json({ name: 'Shoal control plane', docs: '/api/health', console: cfg.consoleUrl }));
  }

  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(JSON.stringify({ level: 'error', msg: err.message, stack: err.stack, requestId: req.id }));
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message, requestId: req.id });
  });
  return app;
}

function validLimits({ download, upload }) {
  for (const [k, v] of Object.entries({ download, upload })) {
    if (v === undefined) continue;
    if (!Number.isFinite(Number(v)) || Number(v) < 0) return `${k} limit must be a non-negative number of bytes/s (0 = unlimited)`;
  }
  return null;
}

function dhtStatus(db) {
  const nodes = db.all("SELECT stats FROM nodes WHERE status = 'up'").map((n) => (n.stats ? JSON.parse(n.stats).dht : null)).filter(Boolean);
  if (!nodes.length) return { enabled: false, running: false, nodes: 0 };
  return { enabled: true, running: nodes.some((d) => d.running), nodes: nodes.reduce((n, d) => n + (d.nodes || 0), 0), port: nodes[0].port, nodeId: nodes[0].nodeId, workers: nodes.length };
}

function globalStats(db, tracker) {
  return {
    database: {
      totalTorrents: db.get("SELECT COUNT(*) AS n FROM transfers WHERE desired != 'removed'").n,
      totalUsers: db.get('SELECT COUNT(*) AS n FROM users').n,
      activeTorrents: db.get("SELECT COUNT(DISTINCT transfer_id) AS n FROM placements WHERE state IN ('downloading','seeding','checking','fetching_metadata')").n,
    },
    engine: fleetStats(db),
    dht: dhtStatus(db),
    tracker: tracker.stats(),
    cas: db.all("SELECT stats FROM nodes WHERE status = 'up'").length ? { dedupBytes: db.get('SELECT COALESCE(SUM(dedup_bytes),0) AS n FROM placements').n } : { dedupBytes: 0 },
    timestamp: new Date().toISOString(),
  };
}
