# Plexel

A professional raster and vector image editor that runs in a desktop
browser, drawing everything on the GPU through WebGPU. It runs at
**https://plexel.dblpl.us**.

The design (the document model, colour, tiles, the render graph, files and
the build order) is in [ARCHITECTURE.md](ARCHITECTURE.md). What the app does
for the person using it is in [MANUAL.md](MANUAL.md), what changed, and
when, is in [CHANGELOG.md](CHANGELOG.md), and where the build stands and
what's next is in [ROADMAP.md](ROADMAP.md).

## Run it

Needs Node 20 or newer, and a browser with WebGPU. The browser checks also
need Chrome.

```
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check, then a production build in dist/
npm run deploy       # check:fast, build, then publish dist/ to Cloudflare Pages
npm run build:cms    # rebuild the colour engine's WebAssembly (needs Docker)
npm run build:hb     # rebuild HarfBuzz's WebAssembly (needs Docker)
npm run bench        # frame times, uploads and first frames on this GPU (PERFORMANCE.md)
npm run check        # every suite, several at once, the browser ones against a production build
npm run check:fast   # the headless ones, check:static first (types, lint, dependency rules, unused files)
```

`npm run check` takes options after `--`: `--only static,text` for some
suites, `--retry-failed` to run a failure again alone (one that passes then
is reported as flaky), `--dev` to run the browser suites against the dev
server, `--jobs N` to change how many run at once.

The colour engine (LittleCMS, compiled to WebAssembly) is checked in under
`src/color/wasm`, so `build:cms` is only needed after a change to
`native/pxcms/pxcms.c` or a new LittleCMS release. It compiles inside the
pinned `emscripten/emsdk:3.1.74` image and refuses a LittleCMS download
whose SHA-256 doesn't match `native/pxcms/lcms.sha256`.

HarfBuzz, which shapes text, is built the same way: `build:hb` compiles
HarfBuzz 14.6.0 with `native/pxhb/pxhb.c` in the same image, refuses a
download that doesn't match `native/pxhb/harfbuzz.sha256`, and writes
`src/text/wasm`, which is checked in.

`deploy` runs the headless checks first and stops if any fail, so a broken
change can't reach the live site by accident. It publishes with `wrangler`,
which has to be logged in to the account that owns the `plexel` Pages
project. The `plexel.dblpl.us` custom domain is attached to that project in the
Cloudflare dashboard.

## What's there

Phases 1 to 14 of the build order: the shell, the engine, documents,
colour and pixels, the render graph, painting, selections, masks and
transforms, adjustments, live filters, layer styles and smart objects,
vectors, type, print colour, interchange, Photoshop's brush engine, the
clipboard, and fills, gradients and the rest of the selection tools; then,
from the gap map, docking and floating panels, and rulers, guides, grids,
snapping with smart guides, and aligning and distributing layers; then,
from a brainstorm on the gap map, tiled documents, retouching, live warps
(Distort, Perspective, Warp, Liquify), thirty live filters and the colour
adjustments (Selective Colour, Photo Filter, Colour Lookup, Colour
Grading), effects on each fill and stroke with graphic styles, and vector
construction (Pathfinder, the Shape Builder, Live Paint, Outline Stroke,
Offset Path, Simplify).
Every layer is drawn on the canvas, composited and colour managed, at any
zoom and angle, on documents of any size; pixel layers can be painted with a
pressure-sensitive pen; part of an image can be selected, masked, moved and
transformed; how layers look can be changed and changed back; shapes and
paths sit beside pixels, sharp at any zoom; text is set properly in any
script and painted like a shape; a document can be taken to press:
converted, proofed, checked ink by ink, its spot colours kept; work
moves to and from Photoshop, SVG and PDF without being flattened; and
things line up: to guides, the grid, the canvas and each other.

- **Photoshop documents in and out** (PSD and PSB): layers, groups, blend
  modes, clipping, pixel and vector masks, shape and fill layers as live
  shapes, type layers as live text, adjustment layers, layer styles and
  embedded smart objects, in RGB, Gray and CMYK at 8 and 16 bits with the
  profile; a composite written for other apps. Our own reader and writer.
- **SVG in and out**: shapes, groups, transforms, fills, strokes and
  gradients, clip paths, blend modes, embedded images and text; exported
  with text live or as outlines, and pictures only where SVG can't hold
  what's drawn.
- **PDF out** for print: vectors, text as outlines, the document's profile,
  PDF/X-4 output intent for CMYK, spot swatches as their own plates.
- **CMYK JPEGs** open, through our own decoder.
- **Adjustments as Photoshop draws them**, held to the composites
  Photoshop saved in its own files.

- **Converting**: Document → Mode (RGB, CMYK, Grayscale, 8 or 16 bits) and
  Convert to Profile, with the rendering intent and black point
  compensation: every pixel and every colour the document keeps elsewhere
  (shapes, text, adjustments, effects, smart objects), as one step.
  Working spaces in Colour Settings.
- **Proofing**: Proof Setup (any profile, intent, paper white and black
  ink simulated), Proof Colours (Ctrl+Y) and the Gamut Warning
  (Ctrl+Shift+Y) on the canvas, drawn through the display table at no
  extra cost a frame.
- **Separations**: each CMYK ink on and off, the inks and their total
  under the pointer, a total ink limit marked on the canvas.
- **Document swatches**: process, global and spot colours saved in the
  document; fills and strokes linked to them at a tint follow them, through
  conversions too. Adobe Swatch Exchange (.ase) libraries in and out.
- **CMYK colour adjustments** through the document's profile, black ink
  kept.

- **The Type tool** (T): click for point text, drag a box for area text,
  click a closed shape's outline for area text inside it, Alt-click (or
  click an open path) for text along it, starting where it's clicked.
  Click text to edit it: a caret, selections by Shift, the mouse, double-
  and triple-click, words with Ctrl; IME composition; cut, copy and paste;
  Undo inside the text. New text layers are named after what's typed.
