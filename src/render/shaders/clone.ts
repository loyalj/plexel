/**
 * The Clone Stamp on the GPU (and the Healing Brush while it's painted):
 * each pixel of a dab's box gets the brush tip's coverage, as any dab does,
 * and the colour of the source at the same place moved by the source's
 * offset, read at full resolution: from the layer as the stroke found it
 * (through the atlas window, as the compositor reads it), or with Sample
 * All Layers from the document as it shows (its composite tiles rendered
 * for the frame into one buffer). In a tiled document the reads wrap
 * round the canvas's edges.
 *
 * The stroke keeps what a sampling stroke keeps (Smudge's and the Mixer's):
 * how far the layer goes towards a paint, and the paint. Coverage builds up
 * to the brush's opacity, as a painted stroke's does, and a later dab's
 * paint replaces an earlier one's by as much as it adds.
 */
import type { ColourMode, Depth } from '../../doc/types'
import { pixelSourceWgsl } from './composite'
import { bufferAccess, preamble, type BufferFormat } from './common'
import { brushWgsl } from './paint'

/** CloneParams: see the struct. */
export const CLONE_PARAMS_BYTES = 208

export interface CloneParams {
  /** Layer offset into tip space. */
  a: number[]
  centre: [number, number]
  aa: number
  hardness: number
  /** The box's first pixel (layer pixels) and its size. */
  box: [number, number, number, number]
  /** The first stroke tile the box reaches, and how many across and down. */
  tiles: [number, number, number, number]
  flow: number
  tip: number
  opacity: number
  noise: boolean
  wetEdges: boolean
  grain: number
  /** Layer to document, and the document's size: paint stops at the canvas's edge. */
  t: number[]
  width: number
  height: number
  /** A layer pixel to the source's pixel, relative to the source window's first pixel. */
  src: number[]
  /** The source window: its first tile and its size in tiles. */
  win: [number, number, number, number]
  /** Where reads wrap: the period across and down (0 for none), and the canvas's corner relative to the window. */
  wrap: [number, number, number, number]
}

export function writeCloneParams(out: ArrayBuffer, p: CloneParams) {
  const f = new Float32Array(out)
  const i = new Int32Array(out)
  const u = new Uint32Array(out)
  f.set(p.a, 0)
  f.set([p.centre[0], p.centre[1], p.aa, p.hardness], 4)
  i.set(p.box, 8)
  i.set(p.tiles, 12)
  f.set([p.flow, p.tip, p.opacity, 0], 16)
  u.set([p.noise ? 1 : 0, p.wetEdges ? 1 : 0, p.grain >>> 0, 0], 20)
  f.set([p.t[0], p.t[1], p.t[2], p.t[3]], 24)
  f.set([p.t[4], p.t[5], p.width, p.height], 28)
  f.set([p.src[0], p.src[1], p.src[2], p.src[3]], 32)
  f.set([p.src[4], p.src[5], 0, 0], 36)
  i.set(p.win, 40)
  i.set(p.wrap, 44)
  // The pixel source's filter field: the kernel reads bilinearly itself.
  u[48] = 0
}

const PARAMS = `
struct Params {
  a: vec4f,
  c: vec4f,
  box: vec4i,
  tiles: vec4i,
  o: vec4f,
  flags: vec4u,
  t: vec4f,
  t2: vec4f,
  s0: vec4f,
  s1: vec4f,
  win: vec4i,
  wrap: vec4i,
  resample: u32,
  _r1: u32,
  _r2: u32,
  _r3: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> stroke: array<f32>;
@group(0) @binding(2) var<storage, read> tips: array<f32>;
@group(0) @binding(3) var<storage, read> tiptable: array<u32>;
@group(0) @binding(8) var<storage, read> slots: array<i32>;
`

