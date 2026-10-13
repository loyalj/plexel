/**
 * Every command the app has, declared once.
 *
 * The menus, the keyboard shortcuts, the Ctrl+K palette and the shortcuts
 * list are all built from this registry, so a command added here is in all
 * four at once, and a shortcut can't be shown in one place and missing from
 * another. Commands never reach into React or the document store: they act
 * on a CommandContext the app hands them, which is also what lets
 * check-commands load the whole registry in Node and run every command.
 *
 * Labels follow the usual desktop rule: a command that opens a dialog or
 * asks for more ends in an ellipsis; one that acts at once doesn't.
 */
import { PANELS, type PanelId } from '../ui/panels'
import { THEMES, type Appearance } from '../ui/theme'
import { TOOL_DEFS, tools, type ToolId } from '../tools'
import { ADJUSTMENT_DEFS } from '../adjust/defs'
import { FILTER_CATEGORIES, FILTER_DEFS } from '../filters/defs'
import { WORKSPACES } from '../ui/workspace'
import { ALIGN_OPS, DISTRIBUTE_OPS, type AlignOp, type DistributeOp } from '../geom/align'
import { ALIGN_TO, SNAP_TARGETS, type AlignTo, type SnapTo } from '../app/guidePrefs'
import { UNITS, type Unit } from '../doc/units'
import type { Tiling } from '../doc/types'
import { defaultKeys, keyChanges, keysOf } from '../input/keymap'

export type DialogId =
  | 'about'
  | 'gpu'
  | 'shortcuts'
  | 'new'
  | 'canvasSize'
  | 'resolution'
  | 'renameDoc'
  | 'recent'
  | 'colourSettings'
  | 'assignProfile'
  | 'convertProfile'
  | 'proofSetup'
  | 'export'
  | 'pen'
  | 'feather'
  | 'expand'
  | 'contract'
  | 'selectMask'
  | 'layerStyle'
  | 'defineBrush'
  | 'fill'
  | 'definePattern'
  | 'colourRange'
  | 'border'
  | 'smooth'
  | 'saveSelection'
  | 'loadSelection'
  | 'interface'
  | 'newWorkspace'
  | 'manageWorkspaces'
  | 'importWorkspace'
  | 'newGuide'
  | 'guideLayout'
  | 'guideSettings'
  /** A filter's dialog, by its FILTER_DEFS id. */
  | `filter:${string}`
  | `adjust:${string}`
  | 'offsetPath'
  | 'simplify'

export type NewMaskKind = 'reveal-all' | 'hide-all' | 'reveal-selection' | 'hide-selection'

/** Things done at once that need no settings of their own (phase 14's Select and Layer additions). */
export type AppAction = 'grow' | 'similar' | 'transform-selection' | 'fill-layer-solid' | 'fill-layer-gradient' | 'fill-layer-pattern'
export type TransformKind = 'flip-h' | 'flip-v' | 'cw' | 'ccw' | '180'
/** The View menu's switches for rulers, guides, grids and snapping (app/guidePrefs.ts). */
export type ViewAid = 'rulers' | 'guides' | 'lockGuides' | 'grid' | 'pixelGrid' | 'smartGuides' | 'snap' | 'tiledView'

/** Document → Tiled: how the document repeats (doc/types.ts' Tiling). */
export const TILING_ITEMS: { id: Tiling; label: string; menu: string }[] = [
  { id: 'off', label: 'Not Tiled', menu: 'Off' },
  { id: 'both', label: 'Tiled in Both Directions', menu: 'Both Directions' },
  { id: 'x', label: 'Tiled Horizontally', menu: 'Horizontally' },
  { id: 'y', label: 'Tiled Vertically', menu: 'Vertically' },
]

/**
 * Photoshop's screen modes, which F steps through: the whole interface;
 * the canvas with the menu bar, panels and bars but no tabs or status bar;
 * the canvas alone, filling the screen (Tab brings the panels back over it).
 */
export type ScreenMode = 'standard' | 'menus' | 'full'
export const SCREEN_MODES: { id: ScreenMode; label: string }[] = [
  { id: 'standard', label: 'Standard Screen Mode' },
  { id: 'menus', label: 'Full Screen Mode with Menu Bar' },
  { id: 'full', label: 'Full Screen Mode' },
]

/** What a command can act on. The app builds one per render. */
export interface CommandContext {
  /** Asks for Photoshop brush files (ABR) and imports them. */
  importBrushes(): void
  appearance: Appearance
  setAppearance(a: Appearance): void
  /** Whether a panel is shown: open, in front in its group, and not folded. */
  panelOpen(id: PanelId): boolean
  /** Shows a panel that isn't shown, and closes one that is. */
  togglePanel(id: PanelId): void
  resetWorkspace(): void
  /** The workspace in use (a task workspace's id or one of your own), its name, and whether it's still as designed. */
  workspace(): string
  workspaceName(): string
  workspacePristine(): boolean
  setWorkspace(id: string): void
  /** Your own workspaces, in the order they were made. */
  customWorkspaces(): { id: string; name: string }[]
  /** Saves where the panels are into the workspace of yours in use. */
  saveWorkspaceChanges(): void
  /** Saves the workspace in use as a file, with your keyboard shortcuts. */
  exportWorkspace(): void
  /** Asks for a workspace file, and then what to do with it. */
  importWorkspace(): void
  screenMode(): ScreenMode
  setScreenMode(m: ScreenMode): void
  /** Tab: whether the bars and panels are hidden; Shift+Tab: the dock alone. */
  panelsHidden(): boolean
  dockHidden(): boolean
  hidePanels(which: 'all' | 'dock'): void
  /** Whether Tab hides the panels (Edit → Interface), or only moves the focus. */
  tabHides(): boolean
  openDialog(id: DialogId): void
  openPalette(): void
  fullscreen(): boolean
  toggleFullscreen(): void

  /** Whether a document is open and in front. */
  hasDoc(): boolean
  /** Whether File System Access is there, so Open Recent has something to list. */
  hasRecent(): boolean
  open(): void
  save(): void
  saveAs(): void
  close(): void
  undoLabel(): string | null
  redoLabel(): string | null
  undo(): void
  redo(): void

  /** The selected layer's id, if any. */
  selectedLayer(): string | null
  /** The selected layer's kind, if any. */
  selectedKind(): string | null
  newGroup(): void
  newPixelLayer(): void
  fill(which: 'fg' | 'bg'): void
  swapColours(): void
  resetColours(): void
  deleteLayer(): void
  renameLayer(): void
  shiftLayer(step: 1 | -1): void
  canShiftLayer(step: 1 | -1): boolean
  toggleLayerVisible(): void

  /** Import an image as a new layer: asks for the file. */
  place(): void
  /** One of the actions in AppAction. */
  act(a: AppAction): void
  /** Whether the front document has alpha channels (saved selections) to load. */
  hasChannels(): boolean

  /** Whether Copy (or Copy Merged) has something to take in the front document. */
  canCopy(merged: boolean): boolean
  /** Copy, Cut or Copy Merged; false when there was nothing to copy. */
  copy(o: { cut?: boolean; merged?: boolean }): boolean
  /** Paste, from the clipboard (the browser asks to read it, from a menu). */
  paste(how: 'paste' | 'in-place' | 'into' | 'outside'): void
  newFromClipboard(): void
  /** Layer via Copy or Cut: the selected pixels into a new layer; Duplicate Layer with none selected. */
  layerVia(cut: boolean): void
  duplicateLayer(): void
  copyStyle(): void
  pasteStyle(): void
  /** Whether a layer style has been copied. */
  hasStyleClip(): boolean
  zoomIn(): void
  zoomOut(): void
  fitOnScreen(): void
  actualPixels(): void
  rotateView(deg: number): void
  resetRotation(): void
  tool(): ToolId
  setTool(id: ToolId): void
  /** Makes the painting tool's brush a step smaller or larger. */
  resizeBrush(dir: 1 | -1): void
  /** Whether the tool in use paints (the Brush, Eraser, Mixer Brush, Smudge). */
  paints(): boolean
  /** Shift+[ and ]: the painting tool's hardness a quarter softer or harder. */
  hardenBrush(dir: 1 | -1): void
  /** A digit typed with a painting tool: its opacity (or with `flow`, its flow), two quick digits as one number. */
  brushDigit(digit: number, flow: boolean): void

  /** Whether the front document has a selection. */
  hasSelection(): boolean
  canReselect(): boolean
  selectAll(): void
  deselect(): void
  reselect(): void
  inverse(): void
  quickMask(): boolean
  toggleQuickMask(): void
  /** Delete: clears what's selected, or with nothing selected deletes the layer. */
  deleteOrClear(): void
  /** Free Transform, in one of its modes; with one open, changes its mode. */
  freeTransform(mode?: 'free' | 'distort' | 'perspective' | 'warp'): void
  transform(kind: TransformKind): void
  /** A Free Transform, Crop or Polygonal Lasso is open: Enter commits it, Esc cancels it. */
  session(): 'transform' | 'crop' | 'polygon' | 'pen' | 'type' | 'liquify' | null
  /** Filter → Liquify. */
  liquify(): void
  commitSession(): void
  cancelSession(): void
  /** The arrow keys: the layer (or with a selection tool, the selection) by whole pixels. */
  nudge(dx: number, dy: number): void
  /** Whether the selected layer has a pixel mask (the Layer Mask commands' mask). */
  hasMask(): boolean
  maskEnabled(): boolean
  addMask(kind: NewMaskKind): void
  deleteMask(): void
  applyMask(): void
  toggleMask(): void
  invertMask(): void
  /** Whether the selected layer is clipped to the one below it. */
  isClipped(): boolean
  canClip(): boolean
  toggleClip(): void
  rasterize(): void
  cropToSelection(): void

