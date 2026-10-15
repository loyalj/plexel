/**
 * Channels in Chrome, end to end, through the panel, the menus, the keys
 * and the pointer: colour channels shown alone (in gray) and hidden, only
 * some of them painted and filled, alpha channels made, painted, filled,
 * cleared, shown as a tint and loaded as the selection, spot channels made
 * from the selection and shown as ink, Channel Options, reordering,
 * loading a colour channel and the composite's luminosity as the
 * selection, the shortcuts, and a layer picked giving the colour channels
 * back.
 *
 * Documents are 800 × 600 at 100%, so a pixel on screen is a document
 * pixel, and an offset from the canvas's centre is one from the
 * document's centre (400, 300).
 *
 * Run with: npm run check:channels
 */
import { check, dialogShown, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

// --- helpers (as check-fills.mjs's) ------------------------------------------------------
const { press, idle } = pageHelpers(page)
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
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (dx, dy, img) => {
  const r = await rect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const stepIs = (l, timeout = 8000) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout }).then(() => true, () => false)
const bounds = () =>
  page.evaluate(async () => {
    const s = globalThis.plexel.documents().active().history.present.selection
    return s ? globalThis.plexel.engine().call('select.bounds', { set: s.tiles }) : null
  })
const boundsNear = (b, want, tol = 3) => !!b && b.every((v, i) => Math.abs(v - want[i]) <= tol)
/** How much a set covers a document point, 0..1. */
const coverAt = (set, x, y) => page.evaluate((s, px, py) => (s ? globalThis.plexel.engine().call('select.at', { set: s, x: px, y: py }) : 0), set, x, y)
const selAt = async (x, y) => coverAt((await doc()).selection?.tiles ?? null, x, y)
const drag = async (from, to, { keys = [], steps: n = 10 } = {}) => {
  const r = await rect()
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(cx + from[0], cy + from[1])
  await page.mouse.down()
  await page.mouse.move(cx + to[0], cy + to[1], { steps: n })
  await page.mouse.up()
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(100)
}
const setColour = async (which, r, g, b) => {
  await page.click('[data-model="rgb"]')
  for (const [l, v] of Object.entries({ R: r, G: g, B: b })) {
    await page.click(`.colour-number[data-channel="${l}"]`, { clickCount: 3 })
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
const tool = (id) => page.evaluate((t) => globalThis.plexel.tools().set(t), id)
const marquee = async (from, to) => {
  await tool('marquee')
  await drag(from, to)
  await stepIs('Rectangular Marquee')
}
const dialogSubmit = async (id) => {
  await page.click(`[data-dialog="${id}"] .dialog-foot .primary`)
  await waitUntil(page, (x) => !document.querySelector(`[data-dialog="${x}"]`), { args: [id] })
}
const row = (id) => `[data-panel="channels"] [data-channel-row="${id}"]`
const pickRow = async (id, keys = []) => {
  for (const k of keys) await page.keyboard.down(k)
  await page.click(`${row(id)} .channel-name`)
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await frames(page)
  await idle()
}
const picked = (id) => page.$eval(row(id), (e) => e.dataset.picked === 'yes').catch(() => false)
const view = () => page.evaluate(() => globalThis.plexel.channels.active())
const RED = [255, 0, 0]
const WHITE = [255, 255, 255]
/** A red square from (-100, -100) to (100, 100) on the white background. */
const redSquare = async () => {
  await setColour('fg', 255, 0, 0)
  await marquee([-100, -100], [100, 100])
  await press('Alt+Backspace')
  await stepIs('Fill with Foreground')
  await press('Control+KeyD')
  await idle()
}
const brush = async (from, to) => {
  await tool('brush')
  await page.evaluate(() => globalThis.plexel.brushes().update('brush', { size: 30, hardness: 1, opacity: 1, flow: 1 }))
  await drag(from, to, { steps: 16 })
}

// --- the colour channels ------------------------------------------------------------------
console.log('\nthe colour channels')
await newDoc()
await redSquare()
await clickMenu('Window', 'window.panel.channels')
await page.waitForSelector(row('composite'))
check('the panel lists the composite and Red, Green and Blue', !!(await page.$(row('composite'))) && !!(await page.$(row('colour:0'))) && !!(await page.$(row('colour:2'))))
await waitUntil(page, () => document.querySelector('[data-channel-row="colour:0"] [data-thumb="image"]'), { timeout: 8000 }).catch(() => {})
check('each row has a thumbnail', !!(await page.$(`${row('colour:0')} [data-thumb="image"]`)) && !!(await page.$(`${row('composite')} [data-thumb="image"]`)))
await pickRow('colour:1')
check('a click on Green picks it, alone', (await picked('colour:1')) && !(await picked('composite')) && (await view()).colour.join() === 'false,true,false')
let img = await shot()
check('Green alone shows in gray: none in the red square, all in the white', near(await at(0, 0, img), [0, 0, 0]) && near(await at(200, 0, img), WHITE))
await pickRow('composite')
check('a click on the composite picks and shows them all', (await picked('composite')) && near(await at(0, 0), RED))
await page.click(`[data-channel-eye="colour:2"]`)
await idle()
img = await shot()
check('Blue hidden: white shows as yellow, red as red', near(await at(200, 0, img), [255, 255, 0]) && near(await at(0, 0, img), RED))
await page.click(`[data-channel-eye="colour:2"]`)
await idle()
check('and shown again', near(await at(200, 0), WHITE))

console.log('\npainting some colour channels')
await pickRow('colour:0')
await setColour('fg', 0, 0, 0)
await marquee([-150, -50], [0, 50])
await press('Alt+Backspace')
check('a fill on Red alone is one step', await stepIs('Fill with Foreground'))
await press('Control+KeyD')
await pickRow('composite')
img = await shot()
check('only red was filled: the square black there, the white cyan', near(await at(-50, 0, img), [0, 0, 0]) && near(await at(-125, 0, img), [0, 255, 255]) && near(await at(50, 0, img), RED) && near(await at(200, 0, img), WHITE))
// Back past the deselect and the fill, then deselect again.
await press('Control+KeyZ')
await press('Control+KeyZ')
await press('Control+KeyD')
await idle()
await pickRow('colour:2')
await setColour('fg', 255, 255, 255)
await brush([-60, 60], [60, 60])
check('a stroke on Blue alone is one step', await stepIs('Brush Stroke'))
await pickRow('composite')
img = await shot()
check('only blue was painted: the square magenta there, the white still white', near(await at(0, 60, img), [255, 0, 255]) && near(await at(0, 0, img), RED) && near(await at(200, 60, img), WHITE), `${await at(0, 60, img)} ${await at(0, 0, img)} ${await at(200, 60, img)}`)
await press('Control+KeyZ')
await idle()

// --- alpha channels ------------------------------------------------------------------------
console.log('\nalpha channels')
await page.click('[data-channels="new"]')
check('New makes an empty alpha channel, one step', (await stepIs('New Channel')) && (await doc()).channels?.length === 1 && (await doc()).channels[0].tiles === null)
const alphaId = (await doc()).channels[0].id
check('it is picked, and shown alone', (await picked(alphaId)) && (await view()).colour.every((x) => !x))
await idle()
check('an empty channel alone shows black', near(await at(0, 0), [0, 0, 0]) && near(await at(250, 150), [0, 0, 0]))
await setColour('fg', 255, 255, 255)
await brush([-200, -150], [200, -150])
check('the Brush paints the channel, one step', (await stepIs('Brush Stroke')) && !!(await doc()).channels[0].tiles)
await idle()
img = await shot()
check('white where it was painted', near(await at(0, -150, img), WHITE) && near(await at(0, 0, img), [0, 0, 0]), `${await at(0, -150, img)} ${await at(0, 0, img)}`)
await marquee([-100, -100], [100, 100])
await press('Alt+Backspace')
check('Fill fills the channel through the selection', await stepIs('Fill with Foreground'))
await press('Control+KeyD')
await idle()
check('white where it was filled', near(await at(50, 50), WHITE) && near(await at(150, 50), [0, 0, 0]))
img = await shot()
check('the layer wasn’t touched: the canvas still shows the channel alone', near(await at(150, 50, img), [0, 0, 0]))
await page.keyboard.down('Control')
await page.click(`${row(alphaId)} .channel-thumb`)
await page.keyboard.up('Control')
check('Ctrl-click loads it as the selection', await stepIs('Load Selection'))
check('the selection is the channel: the square and the stroke', boundsNear(await bounds(), [185, 135, 615, 400], 6) && (await selAt(450, 350)) > 0.98 && (await selAt(450, 450)) < 0.02, `${await bounds()}`)
await press('Control+KeyD')
await page.click(`[data-channel-eye="composite"]`)
await idle()
img = await shot()
check('with the colour shown, the channel is a red tint over what it masks', near(await at(250, 100, img), [255, 128, 128], 12) && near(await at(50, 50, img), RED) && near(await at(150, -150, img), WHITE), `${await at(250, 100, img)} ${await at(50, 50, img)} ${await at(150, -150, img)}`)
await page.click(`[data-channel-eye="${alphaId}"]`)
await idle()
check('its eye hides it', near(await at(250, 100), WHITE) && (await view()).colour.every(Boolean))
await page.click(`[data-channel-eye="${alphaId}"]`)
await idle()

// Delete with nothing selected clears the channel to the background (white), never deletes the layer.
await setColour('fg', 255, 255, 255)
await pickRow(alphaId)
await page.evaluate(() => globalThis.plexel.colours().setBg({ space: 'rgb', profile: { builtin: 'srgb' }, c: [0, 0, 0] }))
await press('Delete')
check('Delete with nothing selected clears the channel (to black), not the layer', (await stepIs('Clear')) && Object.keys((await doc()).nodes).length >= 2 && (await coverAt((await doc()).channels[0].tiles, 400, 150)) < 0.02)
await press('Control+KeyZ')
await idle()

// Picking a layer gives the colour channels back.
await page.click('.layer-row .layer-name')
await frames(page)
check('picking a layer picks the colour channels again', (await picked('composite')) && 'colour' in (await view()).target, JSON.stringify(await view()))

// --- spot channels -----------------------------------------------------------------------------
console.log('\nspot channels')
// The alpha channel hidden, so only the ink shows over the picture.
await page.click(`[data-channel-eye="${alphaId}"]`)
await marquee([0, -50], [200, 50])
await page.click('[data-channels="new-spot"]')
check('New Spot opens its dialog', await dialogShown(page, 'newSpotChannel'))
await page.select('#spot-ink', 'custom')
// The ink's chip opens the colour picker: green by its hex code; Esc closes the picker, not the dialog.
await page.click('#spot-colour')
await page.waitForSelector('[data-colour-picker]')
await page.$eval('[data-picker-hex]', (e) => {
  e.focus()
  e.select()
})
await page.keyboard.type('00ff00')
await page.keyboard.press('Enter')
await page.keyboard.press('Escape')
check('Esc closes the picker and leaves the dialog open', !(await page.$('[data-colour-picker]')) && (await dialogShown(page, 'newSpotChannel')))
await dialogSubmit('newSpotChannel')
check('it makes a spot channel from the selection, one step', (await stepIs('New Spot Channel')) && (await doc()).channels.length === 2 && (await doc()).channels[1].kind === 'spot')
const spot = (await doc()).channels[1]
check('its ink is the colour picked, its name the next free one', spot.ink.space === 'rgb' && spot.ink.c[1] > 0.99 && spot.name === 'Spot Colour 1')
await press('Control+KeyD')
await idle()
img = await shot()
check('the ink shows over the picture: green on white, black on red', near(await at(150, 0, img), [0, 255, 0], 12) && near(await at(50, 0, img), [0, 0, 0], 12) && near(await at(-50, 0, img), RED), `${await at(150, 0, img)} ${await at(50, 0, img)} ${await at(-50, 0, img)}`)
check('it’s picked with the colour still shown', (await picked(spot.id)) && (await view()).colour.every(Boolean), JSON.stringify(await view()))
await setColour('fg', 255, 255, 255)
await brush([-300, 200], [300, 200])
check('white paints no ink on a spot channel', (await stepIs('Brush Stroke')) && (await coverAt((await doc()).channels[1].tiles, 400, 500)) < 0.02)
await press('Control+KeyZ')
await setColour('fg', 0, 0, 0)
await brush([-300, 200], [300, 200])
await stepIs('Brush Stroke')
check('black paints full ink', (await coverAt((await doc()).channels[1].tiles, 400, 500)) > 0.98)
await press('Control+KeyZ')
await idle()

console.log('\nChannel Options and the order')
await page.click(`${row(alphaId)} .channel-thumb`, { clickCount: 2 })
check('a double-click on the thumbnail opens Channel Options', await dialogShown(page, 'channelOptions'))
await page.select('#channel-marks', 'selected')
await page.click('#channel-opacity', { clickCount: 3 })
await page.keyboard.type('80')
await dialogSubmit('channelOptions')
check('OK sets what the tint marks and its opacity, one step', (await stepIs('Channel Options')) && (await doc()).channels[0].marks === 'selected' && Math.abs((await doc()).channels[0].opacity - 0.8) < 1e-6)
await page.evaluate(
  (a, z) => {
    const src = document.querySelector(`[data-channel-row="${a}"]`)
    const dst = document.querySelector(`[data-channel-row="${z}"]`)
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  },
  spot.id,
  alphaId,
)
check('a channel dragged above another moves there, one step', (await stepIs('Move Channel')) && (await doc()).channels[0].id === spot.id, await page.evaluate(() => globalThis.plexel.documents().active().history.label))

// --- loading colour channels and the luminosity ---------------------------------------------------
console.log('\nloading colour channels')
await press('Control+KeyD')
/** Waits for the selection to be something other than `was`. */
const selChanged = (was) => waitUntil(page, (w) => (globalThis.plexel.documents().active().history.present.selection?.tiles ?? null) !== w, { args: [was], timeout: 8000 }).then(() => true, () => false)
let was = (await doc()).selection?.tiles ?? null
await page.keyboard.down('Control')
await page.click(`${row('colour:0')} .channel-thumb`)
await page.keyboard.up('Control')
check('Ctrl-click on Red loads it: the red square and the white both full', (await selChanged(was)) && (await stepIs('Load Channel')) && (await selAt(400, 300)) > 0.98 && (await selAt(100, 100)) > 0.98)
was = (await doc()).selection?.tiles ?? null
await page.keyboard.down('Control')
await page.click(`${row('colour:1')} .channel-thumb`)
await page.keyboard.up('Control')
await selChanged(was)
check('Green: the square none, the white full', (await selAt(400, 300)) < 0.02 && (await selAt(100, 100)) > 0.98, `${await selAt(400, 300)} ${await selAt(100, 100)}`)
was = (await doc()).selection?.tiles ?? null
await press('Control+Alt+Digit2')
check('Ctrl+Alt+2 loads the luminosity', (await selChanged(was)) && (await stepIs('Load Luminosity')))
const lum = await selAt(400, 300)
check('red’s luminosity is about 0.3', lum > 0.2 && lum < 0.4 && (await selAt(100, 100)) > 0.98)
await press('Control+KeyD')

// --- the Magic Wand and the Paint Bucket on a channel ------------------------------------------------
console.log('\nthe Magic Wand on a channel')
await pickRow(alphaId)
await tool('wand')
await page.evaluate(() => globalThis.plexel.selectTools().update('wand', { tolerance: 10, contiguous: true, sampleAll: false }))
const r = await rect()
await page.mouse.click(r.x + r.w / 2 + 50, r.y + r.h / 2 + 50)
await stepIs('Magic Wand')
check('the wand reads the channel, not the layer: the filled square', boundsNear(await bounds(), [300, 200, 500, 400], 8))
await press('Control+KeyD')

// --- the shortcuts ---------------------------------------------------------------------------------
console.log('\nthe shortcuts')
await press('Control+Digit3')
check('Ctrl+3 picks Red', await picked('colour:0'))
await press('Control+Digit6')
check('Ctrl+6 the first channel after the colours (the spot, moved first)', await picked(spot.id))
await press('Control+Digit2')
check('Ctrl+2 the composite', await picked('composite'))

// --- PSD ------------------------------------------------------------------------------------------
console.log('\nPSD')
const psd = await page.evaluate(async () => {
  const P = globalThis.plexel
  const d = P.documents().active()
  const before = d.history.present.channels.map((c) => ({ name: c.name, kind: c.kind ?? 'alpha', marks: c.marks ?? 'masked', opacity: c.opacity, tiles: c.tiles }))
  // How much each channel covers at a few points, before and after.
  const points = [[450, 350], [450, 450], [500, 300], [700, 300]]
  const cover = async (chs) => Promise.all(chs.map((c) => Promise.all(points.map(([x, y]) => (c.tiles ? P.engine().call('select.at', { set: c.tiles, x, y }) : 0)))))
  const was = await cover(d.history.present.channels)
  const ex = await P.exports.psdOf(d.history.present, d.key, false)
  await P.files.openFile(new File([ex.bytes], 'channels.psd'), null)
  await P.engine().call('render.idle', {})
  const now = P.documents().active().history.present.channels ?? []
  const after = now.map((c) => ({ name: c.name, kind: c.kind ?? 'alpha', marks: c.marks ?? 'masked', opacity: c.opacity, ink: c.ink }))
  return { before, after, was, is: await cover(now) }
})
check('written as PSD and opened again, the alpha and spot channels come back, in order, named', psd.after.length === 2 && psd.after.map((c) => `${c.name}:${c.kind}`).join() === psd.before.map((c) => `${c.name}:${c.kind}`).join(), JSON.stringify(psd.after))
check('with how they show: the alpha’s tint marking what’s selected at 80%, the spot’s ink', psd.after.some((c) => c.kind === 'alpha' && c.marks === 'selected' && Math.abs(c.opacity - 0.8) < 0.01) && psd.after.some((c) => c.kind === 'spot' && c.ink?.c[1] > 0.99))
check('and their pixels', psd.was.every((row, i) => row.every((v, j) => Math.abs(v - psd.is[i][j]) < 0.02)), JSON.stringify([psd.was, psd.is]))

await finish(page)
