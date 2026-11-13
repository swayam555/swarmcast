// BitTorrent peer wire protocol (BEP 3) with the extension protocol (BEP 10),
// ut_metadata (BEP 9) and ut_pex (BEP 11). One PeerWire per TCP connection.
import { EventEmitter } from 'node:events';
import { encode, decode, decodePrefix } from './bencode.js';

const PSTR = Buffer.from('BitTorrent protocol');
export const MSG = { CHOKE: 0, UNCHOKE: 1, INTERESTED: 2, NOT_INTERESTED: 3, HAVE: 4, BITFIELD: 5, REQUEST: 6, PIECE: 7, CANCEL: 8, PORT: 9, EXTENDED: 20 };
export const LOCAL_EXT = { ut_metadata: 1, ut_pex: 2 };
const MAX_MESSAGE = 2 * 1024 * 1024; // larger than any sane block; guards memory

export function handshakeBuffer(infoHash, peerId) {
  const reserved = Buffer.alloc(8);
  reserved[5] |= 0x10; // extension protocol
  reserved[7] |= 0x01; // DHT
  return Buffer.concat([Buffer.from([PSTR.length]), PSTR, reserved, Buffer.from(infoHash, 'hex'), Buffer.from(peerId)]);
}

/**
 * Events: handshake({infoHash, peerId, extensions, dht}), choke, unchoke, interested,
 * not_interested, have(index), bitfield(buf), request(index, begin, length),
 * piece(index, begin, block), cancel(index, begin, length), port(n),
 * extended_handshake(dict), metadata(msg, payload), pex(dict), close, error.
 */
export class PeerWire extends EventEmitter {
  constructor(socket, { address } = {}) {
    super();
    this.socket = socket;
    this.address = address || `${socket.remoteAddress}:${socket.remotePort}`;
    this.amChoking = true; this.amInterested = false;
    this.peerChoking = true; this.peerInterested = false;
    this.remoteExt = {};      // name -> remote message id
    this.remoteExtHandshake = null;
    this.handshaken = false;
    this.closed = false;
    this.bytesIn = 0; this.bytesOut = 0;
    this.lastMessageAt = Date.now();
    this.buf = Buffer.alloc(0);

    socket.setNoDelay?.(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.emit('error', e));
    socket.on('close', () => this.destroy());
    this.keepAlive = setInterval(() => { if (Date.now() - this.lastSentAt > 90_000) this.send(Buffer.alloc(4)); }, 30_000);
    this.keepAlive.unref?.();
    this.lastSentAt = Date.now();
  }

  handshake(infoHash, peerId) { this.write(handshakeBuffer(infoHash, peerId)); }

  onData(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    this.lastMessageAt = Date.now();
    try {
      if (!this.handshaken) {
        if (this.buf.length < 1) return;
        const plen = this.buf[0];
        const total = 49 + plen;
        if (this.buf.length < total) return;
        const pstr = this.buf.subarray(1, 1 + plen);
        if (!pstr.equals(PSTR)) throw new Error('not a BitTorrent handshake');
        const reserved = this.buf.subarray(1 + plen, 9 + plen);
        const infoHash = this.buf.subarray(9 + plen, 29 + plen).toString('hex');
        const peerId = this.buf.subarray(29 + plen, 49 + plen);
        this.buf = this.buf.subarray(total);
        this.handshaken = true;
        this.peerId = peerId;
        this.supportsExtensions = (reserved[5] & 0x10) !== 0;
        this.emit('handshake', { infoHash, peerId, extensions: this.supportsExtensions, dht: (reserved[7] & 1) !== 0 });
      }
      while (this.buf.length >= 4) {
        const len = this.buf.readUInt32BE(0);
        if (len > MAX_MESSAGE) throw new Error(`message too large (${len})`);
        if (this.buf.length < 4 + len) break;
        const body = this.buf.subarray(4, 4 + len);
        this.buf = this.buf.subarray(4 + len);
        this.bytesIn += 4 + len;
        if (len) this.dispatch(body);
      }
    } catch (err) {
      this.emit('error', err);
      this.destroy();
    }
  }

