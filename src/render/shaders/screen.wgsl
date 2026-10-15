// The view: the pasteboard, the transparency checkerboard and the
// document's display tiles, drawn through the view transform.
//
// One triangle that covers the whole target. Each fragment finds its
// position in up to three mip levels' tile grids (the level being drawn,
// then coarser ones to fall back on while it renders), each through its
// own transform worked out on the CPU in doubles relative to the grid's
// corner, so the floats here stay small at any zoom on any size of
// document. Display tiles are read by hand, so filtering crosses tile
// edges without seams: nearest when magnified, bilinear otherwise.
//
// Over that, the alpha and spot channels shown: an alpha's tint over what
// it masks (or selects), a spot's ink over the image; with the colour
// channels hidden, paper, and the first alpha as gray. Then the selection:
// its coverage at the level being drawn, from its own atlas, as marching
// ants where it crosses half, or in Quick Mask as a red tint over what
// isn't selected; and a crop's shade. The channels' coverage is in the
// same atlas, each with its own stretch of `sel_tiles`.
//
// A tiled document in Tiled View repeats: a pixel in a copy is moved into
// the document by whole periods first (exactly, in the finest level's
// pixels), and a level's reads wrap at its edge, so filtering crosses the
// seam too. The selection and the overlay show on the document alone.

struct Level {
  // Device pixel to this level's pixels, relative to the grid's first tile:
  // x' = m0.x·x + m0.z·y + m1.x, y' = m0.y·x + m0.w·y + m1.y.
  m0: vec4f,
  m1: vec4f,
  // The grid: its first tile, as an absolute tile index, and its size.
  grid: vec4i,
  // Where its entries start in `tiles`, the document's size in tiles at
  // this level, and whether the level is in use.
  info: vec4u,
  // The document's size in this level's pixels, rounded up, and 1 where it
  // wraps across and down.
  px: vec4i,
}

struct Screen {
  pasteboard: vec4f,
  check_a: vec4f,
  check_b: vec4f,
  // The checkerboard square in device pixels, its origin, and 1 for
  // nearest-neighbour sampling of the finest level.
  check: vec4f,
  // The document's rectangle in the finest level's pixels, relative to
  // its grid: left, top, right, bottom.
  doc: vec4f,
  // The brush cursor: centre and radius in device pixels, and 1 to show it.
  cursor: vec4f,
  // 1 when the selection's coverage is there to draw, 1 for Quick Mask,
  // the ants' crawl in pixels, and 1 to draw the shade.
  sel: vec4f,
  // The shade's hole, a quadrilateral in device pixels: corners 0 and 1, then 2 and 3.
  shade0: vec4f,
  shade1: vec4f,
  // 1 where the view repeats the document across, and down.
  wrap: vec4f,
  levels: array<Level, 3>,
  // The alpha and spot channels shown, and 1 when the colour channels are all hidden.
  chans: vec4f,
  // Per channel: its colour (display) and opacity or solidity; then its kind (0 an alpha
  // marking what's masked, 1 what's selected, 2 a spot) and where its tiles start in sel_tiles.
  chan: array<vec4f, 8>,
}

@group(0) @binding(0) var<uniform> S: Screen;
// Per grid cell: a display atlas layer, -1 for not rendered yet, -2 for
// rendered and empty.
@group(0) @binding(1) var<storage, read> tiles: array<i32>;
@group(0) @binding(2) var atlas: texture_2d_array<f32>;
// The selection's coverage tiles for the finest level's grid, as `tiles`
// has its first level: an atlas layer, -1 not ready, -2 none, -3 all.
@group(0) @binding(3) var<storage, read> sel_tiles: array<i32>;
@group(0) @binding(4) var sel_atlas: texture_2d_array<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);
}

const MISSING = vec4f(-1.0);

// A level pixel, relative to its grid, brought back into the document
// where the level wraps: only ever a pixel or so past the edge, as the
// position was moved into the document before.
fn wrapped(L: Level, i: i32, first: i32, size: i32, on: i32) -> i32 {
  if (on == 0 || size <= 0) { return i; }
  let a = i + first * 256;
  let w = ((a % size) + size) % size;
  return w - first * 256;
}

fn fetch(j: u32, jx: i32, jy: i32) -> vec4f {
  let L = S.levels[j];
  let ix = wrapped(L, jx, L.grid.x, L.px.x, L.px.z);
  let iy = wrapped(L, jy, L.grid.y, L.px.y, L.px.w);
  let tx = ix >> 8u;
  let ty = iy >> 8u;
  let ax = tx + L.grid.x;
  let ay = ty + L.grid.y;
  // Outside the document is transparent, not missing.
  if (ax < 0 || ay < 0 || ax >= i32(L.info.y) || ay >= i32(L.info.z)) { return vec4f(0.0); }
  if (tx < 0 || ty < 0 || tx >= L.grid.z || ty >= L.grid.w) { return MISSING; }
  let e = tiles[L.info.x + u32(ty * L.grid.z + tx)];
  if (e == -1) { return MISSING; }
  if (e == -2) { return vec4f(0.0); }
  return textureLoad(atlas, vec2i(ix & 255, iy & 255), e, 0);
}

