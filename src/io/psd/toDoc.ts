/**
 * A parsed PSD (format.ts) as a Plexel document.
 *
 *   groups            group nodes (pass-through, knockout), clipped layers
 *                     nested under the layer they're clipped to
 *   pixel layers      tile sets, placed by their transform (pixels off the
 *                     canvas kept)
 *   masks             pixel masks (density, feather, disabled, inverted
 *                     default) and vector masks
 *   fill and shape    vector nodes: the path (subpaths combined by their
 *   layers            operations), a fill (colour or gradient) and a stroke
 *   adjustments       Levels, Curves, Brightness/Contrast, Exposure,
 *                     Invert, Posterize, Threshold, Hue/Saturation,
 *                     Vibrance, Colour Balance, Black & White, Channel
 *                     Mixer, Gradient Map
 *   layer effects     all ten of Photoshop's, from lfx2
 *   text              text nodes: point or area, runs with their font,
 *                     size, leading, tracking, colour; paragraphs with
 *                     alignment, indents and spacing
 *   smart objects     embedded nodes whose contents are the embedded PSD,
 *                     PSB or image, placed by their corners
 *
 * Pixels go through `host` (the engine makes tile sets, converts colours,
 * opens nested files), so this file stays pure. What can't be brought over
 * is said, once each.
 */
import type { ColourValue } from '../../color/value'
import { booleanPaths } from '../../geom/boolean'
import type { PathData, Subpath } from '../../geom/path'
import { makeNode } from '../../doc/nodes'
import type { CurvePoints, GradientStop, LevelsValue, ParamColour } from '../../doc/params'
import type { CharProps, Paragraph, ParaProps, Run, TextContent } from '../../doc/text'
import type { Affine, BlendModeId, ColourMode, ColourTag, Depth, Doc, DocChannel, DocNode, LayerFx, NodeId, ProfileRef } from '../../doc/types'
import type { AppearanceItem, Paint, PaintStop } from '../../doc/vector'
import { Reader } from './bin'
import type { Guide } from '../../doc/types'
import { block, readBrightness, readColourBalance, readCurves, readExposure, readGradientMap, readHueSat, readLevels, readLinkedFiles, readMixer, readPath, readSmartObject, readTypeTool, sectionDivider, unicodeName, versionedDescriptor, type PsdPath } from './blocks'
import { bool, en, list, num, obj, objs, str, unit, type Descriptor } from './descriptor'
import { warpFromPsd } from './warp'
import { at, eArr, eNum, type EValue } from './engineData'
import { BLEND_KEYS, PSD_MODE, type PsdFile, type PsdLayer, type PsdSamples } from './format'
import { clamp01 } from '../../lib/num'

export interface PsdHost {
  /**
   * A w × h region's planes (colour channels in the document's terms, then
   * alpha, or null for opaque) as a tile set of the document's format;
   * samples are 0..max. Null when there's nothing in it.
   */
  pixels(mode: ColourMode, depth: Depth, w: number, h: number, planes: PsdSamples[], alpha: PsdSamples | null, max: number): string | null
  /** A mask's plane (0..max) as gray 8-bit coverage tiles. */
  mask(w: number, h: number, plane: PsdSamples, max: number): string | null
  /** A colour into the document's terms (CMYK as ink, all 0..1). */
  colour(v: ColourValue): ParamColour
  /** Lab planes (L 0..100, a and b ±128, from 0..max samples) into the working RGB, as 0..1 planes. */
  labToRgb(L: PsdSamples, a: PsdSamples, b: PsdSamples, max: number): Float32Array[]
  /** A nested file for a smart object, opened as a document in this one's mode and depth; null if it can't be. */
  open(bytes: Uint8Array, name: string, into: { mode: ColourMode; depth: Depth; profile: ProfileRef }): Promise<Doc | null>
  /** The document's profile, from its embedded ICC bytes (or null for the mode's working space). */
  profile(icc: Uint8Array | null, mode: ColourMode): ProfileRef
  /** The working RGB, CMYK and Gray profiles, for colours a file gives without one. */
  working: Record<ColourMode, ProfileRef>
  newId(prefix: string): string
  /** How far through the layers it is, 0..1; may throw to stop (a cancelled open). */
  progress?(fraction: number): Promise<void>
}

export interface PsdImport {
  doc: Doc
  warnings: string[]
  /** PostScript names of the fonts its text asks for, for the page to find. */
  fonts: string[]
}

const BLEND_ENUM: Record<string, BlendModeId> = {
  Nrml: 'normal',
  Dslv: 'dissolve',
  Drkn: 'darken',
  Mltp: 'multiply',
  CBrn: 'color-burn',
  linearBurn: 'linear-burn',
  darkerColor: 'darker-color',
  Lghn: 'lighten',
  Scrn: 'screen',
  CDdg: 'color-dodge',
  linearDodge: 'linear-dodge',
  lighterColor: 'lighter-color',
  Ovrl: 'overlay',
  SftL: 'soft-light',
  HrdL: 'hard-light',
  vividLight: 'vivid-light',
  linearLight: 'linear-light',
  pinLight: 'pin-light',
  hardMix: 'hard-mix',
  Dfrn: 'difference',
  Xclu: 'exclusion',
  blendSubtraction: 'subtract',
  blendDivide: 'divide',
  'H   ': 'hue',
  Strt: 'saturation',
  'Clr ': 'color',
  Lmns: 'luminosity',
}
export const BLEND_ENUM_OF: Record<string, string> = Object.fromEntries(Object.entries(BLEND_ENUM).map(([k, v]) => [v, k]))

