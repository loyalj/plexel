/**
 * The colour engine: LittleCMS, compiled to WebAssembly (native/pxcms),
 * wrapped so the rest of the app never sees a pointer.
 *
 * Nothing outside src/color touches it. Profiles and transforms hold wasm
 * memory and are closed explicitly; the registry in profiles.ts keeps the
 * ones in use and closes what it replaces. Transforms are float in and
 * float out, in Plexel's conventions rather than LittleCMS's: every
 * channel 0..1 (CMYK too: LittleCMS's 0..100 is converted here), and Lab in
 * its own units, L 0..100 and a, b about -128..127.
 *
 * The same code runs on the page, in workers and in Node; only how the
 * wasm bytes arrive differs, so the caller passes them in.
 */
import createPxCms, { type PxCmsModule } from './wasm/pxcms.mjs'

export type ColourSpace = 'rgb' | 'gray' | 'cmyk' | 'lab' | 'xyz' | 'other'
export type ProfileClass = 'display' | 'output' | 'input' | 'space' | 'abstract' | 'link' | 'named' | 'other'

/** ICC rendering intents, in their ICC numbering. */
export const INTENT = { perceptual: 0, relative: 1, saturation: 2, absolute: 3 } as const
export type Intent = keyof typeof INTENT

/** LittleCMS transform flags we use. */
export const FLAGS = {
  blackPointCompensation: 0x2000,
  gamutCheck: 0x1000,
  softProofing: 0x4000,
  noCache: 0x0040,
  highPrecision: 0x0400,
  noOptimise: 0x0100,
} as const

const SPACES: Record<number, ColourSpace> = {
  0x52474220: 'rgb',
  0x47524159: 'gray',
  0x434d594b: 'cmyk',
  0x4c616220: 'lab',
  0x58595a20: 'xyz',
}
const SPACE_SIGNATURE: Record<'rgb' | 'gray' | 'cmyk' | 'lab', number> = {
  rgb: 0x52474220,
  gray: 0x47524159,
  cmyk: 0x434d594b,
  lab: 0x4c616220,
}
const CLASSES: Record<number, ProfileClass> = {
  0x6d6e7472: 'display',
  0x70727472: 'output',
  0x73636e72: 'input',
  0x73706163: 'space',
  0x61627374: 'abstract',
  0x6c696e6b: 'link',
  0x6e6d636c: 'named',
}

export class CmsError extends Error {}

/** A tone curve: a gamma, one of ICC's parametric curves, or a table of 0..1 values. */
export type Curve = { gamma: number } | { parametric: number; params: number[] } | { table: Float32Array | number[] }

export interface Chromaticity {
  x: number
  y: number
}

export class Cms {
  constructor(private m: PxCmsModule) {
    m._px_init()
  }

  private fail(what: string): never {
    const err = this.m.UTF8ToString(this.m._px_last_error())
    this.m._px_clear_error()
    throw new CmsError(err ? `${what}: ${err}` : what)
  }

  /** Copies bytes into wasm memory; the caller frees. */
  private alloc(bytes: Uint8Array): number {
    const ptr = this.m._malloc(bytes.length || 1)
    this.m.HEAPU8.set(bytes, ptr)
    return ptr
  }

  private allocF32(values: ArrayLike<number>): number {
    const ptr = this.m._malloc(Math.max(4, values.length * 4))
    this.m.HEAPF32.set(values, ptr >> 2)
    return ptr
  }

  private allocF64(values: ArrayLike<number>): number {
    const ptr = this.m._malloc(Math.max(8, values.length * 8))
    this.m.HEAPF64.set(values, ptr >> 3)
    return ptr
  }

  private allocString(s: string): number {
    const n = this.m.lengthBytesUTF8(s) + 1
    const ptr = this.m._malloc(n)
    this.m.stringToUTF8(s, ptr, n)
    return ptr
  }

  private wrap(handle: number, what: string): Profile {
    if (!handle) this.fail(what)
    return new Profile(this.m, handle)
  }

  /** A profile from ICC bytes. Throws CmsError, saying why, if they aren't a profile. */
  openProfile(bytes: Uint8Array): Profile {
    const ptr = this.alloc(bytes)
    try {
      return this.wrap(this.m._px_open(ptr, bytes.length), 'This is not a usable ICC profile')
    } finally {
      this.m._free(ptr)
    }
  }

