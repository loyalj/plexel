/**
 * Runs a group of checks, several at once, and says at the end which failed.
 *
 *   node scripts/run-checks.mjs fast      the headless ones, no browser
 *   node scripts/run-checks.mjs browser   every puppeteer suite
 *   node scripts/run-checks.mjs all       both
 *
 * Options:
 *   --only a,b       just these suites (by name, as in check:<name>)
 *   --jobs N         suites at once: headless ones default to one a core,
 *                    browser ones to four (they share the GPU)
 *   --retry-failed   a suite that fails is run once more, alone; one that
 *                    passes then is reported as flaky, not failed
 *   --dev            browser suites against the dev server, not a build
 *
 * Every suite runs even after one fails: a red command check says nothing
 * about the theme, and stopping at the first failure hides the rest. Each
 * runs in its own process (the browser ones with their own Chrome), so one
 * that leaves things in a strange state can't fail another; what it prints
 * is kept and shown whole when it ends, so suites running together don't
 * interleave. The browser suites share one server, handed to each through
 * DEV_URL: by default a production build under Vite's preview server, which
 * is what ships, and which nothing edited under src/ can reload mid-run.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDevServer, startPreviewServer } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Headless: bundled TypeScript through run-ts, plus the theme audit. */
const FAST = [
  ['static', ['scripts/check-static.mjs']],
  ['doc', ['scripts/run-ts.mjs', 'check-doc']],
  ['io', ['scripts/run-ts.mjs', 'check-io']],
  ['color', ['scripts/run-ts.mjs', 'check-color']],
  ['print', ['scripts/run-ts.mjs', 'check-print']],
  ['tiles', ['scripts/run-ts.mjs', 'check-tiles']],
  ['render-ref', ['scripts/run-ts.mjs', 'check-render-ref']],
  ['images', ['scripts/run-ts.mjs', 'check-images']],
  ['brush', ['scripts/run-ts.mjs', 'check-brush']],
  ['select', ['scripts/run-ts.mjs', 'check-select']],
  ['segment', ['scripts/run-ts.mjs', 'check-segment']],
  ['matte', ['scripts/run-ts.mjs', 'check-matte']],
  ['retouch', ['scripts/run-ts.mjs', 'check-retouch']],
  ['adjust', ['scripts/run-ts.mjs', 'check-adjust']],
  ['geom', ['scripts/run-ts.mjs', 'check-geom']],
  ['snap', ['scripts/run-ts.mjs', 'check-snap']],
  ['text', ['scripts/run-ts.mjs', 'check-text']],
  ['commands', ['scripts/run-ts.mjs', 'check-commands']],
  ['artboards', ['scripts/run-ts.mjs', 'check-artboards']],
  ['interchange', ['scripts/run-ts.mjs', 'check-interchange']],
  ['theme', ['scripts/check-theme.mjs']],
]

const BROWSER = [...['engine', 'shell', 'files', 'pixels', 'gpu', 'canvas', 'paint', 'tools', 'effects', 'vectors', 'type', 'proof', 'clipboard', 'fills', 'ux', 'guides', 'workflow', 'tiled', 'healing', 'warp', 'filters', 'appearance', 'construct', 'channels', 'panels', 'flow', 'boards'].map((n) => [n, [`scripts/check-${n}.mjs`]]), ['interchange-browser', ['scripts/check-interchange.mjs']]]

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const group = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--only' && argv[argv.indexOf(a) - 1] !== '--jobs') ?? 'all'
const groups = { fast: FAST, browser: BROWSER, all: [...FAST, ...BROWSER] }
let plan = groups[group]
if (!plan) {
  console.error('usage: node scripts/run-checks.mjs fast|browser|all [--only a,b] [--jobs N] [--retry-failed] [--dev]')
  process.exit(2)
}
const only = option('--only')?.split(',').map((s) => s.trim().replace(/^check:/, ''))
if (only) {
  const unknown = only.filter((n) => !plan.some(([p]) => p === n))
  if (unknown.length) {
    console.error(`no such suite in "${group}": ${unknown.join(', ')}`)
    process.exit(2)
  }
  plan = plan.filter(([n]) => only.includes(n))
}
const isBrowser = (name) => BROWSER.some(([n]) => n === name)
const jobs = Number(option('--jobs')) || 0
const FAST_JOBS = jobs || Math.max(1, cpus().length - 1)
const BROWSER_JOBS = jobs || 4

