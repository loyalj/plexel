/**
 * Stamping dabs into a stroke tile: ref/paint.ts `stamp`, on the GPU. One
 * invocation per pixel of the 256 × 256 tile, each walking the frame's new
 * dabs in order, so overlapping dabs build up exactly as on the CPU.
 *
 * A stroke tile is `stride` floats per pixel in the stroke buffer: the
 * coverage the layer gets; then, for a stroke-wide texture or a dual brush,
 * the main tip's own coverage and the dual brush's; then (for a stroke whose
 * colour varies) the straight colour.
 *
 * Image tips are read through their mip chains (brush/tips.ts `sampleTip`),
 * from one buffer of every tip's levels and a table of where each is.
 */
import { TIP_TABLE_STRIDE } from '../../brush/tips'

/** A dab, as six vec4s. */
export const DAB_FLOATS = 24
/** StampParams: see the struct below. */
export const STAMP_PARAMS_BYTES = 112

/** WGSL shared by the stamp and the sampling brushes: tips, noise, wet edges, textures. */
export const brushWgsl = `
const TIP_STRIDE: u32 = ${TIP_TABLE_STRIDE}u;

fn smooth01(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }

fn round_mask(r: f32, hardness: f32, aa: f32) -> f32 {
  let soft = max(1.0 - hardness, min(1.0, aa));
  return smooth01(clamp((1.0 - r) / soft, 0.0, 1.0));
}

fn tip_level(tip: u32, l: u32, u: vec2f) -> f32 {
  let o = tip * TIP_STRIDE;
  let w0 = tiptable[o];
  let h0 = tiptable[o + 1u];
  let m = f32(tiptable[o + 3u]);
  var w = w0;
  var h = h0;
  for (var i = 0u; i < l; i++) { w = max(1u, (w + 1u) / 2u); h = max(1u, (h + 1u) / 2u); }
  let s = f32(1u << l);
  let f = vec2f(((u.x + 1.0) * 0.5 * m - (m - f32(w0)) * 0.5) / s - 0.5, ((u.y + 1.0) * 0.5 * m - (m - f32(h0)) * 0.5) / s - 0.5);
  let i0 = vec2i(floor(f));
  let t = f - floor(f);
  let base = tiptable[o + 4u + l];
  var v = vec4f(0.0);
  for (var k = 0; k < 4; k++) {
    let x = i0.x + (k & 1);
    let y = i0.y + (k >> 1);
    if (x >= 0 && y >= 0 && x < i32(w) && y < i32(h)) { v[k] = tips[base + u32(y) * w + u32(x)]; }
  }
  return mix(mix(v.x, v.y, t.x), mix(v.z, v.w, t.x), t.y);
}

fn tip_sample(tip: u32, u: vec2f, aa: f32) -> f32 {
  let o = tip * TIP_STRIDE;
  let levels = tiptable[o + 2u];
  let m = f32(tiptable[o + 3u]);
  let lod = min(f32(levels - 1u), max(0.0, log2(max(1.0, aa * m * 0.5))));
  let l0 = u32(floor(lod));
  let l1 = min(levels - 1u, l0 + 1u);
  let fr = lod - f32(l0);
  let a = tip_level(tip, l0, u);
  if (fr > 0.0 && l1 != l0) { return a + (tip_level(tip, l1, u) - a) * fr; }
  return a;
}

fn hash01(x: i32, y: i32, seed: u32) -> f32 {
  var h = (bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u) ^ (seed * 83492791u);
  h = h ^ (h >> 16u);
  h = h * 0x7feb352du;
  h = h ^ (h >> 15u);
  h = h * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}

fn noisy(m: f32, n: f32) -> f32 { return clamp(m + (n - 0.5) * 1.5 * (1.0 - abs(2.0 * m - 1.0)), 0.0, 1.0); }

fn edgeness(is_round: bool, r: f32, m: f32) -> f32 {
  if (is_round) { return smooth01(clamp((r - 0.55) / 0.45, 0.0, 1.0)); }
  return clamp((1.0 - m) * 1.6, 0.0, 1.0);
}

// A dab's coverage at tip-space point u, with Noise and Wet Edges: dab.ts dabMask.
fn dab_mask(u: vec2f, tip: f32, hardness: f32, aa: f32, noise: bool, wet: bool, px: vec2i, grain: u32) -> f32 {
  var m = 0.0;
  var r = 0.0;
  let is_round = tip < 0.0;
  if (is_round) {
    r = length(u);
    if (r >= 1.0) { return 0.0; }
    m = round_mask(r, hardness, aa);
  } else {
    if (abs(u.x) >= 1.0 || abs(u.y) >= 1.0) { return 0.0; }
    m = tip_sample(u32(tip), u, aa);
  }
  if (m <= 0.0) { return 0.0; }
  if (noise) { m = noisy(m, hash01(px.x, px.y, grain)); }
  if (wet) { m = m * (0.45 + 0.55 * edgeness(is_round, r, m)); }
  return m;
}

// textures.ts adjustTexture and textured.
fn texture_adjust(v0: f32, brightness: f32, contrast: f32, invert: bool) -> f32 {
  var t = select(v0, 1.0 - v0, invert);
  t = t + brightness / 150.0 / 2.0;
  let k = select(1.0 + contrast / 50.0, 1.0 + contrast / 100.0 * 3.0, contrast >= 0.0);
  return clamp((t - 0.5) * k + 0.5, 0.0, 1.0);
}

fn textured(m: f32, t: f32, depth: f32, mode: u32) -> f32 {
  if (m <= 0.0 || depth <= 0.0) { return m; }
  var v = 0.0;
  switch mode {
    case 0u: { v = m * t; }
    case 1u: { v = m - (1.0 - t); }
    case 2u: { v = min(m, t); }
    case 3u: { v = select(1.0 - 2.0 * (1.0 - m) * (1.0 - t), 2.0 * m * t, m < 0.5); }
    case 4u: { v = min(1.0, m / max(0.02, 1.0 - t)); }
    case 5u: { v = 1.0 - min(1.0, (1.0 - m) / max(0.02, t)); }
    case 6u: { v = m + t - 1.0; }
    case 7u: { v = select(0.0, 1.0, m + t >= 1.0); }
    case 8u: { v = m * (0.5 + t) - 0.5 * (1.0 - m); }
    default: { v = select(0.0, 1.0, t >= 1.0 - m) * m; }
  }
  v = clamp(v, 0.0, 1.0);
  return m + (v - m) * depth;
}
`

