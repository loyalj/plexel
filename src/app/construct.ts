/**
 * Building shapes from shapes (ARCHITECTURE.md, "Vector construction"):
 * Pathfinder's shape modes and Divide, Trim, Merge, Crop and Minus Back
 * on any number of selected shapes; Outline Stroke, Offset Path, Join,
 * Simplify and Smooth on one; Live Paint; and the Shape Builder tool. Each
 * is one named step, its results paths in the document's coordinates.
 */
import { addVector, insertNode, invertAffine, moveNode, removeNode, setAppearance, setGeometry } from '../doc/edit'
import { makeNode } from '../doc/nodes'
import { freshName, placeOf } from '../doc/tree'
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { appearanceIn, fillItem, geometryPath, solid, strokeStyleOf, type AppearanceItem, type Paint, type StrokeItem } from '../doc/vector'
import { brushAsPaths } from '../vector/outline'
import { booleanPaths } from '../geom/boolean'
import { anchor, applyMat, flattenPath, pathBounds, transformPath, type PathData, type Pt } from '../geom/path'
import { contains, divide, joinPath, regionAt, simplifyPath, smoothPath, unite, type Region } from '../geom/regions'
import { strokeOutline } from '../geom/stroke'
import { offsetPath } from '../vector/itemEffects'
import { docPathOf } from '../vector/shape'
import type { OverlayShape } from '../render/overlay'
import { registerHover, registerTool, type Gesture, type Pointer } from './canvasTools'
import { swatchIn } from './colour'
import { documents, newId, selectedIds, type OpenDoc } from './documents'
import { notify } from './notices'
import { clearToolOverlay, setToolOverlay } from './overlay'

export type PathfinderOp = 'unite' | 'minus-front' | 'intersect' | 'exclude' | 'divide' | 'trim' | 'merge' | 'crop' | 'minus-back'

const PATHFINDER: [PathfinderOp, string][] = [
  ['unite', 'Unite'],
  ['minus-front', 'Minus Front'],
  ['intersect', 'Intersect'],
  ['exclude', 'Exclude'],
  ['divide', 'Divide'],
  ['trim', 'Trim'],
  ['merge', 'Merge'],
  ['crop', 'Crop'],
  ['minus-back', 'Minus Back'],
]

const isShape = (n: DocNode | undefined): n is DocNode => !!n && (n.kind === 'vector' || n.kind === 'boolean')

/** Every node in painting order, bottom first, across the whole tree. */
function paintOrder(doc: Doc): Map<NodeId, number> {
  const out = new Map<NodeId, number>()
  const walk = (id: NodeId) => {
    out.set(id, out.size)
    for (const c of doc.nodes[id]?.children ?? []) walk(c)
  }
  walk(doc.root)
  return out
}

