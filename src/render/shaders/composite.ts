/**
 * The compositing kernel: lays one source onto a composite tile, with an
 * operation (over, atop, lerp, knock: ref/composite.ts) and a blend mode
 * (blendModes.ts). One invocation per pixel of the 256 × 256 tile.
 *
 * The source is either a pixel layer, sampled through its live transform
 * from the tile atlas with the layer's filter, or another composite buffer
 * (a group's result). Each is its own variant, as is each colour mode,
 * source depth and storage precision; the operation and blend mode are
 * uniforms, so the variants stay few.
 *
 * Every sum here is the CPU reference's, in the same order, and check-gpu
 * holds the two together.
 */
import type { ColourMode, Depth } from '../../doc/types'
import { BLEND_DEFS, blendIndex } from '../blendModes'
import { bufferAccess, preamble, type BufferFormat } from './common'

export interface CompositeVariant extends BufferFormat {
  /** Where the source comes from. */
  source: 'pixel' | 'buffer'
  /** The atlas's depth, for a pixel source. */
  depth: Depth
  /** A pixel source with a stroke being painted on it, laid on as each texel is read. */
  stroke?: boolean
}

export const variantKey = (v: CompositeVariant) => `${v.mode}/${v.store}/${v.source}/${v.source === 'pixel' ? v.depth : ''}${v.stroke ? '/stroke' : ''}`

/** The operations, as the kernel numbers them. */
export const OP_INDEX = { over: 0, atop: 1, lerp: 2, knock: 3, tint: 4 } as const
/** Flags in Params.flags. */
export const FLAG_DISSOLVE = 1
export const FLAG_MASK = 2
/** Filters, as the kernel numbers them. */
export const FILTER_INDEX = { nearest: 0, bilinear: 1, bicubic: 2, lanczos: 3 } as const

/** Params, as the uniform buffer holds it: 28 words. */
export const PARAMS_BYTES = 128

/**
 * Writes Params. `m` maps an output pixel's centre (0..256 within the tile)
 * to a position in the source window's pixels, worked out on the CPU in
 * doubles so the shader's floats stay small.
 */
export function writeParams(
  out: ArrayBuffer,
  p: {
    m: number[]
    op: number
    blend: number
    filter: number
    flags: number
    k: number
    seed: number
    origin: [number, number]
    win: [number, number, number, number]
    /**
     * A live stroke: floats per stroke pixel, its blend mode, whether it erases or (Smudge, the
     * Mixer Brush) replaces, its colour when it has one, and where in a pixel its colour is.
     */
    stroke?: { stride: number; blend: number; eraser: boolean; replace?: boolean; colour: number[]; selection?: boolean; colourOffset?: number }
    /** Source pixels read only inside this rectangle (window pixels: left, top, right, bottom): a copy of a tiled document's layer. */
    clip?: [number, number, number, number]
  },
) {
  const f = new Float32Array(out)
  const u = new Uint32Array(out)
  const i = new Int32Array(out)
  f.set([p.m[0], p.m[1], p.m[2], p.m[3]], 0)
  f.set([p.m[4], p.m[5], 0, 0], 4)
  u.set([p.op, p.blend, p.filter, p.flags], 8)
  f[12] = p.k
  u[13] = p.seed >>> 0
  i[14] = p.origin[0]
  i[15] = p.origin[1]
  i.set(p.win, 16)
  if (p.stroke) {
    u.set([p.stroke.stride, p.stroke.blend, p.stroke.replace ? 2 : p.stroke.eraser ? 1 : 0, (p.stroke.selection ? 1 : 0) | ((p.stroke.colourOffset ?? 1) << 8)], 20)
    f.set([...p.stroke.colour, 0, 0, 0, 0].slice(0, 4), 24)
  }
  f.set(p.clip ?? [0, 0, 0, 0], 28)
}

const NON_SEPARABLE = {
  darker: blendIndex('darker-color'),
  lighter: blendIndex('lighter-color'),
  hue: blendIndex('hue'),
  saturation: blendIndex('saturation'),
  color: blendIndex('color'),
  luminosity: blendIndex('luminosity'),
}

