/**
 * What every browser suite needs before it can check anything: a dev
 * server, a Chrome with WebGPU, a page that reports its own errors, a way to
 * record a result, and a way to wait for the app instead of guessing how
 * long it takes.
 *
 * Taken from Fresyn's harness, which earned its shape there: a suite starts
 * its own server on a free port, so `npm run check:shell` is the whole
 * instruction. Set DEV_URL to aim a suite at a server already running (the
 * aggregate runner does, so the suites share one), and CHROME_PATH if the
 * browser is somewhere this file doesn't look.
 *
 * The API, in the order a suite uses it:
 *
 *   const { browser, page, url } = await open({ viewport, httpErrors })
 *       starts (or reuses) the dev server, launches Chrome, opens a page and
 *       starts collecting its console errors and page errors in `problems`.
 *       It does not navigate: the suite does `page.goto(url, ...)`.
 *   check(name, ok, detail?)      record and print one result
 *   failed()                      how many checks have failed so far
 *   problems                      array of stray errors the page reported
 *   waitUntil(page, fn, { timeout = 5000, args }) -> boolean
 *       resolves true as soon as fn(...args) is truthy in the page, false if
 *       it never is. It never throws on a timeout: the check that follows is
 *       the one that should fail, with its own message.
 *   waitForEngine(page, timeout?) -> boolean
 *       until the status bar says the GPU is ready
 *   waitForAnimations(page, timeout?)
 *   frames(page)                  two animation frames: an edit has landed
 *   settle(ms)                    a plain sleep, for when there is genuinely
 *                                 nothing in the page to wait on
 *   finish({ ok, cleanup })       prints the problems, closes Chrome and the
 *                                 server, prints PASS or FAIL and exits
 *
 * Lower-level pieces are exported too: findChrome(), launch(),
 * startDevServer() and withDevServer(fn).
 */
import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- results ----------------------------------------------------------
let failures = 0

/** Record one result. Prints as it goes, so a hang shows where it hung. */
export function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

/** How many checks have failed so far. */
export const failed = () => failures

/**
 * Errors the page raised on its own: console errors, uncaught exceptions,
 * and (when asked for) failed requests. Any of them fails the suite, because
 * an error nobody asserted on is still an error the user would have seen.
 */
export const problems = []

// --- time -------------------------------------------------------------
/** A fixed pause. Prefer waitUntil wherever there is something to wait for. */
export const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for a condition in the page. A fixed sleep is either too short on a
 * slow machine or wasted on a fast one; this is as long as it takes and no
 * longer. Returns whether the condition came true, rather than throwing, so
 * the assertion after it still reports what was wrong.
 */
export async function waitUntil(page, fn, { timeout = 5000, args = [], polling = 'raf' } = {}) {
  try {
    await page.waitForFunction(fn, { timeout, polling }, ...args)
    return true
  } catch (e) {
    if (e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message))) return false
    throw e
  }
}

/**
 * Until the engine has a device and has drawn: the status bar's engine
 * chip says `ready`. The first device on a cold Chrome can take a couple of
 * seconds, hence the longer default.
 */
export const waitForEngine = (page, timeout = 15000) =>
  waitUntil(page, () => document.querySelector('[data-engine-status]')?.getAttribute('data-engine-status') === 'ready', {
    timeout,
  })

/** Wait for every finite CSS transition and animation to finish. Looping ones never do, so they're left out. */
export const waitForAnimations = (page, timeout = 5000) =>
  waitUntil(
    page,
    () =>
      document
        .getAnimations()
        .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
    { timeout },
  )

/**
 * Let the page draw twice. A pointer or key event is committed by React
 * before the next frame and its effects run just after, so two frames is
 * when an edit has landed in the DOM.
 */
export const frames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

// --- chrome -----------------------------------------------------------
/**
 * Where Chrome usually lives. CHROME_PATH wins; after that the usual install
 * paths for each platform, first hit taken. puppeteer-core ships no browser
 * of its own, which is the point: the suites run in the Chrome people use.
 */
