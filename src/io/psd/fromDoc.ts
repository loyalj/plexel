/**
 * A Plexel document as a PSD plan (plan.ts): every layer record with its
 * tagged blocks, written so Photoshop keeps as much live as it can.
 *
 *   groups          section dividers, pass-through and knockout kept
 *   clipping        a layer's children follow it, clipped
 *   pixel layers    their tiles, exactly, when only moved by whole pixels;
 *                   rendered onto the document's grid when transformed
 *   shapes          their pixels, a vector mask of their path (in
 *                   document coordinates), and their first fill (SoCo or
 *                   GdFl) and first stroke (vstk) as a live shape layer
 *   text            its pixels and a TySh block: the text, its runs and
 *                   paragraphs as engine data, fonts by PostScript name
 *   adjustments     Photoshop's own blocks, as toDoc.ts reads them
 *   layer effects   an lfx2 descriptor of every effect
 *   smart objects   SoLd and the contents as an embedded PSB (lnk2)
 *   masks           the pixel mask's tiles and settings; vector masks as
 *                   vmsk paths
 *
 * What a PSD can't hold the way Plexel does (a second fill or stroke,
 * patterns, filters in a layer's effects) is in the layer's pixels and
 * said.
 */
import { geometryPath, strokeNeedsOutline, type AppearanceItem, type Paint } from '../../doc/vector'
import { transformPath, type PathData } from '../../geom/path'
import { docPathOf } from '../../vector/shape'
import { readParamValues, type CurvePoints, type GradientStop, type LevelsValue, type ParamColour } from '../../doc/params'
import { ADJUSTMENT_BY_ID } from '../../adjust/defs'
import { FX_BY_KIND } from '../../fx/defs'
import { resolveChar, resolvePara, type CharProps, type ParaProps } from '../../doc/text'
import { ALPHA_TINT, channelKind, channelOpacity, type Doc, type DocNode, type NodeId } from '../../doc/types'
import { Writer } from './bin'
import { D, desc, writeDescriptor, type Descriptor, type DValue } from './descriptor'
import { writeEngineData, type EValue } from './engineData'
import type { PsdBlock, PsdResource } from './format'
import type { PlanLayer, PsdPlan, PixelSource } from './plan'
import { BLEND_KEY_OF } from './format'
import { BLEND_ENUM_OF } from './toDoc'
import { warpToPsd } from './warp'
import { FILTER_BY_ID, filterValues, warpSpec } from '../../filters/defs'
import { frameCorners } from '../../geom/warp'

export interface PsdOutHost {
  /** A font's PostScript name, as Photoshop wants it. */
  psName(family: string, style: string): string
  /** A smart object's contents as a PSB, or null to leave it as pixels. */
  smartObject(node: DocNode & { kind: 'embedded' }): Promise<Uint8Array | null>
  /** The document's profile, for the file. */
  icc: Uint8Array | null
}

const bytesOf = (fn: (w: Writer) => void, psb = false) => {
  const w = new Writer(psb)
  fn(w)
  return w.done()
}

const descData = (d: Descriptor, before: (w: Writer) => void = (w) => w.u32(16)) =>
  bytesOf((w) => {
    before(w)
    writeDescriptor(w, d)
  })

const TAG_INDEX: Record<string, number> = { red: 1, orange: 2, yellow: 3, green: 4, blue: 5, violet: 6, gray: 7 }

