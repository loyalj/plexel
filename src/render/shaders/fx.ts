/**
 * Layer effects on the GPU (fx/ref.ts has the reference, step for step).
 * They run on a layer's body gathered into a region (shaders/filter.ts's
 * layout), making planes from its alpha and a layer of colour and coverage
 * per effect, which `over` lays where it belongs.
 */
import { OPS_WGSL, blendWgsl } from './composite'
import { PATTERN_WGSL } from '../../vector/patterns'
import { patternImageWgsl } from './vector'
import { preamble, strideOf, type BufferFormat } from './common'

/** FxParams: five vec4s. */
export const FX_PARAMS_BYTES = 80

/** Effect kinds, as the `layer` entry numbers them. */
export const FX_INDEX = {
  'drop-shadow': 0,
  'outer-glow': 1,
  'inner-shadow': 2,
  'inner-glow': 3,
  satin: 4,
  'colour-overlay': 5,
  'gradient-overlay': 6,
  'pattern-overlay': 10,
  /** Pattern Overlay with a pattern of the document's: its pyramid in `stops`. */
  'pattern-image': 11,
  'bevel-highlight': 7,
  'bevel-shadow': 8,
  stroke: 9,
} as const

export interface FxParams {
  size: number
  kind?: number
  /** Flags: centre glow 1, satin invert 2, bevel style (inner 0, outer 4, emboss 8), stroke outside 16, inside 32. */
  flags?: number
  /** A box radius, a jump's step, the number of gradient stops, or (for `over`) the blend mode. */
  n?: number
  /** Offset x, y; spread; k. */
  f0?: [number, number, number, number]
  /** Gradient: centre x, y, direction x, y. Bevel: light x, y, z, depth. */
  f1?: [number, number, number, number]
  /** Gradient half-length, reverse; stroke reach. */
  f2?: [number, number, number, number]
  colour?: number[]
}

export function writeFxParams(out: ArrayBuffer, p: FxParams) {
  const u = new Uint32Array(out)
  const f = new Float32Array(out)
  u.set([p.size, p.kind ?? 0, p.flags ?? 0, p.n ?? 0], 0)
  f.set(p.f0 ?? [0, 0, 0, 0], 4)
  f.set(p.f1 ?? [0, 0, 0, 0], 8)
  f.set(p.f2 ?? [0, 0, 0, 0], 12)
  f.set([...(p.colour ?? []), 0, 0, 0, 0].slice(0, 4), 16)
}

