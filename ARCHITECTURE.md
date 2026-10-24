# Plexel architecture

Plexel is a professional raster and vector image editor that runs in a
desktop browser. It aims at the ground Photoshop, Illustrator and Affinity
cover between them: painting and retouching on big, deep, colour-managed
images, and Illustrator-grade vector and type work, in one document. It is a
single-page app on Cloudflare Pages at **https://plexel.dblpl.us**, with nothing
to install and no server.

This file is the design: what the pieces are, where each lives, and why. It is
written before the code, so it records intent. When the code disagrees, the
code wins and this file gets fixed. Once the app exists, the README's
Decisions section takes over the record of individual choices, the way it
does in Fresyn, and this file keeps the big picture.

## Goals and limits

- **Professional depth from the start.** 8-bit and 16-bit documents with
  colour management, in RGB, Gray and CMYK. Lab, and HSB/HSV as picker modes,
  follow later. Big images from the first build: tens of thousands of pixels
  on a side, many layers, without the page falling over.
- **Non-destructive wherever it can be.** Live transforms on pixel layers,
  adjustment layers, live filters, masks, smart objects, an appearance stack
  on vectors and live booleans. Everything is designed in now, even the parts
  that are built later, so nothing needs a rewrite to arrive.
- **Desktop only.** Mouse, keyboard and a pressure-sensitive pen. No phone or
  tablet layout.
- **WebGPU required.** Chrome, Edge, Safari and Firefox all ship it. A browser
  without it gets a plain page saying so, not a degraded editor.
- **Chromium is the best home, but not the only one.** Open and save in place
  through the File System Access API, and installed fonts through Local Font
  Access, are Chromium features. Other browsers fall back to download and
  upload, and to fonts the user adds.

## What carries over from Fresyn

Fresyn shipped fast and has absorbed many unplanned features without
rewrites. These are the habits that did it, and Plexel keeps every one:

1. **Single source of truth, held in registries.** Fresyn declares each
   module once in `MODULE_DEFS`, and the UI, compiler, save format, migration
   and checks all read that one entry. Plexel does the same for node kinds,
   tools, blend modes, adjustments, filters, layer effects, brush presets,
   importers and exporters. Adding a filter means one def, one GPU kernel and
   its CPU reference, and one manual section. The properties UI is generated
   from the def unless the filter needs a custom face.
2. **One edit path over immutable data.** The document is plain immutable
   data. Every change goes through one `commitDoc(fn, key, label)` into a
   generic `History<Doc>`, with keyed coalescing and step names worked out by
   diffing. Undo, autosave, history labels and change detection then come
   free with every new feature.
3. **The engine stays outside React.** Fresyn's DSP runs in a worklet that
   React never touches. Plexel's renderer, tile store and brush engine run
   in a worker that owns the GPU, and React draws only the menus, panels and
   dialogs around the canvas.
4. **Pure, browser-free core modules.** The document model, geometry, colour
   maths and file formats import nothing from the DOM, so Node runs them
   directly in the fast checks.
5. **A CPU reference for every GPU kernel.** Fresyn's DSP is testable bit for
   bit in Node. A WebGPU shader isn't, so every blend mode, adjustment,
   filter and colour transform also gets a plain TypeScript reference. The
   fast checks hold the reference to the maths, and the browser checks hold
   the GPU to the reference within a stated tolerance. Brush jitter and
   filter noise use seeded RNGs, never `Math.random`.
6. **Checks as the spec.** No test framework: standalone `check-*.ts`
   (headless, bundled by esbuild through `run-ts.mjs`) and `check-*.mjs`
   (Puppeteer against the real app) scripts. Assertions are English sentences
   ("one undo takes back the whole brush stroke"). A runner groups them into
   `fast`, `browser` and `all`, and `deploy` refuses to publish unless
   `check:fast` and a full type-check pass. Catalogue-wide sweeps (every blend
   mode, every filter at both ends of every parameter, every colour mode and
   depth) cover new entries without new tests.
7. **The manual is data and is tested.** MANUAL.md's parameter tables are the
   in-app hover help, pulled out at build time by a Vite plugin, and
   `check:manual` builds the manual's tutorials and checks what the text
   claims. *Not built yet* (13 October 2026): neither the plugin nor
   `check:manual` exists; the hover help comes from the registries' own
   hints, and nothing checks MANUAL.md. On the deferred list.
8. **Defensive I/O.** Every storage call is guarded. Loaders clamp and drop
   bad input and collect `warnings[]` instead of throwing. A migrations table
   handles renames without bumping the format. A file newer than the build is
   refused with a clear message. If rendering crashes, a crash screen hands
   back the user's work.
9. **Performance by measurement.** A bench script, budgets written down in
   PERFORMANCE.md, and before and after numbers for every optimisation.
10. **Decisions written down when they're made.** Comments explain why, in
    plain prose, often naming the failure they prevent. The README keeps a
    Decisions section of short bold-lead paragraphs.

The toolchain is also the same: Vite, React 19, strict TypeScript, no UI
library, hand-built controls, global CSS on theme tokens with several themes
in dark and light, `wrangler pages deploy` from a local build, and COOP/COEP
headers for cross-origin isolation.

## The threads

```
 main thread (React)                       engine worker (owns the GPUDevice)
 ───────────────────                       ──────────────────────────────────
 UI chrome: menus, panels, dialogs         OffscreenCanvas + WebGPU device
 Doc + History<Doc>  ── doc diffs ──────▶  doc mirror (by node id + version)
 input capture (pen, keys)  ── samples ─▶  tool runtime: strokes, previews
 tool state machines                       render graph + caches
 viewport (pan, zoom, rotate) ─────────▶   tile store (CPU slabs, GPU residency)
                    ◀── new tile-set ids,  overlays (ants, handles, guides)
                        bounds, picks ──   colour LUTs, mip pyramids

 helper worker pool: file decode/encode, ICC/LUT builds, zip, PSD, autosave I/O
```

- **The document tree lives on the main thread**, as Fresyn's `Doc` does. It
  is small: nodes, their properties, path data, text, colour values and
  references to pixel content. Pixel data is never in the tree.
- **Pixel data lives in the tile store**, which the engine worker owns. The
  tree refers to pixels by immutable *tile-set ids*. A brush stroke or a
  destructive filter runs in the worker and produces a new tile set that
  shares every untouched tile with the old one. It reports the new id, and
  the main thread commits an ordinary doc edit that swaps the reference.
  Undo points the node back at the old id. History stays generic and cheap,
  however big the image.
- **The worker keeps a mirror of the tree.** The main thread sends the
  changed nodes only, each with its version number, and the render graph
  invalidates by version.
- **Pen input is forwarded at once.** The main thread captures pointer events
  with `getCoalescedEvents()` (and predicted events for display) and passes
  each sample (position, pressure, tilt, twist, time) to the worker through a
  SharedArrayBuffer ring, so painting doesn't wait on React or on a message
  queue.
- **The worker draws the overlays**: marching ants, transform handles, path
  points, guides and the brush cursor. They share the frame's own viewport,
  so they never drift from the image during a pan. Hit-testing is pure
  geometry and runs on the main thread.
- **Messages are typed unions** in `src/engine/protocol.ts`: `ToEngine` and
  `FromEngine`. The file holds types only, as Fresyn's `dsp/protocol.ts`
  does, so either side can import it without pulling in the other.

## Source layout

```
src/
  doc/        the document as pure data: types, NODE_DEFS, edits, history,
              normalize (invariants), describeEdit, serialize + migrations
  color/      colour values and spaces, profiles, the lcms2 wasm wrapper,
              conversions, display and proof LUT builders, swatches
  geom/       paths and béziers, flattening, hit-testing, booleans, offset,
              stroke outlining (joins, caps, dashes, width profiles), live
              shape generators
  text/       the HarfBuzz wrapper, font registry, line breaking and bidi,
              the paragraph composer, text on a path, text styles
  tiles/      tile formats, sparse copy-on-write tile sets, slab allocator,
              reference counting and GC, OPFS spill
  render/     the render graph: node evaluators, region requests, caches
    gpu/      device, pipelines, texture pools, residency
    shaders/  WGSL: compositing, blend modes, kernels, rasterizer, colour
    ref/      CPU reference implementations of every kernel
  select/     selection work that reads the image: Quick Selection's graph
              cut, the Magnetic Lasso's wire, Select and Mask's edge matting
  retouch/    content-aware fill (PatchMatch), and its worker
  engine/     the worker: protocol, scheduler, tool runtime, overlays
  brush/      brush defs, dynamics, dab placement, stroke compositing
  tools/      TOOL_DEFS and each tool's state machine
  io/         importers and exporters, the .pxll zip, File System Access,
              OPFS storage, autosave journal, recovery
  input/      pointer, pen and keyboard capture, shortcuts
  app/        the page's stores and actions: documents, tools and their
              gestures, selections, the clipboard, autosave, the overlay;
              what the components call and read
  lib/        small helpers any layer may use: Listeners (every store's
              change listeners), useStable (callbacks that keep their
              identity, for memoised panels), deepEqual, clamp and clamp01
  checks/     the GPU probes check-gpu drives inside the engine (probe.ts),
              loaded only for the checks
  ui/         React components: shell, panels, dialogs, controls
scripts/      check-*.ts, check-*.mjs, run-checks.mjs, run-ts.mjs,
              harness.mjs, bench-*.ts
```

`doc/`, `color/`, `geom/`, `text/` (apart from loading wasm), `tiles/`
(apart from OPFS) and `render/ref/` run in Node.

## The document model

The document uses one tree of nodes, the Affinity approach, where raster and
vector are equals.

### The document

```ts
interface Doc {
  format: number
  name: string
  width: number; height: number      // pixels
  resolution: number                 // pixels per inch, for physical units
  mode: 'rgb' | 'gray' | 'cmyk'      // later 'lab'; the type leaves room
  depth: 8 | 16                      // later 32 (float); the type leaves room
  profile: ProfileRef                // the working ICC profile
  root: NodeId                       // a group
  nodes: Record<NodeId, Node>
  selection: SelectionRef | null     // in history, as in Photoshop
  guides: Guide[]
  swatches?: DocSwatch[]             // process, global and spot colours (doc/swatches.ts)
  patterns?: DocPattern[]            // patterns made from pixels: tile sets, by id
  channels?: DocChannel[]            // alpha and spot channels: coverage, each with a transform and how it shows
  styles: { char, para, graphic }    // named styles, referenced by id
}
```

**Artboards** (`doc/artboards.ts`) are groups at the top level carrying an
`artboard` (size, background, clip); an artboard's corner is its group's
translation, so moving one is moving a group, and Canvas Size, Crop and
the rest move it with everything else. The canvas is the pasteboard round
them, grown (`fitCanvas`, reporting how far things moved so the view can
follow) whenever they'd leave it. **Symbols** (`doc/symbols.ts`) are
`symbols: { id, name, content: Doc }`, a document per symbol as a smart
object's contents are, and instances are nodes of kind `symbol` whose
transform takes the symbol's coordinates into the document's.

Nothing below the document model knows either: `doc/expand.ts` turns an
artboard into an isolated group with a background rectangle at the bottom
and a vector clip mask, and an instance into a group of copies of its
symbol's layers through its transform (ids `<instance>~<layer>`, which
`ownerOf` maps back), nested instances in turn. `EngineHost.setScene`, the
exporters and picking all read the expanded document; it's kept per
document and per node (and per symbol version), so unchanged nodes stay
the same objects and the engine is sent only what changed. Exporting an
artboard is `artboardDoc`: the document cropped to it with only it in the
root, through every exporter as it is.

### Nodes

Every node carries the same core:

```ts
interface NodeBase {
  id: NodeId
  kind: NodeKind
  name: string
  visible: boolean; locked: LockFlags
  opacity: number; fillOpacity: number   // fill excludes layer effects
  blend: BlendModeId
  blendIf: BlendRanges | null            // reserved now, built later
  transform: Affine                      // doc space; see live transforms
  masks: NodeId[]                        // pixel or vector masks, multiplied
  effects: NodeId[]                      // adjustments / live filters on this node only
  fx: LayerFx[]                          // shadow, stroke, glow, bevel...
  children?: NodeId[]                    // containers only; children clip to the parent
  tag: ColourTag | null
}
```

The kinds, each declared once in `NODE_DEFS` with its own properties,
defaults, container rules and render evaluator:

| Kind | What it is |
| --- | --- |
| `group` | A container. Pass-through or isolated blending, and Photoshop's knockout. Whether it's folded in the Layers panel is view state, not part of the document. |
| `pixel` | Sparse tiles in the document's mode and depth, in its own pixel grid. |
| `vector` | One path or live shape, with an appearance stack. |
| `boolean` | A live compound shape. Its children are vectors, each with an operation (add, subtract, intersect, exclude). Expand turns it into paths. |
| `text` | Point, area or path text, shaped live. Glyphs go through the vector pipeline. |
| `adjustment` | Levels, curves, hue/saturation and the rest, from `ADJUSTMENT_DEFS`. |
| `filter` | A live filter from `FILTER_DEFS`: blur, sharpen, noise, distort and the rest. |
| `embedded` | A smart object: a whole sub-document with its own mode, depth and profile, converted into the parent's space when rendered. |
| `linked` | A smart object whose source is an outside file, kept by handle, with an OPFS copy so the document still opens without it. |
| `mask` | A pixel mask or vector mask, with live density and feather. |
| `fill` | Photoshop's fill layer: one paint (a colour, a gradient, a pattern) over the whole plane, without an edge, shaped by its masks. |
| `symbol` | An instance of one of the document's symbols, placed by its transform; drawn as copies of the symbol's layers. (Artboards are groups with an `artboard`, not a kind of their own.) |

**Effects and clipping follow one rule.** An adjustment or filter placed
among siblings applies to the composite below it inside the same parent. One
placed in a node's own `effects` applies to that node alone, the way
Photoshop's smart filters do. Clipping is nesting: any node can hold
children, and they are clipped to it. Photoshop's "Create clipping mask"
becomes a command that does the nesting, and PSD import maps clipping groups
onto it. That gives one concept instead of two.

**Live transforms on pixel layers.** A pixel node's tiles stay in its own
pixel grid, and `transform` places that grid in the document. The render
step resamples it (bilinear, bicubic or Lanczos, chosen per node) from the
mip level that suits the zoom. A brush on a transformed layer maps its dabs
back into layer space through the inverse transform, so painting works at any
angle. Warp, perspective and mesh distort live in a node's `effects` as
filters with geometric outputs. **Rasterize** renders the node once and
replaces its tiles and transform with the result. It is an explicit command,
never a side effect.

**The appearance stack** on `vector`, `boolean` and `text` nodes is an
ordered list of fills and strokes. Each entry has its own paint (solid,
gradient, pattern or image), opacity, blend mode and effects. Strokes have
width profiles, dashes, caps, joins, alignment and arrowheads. Named graphic
styles are appearance stacks that live in the document, and a node can
reference one.

