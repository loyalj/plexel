# Plexel roadmap

Where the build stands, what comes next, and what's been put off on the
way. Read this first when picking the work up again. Update it at the end
of every phase, and whenever something is deferred or decided.

- **Design**: [ARCHITECTURE.md](ARCHITECTURE.md), including the build
  order this follows.
- **What shipped, and when**: [CHANGELOG.md](CHANGELOG.md).
- **Budgets and measurements**: [PERFORMANCE.md](PERFORMANCE.md), from
  `npm run bench`.
- **Feature coverage against Photoshop, Illustrator and Affinity** (with
  Krita and Inkscape alongside): the gap map, https://claude.ai/artifact/QpD1KdqmsSdcaXcLjoBdGd (updated after
  each phase).

Last updated: 12 October 2026, after vector construction (the last of the four phases asked for).

## Where it stands

| Phase | What | State |
| --- | --- | --- |
| 1 | Scaffold: shell, engine worker on WebGPU, checks, themes, deploy script | Done |
| 2 | Document core: node tree, edits, history, `.pxll`, autosave, save in place | Done |
| 3 | Colour and tiles: LittleCMS, profiles, Colour panel, tile store, pixels in files and journal | Done |
| 4 | The render graph: layers on the canvas, the view, images in and out | Done |
| 5 | Painting: brush engine, pen input, Brush, Eraser, Colour Picker, Swatches, Brushes | Done |
| 6 | Selections, masks and transforms: selection tools, Quick Mask, layer masks, clipping, Move, Free Transform, Rasterize, Crop | Done |
| 7 | Adjustments, live filters, layer effects, smart objects | Done |
| 8 | Vectors: shapes, the Pen, Direct Selection, the appearance stack, compound shapes, vector masks | Done |
| 9 | Type: HarfBuzz, fonts, point, area and path text, the composers, styles, the Type tool | Done |
| 10 | Print colour: conversion, proofing, the gamut warning, separations, document and spot swatches | Done |
| 11 | Interchange: PSD and PSB in and out, SVG in and out, PDF out, CMYK JPEGs | Done |
| 12 | Brushes: Brush Settings, image tips, texture, dual brush, ABR import, the Mixer Brush and Smudge | Done |
| 13 | The clipboard: cut, copy and paste of pixels, layers, styles and paths, with other apps | Done |
| 14 | Fills, gradients and selections: Fill, content-aware fill, the Gradient tool, fill layers, patterns from pixels, the Paint Bucket; Quick Selection, the Magnetic Lasso, Colour Range, Grow, Transform Selection, alpha channels, Select and Mask's edge | Done |
| UX | Between phases: tool cards, disabled commands that say why, key hints, sizing the brush on the canvas, the context menu, the Layers panel's actions, task workspaces, screen modes, Edit → Interface | Done |
| Panels | From the gap map: docking either side, columns, tab groups, floating panels, workspaces of your own; then rebindable shortcuts, columns folded to icons, workspace files, stacked floating windows | Done |
| Guides | From the gap map: rulers, guides (in PSD too), the grid and pixel grid, snapping with smart guides, several layers selected, align and distribute | Done |
| Warps | From the brainstorm: Free Transform's Distort, Perspective and Warp, Liquify, all live geometric effects | Done |
| Filters | From the brainstorm: thirty filters in Photoshop's submenus, Selective Colour, Photo Filter, Colour Lookup, Colour Grading, Hue/Saturation by range, filter layers, Document → Adjustments | Done |
| Appearance | From the brainstorm: effects per fill and stroke, graphic styles | Done |
| Construction | From the brainstorm: Pathfinder, the Shape Builder, Live Paint, Outline Stroke, Offset Path, Join, Simplify, Smooth | Done |
| 15+ | Chosen from the gap map | **Next** |

All forty-three check suites pass (`npm run check`, about ten minutes):
`doc`, `io`, `color`, `print`, `tiles`, `render-ref`, `images`, `brush`,
`select`, `segment`, `matte`, `retouch`, `adjust`, `geom`, `snap`, `text`,
`commands`, `interchange`, `theme` headless; `engine`, `shell`, `files`,
`pixels`, `gpu`, `canvas`, `paint`, `tools`, `effects`, `vectors`, `type`,
`proof`, `clipboard`, `fills`, `ux`, `guides`, `workflow`, `tiled`, `healing`, `warp`, `filters`, `appearance`, `construct`,
`interchange-browser` in Chrome.
The browser suites also pass against `vite preview` of a production build.
Every budget in PERFORMANCE.md is met but four. The 96 MP PSD reopened
and drawn fitted takes 3.4 to 3.7 s against 3 s; it was never met, as the
bench had measured it wrongly (107 ms) until phase 14. And since the run
after guides and snapping, panning with the two hundred shapes, over the
dense text and proofed run at half the display's rate, waiting on the GPU
(about 0.3 ms of CPU a frame). Taking guides and grids out of the overlay
didn't change it, so the shapes' drawing is the suspect (PERFORMANCE.md,
log).

First deployed on 11 October 2026, after phase 7, to the Cloudflare Pages
project `plexel` (https://plexel.pages.dev). Phase 10 was deployed on 11
October 2026, with phases 8 and 9, and phase 11 the same day. Guides,
grids and snapping were deployed on 11 October 2026, and the options bar
across the window on 12 October; tiled documents and retouching on 12 October too.
`npm run deploy` publishes each new version, served at
https://plexel.dblpl.us (attached to the project on 10 October 2026). (The project was
created with
`wrangler pages project create plexel --production-branch=main --force`:
since 4.14x, wrangler hands new Pages projects to Workers unless forced.
Existing projects deploy to Pages as before.)

Renamed from Pixlayer to Plexel on 11 October 2026. Files keep the
`.pxll` extension ("pixel layers"), and documents saved under the old name
still open. Settings saved in the browser under the old name aren't carried
over. The first deployment went to a Pages project called `pixlayer`
(https://pixlayer.pages.dev), which is no longer deployed to.

## Vector construction (done)

Last of the four asked for on 12 October 2026 (brainstorm step 6).

Decided on the way (12 October 2026):
- One region finder for Divide, the Shape Builder and Live Paint: the
  booleans run shape by shape, so regions keep the shapes' curves.
- Pathfinder makes paths (destructive, as Illustrator's panel does);
  Combine Shapes stays the live compound.
- Live Paint is a compound shape with fills kept as points in its regions,
  so the regions follow the paths; its paths' strokes draw over them.
- Not now: Live Paint's gap detection and edge colouring (strokes per
  edge), the Shape Builder's gap options and its merging by colour,
  Pathfinder's Outline; the Width tool and stroke profiles (brainstorm step
  8).

Built the same day: ARCHITECTURE.md (Geometry), MANUAL.md chapter 8; new
`check:construct`.

## Effects per fill and stroke, and graphic styles (done)

Third of the four asked for on 12 October 2026 (brainstorm step 5): where
Plexel can lead Affinity, which has several fills and strokes but no
effects on one.

Decided on the way (12 October 2026):
- An item's effects come in two stages: path effects change its outline
  before it's filled or stroked; pixel effects are live filters on what it
  paints, so every filter (and the new Drop Shadow and Outer Glow, filters
  for layers too) is an item effect without code of its own.
- Graphic styles copy into the node and link it; what's drawn is the
  node's own appearance; a change of its own unlinks it (Illustrator's
  rule). Fragments carry linked styles.
