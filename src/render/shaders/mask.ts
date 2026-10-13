/**
 * Masks on the GPU: one composite tile's worth of a node's masks, as a
 * coverage buffer (256 × 256 f32) the compositing kernel multiplies its
 * alpha scale by (binding 3, FLAG_MASK).
 *
 * Three entry points, run in order for each mask:
 *
 * - `sample` reads the mask's gray tiles through its transform, with the
 *   same window table, filters and mips as a pixel layer, into a buffer
 *   `size` pixels a side: the tile and `margin` pixels around it, which a
 *   feather needs. Where the mask has no tiles it is `outside`.
 * - `blur_h` blurs that across, a Gaussian of `sigma` (the mask's feather),
 *   keeping only the tile's own columns.
 * - `finish` blurs down, inverts if asked, applies the density
 *   (m' = 1 − density · (1 − m)) and writes the tile's coverage, or
 *   multiplies it into what an earlier mask wrote: a node's masks multiply.
 *
 * Without a feather, `sample` is followed by `finish` straight away.
 */
import { OPS_WGSL, blendWgsl, pixelSourceWgsl, strokeWgsl } from './composite'
import { bufferAccess, preamble, type BufferFormat } from './common'

/** MaskParams: two vec4s of mapping, the window, eight scalars, a live stroke's fields as the compositing kernel has them, then a wrap. */
export const MASK_PARAMS_BYTES = 128
export const MASK_INVERT = 1
export const MASK_MULTIPLY = 2

export function writeMaskParams(
  out: ArrayBuffer,
  p: {
    m: number[]
    win: [number, number, number, number]
    resample: number
    size: number
    margin: number
    flags: number
    outside: number
    density: number
    sigma: number
    stroke?: { stride: number; blend: number; eraser: boolean; replace?: boolean; colour: number[]; selection?: boolean; colourOffset?: number }
    /** A tiled document: the mask's reads wrap at this size (its level's pixels; 0 where they don't), from its pixel 0. */
    wrap?: [number, number]
  },
) {
  const f = new Float32Array(out)
  const u = new Uint32Array(out)
  const i = new Int32Array(out)
  f.set([p.m[0], p.m[1], p.m[2], p.m[3], p.m[4], p.m[5], 0, 0], 0)
  i.set(p.win, 8)
  u.set([p.resample, p.size, p.margin, p.flags], 12)
  f.set([p.outside, p.density, p.sigma, 0], 16)
  if (p.stroke) {
    // As the compositing kernel encodes it (composite.ts writeParams).
    u.set([p.stroke.stride, p.stroke.blend, p.stroke.replace ? 2 : p.stroke.eraser ? 1 : 0, (p.stroke.selection ? 1 : 0) | ((p.stroke.colourOffset ?? 1) << 8)], 20)
    f.set([...p.stroke.colour, 0, 0, 0, 0].slice(0, 4), 24)
  }
  i.set([...(p.wrap ?? [0, 0]), 0, 0], 28)
}

const PARAMS = `
struct Params {
  m0: vec4f,
  m1: vec4f,
  win: vec4i,
  resample: u32,
  size: u32,
  margin: u32,
  flags: u32,
  outside: f32,
  density: f32,
  sigma: f32,
  _pad: f32,
  stroke: vec4u,
  stroke_colour: vec4f,
  // A tiled document: where the mask's reads wrap (its level's pixels, 0 for none).
  wrap: vec4i,
}
@group(0) @binding(0) var<uniform> P: Params;
`

/** Gaussian weight of offset k; the sums normalise, so the constant factor doesn't matter. */
const GAUSS = `
fn gauss(k: i32) -> f32 {
  let x = f32(k);
  return exp(-(x * x) / (2.0 * P.sigma * P.sigma));
}
`

/**
 * The mask kernels. The stroke variant lays a stroke being painted on the
 * mask (or, in Quick Mask, on the selection) onto its tiles as they're read,
 * as the compositing kernel does for a pixel layer.
 */
export const maskWgsl = (stroke: boolean) => `${preamble({ mode: 'gray', store: 'f32' })}
${PARAMS}
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
@group(0) @binding(2) var<storage, read_write> wide: array<f32>;
@group(0) @binding(3) var<storage, read_write> across: array<f32>;
${stroke ? `${blendWgsl('gray')}${OPS_WGSL}${strokeWgsl('gray')}` : ''}
${pixelSourceWgsl('gray', 8, stroke, 'wrapped_texel')}
${GAUSS}

// A read past a tiled document's period comes from the other side, in the mask's own pixels.
fn wrap_mask(i: i32, first: i32, size: i32) -> i32 {
  if (size <= 0) { return i; }
  let a = i + first * 256;
  return ((a % size) + size) % size - first * 256;
}
fn wrapped_texel(ix: i32, iy: i32) -> Px {
  return texel(wrap_mask(ix, P.win.x, P.wrap.x), wrap_mask(iy, P.win.y, P.wrap.y));
}

@compute @workgroup_size(16, 16)
fn sample(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= P.size || g.y >= P.size) { return; }
  let o = vec2f(g.xy) + 0.5 - f32(P.margin);
  let p = vec2f(P.m0.x * o.x + P.m0.z * o.y + P.m1.x, P.m0.y * o.x + P.m0.w * o.y + P.m1.y);
  let s = sample_source(p);
  wide[g.y * P.size + g.x] = clamp(s.c.x + (1.0 - s.a) * P.outside, 0.0, 1.0);
}

@compute @workgroup_size(16, 16)
fn blur_h(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= P.size) { return; }
  let r = i32(P.margin);
  let row = g.y * P.size;
  let x = i32(g.x) + r;
  var sum = 0.0;
  var wsum = 0.0;
  for (var k = -r; k <= r; k++) {
    let w = gauss(k);
    sum += wide[row + u32(x + k)] * w;
    wsum += w;
  }
  across[g.y * TILE + g.x] = sum / wsum;
}

@compute @workgroup_size(16, 16)
fn finish(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let r = i32(P.margin);
  var v: f32;
  if (r == 0) {
    v = across[g.y * TILE + g.x];
  } else {
    var sum = 0.0;
    var wsum = 0.0;
    for (var k = -r; k <= r; k++) {
      let w = gauss(k);
      sum += across[u32(i32(g.y) + r + k) * TILE + g.x] * w;
      wsum += w;
    }
    v = sum / wsum;
  }
  if ((P.flags & ${MASK_INVERT}u) != 0u) { v = 1.0 - v; }
  v = 1.0 - P.density * (1.0 - v);
  let i = g.y * TILE + g.x;
  if ((P.flags & ${MASK_MULTIPLY}u) != 0u) { out[i] = out[i] * v; } else { out[i] = v; }
}
`

/** A mask's coverage shown as an opaque gray image in a document's format: its thumbnail. */
export function maskShowWgsl(f: BufferFormat): string {
  return `${preamble(f)}
@group(0) @binding(0) var<storage, read> cover: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<T>;
${bufferAccess(f, 'dst', true)}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let i = g.y * TILE + g.x;
  store_dst(i, Px(vec4f(cover[i]), 1.0));
}
`
}
