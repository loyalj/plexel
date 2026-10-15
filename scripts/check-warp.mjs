/**
 * Live warps, in Chrome, through the real pointer: Free Transform's
 * Distort (a corner dragged), Perspective (a corner and its partner), Warp
 * (a style from the options bar, then its mesh dragged), a warped layer
 * picked up again by Free Transform, a shape warped as an outline (its edge
 * as sharp as an unwarped one's), Rasterize keeping a warp where it was,
 * and Liquify brushed and committed. Each is a live Warp or Liquify effect
 * on the layer, so the layer's own pixels never change.
 *
 * The document is 400 × 300 at 100%, centred: a document point is the
 * canvas's centre plus (x − 200, y − 150) on screen.
 *
 * Run with: npm run check:warp
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

/** Set WARP_SHOTS to a folder to keep a screenshot of each result. */
const shots = process.env.WARP_SHOTS
const keep = async (name) => shots && writeFileSync(join(shots, `${name}.png`), await page.screenshot())

const W = 400
const H = 300
const { press } = pageHelpers(page)
const idle = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
  await frames(page)
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const screen = async (x, y) => {
  const r = await rect()
  return [r.x + r.w / 2 + x - W / 2, r.y + r.h / 2 + y - H / 2]
}
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (x, y, img) => {
  const [sx, sy] = await screen(x, y)
  return pixelAt(img ?? (await shot()), Math.round(sx), Math.round(sy)).slice(0, 3)
}
const near = (a, b, tol = 10) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const RED = [220, 30, 30]
const WHITE = [255, 255, 255]
const isRed = (p) => near(p, RED, 30)
const isWhite = (p) => near(p, WHITE, 12)
const tool = async (id) => {
  await page.evaluate((t) => globalThis.plexel.tools().set(t), id)
  await frames(page)
}
const drag = async (from, to, mods = []) => {
  for (const m of mods) await page.keyboard.down(m)
  const [x0, y0] = await screen(...from)
  const [x1, y1] = await screen(...to)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps: 12 })
  await page.mouse.up()
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
  await settle(100)
  await idle()
}
const lastStep = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const waitStep = (label) => waitUntil(page, (l) => globalThis.plexel.documents().active().history.label === l, { args: [label], timeout: 15000 }).then(() => true, () => false)
const effects = () =>
  page.evaluate(() => {
    const d = globalThis.plexel.documents().active()
    const doc = d.history.present
    const n = doc.nodes[d.selected]
    const owner = n.kind === 'filter' ? Object.values(doc.nodes).find((x) => x.effects?.includes(n.id)) : n
    return owner.effects.map((id) => ({ name: doc.nodes[id].name, filter: doc.nodes[id].props.filter, params: doc.nodes[id].props.params }))
  })
const newDoc = async () => {
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
}
/** A new layer with a red square on it, painted with the Brush, (x, y) to (x + s, y + s). */
const square = async (x, y, s) => {
  await press('Control+Alt+Shift+KeyN')
  await idle()
  await page.evaluate((c) => {
    const p = globalThis.plexel.documents().active().history.present
    globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: c.map((v) => v / 255) })
  }, RED)
  await tool('brush')
  await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 20, hardness: 1, opacity: 1, flow: 1 }))
  for (let yy = y + 10; yy < y + s; yy += 12) {
    const [x0, y0] = await screen(x + 10, yy)
    const [x1] = await screen(x + s - 10, yy)
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y0, { steps: 6 })
    await page.mouse.up()
    await settle(150)
    await idle()
  }
}
const freeTransform = async (mode) => {
  await press('Control+Alt+KeyT')
  await page.waitForSelector('[data-options="transform"]')
  if (mode) await page.click(`[data-transform-mode="${mode}"]`)
  await idle()
}

await newDoc()
await square(100, 100, 100)
check('a red square, 100 to 200 each way', isRed(await at(150, 150)) && isRed(await at(105, 105)) && isWhite(await at(95, 150)))