- Not now: Illustrator's other appearance effects (Scribble, Free
  Distort, Inner Glow, Feather) and item-level opacity masks; graphic
  styles' thumbnails drawn by the engine (they're a fill-and-stroke
  sketch); styles across documents (a library).

Built the same day: ARCHITECTURE.md (Vectors), MANUAL.md chapter 8; new
`check:appearance`.

## The filter and adjustment pack (done)

Third of the four asked for on 12 October 2026 (brainstorm step 3), for
the gap map's last large gap, filter breadth.

Decided on the way (12 October 2026):
- Distortions are geometric effects, as warps are; the radial ones keep
  the content's box as a frame when added, so they move with the layer.
- Colour adjustments that are any function of the colour compile to a
  colour cube, one GPU op for all of them; Hue/Saturation keeps its exact
  sums when only the master is set.
- Filter layers filter what's below them in their context (the nearest
  isolated group, or the document); geometric filters can't be layers.
- An effect's blend mode lays the filtered over the unfiltered, as
  Photoshop's smart filters' blending options do.
- Not now: masks on single live filters, Oil Paint, the rest of Pixelate
  and Render, Reduce Noise, Lens Correction, Camera Raw, Shadows/Highlights,
  Photo Filter and Colour Lookup in PSD files.

Built the same day: ARCHITECTURE.md ("The filter and adjustment pack", under
Adjustments), MANUAL.md chapter 7; new `check:filters`.

## Live warps (done)

Asked for directly (12 October 2026), with the filter and adjustment pack,
effects per fill and stroke with graphic styles, and vector construction:
"complete these next, in phases one after the other". Second of the ten
steps from the brainstorm.

Decided on the way (12 October 2026):
- One mechanism, geometric effects: a filter whose definition gives a map
  in the node's own coordinates; Warp (Free Transform's) and Liquify are
  the first two, the distortion filters of the next phase the rest.
- Free Transform keeps what's affine in the transform and puts the rest in
  one Warp effect, first in the effects; a warp is kept on a frame, so
  Rasterize can carry it.
- Shapes and text with flat colours are warped as outlines; anything else
  as pixels, reading a coarser level where the warp squeezes.
- Liquify is a backward field on a grid (at most 320 a side) over the
  content's box and a quarter more, in the file as base 64.
- Not now: Puppet Warp, Perspective Warp, Liquify's freeze mask and face
  tools, warped outlines in SVG and PDF, Perspective Crop.

Built the same day: ARCHITECTURE.md ("Warps"), MANUAL.md chapter 19; new
`check:warp`.

## Retouching (done)

Asked for directly (12 October 2026), first of the ten next steps from the
brainstorm on the gap map: the Retouching row, its only other large gap
besides filter breadth.

Decided (12 October 2026):
- **Clone Stamp (S)**: Alt-click sets the source; Aligned (on by default)
  keeps the offset from stroke to stroke, otherwise each stroke starts at
  the source again; Sample: Current Layer or All Layers. Live on the GPU,
  a sampling stroke of a new kind that reads the source at full resolution
  (not through the Mixer's 64-pixel patch), with the brush's tip, flow and
  dynamics.
- **Healing Brush (J)**: painted as the Clone Stamp, then healed on
  release: the source's texture with the destination's colour and tone,
  the difference at the stroke's edge spread smoothly inside (a membrane:
  pull-push, then relaxed). Worked out on the CPU in the engine, from the
  stroke's own dabs through the CPU reference, so it matches exactly.
- **Spot Healing Brush (J)**: no source; what's brushed is filled by
  content-aware fill (the PatchMatch inpainting already there) on release.
- **Patch (J)**: a selection (drawn with the Patch tool as a lasso, or the
  one there is) dragged to the area to take from; healed as the Healing
  Brush heals.
- Tiled documents: sources read round the edges.
- Not now: Content-Aware Fill's own workspace, the Red Eye tool, Content-
  Aware Move, diffusion and structure settings.

Built the same day: ARCHITECTURE.md ("Retouching", under Painting) has the
design, MANUAL.md chapter 18 how it's used; new `check:healing`. Decided on
the way: the Spot Healing Brush's preview is a gray wash at 60%, but it
fills all the way whatever the preview's opacity; a stroke with no source
set says to Alt-click first and paints nothing. Healing needs a layer on
whole pixels, unturned (it reads and writes pixel for pixel); the Clone
Stamp works on any. Left for later (deferred list): the source shown under
the brush while cloning, rotating or scaling the source, spot healing
across a tiled document's seam, Content-Aware Fill's workspace, Content-
Aware Move and Red Eye.

## Tiled documents (done)

Asked for directly (12 October 2026), after Krita's Wrap Around Mode and
Photoshop's Pattern Preview: an editing mode for seamless tiles.

Decided (12 October 2026):
- **The document is a tile** (a torus), not a view trick: **Tiled** is a
  document setting, saved in the `.pxll` and a step in the history, since
  whether a blur reads across an edge changes the picture itself. Off,
  both directions, horizontal only or vertical only (friezes, borders).
- **Tiled View** is the in-app switch that shows or hides the repeated
  copies around the canvas; view state, per browser like the grid.
- Built in three stages:
  - [x] **Stage 1**: the setting and Tiled View; the repeat drawn by the
        view pass; the pointer mapped from any copy back onto the
        document; the painting tools (Brush, Eraser, Mixer Brush, Smudge)
        stamping and sampling across the edges; an Offset filter that
        wraps; Define Pattern from the whole document.
  - [x] **Stage 2**: live layers drawn wrapped (shapes, text, transformed
        layers, smart objects crossing an edge appear on the other side);
        live filters and layer styles reading across the edges.
  - [x] **Stage 3**: selections, the Paint Bucket and gradients across
        the edges.
- PSD has no such setting: it exports as the single tile. Overlays
  (selection outline, guides, handles) show once, on the main copy.
- No default key (W is Quick Selection and the Magic Wand); it can be given
  one in Edit → Keyboard Shortcuts.

Stages 2 and 3 (12 October 2026): a tile job can be a copy (`shift`); plain
layers are drawn once per copy, anything that reads round itself once from
periodic sources, so a blur over the seam is one blur; selections, the
wand, the bucket and gradients work on the torus. Decided on the way: a
pixel layer wraps only the pixels in the canvas's rectangle in its own
pixels, since whole tiles carry padding past the canvas (a new document's
white) that would otherwise wrap over the other side; gradients take each
pixel's value from its copy nearest the line's anchor, so they run on over
the seam they're dragged across. The last four (masks of layers drawn
once, Select and Mask's edge and the Magnetic Lasso across the seam,
Offset's other edge modes beyond the canvas, knockout groups) followed the
same day; the deploy before them went out on 12 October 2026.

