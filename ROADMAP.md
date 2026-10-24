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

Last updated: 24 October 2026: working with many layers (dragging several layers at once, new layers going into the selected group and named after it, Rasterize on a group, Merge Layers; then from the brainstorm: Draw Into, numbering, folded groups opening, Select All in Group, Group and Ungroup, Move to Group, drag improvements and Alt-copy, the merge family, Combine into One Shape, folding commands, colour labels, Rename Layers); before it, brushes that change as they paint (bristle, erodible and airbrush tips, the stylus wheel), tool presets and ABR out, then patterns from artwork with pattern editing mode and Pattern Overlay from pixels; before it, typography (colour per character, hyphenation, justification ranges, tab stops, the Glyphs panel); before it, fonts that turn up (no false missing-font warnings, system fonts kept by name and listed by themselves, PSD fonts found later and drawn as Photoshop drew them meanwhile, a font menu with previews); before it, gradients on the canvas, freeform gradients and meshes.

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
| Quality | The quality and performance pass (below) | Done |
| Gaps | Channels, the Pen's editing, stroke profiles, the Width tool, vector brushes, Image Trace (below) | All six done: Channels, the Pen's editing, stroke features, the Width tool, vector brushes and Image Trace; **freehand vector tools next** |
| Boards | Artboards (the Artboard tool, presets, backgrounds, clipping, export each) and symbols (the Symbols panel, Edit Symbol live, Break Link) | Done |
| Flow | Shortcut sets, long jobs' progress and cancel, Zoom to Selection and Layer, the colour picker at the pointer, Edit Toolbar, defaults reset by a double-click, undimmed movable preview dialogs, Tiled View's frame | Done |
| Panels | From the third brainstorm: a column's height shared, sizes as proportions, tabs in a » menu, ⓘ hints for sentences, a type and spacing scale, scrubbing labels, slider bars, segmented choices | Done |
| Start | The start page, after Woodson's: Open and recent files with pictures, New with a card per preset and Custom… | Done; samples later |
| Gradients | From the gap map: gradient handles on the canvas, freeform gradients, meshes and the Mesh tool, gradients along and across strokes | Done |
| Typography | Ideas 13–17: colour per character, hyphenation, the composer's spacing ranges and glyph scaling, tab stops, the Glyphs panel | Done |
| Fonts | From the user's report and 25 ideas: ideas 1–6 and 10 (pending fonts, names kept, one lookup chain, system fonts listed by themselves, PSD fonts found later, Photoshop's pixels as a stand-in, a font menu with previews) | Done; 11–25 later, 7–9 skipped for now |
| Brush engine | From the gap map: bristle, erodible and airbrush tips, the stylus wheel and Initial Rotation, tool presets (and TPL files), brushes out as ABR | Done |
| Patterns | From the gap map: patterns from artwork, pattern editing mode (grid, brick and hex, spacing), Pattern Overlay with the document's patterns | Done |
| Many layers | From the user's workflow: several layers dragged at once, new layers into the selected group with its name, Rasterize on a group (and several layers), Merge Layers; then brainstorm ideas 1, 2, 4, 5, 6, 10–20, 22, 24 and 25 (Draw Into, numbering, Group and Ungroup, Move to Group, the merge family, Combine into One Shape, colour labels, Rename Layers…) | Done; ideas 3, 7, 8, 9, 21 and 23 later (group drawing defaults, Select Similar, selecting layers on the canvas, the panel's filter, counts before big jobs, compact rows) |
| 15+ | Chosen from the gap map | Later |

All fifty check suites pass (`npm run check`, seven to fourteen minutes as the machine allows):
`doc`, `io`, `color`, `print`, `tiles`, `render-ref`, `images`, `brush`,
`select`, `segment`, `matte`, `retouch`, `adjust`, `geom`, `snap`, `text`,
`commands`, `interchange`, `theme`, `static` headless; `engine`, `shell`, `files`,
`pixels`, `gpu`, `canvas`, `paint`, `tools`, `effects`, `vectors`, `type`,
`proof`, `clipboard`, `fills`, `ux`, `guides`, `workflow`, `tiled`, `healing`, `warp`, `filters`, `appearance`, `construct`, `channels`, `panels`, `flow`, `boards`, `artboards`, `layers`,
`interchange-browser` in Chrome.
The browser suites also pass against `vite preview` of a production build.
Every budget in PERFORMANCE.md is met (12 October 2026, after the first
fixes of the quality and performance pass: the pan regression was the page
re-rendering every frame, and the reopened PSD now draws in 2.83 s).

First deployed on 11 October 2026, after phase 7, to the Cloudflare Pages
project `plexel` (https://plexel.pages.dev). Phase 10 was deployed on 11
October 2026, with phases 8 and 9, and phase 11 the same day. Guides,
grids and snapping were deployed on 11 October 2026, and the options bar
across the window on 12 October; tiled documents and retouching on 12 October too. The
quality and performance pass was deployed on 13 October 2026, and Channels the same day; transform controls on shapes and the Pen's editing that evening, and stroke features after them. Then, the same day: the Width tool, vector brushes, WebP, the lasso's Photoshop habits, Save for Web, EPS, colour chips, the grouped toolbar, Image Trace and the freehand tools; then panels and controls; then shortcut sets, long jobs, zooming to things, the colour picker at the pointer, your toolbar, defaults, preview dialogs and Tiled View's frame. Artboards and symbols were deployed on 14 October 2026.
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

## The brush engine's gap, then patterns (done)

Asked for on 19 October 2026: close the gap map's "Brush engine" row, then
its "Patterns" row. Done the same day.

- Decided: bristle, erodible and airbrush tips are footprints chosen per
  dab, generated images named by their settings and a level
  (`brush/special.ts`), so the GPU's stamp kernel and its CPU reference
  didn't change and nothing new is sent to the worker; the stroke builder
  picks the level (bristle depth from pressure and tilt, erodible wear,
  a spray variant) and stretches, turns or moves the dab for tilt. Wear is
  counted on the page from the same samples and kept per tool. The stylus
  wheel is `PointerEvent.tangentialPressure` (the browser does read it); a
  pen that has never turned one counts as full on. Tool presets take and
  give each tool's own store, laid over only where the kind of value
  matches. ABR out carries Plexel's settings whole beside Photoshop's keys,
  so the round trip is exact. A pattern from artwork keeps its tile as a
  document (as a symbol does) and still has a repeat of pixels, so nothing
  that draws patterns changed; pattern editing mode is a tab that's a tiled
  document along the axes the layout repeats exactly, so the copies and
  seamless drawing are Tiled View's. Make Pattern copies the layers (the
  originals stay), as Illustrator's does.
- Done: `brush/special.ts`, the stroke builder (`special`, `wheel`,
  `initial-twist`, `StrokeOptions.wear`), the pen ring and pointer (the
  wheel), the Brush Settings panel (the three tips, their settings, Sharpen
  Tip), seven presets, the cursor; `io/abr.ts` (dBrush and dTips, codes 4
  and 7), `io/abrWrite.ts` and the Brushes panel's Export; `io/tpl.ts`,
  `app/toolPresets.ts` and the Tool Presets panel; `doc/patterns.ts`
  (`PatternTile`, `repeatOf`, `editTiling`, contents), `DocPattern.art` read,
  collected, dropped and converted, `fill.repeat`, `app/patternEdit.ts`,
  Layer → Pattern → Make Pattern, the Patterns panel's Edit and Pattern
  Options; Pattern Overlay's `image` and `imageScale` on the GPU and in
  fx/ref.ts.
