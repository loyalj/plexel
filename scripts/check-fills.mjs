/**
 * Fills, gradients and the selection tools of phase 14 in Chrome, end to
 * end, through the real menus, keys and pointer: Edit → Fill with its
 * contents and blending, Define Pattern and filling with it, fill layers,
 * the Gradient tool (live on a fill layer, and into pixels), the Paint
 * Bucket and content-aware fill; then Quick Selection, the Magnetic Lasso,
 * Colour Range, Grow and Similar, Border and Smooth, Transform Selection,
 * Save and Load Selection with the Channels panel, and Select and Mask's
 * edge detection.
 *
 * Documents are 800 × 600 at 100%, so a pixel on screen is a document
 * pixel, and an offset from the canvas's centre is one from the
 * document's centre (400, 300).
 *
 * Run with: npm run check:fills
 */
import { check, dialogShown, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

// --- helpers (as check-tools.mjs's) ------------------------------------------------------
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
const { idle } = pageHelpers(page)
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (dx, dy, img) => {
  const r = await rect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const stepIs = (l, timeout = 8000) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout }).then(() => true, () => false)
const bounds = () =>
  page.evaluate(async () => {
    const s = globalThis.plexel.documents().active().history.present.selection
    return s ? globalThis.plexel.engine().call('select.bounds', { set: s.tiles }) : null
  })
const boundsNear = (b, want, tol = 3) => !!b && b.every((v, i) => Math.abs(v - want[i]) <= tol)
const drag = async (from, to, { keys = [], steps: n = 10 } = {}) => {
  const r = await rect()
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(cx + from[0], cy + from[1])
  await page.mouse.down()
  await page.mouse.move(cx + to[0], cy + to[1], { steps: n })
  await page.mouse.up()
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(100)
}
const clickAt = async (dx, dy, keys = []) => {
  const r = await rect()
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.click(r.x + r.w / 2 + dx, r.y + r.h / 2 + dy)
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(60)
}
const moveTo = async (dx, dy, n = 6) => {
  const r = await rect()
  await page.mouse.move(r.x + r.w / 2 + dx, r.y + r.h / 2 + dy, { steps: n })
  await settle(30)
}
const setForeground = async (r, g, b) => {
  await page.click('[data-model="rgb"]')
  for (const [l, v] of Object.entries({ R: r, G: g, B: b })) {
    await page.click(`.colour-number[data-channel="${l}"]`, { clickCount: 3 })
    await page.keyboard.type(String(v))
    await page.keyboard.press('Enter')
  }
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
const tool = (id) => page.evaluate((t) => globalThis.plexel.tools().set(t), id)
const marquee = async (from, to) => {
  await tool('marquee')
  await drag(from, to)
  await stepIs('Rectangular Marquee')
}
const dialogSubmit = async (id) => {
  await page.click(`[data-dialog="${id}"] .dialog-foot .primary`)
  await waitUntil(page, (x) => !document.querySelector(`[data-dialog="${x}"]`), { args: [id] })
}
/** A red square from (-100, -100) to (100, 100) on the white background. */
const redSquare = async () => {
  await setForeground(255, 0, 0)
  await marquee([-100, -100], [100, 100])
  await press('Alt+Backspace')
  await stepIs('Fill with Foreground')
  await press('Control+KeyD')
  await idle()
}
const RED = [255, 0, 0]
const WHITE = [255, 255, 255]

// --- Edit → Fill ---------------------------------------------------------------------------
console.log('\nEdit → Fill')
await newDoc()
await marquee([-200, -100], [0, 100])
await press('Shift+F5')
check('Shift+F5 opens Fill', await dialogShown(page, 'fill'))
await page.select('#fill-contents', 'black')
await page.select('#fill-blend', 'multiply')
await page.click('#fill-opacity', { clickCount: 3 })
await page.keyboard.type('50')
await dialogSubmit('fill')
check('Black in Multiply at 50% is one step', await stepIs('Fill with Black'))
await idle()
check('it fills the selection half dark, and nothing outside', near(await at(-100, 0), [128, 128, 128], 8) && near(await at(100, 0), WHITE))
await press('Control+KeyZ')
await idle()

// --- Define Pattern and fill with it ------------------------------------------------------------
console.log('\nDefine Pattern')
await press('Control+KeyD')
await setForeground(0, 0, 255)
await marquee([-400, -300], [-380, -280])
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await marquee([-400, -300], [-360, -260])
await clickMenu('Edit', 'edit.define-pattern')
await page.waitForSelector('#pattern-name')
await dialogSubmit('definePattern')
check('Define Pattern keeps a pattern in the document, one repeat of the selection', await stepIs('Define Pattern'))
const pats = (await doc()).patterns ?? []
check('40 × 40, named', pats.length === 1 && pats[0].width === 40 && pats[0].height === 40 && /Pattern 1/.test(pats[0].name), JSON.stringify(pats))
await marquee([0, -100], [200, 100])
await press('Shift+F5')
await page.select('#fill-contents', 'pattern')
await dialogSubmit('fill')
check('Fill with Pattern', await stepIs('Fill with Pattern'))
await idle()
{
  const img = await shot()
  // The repeat: blue for 20 pixels, white for 20, every 40 from the document's corner.
  const a = await at(10, -100 + 5, img)
  const b = await at(10 + 40, -100 + 5, img)
  const c = await at(10 + 20, -100 + 5, img)
  check('the pattern repeats every 40 pixels from the document’s corner', near(a, b) && !near(a, c), `${a} ${b} ${c}`)
}
await press('Control+KeyD')

// --- fill layers ---------------------------------------------------------------------------------
console.log('\nfill layers')
await setForeground(0, 160, 0)
await clickMenu('Layer', 'layer.fill-solid', 'New Fill Layer')
check('Layer → New Fill Layer → Solid Colour makes a fill layer', await stepIs('New Colour Fill Layer'))
await idle()
const fl = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.history.present.nodes[d.selected]
})
check('a fill layer of the foreground, chosen', fl?.kind === 'fill' && fl.props.paint.kind === 'solid')
check('it covers the canvas', near(await at(-300, 200), [0, 160, 0]) && near(await at(300, -200), [0, 160, 0]))
check('Properties edits its paint', !!(await page.$('[data-props="fill"] #props-fill-paint')))
await page.$eval('#props-fill-paint-gradient', (e) => e.click())
check('switching it to a gradient is one step', await stepIs('Fill Layer'))
await idle()
{
  // A new gradient runs down the canvas (90°), as Photoshop's Gradient Fill does.
  const t = await at(0, -290)
  const b = await at(0, 290)
  check('a gradient fill layer runs across the canvas', !near(t, b, 30), `${t} ${b}`)
}

