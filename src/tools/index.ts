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

export type ToolId =
  | 'move'
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
  | 'direct'
  | 'shape'
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
  /** How many anchors Direct Selection has selected. */
  | { kind: 'anchors' }
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
  marquee: [
    ...SELECT_KEYS,
    { keys: 'Shift', does: 'square or circle', during: 'drag' },
    { keys: 'Alt', does: 'from the centre', during: 'drag' },
  ],
  lasso: [...SELECT_KEYS, { keys: 'Enter', does: 'closes a polygon' }, { keys: 'Esc', does: 'cancels' }],
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
  direct: [
    { keys: 'Shift', does: 'adds points to the selection' },
    { keys: 'Alt+Click', does: 'converts a point' },
    { keys: 'Delete', does: 'removes the selected points' },
    { keys: 'Alt', does: 'breaks a smooth point', during: 'drag' },
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
    cursor: 'move',
    hint: 'Drag to move the selected layers; Shift keeps them straight, Ctrl lets go of snapping. Drag a guide to move it, or off the canvas to remove it. The arrow keys nudge a pixel, Shift ten.',
    options: [{ kind: 'auto-select' }, { kind: 'align' }, { kind: 'session' }],
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
    hint: 'Draw round what to select; in Polygonal mode click its corners; in Magnetic mode click once and trace the edge, and the outline clings to it. Shift adds, Alt subtracts, both intersect.',
   
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
    cursor: 'crosshair',
    hint: 'Click to place points, drag to pull out curves; click the first point to close the path, Enter to finish it open. On the selected path, click a segment to add a point, a point to delete it, an end to carry on.',
   
    options: [{ kind: 'shape-paint' }, { kind: 'session' }],
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
  private listeners = new Set<() => void>()
  /** The tool each group last had, which its key picks. */
  private lastInGroup = new Map<string, ToolId>()

  get = () => this.current

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
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
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
    for (const fn of this.listeners) fn()
  }
}

let store: ToolStore | null = null
export const tools = () => (store ??= new ToolStore())
