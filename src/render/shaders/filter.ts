/**
 * Live filters on the GPU (filters/defs.ts has the references). They run
 * on regions: f32 buffers of premultiplied working-space pixels, `size` a
 * side, gathered from a node's content tiles round the tile being drawn,
 * and cropped back to a tile when the node's effects are done.
 *
 * A box pass runs one invocation per line, keeping a running sum, so a
 * blur costs the same at any radius; a Gaussian is three of them each way.
 */
import { bufferAccess, preamble, strideOf, type BufferFormat } from './common'

/** FilterParams: six vec4s. */
export const FILTER_PARAMS_BYTES = 96

export interface FilterParams {
  size: number
  /** A radius, or Median's. */
  r?: number
  /** Box pass along rows (1) or columns (0); for noise, Gaussian (bit 1) and monochromatic (bit 2). */
  flags?: number
  /** Where a gathered tile lands in the region, or where a crop starts. */
  offset?: [number, number]
  /** The region's first pixel in the level's pixels, for noise. */
  origin?: [number, number]
  /** Amount, threshold or angle, distance, mix. */
  f?: [number, number, number, number]
  seed?: number
  /** Motion Blur's taps. */
  n?: number
  /** Two more groups of four: colours, a light. */
  f2?: [number, number, number, number]
  f3?: [number, number, number, number]
}

export function writeFilterParams(out: ArrayBuffer, p: FilterParams) {
  const u = new Uint32Array(out)
  const i = new Int32Array(out)
  const f = new Float32Array(out)
  u.set([p.size, 0, p.r ?? 0, p.flags ?? 0], 0)
  i.set([...(p.offset ?? [0, 0]), ...(p.origin ?? [0, 0])], 4)
  f.set(p.f ?? [0, 0, 0, 0], 8)
  u.set([(p.seed ?? 0) >>> 0, p.n ?? 0, 0, 0], 12)
  f.set(p.f2 ?? [0, 0, 0, 0], 16)
  f.set(p.f3 ?? [0, 0, 0, 0], 20)
}

