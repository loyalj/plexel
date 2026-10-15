/**
 * Painting in Chrome, end to end: strokes from the mouse and from a pen
 * with pressure, as they land on screen and in the history; opacity and
 * flow; the eraser; refusing locked, hidden and non-pixel layers; Shift-click
 * lines; Esc; the Colour Picker; the options bar, the Brushes and Swatches
 * panels; the brush cursor; painting on a rotated view; painting in CMYK at
 * 16 bits; the history's memory cap; Pen Settings; the Colour panel
 * keeping its hue on a grey; and phase 12's brushes: the number keys and
 * Shift+[ ], the Brush Settings panel, the Mixer Brush and Smudge, Define
 * Brush Preset, importing an ABR file and the tip-shaped cursor.
 *
 * Run with: npm run check:paint
 */
import { check, dialogShown, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'
import { fileURLToPath } from 'node:url'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const { press } = pageHelpers(page)
const clickMenu = async (menu, command) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
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
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const grey = (c) => c[0]
const steps = () => page.evaluate(() => {
  const h = globalThis.plexel.documents().active().history
  return [...h.labels, h.label]
})
const lastStep = async () => (await steps()).at(-1)
/** A mouse stroke between offsets from the canvas's centre. */
const stroke = async (points) => {
  const r = await rect()
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  await page.mouse.move(cx + points[0][0], cy + points[0][1])
  await page.mouse.down()
  for (const [x, y] of points.slice(1)) await page.mouse.move(cx + x, cy + y, { steps: 6 })
  await page.mouse.up()
  await settle(150)
  await idle()
}
/** A pen stroke: synthetic pen events with pressure, as a tablet sends them. */
const penStroke = async (points) => {
  const r = await rect()
  await page.evaluate(
    (pts, rr) => {
      const c = document.querySelector('[data-engine-canvas]')
      const ev = (type, [x, y, p]) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 7, isPrimary: true, pressure: p, buttons: type === 'pointerup' ? 0 : 1, button: 0, clientX: rr.x + rr.w / 2 + x, clientY: rr.y + rr.h / 2 + y })
      c.dispatchEvent(ev('pointerdown', pts[0]))
      for (const p of pts.slice(1)) c.dispatchEvent(ev('pointermove', p))
      c.dispatchEvent(ev('pointerup', pts[pts.length - 1]))
    },
    points,
    r,
  )
  await settle(150)
  await idle()
}
const setForeground = async (r, g, b) => {
  await page.click('[data-model="rgb"]')
  for (const [label, v] of Object.entries({ R: r, G: g, B: b })) {
    await page.click(`.colour-number[data-channel="${label}"]`, { clickCount: 3 })
    await page.keyboard.type(String(v))
    await page.keyboard.press('Enter')
  }
  await frames(page)
}
const setOption = async (id, v) => {
  await page.click(`#${id}`, { clickCount: 3 })
  await page.keyboard.type(String(v))
  await page.keyboard.press('Enter')
  await frames(page)
}
const newDoc = async (o = {}) => {
  await press('Control+Alt+KeyN')
  await page.waitForSelector('#new-name')
  if (o.preset) await page.select('#new-preset', o.preset)
  for (const [id, v] of [['#new-width', o.width], ['#new-height', o.height]]) {
    if (v === undefined) continue
    await page.click(id, { clickCount: 3 })
    await page.keyboard.type(String(v))
  }
  if (o.depth) await page.select('#new-depth', String(o.depth))
  await page.click('[data-dialog="new"] .dialog-foot .primary')
  await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
  await idle()
  await page.click('.layer-row .layer-name')
  await press('Control+Digit1')
  await idle()
}
const notice = (re) => waitUntil(page, (src) => [...document.querySelectorAll('.notice')].some((n) => new RegExp(src).test(n.textContent)), { args: [re.source], timeout: 3000 })

