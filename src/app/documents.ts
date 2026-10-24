/**
 * The open documents: each one's history, the file it belongs to, whether
 * it has unsaved changes, and its view state (selection, folded layers).
 *
 * A store outside React, read through useSyncExternalStore, for three
 * reasons. The autosave journal subscribes to it without being a
 * component. Commands act on it without being inside a render. And
 * deciding whether to coalesce an edit happens here, once, instead of in a
 * setState updater that StrictMode runs twice (Fresyn hit that).
 *
 * Every edit to a document goes through `commit`. That is the one edit
 * path: history, step names, autosave and the dirty flag all follow from
 * it, so no feature has to remember them.
 */
import { describeEdit } from '../doc/describe'
import { commit as commitHistory, initHistory, jumpTo, redo, trimPast, undo, type History } from '../doc/history'
import type { Doc, DocNode, NodeId } from '../doc/types'
import { neighbourOf, noteNumbers, placeOf, type NewPlaceOptions } from '../doc/tree'
import type { FileRef } from '../io/journal'
import { Listeners } from '../lib/listeners'

export type MaskTarget = false | 'pixel' | 'vector'

export interface OpenDoc {
  /** Stable for as long as the document is open, and its name in the journal. */
  key: string
  history: History<Doc>
  /** The state that matches the file on disk; null if it has never been saved. */
  saved: Doc | null
  file: FileRef | null
  selected: NodeId | null
  /**
   * More layers selected with it (Ctrl- or Shift-click in the Layers panel),
   * for moving, aligning and distributing together. `selected` is the key
   * layer: the one the Properties panel shows and single-layer commands act
   * on, and what Align to Key Layer lines the rest up with.
   */
  others: readonly NodeId[]
  folded: ReadonlySet<NodeId>
  /** Groups the panel opened by itself, because a new layer went into them while they were folded. */
  autoOpened: ReadonlySet<NodeId>
  /** Groups folded again by hand after that: folded on purpose, they stay folded when layers go in. */
  keepFolded: ReadonlySet<NodeId>
  /** The group new layers go into whatever's selected (Layer → Draw Into), or none. View state, not history. */
  drawInto: NodeId | null
  /**
   * Painting and pixel commands go to the selected layer's mask rather than
   * its pixels: its mask thumbnail was clicked, as in Photoshop.
   */
  /** Which of the layer's masks is being edited, if one is: its pixel mask or its vector mask. */
  maskTarget: MaskTarget
  /** Quick Mask: the selection shown as a red tint, and painted with the brushes. */
  quickMask: boolean
  /** The selection Deselect last let go of, for Reselect. Not history. */
  lastSelection: string | null
  /**
   * For a smart object's contents opened on their own (Edit Contents): the
   * document holding it and its node. Save puts the contents back there.
   */
  parent: { key: string; node: NodeId } | null
  /**
   * For a symbol opened to edit (Edit Symbol): the document it's in and its
   * id. What's done here goes back there as it's done (app/symbols.ts).
   */
  symbolOf: { key: string; symbol: string } | null
  /**
   * For a pattern's tile opened to edit (pattern editing mode): the document
   * it's in and its id. Its repeat goes back there as it's drawn (app/patternEdit.ts).
   */
  patternOf: { key: string; pattern: string } | null
}

export interface DocsState {
  docs: OpenDoc[]
  active: string | null
}

/** Edits under the same key this close together are one step: one drag of a slider is one undo. */
const COALESCE_MS = 600

export const isDirty = (d: OpenDoc) => d.history.present !== d.saved

/** A fresh random id, short and safe in a file name. */
export function newId(prefix = ''): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return prefix + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12)
}

class DocumentStore {
  private state: DocsState = { docs: [], active: null }
  private changes = new Listeners()
  private lastCommit: { doc: string; key: string; at: number } | null = null

  getState = () => this.state
  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  private set(next: DocsState) {
    if (next === this.state) return
    this.state = next
    this.changes.emit()
  }

