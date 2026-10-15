/**
 * Adjustments, live filters, layer styles and smart objects in Chrome, end
 * to end, through the real menus, panels and dialogs: adjustment layers
 * and their controls in Properties (sliders, Curves, Levels and its
 * histogram); filters added live, changed, hidden, baked in, and applied
 * for good through a selection; the Layer Style dialog; and a smart object
 * made, edited in a tab of its own, saved back, and rasterized.
 *
 * An 800 × 600 document at 100%, so an offset from the canvas's centre is
 * one from the document's centre.
 *
 * Run with: npm run check:effects
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 900 } })
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
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
const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const stepIs = (l) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout: 8000 }).then(() => true, () => false)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const selectedId = () => page.evaluate(() => globalThis.plexel.documents().active().selected)
const drag = async (from, to, keys = []) => {
  const r = await rect()
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(r.x + r.w / 2 + from[0], r.y + r.h / 2 + from[1])
  await page.mouse.down()
  await page.mouse.move(r.x + r.w / 2 + to[0], r.y + r.h / 2 + to[1], { steps: 6 })
  await page.mouse.up()
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(100)
}
/** Sets a range input the way a drag does, firing input events. */
const slide = (selector, value) =>
  page.$eval(
    selector,
    (i, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, String(v))
      i.dispatchEvent(new Event('input', { bubbles: true }))
    },
    value,
  )
const setForeground = async (r, g, b) => {
  await page.click('[data-model="rgb"]')
  for (const [lab, v] of Object.entries({ R: r, G: g, B: b })) {
    await page.click(`.colour-number[data-channel="${lab}"]`, { clickCount: 3 })
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
/** A red square on a new layer, 200 pixels across, in the middle. */
const redSquare = async () => {
  await clickMenu('Layer', 'layer.new-pixel')
  await setForeground(255, 0, 0)
  await press('KeyM')
  await drag([-100, -100], [100, 100])
  await stepIs('Rectangular Marquee')
  await press('Alt+Backspace')
  await stepIs('Fill with Foreground')
  await press('Control+KeyD')
  await idle()
}

// --- adjustment layers -----------------------------------------------------------------
console.log('\nadjustment layers')
await newDoc()
await redSquare()
await clickMenu('Layer', 'layer.adjust-invert', 'New Adjustment Layer')
check('Layer → New Adjustment Layer → Invert adds one, as a step', await stepIs('New Invert Layer'))
await idle()
check('it inverts everything under it: red to cyan, white to black', near(await at(0, 0), [0, 255, 255]) && near(await at(250, 0), [0, 0, 0]), `${await at(0, 0)} / ${await at(250, 0)}`)
check('the Layers panel lists it as an Invert layer', await page.$$eval('.layer-row .layer-kind', (k) => k.some((e) => e.textContent === 'Invert')))
await press('Control+Comma')
await idle()
check('hidden, it does nothing', near(await at(0, 0), [255, 0, 0]))
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()

await clickMenu('Layer', 'layer.adjust-hue-saturation', 'New Adjustment Layer')
await stepIs('New Hue/Saturation Layer')
const hueId = await selectedId()
await page.waitForSelector(`#props-${hueId}-hue`)
check('Properties shows its controls', !!(await page.$(`#props-${hueId}-saturation`)))
await slide(`#props-${hueId}-hue`, 120)
await slide(`#props-${hueId}-hue`, 120)
check('moving Hue is one step', await stepIs('Edit “Hue/Saturation 1”'))
await idle()
check('and turns red green', near(await at(0, 0), [0, 255, 0], 6), String(await at(0, 0)))
const steps = await page.evaluate(() => globalThis.plexel.documents().active().history.past.length)
await slide(`#props-${hueId}-hue`, 60)
await slide(`#props-${hueId}-hue`, 30)
check('a drag of one slider is one step however far it goes', (await page.evaluate(() => globalThis.plexel.documents().active().history.past.length)) === steps)
await press('Delete')
await idle()

await clickMenu('Layer', 'layer.adjust-curves', 'New Adjustment Layer')
await stepIs('New Curves Layer')
const box = await page.$('[data-editor="curves"] .curve-box')
check('Curves has a curve to drag', !!box)
const bb = await box.boundingBox()
await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5)
await page.mouse.down()
await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.2, { steps: 5 })
await page.mouse.up()
check('dragging the middle of the curve up is a step', await stepIs('Edit “Curves 1”'))
await idle()
await press('Delete')
await clickMenu('Layer', 'layer.adjust-levels', 'New Adjustment Layer')
await stepIs('New Levels Layer')
check('Levels shows the document’s histogram', await waitUntil(page, () => document.querySelector('[data-histogram="ready"]')).then(() => true, () => false))
const levelsId = await selectedId()
// Focused directly: in a tall dock, another panel's header can sit over the field.
await page.$eval(`#props-${levelsId}-levels-inWhite`, (i) => {
  i.scrollIntoView({ block: 'center' })
  i.focus()
  i.select()
})
await page.keyboard.type('128')
await frames(page)
check('and its white point can be typed', await stepIs('Edit “Levels 1”'))
// Out of the field, so Delete is the layer's, not the field's.
await page.evaluate(() => document.activeElement.blur())
await press('Delete')
await idle()

