/**
 * The overlay's lines and handles (render/overlay.ts): triangles in device
 * pixels, pulled from a storage buffer by vertex index, drawn over the
 * canvas in the screen pass. Marching ants dash black and white along the
 * line's length and crawl with time.
 */
/** The canvas's size and the ants' time; then the guides', smart guides' and grid's colours. */
export const OVERLAY_PARAMS_BYTES = 64

export const overlayWgsl = `
struct Params {
  size: vec2f,
  time: f32,
  _pad: f32,
  guide: vec4f,
  smart: vec4f,
  grid: vec4f,
}
@group(0) @binding(0) var<uniform> U: Params;
@group(0) @binding(1) var<storage, read> verts: array<vec4f>;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) dist: f32,
  @location(1) @interpolate(flat) ink: u32,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
  let v = verts[i];
  let clip = vec2f(v.x / U.size.x * 2.0 - 1.0, 1.0 - v.y / U.size.y * 2.0);
  return V(vec4f(clip, 0.0, 1.0), v.z, u32(v.w));
}

@fragment
fn fs(in: V) -> @location(0) vec4f {
  if (in.ink == 1u) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (in.ink == 2u) { return vec4f(1.0, 1.0, 1.0, 1.0); }
  // The accent: paths, their anchors and handles, as Illustrator draws them.
  if (in.ink == 3u) { return vec4f(0.10, 0.52, 1.0, 1.0); }
  // A text selection: the accent, see-through.
  if (in.ink == 4u) { return vec4f(0.10, 0.52, 1.0, 0.32); }
  // Guides, smart guides and the grid, in the colours chosen for them; the grid's finer lines fainter.
  if (in.ink == 5u) { return U.guide; }
  if (in.ink == 6u) { return U.smart; }
  if (in.ink == 7u) { return vec4f(U.grid.rgb, U.grid.a * 0.75); }
  if (in.ink == 8u) { return vec4f(U.grid.rgb, U.grid.a * 0.35); }
  // The pixel grid: a faint gray that shows on light and dark alike.
  if (in.ink == 9u) { return vec4f(0.5, 0.5, 0.5, 0.28); }
  let on = (u32(floor((in.dist + U.time) / 4.0)) & 1u) == 0u;
  return select(vec4f(1.0, 1.0, 1.0, 1.0), vec4f(0.0, 0.0, 0.0, 1.0), on);
}
`
