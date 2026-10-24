/**
 * Symbols on the page: New Symbol from the selected layers, placing one,
 * editing one, Break Link, Replace, and the Symbols panel's list. The model
 * is doc/symbols.ts.
 *
 * Edit Symbol opens the symbol's contents in a tab of their own, with every
 * tool. What's done there goes into the document as it's done, so every
 * instance follows at once: one step there ("Edit Symbol") for each run of
 * edits, undone with the rest of the document's history; undoing in the tab
 * goes back too. Closing the tab asks nothing: there's nothing to save.
 */
import { artboardRect, isArtboard } from '../doc/artboards'
import { breakLink, deleteSymbol, duplicateSymbol, instancesOf, makeSymbol, nextSymbolName, placeSymbol, renameSymbol, replaceSymbol, setSymbolContent, symbolById } from '../doc/symbols'
import { placeOf, whereNew } from '../doc/tree'
import type { Doc, NodeId } from '../doc/types'
import { layersBox } from './bounds'
import { documents, newId, placing, selectedIds, type OpenDoc } from './documents'
import { notify } from './notices'
import { views } from './views'

const store = () => documents()

/** The selected layers with none inside another selected one, bottom first. */
function picks(doc: Doc, ids: NodeId[]): NodeId[] {
  const set = new Set(ids)
  const top = ids.filter((id) => {
    let p = placeOf(doc, id)
    while (p) {
      if (set.has(p.parent)) return false
      p = placeOf(doc, p.parent)
    }
    return true
  })
  // Bottom first among their siblings, as the tree draws them.
  return top.sort((a, b) => (placeOf(doc, a)?.index ?? 0) - (placeOf(doc, b)?.index ?? 0))
}

/** Layer → New Symbol (F8, as Illustrator's): the selected layers become a symbol, an instance in their place. */
export async function newSymbolFromSelection(): Promise<string | null> {
  const d = store().active()
  if (!d) return null
  const doc = d.history.present
  const ids = picks(doc, selectedIds(d)).filter((id) => !isArtboard(doc.nodes[id]) && doc.nodes[id]?.kind !== 'adjustment')
  if (!ids.length) {
    notify('info', 'Select the layers to make a symbol of first. Artboards can’t be part of one.')
    return null
  }
  // All from one place: a symbol replaces them where the topmost was.
  const parent = placeOf(doc, ids[0])?.parent
  if (ids.some((id) => placeOf(doc, id)?.parent !== parent)) {
    notify('info', 'The layers for a symbol need to be in the same group or artboard.')
    return null
  }
  const box = await layersBox(doc, ids)
  if (!box) {
    notify('info', 'Those layers have nothing in them to make a symbol of.')
    return null
  }
  const symbolId = newId('sym')
  const instanceId = newId('n')
  const name = nextSymbolName(doc)
  store().commit((x) => makeSymbol(x, ids, box, { symbolId, instanceId, rootId: newId('root'), name }), { key: d.key, label: 'New Symbol' })
  store().select(instanceId, d.key)
  return symbolId
}

/** An instance of a symbol, in the middle of the view (or at a point), in the artboard there or above the selection. */
export function placeInstance(symbolId: string, at?: [number, number]): NodeId | null {
  const d = store().active()
  if (!d || !symbolById(d.history.present, symbolId)) return null
  const v = views().front()
  const doc = d.history.present
  let [cx, cy] = at ?? (v ? [v.cx, v.cy] : [doc.width / 2, doc.height / 2])
  const { parent, index } = whereNew(doc, d.selected, [cx, cy], placing(d))
  // Going onto an artboard the point isn't on (the middle of the view in a gap between them): its middle instead.
  const board = doc.nodes[parent]
  if (isArtboard(board)) {
    const [x0, y0, x1, y1] = artboardRect(board)
    if (cx < x0 || cx >= x1 || cy < y0 || cy >= y1) [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2]
  }
  const id = newId('n')
  store().commit((x) => placeSymbol(x, symbolId, id, parent, index, cx, cy), { key: d.key, label: 'Place Symbol' })
  store().select(id, d.key)
  return id
}

/** The symbol the selected instance shows, if an instance is selected. */
export function selectedSymbol(d: OpenDoc | null | undefined): string | null {
  const n = d?.selected ? d.history.present.nodes[d.selected] : null
  return n?.kind === 'symbol' ? n.props.symbol : null
}