/** Runs one suite, its output kept rather than printed as it comes. */
const run = (name, args, env) =>
  new Promise((resolve) => {
    const t = Date.now()
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => out.push(d))
    child.on('exit', (code, signal) => resolve({ name, code: code ?? (signal ? 1 : 0), seconds: (Date.now() - t) / 1000, output: Buffer.concat(out).toString() }))
  })

/**
 * How long each suite took last time (node_modules/.cache): the longest are
 * started first, so the run doesn't end waiting on one long suite started
 * late.
 */
const timesFile = join(root, 'node_modules/.cache/check-times.json')
const times = (() => {
  try {
    return JSON.parse(readFileSync(timesFile, 'utf8'))
  } catch {
    return {}
  }
})()
const longestFirst = (items) => [...items].sort((a, b) => (times[b[0]] ?? 0) - (times[a[0]] ?? 0))

/** Runs `items` with at most `n` at once, longest first, printing each as it ends. */
async function pool(items, n, start) {
  items = longestFirst(items)
  const results = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      const r = await start(item)
      console.log(`\n=== check:${r.name} ${'='.repeat(Math.max(0, 60 - r.name.length))}\n${r.output.trimEnd()}`)
      console.log(`--- check:${r.name}: ${r.code === 0 ? 'ok' : 'FAIL'} in ${r.seconds.toFixed(1)} s`)
      results.push(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return results
}

const started = Date.now()
let server = null
const results = []
try {
  const fast = plan.filter(([n]) => !isBrowser(n))
  const browser = plan.filter(([n]) => isBrowser(n))
  // The server is made while the headless suites run, so its build costs nothing extra.
  const serving = browser.length ? (flag('--dev') ? startDevServer() : startPreviewServer()) : null
  // Suites with timings in them allow for others running beside them (check-segment).
  const fastEnv = FAST_JOBS > 1 ? { ...process.env, PLEXEL_CHECKS_PARALLEL: '1' } : process.env
  results.push(...(await pool(fast, FAST_JOBS, ([name, args]) => run(name, args, fastEnv))))
  if (serving) {
    server = await serving
    console.log(`\n(browser suites against ${flag('--dev') ? 'the dev server' : 'a production build'} at ${server.url})`)
    results.push(...(await pool(browser, BROWSER_JOBS, ([name, args]) => run(name, args, { ...process.env, DEV_URL: server.url }))))
  }
  // Failures run again, one at a time, when asked: what passes then was flaky.
  if (flag('--retry-failed')) {
    for (const r of results.filter((x) => x.code !== 0)) {
      const [, args] = plan.find(([n]) => n === r.name)
      console.log(`\n(retrying check:${r.name} alone)`)
      const again = await run(r.name, args, isBrowser(r.name) ? { ...process.env, DEV_URL: server.url } : process.env)
      console.log(again.output.trimEnd())
      if (again.code === 0) r.flaky = true
    }
  }
} finally {
  await server?.close()
}

for (const r of results) times[r.name] = Math.round(r.seconds * 10) / 10
try {
  mkdirSync(dirname(timesFile), { recursive: true })
  writeFileSync(timesFile, JSON.stringify(times, null, 2))
} catch {
  // Only an ordering hint.
}

const order = new Map(plan.map(([n], i) => [n, i]))
results.sort((a, b) => order.get(a.name) - order.get(b.name))
console.log(`\n=== summary (${group}${only ? `: ${only.join(', ')}` : ''}) ${'='.repeat(40)}`)
for (const { name, code, seconds, flaky } of results) {
  console.log(`  ${code === 0 ? 'ok   ' : flaky ? 'FLAKY' : 'FAIL '}  check:${name.padEnd(20)} ${seconds.toFixed(1).padStart(6)} s`)
}
const bad = results.filter((r) => r.code !== 0 && !r.flaky)
const flaky = results.filter((r) => r.flaky)
console.log(`\n${bad.length ? `${bad.length} of ${results.length} failed` : `all ${results.length} passed`}${flaky.length ? ` (${flaky.length} flaky: failed, then passed alone)` : ''} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
process.exit(bad.length ? 1 : 0)