Stage 1 is in: ARCHITECTURE.md ("Tiled documents") has the design, MANUAL.md
chapter 17 how it's used; new `check:tiled`. Decided on the way: Offset is
a new kind of filter, one that remaps (`FilterDef.remap`), since it reads
from anywhere on the canvas rather than round a pixel; a layer's effects
are split at it. It works on the canvas and gives the canvas only, as
Photoshop's does. Applied for good, it needs a layer on whole pixels,
unturned (it's drawn on the canvas and moved back into the layer); live,
it works on any. The Mixer Brush and Smudge pick up across the edges only
on such a layer too (stage 2 wraps transformed layers). Painting wraps
whether or not Tiled View is on: the view only shows the copies. Define
Pattern takes the whole canvas from a tiled document, transparent edges
kept, so it repeats as the document does; the 1,024-pixel cap on patterns
stays. Not yet held to a CPU reference on the GPU: Offset's kernels are
checked through the screen in `check:tiled` and its mapping in
`check:adjust`; a `FILTER_CASES` row for remapping filters is to come.

## Your own keyboard shortcuts, and more for the panels (done)

Asked for directly (12 October 2026), closing the gap map's "Workspace &
shortcuts" row: shortcuts couldn't be changed, and three smaller things
were left from docking. ARCHITECTURE.md ("The interface") has the design;
MANUAL.md chapter 15 how it's used.

- [x] **Rebindable shortcuts** (`input/keymap.ts`): your changes kept apart
      from the registry, a command's whole list at a time; a key taken
      from whoever had it; the browser's, the developer tools', the
      clipboard's and Tab refused with a reason; recorded by place for
      digits and punctuation. `shortcutsOf` reads them, so every place
      that shows or matches a key has yours.
- [x] **Edit → Keyboard Shortcuts…** (`ui/ShortcutsDialog.tsx`), Ctrl+Alt+
      Shift+K and Ctrl+/: find, add, change, remove, take from another,
      reset one or all, on a draft that Save keeps.
- [x] **Columns folded to icons** (`Column.icons`): the strip along a
      column's top, icons grouped as the tabs, a flyout beside the column,
      the Window menu, icons that drag.
- [x] **Floating windows of several groups** (`FloatWindow.groups`):
      stacking at a group's foot, the grip, `moveWindow`, closed panels
      coming back above or below; old saves read.
- [x] **Workspaces as files** (`ui/workspaceFile.ts`): Export (with your
      keys) and Import, naming it and choosing whether to take its keys.
- [x] Panel icons in the registry (Phosphor), for the icon columns.
- [x] Checks: `check:commands`, `check:ux`, `check:shell`.
- [x] Docs, CHANGELOG, MANUAL, the gap map and this file.

Decided on the way: one set of keys per browser, not Photoshop's named
sets; an exported workspace carries them, which covers moving and sharing
a setup. Keys are changed on a draft (Save and Cancel), as in Photoshop.
A grouped tool's group key and its Shift key for the next are separate
commands, each yours to change; a tool given a key of its own shows that
one. Keyboard Shortcuts moved from Help to Edit, where Photoshop has it.
Which panel shows beside a column of icons is the dock's view state, not
the layout's, so it's never saved and closes on the next click, as
Photoshop's does. An imported workspace's keys are taken only when asked,
ticked to start with when you have none of your own, so yours are never
replaced unawares.

Found on the way: AltGr is Ctrl+Alt on Windows, so a letter is matched by
its key's place only on a Mac (where ⌥ changes it); otherwise typing ń on
a Polish layout would have been Ctrl+Alt+N. Not deployed yet. All 37
suites pass.

## Workflow from the second brainstorm (done)

Asked for directly (12 October 2026): five of the second round in
brainstorm.md, 29, 31, 34, 37 and 41.

- [x] **Picking layers on the canvas** (29): Ctrl-click, Alt deeper, Shift
      adds, Auto-Select (layer or group) on the Move tool. `app/pick.ts`
      tests each layer where it shows; the engine's `tiles.valuesAt`
      reads every pixel and mask at once. Direct Selection's shape picking
      now shares its hit test.
- [x] **Bird's-eye view** (31): hold H and press.
- [x] **Split View** (34): two panes on one canvas, each its own view; the
      renderer draws each through its view, scissored to its pane, and the
      page works in the pane under the pointer (`engine().canvasSize()` is
      that pane's size). The rulers' top measures each pane.
- [x] **Previous Tool** (37) on `.
- [x] **Swatches dropped on shapes** (41): fill, Shift for the stroke.
- [x] Checks: new `check:workflow`; `check:render-ref`, `check:commands`.
- [x] Docs, CHANGELOG, MANUAL, brainstorm.md and this file.

Decided on the way: Auto-Select is off to start with, as Photoshop's
default is; Ctrl turns it over for a press either way. A press with
nothing under the pointer keeps the selection, so a selected layer can
still be dragged from a clear part of it. Split View's cut is fixed in the
middle; dragging it, and splitting top and bottom, are left for later, as
is a split's second view being saved. The bench is unchanged (the four
known misses at the same numbers).

## The layer below selected (done)

Asked for directly (12 October 2026), from the deferred list: when the
selected layer goes, deleted or undone away, the one below it is selected
(else the one above, else its group), as in Photoshop, so Delete pressed
again deletes the next. With several selected, another of them that's
still there becomes the key layer. `doc/tree.ts`' `neighbourOf`, used by
the document store. `check:clipboard` had assumed a paste lands at the top
after an undo (nothing was selected); a paste goes above the selected
layer, so it now finds the pasted layer by its selection. All 36 suites
pass.

## The Layers panel's buttons (done)

Asked for directly (12 October 2026): icon buttons along the Layers panel's
foot for a new adjustment layer (a menu, upward), a new pixel layer,
Duplicate and Delete, replacing New Group and Delete (New Group stays in
the Layer menu). The context menu can open upward from a point for it.
Found on the way: dragging a panel group's foot read its start lazily,
inside React's state update, so a drag ending before the update crashed
the app; the Curves editor now sits near the Properties panel's foot, and
`check:effects`' drag landed on it. All 36 suites pass.

## The options bar across the window (done)

Asked for directly (12 October 2026): the options bar moved above the
document tabs, across the whole window as Photoshop's is, with the toolbar
at the window's left edge under it, level with the tabs and the docks. A
new left dock opens past the toolbar. Found on the way: a docked panel
squeezed by the others let its content spill out under the panel below
(the shorter docks made it show); it now scrolls. All 36 suites pass.

## Rulers, guides, grids, snapping and alignment (done)

Chosen from the gap map's "Snapping, guides & alignment" row (11 October
2026), a medium gap where Plexel had nothing. ARCHITECTURE.md ("Guides,
grids and snapping", under Tools) has the design; MANUAL.md chapter 16 how
it's used.

- [x] **Rulers** (`ui/Rulers.tsx`): five units, a mark at the pointer, the
      zero point dragged from the corner, a right-click for units, turned
      views measured along whichever axis runs with them.
- [x] **Guides** (`doc/guides.ts`): from the rulers, the Move tool to move
      and remove them, New Guide, New Guide Layout (previewed), New Guides
      from Shape, Lock, Clear, Show; in the history, `.pxll` and PSD
      (resource 1032, both ways); moved by Crop and Canvas Size.
- [x] **The grid and the pixel grid**, drawn by the engine's overlay pass
      (`render/overlay.ts`), thinning out as the zoom drops.
- [x] **Snapping** (`geom/snap.ts`, `app/snapping.ts`): guides, the grid,
      layers' boxes (`app/bounds.ts`), the canvas, anchor points, pixels;
      Move, Free Transform, Crop, Shape, Pen, Direct Selection, Gradient,
      Type, Marquee, Polygonal Lasso, guides and the zero point; Ctrl lets
      go.
- [x] **Smart guides** with equal spacing, and a readout by the pointer.
- [x] **Several layers selected** (`OpenDoc.others`, a key layer): Ctrl-
      and Shift-click in the Layers panel; Move, nudge and Delete on all.
- [x] **Align and distribute** (`geom/align.ts`, `app/align.ts`): the Layer
      menu and the Move tool's options bar, to the layers, the key layer,
      the canvas or the selection.
- [x] **Edit → Guides, Grid & Snapping…**, and the View menu's switches.
- [x] Checks: new `check:snap` (headless) and `check:guides` (browser);
      `check:interchange` (PSD guides), `check:commands`.
- [x] Docs, CHANGELOG, MANUAL chapter 16, the gap map and this file.

Decided on the way: guides are the document's (history, file, PSD) as in
Photoshop, while the grid, units and snapping settings are the browser's,
like the interface settings; the zero point is view state, not saved.
Snapping is on, and to everything but whole pixels, to start with, as
Photoshop's is; the browser checks that drag exact distances hold Ctrl or
land clear of targets. Tools snap the points they place (or the box they
move) rather than the pointer itself, so a press still hits what's under
it. Layers with pixels move by whole pixels when snapped or aligned;
shapes and text exactly. Ctrl+U is Smart Guides, as in Illustrator
(Photoshop gives it to Hue/Saturation, which is a layer here, without a
key). Several layers selected is a key layer plus `others`, so every
single-layer command kept working unchanged on the key layer.

Found on the way: Shift+; arrives as a colon, so shortcuts on ; and ' are
matched by their key's place too, as [ and ] already were.

## Docking, floating panels and your own workspaces (done)

Chosen from the gap map's "Workspace & shortcuts" row (11 October 2026),
leaving rebindable shortcuts for later. ARCHITECTURE.md ("The interface")
has the design; MANUAL.md chapter 15 how it's used.

- [x] **The layout** (`ui/layout.ts`): docks either side, columns, tab
      groups, group heights, floating windows; moves named by panels;
      closed panels reopen where they were; defensive reading.
- [x] **The dock** (`ui/Dock.tsx`): tabs, drag and drop with an indicator,
      Ctrl to float, Esc to cancel, column and group sizing, floating
      windows that move, resize, raise and stay on screen, the ⋯ menu.
- [x] **Workspaces of your own**: New (replacing one by the same name),
      Save Changes, Reset to as saved, Rename and Delete; in the menu, the
      switcher and the palette (run-time commands).
- [x] The saved workspace moved to v2, carrying a v1 save over.
- [x] Checks: `check:commands`, `check:ux`; `check:shell` unchanged.
- [x] Docs, CHANGELOG, MANUAL, the gap map and this file.

Decided on the way: the task workspaces stay one panel per group, as they
were, so they look as before; tab groups are yours to make. A panel's tab
click folds the group when it's already in front, as the title did. The
layout's sizes are in the interface's pixels, like the rest of the chrome.

## The UX pass (done)

Asked for directly (11 October 2026): brainstorm 25 ways to improve how
Plexel feels to use, then build ten of them. The other fifteen are in
[brainstorm.md](brainstorm.md), with what's there to build on and a
suggested order. ARCHITECTURE.md ("The interface") has the design.

- [x] **Tool cards** (1): name, key, what it does and every key and gesture,
      from `TOOL_DEFS.keys`; one tooltip layer for the app.
- [x] **Key hints** in the status bar (2): before a press, during a drag,
      in a session; held modifiers lit.
- [x] **Disabled commands say why** (3), in the menus and the palette;
      `check:commands` makes sure every one does.
- [x] **Alt and a right-drag sizes the brush** on the canvas (6), with the
      tip drawn at its size and hardness.
- [x] **The canvas's context menu** (9), from the registry.
- [x] **The Layers panel** (20, 21): Alt-click solo, peek, drag label and
      heavier drop line, lock, duplicate and delete on the hovered row.
- [x] **Task workspaces** (22): six, each kept as it was left, Reset.
- [x] **Tab, Shift+Tab and F** (23): hiding the panels and the screen modes.
- [x] **Edit → Interface** (24): size, density, contrast, motion, and
      switches for the help.
- [x] **Spring-loaded tools** (8, asked for next): hold a tool's key to use
      it and get the one before back on release; a tap still switches. A
      hold is over 250 ms, or any use on the canvas; let go mid-drag, the
      tool comes back when the drag ends. The status bar says which tool
      letting go brings back; Edit → Interface turns it off.
- [x] Checks: new `check:ux` (browser); `check:commands`, `check:shell`.
- [x] Docs, CHANGELOG, MANUAL chapter 15, brainstorm.md and this file.

Decided on the way: tooltips are asked for with attributes rather than
wrapper components, so any control can have one without restructuring;
native `title` tooltips elsewhere were left as they are for now. The
interface size is CSS `zoom` on the chrome only, never the canvas, so the
engine's device pixels are untouched. Tab is the app's only from the canvas
or with nothing focused, so keyboard users keep it for moving between
controls, and it can be turned off. A workspace saved before presets opens
as Essentials, as it was left.

Found on the way: the manual still called the Layers panel's eye "the
dot". Free Transform on an empty layer says there's nothing to transform
rather than opening, so the hints are checked with Transform Selection.

## Phase 14, fills, gradients and selections (done)

Asked for directly (11 October 2026), from the gap map's "Gradients &
fills" (small gap) and "Selection tools" (medium gap) rows. ARCHITECTURE.md
("Fills, gradients and patterns", and "Selections") has the design.

- [x] **Edit → Fill** (Shift+F5): Foreground, Background, Colour, Pattern,
      Content-Aware, Black, 50% Gray, White; Mode, Opacity, Preserve
      Transparency; through the selection, on a layer or its mask.
- [x] **Content-aware fill**: multi-scale PatchMatch completion
      (`retouch/inpaint.ts`) in a worker of its own.
- [x] **Fill layers**: a `fill` node kind (solid, gradient, pattern), Layer
      → New Fill Layer, Properties, Free Transform, Rasterize; PSD fill
      layers in; PSD, SVG and PDF out as shapes over the canvas.
- [x] **Gradients along a line** and the **Reflected** style, on every
      gradient paint, CPU and GPU.
- [x] **The Gradient tool** (G): five styles, six presets, reverse, mode,
      opacity; a live gradient fill layer by default, its ends moved by
      dragging again (shapes' gradients too); or into pixels.
- [x] **Patterns from pixels**: Define Pattern, `Doc.patterns`, sampled from
      a pyramid on the GPU and the CPU; in fills, fill layers, the Paint
      Bucket and shapes; converted and copied with the document; a
      Patterns panel.
- [x] **The Paint Bucket** (G).
- [x] **Quick Selection** (W): a graph cut round each stretch of the stroke.
- [x] **The Magnetic Lasso**: intelligent scissors, auto anchors, snapping.
- [x] **Colour Range**, with its eyedropper on the canvas; **Grow**,
      **Similar**, **Border**, **Smooth**; **Transform Selection**.
- [x] **Alpha channels**: Save and Load Selection, the Channels panel,
      saved in the file, moved by Crop and Canvas Size.
- [x] **Select and Mask**: Edge Detection with Smart Radius, the Refine
      Edge brush, Output To (selection, layer mask, new layer); floating
      beside the canvas.
- [x] Checks: `check:gpu` (the new paints and fill layers in every mode
      and depth), `check:select`, `check:doc`, `check:print`,
      `check:interchange`; new `check:segment`, `check:matte`,
      `check:retouch` (headless) and `check:fills` (browser).
- [x] Docs, CHANGELOG, MANUAL chapter 14, the gap map and this file.

Decided on the way: fill layers are a node kind of their own rather than a
shape over the canvas, so they have no edge when the canvas grows and the
Gradient tool can edit them live; other formats get them as shapes. The
Gradient tool makes a fill layer by default, as Photoshop's does since
2023 (Pixels is the other choice). Patterns live in the document as tile
sets, so they're saved, converted and collected with no new machinery;
there's no app-wide pattern library yet. Floating dialogs (Colour Range,
Select and Mask) take canvas presses while they're open, whatever the
tool. The three image algorithms (graph cut, live wire, edge matting) and
PatchMatch were written as pure modules with their own checks first, then
wired in.

Found on the way: a Magnetic Lasso point dropped by a click landed where
the pointer was, a few pixels off the edge; the wire's free end now snaps
to the strongest edge within the Width, as Photoshop's does.

## Phase 13, the clipboard (done)

Asked for directly (11 October 2026). Adds a clipboard row to the gap map
(it had none) and closes two deferred items: copying and pasting layers
and layer styles, and copying and pasting paths. ARCHITECTURE.md ("The
clipboard") has the design.

The clipboard holds a small document (a fragment): the copied layers, or
one pixel layer of copied pixels, in the mode, depth and profile they came
from, with the swatches and text styles they use. Pasting converts it into
the target document and puts its layers in with new ids. Its tile sets are
kept alive like any open document's. Other apps get a PNG (sRGB) and, for
text, the words; a marker in the clipboard's HTML says the clipboard still
holds Plexel's own copy, so pasting brings back live layers rather than
the PNG. Chrome showed the marker survives the trip (tested before
building).

- [x] **Copy** (Ctrl+C): with a selection, the target's pixels under it
      (a pixel layer's in its own grid, so a transformed layer stays exact;
      shapes, text and smart objects as Rasterize draws them; a mask's gray);
      with none, the selected layer itself, live.
- [x] **Cut** (Ctrl+X): the same, then cleared, or the layer deleted.
- [x] **Copy Merged**: everything visible under the selection, or the
      whole canvas.
- [x] **Paste** (Ctrl+V): above the selected layer; in place when that's in
      view, centred on the selection when there is one, otherwise centred in
      the view. **Paste in Place** (Ctrl+Shift+V). **Paste Into** and
      **Paste Outside**, masked by the selection.
- [x] **From other apps**: images as pixel layers, SVG markup as shapes,
      plain text as a text layer. The Edit menu reads the clipboard through
      the browser's permission; the keys don't need it.
- [x] **Across documents and modes**: converted with Colour Settings'
      intent; swatches and text styles come along.
- [x] **Layer → Duplicate Layer**, **Layer via Copy** (Ctrl+J) and
      **Layer via Cut**.
- [x] **Copy Layer Style** and **Paste Layer Style**.
- [x] **Paths**: with Direct Selection or the Pen, the selected anchors'
      paths copy, and paste into the selected shape or as a new one.
- [x] **File → New from Clipboard**.
- [x] Checks: `check:doc` (fragments: ids, masks, compound shapes,
      swatches, styles), `check:commands`, and a new browser suite,
      `check:clipboard`, through Chrome's own clipboard.
- [x] Docs, CHANGELOG, MANUAL chapter 13, the gap map and this file.

Decided on the way: Copy with no selection copies the layer, live, as
Affinity does, rather than its pixels as Photoshop does; with a selection
it's Photoshop's pixel copy. Copy Merged is Ctrl+Alt+Shift+C and Layer via
Cut has no key, since Chrome keeps Photoshop's Ctrl+Shift+C and
Ctrl+Shift+J for its developer tools. Ctrl+V pastes from the browser's
paste event, so it never asks for clipboard permission; the menus read the
clipboard and the browser asks once.

Found on the way: after Undo takes away the layer that was selected, no
layer is selected, so the Layer menu's commands that need one are off
until a layer is clicked. Photoshop selects the layer below. (Done on 12 October.)

## Phase 12, brushes (done)

Chosen from the gap map's "Brush engine" row. ARCHITECTURE.md ("Painting")
has the design.

- [x] **Tips from images**: any size up to 1,024 px a side, with mips read
      trilinearly; the built-in tips remade at 256 px; user tips kept in
      IndexedDB by content hash and sent to the engine once.
- [x] **Define Brush Preset** (Edit menu), from the selection or the canvas.
- [x] **ABR files** (Edit → Import Brushes, the Brushes panel's Import):
      versions 1, 2 and 6 to 10, sampled and computed tips, patterns, and
      every section's settings; what can't come over named.
- [x] **Brush Settings panel** (F5): every section listed in the plan,
      Protect Texture included, a curve editor for each control and a live
      stroke preview.
- [x] **Controls**: Off, Fade, pressure, tilt, rotation, direction, initial
      direction, speed (and distance, random), through curves; Brush Pose.
- [x] **Colour Dynamics** in RGB, CMYK and Gray.
- [x] **Texture** with the four papers and ABR patterns, its ten modes,
      depth and jitter, per tip or per stroke.
- [x] **Dual Brush**, **Noise**, **Wet Edges**, **Build-up**, pulled-string
      smoothing.
- [x] **The Mixer Brush** and **Smudge**, with Sample All Layers.
- [x] **The brush cursor** is the tip's outline; number keys for opacity
      (Shift for flow), Shift+[ and ] for hardness.
- [x] Checks: `check:brush` (sections, the outline, ABR files), `check:gpu`
      (every new dab, Smudge and the Mixer, all modes and depths),
      `check:paint` (keys, panel, Mixer, Smudge, Define, Import, cursor);
      the bench for the Mixer and Smudge on the 96 MP document.
- [x] Docs, CHANGELOG, MANUAL chapter 12, the gap map and this file.

Found on the way: the cursor outline's thinning collapsed every closed loop
(its ends meet, so the line between them had no direction), so image tips
showed a circle; the browser check caught it and `check:brush` now covers
it. The Mixer first put its canvas paint and its reservoir's paint down as
two layers in turn, so overlapping dabs always ended at the foreground
colour, and replaced what it carried at every dab when fully wet, so it
never dragged paint. It now puts down one mixture, keeps most of what it
picked up from dab to dab (more of it the wetter it is), and its reservoir
gets dirty, as Photoshop's does. The model is our own, tuned against
Photoshop's described behaviour; Adobe doesn't publish theirs.

Two browser checks had races that only showed on a warm shared server:
`check:files` took its screenshot before the first picture (about 350 ms
after the document is made) and `check:shell` read the panels before they
were drawn after a reload. Both now wait for what they test. F5 is now
Brush Settings, so `check:shell` closes the panel its F5 opens.

## Phase 11, interchange (done)

- [x] **PSD in**: layers and groups with their blend modes, opacity, fill
      and clipping, pixel and vector masks, adjustment layers, layer
      effects, embedded smart objects, text as text in its fonts, in RGB,
      Gray and CMYK at 8 and 16 bits with the profile; what can't come over
      named. PSB too.
- [x] **PSD out**: the same back, with a composite; shapes as shape layers,
      text as type layers with Photoshop's engine data, smart objects with
      their contents inside; what PSD can't hold named.
- [x] **SVG in and out**: paths, shapes, groups, fills and strokes,
      gradients, clip paths, blend modes, text as text and as outlines,
      embedded images, in sRGB.
- [x] **PDF out**: vectors as vectors, text as outlines (live text with
      subset fonts put off), pixels at their resolution, in the document's
      profile and mode; CMYK with a PDF/X-4 output intent; spot colours as
      Separation plates; trim and bleed boxes (no bleed beyond the edge
      yet).
- [x] **CMYK JPEGs** opened, with a decoder of our own.
- [x] Decided: our own PSD code, not ag-psd (README, Decisions).
- [x] Checks: psd-tools' Photoshop files (and a few from GIMP and others),
      resvg's SVG suite, jpeg-js's JPEGs, round trips through PSD, PSB and
      SVG, pdf.js reading the PDFs, and a browser suite for opening,
      exporting and the dialog. No Illustrator or Affinity files were to
      hand; their PSD and SVG output is the same formats.
- [x] Docs, CHANGELOG, MANUAL chapter 11, the gap map, and this file.

Found on the way: Levels and Curves applied the master before each
channel, the reverse of Photoshop; Curves was a monotone spline, not
Photoshop's natural one; Exposure worked on encoded values, not linear
light; Posterize rounded where Photoshop cuts equal bins. All four now
match Photoshop's own composites to within a level on average.

## Deferred

Things put off on the way, with where they're expected to land. When one
is done, move it to the CHANGELOG and take it off this list.

**Shell and workspace**
- Our own icons, drawn on Phosphor's 256-unit grid in its Regular and Fill
  weights, for what Phosphor has none of: the Mixer Brush, Smudge, Quick
  Selection, the Magnetic Lasso (today a mode of the Lasso, with no icon of
  its own), alpha channels and layer effects. Icons in the menus and on the
  panel tabs. (Later)
- Filters: a mask on a single live filter (Photoshop's filter mask); Oil
  Paint, Crystallize, Pointillize, Colour Halftone, Fibres, Lens Flare,
  Reduce Noise, Lens Correction, Shadows/Highlights; Wave's and Displace's
  Repeat Edge Pixels; Photo Filter, Colour Lookup and Colour Grading in PSD
  files (they go out empty, said); grading wheels as a face of their own
  beside the controls. (Later)
- Warps: Puppet Warp and Perspective Warp; Liquify's freeze and thaw
  mask, face-aware tools, pen pressure and its mesh shown; warped shapes and
  text written to SVG and PDF as warped outlines (today unwarped, with the
  live-filter warning); Perspective Crop; painting on a warped layer where
  it shows, not where its pixels are. (Later)
- Retouching: the Clone Stamp's source shown under the brush (an overlay
  of the source as it'll be laid), rotating and scaling the source; spot
  healing across a tiled document's seam; Content-Aware Fill's own
  workspace, Content-Aware Move, the Red Eye tool. (Later)
- Tiled documents: a `FILTER_CASES` row holding remapping filters to a
  CPU reference on the GPU; selection work that wraps on a huge document,
  read at a mip level (its period isn't whole pixels there). (Later)
- Named sets of keyboard shortcuts, as Photoshop has; one set a browser
  for now, carried by workspace files. (Later)
- Icons in a column folded to icons with their names beside them (wider),
  as Photoshop can; and a floating window folded to icons. (Later)
- The fourteen UX ideas not built yet: a home screen, a shortcut sheet on
  `?`, readouts at the cursor, a floating task bar, a
  navigator, scrubby labels and maths in every number field, before and
  after in previews, presets everywhere, named undo with thumbnails,
  progress and cancel for long jobs, a saved-status indicator, pending
  tiles that look pending, and touch gestures. brainstorm.md has each, with
  a suggested order. (Later)
- The rest of the interface's native `title` tooltips moved onto the
  tooltip layer (`data-tip`), so they share its look, delay and size.
  (Later)
- A context menu on the Layers panel's rows and on the panels. (Later)
- Alt-click on a mask's thumbnail to see the mask alone on the canvas, as
  Photoshop does. (Later)
- An installable, offline-capable app (PWA). (Later)
- Each document's view (zoom, pan, rotation) kept across reloads and in the
  file; today a document is fitted again when it reopens. (Later)
- The options bar scrolls sideways when a tool's settings don't fit; a
  compact layout for narrow windows. (Later)

**Workflow**
- Split View: dragging the cut, splitting top and bottom, and keeping the
  second view across reloads; the left ruler follows the active pane.
  (Later)
- A right-click with the Move tool listing every layer under the pointer,
  as Photoshop's does. (Later)
- Dragging the foreground colour, and colours from the Colour panel, onto
  shapes too; today it's swatches. (Later)

**Guides, grids and snapping**
- Distances shown by smart guides (Illustrator's measurement labels) and
  a measuring (Ruler) tool. (Later)
- Snapping to path segments (not only anchors), text baselines and a
  layer's visible edge rather than its box; angled smart guides. (Later)
- Guides at an angle, coloured or locked one by one, and guides per
  artboard once there are artboards. (Later)
- Distribute by a set spacing, as Illustrator's key object does. (Later)
- Free Transform, Group and Copy on several selected layers; today they
  act on the key layer. (Later)
- The zero point saved with the document, as Photoshop does; today it's
  view state. (Later)
- A grid per document (Affinity's), and grid styles (dots, dashes). (Later)

**Documents and history**
- History snapshots, and saving history in the file as Affinity does.
  (Later)
- Rolling backup versions of saved files. (Later)
- Layer search, filtering by kind, and a colour tag UI (tags are already
  in the model). (Later)

**The clipboard**
- Copying several layers at once: several can be selected now, and
  `fragmentOf` already takes a list; Copy takes the key layer. (Later)
- SVG on the clipboard for copied shapes and text, for vector apps; paths
  already go out as SVG. (Later)
- Live layers pasted in another tab or window: the marker names the page,
  so another tab takes the PNG. A fragment written to OPFS under the
  marker would carry them. (Later)
- Illustrator's Paste in Front and Paste in Back, and Paste on All
  Artboards once there are artboards. (Later)
- Copying from a mask leaves out its feather. (Later)
- Photoshop's Lock Transparent Pixels needs a fourth lock flag. (Later)

**Painting**
- Predicted pointer events, drawn ahead of the pen for display only, to
  shorten how far the stroke trails it. (Later)
- Erodible, airbrush and bristle tips (ABR files' come in round, named),
  and a stylus wheel control (the browser can't read one). (Later)
- Photoshop's tool presets (`.tpl`) and brush presets saved out as ABR.
  (Later)
- The Mixer Brush's paint model is fitted by eye to Photoshop's described
  behaviour, not measured against its strokes; Sample All Layers reads
  the image as it was when the frame began. (Later, if it matters)
- An initial-rotation control in ABR files follows the pen's rotation
  throughout. (Later)
- The retouching tools: Blur, Sharpen, Dodge, Burn, Sponge, the healing
  brushes and Clone Stamp, their own gap-map row. (A later phase)
- A stroke is limited to 1,024 tiles (about 256 MB of coverage); past that
  its far end isn't painted, and a message says so. (Later)
- Zoomed out so far that a stroke would need more than 32 × 32 tiles for one
  screen tile, it shows when it's committed rather than as it's drawn.
  (Later)

**Selections, masks and transforms**
- Moving and transforming the selected pixels (a floating selection): the
  Move tool and Free Transform move whole layers today. (Phase 7 or later)
- Select Subject and Select Sky, which need a model (perhaps run locally
  on WebGPU). (Later)
- Select and Mask's Decontaminate Colours (`select/matte.ts` has it; it
  needs an output that changes pixels), Output To "New Layer with Layer
  Mask" and a new document, its view modes (on black, on layers, black
  and white), and a Refine Edge brush that subtracts. (Later)
- Colour Range: Localized Colour Clusters, the subtracting eyedropper,
  Out of Gamut, and its own preview in the dialog. (Later)
- Alpha channels: painting and filling one as a target, thumbnails in the
  Channels panel, and the colour channels listed there. (Later)
- The Magnetic Lasso: Backspace to take back the last point, pen pressure
  for its width. Quick Selection and Select and Mask read documents over
  32 megapixels from a mip level, so there their edges are coarser.
  (Later)
- Typing X, Y, W, H and the angle in Free Transform; choosing the
  reference point. (Later)
- The wand's sample size. (Later)
- Loading any mask as the selection: today only one made from a selection
  and not moved or changed since. (Later)
- Unlinking a mask from its layer; masks always move with it. (Later)
- Crop's aspect ratios and presets, its overlay (rule of thirds), deleting
  what's cropped, and filling new corners after straightening. (Later)
- Quick Mask's options: its colour, and showing what's selected rather than
  what isn't. (Later)
- The wand reads a document over 64 megapixels from a mip level, so there
  its edges are two or more pixels coarse. (Later)
- Marching ants are drawn from the selection at the level being shown;
  straight after a zoom they're missing until that level's selection tiles
  render, usually a frame or two. (Later)

**Adjustments, filters, layer styles, smart objects**
- Auto and eyedroppers in Levels and Curves, Curves' histogram, adjustment
  presets; Hue/Saturation's range limits dragged (they come from files, and
  are Photoshop's defaults otherwise). (Later)
- Hue/Saturation's colour ranges are held to no Photoshop render: on the
  fixture whose ranges overlap and wrap round, the result is further from
  Photoshop's (mean 17.8) than with them left out (10.6). Photoshop doesn't
  publish how overlapping ranges combine; ours add, as GIMP's emulation
  does. More reference renders would settle it. (Later)
- Photoshop's modern Brightness/Contrast curve is fitted to four of its
  renders (about nine levels out on average); more reference renders
  would pin it down. (Later)
- Masks on individual effects (Photoshop's smart filter mask); their
  blend modes are in. (Later)
- Median (and Dust & Scratches) go up to 5 pixels and Motion Blur takes at most 64
  samples; a filter reads at most 512 pixels past a pixel at the level
  drawn (a Gaussian of about 170 pixels at 100%). (Later)
- Layer style extras: global light, contours, noise, Bevel's texture,
  presets and a Styles panel, scaling effects. Bevel & Emboss and Satin are
  close to Photoshop's, not the same. With the special eight blend modes,
  layer effects and fill are approximated: the whole layer's blend fades by
  fill, where Photoshop's leaves its effects alone. Layer effects aren't
  drawn on layers inside a knockout group. (Later)
- Smart objects: linked ones, placing files as smart objects, contents in a
  mode or depth of their own, and changing their canvas size; contents are
  updated on Save, not as they're edited. (Later)

**Fills and gradients**
- Patterns from pixels in Pattern Overlay: a layer style's patterns are
  still the four formulas (its parameter is a fixed choice; it needs a
  pattern parameter kind and the pattern buffer in the effects kernel).
  (Later)
- An app-wide pattern library (as the brushes have) and patterns larger
  than 1,024 pixels a side; today patterns are the document's. (Later)
- A gradient editor with presets of your own, colour midpoints and
  Photoshop's interpolation methods (perceptual, linear, classic), dither,
  and the Gradient tool's on-canvas stops. (Later)
- Content-Aware Fill's own workspace: choosing the sampling area, colour
  and rotation adaptation, output to a new layer. Today it's Edit → Fill's
  choice, on an unscaled, unturned pixel layer, searching at most 3,072
  pixels a side. (Later)
- Fills in a blend mode other than Normal (and Preserve Transparency) run
  pixel by pixel on the CPU in the engine worker; on the largest documents
  they take seconds. (Later, if it matters)

**Vectors**
- Stroke width profiles and arrowheads. (Later)
- Graphic styles: a library across documents, thumbnails drawn by the
  engine, Illustrator's Scribble, Free Distort, Inner Glow and Feather as
  item effects. (Later)
- Arrows and spirals, rounded corners on polygons and stars, and a corner
  widget on any path. (Later)
- Make Selection from a path, and a path from the selection
  (`Doc.selection.path` is reserved). (Later)
- Live Paint's gaps and edge colouring; the Shape Builder's gap options;
  Pathfinder's Outline. (Later)
- Gradient handles drawn on the canvas for a selected shape's gradient
  (the Gradient tool's drag sets its line today), freeform gradients and
  meshes. (Later)
- Combining more than two shapes into one live compound in one go
  (Pathfinder does it, as paths). (Later)
- Editing a compound's shapes on the canvas without selecting them in the
  Layers panel first. (Later)
- Strokes scale with their shape, so a stretched shape's stroke stretches
  too; Illustrator's "scale strokes" switch. (Later)
- Esc throws a Pen path away, as Esc cancels every session here;
  Photoshop keeps it. Enter keeps it. (Decide)
- A vector mask's feather goes through the pixel mask's blur, which
  check:gpu holds to its reference; the vector-mask probe checks them
  unfeathered. (Later)

**Type**
- Colour per character: text's fills and strokes are the layer's, as a
  shape's are; Illustrator and Photoshop colour runs. (Later)
- Threaded frames (text flowing from one frame to the next), text wrap
  round other layers, vertical text, and Photoshop's warped text. (Later)
- Hyphenation, tab stops, drop caps, bullets and numbering, optical
  kerning, and the composer's settings (word and letter spacing ranges).
  Tabs go in as characters but don't line up yet. (Later)
- Fallback fonts for Chinese, Japanese and Korean (a CJK font is about
  15 MB, too big to bundle; system fonts cover them where they're loaded),
  emoji in colour, and WOFF and WOFF2 files. (Later)
- Arabic shaped across a line end is shaped as one paragraph, so a letter
  at a break keeps its joining form for the joined word; Illustrator
  reshapes the pieces. (Later)
- The caret doesn't blink, and dragging past the edge of area text doesn't
  scroll it. Selected text layers show no box to resize area text's frame
  on the canvas; Free Transform scales the frame and text together. (Later)
- Text inside a compound shape; a shape's outline used as area text's frame
  or a text path live (today it's copied when the text is made, and the
  shape stays as it was), and Illustrator's choice of hiding it. (Later)
- The Character panel's font menu lists families in one list; a search
  box, favourites and previews in each font. (Later)
- Local Font Access needs the browser's permission and Chromium; the
  computer's fonts aren't listed elsewhere. (Later)

**Rendering**
- Panning with the bench's two hundred shapes (and the scenes after it,
  which keep them) runs at half the display's rate, GPU-bound, since the
  run after guides and snapping; not the overlay's guides and grids (taken
  out, the same). Find what the GPU waits on. (Next performance pass)
- The 96 MP PSD reopened and drawn fitted takes 3.4 s against its 3 s
  budget: the first frames lay out the dense text again and outline 192
  shapes. Draw the text's tiles at a coarser level first, or keep outlines
  across the round trip. (Next performance pass)
- Blending in linear light as a per-document option. (Later)
- Mip pyramids saved in `.pxll` files, so a huge document's first picture
  doesn't wait on uploading every tile (about 7 ms a megapixel now).
  (Later)
- One GPU memory budget shared by every tile format's atlas; today each
  has its own (PERFORMANCE.md). (Later)

**Colour**
- Lab and 32-bit float documents; the model has room for both. (Later)
- Spot colour channels in pixel layers (Photoshop's spot channels), and
  spot colours on gradient stops and patterns; today spots are for solid
  fills and strokes, shown through their process equivalents, and printed
  on their own plates in PDF. (Later)
- Pantone and other licensed colour books; libraries are ASE files the
  user has. (Later)
- Proof presets (named proof conditions), proofing against a second
  monitor profile, and Proof Setup kept with the document. Each open
  document has its own today, from the working CMYK space. (Later)
- An Info panel with readings under the pointer in any mode; Separations
  reads CMYK documents only. (Later)
- Converting runs in the engine worker, so the canvas waits (13 s for
  96 MP); a helper worker, a progress bar and Cancel. (Later)
- Simulate paper colour only changes anything with a profile that measures
  its paper; the built-in ones have a perfect white. (With measured
  profiles)
- The Colour panel's CMYK, RGB and Gray models outside the document's mode
  use the built-in defaults, not the working spaces. (Later)
- Profiles in the journal are written but never collected. They're small;
  collect them alongside tiles when it matters. (Later)

**Files and images**
- TIFF: JPEG-compressed TIFFs, floating point, BigTIFF, and Photoshop's
  layers inside TIFFs; TIFF export. Not reached in phase 11. (Later)
- An image's resolution (PNG `pHYs`, JPEG's JFIF and EXIF, TIFF's
  XResolution) as the document's resolution; images open at 72 ppi. (Later)
- Decoding images in a helper worker; today it's in the engine worker, so
  frames pause while a big image decodes. (Later)
- Export options: a matte colour for JPEG, PNG at 8 bits from a 16-bit
  document, choosing to convert to sRGB, metadata. (Later)

**Interchange**
- Once, in a full `npm run check`, `check:interchange-browser` timed out
  on its first file open against the dev server; it passed every other
  run, alone and in the full runs, and against `vite preview`. Watch for
  it. (Later)
- PDF with live, selectable text and its fonts embedded as subsets; today
  text is outlines. (Later)
- Bleed: a document setting for bleed beyond the trim, written as the
  PDF's bleed box; today trim and bleed are the document's edge. (Later)
- Opening PDF and Illustrator (`.ai`) files. (Later)
- In PDF, gradient strokes are drawn in their first colour and gradients
  with transparent stops are drawn opaque; an outside stroke on a shape
  whose subpaths overlap is clipped even-odd. (Later)
- Photoshop's patterns (images, in the `Patt` block): Pattern Overlay and
  pattern fill layers come in with one of Plexel's patterns or as their
  pixels, and Pattern Overlay isn't written. Patterns from pixels are in
  now; reading and writing `Patt` is what's left. Alpha channels in PSD
  files, in and out, likewise. (Later)
- Photoshop's smart filters, linked smart objects whose file isn't inside
  the document, warped text and text on a path (as pixels), and spot and
  alpha channels. (Later)
- Writing PSD: an inverted layer mask is written as it is (PSD has no
  inverted flag); a transformed one untransformed; global light is
  Photoshop's default. (Later)
- SVG in: filters, `<mask>`, patterns, markers, images linked from outside
  the file, SVGs embedded as images, radial gradients off their shape's
  centre (centred), and CSS beyond type, class and id selectors. (Later)
- Font names: text from a PSD whose font isn't here keeps its PostScript
  name, guessed into a family and style. (Later)

## Decisions waiting on someone

- **Measured CMYK press profiles.** ECI's free profiles (FOGRA39-based,
  eciCMYK, PSO Coated v3) are the likely choice, but their download sits
  behind a terms page, so a person has to read and accept the licence
  before they can be bundled. Until then, CMYK print work uses the
  printer's own profile, loaded as the working CMYK space (Colour
  Settings), through Convert to Profile or Proof Setup. Phase 10 left this
  open.

## Open technical questions

- None open. (Our own PSD code was chosen over ag-psd in phase 11; README,
  Decisions.)

## Working notes

- The interchange checks use fixtures from psd-tools (PSD and PSB, with
  Photoshop's composites as PNGs), jpeg-js (JPEGs with decoded references)
  and resvg (SVGs with renders), each with its licence beside it in
  `scripts/fixtures/`. pdf.js (`pdfjs-dist`, a dev dependency) reads the
  PDFs back; `run-ts.mjs` leaves it out of the bundle so it finds its own
  worker.

- The colour engine's WebAssembly is checked in. Rebuilding it
  (`npm run build:cms`) needs Docker Desktop running; the build pins
  LittleCMS 2.19.1 by hash and Emscripten 3.1.74 by image. HarfBuzz's
  (`npm run build:hb`) likewise pins HarfBuzz 14.6.0.
- Browser checks run Chrome headless on the real GPU with
  `--enable-unsafe-webgpu --enable-gpu`. File pickers in the checks are
  replaced with ones that return OPFS file handles. Headless Chrome
  refreshes at 30 Hz, which the bench measures and judges against.
- The page exposes `globalThis.plexel` (the engine, the document and view
  stores, the doc functions, `text.layoutOf` and `text.startFonts`, the
  colours, the proofing store, `convert`, `files.openFile` and the
  `exports` (PSD, SVG, PDF)) for the browser checks and the bench. The
  engine's `test.probe` call loads `render/probe.ts` on demand: the GPU
  probes (compositing, resampling, the display table, painting), the
  bench's measurements, and a dump of the display tiles. `render.idle`
  resolves when the canvas is up to date; checks wait on it rather than
  sleeping. `globalThis.plexelLazyBytes` lowers the size at which a
  `.pxll` opens with its tiles read on demand, and
  `globalThis.plexelHistoryBytes` the history's memory cap.
- Pen strokes in `check:paint` are synthetic pen PointerEvents with pressure;
  the canvas tolerates pointers it can't capture.
- `check:tools` drives the tools with Puppeteer's mouse and keyboard on an
  800 × 600 document at 100%, so an offset from the canvas's centre is one
  from the document's. Selection work is the engine's, so it waits for the
  history to reach the step it expects rather than for a frame.
- The selection and mask calls (`engine/selectHost.ts`) pin what they make
  for a minute and hold `tiles.gc` until they're done, so a collection the
  page asked for before committing can't take a new set.
- GPU errors are logged to the console as well as shown, so a browser check
  counts any as a problem.
- Each phase ends with: all checks green (`npm run check`, and the browser
  suites against `vite preview` of a build), the bench run and
  PERFORMANCE.md updated where numbers moved, then the README, CHANGELOG,
  MANUAL, ARCHITECTURE (where the design moved), the gap map and this file.
