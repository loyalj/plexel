/**
 * Vectors in Chrome, end to end, through the real pointer, keys, menus and
 * panels: the Shape tool and its live shapes, edited in Properties; fills
 * and strokes in the appearance stack, with gradients; the Pen drawing and
 * closing paths, adding and deleting points; Direct Selection moving,
 * converting and deleting them; compound shapes made, released and
 * expanded; vector masks; Free Transform and Rasterize on shapes; the
 * Width tool and width profiles in Properties; vector brushes from the
 * panel, Brush Options, Properties and the Layer menu; undo.
 *
 * Documents are 800 × 600 at 100%, so an offset from the canvas's centre is
 * one from the document's centre (400, 300).
 *
 * Run with: npm run check:vectors
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const { press } = pageHelpers(page)
const clickMenu = async (menu, command, submenu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
  if (submenu) {
    await page.click(`[data-submenu="${submenu}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const idle = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
  await frames(page)
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (dx, dy, img) => {
  const r = await rect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const selected = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.selected ? d.history.present.nodes[d.selected] : null
})
const stepIs = (l) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout: 5000 }).then(() => true, () => false)
const pointAt = async (dx, dy) => {
  const r = await rect()
  return [r.x + r.w / 2 + dx, r.y + r.h / 2 + dy]
}
const drag = async (from, to, { keys = [], steps = 8 } = {}) => {
  const a = await pointAt(...from)
  const b = await pointAt(...to)
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(...a)
  await page.mouse.down()
  await page.mouse.move(...b, { steps })
  await page.mouse.up()
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(80)
}
const clickAt = async (dx, dy, keys = []) => {
  const p = await pointAt(dx, dy)
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.click(...p)
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(60)
}
/** The foreground set in the Colour panel's fields, focused directly: in a tall dock a click could land on another panel. */
const setForeground = async (r, g, b) => {
  await page.$eval('[data-model="rgb"]', (e) => e.click())
  await frames(page)
  for (const [l, v] of Object.entries({ R: r, G: g, B: b })) {
    await page.$eval(`.colour-number[data-channel="${l}"]`, (e) => {
      e.focus()
      e.select()
    })
    await page.keyboard.type(String(v))
    await page.keyboard.press('Enter')
  }
  await frames(page)
}
// The dock is taller than the window with a shape selected, so its
// controls are pressed and focused directly rather than clicked at a place
// on screen, where another panel might be.
/** Types into a Properties number field, by its range input's id. */
const setNumber = async (id, v) => {
  await page.$eval(`.slider-row:has(#${id}) .slider-number`, (e) => {
    e.focus()
    e.select()
  })
  await page.keyboard.type(String(v))
  await page.keyboard.press('Enter')
  await frames(page)
}
const tap = async (sel) => {
  await page.$eval(sel, (e) => e.click())
  await frames(page)
}
const typeInto = async (sel, text) => {
  await page.$eval(sel, (e) => {
    e.focus()
    e.select()
  })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await frames(page)
}
/** Selects a layer as a press on its row does. */
const pickLayer = async (id) => {
  await page.$eval(`.layer-row[data-layer="${id}"] .layer-name`, (e) => e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  await frames(page)
}
const newDoc = async () => {
  await press('Control+Alt+KeyN')
  await page.waitForSelector('#new-name')
  for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
    await page.click(id, { clickCount: 3 })
    await page.keyboard.type(String(v))
  }
  await page.click('[data-dialog="new"] .dialog-foot .primary')
  await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
  await idle()
  await page.click('.layer-row .layer-name')
  await press('Control+Digit1')
  await idle()
}
const RED = [255, 0, 0]
const BLUE = [0, 0, 255]
const WHITE = [255, 255, 255]

// --- the Shape tool ----------------------------------------------------------------------
console.log('\nthe Shape tool')
await newDoc()
await setForeground(255, 0, 0)
await press('KeyU')
check('U chooses the Shape tool, a rectangle to start with', await page.$eval('[data-shape-type="rect"]', (e) => e.getAttribute('aria-pressed') === 'true'))
await drag([-200, -100], [0, 100])
check('a drag draws a shape, one step', (await stepIs('New Shape')) && (await selected())?.kind === 'vector')
let s = await selected()
const close = (a, b) => Math.abs(a - b) <= 1
check('a live rectangle filling the dragged box', s.props.geometry.kind === 'shape' && s.props.geometry.shape.type === 'rect' && close(s.props.geometry.shape.w, 200) && close(s.props.geometry.shape.h, 200) && close(s.props.geometry.shape.x, 200), JSON.stringify(s.props.geometry.shape))
await idle()
check('filled with the foreground on the canvas', near(await at(-100, 0), RED) && near(await at(-195, -95), RED) && near(await at(100, 0), WHITE))
await setNumber('props-shape-radius', 60)
await idle()
s = await selected()
check('its corners round from Properties, still a live shape', s.props.geometry.shape.radii.every((r) => r === 60) && (await label()) === 'Edit Shape')
check('and the canvas follows: the corner is gone, the middle stays', near(await at(-197, -97), WHITE) && near(await at(-100, 0), RED))
await typeInto('#props-shape-w', '300')
await idle()
check('its box is typed in Properties', (await selected()).props.geometry.shape.w === 300 && near(await at(80, 0), RED))

await page.click('[data-shape-type="ellipse"]')
await drag([150, -150], [250, -50], { keys: ['Shift'] })
s = await selected()
check('an ellipse, Shift keeping it round', s.props.geometry.shape.type === 'ellipse' && s.props.geometry.shape.w === s.props.geometry.shape.h)
await page.click('[data-shape-type="star"]')
await drag([300, 150], [250, 100], { keys: ['Alt'] })
s = await selected()
check('a star, Alt drawing it from the middle', s.props.geometry.shape.type === 'star' && Math.abs(s.props.geometry.shape.x + s.props.geometry.shape.w / 2 - 700) < 1)
await page.click('[data-shape-type="line"]')
await drag([-300, 200], [-100, 240], { keys: ['Shift'] })
s = await selected()
check('a line snaps to 45° with Shift, and is stroked', s.props.geometry.shape.type === 'line' && Math.abs(s.props.geometry.shape.y2 - s.props.geometry.shape.y1) < 1e-6 && s.props.appearance[0].kind === 'stroke')
await idle()
check('and drawn', near(await at(-200, 200), RED))

