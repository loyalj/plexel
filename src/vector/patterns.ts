/**
 * Patterns, as a registry: each is a formula over pattern space (one cell
 * per unit) giving how much of the foreground colour shows, 0..1, filtered
 * over the pixel's footprint `w` (cells per pixel) so it stays smooth at
 * any zoom instead of shimmering. The paint kernel (render/shaders/
 * vector.ts) and Pattern Overlay (render/shaders/fx.ts) compute the same
 * sums; this is the reference they're held to.
 *
 * These are drawn, not sampled from pixels. Patterns defined from a
 * layer's pixels, as Photoshop's are, come later; a paint names its
 * pattern by id, so they slot in beside these.
 */

export interface PatternDef {
  id: string
  label: string
  /** Its index in the kernels' switch. */
  index: number
}

export const PATTERNS: PatternDef[] = [
  { id: 'checker', label: 'Checkerboard', index: 0 },
  { id: 'stripes', label: 'Stripes', index: 1 },
  { id: 'dots', label: 'Dots', index: 2 },
  { id: 'grid', label: 'Grid', index: 3 },
]

export const PATTERN_BY_ID = new Map(PATTERNS.map((p) => [p.id, p]))

const fract = (x: number) => x - Math.floor(x)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** A square wave of period 2 averaged over a footprint w: ±1 where it's sharp, towards 0 as w grows. */
function wave(x: number, w: number): number {
  if (w < 1e-4) return fract(x * 0.5) < 0.5 ? 1 : -1
  return (2 * (Math.abs(fract((x - 0.5 * w) * 0.5) - 0.5) - Math.abs(fract((x + 0.5 * w) * 0.5) - 0.5))) / w
}

/** How much of the foreground shows at (u, v) in pattern space, over a footprint w. */
export function patternValue(index: number, u: number, v: number, w: number): number {
  switch (index) {
    case 0:
      return clamp01(0.5 - 0.5 * wave(u, w) * wave(v, w))
    case 1:
      return clamp01(0.5 - 0.5 * wave(u, w))
    case 2: {
      const d = Math.hypot(fract(u) - 0.5, fract(v) - 0.5)
      return clamp01((0.35 - d) / Math.max(w, 1e-4) + 0.5)
    }
    case 3: {
      const dx = Math.abs(fract(u + 0.5) - 0.5)
      const dy = Math.abs(fract(v + 0.5) - 0.5)
      const ww = Math.max(w, 1e-4)
      return Math.max(clamp01((0.05 - dx) / ww + 0.5), clamp01((0.05 - dy) / ww + 0.5))
    }
    default:
      return 0
  }
}

/** The same, as WGSL: `pattern_value(index, p, w)`. */
export const PATTERN_WGSL = `
fn pattern_wave(x: f32, w: f32) -> f32 {
  if (w < 1e-4) { return select(-1.0, 1.0, fract(x * 0.5) < 0.5); }
  return 2.0 * (abs(fract((x - 0.5 * w) * 0.5) - 0.5) - abs(fract((x + 0.5 * w) * 0.5) - 0.5)) / w;
}
fn pattern_value(index: u32, p: vec2f, w: f32) -> f32 {
  switch index {
    case 0u: { return clamp(0.5 - 0.5 * pattern_wave(p.x, w) * pattern_wave(p.y, w), 0.0, 1.0); }
    case 1u: { return clamp(0.5 - 0.5 * pattern_wave(p.x, w), 0.0, 1.0); }
    case 2u: {
      let d = length(fract(p) - vec2f(0.5));
      return clamp((0.35 - d) / max(w, 1e-4) + 0.5, 0.0, 1.0);
    }
    case 3u: {
      let dx = abs(fract(p.x + 0.5) - 0.5);
      let dy = abs(fract(p.y + 0.5) - 0.5);
      let ww = max(w, 1e-4);
      return max(clamp((0.05 - dx) / ww + 0.5, 0.0, 1.0), clamp((0.05 - dy) / ww + 0.5, 0.0, 1.0));
    }
    default: { return 0.0; }
  }
}
`
