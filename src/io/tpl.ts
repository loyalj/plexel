/**
 * Photoshop's tool presets (TPL), read: each preset's tool, and the options
 * of it Plexel has, as a patch over that tool's own (app/toolPresets.ts).
 *
 * A TPL file is "8BTP", a version and a count, then tagged sections as an
 * ABR file's are (io/abr.ts): `tppa` patterns (the `patt` layout), `samp`
 * sampled tips, `tpsh` custom shapes and `tpst` styles (which Plexel leaves
 * out), and `tptp`, the presets: a count, then each a name ("$$$/…=Name",
 * the part after the = shown) and a descriptor whose class is the tool
 * (paintbrushTool, magicWandTool…). A painting tool's descriptor is a brush
 * preset with the tool's options beside it, read as ABR presets are.
 * Adobe hasn't published the layout; this follows files Photoshop writes.
 */
import { DEFAULT_BRUSH, type BrushSettings } from '../brush/defs'
import type { GradientType } from '../doc/vector'
import { BLEND_MODES, type BlendModeId } from '../doc/types'
import type { ToolId } from '../tools'
import { BLEND_NAMES, readPatterns, readPreset, readSamples, share, type AbrFile, type AbrImage } from './abr'
import { PsdError, Reader } from './psd/bin'
import { bool, en, get, num, obj, readDescriptor, str, type Descriptor } from './psd/descriptor'

export interface TplPreset {
  name: string
  tool: ToolId
  /** Photoshop's tool, by its class. */
  from: string
  /** The options, shaped as the tool's preset source takes them (app/toolPresets.ts). */
  options: Record<string, unknown>
}

export interface TplFile {
  presets: TplPreset[]
  tips: AbrImage[]
  patterns: AbrImage[]
  warnings: string[]
}

export class TplError extends Error {}

/** Photoshop's tools, by class, as Plexel's. */
const TOOLS: Record<string, ToolId> = {
  paintbrushTool: 'brush',
  pencilTool: 'brush',
  eraserTool: 'eraser',
  wetBrushTool: 'mixer',
  smudgeTool: 'smudge',
  cloneStampTool: 'clone',
  magicStampTool: 'heal',
  spotHealingBrushTool: 'spot',
  gradientTool: 'gradient',
  GrTl: 'gradient',
  typeCreateOrEditTool: 'type',
  bucketTool: 'bucket',
  marqueeRectTool: 'marquee',
  marqueeEllipTool: 'marquee',
  lassoTool: 'lasso',
  polySelTool: 'lasso',
  magneticLassoTool: 'lasso',
  magicWandTool: 'wand',
  quickSelectTool: 'quick',
  rectangleTool: 'shape',
  roundedRectangleTool: 'shape',
  ellipseTool: 'shape',
  polygonTool: 'shape',
  lineTool: 'shape',
  moveTool: 'move',
}

const PAINTING = new Set(['paintbrushTool', 'pencilTool', 'eraserTool', 'wetBrushTool', 'smudgeTool', 'cloneStampTool', 'magicStampTool', 'spotHealingBrushTool'])

/** The Gradient tool's styles, by enum and by GrdT's number. */
const GRADIENTS: Record<string, GradientType> = { 'Lnr ': 'linear', 'Rdl ': 'radial', Angl: 'angular', Rflc: 'reflected', Dmnd: 'diamond', 0: 'linear', 1: 'radial', 2: 'angular', 3: 'reflected', 4: 'diamond' }
const ALIGNS: Record<string, string> = { Left: 'left', Cntr: 'centre', Rght: 'right', JstL: 'justify', JstC: 'justify', JstR: 'justify', JstA: 'justify-all' }
/** Tools Plexel has whose Photoshop presets hold nothing Plexel keeps for them. */
const NOTHING: Record<string, string> = { cropTool: 'Crop’s sizes and resolutions aren’t kept as presets in Plexel', penTool: 'the Pen’s preset holds a style and a pattern Plexel’s Pen doesn’t keep', customShapeTool: 'custom shapes aren’t read', typeVerticalCreateOrEditTool: 'Plexel has no vertical type' }

const blendOf = (d: Descriptor, key = 'Md  '): BlendModeId | undefined => {
  const m = en(d, key)
  const b = m ? BLEND_NAMES[m] : undefined
  return b && BLEND_MODES.includes(b) ? b : undefined
}
const opacityOf = (d: Descriptor) => (get(d, 'Opct') ? Math.min(1, Math.max(0, num(d, 'Opct', 100) / 100)) : undefined)
/** Only what's there: a patch, not a whole state. */
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
const has = (d: Descriptor, key: string) => !!get(d, key)

