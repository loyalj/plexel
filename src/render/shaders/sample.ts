/**
 * The sampling brushes on the GPU: ref/sample.ts, two kernels a dab.
 *
 * `pick` runs once per texel of the carried patch: it finds where the
 * texel falls in the layer, reads the canvas there (the layer through the
 * same window table the compositor uses, with this stroke so far laid on:
 * composite.ts `texel`), bilinearly, and changes what the brush carries.
 *
 * `deposit` runs over the dab's box: each pixel's tip coverage (with Noise
 * and Wet Edges) and the carried paint under it give the paint the layer
 * goes towards and how far; that's combined into the stroke tile's pixel
 * as successive replacements combine.
 *
 * Run as pick, deposit, pick, deposit... in separate passes, so each dab
 * picks up what the ones before it put down. The Mixer's pick-up dirties
 * its reservoir too.
 */
import type { ColourMode, Depth } from '../../doc/types'
import { OPS_WGSL, blendWgsl, pixelSourceWgsl, strokeWgsl } from './composite'
import { bufferAccess, preamble, type BufferFormat } from './common'
import { brushWgsl } from './paint'
import { PATCH } from '../ref/sample'

/** PickParams: see the struct. */
export const PICK_PARAMS_BYTES = 144
/** DepositParams: see the struct. */
export const DEPOSIT_PARAMS_BYTES = 144

export function pickWgsl(mode: ColourMode, depth: Depth): string {
  const n = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  return `${preamble({ mode, store: 'f32' })}
struct Params {
  // A⁻¹: tip space to layer offsets.
  ainv: vec4f,
  // The dab's centre, relative to the window's first tile (layer pixels); smudge's keep share; mixer's pick-up share.
  c: vec4f,
  win: vec4i,
  stroke: vec4u,
  stroke_colour: vec4f,
  // Smudge 0 or Mixer 1; whether this is the stroke's first dab; Finger Painting; the filter (unused: reads are bilinear here).
  kind: u32,
  first: u32,
  finger: u32,
  resample: u32,
  // The foreground, premultiplied; its alpha, and how far the Mixer's reservoir goes towards what it picks up.
  fg: vec4f,
  fga: vec4f,
  // A tiled document: the period across and down in layer pixels (0 where it doesn't repeat), and the
  // canvas's corner relative to the window.
  wrap: vec4i,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(12) var<storage, read_write> carried: array<f32>;
@group(0) @binding(13) var<storage, read_write> reservoir: array<f32>;

${blendWgsl(mode)}
${OPS_WGSL}
${strokeWgsl(mode)}
${pixelSourceWgsl(mode, depth, true)}

const PATCH: u32 = ${PATCH}u;
const N: u32 = ${n}u;

// A read past a tiled document's edge comes from the other side.
fn wrap_axis(i: i32, size: i32, corner: i32) -> i32 {
  if (size <= 0) { return i; }
  return corner + (((i - corner) % size) + size) % size;
}

fn wtexel(ix: i32, iy: i32) -> Px {
  return texel(wrap_axis(ix, P.wrap.x, P.wrap.z), wrap_axis(iy, P.wrap.y, P.wrap.w));
}

fn canvas_at(p: vec2f) -> Px {
  let f = p - 0.5;
  let i0 = vec2i(floor(f));
  let t = f - floor(f);
  let a = wtexel(i0.x, i0.y);
  let b = wtexel(i0.x + 1, i0.y);
  let c = wtexel(i0.x, i0.y + 1);
  let d = wtexel(i0.x + 1, i0.y + 1);
  let top = Px(mix(a.c, b.c, t.x), mix(a.a, b.a, t.x));
  let bottom = Px(mix(c.c, d.c, t.x), mix(c.a, d.a, t.x));
  return Px(mix(top.c, bottom.c, t.y), mix(top.a, bottom.a, t.y));
}

@compute @workgroup_size(16, 16)
fn pick(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= PATCH || g.y >= PATCH) { return; }
  let u = (vec2f(g.xy) + 0.5) / f32(PATCH) * 2.0 - 1.0;
  let p = P.c.xy + vec2f(P.ainv.x * u.x + P.ainv.y * u.y, P.ainv.z * u.x + P.ainv.w * u.y);
  let C = canvas_at(p);
  let o = (g.y * PATCH + g.x) * (N + 1u);
  let first = P.first == 1u;
  if (P.kind == 0u) {
    if (first) {
      var src = C;
      if (P.finger == 1u) { src = Px(P.fg, P.fga.x); }
      for (var c = 0u; c < N; c++) { carried[o + c] = src.c[c]; }
      carried[o + N] = src.a;
    } else {
      let k = P.c.z;
      for (var c = 0u; c < N; c++) { carried[o + c] = carried[o + c] * k + C.c[c] * (1.0 - k); }
      carried[o + N] = carried[o + N] * k + C.a * (1.0 - k);
    }
  } else {
    let w = select(P.c.w, 1.0, first);
    for (var c = 0u; c <= N; c++) {
      let v = select(C.a, C.c[min(c, 3u)], c < N);
      carried[o + c] = carried[o + c] + (v - carried[o + c]) * w;
      reservoir[o + c] = reservoir[o + c] + (carried[o + c] - reservoir[o + c]) * P.fga.y;
    }
  }
}
`
}