// --- fills and strokes -------------------------------------------------------------------
console.log('\nfills and strokes')
const rectId = Object.values((await doc()).nodes).find((n) => n.kind === 'vector' && n.props.geometry.shape?.type === 'rect').id
await pickLayer(rectId)
await frames(page)
await setForeground(0, 0, 255)
await tap('[data-appearance-add="stroke"]')
await frames(page)
s = await selected()
check('+ Stroke adds a stroke on top, in the foreground colour', s.props.appearance.length === 2 && s.props.appearance[1].kind === 'stroke' && (await label()) === 'Appearance')
await setNumber('props-item-1-width', 20)
await idle()
check('a 20 px stroke straddles the edge: blue either side of it', near(await at(-200 - 8, 0), BLUE) && near(await at(-200 + 8, 0), BLUE) && near(await at(-200 + 14, 0), RED))
await page.$eval('#props-item-1-align-outside', (e) => e.click())
await idle()
check('outside, it’s all past the edge', near(await at(-200 - 15, 0), BLUE) && near(await at(-200 + 5, 0), RED))
await page.$eval('#props-item-1-align-inside', (e) => e.click())
await idle()
check('inside, all within it', near(await at(-200 - 5, 0), WHITE) && near(await at(-200 + 15, 0), BLUE))
await tap('[data-appearance-item="0"] .appearance-pick')
await page.$eval('#props-item-0-paint-gradient', (e) => e.click())
await idle()
const top = await at(-100, -80)
const bottom = await at(-100, 80)
check('a fill turned into a gradient runs across the shape, bottom to top at 90°', !near(top, bottom, 30) && bottom[1] < top[1], `${bottom} → ${top}`)
await tap('[data-appearance-item="1"] input[type="checkbox"]')
await idle()
check('a stroke switched off goes from the canvas', !near(await at(-200 + 15, 0), BLUE, 20))
await press('Control+KeyZ')
await idle()
check('and Undo brings it back', near(await at(-200 + 15, 0), BLUE))

// --- the Pen -----------------------------------------------------------------------------
console.log('\nthe Pen')
await press('KeyP')
await setForeground(0, 160, 0)
await clickAt(-300, -250)
await clickAt(-150, -250)
await clickAt(-225, -150)
check('while drawing, nothing is a step yet', (await label()) !== 'New Shape' || (await doc()).nodes[(await selected())?.id]?.props?.geometry?.kind !== 'path')
await clickAt(-300, -250)
check('clicking the first point closes the path: a new shape', (await stepIs('New Shape')) && (await selected()).props.geometry.kind === 'path')
s = await selected()
check('three anchors, closed', s.props.geometry.path.subpaths.length === 1 && s.props.geometry.path.subpaths[0].closed && s.props.geometry.path.subpaths[0].anchors.length === 3)
await idle()
check('filled on the canvas', near(await at(-225, -220), [0, 160, 0]))
// A curve: drag out handles on the second point.
await clickAt(100, -250)
await drag([200, -250], [260, -250])
await clickAt(300, -180)
await press('Enter')
s = await selected()
const curve = s.props.geometry.path.subpaths[0]
check('Enter finishes an open path; a dragged point is smooth, its handles mirrored', (await label()) === 'New Shape' && !curve.closed && curve.anchors.length === 3 && curve.anchors[1].smooth && Math.abs(curve.anchors[1].in[0] - 540) < 1.5 && Math.abs(curve.anchors[1].out[0] - 660) < 1.5)
// Add and delete on the selected path.
const shapes = Object.values((await doc()).nodes).filter((n) => n.kind === 'vector' && n.props.geometry?.kind === 'path')
const triangle = shapes.find((n) => n.props.geometry.path.subpaths[0].anchors.length === 3 && n.props.geometry.path.subpaths[0].closed)
await pickLayer(triangle.id)
await frames(page)
await clickAt(-225, -250)
check('the Pen on the selected path’s segment adds a point there', (await stepIs('Add Anchor Point')) && (await selected()).props.geometry.path.subpaths[0].anchors.length === 4)
await clickAt(-225, -250)
check('and on a point, deletes it', (await stepIs('Delete Anchor Point')) && (await selected()).props.geometry.path.subpaths[0].anchors.length === 3)

// --- Direct Selection --------------------------------------------------------------------
console.log('\nDirect Selection')
await press('KeyA')
await drag([-150, -250], [-120, -270])
s = await selected()
const moved = s.props.geometry.path.subpaths[0].anchors.find((a) => Math.abs(a.p[0] - 280) < 1 && Math.abs(a.p[1] - 30) < 1)
check('dragging a point moves it, one step', (await stepIs('Edit Path')) && !!moved)
check('the options bar says a point is selected', (await page.$eval('[data-anchors]', (e) => Number(e.dataset.anchors))) === 1)
await clickAt(-120, -270, ['Alt'])
s = await selected()
check('Alt-click makes a corner smooth', (await stepIs('Convert Point')) && s.props.geometry.path.subpaths[0].anchors.some((a) => a.smooth && a.in && a.out))
await clickAt(-120, -270)
await press('Delete')
check('Delete takes the selected point away', (await stepIs('Delete Anchor Point')) && (await selected()).props.geometry.path.subpaths[0].anchors.length === 2)
await press('Control+KeyZ')
await clickAt(-100, 0)
check('clicking another shape selects it', (await selected()).id === rectId)
await press('Control+KeyZ')
await press('Control+KeyZ')
await press('Control+KeyZ')

// --- compound shapes ---------------------------------------------------------------------
console.log('\ncompound shapes')
await newDoc()
await setForeground(255, 0, 0)
await press('KeyU')
await page.click('[data-shape-type="rect"]')
await drag([-200, -100], [0, 100])
await drag([-100, -50], [100, 150])
await clickMenu('Layer', 'layer.combine-subtract', 'Combine Shapes')
s = await selected()
check('Subtract Front Shape makes a compound of the two', (await label()) === 'Subtract Front Shape' && s.kind === 'boolean' && s.children.length === 2)
await idle()
check('the front shape cuts the back one: the overlap is empty, the rest red', near(await at(-50, 50), WHITE) && near(await at(-150, 0), RED) && near(await at(50, 120), WHITE))
check('the Layers panel shows the operation', await page.$eval('.layer-op[data-op="subtract"]', () => true).catch(() => false))
const operand = s.children[1]
await pickLayer(operand)
await page.select('#props-bool-op', 'add')
await idle()
check('an operand’s operation changes in Properties', (await label()) === 'Combine Mode' && near(await at(-50, 50), RED) && near(await at(50, 120), RED))
await pickLayer(s.id)
await clickMenu('Layer', 'layer.compound-expand', 'Combine Shapes')
s = await selected()
check('Expand turns it into one path with the combined outline', (await label()) === 'Expand Compound Shape' && s.kind === 'vector' && s.props.geometry.kind === 'path' && s.props.geometry.path.subpaths.length === 1)
await idle()
check('looking the same', near(await at(-50, 50), RED) && near(await at(50, 120), RED) && near(await at(150, -80), WHITE))
await press('Control+KeyZ')
await clickMenu('Layer', 'layer.compound-release', 'Combine Shapes')
check('Release puts the shapes back', (await label()) === 'Release Compound Shape' && Object.values((await doc()).nodes).filter((n) => n.kind === 'vector').length === 2 && !Object.values((await doc()).nodes).some((n) => n.kind === 'boolean'))

