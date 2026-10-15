/**
 * A tile's planar samples, as the tile store holds them, into its atlas
 * layer: a render pass whose target is the layer, reading the samples
 * from a storage buffer they were written to unchanged. Packing pixels on
 * the GPU rather than interleaving them on the CPU first is most of what an
 * upload used to cost (a 96 MP document's first picture uploads every
 * tile).
 *
 * The planes are back to back, each TILE_PIXELS samples, alpha last: RGB as
 * RGBA, Gray as gray and alpha in the first two lanes, CMYK as CMYK plus a
 * second target for alpha (atlas.ts, tileFormats). 8-bit samples are four
 * to a word, 16-bit two; 8-bit values divided by 255 come back exactly
 * from the unorm target.
 */
import type { ColourMode, Depth } from '../../doc/types'
import { TILE, TILE_PIXELS } from '../../tiles/format'

export function uploadWgsl(mode: ColourMode, depth: Depth): string {
  const per = depth === 16 ? 2 : 4
  const bits = depth === 16 ? 16 : 8
  const mask = depth === 16 ? '0xffffu' : '0xffu'
  const outT = depth === 16 ? 'vec4u' : 'vec4f'
  // One sample as the target wants it: a number for 16-bit (uint targets), 0..1 for 8-bit (unorm).
  const s = (c: number) => (depth === 16 ? `sample(${c}u, i)` : `(f32(sample(${c}u, i)) / 255.0)`)
  const zero = depth === 16 ? '0u' : '0.0'
  const a =
    mode === 'rgb' ? `${outT}(${s(0)}, ${s(1)}, ${s(2)}, ${s(3)})` : mode === 'gray' ? `${outT}(${s(0)}, ${s(1)}, ${zero}, ${zero})` : `${outT}(${s(0)}, ${s(1)}, ${s(2)}, ${s(3)})`
  return `
@group(0) @binding(0) var<storage, read> data: array<u32>;

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

fn sample(plane: u32, i: u32) -> u32 {
  let k = plane * ${TILE_PIXELS}u + i;
  return (data[k / ${per}u] >> ((k % ${per}u) * ${bits}u)) & ${mask};
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> Out {
  let p = vec2u(floor(pos.xy));
  let i = p.y * ${TILE}u + p.x;
  var out: Out;
  out.a = ${a};
  ${mode === 'cmyk' ? `out.b = ${outT}(${s(4)}, ${zero}, ${zero}, ${zero});` : ''}
  return out;
}
`
}