  private update(key: string, fn: (d: OpenDoc) => OpenDoc) {
    const i = this.state.docs.findIndex((d) => d.key === key)
    if (i < 0) return
    const before = this.state.docs[i]
    const after = fn(before)
    if (after === before) return
    const docs = [...this.state.docs]
    docs[i] = after
    this.set({ ...this.state, docs })
  }

  active(): OpenDoc | null {
    return this.state.docs.find((d) => d.key === this.state.active) ?? null
  }

  get(key: string): OpenDoc | null {
    return this.state.docs.find((d) => d.key === key) ?? null
  }

  /**
   * Adds a document and brings it to the front. `saved` says whether it
   * matches its file as it arrives: a file just opened does, a new
   * document doesn't, and a restored one says which it was.
   */
  add(o: { key?: string; doc: Doc; file: FileRef | null; saved: boolean; folded?: NodeId[]; drawInto?: NodeId | null; label?: string; parent?: OpenDoc['parent']; symbolOf?: OpenDoc['symbolOf']; patternOf?: OpenDoc['patternOf'] }): string {
    const key = o.key ?? newId('d')
    const entry: OpenDoc = {
      key,
      history: initHistory(o.doc, o.label),
      saved: o.saved ? o.doc : null,
      file: o.file,
      selected: null,
      others: [],
      folded: new Set(o.folded ?? []),
      autoOpened: new Set(),
      keepFolded: new Set(),
      drawInto: o.drawInto ?? null,
      maskTarget: false,
      quickMask: false,
      lastSelection: null,
      parent: o.parent ?? null,
      symbolOf: o.symbolOf ?? null,
      patternOf: o.patternOf ?? null,
    }
    this.set({ docs: [...this.state.docs, entry], active: key })
    return key
  }

  activate(key: string) {
    if (this.state.active === key || !this.get(key)) return
    this.set({ ...this.state, active: key })
  }

  /** Removes a document. The one to its left (or right) comes to the front. */
  remove(key: string) {
    const i = this.state.docs.findIndex((d) => d.key === key)
    if (i < 0) return
    const docs = this.state.docs.filter((d) => d.key !== key)
    const active = this.state.active === key ? (docs[Math.max(0, i - 1)]?.key ?? null) : this.state.active
    this.set({ docs, active })
  }

  /**
   * The one edit path. `fn` gets the active document and returns the next
   * one; if it returns the same object nothing happens at all. Edits that
   * share a `coalesce` key within COALESCE_MS fold into one history step.
   * `label` names the step; otherwise describeEdit works it out.
   */
  commit(fn: (doc: Doc) => Doc, o: { coalesce?: string; label?: string; key?: string } = {}) {
    const key = o.key ?? this.state.active
    if (!key) return
    const now = Date.now()
    const last = this.lastCommit
    const fold = !!o.coalesce && !!last && last.doc === key && last.key === o.coalesce && now - last.at < COALESCE_MS
    this.update(key, (d) => {
      const made = fn(d.history.present)
      if (made === d.history.present) return d
      // New layers in a labelled group take its colour label, and the numbers their names took aren't given again.
      const next = noteNumbers(d.history.present, adoptTags(d.history.present, made))
      const label = o.label ?? describeEdit(d.history.present, next)
      // A selected layer that the edit removed is no longer selected; a folded group a new layer went into opens.
      return { ...d, history: commitHistory(d.history, next, fold, fold ? undefined : label), ...stillSelected(d, d.history.present, next), ...revealNew(d, d.history.present, next) }
    })
    this.lastCommit = o.coalesce ? { doc: key, key: o.coalesce, at: now } : null
  }

  private step(fn: (h: History<Doc>) => History<Doc>, key = this.state.active) {
    if (!key) return
    this.lastCommit = null
    this.update(key, (d) => {
      const history = fn(d.history)
      if (history === d.history) return d
      return { ...d, history, ...stillSelected(d, d.history.present, history.present) }
    })
  }