/** A preset's options for its tool, or null for a tool Plexel hasn't got. */
function optionsOf(cls: string, d: Descriptor, name: string, byAbrId: Map<string, AbrImage>, warn: (w: string) => void): Record<string, unknown> | null {
  if (PAINTING.has(cls)) {
    const brush: BrushSettings = obj(d, 'Brsh') ? (readPreset(d, byAbrId, warn, d)?.settings ?? { ...DEFAULT_BRUSH }) : { ...DEFAULT_BRUSH }
    // Photoshop's Pencil paints hard, aliased edges: the hardest round tip Plexel has.
    if (cls === 'pencilTool') brush.hardness = 1
    const out: Record<string, unknown> = { brush }
    if (cls === 'wetBrushTool') out.mixer = defined({ wet: share(d, /^wet|wetness/i, 0, 1) ?? undefined, load: share(d, /load/i, 0.01, 1) ?? undefined, mix: share(d, /^mix|mixRatio/i, 0, 1) ?? undefined, sampleAll: has(d, 'sampleAllLayers') ? bool(d, 'sampleAllLayers') : undefined })
    if (cls === 'smudgeTool') out.smudge = defined({ strength: share(d, /^Prs |strength|strn/i, 0, 1) ?? undefined, fingerPainting: has(d, 'fingerPainting') ? bool(d, 'fingerPainting') : undefined, sampleAll: has(d, 'Mrgd') ? bool(d, 'Mrgd') : undefined })
    if (cls === 'cloneStampTool' || cls === 'magicStampTool') out.source = defined({ aligned: has(d, 'Algn') ? bool(d, 'Algn') : undefined })
    return out
  }
  switch (cls) {
    case 'gradientTool':
    case 'GrTl': {
      const t = en(d, 'Type') ?? (has(d, 'GrdT') ? String(num(d, 'GrdT', 0)) : null)
      if (obj(d, 'Grad')) warn(`“${name}”’s own gradient came in as the foreground to background; the Gradient tool keeps presets of its own`)
      const rev = has(d, 'Rvrs') ? bool(d, 'Rvrs') : has(d, 'GrdR') ? num(d, 'GrdR', 0) !== 0 : undefined
      return { gradient: defined({ blend: blendOf(d), opacity: opacityOf(d), reverse: rev, type: t ? GRADIENTS[t] : undefined }) }
    }
    case 'typeCreateOrEditTool': {
      const c = obj(obj(d, 'textToolCharacterOptions'), 'TxtS')
      const p = obj(obj(d, 'textToolParagraphOptions'), 'paragraphStyle')
      const algn = p ? en(p, 'Algn') : null
      // Sizes are points; at 72 pixels an inch a point is a pixel.
      const char = c ? defined({ font: str(c, 'FntN') || undefined, style: str(c, 'FntS') || undefined, size: has(c, 'Sz  ') ? Math.max(0.1, num(c, 'Sz  ', 12)) : undefined, tracking: has(c, 'Trck') ? num(c, 'Trck', 0) : undefined, kerning: en(c, 'AtKr') === 'metricsKern' ? 'metrics' : en(c, 'AtKr') ? 'none' : undefined }) : {}
      return { type: { char, para: defined({ align: algn ? ALIGNS[algn] : undefined }) } }
    }
    case 'bucketTool':
      if (obj(d, 'Ptrn')) warn(`“${name}” fills with a pattern of Photoshop’s; it came in filling with the foreground`)
      return { bucket: defined({ source: obj(d, 'Ptrn') ? 'fg' : undefined, blend: blendOf(d), opacity: opacityOf(d), tolerance: has(d, 'BckT') ? Math.min(255, Math.max(0, num(d, 'BckT', 32))) : has(d, 'Tlrn') ? Math.min(255, Math.max(0, num(d, 'Tlrn', 32))) : undefined, antialias: has(d, 'BckA') ? bool(d, 'BckA') : has(d, 'AntA') ? bool(d, 'AntA') : undefined, contiguous: has(d, 'Cntg') ? bool(d, 'Cntg') : undefined, sampleAll: has(d, 'BckS') ? bool(d, 'BckS') : has(d, 'Mrgd') ? bool(d, 'Mrgd') : undefined }) }
    case 'magicWandTool':
      return { wand: defined({ tolerance: has(d, 'Tlrn') ? Math.min(255, Math.max(0, num(d, 'Tlrn', 32))) : undefined, antialias: has(d, 'AntA') ? bool(d, 'AntA') : undefined, contiguous: has(d, 'Cntg') ? bool(d, 'Cntg') : undefined, sampleAll: has(d, 'Mrgd') ? bool(d, 'Mrgd') : undefined }) }
    case 'marqueeRectTool':
    case 'marqueeEllipTool':
      return { marquee: defined({ shape: cls === 'marqueeRectTool' ? 'rect' : 'ellipse', feather: has(d, 'Fthr') ? Math.max(0, num(d, 'Fthr', 0)) : undefined, antialias: has(d, 'AntA') ? bool(d, 'AntA') : undefined }) }
    case 'lassoTool':
    case 'polySelTool':
    case 'magneticLassoTool':
      // The Magnetic Lasso's width and edge contrast (MgWd, MgEd, a percentage).
      return { lasso: defined({ mode: cls === 'lassoTool' ? 'freehand' : cls === 'polySelTool' ? 'polygonal' : 'magnetic', feather: has(d, 'Fthr') ? Math.max(0, num(d, 'Fthr', 0)) : undefined, antialias: has(d, 'AntA') ? bool(d, 'AntA') : undefined, width: has(d, 'MgWd') ? Math.min(256, Math.max(1, num(d, 'MgWd', 10))) : undefined, contrast: has(d, 'MgEd') ? Math.min(1, Math.max(0.01, num(d, 'MgEd', 10) / 100)) : undefined }) }
    case 'quickSelectTool': {
      const b = obj(d, 'Brsh')
      return { quick: defined({ size: b && has(b, 'Dmtr') ? Math.max(1, num(b, 'Dmtr', 30)) : undefined, sampleAll: has(d, 'Mrgd') ? bool(d, 'Mrgd') : undefined }) }
    }
    case 'rectangleTool':
    case 'roundedRectangleTool':
    case 'ellipseTool':
    case 'polygonTool':
    case 'lineTool':
    {
      // A polygon with an indent is a star: its inner radius is what the indent leaves.
      const star = cls === 'polygonTool' && bool(d, 'doIndent')
      const sides = has(d, 'sides') ? num(d, 'sides', 5) : has(d, 'Sds ') ? num(d, 'Sds ', 5) : undefined
      return {
        shape: defined({
          type: cls === 'ellipseTool' ? 'ellipse' : star ? 'star' : cls === 'polygonTool' ? 'polygon' : cls === 'lineTool' ? 'line' : 'rect',
          sides: sides !== undefined && !star ? Math.min(100, Math.max(3, Math.round(sides))) : undefined,
          points: sides !== undefined && star ? Math.min(100, Math.max(3, Math.round(sides))) : undefined,
          inner: star && has(d, 'indent') ? Math.min(0.99, Math.max(0.01, 1 - num(d, 'indent', 50) / 100)) : undefined,
          strokeWidth: has(d, 'LnWd') ? Math.max(0.1, num(d, 'LnWd', 1)) : undefined,
        }),
      }
    }
    case 'moveTool':
      return { move: defined({ autoSelect: has(d, 'autoSelect') ? bool(d, 'autoSelect') : undefined }) }
  }
  warn(NOTHING[cls] ? `“${name}” was left out: ${NOTHING[cls]}` : `“${name}” is for a tool Plexel hasn’t got (${cls}); it was left out`)
  return null
}