**Swatches keep their own space; paints keep the document's.** A swatch
(the document's, `doc/swatches.ts`, or one kept in the browser) stores a
colour value, `{ space, profile, c }` in RGB, CMYK, Gray or Lab, which no
change of mode touches. A paint holds its colour in the document's own
terms, so drawing never converts; a paint linked to a global or spot swatch
also keeps the swatch's id and a tint, and its colour is made again from
the swatch whenever the swatch or the document's space changes. Pixel tiles
are always in the document's mode.

### Selections

A selection is a coverage tile set plus, when it came from a path, the path
itself (`Doc.selection`). Changes to it are history steps, and it's saved
in the file. Alpha and spot channels are coverage sets of their own, kept
beside the layers (Channels, below).

**Coverage** (`tiles/coverage.ts`) is gray 8-bit tiles in the document's
grid: the gray value is how much a pixel is selected, no tile is nothing,
and a uniform tile is a whole tile at one value, so a selection costs only
the tiles along its edge. A tile that's partly transparent (a mask or Quick
Mask painted where there were no tiles) is that much its *outside* value:
v = gray · alpha + (1 − alpha) · outside, the same sum on the CPU and the GPU.
Everything done to coverage works tile by tile with the margin it needs,
in the engine worker, never on the whole image at once:

- **Shapes**: polygons filled by scanlines with four sub-rows a pixel and
  exact coverage across each row, even-odd, clipped to the canvas; ellipses
  as fine polygons. The marquee snaps to whole pixels.
- **Combining**: add is the larger, subtract min(a, 1 − b), intersect the
  smaller; Inverse is 1 − a over the canvas.
- **Feather** is a Gaussian (three box blurs) with sigma half the radius;
  **Expand** and **Contract** are separable max and min; **Select and Mask**
  is smooth (blur, then sharpen back to an edge), feather, then contrast
  and shift as one curve.
- **The Magic Wand** reads the canvas back as 8-bit document values (from a
  mip level past 64 MP) and flood-fills by scanline; tiles with nothing
  selected near them are skipped and full ones written as one value.
- **Through a selection**: filling and clearing a layer look each layer
  pixel up in the coverage through the layer's transform, a tile's window
  at a time. Apply Layer Mask is the same, through both transforms.
- **Transform Selection** and loading an alpha channel sample coverage
  bilinearly back through an affine (`transformCover`), tile by tile,
  tiles far from the moved outline filled without sampling. **Border** is
  Expand minus Contract; **Smooth** is Select and Mask's smoothing alone.