  undo(key?: string) {
    this.step(undo, key)
  }
  redo(key?: string) {
    this.step(redo, key)
  }
  jumpTo(index: number, key?: string) {
    this.step((h) => jumpTo(h, index), key)
  }

  /** Forgets all but the newest `keep` steps back: history past its memory cap. */
  trimHistory(key: string, keep: number) {
    this.update(key, (d) => {
      const history = trimPast(d.history, keep)
      return history === d.history ? d : { ...d, history }
    })
  }

  /** Nothing to save: a symbol being edited, whose changes are already in its document. */
  markClean(key: string) {
    this.update(key, (d) => (d.saved === d.history.present ? d : { ...d, saved: d.history.present }))
  }

  /** After a save: the file now matches this state. */
  markSaved(key: string, doc: Doc, file: FileRef) {
    this.update(key, (d) => ({ ...d, saved: doc, file }))
  }

  /** Selects a layer; `mask` says which of its masks (rather than the layer itself) is what gets edited: `true` is its pixel mask. */
  select(id: NodeId | null, key = this.state.active, target: MaskTarget | boolean = false) {
    if (!key) return
    const mask: MaskTarget = target === true ? 'pixel' : target
    this.update(key, (d) => (d.selected === id && d.maskTarget === mask && !d.others.length ? d : { ...d, selected: id, others: [], maskTarget: mask }))
  }

  /**
   * Several layers selected: `ids` (in any order), with `key` as the key
   * layer (the last of them if it isn't one).
   */
  selectMany(ids: NodeId[], key: NodeId | null = ids[ids.length - 1] ?? null, docKey = this.state.active) {
    if (!docKey) return
    const all = [...new Set(ids)]
    const primary = key && all.includes(key) ? key : (all[all.length - 1] ?? null)
    const others = all.filter((x) => x !== primary)
    this.update(docKey, (d) =>
      d.selected === primary && d.others.length === others.length && others.every((x, i) => d.others[i] === x) ? d : { ...d, selected: primary, others, maskTarget: d.selected === primary ? d.maskTarget : false },
    )
  }

  /** Ctrl-click in the Layers panel: a layer added to what's selected (and made the key layer), or taken out. */
  toggleSelected(id: NodeId, key = this.state.active) {
    const d = key ? this.get(key) : null
    if (!d) return
    const all = selectedIds(d)
    if (all.includes(id)) {
      const rest = all.filter((x) => x !== id)
      this.selectMany(rest, d.selected === id ? (rest[rest.length - 1] ?? null) : d.selected, key)
    } else this.selectMany([...all, id], id, key)
  }

  /** View state that isn't history: Quick Mask, the mask target, Reselect's selection. */
  setEditState(patch: Partial<Pick<OpenDoc, 'maskTarget' | 'quickMask' | 'lastSelection'>>, key = this.state.active) {
    if (!key) return
    this.update(key, (d) => ((Object.keys(patch) as (keyof typeof patch)[]).every((k) => d[k] === patch[k]) ? d : { ...d, ...patch }))
  }

  /** Folds or unfolds a layer by hand. A group the panel opened by itself and folded again here is folded on purpose, and stays so. */
  toggleFolded(id: NodeId, key = this.state.active) {
    if (!key) return
    this.update(key, (d) => {
      const folded = new Set(d.folded)
      const keepFolded = new Set(d.keepFolded)
      if (folded.delete(id)) keepFolded.delete(id)
      else {
        folded.add(id)
        if (d.autoOpened.has(id)) keepFolded.add(id)
      }
      return { ...d, folded, keepFolded }
    })
  }

  /** Every fold at once (Collapse All, Expand All, Collapse Others): `folded` is the new set. */
  setFolded(folded: Iterable<NodeId>, key = this.state.active) {
    if (!key) return
    this.update(key, (d) => ({ ...d, folded: new Set(folded), keepFolded: new Set() }))
  }

