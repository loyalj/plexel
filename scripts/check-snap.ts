/**
 * Guides, grids, snapping and alignment, headless: where points and boxes
 * snap (lines, the grid, equal spacing) and the smart guides they report;
 * align and distribute; the guide edits, layouts and New Guides from
 * Shape; guides moving with Crop and Canvas Size and saving in the file;
 * the settings read defensively; the overlay's guides and grids; and the
 * shortcuts on ; and ' found with Shift held.
 *
 * Run with: npm run check:snap
 */
import { boxLines, snapBox, snapPoint, unionBox, type Box, type SnapTargets } from '../src/geom/snap'
import { alignDeltas, distributeDeltas } from '../src/geom/align'
import { addGuides, boxGuides, clearGuides, layoutGuides, mapGuides, moveGuide, removeGuide, DEFAULT_LAYOUT } from '../src/doc/guides'
import { DEFAULT_PROFILES, createDoc, crop, resizeCanvas } from '../src/doc/edit'
import { docToJson, readDocJson } from '../src/doc/serialize'
import { describeEdit } from '../src/doc/describe'
import { DEFAULT_GUIDE_PREFS, readGuidePrefs, rgbOf } from '../src/app/guidePrefs'
import { INK, VERTEX_FLOATS, tessellate, type OverlayView } from '../src/render/overlay'
import { viewMatrix } from '../src/render/view'
import { matches, parseShortcut } from '../src/input/shortcuts'
import type { Doc } from '../src/doc/types'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e
const targets = (t: Partial<SnapTargets>): SnapTargets => ({ x: [], y: [], grid: null, boxes: [], ...t })
const withBoxes = (boxes: Box[]): SnapTargets => {
  const t = targets({ boxes })
  for (const b of boxes) {
    const l = boxLines(b, 'layer')
    t.x.push(...l.x)
    t.y.push(...l.y)
  }
  return t
}

// --- points ------------------------------------------------------------------------------------
console.log('points')
{
  const t = targets({ x: [{ at: 100, span: null, kind: 'guide' }], y: [{ at: 40, span: null, kind: 'guide' }] })
  const s = snapPoint(104, 45, t, 8)
  check('a point near a guide snaps onto it, on each axis', near(104 + s.dx, 100) && near(45 + s.dy, 40) && s.x && s.y)
  const far = snapPoint(110, 60, t, 8)
  check('one further away than the tolerance stays where it is', far.dx === 0 && far.dy === 0 && !far.x && !far.y)
  check('a guide snapped to draws no smart guide (it shows already)', s.lines.length === 0)
  const g = snapPoint(26, 0, targets({ grid: { x: { step: 10, origin: 3 }, y: { step: 10, origin: 3 } } }), 5)
  check('a point snaps to the nearest grid line, through the zero point', near(26 + g.dx, 23) && near(0 + g.dy, 3))
  const none = snapPoint(104, 45, t, 0)
  check('with no tolerance nothing snaps', none.dx === 0 && none.dy === 0)
  const p = snapPoint(52, 70, withBoxes([[50, 0, 60, 10]]), 4)
  const line = p.lines.find((l) => l.axis === 'x')
  check('a point lined up with a layer’s edge snaps, and a smart guide runs from it to the layer', near(52 + p.dx, 50) && !!line && near(line.at, 50) && near(line.from, 0) && near(line.to, 70), JSON.stringify(p.lines))
}

// --- boxes -------------------------------------------------------------------------------------
console.log('\nboxes')
{
  const t = withBoxes([[50, 0, 60, 10]])
  const s = snapBox([38, 20, 48, 30], t, 4)
  check('a box’s right edge snaps to another’s left', near(s.dx, 2) && s.x, String(s.dx))
  const l = s.lines.find((x) => x.axis === 'x' && near(x.at, 50))
  check('and the smart guide spans both boxes', !!l && near(l.from, 0) && near(l.to, 30), JSON.stringify(s.lines))
  const c = snapBox([53, 40, 59, 50], t, 4)
  check('centres snap to centres, the nearest line winning', near(c.dx, -1) && near((53 + 59) / 2 + c.dx, 55), String(c.dx))
  const edge = snapBox([47, 40, 57, 50], withBoxes([[50, 0, 60, 10]]), 4)
  check('any of its edges or its centre snaps to any of another’s: here its right edge to the other’s centre', near(edge.dx, -2), String(edge.dx))
  const only = snapBox([38, 20, 48, 30], t, 4, { x: false, y: true })
  check('an axis left out doesn’t snap', only.dx === 0)
}

