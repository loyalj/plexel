/**
 * Vector brushes from the page's side (doc/vectorBrush.ts has the model,
 * vector/brush.ts the drawing): what the Vector Brushes panel, Brush
 * Options, Properties and the Layer menu's Brushes do, each one named step.
 *
 * The brushes to choose from are the document's, then the built-in ones
 * (vector/brushLibrary.ts) it hasn't changed: a built-in one edited in
 * Brush Options is kept in the document under the same id.
 */
import { addVectorBrush, artFrom, removeVectorBrush, restrokeWith, type BrushArt, type BrushPart, type VectorBrush } from '../doc/vectorBrush'
import { setAppearance } from '../doc/edit'
import { stylable } from '../doc/graphicStyles'
import { layerRows } from '../doc/tree'
import type { Doc, DocNode, NodeId } from '../doc/types'
import { appearanceIn, geometryPath, solid, strokeItem, type AppearanceItem, type StrokeItem } from '../doc/vector'
import { pathBounds, transformPath } from '../geom/path'
import { builtinBrushes } from '../vector/brushLibrary'
import { strokeAsPath } from '../vector/outline'
import { swatchIn } from './colour'
import { documents, newId, selectedIds } from './documents'
import { notify } from './notices'
import { Listeners } from '../lib/listeners'

/** The brushes to choose from in a document: its own, then the built-in ones it hasn't changed. */
export function brushChoices(doc: Doc): { brush: VectorBrush; builtin: boolean }[] {
  const own = doc.vectorBrushes ?? []
  const ids = new Set(own.map((b) => b.id))
  return [...own.map((brush) => ({ brush, builtin: false })), ...builtinBrushes(doc.mode).filter((b) => !ids.has(b.id)).map((brush) => ({ brush, builtin: true }))]
}

/** A brush by id: the document's, or a built-in one. */
export const brushById = (doc: Doc, id: string): VectorBrush | null => brushChoices(doc).find((c) => c.brush.id === id)?.brush ?? null

/** The index of a node's topmost stroke that's on, or -1. */
export function topStrokeIndex(items: AppearanceItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'stroke' && items[i].enabled) return i
  return -1
}

const appearanceOf = (n: DocNode): AppearanceItem[] => (n.props as { appearance: AppearanceItem[] }).appearance

/** The brush of the key layer's top stroke, if it has one. */
export function selectedBrushId(): string | null {
  const d = documents().active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : undefined
  if (!stylable(n)) return null
  const items = appearanceOf(n)
  const i = topStrokeIndex(items)
  return i >= 0 ? ((items[i] as StrokeItem).brush?.id ?? null) : null
}

/** The selected shapes and text a brush goes on. */
function targets(): { d: NonNullable<ReturnType<ReturnType<typeof documents>['active']>>; ids: NodeId[] } | null {
  const d = documents().active()
  if (!d) return null
  const doc = d.history.present
  const ids = selectedIds(d).filter((id) => stylable(doc.nodes[id]))
  if (!ids.length) {
    notify('info', 'Select shapes or text to stroke with the brush.')
    return null
  }
  return { d, ids }
}

/** The selected shapes' top strokes drawn with a brush; a shape with no stroke gets one (the foreground colour, 4 px). */
export function applyBrush(id: string) {
  const t = targets()
  if (!t) return
  const doc = t.d.history.present
  const brush = brushById(doc, id)
  if (!brush) return
  const fg = swatchIn(doc, 'fg') ?? (doc.mode === 'cmyk' ? [0, 0, 0, 1] : doc.mode === 'gray' ? [0] : [0, 0, 0])
  documents().commit(
    (x) =>
      t.ids.reduce((y, nid) => {
        const n = y.nodes[nid]
        if (!stylable(n)) return y
        const items = appearanceOf(n)
        const i = topStrokeIndex(items)
        const next: AppearanceItem[] = i >= 0 ? items.map((it, j) => (j === i ? { ...(it as StrokeItem), brush } : it)) : [...items, { ...strokeItem(solid(fg), 4), brush }]
        return setAppearance(y, nid, next)
      }, x),
    { key: t.d.key, label: `Apply ${brush.name}` },
  )
}

/** The brush taken off the selected shapes' top strokes: plain strokes again. */
export function removeBrushStroke() {
  const t = targets()
  if (!t) return
  documents().commit(
    (x) =>
      t.ids.reduce((y, nid) => {
        const n = y.nodes[nid]
        if (!stylable(n)) return y
        const items = appearanceOf(n)
        if (!items.some((it) => it.kind === 'stroke' && it.brush)) return y
        return setAppearance(
          y,
          nid,
          items.map((it) => {
            if (it.kind !== 'stroke' || !it.brush) return it
            const { brush: _b, ...rest } = it
            return rest
          }),
        )
      }, x),
    { key: t.d.key, label: 'Remove Brush Stroke' },
  )
}

/** Whether any selected shape's stroke has a brush, for Remove Brush Stroke. */
export function hasBrushStroke(): boolean {
  const d = documents().active()
  if (!d) return false
  const doc = d.history.present
  return selectedIds(d).some((id) => {
    const n = doc.nodes[id]
    return stylable(n) && appearanceOf(n).some((it) => it.kind === 'stroke' && !!it.brush)
  })
}

