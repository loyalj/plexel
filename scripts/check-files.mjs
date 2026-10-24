/**
 * Documents and files, end to end in Chrome: New, edits and their undo,
 * Save, Open, the autosave journal across reloads, closing with unsaved
 * changes, the recent list, saving by download, dropping a file, and
 * opening a damaged one.
 *
 * Headless Chrome can't click a file picker, so the pickers are replaced
 * before the page loads with ones that hand back files in the page's own
 * private storage (OPFS). Those are real FileSystemFileHandles, so the
 * app's save path (permission, createWritable, close) runs as it does for
 * a file on disk, and the file can be read back to see what was written.
 *
 * Run with: npm run check:files
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, finish, frames, launch, open, pageHelpers, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

/** Pickers that save to and open from OPFS. `window.__nextOpen` names the file the next Open picks. */
const MOCK_PICKERS = () => {
  const dir = () => navigator.storage.getDirectory().then((d) => d.getDirectoryHandle('picked', { create: true }))
  window.showSaveFilePicker = async ({ suggestedName }) => (await dir()).getFileHandle(suggestedName, { create: true })
  window.showOpenFilePicker = async () => [await (await dir()).getFileHandle(window.__nextOpen)]
}

const { browser, page, url } = await open({ viewport: { width: 1280, height: 800 } })
await page.evaluateOnNewDocument(MOCK_PICKERS)
await page.goto(url)
await waitForEngine(page)

const { press } = pageHelpers(page)
const text = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => null)
const tabs = () => page.$$eval('.tab', (els) => els.map((e) => ({ name: e.querySelector('.tab-name').textContent, dirty: e.dataset.dirty === 'true', active: e.classList.contains('active') })))
const layerNames = () => page.$$eval('.layer-row .layer-name', (els) => els.map((e) => e.textContent))
const historySteps = () => page.$$eval('.history-step', (els) => els.map((e) => e.textContent))
const clickMenu = async (menu, command) => {
  await page.evaluate((m) => {
    const t = [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m)
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  }, menu)
  await frames(page)
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const typeInto = async (sel, value) => {
  await page.click(sel, { clickCount: 3 })
  await page.keyboard.type(value)
  await frames(page)
}
const opfsBytes = (name) =>
  page.evaluate(async (n) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')
    return [...new Uint8Array(await (await (await d.getFileHandle(n)).getFile()).arrayBuffer())]
  }, name)
const settled = () =>
  waitUntil(page, () => true).then(() => page.evaluate(() => new Promise((r) => setTimeout(r, 700))))

// --- the start screen and New -------------------------------------------------------
console.log('\nnew document')
check('with nothing open the start screen shows', !!(await page.$('[data-screen="start"]')))
await press('Control+Alt+KeyN')
check('Ctrl+Alt+N opens New Document', !!(await page.$('[data-dialog="new"]')))
check('with the name field focused', await page.evaluate(() => document.activeElement?.id === 'new-name'))
await typeInto('#new-name', 'Poster')
await typeInto('#new-width', 'abc')
check('a width that isn’t a number says so', /Enter a number/.test((await text('#new-width-error')) ?? ''))
check('and Create waits', await page.$eval('.dialog-foot .primary', (b) => b.disabled))
await typeInto('#new-width', '400000')
check('a width over the limit says what it comes to', /300,000/.test((await text('#new-width-error')) ?? ''), await text('#new-width-error'))
await typeInto('#new-width', '3000')
await typeInto('#new-height', '2000')
check('the summary shows the size in pixels', /3,000 × 2,000 pixels/.test((await text('[data-summary]')) ?? ''))
await page.select('#new-unit', 'in')
check('changing units converts what was typed', (await page.$eval('#new-width', (i) => i.value)) === '41.667', await page.$eval('#new-width', (i) => i.value))
await page.select('#new-unit', 'px')
// Transparent, so the layer checks below count only the groups they add.
// check:pixels covers backgrounds.
await page.select('#new-background', 'transparent')
await page.focus('#new-name')
await press('Enter')
await waitUntil(page, () => document.querySelectorAll('.tab').length === 1)
check('Enter creates the document', !(await page.$('[data-dialog="new"]')) && (await tabs()).length === 1)
check('its tab is named and marked unsaved', (await tabs())[0]?.name === 'Poster' && (await tabs())[0]?.dirty)
check('the status bar shows its size and mode', /3,000 × 2,000 px · 72 ppi · RGB 8-bit/.test((await text('[data-status="document"]')) ?? ''), await text('[data-status="document"]'))
check('the start screen has gone', !(await page.$('[data-screen="start"]')))
check('the window title names it', (await page.title()).startsWith('Poster •'))

