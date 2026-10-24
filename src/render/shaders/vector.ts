/**
 * Vectors on the GPU, in two kernels (geom/raster.ts and vector/paint.ts
 * have the references, sum for sum):
 *
 * - `raster`: coverage of a region (a tile, or a tile and the margin a
 *   feathered vector mask needs) from its line segments. Each pixel sums
 *   every segment's signed area to its right over its row, starting from
 *   its row's backdrop (what lies left of the region): the integral of the
 *   winding number over the pixel, turned into coverage by the fill rule. Segments are read through workgroup memory 256 at a time, and a
 *   pixel skips those that don't cross its row. The result is written, or
 *   multiplied into what's there (a stroke kept inside its fill), or
 *   multiplied by its complement (kept outside).
 * - `paint`: coverage times a paint (a colour, a gradient, a pattern) into
 *   a composite tile, premultiplied, which the compositing kernel then lays
 *   on with the item's blend mode and opacity. A pattern made from pixels
 *   is read from its own buffer (`patternBuffer`): a header of its levels'
 *   sizes and where each starts, then the levels.
 */
import { PATTERN_WGSL } from '../../vector/patterns'
import { FIELD_HEAD, FREEFORM_STRIDE, MESH_STRIDE, PATTERN_STRIDE, STROKE_SEG, type PaintParams, type PatternLevel } from '../../vector/paint'
import { FREEFORM_EPS } from '../../vector/mesh'
import { bufferAccess, preamble, type BufferFormat } from './common'

/** RasterParams: one vec4u. */
export const RASTER_PARAMS_BYTES = 16
/** Coverage written, multiplied in, or multiplied in as its complement. */
export const RASTER_OP = { write: 0, inside: 1, outside: 2 } as const

/** `n` is the number of segments in all; each workgroup reads its own strip's (geom/raster.ts, stripSegments). */
export function writeRasterParams(out: ArrayBuffer, p: { w: number; h: number; n: number; evenodd: boolean; op: number }) {
  new Uint32Array(out).set([p.w, p.h, p.n, (p.evenodd ? 1 : 0) | (p.op << 1)])
}

/** PaintGpuParams: a vec4u and six vec4s. */
export const PAINT_PARAMS_BYTES = 112

export function writePaintParams(out: ArrayBuffer, p: PaintParams) {
  const u = new Uint32Array(out)
  const f = new Float32Array(out)
  u.set([p.kind, p.stops.length / 6, p.pattern, (p.reverse ? 1 : 0) | (p.full ? 2 : 0)], 0)
  f.set([p.m[0], p.m[1], p.m[2], p.m[3]], 4)
  f.set([p.m[4], p.m[5], p.fw, 0], 8)
  f.set(p.colour.slice(0, 4), 12)
  f.set(p.colour2.slice(0, 4), 16)
  f.set([p.alpha, p.alpha2, 0, 0], 20)
  f.set(p.wrap ?? [0, 0, 0, 0], 24)
}

/**
 * A pattern's pyramid as one buffer of floats: the number of levels, each
 * level's width, height and where its pixels start, then the pixels.
 */
export function patternBuffer(levels: PatternLevel[]): Float32Array {
  const head = 1 + levels.length * 3
  const size = head + levels.reduce((n, l) => n + l.w * l.h * PATTERN_STRIDE, 0)
  const out = new Float32Array(size)
  out[0] = levels.length
  let at = head
  levels.forEach((l, i) => {
    out.set([l.w, l.h, at], 1 + i * 3)
    out.set(l.data, at)
    at += l.data.length
  })
  return out
}

/** Pattern sampling in WGSL reading the pyramid from a buffer of another name (Pattern Overlay's). */
export const patternImageWgsl = (buffer: string) => PATTERN_IMAGE_WGSL.replaceAll('pat[', `${buffer}[`)

