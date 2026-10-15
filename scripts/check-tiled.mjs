/**
 * Tiled documents, in Chrome, through the real pointer and menus:
 * Document → Tiled as a step in the history, Tiled View's copies round the
 * canvas, a stroke over an edge coming back at the other side, a press in a
 * copy painting the document, Smudge across an edge, the Offset filter live
 * (wrapping) and applied (repeating edge pixels), Define Pattern from the
 * whole canvas; a shape over an edge, a live blur reading across the seam,
 * a marquee and the Magic Wand round the edges, and a gradient over the
 * seam.
 *
 * The document is 300 × 200 at 100%, centred, so a document point is the
 * canvas's centre plus (x − 150, y − 100) on screen.
 *
 * Run with: npm run check:tiled
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

const W = 300
const H = 200
const { press } = pageHelpers(page)
const openMenu = async (menu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
}
const closeMenus = async () => {
  await page.mouse.click(5, 845)
  await frames(page)
}
const idle = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
  await frames(page)
}
const setTiling = async (t) => {
  await openMenu('Document')
  await page.click('[data-submenu="Tiled"]')
  await frames(page)
  await page.click(`[data-command="doc.tiled.${t}"]`)
  await idle()
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
/** A document point on screen. */
const screen = async (x, y) => {
  const r = await rect()
  return [r.x + r.w / 2 + x - W / 2, r.y + r.h / 2 + y - H / 2]
}
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
/** The colour on screen at a document point (in a copy, where it's off the canvas). */
const at = async (x, y, img) => {
  const [sx, sy] = await screen(x, y)
  return pixelAt(img ?? (await shot()), Math.round(sx), Math.round(sy)).slice(0, 3)
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const BLACK = [0, 0, 0]
const WHITE = [255, 255, 255]
const stroke = async (points) => {
  const [x0, y0] = await screen(...points[0])
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (const p of points.slice(1)) {
    const [x, y] = await screen(...p)
    await page.mouse.move(x, y, { steps: 12 })
  }
  await page.mouse.up()
  await settle(150)
  await idle()
}
const present = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active().history.present
  return { tiled: d.tiled ?? 'off', patterns: (d.patterns ?? []).map((p) => [p.width, p.height]) }
})
const lastStep = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)

// --- a document --------------------------------------------------------------------------
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', W], ['#new-height', H]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
await page.click('.layer-row .layer-name')
await press('Control+Digit1')
await idle()
const pasteboard = await at(-60, 50)

console.log('\nthe setting')
await openMenu('Document')
await page.click('[data-submenu="Tiled"]')
await frames(page)
check('Document → Tiled offers off, both directions, across and down, off ticked', (await page.$$eval('[data-command^="doc.tiled."]', (els) => els.map((e) => `${e.dataset.command}:${e.getAttribute('aria-checked')}`))).join() === 'doc.tiled.off:true,doc.tiled.both:false,doc.tiled.x:false,doc.tiled.y:false')
await closeMenus()
await openMenu('View')
check('Tiled View says why it can’t be chosen in a document that isn’t tiled', await page.$eval('[data-command="view.tiled-view"]', (e) => e.disabled && /isn’t tiled/.test(e.dataset.why ?? '')))
await closeMenus()
check('off the canvas is the pasteboard', !near(pasteboard, WHITE), String(pasteboard))
await setTiling('both')
check('choosing Both Directions tiles the document, as a step in the history', (await present()).tiled === 'both' && (await lastStep()) === 'Tiled')
check('Tiled View shows the document’s copies round it', near(await at(-60, 50), WHITE) && near(await at(W + 40, H + 40), WHITE), String(await at(-60, 50)))
await press('Control+KeyZ')
await idle()
check('Undo takes the tiling away, and the copies with it', (await present()).tiled === 'off' && near(await at(-60, 50), pasteboard))
await press('Control+Shift+KeyZ')
await idle()

