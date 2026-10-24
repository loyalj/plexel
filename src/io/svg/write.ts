/**
 * A document as SVG: vectors where SVG can say the same thing, images
 * where it can't (io/flat.ts decides which). Colours are sRGB, which is
 * all SVG has; the page converts them.
 *
 *   shapes        one <path> in the shape's own coordinates (its transform
 *                 on it), used by each fill and stroke in order; linear and
 *                 radial gradients in user space, as Plexel lays them out
 *   compounds     their combined outline, in document coordinates
 *   text          <text> line by line, from Plexel's own layout, in runs
 *                 with their font, size and tracking; or outlines
 *   vector masks  clip paths
 *   clipping      a layer and those clipped to it, as one image
 *   groups        <g> with opacity, blend mode and isolation
 *   the rest      embedded PNGs, each layer's opacity and blend mode kept
 */
import type { NodeImage } from '../../engine/nodeImage'
import { brushAsPaths, characterGroups, strokeAsPath } from '../../vector/outline'
import { strokeNeedsOutline } from '../../doc/vector'
import { flattenCount, asVector, groupAsGroup } from '../flat'
import { geometryPath, mainColour, type AppearanceItem, type Paint } from '../../doc/vector'
import { glyphsToPath } from '../../geom/glyphs'
import type { PathData } from '../../geom/path'
import { n4, pathD } from './pathData'

export { pathD }
import { docPathOf } from '../../vector/shape'
import type { ParamColour } from '../../doc/params'
import { resolveChar, textLength } from '../../doc/text'
import type { Doc, DocNode, NodeId } from '../../doc/types'
import type { TextLayout } from '../../text/layout'

