/**
 * Adjustments on the GPU: an adjustment's program (adjust/defs.ts) run on
 * every pixel of a composite tile (or a filter region, in f32), in place. Each pixel is taken out of
 * premultiplied form, adjusted, and put back with its alpha unchanged.
 * `runProgram` is the reference this is held to (check:gpu).
 */
import { LUT_SIZE, OP, type Program } from '../../adjust/defs'
import { CT_K, CT_K_INV, CT_SIZE } from '../../color/cmykAdjust'
import { bufferAccess, preamble, type BufferFormat } from './common'

/**
 * AdjustParams: four u32s (the op, the mode, how many pixels, and whether
 * a CMYK document's profile tables are bound), then sixteen vec4s of the
 * program's numbers.
 */
export const ADJUST_PARAMS_BYTES = 16 + 16 * 16

/** `count` pixels: a composite tile's 65,536, or a filter region's. */
export function writeAdjustParams(out: ArrayBuffer, p: Program, mode: 'rgb' | 'gray' | 'cmyk', count = 65536, tables = false) {
  const u = new Uint32Array(out)
  const f = new Float32Array(out)
  u.set([p.op, mode === 'rgb' ? 0 : mode === 'gray' ? 1 : 2, count, tables ? 1 : 0], 0)
  f.set(p.f.slice(0, 64), 4)
}

/** A CMYK document's tables (color/cmykAdjust.ts) as the kernel reads them: `fwd` then `inv`. */
export function cmykTableData(t: { fwd: Float32Array; inv: Float32Array }): Float32Array {
  const out = new Float32Array(t.fwd.length + t.inv.length)
  out.set(t.fwd)
  out.set(t.inv, t.fwd.length)
  return out
}