- **Shaping by HarfBuzz**, compiled to WebAssembly: kerning, ligatures and
  OpenType features, variable fonts' axes, Arabic joining, Devanagari
  clusters, and mixed left-to-right and right-to-left text (UAX #9), with
  lines broken where Unicode allows (UAX #14).
- **Composers**: every-line (Knuth–Plass, weighing the whole paragraph) or
  single-line; left, centre, right, justified and justify-all; indents and
  space around paragraphs. Area text flows into any shape's frame and says
  when it overflows.
- **The Character and Paragraph panels**: font and style, size, leading,
  tracking, kerning, baseline shift, width and height, underline and
  strikethrough, variable axes as sliders, OpenType features, language;
  alignment, indents, spacing, direction, composer. Named **character and
  paragraph styles**, based on one another, made from the selection,
  applied, redefined, renamed and deleted.
- **Fonts**: Inter Variable built in, with Noto Sans Arabic and Devanagari
  as fallbacks; fonts added from files (kept in the browser), the
  computer's own fonts through Local Font Access, and fonts carried inside
  `.pxll` files where their licence allows. A missing font is named, and
  its text shown in Inter until it's there.
- **Text is drawn as shapes**, so it takes the whole appearance stack:
  fills and strokes with gradients and patterns, masks, effects. **Create
  Outlines** turns it into a shape exactly; Rasterize, into pixels.

- **Shapes** (U): rectangles (with round, chamfered or set-in corners),
  ellipses, polygons, stars and lines, kept live: their size and corners,
  sides and points stay editable in Properties. Shift keeps them square,
  Alt draws them from the middle.
- **The Pen** (P) and **Direct Selection** (A): paths of corners and curves,
  closed by clicking the first point, carried on from an end; points added
  on a segment, deleted, converted between corner and smooth, moved with
  their handles, selected with a box and deleted. The engine draws the
  outline, points and handles over the canvas.
- **The appearance stack**: any number of fills and strokes, in order, each
  with its own paint (a colour, a linear, radial, angular or diamond
  gradient with an opacity for every stop, or a pattern), opacity and blend
  mode. Strokes have width, alignment (centre, inside, outside), miter,
  round or bevel corners with a miter limit, butt, round or square ends,
  and dashes.
- **Compound shapes**: Layer → Combine Shapes unites, subtracts, intersects
  or excludes a shape with the one below, live; each shape's operation can
  be changed after. Expand makes one path, curves kept as curves; Release
  puts the shapes back.
- **Vector masks** beside pixel masks: Reveal All or Hide All, then outlines
  drawn into them with the Pen and the Shape tool, with feather, density
  and invert.
- **Pattern Overlay** joins the layer styles. Free Transform and Rasterize
  work on shapes.

- **Adjustment layers**: Levels, Curves, Brightness/Contrast, Exposure,
  Invert, Posterize, Threshold, Hue/Saturation, Vibrance, Colour Balance,
  Black & White, Channel Mixer and Gradient Map, through their blend mode,
  opacity and mask, clipped or not, or on one layer as an effect. Their
  controls in Properties are generated from each one's parameters, with
  Curves and Levels (and its histogram) editors.
- **Live filters**: Gaussian Blur, Box Blur, Unsharp Mask, High Pass, Add
  Noise, Median and Motion Blur, in a layer's effects and editable later,
  or applied for good through a selection; previewed as they're set.
- **Layer styles**: Drop Shadow, Outer Glow, Inner Shadow, Inner Glow,
  Satin, Colour and Gradient Overlay, Bevel & Emboss and Stroke, in
  Photoshop's order, with Fill fading content but not effects.
- **Smart objects**: Convert to Smart Object, drawn from their contents at
  the resolution the view needs, so scaling loses nothing; Edit Contents in
  a tab of its own, saved back as one step.

- **Selections.** The Marquee (M), Lasso and Polygonal Lasso (L) and Magic
  Wand (W), adding with Shift, subtracting with Alt and intersecting with
  both; Select All, Deselect, Reselect, Inverse, Feather, Expand, Contract,
  and Select and Mask's Smooth, Feather, Contrast and Shift Edge. A
  selection is soft-edged coverage, a step in the history, and saved in the
  file. Marching ants are drawn by the engine.
- **More ways to select**: **Quick Selection** (W), a brush that grows the
  selection out to an object's edges (a graph cut over the image), with
  Auto-Enhance; the **Magnetic Lasso** (L, Magnetic mode), whose outline
  clings to edges as it's traced (Width, Contrast, Frequency); **Colour
  Range** (sampled colours with fuzziness, or reds to magentas,
  highlights, midtones, shadows, skin tones), its eyedropper on the canvas;
  **Grow** and **Similar**; **Border** and **Smooth**; **Transform
  Selection**, the outline itself scaled, skewed and turned.
- **Select and Mask** also re-estimates the edge from the image: a radius
  (or Smart Radius) round it, and a Refine Edge brush for hair and fur;
  the result goes out as the selection, a layer mask or a new layer.
- **Alpha channels**: Save Selection and Load Selection (new, add,
  subtract, intersect, inverted) and the Channels panel; channels are saved
  in the file and move with Crop and Canvas Size.
- **Through the selection**: painting, erasing, filling and Delete stay
  inside it, fading out through a feathered edge.
- **Quick Mask** (Q): the selection as a red tint, painted with the brushes.
- **Layer masks** on any layer or group, from nothing or the selection,
  painted, filled and cleared like pixels, with density, a live feather,
  invert, on and off, Apply and Delete; thumbnails in the Layers panel.
- **Clipping** as a command (Ctrl+Alt+G), as well as by dragging.
- **The Move tool** (V), nudging with the arrow keys, and **Free
  Transform** (Ctrl+Alt+T): scale, stretch, skew, move and turn with
  handles the engine draws, flips and quarter turns. Transforms are live
  until **Rasterize** bakes them in. Lock Position is enforced.
- **Crop** (C), with straighten, keeping what's cropped away as Canvas Size
  does; Crop to Selection.

- **Painting.** The Brush (B) and Eraser (E), with Photoshop's flow and
  opacity: low flow builds up, and opacity is a ceiling a stroke never
  passes. Size, hardness, roundness, angle, spacing, smoothing, a blend
  mode, and dynamics that map pen pressure, tilt, twist, speed, distance or
  a seeded random number onto size, opacity, flow, hardness, angle, scatter
  or colour. Shift-click for straight lines, Esc to abandon a stroke. Each
  stroke is one undo step, sharing every tile it didn't touch.
- **Pen input**: pressure, tilt, twist and an airbrush pen's wheel from
  every coalesced sample, sent to the engine through shared memory, with a
  pressure response in Edit → Pen Settings.
- **Brushes**: sixteen presets (round, soft, inking, airbrush, pencil,
  calligraphy, chalk, spatter, dry bristle, round, flat and fan bristle,
  sketch pencil, pastel chisel, soft airbrush, spray paint), each previewed
  with a stroke in the Brushes panel, and presets of your own.
- **Photoshop's brush engine**: the **Brush Settings** panel (F5) with every
  section (Brush Tip Shape, Shape Dynamics, Scattering, Texture, Dual Brush,
  Colour Dynamics, Transfer, Brush Pose, Noise, Wet Edges, Build-up,
  pulled-string Smoothing, Protect Texture), each control (Fade, pressure,
  tilt, rotation, the stylus wheel, direction, initial direction and
  rotation, speed) through a curve. Tips of any size and shape, mipmapped
  so they stay clean when small; **bristle tips** whose hairs splay with
  pressure and tilt, **erodible tips** that wear as they draw, and
  **airbrush tips** that lean with the pen; **Define Brush Preset** from
  the image; Photoshop's **ABR files** imported (versions 1, 2 and 6 to 10),
  tips, patterns and settings, and brushes **exported** as ABR.
- **Tool presets** (Window → Tool Presets): any tool with its options
  under a name; Photoshop's `.tpl` files imported.
- **The Mixer Brush** (B, Shift+B from the Brush), whose paint picks up and
  mixes with the canvas's (Wet, Load, Mix, Flow, Photoshop's combinations,
  Load and Clean, Sample All Layers), and **Smudge** (Strength, Finger
  Painting, Sample All Layers).
- **The Colour Picker** (I, or Alt with a brush), a point or a 3 × 3 or 5 × 5
  average of the composite.
- **Swatches**, which keep the colour space they were picked in.
- **The options bar** across the window under the menu bar, generated from each tool's settings;
  [ and ] change the brush size, Shift+[ and ] its hardness, the number
  keys its opacity (Shift for flow), and the worker draws the brush's
  outline, the tip's own shape, as the cursor.
- **History** has a memory cap beside its hundred steps: past 1 GB of tiles
  that only older steps hold, the oldest are forgotten.
- **Cut, Copy and Paste** (Ctrl+X, C, V): pixels under a selection (a moved
  or turned layer copies exactly), whole layers live with no selection
  (shapes stay shapes, text stays text), paths with Direct Selection;
  **Copy Merged**, **Paste in Place**, **Paste Into** and **Outside**;
  between documents in any mode and depth, converted on the way. Other
  apps get a PNG (and a text layer's words, a path's SVG); their images,
  SVG markup and text paste in as layers. **Duplicate Layer**, **Layer via
  Copy** (Ctrl+J) and **Cut**, **Copy** and **Paste Layer Style**, **New
  from Clipboard**.

- **The canvas.** Layers composite on the GPU with Photoshop's rules: all
  27 blend modes, opacity and fill opacity, pass-through and isolated
  groups, shallow and deep knockout, and clipping by nesting. Pixel layers
  are drawn through their live transform with nearest, bilinear, bicubic or
  Lanczos resampling, from a mip pyramid when zoomed out. The result goes
  through the display's colour table, with the canvas in Display P3 when
  the display is.
- **The view.** Pan, zoom and rotate: the Hand (H), Zoom (Z) and Rotate View
  (R) tools, Space to pan with any tool, the middle button, the wheel, and
  Ctrl+wheel or a pinch to zoom about the pointer. Ctrl+0 fits, Ctrl+1 is
  100%, Ctrl+= and Ctrl+− step. Each document keeps its own view.
- **Images in and out.** PNG, JPEG and TIFF open as documents in their own
  mode, depth and profile (our own PNG and TIFF decoders, so 16-bit and
  CMYK come through), or come in as layers, converted into the document.
  Drop one on the canvas to place it where it lands. File → Export writes
  PNG (8 or 16-bit, with transparency) or JPEG, with the profile embedded,
  and (since phase 11) PSD, PSB, SVG and PDF.
- **Thumbnails** in the Layers panel are rendered by the engine.
- **Layers drag and drop**, above, below or into another layer: into a
  group groups it, into any other layer clips it.
- **Big files.** A `.pxll` is written straight to its file, one layer at a
  time. One over 64 MB opens without reading its pixels: each tile is read
  from the file when it's first drawn. Saved files carry `thumbnail.png`
  and `preview.png` for other tools.
- **Properties** gains Fill, blend modes in Photoshop's groups, Resampling
  for pixel layers and Knockout for groups.

- **Colour management.** LittleCMS, compiled to WebAssembly, behind a small
  API of our own. Built-in profiles made from their published definitions:
  sRGB, Display P3, Adobe RGB and ProPhoto RGB compatibles, Rec. 2020, Gray
  Gamma 2.2 and 1.8, and a Generic CMYK ink model (not a press profile).
  Any ICC profile can be loaded and is embedded in the document.
- **The Colour panel.** Foreground and background, edited in RGB, HSB, Lab,
  CMYK or Gray, with tracks that preview each channel, hex entry, X to swap
  and D to reset. Each model works in the front document's own profile when
  it's in that mode. A colour outside the document's gamut says so, and one
  click moves it to the nearest colour the document has.
- **Pixel layers and fills.** New documents start with a white, black,
  background-colour or transparent Background. Layer → New Pixel Layer,
  and Edit → Fill with Foreground (Alt+Backspace) or Background
  (Ctrl+Backspace), converting the colour into the document's space with
  the chosen rendering intent. Every fill undoes.
- **Edit → Fill** (Shift+F5): the two colours, a colour of your own, a
  pattern, **content-aware** (PatchMatch, in a worker of its own), black,
  50% gray or white, in any blend mode at any opacity, with Preserve
  Transparency, through the selection.
- **Gradients and fill layers**: the **Gradient tool** (G) drags a
  linear, radial, angle, reflected or diamond gradient; by default it
  makes a **gradient fill layer** that stays editable (drag again to move
  its ends), or lays the gradient into pixels. **Layer → New Fill Layer**
  (solid colour, gradient, pattern) covers the canvas, shaped by its mask.
  The **Paint Bucket** (G) fills what's like the pixel clicked.
- **Patterns from pixels**: **Edit → Define Pattern** keeps what's visible
  under the selection as a pattern of the document's, for fills, fill
  layers, the Paint Bucket, Pattern Overlay and shapes' fills and strokes;
  the Patterns panel lists them. They convert with the document and travel
  with copied layers.
- **Patterns from artwork** (Layer → Pattern → Make Pattern) and **pattern
  editing mode**: the tile in a tab of its own with its copies round it,
  grid, brick and hex layouts with spacing, drawn seamlessly across the
  edges, every use following as it's drawn.
- **The tile store**, in the engine worker: 256-pixel tiles, planar, at 8
  or 16 bits in RGB, Gray or CMYK. Tile sets are copy-on-write, so undo
  costs only what changed; uniform tiles cost a few bytes; memory is held
  to a budget and the rest spills to disk; and what no open document's
  history uses is freed.
- **Pixels in files and the journal.** Each layer's tiles go into the .pxll
  as a pack (filtered and deflated per tile), with embedded profiles beside
  them. The autosave journal stores tiles by content hash, so autosaving
  after an edit writes only the tiles it made.
- **Colour Settings** (Ctrl+Shift+K): the display's profile (sRGB or
  Display P3; browsers don't reveal the monitor's), the rendering intent
  and black-point compensation. **Assign Profile** reinterprets a
  document's numbers in another profile, including one loaded from a file.
