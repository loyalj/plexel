/**
 * A seeded random number generator for brush jitter (mulberry32). Never
 * `Math.random`: the same pen samples and seed must make the same stroke
 * every time, so strokes replay exactly in the checks and on every machine
 * (ARCHITECTURE.md, "Painting").
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