// --- strokes ---------------------------------------------------------------------------
console.log('\nstrokes')
await newDoc({ width: 800, height: 600 })
await press('KeyB')
check('B chooses the Brush, and the options bar shows its settings', (await page.$eval('[data-tool="brush"]', (b) => b.getAttribute('aria-pressed'))) === 'true' && !!(await page.$('[data-options="brush"] #opt-brush-size')))
await setOption('opt-brush-size', 20)
await page.click('[data-pressure="size"]')
check('the size and pressure switch can be set there', (await page.$eval('#opt-brush-size', (i) => i.value)) === '20' && (await page.$eval('[data-pressure="size"]', (b) => b.getAttribute('aria-pressed'))) === 'false')
await stroke([[-200, 0], [200, 0]])
check('a mouse stroke paints black across the white background', near(await at(-150, 0), [0, 0, 0]) && near(await at(150, 0), [0, 0, 0]) && near(await at(0, 20), [255, 255, 255]), `${await at(-150, 0)} / ${await at(0, 20)}`)
check('and is one step in the history, named for it', (await lastStep()) === 'Brush Stroke')
const width = async (dx) => {
  const img = await shot()
  let n = 0
  for (let dy = -40; dy <= 40; dy++) if (grey(await at(dx, dy, img)) < 128) n++
  return n
}
check('the stroke is as wide as the brush (20 pixels at 100%)', Math.abs((await width(0)) - 20) <= 2, String(await width(0)))
await press('Control+KeyZ')
await idle()
check('one undo takes the whole stroke back', near(await at(-150, 0), [255, 255, 255]))
await press('Control+Shift+KeyZ')
await idle()
check('and redo brings it back', near(await at(-150, 0), [0, 0, 0]))

console.log('\npressure')
await page.click('[data-pressure="size"]')
await penStroke(Array.from({ length: 30 }, (_, i) => [-200 + i * 14, 80, 0.15]))
await penStroke(Array.from({ length: 30 }, (_, i) => [-200 + i * 14, 160, 1]))
const light = await (async () => { const img = await shot(); let n = 0; for (let dy = 50; dy <= 110; dy++) if (grey(await at(0, dy, img)) < 128) n++; return n })()
const heavy = await (async () => { const img = await shot(); let n = 0; for (let dy = 130; dy <= 190; dy++) if (grey(await at(0, dy, img)) < 128) n++; return n })()
check('a pen pressing lightly paints a thinner stroke than one pressing hard', light > 0 && light < heavy * 0.5 && Math.abs(heavy - 20) <= 2, `${light} vs ${heavy}`)
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()

console.log('\nopacity and flow')
await setOption('opt-brush-opacity', 50)
await stroke([[-200, -100], [0, -60], [-200, -20]])
const once = await at(-160, -92)
check('at 50% opacity black on white is mid-grey', Math.abs(grey(once) - 128) <= 6, String(once))
// Near the turn, the way out and the way back overlap.
check('and where the stroke goes over itself it stays mid-grey: opacity is a ceiling, not a rate', Math.abs(grey(await at(-6, -60)) - grey(once)) <= 6, `${await at(-6, -60)}`)
await setOption('opt-brush-opacity', 100)
// Dabs far apart, so each pixel gets one dab a stroke: flow alone shows.
await setOption('opt-brush-flow', 25)
await setOption('opt-brush-spacing', 200)
await stroke([[-200, -160], [200, -160]])
const thin = grey(await at(-200, -160))
await stroke([[-200, -160], [200, -160]])
const built = grey(await at(-200, -160))
check('at 25% flow a dab covers a quarter, and a second stroke over it builds it up', Math.abs(thin - 191) <= 6 && Math.abs(built - 143) <= 8, `${thin} → ${built}`)
await setOption('opt-brush-flow', 100)
await setOption('opt-brush-spacing', 10)

console.log('\nthe eraser')
await press('KeyE')
await setOption('opt-eraser-size', 30)
await stroke([[100, -100], [100, 100]])
const erased = await at(100, 0)
check('E erases the Background to transparency: the checkerboard shows', near(erased, [255, 255, 255], 3) || near(erased, [204, 204, 204], 3), String(erased))
check('which is a history step of its own', (await lastStep()) === 'Eraser')

