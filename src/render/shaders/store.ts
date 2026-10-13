/**
 * A composite tile into a tile atlas slot: how a smart object's contents
 * become something its node can be drawn from like a pixel layer's tiles.
 * A render pass whose target is the slot's layer (as the mip pass's is),
 * reading the composite buffer and writing straight values in the atlas's
 * format: CMYK back to ink, 16 bits as integers. Pixels past the contents'
 * own canvas are left transparent, so a smart object ends where its
 * document does.
 */
import type { ColourMode, Depth } from '../../doc/types'
import { bufferAccess, preamble, type BufferFormat } from './common'

/** StoreParams: how many of the tile's columns and rows are on the canvas. */
export const STORE_PARAMS_BYTES = 16

export function storeWgsl(fmt: BufferFormat, depth: Depth): string {
  const mode: ColourMode = fmt.mode
  const outT = depth === 16 ? 'vec4u' : 'vec4f'
  const q = (e: string) => (depth === 16 ? `vec4u(round(clamp(${e}, vec4f(0.0), vec4f(1.0)) * 65535.0))` : e)
  // Straight, in the tile's own terms.
  const pack = mode === 'rgb' ? 'vec4f(c.xyz, a)' : mode === 'gray' ? 'vec4f(c.x, a, 0.0, 0.0)' : 'vec4f(1.0) - c'
  return `${preamble(fmt)}
struct StoreParams { limit: vec4u }
@group(0) @binding(0) var<uniform> P: StoreParams;
@group(0) @binding(1) var<storage, read> src: array<T>;
${bufferAccess(fmt, 'src', false)}

struct Out {
  @location(0) a: ${outT},
  ${mode === 'cmyk' ? `@location(1) b: ${outT},` : ''}
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> Out {
  let o = vec2u(floor(pos.xy));
  var p = load_src(o.y * TILE + o.x);
  if (o.x >= P.limit.x || o.y >= P.limit.y) { p = Px(vec4f(0.0), 0.0); }
  let a = clamp(p.a, 0.0, 1.0);
  var c = vec4f(0.0);
  if (a > 0.0) { c = clamp(p.c / a, vec4f(0.0), vec4f(1.0)); }
  ${mode === 'cmyk' ? 'if (a <= 0.0) { c = vec4f(1.0); }' : ''}
  var out: Out;
  out.a = ${q(pack)};
  ${mode === 'cmyk' ? `out.b = ${q('vec4f(a, 0.0, 0.0, 0.0)')};` : ''}
  return out;
}
`
}
