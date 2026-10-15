/**
 * An SVG file as a Plexel document (RGB, sRGB, which is SVG's space):
 *
 *   groups, svg and symbol    groups, their opacity and blend mode
 *   rect, circle, ellipse,    live shapes where they're exact (a rect with
 *   line                      round corners, circles and ellipses, lines),
 *   path, polyline, polygon   paths otherwise; every path command, arcs as
 *                             curves
 *   fill, stroke              the appearance stack: colours, linear and
 *                             radial gradients (with their stops moved to
 *                             fit Plexel's layout across the shape's box),
 *                             widths, caps, joins, dashes
 *   text, tspan               point text, a paragraph per positioned line
 *   image                     embedded images (data: URLs), as pixel layers
 *   use                       what it refers to, moved
 *   clip-path                 vector masks
 *
 * Styles from presentation attributes, <style> rules (type, class and id
 * selectors) and style attributes, inherited as CSS has them. Filters,
 * masks and patterns aren't brought over and are said.
 */
import { makeNode } from '../../doc/nodes'
import type { CharProps, Paragraph } from '../../doc/text'
import type { Affine, BlendModeId, Doc, DocNode, NodeId } from '../../doc/types'
import type { AppearanceItem, Geometry, Paint, PaintStop } from '../../doc/vector'
import type { Anchor, PathData, Pt, Subpath } from '../../geom/path'
import { parseXml, type XmlElement } from './xml'
import { compose as mul } from '../../geom/affine'

export interface SvgImage {
  node: NodeId
  bytes: Uint8Array
  /** The image's own size is fitted to this box (in the node's coordinates). */
  width: number
  height: number
}

export interface SvgImport {
  doc: Doc
  images: SvgImage[]
  warnings: string[]
}

export interface SvgReadHost {
  newId(prefix: string): string
  /** A CSS colour name to RGB 0..1, or null (the page asks the browser). */
  namedColour(name: string): [number, number, number] | null
}

type M = [number, number, number, number, number, number]
const I: M = [1, 0, 0, 1, 0, 0]
const apply = (m: M, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]

export function parseTransform(s: string | undefined): M {
  let m: M = I
  if (!s) return m
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let x: RegExpExecArray | null
  while ((x = re.exec(s))) {
    const a = x[2].split(/[\s,]+/).filter(Boolean).map(Number)
    let t: M = I
    switch (x[1]) {
      case 'matrix':
        if (a.length === 6) t = a as M
        break
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
        break
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
        break
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180
        const c = Math.cos(r)
        const sn = Math.sin(r)
        const rot: M = [c, sn, -sn, c, 0, 0]
        t = a.length >= 3 ? mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]) : rot
        break
      }
      case 'skewX':
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]
        break
      case 'skewY':
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]
        break
    }
    m = mul(m, t)
  }
  return m
}

// --- path data ------------------------------------------------------------------------------------

