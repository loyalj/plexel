/** The menu bar, the context menu and the smaller menus, built from the registry. */
import { PANELS } from '../ui/panels'
import { THEMES } from '../ui/theme'
import { ADJUSTMENT_DEFS } from '../adjust/defs'
import { FILTER_CATEGORIES, FILTER_DEFS } from '../filters/defs'
import { WORKSPACES } from '../ui/workspace'
import { ALIGN_OPS, DISTRIBUTE_OPS } from '../geom/align'
import { ALIGN_TO, SNAP_TARGETS } from '../app/guidePrefs'
import { UNITS } from '../doc/units'
import { TILING_ITEMS, SCREEN_MODES } from './context'
import type { CommandContext, CommandDef } from './context'
import { type Need, NO_DOC, NO_LAYER, kindName } from './predicates'
import { COMMANDS_BY_ID, runtimeCommands } from './registry'

export type MenuItem = { command: string } | { separator: true } | { submenu: string; items: MenuItem[] } | { runtime: 'workspaces' }

export interface MenuDef {
  id: string
  label: string
  items: MenuItem[]
}

const cmd = (command: string): MenuItem => ({ command })
const SEP: MenuItem = { separator: true }
/** The Colour Label submenu: none, then Photoshop's seven. */
const LABEL_ITEMS: MenuItem[] = ['layer.tag.none', 'layer.tag.red', 'layer.tag.orange', 'layer.tag.yellow', 'layer.tag.green', 'layer.tag.blue', 'layer.tag.violet', 'layer.tag.gray'].map(cmd)

/** A menu's items with its run-time entries filled in, and no separator left doubled or at an end by an empty one. */
export function expandMenu(items: MenuItem[], c: CommandContext): MenuItem[] {
  const out: MenuItem[] = []
  for (const i of items.flatMap((i): MenuItem[] => ('runtime' in i ? runtimeCommands(c).map((d) => cmd(d.id)) : [i])))
    if (!('separator' in i) || (out.length && !('separator' in out[out.length - 1]))) out.push(i)
  if (out.length && 'separator' in out[out.length - 1]) out.pop()
  return out
}

