// Accounts: email/password (scrypt) and Google sign-in, issuing HS256 JWTs.
import { createHmac, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { now, uuid, logActivity } from '../store/db.js';

const b64u = (b) => Buffer.from(b).toString('base64url');

export function signJwt(payload, secret, ttlSec = 7 * 24 * 3600) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat, exp: iat + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expect = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (head.alg !== 'HS256') return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (p.exp && p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const got = scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export const publicUser = (u) => u && ({ _id: u.id, id: u.id, username: u.username, email: u.email, role: u.role, createdAt: u.created_at, updatedAt: u.updated_at, google: Boolean(u.google_sub) });

/** Bearer token or ?token= (for <a download> links and WebSocket upgrades). */
export function requireAuth(cfg, db) {
  return (req, res, next) => {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    // Service tokens let CI pipelines call the API without a user session.
    if (cfg.serviceToken && token === cfg.serviceToken) { req.user = { id: 'service', role: 'admin', username: 'ci' }; return next(); }
    const p = verifyJwt(token, cfg.jwtSecret);
    if (!p) return res.status(401).json({ error: 'Not authenticated' });
    const u = db.get('SELECT * FROM users WHERE id = ?', p.sub);
    if (!u) return res.status(401).json({ error: 'Account no longer exists' });
    req.user = u;
    next();
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function authRoutes(cfg, db) {
  const r = Router();
  const issue = (u) => ({ token: signJwt({ sub: u.id, role: u.role }, cfg.jwtSecret), user: { id: u.id, username: u.username, email: u.email } });

  r.post('/register', (req, res) => {
    const { username, email, password } = req.body || {};
    const errors = [];
    if (!username || String(username).trim().length < 3) errors.push('Username must be at least 3 characters');
    if (!email || !EMAIL.test(email)) errors.push('A valid email is required');
    if (!password || String(password).length < 8) errors.push('Password must be at least 8 characters');
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    if (db.get('SELECT 1 FROM users WHERE email = ?', email.toLowerCase())) return res.status(409).json({ error: 'An account with this email already exists' });
    const first = !db.get('SELECT 1 FROM users LIMIT 1');
    const u = { id: uuid(), username: String(username).trim(), email: email.toLowerCase(), role: first ? 'admin' : 'user', created_at: now(), updated_at: now() };
    db.run('INSERT INTO users(id, username, email, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', u.id, u.username, u.email, hashPassword(password), u.role, u.created_at, u.updated_at);
    logActivity(db, { userId: u.id, event: 'user.registered' });
    res.status(201).json({ ...issue(u), message: 'Account created' });
  });

  r.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const u = email && db.get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
    if (!u || !u.password_hash || !checkPassword(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Invalid email or password' });
    logActivity(db, { userId: u.id, event: 'user.login' });
    res.json(issue(u));
  });

  // ---- Google: ID-token flow (Google Identity Services button) ----
  r.post('/google', async (req, res) => {
    if (!cfg.googleClientId) return res.status(501).json({ error: 'Google sign-in is not configured (set GOOGLE_CLIENT_ID)' });
    try {
      const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(req.body?.credential || '')}`, { signal: AbortSignal.timeout(8000) });
      const info = await resp.json();
      if (!resp.ok || info.aud !== cfg.googleClientId || info.email_verified !== 'true') return res.status(401).json({ error: 'Google token rejected' });
      res.json(issue(upsertGoogle(db, info)));
    } catch (e) { res.status(502).json({ error: `Could not verify Google token: ${e.message}` }); }
  });

  // ---- Google: server-side authorization-code flow ----
  r.get('/google/redirect', (req, res) => {
    if (!cfg.googleClientId || !cfg.googleClientSecret) return res.status(501).json({ error: 'Google OAuth is not configured' });
    const state = signJwt({ n: randomBytes(8).toString('hex') }, cfg.jwtSecret, 600);
    const q = new URLSearchParams({ client_id: cfg.googleClientId, redirect_uri: `${cfg.publicUrl}/api/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  });

  r.get('/google/callback', async (req, res) => {
    const fail = (m) => res.redirect(`${cfg.consoleUrl}/#/login?error=${encodeURIComponent(m)}`);
    if (!verifyJwt(req.query.state, cfg.jwtSecret)) return fail('Sign-in expired, try again');
    try {
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: req.query.code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: `${cfg.publicUrl}/api/auth/google/callback`, grant_type: 'authorization_code' }),
      }).then((x) => x.json());
      const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tok.id_token}`).then((x) => x.json());
      if (info.aud !== cfg.googleClientId) return fail('Google token rejected');
      const { token } = issue(upsertGoogle(db, info));
      res.redirect(`${cfg.consoleUrl}/#/auth?token=${token}`);
    } catch (e) { fail(e.message); }
  });

  r.get('/config', (req, res) => res.json({ googleClientId: cfg.googleClientId || null }));
  return r;
}

function upsertGoogle(db, info) {
  let u = db.get('SELECT * FROM users WHERE google_sub = ? OR email = ?', info.sub, info.email.toLowerCase());
  if (u) {
    if (!u.google_sub) db.run('UPDATE users SET google_sub = ?, updated_at = ? WHERE id = ?', info.sub, now(), u.id);
    return u;
  }
  u = { id: uuid(), username: info.name || info.email.split('@')[0], email: info.email.toLowerCase(), role: 'user', created_at: now(), updated_at: now() };
  db.run('INSERT INTO users(id, username, email, google_sub, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', u.id, u.username, u.email, info.sub, u.role, u.created_at, u.updated_at);
  logActivity(db, { userId: u.id, event: 'user.registered', detail: { via: 'google' } });
  return u;
}

export function userRoutes(cfg, db) {
  const r = Router();
  r.get('/profile', (req, res) => res.json(publicUser(req.user)));
  r.put('/profile', (req, res) => {
    const { username, email } = req.body || {};
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (email && db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', email.toLowerCase(), req.user.id)) return res.status(409).json({ error: 'Email already in use' });
    if (username !== undefined && String(username).trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    db.run('UPDATE users SET username = COALESCE(?, username), email = COALESCE(?, email), updated_at = ? WHERE id = ?', username?.trim() || null, email?.toLowerCase() || null, now(), req.user.id);
    res.json(publicUser(db.get('SELECT * FROM users WHERE id = ?', req.user.id)));
  });
  r.put('/password', (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (req.user.password_hash && !checkPassword(String(currentPassword || ''), req.user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
    if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(newPassword), now(), req.user.id);
    res.json({ message: 'Password updated' });
  });
  r.get('/history', (req, res) => {
    const rows = db.all(`SELECT a.id, a.event, a.detail, a.at, a.transfer_id, a.node_id, t.name FROM activity a LEFT JOIN transfers t ON t.id = a.transfer_id
      WHERE a.user_id = ? OR a.transfer_id IN (SELECT id FROM transfers WHERE owner_id = ?) ORDER BY a.id DESC LIMIT 100`, req.user.id, req.user.id);
    res.json(rows.map((r2) => ({ ...r2, detail: r2.detail ? JSON.parse(r2.detail) : null })));
  });
  return r;
}