// --- the Gradient tool ---------------------------------------------------------------------------
console.log('\nthe Gradient tool')
await press('KeyG')
check('G chooses the Gradient tool, with its options', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'gradient' && !!(await page.$('[data-options="gradient"] [data-gradient-type="linear"]')))
await drag([-200, 0], [200, 0])
check('on a gradient fill layer the drag moves its ends, live', await stepIs('Gradient'))
const line = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.history.present.nodes[d.selected].props.paint.line
})
check('the line is where it was dragged', !!line && Math.abs(line[0] - 200) < 2 && Math.abs(line[2] - 600) < 2, JSON.stringify(line))
await idle()
{
  const img = await shot()
  check('left of the start the first colour, right of the end the last', near(await at(-300, 0, img), [0, 160, 0], 10) && !near(await at(300, 0, img), [0, 160, 0], 40))
}
// A new one, as a layer.
await page.click('.layer-row:last-child .layer-name')
await setForeground(255, 255, 0)
await page.evaluate(() => globalThis.plexel.fillTools().update('gradient', { makes: 'layer', type: 'radial' }))
await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const bg = d.history.present.nodes[d.history.present.root].children[0]
  globalThis.plexel.documents().select(bg)
})
await drag([0, 0], [100, 0])
check('elsewhere it makes a gradient fill layer', await stepIs('New Gradient Fill Layer'))
const made = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const n = d.history.present.nodes[d.selected]
  return { kind: n.kind, type: n.props.paint?.type, line: n.props.paint?.line }
})
check('radial, along the line dragged', made.kind === 'fill' && made.type === 'radial' && Math.abs(made.line[0] - 400) < 2 && Math.abs(made.line[2] - 500) < 2, JSON.stringify(made))
await press('Control+KeyZ')
await press('Control+KeyZ')
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()
// Into pixels, through a selection.
await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const bg = d.history.present.nodes[d.history.present.root].children[0]
  globalThis.plexel.documents().select(bg)
})
await page.evaluate(() => globalThis.plexel.fillTools().update('gradient', { makes: 'pixels', type: 'linear', preset: 'black-white' }))
await marquee([-300, 150], [300, 250])
await tool('gradient')
await drag([-300, 200], [300, 200])
check('set to pixels, it lays the gradient into the layer as one step', await stepIs('Gradient'))
await idle()
{
  const img = await shot()
  const l = await at(-280, 200, img)
  const m = await at(0, 200, img)
  const r = await at(280, 200, img)
  check('dark to light along the drag, inside the selection', l[0] < 30 && Math.abs(m[0] - 128) < 14 && r[0] > 225, `${l} ${m} ${r}`)
  check('and nothing outside it', near(await at(0, 270, img), WHITE))
}
await press('Control+KeyD')