/** PickAllParams: see the struct. */
export const PICK_ALL_PARAMS_BYTES = 112

/**
 * Picking up with Sample All Layers: the same, from the document as it
 * shows (its composite tiles, rendered for the frame into one window
 * buffer), at each patch texel's place in the document.
 */
export function pickAllWgsl(f: BufferFormat): string {
  const n = f.mode === 'rgb' ? 3 : f.mode === 'gray' ? 1 : 4
  return `${preamble(f)}
struct Params {
  ainv: vec4f,
  // The dab's centre in layer pixels; smudge's keep share; mixer's pick-up share.
  c: vec4f,
  // The layer's transform (layer to document), its translation moved to the window's first pixel; then how far
  // the Mixer's reservoir goes towards what it picks up.
  t: vec4f,
  t2: vec4f,
  // The window: its tiles across and down; then Smudge 0 or Mixer 1, first dab, Finger Painting.
  win: vec4u,
  fg: vec4f,
  // A tiled document: its size where it repeats (0 where not), and the window's corner in document pixels.
  wrap: vec4i,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> comp: array<T>;
@group(0) @binding(2) var<storage, read_write> carried: array<f32>;
@group(0) @binding(3) var<storage, read_write> reservoir: array<f32>;

${bufferAccess(f, 'comp', false)}

const PATCH: u32 = ${PATCH}u;
const N: u32 = ${n}u;

fn comp_at(jx: i32, jy: i32) -> Px {
  var x = jx;
  var y = jy;
  // Past a tiled document's edge, from the other side.
  if (P.wrap.x > 0) { x = (((x + P.wrap.z) % P.wrap.x) + P.wrap.x) % P.wrap.x - P.wrap.z; }
  if (P.wrap.y > 0) { y = (((y + P.wrap.w) % P.wrap.y) + P.wrap.y) % P.wrap.y - P.wrap.w; }
  if (x < 0 || y < 0) { return Px(vec4f(0.0), 0.0); }
  let tx = u32(x) >> 8u;
  let ty = u32(y) >> 8u;
  if (tx >= P.win.x || ty >= P.win.y) { return Px(vec4f(0.0), 0.0); }
  return load_comp((ty * P.win.x + tx) * 65536u + (u32(y) & 255u) * 256u + (u32(x) & 255u));
}

@compute @workgroup_size(16, 16)
fn pick(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= PATCH || g.y >= PATCH) { return; }
  let u = (vec2f(g.xy) + 0.5) / f32(PATCH) * 2.0 - 1.0;
  let pl = P.c.xy + vec2f(P.ainv.x * u.x + P.ainv.y * u.y, P.ainv.z * u.x + P.ainv.w * u.y);
  let p = vec2f(P.t.x * pl.x + P.t.z * pl.y + P.t2.x, P.t.y * pl.x + P.t.w * pl.y + P.t2.y);
  let f = p - 0.5;
  let i0 = vec2i(floor(f));
  let t = f - floor(f);
  let a = comp_at(i0.x, i0.y);
  let b = comp_at(i0.x + 1, i0.y);
  let c = comp_at(i0.x, i0.y + 1);
  let d = comp_at(i0.x + 1, i0.y + 1);
  let C = Px(mix(mix(a.c, b.c, t.x), mix(c.c, d.c, t.x), t.y), mix(mix(a.a, b.a, t.x), mix(c.a, d.a, t.x), t.y));
  let o = (g.y * PATCH + g.x) * (N + 1u);
  let first = P.win.w == 1u || P.win.w == 3u;
  if (P.win.z == 0u) {
    if (first) {
      var src = C;
      if (P.win.w >= 2u) { src = Px(P.fg, 1.0); }
      for (var k = 0u; k < N; k++) { carried[o + k] = src.c[k]; }
      carried[o + N] = src.a;
    } else {
      let k0 = P.c.z;
      for (var k = 0u; k < N; k++) { carried[o + k] = carried[o + k] * k0 + C.c[k] * (1.0 - k0); }
      carried[o + N] = carried[o + N] * k0 + C.a * (1.0 - k0);
    }
  } else {
    let w = select(P.c.w, 1.0, first);
    for (var k = 0u; k <= N; k++) {
      let v = select(C.a, C.c[min(k, 3u)], k < N);
      carried[o + k] = carried[o + k] + (v - carried[o + k]) * w;
      reservoir[o + k] = reservoir[o + k] + (carried[o + k] - reservoir[o + k]) * P.t2.z;
    }
  }
}
`
}