  /** Whether the selected layer is a shape with a shape (or compound shape) right below it. */
  canCombine(): boolean
  /** Layer → Combine Shapes: the selected shape with the one below, into a compound shape. */
  combine(op: 'add' | 'subtract' | 'intersect' | 'exclude'): void
  isCompound(): boolean
  releaseCompound(): void
  expandCompound(): void
  /** How many shapes and compound shapes are selected (Pathfinder wants two). */
  shapeCount(): number
  /** Whether a plain shape (a path or live shape) is selected, which Join, Smooth, Simplify and Outline Stroke work on. */
  isPlainShape(): boolean
  /** Whether the selected layer is a Live Paint group. */
  isLivePaint(): boolean
  /** Object construction: a Pathfinder operation (`pf-<op>`), a path command, or Live Paint's Make and Expand. */
  construct(kind: string): void
  /** Whether the selected layer is a live shape, which Convert to Path makes a path. */
  isLiveShape(): boolean
  convertToPath(): void
  /** Whether the selected layer is text. */
  isText(): boolean
  createOutlines(): void
  addFonts(): void
  loadSystemFonts(): void
  hasVectorMask(): boolean
  vectorMaskEnabled(): boolean
  addVectorMask(kind: 'reveal-all' | 'hide-all'): void
  deleteVectorMask(): void
  toggleVectorMask(): void

  /** Layer → New Adjustment Layer: one of ADJUSTMENT_DEFS, above the selected layer. */
  newAdjustment(id: string): void
  /** Layer → New Filter Layer: one of FILTER_DEFS, above the selected layer, filtering everything below it. */
  newFilterLayer(id: string): void
  /** Whether the selected layer (or the layer of a selected effect) is one filters go on. */
  canFilter(): boolean
  /** Whether the selected pixel layer has live filters to bake in. */
  hasLiveFilters(): boolean
  applyLiveFilters(): void
  /** Whether the selected layer has layer effects. */
  hasStyle(): boolean
  clearStyle(): void
  toSmartObject(): void
  editContents(): void

  /** The front document's colour mode and depth, for Image → Mode's ticks. */
  docMode(): 'rgb' | 'gray' | 'cmyk' | null
  /** How the document in front repeats, or null with none open. */
  docTiling(): Tiling | null
  setTiling(t: Tiling): void
  docDepth(): 8 | 16 | null
  convertMode(mode: 'rgb' | 'gray' | 'cmyk'): void
  convertDepth(depth: 8 | 16): void
  /** View → Proof Colours and Gamut Warning, for the front document. */
  proofColours(): boolean
  toggleProofColours(): void
  gamutWarning(): boolean
  toggleGamutWarning(): void

  /** View → Split View: whether the front document shows two views side by side, and turning it over. */
  isSplit(): boolean
  toggleSplit(): void
  /** View → Rulers, Show, Snap and Lock Guides: whether each is on, and turning it over. */
  viewAid(k: ViewAid): boolean
  toggleViewAid(k: ViewAid): void
  /** View → Snap To: what snapping lines things up with. */
  snapTo(k: keyof SnapTo): boolean
  toggleSnapTo(k: keyof SnapTo): void
  /** The rulers' units. */
  units(): Unit
  setUnits(u: Unit): void
  /** Whether the front document has guides. */
  hasGuides(): boolean
  clearGuides(): void
  guidesFromShape(): void
  /** What Align lines layers up with. */
  alignTo(): AlignTo
  setAlignTo(a: AlignTo): void
  /** Why Align or Distribute can't run now, or null. */
  alignWhy(): string | null
  distributeWhy(): string | null
  align(op: AlignOp): void
  distribute(op: DistributeOp): void
}

export interface CommandDef {
  id: string
  /** As the palette and the shortcuts list show it. */
  label: string
  /** As the menu shows it, when that depends on the state: "Undo Canvas Size". */
  menuLabel?(ctx: CommandContext): string
  /** The palette and the shortcuts list group by this. */
  category: string
  /**
   * `Mod+Shift+K` style (see input/shortcuts.ts). The first is the one
   * shown. These are the defaults: read a command's keys with `shortcutsOf`,
   * which has your changes (input/keymap.ts).
   */
  shortcut?: string | string[]
  run(ctx: CommandContext): void
  /** A tick in the menu. */
  checked?(ctx: CommandContext): boolean
  enabled?(ctx: CommandContext): boolean
  /**
   * Why it can't run now, in a few words, for the menu's tooltip and the
   * palette. Without one the reason comes from `enabled` (the predicates
   * below carry theirs) or, failing that, from what's selected.
   */
  why?(ctx: CommandContext): string
  /** Runs again while its key is held down (the arrow keys), where most commands run once a press. */
  repeats?: boolean
  /**
   * A plain key that a focused control keeps (Tab moves the focus between
   * them): the command runs from the canvas or with nothing focused.
   */
  focusKey?: boolean
  /**
   * A clipboard command. Its key is left to the browser in a text field (and
   * for text selected on the page); Paste's key runs from the paste event the
   * browser then fires, which carries what's on the clipboard.
   */
  clipboard?: 'copy' | 'cut' | 'paste'
}

/** A command's shortcuts now, as a list: yours where you've changed them (Edit → Keyboard Shortcuts), the registry's otherwise. */
export const shortcutsOf = (c: CommandDef): string[] => keysOf(c, keyChanges())
/** A command's shortcuts as the registry has them. */
export const defaultShortcutsOf = (c: CommandDef): string[] => defaultKeys(c)

/** A command's first key now, written as the registry writes keys; null when it has none. */
export const keyOf = (id: string): string | null => {
  const c = COMMANDS_BY_ID.get(id)
  return (c && shortcutsOf(c)[0]) ?? null
}

/**
 * A tool's keys now: the one that picks it (its own, else its group's) and
 * the one that steps to the next tool in its group, for the toolbar and the
 * tool's card.
 */
export function toolKeys(t: { id: string; group?: string }): { pick: string | null; next: string | null } {
  return { pick: keyOf(`tool.${t.id}`) ?? (t.group ? keyOf(`tool.group-${t.group}`) : null), next: t.group ? keyOf(`tool.next-${t.group}`) : null }
}

/** A test a command can need, with the words for when it fails. */
type Need = ((c: CommandContext) => boolean) & { why(c: CommandContext): string }
const need = (test: (c: CommandContext) => boolean, why: (c: CommandContext) => string): Need => Object.assign(test, { why })

export const NO_DOC = 'Open or make a document first'
const NO_LAYER = 'Select a layer first'

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
const kindName = (c: CommandContext) => KIND_NAMES[c.selectedKind() ?? ''] ?? 'this layer'
/** No document, then no layer, come first; past those, the reason given. */
const docWhy = (c: CommandContext, why: string) => (c.hasDoc() ? why : NO_DOC)
const layerWhy = (c: CommandContext, why: string) => (!c.hasDoc() ? NO_DOC : c.selectedLayer() === null ? NO_LAYER : why)

const hasDoc = need((c) => c.hasDoc(), () => NO_DOC)
const hasLayer = need((c) => c.hasDoc() && c.selectedLayer() !== null, (c) => layerWhy(c, ''))
const hasPixelLayer = need((c) => c.hasDoc() && c.selectedKind() === 'pixel', (c) => layerWhy(c, `Works on a pixel layer, not ${kindName(c)}`))
const hasSelection = need((c) => c.hasDoc() && c.hasSelection(), (c) => docWhy(c, 'Needs a selection: draw one with a selection tool'))
const hasMask = need((c) => hasLayer(c) && c.hasMask(), (c) => layerWhy(c, 'The layer has no layer mask'))
const canTransform = need((c) => hasLayer(c) && c.selectedKind() !== 'mask', (c) => layerWhy(c, 'Not for a mask on its own'))
const PAINTS_WHY = () => 'For the painting tools: Brush, Mixer Brush, Eraser, Smudge'

const NUDGES: [string, string, number, number][] = [
  ['left', 'ArrowLeft', -1, 0],
  ['right', 'ArrowRight', 1, 0],
  ['up', 'ArrowUp', 0, -1],
  ['down', 'ArrowDown', 0, 1],
]

