/**
 * Geometric effects on the GPU (filters/defs.ts warpRegion is the
 * reference): each pixel of a tile read from where a warp says, out of a
 * region of the node's content gathered round where the tile reads from.
 *
 * Where to read is a grid over the tile, `G` cells a side, each point
 * homogeneous (X, Y, W) relative to the region's corner, worked out on the
 * CPU in doubles; a pixel interpolates its cell's four and divides, which
 * is exact for a perspective and close for a smooth warp. The region may be
 * at a coarser level than the tile (`k` = 2^(tile level − region level)),
 * so a warp that squeezes reads a mip of its content, not every pixel.
 * Results are laid over what `b` holds, so a tiled document's copies add up.
 */
import type { ColourMode } from '../../doc/types'
import { strideOf } from './common'

/** WarpParams: two vec4s. */
export const WARP_PARAMS_BYTES = 32

export interface WarpParams {
  /** The region's side. */
  size: number
  /** Grid cells a side. */
  cells: number
  /** Region pixels per tile pixel. */
  k: number
  /** How far apart a cell's corners may read (region pixels) before it's a seam, read nearest; 0 for never. */
  seam?: number
}

export function writeWarpParams(out: ArrayBuffer, p: WarpParams) {
  const u = new Uint32Array(out)
  const f = new Float32Array(out)
  u.set([p.size, p.cells, 0, 0], 0)
  f.set([p.k, 256 / p.cells, p.seam ?? 0, 0], 4)
}

export function warpWgsl(mode: ColourMode): string {
  const S = strideOf(mode)
  return `
struct WP {
  u: vec4u,
  f: vec4f,
}
@group(0) @binding(0) var<uniform> P: WP;
@group(0) @binding(1) var<storage, read> grid: array<vec4f>;
@group(0) @binding(2) var<storage, read> a: array<f32>;
@group(0) @binding(3) var<storage, read_write> b: array<f32>;

const RS: u32 = ${S}u;
const TILE: u32 = 256u;

fn texel(x: i32, y: i32, c: u32) -> f32 {
  let size = i32(P.u.x);
  if (x < 0 || y < 0 || x >= size || y >= size) { return 0.0; }
  return a[u32(y * size + x) * RS + c];
}

@compute @workgroup_size(16, 16)
fn warp(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let G = P.u.y;
  let n = G + 1u;
  let q = (vec2f(g.xy) + 0.5) / P.f.y;
  let i = min(u32(floor(q.x)), G - 1u);
  let j = min(u32(floor(q.y)), G - 1u);
  let fr = q - vec2f(f32(i), f32(j));
  let h00 = grid[j * n + i];
  let h10 = grid[j * n + i + 1u];
  let h01 = grid[(j + 1u) * n + i];
  let h11 = grid[(j + 1u) * n + i + 1u];
  // A corner with nothing to read (past a perspective's horizon): nothing drawn.
  if (min(min(h00.w, h10.w), min(h01.w, h11.w)) < 0.5) { return; }
  var h = mix(mix(h00, h10, fr.x), mix(h01, h11, fr.x), fr.y);
  if (P.f.z > 0.0) {
    // A seam: corners reading far apart are read as the nearest one alone.
    let q0 = h00.xy / h00.z;
    let q1 = h10.xy / h10.z;
    let q2 = h01.xy / h01.z;
    let q3 = h11.xy / h11.z;
    let spread = max(max(distance(q0, q1), distance(q0, q2)), max(distance(q3, q1), distance(q3, q2))) * P.f.x;
    if (spread > P.f.z) { h = select(select(h00, h10, fr.x >= 0.5), select(h01, h11, fr.x >= 0.5), fr.y >= 0.5); }
  }
  if (h.z <= 1e-12) { return; }
  // Bilinear about pixel centres.
  let p = h.xy / h.z * P.f.x - 0.5;
  let p0 = floor(p);
  let f = p - p0;
  let x0 = i32(p0.x);
  let y0 = i32(p0.y);
  let o = (g.y * TILE + g.x) * RS;
  var v: array<f32, ${S}>;
  for (var c = 0u; c < RS; c++) {
    v[c] = mix(mix(texel(x0, y0, c), texel(x0 + 1, y0, c), f.x), mix(texel(x0, y0 + 1, c), texel(x0 + 1, y0 + 1, c), f.x), f.y);
  }
  let al = v[RS - 1u];
  for (var c = 0u; c < RS; c++) { b[o + c] = v[c] + b[o + c] * (1.0 - al); }
}
`
}