- Checks: check:brush (footprints, splay, wear and the page's count, the
  leaning spray, the wheel, Initial Rotation, ABR special tips, ABR written
  and read back with and without Plexel's key, a TPL file), check:gpu
  (bristle, erodible and airbrush strokes; Pattern Overlay with a document
  pattern; every mode and depth), check:doc (layouts, tiling, contents,
  saved, collected, converted), check:paint (the tips in the panel, Sharpen
  Tip, Export, Tool Presets, a TPL file imported), check:fills (Make
  Pattern, the tab, layouts, edits going back, Done, Cancel, Save a Copy,
  Pattern Overlay on the canvas, a pattern from pixels opened).

Found on the way: Document → Mode didn't convert symbols' contents (their
pixels and colours stayed in the old mode); they convert now. Make
Pattern's box from the layers' bounds was a pixel layer's whole tiles;
it's the exact pixels now. check:fills' Magnetic Lasso clicked faster
than the gesture's double-click (350 ms), which closed the outline early
on a fast machine; the check waits between clicks. Page errors in the
browser checks now carry the first lines of their stack.

## Typography: ideas 13–17 (done)

Asked for on 19 October 2026 (ideas 13 to 17 of the 25); done the same day.

- Decided: a character's own fill and stroke (`CharProps.fill`, `stroke`,
  `strokeWidth`; any paint, the panel setting colours) replace the text's
  bottom fill and bottom stroke for those glyphs (added when it has none),
  the rest of the appearance going over everything, so Photoshop's colour
  runs and Illustrator's character colours both map onto it. Hyphenation
  by the hyphen package's TeX patterns (ISC; each language a lazy chunk),
  off by default so existing text doesn't reflow; "words longer than" as
  Photoshop counts. Word spacing, letter spacing and glyph scaling as
  Photoshop's least / wanted / most (80/100/133, 0/0/0, 100/100/100), the
  wanted values always applied; justification takes word spaces, then
  letters, then glyph scaling. Tab stops measured from the paragraph's
  start edge, default stops every four ems. Glyphs found from the font's
  cmap (read from the file, no wasm change), alternates by shaping.
- Done: `doc/text.ts` (the new settings, read back in range), `text/layout.ts`
  (hyphen breaks, both composers, `justification`, `placeLine`'s tabs,
  leaders and hyphens, paints per glyph), `text/hyphenate.ts`,
  `text/glyphs.ts`, `geom/glyphs.ts` (`paints`, `glyphSubset`),
  `vector/outline.ts` (`perCharacter`, `characterGroups`), Document →
  Mode converting characters' colours, PSD in and out (run colours and
  strokes, hyphenation, spacing ranges, auto leading), SVG (run fills in
  live text, groups in outlines), PDF and EPS (a path per paint), Create
  Outlines (a group of shapes per paint); the Character panel's Fill and
  Stroke, the Paragraph panel's Hyphenate, Hyphenation, Justification and
  Tabs, the Glyphs panel (Window → Glyphs).
- Checks: check:text (patterns load and break words, the limit and word
  length, soft hyphens, settings read back, wanted spacing, justification
  within ranges, tab stops of each kind with leaders and default stops,
  paints per glyph and the outline split, cmap and alternates);
  check:type (Hyphenate from the panel with patterns loading in the page,
  a run drawn in its own colour on the GPU, the Glyphs panel inserting a
  glyph and an alternate); check:interchange-browser (run colours,
  strokes and paragraph settings through a PSD).
- Left: a tab ruler on the canvas; gradients per character from the panel;
  Photoshop's tab stops in PSD; glyph names (the post table) in the Glyphs
  panel; hyphenation exceptions of your own (a dictionary).

## Fonts that turn up (done)

Reported on 19 October 2026: system fonts (Impact) drawn but called missing,
others left in a placeholder; a PSD's text in a stand-in font where another
web viewer showed the right one. 25 ideas drawn up; 1–6 and 10 asked for
and done the same day; 7 (Google Fonts lookup), 8 (Resolve Fonts dialog)
and 9 (font status in panels) skipped for now.

- Causes: `FontLibrary.face` answered null for a font still loading, and
  layout called that missing; a system font's entries were replaced by the
  file's own names once read, so text asking by the browser's names lost
  it; a PSD's PostScript names were looked up once, as it opened.
- Done: `resolve` (family and style, PostScript name, a guess from one,
  full or loosely written names, nearest style), `pending` and `status`,
  `keepNames` (browser's names stay, the file's kept as aliases);
  `TextLayout.pending`; warnings after `systemFontsSettled`, only for
  fonts still missing at the library's version; `autoSystemFonts` when the
  local-fonts permission is granted; PSD runs keep their PostScript name
  (style '') until found; text layers keep Photoshop's pixels
  (`KindProps['text'].stand`), drawn while fonts are missing or pending,
  dropped by edits, saved and converted with the tiles; `ui/FontPicker.tsx`
  and `app/fontMenu.ts`.
- Checks: check:text (pending, names kept, the lookup chain), check:doc
  (stand-ins kept, saved, dropped), check:interchange-browser (stand-ins and
  PostScript names from text.psd), check:type (with Local Font Access
  granted over the DevTools protocol: listed without a click, no false
  warning, PSD fonts found, the font menu).
- Left: ideas 11–25 (similar-font
  suggestions, collections, colour per character, hyphenation, the
  composer's spacing, tab stops, a Glyphs panel, drop caps and lists,
  vertical text, Find and Replace, spell checking, CJK fallbacks fetched on
  demand, threaded frames and wrap, optical kerning and an OpenType panel,
  live text in PDF and EPS); 7–9 when wanted. Kinds in the font menu come
  from names, not the fonts' own classification.

## Gradients on the canvas, freeform and mesh (done)

Asked for on 19 October 2026 from the gap map's Gradients row (Illustrator,
Affinity and Inkscape all meet it; Plexel was partial); done the same day.

