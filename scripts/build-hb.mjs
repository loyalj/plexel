/**
 * Builds the shaper: native/pxhb/pxhb.c and a pinned HarfBuzz, compiled to
 * WebAssembly with Emscripten, in Docker.
 *
 *   node scripts/build-hb.mjs
 *
 * The output (src/text/wasm/pxhb.mjs and pxhb.wasm) is checked in, so
 * building or running the app never needs Docker or Emscripten. Only a
 * change to pxhb.c, or a new HarfBuzz, means running this again.
 *
 * Both inputs are pinned, as the colour engine's are: the HarfBuzz release
 * tarball by its SHA-256, the Emscripten image by its version. A download
 * that doesn't match the hash is refused rather than built.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HB = 'harfbuzz-14.6.0'
const HB_URL = `https://github.com/harfbuzz/harfbuzz/releases/download/14.6.0/${HB}.tar.xz`
/** Filled in from the first download; any later download must match it. */
const HB_SHA256 = process.env.HB_SHA256 ?? readPin()
const EMSDK_IMAGE = 'emscripten/emsdk:3.1.74'

function readPin() {
  const pin = join(root, 'native/pxhb/harfbuzz.sha256')
  return existsSync(pin) ? readFileSync(pin, 'utf8').trim() : null
}

const cache = join(root, 'node_modules/.cache/pxhb')
mkdirSync(cache, { recursive: true })
const tarball = join(cache, `${HB}.tar.xz`)

if (!existsSync(tarball)) {
  console.log(`downloading ${HB_URL}`)
  const res = await fetch(HB_URL)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
}
const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
if (HB_SHA256 && sha !== HB_SHA256) {
  rmSync(tarball)
  throw new Error(`${HB} tarball has SHA-256 ${sha}, expected ${HB_SHA256}. Refusing to build it.`)
}
if (!HB_SHA256) {
  writeFileSync(join(root, 'native/pxhb/harfbuzz.sha256'), sha + '\n')
  console.log(`pinned ${HB} at ${sha}`)
}

const out = join(root, 'src/text/wasm')
mkdirSync(out, { recursive: true })

const exported = [
  'malloc', 'free', 'px_out', 'px_out_len', 'px_version',
  'px_face_count', 'px_face', 'px_face_destroy', 'px_face_upem', 'px_face_glyphs', 'px_face_name', 'px_face_table',
  'px_face_axes', 'px_face_instances', 'px_face_instance',
  'px_font', 'px_font_destroy', 'px_font_variations', 'px_font_metrics',
  'px_shape', 'px_has_glyph', 'px_glyph_outline',
].map((s) => `_${s}`)

// HarfBuzz without what a browser can't use: threads, files, environment
// variables, exit handlers.
const defines = ['-DHB_NO_MT', '-DHB_NO_OPEN', '-DHB_NO_GETENV', '-DHB_NO_ATEXIT', '-DHB_NO_SETLOCALE', '-DHB_NO_BUFFER_SERIALIZE', '-DHB_NO_BUFFER_MESSAGE']
const toWork = (p) => '/work/' + p.slice(root.length + 1).replaceAll('\\', '/')
const q = (a) => `'${a}'`
const steps = [
  'mkdir -p /tmp/hb',
  `tar -xJf ${q(toWork(tarball))} -C /tmp/hb --strip-components=1`,
  ['em++', '-O3', '-flto', '-std=c++17', '-fno-exceptions', '-fno-rtti', ...defines, '-I', '/tmp/hb/src', '-c', '/tmp/hb/src/harfbuzz.cc', '-o', '/tmp/harfbuzz.o'].map(q).join(' '),
  ['emcc', '-O3', '-flto', ...defines, '-I', '/tmp/hb/src', '-c', 'native/pxhb/pxhb.c', '-o', '/tmp/pxhb.o'].map(q).join(' '),
  [
    'em++', '-O3', '-flto', '/tmp/harfbuzz.o', '/tmp/pxhb.o',
    '-o', `${toWork(out)}/pxhb.mjs`,
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createPxHb',
    '-sENVIRONMENT=web,worker,node', '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=32MB', '-sSTACK_SIZE=1MB',
    `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
    '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPF32,HEAPU8,HEAPU16,HEAPU32',
    '-sINCOMING_MODULE_JS_API=wasmBinary,locateFile,instantiateWasm',
  ].map(q).join(' '),
]
console.log(`building with ${EMSDK_IMAGE}`)
execFileSync('docker', ['run', '--rm', '-v', `${root}:/work`, '-w', '/work', EMSDK_IMAGE, 'sh', '-c', steps.join(' && ')], { stdio: 'inherit' })
console.log(`built ${out}/pxhb.mjs and pxhb.wasm`)
