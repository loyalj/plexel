/**
 * Builds the colour engine: native/pxcms/pxcms.c and a pinned LittleCMS,
 * compiled to WebAssembly with Emscripten, in Docker.
 *
 *   node scripts/build-cms.mjs
 *
 * The output (src/color/wasm/pxcms.mjs and pxcms.wasm) is checked in, so
 * building or running the app never needs Docker or Emscripten. Only a
 * change to pxcms.c, or a new LittleCMS, means running this again.
 *
 * Both inputs are pinned: the LittleCMS release tarball by its SHA-256, and
 * the Emscripten image by its version. A download that doesn't match the
 * hash is refused rather than built.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LCMS = 'lcms2.19.1'
const LCMS_URL = `https://github.com/mm2/Little-CMS/archive/refs/tags/${LCMS}.tar.gz`
/** Filled in from the first download; any later download must match it. */
const LCMS_SHA256 = process.env.LCMS_SHA256 ?? readPin()
const EMSDK_IMAGE = 'emscripten/emsdk:3.1.74'

function readPin() {
  const pin = join(root, 'native/pxcms/lcms.sha256')
  return existsSync(pin) ? readFileSync(pin, 'utf8').trim() : null
}

const cache = join(root, 'node_modules/.cache/pxcms')
mkdirSync(cache, { recursive: true })
const tarball = join(cache, `${LCMS}.tar.gz`)

if (!existsSync(tarball)) {
  console.log(`downloading ${LCMS_URL}`)
  const res = await fetch(LCMS_URL)
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
}
const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
if (LCMS_SHA256 && sha !== LCMS_SHA256) {
  rmSync(tarball)
  throw new Error(`${LCMS} tarball has SHA-256 ${sha}, expected ${LCMS_SHA256}. Refusing to build it.`)
}
if (!LCMS_SHA256) {
  writeFileSync(join(root, 'native/pxcms/lcms.sha256'), sha + '\n')
  console.log(`pinned ${LCMS} at ${sha}`)
}

const out = join(root, 'src/color/wasm')
mkdirSync(out, { recursive: true })

const exported = [
  'malloc', 'free', 'px_init', 'px_last_error', 'px_clear_error',
  'px_open', 'px_close', 'px_srgb', 'px_lab_d50', 'px_xyz', 'px_rgb', 'px_gray', 'px_clut_profile', 'px_save',
  'px_space', 'px_pcs', 'px_class', 'px_channels', 'px_version', 'px_description', 'px_supports_intent',
  'px_transform', 'px_proof', 'px_do', 'px_free_transform', 'px_set_alarm',
].map((s) => `_${s}`)

// Paths as the container sees them: the project is mounted at /work, and
// the source is unpacked inside the container, where tar behaves the same
// on every host.
const toWork = (p) => '/work/' + p.slice(root.length + 1).replaceAll('\\', '/')
const emcc = [
  'emcc', '-O3', '-flto',
  '-I', '/tmp/lcms/include', '-I', '/tmp/lcms/src',
  '/tmp/lcms/src/*.c', 'native/pxcms/pxcms.c',
  '-o', `${toWork(out)}/pxcms.mjs`,
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createPxCms',
  '-sENVIRONMENT=web,worker,node', '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=16MB', '-sSTACK_SIZE=1MB',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPF32,HEAPF64,HEAPU8,HEAPU32',
  '-sINCOMING_MODULE_JS_API=wasmBinary,locateFile,instantiateWasm',
].map((a) => (a.includes('*') ? a : `'${a}'`)).join(' ')
const script = [
  'mkdir -p /tmp/lcms',
  `tar -xzf '${toWork(tarball)}' -C /tmp/lcms --strip-components=1`,
  emcc,
].join(' && ')
console.log(`building with ${EMSDK_IMAGE}`)
execFileSync('docker', ['run', '--rm', '-v', `${root}:/work`, '-w', '/work', EMSDK_IMAGE, 'sh', '-c', script], { stdio: 'inherit' })
console.log(`built ${out}/pxcms.mjs and pxcms.wasm`)
