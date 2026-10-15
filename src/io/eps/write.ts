/**
 * A document as Encapsulated PostScript (EPSF 3.0, PostScript Level 3),
 * for print tools that still want EPS. One picture the document's size (at
 * its resolution), in the document's own device colours: DeviceCMYK for a
 * CMYK document (ink, as Plexel keeps it), DeviceRGB or DeviceGray for the
 * others. EPS has no colour profiles, so the numbers go as they are.
 *
 * PostScript has no transparency, so EPS takes less as vectors than PDF:
 *
 *   flattened       everything at the root up to the topmost layer that
 *                   isn't a plain opaque shape or text (any pixels, any
 *                   opacity or blend mode, effects, masks other than vector
 *                   clips) is one image, its clear parts left unpainted (a
 *                   colour-keyed image, ImageType 4)
 *   shapes, text    above that, as paths filled and stroked; gradients as
 *                   Level 3 shadings (shfill); text as outlines; strokes
 *                   with profiles, arrowheads or brushes as their outlines
 *   spot colours    fills and strokes linked to a spot swatch in a
 *                   Separation colour space named for the ink, its process
 *                   colour as the alternate
 *   spot channels   each an image in its ink's Separation space over
 *                   everything, overprinting, so it's a plate of its own
 *
 * Image data is Flate-compressed and ASCII85-encoded, so the file is 7-bit
 * clean. `host` is the PDF writer's.
 */
import { geometryPath, type AppearanceItem, type Paint } from '../../doc/vector'
import { brushAsPaths, strokeAsPath } from '../../vector/outline'
import { strokeNeedsOutline } from '../../doc/vector'
import { glyphsToPath } from '../../geom/glyphs'
import { transformPath, type PathData } from '../../geom/path'
import { docPathOf } from '../../vector/shape'
import type { ParamColour } from '../../doc/params'
import type { DocSwatch } from '../../doc/swatches'
import type { Doc, DocNode, NodeId } from '../../doc/types'
import type { NodeImage } from '../../engine/nodeImage'
import { asVector, groupAsGroup } from '../flat'
import type { PdfHost } from '../pdf/write'

export type EpsHost = Omit<PdfHost, 'icc'>

const f = (v: number) => {
  if (!Number.isFinite(v)) return '0'
  const r = Math.round(v * 10000) / 10000
  return Object.is(r, -0) ? '0' : String(r)
}
/** A PostScript string, 7-bit: printable ASCII as it is, the rest as octal escapes of its UTF-8. */
export function psString(s: string): string {
  let out = ''
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b)
    out += b >= 0x20 && b < 0x7f ? (c === '(' || c === ')' || c === '\\' ? `\\${c}` : c) : `\\${b.toString(8).padStart(3, '0')}`
  }
  return `(${out})`
}

/** Bytes as ASCII85 (with its ~> end), in lines of 75. */
export function ascii85(b: Uint8Array): string {
  let out = ''
  let line = 0
  const put = (s: string) => {
    for (const ch of s) {
      out += ch
      if (++line === 75) {
        out += '\n'
        line = 0
      }
    }
  }
  for (let i = 0; i < b.length; i += 4) {
    const n = Math.min(4, b.length - i)
    let v = 0
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? b[i + k] : 0)
    if (n === 4 && v === 0) {
      put('z')
      continue
    }
    const digits = new Array<string>(5)
    for (let k = 4; k >= 0; k--) {
      digits[k] = String.fromCharCode(33 + (v % 85))
      v = Math.floor(v / 85)
    }
    put(digits.slice(0, n + 1).join(''))
  }
  return `${out}~>`
}

/** Blend modes are all Normal in EPS, and nothing is see-through: what a node needs to be written as vectors here. */
const itemOpaque = (it: AppearanceItem) => !it.enabled || (it.opacity >= 1 && it.blend === 'normal' && (it.paint.kind !== 'gradient' || it.paint.stops.every((s) => s.alpha >= 1)))

