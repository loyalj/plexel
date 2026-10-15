/**
 * Effects on one fill or one stroke of a shape's appearance stack
 * (ARCHITECTURE.md, "Effects per fill and stroke"): Illustrator's
 * appearance effects, which Affinity doesn't have.
 *
 * Two stages. **Path** effects change the outline the item is drawn from,
 * in the shape's own coordinates, before it's filled or stroked: Transform
 * (moved, scaled and turned, with copies), Offset Path, Roughen, Pucker &
 * Bloat, Zig Zag and Warp. **Pixel** effects are live filters (any filter
 * that doesn't move pixels about, Drop Shadow and Outer Glow among them),
 * run on what the item paints, before it's laid on the ones below.
 *
 * Each item keeps its effects in order, top of the list first, as plain
 * JSON: `{ kind, enabled, params }`, `kind` a PATH_EFFECTS id or a filter's.
 */
import { readParamValues, type ParamDef } from '../doc/params'
import { isObject } from '../doc/read'
import { booleanPaths } from '../geom/boolean'
import { anchor, flattenPath, pathBounds, transformPath, type Box, type PathData, type Pt, type Subpath } from '../geom/path'
import { strokeOutline } from '../geom/stroke'
import { WARP_STYLES, WarpMap, boxFrame, frameCorners, styleMesh } from '../geom/warp'
import { FILTER_BY_ID, hash01 } from '../filters/defs'

export interface ItemEffect {
  kind: string
  enabled: boolean
  params: Record<string, unknown>
}

export interface PathEffectDef {
  id: string
  label: string
  params: readonly ParamDef[]
  /** The path the item is drawn from, changed; `tol` is how finely curves are followed, in the shape's units. */
  apply(path: PathData, v: Record<string, unknown>, tol: number): PathData
}

const num = (key: string, label: string, min: number, max: number, def: number, unit: string, step = 1, hint?: string): ParamDef => ({ key, kind: 'number', label, min, max, step, unit, default: def, hint })

/** A path of straight lines through polylines' points. */
function linesPath(lines: { pts: ArrayLike<number>; closed: boolean }[], fillRule: PathData['fillRule']): PathData {
  const subpaths: Subpath[] = []
  for (const l of lines) {
    if (l.pts.length < 4) continue
    const anchors = []
    for (let i = 0; i < l.pts.length; i += 2) anchors.push(anchor(l.pts[i], l.pts[i + 1]))
    subpaths.push({ closed: l.closed, anchors })
  }
  return { subpaths, fillRule }
}

/** A path through points, smoothly (Catmull–Rom's handles) or with corners. */
function pointsPath(pts: Pt[], closed: boolean, smooth: boolean): Subpath {
  const n = pts.length
  const at = (i: number) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))]
  return {
    closed,
    anchors: pts.map((p, i) => {
      if (!smooth) return anchor(p[0], p[1])
      const a = at(i - 1)
      const b = at(i + 1)
      const t: Pt = [(b[0] - a[0]) / 6, (b[1] - a[1]) / 6]
      return anchor(p[0], p[1], [p[0] - t[0], p[1] - t[1]], [p[0] + t[0], p[1] + t[1]], true)
    }),
  }
}

/** Points along a polyline every `step`, its corners kept. */
function resample(pts: ArrayLike<number>, closed: boolean, step: number): Pt[] {
  const out: Pt[] = []
  const n = pts.length / 2
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const ax = pts[2 * i]
    const ay = pts[2 * i + 1]
    const bx = pts[2 * ((i + 1) % n)]
    const by = pts[2 * ((i + 1) % n) + 1]
    const len = Math.hypot(bx - ax, by - ay)
    const k = Math.max(1, Math.round(len / step))
    for (let j = 0; j < k; j++) out.push([ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k])
  }
  if (!closed && n) out.push([pts[2 * (n - 1)], pts[2 * (n - 1) + 1]])
  return out
}