console.log('\npainting over the edges')
await press('KeyB')
await stroke([[W - 60, 100], [W + 60, 100]])
const img = await shot()
check('a stroke over the right edge comes back at the left', near(await at(30, 100, img), BLACK) && near(await at(W - 40, 100, img), BLACK), String(await at(30, 100, img)))
check('and only along it', near(await at(30, 150, img), WHITE) && near(await at(150, 100, img), WHITE))
check('its copies show it too', near(await at(W + 30, 100, img), BLACK) && near(await at(-30, 100, img), BLACK))
await stroke([[-110, 40], [-70, 40]])
check('a stroke in a copy paints the document where the copy is of', near(await at(W - 90, 40), BLACK) && near(await at(-90, 40), BLACK))
await stroke([[130, -20], [130, 20]])
check('a stroke over the top edge comes back at the bottom', near(await at(130, H - 8), BLACK) && near(await at(130, 8), BLACK))
await press('KeyZ')
await page.evaluate(() => globalThis.plexel.tools().set('smudge'))
await frames(page)
const before = await at(10, 125)
await stroke([[W - 30, 100], [W + 10, 135]])
const after = await at(10, 125)
check('Smudge drags paint over the edge, to the other side', after[0] < before[0] - 20, `${before} → ${after}`)

console.log('\nTiled View')
await openMenu('View')
await page.click('[data-command="view.tiled-view"]')
await idle()
check('switched off, the copies go and the pasteboard is back', near(await at(-60, 50), pasteboard) && near(await at(30, 100), BLACK))
await openMenu('View')
await page.click('[data-command="view.tiled-view"]')
await idle()
check('and back on, they show again', near(await at(-60, 50), WHITE))

console.log('\nOffset')
await press('Control+KeyZ') // the smudge
await idle()
await openMenu('Filter')
await page.click('[data-submenu="Other"]')
await page.click('[data-command="filter.offset"]')
await page.waitForSelector('#filter-offset-horizontal')
for (const [k, v] of [['horizontal', W / 2], ['vertical', H / 2]]) {
  await page.click(`#filter-offset-${k} ~ .slider-number`, { clickCount: 3 })
  await page.keyboard.type(String(v))
  await page.keyboard.press('Enter')
}
await frames(page)
check('Offset wraps around to start with', (await page.$eval('#filter-offset-edge', (e) => e.value)) === 'wrap')
await page.click('[data-dialog^="filter"] .dialog-foot .primary')
await idle()
const off = await shot()
// The right-edge stroke at y 100 moves down half: to y 0 (and 200), and along by half.
check('Offset by half, live, moves the seam into the middle', near(await at(170, 4, off), BLACK) && near(await at(170, H - 4, off), BLACK) && near(await at(170, 100, off), WHITE), `${await at(170, 4, off)} / ${await at(170, 100, off)}`)
check('it’s a live filter on the layer', (await page.evaluate(() => Object.values(globalThis.plexel.documents().active().history.present.nodes).filter((n) => n.kind === 'filter' && n.props.filter === 'offset').length)) === 1)
await press('Control+KeyZ')
await idle()
check('and Undo takes it away', near(await at(30, 100), BLACK) && near(await at(170, 4), WHITE))

// Applied for good, repeating the edge: the left half becomes the first column drawn out, and the stroke's
// left end (x 0 to about 75) moves to 150 to about 225.
await openMenu('Filter')
await page.click('[data-submenu="Other"]')
await page.click('[data-command="filter.offset"]')
await page.waitForSelector('#filter-offset-horizontal')
await page.click('#filter-offset-horizontal ~ .slider-number', { clickCount: 3 })
await page.keyboard.type(String(W / 2))
await page.keyboard.press('Enter')
await page.click('#filter-offset-vertical ~ .slider-number', { clickCount: 3 })
await page.keyboard.type('0')
await page.keyboard.press('Enter')
await page.select('#filter-offset-edge', 'repeat')
if (await page.$eval('#filter-live', (e) => e.checked)) await page.click('#filter-live')
await frames(page)
await page.click('[data-dialog^="filter"] .dialog-foot .primary')
await idle()
await waitUntil(page, () => globalThis.plexel.documents().active().history.label !== 'Tiled', { timeout: 5000 }).catch(() => {})
await idle()
check('applied with Repeat Edge Pixels, the gap is the edge column drawn out', near(await at(75, 100), BLACK) && near(await at(75, 60), WHITE) && near(await at(200, 100), BLACK) && near(await at(240, 100), WHITE), `${await at(75, 100)} / ${await at(75, 60)}`)
check('applied, no live filter is left', (await page.evaluate(() => Object.values(globalThis.plexel.documents().active().history.present.nodes).filter((n) => n.kind === 'filter').length)) === 0)

