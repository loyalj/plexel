/**
 * Every icon the interface uses, by what it means, declared once.
 *
 * Icons come from Phosphor (https://phosphoricons.com, MIT), drawn on a
 * 256-unit grid. Components ask for a meaning (`tool.brush`,
 * `layer.visible`), never for a set's own name, so changing an icon, or
 * the set, or drawing one of our own, is a change here and nothing else.
 *
 * Only the icons named here are in the app: `npm run build:icons`
 * (scripts/build-icons.ts) copies their outlines out of `@iconify-json/ph`
 * into icons.data.ts, which is checked in, so nothing is fetched at run
 * time. Tools also get Phosphor's filled weight, for a pressed tool.
 * `check:commands` holds the data to the set and the registry to the tools.
 *
 * Phosphor has no icon of its own for some of Plexel's tools (the Mixer
 * Brush, Smudge, Quick Selection, the Magnetic Lasso) or for alpha
 * channels and layer effects; those use the nearest one for now
 * (ROADMAP.md: drawing our own on Phosphor's grid).
 */

export const ICONS = {
  'tool.move': 'arrows-out-cardinal',
  'tool.marquee': 'selection',
  'tool.lasso': 'lasso',
  'tool.quick': 'selection-plus',
  'tool.wand': 'magic-wand',
  'tool.crop': 'crop',
  'tool.pen': 'pen-nib',
  'tool.curvature': 'bezier-curve',
  'tool.width': 'arrows-out-line-vertical',
  'tool.direct': 'cursor',
  'tool.pencil': 'pencil-simple-line',
  'tool.vbrush': 'paint-brush-broad',
  'tool.blob': 'marker-circle',
  'tool.shape': 'shapes',
  'tool.builder': 'intersect-three',
  'tool.livepaint': 'drop-half',
  'tool.type': 'text-t',
  'tool.brush': 'paint-brush',
  'tool.mixer': 'paint-brush-household',
  'tool.eraser': 'eraser',
  'tool.clone': 'stamp',
  'tool.spot': 'bandaids',
  'tool.heal': 'first-aid',
  'tool.patch': 'puzzle-piece',
  'tool.smudge': 'hand-pointing',
  'tool.gradient': 'gradient',
  'tool.mesh': 'grid-four',
  'tool.bucket': 'paint-bucket',
  'tool.picker': 'eyedropper',
  'tool.hand': 'hand',
  'tool.zoom': 'magnifying-glass-plus',
  'tool.rotate': 'arrow-clockwise',

  'layer.visible': 'eye',
  'layer.hidden': 'eye-slash',
  'layer.clipped': 'arrow-elbow-down-right',
  'layer.adjustment': 'sliders-horizontal',
  'layer.fold-open': 'caret-down',
  'layer.fold-closed': 'caret-right',
  'layer.locked': 'lock-simple',
  'layer.pinned': 'push-pin',
  'layer.unlocked': 'lock-simple-open',
  'layer.duplicate': 'copy',
  'layer.new': 'plus-square',
  'layer.new-adjustment': 'circle-half',
  'layer.delete': 'trash',
  'compound.base': 'square',
  'compound.add': 'unite',
  'compound.subtract': 'subtract',
  'compound.intersect': 'intersect',
  'compound.exclude': 'exclude',
  'channel.load': 'selection',
  'channel.picked': 'radio-button',
  'channel.unpicked': 'circle',

  'align.left': 'align-left',
  'align.hcentre': 'align-center-horizontal',
  'align.right': 'align-right',
  'align.top': 'align-top',
  'align.vcentre': 'align-center-vertical',
  'align.bottom': 'align-bottom',
  'distribute.hcentre': 'arrows-out-line-horizontal',
  'distribute.vcentre': 'arrows-out-line-vertical',
  'distribute.hspace': 'columns',
  'distribute.vspace': 'rows',

  'ui.settings': 'sliders-horizontal',
  'ui.duplicate': 'copy',
  'ui.close': 'x',
  'ui.check': 'check',
  'ui.submenu': 'caret-right',
  'ui.fold': 'caret-down',
  'ui.up': 'caret-up',
  'ui.down': 'caret-down',
  'ui.warning': 'warning',
  'ui.info': 'info',
  'ui.home': 'house',
  'ui.grip': 'dots-six-vertical',
  'ui.swap': 'arrows-left-right',
  'ui.reset': 'arrow-clockwise',
  'ui.workspace': 'layout',
  'ui.more': 'dots-three',
  'ui.expand-left': 'caret-double-left',
  'ui.expand-right': 'caret-double-right',
  'ui.import': 'upload-simple',
  'ui.export': 'download-simple',

  'start.custom': 'file-plus',
  'start.open': 'folder-open',
  'start.clipboard': 'clipboard-text',

  'panel.properties': 'sliders',
  'panel.colour': 'palette',
  'panel.swatches': 'swatches',
  'panel.separations': 'drop-half',
  'panel.brushes': 'paint-brush-broad',
  'panel.brush-settings': 'faders',
  'panel.tool-presets': 'toolbox',
  'panel.character': 'text-aa',
  'panel.paragraph': 'paragraph',
  'panel.glyphs': 'asterisk',
  'panel.layers': 'stack',
  'panel.channels': 'circles-three',
  'panel.patterns': 'checkerboard',
  'panel.history': 'clock-counter-clockwise',
  'panel.symbols': 'shapes',
  'tool.artboard': 'frame-corners',
} as const satisfies Record<string, string>

export type IconName = keyof typeof ICONS

/** Whether an icon also comes filled, for a pressed state: the tools. */
export const hasFilled = (name: IconName) => name.startsWith('tool.')

/** The Phosphor icon names the app needs, filled weights included: what build:icons copies. */
export function phosphorNames(): string[] {
  const out = new Set<string>()
  for (const [name, ph] of Object.entries(ICONS)) {
    out.add(ph)
    if (hasFilled(name as IconName)) out.add(`${ph}-fill`)
  }
  return [...out].sort()
}

/** Where the icons come from, for the About dialog's credits. */
export const ICON_CREDIT = { name: 'Phosphor Icons', licence: 'MIT', url: 'https://phosphoricons.com' }