console.log('\nrefusals')
await press('KeyB')
await page.click('#props-visible') .catch(() => {})
const lockBox = await page.$('[data-props="layer"] label.check:nth-of-type(2) input')
await page.evaluate(() => [...document.querySelectorAll('[data-props="layer"] label.check')].find((l) => /Locked/.test(l.textContent)).querySelector('input').click())
await frames(page)
const before = (await steps()).length
await stroke([[-50, 200], [50, 200]])
check('a locked layer isn’t painted, and says why', (await steps()).length === before && (await notice(/locked against painting/)), (await steps()).join(' | '))
void lockBox
await page.evaluate(() => [...document.querySelectorAll('[data-props="layer"] label.check')].find((l) => /Locked/.test(l.textContent)).querySelector('input').click())
await clickMenu('Layer', 'layer.new-group')
await stroke([[-50, 200], [50, 200]])
check('a group isn’t painted on: it asks for a pixel layer', await notice(/isn’t a pixel layer/))
await clickMenu('Layer', 'layer.new-pixel')
await press('Control+Comma')
await stroke([[-50, 200], [50, 200]])
check('a hidden layer isn’t painted on', await notice(/is hidden/))
await press('Control+Comma')
await setForeground(255, 0, 0)
await stroke([[-50, 220], [50, 220]])
check('a new, empty pixel layer takes paint', near(await at(0, 220), [255, 0, 0]), String(await at(0, 220)))
check('and its thumbnail shows it', await waitUntil(page, () => [...document.querySelectorAll('.layer-row')].some((r) => r.querySelector('.layer-name').textContent === 'Layer 1' && r.querySelector('.layer-thumb').dataset.thumb === 'image')))

// The refusals' notices sit over the canvas's corner; out of the way.
await page.$$eval('.notice button', (bs) => bs.forEach((b) => b.click()))
await frames(page)
console.log('\nlines and Esc')
const r0 = await rect()
await page.mouse.click(r0.x + r0.w / 2 - 250, r0.y + r0.h / 2 + 250)
await page.keyboard.down('Shift')
await page.mouse.click(r0.x + r0.w / 2 + 250, r0.y + r0.h / 2 + 250)
await page.keyboard.up('Shift')
await settle(150)
await idle()
check('Shift-click draws a straight line from the last stroke', near(await at(0, 250), [255, 0, 0]) && near(await at(-125, 250), [255, 0, 0]), String(await at(0, 250)))
const n0 = (await steps()).length
await page.mouse.move(r0.x + r0.w / 2 - 100, r0.y + r0.h / 2 - 230)
await page.mouse.down()
await page.mouse.move(r0.x + r0.w / 2 + 100, r0.y + r0.h / 2 - 230, { steps: 5 })
await page.keyboard.press('Escape')
await page.mouse.up()
await settle(150)
await idle()
check('Esc mid-stroke abandons it: nothing painted, no step', (await steps()).length === n0 && !near(await at(0, -230), [255, 0, 0]))

console.log('\nthe colour picker')
await press('KeyI')
const r1 = await rect()
check('changing tools doesn’t move the canvas', r1.y === r0.y && r1.h === r0.h, `${r0.y} → ${r1.y}`)
await page.mouse.click(r0.x + r0.w / 2, r0.y + r0.h / 2)
await frames(page)
await waitUntil(page, () => /0, 0, 0|0 0 0/.test(document.querySelector('[data-swatch="fg"]').style.background))
check('I and a click take the foreground from the image', /rgb\(0,? 0,? 0\)/.test(await page.$eval('[data-swatch="fg"]', (e) => e.style.background)), `${await page.$eval('[data-swatch="fg"]', (e) => e.style.background)} with ${await page.$eval('.tool[aria-pressed="true"]', (b) => b.dataset.tool)}, under it ${await at(0, 0)}`)
await press('KeyB')
await page.keyboard.down('Alt')
await page.mouse.click(r0.x + r0.w / 2, r0.y + r0.h / 2 + 250)
await page.keyboard.up('Alt')
await waitUntil(page, () => /255, 0, 0|255 0 0/.test(document.querySelector('[data-swatch="fg"]').style.background))
check('Alt-click with the Brush picks too', /rgb\(255,? 0,? 0\)/.test(await page.$eval('[data-swatch="fg"]', (e) => e.style.background)))

