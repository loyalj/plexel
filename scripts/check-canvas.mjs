/**
 * The canvas in Chrome: what the render graph draws, read back from
 * screenshots, and everything that moves the view.
 *
 * Layers composite as they should (blend modes, opacity, fill, hiding,
 * pass-through and isolated groups, knockout, clipping by nesting); images
 * dropped on the canvas become layers where they're dropped, and dropped
 * elsewhere open as documents in their own mode and depth; zoom keys,
 * the wheel, the view tools and rotation move the view and keep the image
 * where they should; layers drag and drop in the panel; exports carry the
 * composite and the profile; saved files carry previews; big files open
 * with their tiles read on demand, and save back in place.
 *
 * Run with: npm run check:canvas
 */
import { deflateSync } from 'node:zlib'
import { check, finish, frames, open, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const MOCK_PICKERS = () => {
  const dir = () => navigator.storage.getDirectory().then((d) => d.getDirectoryHandle('picked', { create: true }))
  window.showSaveFilePicker = async ({ suggestedName }) => (await dir()).getFileHandle(suggestedName, { create: true })
  window.showOpenFilePicker = async () => [await (await dir()).getFileHandle(window.__nextOpen)]
}

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.evaluateOnNewDocument(MOCK_PICKERS)
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const press = async (combo) => {
  const keys = combo.split('+')
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k)
  await page.keyboard.press(keys[keys.length - 1])
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k)
  await frames(page)
}
const clickMenu = async (menu, command) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
/**
 * Until the canvas is up to date: two frames for React's effects to send
 * what changed, then the engine's word that it has drawn all of it.
 */
const rendered = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
}
const canvasRect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
/** The colour on screen at an offset from the canvas's centre. */
const at = async (dx = 0, dy = 0, img) => {
  const r = await canvasRect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const near = (a, b, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const status = (what) => page.$eval(`[data-status="${what}"]`, (e) => e.textContent).catch(() => null)
const view = () => page.evaluate(() => globalThis.plexel.views().front())
const tree = () =>
  page.evaluate(() => {
    const d = globalThis.plexel.documents().active().history.present
    const name = (id) => d.nodes[id].name
    const walk = (id) => (d.nodes[id].children ?? []).map((c) => (d.nodes[c].children?.length ? `${name(c)}[${walk(c).join(',')}]` : name(c)))
    return walk(d.root).join(',')
  })
const newDoc = async ({ name, preset, width, height, background }) => {
  await press('Control+Alt+KeyN')
  await page.waitForSelector('#new-name')
  if (preset) await page.select('#new-preset', preset)
  await page.click('#new-name', { clickCount: 3 })
  await page.keyboard.type(name)
  for (const [id, v] of [['#new-width', width], ['#new-height', height]]) {
    if (v === undefined) continue
    await page.click(id, { clickCount: 3 })
    await page.keyboard.type(String(v))
  }
  if (background) await page.select('#new-background', background)
  await page.click('[data-dialog="new"] .dialog-foot .primary')
  await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
  await rendered()
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
const selectLayer = async (name) => {
  await page.evaluate((n) => [...document.querySelectorAll('.layer-row')].find((r) => r.querySelector('.layer-name').textContent === n).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })), name)
  await page.evaluate(() => dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  await frames(page)
}
const setPercent = async (id, v) => {
  await page.click(`#${id} ~ .slider-number, #${id} + .slider-number`).catch(() => {})
  await page.evaluate((i) => document.getElementById(i).parentElement.querySelector('.slider-number').focus(), id)
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.type(String(v))
  await page.keyboard.press('Enter')
  await frames(page)
}
/** Drags a layer's row onto another's top edge, middle or bottom edge. */
const dragLayer = async (name, onto, where) => {
  const row = async (n) => {
    const h = await page.evaluateHandle((x) => [...document.querySelectorAll('.layer-row')].find((r) => r.querySelector('.layer-name').textContent === x), n)
    return h.asElement().boundingBox()
  }
  const a = await row(name)
  const b = await row(onto)
  const y = where === 'above' ? b.y + 3 : where === 'below' ? b.y + b.height - 3 : b.y + b.height / 2
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 8, { steps: 2 })
  await page.mouse.move(b.x + b.width / 2, y, { steps: 4 })
  await page.mouse.up()
  await frames(page)
}

