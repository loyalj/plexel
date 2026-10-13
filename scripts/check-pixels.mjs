/**
 * Pixels and colour in Chrome: background layers, fills, undo through
 * tile sets, layer thumbnails, the Colour panel and its models, gamut
 * warnings, Colour Settings, Assign Profile (with a profile loaded from a
 * file), pixels saved in .pxll files and in the autosave journal, and the
 * engine freeing what nothing uses.
 *
 * Run with: npm run check:pixels
 */
import { join } from 'node:path'
import { check, finish, frames, open, waitForEngine, waitUntil } from './harness.mjs'

const MOCK_PICKERS = () => {
  const dir = () => navigator.storage.getDirectory().then((d) => d.getDirectoryHandle('picked', { create: true }))
  window.showSaveFilePicker = async ({ suggestedName }) => (await dir()).getFileHandle(suggestedName, { create: true })
  window.showOpenFilePicker = async () => [await (await dir()).getFileHandle(window.__nextOpen)]
}

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.evaluateOnNewDocument(MOCK_PICKERS)
await page.goto(url)
await waitForEngine(page)

const press = async (combo) => {
  const keys = combo.split('+')
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k)
  await page.keyboard.press(keys[keys.length - 1])
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k)
  await frames(page)
}
const text = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => null)
const clickMenu = async (menu, command) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
/**
 * Each layer's name and what its thumbnail shows: the colour at its centre
 * (the engine renders it through the display table), 'empty', or
 * 'pending' while it's being rendered.
 */
const thumbs = () =>
  page.$$eval('.layer-row', (rows) =>
    rows.map((r) => {
      const t = r.querySelector('.layer-thumb')
      return { name: r.querySelector('.layer-name')?.textContent, thumb: t ? (t.dataset.thumb === 'image' ? t.dataset.colour : t.dataset.thumb) : null }
    }),
  )
const thumbOf = async (name) => (await thumbs()).find((t) => t.name === name)?.thumb
const waitThumb = (name, want) =>
  waitUntil(
    page,
    (n, w) => {
      const row = [...document.querySelectorAll('.layer-row')].find((r) => r.querySelector('.layer-name')?.textContent === n)
      const t = row?.querySelector('.layer-thumb')
      if (!t) return false
      const v = t.dataset.thumb === 'image' ? t.dataset.colour : t.dataset.thumb
      if (v === w || (w.startsWith('/') && new RegExp(w.slice(1, -1)).test(v))) return true
      // A thumbnail goes through the display table, which is within a level
      // or three of an exact conversion: colours are compared that closely.
      const nums = (s) => (/^rgb\((\d+), (\d+), (\d+)\)$/.exec(s ?? '') ?? []).slice(1).map(Number)
      const [a, b] = [nums(v), nums(w)]
      return a.length === 3 && b.length === 3 && a.every((x, i) => Math.abs(x - b[i]) <= 3)
    },
    { args: [name, want], timeout: 5000 },
  )
const newDoc = async ({ preset, background, name }) => {
  await press('Control+Alt+KeyN')
  await page.waitForSelector('#new-name')
  if (preset) await page.select('#new-preset', preset)
  if (background) await page.select('#new-background', background)
  if (name) {
    await page.click('#new-name', { clickCount: 3 })
    await page.keyboard.type(name)
  }
  await page.click('[data-dialog="new"] .dialog-foot .primary')
  await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
  await frames(page)
}
const setChannels = async (values) => {
  for (const [label, v] of Object.entries(values)) {
    await page.click(`.colour-number[data-channel="${label}"]`, { clickCount: 3 })
    await page.keyboard.type(String(v))
    await page.keyboard.press('Enter')
    await frames(page)
  }
}
const channels = () => page.$$eval('.colour-number', (els) => Object.fromEntries(els.map((e) => [e.dataset.channel, e.value])))
const stats = async () => {
  await clickMenu('Help', 'help.gpu')
  await waitUntil(page, () => !!document.querySelector('[data-tile-stats]'))
  const s = await page.$$eval('[data-stat]', (els) => Object.fromEntries(els.map((e) => [e.dataset.stat, e.textContent])))
  await press('Escape')
  return s
}

