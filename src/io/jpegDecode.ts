/**
 * A JPEG decoder of our own, for what the browser's can't give us: CMYK
 * and YCCK JPEGs (Photoshop's, prepress files), whose inks the browser
 * turns into RGB on its own terms or refuses. RGB and Gray JPEGs still go
 * through the browser's decoder (io/raster.ts), which is faster.
 *
 * Baseline and progressive Huffman JPEGs at 8 bits, any number of
 * components and sampling factors, restart intervals; Adobe's APP14 marker
 * says whether colours were transformed (YCbCr, YCCK) and, as every
 * Adobe CMYK JPEG is, stored inverted. Arithmetic coding, 12-bit and
 * lossless JPEGs are refused.
 *
 * The output is a Raster (io/raster.ts): CMYK as ink, RGB and Gray as
 * light, 8 bits, opaque. Chroma is upsampled by replication; the inverse
 * DCT is the plain separable float one.
 */
import type { Raster } from './raster'
import { JpegError } from './jpeg'

interface Huffman {
  /** Code lookup: for each length, the first code and where its values start. */
  maxcode: Int32Array
  valptr: Int32Array
  mincode: Int32Array
  values: Uint8Array
}

interface Component {
  id: number
  h: number
  v: number
  tq: number
  /** Blocks across and down, padded to whole MCUs. */
  bw: number
  bh: number
  /** Coefficients, 64 a block, in natural (not zigzag) order. */
  coef: Int32Array
  dcTable: number
  acTable: number
  pred: number
  eobrun: number
}

const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
  52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
])

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1)
  const valptr = new Int32Array(17)
  const mincode = new Int32Array(17)
  let code = 0
  let k = 0
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k
    mincode[l] = code
    code += counts[l - 1]
    k += counts[l - 1]
    maxcode[l] = counts[l - 1] ? code - 1 : -1
    code <<= 1
  }
  maxcode[17] = 0x7fffffff
  return { maxcode, valptr, mincode, values }
}

/** Reads entropy-coded bits, skipping stuffed zero bytes, stopping at markers. */
class Bits {
  private bit = 0
  private cur = 0
  constructor(
    private d: Uint8Array,
    public pos: number,
  ) {}

  read(): number {
    if (this.bit === 0) {
      if (this.pos >= this.d.length) throw new JpegError('The JPEG ends part-way through its image data')
      let b = this.d[this.pos]
      if (b === 0xff && this.d[this.pos + 1] !== 0) {
        // A marker: the data has run out early. Feed zeros and stay on it.
        b = 0
      } else {
        this.pos += b === 0xff ? 2 : 1
      }
      this.cur = b
      this.bit = 8
    }
    this.bit--
    return (this.cur >> this.bit) & 1
  }

  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.read()
    return v
  }

  decode(h: Huffman): number {
    let code = this.read()
    let l = 1
    while (code > h.maxcode[l]) {
      code = (code << 1) | this.read()
      l++
      if (l > 16) throw new JpegError('The JPEG’s Huffman codes don’t match its tables')
    }
    return h.values[h.valptr[l] + code - h.mincode[l]]
  }

  /** A magnitude category's value, sign-extended. */
  receive(s: number): number {
    if (s === 0) return 0
    const v = this.bits(s)
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v
  }

  /** Moves past a restart marker. */
  restart() {
    this.bit = 0
    while (this.pos < this.d.length - 1 && !(this.d[this.pos] === 0xff && this.d[this.pos + 1] >= 0xd0 && this.d[this.pos + 1] <= 0xd7)) this.pos++
    if (this.pos < this.d.length - 1) this.pos += 2
  }
}

/** The float inverse DCT of one block, into 8-bit samples (level-shifted, clamped). */
const COS = (() => {
  const t = new Float64Array(64)
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  return t
})()

function idct(block: Int32Array, off: number, q: Uint16Array, out: Uint8Array, stride: number, base: number, tmp: Float64Array) {
  for (let i = 0; i < 64; i++) tmp[i] = block[off + i] * q[i]
  const row = new Float64Array(64)
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let s = 0
      for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * tmp[y * 8 + u]
      row[y * 8 + x] = s / 2
    }
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      let s = 0
      for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * row[v * 8 + x]
      const p = Math.round(s / 2 + 128)
      out[base + y * stride + x] = p < 0 ? 0 : p > 255 ? 255 : p
    }
}

