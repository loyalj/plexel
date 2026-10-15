/**
 * Print colour in Chrome, through the real menus, dialogs and panels:
 * Document → Mode (to CMYK and back by Undo, to 16 bits), Convert to
 * Profile, Proof Setup with Proof Colours (Ctrl+Y) and the Gamut Warning
 * (Ctrl+Shift+Y) on the canvas, the Separations panel (an ink hidden,
 * readings under the pointer, coverage over a limit marked), and document
 * swatches: a spot colour linked to a shape's fill at a tint, changed, and
 * a library loaded from an Adobe Swatch Exchange file.
 *
 * Documents are 800 × 600 at 100%, so an offset from the canvas's centre is
 * one from the document's centre (400, 300).
 *
 * Run with: npm run check:proof
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const { press } = pageHelpers(page)
const openMenu = async (menu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
}
const clickMenu = async (menu, command, submenu) => {
  await openMenu(menu)
  if (submenu) {
    await page.click(`[data-submenu="${submenu}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const ticked = async (menu, command, submenu) => {
  await openMenu(menu)
  if (submenu) {
    await page.click(`[data-submenu="${submenu}"]`)
    await frames(page)
  }
  const on = await page.$eval(`[data-command="${command}"]`, (b) => b.getAttribute('aria-checked') === 'true' || b.classList.contains('checked') || /✓/.test(b.textContent))
  await press('Escape')
  await press('Escape')
  return on
}
const idle = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
  await frames(page)
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (dx, dy, img) => {
  const r = await rect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const stepIs = (l) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout: 20000 })
const pointAt = async (dx, dy) => {
  const r = await rect()
  return [r.x + r.w / 2 + dx, r.y + r.h / 2 + dy]
}
const drag = async (from, to) => {
  const a = await pointAt(...from)
  const b = await pointAt(...to)
  await page.mouse.move(...a)
  await page.mouse.down()
  await page.mouse.move(...b, { steps: 8 })
  await page.mouse.up()
  await settle(120)
}
const tap = async (sel) => {
  await page.$eval(sel, (e) => e.click())
  await frames(page)
}
const setFg = (space, c, profile) => page.evaluate((v) => globalThis.plexel.colours().setFg(v), { space, c, profile: profile ?? (space === 'lab' ? null : { builtin: space === 'cmyk' ? 'generic-cmyk' : space === 'gray' ? 'gray-gamma-2.2' : 'srgb' }) })
const fillOf = (d, id) => d.nodes[id].props.appearance[0].paint

// --- a document with a saturated blue and a red shape ----------------------------------------
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
await press('Control+Digit1')
await idle()
await setFg('rgb', [0.05, 0.15, 1])
await page.evaluate(() => {
  const s = globalThis.plexel.documents()
  const d = s.active().history.present
  s.select(d.nodes[d.root].children[0])
})
await frames(page)
await press('KeyM')
await drag([-390, -290], [-10, 290])
await clickMenu('Edit', 'edit.fill-foreground')
await press('Control+KeyD')
await page.evaluate(() => {
  const { makeNode } = globalThis.plexel.doc
  globalThis.plexel.documents().commit((d) => {
    const n = makeNode('vector', 'shape', 'Red', { geometry: { kind: 'shape', shape: { type: 'rect', x: 450, y: 100, w: 300, h: 400, radii: [0, 0, 0, 0], corner: 'round' } }, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0.75, 0.35, 0.3] }, opacity: 1, blend: 'normal' }] })
    const root = d.nodes[d.root]
    return { ...d, nodes: { ...d.nodes, shape: n, [d.root]: { ...root, children: [...root.children, 'shape'] } } }
  })
})
await idle()
const blueBefore = await at(-200, 0)
check('a saturated blue and a muted red shape to start from', chroma(blueBefore) > 150 && chroma(await at(200, 0)) > 60, `${blueBefore} / ${await at(200, 0)}`)

// --- proofing -----------------------------------------------------------------------------------
console.log('\nproofing')
await clickMenu('View', 'view.proof-setup')
await page.waitForSelector('[data-dialog="proofSetup"]')
check('Proof Setup starts on the working CMYK space', (await page.$eval('#proof-profile', (s) => s.value)) === JSON.stringify({ builtin: 'generic-cmyk' }))
await page.click('[data-proof-ok]')
await frames(page)
await press('Control+KeyY')
await idle()
const proofed = await at(-200, 0)
check('Ctrl+Y shows the document as it would print: the blue the press can’t reach is duller', chroma(proofed) < chroma(blueBefore) - 25, `${blueBefore} → ${proofed}`)
check('and View → Proof Colours is ticked', await ticked('View', 'view.proof-colours'))
check('proofing is only a view: the document is unchanged', (await label()) !== 'Proof Colours' && (await doc()).mode === 'rgb')
await press('Control+KeyY')
await idle()
check('Ctrl+Y again shows it as it is', chroma(await at(-200, 0)) > chroma(proofed) + 25)
await press('Control+Shift+KeyY')
await idle()
const warned = await at(-200, 0)
const redWarned = await at(200, 0)
check('the Gamut Warning marks what can’t be printed in grey', chroma(warned) < 12 && warned[0] > 90 && warned[0] < 170, `${warned}`)
check('and leaves what can be alone: the muted red', chroma(redWarned) > 60, `${redWarned}`)
await press('Control+Shift+KeyY')
await idle()

// --- converting --------------------------------------------------------------------------------
console.log('\nconverting')
const setsBefore = Object.values((await doc()).nodes).filter((n) => n.kind === 'pixel').map((n) => n.props.tiles)
await clickMenu('Document', 'doc.mode.cmyk', 'Mode')
check('Document → Mode → CMYK Colour converts the document, one step', await stepIs('CMYK Colour'))
let d = await doc()
check('its mode and profile are the working CMYK space', d.mode === 'cmyk' && d.profile.builtin === 'generic-cmyk')
check('its pixels are new sets, its shape’s fill four inks', Object.values(d.nodes).filter((n) => n.kind === 'pixel').every((n) => !setsBefore.includes(n.props.tiles)) && fillOf(d, 'shape').colour.length === 4)
await idle()
const blueCmyk = await at(-200, 0)
check('and it looks as it did proofed: the blue is the printable one', Math.abs(chroma(blueCmyk) - chroma(proofed)) < 20, `${proofed} / ${blueCmyk}`)
check('Mode shows the tick on CMYK Colour', await ticked('Document', 'doc.mode.cmyk', 'Mode'))
await press('Control+KeyZ')
await idle()
d = await doc()
check('Undo brings the RGB document back, pixels and all', d.mode === 'rgb' && chroma(await at(-200, 0)) > chroma(blueCmyk) + 25)
await press('Control+Shift+KeyZ')
await idle()
check('and redo the CMYK one', (await doc()).mode === 'cmyk')
await clickMenu('Document', 'doc.depth.16', 'Mode')
check('16 Bits/Channel converts the depth', (await stepIs('16 Bits/Channel')) && (await doc()).depth === 16)

// --- separations --------------------------------------------------------------------------------
console.log('\nseparations')
await clickMenu('Window', 'window.panel.separations')
await page.waitForSelector('[data-panel-body="separations"]')
const p = await pointAt(-200, 0)
await page.mouse.move(p[0], p[1])
await page.mouse.move(p[0] + 2, p[1] + 1)
await waitUntil(page, () => /%/.test(document.querySelector('[data-ink-total]')?.textContent ?? ''), { timeout: 5000 })
const readings = await page.$$eval('[data-ink-reading]', (e) => e.map((x) => parseInt(x.textContent)))
const total = await page.$eval('[data-ink-total]', (e) => parseInt(e.textContent))
check('under the pointer: each ink and their total', readings.length === 4 && readings[0] > 50 && Math.abs(readings.reduce((a, b) => a + b, 0) - total) <= 2, `${readings.join('/')} = ${total}%`)
await tap('[data-ink-toggle="0"]')
await idle()
const noCyan = await at(-200, 0)
check('hiding cyan shows the plates without it: the blue turns to magenta’s', noCyan[0] > blueCmyk[0] + 60, `${blueCmyk} → ${noCyan}`)
await tap('[data-ink-toggle="0"]')
await page.$eval('#ink-limit', (e) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(e, '100')
  e.dispatchEvent(new Event('input', { bubbles: true }))
})
await tap('[data-ink-warning]')
await idle()
const limited = await at(-200, 0)
check('coverage over the limit is marked on the canvas', limited[1] > 150 && limited[0] < 100, `${limited}`)
await tap('[data-ink-warning]')

// --- swatches -----------------------------------------------------------------------------------
console.log('\nswatches')
await clickMenu('Window', 'window.panel.swatches')
await setFg('cmyk', [0, 0.9, 0.85, 0])
await tap('[data-new-swatch="spot"]')
d = await doc()
const spot = d.swatches?.[0]
check('New Spot keeps the foreground in the document, as a spot colour, as one step', spot?.kind === 'spot' && spot.colour.space === 'cmyk' && (await label()) === 'New Swatch')
await page.evaluate(() => globalThis.plexel.documents().select('shape'))
await frames(page)
await page.waitForSelector('[data-appearance-item="0"]')
if (!(await page.$('[data-appearance-editor="0"]'))) await tap('[data-appearance-item="0"] .appearance-pick')
await page.select('#props-item-0-swatch', spot.id)
await frames(page)
d = await doc()
check('a fill given the spot colour links to it', fillOf(d, 'shape').swatch === spot.id && fillOf(d, 'shape').colour.map((v) => Math.round(v * 100)).join() === '0,90,85,0')
await page.$eval('#props-item-0-tint + .slider-number', (e) => {
  e.focus()
  e.select()
})
await page.keyboard.type('40')
await page.keyboard.press('Enter')
await frames(page)
d = await doc()
check('at a tint: the ink scaled', fillOf(d, 'shape').tint === 0.4 && Math.abs(fillOf(d, 'shape').colour[1] - 0.36) < 1e-6, JSON.stringify(fillOf(d, 'shape')))
await setFg('cmyk', [1, 0.2, 0, 0])
if (!(await page.$('[data-swatch-colour]'))) await tap(`[data-doc-swatch="${spot.id}"] .doc-swatch-name`)
// The swatch's chip opens the picker; its foreground chip takes the foreground.
await tap('[data-swatch-colour]')
await page.waitForSelector('[data-colour-picker]')
await tap('[data-colour-picker] [data-pick="fg"]')
await page.keyboard.press('Escape')
await frames(page)
d = await doc()
check('changing the swatch changes the fill linked to it, at its tint', Math.abs(fillOf(d, 'shape').colour[0] - 0.4) < 1e-6 && (await label()) === 'Swatch Colour')
// A library from another app: an .ase with a Lab colour.
const dir = mkdtempSync(join(tmpdir(), 'plexel-ase-'))
const ase = (() => {
  const name = 'Leaf'
  const len = 2 + (name.length + 1) * 2 + 4 + 12 + 2
  const b = Buffer.alloc(12 + 6 + len)
  b.write('ASEF', 0, 'ascii')
  b.writeUInt16BE(1, 4)
  b.writeUInt32BE(1, 8)
  b.writeUInt16BE(1, 12)
  b.writeUInt32BE(len, 14)
  b.writeUInt16BE(name.length + 1, 18)
  for (let i = 0; i < name.length; i++) b.writeUInt16BE(name.charCodeAt(i), 20 + i * 2)
  const o = 20 + (name.length + 1) * 2
  b.write('LAB ', o, 'ascii')
  b.writeFloatBE(0.6, o + 4)
  b.writeFloatBE(-40, o + 8)
  b.writeFloatBE(45, o + 12)
  b.writeUInt16BE(0, o + 16)
  return b
})()
const file = join(dir, 'leaf.ase')
writeFileSync(file, ase)
const input = await page.$('[data-load-library]')
await input.uploadFile(file)
await waitUntil(page, () => globalThis.plexel.documents().active().history.present.swatches?.some((s) => s.name === 'Leaf'), { timeout: 5000 })
d = await doc()
const leaf = d.swatches.find((s) => s.name === 'Leaf')
check('Load Library adds an .ase file’s colours: a global Lab green', leaf?.kind === 'global' && leaf.colour.space === 'lab' && Math.abs(leaf.colour.c[0] - 60) < 1e-4 && (await label()) === 'Load Swatches')

// --- Convert to Profile -------------------------------------------------------------------------
console.log('\nConvert to Profile')
await clickMenu('Document', 'doc.convert-profile')
await page.waitForSelector('[data-dialog="convertProfile"]')
await page.select('#convert-profile', JSON.stringify({ builtin: 'srgb' }))
await page.click('[data-convert]')
check('converts to the profile chosen, and its mode: back to RGB', (await stepIs('Convert to Profile')) && (await doc()).mode === 'rgb' && (await doc()).depth === 16)
d = await doc()
check('the linked fill takes the spot’s colour in RGB, at its tint', fillOf(d, 'shape').swatch === spot.id && fillOf(d, 'shape').colour.length === 3 && fillOf(d, 'shape').colour[0] > 0.5)

await finish()
