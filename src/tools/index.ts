/**
 * Every tool, declared once (ARCHITECTURE.md, "Tools"). The toolbar, the
 * keyboard, the palette and the options bar read this list; each tool's
 * pointer handling is in the canvas (ui/Viewport.tsx) by its id.
 *
 * `options` is the schema the options bar is generated from: a tool lists
 * the settings it has, and the bar draws the right control for each.
 */
import type { BrushSettings, DynTarget } from '../brush/defs'
import type { PaintTool } from '../app/brushes'
import { Listeners } from '../lib/listeners'

export type ToolId =
  | 'move'
  | 'artboard'
  | 'marquee'
  | 'lasso'
  | 'quick'
  | 'wand'
  | 'crop'
  | 'hand'
  | 'zoom'
  | 'rotate'
  | 'brush'
  | 'mixer'
  | 'eraser'
  | 'smudge'
  | 'clone'
  | 'spot'
  | 'heal'
  | 'patch'
  | 'gradient'
  | 'bucket'
  | 'picker'
  | 'pen'
  | 'curvature'
  | 'width'
  | 'direct'
  | 'shape'
  | 'pencil'
  | 'vbrush'
  | 'blob'
  | 'builder'
  | 'livepaint'
  | 'type'

export type ToolOption =
  /** The brush preset the settings came from. */
  | { kind: 'preset' }
  /** A number setting of the tool's brush. `scale` turns the stored value into what's shown (100 for a percentage). */
  | { kind: 'number'; key: keyof BrushSettings & ('size' | 'hardness' | 'opacity' | 'flow' | 'spacing' | 'smoothing'); label: string; min: number; max: number; unit: string; scale: number; hint: string }
  /** The brush's blend mode. */
  | { kind: 'mode' }
  /** A switch: does pen pressure set this property? */
  | { kind: 'pressure'; target: DynTarget; label: string }
  /** The Colour Picker's sample size. */
  | { kind: 'sample' }
  /** New, add, subtract or intersect: how a selection tool's shape combines with the selection. */
  | { kind: 'select-op' }
  /** A selection tool's feather, in pixels. */
  | { kind: 'feather'; tool: 'marquee' | 'lasso' }
  /** Anti-aliased edges. */
  | { kind: 'antialias'; tool: 'marquee' | 'lasso' | 'wand' }
  /** The Marquee's shape. */
  | { kind: 'marquee-shape' }
  /** Freehand or polygonal. */
  | { kind: 'lasso-mode' }
  /** The Magic Wand's tolerance, contiguous and sample-all switches. */
  | { kind: 'wand' }
  /** The Magnetic Lasso's width, contrast and frequency. */
  | { kind: 'magnetic' }
  /** Quick Selection's brush size, Sample All Layers and Auto-Enhance. */
  | { kind: 'quick' }
  /** The Gradient tool's gradient, style, what it makes, mode and opacity. */
  | { kind: 'gradient' }
  /** The Paint Bucket's fill, mode, opacity, tolerance and switches. */
  | { kind: 'bucket' }
  /** What a Free Transform or Crop in progress is doing, with Commit and Cancel. */
  | { kind: 'session' }
  /** The Shape tool's shape: rectangle, ellipse, polygon, star, line. */
  | { kind: 'shape-type' }
  /** The chosen shape's settings: corners, sides, points. */
  | { kind: 'shape-settings' }
  /** Whether new shapes are filled and stroked, and how wide the stroke is. */
  | { kind: 'shape-paint' }
  /** The Pen's Smart mode. */
  | { kind: 'pen-smart' }
  /** How many anchors Direct Selection has selected. */
  | { kind: 'anchors' }
  /** The Pencil's, the Paintbrush's or the Blob Brush's settings. */
  | { kind: 'freehand'; tool: 'pencil' | 'vbrush' | 'blob' }
  /** The Type tool's font, style and size: the Character panel's, in short. */
  | { kind: 'type-font' }
  /** The Mixer Brush's paint: its combinations, Wet, Load and Mix, Load and Clean, Sample All Layers. */
  | { kind: 'mixer' }
  /** Smudge's Strength, Finger Painting and Sample All Layers. */
  | { kind: 'smudge' }
  /** The Clone Stamp's or the Healing Brush's Aligned and Sample All Layers. */
  | { kind: 'source'; tool: 'clone' | 'heal' }
  /** The Move tool's Align To and its align and distribute buttons. */
  | { kind: 'align' }
  /** The Move tool's Auto-Select and what it picks. */
  | { kind: 'auto-select' }
  /** The Artboard tool's size, its presets, and Add Artboard. */
  | { kind: 'artboard' }