// --- artwork from the selection -----------------------------------------------------------------

/**
 * The selected shapes as brush artwork, in the document's units, bottom
 * to top: each fill a part in its paint, each plain stroke its outline in
 * its paint. Null (and said) when nothing selected has any.
 */
export function artFromSelection(): BrushArt | null {
  const d = documents().active()
  if (!d) return null
  const doc = d.history.present
  const chosen = new Set(selectedIds(d))
  const parts: BrushPart[] = []
  // layerRows is top first; artwork is painted bottom first.
  for (const { node } of [...layerRows(doc)].reverse()) {
    if (!chosen.has(node.id) || node.kind !== 'vector' || !node.visible) continue
    const path = geometryPath(node.props.geometry)
    if (!path.subpaths.length) continue
    for (const it of appearanceIn(node.props.appearance, doc.mode)) {
      if (!it.enabled) continue
      if (it.kind === 'fill') parts.push({ path: transformPath(path, node.transform), paint: it.paint })
      else if (it.width > 0 && !it.brush) parts.push({ path: transformPath(strokeAsPath(path, it), node.transform), paint: it.paint })
    }
  }
  const art = artFrom(parts, (p) => pathBounds(p))
  if (!art) notify('info', 'Select shapes with fills or strokes: they become the brush’s artwork.')
  return art
}

const KIND_NAME = { art: 'Art Brush', scatter: 'Scatter Brush', pattern: 'Pattern Brush' }

/** A fresh name for a brush of a kind: "Art Brush 2". */
function freshName(doc: Doc, kind: VectorBrush['kind']): string {
  const used = new Set(brushChoices(doc).map((c) => c.brush.name))
  let i = 1
  while (used.has(`${KIND_NAME[kind]} ${i}`)) i++
  return `${KIND_NAME[kind]} ${i}`
}

/** A new brush of a kind from the selected shapes, added to the document and opened in Brush Options. */
export function newBrushFromSelection(kind: VectorBrush['kind']) {
  const d = documents().active()
  if (!d) return
  const art = artFromSelection()
  if (!art) return
  const doc = d.history.present
  const base = { id: newId('vb'), name: freshName(doc, kind), colorize: 'none' as const }
  const flips = { flipAlong: false, flipAcross: false }
  const brush: VectorBrush =
    kind === 'art'
      ? { ...base, kind, art, fit: 'stretch', guides: [0.25, 0.25], scale: 1, ...flips }
      : kind === 'scatter'
        ? { ...base, kind, art, size: [1, 1], spacing: [1.5, 1.5], scatter: [0, 0], rotation: [0, 0], relative: 'path', seed: Math.floor(Math.random() * 1e6) }
        : { ...base, kind, side: art, fit: 'stretch', scale: 1, ...flips }
  documents().commit((x) => addVectorBrush(x, brush), { key: d.key, label: 'New Brush' })
  brushOptions.set({ key: d.key, id: brush.id })
}

// --- the library -----------------------------------------------------------------------------------

/** Brush Options' OK: the brush kept in the document (a built-in one too, under its id), and the strokes using it changed if asked. */
export function updateBrush(brush: VectorBrush, restroke: boolean) {
  const d = documents().active()
  if (!d) return
  documents().commit((x) => (restroke ? restrokeWith(addVectorBrush(x, brush), brush) : addVectorBrush(x, brush)), { key: d.key, label: 'Brush Options' })
}

export function deleteBrush(id: string) {
  const d = documents().active()
  if (d) documents().commit((x) => removeVectorBrush(x, id), { key: d.key, label: 'Delete Brush' })
}

/** A copy of a brush in the document, under a name of its own. */
export function duplicateBrush(id: string) {
  const d = documents().active()
  if (!d) return
  const doc = d.history.present
  const b = brushById(doc, id)
  if (!b) return
  const used = new Set(brushChoices(doc).map((c) => c.brush.name))
  let name = `${b.name} copy`
  for (let i = 2; used.has(name); i++) name = `${b.name} copy ${i}`
  documents().commit((x) => addVectorBrush(x, { ...b, id: newId('vb'), name }), { key: d.key, label: 'Duplicate Brush' })
}

export function renameBrush(id: string, name: string) {
  const d = documents().active()
  const b = d ? brushById(d.history.present, id) : null
  if (d && b && name.trim()) documents().commit((x) => addVectorBrush(x, { ...b, name: name.trim().slice(0, 80) }), { key: d.key, label: 'Rename Brush' })
}

/** Brush Options, open for one brush: which. The dialog (ui/brushOptions.tsx) follows this. */
export interface BrushEditing {
  key: string
  id: string
}
let editing: BrushEditing | null = null
const editingChanges = new Listeners()
export const brushOptions = {
  get: () => editing,
  set(e: BrushEditing | null) {
    editing = e
    editingChanges.emit()
  },
  subscribe: (fn: () => void) => editingChanges.subscribe(fn),
}

/** Brush Options for the key layer's brush, or says there's none. */
export function openSelectedBrushOptions() {
  const d = documents().active()
  const id = selectedBrushId()
  if (!d || !id) return notify('info', 'Select a shape stroked with a brush, or double-click a brush in the Vector Brushes panel.')
  brushOptions.set({ key: d.key, id })
}