/** A PNG, built here: `pixel(x, y)` gives each pixel's samples. */
function png(w, h, depth, colour, pixel, icc) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    Buffer.from(data).copy(out, 8)
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = depth
  ihdr[9] = colour
  const rows = []
  for (let y = 0; y < h; y++) {
    rows.push(0)
    for (let x = 0; x < w; x++) for (const v of pixel(x, y)) depth === 16 ? rows.push(v >> 8, v & 255) : rows.push(v)
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)]
  if (icc) parts.push(chunk('iCCP', Buffer.concat([Buffer.from('test\0\0', 'latin1'), deflateSync(icc)])))
  parts.push(chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

/** An uncompressed CMYK TIFF, little-endian, one strip. */
function cmykTiff(w, h, cmyk) {
  const data = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(cmyk, i * 4)
  const entries = [
    [256, 4, w], [257, 4, h], [258, 3, 8], [259, 3, 1], [262, 3, 5], [273, 4, 0], [277, 3, 4], [278, 4, h], [279, 4, data.length], [284, 3, 1],
  ]
  const ifd = 8
  const dataAt = ifd + 2 + entries.length * 12 + 4 + 8
  const out = Buffer.alloc(dataAt + data.length)
  out.write('II', 0, 'latin1')
  out.writeUInt16LE(42, 2)
  out.writeUInt32LE(ifd, 4)
  out.writeUInt16LE(entries.length, ifd)
  entries.forEach(([tag, type, v], i) => {
    const e = ifd + 2 + i * 12
    out.writeUInt16LE(tag, e)
    out.writeUInt16LE(type, e + 2)
    // BitsPerSample has four values; they're all 8, so one short in place will do for a reader that only reads the first.
    out.writeUInt32LE(tag === 258 ? 1 : 1, e + 4)
    if (tag === 273) out.writeUInt32LE(dataAt, e + 8)
    else if (type === 3) out.writeUInt16LE(v, e + 8)
    else out.writeUInt32LE(v, e + 8)
  })
  data.copy(out, dataAt)
  return out
}

/** Drops a file made of `bytes` on the canvas (at an offset from its centre) or elsewhere. */
const drop = async (bytes, name, type, where) => {
  const r = await canvasRect()
  const pt = where === 'canvas' ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: r.x + r.w + 40, y: 200 }
  await page.evaluate(
    (b64, n, t, p, onCanvas) => {
      const bin = atob(b64)
      const u = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([u], n, { type: t }))
      const target = onCanvas ? document.querySelector('[data-engine-canvas]') : document.querySelector('.dock') ?? document.body
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: p.x, clientY: p.y }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: p.x, clientY: p.y }))
    },
    Buffer.from(bytes).toString('base64'),
    name,
    type,
    pt,
    where === 'canvas',
  )
}
const picked = (name) =>
  page.evaluate(async (n) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')
    return [...new Uint8Array(await (await (await d.getFileHandle(n)).getFile()).arrayBuffer())]
  }, name)

// --- compositing on screen -------------------------------------------------------------------
console.log('\ncompositing')
await newDoc({ name: 'Paint' })
check('a new document shows its white Background', near(await at(), [255, 255, 255]), String(await at()))
await clickMenu('Layer', 'layer.new-pixel')
await setForeground(255, 0, 0)
await press('Alt+Backspace')
await rendered()
check('a layer filled red shows red', near(await at(), [255, 0, 0]), String(await at()))
await clickMenu('Layer', 'layer.new-pixel')
await setForeground(0, 0, 255)
await press('Alt+Backspace')
await rendered()
check('a blue layer above it covers it', near(await at(), [0, 0, 255]))
await setPercent('props-opacity', 50)
await rendered()
check('at 50% opacity the two mix half and half', near(await at(), [128, 0, 128]), String(await at()))
await setPercent('props-opacity', 100)
await setPercent('props-fill', 50)
await rendered()
check('fill opacity fades the content the same way', near(await at(), [128, 0, 128]), String(await at()))
await setPercent('props-fill', 100)
await page.select('#props-blend', 'multiply')
await rendered()
check('Multiply: blue on red is black', near(await at(), [0, 0, 0]), String(await at()))
await page.select('#props-blend', 'screen')
await rendered()
check('Screen: blue on red is magenta', near(await at(), [255, 0, 255]), String(await at()))
await page.select('#props-blend', 'difference')
await rendered()
check('Difference: blue on red is magenta too', near(await at(), [255, 0, 255]))
await page.select('#props-blend', 'normal')
await press('Control+Comma')
await rendered()
check('hiding the top layer shows the red again', near(await at(), [255, 0, 0]), String(await at()))
await press('Control+Comma')
await rendered()