- **One tab owns the autosave.** A second Plexel tab works, but says it
  isn't autosaving instead of overwriting the first tab's journal.
- **Display tables** (`color/lut.ts`), built and measured, and sampled on
  the GPU exactly as on the CPU.
- **Documents.** File → New (Ctrl+Alt+N) with presets for screen, print and
  photo, sizes in pixels, inches, centimetres, millimetres or points, RGB,
  Gray or CMYK at 8 or 16 bits, and a colour profile. Several documents open
  at once, one tab each, with a dot for unsaved changes.
- **Files.** Documents save as `.pxll`, a zip any unzip tool can open. In
  Chromium, Save writes back to the file a document came from, and the start
  screen and File → Open Recent list recent files. Elsewhere Save downloads
  and Open uses a file input. Dropping a `.pxll` on the window opens it. A
  file that's damaged or from a newer version is refused with a reason, and
  one that's repaired on the way in says what was repaired.
- **Autosave.** Every open document is kept in the browser's private storage
  (OPFS) as it changes. Close the tab, crash or lose power, and the next
  visit reopens what was open, unsaved changes included, still saving to its
  own file. Closing a document with unsaved changes asks first.
- **Undo.** Every change goes through one edit path into a history of a
  hundred steps per document, each named for what it did ("Canvas Size",
  "Hide “Sky”"). Edit → Undo and Redo say which step they take, and the
  History panel goes straight to any step. A slider drag is one step.
- **The Layers panel** lists the tree top first: select, show and hide, fold
  groups, rename in place (double-click or F2), add groups, delete, and move
  up and down (Ctrl+] and Ctrl+[).