/** The selected shapes and compound shapes, bottom first. */
export function selectedShapes(d: OpenDoc | null): DocNode[] {
  if (!d) return []
  const doc = d.history.present
  const order = paintOrder(doc)
  return selectedIds(d)
    .map((id) => doc.nodes[id])
    .filter(isShape)
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

const pathOfNode = (doc: Doc, n: DocNode) => docPathOf((id) => doc.nodes[id], n) ?? { subpaths: [], fillRule: 'nonzero' as const }
const appearanceOf = (n: DocNode) => (n.kind === 'vector' || n.kind === 'boolean' ? n.props.appearance : [])
const fillsOf = (a: AppearanceItem[]): AppearanceItem[] => a.filter((it) => it.kind === 'fill')

interface Made {
  path: PathData
  appearance: AppearanceItem[]
  name: string
}

/**
 * The shapes `old` taken out and `made` put in where the topmost of them
 * was, each a path in the document's coordinates; with `group`, in a new
 * group of that name. Returns the document and the new nodes' ids.
 */
function replaceShapes(doc: Doc, old: DocNode[], made: Made[], group?: string): { doc: Doc; ids: NodeId[] } {
  const top = old[old.length - 1]
  const place = placeOf(doc, top.id)
  if (!place) return { doc, ids: [] }
  let out = doc
  for (const n of old) out = removeNode(out, n.id)
  // Where the top one was, less the ones taken out from below it in the same list.
  const parent = place.parent
  const index = Math.min(place.index + 1 - old.filter((n) => placeOf(doc, n.id)?.parent === parent && placeOf(doc, n.id)!.index <= place.index).length, out.nodes[parent]?.children?.length ?? 0)
  let where = { parent, index }
  const ids: NodeId[] = []
  if (group) {
    const gid = newId('n')
    out = insertNode(out, makeNode('group', gid, freshName(out, group)), parent, index)
    where = { parent: gid, index: 0 }
    ids.push(gid)
  }
  made.forEach((m, k) => {
    const id = newId('n')
    out = addVector(out, id, m.name, { kind: 'path', path: m.path }, m.appearance, where.parent, where.index + k)
    if (!group) ids.push(id)
  })
  return { doc: out, ids }
}

const op = (path: PathData, o: 'add' | 'subtract' | 'intersect' | 'exclude') => ({ path, op: o })
const nonEmpty = (p: PathData) => p.subpaths.length > 0 && (pathBounds(p) ?? [0, 0, 0, 0])[2] > (pathBounds(p) ?? [0, 0, 0, 0])[0]

/** What a Pathfinder operation makes of shapes (bottom first), as paths with their looks. */
function pathfinderOf(doc: Doc, shapes: DocNode[], o: PathfinderOp): Made[] {
  const paths = shapes.map((n) => pathOfNode(doc, n))
  const top = shapes[shapes.length - 1]
  const name = (n: DocNode) => n.name
  switch (o) {
    case 'unite':
      return [{ path: booleanPaths(paths.map((p) => op(p, 'add'))), appearance: appearanceOf(top), name: name(top) }]
    case 'minus-front':
      return [{ path: booleanPaths(paths.map((p, i) => op(p, i ? 'subtract' : 'add'))), appearance: appearanceOf(shapes[0]), name: name(shapes[0]) }]
    case 'intersect':
      return [{ path: booleanPaths(paths.map((p, i) => op(p, i ? 'intersect' : 'add'))), appearance: appearanceOf(top), name: name(top) }]
    case 'exclude':
      return [{ path: booleanPaths(paths.map((p, i) => op(p, i ? 'exclude' : 'add'))), appearance: appearanceOf(top), name: name(top) }]
    case 'minus-back':
      return [{ path: booleanPaths([op(paths[paths.length - 1], 'add'), ...paths.slice(0, -1).map((p) => op(p, 'subtract'))]), appearance: appearanceOf(top), name: name(top) }]
    case 'crop': {
      // The top shape cuts every one below to itself, and goes.
      const cut = paths[paths.length - 1]
      return shapes.slice(0, -1).map((n, i) => ({ path: booleanPaths([op(paths[i], 'add'), op(cut, 'intersect')]), appearance: fillsOf(appearanceOf(n)), name: name(n) }))
    }
    case 'trim':
    case 'merge': {
      // Each shape less every one above it: what shows of it.
      const shown = shapes.map((n, i) => ({ n, path: i < shapes.length - 1 ? booleanPaths([op(paths[i], 'add'), ...paths.slice(i + 1).map((p) => op(p, 'subtract'))]) : paths[i] }))
      const made = shown.map((s) => ({ path: s.path, appearance: fillsOf(appearanceOf(s.n)), name: name(s.n) }))
      if (o === 'trim') return made
      // Merge: those painted alike made one.
      const groups = new Map<string, Made[]>()
      for (const m of made) {
        const k = JSON.stringify(m.appearance)
        groups.set(k, [...(groups.get(k) ?? []), m])
      }
      return [...groups.values()].map((g) => ({ path: unite(g.map((m) => m.path)), appearance: g[0].appearance, name: g[g.length - 1].name }))
    }
    case 'divide':
      return divide(paths).map((r) => ({ path: r.path, appearance: fillsOf(appearanceOf(shapes[Math.max(...r.inside)])), name: name(shapes[Math.max(...r.inside)]) }))
  }
}

const LABELS: Record<PathfinderOp, string> = Object.fromEntries(PATHFINDER) as Record<PathfinderOp, string>

/** Object → Pathfinder → (one), on the selected shapes. */
export function pathfinder(o: PathfinderOp) {
  const d = documents().active()
  const shapes = selectedShapes(d)
  if (!d || shapes.length < 2) return notify('info', 'Select two or more shapes for Pathfinder.')
  const doc = d.history.present
  let made: Made[]
  try {
    made = pathfinderOf(doc, shapes, o).filter((m) => nonEmpty(m.path))
  } catch (e) {
    return notify('error', `${LABELS[o]} couldn’t work these shapes out.`, [e instanceof Error ? e.message : String(e)])
  }
  if (!made.length) return notify('info', `${LABELS[o]} leaves nothing of these shapes.`)
  const many = made.length > 1
  let ids: NodeId[] = []
  documents().commit(
    (x) => {
      const r = replaceShapes(x, shapes, made, many ? LABELS[o] : undefined)
      ids = r.ids
      return r.doc
    },
    { key: d.key, label: LABELS[o] },
  )
  if (ids[0]) documents().select(ids[0], d.key)
}

// --- one shape's path ----------------------------------------------------------------------------

/** The selected shape (a plain one, its path in its own coordinates), or says why there's none. */
function oneShape(what: string): { d: OpenDoc; n: DocNode & { kind: 'vector' }; path: PathData } | null {
  const d = documents().active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : undefined
  if (!d || n?.kind !== 'vector' || !n.props.geometry) {
    notify('info', `${what} works on a shape: select one${n?.kind === 'boolean' ? ' (expand a compound shape first)' : ''}.`)
    return null
  }
  return { d, n, path: geometryPath(n.props.geometry) }
}

/** Object → Path → Join: the two open ends nearest each other joined, or one open path closed. */
export function joinShape() {
  const s = oneShape('Join')
  if (!s) return
  const next = joinPath(s.path)
  if (next === s.path) return notify('info', 'The path has no open ends to join.')
  documents().commit((x) => setGeometry(x, s.n.id, { kind: 'path', path: next }), { key: s.d.key, label: 'Join' })
}

/** Object → Path → Smooth. */
export function smoothShape() {
  const s = oneShape('Smooth')
  if (s) documents().commit((x) => setGeometry(x, s.n.id, { kind: 'path', path: smoothPath(s.path) }), { key: s.d.key, label: 'Smooth' })
}

/** What Simplify makes of the selected shape at a tolerance: the path, and its anchors before and after. */
export function simplified(tolerance: number, corner: number): { doc: Doc; before: number; after: number; key: string; apply(): void } | null {
  const s = oneShape('Simplify')
  if (!s) return null
  // The tolerance is in document pixels; the path is in the shape's own units.
  const t = s.n.transform
  const scale = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1
  const next = simplifyPath(s.path, tolerance / scale, corner)
  const count = (p: PathData) => p.subpaths.reduce((a, x) => a + x.anchors.length, 0)
  const doc = setGeometry(s.d.history.present, s.n.id, { kind: 'path', path: next })
  return { doc, before: count(s.path), after: count(next), key: s.d.key, apply: () => documents().commit((x) => setGeometry(x, s.n.id, { kind: 'path', path: next }), { key: s.d.key, label: 'Simplify' }) }
}

/**
 * Object → Path → Outline Stroke: the selected shape's top stroke made a
 * shape of its own just above it, filled with the stroke's paint, and the
 * stroke taken off the shape.
 */
export function outlineStroke() {
  const s = oneShape('Outline Stroke')
  if (!s) return
  const items = s.n.props.appearance
  const at = items.map((it, i) => ({ it, i })).filter(({ it }) => it.enabled && it.kind === 'stroke' && it.width > 0).pop()
  if (!at || at.it.kind !== 'stroke') return notify('info', `“${s.n.name}” has no stroke to outline.`)
  const st = at.it
  const t = s.n.transform
  if (st.brush) return outlineBrushStroke(s.d, s.n, items, at.i, st)
  const scale = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])) || 1
  const tol = 0.05 / scale
  const closed = s.path.subpaths.every((x) => x.closed)
  const aligned = closed && st.align !== 'centre'
  const loops = strokeOutline(flattenPath(s.path, tol), strokeStyleOf(st, aligned ? st.width * 2 : st.width), tol)
  const ring: PathData = { fillRule: 'nonzero', subpaths: loops.map((pts) => ({ closed: true, anchors: Array.from({ length: pts.length / 2 }, (_, i) => anchor(pts[2 * i], pts[2 * i + 1])) })) }
  let outline = booleanPaths([op(ring, 'add')])
  // Inside or outside: the doubled stroke kept where the shape is, or isn't.
  if (aligned) outline = booleanPaths([op(outline, 'add'), op(s.path, st.align === 'inside' ? 'intersect' : 'subtract')])
  const doc = s.d.history.present
  const place = placeOf(doc, s.n.id)!
  const id = newId('n')
  const fill = { ...fillItem(st.paint), opacity: st.opacity, blend: st.blend }
  documents().commit(
    (x) => {
      const y = setAppearance(x, s.n.id, items.filter((_, i) => i !== at.i))
      return addVector(y, id, freshName(y, `${s.n.name} Stroke`), { kind: 'path', path: transformPath(outline, t) }, [fill], place.parent, place.index + 1)
    },
    { key: s.d.key, label: 'Outline Stroke' },
  )
  documents().select(id, s.d.key)
}

