/**
 * Brushes written as Photoshop's ABR (version 6.2), the layout io/abr.ts
 * reads: `samp` with every image tip the brushes use, `patt` with every
 * texture's pattern, and `desc`, a descriptor listing the presets with each
 * section of the Brush Settings panel under Photoshop's keys.
 *
 * What Photoshop has no place for goes as near as it can: a control's
 * curve is dropped (Photoshop's controls are straight), and so is a second
 * control on one property or one Photoshop hasn't (Speed, Distance, Random,
 * hardness and the colour properties); a bristle, erodible or airbrush tip
 * goes as a sampled tip of its footprint. Each preset also carries its
 * settings whole under a key of Plexel's own (`plexelBrush`), which
 * Plexel reads back first, so a brush makes the round trip unchanged.
 */
import { type BrushSettings, type Dynamic, type DynInput, type DynTarget } from '../brush/defs'
import { representativeTip } from '../brush/special'
import { textureImage } from '../brush/textures'
import { tipImage } from '../brush/tips'
import { Writer } from './psd/bin'
import { D, writeDescriptor, type DValue } from './psd/descriptor'

export interface AbrOut {
  name: string
  settings: BrushSettings
}

/** Grey images by id: image tips' coverage and patterns' lightness, 0..255. */
export type ImageLookup = (id: string) => { name: string; width: number; height: number; data: Uint8Array } | null

/** Photoshop's control codes (brVr's bVTy), by input. */
const CODE: Partial<Record<DynInput, number>> = { fade: 1, pressure: 2, tilt: 3, wheel: 4, 'initial-direction': 5, direction: 6, 'initial-twist': 7, twist: 8 }

const BLEND: Record<string, string> = {
  normal: 'Nrml', dissolve: 'Dslv', darken: 'Drkn', multiply: 'Mltp', 'color-burn': 'CBrn', 'linear-burn': 'linearBurn', 'darker-color': 'darkerColor', lighten: 'Lghn', screen: 'Scrn', 'color-dodge': 'CDdg', 'linear-dodge': 'linearDodge', 'lighter-color': 'lighterColor',
  overlay: 'Ovrl', 'soft-light': 'SftL', 'hard-light': 'HrdL', 'vivid-light': 'vividLight', 'linear-light': 'linearLight', 'pin-light': 'pinLight', 'hard-mix': 'hardMix', difference: 'Dfrn', exclusion: 'Xclu', subtract: 'blendSubtraction', divide: 'blendDivide', hue: 'H   ', saturation: 'Strt', color: 'Clr ', luminosity: 'Lmns',
}
const TEXTURE: Record<string, string> = { multiply: 'Mltp', subtract: 'Sbtr', darken: 'Drkn', overlay: 'Ovrl', 'color-dodge': 'CDdg', 'color-burn': 'CBrn', 'linear-burn': 'linearBurn', 'hard-mix': 'hardMix', 'linear-height': 'linearHeight', height: 'Hght' }

const pct = (v: number) => D.unit('#Prc', v * 100)

/** A tip's image as 8-bit coverage: the user's from the lookup, a built-in or generated one from its own image. */
function tipBytes(id: string, images: ImageLookup): { name: string; width: number; height: number; data: Uint8Array } | null {
  const user = images(id)
  if (user) return user
  const t = tipImage(id)
  if (!t) return null
  return { name: id, width: t.width, height: t.height, data: Uint8Array.from(t.levels[0], (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)) }
}

/** A texture's pattern as 8-bit lightness: a built-in paper's from its image, an imported one from the lookup. */
function patternBytes(id: string, images: ImageLookup): { name: string; width: number; height: number; data: Uint8Array } | null {
  const user = images(id)
  if (user) return user
  const t = textureImage(id)
  if (!t) return null
  return { name: id, width: t.width, height: t.height, data: Uint8Array.from(t.data, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)) }
}

