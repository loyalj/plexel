/**
 * Effects per fill and stroke, and graphic styles, in Chrome: a Drop
 * Shadow and an Offset Path on one fill of a shape from Properties, then
 * the Graphic Styles panel: a style made from the shape, given to another,
 * redefined (both change), and a link broken by a change of the shape's own.
 *
 * The document is 400 × 300 at 100%, centred: a document point is the
 * canvas's centre plus (x − 200, y − 150) on screen.
 *
 * Run with: npm run check:appearance
 */
import { check, finish, frames, open, pageHelpers, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

const W = 400
const H = 300
const { press } = pageHelpers(page)
const idle = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
  await frames(page)
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const at = async (x, y) => {
  const r = await rect()
  const img = decodePng(Buffer.from(await page.screenshot()))
  return pixelAt(img, Math.round(r.x + r.w / 2 + x - W / 2), Math.round(r.y + r.h / 2 + y - H / 2)).slice(0, 3)
}
const near = (a, b, tol = 12) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const node = (id) => page.evaluate((i) => globalThis.plexel.documents().active().history.present.nodes[i], id)
const select = async (id) => {
  await page.evaluate((i) => globalThis.plexel.documents().select(i, globalThis.plexel.documents().active().key), id)
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
  const box = (id, x, colour) =>
    P.doc.makeNode('vector', id, id, {
      geometry: { kind: 'shape', shape: { type: 'rect', x, y: 100, w: 100, h: 80, radii: [0, 0, 0, 0], corner: 'round' } },
      appearance: [{ kind: 'fill', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'solid', colour } }],
      graphicStyle: null,
    })
  P.documents().commit((x) => P.doc.insertNode(P.doc.insertNode(x, box('one', 50, [0.9, 0.1, 0.1]), x.root, 1), box('two', 250, [0.1, 0.1, 0.9]), x.root, 2), { key: d.key, label: 'Shapes' })
  P.documents().select('one', d.key)
})
await idle()
check('two boxes, red and blue', near(await at(100, 140), [230, 26, 26], 15) && near(await at(300, 140), [26, 26, 230], 15))

console.log('\neffects on one fill')
// The top fill's editor is open to start with.
await page.waitForSelector('[data-item-effect-add]')
await page.select('[data-item-effect-add]', 'drop-shadow')
await idle()
let n = await node('one')
check('a Drop Shadow on the fill, from Properties', n.props.appearance[0].effects?.[0]?.kind === 'drop-shadow')
const shadow = await at(151, 183)
check('drawn: a shadow below and right of the box', shadow[0] < 240 && near(await at(40, 90), [255, 255, 255], 6), String(shadow))
await page.select('[data-item-effect-add]', 'offset')
await idle()
n = await node('one')
check('an Offset Path after it', n.props.appearance[0].effects?.[1]?.kind === 'offset')
const grown = await at(45, 140)
check('the fill reaches 10 px past the box', near(grown, [230, 26, 26], 20), String(grown))

console.log('\ngraphic styles')
await page.evaluate(() => {
  const els = [...document.querySelectorAll('.menu-title')]
  els.find((b) => b.textContent === 'Window').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
})
await frames(page)
await page.click('[data-command="window.panel.graphic-styles"]')
await page.waitForSelector('[data-graphic-styles="new"]')
await page.click('[data-graphic-styles="new"]')
await idle()
const styles = await page.evaluate(() => globalThis.plexel.documents().active().history.present.graphicStyles ?? [])
n = await node('one')
check('New from Selection makes a style of the box’s look, the box linked', styles.length === 1 && n.props.graphicStyle === styles[0].id && styles[0].appearance[0].effects?.length === 2)
await select('two')
await page.click(`[data-graphic-style="${styles[0].id}"] .style-apply`)
await idle()
const two = await node('two')
check('clicking the style gives it to the other box, linked', two.props.graphicStyle === styles[0].id && two.props.appearance[0].effects?.length === 2)
check('which turns red, its shadow with it', near(await at(300, 140), [230, 26, 26], 15) && (await at(351, 183))[0] < 240)
check('Properties says which style it has', !!(await page.$('[data-graphic-style-link]')))
// Redefine from a box made green: both change.
await page.evaluate(() => {
  const P = globalThis.plexel
  const d = P.documents().active()
  const n = d.history.present.nodes.two
  const appearance = n.props.appearance.map((it, i) => (i === 0 ? { ...it, paint: { kind: 'solid', colour: [0.1, 0.8, 0.1] } } : it))
  P.documents().commit((x) => ({ ...x, nodes: { ...x.nodes, two: { ...n, props: { ...n.props, appearance } } } }), { key: d.key, label: 'Green' })
})
await page.click(`[data-graphic-style="${styles[0].id}"] [data-style-redefine]`)
await idle()
check('Redefine: every box linked to the style turns green', near(await at(100, 140), [26, 204, 26], 20) && near(await at(300, 140), [26, 204, 26], 20), `${await at(100, 140)} ${await at(300, 140)}`)
// A change of the box's own breaks its link.
await select('one')
await page.waitForSelector('[data-item-effect="drop-shadow"] input[type="checkbox"]')
await page.click('[data-item-effect="drop-shadow"] input[type="checkbox"]')
await idle()
n = await node('one')
check('switching off an effect is a change of its own: its link is broken', n.props.graphicStyle === null && n.props.appearance[0].effects[0].enabled === false)

await finish()