export function findChrome() {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
    throw new Error(`CHROME_PATH is set to ${process.env.CHROME_PATH}, which does not exist`)
  }
  const env = process.env
  const candidates = {
    win32: [
      env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
      env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      env.HOME && join(env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
  }[process.platform] ?? []
  const found = candidates.filter(Boolean).find((p) => existsSync(p))
  if (found) return found
  throw new Error(
    `No Chrome found for ${process.platform}. Install Chrome, or set CHROME_PATH to a Chrome or Chromium binary.\n` +
      `Looked in:\n  ${candidates.filter(Boolean).join('\n  ')}`,
  )
}

/**
 * Launch Chrome with WebGPU on the real GPU. Headless Chrome keeps WebGPU
 * behind a flag, so `--enable-unsafe-webgpu` turns it on, and
 * `--enable-gpu` stops headless mode falling back to software. Set
 * HEADFUL=1 to watch a suite run in a visible window.
 *
 * `bare` is the opposite: no GPU and no WebGPU, for checking what a
 * browser without it is shown. `defaultViewport: null` turns off
 * puppeteer's viewport emulation, which a real pixel ratio
 * (`--force-device-scale-factor`) needs: emulation pins the ratio to 1.
 */
export function launch({ args = [], bare = false, defaultViewport } = {}) {
  const gpu = bare ? ['--disable-gpu', '--disable-features=WebGPU'] : ['--enable-unsafe-webgpu', '--enable-gpu']
  return puppeteer.launch({
    executablePath: findChrome(),
    headless: process.env.HEADFUL ? false : 'new',
    args: ['--no-sandbox', ...gpu, ...args],
    ...(defaultViewport !== undefined ? { defaultViewport } : {}),
  })
}

/** Start collecting the page's own errors into `problems`. */
function watch(page, { httpErrors = false } = {}) {
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) problems.push('console: ' + m.text())
  })
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  if (httpErrors) {
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().includes('favicon')) problems.push(`http ${r.status()} ${r.url()}`)
    })
  }
}

// --- the dev server ---------------------------------------------------
/** 5173 is left alone: that's where `npm run dev` runs by hand. */
const AVOID = new Set([5173])

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, 'localhost', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * The app, served. If DEV_URL is set it is used as it is and nothing is
 * started. Otherwise Vite runs in this process on a free port, with the
 * project's own vite.config.ts, and `close` stops it.
 */
export async function startDevServer() {
  if (process.env.DEV_URL) return { url: process.env.DEV_URL, close: async () => {} }
  let port = await freePort()
  while (AVOID.has(port)) port = await freePort()
  const { createServer } = await import('vite')
  const server = await createServer({
    root,
    logLevel: 'warn',
    clearScreen: false,
    server: { port, strictPort: true, host: 'localhost' },
  })
  await server.listen()
  return { url: `http://localhost:${port}/`, close: () => server.close() }
}

/** Run fn(url) with a dev server up, and take it down afterwards however fn ends. */
export async function withDevServer(fn) {
  const { url, close } = await startDevServer()
  try {
    return await fn(url)
  } finally {
    await close()
  }
}

// --- a suite ----------------------------------------------------------
const teardown = []

/**
 * Everything a suite needs before its first goto. `viewport` is optional;
 * `httpErrors` also counts failed requests as problems; `args` are extra
 * Chrome flags (check-engine uses them to take WebGPU away).
 */
export async function open({ viewport, httpErrors = false, args } = {}) {
  const server = await startDevServer()
  teardown.push(server.close)
  const browser = await launch({ args })
  teardown.unshift(() => browser.close())
  const page = await browser.newPage()
  if (viewport) await page.setViewport(viewport)
  watch(page, { httpErrors })
  return { browser, page, url: server.url }
}

/**
 * Report and exit. `ok` folds in anything the suite judged without check();
 * `cleanup` runs after the browser is closed.
 */
export async function finish({ ok = true, cleanup } = {}) {
  console.log(`\nproblems    : ${problems.length ? problems.join('\n              ') : 'none'}`)
  for (const step of teardown) await step().catch(() => {})
  if (cleanup) await cleanup()
  const pass = ok && failures === 0 && problems.length === 0
  console.log(pass ? '\nPASS' : `\nFAIL (${failures} check(s)${problems.length ? `, ${problems.length} problem(s)` : ''})`)
  process.exit(pass ? 0 : 1)
}
