/**
 * Which layers are under a point on the canvas: the Move tool's Auto-Select
 * and Ctrl-click, and dropping a swatch on a shape.
 *
 * Layers are tried from the top of the panel down, as they're drawn on top
 * of each other: a hidden layer (or one in a hidden group) never counts, a
 * clipped layer counts only where the layer it's clipped to does, and a
 * layer's masks have to show it there too. Whether a layer has something
 * at the point depends on its kind:
 *
 * - pixels: its alpha there, through its transform;
 * - shapes and compounds: inside a fill, or on a stroke (within half its
 *   width, and a few screen pixels' grace);
 * - text: inside its glyphs' box, or its frame for area text;
 * - smart objects: inside their canvas; fill layers: everywhere.
 *
 * Pixel and mask values are read by the engine, all at once.
 */
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { invertAffine } from '../doc/edit'
import { geometryPath } from '../doc/vector'
import { engine } from '../engine/EngineHost'
import { flattenOutline, isGlyphs, outlineFillRule, type Outline } from '../geom/glyphs'
import { applyMat, pathBounds } from '../geom/path'
import { hitSegment } from '../geom/edit'
import { fillSegments, inside, windingAt } from '../geom/raster'
import { shapeOf } from '../vector/shape'
import { brushReach } from '../vector/brush'
import { layoutOf } from './text'
import { expandDoc, ownerOf } from '../doc/expand'

/** Below this a pixel (or a mask) counts as clear. */
const CLEAR = 0.1

const local = (t: Affine, x: number, y: number) => applyMat(invertAffine(t), x, y)
const scaleOf = (t: Affine) => Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1

/** Whether a path, filled by the fill rule, holds a point (in its own coordinates). */
function insidePath(path: Outline, x: number, y: number, tol: number): boolean {
  return inside(windingAt(fillSegments(flattenOutline(path, tol)), x, y), outlineFillRule(path))
}

/**
 * Whether a shape (or a compound shape) has paint at (x, y) in document
 * pixels: inside a fill, or on a stroke. `grace` is in document pixels.
 */
export function shapeHit(doc: Doc, node: DocNode, x: number, y: number, grace: number): boolean {
  const shape = shapeOf((id) => doc.nodes[id], node)
  if (!shape) return false
  const t = [...shape.transform] as Affine
  const [qx, qy] = local(t, x, y)
  const r = grace / scaleOf(t)
  const filled = shape.appearance.some((it) => it.enabled && it.kind === 'fill')
  if (filled && insidePath(shape.path, qx, qy, r / 4)) return true
  // A brush stroke reaches as far as its artwork does (half its reach: that's lengthened round turns).
  const width = Math.max(0, ...shape.appearance.filter((it) => it.enabled && it.kind === 'stroke').map((it) => (it.kind === 'stroke' ? (it.brush ? brushReach(it.brush, it.width, it.profile) : it.width) : 0)))
  return !isGlyphs(shape.path) && !!hitSegment(shape.path, qx, qy, Math.max(r, width / 2))
}

/** A point request for the engine, with what to do with its answer. */
interface Probe {
  set: string
  x: number
  y: number
  kind: 'alpha' | 'cover'
  outside?: number
}

/** A test that may need the engine: a value now, or a probe and what it means. */
type Test = boolean | { probe: Probe; pass(v: number): boolean }

/** What a layer itself has at the point, before its masks. */
function contentTest(doc: Doc, n: DocNode, x: number, y: number, grace: number): Test {
  switch (n.kind) {
    case 'pixel': {
      if (!n.props.tiles) return false
      const [lx, ly] = local(n.transform, x, y)
      return { probe: { set: n.props.tiles, x: lx, y: ly, kind: 'alpha' }, pass: (v) => v >= CLEAR }
    }
    case 'vector':
    case 'boolean':
      return shapeHit(doc, n, x, y, grace)
    case 'text': {
      const [lx, ly] = local(n.transform, x, y)
      const b = n.props.mode === 'area' && n.props.frame ? pathBounds(geometryPath(n.props.frame)) : (layoutOf(n, doc)?.bounds ?? null)
      return !!b && lx >= b[0] && lx <= b[2] && ly >= b[1] && ly <= b[3]
    }
    case 'embedded': {
      if (!n.props.content) return false
      const [lx, ly] = local(n.transform, x, y)
      return lx >= 0 && ly >= 0 && lx <= n.props.content.width && ly <= n.props.content.height
    }
    case 'fill':
      return true
    default:
      return false
  }
}

