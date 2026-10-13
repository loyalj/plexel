/**
 * Vector construction, in Chrome: Pathfinder's Divide and Minus Front on
 * two overlapping shapes, the Shape Builder merging regions and deleting
 * one, the Live Paint Bucket filling the overlap (and Alt emptying it),
 * Outline Stroke, Offset Path and Simplify from their menus and dialogs.
 *
 * The document is 400 × 300 at 100%, centred: a document point is the
 * canvas's centre plus (x − 200, y − 150) on screen.
 *
 * Run with: npm run check:construct
 */
import { check, finish, frames, open, settle, waitUntil, waitForEngine } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

const W = 400
const H = 300
const press = async (combo) => {
  const keys = combo.split('+')
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k)
  await page.keyboard.press(keys[keys.length - 1])
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k)
  await frames(page)
}
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
const at = async (x, y) => {
  const [sx, sy] = await screen(x, y)
  return pixelAt(decodePng(Buffer.from(await page.screenshot())), Math.round(sx), Math.round(sy)).slice(0, 3)
}
const near = (a, b, tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const RED = [230, 26, 26]
const BLUE = [26, 26, 230]
const WHITE = [255, 255, 255]
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const waitStep = (l) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout: 15000 }).then(() => true, () => false)
const shapes = () => page.evaluate(() => Object.values(globalThis.plexel.documents().active().history.present.nodes).filter((n) => n.kind === 'vector').length)
const menu = async (m, sub, command) => {
  await page.evaluate((x) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === x).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), m)
  await frames(page)
  if (sub) {
    await page.click(`[data-submenu="${sub}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const selectBoth = async () => {
  await page.evaluate(() => {
    const P = globalThis.plexel
    const d = P.documents().active()
    P.documents().selectMany(['one', 'two'], 'two', d.key)
  })
  await idle()
}
const undo = async () => {
  await press('Control+KeyZ')
  await idle()
}

await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', W], ['#new-height', H]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await press('Control+Digit1')
await page.evaluate(() => {
  const P = globalThis.plexel
  const d = P.documents().active()
  const box = (id, x, y, colour, stroke) =>
    P.doc.makeNode('vector', id, id, {
      geometry: { kind: 'shape', shape: { type: 'rect', x, y, w: 120, h: 100, radii: [0, 0, 0, 0], corner: 'round' } },
      appearance: [{ kind: 'fill', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'solid', colour } }, ...(stroke ? [stroke] : [])],
      graphicStyle: null,
    })
  P.documents().commit((x) => P.doc.insertNode(P.doc.insertNode(x, box('one', 80, 60, [0.9, 0.1, 0.1]), x.root, 1), box('two', 140, 110, [0.1, 0.1, 0.9]), x.root, 2), { key: d.key, label: 'Shapes' })
})
await selectBoth()
check('two overlapping boxes', near(await at(100, 80), RED) && near(await at(180, 140), BLUE) && near(await at(240, 190), BLUE))

console.log('\nPathfinder')
await menu('Layer', 'Pathfinder', 'shape.pf-divide')
check('Divide is one step', await waitStep('Divide'))
check('into three shapes, in a group', (await shapes()) === 3)
await idle()
check('each region the colour of the box on top of it', near(await at(100, 80), RED) && near(await at(180, 140), BLUE) && near(await at(240, 190), BLUE))
await undo()
await selectBoth()
await menu('Layer', 'Pathfinder', 'shape.pf-minus-front')
check('Minus Front is one step', await waitStep('Minus Front'))
await idle()
check('the front box is cut out of the back one', (await shapes()) === 1 && near(await at(100, 80), RED) && near(await at(180, 140), WHITE) && near(await at(240, 190), WHITE))
await undo()

console.log('\nthe Shape Builder')
await selectBoth()
await page.evaluate(() => globalThis.plexel.tools().set('builder'))
const drag = async (from, to, mods = []) => {
  for (const m of mods) await page.keyboard.down(m)
  const [x0, y0] = await screen(...from)
  const [x1, y1] = await screen(...to)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y1, { steps: 10 })
  await page.mouse.up()
  for (const m of mods) await page.keyboard.up(m)
  await settle(150)
  await idle()
}
// From the red-only part across the overlap: those two become one, the blue-only part stays apart.
await drag([100, 80], [180, 140])
check('a drag across regions merges them', await waitStep('Shape Builder'))
check('two shapes now: the merged one and the rest', (await shapes()) === 2)
check('the merged one takes the look of where the drag began', near(await at(180, 140), RED) && near(await at(240, 190), BLUE))
await drag([240, 190], [245, 195], ['Alt'])
check('Alt-drag deletes a region', (await label()) === 'Shape Builder Delete' && (await shapes()) === 1 && near(await at(240, 190), WHITE))
await undo()
await undo()

console.log('\nLive Paint')
await selectBoth()
await page.evaluate(() => {
  const p = globalThis.plexel.documents().active().history.present
  globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: [0.1, 0.8, 0.1] })
  globalThis.plexel.tools().set('livepaint')
})
{
  const [x, y] = await screen(180, 140)
  await page.mouse.click(x, y)
}
check('the Live Paint Bucket makes a Live Paint group of the shapes, then paints', await waitStep('Live Paint'))
await idle()
check('the overlap is green, the rest as it was', near(await at(180, 140), [26, 204, 26], 20) && near(await at(100, 80), RED) && near(await at(240, 190), BLUE), `${await at(180, 140)}`)
{
  await page.keyboard.down('Alt')
  const [x, y] = await screen(180, 140)
  await page.mouse.click(x, y)
  await page.keyboard.up('Alt')
}
await idle()
check('Alt-click empties the region', near(await at(180, 140), WHITE), String(await at(180, 140)))
// Moving the group carries its fills with it.
await page.evaluate(() => globalThis.plexel.tools().set('move'))
await undo()
await menu('Layer', 'Live Paint', 'shape.live-expand')
check('Expand makes shapes of the regions', await waitStep('Expand Live Paint'))
await idle()
check('drawn as it was', near(await at(180, 140), [26, 204, 26], 20) && near(await at(100, 80), RED))
await undo()
await undo()
await undo()

console.log('\nOutline Stroke, Offset Path, Simplify')
await page.evaluate(() => {
  const P = globalThis.plexel
  const d = P.documents().active()
  const n = d.history.present.nodes.one
  const appearance = [...n.props.appearance, { kind: 'stroke', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'solid', colour: [0, 0, 0] }, width: 6, join: 'miter', cap: 'butt', miter: 4, dash: [], dashOffset: 0, align: 'centre' }]
  P.documents().commit((x) => ({ ...x, nodes: { ...x.nodes, one: { ...n, props: { ...n.props, appearance } } } }), { key: d.key, label: 'Stroke' })
  P.documents().select('one', d.key)
})
await idle()
const edge = await at(80, 100)
await menu('Layer', 'Path', 'shape.outline-stroke')
check('Outline Stroke is one step', await waitStep('Outline Stroke'))
const outlined = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const doc = d.history.present
  return { strokes: doc.nodes.one.props.appearance.filter((i) => i.kind === 'stroke').length, made: doc.nodes[d.selected].props.appearance[0].kind }
})
check('the stroke a shape of its own, filled, and off the box', outlined.strokes === 0 && outlined.made === 'fill')
await idle()
check('looking as it did', near(await at(80, 100), edge, 20), `${await at(80, 100)} vs ${edge}`)
await undo()
await page.evaluate(() => globalThis.plexel.documents().select('one', globalThis.plexel.documents().active().key))
await menu('Layer', 'Path', 'shape.offset-path')
await page.waitForSelector('[data-dialog="offsetPath"]')
await settle(300)
await page.click('[data-dialog="offsetPath"] .dialog-foot .primary')
check('Offset Path is one step', await waitStep('Offset Path'))
await idle()
check('a shape 10 px bigger, below the box', near(await at(74, 100), RED), String(await at(74, 100)))
await undo()
await page.evaluate(() => globalThis.plexel.documents().select('one', globalThis.plexel.documents().active().key))
await menu('Layer', 'Path', 'shape.simplify')
await page.waitForSelector('[data-simplify-counts]')
check('Simplify counts the anchors before and after', /anchors, then/.test(await page.$eval('[data-simplify-counts]', (e) => e.textContent)))
await page.click('[data-dialog="simplify"] .dialog-foot .primary')
check('and is one step', await waitStep('Simplify'))

await finish()