/**
 * Outline Stroke on a stroke drawn with a vector brush: each part of the
 * brush's artwork a shape of its own, in its paint, grouped just above the
 * shape (the group taking the stroke's opacity and blend), and the stroke
 * taken off the shape.
 */
function outlineBrushStroke(d: OpenDoc, n: DocNode & { kind: 'vector' }, items: AppearanceItem[], index: number, st: StrokeItem) {
  const doc = d.history.present
  const parts = brushAsPaths(geometryPath(n.props.geometry), appearanceIn([st], doc.mode)[0] as StrokeItem, doc.mode)
  if (!parts.length) return notify('info', `“${n.name}”’s brush draws nothing to outline.`)
  const place = placeOf(doc, n.id)!
  const gid = newId('n')
  documents().commit(
    (x) => {
      let y = setAppearance(x, n.id, items.filter((_, i) => i !== index))
      const group = makeNode('group', gid, freshName(y, `${n.name} ${st.brush!.name}`))
      group.opacity = st.opacity
      group.blend = st.blend
      y = insertNode(y, group, place.parent, place.index + 1)
      parts.forEach((p, i) => {
        y = addVector(y, newId('n'), `${st.brush!.name} ${i + 1}`, { kind: 'path', path: transformPath(p.path, n.transform) }, [fillItem(p.paint)], gid, i)
      })
      return y
    },
    { key: d.key, label: 'Outline Stroke' },
  )
  documents().select(gid, d.key)
}