// The engine draws the canvas: checkerboard inside, pasteboard outside.
const shot = async () => decodePng(Buffer.from(await page.screenshot({ type: 'png' })))
const box = await page.$eval('[data-engine-canvas]', (c) => {
  const r = c.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
const checker = (c) => (c[0] === 255 || c[0] === 204) && c[0] === c[1] && c[1] === c[2]
// The first picture takes a few frames; on a warm server the steps above can beat it.
let img = await shot()
for (let i = 0; i < 30 && !checker(pixelAt(img, Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2))); i++) {
  await frames(page)
  img = await shot()
}
const mid = pixelAt(img, Math.round(box.x + box.w / 2), Math.round(box.y + box.h / 2))
const corner = pixelAt(img, Math.round(box.x + 5), Math.round(box.y + 5))
check('the canvas shows the checkerboard where the document is', checker(mid), String(mid))
check('and the pasteboard around it', !checker(corner), String(corner))
check('the zoom is shown', /%$/.test((await text('[data-status="zoom"]')) ?? ''), await text('[data-status="zoom"]'))

// --- editing and history ------------------------------------------------------------------
console.log('\nediting')
await clickMenu('Layer', 'layer.new-group')
await clickMenu('Layer', 'layer.new-group')
check('two new groups, the newest on top', (await layerNames()).join() === 'Group 2,Group 1', (await layerNames()).join())
await press('F2')
await page.keyboard.type('Sky')
await press('Enter')
check('F2 renames the selected layer in place', (await layerNames()).join() === 'Sky,Group 1')
await clickMenu('Window', 'window.panel.history')
check('History lists every step by name', (await historySteps()).join() === 'New Document,New Group,New Group,Rename Layer', (await historySteps()).join())
await press('Control+KeyZ')
check('Ctrl+Z undoes the rename', (await layerNames()).join() === 'Group 2,Group 1')
await page.evaluate(() => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === 'Edit').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
await frames(page)
check('the Edit menu names what Redo brings back', (await text('[data-command="edit.redo"]'))?.includes('Redo Rename Layer'), await text('[data-command="edit.redo"]'))
await press('Escape')
await press('Control+Shift+KeyZ')
check('Ctrl+Shift+Z redoes it', (await layerNames()).join() === 'Sky,Group 1')
await page.click('.history-step:nth-child(1)')
await frames(page)
await page.click('.history-list li:nth-child(2) .history-step')
await frames(page)
check('clicking a step goes straight to it', (await layerNames()).join() === 'Group 1')
await page.click('.history-list li:nth-child(4) .history-step')
await frames(page)
check('and forward again', (await layerNames()).join() === 'Sky,Group 1')

// One drag of the opacity slider is one step.
await page.click('.layer-row[data-layer] .layer-name')
const slider = await (await page.$('#props-opacity')).boundingBox()
await page.mouse.move(slider.x + slider.width - 4, slider.y + slider.height / 2)
await page.mouse.down()
for (let i = 1; i <= 10; i++) await page.mouse.move(slider.x + slider.width * (1 - i / 20), slider.y + slider.height / 2)
await page.mouse.up()
await frames(page)
const opacitySteps = (await historySteps()).filter((s) => s === 'Opacity').length
check('a whole slider drag is one Opacity step', opacitySteps === 1, (await historySteps()).join())
check('and the opacity moved', Number(await page.$eval('.slider-number', (i) => i.value)) < 70)

await press('Control+Alt+KeyC')
await typeInto('#canvas-width', '4000')
await page.click('[data-anchor="0,0"]')
// The anchor button has the focus now, and Enter on a button presses it,
// so the dialog's own button is what applies.
await page.click('[data-dialog="canvasSize"] .dialog-foot .primary')
await frames(page)
check('Canvas Size changes the size', /4,000 × 2,000 px/.test((await text('[data-status="document"]')) ?? ''))
check('and is named as such', (await historySteps()).at(-1) === 'Canvas Size')
await press('Control+KeyZ')
check('and undoes', /3,000 × 2,000 px/.test((await text('[data-status="document"]')) ?? ''))

await page.click('.layer-row .layer-name')
await press('Delete')
check('Delete removes the selected layer', (await layerNames()).join() === 'Group 1', (await layerNames()).join())
await press('Control+KeyZ')

// --- saving ---------------------------------------------------------------------------------
console.log('\nsaving')
await press('Control+KeyS')
const saved = await waitUntil(page, () => document.querySelector('.tab')?.dataset.dirty === 'false', { timeout: 5000 })
check('Ctrl+S on a new document saves it to a chosen file', saved)
check('the tab takes the file’s name and is no longer marked', (await tabs())[0]?.name === 'Poster.pxll' && !(await tabs())[0]?.dirty, JSON.stringify(await tabs()))
const bytes = Buffer.from(await opfsBytes('Poster.pxll'))
check('the file is a zip that begins with its mimetype', bytes.subarray(0, 4).toString('hex') === '504b0304' && bytes.subarray(30, 38 + 20).toString() === 'mimetypeapplication/x-plexel')
check('a notice says it was saved', /Saved “Poster.pxll”/.test((await text('.notices')) ?? ''))

await clickMenu('Layer', 'layer.new-group')
check('an edit marks it unsaved again', (await tabs())[0]?.dirty)
await press('Control+KeyZ')
check('and undoing back to the saved state marks it saved', !(await tabs())[0]?.dirty)
await clickMenu('Layer', 'layer.new-group')
await press('Control+KeyS')
await waitUntil(page, () => document.querySelector('.tab')?.dataset.dirty === 'false')
check('Ctrl+S again saves in place, without asking for a file', !(await tabs())[0]?.dirty && (await tabs()).length === 1)

await page.evaluate(() => (window.__nextOpen = 'Poster.pxll'))
await press('Control+KeyO')
await frames(page)
check('opening a file that is already open brings its tab forward instead of opening it twice', (await tabs()).length === 1)

// --- the journal ------------------------------------------------------------------------------
console.log('\nautosave')
await clickMenu('Layer', 'layer.new-group')
await press('F2')
await page.keyboard.type('Unsaved work')
await press('Enter')
await settled()
await page.reload()
await waitForEngine(page)
await waitUntil(page, () => document.querySelectorAll('.tab').length > 0)
check('after a reload the document is open again', (await tabs()).length === 1 && (await tabs())[0].name === 'Poster.pxll')
check('with its unsaved changes', (await layerNames()).includes('Unsaved work'), (await layerNames()).join())
check('still marked unsaved', (await tabs())[0]?.dirty)
check('its history starts afresh, at Restore', (await historySteps()).join() === 'Restore', (await historySteps()).join())
await press('Control+KeyS')
await waitUntil(page, () => document.querySelector('.tab')?.dataset.dirty === 'false')
check('a restored document still saves to its own file', !(await tabs())[0]?.dirty)

// --- closing --------------------------------------------------------------------------------------
console.log('\nclosing')
await press('Control+Alt+KeyN')
await press('Enter')
await waitUntil(page, () => document.querySelectorAll('.tab').length === 2)
check('a second document opens in a second tab, in front', (await tabs()).length === 2 && (await tabs())[1].active)
await clickMenu('Layer', 'layer.new-group')
await press('Control+Alt+KeyW')
check('closing it with unsaved changes asks first', !!(await page.$('[data-dialog="closeDoc"]')))
check('with Save as the button that has the focus', await page.evaluate(() => document.activeElement?.textContent === 'Save'))
await page.click('[data-dialog="closeDoc"] .dialog-foot .button:not(.primary):not(.danger)')
await frames(page)
check('Cancel keeps it open', (await tabs()).length === 2)
await press('Control+Alt+KeyW')
await page.click('[data-dialog="closeDoc"] .danger')
await frames(page)
check('Don’t Save closes it, and the other comes to the front', (await tabs()).length === 1 && (await tabs())[0].active)
await press('Control+Alt+KeyW')
check('a document with nothing unsaved closes without asking', (await tabs()).length === 0 && !(await page.$('[data-dialog="closeDoc"]')))
const recent = await waitUntil(page, () => !!document.querySelector('[data-recent="Poster.pxll"]'))
check('the start screen lists it under Recent', recent)
await page.click('[data-recent="Poster.pxll"]')
await waitUntil(page, () => document.querySelectorAll('.tab').length === 1)
check('and opens it from there', (await tabs())[0]?.name === 'Poster.pxll' && !(await tabs())[0].dirty)
check('as it was saved', (await layerNames()).includes('Unsaved work'))

// --- opening by drop, and a damaged file ---------------------------------------------------------
console.log('\ndrop and damage')
await page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')
  const file = new File([await (await d.getFileHandle('Poster.pxll')).getFile()], 'Copy.pxll')
  const dt = new DataTransfer()
  dt.items.add(file)
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
})
await waitUntil(page, () => document.querySelectorAll('.tab').length === 2)
check('dropping a .pxll opens it', (await tabs()).some((t) => t.name === 'Copy.pxll'))