// --- the Paint Bucket -----------------------------------------------------------------------------
console.log('\nthe Paint Bucket')
await newDoc()
await redSquare()
await setForeground(0, 0, 255)
await tool('bucket')
check('the Paint Bucket has its options', !!(await page.$('[data-options="bucket"] [data-bucket="contiguous"]')))
await clickAt(0, 0)
check('a click fills what’s like it', await stepIs('Paint Bucket'))
await idle()
check('the square is blue now, and the white round it still white', near(await at(0, 0), [0, 0, 255]) && near(await at(95, 95), [0, 0, 255]) && near(await at(150, 0), WHITE))

// --- content-aware fill -------------------------------------------------------------------------
console.log('\ncontent-aware fill')
await newDoc()
// Stripes 10 pixels wide, then a red blot in them.
await setForeground(0, 0, 0)
for (let x = -400; x < 400; x += 20) {
  await page.evaluate(
    async (x0) => {
      const p = globalThis.plexel
      const d = p.documents().active()
      const doc = d.history.present
      const set = await p.engine().call('select.shape', { width: doc.width, height: doc.height, shape: { kind: 'rect', x0: x0 + 400, y0: 0, x1: x0 + 410, y1: 600 }, antialias: false, feather: 0, op: 'add', current: doc.selection?.tiles ?? null })
      p.documents().commit((x) => ({ ...x, selection: set ? { tiles: set, path: null } : null }), { label: 'Stripes' })
    },
    x,
  )
}
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await press('Control+KeyD')
await setForeground(255, 0, 0)
await marquee([-30, -30], [30, 30])
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await idle()
check('the blot is there', near(await at(0, 0), RED))
await press('Shift+F5')
await page.select('#fill-contents', 'content-aware')
await dialogSubmit('fill')
check('Content-Aware fills the selection as one step', await stepIs('Content-Aware Fill', 30000))
await idle()
{
  const img = await shot()
  let red = 0
  let stripes = 0
  for (let x = -25; x < 25; x++) {
    const c = await at(x, 0, img)
    if (c[0] > 150 && c[1] < 80) red++
    const want = Math.floor((x + 400) / 10) % 2 === 0 ? 0 : 255
    if (Math.abs(c[1] - want) < 60) stripes++
  }
  check('no red is left, and the stripes run on through', red === 0 && stripes > 40, `${red} red, ${stripes}/50 like the stripes`)
}
await press('Control+KeyD')

