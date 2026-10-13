# Changelog

Newest first.

## Vector construction

- **Pathfinder** on any number of shapes: Unite, Minus Front, Intersect,
  Exclude, Divide, Trim, Merge, Crop and Minus Back, curves kept.
- **The Shape Builder** (Shift+U): drag across regions to merge them, Alt
  to delete them.
- **Live Paint**: the Live Paint Bucket fills the regions between paths, the
  regions recomputed as the paths change; Make and Expand.
- **Path commands**: Outline Stroke, Offset Path, Join, Simplify, Smooth.
- Checks: new `check:construct`; `check:geom` (regions, Join, Simplify,
  Live Paint's parts).

## Effects per fill and stroke, and graphic styles

- **Each fill and stroke has effects of its own**: path effects
  (Transform with copies, Offset Path, Roughen, Pucker & Bloat, Zig Zag,
  Warp) and pixel effects (every live filter that keeps pixels in place,
  and the new Drop Shadow and Outer Glow), in order, in Properties.
- **Graphic Styles** panel: named looks in the document, made from a
  shape, given to shapes and text (linked), redefined (every linked shape
  changes), unlinked by a change of a shape's own; carried by copy and
  paste.
- **Filters**: Drop Shadow and Outer Glow, under Stylize, on layers too.
- Checks: new `check:appearance`; `check:geom` (Offset Path, path effects,
  styles), `check:gpu` (two filters).

## The filter and adjustment pack

- **Filters**, in Photoshop's submenus: Lens Blur, Surface Blur, Smart
  Sharpen, Twirl, Pinch, Spherize, ZigZag, Wave, Ripple, Polar
  Coordinates, Displace (a document pattern as the map), Dust & Scratches,
  Mosaic, Clouds, Lighting Effects, Emboss, Find Edges, Solarize, Minimum
  and Maximum; twenty-eight in all, every one live.
- **Adjustments**: Selective Colour, Photo Filter (Photoshop's twenty
  filters or a colour), Colour Lookup (nine looks, or a `.cube` file),
  Colour Grading (four wheels), and Hue/Saturation by colour range.
- **Document → Adjustments**: any adjustment applied to a layer's pixels
  for good, through the selection, or added live.
- **Live filters** take a blend mode of their own; **filter layers**
  (Layer → New Filter Layer) filter everything below them.
- Photoshop: Selective Colour and Hue/Saturation's ranges in and out.
- Checks: new `check:filters`; `check:gpu` (thirty more cases),
  `check:adjust` (the pack's maths).

## Live warps: Distort, Perspective, Warp and Liquify

- **Free Transform's modes**: Free, Distort, Perspective and Warp in the
  options bar and Edit → Transform; Ctrl and Ctrl+Alt+Shift on a corner in
  Free, as Photoshop's.
- **Warp**: a mesh of Bézier patches dragged by its surface, anchors and
  handles, a grid up to 5 × 5, and Photoshop's fifteen styles with Bend
  and H and V distortion.
- **Liquify** (Filter → Liquify, Ctrl+Alt+X): Forward Warp, Reconstruct,
  Smooth, Twirl, Pucker, Bloat and Push Left, Restore All.
- All live: a Warp or Liquify effect in the layer's effects, for pixel
  layers, smart objects, shapes and text; shapes and text keep sharp edges.
  Rasterize keeps a warp where it was. Photoshop smart objects' perspective
  and warp, and warped text, in and out.
- Engine: geometric effects (`FilterDef.warp`), `warpTile` and the warp
  kernel; the filter registry's `data` parameters.
- Checks: new `check:warp`; `check:geom` (warps), `check:gpu` (three warp
  cases), `check:interchange` (a smart object's warp through PSD).

## Retouching: the Clone Stamp, the Healing Brush, the Spot Healing Brush and Patch

- **The Clone Stamp (S)**: Alt-click the source, Aligned, Sample All
  Layers, with the brush's tip, opacity, flow and pressure. Live on the GPU
  from the source at full resolution (render/shaders/clone.ts).
- **The Healing Brush (J)**: painted as a clone, healed on release: the
  source's texture with the tone round it (retouch/heal.ts, a membrane by
  pull-push).
- **The Spot Healing Brush (J)**: what's brushed is filled in from round
  it by content-aware fill, on release.
- **Patch (J)**: a selection (drawn as a Lasso, or one already there)
  dragged to the area to take the repair from, healed in.
- On a tiled document the source reads round the edges.
- Checks: new `check:healing` (browser); `check:retouch` (healing).

## Tiled documents: the last wrap-arounds

- A group's, an adjustment layer's and a fill layer's mask over an edge
  wraps (`wrapped_texel` in render/shaders/mask.ts; vector masks add
  their outline's copies).
- Knockout groups knock out their layers' copies.
- Offset's Repeat Edge Pixels and Set to Transparent repeat beyond the
  canvas in a tiled document, so effects after them read round the seam.
- The Magnetic Lasso clings to edges across the seam, and Select and
  Mask's edge detection and refine brush work across it.
- Checks: `check:tiled` (a fill layer's mask over the edge; Offset then a
  blur at the seam).

## Tiled documents, stages 2 and 3

- **Live layers on the torus**: shapes, text, smart objects and moved or
  transformed pixel layers over an edge show at the other side, still
  live, with their masks and clipped layers. Live filters and layer styles
  read across the edges: a blur or a drop shadow over the seam is
  seamless. (`TileJob.shift`, `copies`, `eachCopy` in render/graph.ts)
- **Selections on the torus**: the Marquee and the Lassos over an edge,
  the Magic Wand, Grow, Similar, Quick Selection and the Paint Bucket
  round the edges, Feather, Expand, Contract, Border, Smooth and Select and
  Mask's sliders without a seam, a moved or transformed selection carried
  round. (`Torus` in tiles/coverage.ts)
- **Gradients** run on over the seam they're dragged across.
- Found on the way: a shape's tiles left of or above the canvas weren't
  drawn (the segment bands start at tile 0), which layer effects and live
  filters gathering round a shape at the canvas's edge read; they now are.
- Checks: `check:tiled`, `check:select`.

## Tiled documents, stage 1

- **Document → Tiled**: a document can be a seamless tile, repeating in
  both directions, across only or down only. It's the document's: a step
  in the history, saved in the `.pxll` (`Doc.tiled`); PSD exports the tile.
- **View → Tiled View** shows the copies round the canvas; a press in any
  copy works on the document, and a drag over a seam stays whole.
- **Painting over the edges**: the Brush, Eraser, Mixer Brush and Smudge
  stamp a dab at the other side too (`wrapDab`), and the Mixer and Smudge
  pick paint up across the edges.
- **Filter → Offset…**, live or applied, with Wrap Around, Repeat Edge
  Pixels or Set to Transparent: a new kind of filter that remaps, worked
  out tile by tile from wherever on the canvas it reads.
- **Define Pattern** takes the whole canvas, edges kept, from a tiled
  document.
- Checks: new `check:tiled` (browser); `check:doc`, `check:brush`,
  `check:adjust`, `check:render-ref`, `check:commands`.

## Your own keyboard shortcuts, and more for the panels

- **Edit → Keyboard Shortcuts…** (Ctrl+Alt+Shift+K, as in Photoshop; Ctrl+/
  still opens it): every command with its keys, by menu, found by name or
  by key. Click + and press a key to add one, click a key to change it, ×
  to take it away; a key another command has says whose it is and asks
  before taking it. Keys the browser keeps, the developer tools' and the
  clipboard's are refused, saying why. Save keeps them, Cancel forgets
  them; Reset puts one command's back, Reset All every one. The menus, the
  palette, the tool cards, the toolbar and the start screen show yours.
  Your workspaces' run-time commands can have keys too. It moved from the
  Help menu to the Edit menu. (`input/keymap.ts`, `ui/ShortcutsDialog.tsx`)
- **Columns fold to icons**, as Photoshop's do: a strip along each column's
  top folds it to a button a panel, grouped as the tabs are; a click shows
  the panel beside the column until the next click elsewhere or Esc. Icons
  drag like tabs, and Window shows a folded panel the same way.
- **A floating window holds several groups stacked**: let go over the foot
  of a group in a window to stack under it. A window of several moves by
  the grip along its top, and docks whole; each group's bar pulls that
  group out. Closed panels come back above or below the group beside them.
- **Workspaces as files**: Window → Workspace → Export saves the one in use
  (with your keys, when you've changed any) as `.plexel-workspace.json`;
  Import Workspace… adds one as yours, asking its name and whether to take
  its keys. (`ui/workspaceFile.ts`)
- Matching keys: punctuation is found by its place too (Shift+- where Shift
  makes it _), and a letter ⌥ turns into something else on a Mac by its
  key. `Mod+Space` and `Mod+Plus` can be written.
- Checks: `check:commands` (the keymap, the layout's icons, stacked windows
  and whole-window moves, workspace files), `check:ux` (all of it by real
  input), `check:shell` (the Help menu without the shortcuts).

## Workflow: picking on the canvas, bird's-eye, split view, previous tool, swatches onto shapes

- **Pick a layer on the canvas** with the Move tool: Ctrl-click selects
  the topmost layer under the pointer, Alt goes one down (and round),
  Shift adds it. **Auto-Select** on the options bar does it at every press
  (Ctrl then lets go), picking the layer or its outermost group. A layer
  counts where it shows: its pixels' alpha, a shape's fill or stroke,
  text's box, a smart object's canvas, through its masks and its clipping
  base. The engine reads pixels and masks for every candidate in one call
  (`tiles.valuesAt`). (`app/pick.ts`, `app/moveTool.ts`)
- **Hold H and press for a bird's-eye view**, as in Photoshop: zoomed in,
  the whole document shows with a frame the size of your view; let go and
  it zooms back in there. Esc puts it back.
- **View → Split View**: two views of the document side by side on the
  same canvas, the second fitted to start with. Each zooms, pans and turns
  on its own; tools, the zoom keys, the status bar and the rulers follow
  the pane under the pointer. The engine draws each pane through its own
  view, clipped to it (`paneRects` in `render/view.ts`).
- **Previous Tool** (the ` key): back to the tool before, and again.
- **Drag a swatch onto a shape or text** to fill it; Shift strokes it. A
  global or spot swatch stays linked. (`app/colourDrag.ts`)
- Checks: new `check:workflow` (browser); `check:render-ref` (the panes'
  maths); `check:commands`.

## The layer below selected

- **When the selected layer goes, the one below it is selected**, as in
  Photoshop: after Delete, so pressing it again deletes the next layer,
  and after an Undo that takes the layer away. With none below, the one
  above; the last in a group, the group. (`neighbourOf` in `doc/tree.ts`)
- Checks: `check:doc` (which layer is chosen), `check:ux` (Delete twice,
  Undo), `check:clipboard` (finding a pasted layer by its selection).

## The Layers panel's buttons

- **Icon buttons along the Layers panel's foot**, at the right as in
  Photoshop: New Adjustment Layer (a menu of every adjustment, opening
  upward from the button), New Pixel Layer, Duplicate and Delete. They
  replace the New Group and Delete text buttons; New Group is in the Layer
  menu. Duplicate and Delete are off, and say why, with no layer selected.
- **Fixed: dragging a panel group's foot could crash the app.** The new
  height was read when React applied it, after a quick drag had already
  ended; it's now worked out as the pointer moves.
- Checks: `check:ux` (the four buttons and the adjustment menu).

## The options bar across the window

- **The options bar runs the full width of the window**, under the menu
  bar, as Photoshop's does. Under it, level with each other, come the
  toolbar at the window's left edge, the docks, and the document tabs over
  the canvas. A new left dock opens just past the toolbar; dropping a
  panel anywhere on the toolbar makes one.
- **A docked panel squeezed by the others scrolls** what's in it; before,
  its content spilled out underneath the panel below it, out of reach.

## Rulers, guides, grids, snapping and alignment

- **Rulers** (View → Rulers, Ctrl+R) along the canvas's top and left, in
  pixels, inches, centimetres, millimetres or points (View → Ruler Units,
  or a right-click on a ruler), with a mark following the pointer. They
  measure whichever document axis runs along them when the view is turned
  a quarter. Drag from their corner to move the zero point; double-click
  it to put it back. (`ui/Rulers.tsx`)
- **Guides.** Dragged out of a ruler (Alt for the other kind), moved with
  the Move tool, dragged off the canvas to remove; View → New Guide…, New
  Guide Layout… (columns, rows, gutters, margins, previewed on the canvas),
  New Guides from Shape, Lock Guides, Clear Guides, Show → Guides. They're
  steps in the history, saved in `.pxll` (where the model had kept room
  for them since phase 2) and in PSD as Photoshop's guide resource, read
  from Photoshop's files too, and carried by Crop and Canvas Size.
  (`doc/guides.ts`)
- **The grid** (Show → Grid, Ctrl+') from the zero point, its spacing in
  any unit with finer subdivisions, thinning out as you zoom away; **the
  pixel grid** from 600%. Drawn by the engine in the overlay pass, under
  the tools' shapes, so it never lags the view. (`render/overlay.ts`)
- **Snapping** (View → Snap, Ctrl+Shift+;; View → Snap To): to guides, the
  grid, other layers' edges and centres, the canvas's edges and centre,
  anchor points, and whole pixels. The Move tool snaps the box of what
  it's moving; Free Transform, Crop, the Shape, Gradient and Type tools,
  the Marquee, the Polygonal Lasso, the Pen and Direct Selection snap
  where they place things; guides and the zero point snap as they're
  dragged. Hold Ctrl to let go. (`geom/snap.ts`, `app/snapping.ts`)
- **Smart guides** (Show → Smart Guides, Ctrl+U): a line from what's
  dragged to what it lines up with, and equal spacing between layers in a
  row, centred in a gap or repeating a pair's, with the gaps marked. A
  readout by the pointer says where a guide is and how far a move has
  gone.
- **Several layers selected**: Ctrl-click and Shift-click in the Layers
  panel, with a key layer. The Move tool, the arrow keys and Delete act on
  them all.
- **Align and distribute** (Layer → Align, Layer → Distribute, and buttons
  on the Move tool's options bar): edges and centres, and equal spacing,
  to the selected layers, the key layer, the canvas or the selection.
  (`geom/align.ts`, `app/align.ts`)
- **Edit → Guides, Grid & Snapping…**: the colours of guides, smart guides
  and the grid, the grid's spacing and subdivisions, the units and what
  snaps, kept by the browser (`plexel.guides.v1`).
- The page's overlay moved to `app/overlay.ts`, with channels for the
  tool's shapes, a snap's smart guides and the guides and grids.
- Shortcuts on ; and ' are found by their key's place as well, so
  Ctrl+Shift+; works though Shift turns ; into a colon.
- Checks: new `check:snap` (headless) and `check:guides` (browser);
  `check:interchange` (guides in PSD); `check:commands` (the new commands
  and their context).

## Docking, floating panels and your own workspaces

- **Panels move.** A dock either side of the canvas, as many columns as
  you like, panels grouped as tabs, and panels floating in windows of their
  own over the canvas. Drag a tab to move a panel, the bar to move its
  group: onto another group's tabs, above or below a group, against a
  column's side for a new column, against the window's edge for a new dock,
  or over the canvas to float it. A blue outline shows where it will go;
  Ctrl floats, Esc calls it off. Floating windows move by their bar,
  resize by their corner, and dock again by being dragged to a dock.
  Docked groups take a height when their foot is dragged. Each group's ⋯
  menu floats, docks and closes it from the keyboard. (`ui/layout.ts`,
  `ui/Dock.tsx`)
- **A closed panel comes back where it was**: in its group, under the group
  it was under, or floating where its window was.
- **The Window menu** ticks a panel when it's shown; one behind a tab is
  brought to the front rather than closed.
- **Your own workspaces.** Window → Workspace → New Workspace… names and
  saves where the panels are; yours are in the menu, the switcher and the
  palette, each remembering how it was left. Reset brings one back as
  saved, Save Changes updates it, and Rename and Delete Workspaces… looks
  after them. A new one by the name of one of yours replaces it, as in
  Photoshop. (`ui/workspace.ts`, `ui/workspaceDialogs.tsx`)
- The saved workspace moved to `plexel.workspace.v2`; a save from before
  is carried over as it was.
- The command registry has run-time commands (`runtimeCommands`), for
  your workspaces.
- Checks: `check:commands` (the layout's moves, closing and reopening,
  reading saved layouts, your workspaces and their commands), `check:ux`
  (tabs, floating, docking left and right, new columns, Esc, the ⋯ menu, a
  reload, and New, Reset, Save Changes, Rename and Delete by real drags
  and clicks in Chrome). `check:shell` passes unchanged.

## Spring-loaded tools

- **Hold a tool's key to use it for a moment**: hold V to move a layer,
  I to pick a colour, M for a quick marquee, and let go to carry on with
  the tool you had. A tap still switches for good, as before. A key held
  over a quarter of a second, or used on the canvas however briefly, is a
  hold; let go mid-drag and the tool comes back when the drag ends. While
  held, the status bar's first hint says which tool letting go brings
  back. Edit → Interface → "Hold a tool's key to use it for a moment"
  turns it off. (`app/springTools.ts`)
- Fixed: clicking a tool brought its tooltip straight back (the click
  redraws the icon under the pointer, which Chrome reports as the pointer
  arriving again). A tooltip put away by a press, key or scroll now stays
  away until the pointer moves to another control.
- Checks: `check:commands` (taps, holds, a quick use, a release mid-drag,
  two keys held, the toolbar mid-hold), `check:ux` (held V and I in
  Chrome, a tap, the setting off).

## UX pass

Ten of 25 ideas from a brainstorm on how Plexel feels to use. The other
fifteen are in brainstorm.md.

- **Tool cards.** Resting on a tool shows its name and key, what it does,
  and every key and gesture it answers to. One tooltip layer for the whole
  app (`ui/Tooltips.tsx`), asked for with `data-tip`, `data-tip-tool` and
  `data-why` attributes. Once one shows, the next shows at once.
- **Disabled commands say why.** A greyed-out menu item gives the reason
  on hover ("Needs a selection: draw one with a selection tool", "Works on
  a pixel layer, not a text layer"). The palette lists matching commands
  that can't run after the ones that can, greyed, with the reason. Every
  command has a reason: its own `why`, the one its `enabled` test carries,
  or what's missing from the selection. `check:commands` makes sure none is
  silent.
- **Key hints** in the status bar: what each key does with the tool in use,
  before a press, during a drag, or while a transform, crop, polygon, path
  or text is open. A held modifier lights its hints. Tools declare their
  keys in `TOOL_DEFS`, which the tool cards read too.
- **Alt and a right-drag sizes the brush** on the canvas (Ctrl+Option and a
  drag on a Mac): left and right for the size, up and down for the
  hardness, with the tip drawn at its size and hardness where the drag
  began. Quick Selection's brush too.
- **A context menu on the canvas**: what can be done now for the
  selection, the selected layer's kind and the work in progress, from the
  same commands as the menus (`contextMenu()` in the registry), enabled
  ones only.
- **The Layers panel**: Alt-click an eye to show that layer alone, and
  again to bring the rest back as they were (one step each). Lock,
  Duplicate and Delete appear on the hovered row, and a locked layer shows
  its lock always. Resting on a thumbnail shows it larger beside the panel.
  A dragged layer says where it would land ("Below Background", "Into Group
  1", "Can't go here"), with a heavier drop line and the dragged row
  dimmed.
- **Task workspaces**: Essentials, Painting, Photo, Vector, Type and Print,
  from a switcher at the right of the menu bar or Window → Workspace. Each
  remembers how it was left; Reset puts the one in use back as designed. A
  workspace saved before this opens as Essentials, as it was left.
- **Tab and the screen modes**: Tab hides the toolbar, options bar and
  dock, Shift+Tab the dock alone (a focused control keeps Tab for moving
  the focus). F steps through Standard, Full Screen Mode with Menu Bar and
  Full Screen Mode, with a note saying how to get back. View → Full Screen
  is now View → Browser Full Screen.
- **Edit → Interface**: interface size (80% to 150%; the canvas keeps its
  own zoom), Compact density, More contrast over any theme, Reduced motion,
  and switches for rich tooltips, key hints and Tab hiding the panels.
  Changes show at once and are kept per browser.
- The Layers panel's visibility toggle is described as an eye in the
  manual, which still said "the dot".
- Checks: new `check:ux` (browser); `check:commands` (workspaces, screen
  modes, every disabled command's reason, the context menu, tool keys,
  interface settings); `check:shell` (Tab is Plexel's on the canvas, a
  control's in a control).

## Icons

- **Phosphor icons** replace the toolbar's emoji and the symbols that stood
  in for icons: layer visibility, folding, clipping and compound-shape
  operations, close buttons, menu ticks and submenu arrows, the swap,
  reorder and reset buttons, the gamut warning. A pressed tool shows
  Phosphor's filled weight.
- **One registry** (`src/ui/icons.ts`) names every icon by what it means;
  `npm run build:icons` bundles only those, from `@iconify-json/ph`.
  `check:commands` holds the bundled outlines to the set and makes sure
  every tool has an icon.
- **Help → About** credits Phosphor Icons (MIT).

## Fills, gradients and selections

Phase 14. Chosen from the gap map's "Gradients & fills" and "Selection
tools" rows: Photoshop's fills and gradients, patterns made from pixels,
content-aware fill, and the selection tools that were missing.

- **Edit → Fill** (Shift+F5): Foreground, Background, a colour of your
  own, a pattern (at a scale), Content-Aware, Black, 50% Gray or White; in
  any blend mode at any opacity, with Preserve Transparency; through the
  selection, on the selected layer or its mask.
- **Content-aware fill**: what's selected made again from the layer round
  it, by multi-scale PatchMatch completion (Wexler's and Barnes's method)
  in a worker of its own, so the canvas keeps drawing. A 512 × 512 region
  with a 120 × 120 hole takes about a third of a second.
- **The Gradient tool** (G): linear, radial, angle, reflected and diamond,
  from six presets made from the colours, reversed or not, in any blend
  mode and opacity. It makes a **gradient fill layer** by default (masked
  by the selection), which stays live: dragging again on a gradient fill
  layer, or on a shape whose top fill is a gradient, moves the gradient's
  ends. Set to Pixels, it lays the gradient into the layer or mask
  through the selection. Shift keeps the line to 45°.
- **Fill layers** (Layer → New Fill Layer: Solid Colour, Gradient,
  Pattern): a paint over the whole canvas with no edge of its own, shaped
  by its mask, edited in Properties, moved and transformed like any layer,
  rasterized on request. Photoshop's fill layers open as these; PSD, SVG
  and PDF export write them as shapes over the canvas.
- **Gradients along a line**, as the Gradient tool draws them, for every
  gradient paint, and the **Reflected** style, on shapes, text and fill
  layers; Photoshop's reflected gradients now come in as such.
- **Patterns from pixels**: Edit → **Define Pattern** keeps what's visible
  under the selection's bounds (up to 1,024 pixels a side) as a pattern of
  the document's. Fills, fill layers, the Paint Bucket and shapes' fills
  and strokes use them, drawn from a pyramid of the repeat so they stay
  smooth when small. They're converted with the document, copied with the
  layers that use them, and listed in a new **Patterns** panel.
- **The Paint Bucket** (G, Shift+G from the Gradient): the foreground or a
  pattern over the pixels like the one clicked (tolerance, contiguous,
  anti-aliased, all layers), inside the selection.
- **Quick Selection** (W): paint over something and the selection grows
  out to its edges (a graph cut, Boykov–Kolmogorov, round each stretch of
  the stroke), shown as it goes and committed as one step; Alt takes away;
  Auto-Enhance softens the edge; [ and ] size the brush. Strokes after the
  first add to the selection it made, as Photoshop's do.
- **The Magnetic Lasso** (the Lasso's third mode): click once and trace;
  the outline follows the strongest edges within the Width (intelligent
  scissors), points drop by themselves where it has settled (Frequency),
  edges fainter than the Contrast are ignored, and a click drops a point
  on the nearest edge.
- **Select → Colour Range**: sampled colours with fuzziness (click the
  canvas while it's open; Shift-click adds), or Reds, Yellows, Greens,
  Cyans, Blues, Magentas, Highlights, Midtones, Shadows and Skin Tones;
  inverted, and combined with the selection.
- **Select → Grow** and **Similar**, with the Magic Wand's tolerance;
  **Modify → Border** and **Smooth**; **Transform Selection**, with Free
  Transform's handles on the outline itself.
- **Select and Mask**: Edge Detection (a radius, and Smart Radius, which
  is narrower where the edge is crisp) and a **Refine Edge brush** re-work
  the edge from the image's colours, so hair and fur come out soft; Output
  To a selection, a layer mask or a new layer. It floats beside the canvas
  now, so the brush can be used.
- **Alpha channels**: Select → **Save Selection** (new, or into a channel:
  replace, add, subtract, intersect) and **Load Selection** (inverted or
  not, combined with the selection), and a **Channels** panel. Channels are
  saved in the file and moved by Crop and Canvas Size.
- **Free Transform** works on fill layers (their box is the canvas).
- **The bench** measured the reopened PSD's fitted draw wrongly (it could
  count frames from before the document started drawing as done): 107 ms
  was really 3.4 s, over its 3 s budget. It now waits for the document to
  start drawing; PERFORMANCE.md has the figures.
- **Checks**: `check:gpu` holds the new paints (reflected, along a line,
  patterns from pixels at full size and small, fill layers) to the CPU
  reference in every mode and depth; `check:select` covers Transform
  Selection, windows written back, Grow, Similar, Colour Range, and fills
  in blend modes with Preserve Transparency against the compositing
  reference; `check:doc` and `check:print` patterns, channels and fill
  layers saved, converted, cropped and copied; three new headless suites,
  `check:segment`, `check:matte` and `check:retouch`, for the algorithms;
  and a new browser suite, `check:fills`, through the real UI.

## The clipboard

Phase 13. Cut, copy and paste: pixels, layers, layer styles and paths,
within a document, between documents, and to and from other apps.

- **Copy** (Ctrl+X, Ctrl+C) takes the selected layer's pixels under the
  selection, or with nothing selected the layer itself, live, with its
  mask, effects, style and clipped layers. A moved, scaled or turned pixel
  layer copies exactly, without being redrawn; shapes, text, smart objects
  and groups copy as Rasterize draws them; a chosen mask copies its grays.
  **Cut** clears what it copied, or deletes the layer.
- **Copy Merged** (Ctrl+Alt+Shift+C): everything that shows, under the
  selection or across the canvas.
- **Paste** (Ctrl+V) puts it above the selected layer: copied pixels
  centred on the selection, anything else where it came from when that's
  in view, otherwise in the middle of the view; pasting pixels drops the
  selection, as Photoshop does. **Paste in Place** (Ctrl+Shift+V), **Paste
  Into** (Ctrl+Alt+Shift+V) and **Paste Outside**, masked by the selection.
- **Between documents** in any mode, depth or profile, converted with
  Colour Settings' intent; linked swatches and text styles come along.
- **With other apps**: a copy goes out as a PNG in sRGB (and as HTML), a
  text layer's words and a path's SVG as text. Images, SVG markup and plain
  text from other apps paste in as a pixel layer, shapes and a text layer.
  Plexel recognises its own copy on the system clipboard by a marker in
  the HTML, so it pastes back live rather than as the picture.
- **Layer → Duplicate Layer**, **Layer via Copy** (Ctrl+J; with nothing
  selected, Duplicate Layer) and **Layer via Cut**.
- **Copy Layer Style** and **Paste Layer Style**, on a clipboard of their
  own.
- **Paths**: with Direct Selection or the Pen, the selected points' paths
  copy and paste into the selected shape, or as a new shape.
- **File → New from Clipboard**, and Paste with no document open, make a
  document to hold the copy.
- Text fields keep their own clipboard keys, and Ctrl+C copies text
  selected on the page.
- **Checks**: `check:doc` covers fragments (what the clipboard holds);
  `check:commands` that the clipboard keys reach the browser's clipboard
  events and no other command uses them; a new browser suite,
  `check:clipboard`, runs all of the above through Chrome's own clipboard.

## Brushes

Phase 12. Photoshop's brush engine: tips of any shape, every section of
its Brush Settings panel, the Mixer Brush and Smudge, and Photoshop's own
brush files opening here.

- **The Brush Settings panel** (Window → Brush Settings, F5), section by
  section as Photoshop has it: Brush Tip Shape (tip, size, flip, angle,
  roundness, hardness, spacing), Shape Dynamics (size, angle and roundness
  jitter, each with a control and a minimum; flip jitter), Scattering (one
  or both axes, count, count jitter), Texture, Dual Brush, Colour Dynamics,
  Transfer, Brush Pose, Noise, Wet Edges, Build-up, Smoothing with Photoshop's
  pulled string, and Protect Texture. A stroke drawn by the brush at the top
  follows every change.
- **Controls**: Off, Fade over a number of dabs, Pen Pressure, Pen Tilt,
  Rotation, Direction, Initial Direction, Speed, Distance and Random, each
  through a curve you can edit, with a minimum. Brush Pose stands in for a
  pen's tilt, rotation and pressure.
- **Tips of any size and shape**, up to 1,024 pixels a side, each with a mip
  chain, so a big tip painted small stays clean; the built-in Chalk,
  Spatter and Dry Bristle remade at 256 pixels. **Edit → Define Brush
  Preset** makes a tip from the image under the selection, as Photoshop
  does: dark is paint.
- **Texture**: four built-in papers (Fine Paper, Canvas, Rough Paper,
  Burlap) and the patterns in brush files, with scale, brightness,
  contrast, invert, Photoshop's ten modes, and depth with its jitter, per
  tip or over the whole stroke.
- **Dual Brush** with its own tip, size, spacing, scatter and count, in
  eight modes; **Noise**; **Wet Edges**; **Build-up**, which keeps painting
  while the pen is held still.
- **Colour Dynamics**: foreground/background, hue, saturation and
  brightness jitter, and purity, per tip or per stroke, in RGB, and in CMYK
  and Gray through the document's profile.
- **Photoshop's brush files (ABR) import** from Edit → Import Brushes or the
  Brushes panel: versions 1 and 2, and 6 to 10 with their sampled tips,
  patterns and presets. Every section above comes over, with the options
  bar's opacity, flow, mode and smoothing; erodible and airbrush tips and
  stylus wheel controls are named, as they can't. Each file's brushes are a
  group in the Brushes panel; tips and patterns are kept in the browser.
- **The Mixer Brush** (B with the Brush; Shift+B goes between them): paint
  picked up from the canvas and mixed with the brush's own, wet into wet.
  Wet, Load, Mix and Flow, Photoshop's combinations from Dry to Very Wet,
  Heavy Mix, Load and Clean (after each stroke, or kept from stroke to
  stroke, so the brush stays dirty), Sample All Layers.
- **Smudge**: the canvas dragged along by the brush, with Strength, Finger
  Painting and Sample All Layers.
- **The brush cursor is the tip's own outline**, turned and squashed as the
  brush paints it.
- **Photoshop's keys**: the number keys set the opacity (two quickly make
  one number; 0 is 100%), with Shift the flow; Shift+[ and ] make the brush
  a quarter softer or harder; F5 shows Brush Settings. Shortcuts on digits
  and brackets are found by the key they're on, so Shift doesn't hide them.
- **Checks**: `check:brush` covers every section, the cursor's outline and
  ABR files (Photoshop's own, a published set, and versions 1, 2 and 6
  built in the check); `check:gpu` holds every new kind of dab, Smudge and
  the Mixer to their CPU references in every mode and depth; `check:paint`
  drives the keys, the panel, the Mixer, Smudge, Define Brush, an import
  and the cursor in Chrome. The bench paints with the Mixer and Smudge on
  the 96 MP document.

## Interchange

Phase 11. Work moves between Plexel and the tools around it without being
flattened on the way: Photoshop documents open with their layers and go
back out with them, SVG comes in as shapes and goes out as shapes, and a
PDF for print keeps vectors as vectors, CMYK as CMYK and spot colours as
plates. What a format can't hold is named, every time, in the message that
follows the open or export.

- **Photoshop documents (PSD and PSB) open** with their layers: groups
  (pass-through kept), blend modes, opacity and fill, clipping, pixel and
  vector masks with their density and feather, hidden and locked layers,
  colour tags and names in any script. Shape layers and solid colour and
  gradient fill layers come in as live shapes with their fill and stroke;
  type layers as live text in their fonts (found by PostScript name among
  the bundled, loaded and local fonts), with their size, leading, tracking,
  alignment and frame; adjustment layers as Plexel's own (Levels, Curves,
  Brightness/Contrast, Exposure, Invert, Posterize, Threshold,
  Hue/Saturation, Vibrance, Colour Balance, Black & White, Channel Mixer,
  Gradient Map); layer styles as layer effects (shadows, glows, Satin,
  overlays, Stroke, Bevel & Emboss, only those switched on); embedded smart
  objects as smart objects whose contents open (a nested PSD, or an image),
  with their transform. RGB, Gray and CMYK at 8 and 16 bits keep their mode
  and profile; 32-bit, Lab, indexed, duotone, bitmap and multichannel
  documents open as the nearest Plexel has, and say so.
- **Our own PSD code**, chosen over ag-psd: it reads and writes PSB, 16-bit
  and CMYK layers, all four channel compressions, and Photoshop's
  descriptors and text engine data byte for byte, and maps them onto
  Plexel's model directly (`io/psd/`).
- **Adjustments match Photoshop's**, checked against the composites
  Photoshop saved in psd-tools' test files: Levels and Curves apply each
  channel's own settings before the master, as Photoshop does (Plexel had
  them the other way round); Curves is a natural cubic spline, Photoshop's
  curve; Exposure works in linear light; Posterize cuts the range into equal
  bins. Each is now within a level of Photoshop's render on average.
  Brightness/Contrast follows Photoshop's modern curve (fitted to its
  renders, since Adobe doesn't publish it) and has **Use legacy** for the
  old straight-line version. Hue/Saturation's master settings follow
  Photoshop's order and its saturation formula.
- **Photoshop documents (PSD and PSB) export** from File → Export, with the
  same layers, a composite for apps that only show the flattened picture,
  the profile and resolution. Shapes go out as shape layers
  (their outline a vector mask, their fill and stroke Photoshop's own),
  text as type layers with Photoshop's text engine data, adjustments and
  effects as Photoshop's, smart objects with their contents inside the file.
  PSB is for documents past 30,000 pixels a side.
- **SVG opens** as shapes: paths and every shape element, groups,
  transforms, `use` and `symbol`, styles from attributes, `style` and
  simple class rules, fills and strokes with dashes, linear and radial
  gradients, opacity and `mix-blend-mode`, clip paths as vector masks,
  embedded images as pixel layers, and text as text. Gradients are moved
  onto Plexel's box-centred model with their colours where they were.
- **SVG exports** with shapes and text as vectors in sRGB, gradients in user
  space, opacity and blend modes, groups as groups and vector masks as clip
  paths; inside and outside strokes as a doubled stroke clipped to the shape
  or masked from it. Layers with effects, pixel masks or pixels are images
  inside it, and an adjustment layer flattens what's under it into one.
  **Text as outlines** writes exact paths instead of `<text>`.
- **PDF exports** for print: one page at the document's size, in the
  document's own profile (ICC-based colour), shapes as paths with
  gradients as shadings, text as outlines, opacity and blend modes, groups
  as transparency groups, vector masks as clipping paths, and images (with
  soft masks) for the rest. A CMYK document gets a PDF/X-4 output intent of
  its profile; fills and strokes linked to a spot swatch use a Separation
  colour space of its name, so the RIP makes a plate. Trim and bleed boxes
  are written.
- **CMYK JPEGs open**, through a JPEG decoder of our own (baseline and
  progressive, restart markers, Adobe's YCCK and inverted CMYK), as CMYK
  documents with their profile.
- **Open knows a file by what it is**: Photoshop and SVG files open
  whatever they're called, and the Open picker lists them.
- **Fixed on the way**: a shape's vector mask was written into PSD with
  each subpath record two bytes long, so the shape read back empty; layer
  names that aren't plain ASCII changed in a round trip; a path not opening
  with a moveto drew instead of drawing nothing; a gradient in user space
  measured its percentages against the shape, not the viewport; a clip path
  in the element's box units was read in user units; dashed circles
  started their dashes at the wrong point. A variable font's instances all
  had the face's PostScript name, so Inter Regular came back from a PSD as
  Inter Thin; each now has its own. Dense text fitted on screen could put
  more glyph segments into one tile than a frame's storage ring holds, and
  that tile was waited for for ever; it now gets a buffer of its own.
  Rasterizing a layer while reads were in flight could lose its tiles to a
  collection; they're made once the read is done (baking a filter through a
  selection had the same gap).
- **The bench** writes the 96 MP CMYK document, with everything on it, as a
  PSD in 32.6 s (it didn't finish in three minutes at first: pixels copied
  one at a time, and every readback waiting its turn behind the queue),
  opens it again in 20.3 s, and draws it 0.1 s later.
- **Checks**: `check:interchange` (headless) reads all 49 of psd-tools' PSD
  and PSB files, writes eight back and reads them the same byte for byte,
  round-trips 60 descriptors and 17 text layers' engine data, decodes
  jpeg-js's JPEGs to within a level of its references, reads resvg's SVG
  cases, and has pdf.js read the PDFs. `check:interchange-browser` draws
  Photoshop's adjustment files against Photoshop's own composites and 24 of
  resvg's cases against resvg's renders, round-trips eight PSDs and a PSB
  and draws them again, has Chrome draw Plexel's SVGs, and opens a CMYK
  JPEG. `check:adjust` holds the new tone formulas, `check:text` the
  instances' PostScript names, and `check:type` dense text drawn to its
  last tile.

## Print colour

Phase 10. A document going to press can be prepared and checked without
leaving Plexel: converted to the printer's profile and mode, proofed on
screen, its unprintable colours and heavy ink found, each ink looked at on
its own, and its spot colours kept as spot colours.

- **Convert to Profile** (Document menu) and **Document → Mode** (RGB
  Colour, CMYK Colour, Grayscale; 8 or 16 Bits/Channel): every layer's
  pixels converted in the engine, and every other colour the document
  keeps (fills, strokes, gradients and patterns, adjustments', filters' and
  layer styles' colours, smart objects' contents) on the page, through the
  same profiles, rendering intent and black-point setting, as one step.
  Curves and Levels keep their master curve across a mode change and say
  that their channels went. A large conversion says it's working.
- **Working spaces** in Colour Settings: the RGB, CMYK and Gray profiles
  Mode converts to (built in or loaded), working CMYK also the proof
  condition documents start with.
- **Proof Setup** (View menu): any profile, its intent and black point
  compensation, and whether the paper's white and the ink's black are
  simulated. **Proof Colours** (Ctrl+Y) shows the document as it would
  print, through a second display table: the document converted to the
  proof's device values, clipped to what it can print, then to the screen.
  A CMYK document proofed on its own profile is shown as it is.
- **Gamut Warning** (Ctrl+Shift+Y): what the proof condition can't print
  marked in grey, judged as the Colour panel judges it (out of an RGB
  device's range, or moved more than 2 ΔE2000 by the trip to a CMYK or
  Gray device and back). It's carried in the display table's alpha, so it
  costs nothing extra to draw.
- **The Separations panel**: inks switched off and on (each plate alone, or
  any mix), each ink and the total under the pointer, the total ink limit,
  and coverage over it marked on the canvas.
- **Colour adjustments in CMYK through the profile**: Hue/Saturation and
  the other colour adjustments take CMYK colours to RGB through the
  document's profile and back with black kept, solving C, M and Y with K
  held (`color/cmykAdjust.ts`), applied as a change so an adjustment that
  changes nothing leaves the inks exactly as they were.
- **Document swatches**, saved in the document: process, global and spot
  colours in their own spaces. Fills and strokes linked to a global or spot
  swatch, at a tint, follow it when it changes, and are made again from it
  after a conversion. Spot colours are drawn through their process
  equivalents. **Libraries**: Adobe Swatch Exchange files (`.ase`) loaded
  and saved.
- **Ctrl+Y is Proof Colours**, as in Photoshop; Redo is Ctrl+Shift+Z.
- **Checks**: `check:print` (headless) and `check:proof` (in Chrome) are
  new; `check:gpu` holds the display pass's proofing, gamut marks, hidden
  inks and ink limit to their reference in every mode, and the CMYK
  colour adjustments to theirs through the profile's tables.
- **The bench** proofs the 96 MP document on CMYK with the gamut marked
  (drawn again in 0.65 s, panning at the display's rate) and converts it
  to CMYK in 12.9 s.
- **Fixed on the way**: converting pixels through LittleCMS's float
  transforms took 54 s for 96 MP; the conversion is now sampled on a grid
  once and interpolated, as LittleCMS's own optimised transforms do, with
  RGB and Gray outputs kept roughly linear in the table so the shadows
  stay within a ΔE2000 of LittleCMS's answer. The tables for CMYK
  adjustments took 1.4 s to make; solving them on the table's own
  tetrahedra, whose Jacobian is exact, takes 0.5 s. A CMYK document proofed
  on its own profile was sent through the profile's inverse and back. The
  gamut check said every colour fits a Gray device. Display tables for
  thumbnails and exports were made again for every call; they're kept now,
  a few at a time, and freed when they drop out.

## Type

Phase 9. Text as Illustrator and Photoshop have it: shaped by HarfBuzz in
any script, set as point, area or path text with two composers, styled by
character and paragraph with named styles, and drawn through the vector
pipeline, so it takes fills, strokes, gradients, patterns, masks and
effects. In RGB, Gray and CMYK, at 8 and 16 bits.

- **The Type tool** (T): a click starts point text, a drag area text in the
  box dragged, a click on a closed shape's outline area text inside the
  shape, and Alt-click (or a click on an open path) text along it from that
  point, as in Illustrator.
  Nothing is added until the first character; the new layer is named after
  its text and undoes in one step. Clicking text edits it: the caret, Shift
  and the arrows (Ctrl for words), Home and End, Backspace and Delete
  (Ctrl for words), Enter and Shift+Enter, drag, double- and triple-click
  selections, cut, copy and paste, IME composition shown in place, and
  Undo and Redo inside the text, a run of typing at a time. Esc or
  Ctrl+Enter finishes.
- **HarfBuzz 14.6.0**, compiled to WebAssembly by `npm run build:hb` in
  the pinned Emscripten image, checked by SHA-256 like LittleCMS: faces and
  their names, variable axes and named instances, shaping with features,
  kerning and language, outlines through draw callbacks.
- **Layout** (`text/layout.ts`): bidi levels (UAX #9) and lines in visual
  order, line breaks (UAX #14), each run's script and a fallback font per
  character, shaping in paragraph context; the every-line composer
  (Knuth–Plass: justified text by demerits, ragged text by squared slack)
  and the single-line one; left, centre, right, justify and justify-all;
  indents, first-line indents, space before and after; area text in any
  shape's frame, line by line through its width at each band; text along a
  path, each glyph turned to it, from a start that can be moved.
- **Character settings**: font and style, size, leading (auto at 120%),
  tracking, kerning, baseline shift, horizontal and vertical scale,
  underline and strikethrough, variable axes, OpenType features (ligatures,
  small caps, figures, fractions and more), language. **Paragraph
  settings**: alignment, indents, spacing, direction, composer.
- **The Character and Paragraph panels** change the selected characters
  while editing, a whole text layer when it's selected, and new text's
  settings otherwise; the options bar shows font, style and size.
- **Character and paragraph styles**, named and based on one another: made
  from the selection, applied, redefined, renamed (double-click) and
  deleted (styles based on a deleted one inherit what it inherited). They
  live in the document, and settings made directly sit on top of them.
- **Fonts**: Inter Variable and its italic built in, with Noto Sans Arabic
  and Devanagari as fallbacks loaded when first needed; fonts added from
  files and kept in OPFS; the computer's fonts through Local Font Access;
  fonts carried in `.pxll` files (`fonts/<hash>.font`) where the font's
  licence allows, and kept in the journal for recovery. A missing font is
  named once, its text shown in Inter until the font arrives, then drawn
  again in it.
- **Glyph sets**: text reaches the engine as each glyph's outline once and
  a transform for every place it's set, attached on the way (the document
  doesn't hold them) and drawn by the vector pipeline as one shape. Their
  box is as tight as a path's, so a gradient sits the same on text and on
  its outlines.
- **Create Outlines** (Type menu, Properties) turns text into a shape with
  the same fills, strokes, masks and effects, exactly. **Rasterize** and
  **Free Transform** work on text; text layers have thumbnails that follow
  their fonts arriving.
- **The rasterizer**: an outline's segments are now sorted into bands of
  tile rows in one pass, and each band by tile column, with the backdrop of
  everything left of a column summed once. A tile reads only what crosses
  it, so a tile of dense text, or of a long path, costs what's on it.
- **Checks**: `check:text` (headless) and `check:type` (in Chrome) are new;
  `check:gpu` holds dense small glyphs and large turned glyphs with a
  gradient and a stroke to the reference in every mode and depth;
  `check:geom` holds the column sort to the whole band, exactly.
- **The bench** sets 60,000 characters of justified area text on the 96 MP
  document: laid out in 142 ms (49,000 glyphs from 41 outlines, 172
  lines), drawn fitted in 1.4 s and at 100% in 0.8 s, panning at the
  display's rate with 4.7 ms of CPU a frame at the 95th percentile.
- **Fixed on the way**: justified lines stopped short of the right edge
  when the words needed squeezing; now spacing can shrink. Area text in a
  circle could set its first line letter by letter where the frame was too
  narrow for a word; now such bands are skipped. A run of typing folded
  into the step before it, so Undo went back too far; now moving the caret
  starts a new step. Create Outlines left nothing selected, and Rasterize
  was greyed out for text. Text on a closed path couldn't run along its
  last side. Panning over dense text spent 10 ms of CPU on some frames
  sorting the whole outline for each new band of tiles; now it's sorted
  once.

## Vectors

Phase 8. Shapes and paths sit beside pixels in one document, painted by a
stack of fills and strokes, drawn on the GPU with exact edges at any zoom,
and combined live into compound shapes. In RGB, Gray and CMYK, at 8 and 16
bits.

- **The Shape tool** (U): rectangles with round, chamfered or set-in corners,
  ellipses, polygons, stars and lines, as live shapes whose box, corners,
  sides, points and inner radius stay editable in Properties. Shift keeps
  a shape square (a line at 45° steps), Alt draws it from the middle. The
  options bar sets the shape, its settings, and whether new shapes are
  filled (with the foreground) and stroked (with the background).
- **The Pen** (P): click for corners, drag for curves with mirrored
  handles (Alt breaks them), click the first point to close, Enter to
  finish open, Esc to throw away; the next segment follows the pointer. On
  the selected path, a click on a segment adds a point without changing the
  curve, on a point deletes it, Alt-click converts it, and on an open
  path's end carries it on.
- **Direct Selection** (A): points selected by clicking (Shift adds) or a
  box, dragged with their handles; handles dragged, a smooth point's other
  handle turning to stay in line (Alt makes it a corner); Alt-click
  converts; Delete removes; a click on another shape selects it. Editing a
  live shape's points makes it a path, as in Illustrator; Layer → Convert
  to Path does that on purpose.
- **The appearance stack**, in Properties: fills and strokes added,
  reordered, switched off and removed, each with a paint (colour; linear,
  radial, angular or diamond gradient with an opacity per stop, angle,
  scale and reverse; or a pattern in two colours, sized and turned),
  opacity and blend mode. Strokes have width, alignment (centre, inside,
  outside), corners, ends, miter limit, dashes and dash offset. A path's
  fill rule is non-zero or even-odd.
- **Compound shapes**: Layer → Combine Shapes → Unite, Subtract Front
  Shape, Intersect or Exclude combines the selected shape with the one
  below (or joins the compound below); the result is live, painted with its
  own appearance, and each shape's operation changes in Properties. Expand
  turns it into one path with its curves; Release gives the shapes back.
  Moving or transforming a compound moves its shapes.
- **Vector masks**, one beside each layer's pixel mask: Layer → Vector
  Mask → Reveal All or Hide All, then outlines drawn into it with the Pen
  or the Shape tool while its thumbnail is chosen. Feather, density,
  invert, on and off, as pixel masks have; their own thumbnail in the
  Layers panel.
- **Pattern Overlay**, the last of Photoshop's ten layer effects, with the
  same patterns (checkerboard, stripes, dots, grid), laid in the document's
  space.
- **Free Transform and Rasterize** on shapes and compound shapes;
  thumbnails for them in the Layers panel.
- **The rasterizer**: each pixel's coverage is the exact area its outline
  covers, from the segments crossing its tile (what lies left of the tile
  summed into one number a row), read by the kernel 16 rows at a time.
  Outlines are made once per shape and zoom level, and tiles read only the
  segments in their band of rows.
- **Geometry** (`geom/`): paths of cubics with exact bounds and adaptive
  flattening, live shapes, stroke outlines, curve-preserving booleans,
  path editing and hit tests, all pure and checked in Node.
- **Checks**: `check:geom` (headless) and `check:vectors` (in Chrome) are
  new, and `check:gpu` holds every paint, stroke, compound and vector mask
  to the CPU reference in every mode and depth, and Pattern Overlay too.
- **The bench** draws two hundred shapes, a compound and a 4,000-point path
  on the 96 MP document: 256 ms to draw the view again, panning at the
  display's rate.
- **Fixed on the way**: a long path's stroke overflowed the call stack and
  stopped the canvas drawing; now outlines are built without spreading, and
  a shape that can't be drawn is skipped and logged instead of stopping
  every frame. Panning re-rendered the whole app every frame (the status
  bar's zoom was read at the top); now only the status bar follows the
  view, which kept panning at the display's rate with hundreds of layers.

## Renamed to Plexel

- Pixlayer is now Plexel, at plexel.pages.dev (and plexel.dblpl.us once
  attached). Files keep the `.pxll` extension, and documents saved under
  the old name still open. Settings saved in the browser under the old name
  start fresh.

## Keys and the mouse are the app's

- The browser's own responses to keys and the mouse are kept from the
  page: find, print, reload, page zoom (Ctrl+wheel, pinching, Ctrl+=),
  back and forward (Alt+←, the mouse's side buttons, swiping), its context
  menu, autoscroll, caret browsing, Alt to its menu, and dragging images or
  dropping links onto the page. Text fields, dropdowns, sliders and buttons
  keep their own keys, Tab keeps moving the focus, and the developer tools
  and the clipboard keys are left alone (`input/guard.ts`).
- In full screen, Chrome and Edge lock the keyboard, so Ctrl+W, Ctrl+T,
  Ctrl+N and Ctrl+Tab come to the page instead of closing or opening tabs.
- `check:shell` checks what is cancelled and what is left alone.

## Adjustments, live filters, layer styles and smart objects

Phase 7. Layers can change how they look without their pixels changing,
and every such change stays editable: adjustment layers, filters that stay
live in a layer's effects, Photoshop's layer styles, and smart objects that
can be scaled up and down without losing anything. In RGB, Gray and CMYK,
at 8 and 16 bits.

- **Adjustment layers** (Layer → New Adjustment Layer): Levels, Curves,
  Brightness/Contrast, Exposure, Invert, Posterize, Threshold,
  Hue/Saturation, Vibrance, Colour Balance, Black & White, Channel Mixer and
  Gradient Map. Each adjusts what's under it, through its blend mode,
  opacity and mask; clipped, it adjusts only the layer it's clipped to; in
  a layer's effects, that layer alone. Tone adjustments on CMYK work on the
  inks, as Photoshop's do.
- **Their settings in Properties**, generated from each adjustment's list
  of parameters: sliders with typed numbers, switches, colours taken from
  the foreground, a Curves editor per channel, Levels with the document's
  histogram, and a gradient editor. A drag of one control is one step.
- **The Filter menu**: Gaussian Blur, Box Blur, Unsharp Mask, High Pass,
  Add Noise, Median and Motion Blur, each with a dialog that shows the
  result on the canvas as it's set. A filter is **live** by default: it
  goes in the layer's effects, listed under the layer in the Layers panel
  with its own eye, its settings changed in Properties at any time. Untick
  Live, or filter with a selection, and the pixels change for good, only
  where they're selected. **Filter → Apply Live Filters** bakes a layer's
  live filters in.
- **Layer styles** (Layer → Layer Style…, or double-click "fx" in the
  Layers panel): Drop Shadow, Outer Glow, Inner Shadow, Inner Glow, Satin,
  Colour Overlay, Gradient Overlay, Bevel & Emboss and Stroke, previewed as
  they're set, drawn in Photoshop's order. Shadows and glows blend with
  what's below in their own modes; Fill fades a layer's content but not its
  effects; with the special eight blend modes, Fill fades the layer's blend
  as Opacity does, close to Photoshop (ROADMAP.md says where it differs).
  **Clear Layer Style** takes them off.
- **Smart objects** (Layer → Smart Objects): Convert to Smart Object puts a
  layer's contents in a document of their own, drawn through the layer's
  transform from those contents at the resolution the view needs, so
  scaling one down and back up loses nothing. **Edit Contents** opens them
  in a tab; Save there puts them back as one step. Rasterize makes one a
  pixel layer again. Live filters and layer styles work on them as on any
  layer.

Writing the checks found these, all fixed:

- Applying a layer's live filters left nothing selected when an effect's
  row had been, so the filter commands that followed did nothing. The layer
  is selected now.
- Free Transform didn't know a smart object's bounds, so it wouldn't start
  on one.
- Rasterize was still only enabled for pixel layers.
- A filter baked through a selection rewrote transparent pixels outside
  it. Pixels the selection doesn't reach come back exactly as they were.

`check-adjust` covers the registries and their parameters headless, each
adjustment against what it means, the filter references and the effects'
distance fields. `check-gpu` holds every adjustment, filter and effect to
its CPU reference, smart objects to the same layer drawn directly, and
baked filters to live ones. `check-effects` drives them all in Chrome.

## Selections, masks and transforms

Phase 6. Part of an image can be selected and worked on alone, layers can
be hidden in part without losing anything, and layers move, scale, turn
and skew live, in every colour mode and depth.

- **Selections** are part of the document, as in Photoshop: each one is a
  step in the history and is saved in the file. A selection is coverage, so
  it can be soft. Select All (Ctrl+A), Deselect (Ctrl+D), Reselect
  (Ctrl+Shift+D), Inverse (Shift+F7).
- **The Marquee (M)**, rectangle or ellipse; **the Lasso (L)**, freehand or
  polygonal; **the Magic Wand (W)**, with tolerance, contiguous and
  sample-all-layers. Shift adds, Alt subtracts, both intersect, or the
  options bar's New, Add, Subtract and Intersect; feather and anti-alias.
  Dragging inside the selection moves its outline; a click deselects.
- **Select → Feather (Shift+F6), Expand, Contract**, and **Select and Mask**
  (Ctrl+Alt+R) with Smooth, Feather, Contrast and Shift Edge, previewed on
  the canvas as the sliders move.
- **Marching ants**, drawn by the engine in the frame's own view, from the
  selection's coverage, so they follow the image exactly at any zoom or
  angle.
- **Painting, filling and clearing go through the selection.** A stroke's
  coverage is multiplied by the selection's as it's laid on, so a feathered
  selection lets paint fade out. Delete with a selection clears it; Fill
  fills only it.
- **Quick Mask (Q)**: the selection as a red tint, painted with the brushes.
- **Layer masks** on any layer or group: Reveal All, Hide All, Reveal
  Selection, Hide Selection; painted with the brushes, filled and cleared
  through a selection; density, feather (live), invert, turned off and on,
  applied, deleted. Mask thumbnails in the Layers panel choose whether
  painting goes to the pixels or the mask; Shift-click turns a mask off,
  Ctrl-click loads it as the selection. Masks are evaluated on the GPU and
  multiplied into the compositing kernel's mask input.
- **Clipping as a command**: Create and Release Clipping Mask (Ctrl+Alt+G),
  and a hook on clipped layers in the Layers panel.
- **The Move tool (V)** and the arrow keys (Shift for ten pixels), and **Free
  Transform** (Ctrl+Alt+T, as Ctrl+T is the browser's): scale with or
  without proportions, about a corner or the middle, stretch, skew, move and
  turn, with handles drawn by the engine, a readout in the options bar,
  Enter to commit and Esc to cancel. **Edit → Transform** flips and turns
  by 90° and 180°. Moves and transforms show on the canvas as they're made
  and commit as one step.
- **Lock Position**, in Properties, is enforced by every move and transform.
- **Rasterize** bakes a pixel layer's live transform into its pixels.
- **Crop (C)** with straighten: drag the handles, move the box, turn it
  from outside. Nothing is cut away, as with Canvas Size; **Document → Crop to
  Selection** too.

Writing the checks found these, all fixed:

- Mask edits redrew nothing: masks aren't anyone's children, so the scene
  didn't know which layer they belonged to. They dirty their layer's area,
  and their versions are part of its content version, now.
- Canvas Size moved only top-level layers, and Crop would have too:
  transforms are in document pixels for nested layers as well, so every
  layer moves now. (`check:doc` had held the old behaviour as correct.)
- Escape didn't close a menu opened with the mouse, where the focus is on
  its title rather than in its list.
- Ctrl+A in a text field selected the document rather than the field's
  text; and with Enter, Escape, Delete and the arrows now commands, a
  plain key whose command couldn't run was still swallowed. A plain key
  whose command can't run is left alone now.
- The Magic Wand's anti-aliasing visited every pixel of the canvas: 6 s on
  a 96-megapixel document. It visits only tiles with something selected
  near them now, and writes fully selected tiles as one value: 1.7 s.

`check-select` covers the selection maths headless: shapes, combining,
Inverse, Feather, Expand and Contract, Select and Mask, the wand, filling and
clearing through a selection and Apply Layer Mask. `check-gpu` holds masks
(plain, inverted, thinned, moved, turned, feathered, two at once, on groups,
clipped layers and pass-through groups) and strokes confined to a selection
to CPU references. `check-tools` drives every tool and command in Chrome.

## Painting

Phase 5. Pixel layers can be painted, with a mouse or a pressure-sensitive
pen, at any zoom and angle, in every colour mode and depth. Strokes behave
as Photoshop's do, show on the canvas as they're drawn, and undo as one
step each.

- **The Brush (B) and the Eraser (E).** Size, hardness, roundness, angle,
  spacing, smoothing, opacity, flow, and a blend mode for the Brush. Flow
  builds up where dabs overlap; opacity is a ceiling one stroke never
  passes, however often it crosses itself. Shift-click draws a straight line
  from the last stroke; Esc abandons the stroke in progress. A stroke stops
  at the edge of the canvas.
- **Dynamics**: pen pressure, tilt, twist, speed, distance along the stroke,
  or a seeded random number, each through a curve, onto size, opacity, flow,
  hardness, angle, scatter or colour. The options bar switches pressure on
  and off for size, opacity and flow; presets use the rest. Jitter is
  seeded, so the same pen samples always make the same stroke.
- **Tips**: the round tip, and chalk, spatter and dry-bristle tips made from
  fixed seeds.
- **Nine brush presets** in a new **Brushes** panel, each shown with a stroke
  drawn by it, and presets of your own (Save Current Brush).
- **Pen input**: pressure, tilt and twist from every coalesced pointer
  sample, sent to the engine through shared memory as they arrive. **Edit →
  Pen Settings** sets how pressure responds, from soft to firm, with a pad
  to try it on.
- **Painting on transformed layers**: dabs are mapped into the layer's own
  pixels, so a brush paints the same on a layer that's been moved, scaled
  or turned.
- **The Colour Picker** (I): click for the foreground, Alt-click for the
  background, from a point or a 3 × 3 or 5 × 5 average of the composite.
  Alt with the Brush or Eraser picks too.
- **The Swatches panel**: click a swatch for the foreground, Alt-click for
  the background; add the foreground, remove with Delete or a right-click.
  Swatches keep the colour space they were picked in.
- **The options bar** above the canvas, generated from each tool's settings.
  Labels scrub when dragged; [ and ] change the brush size.
- **The brush cursor**: the brush's outline, drawn by the engine in the
  frame's own view, so it never drifts from the image.
- **Locks are enforced** for painting: a locked, hidden or non-pixel layer
  isn't painted, and a message says why.
- **History's memory cap**: past 1 GB of tiles that only older steps hold,
  the oldest steps are forgotten, beside the hundred-step limit.
- **The Colour panel keeps its hue** while you edit in HSB, so dragging Hue on
  a grey works.
- **Mips are kept by content**, so after a stroke only the mips above the
  tiles it changed are rebuilt.

Writing the checks found these, all fixed:

- Clicking the canvas left the focus in the text field typed in last, so
  tool shortcuts (I, B) typed into the field instead. The canvas now takes
  the focus away from fields when it's clicked.
- The options bar wrapped onto a second row for tools with many settings,
  so choosing a tool could move the canvas. It's one row of a fixed height
  now, scrolling sideways when it doesn't fit.
- Pen samples that reached the engine through shared memory before the
  stroke's own start message were dropped, losing the start of a fast
  stroke. They're held until the stroke starts now.

`check-brush` covers the brush engine and the painting reference, headless.
`check-gpu` holds strokes painted through the engine to that reference on the
GPU, in every mode and depth, and `check-paint` covers painting in Chrome.

## The render graph: layers on the canvas

Phase 4. The checkerboard gives way to the image. Every layer is drawn on
the canvas, composited the way Photoshop composites, colour managed through
the display's profile, at any zoom and any angle, on documents of any size.
Images come in from PNG, JPEG and TIFF and go out as PNG and JPEG, with
their profiles.

- **Compositing on the GPU**, with Photoshop's rules: all 27 blend modes,
  opacity and fill opacity, pass-through and isolated groups, knockout
  (shallow, to the layers under the group; deep, to the bottom layer), and
  clipping by nesting. CMYK blends as light, as Photoshop's does, so
  Multiply darkens in every mode. Every kernel has a CPU reference, and the
  GPU matches it to about 10⁻⁷.
- **Live transforms drawn**: a pixel layer is resampled through its
  transform with Nearest, Bilinear, Bicubic or Lanczos (Properties →
  Resampling), from a mip pyramid when it's shrunk.
- **Colour managed display**: the document goes through the display table
  built from its profile and the display's. With Colour Settings on Display
  P3, the canvas itself is Display P3.
- **The view**: the Hand (H), Zoom (Z) and Rotate View (R) tools in a new
  toolbar; Space to pan with any tool; the middle button; the wheel to pan
  and Ctrl+wheel (or a pinch) to zoom about the pointer. View → Zoom In
  (Ctrl+=), Zoom Out (Ctrl+−), Fit on Screen (Ctrl+0), 100% (Ctrl+1),
  Rotate View Left and Right 15°, Reset Rotation. The status bar shows the
  zoom, the rotation, and "Rendering…" while tiles are still coming.
- **Opening images**: File → Open takes PNG, JPEG and TIFF as well as
  `.pxll`, and each opens as a document in its own mode, depth and profile:
  a 16-bit PNG stays 16-bit, a CMYK TIFF stays CMYK. PNG and TIFF are
  decoded by our own code, every variant of each that the formats allow
  for, apart from JPEG-in-TIFF and floating point.
- **File → Import as Layer**, and images dropped on the canvas: a new layer,
  converted into the document's mode, depth and profile with the intent in
  Colour Settings, placed where it was dropped.
- **File → Export** (Ctrl+Alt+Shift+W): PNG at the document's depth with
  transparency, or JPEG on white at a chosen quality, with the profile
  embedded. The dialog says what the file will hold.
- **Layer thumbnails** are rendered by the engine, for pixel layers and
  groups.
- **Drag and drop in the Layers panel**: onto a row's top or bottom edge to
  go above or below it, onto its middle to go inside it. Inside a group
  groups; inside any other layer clips.
- **Properties**: Fill, blend modes grouped as in Photoshop's menu,
  Resampling for pixel layers, Knockout for groups.
- **Saving streams**: a `.pxll` is written straight to its file, one layer's
  tiles at a time, instead of being built in memory first. Saved files carry
  `thumbnail.png` and `preview.png`.
- **Opening big files**: a `.pxll` over 64 MB opens without reading its
  pixels. Each tile is read from the file the first time it's drawn, and
  dropped rather than spilled when memory runs short. Saving over the same
  file reads the rest first.
- **Graphics Information** shows the GPU's side: tiles on the GPU, display
  tiles, cached groups, and the compositing precision.
- **`npm run bench`** and **PERFORMANCE.md**: uploads, compositing per
  storage format, the first frame of a 96-megapixel document, and frame
  times while panning, zooming and rotating, against written budgets.

Decided by measurement: 16-bit documents composite in f32, and 8-bit ones in
f16 where the GPU has it (PERFORMANCE.md).

Writing the checks found these, all fixed:

- At 100% only the top-left of the canvas drew. A pixel layer's tile window
  had its origin taken off twice, once on the CPU and again in the shader,
  so every window not starting at the layer's first tile read the wrong
  tiles. A filled Background hid it for one column. The GPU probes now read
  from a window that starts further in.
- When an atlas grew partway through a frame, the copy into the bigger
  texture was submitted at once, before the frame's own commands that had
  written into the old one, so those tiles were lost. The copy now goes into
  the frame's command encoder, after them.
- Thumbnails failed to read back: the buffer they were gathered in couldn't
  be copied into.
- An imported image's layer was named "green 1" rather than "green". It
  keeps its file's name unless a layer already has it.
- Uploading a tile interleaved its planes sample by sample. Whole pixels at a
  time made uploads about half as fast again, and with two frames allowed in
  flight on the GPU, the first frame of a 96-megapixel document came in
  half the time.
- `check:gpu` and `check:canvas` took four and two and a half minutes. The
  probes now compare a spread-out sample of their random pixels, and the
  canvas check waits on the engine's word that it has drawn everything
  (`render.idle`) instead of on frame counts: 45 and 20 seconds.

`check-render-ref` and `check-images` cover the references, the view maths,
the scene and the codecs, headless. `check-gpu` holds the GPU to the
references on the real device, and `check-canvas` checks what's on screen,
the view, the panel, imports, exports and big files, in Chrome.

## Colour and pixels

Phase 3. Colour management, a Colour panel, and real pixels: layers hold
tiles in the engine's tile store, fills undo, and pixels save in .pxll
files and survive a crash in the journal. The canvas draws them in phase 4;
until then the Layers panel's thumbnails show what each layer holds.

- **The colour engine** is LittleCMS 2.19.1, compiled to WebAssembly in a
  pinned Emscripten image, behind a small C API of our own
  (`native/pxcms`). It runs on the page, in workers and in Node.
- **Built-in profiles** made from their published definitions: sRGB,
  Display P3, Adobe RGB (1998) compatible, ProPhoto RGB compatible, Rec.
  2020, Gray Gamma 2.2 and 1.8, and Generic CMYK, an ink model with dot
  gain, grey component replacement and a realistic black, plainly not a
  press profile.
- **The Colour panel**: foreground and background, RGB, HSB, Lab, CMYK and
  Gray sliders with live tracks, hex, X to swap and D to reset, and a gamut
  warning that fixes the colour in one click.
- **New Document → Background contents**: White, Black, Background colour
  or Transparent.
- **Layer → New Pixel Layer** and **Edit → Fill with Foreground / Background**
  (Alt+Backspace, Ctrl+Backspace), converted with the rendering intent in
  Colour Settings. Each fill is one undoable step.
- **Layer thumbnails** show a layer's colour, or the checkerboard when it's
  empty.
- **Edit → Colour Settings** (Ctrl+Shift+K): display profile, rendering
  intent, black-point compensation.
- **Document → Assign Profile**, including loading an ICC file, which is
  embedded in the document from then on.
- **The tile store**: copy-on-write tile sets, uniform tiles that cost
  bytes, a memory budget with spilling to disk, and collection of what no
  open document's history uses. Help → Graphics Information shows its
  figures.
- **.pxll files** carry each layer's tiles and any embedded profile.
- **The journal** stores tiles by content hash, so autosaving after an edit
  writes only the new tiles.
- **A second tab** no longer shares the first tab's autosave: it says it
  isn't autosaving, and leaves the first tab's journal alone.
- **Clicking the empty part of the Layers panel** deselects, so Properties
  shows the document again.

Writing the checks found these, all fixed:

- The Generic CMYK profile couldn't be saved as ICC bytes: LittleCMS writes
  lookup tables only at 16 bits and with curves around them. The tables are
  quantised and wrapped now.
- That profile was 2.3 MB, its tables written once per rendering intent.
  The intents share one copy now, at 790 KB.
- sRGB black counted as out of the CMYK gamut, because the check compared
  colours without black-point compensation. Gamut is judged by a round
  trip under the conversion's own settings now, in ΔE2000.
- The CMYK display table's worst error was 3.8 ΔE2000, near full black. Its
  points moved from C, M and Y to K: 1.3 at worst, in a quarter of the
  memory.
- A Dot Gain 20% profile was dropped: its curve couldn't be matched to
  Photoshop's from published information, and a profile with that name
  that renders differently would mislead.
- Once a layer was selected there was no way to deselect it, so the
  Properties panel couldn't show the document again (see above).

`check-color` and `check-tiles` cover the engine, the profiles, conversion,
the display tables, and the tile store, packs and journal, all headless.
`check-pixels` covers all of it in Chrome.

## Documents: making, saving, undoing and never losing them

Phase 2. Plexel now has documents: made, edited, undone, saved as `.pxll`
files, and kept safe in the browser between visits. There are no pixels
yet, but the document model they'll live in is complete, so later phases
add to it rather than change it.

- **New Document** (Ctrl+Alt+N), with presets for screen, print and photo.
  Sizes are typed in pixels, inches, centimetres, millimetres or points, and
  converted when the unit changes. Colour mode (RGB, Gray, CMYK), 8 or 16
  bits, and a colour profile per mode. A value that can't be used says why
  under its field.
- **Tabs**, one per open document, with a dot for unsaved changes, and a
  window title that says the same.
- **Save and Open.** `.pxll` files are zips any unzip tool can read. In
  Chromium, Save writes back to the document's own file and asks for
  permission when the browser wants it; elsewhere it downloads. Opening a
  file that's already open brings its tab forward. Drop a `.pxll` on the
  window to open it.
- **Recent files** on the start screen and in File → Open Recent (Chromium).
- **Autosave** to the browser's private storage. Reloading, closing the tab
  or a crash reopens everything that was open, unsaved changes and all,
  still tied to its file. The status bar says "Not autosaving" if the
  storage is full or missing, and only then does leaving the page ask first.
- **Closing a document** with unsaved changes asks: Save, Don't Save or
  Cancel, with Save focused.
- **Undo and Redo** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y), a hundred steps per
  document, each named for what it did. The Edit menu says which step Undo
  and Redo take, and the History panel jumps to any step. Dragging a slider
  is one step however far it goes.
- **The Layers panel**: select, show and hide, fold, rename in place (F2 or
  double-click), New Group, Delete, and Move Up and Down (Ctrl+] and Ctrl+[).
- **The Properties panel**: the selected layer's opacity, blend mode (all of
  Photoshop's), visibility and lock; the document's size, print size,
  resolution, mode and profile when nothing is selected.
- **Canvas Size** (Ctrl+Alt+C) around any of nine anchors, without cropping
  anything, and **Resolution**, which changes the print size, not the pixels.
- **The canvas** is drawn by the engine, fitted to the view, as the
  transparency checkerboard. The zoom is in the status bar.
- **Damaged and newer files** are refused with a reason; files repaired on
  the way in list what was repaired.
- **The crash screen** offers every open document as a `.pxll` download.

Writing the checks found these, all fixed:

- Canvas Size was named "Move Layers" in the history, because it moves the
  layers too. It's now named for what was asked.
- Forcing Zip64 put a Zip64 field on the `mimetype` entry, so a `.pxll`
  could no longer be recognised from its first bytes. `mimetype` never gets
  one now.
- After a dialog closed, the focus went back to the opacity slider, and
  Ctrl+Z did nothing, because any input counted as a text field. Only text
  fields keep the keys now.
- Delete pressed in the blend-mode dropdown would have deleted the layer.
  Dropdowns keep their own plain keys now.

`check-doc` covers the model, edits, history, step names and the loader's
repairs. `check-io` covers the zip code against itself, Node's zlib and zips
from Python, the `.pxll` format and the journal. `check-files` covers all of
it in Chrome, with file pickers that hand back real file handles.

## The shell and the engine

The first build: an editor's frame with nothing to edit yet, and an engine
worker that has the GPU and draws. Everything after this adds documents,
tools and panels to this shell rather than changing it.

- **The engine worker** gets a WebGPU device on an OffscreenCanvas, raising
  its limits to what the adapter allows and taking the optional features it
  uses when they're there (`float32-filterable`, `shader-f16`,
  `timestamp-query`). It draws the pasteboard through a real pipeline and
  shader, only when something changed, at the canvas's size in device
  pixels. When the device is lost it asks for a new one, up to three times in
  a row.
- **No WebGPU, plainly said.** A browser without WebGPU, or with no adapter,
  gets a page that says which, and what would fix it.
- **One command registry** for the menu bar, the shortcuts, the Ctrl+K
  palette and the Keyboard Shortcuts list.
- **The menu bar**: View (the palette, themes, dark and light, full screen),
  Window (the panels, Reset Workspace) and Help (Keyboard Shortcuts, Graphics
  Information, About). It works by mouse and by keyboard the way desktop menu
  bars do.
- **The command palette** finds a command from a few of its letters in order,
  ranks word starts and runs above scattered letters, and finds a whole
  category by its name.
- **The dock**: Properties, Colour, Layers and History panels that fold and
  close, a draggable edge, and a workspace remembered per browser.
- **Themes**: Graphite, Darkroom and Fjord, each dark and light, with a
  neutral grey pasteboard in all six.
- **The status bar** shows the engine's state, the adapter, and the canvas's
  size in device pixels, and warns if the page isn't cross-origin isolated.
- **Crash screen**: if the app fails to draw, the page says what broke and
  offers a reload instead of going blank.

Writing the checks found one bug, fixed: moving the window to a screen with
a different pixel ratio could leave the canvas at the old ratio, because the
resize observer doesn't always report a change of ratio alone. The ratio is
now watched with a media query as well.

`check-commands` and `check-theme` cover the registry, the menus, shortcuts,
the palette's search, view-state loading and every palette. `check-engine`
covers the device, drawing, theme changes, sizing on 1× and real 2× screens,
idling, and the no-WebGPU page. `check-shell` covers the menus, palette,
shortcuts, dialogs, dock and reload.
