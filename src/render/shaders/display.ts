/**
 * From a composite tile to what the screen shows: each pixel back to the
 * document's own values, through the display lookup table (color/lut.ts),
 * and out as display colour.
 *
 * The table lives in a storage buffer laid out exactly as `Lut.data`, and
 * is read with the same tetrahedral interpolation as `sampleLut`, by hand.
 * A 3D texture's filtering would be trilinear, which is a different (and
 * worse) answer, so a texture buys nothing here; check-gpu holds this to
 * `sampleLut`.
 *
 * On top of the table, the document's look (color/lut.ts, `displayRef`):
 * channels hidden (CMYK inks for separations, any colour channel from the
 * Channels panel), one channel alone in gray, colours the proof condition can't
 * reproduce marked (the table's A, past half), and CMYK pixels over the
 * ink limit marked.
 *
 * Two outputs: `to_tile` writes premultiplied display colour into a layer
 * of the display atlas, which the screen pass draws from; `to_bytes` writes
 * straight 8-bit RGBA, for thumbnails and previews.
 */
import type { ColourMode } from '../../doc/types'
import type { Look, Lut } from '../../color/lut'
import { bufferAccess, preamble, type BufferFormat } from './common'

/** LutParams: dims, size, kSlices, flags (1 gamut, 2 ink limit, 4 one channel in gray, its index << 8); the channels shown; the gamut alarm (w: the ink limit); the ink alarm. */
export const LUT_PARAMS_BYTES = 64

export function writeLutParams(lut: Lut, look: Look): ArrayBuffer {
  const out = new ArrayBuffer(LUT_PARAMS_BYTES)
  const u = new Uint32Array(out)
  const f = new Float32Array(out)
  u.set([lut.dims, lut.size, lut.kSlices, (look.gamut ? 1 : 0) | (look.inkLimit > 0 && lut.input === 'cmyk' ? 2 : 0) | (look.gray >= 0 ? 4 | (look.gray << 8) : 0)], 0)
  f.set(look.inks.map((x) => (x ? 1 : 0)), 4)
  f.set([...look.alarm, look.inkLimit], 8)
  f.set([...look.inkAlarm, 0], 12)
  return out
}

