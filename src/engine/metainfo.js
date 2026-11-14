// Torrent metainfo: build from local files, parse .torrent buffers, and
// translate to/from magnet URIs. Single- and multi-file layouts (BEP 3).
import { createHash } from 'node:crypto';
import { open, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { encode, decode, text } from './bencode.js';

export const sha1 = (b) => createHash('sha1').update(b).digest();

/** Pick a piece length so a torrent has roughly 1–2k pieces, clamped 16 KiB … 16 MiB. */
export function choosePieceLength(totalBytes) {
  let len = 16 * 1024;
  while (len < 16 * 1024 * 1024 && totalBytes / len > 1500) len *= 2;
  return len;
}

async function walk(root) {
  const st = await stat(root);
  if (st.isFile()) return [{ abs: root, rel: [path.basename(root)], length: st.size }];
  const out = [];
  const visit = async (dir, rel) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await visit(abs, [...rel, e.name]);
      else if (e.isFile()) out.push({ abs, rel: [...rel, e.name], length: (await stat(abs)).size });
    }
  };
  await visit(root, []);
  return out;
}

/**
 * Hash a file or directory into a metainfo object.
 * Returns { torrent (Buffer), info, infoHash (hex), files, pieceLength, length }.
 */
export async function createTorrent(srcPath, { announce = [], name, pieceLength, comment, createdBy = 'swarmcast/0.1', isPrivate = false } = {}) {
  const files = await walk(srcPath);
  if (!files.length) throw new Error('nothing to share: no files found');
  const total = files.reduce((n, f) => n + f.length, 0);
  const plen = pieceLength || choosePieceLength(total);
  const hashes = [];
  let carry = Buffer.alloc(0);

  for (const f of files) {
    const fh = await open(f.abs, 'r');
    try {
      const chunk = Buffer.alloc(Math.max(plen, 1 << 20));
      let off = 0;
      while (off < f.length) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, off);
        if (!bytesRead) break;
        off += bytesRead;
        carry = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        while (carry.length >= plen) {
          hashes.push(sha1(carry.subarray(0, plen)));
          carry = carry.subarray(plen);
        }
      }
    } finally { await fh.close(); }
  }
  if (carry.length || total === 0) hashes.push(sha1(carry));

  const isDir = (await stat(srcPath)).isDirectory();
  const info = {
    name: name || path.basename(path.resolve(srcPath)),
    'piece length': plen,
    pieces: Buffer.concat(hashes),
    ...(isPrivate ? { private: 1 } : {}),
  };
  if (isDir) info.files = files.map((f) => ({ length: f.length, path: f.rel }));
  else info.length = total;

  const meta = { info, 'creation date': Math.floor(Date.now() / 1000), 'created by': createdBy };
  const trackers = [].concat(announce).filter(Boolean);
  if (trackers.length) { meta.announce = trackers[0]; meta['announce-list'] = trackers.map((t) => [t]); }
  if (comment) meta.comment = comment;

  const torrent = encode(meta);
  return { ...parseTorrent(torrent), sourceFiles: files.map((f) => f.abs) };
}

/** Parse a .torrent buffer into a normalised description. */
export function parseTorrent(buf) {
  const { value, raw } = decode(buf, { rawKey: 'info' });
  if (!value.info || !raw) throw new Error('not a torrent: missing info dictionary');
  return describe(value.info, raw, value);
}

/** Build a description from a bare info dict (e.g. fetched via ut_metadata). */
export function fromInfoBuffer(infoBuf, extra = {}) {
  const info = decode(infoBuf);
  return describe(info, infoBuf, { ...extra, info });
}

function describe(info, rawInfo, meta) {
  const infoHash = sha1(rawInfo).toString('hex');
  const pieceLength = Number(info['piece length']);
  const pieces = [];
  for (let i = 0; i < info.pieces.length; i += 20) pieces.push(info.pieces.subarray(i, i + 20));
  const name = text(info['name.utf-8'] || info.name);

  let files;
  if (info.files) {
    let offset = 0;
    files = info.files.map((f) => {
      const parts = (f['path.utf-8'] || f.path).map(text);
      const entry = { path: path.join(name, ...parts), name: parts[parts.length - 1], length: Number(f.length), offset };
      offset += entry.length;
      return entry;
    });
  } else {
    files = [{ path: name, name, length: Number(info.length), offset: 0 }];
  }
  const length = files.reduce((n, f) => n + f.length, 0);
  const expected = Math.ceil(length / pieceLength) || 1;
  if (pieces.length !== expected) throw new Error(`corrupt torrent: ${pieces.length} piece hashes for ${expected} pieces`);

  const announce = [];
  if (meta['announce-list']) for (const tier of meta['announce-list']) for (const t of tier) announce.push(text(t));
  if (meta.announce && !announce.includes(text(meta.announce))) announce.unshift(text(meta.announce));
  if (Array.isArray(meta.trackers)) for (const t of meta.trackers) if (!announce.includes(t)) announce.push(t);

  return {
    infoHash, name, pieceLength, pieces, files, length, announce,
    private: Number(info.private) === 1,
    infoBuffer: Buffer.from(rawInfo),
    torrent: rebuildTorrent(meta, rawInfo),
    createdAt: meta['creation date'] ? new Date(Number(meta['creation date']) * 1000) : null,
    comment: meta.comment ? text(meta.comment) : undefined,
  };
}

// Re-serialise the torrent around the *original* info bytes so the info hash never drifts.
function rebuildTorrent(meta, rawInfo) {
  const rest = { ...meta }; delete rest.info;
  if (Array.isArray(rest.trackers)) {
    if (!rest.announce && rest.trackers[0]) rest.announce = rest.trackers[0];
    if (!rest['announce-list'] && rest.trackers.length) rest['announce-list'] = rest.trackers.map((t) => [t]);
  }
  delete rest.trackers;
  for (const k of Object.keys(rest)) if (rest[k] === undefined || rest[k] === null) delete rest[k];
  const keys = Object.keys(rest).concat('info').sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const parts = [Buffer.from('d')];
  for (const k of keys) {
    parts.push(encode(k));
    parts.push(k === 'info' ? Buffer.from(rawInfo) : encode(rest[k]));
  }
  parts.push(Buffer.from('e'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- magnets

export function toMagnet({ infoHash, name, announce = [], length }) {
  const q = [`xt=urn:btih:${infoHash}`];
  if (name) q.push(`dn=${encodeURIComponent(name)}`);
  if (length) q.push(`xl=${length}`);
  for (const t of announce) q.push(`tr=${encodeURIComponent(t)}`);
  return `magnet:?${q.join('&')}`;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32ToHex(s) {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('bad base32 in magnet');
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

export function parseMagnet(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('magnet:?')) throw new Error('not a magnet URI');
  const params = new URLSearchParams(uri.slice(8));
  let infoHash = null;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(xt);
    if (m) infoHash = m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1]);
  }
  if (!infoHash) throw new Error('magnet URI has no btih info hash');
  return {
    infoHash,
    name: params.get('dn') || undefined,
    announce: params.getAll('tr'),
    length: params.get('xl') ? Number(params.get('xl')) : undefined,
    peers: params.getAll('x.pe'),
  };
}

/** Per-piece byte length (last piece is usually short). */
export function pieceSize(t, index) {
  const last = t.pieces.length - 1;
  return index < last ? t.pieceLength : t.length - t.pieceLength * last || t.pieceLength;
}
