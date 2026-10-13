/**
 * Audits every palette in theme.css.
 *
 * A theme is a wall of colour tokens, and the ways it goes wrong are all
 * silent. Leave a token out and that part of the interface keeps the
 * default theme's colour, which nobody notices until a screenshot. Pick a
 * pair that doesn't contrast and the label is still there, the right size,
 * and unreadable. Tint the pasteboard and every colour judgement made
 * against it is off, with nothing on screen to say so.
 *
 * So: every palette declares exactly the reference's tokens, every
 * registered theme has both modes, every token is read by something, the
 * pairs that end up on top of each other clear a ratio, and the pasteboard
 * is a neutral grey everywhere.
 *
 * Run with: npm run check:theme
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/theme.css'), 'utf8')
const themeTs = readFileSync(join(root, 'src/ui/theme.ts'), 'utf8')

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// --- parse ------------------------------------------------------------
/** Every `selector { ... }` block, with its custom properties. */
const blocks = []
for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const selector = m[1].trim().replace(/\s+/g, ' ')
  const tokens = new Map()
  for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(d[1], d[2].trim())
  const at = /\[data-theme="([^"]+)"\]\[data-mode="([^"]+)"\]/.exec(selector)
  const scheme = /color-scheme:\s*(dark|light)/.exec(m[2])?.[1]
  blocks.push({ selector, tokens, scheme, theme: at?.[1], mode: at?.[2] })
}

const palettes = blocks.filter((b) => b.theme)
console.log(`\n${palettes.length} palettes in theme.css`)

// --- every palette declares the same tokens ---------------------------
console.log('\ntoken coverage')
const reference = palettes.find((p) => p.theme === 'graphite' && p.mode === 'dark')
if (!reference) {
  check('the reference palette (graphite/dark) exists', false)
  process.exit(1)
}
check(
  'the reference palette is also the bare :root, so a missing attribute still paints',
  reference.selector.split(',').map((s) => s.trim()).includes(':root'),
)
const expected = [...reference.tokens.keys()].sort()
check('the reference declares a full set', expected.length >= 25, `${expected.length} tokens`)

for (const p of palettes) {
  const got = new Set(p.tokens.keys())
  const missing = expected.filter((t) => !got.has(t))
  const extra = [...got].filter((t) => !expected.includes(t))
  check(
    `${p.theme}/${p.mode} declares every token`,
    missing.length === 0 && extra.length === 0,
    [missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : '']
      .filter(Boolean)
      .join('; '),
  )
  check(`${p.theme}/${p.mode} sets color-scheme to match`, p.scheme === p.mode, p.scheme ? `found ${p.scheme}` : 'none found')
}

// --- every token is read by something ---------------------------------
/* A token nothing reads is one more value every new theme has to invent,
   for no effect. */
console.log('\ntokens in use')
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const path = join(dir, f)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
const readers = walk(join(root, 'src'))
  .filter((path) => /\.(css|tsx?)$/.test(path) && !path.endsWith('theme.css'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
const unread = expected.filter((t) => !new RegExp(`${t}(?![a-z0-9-])`).test(readers))
check('every palette token is read outside theme.css', unread.length === 0, unread.length ? `unread ${unread.join(', ')}` : '')

// --- every registered theme is painted, and vice versa ----------------
console.log('\nregistered themes')
const registered = [...themeTs.matchAll(/\{ id: '([^']+)', name: '([^']+)' \}/g)].map((m) => m[1])
check('theme.ts lists some themes', registered.length > 0, registered.join(', '))
for (const id of registered) {
  for (const mode of ['dark', 'light']) {
    check(`${id} has a ${mode} palette`, palettes.some((p) => p.theme === id && p.mode === mode))
  }
}
for (const p of palettes) check(`${p.theme}/${p.mode} is registered in theme.ts`, registered.includes(p.theme))

// --- colour maths -----------------------------------------------------
const hex = (v) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((v ?? '').trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05]
  return x > y ? x / y : y / x
}

// --- the pasteboard is neutral ----------------------------------------
console.log('\npasteboard')
for (const p of palettes) {
  const c = hex(p.tokens.get('--pasteboard'))
  check(`${p.theme}/${p.mode} has a neutral grey pasteboard`, !!c && c[0] === c[1] && c[1] === c[2], p.tokens.get('--pasteboard'))
}

// --- contrast ---------------------------------------------------------
/**
 * What sits on what. Interface text in an editor is small (11 to 13 px), so
 * even the faintest label holds to WCAG AA's 4.5, and body text to 7. The
 * focus ring is a stroke, not text, and needs 3.
 */
const PAIRS = [
  ['--ink', '--panel', 7, 'body text on a panel'],
  ['--ink-dim', '--panel', 5, 'secondary text on a panel'],
  ['--ink-faint', '--panel', 4.5, 'the faintest labels on a panel'],
  ['--ink', '--panel-head', 7, 'a panel title'],
  ['--accent-line', '--panel', 4.5, 'accent text on a panel'],
  ['--ink', '--chrome', 7, 'menu titles on the menu bar'],
  ['--ink-dim', '--chrome', 4.5, 'the status bar'],
  ['--ink-faint', '--chrome', 4.5, 'faint status bar labels'],
  ['--ink', '--menu', 7, 'menu items'],
  ['--ink-faint', '--menu', 4.5, 'shortcuts in a menu'],
  ['--ink', '--hover', 7, 'a hovered menu item'],
  ['--ink', '--selected', 7, 'a selected row'],
  ['--ink', '--field', 7, 'text in a field'],
  ['--ink-dim', '--pasteboard', 4.5, 'the empty canvas message'],
  ['--on-accent', '--accent', 4.5, 'a label on a filled accent button'],
  ['--on-danger', '--danger', 4.5, 'a label on a danger button'],
  ['--focus', '--panel', 3, 'the focus ring on a panel'],
  ['--focus', '--chrome', 3, 'the focus ring on the menu bar'],
]

console.log('\ncontrast')
for (const p of palettes) {
  const worst = []
  for (const [fg, bg, min, what] of PAIRS) {
    const a = hex(p.tokens.get(fg))
    const b = hex(p.tokens.get(bg))
    if (!a || !b) {
      check(`${p.theme}/${p.mode}: ${fg} on ${bg} is a plain colour`, false, 'not a hex value')
      continue
    }
    const ratio = contrast(a, b)
    if (ratio < min) worst.push(`${what} ${ratio.toFixed(2)}:1 < ${min}`)
  }
  check(`${p.theme}/${p.mode} is readable`, worst.length === 0, worst.join('; '))
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
