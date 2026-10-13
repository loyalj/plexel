/**
 * Photoshop's brush files (ABR), read: their tips, their patterns, and
 * their presets' settings mapped onto Plexel's (brush/defs.ts).
 *
 * Versions 1 and 2 are fixed records: computed (round) brushes and sampled
 * ones, a grey image each. Versions 6 to 10 are tagged sections: `samp`,
 * the sampled tips, each named by an id the presets refer to; `patt`, the
 * patterns textures use (as Photoshop's documents keep them); and `desc`, a
 * descriptor (io/psd/descriptor.ts) holding a list of presets with every
 * section of the Brush Settings panel. Adobe hasn't published the modern
 * layout as a whole; this follows what Photoshop writes, as GIMP, Krita,
 * ag-psd and AbrKit read it, and is checked against files Photoshop made.
 *
 * Tips and patterns come out as 8-bit grey with Plexel's own content-hash
 * ids (brush/tips.ts `tipId`), so a tip from an ABR file is the same tip
 * however often it's imported. Whatever can't come over is named.
 */
import { DEFAULT_BRUSH, DEFAULT_DUAL, DEFAULT_TEXTURE, LINEAR, type BrushSettings, type DualMode, type DynInput, type DynTarget, type Dynamic, type TextureMode } from '../brush/defs'
import { tipId } from '../brush/tips'
import { BLEND_MODES, type BlendModeId } from '../doc/types'
import { PsdError, Reader } from './psd/bin'
import { bool, en, get, num, obj, objs, readDescriptor, str, type Descriptor } from './psd/descriptor'
import { unpackBits } from './psd/format'

export interface AbrImage {
  id: string
  name: string
  width: number
  height: number
  /** 8-bit grey: a tip's coverage, a pattern's lightness. */
  data: Uint8Array
}

export interface AbrPreset {
  name: string
  settings: BrushSettings
}

export interface AbrFile {
  version: number
  presets: AbrPreset[]
  tips: AbrImage[]
  patterns: AbrImage[]
  warnings: string[]
}