/** Whether a node goes into EPS as vectors: a plain opaque shape or text (or a group of them), clipped by vector masks at most. */
export function epsVector(doc: Doc, n: DocNode | undefined): boolean {
  if (!n || !n.visible) return true
  if (n.kind === 'mask') return true
  if (n.opacity < 1 || (n.blend !== 'normal' && n.blend !== 'pass-through')) return false
  if (n.kind === 'group') return groupAsGroup(doc, n) && (n.children ?? []).every((c) => epsVector(doc, doc.nodes[c]))
  if (n.fillOpacity < 1) return false
  // Layers clipped to it are drawn through it: pixels.
  if ((n.children ?? []).some((c) => doc.nodes[c]?.visible)) return false
  if (!asVector(doc, n)) return false
  return (n.props as { appearance: AppearanceItem[] }).appearance.every(itemOpaque)
}

/** How many of the root's children (from the bottom) are flattened into the one image: up to the topmost that isn't vectors. */
export function epsFlattenCount(doc: Doc): number {
  const kids = doc.nodes[doc.root].children ?? []
  for (let i = kids.length - 1; i >= 0; i--) if (!epsVector(doc, doc.nodes[kids[i]])) return i + 1
  return 0
}

export async function docToEps(doc: Doc, host: EpsHost): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings = new Set<string>()
  const warn = (w: string) => warnings.add(w)
  const device = doc.mode === 'cmyk' ? '/DeviceCMYK' : doc.mode === 'rgb' ? '/DeviceRGB' : '/DeviceGray'
  const white: ParamColour = doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1]
  const swatches = new Map((doc.swatches ?? []).map((s) => [s.id, s]))
  /** The inks named in the file, with their process colours, for the header. */
  const inks = new Map<string, ParamColour>()

  // --- colour ----------------------------------------------------------------------------------------
  const setColour = (c: ParamColour) => (doc.mode === 'cmyk' ? `${c.slice(0, 4).map(f).join(' ')} setcmykcolor\n` : doc.mode === 'rgb' ? `${c.slice(0, 3).map(f).join(' ')} setrgbcolor\n` : `${f(c[0])} setgray\n`)
  /** A Separation colour space for an ink: its tint t made the process colour white + (full − white) · t. */
  const separation = (name: string, full: ParamColour) => {
    inks.set(name, full)
    const parts = full.map((v, i) => `${f(v - white[i])} mul ${f(white[i])} add`)
    const proc = parts.map((p, i) => (i < parts.length - 1 ? `dup ${p} exch` : p)).join(' ')
    return `[/Separation ${psString(name)} cvn ${device} {${proc}}]`
  }
  const spotSpace = (s: DocSwatch) => separation(s.name, host.spotColour(s))
  const paintColour = (p: Paint): string => {
    const linked = p.kind === 'solid' && p.swatch ? swatches.get(p.swatch) : undefined
    if (linked?.kind === 'spot' && p.kind === 'solid') return `${spotSpace(linked)} setcolorspace ${f(p.tint ?? 1)} setcolor\n`
    return setColour(p.kind === 'solid' ? p.colour : p.kind === 'gradient' ? p.stops[0].colour : p.colour)
  }

  // --- paths -----------------------------------------------------------------------------------------
  const pathOps = (p: PathData): string => {
    let o = ''
    for (const s of p.subpaths) {
      const a = s.anchors
      if (!a.length) continue
      o += `${f(a[0].p[0])} ${f(a[0].p[1])} moveto\n`
      const seg = (i: number, j: number) => {
        const p0 = a[i]
        const p1 = a[j]
        if (p0.out || p1.in) {
          const c1 = p0.out ?? p0.p
          const c2 = p1.in ?? p1.p
          o += `${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p1.p[0])} ${f(p1.p[1])} curveto\n`
        } else o += `${f(p1.p[0])} ${f(p1.p[1])} lineto\n`
      }
      for (let i = 0; i + 1 < a.length; i++) seg(i, i + 1)
      if (s.closed) {
        if (a.length > 1) seg(a.length - 1, 0)
        o += 'closepath\n'
      }
    }
    return o
  }
  const boxOf = (p: PathData): [number, number, number, number] | null => {
    let b: [number, number, number, number] | null = null
    for (const s of p.subpaths)
      for (const a of s.anchors)
        for (const q of [a.p, a.in, a.out]) {
          if (!q) continue
          b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])] : [q[0], q[1], q[0], q[1]]
        }
    return b
  }
  /** A gradient as a Level 3 shading, laid across the shape's box as Plexel lays it. */
  const shading = (p: Extract<Paint, { kind: 'gradient' }>, box: [number, number, number, number] | null): string => {
    const b = box ?? [0, 0, 1, 1]
    const cx = (b[0] + b[2]) / 2
    const cy = (b[1] + b[3]) / 2
    const w = Math.max(1e-6, b[2] - b[0])
    const h = Math.max(1e-6, b[3] - b[1])
    const stops = p.reverse ? [...p.stops].reverse().map((s) => ({ ...s, at: 1 - s.at })) : p.stops
    const fns = stops.slice(1).map((s, i) => `<< /FunctionType 2 /Domain [0 1] /C0 [${stops[i].colour.map(f).join(' ')}] /C1 [${s.colour.map(f).join(' ')}] /N 1 >>`)
    const fn = fns.length === 1 ? fns[0] : `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${stops.slice(1, -1).map((s) => f(s.at)).join(' ')}] /Encode [${fns.map(() => '0 1').join(' ')}] >>`
    const scale = p.scale / 100
    if (p.type === 'radial') {
      const r = (Math.max(w, h) / 2) * scale
      return `<< /ShadingType 3 /ColorSpace ${device} /Coords [${f(cx)} ${f(cy)} 0 ${f(cx)} ${f(cy)} ${f(r)}] /Function ${fn} /Extend [true true] >> shfill\n`
    }
    const a = (p.angle * Math.PI) / 180
    const dx = Math.cos(a)
    const dy = -Math.sin(a)
    const half = ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale
    return `<< /ShadingType 2 /ColorSpace ${device} /Coords [${f(cx - dx * half)} ${f(cy - dy * half)} ${f(cx + dx * half)} ${f(cy + dy * half)}] /Function ${fn} /Extend [true true] >> shfill\n`
  }
  /** A path filled with a paint: a colour, or a gradient through the path as a clip. */
  const fillWith = (path: PathData, paint: Paint, box: [number, number, number, number] | null, cut = ''): string => {
    const even = path.fillRule === 'evenodd'
    if (paint.kind === 'gradient') return `gsave\n${cut}${pathOps(path)}${even ? 'eoclip' : 'clip'} newpath\n${shading(paint, box)}grestore\n`
    return `gsave\n${cut}${paintColour(paint)}${pathOps(path)}${even ? 'eofill' : 'fill'}\ngrestore\n`
  }

  /** A path's fills and strokes, in order, in its own coordinates (the caller's concat places it). */
  const paintPath = (path: PathData, items: AppearanceItem[]): string => {
    let o = ''
    const box = boxOf(path)
    const even = path.fillRule === 'evenodd'
    for (const it of items) {
      if (!it.enabled) continue
      if (it.kind === 'fill') {
        o += fillWith(path, it.paint, box)
        continue
      }
      // An inside stroke is one twice as wide clipped to the shape; an outside one, clipped to all but it.
      const pb = box ?? [0, 0, 0, 0]
      const pad = it.width * Math.max(4, it.miter) + 2
      const cut =
        it.align === 'inside'
          ? `${pathOps(path)}${even ? 'eoclip' : 'clip'} newpath\n`
          : it.align === 'outside'
            ? `${f(pb[0] - pad)} ${f(pb[1] - pad)} moveto ${f(pb[2] + pad)} ${f(pb[1] - pad)} lineto ${f(pb[2] + pad)} ${f(pb[3] + pad)} lineto ${f(pb[0] - pad)} ${f(pb[3] + pad)} lineto closepath\n${pathOps(path)}eoclip newpath\n`
            : ''
      if (it.brush) {
        // A brush stroke: its artwork's parts, each filled in its paint.
        for (const p of brushAsPaths(path, it, doc.mode)) o += fillWith(p.path, p.paint, box)
        continue
      }
      if (strokeNeedsOutline(it)) {
        o += fillWith(strokeAsPath(path, it), it.paint, box, cut)
        continue
      }
      const st = `${f(it.align === 'centre' ? it.width : it.width * 2)} setlinewidth ${it.cap === 'round' ? 1 : it.cap === 'square' ? 2 : 0} setlinecap ${it.join === 'round' ? 1 : it.join === 'bevel' ? 2 : 0} setlinejoin ${f(it.miter)} setmiterlimit [${it.dash.map(f).join(' ')}] ${f(it.dashOffset)} setdash\n`
      if (it.paint.kind === 'gradient') {
        // A gradient along a stroke: its outline, filled with the shading.
        o += fillWith(strokeAsPath(path, it), it.paint, box, cut)
        continue
      }
      o += `gsave\n${cut}${st}${paintColour(it.paint)}${pathOps(path)}stroke\ngrestore\n`
    }
    return o
  }

  // --- images ----------------------------------------------------------------------------------------
  /**
   * An image in the document's samples: its clear parts unpainted, by a key
   * colour no painted pixel has (ImageType 4); what's partly see-through
   * laid on white paper.
   */
  const imageOps = async (img: NodeImage | null): Promise<string> => {
    if (!img) return ''
    const ch = img.channels
    const nc = ch - 1
    const count = img.w * img.h
    const colour = new Uint8Array(count * nc)
    let clear = false
    for (let i = 0; i < count; i++) {
      const a = img.data[i * ch + nc] / 255
      if (a < 0.5) {
        clear = true
        continue
      }
      for (let c = 0; c < nc; c++) colour[i * nc + c] = Math.round(img.data[i * ch + c] * a + white[c] * 255 * (1 - a))
    }
    let mask = ''
    if (clear) {
      // A key colour no painted pixel is: tried from a few unlikely ones.
      let k: number[] = []
      for (let t = 1; t < 255 && !k.length; t++) {
        const cand = Array.from({ length: nc }, (_, c) => (t * (c + 3) + 7) % 256)
        let hit = false
        for (let i = 0; i < count && !hit; i++) if (img.data[i * ch + nc] >= 128 && cand.every((v, c) => colour[i * nc + c] === v)) hit = true
        if (!hit) k = cand
      }
      for (let i = 0; i < count; i++) if (img.data[i * ch + nc] < 128) colour.set(k, i * nc)
      mask = ` /MaskColor [${k.join(' ')}]`
    }
    const data = ascii85(await host.deflate(colour))
    const decode = Array.from({ length: nc }, () => '0 1').join(' ')
    return `gsave\n${device} setcolorspace\n${f(img.x)} ${f(img.y)} translate ${f(img.w)} ${f(img.h)} scale\n<< /ImageType ${clear ? 4 : 1} /Width ${img.w} /Height ${img.h} /BitsPerComponent 8 /Decode [${decode}] /ImageMatrix [${img.w} 0 0 ${img.h} 0 0]${mask} /DataSource currentfile /ASCII85Decode filter /FlateDecode filter >> image\n${data}\ngrestore\n`
  }

  const clipOps = (node: DocNode): string => {
    const vm = node.masks.map((m) => doc.nodes[m]).find((m) => m?.kind === 'mask' && m.visible && m.props.source === 'vector' && m.props.geometry)
    if (!vm || vm.kind !== 'mask' || !vm.props.geometry) return ''
    const p = transformPath(geometryPath(vm.props.geometry), vm.transform)
    return `${pathOps(p)}${p.fillRule === 'evenodd' ? 'eoclip' : 'clip'} newpath\n`
  }

  // --- the tree --------------------------------------------------------------------------------------
  const nodeOps = (id: NodeId): string => {
    const node = doc.nodes[id]
    if (!node || !node.visible || node.kind === 'mask') return ''
    const clip = clipOps(node)
    if (node.kind === 'group') {
      let body = ''
      for (const c of node.children ?? []) body += nodeOps(c)
      return body ? `gsave\n${clip}${body}grestore\n` : ''
    }
    let body = ''
    if (node.kind === 'text') {
      const l = host.layout(node)
      if (!l) {
        warn('Text whose fonts hadn’t loaded was left out')
        return ''
      }
      warn('Text is in the EPS as outlines: exact, though not editable')
      body = `[${node.transform.map(f).join(' ')}] concat\n${paintPath(glyphsToPath(l.glyphs), node.props.appearance)}`
    } else if (node.kind === 'boolean') {
      const p = docPathOf((x) => doc.nodes[x], node)
      if (p) body = paintPath(p, node.props.appearance)
    } else if (node.kind === 'vector' && node.props.geometry) body = `[${node.transform.map(f).join(' ')}] concat\n${paintPath(geometryPath(node.props.geometry), node.props.appearance)}`
    return body ? `gsave\n${clip}${body}grestore\n` : ''
  }

  let content = `gsave\n${f(72 / doc.resolution)} 0 0 ${f(-72 / doc.resolution)} 0 ${f((doc.height * 72) / doc.resolution)} 6 array astore concat\n`
  const kids = doc.nodes[doc.root].children ?? []
  const flat = epsFlattenCount(doc)
  if (flat) {
    warn(flat === kids.length ? 'EPS has no transparency, so the picture is one image (shapes and text that are fully opaque stay vectors only above everything else)' : 'EPS has no transparency: the layers up to the last one with pixels, opacity, a blend mode or effects are one image; the shapes and text above it are vectors')
    content += await imageOps(await host.flattened(flat))
  }
  for (const c of kids.slice(flat)) content += nodeOps(c)
  // Spot channels over everything, overprinting: each ink on its own plate, where it has ink (tint 0 unpainted).
  const spotPlanes = (await host.spotChannels?.()) ?? []
  for (const sp of spotPlanes) {
    const space = separation(sp.name, sp.full)
    content += `gsave\ntrue setoverprint\n${space} setcolorspace\n0 0 translate ${sp.width} ${sp.height} scale\n<< /ImageType 4 /Width ${sp.width} /Height ${sp.height} /BitsPerComponent 8 /Decode [0 1] /ImageMatrix [${sp.width} 0 0 ${sp.height} 0 0] /MaskColor [0] /DataSource currentfile /ASCII85Decode filter /FlateDecode filter >> image\n${ascii85(await host.deflate(sp.data))}\ngrestore\n`
  }
  content += 'grestore\n'
  if (doc.mode !== 'cmyk') warn(`EPS has no colour profiles: the colours are the document’s ${doc.mode === 'rgb' ? 'RGB' : 'Gray'} numbers, as the printer’s device takes them`)

  const w = (doc.width * 72) / doc.resolution
  const h = (doc.height * 72) / doc.resolution
  const date = host.now
  const header = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(w)} ${Math.ceil(h)}`,
    `%%HiResBoundingBox: 0 0 ${f(w)} ${f(h)}`,
    '%%Creator: Plexel',
    `%%Title: ${psString(doc.name)}`,
    `%%CreationDate: ${date.toISOString()}`,
    '%%DocumentData: Clean7Bit',
    '%%LanguageLevel: 3',
    doc.mode === 'cmyk' ? '%%DocumentProcessColors: Cyan Magenta Yellow Black' : null,
    inks.size ? `%%DocumentCustomColors: ${[...inks.keys()].map(psString).join(' ')}` : null,
    ...[...inks].map(([name, full]) => (doc.mode === 'cmyk' ? `%%CMYKCustomColor: ${full.slice(0, 4).map(f).join(' ')} ${psString(name)}` : doc.mode === 'rgb' ? `%%RGBCustomColor: ${full.slice(0, 3).map(f).join(' ')} ${psString(name)}` : null)),
    `%%Pages: 1`,
    '%%EndComments',
    '%%BeginProlog',
    '%%EndProlog',
    '%%Page: 1 1',
  ].filter((x): x is string => x !== null)
  const text = `${header.join('\n')}\n${content}showpage\n%%Trailer\n%%EOF\n`
  return { bytes: new TextEncoder().encode(text), warnings: [...warnings] }
}