export async function docToPlan(doc: Doc, key: string, host: PsdOutHost, o: { psb?: boolean } = {}): Promise<{ plan: PsdPlan; warnings: string[] }> {
  const warnings = new Set<string>()
  const warn = (w: string) => warnings.add(w)
  const layers: PlanLayer[] = []
  const globalBlocks: PsdBlock[] = []
  const linked: Uint8Array[] = []
  const mode = doc.mode
  const max = 255

  // --- colours as descriptors, in the document's own terms ----------------------------------------
  const colourDesc = (c: ParamColour): DValue => {
    if (mode === 'cmyk')
      return D.obj('CMYC', [
        ['Cyn ', D.doub(c[0] * 100)],
        ['Mgnt', D.doub(c[1] * 100)],
        ['Ylw ', D.doub(c[2] * 100)],
        ['Blck', D.doub(c[3] * 100)],
      ])
    if (mode === 'gray') return D.obj('Grsc', [['Gry ', D.doub((1 - c[0]) * 100)]])
    return D.obj('RGBC', [
      ['Rd  ', D.doub(c[0] * max)],
      ['Grn ', D.doub(c[1] * max)],
      ['Bl  ', D.doub(c[2] * max)],
    ])
  }
  const gradientDesc = (stops: { at: number; colour: ParamColour; alpha?: number }[]): DValue =>
    D.obj('Grdn', [
      ['Nm  ', D.text('Custom')],
      ['GrdF', D.enum('GrdF', 'CstS')],
      ['Intr', D.doub(4096)],
      [
        'Clrs',
        D.list(
          stops.map((s) =>
            D.obj('Clrt', [
              ['Clr ', colourDesc(s.colour)],
              ['Type', D.enum('Clry', 'UsrS')],
              ['Lctn', D.long(s.at * 4096)],
              ['Mdpn', D.long(50)],
            ]),
          ),
        ),
      ],
      [
        'Trns',
        D.list(
          stops.map((s) =>
            D.obj('TrnS', [
              ['Opct', D.unit('#Prc', (s.alpha ?? 1) * 100)],
              ['Lctn', D.long(s.at * 4096)],
              ['Mdpn', D.long(50)],
            ]),
          ),
        ),
      ],
    ])
  const blendEnum = (b: string) => D.enum('BlnM', BLEND_ENUM_OF[b] ?? 'Nrml')

  // --- paths ---------------------------------------------------------------------------------------
  const pathBlock = (path: PathData, flags = 0): Uint8Array =>
    bytesOf((w) => {
      w.u32(3)
      w.u32(flags)
      const fixed = (v: number) => w.i32(Math.round(v * 2 ** 24))
      const pt = (p: [number, number]) => {
        fixed(p[1] / doc.height)
        fixed(p[0] / doc.width)
      }
      // A path fill rule record, then the initial fill rule.
      w.u16(6)
      w.zeros(24)
      w.u16(8)
      w.u16(0)
      w.zeros(22)
      path.subpaths.forEach((s, i) => {
        w.u16(s.closed ? 0 : 3)
        w.u16(s.anchors.length)
        // Even-odd holes are each XOR'd in; non-zero subpaths are united.
        w.i16(i === 0 ? 1 : path.fillRule === 'evenodd' ? 0 : 1)
        w.u16(1)
        // Every record is its selector and 24 bytes: the count, the operation and this flag take 6.
        w.zeros(18)
        for (const a of s.anchors) {
          w.u16(s.closed ? (a.smooth ? 1 : 2) : a.smooth ? 4 : 5)
          pt(a.in ?? a.p)
          pt(a.p)
          pt(a.out ?? a.p)
        }
      })
    })

  const nodePath = (n: DocNode): PathData | null => {
    if (n.kind === 'vector' && n.props.geometry) return transformPath(geometryPath(n.props.geometry), n.transform)
    if (n.kind === 'boolean') return docPathOf((id) => doc.nodes[id], n)
    return null
  }

  // --- fills and strokes --------------------------------------------------------------------------
  const fillBlock = (p: Paint): PsdBlock | null => {
    if (p.kind === 'solid') return { key: 'SoCo', data: descData(desc('null', [['Clr ', colourDesc(p.colour)]])) }
    if (p.kind === 'gradient' && p.line) warn('Gradients drawn along a line keep their look in the layer’s pixels; Photoshop gets their angle and scale across the layer')
    if (p.kind === 'gradient')
      return {
        key: 'GdFl',
        data: descData(
          desc('null', [
            ['Grad', gradientDesc(p.stops)],
            ['Type', D.enum('GrdT', p.type === 'radial' ? 'Rdl ' : p.type === 'angular' ? 'Angl' : p.type === 'diamond' ? 'Dmnd' : p.type === 'reflected' ? 'Rflc' : 'Lnr ')],
            ['Angl', D.unit('#Ang', p.angle)],
            ['Scl ', D.unit('#Prc', p.scale)],
            ['Rvrs', D.bool(p.reverse)],
            ['Dthr', D.bool(false)],
            ['Algn', D.bool(true)],
          ]),
        ),
      }
    warn('Pattern fills are in their layers’ pixels; Photoshop’s patterns are images')
    return null
  }
  const strokeBlock = (s: Extract<AppearanceItem, { kind: 'stroke' }> | null, fill: boolean): PsdBlock => {
    const p = s?.paint
    const content: DValue =
      p?.kind === 'gradient'
        ? D.obj('gradientLayer', [
            ['Grad', gradientDesc(p.stops)],
            ['Type', D.enum('GrdT', 'Lnr ')],
            ['Angl', D.unit('#Ang', p.angle)],
          ])
        : D.obj('solidColorLayer', [['Clr ', colourDesc(p?.kind === 'solid' ? p.colour : mode === 'cmyk' ? [0, 0, 0, 1] : mode === 'gray' ? [0] : [0, 0, 0])]])
    return {
      key: 'vstk',
      data: descData(
        desc('strokeStyle', [
          ['strokeStyleVersion', D.long(2)],
          ['strokeEnabled', D.bool(!!s)],
          ['fillEnabled', D.bool(fill)],
          ['strokeStyleLineWidth', D.unit('#Pxl', s?.width ?? 1)],
          ['strokeStyleLineDashOffset', D.unit('#Pnt', s && s.width ? s.dashOffset / s.width : 0)],
          ['strokeStyleMiterLimit', D.doub((s?.miter ?? 4) * 25)],
          ['strokeStyleLineCapType', D.enum('strokeStyleLineCapType', s?.cap === 'round' ? 'strokeStyleRoundCap' : s?.cap === 'square' ? 'strokeStyleSquareCap' : 'strokeStyleButtCap')],
          ['strokeStyleLineJoinType', D.enum('strokeStyleLineJoinType', s?.join === 'round' ? 'strokeStyleRoundJoin' : s?.join === 'bevel' ? 'strokeStyleBevelJoin' : 'strokeStyleMiterJoin')],
          [
            'strokeStyleLineAlignment',
            D.enum('strokeStyleLineAlignment', s?.align === 'inside' ? 'strokeStyleAlignInside' : s?.align === 'outside' ? 'strokeStyleAlignOutside' : 'strokeStyleAlignCenter'),
          ],
          ['strokeStyleScaleLock', D.bool(false)],
          ['strokeStyleStrokeAdjust', D.bool(false)],
          ['strokeStyleLineDashSet', D.list((s?.dash ?? []).map((d) => D.unit('#Nne', s && s.width ? d / s.width : d)))],
          ['strokeStyleBlendMode', blendEnum(s?.blend ?? 'normal')],
          ['strokeStyleOpacity', D.unit('#Prc', (s?.opacity ?? 1) * 100)],
          ['strokeStyleContent', content],
          ['strokeStyleResolution', D.doub(doc.resolution)],
        ]),
      ),
    }
  }

  // --- layer effects -------------------------------------------------------------------------------
  const fxBlock = (n: DocNode): PsdBlock | null => {
    if (!n.fx.length) return null
    const items: [string, DValue][] = [
      ['Scl ', D.unit('#Prc', 100)],
      ['masterFXSwitch', D.bool(true)],
    ]
    for (const f of n.fx) {
      const def = FX_BY_KIND.get(f.kind as never)
      if (!def) continue
      const v = readParamValues(def.params, f.params, mode) as Record<string, unknown>
      const c = (k: string) => colourDesc(v[k] as ParamColour)
      const on: [string, DValue] = ['enab', D.bool(f.enabled)]
      const md = (k = 'blend') => blendEnum(v[k] as string)
      switch (f.kind) {
        case 'drop-shadow':
          items.push([
            'DrSh',
            D.obj('DrSh', [
              on,
              ['Md  ', md()],
              ['Clr ', c('colour')],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['uglg', D.bool(false)],
              ['lagl', D.unit('#Ang', v.angle as number)],
              ['Dstn', D.unit('#Pxl', v.distance as number)],
              ['Ckmt', D.unit('#Pxl', v.spread as number)],
              ['blur', D.unit('#Pxl', v.size as number)],
              ['Nose', D.unit('#Prc', 0)],
              ['AntA', D.bool(false)],
              ['layerConceals', D.bool(true)],
            ]),
          ])
          break
        case 'inner-shadow':
          items.push([
            'IrSh',
            D.obj('IrSh', [
              on,
              ['Md  ', md()],
              ['Clr ', c('colour')],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['uglg', D.bool(false)],
              ['lagl', D.unit('#Ang', v.angle as number)],
              ['Dstn', D.unit('#Pxl', v.distance as number)],
              ['Ckmt', D.unit('#Pxl', v.choke as number)],
              ['blur', D.unit('#Pxl', v.size as number)],
              ['Nose', D.unit('#Prc', 0)],
              ['AntA', D.bool(false)],
            ]),
          ])
          break
        case 'outer-glow':
          items.push([
            'OrGl',
            D.obj('OrGl', [
              on,
              ['Md  ', md()],
              ['Clr ', c('colour')],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['GlwT', D.enum('BETE', 'SfBL')],
              ['Ckmt', D.unit('#Pxl', v.spread as number)],
              ['blur', D.unit('#Pxl', v.size as number)],
              ['Nose', D.unit('#Prc', 0)],
              ['ShdN', D.unit('#Prc', 0)],
              ['AntA', D.bool(false)],
              ['Inpr', D.unit('#Prc', 50)],
            ]),
          ])
          break
        case 'inner-glow':
          items.push([
            'IrGl',
            D.obj('IrGl', [
              on,
              ['Md  ', md()],
              ['Clr ', c('colour')],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['GlwT', D.enum('BETE', 'SfBL')],
              ['Ckmt', D.unit('#Pxl', v.choke as number)],
              ['blur', D.unit('#Pxl', v.size as number)],
              ['ShdN', D.unit('#Prc', 0)],
              ['Nose', D.unit('#Prc', 0)],
              ['AntA', D.bool(false)],
              ['glwS', D.enum('IGSr', v.source === 'centre' ? 'SrcC' : 'SrcE')],
              ['Inpr', D.unit('#Prc', 50)],
            ]),
          ])
          break
        case 'satin':
          items.push([
            'ChFX',
            D.obj('ChFX', [
              on,
              ['Md  ', md()],
              ['Clr ', c('colour')],
              ['AntA', D.bool(true)],
              ['Invr', D.bool(v.invert as boolean)],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['lagl', D.unit('#Ang', v.angle as number)],
              ['Dstn', D.unit('#Pxl', v.distance as number)],
              ['blur', D.unit('#Pxl', v.size as number)],
            ]),
          ])
          break
        case 'colour-overlay':
          items.push(['SoFi', D.obj('SoFi', [on, ['Md  ', md()], ['Opct', D.unit('#Prc', v.opacity as number)], ['Clr ', c('colour')]])])
          break
        case 'gradient-overlay':
          items.push([
            'GrFl',
            D.obj('GrFl', [
              on,
              ['Md  ', md()],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['Grad', gradientDesc(v.gradient as GradientStop[])],
              ['Angl', D.unit('#Ang', v.angle as number)],
              ['Type', D.enum('GrdT', 'Lnr ')],
              ['Rvrs', D.bool(v.reverse as boolean)],
              ['Dthr', D.bool(false)],
              ['Algn', D.bool(true)],
              ['Scl ', D.unit('#Prc', v.scale as number)],
              [
                'Ofst',
                D.obj('Pnt ', [
                  ['Hrzn', D.unit('#Prc', 0)],
                  ['Vrtc', D.unit('#Prc', 0)],
                ]),
              ],
            ]),
          ])
          break
        case 'pattern-overlay':
          warn('Pattern Overlay was left out: Photoshop’s patterns are images')
          break
        case 'stroke':
          items.push([
            'FrFX',
            D.obj('FrFX', [
              on,
              ['Styl', D.enum('FStl', v.position === 'inside' ? 'InsF' : v.position === 'centre' ? 'CtrF' : 'OutF')],
              ['PntT', D.enum('FrFl', 'SClr')],
              ['Md  ', md()],
              ['Opct', D.unit('#Prc', v.opacity as number)],
              ['Sz  ', D.unit('#Pxl', v.size as number)],
              ['Clr ', c('colour')],
            ]),
          ])
          break
        case 'bevel':
          items.push([
            'ebbl',
            D.obj('ebbl', [
              on,
              ['hglM', md('highlightBlend')],
              ['hglC', c('highlightColour')],
              ['hglO', D.unit('#Prc', v.highlightOpacity as number)],
              ['sdwM', md('shadowBlend')],
              ['sdwC', c('shadowColour')],
              ['sdwO', D.unit('#Prc', v.shadowOpacity as number)],
              ['bvlT', D.enum('bvlT', 'SfBL')],
              ['bvlS', D.enum('BESl', v.style === 'outer' ? 'OtrB' : v.style === 'emboss' ? 'Embs' : 'InrB')],
              ['uglg', D.bool(false)],
              ['lagl', D.unit('#Ang', v.angle as number)],
              ['Lald', D.unit('#Ang', v.altitude as number)],
              ['srgR', D.unit('#Prc', v.depth as number)],
              ['blur', D.unit('#Pxl', v.size as number)],
              ['bvlD', D.enum('BESs', v.direction === 'down' ? 'Out ' : 'In  ')],
              ['Sftn', D.unit('#Pxl', v.soften as number)],
            ]),
          ])
          break
      }
    }
    return { key: 'lfx2', data: descData(desc('null', items), (w) => (w.u32(0), w.u32(16))) }
  }

  // --- adjustments ---------------------------------------------------------------------------------
  const channels = mode === 'rgb' ? ['master', 'red', 'green', 'blue'] : mode === 'cmyk' ? ['master', 'cyan', 'magenta', 'yellow', 'black'] : ['master']
  const adjustmentBlocks = (n: DocNode & { kind: 'adjustment' }): PsdBlock[] => {
    const def = ADJUSTMENT_BY_ID.get(n.props.adjustment)
    if (!def) return []
    const v = readParamValues(def.params, n.props.params, mode) as Record<string, unknown>
    const num = (k: string) => v[k] as number
    switch (n.props.adjustment) {
      case 'levels': {
        const lv = v.levels as Record<string, LevelsValue>
        return [
          {
            key: 'levl',
            data: bytesOf((w) => {
              w.u16(2)
              for (let i = 0; i < 29; i++) {
                // Gray's one channel is the second record, as Photoshop has it.
                const ch = mode === 'gray' ? (i === 1 ? 'master' : null) : (channels[i] ?? null)
                const r = ch ? lv[ch] : null
                w.u16(Math.round((r?.inBlack ?? 0) * 255))
                w.u16(Math.round((r?.inWhite ?? 1) * 255))
                w.u16(Math.round((r?.outBlack ?? 0) * 255))
                w.u16(Math.round((r?.outWhite ?? 1) * 255))
                w.u16(Math.round((r?.gamma ?? 1) * 100))
              }
            }),
          },
        ]
      }
      case 'curves': {
        const cv = v.curves as Record<string, CurvePoints>
        const present = channels
          .map((ch, i) => [mode === 'gray' ? 1 : i, cv[ch]] as const)
          .filter(([, c]) => c && !(c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1))
        return [
          {
            key: 'curv',
            data: bytesOf((w) => {
              w.u8(0)
              w.u16(1)
              w.u32(present.reduce((b, [i]) => b | (1 << i), 0))
              const pts = (c: CurvePoints) => {
                w.u16(c.length)
                for (const [x, y] of c) {
                  w.u16(Math.round(y * 255))
                  w.u16(Math.round(x * 255))
                }
              }
              for (const [, c] of present) pts(c)
              w.sig('Crv ')
              w.u16(4)
              w.u32(present.length)
              for (const [i, c] of present) {
                w.u16(i)
                pts(c)
              }
            }),
          },
        ]
      }
      case 'brightness-contrast':
        return [
          { key: 'brit', data: bytesOf((w) => (w.i16(Math.round(num('brightness'))), w.i16(Math.round(num('contrast'))), w.u16(127), w.u8(0), w.u8(0))) },
          {
            key: 'CgEd',
            data: descData(
              desc('null', [
                ['Vrsn', D.long(1)],
                ['Brgh', D.long(num('brightness'))],
                ['Cntr', D.long(num('contrast'))],
                ['means', D.long(127)],
                ['Lab ', D.bool(false)],
                ['useLegacy', D.bool(!!v.legacy)],
                ['Auto', D.bool(false)],
              ]),
            ),
          },
        ]
      case 'exposure':
        return [{ key: 'expA', data: bytesOf((w) => (w.u16(1), w.f32(num('exposure')), w.f32(num('offset')), w.f32(num('gamma')))) }]
      case 'invert':
        return [{ key: 'nvrt', data: new Uint8Array(0) }]
      case 'posterize':
        return [{ key: 'post', data: bytesOf((w) => (w.u16(num('levels')), w.u16(0))) }]
      case 'threshold':
        return [{ key: 'thrs', data: bytesOf((w) => (w.u16(num('level')), w.u16(0))) }]
      case 'hue-saturation':
        return [
          {
            key: 'hue2',
            data: bytesOf((w) => {
              w.u16(2)
              const col = v.colorize as boolean
              w.u8(col ? 1 : 0)
              w.u8(0)
              const three = [num('hue'), num('saturation'), num('lightness')].map(Math.round)
              for (const x of col ? three : [0, 25, 0]) w.i16(x)
              for (const x of col ? [0, 0, 0] : three) w.i16(x)
              const ranges = [
                [315, 345, 15, 45],
                [15, 45, 75, 105],
                [75, 105, 135, 165],
                [135, 165, 195, 225],
                [195, 225, 255, 285],
                [255, 285, 315, 345],
              ]
              const names = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']
              ranges.forEach((r0, i) => {
                const lim = v[`${names[i]}Limits`]
                const r = Array.isArray(lim) && lim.length === 4 ? (lim as number[]) : r0
                for (const x of r) w.i16(Math.round(x))
                for (const x of col ? [0, 0, 0] : [num(`${names[i]}Hue`), num(`${names[i]}Saturation`), num(`${names[i]}Lightness`)]) w.i16(Math.round(x))
              })
            }),
          },
        ]
      case 'selective-colour':
        return [
          {
            key: 'selc',
            data: bytesOf((w) => {
              w.u16(1)
              w.u16(v.method === 'absolute' ? 1 : 0)
              w.zeros(8)
              for (const range of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks']) for (const ink of ['cyan', 'magenta', 'yellow', 'black']) w.i16(Math.round(num(`${range}_${ink}`)))
            }),
          },
        ]
      case 'vibrance':
        return [
          {
            key: 'vibA',
            data: descData(
              desc('null', [
                ['vibrance', D.long(num('vibrance'))],
                ['Strt', D.long(num('saturation'))],
              ]),
            ),
          },
        ]
      case 'colour-balance':
        return [
          {
            key: 'blnc',
            data: bytesOf((w) => {
              for (const k of ['shadows', 'midtones', 'highlights']) for (const a of ['CyanRed', 'MagentaGreen', 'YellowBlue']) w.i16(Math.round(num(`${k}${a}`)))
              w.u8(v.preserveLuminosity ? 1 : 0)
              w.u8(0)
            }),
          },
        ]
      case 'black-white': {
        const h = num('tintHue') / 60
        const s = num('tintSaturation') / 100
        const l = 0.5
        const q = l + s - l * s
        const p = 2 * l - q
        const hue = (t: number) => {
          t = ((t % 6) + 6) % 6
          return t < 1 ? p + (q - p) * t : t < 3 ? q : t < 4 ? p + (q - p) * (4 - t) : p
        }
        return [
          {
            key: 'blwh',
            data: descData(
              desc('null', [
                ['Rd  ', D.long(num('reds'))],
                ['Yllw', D.long(num('yellows'))],
                ['Grn ', D.long(num('greens'))],
                ['Cyn ', D.long(num('cyans'))],
                ['Bl  ', D.long(num('blues'))],
                ['Mgnt', D.long(num('magentas'))],
                ['useTint', D.bool(v.tint as boolean)],
                [
                  'tintColor',
                  D.obj('RGBC', [
                    ['Rd  ', D.doub(hue(h + 2) * 255)],
                    ['Grn ', D.doub(hue(h) * 255)],
                    ['Bl  ', D.doub(hue(h - 2) * 255)],
                  ]),
                ],
                ['bwPresetKind', D.long(1)],
                ['blackAndWhitePresetFileName', D.text('')],
              ]),
            ),
          },
        ]
      }
      case 'channel-mixer':
        return [
          {
            key: 'mixr',
            data: bytesOf((w) => {
              w.u16(1)
              w.u16(v.monochrome ? 1 : 0)
              const outs = v.monochrome ? ['gray', 'gray', 'gray', 'gray'] : ['red', 'green', 'blue', 'red']
              for (const o of outs) for (const k of ['FromRed', 'FromGreen', 'FromBlue', null, 'Constant']) w.i16(k ? Math.round(num(`${o}${k}`)) : 0)
              w.zeros(2)
            }),
          },
        ]
      case 'gradient-map':
        return [
          {
            key: 'grdm',
            data: bytesOf((w) => {
              w.u16(1)
              w.u8(v.reverse ? 1 : 0)
              w.u8(0)
              w.unicode('Custom')
              const stops = v.gradient as GradientStop[]
              w.u16(stops.length)
              for (const s of stops) {
                w.u32(Math.round(s.at * 4096))
                w.u32(50)
                if (mode === 'cmyk') {
                  w.u16(2)
                  for (const x of s.colour) w.u16(Math.round((1 - x) * 65535))
                } else if (mode === 'gray') {
                  w.u16(8)
                  w.u16(Math.round(s.colour[0] * 10000))
                  w.zeros(6)
                } else {
                  w.u16(0)
                  for (const x of s.colour) w.u16(Math.round(x * 65535))
                  w.u16(0)
                }
                w.zeros(2)
              }
              w.u16(2)
              for (const at of [0, 4096]) {
                w.u32(at)
                w.u32(50)
                w.u16(100)
              }
              w.u16(2)
              w.u16(4096)
              w.u16(32)
              w.u16(0)
              w.u32(0)
              w.u16(0)
              w.u16(0)
              w.u32(2048)
              w.u16(0)
              w.zeros(8)
              for (let i = 0; i < 4; i++) w.u16(32768)
              w.zeros(2)
            }),
          },
        ]
    }
    // Photo Filter, Colour Lookup and Colour Grading have no block here: the layer goes out empty, said.
    warn(`${def.label} adjustments don’t go into Photoshop files yet: the layer is left empty there`)
    return []
  }

  // --- text ----------------------------------------------------------------------------------------
  /** A layer's first Warp effect, shown and warping, by id. */
  const warpEffectId = (n: DocNode): NodeId | null =>
    n.effects.find((e) => {
      const x = doc.nodes[e]
      return x?.kind === 'filter' && x.visible && x.props.filter === 'warp'
    }) ?? null
  /** Its settings, whole, when it warps anything. */
  const warpOf = (n: DocNode): Record<string, unknown> | null => {
    const id = warpEffectId(n)
    const e = id ? doc.nodes[id] : null
    if (e?.kind !== 'filter') return null
    const v = filterValues('warp', e.props.params, doc.mode)
    return warpSpec(v) ? v : null
  }

  const typeBlock = (n: DocNode & { kind: 'text' }): PsdBlock => {
    const content = n.props.content
    const text = content.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\r') + '\r'
    const fontNames: string[] = ['AdobeInvisFont']
    const fontIndex = (c: CharProps) => {
      const ps = host.psName(c.font, c.style)
      let i = fontNames.indexOf(ps)
      if (i < 0) i = fontNames.push(ps) - 1
      return i
    }
    const fill = n.props.appearance.find((a) => a.kind === 'fill' && a.paint.kind === 'solid')?.paint as Extract<Paint, { kind: 'solid' }> | undefined
    const fc = fill?.colour ?? (mode === 'cmyk' ? [0, 0, 0, 1] : mode === 'gray' ? [0] : [0, 0, 0])
    const fillValues = mode === 'cmyk' ? [1, ...fc] : mode === 'gray' ? [1, fc[0]] : [1, ...fc]
    const styleData = (c: CharProps): EValue => ({
      Font: fontIndex(c),
      FontSize: c.size,
      FauxBold: false,
      FauxItalic: false,
      AutoLeading: c.leading === null,
      Leading: c.leading ?? c.size * 1.2,
      HorizontalScale: c.horizontalScale / 100,
      VerticalScale: c.verticalScale / 100,
      Tracking: c.tracking,
      AutoKerning: c.kerning === 'metrics',
      Kerning: 0,
      BaselineShift: c.baselineShift,
      FontCaps: 0,
      FontBaseline: 0,
      Underline: c.underline,
      Strikethrough: c.strikethrough,
      Ligatures: true,
      DLigatures: false,
      BaselineDirection: 2,
      Tsume: 0,
      StyleRunAlignment: 2,
      Language: 0,
      NoBreak: false,
      FillColor: { Type: 1, Values: fillValues },
      StrokeColor: { Type: 1, Values: [1, 0, 0, 0] },
      FillFlag: true,
      StrokeFlag: false,
      FillFirst: true,
      YUnderline: 1,
      OutlineWidth: 1,
      CharacterDirection: 0,
      HindiNumbers: false,
      Kashida: 1,
      DiacriticPos: 2,
    })
    const JUST: Record<string, number> = { left: 0, right: 1, centre: 2, justify: 3, 'justify-all': 6 }
    const paraData = (p: ParaProps): EValue => ({
      Justification: JUST[p.align] ?? 0,
      FirstLineIndent: p.indentFirst,
      StartIndent: p.indentLeft,
      EndIndent: p.indentRight,
      SpaceBefore: p.spaceBefore,
      SpaceAfter: p.spaceAfter,
      AutoHyphenate: false,
      HyphenatedWordSize: 6,
      PreHyphen: 2,
      PostHyphen: 2,
      ConsecutiveHyphens: 8,
      Zone: 36,
      WordSpacing: [0.8, 1, 1.33],
      LetterSpacing: [0, 0, 0],
      GlyphSpacing: [1, 1, 1],
      AutoLeading: 1.2,
      LeadingType: 0,
      Hanging: false,
      Burasagari: false,
      KinsokuOrder: 0,
      EveryLineComposer: p.composer === 'every',
    })
    const styleRuns: EValue[] = []
    const styleLens: number[] = []
    const paraRuns: EValue[] = []
    const paraLens: number[] = []
    content.paragraphs.forEach((p, pi) => {
      const last = pi === content.paragraphs.length - 1
      let plen = 0
      p.runs.forEach((r, ri) => {
        const len = r.text.length + (ri === p.runs.length - 1 ? 1 : 0)
        if (!len) return
        styleRuns.push({ StyleSheet: { StyleSheetData: styleData(resolveChar(r, p, doc.textStyles)) } })
        styleLens.push(len)
        plen += len
      })
      if (!p.runs.some((r) => r.text.length)) {
        styleRuns.push({ StyleSheet: { StyleSheetData: styleData(resolveChar(p.runs[0] ?? { style: null, props: {} }, p, doc.textStyles)) } })
        styleLens.push(1)
        plen = Math.max(plen, 1)
      }
      paraRuns.push({ ParagraphSheet: { DefaultStyleSheet: 0, Properties: paraData(resolvePara(p, doc.textStyles)) }, Adjustments: { Axis: [1, 0, 1], XY: [0, 0] } })
      paraLens.push(plen)
      void last
    })
    const box = n.props.mode === 'area' && n.props.frame?.kind === 'shape' && n.props.frame.shape.type === 'rect' ? n.props.frame.shape : null
    const shapeType = box ? 1 : 0
    const engine: EValue = {
      EngineDict: {
        Editor: { Text: text.replace(/\u2028/g, '\u0003') },
        ParagraphRun: {
          DefaultRunData: { ParagraphSheet: { DefaultStyleSheet: 0, Properties: {} }, Adjustments: { Axis: [1, 0, 1], XY: [0, 0] } },
          RunArray: paraRuns,
          RunLengthArray: paraLens,
          IsJoinable: 1,
        },
        StyleRun: { DefaultRunData: { StyleSheet: { StyleSheetData: {} } }, RunArray: styleRuns, RunLengthArray: styleLens, IsJoinable: 2 },
        GridInfo: {
          GridIsOn: false,
          ShowGrid: false,
          GridSize: 18,
          GridLeading: 22,
          GridColor: { Type: 1, Values: [0, 0, 0, 1] },
          GridLeadingFillColor: { Type: 1, Values: [0, 0, 0, 1] },
          AlignLineHeightToGridFlags: false,
        },
        AntiAlias: 4,
        UseFractionalGlyphWidths: true,
        Rendered: {
          Version: 1,
          Shapes: {
            WritingDirection: 0,
            Children: [
              {
                ShapeType: shapeType,
                Procession: 0,
                Lines: { WritingDirection: 0, Children: [] },
                Cookie: {
                  Photoshop: {
                    ShapeType: shapeType,
                    ...(box ? { BoxBounds: [box.x, box.y, box.x + box.w, box.y + box.h] } : { PointBase: [0, 0] }),
                    Base: { ShapeType: shapeType, TransformPoint0: [1, 0], TransformPoint1: [0, 1], TransformPoint2: [0, 0] },
                  },
                },
              },
            ],
          },
        },
      },
      ResourceDict: {
        TheNormalStyleSheet: 0,
        TheNormalParagraphSheet: 0,
        ParagraphSheetSet: [{ Name: 'Normal RGB', DefaultStyleSheet: 0, Properties: paraData(resolvePara({ runs: [], style: null, props: {} }, undefined)) }],
        StyleSheetSet: [{ Name: 'Normal RGB', StyleSheetData: styleData(resolveChar({ style: null, props: {} }, { style: null }, undefined)) }],
        FontSet: fontNames.map((name) => ({ Name: name, Script: 0, FontType: 0, Synthetic: 0 })),
        SuperscriptSize: 0.583,
        SuperscriptPosition: 0.333,
        SubscriptSize: 0.583,
        SubscriptPosition: 0.333,
        SmallCapSize: 0.7,
      },
      DocumentResources: {
        FontSet: fontNames.map((name) => ({ Name: name, Script: 0, FontType: 0, Synthetic: 0 })),
        SuperscriptSize: 0.583,
        SuperscriptPosition: 0.333,
        SubscriptSize: 0.583,
        SubscriptPosition: 0.333,
        SmallCapSize: 0.7,
      },
    }
    if (n.props.mode === 'path') warn('Text on a path came in as point text, with its pixels as they were')
    const t = n.transform
    return {
      key: 'TySh',
      data: bytesOf((w) => {
        w.u16(1)
        for (const v of t) w.f64(v)
        w.u16(50)
        w.u32(16)
        writeDescriptor(
          w,
          desc('TxLr', [
            ['Txt ', D.text(text.replace(/\r$/, '').replace(/\u2028/g, '\r'))],
            ['textGridding', D.enum('textGridding', 'None')],
            ['Ornt', D.enum('Ornt', 'Hrzn')],
            ['AntA', D.enum('Annt', 'antiAliasSharp')],
            ['TextIndex', D.long(0)],
            ['EngineData', D.data(writeEngineData(engine))],
          ]),
        )
        w.u16(1)
        w.u32(16)
        // A Warp effect with a style is Photoshop's warped text; anything else of it, as an unwarped text.
        const tw = warpOf(n)
        writeDescriptor(w, desc('warp', warpToPsd(tw && tw.style !== 'custom' && tw.style !== 'none' ? tw : null, 0, 0)))
        for (let i = 0; i < 4; i++) w.f64(0)
      }),
    }
  }

  // --- smart objects -------------------------------------------------------------------------------
  let uidCount = 0
  const smartBlock = async (n: DocNode & { kind: 'embedded' }): Promise<PsdBlock | null> => {
    const c = n.props.content
    if (!c) return null
    const bytes = await host.smartObject(n)
    if (!bytes) return null
    const uid = `plexel-${(uidCount++).toString(36)}-${n.id}`
    const t = n.transform
    const corner = (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]
    let corners = [...corner(0, 0), ...corner(c.width, 0), ...corner(c.width, c.height), ...corner(0, c.height)]
    // A Warp effect: its corners as the placed layer's, its mesh or style as its warp, over the contents' rectangle.
    const wv = warpOf(n)
    let warp: [string, DValue][] = warpToPsd(null, c.width, c.height)
    if (wv) {
      const f = wv.frame as number[]
      const own = Math.abs(f[0] - c.width) < 1e-6 && Math.abs(f[3] - c.height) < 1e-6 && [f[1], f[2], f[4], f[5]].every((x) => Math.abs(x) < 1e-6)
      if (own) {
        const q = (wv.corners as number[] | null) ?? frameCorners(f)
        corners = [0, 1, 2, 3].flatMap((i) => corner(q[2 * i], q[2 * i + 1]))
        warp = warpToPsd(wv, c.width, c.height)
        if (wv.style === 'custom' && ((wv.mesh as { cols: number } | null)?.cols ?? 1) !== 1) warn('A warp on a grid of more than one patch came out flat (Photoshop’s keeps one)')
      } else {
        // Made on another box: where the contents' corners go, as a perspective; a bend is lost.
        const m = FILTER_BY_ID.get('warp')!.warp!(wv)
        const q = [
          [0, 0],
          [c.width, 0],
          [c.width, c.height],
          [0, c.height],
        ].map(([x, y]) => m?.forward?.(x, y) ?? [x, y])
        corners = q.flatMap(([x, y]) => corner(x, y))
        if (wv.style !== 'none') warn('A smart object’s warp, made over part of it, came out as its corners only')
      }
    }
    const so = desc('null', [
      ['Idnt', D.text(uid)],
      ['placed', D.text(uid)],
      ['PgNm', D.long(1)],
      ['totalPages', D.long(1)],
      [
        'frameStep',
        D.obj('null', [
          ['numerator', D.long(0)],
          ['denominator', D.long(600)],
        ]),
      ],
      [
        'duration',
        D.obj('null', [
          ['numerator', D.long(0)],
          ['denominator', D.long(600)],
        ]),
      ],
      ['frameCount', D.long(1)],
      ['Annt', D.long(16)],
      ['Type', D.long(2)],
      ['Trnf', D.list(corners.map(D.doub))],
      ['nonAffineTransform', D.list(corners.map(D.doub))],
      ['warp', D.obj('warp', warp)],
      [
        'Sz  ',
        D.obj('Pnt ', [
          ['Wdth', D.doub(c.width)],
          ['Hght', D.doub(c.height)],
        ]),
      ],
      ['Rslt', D.unit('#Rsl', c.resolution)],
      ['comp', D.long(-1)],
      [
        'compInfo',
        D.obj('null', [
          ['compID', D.long(-1)],
          ['originalCompID', D.long(-1)],
        ]),
      ],
    ])
    // The contents, embedded in the global linked-files block.
    const item = bytesOf((w) => {
      w.sig('liFD')
      w.u32(2)
      w.pascal(uid, 1)
      w.unicode(`${n.name || 'Contents'}.psb`)
      w.sig('8BPB')
      w.sig('8BIM')
      w.u64(bytes.length)
      w.u8(0)
      w.bytes(bytes)
    })
    linked.push(bytesOf((w) => (w.u64(item.length), w.bytes(item), w.pad(4))))
    return {
      key: 'SoLd',
      data: bytesOf((w) => {
        w.sig('soLD')
        w.u32(4)
        w.u32(16)
        writeDescriptor(w, so)
      }),
    }
  }

  // --- layer records -------------------------------------------------------------------------------
  const unicode = (s: string) => bytesOf((w) => w.unicode(s, false))
  const common = (n: DocNode, name: string): PsdBlock[] => {
    const out: PsdBlock[] = [{ key: 'luni', data: unicode(name) }]
    const lockFlags = (n.locked.pixels ? 2 : 0) | (n.locked.position ? 4 : 0) | (n.locked.all ? 0x80000000 : 0)
    if (lockFlags) out.push({ key: 'lspf', data: bytesOf((w) => w.u32(lockFlags)) })
    if (n.tag) out.push({ key: 'lclr', data: bytesOf((w) => (w.u16(TAG_INDEX[n.tag!] ?? 0), w.zeros(6))) })
    if (n.fillOpacity < 1) out.push({ key: 'iOpa', data: bytesOf((w) => (w.u8(Math.round(n.fillOpacity * 255)), w.zeros(3))) })
    const fx = fxBlock(n)
    if (fx) out.push(fx)
    return out
  }
  const flagsOf = (n: DocNode) => (n.visible ? 0 : 2) | 8
  const blendKey = (b: string) => BLEND_KEY_OF[b] ?? 'norm'

  /** A node's pixel mask and vector mask, for its record. */
  const masksFor = (n: DocNode): { mask: PlanLayer['mask']; vector: PsdBlock | null } => {
    let mask: PlanLayer['mask'] = null
    let vector: PsdBlock | null = null
    for (const mid of n.masks) {
      const m = doc.nodes[mid]
      if (!m || m.kind !== 'mask') continue
      if (m.props.source === 'pixel' && !mask) {
        const t = m.transform
        const whole = t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && Number.isInteger(t[4]) && Number.isInteger(t[5])
        if (!whole) warn('A transformed layer mask was written untransformed')
        mask = {
          set: m.props.tiles,
          dx: Math.round(t[4]),
          dy: Math.round(t[5]),
          defaultColor: m.props.outside >= 0.5 ? 255 : 0,
          flags: m.visible ? 0 : 2,
          userDensity: m.props.density < 1 ? Math.round(m.props.density * 255) : undefined,
          userFeather: m.props.feather > 0 ? m.props.feather : undefined,
        }
        if (m.props.invert) warn('An inverted layer mask was written as it is, not inverted')
      } else if (m.props.source === 'vector' && !vector && m.props.geometry) {
        const path = transformPath(geometryPath(m.props.geometry), m.transform)
        vector = { key: 'vmsk', data: pathBlock(path, (m.props.invert ? 1 : 0) | (m.visible ? 0 : 4)) }
      }
    }
    return { mask, vector }
  }

  const add = async (id: NodeId, clipped: boolean) => {
    const n = doc.nodes[id]
    if (!n || n.kind === 'mask' || n.kind === 'filter') return
    const name = n.name
    // A smart object's or text's warp goes out as Photoshop's own; any other filter can't.
    if (n.effects.some((e) => doc.nodes[e]?.kind === 'filter' && !((n.kind === 'embedded' || n.kind === 'text') && e === warpEffectId(n))))
      warn('Live filters were left out (Photoshop’s smart filters are on smart objects); bake them in first to keep them')
    const { mask, vector } = masksFor(n)
    const base = { name, blend: blendKey(n.blend === 'pass-through' ? 'normal' : n.blend), opacity: Math.round(n.opacity * 255), clipping: clipped ? 1 : 0, flags: flagsOf(n), mask }
    if (n.kind === 'group') {
      layers.push({
        ...base,
        name: '</Layer group>',
        blend: 'norm',
        opacity: 255,
        clipping: 0,
        flags: 8,
        blocks: [
          { key: 'luni', data: unicode('</Layer group>') },
          { key: 'lsct', data: bytesOf((w) => w.u32(3)) },
        ],
        content: null,
        mask: null,
      })
      for (const c of n.children ?? []) await add(c, false)
      const blocks = common(n, name)
      blocks.push({ key: 'lsct', data: bytesOf((w) => (w.u32(1), w.sig('8BIM'), w.sig(n.blend === 'pass-through' ? 'pass' : blendKey(n.blend)))) })
      if (n.props.knockout !== 'none') blocks.push({ key: 'knko', data: bytesOf((w) => (w.u8(1), w.zeros(3))) })
      if (vector) blocks.push(vector)
      layers.push({ ...base, blend: n.blend === 'pass-through' ? 'pass' : blendKey(n.blend), blocks, content: null })
      return
    }
    const blocks = common(n, name)
    let content: PixelSource = null
    // A Live Paint group goes as its pixels: Photoshop has nothing like it.
    if (n.kind === 'boolean' && n.props.live) {
      warn('A Live Paint group went out as its pixels')
      layers.push({ ...base, blocks, content: { kind: 'node', node: n.id } })
      return
    }
    switch (n.kind) {
      case 'pixel': {
        const t = n.transform
        const whole = t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && Number.isInteger(t[4]) && Number.isInteger(t[5])
        content = n.props.tiles ? (whole ? { kind: 'set', set: n.props.tiles, dx: t[4], dy: t[5] } : { kind: 'node', node: n.id }) : null
        if (vector) blocks.push(vector)
        break
      }
      case 'vector':
      case 'boolean': {
        content = { kind: 'node', node: n.id }
        const path = nodePath(n)
        const items = n.props.appearance.filter((a) => a.enabled)
        if (items.some((a) => a.effects?.some((e) => e.enabled))) warn('A fill’s or stroke’s own effects were left out: Photoshop’s shapes have none (the layer’s pixels keep the look)')
        const fill = items.find((a) => a.kind === 'fill')
        const stroke = items.find((a) => a.kind === 'stroke') as Extract<AppearanceItem, { kind: 'stroke' }> | undefined
        if (items.filter((a) => a.kind === 'fill').length > 1 || items.filter((a) => a.kind === 'stroke').length > 1)
          warn('Shapes with more than one fill or stroke keep their first of each live; the rest are in their pixels')
        if (stroke?.brush) warn(`A stroke drawn with the brush “${stroke.brush.name}” is in the layer’s pixels; Photoshop has no vector brushes, so its live stroke is plain`)
        else if (stroke && strokeNeedsOutline(stroke)) warn('A stroke’s width profile, arrowheads or dashes fitted to corners are in the layer’s pixels; its live stroke in Photoshop is plain')
        const fb = fill ? fillBlock(fill.paint) : null
        if (path && (fb || stroke)) {
          blocks.push(fb ?? { key: 'SoCo', data: descData(desc('null', [['Clr ', colourDesc(mode === 'cmyk' ? [0, 0, 0, 0] : mode === 'gray' ? [1] : [1, 1, 1])]])) })
          blocks.push({ key: 'vmsk', data: pathBlock(path) })
          blocks.push(strokeBlock(stroke ?? null, !!fb))
        }
        if (vector) warn('A shape’s own vector mask was left out: a shape layer’s vector mask is its outline')
        break
      }
      case 'fill': {
        // Photoshop's own fill layer: the paint, no outline, the pixels drawn over the canvas.
        content = { kind: 'node', node: n.id }
        const fb = fillBlock(n.props.paint)
        if (fb) blocks.push(fb)
        if (vector) blocks.push(vector)
        break
      }
      case 'text':
        content = { kind: 'node', node: n.id }
        blocks.push(typeBlock(n))
        if (vector) blocks.push(vector)
        break
      case 'adjustment':
        blocks.push(...adjustmentBlocks(n))
        if (vector) blocks.push(vector)
        break
      case 'embedded': {
        content = { kind: 'node', node: n.id }
        const so = await smartBlock(n)
        if (so) blocks.push(so)
        if (vector) blocks.push(vector)
        break
      }
      default:
        warn(`A ${n.kind} layer was left out`)
        return
    }
    layers.push({ ...base, blocks, content })
    // Layers clipped to this one follow it.
    for (const c of n.children ?? []) await addClipped(c)
  }
  const addClipped = async (id: NodeId) => {
    const n = doc.nodes[id]
    if (!n) return
    if (n.children?.length && n.kind !== 'group') {
      warn('Layers clipped to a clipped layer were clipped to the layer below them all')
      await add(id, true)
      return
    }
    await add(id, true)
  }

  for (const c of doc.nodes[doc.root].children ?? []) await add(c, false)
  if (linked.length) globalBlocks.push({ key: 'lnk2', data: concat(linked) })

  // --- resources -----------------------------------------------------------------------------------
  const resources: PsdResource[] = []
  resources.push({
    id: 1005,
    name: '',
    data: bytesOf((w) => {
      w.u32(Math.round(doc.resolution * 65536))
      w.u16(1)
      w.u16(2)
      w.u32(Math.round(doc.resolution * 65536))
      w.u16(1)
      w.u16(2)
    }),
  })
  resources.push({ id: 1037, name: '', data: bytesOf((w) => w.i32(120)) })
  resources.push({ id: 1049, name: '', data: bytesOf((w) => w.i32(30)) })
  if (host.icc) resources.push({ id: 1039, name: '', data: host.icc })
  // Guides, in 1/32 pixels, as Photoshop keeps them.
  if (doc.guides.length) {
    resources.push({
      id: 1032,
      name: '',
      data: bytesOf((w) => {
        w.i32(1)
        w.i32(576)
        w.i32(576)
        w.i32(doc.guides.length)
        for (const g of doc.guides) {
          w.i32(Math.round(g.at * 32))
          w.u8(g.axis === 'x' ? 0 : 1)
        }
      }),
    })
  }

  // Alpha and spot channels: their names (Unicode and Pascal) and how each shows, as Photoshop reads them.
  const docChannels = doc.channels ?? []
  if (docChannels.length) {
    resources.push({ id: 1045, name: '', data: bytesOf((w) => docChannels.forEach((c) => w.unicode(c.name))) })
    resources.push({
      id: 1006,
      name: '',
      data: bytesOf((w) => {
        for (const c of docChannels) {
          const name = c.name.replace(/[^\x20-\xff]/g, '?').slice(0, 255)
          w.u8(name.length)
          for (let i = 0; i < name.length; i++) w.u8(name.charCodeAt(i))
        }
      }),
    })
    resources.push({
      id: 1077,
      name: '',
      data: bytesOf((w) => {
        w.u32(1)
        for (const c of docChannels) {
          const { space, values } = colourStruct(channelKind(c) === 'spot' && c.ink ? c.ink : { space: 'rgb', c: c.tint ?? ALPHA_TINT })
          w.u16(space)
          for (const v of values) w.u16(v)
          w.u16(Math.round(channelOpacity(c) * 100))
          w.u8(channelKind(c) === 'spot' ? 2 : c.marks === 'selected' ? 0 : 1)
        }
      }),
    })
  }

  const plan: PsdPlan = {
    key,
    psb: !!o.psb || doc.width > 30000 || doc.height > 30000,
    width: doc.width,
    height: doc.height,
    mode: mode === 'cmyk' ? 4 : mode === 'rgb' ? 3 : 1,
    depth: doc.depth,
    resources,
    layers,
    blocks: globalBlocks,
    ...(docChannels.length ? { channels: docChannels.map((c) => ({ id: c.id, spot: channelKind(c) === 'spot' })) } : {}),
  }
  return { plan, warnings: [...warnings] }
}

/** A colour as Photoshop's colour structure: a space id and four 16-bit values. */
function colourStruct(v: { space: string; c: number[] }): { space: number; values: number[] } {
  const u = (x: number, k: number) => Math.round(Math.min(1, Math.max(0, x)) * k)
  const s16 = (x: number) => (Math.round(x * 100) + 65536) % 65536
  switch (v.space) {
    case 'cmyk':
      return { space: 2, values: v.c.map((x) => 65535 - u(x, 65535)) }
    case 'gray':
      return { space: 8, values: [10000 - u(v.c[0], 10000), 0, 0, 0] }
    case 'lab':
      return { space: 7, values: [Math.round(Math.min(100, Math.max(0, v.c[0])) * 100), s16(v.c[1]), s16(v.c[2]), 0] }
    default:
      return { space: 0, values: [...v.c.slice(0, 3).map((x) => u(x, 65535)), 0] }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
