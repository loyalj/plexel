/**
 * A document as a PDF, for print: one page the document's size (at its
 * resolution), in the document's own colour space (its ICC profile), with
 * vectors where PDF can hold them and images where it can't (io/flat.ts
 * decides which).
 *
 *   shapes          paths, filled and stroked, in the document's colours
 *                   (an ICCBased colour space); linear and radial
 *                   gradients as axial and radial shadings
 *   spot colours    fills and strokes linked to a spot swatch use a
 *                   Separation colour space named for it, its process
 *                   equivalent as the alternate, so a RIP makes a plate
 *   spot channels   each an image in its ink's Separation space (shared
 *                   with a spot swatch of the same name), over everything
 *                   and overprinting, so it's a plate of its own
 *   text            outlines, exact (live text comes later)
 *   opacity, blend  ExtGState: constant alpha and the blend mode
 *   groups          transparency groups (isolated unless pass-through)
 *   vector masks    clipping paths
 *   the rest        images in the document's own samples (CMYK as ink),
 *                   their transparency as a soft mask
 *   CMYK            a PDF/X-4 output intent of the document's profile
 */
import { geometryPath, mainColour, type AppearanceItem, type Paint } from '../../doc/vector'
import { brushAsPaths, characterGroups, strokeAsPath } from '../../vector/outline'
import { strokeNeedsOutline } from '../../doc/vector'
import { glyphsToPath } from '../../geom/glyphs'
import { transformPath, type PathData } from '../../geom/path'
import { docPathOf } from '../../vector/shape'
import type { ParamColour } from '../../doc/params'
import type { DocSwatch } from '../../doc/swatches'
import type { Doc, DocNode, NodeId } from '../../doc/types'
import type { NodeImage } from '../../engine/nodeImage'
import type { TextLayout } from '../../text/layout'
import { asVector, flattenCount, groupAsGroup } from '../flat'

export interface PdfHost {
  /** A node rendered as it composites but at full strength, alone: the document's own 8-bit samples (CMYK as ink) and alpha. */
  image(node: NodeId): Promise<NodeImage | null>
  /** The root's first `count` children flattened, likewise. */
  flattened(count: number): Promise<NodeImage | null>
  layout(node: DocNode): TextLayout | null
  icc: Uint8Array | null
  profileName: string
  /** A spot swatch's full-strength colour in the document's terms. */
  spotColour(s: DocSwatch): ParamColour
  /** The document's spot channels: each one's ink (its name, its full strength in the document's terms) and its plane over the canvas, a byte a pixel, 255 full ink. */
  spotChannels?(): Promise<{ name: string; full: ParamColour; width: number; height: number; data: Uint8Array }[]>
  deflate(b: Uint8Array): Promise<Uint8Array>
  /** For the file's ID and dates. */
  now: Date
}

const PDF_BLEND: Record<string, string> = {
  normal: 'Normal',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  darken: 'Darken',
  lighten: 'Lighten',
  'color-dodge': 'ColorDodge',
  'color-burn': 'ColorBurn',
  'hard-light': 'HardLight',
  'soft-light': 'SoftLight',
  difference: 'Difference',
  exclusion: 'Exclusion',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
}

