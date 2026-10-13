/**
 * A tip's outline, for the brush cursor: where its coverage crosses a
 * third, traced with marching squares on a level about 64 texels across,
 * joined into closed loops and thinned (Ramer–Douglas–Peucker), in tip
 * space (−1..1 across the tip's longer side). Worked out once per tip.
 * The round tip's is a circle, made where it's drawn.
 */
import type { TipId } from './defs'
import { levelSize, tipImage } from './tips'

type Pt = [number, number]

const made = new Map<TipId, Pt[][]>()

/** Fewest points that stay within `eps` of the line. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts
  const [a, b] = [pts[0], pts[pts.length - 1]]
  let far = 0
  let at = 0
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len
    if (d > far) {
      far = d
      at = i
    }
  }
  if (far <= eps) return [a, b]
  return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)]
}

/** The outline's loops; empty for a tip with nothing in it, or one not known here. */
export function tipOutline(tip: TipId): Pt[][] {
  const have = made.get(tip)
  if (have) return have
  const t = tipImage(tip)
  if (!t) return []
  // The level nearest 64 texels across.
  let l = 0
  while (l < t.levels.length - 1 && Math.max(...levelSize(t, l)) > 64) l++
  const [w, h] = levelSize(t, l)
  const img = t.levels[l]
  const peak = img.reduce((m, v) => Math.max(m, v), 0)
  if (peak <= 0) return []
  const level = peak / 3
  // Padded by one empty texel all round, so every loop closes.
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img[y * w + x])
  const m = Math.max(t.width, t.height)
  const scale = 2 ** l
  // A texel corner (between texel centres) in tip space.
  const toTip = (x: number, y: number): Pt => [((x + 0.5) * scale + (m - t.width) / 2) / m * 2 - 1, ((y + 0.5) * scale + (m - t.height) / 2) / m * 2 - 1]
  // Edges from marching squares, keyed by their start, as cell-edge midpoints interpolated.
  const segs = new Map<string, { a: Pt; b: Pt; to: string }>()
  const edgePoint = (x0: number, y0: number, x1: number, y1: number): Pt => {
    const v0 = at(x0, y0)
    const v1 = at(x1, y1)
    const k = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0)
    return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k]
  }
  const key = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`
  for (let y = -1; y < h; y++)
    for (let x = -1; x < w; x++) {
      const c = (at(x, y) > level ? 8 : 0) | (at(x + 1, y) > level ? 4 : 0) | (at(x + 1, y + 1) > level ? 2 : 0) | (at(x, y + 1) > level ? 1 : 0)
      if (c === 0 || c === 15) continue
      const top = () => edgePoint(x, y, x + 1, y)
      const right = () => edgePoint(x + 1, y, x + 1, y + 1)
      const bottom = () => edgePoint(x, y + 1, x + 1, y + 1)
      const left = () => edgePoint(x, y, x, y + 1)
      // Each case's segments, oriented so the inside is on one side throughout.
      const cases: Record<number, [() => Pt, () => Pt][]> = {
        1: [[left, bottom]],
        2: [[bottom, right]],
        3: [[left, right]],
        4: [[right, top]],
        5: [[left, top], [right, bottom]],
        6: [[bottom, top]],
        7: [[left, top]],
        8: [[top, left]],
        9: [[top, bottom]],
        10: [[top, right], [bottom, left]],
        11: [[top, right]],
        12: [[right, left]],
        13: [[right, bottom]],
        14: [[bottom, left]],
      }
      for (const [fa, fb] of cases[c]) {
        const a = fa()
        const b = fb()
        segs.set(key(a), { a, b, to: key(b) })
      }
    }
  // Joined into loops.
  const loops: Pt[][] = []
  const used = new Set<string>()
  for (const [k0, s0] of segs) {
    if (used.has(k0)) continue
    const loop: Pt[] = []
    let k = k0
    let s = s0
    while (s && !used.has(k)) {
      used.add(k)
      loop.push(s.a)
      k = s.to
      s = segs.get(k)!
    }
    if (loop.length < 3) continue
    // A closed loop's ends meet, which gives the line between them no direction: it's thinned as two halves, split where it's farthest from its start.
    let far = 0
    for (let i = 1; i < loop.length; i++) if (Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]) > Math.hypot(loop[far][0] - loop[0][0], loop[far][1] - loop[0][1])) far = i
    const thin = [...simplify(loop.slice(0, far + 1), 0.6).slice(0, -1), ...simplify([...loop.slice(far), loop[0]], 0.6).slice(0, -1)]
    if (thin.length >= 3) loops.push(thin.map(([x, y]) => toTip(x, y)))
  }
  // The bigger loops only: specks would make the cursor noisy.
  const area = (p: Pt[]) => Math.abs(p.reduce((s, q, i) => s + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0)) / 2
  const out = loops
    .filter((p) => p.length >= 3)
    .sort((a, b) => area(b) - area(a))
    .slice(0, 24)
    .filter((p, i, all) => i === 0 || area(p) > area(all[0]) * 0.01)
  made.set(tip, out)
  return out
}

/** The outline as the cursor draws it: a dab's shape in document pixels round (x, y). */
export function cursorLoops(tip: TipId, x: number, y: number, size: number, angleDeg: number, roundness: number, flipX: boolean, flipY: boolean): Pt[][] {
  const loops = tip === 'round' ? [Array.from({ length: 48 }, (_, i) => [Math.cos((i / 48) * Math.PI * 2), Math.sin((i / 48) * Math.PI * 2)] as Pt)] : tipOutline(tip)
  const r = size / 2
  const a = (angleDeg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return loops.map((loop) =>
    loop.map(([ux, uy]) => {
      // Tip space to document, as dab.ts maps the other way: flip, scale by the radii, turn.
      const dx = ux * r * (flipX ? -1 : 1)
      const dy = uy * r * roundness * (flipY ? -1 : 1)
      return [x + dx * cos - dy * sin, y + dx * sin + dy * cos] as Pt
    }),
  )
}