// --- Quick Selection ---------------------------------------------------------------------------
console.log('\nQuick Selection')
await newDoc()
await redSquare()
await press('KeyW')
check('W chooses Quick Selection', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'quick' && !!(await page.$('[data-options="quick"] [data-quick="auto-enhance"]')))
await drag([-30, -10], [30, 10], { steps: 6 })
check('a stroke is one step', await stepIs('Quick Selection'))
check('the selection grows out to the square’s edges', boundsNear(await bounds(), [300, 200, 500, 400], 4), JSON.stringify(await bounds()))
// A second stroke, on the white, carries on from the first: it adds, without changing the options bar.
const before = await page.evaluate(() => globalThis.plexel.documents().active().history.labels.length)
await drag([150, -10], [180, 10], { steps: 6 })
const another = await waitUntil(page, (n) => globalThis.plexel.documents().active().history.labels.length > n, { args: [before], timeout: 8000 }).then(() => true, () => false)
check('a second stroke adds to what the first made, as Photoshop’s does', another && (await page.evaluate(async () => { const s = globalThis.plexel.documents().active().history.present.selection.tiles; const e = globalThis.plexel.engine(); return (await e.call('select.at', { set: s, x: 400, y: 300 })) > 0.9 && (await e.call('select.at', { set: s, x: 565, y: 300 })) > 0.9 })) && (await page.evaluate(() => globalThis.plexel.selectTools().get().op)) === 'replace', JSON.stringify(await bounds()))
await press('Shift+KeyW')
check('Shift+W goes on to the Magic Wand', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'wand')

// --- Grow, Similar, Border, Smooth ------------------------------------------------------------------
console.log('\nGrow, Similar, Border and Smooth')
await press('Control+KeyD')
await marquee([-20, -20], [20, 20])
await clickMenu('Select', 'select.grow')
check('Grow is a step', await stepIs('Grow'))
check('it grows to the like colours round the selection: the square', boundsNear(await bounds(), [300, 200, 500, 400], 2), JSON.stringify(await bounds()))
await clickMenu('Select', 'select.border', 'Modify')
await page.waitForSelector('#border-by')
await dialogSubmit('border')
check('Border is a step', await stepIs('Border'))
const ring = await page.evaluate(async () => {
  const s = globalThis.plexel.documents().active().history.present.selection.tiles
  const e = globalThis.plexel.engine()
  return [await e.call('select.at', { set: s, x: 400, y: 300 }), await e.call('select.at', { set: s, x: 300, y: 300 })]
})
check('a band along the edge, nothing in the middle', ring[0] === 0 && ring[1] > 0.3, JSON.stringify(ring))
await clickMenu('Select', 'select.smooth', 'Modify')
await page.waitForSelector('#border-by')
await dialogSubmit('smooth')
check('Smooth is a step', await stepIs('Smooth'))

// --- Colour Range -------------------------------------------------------------------------------
console.log('\nColour Range')
await press('Control+KeyD')
await clickMenu('Select', 'select.colour-range')
check('Colour Range opens beside the canvas, not over it', (await dialogShown(page, 'colourRange')) && !!(await page.$('.scrim.floating [data-dialog="colourRange"]')))
await clickAt(0, 0)
await waitUntil(page, () => document.querySelector('[data-range-samples]')?.getAttribute('data-range-samples') === '1').catch(() => {})
await settle(400)
await dialogSubmit('colourRange')
check('a click samples the canvas; OK selects the colour', await stepIs('Colour Range'))
check('the red square, and only it', boundsNear(await bounds(), [300, 200, 500, 400], 2), JSON.stringify(await bounds()))

// --- Transform Selection -------------------------------------------------------------------------
console.log('\nTransform Selection')
await clickMenu('Select', 'select.transform')
check('Transform Selection shows handles on the selection', (await page.evaluate(() => document.querySelector('[data-options="transform"]') !== null)))
// The bottom-right corner, dragged out by 50 (Shift: freely).
await drag([100, 100], [150, 150], { keys: ['Shift'] })
await press('Enter')
check('Enter makes the selection again through the transform', await stepIs('Transform Selection'))
check('it grew with the corner', boundsNear(await bounds(), [300, 200, 550, 450], 3), JSON.stringify(await bounds()))

