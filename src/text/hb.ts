/**
 * The shaper: HarfBuzz, compiled to WebAssembly (native/pxhb), wrapped so
 * the rest of the app never sees a pointer.
 *
 * A Face is a font file's face (a collection holds several): its names,
 * weight, style, licence flags, variation axes and named instances. A Font
 * is a face at a set of variation coordinates; it shapes text and gives
 * glyph outlines. Everything is in font units; layout scales it to the
 * size the text is set at.
 *
 * The same code runs on the page and in Node; only how the wasm bytes
 * arrive differs, so the caller passes them in.
 */
import createPxHb, { type PxHbModule } from './wasm/pxhb.mjs'

export interface Axis {
  tag: string
  min: number
  default: number
  max: number
  name: string
}

export interface Instance {
  name: string
  coords: Record<string, number>
}

export interface FaceInfo {
  family: string
  subfamily: string
  full: string
  postscript: string
  upem: number
  glyphs: number
  /** OS/2: 100 (thin) to 900 (black). */
  weight: number
  /** OS/2: 1 (ultra-condensed) to 9 (ultra-expanded). */
  width: number
  italic: boolean
  /** OS/2 fsType: the licence's embedding permissions. */
  fsType: number
  axes: Axis[]
  instances: Instance[]
}

export interface ShapedGlyph {
  gid: number
  /** A UTF-16 offset into the text shaped. */
  cluster: number
  ax: number
  ay: number
  dx: number
  dy: number
}

export interface Metrics {
  ascender: number
  descender: number
  lineGap: number
  xHeight: number
  capHeight: number
  underlineOffset: number
  underlineSize: number
  strikeOffset: number
  strikeSize: number
}

/**
 * A glyph's outline in font units, y up: commands as numbers, 0 x y (move),
 * 1 x y (line), 3 c1x c1y c2x c2y x y (cubic), 4 (close). Quadratics are
 * raised to cubics.
 */
export type GlyphOutline = number[]