// --- equal spacing -----------------------------------------------------------------------------
console.log('\nequal spacing')
{
  const row: Box[] = [
    [0, 0, 10, 10],
    [100, 0, 110, 10],
  ]
  const s = snapBox([42, 2, 62, 8], withBoxes(row), 4)
  check('a box between two snaps to the middle of the gap', near(42 + s.dx, 45) && s.gaps.length === 2, JSON.stringify(s))
  check('its gaps are marked, the same size each side', s.gaps.length === 2 && near(s.gaps[0].to - s.gaps[0].from, s.gaps[1].to - s.gaps[1].from))
  const series = snapBox([61, 0, 71, 10], targets({ boxes: [[0, 0, 10, 10], [30, 0, 40, 10]] }), 3)
  check('beside a pair it repeats their gap', near(61 + series.dx, 60) && series.gaps.length === 2, JSON.stringify(series.gaps))
  const before = snapBox([-32, 0, -22, 10], targets({ boxes: [[0, 0, 10, 10], [30, 0, 40, 10]] }), 3)
  check('on the other side too', near(-22 + before.dx, -20), String(before.dx))
  const other = snapBox([42, 50, 62, 60], withBoxes(row), 4)
  check('boxes in another row don’t space it', other.gaps.length === 0)
}

// --- align and distribute ----------------------------------------------------------------------
console.log('\nalign and distribute')
{
  const boxes: Box[] = [
    [10, 10, 30, 20],
    [50, 30, 60, 60],
    [100, 0, 140, 5],
  ]
  const ref = unionBox(boxes)!
  const left = alignDeltas(boxes, 'left', ref)
  check('Align Left Edges brings each to the leftmost', boxes.every((b, i) => near(b[0] + left[i][0], 10) && left[i][1] === 0))
  const mid = alignDeltas(boxes, 'vcentre', ref)
  check('Align Vertical Centres to the box round them all', boxes.every((b, i) => near((b[1] + b[3]) / 2 + mid[i][1], 30)))
  const canvas = alignDeltas(boxes, 'right', [0, 0, 200, 100])
  check('to the canvas, its right edge', boxes.every((b, i) => near(b[2] + canvas[i][0], 200)))
  const d = distributeDeltas(boxes, 'hcentre')
  const centres = boxes.map((b, i) => (b[0] + b[2]) / 2 + d[i][0])
  check('Distribute Horizontal Centres spreads the centres evenly, the outer two staying put', near(centres[0], 20) && near(centres[2], 120) && near(centres[1], 70), centres.join())
  const sp = distributeDeltas(boxes, 'hspace')
  const moved = boxes.map((b, i) => [b[0] + sp[i][0], b[2] + sp[i][0]])
  check('Distribute Horizontal Spacing makes the gaps equal', near(moved[1][0] - moved[0][1], moved[2][0] - moved[1][1]) && near(moved[0][0], 10) && near(moved[2][1], 140), JSON.stringify(moved))
  const across = distributeDeltas(boxes.slice(0, 2), 'left', [0, 0, 200, 100])
  check('across the canvas, two layers go against its edges', near(boxes[0][0] + across[0][0], 0) && near(boxes[1][2] + across[1][0], 200))
  check('two layers alone don’t distribute between themselves', distributeDeltas(boxes.slice(0, 2), 'left').every((x) => x[0] === 0 && x[1] === 0))
  const unsorted = distributeDeltas([boxes[2], boxes[0], boxes[1]], 'hcentre')
  check('the order they’re selected in doesn’t matter', near(unsorted[1][0], d[0][0]) && near(unsorted[2][0], d[1][0]) && near(unsorted[0][0], d[2][0]))
}

