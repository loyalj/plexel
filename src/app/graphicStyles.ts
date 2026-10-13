/**
 * Graphic styles from the page's side (doc/graphicStyles.ts has the
 * edits): what the Graphic Styles panel and Properties do, each one named
 * step.
 */
import { addGraphicStyle, applyGraphicStyle, linkOf, redefineGraphicStyle, removeGraphicStyle, renameGraphicStyle, stylable, unlinkGraphicStyle } from '../doc/graphicStyles'
import type { AppearanceItem } from '../doc/vector'
import { documents, newId, selectedIds } from './documents'
import { notify } from './notices'

const store = () => documents()

/** The selected shape or text whose appearance a style is made from, or says why there's none. */
function source() {
  const d = store().active()
  const n = d?.selected ? d.history.present.nodes[d.selected] : undefined
  if (!d || !stylable(n)) {
    notify('info', 'Select a shape, a compound shape or text: its fills, strokes and their effects become the style.')
    return null
  }
  return { d, n, appearance: (n.props as { appearance: AppearanceItem[] }).appearance }
}

/** A new style from the selected shape's appearance, the shape linked to it. */
export function newGraphicStyle() {
  const s = source()
  if (!s) return
  const doc = s.d.history.present
  const used = new Set((doc.graphicStyles ?? []).map((g) => g.name))
  let i = 1
  while (used.has(`Style ${i}`)) i++
  const id = newId('g')
  store().commit((x) => applyGraphicStyle(addGraphicStyle(x, { id, name: `Style ${i}`, appearance: s.appearance }), [s.n.id], id), { key: s.d.key, label: 'New Graphic Style' })
}

/** The style given to every selected shape and text, linked. */
export function applyStyle(id: string) {
  const d = store().active()
  if (!d) return
  const doc = d.history.present
  const ids = selectedIds(d).filter((x) => stylable(doc.nodes[x]))
  if (!ids.length) return notify('info', 'Select shapes or text to give the style to.')
  const name = doc.graphicStyles?.find((g) => g.id === id)?.name ?? 'Graphic Style'
  store().commit((x) => applyGraphicStyle(x, ids, id), { key: d.key, label: `Apply ${name}` })
}

/** The style made the selected shape's appearance, and every shape linked to it with it. */
export function redefineStyle(id: string) {
  const s = source()
  if (!s) return
  const name = s.d.history.present.graphicStyles?.find((g) => g.id === id)?.name ?? 'Graphic Style'
  store().commit((x) => applyGraphicStyle(redefineGraphicStyle(x, id, s.appearance), [s.n.id], id), { key: s.d.key, label: `Redefine ${name}` })
}

export function deleteStyle(id: string) {
  const d = store().active()
  if (d) store().commit((x) => removeGraphicStyle(x, id), { key: d.key, label: 'Delete Graphic Style' })
}

export function renameStyle(id: string, name: string) {
  const d = store().active()
  if (d) store().commit((x) => renameGraphicStyle(x, id, name), { key: d.key, label: 'Rename Graphic Style' })
}

/** The selected shapes' links to their styles broken; their looks stay. */
export function unlinkSelected() {
  const d = store().active()
  if (!d) return
  const ids = selectedIds(d).filter((x) => linkOf(d.history.present.nodes[x]))
  if (ids.length) store().commit((x) => ids.reduce((y, id) => unlinkGraphicStyle(y, id), x), { key: d.key, label: 'Break Link to Graphic Style' })
}