// --- vector masks ------------------------------------------------------------------------
console.log('\nvector masks')
await newDoc()
await setForeground(255, 0, 0)
await press('Alt+Backspace')
await idle()
await clickMenu('Layer', 'layer.vmask-hide-all', 'Vector Mask')
await idle()
check('Hide All adds an empty vector mask that hides the layer', (await label()) === 'Add Vector Mask' && !near(await at(0, 0), RED))
check('and makes it what the tools edit', await page.$eval('.layer-part.mask.vector.target', () => true).catch(() => false))
await press('KeyU')
await page.click('[data-shape-type="ellipse"]')
await drag([-100, -100], [100, 100])
await idle()
check('a shape drawn into it shows what’s inside', (await label()) === 'Edit Vector Mask' && near(await at(0, 0), RED) && !near(await at(150, 0), RED))
const layer = Object.values((await doc()).nodes).find((n) => n.kind === 'pixel')
check('and the layer’s pixels are untouched', !!layer.props.tiles)
await tap('[data-props="mask"] input[type="checkbox"]')
await idle()
check('inverted, it hides the inside instead', !near(await at(0, 0), RED) && near(await at(150, 0), RED))

// --- the Pen's editing ----------------------------------------------------------------------
/** A point along segment `k` of a subpath at t, in document pixels. */
const evalPoint = (s, k, t) => {
  const a = s.anchors[k]
  const b = s.anchors[(k + 1) % s.anchors.length]
  const p1 = a.out ?? a.p
  const p2 = b.in ?? b.p
  const u = 1 - t
  return [0, 1].map((i) => u * u * u * a.p[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * b.p[i])
}
console.log('\nthe Curvature tool')
await newDoc()
const shapesNow = async () => Object.values((await doc()).nodes).filter((n) => n.kind === 'vector')
const pathOf = (n) => n.props.geometry.path
await page.evaluate(() => globalThis.plexel.tools().set('curvature'))
for (const [x, y] of [[-150, 50], [0, -80], [150, 50]]) await clickAt(x, y)
await press('Enter')
check('clicks make a path of smooth points, one step', (await stepIs('New Shape')) && (await shapesNow()).length === 1)
let cv = pathOf((await shapesNow())[0]).subpaths[0]
check('the curve runs through them, the middle point’s handles level', cv.anchors.length === 3 && cv.anchors.every((a) => a.smooth) && !!cv.anchors[1].in && Math.abs(cv.anchors[1].in[1] - cv.anchors[1].out[1]) < 1e-6 && cv.anchors[1].out[0] > cv.anchors[1].p[0])
await drag([0, -80], [0, -140])
cv = pathOf((await shapesNow())[0]).subpaths[0]
check('dragging a point moves it, the curve following', (await stepIs('Edit Path')) && Math.abs(cv.anchors[1].p[1] - (300 - 140)) < 1.5 && !!cv.anchors[0].out)
await clickAt(0, -140)
await clickAt(0, -140)
cv = pathOf((await shapesNow())[0]).subpaths[0]
check('a double-click makes a point a corner', (await stepIs('Convert Point')) && !cv.anchors[1].smooth && cv.anchors[1].in === null)
await settle(500)
await clickAt(0, -140)
await clickAt(0, -140)
check('and again, smooth', pathOf((await shapesNow())[0]).subpaths[0].anchors[1].smooth)
// A click on a segment adds a smooth point there.
const seg = evalPoint(pathOf((await shapesNow())[0]).subpaths[0], 0, 0.5)
await clickAt(seg[0] - 400, seg[1] - 300)
check('a click on a segment adds a smooth point', (await stepIs('Add Anchor Point')) && pathOf((await shapesNow())[0]).subpaths[0].anchors.length === 4)

console.log('\nthe Pen’s Smart mode')
await newDoc()
await page.evaluate(() => globalThis.plexel.tools().set('pen'))
await page.click('[data-pen-smart]')
for (const [x, y] of [[-150, 50], [0, -80], [150, 50]]) await clickAt(x, y)
await press('Enter')
const smart = pathOf((await shapesNow())[0]).subpaths[0]
check('Smart: clicks make smooth points with their curves worked out', (await stepIs('New Shape')) && smart.anchors.every((a) => a.smooth) && !!smart.anchors[1].in)
await page.click('[data-pen-smart]')

console.log('\npoints across several shapes')
await newDoc()
await page.evaluate(() => globalThis.plexel.tools().set('pen'))
for (const pts of [[[-200, -50], [-50, -50], [-50, 50]], [[50, -50], [200, -50], [200, 50]]]) {
  for (const [x, y] of pts) await clickAt(x, y)
  await press('Enter')
  await stepIs('New Shape')
}
const [left, right] = await shapesNow()
await press('KeyA')
// A box round the two inner corners, one in each shape.
await drag([-80, -80], [80, -20])
const both = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return { selected: [d.selected, ...d.others].filter(Boolean).length }
})
check('Direct Selection’s box takes points of every shape it reaches, and selects those shapes', both.selected === 2, JSON.stringify(both))
await drag([-50, -50], [-50, -100])
const movedBoth = await shapesNow()
check('a drag moves the points of both shapes, one step', (await stepIs('Edit Paths')) && movedBoth.every((n) => pathOf(n).subpaths[0].anchors.some((a) => Math.abs(a.p[1] - 200) < 1.5)))
await press('Control+KeyZ')
await idle()

console.log('\njoining and breaking')
// The two inner ends: the first path's last point (-50, 50) and the second's first (50, -50).
await clickAt(-50, 50)
await clickAt(50, -50, ['Shift'])
await clickMenu('Layer', 'shape.join', 'Path')
const joined = await shapesNow()
check('Join on two ends of two shapes: one shape, one open path through all six points', (await stepIs('Join')) && joined.length === 1 && pathOf(joined[0]).subpaths.length === 1 && pathOf(joined[0]).subpaths[0].anchors.length === 6 && !pathOf(joined[0]).subpaths[0].closed)
void left
void right
await clickAt(-50, 50)
await clickMenu('Layer', 'shape.break', 'Path')
check('Break at Points cuts it there in two', (await stepIs('Break at Points')) && pathOf((await shapesNow())[0]).subpaths.length === 2)
await clickMenu('Layer', 'shape.separate', 'Path')
check('Separate makes each part a shape of its own', (await stepIs('Separate')) && (await shapesNow()).length === 2)