export function adjustWgsl(fmt: BufferFormat): string {
  const n = fmt.mode === 'rgb' ? 3 : fmt.mode === 'gray' ? 1 : 4
  return `${preamble(fmt)}
struct AdjustParams {
  op: u32,
  mode: u32,
  count: u32,
  tables: u32,
  f: array<vec4f, 16>,
}
@group(0) @binding(0) var<uniform> A: AdjustParams;
@group(0) @binding(1) var<storage, read_write> buf: array<T>;
@group(0) @binding(2) var<storage, read> table: array<f32>;
${fmt.mode === 'cmyk' ? '@group(0) @binding(3) var<storage, read> ctab: array<vec4f>;' : ''}
${bufferAccess(fmt, 'buf', true)}
${fmt.mode === 'cmyk' ? cmykTablesWgsl() : ''}

const N: u32 = ${LUT_SIZE}u;

fn fv(i: u32) -> f32 { return A.f[i / 4u][i % 4u]; }

fn lookup(c: u32, x: f32) -> f32 {
  let p = clamp(x, 0.0, 1.0) * f32(N - 1u);
  let i = min(N - 2u, u32(floor(p)));
  let fr = p - f32(i);
  return table[c * N + i] * (1.0 - fr) + table[c * N + i + 1u] * fr;
}

fn luma(c: vec3f) -> f32 { return 0.299 * c.x + 0.587 * c.y + 0.114 * c.z; }

fn rgb_to_hsl(c: vec3f) -> vec3f {
  let mx = max(c.x, max(c.y, c.z));
  let mn = min(c.x, min(c.y, c.z));
  let l = (mx + mn) * 0.5;
  if (mx == mn) { return vec3f(0.0, 0.0, l); }
  let d = mx - mn;
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h: f32;
  if (mx == c.x) { h = (c.y - c.z) / d + select(0.0, 6.0, c.y < c.z); }
  else if (mx == c.y) { h = (c.z - c.x) / d + 2.0; }
  else { h = (c.x - c.y) / d + 4.0; }
  return vec3f(h / 6.0, s, l);
}

fn hue_part(p: f32, q: f32, t0: f32) -> f32 {
  let t = t0 - floor(t0);
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> vec3f {
  if (s <= 0.0) { return vec3f(l); }
  let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
  let p = 2.0 * l - q;
  return vec3f(hue_part(p, q, h + 1.0 / 3.0), hue_part(p, q, h), hue_part(p, q, h - 1.0 / 3.0));
}

fn sat_amount(s: f32, a: f32) -> f32 {
  if (a < 0.0) { return s * (1.0 + a); }
  return clamp(s + (1.0 - s) * a * s, 0.0, 1.0);
}

// Hue/Saturation's saturation, Photoshop's way: adjust/defs.ts saturate.
fn saturate(c: vec3f, a: f32) -> vec3f {
  let mx = max(c.x, max(c.y, c.z));
  let mn = min(c.x, min(c.y, c.z));
  let delta = mx - mn;
  if (delta <= 0.0 || a == 0.0) { return c; }
  let sum = mx + mn;
  let L = sum * 0.5;
  if (a < 0.0) { return vec3f(L) + (c - vec3f(L)) * (1.0 + a); }
  let S = select(delta / (2.0 - sum), delta / sum, L < 0.5);
  let k = 1.0 / select(1.0 - a, S, a + S >= 1.0) - 1.0;
  return clamp(c + (c - vec3f(L)) * k, vec3f(0.0), vec3f(1.0));
}

// A program on one straight working-space colour: adjust/defs.ts runProgram.
fn run(c0: vec4f) -> vec4f {
  let op = A.op;
  if (op == ${OP.lut}u) {
    let ink = fv(0u) > 0.5;
    var o = c0;
    for (var k = 0u; k < ${n}u; k++) {
      let v = c0[k];
      o[k] = select(lookup(k, v), 1.0 - lookup(k, 1.0 - v), ink);
    }
    return o;
  }
  var rgb: vec3f;
  if (A.mode == 0u) { rgb = c0.xyz; }
  else if (A.mode == 1u) { rgb = vec3f(c0.x); }
  else { rgb = ${fmt.mode === 'cmyk' ? 'select(c0.xyz * c0.w, cmyk_to_rgb(c0), A.tables == 1u)' : 'c0.xyz * c0.w'}; }
  var out: vec3f;
  switch op {
    case ${OP.threshold}u: {
      let y = select(0.0, 1.0, luma(rgb) >= fv(0u));
      if (A.mode == 2u) { return vec4f(1.0, 1.0, 1.0, y); }
      out = vec3f(y);
    }
    case ${OP.hsl}u: {
      let L = fv(2u);
      if (fv(3u) > 0.5) {
        var hsl = rgb_to_hsl(rgb);
        hsl.x = select(fv(0u), fv(0u) + 1.0, fv(0u) < 0.0);
        hsl.y = clamp(0.25 + fv(1u) * 0.75, 0.0, 1.0);
        hsl.z = select(hsl.z + (1.0 - hsl.z) * L, hsl.z * (1.0 + L), L < 0.0);
        out = hsl_to_rgb(hsl.x, hsl.y, hsl.z);
      } else {
        let lit = select(rgb + (vec3f(1.0) - rgb) * L, rgb * (1.0 + L), L < 0.0);
        let hsl = rgb_to_hsl(lit);
        out = saturate(hsl_to_rgb(hsl.x + fv(0u), hsl.y, hsl.z), fv(1u));
      }
    }
    case ${OP.vibrance}u: {
      var hsl = rgb_to_hsl(rgb);
      hsl.y = clamp(hsl.y * (1.0 + fv(0u) * (1.0 - hsl.y)), 0.0, 1.0);
      hsl.y = sat_amount(hsl.y, fv(1u));
      out = hsl_to_rgb(hsl.x, hsl.y, hsl.z);
    }
    case ${OP.balance}u: {
      let y0 = luma(rgb);
      let ws = (1.0 - y0) * (1.0 - y0);
      let wh = y0 * y0;
      let wm = 1.0 - ws - wh;
      out = rgb + ws * vec3f(fv(0u), fv(1u), fv(2u)) + wm * vec3f(fv(3u), fv(4u), fv(5u)) + wh * vec3f(fv(6u), fv(7u), fv(8u));
      if (fv(9u) > 0.5) { out = out + (y0 - luma(out)); }
    }
    case ${OP.bw}u: {
      // The strongest channel's primary and the secondary it makes with the next.
      var hi = 0u;
      var mid = 1u;
      var lo = 2u;
      if (rgb[mid] > rgb[hi]) { let t = hi; hi = mid; mid = t; }
      if (rgb[lo] > rgb[mid]) { let t = mid; mid = lo; lo = t; }
      if (rgb[mid] > rgb[hi]) { let t = hi; hi = mid; mid = t; }
      let primary = hi * 2u;
      let pair = hi + mid;
      let secondary = select(select(5u, 3u, pair == 3u), 1u, pair == 1u);
      let y = clamp(rgb[lo] + (rgb[hi] - rgb[mid]) * fv(primary) + (rgb[mid] - rgb[lo]) * fv(secondary), 0.0, 1.0);
      if (fv(6u) > 0.5) {
        let t = hsl_to_rgb(fv(7u), fv(8u), y);
        out = t + (y - luma(t));
      } else {
        out = vec3f(y);
      }
    }
    case ${OP.mixer}u: {
      out = vec3f(
        dot(rgb, vec3f(fv(0u), fv(1u), fv(2u))) + fv(3u),
        dot(rgb, vec3f(fv(4u), fv(5u), fv(6u))) + fv(7u),
        dot(rgb, vec3f(fv(8u), fv(9u), fv(10u))) + fv(11u),
      );
      if (A.mode == 1u) { out = vec3f(dot(rgb, vec3f(fv(12u), fv(13u), fv(14u))) + fv(15u)); }
    }
    case ${OP.cube}u: {
      // A colour cube, S a side, red fastest: trilinear.
      let S = u32(fv(0u));
      let q = clamp(rgb, vec3f(0.0), vec3f(1.0)) * f32(S - 1u);
      let i0 = min(vec3u(floor(q)), vec3u(S - 2u));
      let fr = q - vec3f(i0);
      var o = vec3f(0.0);
      for (var dz = 0u; dz < 2u; dz++) { for (var dy = 0u; dy < 2u; dy++) { for (var dx = 0u; dx < 2u; dx++) {
        let w = select(1.0 - fr.x, fr.x, dx == 1u) * select(1.0 - fr.y, fr.y, dy == 1u) * select(1.0 - fr.z, fr.z, dz == 1u);
        let k = (((i0.z + dz) * S + i0.y + dy) * S + i0.x + dx) * 3u;
        o += w * vec3f(table[k], table[k + 1u], table[k + 2u]);
      } } }
      out = o;
    }
    case ${OP.gradient}u: {
      let p = clamp(luma(rgb), 0.0, 1.0) * f32(N - 1u);
      let i = min(N - 2u, u32(floor(p)));
      let fr = p - f32(i);
      var g = vec4f(0.0);
      for (var k = 0u; k < 4u; k++) { g[k] = table[i * 4u + k] * (1.0 - fr) + table[(i + 1u) * 4u + k] * fr; }
      return g;
    }
    default: { return c0; }
  }
  out = clamp(out, vec3f(0.0), vec3f(1.0));
  if (A.mode == 0u) { return vec4f(out, 0.0); }
  if (A.mode == 1u) { return vec4f(clamp(luma(out), 0.0, 1.0), 0.0, 0.0, 0.0); }
  let k = c0.w;
  ${fmt.mode === 'cmyk' ? 'if (A.tables == 1u) { return vec4f(clamp(c0.xyz + rgb_to_cmy(out, k) - rgb_to_cmy(rgb, k), vec3f(0.0), vec3f(1.0)), k); }' : ''}
  if (k <= 1e-6) { return vec4f(1.0, 1.0, 1.0, k); }
  return vec4f(clamp(out / k, vec3f(0.0), vec3f(1.0)), k);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= A.count) { return; }
  let p = load_buf(i);
  if (p.a <= 0.0) { return; }
  let s = clamp(p.c / p.a, vec4f(0.0), vec4f(1.0));
  let o = run(s);
  store_buf(i, Px(o * p.a, p.a));
}
`
}

