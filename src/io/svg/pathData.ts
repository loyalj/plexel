/**
 * A path as SVG path data: what the SVG writer uses, and what Copy puts on
 * the clipboard for a path, kept apart from the writer so copying a path
 * doesn't load it.
 */
import type { PathData } from '../../geom/path'

/** A number as SVG writes it: three decimals at most, and no "-0". */
export const n4 = (v: number) => (Math.abs(v) < 1e-9 ? '0' : String(Math.round(v * 1000) / 1000))

export function pathD(p: PathData): string {
  let d = ''
  for (const s of p.subpaths) {
    const a = s.anchors
    if (!a.length) continue
    d += `M${n4(a[0].p[0])} ${n4(a[0].p[1])}`
    const seg = (i: number, j: number) => {
      const p0 = a[i]
      const p1 = a[j]
      if (p0.out || p1.in) {
        const c1 = p0.out ?? p0.p
        const c2 = p1.in ?? p1.p
        d += `C${n4(c1[0])} ${n4(c1[1])} ${n4(c2[0])} ${n4(c2[1])} ${n4(p1.p[0])} ${n4(p1.p[1])}`
      } else d += `L${n4(p1.p[0])} ${n4(p1.p[1])}`
    }
    for (let i = 0; i + 1 < a.length; i++) seg(i, i + 1)
    if (s.closed) {
      if (a.length > 1) seg(a.length - 1, 0)
      d += 'Z'
    }
  }
  return d
}