console.log('\npanels and the cursor')
await clickMenu('Window', 'window.panel.swatches')
await page.click('[data-swatch-index="9"]')
await frames(page)
const sw = await page.$eval('[data-swatch-index="9"]', (e) => e.style.background)
check('clicking a swatch makes it the foreground', (await page.$eval('[data-swatch="fg"]', (e) => e.style.background)) === sw, sw)
await clickMenu('Window', 'window.panel.brushes')
await page.click('[data-preset="soft-round"]')
await frames(page)
check('choosing Soft Round in Brushes sets the Brush to it', (await page.$eval('#opt-brush-preset', (s) => s.value)) === 'soft-round' && (await page.$eval('#opt-brush-hardness', (i) => i.value)) === '0')
check('every preset has a preview stroke', (await page.$$('.brush-preview')).length >= 9)
const size0 = Number(await page.$eval('#opt-brush-size', (i) => i.value))
await page.mouse.click(r0.x + 20, r0.y + 20, { button: 'middle' })
await press('BracketRight')
check('] makes the brush larger', Number(await page.$eval('#opt-brush-size', (i) => i.value)) > size0)
await press('BracketLeft')
check('[ makes it smaller again', Number(await page.$eval('#opt-brush-size', (i) => i.value)) === size0)
await setOption('opt-brush-size', 60)
await page.mouse.move(r0.x + r0.w / 2 - 300, r0.y + r0.h / 2 - 200)
await frames(page)
await idle()
const ring = await (async () => {
  const img = await shot()
  const cx = Math.round(r0.x + r0.w / 2 - 300)
  const cy = Math.round(r0.y + r0.h / 2 - 200)
  // The ring sits on the brush's edge: 30 pixels out at 100%.
  const onRing = pixelAt(img, cx + 30, cy)
  const inside = pixelAt(img, cx + 15, cy)
  return { onRing, inside }
})()
// Close the panels again, so the Colour panel has its room back.
for (const id of ['swatches', 'brushes']) await page.click(`[data-panel="${id}"] .panel-close`)
check('the brush cursor is drawn at the brush’s size', !near(ring.onRing.slice(0, 3), ring.inside.slice(0, 3), 10), JSON.stringify(ring))

console.log('\na rotated view')
await clickMenu('View', 'view.rotate-right')
await clickMenu('View', 'view.rotate-right')
await clickMenu('View', 'view.rotate-right')
await idle()
await setForeground(0, 0, 255)
await setOption('opt-brush-size', 16)
await page.select('#opt-brush-preset', 'hard-round')
await setOption('opt-brush-size', 16)
await stroke([[-150, -260], [150, -260]])
check('with the view turned, the stroke is still under the pointer', near(await at(-100, -260), [0, 0, 255]) && near(await at(100, -260), [0, 0, 255]), `${await at(-100, -260)} ${await at(100, -260)}`)
await clickMenu('View', 'view.reset-rotation')

console.log('\nCMYK at 16 bits')
await newDoc({ preset: 'a4', depth: 16 })
await press('KeyD')
await stroke([[-100, 0], [100, 0]])
check('a CMYK 16-bit document paints too', grey(await at(0, 0)) < 60, String(await at(0, 0)))

console.log('\nhistory’s memory cap')
await page.evaluate(() => (globalThis.plexelHistoryBytes = 1))
await stroke([[-100, 40], [100, 40]])
await stroke([[-100, 80], [100, 80]])
await waitUntil(page, () => globalThis.plexel.documents().active().history.past.length <= 1, { timeout: 5000 })
check('past its memory cap, history forgets its oldest steps', (await page.evaluate(() => globalThis.plexel.documents().active().history.past.length)) <= 1)
await page.evaluate(() => delete globalThis.plexelHistoryBytes)