console.log('\ngroups, knockout and clipping')
await clickMenu('Layer', 'layer.new-group')
await dragLayer('Layer 2', 'Group 1', 'into')
check('dropping a layer on the middle of a group puts it inside', (await tree()) === 'Background,Layer 1,Group 1[Layer 2]', await tree())
await selectLayer('Group 1')
await setPercent('props-opacity', 50)
await rendered()
check('a pass-through group at 50% fades its layers over what’s below', near(await at(), [128, 0, 128]), String(await at()))
await page.select('#props-blend', 'normal')
await rendered()
check('so does an isolated one, here', near(await at(), [128, 0, 128]), String(await at()))
await setPercent('props-opacity', 100)
await page.select('#props-blend', 'pass-through')
await page.select('#props-knockout', 'deep')
await selectLayer('Layer 2')
await setPercent('props-fill', 0)
await rendered()
check('a deep knockout layer at 0% fill punches down to the bottom layer', near(await at(), [255, 255, 255]), String(await at()))
await selectLayer('Group 1')
await page.select('#props-knockout', 'shallow')
await rendered()
check('a shallow one only to the layers below its group', near(await at(), [255, 0, 0]), String(await at()))
await page.select('#props-knockout', 'none')
await selectLayer('Layer 2')
await setPercent('props-fill', 100)
await rendered()

const green = png(100, 100, 8, 6, () => [0, 255, 0, 255])
await drop(green, 'green.png', 'image/png', 'canvas')
await waitUntil(page, () => [...document.querySelectorAll('.layer-name')].some((e) => e.textContent === 'green'))
await rendered()
check('an image dropped on the canvas becomes a layer, there', near(await at(), [0, 255, 0]) && near(await at(80, 0), [0, 0, 255]), `${await at()} / ${await at(80, 0)}`)
check('named after its file', (await tree()).includes('green'))
await dragLayer('Layer 2', 'green', 'into')
await rendered()
check('dropping a layer on another clips it: blue only where the green layer is', near(await at(), [0, 0, 255]) && near(await at(80, 0), [255, 0, 0]), `${await at()} / ${await at(80, 0)}`)
check('the tree shows it nested', /green\[Layer 2\]/.test(await tree()), await tree())
await dragLayer('Layer 2', 'Layer 1', 'above')
check('dragging it back out, above Layer 1', (await tree()).startsWith('Background,Layer 1,Layer 2'), await tree())
await press('Control+KeyZ')
check('one undo puts the move back', /green\[Layer 2\]/.test(await tree()))
await waitUntil(page, () => [...document.querySelectorAll('.layer-row')].some((r) => r.querySelector('.layer-name').textContent === 'green' && r.querySelector('.layer-thumb')?.dataset.thumb === 'image'))
check('its thumbnail is rendered by the engine', (await page.evaluate(() => [...document.querySelectorAll('.layer-row')].find((r) => r.querySelector('.layer-name').textContent === 'green').querySelector('.layer-thumb').dataset.colour)) === 'rgb(0, 0, 255)')

// --- the view ------------------------------------------------------------------------------------
console.log('\nthe view')
const fitZoom = await status('zoom')
check('a document opens fitted, below 100%', /%$/.test(fitZoom ?? '') && parseFloat(fitZoom) < 100, fitZoom)
await press('Control+Digit1')
await rendered()
check('Ctrl+1 is 100%', (await status('zoom')) === '100%')
const width = async () => {
  const img = await shot()
  const r = await canvasRect()
  const y = Math.round(r.y + r.h / 2)
  let n = 0
  for (let x = Math.round(r.x); x < r.x + r.w; x++) if (near(pixelAt(img, x, y).slice(0, 3), [0, 0, 255], 8)) n++
  return n
}
check('at 100% the 100-pixel image is 100 pixels on screen', Math.abs((await width()) - 100) <= 1, String(await width()))
await press('Control+Equal')
await rendered()
check('Ctrl+= steps to 200%, and it’s 200 pixels across', (await status('zoom')) === '200%' && Math.abs((await width()) - 200) <= 2, `${await status('zoom')} ${await width()}`)
await press('Control+Minus')
await rendered()
check('Ctrl+− steps back to 100%', (await status('zoom')) === '100%')