/** What Offset Path makes of the selected shape: a new shape just below it, its path offset. */
export function offsetShape(distance: number, join: 'miter' | 'round' | 'bevel', miter: number, commit: boolean): Doc | null {
  const d = documents().active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : undefined
  if (!d || !isShape(n)) {
    if (commit) notify('info', 'Offset Path works on a shape or a compound shape: select one.')
    return null
  }
  const doc = d.history.present
  const path = pathOfNode(doc, n)
  const made = offsetPath(path, distance, join, miter, 0.05)
  const place = placeOf(doc, n.id)!
  const id = newId('n')
  const next = addVector(doc, id, freshName(doc, `${n.name} Offset`), { kind: 'path', path: made }, appearanceOf(n), place.parent, place.index)
  if (commit) {
    documents().commit((x) => addVector(x, id, freshName(x, `${n.name} Offset`), { kind: 'path', path: made }, appearanceOf(n), place.parent, place.index), { key: d.key, label: 'Offset Path' })
    documents().select(id, d.key)
  }
  return next
}

// --- Live Paint ------------------------------------------------------------------------------------

/** A point inside a region: its box's middle if that's in it, else the middle of where a line across the middle first goes in. */
function interiorPoint(r: PathData): Pt | null {
  const b = pathBounds(r)
  if (!b) return null
  const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
  if (contains(r, c)) return c
  for (const fy of [0.5, 0.33, 0.67, 0.2, 0.8, 0.1, 0.9]) {
    const y = b[1] + (b[3] - b[1]) * fy
    const xs: number[] = []
    for (const l of flattenPath(r, 0.05)) {
      const n = l.pts.length / 2
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const y0 = l.pts[2 * i + 1]
        const y1 = l.pts[2 * j + 1]
        if (y0 <= y !== y1 <= y) xs.push(l.pts[2 * i] + ((y - y0) * (l.pts[2 * j] - l.pts[2 * i])) / (y1 - y0))
      }
    }
    xs.sort((a, b2) => a - b2)
    for (let i = 0; i + 1 < xs.length; i++) {
      const q: Pt = [(xs[i] + xs[i + 1]) / 2, y]
      if (contains(r, q)) return q
    }
  }
  return null
}

/** Whether a node is a Live Paint group. */
export const isLivePaint = (n: DocNode | undefined): n is DocNode & { kind: 'boolean' } => n?.kind === 'boolean' && !!n.props.live

