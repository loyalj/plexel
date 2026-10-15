/**
 * Artboards and symbols in Chrome: New Document with an artboard, the
 * pasteboard round it, Layer → New Artboard, the Artboard tool drawing,
 * moving and sizing one, its name dragged, a shape drawn on one going into
 * it and clipped to it (and not, with Clip off), the Move tool carrying a
 * layer onto another artboard, exporting each artboard (a zip) and the
 * selected one, Release Artboard; then New Symbol, placing instances from
 * the Symbols panel, editing the symbol in its tab with every instance
 * following, undo in the document followed by the tab, Break Link,
 * Rasterize of an instance.
 *
 * Run with: npm run check:boards
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const MOCK_PICKERS = () => {
  const dir = () => navigator.storage.getDirectory().then((d) => d.getDirectoryHandle('picked', { create: true }))
  window.showSaveFilePicker = async ({ suggestedName }) => (await dir()).getFileHandle(suggestedName, { create: true })
}
const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.evaluateOnNewDocument(MOCK_PICKERS)
await page.goto(url)
await waitForEngine(page)
const { press, idle } = pageHelpers(page)

const openMenu = async (menu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
}
const run = async (menu, command, submenu) => {
  await openMenu(menu)
  if (submenu) {
    await page.click(`[data-submenu="${submenu}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const stepIs = (l, timeout = 8000) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout })
const boards = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active().history.present
  return [...d.nodes[d.root].children].map((id) => d.nodes[id]).filter((n) => n.kind === 'group' && n.props.artboard).map((n) => ({ id: n.id, name: n.name, x: n.transform[4], y: n.transform[5], w: n.props.artboard.width, h: n.props.artboard.height, kids: n.children }))
})
const parentOf = (id) => page.evaluate((i) => { const d = globalThis.plexel.documents().active().history.present; return Object.values(d.nodes).find((n) => n.children?.includes(i))?.id ?? null }, id)
/** A document point on the page, through the front view (unrotated, as here). */
const screenOf = (x, y) => page.evaluate((x, y) => {
  const v = globalThis.plexel.views().front()
  const r = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
  return [r.left + r.width / 2 + (x - v.cx) * v.zoom, r.top + r.height / 2 + (y - v.cy) * v.zoom]
}, x, y)
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (x, y, img) => {
  const [sx, sy] = await screenOf(x, y)
  return pixelAt(img ?? (await shot()), Math.round(sx), Math.round(sy)).slice(0, 3)
}
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const dragDoc = async (from, to, { steps = 8, keys = [] } = {}) => {
  const a = await screenOf(...from)
  const b = await screenOf(...to)
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(a[0], a[1])
  await page.mouse.down()
  await page.mouse.move(b[0], b[1], { steps })
  await page.mouse.up()
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(120)
}
const tool = (id) => page.evaluate((t) => globalThis.plexel.tools().set(t), id)
const picked = (name) =>
  page.evaluate(async (n) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')
    return [...new Uint8Array(await (await (await d.getFileHandle(n)).getFile()).arrayBuffer())]
  }, name)
const WHITE = [255, 255, 255]
const RED = [255, 0, 0]

// --- a document that is an artboard ------------------------------------------------------------
console.log('\nNew Document with an artboard')
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('#new-artboard')
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
let b = await boards()
let d = await doc()
check('it starts as one artboard, the size asked for, on a pasteboard round it', b.length === 1 && b[0].w === 800 && b[0].h === 600 && d.width === 1200 && d.height === 1000 && b[0].x === 200, JSON.stringify(b))
check('with an empty layer on it', b[0].kids.length === 1 && d.nodes[b[0].kids[0]].kind === 'pixel')
await press('Control+Digit0')
await settle(200)
await idle()
let img = await shot()
check('the artboard white, the pasteboard round it shaded dark', near(await at(600, 500, img), WHITE) && (await at(60, 60, img)).every((v) => v < 130), `${await at(60, 60, img)}`)
check('its name over it', !!(await page.$(`[data-artboard-label="${b[0].id}"]`)))

console.log('\nNew Artboard')
await run('Layer', 'layer.new-artboard', 'Artboards')
await idle()
b = await boards()
check('Layer → New Artboard: another, the same size, to the right', b.length === 2 && b[1].x === b[0].x + 800 + 100 && b[1].w === 800 && (await label()) === 'New Artboard', JSON.stringify(b.map((x) => [x.x, x.y])))
check('and the canvas grew to hold it', (await doc()).width === b[1].x + 800 + 200)