  srgb(): Profile {
    return this.wrap(this.m._px_srgb(), 'sRGB')
  }

  /** CIE Lab under D50, the profile connection space: for converting to and from Lab values. */
  lab(): Profile {
    return this.wrap(this.m._px_lab_d50(), 'Lab')
  }

  private curve(c: Curve, fn: (type: number, params: number, count: number, table: number) => number): number {
    const params = 'gamma' in c ? [c.gamma] : 'parametric' in c ? c.params : []
    const type = 'gamma' in c ? 1 : 'parametric' in c ? c.parametric : 0
    const table = 'table' in c ? c.table : []
    const pp = this.allocF64(params)
    const tp = this.allocF32(table)
    try {
      return fn(type, pp, table.length, tp)
    } finally {
      this.m._free(pp)
      this.m._free(tp)
    }
  }

  rgbProfile(o: { white: Chromaticity; red: Chromaticity; green: Chromaticity; blue: Chromaticity; curve: Curve; description: string; copyright: string }): Profile {
    const d = this.allocString(o.description)
    const c = this.allocString(o.copyright)
    try {
      const h = this.curve(o.curve, (type, params, count, table) =>
        this.m._px_rgb(o.white.x, o.white.y, o.red.x, o.red.y, o.green.x, o.green.y, o.blue.x, o.blue.y, type, params, count, table, d, c),
      )
      return this.wrap(h, `The profile “${o.description}” could not be made`)
    } finally {
      this.m._free(d)
      this.m._free(c)
    }
  }

  grayProfile(o: { white: Chromaticity; curve: Curve; description: string; copyright: string }): Profile {
    const d = this.allocString(o.description)
    const c = this.allocString(o.copyright)
    try {
      const h = this.curve(o.curve, (type, params, count, table) => this.m._px_gray(o.white.x, o.white.y, type, params, count, table, d, c))
      return this.wrap(h, `The profile “${o.description}” could not be made`)
    } finally {
      this.m._free(d)
      this.m._free(c)
    }
  }

  /**
   * An output profile from lookup tables (see px_clut_profile): `a2b` maps
   * device values to normalised Lab, on `a2bPoints` per input channel;
   * `b2a` maps normalised Lab to device values 0..1, on `b2aPoints` per axis.
   */
  clutProfile(o: { space: 'cmyk' | 'rgb' | 'gray'; channels: number; a2bPoints: number; a2b: Float32Array; b2aPoints: number; b2a: Float32Array; description: string; copyright: string }): Profile {
    const a = this.allocF32(o.a2b)
    const b = this.allocF32(o.b2a)
    const d = this.allocString(o.description)
    const c = this.allocString(o.copyright)
    try {
      return this.wrap(this.m._px_clut_profile(SPACE_SIGNATURE[o.space], o.channels, o.a2bPoints, a, o.b2aPoints, b, d, c), `The profile “${o.description}” could not be made`)
    } finally {
      for (const p of [a, b, d, c]) this.m._free(p)
    }
  }

  transform(from: Profile, to: Profile, intent: Intent = 'relative', flags = 0): Transform {
    const t = this.m._px_transform(from.handle, to.handle, INTENT[intent], flags)
    if (!t) this.fail(`No transform from “${from.description}” to “${to.description}”`)
    return new Transform(this.m, t, from, to)
  }

  /**
   * A transform that shows on `to` how `proof` would reproduce colours in
   * `from`. With FLAGS.gamutCheck, colours outside `proof`'s gamut come out
   * as the alarm colour instead.
   */
  proofTransform(from: Profile, to: Profile, proof: Profile, intent: Intent, proofIntent: Intent, flags = FLAGS.softProofing): Transform {
    const t = this.m._px_proof(from.handle, to.handle, proof.handle, INTENT[intent], INTENT[proofIntent], flags)
    if (!t) this.fail(`No proofing transform through “${proof.description}”`)
    return new Transform(this.m, t, from, to)
  }

  /** The colour a gamut check marks with, as device values 0..1. */
  setAlarm(r: number, g: number, b: number) {
    const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 65535)
    this.m._px_set_alarm(q(r), q(g), q(b))
  }
}