export function depositWgsl(mode: ColourMode): string {
  const n = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  return `
struct DepositParams {
  // Layer offset into tip space.
  a: vec4f,
  // Centre (layer pixels), anti-aliasing width, hardness.
  c: vec4f,
  // The box's first pixel (layer pixels), its width and height.
  box: vec4i,
  // The first tile the box reaches, and how many tiles across and down.
  tiles: vec4i,
  // Flow, tip (−1 round), the mix, the wetness (each as this dab has it).
  o: vec4f,
  // Smudge 0 or Mixer 1, Noise, Wet Edges, the Noise seed.
  flags: vec4u,
  // The layer's transform (layer to document), and the document's size: paint stops at the canvas's edge.
  t: vec4f,
  t2: vec4f,
  // How full the Mixer's reservoir is.
  r: vec4f,
}
@group(0) @binding(0) var<uniform> D: DepositParams;
@group(0) @binding(1) var<storage, read> carried: array<f32>;
@group(0) @binding(2) var<storage, read> reservoir: array<f32>;
@group(0) @binding(3) var<storage, read_write> stroke: array<f32>;
@group(0) @binding(4) var<storage, read> tips: array<f32>;
@group(0) @binding(5) var<storage, read> tiptable: array<u32>;
@group(0) @binding(6) var<storage, read> slots: array<i32>;

${brushWgsl}

const PATCH: u32 = ${PATCH}u;
const N: u32 = ${n}u;

fn patch_at(src: u32, u: vec2f, c: u32) -> f32 {
  let f = clamp((u + 1.0) * 0.5 * f32(PATCH) - 0.5, vec2f(0.0), vec2f(f32(PATCH - 1u)));
  let i0 = min(vec2u(floor(f)), vec2u(PATCH - 2u));
  let t = f - vec2f(i0);
  let s = N + 1u;
  var v = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let i = (i0.y + (k >> 1u)) * PATCH + i0.x + (k & 1u);
    if (src == 0u) { v[k] = carried[i * s + c]; } else { v[k] = reservoir[i * s + c]; }
  }
  return mix(mix(v.x, v.y, t.x), mix(v.z, v.w, t.x), t.y);
}

@compute @workgroup_size(16, 16)
fn deposit(@builtin(global_invocation_id) g: vec3u) {
  if (i32(g.x) >= D.box.z || i32(g.y) >= D.box.w) { return; }
  let ip = vec2i(D.box.x + i32(g.x), D.box.y + i32(g.y));
  let p = vec2f(ip) + 0.5;
  let doc = vec2f(D.t.x * p.x + D.t.z * p.y + D.t2.x, D.t.y * p.x + D.t.w * p.y + D.t2.y);
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= D.t2.z || doc.y >= D.t2.w) { return; }
  let o = p - D.c.xy;
  let u = vec2f(D.a.x * o.x + D.a.y * o.y, D.a.z * o.x + D.a.w * o.y);
  let m = dab_mask(u, D.o.y, D.c.w, D.c.z, D.flags.y == 1u, D.flags.z == 1u, ip, D.flags.w);
  if (m <= 0.0) { return; }
  let tile = vec2i(ip.x >> 8u, ip.y >> 8u) - D.tiles.xy;
  if (tile.x < 0 || tile.y < 0 || tile.x >= D.tiles.z || tile.y >= D.tiles.w) { return; }
  let slot = slots[tile.y * D.tiles.z + tile.x];
  if (slot < 0) { return; }
  var T: array<f32, ${n + 1}>;
  var k = 0.0;
  if (D.flags.x == 0u) {
    for (var c = 0u; c <= N; c++) { T[c] = patch_at(0u, u, c); }
    k = m * D.o.x;
  } else {
    // One paint: the canvas paint on the brush by mix and wetness, the reservoir's by the rest of the mix and what's left in it.
    let cs = D.o.z * D.o.w;
    let ra = patch_at(1u, u, N);
    let rs = (1.0 - D.o.z) * ra * D.r.x;
    let share = cs + rs;
    k = m * D.o.x * share;
    if (share > 0.0) {
      for (var c = 0u; c < N; c++) {
        let r1 = select(0.0, patch_at(1u, u, c) / ra, ra > 0.0);
        T[c] = (patch_at(0u, u, c) * cs + r1 * rs) / share;
      }
      T[N] = (patch_at(0u, u, N) * cs + rs) / share;
    }
  }
  // Written as k0 + k − k0·k, not 1 − (1 − k0)(1 − k): a tiny k would cancel to 0 and the paint divide by it.
  if (k <= 0.0) { return; }
  let px = u32(slot) * 65536u + u32(ip.y & 255) * 256u + u32(ip.x & 255);
  let b = px * (N + 2u);
  let k0 = stroke[b];
  let kk = k0 + k - k0 * k;
  for (var c = 0u; c <= N; c++) { stroke[b + 1u + c] = (stroke[b + 1u + c] * k0 * (1.0 - k) + T[c] * k) / kk; }
  stroke[b] = kk;
}
`
}