/** The menu bar, left to right. */
export const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: 'File',
    items: [cmd('file.new'), cmd('file.new-from-clipboard'), cmd('file.open'), cmd('file.recent'), SEP, cmd('file.place'), SEP, cmd('file.save'), cmd('file.save-as'), cmd('file.export'), cmd('file.save-for-web'), SEP, cmd('file.close')],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      cmd('edit.undo'),
      cmd('edit.redo'),
      SEP,
      cmd('edit.cut'),
      cmd('edit.copy'),
      cmd('edit.copy-merged'),
      cmd('edit.paste'),
      { submenu: 'Paste Special', items: [cmd('edit.paste-in-place'), cmd('edit.paste-into'), cmd('edit.paste-outside')] },
      cmd('edit.delete'),
      SEP,
      cmd('edit.fill'),
      cmd('edit.fill-foreground'),
      cmd('edit.fill-background'),
      SEP,
      cmd('edit.free-transform'),
      {
        submenu: 'Transform',
        items: [
          cmd('edit.transform-distort'),
          cmd('edit.transform-perspective'),
          cmd('edit.transform-warp'),
          SEP,
          cmd('edit.transform-flip-h'),
          cmd('edit.transform-flip-v'),
          SEP,
          cmd('edit.transform-cw'),
          cmd('edit.transform-ccw'),
          cmd('edit.transform-180'),
        ],
      },
      cmd('edit.commit'),
      cmd('edit.cancel'),
      SEP,
      cmd('edit.define-brush'),
      cmd('edit.define-pattern'),
      cmd('edit.import-brushes'),
      SEP,
      cmd('edit.colour-settings'),
      cmd('edit.pen-settings'),
      cmd('edit.guide-settings'),
      cmd('edit.interface'),
      cmd('edit.toolbar'),
      cmd('help.shortcuts'),
    ],
  },
  {
    id: 'document',
    label: 'Document',
    items: [
      { submenu: 'Mode', items: [cmd('doc.mode.rgb'), cmd('doc.mode.cmyk'), cmd('doc.mode.gray'), SEP, cmd('doc.depth.8'), cmd('doc.depth.16')] },
      { submenu: 'Tiled', items: TILING_ITEMS.map((t) => cmd(`doc.tiled.${t.id}`)) },
      { submenu: 'Adjustments', items: ADJUSTMENT_DEFS.map((a) => cmd(`doc.adjust-${a.id}`)) },
      SEP,
      cmd('doc.canvas-size'),
      cmd('doc.resolution'),
      cmd('doc.crop'),
      SEP,
      cmd('doc.assign-profile'),
      cmd('doc.convert-profile'),
      SEP,
      { submenu: 'Channels', items: [cmd('channel.new'), cmd('channel.new-spot'), cmd('channel.duplicate'), cmd('channel.delete'), SEP, cmd('channel.options')] },
      SEP,
      cmd('doc.rename'),
    ],
  },
  {
    id: 'layer',
    label: 'Layer',
    items: [
      cmd('layer.new-pixel'),
      cmd('layer.new-group'),
      { submenu: 'New Fill Layer', items: [cmd('layer.fill-solid'), cmd('layer.fill-gradient'), cmd('layer.fill-pattern')] },
      { submenu: 'New Adjustment Layer', items: ADJUSTMENT_DEFS.map((a) => cmd(`layer.adjust-${a.id}`)) },
      { submenu: 'New Filter Layer', items: FILTER_DEFS.filter((f) => !f.hidden && !f.warp && !f.remap).map((f) => cmd(`layer.filter-${f.id}`)) },
      cmd('layer.duplicate'),
      cmd('layer.via-copy'),
      cmd('layer.via-cut'),
      SEP,
      cmd('layer.style'),
      cmd('layer.copy-style'),
      cmd('layer.paste-style'),
      cmd('layer.clear-style'),
      { submenu: 'Smart Objects', items: [cmd('layer.smart-convert'), cmd('layer.smart-edit')] },
      SEP,
      cmd('layer.rename'),
      cmd('layer.rename-many'),
      cmd('layer.toggle-visible'),
      { submenu: 'Colour Label', items: LABEL_ITEMS },
      SEP,
      cmd('layer.group'),
      cmd('layer.ungroup'),
      cmd('layer.select-in-group'),
      cmd('layer.move-to-group'),
      cmd('layer.draw-into'),
      { submenu: 'Groups in the Panel', items: [cmd('layer.fold-all'), cmd('layer.unfold-all'), cmd('layer.fold-others')] },
      SEP,
      {
        submenu: 'Layer Mask',
        items: [
          cmd('layer.mask-reveal-all'),
          cmd('layer.mask-hide-all'),
          cmd('layer.mask-reveal-selection'),
          cmd('layer.mask-hide-selection'),
          SEP,
          cmd('layer.mask-delete'),
          cmd('layer.mask-apply'),
          SEP,
          cmd('layer.mask-toggle'),
          cmd('layer.mask-invert'),
        ],
      },
      {
        submenu: 'Vector Mask',
        items: [cmd('layer.vmask-reveal-all'), cmd('layer.vmask-hide-all'), SEP, cmd('layer.vmask-delete'), cmd('layer.vmask-toggle')],
      },
      cmd('layer.clip'),
      SEP,
      { submenu: 'Artboards', items: [cmd('layer.new-artboard'), cmd('layer.artboard-from-layers'), SEP, cmd('layer.release-artboard')] },
      { submenu: 'Symbols', items: [cmd('layer.new-symbol'), SEP, cmd('layer.edit-symbol'), cmd('layer.break-symbol')] },
      { submenu: 'Pattern', items: [cmd('layer.make-pattern')] },
      SEP,
      {
        submenu: 'Combine Shapes',
        items: [cmd('layer.combine-add'), cmd('layer.combine-subtract'), cmd('layer.combine-intersect'), cmd('layer.combine-exclude'), SEP, cmd('layer.compound-release'), cmd('layer.compound-expand'), SEP, cmd('shape.combine-one')],
      },
      {
        submenu: 'Pathfinder',
        items: [cmd('shape.pf-unite'), cmd('shape.pf-minus-front'), cmd('shape.pf-intersect'), cmd('shape.pf-exclude'), SEP, cmd('shape.pf-divide'), cmd('shape.pf-trim'), cmd('shape.pf-merge'), cmd('shape.pf-crop'), cmd('shape.pf-minus-back')],
      },
      { submenu: 'Path', items: [cmd('shape.outline-stroke'), cmd('shape.offset-path'), SEP, cmd('shape.join'), cmd('shape.break'), cmd('shape.separate'), cmd('shape.simplify'), cmd('shape.smooth')] },
      { submenu: 'Live Paint', items: [cmd('shape.live-make'), cmd('shape.live-expand')] },
      { submenu: 'Brushes', items: [cmd('shape.brush-new-art'), cmd('shape.brush-new-scatter'), cmd('shape.brush-new-pattern'), SEP, cmd('shape.brush-remove'), cmd('shape.brush-options')] },
      cmd('layer.convert-path'),
      cmd('layer.rasterize'),
      cmd('layer.merge'),
      cmd('layer.flatten-group'),
      cmd('layer.merge-visible'),
      cmd('layer.stamp-visible'),
      cmd('layer.image-trace'),
      SEP,
      cmd('layer.raise'),
      cmd('layer.lower'),
      SEP,
      { submenu: 'Align', items: [...ALIGN_OPS.map((o) => cmd(`layer.align.${o.id}`)), SEP, ...ALIGN_TO.map((a) => cmd(`layer.align-to.${a.id}`))] },
      { submenu: 'Distribute', items: DISTRIBUTE_OPS.map((o) => cmd(`layer.distribute.${o.id}`)) },
      SEP,
      cmd('layer.delete'),
    ],
  },
  {
    id: 'type',
    label: 'Type',
    items: [cmd('type.create-outlines'), SEP, cmd('type.add-fonts'), cmd('type.system-fonts')],
  },
  {
    id: 'select',
    label: 'Select',
    items: [
      cmd('select.all'),
      cmd('select.deselect'),
      cmd('select.reselect'),
      cmd('select.inverse'),
      SEP,
      cmd('select.colour-range'),
      SEP,
      cmd('select.mask'),
      { submenu: 'Modify', items: [cmd('select.border'), cmd('select.smooth'), cmd('select.expand'), cmd('select.contract'), cmd('select.feather')] },
      cmd('select.grow'),
      cmd('select.similar'),
      SEP,
      cmd('select.transform'),
      SEP,
      cmd('select.quick-mask'),
      SEP,
      cmd('select.load'),
      cmd('select.save'),
      cmd('select.load-luminosity'),
    ],
  },
  {
    id: 'filter',
    label: 'Filter',
    items: [
      cmd('filter.liquify'),
      SEP,
      // Photoshop's submenus, each its filters in the order they were added.
      ...FILTER_CATEGORIES.map((c) => ({ submenu: c, items: FILTER_DEFS.filter((f) => !f.hidden && (f.category ?? 'Other') === c).map((f) => cmd(`filter.${f.id}`)) })).filter((m) => m.items.length),
      SEP,
      cmd('filter.apply-live'),
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      cmd('view.zoom-in'),
      cmd('view.zoom-out'),
      cmd('view.fit'),
      cmd('view.actual'),
      cmd('view.zoom-selection'),
      cmd('view.zoom-layer'),
      SEP,
      cmd('view.rotate-left'),
      cmd('view.rotate-right'),
      cmd('view.reset-rotation'),
      SEP,
      cmd('view.split'),
      cmd('view.tiled-view'),
      SEP,
      cmd('view.proof-setup'),
      cmd('view.proof-colours'),
      cmd('view.gamut-warning'),
      SEP,
      cmd('view.rulers'),
      { submenu: 'Ruler Units', items: UNITS.map((u) => cmd(`view.units.${u.id}`)) },
      { submenu: 'Show', items: [cmd('view.show-guides'), cmd('view.show-grid'), cmd('view.show-pixel-grid'), cmd('view.smart-guides')] },
      cmd('view.snap'),
      { submenu: 'Snap To', items: SNAP_TARGETS.map((t) => cmd(`view.snap-to.${t.id}`)) },
      SEP,
      cmd('view.lock-guides'),
      cmd('view.clear-guides'),
      cmd('view.new-guide'),
      cmd('view.guide-layout'),
      cmd('view.guides-from-shape'),
      SEP,
      cmd('palette.open'),
      SEP,
      {
        submenu: 'Theme',
        items: [...THEMES.map((t) => cmd(`appearance.theme.${t.id}`)), SEP, cmd('appearance.mode.dark'), cmd('appearance.mode.light')],
      },
      cmd('appearance.mode.toggle'),
      SEP,
      { submenu: 'Screen Mode', items: [...SCREEN_MODES.map((m) => cmd(`view.screen.${m.id}`)), SEP, cmd('view.screen-next')] },
      cmd('view.hide-panels'),
      cmd('view.hide-dock'),
      cmd('view.fullscreen'),
    ],
  },
  {
    id: 'window',
    label: 'Window',
    items: [
      {
        submenu: 'Workspace',
        items: [
          ...WORKSPACES.map((w) => cmd(`window.workspace.${w.id}`)),
          SEP,
          { runtime: 'workspaces' },
          SEP,
          cmd('window.reset'),
          cmd('window.workspace-save'),
          cmd('window.workspace-new'),
          cmd('window.workspace-manage'),
          SEP,
          cmd('window.workspace-export'),
          cmd('window.workspace-import'),
        ],
      },
      SEP,
      ...PANELS.map((p) => cmd(`window.panel.${p.id}`)),
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [cmd('help.gpu'), SEP, cmd('help.about')],
  },
]

