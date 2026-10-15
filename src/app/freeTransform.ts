/**
 * Free Transform (Ctrl+Alt+T) and Transform Selection: a session on the
 * canvas with handles on the layer's box.
 *
 * Free: scale (corners keep proportions; Shift lets them go; Alt from the
 * middle), stretch, skew (Ctrl on an edge), move inside, turn outside, as
 * Photoshop's does; and Ctrl on a corner distorts, Ctrl+Alt+Shift puts it
 * in perspective. **Distort** and **Perspective** make that the corners'
 * drag; **Warp** shows a mesh of Bézier patches whose anchors, handles and
 * surface are dragged, or a style (Arc, Flag, Twist and the rest) chosen
 * in the options bar.
 *
 * What's affine goes into the layer's transform, as it always has. What
 * isn't (corners off their parallelogram, a mesh) is a **Warp** effect,
 * first in the layer's effects (filters/defs.ts): live, editable again by
 * Free Transform or in Properties, and drawn by the render graph for
 * pixels, smart objects, shapes and text alike, shapes and text as
 * outlines. The session works in the unit square of the box it started
 * on, so a layer already warped is picked up where it was left.
 *
 * With several layers selected, the box is round all of them and the
 * change is the same for each (scale, skew, move, turn; no warp). The
 * transform controls (app/transformControls.ts) open a session for one
 * drag of a handle and commit it when the pointer lifts.
 */
import { compose, invertAffine, moveEffect, removeNode, setAppearance, setParams, transformNode, updateNode, addEffect } from '../doc/edit'
import { moveTool } from './moveTool'
import { makeNode } from '../doc/nodes'
import type { Affine, Doc, DocNode, NodeId } from '../doc/types'
import { engine } from '../engine/EngineHost'
import { filterValues, styled } from '../filters/defs'
import type { Pt } from '../geom/path'
import {
  boxFrame,
  convexQuad,
  dragMeshPoint,
  dragMeshSurface,
  identityMesh,
  invertH,
  isAnchor,
  isIdentityMesh,
  isInner,
  mapH,
  meshEval,
  meshHeight,
  meshInverse,
  meshPoint,
  meshWidth,
  quadPoints,
  regridMesh,
  squareToQuad,
  styleMesh,
  type H3,
  type Mesh,
} from '../geom/warp'
import type { OverlayShape } from '../render/overlay'
import { apply } from '../render/view'
import { GRAB, cantMove, dist, movable, sessions, snapped, toDevice, transformBox, type Gesture, type Pointer, type Session } from './canvasTools'
import { documents, newId, type OpenDoc } from './documents'
import { notify } from './notices'
import { setToolOverlay } from './overlay'
import { boxOf } from '../geom/snap'
import { startSnap } from './snapping'
import { modifySelection } from './selection'
import { filterTarget } from './effects'

export type TransformMode = 'free' | 'distort' | 'perspective' | 'warp'

/** The warp chosen in the options bar: a style and its settings, or Custom (the mesh as dragged), and the mesh's grid. */
export interface WarpChoice {
  style: string
  bend: number
  horizontal: number
  vertical: number
  orient: 'horizontal' | 'vertical'
  /** Patches a side of a custom mesh. */
  grid: number
}

export const NO_WARP: WarpChoice = { style: 'none', bend: 50, horizontal: 0, vertical: 0, orient: 'horizontal', grid: 1 }

/** What the options bar shows, and changes, while a Free Transform is open. */
export interface TransformUi {
  mode: TransformMode
  /** Whether this transform can warp: a layer, not a group or the selection. */
  warps: boolean
  warp: WarpChoice
}

type Listener = () => void
class UiStore {
  private state: TransformUi = { mode: 'free', warps: false, warp: NO_WARP }
  private listeners = new Set<Listener>()
  /** The open session's reaction to a change made in the options bar. */
  onChange: ((prev: TransformUi) => void) | null = null
  get = () => this.state
  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  /** Set by the session itself, without telling it. */
  put(patch: Partial<TransformUi>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }
  /** Set from the options bar: the session follows. */
  set(patch: Partial<TransformUi>) {
    const prev = this.state
    if (patch.mode && patch.mode !== 'free' && !prev.warps) {
      notify('info', 'Distort, Perspective and Warp work on a layer: a group can be converted to a smart object first.')
      return
    }
    this.put(patch)
    this.onChange?.(prev)
  }
  setWarp(patch: Partial<WarpChoice>) {
    this.set({ warp: { ...this.state.warp, ...patch } })
  }
}
let uiStore: UiStore | null = null
export const transformUi = () => (uiStore ??= new UiStore())

