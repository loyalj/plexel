/**
 * Zip files, written and read, with Zip64.
 *
 * A .pxll is a zip, so that any unzip tool can look inside one when
 * something has gone wrong. Our own code rather than a library because the
 * format needs three things together: Zip64 (a 16-bit CMYK document passes
 * 4 GB easily), entries written as a stream with their sizes known only at
 * the end (tile packs, from phase 3), and random-access reads straight from
 * a File, so opening a big document never loads all of it.
 *
 * Compression is the platform's own `deflate-raw` CompressionStream, which
 * browsers and Node both have, so this file runs unchanged in the checks.
 *
 * What it writes: UTF-8 names, deflate or stored entries, Zip64 records
 * only where a size or offset needs them (or everywhere when asked, so the
 * checks can exercise that path without writing 4 GB). What it reads: the
 * same, plus anything other tools write in those terms. Encryption,
 * multi-disk archives and other compression methods are refused by name.
 */

// --- CRC-32 -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Running CRC-32: start with `crc32(data)`, continue with `crc32(more, previous)`. */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

// --- little-endian helpers -----------------------------------------------------

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

class Bytes {
  private buf: Uint8Array
  private view: DataView
  at = 0
  constructor(size: number) {
    this.buf = new Uint8Array(size)
    this.view = new DataView(this.buf.buffer)
  }
  u16(v: number) {
    this.view.setUint16(this.at, v, true)
    this.at += 2
    return this
  }
  u32(v: number) {
    this.view.setUint32(this.at, v >>> 0, true)
    this.at += 4
    return this
  }
  u64(v: number) {
    // Sizes stay below 2^53, so splitting a double is exact.
    this.view.setUint32(this.at, v % 2 ** 32, true)
    this.view.setUint32(this.at + 4, Math.floor(v / 2 ** 32), true)
    this.at += 8
    return this
  }
  bytes(b: Uint8Array) {
    this.buf.set(b, this.at)
    this.at += b.length
    return this
  }
  done() {
    return this.buf.subarray(0, this.at)
  }
}

const readU64 = (v: DataView, at: number) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32

function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const utf8 = new TextEncoder()
const fromUtf8 = new TextDecoder()

// --- streams ------------------------------------------------------------------

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return collect(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')))
}

export async function inflateRaw(data: Uint8Array | Blob): Promise<Uint8Array> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart])
  return collect(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')))
}

// --- writing ------------------------------------------------------------------

/** Where the zip's bytes go: memory, a file, a download. Writes arrive in order. */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>
}

export interface AddOptions {
  /** Deflate it. Off for data that's already compressed (PNG, packed tiles) and for `mimetype`. */
  compress?: boolean
  modified?: Date
}

interface Written {
  name: Uint8Array
  method: number
  flags: number
  time: number
  date: number
  crc: number
  compressed: number
  size: number
  offset: number
}

export class ZipWriter {
  private offset = 0
  private entries: Written[] = []
  private names = new Set<string>()
  private finished = false

  /** `forceZip64` writes Zip64 records everywhere: for the checks, which can't write 4 GB to get them. */
  constructor(
    private sink: ZipSink,
    private opts: { forceZip64?: boolean } = {},
  ) {}

  private async emit(chunk: Uint8Array) {
    await this.sink.write(chunk)
    this.offset += chunk.length
  }

  private claim(name: string) {
    if (this.finished) throw new Error('The zip is already finished')
    if (this.names.has(name)) throw new Error(`“${name}” is already in the zip`)
    this.names.add(name)
  }

  /**
   * Adds an entry whose bytes are all in hand. Its sizes are known before it
   * is written, so the local header carries them and no data descriptor
   * follows. That's the form ODF-style `mimetype` entries need.
   */
  async add(name: string, data: Uint8Array, o: AddOptions = {}) {
    this.claim(name)
    const compress = o.compress ?? true
    const body = compress ? await deflateRaw(data) : data
    const entry = this.entry(name, compress, 0, o.modified)
    entry.crc = crc32(data)
    entry.size = data.length
    entry.compressed = body.length
    await this.emit(this.localHeader(entry, true))
    await this.emit(body)
    this.entries.push(entry)
  }