/** What a layer's masks let show at the point: each must. */
function maskTests(doc: Doc, n: DocNode, x: number, y: number): Test[] {
  const out: Test[] = []
  for (const id of n.masks) {
    const m = doc.nodes[id]
    if (!m || m.kind !== 'mask' || !m.visible) continue
    const [lx, ly] = local(m.transform, x, y)
    const shows = (v: number) => (m.props.invert ? 1 - v : v) * m.props.density + (1 - m.props.density) >= CLEAR
    if (m.props.source === 'vector') {
      const g = m.props.geometry
      out.push(shows(g ? (insidePath(geometryPath(g), lx, ly, 0.25) ? 1 : 0) : m.props.outside))
    } else if (m.props.tiles) out.push({ probe: { set: m.props.tiles, x: lx, y: ly, kind: 'cover', outside: m.props.outside }, pass: shows })
    else out.push(shows(m.props.outside))
  }
  return out
}

/**
 * Every layer under (x, y), in document pixels, topmost first. `grace` is
 * how far off a shape's edge still counts, in document pixels (a few
 * screen pixels at the zoom in use).
 */
export async function layersAt(page: Doc, x: number, y: number, grace = 0): Promise<NodeId[]> {
  // Artboards and symbol instances as the layers they're drawn as: a hit on an
  // instance's artwork is a hit on the instance, on an artboard's background the artboard's.
  const doc = expandDoc(page)
  // Each candidate, in order, with all its tests; a clipped layer also needs its base's.
  const candidates: { id: NodeId; tests: Test[] }[] = []
  const visit = (id: NodeId, clip: Test[]) => {
    const n = doc.nodes[id]
    if (!n || !n.visible) return
    if (n.kind === 'group') {
      // A group's masks hide what's in it.
      const masks = maskTests(doc, n, x, y)
      for (const c of [...(n.children ?? [])].reverse()) visit(c, [...clip, ...masks])
      return
    }
    if (n.kind === 'adjustment' || n.kind === 'mask' || n.kind === 'filter') return
    const own = [contentTest(doc, n, x, y, grace), ...maskTests(doc, n, x, y)]
    // Layers clipped to this one are above it, and show only where it does.
    if (n.kind !== 'boolean') for (const c of [...(n.children ?? [])].reverse()) visit(c, [...clip, ...own])
    candidates.push({ id, tests: [...clip, ...own] })
  }
  for (const c of [...(doc.nodes[doc.root]?.children ?? [])].reverse()) visit(c, [])

  // The engine's reads, all at once, each asked for once.
  const probes: Probe[] = []
  const index = new Map<string, number>()
  for (const c of candidates) {
    for (const t of c.tests) {
      if (typeof t === 'boolean') continue
      const k = `${t.probe.set}|${Math.floor(t.probe.x)}|${Math.floor(t.probe.y)}|${t.probe.kind}|${t.probe.outside ?? 0}`
      if (!index.has(k)) {
        index.set(k, probes.length)
        probes.push(t.probe)
      }
    }
  }
  const values = probes.length ? await engine().call('tiles.valuesAt', { points: probes }) : []
  const pass = (t: Test) => {
    if (typeof t === 'boolean') return t
    return t.pass(values[index.get(`${t.probe.set}|${Math.floor(t.probe.x)}|${Math.floor(t.probe.y)}|${t.probe.kind}|${t.probe.outside ?? 0}`)!] ?? 0)
  }
  const hits = candidates.filter((c) => c.tests.every(pass)).map((c) => ownerOf(c.id))
  return hits.filter((id, i) => hits.indexOf(id) === i && !!page.nodes[id])
}

/** The outermost group holding a layer, under the root; or the layer itself when it's at the top level. */
export function topGroupOf(doc: Doc, id: NodeId): NodeId {
  let at = id
  for (;;) {
    let parent: NodeId | null = null
    for (const n of Object.values(doc.nodes)) if (n.children?.includes(at)) parent = n.id
    if (!parent || parent === doc.root) return at
    at = parent
  }
}