/** The tables' samplers: color/cmykAdjust.ts sample4, by hand. */
function cmykTablesWgsl(): string {
  return `
const CS: u32 = ${CT_SIZE}u;
const CK: u32 = ${CT_K}u;
const CKI: u32 = ${CT_K_INV}u;
const CINV: u32 = ${CT_SIZE ** 3 * CT_K}u;

fn cat(base: u32, i: u32, j: u32, k: u32) -> vec3f { return ctab[base + (k * CS + j) * CS + i].xyz; }

fn ctetra(base: u32, p: vec3f) -> vec3f {
  let s1 = f32(CS - 1u);
  let f = clamp(p, vec3f(0.0), vec3f(1.0)) * s1;
  let i0 = min(floor(f), vec3f(s1 - 1.0));
  let r = f - i0;
  let x0 = u32(i0.x);
  let y0 = u32(i0.y);
  let z0 = u32(i0.z);
  let c000 = cat(base, x0, y0, z0);
  let c111 = cat(base, x0 + 1u, y0 + 1u, z0 + 1u);
  if (r.x >= r.y) {
    if (r.y >= r.z) {
      let c100 = cat(base, x0 + 1u, y0, z0);
      let c110 = cat(base, x0 + 1u, y0 + 1u, z0);
      return c000 + r.x * (c100 - c000) + r.y * (c110 - c100) + r.z * (c111 - c110);
    }
    if (r.x >= r.z) {
      let c100 = cat(base, x0 + 1u, y0, z0);
      let c101 = cat(base, x0 + 1u, y0, z0 + 1u);
      return c000 + r.x * (c100 - c000) + r.z * (c101 - c100) + r.y * (c111 - c101);
    }
    let c001 = cat(base, x0, y0, z0 + 1u);
    let c101 = cat(base, x0 + 1u, y0, z0 + 1u);
    return c000 + r.z * (c001 - c000) + r.x * (c101 - c001) + r.y * (c111 - c101);
  }
  if (r.z >= r.y) {
    let c001 = cat(base, x0, y0, z0 + 1u);
    let c011 = cat(base, x0, y0 + 1u, z0 + 1u);
    return c000 + r.z * (c001 - c000) + r.y * (c011 - c001) + r.x * (c111 - c011);
  }
  if (r.z >= r.x) {
    let c010 = cat(base, x0, y0 + 1u, z0);
    let c011 = cat(base, x0, y0 + 1u, z0 + 1u);
    return c000 + r.y * (c010 - c000) + r.z * (c011 - c010) + r.x * (c111 - c011);
  }
  let c010 = cat(base, x0, y0 + 1u, z0);
  let c110 = cat(base, x0 + 1u, y0 + 1u, z0);
  return c000 + r.y * (c010 - c000) + r.x * (c110 - c010) + r.z * (c111 - c110);
}

fn csample(base: u32, p: vec3f, w: f32, slices: u32) -> vec3f {
  let slice = CS * CS * CS;
  let fk = clamp(w, 0.0, 1.0) * f32(slices - 1u);
  let k0 = min(u32(floor(fk)), slices - 2u);
  let rk = fk - f32(k0);
  return ctetra(base + k0 * slice, p) * (1.0 - rk) + ctetra(base + (k0 + 1u) * slice, p) * rk;
}

fn cmyk_to_rgb(c: vec4f) -> vec3f { return csample(0u, c.xyz, c.w, CK); }
fn rgb_to_cmy(rgb: vec3f, k: f32) -> vec3f { return csample(CINV, rgb, k, CKI); }
`
}