/**
 * Why a command can't run now, or null when it can: its own `why`, the
 * reason its `enabled` test carries, or what's missing from the selection.
 */
export function disabledReason(def: CommandDef, c: CommandContext): string | null {
  if (!def.enabled || def.enabled(c)) return null
  const why = def.why?.(c) ?? (def.enabled as Partial<Need>).why?.(c)
  if (why) return why
  if (!c.hasDoc()) return NO_DOC
  if (c.selectedLayer() === null) return NO_LAYER
  return `Not available for ${kindName(c)}`
}

/**
 * A command's label in the context menu, where it has no submenu around it
 * to lean on: "Reveal All" under Layer → Layer Mask is "Layer Mask: Reveal
 * All" there.
 */
export function contextLabel(def: CommandDef, c: CommandContext): string {
  // Out of their submenu, colour labels say what they are: "Colour Label: Red".
  if (def.id.startsWith('layer.tag.')) return def.label
  const label = def.menuLabel ? def.menuLabel(c) : def.label
  return /Mask$/.test(def.category) && !/Mask/.test(label) ? `${def.category}: ${label}` : label
}

/**
 * What a right-click on the canvas offers: what can be done now, for the
 * selection, the selected layer and the work in progress, from the same
 * commands the menus run. Only what's enabled is listed, so the menu is
 * short and every item does something.
 */
