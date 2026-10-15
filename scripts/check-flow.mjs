/**
 * Working without interruptions, in Chrome: filter dialogs that preview
 * undimmed, move and come back where they were left, while the canvas
 * only pans; Tiled View's frame and its way back to the document; Zoom to
 * Selection and Zoom to Layer; controls marked when off their default and
 * reset by a double-click; shortcut sets; the toolbar edited; the colour
 * picker at the pointer; and a long job's bar, its progress and Cancel.
 *
 * UX_SHOTS=dir keeps screenshots of each.
 *
 * Run with: npm run check:flow
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 800 } })
await page.goto(url)
await waitForEngine(page)
const { press, idle } = pageHelpers(page)
const shots = process.env.UX_SHOTS
const keep = async (name) => shots && writeFileSync(join(shots, `flow-${name}.png`), await page.screenshot())

const openMenu = async (menu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
}
const runMenu = async (menu, command, submenu) => {
  await openMenu(menu)
  if (submenu) {
    await page.click(`[data-submenu="${submenu}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const stepIs = (l, timeout = 8000) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout })
const canvas = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
const drag = async (from, to, { button = 'left', steps = 8 } = {}) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button })
  await page.mouse.move(from.x + 4, from.y + 4, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up({ button })
  await settle(100)
}
const centreOf = async (sel) => {
  const b = await (await page.$(sel)).boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const newDoc = async (w = 800, h = 600) => {
  await press('Control+Alt+KeyN')
  await page.waitForSelector('#new-name')
  for (const [id, v] of [['#new-width', w], ['#new-height', h]]) {
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
// The view of the front document, from the store the page exposes for its checks.
const frontView = () => page.evaluate(() => globalThis.plexel.views().front())

await newDoc()

// --- a filter dialog previews undimmed, moves, and the canvas only pans ---------------------
console.log('\nPreviewing dialogs')
await runMenu('Filter', 'filter.gaussian-blur', 'Blur')
await page.waitForSelector('[data-dialog="filter"]')
check('a filter dialog dims nothing', await page.$eval('.scrim', (s) => s.classList.contains('preview') && getComputedStyle(s).backgroundColor.replace(/\s/g, '') === 'rgba(0,0,0,0)'))
check('and says it’s previewing, so the rest of the interface waits', await page.evaluate(() => document.documentElement.hasAttribute('data-previewing')))
const before = await frontView()
const steps0 = await label()
const c = await canvas()
await drag({ x: c.x - 200, y: c.y }, { x: c.x - 100, y: c.y + 40 })
const after = await frontView()
check('a drag on the canvas pans the view', Math.abs(after.cx - before.cx) > 20 || Math.abs(after.cy - before.cy) > 20, `${before.cx},${before.cy} → ${after.cx},${after.cy}`)
check('and doesn’t touch the layer', (await label()) === steps0)
const box0 = await (await page.$('[data-dialog="filter"]')).boundingBox()
const grip = await centreOf('[data-dialog="filter"] [data-dialog-grip] h2')
await drag(grip, { x: grip.x - 300, y: grip.y + 60 })
const box1 = await (await page.$('[data-dialog="filter"]')).boundingBox()
check('the dialog moves by its title bar', Math.abs(box1.x - (box0.x - 300)) < 6 && Math.abs(box1.y - (box0.y + 60)) < 6, `${Math.round(box0.x)},${Math.round(box0.y)} → ${Math.round(box1.x)},${Math.round(box1.y)}`)
await keep('filter')
await page.click('[data-dialog="filter"] .dialog-foot .button:not(.primary)')
await waitUntil(page, () => !document.querySelector('[data-dialog="filter"]'))
check('closed, the interface takes presses again', !(await page.evaluate(() => document.documentElement.hasAttribute('data-previewing'))))
await runMenu('Filter', 'filter.gaussian-blur', 'Blur')
await page.waitForSelector('[data-dialog="filter"]')
const box2 = await (await page.$('[data-dialog="filter"]')).boundingBox()
check('opened again, it’s where it was left', Math.abs(box2.x - box1.x) < 6 && Math.abs(box2.y - box1.y) < 6)
await page.click('[data-dialog="filter"] [data-dialog-grip] h2', { clickCount: 2 })
await frames(page)
const box3 = await (await page.$('[data-dialog="filter"]')).boundingBox()
check('a double-click on its bar puts it back', Math.abs(box3.x - box0.x) < 6 && Math.abs(box3.y - box0.y) < 6)
await page.mouse.click(10, 400)
await press('Escape')
check('Esc closes it, wherever the focus is', await waitUntil(page, () => !document.querySelector('[data-dialog="filter"]')))

// --- controls marked off their default, reset by a double-click -----------------------
console.log('\nDefaults')
await page.waitForSelector('#props-opacity')
const opacityLabel = '.slider-row:has(#props-opacity) .slider-label'
check('at its default, Opacity isn’t marked', !(await page.$eval(opacityLabel, (e) => e.hasAttribute('data-changed'))))
await page.$eval('.slider-row:has(#props-opacity) .slider-number', (e) => {
  e.focus()
  e.select()
})
await page.keyboard.type('40')
await page.keyboard.press('Enter')
await idle()
check('set to 40%, its label is marked', await page.$eval(opacityLabel, (e) => e.hasAttribute('data-changed')))
await page.click(opacityLabel, { clickCount: 2 })
await idle()
const layer = await page.evaluate(() => { const d = globalThis.plexel.documents().active(); return d.history.present.nodes[d.selected].opacity })
check('a double-click on the label puts 100% back', layer === 1, String(layer))
check('and the mark goes', !(await page.$eval(opacityLabel, (e) => e.hasAttribute('data-changed'))))

// --- Zoom to Selection and Zoom to Layer ------------------------------------------------------
console.log('\nZooming to things')
await page.evaluate(async () => {
  const p = globalThis.plexel
  const d = p.documents().active()
  const doc = d.history.present
  const set = await p.engine().call('select.shape', { width: doc.width, height: doc.height, shape: { kind: 'rect', x0: 500, y0: 100, x1: 600, y1: 160 }, antialias: false, feather: 0, op: 'replace', current: null })
  p.documents().commit((x) => ({ ...x, selection: set ? { tiles: set, path: null } : null }), { label: 'Select' })
})
await idle()
const z0 = (await frontView()).zoom
await runMenu('View', 'view.zoom-selection')
await settle(150)
const v1 = await frontView()
check('Zoom to Selection frames it: zoomed in, centred on it', v1.zoom > z0 * 2 && Math.abs(v1.cx - 550) < 1 && Math.abs(v1.cy - 130) < 1, JSON.stringify(v1))
await press('Control+KeyD')
// A small shape, then its thumbnail double-clicked.
await page.evaluate(() => globalThis.plexel.tools().set('shape'))
await press('Control+Digit0')
await settle(100)
const cc = await canvas()
await drag({ x: cc.x - 200, y: cc.y - 150 }, { x: cc.x - 170, y: cc.y - 120 }, { steps: 4 })
await stepIs('New Shape')
await press('Control+Digit0')
await settle(100)
const zFit = (await frontView()).zoom
await page.$eval('.layer-row.selected [data-part="content"]', (e) => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
await waitUntil(page, (z) => globalThis.plexel.views().front().zoom > z * 2, { args: [zFit], timeout: 3000 })
check('double-clicking a layer’s thumbnail zooms to the layer', (await frontView()).zoom > zFit * 2)
check('and its name isn’t opened for renaming', !(await page.$('.layer-rename')))
await press('Control+Digit0')

// --- the colour picker at the pointer ----------------------------------------------------
console.log('\nThe colour picker at the pointer')
await page.evaluate(() => globalThis.plexel.tools().set('brush'))
const fg = () => page.evaluate(() => globalThis.plexel.colours().get().fg.c.map((v) => Math.round(v * 100) / 100))
const fg0 = await fg()
const p0 = await canvas()
await page.keyboard.down('Shift')
await page.keyboard.down('Alt')
await page.mouse.move(p0.x, p0.y)
await page.mouse.down({ button: 'right' })
await frames(page)
check('Shift+Alt and the right button show it at the pointer', !!(await page.$('[data-colour-hud]')))
// Onto the strip for the hue, then back into the square for a light, strong shade.
await page.mouse.move(p0.x + 200, p0.y + 60, { steps: 6 })
await page.mouse.move(p0.x + 150, p0.y - 150, { steps: 6 })
await keep('hud')
const mid = await fg()
check('the foreground follows as it moves', mid.join() !== fg0.join(), `${fg0} → ${mid}`)
await page.mouse.up({ button: 'right' })
await page.keyboard.up('Alt')
await page.keyboard.up('Shift')
await frames(page)
check('let go, it goes and the colour stays', !(await page.$('[data-colour-hud]')) && (await fg()).join() === mid.join())
check('no context menu followed it', !(await page.$('[data-context-menu]')))
await page.keyboard.down('Shift')
await page.keyboard.down('Alt')
await page.mouse.down({ button: 'right' })
await page.mouse.move(p0.x + 40, p0.y + 40, { steps: 4 })
await page.keyboard.up('Alt')
await page.keyboard.up('Shift')
await page.keyboard.press('Escape')
await page.mouse.up({ button: 'right' })
await frames(page)
check('Esc puts the colour back', (await fg()).join() === mid.join(), `${await fg()}`)

// --- shortcut sets ---------------------------------------------------------------------------
console.log('\nShortcut sets')
await press('Control+Alt+Shift+KeyK')
await page.waitForSelector('[data-keys-set]')
check('the shortcuts start as Photoshop’s', (await page.$eval('[data-keys-set]', (s) => s.value)) === 'photoshop')
await page.select('[data-keys-set]', 'illustrator')
await frames(page)
check('Illustrator’s set gives the Paintbrush B', await page.$eval('[data-keys-row="tool.vbrush"]', (r) => [...r.querySelectorAll('[data-key]')].some((k) => k.dataset.key === 'B')))
check('and takes B from the Brush’s group', await page.$eval('[data-keys-row="tool.group-brush"]', (r) => r.querySelectorAll('[data-key]').length === 0))
await page.select('[data-keys-set]', 'affinity')
await frames(page)
check('Affinity’s, Photoshop’s keys, is chosen', (await page.$eval('[data-keys-set]', (s) => s.value)) === 'affinity' && (await page.$eval('[data-keys-changed]', (e) => e.dataset.keysChanged)) === '0')
await page.select('[data-keys-set]', 'illustrator')
await page.click('[data-keys-save]')
await waitUntil(page, () => !document.querySelector('[data-dialog="shortcuts"]'))
await page.evaluate(() => document.activeElement?.blur?.())
await page.keyboard.press('KeyB')
await frames(page)
check('saved, B picks the Paintbrush', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'vbrush')
await press('Control+Alt+Shift+KeyK')
await page.waitForSelector('[data-keys-set]')
check('the dialog says which set is in use', (await page.$eval('[data-keys-set]', (s) => s.value)) === 'illustrator')
await page.select('[data-keys-set]', 'photoshop')
await page.click('[data-keys-save]')
await waitUntil(page, () => !document.querySelector('[data-dialog="shortcuts"]'))

// --- the toolbar, edited ---------------------------------------------------------------------
console.log('\nEdit Toolbar')
await runMenu('Edit', 'edit.toolbar')
await page.waitForSelector('[data-dialog="toolbar"]')
await page.click('[data-toolbar-shown="crop"]')
await frames(page)
check('a slot unticked leaves the bar', !(await page.$('.toolbar [data-tool-slot="crop"]')))
await page.click('[data-dialog="toolbar"] [aria-label^="Move Type"][aria-label$="up"]')
await frames(page)
const order = await page.$$eval('.toolbar [data-tool-slot]', (b) => b.map((x) => x.dataset.toolSlot))
check('moved up, it’s higher on the bar', order.indexOf('type') >= 0 && order.indexOf('type') < order.indexOf('shape'), order.join(' '))
await page.click('#toolbar-columns-two')
await frames(page)
check('Two columns: the bar has two', await page.$eval('.toolbar', (b) => b.classList.contains('two-columns')))
await keep('toolbar')
await page.click('[data-dialog="toolbar"] .dialog-foot .primary')
await page.click('.toolbar [data-tool-slot="more"]')
await page.waitForSelector('[data-tool-flyout="more"]')
check('the … slot has the tools taken off', !!(await page.$('[data-tool-flyout="more"] [data-tool-option="crop"]')) && !!(await page.$('[data-tool-flyout="more"] [data-tool-edit]')))
await page.click('[data-tool-flyout="more"] [data-tool-option="crop"]')
check('and they still work from there', (await page.evaluate(() => globalThis.plexel.tools().get())) === 'crop')
await press('Escape')
await page.click('.toolbar [data-tool-slot="more"]')
await page.click('[data-tool-flyout="more"] [data-tool-edit]')
await page.waitForSelector('[data-dialog="toolbar"]')
await page.click('[data-toolbar-reset]')
await frames(page)
check('Restore Defaults puts it back', !!(await page.$('.toolbar [data-tool-slot="crop"]')) && !(await page.$eval('.toolbar', (b) => b.classList.contains('two-columns'))))
await page.click('[data-dialog="toolbar"] .dialog-foot .primary')

// --- Tiled View: the document framed, and a way back ---------------------------------------
console.log('\nTiled View')
await openMenu('Document')
await page.click('[data-submenu="Tiled"]')
await frames(page)
await page.click('[data-command="doc.tiled.both"]')
await idle()
check('the document in view, no way back is offered', !(await page.$('[data-tile-home]')))
{
  // Its edge drawn in the accent among the white copies.
  await page.evaluate(() => globalThis.plexel.views().zoomTo(0.5))
  await settle(200)
  const v = await frontView()
  const m = await canvas()
  const png = await page.screenshot({ encoding: 'base64' })
  const edge = await page.evaluate(async (src, x, y) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + src
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    return [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data]
  }, png, m.x - v.cx * v.zoom, m.y)
  check('in Tiled View the document itself is framed in the accent', edge[2] > edge[0] + 60, String(edge))
  await keep('frame')
}
await page.evaluate(() => globalThis.plexel.views().centreOn(800 * 3.5, 600 * 3.5))
await settle(150)
await keep('tiled')
check('far off among its copies, a way back is offered', !!(await page.$('[data-tile-home]')))
await page.click('[data-tile-home]')
await settle(150)
const home = await frontView()
check('and it centres the document again', Math.abs(home.cx - 400) < 1 && Math.abs(home.cy - 300) < 1 && !(await page.$('[data-tile-home]')))

// --- a long job: progress and Cancel ------------------------------------------------------
console.log('\nA long job')
await newDoc(2400, 1800)
await page.evaluate(async () => {
  const p = globalThis.plexel
  const d = p.documents().active()
  const doc = d.history.present
  const set = await p.engine().call('select.shape', { width: doc.width, height: doc.height, shape: { kind: 'rect', x0: 600, y0: 500, x1: 1700, y1: 1300 }, antialias: false, feather: 0, op: 'replace', current: null })
  p.documents().commit((x) => ({ ...x, selection: set ? { tiles: set, path: null } : null }), { label: 'Select' })
})
await press('Shift+F5')
await page.waitForSelector('#fill-contents')
await page.select('#fill-contents', 'content-aware')
await page.click('[data-dialog="fill"] .dialog-foot .primary')
const shown = await waitUntil(page, () => !!document.querySelector('[data-job]'), { timeout: 4000 })
check('content-aware fill shows a job bar with Cancel', shown && !!(await page.$('[data-job-cancel]')), await page.$eval('.job-label', (e) => e.textContent).catch(() => ''))
const moved = await waitUntil(page, () => Number(document.querySelector('[data-job] [role=progressbar]')?.getAttribute('aria-valuenow') ?? 0) > 0, { timeout: 8000 })
check('its progress moves', moved)
await keep('job')
await page.keyboard.press('Escape')
await frames(page)
check('Esc cancels: the bar goes', await waitUntil(page, () => !document.querySelector('[data-job]'), { timeout: 2000 }))
await settle(500)
check('and nothing was filled, and nothing went wrong', (await label()) === 'Select' && !(await page.$('.notice.error, [data-notice="error"]')))

await finish()
