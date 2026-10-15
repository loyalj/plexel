# Plexel performance

Budgets, how they're measured, and dated numbers. Every optimisation gets a
before and an after here. The numbers come from `npm run bench`
(`scripts/bench.mjs`), which drives the real app in Chrome on the real GPU and
prints each figure and whether each budget was met. Set `BENCH_OUT` to a
path to keep the run as JSON, and `BENCH_PROFILE` to a folder for CPU
profiles of the page and the engine while the reopened PSD is drawn (open
them in Chrome's DevTools).

## Method

- **Machine**: the development machine, Windows 10, an NVIDIA Turing GPU
  (the adapter names no more than that), Chrome headless with WebGPU on the
  real GPU. Headless Chrome refreshes at 30 Hz, so frame budgets are judged
  against the display's own measured refresh rather than a fixed 60 Hz.
- **The dev server**, not a production build. Rendering is GPU-bound and the
  CPU work per frame is under a millisecond either way.
- **The document** for the frame figures: 12,000 × 8,000 RGB 8-bit (96 MP),
  a white Background and a layer of noise. Noise tiles can't be uniform, so
  every tile is real data: 1,504 tiles, 384 MB.
- **Uploads**: tiles from the tile store into the GPU atlas, timed from the
  first `writeTexture` to `onSubmittedWorkDone`.
- **Compositing**: 16 tiles under 8 noise layers alternating Screen and
  Multiply at 80%, the second of two runs (the first uploads), GPU time to
  `onSubmittedWorkDone`.
- **Painting**: on the same document at 100%, a stroke of 480 pen samples,
  four a frame, through the shared ring as a pen sends them, then the bake
  when it ends, timed from the call to the new tile set.
- **Selections**: on the same document, each call timed from the page to
  its result: Select All; an anti-aliased ellipse 200 pixels inside the
  canvas's edges; feathering that by 20 px; the Magic Wand clicked on the
  noise (so it reads the whole composite back, from a mip level past 64 MP).
  Then the feathered ellipse as the noise layer's mask (with an 8 px live
  feather) and as the selection, and 120 frames of panning with both on
  screen, ants crawling.
- **Adjustments and a live filter**: on the same document, Curves,
  Hue/Saturation and Levels layers over everything and a 8 px Gaussian
  Blur in the noise layer's effects, added in one step: the time until
  every tile in view is drawn again, then 120 frames of panning.
- **Vectors**: on the same document, with the adjustments still there, two
  hundred shapes added in one step (rectangles, ellipses, stars and
  hexagons up to 1,600 px across, at 85%, a third with gradients, some with
  patterns, half stroked 12 px, a quarter of those dashed), a compound
  shape (a ring with two circles added and excluded, filled in Multiply and
  stroked outside) and a path of 4,000 smooth points stroked 16 px: the
  time until every tile in view is drawn again, 120 frames of panning, and
  then Fit on Screen, timed until every tile is drawn.
- **Type**: on the same document, still fitted, a text layer of 60,000
  characters of area text (paragraphs of about 700 characters of English
  words, Inter at 22 px, justified, every-line composer) in a frame
  5,200 × 6,800 px, added in one step: the time until it's laid out and
  every tile in view drawn; the layout alone, timed again on the page from
  nothing; then at 100% over the text, the time until every tile is drawn,
  and 120 frames of panning across it.
- **Print colour**: on the same document, fitted, Proof Colours and the
  Gamut Warning turned on against Generic CMYK: the time until every tile
  in view is drawn again, and 120 frames of panning. Then, proofing off,
  the whole document converted to CMYK (relative colorimetric, black-point
  compensation): the time from asking until it's committed.
- **Interchange**: then the whole CMYK document, with its 200 shapes, the
  compound and the path, the text, the three adjustments, the masked noise
  layer and its blur, written as a PSD (every shape and the text
  rasterized into its layer, the composite rendered, the file built in
  the engine), timed from asking until the bytes are on the page; then
  opened again, timed until it's a document; then until a frame of it,
  fitted, has nothing left to draw.