export function decodeJpegPixels(d: Uint8Array): Raster {
  if (!(d[0] === 0xff && d[1] === 0xd8)) throw new JpegError('This isn’t a JPEG')
  const qt: Uint16Array[] = []
  const dcTables: Huffman[] = []
  const acTables: Huffman[] = []
  let comps: Component[] = []
  let width = 0
  let height = 0
  let progressive = false
  let hmax = 1
  let vmax = 1
  let mcux = 0
  let mcuy = 0
  let restartInterval = 0
  let adobe: number | null = null
  let icc: Uint8Array[] = []
  let pos = 2
  const u16 = (p: number) => (d[p] << 8) | d[p + 1]
  while (pos < d.length) {
    if (d[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = d[pos + 1]
    pos += 2
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) continue
    if (marker === 0xd9) break
    const len = u16(pos)
    const seg = d.subarray(pos + 2, pos + len)
    pos += len
    switch (marker) {
      case 0xdb: {
        let p = 0
        while (p < seg.length) {
          const pq = seg[p] >> 4
          const tq = seg[p] & 15
          p++
          const t = new Uint16Array(64)
          for (let i = 0; i < 64; i++) {
            t[ZIGZAG[i]] = pq ? (seg[p] << 8) | seg[p + 1] : seg[p]
            p += pq ? 2 : 1
          }
          qt[tq] = t
        }
        break
      }
      case 0xc4: {
        let p = 0
        while (p < seg.length) {
          const tc = seg[p] >> 4
          const th = seg[p] & 15
          const counts = seg.subarray(p + 1, p + 17)
          const n = counts.reduce((a, b) => a + b, 0)
          const values = seg.slice(p + 17, p + 17 + n)
          ;(tc ? acTables : dcTables)[th] = buildHuffman(counts, values)
          p += 17 + n
        }
        break
      }
      case 0xc0:
      case 0xc1:
      case 0xc2: {
        if (seg[0] !== 8) throw new JpegError(`This is a ${seg[0]}-bit JPEG; Plexel reads 8-bit ones`)
        progressive = marker === 0xc2
        height = (seg[1] << 8) | seg[2]
        width = (seg[3] << 8) | seg[4]
        if (!width || !height) throw new JpegError('The JPEG gives no size')
        const n = seg[5]
        comps = []
        for (let i = 0; i < n; i++) {
          const o = 6 + i * 3
          comps.push({ id: seg[o], h: seg[o + 1] >> 4, v: seg[o + 1] & 15, tq: seg[o + 2], bw: 0, bh: 0, coef: new Int32Array(0), dcTable: 0, acTable: 0, pred: 0, eobrun: 0 })
        }
        hmax = Math.max(...comps.map((c) => c.h))
        vmax = Math.max(...comps.map((c) => c.v))
        mcux = Math.ceil(width / (8 * hmax))
        mcuy = Math.ceil(height / (8 * vmax))
        for (const c of comps) {
          c.bw = mcux * c.h
          c.bh = mcuy * c.v
          c.coef = new Int32Array(c.bw * c.bh * 64)
        }
        break
      }
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        throw new JpegError('This JPEG is lossless, hierarchical or arithmetic-coded, which Plexel doesn’t read')
      case 0xdd:
        restartInterval = (seg[0] << 8) | seg[1]
        break
      case 0xe2:
        if (String.fromCharCode(...seg.subarray(0, 11)) === 'ICC_PROFILE') icc[seg[12] - 1] = seg.slice(14)
        break
      case 0xee:
        if (String.fromCharCode(...seg.subarray(0, 5)) === 'Adobe') adobe = seg[11]
        break
      case 0xda: {
        const ns = seg[0]
        const scomps: Component[] = []
        for (let i = 0; i < ns; i++) {
          const c = comps.find((x) => x.id === seg[1 + i * 2])
          if (!c) throw new JpegError('A scan names a component the image doesn’t have')
          c.dcTable = seg[2 + i * 2] >> 4
          c.acTable = seg[2 + i * 2] & 15
          scomps.push(c)
        }
        const o = 1 + ns * 2
        const ss = seg[o]
        const se = seg[o + 1]
        const ah = seg[o + 2] >> 4
        const al = seg[o + 2] & 15
        pos = scan(d, pos, scomps, progressive, ss, se, ah, al, restartInterval, dcTables, acTables, { width, height, hmax, vmax, mcux, mcuy })
        break
      }
      default:
        break
    }
  }
  if (!comps.length) throw new JpegError('The JPEG has no image in it')
  // Every component's samples, at its own resolution.
  const tmp = new Float64Array(64)
  const planes = comps.map((c) => {
    const q = qt[c.tq]
    if (!q) throw new JpegError('The JPEG is missing a quantisation table')
    const w = c.bw * 8
    const plane = new Uint8Array(w * c.bh * 8)
    for (let by = 0; by < c.bh; by++) for (let bx = 0; bx < c.bw; bx++) idct(c.coef, (by * c.bw + bx) * 64, q, plane, w, by * 8 * w + bx * 8, tmp)
    return { plane, w, sx: hmax / c.h, sy: vmax / c.v }
  })
  const n = comps.length
  // Adobe's marker says what the colours are; without it, three components are YCbCr as JFIF has them.
  const transform = adobe !== null ? adobe : n === 3 ? 1 : 0
  const mode: Raster['mode'] = n === 1 ? 'gray' : n === 3 ? 'rgb' : 'cmyk'
  if (n !== 1 && n !== 3 && n !== 4) throw new JpegError(`This JPEG has ${n} components; Plexel reads 1, 3 or 4`)
  const out = new Uint8Array(width * height * (n + 1))
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
  const at = (k: number, x: number, y: number) => {
    const p = planes[k]
    return p.plane[Math.floor(y / p.sy) * p.w + Math.floor(x / p.sx)]
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * (n + 1)
      if (n === 1) out[o] = at(0, x, y)
      else if (n === 3) {
        if (transform === 1) {
          const Y = at(0, x, y)
          const cb = at(1, x, y) - 128
          const cr = at(2, x, y) - 128
          out[o] = clamp(Y + 1.402 * cr)
          out[o + 1] = clamp(Y - 0.344136 * cb - 0.714136 * cr)
          out[o + 2] = clamp(Y + 1.772 * cb)
        } else for (let k = 0; k < 3; k++) out[o + k] = at(k, x, y)
      } else {
        let c: number, m: number, yy: number
        const k4 = at(3, x, y)
        if (transform === 2) {
          // YCCK: YCbCr of the inverted CMY, black as it is.
          const Y = at(0, x, y)
          const cb = at(1, x, y) - 128
          const cr = at(2, x, y) - 128
          c = 255 - clamp(Y + 1.402 * cr)
          m = 255 - clamp(Y - 0.344136 * cb - 0.714136 * cr)
          yy = 255 - clamp(Y + 1.772 * cb)
        } else {
          c = at(0, x, y)
          m = at(1, x, y)
          yy = at(2, x, y)
        }
        // Adobe writes CMYK inverted (255 is no ink); without its marker the values are ink.
        const inverted = adobe !== null
        out[o] = inverted ? 255 - c : c
        out[o + 1] = inverted ? 255 - m : m
        out[o + 2] = inverted ? 255 - yy : yy
        out[o + 3] = inverted ? 255 - k4 : k4
      }
      out[o + n] = 255
    }
  icc = icc.filter(Boolean)
  const profile = icc.length ? new Uint8Array(icc.reduce((a, b) => a + b.length, 0)) : null
  if (profile) {
    let p = 0
    for (const part of icc) {
      profile.set(part, p)
      p += part.length
    }
  }
  return { width, height, mode, depth: 8, data: out, icc: profile, warnings: [] }
}

/** The frame a scan belongs to: its size and largest sampling factors, for counting a non-interleaved scan's blocks. */
interface Frame {
  width: number
  height: number
  hmax: number
  vmax: number
  mcux: number
  mcuy: number
}

/** One scan's entropy-coded data into the components' coefficients. Returns where the data ends. */
function scan(d: Uint8Array, start: number, comps: Component[], progressive: boolean, ss: number, se: number, ah: number, al: number, restart: number, dcT: Huffman[], acT: Huffman[], f: Frame): number {
  const b = new Bits(d, start)
  for (const c of comps) {
    c.pred = 0
    c.eobrun = 0
  }
  const blockAt = (c: Component, bx: number, by: number) => (by * c.bw + bx) * 64
  const decodeBlock = (c: Component, off: number) => {
    const coef = c.coef
    if (!progressive) {
      const dc = dcT[c.dcTable]
      const ac = acT[c.acTable]
      if (!dc || !ac) throw new JpegError('The JPEG is missing a Huffman table')
      c.pred += b.receive(b.decode(dc))
      coef[off] = c.pred
      for (let k = 1; k < 64; ) {
        const rs = b.decode(ac)
        const r = rs >> 4
        const s = rs & 15
        if (s === 0) {
          if (r === 15) {
            k += 16
            continue
          }
          break
        }
        k += r
        if (k > 63) break
        coef[off + ZIGZAG[k]] = b.receive(s)
        k++
      }
      return
    }
    if (ss === 0) {
      // DC: the first pass, or a refinement bit.
      if (ah === 0) {
        c.pred += b.receive(b.decode(dcT[c.dcTable]))
        coef[off] = c.pred * (1 << al)
      } else if (b.read()) coef[off] |= 1 << al
      return
    }
    if (ah === 0) {
      // AC, first pass: a band of coefficients, or a run of empty blocks.
      if (c.eobrun > 0) {
        c.eobrun--
        return
      }
      for (let k = ss; k <= se; ) {
        const rs = b.decode(acT[c.acTable])
        const r = rs >> 4
        const s = rs & 15
        if (s === 0) {
          if (r < 15) {
            c.eobrun = (1 << r) - 1
            if (r) c.eobrun += b.bits(r)
            break
          }
          k += 16
          continue
        }
        k += r
        if (k > 63) break
        coef[off + ZIGZAG[k]] = b.receive(s) * (1 << al)
        k++
      }
      return
    }
    // AC, refinement: a bit more of the coefficients already there, and new ones of ±1.
    let k = ss
    const p1 = 1 << al
    const m1 = -1 << al
    if (c.eobrun <= 0) {
      while (k <= se) {
        const rs = b.decode(acT[c.acTable])
        let r = rs >> 4
        const s = rs & 15
        let value = 0
        if (s) value = b.read() ? p1 : m1
        else if (r !== 15) {
          c.eobrun = 1 << r
          if (r) c.eobrun += b.bits(r)
          break
        }
        while (k <= se) {
          const z = off + ZIGZAG[k]
          if (coef[z] !== 0) {
            if (b.read() && (coef[z] & p1) === 0) coef[z] += coef[z] >= 0 ? p1 : m1
          } else {
            if (r === 0) {
              if (value) coef[z] = value
              k++
              break
            }
            r--
          }
          k++
        }
      }
    }
    if (c.eobrun > 0) {
      for (; k <= se; k++) {
        const z = off + ZIGZAG[k]
        if (coef[z] !== 0 && b.read() && (coef[z] & p1) === 0) coef[z] += coef[z] >= 0 ? p1 : m1
      }
      c.eobrun--
    }
  }
  let count = 0
  const restartIfDue = () => {
    if (restart && count > 0 && count % restart === 0) {
      b.restart()
      for (const c of comps) {
        c.pred = 0
        c.eobrun = 0
      }
    }
  }
  if (comps.length === 1) {
    // Non-interleaved: one block at a time, covering the component's own size rather than whole MCUs.
    const c = comps[0]
    const across = Math.ceil(Math.ceil((f.width * c.h) / f.hmax) / 8)
    const down = Math.ceil(Math.ceil((f.height * c.v) / f.vmax) / 8)
    for (let by = 0; by < down; by++)
      for (let bx = 0; bx < across; bx++) {
        restartIfDue()
        decodeBlock(c, blockAt(c, bx, by))
        count++
      }
  } else {
    for (let my = 0; my < f.mcuy; my++)
      for (let mx = 0; mx < f.mcux; mx++) {
        restartIfDue()
        for (const c of comps) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) decodeBlock(c, blockAt(c, mx * c.h + h, my * c.v + v))
        count++
      }
  }
  // Past the scan's data: on to the next marker that isn't a restart.
  let p = b.pos
  while (p < d.length - 1 && !(d[p] === 0xff && d[p + 1] !== 0 && !(d[p + 1] >= 0xd0 && d[p + 1] <= 0xd7))) p++
  return p
}