const r = await canvasRect()
await page.mouse.move(r.x + r.w / 2 + 30, r.y + r.h / 2)
const before = await view()
await page.keyboard.down('Control')
await page.mouse.wheel({ deltaY: -200 })
await page.keyboard.up('Control')
await rendered()
const after = await view()
check('Ctrl+wheel zooms in', after.zoom > before.zoom * 1.5, `${before.zoom} → ${after.zoom}`)
// The point under the pointer: 30 CSS pixels right of centre, in document pixels.
const under = (v) => v.cx + 30 / v.zoom
check('about the point under the pointer', Math.abs(under(before) - under(after)) < 0.5, `${under(before)} vs ${under(after)}`)
await press('Control+Digit1')
await rendered()

await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
await page.keyboard.down('Space')
await page.mouse.down()
await page.mouse.move(r.x + r.w / 2 + 120, r.y + r.h / 2, { steps: 5 })
await page.mouse.up()
await page.keyboard.up('Space')
await rendered()
check('Space-drag pans: the image follows the pointer', near(await at(120, 0), [0, 0, 255]) && near(await at(), [255, 0, 0]), `${await at(120, 0)} / ${await at()}`)
await press('KeyZ')
check('Z chooses the Zoom tool', (await page.$eval('[data-tool="zoom"]', (b) => b.getAttribute('aria-pressed'))) === 'true')
await page.mouse.click(r.x + r.w / 2 + 120, r.y + r.h / 2)
await rendered()
check('a click with it zooms in a step, keeping the image under the click', (await status('zoom')) === '200%' && near(await at(120, 0), [0, 0, 255]), await status('zoom'))
await page.keyboard.down('Alt')
await page.mouse.click(r.x + r.w / 2 + 120, r.y + r.h / 2)
await page.keyboard.up('Alt')
await rendered()
check('Alt-click zooms out', (await status('zoom')) === '100%')
await press('KeyH')
await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
await page.mouse.down()
await page.mouse.move(r.x + r.w / 2 - 120, r.y + r.h / 2, { steps: 5 })
await page.mouse.up()
await rendered()
check('the Hand tool drags it back', near(await at(), [0, 0, 255]), String(await at()))

// Fitting centres the document, and the square was dropped at its centre.
await press('Control+Digit0')
await press('Control+Digit1')
await clickMenu('View', 'view.rotate-right')
await clickMenu('View', 'view.rotate-right')
await clickMenu('View', 'view.rotate-right')
await rendered()
check('rotating the view three times 15° turns it 45°', (await status('rotation')) === '45°', await status('rotation'))
check('and the square turns with it: its corner reaches past where its side was', near(await at(62, 0), [0, 0, 255]) && near(await at(46, 46), [255, 0, 0]), `${await at(62, 0)} / ${await at(46, 46)}`)
await clickMenu('View', 'view.reset-rotation')
await rendered()
check('Reset Rotation puts it straight', (await status('rotation')) === null && near(await at(46, 46), [0, 0, 255]) && near(await at(62, 0), [255, 0, 0]))
await press('Control+Digit0')
await rendered()
check('Ctrl+0 fits it again', (await status('zoom')) === fitZoom)

// --- export ---------------------------------------------------------------------------------------
console.log('\nexport')
await press('Control+Alt+Shift+KeyW')
check('Export opens its dialog', !!(await page.$('[data-dialog="export"]')))
check('which says what a PNG will hold', /8-bit RGB with transparency, with the document’s profile/.test(await page.$eval('[data-export-summary]', (e) => e.textContent)))
await page.click('[data-dialog="export"] .dialog-foot .primary')
await waitUntil(page, () => [...document.querySelectorAll('.notice')].some((n) => /Exported “Paint.png”/.test(n.textContent)), { timeout: 15000 })
const pngOut = Buffer.from(await picked('Paint.png'))
const decoded = decodePng(pngOut)
check('the PNG is the document’s size', decoded.width === 1920 && decoded.height === 1080)
check('and holds the composite: blue in the middle, red around it', near(pixelAt(decoded, 960, 540).slice(0, 3), [0, 0, 255], 0) && near(pixelAt(decoded, 960 + 80, 540).slice(0, 3), [255, 0, 0], 0))
check('with the profile embedded', pngOut.includes(Buffer.from('iCCP')))
await press('Control+Alt+Shift+KeyW')
await page.select('#export-format', 'jpeg')
check('JPEG is said to be 8-bit on white', /8-bit RGB on white/.test(await page.$eval('[data-export-summary]', (e) => e.textContent)))
await page.click('[data-dialog="export"] .dialog-foot .primary')
await waitUntil(page, () => [...document.querySelectorAll('.notice')].some((n) => /Exported “Paint.jpg”/.test(n.textContent)), { timeout: 15000 })
const jpg = Buffer.from(await picked('Paint.jpg'))
check('the JPEG is a JPEG, with an ICC profile', jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.includes(Buffer.from('ICC_PROFILE')))

