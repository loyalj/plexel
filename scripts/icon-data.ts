/**
 * The icon data file, as build:icons writes it and check:commands
 * compares it: each Phosphor outline the registry names, from
 * `@iconify-json/ph`.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { phosphorNames } from '../src/ui/icons'

// Run from the repository's root, as npm runs scripts (run-ts bundles this elsewhere first).
const root = resolve('.')
export const ICON_DATA_FILE = join(root, 'src/ui/icons.data.ts')

/** Each icon's SVG body (inside a 256-unit viewBox), by Phosphor name. Throws on a name the set doesn't have. */
export function iconBodies(): Record<string, string> {
  const require = createRequire(join(root, 'package.json'))
  const set = JSON.parse(readFileSync(require.resolve('@iconify-json/ph/icons.json'), 'utf8')) as {
    icons: Record<string, { body: string }>
    aliases?: Record<string, { parent: string }>
  }
  const out: Record<string, string> = {}
  for (const name of phosphorNames()) {
    const icon = set.icons[name] ?? (set.aliases?.[name] ? set.icons[set.aliases[name].parent] : undefined)
    if (!icon) throw new Error(`Phosphor has no icon called “${name}”`)
    out[name] = icon.body
  }
  return out
}

/** The data file's text. */
export function iconDataSource(bodies: Record<string, string>): string {
  const lines = Object.entries(bodies).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  return `/**
 * Written by \`npm run build:icons\` (scripts/build-icons.ts) from
 * @iconify-json/ph: the outlines of the icons src/ui/icons.ts names, on
 * Phosphor's 256-unit grid. Phosphor Icons, MIT licence. Don't edit by hand.
 */
export const ICON_DATA: Record<string, string> = {
${lines.join('\n')}
}
`
}