export const COMMANDS: CommandDef[] = [
  // --- file ---
  {
    id: 'file.new',
    label: 'New…',
    category: 'File',
    // Ctrl+N belongs to the browser (a new window) and can't be taken.
    shortcut: 'Mod+Alt+N',
    run: (c) => c.openDialog('new'),
  },
  {
    id: 'file.new-from-clipboard',
    label: 'New from Clipboard',
    category: 'File',
    run: (c) => c.newFromClipboard(),
  },
  {
    id: 'file.open',
    label: 'Open…',
    category: 'File',
    shortcut: 'Mod+O',
    run: (c) => c.open(),
  },
  {
    id: 'file.recent',
    label: 'Open Recent…',
    category: 'File',
    run: (c) => c.openDialog('recent'),
    enabled: (c) => c.hasRecent(),
    why: () => 'Needs a browser that can reopen files where they are (Chrome or Edge)',
  },
  {
    id: 'file.place',
    label: 'Import as Layer…',
    category: 'File',
    // Ctrl+Shift+I opens the browser's developer tools and can't be taken.
    run: (c) => c.place(),
    enabled: hasDoc,
  },
  {
    id: 'file.export',
    label: 'Export…',
    category: 'File',
    // Photoshop's Export As.
    shortcut: 'Mod+Alt+Shift+W',
    run: (c) => c.openDialog('export'),
    enabled: hasDoc,
  },
  {
    id: 'file.save',
    label: 'Save',
    category: 'File',
    shortcut: 'Mod+S',
    run: (c) => c.save(),
    enabled: hasDoc,
  },
  {
    id: 'file.save-as',
    label: 'Save As…',
    category: 'File',
    shortcut: 'Mod+Shift+S',
    run: (c) => c.saveAs(),
    enabled: hasDoc,
  },
  {
    id: 'file.close',
    label: 'Close',
    category: 'File',
    // Ctrl+W closes the browser tab and can't be taken.
    shortcut: 'Mod+Alt+W',
    run: (c) => c.close(),
    enabled: hasDoc,
  },

  // --- edit ---
  {
    id: 'edit.undo',
    label: 'Undo',
    menuLabel: (c) => (c.undoLabel() ? `Undo ${c.undoLabel()}` : 'Undo'),
    category: 'Edit',
    shortcut: 'Mod+Z',
    run: (c) => c.undo(),
    enabled: (c) => c.undoLabel() !== null,
    why: () => 'Nothing to undo',
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    menuLabel: (c) => (c.redoLabel() ? `Redo ${c.redoLabel()}` : 'Redo'),
    category: 'Edit',
    // Ctrl+Y is Proof Colours, as in Photoshop.
    shortcut: 'Mod+Shift+Z',
    run: (c) => c.redo(),
    enabled: (c) => c.redoLabel() !== null,
    why: () => 'Nothing to redo',
  },
  {
    id: 'edit.cut',
    label: 'Cut',
    category: 'Edit',
    shortcut: 'Mod+X',
    clipboard: 'cut',
    run: (c) => void c.copy({ cut: true }),
    enabled: (c) => hasDoc(c) && c.canCopy(false),
    why: (c) => docWhy(c, 'Nothing to cut: select a layer, or pixels on it'),
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    category: 'Edit',
    shortcut: 'Mod+C',
    clipboard: 'copy',
    run: (c) => void c.copy({}),
    enabled: (c) => hasDoc(c) && c.canCopy(false),
    why: (c) => docWhy(c, 'Nothing to copy: select a layer, or pixels on it'),
  },
  {
    id: 'edit.copy-merged',
    label: 'Copy Merged',
    category: 'Edit',
    // Photoshop's Ctrl+Shift+C opens the browser's inspector and can't be taken, so Alt joins it.
    shortcut: 'Mod+Alt+Shift+C',
    run: (c) => void c.copy({ merged: true }),
    enabled: hasDoc,
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    category: 'Edit',
    shortcut: 'Mod+V',
    clipboard: 'paste',
    run: (c) => c.paste('paste'),
  },
  {
    id: 'edit.paste-in-place',
    label: 'Paste in Place',
    category: 'Edit',
    shortcut: 'Mod+Shift+V',
    clipboard: 'paste',
    run: (c) => c.paste('in-place'),
    enabled: hasDoc,
  },
  {
    id: 'edit.paste-into',
    label: 'Paste Into',
    category: 'Edit',
    shortcut: 'Mod+Alt+Shift+V',
    run: (c) => c.paste('into'),
    enabled: hasSelection,
  },
  {
    id: 'edit.paste-outside',
    label: 'Paste Outside',
    category: 'Edit',
    run: (c) => c.paste('outside'),
    enabled: hasSelection,
  },
  {
    id: 'edit.fill-foreground',
    label: 'Fill with Foreground',
    category: 'Edit',
    shortcut: 'Alt+Backspace',
    run: (c) => c.fill('fg'),
    enabled: (c) => hasPixelLayer(c) || hasMask(c),
    why: (c) => layerWhy(c, 'Fills a pixel layer or a mask: select one'),
  },
  {
    id: 'edit.fill-background',
    label: 'Fill with Background',
    category: 'Edit',
    shortcut: 'Mod+Backspace',
    run: (c) => c.fill('bg'),
    enabled: (c) => hasPixelLayer(c) || hasMask(c),
    why: (c) => layerWhy(c, 'Fills a pixel layer or a mask: select one'),
  },
  {
    id: 'edit.fill',
    label: 'Fill…',
    category: 'Edit',
    // Shift+F5, as in Photoshop; the page keeps F-keys from the browser.
    shortcut: 'Shift+F5',
    run: (c) => c.openDialog('fill'),
    enabled: (c) => hasPixelLayer(c) || hasMask(c),
    why: (c) => layerWhy(c, 'Fills a pixel layer or a mask: select one'),
  },
  {
    id: 'edit.define-pattern',
    label: 'Define Pattern…',
    category: 'Edit',
    run: (c) => c.openDialog('definePattern'),
    enabled: hasDoc,
  },
  {
    id: 'edit.delete',
    label: 'Delete',
    menuLabel: (c) => (c.hasSelection() ? 'Clear' : 'Delete Layer'),
    category: 'Edit',
    shortcut: ['Delete', 'Backspace'],
    run: (c) => c.deleteOrClear(),
    enabled: hasLayer,
  },
  {
    id: 'edit.define-brush',
    label: 'Define Brush Preset…',
    category: 'Edit',
    run: (c) => c.openDialog('defineBrush'),
    enabled: hasDoc,
  },
  {
    id: 'edit.import-brushes',
    label: 'Import Brushes…',
    category: 'Edit',
    run: (c) => c.importBrushes(),
  },
  {
    id: 'edit.free-transform',
    label: 'Free Transform',
    category: 'Edit',
    // Ctrl+T is the browser's (a new tab) and can't be taken, so Alt joins it.
    shortcut: 'Mod+Alt+T',
    run: (c) => c.freeTransform(),
    enabled: (c) => canTransform(c) && c.session() !== 'transform',
    why: (c) => layerWhy(c, c.session() === 'transform' ? 'A Free Transform is already open' : 'Not for a mask on its own'),
  },
  ...(
    [
      ['distort', 'Distort'],
      ['perspective', 'Perspective'],
      ['warp', 'Warp'],
    ] as ['distort' | 'perspective' | 'warp', string][]
  ).map(
    ([mode, label]): CommandDef => ({
      id: `edit.transform-${mode}`,
      label,
      category: 'Edit',
      run: (c) => c.freeTransform(mode),
      enabled: (c) => canTransform(c) && (!c.session() || c.session() === 'transform'),
      why: (c) => layerWhy(c, c.session() ? 'Finish the crop or path in progress first (Enter or Esc)' : 'Not for a mask on its own'),
    }),
  ),
  ...(
    [
      ['flip-h', 'Flip Horizontal'],
      ['flip-v', 'Flip Vertical'],
      ['cw', 'Rotate 90° Clockwise'],
      ['ccw', 'Rotate 90° Counter Clockwise'],
      ['180', 'Rotate 180°'],
    ] as [TransformKind, string][]
  ).map(
    ([kind, label]): CommandDef => ({
      id: `edit.transform-${kind}`,
      label,
      category: 'Edit',
      run: (c) => c.transform(kind),
      enabled: (c) => canTransform(c) && !c.session(),
      why: (c) => layerWhy(c, c.session() ? 'Finish the transform, crop or path in progress first (Enter or Esc)' : 'Not for a mask on its own'),
    }),
  ),
  {
    id: 'edit.commit',
    label: 'Commit',
    menuLabel: (c) => (c.session() === 'crop' ? 'Crop' : c.session() === 'polygon' ? 'Close Selection' : c.session() === 'liquify' ? 'Commit Liquify' : 'Commit Transform'),
    category: 'Edit',
    shortcut: 'Enter',
    run: (c) => c.commitSession(),
    enabled: (c) => c.session() !== null,
    why: () => 'Nothing in progress: no transform, crop, polygon or path',
  },
  {
    id: 'edit.cancel',
    label: 'Cancel',
    menuLabel: (c) => (c.session() === 'crop' ? 'Cancel Crop' : c.session() === 'polygon' ? 'Cancel Selection' : c.session() === 'liquify' ? 'Cancel Liquify' : 'Cancel Transform'),
    category: 'Edit',
    shortcut: 'Escape',
    run: (c) => c.cancelSession(),
    enabled: (c) => c.session() !== null,
    why: () => 'Nothing in progress: no transform, crop, polygon or path',
  },
  ...NUDGES.flatMap(([name, key, dx, dy]): CommandDef[] => [
    {
      id: `edit.nudge-${name}`,
      label: `Nudge ${name[0].toUpperCase()}${name.slice(1)}`,
      category: 'Edit',
      shortcut: key,
      run: (c) => c.nudge(dx, dy),
      enabled: hasDoc,
      repeats: true,
    },
    {
      id: `edit.nudge-${name}-10`,
      label: `Nudge ${name[0].toUpperCase()}${name.slice(1)} 10 Pixels`,
      category: 'Edit',
      shortcut: `Shift+${key}`,
      run: (c) => c.nudge(dx * 10, dy * 10),
      enabled: hasDoc,
      repeats: true,
    },
  ]),
  {
    id: 'edit.colour-settings',
    label: 'Colour Settings…',
    category: 'Edit',
    shortcut: 'Mod+Shift+K',
    run: (c) => c.openDialog('colourSettings'),
  },
  {
    id: 'colour.swap',
    label: 'Swap Foreground and Background',
    category: 'Colour',
    shortcut: 'X',
    run: (c) => c.swapColours(),
  },
  {
    id: 'colour.reset',
    label: 'Default Colours',
    category: 'Colour',
    shortcut: 'D',
    run: (c) => c.resetColours(),
  },
  {
    id: 'edit.pen-settings',
    label: 'Pen Settings…',
    category: 'Edit',
    run: (c) => c.openDialog('pen'),
  },
  {
    id: 'edit.interface',
    label: 'Interface…',
    category: 'Edit',
    run: (c) => c.openDialog('interface'),
  },
  {
    id: 'brush.smaller',
    label: 'Smaller Brush',
    category: 'Tools',
    shortcut: '[',
    run: (c) => c.resizeBrush(-1),
  },
  {
    id: 'brush.larger',
    label: 'Larger Brush',
    category: 'Tools',
    shortcut: ']',
    run: (c) => c.resizeBrush(1),
  },
  {
    id: 'brush.softer',
    label: 'Softer Brush',
    category: 'Tools',
    shortcut: 'Shift+[',
    run: (c) => c.hardenBrush(-1),
  },
  {
    id: 'brush.harder',
    label: 'Harder Brush',
    category: 'Tools',
    shortcut: 'Shift+]',
    run: (c) => c.hardenBrush(1),
  },
  // Photoshop's number keys: 1 is 10%, 0 is 100%, two quickly (4, 5) are 45%; with Shift, the flow.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].flatMap((d): CommandDef[] => [
    { id: `brush.opacity-${d}`, label: `Brush Opacity ${d === 0 ? 100 : d * 10}%`, category: 'Tools', shortcut: String(d), run: (c) => c.brushDigit(d, false), enabled: (c) => c.paints(), why: PAINTS_WHY },
    { id: `brush.flow-${d}`, label: `Brush Flow ${d === 0 ? 100 : d * 10}%`, category: 'Tools', shortcut: `Shift+${d}`, run: (c) => c.brushDigit(d, true), enabled: (c) => c.paints(), why: PAINTS_WHY },
  ]),
  {
    id: 'palette.open',
    label: 'Command Palette…',
    category: 'General',
    shortcut: 'Mod+K',
    run: (c) => c.openPalette(),
  },

  // --- document ---
  {
    id: 'doc.canvas-size',
    label: 'Canvas Size…',
    category: 'Document',
    shortcut: 'Mod+Alt+C',
    run: (c) => c.openDialog('canvasSize'),
    enabled: hasDoc,
  },
  {
    id: 'doc.resolution',
    label: 'Resolution…',
    category: 'Document',
    run: (c) => c.openDialog('resolution'),
    enabled: hasDoc,
  },
  {
    id: 'doc.assign-profile',
    label: 'Assign Profile…',
    category: 'Document',
    run: (c) => c.openDialog('assignProfile'),
    enabled: hasDoc,
  },
  {
    id: 'doc.convert-profile',
    label: 'Convert to Profile…',
    category: 'Document',
    run: (c) => c.openDialog('convertProfile'),
    enabled: hasDoc,
  },
  ...(
    [
      ['rgb', 'RGB Colour'],
      ['cmyk', 'CMYK Colour'],
      ['gray', 'Grayscale'],
    ] as const
  ).map(
    ([mode, label]): CommandDef => ({
      id: `doc.mode.${mode}`,
      label,
      category: 'Document',
      run: (c) => c.convertMode(mode),
      checked: (c) => c.docMode() === mode,
      enabled: hasDoc,
    }),
  ),
  ...TILING_ITEMS.map(
    (t): CommandDef => ({
      id: `doc.tiled.${t.id}`,
      label: t.label,
      menuLabel: () => t.menu,
      category: 'Document',
      run: (c) => c.setTiling(t.id),
      checked: (c) => c.docTiling() === t.id,
      enabled: hasDoc,
    }),
  ),
  {
    id: 'view.tiled-view',
    label: 'Tiled View',
    category: 'View',
    run: (c) => c.toggleViewAid('tiledView'),
    checked: (c) => c.viewAid('tiledView'),
    enabled: (c) => c.hasDoc() && c.docTiling() !== 'off',
    why: (c) => (c.hasDoc() ? 'The document isn’t tiled: choose Document → Tiled' : NO_DOC),
  },
  ...([8, 16] as const).map(
    (depth): CommandDef => ({
      id: `doc.depth.${depth}`,
      label: `${depth} Bits/Channel`,
      category: 'Document',
      run: (c) => c.convertDepth(depth),
      checked: (c) => c.docDepth() === depth,
      enabled: hasDoc,
    }),
  ),
  {
    id: 'view.proof-setup',
    label: 'Proof Setup…',
    category: 'View',
    run: (c) => c.openDialog('proofSetup'),
    enabled: hasDoc,
  },
  {
    id: 'view.proof-colours',
    label: 'Proof Colours',
    category: 'View',
    shortcut: 'Mod+Y',
    run: (c) => c.toggleProofColours(),
    checked: (c) => c.proofColours(),
    enabled: hasDoc,
  },
  {
    id: 'view.gamut-warning',
    label: 'Gamut Warning',
    category: 'View',
    shortcut: 'Mod+Shift+Y',
    run: (c) => c.toggleGamutWarning(),
    checked: (c) => c.gamutWarning(),
    enabled: hasDoc,
  },
  {
    id: 'doc.crop',
    label: 'Crop to Selection',
    category: 'Document',
    run: (c) => c.cropToSelection(),
    enabled: hasSelection,
  },
  {
    id: 'doc.rename',
    label: 'Rename Document…',
    category: 'Document',
    run: (c) => c.openDialog('renameDoc'),
    enabled: hasDoc,
  },

  // --- layer ---
  {
    id: 'layer.new-pixel',
    label: 'New Pixel Layer',
    category: 'Layer',
    // Ctrl+Shift+N is the browser's (a private window), so Alt joins it.
    shortcut: 'Mod+Alt+Shift+N',
    run: (c) => c.newPixelLayer(),
    enabled: hasDoc,
  },
  {
    id: 'layer.new-group',
    label: 'New Group',
    category: 'Layer',
    run: (c) => c.newGroup(),
    enabled: hasDoc,
  },
  {
    id: 'layer.fill-solid',
    label: 'Solid Colour',
    category: 'New Fill Layer',
    run: (c) => c.act('fill-layer-solid'),
    enabled: hasDoc,
  },
  {
    id: 'layer.fill-gradient',
    label: 'Gradient',
    category: 'New Fill Layer',
    run: (c) => c.act('fill-layer-gradient'),
    enabled: hasDoc,
  },
  {
    id: 'layer.fill-pattern',
    label: 'Pattern',
    category: 'New Fill Layer',
    run: (c) => c.act('fill-layer-pattern'),
    enabled: hasDoc,
  },
  {
    id: 'layer.duplicate',
    label: 'Duplicate Layer',
    category: 'Layer',
    run: (c) => c.duplicateLayer(),
    enabled: (c) => hasLayer(c) && c.selectedKind() !== 'mask',
    why: (c) => layerWhy(c, 'A mask is duplicated with its layer'),
  },
  {
    id: 'layer.via-copy',
    label: 'Layer via Copy',
    category: 'Layer',
    shortcut: 'Mod+J',
    run: (c) => c.layerVia(false),
    enabled: hasLayer,
  },
  {
    id: 'layer.via-cut',
    label: 'Layer via Cut',
    category: 'Layer',
    // Photoshop's Ctrl+Shift+J opens the browser's console and can't be taken.
    run: (c) => c.layerVia(true),
    enabled: (c) => hasSelection(c) && hasLayer(c),
    why: (c) => (hasSelection(c) ? layerWhy(c, '') : hasSelection.why(c)),
  },
  {
    id: 'layer.rename',
    label: 'Rename Layer',
    category: 'Layer',
    shortcut: 'F2',
    run: (c) => c.renameLayer(),
    enabled: hasLayer,
  },
  {
    id: 'layer.toggle-visible',
    label: 'Show or Hide Layer',
    category: 'Layer',
    shortcut: 'Mod+,',
    run: (c) => c.toggleLayerVisible(),
    enabled: hasLayer,
  },
  {
    id: 'layer.raise',
    label: 'Move Layer Up',
    category: 'Layer',
    shortcut: 'Mod+]',
    run: (c) => c.shiftLayer(1),
    enabled: (c) => hasLayer(c) && c.canShiftLayer(1),
    why: (c) => layerWhy(c, 'Already at the top of its group'),
  },
  {
    id: 'layer.lower',
    label: 'Move Layer Down',
    category: 'Layer',
    shortcut: 'Mod+[',
    run: (c) => c.shiftLayer(-1),
    enabled: (c) => hasLayer(c) && c.canShiftLayer(-1),
    why: (c) => layerWhy(c, 'Already at the bottom of its group'),
  },
  {
    id: 'layer.delete',
    label: 'Delete Layer',
    category: 'Layer',
    run: (c) => c.deleteLayer(),
    enabled: hasLayer,
  },
  ...(
    [
      ['reveal-all', 'Reveal All'],
      ['hide-all', 'Hide All'],
      ['reveal-selection', 'Reveal Selection'],
      ['hide-selection', 'Hide Selection'],
    ] as [NewMaskKind, string][]
  ).map(
    ([kind, label]): CommandDef => ({
      id: `layer.mask-${kind}`,
      label,
      category: 'Layer Mask',
      run: (c) => c.addMask(kind),
      enabled: (c) => canTransform(c) && !c.hasMask() && (!kind.endsWith('selection') || c.hasSelection()),
      why: (c) => layerWhy(c, c.hasMask() ? 'The layer already has a layer mask' : kind.endsWith('selection') && !c.hasSelection() ? 'Needs a selection to make the mask from' : 'Not for a mask on its own'),
    }),
  ),
  {
    id: 'layer.mask-delete',
    label: 'Delete Layer Mask',
    category: 'Layer Mask',
    run: (c) => c.deleteMask(),
    enabled: hasMask,
  },
  {
    id: 'layer.mask-apply',
    label: 'Apply Layer Mask',
    category: 'Layer Mask',
    run: (c) => c.applyMask(),
    enabled: (c) => hasMask(c) && c.selectedKind() === 'pixel',
    why: (c) => (hasMask(c) ? 'Applies to a pixel layer’s mask; rasterize the layer first' : hasMask.why(c)),
  },
  {
    id: 'layer.mask-toggle',
    label: 'Disable Layer Mask',
    menuLabel: (c) => (c.hasMask() && !c.maskEnabled() ? 'Enable Layer Mask' : 'Disable Layer Mask'),
    category: 'Layer Mask',
    run: (c) => c.toggleMask(),
    enabled: hasMask,
  },
  {
    id: 'layer.mask-invert',
    label: 'Invert Layer Mask',
    category: 'Layer Mask',
    run: (c) => c.invertMask(),
    enabled: hasMask,
  },
  {
    id: 'layer.clip',
    label: 'Create Clipping Mask',
    menuLabel: (c) => (c.isClipped() ? 'Release Clipping Mask' : 'Create Clipping Mask'),
    category: 'Layer',
    shortcut: 'Mod+Alt+G',
    run: (c) => c.toggleClip(),
    enabled: (c) => hasLayer(c) && (c.isClipped() || c.canClip()),
    why: (c) => layerWhy(c, 'Needs a layer below to clip to'),
  },
  ...ADJUSTMENT_DEFS.map(
    (a): CommandDef => ({
      id: `layer.adjust-${a.id}`,
      label: a.label,
      category: 'New Adjustment Layer',
      run: (c) => c.newAdjustment(a.id),
      enabled: hasDoc,
    }),
  ),
  ...FILTER_DEFS.filter((f) => !f.hidden && !f.warp && !f.remap).map(
    (f): CommandDef => ({
      id: `layer.filter-${f.id}`,
      label: f.label,
      category: 'New Filter Layer',
      run: (c) => c.newFilterLayer(f.id),
      enabled: hasDoc,
    }),
  ),
  ...ADJUSTMENT_DEFS.map(
    (a): CommandDef => ({
      id: `doc.adjust-${a.id}`,
      label: `${a.label}…`,
      category: 'Adjustments',
      run: (c) => c.openDialog(`adjust:${a.id}`),
      enabled: (c) => c.hasDoc() && c.canFilter(),
      why: (c) => layerWhy(c, `Adjustments go on pixel layers, smart objects, shapes and text, not ${kindName(c)}`),
    }),
  ),
  {
    id: 'layer.style',
    label: 'Layer Style…',
    category: 'Layer',
    run: (c) => c.openDialog('layerStyle'),
    enabled: (c) => hasLayer(c) && c.selectedKind() !== 'adjustment' && c.selectedKind() !== 'filter',
    why: (c) => layerWhy(c, `Not for ${kindName(c)}`),
  },
  {
    id: 'layer.clear-style',
    label: 'Clear Layer Style',
    category: 'Layer',
    run: (c) => c.clearStyle(),
    enabled: (c) => hasLayer(c) && c.hasStyle(),
    why: (c) => layerWhy(c, 'The layer has no layer style'),
  },
  {
    id: 'layer.copy-style',
    label: 'Copy Layer Style',
    category: 'Layer',
    run: (c) => c.copyStyle(),
    enabled: (c) => hasLayer(c) && c.hasStyle(),
    why: (c) => layerWhy(c, 'The layer has no layer style to copy'),
  },
  {
    id: 'layer.paste-style',
    label: 'Paste Layer Style',
    category: 'Layer',
    run: (c) => c.pasteStyle(),
    enabled: (c) => hasLayer(c) && c.hasStyleClip() && c.selectedKind() !== 'adjustment' && c.selectedKind() !== 'filter' && c.selectedKind() !== 'mask',
    why: (c) => layerWhy(c, c.hasStyleClip() ? `Not for ${kindName(c)}` : 'No layer style copied yet: Copy Layer Style first'),
  },
  {
    id: 'layer.smart-convert',
    label: 'Convert to Smart Object',
    category: 'Smart Objects',
    run: (c) => c.toSmartObject(),
    enabled: (c) => hasLayer(c) && c.selectedKind() !== 'adjustment' && c.selectedKind() !== 'filter',
    why: (c) => layerWhy(c, `Not for ${kindName(c)}`),
  },
  {
    id: 'layer.smart-edit',
    label: 'Edit Contents',
    category: 'Smart Objects',
    run: (c) => c.editContents(),
    enabled: (c) => c.hasDoc() && c.selectedKind() === 'embedded',
    why: (c) => layerWhy(c, 'Select a smart object first'),
  },
  ...FILTER_DEFS.filter((f) => !f.hidden).map(
    (f): CommandDef => ({
      id: `filter.${f.id}`,
      label: `${f.label}…`,
      category: 'Filter',
      run: (c) => c.openDialog(`filter:${f.id}`),
      enabled: (c) => c.hasDoc() && c.canFilter(),
      why: (c) => layerWhy(c, `Filters go on pixel layers, smart objects, shapes and text, not ${kindName(c)}`),
    }),
  ),
  {
    id: 'filter.liquify',
    label: 'Liquify',
    category: 'Filter',
    // Photoshop's Ctrl+Shift+X is the browser's (Cut, with Shift), so Alt stands in for Shift.
    shortcut: 'Mod+Alt+X',
    run: (c) => c.liquify(),
    enabled: (c) => c.hasDoc() && c.canFilter() && !c.session(),
    why: (c) => layerWhy(c, c.session() ? 'Finish the transform, crop or path in progress first (Enter or Esc)' : `Liquify works on pixel layers, smart objects, shapes and text, not ${kindName(c)}`),
  },
  {
    id: 'filter.apply-live',
    label: 'Apply Live Filters',
    category: 'Filter',
    run: (c) => c.applyLiveFilters(),
    enabled: (c) => c.hasDoc() && c.hasLiveFilters(),
    why: (c) => layerWhy(c, 'The layer has no live filters'),
  },
  {
    id: 'layer.rasterize',
    label: 'Rasterize',
    category: 'Layer',
    run: (c) => c.rasterize(),
    enabled: (c) => hasPixelLayer(c) || (c.hasDoc() && ['embedded', 'vector', 'boolean', 'text', 'fill'].includes(c.selectedKind() ?? '')),
    why: (c) => layerWhy(c, `Already pixels, or nothing to rasterize in ${kindName(c)}`),
  },
  ...(
    [
      ['add', 'Unite Shapes'],
      ['subtract', 'Subtract Front Shape'],
      ['intersect', 'Intersect Shapes'],
      ['exclude', 'Exclude Overlapping Shapes'],
    ] as const
  ).map(
    ([op, label]): CommandDef => ({
      id: `layer.combine-${op}`,
      label,
      category: 'Combine Shapes',
      run: (c) => c.combine(op),
      enabled: (c) => c.hasDoc() && c.canCombine(),
      why: (c) => layerWhy(c, 'Select a shape with another shape right below it'),
    }),
  ),
  ...(
    [
      ['unite', 'Unite'],
      ['minus-front', 'Minus Front'],
      ['intersect', 'Intersect'],
      ['exclude', 'Exclude'],
      ['divide', 'Divide'],
      ['trim', 'Trim'],
      ['merge', 'Merge'],
      ['crop', 'Crop'],
      ['minus-back', 'Minus Back'],
    ] as [string, string][]
  ).map(
    ([op, label]): CommandDef => ({
      id: `shape.pf-${op}`,
      label,
      category: 'Pathfinder',
      run: (c) => c.construct(`pf-${op}`),
      enabled: (c) => c.hasDoc() && c.shapeCount() >= 2,
      why: () => 'Select two or more shapes',
    }),
  ),
  ...(
    [
      ['outline-stroke', 'Outline Stroke'],
      ['join', 'Join'],
      ['smooth', 'Smooth'],
    ] as [string, string][]
  ).map(
    ([kind, label]): CommandDef => ({
      id: `shape.${kind}`,
      label,
      category: 'Path',
      run: (c) => c.construct(kind),
      enabled: (c) => c.hasDoc() && c.isPlainShape(),
      why: () => 'Select a shape (expand a compound shape first)',
    }),
  ),
  {
    id: 'shape.offset-path',
    label: 'Offset Path…',
    category: 'Path',
    run: (c) => c.openDialog('offsetPath'),
    enabled: (c) => c.hasDoc() && c.shapeCount() >= 1,
    why: () => 'Select a shape or a compound shape',
  },
  {
    id: 'shape.simplify',
    label: 'Simplify…',
    category: 'Path',
    run: (c) => c.openDialog('simplify'),
    enabled: (c) => c.hasDoc() && c.isPlainShape(),
    why: () => 'Select a shape (expand a compound shape first)',
  },
  {
    id: 'shape.live-make',
    label: 'Make',
    category: 'Live Paint',
    run: (c) => c.construct('live-make'),
    enabled: (c) => c.hasDoc() && c.shapeCount() >= 1 && !c.isLivePaint(),
    why: () => 'Select shapes to make a Live Paint group of',
  },
  {
    id: 'shape.live-expand',
    label: 'Expand',
    category: 'Live Paint',
    run: (c) => c.construct('live-expand'),
    enabled: (c) => c.hasDoc() && c.isLivePaint(),
    why: () => 'Select a Live Paint group',
  },
  {
    id: 'layer.compound-release',
    label: 'Release Compound Shape',
    category: 'Combine Shapes',
    run: (c) => c.releaseCompound(),
    enabled: (c) => c.hasDoc() && c.isCompound(),
    why: (c) => layerWhy(c, 'Select a compound shape first'),
  },
  {
    id: 'layer.compound-expand',
    label: 'Expand Compound Shape',
    category: 'Combine Shapes',
    run: (c) => c.expandCompound(),
    enabled: (c) => c.hasDoc() && c.isCompound(),
    why: (c) => layerWhy(c, 'Select a compound shape first'),
  },
  {
    id: 'layer.convert-path',
    label: 'Convert to Path',
    category: 'Layer',
    run: (c) => c.convertToPath(),
    enabled: (c) => c.hasDoc() && c.isLiveShape(),
    why: (c) => layerWhy(c, 'Select a live shape (rectangle, ellipse, polygon, star or line) first'),
  },
  {
    id: 'type.create-outlines',
    label: 'Create Outlines',
    category: 'Type',
    run: (c) => c.createOutlines(),
    enabled: (c) => c.hasDoc() && c.isText(),
    why: (c) => layerWhy(c, 'Select a text layer first'),
  },
  {
    id: 'type.add-fonts',
    label: 'Add Fonts…',
    category: 'Type',
    run: (c) => c.addFonts(),
  },
  {
    id: 'type.system-fonts',
    label: 'Load System Fonts',
    category: 'Type',
    run: (c) => c.loadSystemFonts(),
  },
  {
    id: 'layer.vmask-reveal-all',
    label: 'Reveal All',
    category: 'Vector Mask',
    run: (c) => c.addVectorMask('reveal-all'),
    enabled: (c) => canTransform(c) && !c.hasVectorMask(),
    why: (c) => layerWhy(c, c.hasVectorMask() ? 'The layer already has a vector mask' : 'Not for a mask on its own'),
  },
  {
    id: 'layer.vmask-hide-all',
    label: 'Hide All',
    category: 'Vector Mask',
    run: (c) => c.addVectorMask('hide-all'),
    enabled: (c) => canTransform(c) && !c.hasVectorMask(),
    why: (c) => layerWhy(c, c.hasVectorMask() ? 'The layer already has a vector mask' : 'Not for a mask on its own'),
  },
  {
    id: 'layer.vmask-delete',
    label: 'Delete Vector Mask',
    category: 'Vector Mask',
    run: (c) => c.deleteVectorMask(),
    enabled: (c) => hasLayer(c) && c.hasVectorMask(),
    why: (c) => layerWhy(c, 'The layer has no vector mask'),
  },
  {
    id: 'layer.vmask-toggle',
    label: 'Disable Vector Mask',
    menuLabel: (c) => (c.hasVectorMask() && !c.vectorMaskEnabled() ? 'Enable Vector Mask' : 'Disable Vector Mask'),
    category: 'Vector Mask',
    run: (c) => c.toggleVectorMask(),
    enabled: (c) => hasLayer(c) && c.hasVectorMask(),
    why: (c) => layerWhy(c, 'The layer has no vector mask'),
  },

  // --- select ---
  {
    id: 'select.all',
    label: 'All',
    category: 'Select',
    shortcut: 'Mod+A',
    run: (c) => c.selectAll(),
    enabled: hasDoc,
  },
  {
    id: 'select.deselect',
    label: 'Deselect',
    category: 'Select',
    shortcut: 'Mod+D',
    run: (c) => c.deselect(),
    enabled: hasSelection,
  },
  {
    id: 'select.reselect',
    label: 'Reselect',
    category: 'Select',
    shortcut: 'Mod+Shift+D',
    run: (c) => c.reselect(),
    enabled: (c) => c.hasDoc() && c.canReselect(),
    why: (c) => docWhy(c, 'No earlier selection to bring back'),
  },
  {
    id: 'select.inverse',
    label: 'Inverse',
    category: 'Select',
    // Photoshop's Ctrl+Shift+I opens the browser's developer tools; Shift+F7 is its other key for this.
    shortcut: 'Shift+F7',
    run: (c) => c.inverse(),
    enabled: hasDoc,
  },
  {
    id: 'select.feather',
    label: 'Feather…',
    category: 'Select',
    shortcut: 'Shift+F6',
    run: (c) => c.openDialog('feather'),
    enabled: hasSelection,
  },
  {
    id: 'select.expand',
    label: 'Expand…',
    category: 'Select',
    run: (c) => c.openDialog('expand'),
    enabled: hasSelection,
  },
  {
    id: 'select.contract',
    label: 'Contract…',
    category: 'Select',
    run: (c) => c.openDialog('contract'),
    enabled: hasSelection,
  },
  {
    id: 'select.border',
    label: 'Border…',
    category: 'Select',
    run: (c) => c.openDialog('border'),
    enabled: hasSelection,
  },
  {
    id: 'select.smooth',
    label: 'Smooth…',
    category: 'Select',
    run: (c) => c.openDialog('smooth'),
    enabled: hasSelection,
  },
  {
    id: 'select.grow',
    label: 'Grow',
    category: 'Select',
    run: (c) => c.act('grow'),
    enabled: hasSelection,
  },
  {
    id: 'select.similar',
    label: 'Similar',
    category: 'Select',
    run: (c) => c.act('similar'),
    enabled: hasSelection,
  },
  {
    id: 'select.transform',
    label: 'Transform Selection',
    category: 'Select',
    run: (c) => c.act('transform-selection'),
    enabled: (c) => hasSelection(c) && !c.session(),
    why: (c) => (hasSelection(c) ? 'Finish the transform, crop or path in progress first (Enter or Esc)' : hasSelection.why(c)),
  },
  {
    id: 'select.colour-range',
    label: 'Colour Range…',
    category: 'Select',
    run: (c) => c.openDialog('colourRange'),
    enabled: hasDoc,
  },
  {
    id: 'select.save',
    label: 'Save Selection…',
    category: 'Select',
    run: (c) => c.openDialog('saveSelection'),
    enabled: hasSelection,
  },
  {
    id: 'select.load',
    label: 'Load Selection…',
    category: 'Select',
    run: (c) => c.openDialog('loadSelection'),
    enabled: (c) => hasDoc(c) && c.hasChannels(),
    why: (c) => docWhy(c, 'No saved selections yet: Select → Save Selection keeps one'),
  },
  {
    id: 'select.mask',
    label: 'Select and Mask…',
    category: 'Select',
    shortcut: 'Mod+Alt+R',
    run: (c) => c.openDialog('selectMask'),
    enabled: hasSelection,
  },
  {
    id: 'select.quick-mask',
    label: 'Quick Mask',
    category: 'Select',
    shortcut: 'Q',
    run: (c) => c.toggleQuickMask(),
    checked: (c) => c.quickMask(),
    enabled: hasDoc,
  },

  // --- help ---
  {
    id: 'help.shortcuts',
    label: 'Keyboard Shortcuts…',
    category: 'Edit',
    // Photoshop's, and the one Plexel had before shortcuts could be changed.
    shortcut: ['Mod+Alt+Shift+K', 'Mod+/'],
    run: (c) => c.openDialog('shortcuts'),
  },
  {
    id: 'help.gpu',
    label: 'Graphics Information…',
    category: 'Help',
    run: (c) => c.openDialog('gpu'),
  },
  {
    id: 'help.about',
    label: 'About Plexel…',
    category: 'Help',
    run: (c) => c.openDialog('about'),
  },

  {
    id: 'view.split',
    label: 'Split View',
    category: 'View',
    run: (c) => c.toggleSplit(),
    checked: (c) => c.isSplit(),
    enabled: hasDoc,
  },
  // --- rulers, guides, grids, snapping ---
  {
    id: 'view.rulers',
    label: 'Rulers',
    category: 'View',
    shortcut: 'Mod+R',
    run: (c) => c.toggleViewAid('rulers'),
    checked: (c) => c.viewAid('rulers'),
  },
  ...UNITS.map(
    (u): CommandDef => ({
      id: `view.units.${u.id}`,
      label: `Ruler Units: ${u.label}`,
      menuLabel: () => u.label,
      category: 'View',
      run: (c) => c.setUnits(u.id),
      checked: (c) => c.units() === u.id,
    }),
  ),
  {
    id: 'view.show-guides',
    label: 'Guides',
    category: 'View',
    shortcut: 'Mod+;',
    run: (c) => c.toggleViewAid('guides'),
    checked: (c) => c.viewAid('guides'),
  },
  {
    id: 'view.show-grid',
    label: 'Grid',
    category: 'View',
    shortcut: "Mod+'",
    run: (c) => c.toggleViewAid('grid'),
    checked: (c) => c.viewAid('grid'),
  },
  {
    id: 'view.show-pixel-grid',
    label: 'Pixel Grid',
    category: 'View',
    run: (c) => c.toggleViewAid('pixelGrid'),
    checked: (c) => c.viewAid('pixelGrid'),
  },
  {
    id: 'view.smart-guides',
    label: 'Smart Guides',
    category: 'View',
    shortcut: 'Mod+U',
    run: (c) => c.toggleViewAid('smartGuides'),
    checked: (c) => c.viewAid('smartGuides'),
  },
  {
    id: 'view.snap',
    label: 'Snap',
    category: 'View',
    shortcut: 'Mod+Shift+;',
    run: (c) => c.toggleViewAid('snap'),
    checked: (c) => c.viewAid('snap'),
  },
  ...SNAP_TARGETS.map(
    (t): CommandDef => ({
      id: `view.snap-to.${t.id}`,
      label: `Snap To ${t.label}`,
      menuLabel: () => t.label,
      category: 'View',
      run: (c) => c.toggleSnapTo(t.id),
      checked: (c) => c.snapTo(t.id),
      enabled: (c) => c.viewAid('snap'),
      why: () => 'Snapping is off: View → Snap',
    }),
  ),
  {
    id: 'view.lock-guides',
    label: 'Lock Guides',
    category: 'View',
    shortcut: 'Mod+Alt+;',
    run: (c) => c.toggleViewAid('lockGuides'),
    checked: (c) => c.viewAid('lockGuides'),
  },
  {
    id: 'view.clear-guides',
    label: 'Clear Guides',
    category: 'View',
    run: (c) => c.clearGuides(),
    enabled: need((c) => c.hasDoc() && c.hasGuides(), (c) => docWhy(c, 'The document has no guides')),
  },
  {
    id: 'view.new-guide',
    label: 'New Guide…',
    category: 'View',
    run: (c) => c.openDialog('newGuide'),
    enabled: hasDoc,
  },
  {
    id: 'view.guide-layout',
    label: 'New Guide Layout…',
    category: 'View',
    run: (c) => c.openDialog('guideLayout'),
    enabled: hasDoc,
  },
  {
    id: 'view.guides-from-shape',
    label: 'New Guides from Shape',
    category: 'View',
    run: (c) => c.guidesFromShape(),
    enabled: hasLayer,
  },
  {
    id: 'edit.guide-settings',
    label: 'Guides, Grid & Snapping…',
    category: 'Edit',
    run: (c) => c.openDialog('guideSettings'),
  },
  ...ALIGN_OPS.map(
    (o): CommandDef => ({
      id: `layer.align.${o.id}`,
      label: `Align ${o.label}`,
      menuLabel: () => o.label,
      category: 'Layer',
      run: (c) => c.align(o.id),
      enabled: (c) => c.alignWhy() === null,
      why: (c) => c.alignWhy() ?? '',
    }),
  ),
  ...DISTRIBUTE_OPS.map(
    (o): CommandDef => ({
      id: `layer.distribute.${o.id}`,
      label: `Distribute ${o.label}`,
      menuLabel: () => o.label,
      category: 'Layer',
      run: (c) => c.distribute(o.id),
      enabled: (c) => c.distributeWhy() === null,
      why: (c) => c.distributeWhy() ?? '',
    }),
  ),
  ...ALIGN_TO.map(
    (a): CommandDef => ({
      id: `layer.align-to.${a.id}`,
      label: `Align To ${a.label}`,
      menuLabel: () => a.label,
      category: 'Layer',
      run: (c) => c.setAlignTo(a.id),
      checked: (c) => c.alignTo() === a.id,
    }),
  ),

  // --- view ---
  {
    id: 'view.zoom-in',
    label: 'Zoom In',
    category: 'View',
    shortcut: 'Mod+=',
    run: (c) => c.zoomIn(),
    enabled: hasDoc,
  },
  {
    id: 'view.zoom-out',
    label: 'Zoom Out',
    category: 'View',
    shortcut: 'Mod+-',
    run: (c) => c.zoomOut(),
    enabled: hasDoc,
  },
  {
    id: 'view.fit',
    label: 'Fit on Screen',
    category: 'View',
    shortcut: 'Mod+0',
    run: (c) => c.fitOnScreen(),
    enabled: hasDoc,
  },
  {
    id: 'view.actual',
    label: '100%',
    category: 'View',
    shortcut: 'Mod+1',
    run: (c) => c.actualPixels(),
    enabled: hasDoc,
  },
  {
    id: 'view.rotate-left',
    label: 'Rotate View Left 15°',
    category: 'View',
    run: (c) => c.rotateView(-15),
    enabled: hasDoc,
  },
  {
    id: 'view.rotate-right',
    label: 'Rotate View Right 15°',
    category: 'View',
    run: (c) => c.rotateView(15),
    enabled: hasDoc,
  },
  {
    id: 'view.reset-rotation',
    label: 'Reset Rotation',
    category: 'View',
    run: (c) => c.resetRotation(),
    enabled: hasDoc,
  },
  ...TOOL_DEFS.map(
    (t): CommandDef => ({
      id: `tool.${t.id}`,
      label: `${t.name} Tool`,
      category: 'Tools',
      // A grouped tool's key belongs to its group (below).
      shortcut: t.group ? undefined : t.shortcut,
      run: (c) => c.setTool(t.id),
      checked: (c) => c.tool() === t.id,
    }),
  ),
  ...[...new Set(TOOL_DEFS.flatMap((t) => (t.group ? [t.group] : [])))].flatMap((g): CommandDef[] => {
    const first = TOOL_DEFS.find((t) => t.group === g)!
    const names = TOOL_DEFS.filter((t) => t.group === g).map((t) => t.name)
    return [
      { id: `tool.group-${g}`, label: `${names.join(' or ')} Tool`, category: 'Tools', shortcut: first.shortcut, run: () => tools().pickGroup(g) },
      { id: `tool.next-${g}`, label: `Next of ${names.join(', ')}`, category: 'Tools', shortcut: first.shortcut ? `Shift+${first.shortcut}` : undefined, run: () => tools().cycleGroup(g) },
    ]
  }),
  {
    id: 'tool.previous',
    label: 'Previous Tool',
    category: 'Tools',
    shortcut: '`',
    run: () => tools().back(),
    enabled: () => tools().hasPrevious(),
    why: () => 'No other tool used yet',
  },
  {
    id: 'view.fullscreen',
    label: 'Browser Full Screen',
    category: 'View',
    // No shortcut: F11 belongs to the browser, and F is the screen modes'.
    run: (c) => c.toggleFullscreen(),
    checked: (c) => c.fullscreen(),
  },
  ...SCREEN_MODES.map(
    (m): CommandDef => ({
      id: `view.screen.${m.id}`,
      label: m.label,
      category: 'View',
      run: (c) => c.setScreenMode(m.id),
      checked: (c) => c.screenMode() === m.id,
    }),
  ),
  {
    id: 'view.screen-next',
    label: 'Next Screen Mode',
    category: 'View',
    shortcut: 'F',
    run: (c) => c.setScreenMode(SCREEN_MODES[(SCREEN_MODES.findIndex((m) => m.id === c.screenMode()) + 1) % SCREEN_MODES.length].id),
  },
  {
    id: 'view.hide-panels',
    label: 'Hide Panels',
    menuLabel: (c) => (c.panelsHidden() ? 'Show Panels' : 'Hide Panels'),
    category: 'View',
    shortcut: 'Tab',
    focusKey: true,
    run: (c) => c.hidePanels('all'),
    enabled: (c) => c.tabHides(),
    why: () => 'Tab only moves the focus: turned off in Edit → Interface',
  },
  {
    id: 'view.hide-dock',
    label: 'Hide the Dock',
    menuLabel: (c) => (c.dockHidden() ? 'Show the Dock' : 'Hide the Dock'),
    category: 'View',
    shortcut: 'Shift+Tab',
    focusKey: true,
    run: (c) => c.hidePanels('dock'),
    enabled: (c) => c.tabHides(),
    why: () => 'Tab only moves the focus: turned off in Edit → Interface',
  },
  ...THEMES.map(
    (t): CommandDef => ({
      id: `appearance.theme.${t.id}`,
      label: t.name,
      category: 'Appearance',
      run: (c) => c.setAppearance({ ...c.appearance, theme: t.id }),
      checked: (c) => c.appearance.theme === t.id,
    }),
  ),
  {
    id: 'appearance.mode.dark',
    label: 'Dark',
    category: 'Appearance',
    run: (c) => c.setAppearance({ ...c.appearance, mode: 'dark' }),
    checked: (c) => c.appearance.mode === 'dark',
  },
  {
    id: 'appearance.mode.light',
    label: 'Light',
    category: 'Appearance',
    run: (c) => c.setAppearance({ ...c.appearance, mode: 'light' }),
    checked: (c) => c.appearance.mode === 'light',
  },
  {
    id: 'appearance.mode.toggle',
    label: 'Switch Dark and Light',
    category: 'Appearance',
    shortcut: 'Mod+Shift+L',
    run: (c) => c.setAppearance({ ...c.appearance, mode: c.appearance.mode === 'dark' ? 'light' : 'dark' }),
  },

  // --- window ---
  ...PANELS.map(
    (p): CommandDef => ({
      id: `window.panel.${p.id}`,
      label: p.title,
      category: 'Window',
      ...(p.shortcut ? { shortcut: p.shortcut } : {}),
      run: (c) => c.togglePanel(p.id),
      checked: (c) => c.panelOpen(p.id),
    }),
  ),
  ...WORKSPACES.map(
    (w): CommandDef => ({
      id: `window.workspace.${w.id}`,
      label: `${w.name} Workspace`,
      menuLabel: () => w.name,
      category: 'Window',
      run: (c) => c.setWorkspace(w.id),
      checked: (c) => c.workspace() === w.id,
    }),
  ),
  {
    id: 'window.reset',
    label: 'Reset Workspace',
    menuLabel: (c) => `Reset ${c.workspaceName()}`,
    category: 'Window',
    run: (c) => c.resetWorkspace(),
    enabled: (c) => !c.workspacePristine(),
    why: () => 'The workspace is already as it was designed',
  },
  {
    id: 'window.workspace-save',
    label: 'Save Changes to Workspace',
    menuLabel: (c) => (isOwnWorkspace(c) ? `Save Changes to ${c.workspaceName()}` : 'Save Changes to Workspace'),
    category: 'Window',
    run: (c) => c.saveWorkspaceChanges(),
    enabled: (c) => isOwnWorkspace(c) && !c.workspacePristine(),
    why: (c) => (isOwnWorkspace(c) ? 'Nothing has changed since it was saved' : `${c.workspaceName()} is one of Plexel’s own: use New Workspace to keep this layout`),
  },
  {
    id: 'window.workspace-new',
    label: 'New Workspace…',
    category: 'Window',
    run: (c) => c.openDialog('newWorkspace'),
  },
  {
    id: 'window.workspace-manage',
    label: 'Rename and Delete Workspaces…',
    category: 'Window',
    run: (c) => c.openDialog('manageWorkspaces'),
    enabled: (c) => c.customWorkspaces().length > 0,
    why: () => 'There are no workspaces of your own yet: make one with New Workspace',
  },
  {
    id: 'window.workspace-export',
    label: 'Export Workspace…',
    menuLabel: (c) => `Export ${c.workspaceName()}…`,
    category: 'Window',
    run: (c) => c.exportWorkspace(),
  },
  {
    id: 'window.workspace-import',
    label: 'Import Workspace…',
    category: 'Window',
    run: (c) => c.importWorkspace(),
  },
]