/** The blend functions: one case per separable mode, then the whole-colour ones. */
export function blendWgsl(mode: ColourMode): string {
  const cases = BLEND_DEFS.filter((d) => d.wgsl)
    .map((d) => `    case ${blendIndex(d.id)}u: { return ${d.wgsl}; }`)
    .join('\n')
  const nc = mode === 'gray' ? 1 : mode === 'rgb' ? 3 : 4
  // In Gray there's no hue: Luminosity takes the source, the others keep the backdrop.
  // In CMYK the first three light channels are treated as RGB and black on its own.
  const nonsep =
    nc === 1
      ? `  if (mode == ${NON_SEPARABLE.luminosity}u) { return s; }
  return b;`
      : `  var rgb: vec3f;
  switch mode {
    case ${NON_SEPARABLE.hue}u: { rgb = set_lum(set_sat(s.xyz, sat(b.xyz)), lum(b.xyz)); }
    case ${NON_SEPARABLE.saturation}u: { rgb = set_lum(set_sat(b.xyz, sat(s.xyz)), lum(b.xyz)); }
    case ${NON_SEPARABLE.color}u: { rgb = set_lum(s.xyz, lum(b.xyz)); }
    default: { rgb = set_lum(b.xyz, lum(s.xyz)); }
  }
  ${nc === 4 ? `return vec4f(rgb, select(b.w, s.w, mode == ${NON_SEPARABLE.luminosity}u));` : 'return vec4f(rgb, 0.0);'}`
  const sum = nc === 1 ? 'v.x' : nc === 3 ? 'v.x + v.y + v.z' : 'v.x + v.y + v.z + v.w'
  return `
fn hard_light(b: f32, s: f32) -> f32 {
  return select(b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0), b * (2.0 * s), s <= 0.5);
}
fn color_dodge(b: f32, s: f32) -> f32 {
  return select(select(min(1.0, b / (1.0 - s)), 1.0, s >= 1.0), 0.0, b <= 0.0);
}
fn color_burn(b: f32, s: f32) -> f32 {
  return select(select(1.0 - min(1.0, (1.0 - b) / s), 0.0, s <= 0.0), 1.0, b >= 1.0);
}

fn sep(mode: u32, b: f32, s: f32) -> f32 {
  switch mode {
${cases}
    default: { return s; }
  }
}

fn lum(c: vec3f) -> f32 { return 0.3 * c.x + 0.59 * c.y + 0.11 * c.z; }
fn clip_colour(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.x, min(c.y, c.z));
  let x = max(c.x, max(c.y, c.z));
  var o = c;
  if (n < 0.0) { o = l + (o - l) * l / (l - n); }
  if (x > 1.0) { o = l + (o - l) * (1.0 - l) / (x - l); }
  return o;
}
fn set_lum(c: vec3f, l: f32) -> vec3f { return clip_colour(c + (l - lum(c))); }
fn sat(c: vec3f) -> f32 { return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z)); }
fn set_sat(c: vec3f, s: f32) -> vec3f {
  let hi = max(c.x, max(c.y, c.z));
  let lo = min(c.x, min(c.y, c.z));
  if (hi <= lo) { return vec3f(0.0); }
  return (c - lo) * s / (hi - lo);
}
fn total(v: vec4f) -> f32 { return ${sum}; }

fn blend_colour(mode: u32, b: vec4f, s: vec4f) -> vec4f {
  if (mode == ${NON_SEPARABLE.darker}u) { return select(b, s, total(s) < total(b)); }
  if (mode == ${NON_SEPARABLE.lighter}u) { return select(b, s, total(s) > total(b)); }
  if (mode >= ${NON_SEPARABLE.hue}u) {
${nonsep}
  }
  return vec4f(sep(mode, b.x, s.x), sep(mode, b.y, s.y), sep(mode, b.z, s.z), sep(mode, b.w, s.w));
}
`
}

