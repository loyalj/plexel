/** What commands act on (CommandContext), what a command is (CommandDef), and the names they use. */
import type { PanelId } from '../ui/panels'
import type { Appearance } from '../ui/theme'
import type { ToolId } from '../tools'
import type { AlignOp, DistributeOp } from '../geom/align'
import type { AlignTo, SnapTo } from '../app/guidePrefs'
import type { Unit } from '../doc/units'
import type { Tiling } from '../doc/types'

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
  | 'saveForWeb'
  | 'imageTrace'
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
  | 'toolbar'
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
  | 'newSpotChannel'
  | 'channelOptions'

export type NewMaskKind = 'reveal-all' | 'hide-all' | 'reveal-selection' | 'hide-selection'

/** The Channels panel's actions: a channel picked by its place (0 the composite), a new one, the picked one duplicated or deleted, the composite's luminosity loaded. */
export type ChannelAction = { pick: number } | 'new' | 'duplicate' | 'delete' | 'load-luminosity'

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
  /** The Channels panel's actions (app/channelActions.ts). */
  channel(a: ChannelAction): void
  /** Whether an alpha or spot channel is picked in the Channels panel. */
  channelPicked(): boolean
  /** How many channels Ctrl+3 onwards can pick in the front document. */
  channelCount(): number

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
  /** View → Zoom to Selection: the selection's bounds framed. */
  zoomToSelection(): void
  /** View → Zoom to Layer: the selected layer (or layers) framed. */
  zoomToLayer(): void
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
  /** Vector brushes: a new art, scatter or pattern brush from the selected shapes; the brush off the selected strokes; the selected stroke's Brush Options. */
  vectorBrush(action: 'new-art' | 'new-scatter' | 'new-pattern' | 'remove' | 'options'): void
  /** Whether a selected shape's stroke is drawn with a brush. */
  hasBrushStroke(): boolean
  /** Whether the selected layer is pixels Image Trace can trace. */
  canTrace(): boolean
  /** Artboards: a new one, one from the selected layers, one's layers let go of it. */
  artboard(action: 'new' | 'from-layers' | 'release'): void
  /** Whether the selected layer is an artboard or is in one. */
  inArtboard(): boolean
  /** Symbols: New Symbol from the selection, Edit Symbol and Break Link for the selected instance. */
  symbol(action: 'new' | 'edit' | 'break'): void
  /** Whether the selected layers can be made a symbol. */
  canMakeSymbol(): boolean
  /** Whether a symbol instance is selected. */
  instanceSelected(): boolean
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
  category: CommandCategory
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

/** The groups the palette and the shortcuts list put commands in: a misspelt one would make a group of its own. */
export type CommandCategory = 'Adjustments' | 'Appearance' | 'Brushes' | 'Channels' | 'Colour' | 'Combine Shapes' | 'Document' | 'Edit' | 'File' | 'Filter' | 'General' | 'Help' | 'Layer Mask' | 'Layer' | 'Live Paint' | 'New Adjustment Layer' | 'New Fill Layer' | 'New Filter Layer' | 'Path' | 'Pathfinder' | 'Select' | 'Smart Objects' | 'Tools' | 'Type' | 'Vector Mask' | 'View' | 'Window'