const isOwnWorkspace = (c: CommandContext) => c.customWorkspaces().some((w) => w.id === c.workspace())

/**
 * Commands that exist only at run time: one for each workspace of your own,
 * to change to it. The menus list them where MENUS has `{ runtime }`, and
 * the palette with the rest.
 */
export function runtimeCommands(c: CommandContext): CommandDef[] {
  return c.customWorkspaces().map(
    (w): CommandDef => ({
      id: `window.workspace.${w.id}`,
      label: `${w.name} Workspace`,
      menuLabel: () => w.name,
      category: 'Window',
      run: (x) => x.setWorkspace(w.id),
      checked: (x) => x.workspace() === w.id,
    }),
  )
}

/** A command by its id, the run-time ones included. */
export const commandById = (id: string, c: CommandContext): CommandDef | undefined => COMMANDS_BY_ID.get(id) ?? runtimeCommands(c).find((d) => d.id === id)

/** A menu's items with its run-time entries filled in, and no separator left doubled or at an end by an empty one. */
export function expandMenu(items: MenuItem[], c: CommandContext): MenuItem[] {
  const out: MenuItem[] = []
  for (const i of items.flatMap((i): MenuItem[] => ('runtime' in i ? runtimeCommands(c).map((d) => cmd(d.id)) : [i])))
    if (!('separator' in i) || (out.length && !('separator' in out[out.length - 1]))) out.push(i)
  if (out.length && 'separator' in out[out.length - 1]) out.pop()
  return out
}

