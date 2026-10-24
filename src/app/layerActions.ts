/**
 * Working with many layers at once, from the Layers panel and the Layer
 * menu: grouping and ungrouping what's selected, selecting a group's
 * layers, folding every group or all but one, the group new layers are
 * pinned to (Draw Into), colour labels, moving and copying several layers
 * into a group, renaming several, and several shapes made one.
 *
 * Each action leaves its result selected, so the next can follow: the new
 * group after Group, its layers after Ungroup, the copies after a copy.
 */
import { combineIntoOne, groupLayers, moveNodes, renameMany, setTag, ungroupLayers } from '../doc/edit'
import { fragmentOf, pasteFragment } from '../doc/fragment'
import { freshName, layerRows, outermost, placeOf } from '../doc/tree'
import type { ColourTag, Doc, NodeId } from '../doc/types'
import type { PathData } from '../geom/path'
import { docPathOf } from '../vector/shape'
import { copyName } from './clipboard'
import { documents, newId, selectedIds, type OpenDoc } from './documents'
import { notify } from './notices'

const active = () => documents().active()
/** The selected layers, without those inside another of them, bottom first. */
const chosen = (d: OpenDoc) => outermost(d.history.present, selectedIds(d))
const isGroup = (doc: Doc, id: NodeId | null | undefined) => {
  const n = id ? doc.nodes[id] : null
  return n?.kind === 'group' && !n.props.artboard && id !== doc.root
}

// --- grouping ------------------------------------------------------------------------------------

/** Group Layers (Ctrl+G): the selected layers into a new group in the top one's place; the group is selected. */
export function groupSelected() {
  const d = active()
  if (!d) return
  const ids = chosen(d)
  if (!ids.length) return
  const id = newId('n')
  documents().commit((x) => groupLayers(x, ids, id, freshName(x, 'Group')), { key: d.key, label: 'Group Layers' })
  if (documents().get(d.key)?.history.present.nodes[id]) documents().select(id, d.key)
}

/** Whether Ungroup has a group to let out among what's selected. */
export const canUngroup = (d: OpenDoc | null | undefined) => !!d && selectedIds(d).some((id) => isGroup(d.history.present, id))

/** Ungroup Layers (Ctrl+Shift+G): each selected group's layers let out in its place; they're selected. */
export function ungroupSelected() {
  const d = active()
  if (!d) return
  const doc = d.history.present
  const groups = selectedIds(d).filter((id) => isGroup(doc, id))
  if (!groups.length) return
  const freed = groups.flatMap((g) => doc.nodes[g].children ?? [])
  documents().commit((x) => ungroupLayers(x, groups), { key: d.key, label: 'Ungroup Layers' })
  if (freed.length) documents().selectMany(freed, freed[freed.length - 1], d.key)
}

/**
 * The group Select All in Group works in: the selected group itself, or
 * the group holding the selected layer. Null at the top level.
 */
export function groupFor(d: OpenDoc | null | undefined): NodeId | null {
  if (!d?.selected) return null
  const doc = d.history.present
  if (isGroup(doc, d.selected)) return d.selected
  const place = placeOf(doc, d.selected)
  return place?.slot === 'children' && place.parent !== doc.root && doc.nodes[place.parent]?.kind === 'group' ? place.parent : null
}

/** Select All in Group: every layer in the group (opened, so they show), ready to drag, merge or rasterize together. */
export function selectInGroup(group = groupFor(active())) {
  const d = active()
  if (!d || !group) return
  const kids = d.history.present.nodes[group]?.children ?? []
  if (!kids.length) return notify('info', `“${d.history.present.nodes[group].name}” is empty.`)
  if (d.folded.has(group)) documents().toggleFolded(group, d.key)
  documents().selectMany([...kids], kids[kids.length - 1], d.key)
}

// --- folding -------------------------------------------------------------------------------------

/** Every layer the panel can fold: those with layers in them. */
const foldable = (doc: Doc) => layerRows(doc).filter((r) => r.node.children?.length).map((r) => r.node.id)

/** Collapse All Groups, or Expand All Groups. */
export function foldAll(fold: boolean) {
  const d = active()
  if (d) documents().setFolded(fold ? foldable(d.history.present) : [], d.key)
}

/** Collapse Others: every group folded but those holding (or being) a selected layer. */
export function foldOthers() {
  const d = active()
  if (!d) return
  const doc = d.history.present
  const open = new Set<NodeId>()
  for (const id of selectedIds(d)) for (let at: NodeId | undefined = id; at && at !== doc.root; at = placeOf(doc, at)?.parent) open.add(at)
  documents().setFolded(
    foldable(doc).filter((id) => !open.has(id)),
    d.key,
  )
}

// --- Draw Into -----------------------------------------------------------------------------------

/** The group Draw Into would pin or unpin: the selected group. */
export const drawIntoTarget = (d: OpenDoc | null | undefined) => (d && isGroup(d.history.present, d.selected) ? d.selected : null)

/** Draw Into: new layers go into the selected group, whatever's selected later; again (or on the pin) to unpin. */
export function toggleDrawInto(id = drawIntoTarget(active())) {
  const d = active()
  if (!d) return
  if (!id || d.drawInto === id) return documents().setDrawInto(null, d.key)
  documents().setDrawInto(id, d.key)
}

/** The group new layers are pinned to, if it's still in the document. */
export const pinnedGroup = (d: OpenDoc | null | undefined) => (d?.drawInto && isGroup(d.history.present, d.drawInto) ? d.drawInto : null)

// --- colour labels -------------------------------------------------------------------------------

/** The key layer's colour label, for the menu's tick. */
export const tagOf = (d: OpenDoc | null | undefined) => (d?.selected ? (d.history.present.nodes[d.selected]?.tag ?? null) : null)