/** Reads a TPL file; throws TplError if it isn't one Plexel can read. */
export function readTpl(bytes: Uint8Array): TplFile {
  const r = new Reader(bytes)
  const abr: AbrFile = { version: 0, presets: [], tips: [], patterns: [], warnings: [] }
  const out: TplFile = { presets: [], tips: abr.tips, patterns: abr.patterns, warnings: abr.warnings }
  const warn = (w: string) => {
    if (!out.warnings.includes(w)) out.warnings.push(w)
  }
  try {
    if (r.left < 12 || r.sig() !== '8BTP') throw new TplError('That isn’t a Photoshop tool preset file')
    r.u32()
    r.u32()
    const byAbrId = new Map<string, AbrImage>()
    const presets: { name: string; desc: Descriptor }[] = []
    while (r.left >= 12) {
      const sig = r.sig()
      const key = r.sig()
      const len = Math.min(r.u32(), r.left)
      const s = r.sub(len)
      if (sig !== '8BIM') warn('A part of the file Plexel doesn’t know was left out')
      else if (key === 'tppa' || key === 'patt') readPatterns(s, abr)
      else if (key === 'samp') readSamples(s, 2, byAbrId, abr)
      else if (key === 'tptp') {
        const n = s.u32()
        for (let i = 0; i < n && s.left > 8; i++) {
          const full = s.unicode()
          s.u32()
          const desc = readDescriptor(s)
          presets.push({ name: (full.split('=').pop() ?? full).replace(/\0+$/, '').trim() || 'Tool Preset', desc })
        }
      } else if (key === 'tpsh') warn('Custom shapes in the file were left out')
      else if (key === 'tpst') warn('Styles in the file were left out')
      while (r.pos % 4 && r.left) r.pos++
    }
    for (const p of presets) {
      const tool = TOOLS[p.desc.cls]
      const options = optionsOf(p.desc.cls, p.desc, p.name, byAbrId, warn)
      if (tool && options) out.presets.push({ name: p.name, tool, from: p.desc.cls, options })
    }
    return out
  } catch (e) {
    if (e instanceof TplError) throw e
    if (e instanceof PsdError) throw new TplError(`The file is damaged: ${e.message}`)
    throw e
  }
}