/** Pattern sampling in WGSL, the same sums as vector/paint.ts's patternSample, reading `pat`. */
const PATTERN_IMAGE_WGSL = `
fn pat_wrap(v: i32, n: i32) -> u32 { return u32(((v % n) + n) % n); }
fn pat_px(o: u32, w: u32, x: u32, y: u32) -> array<f32, 5> {
  let b = o + (y * w + x) * ${PATTERN_STRIDE}u;
  return array<f32, 5>(pat[b], pat[b + 1u], pat[b + 2u], pat[b + 3u], pat[b + 4u]);
}
fn pat_level(l: u32, fu: f32, fv: f32) -> array<f32, 5> {
  let w = u32(pat[1u + l * 3u]);
  let h = u32(pat[2u + l * 3u]);
  let o = u32(pat[3u + l * 3u]);
  let x = fu * f32(w) - 0.5;
  let y = fv * f32(h) - 0.5;
  let x0 = floor(x);
  let y0 = floor(y);
  let fx = x - x0;
  let fy = y - y0;
  let xa = pat_wrap(i32(x0), i32(w));
  let xb = pat_wrap(i32(x0) + 1, i32(w));
  let ya = pat_wrap(i32(y0), i32(h));
  let yb = pat_wrap(i32(y0) + 1, i32(h));
  let p00 = pat_px(o, w, xa, ya);
  let p10 = pat_px(o, w, xb, ya);
  let p01 = pat_px(o, w, xa, yb);
  let p11 = pat_px(o, w, xb, yb);
  var r: array<f32, 5>;
  for (var c = 0u; c < 5u; c++) {
    let top = p00[c] * (1.0 - fx) + p10[c] * fx;
    let bottom = p01[c] * (1.0 - fx) + p11[c] * fx;
    r[c] = top * (1.0 - fy) + bottom * fy;
  }
  return r;
}
// Premultiplied colour (xyzw) and alpha at (u, v) in the pattern's pixels, with a footprint of fw pattern pixels.
fn pattern_image(u: f32, v: f32, fw: f32) -> array<f32, 5> {
  let n = u32(pat[0]);
  if (n == 0u) { return array<f32, 5>(0.0, 0.0, 0.0, 0.0, 0.0); }
  let w0 = pat[1];
  let h0 = pat[2];
  let lod = min(f32(n - 1u), max(0.0, log2(max(fw, 1e-6))));
  let l0 = u32(floor(lod));
  let t = lod - f32(l0);
  let fu = u / w0 - floor(u / w0);
  let fv = v / h0 - floor(v / h0);
  var r = pat_level(l0, fu, fv);
  if (t > 0.0 && l0 + 1u < n) {
    let q = pat_level(l0 + 1u, fu, fv);
    for (var c = 0u; c < 5u; c++) { r[c] = r[c] * (1.0 - t) + q[c] * t; }
  }
  return r;
}
`

/**
 * A stroke gradient's, a freeform gradient's and a mesh's sums, reading
 * their field from `pat` (vector/paint.ts: strokeT, freeformField and
 * meshFieldAt, the same sums; vector/mesh.ts has the mesh's arithmetic).
 */
