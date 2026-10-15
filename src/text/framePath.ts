/**
 * A text frame's path as layout reads it, and how far along it a point is.
 * Apart from the layout itself, so the Type tool can place text on a path
 * before the layout (loaded with the fonts, app/text.ts) is there.
 */
import { flattenPath, type PathData } from '../geom/path'

/** A frame's path as polylines, each closed one with its first point again at its end. */
export function pathPolys(frame: PathData): number[][] {
  return flattenPath(frame, 0.25).map((l) => (l.closed && l.pts.length >= 4 ? [...l.pts, l.pts[0], l.pts[1]] : l.pts))
}

/** How far along a text path (its first subpath, as layout reads it) the point nearest (x, y) is: where text clicked onto a path starts. */
export function distanceAlong(frame: PathData, x: number, y: number): number {
  const pts = pathPolys(frame)[0]
  if (!pts || pts.length < 4) return 0
  let best = Infinity
  let at = 0
  let run = 0
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2]
    const ay = pts[i - 1]
    const dx = pts[i] - ax
    const dy = pts[i + 1] - ay
    const len = Math.hypot(dx, dy)
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (len * len))) : 0
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y)
    if (d < best) {
      best = d
      at = run + t * len
    }
    run += len
  }
  return at
}