const IDENT: Affine = [1, 0, 0, 1, 0, 0]
const UNIT: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const scaleAbout = (ax: number, ay: number, sx: number, sy: number): Affine => [sx, 0, 0, sy, ax - sx * ax, ay - sy * ay]
import { rotateAbout } from '../geom/affine'


/** A warp effect's settings: the frame it was made on, its corners in the node's own coordinates, the choice and mesh. */
export type WarpParams = Record<string, unknown>

/** The first Warp effect on a node, if it has one. */
function warpEffectOf(doc: Doc, id: NodeId): DocNode | null {
  for (const e of doc.nodes[id]?.effects ?? []) {
    const n = doc.nodes[e]
    if (n?.kind === 'filter' && n.props.filter === 'warp') return n
  }
  return null
}

/**
 * A document with a node's Warp effect set: added first in its effects
 * (as `effectId`) when it has none, its settings and name changed when it
 * has, taken off when `params` is null.
 */
function withWarp(doc: Doc, id: NodeId, params: WarpParams | null, name: string, effectId: NodeId): Doc {
  const have = warpEffectOf(doc, id)
  if (!params) return have ? removeNode(doc, have.id) : doc
  if (have) return updateNode(setParams(doc, have.id, params), have.id, (n) => (n.name === name ? n : ({ ...n, name } as DocNode)))
  const effect = makeNode('filter', effectId, name, { filter: 'warp', params })
  return moveEffect(addEffect(doc, id, effect), effectId, 0)
}

/** What a transform session moves: a layer (previewed live) or the selection's outline. */
interface TransformTarget {
  preview(m: Affine, warp: WarpParams | null, name: string): void
  commit(m: Affine, warp: WarpParams | null, name: string, label: string): void
  cancel(): void
  /** Draw the box as marching ants and hide the selection's own, as Transform Selection does. */
  ants?: boolean
  /** The layers being transformed, which snapping leaves out. */
  moving?: NodeId[]
}

/**
 * With Scale Strokes off, the strokes of shapes under `ids` (themselves,
 * or inside them) made narrower by as much as `m` scales them, so they
 * look as wide as before: widths, dashes and the dash offset.
 */
function keepStrokes(doc: Doc, ids: NodeId[], m: Affine): Doc {
  if (moveTool().get().scaleStrokes) return doc
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
  if (!(s > 1e-9) || Math.abs(s - 1) < 1e-9) return doc
  let out = doc
  const visit = (id: NodeId) => {
    const n = out.nodes[id]
    if (!n) return
    if ((n.kind === 'vector' || n.kind === 'boolean' || n.kind === 'text') && n.props.appearance.some((a) => a.kind === 'stroke')) {
      out = setAppearance(out, id, n.props.appearance.map((a) => (a.kind === 'stroke' ? { ...a, width: a.width / s, dash: a.dash.map((d) => d / s), dashOffset: a.dashOffset / s } : a)))
    }
    for (const c of n.children ?? []) visit(c)
  }
  for (const id of ids) visit(id)
  return out
}

/** Says why a transform can't start; no gesture. */
function refuse(why: string): null {
  notify('info', why)
  return null
}

/** A Free Transform for one drag (the transform controls): the press it starts with, the gesture it makes. */
export interface OneDrag {
  press: Pointer
}

/**
 * Starts Free Transform on the selected layers, in `mode`; with one
 * already open, changes its mode. With `once`, it's for the one drag
 * that press starts, committed when the pointer lifts: the gesture is
 * returned.
 */