export interface SvgHost {
  /** A colour in the document's terms as sRGB hex. */
  colour(c: ParamColour): string
  /** A node rendered as it composites (masks, effects, layers clipped to it) but at full strength in Normal, alone, as an sRGB PNG. */
  image(node: NodeId): Promise<NodeImage | null>
  /** The root's first `count` children flattened, as an sRGB PNG. */
  flattened(count: number): Promise<NodeImage | null>
  layout(node: DocNode): TextLayout | null
  textAsOutlines: boolean
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const matrix = (t: number[]) => (t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0 ? '' : ` transform="matrix(${t.map(n4).join(' ')})"`)


function base64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

const BLEND_CSS: Record<string, string> = { 'color-dodge': 'color-dodge', 'color-burn': 'color-burn', 'hard-light': 'hard-light', 'soft-light': 'soft-light' }

export async function docToSvg(doc: Doc, host: SvgHost): Promise<{ svg: string; warnings: string[] }> {
  const warnings = new Set<string>()
  const defs: string[] = []
  let ids = 0
  const uid = (p: string) => `${p}${ids++}`

  const groupAttrs = (n: DocNode, k = n.opacity * (n.kind === 'group' ? 1 : n.fillOpacity)) => {
    const parts: string[] = []
    if (k < 1) parts.push(` opacity="${n4(k)}"`)
    const style: string[] = []
    if (n.blend !== 'normal' && n.blend !== 'pass-through') style.push(`mix-blend-mode:${BLEND_CSS[n.blend] ?? n.blend}`)
    if (n.kind === 'group' && n.blend !== 'pass-through') style.push('isolation:isolate')
    if (style.length) parts.push(` style="${style.join(';')}"`)
    return parts.join('')
  }

  const imageEl = (img: NodeImage) => `<image x="${img.x}" y="${img.y}" width="${img.w}" height="${img.h}" href="data:image/png;base64,${base64(img.png!)}"/>`

  const paintRef = (p: Paint, n: DocNode, box: [number, number, number, number] | null): string => {
    if (p.kind === 'solid') return host.colour(p.colour)
    if (p.kind !== 'gradient') return host.colour(mainColour(p))
    const id = uid('g')
    const b = box ?? [0, 0, 1, 1]
    const cx = (b[0] + b[2]) / 2
    const cy = (b[1] + b[3]) / 2
    const w = Math.max(1e-6, b[2] - b[0])
    const h = Math.max(1e-6, b[3] - b[1])
    const stops = (p.reverse ? [...p.stops].reverse().map((s) => ({ ...s, at: 1 - s.at })) : p.stops).map((s) => `<stop offset="${n4(s.at)}" stop-color="${host.colour(s.colour)}"${s.alpha < 1 ? ` stop-opacity="${n4(s.alpha)}"` : ''}/>`).join('')
    const scale = p.scale / 100
    if (p.type === 'radial') {
      const r = (Math.max(w, h) / 2) * scale
      defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n4(cx)}" cy="${n4(cy)}" r="${n4(r)}">${stops}</radialGradient>`)
    } else {
      const a = (p.angle * Math.PI) / 180
      const dx = Math.cos(a)
      const dy = -Math.sin(a)
      const half = ((Math.abs(w * dx) + Math.abs(h * dy)) / 2) * scale
      defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n4(cx - dx * half)}" y1="${n4(cy - dy * half)}" x2="${n4(cx + dx * half)}" y2="${n4(cy + dy * half)}">${stops}</linearGradient>`)
    }
    void n
    return `url(#${id})`
  }

  /** A path's fills and strokes, in order, using one definition of it. */
  const paintPath = (n: DocNode, path: PathData, items: AppearanceItem[], transform: number[], box: [number, number, number, number] | null): string => {
    const pid = uid('p')
    defs.push(`<path id="${pid}" d="${pathD(path)}"${path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`)
    const out: string[] = []
    for (const it of items) {
      if (!it.enabled) continue
      const paint = paintRef(it.paint, n, box)
      if (it.kind === 'fill') {
        out.push(`<use href="#${pid}" fill="${paint}"${it.opacity < 1 ? ` fill-opacity="${n4(it.opacity)}"` : ''}${path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`)
        continue
      }
      if (it.brush) {
        // A brush stroke: its artwork's parts, each filled in its paint, the stroke's opacity on them together.
        const parts = brushAsPaths(path, it, doc.mode).map((p) => `<path d="${pathD(p.path)}" fill="${paintRef(p.paint, n, box)}"${p.path.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`)
        out.push(`<g${it.opacity < 1 ? ` opacity="${n4(it.opacity)}"` : ''}>${parts.join('')}</g>`)
        continue
      }
      // An inside stroke is one twice as wide clipped to the shape; an outside one, masked to all but the shape.
      const rule = path.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
      let cut = ''
      if (it.align === 'inside') {
        const cid = uid('c')
        defs.push(`<clipPath id="${cid}"><use href="#${pid}" clip-rule="${rule}"/></clipPath>`)
        cut = ` clip-path="url(#${cid})"`
      } else if (it.align === 'outside') {
        const pb = boxOf(path) ?? [0, 0, 0, 0]
        const pad = it.width * Math.max(4, it.miter) + 2
        const mid = uid('m')
        defs.push(
          `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${n4(pb[0] - pad)}" y="${n4(pb[1] - pad)}" width="${n4(pb[2] - pb[0] + 2 * pad)}" height="${n4(pb[3] - pb[1] + 2 * pad)}"><rect x="${n4(pb[0] - pad)}" y="${n4(pb[1] - pad)}" width="${n4(pb[2] - pb[0] + 2 * pad)}" height="${n4(pb[3] - pb[1] + 2 * pad)}" fill="#fff"/><use href="#${pid}" fill="#000" fill-rule="${rule}"/></mask>`,
        )
        cut = ` mask="url(#${mid})"`
      }
      const width = it.align === 'centre' ? it.width : it.width * 2
      if (strokeNeedsOutline(it)) {
        // A profile, arrowheads or dashes fitted to corners: the outline the stroke paints, filled.
        out.push(`<path d="${pathD(strokeAsPath(path, it))}" fill="${paint}"${it.opacity < 1 ? ` fill-opacity="${n4(it.opacity)}"` : ''}${cut}/>`)
        continue
      }
      out.push(
        `<use href="#${pid}" fill="none" stroke="${paint}" stroke-width="${n4(width)}" stroke-linecap="${it.cap}" stroke-linejoin="${it.join}" stroke-miterlimit="${n4(it.miter)}"${it.dash.length ? ` stroke-dasharray="${it.dash.map(n4).join(' ')}" stroke-dashoffset="${n4(it.dashOffset)}"` : ''}${it.opacity < 1 ? ` stroke-opacity="${n4(it.opacity)}"` : ''}${cut}/>`,
      )
    }
    return `<g${matrix(transform)}>${out.join('')}</g>`
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

  const clipFor = (n: DocNode): string => {
    const vm = n.masks.map((m) => doc.nodes[m]).find((m) => m?.kind === 'mask' && m.visible && m.props.source === 'vector' && m.props.geometry)
    if (!vm || vm.kind !== 'mask' || !vm.props.geometry) return ''
    const id = uid('c')
    defs.push(`<clipPath id="${id}"><path d="${pathD(geometryPath(vm.props.geometry))}"${matrix(vm.transform)}/></clipPath>`)
    return ` clip-path="url(#${id})"`
  }

  const textEl = (n: DocNode & { kind: 'text' }): string => {
    const l = host.layout(n)
    if (!l) {
      warnings.add('Text whose fonts hadn’t loaded was left out')
      return ''
    }
    if (host.textAsOutlines) {
      const groups = characterGroups(l.glyphs, n.props.appearance)
      return groups.length === 1 ? paintPath(n, glyphsToPath(groups[0].glyphs), groups[0].appearance, n.transform, null) : `<g>${groups.map((g) => paintPath(n, glyphsToPath(g.glyphs), g.appearance, n.transform, null)).join('')}</g>`
    }
    const fill = n.props.appearance.find((a) => a.enabled && a.kind === 'fill')
    const colour = fill?.paint.kind === 'solid' ? host.colour(fill.paint.colour) : fill ? host.colour([0, 0, 0]) : 'none'
    if (n.props.appearance.some((a) => a.enabled && a.kind === 'stroke')) warnings.add('Strokes on text are kept only in outlines; choose Text as outlines to keep them')
    // Positions over the whole text, each paragraph break one.
    const content = n.props.content
    const spans: { start: number; end: number; style: string }[] = []
    let pos = 0
    for (const p of content.paragraphs) {
      for (const r of p.runs) {
        const c = resolveChar(r, p, doc.textStyles)
        const weight = /black|heavy/i.test(c.style) ? 900 : /extra ?bold/i.test(c.style) ? 800 : /semi ?bold|demi/i.test(c.style) ? 600 : /bold/i.test(c.style) ? 700 : /medium/i.test(c.style) ? 500 : /light/i.test(c.style) ? 300 : /thin/i.test(c.style) ? 100 : 400
        // Colour per character: a run's own fill (its first colour, where it isn't one) over the text's.
        if (c.stroke) warnings.add('Strokes on text are kept only in outlines; choose Text as outlines to keep them')
        const style = [c.fill ? `fill:${host.colour(mainColour(c.fill))}` : '', `font-family:'${c.font.replace(/'/g, '')}'`, `font-size:${n4(c.size)}px`, weight !== 400 ? `font-weight:${weight}` : '', /italic|oblique/i.test(c.style) ? 'font-style:italic' : '', c.tracking ? `letter-spacing:${n4((c.tracking / 1000) * c.size)}px` : '', c.underline || c.strikethrough ? `text-decoration:${[c.underline ? 'underline' : '', c.strikethrough ? 'line-through' : ''].join(' ').trim()}` : ''].filter(Boolean).join(';')
        spans.push({ start: pos, end: pos + r.text.length, style })
        pos += r.text.length
      }
      pos += 1
    }
    const flat = content.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
    void textLength
    const lines = l.lines.map((line) => {
      const parts = spans
        .filter((s) => s.end > line.start && s.start < line.end)
        .map((s) => `<tspan style="${s.style}">${esc(flat.slice(Math.max(s.start, line.start), Math.min(s.end, line.end)).replace(/\u2028/g, ''))}</tspan>`)
        .join('')
      return `<text x="${n4(line.x0)}" y="${n4(line.baseline)}" fill="${colour}" xml:space="preserve">${parts}</text>`
    })
    if (l.lines.some((x) => x.rtl)) warnings.add('Right-to-left text is written as it reads; check it in the app you open the SVG in')
    return `<g${matrix(n.transform)}>${lines.join('')}</g>`
  }

  const nodeEl = async (id: NodeId): Promise<string> => {
    const n = doc.nodes[id]
    if (!n || !n.visible || n.kind === 'mask' || n.kind === 'filter' || n.kind === 'adjustment') return ''
    let inner = ''
    if (n.kind === 'group' && groupAsGroup(doc, n)) {
      const kids: string[] = []
      for (const c of n.children ?? []) kids.push(await nodeEl(c))
      return `<g${groupAttrs(n)}${clipFor(n)}>${kids.join('')}</g>`
    }
    // A layer with layers clipped to it goes in as one image of them all.
    const clipped = n.kind !== 'group' && (n.children ?? []).some((c) => doc.nodes[c]?.visible)
    if (n.kind !== 'group' && !clipped && asVector(doc, n)) {
      if (n.kind === 'text') inner = textEl(n)
      else if (n.kind === 'boolean') {
        const p = docPathOf((x) => doc.nodes[x], n)
        inner = p ? paintPath(n, p, n.props.appearance, [1, 0, 0, 1, 0, 0], boxOf(p)) : ''
      } else if (n.kind === 'vector' && n.props.geometry) {
        const p = geometryPath(n.props.geometry)
        inner = paintPath(n, p, n.props.appearance, n.transform, boxOf(p))
      }
      inner = clipFor(n) ? `<g${clipFor(n)}>${inner}</g>` : inner
    } else {
      const img = await host.image(n.id)
      if (img?.png) inner = imageEl(img)
      if (n.kind === 'group') {
        // A group drawn as one image already holds its layers.
        return inner ? `<g${groupAttrs(n, n.opacity)}>${inner}</g>` : ''
      }
    }
    return inner ? `<g${groupAttrs(n)}>${inner}</g>` : ''
  }

  const body: string[] = []
  const kids = doc.nodes[doc.root].children ?? []
  const flat = flattenCount(doc)
  if (flat) {
    warnings.add(flat === kids.length ? 'The document has adjustment layers or blend modes SVG hasn’t, so it’s one image' : 'Layers under an adjustment layer or a blend mode SVG hasn’t are flattened into one image')
    const img = await host.flattened(flat)
    if (img?.png) body.push(imageEl(img))
  }
  for (const c of kids.slice(flat)) body.push(await nodeEl(c))
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">
<title>${esc(doc.name)}</title>
${defs.length ? `<defs>${defs.join('')}</defs>\n` : ''}${body.join('\n')}
</svg>
`
  return { svg, warnings: [...warnings] }
}