- **Frames**: the page changes the view once a display frame (pan 12 px,
  zoom 3%, rotate 1°) and records every frame the engine reports: when it
  arrived, how long it took to build on the CPU, how many tiles it rendered
  and how many were left.

## Budgets

| What | Budget | 10 Oct 2026 |
| --- | --- | --- |
| Uploads, RGB 8-bit | at least 500 MB/s | 910–950 MB/s (12 Oct, after the change in the log) |
| A 96 MP document: first picture | within 1 s | 652–677 ms (13 Oct) |
| A 96 MP document: every tile in view | within 3 s | 690–760 ms |
| Panning at 100%: frame interval | within 10% of the display's | 33.4 ms against 33.3 ms |
| Panning at 100%: CPU per frame | at most 8 ms at the 95th percentile | 0.7–1.0 ms |
| Zooming continuously: frame interval | within 10% of the display's | 33.3 ms |
| Rotating continuously: frame interval | within 10% of the display's | 33.4 ms |
| Painting (60 px brush, 4 samples a frame): frame interval | within 10% of the display's | 33.3 ms (11 Oct) |
| Painting: CPU per frame | at most 8 ms at the 95th percentile | 0.9 ms |
| Baking a stroke when the pen lifts (a 1,000-pixel stroke) | within 250 ms | 122–127 ms |
| The Mixer Brush (wet, loaded, half mix; the same stroke): frame interval | within 10% of the display's | 33.3–33.4 ms (11 Oct) |
| The Mixer Brush: CPU per frame | at most 8 ms at the 95th percentile | 1.6–1.8 ms |
| Smudge at 70% (the same stroke): frame interval | within 10% of the display's | 33.3–33.4 ms |
| Smudge: CPU per frame | at most 8 ms at the 95th percentile | 1.4 ms |
| Baking a Mixer or Smudge stroke when the pen lifts | within 250 ms | 35–39 ms |
| Select All, 96 MP | within 100 ms | 26–28 ms |
| An anti-aliased ellipse, 96 MP | within 1 s | 213–234 ms (12 Oct, after the change in the log) |
| Feathering it by 20 px | within 2 s | 728–736 ms (12 Oct) |
| The Magic Wand, 96 MP | within 3 s | 1.74 s (10 Oct, after the change in the log) |
| Panning with a feathered mask and marching ants: frame interval | within 10% of the display's | 33.3–33.4 ms |
| Panning with a mask and ants: CPU per frame | at most 8 ms at the 95th percentile | 1.0–1.1 ms |
| Three adjustment layers and a live blur added: the view drawn again | within 3 s | 283 ms |
| Panning with them: frame interval | within 10% of the display's | 33.3 ms |
| Panning with them: CPU per frame | at most 8 ms at the 95th percentile | 2.0–2.5 ms |
| Two hundred shapes, a compound and a 4,000-point path added: the view drawn again | within 3 s | 253–258 ms (11 Oct) |
| Panning with them: frame interval | within 10% of the display's | 33.4 ms |
| Panning with them: CPU per frame | at most 8 ms at the 95th percentile | 3.6–5.3 ms |
| Fitting the document with them on screen: every shape drawn | within 3 s | 374–388 ms |
| 60,000 characters of justified area text: laid out | within 1 s | 116 ms (13 Oct, every-line for the first time; see the log) |
| The same added, fitted on screen: laid out and every tile drawn | within 3 s | 0.83–0.99 s (13 Oct) |
| At 100% over the text: every tile in view drawn | within 1 s | 806–923 ms |
| Panning over the text: frame interval | within 10% of the display's | 33.3–33.4 ms |
| Panning over the text: CPU per frame | at most 8 ms at the 95th percentile | 4.7 ms (after the change in the log) |
| Proof Colours and the Gamut Warning on: the view drawn again | within 3 s | 648–803 ms (11 Oct) |
| Panning proofed: frame interval | within 10% of the display's | 33.3–33.4 ms |
| Panning proofed: CPU per frame | at most 8 ms at the 95th percentile | 0.3 ms |
| The 96 MP document converted to CMYK | within 20 s | 12.9 s (after the change in the log) |
| The same written as a PSD (212 layers, 573 MB) | within 60 s | 32.6 s (11 Oct, after the change in the log) |
| And opened again | within 40 s | 14.3–14.4 s (12 Oct) |
| And drawn, fitted, after opening | within 3 s | 2.29–2.40 s (13 Oct, after the change in the log) |

