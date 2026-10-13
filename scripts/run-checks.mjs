/**
 * Runs a group of checks one after another and says at the end which failed.
 *
 *   node scripts/run-checks.mjs fast      the headless ones, no browser
 *   node scripts/run-checks.mjs browser   every puppeteer suite
 *   node scripts/run-checks.mjs all       both
 *
 * Every suite runs even after one fails: a red command check says nothing
 * about the theme, and stopping at the first failure hides the rest. The
 * browser suites share one dev server, started here and handed to each
 * through DEV_URL. Each suite still runs in its own process with its own
 * Chrome, so one that leaves the page in a strange state can't fail the
 * next.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDevServer } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Headless: bundled TypeScript through run-ts, plus the theme audit. */
const FAST = [
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
  ['interchange', ['scripts/run-ts.mjs', 'check-interchange']],
  ['theme', ['scripts/check-theme.mjs']],
]

const BROWSER = [...['engine', 'shell', 'files', 'pixels', 'gpu', 'canvas', 'paint', 'tools', 'effects', 'vectors', 'type', 'proof', 'clipboard', 'fills', 'ux', 'guides', 'workflow', 'tiled', 'healing', 'warp', 'filters', 'appearance', 'construct'].map((n) => [n, [`scripts/check-${n}.mjs`]]), ['interchange-browser', ['scripts/check-interchange.mjs']]]

const group = process.argv[2] ?? 'all'
const plan = { fast: FAST, browser: BROWSER, all: [...FAST, ...BROWSER] }[group]
if (!plan) {
  console.error('usage: node scripts/run-checks.mjs fast|browser|all')
  process.exit(2)
}

const run = (args, env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
  })

const results = []
let server = null
const started = Date.now()
try {
  for (const [name, args] of plan) {
    const env = { ...process.env }
    if (BROWSER.some(([n]) => n === name)) {
      server ??= await startDevServer()
      env.DEV_URL = server.url
    }
    console.log(`\n=== check:${name} ${'='.repeat(Math.max(0, 60 - name.length))}`)
    const t = Date.now()
    const code = await run(args, env)
    results.push({ name, code, seconds: (Date.now() - t) / 1000 })
  }
} finally {
  await server?.close()
}

console.log(`\n=== summary (${group}) ${'='.repeat(50)}`)
for (const { name, code, seconds } of results) {
  console.log(`  ${code === 0 ? 'ok  ' : 'FAIL'}  check:${name.padEnd(20)} ${seconds.toFixed(1).padStart(6)} s`)
}
const bad = results.filter((r) => r.code !== 0)
console.log(`\n${bad.length ? `${bad.length} of ${results.length} failed` : `all ${results.length} passed`} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
process.exit(bad.length ? 1 : 0)