// --- Save and Load Selection, and the Channels panel ------------------------------------------------
console.log('\nSave and Load Selection')
await clickMenu('Select', 'select.save')
await page.waitForSelector('#save-sel-name')
await dialogSubmit('saveSelection')
check('Save Selection makes an alpha channel', await stepIs('Save Selection'))
check('named Alpha 1', ((await doc()).channels ?? [])[0]?.name === 'Alpha 1')
await press('Control+KeyD')
await clickMenu('Select', 'select.load')
await page.waitForSelector('#load-sel-channel')
await dialogSubmit('loadSelection')
check('Load Selection brings it back', (await stepIs('Load Selection')) && boundsNear(await bounds(), [300, 200, 550, 450], 3))
await clickMenu('Window', 'window.panel.channels')
await frames(page)
check('the Channels panel lists it', !!(await page.$('[data-panel="channels"] [data-channel-row][data-kind="alpha"]')))

// --- Select and Mask --------------------------------------------------------------------------------
console.log('\nSelect and Mask')
await press('Control+Alt+KeyR')
await page.waitForSelector('#refine-radius')
check('Select and Mask floats beside the canvas, with Edge Detection and Output To', !!(await page.$('.scrim.floating [data-dialog="selectMask"]')) && !!(await page.$('#refine-output')))
await page.$eval('#refine-radius', (e) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(e, '12')
  e.dispatchEvent(new Event('input', { bubbles: true }))
})
await settle(1500)
await dialogSubmit('selectMask')
check('OK commits the refined selection', await stepIs('Select and Mask', 15000))

// --- the Magnetic Lasso ------------------------------------------------------------------------------
console.log('\nthe Magnetic Lasso')
await newDoc()
await redSquare()
await tool('lasso')
await page.evaluate(() => globalThis.plexel.selectTools().update('lasso', { mode: 'magnetic' }))
check('the Lasso has a Magnetic mode, with its settings', !!(await page.$('[data-lasso="magnetic"][aria-pressed="true"]')) && !!(await page.$('#opt-lasso-width')))
// Round the square, a little off its edge: the wire clings to it.
await clickAt(-97, -103)
for (const [x, y] of [
  [0, -104],
  [97, -98],
  [104, 0],
  [98, 97],
  [0, 104],
  [-97, 98],
  [-104, 0],
  [-100, -60],
]) {
  await moveTo(x, y, 8)
  // Longer than the gesture's double-click (350 ms), which closes the outline.
  await settle(400)
  await clickAt(x, y)
}
// Photoshop's habits: Alt-click a straight side out to a stray point, and Backspace takes it back.
await clickAt(250, -250, ['Alt'])
await press('Backspace')
await settle(400)
await clickAt(-97, -103)
check('a click on the start closes it, as one step', await stepIs('Magnetic Lasso'))
check('the outline followed the square’s edges, the point taken back not in it', boundsNear(await bounds(), [300, 200, 500, 400], 4), JSON.stringify(await bounds()))
await page.evaluate(() => globalThis.plexel.selectTools().update('lasso', { mode: 'freehand' }))

