/**
 * Rulers, guides, grids, snapping and alignment in Chrome, through the real
 * menus, keys, panels and pointer: rulers shown and their units; guides
 * dragged out of a ruler, moved, and dragged off again; New Guide and New
 * Guide Layout; Lock and Clear Guides; the grid and snapping to it; the
 * Move tool snapping a layer to a guide, letting go with Ctrl, and drawing
 * smart guides; several layers selected in the Layers panel, moved
 * together, aligned and distributed from the menu and the options bar.
 *
 * Documents are 800 × 600 at 100%, so a pixel on screen is a document
 * pixel, and an offset from the canvas's centre is one from the
 * document's centre (400, 300).
 *
 * Run with: npm run check:guides
 */
import { check, finish, frames, open, settle, waitUntil, waitForEngine } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
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
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
/** The page point over document point (x, y), through the view as the engine draws it. */
const pt = (x, y) =>
  page.evaluate(
    (px, py) => {
      const v = globalThis.plexel.views().front()
      const c = globalThis.plexel.engine().canvasSize()
      const r = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
      // As render/view.ts: unrotated, the translation is whole device pixels.
      const s = v.zoom * c.dpr
      const e = Math.round(c.width / 2 - s * v.cx)
      const f = Math.round(c.height / 2 - s * v.cy)
      const k = r.width / c.width
      return [r.x + (e + s * px) * k, r.y + (f + s * py) * k]
    },
    x,
    y,
  )
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const steps = () => page.evaluate(() => { const h = globalThis.plexel.documents().active().history; return [...h.labels, h.label] })
const lastStep = async () => (await steps()).at(-1)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const guides = async () => (await doc()).guides
const prefs = () => page.evaluate(() => globalThis.plexel.guidePrefs().get())
const setPrefs = (p) => page.evaluate((x) => globalThis.plexel.guidePrefs().update(x), p)
/** A drag between page points, keys held, with the mouse still down at the end when `hold`. */
const drag = async (from, to, { keys = [], steps: n = 10, hold = false } = {}) => {
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: n })
  if (hold) return async () => {
    await page.mouse.up()
    for (const k of [...keys].reverse()) await page.keyboard.up(k)
    await settle(100)
  }
  await page.mouse.up()
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(100)
}
/** A shape's box in document pixels: its rectangle through its transform (a move). */
const boxOf = async (name) => page.evaluate((n) => {
  const d = globalThis.plexel.documents().active().history.present
  const node = Object.values(d.nodes).find((x) => x.name === n)
  const s = node.props.geometry.shape
  const t = node.transform
  return [s.x + t[4], s.y + t[5], s.x + s.w + t[4], s.y + s.h + t[5]]
}, name)
const near = (a, b, tol = 0.51) => Math.abs(a - b) <= tol
/** Draws a rectangle with the Shape tool from one document point to another, snapping let go (Ctrl). */
const rectangle = async (name, x0, y0, x1, y1) => {
  await press('KeyU')
  await drag(await pt(x0, y0), await pt(x1, y1), { keys: ['Control'] })
  await page.waitForFunction(() => globalThis.plexel.documents().active().history.label === 'New Shape')
  await page.evaluate((nm) => {
    const s = globalThis.plexel.documents()
    const d = s.active()
    s.commit((x) => ({ ...x, nodes: { ...x.nodes, [d.selected]: { ...x.nodes[d.selected], name: nm } } }), { label: 'Rename' })
  }, name)
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
  await press('Control+Digit1')
  await idle()
}
/** Whether the screenshot has a pixel close to `rgb` along a row or column of document points. */
const anyNear = (img, pts, rgb, tol = 40) => pts.some(([x, y]) => [-1, 0, 1].some((e) => pixelAt(img, Math.round(x), Math.round(y) + e).slice(0, 3).every((v, i) => Math.abs(v - rgb[i]) <= tol)))

await newDoc()
await setPrefs({ snap: true, smartGuides: true, guides: true, lockGuides: false, grid: false, rulers: false, units: 'px', alignTo: 'layers', snapTo: { guides: true, grid: true, layers: true, document: true, points: true, pixels: false } })
await frames(page)

// --- rulers ---------------------------------------------------------------------------------
console.log('rulers')
const before = await rect()
await press('Control+KeyR')
await page.waitForSelector('[data-ruler="top"]')
await idle()
const after = await rect()
check('Ctrl+R shows the rulers, and the canvas makes room for them', near(after.x - before.x, 20, 1) && near(after.y - before.y, 20, 1) && (await prefs()).rulers, JSON.stringify([before, after]))
check('the corner names the units', (await page.$eval('[data-ruler="corner"]', (e) => e.textContent)) === 'px')
await press('Control+Digit1')
await idle()