console.log('\nDefine Pattern')
await openMenu('Edit')
await page.click('[data-command="edit.define-pattern"]')
await page.waitForSelector('[data-pattern-whole]')
check('from a tiled document it takes the whole canvas to start with', await page.$eval('[data-pattern-whole]', (e) => e.checked))
await page.click('[data-dialog="definePattern"] .dialog-foot .primary')
await waitUntil(page, () => (globalThis.plexel.documents().active().history.present.patterns ?? []).length > 0, { timeout: 5000 }).catch(() => {})
check('the pattern is the canvas, one repeat of the document', JSON.stringify((await present()).patterns) === JSON.stringify([[W, H]]), JSON.stringify((await present()).patterns))

console.log('\nlive layers over the edges')
// A fresh tiled document: a rectangle over the right edge, then live filters and selections round it.
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', W], ['#new-height', H]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
await press('Control+Digit1')
await idle()
await setTiling('both')
const tool = async (id) => {
  await page.evaluate((t) => globalThis.plexel.tools().set(t), id)
  await frames(page)
}
const dragDoc = async (a, b, steps = 10) => {
  const [x0, y0] = await screen(...a)
  const [x1, y1] = await screen(...b)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps })
  await page.mouse.up()
  await settle(150)
  await idle()
}
await tool('shape')
await dragDoc([W - 60, 60], [W + 40, 140])
const sh = await shot()
check('a shape drawn over the right edge shows at the left too', near(await at(20, 100, sh), BLACK) && near(await at(W - 30, 100, sh), BLACK), String(await at(20, 100, sh)))
check('and nowhere else', near(await at(150, 100, sh), WHITE) && near(await at(20, 40, sh), WHITE))
check('it’s one live shape, past the canvas', await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const n = d.history.present.nodes[d.selected]
  return n.kind === 'vector' && n.props.geometry.shape.x + n.props.geometry.shape.w > 300
}))
await openMenu('Filter')
await page.click('[data-submenu="Blur"]')
await page.click('[data-command="filter.gaussian-blur"]')
await page.waitForSelector('#filter-gaussian-blur-radius')
await page.click('#filter-gaussian-blur-radius ~ .slider-number', { clickCount: 3 })
await page.keyboard.type('6')
await page.keyboard.press('Enter')
await page.click('[data-dialog^="filter"] .dialog-foot .primary')
await idle()
const bl = await shot()
// Across the seam the shape carries on, so a blur leaves it solid there: no fading at the canvas's edges.
check('a live blur reads across the seam: the shape stays solid at the edges', (await at(1, 100, bl))[0] < 40 && (await at(W - 2, 100, bl))[0] < 40, `${await at(1, 100, bl)} / ${await at(W - 2, 100, bl)}`)
check('and softens its other edges', (await at(W - 60, 100, bl))[0] > 60 && (await at(W - 60, 100, bl))[0] < 200, String(await at(W - 60, 100, bl)))

console.log('\nselections over the edges')
const selAt = (x, y) => page.evaluate(async ([x, y]) => {
  const s = globalThis.plexel.documents().active().history.present.selection?.tiles
  return s ? globalThis.plexel.engine().call('select.at', { set: s, x, y }) : 0
}, [x, y])
await tool('marquee')
await dragDoc([W - 40, 20], [W + 40, 50])
check('a marquee dragged over the right edge selects at the left too', (await selAt(20, 35)) > 0.9 && (await selAt(W - 20, 35)) > 0.9 && (await selAt(150, 35)) === 0, `${await selAt(20, 35)}`)
await press('Control+KeyD')
// The wand on the white: the white left of the shape and right of it are one region round the seam.
await page.click('.layer-row:last-child .layer-name')
await tool('wand')
await page.evaluate(() => globalThis.plexel.selectTools().update('wand', { contiguous: true, sampleAll: true }))
const [wx, wy] = await screen(150, 30)
await page.mouse.click(wx, wy)
await idle()
await waitUntil(page, () => !!globalThis.plexel.documents().active().history.present.selection, { timeout: 5000 }).catch(() => {})
check('the Magic Wand’s region flows round the edges', (await selAt(150, 30)) > 0.9 && (await selAt(5, 180)) > 0.9 && (await selAt(20, 100)) < 0.1, `${await selAt(5, 180)} / ${await selAt(20, 100)}`)
await press('Control+KeyD')