// --- live filters ----------------------------------------------------------------------------
console.log('\nlive filters')
await page.click('.layer-row:nth-child(1) .layer-name')
await clickMenu('Filter', 'filter.gaussian-blur', 'Blur')
await page.waitForSelector('[data-dialog="filter"] #filter-gaussian-blur-radius')
await slide('#filter-gaussian-blur-radius', 12)
await settle(300)
await idle()
const previewEdge = await at(100, 0)
check('the Filter dialog shows the blur on the canvas as it’s set', previewEdge[1] > 40 && previewEdge[1] < 230, String(previewEdge))
check('Live is ticked by default', await page.$eval('#filter-live', (i) => i.checked))
await page.click('[data-dialog="filter"] .dialog-foot .primary')
check('OK adds it as a live filter, one step', await stepIs('Gaussian Blur'))
await idle()
check('it shows under the layer in the Layers panel', !!(await page.$('.effect-row')))
check('and blurs the square’s edge', (await at(100, 0))[1] > 40 && near(await at(0, 0), [255, 0, 0]), String(await at(100, 0)))
await page.click('.effect-row .layer-name')
await page.waitForSelector('[data-props="filter"]')
const filterId = await selectedId()
await slide(`#props-${filterId}-radius`, 2)
check('clicked, its settings change in Properties', await stepIs('Edit “Gaussian Blur”'))
await idle()
const sharper = await at(100, 0)
await page.click('.effect-row .layer-eye')
await idle()
check('its eye hides it', near(await at(102, 0), [255, 255, 255]) && sharper[1] > 40, `${await at(102, 0)} / ${sharper}`)
await page.click('.effect-row .layer-eye')
await clickMenu('Filter', 'filter.apply-live')
check('Filter → Apply Live Filters bakes them in', (await stepIs('Apply Live Filters')) && !(await page.$('.effect-row')))
await idle()
check('leaving the picture as it was', near(await at(100, 0), sharper, 6), `${await at(100, 0)} vs ${sharper}`)

const leftBefore = await at(-102, 0)
await press('KeyM')
await drag([0, -200], [200, 200])
await stepIs('Rectangular Marquee')
await clickMenu('Filter', 'filter.box-blur', 'Blur')
await page.waitForSelector('#filter-box-blur-radius')
check('with a selection, Live starts unticked', !(await page.$eval('#filter-live', (i) => i.checked)))
await slide('#filter-box-blur-radius', 20)
await page.click('[data-dialog="filter"] .dialog-foot .primary')
check('and OK filters the pixels for good', await stepIs('Box Blur'))
await press('Control+KeyD')
await idle()
check('only where they’re selected: the left edge stays as it was, the right one blurs', near(await at(-102, 0), leftBefore, 2) && (await at(115, 0))[1] < 250, `${await at(-102, 0)} vs ${leftBefore}; ${await at(115, 0)}`)