export const OPS_WGSL = `
fn unpremult(p: Px) -> vec4f {
  if (p.a <= 0.0) { return vec4f(0.0); }
  return clamp(p.c / p.a, vec4f(0.0), vec4f(1.0));
}
fn op_over(d: Px, s: Px, mode: u32, k: f32) -> Px {
  let as_ = s.a * k;
  if (as_ <= 0.0) { return d; }
  let cs = unpremult(s);
  let B = blend_colour(mode, unpremult(d), cs);
  return Px(as_ * (1.0 - d.a) * cs + as_ * d.a * B + (1.0 - as_) * d.c, as_ + d.a * (1.0 - as_));
}
fn op_atop(d: Px, s: Px, mode: u32, k: f32) -> Px {
  let as_ = s.a * k;
  if (as_ <= 0.0 || d.a <= 0.0) { return d; }
  let B = blend_colour(mode, unpremult(d), unpremult(s));
  return Px(as_ * d.a * B + (1.0 - as_) * d.c, d.a);
}
fn op_lerp(d: Px, s: Px, k: f32) -> Px {
  return Px(d.c + (s.c - d.c) * k, d.a + (s.a - d.a) * k);
}
fn op_knock(d: Px, s: Px, kb: Px, mode: u32, k: f32) -> Px {
  let shape = s.a;
  if (shape <= 0.0) { return d; }
  let solid = Px(unpremult(s), 1.0);
  return op_lerp(d, op_over(kb, solid, mode, k), shape);
}
fn op_tint(d: Px, s: Px, mode: u32, k: f32) -> Px {
  if (d.a <= 0.0 || k <= 0.0) { return d; }
  let B = blend_colour(mode, unpremult(d), unpremult(s));
  return Px(d.c + (d.a * B - d.c) * k, d.a);
}
fn dissolve_threshold(x: u32, y: u32, seed: u32) -> f32 {
  var v = (x * 0x9e3779b1u) ^ (y * 0x85ebca77u) ^ (seed * 0xc2b2ae3du);
  v = v * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return f32(((w >> 22u) ^ w) >> 8u) / 16777216.0;
}
`

/**
 * A live stroke laid onto a layer texel as it's read: ref/paint.ts
 * `applyStroke`. Stroke tiles share the layer's tile grid, and `swin` says
 * which stroke tile (if any) each window tile has.
 */
function strokeWgsl(mode: ColourMode): string {
  const n = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  const reads = ['x', 'y', 'z', 'w']
    .slice(0, n)
    .map((l, i) => `c.${l} = stroke[o + co + ${i}u];`)
    .join(' ')
  return `
@group(0) @binding(8) var<storage, read> swin: array<i32>;
@group(0) @binding(9) var<storage, read> stroke: array<f32>;
// The selection's coverage per stroke tile, when the stroke is confined to one (stroke.w bit 0).
@group(0) @binding(11) var<storage, read> strokesel: array<f32>;

// stroke: stride, blend mode, kind (0 paint, 1 erase, 2 replace), then the selection bit and the colour's offset (<< 8).
fn with_stroke(p: Px, ix: i32, iy: i32, slot: i32) -> Px {
  if (slot < 0) { return p; }
  let px = u32(slot) * 65536u + u32(iy & 255) * 256u + u32(ix & 255);
  let o = px * P.stroke.x;
  let co = P.stroke.w >> 8u;
  var a = stroke[o];
  if ((P.stroke.w & 1u) == 1u) { a = a * strokesel[px]; }
  if (a <= 0.0) { return p; }
  if (P.stroke.z == 1u) { return Px(p.c * (1.0 - a), p.a * (1.0 - a)); }
  var c = P.stroke_colour;
  if (P.stroke.x > co) { ${reads} }
  if (P.stroke.z == 2u) {
    // Smudge and the Mixer Brush: towards the stroke's own pixel (premultiplied, its alpha after the colour).
    let ta = stroke[o + co + ${n}u];
    return Px(p.c + (c - p.c) * a, p.a + (ta - p.a) * a);
  }
  return op_over(p, Px(c * a, a), P.stroke.y, 1.0);
}
`
}

/** Reading a pixel layer from the atlas: the window table, uniform tiles, the filters. */
export { strokeWgsl }