export class AbrError extends Error {}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** A grey image of `depth` bits, raw or PackBits by row, into 8 bits. */
function readImage(r: Reader, width: number, height: number, depth: number, compression: number): Uint8Array {
  const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * (depth / 8)
  const raw = new Uint8Array(rowBytes * height)
  if (compression === 0) raw.set(r.bytes(rowBytes * height))
  else {
    const counts = Array.from({ length: height }, () => r.u16())
    for (let y = 0; y < height; y++) {
      const start = r.pos
      r.skip(counts[y])
      unpackBits(r.b, start, start + counts[y], raw, y * rowBytes, rowBytes)
    }
  }
  if (depth === 8) return raw
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      out[y * width + x] = depth === 16 ? raw[y * rowBytes + x * 2] : raw[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0
  return out
}

// --- versions 1 and 2 ---------------------------------------------------------------------------

function readLegacy(r: Reader, version: number, out: AbrFile) {
  const count = r.u16()
  for (let i = 0; i < count && r.left >= 6; i++) {
    const type = r.u16()
    const len = r.u32()
    const s = r.sub(Math.min(len, r.left))
    if (type === 1) {
      s.u32()
      const spacing = s.u16()
      const diameter = s.u16()
      const roundness = s.u16()
      const angle = s.u16()
      const hardness = s.u16()
      out.presets.push({
        name: `Round ${diameter}`,
        settings: { ...DEFAULT_BRUSH, tip: 'round', size: Math.max(1, diameter), hardness: clamp01(hardness / 100), roundness: Math.max(0.01, roundness / 100), angle: ((angle + 180) % 360) - 180, spacing: Math.max(0.01, spacing / 100), dynamics: [] },
      })
    } else if (type === 2) {
      s.u32()
      const spacing = s.u16()
      let name = `Sampled ${i + 1}`
      if (version === 2) name = s.unicode() || name
      s.u8()
      s.skip(8)
      const top = s.i32()
      const left = s.i32()
      const bottom = s.i32()
      const right = s.i32()
      const depth = s.u16()
      const compression = s.u8()
      const w = right - left
      const h = bottom - top
      if (w <= 0 || h <= 0 || w > 10000 || h > 10000) {
        out.warnings.push(`A brush tip of an impossible size (${w} × ${h}) was left out`)
        continue
      }
      const data = readImage(s, w, h, depth, compression)
      const id = tipId(w, h, data)
      out.tips.push({ id, name, width: w, height: h, data })
      out.presets.push({ name, settings: { ...DEFAULT_BRUSH, tip: id, size: Math.max(w, h), spacing: Math.max(0.01, spacing / 100), dynamics: [] } })
    } else out.warnings.push(`A brush of a kind Plexel doesn't know (${type}) was left out`)
  }
}

// --- versions 6 to 10: samples and patterns --------------------------------------------------------

function readSamples(s: Reader, sub: number, byAbrId: Map<string, AbrImage>, out: AbrFile) {
  while (s.left >= 4) {
    const len = s.u32()
    const start = s.pos
    if (len === 0 || len > s.left) break
    try {
      const e = s.sub(len)
      const idLen = e.u8()
      const abrId = new TextDecoder('latin1').decode(e.bytes(idLen))
      // A preamble after the id whose size depends on the subversion; then the bounds.
      e.skip(sub === 1 ? 10 : 264)
      const top = e.i32()
      const left = e.i32()
      const bottom = e.i32()
      const right = e.i32()
      const depth = e.u16()
      const compression = e.u8()
      const w = right - left
      const h = bottom - top
      if (w <= 0 || h <= 0 || w > 10000 || h > 10000 || ![1, 8, 16].includes(depth)) out.warnings.push('A brush tip that couldn’t be read was left out')
      else {
        const data = readImage(e, w, h, depth, compression)
        const img = { id: tipId(w, h, data), name: abrId, width: w, height: h, data }
        byAbrId.set(abrId, img)
        if (!out.tips.some((t) => t.id === img.id)) out.tips.push(img)
      }
    } catch {
      out.warnings.push('A brush tip that couldn’t be read was left out')
    }
    s.pos = start + len
    while (s.pos % 4 && s.left) s.pos++
  }
}

/** One channel of a virtual memory array list: its plane, 8-bit, or null when it isn't written. */
function readVmaChannel(r: Reader): { w: number; h: number; data: Uint8Array } | null {
  const written = r.u32()
  if (!written) return null
  const len = r.u32()
  if (!len) return null
  const s = r.sub(len)
  s.u32()
  const top = s.i32()
  const left = s.i32()
  const bottom = s.i32()
  const right = s.i32()
  const depth = s.u16()
  const compression = s.u8()
  const w = right - left
  const h = bottom - top
  if (w <= 0 || h <= 0 || ![1, 8, 16].includes(depth)) return null
  return { w, h, data: readImage(s, w, h, depth, compression) }
}

function readPatterns(s: Reader, out: AbrFile) {
  while (s.left >= 4) {
    const len = s.u32()
    const start = s.pos
    if (len === 0 || len > s.left) break
    try {
      const e = s.sub(len)
      e.u32()
      const mode = e.u32()
      e.i16()
      e.i16()
      const name = e.unicode()
      const id = e.pascal(1)
      const palette = mode === 2 ? e.bytes(768) : null
      // The virtual memory array list: its bounds, then each channel.
      e.u32()
      e.u32()
      e.skip(16)
      const channels = e.u32()
      const planes: ({ w: number; h: number; data: Uint8Array } | null)[] = []
      for (let c = 0; c < channels + 2 && e.left >= 4; c++) planes.push(readVmaChannel(e))
      const first = planes.find((p) => p)
      if (!first) continue
      const { w, h } = first
      const grey = new Uint8Array(w * h)
      const at = (c: number, i: number) => planes[c]?.data[i] ?? 0
      for (let i = 0; i < w * h; i++) {
        if (mode === 3) grey[i] = Math.round(0.299 * at(0, i) + 0.587 * at(1, i) + 0.114 * at(2, i))
        else if (mode === 2 && palette) {
          const k = at(0, i)
          grey[i] = Math.round(0.299 * palette[k] + 0.587 * palette[256 + k] + 0.114 * palette[512 + k])
        } else if (mode === 4) grey[i] = Math.round(((255 - at(0, i)) * 0.299 + (255 - at(1, i)) * 0.587 + (255 - at(2, i)) * 0.114) * ((255 - at(3, i)) / 255))
        else grey[i] = at(0, i)
      }
      out.patterns.push({ id, name: name || id, width: w, height: h, data: grey })
    } catch {
      out.warnings.push('A pattern that couldn’t be read was left out')
    }
    s.pos = start + len
    while (s.pos % 4 && s.left) s.pos++
  }
}

// --- presets ------------------------------------------------------------------------------------------

/** Photoshop's control codes (brVr's bVTy). */
const CONTROL: Record<number, DynInput | null> = { 0: null, 1: 'fade', 2: 'pressure', 3: 'tilt', 5: 'initial-direction', 6: 'direction', 8: 'twist' }

const BLEND_NAMES: Record<string, BlendModeId> = {
  Nrml: 'normal', normal: 'normal', Dslv: 'dissolve', dissolve: 'dissolve', Bhnd: 'normal', Drkn: 'darken', darken: 'darken', Mltp: 'multiply', multiply: 'multiply', CBrn: 'color-burn', colorBurn: 'color-burn', linearBurn: 'linear-burn',
  darkerColor: 'darker-color', Lghn: 'lighten', lighten: 'lighten', Scrn: 'screen', screen: 'screen', CDdg: 'color-dodge', colorDodge: 'color-dodge', linearDodge: 'linear-dodge', lighterColor: 'lighter-color', Ovrl: 'overlay', overlay: 'overlay',
  SftL: 'soft-light', softLight: 'soft-light', HrdL: 'hard-light', hardLight: 'hard-light', vividLight: 'vivid-light', linearLight: 'linear-light', pinLight: 'pin-light', hardMix: 'hard-mix', Dfrn: 'difference', difference: 'difference', Xclu: 'exclusion', exclusion: 'exclusion',
  blendSubtraction: 'subtract', subtract: 'subtract', blendDivide: 'divide', divide: 'divide', H: 'hue', 'H   ': 'hue', hue: 'hue', Strt: 'saturation', saturation: 'saturation', Clr: 'color', 'Clr ': 'color', color: 'color', Lmns: 'luminosity', luminosity: 'luminosity',
}

const TEXTURE_NAMES: Record<string, TextureMode> = { Mltp: 'multiply', multiply: 'multiply', Sbtr: 'subtract', subtract: 'subtract', blendSubtraction: 'subtract', Drkn: 'darken', darken: 'darken', Ovrl: 'overlay', overlay: 'overlay', CDdg: 'color-dodge', colorDodge: 'color-dodge', CBrn: 'color-burn', colorBurn: 'color-burn', linearBurn: 'linear-burn', hardMix: 'hard-mix', linearHeight: 'linear-height', height: 'height', Hght: 'height' }

const pct = (d: Descriptor | undefined, key: string, fallback = 0) => {
  const v = get(d, key)
  return v ? num(d, key, fallback * 100) / 100 : fallback
}

function readPreset(p: Descriptor, byAbrId: Map<string, AbrImage>, warn: (w: string) => void): AbrPreset | null {
  const name = str(p, 'Nm  ', 'Brush')
  const shape = obj(p, 'Brsh')
  if (!shape) return null
  const b: BrushSettings = { ...DEFAULT_BRUSH, dynamics: [] }
  const dynamics: Dynamic[] = []
  const tipOf = (s: Descriptor): string | null => {
    if (s.cls === 'computedBrush') return 'round'
    if (s.cls === 'sampledBrush') {
      const img = byAbrId.get(str(s, 'sampledData'))
      if (img) return img.id
      warn(`“${name}”’s tip wasn’t in the file; it came in round`)
      return 'round'
    }
    warn(`“${name}” is a ${s.cls === 'dBrush' ? 'bristle' : s.cls === 'dTips' ? 'erodible or airbrush' : 'kind of'} tip Plexel hasn’t got; it came in round`)
    return 'round'
  }
  b.tip = tipOf(shape) ?? 'round'
  b.size = Math.max(1, num(shape, 'Dmtr', 30))
  b.hardness = shape.cls === 'computedBrush' ? pct(shape, 'Hrdn', 1) : 1
  b.angle = num(shape, 'Angl', 0)
  b.roundness = Math.max(0.01, pct(shape, 'Rndn', 1))
  b.spacing = bool(shape, 'Intr', true) ? Math.max(0.01, pct(shape, 'Spcn', 0.25)) : 0.25
  b.flipX = bool(shape, 'flipX')
  b.flipY = bool(shape, 'flipY')
  // A variation (brVr): its jitter, minimum, and control as a dynamic on `target`.
  const variation = (v: Descriptor | undefined, target: DynTarget, min: number): number => {
    if (!v) return 0
    const code = num(v, 'bVTy', 0)
    const input = CONTROL[code]
    if (code === 4) warn(`“${name}” is controlled by a stylus wheel, which the browser can’t read; that control was left off`)
    if (code === 7) warn(`“${name}” is controlled by the pen’s rotation when the stroke begins; it follows the pen’s rotation throughout instead`)
    const inp = input ?? (code === 7 ? 'twist' : null)
    if (inp) dynamics.push({ input: inp, target, curve: [...LINEAR], min, ...(inp === 'fade' ? { steps: Math.max(1, num(v, 'fStp', 25)) } : {}) })
    return clamp01(pct(v, 'jitter', 0))
  }
  if (bool(p, 'useTipDynamics')) {
    b.sizeJitter = variation(obj(p, 'szVr'), 'size', pct(p, 'minimumDiameter', 0))
    b.angleJitter = variation(obj(p, 'angleDynamics'), 'angle', 0)
    b.minRoundness = Math.max(0.01, pct(p, 'minimumRoundness', 0.25))
    b.roundnessJitter = variation(obj(p, 'roundnessDynamics'), 'roundness', b.minRoundness)
    b.flipXJitter = bool(p, 'flipX')
    b.flipYJitter = bool(p, 'flipY')
  }
  if (bool(p, 'useScatter')) {
    const sd = obj(p, 'scatterDynamics')
    b.scatter = Math.min(10, pct(sd, 'jitter', 0))
    if (sd) {
      const code = num(sd, 'bVTy', 0)
      const inp = CONTROL[code]
      if (inp) dynamics.push({ input: inp, target: 'scatter', curve: [...LINEAR], min: 0, ...(inp === 'fade' ? { steps: Math.max(1, num(sd, 'fStp', 25)) } : {}) })
    }
    b.scatterBothAxes = bool(p, 'bothAxes')
    b.count = Math.min(16, Math.max(1, Math.round(num(p, 'Cnt ', 1))))
    b.countJitter = variation(obj(p, 'countDynamics'), 'count', 0)
  }
  if (bool(p, 'useTexture')) {
    const t = obj(p, 'Txtr')
    const patId = t ? str(t, 'Idnt') : ''
    const mode = en(p, 'textureBlendMode')
    if (!patId) warn(`“${name}”’s texture names no pattern; it came in with paper`)
    b.texture = {
      ...DEFAULT_TEXTURE,
      id: patId ? `pat:${patId}` : 'paper',
      scale: Math.max(0.01, pct(p, 'textureScale', 1)),
      brightness: Math.max(-150, Math.min(150, num(p, 'textureBrightness', 0))),
      contrast: Math.max(-50, Math.min(100, num(p, 'textureContrast', 0))),
      invert: bool(p, 'InvT'),
      mode: (mode && TEXTURE_NAMES[mode]) || 'multiply',
      depth: clamp01(pct(p, 'textureDepth', 1)),
      minDepth: clamp01(pct(p, 'minimumDepth', 0)),
      eachTip: bool(p, 'TxtC'),
      depthJitter: 0,
    }
    b.texture.depthJitter = variation(obj(p, 'textureDepthDynamics'), 'texture-depth', b.texture.minDepth)
  }
  const dual = obj(p, 'dualBrush')
  if (dual && bool(dual, 'useDualBrush')) {
    const ds = obj(dual, 'Brsh')
    const mode = en(dual, 'BlnM')
    const dm: Record<string, DualMode> = { Mltp: 'multiply', multiply: 'multiply', Drkn: 'darken', darken: 'darken', Ovrl: 'overlay', overlay: 'overlay', CDdg: 'color-dodge', colorDodge: 'color-dodge', CBrn: 'color-burn', colorBurn: 'color-burn', linearBurn: 'linear-burn', hardMix: 'hard-mix', linearHeight: 'linear-height' }
    const sd = obj(dual, 'scatterDynamics')
    b.dual = {
      ...DEFAULT_DUAL,
      tip: ds ? (tipOf(ds) ?? 'round') : 'round',
      size: ds ? Math.max(1, num(ds, 'Dmtr', 25)) : 25,
      hardness: ds?.cls === 'computedBrush' ? pct(ds, 'Hrdn', 1) : 1,
      spacing: Math.max(0.01, pct(dual, 'Spcn', ds ? pct(ds, 'Spcn', 0.25) : 0.25)),
      scatter: bool(dual, 'useScatter') ? Math.min(10, pct(sd, 'jitter', 0)) : 0,
      bothAxes: bool(dual, 'bothAxes'),
      count: Math.min(16, Math.max(1, Math.round(num(dual, 'Cnt ', 1)))),
      mode: (mode && dm[mode]) || 'multiply',
      flip: bool(dual, 'Flip'),
    }
  }
  if (bool(p, 'useColorDynamics')) {
    b.colourJitter = variation(obj(p, 'clVr'), 'colour', 0)
    b.hueJitter = clamp01(pct(p, 'H   ', 0))
    b.saturationJitter = clamp01(pct(p, 'Strt', 0))
    b.brightnessJitter = clamp01(pct(p, 'Brgh', 0))
    b.purity = Math.max(-1, Math.min(1, pct(p, 'purity', 0)))
    b.colourPerTip = bool(p, 'colorDynamicsPerTip', true)
  }
  if (bool(p, 'usePaintDynamics')) {
    b.opacityJitter = variation(obj(p, 'opVr'), 'opacity', pct(obj(p, 'opVr'), 'Mnm ', 0))
    b.flowJitter = variation(obj(p, 'prVr'), 'flow', pct(obj(p, 'prVr'), 'Mnm ', 0))
    b.wetnessJitter = variation(obj(p, 'wtVr'), 'wetness', pct(obj(p, 'wtVr'), 'Mnm ', 0))
    b.mixJitter = variation(obj(p, 'mxVr'), 'mix', pct(obj(p, 'mxVr'), 'Mnm ', 0))
  }
  if (bool(p, 'useBrushPose')) {
    b.pose = {
      tiltX: bool(p, 'overridePoseTiltX') ? Math.max(-90, Math.min(90, num(p, 'brushPoseTiltX', 0))) : null,
      tiltY: bool(p, 'overridePoseTiltY') ? Math.max(-90, Math.min(90, num(p, 'brushPoseTiltY', 0))) : null,
      rotation: bool(p, 'overridePoseAngle') ? ((num(p, 'brushPoseAngle', 0) % 360) + 360) % 360 : null,
      pressure: bool(p, 'overridePosePressure') ? clamp01(pct(p, 'brushPosePressure', 1)) : null,
    }
  }
  b.noise = bool(p, 'Nose')
  b.wetEdges = bool(p, 'Wtdg')
  b.buildUp = bool(p, 'Rpt ')
  const tool = obj(p, 'toolOptions')
  if (tool) {
    b.opacity = clamp01(num(tool, 'Opct', 100) / 100)
    b.flow = clamp01(num(tool, 'flow', 100) / 100)
    const mode = en(tool, 'Md  ')
    if (mode) {
      const m = BLEND_NAMES[mode]
      if (m && BLEND_MODES.includes(m)) b.mode = m
      else warn(`“${name}”’s blend mode wasn’t one Plexel knows; it came in as Normal`)
    }
    if (bool(tool, 'smoothing')) {
      b.smoothing = Math.min(0.95, num(tool, 'smoothingValue', 0) / 100)
      b.pulledString = bool(tool, 'smoothingRadiusMode')
    }
  }
  b.dynamics = dynamics
  return { name, settings: b }
}

/** Reads an ABR file; throws AbrError if it isn't one Plexel can read. */
export function readAbr(bytes: Uint8Array): AbrFile {
  const r = new Reader(bytes)
  const out: AbrFile = { version: 0, presets: [], tips: [], patterns: [], warnings: [] }
  const warn = (w: string) => {
    if (!out.warnings.includes(w)) out.warnings.push(w)
  }
  try {
    out.version = r.u16()
    if (out.version === 1 || out.version === 2) {
      readLegacy(r, out.version, out)
      return out
    }
    if (![6, 7, 9, 10].includes(out.version)) throw new AbrError(`That’s ABR version ${out.version}, which Plexel doesn’t read (1, 2 and 6 to 10 it does)`)
    const sub = r.u16()
    const byAbrId = new Map<string, AbrImage>()
    let presets: Descriptor[] = []
    while (r.left >= 12) {
      const sig = r.sig()
      const key = r.sig()
      const len = Math.min(r.u32(), r.left)
      const s = r.sub(len)
      if (sig !== '8BIM') {
        warn('A part of the file Plexel doesn’t know was left out')
      } else if (key === 'samp') readSamples(s, sub, byAbrId, out)
      else if (key === 'patt') readPatterns(s, out)
      else if (key === 'desc') {
        s.u32()
        presets = objs(readDescriptor(s), 'Brsh')
      }
      while (r.pos % 4 && r.left) r.pos++
    }
    if (presets.length) {
      for (const p of presets) {
        const got = readPreset(p, byAbrId, warn)
        if (got) out.presets.push(got)
      }
    } else {
      // Tips without presets (some older exports): each tip a brush of its own.
      for (const t of out.tips) out.presets.push({ name: t.name, settings: { ...DEFAULT_BRUSH, tip: t.id, size: Math.max(t.width, t.height), dynamics: [] } })
    }
    // Textures name patterns by Photoshop's id: in the file, they become the pattern's; otherwise paper.
    const patIds = new Set(out.patterns.map((p) => p.id))
    for (const p of out.presets) {
      const t = p.settings.texture
      if (t?.id.startsWith('pat:') && !patIds.has(t.id.slice(4))) {
        warn(`“${p.name}”’s texture pattern wasn’t in the file; it came in with paper`)
        p.settings.texture = { ...t, id: 'paper' }
      }
    }
    return out
  } catch (e) {
    if (e instanceof AbrError) throw e
    if (e instanceof PsdError) throw new AbrError(`The file is damaged: ${e.message}`)
    throw e
  }
}

/** A pattern id from an ABR file as Plexel names it ('pat:…', its pixels' hash), and every texture that uses it renamed. */
export function renamePatterns(f: AbrFile, hash: (p: AbrImage) => string): AbrFile {
  const map = new Map(f.patterns.map((p) => [p.id, hash(p)]))
  return {
    ...f,
    patterns: f.patterns.map((p) => ({ ...p, id: map.get(p.id)! })),
    presets: f.presets.map((p) => (p.settings.texture?.id.startsWith('pat:') ? { ...p, settings: { ...p.settings, texture: { ...p.settings.texture, id: map.get(p.settings.texture.id.slice(4)) ?? 'paper' } } } : p)),
  }
}
