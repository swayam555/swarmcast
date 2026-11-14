#!/usr/bin/env node
// Entry point. SWARMCAST_ROLE = all (API + embedded worker, default) | api | worker.
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { openDb, now } from './store/db.js';
import { createBus } from './cluster/bus.js';
import { createLeases } from './cluster/leases.js';
import { Worker } from './cluster/worker.js';
import { Metrics } from './obs/metrics.js';
import { createApp } from './api/app.js';
import { verifyJwt } from './api/auth.js';
import { view, fleetStats } from './api/transfers.js';
import { SpeedHistory } from './engine/rate.js';

const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || env.SWARMCAST_DATA_DIR || 'data');
  const port = Number(env.PORT || 3029);
  const publicUrl = env.SWARMCAST_PUBLIC_URL || `http://localhost:${port}`;
  const cfg = {
    role: env.SWARMCAST_ROLE || 'all',
    port, publicUrl, dataDir,
    dbFile: env.SWARMCAST_DB || path.join(dataDir, 'swarmcast.db'),
    uploadDir: env.SWARMCAST_UPLOAD_DIR || path.join(dataDir, 'uploads'),
    maxUpload: env.SWARMCAST_MAX_UPLOAD || '2gb',
    jwtSecret: env.JWT_SECRET || 'dev-only-change-me',
    serviceToken: env.SWARMCAST_SERVICE_TOKEN || null,
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || null,
    consoleUrl: env.SWARMCAST_CONSOLE_URL || 'http://localhost:5173',
    corsOrigins: list(env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'),
    busDriver: env.SWARMCAST_BUS || 'sqlite', kafkaBrokers: env.KAFKA_BROKERS,
    leaseDriver: env.SWARMCAST_LEASES || 'sqlite', redisUrl: env.REDIS_URL,
    peerPort: Number(env.SWARMCAST_PEER_PORT ?? 6881),
    dhtPort: Number(env.SWARMCAST_DHT_PORT ?? 6881),
    dht: env.SWARMCAST_DHT !== 'off',
    dhtBootstrap: list(env.SWARMCAST_DHT_BOOTSTRAP),
    trackerInterval: Number(env.SWARMCAST_TRACKER_INTERVAL || 30),
    logRequests: env.SWARMCAST_LOG_REQUESTS !== 'off',
    ...overrides,
  };
  // The control plane's own /announce tracker is always offered to swarms it creates.
  cfg.trackers = overrides.trackers || [...new Set([`${publicUrl}/announce`, ...list(env.SWARMCAST_TRACKERS)])];
  if (cfg.jwtSecret === 'dev-only-change-me' && env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  return cfg;
}

export async function startSwarmcast(overrides = {}) {
  const cfg = loadConfig(overrides);
  const db = openDb(cfg.dbFile);
  const metrics = new Metrics();
  const bus = createBus({ driver: cfg.busDriver, db, brokers: cfg.kafkaBrokers });
  const leases = createLeases({ driver: cfg.leaseDriver, db, redisUrl: cfg.redisUrl });
  const out = { cfg, db, metrics, bus, leases };

  if (cfg.role === 'all' || cfg.role === 'worker') {
    out.worker = await new Worker({
      db, bus, leases, metrics, dataDir: path.join(cfg.dataDir, 'worker'), nodeId: overrides.nodeId || env.SWARMCAST_NODE_ID,
      peerPort: cfg.peerPort, dhtPort: cfg.dhtPort, dht: cfg.dht, dhtBootstrap: cfg.dhtBootstrap, trackers: cfg.trackers,
    }).start();
  }

  if (cfg.role === 'all' || cfg.role === 'api') {
    const app = createApp({ cfg, db, bus, metrics, leases });
    const history = new SpeedHistory();
    app.locals.history = history;
    const server = http.createServer(app);
    attachSockets(server, { cfg, db, history, metrics, bus });
    const sweeper = setInterval(() => sweep(db, leases), 5000); sweeper.unref();
    metrics.collect((m) => {
      const states = db.all('SELECT state, COUNT(*) AS n FROM placements GROUP BY state');
      for (const s of ['downloading', 'seeding', 'paused', 'queued', 'checking', 'error', 'fetching_metadata']) m.set('swarmcast_transfers', states.find((x) => x.state === s)?.n || 0, { state: s });
      const f = fleetStats(db);
      m.set('swarmcast_active_workers', f.workers); m.set('swarmcast_download_speed_bytes', f.totalDownloadSpeed); m.set('swarmcast_upload_speed_bytes', f.totalUploadSpeed);
      m.set('swarmcast_queue_lag_seconds', bus.lag() / 1000);
    });
    await new Promise((r) => server.listen(cfg.port, r));
    out.server = server; out.app = app;
    console.log(JSON.stringify({ level: 'info', msg: `Swarmcast control plane on :${server.address().port}`, role: cfg.role, bus: bus.kind, leases: leases.kind }));
  }

  out.stop = async () => {
    await out.worker?.stop();
    await new Promise((r) => (out.server ? out.server.close(() => r()) : r()));
    out.wss?.close();
    await bus.close(); await leases.close(); db.close();
  };
  return out;
}

/** Workers that miss heartbeats are marked down; their placements stop counting as live. */
function sweep(db, leases) {
  const cutoff = new Date(Date.now() - 20_000).toISOString();
  const dead = db.all("SELECT id FROM nodes WHERE status = 'up' AND heartbeat_at < ?", cutoff);
  for (const n of dead) {
    db.run("UPDATE nodes SET status = 'down' WHERE id = ?", n.id);
    db.run("UPDATE placements SET state = 'lost', download_speed = 0, upload_speed = 0, peers = 0, updated_at = ? WHERE node_id = ? AND state != 'lost'", now(), n.id);
    db.run("INSERT INTO activity(node_id, event, at) VALUES (?, 'node.down', ?)", n.id, now());
  }
  db.run("DELETE FROM placements WHERE state = 'lost' AND node_id IN (SELECT id FROM nodes WHERE status = 'down' AND heartbeat_at < ?)", new Date(Date.now() - 3600_000).toISOString());
  leases.sweep().catch(() => {});
}

/**
 * WebSocket at /ws?token=… . Each second every client gets its transfer list and
 * fleet stats; clients may also {subscribe: transferId} for piece-level detail.
 */
function attachSockets(server, { cfg, db, history, metrics }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    const p = verifyJwt(token, cfg.jwtSecret);
    const user = p && db.get('SELECT * FROM users WHERE id = ?', p.sub);
    if (!user) { ws.close(4401, 'unauthorized'); return; }
    ws.user = user; ws.subs = new Set();
    ws.on('message', (m) => {
      try {
        const msg = JSON.parse(m);
        if (msg.subscribe) { ws.subs.add(msg.subscribe); ws.send(JSON.stringify({ type: 'subscribed', id: msg.subscribe })); }
        if (msg.unsubscribe) { ws.subs.delete(msg.unsubscribe); ws.send(JSON.stringify({ type: 'unsubscribed', id: msg.unsubscribe })); }
        if (msg.ping) ws.send(JSON.stringify({ type: 'pong', t: msg.ping }));
      } catch { /* ignore junk */ }
    });
    ws.send(JSON.stringify({ type: 'connected', user: { id: user.id, username: user.username } }));
  });

  let lastActivity = db.get('SELECT COALESCE(MAX(id),0) AS n FROM activity').n;
  const tick = setInterval(() => {
    const f = fleetStats(db);
    history.push(f.totalDownloadSpeed, f.totalUploadSpeed);
    metrics.set('swarmcast_ws_clients', wss.clients.size);
    const events = db.all('SELECT a.id, a.event, a.transfer_id AS transferId, a.node_id AS nodeId, a.detail, a.at, t.name, t.owner_id FROM activity a LEFT JOIN transfers t ON t.id = a.transfer_id WHERE a.id > ? ORDER BY a.id LIMIT 100', lastActivity);
    if (events.length) lastActivity = events[events.length - 1].id;
    if (!wss.clients.size) return;
    const all = db.all("SELECT t.*, u.username AS owner_name FROM transfers t LEFT JOIN users u ON u.id = t.owner_id WHERE t.desired != 'removed' ORDER BY t.created_at DESC");
    for (const ws of wss.clients) {
      if (ws.readyState !== 1 || !ws.user) continue;
      const mine = all.filter((t) => ws.user.role === 'admin' || !t.owner_id || t.owner_id === ws.user.id);
      ws.send(JSON.stringify({ type: 'torrents', torrents: mine.map((t) => view(db, t, ws.user.id)), stats: f, sample: history.list[history.list.length - 1] }));
      for (const id of ws.subs) {
        const t = all.find((x) => x.id === id);
        if (t) ws.send(JSON.stringify({ type: 'detail', id, detail: view(db, t, ws.user.id, { detail: true }).detail }));
      }
      for (const e of events) {
        if (ws.user.role !== 'admin' && e.owner_id && e.owner_id !== ws.user.id) continue;
        ws.send(JSON.stringify({ type: 'event', event: { id: e.id, event: e.event, transferId: e.transferId, nodeId: e.nodeId, name: e.name, at: e.at, detail: e.detail ? JSON.parse(e.detail) : null } }));
      }
    }
  }, 1000);
  tick.unref();
  wss.on('close', () => clearInterval(tick));
  return wss;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/server.js')) {
  const s = await startSwarmcast();
  const shutdown = async () => { await s.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