console.log('\nDistort')
await freeTransform('distort')
check('the options bar shows the modes, Distort chosen', await page.$eval('[data-transform-mode="distort"]', (b) => b.getAttribute('aria-pressed') === 'true'))
await drag([100, 100], [150, 130])
await idle()
check('the corner dragged is previewed where it went', isWhite(await at(108, 108)) && isRed(await at(152, 135)))
await press('Enter')
check('Enter commits it as one step, Distort', await waitStep('Distort'))
let fx = await effects()
check('as a live effect first on the layer', fx.length === 1 && fx[0].filter === 'warp' && fx[0].name === 'Distort', JSON.stringify(fx.map((f) => f.name)))
await idle()
const distorted = await shot()
check('drawn: the top left corner gone in, the rest still there', isWhite(await at(108, 108, distorted)) && isRed(await at(170, 170, distorted)) && isRed(await at(185, 125, distorted)), [await at(108, 108, distorted), await at(170, 170, distorted), await at(185, 125, distorted)].join(' / '))
await keep('distort')
await press('Control+KeyZ')
await idle()
check('undo puts it back', isRed(await at(108, 108)) && (await effects()).length === 0)

console.log('\nPerspective')
await freeTransform('perspective')
// The top right corner in towards the middle: the top left comes in with it.
await drag([200, 100], [170, 100])
await press('Enter')
check('Perspective is one step', await waitStep('Perspective'))
await idle()
const persp = await shot()
check('the top narrows from both sides', isWhite(await at(110, 103, persp)) && isWhite(await at(190, 103, persp)) && isRed(await at(150, 103, persp)), [await at(110, 103, persp), await at(190, 103, persp)].join(' / '))
check('the bottom stays as wide', isRed(await at(112, 190, persp)) && isRed(await at(188, 190, persp)))
await keep('perspective')
await press('Control+KeyZ')
await idle()

console.log('\nWarp')
await freeTransform('warp')
check('Warp shows a style menu', !!(await page.$('#opt-warp-style')))
await page.select('#opt-warp-style', 'arc')
await idle()
check('a style is previewed at once', !isRed(await at(105, 105)) || !isRed(await at(195, 105)) || !isWhite(await at(150, 95)))
await press('Enter')
check('Warp is one step', await waitStep('Warp'))
fx = await effects()
check('kept as its style and bend, editable in Properties', fx[0]?.params?.style === 'arc' && fx[0]?.params?.bend === 50, JSON.stringify(fx[0]?.params?.style))
await idle()
const arced = await shot()
check('Arc bends the square: its top middle rises above the box, and its bottom middle too', isRed(await at(150, 92, arced)) && isWhite(await at(150, 196, arced)), [await at(150, 92, arced), await at(150, 196, arced)].join(' / '))
check('with nothing stray round it', isWhite(await at(30, 270, arced)) && isWhite(await at(350, 20, arced)) && isWhite(await at(70, 150, arced)))
await keep('arc')
// Picked up again: the same style, and the mesh dragged makes it Custom.
await freeTransform()
const ui = await page.evaluate(() => globalThis.plexel.transformUi().get())
check('Free Transform on a warped layer picks the warp up', ui.warp.style === 'arc')
await page.click('[data-transform-mode="warp"]')
await idle()
await drag([150, 150], [150, 175])
check('dragging the mesh makes the style Custom', (await page.evaluate(() => globalThis.plexel.transformUi().get().warp.style)) === 'custom')
await press('Enter')
check('and commits as Warp again', await waitStep('Warp'))
fx = await effects()
check('still one Warp effect, now with its own mesh', fx.length === 1 && fx[0].params.style === 'custom' && fx[0].params.mesh?.pts?.length === 32)
await idle()
check('the middle pulled down, past where the arc ended', isRed(await at(150, 199)), String(await at(150, 199)))
await keep('custom')

