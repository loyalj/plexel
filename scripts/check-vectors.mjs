/**
 * Vectors in Chrome, end to end, through the real pointer, keys, menus and
 * panels: the Shape tool and its live shapes, edited in Properties; fills
 * and strokes in the appearance stack, with gradients; the Pen drawing and
 * closing paths, adding and deleting points; Direct Selection moving,
 * converting and deleting them; compound shapes made, released and
 * expanded; vector masks; Free Transform and Rasterize on shapes; undo.
 *
 * Documents are 800 × 600 at 100%, so an offset from the canvas's centre is
 * one from the document's centre (400, 300).
 *
 * Run with: npm run check:vectors
 */
import { check, finish, frames, open, settle, waitUntil, waitForEngine } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const press = async (combo) => {
  const keys = combo.split('+')
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k)
  await page.keyboard.press(keys[keys.length - 1])
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k)
  await frames(page)
}
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
await page.select('#props-item-1-align', 'outside')
await idle()
check('outside, it’s all past the edge', near(await at(-200 - 15, 0), BLUE) && near(await at(-200 + 5, 0), RED))
await page.select('#props-item-1-align', 'inside')
await idle()
check('inside, all within it', near(await at(-200 - 5, 0), WHITE) && near(await at(-200 + 15, 0), BLUE))
await tap('[data-appearance-item="0"] .appearance-pick')
await page.select('#props-item-0-paint', 'gradient')
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