export function contextMenu(c: CommandContext): MenuItem[] {
  const groups: string[][] = []
  const session = c.session()
  if (session) {
    // The work in progress first and only: it ends at the next edit anyway.
    groups.push(['edit.commit', 'edit.cancel'])
  } else if (!c.hasDoc()) {
    groups.push(['file.new', 'file.open', 'file.recent'])
  } else {
    if (c.hasSelection()) {
      groups.push(['select.deselect', 'select.inverse', 'select.feather', 'select.mask', 'select.transform'])
      groups.push(['edit.fill', 'layer.via-copy', 'layer.via-cut', 'layer.mask-reveal-selection', 'select.save'])
    } else groups.push(['select.all', 'select.reselect'])
    const kind = c.selectedKind()
    if (kind) {
      const byKind: Record<string, string[]> = {
        pixel: ['layer.mask-reveal-all', 'layer.smart-convert', 'filter.apply-live', 'layer.image-trace'],
        vector: ['layer.convert-path', 'layer.rasterize', 'layer.vmask-reveal-all'],
        boolean: ['layer.compound-release', 'layer.compound-expand', 'layer.rasterize'],
        text: ['type.create-outlines', 'layer.rasterize'],
        fill: ['layer.rasterize', 'layer.mask-reveal-all'],
        embedded: ['layer.smart-edit', 'layer.rasterize', 'layer.image-trace'],
        group: ['layer.rasterize', 'layer.flatten-group', 'layer.select-in-group', 'layer.draw-into', 'layer.mask-reveal-all'],
      }
      groups.push(['edit.free-transform', 'layer.duplicate', 'layer.rename', 'layer.style', 'layer.clip', ...(byKind[kind] ?? []), 'layer.group', 'layer.merge', 'layer.delete'])
      if (c.hasMask()) groups.push(['layer.mask-toggle', 'layer.mask-invert', 'layer.mask-apply', 'layer.mask-delete'])
    }
    groups.push(['edit.undo', 'edit.paste'])
    groups.push(['view.fit', 'view.actual'])
  }
  const out: MenuItem[] = []
  for (const g of groups) {
    const items = g.filter((id) => {
      const def = COMMANDS_BY_ID.get(id)
      return !!def && (!def.enabled || def.enabled(c))
    })
    if (!items.length) continue
    if (out.length) out.push(SEP)
    out.push(...items.map(cmd))
  }
  return out
}