/** An id Photoshop will take for a tip or pattern: a UUID-like string from ours. */
const abrId = (id: string) => {
  const h = id.replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** Writes brushes as an ABR file, with a note for each thing Photoshop has no place for. */
export function writeAbr(presets: AbrOut[], images: ImageLookup): { bytes: Uint8Array; notes: string[] } {
  const notes: string[] = []
  const note = (s: string) => {
    if (!notes.includes(s)) notes.push(s)
  }
  // Every image tip and pattern the presets use, once each, with the id Photoshop will know it by.
  const tips = new Map<string, { id: string; img: NonNullable<ReturnType<typeof tipBytes>> }>()
  const patterns = new Map<string, { id: string; img: NonNullable<ReturnType<typeof patternBytes>> }>()
  const tipOf = (b: Pick<BrushSettings, 'tip' | 'special'>): string | null => {
    const id = b.special ? representativeTip(b.special) : b.tip
    if (id === 'round') return null
    if (!tips.has(id)) {
      const img = tipBytes(id, images)
      if (img) tips.set(id, { id: abrId(id), img })
    }
    return tips.get(id)?.id ?? null
  }
  const patternOf = (id: string): string | null => {
    if (!patterns.has(id)) {
      const img = patternBytes(id, images)
      if (img) patterns.set(id, { id: abrId(id), img })
    }
    return patterns.get(id)?.id ?? null
  }

  const descs: DValue[] = presets.map(({ name, settings: b }) => {
    const items: [string, DValue][] = [['Nm  ', D.text(name)]]
    // The tip.
    const sampled = tipOf(b)
    if (b.special) note(`Bristle, erodible and airbrush tips go to Photoshop as an image of their footprint`)
    const shape: [string, DValue][] = [['Dmtr', D.unit('#Pxl', b.size)]]
    if (!sampled) shape.push(['Hrdn', pct(b.hardness)])
    shape.push(['Angl', D.unit('#Ang', b.angle)], ['Rndn', pct(b.roundness)], ['Spcn', pct(b.spacing)], ['Intr', D.bool(true)], ['flipX', D.bool(b.flipX)], ['flipY', D.bool(b.flipY)])
    if (sampled) shape.push(['sampledData', D.text(sampled)])
    items.push(['Brsh', D.obj(sampled ? 'sampledBrush' : 'computedBrush', shape)])
    // A property's control, as Photoshop's one per property: the first that maps, straight.
    const used = new Set<Dynamic>()
    const variation = (target: DynTarget, jitter: number): DValue => {
      const ds = b.dynamics.filter((d) => d.target === target)
      const c = ds.find((d) => CODE[d.input] !== undefined)
      if (c) used.add(c)
      return D.obj('brVr', [
        ['bVTy', D.long(c ? CODE[c.input]! : 0)],
        ['fStp', D.long(c?.steps ?? 25)],
        ['jitter', pct(jitter)],
        ['Mnm ', pct(c?.min ?? 0)],
      ])
    }
    const minOf = (target: DynTarget) => b.dynamics.find((d) => d.target === target && CODE[d.input] !== undefined)?.min ?? 0
    items.push(
      ['useTipDynamics', D.bool(true)],
      ['szVr', variation('size', b.sizeJitter)],
      ['minimumDiameter', pct(minOf('size'))],
      ['angleDynamics', variation('angle', b.angleJitter)],
      ['roundnessDynamics', variation('roundness', b.roundnessJitter)],
      ['minimumRoundness', pct(b.minRoundness)],
      ['flipX', D.bool(b.flipXJitter)],
      ['flipY', D.bool(b.flipYJitter)],
    )
    items.push(['useScatter', D.bool(b.scatter > 0 || b.count > 1 || b.countJitter > 0)], ['scatterDynamics', variation('scatter', b.scatter)], ['bothAxes', D.bool(b.scatterBothAxes)], ['Cnt ', D.doub(b.count)], ['countDynamics', variation('count', b.countJitter)])
    if (b.texture) {
      const t = b.texture
      const pid = patternOf(t.id)
      if (!pid) note('A texture whose pattern isn’t in the brush library went without its pattern')
      items.push(
        ['useTexture', D.bool(true)],
        ['TxtC', D.bool(t.eachTip)],
        ['Txtr', D.obj('Ptrn', [['Nm  ', D.text(patterns.get(t.id)?.img.name ?? t.id)], ['Idnt', D.text(pid ?? '')]])],
        ['textureScale', pct(t.scale)],
        ['textureBrightness', D.long(t.brightness)],
        ['textureContrast', D.long(t.contrast)],
        ['InvT', D.bool(t.invert)],
        ['textureBlendMode', D.enum('BlnM', TEXTURE[t.mode] ?? 'Mltp')],
        ['textureDepth', pct(t.depth)],
        ['minimumDepth', pct(t.minDepth)],
        ['textureDepthDynamics', variation('texture-depth', t.depthJitter)],
      )
    } else items.push(['useTexture', D.bool(false)])
    if (b.dual) {
      const d = b.dual
      const dt = tipOf({ tip: d.tip, special: null })
      const ds: [string, DValue][] = [['Dmtr', D.unit('#Pxl', d.size)]]
      if (!dt) ds.push(['Hrdn', pct(d.hardness)])
      ds.push(['Angl', D.unit('#Ang', 0)], ['Rndn', pct(1)], ['Spcn', pct(d.spacing)], ['Intr', D.bool(true)])
      if (dt) ds.push(['sampledData', D.text(dt)])
      items.push([
        'dualBrush',
        D.obj('dualBrush', [
          ['useDualBrush', D.bool(true)],
          ['Flip', D.bool(d.flip)],
          ['Brsh', D.obj(dt ? 'sampledBrush' : 'computedBrush', ds)],
          ['BlnM', D.enum('BlnM', TEXTURE[d.mode] ?? 'Mltp')],
          ['useScatter', D.bool(d.scatter > 0)],
          ['Spcn', pct(d.spacing)],
          ['Cnt ', D.doub(d.count)],
          ['bothAxes', D.bool(d.bothAxes)],
          ['scatterDynamics', D.obj('brVr', [['bVTy', D.long(0)], ['fStp', D.long(25)], ['jitter', pct(d.scatter)]])],
        ]),
      ])
    }
    const colourOn = b.colourJitter > 0 || b.hueJitter > 0 || b.saturationJitter > 0 || b.brightnessJitter > 0 || b.purity !== 0 || b.dynamics.some((d) => d.target === 'colour')
    items.push(['useColorDynamics', D.bool(colourOn)], ['clVr', variation('colour', b.colourJitter)], ['H   ', pct(b.hueJitter)], ['Strt', pct(b.saturationJitter)], ['Brgh', pct(b.brightnessJitter)], ['purity', pct(b.purity)], ['colorDynamicsPerTip', D.bool(b.colourPerTip)])
    items.push(['usePaintDynamics', D.bool(true)], ['opVr', variation('opacity', b.opacityJitter)], ['prVr', variation('flow', b.flowJitter)], ['wtVr', variation('wetness', b.wetnessJitter)], ['mxVr', variation('mix', b.mixJitter)])
    if (b.pose) {
      const p = b.pose
      items.push(
        ['useBrushPose', D.bool(true)],
        ['overridePoseAngle', D.bool(p.rotation !== null)],
        ['overridePoseTiltX', D.bool(p.tiltX !== null)],
        ['overridePoseTiltY', D.bool(p.tiltY !== null)],
        ['overridePosePressure', D.bool(p.pressure !== null)],
        ['brushPoseTiltX', D.doub(p.tiltX ?? 0)],
        ['brushPoseTiltY', D.doub(p.tiltY ?? 0)],
        ['brushPoseAngle', D.doub(p.rotation ?? 0)],
        ['brushPosePressure', pct(p.pressure ?? 1)],
      )
    }
    items.push(['Nose', D.bool(b.noise)], ['Wtdg', D.bool(b.wetEdges)], ['Rpt ', D.bool(b.buildUp)])
    items.push([
      'toolOptions',
      D.obj('null', [
        ['Opct', D.long(b.opacity * 100)],
        ['flow', D.long(b.flow * 100)],
        ['Md  ', D.enum('BlnM', BLEND[b.mode] ?? 'Nrml')],
        ['smoothing', D.bool(b.smoothing > 0)],
        ['smoothingValue', D.long(b.smoothing * 100)],
        ['smoothingRadiusMode', D.bool(b.pulledString)],
      ]),
    ])
    const lost = b.dynamics.filter((d) => !used.has(d))
    if (lost.length) note('Controls Photoshop hasn’t got (Speed, Distance, Random, a second control on one property, or one on hardness or hue, saturation and brightness) were left for Plexel alone')
    if (b.dynamics.some((d) => d.curve.length !== 2 || d.curve[0] !== 0 || d.curve[1] !== 1)) note('Controls’ curves were left for Plexel alone; Photoshop’s are straight')
    // The whole settings, for Plexel to read back unchanged.
    items.push(['plexelBrush', D.text(JSON.stringify(b))])
    return D.obj('brushPreset', items)
  })

  const w = new Writer()
  w.u16(6)
  w.u16(2)
  // Tips.
  w.sig('8BIM')
  w.sig('samp')
  let end = w.mark()
  for (const { id, img } of tips.values()) {
    const item = w.mark()
    const start = w.pos
    w.pascal(id, 1)
    // Subversion 2's preamble, then the bounds, 8-bit, uncompressed.
    w.zeros(264)
    w.i32(0)
    w.i32(0)
    w.i32(img.height)
    w.i32(img.width)
    w.u16(8)
    w.u8(0)
    w.bytes(img.data)
    item()
    w.pad(4, start - 4)
  }
  end()
  // Patterns.
  w.sig('8BIM')
  w.sig('patt')
  end = w.mark()
  for (const { id, img } of patterns.values()) {
    const item = w.mark()
    const start = w.pos
    w.u32(1)
    // Grayscale.
    w.u32(1)
    w.i16(img.height)
    w.i16(img.width)
    w.unicode(img.name)
    w.pascal(id, 1)
    // The virtual memory array list: version, length, bounds, channels, then each (and the two masks, unwritten).
    w.u32(3)
    const vma = w.mark()
    w.i32(0)
    w.i32(0)
    w.i32(img.height)
    w.i32(img.width)
    w.u32(1)
    w.u32(1)
    const ch = w.mark()
    w.u32(8)
    w.i32(0)
    w.i32(0)
    w.i32(img.height)
    w.i32(img.width)
    w.u16(8)
    w.u8(0)
    w.bytes(img.data)
    ch()
    w.u32(0)
    w.u32(0)
    vma()
    item()
    w.pad(4, start - 4)
  }
  end()
  // Presets.
  w.sig('8BIM')
  w.sig('desc')
  end = w.mark()
  w.u32(16)
  writeDescriptor(w, { name: '', cls: 'null', items: [['Brsh', D.list(descs)]] })
  end()
  return { bytes: w.done(), notes }
}