// --- stroke features ---------------------------------------------------------------------
console.log('\nstroke features')
await newDoc()
await setForeground(0, 0, 255)
await page.evaluate(() => globalThis.plexel.tools().set('pen'))
// Stroked, not filled.
const paintOn = (k) => page.$eval(`[data-shape-paint="${k}"]`, (e) => e.getAttribute('aria-pressed') === 'true')
if (await paintOn('fill')) await page.click('[data-shape-paint="fill"]')
if (!(await paintOn('stroke'))) await page.click('[data-shape-paint="stroke"]')
await clickAt(-200, 0)
await clickAt(200, 0)
await press('Enter')
await stepIs('New Shape')
await idle()
const strokeIndex = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.history.present.nodes[d.selected].props.appearance.findIndex((a) => a.kind === 'stroke')
})
const strokeOf = async () => {
  const d = await page.evaluate(() => {
    const x = globalThis.plexel.documents().active()
    return x.history.present.nodes[x.selected].props.appearance
  })
  return d[strokeIndex]
}
check('the line is stroked, four pixels wide', strokeIndex >= 0 && (await strokeOf()).width === 4)
await page.select(`#props-item-${strokeIndex}-end`, 'triangle')
check('Properties gives the end an arrowhead, one step', (await stepIs('Appearance')) && (await strokeOf()).end?.shape === 'triangle')
await idle()
// The head is four widths long and four wide: 12 px back from the tip, 4 px off the line, it's blue; on the plain line it isn't.
let img = await shot()
check('the head shows at the end, wider than the line', near(await at(200 - 12, 4, img), BLUE, 40) && !near(await at(0, 4, img), BLUE, 40), `${await at(200 - 12, 4, img)} ${await at(0, 4, img)}`)
await page.select(`#props-item-${strokeIndex}-profile`, 'taper-start')
check('a width profile, one step', (await stepIs('Appearance')) && (await strokeOf()).profile?.length === 2)
await idle()
img = await shot()
check('Taper Start: nothing at the start, the full width further on', !near(await at(-196, 0, img), BLUE, 60) && near(await at(100, 0, img), BLUE, 40), `${await at(-196, 0, img)} ${await at(100, 0, img)}`)

console.log('\nScale Strokes')
await newDoc()
await setForeground(0, 0, 255)
await press('KeyU')
await page.click('[data-shape-type="rect"]')
if (await paintOn('fill')) await page.click('[data-shape-paint="fill"]')
if (!(await paintOn('stroke'))) await page.click('[data-shape-paint="stroke"]')
await drag([-50, -50], [50, 50])
await stepIs('New Shape')
const widthNow = () =>
  page.evaluate(() => {
    const d = globalThis.plexel.documents().active()
    return d.history.present.nodes[d.selected].props.appearance.find((a) => a.kind === 'stroke').width
  })
await press('KeyV')
await idle()
await page.click('#opt-scale-strokes')
check('Scale Strokes is in the Move tool’s options, and turns off', !(await page.$eval('#opt-scale-strokes', (e) => e.checked)))
// The bottom-right handle dragged out to twice the size: the stroke made half as wide in the shape's own units.
const w0 = await widthNow()
const half = w0 / 2
await drag([50 + half, 50 + half], [150 + w0, 150 + w0], { steps: 12 })
const w1 = await widthNow()
check('off, scaling a shape keeps its stroke as wide on screen', (await stepIs('Free Transform')) && Math.abs(w1 - w0 / 2) < w0 * 0.1, `${w0} → ${w1}`)
await press('Control+KeyZ')
await page.click('#opt-scale-strokes')
await drag([50 + half, 50 + half], [150 + w0, 150 + w0], { steps: 12 })
check('on, the stroke scales with it, as before', (await stepIs('Free Transform')) && (await widthNow()) === w0)
// The shape tools as the rest of the checks expect them: filled, not stroked.
await press('KeyU')
if (!(await paintOn('fill'))) await page.click('[data-shape-paint="fill"]')
if (await paintOn('stroke')) await page.click('[data-shape-paint="stroke"]')

// --- the transform controls -------------------------------------------------------------
console.log('\nthe transform controls')
await newDoc()
await setForeground(0, 0, 255)
await press('KeyU')
await page.click('[data-shape-type="rect"]')
await drag([-100, -50], [-20, 50])
await drag([20, -50], [100, 50])
const shapeIds = Object.values((await doc()).nodes).filter((n) => n.kind === 'vector').map((n) => n.id)
await press('KeyV')
await page.evaluate((ids) => {
  const P = globalThis.plexel
  P.documents().selectMany(ids, ids[1])
}, shapeIds)
await idle()
const scaleOf = (n) => Math.hypot(n.transform[0], n.transform[1])
// The box round both runs from (-100, -50) to (100, 50); its bottom-right corner dragged out scales both from the top left.
await drag([100, 50], [180, 90])
check('with two shapes selected, the Move tool’s corner handle scales both, one step', await stepIs('Free Transform'))
const after = await doc()
const scales = shapeIds.map((id) => scaleOf(after.nodes[id]))
check('in proportion, about the box’s far corner', scales.every((k) => Math.abs(k - 1.4) < 0.02) && shapeIds.every((id) => Math.abs(after.nodes[id].transform[4] - (-100 + 400) * (1 - 1.4)) < 2), scales.map((k) => k.toFixed(3)).join())
await press('Control+KeyZ')
await idle()
await drag([0, 0], [30, 20])
check('inside the box the Move tool still moves them', await stepIs('Move'))
await press('Control+KeyZ')
await idle()
// Just outside the top-right corner: a turn.
await drag([108, -58], [120, 30], { steps: 12 })
const turned = await doc()
check('just outside a corner, a drag turns them', (await stepIs('Free Transform')) && shapeIds.every((id) => Math.abs(turned.nodes[id].transform[1]) > 0.1), shapeIds.map((id) => turned.nodes[id].transform[1].toFixed(3)).join())
await press('Control+KeyZ')
await idle()
// One shape: its own box; the right edge's handle stretches it alone.
await page.evaluate((id) => globalThis.plexel.documents().select(id), shapeIds[1])
await idle()
await drag([100, 0], [140, 0])
const one = await doc()
check('one shape: its right edge’s handle stretches it across, the other left alone', (await stepIs('Free Transform')) && Math.abs(one.nodes[shapeIds[1]].transform[0] - 1.5) < 0.03 && one.nodes[shapeIds[0]].transform[0] === 1, `${one.nodes[shapeIds[1]].transform[0].toFixed(3)} ${one.nodes[shapeIds[0]].transform[0]}`)
await press('Control+KeyZ')
await idle()
// A pixel layer selected: no controls, so the same press moves it.
await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const pixel = Object.values(d.history.present.nodes).find((n) => n.kind === 'pixel')
  globalThis.plexel.documents().select(pixel.id)
})
await idle()
await drag([100, 50], [120, 60])
check('with a pixel layer selected there are no controls: the press moves it', await stepIs('Move'))