const FIELD_WGSL = `
struct Paint4 { c: vec4f, a: f32 }

fn stroke_t(q: vec2f) -> f32 {
  let n = u32(pat[0]);
  var best = 3.0e38;
  var k = 0xffffffffu;
  var tau = 0.0;
  for (var s = 0u; s < n; s++) {
    let o = ${FIELD_HEAD}u + s * ${STROKE_SEG}u;
    let a = vec2f(pat[o], pat[o + 1u]);
    let ab = vec2f(pat[o + 2u], pat[o + 3u]) - a;
    let l2 = dot(ab, ab);
    var t = 0.0;
    if (l2 > 0.0) { t = clamp(dot(q - a, ab) / l2, 0.0, 1.0); }
    let dq = q - (a + ab * t);
    let d2 = dot(dq, dq);
    if (d2 < best) {
      best = d2;
      k = o;
      tau = t;
    }
  }
  if (k == 0xffffffffu) { return 0.0; }
  if (pat[1] < 0.5) { return (pat[k + 4u] + tau * (pat[k + 5u] - pat[k + 4u])) / max(pat[k + 6u], 1e-9); }
  let a = vec2f(pat[k], pat[k + 1u]);
  let ab = vec2f(pat[k + 2u], pat[k + 3u]) - a;
  let side = ab.x * (q.y - a.y) - ab.y * (q.x - a.x);
  var d = sqrt(best);
  if (side * pat[k + 11u] < 0.0) { d = -d; }
  let wl = pat[k + 7u] + tau * (pat[k + 9u] - pat[k + 7u]);
  let wr = pat[k + 8u] + tau * (pat[k + 10u] - pat[k + 8u]);
  return (d + wr) / max(wl + wr, 1e-9);
}

fn freeform_at(q: vec2f) -> Paint4 {
  let n = u32(pat[0]);
  var c = vec4f(0.0);
  var a = 0.0;
  var sum = 0.0;
  for (var i = 0u; i < n; i++) {
    let o = ${FIELD_HEAD}u + i * ${FREEFORM_STRIDE}u;
    let dq = q - vec2f(pat[o], pat[o + 1u]);
    let s2 = pat[o + 7u] * pat[o + 7u];
    let w = pow(s2 / (dot(dq, dq) + ${FREEFORM_EPS}), 1.5);
    let al = pat[o + 6u];
    c += vec4f(pat[o + 2u], pat[o + 3u], pat[o + 4u], pat[o + 5u]) * al * w;
    a += al * w;
    sum += w;
  }
  if (sum <= 0.0) { return Paint4(vec4f(0.0), 0.0); }
  return Paint4(c / sum, a / sum);
}

fn mesh_pt(vs: u32, cols: u32, i: u32, j: u32) -> vec2f {
  let o = vs + (j * (cols + 1u) + i) * ${MESH_STRIDE}u;
  return vec2f(pat[o], pat[o + 1u]);
}

// Where q is in the patch a b c d: u, v and how far outside it (vector/mesh.ts, invBilinear).
fn inv_bilinear(q: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> vec3f {
  let e = b - a;
  let f = d - a;
  let g = a - b + c - d;
  let h = q - a;
  let k2 = g.x * f.y - g.y * f.x;
  let k1 = e.x * f.y - e.y * f.x + h.x * g.y - h.y * g.x;
  let k0 = h.x * e.y - h.y * e.x;
  let w = sqrt(max(0.0, k1 * k1 - 4.0 * k0 * k2));
  var qq = -0.5 * (k1 - w);
  if (k1 >= 0.0) { qq = -0.5 * (k1 + w); }
  var roots = array<f32, 2>(1e9, 1e9);
  if (qq != 0.0) { roots[0] = k0 / qq; }
  if (k2 != 0.0) { roots[1] = qq / k2; }
  var best = vec3f(0.0, 0.0, 3.0e38);
  for (var r = 0u; r < 2u; r++) {
    let v = roots[r];
    let p = e + g * v;
    let pp = dot(p, p);
    var u = 0.0;
    if (pp > 0.0) { u = dot(h - f * v, p) / pp; }
    let out = max(max(0.0, max(-u, u - 1.0)), max(-v, v - 1.0));
    if (out < best.z) { best = vec3f(u, v, out); }
  }
  return best;
}

fn catmull_rom(f: f32) -> vec4f {
  let f2 = f * f;
  let f3 = f2 * f;
  return vec4f((-f3 + 2.0 * f2 - f) / 2.0, (3.0 * f3 - 5.0 * f2 + 2.0) / 2.0, (-3.0 * f3 + 4.0 * f2 + f) / 2.0, (f3 - f2) / 2.0);
}

fn mesh_at(q: vec2f) -> Paint4 {
  let cols = u32(pat[0]);
  let rows = u32(pat[1]);
  let np = u32(pat[2]);
  let vs = u32(pat[3]);
  var bi = 0u;
  var bj = 0u;
  var best = vec3f(0.0, 0.0, 3.0e38);
  for (var k = 0u; k < np; k++) {
    let i = u32(pat[${FIELD_HEAD}u + k * 2u]);
    let j = u32(pat[${FIELD_HEAD}u + k * 2u + 1u]);
    let r = inv_bilinear(q, mesh_pt(vs, cols, i, j), mesh_pt(vs, cols, i + 1u, j), mesh_pt(vs, cols, i + 1u, j + 1u), mesh_pt(vs, cols, i, j + 1u));
    if (r.z < best.z) {
      best = r;
      bi = i;
      bj = j;
      if (r.z <= 0.0) { break; }
    }
  }
  let gu = f32(bi) + clamp(best.x, 0.0, 1.0);
  let gv = f32(bj) + clamp(best.y, 0.0, 1.0);
  let iu = min(cols - 1u, u32(max(0.0, floor(gu))));
  let iv = min(rows - 1u, u32(max(0.0, floor(gv))));
  let wu = catmull_rom(clamp(gu - f32(iu), 0.0, 1.0));
  let wv = catmull_rom(clamp(gv - f32(iv), 0.0, 1.0));
  var c = vec4f(0.0);
  var a = 0.0;
  for (var b = 0u; b < 4u; b++) {
    let j = u32(clamp(i32(iv) - 1 + i32(b), 0, i32(rows)));
    for (var aa = 0u; aa < 4u; aa++) {
      let i = u32(clamp(i32(iu) - 1 + i32(aa), 0, i32(cols)));
      let w = wu[aa] * wv[b];
      let o = vs + (j * (cols + 1u) + i) * ${MESH_STRIDE}u;
      c += vec4f(pat[o + 2u], pat[o + 3u], pat[o + 4u], pat[o + 5u]) * w;
      a += pat[o + 6u] * w;
    }
  }
  let al = clamp(a, 0.0, 1.0);
  return Paint4(clamp(c, vec4f(0.0), vec4f(al)), al);
}
`