- **The Properties panel** shows the selected layer's opacity, blend mode
  (Photoshop's full set), visibility and lock, or the document's size, print
  size, resolution, mode and profile when no layer is selected.
- **Document → Canvas Size** (Ctrl+Alt+C) grows or shrinks the canvas around
  any of nine anchors. Layers keep their place against the anchor and
  nothing is cropped. **Resolution** changes how big the pixels print.
- **The shell** from phase 1: one command registry behind the menus, the
  shortcuts (yours to change, in Edit → Keyboard Shortcuts), the Ctrl+K
  palette and the shortcuts list; a dock of panels
  that fold, close and resize; three themes in dark and light, with a
  neutral pasteboard; and a page that explains itself without WebGPU.
- **Help as you work** (the UX pass): tool cards listing every key, disabled
  commands that say why, key hints in the status bar, a context menu on the
  canvas, Alt and a right-drag to size the brush, spring-loaded tool keys,
  task workspaces, Tab and
  Photoshop's screen modes, and Edit → Interface for size, density,
  contrast and motion. brainstorm.md has the ideas still to build.
- **Crash screen.** If the app fails to draw, the screen offers every open
  document from the autosave as a `.pxll` download before anything else.

## Checks

```
npm run check            # everything
npm run check:fast       # the headless ones (what deploy runs)
npm run check:browser-all
```

| Check | Kind | What it holds |
| --- | --- | --- |
| `check:doc` | headless | The document model: every node kind's defaults and loading, creating documents, every edit (including the refusals: a group into itself, pass-through on a pixel layer), Canvas Size around its anchors, moving and transforming (what a group, a layer and its masks carry, and what stays), Crop and straightening, selections, masks and clipping, history with coalescing and jumps, the names of steps, fragments (what the clipboard holds: layers lifted out with everything they hold, the swatches and styles they use, pasted back with new ids, compound shapes' operations following them, offsets, a parent that can't take them), and the loader against broken, hostile and future documents: cycles, nodes listed twice, missing references, orphans, unknown kinds, out-of-range values. |
| `check:io` | headless | The zip layer: CRC-32, round trips of every kind of entry with and without Zip64, our deflate inflated by Node's zlib, zips written by Python's `zipfile`, and damaged files refused by name. The `.pxll` format, and the autosave journal against a store in memory, including a crash between writes and damaged entries. |
| `check:color` | headless | The colour engine against published values (sRGB's primaries in Lab, Display P3 and Adobe RGB conversions, Sharma's CIEDE2000 test pairs), every built-in profile surviving a save as ICC bytes, the CMYK ink model inverting exactly and its profile matching it, resolving a document's profile with fallbacks, gamut warnings (black under black-point compensation included), the picker models, and every display table against the engine. |
| `check:tiles` | headless | Every format at 8 and 16 bits: tiles reading back exactly, uniform tiles, copy-on-write sets, collection, the memory budget with spilling and reading back, content hashes, packs (and that filtering beats plain deflate), damaged packs refused, and the journal writing only new tiles and restoring them. |
| `check:commands` | headless | The registry: unique ids, menus that name real commands, tidy separators, every shortcut parses, no two share a key, none the browser keeps for itself, the clipboard's keys left to the browser's clipboard events and no other command on them, the ellipsis rule, ticks that tell the truth, what's enabled without a document, a selection or a mask, and that only the arrow keys repeat. The icon registry: every tool has an icon, and the bundled outlines are exactly Phosphor's. Every command disabled with no document or no layer gives a reason. The context menu offers only what can run, for the selection, the layer's kind and a transform. Workspaces: their panels exist, each keeps how it was left, Reset, older saves. F through the screen modes; Tab a focus key. Spring-loaded tools: taps, holds, a quick use, a release mid-drag. Every tool lists its keys. The palette's search ranking. Defensive loading of the appearance, workspace and interface settings. |
| `check:adjust` | headless | The adjustment, filter and effect registries and their parameters read back (defaults, limits, wrong shapes); every adjustment against what it means (Invert, Posterize's equal bins, Threshold, Levels' points and gamma with each channel before the master, curves as natural splines through their points, Exposure in linear light, Brightness/Contrast keeping its ends and its legacy version, Hue, Saturation and Lightness as Photoshop orders them, Vibrance, Colour Balance keeping luminosity, Black & White's Photoshop weights, Channel Mixer, Gradient Map); the filter references (a blur keeps the total and spreads evenly, box means, Median, seeded noise, Motion Blur's taps, Unsharp Mask at an edge); and the effects' jump flooding against brute force, shadows' direction and strokes. |
| `check:select` | headless | Selections as coverage: rectangles exact to the pixel, ellipses to πab, even-odd lassos, clipping to the canvas, whole tiles costing no pixels; Select All, Inverse, and combining by add, subtract and intersect; Feather keeping the area and halving at the edge, Expand and Contract across tile seams, Select and Mask's Smooth, Contrast and Shift Edge; the Magic Wand (tolerance, contiguous or not, a ramp, anti-aliasing, read from a mip level, flat fields as whole tiles); filling and clearing a transformed layer through a selection; moving a selection; exact bounds; and Apply Layer Mask with invert, density, feather and the layer's transform. |
| `check:geom` | headless | Paths: exact boxes against dense sampling, flattening within its tolerance, splitting; every live shape against its area; strokes' caps, joins, miter limit and dashes against the areas they should cover, a circle's ring; the coverage rasterizer against exact clipped areas of convex polygons, regions cut out of a shape (with and without each row's backdrop), the kernel's per-pixel sum, its strips of rows and a band sorted by column, sampling, and the fill rules; booleans against analytic areas (rectangles, circles' lens), keeping curves, edges shared or identical, holes, a crossed outline, and a fuzz of random shapes against the same combination sampled point by point; path editing; the vector model read back; and combining, releasing and expanding compound shapes, vector masks, the history's names for them, and the scene's bounds and redraw regions. |
| `check:text` | headless | HarfBuzz on the bundled fonts: faces, names, axes and instances, shaping with kerning, ligatures and features, Arabic and Devanagari, outlines; the font library's styles, nearest matches and fallbacks; the text model's edits (insert, delete, replace across runs and paragraphs, styling ranges, styles and their inheritance); layout: line breaks, bidi in visual order, both composers against their measures, justification reaching both edges, alignment, indents and spacing, area text in a circle, overflow, path text along an arc and a closed path; glyph sets against the paths Create Outlines makes; fonts carried in a `.pxll` and found again; and each variable instance found by its own PostScript name, as Photoshop files name fonts. |
| `check:print` | headless | Print colour: soft-proof tables against LittleCMS's two conversions chained (simulated black, a document proofed on its own profile), the gamut check against CMYK, RGB and Gray devices, the display's look (one ink alone, coverage over a limit), the CMYK adjustment tables (forward against the profile, inverse with black held, identity exact, a hue turned and a colour desaturated through the profile), documents converted (every kind of colour, smart objects, pixel sets, Curves' channels dropped and said), tile sets converted against the colour engine and requantised exactly, grid conversions within a ΔE2000 of LittleCMS's answer, document swatches (links, tints, edits, deletion, saving, mode changes, broken ones), and Adobe Swatch Exchange files written, read, grouped and refused. |
| `check:interchange` | headless | Every one of psd-tools' 49 PSD and PSB files parsed and mapped onto documents (modes, depths, groups, masks, shapes, text, effects, adjustments, smart objects, and what's said about the rest); files written back and read the same, layer by layer and byte by byte; documents written as PSD (vector masks as path records, adjustments as Photoshop's blocks, guides as its guide resource) and read back; 60 descriptors and 17 text layers' engine data round-tripped; jpeg-js's JPEGs (baseline, progressive, CMYK, YCCK, restart markers) decoded against its references; SVG path data, transforms and gradients, and resvg's cases read; SVG written and read back; PDFs written and read by pdf.js (page size, paths, shadings, blend and opacity, ICC colour, PDF/X output intent, spot separations, trim and bleed boxes, inside and outside strokes, every cross-reference). |
| `check:snap` | headless | Snapping: a point to guides, the grid through the zero point and a layer's edge (with the smart guide to it), a box by its edges or centre to the nearest line, an axis left out, equal spacing (centred in a gap, a pair's gap repeated either side, other rows ignored); align and distribute (edges, centres, spacing, to the canvas, in any order); guides added once, moved, merged, removed, cleared, saved, dropped when unreadable, and moved by Canvas Size and Crop (turned a quarter, and gone when straightened); New Guide Layout's columns, rows, margins and centred widths, New Guides from Shape; the settings read defensively; the overlay's guides clipped to the canvas, the grid thinning out as the zoom drops, the pixel grid only close in; and Ctrl+Shift+; found though Shift makes a colon. |
| `check:tiled` | browser | Tiled documents: painting, shapes, filters and selections across the seams, Tiled View. |
| `check:healing` | browser | The Clone Stamp, the Healing Brush, the Spot Healing Brush and Patch, and cloning across a tiled document's seam. |
| `check:warp` | browser | Free Transform's Distort, Perspective and Warp (a style, a dragged mesh, picked up again), a shape warped as outlines, Rasterize keeping a warp, Liquify. |
| `check:filters` | browser | The Filter menu's submenus, Twirl, Lens Blur with an effect's blend mode, a filter layer, Document → Adjustments, Colour Lookup from a `.cube` file. |
| `check:appearance` | browser | Effects on one fill (a shadow, an offset path) from Properties; graphic styles made, given, redefined and unlinked. |
| `check:channels` | browser | The Channels panel: colour channels shown alone and hidden, Red or Blue alone painted and filled, an alpha channel made, painted, filled, cleared, shown as a tint and loaded, a spot channel made from the selection and shown as ink, Channel Options, reordering, colour channels and the luminosity loaded, the Magic Wand on a channel, Ctrl+2 onwards, and alpha and spot channels through PSD and back. |
| `check:construct` | browser | Pathfinder, the Shape Builder, Live Paint, Outline Stroke, Offset Path and Simplify. |
| `check:guides` | browser | Rulers through the real UI: Ctrl+R making room for them, a guide dragged out of each ruler with its readout, drawn on screen, moved and dragged off with the Move tool, Undo, Lock Guides and Ctrl+; ; New Guide and New Guide Layout; the Move tool snapping a shape to a guide, letting go with Ctrl, and lining up with another's top with a smart guide drawn and the readout; the grid shown and snapped to by Move and the Shape tool; Snap turned off; Ctrl- and Shift-click in the Layers panel, moving two layers together, Align from the menu and the options bar to the layers, the key layer and the canvas, Distribute Horizontal Spacing, Delete; a ruler's units from its right-click menu. |
| `check:theme` | headless | Every palette declares the full token set, every registered theme has both modes, every token is used, contrast pairs clear their ratios, and every pasteboard is neutral grey. |
| `check:engine` | browser | A real device on the real GPU, the pasteboard drawn in the theme's colour and redrawn on a change, the canvas at its size in device pixels after a resize and on a real 2× screen, no frames while idle, and the explanation page when WebGPU is missing. |
| `check:files` | browser | New with its validation and units, the checkerboard drawn where the document is, layer edits, undo, redo and History, one step per slider drag, Canvas Size, Save (to a picked file, then in place), the dirty dot, opening a file already open, the journal across reloads, closing with unsaved changes, the recent list, dropping a file, a damaged file, and saving by download where File System Access is missing. File pickers are replaced with ones that return files in OPFS, which are real file handles, so the app's own save path runs. |
| `check:render-ref` | headless | The render graph's CPU references: every blend mode against Photoshop's formulas, neutral colours and modes that commute; over, atop, lerp and knockout; Dissolve's seeded pattern; the four resampling filters; the working space and the mip reduction; the view maths (fit, zoom about a point, pan when rotated, mip levels, visible tiles); and the scene's bounds, content versions and the regions each kind of edit dirties. |
| `check:images` | headless | PNG, built byte by byte in every variant (1 to 16 bits, gray, RGB, palette, keyed transparency, Adam7, iCCP), and our encoder read back and inflated by Node's zlib; TIFF in strips and tiles, uncompressed, LZW (with an early-change encoder here), Deflate and PackBits, with prediction, planar layout, both byte orders, 1 to 16 bits, palette, WhiteIsZero, CMYK and associated alpha; JPEG's markers and writing a profile in; and images into tiles with depth and colour conversion. |
| `check:brush` | headless | The brush engine: settings read back defensively, curves, the seeded generator, dab placement (spacing, smoothing, pressure, jitter, taps, Fade, direction, pulled string, Build-up), every Brush Settings section, colour dynamics in RGB, CMYK and Gray, image tips and their mips, textures and their modes, Noise and Wet Edges, dabs mapped onto scaled and turned layers, the cursor's outline, and the stroke buffer's flow, opacity ceiling, colour mixing, replacing strokes and canvas edge, held to Photoshop's behaviour; ABR files Photoshop made, a published set, and versions 1, 2 and 6 built in the check (tips, patterns, presets, what's refused and named). |
| `check:gpu` | browser | The GPU against the CPU references on the real device: every blend mode under every compositing operation, in RGB, Gray and CMYK at 8 and 16 bits, in f32 and f16; the four filters magnified, minified through a mip, and from a window that doesn't start at the layer's first tile; the display table against `sampleLut`, and proofed, with the gamut marked, inks hidden and an ink limit, against `displayRef`; strokes painted through the engine (hard, soft, Multiply, the eraser, colour jitter, a sampled tip, a turned layer, confined to a feathered selection, an image tip through its mips, textures per tip and per stroke, a dual brush, Noise and Wet Edges, hue/saturation/brightness jitter) baked within one sample step of the reference; Smudge and the Mixer Brush (Finger Painting, a sampled tip, a turned layer, wet and dry, Sample All Layers) likewise; masks (plain, inverted at a density, hiding outside their tiles, moved, turned and scaled, feathered, two multiplied, on an isolated group, a clipped layer and a pass-through group); every adjustment as a layer, in Luminosity, clipped and as an effect (on CMYK through the profile's tables); every live filter, a chain and one at partial opacity, on the middle of three by three tiles; every layer effect alone and together, and a special-eight mode; smart objects against the same layer drawn directly; and filters baked in against live ones, through a selection; Pattern Overlay; and shapes (every gradient kind, patterns, strokes centred, inside and outside, dashes, blend modes in the appearance stack and on the layer, a compound shape, vector masks) and text's glyph sets (dense small text, large turned glyphs with a gradient and a stroke) against the coverage and paint references. It also holds the numbers behind the 16-bit storage decision. |
| `check:canvas` | browser | What's on screen, from screenshots: blend modes, opacity, fill, hiding, groups, knockout and clipping; images dropped on the canvas becoming layers there, and opening as documents in their own mode and depth (16-bit PNG, CMYK TIFF, JPEG); the zoom keys, Ctrl+wheel about the pointer, Space-drag, the Hand, Zoom and Rotate View tools; layers dragged above, below and into each other; PNG and JPEG exports with their profiles; previews in saved files; and a file opened with its tiles read on demand, then saved back over itself. |
| `check:paint` | browser | Mouse and pen strokes (pressure from synthetic pen events) on screen and in the history, undo and redo, opacity as a ceiling and flow building up, the eraser, refusing locked, hidden and non-pixel layers, Shift-click lines, Esc, the Colour Picker, Swatches, Brushes and the options bar, the brush cursor, painting on a rotated view and in CMYK at 16 bits, the history's memory cap, Pen Settings, the Colour panel keeping its hue on a grey; the number keys and Shift+[ ], Brush Settings (F5) and a textured stroke, the Mixer Brush carrying paint on, Smudge, Define Brush Preset, importing an ABR file, and the tip-shaped cursor. |
| `check:tools` | browser | Every tool and command of phase 6 through the real UI: the Marquee (both shapes, Shift and Alt), marching ants on screen, the Lasso freehand and polygonal, the Magic Wand, the Select menu and its dialogs, painting, filling and Delete through a selection, Quick Mask, layer masks made, painted, inverted, turned off, feathered and applied, clipping, the Move tool, nudging, Free Transform (scale, Esc, Enter), flipping, Rasterize, Lock Position, Crop with its handles, and Crop to Selection. |
| `check:effects` | browser | Adjustment layers from the menu, hidden and deleted, their controls in Properties (one step a drag), the Curves editor and Levels with its histogram; a filter previewed, added live, changed in Properties, hidden by its eye, baked in, and applied for good through a selection; the Layer Style dialog, its preview, fx in the Layers panel, Clear Layer Style; and a smart object made, scaled down and up without losing its edges, edited in its own tab and saved back, and rasterized. |
| `check:vectors` | browser | The Shape tool's shapes on screen and in the document, edited in Properties; strokes added, aligned and switched off, a fill turned gradient; the Pen closing and finishing paths, adding and deleting points; Direct Selection moving, converting and deleting them, and picking another shape; compound shapes made, their operation changed, expanded and released; vector masks hiding, revealing and inverting; Free Transform and Rasterize on a shape. |
| `check:type` | browser | The Type tool through the real UI: point text typed, drawn, named and undone in one step; editing with the keys, a selection typed over, Undo and Redo inside the text, Ctrl+Backspace, Enter, an IME's composition, pasting; the Character and Paragraph panels on a selection, a layer and new text; a paragraph style made and renamed; area text wrapping and overflowing; area text inside a star; text along a shape's outline from where it's clicked; the text's thumbnail; Create Outlines, Rasterize, a missing font named, and 60,000 characters of area text fitted on screen drawn to the last tile. |
| `check:segment` | headless | Quick Selection's graph cut (a disc found from a short stroke, subtracting, touching objects, every mode, a big window cut small then refined, its guarantees at the window's edge) and the Magnetic Lasso's wire (along a circle where the chord cuts across, snapping, contrast, anchors), with timings. |
| `check:matte` | headless | Select and Mask's edge: images made from a known alpha (a soft disc, hair-like strands over texture), a hard cut refined to well under its error, Smart Radius narrower on a crisp edge than a soft one, colour decontamination, every mode, timings. |
| `check:retouch` | headless | Content-aware fill: stripes and gradients continued through a hole, the right texture of two chosen, a source region obeyed, several holes at the edges, soft holes blended exactly, every mode, repeatable by seed, cancellable, timings. |
| `check:fills` | browser | Phase 14 through the real UI: Edit → Fill in a blend mode at an opacity, Define Pattern and filling with it, fill layers from the menu and edited in Properties, the Gradient tool live on a fill layer, making one and into pixels through a selection, the Paint Bucket, content-aware fill continuing stripes, Quick Selection, Grow, Border, Smooth, Colour Range's eyedropper, Transform Selection, Save and Load Selection with the Channels panel, Select and Mask's edge detection, and the Magnetic Lasso round a square. |
| `check:clipboard` | browser | The clipboard through Chrome's own: pixels copied (the PNG and the marker other apps and Plexel see), pasted centred on the selection, in place when in view, in place, into and outside the selection; Cut and Undo; Copy Merged; a layer and a shape with its effects copied live; Duplicate Layer and its names, Layer via Copy and Cut; Copy and Paste Layer Style; a path copied with Direct Selection (as SVG for other apps) and pasted into its shape and as a new one; an image, SVG markup and plain text from another app, a text layer's words out; Edit → Paste reading the clipboard; pixels into a CMYK 16-bit document; New from Clipboard; a text field keeping its own clipboard; nothing copied when there's nothing to copy. |
| `check:proof` | browser | Print colour through the real UI: Proof Setup, Proof Colours dulling what the press can't print, the Gamut Warning marking it and sparing what it can; Mode → CMYK as one step, looking as it did proofed, undone and redone; 16 bits; the Separations panel's readings, a plate hidden, coverage over a limit marked; a spot swatch made, linked to a fill at a tint and changed; an .ase library loaded; Convert to Profile back to RGB with the linked fill made again from its swatch. |
| `check:pixels` | browser | Background contents, New Pixel Layer, fills and their undo, engine-rendered thumbnails, the Colour panel's models, hex, X and D, a CMYK document's gamut warning and its fix, Colour Settings drawing swatches in Display P3, Assign Profile with a loaded ICC file (and refusing one for the wrong mode), pixels and profiles saved and reopened, an unsaved fill restored from the journal, and tiles freed when documents close. |
| `check:interchange-browser` | browser | Photoshop's adjustment files drawn against the composites Photoshop saved in them (Levels, Curves, Exposure, Posterize, Invert and Threshold within a level and a half on average); 24 of resvg's SVG cases against resvg's renders; eight PSDs and a PSB written, reopened and drawn the same with the same layers; Plexel's SVGs drawn by Chrome as Plexel draws them, with shapes as paths and text live or as outlines; PDFs read by pdf.js at the right size, with paths, images and a CMYK document's press furniture; a CMYK JPEG opening as CMYK; files known by their contents; and the Export dialog's formats. |
| `check:ux` | browser | The UX pass through the real pointer and keys: a tool's card and the next one shown at once, a disabled menu item's reason, the palette's greyed matches, the key hints before a press, during a drag and in a transform, a held Shift lit, Alt and a right-drag sizing the brush by twice the drag at 100% with nothing painted and no menu after it, V held for the Move tool and the Brush back on release, a tap switching for good, a quick hold of I used to pick, spring-loading turned off, the context menu with and without a selection, the Layers panel's lock, duplicate and delete, Alt-click solo and back as one step each, the peek beside the dock, the drag label, workspaces kept as left and reset, Tab and Shift+Tab, Tab left to a focused control, F through the three screen modes, and Edit → Interface's size (bars larger, canvas and dock in step), density, contrast and switches. |
| `check:shell` | browser | Menus by mouse and keyboard, submenus, shortcuts, the palette (search, run, nothing found, Esc), dialogs, the dock (close, open, fold, resize, reset), and the view state surviving a reload. |

The browser suites start their own dev server and Chrome (with WebGPU turned
on), so each `npm run check:x` is the whole instruction. Set `DEV_URL` to aim
them at a server already running (a `vite preview` of the build, say),
`CHROME_PATH` if Chrome is somewhere unusual, and `HEADFUL=1` to watch.

## Decisions

**WebGPU or nothing.** There is no WebGL or Canvas2D fallback. Every browser
that matters ships WebGPU, and a second renderer would double every kernel
and halve the time spent on the first. Without it, the page explains.

**Icons from Phosphor, bundled.** The interface's icons are Phosphor's
(MIT), chosen over Tabler and Lucide after trying all three in a mock of
the editor (11 October 2026): the largest set, six weights (Regular, and
Fill for a pressed tool), and closest to an editor's look. Components name
an icon by meaning (`tool.brush`, `layer.visible`) through one registry,
`src/ui/icons.ts`; `npm run build:icons` copies just those outlines out of
`@iconify-json/ph` into `src/ui/icons.data.ts`, so nothing is fetched at
run time (the page is cross-origin isolated, and an offline app is
planned). Tools Phosphor has no icon for use the nearest one until we
draw our own on its grid. Help → About credits it.

**The engine owns the canvas.** The page transfers the canvas to the worker
once, and React never draws on it. A panel re-rendering can never cost the
canvas a frame. The price is that the page can't read the canvas back, so the
checks read what was drawn from screenshots.

**Frames on demand.** The engine draws when something changed, at most once
per display frame, and the canvas keeps its last image in between. An idle
image editor should leave the GPU idle.

**Sizes in device pixels.** The canvas is sized from the
`device-pixel-content-box`, so the image is never resampled by a fraction of
a pixel. The pixel ratio is watched separately, because moving a window to
another screen changes it without changing the canvas's CSS size.

**The pasteboard is neutral.** A theme can tint the whole interface, but the
ground around the image stays an equal-RGB grey, because a tinted ground
shifts how every colour in the image is judged. `check:theme` enforces it.

**One command registry.** Menus, shortcuts, the palette and the shortcuts
list are all generated from `src/commands`, so they can't disagree. Commands
act through a `CommandContext` rather than reaching into React, which is also
what lets the whole registry be checked in Node.

**Menus that only promise what exists.** Menus and commands arrive with the
features they run. A menu bar full of disabled items would advertise an app
that isn't there yet.

**One edit path.** Every change to a document is a pure function from one
document to the next, committed through the document store. History, step
names, the dirty dot and autosave all follow from that one path, so no
feature has to remember any of them. An edit that changes nothing returns
the same object, and then nothing happens at all: no step, no write, no
redraw.

**Pixels aren't in the document.** A pixel layer holds a tile-set id,
not tiles. That's what keeps a hundred undo steps of a huge image cheap, and
it's why the model was settled before any pixel exists.

**Unsaved work lives in the journal, not in the tab.** Closing the tab never
loses anything, so leaving the page only asks first when the journal is
behind or unavailable. The next visit reopens what was open, as a code
editor does, rather than asking about recovery.

**Children are in painting order.** `children[0]` is the bottom of a group,
which is the order the renderer walks and PSD stores. The Layers panel
reverses it for display, and only there.

**Clipping is nesting.** Any layer can hold children, which are clipped to
it. Photoshop's clipping mask becomes the command that does the nesting.
One idea instead of two.

**View state stays out of history.** Which layer is selected and which
groups are folded belong to the window, not the document, so changing them
is never an undo step. The journal keeps them, so a reload does too.

**Loaders repair and say so.** A document from a crash, an older or newer
build, or a hand edit always comes back usable, or is refused with a
reason. A layer that belongs nowhere is put back at the top, never dropped:
the user can delete it, but can't get back what a loader threw away.

**Our own zip.** A `.pxll` needs Zip64, entries written as streams, and
random-access reads from a File, together. The platform's
`CompressionStream` does the deflating, so the same code runs in the browser
and in the checks, and a check reads zips Python wrote, to make sure we read
what other tools make.

**Shortcuts the browser keeps are not ours.** Ctrl+N, Ctrl+W and Ctrl+T
can't be taken from Chrome, so New is Ctrl+Alt+N, Close is Ctrl+Alt+W and Free
Transform is Ctrl+Alt+T; Ctrl+Shift+I opens the developer tools, so Inverse is
Shift+F7, Photoshop's other key for it.
`check:commands` refuses any shortcut on that list.

**Our own build of LittleCMS.** The published WebAssembly builds expose
too little of it (no profiles from primaries, no proofing, no saving a
profile). So `native/pxcms/pxcms.c` wraps exactly what Plexel uses, and
`build:cms` compiles it with a pinned LittleCMS in a pinned Emscripten
image, checking the source's hash. The result is checked in.

**Profiles from definitions, not files.** Every built-in profile is made
from its published primaries, white point and curve, so there's nothing
third-party to license. There's no measured press profile among them: the
Generic CMYK one is a plain ink model that says so in its name, and real
print conditions come from the printer's own profile, loaded by the user.

**Gamut is judged by what people see.** A colour counts as out of gamut
when the trip there and back moves it by more than 2 ΔE2000, under the
same intent and black-point setting the conversion uses. Judged any other
way, sRGB black was out of every CMYK gamut, which isn't what anyone
means.

**CMYK display tables spend their points on black.** A CMYK document is
shown through 33 slices along K of a 17-point table over C, M and Y: the
error lives along K, and this layout has a quarter of the error and a
quarter of the memory of the obvious 33-point one with 17 slices.

**Straight alpha in tiles.** Tiles keep colour and alpha separately, as
PSD does, so editing alpha never costs colour precision. Compositing
premultiplies on the GPU.

**Pixels are journalled before the document that refers to them.** A crash
between the two leaves tiles nobody refers to (collected later), never a
document that refers to tiles that aren't there.

**One tab owns the journal.** A Web Lock decides it. Each engine worker
also spills into a folder of its own, held by a lock, so a new tab clears
only the spill folders whose tab has gone.

**Only text fields keep the keys.** A shortcut without Ctrl is left alone in
a text field, and so are Ctrl+Z, Ctrl+Y and Ctrl+A, which are the field's
own undo and select-all. A slider or a checkbox isn't a text field, so Undo
still works after one. A plain key whose command can't run now (Esc with no
transform open, the arrows with nothing to nudge) is left to whatever else
wants it.

**A selection is coverage tiles, in the history.** Gray 8-bit tiles in the
document's grid, where the value is how much a pixel is selected; no tile is
nothing selected, and a uniform tile a whole tile at one value. Selecting
most of a huge canvas costs only the tiles along its edge. Every selection
operation works tile by tile in the engine worker, never on the whole image.

**Masks multiply as a node is laid on.** A node's masks are evaluated per
composite tile on the GPU (sampled through their own transform from the
same atlases and mips as pixels, blurred for feather, inverted and thinned)
and multiplied into the compositing kernel's alpha scale. A cached group
result is the group without its mask, so changing the mask never re-renders
what's under it. A mask that's one value across a tile costs nothing but a
number.

**Strokes are confined as they're laid on, not as they're stamped.** The
selection multiplies the stroke's coverage when the stroke meets the layer,
so a brush builds up inside the selection exactly as it would anywhere.

**Tools draw over the canvas through the engine.** Marching ants, Quick
Mask's tint, marquee and lasso outlines, transform handles and the crop's
shade are drawn in the same frame as the image, through the same view, so
they never trail it while the view moves.

**One parameter list per adjustment, filter and effect.** Each registry
entry lists its parameters once (doc/params.ts); the same list reads them
back from a file, feeds the CPU reference and generates the controls in
Properties and the dialogs.

**Adjustments compile to programs.** An adjustment's settings become one of
eight operations with its numbers worked out on the CPU (a tone table, a
colour matrix, a hue rotation...); the GPU kernel and the TypeScript
reference run the same programs, so the reference is exact.

**Live filters read past the tile.** A layer's content tiles round the one
being drawn are gathered into a region as wide as its filters read, the
filters run on the region, and the middle is cut out. Content tiles are
cached apart from the filters, so changing a filter's settings doesn't
draw the layer again; blurs are box passes with a running sum, so a big
radius costs no more than a small one.

**Layer effects blend where Photoshop's do.** Shadows and glows go onto
what's below in their own blend modes; the rest go on the content within
its shape, so Fill fades the content and leaves its effects.

**Smart objects are drawn like pixel layers.** Their contents are
rendered, at the mip level the view needs, into the same tile atlas pixel
layers sample from, and drawn through the node's transform by the same
code: scaled, turned, filtered and styled like any layer, never losing
detail.

**Vectors are covered exactly, not sampled.** A shape is flattened into
lines (finely enough for the zoom) and each pixel sums the signed area its
row's segments leave to its right: the integral of the winding number over
the pixel. That's exact where one edge crosses a pixel, and the fill rule
turns it into coverage. Each tile gets only the segments crossing it;
whatever lies left of it counts once per row. An outline's segments are
sorted into bands of tile rows, and each band by tile column, once, so a
tile of dense text reads only what crosses it. The same sums run on the CPU
as the reference.

**Text is laid out on the page and drawn as glyphs.** HarfBuzz, the
fonts and layout run on the page, where the Type tool needs the result for
the caret and hit tests. The engine is sent each glyph's outline once and a
transform for every place it's set: the bench's 60,000 characters are 41
outlines and 49,000 small transforms; the vector pipeline draws the set as one
shape. A document carries no glyphs: they're attached on the way to the
engine and made again when a font arrives.

**Our own build of HarfBuzz.** The published WebAssembly builds expose
JavaScript objects for every call and bundle their own font loading; ours
is a small C file over HarfBuzz with a flat interface (faces, fonts,
shaping into a float buffer, outlines through draw callbacks), built and
pinned like LittleCMS.

**Fonts travel with documents where their licence says so.** A font's
`fsType` decides: installable or editable fonts go into the `.pxll` (as
`fonts/<hash>.font`), preview-only, restricted and bitmap-only ones don't,
and nor do the built-in ones. A font that isn't there is asked for by name
and shown in Inter meanwhile; the text keeps its own font setting.

**Proofing is a display table.** A proof condition is folded into the
table the canvas is already drawn through: the document converted to the
proof's device values, clipped to what it can print, then to the screen.
The gamut warning rides in the same table's alpha (out of gamut is 0,
interpolated like the colour, marked past half), and separations and the
ink limit are a few instructions in the display pass. Proofing costs a new
table, not a slower frame.