/** SVG path data as Plexel's paths: every command, arcs as cubics. */
export function parsePathData(d: string): PathData {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  let i = 0
  const subpaths: Subpath[] = []
  let cur: Anchor[] | null = null
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let lastC: Pt | null = null
  let lastQ: Pt | null = null
  let cmd = ''
  const num = () => Number(toks[i++])
  const isNum = () => i < toks.length && !/[a-zA-Z]/.test(toks[i])
  const flag = () => {
    // Arc flags may run together ("10" is two flags).
    const t = toks[i]
    if (t.length > 1 && (t[0] === '0' || t[0] === '1') && !t.includes('.')) {
      toks[i] = t.slice(1)
      return t[0] === '1'
    }
    i++
    return Number(t) !== 0
  }
  const start = (px: number, py: number) => {
    cur = [{ p: [px, py], in: null, out: null, smooth: false }]
    subpaths.push({ closed: false, anchors: cur })
  }
  const lineTo = (px: number, py: number) => {
    if (!cur) start(x, y)
    cur!.push({ p: [px, py], in: null, out: null, smooth: false })
  }
  const curveTo = (c1: Pt, c2: Pt, p: Pt) => {
    if (!cur) start(x, y)
    cur![cur!.length - 1].out = c1
    cur!.push({ p, in: c2, out: null, smooth: false })
  }
  // Path data that doesn't open with a moveto is in error from the start, and draws nothing.
  if (toks.length && toks[0] !== 'M' && toks[0] !== 'm') return { fillRule: 'nonzero', subpaths: [] }
  while (i < toks.length) {
    if (!isNum()) cmd = toks[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (C) {
      case 'M': {
        x = ox + num()
        y = oy + num()
        start(x, y)
        sx = x
        sy = y
        cmd = rel ? 'l' : 'L'
        lastC = lastQ = null
        break
      }
      case 'L':
        x = ox + num()
        y = oy + num()
        lineTo(x, y)
        lastC = lastQ = null
        break
      case 'H':
        x = ox + num()
        lineTo(x, y)
        lastC = lastQ = null
        break
      case 'V':
        y = oy + num()
        lineTo(x, y)
        lastC = lastQ = null
        break
      case 'C': {
        const c1: Pt = [ox + num(), oy + num()]
        const c2: Pt = [ox + num(), oy + num()]
        x = ox + num()
        y = oy + num()
        curveTo(c1, c2, [x, y])
        lastC = c2
        lastQ = null
        break
      }
      case 'S': {
        const c1: Pt = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y]
        const c2: Pt = [ox + num(), oy + num()]
        x = ox + num()
        y = oy + num()
        curveTo(c1, c2, [x, y])
        lastC = c2
        lastQ = null
        break
      }
      case 'Q':
      case 'T': {
        const q: Pt = C === 'Q' ? [ox + num(), oy + num()] : lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y]
        const px = ox + num()
        const py = oy + num()
        curveTo([x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], [px + (2 / 3) * (q[0] - px), py + (2 / 3) * (q[1] - py)], [px, py])
        x = px
        y = py
        lastQ = q
        lastC = null
        break
      }
      case 'A': {
        const rx = Math.abs(num())
        const ry = Math.abs(num())
        const rot = num()
        const large = flag()
        const sweep = flag()
        const px = ox + num()
        const py = oy + num()
        for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, px, py)) curveTo([c[0], c[1]], [c[2], c[3]], [c[4], c[5]])
        x = px
        y = py
        lastC = lastQ = null
        break
      }
      case 'Z': {
        if (cur) {
          const s = subpaths[subpaths.length - 1]
          s.closed = true
          // A closing point on the start is the start.
          const a = s.anchors
          if (a.length > 1 && Math.hypot(a[a.length - 1].p[0] - a[0].p[0], a[a.length - 1].p[1] - a[0].p[1]) < 1e-9) {
            a[0].in = a[a.length - 1].in
            a.pop()
          }
        }
        x = sx
        y = sy
        cur = null
        lastC = lastQ = null
        break
      }
      default:
        i = toks.length
    }
  }
  return { fillRule: 'nonzero', subpaths: subpaths.filter((s) => s.anchors.length) }
}

