/**
 * Selections, masks and transforms in Chrome, end to end, through the real
 * menus, keys and pointer: the Marquee, Lasso and Magic Wand with their
 * keys for adding and subtracting; the Select menu; filling, clearing and
 * painting through a selection; marching ants and Quick Mask on the
 * canvas; layer masks made, painted, turned off, inverted and applied;
 * clipping; the Move tool and nudging; Free Transform, flipping and
 * Rasterize; and Crop.
 *
 * Documents are 800 × 600 at 100%, so a pixel on screen is a document
 * pixel, and an offset from the canvas's centre is one from the
 * document's centre (400, 300).
 *
 * Run with: npm run check:tools
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
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
/** The screen's colour at an offset from the canvas's centre. */
const at = async (dx, dy, img) => {
  const r = await rect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const isChecker = (c) => near(c, [255, 255, 255]) || near(c, [204, 204, 204])
const steps = () => page.evaluate(() => {
  const h = globalThis.plexel.documents().active().history
  return [...h.labels, h.label]
})
const lastStep = async () => (await steps()).at(-1)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
/** Waits for the history to reach a step named `label` (selection work is the engine's, so it lands a moment later). */
const stepIs = (label) => waitUntil(page, (l) => { const h = globalThis.plexel.documents().active().history; return h.label === l }, { args: [label], timeout: 5000 }).then(() => true, () => false)
/** A drag between offsets from the canvas's centre, with keys held. */
const drag = async (from, to, { keys = [], steps: n = 8 } = {}) => {
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
const path = async (points, keys = []) => {
  const r = await rect()
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(cx + points[0][0], cy + points[0][1])
  await page.mouse.down()
  for (const [x, y] of points.slice(1)) await page.mouse.move(cx + x, cy + y, { steps: 10 })
  await page.mouse.up()
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(100)
}
const clickAt = async (dx, dy, keys = []) => {
  const r = await rect()
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.click(r.x + r.w / 2 + dx, r.y + r.h / 2 + dy)
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(60)
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
/** Fills the selection with the foreground (Alt+Backspace) and waits for the step. */
const fill = async () => {
  await press('Alt+Backspace')
  await stepIs('Fill with Foreground')
  await idle()
}
const notice = (re) => waitUntil(page, (src) => [...document.querySelectorAll('.notice')].some((n) => new RegExp(src).test(n.textContent)), { args: [re.source], timeout: 3000 }).then(() => true, () => false)
const RED = [255, 0, 0]
const WHITE = [255, 255, 255]

// --- the marquee -----------------------------------------------------------------------
console.log('\nthe marquee')
await newDoc()
await setForeground(255, 0, 0)
await press('KeyM')
check('M chooses the Marquee, with its options', (await page.$eval('[data-tool="marquee"]', (b) => b.getAttribute('aria-pressed'))) === 'true' && !!(await page.$('[data-options="marquee"] [data-op="add"]')))
await drag([-200, -100], [0, 100])
check('a drag selects a rectangle, as a step', await stepIs('Rectangular Marquee'))
await idle()
const ants = await (async () => {
  const img = await shot()
  let dark = 0
  let light = 0
  for (let x = -190; x < -10; x++) {
    const c = await at(x, -100, img)
    if (c[0] < 60) dark++
    else if (c[0] > 200) light++
  }
  return { dark, light }
})()
check('marching ants run along its edge, black and white', ants.dark > 40 && ants.light > 40, JSON.stringify(ants))
await fill()
check('Alt+Backspace fills the selection, and only it', near(await at(-100, 0), RED) && near(await at(100, 0), WHITE) && near(await at(-100, 150), WHITE), `${await at(-100, 0)} / ${await at(100, 0)}`)
await press('Control+KeyD')
check('Ctrl+D deselects', (await stepIs('Deselect')) && (await doc()).selection === null)
await press('Control+Shift+KeyD')
check('Ctrl+Shift+D brings it back', (await stepIs('Reselect')) && (await doc()).selection !== null)
await press('Shift+F7')
check('Shift+F7 inverts it', await stepIs('Inverse'))
await setForeground(0, 0, 255)
await fill()
check('so a fill now covers everything else', near(await at(150, 0), [0, 0, 255]) && near(await at(-100, 0), RED), `${await at(150, 0)}`)
await press('Control+KeyA')
check('Ctrl+A selects all', await stepIs('Select All'))
await press('Control+KeyD')

console.log('\nadding and subtracting')
await newDoc()
await setForeground(0, 160, 0)
await page.click('[data-shape="ellipse"]')
await drag([-300, -250], [-100, -150])
await stepIs('Elliptical Marquee')
await drag([0, -250], [200, -150], { keys: ['Shift'] })
await stepIs('Elliptical Marquee')
await fill()
check('an ellipse selects its inside, not its corners', near(await at(-200, -200), [0, 160, 0]) && near(await at(-295, -245), WHITE), `${await at(-295, -245)}`)
check('and Shift added a second one', near(await at(100, -200), [0, 160, 0]))
await page.click('[data-shape="rect"]')
await press('Control+KeyA')
await drag([-50, 120], [50, 220], { keys: ['Alt'] })
await stepIs('Rectangular Marquee')
await setForeground(200, 200, 0)
await fill()
check('Alt takes a rectangle away from the selection', near(await at(0, 170), WHITE) && near(await at(250, 250), [200, 200, 0]), `${await at(0, 170)} / ${await at(250, 250)}`)
await press('Control+KeyZ')
await press('Control+KeyD')
await idle()

console.log('\nthe lasso and the wand')
await newDoc()
await setForeground(255, 0, 0)
await press('KeyL')
await path([[-200, 0], [-100, -150], [0, 0], [-200, 0]])
check('a lasso drag selects what it goes round', await stepIs('Lasso'))
await fill()
check('a lasso’s triangle fills', near(await at(-100, -30), RED) && near(await at(-190, -100), WHITE), `${await at(-100, -30)}`)
await press('Control+KeyD')
await page.click('[data-lasso="polygonal"]')
await clickAt(50, 50)
await clickAt(250, 50)
await clickAt(250, 200)
check('the Polygonal Lasso takes a click per corner, and the bar says so', /3 corners/.test(await page.$eval('[data-session="polygon"]', (e) => e.textContent)))
await press('Enter')
check('Enter closes it', await stepIs('Polygonal Lasso'))
await setForeground(0, 0, 255)
await fill()
check('and it fills as drawn', near(await at(200, 100), [0, 0, 255]) && near(await at(70, 180), WHITE), `${await at(200, 100)} / ${await at(70, 180)}`)
await press('Control+KeyD')
// Photoshop's habits: Backspace takes the last corner back; Shift keeps a side to 45°.
await clickAt(-300, 100)
await clickAt(-200, 100)
await clickAt(-150, 180)
await press('Backspace')
check('Backspace takes the Polygonal Lasso’s last corner back', /2 corners/.test(await page.$eval('[data-session="polygon"]', (e) => e.textContent)))
await clickAt(-150, 190, ['Shift'])
await press('Enter')
const shifted = (await doc()).selection
check('Shift put the next corner on the 45° line', (await stepIs('Polygonal Lasso')) && !!shifted)
await setForeground(0, 0, 0)
await fill()
// The triangle (-300, 100), (-200, 100), (-127, 173): its middle filled; where the corner taken back was, not.
check('the corner taken back isn’t in it, the 45° one is', near(await at(-209, 120), [0, 0, 0]) && near(await at(-152, 175), WHITE) && near(await at(-150, 157), [0, 0, 0]), `${await at(-152, 175)} ${await at(-150, 157)}`)
await press('Control+KeyD')
await page.click('[data-lasso="freehand"]')
// The Lasso drawn freehand, the button let go with Alt held: straight sides from there, Alt let go to close.
{
  const r = await rect()
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  await page.mouse.move(cx - 300, cy - 260)
  await page.mouse.down()
  await page.mouse.move(cx - 150, cy - 260, { steps: 10 })
  await page.keyboard.down('Alt')
  await page.mouse.up()
  await settle(80)
  check('Alt held as the button comes up carries the Lasso on in straight sides', /straight sides/.test(await page.$eval('[data-session="polygon"]', (e) => e.textContent)))
  await page.mouse.click(cx - 150, cy - 110)
  await settle(60)
  await page.keyboard.up('Alt')
}
check('letting go of Alt closes it', await stepIs('Lasso'))
await setForeground(200, 0, 200)
await fill()
check('freehand and straight sides together make the selection', near(await at(-200, -210), [200, 0, 200]) && near(await at(-280, -130), WHITE), `${await at(-200, -210)} ${await at(-280, -130)}`)
await press('Control+KeyD')
await press('KeyW')
// W's group starts with Quick Selection, as Photoshop's does; Shift+W goes on to the wand.
if (!(await page.$('[data-wand="contiguous"]'))) await press('Shift+KeyW')
await page.click('[data-wand="contiguous"]')
check('W, then Shift+W, chooses the Magic Wand, and Contiguous can be switched off', (await page.$eval('[data-wand="contiguous"]', (b) => b.getAttribute('aria-pressed'))) === 'false')
await clickAt(-100, -30)
check('a click with the wand selects like colours', await stepIs('Magic Wand'))
await setForeground(0, 200, 0)
await fill()
check('everywhere they are: the red triangle went green, the blue stayed', near(await at(-100, -30), [0, 200, 0]) && near(await at(200, 100), [0, 0, 255]), `${await at(-100, -30)} ${await at(200, 100)}`)
await page.click('[data-wand="contiguous"]')
await press('Control+KeyD')

console.log('\nmodifying the selection')
await press('KeyM')
await drag([-100, -100], [100, 100])
await stepIs('Rectangular Marquee')
await press('Shift+F6')
await page.waitForSelector('#feather-radius')
await page.click('#feather-radius', { clickCount: 3 })
await page.keyboard.type('30')
await page.keyboard.press('Enter')
check('Shift+F6 feathers the selection', await stepIs('Feather'))
await setForeground(0, 0, 0)
await fill()
// Ten pixels outside the old edge: the ants run along the edge itself.
const edge = await at(-110, 0)
check('a feathered fill fades out at its edge', edge[0] > 60 && edge[0] < 200 && near(await at(0, 0), [0, 0, 0]), String(edge))
await clickMenu('Select', 'select.expand', 'Modify')
await page.waitForSelector('#grow-by')
await page.keyboard.press('Enter')
check('Select → Expand', await stepIs('Expand'))
await press('Control+Alt+KeyR')
await page.waitForSelector('#refine-shift')
await page.$eval('#refine-contrast', (i) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(i, '80')
  i.dispatchEvent(new Event('input', { bubbles: true }))
})
await settle(400)
await page.click('[data-dialog="selectMask"] .dialog-foot .primary')
check('Select and Mask commits its refinement as one step', await stepIs('Select and Mask'))
await press('Control+KeyD')

console.log('\npainting and clearing through the selection')
await newDoc()
await press('KeyM')
await drag([-100, -100], [100, 100])
await stepIs('Rectangular Marquee')
await press('KeyB')
await press('KeyD')
await path([[-250, 0], [250, 0]])
await stepIs('Brush Stroke')
await idle()
check('a brush stroke paints only inside the selection', near(await at(0, 0), [0, 0, 0]) && near(await at(-200, 0), WHITE), `${await at(0, 0)} / ${await at(-200, 0)}`)
await press('Delete')
check('Delete with a selection clears it', await stepIs('Clear'))
await idle()
check('to transparency', isChecker(await at(0, 0)) && near(await at(-200, 0), WHITE), String(await at(0, 0)))
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()

console.log('\nquick mask')
await press('KeyQ')
await idle()
const tint = await at(-200, 0)
check('Q shows what isn’t selected under red', tint[0] > 200 && tint[1] < 180 && near(await at(0, 0), WHITE), `${tint} / ${await at(0, 0)}`)
await press('KeyB')
await path([[-20, -150], [-20, 150]])
check('painting black in Quick Mask takes away from the selection', await stepIs('Brush Stroke'))
await idle()
const masked = await at(-20, 0)
check('and shows red where it painted', masked[0] > 200 && masked[1] < 180, String(masked))
await press('KeyQ')
await idle()
check('Q again goes back to marching ants', near(await at(-200, 0), WHITE))
await press('Control+KeyD')

console.log('\nlayer masks')
await newDoc()
await setForeground(255, 0, 0)
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await press('KeyM')
await drag([-100, -100], [100, 100])
await stepIs('Rectangular Marquee')
await clickMenu('Layer', 'layer.mask-reveal-selection', 'Layer Mask')
check('Layer Mask → Reveal Selection adds a mask', await stepIs('Reveal Selection'))
await press('Control+KeyD')
await idle()
check('which shows the layer only where it was selected', near(await at(0, 0), RED) && isChecker(await at(-200, 0)), `${await at(-200, 0)}`)
check('the mask has a thumbnail, framed as what painting goes to', await waitUntil(page, () => !!document.querySelector('.layer-part.mask.target .layer-thumb[data-thumb="image"]')).then(() => true, () => false))
check('and Properties shows the mask’s settings', !!(await page.$('[data-props="mask"] #props-density')))
await press('KeyB')
await press('KeyD')
await press('KeyX')
await path([[-250, -200], [250, -200]])
await stepIs('Brush Stroke')
await idle()
check('painting white on the mask reveals more of the layer', near(await at(-200, -200), RED), String(await at(-200, -200)))
await page.click('[data-props="mask"] label.check input')
await idle()
check('Invert in Properties turns it inside out', isChecker(await at(0, 0)) && near(await at(-200, 0), RED), `${await at(0, 0)}`)
await page.click('[data-props="mask"] label.check input')
const maskEl = await page.$('.layer-part.mask')
await page.keyboard.down('Shift')
await maskEl.click()
await page.keyboard.up('Shift')
await idle()
check('Shift-click on the mask turns it off', (await stepIs('Disable Layer Mask')) && near(await at(-200, 0), RED))
await page.keyboard.down('Shift')
await maskEl.click()
await page.keyboard.up('Shift')
await stepIs('Enable Layer Mask')
await page.$eval('#props-feather', (i) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(i, '40')
  i.dispatchEvent(new Event('input', { bubbles: true }))
})
await idle()
const soft = await at(-100, 0)
check('a feathered mask fades the layer at its edge', soft[1] > 40 && soft[1] < 230, String(soft))
await clickMenu('Layer', 'layer.mask-apply', 'Layer Mask')
check('Apply Layer Mask bakes it in and lets the mask go', (await stepIs('Apply Layer Mask')) && !(await page.$('.layer-part.mask')))
await idle()
check('leaving the layer looking the same', isChecker(await at(-300, 0)) && near(await at(0, 0), RED), `${await at(-300, 0)}`)

console.log('\nclipping')
await clickMenu('Layer', 'layer.new-pixel')
await setForeground(0, 0, 255)
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await press('Control+Alt+KeyG')
check('Ctrl+Alt+G clips the layer to the one below', (await stepIs('Create Clipping Mask')) && !!(await page.$('.layer-row.clipped')))
await idle()
check('so it shows only where that one has pixels', near(await at(0, 0), [0, 0, 255]) && isChecker(await at(-300, 0)), `${await at(-300, 0)}`)
await press('Control+Alt+KeyG')
check('and again releases it', (await stepIs('Release Clipping Mask')) && !(await page.$('.layer-row.clipped')))
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()

console.log('\nmove and transform')
await newDoc()
await clickMenu('Layer', 'layer.new-pixel')
await setForeground(255, 0, 0)
await press('KeyM')
await drag([-50, -50], [50, 50])
await stepIs('Rectangular Marquee')
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await press('Control+KeyD')
await press('KeyV')
await drag([0, 0], [150, 0])
check('V and a drag move the layer, as one step', await stepIs('Move'))
await idle()
check('it moved', near(await at(150, 0), RED) && near(await at(-30, 0), WHITE), `${await at(150, 0)}`)
await press('ArrowLeft')
await press('Shift+ArrowLeft')
check('the arrow keys nudge it', (await stepIs('Nudge')) && (await doc()).nodes[(await page.evaluate(() => globalThis.plexel.documents().active().selected))].transform[4] === 139)
await press('Control+Alt+KeyT')
await waitUntil(page, () => !!document.querySelector('[data-options="transform"]'))
check('Ctrl+Alt+T starts Free Transform, and the bar says what it’s doing', /W 100 px, H 100 px/.test(await page.$eval('[data-options="transform"]', (e) => e.textContent)))
// The box's bottom-right corner is at (189, 50) from the centre; drag it out to double the size.
await drag([189, 50], [289, 150])
await settle(200)
check('dragging a corner scales it, keeping its proportions', /W 200 px, H 200 px/.test(await page.$eval('[data-options="transform"]', (e) => e.textContent)), await page.$eval('[data-options="transform"]', (e) => e.textContent))
await idle()
check('live on the canvas', near(await at(270, 130), RED), String(await at(270, 130)))
await press('Escape')
await idle()
check('Esc cancels it', near(await at(270, 130), WHITE) && (await lastStep()) === 'Nudge')
await press('Control+Alt+KeyT')
await waitUntil(page, () => !!document.querySelector('[data-options="transform"]'))
await drag([189, 50], [289, 150])
await drag([139, 0], [139, 0])
await press('Enter')
check('Enter commits it as one step', await stepIs('Free Transform'))
await clickMenu('Edit', 'edit.transform-flip-h', 'Transform')
check('Edit → Transform → Flip Horizontal', await stepIs('Flip Horizontal'))
const t = (await doc()).nodes[(await page.evaluate(() => globalThis.plexel.documents().active().selected))].transform
check('the layer carries the transform live', Math.abs(t[0] + 2) < 1e-6 && Math.abs(t[3] - 2) < 1e-6, JSON.stringify(t))
await clickMenu('Layer', 'layer.rasterize')
check('Rasterize bakes it into the pixels', await stepIs('Rasterize'))
const t2 = (await doc()).nodes[(await page.evaluate(() => globalThis.plexel.documents().active().selected))].transform
await idle()
check('leaving no transform, and the picture as it was', JSON.stringify(t2) === '[1,0,0,1,0,0]' && near(await at(240, 100), RED), `${JSON.stringify(t2)} ${await at(240, 100)}`)
await page.evaluate(() => [...document.querySelectorAll('[data-props="layer"] label.check')].find((l) => /Lock position/.test(l.textContent)).querySelector('input').click())
await frames(page)
const before = (await steps()).length
await drag([200, 100], [0, 0])
check('a layer locked in position won’t move, and says why', (await steps()).length === before && (await notice(/locked in position/)))
await page.$$eval('.notice button', (bs) => bs.forEach((b) => b.click()))

console.log('\ncrop')
await press('KeyC')
await waitUntil(page, () => !!document.querySelector('[data-session="crop"]'))
check('C shows the crop box round the canvas', /800 × 600 px/.test(await page.$eval('[data-session="crop"]', (e) => e.textContent)))
// Its bottom-right handle is at the canvas's corner, (400, 300) from the centre.
await drag([400, 300], [300, 200])
check('dragging a handle resizes it', /700 × 500 px/.test(await page.$eval('[data-session="crop"]', (e) => e.textContent)), await page.$eval('[data-session="crop"]', (e) => e.textContent))
await press('Enter')
check('Enter crops', await stepIs('Crop'))
const cropped = await doc()
check('the canvas is the box', cropped.width === 700 && cropped.height === 500)
await press('Control+KeyZ')
await press('KeyM')
await drag([-100, -100], [50, 0])
await stepIs('Rectangular Marquee')
await clickMenu('Document', 'doc.crop')
check('Document → Crop to Selection', (await stepIs('Crop')) && (await doc()).width === 150 && (await doc()).height === 100)

await finish()