const TAGS: (ColourTag | null)[] = [null, 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray']


export async function psdToDoc(f: PsdFile, host: PsdHost): Promise<PsdImport> {
  const warnings = new Set<string>()
  const warn = (w: string) => warnings.add(w)
  const fonts = new Set<string>()

  // --- mode, depth, profile, resolution -------------------------------------------------------
  let mode: ColourMode
  let depth: Depth = f.depth === 8 || f.depth === 1 ? 8 : 16
  switch (f.mode) {
    case PSD_MODE.rgb:
    case PSD_MODE.indexed:
    case PSD_MODE.lab:
      mode = 'rgb'
      break
    case PSD_MODE.cmyk:
      mode = 'cmyk'
      break
    default:
      mode = 'gray'
  }
  if (f.mode === PSD_MODE.lab) warn('Lab documents open as RGB in the working space; Plexel has no Lab mode yet')
  if (f.mode === PSD_MODE.indexed) warn('An indexed-colour document opens as RGB')
  if (f.mode === PSD_MODE.duotone) warn('A duotone opens as its grayscale; the duotone inks are left out')
  if (f.mode === PSD_MODE.multichannel) warn('A multichannel document opens as Gray, from its first channel')
  if (f.mode === PSD_MODE.bitmap) warn('A bitmap opens as Gray')
  if (f.depth === 32) warn('A 32-bit document opens at 16 bits, its light encoded for display; values above white are clipped')
  if (f.depth === 1) depth = 8
  const iccRes = f.resources.find((r) => r.id === 1039)
  const profile = f.mode === PSD_MODE.lab || f.mode === PSD_MODE.indexed ? host.working.rgb : host.profile(f.mode === PSD_MODE.duotone || f.mode === PSD_MODE.multichannel ? null : (iccRes?.data ?? null), mode)
  const resolution = (() => {
    const r = f.resources.find((x) => x.id === 1005)
    if (!r || r.data.length < 16) return 72
    const rd = new Reader(r.data)
    const res = rd.u32() / 65536
    const u = rd.u16()
    return u === 2 ? res * 2.54 : res
  })()
  const globalAngle = (() => {
    const r = f.resources.find((x) => x.id === 1037)
    return r && r.data.length >= 4 ? new Reader(r.data).i32() : 120
  })()
  const palette = f.mode === PSD_MODE.indexed ? f.colorModeData : null
  const max = f.depth === 16 ? 65535 : f.depth === 32 ? 1 : 255

  /** A file's channel planes in the document's terms. */
  const colourPlanes = (planes: (PsdSamples | null)[], n: number): { planes: PsdSamples[]; max: number } => {
    const p = planes.map((x) => x ?? new Uint8Array(n))
    if (f.mode === PSD_MODE.cmyk) {
      // PSD keeps CMYK inverted: 0 is all ink.
      return { planes: p.slice(0, 4).map((x) => x.map((v) => max - v) as PsdSamples), max }
    }
    if (f.mode === PSD_MODE.indexed && palette) {
      const idx = p[0]
      const out = [0, 1, 2].map((c) => Uint8Array.from(idx, (i) => palette[c * 256 + i]))
      return { planes: out, max: 255 }
    }
    if (f.mode === PSD_MODE.lab) {
      const rgb = host.labToRgb(p[0], p[1], p[2], max)
      return { planes: rgb.map((x) => Uint16Array.from(x, (v) => Math.round(clamp01(v) * 65535))), max: 65535 }
    }
    if (f.depth === 32) {
      // Linear light to display-encoded (the sRGB curve), clipped.
      const enc = (v: number) => {
        const x = clamp01(v)
        return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
      }
      return { planes: p.slice(0, mode === 'rgb' ? 3 : 1).map((x) => Uint16Array.from(x, (v) => Math.round(enc(v) * 65535))), max: 65535 }
    }
    return { planes: p.slice(0, mode === 'rgb' ? 3 : mode === 'cmyk' ? 4 : 1), max }
  }
  const outDepth: Depth = f.mode === PSD_MODE.lab ? 16 : depth
  if (f.mode === PSD_MODE.lab && f.depth === 8) warn('A Lab document opens at 16 bits, so its conversion keeps its precision')
  depth = outDepth

  // --- colours ---------------------------------------------------------------------------------
  const docTerms = (space: ColourValue['space'], c: number[]): ParamColour => {
    const prof = space === 'lab' ? null : space === mode ? profile : host.working[space as ColourMode]
    return host.colour({ space, profile: prof, c })
  }
  /** A descriptor colour (RGBC, CMYC, Grsc, LbCl, HSBC, BkCl) in the document's terms. */
  const descColour = (d: Descriptor | undefined): ParamColour => {
    if (!d) return mode === 'cmyk' ? [0, 0, 0, 1] : mode === 'gray' ? [0] : [0, 0, 0]
    switch (d.cls) {
      case 'RGBC': {
        const r = num(d, 'Rd  ', num(d, 'redFloat') * 255)
        const g = num(d, 'Grn ', num(d, 'greenFloat') * 255)
        const b = num(d, 'Bl  ', num(d, 'blueFloat') * 255)
        return docTerms('rgb', [r / 255, g / 255, b / 255].map(clamp01))
      }
      case 'CMYC':
        return docTerms('cmyk', [num(d, 'Cyn '), num(d, 'Mgnt'), num(d, 'Ylw '), num(d, 'Blck')].map((v) => clamp01(v / 100)))
      case 'Grsc':
        return docTerms('gray', [clamp01(1 - num(d, 'Gry ') / 100)])
      case 'LbCl':
      case 'BkCl':
        return docTerms('lab', [num(d, 'Lmnc'), num(d, 'A   '), num(d, 'B   ')])
      case 'HSBC': {
        const h = (num(d, 'H   ') / 360) * 6
        const s = num(d, 'Strt') / 100
        const v = num(d, 'Brgh') / 100
        const i = Math.floor(h) % 6
        const fr = h - Math.floor(h)
        const p = v * (1 - s)
        const q = v * (1 - s * fr)
        const t = v * (1 - s * (1 - fr))
        const rgb = [
          [v, t, p],
          [q, v, p],
          [p, v, t],
          [p, q, v],
          [t, p, v],
          [v, p, q],
        ][i]
        return docTerms('rgb', rgb)
      }
      default:
        warn(`A colour in the ${d.cls} model was read as black`)
        return descColour(undefined)
    }
  }
  /** A gradient-map or gradient stop's colour (space id and four 16-bit values). */
  const stopColour = (space: number, v: number[]): ParamColour => {
    if (space === 0) return docTerms('rgb', v.slice(0, 3).map((x) => x / 65535))
    if (space === 2) return docTerms('cmyk', v.slice(0, 4).map((x) => 1 - x / 65535))
    if (space === 8) return docTerms('gray', [v[0] / 10000])
    if (space === 7) return docTerms('lab', [v[0] / 100, (v[1] - 12800) / 100, (v[2] - 12800) / 100])
    return docTerms('rgb', v.slice(0, 3).map((x) => x / 65535))
  }

  // --- the pieces of a layer -------------------------------------------------------------------
  const nodes: Record<NodeId, DocNode> = {}
  const id = (p: string) => host.newId(p)

  const pathData = (p: PsdPath): PathData => {
    const subs = p.subpaths.filter((s) => s.knots.length)
    const toSub = (s: (typeof subs)[number]): Subpath => ({
      closed: s.closed,
      anchors: s.knots.map((k) => ({
        p: k.anchor,
        in: Math.hypot(k.before[0] - k.anchor[0], k.before[1] - k.anchor[1]) < 1e-6 ? null : k.before,
        out: Math.hypot(k.after[0] - k.anchor[0], k.after[1] - k.anchor[1]) < 1e-6 ? null : k.after,
        smooth: k.linked,
      })),
    })
    const closed = subs.filter((s) => s.closed)
    const open = subs.filter((s) => !s.closed).map(toSub)
    if (closed.length <= 1) return { fillRule: 'nonzero', subpaths: [...closed.map(toSub), ...open] }
    const OPS = { 0: 'exclude', 1: 'add', 2: 'subtract', 3: 'intersect' } as const
    const combined = booleanPaths(closed.map((s) => ({ path: { fillRule: 'nonzero' as const, subpaths: [toSub(s)] }, op: OPS[s.op as 0 | 1 | 2 | 3] ?? 'add' })))
    return { fillRule: combined.fillRule, subpaths: [...combined.subpaths, ...open] }
  }

  const masksOf = (L: PsdLayer, vector: PsdPath | null, owner: NodeId): NodeId[] => {
    const out: NodeId[] = []
    const m = L.mask
    // The pixel mask: -3 when there's a real one beside a vector mask, otherwise -2.
    const ch = L.channels.find((c) => c.id === (m?.real ? -3 : -2)) ?? L.channels.find((c) => c.id === -2)
    const rect = ch?.id === -3 && m?.real ? m.real : m
    if (m && rect && ch) {
      const w = rect.right - rect.left
      const h = rect.bottom - rect.top
      const flags = ch.id === -3 && m.real ? m.real.flags : m.flags
      const def = ch.id === -3 && m.real ? m.real.defaultColor : m.defaultColor
      const tiles = ch.data && w > 0 && h > 0 ? host.mask(w, h, ch.data, f.depth === 32 ? 1 : max) : null
      const mid = id('m')
      const mask = makeNode('mask', mid, 'Layer Mask', { source: 'pixel', tiles, geometry: null, density: (m.userDensity ?? 255) / 255, feather: m.userFeather ?? 0, invert: false, outside: def >= 128 ? 1 : 0 })
      mask.transform = [1, 0, 0, 1, rect.left, rect.top]
      mask.visible = (flags & 2) === 0
      nodes[mid] = mask
      out.push(mid)
    }
    if (vector) {
      const mid = id('m')
      const mask = makeNode('mask', mid, 'Vector Mask', { source: 'vector', tiles: null, geometry: { kind: 'path', path: pathData(vector) }, density: (m?.vectorDensity ?? 255) / 255, feather: m?.vectorFeather ?? 0, invert: vector.invert, outside: 0 })
      mask.visible = !vector.disabled
      nodes[mid] = mask
      out.push(mid)
    }
    void owner
    return out
  }

  const gradientPaint = (g: Descriptor | undefined, d: Descriptor): Paint => {
    const colours = objs(g, 'Clrs')
    const trans = objs(g, 'Trns')
    const alphaAt = (x: number) => {
      if (!trans.length) return 1
      const ts = trans.map((t) => ({ at: num(t, 'Lctn') / 4096, a: num(t, 'Opct', 100) / 100 })).sort((a, b) => a.at - b.at)
      if (x <= ts[0].at) return ts[0].a
      for (let i = 1; i < ts.length; i++) if (x <= ts[i].at) return ts[i - 1].a + ((ts[i].a - ts[i - 1].a) * (x - ts[i - 1].at)) / (ts[i].at - ts[i - 1].at || 1)
      return ts[ts.length - 1].a
    }
    const stops: PaintStop[] = colours.map((c) => {
      const at = num(c, 'Lctn') / 4096
      return { at, colour: descColour(obj(c, 'Clr ')), alpha: alphaAt(at) }
    })
    if (stops.length < 2) stops.push(...[{ at: 0, colour: descColour(undefined), alpha: 1 }, { at: 1, colour: descColour(undefined), alpha: 1 }].slice(stops.length))
    const t = en(d, 'Type')
    return {
      kind: 'gradient',
      type: t === 'Rdl ' ? 'radial' : t === 'Angl' ? 'angular' : t === 'Dmnd' ? 'diamond' : t === 'Rflc' ? 'reflected' : 'linear',
      stops: stops.sort((a, b) => a.at - b.at),
      angle: unit(d, 'Angl')?.v ?? 90,
      scale: unit(d, 'Scl ')?.v ?? 100,
      reverse: bool(d, 'Rvrs'),
    }
  }

  const fillPaint = (L: PsdLayer): Paint | null => {
    const so = block(L.blocks, 'SoCo')
    if (so) return { kind: 'solid', colour: descColour(obj(versionedDescriptor(so), 'Clr ')) }
    const gd = block(L.blocks, 'GdFl')
    if (gd) {
      const d = versionedDescriptor(gd)
      return gradientPaint(obj(d, 'Grad'), d)
    }
    return null
  }

  const strokeOf = (L: PsdLayer): { fill: boolean; stroke: AppearanceItem | null } => {
    const data = block(L.blocks, 'vstk')
    if (!data) return { fill: true, stroke: null }
    const d = versionedDescriptor(data)
    const fill = bool(d, 'fillEnabled', true)
    if (!bool(d, 'strokeEnabled', true)) return { fill, stroke: null }
    const content = obj(d, 'strokeStyleContent')
    const paint: Paint = content && obj(content, 'Clr ') ? { kind: 'solid', colour: descColour(obj(content, 'Clr ')) } : content && obj(content, 'Grad') ? gradientPaint(obj(content, 'Grad'), content) : { kind: 'solid', colour: descColour(undefined) }
    const w = unit(d, 'strokeStyleLineWidth')
    const width = w ? (w.unit === '#Pnt' ? (w.v * resolution) / 72 : w.v) : 1
    const cap = en(d, 'strokeStyleLineCapType')
    const join = en(d, 'strokeStyleLineJoinType')
    const align = en(d, 'strokeStyleLineAlignment')
    const dashes = list(d, 'strokeStyleLineDashSet').map((v) => (v.t === 'UntF' || v.t === 'doub' ? v.v * width : 0))
    return {
      fill,
      stroke: {
        kind: 'stroke',
        enabled: true,
        paint,
        opacity: num(d, 'strokeStyleOpacity', 100) / 100,
        blend: BLEND_ENUM[en(d, 'strokeStyleBlendMode') ?? 'Nrml'] ?? 'normal',
        width,
        join: join === 'strokeStyleRoundJoin' ? 'round' : join === 'strokeStyleBevelJoin' ? 'bevel' : 'miter',
        cap: cap === 'strokeStyleRoundCap' ? 'round' : cap === 'strokeStyleSquareCap' ? 'square' : 'butt',
        miter: num(d, 'strokeStyleMiterLimit', 100) / 25,
        dash: dashes.some((x) => x > 0) ? dashes : [],
        dashOffset: num(d, 'strokeStyleLineDashOffset') * width,
        align: align === 'strokeStyleAlignInside' ? 'inside' : align === 'strokeStyleAlignOutside' ? 'outside' : 'centre',
      } as AppearanceItem,
    }
  }

  // --- layer effects -----------------------------------------------------------------------------
  const blendOf = (d: Descriptor, key = 'Md  ') => BLEND_ENUM[en(d, key) ?? 'Nrml'] ?? 'normal'
  const pct = (d: Descriptor, key: string, dflt: number) => unit(d, key)?.v ?? dflt
  const px = (d: Descriptor, key: string, dflt: number) => unit(d, key)?.v ?? dflt
  const angleOf = (d: Descriptor) => (bool(d, 'uglg', true) ? globalAngle : (unit(d, 'lagl')?.v ?? globalAngle))
  const effectsOf = (L: PsdLayer): LayerFx[] => {
    const data = block(L.blocks, 'lfx2', 'lmfx')
    if (!data) return []
    let d: Descriptor
    try {
      d = versionedDescriptor(data, 4)
    } catch {
      warn('A layer’s effects couldn’t be read')
      return []
    }
    const all = bool(d, 'masterFXSwitch', true)
    const out: LayerFx[] = []
    // A "multi" list (newer files, several of one effect) or the single descriptor.
    const each = (single: string, multi: string) => {
      const many = objs(d, multi)
      return many.length ? many : obj(d, single) ? [obj(d, single)!] : []
    }
    // Photoshop keeps every effect a layer has ever had, switched off; only those on come over.
    const add = (kind: string, e: Descriptor, params: Record<string, unknown>) => {
      if (bool(e, 'enab', true)) out.push({ kind, enabled: all, params })
    }
    for (const e of each('DrSh', 'dropShadowMulti'))
      add('drop-shadow', e, { blend: blendOf(e), colour: descColour(obj(e, 'Clr ')), opacity: pct(e, 'Opct', 75), angle: angleOf(e), distance: px(e, 'Dstn', 5), spread: pct(e, 'Ckmt', 0), size: px(e, 'blur', 5) })
    for (const e of each('IrSh', 'innerShadowMulti'))
      add('inner-shadow', e, { blend: blendOf(e), colour: descColour(obj(e, 'Clr ')), opacity: pct(e, 'Opct', 75), angle: angleOf(e), distance: px(e, 'Dstn', 5), choke: pct(e, 'Ckmt', 0), size: px(e, 'blur', 5) })
    for (const e of each('OrGl', 'outerGlowMulti'))
      add('outer-glow', e, { blend: blendOf(e), colour: descColour(obj(e, 'Clr ')), opacity: pct(e, 'Opct', 75), spread: pct(e, 'Ckmt', 0), size: px(e, 'blur', 5) })
    for (const e of each('IrGl', 'innerGlowMulti'))
      add('inner-glow', e, { blend: blendOf(e), colour: descColour(obj(e, 'Clr ')), opacity: pct(e, 'Opct', 75), source: en(e, 'glwS') === 'SrcC' ? 'centre' : 'edge', choke: pct(e, 'Ckmt', 0), size: px(e, 'blur', 5) })
    for (const e of each('ChFX', 'satinMulti'))
      add('satin', e, { blend: blendOf(e), colour: descColour(obj(e, 'Clr ')), opacity: pct(e, 'Opct', 50), angle: unit(e, 'lagl')?.v ?? 19, distance: px(e, 'Dstn', 11), size: px(e, 'blur', 14), invert: bool(e, 'Invr', true) })
    for (const e of each('SoFi', 'solidFillMulti')) add('colour-overlay', e, { blend: blendOf(e), colour: descColour(obj(e, 'Clr ')), opacity: pct(e, 'Opct', 100) })
    for (const e of each('GrFl', 'gradientFillMulti')) {
      const g = gradientPaint(obj(e, 'Grad'), e) as Extract<Paint, { kind: 'gradient' }>
      add('gradient-overlay', e, { blend: blendOf(e), opacity: pct(e, 'Opct', 100), gradient: g.stops.map((s): GradientStop => ({ at: s.at, colour: s.colour })), angle: unit(e, 'Angl')?.v ?? 90, scale: Math.min(150, Math.max(10, unit(e, 'Scl ')?.v ?? 100)), reverse: bool(e, 'Rvrs') })
    }
    for (const e of each('patternFill', 'patternFillMulti')) {
      warn('Pattern Overlay came in with one of Plexel’s patterns; Photoshop’s patterns are images Plexel can’t use yet')
      add('pattern-overlay', e, { blend: blendOf(e), opacity: pct(e, 'Opct', 100), pattern: 'checker', scale: unit(e, 'Scl ')?.v ?? 100, angle: unit(e, 'Angl')?.v ?? 0 })
    }
    for (const e of each('FrFX', 'frameFXMulti')) {
      const st = en(e, 'Styl')
      if (en(e, 'PntT') && en(e, 'PntT') !== 'SClr') warn('A gradient or pattern stroke effect came in as a colour')
      add('stroke', e, { size: px(e, 'Sz  ', 3), position: st === 'InsF' ? 'inside' : st === 'CtrF' ? 'centre' : 'outside', blend: blendOf(e), opacity: pct(e, 'Opct', 100), colour: descColour(obj(e, 'Clr ')) })
    }
    for (const e of each('ebbl', 'bevelEmbossMulti')) {
      const s = en(e, 'bvlS')
      if (s === 'PlEb' || s === 'strokeEmboss') warn('A pillow or stroke emboss came in as an emboss')
      add('bevel', e, {
        style: s === 'OtrB' ? 'outer' : s === 'Embs' || s === 'PlEb' || s === 'strokeEmboss' ? 'emboss' : 'inner',
        depth: pct(e, 'srgR', 100),
        direction: en(e, 'bvlD') === 'Out ' ? 'down' : 'up',
        size: px(e, 'blur', 5),
        soften: px(e, 'Sftn', 0),
        angle: angleOf(e),
        altitude: unit(e, 'Lald')?.v ?? 30,
        highlightBlend: blendOf(e, 'hglM'),
        highlightColour: descColour(obj(e, 'hglC')),
        highlightOpacity: pct(e, 'hglO', 75),
        shadowBlend: blendOf(e, 'sdwM'),
        shadowColour: descColour(obj(e, 'sdwC')),
        shadowOpacity: pct(e, 'sdwO', 75),
      })
    }
    return out
  }

  // --- adjustments -------------------------------------------------------------------------------
  const channelNames = mode === 'rgb' ? ['master', 'red', 'green', 'blue'] : mode === 'cmyk' ? ['master', 'cyan', 'magenta', 'yellow', 'black'] : ['master']
  const adjustmentOf = (L: PsdLayer): { adjustment: string; params: Record<string, unknown> } | null => {
    const b = (k: string) => block(L.blocks, k)
    let data: Uint8Array | null
    if ((data = b('levl'))) {
      const recs = readLevels(data)
      const lv: Record<string, LevelsValue> = {}
      const identity = (r: (typeof recs)[number] | undefined) => !r || (r.inBlack === 0 && r.inWhite === 255 && r.outBlack === 0 && r.outWhite === 255 && Math.abs(r.gamma - 1) < 1e-6)
      // A grayscale document's one channel is the second record; the first (the composite) is usually left alone.
      if (mode === 'gray' && identity(recs[0]) && !identity(recs[1])) recs[0] = recs[1]
      channelNames.forEach((ch, i) => {
        const r = recs[i]
        if (r) lv[ch] = { inBlack: r.inBlack / 255, inWhite: r.inWhite / 255, gamma: r.gamma, outBlack: r.outBlack / 255, outWhite: r.outWhite / 255 }
      })
      return { adjustment: 'levels', params: { levels: lv } }
    }
    if ((data = b('curv'))) {
      const cs = readCurves(data)
      const cv: Record<string, CurvePoints> = {}
      if (mode === 'gray' && cs.has(1) && (!cs.has(0) || cs.get(0)!.length <= 2)) cs.set(0, cs.get(1)!)
      for (const [i, pts] of cs) if (channelNames[i]) cv[channelNames[i]] = pts.map(([x, y]) => [x / 255, y / 255] as [number, number]).sort((a, b) => a[0] - b[0])
      return { adjustment: 'curves', params: { curves: cv } }
    }
    if ((data = b('CgEd'))) {
      const d = versionedDescriptor(data)
      return { adjustment: 'brightness-contrast', params: { brightness: num(d, 'Brgh'), contrast: num(d, 'Cntr'), legacy: bool(d, 'useLegacy') } }
    }
    // Only the old block: from before CS3, so the legacy version.
    if ((data = b('brit'))) return { adjustment: 'brightness-contrast', params: { ...readBrightness(data), legacy: true } }
    if ((data = b('expA'))) return { adjustment: 'exposure', params: readExposure(data) }
    if (b('nvrt')) return { adjustment: 'invert', params: {} }
    if ((data = b('post'))) return { adjustment: 'posterize', params: { levels: new Reader(data).u16() } }
    if ((data = b('thrs'))) return { adjustment: 'threshold', params: { level: new Reader(data).u16() } }
    if ((data = b('hue2'))) {
      const h = readHueSat(data)
      const v = h.colorize ? h.colorization : h.master
      // Each colour range's own settings, in Photoshop's order (reds round to magentas); its hue limits are Plexel's own.
      const p: Record<string, unknown> = { hue: v[0], saturation: v[1], lightness: v[2], colorize: h.colorize }
      if (!h.colorize) ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'].forEach((r, i) => {
        const x = h.ranges[i] ?? [0, 0, 0]
        p[`${r}Hue`] = x[0]
        p[`${r}Saturation`] = x[1]
        p[`${r}Lightness`] = x[2]
        if (h.limits[i]) p[`${r}Limits`] = h.limits[i]
      })
      return { adjustment: 'hue-saturation', params: p }
    }
    if ((data = b('vibA'))) {
      const d = versionedDescriptor(data)
      return { adjustment: 'vibrance', params: { vibrance: num(d, 'vibrance'), saturation: num(d, 'Strt') } }
    }
    if ((data = b('blnc'))) {
      const c = readColourBalance(data)
      const p: Record<string, unknown> = { preserveLuminosity: c.luminosity }
      for (const [k, v] of [
        ['shadows', c.shadows],
        ['midtones', c.midtones],
        ['highlights', c.highlights],
      ] as const) {
        p[`${k}CyanRed`] = v[0]
        p[`${k}MagentaGreen`] = v[1]
        p[`${k}YellowBlue`] = v[2]
      }
      return { adjustment: 'colour-balance', params: p }
    }
    if ((data = b('blwh'))) {
      const d = versionedDescriptor(data)
      const tint = obj(d, 'tintColor')
      let hue = 0
      let sat = 0
      if (tint) {
        const c = [num(tint, 'Rd  '), num(tint, 'Grn '), num(tint, 'Bl  ')].map((x) => x / 255)
        const mx = Math.max(...c)
        const mn = Math.min(...c)
        const l = (mx + mn) / 2
        sat = mx === mn ? 0 : ((mx - mn) / (1 - Math.abs(2 * l - 1))) * 100
        const dd = mx - mn || 1
        hue = mx === c[0] ? ((c[1] - c[2]) / dd) % 6 : mx === c[1] ? (c[2] - c[0]) / dd + 2 : (c[0] - c[1]) / dd + 4
        hue = (hue * 60 + 360) % 360
      }
      return {
        adjustment: 'black-white',
        params: { reds: num(d, 'Rd  ', 40), yellows: num(d, 'Yllw', 60), greens: num(d, 'Grn ', 40), cyans: num(d, 'Cyn ', 60), blues: num(d, 'Bl  ', 20), magentas: num(d, 'Mgnt', 80), tint: bool(d, 'useTint'), tintHue: hue, tintSaturation: Math.min(100, sat) },
      }
    }
    if ((data = b('mixr'))) {
      const m = readMixer(data)
      const p: Record<string, unknown> = { monochrome: m.monochrome }
      const outs = m.monochrome ? ['gray'] : ['red', 'green', 'blue']
      outs.forEach((o, i) => {
        const r = m.rows[i] ?? [0, 0, 0, 0, 0]
        p[`${o}FromRed`] = r[0]
        p[`${o}FromGreen`] = r[1]
        p[`${o}FromBlue`] = r[2]
        p[`${o}Constant`] = r[4]
      })
      return { adjustment: 'channel-mixer', params: p }
    }
    if ((data = b('grdm'))) {
      const g = readGradientMap(data)
      return { adjustment: 'gradient-map', params: { gradient: g.stops.map((s) => ({ at: s.at, colour: stopColour(s.space, s.values) })), reverse: g.reverse } }
    }
    if ((data = b('selc'))) {
      // Version, method, then ten records of cyan, magenta, yellow and black: the first unused, then reds round to blacks.
      const r = new Reader(data)
      r.u16()
      const p: Record<string, unknown> = { method: r.u16() === 1 ? 'absolute' : 'relative' }
      r.skip(8)
      for (const range of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks']) {
        if (r.left < 8) break
        for (const ink of ['cyan', 'magenta', 'yellow', 'black']) p[`${range}_${ink}`] = r.i16()
      }
      return { adjustment: 'selective-colour', params: p }
    }
    for (const [k, name] of [
      ['clrL', 'Colour Lookup'],
    ])
      if (b(k)) {
        warn(`${name} adjustment layers aren’t in Plexel yet; they were left out`)
        return { adjustment: '', params: {} }
      }
    return null
  }

  // --- text --------------------------------------------------------------------------------------
  const textOf = (L: PsdLayer): DocNode | null => {
    const data = block(L.blocks, 'TySh')
    if (!data) return null
    const t = readTypeTool(data)
    const ed = t.engine
    const fontSet = eArr(at(ed, 'ResourceDict', 'FontSet'))
    const fontName = (i: number) => {
      const name = at(fontSet, i, 'Name')
      return typeof name === 'string' ? name : 'Myriad Pro'
    }
    const raw = (typeof at(ed, 'EngineDict', 'Editor', 'Text') === 'string' ? (at(ed, 'EngineDict', 'Editor', 'Text') as string) : str(t.text, 'Txt ')).replace(/\r$/, '')
    // The scale in the transform (Photoshop's points to pixels, and any scaling) goes into the sizes.
    const [xx, xy, yx, yy, tx, ty] = t.transform
    const s = Math.sqrt(Math.abs(xx * yy - xy * yx)) || 1
    const transform: Affine = [xx / s, xy / s, yx / s, yy / s, tx, ty]
    // Style runs over the text.
    const styleRuns = eArr(at(ed, 'EngineDict', 'StyleRun', 'RunArray'))
    const styleLens = eArr(at(ed, 'EngineDict', 'StyleRun', 'RunLengthArray')).map((x) => eNum(x))
    const paraRuns = eArr(at(ed, 'EngineDict', 'ParagraphRun', 'RunArray'))
    const paraLens = eArr(at(ed, 'EngineDict', 'ParagraphRun', 'RunLengthArray')).map((x) => eNum(x))
    let fill: ParamColour | null = null
    let mixed = false
    const charProps = (sd: EValue | undefined): Partial<CharProps> => {
      const d = at(sd, 'StyleSheet', 'StyleSheetData')
      const ps = fontName(eNum(at(d, 'Font')))
      fonts.add(ps)
      const fc = eArr(at(d, 'FillColor', 'Values')).map((x) => eNum(x))
      if (fc.length) {
        const c = mode === 'cmyk' ? docTerms('cmyk', fc.slice(1, 5)) : mode === 'gray' ? docTerms('gray', [fc[1]]) : docTerms('rgb', fc.slice(1, 4))
        if (fill && c.some((v, i) => Math.abs(v - fill![i]) > 1e-3)) mixed = true
        fill ??= c
      }
      const size = eNum(at(d, 'FontSize'), 12) * s
      const lead = at(d, 'Leading')
      const auto = at(d, 'AutoLeading') !== false
      return {
        font: ps,
        style: '',
        size,
        leading: auto || typeof lead !== 'number' ? null : lead * s,
        tracking: eNum(at(d, 'Tracking')),
        kerning: eNum(at(d, 'AutoKerning'), 1) || at(d, 'AutoKerning') === undefined ? 'metrics' : 'none',
        baselineShift: eNum(at(d, 'BaselineShift')) * s,
        horizontalScale: eNum(at(d, 'HorizontalScale'), 1) * 100,
        verticalScale: eNum(at(d, 'VerticalScale'), 1) * 100,
        underline: at(d, 'Underline') === true,
        strikethrough: at(d, 'Strikethrough') === true,
      }
    }
    const paraProps = (pd: EValue | undefined): Partial<ParaProps> => {
      const p = at(pd, 'ParagraphSheet', 'Properties')
      const j = eNum(at(p, 'Justification'))
      return {
        align: j === 1 ? 'right' : j === 2 ? 'centre' : j === 6 ? 'justify-all' : j >= 3 ? 'justify' : 'left',
        indentFirst: eNum(at(p, 'FirstLineIndent')) * s,
        indentLeft: eNum(at(p, 'StartIndent')) * s,
        indentRight: eNum(at(p, 'EndIndent')) * s,
        spaceBefore: eNum(at(p, 'SpaceBefore')) * s,
        spaceAfter: eNum(at(p, 'SpaceAfter')) * s,
      }
    }
    // Paragraphs split at returns; each gets its paragraph run's settings and its share of the style runs.
    const full = raw + '\r'
    const paragraphs: Paragraph[] = []
    let pos = 0
    let pi = 0
    let pRunEnd = paraLens[0] ?? full.length
    const styleAt = (p: number) => {
      let acc = 0
      for (let i = 0; i < styleLens.length; i++) {
        acc += styleLens[i]
        if (p < acc) return i
      }
      return Math.max(0, styleLens.length - 1)
    }
    while (pos < full.length) {
      const end = full.indexOf('\r', pos)
      const stop = end < 0 ? full.length : end
      const text = full.slice(pos, stop).replace(/\u0003/g, '\u2028')
      while (pos >= pRunEnd && pi < paraLens.length - 1) {
        pi++
        pRunEnd += paraLens[pi]
      }
      const runs: Run[] = []
      let k = pos
      while (k < stop) {
        const si = styleAt(k)
        let acc = 0
        for (let i = 0; i <= si; i++) acc += styleLens[i] ?? 0
        const runEnd = Math.min(stop, styleLens.length ? acc : stop)
        runs.push({ text: full.slice(k, Math.max(runEnd, k + 1)).replace(/\u0003/g, '\u2028'), style: null, props: charProps(styleRuns[si]) })
        k = Math.max(runEnd, k + 1)
      }
      if (!runs.length) runs.push({ text: '', style: null, props: charProps(styleRuns[styleAt(Math.max(0, pos - 1))]) })
      paragraphs.push({ runs, style: null, props: paraProps(paraRuns[pi]) })
      void text
      pos = stop + 1
    }
    if (mixed) warn('Text with several colours came in in its first colour; colour per character comes later')
    const content: TextContent = { paragraphs }
    // Point or box text.
    const shape = at(ed, 'EngineDict', 'Rendered', 'Shapes', 'Children', 0, 'Cookie', 'Photoshop')
    const box = eArr(at(shape, 'BoxBounds')).map((x) => eNum(x))
    const isBox = eNum(at(shape, 'ShapeType')) === 1 && box.length === 4
    const n = makeNode('text', id('t'), L.name, {
      mode: isBox ? 'area' : 'point',
      content,
      frame: isBox ? { kind: 'shape', shape: { type: 'rect', x: box[0] * s, y: box[1] * s, w: (box[2] - box[0]) * s, h: (box[3] - box[1]) * s, radii: [0, 0, 0, 0], corner: 'round' } } : null,
      pathOffset: 0,
      appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: fill ?? descColour(undefined) }, opacity: 1, blend: 'normal' }],
    })
    n.transform = transform
    // Warped text: the Warp effect, over the text's bounds (in its own coordinates, as Photoshop keeps them).
    const tw = obj(t.text, 'warp')
    if (tw && en(tw, 'warpStyle') && en(tw, 'warpStyle') !== 'warpNone') {
      const b = obj(t.text, 'bounds') ?? obj(t.text, 'boundingBox')
      const l = num(b, 'Left') * s
      const tp = num(b, 'Top ') * s
      const r = num(b, 'Rght') * s
      const bt = num(b, 'Btom') * s
      const params = r > l && bt > tp ? warpFromPsd(tw, [r - l, 0, 0, bt - tp, l, tp], null) : null
      if (params) warps.set(n.id, params)
      else warn('Warped text came in unwarped: its bounds weren’t in the file')
    }
    return n
  }

  // --- warps --------------------------------------------------------------------------------------
  /** Warp effects for the layers that have one (smart objects' perspective and warp, warped text), by node. */
  const warps = new Map<NodeId, Record<string, unknown>>()

  // --- smart objects -----------------------------------------------------------------------------
  const linked = new Map<string, { name: string; data: Uint8Array | null; external: boolean }>()
  for (const b of f.blocks) if (b.key === 'lnk2' || b.key === 'lnkD' || b.key === 'lnk3') for (const l of readLinkedFiles(b.data)) linked.set(l.id, l)
  const smartOf = async (L: PsdLayer): Promise<DocNode | null> => {
    // SoLd (or SoLE) has the full settings; an older PlLd alone isn't enough to place the contents.
    const data = block(L.blocks, 'SoLd', 'SoLE')
    if (!data) {
      warn('A smart object from an old version of Photoshop came in as its pixels')
      return null
    }
    let d: Descriptor
    try {
      d = readSmartObject(data)
    } catch {
      warn('A smart object’s settings couldn’t be read; it came in as its pixels')
      return null
    }
    const uid = str(d, 'Idnt')
    const file = linked.get(uid)
    if (!file || !file.data) {
      warn(file?.external ? 'A smart object linked to a file outside the document came in as its pixels' : 'A smart object’s contents weren’t in the file; it came in as its pixels')
      return null
    }
    const content = await host.open(file.data, file.name, { mode, depth, profile })
    if (!content) {
      warn(`A smart object’s contents (“${file.name}”) couldn’t be opened; it came in as its pixels`)
      return null
    }
    if (objs(d, 'filterFX').length || obj(d, 'filterFX')) warn('Smart filters were left out')
    const corners = list(d, 'Trnf').map((v) => (v.t === 'doub' ? v.v : 0))
    const sz = obj(d, 'Sz  ')
    const w = num(sz, 'Wdth', content.width) || content.width
    const h = num(sz, 'Hght', content.height) || content.height
    let transform: Affine = [1, 0, 0, 1, L.left, L.top]
    let skew = false
    if (corners.length === 8) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = corners
      transform = [(x1 - x0) / w, (y1 - y0) / w, (x3 - x0) / h, (y3 - y0) / h, x0, y0]
      // A fourth corner off the parallelogram: a perspective, kept in the Warp effect.
      skew = Math.hypot(x0 + (x1 - x0) + (x3 - x0) - x2, y0 + (y1 - y0) + (y3 - y0) - y2) > 0.5
    }
    if (content.width !== w || content.height !== h) transform = [(transform[0] * w) / content.width, (transform[1] * w) / content.width, (transform[2] * h) / content.height, (transform[3] * h) / content.height, transform[4], transform[5]]
    const n = makeNode('embedded', id('s'), L.name, { asset: null, content })
    n.transform = transform
    // The corners in the contents' own pixels, through the transform's inverse; the warp over the contents' rectangle.
    const [a, b, c, dd, e, ff] = transform
    const det = a * dd - b * c || 1e-12
    const local = skew
      ? [0, 1, 2, 3].flatMap((i) => {
          const x = corners[2 * i] - e
          const y = corners[2 * i + 1] - ff
          return [(dd * x - c * y) / det, (-b * x + a * y) / det]
        })
      : null
    const params = warpFromPsd(obj(d, 'warp'), [content.width, 0, 0, content.height, 0, 0], local)
    if (params) warps.set(n.id, params)
    return n
  }

  // --- each layer --------------------------------------------------------------------------------
  const pixelNode = (L: PsdLayer, name: string): DocNode => {
    const w = L.right - L.left
    const h = L.bottom - L.top
    const colourCh = mode === 'rgb' ? 3 : mode === 'cmyk' ? 4 : 1
    const fileCh = f.mode === PSD_MODE.lab ? 3 : f.mode === PSD_MODE.indexed ? 1 : f.mode === PSD_MODE.cmyk ? 4 : f.mode === PSD_MODE.rgb ? 3 : 1
    const planes = Array.from({ length: fileCh }, (_, i) => L.channels.find((c) => c.id === i)?.data ?? null)
    const alpha = L.channels.find((c) => c.id === -1)?.data ?? null
    let tiles: string | null = null
    if (w > 0 && h > 0 && planes.some(Boolean)) {
      const cp = colourPlanes(planes, w * h)
      const a = alpha && f.depth === 32 ? Uint16Array.from(alpha, (v) => Math.round(clamp01(v) * 65535)) : alpha
      tiles = host.pixels(mode, depth, w, h, cp.planes.slice(0, colourCh), a, cp.max === 1 ? 65535 : cp.max)
    }
    const n = makeNode('pixel', id('p'), name, { tiles, resample: 'bicubic' })
    n.transform = [1, 0, 0, 1, L.left, L.top]
    return n
  }

  const nodeFor = async (L: PsdLayer): Promise<DocNode | null> => {
    const name = block(L.blocks, 'luni') ? unicodeName(block(L.blocks, 'luni')!) : L.name
    const vData = block(L.blocks, 'vmsk', 'vsms')
    const vector = vData ? readPath(vData, f.width, f.height) : null
    let n: DocNode | null = null
    let maskVector: PsdPath | null = vector
    const adj = adjustmentOf(L)
    if (adj) {
      if (!adj.adjustment) return null
      n = makeNode('adjustment', id('a'), name, { adjustment: adj.adjustment, params: adj.params })
    } else if (block(L.blocks, 'TySh')) n = textOf(L)
    else if (block(L.blocks, 'SoLd', 'SoLE', 'PlLd')) n = (await smartOf(L)) ?? pixelNode(L, name)
    else {
      const paint = fillPaint(L)
      if (paint) {
        // A fill layer: with a vector mask, a shape; without, the whole canvas, masked.
        const { fill, stroke } = strokeOf(L)
        const appearance: AppearanceItem[] = []
        if (fill) appearance.push({ kind: 'fill', enabled: true, paint, opacity: 1, blend: 'normal' })
        if (stroke) appearance.push(stroke)
        if (vector && !vector.invert) n = makeNode('vector', id('v'), name, { geometry: { kind: 'path', path: pathData(vector) }, appearance, graphicStyle: null })
        // Without an outline of its own it's a fill layer, as in Photoshop: the whole plane, masked.
        else n = makeNode('fill', id('f'), name, { paint })
        if (vector && !vector.invert) maskVector = null
        if (vector?.disabled) maskVector = vector
      } else if (block(L.blocks, 'PtFl')) {
        warn('Pattern fill layers came in as their pixels; Photoshop’s patterns are images Plexel can’t use yet')
        n = pixelNode(L, name)
      } else n = pixelNode(L, name)
    }
    if (!n) return null
    n.name = name
    n.visible = (L.flags & 2) === 0
    n.opacity = L.opacity / 255
    const iOpa = block(L.blocks, 'iOpa')
    if (iOpa) n.fillOpacity = iOpa[0] / 255
    n.blend = (BLEND_KEYS[L.blend] as BlendModeId) ?? 'normal'
    if (n.blend === 'pass-through') n.blend = 'normal'
    const lspf = block(L.blocks, 'lspf')
    if (lspf) {
      const fl = new Reader(lspf).u32()
      n.locked = { pixels: (fl & 2) !== 0, position: (fl & 4) !== 0, all: (fl & 0x80000000) !== 0 }
    }
    const lclr = block(L.blocks, 'lclr')
    if (lclr) n.tag = TAGS[new Reader(lclr).u16()] ?? null
    n.masks = masksOf(L, n.kind === 'vector' && !maskVector ? null : maskVector, n.id)
    n.fx = effectsOf(L)
    nodes[n.id] = n
    const wp = warps.get(n.id)
    if (wp) {
      const e = makeNode('filter', id('w'), wp.style === 'none' ? 'Perspective' : 'Warp', { filter: 'warp', params: wp })
      nodes[e.id] = e
      n.effects = [e.id, ...n.effects]
    }
    return n
  }

  // --- the tree ----------------------------------------------------------------------------------
  const rootId = id('r')
  const root = makeNode('group', rootId, 'Root')
  nodes[rootId] = root
  interface Frame {
    children: NodeId[]
    /** For each child, whether it's clipped to the one below. */
    clipped: boolean[]
  }
  const stack: Frame[] = [{ children: [], clipped: [] }]
  const place = (frame: Frame, nid: NodeId, clipped: boolean) => {
    frame.children.push(nid)
    frame.clipped.push(clipped)
  }
  // Clipped layers become children of the layer they're clipped to (Plexel's clipping is nesting).
  const resolveClipping = (frame: Frame): NodeId[] => {
    const out: NodeId[] = []
    let base: DocNode | null = null
    frame.children.forEach((cid, i) => {
      const c = nodes[cid]
      if (frame.clipped[i] && base) {
        if (base.kind === 'group' || base.kind === 'adjustment') {
          warn('A layer clipped to a group or an adjustment came in unclipped')
          out.push(cid)
          return
        }
        base.children = [...(base.children ?? []), cid]
        return
      }
      base = c
      out.push(cid)
    })
    return out
  }
  if (f.layers.length) {
    let done = 0
    for (const L of f.layers) {
      await host.progress?.(done++ / f.layers.length)
      const lsct = block(L.blocks, 'lsct', 'lsdk')
      const sec = lsct ? sectionDivider(lsct) : null
      if (sec?.type === 3) {
        stack.push({ children: [], clipped: [] })
        continue
      }
      if (sec && (sec.type === 1 || sec.type === 2)) {
        const frame = stack.length > 1 ? stack.pop()! : { children: [], clipped: [] }
        const name = block(L.blocks, 'luni') ? unicodeName(block(L.blocks, 'luni')!) : L.name
        const knko = block(L.blocks, 'knko')
        const g = makeNode('group', id('g'), name, { knockout: knko && knko[0] ? 'shallow' : 'none' })
        g.children = resolveClipping(frame)
        g.visible = (L.flags & 2) === 0
        g.opacity = L.opacity / 255
        const key = sec.blend ?? L.blend
        g.blend = (BLEND_KEYS[key] as BlendModeId) ?? 'pass-through'
        g.masks = masksOf(L, block(L.blocks, 'vmsk', 'vsms') ? readPath(block(L.blocks, 'vmsk', 'vsms')!, f.width, f.height) : null, g.id)
        g.fx = effectsOf(L)
        const lclr = block(L.blocks, 'lclr')
        if (lclr) g.tag = TAGS[new Reader(lclr).u16()] ?? null
        nodes[g.id] = g
        place(stack[stack.length - 1], g.id, L.clipping === 1)
        continue
      }
      const n = await nodeFor(L)
      if (n) place(stack[stack.length - 1], n.id, L.clipping === 1)
    }
    while (stack.length > 1) {
      // A group never closed: its layers go to the one around it.
      const fr = stack.pop()!
      for (let i = 0; i < fr.children.length; i++) place(stack[stack.length - 1], fr.children[i], fr.clipped[i])
      warn('A group in the file wasn’t closed; its layers came in outside it')
    }
  } else if (f.composite) {
    // No layers: the composite is the Background.
    const n = f.width * f.height
    const cp = colourPlanes(f.composite, n)
    const colourCh = mode === 'rgb' ? 3 : mode === 'cmyk' ? 4 : 1
    const tiles = host.pixels(mode, depth, f.width, f.height, cp.planes.slice(0, colourCh), null, cp.max === 1 ? 65535 : cp.max)
    const bg = makeNode('pixel', id('p'), 'Background', { tiles, resample: 'bicubic' })
    nodes[bg.id] = bg
    place(stack[0], bg.id, false)
  }
  root.children = resolveClipping(stack[0])
  const doc: Doc = { name: 'Untitled', width: f.width, height: f.height, resolution, mode, depth, profile, root: rootId, nodes, guides: readGuides(f.resources.find((r) => r.id === 1032)?.data), selection: null }
  const channels = readChannels(f, host, warn)
  if (channels.length) doc.channels = channels
  return { doc, warnings: [...warnings], fonts: [...fonts] }
}