// --- gradients edited on the canvas: stops, freeform points, the Mesh tool --------------------------
console.log('\ngradients on the canvas')
await newDoc()
await page.evaluate(() => {
  const P = globalThis.plexel
  const d = P.documents().active()
  P.documents().commit(
    (doc) => {
      const n = P.doc.makeNode('vector', 'gshape', 'Shape', {
        geometry: { kind: 'shape', shape: { type: 'rect', x: 200, y: 150, w: 400, h: 300, radii: [0, 0, 0, 0], corner: 'round' } },
        appearance: [{ kind: 'fill', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'gradient', type: 'linear', stops: [{ at: 0, colour: [1, 0, 0], alpha: 1 }, { at: 1, colour: [0, 0, 1], alpha: 1 }], angle: 0, scale: 100, reverse: false } }],
      })
      return P.doc.insertNode(doc, n, doc.root, doc.nodes[doc.root].children.length)
    },
    { key: d.key, label: 'Gradient Shape' },
  )
  P.documents().select('gshape')
})
await tool('gradient')
await frames(page)
const handles = () => page.evaluate(() => globalThis.plexel.gradients.handlesOf())
const paintOf = () => page.evaluate(() => globalThis.plexel.documents().active().history.present.nodes.gshape.props.appearance[0].paint)
const off = (p) => [p[0] - 400, p[1] - 300]
{
  const h = await handles()
  check('the selected shape’s gradient shows its line across the box, with its stops beside it', !!h && Math.abs(h.line[0][0] - 200) < 1 && Math.abs(h.line[1][0] - 600) < 1 && h.stops.length === 2 && Math.abs(h.stops[0][0] - 200) < 1 && h.stops[0][1] > 302, JSON.stringify(h))
  await drag(off(h.stops[0]), [0, off(h.stops[0])[1]])
  check('dragging a stop slides it along the line, one step', await stepIs('Move Gradient Stop'))
  const p = await paintOf()
  check('it is half way along now', Math.abs(p.stops[0].at - 0.5) < 0.02, JSON.stringify(p.stops.map((x) => x.at)))
}
await clickAt(-100, 0)
check('a click on the line adds a stop there', await stepIs('Add Gradient Stop'))
{
  const p = await paintOf()
  check('three stops, the new one a quarter along in the colour it had', p.stops.length === 3 && Math.abs(p.stops[0].at - 0.25) < 0.02 && p.stops[0].colour[0] > 0.99, JSON.stringify(p.stops))
}
await press('Delete')
check('Delete takes the selected stop away', (await stepIs('Delete Gradient Stop')) && (await paintOf()).stops.length === 2)
{
  const h = await handles()
  await drag(off(h.line[1]), [200, 120])
  check('dragging an end moves it, giving the gradient a line of its own', (await stepIs('Move Gradient')) && JSON.stringify((await paintOf()).line?.map(Math.round)) === JSON.stringify([200, 300, 600, 420]), JSON.stringify((await paintOf()).line))
  await drag(off(h.stops[1]), [off(h.stops[1])[0], 200])
  check('a stop dragged far off the line is taken away, unless only two are left', (await paintOf()).stops.length === 2)
}
// Freeform, from Properties: four points over the box; a click adds one in the foreground colour.
await page.$eval('#props-item-0-paint-freeform', (e) => e.click())
check('Properties makes it a freeform gradient', (await paintOf()).kind === 'freeform' && (await paintOf()).points.length === 4)
await setForeground(0, 255, 0)
await clickAt(0, -100)
check('a click in the shape adds a colour point', await stepIs('Add Colour Point'))
{
  const p = await paintOf()
  const q = p.points[4]
  check('where it was clicked, in the foreground colour', p.points.length === 5 && Math.abs(q.p[0] - 400) < 1.5 && Math.abs(q.p[1] - 200) < 1.5 && q.colour[1] > 0.99 && q.colour[0] < 0.01, JSON.stringify(q))
  check('Properties lists it, selected', !!(await page.$('[data-editor="freeform"] [data-point="4"].selected')))
  await drag([0, -100], [50, -80])
  check('dragging a point moves it', (await stepIs('Move Colour Point')) && Math.abs((await paintOf()).points[4].p[0] - 450) < 1.5)
  await idle()
  // Beside the point: its handle is drawn over it.
  check('the canvas shows the green point’s colour there', near(await at(58, -72), [0, 255, 0], 30), JSON.stringify(await at(58, -72)))
}
// The Mesh tool: a click makes the shape a mesh, then adds rows and columns.
await press('Escape')
await tool('mesh')
await setForeground(255, 255, 0)
await clickAt(-100, -50)
check('the Mesh tool makes the shape a mesh through the click', await stepIs('Make Gradient Mesh'))
{
  const p = await paintOf()
  check('2 × 2 patches, the new point in the foreground colour', p.kind === 'mesh' && p.cols === 2 && p.rows === 2 && p.nodes[4].colour[0] > 0.99 && p.nodes[4].colour[1] > 0.99 && p.nodes[4].colour[2] < 0.01, JSON.stringify({ cols: p.cols, rows: p.rows, n: p.nodes[4] }))
  await idle()
  check('the canvas shows it at the point', near(await at(-92, -42), [255, 255, 0], 30), JSON.stringify(await at(-92, -42)))
}
await clickAt(100, 80)
check('another click adds a row and a column', (await stepIs('Add Mesh Lines')) && (await paintOf()).cols === 3 && (await paintOf()).rows === 3)
await drag([100, 80], [120, 90])
check('dragging a mesh point moves it', await stepIs('Move Mesh Point'))
await clickAt(120, 90, ['Alt'])
check('Alt-click on a point takes its row and column away', (await stepIs('Delete Mesh Lines')) && (await paintOf()).cols === 2 && (await paintOf()).rows === 2)
check('Properties sets the mesh’s columns and rows', !!(await page.$('#props-item-0-mcols')))
await press('Control+KeyZ')
check('each is one step in the history', (await stepIs('Move Mesh Point')) && (await paintOf()).cols === 3)

