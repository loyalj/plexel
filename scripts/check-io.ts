/**
 * Files: the zip layer under .pxll, the .pxll format itself, and the
 * autosave journal.
 *
 * The zip code is checked against itself (every kind of entry round-trips,
 * Zip64 included), against Node's own zlib (our deflate is real deflate),
 * and against zips Python's zipfile wrote (we read what other tools make).
 * The journal is checked against a store in memory, including the ways a
 * crash or a damaged file can leave it.
 *
 * Run with: npm run check:io
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { DEFAULT_PROFILES, addGroup, createDoc } from '../src/doc/edit'
import { docToJson } from '../src/doc/serialize'
import { memoryStore, readJournalDoc, removeJournalDoc, restoreSession, writeJournalDoc, writeSession } from '../src/io/journal'
import { PXLL_MIME, pxllBlob, readPxll } from '../src/io/pxll'
import { ZipReader, ZipWriter, crc32, memorySink } from '../src/io/zip'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const enc = new TextEncoder()
const dec = new TextDecoder()
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer())
const streamOf = (data: Uint8Array, chunk = 1000) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.length; i += chunk) c.enqueue(data.slice(i, i + chunk))
      c.close()
    },
  })
/** Fills a buffer with a repeatable mix of text-like and noisy bytes. */
const sample = (n: number) => {
  const out = new Uint8Array(n)
  let x = 12345
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = i % 3 ? 97 + ((x >>> 16) % 26) : x >>> 24
  }
  return out
}

// --- CRC ------------------------------------------------------------------------------
console.log('\ncrc-32')
check('CRC-32 of “123456789” is CBF43926', crc32(enc.encode('123456789')) === 0xcbf43926, crc32(enc.encode('123456789')).toString(16))
const whole = sample(5000)
check('a running CRC over pieces equals the CRC of the whole', crc32(whole.subarray(1234), crc32(whole.subarray(0, 1234))) === crc32(whole))

// --- our zips, read back ----------------------------------------------------------------
console.log('\nzip round trips')
async function build(forceZip64: boolean) {
  const m = memorySink()
  const z = new ZipWriter(m.sink, { forceZip64 })
  await z.add('mimetype', enc.encode(PXLL_MIME), { compress: false })
  await z.add('deflated.txt', enc.encode('hello '.repeat(500)))
  await z.add('stored.bin', sample(3000), { compress: false })
  await z.add('empty', new Uint8Array(0))
  await z.add('dossier/ünïcode — ✓.txt', enc.encode('naïve'))
  await z.addStream('streamed.bin', streamOf(sample(100_000)))
  await z.addStream('streamed-stored.bin', streamOf(sample(20_000)), { compress: false })
  await z.finish()
  return m.blob()
}
for (const zip64 of [false, true]) {
  const label = zip64 ? 'with Zip64 everywhere' : 'plain'
  const blob = await build(zip64)
  const r = await ZipReader.open(blob)
  check(`${label}: every entry is listed`, r.entries.size === 7, String(r.entries.size))
  check(`${label}: a deflated entry reads back`, (await r.readText('deflated.txt')) === 'hello '.repeat(500))
  check(`${label}: a stored entry reads back`, (await r.read('stored.bin')).join() === sample(3000).join())
  check(`${label}: an empty entry reads back`, (await r.read('empty')).length === 0)
  check(`${label}: a Unicode name survives`, (await r.readText('dossier/ünïcode — ✓.txt')) === 'naïve')
  check(`${label}: a streamed, deflated entry reads back`, (await r.read('streamed.bin')).join() === sample(100_000).join())
  check(`${label}: a streamed, stored entry reads back`, (await r.read('streamed-stored.bin')).join() === sample(20_000).join())
  const bytes = await bytesOf(blob)
  check(`${label}: the file starts with the mimetype entry`, dec.decode(bytes.subarray(30, 38)) === 'mimetype' && dec.decode(bytes.subarray(38, 38 + PXLL_MIME.length)) === PXLL_MIME)
  const eocdZip64 = (() => {
    for (let i = bytes.length - 22; i >= 0; i--) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 6 && bytes[i + 3] === 6) return true
    return false
  })()
  check(`${label}: ${zip64 ? 'has' : 'has no'} a Zip64 end record`, eocdZip64 === zip64)
}