fn sample_level(j: u32, p: vec2f, nearest: bool) -> vec4f {
  let L = S.levels[j];
  let q = vec2f(L.m0.x * p.x + L.m0.z * p.y + L.m1.x, L.m0.y * p.x + L.m0.w * p.y + L.m1.y);
  if (nearest) {
    return fetch(j, i32(floor(q.x)), i32(floor(q.y)));
  }
  let t = q - 0.5;
  let i = vec2i(floor(t));
  let f = t - floor(t);
  let a = fetch(j, i.x, i.y);
  let b = fetch(j, i.x + 1, i.y);
  let c = fetch(j, i.x, i.y + 1);
  let d = fetch(j, i.x + 1, i.y + 1);
  if (a.x < 0.0 || b.x < 0.0 || c.x < 0.0 || d.x < 0.0) { return MISSING; }
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// The brush cursor: a white ring inside a black one, so it shows on any
// colour, and a small cross when the brush is too small for a ring to read.
fn with_cursor(c: vec4f, pos: vec2f) -> vec4f {
  if (S.cursor.w < 0.5) { return c; }
  let d = distance(pos, S.cursor.xy);
  let r = S.cursor.z;
  var out = c.rgb;
  if (r < 3.0) {
    let o = abs(pos - S.cursor.xy);
    if ((o.x < 0.6 && o.y < 5.0) || (o.y < 0.6 && o.x < 5.0)) { out = select(vec3f(0.0), vec3f(1.0), (o.x + o.y) < 2.5); }
    return vec4f(out, 1.0);
  }
  let k = 1.0 - smoothstep(0.4, 1.0, abs(d - r));
  let j = 1.0 - smoothstep(0.4, 1.0, abs(d - r - 1.4));
  out = mix(out, vec3f(0.0), j * 0.85);
  out = mix(out, vec3f(1.0), k * 0.9);
  return vec4f(out, 1.0);
}

// The selection's coverage at a device pixel: 0..1, or -1 where it isn't ready.
fn sel_at(p: vec2f) -> f32 {
  return cover_at(0u, p);
}

// A coverage at a device pixel, its tiles from `start` in sel_tiles: 0..1, or -1 where it isn't ready.
fn cover_at(start: u32, p: vec2f) -> f32 {
  let L = S.levels[0];
  let q = vec2f(L.m0.x * p.x + L.m0.z * p.y + L.m1.x, L.m0.y * p.x + L.m0.w * p.y + L.m1.y);
  if (q.x < S.doc.x || q.y < S.doc.y || q.x >= S.doc.z || q.y >= S.doc.w) { return 0.0; }
  let ix = i32(floor(q.x));
  let iy = i32(floor(q.y));
  let tx = ix >> 8u;
  let ty = iy >> 8u;
  if (tx < 0 || ty < 0 || tx >= L.grid.z || ty >= L.grid.w) { return -1.0; }
  let e = sel_tiles[start + u32(ty * L.grid.z + tx)];
  if (e == -1) { return -1.0; }
  if (e == -2) { return 0.0; }
  if (e == -3) { return 1.0; }
  return textureLoad(sel_atlas, vec2i(ix & 255, iy & 255), e, 0).x;
}

fn with_selection(c: vec4f, p: vec2f) -> vec4f {
  if (S.sel.x < 0.5) { return c; }
  let v = sel_at(p);
  if (v < 0.0) { return c; }
  if (S.sel.y > 0.5) {
    // Quick Mask: what isn't selected, under half-strength red.
    let L = S.levels[0];
    let q = vec2f(L.m0.x * p.x + L.m0.z * p.y + L.m1.x, L.m0.y * p.x + L.m0.w * p.y + L.m1.y);
    if (q.x < S.doc.x || q.y < S.doc.y || q.x >= S.doc.z || q.y >= S.doc.w) { return c; }
    return vec4f(mix(c.rgb, vec3f(1.0, 0.0, 0.0), 0.5 * (1.0 - v)), 1.0);
  }
  let inside = v >= 0.5;
  if (!inside) { return c; }
  var edge = false;
  var n = array<vec2f, 4>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0));
  for (var i = 0; i < 4; i++) {
    let u = sel_at(p + n[i]);
    if (u >= 0.0 && u < 0.5) { edge = true; }
  }
  if (!edge) { return c; }
  let on = (i32(floor((p.x + p.y + S.sel.z) / 4.0)) & 1) == 0;
  return select(vec4f(1.0, 1.0, 1.0, 1.0), vec4f(0.0, 0.0, 0.0, 1.0), on);
}