/** How a file shows an alpha or spot channel (image resource 1077, or 1007 before it). */
interface DisplayInfo {
  /** Photoshop's colour space id and its four 16-bit values. */
  space: number
  values: number[]
  /** 0..100: an alpha's tint opacity, a spot's solidity. */
  opacity: number
  /** 0 an alpha whose tint marks what's selected, 1 what's masked, 2 a spot. */
  kind: number
}

/** The channels' names: Unicode (1045) when there, else Pascal (1006). */
export function readChannelNames(f: Pick<PsdFile, 'resources'>): string[] {
  const uni = f.resources.find((r) => r.id === 1045)?.data
  if (uni) {
    const r = new Reader(uni)
    const out: string[] = []
    while (r.left >= 4) out.push(r.unicode().replace(/\0+$/, ''))
    return out
  }
  const pas = f.resources.find((r) => r.id === 1006)?.data
  if (!pas) return []
  const out: string[] = []
  let i = 0
  while (i < pas.length) {
    const n = pas[i]
    out.push(new TextDecoder('latin1').decode(pas.subarray(i + 1, i + 1 + n)))
    i += 1 + n
  }
  return out
}

export function readDisplayInfo(f: Pick<PsdFile, 'resources'>): DisplayInfo[] {
  const read = (r: Reader, padded: boolean): DisplayInfo[] => {
    const out: DisplayInfo[] = []
    while (r.left >= (padded ? 14 : 13)) {
      const space = r.u16()
      const values = [r.u16(), r.u16(), r.u16(), r.u16()]
      const opacity = r.u16()
      const kind = r.u8()
      if (padded) r.u8()
      out.push({ space, values, opacity, kind })
    }
    return out
  }
  const now = f.resources.find((r) => r.id === 1077)?.data
  if (now && now.length >= 4) {
    const r = new Reader(now)
    r.u32()
    return read(r, false)
  }
  const old = f.resources.find((r) => r.id === 1007)?.data
  return old ? read(new Reader(old), true) : []
}

