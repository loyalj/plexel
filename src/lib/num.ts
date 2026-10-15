/** Numbers kept in range: the one definition of each, where a dozen modules had their own. */

/** v kept within 0..1. */
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** v kept within lo..hi. */
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