// --- the Width tool --------------------------------------------------------------------------
console.log('\nthe Width tool')
await newDoc()
await setForeground(0, 0, 255)
await page.evaluate(() => globalThis.plexel.tools().set('pen'))
if (await paintOn('fill')) await page.click('[data-shape-paint="fill"]')
if (!(await paintOn('stroke'))) await page.click('[data-shape-paint="stroke"]')
await clickAt(-200, 0)
await clickAt(200, 0)
await press('Enter')
await stepIs('New Shape')
const lineId = await page.evaluate(() => globalThis.plexel.documents().active().selected)
const lineStroke = await page.evaluate((id) => globalThis.plexel.documents().active().history.present.nodes[id].props.appearance.findIndex((a) => a.kind === 'stroke'), lineId)
await setNumber(`props-item-${lineStroke}-width`, 10)
await stepIs('Appearance')
const profileNow = () => page.evaluate(({ id, i }) => globalThis.plexel.documents().active().history.present.nodes[id].props.appearance[i].profile ?? null, { id: lineId, i: lineStroke })
/** The width points as drawn, as offsets from the canvas's centre. */
const widthPoints = () => page.evaluate((id) => globalThis.plexel.width.pointsOf(id).map((w) => ({ point: w.point, c: [w.c[0] - 400, w.c[1] - 300], l: [w.l[0] - 400, w.l[1] - 300], r: [w.r[0] - 400, w.r[1] - 300] })), lineId)
await page.evaluate(() => globalThis.plexel.tools().set('width'))
await idle()
// The stroke's left is towards (−dy, dx): for a line drawn left to right, down the screen.
await drag([0, 3], [0, 13])
let wprof = await profileNow()
check('dragging the stroke adds a width point there and widens both sides, one step', (await stepIs('Add Width Point')) && wprof?.length === 3 && Math.abs(wprof[1].at - 0.5) < 0.01 && Math.abs(wprof[1].left - 3) < 0.15 && Math.abs(wprof[1].right - 3) < 0.15, JSON.stringify(wprof))
await idle()
img = await shot()
check('the stroke is wider there, and as it was near the ends', near(await at(0, 12, img), BLUE, 40) && near(await at(0, -12, img), BLUE, 40) && !near(await at(-185, 12, img), BLUE, 60), `${await at(0, 12, img)} ${await at(-185, 12, img)}`)
let wps = await widthPoints()
const mid = wps.find((w) => Math.abs(w.c[0]) < 1)
check('the point shows across the stroke, its edges where the stroke’s are', !!mid && Math.abs(mid.l[1] - 15) < 0.8 && Math.abs(mid.r[1] + 15) < 0.8, JSON.stringify(mid))
// Alt on an edge: that side only.
await drag(mid.l, [mid.l[0], mid.l[1] + 10], { keys: ['Alt'] })
wprof = await profileNow()
check('Alt-dragging an edge widens that side only', (await stepIs('Edit Width Point')) && Math.abs(wprof[1].left - 5) < 0.15 && Math.abs(wprof[1].right - 3) < 0.15, JSON.stringify(wprof[1]))
await idle()
img = await shot()
check('so the stroke is wider on that side than the other', near(await at(0, 22, img), BLUE, 40) && !near(await at(0, -19, img), BLUE, 60))
// The centre slides along the path.
await drag(mid.c, [100, 0])
wprof = await profileNow()
check('dragging the centre slides the point along the path', (await stepIs('Move Width Point')) && Math.abs(wprof[1].at - 0.75) < 0.01, JSON.stringify(wprof))
// Alt on a centre: a copy.
wps = await widthPoints()
const slid = wps.find((w) => Math.abs(w.c[0] - 100) < 1)
await drag(slid.c, [-100, 0], { keys: ['Alt'] })
wprof = await profileNow()
check('Alt-dragging the centre copies the point', (await stepIs('Copy Width Point')) && wprof.length === 4 && Math.abs(wprof[1].at - 0.25) < 0.01 && Math.abs(wprof[1].left - 5) < 0.15, JSON.stringify(wprof))
// Double-click: Width Point Edit.
await clickAt(...slid.c)
await clickAt(...slid.c)
check('double-clicking a point opens Width Point Edit', !!(await page.waitForSelector('#width-side-1', { timeout: 3000 }).catch(() => null)))
check('it shows each side in pixels', (await page.$eval('#width-side-1', (e) => e.value)) === '25' && (await page.$eval('#width-side-2', (e) => e.value)) === '15' && (await page.$eval('#width-total', (e) => e.value)) === '40')
await typeInto('#width-side-1', '20')
wprof = await profileNow()
check('its OK sets the widths', (await stepIs('Edit Width Point')) && Math.abs(wprof[2].left - 4) < 1e-6 && Math.abs(wprof[2].right - 3) < 1e-6 && !(await page.$('#width-side-1')), JSON.stringify(wprof))
// Shift-click two points, Delete takes both away.
wps = await widthPoints()
const c1 = wps.find((w) => Math.abs(w.c[0] + 100) < 1).c
const c2 = wps.find((w) => Math.abs(w.c[0] - 100) < 1).c
await settle(500)
await clickAt(...c1)
await clickAt(...c2, ['Shift'])
check('Shift-click selects a second point', (await page.evaluate(() => globalThis.plexel.width.selection.points.length)) === 2)
await press('Delete')
check('Delete removes the selected points, and a profile left all full width is none', (await stepIs('Delete Width Points')) && (await profileNow()) === null)
await press('Control+KeyZ')
check('undo brings them back', (await profileNow())?.length === 4)
// A stroked shape not selected: the tool reaches it, and selects it.
await page.evaluate(() => globalThis.plexel.documents().select(null))
await idle()
await drag([-150, 2], [-150, 8])
check('the tool works on a stroked shape that isn’t selected, and selects it', (await stepIs('Add Width Point')) && (await page.evaluate(() => globalThis.plexel.documents().active().selected)) === lineId)