export const PATH_EFFECTS: PathEffectDef[] = [
  {
    id: 'transform',
    label: 'Transform',
    params: [
      num('moveX', 'Move across', -2000, 2000, 10, 'px', 1),
      num('moveY', 'Move down', -2000, 2000, 10, 'px', 1),
      num('scaleX', 'Scale across', 1, 1000, 100, '%'),
      num('scaleY', 'Scale down', 1, 1000, 100, '%'),
      num('angle', 'Angle', -360, 360, 0, '°'),
      num('copies', 'Copies', 0, 50, 0, '', 1, 'Each copy moved, scaled and turned again from the last; none moves the item itself.'),
    ],
    apply(path, v) {
      const b = pathBounds(path)
      if (!b) return path
      const cx = (b[0] + b[2]) / 2
      const cy = (b[1] + b[3]) / 2
      const a = ((v.angle as number) * Math.PI) / 180
      const sx = (v.scaleX as number) / 100
      const sy = (v.scaleY as number) / 100
      const c = Math.cos(a)
      const s = Math.sin(a)
      // About the box's middle: scale, turn, then move.
      const m = [c * sx, s * sx, -s * sy, c * sy, 0, 0]
      m[4] = cx - m[0] * cx - m[2] * cy + (v.moveX as number)
      m[5] = cy - m[1] * cx - m[3] * cy + (v.moveY as number)
      const copies = Math.round(v.copies as number)
      if (!copies) return transformPath(path, m)
      const out: PathData = { subpaths: [...path.subpaths], fillRule: 'nonzero' }
      let cur = path
      for (let k = 0; k < copies; k++) {
        cur = transformPath(cur, m)
        out.subpaths.push(...cur.subpaths)
      }
      return out
    },
  },
  {
    id: 'offset',
    label: 'Offset Path',
    params: [
      num('distance', 'Offset', -500, 500, 10, 'px', 0.5, 'Out from the outline; in, when negative.'),
      { key: 'join', kind: 'choice', label: 'Joins', options: [['miter', 'Miter'], ['round', 'Round'], ['bevel', 'Bevel']], default: 'miter' },
      num('miter', 'Miter limit', 1, 20, 4, '×', 0.5),
    ],
    apply: (path, v, tol) => offsetPath(path, v.distance as number, v.join as 'miter' | 'round' | 'bevel', v.miter as number, tol),
  },
  {
    id: 'roughen',
    label: 'Roughen',
    params: [
      num('size', 'Size', 0, 200, 5, 'px', 0.5, 'How far points stray from the outline.'),
      num('detail', 'Detail', 1, 100, 10, '/100 px', 1, 'How many points, every hundred pixels along the outline.'),
      { key: 'smooth', kind: 'bool', label: 'Smooth', default: false, hint: 'Curves through the points rather than corners at them.' },
      num('seed', 'Seed', 0, 9999, 1, ''),
    ],
    apply(path, v, tol) {
      const step = 100 / Math.max(1, v.detail as number)
      const size = v.size as number
      const seed = v.seed as number
      let k = 0
      const subpaths = flattenPath(path, tol).map((l) => {
        const pts = resample(l.pts, l.closed, step).map(([x, y]): Pt => {
          k++
          return [x + (hash01(k, 1, seed, 0) * 2 - 1) * size, y + (hash01(k, 2, seed, 0) * 2 - 1) * size]
        })
        return pointsPath(pts, l.closed, !!v.smooth)
      })
      return { subpaths: subpaths.filter((s) => s.anchors.length >= 2), fillRule: path.fillRule }
    },
  },
  {
    id: 'pucker',
    label: 'Pucker & Bloat',
    params: [num('amount', 'Amount', -200, 200, 30, '%', 1, 'Pucker (negative) pulls the points in and pushes the curves out; Bloat the other way.')],
    apply(path, v) {
      const b = pathBounds(path)
      if (!b) return path
      const cx = (b[0] + b[2]) / 2
      const cy = (b[1] + b[3]) / 2
      const a = (v.amount as number) / 100
      const to = (p: Pt, k: number): Pt => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k]
      return {
        fillRule: path.fillRule,
        subpaths: path.subpaths.map((s) => {
          const n = s.anchors.length
          return {
            closed: s.closed,
            anchors: s.anchors.map((an, i) => {
              // Each segment's handles towards its middle, pushed the other way from the anchors.
              const prev = s.anchors[(i - 1 + n) % n].p
              const next = s.anchors[(i + 1) % n].p
              const inH: Pt = [(an.p[0] * 2 + prev[0]) / 3, (an.p[1] * 2 + prev[1]) / 3]
              const outH: Pt = [(an.p[0] * 2 + next[0]) / 3, (an.p[1] * 2 + next[1]) / 3]
              return anchor(...to(an.p, 1 - a), i > 0 || s.closed ? to(inH, 1 + a) : null, i < n - 1 || s.closed ? to(outH, 1 + a) : null)
            }),
          }
        }),
      }
    },
  },
  {
    id: 'zigzag',
    label: 'Zig Zag',
    params: [num('size', 'Size', 0, 200, 6, 'px', 0.5), num('ridges', 'Ridges', 1, 200, 10, '/100 px', 1), { key: 'smooth', kind: 'bool', label: 'Smooth', default: false, hint: 'Waves rather than zigzags.' }],
    apply(path, v, tol) {
      const step = 100 / Math.max(1, v.ridges as number) / 2
      const size = v.size as number
      const subpaths = flattenPath(path, tol).map((l) => {
        const pts = resample(l.pts, l.closed, step)
        const n = pts.length
        const out = pts.map((p, i): Pt => {
          const a = pts[l.closed ? (i - 1 + n) % n : Math.max(0, i - 1)]
          const b = pts[l.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]
          const tx = b[0] - a[0]
          const ty = b[1] - a[1]
          const len = Math.hypot(tx, ty) || 1
          const s = (i % 2 ? 1 : -1) * size
          return [p[0] - (ty / len) * s, p[1] + (tx / len) * s]
        })
        return pointsPath(out, l.closed, !!v.smooth)
      })
      return { subpaths: subpaths.filter((s) => s.anchors.length >= 2), fillRule: path.fillRule }
    },
  },
  {
    id: 'warp',
    label: 'Warp',
    params: [
      { key: 'style', kind: 'choice', label: 'Style', options: WARP_STYLES.filter(([s]) => s !== 'none' && s !== 'custom'), default: 'arc' },
      { key: 'orient', kind: 'choice', label: 'Orientation', options: [['horizontal', 'Horizontal'], ['vertical', 'Vertical']], default: 'horizontal' },
      num('bend', 'Bend', -100, 100, 50, '%'),
      num('horizontal', 'Horizontal distortion', -100, 100, 0, '%'),
      num('vertical', 'Vertical distortion', -100, 100, 0, '%'),
    ],
    apply(path, v, tol) {
      const b = pathBounds(path)
      if (!b || b[2] - b[0] < 1e-9 || b[3] - b[1] < 1e-9) return path
      const frame = boxFrame(b)
      const m = new WarpMap({ frame, corners: frameCorners(frame), mesh: styleMesh(v.style as string, (v.bend as number) / 100, (v.horizontal as number) / 100, (v.vertical as number) / 100, v.orient === 'vertical') })
      const subpaths = flattenPath(path, tol).map((l) => {
        // Cut finely enough to follow the bend, then carried through it.
        const pts = resample(l.pts, l.closed, Math.max(tol * 20, Math.max(b[2] - b[0], b[3] - b[1]) / 64))
        return pointsPath(pts.map((p) => m.forward(p[0], p[1]) ?? p), l.closed, false)
      })
      return { subpaths, fillRule: path.fillRule }
    },
  },
]