const f = (v: number) => {
  if (!Number.isFinite(v)) return '0'
  const r = Math.round(v * 10000) / 10000
  return Object.is(r, -0) ? '0' : String(r)
}
const pdfString = (s: string) => {
  // Text strings as UTF-16BE with a BOM when they aren't plain ASCII.
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/([\\()])/g, '\\$1')})`
  let hex = 'FEFF'
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
  return `<${hex}>`
}
const pdfName = (s: string) => '/' + s.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))

class Objects {
  private parts: Uint8Array[] = []
  private bodies: (Uint8Array | null)[] = []
  private enc = new TextEncoder()

  reserve(): number {
    this.bodies.push(null)
    return this.bodies.length
  }
  set(n: number, body: string | Uint8Array) {
    this.bodies[n - 1] = typeof body === 'string' ? this.enc.encode(body) : body
  }
  add(body: string | Uint8Array): number {
    const n = this.reserve()
    this.set(n, body)
    return n
  }
  stream(dict: string, data: Uint8Array): number {
    const head = this.enc.encode(`<< ${dict} /Length ${data.length} >>\nstream\n`)
    const tail = this.enc.encode('\nendstream')
    const b = new Uint8Array(head.length + data.length + tail.length)
    b.set(head)
    b.set(data, head.length)
    b.set(tail, head.length + data.length)
    return this.add(b)
  }
  finish(trailer: string): Uint8Array {
    const header = this.enc.encode('%PDF-1.6\n%\xe2\xe3\xcf\xd3\n')
    this.parts = [header]
    const offsets: number[] = []
    let pos = header.length
    this.bodies.forEach((b, i) => {
      const head = this.enc.encode(`${i + 1} 0 obj\n`)
      const tail = this.enc.encode('\nendobj\n')
      offsets.push(pos)
      this.parts.push(head, b ?? this.enc.encode('null'), tail)
      pos += head.length + (b?.length ?? 4) + tail.length
    })
    let xref = `xref\n0 ${this.bodies.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
    this.parts.push(this.enc.encode(`${xref}trailer\n<< /Size ${this.bodies.length + 1} ${trailer} >>\nstartxref\n${pos}\n%%EOF\n`))
    const out = new Uint8Array(this.parts.reduce((a, p) => a + p.length, 0))
    let o = 0
    for (const p of this.parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }
}