/** `texelFn` is what sample_source reads through: `texel`, or a variant that clips or wraps first. */
export function pixelSourceWgsl(mode: ColourMode, depth: Depth, stroke: boolean, texelFn = 'texel'): string {
  const tex = depth === 16 ? 'texture_2d_array<u32>' : 'texture_2d_array<f32>'
  const norm = depth === 16 ? '(vec4f(textureLoad(atlas_a, l, e, 0)) / 65535.0)' : 'textureLoad(atlas_a, l, e, 0)'
  const normB = depth === 16 ? '(f32(textureLoad(atlas_b, l, e, 0).x) / 65535.0)' : 'textureLoad(atlas_b, l, e, 0).x'
  const straight =
    mode === 'rgb'
      ? `let t = ${norm}; c = t.xyz; a = t.w;`
      : mode === 'gray'
        ? `let t = ${norm}; c = vec4f(t.x, 0.0, 0.0, 0.0); a = t.y;`
        : `c = ${norm}; a = ${normB};`
  const cDecl = mode === 'rgb' ? 'var c: vec3f;' : 'var c: vec4f;'
  const toWorking = mode === 'rgb' ? 'vec4f(c, 0.0)' : mode === 'cmyk' ? '(vec4f(1.0) - c)' : 'c'
  return `
@group(0) @binding(4) var atlas_a: ${tex};
${mode === 'cmyk' ? `@group(0) @binding(5) var atlas_b: ${tex};` : ''}
@group(0) @binding(6) var<storage, read> win: array<i32>;
@group(0) @binding(7) var<storage, read> uniforms: array<vec4f>;

// (ix, iy) are relative to the window's first tile already: the CPU's
// mapping subtracts it, so the floats stay small.
fn texel(ix: i32, iy: i32) -> Px {
  let tx = ix >> 8u;
  let ty = iy >> 8u;
  if (tx < 0 || ty < 0 || tx >= P.win.z || ty >= P.win.w) { return Px(vec4f(0.0), 0.0); }
  let e = win[ty * P.win.z + tx];
  ${stroke ? 'let slot = swin[ty * P.win.z + tx];' : ''}
  if (e == -1) { return ${stroke ? 'with_stroke(Px(vec4f(0.0), 0.0), ix, iy, slot)' : 'Px(vec4f(0.0), 0.0)'}; }
  ${cDecl}
  var a: f32;
  if (e <= -2) {
    let u = u32(-2 - e);
    let uc = uniforms[u * 2u];
    c = ${mode === 'rgb' ? 'uc.xyz' : 'uc'};
    a = uniforms[u * 2u + 1u].x;
  } else {
    let l = vec2i(ix & 255, iy & 255);
    ${straight}
  }
  let w = ${toWorking};
  return ${stroke ? 'with_stroke(Px(w * a, a), ix, iy, slot)' : 'Px(w * a, a)'};
}

const PI: f32 = 3.14159265358979;
fn sinc(x: f32) -> f32 {
  if (x == 0.0) { return 1.0; }
  return sin(PI * x) / (PI * x);
}
fn kernel(f: u32, x: f32) -> f32 {
  let t = abs(x);
  if (f == 1u) { return max(0.0, 1.0 - t); }
  if (f == 2u) {
    if (t <= 1.0) { return 1.5 * t * t * t - 2.5 * t * t + 1.0; }
    if (t < 2.0) { return -0.5 * t * t * t + 2.5 * t * t - 4.0 * t + 2.0; }
    return 0.0;
  }
  if (t < 3.0) { return sinc(x) * sinc(x / 3.0); }
  return 0.0;
}

fn sample_source(p: vec2f) -> Px {
  if (P.resample == 0u) { return ${texelFn}(i32(floor(p.x)), i32(floor(p.y))); }
  let lo = select(select(2, 1, P.resample == 2u), 0, P.resample == 1u);
  let n = 2 * lo + 2;
  let t = p - 0.5;
  let i = floor(t);
  let f = t - i;
  var wx: array<f32, 6>;
  var wy: array<f32, 6>;
  var sx = 0.0;
  var sy = 0.0;
  for (var j = 0; j < n; j++) {
    wx[j] = kernel(P.resample, f.x - f32(j - lo));
    wy[j] = kernel(P.resample, f.y - f32(j - lo));
    sx += wx[j];
    sy += wy[j];
  }
  var c = vec4f(0.0);
  var a = 0.0;
  let x0 = i32(i.x) - lo;
  let y0 = i32(i.y) - lo;
  for (var y = 0; y < n; y++) {
    for (var x = 0; x < n; x++) {
      let w = (wx[x] / sx) * (wy[y] / sy);
      let q = ${texelFn}(x0 + x, y0 + y);
      c += q.c * w;
      a += q.a * w;
    }
  }
  a = clamp(a, 0.0, 1.0);
  return Px(clamp(c, vec4f(0.0), vec4f(a)), a);
}
`
}