/** Edit Symbol: its contents in a tab of their own, changes going back as they're made. */
export function editSymbol(symbolId: string) {
  const d = store().active()
  const s = d ? symbolById(d.history.present, symbolId) : null
  if (!d || !s) return
  const open = store()
    .getState()
    .docs.find((x) => x.symbolOf?.key === d.key && x.symbolOf.symbol === symbolId)
  if (open) return store().activate(open.key)
  const key = store().add({ doc: { ...s.content, name: s.name }, file: null, saved: true, symbolOf: { key: d.key, symbol: symbolId }, label: 'Edit Symbol' })
  pushed.set(key, store().get(key)!.history.present)
  sentContent.set(key, s.content)
}

/** What each symbol tab last sent back, so only a change is sent. */
const pushed = new Map<string, Doc>()
/** The contents the document was last given from each tab (renamed, it's a new object there). */
const sentContent = new Map<string, Doc>()

// A symbol's tab: each change (an edit, an undo, a redo) goes back into its document; and
// a change to the symbol there (undone there, say) comes into the tab, so the two agree.
store().subscribe(() => {
  for (const t of store().getState().docs) {
    if (!t.symbolOf) continue
    const owner = store().get(t.symbolOf.key)
    const symbol = t.symbolOf.symbol
    const there = owner ? symbolById(owner.history.present, symbol)?.content : undefined
    if (!owner || !there) continue
    const now = t.history.present
    const sent = pushed.get(t.key)
    if (sent === now) {
      // The tab as last sent: the document's copy changed on its own, so the tab takes it.
      if (there !== now && there !== sentContent.get(t.key)) {
        pushed.set(t.key, there)
        sentContent.set(t.key, there)
        store().commit(() => there, { key: t.key, label: 'Changed in its document' })
        store().markClean(t.key)
      }
      continue
    }
    pushed.set(t.key, now)
    sentContent.set(t.key, now)
    // The tab's name is the symbol's: renamed there, it's renamed here too.
    store().commit((x) => {
      const named = now.name && now.name !== symbolById(x, symbol)?.name ? renameSymbol(x, symbol, now.name) : x
      return setSymbolContent(named, symbol, now)
    }, { key: owner.key, label: 'Edit Symbol', coalesce: `symbol:${symbol}` })
    store().markClean(t.key)
  }
  for (const k of [...pushed.keys()]) if (!store().get(k)) {
    pushed.delete(k)
    sentContent.delete(k)
  }
})

/** Break Link to Symbol: the selected instances become groups of their own. */
export function breakLinkSelected() {
  const d = store().active()
  if (!d) return
  const doc = d.history.present
  const ids = selectedIds(d).filter((id) => doc.nodes[id]?.kind === 'symbol')
  if (!ids.length) return
  const last = ids[ids.length - 1]
  const at = placeOf(doc, last)
  store().commit((x) => ids.reduce((y, id) => breakLink(y, id, () => newId('n')), x), { key: d.key, label: 'Break Link to Symbol' })
  // The group that took the last instance's place.
  const now = store().get(d.key)?.history.present
  const group = at && now ? now.nodes[at.parent]?.children?.[at.index] : null
  if (group) store().select(group, d.key)
}

/** Replace Symbol: the selected instances show another symbol. */
export function replaceSelected(symbolId: string) {
  const d = store().active()
  if (!d) return
  const doc = d.history.present
  const ids = selectedIds(d).filter((id) => doc.nodes[id]?.kind === 'symbol')
  if (!ids.length) return
  store().commit((x) => ids.reduce((y, id) => replaceSymbol(y, id, symbolId), x), { key: d.key, label: 'Replace Symbol' })
}

export function removeSymbol(symbolId: string) {
  const d = store().active()
  if (!d) return
  const n = instancesOf(d.history.present, symbolId).length
  store().commit((x) => deleteSymbol(x, symbolId, () => newId('n')), { key: d.key, label: 'Delete Symbol' })
  if (n) notify('info', `${n} instance${n === 1 ? '' : 's'} of it became ${n === 1 ? 'a group' : 'groups'} of ${n === 1 ? 'its' : 'their'} own.`)
}

export function renameSymbolTo(symbolId: string, name: string) {
  const d = store().active()
  if (d) store().commit((x) => renameSymbol(x, symbolId, name), { key: d.key, label: 'Rename Symbol' })
}

export function duplicateSymbolOf(symbolId: string) {
  const d = store().active()
  const s = d ? symbolById(d.history.present, symbolId) : null
  if (!d || !s) return
  store().commit((x) => duplicateSymbol(x, symbolId, newId('sym'), `${s.name} copy`), { key: d.key, label: 'Duplicate Symbol' })
}

/** Whether the selection can be made a symbol: layers, none of them artboards. */
export function canMakeSymbol(d: OpenDoc | null | undefined): boolean {
  if (!d) return false
  const doc = d.history.present
  const ids = selectedIds(d)
  return ids.length > 0 && ids.every((id) => !!doc.nodes[id] && !isArtboard(doc.nodes[id]))
}