/**
 * Object → Live Paint → Make: the selected shapes into a Live Paint group,
 * the regions they cut each other into filled as the topmost shape over
 * each was; their strokes stay theirs, drawn over the regions.
 */
export function makeLivePaint(): NodeId | null {
  const d = documents().active()
  const shapes = selectedShapes(d).filter((n) => !isLivePaint(n))
  if (!d || !shapes.length) {
    notify('info', 'Select shapes to make a Live Paint group of.')
    return null
  }
  const doc = d.history.present
  const paths = shapes.map((n) => pathOfNode(doc, n))
  const fills: { at: Pt; paint: Paint }[] = []
  for (const r of divide(paths)) {
    const top = [...r.inside].reverse().map((i) => shapes[i]).find((n) => appearanceOf(n).some((it) => it.enabled && it.kind === 'fill'))
    const q = interiorPoint(r.path)
    const fill = top ? [...appearanceOf(top)].reverse().find((it) => it.enabled && it.kind === 'fill') : null
    if (q && fill) fills.push({ at: q, paint: fill.paint })
  }
  const place = placeOf(doc, shapes[shapes.length - 1].id)!
  const id = newId('n')
  documents().commit(
    (x) => {
      let y = insertNode(x, makeNode('boolean', id, freshName(x, 'Live Paint'), { ops: {}, appearance: [], live: { fills } }), place.parent, place.index + 1)
      shapes.forEach((n, i) => (y = moveNode(y, n.id, id, i)))
      return y
    },
    { key: d.key, label: 'Make Live Paint' },
  )
  documents().select(id, d.key)
  return id
}

/** A Live Paint group's regions, in the document's coordinates. */
function liveRegions(doc: Doc, g: DocNode): Region[] {
  const kids = (g.children ?? []).map((c) => doc.nodes[c]).filter((c): c is DocNode => !!c && c.visible && isShape(c))
  return divide(kids.map((c) => pathOfNode(doc, c)))
}

/**
 * The Live Paint Bucket: the region clicked in a Live Paint group filled
 * with the foreground colour (Alt: its fill taken away). On shapes that
 * aren't one yet, it makes one of the selected shapes first.
 */