export function compositeWgsl(v: CompositeVariant): string {
  const src =
    v.source === 'pixel'
      ? `${v.stroke ? strokeWgsl(v.mode) : ''}${pixelSourceWgsl(v.mode, v.depth, !!v.stroke, 'clipped_texel')}
// A copy of a tiled document's layer reads only the layer's pixels inside P.clip (where they were made).
fn clipped_texel(ix: i32, iy: i32) -> Px {
  if (P.clip.z > P.clip.x && (f32(ix) < P.clip.x || f32(iy) < P.clip.y || f32(ix) >= P.clip.z || f32(iy) >= P.clip.w)) { return Px(vec4f(0.0), 0.0); }
  return texel(ix, iy);
}
fn source(g: vec2u, i: u32) -> Px {
  let o = vec2f(g) + 0.5;
  let p = vec2f(P.m0.x * o.x + P.m0.z * o.y + P.m1.x, P.m0.y * o.x + P.m0.w * o.y + P.m1.y);
  return sample_source(p);
}`
      : `@group(0) @binding(4) var<storage, read> src: array<T>;
${bufferAccess(v, 'src', false)}
fn source(g: vec2u, i: u32) -> Px { return load_src(i); }`

  return `${preamble(v)}
struct Params {
  m0: vec4f,
  m1: vec4f,
  op: u32,
  blend: u32,
  resample: u32,
  flags: u32,
  k: f32,
  seed: u32,
  origin: vec2i,
  win: vec4i,
  // A live stroke: stride, blend mode, eraser, in use.
  stroke: vec4u,
  stroke_colour: vec4f,
  // Source pixels outside this rectangle read as nothing, when it isn't empty: a copy of a tiled document's layer.
  clip: vec4f,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> dst: array<T>;
@group(0) @binding(2) var<storage, read> kb: array<T>;
@group(0) @binding(3) var<storage, read> mask: array<f32>;

${bufferAccess(v, 'dst', true)}
${bufferAccess(v, 'kb', false)}
${blendWgsl(v.mode)}
${OPS_WGSL}
${src}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let i = g.y * TILE + g.x;
  var s = source(g.xy, i);
  var k = P.k;
  if ((P.flags & ${FLAG_MASK}u) != 0u) { k = k * mask[i]; }
  var mode = P.blend;
  if ((P.flags & ${FLAG_DISSOLVE}u) != 0u) {
    let t = dissolve_threshold(u32(P.origin.x + i32(g.x)), u32(P.origin.y + i32(g.y)), P.seed);
    if (s.a > 0.0 && t < s.a * k) {
      s = Px(s.c / s.a, 1.0);
      k = 1.0;
    } else {
      s = Px(vec4f(0.0), 0.0);
      k = 0.0;
    }
    mode = ${blendIndex('normal')}u;
  }
  let d = load_dst(i);
  var r: Px;
  switch P.op {
    case 0u: { r = op_over(d, s, mode, k); }
    case 1u: { r = op_atop(d, s, mode, k); }
    case 2u: { r = op_lerp(d, s, k); }
    case 4u: { r = op_tint(d, s, mode, k); }
    default: { r = op_knock(d, s, load_kb(i), mode, k); }
  }
  store_dst(i, r);
}
${v.source === 'pixel' && v.stroke ? bakeWgsl(v.mode, v.depth) : ''}`
}

/**
 * Baking a stroke into a tile: the layer's texel with the stroke laid on,
 * back in the document's own terms (straight, CMYK as ink) and quantised to
 * its depth, one plane after another, as the tile store keeps tiles.
 */
function bakeWgsl(mode: ColourMode, depth: Depth): string {
  const n = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  const max = depth === 16 ? '65535.0' : '255.0'
  const lanes = ['x', 'y', 'z', 'w'].slice(0, n)
  const writes = lanes
    .map((l, i) => `bake_out[${i}u * 65536u + i] = u32(round(clamp(${mode === 'cmyk' ? `1.0 - s.${l}` : `s.${l}`}, 0.0, 1.0) * ${max}));`)
    .join('\n  ')
  return `
@group(0) @binding(10) var<storage, read_write> bake_out: array<u32>;

@compute @workgroup_size(16, 16)
fn bake(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let i = g.y * TILE + g.x;
  let p = texel(i32(g.x), i32(g.y));
  let a = clamp(p.a, 0.0, 1.0);
  let s = select(vec4f(0.0), clamp(p.c / p.a, vec4f(0.0), vec4f(1.0)), p.a > 0.0);
  ${writes}
  bake_out[${n}u * 65536u + i] = u32(round(a * ${max}));
}
`
}
