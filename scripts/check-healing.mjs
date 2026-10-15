/**
 * Retouching, in Chrome, through the real pointer: the Clone Stamp (its
 * source set with Alt-click, Aligned, Sample All Layers), the Healing
 * Brush (the source's texture taking on the colour round where it's
 * painted), the Spot Healing Brush (a spot filled in from round it) and
 * Patch (a selection healed from where it's dragged to), and cloning
 * across a tiled document's seam.
 *
 * The document is 400 × 300 at 100%, centred: a document point is the
 * canvas's centre plus (x − 200, y − 150) on screen.
 *
 * Run with: npm run check:healing
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Set HEAL_SHOTS to a folder to keep a screenshot of each tool's result. */
const shots = process.env.HEAL_SHOTS
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
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const tool = async (id) => {
  await page.evaluate((t) => globalThis.plexel.tools().set(t), id)
  await frames(page)
}
const stroke = async (points, mods = []) => {
  for (const m of mods) await page.keyboard.down(m)
  const [x0, y0] = await screen(...points[0])
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (const p of points.slice(1)) {
    const [x, y] = await screen(...p)
    await page.mouse.move(x, y, { steps: 10 })
  }
  await page.mouse.up()
  for (const m of mods.reverse()) await page.keyboard.up(m)
  await settle(200)
  await idle()
}
const altClick = async (x, y) => {
  const [sx, sy] = await screen(x, y)
  await page.keyboard.down('Alt')
  await page.mouse.click(sx, sy)
  await page.keyboard.up('Alt')
  await frames(page)
}
const lastStep = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const waitStep = (label) => waitUntil(page, (l) => globalThis.plexel.documents().active().history.label === l, { args: [label], timeout: 15000 }).then(() => true, () => false)
const setSize = async (id, v) => {
  await page.evaluate(([t, s]) => globalThis.plexel.brushes().update(t, { size: s, hardness: 1 }), [id, v])
  await frames(page)
}
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
  await page.click('.layer-row .layer-name')
  await press('Control+Digit1')
  await idle()
}
/** A red square, painted with the Brush, at document (x, y) to (x + s, y + s). */
const square = async (x, y, s, colour = [220, 30, 30]) => {
  await page.evaluate((c) => {
    const p = globalThis.plexel.documents().active().history.present
    globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: c.map((v) => v / 255) })
  }, colour)
  await tool('brush')
  await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 20, hardness: 1, opacity: 1, flow: 1 }))
  for (let yy = y + 10; yy < y + s; yy += 12) await stroke([[x + 10, yy], [x + s - 10, yy]])
}

await newDoc()

console.log('\nthe Clone Stamp')
await square(40, 40, 60)
check('there’s a red square to copy', near(await at(70, 70), [220, 30, 30], 12))
await tool('clone')
await setSize('clone', 40)
const before = await lastStep()
await stroke([[250, 70], [260, 70]])
check('without a source, a stroke says to Alt-click first and paints nothing', (await lastStep()) === before && (await page.$$eval('.notice', (els) => els.some((e) => /Alt-click/.test(e.textContent)))))
await altClick(70, 70)
await stroke([[250, 70], [262, 70]])
check('Alt-click sets the source, and a stroke paints its copy', (await waitStep('Clone Stamp')) && near(await at(256, 70), [220, 30, 30], 12) && near(await at(256, 40), [255, 255, 255], 6), String(await at(256, 70)))
// Aligned: the next stroke carries on the same picture, 180 to the right of the source.
await stroke([[250, 110], [262, 110]])
check('Aligned: the next stroke carries on copying the same picture', near(await at(256, 110), [255, 255, 255], 6), String(await at(256, 110)))
await page.evaluate(() => globalThis.plexel.retouch().update('clone', { aligned: false }))
await stroke([[300, 220], [306, 220]])
check('not Aligned: every stroke starts from the source again', near(await at(303, 220), [220, 30, 30], 12), String(await at(303, 220)))
await page.evaluate(() => globalThis.plexel.retouch().update('clone', { aligned: true }))
await keep('clone')