console.log('\na gradient over the seam')
await page.evaluate(() => globalThis.plexel.fillTools().update('gradient', { makes: 'layer', type: 'linear', preset: 'black-white' }))
await tool('gradient')
await dragDoc([W - 40, 190], [W + 40, 190])
const gr = await shot()
const g1 = await at(W - 20, 190, gr)
const g2 = await at(20, 190, gr)
check('a gradient dragged over the seam runs on across it, dark to light', g2[0] > g1[0] + 60, `${g1} → ${g2}`)

console.log('\nmasks and Offset beyond the canvas')
{
  // A solid fill layer masked by a band of selection: drawn once (a fill covers everywhere), so its mask must repeat.
  await press('Control+KeyD')
  await tool('marquee')
  await dragDoc([100, -10], [160, H + 10])
  await openMenu('Layer')
  await page.click('[data-submenu="New Fill Layer"]')
  await frames(page)
  await page.click('[data-command="layer.fill-solid"]')
  await idle()
  await press('Control+KeyD')
  const ids = await page.evaluate(() => {
    const d = globalThis.plexel.documents().active()
    const n = d.history.present.nodes[d.selected]
    return { fill: n.kind === 'fill' ? n.id : null, mask: n.masks?.[0] ?? null }
  })
  check('a fill layer made with a selection is masked by it', !!ids.fill && !!ids.mask)
  // Its mask moved by 170: the band at 270 to 330, over the right edge.
  await page.evaluate((m) => globalThis.plexel.documents().commit((d) => ({ ...d, nodes: { ...d.nodes, [m]: { ...d.nodes[m], transform: [1, 0, 0, 1, 170, 0] } } }), { label: 'Move Mask' }), ids.mask)
  await idle()
  const mk = await shot()
  check('a fill layer’s mask moved over the edge shows at the other side', near(await at(280, 50, mk), BLACK) && near(await at(15, 50, mk), BLACK) && near(await at(130, 50, mk), WHITE), `${await at(15, 50, mk)} / ${await at(130, 50, mk)}`)
  await press('Control+KeyZ')
  await press('Control+KeyZ')
  await idle()

  // A band right across, offset with Repeat Edge Pixels, then blurred: at the seam the blur reads what Offset gives
  // past the canvas, so the band stays solid there.
  await tool('shape')
  await dragDoc([10, 150], [W - 10, 185])
  await page.evaluate((w) => {
    const d = globalThis.plexel.documents().active()
    const n = d.history.present.nodes[d.selected]
    const g = n.props.geometry
    globalThis.plexel.documents().commit((x) => ({ ...x, nodes: { ...x.nodes, [n.id]: { ...n, props: { ...n.props, geometry: { ...g, shape: { ...g.shape, x: -40, w: w + 80 } } } } } }), { label: 'Widen' })
  }, W)
  await idle()
  await openMenu('Filter')
  await page.click('[data-submenu="Other"]')
  await page.click('[data-command="filter.offset"]')
  await page.waitForSelector('#filter-offset-horizontal')
  await page.click('#filter-offset-horizontal ~ .slider-number', { clickCount: 3 })
  await page.keyboard.type('40')
  await page.keyboard.press('Enter')
  await page.select('#filter-offset-edge', 'repeat')
  await page.click('[data-dialog^="filter"] .dialog-foot .primary')
  await idle()
  await openMenu('Filter')
  await page.click('[data-submenu="Blur"]')
  await page.click('[data-command="filter.gaussian-blur"]')
  await page.waitForSelector('#filter-gaussian-blur-radius')
  await page.click('#filter-gaussian-blur-radius ~ .slider-number', { clickCount: 3 })
  await page.keyboard.type('6')
  await page.keyboard.press('Enter')
  await page.click('[data-dialog^="filter"] .dialog-foot .primary')
  await idle()
  const rb = await shot()
  check('after Offset’s Repeat Edge Pixels a blur reads round the seam: the band stays solid at the edges', (await at(0, 167, rb))[0] < 40 && (await at(W - 1, 167, rb))[0] < 40, `${await at(0, 167, rb)} / ${await at(W - 1, 167, rb)}`)
}

console.log('\nacross only')
await setTiling('x')
check('Tiled Horizontally repeats across but not down', near(await at(-60, 100), BLACK) || near(await at(-60, 60), WHITE))
check('so above the canvas is the pasteboard', near(await at(100, -40), pasteboard))
await setTiling('off')
check('Off takes the copies away', near(await at(-60, 60), pasteboard))

await finish()
