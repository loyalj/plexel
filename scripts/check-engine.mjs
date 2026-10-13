/**
 * The engine worker, in a real Chrome on the real GPU: it gets a device,
 * draws, follows the theme and the canvas size, and says clearly when there
 * is no WebGPU at all.
 *
 * The canvas belongs to the worker, so the page can't read its pixels.
 * What the engine drew is read from screenshots instead, which go through
 * the compositor the way the user sees them.
 *
 * Run with: npm run check:engine
 */
import { check, finish, frames, launch, open, problems, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, hexRgb, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 800 } })

/** The colour the engine drew at (x, y) of the canvas, in CSS pixels. */
async function canvasPixel(x, y) {
  const box = await page.$eval('[data-engine-canvas]', (c) => {
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y }
  })
  const png = await page.screenshot({ clip: { x: box.x + x, y: box.y + y, width: 1, height: 1 }, type: 'png' })
  return pixelAt(decodePng(Buffer.from(png)), 0, 0).slice(0, 3)
}
const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)
const near = (a, b, tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

console.log('\nstart-up')
await page.goto(url)
check('the engine reports a ready GPU', await waitForEngine(page))
check('the page is cross-origin isolated', await page.evaluate(() => crossOriginIsolated))
const status = await page.$eval('[data-engine-status]', (e) => e.textContent)
check('the status bar names the adapter', /GPU ready\S*.+/.test(status ?? ''), status)

console.log('\ndrawing')
const dark = await token('--pasteboard')
const drawn = await canvasPixel(40, 40)
check('the canvas shows the theme’s pasteboard', near(drawn, hexRgb(dark)), `drew ${drawn}, theme ${dark}`)

// A different palette: the engine is told and redraws.
await page.keyboard.down('Control')
await page.keyboard.down('Shift')
await page.keyboard.press('KeyL')
await page.keyboard.up('Shift')
await page.keyboard.up('Control')
const light = await token('--pasteboard')
check('switching mode changes the pasteboard token', light !== dark, `${dark} → ${light}`)
let redrawn = false
for (let i = 0; i < 30 && !redrawn; i++) {
  redrawn = near(await canvasPixel(40, 40), hexRgb(light))
  if (!redrawn) await frames(page)
}
check('the engine redraws in the new pasteboard', redrawn, `drew ${await canvasPixel(40, 40)}, theme ${light}`)
check('the pasteboard is a neutral grey as drawn', ((c) => c[0] === c[1] && c[1] === c[2])(await canvasPixel(40, 40)))

console.log('\nsize')
const sized = async () =>
  page.evaluate(() => {
    const c = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
    const text = document.querySelector('[data-status="canvas"]').textContent
    const m = /(\d+) × (\d+) px/.exec(text)
    return {
      want: [Math.round(c.width * devicePixelRatio), Math.round(c.height * devicePixelRatio)],
      got: m ? [Number(m[1]), Number(m[2])] : null,
    }
  })
const first = await sized()
check('the canvas is drawn at its size in device pixels', String(first.want) === String(first.got), JSON.stringify(first))

await page.setViewport({ width: 900, height: 600 })
const resized = await waitUntil(
  page,
  () => {
    const c = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
    const m = /(\d+) × (\d+) px/.exec(document.querySelector('[data-status="canvas"]').textContent)
    return m && Number(m[1]) === Math.round(c.width * devicePixelRatio) && Number(m[2]) === Math.round(c.height * devicePixelRatio)
  },
  { timeout: 5000 },
)
check('after a resize the engine draws at the new size', resized, JSON.stringify(await sized()))

// A real 2× screen, not puppeteer's emulated one: emulation changes
// devicePixelRatio but leaves the device-pixel box at CSS size, so it can't
// say whether the canvas follows the ratio.
const retina = await launch({ args: ['--force-device-scale-factor=2'], defaultViewport: null })
const page3 = (await retina.pages())[0] ?? (await retina.newPage())
await page3.goto(url)
await waitForEngine(page3)
const hidpi = await waitUntil(
  page3,
  () => {
    const c = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
    const m = /(\d+) × (\d+) px/.exec(document.querySelector('[data-status="canvas"]').textContent)
    return devicePixelRatio === 2 && m && Number(m[1]) === Math.round(c.width * 2) && Number(m[2]) === Math.round(c.height * 2)
  },
  { timeout: 5000 },
)
const hidpiSize = await page3.evaluate(() => [devicePixelRatio, document.querySelector('[data-status="canvas"]').textContent])
check('on a 2× screen the canvas has twice the pixels', hidpi, JSON.stringify(hidpiSize))
await retina.close()

console.log('\nidle')
// Frames are drawn on demand. Sitting still for a second must not draw.
const framesNow = async () => page.evaluate(() => Number(document.querySelector('[data-engine-status]').dataset.frames))
const before = await framesNow()
await new Promise((r) => setTimeout(r, 1000))
const after = await framesNow()
check('an idle editor draws no frames', Number.isFinite(before) && before === after, `${before} → ${after}`)

console.log('\nno WebGPU')
// A second Chrome with the GPU turned off and WebGPU left behind its flag:
// the engine finds no adapter and the page says so instead of drawing an
// editor that can't draw.
const bare = await launch({ bare: true })
const page2 = await bare.newPage()
const errors = []
page2.on('pageerror', (e) => errors.push(e.message))
await page2.goto(url)
const shown = await waitUntil(page2, () => !!document.querySelector('[data-screen="unsupported"]'), { timeout: 15000 })
check('without WebGPU the page explains instead of drawing an editor', shown)
const text = shown ? await page2.$eval('[data-screen="unsupported"]', (e) => e.textContent) : ''
check('it says what is missing and what would fix it', /WebGPU/.test(text) && /Chrome/.test(text), text.slice(0, 120))
check('and raises no errors of its own', errors.length === 0, errors.join('; '))
await bare.close()

await finish({ ok: problems.length === 0 })