/** The kernel: `layer` reads the layer through the atlas, `composite` the document's composite window. */
export function cloneWgsl(mode: ColourMode, depth: Depth, source: 'layer' | 'composite', comp: BufferFormat): string {
  const n = mode === 'rgb' ? 3 : mode === 'gray' ? 1 : 4
  const read =
    source === 'layer'
      ? `${pixelSourceWgsl(mode, depth, false)}
fn wrap_axis(i: i32, size: i32, corner: i32) -> i32 {
  if (size <= 0) { return i; }
  return corner + (((i - corner) % size) + size) % size;
}
fn src_px(ix: i32, iy: i32) -> Px { return texel(wrap_axis(ix, P.wrap.x, P.wrap.z), wrap_axis(iy, P.wrap.y, P.wrap.w)); }`
      : `@group(0) @binding(9) var<storage, read> comp: array<CT>;
${bufferAccess(comp, 'comp', false).replace(/\bT\b/g, 'CT')}
fn src_px(jx: i32, jy: i32) -> Px {
  var x = jx;
  var y = jy;
  if (P.wrap.x > 0) { x = (((x + P.wrap.z) % P.wrap.x) + P.wrap.x) % P.wrap.x - P.wrap.z; }
  if (P.wrap.y > 0) { y = (((y + P.wrap.w) % P.wrap.y) + P.wrap.y) % P.wrap.y - P.wrap.w; }
  if (x < 0 || y < 0) { return Px(vec4f(0.0), 0.0); }
  let tx = u32(x) >> 8u;
  let ty = u32(y) >> 8u;
  if (tx >= u32(P.win.z) || ty >= u32(P.win.w)) { return Px(vec4f(0.0), 0.0); }
  return load_comp((ty * u32(P.win.z) + tx) * 65536u + (u32(y) & 255u) * 256u + (u32(x) & 255u));
}`
  return `${preamble({ mode, store: 'f32' })}
${source === 'composite' ? `alias CT = ${comp.store};` : ''}
${PARAMS}
${read}
${brushWgsl}

const N: u32 = ${n}u;

// The source at a point, bilinearly about pixel centres: whole-pixel offsets read pixels exactly.
fn source_at(p: vec2f) -> Px {
  let f = p - 0.5;
  let i0 = vec2i(floor(f));
  let t = f - floor(f);
  let a = src_px(i0.x, i0.y);
  let b = src_px(i0.x + 1, i0.y);
  let c = src_px(i0.x, i0.y + 1);
  let d = src_px(i0.x + 1, i0.y + 1);
  return Px(mix(mix(a.c, b.c, t.x), mix(c.c, d.c, t.x), t.y), mix(mix(a.a, b.a, t.x), mix(c.a, d.a, t.x), t.y));
}

@compute @workgroup_size(16, 16)
fn clone(@builtin(global_invocation_id) g: vec3u) {
  if (i32(g.x) >= P.box.z || i32(g.y) >= P.box.w) { return; }
  let ip = vec2i(P.box.x + i32(g.x), P.box.y + i32(g.y));
  let p = vec2f(ip) + 0.5;
  let doc = vec2f(P.t.x * p.x + P.t.z * p.y + P.t2.x, P.t.y * p.x + P.t.w * p.y + P.t2.y);
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= P.t2.z || doc.y >= P.t2.w) { return; }
  let o = p - P.c.xy;
  let u = vec2f(P.a.x * o.x + P.a.y * o.y, P.a.z * o.x + P.a.w * o.y);
  let m = dab_mask(u, P.o.y, P.c.w, P.c.z, P.flags.x == 1u, P.flags.y == 1u, ip, P.flags.z);
  let w = m * P.o.x;
  if (w <= 0.0) { return; }
  let tile = vec2i(ip.x >> 8u, ip.y >> 8u) - P.tiles.xy;
  if (tile.x < 0 || tile.y < 0 || tile.x >= P.tiles.z || tile.y >= P.tiles.w) { return; }
  let slot = slots[tile.y * P.tiles.z + tile.x];
  if (slot < 0) { return; }
  let px = u32(slot) * 65536u + u32(ip.y & 255) * 256u + u32(ip.x & 255);
  let b = px * (N + 2u);
  let k0 = stroke[b];
  let op = P.o.z;
  if (k0 >= op) { return; }
  // Up towards the opacity by the dab's coverage, as a brush's stroke builds; q is how far this dab replaces.
  let kk = k0 + (op - k0) * w;
  let q = select((kk - k0) / (1.0 - k0), 1.0, k0 >= 1.0);
  let sp = vec2f(P.s0.x * p.x + P.s0.z * p.y + P.s1.x, P.s0.y * p.x + P.s0.w * p.y + P.s1.y);
  let S = source_at(sp);
  for (var c = 0u; c < N; c++) { stroke[b + 1u + c] = (stroke[b + 1u + c] * k0 * (1.0 - q) + S.c[c] * q) / kk; }
  stroke[b + 1u + N] = (stroke[b + 1u + N] * k0 * (1.0 - q) + S.a * q) / kk;
  stroke[b] = kk;
}
`
}