/** A colour label (or none) on every selected layer, as one step. */
export function tagSelected(tag: ColourTag | null) {
  const d = active()
  if (!d) return
  const ids = selectedIds(d)
  documents().commit((x) => ids.reduce((y, id) => setTag(y, id, tag), x), { key: d.key, label: tag ? 'Colour Label' : 'No Colour Label' })
}

// --- moving and copying into a group --------------------------------------------------------------

/** The groups the selected layers could move into, top first, each with the names of the groups holding it. */
export function groupChoices(d: OpenDoc): { id: NodeId; name: string; path: string }[] {
  const doc = d.history.present
  const moving = new Set(chosen(d))
  const out: { id: NodeId; name: string; path: string }[] = []
  const walk = (id: NodeId, trail: string[]) => {
    for (const c of [...(doc.nodes[id].children ?? [])].reverse()) {
      const n = doc.nodes[c]
      // Not into a layer being moved, nor anything inside one.
      if (n?.kind !== 'group' || moving.has(c)) continue
      out.push({ id: c, name: n.name, path: trail.join(' / ') })
      walk(c, [...trail, n.name])
    }
  }
  walk(doc.root, [])
  return out
}

/** Move to Group: the selected layers into `group` (the root for the top level), at its top; they stay selected. */
export function moveSelectedTo(group: NodeId) {
  const d = active()
  if (!d) return
  const ids = chosen(d)
  const doc = d.history.present
  const index = (doc.nodes[group]?.children ?? []).filter((c) => !ids.includes(c)).length
  documents().commit((x) => moveNodes(x, ids, group, index), { key: d.key, label: ids.length > 1 ? 'Move Layers' : 'Move Layer' })
  if (documents().get(d.key)?.history.present === doc) notify('info', `Those layers can’t go into “${doc.nodes[group]?.name ?? 'that group'}”.`)
}

/** Alt-drag in the Layers panel: copies of `ids` into `parent` at `index`, each named "… copy"; the copies are selected. */
export function copyLayersTo(ids: NodeId[], parent: NodeId, index: number) {
  const d = active()
  if (!d) return
  const frag = fragmentOf(d.history.present, ids, newId('r'))
  let made: NodeId[] = []
  documents().commit(
    (x) => {
      const r = pasteFragment(x, frag, { parent, index, newId, rename: (n) => copyName(x, n) })
      made = r.ids
      return r.doc
    },
    { key: d.key, label: ids.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer' },
  )
  if (made.length) documents().selectMany(made, made[made.length - 1], d.key)
}

// --- renaming several ----------------------------------------------------------------------------

export type RenameRule = { kind: 'number'; pattern: string; start: number; fromTop: boolean } | { kind: 'replace'; find: string; replace: string; matchCase: boolean }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The names Rename Layers would give the selected layers, in panel order
 * (top first): numbered from a pattern, where each run of # is the number
 * in at least that many digits ("Window ##" → "Window 01"; a pattern
 * without # gets " #" after it), counted from the bottom unless `fromTop`;
 * or with every `find` replaced.
 */
export function renamesFor(d: OpenDoc, rule: RenameRule): { id: NodeId; from: string; to: string }[] {
  const doc = d.history.present
  const picked = new Set(selectedIds(d))
  const rows = layerRows(doc)
    .filter((r) => picked.has(r.node.id))
    .map((r) => r.node)
  if (rule.kind === 'replace') {
    const re = rule.find ? new RegExp(escapeRe(rule.find), rule.matchCase ? 'g' : 'gi') : null
    return rows.map((n) => ({ id: n.id, from: n.name, to: re ? n.name.replace(re, () => rule.replace) : n.name }))
  }
  const pattern = rule.pattern.includes('#') ? rule.pattern : `${rule.pattern.trimEnd()} #`
  const order = rule.fromTop ? rows : [...rows].reverse()
  const named = new Map(order.map((n, i) => [n.id, pattern.replace(/#+/g, (run) => String(rule.start + i).padStart(run.length, '0'))]))
  return rows.map((n) => ({ id: n.id, from: n.name, to: named.get(n.id)! }))
}

/** Rename Layers: the selected layers renamed by `rule`, as one step. */
export function renameSelected(rule: RenameRule) {
  const d = active()
  if (!d) return
  const names = new Map(
    renamesFor(d, rule)
      .filter((r) => r.to.trim() && r.to !== r.from)
      .map((r) => [r.id, r.to]),
  )
  if (names.size) documents().commit((x) => renameMany(x, names), { key: d.key, label: 'Rename Layers' })
}

// --- several shapes, one shape -------------------------------------------------------------------

/** The selected shapes Combine into One Shape would join, bottom first. */
const shapesOf = (d: OpenDoc) => chosen(d).filter((id) => ['vector', 'boolean'].includes(d.history.present.nodes[id]?.kind))

export const canCombineOne = (d: OpenDoc | null | undefined) => !!d && shapesOf(d).length >= 2

/**
 * Combine into One Shape: the selected shapes made one shape holding all
 * their paths, each part as it was (an open stroke stays open), with the
 * top one's look: a hundred Pencil strokes as one editable layer. It's
 * selected.
 */
export function combineSelected() {
  const d = active()
  if (!d) return
  const ids = shapesOf(d)
  if (ids.length < 2) return notify('info', 'Select two or more shapes to combine.')
  const doc = d.history.present
  const path: PathData = { fillRule: 'nonzero', subpaths: ids.flatMap((id) => docPathOf((k) => doc.nodes[k], doc.nodes[id])?.subpaths ?? []) }
  const top = ids[ids.length - 1]
  documents().commit((x) => combineIntoOne(x, ids, path), { key: d.key, label: 'Combine into One Shape' })
  documents().select(top, d.key)
}