console.log('\nsettings')
await clickMenu('Edit', 'edit.pen-settings')
check('Edit → Pen Settings opens', await dialogShown(page, 'pen'))
await page.$eval('#pen-response', (i) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(i, '60')
  i.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.click('[data-dialog="pen"] .dialog-foot .primary')
check('and keeps a firmer response', (await page.evaluate(() => JSON.parse(localStorage.getItem('plexel.pen.v1')).response)) > 1.4)
await page.click('[data-model="hsb"]')
await page.click('.colour-number[data-channel="S"]', { clickCount: 3 })
await page.keyboard.type('0')
await page.keyboard.press('Enter')
await page.click('.colour-number[data-channel="H"]', { clickCount: 3 })
await page.keyboard.type('200')
await page.keyboard.press('Enter')
await frames(page)
check('on a grey, the hue typed in HSB stays put', (await page.$eval('.colour-number[data-channel="H"]', (i) => i.value)) === '200')

console.log('\nbrush keys')
await newDoc({ width: 800, height: 600 })
await page.click('[data-tool="brush"]')
await frames(page)
const brushState = () => page.evaluate(() => globalThis.plexel.brushes().get().brush)
await page.select('#opt-brush-preset', 'hard-round')
await frames(page)
await press('Digit5')
check('5 sets the Brush’s opacity to 50%', near([(await brushState()).opacity * 100], [50], 0.01) && (await page.$eval('#opt-brush-opacity', (i) => i.value)) === '50')
await settle(700)
await page.keyboard.press('Digit4')
await page.keyboard.press('Digit5')
await frames(page)
check('4 then 5, quickly, set it to 45%', near([(await brushState()).opacity * 100], [45], 0.01), String((await brushState()).opacity))
await settle(700)
await press('Shift+Digit3')
check('Shift+3 sets the flow to 30%, not the opacity', near([(await brushState()).flow * 100], [30], 0.01) && near([(await brushState()).opacity * 100], [45], 0.01))
await settle(700)
await press('Digit0')
await press('Shift+Digit0')
check('0 is 100%', (await brushState()).opacity === 1 && (await brushState()).flow === 1)
await settle(700)
await press('Shift+BracketLeft')
const h1 = (await brushState()).hardness
await press('Shift+BracketLeft')
await press('Shift+BracketLeft')
const h3 = (await brushState()).hardness
await press('Shift+BracketRight')
check('Shift+[ makes the brush softer a quarter at a time, Shift+] harder', near([h1, h3, (await brushState()).hardness], [0.75, 0.25, 0.5], 1e-6), `${h1} ${h3} ${(await brushState()).hardness}`)
check('the size stays put meanwhile', (await brushState()).size === (await page.evaluate(() => globalThis.plexel.brushes().get().brush.size)))
await page.select('#opt-brush-preset', 'hard-round')
await setOption('opt-brush-size', 30)

console.log('\nthe Brush Settings panel')
await press('F5')
check('F5 opens Brush Settings, for the Brush', !!(await page.$('[data-brush-settings="brush"]')))
const sections = await page.$$eval('[data-brush-settings] [data-section]', (s) => s.map((e) => e.dataset.section))
check('it has Photoshop’s sections', ['tip', 'shape', 'scatter', 'texture', 'dual', 'colour', 'transfer', 'pose'].every((id) => sections.includes(id)), sections.join(' '))
const inked = () => page.$eval('[data-brush-preview]', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) n += d[i] > 0; return n })
await waitUntil(page, () => { const c = document.querySelector('[data-brush-preview]'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false }, { timeout: 3000 })
const plainInk = await inked()
check('and a stroke drawn by the brush', plainInk > 100, String(plainInk))
await page.click('[data-section-on="texture"]')
await frames(page)
check('turning Texture on gives the brush a texture', (await brushState()).texture !== null)
await settle(200)
check('which the preview shows: the paper takes some of the paint', (await inked()) !== plainInk || (await page.$eval('[data-brush-preview]', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lo = 0; for (let i = 3; i < d.length; i += 4) lo += d[i] > 0 && d[i] < 250; return lo })) > 50)
await setForeground(0, 0, 0)
const s0 = (await steps()).length
await stroke([[-200, -200], [200, -200]])
const grain = await (async () => { const img = await shot(); const v = []; for (let dx = -150; dx <= 150; dx += 3) v.push(grey(await at(dx, -200, img))); return v })()
check('a textured stroke paints, unevenly', (await steps()).length === s0 + 1 && Math.min(...grain) < 128 && Math.max(...grain) - Math.min(...grain) > 30, `${Math.min(...grain)}..${Math.max(...grain)}`)
await page.click('[data-section-on="texture"]')
await press('F5')
check('F5 again closes it', !(await page.$('[data-brush-settings]')))