  /**
   * Adds an entry from a stream, for data too big to hold at once. The
   * sizes and CRC are worked out as it passes and written after it in a
   * data descriptor; the central directory has them too, which is where
   * readers (ours included) look.
   */
  async addStream(name: string, source: ReadableStream<Uint8Array>, o: AddOptions = {}) {
    this.claim(name)
    const compress = o.compress ?? true
    const entry = this.entry(name, compress, 8, o.modified)
    await this.emit(this.localHeader(entry, false))

    let crc = 0
    let size = 0
    const counted = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          crc = crc32(chunk, crc)
          size += chunk.length
          ctl.enqueue(chunk)
        },
      }),
    )
    const body: ReadableStream<Uint8Array> = compress
      ? counted.pipeThrough(new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      : counted
    let compressed = 0
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      compressed += value.length
      await this.emit(value)
    }
    entry.crc = crc
    entry.size = size
    entry.compressed = compressed

    const big = this.opts.forceZip64 || size >= U32_MAX || compressed >= U32_MAX
    const d = new Bytes(24).u32(0x08074b50).u32(crc)
    if (big) d.u64(compressed).u64(size)
    else d.u32(compressed).u32(size)
    await this.emit(d.done())
    this.entries.push(entry)
  }

  private entry(name: string, compress: boolean, flags: number, modified = new Date()): Written {
    const { time, date } = dosDateTime(modified)
    // Bit 11: the name is UTF-8.
    return { name: utf8.encode(name), method: compress ? 8 : 0, flags: flags | 0x800, time, date, crc: 0, compressed: 0, size: 0, offset: this.offset }
  }

  private localHeader(e: Written, sized: boolean): Uint8Array {
    // An entry written whole only gets a Zip64 extra when it needs one,
    // even when Zip64 is forced: `mimetype` must have no extra field at
    // all, or the file can't be recognised from its first bytes.
    const big = (sized && (e.size >= U32_MAX || e.compressed >= U32_MAX)) || (!sized && !!this.opts.forceZip64)
    const extra = big ? new Bytes(20).u16(0x0001).u16(16).u64(sized ? e.size : 0).u64(sized ? e.compressed : 0).done() : new Uint8Array(0)
    const b = new Bytes(30 + e.name.length + extra.length)
    b.u32(0x04034b50).u16(big ? 45 : 20).u16(e.flags).u16(e.method).u16(e.time).u16(e.date)
    b.u32(sized ? e.crc : 0)
    b.u32(big ? U32_MAX : sized ? e.compressed : 0)
    b.u32(big ? U32_MAX : sized ? e.size : 0)
    b.u16(e.name.length).u16(extra.length).bytes(e.name).bytes(extra)
    return b.done()
  }

  /** Writes the central directory and the end records. Nothing can be added after. */
  async finish() {
    if (this.finished) return
    this.finished = true
    const force = !!this.opts.forceZip64
    const cdStart = this.offset
    for (const e of this.entries) {
      const needSize = force || e.size >= U32_MAX
      const needComp = force || e.compressed >= U32_MAX
      const needOffset = force || e.offset >= U32_MAX
      const fields: number[] = []
      if (needSize) fields.push(e.size)
      if (needComp) fields.push(e.compressed)
      if (needOffset) fields.push(e.offset)
      let extra: Uint8Array = new Uint8Array(0)
      if (fields.length) {
        const x = new Bytes(4 + fields.length * 8).u16(0x0001).u16(fields.length * 8)
        for (const f of fields) x.u64(f)
        extra = x.done()
      }
      const zip64 = fields.length > 0
      const b = new Bytes(46 + e.name.length + extra.length)
      b.u32(0x02014b50).u16(zip64 ? 45 : 20).u16(zip64 ? 45 : 20).u16(e.flags).u16(e.method).u16(e.time).u16(e.date)
      b.u32(e.crc).u32(needComp ? U32_MAX : e.compressed).u32(needSize ? U32_MAX : e.size)
      b.u16(e.name.length).u16(extra.length).u16(0).u16(0).u16(0).u32(0)
      b.u32(needOffset ? U32_MAX : e.offset).bytes(e.name).bytes(extra)
      await this.emit(b.done())
    }
    const cdSize = this.offset - cdStart
    const count = this.entries.length
    const zip64 = force || count >= U16_MAX || cdSize >= U32_MAX || cdStart >= U32_MAX
    if (zip64) {
      const recordAt = this.offset
      const r = new Bytes(56 + 20)
      r.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdStart)
      r.u32(0x07064b50).u32(0).u64(recordAt).u32(1)
      await this.emit(r.done())
    }
    const end = new Bytes(22)
    end.u32(0x06054b50).u16(0).u16(0)
    end.u16(zip64 ? U16_MAX : count).u16(zip64 ? U16_MAX : count)
    end.u32(zip64 ? U32_MAX : cdSize).u32(zip64 ? U32_MAX : cdStart).u16(0)
    await this.emit(end.done())
  }
}

/** A sink that keeps everything in memory, for small zips and for the checks. */
export function memorySink() {
  const chunks: Uint8Array[] = []
  return {
    sink: { write: async (c: Uint8Array) => void chunks.push(c.slice()) } satisfies ZipSink,
    blob: (type = 'application/zip') => new Blob(chunks as BlobPart[], { type }),
  }
}

// --- reading ------------------------------------------------------------------

export interface ZipEntry {
  name: string
  method: number
  flags: number
  crc: number
  compressed: number
  size: number
  offset: number
}

export class ZipError extends Error {}

/**
 * The entries of a zip, read from its central directory, with each entry's
 * bytes fetched only when asked for. Works on any Blob, including a File
 * straight from a file picker, so a big archive is never read whole.
 */
export class ZipReader {
  private constructor(
    private blob: Blob,
    readonly entries: Map<string, ZipEntry>,
  ) {}