// --- Patterns from artwork, and pattern editing mode ----------------------------------------------------
console.log('\nMake Pattern and pattern editing mode')
await press('Escape')
await newDoc()
// The red square on a layer of its own, over the white background.
await press('Control+Alt+Shift+KeyN')
await stepIs('New Pixel Layer')
await redSquare()
const ownerKey = await page.evaluate(() => globalThis.plexel.documents().active().key)
const layerId = await page.evaluate(() => globalThis.plexel.documents().active().selected)
const owner = () => page.evaluate((k) => globalThis.plexel.documents().get(k).history.present, ownerKey)
const ownerPattern = async () => (await owner()).patterns?.[0] ?? null
await clickMenu('Layer', 'layer.make-pattern', 'Pattern')
const madeTab = await waitUntil(page, () => !!globalThis.plexel.documents().active()?.patternOf, { timeout: 8000 }).then(() => true, () => false)
check('Layer → Pattern → Make Pattern opens the layer’s copy in a tab of its own', madeTab)
const tabKey = await page.evaluate(() => globalThis.plexel.documents().active().key)
const tab = () => page.evaluate((k) => globalThis.plexel.documents().get(k)?.history.present ?? null, tabKey)
{
  const t = await tab()
  check('its canvas is the layer’s box, repeating both ways', t.width === 200 && t.height === 200 && t.tiled === 'both', `${t.width} × ${t.height}, ${t.tiled}`)
}
const patternMade = await waitUntil(page, (k) => !!globalThis.plexel.documents().get(k).history.present.patterns?.[0]?.art, { args: [ownerKey], timeout: 8000 }).then(() => true, () => false)
{
  const p = await ownerPattern()
  check('the pattern is in its document at once, one step there, with its artwork', patternMade && p.width === 200 && p.height === 200 && (await page.evaluate((k) => globalThis.plexel.documents().get(k).history.label, ownerKey)) === 'Make Pattern')
  check('the red square is still where it was', !!(await owner()).nodes[layerId])
}
check('the Patterns panel shows the Pattern Options', !!(await page.waitForSelector('[data-pattern-options]', { timeout: 4000 }).catch(() => null)))
await page.select('#pattern-tile-type', 'brick-row')
const brick = await waitUntil(page, (k) => globalThis.plexel.documents().get(k).history.present.patterns?.[0]?.height === 400, { args: [ownerKey], timeout: 8000 }).then(() => true, () => false)
check('Brick by Row: a repeat two tiles high, the tab wrapping across only', brick && (await ownerPattern()).art.tile.type === 'brick-row' && (await tab()).tiled === 'x')
// Something drawn in the tile: a blue square in its corner.
await page.evaluate((k) => {
  const { doc, documents } = globalThis.plexel
  const n = doc.makeNode('vector', 'blue', 'Blue', { geometry: { kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w: 50, h: 50, radii: [0, 0, 0, 0], corner: 'round' } }, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0, 0, 1] }, opacity: 1, blend: 'normal' }], graphicStyle: null })
  documents().commit((d) => doc.insertNode(d, n, d.root, (d.nodes[d.root].children ?? []).length), { key: k, label: 'Add Blue' })
}, tabKey)
const followed = await waitUntil(page, (k) => !!globalThis.plexel.documents().get(k).history.present.patterns?.[0]?.art?.content.nodes.blue, { args: [ownerKey], timeout: 8000 }).then(() => true, () => false)
check('what’s drawn in the tab goes into the pattern', followed && (await page.evaluate((k) => globalThis.plexel.documents().get(k).history.label, ownerKey)) === 'Edit Pattern')
await page.click('[data-pattern-done]')
await waitUntil(page, (k) => !globalThis.plexel.documents().get(k), { args: [tabKey] })
check('Done closes the tab and goes back to the document', (await page.evaluate(() => globalThis.plexel.documents().active().key)) === ownerKey)
// Pattern Overlay with it on the red square: bricks a row down moved half a tile along.
const patId = (await ownerPattern()).id
await page.evaluate(
  (k, id, pid) => {
    const { doc, documents } = globalThis.plexel
    documents().commit((d) => doc.setFx(d, id, [{ kind: 'pattern-overlay', enabled: true, params: { image: pid, imageScale: 100 } }]), { key: k, label: 'Layer Style' })
  },
  ownerKey,
  layerId,
  patId,
)
await idle()
{
  const img = await shot()
  // Document (310, 210) is in the second row, 10 px into a tile moved 100 along: the blue corner.
  check('Pattern Overlay draws the document’s pattern: its blue corner where the bricks put it', near(await at(-90, -90, img), [0, 0, 255], 20), JSON.stringify(await at(-90, -90, img)))
  check('and its red elsewhere', near(await at(50, -90, img), RED, 20) && near(await at(-90, 90, img), RED, 20), JSON.stringify([await at(50, -90, img), await at(-90, 90, img)]))
}
// Edit again, change the layout, then Cancel: the pattern goes back as it was.
await page.click(`[data-pattern-edit="${patId}"]`)
await waitUntil(page, () => !!globalThis.plexel.documents().active()?.patternOf)
const tab2 = await page.evaluate(() => globalThis.plexel.documents().active().key)
await page.waitForSelector('#pattern-tile-type')
await page.select('#pattern-tile-type', 'grid')
await waitUntil(page, (k) => globalThis.plexel.documents().get(k).history.present.patterns?.[0]?.height === 200, { args: [ownerKey], timeout: 8000 }).catch(() => {})
await page.click('[data-pattern-cancel]')
await waitUntil(page, (k) => !globalThis.plexel.documents().get(k), { args: [tab2] })
check('Cancel puts the pattern back as it was before the tab opened', (await ownerPattern()).art.tile.type === 'brick-row' && (await ownerPattern()).height === 400 && (await page.evaluate((k) => globalThis.plexel.documents().get(k).history.label, ownerKey)) === 'Cancel Pattern Edit')
// Save a Copy keeps a second pattern.
await page.click(`[data-pattern-edit="${patId}"]`)
await waitUntil(page, () => !!globalThis.plexel.documents().active()?.patternOf)
await page.waitForSelector('[data-pattern-copy]')
await page.click('[data-pattern-copy]')
check('Save a Copy keeps what’s drawn as a pattern of its own', await waitUntil(page, (k) => globalThis.plexel.documents().get(k).history.present.patterns?.length === 2, { args: [ownerKey], timeout: 8000 }).then(() => true, () => false))
await page.click('[data-pattern-done]')
await waitUntil(page, () => !globalThis.plexel.documents().active()?.patternOf)
// A pattern from pixels opens as a layer of its pixels and stays pixels until something's drawn.
await marquee([-100, -100], [-20, -20])
await clickMenu('Edit', 'edit.define-pattern')
await dialogSubmit('definePattern')
await stepIs('Define Pattern')
await press('Control+KeyD')
const pixelPat = (await owner()).patterns.at(-1)
await page.click(`[data-pattern-edit="${pixelPat.id}"]`)
await waitUntil(page, () => !!globalThis.plexel.documents().active()?.patternOf)
{
  const t = await page.evaluate(() => globalThis.plexel.documents().active().history.present)
  const layers = t.nodes[t.root].children.map((id) => t.nodes[id])
  check('a pattern from pixels opens as one pixel layer of its repeat', layers.length === 1 && layers[0].kind === 'pixel' && layers[0].props.tiles === pixelPat.tiles && t.width === pixelPat.width)
}
await page.click('[data-pattern-done]')
await waitUntil(page, () => !globalThis.plexel.documents().active()?.patternOf)
check('opened and closed untouched, it stays as it was', JSON.stringify((await owner()).patterns.at(-1)) === JSON.stringify(pixelPat))

await finish()