export async function beginFreeTransform(mode: TransformMode = 'free', once?: OneDrag): Promise<Gesture | null> {
  const d = documents().active()
  if (!d) return null
  const open = sessions().get()
  if (!once && open?.kind === 'transform' && open.key === d.key) {
    transformUi().set({ mode })
    return null
  }
  const doc = d.history.present
  const ids = movable(d, true)
  if (ids.length > 1) return beginMany(d, ids, mode, once)
  // With a layer's effect selected (its Warp, say), the layer.
  const node = filterTarget(d)
  if (!node) return refuse('Select a layer to transform.')
  const why = cantMove(node)
  if (why) return refuse(why)
  // A layer, its own coordinates the frame, can warp; a group can't (convert it to a smart object first).
  const warps = node.kind !== 'group' && node.kind !== 'adjustment' && node.kind !== 'fill'
  if (mode !== 'free' && !warps) return refuse(`${node.kind === 'fill' ? 'A fill layer has no edge to' : 'Distort, Perspective and Warp work on a layer, not a group:'} ${node.kind === 'fill' ? 'warp' : 'convert it to a smart object first'}.`)
  // Picked up where it was left: a warp already on the layer gives the session its frame, corners and mesh.
  const have = warps ? warpEffectOf(doc, node.id) : null
  let frame: Affine
  let start: { corners: Pt[]; mesh: Mesh | null; choice: WarpChoice; own: number[] } | undefined
  if (have) {
    const v = filterValues('warp', have.kind === 'filter' ? have.props.params : {}, doc.mode)
    const own = v.frame as number[]
    frame = compose(node.transform, own as Affine)
    const fi = invertAffine(own as Affine)
    const c = (v.corners as number[] | null) ?? null
    const corners = c ? quadPoints(c).map(([x, y]) => apply(fi, x, y) as Pt) : UNIT.map((p) => [...p] as Pt)
    const mesh = v.style === 'custom' ? ((v.mesh as Mesh | null) ?? null) : null
    start = {
      corners,
      mesh: mesh ? { ...mesh, pts: [...mesh.pts] } : null,
      choice: { style: v.style as string, bend: v.bend as number, horizontal: v.horizontal as number, vertical: v.vertical as number, orient: v.orient as 'horizontal' | 'vertical', grid: mesh?.cols ?? 1 },
      own,
    }
  } else {
    const fb = await transformBox(doc, node)
    if (!fb) return refuse(`“${node.name}” has nothing in it to transform.`)
    // A compound's box is in the document; a warp is in its own coordinates, as everything else's is.
    const own = warps && node.kind === 'boolean' ? compose(invertAffine(node.transform), compose(fb.frame, boxFrame(fb.box) as Affine)) : (boxFrame(fb.box) as Affine)
    frame = warps && node.kind === 'boolean' ? compose(node.transform, own) : compose(fb.frame, own)
    start = { corners: UNIT.map((p) => [...p] as Pt), mesh: null, choice: NO_WARP, own }
  }
  const effectId = newId('f')
  const own = start.own
  const local = (c: Pt[]) => c.flatMap(([x, y]) => apply(own as Affine, x, y))
  const params = (corners: Pt[], mesh: Mesh | null, w: WarpChoice): WarpParams | null => {
    const flat = corners.every((p, i) => Math.abs(p[0] - UNIT[i][0]) < 1e-9 && Math.abs(p[1] - UNIT[i][1]) < 1e-9)
    const bent = w.style === 'custom' ? !!mesh && !isIdentityMesh(mesh) : w.style !== 'none'
    if (flat && !bent) return null
    return { style: bent ? w.style : 'none', bend: w.bend, horizontal: w.horizontal, vertical: w.vertical, orient: w.orient, frame: own, corners: local(corners), mesh: bent && w.style === 'custom' ? mesh : null }
  }
  return startSession(
    transformSession(
      d,
      frame,
      {
        preview: (m, warp, name) => previewDoc(d.key, keepStrokes(withWarp(transformNode(doc, node.id, m), node.id, warp, name, effectId), [node.id], m)),
        commit: (m, warp, name, label) => {
          unpreview(d.key)
          documents().commit((x) => keepStrokes(withWarp(transformNode(x, node.id, m), node.id, warp, name, effectId), [node.id], m), { key: d.key, label })
        },
        cancel: () => unpreview(d.key),
        moving: [node.id],
      },
      { warps, mode, start, params },
    ),
    once,
  )
}