/**
 * A key or gesture a tool answers to, for its tooltip and the status bar's
 * hints. `keys` is written `Shift+Alt`, `[ ]`, `Click` or `Alt+Right-drag`:
 * Shift, Alt and Ctrl light up in the hints while they're held, and print
 * as ⇧, ⌥ and ⌘ on a Mac. `during: 'drag'` is a key that matters once the
 * press has started (Shift for a square), shown only then.
 */
export interface ToolKey {
  keys: string
  does: string
  during?: 'drag'
}

export interface ToolDef {
  id: ToolId
  name: string
  /** One key, as Photoshop has it; none for a tool Photoshop gives none. In a group, the group's key. */
  shortcut?: string
  /** Tools sharing a key, as Photoshop groups them: the key picks the group's last tool, Shift with it the next. */
  group?: string
  /** The canvas's cursor while the tool is chosen (and not in use). */
  cursor: string
  /** What the toolbar's tooltip says beyond the name. */
  hint: string
  /** Its keys and gestures, as the tooltip lists them and the status bar hints them. */
  keys: ToolKey[]
  /** Which brush a painting tool paints with. */
  paints?: PaintTool
  options?: ToolOption[]
}

const brushOptions = (withMode: boolean): ToolOption[] => [
  { kind: 'preset' },
  { kind: 'number', key: 'size', label: 'Size', min: 1, max: 2000, unit: 'px', scale: 1, hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' },
  { kind: 'number', key: 'hardness', label: 'Hardness', min: 0, max: 100, unit: '%', scale: 100, hint: 'How sharp the edge is, from soft to hard. Round tips only.' },
  ...(withMode ? [{ kind: 'mode' } as ToolOption] : []),
  { kind: 'number', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%', scale: 100, hint: 'The most one stroke covers, however often it crosses itself.' },
  { kind: 'number', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%', scale: 100, hint: 'How much each dab adds: low flow builds up as you go over the same place.' },
  { kind: 'number', key: 'spacing', label: 'Spacing', min: 1, max: 200, unit: '%', scale: 100, hint: 'The distance between dabs, as a share of the diameter.' },
  { kind: 'number', key: 'smoothing', label: 'Smoothing', min: 0, max: 95, unit: '%', scale: 100, hint: 'How much the stroke lags behind the pen to steady it.' },
  { kind: 'pressure', target: 'size', label: 'Pressure: size' },
  { kind: 'pressure', target: 'opacity', label: 'Pressure: opacity' },
  { kind: 'pressure', target: 'flow', label: 'Pressure: flow' },
]

const selectOptions = (tool: 'marquee' | 'lasso'): ToolOption[] => [{ kind: 'select-op' }, { kind: 'feather', tool }, { kind: 'antialias', tool }, { kind: 'session' }]

const SELECT_KEYS: ToolKey[] = [
  { keys: 'Shift', does: 'adds to the selection' },
  { keys: 'Alt', does: 'subtracts' },
  { keys: 'Shift+Alt', does: 'intersects' },
]

const PAINT_KEYS: ToolKey[] = [
  { keys: '[ ]', does: 'smaller, larger' },
  { keys: 'Shift+[ ]', does: 'softer, harder' },
  { keys: 'Alt+Right-drag', does: 'size and hardness on the canvas' },
  { keys: 'Shift+Alt+Right-drag', does: 'a colour picker at the pointer' },
  { keys: 'Alt', does: 'picks a colour' },
  { keys: 'Shift+Click', does: 'a straight line from the last stroke' },
]

/** The keys the tooltips list and the status bar hints, tool by tool. */
const TOOL_KEYS: Record<ToolId, ToolKey[]> = {
  move: [
    { keys: 'Drag', does: 'moves the selected layers, or a guide' },
    { keys: 'Ctrl+Click', does: 'selects the layer under the pointer (with Auto-Select on, doesn’t)' },
    { keys: 'Alt+Click', does: 'with Auto-Select (or Ctrl), the next layer down' },
    { keys: 'Shift+Click', does: 'with Auto-Select, adds the layer under the pointer' },
    { keys: 'Arrows', does: 'nudge a pixel, with Shift ten' },
    { keys: 'Shift', does: 'keeps it straight', during: 'drag' },
    { keys: 'Ctrl', does: 'lets go of snapping', during: 'drag' },
  ],
  artboard: [
    { keys: 'Drag', does: 'draws an artboard on the pasteboard, or moves one with its layers' },
    { keys: 'Click', does: 'selects an artboard' },
    { keys: 'Shift', does: 'keeps a move straight', during: 'drag' },
  ],
  marquee: [
    ...SELECT_KEYS,
    { keys: 'Shift', does: 'square or circle', during: 'drag' },
    { keys: 'Alt', does: 'from the centre', during: 'drag' },
  ],
  lasso: [
    ...SELECT_KEYS,
    { keys: 'Alt', does: 'let go of the button with it: straight sides, then let go of Alt to close', during: 'drag' },
    { keys: 'Shift', does: 'polygonal sides at 45°' },
    { keys: 'Backspace', does: 'takes the last corner back' },
    { keys: 'Enter', does: 'closes a polygon' },
    { keys: 'Esc', does: 'cancels' },
  ],
  quick: [
    { keys: 'Drag', does: 'paints the selection out to the edges' },
    { keys: 'Alt', does: 'paints it away' },
    { keys: '[ ]', does: 'smaller, larger' },
  ],
  wand: [{ keys: 'Click', does: 'selects similar pixels' }, ...SELECT_KEYS],
  crop: [
    { keys: 'Drag', does: 'the handles; outside the box straightens' },
    { keys: 'Enter', does: 'crops' },
    { keys: 'Esc', does: 'cancels' },
  ],
  pen: [
    { keys: 'Click', does: 'a corner point' },
    { keys: 'Drag', does: 'a smooth point' },
    { keys: 'Enter', does: 'finishes the path open' },
    { keys: 'Alt', does: 'breaks the handles', during: 'drag' },
  ],
  curvature: [
    { keys: 'Click', does: 'a smooth point' },
    { keys: 'Alt+Click', does: 'a corner point' },
    { keys: 'Double-click', does: 'a point: corner or smooth' },
    { keys: 'Enter', does: 'finishes the path open' },
  ],
  width: [
    { keys: 'Drag', does: 'a stroke: adds a width point and widens it' },
    { keys: 'Drag', does: 'a point’s edge: wider or narrower; its centre: along the path' },
    { keys: 'Shift+Click', does: 'selects several points' },
    { keys: 'Double-click', does: 'a point: its widths in pixels' },
    { keys: 'Delete', does: 'removes the selected points' },
    { keys: 'Alt', does: 'one side only; a copy of the point', during: 'drag' },
  ],
  direct: [
    { keys: 'Shift', does: 'adds points (of any shape) to the selection' },
    { keys: 'Alt+Click', does: 'converts a point' },
    { keys: 'Delete', does: 'removes the selected points' },
    { keys: 'Alt', does: 'breaks a smooth point', during: 'drag' },
  ],
  pencil: [
    { keys: 'Drag', does: 'draws a path as your hand goes' },
    { keys: 'Drag', does: 'from the selected path: redraws it there, or carries it on from an end' },
    { keys: 'Drag', does: 'back to where it started: a closed path' },
  ],
  vbrush: [
    { keys: 'Drag', does: 'paints a path with the chosen vector brush' },
    { keys: 'Drag', does: 'from the selected path: redraws it there' },
  ],
  blob: [
    { keys: 'Drag', does: 'paints a filled shape, joining the shapes of its colour it touches' },
    { keys: '[ ]', does: 'smaller, larger' },
  ],
  shape: [
    { keys: 'Drag', does: 'draws a live shape' },
    { keys: 'Shift', does: 'keeps it square', during: 'drag' },
    { keys: 'Alt', does: 'from the middle', during: 'drag' },
    { keys: 'Ctrl', does: 'lets go of snapping', during: 'drag' },
  ],
  builder: [
    { keys: 'Drag', does: 'merges the regions crossed' },
    { keys: 'Alt', does: 'deletes them instead', during: 'drag' },
  ],
  livepaint: [
    { keys: 'Click', does: 'fills the region' },
    { keys: 'Alt', does: 'empties it' },
  ],
  type: [
    { keys: 'Click', does: 'point text' },
    { keys: 'Drag', does: 'a text box' },
    { keys: 'Alt+Click', does: 'type along a path' },
    { keys: 'Ctrl+Enter', does: 'finishes' },
  ],
  brush: PAINT_KEYS,
  mixer: PAINT_KEYS,
  eraser: PAINT_KEYS,
  smudge: [...PAINT_KEYS.filter((k) => k.keys !== 'Alt'), { keys: '0–9', does: 'strength' }],
  clone: [{ keys: 'Alt+Click', does: 'sets where to copy from' }, { keys: 'Drag', does: 'paints the copy' }, ...PAINT_KEYS.filter((k) => k.keys !== 'Alt')],
  heal: [{ keys: 'Alt+Click', does: 'sets where to take the repair from' }, { keys: 'Drag', does: 'paints it, healed in when you let go' }, ...PAINT_KEYS.filter((k) => k.keys !== 'Alt')],
  spot: [{ keys: 'Drag', does: 'paints over what to remove, filled in when you let go' }, ...PAINT_KEYS.filter((k) => k.keys !== 'Alt' && k.keys !== 'Shift+Click')],
  patch: [
    { keys: 'Drag', does: 'draws round what to repair' },
    { keys: 'Drag', does: 'inside the selection: to where to take the repair from' },
  ],
  gradient: [
    { keys: 'Drag', does: 'lays the gradient from start to end' },
    { keys: 'Shift', does: 'keeps it to 45°', during: 'drag' },
  ],
  bucket: [{ keys: 'Click', does: 'fills similar pixels' }],
  picker: [
    { keys: 'Click', does: 'foreground colour' },
    { keys: 'Alt+Click', does: 'background colour' },
  ],
  hand: [
    { keys: 'Drag', does: 'moves the view' },
    { keys: 'Space', does: 'the Hand with any tool' },
  ],
  zoom: [
    { keys: 'Click', does: 'zooms in' },
    { keys: 'Alt+Click', does: 'zooms out' },
    { keys: 'Drag', does: 'zooms smoothly' },
  ],
  rotate: [
    { keys: 'Drag', does: 'turns the view' },
    { keys: 'Double-click', does: 'puts it straight' },
    { keys: 'Shift', does: 'snaps to 15°', during: 'drag' },
  ],
}

/** While a Free Transform, Crop, polygon, path or text is open, its keys come first. */
export const SESSION_KEYS: Record<'transform' | 'crop' | 'polygon' | 'pen' | 'type' | 'liquify', ToolKey[]> = {
  transform: [
    { keys: 'Enter', does: 'commits' },
    { keys: 'Esc', does: 'cancels' },
    { keys: 'Shift', does: 'frees the proportions, snaps turns to 15°' },
    { keys: 'Alt', does: 'about the centre' },
    { keys: 'Ctrl', does: 'skews from a side, distorts from a corner' },
    { keys: 'Ctrl+Alt+Shift', does: 'perspective from a corner' },
  ],
  liquify: [
    { keys: 'Enter', does: 'commits' },
    { keys: 'Esc', does: 'cancels' },
    { keys: 'Alt', does: 'twirls the other way; Pucker and Bloat swap' },
  ],
  crop: [
    { keys: 'Enter', does: 'crops' },
    { keys: 'Esc', does: 'cancels' },
    { keys: 'Shift', does: 'snaps the straightening to 15°' },
  ],
  polygon: [
    { keys: 'Click', does: 'a corner' },
    { keys: 'Enter', does: 'closes it' },
    { keys: 'Esc', does: 'cancels' },
  ],
  pen: [
    { keys: 'Click', does: 'the first point closes the path' },
    { keys: 'Enter', does: 'finishes it open' },
    { keys: 'Esc', does: 'cancels' },
  ],
  type: [
    { keys: 'Ctrl+Enter', does: 'finishes' },
    { keys: 'Esc', does: 'finishes' },
    { keys: 'Shift+Enter', does: 'a line break' },
  ],
}

/** What works whatever the tool. */
export const GLOBAL_KEYS: ToolKey[] = [
  { keys: 'Space', does: 'Hand' },
  { keys: 'Right-click', does: 'actions' },
]

const DEFS: Omit<ToolDef, 'keys'>[] = [
  {
    id: 'move',
    name: 'Move',
    shortcut: 'V',
    group: 'move',
    cursor: 'move',
    hint: 'Drag to move the selected layers; Shift keeps them straight, Ctrl lets go of snapping. Drag a guide to move it, or off the canvas to remove it. The arrow keys nudge a pixel, Shift ten.',
    options: [{ kind: 'auto-select' }, { kind: 'align' }, { kind: 'session' }],
  },
  {
    id: 'artboard',
    name: 'Artboard',
    shortcut: 'V',
    group: 'move',
    cursor: 'crosshair',
    hint: 'Drag on the pasteboard to draw an artboard; drag one to move it with its layers; drag its handles to size it. The options bar sizes it and adds more.',
    options: [{ kind: 'artboard' }],
  },
  {
    id: 'marquee',
    name: 'Marquee',
    shortcut: 'M',
    cursor: 'crosshair',
    hint: 'Drag a rectangle or ellipse to select. Shift adds, Alt subtracts, both intersect; Shift after starting makes a square or circle, Alt draws from the centre. Drag inside the selection to move it.',
   
    options: [{ kind: 'marquee-shape' }, ...selectOptions('marquee')],
  },
  {
    id: 'lasso',
    name: 'Lasso',
    shortcut: 'L',
    cursor: 'crosshair',
    hint: 'Draw round what to select; in Polygonal mode click its corners (Alt-drag for freehand, Shift for 45°); in Magnetic mode click once and trace the edge, and the outline clings to it (Alt-click for a straight side). Shift adds, Alt subtracts, both intersect. Drawing freehand, let go of the button with Alt held to carry on in straight sides, and let go of Alt to close. Backspace takes the last corner back.',
   
    options: [{ kind: 'lasso-mode' }, ...selectOptions('lasso'), { kind: 'magnetic' }],
  },
  {
    id: 'quick',
    name: 'Quick Selection',
    shortcut: 'W',
    group: 'wand',
    cursor: 'crosshair',
    hint: 'Paint over what to select, and the selection grows out to its edges. Alt paints away what shouldn’t be selected; [ and ] change the brush size.',
   
    options: [{ kind: 'select-op' }, { kind: 'quick' }],
  },
  {
    id: 'wand',
    name: 'Magic Wand',
    shortcut: 'W',
    group: 'wand',
    cursor: 'crosshair',
    hint: 'Click to select pixels like the one clicked. Shift adds, Alt subtracts, both intersect.',
   
    options: [{ kind: 'select-op' }, { kind: 'wand' }, { kind: 'antialias', tool: 'wand' }],
  },
  { id: 'crop', name: 'Crop', shortcut: 'C', cursor: 'crosshair', hint: 'Drag the handles to choose what to keep, outside the box to straighten. Enter crops; nothing is thrown away, so the canvas can grow back.', options: [{ kind: 'session' }] },
  {
    id: 'pen',
    name: 'Pen',
    shortcut: 'P',
    group: 'pen',
    cursor: 'crosshair',
    hint: 'Click to place points, drag to pull out curves; click the first point to close the path, Enter to finish it open. On the selected path, click a segment to add a point, a point to delete it, an end to carry on.',
   
    options: [{ kind: 'pen-smart' }, { kind: 'shape-paint' }, { kind: 'session' }],
  },
  {
    id: 'curvature',
    name: 'Curvature',
    shortcut: 'P',
    group: 'pen',
    cursor: 'crosshair',
    hint: 'Click to place smooth points, the curve running through them (Alt-click for a corner); click the first point to close, Enter to finish open. On the selected path: drag a point to move it, the curve following; double-click a point to make it a corner or smooth; click a segment to add a point.',
    options: [{ kind: 'shape-paint' }, { kind: 'session' }],
  },
  {
    id: 'width',
    name: 'Width',
    shortcut: 'P',
    group: 'pen',
    cursor: 'crosshair',
    hint: 'Drag a shape’s stroke to make it wider or narrower there: a width point is added where you press. Drag a point’s edge to change its width (Alt: one side only), its centre to slide it along the path (Alt: a copy). Shift-click selects several; Delete removes them; double-click a point to type its widths.',
  },
  {
    id: 'direct',
    name: 'Direct Selection',
    shortcut: 'A',
    cursor: 'default',
    hint: 'Click a point of the selected path to select it (Shift adds), drag to move it; drag a handle to reshape the curve (Alt breaks a smooth point). Alt-click converts a point; Delete removes the selected ones. Click another shape to select it.',
   
    options: [{ kind: 'anchors' }],
  },
  {
    id: 'pencil',
    name: 'Pencil',
    shortcut: 'N',
    group: 'pencil',
    cursor: 'crosshair',
    hint: 'Draw a path freehand, smoothed to curves as you let go (Fidelity sets how smooth). End near where you began to close it. Start a stroke on the selected path to redraw that part of it, or at an open end to carry it on.',
    options: [{ kind: 'freehand', tool: 'pencil' }],
  },
  {
    id: 'vbrush',
    name: 'Paintbrush',
    shortcut: 'N',
    group: 'pencil',
    cursor: 'crosshair',
    hint: 'Paint a path freehand, stroked with a vector brush (choose it here or in Vector Brushes): art bent along it, copies scattered along it, or tiles. Its width is the stroke’s. Start on the selected path to redraw it.',
    options: [{ kind: 'freehand', tool: 'vbrush' }],
  },
  {
    id: 'blob',
    name: 'Blob Brush',
    shortcut: 'N',
    group: 'pencil',
    cursor: 'crosshair',
    hint: 'Paint filled shapes in the foreground colour, as with a marker: where a stroke touches a shape of the same colour (filled, no stroke), they become one shape. [ and ] change the size.',
    options: [{ kind: 'freehand', tool: 'blob' }],
  },
  {
    id: 'shape',
    name: 'Shape',
    shortcut: 'U',
    group: 'shape',
    cursor: 'crosshair',
    hint: 'Drag to draw a live shape: Shift keeps it square, Alt draws it from the middle. Its settings stay editable in Properties.',
   
    options: [{ kind: 'shape-type' }, { kind: 'shape-settings' }, { kind: 'shape-paint' }],
  },
  {
    id: 'builder',
    name: 'Shape Builder',
    shortcut: 'U',
    group: 'shape',
    cursor: 'crosshair',
    hint: 'With shapes selected, drag across the regions they make to merge them into one; Alt-drag to delete them. Each region keeps the look of the shape on top of it.',
  },
  {
    id: 'livepaint',
    name: 'Live Paint Bucket',
    shortcut: 'U',
    group: 'shape',
    cursor: 'crosshair',
    hint: 'Click a region between the selected shapes (or in a Live Paint group) to fill it with the foreground colour; Alt-click to empty it. Shapes become a Live Paint group the first time.',
  },
  {
    id: 'type',
    name: 'Type',
    shortcut: 'T',
    cursor: 'text',
    hint: 'Click to type point text, drag a box for area text; click a closed shape’s outline to type inside it, Alt-click it (or an open path) to type along it; click text to edit it. Esc or Ctrl+Enter finishes.',
   
    options: [{ kind: 'type-font' }, { kind: 'session' }],
  },
  { id: 'brush', name: 'Brush', shortcut: 'B', group: 'brush', cursor: 'none', hint: 'Paint on the selected pixel layer. Shift-click draws a straight line from the last stroke; hold Alt to pick a colour.', paints: 'brush', options: brushOptions(true) },
  {
    id: 'mixer',
    name: 'Mixer Brush',
    shortcut: 'B',
    group: 'brush',
    cursor: 'none',
    hint: 'Paint that mixes with the paint already there, wet into wet: the brush picks up colour from the canvas as it goes. Load and Clean set what it starts with.',
   
    paints: 'mixer',
    options: [
      { kind: 'preset' },
      { kind: 'number', key: 'size', label: 'Size', min: 1, max: 2000, unit: 'px', scale: 1, hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' },
      { kind: 'mixer' },
      { kind: 'number', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%', scale: 100, hint: 'How much paint each dab puts down.' },
      { kind: 'pressure', target: 'size', label: 'Pressure: size' },
    ],
  },
  {
    id: 'spot',
    name: 'Spot Healing Brush',
    shortcut: 'J',
    group: 'heal',
    cursor: 'none',
    hint: 'Paint over a spot, a speck or a small mark: when you let go, it’s filled in from what’s round it.',
    paints: 'spot',
    options: [
      { kind: 'number', key: 'size', label: 'Size', min: 1, max: 2000, unit: 'px', scale: 1, hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' },
      { kind: 'number', key: 'hardness', label: 'Hardness', min: 0, max: 100, unit: '%', scale: 100, hint: 'How sharp the edge is, from soft to hard.' },
      { kind: 'pressure', target: 'size', label: 'Pressure: size' },
    ],
  },
  {
    id: 'heal',
    name: 'Healing Brush',
    shortcut: 'J',
    group: 'heal',
    cursor: 'none',
    hint: 'Alt-click where to take the repair from, then paint over what to repair: when you let go, the texture there takes on the colour and tone round where you painted.',
    paints: 'heal',
    options: [
      { kind: 'preset' },
      { kind: 'number', key: 'size', label: 'Size', min: 1, max: 2000, unit: 'px', scale: 1, hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' },
      { kind: 'number', key: 'hardness', label: 'Hardness', min: 0, max: 100, unit: '%', scale: 100, hint: 'How sharp the edge is, from soft to hard.' },
      { kind: 'source', tool: 'heal' },
      { kind: 'pressure', target: 'size', label: 'Pressure: size' },
    ],
  },
  {
    id: 'patch',
    name: 'Patch',
    shortcut: 'J',
    group: 'heal',
    cursor: 'crosshair',
    hint: 'Draw round what to repair (or select it), then drag it to an area to take the repair from: when you let go, that area’s texture is healed in.',
  },
  {
    id: 'clone',
    name: 'Clone Stamp',
    shortcut: 'S',
    cursor: 'none',
    hint: 'Paint a copy of another part of the image: Alt-click where to copy from, then paint where it goes.',
    paints: 'clone',
    options: [
      { kind: 'preset' },
      { kind: 'number', key: 'size', label: 'Size', min: 1, max: 2000, unit: 'px', scale: 1, hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' },
      { kind: 'number', key: 'hardness', label: 'Hardness', min: 0, max: 100, unit: '%', scale: 100, hint: 'How sharp the edge is, from soft to hard. Round tips only.' },
      { kind: 'number', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%', scale: 100, hint: 'The most one stroke covers, however often it crosses itself.' },
      { kind: 'number', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%', scale: 100, hint: 'How much each dab adds: low flow builds up as you go over the same place.' },
      { kind: 'source', tool: 'clone' },
      { kind: 'pressure', target: 'size', label: 'Pressure: size' },
      { kind: 'pressure', target: 'opacity', label: 'Pressure: opacity' },
    ],
  },
  { id: 'eraser', name: 'Eraser', shortcut: 'E', cursor: 'none', hint: 'Erase the selected pixel layer to transparency.', paints: 'eraser', options: brushOptions(false) },
  {
    id: 'smudge',
    name: 'Smudge',
    cursor: 'none',
    hint: 'Push paint along as if with a finger: the brush picks up what’s under it where the stroke starts and drags it on. Finger Painting starts with the foreground colour.',
   
    paints: 'smudge',
    options: [
      { kind: 'preset' },
      { kind: 'number', key: 'size', label: 'Size', min: 1, max: 2000, unit: 'px', scale: 1, hint: 'The brush’s diameter in document pixels. [ and ] make it smaller and larger.' },
      { kind: 'number', key: 'hardness', label: 'Hardness', min: 0, max: 100, unit: '%', scale: 100, hint: 'How sharp the edge is, from soft to hard. Round tips only.' },
      { kind: 'smudge' },
      { kind: 'number', key: 'spacing', label: 'Spacing', min: 1, max: 200, unit: '%', scale: 100, hint: 'The distance between dabs, as a share of the diameter.' },
      { kind: 'pressure', target: 'opacity', label: 'Pressure: strength' },
    ],
  },
  {
    id: 'gradient',
    name: 'Gradient',
    shortcut: 'G',
    group: 'fill',
    cursor: 'crosshair',
    hint: 'Drag across the canvas to lay a gradient from where you press to where you let go; Shift keeps it to 45°. On a gradient fill layer or a shape with a gradient, the drag moves its ends.',
   
    options: [{ kind: 'gradient' }],
  },
  {
    id: 'bucket',
    name: 'Paint Bucket',
    shortcut: 'G',
    group: 'fill',
    cursor: 'crosshair',
    hint: 'Click to fill the pixels like the one clicked (within the tolerance) with the foreground colour or a pattern, inside the selection.',
   
    options: [{ kind: 'bucket' }],
  },
  { id: 'picker', name: 'Colour Picker', shortcut: 'I', cursor: 'crosshair', hint: 'Click to take the foreground colour from the image; Alt-click for the background.', options: [{ kind: 'sample' }] },
  { id: 'hand', name: 'Hand', shortcut: 'H', cursor: 'grab', hint: 'Drag to move around the document. Hold Space to use it with any tool.' },
  { id: 'zoom', name: 'Zoom', shortcut: 'Z', cursor: 'zoom-in', hint: 'Click to zoom in, Alt-click to zoom out, drag left or right to zoom smoothly.' },
  { id: 'rotate', name: 'Rotate View', shortcut: 'R', cursor: 'alias', hint: 'Drag to turn the view; Shift snaps to 15°. Double-click to put it straight.' },
]

export const TOOL_DEFS: ToolDef[] = DEFS.map((t) => ({ ...t, keys: TOOL_KEYS[t.id] }))

export const TOOL_BY_ID = new Map(TOOL_DEFS.map((t) => [t.id, t]))

/** A group's tools, in the toolbar's order. */
export const toolsInGroup = (group: string) => TOOL_DEFS.filter((t) => t.group === group)

class ToolStore {
  private current: ToolId = 'hand'
  /** The tool before this one, which Previous Tool (the ` key) goes back to. */
  private previous: ToolId | null = null
  private changes = new Listeners()
  /** The tool each group last had, which its key picks. */
  private lastInGroup = new Map<string, ToolId>()

  get = () => this.current

  /** The tool a group's slot in the toolbar shows: the one it had last (its first, to begin with). */
  shownIn(group: string): ToolId {
    return this.lastInGroup.get(group) ?? toolsInGroup(group)[0].id
  }

  /** A group's key: the tool it had last (its first, to begin with). */
  pickGroup(group: string) {
    this.set(this.lastInGroup.get(group) ?? toolsInGroup(group)[0].id)
  }

  /** Shift with a group's key: its next tool, round to the first. */
  cycleGroup(group: string) {
    const list = toolsInGroup(group)
    const at = list.findIndex((t) => t.id === this.current)
    this.set(list[(at + 1) % list.length].id)
  }

  subscribe = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }

  /** Previous Tool: back to the one before, and again to come back. */
  back() {
    if (this.previous) this.set(this.previous)
  }
  hasPrevious = () => this.previous !== null

  set(id: ToolId) {
    if (id === this.current) return
    this.previous = this.current
    this.current = id
    const g = TOOL_BY_ID.get(id)?.group
    if (g) this.lastInGroup.set(g, id)
    this.changes.emit()
  }
}

let store: ToolStore | null = null
export const tools = () => (store ??= new ToolStore())