**Conversions are sampled, then interpolated.** LittleCMS's float
transforms run the whole pipeline for every pixel, about 2 megapixels a
second in WebAssembly. Converting a document samples the conversion on the
display tables' grids (finer in K for CMYK), keeps RGB and Gray outputs
roughly linear, and interpolates tetrahedrally, as LittleCMS's own
optimised transforms do: within a ΔE2000 of its answer, the deepest
shadows included.

**CMYK keeps its black.** Colour adjustments on a CMYK document go to RGB
through its profile and come back with K where it was, C, M and Y solved
for on the profile's forward table, and the result applied as a change, so
an adjustment that changes nothing changes nothing.

**Swatches link; paints don't need them.** A fill linked to a global or
spot swatch keeps the swatch's id and a tint beside its colour, which is
always the swatch's colour in the document's terms. Drawing never looks a
swatch up; editing one, or converting the document, makes its paints'
colours again from it.

**Strokes are geometry.** A stroke is outlined (offsets, joins, caps,
dashes) and filled like any shape, so inside and outside strokes, dashes and
an Outline Stroke command all come from one place.

**Booleans work on the curves.** Compound shapes are combined by cutting
every curve where it meets another and keeping the pieces with the result
inside on one side only, as paper.js does, so Expand gives curves, not a
polygon. A compound is worked out once per change of its shapes.