/** An elliptical arc as cubics (SVG's endpoint parameterisation, F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]]
  const phi = (rotDeg * Math.PI) / 180
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cp * dx + sp * dy
  const y1p = -sp * dx + cp * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    rx *= Math.sqrt(lam)
    ry *= Math.sqrt(lam)
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) co = -co
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)))
  const step = dt / n
  const k = (4 / 3) * Math.tan(step / 4)
  const out: number[][] = []
  const pt = (t: number) => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp]
  const dv = (t: number) => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp, -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp]
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step
    const b = a + step
    const p0 = pt(a)
    const p1 = pt(b)
    const d0 = dv(a)
    const d1 = dv(b)
    out.push([p0[0] + k * d0[0], p0[1] + k * d0[1], p1[0] - k * d1[0], p1[1] - k * d1[1], p1[0], p1[1]])
  }
  return out
}

// --- styles ---------------------------------------------------------------------------------------

const INHERITED = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'font-family', 'font-size', 'font-weight', 'font-style', 'visibility', 'color', 'letter-spacing', 'text-anchor', 'clip-rule', 'text-decoration'])
const PROPS = new Set([...INHERITED, 'opacity', 'display', 'clip-path', 'mix-blend-mode', 'mask', 'filter', 'stop-color', 'stop-opacity'])

type Style = Record<string, string>

function parseStyleAttr(s: string | undefined): Style {
  const out: Style = {}
  for (const part of (s ?? '').split(';')) {
    const c = part.indexOf(':')
    if (c < 0) continue
    out[part.slice(0, c).trim().toLowerCase()] = part.slice(c + 1).trim().replace(/\s*!important$/, '')
  }
  return out
}

interface Rule {
  sel: { tag?: string; cls?: string; id?: string }
  style: Style
  spec: number
}

function parseCss(css: string): Rule[] {
  const rules: Rule[] = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean))) {
    const style = parseStyleAttr(m[2])
    for (const raw of m[1].split(',')) {
      const s = raw.trim()
      if (!s || /[\s>+~:[]/.test(s)) continue
      const sel: Rule['sel'] = {}
      const parts = s.match(/[.#]?[^.#]+/g) ?? []
      for (const p of parts) {
        if (p[0] === '.') sel.cls = p.slice(1)
        else if (p[0] === '#') sel.id = p.slice(1)
        else if (p !== '*') sel.tag = p
      }
      rules.push({ sel, style, spec: (sel.id ? 100 : 0) + (sel.cls ? 10 : 0) + (sel.tag ? 1 : 0) })
    }
  }
  return rules.sort((a, b) => a.spec - b.spec)
}

// --- the document ---------------------------------------------------------------------------------

export function svgToDoc(text: string, name: string, host: SvgReadHost): SvgImport {
  const warnings = new Set<string>()
  const warn = (w: string) => warnings.add(w)
  const root = parseXml(text)
  if (root.name !== 'svg' && !root.name.endsWith(':svg')) throw new Error('This isn’t an SVG file')
  const byId = new Map<string, XmlElement>()
  const rules: Rule[] = []
  const walk = (e: XmlElement) => {
    if (e.attrs.id) byId.set(e.attrs.id, e)
    if (e.name === 'style') rules.push(...parseCss(e.children.filter((c): c is string => typeof c === 'string').join('')))
    for (const c of e.children) if (typeof c !== 'string') walk(c)
  }
  walk(root)
  rules.sort((a, b) => a.spec - b.spec)
  const tag = (e: XmlElement) => e.name.replace(/^svg:/, '')
  const ownStyle = (e: XmlElement): Style => {
    const s: Style = {}
    for (const [k, v] of Object.entries(e.attrs)) if (PROPS.has(k)) s[k] = v
    const classes = (e.attrs.class ?? '').split(/\s+/).filter(Boolean)
    for (const r of rules) {
      if (r.sel.tag && r.sel.tag !== tag(e)) continue
      if (r.sel.cls && !classes.includes(r.sel.cls)) continue
      if (r.sel.id && r.sel.id !== e.attrs.id) continue
      Object.assign(s, r.style)
    }
    Object.assign(s, parseStyleAttr(e.attrs.style))
    return s
  }
  const inherit = (parent: Style, e: XmlElement): Style => {
    const own = ownStyle(e)
    const out: Style = {}
    for (const [k, v] of Object.entries(parent)) if (INHERITED.has(k)) out[k] = v
    for (const [k, v] of Object.entries(own)) if (v !== 'inherit') out[k] = v
    return out
  }

  // The canvas: width and height, the viewBox fitted into them.
  const vb = (root.attrs.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
  const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0
  const len = (v: string | undefined, ref: number, font = 16): number | null => {
    if (!v) return null
    const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/i.exec(v)
    if (!m) return null
    const n = Number(m[1])
    switch ((m[2] ?? 'px').toLowerCase()) {
      case 'pt':
        return (n * 4) / 3
      case 'pc':
        return n * 16
      case 'mm':
        return (n * 96) / 25.4
      case 'cm':
        return (n * 96) / 2.54
      case 'in':
        return n * 96
      case 'em':
        return n * font
      case 'ex':
        return n * font * 0.5
      case '%':
        return (n / 100) * ref
      default:
        return n
    }
  }
  const W = Math.max(1, Math.round(len(root.attrs.width, hasVb ? vb[2] : 300) ?? (hasVb ? vb[2] : 300)))
  const H = Math.max(1, Math.round(len(root.attrs.height, hasVb ? vb[3] : 150) ?? (hasVb ? vb[3] : 150)))
  let rootM: M = I
  if (hasVb) {
    const par = root.attrs.preserveAspectRatio ?? 'xMidYMid meet'
    const sx = W / vb[2]
    const sy = H / vb[3]
    if (par.startsWith('none')) rootM = [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy]
    else {
      const s = par.includes('slice') ? Math.max(sx, sy) : Math.min(sx, sy)
      const ax = par.includes('xMin') ? 0 : par.includes('xMax') ? 1 : 0.5
      const ay = par.includes('YMin') ? 0 : par.includes('YMax') ? 1 : 0.5
      rootM = [s, 0, 0, s, (W - vb[2] * s) * ax - vb[0] * s, (H - vb[3] * s) * ay - vb[1] * s]
    }
  }
  const vw = hasVb ? vb[2] : W
  const vh = hasVb ? vb[3] : H

  const nodes: Record<NodeId, DocNode> = {}
  const images: SvgImage[] = []

  // --- colours and paints ---
  const colourOf = (v: string | undefined, current: string | undefined): [number, number, number] | null => {
    if (!v) return null
    const s = v.trim().toLowerCase()
    if (s === 'none' || s === 'transparent') return null
    if (s === 'currentcolor') return colourOf(current ?? 'black', undefined)
    let m: RegExpExecArray | null
    if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
      const h = m[1]
      const full = h.length <= 4 ? h.split('').map((c) => c + c).join('') : h
      return [0, 2, 4].map((k) => parseInt(full.slice(k, k + 2), 16) / 255) as [number, number, number]
    }
    if ((m = /^rgba?\(([^)]*)\)$/.exec(s))) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean)
      return [0, 1, 2].map((k) => (p[k]?.endsWith('%') ? parseFloat(p[k]) / 100 : Number(p[k] ?? 0) / 255)) as [number, number, number]
    }
    if ((m = /^hsla?\(([^)]*)\)$/.exec(s))) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean)
      const h = (parseFloat(p[0]) / 360) % 1
      const sat = parseFloat(p[1]) / 100
      const l = parseFloat(p[2]) / 100
      const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat
      const pp = 2 * l - q
      const hue = (t: number) => {
        t = ((t % 1) + 1) % 1
        return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp
      }
      return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
    }
    const named = host.namedColour(s)
    if (!named) warn(`The colour “${v}” wasn’t understood and was read as black`)
    return named ?? [0, 0, 0]
  }

  /** A paint server (gradient) by reference, with the attributes and stops it inherits through href. */
  const gradientOf = (id: string): { el: XmlElement; attrs: Record<string, string>; stops: XmlElement[] } | null => {
    let el = byId.get(id)
    if (!el) return null
    const attrs: Record<string, string> = {}
    let stops: XmlElement[] = []
    const seen = new Set<string>()
    const first = el
    while (el && !seen.has(el.attrs.id ?? '')) {
      seen.add(el.attrs.id ?? '')
      for (const [k, v] of Object.entries(el.attrs)) if (!(k in attrs)) attrs[k] = v
      if (!stops.length) stops = el.children.filter((c): c is XmlElement => typeof c !== 'string' && tag(c) === 'stop')
      const href: string | undefined = el.attrs.href ?? el.attrs['xlink:href']
      el = href?.startsWith('#') ? byId.get(href.slice(1)) : undefined
    }
    return { el: first, attrs, stops }
  }

  const paintOf = (v: string | undefined, style: Style, box: [number, number, number, number] | null): { paint: Paint; opacity: number } | null => {
    if (!v || v === 'none') return null
    const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(v)
    if (url) {
      const g = gradientOf(url[1])
      if (!g || (tag(g.el) !== 'linearGradient' && tag(g.el) !== 'radialGradient')) {
        warn(g && tag(g.el) === 'pattern' ? 'Pattern fills came in as grey' : 'A fill referred to something that isn’t there')
        return { paint: { kind: 'solid', colour: [0.5, 0.5, 0.5] }, opacity: 1 }
      }
      const svgStops: PaintStop[] = g.stops.map((s) => {
        const st = { ...ownStyle(s) }
        const off = s.attrs.offset ?? '0'
        return { at: Math.min(1, Math.max(0, off.endsWith('%') ? parseFloat(off) / 100 : Number(off))), colour: colourOf(st['stop-color'] ?? 'black', style.color) ?? [0, 0, 0], alpha: Number(st['stop-opacity'] ?? 1) }
      })
      if (svgStops.length === 0) return null
      if (svgStops.length === 1) svgStops.push({ ...svgStops[0], at: 1 })
      const b = box ?? [0, 0, 1, 1]
      const bw = Math.max(1e-6, b[2] - b[0])
      const bh = Math.max(1e-6, b[3] - b[1])
      const bbox = (g.attrs.gradientUnits ?? 'objectBoundingBox') === 'objectBoundingBox'
      const gt = parseTransform(g.attrs.gradientTransform)
      // In the box's units a value is a fraction of the box; in user space a percentage is of the viewport.
      const at = (x: string | undefined, d: string, size: number, origin: number, view: number): number => {
        const s = x ?? d
        const v = s.endsWith('%') ? parseFloat(s) / 100 : Number(s)
        return bbox ? origin + v * size : s.endsWith('%') ? v * view : v
      }
      const toNode = (p: Pt): Pt => (bbox ? apply([bw, 0, 0, bh, b[0], b[1]], apply(gt, [(p[0] - b[0]) / bw, (p[1] - b[1]) / bh])) : apply(gt, p))
      const cx = (b[0] + b[2]) / 2
      const cy = (b[1] + b[3]) / 2
      if (tag(g.el) === 'radialGradient') {
        const c = toNode([at(g.attrs.cx, '50%', bw, b[0], vw), at(g.attrs.cy, '50%', bh, b[1], vh)])
        const rr = Math.abs(at(g.attrs.r, '50%', Math.hypot(bw, bh) / Math.SQRT2, 0, Math.hypot(vw, vh) / Math.SQRT2) * (bbox ? 1 : 1))
        if (Math.hypot(c[0] - cx, c[1] - cy) > 1) warn('A radial gradient off its shape’s centre came in centred')
        const r = bbox ? rr * Math.max(bw, bh) / Math.max(1e-6, Math.hypot(bw, bh) / Math.SQRT2) : rr
        return { paint: { kind: 'gradient', type: 'radial', stops: svgStops, angle: 0, scale: (r / (Math.max(bw, bh) / 2)) * 100, reverse: false }, opacity: 1 }
      }
      const p1 = toNode([at(g.attrs.x1, '0%', bw, b[0], vw), at(g.attrs.y1, '0%', bh, b[1], vh)])
      const p2 = toNode([at(g.attrs.x2, '100%', bw, b[0], vw), at(g.attrs.y2, '0%', bh, b[1], vh)])
      const L = Math.max(1e-6, Math.hypot(p2[0] - p1[0], p2[1] - p1[1]))
      const dx = (p2[0] - p1[0]) / L
      const dy = (p2[1] - p1[1]) / L
      const angle = (Math.atan2(-dy, dx) * 180) / Math.PI
      // Plexel's gradient is centred on the box; SVG's start anywhere. Its stops are moved to match.
      const s1 = (p1[0] - cx) * dx + (p1[1] - cy) * dy
      const shift = (s1 + L / 2) / L
      const stops = resampleStops(svgStops, shift)
      const half = (Math.abs(bw * dx) + Math.abs(bh * dy)) / 2
      return { paint: { kind: 'gradient', type: 'linear', stops, angle, scale: (L / Math.max(1e-6, 2 * half)) * 100, reverse: false }, opacity: 1 }
    }
    const c = colourOf(v, style.color)
    return c ? { paint: { kind: 'solid', colour: c }, opacity: 1 } : null
  }

  const appearanceOf = (style: Style, box: [number, number, number, number] | null, scale: number): AppearanceItem[] => {
    const out: AppearanceItem[] = []
    const fill = paintOf(style.fill ?? 'black', style, box)
    if (fill) out.push({ kind: 'fill', enabled: true, paint: fill.paint, opacity: Number(style['fill-opacity'] ?? 1), blend: 'normal' })
    const stroke = paintOf(style.stroke, style, box)
    if (stroke) {
      const w = len(style['stroke-width'], Math.hypot(vw, vh) / Math.SQRT2) ?? 1
      const dash = (style['stroke-dasharray'] ?? 'none') === 'none' ? [] : style['stroke-dasharray'].split(/[\s,]+/).map((x) => len(x, 100) ?? 0)
      out.push({
        kind: 'stroke',
        enabled: true,
        paint: stroke.paint,
        opacity: Number(style['stroke-opacity'] ?? 1),
        blend: 'normal',
        width: w,
        join: style['stroke-linejoin'] === 'round' ? 'round' : style['stroke-linejoin'] === 'bevel' ? 'bevel' : 'miter',
        cap: style['stroke-linecap'] === 'round' ? 'round' : style['stroke-linecap'] === 'square' ? 'square' : 'butt',
        miter: Number(style['stroke-miterlimit'] ?? 4),
        dash: dash.length % 2 ? [...dash, ...dash] : dash,
        dashOffset: len(style['stroke-dashoffset'], 100) ?? 0,
        align: 'centre',
      } as AppearanceItem)
    }
    void scale
    return out
  }

  const boxOfPath = (p: PathData): [number, number, number, number] | null => {
    let b: [number, number, number, number] | null = null
    for (const s of p.subpaths)
      for (const a of s.anchors) {
        const q = a.p
        b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])] : [q[0], q[1], q[0], q[1]]
      }
    return b
  }

  const BLENDS = new Set(['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'])
  const common = (n: DocNode, style: Style, m: M, box: [number, number, number, number] | null = null) => {
    n.transform = m as Affine
    if (style.opacity !== undefined) n.opacity = Math.min(1, Math.max(0, Number(style.opacity)))
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') n.visible = false
    const blend = style['mix-blend-mode']
    if (blend && BLENDS.has(blend)) n.blend = blend as BlendModeId
    if (style.filter && style.filter !== 'none') warn('SVG filters were left out')
    if (style.mask && style.mask !== 'none') warn('SVG masks were left out; clip paths come in as vector masks')
    const clip = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(style['clip-path'] ?? '')
    if (clip) {
      const cp = byId.get(clip[1])
      if (cp) {
        // The clip path's shapes, in the clipped element's user space, joined.
        const subpaths: Subpath[] = []
        const collect = (e: XmlElement, cm: M) => {
          const em = mul(cm, parseTransform(e.attrs.transform))
          const p = shapePath(e)
          if (p) for (const s of p.subpaths) subpaths.push({ closed: s.closed, anchors: s.anchors.map((a) => ({ p: apply(em, a.p), in: a.in ? apply(em, a.in) : null, out: a.out ? apply(em, a.out) : null, smooth: a.smooth })) })
          for (const c of e.children) if (typeof c !== 'string') collect(c, em)
        }
        // In the box's units the clip path is drawn in a unit square stretched over the element's box.
        const units = cp.attrs.clipPathUnits === 'objectBoundingBox'
        if (units && !box) warn('A clip path sized to its element’s box came in on something without one, and was left out')
        else collect(cp, units ? mul([box![2] - box![0], 0, 0, box![3] - box![1], box![0], box![1]], parseTransform(cp.attrs.transform)) : parseTransform(cp.attrs.transform))
        if (subpaths.length) {
          const mid = host.newId('m')
          const mask = makeNode('mask', mid, 'Vector Mask', { source: 'vector', tiles: null, geometry: { kind: 'path', path: { fillRule: 'nonzero', subpaths } }, density: 1, feather: 0, invert: false, outside: 0 })
          mask.transform = m as Affine
          nodes[mid] = mask
          n.masks = [mid]
        }
      }
    }
  }

  /** An element's outline as a path in its own coordinates, for shapes and clip paths. */
  function shapePath(e: XmlElement): PathData | null {
    const a = e.attrs
    const n = (k: string, ref = vw) => len(a[k], ref) ?? 0
    switch (tag(e)) {
      case 'path':
        return parsePathData(a.d ?? '')
      case 'rect': {
        const x = n('x')
        const y = n('y', vh)
        const w = n('width')
        const h = n('height', vh)
        if (w <= 0 || h <= 0) return null
        let rx = a.rx !== undefined ? n('rx') : a.ry !== undefined ? n('ry', vh) : 0
        let ry = a.ry !== undefined ? n('ry', vh) : rx
        rx = Math.min(rx, w / 2)
        ry = Math.min(ry, h / 2)
        if (!rx || !ry) return { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((p) => ({ p: p as Pt, in: null, out: null, smooth: false })) }] }
        const k = 0.5523
        return parsePathData(`M${x + rx} ${y}H${x + w - rx}C${x + w - rx + k * rx} ${y} ${x + w} ${y + ry - k * ry} ${x + w} ${y + ry}V${y + h - ry}C${x + w} ${y + h - ry + k * ry} ${x + w - rx + k * rx} ${y + h} ${x + w - rx} ${y + h}H${x + rx}C${x + rx - k * rx} ${y + h} ${x} ${y + h - ry + k * ry} ${x} ${y + h - ry}V${y + ry}C${x} ${y + ry - k * ry} ${x + rx - k * rx} ${y} ${x + rx} ${y}Z`)
      }
      case 'circle':
      case 'ellipse': {
        const cx = n('cx')
        const cy = n('cy', vh)
        const rx = tag(e) === 'circle' ? n('r', Math.hypot(vw, vh) / Math.SQRT2) : n('rx')
        const ry = tag(e) === 'circle' ? rx : n('ry', vh)
        if (rx <= 0 || ry <= 0) return null
        return parsePathData(`M${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}Z`)
      }
      case 'line':
        return parsePathData(`M${n('x1')} ${n('y1', vh)}L${n('x2')} ${n('y2', vh)}`)
      case 'polyline':
      case 'polygon': {
        const pts = (a.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
        if (pts.length < 4) return null
        let d = `M${pts[0]} ${pts[1]}`
        for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`
        return parsePathData(tag(e) === 'polygon' ? d + 'Z' : d)
      }
    }
    return null
  }

  /** A live shape where SVG's is exactly one of Plexel's. */
  const liveShape = (e: XmlElement): Geometry | null => {
    const a = e.attrs
    const n = (k: string, ref = vw) => len(a[k], ref) ?? 0
    if (tag(e) === 'circle' || tag(e) === 'ellipse') {
      const rx = tag(e) === 'circle' ? n('r') : n('rx')
      const ry = tag(e) === 'circle' ? rx : n('ry', vh)
      return { kind: 'shape', shape: { type: 'ellipse', x: n('cx') - rx, y: n('cy', vh) - ry, w: 2 * rx, h: 2 * ry } }
    }
    if (tag(e) === 'rect') {
      // Plexel's corners are round: a rect whose corners are elliptical stays a path.
      if (a.rx !== undefined && a.ry !== undefined && Math.abs(n('rx') - n('ry', vh)) > 1e-6) return null
      const rx = a.rx ?? a.ry
      const r = rx !== undefined ? Math.min(len(rx, vw) ?? 0, n('width') / 2, n('height', vh) / 2) : 0
      return { kind: 'shape', shape: { type: 'rect', x: n('x'), y: n('y', vh), w: n('width'), h: n('height', vh), radii: [r, r, r, r], corner: 'round' } }
    }
    if (tag(e) === 'line') return { kind: 'shape', shape: { type: 'line', x1: n('x1'), y1: n('y1', vh), x2: n('x2'), y2: n('y2', vh) } }
    return null
  }

  const textOf = (e: XmlElement, style: Style, m: M): DocNode | null => {
    const paragraphs: Paragraph[] = []
    let current: Paragraph = { runs: [], style: null, props: {} }
    const charOf = (st: Style): Partial<CharProps> => {
      const family = (st['font-family'] ?? 'Inter Variable').split(',')[0].trim().replace(/^['"]|['"]$/g, '')
      const w = st['font-weight'] ?? 'normal'
      const weight = w === 'bold' ? 700 : w === 'normal' ? 400 : Number(w) || 400
      const italic = /italic|oblique/.test(st['font-style'] ?? '')
      const styleName = `${weight >= 900 ? 'Black' : weight >= 800 ? 'ExtraBold' : weight >= 700 ? 'Bold' : weight >= 600 ? 'SemiBold' : weight >= 500 ? 'Medium' : weight <= 300 ? 'Light' : 'Regular'}${italic ? ' Italic' : ''}`.replace('Regular Italic', 'Italic')
      const size = len(st['font-size'], 16) ?? 16
      const ls = len(st['letter-spacing'], size, size)
      return { font: family, style: styleName, size, tracking: ls ? (ls / size) * 1000 : 0, underline: /underline/.test(st['text-decoration'] ?? ''), strikethrough: /line-through/.test(st['text-decoration'] ?? '') }
    }
    const visit = (el: XmlElement, st: Style, first: boolean) => {
      if (!first && (el.attrs.y !== undefined || el.attrs.dy !== undefined) && current.runs.length) {
        paragraphs.push(current)
        current = { runs: [], style: null, props: {} }
      }
      for (const c of el.children) {
        if (typeof c === 'string') {
          const t = c.replace(/\s+/g, ' ')
          if (t.trim() || current.runs.length) current.runs.push({ text: t, style: null, props: charOf(st) })
        } else if (tag(c) === 'tspan') visit(c, inherit(st, c), false)
      }
    }
    visit(e, style, true)
    if (current.runs.length) paragraphs.push(current)
    if (!paragraphs.length) return null
    for (const p of paragraphs) {
      p.runs[0].text = p.runs[0].text.replace(/^\s+/, '')
      p.runs[p.runs.length - 1].text = p.runs[p.runs.length - 1].text.replace(/\s+$/, '')
      const anchor = style['text-anchor']
      if (anchor === 'middle') p.props.align = 'centre'
      else if (anchor === 'end') p.props.align = 'right'
    }
    const fill = paintOf(style.fill ?? 'black', style, null)
    const x = len(e.attrs.x?.split(/[\s,]+/)[0], vw) ?? 0
    const y = len(e.attrs.y?.split(/[\s,]+/)[0], vh) ?? 0
    const n = makeNode('text', host.newId('t'), paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').slice(0, 40) || 'Text', {
      mode: 'point',
      content: { paragraphs },
      frame: null,
      pathOffset: 0,
      appearance: fill ? [{ kind: 'fill', enabled: true, paint: fill.paint, opacity: Number(style['fill-opacity'] ?? 1), blend: 'normal' }] : [],
    })
    common(n, style, mul(m, [1, 0, 0, 1, x, y]))
    return n
  }

  const imageOf = (e: XmlElement, style: Style, m: M): DocNode | null => {
    const href = e.attrs.href ?? e.attrs['xlink:href'] ?? ''
    const d = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(href)
    if (!d) {
      warn('Images linked from outside the file were left out; embedded ones came in')
      return null
    }
    let bytes: Uint8Array
    try {
      bytes = d[2] ? Uint8Array.from(atob(d[3].replace(/\s+/g, '')), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(d[3]))
    } catch {
      warn('An embedded image couldn’t be read')
      return null
    }
    if (/svg/.test(d[1])) {
      warn('An SVG embedded as an image was left out')
      return null
    }
    const x = len(e.attrs.x, vw) ?? 0
    const y = len(e.attrs.y, vh) ?? 0
    const w = len(e.attrs.width, vw) ?? 0
    const h = len(e.attrs.height, vh) ?? 0
    const n = makeNode('pixel', host.newId('p'), e.attrs.id ?? 'Image', { tiles: null, resample: 'bicubic' })
    common(n, style, mul(m, [1, 0, 0, 1, x, y]), [0, 0, w, h])
    images.push({ node: n.id, bytes, width: w, height: h })
    return n
  }

  const seenUse = new Set<XmlElement>()
  const element = (e: XmlElement, parentStyle: Style, pm: M): NodeId[] => {
    const t = tag(e)
    if (['defs', 'style', 'title', 'desc', 'metadata', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'filter', 'marker', 'symbol', 'script'].includes(t)) return []
    const style = inherit(parentStyle, e)
    const m = mul(pm, parseTransform(e.attrs.transform))
    if (t === 'g' || t === 'svg' || t === 'a' || t === 'switch') {
      let gm = m
      if (t === 'svg') {
        gm = mul(m, [1, 0, 0, 1, len(e.attrs.x, vw) ?? 0, len(e.attrs.y, vh) ?? 0])
        const nvb = (e.attrs.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
        const w = len(e.attrs.width, vw)
        const h = len(e.attrs.height, vh)
        if (nvb.length === 4 && w && h) gm = mul(gm, [w / nvb[2], 0, 0, h / nvb[3], (-nvb[0] * w) / nvb[2], (-nvb[1] * h) / nvb[3]])
      }
      const kids: NodeId[] = []
      // Children are given the group's full transform; the group keeps the identity, so opacity and masks stay put.
      const childStyle: Style = { ...style }
      delete childStyle.opacity
      delete childStyle['clip-path']
      delete childStyle['mix-blend-mode']
      for (const c of e.children) if (typeof c !== 'string') kids.push(...element(c, childStyle, gm))
      if (!kids.length) return []
      const g = makeNode('group', host.newId('g'), e.attrs.id ?? (t === 'svg' ? 'SVG' : 'Group'))
      g.children = kids
      common(g, style, I)
      // A group's clip path is in its children's user space.
      for (const mid of g.masks) nodes[mid].transform = gm as Affine
      g.blend = g.blend === 'normal' ? 'pass-through' : g.blend
      nodes[g.id] = g
      return [g.id]
    }
    if (t === 'use') {
      const href = e.attrs.href ?? e.attrs['xlink:href'] ?? ''
      const target = href.startsWith('#') ? byId.get(href.slice(1)) : undefined
      if (!target || seenUse.has(target)) return []
      seenUse.add(target)
      const um = mul(m, [1, 0, 0, 1, len(e.attrs.x, vw) ?? 0, len(e.attrs.y, vh) ?? 0])
      const out = tag(target) === 'symbol' ? target.children.flatMap((c) => (typeof c === 'string' ? [] : element(c, style, um))) : element(target, style, um)
      seenUse.delete(target)
      return out
    }
    if (t === 'text') {
      const n = textOf(e, style, m)
      if (!n) return []
      nodes[n.id] = n
      return [n.id]
    }
    if (t === 'image') {
      const n = imageOf(e, style, m)
      if (!n) return []
      nodes[n.id] = n
      return [n.id]
    }
    if (t === 'foreignObject') {
      warn('foreignObject content was left out')
      return []
    }
    const path = shapePath(e)
    if (!path) return []
    if (style['fill-rule'] === 'evenodd') path.fillRule = 'evenodd'
    // Dashes start where SVG's outline starts, which a live shape's doesn't: a dashed shape comes in as its path.
    const dashed = (style['stroke-dasharray'] ?? 'none') !== 'none' && style.stroke !== undefined && style.stroke !== 'none'
    const live = path.fillRule === 'nonzero' && !dashed ? liveShape(e) : null
    const box = boxOfPath(path)
    const appearance = appearanceOf(style, box, 1)
    const n = makeNode('vector', host.newId('v'), e.attrs.id ?? ({ path: 'Path', rect: 'Rectangle', circle: 'Ellipse', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon' } as Record<string, string>)[t] ?? 'Shape', { geometry: live ?? { kind: 'path', path }, appearance, graphicStyle: null })
    common(n, style, m, box)
    nodes[n.id] = n
    return [n.id]
  }

  const rootStyle: Style = { ...ownStyle(root) }
  const kids: NodeId[] = []
  const inner: Style = { ...rootStyle }
  delete inner.opacity
  for (const c of root.children) if (typeof c !== 'string') kids.push(...element(c, inner, rootM))
  const rootId = host.newId('r')
  const rootNode = makeNode('group', rootId, 'Root')
  rootNode.children = kids
  nodes[rootId] = rootNode
  const doc: Doc = { name: name.replace(/\.svgz?$/i, ''), width: W, height: H, resolution: 96, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' }, root: rootId, nodes, guides: [], selection: null }
  return { doc, images, warnings: [...warnings] }
}

/**
 * Stops moved by `shift` (a gradient's start moved along it), as stops over
 * 0..1 again: those that land inside kept, and the ends given the colour
 * the moved gradient has there (its first or last colour past its ends, as
 * SVG pads them).
 */
export function resampleStops(stops: PaintStop[], shift: number): PaintStop[] {
  const sorted = [...stops].sort((a, b) => a.at - b.at)
  const at = (t: number): PaintStop => {
    if (t <= sorted[0].at) return { ...sorted[0], at: t }
    for (let i = 1; i < sorted.length; i++)
      if (t <= sorted[i].at) {
        const a = sorted[i - 1]
        const b = sorted[i]
        const f = (t - a.at) / Math.max(1e-9, b.at - a.at)
        return { at: t, colour: a.colour.map((v, k) => v + (b.colour[k] - v) * f), alpha: a.alpha + (b.alpha - a.alpha) * f }
      }
    return { ...sorted[sorted.length - 1], at: t }
  }
  const out: PaintStop[] = [{ ...at(-shift), at: 0 }]
  for (const s of sorted) if (s.at + shift > 0 && s.at + shift < 1) out.push({ ...s, at: s.at + shift })
  out.push({ ...at(1 - shift), at: 1 })
  return out
}