export const RASTER_WGSL = `
struct RasterP {
  w: u32,
  h: u32,
  n: u32,
  flags: u32,
}
@group(0) @binding(0) var<uniform> P: RasterP;
@group(0) @binding(1) var<storage, read> segs: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> cover: array<f32>;
// Each row's backdrop: the height of everything left of the region, summed.
@group(0) @binding(3) var<storage, read> rows: array<f32>;
// Where each strip of 16 rows starts in segs: a workgroup reads only its own.
@group(0) @binding(4) var<storage, read> strips: array<u32>;
var<workgroup> strip_range: vec2u;

var<workgroup> chunk: array<vec4f, 256>;

fn W(u: f32) -> f32 {
  if (u <= 0.0) { return u; }
  if (u >= 1.0) { return 0.5; }
  return u - 0.5 * u * u;
}

fn contrib(s: vec4f, px: f32, py: f32) -> f32 {
  var a = s.xy;
  var b = s.zw;
  var sgn = 1.0;
  if (a.y > b.y) {
    let t = a;
    a = b;
    b = t;
    sgn = -1.0;
  }
  let y0 = max(a.y, py);
  let y1 = min(b.y, py + 1.0);
  if (y1 <= y0) { return 0.0; }
  let k = (b.x - a.x) / (b.y - a.y);
  let xa = a.x + k * (y0 - a.y) - px;
  let xb = a.x + k * (y1 - a.y) - px;
  var avg: f32;
  if (abs(xb - xa) < 1e-5) {
    avg = clamp(1.0 - 0.5 * (xa + xb), 0.0, 1.0);
  } else {
    avg = (W(xb) - W(xa)) / (xb - xa);
  }
  return sgn * (y1 - y0) * avg;
}

@compute @workgroup_size(16, 16)
fn raster(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u) {
  let px = f32(g.x);
  let py = f32(g.y);
  var acc = 0.0;
  if (g.y < P.h) { acc = rows[g.y]; }
  // The strip's range, read once and shared: uniform across the workgroup, as its barriers need.
  if (li == 0u) { strip_range = vec2u(strips[wg.y], strips[wg.y + 1u]); }
  let range = workgroupUniformLoad(&strip_range);
  let first = range.x;
  let count = range.y - range.x;
  for (var base = 0u; base < count; base += 256u) {
    let j = base + li;
    if (j < count) { chunk[li] = segs[first + j]; } else { chunk[li] = vec4f(0.0); }
    workgroupBarrier();
    let m = min(256u, count - base);
    for (var i = 0u; i < m; i++) {
      let s = chunk[i];
      // Not in this pixel's row, or wholly right of it: nothing to add.
      if (max(s.y, s.w) <= py || min(s.y, s.w) >= py + 1.0 || min(s.x, s.z) >= px + 1.0) { continue; }
      acc += contrib(s, px, py);
    }
    workgroupBarrier();
  }
  if (g.x >= P.w || g.y >= P.h) { return; }
  var c: f32;
  if ((P.flags & 1u) != 0u) {
    c = abs(acc - 2.0 * round(0.5 * acc));
  } else {
    c = min(abs(acc), 1.0);
  }
  let i = g.y * P.w + g.x;
  let op = P.flags >> 1u;
  if (op == ${RASTER_OP.inside}u) {
    cover[i] = cover[i] * c;
  } else if (op == ${RASTER_OP.outside}u) {
    cover[i] = cover[i] * (1.0 - c);
  } else {
    cover[i] = c;
  }
}
`