await page.evaluate(async () => {
  const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')
  const w = await (await d.getFileHandle('broken.pxll', { create: true })).createWritable()
  await w.write(new Uint8Array([80, 75, 3, 4, 1, 2, 3]))
  await w.close()
  window.__nextOpen = 'broken.pxll'
})
await press('Control+KeyO')
const refused = await waitUntil(page, () => !!document.querySelector('[data-notice="error"]'))
check('a damaged file is refused with a message', refused && /couldn’t be opened/.test((await text('[data-notice="error"]')) ?? ''))
check('and opens nothing', (await tabs()).length === 2)

// --- the start page's own cards ---------------------------------------------------------------
console.log('\nstart page')
await press('Control+Alt+KeyW')
await press('Control+Alt+KeyW')
await waitUntil(page, () => !!document.querySelector('[data-screen="start"]'))
await page.click('[data-start-card="preset-square"]')
await waitUntil(page, () => document.querySelectorAll('.tab').length === 1)
check('a preset card makes its document at once', !(await page.$('[data-dialog="new"]')) && (await tabs())[0]?.name === 'Untitled')
check('at the preset’s size and mode', /2,048 × 2,048 px · 72 ppi · RGB 8-bit/.test((await text('[data-status="document"]')) ?? ''), await text('[data-status="document"]'))
await press('Control+KeyS')
await waitUntil(page, () => document.querySelector('.tab')?.dataset.dirty === 'false')
await press('Control+Alt+KeyW')
await waitUntil(page, () => !!document.querySelector('[data-screen="start"]'))
const pictured = await waitUntil(page, () => {
  const img = document.querySelector('[data-recent="Untitled.pxll"] img')
  return !!img && img.complete && img.naturalWidth > 0
})
check('a saved file shows its picture under Recent', pictured)
await page.click('[data-recent="Untitled.pxll"] + .start-forget')
const forgotten = await waitUntil(page, () => !document.querySelector('[data-recent="Untitled.pxll"]'))
check('× takes a file off Recent', forgotten)
await page.click('[data-start-card="custom"]')
check('Custom… opens New Document', !!(await waitUntil(page, () => !!document.querySelector('[data-dialog="new"]'))))
await browser.close()