**Panning redraws the canvas, not the app.** Only the status bar follows the
view; with hundreds of layers, re-rendering the panels every frame of a pan
cost frames.

**Previews skip the history.** A move or transform in progress is sent to
the engine as a document of its own, straight to the canvas, and committed
once when it ends: one step, however long the drag.

**Compositing in storage buffers.** A composite tile is a storage buffer, not
a render target: CMYK has five channels, which no texture format holds,
and the blend modes read the backdrop where they write, which a storage
buffer allows in one pass and a render target doesn't. The same choice
makes the precision a matter of number type.

**f16 for 8-bit, f32 for 16-bit.** Measured (PERFORMANCE.md): f16 is within a
fifth of an 8-bit step and halves the memory, but would lose more than five
bits of a 16-bit document. Neither is faster on the GPU here.

**CMYK blends as light.** Inks are inverted for compositing, as Photoshop
does, so Multiply darkens and Screen lightens in CMYK as they do in RGB.

**Display tables are read by hand.** The table is a storage buffer laid out
as on the CPU and read with the same tetrahedral interpolation, so the GPU
matches `sampleLut` to 10⁻⁷. A 3D texture's filtering would be trilinear, a
different and worse answer.

**Display tiles per mip level, kept while stale.** The renderer keeps
finished tiles at the level that suits the zoom, and an edit marks the ones
it touched as stale instead of dropping them: the old picture stays up until
the new one is ready, and while a tile renders a coarser level shows
through. Moving the view never waits for a tile.

**Mips belong to tile sets.** A set never changes, so its pyramid is built
once, on the GPU, and only ever evicted. Base tiles are keyed by tile id, so
every set derived from another shares its uploads. Uniform and empty tiles
are never uploaded at any level.

**Coordinates relative to the tile.** Every transform the GPU sees maps from
a tile's own pixels to a window of the source, worked out in doubles on the
CPU, so float32 is exact enough at the far corner of a 300,000-pixel
document.

**Strokes are drawn into stroke tiles, not into the layer.** While the pen
is down, dabs are stamped into float stroke tiles in the layer's own pixel
grid, and the compositing kernel lays the stroke on as it reads the layer.
The canvas shows the stroke at once through the ordinary render path, at
any zoom and angle, and on a turned or scaled layer; flow and opacity
behave as Photoshop's because coverage builds up in the stroke before it
blends once. Only when the pen lifts are the touched tiles baked, read back
and made into a new tile set.

**Mips are keyed by what's under them.** A mip tile's key is a hash of the
four below it, so after a stroke only the mips above the changed tiles are
built again, not the layer's whole pyramid.

**Pen samples skip the message queue.** The page writes each sample into a
SharedArrayBuffer ring as the pointer event arrives, and the worker reads
the ring at the start of each frame. Samples that beat their stroke's begin
message are held until it arrives. Without cross-origin isolation, samples
go as messages.