// --- backgrounds --------------------------------------------------------------------
console.log('\nbackgrounds')
await newDoc({ name: 'Paint' })
check('a new document has a Background pixel layer', (await thumbs()).map((t) => t.name).join() === 'Background')
check('its thumbnail is white', await waitThumb('Background', 'rgb(255, 255, 255)'), String(await thumbOf('Background')))
const s1 = await stats()
check('the engine holds one set of one uniform tile, using no tile memory', s1.sets === '1' && /^1 \(1 uniform/.test(s1.tiles) && /^0 B/.test(s1.memory), JSON.stringify(s1))
await newDoc({ background: 'transparent', name: 'Clear' })
check('a transparent document has no layers', (await thumbs()).length === 0)
await newDoc({ background: 'black', name: 'Night' })
check('a black one starts black', await waitThumb('Background', 'rgb(0, 0, 0)'))

// --- fills and undo ----------------------------------------------------------------------
console.log('\nfills')
await clickMenu('Layer', 'layer.new-pixel')
check('New Pixel Layer adds an empty layer, its thumbnail the checkerboard', await waitThumb('Layer 1', 'empty'), String(await thumbOf('Layer 1')))
await page.click('[data-model="rgb"]')
await setChannels({ R: 255, G: 0, B: 0 })
check('typing RGB values sets the foreground', /rgb\(255 0 0\)|rgb\(255, 0, 0\)/.test(await page.$eval('[data-swatch="fg"]', (e) => e.style.background)), await page.$eval('[data-swatch="fg"]', (e) => e.style.background))
await page.click('.layer-row .layer-name')
await press('Alt+Backspace')
check('Alt+Backspace fills the layer with the foreground', await waitThumb('Layer 1', 'rgb(255, 0, 0)'), String(await thumbOf('Layer 1')))
await press('Control+Backspace')
check('Ctrl+Backspace fills it with the background', await waitThumb('Layer 1', 'rgb(255, 255, 255)'))
await press('Control+KeyZ')
check('undo brings the red back: the old set is still there', await waitThumb('Layer 1', 'rgb(255, 0, 0)'))
await press('Control+KeyZ')
check('and undo again empties it', await waitThumb('Layer 1', 'empty'))
await press('Control+Shift+KeyZ')
check('redo fills it again', await waitThumb('Layer 1', 'rgb(255, 0, 0)'))
await clickMenu('Window', 'window.panel.history')
check('fills are named in the history', (await page.$$eval('.history-step', (els) => els.map((e) => e.textContent))).includes('Fill with Foreground'))
await page.click('.layer-row:last-child .layer-name')
await clickMenu('Layer', 'layer.new-group')
await page.evaluate(() => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === 'Edit').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
await frames(page)
check('Fill is disabled for a group', await page.$eval('[data-command="edit.fill-foreground"]', (b) => b.disabled))
await press('Escape')

// --- the colour panel --------------------------------------------------------------------
console.log('\ncolour panel')
await page.click('[data-model="hsb"]')
const hsb = await channels()
check('pure red in HSB is 0°, 100%, 100%', hsb.H === '0' && hsb.S === '100' && hsb.B === '100', JSON.stringify(hsb))
check('and its hex is ff0000', (await page.$eval('#colour-hex', (i) => i.value)) === 'ff0000')
// Focused directly: with the dock scrolled, a panel's header can sit over the field.
await page.$eval('#colour-hex', (i) => {
  i.scrollIntoView({ block: 'center' })
  i.focus()
  i.select()
})
await page.keyboard.type('3a66db')
await page.keyboard.press('Enter')
await frames(page)
await page.click('[data-model="rgb"]')
const rgb = await channels()
check('a typed hex sets the colour', rgb.R === '58' && rgb.G === '102' && rgb.B === '219', JSON.stringify(rgb))
await page.click('[data-model="lab"]')
const labv = await channels()
check('Lab shows it in Lab', Number(labv.L) > 40 && Number(labv.L) < 50 && Number(labv.b) < -50, JSON.stringify(labv))
await page.mouse.click(60, 700)
await press('KeyX')
check('X swaps foreground and background', /255/.test(await page.$eval('[data-swatch="fg"]', (e) => e.style.background)))
await press('KeyD')
check('D resets to black on white', /rgb\(0 0 0\)|rgb\(0, 0, 0\)/.test(await page.$eval('[data-swatch="fg"]', (e) => e.style.background)))

// --- CMYK and gamut ----------------------------------------------------------------------
console.log('\ncmyk and gamut')
await newDoc({ preset: 'a4', name: 'Flyer' })
check('an A4 print document is CMYK with the Generic CMYK profile', /CMYK 8-bit/.test((await text('[data-status="document"]')) ?? '') && /Generic CMYK/.test((await text('[data-props="document"]')) ?? ''))
check('black is within the CMYK gamut', !(await page.$('[data-gamut-warning]')))
await page.click('[data-model="rgb"]')
await setChannels({ R: 0, G: 0, B: 255 })
check('sRGB’s pure blue warns that the CMYK document can’t print it', !!(await page.$('[data-gamut-warning]')))
await page.click('[data-gamut-warning]')
await frames(page)
check('clicking the warning moves the colour into the gamut', !(await page.$('[data-gamut-warning]')))
await page.click('[data-model="cmyk"]')
const cmyk = await channels()
check('and the CMYK sliders show the inks for it', Number(cmyk.C) > 60 && Number(cmyk.Y) < 10, JSON.stringify(cmyk))
await page.click('.layer-row .layer-name')
await press('Alt+Backspace')
check('filling a CMYK layer shows a blue thumbnail', await waitThumb('Background', '/rgb\\(\\d+, \\d+, (1\\d\\d|2\\d\\d)\\)/'), String(await thumbOf('Background')))
await page.keyboard.press('KeyD')

// --- colour settings -------------------------------------------------------------------------
console.log('\ncolour settings')
await press('Control+Shift+KeyK')
check('Ctrl+Shift+K opens Colour Settings', !!(await page.$('[data-dialog="colourSettings"]')))
await page.select('#cs-display', 'display-p3')
await page.click('[data-dialog="colourSettings"] .dialog-foot .primary')
await frames(page)
const bg = await page.$eval('[data-swatch="bg"]', (e) => e.getAttribute('style'))
check('with a Display P3 screen, swatches are drawn in Display P3', /display-p3/.test(bg ?? ''), bg)
await press('Control+Shift+KeyK')
await page.select('#cs-display', 'srgb')
await page.click('[data-dialog="colourSettings"] .dialog-foot .primary')

// --- assign profile -----------------------------------------------------------------------------
console.log('\nassign profile')
// Back to Night, the RGB document with the filled layer.
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'Night').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
await frames(page)
await page.evaluate(() => document.querySelector('.layers').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
await frames(page)
check('a click in the empty part of the Layers panel deselects, and Properties shows the document', !!(await page.$('[data-props="document"]')))
await clickMenu('Document', 'doc.assign-profile')
const options = await page.$$eval('#assign-profile option', (os) => os.map((o) => o.textContent))
check('an RGB document is offered RGB profiles only', options.includes('Display P3') && !options.some((o) => /CMYK|Gray/.test(o)), options.join(', '))
const chooser = page.waitForFileChooser()
await page.click('[data-dialog="assignProfile"] .dialog-body .button')
await (await chooser).accept([join(process.cwd(), 'scripts/fixtures/fixture-cmyk.icc')])
check('loading a CMYK profile for an RGB document is refused, saying why', await waitUntil(page, () => /is a CMYK profile/.test(document.querySelector('[data-dialog="assignProfile"] .field-error')?.textContent ?? '')))
const chooser2 = page.waitForFileChooser()
await page.click('[data-dialog="assignProfile"] .dialog-body .button')
await (await chooser2).accept([join(process.cwd(), 'scripts/fixtures/fixture-wide-rgb.icc')])
check('loading an RGB profile adds it and chooses it', await waitUntil(page, () => document.querySelector('#assign-profile')?.selectedOptions[0]?.textContent === 'Fixture Wide RGB'))
await page.click('[data-dialog="assignProfile"] .dialog-foot .primary')
await frames(page)
check('assigning it changes the document’s profile', /Embedded profile/.test((await text('[data-props="document"]')) ?? ''), await text('[data-props="document"]'))
check('as an undoable step', (await page.$$eval('.history-step', (els) => els.map((e) => e.textContent))).at(-1) === 'Assign Profile')

// --- saving pixels -------------------------------------------------------------------------------
console.log('\nsaving pixels')
await press('Control+KeyS')
await waitUntil(page, () => document.querySelector('.tab.active')?.dataset.dirty === 'false')
const entries = await page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')
  const bytes = new Uint8Array(await (await (await d.getFileHandle('Night.pxll')).getFile()).arrayBuffer())
  const text = new TextDecoder('latin1').decode(bytes)
  return { tiles: (text.match(/layers\/t[a-z0-9]+\.tiles/g) ?? []).length, profiles: (text.match(/profiles\/[0-9a-f]{64}\.icc/g) ?? []).length }
})
check('the .pxll holds a tile pack per layer and the embedded profile', entries.tiles >= 4 && entries.profiles >= 2, JSON.stringify(entries))
await press('Control+Alt+KeyW')
await waitUntil(page, () => !!document.querySelector('[data-recent="Night.pxll"]') || document.querySelectorAll('.tab').length > 0)
await page.evaluate(() => (window.__nextOpen = 'Night.pxll'))
await press('Control+KeyO')
await waitUntil(page, () => [...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'Night.pxll'))
check('reopened, the layers have their pixels', (await waitThumb('Layer 1', 'rgb(255, 0, 0)')) && (await waitThumb('Background', 'rgb(0, 0, 0)')), JSON.stringify(await thumbs()))
check('and the document still has its loaded profile', /Embedded profile/.test((await text('[data-props="document"]')) ?? ''))

