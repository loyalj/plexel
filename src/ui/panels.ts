/**
 * The dock's panels, declared once. The Window menu, the palette's
 * show/hide commands, the dock and the saved workspace all read this list,
 * so a new panel is one entry here and its component.
 *
 * Until a document exists every panel shows its empty state, which says
 * what will appear there. That is also what a panel shows later when the
 * document is closed, so the copy is written for both.
 */

export type PanelId = 'layers' | 'properties' | 'colour' | 'swatches' | 'brushes' | 'brush-settings' | 'tool-presets' | 'history' | 'character' | 'paragraph' | 'glyphs' | 'separations' | 'channels' | 'patterns' | 'graphic-styles' | 'vector-brushes' | 'symbols'

export interface PanelDef {
  id: PanelId
  title: string
  /** What the panel shows when there is nothing to show. */
  empty: string
  /** Open in the Essentials workspace, the one a fresh browser starts in. */
  defaultOpen: boolean
  /** The key that shows and hides it, as Photoshop has it. */
  shortcut?: string
}

export const PANELS: PanelDef[] = [
  {
    id: 'properties',
    title: 'Properties',
    empty: 'The settings of whatever is selected: a layer, a shape, a tool.',
    defaultOpen: true,
  },
  {
    id: 'colour',
    title: 'Colour',
    empty: 'The foreground and background colours, in RGB, HSB, Lab, CMYK or Gray.',
    defaultOpen: true,
  },
  {
    id: 'swatches',
    title: 'Swatches',
    empty: 'Colours kept for reuse, and the document’s own: process, global and spot colours.',
    defaultOpen: false,
  },
  {
    id: 'separations',
    title: 'Separations',
    empty: 'The inks of a CMYK document, one at a time or together, and how much ink is under the pointer.',
    defaultOpen: false,
  },
  {
    id: 'brushes',
    title: 'Brushes',
    empty: 'Brush presets, each with a stroke drawn by it.',
    defaultOpen: false,
  },
  {
    id: 'brush-settings',
    title: 'Brush Settings',
    empty: 'Every setting of the painting tool’s brush, section by section, with a stroke drawn by it.',
    defaultOpen: false,
    // Photoshop's key. The page keeps F5 from the browser anyway (input/guard.ts), so it never reloaded.
    shortcut: 'F5',
  },
  {
    id: 'tool-presets',
    title: 'Tool Presets',
    empty: 'Tools with their options kept under a name, chosen in one click; Photoshop’s too.',
    defaultOpen: false,
  },
  {
    id: 'character',
    title: 'Character',
    empty: 'Fonts, sizes, spacing and OpenType features for text.',
    defaultOpen: false,
  },
  {
    id: 'paragraph',
    title: 'Paragraph',
    empty: 'Alignment, indents, spacing, hyphenation, justification and tabs for text.',
    defaultOpen: false,
  },
  {
    id: 'glyphs',
    title: 'Glyphs',
    empty: 'Every character of the font in use, and each one’s alternates, to insert into text.',
    defaultOpen: false,
  },
  {
    id: 'layers',
    title: 'Layers',
    empty: 'The layers of the open document, top to bottom.',
    defaultOpen: true,
  },
  {
    id: 'channels',
    title: 'Channels',
    empty: 'Alpha channels: selections saved with the document, to load again.',
    defaultOpen: false,
  },
  {
    id: 'patterns',
    title: 'Patterns',
    empty: 'Patterns made from pixels, kept in the document for fills, fill layers and shapes.',
    defaultOpen: false,
  },
  {
    id: 'graphic-styles',
    title: 'Graphic Styles',
    empty: 'Named looks for shapes and text: fills, strokes and their effects, kept with the document.',
    defaultOpen: false,
  },
  {
    id: 'vector-brushes',
    title: 'Vector Brushes',
    empty: 'Brushes for strokes: artwork bent along a path, scattered along it, or repeated as tiles.',
    defaultOpen: false,
  },
  {
    id: 'symbols',
    title: 'Symbols',
    empty: 'Artwork kept once and placed as instances: edit the symbol and every instance follows.',
    defaultOpen: false,
  },
  {
    id: 'history',
    title: 'History',
    empty: 'Every change to the open document, by name. Pick one to go back to it.',
    defaultOpen: false,
  },
]