export function displayWgsl(f: BufferFormat): string {
  // The document's own values from a pixel: RGB and Gray light, CMYK ink.
  const doc: Record<ColourMode, string> = {
    rgb: 'return vec4f(unpremult(p).xyz, 0.0);',
    gray: 'return vec4f(unpremult(p).x, 0.0, 0.0, 0.0);',
    cmyk: 'return vec4f(1.0) - unpremult(p);',
  }
  const lookup: Record<ColourMode, string> = {
    rgb: 'tetra(0u, v.xyz * D.inks.xyz)',
    gray: 'gray(v.x)',
    cmyk: 'cmyk(v * D.inks)',
  }
  return `${preamble(f)}
struct LutParams {
  dims: u32,
  size: u32,
  k_slices: u32,
  flags: u32,
  inks: vec4f,
  alarm: vec4f,
  ink_alarm: vec4f,
}

@group(0) @binding(0) var<uniform> D: LutParams;
@group(0) @binding(1) var<storage, read> src: array<T>;
@group(0) @binding(2) var<storage, read> lut: array<vec4f>;
@group(0) @binding(3) var out_tile: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<storage, read_write> out_bytes: array<u32>;

${bufferAccess(f, 'src', false)}

fn unpremult(p: Px) -> vec4f {
  if (p.a <= 0.0) { return vec4f(0.0); }
  return clamp(p.c / p.a, vec4f(0.0), vec4f(1.0));
}

fn at(base: u32, i: u32, j: u32, k: u32) -> vec4f {
  return lut[base + (k * D.size + j) * D.size + i];
}

fn tetra(base: u32, p: vec3f) -> vec4f {
  let s1 = f32(D.size - 1u);
  let f = clamp(p, vec3f(0.0), vec3f(1.0)) * s1;
  let i0 = min(floor(f), vec3f(s1 - 1.0));
  let r = f - i0;
  let x0 = u32(i0.x);
  let y0 = u32(i0.y);
  let z0 = u32(i0.z);
  let c000 = at(base, x0, y0, z0);
  let c111 = at(base, x0 + 1u, y0 + 1u, z0 + 1u);
  if (r.x >= r.y) {
    if (r.y >= r.z) {
      let c100 = at(base, x0 + 1u, y0, z0);
      let c110 = at(base, x0 + 1u, y0 + 1u, z0);
      return c000 + r.x * (c100 - c000) + r.y * (c110 - c100) + r.z * (c111 - c110);
    }
    if (r.x >= r.z) {
      let c100 = at(base, x0 + 1u, y0, z0);
      let c101 = at(base, x0 + 1u, y0, z0 + 1u);
      return c000 + r.x * (c100 - c000) + r.z * (c101 - c100) + r.y * (c111 - c101);
    }
    let c001 = at(base, x0, y0, z0 + 1u);
    let c101 = at(base, x0 + 1u, y0, z0 + 1u);
    return c000 + r.z * (c001 - c000) + r.x * (c101 - c001) + r.y * (c111 - c101);
  }
  if (r.z >= r.y) {
    let c001 = at(base, x0, y0, z0 + 1u);
    let c011 = at(base, x0, y0 + 1u, z0 + 1u);
    return c000 + r.z * (c001 - c000) + r.y * (c011 - c001) + r.x * (c111 - c011);
  }
  if (r.z >= r.x) {
    let c010 = at(base, x0, y0 + 1u, z0);
    let c011 = at(base, x0, y0 + 1u, z0 + 1u);
    return c000 + r.y * (c010 - c000) + r.z * (c011 - c010) + r.x * (c111 - c011);
  }
  let c010 = at(base, x0, y0 + 1u, z0);
  let c110 = at(base, x0 + 1u, y0 + 1u, z0);
  return c000 + r.y * (c010 - c000) + r.x * (c110 - c010) + r.z * (c111 - c110);
}

fn gray(g: f32) -> vec4f {
  let f = clamp(g, 0.0, 1.0) * f32(D.size - 1u);
  let i = min(u32(floor(f)), D.size - 2u);
  let r = f - f32(i);
  return lut[i] * (1.0 - r) + lut[i + 1u] * r;
}

fn cmyk(v: vec4f) -> vec4f {
  let slice = D.size * D.size * D.size;
  let fk = clamp(v.w, 0.0, 1.0) * f32(D.k_slices - 1u);
  let k0 = min(u32(floor(fk)), D.k_slices - 2u);
  let rk = fk - f32(k0);
  let a = tetra(k0 * slice, v.xyz);
  let b = tetra((k0 + 1u) * slice, v.xyz);
  return a * (1.0 - rk) + b * rk;
}

fn values(p: Px) -> vec4f {
  ${doc[f.mode]}
}

// The look on a document colour: color/lut.ts displayRef.
fn look(v: vec4f) -> vec3f {
  if ((D.flags & 4u) != 0u) {
    let g = clamp(${f.mode === 'cmyk' ? '1.0 - v[D.flags >> 8u]' : 'v[D.flags >> 8u]'}, 0.0, 1.0);
    return vec3f(g);
  }
  let t = ${lookup[f.mode]};
  var out = t.xyz;
  if ((D.flags & 1u) != 0u && t.w <= 0.5) { out = D.alarm.xyz; }
  if ((D.flags & 2u) != 0u && v.x + v.y + v.z + v.w > D.alarm.w) { out = D.ink_alarm.xyz; }
  return out;
}

fn display(p: Px) -> vec3f {
  return look(values(p));
}

@compute @workgroup_size(16, 16)
fn to_tile(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let p = load_src(g.y * TILE + g.x);
  let a = clamp(p.a, 0.0, 1.0);
  let rgb = select(vec3f(0.0), display(p), a > 0.0);
  textureStore(out_tile, vec2i(g.xy), vec4f(rgb * a, a));
}

@compute @workgroup_size(16, 16)
fn to_bytes(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= TILE || g.y >= TILE) { return; }
  let i = g.y * TILE + g.x;
  let p = load_src(i);
  let a = clamp(p.a, 0.0, 1.0);
  let rgb = select(vec3f(0.0), display(p), a > 0.0);
  out_bytes[i] = pack4x8unorm(vec4f(rgb, a));
}

// For check-gpu: the table sampled at given document colours, straight.
@group(1) @binding(0) var<storage, read> probe_in: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> probe_out: array<vec4f>;

@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&probe_in)) { return; }
  let v = probe_in[g.x];
  ${f.mode === 'rgb' ? 'probe_out[g.x] = vec4f(tetra(0u, v.xyz).xyz, 1.0);' : f.mode === 'gray' ? 'probe_out[g.x] = vec4f(gray(v.x).xyz, 1.0);' : 'probe_out[g.x] = vec4f(cmyk(v).xyz, 1.0);'}
}

// For check-gpu: the whole look at given document colours.
@compute @workgroup_size(64)
fn probe_look(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= arrayLength(&probe_in)) { return; }
  probe_out[g.x] = vec4f(look(probe_in[g.x]), 1.0);
}
`
}