const m = memorySink()
const z = new ZipWriter(m.sink)
await z.add('a', enc.encode('x'))
let threw = false
try {
  await z.add('a', enc.encode('y'))
} catch {
  threw = true
}
check('the same name twice is refused', threw)

// --- against other implementations --------------------------------------------------------
console.log('\nagainst other implementations')
{
  const m2 = memorySink()
  const zw = new ZipWriter(m2.sink)
  const text = 'deflate me '.repeat(300)
  await zw.add('t.txt', enc.encode(text))
  await zw.finish()
  const bytes = await bytesOf(m2.blob())
  const nameLen = bytes[26] | (bytes[27] << 8)
  const extraLen = bytes[28] | (bytes[29] << 8)
  const comp = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)
  const data = bytes.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + comp)
  check('our deflate is inflated by Node’s zlib', dec.decode(inflateRawSync(data)) === text)
}
// Written by Python's zipfile (see scripts/fixtures/README.md), so these are
// zips our writer had no part in.
const fixture = (name: string) => new Blob([readFileSync(join(process.cwd(), 'scripts', 'fixtures', name))])
{
  const py = await ZipReader.open(fixture('python-plain.zip'))
  check('a zip from Python’s zipfile is read', (await py.readText('notes/hello.txt')) === 'Hello from Python '.repeat(20))
  check('including a name in UTF-8', (await py.readText('ünïcode.txt')) === 'naïve')
  const py64 = await ZipReader.open(fixture('python-zip64.zip'))
  check('and one whose entry has a Zip64 local header', (await py64.readText('big.txt')) === 'zip64 '.repeat(50))
}

// --- damage ----------------------------------------------------------------------------------
console.log('\ndamage')
const good = await bytesOf(await build(false))
const rejects = async (bytes: Uint8Array, entry: string | null, pattern: RegExp) => {
  try {
    const r = await ZipReader.open(new Blob([bytes as BlobPart]))
    if (entry) await r.read(entry)
    return false
  } catch (e) {
    return pattern.test(String(e))
  }
}
check('a file cut short says it is incomplete', await rejects(good.subarray(0, good.length - 40), null, /end is missing|incomplete|damaged/))
check('a file that isn’t a zip says so', await rejects(enc.encode('just some text, not a zip at all'), null, /not a zip/))
{
  const flipped = good.slice()
  // Corrupt a byte inside the stored entry's data: its CRC no longer matches.
  const r = await ZipReader.open(new Blob([good as BlobPart]))
  const e = r.entries.get('stored.bin')!
  flipped[e.offset + 30 + 'stored.bin'.length + 100] ^= 0xff
  check('a damaged entry fails its checksum, by name', await rejects(flipped, 'stored.bin', /stored\.bin.*checksum/))
}