What bounds each:

- **The first picture** needs every base tile on the GPU once, to build the
  coarse mip levels a fitted view shows: 384 MB at the upload rate is most of
  the 700 ms. It grows with the image, about 7 ms a megapixel here. Mip
  pyramids saved in the file would remove it; that's on the roadmap's
  deferred list.
- **Selection work** is on the CPU in the engine worker, tile by tile:
  tiles wholly inside or outside a shape are one value and cost little, so
  the time grows with the length of the edge, not the area. Feathering
  reads each tile with a margin of three sigmas. The wand first reads the
  composite back (24 MP, from the mip level below 96 MP), then floods.
- **Adjustments** cost a copy of the tile and one pass each; a **live
  filter** costs gathering the content tiles round each tile (cached, so
  each is drawn once) and its passes over the region, whose cost doesn't
  depend on the radius. A blur only reads as far as its reach at the level
  drawn, so zoomed out it's cheap.
- **Vectors** cost, once per shape and zoom level, flattening and (for
  strokes) outlining on the CPU in the worker: 74 ms for the 4,000-point
  path at 100%, 8 ms zoomed out to a level where it's small. Then per tile,
  per fill or stroke: the segments crossing the tile, picked out of its
  band of rows and its column (sorted once per outline and level), one
  coverage pass (each pixel sums the segments crossing its strip of 16
  rows), one paint pass and one compositing pass. A tile under many shapes
  costs that many passes: about 25 ms of GPU for a tile under a dozen
  stroked and gradient-filled shapes on this machine.
- **Text** costs its layout on the page (HarfBuzz shaping each run of a
  paragraph, then breaking and composing it): about 2.4 µs a character for
  justified English, every-line. The glyphs then cost what a shape does,
  with one fill: here 49,000 glyphs from 41 outlines, flattened once per
  level. The 1.4 s to draw it fitted takes in the layout, sending 49,000
  placements to the worker, and flattening and sorting every glyph at the
  coarse level (not timed apart yet); panning at 100% then reads only the
  tiles' own segments.
- **Proofing** costs a display table, made once per condition in the
  worker (within the 648 ms above), and the redraw of what's in view; frames
  after that cost what they did, the gamut mark and ink limit being a few
  instructions in the display pass.
- **Converting** a document reads every pixel tile, interpolates each
  pixel in the conversion's table and quantises it back: about 13
  megapixels a second from RGB on this machine, 6 from CMYK, in the engine
  worker (the canvas waits meanwhile; a large conversion says it's
  working). Uniform tiles are converted once.