const PATH_EFFECT_BY_ID = new Map(PATH_EFFECTS.map((d) => [d.id, d]))

/** Pixel effects: live filters that don't move pixels about the canvas. */
export const pixelEffectIds = () => [...FILTER_BY_ID.values()].filter((d) => !d.hidden && !d.warp && !d.remap).map((d) => d.id)

/** Whether an effect is a path effect, a pixel effect, or neither (a kind this build doesn't know). */
export const stageOf = (kind: string): 'path' | 'pixels' | null => (PATH_EFFECT_BY_ID.has(kind) ? 'path' : FILTER_BY_ID.get(kind) && !FILTER_BY_ID.get(kind)!.warp && !FILTER_BY_ID.get(kind)!.remap ? 'pixels' : null)

/** An effect's settings, whole, from its registry entry. */
export function effectValues(e: ItemEffect, mode: 'rgb' | 'gray' | 'cmyk'): Record<string, unknown> {
  const defs = PATH_EFFECT_BY_ID.get(e.kind)?.params ?? FILTER_BY_ID.get(e.kind)?.params ?? []
  return readParamValues(defs, e.params, mode)
}

export function effectLabel(kind: string): string {
  return PATH_EFFECT_BY_ID.get(kind)?.label ?? FILTER_BY_ID.get(kind)?.label ?? kind
}

