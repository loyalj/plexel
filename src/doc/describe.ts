/**
 * What an edit did, in a few words, for the History panel and the Undo
 * menu item.
 *
 * Worked out by comparing the document before and after rather than
 * handed in by every place that edits it: every edit goes through one
 * commit, and a name that has to be remembered at each call site ends up
 * saying "Edit" at most of them. (Fresyn learned this; its describeEdit is
 * the model.) The few edits that know better pass their own label.
 *
 * Cheap on the common path: the document is persistent, so the changed
 * nodes are found by reference, without looking inside the rest.
 */
import { nodeDef } from './nodes'
import type { Doc, DocNode } from './types'

export function describeEdit(prev: Doc, next: Doc): string {
  // First, because Canvas Size moves layers too, and is named for what the
  // user asked for, not for its side effects.
  if (prev.width !== next.width || prev.height !== next.height) return 'Canvas Size'
  if (prev.nodes !== next.nodes) {
    const n = describeNodes(prev, next)
    if (n) return n
  }
  if (prev.selection !== next.selection) {
    if (!next.selection) return 'Deselect'
    return prev.selection ? 'Modify Selection' : 'Select'
  }
  if (prev.resolution !== next.resolution) return 'Resolution'
  if (prev.name !== next.name) return 'Rename Document'
  if (prev.guides !== next.guides) return 'Guides'
  if (prev.tiled !== next.tiled) return 'Tiled'
  if (prev.mode !== next.mode || prev.depth !== next.depth) return 'Mode'
  if (prev.profile !== next.profile) return 'Assign Profile'
  return 'Edit'
}

const quoted = (n: DocNode) => `“${n.name}”`

function describeNodes(prev: Doc, next: Doc): string | null {
  const added = Object.keys(next.nodes).filter((id) => !prev.nodes[id])
  const removed = Object.keys(prev.nodes).filter((id) => !next.nodes[id])
  if (added.length) {
    // A subtree arrives as one edit; name it by its top node, the one whose
    // parent was already there.
    const top = added.map((id) => next.nodes[id]).find((n) => !added.some((a) => next.nodes[a].children?.includes(n.id) || next.nodes[a].masks.includes(n.id)))
    if (top?.kind === 'mask') return top.props.source === 'vector' ? 'Add Vector Mask' : 'Add Layer Mask'
    return top ? `New ${nodeDef(top.kind).label}` : 'New Layers'
  }
  if (removed.length) {
    const top = removed.map((id) => prev.nodes[id]).find((n) => !removed.some((r) => prev.nodes[r].children?.includes(n.id) || prev.nodes[r].masks.includes(n.id)))
    if (top?.kind === 'mask') return 'Delete Layer Mask'
    return top ? `Delete ${quoted(top)}` : 'Delete Layers'
  }

  const changed = Object.keys(next.nodes).filter((id) => prev.nodes[id] !== next.nodes[id])
  // A move changes two parents' child lists, and nothing else.
  const parents = changed.filter((id) => prev.nodes[id].children !== next.nodes[id].children)
  if (parents.length && parents.length === changed.length) return 'Move Layer'
  // Canvas Size shifts every top-level layer at once.
  if (changed.length > 1) {
    const moved = changed.every((id) => prev.nodes[id].transform !== next.nodes[id].transform)
    return moved ? 'Move Layers' : 'Edit Layers'
  }
  if (changed.length !== 1) return null
  const a = prev.nodes[changed[0]]
  const b = next.nodes[changed[0]]
  if (a.name !== b.name) return 'Rename Layer'
  if (a.visible !== b.visible) return b.visible ? `Show ${quoted(b)}` : `Hide ${quoted(b)}`
  if (a.opacity !== b.opacity) return 'Opacity'
  if (a.fillOpacity !== b.fillOpacity) return 'Fill Opacity'
  if (a.blend !== b.blend) return 'Blend Mode'
  if (a.locked !== b.locked) return b.locked.all || b.locked.pixels || b.locked.position ? `Lock ${quoted(b)}` : `Unlock ${quoted(b)}`
  if (a.transform !== b.transform) return 'Transform'
  if (a.tag !== b.tag) return 'Colour Tag'
  if (a.kind === 'pixel' && b.kind === 'pixel' && a.props.resample !== b.props.resample) return 'Resampling'
  if (a.kind === 'group' && b.kind === 'group' && a.props.knockout !== b.props.knockout) return 'Knockout'
  if (a.fx !== b.fx) return 'Layer Style'
  if (a.effects !== b.effects) return 'Move Filter'
  if ((a.kind === 'adjustment' || a.kind === 'filter') && a.props !== b.props) return `Edit ${quoted(b)}`
  if (a.kind === 'embedded' && b.kind === 'embedded' && a.props.content !== b.props.content) return 'Edit Contents'
  if (a.kind === 'vector' && b.kind === 'vector' && a.props.geometry !== b.props.geometry) return b.props.geometry?.kind === 'shape' ? 'Edit Shape' : 'Edit Path'
  if ((a.kind === 'vector' || a.kind === 'boolean') && a.props !== b.props) return 'Appearance'
  if (a.kind === 'mask' && b.kind === 'mask' && a.props.geometry !== b.props.geometry) return 'Edit Vector Mask'
  if (a.kind === 'mask' && b.kind === 'mask') {
    if (a.props.tiles !== b.props.tiles) return 'Paint Mask'
    if (a.props.invert !== b.props.invert) return 'Invert Mask'
    if (a.props.density !== b.props.density) return 'Mask Density'
    if (a.props.feather !== b.props.feather) return 'Mask Feather'
  }
  if (a.props !== b.props) return `Edit ${nodeDef(b.kind).label}`
  return null
}
