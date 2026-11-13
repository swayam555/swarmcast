// Maps torrent pieces onto files on disk and keeps a content-addressed store
// (CAS) of verified pieces so identical bytes are never fetched twice.
import { open, mkdir, stat, rm, link, copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pieceSize, sha1 } from './metainfo.js';

export class TorrentStorage {
  constructor(meta, root, { selected } = {}) {
    this.meta = meta;
    this.root = root;
    this.handles = new Map();
    // Files the user deselected are never written; pieces that touch them still
    // get fetched only if they also touch a selected file.
    this.selected = selected || meta.files.map(() => true);
  }

  filePath(f) { return path.join(this.root, f.path); }

  async handle(f, writable) {
    const key = f.path + (writable ? ':w' : ':r');
    let h = this.handles.get(key);
    if (h) return h;
    const p = this.filePath(f);
    if (writable) {
      await mkdir(path.dirname(p), { recursive: true });
      try { h = await open(p, 'r+'); } catch { h = await open(p, 'w+'); }
    } else {
      h = await open(p, 'r');
    }
    this.handles.set(key, h);
    return h;
  }

  /** Byte ranges of each file covered by a piece. */
  spans(index) {
    const start = index * this.meta.pieceLength;
    const end = start + pieceSize(this.meta, index);
    const out = [];
    this.meta.files.forEach((f, fi) => {
      const fs = f.offset; const fe = f.offset + f.length;
      if (fe <= start || fs >= end || f.length === 0) return;
      const s = Math.max(start, fs); const e = Math.min(end, fe);
      out.push({ file: f, fileIndex: fi, fileOffset: s - fs, pieceOffset: s - start, length: e - s });
    });
    return out;
  }

  pieceWanted(index) { return this.spans(index).some((s) => this.selected[s.fileIndex]); }

  async writePiece(index, data) {
    for (const s of this.spans(index)) {
      if (!this.selected[s.fileIndex]) continue;
      const h = await this.handle(s.file, true);
      await h.write(data, s.pieceOffset, s.length, s.fileOffset);
    }
  }

  async readPiece(index) { return this.read(index, 0, pieceSize(this.meta, index)); }

  async read(index, begin, length) {
    const out = Buffer.alloc(length);
    const absStart = index * this.meta.pieceLength + begin;
    const absEnd = absStart + length;
    for (const f of this.meta.files) {
      const fs = f.offset; const fe = f.offset + f.length;
      if (fe <= absStart || fs >= absEnd) continue;
      const s = Math.max(absStart, fs); const e = Math.min(absEnd, fe);
      const h = await this.handle(f, false).catch(() => null);
      if (!h) throw new Error(`missing data file ${f.path}`);
      await h.read(out, s - absStart, e - s, s - fs);
    }
    return out;
  }

  /** Re-hash what is on disk. Calls onProgress(done,total). Returns verified piece indices. */
  async verify(onProgress) {
    const ok = [];
    for (let i = 0; i < this.meta.pieces.length; i++) {
      try {
        const data = await this.readPiece(i);
        if (sha1(data).equals(this.meta.pieces[i])) ok.push(i);
      } catch { /* missing or short file: piece not present */ }
      if (onProgress && (i % 32 === 0 || i === this.meta.pieces.length - 1)) onProgress(i + 1, this.meta.pieces.length);
    }
    return ok;
  }

  async preallocate() {
    for (const [i, f] of this.meta.files.entries()) {
      if (!this.selected[i]) continue;
      const h = await this.handle(f, true);
      const st = await h.stat();
      if (st.size < f.length) await h.truncate(f.length);
    }
  }

  async close() {
    for (const h of this.handles.values()) await h.close().catch(() => {});
    this.handles.clear();
  }

  async remove() {
    await this.close();
    const top = this.meta.files.length > 1 || this.meta.files[0].path.includes(path.sep)
      ? path.join(this.root, this.meta.name) : this.filePath(this.meta.files[0]);
    await rm(top, { recursive: true, force: true });
  }
}

/**
 * Content-addressed piece store. Blobs live at cas/ab/<sha256>; an index maps the
 * torrent-native SHA-1 of a piece to its SHA-256 blob so another transfer that
 * contains the same piece can be filled from disk instead of the network.
 */
export class CasStore {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.index = new Map();
    this.stats = { hits: 0, misses: 0, dedupBytes: 0, storedBytes: 0, blobs: 0 };
    this.dirty = false;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8'));
      for (const [k, v] of Object.entries(raw.index || {})) this.index.set(k, v);
      Object.assign(this.stats, raw.stats || {});
    } catch { /* fresh store */ }
    this.flushTimer = setInterval(() => this.flush().catch(() => {}), 5000);
    this.flushTimer.unref?.();
    return this;
  }

  blobPath(digest) { return path.join(this.dir, digest.slice(0, 2), digest); }

  async put(sha1hex, data) {
    if (this.index.has(sha1hex)) return this.index.get(sha1hex);
    const digest = createHash('sha256').update(data).digest('hex');
    const p = this.blobPath(digest);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
    this.index.set(sha1hex, digest);
    this.stats.storedBytes += data.length; this.stats.blobs++;
    this.dirty = true;
    return digest;
  }

  /** Returns the piece bytes if we already hold them, verified against the SHA-1. */
  async get(sha1hex) {
    const digest = this.index.get(sha1hex);
    if (!digest) { this.stats.misses++; return null; }
    try {
      const data = await readFile(this.blobPath(digest));
      if (sha1(data).toString('hex') !== sha1hex) throw new Error('cas blob corrupt');
      this.stats.hits++; this.stats.dedupBytes += data.length;
      return data;
    } catch {
      this.index.delete(sha1hex); this.dirty = true; this.stats.misses++;
      return null;
    }
  }

  /** Materialise a whole single-file artifact by hard-linking an existing copy when possible. */
  async materialize(from, to) {
    await mkdir(path.dirname(to), { recursive: true });
    try { await link(from, to); } catch { await copyFile(from, to); }
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ index: Object.fromEntries(this.index), stats: this.stats }));
    await rename(tmp, this.indexFile);
  }

  async usage() {
    let bytes = 0;
    for (const d of new Set(this.index.values())) { try { bytes += (await stat(this.blobPath(d))).size; } catch { /* gone */ } }
    return { blobs: this.index.size, bytes, ...this.stats, hitRate: this.stats.hits + this.stats.misses ? this.stats.hits / (this.stats.hits + this.stats.misses) : 0 };
  }

  async close() { clearInterval(this.flushTimer); await this.flush(); }
}