**History is capped by what it holds, too.** A hundred steps of strokes on a
big image can hold gigabytes of replaced tiles. Past 1 GB of tiles that
only older steps hold, the oldest steps go.

**The checks get a word from the engine.** `render.idle` resolves once a
frame reflecting every earlier message has been drawn with nothing left to
render, so a browser check waits exactly as long as drawing takes, never a
guessed sleep.

**Our own PNG and TIFF.** The browser's decoders hand back 8-bit sRGB and
drop the profile. JPEG's pixels do come from the browser, asked not to
convert colours, with its profile read by our own marker parser. CMYK
JPEGs, which the browser can't decode faithfully, go through our own
decoder.

**Our own PSD code.** ag-psd hands pixels over as canvases and keeps
descriptors as plain objects; Plexel's pixels live in the engine's tiles at
16 bits and in CMYK, and a file it partly understands should write back
what it didn't touch. So `io/psd/` reads and writes the format exactly,
keeps every block it doesn't understand, and maps onto Plexel's model
separately. A PSD is written from a plan made on the page, with the
engine filling in the pixels from its tiles.

**Adjustments follow Photoshop's formulas.** A Photoshop document should
look the same in Plexel. Levels and Curves take each channel before the
master, Curves is a natural spline, Exposure works in linear light,
Posterize cuts equal bins, and each is held to the composites Photoshop
saved in its own files. Where Photoshop's formula isn't published
(Brightness/Contrast), ours is fitted to its renders.

**Vectors where the format can hold them.** SVG and PDF get paths and text
for every layer they can draw as Plexel does, and an image of the rest;
anything that changes what's under it (an adjustment, a blend mode the
format lacks) flattens what's below into one image, so the file always
looks like the document.

**The Fresyn toolchain.** Vite, React 19, strict TypeScript, no UI library,
plain global CSS on theme tokens, checks as standalone scripts, and a deploy
gated on the headless checks. ARCHITECTURE.md lists the habits that came
with it.

## Layout