- Decided: two new paint kinds, `freeform` (colour points) and `mesh` (a
  grid of coloured points), and `stroke: 'along' | 'across'` on a gradient;
  all in the shape's own coordinates. One paint kernel still: the new kinds
  read a field cut to the tile (stroke centre segments, freeform points, or
  a mesh's patches and points) from the binding image patterns use.
  Freeform blends by inverse distance (power 3, scaled by spread); meshes
  have straight-sided patches, found by inverting the bilinear map, and a
  Catmull–Rom spline through the points' colours (smooth across patches).
  Across a stroke follows the width profile; inside and outside strokes run
  from the path to the visible edge. The canvas edits the item open in
  Properties when it can (`paintFocus`), else the top fill, else the top
  stroke. Stops are drawn beside the line, clear of its end handles. Files
  that can't hold them take the shape as an image of itself.
- Done: `vector/mesh.ts` (inverse bilinear, the spline, split, resize,
  freeform weights), `vector/paint.ts`'s fields and CPU reference,
  `render/shaders/vector.ts` (kinds 8 to 10), `app/gradientEdit.ts` (the
  annotator, freeform points, the Mesh tool, Delete), Properties' Freeform
  and Mesh editors and Apply (Within, Along, Across) on strokes, the Mesh
  tool (in the Gradient slot; U in Illustrator's keys; icon grid-four);
  `mapPaintColours`, `paintColours`, `mainColour` in doc/vector.ts so
  conversion, masks, colorizing and the exporters handle every kind.
- Checks: check:gpu (five new probes: along, across with a profile, across
  an inside stroke, freeform, a warped mesh, every mode and depth),
  check:geom (the mesh arithmetic, files read back), check:fills (the
  annotator, freeform points, the Mesh tool on the canvas).
- Left: curved mesh lines with handles on mesh points (Illustrator's);
  freeform gradients' Lines mode; double-clicking a stop for its colour,
  and colour midpoints between stops; SVG 2's `meshgradient` read (Inkscape
  writes it); meshes and freeform gradients as PDF and EPS shadings (types
  4 to 7) rather than images; spot colours in meshes.
- Found on the way: check:fills' Magnetic Lasso check ("the outline followed
  the square's edges") fails, with the new editor's overlay switched off
  too; it looks older than this work. (Look into)

## The start page (done)

Asked for on 18 October 2026, after the start page of the sister project
Woodson; done the same day, samples left for later.

- Decided: the page fills the document area, on the pasteboard, in place of
  the card that floated over it, and shows on the same terms (nothing open,
  and the session restored). Two sections of square cards, Open first (as
  Woodson's own projects come first, so recent files don't sit under the
  presets), then New. A preset's card makes its document at once, as the
  dialog would with that preset and nothing changed (named Untitled, a white
  Background); **Custom…** is the dialog. A recent file's picture is the
  thumbnail.png the .pxll carries, kept in IndexedDB beside its handle (a
  `pictures` store, version 2 of the `plexel` database), since a handle
  can't be read without a click; it's taken from the file as it opens and
  from what's written as it saves. A document with nothing to draw has no
  picture, and its card shows an icon.
- Done: `ui/StartPage.tsx` (the cards, the arrow keys moving between them by
  where they sit, the × that takes a file off Recent), `newFromPreset` in
  `app/files.ts`, `readPxll` returning the thumbnail, `touchRecent` keeping
  pictures and `onRecentChange` so lists follow, `forgetRecent` dropping the
  handle and picture too; three icons (`start.custom`, `start.open`,
  `start.clipboard`).
- Checks: check:files (a preset card makes its document, a saved file's
  picture under Recent, × takes it off, Custom… opens the dialog, no Recent
  without File System Access).
- Left: **samples** ("Learn from a sample", as Woodson has): documents built
  in code, written as .pxll with pictures by a script, with a check that
  fails when a sample changes and its picture wasn't made again; opened as an
  unsaved copy. Candidates: a photo retouch (masks, adjustment layers), a
  poster (type, shapes, effects), a print flyer (CMYK, spot colours,
  proofing), an icon set (artboards, symbols), a painting (brushes, the
  Mixer Brush). Also: your own presets as cards; the last background and
  artboard choice remembered for the cards.

## Artboards and symbols (done)

Asked for on 14 October 2026, the first of the five biggest gaps, done the
same day.

- Decided: an artboard is a group at the top level with an `artboard`
  (size, background, clip), its corner its translation, so every existing
  edit (moving, Canvas Size, Crop, the Layers panel, PSD's groups) works on
  it; a symbol is a document of its own (as a smart object's contents) and
  an instance a `symbol` node; both expanded into plain layers for the
  engine, the exporters and picking (`doc/expand.ts`), so the renderer is
  untouched. Edit Symbol in a tab, live (one coalesced step a run in the
  document; the tab follows the document's undo), as smart objects open.
- Done: `doc/artboards.ts`, `doc/symbols.ts`, `doc/expand.ts`, the tree's
  `whereNew` (one place for where a new layer goes, artboards included);
  `app/artboards.ts` (New, from Layers, Release, the commit that grows the
  canvas and moves the view with it, export documents), `app/artboardTool.ts`,
  `app/symbols.ts`; the Artboard tool in Move's slot; the pasteboard (an
  overlay ink); artboard names on the canvas; Properties for artboards and
  instances; the Symbols panel; New Document's Artboard; Export's All
  artboards, Selected, Whole canvas (a zip); the Move tool moving layers
  between artboards; instances in Free Transform, Rasterize (the engine
  rasterizing a group), copy and paste; Illustrator's set has the Artboard
  tool on Shift+O.
- Checks: new `check:artboards` (headless) and `check:boards` (browser);
  check:ux (Move's slot now holds the Artboard tool).
- Left: PSD artboards read and written as Photoshop's (written as groups
  now); a page per artboard in one PDF; guides per artboard and Paste on All
  Artboards; editing a symbol in place on the canvas (isolation mode) and
  per-instance overrides; shared symbol libraries; 9-slice scaling; the
  pasteboard drawn under layers rather than over (overflow shows dimmed).

## Eight more from the brainstorms (done)

Asked for on 13 October 2026, done the same day:

- **Shortcut sets** (28): `input/keySets.ts`, Photoshop's (the registry's),
  Affinity's (the same keys: Affinity Photo follows Photoshop's for what
  Plexel has) and Illustrator's (its tools, Free Transform on E, Create
  Outlines, Hide, Swap). Chosen in Edit → Keyboard Shortcuts' Set menu,
  applied through `assignKey`; the menu names the set the keys match.
- **Progress and cancel for long jobs** (17): a `job` id on the call,
  `progress` messages and `job.cancel` (`engine/jobs.ts`, `app/jobs.ts`),
  a bar over the canvas with Cancel and Esc (`ui/JobBar.tsx`). Content-aware
  fill (its worker terminated), PSD import (per layer, yielding so the
  cancel lands), filters and adjustments applied for good and Apply Live
  Filters (the result dropped).
- **Zoom to Selection and Zoom to Layer** (32), and a double-click on a
  layer's thumbnail (`app/zoomTo.ts`, `views().fitBox`).
- **The colour picker at the pointer** (35): Shift+Alt and a right-drag
  (Ctrl+Option+Cmd on a Mac) with a painting tool or the Colour Picker
  (`ui/ColourHud.tsx`); Esc puts the colour back.
- **Edit → Toolbar…** (42): order, hidden slots under a "…" slot, one, two
  or automatic columns (`ui/toolbarPrefs.ts`, `ui/ToolbarDialog.tsx`).
- **Defaults marked, double-click to reset** (third round's 20): the shared
  controls' `defaultValue`; parameters' defaults, Properties' opacity,
  fill, density, feather and knockout, a stroke's settings, a shape's
  corners, the type panels' numbers.
- **Filter dialogs undimmed and movable** (asked for): `Dialog
  floating="preview"` for filters, adjustments, Layer Style, Offset Path
  and Simplify; the canvas pans under them and the rest of the interface
  waits; every dialog moves by its title bar and opens where it was left.
  Found on the way: a floating dialog didn't close on Esc once the focus
  left it, so now it does from anywhere.
- **Tiled View's frame and a way back** (asked for): the document framed
  in the accent (overlay style `frame`), and **Back to the document** when
  it's mostly out of view (`ui/TileHome.tsx`).
- Checks: new `check:flow`; check:commands (sets, the toolbar's prefs).

Left: Affinity Designer's own vector keys as a set of their own (they clash
with Photo's); a toolbar slot split into its tools, as Photoshop allows;
a cancel that stops a bake's GPU work part way; dialogs remembering their
settings as well as their place (the third round's 25).

## Panels and controls, from the third brainstorm (done)

Asked for on 13 October 2026: brainstorm 25 ideas for how Plexel feels
to use, with panels a known problem (scroll bars inside scroll bars, tab
bars half covered by the group below, sentences everywhere). Eight chosen
(1, 5, 7, 9, 14, 15, 17, 18) and done the same day:

- **One scroll level a column** (1): a docked column's groups share its
  height. Each takes the height of what's in it while there's room (the
  last the room left); when there isn't, `useLevel` holds every group to
  one height, the most that lets them all fit, so short panels stay whole
  and long ones scroll inside themselves. A group never shrinks past its
  tab bar and a strip (72 px). The Layers, History and Brushes lists
  scroll on their own, their buttons kept in view.
- **Sizes as proportions** (5): a divider between two groups trades height
  between them, and from then on every group in the column has a share,
  flex-grown from zero, so the column keeps its look at any window size.
  Double-click fits them again. `layout.ts` `setColumnHeights`,
  `fitColumn`; heights saved before read as shares.
- **Tabs that don't fit go into a » menu** (7), the front tab kept.
- **ⓘ hints for sentences** (9): `Hint` and `Label`, `Field`'s and
  `Dialog`'s `hint`; every `field-note` became a hint, a `field-meta`
  fact or a short `field-empty`; empty panels say "No document open" (what
  a panel is for is its tab's tooltip); the browser's `title` tooltips on
  elements became the app's (`data-tip`).
- **A type and spacing scale** (14): tokens on `:root`, the stylesheet's
  text sizes and gaps put onto them, paddings on the scale too; Compact
  redefines the larger steps.
- **Scrubbing labels** (15): every shared number field's label, the
  options bar's, and plain number fields in dialogs (`installLabelScrub`).
- **Slider bars** (17): `SliderField`, a range input drawn as the bar with
  the label and the number on it; every slider in panels and dialogs.
- **Segmented choices** (18): `Segmented`; parameters with up to three
  short choices, a stroke's Align, Corners and Ends, fill rule, corner
  style, the paint's kind, Knockout, Direction, Composer, Image Trace's
  mode, Interface's Density, Contrast and Motion.
- Checks: new `check:panels`; check:ux, check:vectors, check:canvas,
  check:fills moved from menus to the buttons.

The other seventeen, kept for later: a panel's least height kept and the
least used folded when a column runs out (2), double-click a tab to solo
its group (3), panels filling the room left by kind (4), larger drop
targets with words (6), Tab and Shift+Tab made easier to find (8), a Show
Hints setting (10), collapsible sections inside panels (11), labels and
controls on one grid (12), empty states with one action button (13),
arithmetic and units in number fields (16), recent colours in the chip
picker (19), double-click to reset a control, with a mark when it isn't
the default (20), the command palette for panels and settings too (21), a
task bar by the selection (22), notices that fade with Undo (23), hover
previews of blend modes, brushes and swatches (24), dialogs that reopen
where and as they were left (25).

## Image Trace, then freehand vector tools (done)

Asked for on 13 October 2026, in this order: Image Trace (the last of the
six gaps), then a Paintbrush for vector brushes and freehand drawing
tools. And keep the toolbar from running off the bottom as tools are
added.

The toolbar (done 13 October 2026): one slot per group of tools that share
a key, as Photoshop's (`ui/Toolbar.tsx` `TOOL_SLOTS`), the group's last
tool showing with a corner triangle; a flyout on right-click, a held press
or the triangle; Alt-click for the next; two columns when one doesn't fit
(a ResizeObserver), scrolling past that. 31 tools in 19 slots. New tools
join a group where Photoshop or Illustrator put them, so the bar only
grows by a slot for a new kind of tool. Checks: check:ux (slots, the
flyout, holding, Alt-click, two columns in a short window), check:paint.

Image Trace (done 13 October 2026), the last of the six gaps:
- Decided: filled shapes, abutting (each boundary between two regions
  fitted once and shared, so no gaps and no overlaps), one shape per colour
  in a group above the layer, the layer hidden; a dialog beside the canvas
  with Illustrator's presets for fills and the settings that matter
  (mode, threshold or count, paths, corners, noise, blur, ignore white),
  traced live in a worker (`trace/worker.ts`) with counts.
- Checks: check:geom (a square's corners and area exact, a circle smooth
  and within 3%, the circle and the hole round it one curve, noise,
  transparency, Ignore White, colours abutting to the image's area, gray
  levels, shrinking), check:vectors (traced from Layer → Image Trace,
  previewed, committed as one step, the image hidden, undo).
- Left: Illustrator's centerline tracing (Line Art, Technical Drawing: the
  shapes' middle lines as strokes); a live trace object that keeps its
  image and settings (the trace is shapes, and the image stays beside it,
  hidden); tracing by custom palettes or document swatches; overlapping
  ("stacked") shapes.

Freehand vector tools (done 13 October 2026):
- Decided: Illustrator's three, in one toolbar slot on N (Photoshop's B is
  the raster brushes): the Pencil, the Paintbrush (stroked with the chosen
  vector brush, plain for Basic) and the Blob Brush (filled shapes joining
  the same-coloured plain shapes they touch, in the same group). Fidelity
  in screen pixels. Edit selected (redraw between two places on the
  selected path, or carry on from an open end), Keep selected, Fill, Close
  when near; the Blob Brush's size ([ ]) and Merge only with selection.
- Done: `geom/freehand.ts` (fitting, nearest place, splicing, extending;
  the fitter shared with Image Trace, which gained smooth joins too),
  `app/freehand.ts`, the options bar. Checks: check:geom (fitting within
  the fidelity, fewer anchors when smoother, closing, splicing both ways,
  on a closed path, extending), check:vectors (N and Shift+N, a wave, a
  closed ring, a redraw, the Paintbrush with a brush, the Blob Brush
  joining and not, [ ]).
- Left: pen pressure (a width profile from it, for calligraphic strokes);
  the Smooth tool and Path Eraser; the Blob Brush joining across groups or
  erasing (Illustrator's Eraser on shapes).

## Colour chips (done)

Asked for on 13 October 2026: no more "Use Foreground" buttons; a colour
chip opens a small colour picker. Done the same day: `ui/ColourChip.tsx`
(a saturation and brightness square, a hue strip, the Colour panel's
models and hex, chips for the foreground, background and swatches; live,
one step through the caller's coalesce key; Esc, Enter or a click outside
closes it). It replaced the buttons in colour parameters (filters, fill
dialog, paints), both gradient stop editors and the swatch options, and
the browser's colour inputs (inks, alpha tints, guide colours, Save for
Web's matte). Checks: check:vectors (the fill's chip), check:channels (an
ink by hex; Esc leaves the dialog open), check:proof (a swatch from the
foreground).

## Asked for by users (done)

Asked for on 13 October 2026 from three users' lists (Photoshop and
Affinity users: WebP output, layer masking, the lasso, Save for Web, the
Pen, layers, blend modes, adjustment layers, print output). Most were
already there; four gaps, in this order, then back to the six gaps:

1. **WebP export** (done 13 October 2026): lossy at a quality or
   lossless, with transparency and the profile (put into the file by
   `io/webp.ts`, since Chrome's encoder leaves it out); WebP opens and
   imports too. Checks: check:images (the container), check:canvas
   (exported, lossless, opened again).
2. **The lasso's Photoshop habits** (done 13 October 2026): Alt as the
   button comes up carries the Lasso on in straight sides, Alt let go
   closes; Alt-drag freehand and Shift 45° in Polygonal mode; Backspace
   the last corner back (Polygonal, the carried-on Lasso, Magnetic, which
   also takes Alt-click straight sides). Sessions take keys first
   (`Session.takeKey`). Checks: check:tools, check:fills.
3. **Save for Web** (done 13 October 2026): Original, Optimized, 2-Up and
   4-Up panes that pan together, each file's size and download time;
   JPEG, PNG-24, PNG-8 (`io/quantize.ts`: median cut, dithering, one-bit
   transparency; `encodePngIndexed`) and WebP; the size it's made at;
   sRGB and the profile; remembered. The engine keeps the composite while
   the document is the same (`image.optimize`). Checks: check:images
   (palette, dithering, indexed PNG), check:canvas (4-Up, PNG-8 at half
   size saved). Left: GIF (PNG-8 does its job), metadata beyond the
   profile, a progressive JPEG (the browser's encoder makes baseline
   only).
4. **EPS export** (done 13 October 2026): `io/eps/write.ts`, EPSF 3.0 at
   PostScript Level 3 with the PDF writer's host: device colours (EPS has
   no profiles), Separation spaces for spot inks (and the DSC custom-colour
   comments), shfill gradients, text as outlines; flattened up to the last
   root layer that isn't opaque vectors, since PostScript has no
   transparency, the clear parts colour-keyed; spot channels overprinting.
   Checks: check:interchange draws the files with Ghostscript compiled to
   WebAssembly (`@jspawn/ghostscript-wasm`, AGPL, a dev dependency only,
   never shipped): colours, shadings, the flattened image's clear parts,
   CMYK inks, the spot plate. Left: a TIFF preview in the EPS header (most
   tools draw EPS themselves now), live text with embedded fonts.

## Vector brushes (done)

Fifth of the six gaps, started 13 October 2026.

Decided before starting (13 October 2026):
- **Three kinds, as Illustrator's**: an **art** brush bends one piece of
  artwork along the whole path (stretched to fit, scaled in proportion, or
  stretched between two guides so its ends keep their shape); a
  **scatter** brush puts copies along it (size, spacing, scatter off the
  path and rotation, each a range, varied the same way every time;
  rotation following the path or the page); a **pattern** brush repeats a
  side tile bent along it, with start, end and corner tiles if given
  (corners where the path turns sharply; tiles stretched to fit, or kept
  their length with space added).
- **A stroke takes a brush**: a stroke item holds the brush itself (copied
  in, as a graphic style's appearance is), so a shape draws the same
  anywhere, copied, pasted or in another document. The stroke's width is
  the brush's height on the path (times the brush's scale), its profile
  varies it, its opacity, blend and effects are the whole brush's;
  dashes, arrowheads, corners and ends don't apply.
- **Artwork** is filled regions in their own paints, made from selected
  shapes (fills, and strokes as their outlines). **Colorization** as
  Illustrator's: None (its own colours), Tints (the stroke's colour, lighter
  where the art is lighter), Tints and Shades (darker too) and Hue Shift
  (the art's key colour becomes the stroke's, the rest turned with it).
- **The document keeps a brush library** (Window → Vector Brushes), with
  built-in brushes listed after it; a built-in one edited in Brush Options
  is kept in the document under its id. Editing a brush's options offers
  to change the strokes using it.
- **Drawing**: each part bent through the path (the envelope code's
  `warpLines`), into one item with several paints, laid together so the
  stroke's opacity is the whole brush's. SVG and PDF get the parts as
  filled paths; PSD keeps the pixels and says so. Outline Stroke on a
  brush stroke makes its parts shapes, grouped.

The work (done 13 October 2026):
- [x] Model, reading, the library and built-ins (doc/vectorBrush.ts,
  vector/brushLibrary.ts).
- [x] Geometry: art, scatter, pattern, colorization (vector/brush.ts).
- [x] Drawing (outline parts, the graph, the reference), reach, picking.
- [x] The panel, Brush Options, Properties, commands; Outline Stroke.
- [x] SVG, PDF, PSD.
- [x] Checks (check:geom, check:vectors, check:interchange, check:gpu,
  check:commands), ARCHITECTURE.md (Geometry), MANUAL.md chapter 8,
  CHANGELOG, the gap map.

Left, with reasons:
- **Bristle brushes** (Illustrator's painterly vector brush): they're a
  raster look made of many translucent strokes; the raster brushes cover
  that.
- **A Paintbrush tool** that draws freehand paths with a brush: brushes go
  on paths the Pen, the shapes and text make for now; freehand drawing
  with curve fitting (Simplify's) is a tool of its own, worth doing next to
  this.
- Pattern brushes' inner and outer corner tiles are one corner tile, and
  Illustrator's automatic corners (made from the side tile) aren't made:
  without a corner tile the side tiles bend round.
- Art and pattern brushes overlapping at sharp turns fold as Illustrator's
  do; its "overlap: adjust" option isn't there.
- Brush libraries as files (Illustrator's .ai brush libraries) aren't
  read; brushes travel in documents.

## The Width tool (done)

Fourth of the six gaps, started 13 October 2026.

Decided before starting (13 October 2026):
- **In the Pen's group** (P, Shift+P to reach it; Photoshop's W is the
  Magic Wand, so not Illustrator's Shift+W): it edits the width
  points of a shape's topmost stroke (the profile stroke features made),
  on the selected shapes, or on any stroked shape the press lands on
  (which it then selects). Vector layers; compounds and text later.
- **On the canvas**, as Illustrator's: hovering the stroke shows where a
  point would go, across the stroke; each width point shows as a line
  across the stroke, its centre a point, its two edges handles. Dragging
  the stroke adds a point there and widens it; dragging an edge widens
  both sides in proportion (Alt: that side only); dragging the centre
  slides the point along the path between its neighbours (Alt: a copy);
  Shift-click selects several, and dragging one edge widens them all;
  Delete removes the selected; double-click opens Width Point Edit (each
  side and the whole width, in pixels).
- **The model stays the profile's points**: a share of the stroke's width
  each side, at a share of each subpath's length, so a path of several
  subpaths takes the same profile on each, as the stroke draws it. The
  first point added to a uniform stroke brings the ends with it at full
  width. A closed path's points at its start and end are the same place:
  one shows, and edits go to both. A profile left all at full width is
  uniform again.
- **Properties**: the profile's Flip Along and Flip Across, and profiles
  saved under a name of your own, kept by the browser, listed after the
  presets.

The work (done 13 October 2026):
- [x] Profile edits and measuring along a path (geom/width.ts).
- [x] The tool: hover, overlay, the drags, Delete, double-click.
- [x] Width Point Edit; Properties' flips and saved profiles.
- [x] Checks (check:geom, check:vectors), ARCHITECTURE.md (Geometry),
  MANUAL.md chapter 8, CHANGELOG, the gap map.

Left, with reasons:
- Compound shapes' and text's strokes: their outlines are worked out from
  other nodes, so a press can't be placed on one path; later, with the
  outline kept per node.
- One profile per stroke, shared by its subpaths (as the stroke draws it):
  Illustrator keeps width points per path, which a path of one subpath
  matches exactly.
- Illustrator's "Adjust adjoining width points" and Shift-drag spreading
  the neighbours along: points move one at a time.
- Saved profiles live in the browser, not in the document or a library
  file.

## Stroke features (done)

Third of the six gaps, started 13 October 2026.

Decided before starting (13 October 2026):
- **Width profiles** are width points along each subpath: where (0..1 of
  its length) and how wide each side is there (a share of the stroke's
  width), eased between points, as Illustrator's are. Presets give the
  points (Uniform, Taper Both, Taper Start, Taper End, Bulge, Pinch,
  Brush); the Width tool (the next gap) will move and add them on the
  canvas, so the model is the points, not the preset's name. The outline
  takes each point's own half-widths, both sides, joins and caps included.
- **Arrowheads** at either end of open paths: a shape (triangle, open,
  stealth, circle, square, diamond, bar) and a scale of the stroke's width,
  filled with the stroke's paint; the line stops short under a filled head
  so it can't show past the tip. Closed paths have none.
- **Dashes aligned to corners**, as Illustrator's: the path cut at its
  corners (anchors whose two sides don't continue each other) and ends,
  and the pattern stretched on each run to a whole number of repeats,
  half a dash either side of every corner, so corners and ends are always
  dashed. Corners come from the flattening (flattenPath marks them).
- **Scale Strokes** is Illustrator's preference, in the Move tool's and
  Free Transform's options: on (the default), a shape's strokes scale with
  it, as now; off, Free Transform and the transform controls change the
  strokes' widths and dashes by the opposite amount, so they look as wide
  as before. Kept by the browser. Non-uniform scaling keeps the stroke as
  the shape's transform draws it (wider one way), as before.
- **In files**: SVG and PDF get a stroke with a profile, arrowheads or
  aligned dashes as its outline, filled (exact; plain strokes stay
  strokes). PSD's shape strokes can't hold them: the stroke is written
  plain and that's said.

The work (done 13 October 2026):
- [x] Model and reading; presets.
- [x] The outline: profiles, arrowheads, aligned dashes; reach.
- [x] Properties: profile, arrowheads (each end, size), align dashes.
- [x] Scale Strokes.
- [x] SVG, PDF and PSD.
- [x] Checks (check:geom, check:vectors, check:interchange), ARCHITECTURE.md
  (Geometry), MANUAL.md chapter 8, CHANGELOG, the gap map.

Left, with reasons:
- Editing the profile's points by hand: the Width tool, done after this.
- Scale Strokes off with a non-uniform scale keeps the stroke as the
  shape's transform draws it (wider one way); and it unlinks a shape from
  its graphic style, since its strokes change (Illustrator's rule).
- Arrowheads on dashes' ends, and Illustrator's "tip beyond the end"
  placement: heads go at the path's own ends, tip on the end.
- Profiles on text strokes go along each glyph's contour, as they do in
  Illustrator once outlined.

## The Pen's editing (done)

Second of the six gaps, started 13 October 2026.

Decided before starting (13 October 2026):
- **Points across several shapes.** The selected points are kept per
  shape (by node id), not for one target: Direct Selection's box takes the
  points of every visible, unlocked shape it reaches, and those shapes
  become the selected layers; Shift-click adds another shape's point; a
  drag moves every selected point, each in its own shape's coordinates, as
  one step; Delete, Convert, Join and Break work on all of them. Every
  selected shape shows its outline and points. The Pen still draws on one
  path (the key layer's).
- **The Curvature tool** (in the Pen's group, Shift+P): clicks place
  smooth points, the curve through them worked out from their neighbours
  as Illustrator's does (each smooth point's handles along the line
  between its neighbours, a third of the way to each; an open end's
  turned towards the next point's); Alt-click places a corner. On a path:
  click a segment to add a smooth point, drag a point to move it with the
  curve following, double-click a point to make it a corner or smooth,
  Delete removes it.
- **"Smooth-curve display like Affinity's"**, read as Affinity's Smart
  pen mode and its point display: a **Smart** option for the Pen, which
  makes each clicked point smooth with its handles worked out as the
  Curvature tool's (a drag still pulls them out by hand), the rubber band
  showing the curve as it will be; and smooth points drawn round, corners
  square, as Affinity draws them.
- **Joining and breaking.** Path → Join: two selected end points (of one
  shape or two) joined by a straight segment, or merged into one point
  where they meet; with shapes selected and none of their points, their
  open paths joined end to end into one shape, nearest ends first (one
  shape's own ends, as before). Path → Break at Points cuts the paths at
  the selected points (a closed path opens there); Path → Separate makes
  each subpath a shape of its own.

The work (done 13 October 2026):
- [x] Points across several shapes: the selection, the box, drags, Delete,
  the overlay. (Alt-click converts one point, as before.)
- [x] Round and square points.
- [x] The curvature rule; the Curvature tool; the Pen's Smart mode.
- [x] Join, Break at Points, Separate.
- [x] Checks (check:geom for the rules, check:vectors through the UI),
  ARCHITECTURE.md, MANUAL.md chapter 8, CHANGELOG, the gap map.

Left, with reasons:
- Dragging a whole segment's curve with the Curvature tool or Direct
  Selection (Illustrator's segment reshaping): a drag on a segment moves
  its two ends, as before.
- Separate gives the new shapes the look but not the masks or effects of
  the one they came from (a mask can't be shared); they stay on the first.
- The Pen still draws into one path (the key layer's); points of several
  shapes are for Direct Selection, Delete, Join and Break.
- Smart and the Curvature tool recompute the handles of smooth points next
  to the one changed, hand-made ones included, as Illustrator's Curvature
  tool does.

## Transform controls on shapes (done)

Asked for on 13 October 2026, between Channels and the Pen's editing: with
the Move tool, selected shape layers (one or several) show Free
Transform's box and handles. Done the same day: a drag on a handle or just
outside a corner is a Free Transform for that drag, committed on release;
Free Transform works on several layers (one box, the same affine; no
warps); the cursor follows the handle under it. `check:vectors` drives it.
Not now: the same for text, pixel and smart-object layers (Photoshop's
Show Transform Controls as an option), and the box following the layers
during a move (it hides, and comes back where they end up).

## Channels (done)

First of the six gaps, asked for on 13 October 2026.

Decided before starting (13 October 2026):
- **A channel is coverage, as now.** `DocChannel` gains a kind (alpha or
  spot; absent is alpha). An alpha channel keeps how it shows: a tint
  (sRGB, red by default), its opacity (50%), and whether the tint marks
  what's masked (the default) or what's selected. A spot channel keeps its
  ink: a name (the channel's), a colour in its own space as swatches keep
  theirs, and its solidity. Its tiles are the ink's amount (1 full ink),
  so a missing tile is no ink, as a missing coverage tile is nothing.
- **What's shown and what's edited are view state** (app/channels.ts), per
  open document, not in the history or the file, as in Photoshop: which
  colour channels are shown, which alpha and spot channels are shown
  (spots shown, alphas hidden, until changed), and the target: all colour
  channels, some of them, or one alpha or spot channel. A click on a row
  targets it and shows it alone (a colour channel, or an alpha or spot
  channel with the colour hidden); Shift-click adds; the eyes only show
  and hide. Selecting a layer targets the colour channels again, so a
  layer is never left unpaintable by a channel picked long ago.
- **The display.** Colour channels hidden are a mask in the display pass,
  as the Separations panel's inks already are (one colour channel alone is
  shown in gray, as Photoshop shows it); with none shown, the canvas is
  paper. Alpha and spot channels shown are drawn by the screen pass from
  their coverage at the level shown, rendered into the selection's atlas
  as the selection's is: an alpha as its tint (or, with the colour hidden,
  as gray), a spot as its ink over the image (multiplied, then towards the
  ink by its solidity). At most four at once.
- **Painting a channel** is painting a gray target, as Quick Mask paints
  the selection: brushes, the Eraser (paints the background), Fill,
  Delete, the Gradient tool and the Paint Bucket. On a spot channel black
  is ink, as in Photoshop. Strokes on a channel go to the engine as a node
  of their own (`#channel:<id>`), drawn live wherever the channel shows.
- **Painting some colour channels**: the stroke kernel keeps the planes
  not targeted (and alpha) as they were, on the GPU and in the CPU
  reference, live and baked; fills, Delete and filters applied for good
  go through one engine call that keeps the untargeted planes of the
  tiles they changed. The Eraser paints the background, as in Photoshop.
- **Thumbnails** from the engine: the composite and each colour channel
  from the composite at a small level, alpha and spot channels from their
  coverage.
- **Loading a channel as the selection** (Ctrl-click a row): an alpha or
  spot channel as now; a colour channel by its brightness (CMYK by its
  ink), and the composite by its luminosity (Ctrl+Alt+2).
- **PSD**: alpha and spot channels read from the composite's extra
  channels (names from resources 1045 and 1006, display from 1077 or 1007;
  the merged transparency told apart), even when the file has layers (the
  extra channels only are decoded); written the same way.
- **PDF**: each spot channel an image in its Separation colour space,
  drawn over the page with overprint, so it makes its own plate. A spot
  swatch of the same name shares the colour space.
- **The Separations panel** lists spot channels too, shown or hidden there
  and read under the pointer.

The work (done 13 October 2026):
- [x] Model, serialisation, the channel view and target store, commands
  (New Channel, New Spot Channel, Channel Options, Duplicate and Delete
  Channel in Document → Channels; Load Luminosity; Ctrl+2 to Ctrl+9).
- [x] The Channels panel: composite, colour, alpha and spot rows, eyes,
  thumbnails, rename, reorder by dragging, Options and New Spot Channel
  dialogs.
- [x] The display: colour channels in the display pass; alpha and spot
  channels in the screen pass.
- [x] Painting and filling an alpha or spot channel; the Magic Wand and the
  Paint Bucket reading one (`readCover8`).
- [x] Painting and filling some colour channels; filters and adjustments
  applied for good to them (a live filter is applied for good there).
- [x] Loading colour channels and the composite as the selection.
- [x] PSD in and out; PDF out; the Separations panel.
- [x] Checks: new `check:channels` (browser, with a PSD round trip);
  `check:doc` (spot channels and options, damaged ones),
  `check:interchange` (Photoshop's spot fixture, names and display info
  round trips, a flat read decoding only the extra channels, spot channels
  in PDF), `check:gpu` (a stroke on some colour channels against the CPU
  reference), `check:fills` (the panel's new rows). ARCHITECTURE.md
  (Channels), MANUAL.md chapter 20, CHANGELOG, the gap map.

Decided on the way:
- With a channel targeted and nothing selected, Delete clears the channel
  (to the background colour) rather than deleting the selected layer; and
  clicking a layer in the Layers panel, even the one already selected,
  targets the colour channels again.
- New Spot Channel shows the colour as well, so the ink shows over the
  picture; New Channel shows the new alpha alone, ready to paint.
- A channel targeted that disappears (deleted, or its making undone) gives
  back the colour channels, shown, rather than a canvas of paper.
- PSD's channel names leave out the merged transparency; a file whose
  names count it is read too.

Left, with reasons:
- Filters and adjustments on an alpha or spot channel (blurring an alpha
  is common): the render graph filters layers; a channel would need to go
  through it as a gray layer of its own. Asked for with Calculations and
  Apply Image, which need the same.
- Split Channels, Merge Channels, Merge Spot Channel: rare, and each is a
  document conversion of its own.
- Smudge, the Mixer, the Clone Stamp and the healing tools on an alpha or
  spot channel: they sample a layer; refused with a reason.
- More than four alpha and spot channels on the canvas at once: the screen
  pass's uniform holds four.
- Spot channels at a tint in vector paints, and spot swatches shown as
  their own plates in Separations: shapes still show spot swatches through
  their process colour on screen (PDF already prints them on their plates).
- check:paint's CMYK 16-bit stroke failed twice in one full run (once
  retried alone against the same server) and passed in six runs since,
  alone and under load: watched, not yet explained. check:warp's first
  step (a red square) timed out once under load on 13 October, passing alone.

## The quality and performance pass (done)

Asked for on 12 October 2026, from a read-only review of the whole code
(rendering, tiles and the engine, the interface, the document and commands,
tooling). The code's hygiene is good (strict, almost no `any`, no runtime
cycles between `app/` and `ui/`); this is structure and hot paths. Each
item ticks off here when done, with its before and after in PERFORMANCE.md
where it's measured. Worked in this order:

**1. The panning regression and other first fixes** (done 12 October 2026)
- [x] App subscribes to the whole engine state (`App.tsx:230`) and every
  `frame` message makes a new one (`EngineHost.ts:430`), so the whole app,
  the 200-row Layers panel with it, re-renders each engine frame: the
  likely cause of the three pan budgets missed since guides (the engine
  only draws when the page sends a view, so a slow page halves the rate).
  Split per-frame figures into a store only the status bar reads; then
  re-run the bench. *All three pans back at 33.3 ms.*
- [x] Tile collection only waits for selection work (`worker.ts:342`);
  conversion, PSD write, retouching and decoding make unheld tiles across
  `await`s (`tiles/convert.ts`). One store-wide work-in-progress guard.
  *Every call but tiles.gc is guarded (engine/work.ts).*
- [x] PSD open decodes the merged composite it doesn't use when there are
  layers (`psdHost.ts:83`, no `{composite: false}`).
- [x] The reopened PSD drawn fitted (3.4 s against 3). *Profiled first:
  the CMYK tables built again for an embedded copy of Generic CMYK (now
  recognised as the built-in), uploads interleaved on the CPU (now packed
  on the GPU), a matrix through arrays in outlines' segments. 2.83 s.*

**2. The interface's renders** (done 12 October 2026, but for the two noted)
- [x] A small `createStore` with selectors for the 33 hand-made listener
  stores, so subscriptions can be narrow. *`Listeners` (lib/listeners.ts)
  in all 33; narrow reads go with the options bar's split (7).*
- [x] The command context is rebuilt on every commit (a 420-line
  `useMemo`), with every shortcut parsed again and the key listeners
  re-attached: read the stores lazily, keep the key handler in a ref.
  *The key listeners are added once and parse keys only after a change; the
  context itself is still rebuilt (split with App.tsx in 7).*
- [x] Panels: content made as new JSX each App render, no `memo` anywhere;
  the Layers panel's actions into a module, panels subscribing for
  themselves, a memoised layer row; `useThumbs` memoised on the document
  (it's O(n²) and stringifies the profile every render). *Panels
  memoised with stable actions; `useThumbs` once per document state. The
  big cost was elsewhere: each thumbnail a GPU canvas, a composited layer
  each (PERFORMANCE.md, log). A tool chosen with 200 layers: 16.7 ms to
  4.9.*
- [ ] A memoised layer row, so selecting a layer draws two rows, not two
  hundred (8.9 ms with 200 layers now).
- [x] Pointer moves: the canvas's rect read once (a ResizeObserver), not
  several `getBoundingClientRect`s per event and per pen sample. *Read
  once a frame; the document point once a move.*
- [ ] Coalesced points to the lasso and the Pen's gestures.
- [x] Overlay sends coalesced to one per frame. *One per microtask.*
- [x] Found on the way: the session readout (the Polygonal Lasso's corners,
  Free Transform's size) was kept current by App's re-renders every frame;
  it now follows the tool overlay.

**3. The engine's CPU work** (done 12 October 2026, but for the helper pool)
- [x] Expand/Contract: van Herk/Gil-Werman, constant per pixel (it's
  O(radius)). *The same results; an edge tile at 50 px 150 to 210 ms
  before, 13 ms now; at 256 px 3.6 s, 60 ms.*
- [x] Combine and invert: pass tiles through when the other side is all 0
  or all 1, rather than re-encoding them into new slots.
- [x] Feather: skip tiles whose neighbours are all one value; a blur loop
  without per-read closures and clamps; off-canvas zeroing only on edge
  tiles; `CoverReader` keeping three tile rows, not every tile. *1.32 s to
  0.73.*
- [x] The ellipse and polygons: an active edge list (each sub-row now tests
  every edge, up to 4,096). *Edges by band of rows: 750 ms to about 220.*
- [x] PSD write: profiled (`BENCH_PROFILE` now covers the write): of 34 s,
  converting the rasterized shapes' read-back tiles to samples 6.4 s,
  `packBits` 5.9 s, the composite's quantising 3.2 s, layers' rows (CMYK
  inverted) 2.8 s, rendering about 3 s. `packBits` into a buffer and
  `DataView`-free 16-bit samples measured no faster, and were left as
  they were. *What's left is per-pixel work: the GPU quantising before
  readback, or the helper pool below; within its budget (60 s) meanwhile.*
- [x] PSD read: plain row copies when the depth doesn't change. *With the
  composite left undecoded: 20.3 s to 14.3.*
- [x] CMYK conversion: the output's gamma applied in place (it made a copy
  each time). *A table for it is left out: the curve is too steep near
  nought to interpolate within a 16-bit step.*
- [x] Autosave: an in-memory index of each set's tiles (every change reads
  every set's manifest from storage).
- [x] PSD open: the file's bytes handed to the worker, not copied
  (`EngineHost.call` takes buffers to give).
- [ ] ~~Results transferred whatever their typed array~~: left as it is. A
  handler returning an array it keeps (a cache) would have it detached;
  nothing measured costs.
- [ ] The helper worker pool ARCHITECTURE.md describes, for conversion, PSD
  open and save and feathering, so the canvas keeps drawing meanwhile;
  `packBits` and the read-back conversion in parallel there.

**4. Rendering** (done 13 October 2026: what measured; the rest left, below)

Decided (13 October 2026): only what a measurement shows. Every frame
budget is met with under a millisecond of CPU a frame panning, so the
items that would save microseconds a frame are left, with their reasons.
- [x] What the reopened PSD's draw spent, profiled: vectors 1 s (outlining
  0.35 s, mostly flattening the text's glyphs; each tile's segments
  0.6 s), the Layers panel's thumbnails 0.2 s in the middle of it, the
  rings' small writes 0.23 s. *Each glyph is flattened once for each size
  and angle it's set at, then moved (49,000 placements of 41 glyphs were
  49,000 flattenings); thumbnails wait for the canvas and come a few at a
  time (`EngineHost.whenDrawn`); rings hold small writes and send them in
  one before each submit. 2.83 s to 2.29–2.40; the dense text fitted 1.45 s
  to 0.83–0.99.*
- [x] Ring writes staged and flushed once before submit (one
  `writeBuffer` per put now). *Writes up to 4 KB, in the parameter and
  window rings; uploads aren't (each is a tile).*
- [x] The 96 MP first picture (about 750 ms): timed. *The thumbnails of its
  two layers were made in the middle of it; now after. 652–677 ms; what's
  left is the uploads themselves (the GPU path, and the CPU fallback for
  work outside frames).*
- [ ] Outlines at coarse levels: reuse a finer level's geometry. Left: with
  glyphs flattened once each, outlining is a small part of the draw, and
  drawing coarse first means the finer outline isn't there yet to reuse.
- [ ] Fewer passes per stroked shape (one compute pass per tile's
  dispatches, dispatch over the shape's box, raster, paint and over fused).
  Left: the GPU keeps up with the display panning over two hundred shapes.
- [ ] Readback staging buffers pooled; texture views and the screen's bind
  group cached; `lutBuffers` not stringifying the look each frame; scratch
  arrays reused per tile; caches indexed by scene and node for `forget`.
  Left: microseconds a frame.
- [ ] Wait-then-next-frame in the worker (`worker.ts:304`). Left: no frame
  measured late for it.

**5. Text** (done 13 October 2026)
- [x] Layout cached per paragraph (untouched paragraphs keep their
  identity): one keystroke in 60,000 characters lays out everything again
  now, about 145 ms. *Shaping, segments, line ends and each line's glyphs
  kept by paragraph (text/layout.ts, paraCache), for the same fonts and
  styles: 120 justified paragraphs laid out again after an edit in about
  10 ms, against about 70 laying them out afresh (`check:text` holds it to
  the same result, and to less than three quarters). The 145 first
  reported was a first layout, before the JIT had warmed; and the cache did
  nothing for frames until the fix below.*
- [x] Found on the way, from profiling the edit: a rectangular frame was
  never taken for one (`isRect` wanted four points; a closed path comes
  back to its first, so five), so since phase 9 area text never used the
  every-line composer (Knuth–Plass) whatever it was set to, and was broken
  line by line as a shaped frame. `check:text`'s comparison of the two
  composers allowed them to be equal, and they were; it now wants
  every-line less ragged. Text in existing documents may break
  differently: as it was meant to.
- [x] Shaping: the font resolved once per run, not a sorted key per
  character; the mark test only above U+0300. *Fresh layout of the bench's
  60,000 characters 140 ms to 102.* Found on the way: characters set in a
  fallback font each made an item of their own (a new face entry each),
  so a run of them was shaped a character at a time, without kerning or
  ligatures between them; one entry per fallback face now.
- [ ] A new font lays out only the text that wanted it. Left: the page's
  work while fonts arrive measured about 1% of the reopening.
- [x] Caret positions from cached prefix lengths, not joining every run.
  *Paragraphs' lengths kept by paragraph.*

**6. Loading** (done 13 October 2026)
- [x] The test handle (`main.tsx:45`) made lazy, so importers and
  exporters leave the 998 KB main chunk; then PSD, SVG, PDF, the brush and
  swatch importers and the dialogs loaded on demand. *Measured by module
  first (a build reporting each chunk's modules): PSD, SVG, PDF and ABR
  (exports, svg, psd, abr chunks), the text layout with its line breaking
  and bidi tables (with the fonts, which were already on demand), and 29
  dialogs in twelve files (docDialogs stays: the start screen uses it).
  The main chunk 998 KB (332 gzipped) to 813 (266). The swatch file
  reader stays, 4 KB and needed synchronously. The dialogs are fetched once
  the page is idle (ui/lazyDialogs.ts), so even the first opens at once;
  the checks wait for them with the engine (harness.mjs, waitForEngine),
  and those that open a dialog then read it wait for it (`dialogShown`),
  since a lazy component shows a moment after it's asked for even when
  loaded.*
- [x] Wasm compiled as it streams. *The Emscripten loaders already stream
  when given the URL rather than the bytes.* pxcms once for page and worker
  is left: it needs a hand-over in the protocol for tens of milliseconds at
  start. HarfBuzz was already loaded only when type is first needed.
- [x] `/fonts/*` cached long (or hashed through `?url`). *A week, then
  revalidated in the background (`public/_headers`); they keep their
  names, which the font library knows them by.*

**7. Correctness and structure** (done 13 October 2026, but for the splits noted)
- [x] Errors keep their name across the worker (the quota check in autosave
  can't match one from the worker); pending calls rejected when the
  worker dies. *And a reply that won't clone is the call's failure.*
- [x] The protocol's calls typed end to end (method tied to args); transfer
  chosen explicitly, not by a top-level `bytes`. *The wire message ties each
  method to its arguments (CallMessage); the copy-by-name went: a message
  is copied anyway, so only `give` (transfer) is a choice.*
- [x] One hold-for-commit helper for the five copies of the 60 s timer.
  *`held` in tileHost: seven copies in five files.*
- [x] `JSON.stringify` equality in `doc/` replaced by one deep equal (key
  order made no-ops into history steps; slow with Liquify fields).
  *lib/equal.ts; five uses (the rest were copies and serialising).*
- [x] The history cap counts what isn't tiles too (Liquify fields, about
  0.5 MB a step, weren't counted). *Each step's long strings (stepBytes);
  the cap's failures are said now, not swallowed.*
- [x] One `geom/affine.ts` (four composes, three inverses that disagreed on
  singular matrices); one `clamp`. *A singular affine inverts to the
  identity everywhere (one place made values of 10¹²); lib/num.ts for
  clamp and clamp01, ten copies.*
- [x] Typed parameters for filters, effects and adjustments. *defineFilter,
  defineFx and defineAdjustment infer each one's values from its
  parameters (ParamValues; data parameters from their readers): 141 casts
  to 10, the rest in helpers shared between them.* A `CommandId` type was
  tried and left: two dozen generated families of commands type their ids
  as strings, which makes the union a string, and check:commands already
  fails on a menu naming a missing command. Categories are a union now.
- [x] `render/graph.ts`'s one `encode` helper, which also counts the
  dispatches it missed (the mask display's, and the renderer's two); three
  of `render/readback.ts`'s band loops as one (renderBand; the other two
  render differently). The split by concern is left: one class of seventy
  methods sharing its state, split for navigation alone.
- [x] `commands/index.ts` split: context, predicates, registry, menus and
  shortcuts, index.ts re-exporting. The context in slices is left.
- [ ] `App.tsx` split: the command context, key dispatch. Left (the dialogs
  are a table already, ui/lazyDialogs.ts): the context closes over some
  twenty-five pieces of App's state; better done as reading the stores when
  it runs, a change of its own, measured.
- [x] One way to dispatch tools (a switch, a registry and a hard-coded list
  in `Viewport.tsx`). *One registry; isGestureTool from it; Patch registers
  itself, as the vector and type tools do.*
- [x] `render/probe.ts` (GPU test code) out of `src/render`: src/checks/.
- [x] Found on the way, by check:static: four runtime import cycles (three
  through app/canvasTools, one the commands split made); none now.

**8. Checks and tooling** (done 13 October 2026)
- [x] Suites in parallel, output kept per suite, `--only` and
  `--retry-failed`. *Headless ones a core each, browser ones four at once,
  longest first by their last times: all 43 in 410 s, from about 900.
  `--retry-failed` has already told a flaky run (check:segment, with the
  machine busy) from a failure: its one tight timing (150 ms) is doubled
  when suites run side by side, and strict alone.*
- [x] Browser suites against a built preview, so editing during a run
  can't break it. *The default now; `--dev` for the dev server.*
- [x] typescript-eslint (floating promises), the React hooks rules,
  dependency-cruiser, knip; as `check:static` at the front of `check:fast`.
  *Lint found ten async functions where plain ones were expected (four
  fixed; JSX handlers allowed); dependency-cruiser the cycles above; knip
  240 exports nothing else used: 203 are used in their own module and are
  no longer exported; 37 are used nowhere and are kept, exported, for
  review (`npx knip` lists them; some look like groundwork, moveChannel and
  moveSwatch among them). knip fails on unused files and packages, not on
  exports.*
- [x] The browser suites' shared helpers in one module (`press` was
  defined in 21 of them). *pageHelpers: press (21 suites) and idle (17);
  nine keep an idle of their own that waits a frame more. The other
  helpers differ suite to suite.* Fewer fixed `settle` waits: left, 63 of
  them, each needing what it waits for worked out.
- [x] Tidying: `check:manual` named in ARCHITECTURE.md but missing (marked
  not built, with the plugin it pairs with); `scripts/shot-split.tmp.mjs`
  (deleted); `.gitignore` (both spellings).

## After the pass: six gaps from the gap map

Asked for on 12 October 2026, in this order, each a phase of its own.

1. **Channels**: painting and filling an alpha channel; the colour
   channels in the Channels panel; thumbnails; spot channels in pixel
   layers; alpha channels in PSD.
2. **The Pen's editing**: the Curvature tool; a smooth-curve display like
   Affinity's; joining and splitting paths; selecting points across
   several shapes.
3. **Stroke features**: variable width profiles, arrowheads, dashes
   aligned to corners, a switch to scale strokes.
4. **The Width tool**: editing width profiles on the canvas (needs 3).
5. **Vector brushes**: art brushes bending artwork along a path (from the
   envelope distortion code), scatter and pattern brushes.
6. **Image Trace** (done 13 October 2026): pixel layers traced into vector
   shapes, with presets.

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
- Samples on the start page, and your own presets as cards (see *The start
  page*). (Next for the start page)
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
- Bristle, erodible and airbrush tips from ABR files keep their shape;
  their other settings are found by key name (Adobe hasn't published the
  keys) and otherwise defaulted, said. Checked against made-up files, not
  ones Photoshop wrote. (Later, with a file from Photoshop)
- Bristle tips are footprints at twelve depths, not simulated hairs that
  bend and trail; no 3D brush preview. (Later, if it matters)
- Tool presets saved out as `.tpl`; TPL's sampled tips are read as ABR's
  are but haven't been checked against a real file; the Crop tool's sizes,
  the Pen's style, custom shapes and styles in TPL files aren't kept.
  (Later)
- The Mixer Brush's paint model is fitted by eye to Photoshop's described
  behaviour, not measured against its strokes; Sample All Layers reads
  the image as it was when the frame began. (Later, if it matters)
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
- ~~Alpha channels: painting and filling one as a target, thumbnails in the
  Channels panel, and the colour channels listed there.~~ Done with Channels (13 October 2026).
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
- Pattern editing mode: a brick or hex layout wraps the tab only along
  the axis it repeats exactly, so artwork past the tile's edge the other
  way is cut off there; a hex tile isn't clipped to a hexagon. Patterns
  from artwork go to SVG, PDF and PSD as their repeat's pixels. Photoshop's
  Pattern Overlay doesn't come in with its pattern yet (the `Patt` block,
  below). (Later)
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
- Gradients: curved mesh lines, freeform Lines mode, stop midpoints, mesh
  and freeform gradients as PDF/EPS shadings (see "Gradients on the
  canvas", above). (Later)
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
- Threaded frames (text flowing from one frame to the next), text wrap
  round other layers, vertical text, and Photoshop's warped text. (Later)
- Drop caps, bullets and numbering, optical kerning; a tab ruler on the
  canvas; per-character gradients chosen in the Character panel (the model
  takes any paint; the panel sets colours). (Later)
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
  colours, the proofing store, `convert`, `files.openFile`, the
  `exports` (PSD, SVG, PDF), `toolPresets` and `patternEdit.of`) for the
  browser checks and the bench. The
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
