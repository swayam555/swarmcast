// SQLite (node:sqlite) is the source of truth for users, transfers, placements
// (which worker holds which transfer), leases, directives and settings.
// WAL mode lets the API and several worker processes share one file on a host.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT, google_sub TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY, info_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  magnet TEXT NOT NULL, torrent BLOB, size INTEGER NOT NULL DEFAULT 0,
  piece_count INTEGER NOT NULL DEFAULT 0, source_path TEXT,
  desired TEXT NOT NULL DEFAULT 'running',       -- running | paused | removed
  replicas TEXT NOT NULL DEFAULT '1',             -- '1'..'n' or 'all'
  selected TEXT,                                  -- JSON array of file indices or NULL = all
  owner_id TEXT REFERENCES users(id), request_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS placements (
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', error TEXT,
  progress REAL NOT NULL DEFAULT 0, have_bytes INTEGER NOT NULL DEFAULT 0,
  downloaded INTEGER NOT NULL DEFAULT 0, uploaded INTEGER NOT NULL DEFAULT 0,
  download_speed INTEGER NOT NULL DEFAULT 0, upload_speed INTEGER NOT NULL DEFAULT 0,
  peers INTEGER NOT NULL DEFAULT 0, seeds INTEGER NOT NULL DEFAULT 0, leeches INTEGER NOT NULL DEFAULT 0,
  eta INTEGER NOT NULL DEFAULT -1, completed_pieces INTEGER NOT NULL DEFAULT 0, dedup_bytes INTEGER NOT NULL DEFAULT 0,
  bitfield TEXT, data_path TEXT, fence INTEGER NOT NULL DEFAULT 0,
  detail TEXT, updated_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY (transfer_id, node_id)
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, peer_port INTEGER NOT NULL, dht_port INTEGER,
  status TEXT NOT NULL DEFAULT 'up', capacity INTEGER NOT NULL DEFAULT 5,
  stats TEXT, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  key TEXT PRIMARY KEY, holder TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fence_counter (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS directives (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL,
  request_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id TEXT, user_id TEXT, node_id TEXT,
  event TEXT NOT NULL, detail TEXT, request_id TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, user_id TEXT,
  status INTEGER, body TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity_transfer ON activity(transfer_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id, id);
CREATE INDEX IF NOT EXISTS idx_placements_node ON placements(node_id);
`;

export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    raw: db,
    get: (sql, ...p) => prep(sql).get(...p),
    all: (sql, ...p) => prep(sql).all(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}

// ------------------------------------------------------------------ settings
const DEFAULTS = { maxActiveTorrents: 5, speedLimits: { download: 0, upload: 0 } };
export function getSettings(db) {
  const out = structuredClone(DEFAULTS);
  for (const r of db.all('SELECT key, value FROM settings')) out[r.key] = JSON.parse(r.value);
  return out;
}
export function putSetting(db, key, value) {
  db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export function logActivity(db, { transferId = null, userId = null, nodeId = null, event, detail = null, requestId = null }) {
  db.run('INSERT INTO activity(transfer_id, user_id, node_id, event, detail, request_id, at) VALUES (?,?,?,?,?,?,?)',
    transferId, userId, nodeId, event, detail ? JSON.stringify(detail) : null, requestId, now());
}