// --- the journal ---------------------------------------------------------------------------------
console.log('\njournal')
await page.click('.layer-row .layer-name')
await page.click('[data-model="rgb"]')
await setChannels({ R: 0, G: 128, B: 0 })
await page.click('.layer-row .layer-name')
await press('Alt+Backspace')
await waitThumb('Layer 1', 'rgb(0, 128, 0)')
await new Promise((r) => setTimeout(r, 900))
await page.reload()
await waitForEngine(page)
await waitUntil(page, () => document.querySelectorAll('.tab').length >= 4, { timeout: 10000 })
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'Night.pxll').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
check('after a reload, an unsaved fill is restored from the journal', await waitThumb('Layer 1', 'rgb(0, 128, 0)'), JSON.stringify(await thumbs()))
const flyer = await page.evaluate(() => [...document.querySelectorAll('.tab')].some((t) => t.querySelector('.tab-name').textContent === 'Flyer'))
check('every document comes back', flyer)

// --- freeing what nothing uses ----------------------------------------------------------------------
console.log('\ncollection')
for (const t of await page.$$('.tab')) {
  const name = await t.$eval('.tab-name', (e) => e.textContent)
  if (name !== 'Night.pxll') {
    await t.$eval('.tab-close', (b) => b.click())
    await frames(page)
    if (await page.$('[data-dialog="closeDoc"]')) await page.click('[data-dialog="closeDoc"] .danger')
  }
}
await new Promise((r) => setTimeout(r, 2000))
const s2 = await stats()
// Night holds Background and Layer 1; its history since the restore holds
// nothing else. Everything the closed documents held is freed.
check('closing documents frees their tiles', Number(s2.sets) <= 3, JSON.stringify(s2))

await finish()