/** An item's effects read back from a file: those with a kind and params, as they are (made whole when used). */
export function readItemEffects(v: unknown): ItemEffect[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((e): e is Record<string, unknown> => isObject(e) && typeof e.kind === 'string' && e.kind.length <= 64)
    .slice(0, 32)
    .map((e) => ({ kind: e.kind as string, enabled: e.enabled !== false, params: isObject(e.params) ? (e.params as Record<string, unknown>) : {} }))
}

/** An item's path through its path effects, in order; the path as it was when it has none. */
export function itemPath(path: PathData, effects: ItemEffect[] | undefined, mode: 'rgb' | 'gray' | 'cmyk', tol: number): PathData {
  let p = path
  for (const e of effects ?? []) {
    if (!e.enabled) continue
    const def = PATH_EFFECT_BY_ID.get(e.kind)
    if (def) p = def.apply(p, readParamValues(def.params, e.params, mode), tol)
  }
  return p
}

/** Whether an item has path effects that change its outline. */
export const hasPathEffects = (effects: ItemEffect[] | undefined) => !!effects?.some((e) => e.enabled && PATH_EFFECT_BY_ID.has(e.kind))

/** An item's pixel effects, shown, in order. */
export const pixelEffects = (effects: ItemEffect[] | undefined) => (effects ?? []).filter((e) => e.enabled && stageOf(e.kind) === 'pixels')

/** How far an item's pixel effects reach past what it paints, in document pixels. */
export function pixelReach(effects: ItemEffect[] | undefined, mode: 'rgb' | 'gray' | 'cmyk'): number {
  let m = 0
  for (const e of pixelEffects(effects)) m += Math.ceil(FILTER_BY_ID.get(e.kind)!.reach(effectValues(e, mode), 1))
  return m
}

/**
 * Offset Path: the outline grown by `d` (shrunk, negative), its corners
 * mitred, rounded or bevelled: the path with its stroke `2|d|` wide added
 * (or taken away), worked out by the booleans so the result is a path.
 */
export function offsetPath(path: PathData, d: number, join: 'miter' | 'round' | 'bevel', miter: number, tol: number): PathData {
  if (Math.abs(d) < 1e-9 || !path.subpaths.length) return path
  const lines = flattenPath(path, tol)
  const loops = strokeOutline(lines, { width: 2 * Math.abs(d), join, cap: join === 'round' ? 'round' : 'butt', miter, dash: [], dashOffset: 0 }, tol)
  const ring = linesPath(loops.map((pts) => ({ pts, closed: true })), 'nonzero')
  const closed: PathData = { subpaths: path.subpaths.filter((s) => s.closed), fillRule: path.fillRule }
  if (!closed.subpaths.length) return ring
  return booleanPaths([
    { path: closed, op: 'add' },
    { path: ring, op: d > 0 ? 'add' : 'subtract' },
  ])
}

/** The box an item's path effects take a path to, or the path's own. */
export function itemBounds(path: PathData, effects: ItemEffect[] | undefined, mode: 'rgb' | 'gray' | 'cmyk', tol: number): Box | null {
  return pathBounds(hasPathEffects(effects) ? itemPath(path, effects, mode, tol) : path)
}