  dispatch(body) {
    const id = body[0];
    const p = body.subarray(1);
    switch (id) {
      case MSG.CHOKE: this.peerChoking = true; return this.emit('choke');
      case MSG.UNCHOKE: this.peerChoking = false; return this.emit('unchoke');
      case MSG.INTERESTED: this.peerInterested = true; return this.emit('interested');
      case MSG.NOT_INTERESTED: this.peerInterested = false; return this.emit('not_interested');
      case MSG.HAVE: return this.emit('have', p.readUInt32BE(0));
      case MSG.BITFIELD: return this.emit('bitfield', Buffer.from(p));
      case MSG.REQUEST: return this.emit('request', p.readUInt32BE(0), p.readUInt32BE(4), p.readUInt32BE(8));
      case MSG.PIECE: return this.emit('piece', p.readUInt32BE(0), p.readUInt32BE(4), Buffer.from(p.subarray(8)));
      case MSG.CANCEL: return this.emit('cancel', p.readUInt32BE(0), p.readUInt32BE(4), p.readUInt32BE(8));
      case MSG.PORT: return this.emit('port', p.readUInt16BE(0));
      case MSG.EXTENDED: return this.onExtended(p[0], p.subarray(1));
      default: return; // unknown messages are ignored per spec
    }
  }

  onExtended(extId, payload) {
    if (extId === 0) {
      const d = decode(payload);
      this.remoteExtHandshake = d;
      if (d.m) for (const [k, v] of Object.entries(d.m)) this.remoteExt[k] = Number(v);
      return this.emit('extended_handshake', d);
    }
    if (extId === LOCAL_EXT.ut_metadata) {
      const { value, consumed } = decodePrefix(payload);
      return this.emit('metadata', value, payload.subarray(consumed));
    }
    if (extId === LOCAL_EXT.ut_pex) return this.emit('pex', decode(payload));
  }

  // ------------------------------------------------------------ senders
  write(buf) {
    if (this.closed) return false;
    this.bytesOut += buf.length;
    this.lastSentAt = Date.now();
    return this.socket.write(buf);
  }
  send(body) {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
    return this.write(body.length ? Buffer.concat([head, body]) : head);
  }
  simple(id) { return this.send(Buffer.from([id])); }

  choke() { if (!this.amChoking) { this.amChoking = true; this.simple(MSG.CHOKE); } }
  unchoke() { if (this.amChoking) { this.amChoking = false; this.simple(MSG.UNCHOKE); } }
  interested() { if (!this.amInterested) { this.amInterested = true; this.simple(MSG.INTERESTED); } }
  notInterested() { if (this.amInterested) { this.amInterested = false; this.simple(MSG.NOT_INTERESTED); } }
  have(index) { const b = Buffer.alloc(5); b[0] = MSG.HAVE; b.writeUInt32BE(index, 1); this.send(b); }
  bitfield(buf) { this.send(Buffer.concat([Buffer.from([MSG.BITFIELD]), buf])); }
  request(index, begin, length) { this.send(triple(MSG.REQUEST, index, begin, length)); }
  cancel(index, begin, length) { this.send(triple(MSG.CANCEL, index, begin, length)); }
  piece(index, begin, block) {
    const h = Buffer.alloc(9); h[0] = MSG.PIECE; h.writeUInt32BE(index, 1); h.writeUInt32BE(begin, 5);
    this.send(Buffer.concat([h, block]));
  }
  port(n) { const b = Buffer.alloc(3); b[0] = MSG.PORT; b.writeUInt16BE(n, 1); this.send(b); }

  extendedHandshake(extra = {}) {
    this.send(Buffer.concat([Buffer.from([MSG.EXTENDED, 0]), encode({ m: LOCAL_EXT, v: 'Shoal 0.1', reqq: 250, ...extra })]));
  }
  extended(name, dict, trailer) {
    const id = this.remoteExt[name];
    if (!id) return false;
    const parts = [Buffer.from([MSG.EXTENDED, id]), encode(dict)];
    if (trailer) parts.push(trailer);
    return this.send(Buffer.concat(parts));
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.socket.destroy();
    this.emit('close');
  }
}

function triple(id, a, b, c) {
  const buf = Buffer.alloc(13); buf[0] = id;
  buf.writeUInt32BE(a, 1); buf.writeUInt32BE(b, 5); buf.writeUInt32BE(c, 9);
  return buf;
}

// Compact peer encodings (BEP 23 / PEX)
export function encodeCompactPeers(list) {
  const out = [];
  for (const p of list) {
    const [host, port] = splitAddr(p);
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) continue;
    const b = Buffer.alloc(6); parts.forEach((n, i) => { b[i] = n; }); b.writeUInt16BE(port, 4); out.push(b);
  }
  return Buffer.concat(out);
}
export function decodeCompactPeers(buf) {
  const out = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) out.push(`${buf[i]}.${buf[i + 1]}.${buf[i + 2]}.${buf[i + 3]}:${buf.readUInt16BE(i + 4)}`);
  return out;
}
export function splitAddr(a) { const i = a.lastIndexOf(':'); return [a.slice(0, i).replace(/^\[|\]$/g, ''), Number(a.slice(i + 1))]; }