```
src/
  main.tsx            applies the saved theme before the first render, mounts App
  App.tsx             the shell: view state, the CommandContext, shortcuts
  app.css             every style; z-index layers named once at the top
  theme.css           the palettes: three themes, dark and light
  app/
    documents.ts      the open documents: history, file, selection; the one edit path
    gesture.ts        what the pointer is doing on the canvas, for the key hints
    springTools.ts    a tool's key held rather than tapped: the tool before, back on release
    colour.ts         the colour engine on the page
    colours.ts        the foreground and background colours
    colourSettings.ts the display profile, intent and black-point setting
    pixels.ts         fills, and telling the engine which tile sets are in use
    clipboard.ts      Cut, Copy, Paste and its kinds, Layer via Copy, Duplicate Layer, layer styles, the system clipboard
    autosave.ts       keeps the journal in step with the documents
    files.ts          New, Open (documents and images), Save, Import as Layer, Export, Close
    psd.ts            opening Photoshop documents on the page: fonts found by PostScript name
    svg.ts            opening SVG on the page: named colours, embedded images
    exports.ts        PSD, PSB, SVG and PDF written from a document
    views.ts          each document's view: fit, zoom, pan, rotate
    painting.ts       starting strokes, passing samples, committing them; the Colour Picker
    selection.ts      the Select menu, fills and Delete through it, Quick Mask, layer masks, alpha channels
    selectTools.ts    the selection tools' settings
    canvasTools.ts    Move, Marquee, Lasso, Wand, Crop, Free Transform and Transform Selection gestures; sessions; overlays
    toolGestures.ts   the Gradient tool, the Paint Bucket, Quick Selection and the Magnetic Lasso
    fills.ts          Edit → Fill, content-aware fill, Define Pattern, fill layers
    patternEdit.ts    Make Pattern and pattern editing mode: the tile's tab, its repeat drawn back into the pattern
    fillTools.ts      the Gradient tool's and the Paint Bucket's settings
    vectors.ts        the Pen, Direct Selection and Shape tools, paths' overlay, compound shapes, vector masks
    fonts.ts          the font library on the page: built-in, added, the computer's, documents' own
    text.ts           text laid out for the engine (glyphs attached on the way), missing fonts
    typing.ts         the Type tool: the editing session, its hidden text field, panels' targets, Create Outlines
    typeSettings.ts   new text's character and paragraph settings
    textStyles.ts     character and paragraph styles: made, redefined, renamed, deleted
    fontEmbed.ts      the fonts a document carries in its file and the journal
    effects.ts        adjustment layers, filters, layer styles, smart objects and Edit Contents
    brushes.ts        the painting tools' brushes, saved presets, the Mixer's and Smudge's settings, pen settings
    brushAssets.ts    image tips and patterns, kept in IndexedDB by content hash and sent to the engine once
    brushImport.ts    ABR files imported into the Brushes panel and exported from it; Define Brush Preset
    toolPresets.ts    tool presets: each tool's options taken and given back; TPL files imported
    swatches.ts       kept colours
    docSwatches.ts    the document's swatches: made, changed, linked, libraries in and out
    convert.ts        Convert to Profile and Document → Mode
    proofing.ts       each document's proof settings and separations, sent to the engine
    pointer.ts        where the pointer is over the document, for the Separations panel
    notices.ts        the messages at the bottom of the canvas
  adjust/
    defs.ts           ADJUSTMENT_DEFS, compiled to programs, and the reference that runs them
  filters/
    defs.ts           FILTER_DEFS: each filter's parameters, reach and CPU reference
  fx/
    defs.ts           FX_DEFS: the layer effects and their parameters
    ref.ts            the effects worked out on the CPU: planes, jump flooding, each effect's layer
  geom/               geometry (no DOM, runs in Node)
    path.ts           paths of cubics: segments, bounds, flattening, transforms
    shapes.ts         live shapes and the paths they make
    stroke.ts         strokes as outlines: joins, caps, dashes
    raster.ts         exact coverage: segments per region, the reference the kernel is held to
    boolean.ts        add, subtract, intersect and exclude on the curves
    edit.ts           what the Pen and Direct Selection do to a path, and hit tests
    glyphs.ts         glyph sets: outlines placed many times, flattened, bounded, made a path
  text/               type (no DOM, runs in Node apart from loading the wasm)
    hb.ts             HarfBuzz, wrapped: faces, names, axes, shaping, outlines, licences
    wasm/             the compiled HarfBuzz (from native/pxhb by build:hb)
    fonts.ts          the font library: families and styles, lazy loading, fallbacks
    layout.ts         shaping in paragraphs, line breaking, bidi, the composers, frames, paths
    caret.ts          positions, carets, hit tests, words and lines, selection boxes
  vector/
    shape.ts          a shape's or compound's path, wherever it's asked for
    outline.ts        what each fill and stroke fills, per mip level
    paint.ts          paints made concrete for a tile, and their reference
    patterns.ts       the patterns, as formulas, in TypeScript and WGSL
  doc/                the document as pure data (no DOM, runs in Node)
    types.ts          Doc, nodes, blend modes, limits
    vector.ts         geometry and the appearance stack, read back whole
    convert.ts        a document's colours converted to another mode, profile or depth
    swatches.ts       document swatches: process, global and spot, and the paints linked to them
    text.ts           text's content, character and paragraph settings, styles, and edits to them
    nodes.ts          NODE_DEFS: every node kind, declared once
    edit.ts           every edit, as a pure function
    params.ts         parameters described once: reading them, and what the controls are made from
    tree.ts           places, subtrees, the layers panel's rows
    fragment.ts       layers lifted out as a small document, and pasted back with new ids
    patterns.ts       patterns from artwork: tile layouts and their repeats, the edit tab's tiling, contents
    history.ts        undo and redo for any immutable value
    describe.ts       names each history step by diffing
    serialize.ts      JSON out, and a defensive, repairing loader
    read.ts           reading untrusted values with defaults and warnings
    units.ts          px, in, cm, mm and pt
    presets.ts        the New Document presets and profile choices
  color/
    cms.ts            LittleCMS, wrapped: profiles, transforms, no pointers
    wasm/             the compiled engine (from native/pxcms by build:cms)
    profiles.ts       the built-in profiles, and resolving a document's
    cmykModel.ts      the ink model behind Generic CMYK
    value.ts          a colour in its own space, and converting it
    models.ts         HSB, HSL, hex, LCh, ΔE76 and ΔE2000
    lut.ts            display lookup tables (proofed and gamut-marked too) and their CPU samplers
    proof.ts          how a document is looked at: Proof Setup, Proof Colours, the Gamut Warning, inks
    convertLut.ts     conversions sampled on a grid, for converting many pixels fast
    cmykAdjust.ts     CMYK to RGB and back with black kept, for colour adjustments
  select/             the selection work that reads the image, pure and run in Node too
    quickSelect.ts    Quick Selection: a graph cut (Boykov–Kolmogorov) round a brush stroke
    liveWire.ts       the Magnetic Lasso: edge costs and the cheapest path along them
    matte.ts          Select and Mask's edge band, the edge re-estimated from colours, decontamination
  retouch/
    inpaint.ts        content-aware fill: multi-scale PatchMatch completion
    inpaint.worker.ts the same, in a worker of its own
  tiles/
    format.ts         tile layout: planar, 256 pixels, 8 or 16 bits
    store.ts          the tile store: sets, refcounts, slabs, the budget
    spill.ts          where tiles go past the budget
    pack.ts           tiles as bytes: filtered, deflated, packed
    journal.ts        tiles in the autosave journal, by content hash
    coverage.ts       selections and masks as tiles: shapes, combining, feather, the wand, Grow, Colour Range, transforms, fills through them
    fill.ts           a paint or an image laid on a layer through coverage, in a blend mode, preserving transparency or not
    patterns.ts       a pattern's pixels read out for drawing
    convert.ts        a tile set converted to another mode or depth
  io/
    zip.ts            zip writing and reading, with Zip64
    assets.ts         bytes documents refer to by hash: embedded profiles
    pxll.ts           the .pxll layout
    journal.ts        the autosave journal, over any store
    opfs.ts           the journal's store in OPFS (opfs.worker.ts for older browsers)
    handles.ts        file handles and the recent list, in IndexedDB
    files.ts          pickers, writing to a handle (as a stream), downloads
    png.ts            PNG decoding (every variant) and encoding
    tiff.ts           TIFF decoding: strips, tiles, LZW, Deflate, PackBits
    jpeg.ts           JPEG markers: size, components, ICC in and out
    jpegDecode.ts     our own JPEG decoder, for CMYK: baseline, progressive, YCCK
    flat.ts           what SVG and PDF can hold as vectors, and what flattens
    abr.ts            Photoshop's brush files: tips, patterns and presets mapped onto Plexel's
    abrWrite.ts       brushes written as an ABR file, with Plexel's settings whole beside Photoshop's keys
    tpl.ts            Photoshop's tool presets: each preset's tool and the options of it Plexel has
    psd/              Photoshop documents (no DOM, runs in Node)
      bin.ts          bytes in and out, PSB's wider lengths included
      format.ts       the file as Photoshop lays it out, read and written exactly
      descriptor.ts   Photoshop's descriptors, as trees, written back as they were
      engineData.ts   the text engine's data, likewise
      blocks.ts       the tagged blocks Plexel reads: paths, adjustments, text, smart objects
      toDoc.ts        a file onto Plexel's model
      fromDoc.ts      a document onto a plan of layers, blocks and where their pixels are
      plan.ts         the plan's types, shared with the engine
    svg/
      xml.ts          enough XML for SVG
      read.ts         SVG onto Plexel's model: shapes, styles, gradients, clip paths, text
      write.ts        a document as SVG
    pdf/
      write.ts        a document as a PDF for print
    raster.ts         a decoded image, sniffing a file's kind, images into tiles
    ase.ts            Adobe Swatch Exchange files, read and written
  commands/
    index.ts          COMMANDS and MENUS: the one registry
    search.ts         the palette's matching and ranking
  engine/
    protocol.ts       ToEngine / FromEngine message types (types only)
    EngineHost.ts     the page's handle on the worker: scenes, views, sizes, calls
    worker.ts         the engine worker: device, canvas, frames, recovery, calls
    tileHost.ts       the tile store as the worker runs it, and its calls
    selectHost.ts     the selection and mask calls
    selectImageHost.ts the selection calls that read the image: Grow, Colour Range, Quick Selection, the wire, Refine Edge
    fillHost.ts       fills, gradients into pixels, content-aware fill, Define Pattern's crop
    clipHost.ts       pixels read under a selection for the clipboard, and its PNG
    colourHost.ts     LittleCMS in the worker: profiles, display and proof tables, CMYK adjustment tables
    convertHost.ts    converting a document's pixels
    imageHost.ts      decoding images into tiles, encoding exports
    psdHost.ts        opening Photoshop documents into tile sets
    psdWrite.ts       writing a plan's pixels from the tiles into a PSD
    nodeImage.ts      a layer or the flattened bottom of a document as an image, for SVG and PDF
    gpu.ts            getting a device, and saying why when there isn't one
  brush/              the brush engine (no DOM, runs in Node)
    defs.ts           brush settings: every Brush Settings section, controls, BRUSH_PRESETS, the Mixer's presets
    stroke.ts         pen samples to dabs: smoothing (and the pulled string), spacing, dynamics, jitter, Build-up
    dab.ts            a dab mapped into a layer's pixels, and its coverage: tips, Noise, Wet Edges
    tips.ts           tips of any size with their mips, the built-in ones made from fixed seeds
    special.ts        bristle, erodible and airbrush footprints, made from their names; erodible wear
    textures.ts       the built-in papers, patterns, and the ten texture modes
    colour.ts         Colour Dynamics in RGB, CMYK and Gray
    outline.ts        a tip's outline, for the cursor
    preview.ts        a stroke drawn on the CPU, for the panels' previews
    rng.ts            the seeded generator
  render/
    strokes.ts        strokes being painted: stamping, and baking into tiles
    view.ts           the view maths: matrices, fit, zoom, mip levels, visible tiles
    scene.ts          the engine's copy of a document: bounds, versions, dirty regions
    graph.ts          the render graph: evaluators, groups, clipping, knockout, the group cache
    residency.ts      tiles and mips on the GPU
    renderer.ts       frames: scheduling, display tiles, the selection's overlay, the screen pass
    overlay.ts        what tools draw over the canvas, and cutting it into triangles
    readback.ts       thumbnails, previews and full-size composites, read back
    blendModes.ts     BLEND_DEFS: every blend mode, declared once
    probe.ts          the checks' and the bench's probes, loaded only when asked
    gpu/              atlases with LRU eviction, pipelines, rings, the buffer pool
    shaders/          WGSL: compositing, masks, adjustments, filters, layer effects, vector coverage and paint, smart objects' tiles, display, mips, the screen, overlays
    ref/              the CPU references: blend modes, compositing, resampling, painting, Smudge and the Mixer
  tools/
    index.ts          TOOL_DEFS: Move, Marquee, Lasso, Quick Selection, Magic Wand, Crop, Pen, Direct Selection, Shape, Type, Brush, Mixer Brush, Eraser, Smudge, Gradient, Paint Bucket, Colour Picker, Hand, Zoom, Rotate View; groups sharing a key
  input/
    shortcuts.ts      parsing, matching and printing shortcuts
    penRing.ts        pen samples to the worker through shared memory
    guard.ts          the browser kept from the keys and the mouse
  ui/
    MenuBar.tsx       the menu bar, from MENUS, with the workspace switcher
    ContextMenu.tsx   the canvas's right-click menu, from contextMenu()
    Tooltips.tsx      the tooltip layer: data-tip, data-tip-tool and data-why
    Keys.tsx          keys and gestures as chips, ⇧⌥⌘ on a Mac
    KeyHints.tsx      the status bar's key hints for the tool in use
    InterfaceDialog.tsx Edit → Interface
    interface.ts      interface settings: size, density, contrast, motion, help
    CommandPalette.tsx
    Dock.tsx          the panels and the splitter
    LayersPanel.tsx, HistoryPanel.tsx, PropertiesPanel.tsx
    DocTabs.tsx       a tab per open document
    docDialogs.tsx    New, Canvas Size, Resolution, Rename, Open Recent, unsaved changes
    Notices.tsx
    ColourPanel.tsx, colourView.ts, colourDialogs.tsx
    Viewport.tsx      the canvas the engine draws on, its gestures, and the start screen
    Toolbar.tsx       the tools, from TOOL_DEFS
    OptionsBar.tsx    the chosen tool's settings, from its schema
    BrushesPanel.tsx, SwatchesPanel.tsx
    BrushSettingsPanel.tsx every section of the brush, controls and their curves, the live preview
    DefineBrushDialog.tsx Define Brush Preset
    SeparationsPanel.tsx the inks of a CMYK document, the readings under the pointer, the ink limit
    PenDialog.tsx     Pen Settings
    icons.ts          the icon registry: every icon by meaning, Phosphor's name for it
    icons.data.ts     the outlines build:icons copied out of Phosphor (generated, checked in)
    Icon.tsx          an icon from the registry, in the text's colour and size
    selectDialogs.tsx Feather, Expand and Contract, Border and Smooth, Colour Range, Save and Load Selection, Select and Mask
    fillDialogs.tsx   Fill and Define Pattern
    ToolPresetsPanel.tsx tool presets: new, choose, rename, Current Tool Only, import
    ChannelsPanel.tsx alpha channels, and the document's patterns (and pattern editing mode's options)
    ParamControls.tsx controls from parameter lists, the Curves, Levels and gradient editors
    VectorProps.tsx   a shape's or text's settings and its appearance stack, in Properties
    TypePanels.tsx    the Character and Paragraph panels, and their styles
    effectDialogs.tsx the Filter and Layer Style dialogs
    ExportDialog.tsx  PNG or JPEG, and what the file will hold
    StatusBar.tsx
    Dialog.tsx        a modal dialog; dialogs.tsx holds the Help ones
    Unsupported.tsx   the page shown without WebGPU
    ErrorBoundary.tsx the page shown when the app fails to draw
    panels.ts         PANELS: the dock's panels, declared once
    workspace.ts      the task workspaces, which panels are open, the dock's width
    theme.ts          theme names, and loading and saving the choice
native/
  pxcms/              the C side of the colour engine, and LittleCMS's pinned hash
  pxhb/               the C side of the shaper, and HarfBuzz's pinned hash
public/
  fonts/              Inter Variable and the Noto fallbacks, with their licences
scripts/
  build-cms.mjs       compiles the colour engine in Docker
  build-hb.mjs        compiles HarfBuzz in Docker
  run-checks.mjs      runs the suites in groups and summarises
  run-ts.mjs          bundles a TypeScript check with esbuild and runs it
  harness.mjs         dev server, Chrome with WebGPU, waiting, reporting
  png.mjs             reads screenshots back, for checking drawn colours
  bench.mjs           the bench (npm run bench)
  check-*.ts / .mjs   the suites
  fixtures/           files made by other tools, for the checks to read
```

## Roadmap

[ROADMAP.md](ROADMAP.md) tracks where the build stands, the next phase's
checklist, what's been deferred and what's waiting on a decision. Phases 1
to 14 are done; what comes next is chosen from the gap map. [PERFORMANCE.md](PERFORMANCE.md) has the budgets and the
measurements.