console.log('\nProperties: flips and saved profiles')
await page.select(`#props-item-${lineStroke}-profile`, 'taper-start')
await stepIs('Appearance')
await tap(`#props-item-${lineStroke}-profile-flip-along`)
check('Flip Along turns Taper Start into Taper End', (await page.$eval(`#props-item-${lineStroke}-profile`, (e) => e.value)) === 'taper-end')
await page.select(`#props-item-${lineStroke}-profile`, 'bulge')
await idle()
await page.evaluate(() => globalThis.plexel.tools().set('width'))
wps = await widthPoints()
const bulgeMid = wps.find((w) => Math.abs(w.c[0]) < 1)
await drag(bulgeMid.l, [bulgeMid.l[0], bulgeMid.l[1] + 6], { keys: ['Alt'] })
await stepIs('Edit Width Point')
check('edited by hand, the profile is Custom', (await page.$eval(`#props-item-${lineStroke}-profile`, (e) => e.value)) === 'custom')
await tap(`#props-item-${lineStroke}-profile-flip-across`)
wprof = await profileNow()
check('Flip Across swaps the sides', wprof[1].right > wprof[1].left + 0.5, JSON.stringify(wprof[1]))
await tap(`#props-item-${lineStroke}-profile-save`)
await typeInto(`#props-item-${lineStroke}-profile-name`, 'Lopsided')
const savedNames = await page.evaluate(() => [...document.querySelectorAll(`[id$="-profile"] option`)].map((o) => o.textContent))
check('Save keeps it by a name, listed after the presets, and chosen', savedNames.includes('Lopsided') && (await page.$eval(`#props-item-${lineStroke}-profile`, (e) => e.selectedOptions[0].textContent)) === 'Lopsided')
await page.select(`#props-item-${lineStroke}-profile`, 'uniform')
await stepIs('Appearance')
const lop = await page.evaluate(() => [...document.querySelector('[id$="-profile"]').options].find((o) => o.textContent === 'Lopsided').value)
await page.select(`#props-item-${lineStroke}-profile`, lop)
check('choosing it gives the stroke its points', JSON.stringify(await profileNow()) === JSON.stringify(wprof))
await tap(`#props-item-${lineStroke}-profile-forget`)
check('Forget takes it out of the list, the stroke keeps it', !(await page.evaluate(() => [...document.querySelector('[id$="-profile"]').options].some((o) => o.textContent === 'Lopsided'))) && JSON.stringify(await profileNow()) === JSON.stringify(wprof))

// The shape tools as the rest of the checks expect them: filled, not stroked.
await press('KeyU')
if (!(await paintOn('fill'))) await page.click('[data-shape-paint="fill"]')
if (await paintOn('stroke')) await page.click('[data-shape-paint="stroke"]')

// --- vector brushes --------------------------------------------------------------------------
console.log('\nvector brushes')
await newDoc()
await setForeground(0, 0, 255)
await page.evaluate(() => globalThis.plexel.tools().set('pen'))
if (await paintOn('fill')) await page.click('[data-shape-paint="fill"]')
if (!(await paintOn('stroke'))) await page.click('[data-shape-paint="stroke"]')
await clickAt(-200, 0)
await clickAt(200, 0)
await press('Enter')
await stepIs('New Shape')
const brushLine = await page.evaluate(() => globalThis.plexel.documents().active().selected)
const brushStroke = await page.evaluate((id) => globalThis.plexel.documents().active().history.present.nodes[id].props.appearance.findIndex((a) => a.kind === 'stroke'), brushLine)
await setNumber(`props-item-${brushStroke}-width`, 12)
await stepIs('Appearance')
const strokeNow = () => page.evaluate(({ id, i }) => globalThis.plexel.documents().active().history.present.nodes[id]?.props.appearance[i] ?? null, { id: brushLine, i: brushStroke })
await clickMenu('Window', 'window.panel.vector-brushes')
await page.waitForSelector('[data-vector-brush="builtin:ribbon"]')
check('the Vector Brushes panel lists the built-in brushes, each drawn', (await page.$$eval('[data-vector-brush^="builtin:"] .brush-preview path', (e) => e.length)) >= 9)
await tap('[data-vector-brush="builtin:ribbon"] .brush-apply')
check('clicking one strokes the selected shape with it, one step', (await stepIs('Apply Ribbon')) && (await strokeNow()).brush?.id === 'builtin:ribbon')
await idle()
let bimg = await shot()
// The ribbon is 20 high as drawn, 12 on the path: bands above and below the middle, Hue Shift turning its red to the stroke's blue.
const above = await at(0, -3, bimg)
const below = await at(0, 3, bimg)
check('the artwork draws along the path, its two bands in two blues', !near(above, WHITE, 30) && !near(below, WHITE, 30) && !near(above, below, 20) && above[2] > above[0] && below[2] > below[0], `${above} ${below}`)
check('as high as the stroke is wide', near(await at(0, 9, bimg), WHITE, 10) && near(await at(0, -9, bimg), WHITE, 10))
check('Properties shows the brush', (await page.$eval(`#props-item-${brushStroke}-brush`, (e) => e.value)) === 'builtin:ribbon')
// Brush Options: its own colours, and the strokes drawn with it changed.
await tap('[data-brush-options="builtin:ribbon"]')
await page.waitForSelector('#brush-colorize')
await page.select('#brush-colorize', 'none')
check('Brush Options offers to change the stroke drawn with it', await page.$eval('#brush-restroke', (e) => e.checked))
await page.click('[data-dialog="brushOptions"] .dialog-foot .primary')
check('OK keeps the brush in the document, and changes the stroke, one step', (await stepIs('Brush Options')) && (await page.evaluate(() => globalThis.plexel.documents().active().history.present.vectorBrushes?.[0]?.colorize)) === 'none' && (await strokeNow()).brush.colorize === 'none')
await idle()
check('the ribbon in its own red now', near(await at(0, -3), [219, 38, 51], 40), String(await at(0, -3)))
await press('Control+KeyZ')
check('undo puts the brush back as it was', (await strokeNow()).brush.colorize === 'hue-shift')
// A new brush from the selected shapes: a red square becomes a scatter brush.
await press('KeyU')
await page.click('[data-shape-type="rect"]')
if (!(await paintOn('fill'))) await page.click('[data-shape-paint="fill"]')
if (await paintOn('stroke')) await page.click('[data-shape-paint="stroke"]')
await setForeground(255, 0, 0)
await drag([150, 150], [170, 170])
await stepIs('New Shape')
await page.select('[data-vector-brushes="kind"]', 'scatter')
await tap('[data-vector-brushes="new"]')
check('New from Selection makes a scatter brush of the selected shape, one step', (await stepIs('New Brush')) && (await page.evaluate(() => globalThis.plexel.documents().active().history.present.vectorBrushes?.some((b) => b.kind === 'scatter' && b.art.parts.length === 1))))
check('and opens its Brush Options', (await page.waitForSelector('#brush-size-lo', { timeout: 3000 }).catch(() => null)) !== null && (await page.$eval('#brush-name', (e) => e.value)) === 'Scatter Brush 1')
await page.click('[data-dialog="brushOptions"] .dialog-foot .primary')
await stepIs('Brush Options')
await page.evaluate((id) => globalThis.plexel.documents().select(id), brushLine)
await idle()
const scatterId = await page.evaluate(() => globalThis.plexel.documents().active().history.present.vectorBrushes.find((b) => b.kind === 'scatter').id)
await tap(`[data-vector-brush="${scatterId}"] .brush-apply`)
await stepIs('Apply Scatter Brush 1')
await idle()
bimg = await shot()
const reds = []
for (let x = -190; x <= 190; x += 4) reds.push(near(await at(x, 0, bimg), [255, 0, 0], 40))
check('the line is drawn with red squares along it, spaced', reds.filter(Boolean).length > 20 && reds.filter((r) => !r).length > 10, `${reds.filter(Boolean).length} red of ${reds.length}`)
// Properties: none makes it a plain stroke again.
await page.select(`#props-item-${brushStroke}-brush`, 'none')
check('Brush: None in Properties makes it a plain stroke', (await stepIs('Appearance')) && !(await strokeNow()).brush)
await page.select(`#props-item-${brushStroke}-brush`, 'builtin:railroad')
await stepIs('Appearance')
await clickMenu('Layer', 'shape.brush-remove', 'Brushes')
check('Layer → Brushes → Remove Brush Stroke', (await stepIs('Remove Brush Stroke')) && !(await strokeNow()).brush)
await tap('[data-vector-brush="builtin:ribbon"] .brush-apply')
await stepIs('Apply Ribbon')
await clickMenu('Layer', 'shape.outline-stroke', 'Path')
const outlined = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const g = d.history.present.nodes[d.selected]
  return { kind: g.kind, kids: (g.children ?? []).map((c) => d.history.present.nodes[c].kind) }
})
check('Outline Stroke makes the brush’s parts shapes, grouped', (await stepIs('Outline Stroke')) && outlined.kind === 'group' && outlined.kids.length === 3 && outlined.kids.every((k) => k === 'vector'), JSON.stringify(outlined))
await idle()
check('looking the same', !near(await at(0, -3), WHITE, 30))
// The shape tools as the rest of the checks expect them: filled, not stroked.
await press('KeyU')
if (!(await paintOn('fill'))) await page.click('[data-shape-paint="fill"]')
if (await paintOn('stroke')) await page.click('[data-shape-paint="stroke"]')