const tagNumber = (tag: string) => ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0
const tagString = (hi: number, lo: number) => String.fromCharCode((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255)

export class HarfBuzz {
  readonly version: string
  private textPtr = 0
  private textCap = 0
  private lastText: string | null = null

  constructor(readonly m: PxHbModule) {
    this.version = m.UTF8ToString(m._px_version())
  }

  /** How many faces a font file holds. */
  faceCount(bytes: Uint8Array): number {
    return this.withBytes(bytes, (p) => this.m._px_face_count(p, bytes.length))
  }

  /** A face from a font file, or null when it isn't one HarfBuzz reads. */
  openFace(bytes: Uint8Array, index = 0): Face | null {
    const ptr = this.withBytes(bytes, (p) => this.m._px_face(p, bytes.length, index))
    return ptr ? new Face(this, ptr) : null
  }

  private withBytes<T>(bytes: Uint8Array, fn: (ptr: number) => T): T {
    const p = this.m._malloc(Math.max(1, bytes.length))
    try {
      this.m.HEAPU8.set(bytes, p)
      return fn(p)
    } finally {
      this.m._free(p)
    }
  }

  /** The values the last call left in the module's output buffer. */
  out(): Float32Array {
    const p = this.m._px_out()
    const n = this.m._px_out_len()
    return p ? this.m.HEAPF32.slice(p / 4, p / 4 + n) : new Float32Array(0)
  }

  /** A string in wasm memory as UTF-16, kept while the same text is shaped item by item. */
  textIn(text: string): number {
    if (text === this.lastText) return this.textPtr
    const bytes = (text.length + 1) * 2
    if (bytes > this.textCap) {
      if (this.textPtr) this.m._free(this.textPtr)
      this.textCap = Math.max(bytes, 4096)
      this.textPtr = this.m._malloc(this.textCap)
    }
    const heap = this.m.HEAPU16
    const base = this.textPtr / 2
    for (let i = 0; i < text.length; i++) heap[base + i] = text.charCodeAt(i)
    this.lastText = text
    return this.textPtr
  }

  /** A JS string in wasm memory as UTF-8, for the call it's passed to only. */
  cString<T>(s: string, fn: (ptr: number) => T): T {
    const n = this.m.lengthBytesUTF8(s) + 1
    const p = this.m._malloc(n)
    try {
      this.m.stringToUTF8(s, p, n)
      return fn(p)
    } finally {
      this.m._free(p)
    }
  }
}

export class Face {
  readonly info: FaceInfo
  private fonts = new Map<string, Font>()

  constructor(
    private hb: HarfBuzz,
    readonly ptr: number,
  ) {
    const m = hb.m
    const name = (id: number) => {
      const cap = 1024
      const buf = m._malloc(cap)
      try {
        const len = m._px_face_name(ptr, id, buf, cap)
        return len ? new TextDecoder().decode(m.HEAPU8.slice(buf, buf + len)) : ''
      } finally {
        m._free(buf)
      }
    }
    const table = (tag: string, cap: number): DataView | null => {
      const buf = m._malloc(cap)
      try {
        const len = m._px_face_table(ptr, tagNumber(tag), buf, cap)
        if (!len) return null
        return new DataView(m.HEAPU8.slice(buf, buf + Math.min(len, cap)).buffer)
      } finally {
        m._free(buf)
      }
    }
    const os2 = table('OS/2', 96)
    const head = table('head', 54)
    const u16 = (v: DataView | null, at: number) => (v && v.byteLength >= at + 2 ? v.getUint16(at) : 0)
    const n = m._px_face_axes(ptr)
    const raw = hb.out()
    const axes: Axis[] = []
    for (let i = 0; i < n; i++) {
      const o = i * 7
      axes.push({ tag: tagString(raw[o], raw[o + 1]), min: raw[o + 2], default: raw[o + 3], max: raw[o + 4], name: name(raw[o + 5]) || tagString(raw[o], raw[o + 1]) })
    }
    const instances: Instance[] = []
    const ni = m._px_face_instances(ptr)
    for (let i = 0; i < ni; i++) {
      const id = m._px_face_instance(ptr, i)
      const c = hb.out()
      instances.push({ name: name(id) || `Instance ${i + 1}`, coords: Object.fromEntries(axes.map((a, k) => [a.tag, c[k] ?? a.default])) })
    }
    const fsSelection = u16(os2, 62)
    this.info = {
      family: name(16) || name(1),
      subfamily: name(17) || name(2),
      full: name(4),
      postscript: name(6),
      upem: m._px_face_upem(ptr),
      glyphs: m._px_face_glyphs(ptr),
      weight: u16(os2, 4) || 400,
      width: u16(os2, 6) || 5,
      italic: (fsSelection & 1) !== 0 || (u16(head, 44) & 2) !== 0,
      fsType: u16(os2, 8),
      axes,
      instances,
    }
  }

  /** A table of the face's file, whole (the Glyphs panel reads its cmap); null when the font hasn't one. */
  tableBytes(tag: string): Uint8Array | null {
    const m = this.hb.m
    const read = (cap: number) => {
      const buf = m._malloc(Math.max(1, cap))
      try {
        const len = m._px_face_table(this.ptr, tagNumber(tag), buf, cap)
        return { len, bytes: m.HEAPU8.slice(buf, buf + Math.min(len, cap)) }
      } finally {
        m._free(buf)
      }
    }
    const first = read(4096)
    if (!first.len) return null
    return first.len <= 4096 ? first.bytes : read(first.len).bytes
  }

  /** The face at a set of variation coordinates (axes not given stay at their defaults), made once. */
  font(variations: Record<string, number> = {}): Font {
    const key = Object.entries(variations)
      .filter(([t]) => this.info.axes.some((a) => a.tag === t))
      .sort()
      .map(([t, v]) => `${t}=${v}`)
      .join(',')
    let f = this.fonts.get(key)
    if (!f) {
      f = new Font(this.hb, this, this.hb.m._px_font(this.ptr))
      if (key) {
        const pairs = Object.entries(variations).filter(([t]) => this.info.axes.some((a) => a.tag === t))
        const arr = new Float32Array(pairs.length * 3)
        pairs.forEach(([t, v], i) => {
          const n = tagNumber(t)
          arr.set([n >>> 16, n & 0xffff, v], i * 3)
        })
        const p = this.hb.m._malloc(Math.max(4, arr.byteLength))
        this.hb.m.HEAPF32.set(arr, p / 4)
        this.hb.m._px_font_variations(f.ptr, p, pairs.length)
        this.hb.m._free(p)
      }
      this.fonts.set(key, f)
    }
    return f
  }

  destroy() {
    for (const f of this.fonts.values()) f.destroy()
    this.fonts.clear()
    this.hb.m._px_face_destroy(this.ptr)
  }
}

export class Font {
  private outlines = new Map<number, GlyphOutline>()
  private metricsCache: Metrics | null = null

  constructor(
    private hb: HarfBuzz,
    readonly face: Face,
    readonly ptr: number,
  ) {}

  metrics(): Metrics {
    if (this.metricsCache) return this.metricsCache
    this.hb.m._px_font_metrics(this.ptr)
    const v = this.hb.out()
    this.metricsCache = { ascender: v[0], descender: v[1], lineGap: v[2], xHeight: v[3], capHeight: v[4], underlineOffset: v[5], underlineSize: v[6], strikeOffset: v[7], strikeSize: v[8] }
    return this.metricsCache
  }

  /**
   * Shapes `length` UTF-16 units of `text` from `offset`, seeing the rest of
   * it as context. `script` is an ISO 15924 tag (Latn, Arab...) or empty
   * for HarfBuzz to guess; `features` are HarfBuzz feature strings.
   */
  shape(text: string, offset: number, length: number, dir: 'ltr' | 'rtl', script = '', lang = '', features: string[] = []): ShapedGlyph[] {
    const hb = this.hb
    const tp = hb.textIn(text)
    const n = hb.cString(lang, (lp) => hb.cString(features.join(','), (fp) => hb.m._px_shape(this.ptr, tp, text.length, offset, length, dir === 'rtl' ? 5 : 4, script.length === 4 ? tagNumber(script) : 0, lp, fp)))
    const v = hb.out()
    const out: ShapedGlyph[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const o = i * 6
      out[i] = { gid: v[o], cluster: v[o + 1], ax: v[o + 2], ay: v[o + 3], dx: v[o + 4], dy: v[o + 5] }
    }
    return out
  }

  hasGlyph(codePoint: number): boolean {
    return this.hb.m._px_has_glyph(this.ptr, codePoint) === 1
  }

  /** A glyph's outline in font units, y up, quadratics raised to cubics; made once. */
  outline(gid: number): GlyphOutline {
    const hit = this.outlines.get(gid)
    if (hit) return hit
    this.hb.m._px_glyph_outline(this.ptr, gid)
    const v = this.hb.out()
    const out: number[] = []
    let x = 0
    let y = 0
    for (let i = 0; i < v.length; ) {
      const op = v[i]
      if (op === 0 || op === 1) {
        x = v[i + 1]
        y = v[i + 2]
        out.push(op, x, y)
        i += 3
      } else if (op === 2) {
        // A quadratic raised to a cubic: handles two thirds of the way to its control point.
        const cx = v[i + 1]
        const cy = v[i + 2]
        const ex = v[i + 3]
        const ey = v[i + 4]
        out.push(3, x + ((cx - x) * 2) / 3, y + ((cy - y) * 2) / 3, ex + ((cx - ex) * 2) / 3, ey + ((cy - ey) * 2) / 3, ex, ey)
        x = ex
        y = ey
        i += 5
      } else if (op === 3) {
        out.push(3, v[i + 1], v[i + 2], v[i + 3], v[i + 4], v[i + 5], v[i + 6])
        x = v[i + 5]
        y = v[i + 6]
        i += 7
      } else {
        out.push(4)
        i += 1
      }
    }
    this.outlines.set(gid, out)
    return out
  }

  destroy() {
    this.hb.m._px_font_destroy(this.ptr)
  }
}

/** HarfBuzz, from the wasm's bytes (the checks) or its URL, compiled as it downloads (as startCms). */
export async function startHarfBuzz(wasm: ArrayBuffer | Uint8Array | { url: string }): Promise<HarfBuzz> {
  return new HarfBuzz(await createPxHb('url' in wasm ? { locateFile: () => wasm.url } : { wasmBinary: wasm }))
}

/**
 * Whether a face's licence lets it travel inside an editable document (OS/2
 * fsType). Its low bits say how it may be embedded, the least restrictive
 * winning: installable (none set) and editable (8) may; preview & print
 * only (4) and restricted (2) may not, nor may bitmap-only embedding (0x200).
 */
export function embeddable(fsType: number): boolean {
  if (fsType & 0x0200) return false
  const usage = fsType & 0x000f
  return usage === 0 || (usage & 0x0008) !== 0
}