export async function docToPdf(doc: Doc, host: PdfHost): Promise<{ bytes: Uint8Array; warnings: string[] }> {
  const warnings = new Set<string>()
  const warn = (w: string) => warnings.add(w)
  const objs = new Objects()
  const n = doc.mode === 'cmyk' ? 4 : doc.mode === 'rgb' ? 3 : 1
  const device = doc.mode === 'cmyk' ? '/DeviceCMYK' : doc.mode === 'rgb' ? '/DeviceRGB' : '/DeviceGray'
  // The document's colour space: its profile, or the device space when there's none.
  const iccRef = host.icc ? objs.stream(`/N ${n} /Alternate ${device} /Filter /FlateDecode`, await host.deflate(host.icc)) : 0
  const cs = iccRef ? `[/ICCBased ${iccRef} 0 R]` : device
  const csRef = objs.add(cs)
  // The page's resources, shared by its forms: numbered now, written last, when they're all known.
  const resRef = objs.reserve()

  const res = { ExtGState: new Map<string, string>(), XObject: new Map<string, number>(), Shading: new Map<string, number>(), ColorSpace: new Map<string, string>([['CS0', `${csRef} 0 R`]]) }
  let names = 0
  const gs = (ca: number, CA: number, blend: string) => {
    const key = `${f(ca)}/${f(CA)}/${blend}`
    for (const [k, v] of res.ExtGState) if (v.endsWith(`%${key}`)) return k
    const name = `G${names++}`
    res.ExtGState.set(name, `<< /Type /ExtGState /ca ${f(ca)} /CA ${f(CA)} /BM /${PDF_BLEND[blend] ?? 'Normal'} >> %${key}`)
    return name
  }
  // Spot colours, one Separation space each, by the ink's name: a spot swatch and a spot channel of the same name are one ink.
  const spots = new Map<string, string>()
  const separation = (inkName: string, full: ParamColour) => {
    let name = spots.get(inkName)
    if (name) return name
    name = `CS${res.ColorSpace.size}`
    const white = doc.mode === 'cmyk' ? [0, 0, 0, 0] : doc.mode === 'gray' ? [1] : [1, 1, 1]
    // PDF's CMYK is ink, like Plexel's; RGB and Gray are light.
    res.ColorSpace.set(name, `[/Separation ${pdfName(inkName)} ${csRef} 0 R << /FunctionType 2 /Domain [0 1] /C0 [${white.map(f).join(' ')}] /C1 [${full.map(f).join(' ')}] /N 1 >>]`)
    spots.set(inkName, name)
    return name
  }
  const spotSpace = (s: DocSwatch) => separation(s.name, host.spotColour(s))
  const swatches = new Map((doc.swatches ?? []).map((s) => [s.id, s]))

  // --- paint operators -------------------------------------------------------------------------------
  const colourOp = (c: ParamColour, stroke: boolean) => `/CS0 ${stroke ? 'CS' : 'cs'} ${c.map(f).join(' ')} ${stroke ? 'SCN' : 'scn'}`
  const pathOps = (p: PathData): string => {
    let o = ''
    for (const s of p.subpaths) {
      const a = s.anchors
      if (!a.length) continue
      o += `${f(a[0].p[0])} ${f(a[0].p[1])} m\n`
      const seg = (i: number, j: number) => {
        const p0 = a[i]
        const p1 = a[j]
        if (p0.out || p1.in) {
          const c1 = p0.out ?? p0.p
          const c2 = p1.in ?? p1.p
          o += `${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p1.p[0])} ${f(p1.p[1])} c\n`
        } else o += `${f(p1.p[0])} ${f(p1.p[1])} l\n`
      }
      for (let i = 0; i + 1 < a.length; i++) seg(i, i + 1)
      if (s.closed) {
        if (a.length > 1) seg(a.length - 1, 0)
        o += 'h\n'
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
  /** A gradient as a shading in the shape's own coordinates, as Plexel lays it out across the box. */
  const shading = (p: Extract<Paint, { kind: 'gradient' }>, box: [number, number, number, number] | null): string => {
    const b = box ?? [0, 0, 1, 1]
    const cx = (b[0] + b[2]) / 2
    const cy = (b[1] + b[3]) / 2
    const w = Math.max(1e-6, b[2] - b[0])
    const h = Math.max(1e-6, b[3] - b[1])
    const stops = p.reverse ? [...p.stops].reverse().map((s) => ({ ...s, at: 1 - s.at })) : p.stops
    if (stops.some((s) => s.alpha < 1)) warn('Gradients with transparent stops are drawn opaque in the PDF')
    const fns = stops.slice(1).map((s, i) => `<< /FunctionType 2 /Domain [0 1] /C0 [${stops[i].colour.map(f).join(' ')}] /C1 [${s.colour.map(f).join(' ')}] /N 1 >>`)
    const fn = fns.length === 1 ? fns[0] : `<< /FunctionType 3 /Domain [0 1] /Functions [${fns.join(' ')}] /Bounds [${stops.slice(1, -1).map((s) => f(s.at)).join(' ')}] /Encode [${fns.map(() => '0 1').join(' ')}] >>`
    const scale = p.scale / 100
    let dict: string
    if (p.type === 'radial') {
      const r = (Math.max(w, h) / 2) * scale
      dict = `<< /ShadingType 3 /ColorSpace ${csRef} 0 R /Coords [${f(cx)} ${f(cy)} 0 ${f(cx)} ${f(cy)} ${f(r)}] /Function ${fn} /Extend [true true] >>`
    } else {
      const a = (p.angle * Math.PI) / 180
      const dx = Math.cos(a)
      const dy = -Math.sin(a)
      const half = ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale
      dict = `<< /ShadingType 2 /ColorSpace ${csRef} 0 R /Coords [${f(cx - dx * half)} ${f(cy - dy * half)} ${f(cx + dx * half)} ${f(cy + dy * half)}] /Function ${fn} /Extend [true true] >>`
    }
    const name = `Sh${res.Shading.size}`
    res.Shading.set(name, objs.add(dict))
    return name
  }

  /** A path's fills and strokes, in order, in its own coordinates (the caller's `cm` places it). */
  const paintPath = (path: PathData, items: AppearanceItem[]): string => {
    let o = ''
    const box = boxOf(path)
    const even = path.fillRule === 'evenodd'
    for (const it of items) {
      if (!it.enabled) continue
      const g = it.opacity < 1 ? `/${gs(it.opacity, it.opacity, 'normal')} gs\n` : ''
      const linked = it.paint.kind === 'solid' && it.paint.swatch ? swatches.get(it.paint.swatch) : undefined
      if (it.kind === 'fill') {
        if (it.paint.kind === 'gradient') {
          o += `q\n${g}${pathOps(path)}W${even ? '*' : ''} n\n/${shading(it.paint, box)} sh\nQ\n`
        } else {
          const colour = mainColour(it.paint)
          const set = linked?.kind === 'spot' ? `/${spotSpace(linked)} cs ${f(it.paint.kind === 'solid' ? (it.paint.tint ?? 1) : 1)} scn` : colourOp(colour, false)
          o += `q\n${g}${set}\n${pathOps(path)}f${even ? '*' : ''}\nQ\n`
        }
      } else {
        // An inside stroke is one twice as wide clipped to the shape; an outside one, clipped to all but it
        // (a box round it with the shape cut out, even-odd).
        const pb = box ?? [0, 0, 0, 0]
        const pad = it.width * Math.max(4, it.miter) + 2
        const cut =
          it.align === 'inside'
            ? `${pathOps(path)}W${even ? '*' : ''} n\n`
            : it.align === 'outside'
              ? `${f(pb[0] - pad)} ${f(pb[1] - pad)} ${f(pb[2] - pb[0] + 2 * pad)} ${f(pb[3] - pb[1] + 2 * pad)} re\n${pathOps(path)}W* n\n`
              : ''
        if (it.brush) {
          // A brush stroke: its artwork's parts, each filled in its paint (gradients as shadings), under the stroke's opacity.
          for (const p of brushAsPaths(path, it, doc.mode)) {
            const ev = p.path.fillRule === 'evenodd' ? '*' : ''
            if (p.paint.kind === 'gradient') o += `q\n${g}${pathOps(p.path)}W${ev} n\n/${shading(p.paint, box)} sh\nQ\n`
            else o += `q\n${g}${colourOp(mainColour(p.paint), false)}\n${pathOps(p.path)}f${ev}\nQ\n`
          }
          continue
        }
        if (strokeNeedsOutline(it)) {
          // A profile, arrowheads or dashes fitted to corners: the outline the stroke paints, filled.
          const outline = strokeAsPath(path, it)
          if (it.paint.kind === 'gradient') o += `q\n${g}${cut}${pathOps(outline)}W n\n/${shading(it.paint, box)} sh\nQ\n`
          else {
            const colour = mainColour(it.paint)
            const set = linked?.kind === 'spot' ? `/${spotSpace(linked)} cs ${f(it.paint.kind === 'solid' ? (it.paint.tint ?? 1) : 1)} scn` : colourOp(colour, false)
            o += `q\n${g}${cut}${set}\n${pathOps(outline)}f\nQ\n`
          }
          continue
        }
        const st = `${f(it.align === 'centre' ? it.width : it.width * 2)} w ${it.cap === 'round' ? 1 : it.cap === 'square' ? 2 : 0} J ${it.join === 'round' ? 1 : it.join === 'bevel' ? 2 : 0} j ${f(it.miter)} M [${it.dash.map(f).join(' ')}] ${f(it.dashOffset)} d\n`
        if (it.paint.kind === 'gradient') {
          warn('Gradient strokes are drawn in their first colour in the PDF')
          o += `q\n${g}${cut}${st}${colourOp(it.paint.stops[0].colour, true)}\n${pathOps(path)}S\nQ\n`
        } else {
          const colour = mainColour(it.paint)
          const set = linked?.kind === 'spot' ? `/${spotSpace(linked)} CS ${f(it.paint.kind === 'solid' ? (it.paint.tint ?? 1) : 1)} SCN` : colourOp(colour, true)
          o += `q\n${g}${cut}${st}${set}\n${pathOps(path)}S\nQ\n`
        }
      }
    }
    return o
  }

  // --- images ----------------------------------------------------------------------------------------
  const imageOps = async (img: NodeImage | null): Promise<string> => {
    if (!img) return ''
    const ch = img.channels
    const nc = ch - 1
    const colour = new Uint8Array(img.w * img.h * nc)
    const alpha = new Uint8Array(img.w * img.h)
    let opaque = true
    for (let i = 0; i < img.w * img.h; i++) {
      for (let c = 0; c < nc; c++) colour[i * nc + c] = img.data[i * ch + c]
      alpha[i] = img.data[i * ch + nc]
      if (alpha[i] < 255) opaque = false
    }
    const smask = opaque ? 0 : objs.stream(`/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, await host.deflate(alpha))
    const ref = objs.stream(`/Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${csRef} 0 R /BitsPerComponent 8 /Filter /FlateDecode${smask ? ` /SMask ${smask} 0 R` : ''}`, await host.deflate(colour))
    const name = `Im${res.XObject.size}`
    res.XObject.set(name, ref)
    return `q\n${f(img.w)} 0 0 ${f(-img.h)} ${f(img.x)} ${f(img.y + img.h)} cm\n/${name} Do\nQ\n`
  }

  const clipOps = (node: DocNode): string => {
    const vm = node.masks.map((m) => doc.nodes[m]).find((m) => m?.kind === 'mask' && m.visible && m.props.source === 'vector' && m.props.geometry)
    if (!vm || vm.kind !== 'mask' || !vm.props.geometry) return ''
    // The clip's own transform on its points, so it doesn't carry over to what's drawn inside it.
    return `${pathOps(transformPath(geometryPath(vm.props.geometry), vm.transform))}W n\n`
  }

  // --- the tree --------------------------------------------------------------------------------------
  /** A group's contents as a transparency group (a form), for its opacity and blend to apply to them together. */
  const formOf = async (body: string, isolated: boolean): Promise<string> => {
    const ref = objs.stream(`/Type /XObject /Subtype /Form /BBox [0 0 ${doc.width} ${doc.height}] /Group << /S /Transparency /CS ${csRef} 0 R${isolated ? ' /I true' : ''} >> /Resources ${resRef} 0 R`, await host.deflate(new TextEncoder().encode(body)))
    const name = `Fm${res.XObject.size}`
    res.XObject.set(name, ref)
    return name
  }

  const nodeOps = async (id: NodeId): Promise<string> => {
    const node = doc.nodes[id]
    if (!node || !node.visible || node.kind === 'mask' || node.kind === 'filter' || node.kind === 'adjustment') return ''
    const k = node.opacity * (node.kind === 'group' ? 1 : node.fillOpacity)
    const blend = node.blend === 'pass-through' ? 'normal' : node.blend
    const g = k < 1 || blend !== 'normal' ? `/${gs(k, k, blend)} gs\n` : ''
    const clip = clipOps(node)
    if (node.kind === 'group' && groupAsGroup(doc, node)) {
      let body = ''
      for (const c of node.children ?? []) body += await nodeOps(c)
      if (!body) return ''
      // A pass-through group in Normal at full opacity needs no group of its own.
      if (node.blend === 'pass-through' && k >= 1) return `q\n${clip}${body}Q\n`
      return `q\n${clip}${g}/${await formOf(body, node.blend !== 'pass-through')} Do\nQ\n`
    }
    const clipped = node.kind !== 'group' && (node.children ?? []).some((c) => doc.nodes[c]?.visible)
    if (node.kind !== 'group' && !clipped && asVector(doc, node)) {
      let body = ''
      if (node.kind === 'text') {
        const l = host.layout(node)
        if (!l) {
          warn('Text whose fonts hadn’t loaded was left out')
          return ''
        }
        warn('Text is in the PDF as outlines: exact, though not selectable')
        body = `${node.transform.map(f).join(' ')} cm\n${characterGroups(l.glyphs, node.props.appearance)
          .map((g) => paintPath(glyphsToPath(g.glyphs), g.appearance))
          .join('')}`
      } else if (node.kind === 'boolean') {
        const p = docPathOf((x) => doc.nodes[x], node)
        if (p) body = paintPath(p, node.props.appearance)
      } else if (node.kind === 'vector' && node.props.geometry) body = `${node.transform.map(f).join(' ')} cm\n${paintPath(geometryPath(node.props.geometry), node.props.appearance)}`
      if (!body) return ''
      // Opacity and a blend mode over several fills and strokes apply to them together.
      const items = node.kind === 'vector' || node.kind === 'boolean' || node.kind === 'text' ? node.props.appearance.filter((a) => a.enabled).length : 1
      if (g && items > 1) return `q\n${clip}${g}/${await formOf(`q\n${body}Q\n`, true)} Do\nQ\n`
      return `q\n${clip}${g}${body}Q\n`
    }
    const img = await imageOps(await host.image(id))
    return img ? `q\n${g}${img}Q\n` : ''
  }

  let content = `q\n${f(72 / doc.resolution)} 0 0 ${f(-72 / doc.resolution)} 0 ${f((doc.height * 72) / doc.resolution)} cm\n`
  const kids = doc.nodes[doc.root].children ?? []
  const flat = flattenCount(doc)
  if (flat) {
    warn(flat === kids.length ? 'The document has adjustment layers or blend modes PDF hasn’t, so the PDF is one image' : 'Layers under an adjustment layer or a blend mode PDF hasn’t are flattened into one image')
    content += await imageOps(await host.flattened(flat))
  }
  for (const c of kids.slice(flat)) content += await nodeOps(c)
  // Spot channels over everything, overprinting: each ink on its own plate, the others left as they are.
  const spotPlanes = (await host.spotChannels?.()) ?? []
  if (spotPlanes.length) res.ExtGState.set('GOP', '<< /Type /ExtGState /OP true /op true /OPM 1 >> %overprint')
  for (const sp of spotPlanes) {
    const cs = res.ColorSpace.get(separation(sp.name, sp.full))
    const ref = objs.stream(`/Type /XObject /Subtype /Image /Width ${sp.width} /Height ${sp.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /FlateDecode`, await host.deflate(sp.data))
    const name = `Im${res.XObject.size}`
    res.XObject.set(name, ref)
    content += `q\n/GOP gs\n${f(sp.width)} 0 0 ${f(-sp.height)} 0 ${f(sp.height)} cm\n/${name} Do\nQ\n`
  }
  content += 'Q\n'

  const resources = () =>
    `<< /ColorSpace << ${[...res.ColorSpace].map(([k, v]) => `/${k} ${v}`).join(' ')} >> /ExtGState << ${[...res.ExtGState].map(([k, v]) => `/${k} ${v.replace(/ %.*$/, '')}`).join(' ')} >> /XObject << ${[...res.XObject].map(([k, v]) => `/${k} ${v} 0 R`).join(' ')} >> /Shading << ${[...res.Shading].map(([k, v]) => `/${k} ${v} 0 R`).join(' ')} >> >>`
  const contentRef = objs.stream('/Filter /FlateDecode', await host.deflate(new TextEncoder().encode(content)))
  const w = (doc.width * 72) / doc.resolution
  const h = (doc.height * 72) / doc.resolution
  const pagesRef = objs.reserve()
  const pageRef = objs.add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${f(w)} ${f(h)}] /TrimBox [0 0 ${f(w)} ${f(h)}] /BleedBox [0 0 ${f(w)} ${f(h)}] /Resources ${resRef} 0 R /Contents ${contentRef} 0 R /Group << /S /Transparency /CS ${csRef} 0 R >> >>`)
  objs.set(pagesRef, `<< /Type /Pages /Kids [${pageRef} 0 R] /Count 1 >>`)
  objs.set(resRef, resources())
  const date = host.now
  const pdfDate = `D:${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`
  const iso = date.toISOString()
  const cmyk = doc.mode === 'cmyk' && iccRef
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${doc.name.replace(/[<&]/g, '')}</rdf:li></rdf:Alt></dc:title><xmp:CreateDate>${iso}</xmp:CreateDate><xmp:ModifyDate>${iso}</xmp:ModifyDate><xmp:CreatorTool>Plexel</xmp:CreatorTool><pdf:Producer>Plexel</pdf:Producer><pdf:Trapped>False</pdf:Trapped>${cmyk ? '<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>' : ''}<xmpMM:DocumentID>uuid:plexel-${date.getTime().toString(16)}</xmpMM:DocumentID><xmpMM:InstanceID>uuid:plexel-${date.getTime().toString(16)}-1</xmpMM:InstanceID></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  const metaRef = objs.stream('/Type /Metadata /Subtype /XML', new TextEncoder().encode(xmp))
  const intent = cmyk ? ` /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier ${pdfString(host.profileName)} /Info ${pdfString(host.profileName)} /DestOutputProfile ${iccRef} 0 R >>]` : ''
  const catalog = objs.add(`<< /Type /Catalog /Pages ${pagesRef} 0 R /Metadata ${metaRef} 0 R${intent} >>`)
  const info = objs.add(`<< /Title ${pdfString(doc.name)} /Creator (Plexel) /Producer (Plexel) /CreationDate (${pdfDate}) /ModDate (${pdfDate}) /Trapped /False${cmyk ? ' /GTS_PDFXVersion (PDF/X-4)' : ''} >>`)
  const id = Array.from({ length: 16 }, (_, i) => ((date.getTime() >> (i % 8)) ^ (i * 37 + doc.width + doc.height)) & 255).map((b) => b.toString(16).padStart(2, '0')).join('')
  const bytes = objs.finish(`/Root ${catalog} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>]`)
  return { bytes, warnings: [...warnings] }
}