  /** Pins a group for new layers to go into (Draw Into), or unpins with null. */
  setDrawInto(id: NodeId | null, key = this.state.active) {
    if (!key) return
    this.update(key, (d) => (d.drawInto === id ? d : { ...d, drawInto: id }))
  }
}

/** What, besides the key layer, decides where a document's new layers go (doc/tree.ts' whereNew): the pinned group and the other layers selected. */
export const placing = (d: OpenDoc): NewPlaceOptions => ({ pinned: d.drawInto, others: d.others })

/** The layers `next` has that `prev` didn't, among the panel's rows. */
function newLayers(prev: Doc, next: Doc): NodeId[] {
  if (prev.nodes === next.nodes) return []
  const out: NodeId[] = []
  for (const id in next.nodes) if (!prev.nodes[id] && placeOf(next, id)?.slot === 'children') out.push(id)
  return out
}

/** New layers made inside a group with a colour label, and without one of their own, take the group's. */
function adoptTags(prev: Doc, next: Doc): Doc {
  let nodes: Record<NodeId, DocNode> | null = null
  for (const id of newLayers(prev, next)) {
    const n = next.nodes[id]
    const parent = next.nodes[placeOf(next, id)!.parent]
    if (n.tag || !parent?.tag || parent.id === next.root) continue
    nodes ??= { ...next.nodes }
    nodes[id] = { ...n, tag: parent.tag } as DocNode
  }
  return nodes ? { ...next, nodes } : next
}

/**
 * Folded groups a new layer went into open, so it doesn't land out of
 * sight, unless they were folded again by hand after opening that way.
 */
function revealNew(d: OpenDoc, prev: Doc, next: Doc): Partial<OpenDoc> {
  if (!d.folded.size) return {}
  let folded: Set<NodeId> | null = null
  let autoOpened: Set<NodeId> | null = null
  for (const id of newLayers(prev, next))
    for (let at = placeOf(next, id)?.parent; at && at !== next.root; at = placeOf(next, at)?.parent) {
      if (!d.folded.has(at) || d.keepFolded.has(at)) continue
      ;(folded ??= new Set(d.folded)).delete(at)
      ;(autoOpened ??= new Set(d.autoOpened)).add(at)
    }
  return folded ? { folded, autoOpened: autoOpened! } : {}
}

/** Every selected layer: the key layer first, then the others. */
export const selectedIds = (d: OpenDoc): NodeId[] => (d.selected ? [d.selected, ...d.others.filter((x) => x !== d.selected)] : [...d.others])

/**
 * What's still selected once `next` follows `prev`: layers that are gone are
 * let go. When the key layer goes (deleted, or undone away) and none of the
 * others is left to take its place, the layer below it is selected, as in
 * Photoshop, so Delete pressed again deletes the next one.
 */
function stillSelected(d: OpenDoc, prev: Doc, next: Doc): Pick<OpenDoc, 'selected' | 'others' | 'maskTarget'> {
  const others = d.others.filter((x) => !!next.nodes[x])
  const kept = { selected: d.selected, others: others.length === d.others.length ? d.others : others, maskTarget: d.maskTarget }
  if (!d.selected || next.nodes[d.selected]) return kept
  if (others.length) return { selected: others[others.length - 1], others: others.slice(0, -1), maskTarget: false }
  // Only a layer the panel lists: not a mask, an effect or the root.
  const listed = (id: NodeId) => {
    const n = next.nodes[id]
    return !!n && id !== next.root && placeOf(next, id)?.slot === 'children'
  }
  // Every selected layer went: the nearest below the key layer that's still there (passing over those deleted with it).
  return { selected: neighbourOf(prev, d.selected, listed), others: [], maskTarget: false }
}

let store: DocumentStore | null = null
/** The page's one document store. */
export const documents = () => (store ??= new DocumentStore())