console.log('\nthe Healing Brush')
// A grey ground on the right half, and a darker texture (stripes) to take the repair from on the left.
await newDoc()
await square(0, 0, W, [200, 200, 200])
await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 4 }))
for (let x = 20; x < 120; x += 10) {
  await page.evaluate(() => {
    const p = globalThis.plexel.documents().active().history.present
    globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: [0.25, 0.25, 0.25] })
  })
  await stroke([[x, 100], [x, 200]])
}
await page.evaluate(() => {
  const p = globalThis.plexel.documents().active().history.present
  globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: [0.95, 0.95, 0.95] })
})
await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 30 }))
await stroke([[300, 150], [310, 150]])
check('a light blemish to heal on the grey', (await at(305, 150))[0] > 230)
await tool('heal')
await setSize('heal', 50)
await altClick(70, 150)
await stroke([[300, 150], [312, 150]])
check('the Healing Brush is one step', await waitStep('Healing Brush'))
await keep('heal')
const healed = await shot()
const mid = await at(305, 150, healed)
check('the blemish is gone: healed to the grey round it', Math.abs(mid[0] - 200) < 45, String(mid))
const vals = []
for (let x = 285; x <= 325; x += 2) vals.push((await at(x, 150, healed))[0])
check('with the source’s texture: the stripes come through', Math.max(...vals) - Math.min(...vals) > 25, vals.join())

console.log('\nthe Spot Healing Brush')
await newDoc()
await square(0, 0, W, [60, 120, 200])
await page.evaluate(() => {
  const p = globalThis.plexel.documents().active().history.present
  globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: [1, 1, 0] })
})
await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 14 }))
await tool('brush')
await stroke([[200, 150], [202, 150]])
check('a yellow spot on the blue', near(await at(201, 150), [255, 255, 0], 30))
await tool('spot')
await setSize('spot', 40)
await stroke([[195, 150], [207, 150]])
check('the Spot Healing Brush is one step', await waitStep('Spot Healing Brush'))
await keep('spot')
check('and the spot is filled in from round it', near(await at(201, 150), [60, 120, 200], 30), String(await at(201, 150)))

console.log('\nPatch')
await newDoc()
await square(0, 0, W, [90, 160, 90])
await page.evaluate(() => {
  const p = globalThis.plexel.documents().active().history.present
  globalThis.plexel.colours().setFg({ space: 'rgb', profile: p.profile, c: [0.9, 0.2, 0.8] })
})
await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 24 }))
await tool('brush')
await stroke([[100, 100], [110, 100]])
await tool('patch')
await stroke([[70, 70], [140, 70], [140, 130], [70, 130], [70, 70]])
check('the Patch tool draws a selection round what to repair', !!(await page.evaluate(() => globalThis.plexel.documents().active().history.present.selection)))
await stroke([[105, 100], [305, 150]])
check('dragged to clean ground and let go, it’s one step', await waitStep('Patch'))
await press('Control+KeyD')
await idle()
check('and what was there is healed away', near(await at(105, 100), [90, 160, 90], 30), String(await at(105, 100)))

console.log('\nacross a tiled document’s seam')
await newDoc()
await page.evaluate(() => globalThis.plexel.documents().commit((d) => ({ ...d, tiled: 'both' }), { label: 'Tiled' }))
await idle()
await square(10, 120, 50)
await tool('clone')
await altClick(30, 145)
// Painting near the left edge, 30 to the left of the source would be off the canvas: read from the right side.
await stroke([[W - 20, 145], [W - 14, 145]])
await waitStep('Clone Stamp')
check('the Clone Stamp’s source reads round the seam', near(await at(W - 17, 145), [220, 30, 30], 14), String(await at(W - 17, 145)))

await finish()