// --- layer styles ----------------------------------------------------------------------------
console.log('\nlayer styles')
await newDoc()
await redSquare()
await clickMenu('Layer', 'layer.style')
await page.waitForSelector('[data-dialog="layerStyle"]')
await page.click('[data-fx="drop-shadow"] input')
await page.waitForSelector('#fx-drop-shadow-distance')
await slide('#fx-drop-shadow-distance', 30)
await slide('#fx-drop-shadow-size', 0)
await settle(300)
await idle()
check('the dialog shows a drop shadow as it’s set, on the canvas as it is', (await at(110, 118))[0] < 200, String(await at(110, 118)))
await page.click('[data-fx="stroke"] input')
await slide('#fx-stroke-size', 6)
await page.click('[data-dialog="layerStyle"] .dialog-foot .primary')
check('OK is one step, Layer Style', await stepIs('Layer Style'))
await idle()
// Light from 120°, 30 px: the shadow is 15 right and 26 down, past the 6 px stroke there.
check('a shadow below and to the right', (await at(110, 118))[0] < 200 && near(await at(-115, -115), [255, 255, 255]), `${await at(110, 118)}`)
check('and a stroke round the square', near(await at(103, 0), [0, 0, 0], 30), String(await at(103, 0)))
check('fx marks the layer, and Properties lists its effects', !!(await page.$('.layer-fx')) && (await page.$$eval('.props-fx li', (l) => l.map((e) => e.textContent))).join() === 'Drop Shadow,Stroke')
await clickMenu('Layer', 'layer.clear-style')
check('Clear Layer Style takes it off', await stepIs('Clear Layer Style'))
await idle()
check('and the square is plain again', near(await at(115, 115), [255, 255, 255]))

// --- smart objects ---------------------------------------------------------------------------
console.log('\nsmart objects')
await clickMenu('Layer', 'layer.smart-convert', 'Smart Objects')
check('Convert to Smart Object, as a step', await stepIs('Convert to Smart Object'))
await idle()
const so = await selectedId()
check('the layer is one now, and looks the same', (await doc()).nodes[so].kind === 'embedded' && near(await at(0, 0), [255, 0, 0]) && near(await at(150, 0), [255, 255, 255]))
await press('Control+Alt+KeyT')
await waitUntil(page, () => !!document.querySelector('[data-options="transform"]'))
await drag([100, 100], [-50, -50])
await press('Enter')
await stepIs('Free Transform')
await idle()
check('scaled down, it’s smaller', near(await at(-60, -60), [255, 0, 0]) && near(await at(50, 50), [255, 255, 255]), `${await at(-60, -60)} / ${await at(50, 50)}`)
await press('Control+Alt+KeyT')
await waitUntil(page, () => !!document.querySelector('[data-options="transform"]'))
// Its corner is at (−50, −50) now; out to (150, 150) makes it 250 across, bigger than it began.
await drag([-50, -50], [150, 150])
await press('Enter')
await stepIs('Free Transform')
await idle()
const parentKey = await page.evaluate(() => globalThis.plexel.documents().active().key)
check('scaled back up past where it was, it’s drawn from its contents, so its edges are still sharp', near(await at(-98, 0), [255, 0, 0], 8) && near(await at(-102, 0), [255, 255, 255], 8) && near(await at(140, 0), [255, 0, 0], 8), `${await at(-98, 0)} ${await at(-102, 0)} ${await at(140, 0)}`)
await clickMenu('Layer', 'layer.smart-edit', 'Smart Objects')
await waitUntil(page, (k) => globalThis.plexel.documents().getState().active !== k, { args: [parentKey] })
check('Edit Contents opens the contents in a tab of their own', (await page.evaluate((k) => globalThis.plexel.documents().active().parent?.key === k, parentKey)))
await page.click('.layer-row .layer-name')
await press('Control+KeyA')
await setForeground(0, 0, 255)
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await press('Control+KeyS')
await waitUntil(page, (k) => globalThis.plexel.documents().get(k).history.label === 'Edit Contents', { args: [parentKey] })
check('Save there puts them back, as a step in the document holding it', true)
await page.evaluate((k) => globalThis.plexel.documents().activate(k), parentKey)
await idle()
check('which shows the new contents', near(await at(0, 0), [0, 0, 255], 8), String(await at(0, 0)))
await clickMenu('Layer', 'layer.rasterize')
check('Rasterize makes it a pixel layer', (await stepIs('Rasterize')) && (await doc()).nodes[so].kind === 'pixel')
await idle()
check('looking the same', near(await at(0, 0), [0, 0, 255], 8))

await finish()