/** A display colour (Photoshop's colour structure) as a colour value in its own space; RGB's and CMYK's under the working profiles. */
function displayColour(d: DisplayInfo, host: PsdHost): ColourValue {
  const v = d.values
  const s16 = (x: number) => (x >= 32768 ? x - 65536 : x)
  switch (d.space) {
    case 2:
      return { space: 'cmyk', profile: host.working.cmyk, c: v.map((x) => 1 - x / 65535) }
    case 7:
      return { space: 'lab', profile: null, c: [v[0] / 100, s16(v[1]) / 100, s16(v[2]) / 100] }
    case 8:
      return { space: 'gray', profile: host.working.gray, c: [1 - v[0] / 10000] }
    case 1: {
      const h = (v[0] / 65535) * 6
      const s = v[1] / 65535
      const b = v[2] / 65535
      const i = Math.floor(h) % 6
      const fr = h - Math.floor(h)
      const p = b * (1 - s)
      const q = b * (1 - s * fr)
      const t = b * (1 - s * (1 - fr))
      const rgb = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][i]
      return { space: 'rgb', profile: host.working.rgb, c: rgb }
    }
    default:
      return { space: 'rgb', profile: host.working.rgb, c: v.slice(0, 3).map((x) => x / 65535) }
  }
}

/**
 * The composite's alpha and spot channels: the planes after its colour
 * (and after the merged transparency, when the layer count said there is
 * one), named and shown as the image resources say. An alpha's plane is
 * how much is selected; a spot's is stored as Photoshop shows it, black
 * full ink, so it's turned round into how much ink.
 */