console.log('\nThe Artboard tool')
await tool('artboard')
await press('Control+Digit0')
await settle(200)
const [a1, a2] = b
// Drawn on the pasteboard below the first.
await dragDoc([a1.x, a1.y + 650], [a1.x + 300, a1.y + 750])
await stepIs('New Artboard')
b = await boards()
const a3 = b.find((x) => x.id !== a1.id && x.id !== a2.id)
check('dragging on the pasteboard draws an artboard', !!a3 && Math.abs(a3.w - 300) <= 2 && Math.abs(a3.h - 100) <= 2, JSON.stringify(a3))
check('and selects it', (await page.evaluate(() => globalThis.plexel.documents().active().selected)) === a3?.id)
await dragDoc([a3.x + 150, a3.y + 50], [a3.x + 250, a3.y + 70])
await stepIs('Move Artboard')
let a3n = (await boards()).find((x) => x.id === a3.id)
check('dragging one moves it', Math.abs(a3n.x - (a3.x + 100)) <= 2 && Math.abs(a3n.y - (a3.y + 20)) <= 2, JSON.stringify(a3n))
// Its bottom right handle.
await dragDoc([a3n.x + a3n.w, a3n.y + a3n.h], [a3n.x + a3n.w + 100, a3n.y + a3n.h + 50], { steps: 6 })
await stepIs('Resize Artboard')
const a3s = (await boards()).find((x) => x.id === a3.id)
check('dragging its corner sizes it', Math.abs(a3s.w - (a3n.w + 100)) <= 2 && Math.abs(a3s.h - (a3n.h + 50)) <= 2 && a3s.x === a3n.x, JSON.stringify(a3s))
// Its name, with another tool.
await tool('brush')
const lab = await (await page.$(`[data-artboard-label="${a3.id}"] span`)).boundingBox()
await page.mouse.move(lab.x + 10, lab.y + lab.height / 2)
await page.mouse.down()
await page.mouse.move(lab.x + 10, lab.y + lab.height / 2 + 30, { steps: 5 })
await page.mouse.up()
await stepIs('Move Artboard')
const a3l = (await boards()).find((x) => x.id === a3.id)
check('its name drags it with any tool', a3l.y > a3s.y + 10, `${a3s.y} → ${a3l.y}`)

console.log('\nLayers on artboards')
await tool('shape')
await page.evaluate((id) => globalThis.plexel.documents().select(id), a1.kids[0])
// A rectangle on the second artboard, over its right edge.
const b2 = (await boards()).find((x) => x.id === a2.id)
await page.evaluate(async () => {
  const p = globalThis.plexel
  p.colours().setFg({ space: 'rgb', profile: { builtin: 'srgb' }, c: [1, 0, 0] })
})
await dragDoc([b2.x + 700, b2.y + 200], [b2.x + 900, b2.y + 300])
await stepIs('Rectangle')
const shape = await page.evaluate(() => globalThis.plexel.documents().active().selected)
check('a shape drawn on an artboard goes into it, though another artboard’s layer was selected', (await parentOf(shape)) === a2.id)
await idle()
img = await shot()
check('it shows on the artboard', near(await at(b2.x + 750, b2.y + 250, img), RED))
check('and is clipped at its edge: the pasteboard past it', !near(await at(b2.x + 850, b2.y + 250, img), RED), `${await at(b2.x + 850, b2.y + 250, img)}`)
await page.evaluate((id) => globalThis.plexel.documents().select(id), a2.id)
await frames(page)
await page.click('[data-artboard-clip]')
await idle()
{
  const c = await at(b2.x + 850, b2.y + 250)
  check('Clip contents off: it runs over the edge, shown through the pasteboard', c[0] > c[1] + 60 && c[0] > c[2] + 60, String(c))
}
await page.click('[data-artboard-clip]')
await idle()
// Carried onto the first artboard with the Move tool.
await tool('move')
await page.evaluate((id) => globalThis.plexel.documents().select(id), shape)
await dragDoc([b2.x + 750, b2.y + 250], [a1.x + 300, a1.y + 250])
await stepIs('Move')
check('the Move tool carries a layer onto another artboard: it goes into it', (await parentOf(shape)) === a1.id)

console.log('\nExporting artboards')
await run('File', 'file.export')
await page.waitForSelector('#export-scope')
check('the Export dialog offers the artboards', !!(await page.$('#export-scope-artboards')) && !!(await page.$('#export-scope-canvas')))
await page.select('#export-format', 'png')
await page.click('#export-scope-artboards')
await page.click('[data-dialog="export"] .dialog-foot .primary')
const zipName = `${d.name} artboards.zip`
await waitUntil(page, (n) => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('picked')).then((p) => p.getFileHandle(n)).then((h) => h.getFile()).then((f) => f.size > 100, () => false), { args: [zipName], timeout: 15000, polling: 200 })
const zip = Buffer.from(await picked(zipName).catch(() => []))
const names = [...zip.toString('latin1').matchAll(/Artboard \d\.png/g)].map((m) => m[0])
check('All artboards: a zip with a PNG for each', new Set(names).size === 3, [...new Set(names)].join())
await page.evaluate((id) => globalThis.plexel.documents().select(id), a2.id)
await run('File', 'file.export')
await page.waitForSelector('#export-scope-artboard')
await page.click('#export-scope-artboard')
await page.click('[data-dialog="export"] .dialog-foot .primary')
const one = `${d.name} - Artboard 2.png`
await waitUntil(page, (n) => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('picked')).then((p) => p.getFileHandle(n)).then((h) => h.getFile()).then((f) => f.size > 100, () => false), { args: [one], timeout: 15000, polling: 200 })
const png = decodePng(Buffer.from(await picked(one)))
check('the selected artboard alone: its size, its background', png.width === 800 && png.height === 600 && near(pixelAt(png, 400, 300).slice(0, 3), WHITE), `${png.width}×${png.height}`)