// --- .pxll -------------------------------------------------------------------------------------
console.log('\n.pxll')
let doc = createDoc({ name: 'Flyer', width: 2480, height: 3508, resolution: 300, mode: 'cmyk', depth: 8, profile: DEFAULT_PROFILES.cmyk }, 'root')
doc = addGroup(doc, 'g', 'Headline', 'root', 0)
for (const zip64 of [false, true]) {
  const blob = await pxllBlob(doc, undefined, { forceZip64: zip64 })
  const back = await readPxll(blob)
  check(`a document survives a .pxll round trip${zip64 ? ' with Zip64' : ''}`, back.ok && JSON.stringify(back.doc) === JSON.stringify(doc))
}
const pxBytes = await bytesOf(await pxllBlob(doc))
check('a .pxll is recognisable from its first bytes', dec.decode(pxBytes.subarray(30, 38 + PXLL_MIME.length)) === 'mimetype' + PXLL_MIME)
{
  const other = memorySink()
  const zw = new ZipWriter(other.sink)
  await zw.add('mimetype', enc.encode('application/epub+zip'), { compress: false })
  await zw.finish()
  const r = await readPxll(other.blob())
  check('another kind of zip is refused, saying what it is', !r.ok && /epub/.test(r.error), r.ok ? '' : r.error)
}
{
  const noDoc = memorySink()
  const zw = new ZipWriter(noDoc.sink)
  await zw.add('mimetype', enc.encode(PXLL_MIME), { compress: false })
  await zw.finish()
  const r = await readPxll(noDoc.blob())
  check('a .pxll with no document says so', !r.ok && /document\.json/.test(r.error))
}
{
  const noMime = memorySink()
  const zw = new ZipWriter(noMime.sink)
  await zw.add('document.json', enc.encode(docToJson(doc)))
  await zw.finish()
  const r = await readPxll(noMime.blob())
  check('a .pxll missing its mimetype still opens, with a warning', r.ok && r.warnings.some((w) => /mimetype/.test(w)))
}
{
  const old = memorySink()
  const zw = new ZipWriter(old.sink)
  await zw.add('mimetype', enc.encode('application/x-pixlayer'), { compress: false })
  await zw.add('document.json', enc.encode(docToJson(doc)))
  await zw.finish()
  const r = await readPxll(old.blob())
  check('a .pxll saved before the rename (as Pixlayer’s) still opens', r.ok && r.warnings.length === 0, r.ok ? r.warnings.join('; ') : r.error)
}
check('a damaged .pxll is refused, not thrown', !(await readPxll(new Blob([pxBytes.subarray(0, 50) as BlobPart]))).ok)

// --- the journal -------------------------------------------------------------------------------
console.log('\njournal')
const store = memoryStore()
const other = createDoc({ name: 'Sketch', width: 800, height: 600, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
await writeJournalDoc(store, 'k1', doc)
await writeJournalDoc(store, 'k2', other)
await writeSession(store, {
  active: 'k1',
  docs: [
    { key: 'k2', file: null, clean: false, folded: [] },
    { key: 'k1', file: { name: 'Flyer.pxll', handleKey: 'h-1' }, clean: true, folded: ['g'] },
  ],
})
let restored = await restoreSession(store)
check('the session restores both documents in their order', restored.docs.map((d) => d.key).join() === 'k2,k1')
check('with the one in front still in front', restored.active === 'k1')
check('each document as it was', JSON.stringify(restored.docs[1].doc) === JSON.stringify(doc))
check('with its file, saved state and folded layers', restored.docs[1].file?.handleKey === 'h-1' && restored.docs[1].clean && restored.docs[1].folded.join() === 'g')

await writeJournalDoc(store, 'k3', other)
restored = await restoreSession(store)
check('a document in the journal but not in the session (a crash between writes) is restored too', restored.docs.some((d) => d.key === 'k3' && !d.clean))

store.files.set('docs/k2.json', enc.encode('{"format":1,"app":"plexel","doc":'))
restored = await restoreSession(store)
check('a damaged document is skipped and reported, and the others still restore', !restored.docs.some((d) => d.key === 'k2') && restored.docs.some((d) => d.key === 'k1') && restored.problems.length === 1, restored.problems.join('; '))

store.files.set('session.json', enc.encode('{{{'))
restored = await restoreSession(store)
check('a damaged session still restores the documents it can find', restored.docs.length === 2 && restored.problems.some((p) => /damaged/.test(p)), restored.problems.join('; '))

await writeSession(store, { active: 'gone', docs: [{ key: 'k1', file: null, clean: true, folded: [] }, { key: '../../evil', file: null, clean: true, folded: [] }] })
restored = await restoreSession(store)
check('a key that could be a path is ignored', !restored.docs.some((d) => d.key.includes('/')))
check('an active document that is gone falls back to the last one', restored.active === restored.docs[restored.docs.length - 1].key)

await removeJournalDoc(store, 'k1')
check('a closed document leaves the journal', (await readJournalDoc(store, 'k1')) === null)
check('an empty journal restores nothing, without problems', await (async () => {
  const r = await restoreSession(memoryStore())
  return r.docs.length === 0 && r.problems.length === 0 && r.active === null
})())

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