// --- saving by download, without File System Access -----------------------------------------------
console.log('\ndownload')
const plain = await launch()
const downloads = mkdtempSync(join(tmpdir(), 'plexel-dl-'))
const page2 = await plain.newPage()
await page2.setViewport({ width: 1280, height: 800 })
await page2.evaluateOnNewDocument(() => {
  delete window.showSaveFilePicker
  delete window.showOpenFilePicker
})
const cdp = await page2.createCDPSession()
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
await page2.goto(url)
await waitForEngine(page2)
await page2.waitForSelector('[data-screen="start"]')
check('without File System Access the start page has no Recent', !(await page2.$('.start-recent, .start-empty')) && !!(await page2.$('[data-start-card="open"]')))
await page2.keyboard.down('Control')
await page2.keyboard.down('Alt')
await page2.keyboard.press('KeyN')
await page2.keyboard.up('Alt')
await page2.keyboard.up('Control')
await page2.waitForSelector('#new-name')
await page2.click('#new-name', { clickCount: 3 })
await page2.keyboard.type('Download me')
await page2.keyboard.press('Enter')
// New waits for its background fill, so the tab comes a moment later.
await waitUntil(page2, () => document.querySelectorAll('.tab').length === 1)
await page2.keyboard.down('Control')
await page2.keyboard.press('KeyS')
await page2.keyboard.up('Control')
const got = await (async () => {
  for (let i = 0; i < 50; i++) {
    const f = readdirSync(downloads).find((n) => n.endsWith('.pxll'))
    if (f) return f
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
})()
check('without File System Access, Save downloads the file', got === 'Download me.pxll', String(got))
if (got) {
  const b = readFileSync(join(downloads, got))
  check('and the download is a .pxll', b.subarray(30, 38 + 20).toString() === 'mimetypeapplication/x-plexel')
}
check('and the tab is marked saved', await page2.$eval('.tab', (t) => t.dataset.dirty === 'false'))
await plain.close()
rmSync(downloads, { recursive: true, force: true })

await finish()
