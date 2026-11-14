// HTTP origin ("web seed", BEP 19 style): when no peer can supply a piece, read its bytes straight
// from an HTTP(S) URL with Range requests. Works with S3/GCS pre-signed URLs, MinIO, nginx, etc.
//
// Single-file torrents: the URL is the file itself.
// Multi-file torrents:  the URL is the folder that holds the torrent's files, so file
//                       "<name>/a/b.bin" is fetched from "<url>/a/b.bin".

import http from 'node:http';
import https from 'node:https';

const TIMEOUT_MS = 60_000;

/**
 * GET a URL with node:http(s), following up to 5 redirects. Resolves with the response stream.
 * (Not fetch(): undici can crash the process when a server closes mid-stream under backpressure.)
 */
export function httpGet(url, { headers = {}, timeoutMs = TIMEOUT_MS, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error('only http and https URLs are supported'));
    const req = lib.get(u, { headers: { 'user-agent': 'swarmcast', ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        return httpGet(next, { headers, timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
      }
      res.setTimeout(timeoutMs, () => res.destroy(new Error('origin stopped sending data')));
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('origin did not answer in time')));
    req.on('error', reject);
  });
}

async function readAll(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The URLs and byte ranges that together make up [start, start + length) of the torrent's data. */
export function rangesFor(meta, url, start, length) {
  const end = start + length;
  const multi = meta.files.length > 1 || meta.files[0].path !== meta.name;
  const base = url.replace(/\/+$/, '');
  const out = [];
  for (const f of meta.files) {
    const fEnd = f.offset + f.length;
    if (fEnd <= start || f.offset >= end || !f.length) continue;
    const from = Math.max(start, f.offset) - f.offset;
    const to = Math.min(end, fEnd) - f.offset; // exclusive
    // f.path is "<name>/<sub>/<file>" for multi-file torrents
    const rel = f.path.split(/[\\/]/).slice(1).map(encodeURIComponent).join('/');
    out.push({ url: multi ? `${base}/${rel}` : url, from, to });
  }
  return out;
}

async function fetchRange({ url, from, to }) {
  const res = await httpGet(url, { headers: { range: `bytes=${from}-${to - 1}` } });
  if (res.statusCode !== 206) {
    res.destroy();
    if (res.statusCode === 200) throw new Error('origin ignores Range requests');
    throw new Error(`origin answered HTTP ${res.statusCode}`);
  }
  const buf = await readAll(res);
  if (buf.length !== to - from) throw new Error(`origin sent ${buf.length} bytes, expected ${to - from}`);
  return buf;
}

/** Read bytes [start, start + length) of the torrent's data from the origin. */
export async function readFromOrigin(meta, url, start, length) {
  const parts = [];
  for (const r of rangesFor(meta, url, start, length)) parts.push(await fetchRange(r));
  return Buffer.concat(parts);
}

/** Only plain http(s) URLs, without credentials in them, are accepted as origins. */
export function checkOriginUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  let u;
  try { u = new URL(String(value)); } catch { throw Object.assign(new Error('originUrl is not a valid URL'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('originUrl must be http or https'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Put credentials in a pre-signed URL, not in user:password@'), { status: 400 });
  if (String(value).length > 4096) throw Object.assign(new Error('originUrl is too long'), { status: 400 });
  return u.toString();
}