export const stampWgsl = `
struct Dab {
  // Centre (relative to the tile's corner, layer pixels), anti-aliasing width, hardness.
  c: vec4f,
  // Layer offset into tip space.
  a: vec4f,
  // Opacity, flow, tip (−1 round, else its index in the table), 1 for a dual brush's dab.
  o: vec4f,
  colour: vec4f,
  // The box it can touch, relative to the tile's corner.
  box: vec4f,
  // Texture depth, then the Noise seed (as bits).
  x: vec4f,
}

struct StampParams {
  count: u32,
  stride: u32,
  tile: u32,
  channels: u32,
  // The layer's transform (layer to document), its translation moved to the tile's corner.
  t: vec4f,
  // Translation, then the document's width and height.
  t2: vec4f,
  // Noise, wet edges, whether the main coverage is kept apart (raw), whether there's a dual channel.
  flags: vec4u,
  // The tile's corner in layer pixels; the dual mode (+1, 0 for none); the colour's offset.
  origin: vec4i,
  // Texture: in use (1 stroke-wide, 2 each tip), its mode, inverted, width.
  tex: vec4u,
  // Texture: scale, brightness, contrast, depth.
  tex2: vec4f,
}

@group(0) @binding(0) var<uniform> S: StampParams;
@group(0) @binding(1) var<storage, read> dabs: array<Dab>;
@group(0) @binding(2) var<storage, read_write> stroke: array<f32>;
@group(0) @binding(3) var<storage, read> tips: array<f32>;
@group(0) @binding(4) var<storage, read> tiptable: array<u32>;
@group(0) @binding(5) var<storage, read> paper: array<f32>;

${brushWgsl}

fn texture_at(doc: vec2f) -> f32 {
  let w = i32(S.tex.w);
  let h = i32(arrayLength(&paper)) / max(1, w);
  let f = doc / S.tex2.x - 0.5;
  let i0 = vec2i(floor(f));
  let t = f - floor(f);
  var v = vec4f(0.0);
  for (var k = 0; k < 4; k++) {
    let x = ((i0.x + (k & 1)) % w + w) % w;
    let y = ((i0.y + (k >> 1)) % h + h) % h;
    v[k] = paper[y * w + x];
  }
  let raw = mix(mix(v.x, v.y, t.x), mix(v.z, v.w, t.x), t.y);
  return texture_adjust(raw, S.tex2.y, S.tex2.z, S.tex.z == 1u);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= 256u || g.y >= 256u) { return; }
  let p = vec2f(g.xy) + 0.5;
  let doc = vec2f(S.t.x * p.x + S.t.z * p.y + S.t2.x, S.t.y * p.x + S.t.w * p.y + S.t2.y);
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= S.t2.z || doc.y >= S.t2.w) { return; }
  let base = (S.tile * 65536u + g.y * 256u + g.x) * S.stride;
  let raw = S.flags.z == 1u;
  let ro = select(0u, 1u, raw);
  let dof = 1u + ro;
  let co = u32(S.origin.w);
  let px = vec2i(S.origin.x + i32(g.x), S.origin.y + i32(g.y));
  let tv = select(1.0, texture_at(doc), S.tex.x > 0u);
  var a = stroke[base + ro];
  var dual = select(0.0, stroke[base + dof], S.flags.w == 1u);
  var touched = false;
  for (var k = 0u; k < S.count; k++) {
    let d = dabs[k];
    if (p.x < d.box.x || p.y < d.box.y || p.x > d.box.z || p.y > d.box.w) { continue; }
    let o = p - d.c.xy;
    let u = vec2f(d.a.x * o.x + d.a.y * o.y, d.a.z * o.x + d.a.w * o.y);
    var m = dab_mask(u, d.o.z, d.c.w, d.c.z, S.flags.x == 1u, S.flags.y == 1u, px, bitcast<u32>(d.x.y));
    if (m <= 0.0) { continue; }
    if (d.o.w > 0.5) {
      if (S.flags.w == 1u) { dual = dual + (1.0 - dual) * m; }
      touched = true;
      continue;
    }
    if (S.tex.x == 2u) { m = textured(m, tv, d.x.x, S.tex.y); }
    let w = d.o.y * m;
    if (w <= 0.0 || a >= d.o.x) { continue; }
    let a2 = a + (d.o.x - a) * w;
    if (S.channels > 0u) {
      let share = (a2 - a) / a2;
      for (var c = 0u; c < S.channels; c++) {
        let v = stroke[base + co + c];
        stroke[base + co + c] = v + (d.colour[c] - v) * share;
      }
    }
    a = a2;
    touched = true;
  }
  stroke[base + ro] = a;
  if (S.flags.w == 1u) { stroke[base + dof] = dual; }
  if (touched && raw) {
    var f = a;
    if (S.flags.w == 1u && S.origin.z > 0) { f = textured(f, dual, 1.0, u32(S.origin.z - 1)); }
    if (S.tex.x == 1u) { f = textured(f, tv, S.tex2.w, S.tex.y); }
    stroke[base] = f;
  }
}
`