console.log('\nthe Mixer Brush')
await setForeground(255, 0, 0)
await stroke([[-200, 0], [200, 0]])
await setForeground(0, 0, 255)
await press('Shift+KeyB')
check('Shift+B goes on to the Mixer Brush, with its options', (await page.$eval('[data-tool="mixer"]', (b) => b.getAttribute('aria-pressed'))) === 'true' && !!(await page.$('#opt-mixer-wet')))
await setOption('opt-mixer-wet', 100)
await setOption('opt-mixer-load', 50)
await setOption('opt-mixer-mix', 50)
await setOption('opt-mixer-size', 24).catch(() => {})
await page.click('[data-mixer-load]')
await stroke([[0, -120], [0, 120]])
const beforeRed = await at(0, -60)
const afterRed = await at(0, 60)
check('a Mixer stroke is a step of its own', (await lastStep()) === 'Mixer Brush', await lastStep())
check('it paints its blue, thinned by the white it picks up on the way', beforeRed[2] > beforeRed[0] + 40 && beforeRed[0] > 20, String(beforeRed))
check('and after crossing the red it carries red on with it', afterRed[0] > afterRed[1] + 30 && afterRed[0] > beforeRed[0] + 20, `${beforeRed} → ${afterRed}`)
await press('KeyB')
check('B keeps to the Mixer Brush, the group’s last tool', (await page.$eval('[data-tool="mixer"]', (b) => b.getAttribute('aria-pressed'))) === 'true')

console.log('\nSmudge')
/** A tool from its group's flyout: right-click the group's slot, then the tool. */
const pickTool = async (id) => {
  await page.click('[data-tool-slot="brush"]', { button: 'right' })
  await page.waitForSelector(`[data-tool-option="${id}"]`)
  await page.click(`[data-tool-option="${id}"]`)
  await frames(page)
}
await pickTool('brush')
await setForeground(0, 0, 0)
await setOption('opt-brush-size', 16)
await stroke([[-150, 120], [-150, 260]])
await page.click('[data-tool="smudge"]')
await frames(page)
check('Smudge is in the toolbar, with its Strength', !!(await page.$('#opt-smudge-strength')))
await setOption('opt-smudge-strength', 80)
await stroke([[-150, 190], [-40, 190]])
check('a Smudge stroke is a step of its own', (await lastStep()) === 'Smudge', await lastStep())
const dragged = grey(await at(-120, 190))
check('it drags the black along the way it went, fading', dragged < 200 && grey(await at(-120, 140)) > 245 && grey(await at(-60, 190)) > dragged, `${dragged} / ${await at(-60, 190)}`)

console.log('\nDefine Brush Preset')
await pickTool('brush')
await setOption('opt-brush-size', 12)
await stroke([[200, 150], [260, 200], [200, 250]])
await press('KeyM')
const r2 = await rect()
await page.mouse.move(r2.x + r2.w / 2 + 180, r2.y + r2.h / 2 + 130)
await page.mouse.down()
await page.mouse.move(r2.x + r2.w / 2 + 280, r2.y + r2.h / 2 + 270, { steps: 4 })
await page.mouse.up()
await idle()
await clickMenu('Edit', 'edit.define-brush')
await page.waitForSelector('[data-define-brush-tip]', { timeout: 5000 })
await page.click('#define-brush-name', { clickCount: 3 })
await page.keyboard.type('Chevron')
await page.click('[data-dialog="defineBrush"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="defineBrush"]'))
const defined = await brushState()
check('the selection’s paint becomes a tip, and the Brush takes it', defined.tip.startsWith('tip:') && defined.size >= 60 && defined.size <= 141, `${defined.tip} ${defined.size}`)
check('kept as a preset of the user’s, under Defined', await page.evaluate(() => globalThis.plexel.brushes().get().user.some((p) => p.name === 'Chevron' && p.group === 'Defined')))
await press('Control+KeyD')
await press('KeyB')
await pickTool('brush')
await setForeground(0, 128, 0)
await setOption('opt-brush-spacing', 150)
const s1 = (await steps()).length
await stroke([[-250, -120], [-50, -120]])
const greenDabs = await (async () => { const img = await shot(); let n = 0; for (let dx = -260; dx <= -40; dx += 2) for (let dy = -170; dy <= -70; dy += 2) { const c = await at(dx, dy, img); if (c[1] > c[0] + 40 && c[1] > c[2] + 40) n++ } return n })()
check('and paints with it', (await steps()).length === s1 + 1 && greenDabs > 30, String(greenDabs))

