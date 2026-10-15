/**
 * The static checks, before anything runs: types (tsc), the lint
 * (eslint.config.js), how src/ depends on itself (.dependency-cruiser.cjs:
 * no runtime cycles, the core stays core), and unused files and
 * dependencies (knip.json). Unused exports aren't failed on: knip lists
 * them, and the ones used nowhere are kept for review (ROADMAP.md).
 *
 * Run with: npm run check:static
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const steps = [
  ['types', ['tsc', '--noEmit', '-p', '.']],
  ['lint', ['eslint', 'src']],
  ['dependencies', ['depcruise', 'src', '--config', '.dependency-cruiser.cjs', '--output-type', 'err']],
  ['unused files and packages', ['knip', '--no-progress', '--include', 'files,dependencies,unlisted,binaries']],
]
let failures = 0
for (const [name, args] of steps) {
  const t = Date.now()
  const r = spawnSync('npx', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  const ok = r.status === 0
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}  ${((Date.now() - t) / 1000).toFixed(1)} s`)
  if (!ok) console.log(`${r.stdout}${r.stderr}`.trim().replace(/^/gm, '        '))
}
console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