export function fxWgsl(fmt: BufferFormat): string {
  const S = strideOf(fmt.mode)
  // Regions are always f32; the blend functions want the format's colour count.
  return `${preamble({ mode: fmt.mode, store: 'f32' })}
struct FxP {
  u: vec4u,
  f0: vec4f,
  f1: vec4f,
  f2: vec4f,
  colour: vec4f,
}
@group(0) @binding(0) var<uniform> P: FxP;
@group(0) @binding(1) var<storage, read> body: array<f32>;
@group(0) @binding(2) var<storage, read> plane: array<f32>;
@group(0) @binding(3) var<storage, read> seeds_out: array<i32>;
@group(0) @binding(4) var<storage, read> seeds_in: array<i32>;
@group(0) @binding(5) var<storage, read_write> out: array<f32>;
@group(0) @binding(6) var<storage, read> stops: array<f32>;
@group(0) @binding(7) var<storage, read_write> seeds_next: array<i32>;
${blendWgsl(fmt.mode)}
${OPS_WGSL}
${PATTERN_WGSL}
${patternImageWgsl('stops')}

const RS: u32 = ${S}u;

fn alpha_at(i: u32) -> f32 { return body[i * RS + RS - 1u]; }

// The body's alpha, hardened by spread (f0.z) into a plane.
@compute @workgroup_size(256)
fn shape(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let k = 1.0 / max(1e-4, 1.0 - min(0.99, P.f0.z));
  out[g.x] = clamp(alpha_at(g.x) * k, 0.0, 1.0);
}

// One box pass over a plane, a line an invocation; radius P.u.w, rows when flags is 1.
@compute @workgroup_size(64)
fn pbox(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  let line = g.x;
  if (line >= size) { return; }
  let r = P.u.w;
  let horizontal = P.u.z == 1u;
  let n = f32(2u * r + 1u);
  var sum = 0.0;
  for (var i = 0u; i <= min(r, size - 1u); i++) { sum += plane[select(i * size + line, line * size + i, horizontal)]; }
  for (var i = 0u; i < size; i++) {
    out[select(i * size + line, line * size + i, horizontal)] = sum / n;
    let add = i + r + 1u;
    if (add < size) { sum += plane[select(add * size + line, line * size + add, horizontal)]; }
    if (i >= r) {
      let d = i - r;
      sum -= plane[select(d * size + line, line * size + d, horizontal)];
    }
  }
}

// Seeds for jump flooding: inside pixels (flags 0) or outside ones (flags 1).
@compute @workgroup_size(256)
fn jfa_init(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let isIn = alpha_at(g.x) >= 0.5;
  seeds_next[g.x] = select(-1, i32(g.x), isIn != (P.u.z == 1u));
}

// One jump of step P.u.w: the nearest seed any of nine pixels that far away knows.
@compute @workgroup_size(256)
fn jfa_step(@builtin(global_invocation_id) g: vec3u) {
  let size = i32(P.u.x);
  if (g.x >= u32(size * size)) { return; }
  let x = i32(g.x) % size;
  let y = i32(g.x) / size;
  let k = i32(P.u.w);
  var best = -1;
  var bestD = 0x7fffffff;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let qx = x + dx * k;
      let qy = y + dy * k;
      if (qx < 0 || qy < 0 || qx >= size || qy >= size) { continue; }
      let s = seeds_out[qy * size + qx];
      if (s < 0) { continue; }
      let sx = s % size;
      let sy = s / size;
      let d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  seeds_next[g.x] = best;
}

fn dist(seeds_is_out: bool, i: u32) -> f32 {
  let size = i32(P.u.x);
  var s: i32;
  if (seeds_is_out) { s = seeds_out[i]; } else { s = seeds_in[i]; }
  if (s < 0) { return 1e9; }
  let x = i32(i) % size;
  let y = i32(i) / size;
  let sx = s % size;
  let sy = s / size;
  return sqrt(f32((sx - x) * (sx - x) + (sy - y) * (sy - y)));
}

fn sample_plane(x: f32, y: f32) -> f32 {
  let size = i32(P.u.x);
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = x - floor(x);
  let fy = y - floor(y);
  var v = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var j = 0; j < 4; j++) {
    let ix = x0 + (j & 1);
    let iy = y0 + (j >> 1);
    if (ix >= 0 && iy >= 0 && ix < size && iy < size) { v[j] = plane[iy * size + ix]; }
  }
  return (v[0] * (1.0 - fx) + v[1] * fx) * (1.0 - fy) + (v[2] * (1.0 - fx) + v[3] * fx) * fy;
}

fn plane_at(x: i32, y: i32) -> f32 {
  let size = i32(P.u.x);
  if (x < 0 || y < 0 || x >= size || y >= size) { return 0.0; }
  return plane[y * size + x];
}

fn gradient_at(t: f32) -> vec4f {
  let n = P.u.w;
  if (t <= stops[0]) { return vec4f(stops[1], stops[2], stops[3], stops[4]); }
  for (var i = 1u; i < n; i++) {
    let b = i * 5u;
    if (t <= stops[b]) {
      let a = b - 5u;
      let f = (t - stops[a]) / max(1e-9, stops[b] - stops[a]);
      return mix(vec4f(stops[a + 1u], stops[a + 2u], stops[a + 3u], stops[a + 4u]), vec4f(stops[b + 1u], stops[b + 2u], stops[b + 3u], stops[b + 4u]), f);
    }
  }
  let l = (n - 1u) * 5u;
  return vec4f(stops[l + 1u], stops[l + 2u], stops[l + 3u], stops[l + 4u]);
}

// One effect's layer: colour times coverage, and coverage, from the planes.
@compute @workgroup_size(256)
fn layer(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = f32(g.x % size);
  let y = f32(g.x / size);
  let a = alpha_at(g.x);
  var colour = P.colour;
  var cov = 0.0;
  switch P.u.y {
    case 0u: { cov = sample_plane(x - P.f0.x, y - P.f0.y); }
    case 1u: { cov = plane[g.x]; }
    case 2u: { cov = a * (1.0 - sample_plane(x - P.f0.x, y - P.f0.y)); }
    case 3u: { cov = a * select(1.0 - plane[g.x], plane[g.x], (P.u.z & 1u) != 0u); }
    case 4u: {
      let d = abs(sample_plane(x + P.f0.x, y + P.f0.y) - sample_plane(x - P.f0.x, y - P.f0.y));
      cov = a * select(d, 1.0 - d, (P.u.z & 2u) != 0u);
    }
    case 5u: { cov = a; }
    case 10u: {
      // A pattern in document space: f1 and f2.xy map the pixel's centre into
      // cells, f2.z is the filter's width, f0 the background, f2.w its opacity.
      let gp = vec2f(P.f1.x * (x + 0.5) + P.f1.z * (y + 0.5) + P.f2.x, P.f1.y * (x + 0.5) + P.f1.w * (y + 0.5) + P.f2.y);
      let v = pattern_value(P.u.z, gp, P.f2.z);
      let pa = P.f2.w * (1.0 - v) + v;
      colour = select(vec4f(0.0), (P.f0 * P.f2.w * (1.0 - v) + P.colour * v) / pa, pa > 0.0);
      cov = a * pa;
    }
    case 11u: {
      // A pattern of the document's in document space: f1 and f2.xy map the pixel's centre
      // into its pixels, f2.z is how many of them a pixel here covers.
      let gp = vec2f(P.f1.x * (x + 0.5) + P.f1.z * (y + 0.5) + P.f2.x, P.f1.y * (x + 0.5) + P.f1.w * (y + 0.5) + P.f2.y);
      let s = pattern_image(gp.x, gp.y, P.f2.z);
      colour = select(vec4f(0.0), vec4f(s[0], s[1], s[2], s[3]) / s[4], s[4] > 0.0);
      cov = a * s[4];
    }
    case 6u: {
      var t = clamp(0.5 + ((x + 0.5 - P.f1.x) * P.f1.z + (y + 0.5 - P.f1.y) * P.f1.w) / (2.0 * P.f2.x), 0.0, 1.0);
      if (P.f2.y > 0.5) { t = 1.0 - t; }
      colour = gradient_at(t);
      cov = a;
    }
    case 7u, 8u: {
      let xi = i32(x);
      let yi = i32(y);
      let depth = P.f1.w;
      let gx = (plane_at(xi + 1, yi) - plane_at(xi - 1, yi)) / 2.0 * depth;
      let gy = (plane_at(xi, yi + 1) - plane_at(xi, yi - 1)) / 2.0 * depth;
      let len = sqrt(gx * gx + gy * gy + 1.0);
      let shade = (-gx * P.f1.x - gy * P.f1.y + P.f1.z) / len - P.f1.z;
      let h = plane[g.x];
      var region = clamp(h * 2.0, 0.0, 1.0);
      if ((P.u.z & 12u) == 0u) { region = a; }
      else if ((P.u.z & 4u) != 0u) { region = (1.0 - a) * clamp(h * 2.0, 0.0, 1.0); }
      cov = region * clamp(select(-shade, shade, P.u.y == 7u) * 2.0, 0.0, 1.0);
    }
    default: {
      let reach = P.f2.z;
      var o = 0.0;
      var n = 0.0;
      if ((P.u.z & 16u) != 0u) { o = (1.0 - a) * clamp(reach + 1.0 - dist(true, g.x), 0.0, 1.0); }
      if ((P.u.z & 32u) != 0u) { n = a * clamp(reach + 1.0 - dist(false, g.x), 0.0, 1.0); }
      cov = o + n;
    }
  }
  cov = clamp(cov, 0.0, 1.0);
  for (var c = 0u; c < RS - 1u; c++) { out[g.x * RS + c] = colour[c] * cov; }
  out[g.x * RS + RS - 1u] = cov;
}

fn load_px(buf_is_body: bool, i: u32) -> Px {
  var c = vec4f(0.0);
  if (buf_is_body) {
    for (var k = 0u; k < RS - 1u; k++) { c[k] = body[i * RS + k]; }
    return Px(c, body[i * RS + RS - 1u]);
  }
  for (var k = 0u; k < RS - 1u; k++) { c[k] = out[i * RS + k]; }
  return Px(c, out[i * RS + RS - 1u]);
}

// out = body over out, in blend mode P.u.w, at f0.w: an effect laid on the content.
@compute @workgroup_size(256)
fn over(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let r = op_over(load_px(false, g.x), load_px(true, g.x), P.u.w, P.f0.w);
  for (var c = 0u; c < RS - 1u; c++) { out[g.x * RS + c] = r.c[c]; }
  out[g.x * RS + RS - 1u] = r.a;
}
`
}
