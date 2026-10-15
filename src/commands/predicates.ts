/** The tests commands need before they can run, each with the words for when it fails. */
import type { CommandContext } from './context'

/** A test a command can need, with the words for when it fails. */
export type Need = ((c: CommandContext) => boolean) & { why(c: CommandContext): string }
export const need = (test: (c: CommandContext) => boolean, why: (c: CommandContext) => string): Need => Object.assign(test, { why })

export const NO_DOC = 'Open or make a document first'
export const NO_LAYER = 'Select a layer first'

const KIND_NAMES: Record<string, string> = {
  pixel: 'a pixel layer',
  vector: 'a shape',
  boolean: 'a compound shape',
  text: 'a text layer',
  group: 'a group',
  adjustment: 'an adjustment layer',
  filter: 'a live filter',
  fill: 'a fill layer',
  embedded: 'a smart object',
  mask: 'a mask',
}
/** The selected layer's kind in words: "a text layer". */
export const kindName = (c: CommandContext) => KIND_NAMES[c.selectedKind() ?? ''] ?? 'this layer'
/** No document, then no layer, come first; past those, the reason given. */
export const docWhy = (c: CommandContext, why: string) => (c.hasDoc() ? why : NO_DOC)
export const layerWhy = (c: CommandContext, why: string) => (!c.hasDoc() ? NO_DOC : c.selectedLayer() === null ? NO_LAYER : why)

export const hasDoc = need((c) => c.hasDoc(), () => NO_DOC)
export const hasLayer = need((c) => c.hasDoc() && c.selectedLayer() !== null, (c) => layerWhy(c, ''))
export const hasPixelLayer = need((c) => c.hasDoc() && c.selectedKind() === 'pixel', (c) => layerWhy(c, `Works on a pixel layer, not ${kindName(c)}`))
export const hasSelection = need((c) => c.hasDoc() && c.hasSelection(), (c) => docWhy(c, 'Needs a selection: draw one with a selection tool'))
export const hasMask = need((c) => hasLayer(c) && c.hasMask(), (c) => layerWhy(c, 'The layer has no layer mask'))
export const canTransform = need((c) => hasLayer(c) && c.selectedKind() !== 'mask', (c) => layerWhy(c, 'Not for a mask on its own'))
export const PAINTS_WHY = () => 'For the painting tools: Brush, Mixer Brush, Eraser, Smudge'