// The alpha and spot channels shown, over the image (or over paper, the colour hidden).
fn with_channels(c: vec4f, p: vec2f) -> vec4f {
  let n = u32(S.chans.x);
  let hidden = S.chans.y > 0.5;
  if (n == 0u && !hidden) { return c; }
  let L = S.levels[0];
  let q = vec2f(L.m0.x * p.x + L.m0.z * p.y + L.m1.x, L.m0.y * p.x + L.m0.w * p.y + L.m1.y);
  if (q.x < S.doc.x || q.y < S.doc.y || q.x >= S.doc.z || q.y >= S.doc.w) { return c; }
  var out = select(c.rgb, vec3f(1.0), hidden);
  var gray = hidden;
  for (var k = 0u; k < n; k++) {
    let colour = S.chan[k * 2u];
    let info = S.chan[k * 2u + 1u];
    let v = cover_at(u32(info.y), p);
    if (v < 0.0) { continue; }
    let kind = u32(info.x);
    if (kind == 2u) {
      // A spot ink: multiplied over what's under it, then towards the ink itself by its solidity.
      out = mix(out, mix(out * colour.rgb, colour.rgb, colour.w), v);
    } else if (gray) {
      // An alpha alone: white what's selected.
      out = vec3f(v);
      gray = false;
    } else {
      out = mix(out, colour.rgb, colour.w * select(1.0 - v, v, kind == 1u));
    }
  }
  return vec4f(out, 1.0);
}

fn cross2(a: vec2f, b: vec2f, p: vec2f) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

// A crop's shade: everything outside its quadrilateral, darkened.
fn with_shade(c: vec4f, p: vec2f) -> vec4f {
  if (S.sel.w < 0.5) { return c; }
  let a = S.shade0.xy;
  let b = S.shade0.zw;
  let d = S.shade1.xy;
  let e = S.shade1.zw;
  let k0 = cross2(a, b, p);
  let k1 = cross2(b, d, p);
  let k2 = cross2(d, e, p);
  let k3 = cross2(e, a, p);
  let inside = (k0 >= 0.0 && k1 >= 0.0 && k2 >= 0.0 && k3 >= 0.0) || (k0 <= 0.0 && k1 <= 0.0 && k2 <= 0.0 && k3 <= 0.0);
  if (inside) { return c; }
  return vec4f(c.rgb * 0.4, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return with_cursor(with_shade(with_selection(with_channels(scene(pos), pos.xy), pos.xy), pos.xy), pos.xy);
}

// A device pixel in a copy of a tiled document, moved by whole periods to
// the same place in the document itself.
fn into_doc(p: vec2f) -> vec2f {
  if (S.wrap.x < 0.5 && S.wrap.y < 0.5) { return p; }
  let L0 = S.levels[0];
  let q = vec2f(L0.m0.x * p.x + L0.m0.z * p.y + L0.m1.x, L0.m0.y * p.x + L0.m0.w * p.y + L0.m1.y);
  let size = S.doc.zw - S.doc.xy;
  var d = vec2f(0.0);
  if (S.wrap.x > 0.5) { d.x = -floor((q.x - S.doc.x) / size.x) * size.x; }
  if (S.wrap.y > 0.5) { d.y = -floor((q.y - S.doc.y) / size.y) * size.y; }
  // Back to device pixels through the inverse of the level's 2×2.
  let det = L0.m0.x * L0.m0.w - L0.m0.z * L0.m0.y;
  return p + vec2f(L0.m0.w * d.x - L0.m0.z * d.y, -L0.m0.y * d.x + L0.m0.x * d.y) / det;
}

fn scene(pos: vec4f) -> vec4f {
  let L0 = S.levels[0];
  let p = into_doc(pos.xy);
  let q = vec2f(L0.m0.x * p.x + L0.m0.z * p.y + L0.m1.x, L0.m0.y * p.x + L0.m0.w * p.y + L0.m1.y);
  let outX = S.wrap.x < 0.5 && (q.x < S.doc.x || q.x >= S.doc.z);
  let outY = S.wrap.y < 0.5 && (q.y < S.doc.y || q.y >= S.doc.w);
  if (L0.info.w == 0u || outX || outY) {
    return S.pasteboard;
  }
  var px = vec4f(0.0);
  for (var j = 0u; j < 3u; j++) {
    if (S.levels[j].info.w == 0u) { break; }
    let s = sample_level(j, p, j == 0u && S.check.w > 0.5);
    if (s.x >= 0.0) {
      px = s;
      break;
    }
  }
  // Squares counted from the document's corner on screen, so the pattern
  // doesn't crawl as the view moves (in a copy, from the document's).
  let cell = floor((p - S.check.yz) / S.check.x);
  let odd = (i32(cell.x) + i32(cell.y)) & 1;
  let checker = select(S.check_a, S.check_b, odd == 1);
  return vec4f(px.rgb + checker.rgb * (1.0 - px.a), 1.0);
}