/** Opens a session, or for one drag, opens it, hands it the press and commits it when the drag ends. */
function startSession(s: Session, once?: OneDrag): Gesture | null {
  sessions().start(s)
  if (!once) return null
  const g = s.down(once.press)
  if (!g) {
    sessions().end(true)
    return null
  }
  return {
    move: (p) => g.move(p),
    up(p) {
      g.up(p)
      if (sessions().get() !== s) return
      s.commit()
      sessions().end(false)
    },
    cancel() {
      g.cancel()
      if (sessions().get() === s) sessions().end(true)
    },
  }
}

/**
 * The box round several layers, in the document: each one's box through
 * its transform, all their corners together. Null when none has anything
 * in it.
 */
export async function boxOfLayers(doc: Doc, ids: NodeId[]): Promise<[number, number, number, number] | null> {
  const pts: Pt[] = []
  for (const id of ids) {
    const n = doc.nodes[id]
    const fb = n ? await transformBox(doc, n) : null
    if (!fb) continue
    const [x0, y0, x1, y1] = fb.box
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ])
      pts.push(apply(fb.frame, x, y) as Pt)
  }
  return pts.length ? boxOf(pts) : null
}

/** Free Transform on several layers: one box round them all, the same change for each; no warps. */
async function beginMany(d: OpenDoc, ids: NodeId[], mode: TransformMode, once?: OneDrag): Promise<Gesture | null> {
  if (mode !== 'free') return refuse('Distort, Perspective and Warp work on one layer at a time. Select one layer.')
  const doc = d.history.present
  for (const id of ids) {
    const why = cantMove(doc.nodes[id])
    if (why) return refuse(why)
  }
  const box = await boxOfLayers(doc, ids)
  if (!box) return refuse('The selected layers have nothing in them to transform.')
  const all = (x: Doc, m: Affine) => keepStrokes(ids.reduce((y, id) => (y.nodes[id] ? transformNode(y, id, m) : y), x), ids, m)
  return startSession(
    transformSession(
      d,
      boxFrame(box) as Affine,
      {
        preview: (m) => previewDoc(d.key, all(doc, m)),
        commit: (m, _w, _n, label) => {
          unpreview(d.key)
          documents().commit((x) => all(x, m), { key: d.key, label })
        },
        cancel: () => unpreview(d.key),
        moving: ids,
      },
      { warps: false, mode: 'free' },
    ),
    once,
  )
}

const previewDoc = (key: string, doc: Doc) => engine().setScene(key, doc)
const unpreview = (key: string) => {
  const d = documents().get(key)
  if (d) engine().setScene(key, d.history.present)
}

/**
 * Select → Transform Selection: Free Transform's handles on the
 * selection's box, the outline itself moved, scaled, skewed or turned, and
 * the selection made again through it when committed.
 */
export async function beginTransformSelection() {
  const d = documents().active()
  const sel = d?.history.present.selection?.tiles
  if (!d || !sel) return
  const b = await engine().call('select.bounds', { set: sel })
  if (!b) return
  sessions().start(
    transformSession(
      d,
      boxFrame(b) as Affine,
      {
        preview: () => {},
        commit: (m) => modifySelection({ kind: 'transform', m }, 'Transform Selection'),
        cancel: () => {},
        ants: true,
      },
      { warps: false, mode: 'free' },
    ),
  )
}

interface WarpSetup {
  warps: boolean
  mode: TransformMode
  start?: { corners: Pt[]; mesh: Mesh | null; choice: WarpChoice }
  params?: (corners: Pt[], mesh: Mesh | null, w: WarpChoice) => WarpParams | null
}

// Corners: top left, top right, bottom right, bottom left. Edges by their middle handle (4..7): top, right, bottom, left.
const EDGE: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
]
const OPPOSITE = [2, 3, 0, 1, 6, 7, 4, 5]

/**
 * The session. Everything is in the unit square of the box (`frame` takes
 * it into the document): the corners' homography H, a mesh in the square
 * before it, and `m`, the affine change in the document after both.
 */