// --- guides in the document --------------------------------------------------------------------
console.log('\nguides in the document')
const doc0: Doc = createDoc({ name: 'G', width: 500, height: 300, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
{
  let d = addGuides(doc0, [{ axis: 'x', at: 100 }, { axis: 'y', at: 50 }, { axis: 'x', at: 100 }])
  check('guides are added once each', d.guides.length === 2)
  check('a change to them is named', describeEdit(doc0, d) === 'Guides', describeEdit(doc0, d))
  check('adding nothing new changes nothing', addGuides(d, [{ axis: 'x', at: 100 }]) === d)
  d = moveGuide(d, 0, 120)
  check('a guide moves', d.guides[0].at === 120 && d.guides[0].axis === 'x')
  const merged = moveGuide(addGuides(d, [{ axis: 'x', at: 200 }]), 2, 120)
  check('one moved onto another merges with it', merged.guides.length === 2)
  check('a guide is removed', removeGuide(d, 1).guides.length === 1 && removeGuide(d, 5) === d)
  const cleared = clearGuides(d)
  check('Clear Guides, and again changes nothing', cleared.guides.length === 0 && clearGuides(cleared) === cleared)
  const back = readDocJson(docToJson(d))
  check('guides save and read back', back.ok && JSON.stringify(back.doc.guides) === JSON.stringify(d.guides))
  const bad = readDocJson(JSON.parse(docToJson({ ...d, guides: [{ axis: 'z', at: 3 }, { axis: 'y', at: 'x' }, { axis: 'y', at: 7 }] as never })))
  check('a guide that can’t be read is dropped, with a warning', bad.ok && bad.doc.guides.length === 1 && bad.warnings.some((w) => /guide could not be read.*2 times/.test(w)), bad.ok ? JSON.stringify([bad.doc.guides, bad.warnings]) : bad.error)
  const grown = resizeCanvas(d, 700, 500, { x: 0.5, y: 0.5 })
  check('Canvas Size moves the guides with the canvas', grown.guides[0].at === 220 && grown.guides[1].at === 150, JSON.stringify(grown.guides))
  const cropped = crop(d, { x: 20, y: 10, width: 300, height: 200, angle: 0 })
  check('Crop moves them too', near(cropped.guides[0].at, 100) && near(cropped.guides[1].at, 40), JSON.stringify(cropped.guides))
  const turned = crop(d, { x: 0, y: 0, width: 300, height: 500, angle: 90 })
  check('turned a quarter, across becomes down', turned.guides.length === 2 && turned.guides.some((g) => g.axis === 'y') && turned.guides.some((g) => g.axis === 'x'), JSON.stringify(turned.guides))
  check('straightened at an angle, they go', crop(d, { x: 0, y: 0, width: 300, height: 200, angle: 7 }).guides.length === 0)
  check('mapGuides drops what it returns nothing for', mapGuides(d, (g) => (g.axis === 'x' ? g : null)).guides.length === 1)
}

// --- New Guide Layout --------------------------------------------------------------------------
console.log('\nNew Guide Layout')
{
  const cols = layoutGuides({ ...DEFAULT_LAYOUT, columns: { count: 4, width: 0, gutter: 20 } }, 500, 300)
  check('four columns with gutters share out the width', cols.map((g) => g.at).join() === '0,110,130,240,260,370,390,500' && cols.every((g) => g.axis === 'x'), cols.map((g) => g.at).join())
  const margins = layoutGuides({ columns: { count: 0, width: 0, gutter: 0 }, rows: { count: 2, height: 0, gutter: 0 }, margin: { top: 20, left: 30, bottom: 20, right: 30 } }, 500, 300)
  check('margins make guides of their own, and rows fit inside them', margins.filter((g) => g.axis === 'x').map((g) => g.at).join() === '30,470' && margins.filter((g) => g.axis === 'y').map((g) => g.at).join() === '20,150,280', JSON.stringify(margins))
  const fixed = layoutGuides({ ...DEFAULT_LAYOUT, columns: { count: 2, width: 100, gutter: 10 } }, 500, 300)
  check('columns of a given width are centred', fixed.map((g) => g.at).join() === '145,245,255,355', fixed.map((g) => g.at).join())
  check('none that don’t fit', layoutGuides({ ...DEFAULT_LAYOUT, columns: { count: 10, width: 0, gutter: 100 } }, 500, 300).length === 0)
  check('New Guides from Shape: its edges and centre both ways', boxGuides([10, 20, 30, 60]).map((g) => `${g.axis}${g.at}`).join() === 'x10,x20,x30,y20,y40,y60')
}

// --- settings ----------------------------------------------------------------------------------
console.log('\nsettings')
{
  check('nothing saved: the defaults', readGuidePrefs(null) === DEFAULT_GUIDE_PREFS)
  check('not JSON, or not an object: the defaults', readGuidePrefs('{') === DEFAULT_GUIDE_PREFS && readGuidePrefs('[1]') === DEFAULT_GUIDE_PREFS)
  const p = readGuidePrefs(JSON.stringify({ rulers: true, units: 'cm', gridEvery: -4, gridSub: 2.5, guideColour: '#ABCDEF', smartColour: 'red', alignTo: 'canvas', snapTo: { pixels: true, grid: 'yes' } }))
  check('each setting is read on its own; what’s wrong is its default', p.rulers && p.units === 'cm' && p.gridEvery === 100 && p.gridSub === 4 && p.guideColour === '#abcdef' && p.smartColour === DEFAULT_GUIDE_PREFS.smartColour && p.alignTo === 'canvas' && p.snapTo.pixels && p.snapTo.grid)
  check('reading never changes the defaults', !DEFAULT_GUIDE_PREFS.snapTo.pixels && DEFAULT_GUIDE_PREFS.units === 'px')
  check('a colour as channels', JSON.stringify(rgbOf('#ff8000')) === JSON.stringify([1, 128 / 255, 0]))
}

// --- the overlay's guides and grids -----------------------------------------------------------
console.log('\nthe overlay’s guides and grids')
{
  const size = { width: 800, height: 600, dpr: 1 }
  const at = (zoom: number) => viewMatrix({ cx: 250, cy: 150, zoom, rotation: 0 }, size)
  const view = (o: Partial<OverlayView>): OverlayView => ({ width: 500, height: 300, guides: [], grid: null, pixelGrid: false, colours: { guide: [0, 1, 1], smart: [1, 0, 1], grid: [0.5, 0.5, 0.5] }, ...o })
  const inks = (v: Float32Array) => {
    const out = new Map<number, number>()
    for (let i = 3; i < v.length; i += VERTEX_FLOATS * 3) out.set(v[i], (out.get(v[i]) ?? 0) + 1)
    return out
  }
  const g = tessellate([], at(1), 1, size, view({ guides: [{ axis: 'x', at: 100 }] }))
  const xs = [...g].filter((_, i) => i % VERTEX_FLOATS === 0)
  const ys = [...g].filter((_, i) => i % VERTEX_FLOATS === 1)
  check('a guide crosses the whole canvas, top to bottom', Math.min(...ys) <= 0 && Math.max(...ys) >= 600 && Math.max(...xs) - Math.min(...xs) < 3 && inks(g).get(INK.guide) === 2)
  const grid = tessellate([], at(1), 1, size, view({ grid: { step: [100, 100], origin: [0, 0], sub: 4 } }))
  const gi = inks(grid)
  check('the grid draws its lines and, far enough apart, the finer ones', (gi.get(INK.grid) ?? 0) === 2 * (6 + 4) && (gi.get(INK.gridSub) ?? 0) === 2 * (15 + 9), JSON.stringify([...gi]))
  const fewer = inks(tessellate([], at(0.1), 1, size, view({ grid: { step: [100, 100], origin: [0, 0], sub: 4 } })))
  const none = inks(tessellate([], at(0.05), 1, size, view({ grid: { step: [100, 100], origin: [0, 0], sub: 4 } })))
  check('zoomed out, lines closer than a few pixels are left out: the finer ones first, then all', !fewer.get(INK.gridSub) && (fewer.get(INK.grid) ?? 0) > 0 && !none.get(INK.grid), JSON.stringify([[...fewer], [...none]]))
  check('the pixel grid shows only zoomed in close', !inks(tessellate([], at(4), 1, size, view({ pixelGrid: true }))).get(INK.pixelGrid) && (inks(tessellate([], at(8), 1, size, view({ pixelGrid: true }))).get(INK.pixelGrid) ?? 0) > 0)
  const turned = tessellate([], viewMatrix({ cx: 250, cy: 150, zoom: 1, rotation: 30 }, size), 1, size, view({ guides: [{ axis: 'y', at: 150 }] }))
  check('a guide in a turned view is clipped to the canvas', turned.length > 0 && [...turned].every((v, i) => i % VERTEX_FLOATS > 1 || (v >= -4 && v <= 804)))
  const smart = inks(tessellate([{ kind: 'path', points: [[0, 0], [10, 0]], closed: false, style: 'smart' }], at(1), 1, size))
  check('a smart guide is drawn in its own ink', smart.get(INK.smart) === 2)
}

// --- keys ----------------------------------------------------------------------------------------
console.log('\nkeys')
{
  const key = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent
  check('Ctrl+Shift+; is found though Shift makes the key a colon', matches(parseShortcut('Mod+Shift+;')!, key({ key: ':', code: 'Semicolon', ctrlKey: true, shiftKey: true }), false))
  check("Ctrl+' by its key", matches(parseShortcut("Mod+'")!, key({ key: "'", code: 'Quote', ctrlKey: true }), false))
  check('Ctrl+; isn’t Ctrl+Shift+;', !matches(parseShortcut('Mod+;')!, key({ key: ':', code: 'Semicolon', ctrlKey: true, shiftKey: true }), false))
}

console.log(failures ? `\n${failures} failure${failures === 1 ? '' : 's'}` : '\nall clear')
process.exit(failures ? 1 : 0)