// --- colour chips ------------------------------------------------------------------------------
console.log('\ncolour chips')
await newDoc()
await setForeground(255, 0, 0)
await press('KeyU')
await page.click('[data-shape-type="rect"]')
await drag([-60, -60], [60, 60])
await stepIs('New Shape')
const fillNow = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.history.present.nodes[d.selected].props.appearance.find((a) => a.kind === 'fill').paint.colour
})
check('there’s no Use Foreground button any more: the fill’s colour is a chip', !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Use Foreground/.test(b.textContent)))) && !!(await page.$('[data-param-colour]')))
await tap('[data-param-colour]')
check('the chip opens a colour picker', !!(await page.waitForSelector('[data-colour-picker]', { timeout: 3000 }).catch(() => null)))
await page.$eval('[data-picker-hex]', (e) => {
  e.focus()
  e.select()
})
await page.keyboard.type('2060c0')
await page.keyboard.press('Enter')
await frames(page)
let fc = await fillNow()
check('its hex code sets the fill', fc.map((v) => Math.round(v * 255)).join() === '32,96,192', fc.join())
// A drag across the square: the colour follows, one step in the history.
const stepsBefore = await page.evaluate(() => globalThis.plexel.documents().active().history.labels.length)
const sq = await page.$eval('[data-picker-square]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
await page.mouse.move(sq.x + sq.w * 0.2, sq.y + sq.h * 0.2)
await page.mouse.down()
await page.mouse.move(sq.x + sq.w * 0.9, sq.y + sq.h * 0.1, { steps: 10 })
await page.mouse.up()
await frames(page)
fc = await fillNow()
const stepsAfter = await page.evaluate(() => globalThis.plexel.documents().active().history.labels.length)
check('dragging in the square changes it as it goes, as one step', fc[2] > 0.8 && fc[0] < 0.3 && stepsAfter - stepsBefore === 0, `${fc.map((v) => v.toFixed(2))} steps +${stepsAfter - stepsBefore}`)
await tap('[data-colour-picker] [data-pick="fg"]')
fc = await fillNow()
check('its foreground chip takes the foreground', fc.map((v) => Math.round(v * 255)).join() === '255,0,0', fc.join())
await page.mouse.click(5, 450)
await frames(page)
check('a click elsewhere closes it', !(await page.$('[data-colour-picker]')))
await press('Control+KeyZ')
fc = await fillNow()
check('one undo takes the fill back to the red it was drawn with, every picker change one step', fc.map((v) => Math.round(v * 255)).join() === '255,0,0' && (await label()) === 'New Shape', fc.join())

// --- Image Trace ---------------------------------------------------------------------------------
console.log('\nImage Trace')
await newDoc()
// A black square painted on the background, which is white.
await setForeground(0, 0, 0)
await press('KeyM')
await drag([-100, -80], [60, 80])
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await press('Control+KeyD')
await idle()
const bgId = await page.evaluate(() => globalThis.plexel.documents().active().selected)
await clickMenu('Layer', 'layer.image-trace')
check('Layer → Image Trace opens its dialog beside the canvas', !!(await page.waitForSelector('[data-dialog="imageTrace"]', { timeout: 5000 }).catch(() => null)))
await waitUntil(page, () => /paths ·/.test(document.querySelector('[data-trace-stats]')?.textContent ?? ''), { timeout: 20000 })
const stats = await page.$eval('[data-trace-stats]', (e) => e.textContent)
check('it traces the layer at once and counts what it made: two colours', /2 colours/.test(stats), stats)
check('the canvas shows the trace before it’s committed', (await label()) === 'Deselect')
await page.click('[data-trace-ok]')
const traced = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const doc = d.history.present
  const g = doc.nodes[d.selected]
  return { label: d.history.label, kind: g.kind, kids: (g.children ?? []).map((c) => ({ name: doc.nodes[c].name, kind: doc.nodes[c].kind, fill: doc.nodes[c].props.appearance[0].paint.colour })), hidden: doc.nodes[Object.values(doc.nodes).find((n) => n.kind === 'pixel').id].visible === false }
})
check('Trace makes a group of shapes, one per colour, one step', traced.label === 'Image Trace' && traced.kind === 'group' && traced.kids.length === 2 && traced.kids.every((k) => k.kind === 'vector'), JSON.stringify(traced))
check('the black one black, the white one white, in the document’s colours', traced.kids.some((k) => k.name === 'Black' && k.fill.every((v) => v < 0.01)) && traced.kids.some((k) => k.name === 'White' && k.fill.every((v) => v > 0.99)))
check('the image hidden', traced.hidden)
await idle()
check('drawn where the pixels were: black inside the square, white outside it', near(await at(-20, 0), [0, 0, 0], 10) && near(await at(120, 0), WHITE, 10) && near(await at(-99, -79), [0, 0, 0], 40))
const blackPath = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const doc = d.history.present
  const b = (doc.nodes[d.selected].children ?? []).map((c) => doc.nodes[c]).find((n) => n.name === 'Black')
  return b.props.geometry.path.subpaths.map((sp) => sp.anchors.length)
})
check('the square is four corners', blackPath.length === 1 && blackPath[0] === 4, JSON.stringify(blackPath))
await press('Control+KeyZ')
check('undo takes it back, the image showing again', await page.evaluate((id) => globalThis.plexel.documents().active().history.present.nodes[id]?.visible !== false && !Object.values(globalThis.plexel.documents().active().history.present.nodes).some((n) => n.name?.startsWith('Image Trace')), bgId))