function transformSession(d: OpenDoc, frame: Affine, target: TransformTarget, setup: WarpSetup): Session {
  const ui = transformUi()
  ui.put({ mode: setup.mode, warps: setup.warps, warp: setup.start?.choice ?? NO_WARP })
  const st = {
    m: [...IDENT] as Affine,
    corners: setup.start?.corners.map((p) => [...p] as Pt) ?? UNIT.map((p) => [...p] as Pt),
    /** The custom mesh (Custom); a style's is made from its settings. */
    mesh: setup.start?.mesh ?? null,
  }
  const H = (): H3 => squareToQuad(st.corners) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const meshNow = (): Mesh | null => {
    const w = ui.get().warp
    if (w.style === 'custom') return st.mesh
    return styled(w as unknown as Record<string, unknown>) ? styleMesh(w.style, w.bend / 100, w.horizontal / 100, w.vertical / 100, w.orient === 'vertical') : null
  }
  /** A point of the square, through the mesh and the corners, in the frame (before m). */
  const shown = (u: number, v: number, h = H(), mesh = meshNow()): Pt => {
    const [x, y] = mesh ? meshEval(mesh, u, v) : [u, v]
    return mapH(h, x, y) ?? [x, y]
  }
  const toDoc = (m: Affine, p: Pt) => apply(compose(m, frame), p[0], p[1]) as Pt
  // Handles in the frame: the corners, then the edges' middles.
  const handles = (): Pt[] => {
    const h = H()
    return [...st.corners, ...EDGE.map(([a, b]) => mapH(h, (UNIT[a][0] + UNIT[b][0]) / 2, (UNIT[a][1] + UNIT[b][1]) / 2) ?? st.corners[a])]
  }
  const centre = (): Pt => mapH(H(), 0.5, 0.5) ?? [0.5, 0.5]
  const warpParams = () => (setup.params ? setup.params(st.corners, st.mesh, ui.get().warp) : null)
  const names = () => {
    const w = warpParams()
    const bent = !!w && w.style !== 'none'
    const name = bent ? 'Warp' : ui.get().mode === 'perspective' ? 'Perspective' : 'Distort'
    const label = bent ? 'Warp' : w ? name : 'Free Transform'
    return { name, label }
  }

  // The outline drawn: the box's edges through the warp, as lines.
  const edgeLine = (from: Pt, to: Pt, n = 24): Pt[] => {
    const h = H()
    const mesh = meshNow()
    const out: Pt[] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      out.push(toDoc(st.m, shown(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, h, mesh)))
    }
    return out
  }
  const show = () => {
    const mode = ui.get().mode
    const mesh = meshNow()
    const outline = [...edgeLine([0, 0], [1, 0]), ...edgeLine([1, 0], [1, 1]).slice(1), ...edgeLine([1, 1], [0, 1]).slice(1), ...edgeLine([0, 1], [0, 0]).slice(1, -1)]
    const shapes: OverlayShape[] = [{ kind: 'path', points: outline, closed: true, style: target.ants ? 'ants' : 'line' }]
    if (mode === 'warp') {
      const m = mesh ?? identityMesh(ui.get().warp.grid, ui.get().warp.grid)
      // The grid at every third of a patch, as Photoshop draws it.
      for (let k = 1; k < 3 * m.cols; k++) shapes.push({ kind: 'path', points: edgeLine([k / (3 * m.cols), 0], [k / (3 * m.cols), 1]), closed: false, style: 'thin' })
      for (let k = 1; k < 3 * m.rows; k++) shapes.push({ kind: 'path', points: edgeLine([0, k / (3 * m.rows)], [1, k / (3 * m.rows)]), closed: false, style: 'thin' })
      if (ui.get().warp.style === 'custom' || ui.get().warp.style === 'none') {
        const h = H()
        const at = (i: number, j: number) => toDoc(st.m, mapH(h, ...meshPoint(m, i, j)) ?? meshPoint(m, i, j))
        const anchors: Pt[] = []
        const dots: Pt[] = []
        for (let j = 0; j < meshHeight(m); j++)
          for (let i = 0; i < meshWidth(m); i++) {
            if (isInner(i, j)) continue
            if (isAnchor(i, j)) anchors.push(at(i, j))
            else {
              dots.push(at(i, j))
              const ai = j % 3 === 0 ? (i % 3 === 1 ? i - 1 : i + 1) : i
              const aj = j % 3 === 0 ? j : j % 3 === 1 ? j - 1 : j + 1
              shapes.push({ kind: 'path', points: [at(ai, aj), at(i, j)], closed: false, style: 'thin' })
            }
          }
        shapes.push({ kind: 'dots', points: dots }, { kind: 'anchors', points: anchors, selected: anchors.map(() => false) })
      }
    } else shapes.push({ kind: 'handles', points: handles().map((p) => toDoc(st.m, p)) })
    setToolOverlay(d.key, { shapes, hideAnts: target.ants })
    const { name } = names()
    target.preview(st.m, warpParams(), name)
  }

  // The options bar changed the mode, the style or the grid.
  ui.onChange = (prev) => {
    const now = ui.get()
    if (now.warp.style === 'none' && prev.warp.style !== 'none') st.mesh = null
    else if (now.warp.style === 'custom' && prev.warp.style !== 'custom') {
      // Custom from a style: its mesh to drag, at the grid chosen.
      const from = styled(prev.warp as unknown as Record<string, unknown>) ? styleMesh(prev.warp.style, prev.warp.bend / 100, prev.warp.horizontal / 100, prev.warp.vertical / 100, prev.warp.orient === 'vertical') : st.mesh
      st.mesh = from ? (now.warp.grid === from.cols ? { ...from, pts: [...from.pts] } : regridMesh(from, now.warp.grid, now.warp.grid)) : identityMesh(now.warp.grid, now.warp.grid)
    } else if (now.warp.grid !== prev.warp.grid) {
      // A new grid: the shape as it is, on more or fewer patches.
      const from = meshNow() ?? st.mesh
      st.mesh = from ? regridMesh(from, now.warp.grid, now.warp.grid) : identityMesh(now.warp.grid, now.warp.grid)
      ui.put({ warp: { ...now.warp, style: from && !isIdentityMesh(from) ? 'custom' : now.warp.style === 'custom' ? 'custom' : 'none' } })
    }
    show()
  }
  show()

  const unitOf = (q: Pt): Pt | null => {
    const hi = invertH(H())
    return hi ? mapH(hi, q[0], q[1]) : null
  }
  /** Turns a mesh into the custom one to drag: the style's, or a flat one. */
  const customMesh = (): Mesh => {
    const w = ui.get().warp
    if (w.style !== 'custom') {
      const from = meshNow()
      st.mesh = from ? (from.cols === w.grid ? { ...from, pts: [...from.pts] } : regridMesh(from, w.grid, w.grid)) : identityMesh(w.grid, w.grid)
      ui.put({ warp: { ...w, style: 'custom' } })
    }
    return st.mesh!
  }

  const s: Session = {
    kind: 'transform',
    key: d.key,
    down(p0) {
      const dev = toDevice()
      const m0 = st.m
      const inv = invertAffine(compose(m0, frame))
      const local = (p: Pointer) => apply(inv, p.x, p.y) as Pt
      const mode = ui.get().mode
      const near = (q: Pt) => dist(dev(...toDoc(m0, q)), [p0.dx, p0.dy]) < GRAB
      const snap = startSnap(d, { moving: target.moving })
      const stop = { up: () => snap.end(), cancel: () => snap.end() }
      const c0 = st.corners.map((p) => [...p] as Pt)
      const q0 = local(p0)

      if (mode === 'warp') {
        const mesh = meshNow() ?? identityMesh(ui.get().warp.grid, ui.get().warp.grid)
        const h = H()
        // A point of the mesh: anchors before handles.
        let hit: [number, number] | null = null
        for (const anchors of [true, false]) {
          for (let j = 0; j < meshHeight(mesh) && !hit; j++)
            for (let i = 0; i < meshWidth(mesh) && !hit; i++) {
              if (isInner(i, j) || isAnchor(i, j) !== anchors) continue
              if (near(mapH(h, ...meshPoint(mesh, i, j)) ?? meshPoint(mesh, i, j))) hit = [i, j]
            }
          if (hit) break
        }
        const u0 = unitOf(q0)
        if (!u0) {
          snap.end()
          return null
        }
        let last = u0
        if (hit) {
          const [hi, hj] = hit
          return {
            ...stop,
            move(p) {
              const u = unitOf(local(p))
              if (!u) return
              dragMeshPoint(customMesh(), hi, hj, u[0] - last[0], u[1] - last[1])
              last = u
              show()
            },
          }
        }
        // On the surface: where on the mesh the press is, and that point dragged.
        const uv = meshInverse(mesh, u0[0], u0[1])
        if (!uv || uv[0] < 0 || uv[1] < 0 || uv[0] > 1 || uv[1] > 1) {
          snap.end()
          return { move() {}, up() {}, cancel() {} }
        }
        return {
          ...stop,
          move(p) {
            const u = unitOf(local(p))
            if (!u) return
            dragMeshSurface(customMesh(), uv[0], uv[1], u[0] - last[0], u[1] - last[1])
            last = u
            show()
          },
        }
      }

      const hs = handles()
      const hit = hs.findIndex((q) => near(q))
      const unit0 = unitOf(q0)
      const inside = !!unit0 && unit0[0] >= 0 && unit0[0] <= 1 && unit0[1] >= 0 && unit0[1] <= 1
      const cornerMode = (p: Pointer): 'distort' | 'perspective' | null => {
        if (!setup.warps) return null
        if (mode === 'distort' || mode === 'perspective') return mode
        if (p.ctrlKey && p.altKey && p.shiftKey) return 'perspective'
        if (p.ctrlKey) return 'distort'
        return null
      }
      const tryCorners = (next: Pt[]) => {
        if (!convexQuad(next)) return
        st.corners = next
        show()
      }
      if (hit >= 0 && hit < 4 && cornerMode(p0)) {
        const how = cornerMode(p0)!
        return {
          ...stop,
          move(raw) {
            const p = snapped(snap, raw)
            const q = local(p)
            const dx = q[0] - q0[0]
            const dy = q[1] - q0[1]
            const next = c0.map((c) => [...c] as Pt)
            if (how === 'distort') next[hit] = [c0[hit][0] + dx, c0[hit][1] + dy]
            else {
              // Perspective: the corner and its partner along the edge the drag runs along move apart or together.
              const across = Math.abs(dx) >= Math.abs(dy)
              const partner = across ? [1, 0, 3, 2][hit] : [3, 2, 1, 0][hit]
              next[hit] = across ? [c0[hit][0] + dx, c0[hit][1]] : [c0[hit][0], c0[hit][1] + dy]
              next[partner] = across ? [c0[partner][0] - dx, c0[partner][1]] : [c0[partner][0], c0[partner][1] - dy]
            }
            tryCorners(next)
          },
        }
      }
      if (hit >= 4 && setup.warps && (mode === 'distort' || mode === 'perspective')) {
        const [a, b] = EDGE[hit - 4]
        return {
          ...stop,
          move(raw) {
            const q = local(snapped(snap, raw))
            let dx = q[0] - q0[0]
            let dy = q[1] - q0[1]
            if (mode === 'perspective') {
              // Along the edge only: a skew of that edge.
              const ex = c0[b][0] - c0[a][0]
              const ey = c0[b][1] - c0[a][1]
              const l2 = ex * ex + ey * ey || 1
              const t = (dx * ex + dy * ey) / l2
              dx = ex * t
              dy = ey * t
            }
            const next = c0.map((c) => [...c] as Pt)
            next[a] = [c0[a][0] + dx, c0[a][1] + dy]
            next[b] = [c0[b][0] + dx, c0[b][1] + dy]
            tryCorners(next)
          },
        }
      }
      if (hit >= 0) {
        const corner = hit < 4
        return {
          ...stop,
          move(raw) {
            // The handle snaps, unless it's skewing.
            const p = raw.ctrlKey && !corner ? raw : snapped(snap, raw)
            const [qx, qy] = local(p)
            const [hx, hy] = hs[hit]
            const [ax, ay] = p.altKey ? centre() : hs[OPPOSITE[hit]]
            if (p.ctrlKey && !corner) {
              // Skew along the edge held.
              const horizontal = hit === 4 || hit === 6
              const k = horizontal ? (qx - hx) / (hy - ay || 1) : (qy - hy) / (hx - ax || 1)
              const sk: Affine = horizontal ? [1, 0, k, 1, -k * ay, 0] : [1, k, 0, 1, 0, -k * ax]
              st.m = compose(m0, compose(frame, compose(sk, invertAffine(frame))))
            } else {
              let sx = corner || hit === 5 || hit === 7 ? (qx - ax) / (hx - ax || 1) : 1
              let sy = corner || hit === 4 || hit === 6 ? (qy - ay) / (hy - ay || 1) : 1
              // Corners keep the proportions; Shift lets them go, as in Photoshop.
              if (corner && !p.shiftKey) {
                const k = Math.abs(sx) > Math.abs(sy) ? Math.abs(sx) : Math.abs(sy)
                sx = Math.sign(sx || 1) * k
                sy = Math.sign(sy || 1) * k
              }
              st.m = compose(m0, compose(frame, compose(scaleAbout(ax, ay, sx, sy), invertAffine(frame))))
            }
            show()
          },
        }
      }
      if (inside) {
        // The box round the transformed corners, as it was at the press: what snaps.
        const box0 = boxOf(st.corners.map((q) => toDoc(m0, q)))!
        return {
          ...stop,
          move(p) {
            let dx = p.x - p0.x
            let dy = p.y - p0.y
            const lock = p.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'y' : 'x') : null
            if (lock === 'y') dy = 0
            if (lock === 'x') dx = 0
            const [sx, sy] = snap.box([box0[0] + dx, box0[1] + dy, box0[2] + dx, box0[3] + dy], p, (ox, oy) => [lock === 'x' ? 0 : ox, lock === 'y' ? 0 : oy])
            st.m = compose([1, 0, 0, 1, dx + sx, dy + sy], m0)
            show()
          },
        }
      }
      snap.end()
      // Outside the box: turn it about its centre; Shift in 15° steps.
      const [cx, cy] = toDoc(m0, centre())
      const a0 = Math.atan2(p0.y - cy, p0.x - cx)
      const g: Gesture = {
        move(p) {
          let a = Math.atan2(p.y - cy, p.x - cx) - a0
          if (p.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
          st.m = compose(rotateAbout(cx, cy, a), m0)
          show()
        },
        up() {},
        cancel() {},
      }
      return g
    },
    commit() {
      ui.onChange = null
      const w = warpParams()
      const still = st.m.every((v, i) => Math.abs(v - IDENT[i]) < 1e-12)
      const before = setup.start && (setup.start.mesh || setup.start.choice.style !== 'none' || !setup.start.corners.every((p, i) => p[0] === UNIT[i][0] && p[1] === UNIT[i][1]))
      if (still && !w && !before) return target.cancel()
      const { name, label } = names()
      target.commit(st.m, w, name, label)
    },
    cancel: () => {
      ui.onChange = null
      target.cancel()
    },
    readout() {
      const q = st.corners.map((p) => toDoc(st.m, p))
      const w = dist(q[0], q[1])
      const h = dist(q[0], q[3])
      const angle = (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI
      const size = `W ${Math.round(w)} px, H ${Math.round(h)} px, ${angle.toFixed(1)}°.`
      switch (ui.get().mode) {
        case 'distort':
          return `${size} Distort: drag a corner anywhere, or an edge to move both its corners. Enter commits; Esc cancels.`
        case 'perspective':
          return `${size} Perspective: drag a corner to bring its edge in or out, or an edge to lean it. Enter commits; Esc cancels.`
        case 'warp':
          return `Warp: drag the mesh, its anchors or their handles, or choose a style. Enter commits; Esc cancels.`
      }
      return `${size} Drag a handle to scale (Shift: freely, Alt: from the centre, Ctrl on an edge: skew${setup.warps ? ', Ctrl on a corner: distort' : ''}), inside to move, outside to turn. Enter commits; Esc cancels.`
    },
  }
  return s
}
