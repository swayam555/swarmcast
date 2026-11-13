// Compact piece-availability bitmap, MSB-first as on the wire.
export class Bitfield {
  constructor(size, buffer) {
    this.size = size;
    this.buf = Buffer.alloc(Math.ceil(size / 8));
    if (buffer) Buffer.from(buffer).copy(this.buf, 0, 0, this.buf.length);
    this.clearSpareBits();
  }
  static full(size) { const b = new Bitfield(size); b.buf.fill(0xff); b.clearSpareBits(); return b; }

  clearSpareBits() {
    const spare = this.buf.length * 8 - this.size;
    if (spare > 0 && this.buf.length) this.buf[this.buf.length - 1] &= (0xff << spare) & 0xff;
  }
  get(i) { return i >= 0 && i < this.size && (this.buf[i >> 3] & (0x80 >> (i & 7))) !== 0; }
  set(i, on = true) {
    if (i < 0 || i >= this.size) return;
    if (on) this.buf[i >> 3] |= 0x80 >> (i & 7);
    else this.buf[i >> 3] &= ~(0x80 >> (i & 7));
  }
  count() {
    let n = 0;
    for (const byte of this.buf) { let b = byte; while (b) { n += b & 1; b >>= 1; } }
    return n;
  }
  complete() { return this.count() === this.size; }
  toBuffer() { return Buffer.from(this.buf); }
  toArray() { return Array.from({ length: this.size }, (_, i) => (this.get(i) ? 1 : 0)); }
  toHex() { return this.buf.toString('hex'); }
  static fromHex(size, hex) { return new Bitfield(size, Buffer.from(hex || '', 'hex')); }
}
