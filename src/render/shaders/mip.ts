/**
 * One tile of a mip level from the four tiles below it: a render pass whose
 * target is the new tile's layer in the atlas, reading the four children
 * from a scratch texture (an atlas layer can't be read and written in the
 * same pass). Each output pixel is the premultiplied average of four, as
 * ref/working.ts `reduce` does it, stored straight in the atlas's format.
 *
 * A child that's missing is transparent, and a uniform child is read from
 * its value instead of a texture, so neither needs uploading.
 */
import type { ColourMode, Depth } from '../../doc/types'

/** MipParams: per child its kind (0 transparent, 1 uniform, 2 scratch layer), then each uniform child's colour and alpha. */
export const MIP_PARAMS_BYTES = 16 + 4 * 32

export function mipWgsl(mode: ColourMode, depth: Depth): string {
  const tex = depth === 16 ? 'texture_2d_array<u32>' : 'texture_2d_array<f32>'
  const n = (e: string) => (depth === 16 ? `(vec4f(${e}) / 65535.0)` : e)
  const nb = (e: string) => (depth === 16 ? `(f32(${e}.x) / 65535.0)` : `${e}.x`)
  // Straight colour (vec4, unused lanes 0) and alpha, from the scratch layers.
  const read =
    mode === 'rgb'
      ? `let t = ${n('textureLoad(scratch_a, p, layer, 0)')}; return Px(vec4f(t.xyz, 0.0), t.w);`
      : mode === 'gray'
        ? `let t = ${n('textureLoad(scratch_a, p, layer, 0)')}; return Px(vec4f(t.x, 0.0, 0.0, 0.0), t.y);`
        : `return Px(${n('textureLoad(scratch_a, p, layer, 0)')}, ${nb('textureLoad(scratch_b, p, layer, 0)')});`
  const outT = depth === 16 ? 'vec4u' : 'vec4f'
  const q = (e: string) => (depth === 16 ? `vec4u(round(clamp(${e}, vec4f(0.0), vec4f(1.0)) * 65535.0))` : e)
  const pack =
    mode === 'rgb' ? 'vec4f(c.xyz, a)' : mode === 'gray' ? 'vec4f(c.x, a, 0.0, 0.0)' : 'c'
  return `
struct Px { c: vec4f, a: f32 }
struct MipParams {
  kinds: vec4u,
  values: array<vec4f, 8>,
}
@group(0) @binding(0) var<uniform> M: MipParams;
@group(0) @binding(1) var scratch_a: ${tex};
${mode === 'cmyk' ? `@group(0) @binding(2) var scratch_b: ${tex};` : ''}

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

fn child(layer: i32, p: vec2i) -> Px {
  ${read}
}

fn texel(which: u32, p: vec2i) -> Px {
  let kind = M.kinds[which];
  if (kind == 0u) { return Px(vec4f(0.0), 0.0); }
  if (kind == 1u) { return Px(M.values[which * 2u], M.values[which * 2u + 1u].x); }
  return child(i32(which), p);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> Out {
  let o = vec2i(floor(pos.xy));
  let which = u32(o.x >= 128) + 2u * u32(o.y >= 128);
  let base = (o % vec2i(128)) * 2;
  var c = vec4f(0.0);
  var a = 0.0;
  for (var j = 0; j < 4; j++) {
    let t = texel(which, base + vec2i(j & 1, j >> 1));
    c += t.c * t.a;
    a += t.a;
  }
  if (a > 0.0) { c = c / a; } else { c = vec4f(0.0); }
  a = a / 4.0;
  var out: Out;
  out.a = ${q(pack)};
  ${mode === 'cmyk' ? `out.b = ${q('vec4f(a, 0.0, 0.0, 0.0)')};` : ''}
  return out;
}
`
}
