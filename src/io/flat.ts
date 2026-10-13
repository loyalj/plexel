/**
 * What a flat format (SVG, PDF) can take of a document as it is, and what
 * has to go in as pixels. Both have groups, opacity, sixteen blend modes,
 * paths with fills, strokes and linear and radial gradients, clipping
 * paths, alpha masks and text; neither has adjustment layers, the other
 * blend modes, knockout, or Plexel's layer effects.
 *
 *   - Everything at the root up to the topmost layer that needs what the
 *     format hasn't (an adjustment layer, a blend mode it lacks, a knockout
 *     group, anywhere in that layer) is flattened into one image.
 *   - Above that, a shape or text with nothing the format lacks is written
 *     as vectors; any other layer as an image of itself (with its masks and
 *     effects, at full strength), its opacity and blend mode still the
 *     file's own.
 */
import type { Doc, DocNode, NodeId } from '../doc/types'
import type { AppearanceItem } from '../doc/vector'

/** Blend modes SVG (CSS mix-blend-mode) and PDF both have. */
export const FLAT_BLENDS = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'])

const blendOk = (b: string) => b === 'pass-through' || FLAT_BLENDS.has(b)

/** Whether a node, or anything in it, needs the layers below flattened with it. */
export function needsFlatten(doc: Doc, id: NodeId): boolean {
  const n = doc.nodes[id]
  if (!n || !n.visible) return false
  // An adjustment or a filter layer changes what's below it, so that's drawn as one image with it.
  if (n.kind === 'adjustment' || n.kind === 'filter') return true
  if (!blendOk(n.blend)) return true
  if (n.kind === 'group' && n.props.knockout !== 'none') return true
  return (n.children ?? []).some((c) => needsFlatten(doc, c))
}

/** How many of the root's children (from the bottom) go into the flattened image; 0 for none. */
export function flattenCount(doc: Doc): number {
  const kids = doc.nodes[doc.root].children ?? []
  for (let i = kids.length - 1; i >= 0; i--) if (needsFlatten(doc, kids[i])) return i + 1
  return 0
}

const itemOk = (it: AppearanceItem) =>
  !it.enabled ||
  (it.blend === 'normal' &&
    // A fill's or stroke's own effects are drawn, not written: the shape goes as an image of itself.
    !it.effects?.some((e) => e.enabled) &&
    (it.paint.kind === 'solid' || (it.paint.kind === 'gradient' && (it.paint.type === 'linear' || it.paint.type === 'radial'))) &&
    // Inside and outside strokes are written as a stroke twice as wide, clipped to the shape or to all but it.
    true)

/** Whether a node can be written as vectors (its own paths and text), rather than as an image of itself. */
export function asVector(doc: Doc, n: DocNode): boolean {
  if (n.kind !== 'vector' && n.kind !== 'boolean' && n.kind !== 'text') return false
  // A Live Paint group's regions are drawn, not written: it goes as an image of itself.
  if (n.kind === 'boolean' && n.props.live) return false
  if (n.fx.length || n.effects.length) return false
  if (n.kind === 'text' && n.props.mode === 'path') return false
  for (const m of n.masks) {
    const mk = doc.nodes[m]
    if (!mk || mk.kind !== 'mask' || !mk.visible) continue
    if (mk.props.source !== 'vector' || mk.props.density < 1 || mk.props.feather > 0 || mk.props.invert) return false
  }
  return n.props.appearance.every(itemOk)
}

/** Whether a group can be a group in the file (rather than an image of itself). */
export function groupAsGroup(doc: Doc, n: DocNode): boolean {
  if (n.kind !== 'group') return false
  if (n.fx.length || n.effects.length || n.fillOpacity < 1) return false
  return n.masks.every((m) => {
    const mk = doc.nodes[m]
    return !mk || mk.kind !== 'mask' || !mk.visible || (mk.props.source === 'vector' && mk.props.density >= 1 && mk.props.feather <= 0 && !mk.props.invert)
  })
}
