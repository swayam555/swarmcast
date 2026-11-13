// Bencoding (BEP 3). Strings decode to Buffers so binary fields (piece hashes,
// compact peers) survive untouched; callers convert to text where they need it.

export function encode(value) {
  const parts = [];
  write(value, parts);
  return Buffer.concat(parts);
}

function write(v, out) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    out.push(Buffer.from(`${b.length}:`), b);
  } else if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    out.push(Buffer.from(`${b.length}:`), b);
  } else if (typeof v === 'number' || typeof v === 'bigint') {
    if (typeof v === 'number' && !Number.isInteger(v)) throw new TypeError(`bencode: non-integer ${v}`);
    out.push(Buffer.from(`i${v}e`));
  } else if (typeof v === 'boolean') {
    out.push(Buffer.from(`i${v ? 1 : 0}e`));
  } else if (Array.isArray(v)) {
    out.push(Buffer.from('l'));
    for (const item of v) write(item, out);
    out.push(Buffer.from('e'));
  } else if (v && typeof v === 'object') {
    out.push(Buffer.from('d'));
    // Keys must be sorted as raw byte strings.
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && v[k] !== null)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const k of keys) { write(k, out); write(v[k], out); }
    out.push(Buffer.from('e'));
  } else {
    throw new TypeError(`bencode: cannot encode ${typeof v}`);
  }
}

/**
 * Decode a bencoded buffer. Returns the value; with {withRaw:true} also returns
 * the raw byte span of the top-level dict key named by `rawKey` (used to hash
 * the exact `info` dictionary bytes, which re-encoding might not reproduce).
 */
export function decode(buf, { rawKey } = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  let pos = 0;
  let raw = null;

  const read = (depth) => {
    const c = buf[pos];
    if (c === 0x69) { // i
      const end = buf.indexOf(0x65, pos);
      if (end < 0) throw new Error('bencode: unterminated int');
      const txt = buf.toString('ascii', pos + 1, end);
      if (!/^-?\d+$/.test(txt)) throw new Error(`bencode: bad int "${txt}"`);
      pos = end + 1;
      const n = Number(txt);
      return Number.isSafeInteger(n) ? n : BigInt(txt);
    }
    if (c === 0x6c) { // l
      pos++;
      const list = [];
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) throw new Error('bencode: unterminated list');
        list.push(read(depth + 1));
      }
      pos++;
      return list;
    }
    if (c === 0x64) { // d
      pos++;
      const dict = {};
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) throw new Error('bencode: unterminated dict');
        const key = read(depth + 1).toString('utf8');
        const start = pos;
        dict[key] = read(depth + 1);
        if (depth === 0 && rawKey && key === rawKey) raw = buf.subarray(start, pos);
      }
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, pos);
      if (colon < 0) throw new Error('bencode: bad string length');
      const len = Number(buf.toString('ascii', pos, colon));
      const start = colon + 1;
      if (start + len > buf.length) throw new Error('bencode: string overruns buffer');
      pos = start + len;
      return buf.subarray(start, pos);
    }
    throw new Error(`bencode: unexpected byte 0x${(c ?? 0).toString(16)} at ${pos}`);
  };

  const value = read(0);
  return rawKey ? { value, raw, consumed: pos } : value;
}

/** Decode the first value and report how many bytes it used (ut_metadata carries a trailing payload). */
export function decodePrefix(buf) {
  const r = decode(buf, { rawKey: '\u0000' });
  return { value: r.value, consumed: r.consumed };
}

export const text = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b);