console.log('\nimporting brushes')
await clickMenu('Window', 'window.panel.brushes')
const abr = fileURLToPath(new URL('./fixtures/abr/myer-settlement-brushes.abr', import.meta.url))
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click('[data-import-brushes]')])
await chooser.accept([abr])
await waitUntil(page, () => !!document.querySelector('[data-brush-group="myer-settlement-brushes"]'), { timeout: 10000 })
check('Import reads an ABR file into a group of its own', (await page.evaluate(() => globalThis.plexel.brushes().get().user.filter((p) => p.group === 'myer-settlement-brushes').length)) === 148)
check('and says so', await notice(/148 brushes came in/))
const firstId = await page.evaluate(() => globalThis.plexel.brushes().get().user.find((p) => p.group === 'myer-settlement-brushes').id)
await page.click(`[data-preset="${firstId}"]`)
await frames(page)
check('choosing one gives the Brush its tip', (await brushState()).tip.startsWith('tip:') && (await brushState()).tip !== defined.tip)
await waitUntil(page, () => [...document.querySelectorAll('[data-brush-group="myer-settlement-brushes"] ~ ul .brush-preview')].slice(0, 3).some((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false }), { timeout: 5000 })
check('its previews are drawn', true)
await page.$$eval('.notice button', (bs) => bs.forEach((b) => b.click()))
await setOption('opt-brush-size', 120)
const s2 = (await steps()).length
await stroke([[-200, 60], [200, 60]])
check('and it paints', (await steps()).length === s2 + 1)

console.log('\nthe brush cursor')
// The cursor, with the pointer over an empty patch and away from it.
const cursorDiff = async (dx, dy) => {
  const r = await rect()
  await page.mouse.move(r.x + 20, r.y + 20)
  await frames(page)
  await idle()
  const off = await shot()
  await page.mouse.move(r.x + r.w / 2 + dx, r.y + r.h / 2 + dy)
  await frames(page)
  await idle()
  const on = await shot()
  const cells = []
  for (let y = -70; y <= 70; y += 2) for (let x = -70; x <= 70; x += 2) {
    const a = pixelAt(off, Math.round(r.x + r.w / 2 + dx + x), Math.round(r.y + r.h / 2 + dy + y))
    const b = pixelAt(on, Math.round(r.x + r.w / 2 + dx + x), Math.round(r.y + r.h / 2 + dy + y))
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 30) cells.push([x, y])
  }
  return cells
}
const tipCursor = await cursorDiff(150, -40)
await page.click('[data-preset="hard-round"]')
await setOption('opt-brush-size', 120)
const roundCursor = await cursorDiff(150, -40)
const radii = (cells) => cells.map(([x, y]) => Math.hypot(x, y))
const spread = (v) => (v.length ? Math.max(...v) - Math.min(...v) : 0)
check('a round tip’s cursor is a ring at its radius', roundCursor.length > 20 && radii(roundCursor).every((r) => Math.abs(r - 60) <= 6), `${roundCursor.length} cells, radii ${Math.min(...radii(roundCursor)).toFixed(0)}..${Math.max(...radii(roundCursor)).toFixed(0)}`)
check('an image tip’s cursor follows its shape instead', tipCursor.length > 20 && spread(radii(tipCursor)) > 20, `${tipCursor.length} cells, spread ${spread(radii(tipCursor)).toFixed(0)}`)
await page.click('[aria-label="Remove the myer-settlement-brushes brushes"]')
await frames(page)
check('a whole imported group can be removed', !(await page.$('[data-brush-group="myer-settlement-brushes"]')))
await page.click('[data-panel="brushes"] .panel-close')

await finish()
