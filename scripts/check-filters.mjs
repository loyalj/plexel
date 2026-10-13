/**
 * The filter and adjustment pack, in Chrome: the Filter menu's submenus, a
 * distortion (Twirl, kept on the layer's box) and a blur (Lens Blur) from
 * their dialogs, an effect's own blend mode, a filter layer blurring
 * everything below it, Document → Adjustments applied to a layer's pixels
 * for good, and Colour Lookup reading a .cube file.
 *
 * The document is 400 × 300 at 100%, centred: a document point is the
 * canvas's centre plus (x − 200, y − 150) on screen.
 *
 * Run with: npm run check:filters
 */
import { check, finish, frames, open, settle, waitUntil, waitForEngine } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (x, y, img) => {
  const [sx, sy] = await screen(x, y)
  return pixelAt(img ?? (await shot()), Math.round(sx), Math.round(sy)).slice(0, 3)
}
const near = (a, b, tol = 10) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const RED = [220, 30, 30]
const waitStep = (label) => waitUntil(page, (l) => globalThis.plexel.documents().active().history.label === l, { args: [label], timeout: 15000 }).then(() => true, () => false)
const openMenu = async (m) => {
  await page.evaluate((x) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === x).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), m)
  await frames(page)
}
const menu = async (m, sub, command) => {
  await openMenu(m)
  if (sub) {
    await page.click(`[data-submenu="${sub}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const ok = async () => {
  await page.click('[data-dialog] .dialog-foot .primary')
  await frames(page)
}
const selectedNode = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.history.present.nodes[d.selected]
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
/** A new layer with a red square on it, (x, y) to (x + s, y + s), filled through a selection. */
const square = async (x, y, s) => {
  await press('Control+Alt+Shift+KeyN')
  await idle()
  await page.evaluate((c) => {
    const p = globalThis.plexel.documents().active().history.present
    globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: c.map((v) => v / 255) })
  }, RED)
  await page.evaluate(() => globalThis.plexel.tools().set('brush'))
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

await newDoc()
await square(100, 100, 120)
await page.evaluate(() => globalThis.plexel.tools().set('move'))
await page.mouse.move(5, 5)
await idle()

console.log('\nthe Filter menu')
await openMenu('Filter')
const subs = await page.$$eval('[data-submenu]', (els) => els.map((e) => e.getAttribute('data-submenu')))
check('the filters are in Photoshop’s submenus', ['Blur', 'Distort', 'Noise', 'Pixelate', 'Render', 'Sharpen', 'Stylize', 'Other'].every((s) => subs.includes(s)), subs.join())
await page.keyboard.press('Escape')
await frames(page)

console.log('\nTwirl')
// A white bar across the square's middle, for the twirl to turn.
await page.evaluate(() => {
  const p = globalThis.plexel.documents().active().history.present
  globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: [1, 1, 1] })
  globalThis.plexel.tools().set('brush')
  globalThis.plexel.brushes().update('brush', { size: 8 })
})
{
  const [x0, y0] = await screen(115, 160)
  const [x1] = await screen(205, 160)
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x1, y0, { steps: 8 })
  await page.mouse.up()
  await settle(200)
  await page.evaluate(() => globalThis.plexel.tools().set('move'))
  await page.mouse.move(5, 5)
  await idle()
}
const before = await shot()
await menu('Filter', 'Distort', 'filter.twirl')
await page.waitForSelector('[data-dialog="filter"]')
await settle(400)
await ok()
check('Twirl is one step', await waitStep('Twirl'))
let n = await selectedNode()
const fx = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const doc = d.history.present
  const layer = Object.values(doc.nodes).find((x) => x.effects?.length)
  return layer.effects.map((id) => doc.nodes[id])
})
check('kept on the layer’s box', Array.isArray(fx[0]?.props.params.frame) && fx[0].props.params.frame[0] > 100, JSON.stringify(fx[0]?.props.params.frame))
await idle()
const twirled = await shot()
// The bar turns most at the middle, not at all at the circle's edge.
let moved = 0
for (let x = 130; x <= 190; x += 5) for (let y = 145; y <= 175; y += 5) if (!near(await at(x, y, before), await at(x, y, twirled), 30)) moved++
check('the bar across the middle turns', moved > 4, `${moved} points differ`)
check('its corners stay put', near(await at(105, 105, twirled), await at(105, 105, before), 30))
await press('Control+KeyZ')
await idle()

console.log('\nLens Blur, and an effect’s blend mode')
await menu('Filter', 'Blur', 'filter.lens-blur')
await page.waitForSelector('[data-dialog="filter"]')
await ok()
check('Lens Blur is one step', await waitStep('Lens Blur'))
await idle()
const blurred = await shot()
const edge = await at(97, 160, blurred)
check('the square’s edge is out of focus', edge[1] < 240 && edge[1] > 40, String(edge))
// The effect selected, its blend mode in Properties.
await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const doc = d.history.present
  const e = Object.values(doc.nodes).find((x) => x.kind === 'filter')
  globalThis.plexel.documents().select(e.id, d.key)
})
await page.waitForSelector('#props-filter-blend')
await page.select('#props-filter-blend', 'darken')
await idle()
n = await selectedNode()
check('an effect takes a blend mode of its own, in Properties', n.blend === 'darken')
const darkened = await shot()
check('Darken keeps the square red inside the blur’s halo', (await at(97, 160, darkened))[1] >= edge[1] - 2, `${await at(97, 160, darkened)} after ${edge}`)
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()

console.log('\nA filter layer')
await menu('Layer', 'New Filter Layer', 'layer.filter-gaussian-blur')
check('a filter layer is one step', await waitStep('New Gaussian Blur Layer'))
n = await selectedNode()
check('a filter among the layers', n.kind === 'filter' && n.props.filter === 'gaussian-blur')
await idle()
const layered = await shot()
const soft = await at(98, 160, layered)
check('it blurs everything below it', soft[1] < 245 && soft[1] > 30, String(soft))
check('the Properties panel calls it a filter layer', (await page.$eval('[data-props="filter"] .layer-kind', (e) => e.textContent)) === 'Filter Layer')
// Painted below it, a stroke comes up blurred.
await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  globalThis.plexel.documents().select(d.history.present.nodes[d.history.present.root].children[1], d.key)
})
await press('Control+KeyZ')
await idle()

console.log('\nAdjustments applied for good')
const sq = await page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  const root = d.history.present.nodes[d.history.present.root]
  const id = root.children[root.children.length - 1]
  globalThis.plexel.documents().select(id, d.key)
  return id
})
await menu('Document', 'Adjustments', 'doc.adjust-photo-filter')
await page.waitForSelector('[data-dialog="adjust"]')
check('a pixel layer’s adjustment starts as for good', !(await page.$eval('#adjust-live', (e) => e.checked)))
await page.select('#adjust-photo-filter-filter', 'cooling-80')
await settle(300)
await ok()
check('Photo Filter is one step', await waitStep('Photo Filter'))
const changed = await page.evaluate((id) => globalThis.plexel.documents().active().history.present.nodes[id].effects.length, sq)
check('in the layer’s pixels, not its effects', changed === 0)
await idle()
const cooled = await at(160, 130)
check('the red is cooler', !near(cooled, RED, 6) && cooled[2] > RED[2], String(cooled))
await press('Control+KeyZ')
await idle()

console.log('\nColour Lookup from a .cube file')
const dir = mkdtempSync(join(tmpdir(), 'plexel-cube-'))
const lines = ['TITLE "invert"', 'LUT_3D_SIZE 2']
for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${1 - r} ${1 - g} ${1 - b}`)
const file = join(dir, 'invert.cube')
writeFileSync(file, lines.join('\n'))
await menu('Layer', 'New Adjustment Layer', 'layer.adjust-colour-lookup')
await waitStep('New Colour Lookup Layer')
n = await selectedNode()
const prefix = `#props-${n.id}`
await page.select(`${prefix}-look`, 'file')
await page.waitForSelector('[data-file-input]')
const input = await page.$('[data-file-input]')
await input.uploadFile(file)
await waitUntil(page, () => document.querySelector('[data-file-name]')?.textContent === 'invert.cube', { timeout: 5000 }).catch(() => null)
check('the file is read and named', (await page.$eval('[data-file-name]', (e) => e.textContent)) === 'invert.cube')
await idle()
const inv = await at(160, 130)
check('and the table is used: red turns cyan', inv[0] < 80 && inv[1] > 180 && inv[2] > 180, String(inv))

await finish()
