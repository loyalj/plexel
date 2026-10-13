/**
 * WGSL shared by the render kernels, written out per variant.
 *
 * A composite tile is a storage buffer of 256 × 256 pixels, each `S`
 * numbers: the colour channels (3 for RGB, 1 for Gray, 4 for CMYK as light)
 * premultiplied, then alpha. Buffers rather than textures because CMYK has
 * five channels, which no texture format holds, and because the blend
 * modes need to read the backdrop where they write, which a storage buffer
 * allows and a render target doesn't.
 *
 * The numbers are f32, or f16 where the device has shader-f16 and the
 * document is 8-bit (PERFORMANCE.md has the measurements behind that).
 */
import type { ColourMode } from '../../doc/types'
import { COLOUR_CHANNELS } from '../../tiles/format'

export type Store = 'f32' | 'f16'

export interface BufferFormat {
  mode: ColourMode
  store: Store
}

/** Numbers per pixel in a composite buffer. */
export const strideOf = (mode: ColourMode) => COLOUR_CHANNELS[mode] + 1

/** Bytes in one composite tile's buffer. */
export const tileBufferBytes = (f: BufferFormat) => 256 * 256 * strideOf(f.mode) * (f.store === 'f16' ? 2 : 4)

const LANES = ['x', 'y', 'z', 'w']

/** The preamble: the f16 extension if needed, the pixel type and the stride. */
export function preamble(f: BufferFormat): string {
  return `${f.store === 'f16' ? 'enable f16;\n' : ''}
alias T = ${f.store};
const NC: u32 = ${COLOUR_CHANNELS[f.mode]}u;
const S: u32 = ${strideOf(f.mode)}u;
const TILE: u32 = 256u;

struct Px {
  c: vec4f,
  a: f32,
}
`
}

/** `load_<name>(i)` and, if writable, `store_<name>(i, p)` for a buffer binding called `name`. */
export function bufferAccess(f: BufferFormat, name: string, writable: boolean): string {
  const n = COLOUR_CHANNELS[f.mode]
  const loads = LANES.slice(0, n)
    .map((l, i) => `  c.${l} = f32(${name}[o + ${i}u]);`)
    .join('\n')
  const stores = LANES.slice(0, n)
    .map((l, i) => `  ${name}[o + ${i}u] = T(p.c.${l});`)
    .join('\n')
  return `
fn load_${name}(i: u32) -> Px {
  let o = i * S;
  var c = vec4f(0.0);
${loads}
  return Px(c, f32(${name}[o + NC]));
}
${
  writable
    ? `
fn store_${name}(i: u32, p: Px) {
  let o = i * S;
${stores}
  ${name}[o + NC] = T(p.a);
}
`
    : ''
}`
}