// --- guides out of the rulers -----------------------------------------------------------------
console.log('\nguides out of the rulers')
{
  const top = await page.$eval('[data-ruler="top"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
  const target = await pt(400, 150)
  const release = await drag(top, target, { hold: true })
  const shown = await page.$eval('[data-readout]', (e) => e.textContent).catch(() => null)
  check('dragging out of the top ruler shows where the guide is', shown === 'Y 150 px', String(shown))
  await release()
  const g = await guides()
  check('and lets go of a horizontal guide there, as one step', g.length === 1 && g[0].axis === 'y' && near(g[0].at, 150) && (await lastStep()) === 'New Guide', JSON.stringify(g))
  check('the readout goes when the drag ends', !(await page.$('[data-readout]')))
  const left = await page.$eval('[data-ruler="left"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
  await drag(left, await pt(250, 300))
  const g2 = await guides()
  check('out of the left ruler, a vertical one', g2.length === 2 && g2[1].axis === 'x' && near(g2[1].at, 250), JSON.stringify(g2))
  const img = await shot()
  const [gx] = await pt(250, 0)
  const ys = await Promise.all([100, 200, 400, 500].map(async (y) => (await pt(0, y))[1]))
  check('guides are drawn across the canvas in their colour', anyNear(img, ys.map((y) => [gx, y]), [0, 200, 255]) || anyNear(img, ys.map((y) => [gx - 1, y]), [0, 200, 255]))

  await press('KeyV')
  await page.mouse.move(...(await pt(250, 400)))
  await frames(page)
  check('the Move tool over a guide offers to drag it', (await page.$eval('.viewport', (e) => e.style.cursor)) === 'col-resize')
  await drag(await pt(250, 400), await pt(300, 400))
  check('and moves it', near((await guides())[1].at, 300) && (await lastStep()) === 'Move Guide', JSON.stringify(await guides()))
  const leftRuler = await page.$eval('[data-ruler="left"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
  await drag(await pt(300, 450), leftRuler)
  check('dragged off the canvas, it’s taken away', (await guides()).length === 1 && (await lastStep()) === 'Delete Guide')
  await press('Control+KeyZ')
  check('Undo brings it back', (await guides()).length === 2)
  await press('Control+Alt+Semicolon')
  check('Lock Guides (Ctrl+Alt+;)', (await prefs()).lockGuides)
  await page.mouse.move(...(await pt(300, 400)))
  await frames(page)
  check('a locked guide isn’t offered', (await page.$eval('.viewport', (e) => e.style.cursor)) !== 'col-resize')
  await press('Control+Alt+Semicolon')
  await press('Control+Semicolon')
  check('Ctrl+; hides the guides', !(await prefs()).guides)
  await press('Control+Semicolon')
  check('and shows them', (await prefs()).guides)
}

// --- New Guide, New Guide Layout, Clear Guides ---------------------------------------------------
console.log('\nNew Guide, New Guide Layout, Clear Guides')
{
  await clickMenu('View', 'view.clear-guides')
  check('Clear Guides', (await guides()).length === 0 && (await lastStep()) === 'Clear Guides')
  await clickMenu('View', 'view.new-guide')
  await page.waitForSelector('#guide-at')
  await page.select('#guide-axis', 'x')
  await page.click('#guide-at', { clickCount: 3 })
  await page.keyboard.type('600')
  await page.keyboard.press('Enter')
  await settle(100)
  const g = await guides()
  check('New Guide adds one where it’s typed', g.length === 1 && g[0].axis === 'x' && near(g[0].at, 600) && (await lastStep()) === 'New Guide', JSON.stringify(g))
  await clickMenu('View', 'view.guide-layout')
  await page.waitForSelector('#layout-cols')
  await page.click('#layout-cols', { clickCount: 3 })
  await page.keyboard.type('4')
  await frames(page)
  await page.click('[data-dialog="guideLayout"] .dialog-foot .primary')
  await settle(100)
  const l = await guides()
  check('New Guide Layout makes the columns, clearing what was there', l.length === 8 && l.map((x) => Math.round(x.at)).join() === '0,185,205,390,410,595,615,800' && (await lastStep()) === 'New Guide Layout', l.map((x) => x.at).join())
  await clickMenu('View', 'view.clear-guides')
}

// --- snapping the Move tool ---------------------------------------------------------------------
console.log('\nsnapping')
{
  await rectangle('A', 100, 100, 200, 200)
  await rectangle('B', 500, 300, 560, 360)
  check('the shapes are where they were drawn (snapping let go with Ctrl)', JSON.stringify(await boxOf('A')) === '[100,100,200,200]' && JSON.stringify(await boxOf('B')) === '[500,300,560,360]', JSON.stringify([await boxOf('A'), await boxOf('B')]))
  // A guide at x = 300 for A to snap to.
  await page.evaluate(() => globalThis.plexel.documents().commit((x) => ({ ...x, guides: [{ axis: 'x', at: 300 }] }), { label: 'New Guide' }))
  await page.evaluate(() => {
    const s = globalThis.plexel.documents()
    const d = s.active()
    const a = Object.values(d.history.present.nodes).find((n) => n.name === 'A')
    s.select(a.id)
  })
  await press('KeyV')
  await drag(await pt(150, 150), await pt(246, 153))
  let a = await boxOf('A')
  check('Move snaps a layer’s edge to a guide within a few pixels', near(a[2], 300) && near(a[1], 103), JSON.stringify(a))
  await press('Control+KeyZ')
  await drag(await pt(150, 150), await pt(246, 153), { keys: ['Control'] })
  a = await boxOf('A')
  check('with Ctrl held it doesn’t', near(a[2], 296), JSON.stringify(a))
  await press('Control+KeyZ')
  // Lining A's top up with B's: a smart guide runs between them while the drag is held.
  const release = await drag(await pt(150, 150), await pt(152, 348), { hold: true })
  await idle()
  const img = await shot()
  const row = []
  for (let x = 260; x < 480; x += 4) row.push(await pt(x, 300))
  check('a smart guide is drawn from the layer to what it lines up with', anyNear(img, row, [255, 47, 180], 60), JSON.stringify(pixelAt(img, ...(await pt(400, 300)).map(Math.round))))
  const readout = await page.$eval('[data-readout]', (e) => e.textContent).catch(() => '')
  check('the readout says how far it has moved', /ΔX 2 px\s+ΔY 200 px/.test(readout), readout)
  await release()
  a = await boxOf('A')
  check('its top lands on the other’s top', near(a[1], 300), JSON.stringify(a))
  await press('Control+KeyZ')
  // The grid: shown, things snap to it.
  await setPrefs({ gridEvery: 100, gridUnit: 'px', gridSub: 1 })
  await press("Control+Quote")
  check("Ctrl+' shows the grid", (await prefs()).grid)
  await drag(await pt(150, 150), await pt(155, 147))
  a = await boxOf('A')
  check('a layer snaps to the grid', near(a[0], 100) && near(a[1], 100), JSON.stringify(a))
  await press('KeyU')
  await drag(await pt(296, 404), await pt(397, 497))
  const shapes = await page.evaluate(() => Object.values(globalThis.plexel.documents().active().history.present.nodes).filter((n) => n.kind === 'vector').length)
  const c = await page.evaluate(() => {
    const d = globalThis.plexel.documents().active()
    const s = d.history.present.nodes[d.selected].props.geometry.shape
    return [s.x, s.y, s.x + s.w, s.y + s.h]
  })
  check('a shape’s corners snap to the grid as it’s drawn', shapes === 3 && near(c[0], 300) && near(c[1], 400) && near(c[2], 400) && near(c[3], 500), JSON.stringify(c))
  await press('Control+KeyZ')
  await press("Control+Quote")
  await press('Control+Shift+Semicolon')
  check('Ctrl+Shift+; turns snapping off', !(await prefs()).snap)
  await press('KeyV')
  await page.evaluate(() => {
    const s = globalThis.plexel.documents()
    s.select(Object.values(s.active().history.present.nodes).find((n) => n.name === 'A').id)
  })
  await drag(await pt(150, 150), await pt(246, 153))
  check('and then nothing snaps', near((await boxOf('A'))[2], 296))
  await press('Control+KeyZ')
  await press('Control+Shift+Semicolon')
}

// --- several layers, align and distribute ------------------------------------------------------------
console.log('\nseveral layers, align and distribute')
{
  await rectangle('C', 300, 450, 340, 500)
  const row = (n) => page.$(`.layer-row[data-layer="${n}"]`)
  const idOf = (n) => page.evaluate((nm) => Object.values(globalThis.plexel.documents().active().history.present.nodes).find((x) => x.name === nm).id, n)
  const [ida, idb, idc] = [await idOf('A'), await idOf('B'), await idOf('C')]
  await (await row(ida)).click()
  await page.keyboard.down('Control')
  await (await row(idb)).click()
  await page.keyboard.up('Control')
  await frames(page)
  const sel = await page.evaluate(() => { const d = globalThis.plexel.documents().active(); return [d.selected, ...d.others] })
  check('Ctrl-click in the Layers panel selects another layer too, as the key layer', sel[0] === idb && sel.includes(ida) && sel.length === 2, JSON.stringify(sel))
  check('both rows show selected', (await page.$$eval('.layer-row.selected', (e) => e.length)) === 2)
  await press('KeyV')
  await drag(await pt(150, 150), await pt(160, 140), { keys: ['Control'] })
  check('the Move tool moves them together', JSON.stringify(await boxOf('A')) === '[110,90,210,190]' && JSON.stringify(await boxOf('B')) === '[510,290,570,350]', JSON.stringify([await boxOf('A'), await boxOf('B')]))
  await press('Control+KeyZ')
  await clickMenu('Layer', 'layer.align.top', 'Align')
  check('Layer → Align → Top Edges lines them up with the topmost', (await boxOf('A'))[1] === 100 && (await boxOf('B'))[1] === 100 && (await lastStep()) === 'Align Top Edges', JSON.stringify([await boxOf('A'), await boxOf('B')]))
  await press('Control+KeyZ')
  await page.select('#opt-align-to', 'key')
  await page.click('[data-align="left"]')
  await settle(100)
  check('Align To Key Layer leaves the key layer and moves the rest to it', (await boxOf('A'))[0] === 500 && (await boxOf('B'))[0] === 500, JSON.stringify([await boxOf('A'), await boxOf('B')]))
  await press('Control+KeyZ')
  await page.select('#opt-align-to', 'canvas')
  await page.click('[data-align="right"]')
  await settle(100)
  check('Align To Canvas: their right edges on the canvas’s', (await boxOf('A'))[2] === 800 && (await boxOf('B'))[2] === 800)
  await press('Control+KeyZ')
  await page.select('#opt-align-to', 'layers')
  check('Distribute needs three layers', await page.$eval('[data-distribute="hspace"]', (e) => e.disabled))
  // Shift-click adds the range in the panel: C was drawn with A selected, so it's between A and B.
  await (await row(ida)).click()
  await page.keyboard.down('Shift')
  await (await row(idb)).click()
  await page.keyboard.up('Shift')
  await frames(page)
  const three = await page.evaluate(() => { const d = globalThis.plexel.documents().active(); return [d.selected, ...d.others] })
  check('Shift-click selects every row between', three.length === 3, JSON.stringify([three, ida, idb, idc]))
  await page.click('[data-distribute="hspace"]')
  await settle(100)
  const [A, B, C] = [await boxOf('A'), await boxOf('B'), await boxOf('C')]
  check('Distribute Horizontal Spacing makes the gaps between them equal', near(C[0] - A[2], B[0] - C[2]) && A[0] === 100 && B[2] === 560 && (await lastStep()) === 'Distribute Horizontal Spacing', JSON.stringify([A, C, B]))
  await press('Delete')
  check('Delete deletes every selected layer, as one step', (await page.evaluate(() => Object.values(globalThis.plexel.documents().active().history.present.nodes).filter((n) => n.kind === 'vector').length)) === 0 && (await lastStep()) === 'Delete Layers')
}

// --- ruler units ------------------------------------------------------------------------------
console.log('\nruler units')
{
  const top = await page.$eval('[data-ruler="top"]', (e) => { const r = e.getBoundingClientRect(); return [r.x + 100, r.y + 10] })
  await page.mouse.click(...top, { button: 'right' })
  await page.waitForSelector('[data-command="view.units.in"]')
  await page.click('[data-command="view.units.in"]')
  await frames(page)
  check('a right-click on a ruler picks its units', (await prefs()).units === 'in' && (await page.$eval('[data-ruler="corner"]', (e) => e.textContent)) === 'in')
  await setPrefs({ units: 'px' })
  await press('Control+KeyR')
  check('Ctrl+R hides the rulers again', !(await page.$('[data-ruler="top"]')))
}

await finish()