export class Profile {
  readonly space: ColourSpace
  readonly pcs: ColourSpace
  readonly kind: ProfileClass
  readonly channels: number
  readonly version: number
  readonly description: string
  private closed = false

  constructor(
    private m: PxCmsModule,
    readonly handle: number,
  ) {
    this.space = SPACES[m._px_space(handle)] ?? 'other'
    this.pcs = SPACES[m._px_pcs(handle)] ?? 'other'
    this.kind = CLASSES[m._px_class(handle)] ?? 'other'
    this.channels = m._px_channels(handle)
    this.version = m._px_version(handle)
    const buf = m._malloc(256)
    m._px_description(handle, buf, 256)
    this.description = m.UTF8ToString(buf) || 'Unnamed profile'
    m._free(buf)
  }

  /** The profile as ICC bytes, for embedding in a file. */
  bytes(): Uint8Array {
    const out = this.m._malloc(4)
    try {
      const len = this.m._px_save(this.handle, out)
      if (!len) {
        const why = this.m.UTF8ToString(this.m._px_last_error())
        this.m._px_clear_error()
        throw new CmsError(`The profile “${this.description}” could not be saved${why ? `: ${why}` : ''}`)
      }
      const ptr = this.m.HEAPU32[out >> 2]
      const bytes = this.m.HEAPU8.slice(ptr, ptr + len)
      this.m._free(ptr)
      return bytes
    } finally {
      this.m._free(out)
    }
  }

  supportsIntent(intent: Intent, direction: 'input' | 'output' = 'output') {
    return this.m._px_supports_intent(this.handle, INTENT[intent], direction === 'input' ? 0 : 1) !== 0
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.m._px_close(this.handle)
  }
}

/** Scales between Plexel's 0..1 CMYK and LittleCMS's 0..100. Other spaces pass through. */
const cmykScale = (p: Profile) => (p.space === 'cmyk' ? 100 : 1)

export class Transform {
  readonly inChannels: number
  readonly outChannels: number
  private closed = false
  private inScale: number
  private outScale: number

  constructor(
    private m: PxCmsModule,
    private handle: number,
    from: Profile,
    to: Profile,
  ) {
    this.inChannels = from.channels
    this.outChannels = to.channels
    this.inScale = cmykScale(from)
    this.outScale = 1 / cmykScale(to)
  }

  /** Converts `count` colours, packed channel after channel, and returns them the same way. */
  run(input: ArrayLike<number>, count = input.length / this.inChannels): Float32Array {
    if (this.closed) throw new CmsError('The transform has been closed')
    const inLen = count * this.inChannels
    const outLen = count * this.outChannels
    const inPtr = this.m._malloc(Math.max(4, inLen * 4))
    const outPtr = this.m._malloc(Math.max(4, outLen * 4))
    try {
      const heapIn = this.m.HEAPF32.subarray(inPtr >> 2, (inPtr >> 2) + inLen)
      if (this.inScale === 1) heapIn.set(input as ArrayLike<number>)
      else for (let i = 0; i < inLen; i++) heapIn[i] = input[i] * this.inScale
      this.m._px_do(this.handle, inPtr, outPtr, count)
      // Read HEAPF32 again: a memory growth during the call replaces it.
      const out = this.m.HEAPF32.slice(outPtr >> 2, (outPtr >> 2) + outLen)
      if (this.outScale !== 1) for (let i = 0; i < outLen; i++) out[i] *= this.outScale
      return out
    } finally {
      this.m._free(inPtr)
      this.m._free(outPtr)
    }
  }

  /** One colour. */
  one(values: number[]): number[] {
    return [...this.run(values, 1)]
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.m._px_free_transform(this.handle)
  }
}

/** Starts a colour engine from the wasm bytes, which the caller fetches or reads as its platform allows. */
/**
 * The engine, from the wasm's bytes (the checks, in Node) or its URL: given
 * the URL, the module is compiled as it downloads (instantiateStreaming)
 * rather than after.
 */
export async function startCms(wasm: ArrayBuffer | Uint8Array | { url: string }): Promise<Cms> {
  return new Cms(await createPxCms('url' in wasm ? { locateFile: () => wasm.url } : { wasmBinary: wasm }))
}
