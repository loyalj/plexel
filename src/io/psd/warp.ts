/**
 * Photoshop's warps, in and out: a placed layer's (smart object's)
 * perspective corners and warp, and warped text, as Plexel's Warp effect
 * (filters/defs.ts). Photoshop warps the contents' rectangle with a mesh,
 * then carries its corners to a quad; so does the Warp effect, with the
 * contents' rectangle as its frame.
 */
import type { DValue, Descriptor } from './descriptor'
import { D, en, get, num, obj } from './descriptor'

const STYLES: [string, string][] = [
  ['warpArc', 'arc'],
  ['warpArcLower', 'arc-lower'],
  ['warpArcUpper', 'arc-upper'],
  ['warpArch', 'arch'],
  ['warpBulge', 'bulge'],
  ['warpShellLower', 'shell-lower'],
  ['warpShellUpper', 'shell-upper'],
  ['warpFlag', 'flag'],
  ['warpWave', 'wave'],
  ['warpFish', 'fish'],
  ['warpRise', 'rise'],
  ['warpFisheye', 'fisheye'],
  ['warpInflate', 'inflate'],
  ['warpSqueeze', 'squeeze'],
  ['warpTwist', 'twist'],
  ['warpCustom', 'custom'],
]
const FROM = new Map(STYLES)
const TO = new Map(STYLES.map(([a, b]) => [b, a]))

/** Numbers out of a list of unit floats, or doubles. */
function numbers(v: DValue | undefined): number[] {
  if (!v) return []
  if (v.t === 'UnFl') return v.v
  if (v.t === 'VlLs') return v.v.flatMap((x) => (x.t === 'doub' || x.t === 'UntF' || x.t === 'long' ? [x.v] : x.t === 'UnFl' ? x.v : []))
  return []
}

/**
 * A Warp effect's settings from Photoshop's warp descriptor (and a placed
 * layer's corners, in the node's own coordinates, when they're off their
 * parallelogram), over `frame` (the unit square to the contents'
 * rectangle). Null when neither moves anything.
 */
export function warpFromPsd(w: Descriptor | undefined, frame: number[], corners: number[] | null): Record<string, unknown> | null {
  const id = w ? en(w, 'warpStyle') : null
  const style = id && id !== 'warpNone' ? (FROM.get(id) ?? null) : null
  let mesh: { cols: number; rows: number; pts: number[] } | null = null
  if (style === 'custom') {
    const pts = obj(obj(w, 'customEnvelopeWarp'), 'meshPoints')
    const xs = numbers(get(pts, 'Hrzn'))
    const ys = numbers(get(pts, 'Vrtc'))
    const b = obj(w, 'bounds')
    const l = num(b, 'Left')
    const t = num(b, 'Top ')
    const r = num(b, 'Rght', l + 1)
    const bt = num(b, 'Btom', t + 1)
    if (xs.length === 16 && ys.length === 16 && r > l && bt > t) mesh = { cols: 1, rows: 1, pts: xs.flatMap((x, i) => [(x - l) / (r - l), (ys[i] - t) / (bt - t)]) }
  }
  if (!style && !corners) return null
  if (style === 'custom' && !mesh) return corners ? { style: 'none', frame, corners } : null
  return {
    style: style ?? 'none',
    bend: num(w, 'warpValue'),
    horizontal: num(w, 'warpPerspective'),
    vertical: num(w, 'warpPerspectiveOther'),
    orient: en(w, 'warpRotate') === 'Vrtc' ? 'vertical' : 'horizontal',
    frame,
    ...(corners ? { corners } : {}),
    ...(mesh ? { mesh } : {}),
  }
}

/** Photoshop's warp descriptor for a Warp effect's settings (whole), over contents `w` × `h`; a flat one for none. */
export function warpToPsd(v: Record<string, unknown> | null, w: number, h: number): [string, DValue][] {
  const style = v ? (v.style as string) : 'none'
  const id = TO.get(style) ?? 'warpNone'
  const items: [string, DValue][] = [
    ['warpStyle', D.enum('warpStyle', id)],
    ['warpValue', D.doub(v && style !== 'custom' ? (v.bend as number) : 0)],
    ['warpPerspective', D.doub(v && style !== 'custom' ? (v.horizontal as number) : 0)],
    ['warpPerspectiveOther', D.doub(v && style !== 'custom' ? (v.vertical as number) : 0)],
    ['warpRotate', D.enum('Ornt', v?.orient === 'vertical' ? 'Vrtc' : 'Hrzn')],
  ]
  const mesh = v?.mesh as { cols: number; rows: number; pts: number[] } | null
  if (style === 'custom' && mesh && mesh.cols === 1 && mesh.rows === 1) {
    items.push(['bounds', D.obj('classFloatRect', [['Top ', D.doub(0)], ['Left', D.doub(0)], ['Btom', D.doub(h)], ['Rght', D.doub(w)]])])
    items.push(['uOrder', D.long(4)], ['vOrder', D.long(4)])
    const xs = mesh.pts.filter((_, i) => i % 2 === 0).map((x) => x * w)
    const ys = mesh.pts.filter((_, i) => i % 2 === 1).map((y) => y * h)
    items.push(['customEnvelopeWarp', D.obj('customEnvelopeWarp', [['meshPoints', D.obj('rationalPoint', [['Hrzn', { t: 'UnFl', unit: '#Pxl', v: xs }], ['Vrtc', { t: 'UnFl', unit: '#Pxl', v: ys }]])]])])
  }
  return items
}
