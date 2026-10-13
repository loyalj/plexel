/**
 * Big-endian bytes in and out, as Photoshop's formats lay them: PSD and
 * PSB (where some lengths are 8 bytes), descriptors, engine data. The
 * reader throws PsdError past its end, so a truncated file fails saying so
 * rather than reading garbage.
 */
export class PsdError extends Error {}

export class Reader {
  pos = 0
  private v: DataView

  constructor(
    readonly b: Uint8Array,
    /** PSB: lengths that are 8 bytes there and 4 in a PSD. */
    public psb = false,
  ) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }

  get left() {
    return this.b.length - this.pos
  }

  private need(n: number) {
    if (n < 0 || this.pos + n > this.b.length) throw new PsdError('The file ends part-way through')
  }

  u8() {
    this.need(1)
    return this.b[this.pos++]
  }
  i8() {
    const v = this.u8()
    return v > 127 ? v - 256 : v
  }
  u16() {
    this.need(2)
    const v = this.v.getUint16(this.pos)
    this.pos += 2
    return v
  }
  i16() {
    this.need(2)
    const v = this.v.getInt16(this.pos)
    this.pos += 2
    return v
  }
  u32() {
    this.need(4)
    const v = this.v.getUint32(this.pos)
    this.pos += 4
    return v
  }
  i32() {
    this.need(4)
    const v = this.v.getInt32(this.pos)
    this.pos += 4
    return v
  }
  f32() {
    this.need(4)
    const v = this.v.getFloat32(this.pos)
    this.pos += 4
    return v
  }
  f64() {
    this.need(8)
    const v = this.v.getFloat64(this.pos)
    this.pos += 8
    return v
  }
  /** An 8-byte unsigned length (exact to 2⁵³). */
  u64() {
    const hi = this.u32()
    const lo = this.u32()
    return hi * 2 ** 32 + lo
  }
  i64() {
    this.need(8)
    const v = this.v.getBigInt64(this.pos)
    this.pos += 8
    return Number(v)
  }
  /** A section length: 8 bytes in a PSB, 4 in a PSD. */
  len() {
    return this.psb ? this.u64() : this.u32()
  }
  bytes(n: number) {
    this.need(n)
    const out = this.b.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  skip(n: number) {
    this.need(n)
    this.pos += n
  }
  sig() {
    return String.fromCharCode(...this.bytes(4))
  }
  /** A Pascal string, its length byte included, padded to a multiple of `pad`. */
  pascal(pad = 2) {
    const n = this.u8()
    // Byte for byte (true Latin-1, not windows-1252), so the name writes back as it was; the Unicode name block is what's shown.
    const s = String.fromCharCode(...this.bytes(n))
    const used = n + 1
    if (used % pad) this.skip(pad - (used % pad))
    return s
  }
  /** A Unicode string: a u32 count of UTF-16 units, then the units (a trailing NUL dropped). */
  unicode() {
    const n = this.u32()
    this.need(n * 2)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16())
    return s.replace(/\0+$/, '')
  }
  /** A descriptor key or class: a u32 length, then that many characters, or four when it's 0. */
  id() {
    const n = this.u32()
    return new TextDecoder('latin1').decode(this.bytes(n || 4))
  }
  /** A sub-reader over the next `n` bytes; this one moves past them. */
  sub(n: number) {
    const r = new Reader(this.bytes(n), this.psb)
    return r
  }
}

/** Bytes written big-endian into a buffer that grows. Lengths can be written later (`mark`). */
export class Writer {
  private buf = new Uint8Array(1 << 16)
  private v = new DataView(this.buf.buffer)
  pos = 0

  constructor(public psb = false) {}

  private room(n: number) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.v = new DataView(next.buffer)
  }

  u8(x: number) {
    this.room(1)
    this.buf[this.pos++] = x & 255
  }
  i8(x: number) {
    this.u8(x < 0 ? x + 256 : x)
  }
  u16(x: number) {
    this.room(2)
    this.v.setUint16(this.pos, x)
    this.pos += 2
  }
  i16(x: number) {
    this.room(2)
    this.v.setInt16(this.pos, x)
    this.pos += 2
  }
  u32(x: number) {
    this.room(4)
    this.v.setUint32(this.pos, x >>> 0)
    this.pos += 4
  }
  i32(x: number) {
    this.room(4)
    this.v.setInt32(this.pos, x)
    this.pos += 4
  }
  f32(x: number) {
    this.room(4)
    this.v.setFloat32(this.pos, x)
    this.pos += 4
  }
  f64(x: number) {
    this.room(8)
    this.v.setFloat64(this.pos, x)
    this.pos += 8
  }
  u64(x: number) {
    this.u32(Math.floor(x / 2 ** 32))
    this.u32(x % 2 ** 32)
  }
  i64(x: number) {
    this.room(8)
    this.v.setBigInt64(this.pos, BigInt(Math.round(x)))
    this.pos += 8
  }
  len(x: number) {
    if (this.psb) this.u64(x)
    else this.u32(x)
  }
  bytes(b: Uint8Array) {
    this.room(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }
  zeros(n: number) {
    this.room(n)
    this.buf.fill(0, this.pos, this.pos + n)
    this.pos += n
  }
  sig(s: string) {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i))
  }
  pascal(s: string, pad = 2) {
    // Pascal strings are Mac Roman: a name read from a file goes back byte for byte; anything past a byte is ?, and the Unicode name carries it.
    const ascii = Uint8Array.from([...s].slice(0, 255), (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f))
    this.u8(ascii.length)
    this.bytes(ascii)
    const used = ascii.length + 1
    if (used % pad) this.zeros(pad - (used % pad))
  }
  unicode(s: string, nul = true) {
    this.u32(s.length + (nul ? 1 : 0))
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i))
    if (nul) this.u16(0)
  }
  id(s: string) {
    // Four-character keys are written as length 0, the way Photoshop writes them.
    if (s.length === 4) {
      this.u32(0)
      this.sig(s)
    } else {
      this.u32(s.length)
      for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
    }
  }
  /** Writes a placeholder length (4 bytes, or `big` 8) and returns a function that fills it with what follows. */
  mark(big = false): () => void {
    const at = this.pos
    if (big) this.u64(0)
    else this.u32(0)
    const start = this.pos
    return () => {
      const n = this.pos - start
      if (big) {
        this.v.setUint32(at, Math.floor(n / 2 ** 32))
        this.v.setUint32(at + 4, n % 2 ** 32)
      } else this.v.setUint32(at, n)
    }
  }
  /** Pads with zeros to a multiple of `n`, counted from `from`. */
  pad(n: number, from = 0) {
    const r = (this.pos - from) % n
    if (r) this.zeros(n - r)
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}