/** A right-click on a ruler: its units, and the rulers' other settings. */
/**
 * The Layers panel's menu, at a right-click on a row: what works on the
 * layers selected, the many-layer actions first. Items that can't run
 * now are left out, as on the canvas.
 */
export function layersMenu(c: CommandContext): MenuItem[] {
  // A context menu has no submenus: the colour labels are listed, each saying what it is.
  const groups: string[][] = [
    ['layer.draw-into', 'layer.select-in-group', 'layer.group', 'layer.ungroup', 'layer.move-to-group'],
    ['layer.merge', 'layer.flatten-group', 'layer.rasterize', 'shape.combine-one'],
    ['layer.duplicate', 'layer.rename', 'layer.rename-many'],
    LABEL_ITEMS.map((i) => ('command' in i ? i.command : '')),
    ['layer.fold-all', 'layer.unfold-all', 'layer.fold-others'],
    ['layer.delete'],
  ]
  const out: MenuItem[] = []
  for (const g of groups) {
    const items = g.flatMap((x): MenuItem[] => {
      const def = COMMANDS_BY_ID.get(x)
      return def && (!def.enabled || def.enabled(c)) ? [cmd(x)] : []
    })
    if (!items.length) continue
    if (out.length) out.push(SEP)
    out.push(...items)
  }
  return out
}

export function rulerMenu(): MenuItem[] {
  return [...UNITS.map((u) => cmd(`view.units.${u.id}`)), SEP, cmd('view.show-guides'), cmd('view.lock-guides'), cmd('view.new-guide'), SEP, cmd('view.rulers')]
}

/** The Layers panel's adjustment button: each adjustment layer it can add. */
export function adjustmentMenu(): MenuItem[] {
  return ADJUSTMENT_DEFS.map((a) => cmd(`layer.adjust-${a.id}`))
}