  static async open(blob: Blob): Promise<ZipReader> {
    const tailSize = Math.min(blob.size, 22 + U16_MAX + 20)
    const tailStart = blob.size - tailSize
    const tail = new DataView(await blob.slice(tailStart).arrayBuffer())
    let eocd = -1
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ZipError('This is not a zip file, or its end is missing (an interrupted save or download can do that).')
    if (tail.getUint16(eocd + 4, true) !== 0 || tail.getUint16(eocd + 6, true) !== 0) {
      throw new ZipError('The zip is split across several files, which isn’t supported.')
    }
    let count = tail.getUint16(eocd + 10, true)
    let cdSize = tail.getUint32(eocd + 12, true)
    let cdStart = tail.getUint32(eocd + 16, true)

    const locator = eocd - 20
    if (locator >= 0 && tail.getUint32(locator, true) === 0x07064b50) {
      const recordAt = readU64(tail, locator + 8)
      const rec = new DataView(await blob.slice(recordAt, recordAt + 56).arrayBuffer())
      if (rec.getUint32(0, true) !== 0x06064b50) throw new ZipError('The zip’s Zip64 end record is damaged.')
      count = readU64(rec, 32)
      cdSize = readU64(rec, 40)
      cdStart = readU64(rec, 48)
    }
    if (cdStart + cdSize > blob.size) throw new ZipError('The zip’s directory points past the end of the file. The file is incomplete.')

    const cd = new DataView(await blob.slice(cdStart, cdStart + cdSize).arrayBuffer())
    const entries = new Map<string, ZipEntry>()
    let at = 0
    for (let i = 0; i < count; i++) {
      if (at + 46 > cd.byteLength || cd.getUint32(at, true) !== 0x02014b50) throw new ZipError('The zip’s directory is damaged.')
      const flags = cd.getUint16(at + 8, true)
      const method = cd.getUint16(at + 10, true)
      const crc = cd.getUint32(at + 16, true)
      let compressed = cd.getUint32(at + 20, true)
      let size = cd.getUint32(at + 24, true)
      const nameLen = cd.getUint16(at + 28, true)
      const extraLen = cd.getUint16(at + 30, true)
      const commentLen = cd.getUint16(at + 32, true)
      let offset = cd.getUint32(at + 42, true)
      const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + at + 46, nameLen)
      // Names are UTF-8 when bit 11 says so, and in practice almost always.
      const name = fromUtf8.decode(nameBytes)
      let x = at + 46 + nameLen
      const extraEnd = x + extraLen
      while (x + 4 <= extraEnd) {
        const id = cd.getUint16(x, true)
        const len = cd.getUint16(x + 2, true)
        if (id === 0x0001) {
          // The Zip64 fields appear in this order, and only for the values
          // the record above maxed out.
          let f = x + 4
          if (size === U32_MAX) {
            size = readU64(cd, f)
            f += 8
          }
          if (compressed === U32_MAX) {
            compressed = readU64(cd, f)
            f += 8
          }
          if (offset === U32_MAX) offset = readU64(cd, f)
        }
        x += 4 + len
      }
      entries.set(name, { name, method, flags, crc, compressed, size, offset })
      at = extraEnd + commentLen
    }
    return new ZipReader(blob, entries)
  }

  has(name: string) {
    return this.entries.has(name)
  }

  /**
   * Where a stored (uncompressed) entry's bytes are in the file, so they
   * can be read in pieces later without going through the zip: the .pxll
   * reader reads big layers' tiles this way, on demand. Null for a
   * compressed entry.
   */
  async range(name: string): Promise<{ start: number; length: number } | null> {
    const e = this.entries.get(name)
    if (!e || e.method !== 0 || e.flags & 1) return null
    const head = new DataView(await this.blob.slice(e.offset, e.offset + 30).arrayBuffer())
    if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new ZipError(`“${name}” is damaged: its header is missing.`)
    return { start: e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true), length: e.size }
  }

  /** An entry's bytes, inflated and checked against its CRC and size. */
  async read(name: string): Promise<Uint8Array> {
    const e = this.entries.get(name)
    if (!e) throw new ZipError(`“${name}” is not in the zip.`)
    if (e.flags & 1) throw new ZipError(`“${name}” is encrypted, which isn’t supported.`)
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`“${name}” uses a compression method (${e.method}) that isn’t supported.`)
    const head = new DataView(await this.blob.slice(e.offset, e.offset + 30).arrayBuffer())
    if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new ZipError(`“${name}” is damaged: its header is missing.`)
    const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true)
    const body = this.blob.slice(start, start + e.compressed)
    let data: Uint8Array
    try {
      data = e.method === 8 ? await inflateRaw(body) : new Uint8Array(await body.arrayBuffer())
    } catch {
      throw new ZipError(`“${name}” is damaged: it doesn’t decompress.`)
    }
    if (data.length !== e.size || crc32(data) !== e.crc) throw new ZipError(`“${name}” is damaged: its checksum doesn’t match.`)
    return data
  }

  async readText(name: string): Promise<string> {
    return fromUtf8.decode(await this.read(name))
  }
}