export function filterWgsl(fmt: BufferFormat): string {
  const S = strideOf(fmt.mode)
  return `${preamble(fmt)}
struct FP {
  u: vec4u,
  i: vec4i,
  f: vec4f,
  s: vec4u,
  f2: vec4f,
  f3: vec4f,
}
@group(0) @binding(0) var<uniform> P: FP;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read_write> b: array<f32>;
@group(0) @binding(3) var<storage, read> src: array<T>;
@group(0) @binding(4) var<storage, read_write> dst: array<T>;
${bufferAccess(fmt, 'src', false)}
${bufferAccess(fmt, 'dst', true)}

const RS: u32 = ${S}u;

// A composite tile into the region, at P.i.xy.
@compute @workgroup_size(16, 16)
fn gather(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let x = i32(g.x) + P.i.x;
  let y = i32(g.y) + P.i.y;
  let size = i32(P.u.x);
  if (x < 0 || y < 0 || x >= size || y >= size) { return; }
  let p = load_src(g.y * TILE + g.x);
  let o = u32(y * size + x) * RS;
  for (var c = 0u; c < RS - 1u; c++) { b[o + c] = p.c[c]; }
  b[o + RS - 1u] = p.a;
}

// A composite tile into the region at P.i.xy, only its pixels in P.f
// (in the tile's pixels: left, top, right, bottom): the canvas, for Offset.
@compute @workgroup_size(16, 16)
fn gather_clip(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  if (f32(g.x) < P.f.x || f32(g.y) < P.f.y || f32(g.x) >= P.f.z || f32(g.y) >= P.f.w) { return; }
  let x = i32(g.x) + P.i.x;
  let y = i32(g.y) + P.i.y;
  let size = i32(P.u.x);
  if (x < 0 || y < 0 || x >= size || y >= size) { return; }
  let p = load_src(g.y * TILE + g.x);
  let o = u32(y * size + x) * RS;
  for (var c = 0u; c < RS - 1u; c++) { b[o + c] = p.c[c]; }
  b[o + RS - 1u] = p.a;
}

// Offset's Repeat Edge Pixels: each pixel of the tile-sized region b from
// the window a, at its place there (P.i.xy is where b's first pixel falls)
// held inside the canvas (P.f, in a's pixels: left, top, right, bottom).
@compute @workgroup_size(16, 16)
fn clamp_read(@builtin(global_invocation_id) g: vec3u) {
  let size = i32(P.u.x);
  if (i32(g.x) >= size || i32(g.y) >= size) { return; }
  let w = vec2i(clamp(vec2f(vec2i(g.xy) + P.i.xy), P.f.xy, P.f.zw));
  let o = u32(i32(g.y) * size + i32(g.x)) * RS;
  if (w.x < 0 || w.y < 0 || w.x >= size || w.y >= size) {
    for (var c = 0u; c < RS; c++) { b[o + c] = 0.0; }
    return;
  }
  let s = u32(w.y * size + w.x) * RS;
  for (var c = 0u; c < RS; c++) { b[o + c] = a[s + c]; }
}

// The region's pixels outside P.f (left, top, right, bottom), cleared: Offset gives the canvas only.
@compute @workgroup_size(16, 16)
fn keep_rect(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size || g.y >= size) { return; }
  if (f32(g.x) >= P.f.x && f32(g.y) >= P.f.y && f32(g.x) < P.f.z && f32(g.y) < P.f.w) { return; }
  let o = (g.y * size + g.x) * RS;
  for (var c = 0u; c < RS; c++) { b[o + c] = 0.0; }
}

// The region's tile-sized middle, from P.i.xy, out to a composite tile.
@compute @workgroup_size(16, 16)
fn crop(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let size = P.u.x;
  let o = ((g.y + u32(P.i.y)) * size + g.x + u32(P.i.x)) * RS;
  var c = vec4f(0.0);
  for (var k = 0u; k < RS - 1u; k++) { c[k] = a[o + k]; }
  let al = clamp(a[o + RS - 1u], 0.0, 1.0);
  store_dst(g.y * TILE + g.x, Px(clamp(c, vec4f(0.0), vec4f(al)), al));
}

// One box pass, a line an invocation: the mean of 2r + 1 pixels, transparent outside.
@compute @workgroup_size(64)
fn box(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  let line = g.x;
  if (line >= size) { return; }
  let r = P.u.z;
  let horizontal = P.u.w == 1u;
  let n = f32(2u * r + 1u);
  for (var c = 0u; c < RS; c++) {
    var sum = 0.0;
    for (var i = 0u; i <= min(r, size - 1u); i++) {
      sum += a[select(i * size + line, line * size + i, horizontal) * RS + c];
    }
    for (var i = 0u; i < size; i++) {
      b[select(i * size + line, line * size + i, horizontal) * RS + c] = sum / n;
      let add = i + r + 1u;
      if (add < size) { sum += a[select(add * size + line, line * size + add, horizontal) * RS + c]; }
      if (i >= r) {
        let drop = i - r;
        sum -= a[select(drop * size + line, line * size + drop, horizontal) * RS + c];
      }
    }
  }
}

fn straight_at(buf_is_a: bool, o: u32, c: u32) -> f32 {
  var v: f32;
  var al: f32;
  if (buf_is_a) { v = a[o + c]; al = a[o + RS - 1u]; } else { v = b[o + c]; al = b[o + RS - 1u]; }
  if (al <= 0.0) { return 0.0; }
  return clamp(v / al, 0.0, 1.0);
}

// Unsharp Mask (flags 0) or High Pass (flags 1): a is the original, b its blur; the result into b.
@compute @workgroup_size(256)
fn sharpen(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let o = g.x * RS;
  let al = a[o + RS - 1u];
  var outc: array<f32, 5>;
  for (var c = 0u; c < RS - 1u; c++) {
    let s = straight_at(true, o, c);
    let bl = straight_at(false, o, c);
    var x: f32;
    if (P.u.w == 1u) { x = 0.5 + s - bl; }
    else if (abs(s - bl) < P.f.y) { x = s; }
    else { x = s + P.f.x * (s - bl); }
    outc[c] = clamp(x, 0.0, 1.0) * al;
  }
  for (var c = 0u; c < RS - 1u; c++) { b[o + c] = select(0.0, outc[c], al > 0.0); }
  b[o + RS - 1u] = al;
}

fn hash01(x: i32, y: i32, seed: u32, k: u32) -> f32 {
  var v = (u32(x) * 0x9e3779b1u) ^ (u32(y) * 0x85ebca77u) ^ ((seed + k * 0x632be5abu) * 0xc2b2ae3du);
  v = v * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return f32(((w >> 22u) ^ w) >> 8u) / 16777216.0;
}

fn noise_at(x: i32, y: i32, k: u32, gauss: bool) -> f32 {
  let u = hash01(x, y, P.s.x, k);
  if (!gauss) { return u * 2.0 - 1.0; }
  let u2 = hash01(x, y, P.s.x, k + 7u);
  return sqrt(-2.0 * log(max(1e-7, 1.0 - u))) * cos(6.283185307179586 * u2) / 3.0;
}

// Add Noise: a to b.
@compute @workgroup_size(256)
fn noise(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let o = g.x * RS;
  let al = a[o + RS - 1u];
  let x = P.i.z + i32(g.x % size);
  let y = P.i.w + i32(g.x / size);
  let gauss = (P.u.w & 2u) != 0u;
  let mono = (P.u.w & 4u) != 0u;
  for (var c = 0u; c < RS - 1u; c++) {
    let s = straight_at(true, o, c);
    let n = noise_at(x, y, select(c, 0u, mono), gauss);
    b[o + c] = select(0.0, clamp(s + n * P.f.x, 0.0, 1.0) * al, al > 0.0);
  }
  b[o + RS - 1u] = al;
}

fn at_a(x: i32, y: i32, c: u32) -> f32 {
  let size = i32(P.u.x);
  if (x < 0 || y < 0 || x >= size || y >= size) { return 0.0; }
  return a[u32(y * size + x) * RS + c];
}

// Median, channel by channel: the middle of the (2r + 1)² values round each pixel, found by halving.
@compute @workgroup_size(256)
fn median(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = i32(g.x % size);
  let y = i32(g.x / size);
  let r = i32(P.u.z);
  let count = u32((2 * r + 1) * (2 * r + 1));
  let want = count / 2u + 1u;
  for (var c = 0u; c < RS; c++) {
    var lo = -1.0;
    var hi = 2.0;
    for (var it = 0; it < 24; it++) {
      let mid = (lo + hi) * 0.5;
      var n = 0u;
      for (var dy = -r; dy <= r; dy++) { for (var dx = -r; dx <= r; dx++) { if (at_a(x + dx, y + dy, c) <= mid) { n++; } } }
      if (n >= want) { hi = mid; } else { lo = mid; }
    }
    // Snapped to the nearest value actually there at or above the bound.
    var best = 3.0;
    for (var dy = -r; dy <= r; dy++) { for (var dx = -r; dx <= r; dx++) {
      let v = at_a(x + dx, y + dy, c);
      if (v >= lo && v < best) { best = v; }
    } }
    b[g.x * RS + c] = best;
  }
}

// Motion Blur: the mean of n bilinear taps along the line.
@compute @workgroup_size(256)
fn motion(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = f32(g.x % size);
  let y = f32(g.x / size);
  let n = P.s.y;
  let d = P.f.z;
  let ang = P.f.y * 3.141592653589793 / 180.0;
  let dir = vec2f(cos(ang), -sin(ang));
  for (var c = 0u; c < RS; c++) {
    var sum = 0.0;
    for (var i = 0u; i < n; i++) {
      let t = select(-d / 2.0 + d * f32(i) / f32(n - 1u), 0.0, n == 1u);
      let p = vec2f(x, y) + t * dir;
      let p0 = floor(p);
      let fr = p - p0;
      let xi = i32(p0.x);
      let yi = i32(p0.y);
      sum += (at_a(xi, yi, c) * (1.0 - fr.x) + at_a(xi + 1, yi, c) * fr.x) * (1.0 - fr.y) + (at_a(xi, yi + 1, c) * (1.0 - fr.x) + at_a(xi + 1, yi + 1, c) * fr.x) * fr.y;
    }
    b[g.x * RS + c] = sum / f32(n);
  }
}

// --- the filter pack ------------------------------------------------------------------------

fn bil_a(p: vec2f, c: u32) -> f32 {
  let p0 = floor(p);
  let fr = p - p0;
  let xi = i32(p0.x);
  let yi = i32(p0.y);
  return (at_a(xi, yi, c) * (1.0 - fr.x) + at_a(xi + 1, yi, c) * fr.x) * (1.0 - fr.y) + (at_a(xi, yi + 1, c) * (1.0 - fr.x) + at_a(xi + 1, yi + 1, c) * fr.x) * fr.y;
}

// A pixel's straight colour, its mean, in a: what highlights and edges are judged by.
fn lum_a(x: i32, y: i32) -> f32 {
  let al = at_a(x, y, RS - 1u);
  if (al <= 0.0) { return 0.0; }
  var s = 0.0;
  for (var c = 0u; c < RS - 1u; c++) { s += at_a(x, y, c); }
  return clamp(s / (al * f32(RS - 1u)), 0.0, 1.0);
}

// Lens Blur: n taps over a disc of radius P.f.x (a golden-angle spiral), highlights over P.f.z brightened by P.f.y.
@compute @workgroup_size(256)
fn lens(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = f32(g.x % size);
  let y = f32(g.x / size);
  let n = P.s.y;
  var sum: array<f32, 5>;
  var ws = 0.0;
  for (var k = 0u; k < n; k++) {
    let t = (f32(k) + 0.5) / f32(n);
    let rad = P.f.x * sqrt(t);
    let ang = f32(k) * 2.399963229728653;
    let p = vec2f(x, y) + rad * vec2f(cos(ang), sin(ang)) - vec2f(0.0);
    var s: array<f32, 5>;
    var m = 0.0;
    for (var c = 0u; c < RS; c++) { s[c] = bil_a(p, c); }
    let al = s[RS - 1u];
    for (var c = 0u; c < RS - 1u; c++) { m += s[c]; }
    let l = select(0.0, clamp(m / (al * f32(RS - 1u)), 0.0, 1.0), al > 0.0);
    let w = 1.0 + P.f.y * smoothstep(P.f.z, 1.0, l);
    for (var c = 0u; c < RS; c++) { sum[c] += s[c] * w; }
    ws += w;
  }
  for (var c = 0u; c < RS; c++) { b[g.x * RS + c] = sum[c] / ws; }
}

// Surface Blur: the disc of radius r, every P.u.w-th pixel, each weighed by how near its colour is (threshold P.f.x).
@compute @workgroup_size(256)
fn surface(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = i32(g.x % size);
  let y = i32(g.x / size);
  let r = i32(P.u.z);
  let st = i32(max(1u, P.u.w));
  let a0 = at_a(x, y, RS - 1u);
  var c0: array<f32, 5>;
  for (var c = 0u; c < RS - 1u; c++) { c0[c] = select(0.0, at_a(x, y, c) / a0, a0 > 0.0); }
  var sum: array<f32, 5>;
  var ws = 0.0;
  for (var dy = -r; dy <= r; dy += st) {
    for (var dx = -r; dx <= r; dx += st) {
      if (dx * dx + dy * dy > r * r) { continue; }
      let qa = at_a(x + dx, y + dy, RS - 1u);
      var d = 0.0;
      for (var c = 0u; c < RS - 1u; c++) { d = max(d, abs(select(0.0, at_a(x + dx, y + dy, c) / qa, qa > 0.0) - c0[c])); }
      let w = max(0.0, 1.0 - d / (2.5 * P.f.x));
      for (var c = 0u; c < RS; c++) { sum[c] += at_a(x + dx, y + dy, c) * w; }
      ws += w;
    }
  }
  for (var c = 0u; c < RS; c++) { b[g.x * RS + c] = select(at_a(x, y, c), sum[c] / ws, ws > 0.0); }
}

// Colour-only filters on a pixel and its neighbours: Emboss (flags 0), Find Edges (1), Solarize (2), Lighting (3).
@compute @workgroup_size(256)
fn stylize(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = i32(g.x % size);
  let y = i32(g.x / size);
  let o = g.x * RS;
  let al = a[o + RS - 1u];
  b[o + RS - 1u] = al;
  if (al <= 0.0) { for (var c = 0u; c < RS - 1u; c++) { b[o + c] = 0.0; } return; }
  let kind = P.u.w;
  if (kind == 0u) {
    // Emboss: the difference across the light's direction, over gray.
    let d = P.f.xy;
    let v = clamp(0.5 + P.f.z * (bil_lum(vec2f(f32(x), f32(y)) - d) - bil_lum(vec2f(f32(x), f32(y)) + d)), 0.0, 1.0);
    for (var c = 0u; c < RS - 1u; c++) { b[o + c] = v * al; }
    return;
  }
  if (kind == 1u) {
    // Find Edges: Sobel per channel, dark on white.
    for (var c = 0u; c < RS - 1u; c++) {
      let gx = st_a(x + 1, y - 1, c) + 2.0 * st_a(x + 1, y, c) + st_a(x + 1, y + 1, c) - st_a(x - 1, y - 1, c) - 2.0 * st_a(x - 1, y, c) - st_a(x - 1, y + 1, c);
      let gy = st_a(x - 1, y + 1, c) + 2.0 * st_a(x, y + 1, c) + st_a(x + 1, y + 1, c) - st_a(x - 1, y - 1, c) - 2.0 * st_a(x, y - 1, c) - st_a(x + 1, y - 1, c);
      b[o + c] = clamp(1.0 - sqrt(gx * gx + gy * gy) * 0.5, 0.0, 1.0) * al;
    }
    return;
  }
  if (kind == 2u) {
    // Solarize: the light half turned dark.
    for (var c = 0u; c < RS - 1u; c++) {
      let s = clamp(a[o + c] / al, 0.0, 1.0);
      b[o + c] = select(s, 1.0 - s, s > 0.5) * al;
    }
    return;
  }
  // Lighting: a light from P.f2 (direction x, y, z; intensity), on a surface raised by lightness (P.f.x), ambient P.f.y, gloss P.f.z.
  let h = P.f.x;
  let gx = lum_a(x + 1, y) - lum_a(x - 1, y);
  let gy = lum_a(x, y + 1) - lum_a(x, y - 1);
  let nrm = normalize(vec3f(-gx * h, -gy * h, 1.0));
  let L = normalize(P.f2.xyz);
  let diff = max(0.0, dot(nrm, L));
  let hv = normalize(L + vec3f(0.0, 0.0, 1.0));
  let spec = pow(max(0.0, dot(nrm, hv)), 24.0) * P.f.z;
  for (var c = 0u; c < RS - 1u; c++) {
    let s = clamp(a[o + c] / al, 0.0, 1.0);
    b[o + c] = clamp(s * (P.f.y + P.f2.w * diff * P.f3[c]) + spec * P.f3[c], 0.0, 1.0) * al;
  }
}

fn st_a(x: i32, y: i32, c: u32) -> f32 {
  let al = at_a(x, y, RS - 1u);
  return select(0.0, clamp(at_a(x, y, c) / al, 0.0, 1.0), al > 0.0);
}

fn bil_lum(p: vec2f) -> f32 {
  var m = 0.0;
  for (var c = 0u; c < RS - 1u; c++) { m += bil_a(p, c); }
  let al = bil_a(p, RS - 1u);
  return select(0.0, clamp(m / (al * f32(RS - 1u)), 0.0, 1.0), al > 0.0);
}

// Mosaic: every pixel the mean of its cell (P.f.x a side, on the document's grid from P.i.zw), m × m taps.
@compute @workgroup_size(256)
fn mosaic(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let x = i32(g.x % size);
  let y = i32(g.x / size);
  let cell = P.f.x;
  let gx = floor(f32(P.i.z + x) / cell) * cell - f32(P.i.z);
  let gy = floor(f32(P.i.w + y) / cell) * cell - f32(P.i.w);
  let m = P.s.y;
  var sum: array<f32, 5>;
  for (var j = 0u; j < m; j++) {
    for (var i = 0u; i < m; i++) {
      let p = vec2f(gx + (f32(i) + 0.5) * cell / f32(m), gy + (f32(j) + 0.5) * cell / f32(m));
      for (var c = 0u; c < RS; c++) { sum[c] += at_a(i32(floor(p.x)), i32(floor(p.y)), c); }
    }
  }
  for (var c = 0u; c < RS; c++) { b[g.x * RS + c] = sum[c] / f32(m * m); }
}

// Dust & Scratches: b holds a's median; where a differs from it by less than the threshold, a is kept.
@compute @workgroup_size(256)
fn despeckle(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let o = g.x * RS;
  var d = 0.0;
  for (var c = 0u; c < RS; c++) { d = max(d, abs(a[o + c] - b[o + c])); }
  if (d < P.f.x) { for (var c = 0u; c < RS; c++) { b[o + c] = a[o + c]; } }
}

// Minimum (flags bit 2 off) or Maximum (on), along rows (bit 1) or columns: a line an invocation.
@compute @workgroup_size(64)
fn morph(@builtin(global_invocation_id) g: vec3u) {
  let size = i32(P.u.x);
  let line = i32(g.x);
  if (line >= size) { return; }
  let r = i32(P.u.z);
  let horizontal = (P.u.w & 1u) != 0u;
  let biggest = (P.u.w & 2u) != 0u;
  for (var i = 0; i < size; i++) {
    for (var c = 0u; c < RS; c++) {
      var v = select(1e9, -1e9, biggest);
      for (var k = max(0, i - r); k <= min(size - 1, i + r); k++) {
        let q = a[u32(select(k * size + line, line * size + k, horizontal)) * RS + c];
        v = select(min(v, q), max(v, q), biggest);
      }
      b[u32(select(i * size + line, line * size + i, horizontal)) * RS + c] = v;
    }
  }
}

// Value noise, smooth between the lattice's corners: Clouds' octaves.
fn vnoise(p: vec2f, seed: u32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let xi = i32(i.x);
  let yi = i32(i.y);
  let a0 = hash01(xi, yi, seed, 0u);
  let a1 = hash01(xi + 1, yi, seed, 0u);
  let a2 = hash01(xi, yi + 1, seed, 0u);
  let a3 = hash01(xi + 1, yi + 1, seed, 0u);
  // (lerp by hand: this module has an entry point called mix)
  let top = a0 + (a1 - a0) * u.x;
  let bot = a2 + (a3 - a2) * u.x;
  return top + (bot - top) * u.y;
}

// Clouds: five octaves of noise at the document's scale P.f.x (pixels at this level), between colours P.f2 and P.f3.
@compute @workgroup_size(256)
fn clouds(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let o = g.x * RS;
  let al = a[o + RS - 1u];
  let p = (vec2f(f32(P.i.z + i32(g.x % size)), f32(P.i.w + i32(g.x / size))) + 0.5) / P.f.x;
  var v = 0.0;
  var amp = 0.5;
  var q = p;
  for (var k = 0u; k < 5u; k++) {
    v += amp * vnoise(q, P.s.x + k);
    q = q * 2.0;
    amp *= 0.5;
  }
  v = clamp((v - 0.0) / 0.96875, 0.0, 1.0);
  for (var c = 0u; c < RS - 1u; c++) { b[o + c] = (P.f2[c] + (P.f3[c] - P.f2[c]) * v) * al; }
  b[o + RS - 1u] = al;
}

// Drop Shadow and Outer Glow: a holds the region blurred; b the region as it was, and gets the shadow laid
// under it: a's alpha read P.f.yz away (bilinear), at opacity P.f.x, in colour P.f2.
@compute @workgroup_size(256)
fn shadow(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size) { return; }
  let o = g.x * RS;
  let p = vec2f(f32(g.x % size), f32(g.x / size)) - P.f.yz;
  let A = min(1.0, bil_a(p, RS - 1u)) * P.f.x;
  let al = b[o + RS - 1u];
  for (var c = 0u; c < RS - 1u; c++) { b[o + c] = b[o + c] + P.f2[c] * A * (1.0 - al); }
  b[o + RS - 1u] = al + A * (1.0 - al);
}

// a added into b: parts of a region worked out apart, each cleared outside its own part.
@compute @workgroup_size(256)
fn add_region(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size * RS) { return; }
  b[g.x] = b[g.x] + a[g.x];
}

// b moved back towards a by 1 − k: an effect at opacity k.
@compute @workgroup_size(256)
fn mix(@builtin(global_invocation_id) g: vec3u) {
  let size = P.u.x;
  if (g.x >= size * size * RS) { return; }
  b[g.x] = a[g.x] + (b[g.x] - a[g.x]) * P.f.w;
}
`
}