// --- importing as documents ------------------------------------------------------------------------
console.log('\nimages as documents')
const deep = png(64, 48, 16, 2, (x) => [x * 1000, 30000, 65535 - x * 1000], Buffer.from('not a real profile'))
await drop(deep, 'deep.png', 'image/png', 'elsewhere')
await waitUntil(page, () => [...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'deep'), { timeout: 10000 })
await rendered()
check('a 16-bit PNG dropped off the canvas opens as a 16-bit RGB document', /64 × 48 px.*RGB 16-bit/.test((await status('document')) ?? ''), await status('document'))
check('and a profile that can’t be read is said so', await waitUntil(page, () => [...document.querySelectorAll('.notice')].some((n) => /profile couldn’t be read/.test(n.textContent))))
await drop(cmykTiff(40, 30, [255, 0, 0, 0]), 'cyan.tif', 'image/tiff', 'elsewhere')
await waitUntil(page, () => [...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'cyan'), { timeout: 10000 })
await rendered()
check('a CMYK TIFF opens as a CMYK document', /40 × 30 px.*CMYK 8-bit/.test((await status('document')) ?? ''), await status('document'))
const cyan = await at()
// What Generic CMYK makes of full cyan in sRGB, as LittleCMS converts it directly.
check('and full cyan ink shows as the profile says it looks', near(cyan, [80, 250, 251], 3), String(cyan))
const jpegBytes = await page.evaluate(async () => {
  const c = new OffscreenCanvas(30, 20)
  const g = c.getContext('2d')
  g.fillStyle = '#ffcc00'
  g.fillRect(0, 0, 30, 20)
  return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer())]
})
await drop(Buffer.from(jpegBytes), 'sun.jpg', 'image/jpeg', 'elsewhere')
await waitUntil(page, () => [...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'sun'), { timeout: 10000 })
await rendered()
check('a JPEG opens as an 8-bit RGB document', /30 × 20 px.*RGB 8-bit/.test((await status('document')) ?? ''))
check('in its colours', near(await at(), [255, 204, 0], 6), String(await at()))

// --- saved files: previews, and reading big files on demand ---------------------------------------
console.log('\nsaving and reopening')
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-name').textContent === 'Paint').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
await rendered()
await press('Control+KeyS')
await waitUntil(page, () => document.querySelector('.tab.active')?.dataset.dirty === 'false', { timeout: 15000 })
const pxll = Buffer.from(await picked('Paint.pxll'))
check('a saved .pxll carries thumbnail.png and preview.png', pxll.includes(Buffer.from('thumbnail.png')) && pxll.includes(Buffer.from('preview.png')))
await press('Control+Alt+KeyW')
await page.evaluate(() => {
  globalThis.plexelLazyBytes = 1
  window.__nextOpen = 'Paint.pxll'
})
await press('Control+KeyO')
await waitUntil(page, () => [...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'Paint.pxll'), { timeout: 10000 })
await rendered()
check('opened with its tiles left in the file, it draws as it did', near(await at(), [0, 0, 255]) || near(await at(), [0, 255, 0]), String(await at()))
await clickMenu('Layer', 'layer.new-pixel')
await press('Control+KeyS')
await waitUntil(page, () => document.querySelector('.tab.active')?.dataset.dirty === 'false', { timeout: 15000 })
await press('Control+Alt+KeyW')
await press('Control+KeyO')
await waitUntil(page, () => [...document.querySelectorAll('.tab-name')].some((t) => t.textContent === 'Paint.pxll'), { timeout: 10000 })
await rendered()
check('saved back over that same file, and opened again, nothing is lost', (await tree()).endsWith('Layer 3') && (near(await at(), [0, 0, 255]) || near(await at(), [0, 255, 0])), `${await tree()} ${await at()}`)
await settle(300)

await finish()