console.log('\nRelease Artboard')
await page.evaluate((id) => globalThis.plexel.documents().select(id), a3.id)
await run('Layer', 'layer.release-artboard', 'Artboards')
check('Release Artboard: it goes, its layers (none) stay', (await boards()).length === 2 && (await label()) === 'Release Artboard')

// --- symbols ------------------------------------------------------------------------------------
console.log('\nSymbols')
await page.evaluate((id) => globalThis.plexel.documents().select(id), shape)
await press('F8')
await stepIs('New Symbol')
d = await doc()
const inst = await page.evaluate(() => globalThis.plexel.documents().active().selected)
check('F8 makes a symbol of the shape, an instance in its place', d.symbols?.length === 1 && d.nodes[inst]?.kind === 'symbol' && (await parentOf(inst)) === a1.id)
await idle()
check('the instance looks as the shape did', near(await at(a1.x + 300, a1.y + 250), RED))
await page.waitForSelector('[data-panel="symbols"] .symbol-place')
check('the Symbols panel lists it, one instance', (await page.$eval('[data-symbol-count]', (e) => e.dataset.symbolCount)) === '1')
await page.click('.symbol-place')
await stepIs('Place Symbol')
check('placed from the panel: two instances', (await page.$eval('[data-symbol-count]', (e) => e.dataset.symbolCount)) === '2')
const inst2 = await page.evaluate(() => globalThis.plexel.documents().active().selected)
const i2 = (await doc()).nodes[inst2]
// Edit the symbol: blue, in its tab.
await page.click('[data-symbol-edit]')
await waitUntil(page, () => globalThis.plexel.documents().getState().docs.length === 2 && !!globalThis.plexel.documents().active().symbolOf)
await page.evaluate(() => {
  const p = globalThis.plexel
  const doc = p.documents().active().history.present
  const s = Object.values(doc.nodes).find((n) => n.kind === 'vector')
  p.documents().commit((x) => ({ ...x, nodes: { ...x.nodes, [s.id]: { ...s, props: { ...s.props, appearance: s.props.appearance.map((it) => ({ ...it, paint: { kind: 'solid', colour: [0, 0, 1] } })) } } } }), { label: 'Blue' })
})
await frames(page)
await page.evaluate(() => { const p = globalThis.plexel; p.documents().activate(p.documents().getState().docs[0].key) })
await settle(200)
await idle()
img = await shot()
check('edited in its tab, every instance follows', near(await at(a1.x + 300, a1.y + 250, img), [0, 0, 255]) && near(await at(i2.transform[4] + 10, i2.transform[5] + 10, img), [0, 0, 255]), `${await at(a1.x + 300, a1.y + 250, img)}`)
check('as one step in the document', (await label()) === 'Edit Symbol')
await press('Control+KeyZ')
await idle()
check('undone in the document, the instances are red again', near(await at(a1.x + 300, a1.y + 250), RED))
check('and the symbol’s tab follows', await page.evaluate(() => {
  const tab = globalThis.plexel.documents().getState().docs.find((x) => x.symbolOf)
  const v = Object.values(tab.history.present.nodes).find((n) => n.kind === 'vector')
  return v.props.appearance[0].paint.colour.join() === '1,0,0'
}))
// Break Link.
await page.evaluate((id) => globalThis.plexel.documents().select(id), inst2)
await run('Layer', 'layer.break-symbol', 'Symbols')
await stepIs('Break Link to Symbol')
check('Break Link: a group of its own, one instance left', (await doc()).nodes[await page.evaluate(() => globalThis.plexel.documents().active().selected)].kind === 'group' && (await page.$eval('[data-symbol-count]', (e) => e.dataset.symbolCount)) === '1')
// Rasterize an instance.
await page.evaluate((id) => globalThis.plexel.documents().select(id), inst)
await run('Layer', 'layer.rasterize')
await stepIs('Rasterize')
await idle()
check('Rasterize makes an instance pixels, looking the same', (await doc()).nodes[inst].kind === 'pixel' && near(await at(a1.x + 300, a1.y + 250), RED), `${(await doc()).nodes[inst].kind} ${await at(a1.x + 300, a1.y + 250)} ${await label()}`)

await finish()