function livePaintClick(d: OpenDoc, p: Pointer) {
  let doc = d.history.present
  const sel = d.selected ? doc.nodes[d.selected] : undefined
  let g = isLivePaint(sel) ? sel : isLivePaint(doc.nodes[placeOf(doc, d.selected ?? '')?.parent ?? '']) ? doc.nodes[placeOf(doc, d.selected!)!.parent] : undefined
  if (!g) {
    const made = selectedShapes(d).length ? makeLivePaint() : null
    if (!made) return notify('info', 'Select shapes (or a Live Paint group) to paint the regions between them.')
    doc = documents().get(d.key)!.history.present
    g = doc.nodes[made]
  }
  const regions = liveRegions(doc, g)
  const i = regionAt(regions, [p.x, p.y])
  if (i < 0) return
  const t = g.transform
  const ti = invertAffine(t as Affine)
  const keep = (g.props as { live: { fills: { at: Pt; paint: Paint }[] } }).live.fills.filter((f) => !contains(regions[i].path, applyMat(t, f.at[0], f.at[1])))
  const fg = swatchIn(doc, 'fg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  const fills = p.altKey ? keep : [...keep, { at: applyMat(ti, p.x, p.y), paint: solid(fg) }]
  const gid = g.id
  documents().commit((x) => ({ ...x, nodes: { ...x.nodes, [gid]: { ...x.nodes[gid], props: { ...(x.nodes[gid].props as object), live: { fills } } } as DocNode } }), { key: d.key, label: 'Live Paint' })
}

/**
 * Object → Live Paint → Expand: the group's filled regions as shapes of
 * their own, with its paths (their strokes only) over them, in a group.
 */
export function expandLivePaint() {
  const d = documents().active()
  const g = d?.selected ? d.history.present.nodes[d.selected] : undefined
  if (!d || !isLivePaint(g)) return notify('info', 'Select a Live Paint group to expand.')
  const doc = d.history.present
  const regions = liveRegions(doc, g)
  const t = g.transform
  const made: Made[] = []
  for (const f of g.props.live!.fills) {
    const i = regionAt(regions, applyMat(t, f.at[0], f.at[1]))
    if (i >= 0) made.push({ path: regions[i].path, appearance: [fillItem(f.paint)], name: 'Region' })
  }
  const kids = (g.children ?? []).map((c) => doc.nodes[c]).filter(isShape)
  let ids: NodeId[] = []
  documents().commit(
    (x) => {
      const r = replaceShapes(x, [g], made, g.name)
      let y = r.doc
      const gid = r.ids[0]
      // The paths, strokes only, over the regions.
      kids.forEach((k, i) => {
        y = addVector(y, newId('n'), k.name, { kind: 'path', path: pathOfNode(doc, k) }, appearanceOf(k).filter((it) => it.kind === 'stroke'), gid, made.length + i)
      })
      ids = r.ids
      return y
    },
    { key: d.key, label: 'Expand Live Paint' },
  )
  if (ids[0]) documents().select(ids[0], d.key)
}

// --- the Shape Builder -------------------------------------------------------------------------------

/** A region's outline for the overlay, in document pixels. */
function regionShapes(r: Region, style: 'smart' | 'line'): OverlayShape[] {
  return flattenPath(r.path, 0.5).map((l) => ({ kind: 'path' as const, points: Array.from({ length: l.pts.length / 2 }, (_, i) => [l.pts[2 * i], l.pts[2 * i + 1]] as [number, number]), closed: true, style }))
}

let builderCache: { doc: Doc; ids: string; regions: Region[] } | null = null
function builderRegions(d: OpenDoc, shapes: DocNode[]): Region[] {
  const doc = d.history.present
  const ids = shapes.map((n) => n.id).join()
  if (builderCache && builderCache.doc === doc && builderCache.ids === ids) return builderCache.regions
  const regions = divide(shapes.map((n) => pathOfNode(doc, n)))
  builderCache = { doc, ids, regions }
  return regions
}

/**
 * The Shape Builder (Shift+U from the Shape tool): with shapes selected,
 * drag across the regions they make to merge them into one shape, or with
 * Alt to delete them. The shapes are cut into their regions as it does;
 * the regions keep the look of the shape on top of them.
 */
function builderPress(d: OpenDoc, p0: Pointer): Gesture | null {
  const shapes = selectedShapes(d)
  if (shapes.length < 1) {
    notify('info', 'Select the shapes to build from first, with the Move tool or in the Layers panel.')
    return null
  }
  const regions = builderRegions(d, shapes)
  const touched = new Set<number>()
  const touch = (p: Pointer) => {
    const i = regionAt(regions, [p.x, p.y])
    if (i >= 0) touched.add(i)
    setToolOverlay(d.key, { shapes: [...touched].flatMap((k) => regionShapes(regions[k], p.altKey ? 'line' : 'smart')) })
  }
  touch(p0)
  let alt = p0.altKey
  return {
    move(p) {
      alt = p.altKey
      touch(p)
    },
    up() {
      clearToolOverlay(d.key)
      if (!touched.size) return
      const doc = d.history.present
      // A region keeps the look of the shape on top of it.
      const looks = (r: Region) => appearanceOf(shapes[Math.max(...r.inside)])
      const made: Made[] = []
      regions.forEach((r, i) => {
        if (!touched.has(i)) made.push({ path: r.path, appearance: looks(r), name: shapes[Math.max(...r.inside)].name })
      })
      if (!alt) {
        const first = regions[[...touched][0]]
        made.push({ path: unite([...touched].map((i) => regions[i].path)), appearance: looks(first), name: shapes[Math.max(...first.inside)].name })
      }
      let ids: NodeId[] = []
      documents().commit(
        (x) => {
          const r = replaceShapes(x, shapes, made)
          ids = r.ids
          return r.doc
        },
        { key: d.key, label: alt ? 'Shape Builder Delete' : 'Shape Builder' },
      )
      void doc
      // The new shapes stay selected, to build on.
      if (ids.length) documents().selectMany(ids, ids[ids.length - 1], d.key)
    },
    cancel() {
      clearToolOverlay(d.key)
    },
  }
}

registerTool('builder', builderPress)
registerHover('builder', (p) => {
  const d = documents().active()
  if (!d) return
  const shapes = selectedShapes(d)
  if (!shapes.length) return clearToolOverlay(d.key)
  const regions = builderRegions(d, shapes)
  const i = regionAt(regions, [p.x, p.y])
  if (i >= 0) setToolOverlay(d.key, { shapes: regionShapes(regions[i], 'smart') })
  else clearToolOverlay(d.key)
})
registerTool('livepaint', (d, p) => {
  livePaintClick(d, p)
  return null
})