- **CMYK colour adjustments** cost two table lookups a pixel more than
  RGB's, and the profile's tables once per session (0.5 s in the worker,
  the first time a CMYK document's colour adjustment is drawn).
- **Writing a PSD** costs, for each shape and text layer, rendering its
  tiles at full size and reading them back; for each pixel layer, copying
  its tiles' rows into the file's planes; the composite, rendered tile row
  by tile row and read back; then PackBits on every row of every channel.
  Readbacks wait behind whatever else the GPU has queued, so several are
  kept in flight. Opening one is parsing and unpacking every channel,
  then making tiles, in the engine worker.
- **Masks** cost a sample of the mask (and two blur passes when feathered)
  per tile where the mask has tiles; a mask that's one value across a tile
  is a number, with no pass at all.
- **Frames while moving** cost under a millisecond of CPU and never wait on
  a tile: what's already rendered (or a coarser level of it) is drawn
  through the new view at once, and new tiles fill in over the next frames.
  Up to two frames are in flight on the GPU.

## The 16-bit compositing format

Decided 10 October 2026, phase 4, by measurement (`check:gpu` for precision,
`npm run bench` for time and memory).

Composite tiles are storage buffers, not textures (ARCHITECTURE.md, "The
render graph"), so the format is a choice of number: f32 or f16. The
question was whether 16-bit documents can composite in f16, as 8-bit ones
can, or need f32.

| | Worst error against the CPU reference, every blend mode and operation | GPU time, 8 layers × 16 tiles | Composite tile, RGB |
| --- | --- | --- | --- |
| 8-bit in f32 | 3.4 × 10⁻⁷ | 7.9–8.9 ms | 1 MB |
| 8-bit in f16 | 7.4 × 10⁻⁴ (an 8-bit step is 3.9 × 10⁻³) | 7.1–8.1 ms | 512 KB |
| 16-bit in f32 | 5.4 × 10⁻⁷ (a 16-bit step is 1.5 × 10⁻⁵) | 7.0–8.0 ms | 1 MB |
| 16-bit in f16 | 7.7 × 10⁻⁴, about 50 16-bit steps | 6.7–8.9 ms | 512 KB |

**8-bit documents composite in f16** where the device has `shader-f16`
(and in f32 where it doesn't): the error is under a fifth of an 8-bit step,
every 8-bit value survives the round trip exactly, and a composite tile takes
half the memory. The only visible difference is at exact ties: Hard Mix's
threshold falls the other way for pixels sitting exactly on it, which
`check:gpu` allows for.

**16-bit documents composite in f32.** f16 would throw away more than five
of their sixteen bits. Speed doesn't separate the two at all on this GPU:
the work is dominated by dispatches, not by bandwidth.

## GPU memory

Each tile format (mode and depth) has its own texture-array atlas, growing
by doubling up to 512 MB (or the device's array-layer limit), with
least-recently-used eviction. The display atlas (finished tiles, RGBA f16)
grows to 256 MB, and cached results (groups, layers' bodies for their
effects, the content a live filter gathers) to 192 MB. After the bench,
which touches three tile formats: tile atlases 808 MB in all, display atlas
256 MB, cached results 192 MB (the live blur's gathered tiles fill it to
its limit).

The tile budget is per format, so a session working in several modes at
once can hold more than 512 MB of tiles. One budget across every atlas is on
the deferred list.

## Log

- **13 Oct 2026, loading** (the pass's sixth step). The main chunk was
  998 KB (332 KB gzipped): every importer, exporter and dialog, and the
  text layout, whether a visit used them or not. A build reporting each
  chunk's modules showed what was there; they now load when first used.
  813 KB (266 gzipped), with PSD/SVG/PDF writing (49 KB), SVG reading
  (23 KB), the layout (42 KB) and the dialogs (60 KB) in chunks of their
  own. HarfBuzz's 910 KB of wasm was, and is, loaded only with the fonts.

- **13 Oct 2026, rendering and text** (the pass's fourth and fifth steps).
  The reopened PSD's draw, profiled: glyphs were flattened once per
  placement (49,000 for 41 glyphs), now once per glyph and transform and
  moved; the Layers panel's 212 thumbnails were made in the middle of the
  first draw, now after the canvas has drawn (`EngineHost.whenDrawn`) and
  eight at a time, with frames between; and each dispatch's parameters
  were a queue write of their own, now held on the CPU and sent in one
  before each submit. 2.83 s to 2.29–2.40; the dense text fitted 1.45 s to
  0.83–0.99; the 96 MP first picture 715–785 ms to 652–677 (its two
  thumbnails were made inside it). Text: paragraphs keep their shaping,
  line breaks and placed lines between layouts, so an edit lays out only
  what it changed (about 10 ms for 120 justified paragraphs, against about
  70 afresh, `check:text`), and shaping resolves fonts once a paragraph: a
  fresh layout of the bench's 60,000 characters 140 ms to 102. Then, from
  profiling an edit: a rectangular frame had never been recognised as one,
  so every-line composition (Knuth–Plass) had never run, and the earlier
  figures here for "justified, every-line" text were single-line's. With it
  running: 116 ms for the 60,000 characters, still well within 1 s. The bench's fresh layout now lays out a
  deep copy, since a shallow one shares the paragraphs, and so the cache.
  At 100% over the text, every tile drawn: 921 ms in the last run (500 to
  1,050 over the runs since 11 Oct; close to its budget, and noisy).

- **12 Oct 2026, the engine's CPU work** (the pass's third step). The
  ellipse: each of a tile row's 1,024 sub-rows tested every edge of the
  polygon (4,096 for a big ellipse); edges are now sorted into bands of
  rows, 736 ms to 213–234. Feathering: tiles whose whole neighbourhood is
  one value are known from the tiles' bookkeeping without building their
  window, the blur's columns are swept a row at a time (memory read in
  order, the same sums), and decoded tiles are let go once passed: 1.32 s
  to 0.73. Expand and Contract take the most or least over a square in
  three comparisons a pixel whatever the radius (van Herk and Gil-Werman),
  where trying the square cost 2r: 150 to 210 ms an edge tile at 50 px
  before, 13 ms. Reopening the PSD: rows copied as they are when the depth
  doesn't change, and the merged image not decoded: 20.3 s to 14.3. Writing
  the PSD (34 s) was profiled before anything was changed: two changes the
  review proposed (`packBits` into a buffer, 16-bit samples without
  DataView) measured no faster and weren't kept; the time is per-pixel
  work on the CPU (log above, and ROADMAP.md).

- **12 Oct 2026, the interface with two hundred layers.** Measured on a
  production build (`vite preview`; the dev server's React is several
  times slower and mostly measures itself): each change timed from the
  call until the page is idle, 40 times. Choosing a tool took 16.7 ms
  (p95 20), selecting a layer 17.4 ms, a commit 6 ms. JavaScript was a
  small part: a trace put about 10 ms of each in Layerize, Chrome working
  out composited layers, because each layer's thumbnail was a canvas on
  the GPU, and a GPU canvas is a layer of its own. The thumbnails (and the
  Brushes panel's previews, and the tip picker's) are now drawn on the CPU
  (`willReadFrequently`): a tool chosen in 4.9 ms (p95 7.4), a layer
  selected in 8.9 ms, a commit 6.2 ms. With it: the panels are memoised
  and get the same action functions every render (lib/stable.ts), the
  thumbnails' bookkeeping is worked out once per document state, the key
  listeners are added once (not again on every commit, with every
  command's keys parsed again), the canvas's box is read once a frame
  while the pointer moves, and a document's overlay is sent once for
  whatever changed it in one go.

- **12 Oct 2026, the quality and performance pass, first fixes.** Every
  budget is met.
  - *Panning with shapes, over text and proofed* (64 to 66 ms a frame
    since guides, against 33.3): not the GPU. The page re-rendered the
    whole app on every engine frame: App subscribed to the engine's whole
    state, and each `frame` message made a new one. With 200-odd layers
    the page fell behind, and the engine only draws when the page sends a
    view. App now follows only the engine's health (status, GPU, reason,
    error); the status bar and the Graphics Information dialog follow the
    frames. All three back at 33.3 ms over 120 frames.
  - *The reopened PSD drawn fitted*: 3.38 to 3.48 s before, measured with
    the bench's new `BENCH_PROFILE` (CPU profiles of the page and the
    engine from the reopening until it's drawn). Three things: the CMYK
    adjustment tables were built again (380 ms) because the reopened
    document named an embedded copy of Generic CMYK, not the built-in (a
    profile Plexel wrote is now recognised as its built-in, the header's
    date and ID aside); uploads interleaved every tile's samples on the
    CPU (850 ms), now packed by a render pass from the samples as the
    store holds them; and outlines' segments were made through a matrix
    that returned an array a point. 2.83 s. The rest is outlining the 192
    shapes and 49,000 glyphs at the coarse level (about 1 s) and the
    tiles' uploads themselves.
  - *Uploads*: 650 to 840 MB/s before, 910 to 1,120 MB/s for RGB 8-bit,
    RGB 16-bit and CMYK 8-bit. The first picture of the 96 MP document
    didn't change (715 to 785 ms): it's bound by something else, not timed
    apart yet.
  - PSD open no longer decodes the merged composite when there are layers.

- **11 Oct 2026, after guides, grids and snapping: panning with shapes,
  text and proofing.** Three runs of the bench miss three panning budgets
  that were met before: panning with the two hundred shapes, over the
  dense text, and proofed, each at a 64 to 66 ms median frame interval
  (p95 about 147 ms) against the display's 33.3 ms, and over about 260
  frames rather than 120. CPU time a frame is 0.2 to 0.5 ms, well under
  its budget (it was 3.6 to 5.3 ms with the shapes before), so the frames
  wait on the GPU. Every earlier pan in the same runs (plain, with a mask
  and ants, with adjustments and a blur) is at 33.3 ms. It isn't this
  phase's overlay: with the guides and grids taken out of the overlay
  altogether, a third run measured the same 64 to 65 ms. The three scenes
  share the shapes (the later scenes keep them), so the shapes' drawing on
  this machine and driver is the first suspect. At 100% over the text was
  drawn in 1.05 s in one run (a miss) and within 1 s in the next. Open, to
  be looked at in the next performance pass, alongside the reopened PSD
  (3.58 to 3.66 s in these runs).

- **11 Oct 2026, after phase 14, the reopened PSD**: the bench's 107 ms for
  drawing the reopened PSD fitted was never a finished picture. It took the
  last frame after polling once a second, and the first frames after
  opening report nothing pending because the new document hasn't started
  drawing yet; a poll that landed then counted it done. The bench now
  waits for the first frame with the reopened document's tiles to draw,
  then for one with nothing left: 3.37 to 3.58 s over four runs, over the
  3 s budget. The time goes on the first frames at that level (0.5 to 1 s a
  frame, a tile or two each): laying out the 60,000 characters of text
  again and outlining the 192 shapes, as the original document's fitted
  text alone takes 1.76 s. Phase 14 didn't change this path (the reopened
  document has no fill layers). Open, to be looked at: drawing the text's
  tiles first at a coarser level, or keeping outlines from the original
  across the round trip, would bring it under. Every other budget is met.

- **11 Oct 2026, the sampling brushes**, from the bench's first run with
  the Mixer Brush and Smudge. Each dab picks up a 64 × 64 patch and puts it
  down over its box, two compute passes a dab where the Brush has one
  stamp for a frame's dabs; on the 96 MP document the same 480-sample
  stroke kept to the display (33.4 ms) with 1.4 to 1.8 ms of CPU a frame at
  the 95th percentile, against the Brush's 1.0 ms. Their bake is quicker
  than the Brush's (35 to 39 ms against 131 ms) because the stroke tile
  already holds the paint, not coverage to blend. The bench now fills its
  brush settings from the app's defaults, so it paints what the app would
  after phase 12's new sections. The first run was cut short by the dev
  server reloading the page when a source file changed under it: don't
  edit `src/` while the bench runs.

- **11 Oct 2026, writing PSD**, from the bench's first run with
  interchange. Writing the 96 MP CMYK document as a PSD didn't finish in
  the three minutes the bench allowed. Three things, measured in turn:
  each layer's pixels were copied out of the tiles one pixel and one
  channel at a time, and CMYK inverted through a closure (5.5 s a 96 MP
  layer; row by row with uniform tiles filled, 0.2 to 0.75 s); each
  shape's readback waited about 220 ms behind the queue whatever its size,
  one band of tiles at a time, so 200 shapes took 263 s (with four bands
  in flight and four layers at once, 32.5 s for layers and composite);
  and with the reads in flight, tiles made from them belonged to no set
  while they waited, so a collection could take them ("No tile 4045"):
  they're now made only once the read is done, as baking already did
  through a selection (which had the same gap, and now doesn't). Then the
  reopened document never finished drawing: dense text fitted on screen
  put 16.7 MB of glyph segments into one tile, more than the 8 MB storage
  ring a frame has, and the tile was retried every frame for ever. A write
  bigger than the ring now gets a buffer of its own for the frame
  (`check:type` holds it). The same bug froze the 60,000-character
  document at other sizes than the bench's.

- **11 Oct 2026, converting pixels**, from the bench's first run with print
  colour. Converting the 96 MP document to CMYK through LittleCMS's float
  transform, pixel by pixel, took 54 s against a 20 s budget: about 2
  megapixels a second in WebAssembly, which evaluates the profile's whole
  pipeline each time. Sampling the conversion on a grid once and
  interpolating each pixel, as LittleCMS's own optimised transforms do,
  takes 12.9 s. Interpolating gamma-encoded RGB in straight lines was up
  to 3.6 ΔE2000 off in the deepest shadows; storing the outputs roughly
  linear (raised to 2.2) brought every case within 0.8 (`check:print`).
  The CMYK adjustment tables took 1.4 s to solve with Newton's method on
  differences; on the forward table's own tetrahedra, where the Jacobian is
  exact, 0.5 s.

- **11 Oct 2026, dense text**, from the bench's first run with text. All
  the budgets were met but one: panning over the text took 10.4 ms of CPU
  at the 95th percentile, against 8. The frames that went over were those
  that drew tiles: every tile read its whole band of rows (the page's
  width of text) and summed a backdrop row by row for each segment left of
  it, and each new band scanned every segment of the outline to find its
  own. Each band is now
  sorted by tile column too, with the backdrop of everything left of a
  column summed once (exactly the same coverage; `check:geom` compares
  them): 7.8 ms. Then every band is sorted out in one pass over the
  outline, the first time any tile asks: 4.7 ms. Two hundred shapes'
  panning went from 4.1 to 3.6 ms with it. The rasterizer itself needed
  nothing more (no sparse strips): the GPU kept the display's rate
  throughout.

- **11 Oct 2026, vectors under load**, from the bench's first run with
  shapes. A long path's stroke overflowed the call stack while its outline
  was built (an array spread into `push`), and the error stopped every frame
  of the document: the canvas froze. Outlines are now built element by
  element, and a shape that can't be worked out draws nothing and is logged.
  Then each tile scanned all 239,000 segments of that stroke, and every one
  to the left of the tile came to the GPU as a segment of its own: segments
  are now sorted into bands of tile rows once, and what lies left of a tile
  is summed into one backdrop number a row. The view drew again in 253 ms.
  Panning still ran at 38 ms against 33.3: not the GPU (giving each
  workgroup only its 16 rows' segments changed nothing) but the page, which
  re-rendered the whole app, the 200-row Layers panel with it, on every
  frame of the pan, because the status bar's zoom was read at the top.
  Only the status bar follows the view now: 33.4 ms.

- **10 Oct 2026, the Magic Wand's tiles**: making the selection from the
  wand's flood fill visited every pixel of the canvas with a 3 × 3
  anti-aliasing neighbourhood: 6.1 s on the 96 MP document, against a 3 s
  budget. Counting each tile's hits first, it skips tiles with nothing
  selected near them and writes tiles full of hits (with full tiles all
  round) as one uniform tile; half floats read back go through a table
  instead of a function. 1.74 s.

- **11 Oct 2026, mips by content**: mip tiles were keyed by tile set, so
  every committed stroke made a new set whose whole pyramid was built
  again the next time the layer was seen zoomed out. Keyed by a hash of the
  tiles under them, a stroke rebuilds only the mips above the tiles it
  changed. Made with painting, by design rather than after a measurement;
  the bench doesn't time zoomed-out redraws after a stroke yet.

- **10 Oct 2026, uploads and frames in flight**, made together. Tiles were
  interleaved for the atlas sample by sample; whole pixels as 32-bit words
  is four times fewer stores. And a frame waited for the previous one to
  finish on the GPU before it was built; now two may be in flight. RGB 8-bit
  uploads went from 500 to 650–840 MB/s, and the 96 MP document's first
  picture from 1,350 ms to about 700 ms. Frame intervals were 33.3 ms before
  and after: headless Chrome's display is 30 Hz, so the second change only
  shows where a frame takes the GPU longer than the gap between refreshes.