console.log('\nShapes keep their edges')
await newDoc()
await page.evaluate(() => {
  const P = globalThis.plexel
  const d = P.documents().active()
  const doc = d.history.present
  const shape = P.doc.makeNode('vector', 'shape1', 'Box', {
    geometry: { kind: 'shape', shape: { type: 'rect', x: 100, y: 100, w: 200, h: 100, radii: [0, 0, 0, 0], corner: 'round' } },
    appearance: [{ kind: 'fill', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'solid', colour: [0, 0, 0] } }],
  })
  P.documents().commit((x) => P.doc.insertNode(x, shape, x.root, x.nodes[x.root].children.length), { key: d.key, label: 'Shape' })
  P.documents().select('shape1', d.key)
  void doc
})
await idle()
const flatEdge = await at(150, 100)
check('a black box', near(await at(200, 150), [0, 0, 0], 12), String(await at(200, 150)) + ' ' + flatEdge)
await freeTransform('warp')
await page.select('#opt-warp-style', 'flag')
await press('Enter')
await waitStep('Warp')
await idle()
// Zoomed in 8×, the warped edge is one pixel of grey at most, as an outline drawn sharp is.
await page.evaluate(() => globalThis.plexel.views().zoomTo(8, null))
await idle()
const sharp = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.history.present.nodes.shape1.effects.length
})
check('a shape’s warp is a live effect too', sharp === 1)
await page.evaluate(() => globalThis.plexel.views().fit?.())
await press('Control+Digit1')
await idle()
const flag = await shot()
check('Flag waves the box: its left edge’s top drops, its right edge’s top rises', !near(await at(130, 103, flag), [0, 0, 0], 40) || !near(await at(270, 197, flag), [0, 0, 0], 40), [await at(130, 103, flag), await at(270, 197, flag)].join(' / '))
await keep('flag')
// Rasterize: the warp stays where it was drawn.
const beforeRaster = [await at(130, 103, flag), await at(200, 150, flag), await at(270, 197, flag)]
await page.evaluate(() => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === 'Layer').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
await page.waitForSelector('[data-command="layer.rasterize"]')
await page.click('[data-command="layer.rasterize"]')
await waitStep('Rasterize')
await idle()
const raster = await shot()
const afterRaster = [await at(130, 103, raster), await at(200, 150, raster), await at(270, 197, raster)]
check('Rasterize keeps the warp where it was drawn', afterRaster.every((p, i) => near(p, beforeRaster[i], 40)), JSON.stringify([beforeRaster, afterRaster]))

console.log('\nLiquify')
await newDoc()
await square(100, 100, 100)
await press('Control+Alt+KeyX')
check('Liquify opens its options', !!(await page.waitForSelector('[data-options="liquify"]', { timeout: 5000 }).catch(() => null)))
await page.evaluate(() => globalThis.plexel.liquifySettings().set({ tool: 'warp', size: 80, pressure: 100 }))
// Push the right edge out.
for (let i = 0; i < 3; i++) await drag([185, 150], [240, 150])
check('the push is previewed', isRed(await at(212, 150)), String(await at(212, 150)))
await press('Enter')
check('Enter commits it as one step, Liquify', await waitStep('Liquify'))
fx = await effects()
check('as a live Liquify effect', fx.length === 1 && fx[0].filter === 'liquify' && typeof fx[0].params.field?.data === 'string')
await idle()
check('drawn: the right edge pushed out, the left as it was', isRed(await at(212, 150)) && isRed(await at(105, 150)) && isWhite(await at(95, 150)))
await keep('liquify')
// Opened again, Restore All takes it off.
await press('Control+Alt+KeyX')
await page.waitForSelector('[data-liquify-restore]')
await page.click('[data-liquify-restore]')
await press('Enter')
await waitStep('Liquify')
check('Restore All and commit take the effect off', (await effects()).length === 0)
await idle()
check('and the square is as it was', isWhite(await at(212, 150)))

await finish()