// --- the freehand tools ---------------------------------------------------------------------------
console.log('\nthe freehand tools')
await newDoc()
await setForeground(0, 0, 255)
/** A stroke through offsets from the canvas's centre. */
const fstroke = async (pts) => {
  const first = await pointAt(...pts[0])
  await page.mouse.move(...first)
  await page.mouse.down()
  for (const p of pts.slice(1)) await page.mouse.move(...(await pointAt(...p)), { steps: 3 })
  await page.mouse.up()
  await settle(120)
}
const vshapes = () => page.evaluate(() => Object.values(globalThis.plexel.documents().active().history.present.nodes).filter((n) => n.kind === 'vector'))
await press('KeyN')
check('N chooses the Pencil', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'pencil')
await press('Shift+KeyN')
check('Shift+N goes on to the Paintbrush, in the same toolbar slot', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'vbrush' && (await page.$eval('[data-tool-slot="pencil"]', (b) => b.dataset.tool)) === 'vbrush')
await page.evaluate(() => globalThis.plexel.tools().set('pencil'))
// A wavy line, freehand.
const wave = Array.from({ length: 25 }, (_, i) => [-240 + i * 20, 40 * Math.sin(i / 4) - 150])
await fstroke(wave)
let fall = await vshapes()
let pencil = fall.at(-1)
check('the Pencil draws a path as the hand goes, one step', (await label()) === 'Pencil' && fall.length === 1 && !pencil.props.geometry.path.subpaths[0].closed && pencil.props.appearance.some((a) => a.kind === 'stroke'))
check('smoothed into a few curves', pencil.props.geometry.path.subpaths[0].anchors.length <= 10, String(pencil.props.geometry.path.subpaths[0].anchors.length))
await idle()
check('stroked in the foreground colour', near(await at(...wave[12]), BLUE, 60), String(await at(...wave[12])))
// Back to where it began: closed.
const ring = Array.from({ length: 33 }, (_, i) => [150 + 60 * Math.cos((i / 32) * Math.PI * 2), 120 + 60 * Math.sin((i / 32) * Math.PI * 2)])
await fstroke(ring)
fall = await vshapes()
check('a stroke that ends where it began closes the path', fall.length === 2 && fall.at(-1).props.geometry.path.subpaths[0].closed)
// Redrawing the selected path: a hump drawn over the middle of the wave.
await page.evaluate((id) => globalThis.plexel.documents().select(id), pencil.id)
const hump = Array.from({ length: 11 }, (_, i) => [wave[8][0] + i * 8, wave[8][1] + (i === 0 || i === 10 ? 0 : -60 * Math.sin((i / 10) * Math.PI))])
hump[10] = [wave[12][0], wave[12][1]]
await fstroke(hump)
fall = await vshapes()
const reshaped = fall.find((n) => n.id === pencil.id)
const ys = reshaped.props.geometry.path.subpaths[0].anchors.map((a) => a.p[1])
check('a stroke from the selected path back to it redraws that part, one step', (await label()) === 'Reshape Path' && fall.length === 2, JSON.stringify(ys.map(Math.round)))
await idle()
// The hump's top is drawn now; the wave's own line under it isn't.
const humpTop = hump[5]
const shotNow = await shot()
/** Whether any pixel within 7 above or below is blue: a smoothed curve can lie a few pixels off the hand. */
const blueNear = async (x, y) => {
  for (let dy = -7; dy <= 7; dy++) if (near(await at(x, y + dy, shotNow), BLUE, 90)) return true
  return false
}
check('the redrawn part is where it was drawn, the old part gone', (await blueNear(humpTop[0], humpTop[1])) && !(await blueNear(wave[10][0], wave[10][1])))
// The Paintbrush with a brush.
await page.evaluate(() => globalThis.plexel.tools().set('vbrush'))
await page.evaluate(() => globalThis.plexel.documents().select(null))
await page.select('#opt-freehand-brush', 'builtin:ribbon')
await page.$eval('#opt-freehand-width', (e) => {
  e.focus()
  e.select()
})
await page.keyboard.type('16')
await page.keyboard.press('Enter')
await fstroke([[-240, 150], [-100, 170], [40, 150], [180, 170]])
fall = await vshapes()
const painted = fall.at(-1)
check('the Paintbrush paints a path stroked with the chosen brush, as wide as asked', (await label()) === 'Paintbrush' && painted.props.appearance.find((a) => a.kind === 'stroke').brush?.id === 'builtin:ribbon' && painted.props.appearance.find((a) => a.kind === 'stroke').width === 16)
await idle()
check('its artwork drawn along it', !near(await at(-100, 166), WHITE, 30), String(await at(-100, 166)))
// The Blob Brush: filled shapes that join.
await page.evaluate(() => globalThis.plexel.tools().set('blob'))
await setForeground(255, 0, 0)
const blobReds = async () => (await vshapes()).filter((n) => n.props.appearance.length === 1 && n.props.appearance[0].kind === 'fill' && n.props.appearance[0].paint.colour[0] > 0.99 && n.props.appearance[0].paint.colour[1] < 0.01)
await fstroke([[-60, -40], [0, -30], [60, -40]])
check('the Blob Brush paints a filled shape, one step', (await label()) === 'Blob Brush' && (await blobReds()).length === 1)
await idle()
check('in the foreground colour, as wide as its size', near(await at(0, -32), [255, 0, 0], 40) && near(await at(0, -32 + 20), WHITE, 30))
await fstroke([[0, -80], [5, -30], [0, 20]])
check('a stroke across it joins it: still one shape', (await label()) === 'Blob Brush' && (await blobReds()).length === 1)
await fstroke([[200, -60], [240, -60]])
check('one that doesn’t touch it is a shape of its own', (await blobReds()).length === 2)
await press('BracketRight')
check('] makes it larger', (await page.$eval('#opt-freehand-size', (e) => Number(e.value))) > 20)

// --- transforms and Rasterize ------------------------------------------------------------
console.log('\ntransforms and Rasterize')
await newDoc()
await setForeground(0, 0, 255)
await press('KeyU')
await page.click('[data-shape-type="rect"]')
await drag([-100, -100], [100, 100])
await press('Control+Alt+KeyT')
check('Free Transform starts on a shape', (await page.evaluate(() => !!document.querySelector('[data-options="transform"]'))))
await press('Escape')
await clickMenu('Layer', 'layer.rasterize')
await idle()
s = await selected()
check('Rasterize makes a shape a pixel layer that looks the same', (await label()) === 'Rasterize' && s.kind === 'pixel' && !!s.props.tiles && near(await at(0, 0), BLUE) && near(await at(150, 0), WHITE))

await finish()