export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

export type MenuItem = { command: string } | { separator: true } | { submenu: string; items: MenuItem[] } | { runtime: 'workspaces' }

export interface MenuDef {
  id: string
  label: string
  items: MenuItem[]
}

const cmd = (command: string): MenuItem => ({ command })
const SEP: MenuItem = { separator: true }

/** The menu bar, left to right. */
export const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: 'File',
    items: [cmd('file.new'), cmd('file.new-from-clipboard'), cmd('file.open'), cmd('file.recent'), SEP, cmd('file.place'), SEP, cmd('file.save'), cmd('file.save-as'), cmd('file.export'), SEP, cmd('file.close')],
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
      cmd('layer.toggle-visible'),
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
      {
        submenu: 'Combine Shapes',
        items: [cmd('layer.combine-add'), cmd('layer.combine-subtract'), cmd('layer.combine-intersect'), cmd('layer.combine-exclude'), SEP, cmd('layer.compound-release'), cmd('layer.compound-expand')],
      },
      {
        submenu: 'Pathfinder',
        items: [cmd('shape.pf-unite'), cmd('shape.pf-minus-front'), cmd('shape.pf-intersect'), cmd('shape.pf-exclude'), SEP, cmd('shape.pf-divide'), cmd('shape.pf-trim'), cmd('shape.pf-merge'), cmd('shape.pf-crop'), cmd('shape.pf-minus-back')],
      },
      { submenu: 'Path', items: [cmd('shape.outline-stroke'), cmd('shape.offset-path'), SEP, cmd('shape.join'), cmd('shape.simplify'), cmd('shape.smooth')] },
      { submenu: 'Live Paint', items: [cmd('shape.live-make'), cmd('shape.live-expand')] },
      cmd('layer.convert-path'),
      cmd('layer.rasterize'),
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
        pixel: ['layer.mask-reveal-all', 'layer.smart-convert', 'filter.apply-live'],
        vector: ['layer.convert-path', 'layer.rasterize', 'layer.vmask-reveal-all'],
        boolean: ['layer.compound-release', 'layer.compound-expand', 'layer.rasterize'],
        text: ['type.create-outlines', 'layer.rasterize'],
        fill: ['layer.rasterize', 'layer.mask-reveal-all'],
        embedded: ['layer.smart-edit', 'layer.rasterize'],
        group: ['layer.mask-reveal-all'],
      }
      groups.push(['edit.free-transform', 'layer.duplicate', 'layer.rename', 'layer.style', 'layer.clip', ...(byKind[kind] ?? []), 'layer.delete'])
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
export function rulerMenu(): MenuItem[] {
  return [...UNITS.map((u) => cmd(`view.units.${u.id}`)), SEP, cmd('view.show-guides'), cmd('view.lock-guides'), cmd('view.new-guide'), SEP, cmd('view.rulers')]
}

/** The Layers panel's adjustment button: each adjustment layer it can add. */
export function adjustmentMenu(): MenuItem[] {
  return ADJUSTMENT_DEFS.map((a) => cmd(`layer.adjust-${a.id}`))
}