function readChannels(f: PsdFile, host: PsdHost, warn: (w: string) => void): DocChannel[] {
  if (!f.composite) return []
  const colourCount = f.mode === PSD_MODE.cmyk ? 4 : f.mode === PSD_MODE.rgb || f.mode === PSD_MODE.lab ? 3 : 1
  let first = colourCount + (f.mergedAlpha && f.layers.length ? 1 : 0)
  const names = readChannelNames(f)
  const shows = readDisplayInfo(f)
  // A file whose names count the merged transparency too: it's named first, and isn't a channel.
  const extras = f.channels - first
  const skip = names.length === extras + 1 && f.mergedAlpha ? 1 : 0
  if (extras <= 0) return []
  const max = f.depth === 16 ? 65535 : f.depth === 32 ? 1 : 255
  const out: DocChannel[] = []
  for (let i = 0; i < extras; i++, first++) {
    const plane = f.composite[first]
    if (!plane) continue
    const show = shows[i + skip]
    const spot = show?.kind === 2
    const name = names[i + skip]?.trim() || (spot ? `Spot Colour ${i + 1}` : `Alpha ${i + 1}`)
    const data = spot ? plane.map((v) => max - v) : plane
    const tiles = host.mask(f.width, f.height, data as PsdSamples, max)
    const c: DocChannel = { id: host.newId('ch'), name, tiles, transform: [1, 0, 0, 1, 0, 0] }
    if (spot) {
      c.kind = 'spot'
      c.ink = displayColour(show, host)
      c.opacity = clamp01(show.opacity / 100)
    } else if (show) {
      const ink = displayColour(show, host)
      if (ink.space === 'rgb') c.tint = ink.c.map(clamp01) as [number, number, number]
      if (show.kind === 0) c.marks = 'selected'
      if (show.opacity !== 50) c.opacity = clamp01(show.opacity / 100)
    }
    out.push(c)
  }
  if (out.length && f.mode === PSD_MODE.multichannel) warn('A multichannel document’s other channels came in as alpha channels')
  return out
}


/**
 * Photoshop's guides (image resource 1032): a version, the grid's cycle
 * (unused), a count, then each guide's place in 1/32 pixels and whether it
 * runs down (0) or across (1).
 */
export function readGuides(data: Uint8Array | undefined): Guide[] {
  if (!data || data.length < 16) return []
  const r = new Reader(data)
  r.i32()
  r.i32()
  r.i32()
  const n = r.i32()
  const out: Guide[] = []
  for (let i = 0; i < n && r.left >= 5; i++) {
    const at = r.i32() / 32
    out.push({ axis: r.u8() === 0 ? 'x' : 'y', at })
  }
  return out
}