- **Work that reads the image** (`engine/selectImageHost.ts`) reads the
  canvas (or one layer) as 8-bit document values once per document state,
  from a mip level past 32 MP, and keeps the read while a drag calls again:
  - **Grow** and **Similar** take each channel's range over the selected
    pixels, widened by the wand's tolerance, and flood out from them (or
    take every pixel in range).
  - **Colour Range** gives each pixel a coverage from its distance to the
    sampled colours (full within half the fuzziness, nothing past it), or
    from its hue or lightness for the presets.
  - **Quick Selection** (`select/quickSelect.ts`) cuts a window round each
    stretch of the stroke: a graph over its pixels in Lab, eight
    neighbours each, links cheap to cut where the colour changes, tied to
    the stroke (and what's selected) on one side and the window's
    unselected rim on the other, colour histograms of each for the data
    term, cut by Boykov–Kolmogorov max-flow. A big window is cut small
    first, then again at full size in a band round that edge. The result
    is written back over the window (`pasteWindow`); the window's rim
    keeps its old values, so the seams don't show.
  - **The Magnetic Lasso's wire** (`select/liveWire.ts`) is Mortensen and
    Barrett's intelligent scissors: Sobel edge strength over the colours,
    non-maximum suppression in place of the Laplacian, gradient direction,
    computed lazily in 64-pixel blocks; Dijkstra from the last anchor
    within the Width of the line to the pointer, whose end snaps to the
    strongest edge near it. Anchors drop where the wire's start has held
    still over successive calls (`stableAnchor`).
  - **Select and Mask's edge** (`select/matte.ts`) is a band within the
    radius of where the coverage crosses a half (narrowed or widened by
    Smart Radius from the edge's width in the image) plus the refine
    brush's strokes; outside it what's surely in and out is the trimap.
    Each band pixel casts rays for the nearest known foreground and
    background colours, takes the pair that explains its colour best (and
    its neighbours' best), its alpha by projecting onto the line between
    them, leaning to wholly in or out unless a mix explains it clearly
    better; a guided filter then smooths it. Refined at most 4 MP at once,
    from a mip level beyond that.
- **Alpha channels** (`Doc.channels`) are coverage sets with a transform of
  their own, as masks have, so Crop and Canvas Size move them without
  touching their pixels; loading one samples it through its transform.

### Channels

- **Alpha and spot channels are coverage.** A `DocChannel` is a coverage
  set with a transform, plus how it shows: an alpha channel's tint (sRGB),
  its opacity and whether the tint marks what's masked or selected; a spot
  channel's ink (a colour value in its own space, as swatches keep theirs,
  named by the channel) and its solidity. A spot's coverage is how much
  ink, so a missing tile is no ink; PSD keeps it the other way round
  (black is ink) and is turned round on the way in and out.
- **What's shown and picked is view state** (`app/channels.ts`), per open
  document, not in the history or the file: the colour channels shown,
  the alpha and spot channels shown (spots by default, alphas not), and
  the target, some colour channels or one alpha or spot channel. Picking
  a layer targets the colour channels again; Quick Mask takes precedence.
- **The colour channels on screen** are the display pass's: the look
  (`color/lut.ts`) masks hidden channels, as Separations' inks are
  masked (RGB's lights at zero, CMYK's inks at none), and one channel alone
  is shown as its own value in gray, past the table. `displayRef` is held
  to it.
- **Alpha and spot channels on screen** are the screen pass's: each shown
  one's coverage at the level shown is rendered into the selection's atlas
  by the mask kernel (`renderCover`, keyed by channel), its tiles' slots
  after the selection's in `sel_tiles`, at most four at once. An alpha is
  its tint over what it marks; a spot multiplies its ink over the picture,
  then moves towards the ink by its solidity; with every colour channel
  hidden, the canvas is paper and the first alpha shows as gray.
- **Painting a channel** is painting a gray target, as Quick Mask paints
  the selection: strokes go to the engine on a node id of their own
  (`#channel:<id>`), resolved to the channel's set and transform, and
  drawn live through the coverage overlay; fills go through the same
  `select.fill` and `fill.paint` as a mask's, and commit to the channel in
  its own pixels. The Magic Wand and the Paint Bucket read a channel through
  `readCover8`, as the canvas shows it.
- **Painting some colour channels** keeps the others: the stroke kernel's
  `with_stroke` puts back the straight colour of each channel not
  targeted, and alpha (bits in the stroke parameters; `keepPlanes` in
  `ref/paint.ts` is its reference), so it's right live and baked; fills,
  Delete, content-aware fill and filters applied for good go through
  `fill.keepPlanes` (`tiles/planes.ts`), which builds new tiles only where
  the edit changed one.
- **Thumbnails and loading** (`engine/channelHost.ts`): colour channels
  from the composite at a small mip level, over white; alpha and spot
  channels from `readCover8`. A colour channel loads as the selection by
  its value (CMYK's by its ink's absence), the composite by its luminosity,
  from the full-size composite a band of tiles at a time.

### The clipboard

What's copied is a **fragment** (`doc/fragment.ts`): an ordinary `Doc` whose
root holds the copied layers with everything under them (children, masks,
effects), in the mode, depth and profile they came from, with the swatches
their paints link to and the text styles. Copied pixels are a fragment of
one pixel layer. Because it's a document, the machinery that already works
on documents works on it: `tileSetsOf` finds its pixels, which the page
keeps alive while it's on the clipboard; `convertDoc` and `tiles.convert`
bring it into another document's colours; and pasting is one pure edit,
`pasteFragment`, which gives every node a new id (compound shapes'
operations follow their shapes) and moves the layers by an offset. Duplicate
Layer is a fragment pasted straight back.

**Pixels under a selection** (`engine/clipHost.ts`) stay in their layer's
own grid where they can: a pixel layer's tiles are copied with each alpha
taken down by the selection's coverage through the layer's transform, so
a scaled or turned layer copies exactly and pastes still live, with its
transform. A tile wholly selected is shared, not copied. Shapes, text, smart
objects and groups are drawn first, on the document's grid, as Rasterize
draws them; Copy Merged draws the composite. A mask copies its gray as a
Gray fragment.

**The system clipboard** gets, while the key press or click still allows
it, a `ClipboardItem` whose PNG is still being drawn (a promise the engine
fulfils): the copy as sRGB PNG, the same in HTML, a text layer's words or a
path's SVG as plain text, and in the HTML a `<meta name="plexel-clip">`
marker naming the copy and this page. A paste that finds its own marker
pastes the fragment, live; one that finds another's (another tab), or none,
takes what's there as an image, SVG or text. Ctrl+V pastes from the
browser's paste event, which carries the clipboard without asking
permission, so the keydown handler leaves Ctrl+V (and Ctrl+Shift+V) to the
browser; the menus read with `navigator.clipboard.read()`, which asks once.
Chrome keeps the marker through the round trip (checked before building,
and in `check:clipboard`).

### Masks

A mask is a node in its layer's `masks`, with its own transform (carried
with the layer by every move), its coverage tiles in its own grid, an
*outside* value for where it has none (1 reveals, 0 hides, so a new Reveal
All mask costs nothing), and live density, feather and invert. A disabled
mask is one whose `visible` is off. Masks made from the selection share its
tiles.

## Colour

- **The engine** is LittleCMS 2 (MIT), compiled to WebAssembly from a pinned
  release (2.19.1) by `scripts/build-cms.mjs`, behind our own small C API
  (`native/pxcms`). It runs on the page (for the Colour panel), in workers
  and in Node. Nothing outside `src/color/` touches it.
- **Profiles.** Built-in profiles are made from their published
  definitions (sRGB, Display P3, Adobe RGB and ProPhoto compatibles, Rec.
  2020, Gray Gamma 2.2 and 1.8), so none is a third-party file. CMYK has a
  Generic CMYK ink model, exactly invertible, named as not a press profile.
  Loaded and embedded profiles are content-addressed assets. Measured press
  profiles (FOGRA, GRACoL) wait on a licence decision.
- **Display.** The canvas shows the document through a LUT built by lcms2
  (in the engine worker) from the document profile to the display profile:
  a 3D table for RGB and Lab, a 1D one for Gray, and a stack of 3D slices
  across K for CMYK (a 4D LUT). On the GPU each is a storage buffer laid out
  exactly as on the CPU and read with the same tetrahedral interpolation by
  hand, so the GPU matches `sampleLut` to 10⁻⁷ (`check:gpu`); a 3D
  texture's own filtering would be trilinear, a different answer. Browsers
  don't expose the monitor's ICC profile, so the user picks one, with
  Display P3 the default when `(color-gamut: p3)` matches. The WebGPU canvas
  is configured in the matching colour space. Table sizes are measured in
  `check:color`: 33³ for RGB, 1024 for Gray, and for CMYK 33 K slices of
  17³, since CMYK's error lives along K.
- **Soft-proofing** (built in phase 10) chains document → proof condition →
  display into the same table (`buildLookLut`): the document converted to
  the proof's device values with the proof's intent and black-point
  setting, clipped to the device, then shown relative colorimetric (the
  display's white), without black-point compensation (the ink's black), or
  absolute (the paper's white). A document proofed on its own profile skips
  the first step. The proof condition is view state per open document
  (`color/proof.ts`, `app/proofing.ts`), sent to the engine as the view is;
  only the canvas is proofed, never thumbnails or files.
- **The gamut warning** is the same table's alpha: 0 where the condition
  can't reproduce a grid point, interpolated like the colour, and marked
  past half in the alarm colour. Separations (inks hidden) and the total
  ink limit are a mask and a sum in the display pass. `displayRef` is the
  reference `check:gpu` holds the pass to.
- **Converting** a document (Convert to Profile, Document → Mode, 8 and 16
  bits) converts its tile sets in the engine (`engine/convertHost.ts`,
  `tiles/convert.ts`) and every other colour it holds on the page
  (`doc/convert.ts`), then commits both as one step. Pixels go through the
  conversion sampled on a grid and interpolated tetrahedrally
  (`color/convertLut.ts`: 33³ for RGB, 17³ × 65 K slices for CMYK, 4096
  points for Gray, RGB and Gray outputs stored roughly linear), as
  LittleCMS's optimised transforms do; its float transforms per pixel took
  four times as long in WebAssembly (54 s against 13 s for the bench's
  96 MP). Curves and Levels keep only their
  master channel across a mode change. Linked paints are made again from
  their swatches.
- **Colour adjustments on CMYK** go through the document's profile
  (`color/cmykAdjust.ts`): to Adobe RGB compatible by a forward table
  (17³ × 33), adjusted, and back with K held by an inverse table solved on
  the forward one with Newton's method (17³ × 17), applied as a change so
  an identity adjustment is exact. Tone tables still work on each ink.
- **Rendering intents and black-point compensation** apply to mode changes,
  conversions, placed content, proofing and exports, as lcms2 provides
  them; Colour Settings holds the defaults and the working spaces.
- **Pickers** show RGB, HSB/HSV, Lab, CMYK and Gray sliders for any colour,
  converted through the document profile. The model doesn't depend on them.
  The Colour panel arrived in phase 3, with the engine, rather than with
  painting.
- **Gamut** is judged by a round trip under the conversion's own intent and
  black-point setting, in ΔE2000, with 2 as the line.

## Tiles and memory

- **Tiles are 256 × 256.** A tile set maps tile coordinates to tiles. A
  missing tile is transparent, and a *uniform* tile is stored as one value,
  so a filled background costs bytes, not megabytes.
- **Channels are planar.** Each tile holds one plane per channel: RGB+A is 4,
  Gray+A is 2, CMYK+A is 5 (alpha and spot channels are sets of their own,
  gray coverage). On the GPU the
  planes are packed into textures of up to four channels: CMYK+A is two.
- **Alpha is straight**, not premultiplied, as PSD keeps it. The GPU
  premultiplies when it composites.
- **Depth.** 8-bit planes are `Uint8`. 16-bit planes are `Uint16` on the CPU
  and `rgba16uint` (or `r16uint`) on the GPU, decoded and filtered in the
  shader. Compositing happens in floats, in storage buffers (see the render
  graph): f16 for 8-bit documents where the device has `shader-f16`, f32
  for 16-bit ones. Decided by measurement in phase 4 and recorded in
  PERFORMANCE.md: f16 is within a fifth of an 8-bit step at half the
  memory, and would lose more than five bits of a 16-bit document.
- **Copy-on-write.** Tiles are immutable and reference-counted. Changing a
  tile makes a new one. A tile set is reachable from the current doc, from
  history or from the autosave journal. Anything else is collected.
- **Memory.** CPU tiles live in SharedArrayBuffer slabs of about 8 MB. The
  budget is a quarter of the memory the browser reports (1 GB when it won't
  say); past it, the least recently used tiles spill to an OPFS folder of
  the worker's own, held by a Web Lock so another tab never clears it, and
  come back on demand. History is capped at a hundred steps, and at 1 GB of
  tiles only older steps hold.
- **GPU residency.** Tiles in view are uploaded into a texture-array atlas,
  one per tile format, growing by doubling to a budget and then evicting the
  least recently used. Base tiles are keyed by tile id, so sets derived from
  one another share uploads. Each tile set has a mip pyramid for zoomed-out
  views, built lazily on the GPU from the four tiles below and keyed by a
  hash of what's under them, so sets that share tiles share mips, and after
  a brush stroke only the mips above the changed tiles are rebuilt. Mips are
  never invalidated, only evicted.
  Uniform and empty tiles are known from the store's bookkeeping and never
  uploaded, at any level. An upload writes the tile's planar samples, as
  the store holds them, into a frame's upload ring, and a render pass packs
  them into the atlas layer (shaders/upload.ts); a frame whose ring is full
  stops and goes on next frame, and work outside the frames (thumbnails,
  exports) interleaves on the CPU instead.
- **Reading on demand.** A tile can stay in the file it came from (a big
  `.pxll`'s stored pack) until it's first needed; past the memory budget it's
  dropped rather than spilled, since the file still has it. Before that file
  is overwritten, its remaining tiles are read in.
- **Coordinates** are doubles in document space on the CPU. Shaders get
  float32 coordinates relative to the tile or viewport origin, so precision
  holds at the far corner of a huge canvas.

## The render graph

Rendering is a graph of requests: *give me this tile of this node at this
mip level.*

- **The scene.** The worker keeps a mirror of each open document
  (`render/scene.ts`): the page sends only the nodes that are new objects
  since last time, each with a version. From those the scene knows every
  node's bounds, a content version for every subtree, and, for each update,
  the regions that now draw differently: a changed node's old and new
  bounds, only the children that moved in a reordered list, clipped by
  their ancestors.
- **Composite tiles are storage buffers**, 256 × 256 pixels of premultiplied
  floats in the working space: the colour channels (CMYK as light, 1 − ink)
  then alpha. Not textures: CMYK's five channels fit no texture format, and
  the blend modes read the backdrop where they write, which a storage buffer
  allows in one pass. One compute kernel lays a source onto a tile with an
  operation (over, atop for clipping, lerp for a faded pass-through group,
  knock for knockout) and a blend mode; the source is a pixel layer sampled
  through its transform, or another composite buffer.
- Each kind that draws content registers an **evaluator** (`render/
  graph.ts`): it lays the node's own content onto a tile with an operation,
  a blend mode and an alpha scale. Bounds come from the scene. Kinds without
  one draw nothing yet, and nor do their clipped children. Adjustments and
  filters arrive as evaluators that change the backdrop (phase 7); a
  `needs(region)` that widens the input for a blur arrives with them.
- **Masks** are evaluated per composite tile and multiplied into the alpha
  scale wherever a node is laid on (over, atop, the pass-through lerp, a
  knockout group's result), through the kernel's mask input. A mask kernel
  (`shaders/mask.ts`) samples the mask's gray tiles through its transform
  with the pixel source's window tables, atlases and mips (`outside` where
  it has no tiles), blurs a margin round the tile for the feather, then
  inverts and thins by density; a node's masks multiply. A mask that's one
  value across the tile is a number, with no buffer. Cached isolated results
  don't include the node's own mask, so a mask edit never re-renders
  what's under it; mask versions are part of the node's content version.
- **Groups, clipping and knockout** are the graph's own rules, the same for
  every kind: pass-through groups lay their children straight onto the
  backdrop (faded back by lerp below 100%); other groups and every clip base
  are isolated, composited over transparency and laid on with their mode;
  knockout groups lay each child over the knockout backdrop.
- **Caching.** Isolated results are cached per node, mip level and tile,
  keyed by the subtree's content version, so editing a layer above a group
  doesn't redraw the group. Finished display tiles are kept per document,
  level and tile; an edit marks the ones its dirty regions touch as stale
  rather than dropping them, so the old picture stays up until the new one
  is ready.
- **Scheduling.** Each frame takes the tiles the view needs at the level
  that suits the zoom (`render/view.ts`), nearest the centre first, after a
  quick whole picture two levels coarser where that's missing, within a
  time budget. The screen pass draws from whatever is ready, falling back
  to coarser levels per pixel. Nothing blocks a frame: a tile whose pixels
  are still coming back from disk is skipped and the frame asked for again
  when they arrive. Two frames may be in flight on the GPU.
- **Precision.** Every transform the GPU sees maps a tile's own pixels to a
  window of the source, computed in doubles on the CPU, so float32 stays
  exact at the far corner of a 300,000-pixel document.
- **Blending** follows Photoshop's semantics, so PSD files composite the
  same: the full list of blend modes, fill opacity separate from opacity,
  knockout and pass-through groups, and CMYK blending done the way Photoshop
  does it. By default blending happens in the document's encoded space, as
  Photoshop does. A per-document option blends in linear light.
- **Vectors are rasterized on the GPU** by our own WGSL kernel, with the
  analytic coverage Vello and font rasterizers use: each pixel's coverage is
  the integral of the winding number over it, summed exactly from the line
  segments crossing its row, and the fill rule turns that into coverage.
  Curves are flattened on the CPU in the worker, to a tenth of a pixel at
  the level drawn. Rather than Vello's sparse strips, each tile gets the
  segments crossing it, with whatever lies left of it summed into one
  backdrop number a row, and the kernel reads them 16 rows (a workgroup)
  at a time. It measured fast enough (PERFORMANCE.md); sparse strips stay
  the option if text or very dense art says otherwise. Edges stay exact at
  any zoom, and nothing goes through a pixel intermediate at a fixed
  resolution.
- **Paint servers** turn coverage into colour: solid, linear, radial,
  angular, reflected and diamond gradients, patterns (formulas and
  images), gradients along and across a stroke, freeform gradients and
  gradient meshes, in one kernel. The last three read a *field* cut to the
  tile from the binding images use (see "Fills, gradients and patterns").
- **Final output.** Each finished composite tile goes through the display
  LUT into a display atlas (RGBA f16). The screen pass draws the
  pasteboard, the checkerboard and the display tiles through the view
  transform, nearest-neighbour when magnified and bilinear across tile edges
  otherwise.
- **Adjustments, live filters, layer effects and smart objects** are
  covered in their own section below.
- **Overlays.** The selection's coverage at the level shown is rendered per
  tile into its own atlas (r32float) through the mask kernel, so a Quick
  Mask stroke shows as it's painted. The screen shader draws marching ants
  where coverage crosses a half between neighbouring screen pixels, dashed
  and crawling, or in Quick Mask a red tint by what isn't selected, and a
  crop's shade. Alpha and spot channels shown are drawn under that, from
  the same atlas (Channels, above). Lines and handles from the tools (`render/overlay.ts`) are
  cut into triangles on the CPU each frame, through the frame's own view,
  and drawn in the same pass.

## Adjustments, filters and layer effects

Three registries, each entry listing its parameters once (`doc/params.ts`):
that list reads them back from a file with defaults and limits, feeds the
CPU reference, and generates the controls in Properties and the dialogs.
Nodes keep parameters as plain JSON, made whole whenever they're used, so a
file from a newer build with settings this one doesn't know still works.

- **Adjustments** (`adjust/defs.ts`) compile their settings into a
  program: a per-channel tone table, or one of seven colour operations with
  its numbers worked out on the CPU. The GPU kernel and `runProgram` run the
  same programs. An adjustment layer copies what's under it, runs its
  program on the copy, and lays it back with the `tint` operation: the
  backdrop's colour moves towards its blend with the copy by opacity times
  mask, and its alpha stays. Clipped, it tints only its base; in a node's
  effects, it runs on that node's content. Tone tables on CMYK work on ink;
  colour operations on the colour through the document's profile, black
  kept (see Colour).
- **Live filters** (`filters/defs.ts`) live in a node's `effects`, run in
  order on its content. Each says how far it reads (its reach, scaled by
  the mip level). The graph gathers the node's content tiles round the
  tile being drawn into an f32 region that wide, runs each effect on it,
  and crops the middle. Content tiles are cached apart from the effects,
  keyed by the node's own version, so a filter's settings change without
  the layer being drawn again. Blurs are box passes with a running sum (a
  Gaussian is three each way), so their cost doesn't grow with the radius.
  Reach is capped at 512 pixels at the level drawn. Applying filters for
  good runs the same graph on a scene holding just the layer, in its own
  pixels, and mixes the result with the old pixels by the selection.
- **Layer effects** (`fx/defs.ts`, `fx/ref.ts`) work from the node's body:
  its content with its effects, times its masks, gathered round the tile.
  From the body's alpha come planes (hardened, blurred, or jump-flooded
  into distances for strokes); each effect makes a layer of colour and
  coverage. Shadows and glows go straight onto what's below, each in its
  own blend mode, at the node's opacity; the content goes into the node's
  own buffer at its fill, the effects that sit on it over that, then the
  layers clipped to it, then its stroke; and that is laid on in the node's
  blend mode at its opacity. With the special eight modes, fill fades the
  whole lay-on instead.
- **Smart objects** are embedded nodes whose `content` is a whole document.
  The renderer keeps a scene for each, made when it's first drawn and again
  when the contents change; the graph renders its tiles at the mip level
  the view needs into the tile atlas (a store pass, as the mip pass does)
  and draws the node through the pixel layer's own sampling code, so a
  smart object is resampled, filtered, styled and masked like any layer.
  Tiles past the contents' canvas are left transparent. Edit Contents opens
  the contents as a document linked to the node; Save commits them back.

## Vectors

A `vector` node holds its geometry and its appearance stack
(`doc/vector.ts`); a `boolean` node (a compound shape) holds its operands as
children, each with its operation, and an appearance of its own.

- **Geometry** is a path (subpaths of anchors with absolute handles, a fill
  rule) or a live shape's parameters, in the node's own coordinates; its
  transform places it, so moving, scaling and turning a shape is the same
  live transform every layer has. A stroke scales with it.
- **The appearance stack** is a list of fills and strokes, drawn bottom
  first, each with a paint, opacity, blend mode and (strokes) width,
  alignment, joins, caps, miter limit and dashes. Colours are kept in the
  document's terms, as every colour parameter is, and made the right shape
  for its mode when drawn.
- **Drawing** (`vector/outline.ts`, the vector evaluator in the render
  graph): once per node, mip level and version, each item becomes segments
  in that level's pixels: a fill is the path flattened; a stroke is its
  outline (made in the shape's own coordinates, so it turns with it), and
  an inside or outside stroke is one twice as wide kept where the fill is
  or isn't. The first time a tile asks, the segments are sorted into bands
  of tile rows in one pass, and a band by tile column when a tile in it
  first asks, with the backdrop of everything wholly left of each column
  summed once (`segmentGrid` in `geom/raster.ts`), so a tile reads only the
  segments crossing it. Per tile, each item's coverage is rasterized, times its
  paint (`shaders/vector.ts`), and the items laid on one another in their
  blend modes; the result is laid on like any layer, so shapes take masks,
  filters, layer styles and clipping without anything of their own.
- **Effects per fill and stroke** (`vector/itemEffects.ts`): an item's
  `effects`, in order. Path effects change the path the item is outlined
  from, in the shape's coordinates, before filling or stroking
  (`vectorOutline` keeps the shape's own geometry for items without):
  Transform with copies, Offset Path (the path with a stroke `2|d|` wide
  added or taken away by the booleans, so the result is a path, which the
  Offset Path command uses too), Roughen, Pucker & Bloat, Zig Zag and
  Warp. Pixel effects are live filters run on what the item paints: the
  item is painted on its own per tile (`itemTile`, cached), gathered round
  the tile by `runEffects` as a layer's effects are, and laid on with the
  item's opacity and blend. Bounds take both in (`vectorBounds`).
- **Graphic styles** (`doc/graphicStyles.ts`) are named appearance stacks in
  `Doc.graphicStyles`. Applying one copies its appearance into the node and
  links it (`graphicStyle`); redefining rewrites every linked node's
  appearance; `setAppearance` unlinks. What's drawn is always the node's
  own appearance, so a style missing or deleted changes nothing on the
  canvas. Fragments carry the styles their shapes link to.
- **Compound shapes** are worked out in document pixels from their visible
  operands (`vector/shape.ts`), cached by the subtree's content version.
  Moving or transforming the compound carries its operands; its own
  transform stays the identity. The page works out the same path for hit
  tests, the outline on the canvas and Expand.
- **Vector masks** are mask nodes with `source: 'vector'` and a geometry:
  their coverage is rasterized into the mask kernel's wide buffer, then
  blurred, inverted and thinned by the same passes as a pixel mask. One
  pixel mask and one vector mask per layer, as in Photoshop; the mask
  target says which the tools edit.
- **Tools** (`app/vectors.ts`): the Pen is a session (each press adds an
  anchor; Enter, closing or a tool change commits), Direct Selection and
  the Shape tool are gestures; all preview by sending an uncommitted
  document to the engine and commit once. They edit the target: the
  selected shape's path, or its vector mask. Editing a live shape's anchors
  converts it to a path. The outline, anchors and handles are the overlay's,
  in the accent colour; smooth points round, corners square.
- **Points across shapes.** The selected anchors are kept per node
  (`AnchorSelection`, by id): Direct Selection hit-tests every selected
  shape (the key layer's first), its box reaches every visible, unlocked
  shape and selects those layers, and a drag moves each shape's points in
  its own coordinates (the document's move through the inverse of its
  transform's linear part), committed as one step; Delete, Join and Break
  work across them. A vector mask being edited is edited alone.
- **The curvature rule** (`geom/edit.ts` `curvatureAnchor`, `recurve`): a
  smooth point's handles lie along the line between its neighbours, a third
  of the way to each; an open end's turns towards where the curve through
  its neighbour heads (the neighbour's tangent mirrored across the chord).
  The Curvature tool applies it to the points round the one it changed; the
  Pen's Smart mode to the points it placed by a click, keeping handles
  pulled out by hand. One drawing session serves the Pen, Smart and the
  Curvature tool.
- **Joining and breaking** are pure functions too (`breakAt`,
  `joinSubpaths`, `closeSubpath`, `separate`); joining two shapes moves
  the second's subpath into the first's coordinates.
- **The Width tool** (`app/widthTool.ts`) edits the profile of a shape's
  topmost stroke, nothing else: its arithmetic is `geom/width.ts` (adding a
  point as wide as the stroke is there, setting, sliding between
  neighbours, deleting, flipping; a profile all at full width becomes none;
  a closed path's points at 0 and 1 kept as one). It measures each subpath
  as the stroke does (flattened, its length, the closing side included) to
  find where a press is (a share of the length) and which side (towards
  the normal (−dy, dx), the outline's left), in the shape's own units, so
  a transformed shape is no different. Drags preview through the engine
  and commit one step through `setAppearance`; the overlay is drawn only
  while it's still the tool's (the overlay's version), so switching tools
  can't wipe another tool's. Saved profiles are `app/widthProfiles.ts`,
  kept by the browser like the tools' settings.
- **Vector brushes** (`doc/vectorBrush.ts` the model, `vector/brush.ts` the
  drawing): a stroke item can hold a brush, a copy of the library's
  (`Doc.vectorBrushes`, or a built-in one from `vector/brushLibrary.ts`),
  so a stroke draws the same anywhere it's pasted; editing a brush can
  re-copy it into every stroke with its id (`restrokeWith`). Artwork is
  filled parts, each its own paint, x along the path, y across. Each line
  of the flattened path becomes a **rail**: distances along it and a
  normal at each point averaged from its segments (lengthened by 1/cos of
  half the turn, at most twice), interpolated along each segment, so art
  bends round a flattened curve rather than kinking. Art at (x, y) goes to
  (s(x), y·k·profile) on the rail, each loop carried through by
  `warpLines` (the envelope code), cut until it follows; scatter copies and
  corner tiles are only moved, turned and scaled. Colorization (tints,
  tints and shades, hue shift) recolours parts in the document's mode. The
  result is one `ItemOutline` with `parts`: the graph (and its CPU
  reference) paints the parts over one another into one buffer, which is
  then laid on with the stroke's opacity, blend and effects, as a plain
  stroke is. A proportional art brush is as wide as the path is long, so
  bounds pass the longest line to `appearanceReach`. SVG and PDF get the
  parts as filled paths (`brushAsPaths`); Outline Stroke makes them shapes
  in a group.

### The filter and adjustment pack

- **Filters** are entries in `FILTER_DEFS` with a category (the Filter
  menu's submenus), each a CPU reference and a GPU path in the render
  graph, mostly new entries in `shaders/filter.ts`: Lens Blur (a disc of up
  to 256 taps on a golden-angle spiral, highlights weighted up), Surface
  Blur (a disc, every pixel up to 17 a side, weighed by colour), Smart
  Sharpen (Unsharp Mask's sums over a Gaussian, lens or motion blur), the
  Stylize four in one kernel, Mosaic on the document's grid, Dust &
  Scratches (Median, kept where it differs little), Minimum and Maximum
  (separable), Clouds (five octaves of value noise from the same hash as
  Add Noise). Parameters gained `f2` and `f3` for colours and a light.
- **Distortions** are geometric effects (see Warps): Twirl, Pinch,
  Spherize, ZigZag and Polar Coordinates are maps on a frame, the unit
  square of the content's box when they were added (`geom/distort.ts`);
  Wave and Ripple move points directly; Displace reads a document pattern,
  through the warp's `env`. A warp says how fine its detail is, so its grid
  is fine enough (down to a pixel), and whether it has seams (Polar's),
  where the kernel reads a cell's nearest point rather than between.
- **Adjustments that are any function of the colour** (Selective Colour,
  Photo Filter, Colour Lookup, Colour Grading, Hue/Saturation with a range)
  compile to a colour cube: the function at 17³ (33³ for Hue/Saturation's
  ranges; a `.cube` file's own size) points, read trilinearly by
  `runProgram` and the kernel alike (op `cube`). Big tables are kept on the
  GPU per program rather than uploaded per tile.
- **Parameters** gained kinds: `pattern` (one of the document's), `file`
  (data loaded from a file, kept in the document: a `.cube` table as 16-bit
  base 64), `wheel` (a hue and an amount), and `when`, which shows a control
  only for some settings (a range's sliders).
- **An effect's blend mode**: a live filter not in Normal is laid over its
  input in its mode at its opacity (the effects kernel's `over`), as
  Photoshop's smart filters' blending options.
- **Filter layers**: a filter node among the layers (its role is now
  layer-or-effect) filters everything below it in its context, the nearest
  isolated group or the document: the context's children up to it are
  drawn per tile (`belowTile`, cached by the context's version, the draw
  stopping at the layer), gathered round the tile, filtered, and laid back
  over what's there with `lerp` at its opacity and through its masks. Its
  bounds are everywhere, and a change below it spreads by its reach
  (`Scene.filterLayerReach`). Geometric filters aren't filter layers. SVG
  and PDF flatten what's below one, as for an adjustment.

## Warps

Free Transform's Distort, Perspective and Warp, and Liquify, are
**geometric effects**: filters in a node's `effects` whose `FilterDef.warp`
gives a map in the node's own coordinates (`filters/defs.ts`, the maths in
`geom/warp.ts`). Each says, for a point drawn, where it's read from
(`inverse`, homogeneous), where a rectangle can be drawn (`bounds`), and,
when it can, where a point goes (`forward`).

- **Warp** (Free Transform's) is a frame (the affine from the unit square
  to the box it was made on), a mesh of bicubic Bézier patches over the
  square (a style's, fitted through the style's shape at a 4 × 4 lattice,
  or Custom), and the box's corners after it (a homography: perspective and
  distort). Past the square a mesh carries on straight along its edges'
  slopes, so it has an inverse everywhere without curling back. The
  inverse is Newton's method from the last answer, or the nearest of a
  lattice, preferring an answer in the square. A Free Transform session
  works in that unit square: an affine change goes into the transform as it
  always did, the rest into the effect, first in the list.
- **Liquify** is a field of displacements on a grid over the content's box
  and a quarter as much again (at most 320 points a side, kept in the file
  as 16-bit eighths of a pixel in base 64): a backward map, each point read
  from itself plus the field there. Each brush dab works out, for the
  points it covers, where they should now be read from, and composes that
  with what was there.
- **Drawing** (`graph.ts warpTile`): the inverse is worked out in doubles at
  a grid over the tile (8 pixels apart, or as fine as a Liquify field's
  spacing, to 2), through the node's transform, as homogeneous coordinates,
  so a perspective interpolates exactly. Points with nothing to read (past a
  fold) are carried on from their neighbours, so cells along the content's
  edge keep their edge. What the grid reads is gathered into a region of
  the content (with the effects before the warp) at a level chosen by how
  much the cells reading the content are squeezed, as a mip would be; the
  kernel (`shaders/warp.ts`) interpolates and reads bilinearly. In a tiled
  document each copy of the warped node is drawn, so the warped layer is
  what repeats.
- **Shapes and text** whose paints are flat colours, with warps that map
  forwards first in their effects, are warped as outlines: the fill's lines
  and the strokes' outlines carried through the map, each piece cut until
  its middle and quarters land within a tenth of a pixel
  (`geom/warp.ts warpLines`). Those warps are then not run as pixels.
- **Bounds** come from the map: the scene carries a node's rectangle through
  its warps, in order, with the reach of the filters before each, and a
  stroke on a warped layer redraws wherever the layer is drawn.
- **Rasterize** makes a node's coordinates the document's; its warps are
  carried by the old transform (`rebaseWarps`), which is why a warp keeps a
  frame rather than a box.
- **Photoshop**: a placed layer's corners (`Trnf`) and `warp` descriptor,
  and text's warp, are the Warp effect over the contents' rectangle, in
  and out (`io/psd/warp.ts`).

## Fills, gradients and patterns

- **Fill layers** (`fill` nodes) draw their paint over every tile with full
  coverage: the vector paint kernel with a flag that skips the coverage
  buffer, then laid on like any layer, so masks, clipping, effects and
  blend modes work as for anything else. Their bounds are everywhere, as an
  adjustment's are; Rasterize, the clipboard and Free Transform take the
  canvas as their box. A gradient without a line of its own lies across the
  canvas, in the layer's own coordinates, so it moves with the layer.
  PSD, SVG and PDF get each fill layer as a rectangle over the canvas with
  the same paint (`fillsAsShapes`); Photoshop's fill layers without a
  vector mask open as fill layers.
- **Gradients** are laid across the shape's box by angle and scale, as
  Photoshop's Gradient Overlay is, or along a line (`Paint.line`, start and
  end in the node's own coordinates) as the Gradient tool drags them:
  linear and reflected from 0 at the start to 1 at the end, radial,
  angular and diamond centred on the start and turned to the line. One
  matrix per paint maps a tile pixel to gradient space; the kernel and
  `vector/paint.ts` do the same sums.
- **Gradients along or across a stroke** (`Paint.stroke`) take their
  position from the stroke's centre line: the outline builder keeps the
  path flattened in the shape's coordinates (`StrokeCentre`: each segment's
  ends, how far along its subpath they are, the width each side from the
  profile, and which side shows for an inside or outside stroke, found by
  asking the fill). Per tile, the segments within the stroke's reach go to
  the kernel; each pixel takes its nearest segment: along is the distance
  along the subpath over its length, across the signed distance (its
  magnitude, so a corner's outside runs on smoothly) between the two
  edges.
- **Freeform gradients** blend colour points by inverse distance,
  (spread² / d²)^1.5 each, premultiplied. **Gradient meshes** are grids of
  points with colours, patches with straight sides: a pixel is found in its
  patch by inverting the bilinear map (the root nearer the patch), and its
  colour is a Catmull–Rom spline through the points' colours over the grid,
  smooth across patch edges; past the mesh's edge the nearest patch's
  colour carries on. Per tile the field holds the patches that meet it and
  those round the mesh's edge. `vector/mesh.ts` has the arithmetic (and the
  edits: splitting a mesh through a point so it looks the same, making it
  again finer or coarser); check:gpu holds the kernel to it.
- **Editing on the canvas** (`app/gradientEdit.ts`): the Gradient tool and
  the Mesh tool draw the selected layer's gradient as overlay shapes (the
  line, its stops beside it, freeform points, the mesh's grid) and turn a
  press on them into a drag that previews through the engine and commits
  one step. Which paint is edited is the item open in Properties
  (`paintFocus`) when it can be, else the top fill, else the top stroke.
- **Files**: SVG, PDF and EPS have no freeform gradients, meshes or
  stroke gradients that match, so a shape with one goes as an image of
  itself (`io/flat.ts`), as angular and diamond gradients already do; PSD
  keeps them in the layer's pixels, with a warning.
- **Patterns made from pixels** (`Doc.patterns`) are tile sets in the
  document's mode and depth, one repeat at the origin, at most 1,024
  pixels a side, saved, converted and collected like pixel layers. A paint
  names a pattern by id: a built-in formula's, or a document pattern's.
  For drawing, the repeat is read into the working space, premultiplied,
  and a pyramid made of it (each level half the last, rounded, every pixel
  the area-weighted average of what it covers, wrapping round), sampled
  bilinearly with wrap-around between the two levels nearest the
  footprint. On the GPU the pyramid is one storage buffer per pattern (a
  header of the levels' sizes and offsets, then the pixels), built the
  first time a tile needs it (the tile waits, NotReady, while it's read)
  and kept by tile set, which never changes; a document's patterns
  changing redraws it all.
- **Patterns from artwork** (`DocPattern.art`, `doc/patterns.ts`) keep
  their tile as a document of its own, as a symbol's contents, and a
  layout (`PatternTile`: grid, brick by row or column with an offset of
  ½ to ⅕, hex by column or row; spacing). The pattern's `tiles` are still
  one repeat, so every consumer is unchanged: `repeatOf` says where each
  copy of the tile lies in a repeat (a brick row offset by 1/n makes the
  repeat n rows high; hexagons' columns are ¾ of a tile apart), and the
  engine's `fill.repeat` lays the tile's pixels there, wrapping, later
  over earlier. Saved, read (`readPatternTile`), collected, converted
  (`pixelSets` and `convertDocColours` go into the artwork, and now into
  symbols' contents too) and copied with the pattern.
- **Pattern editing mode** (`app/patternEdit.ts`) opens the tile in a tab
  (`OpenDoc.patternOf`), a tiled document along the axes where the layout
  repeats a tile exactly (`editTiling`), so the tab's copies and seamless
  painting are Tiled View's. A moment after each change in the tab, its
  merged pixels (`clip.pixels`) are laid out by `fill.repeat` and the
  pattern takes the repeat and the artwork in one coalesced step in its
  document; a change there (an undo) comes back into the tab. Cancel puts
  back the pattern the tab opened with. Make Pattern copies the selected
  layers (`patternContent`, their exact pixel bounds) and opens a tab for a
  pattern that exists in the document from its first repeat; a pattern
  from pixels opens as one pixel layer (`pixelContent`) and gains artwork
  only when something's drawn.
- **Pattern Overlay** with a document pattern (`image`, `imageScale`)
  samples the pattern's pyramid on the GPU as the paint kernel does, the
  pyramid's buffer bound where gradient stops go (`pattern_image` over
  `stops`, layer kind 11); fx/ref.ts does the same sums with
  `patternSample`.
- **Filling pixels** (`tiles/fill.ts`): a paint or an image laid on a
  layer's tiles through coverage, each layer pixel looked up through the
  layer's transform, composited by the reference's `over` (or `atop`, for
  Preserve Transparency) in any blend mode at an opacity; Normal at full
  strength takes a short way round. Edit → Fill, the Gradient tool set to
  pixels and the Paint Bucket (the wand's coverage intersected with the
  selection) all go through it. Untouched tiles are shared.
- **Content-aware fill** (`retouch/inpaint.ts`) is multi-scale PatchMatch
  completion: a pyramid down to where the hole is a few pixels across,
  filled from its rim at the coarsest level; at each level rounds of
  PatchMatch (propagation and random search, from patches touching the
  hole to patches wholly outside it) and Wexler's distance-weighted
  voting; the field carried up a level at a time. It runs on the
  selection's bounds and as much again round them (at most 3,072 pixels a
  side) in a worker of its own, so the canvas keeps drawing; the result
  goes on through the fill above, so blend modes and opacity apply.

## Geometry

Built in phase 8, all pure and checked in Node (`check:geom`):

- **Paths** are cubic béziers, with open and closed subpaths and a fill
  rule. Bounds are exact (from the curves' extremes); flattening uses Wang's
  formula for the number of lines a curve needs within a tolerance.
- **Live shapes**: rectangles with round, chamfered and set-in corners,
  ellipses, polygons, stars and lines store their parameters and generate
  their path when needed. Arrows, spirals and a corner widget on any path
  come later.
- **Booleans** are our own, curve-preserving: monotone pieces, intersections
  by subdivision refined with Newton's method, and each edge kept or dropped
  by the winding numbers either side of it, the approach paper.js uses, so
  Expand produces curves, not polygons. A fuzz check builds random shapes
  and compares inside-ness and area against a sampled reference.
- **Stroking** generates the outline as geometry, with joins, caps and
  dashes, from the path flattened for the scale it's drawn at: offsets of
  the flattened polyline, meeting where they cross on a gentle turn (so the
  outline doesn't overlap itself there and its edge's anti-aliasing stays
  exact). The renderer fills that outline, so "Outline Stroke" is the same
  code with its result kept. Each point of a line carries its distance
  along the subpath and a half-width either side: a **width profile**
  (width points along the subpath, eased between) sets them, the side
  offsets, joins and caps take them, and straight runs are cut finer so a
  taper is smooth. **Arrowheads** are loops added at an open line's ends,
  pointing along the line a head's length back, the line trimmed under a
  filled head. **Dashes aligned to corners** cut the line at the corners
  `flattenPath` marks (anchors whose two sides don't continue each other)
  and fit a whole number of repeats to each run, half a dash either side of
  a corner. SVG and PDF get such a stroke as its outline, filled
  (`strokeAsPath`); PSD keeps it plain and says so. **Scale Strokes** off
  makes Free Transform divide the strokes' widths and dashes by the
  transform's scale (the root of its determinant).
- **Regions** (`geom/regions.ts`): every area shapes' outlines cut the
  plane into, with the shapes it's inside, by the booleans: the shapes
  added one at a time, each region so far cut into what's in the new shape
  and what isn't, and the new shape's own part; then each split into its
  connected pieces (outlines with their holes). Pathfinder's Divide, the
  Shape Builder and Live Paint are built on it.
- **Offset Path** is the path with its stroke `2|d|` wide added (or taken
  away) by the booleans, so the result is curves; **Outline Stroke** is the
  stroke's outline tidied by them. **Simplify** is Schneider's curve
  fitting (sampled, cut at corners, each stretch fitted with as few cubics
  as stay within the tolerance, splitting where the fit is worst);
  **Smooth** Catmull–Rom handles; **Join** the nearest open ends.
- **Live Paint** is a compound shape with `live`: fills, each a point (in
  the group's coordinates) and a paint. It draws the region holding each
  point, then its paths' strokes, each part outlined on its own
  (`livePaintParts`, regions cached by the group's version), so regions
  follow the paths as they change. SVG, PDF and PSD take it as an image.

## Type

Built in phase 9. Text is laid out on the page, where the Type tool needs
the layout for its caret and hit tests, and drawn by the engine as a glyph
set through the vector pipeline.

- **The model** (`doc/text.ts`): a `text` node has a mode (point, area or
  path), its content, a frame (area text's box or path text's path, in the
  node's coordinates; the transform places it), where path text starts, and
  an appearance stack like a shape's. Content is paragraphs of runs; a run
  is text with a character style and its own settings, a paragraph has a
  paragraph style and its own settings. Positions are UTF-16 offsets with
  each paragraph break counting one. Styles live in the document
  (`Doc.textStyles`), named, referred to by id, each based on another or
  none. A run's character settings resolve as the defaults, then the
  paragraph style's chain (paragraph styles carry character settings too),
  then the character style's chain, then the run's own; a paragraph's
  settings as the defaults, its style's chain, then its own. Edits (insert, delete,
  replace, style a range or paragraphs) are pure and normalise runs.
- **Shaping** (`text/hb.ts`) uses HarfBuzz 14.6.0 (MIT), compiled with a
  small C interface of our own (`native/pxhb/pxhb.c`): faces with their
  names, metrics, axes, named instances and `fsType`; fonts per variation;
  shaping UTF-16 text in its paragraph context into a float buffer (glyph,
  cluster, advances, offsets) at cluster level "monotone characters";
  outlines through draw callbacks, quadratics raised to cubics, cached.
  Results are in font units: fonts are scaled to their em.
- **Fonts** (`text/fonts.ts`, `app/fonts.ts`): a library of families and
  styles from files, every face of a collection and every named instance
  of a variable font as a style, loaded lazily where their bytes are
  fetched on first use; the nearest style by weight, width and italic; a
  fallback list by script; a version that moves when a font arrives.
  Sources: built in (Inter Variable and italic, Noto Sans Arabic and
  Devanagari as fallbacks, served from `public/fonts`), added by the user
  (kept in OPFS by hash), the computer's through Local Font Access (listed
  without a click when the permission is already granted), and a
  document's own (from its file or the journal). `resolve` finds a font by
  family and style, then by PostScript name (a Photoshop file's runs have
  no style until found), a guess from one, a full or loosely written name,
  and the family's nearest style; a system font keeps the browser's names
  after its file is read, the file's own kept as aliases the menu doesn't
  list. A font known but not read is `pending`, which layout reports apart
  from `missing`; missing-font warnings wait for the system's fonts to be
  listed and are said only for fonts still missing then.
- **Stand-ins** (`KindProps['text'].stand`): a PSD text layer keeps
  Photoshop's pixels as a tile set placed in the text's coordinates; while
  any of its fonts is missing or pending, the page hands the engine a
  pixel node with them instead of glyphs (`app/text.ts`, decorate). Edits
  to the text drop it; it's saved, converted and collected with the
  document's tiles.
- **The font menu** (`ui/FontPicker.tsx`, `app/fontMenu.ts`): families
  drawn in their own faces (a system font by name, others from their bytes
  as a FontFace), a list that renders only rows in view, favourites and
  recent in local storage, kinds from names.
- **Layout** (`text/layout.ts`), per paragraph: bidi levels (bidi-js,
  UAX #9), runs split by level, script, font (with a fallback for each
  character the font lacks) and settings, each shaped in the paragraph's
  context; break opportunities (linebreak, UAX #14) make segments with
  their widths, stretch and shrink. Hyphenating paragraphs add break
  opportunities where their language's Knuth–Liang patterns allow
  (`text/hyphenate.ts`, the hyphen package's TeX patterns, each language
  loaded when first wanted; a `Hyphenator` the layout asks synchronously,
  its version keying paragraphs' caches), and soft hyphens are always ones;
  a segment ending at one carries the hyphen's width. The paragraph's
  wanted word spacing, letter spacing and glyph scaling are applied as
  items are shaped; a line's stretch and shrink are what its word spaces,
  letter gaps and glyph widths may give within the ranges. The every-line
  composer is Knuth-Plass (justified text by its demerits, a hyphen's
  penalty and more for two in a row, the hyphen limit enforced on the best
  path; ragged text by squared slack; a line with nothing to stretch is the
  worst); the single-line composer is greedy, ending a line at its last
  allowed break (a hyphen only where it fits, within the limit and outside
  the zone). Each line is put in visual order by rule L2, justified
  (`justification`: word spaces within their range, then letters, then
  glyph scaling, the rest to the spaces; one word spread or aligned), its
  tabs moved to their stops (left, centre, right, decimal; leaders on a grid
  from the stop), a hyphen drawn after a broken word, then placed: point
  text from its origin, area text through its frame's width at each line's
  band (bands too narrow for the next word are skipped), path text along
  the flattened path, each glyph at its middle's distance and turned to the
  path there. The result is a glyph set, the lines (for the caret,
  selection and hit tests), bounds, overflow and the missing fonts. Each
  glyph keeps the paint its characters have of their own (`CharProps.fill`,
  `stroke`): the glyph set's `paints` and `paintOf`, which the outline
  builder splits the text's bottom fill and stroke by (`perCharacter`), and
  files and Create Outlines draw as a path per paint (`characterGroups`).
- **The Glyphs panel** (`text/glyphs.ts`, `ui/GlyphsPanel.tsx`): the face's
  cmap read from its file (`Face.tableBytes`; formats 12 and 4), a
  character's alternates found by shaping it with each alternate feature
  (aalt=n, salt, swsh, ssNN, cvNN, figures, small caps…), glyphs drawn as
  SVG paths from their outlines, rows drawn only in view; inserting goes
  through the type session (`insertGlyph`), an alternate with its feature.
- **Glyph sets** (`geom/glyphs.ts`): each glyph's outline once, in font
  units, and seven numbers per glyph set: the outline and the affine into
  the node's coordinates. The vector pipeline takes either a path or a glyph
  set wherever it flattens, bounds or fills an outline, so text takes the
  appearance stack, masks and effects with nothing of its own. Underlines
  and strikethroughs are a unit square placed as a glyph. Create Outlines
  places every contour into one path.
- **Getting to the engine**: the document holds no glyphs. EngineHost runs
  a decorator over text nodes (and smart objects' contents) as a scene is
  sent, attaching the layout's glyph set, cached per node, library version
  and styles; a font arriving bumps an epoch that sends text again.
- **Editing** (`app/typing.ts`): the Type tool's session commits every
  change at once (a run of typing folds into one step until the caret is
  moved some other way) and stays open through its own edits, Undo and
  Redo. Keys come through a hidden textarea placed at the caret, which is
  also what an IME composes in and the clipboard reads and writes. The
  caret, selection and composition are overlay shapes the engine draws.
- **In files**: fonts the text uses go into `.pxll` files as
  `fonts/<hash>.font` when they're neither built in nor restricted by their
  `fsType` (installable or editable embedding only), and fonts that came
  with a document go into the journal with a list of them.
- **Later**: threaded frames and text wrap round other layers, vertical
  text, hyphenation, tab stops, per-character colour, and WOFF/WOFF2.

## Painting

### Retouching

- **The Clone Stamp** is a stroke of its own kind (`StrokeStart.clone`:
  the source's offset in document pixels, and Sample All Layers). It keeps
  a sampling stroke's pixels (how far towards a paint, and the paint), so
  the compositor and the bake treat it as Smudge's; its kernel
  (shaders/clone.ts) gives each pixel of a dab the tip's coverage, built up
  to the opacity as a brush's is, and the source at full resolution: the
  layer through an atlas window of the tiles the source box reaches, or
  the composite rendered for the frame, wrapping on a tiled document. The
  page keeps the source and Aligned's offset (app/retouch.ts).
- **The Healing Brush and the Spot Healing Brush** paint a preview (a
  clone; a gray wash) and are finished on the CPU when the pen lifts
  (`StrokeStart.retouch`, `Renderer.finishRetouch`, engine/retouchHost.ts):
  the stroke's dabs, all of them (`LiveStroke.placed`), give exactly what
  it covered through the CPU dab mask, times the selection; a window of
  the layer round that is healed (retouch/heal.ts) or, spot healing,
  filled by content-aware fill's PatchMatch in its worker, then mixed in
  by coverage and written as a new set. **Patch** (`retouch.patch`) heals
  what the selection covers the same way.
- **Healing** (retouch/heal.ts) is the source plus a correction that
  equals destination minus source at the area's edge and is spread
  smoothly inside: a membrane, found by a pull-push pyramid and relaxed by
  Jacobi sweeps, after Pérez et al.'s Poisson image editing. It reads and
  writes the layer pixel for pixel, so it needs a layer on whole pixels,
  unturned.

- **Brushes** are settings (`brush/defs.ts`), one field or section for
  each of Photoshop's Brush Settings: the tip and its shape, Shape Dynamics,
  Scattering, Texture, Dual Brush, Colour Dynamics, Transfer, Brush Pose,
  Noise, Wet Edges, Build-up and Smoothing. Each control maps an input
  (pressure, tilt, twist, speed, distance, random, Fade over a number of
  dabs, direction, initial direction) through a curve onto a property
  (size, angle, roundness, scatter, count, opacity, flow, wetness, mix,
  texture depth, colour, hue, saturation, brightness), with a minimum.
  `readBrush` reads any saved or imported settings defensively. Presets are
  entries in `BRUSH_PRESETS`.
- **Bristle, erodible and airbrush tips** (`BrushSettings.special`) are
  footprints made per dab (`brush/special.ts`): the stroke builder picks,
  for each dab, a generated image tip named by the tip's settings and a
  level (`gen:b:…` how deep a bristle brush is pressed, from pressure and
  tilt; `gen:e:…` how worn a square or triangle is; `gen:a:…` which of
  eight spray variants), and sets the dab's size, roundness, angle and
  centre from the pen (an airbrush leans and stretches by its tilt; an
  erodible point grows with wear and pressure and draws with its side when
  tilted). The images are made from their names wherever they're asked
  for (page, worker, checks), so the stamp kernel and its CPU reference
  are unchanged and nothing is sent. Bristles are hairs with a length (a
  pointed brush's middle ones longest): a hair touches once the depth
  passes its length and splays outward as it's pressed further, by length
  and less for stiffness; close dabs draw each hair as a line. Erodible
  wear (`Wear`) grows with distance in diameters × pressure × softness;
  `StrokeStart.wear` gives a stroke its starting wear, and the page counts
  the same from the samples it sends and keeps it per tool until Sharpen
  Tip (or a preset is chosen).
- **Tips are images by id**: the round tip is computed; the rest (built-in
  Chalk, Spatter and Bristle at 256 px, and tips defined or imported, up to
  1,024 px a side) are grey images with a mip chain, named by a hash of
  their pixels (`tip:` and 16 hex digits), so the same tip from two ABR
  files is one tip. A dab reads its tip trilinearly at the level its size
  calls for, so a big tip painted small doesn't alias. Image tips and
  patterns are kept in IndexedDB on the page (`app/brushAssets.ts`) and sent
  to the worker once, before the first stroke that needs them; the GPU
  keeps them packed in one growing buffer with a table of offsets
  (`render/strokes.ts` `TipBank`).
- **Texture** is a tileable grey image (four built-in papers made from
  seeds, or a pattern from an ABR file) adjusted by brightness, contrast
  and invert, and combined with the dab's coverage by one of Photoshop's
  ten modes at a depth: per dab when Texture Each Tip is on, otherwise once
  over the stroke's raw coverage as it's laid on. **Dual Brush** stamps a
  second tip's dabs into a coverage channel of their own, combined with the
  main one by its mode the same way. So a stroke tile is `[coverage, raw?,
  dual?, colour…]` (`render/ref/paint.ts` `layoutOf`): only what the
  brush uses.
- **Pen samples go straight to the worker.** The page's pointer handler
  takes every coalesced sample (position in document pixels, pressure
  through the user's response curve, tilt, twist, the airbrush wheel
  (`tangentialPressure`, 0..1; a pen that has never turned one reads full
  on), time) and writes it into
  a SharedArrayBuffer ring (`input/penRing.ts`), which the worker drains at
  the start of each frame. Without cross-origin isolation, samples go as
  messages.
- **A stroke runs in the worker.** The brush engine (`brush/stroke.ts`)
  smooths the samples and places dabs at the brush's spacing, in document
  pixels; each dab is mapped into the layer's own pixels through the inverse
  of its live transform, as an affine map into the tip's space, so painting
  works at any angle on any transformed layer.
- **Stroke tiles.** Each frame's new dabs are stamped by a compute shader
  into float stroke tiles in the layer's tile grid, using Photoshop's
  semantics: coverage builds up by flow towards the stroke's opacity and
  never past it, and a stroke whose colour varies keeps colour per pixel.
  The compositing kernel lays the stroke onto the layer as it reads each
  texel (at full resolution while a stroke is on the layer), so the canvas
  shows it at once through the ordinary render path. The dirty regions and
  a live version in the scene keep caches honest.
- **Release bakes.** When the pen lifts, every touched tile is rendered with
  the stroke laid on, read back at the document's depth, and a new tile set
  is derived that shares every untouched tile. The page commits it as one
  history step; the stroke stays on screen until the document arrives with
  the new set, and the set is pinned against collection until then.
- **Jitter is seeded**, so the same pen samples always make the same stroke,
  and the checks replay strokes against the CPU reference.
- **Targets.** A stroke paints a pixel layer (only some of its colour
  channels, when only some are targeted), a mask, an alpha or spot
  channel, or (in Quick Mask) the selection itself; all but the first are
  gray 8-bit with their own transform, painted in gray levels, where
  missing tiles are the outside value under the stroke.
- **Confined to the selection** as the stroke is laid on, not as it's
  stamped: each stroke tile has the selection's coverage beside it, in the
  layer's pixels, read from the tile store when the tile is first touched,
  and the stroke's coverage is multiplied by it in the compositing and bake
  kernels. A brush builds up inside the selection exactly as anywhere.
- **Smudge and the Mixer Brush sample.** The brush carries paint: a 64 × 64
  patch across the tip's square, premultiplied, in the document's colour
  model. Each dab a compute kernel picks up what's under each patch texel
  (the layer read through the compositor's window table with the stroke so
  far laid on, bilinearly; or, with Sample All Layers, the frame's
  composite tiles gathered into one buffer), and a second puts paint down
  over the dab's box. Smudge keeps its strength of what it carried and puts
  that down. The Mixer's canvas paint moves a quarter of its wetness
  towards what's under it, so what it picks up is carried on and streaks;
  it puts down one paint mixed from that (by mix and wetness) and its
  reservoir's (by the rest of the mix and what's left in it), and the
  reservoir gets dirty with what it picks up, as Photoshop's does. The
  reservoir drains by its load, and is loaded, cleaned or carried to the
  next stroke. Sampling strokes are replacing strokes: the stroke tile
  holds the paint the layer goes towards and how far, so smudging
  transparency into paint thins it. `render/ref/sample.ts` is the reference
  the kernels are held to.
- **ABR files** are read on the page (`io/abr.ts`): versions 1 and 2's
  fixed records, and 6 to 10's tagged sections (`samp` tips, `patt`
  patterns, `desc` presets through the PSD descriptor reader). Presets map
  onto Plexel's settings section by section; what can't come over is named.
  A bristle tip is class `dBrush`, an erodible or airbrush one `dTips`,
  each with its shape as `Shp ` (its place in Photoshop's menu; `dTips` 5
  is the airbrush); their other settings' keys aren't published, so they're
  found by name and otherwise defaulted, said. **Written** (`io/abrWrite.ts`)
  as version 6.2: every image tip and texture pattern the brushes use, and
  each preset under Photoshop's keys (one straight control per property, a
  special tip as a sampled image of its footprint) plus the settings whole
  under `plexelBrush`, which the reader takes first, so Plexel's round trip
  is exact.
- **Tool presets** (`app/toolPresets.ts`) are a tool and options taken from
  that tool's own store: each tool with options has a source that takes
  them and gives them back (the brushes and the Mixer's, Smudge's and the
  Clone Stamp's settings; the selection, fill, shape, freehand, type and
  Move tools' stores). Given back, a preset's values are laid over the
  tool's only where they're the same kind of value (`overlay`). Kept in
  the browser. Photoshop's TPL files (`io/tpl.ts`) are "8BTP", then ABR's
  tagged sections: `tppa` patterns, `samp` tips, `tpsh` shapes and
  `tpst` styles (left out), and `tptp`, each preset a name and a
  descriptor whose class is the tool (`paintbrushTool`, `GrTl`…); a
  painting tool's is a brush preset with its options beside it. Each comes
  in as a patch over the tool's options.
- **The cursor** is the tip's outline, traced once per tip by marching
  squares at a level about 64 texels across and thinned, then turned,
  squashed and flipped as the dab is and drawn as overlay lines; a round
  tip at full roundness is the shader's ring.

## Tools

`TOOL_DEFS` declares each tool: its id, name, shortcut, cursor, the
options schema that generates the options bar, and its keys and gestures
(`keys`), which its tooltip card lists and the status bar hints, the ones
marked `during: 'drag'` only while a drag is on. Sessions declare theirs in
`SESSION_KEYS`. A press on the canvas starts
a **gesture** (`app/canvasTools.ts`) that turns input into doc edits or
engine operations. A tool never edits the document directly. It calls the
same `commit` as every panel, so undo and autosave are never special cases.

- **Previews skip the history.** A move or transform in progress sends the
  engine a document of its own, straight to the canvas, and commits once
  when it ends.
- **Sessions** outlast a drag: Free Transform, Crop and the Polygonal Lasso
  stay open until Enter commits or Esc cancels, and end themselves if the
  document changes underneath. The options bar shows what they're doing.
- **Transforms are in document space.** Free Transform builds one affine in
  document pixels, applied on top of the layer's (and its masks', and a
  group's whole contents'); handles work in the layer's own frame, so
  scaling a turned layer scales along its own edges. Rasterize bakes a
  layer's transform into new tiles on the document's grid.
  Several layers share one box in the document, and each gets the same
  affine. The Move tool's transform controls (`app/transformControls.ts`)
  draw that box round selected shapes and open a session for one drag of
  a handle, committed when the pointer lifts; they register with
  canvasTools rather than being imported by it, so there's no cycle.
- **Crop** changes the canvas, not the layers: every node's transform is
  moved (and, straightening, turned) into the new canvas's coordinates, as
  Canvas Size does, so nothing is lost.

### Guides, grids and snapping

- **Guides are the document's** (`Doc.guides`, edited by `doc/guides.ts`):
  in the history, saved in `.pxll` and in PSD (image resource 1032, in
  1/32 pixels), and moved by Crop and Canvas Size with the canvas. The
  grid, the rulers' units, what shows and what snaps are view settings
  (`app/guidePrefs.ts`), per browser like the interface's; the rulers'
  zero point is each open document's view state (`app/viewAids.ts`).
- **The engine draws them** in the overlay pass, under the tools' shapes:
  the page sends the guides, the grid's spacing and colours as the
  overlay's `view`, and `render/overlay.ts` clips each guide to the canvas
  and lays the grid over what of the document is in view, leaving out
  lines closer than a few pixels on screen. Smart guides are overlay
  paths of their own ink. The page's overlay (`app/overlay.ts`) has three
  channels: the tool's shapes, a snap's smart guides, and the view, so a
  tool redrawing never wipes the others.
- **Snapping is maths over targets gathered once a gesture** (`geom/snap.ts`,
  pure, and `app/snapping.ts`). A Snapper is made at the press with what's
  moving; it collects guides, the grid, the canvas's edges and centre,
  anchor points, and other layers' boxes (`app/bounds.ts`: measured from
  their pixels by the engine, kept with their node objects, arriving a
  moment later). Each move asks how far to pull a point or a box on each
  axis, nearest first; a box also snaps to equal spacing among the boxes
  in its row. What lines up afterwards comes back as smart guides. Ctrl
  lets go; the tolerance is in screen pixels. Tools snap where they place
  things, not by moving the pointer before the tool sees it, so a press
  still hits what's under it.
- **Picking a layer on the canvas** (`app/pick.ts`) tries layers from the
  top down where each shows: a pixel layer's alpha, a shape's fill or
  stroke, text's box, through masks and clipping bases. Pixel and mask
  values are probes answered by the engine together (`tiles.valuesAt`),
  so a deep document costs one round trip.
- **Split View** is two panes on the one canvas. `render/view.ts`' `paneRects`
  cuts it; the renderer works out each pane's tiles, renders what either
  needs once, and draws each through its own view matrix moved to its pane
  and scissored to it. On the page, `views()` holds both views and which
  pane is active (the one under the pointer); `get`, `set` and
  `engine().canvasSize()` are about the active pane, so gestures and
  commands are unchanged.
- **Several layers can be selected** (`OpenDoc.others`, with `selected` as
  the key layer), from the Layers panel. Move, nudging, Delete and
  Align/Distribute (`geom/align.ts`, `app/align.ts`) act on them all;
  commands for one layer act on the key layer.

## Tiled documents

A document can be a seamless tile, a torus: `Doc.tiled` (`'both'`, `'x'`
across only, `'y'` down only; absent is off), a step in the history,
saved in the `.pxll`, sent to the engine in `SceneDoc`, where a change
redraws everything. It's the document's, not the view's, because whether
something reads across an edge changes the picture. A smart object's
contents and a clipboard fragment never carry it. Built in stages
(ROADMAP.md); what's there:

- **Tiled View** (`GuidePrefs.tiledView`, sent with the overlay) shows the
  copies. `visibleTiles` folds the view into the document's own tiles
  (`foldedTiles`), and `screen.wgsl` moves each pixel of a copy into the
  document by whole periods (exactly, in the finest level's pixels) before
  sampling, with a level's reads wrapping at its edge so filtering crosses
  the seam. The selection and the overlay show on the document alone.
- **The pointer**: a press in a copy is moved into the document by whole
  periods, the same for its whole drag (`app/tiling.ts` `copyShift`), so
  tools work there and a drag over a seam stays in one piece.
- **Painting**: `wrapDab` (brush/dab.ts) brings each dab into the document
  and adds a copy a period away for each edge its reach crosses; each copy
  is clipped to the canvas when stamped, which is what makes them meet. A
  sampling stroke (the Mixer Brush, Smudge) picks up once, at the dab, and
  puts the same paint down at each copy; its reads wrap in the layer
  (`wtexel` in the pick kernel, for a layer on whole pixels, unturned) and
  in the composite (Sample All Layers), whose window covers the copies'
  tiles and pages in only those.
- **Layers on the torus** (render/graph.ts). A `TileJob` can carry a
  `shift` (whole periods, in document pixels): drawn through it, a node's
  content as far along lands on the tile (`originX`/`originY` take it at
  every place a tile's position is read; `rectOf` culls by it; cache keys
  include it; a vector reads every segment, as its bands are per tile).
  `copies(job, bounds)` gives the shifted jobs whose content meets the
  tile. A plain node (no live filters, no layer effects, not a group or
  an adjustment) is drawn once per copy, mask and clipped layers and all
  (`eachCopy`); anything else is drawn once from periodic sources:
  `contentTile` and `drawOwn` gather a node's copies, so a blur or a shadow
  over a seam is worked out on what repeats, not as two halves laid one
  over the other. A pixel layer's copies read only the layer's pixels in
  the canvas's rectangle in its own pixels (`clip` in the composite
  kernel): past it are whole tiles' padding (a new document's background,
  fills to tile edges), not pixels to wrap. Dirty regions are wrapped too
  (`wrapDirty`). Everywhere-wide bounds (adjustments, fill layers) are
  never copied. Every copy carries a shift (the one in place too), so a
  node drawn once is told apart from a copy: its masks wrap in their own
  pixels (`wrapped_texel` in the mask kernel, for a mask moved but not
  turned; a vector mask adds its outline's copies), and knockout groups
  draw their children's copies. In a tiled document Offset's result
  repeats beyond the canvas in every edge mode (the two that don't wrap
  are worked out piece by piece, a period away, and added), and a filter
  applied for good is drawn on the canvas and moved back into the layer.
  The Magnetic Lasso and Select and Mask's edge read a window cut with
  wrapping, Select and Mask's with a margin past the period that isn't
  pasted back.
- **Selections on the torus** (tiles/coverage.ts, `Torus`): polygons fold
  each row's spans into the canvas; a wrapping `CoverReader` gives
  Feather, Expand and Contract, Border, Smooth, Select and Mask's sliders
  and moving a selection their neighbours across the edges; the flood
  fill (the Magic Wand, Grow, the Paint Bucket) carries runs round;
  Transform Selection folds the copies it reaches; a pasted window
  (Quick Selection) is pasted in pieces. The engine's calls take the
  document's tiling (`tiled`). Corners of a lasso clicked over a seam are
  moved to the copy nearest the last (`nearestCopy`).
- **Gradients**: `PaintParams.wrap` gives each pixel the gradient's value
  at its copy nearest the line's anchor (`gradientAnchor`), the same in
  `paintAt` and the paint kernel.
- **Filters that remap** (`FilterDef.remap`: Offset) read from anywhere on
  the canvas, so they aren't gathered as a region. `withEffects` splits a
  layer's effects at the last one: those before it are worked out at the
  tiles it reads (`remapTile`, recursively), the tiles it needs gathered
  whole and clipped to the canvas (`gather_clip`), a period away too for
  Wrap Around, or through a clamped window for Repeat Edge Pixels
  (`clamp_read`); those after it run on its result as on content. Its
  result is the canvas only (`keep_rect`), so the scene gives such a layer
  the canvas as its bounds and the canvas's size as its reach. Applied for
  good, it's drawn on the canvas and moved back into the layer
  (`shiftTiles`), so it needs a layer on whole pixels.

## Files

### `.pxll`

A zip (Zip64 for big documents), written as a stream from a worker:

```
mimetype            "application/x-plexel", first and stored, as ODF does
document.json       format version, document fields, the node tree
layers/<id>.tiles   one pack per tile set: header, tile index, deflated planes
profiles/<hash>.icc
fonts/<hash>.font   the fonts the text uses, where their licence allows
assets/<hash>       embedded and linked sources: placed images, sub-documents
thumbnail.png       small, for file browsers and the recent-files list
preview.png         a flattened composite, so other tools can show something
```

- **Packs instead of one file per tile**, so a big document isn't 100,000 zip
  entries. Tiles are content-addressed inside packs, which lets autosave
  write only what changed.
- **Versioning** follows Fresyn exactly. A `FORMAT` number stays put while a
  `MIGRATIONS` table handles renames. The loader is defensive, collects
  warnings, and refuses files newer than the build.

### Storage

- **Open and save in place** use the File System Access API in Chromium. File
  handles go in IndexedDB for the recent-files list, each with its
  thumbnail.png beside it (a `pictures` store) for the start page. Other browsers open
  through a file input and save as a download.
- **Autosave** goes to OPFS as a journal: the doc JSON plus content-addressed
  tile packs, so each save writes only new tiles. It is debounced and flushed
  on `pagehide`. After a crash, the next visit offers to recover. The crash
  screen can hand back the journal as a `.pxll`, bypassing the app code that
  failed.
- **Every storage call** is wrapped and reports failure, such as a full disk
  or a refused permission, to the user.

### Import and export

The browser's own decoders (`createImageBitmap`, `<img>`) convert to 8-bit
sRGB and drop the profile, so they are used only where that doesn't matter.

| Format | Import | Export | Notes |
| --- | --- | --- | --- |
| PNG | own decoder | own encoder | 8/16-bit, ICC, via `DecompressionStream` / `CompressionStream` |
| JPEG | browser decode + own ICC parse; CMYK through our own decoder | browser / wasm encoder | `io/jpegDecode.ts`: baseline and progressive, Adobe YCCK and inverted CMYK |
| TIFF | own | own | 8/16-bit, RGB/Gray/CMYK, LZW/deflate, layers later |
| WebP | browser decode + own profile read (`io/webp.ts`) | browser encoder (lossless at quality 1 exactly), profile put in by `io/webp.ts` (the file made extended: VP8X, ICCP) | Chrome's encoder writes no profile |
| AVIF | browser | wasm (later) | |
| PNG-8 | (PNG's decoder) | `io/quantize.ts` (median cut over a 15-bit histogram, nearest colour, Floyd–Steinberg) and `encodePngIndexed` | Save for Web's; one-bit transparency |

**Freehand paths** (`geom/freehand.ts`, the tools in `app/freehand.ts`): a
stroke's points thinned and fitted by `fitPoints` (shared with Image
Trace: corners by chord angles over a few points so a hand's jitter isn't
a corner, smoothing, Schneider cubics, handles lined up where fitted
curves meet inside a run). Redrawing a selected path splices the fitted
stroke between the nearest places on it to the stroke's ends (cubics split
there), turned round if drawn against the path, the arc it runs along
replaced on a closed one; from an open end it extends. The Blob Brush is
the stroke's round outline (`strokeOutline`) united with the same-coloured
plain shapes it touches in its group (`booleanPaths`), then refitted.

**Image Trace** (`trace/trace.ts`, in a worker of its own,
`app/imageTrace.ts` for the document side): colours (a threshold, gray
levels, or median cut through `io/quantize.ts`, a box blur first),
regions (4-connected flood fill; noise regions joined to the neighbour
they share most edge with, smallest first), boundary loops on the pixel
lattice (each region on its left, saddles turned left), cut at junctions
(three or more labels round a lattice point, or a diagonal pair). Each
piece is fitted once (corners by chord angles, the staircase smoothed,
`fitCubics` from `geom/regions.ts`) and looked up by its ends for the
region on its other side, reversed: shapes abut exactly. One shape per
colour, all its regions in one even-odd path.

Colours set anywhere but the Colour panel are chips (`ui/ColourChip.tsx`):
`ColourChip` edits a ColourValue, `DocColourChip` a colour in a document's
terms (converted with Colour Settings' intent), `HexColourChip` the app's
own sRGB colours. The picker is portalled over everything and changes the
colour live; the caller's coalesce key makes a session one step.

Save for Web asks the engine for each file it shows (`image.optimize`,
`engine/imageHost.ts`): the composite as 8-bit RGBA, in sRGB or the
document's RGB profile, is kept while the document is the same, so a
setting changed only resamples (a canvas, smoothing high) and encodes
again. The dialog decodes each file back to show it.
| GIF, BMP | browser | own | |
| SVG | own XML parser → vector nodes | own writer | `io/svg/`; checked against resvg's renders and Chrome's |
| EPS | — | own writer (`io/eps/write.ts`, EPSF 3.0, Level 3), the PDF writer's host | device colours, Separation inks, shfill gradients; flattened up to the last layer that isn't opaque vectors (PostScript has no transparency), clear parts colour-keyed (ImageType 4); Flate + ASCII85, 7-bit clean; drawn by Ghostscript (WebAssembly, a dev dependency) in check:interchange |
| PDF | later: vectors and images | own writer, PDF/X-4 for CMYK | `io/pdf/`; read back by pdf.js in the checks. `.ai` files will open through their PDF part |
| PSD / PSB | own reader | own writer | `io/psd/`, our own rather than ag-psd (below) |
| Camera RAW | later, LibRaw in wasm | | |

#### PSD and PSB

`io/psd/` is in layers. `bin.ts` reads and writes the bytes (PSB's wider
lengths included); `format.ts` is the file as Photoshop lays it out
(header, resources, layer records with their channels in all four
compressions, tagged blocks, the composite), read and written exactly, so
an unchanged file writes back the same byte for byte. `descriptor.ts` and
`engineData.ts` are Photoshop's two data languages, kept as trees and
written back as they were; `blocks.ts` reads the tagged blocks Plexel
understands. Above that, `toDoc.ts` maps a file onto Plexel's model and
`fromDoc.ts` maps a document onto a **plan**: every layer's records and
blocks, with its pixels named by where they come from (a tile set, or a
node to rasterise) rather than copied. The page makes the plan; the engine
(`engine/psdWrite.ts`) fills in the pixels from its tiles and writes the
file, so no layer's pixels cross to the page. Opening goes the other way:
the engine reads the file and makes the tile sets (`engine/psdHost.ts`),
and the page finds the fonts.

Our own code rather than ag-psd: ag-psd hands pixels over as canvases or
image data (Plexel's live in the engine's tiles, at 16 bits and in CMYK
too), turns descriptors into plain objects, so what it doesn't model
doesn't write back as it was, and would still have needed its own mapping
onto Plexel's model. Ours is about 3,800 lines, keeps every block it
doesn't understand untouched, and is checked against psd-tools' files.

#### SVG and PDF

Both write a document as vectors where the format can hold what's drawn,
and as images where it can't; `io/flat.ts` decides. A layer is a vector if
it's a shape or text with no layer effects, live filters or pixel masks,
and paints the format has (solid colours, linear and radial gradients, in
Normal). Any layer that changes what's under it (an adjustment, a blend
mode the format lacks, a knockout group) flattens everything below it into
one image, rendered by the engine (`engine/nodeImage.ts`). Inside and
outside strokes are a stroke twice as wide, clipped to the shape or to
everything but it. Plexel's gradients are centred on the shape's box; SVG
and PDF gradients are placed in user space, so the writers work the
endpoints out from the box, and the SVG reader moves SVG's stops onto
Plexel's model (`resampleStops`) so the colours stay where they were.

The PDF is one page in the document's own colour (an ICCBased colour space
from its profile), with transparency groups for groups, ExtGState for
opacity and blend modes, shadings for gradients, and image XObjects with
soft masks for the rest. Spot swatches are Separation colour spaces with
their process equivalent as the alternate; spot channels are images in
the Separation of their ink (shared by name with a swatch's), drawn last
with overprint on, so each is a plate of its own. A CMYK document gets a PDF/X-4
output intent of its profile. Text is outlines for now; live text with
subset fonts is a later step.

## The interface

- React for the chrome only. A dockable panel system (docks either side,
  columns, tab groups, floating windows), with layers, properties, colour,
  swatches, brushes, history, channels, navigator, character, paragraph,
  appearance and info panels. Workspaces save the layout, and you can name
  and save your own.
- Panels that edit a def-driven thing (a filter, an adjustment, tool options,
  node properties) are generated from the def's parameter schema, with a
  custom face only when needed.
- Hand-built controls: number fields that scrub, sliders, curves and levels
  editors, gradient editors and colour wheels. Typed entry and units (px, mm,
  cm, in, pt, pica) are available everywhere.
- **The shared controls** (`ui/controls.tsx`), so a number or a choice
  behaves the same everywhere: `NumberInput` (typed until Enter or a blur,
  Esc back, arrows step), `ScrubLabel` and `scrub` (a label dragged
  sideways, Shift and Alt for speed), `SliderField` (a real range input
  styled as the bar, the number and the label laid over it on a grid, so
  the keys, the tests' selectors and assistive tools still find a range),
  `Segmented` (a radio group of buttons), `Hint` and `Label` (an ⓘ with
  a `data-tip`). `installLabelScrub` gives the labels of plain number
  fields (dialogs keep their values as strings) scrubbing too, by setting
  the input's value as typing would. Notes are of three kinds, each with
  its class: an explanation is a hint; a fact about the thing (a count, a
  size) is `field-meta`; nothing here is `field-empty`, its how-to a hint.
- **Long jobs** (`app/jobs.ts`, `engine/jobs.ts`, `ui/JobBar.tsx`): a call that
  can take a while carries a `job` id; the engine reports `progress`
  messages for it (at most ten a second) and polls a cancelled set at
  `checkpoint`s that also yield to the worker's queue, so a `job.cancel`
  message can arrive mid-job. Content-aware fill's search, in a worker of
  its own, reports from its loop and is terminated on cancel; PSD import
  reports per layer through `PsdHost.progress`; a bake (GPU work that
  can't be stopped part way) drops its result. The page's promise rejects
  with `Cancelled` at once.
- **Previewing dialogs** (`Dialog floating="preview"`, `app/previewing.ts`):
  no backdrop; while one is open, `data-previewing` on `<html>` turns off
  the panels', bars' and menus' pointer events, and the canvas's presses
  pan. Every dialog moves by its title bar, its offset kept per dialog id
  (`plexel.dialogs.v1`) and pulled back on screen.
- **Your toolbar** (`ui/toolbarPrefs.ts`): slot ids (a group's or a lone
  tool's) in order, those hidden, the columns; read defensively, new slots
  placed after their neighbour in the shipped order. **Shortcut sets**
  (`input/keySets.ts`): a set is the keys that differ from the registry's,
  applied through `assignKey` so no key ends on two commands; the dialog
  names the set the draft matches.
- **The type and spacing scale** is tokens on `:root` (`--text-xs`…`lg`,
  `--space-1`…`6`, `--control-h`, `--panel-head-h`); Compact redefines
  the larger steps rather than restyling each part.
- Themes on tokens, in dark and light, checked for contrast by `check:theme`.
  Canvas chrome colours come from the same tokens.
- Customisable shortcuts and a command palette (Ctrl+K) built from one
  command registry. The registry's keys are the defaults; what you change
  is `input/keymap.ts`'s, kept apart as a command's whole list of keys
  replacing the registry's (an empty list takes them away), so a key a
  later version adds still arrives unless you've set that command's keys,
  and Reset is forgetting the change. `shortcutsOf` gives a command's keys
  now, so the menus, the palette, the tool cards, the toolbar and the key
  handler all show and match yours. A key is one command's at a time:
  giving it to another takes it from the one that had it (the editor asks
  first), and `keyProblem` refuses the browser's own keys, the developer
  tools', the clipboard's for anything but the clipboard commands, and Tab
  for anything but Tab's. Kept per browser (`plexel.keys.v1`), read field
  by field, and carried in an exported workspace. Keys are recorded by
  `shortcutFromEvent`, by place for digits and punctuation (Shift+1, not
  !) and for a letter ⌥ turns into something else; matching tries a key's
  place too in those cases, never for a letter typed as itself, so a
  layout keeps its letters. Menus are generated from that registry too, and so is
  the canvas's context menu: `contextMenu(ctx)` picks the commands that fit
  the selection, the layer's kind and a session, and lists the enabled ones.
- **Every disabled command says why.** `CommandDef.why`, or the reason its
  `enabled` test carries (the shared tests, `hasDoc`, `hasLayer`,
  `hasSelection` and the rest, are built with `need(test, why)`), or a
  fallback from what's selected; `disabledReason()` picks. The menus show
  it on hover, the palette beside greyed matches.
- **One tooltip layer** (`ui/Tooltips.tsx`) for the whole app, asked for by
  attributes rather than components: `data-tip` (text, `data-tip-keys` for a
  shortcut), `data-tip-tool` (a tool's card from `TOOL_DEFS`), `data-why`
  (set on a control only while it's disabled). It listens for `pointerover`
  on the document, which disabled buttons still get in Chrome and Firefox.
- **The layout** (`ui/layout.ts`) is plain data: a dock either side of the
  canvas, each a row of columns; a column is panel groups stacked; a group
  is tabs, one in front, folded or not, with a height once one is dragged;
  floating windows hold groups stacked as a column does, back to front. A
  column can be folded to icons (`Column.icons`), keeping its width for
  when it opens out; which panel is shown beside it from its icons is view
  state in the dock (`iconPanel`), not the layout's, as Photoshop's
  flyouts close on the next click. A panel is in one
  group at most, so a group is named by any panel in it, and every move
  (onto a group's tabs, above or below a group, beside a column, over the
  canvas) names its target by a panel already there. A move puts the panel
  in at the target first and takes it out of where it was second, so the
  target can't be lost to the column or window the move empties. A whole
  window moves with `moveWindow`: over the canvas it just moves, elsewhere
  its groups go in at the target in order, each named by its front panel.
  Closing a panel records where it was (a tab mate, the group above it,
  or below it when it was at the top, its window when alone there), and
  opening it again puts it back. A window saved before windows stacked
  (`group`, not `groups`) reads as one of a single group. All of it is pure, so `check:commands`
  runs it in Node. `ui/Dock.tsx` draws it and turns the pointer into those
  moves: a drag keeps its target and indicator in a small store of its own,
  so moving the pointer never redraws the app, and a floating window being
  dragged is moved on the DOM and committed when let go.
- **A docked column shares its height** (`Dock.tsx`): its groups are flex
  items that never shrink past their tab bar and a strip (`GROUP_FLOOR`),
  each clipping and scrolling what's in it. Without shares, a group takes
  the height of what's in it (the last one the room left), and when they
  don't all fit, `useLevel` water-fills: one height every group is held to
  (a `max-height` through `--level`), the most that lets them all fit,
  worked out from each group's tab bar and its body's `scrollHeight` and
  kept current by a ResizeObserver on the column and what's in each
  group. Dragging a divider gives every group in the column its drawn
  height as a share (`setColumnHeights`), and shares are flex-grow from
  zero, so they keep their proportions in any window. A group's tabs are
  measured from an unseen copy at natural width; those past the bar's
  width (keeping the front one) go to a » menu.
- **Workspaces** (`ui/workspace.ts`) are the six task presets
  (`WORKSPACES`, each a column of panels and a width) and your own, saved
  with a name and the layout they were saved with. The saved workspace holds
  the one in use, its layout, and under `kept` how each other one was left,
  so switching back finds it as it was. Reset goes back to the design: a
  preset as shipped, one of yours as last saved (Save Changes updates it). A
  new one with the name of one of yours replaces it, as in Photoshop; a task
  workspace's name is refused. Your workspaces have run-time commands
  (`runtimeCommands` in the registry), which the menu lists where `MENUS`
  has `{ runtime: 'workspaces' }`, and the palette with the rest. The save
  is `plexel.workspace.v2`; a first-version save (before docking) is read
  once and carried over, its panels down one column on the right.
  A workspace goes out as a file (`ui/workspaceFile.ts`): JSON with a
  `format` of `plexel-workspace`, a version, its name, its layout and, when
  any are changed, your keys; read back with the layout's own defensive
  reader, it's added with `addWorkspace` (New Workspace is that, with where
  the panels are now).
- **Spring-loaded tools** (`app/springTools.ts`): the shortcut handler
  tells the spring which key chose a tool and what was chosen before; the
  key's release gives it back if the press was a hold (over 250 ms, or the
  canvas used meanwhile), after any drag in progress. The spring takes its
  clock, tool setter and drag test as arguments, so `check:commands` runs
  it with a fake clock.
- **Screen modes and Tab** are view state in `App`: Standard, with Menu
  Bar, and Full Screen (the canvas alone, and the browser's full screen if
  it wasn't already). Tab and Shift+Tab are `focusKey` commands: the app
  takes them only from the canvas or with nothing focused, so keyboard users
  still move between controls with them.
- **Interface settings** (`ui/interface.ts`) apply as `--ui-scale` and
  `data-density`, `data-contrast` and `data-motion` on `<html>`. The size is
  CSS `zoom` on the chrome (bars, dock, dialogs, tooltips, menus), never on
  the canvas, whose device pixels the engine owns. Dock columns and floating
  windows are zoomed too, so they keep their sizes in their own pixels;
  anything placed at a screen point divides the point by the scale, and the
  Layers panel's peek and drag label are portalled to `<body>` so the dock's
  scrolling can't carry them.

## Checks

| Suite | Kind | What it holds |
| --- | --- | --- |
| `check:static` | fast | types (tsc); the lint (eslint.config.js: promises not waited for or misused, the rules of hooks, type-only imports marked); dependencies (.dependency-cruiser.cjs: no runtime import cycles, doc/ tiles/ color/ geom/ text/ lib/ never importing the app, interface, engine or renderer); unused files and packages (knip.json) |
| `check:artboards` | fast | artboards made, moved (carrying their layers), sized (not), kept at the top level; the canvas grown round them and the shift reported; the pasteboard's area; one artboard as a document; symbols made, placed, edited, renamed, replaced, broken and deleted, nested; both expanded into plain layers and kept as the same objects; files read back; instances copied with their symbols; where a new layer goes |
| `check:commands` | fast | the command registry, menus, shortcuts and your own keys (giving, taking, refusing, recording, reading), palette search, the layout (icons, stacked windows, whole-window moves), workspace files, view-state loading |
| `check:doc` | fast | edits, history, coalescing, normalize, describeEdit, save round trip, migrations; patterns from artwork: layouts and their repeats, the edit tab’s tiling, Make Pattern’s contents, saved, collected and converted with the document |
| `check:snap` | fast | snapping points and boxes to lines, the grid and equal spacing, and the smart guides reported; align and distribute; guide edits, layouts, Crop and Canvas Size moving guides, saving them; the settings read defensively; the overlay's guides and grids; shortcuts on ; and ' |
| `check:flow` | browser | a filter dialog undimmed, the canvas only panning under it, the dialog moved, reopened where it was, put back, closed by Esc wherever the focus is; a control marked off its default and reset by a double-click; Zoom to Selection, a thumbnail double-clicked; the colour picker at the pointer, its colour kept or put back by Esc; shortcut sets chosen, saved, recognised; the toolbar edited (a slot off and in the … slot, moved, two columns, Restore Defaults); Tiled View's frame and its way back; content-aware fill's job bar, its progress, and Esc cancelling it with nothing changed |
| `check:boards` | browser | New Document with an artboard, the pasteboard, New Artboard, the Artboard tool drawing, moving and sizing one, its name dragged, a shape drawn going onto its artboard and clipped (and not, Clip off), the Move tool carrying a layer onto another artboard, exporting every artboard (a zip) and the selected one, Release Artboard; New Symbol, placing from the panel, editing in the symbol's tab with every instance following, undo followed by the tab, Break Link, Rasterize |
| `check:panels` | browser | a column's groups sharing its height (one scroll level, tab bars never covered, short panels whole), dividers trading height and keeping proportions in a shorter window, a double-click fitting them; tabs in the » menu; slider bars scrubbed by their label, numbers stepped by the arrows and put back by Esc, box fields scrubbed, segmented choices and their arrow keys, ⓘ hints and their tooltips, a dialog's number label scrubbing |
| `check:filters` | browser | the Filter menu's submenus, Twirl kept on the layer's box, Lens Blur and an effect's blend mode, a filter layer, Document → Adjustments applied for good, Colour Lookup from a `.cube` file |
| `check:channels` | browser | the Channels panel: colour channels shown alone in gray and hidden, some colour channels painted and filled, alpha channels made, painted, filled, cleared, tinted and loaded, spot channels made from the selection and shown as ink, Channel Options, reordering, colour channels and the luminosity loaded, the Magic Wand on a channel, the shortcuts, PSD round trips |
| `check:construct` | browser | Pathfinder's Divide and Minus Front, the Shape Builder merging and deleting regions, the Live Paint Bucket (making a group, filling, emptying), Live Paint's Expand, Outline Stroke, Offset Path and Simplify |
| `check:appearance` | browser | a Drop Shadow and an Offset Path on one fill from Properties; the Graphic Styles panel: new from a shape, given to another, redefined, a link broken |
| `check:warp` | browser | Free Transform's Distort, Perspective and Warp (a style, then its mesh dragged, then picked up again), a shape warped as outlines, Rasterize keeping a warp, Liquify brushed, committed and restored |
| `check:healing` | browser | the Clone Stamp (no source, Alt-click, Aligned on and off), the Healing Brush (a blemish healed to the ground with the source's texture), the Spot Healing Brush, Patch (drawn, dragged, healed), cloning across a tiled document's seam |
| `check:tiled` | browser | Document → Tiled as a step, Tiled View's copies, strokes over each edge and from a copy, Smudge across an edge, Offset live (wrapping) and applied (repeating edge pixels), Define Pattern from the whole canvas, a shape over an edge, a live blur across the seam, a marquee and the Magic Wand round the edges, a gradient over the seam, across only |
| `check:workflow` | browser | picking layers on the canvas (Ctrl-click, Alt deeper, Shift, Auto-Select, groups), Previous Tool, the bird's-eye view, swatches dropped on shapes, Split View's panes zoomed and drawn in on their own |
| `check:guides` | browser | rulers and their units, guides dragged from the rulers, moved and removed, New Guide and New Guide Layout, Lock and Clear, the grid, the Move and Shape tools snapping and letting go with Ctrl, smart guides on screen, several layers selected in the Layers panel, moved, aligned and distributed |
| `check:geom` | fast | bézier maths and flattening, live shapes' areas, stroke outlines (joins, caps, dashes), exact coverage against clipped areas, booleans against analytic areas and a sampled fuzz, path editing, the vector model and its edits |
| `check:vectors` | browser | the Shape tool, the appearance stack in Properties, the Pen, Direct Selection, compound shapes, vector masks, transforming and rasterizing shapes, through the real UI |
| `check:color` | fast | known conversions (ΔE), LUT accuracy, mode changes, round trips |
| `check:tiles` | fast | copy-on-write sharing, refcounts, GC, spill and reload |
| `check:render-ref` | fast | every blend mode, adjustment and filter in the CPU reference, against formulas and known images; the view maths; the scene's bounds and dirty regions |
| `check:images` | fast | the image codecs against images built byte by byte in every variant |
| `check:io` | fast | codec round trips, ICC preservation, `.pxll` round trip, defensive loading |
| `check:text` | fast | HarfBuzz on the bundled fonts, the font library, the text model's edits and styles, layout (breaking, bidi, both composers, alignment, frames, paths), glyph sets against their outlines, fonts carried in `.pxll` |
| `check:type` | browser | the Type tool, editing, IME and the clipboard, the Character and Paragraph panels, styles, area and path text, Create Outlines, Rasterize, a missing font; with Local Font Access granted, system fonts listed by themselves, loading without a warning, PSD fonts found, the font menu |
| `check:print` | fast | proof tables against lcms chained, the gamut check, the display look's reference, CMYK adjustment tables, documents and tile sets converted, grid conversions against lcms, document swatches, ASE files |
| `check:interchange` | fast | every PSD/PSB fixture parsed and mapped, files written back byte for byte, descriptors and EngineData round trips, PSD written from documents, the JPEG decoder against references, SVG read and written, PDF read back by pdf.js |
| `check:interchange-browser` | browser | Photoshop's adjustment files against Photoshop's composites, resvg's cases against resvg's renders, PSD and PSB round trips drawn again, SVG drawn by Chrome, PDF read by pdf.js, CMYK JPEGs, the Export dialog |
| `check:clipboard` | browser | cut, copy and paste through Chrome's clipboard: pixels, layers, paths, styles, other apps' images, SVG and text, another document's mode |
| `check:segment` | fast | Quick Selection's graph cut and the Magnetic Lasso's wire on images made to test them, with timings |
| `check:matte` | fast | Select and Mask's edge band and refinement against images with a known alpha, decontamination, timings |
| `check:retouch` | fast | content-aware fill continuing stripes, gradients and textures, its source region, soft holes, every mode, timings; healing (tone from round, texture from the source, no seam) and pull-push |
| `check:fills` | browser | Edit → Fill, Define Pattern, fill layers, the Gradient tool, the Paint Bucket, content-aware fill, Quick Selection, the Magnetic Lasso, Colour Range, Grow, Border, Smooth, Transform Selection, alpha channels and Select and Mask's edge, through the real UI; Make Pattern, pattern editing mode (layouts, edits going back, Done, Cancel, Save a Copy, a pattern from pixels opened), Pattern Overlay with the pattern |
| `check:proof` | browser | Mode and Convert to Profile, Proof Setup, Proof Colours and the Gamut Warning on screen, the Separations panel, spot swatches linked at a tint, an ASE library loaded |
| `check:manual` | fast | *not built yet*: manual tutorials and parameter tables against the registries |
| `check:theme` | fast | full token sets, contrast pairs |
| `check:engine` | browser | the device, drawing, theme and size changes, idling, the no-WebGPU page |
| `check:shell` | browser | menus, palette, shortcuts, dialogs, the dock, view state across reloads |
| `check:gpu` | browser | each GPU kernel against its CPU reference, every mode × depth; bristle, erodible and airbrush strokes; Pattern Overlay with a document pattern |
| `check:brush` | fast | dab placement, dynamics, seeded jitter, dabs on transformed layers, flow and opacity in the stroke buffer; bristle, erodible and airbrush footprints, wear, the leaning spray, the stylus wheel and Initial Rotation; ABR special tips read, brushes written and read back; TPL files |
| `check:paint` | browser | strokes from mouse and pen, flow and opacity, the eraser, refusals, the picker, the panels, undo and the history cap; the new tips in Brush Settings, Sharpen Tip, Export, Tool Presets and a TPL file imported |
| `check:canvas` | browser | what's drawn, from screenshots; pan, zoom, rotate and the view tools; layer drag and drop; imports, exports and big files |
| `check:files` | browser | open, save, autosave and recovery in OPFS |
| `check:ux` | browser | tool cards, disabled commands' reasons, key hints, sizing the brush on the canvas, the context menu, the Layers panel's actions, solo, peek and drag label, workspaces, docking, tab groups and floating panels by real drags, columns folded to icons, windows of stacked groups and their grip, workspaces of your own, exporting and importing a workspace, your own keyboard shortcuts, Tab and the screen modes, the interface settings |

The browser suites run Chrome through `puppeteer-core` with WebGPU enabled
on the real GPU (`--enable-unsafe-webgpu --enable-gpu`; headless Chrome
keeps WebGPU behind that flag). The canvas belongs to the worker, so what it
drew is read back from screenshots.

`npm run check` (scripts/run-checks.mjs) runs suites several at once: the
headless ones one a core, the browser ones four at a time (they share the
GPU), longest first by their last times (node_modules/.cache), each one's
output shown whole when it ends. The browser suites run against a
production build under Vite's preview server, which is what ships and which
editing src/ can't reload mid-run; `--dev` uses the dev server. `--only a,b`
runs some; `--retry-failed` runs a failure again alone and reports one that
passes then as flaky. All 44 suites in about seven minutes, where one after
another took fifteen. The suites share their common steps from
scripts/harness.mjs (`pageHelpers`: `press`, `idle`; `dialogShown`), and
waitForEngine also waits for the dialogs' code (they load on demand).
`npm run bench` measures stroke latency, pan and zoom frame times, filter
throughput and the time to open a big file, against budgets in
PERFORMANCE.md.

## Build and deploy

- `vite.config.ts`: `build.target: 'es2022'`, React in its own chunk, workers
  as ES modules (unlike Fresyn's worklet, workers have a module loader), wasm
  served as hashed assets, COOP/COEP on the dev server.
- **Loaded on demand**, not in the first download: reading and writing
  PSD, SVG and PDF, ABR import (`import()` where they're used, app/files.ts),
  the text layout with its line breaking and bidi tables (with the fonts,
  app/text.ts), and the dialogs (`React.lazy` in App.tsx, under one
  Suspense). What only says what a file is lives apart (io/sniff.ts), as
  does what Copy and the Type tool need at once (io/svg/pathData.ts,
  text/framePath.ts). The wasm modules compile as they download.
- `public/_headers`: immutable caching for `/assets/*`, a week for
  `/fonts/*`, plus `nosniff`, the referrer policy and COOP/COEP on `/*`.
  Cross-origin isolation is what lets the tile slabs and the pen ring be
  shared memory.
- `npm run deploy` is `check:fast && build && wrangler pages deploy dist
  --project-name=plexel`. The `plexel.dblpl.us` custom domain is attached to
  the Pages project in the Cloudflare dashboard.

## Documentation

- **README.md**: run it, a tour, every check, the **Decisions** section and
  the annotated layout.
- **MANUAL.md**: the user manual, with a section per tool, panel, adjustment
  and filter. Its parameter tables feed the hover help, and its tutorials are
  checked.
- **CHANGELOG.md**: newest first, in Fresyn's form. Each entry has a feature
  heading, a paragraph, bold-lead bullets, the bugs found along the way, and
  the checks that cover it.
- **PERFORMANCE.md**: budgets, method, and dated before and after numbers.
- **BRAINSTORM.md**: unfiltered ideas, kept out of the build.
- **The parity report**: an artifact comparing Plexel with Photoshop,
  Illustrator and Affinity, updated each iteration to steer what comes next.

## Build order

Each phase ends with something to run and checks that pass. The model above
is complete from phase 1, so later phases add evaluators, tools and panels,
not structure. All modes and depths go through the core from the beginning:
the checks sweep RGB, Gray and CMYK at 8 and 16 bits from phase 2, even
before the UI offers every combination.

1. **Scaffold.** Vite, React, TypeScript, the check runner and harness,
   themes, `_headers`, deploy. The app shell with menus and empty docks. The
   engine worker gets a WebGPU device on an OffscreenCanvas, and a missing
   WebGPU gets a clear page.
2. **Document core.** `Doc` and `NODE_DEFS`, edits, history, `describeEdit`,
   the `.pxll` writer and reader, OPFS autosave and recovery, File System
   Access open and save, the crash screen.
3. **Colour and tiles.** lcms2 in wasm, profiles, colour values, display LUTs.
   The tile store with planar channels, 8/16-bit, copy-on-write, slabs, spill
   and residency.
4. **The render graph.** Pixel and group evaluators, every blend mode with its
   CPU reference, pan, zoom and rotate, mip pyramids, the layers panel. Import
   PNG, JPEG and TIFF with their profiles, and export PNG and JPEG.
5. **Painting.** Pen input, the brush engine, eraser, colour panel and
   pickers, swatches, brush presets.
6. **Selections, masks and transforms.** Marquee, lasso, magic wand, quick
   mask, refine edge. Pixel masks (vector masks arrive with vectors),
   clipping by nesting, live transforms with handles, Rasterize and crop.
7. **Adjustments, live filters, layer FX and smart objects.** The registries
   and a first set of each, plus embedded smart objects.
8. **Vectors.** The pen tool and node editing, live shapes, the appearance
   stack, gradients and paints, live booleans, vector masks, the GPU
   rasterizer at full quality. Done; stroke width profiles were put off.
9. **Type.** HarfBuzz, fonts, point, area and path text, character and
   paragraph styles. Done; threaded frames, hyphenation and per-character
   colour were put off.
10. **Print colour end to end.** Mode conversion and Convert to Profile,
    soft-proofing, gamut warnings, separations and the ink limit, colour
    adjustments in CMYK through the profile, document swatches with global
    and spot colours, ASE libraries. Done; measured press profiles were put
    off, and spot channels came with Channels, after the quality pass.
11. **Interchange.** SVG in and out, PDF out, PSD and PSB in and out, CMYK
    JPEGs. Done; live PDF text, bleed, Photoshop's patterns and smart
    filters, and opening PDF were put off.
12. **Brushes.** Photoshop's brush engine, image tips, ABR files, the Mixer
    Brush and Smudge. Done.
13. **The clipboard.** Cut, copy and paste of pixels, layers, styles and
    paths, between documents and with other apps; Duplicate Layer and Layer
    via Copy. Done; several layers at once, SVG out for shapes, and live
    layers across tabs were put off.
14. **Fills, gradients and selections.** Edit → Fill with its contents and
    blending, content-aware fill, the Gradient tool, fill layers, patterns
    from pixels, the Paint Bucket; Quick Selection, the Magnetic Lasso,
    Colour Range, Grow and Similar, Border and Smooth, Transform Selection,
    alpha channels, and Select and Mask's edge detection and refine brush.
    Done; patterns from pixels in Pattern Overlay and Photoshop's patterns
    were put off; painting alpha channels came with Channels.

Then, from the gap map: **docking and floating panels** and workspaces of
your own; **guides, grids and snapping**: rulers, guides (in PSD too), the
grid and pixel grid, snapping with smart guides and equal spacing, several
layers selected, align and distribute.

Between phases, a **UX pass** (asked for directly): tool cards, reasons for
disabled commands, key hints, sizing the brush on the canvas, the context
menu, the Layers panel's actions, task workspaces, screen modes and the
interface settings. brainstorm.md keeps the ideas not built yet.

After that, the parity report picks the order: retouching (healing, clone;
content-aware fill is in), liquify and warps, more filters, symbols,
artboards, RAW, scripting and the rest.

## Open questions

- Whether to ship measured CMYK press profiles. ECI's (FOGRA39-based,
  eciCMYK, PSO) are the likely choice; their download sits behind a terms
  page, so the licence needs a person to read and accept it.
- Photoshop's modern Brightness/Contrast curve isn't published; ours is
  fitted to its renders of four settings (within about nine levels on
  average). More reference renders would pin it down.