export function paintWgsl(f: BufferFormat): string {
  return `${preamble(f)}
struct PaintP {
  u: vec4u,
  m0: vec4f,
  m1: vec4f,
  colour: vec4f,
  colour2: vec4f,
  alphas: vec4f,
  // A tiled document's gradient: the period across and down in tile pixels (0 for none), and the anchor.
  wrap: vec4f,
}
@group(0) @binding(0) var<uniform> P: PaintP;
@group(0) @binding(1) var<storage, read> cover: array<f32>;
@group(0) @binding(2) var<storage, read> stops: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<T>;
@group(0) @binding(4) var<storage, read> pat: array<f32>;
${bufferAccess(f, 'out', true)}
${PATTERN_WGSL}
${PATTERN_IMAGE_WGSL}

const PI2: f32 = 6.283185307179586;
${FIELD_WGSL}

fn stop_at(i: u32) -> f32 { return stops[i * 6u]; }
fn stop_colour(i: u32) -> vec4f { let o = i * 6u + 1u; return vec4f(stops[o], stops[o + 1u], stops[o + 2u], stops[o + 3u]); }
fn stop_alpha(i: u32) -> f32 { return stops[i * 6u + 5u]; }

@compute @workgroup_size(16, 16)
fn paint(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let i = g.y * TILE + g.x;
  var cov = 1.0;
  if ((P.u.w & 2u) == 0u) { cov = cover[i]; }
  if (cov <= 0.0) {
    store_out(i, Px(vec4f(0.0), 0.0));
    return;
  }
  let kind = P.u.x;
  var c: vec4f;
  var a: f32;
  if (kind == 0u) {
    c = P.colour;
    a = 1.0;
  } else {
    var x = f32(g.x) + 0.5;
    var y = f32(g.y) + 0.5;
    // In a tiled document, the copy of the pixel nearest the gradient's anchor.
    if (P.wrap.x > 0.0) { x = x - round((x - P.wrap.z) / P.wrap.x) * P.wrap.x; }
    if (P.wrap.y > 0.0) { y = y - round((y - P.wrap.w) / P.wrap.y) * P.wrap.y; }
    let gp = vec2f(P.m0.x * x + P.m0.z * y + P.m1.x, P.m0.y * x + P.m0.w * y + P.m1.y);
    if (kind == 7u) {
      let s = pattern_image(gp.x, gp.y, P.m1.z);
      c = vec4f(s[0], s[1], s[2], s[3]);
      a = s[4];
    } else if (kind == 9u) {
      let s = freeform_at(gp);
      c = s.c;
      a = s.a;
    } else if (kind == 10u) {
      let s = mesh_at(gp);
      c = s.c;
      a = s.a;
    } else if (kind == 5u) {
      let v = pattern_value(P.u.z, gp, P.m1.z);
      a = P.alphas.y * (1.0 - v) + P.alphas.x * v;
      c = P.colour2 * P.alphas.y * (1.0 - v) + P.colour * P.alphas.x * v;
    } else {
      var t: f32;
      if (kind == 1u) {
        t = gp.x;
      } else if (kind == 8u) {
        t = stroke_t(gp);
      } else if (kind == 6u) {
        t = abs(gp.x);
      } else if (kind == 2u) {
        t = length(gp);
      } else if (kind == 3u) {
        let ang = atan2(gp.y, gp.x) / PI2;
        t = ang - floor(ang);
      } else {
        t = abs(gp.x) + abs(gp.y);
      }
      if ((P.u.w & 1u) != 0u) { t = 1.0 - t; }
      t = clamp(t, 0.0, 1.0);
      let n = P.u.y;
      var sc: vec4f;
      var sa: f32;
      if (t <= stop_at(0u)) {
        sc = stop_colour(0u);
        sa = stop_alpha(0u);
      } else if (t >= stop_at(n - 1u)) {
        sc = stop_colour(n - 1u);
        sa = stop_alpha(n - 1u);
      } else {
        var k = 0u;
        while (k < n - 2u && t > stop_at(k + 1u)) { k++; }
        let span = max(1e-6, stop_at(k + 1u) - stop_at(k));
        let fr = clamp((t - stop_at(k)) / span, 0.0, 1.0);
        sc = mix(stop_colour(k), stop_colour(k + 1u), fr);
        sa = mix(stop_alpha(k), stop_alpha(k + 1u), fr);
      }
      c = sc * sa;
      a = sa;
    }
  }
  store_out(i, Px(c * cov, a * cov));
}
`
}
