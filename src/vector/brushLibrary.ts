/**
 * The vector brushes Plexel comes with: a few of each kind to start from,
 * made here in a document's colour mode. Choosing one copies it into the
 * document's library (by its id, so its strokes stay linked to it there).
 */
import type { ColourMode } from '../doc/types'
import { solid, type Paint } from '../doc/vector'
import { artFrom, type BrushArt, type BrushPart, type VectorBrush } from '../doc/vectorBrush'
import { anchor, pathBounds, type PathData } from '../geom/path'
import { KAPPA } from '../geom/shapes'
import { rgbIn } from './brush'

const paintOf = (rgb: [number, number, number], mode: ColourMode): Paint => solid(rgbIn(rgb, mode))

const poly = (pts: [number, number][]): PathData => ({ fillRule: 'nonzero', subpaths: [{ closed: true, anchors: pts.map(([x, y]) => anchor(x, y)) }] })
const rect = (x0: number, y0: number, x1: number, y1: number) => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])

function ellipse(cx: number, cy: number, rx: number, ry: number): PathData {
  const k = KAPPA
  return {
    fillRule: 'nonzero',
    subpaths: [
      {
        closed: true,
        anchors: [
          anchor(cx, cy - ry, [cx - rx * k, cy - ry], [cx + rx * k, cy - ry], true),
          anchor(cx + rx, cy, [cx + rx, cy - ry * k], [cx + rx, cy + ry * k], true),
          anchor(cx, cy + ry, [cx + rx * k, cy + ry], [cx - rx * k, cy + ry], true),
          anchor(cx - rx, cy, [cx - rx, cy + ry * k], [cx - rx, cy - ry * k], true),
        ],
      },
    ],
  }
}

function star(cx: number, cy: number, r: number, inner: number, points: number): PathData {
  const pts: [number, number][] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points
    const rr = i % 2 ? r * inner : r
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr])
  }
  return poly(pts)
}

const art = (parts: BrushPart[]): BrushArt => artFrom(parts, (p) => pathBounds(p))!

/** The built-in brushes, in `mode`'s colours. */
export function builtinBrushes(mode: ColourMode): VectorBrush[] {
  const ink = paintOf([0, 0, 0], mode)
  const flips = { flipAlong: false, flipAcross: false }
  // A lens: two curves from end to end, pointed at both.
  const lens: PathData = { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [anchor(0, 0, [30, 12], [30, -12]), anchor(100, 0, [70, -12], [70, 12])] }] }
  return [
    { id: 'builtin:taper', name: 'Tapered Ink', kind: 'art', colorize: 'tints', art: art([{ path: lens, paint: ink }]), fit: 'stretch', guides: [0.25, 0.25], scale: 1, ...flips },
    {
      id: 'builtin:arrow',
      name: 'Arrow',
      kind: 'art',
      colorize: 'tints',
      art: art([
        { path: rect(0, -3, 80, 3), paint: ink },
        { path: poly([[78, -10], [100, 0], [78, 10]]), paint: ink },
      ]),
      fit: 'guides',
      guides: [0, 0.22],
      scale: 1,
      ...flips,
    },
    {
      id: 'builtin:ribbon',
      name: 'Ribbon',
      kind: 'art',
      colorize: 'hue-shift',
      art: art([
        { path: rect(0, -10, 100, 0), paint: paintOf([0.86, 0.15, 0.2], mode) },
        { path: rect(0, 0, 100, 10), paint: paintOf([0.55, 0.05, 0.1], mode) },
        { path: rect(0, -1, 100, 1), paint: paintOf([1, 0.85, 0.3], mode) },
      ]),
      fit: 'stretch',
      guides: [0.25, 0.25],
      scale: 1,
      ...flips,
    },
    { id: 'builtin:dots', name: 'Dots', kind: 'scatter', colorize: 'tints', art: art([{ path: ellipse(0, 0, 5, 5), paint: ink }]), size: [0.8, 1.2], spacing: [1.6, 2.4], scatter: [-0.6, 0.6], rotation: [0, 0], relative: 'path', seed: 7 },
    { id: 'builtin:stars', name: 'Stars', kind: 'scatter', colorize: 'tints', art: art([{ path: star(0, 0, 10, 0.45, 5), paint: ink }]), size: [0.6, 1.4], spacing: [1.2, 2], scatter: [-1, 1], rotation: [-180, 180], relative: 'page', seed: 11 },
    {
      id: 'builtin:confetti',
      name: 'Confetti',
      kind: 'scatter',
      colorize: 'none',
      art: art([
        { path: rect(-6, -4, -2, 4), paint: paintOf([0.95, 0.3, 0.3], mode) },
        { path: rect(1, -6, 4, 0), paint: paintOf([1, 0.8, 0.2], mode) },
        { path: rect(1, 2, 7, 5), paint: paintOf([0.25, 0.5, 0.95], mode) },
      ]),
      size: [0.5, 1.2],
      spacing: [1, 1.8],
      scatter: [-1.2, 1.2],
      rotation: [-180, 180],
      relative: 'page',
      seed: 3,
    },
    {
      id: 'builtin:rope',
      name: 'Rope',
      kind: 'pattern',
      colorize: 'tints-shades',
      side: art([
        { path: poly([[0, 8], [6, -8], [12, -8], [6, 8]]), paint: paintOf([0.35, 0.35, 0.35], mode) },
        { path: poly([[2, 6], [7, -6], [9, -6], [4, 6]]), paint: paintOf([0.75, 0.75, 0.75], mode) },
      ]),
      fit: 'stretch',
      scale: 1,
      ...flips,
    },
    {
      id: 'builtin:railroad',
      name: 'Railroad',
      kind: 'pattern',
      colorize: 'tints',
      side: art([
        { path: rect(0, -7, 20, -5), paint: ink },
        { path: rect(0, 5, 20, 7), paint: ink },
        { path: rect(8, -10, 12, 10), paint: paintOf([0.45, 0.45, 0.45], mode) },
      ]),
      corner: art([{ path: rect(-10, -10, 10, 10), paint: paintOf([0.45, 0.45, 0.45], mode) }]),
      fit: 'stretch',
      scale: 1,
      ...flips,
    },
    {
      id: 'builtin:beads',
      name: 'Beads',
      kind: 'pattern',
      colorize: 'tints',
      side: art([
        { path: rect(0, -0.8, 12, 0.8), paint: ink },
        { path: ellipse(6, 0, 4, 4), paint: ink },
      ]),
      fit: 'stretch',
      scale: 1,
      ...flips,
    },
  ]
}
