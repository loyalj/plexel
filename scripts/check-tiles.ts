/**
 * The tile store: formats, uniform and data tiles, copy-on-write sets,
 * reference counting and collection, the memory budget and spilling,
 * content hashes, packs (the .pxll form) and the journal's tiles.
 *
 * Every format is swept: RGB, Gray and CMYK, at 8 and 16 bits. The budget
 * is set tiny, so spilling and reading back happen within a few tiles
 * rather than a few gigabytes.
 *
 * Run with: npm run check:tiles
 */
import { TILE, TILE_PIXELS, newSamples, planesOf, quantise, tileBytes, type Samples, type TileFormat } from '../src/tiles/format'
import { TileJournal } from '../src/tiles/journal'
import { PackError, decodeSet, encodeSet } from '../src/tiles/pack'
import { memorySpill } from '../src/tiles/spill'
import { TileStore } from '../src/tiles/store'
import { memoryStore } from '../src/io/journal'
import { deflateRaw } from '../src/io/zip'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
let seed = 11
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

const FORMATS: TileFormat[] = (['rgb', 'gray', 'cmyk'] as const).flatMap((mode) => ([8, 16] as const).map((depth) => ({ mode, depth })))
const label = (f: TileFormat) => `${f.mode.toUpperCase()} ${f.depth}-bit`
const store = (budget = 1e9) => {
  const spill = memorySpill()
  return { s: new TileStore({ budget, spill, shared: false }), spill }
}

/** A tile that's smooth, like a photo: a gradient per plane plus a little noise. */
function photo(f: TileFormat, salt = 0): Samples {
  const s = newSamples(f)
  const max = f.depth === 16 ? 65535 : 255
  for (let p = 0; p < planesOf(f); p++)
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) s[p * TILE_PIXELS + y * TILE + x] = Math.min(max, Math.round(((x + y * 0.5 + p * 40 + salt) / 400) * max + rand() * max * 0.01))
  return s
}
function noise(f: TileFormat): Samples {
  const s = newSamples(f)
  const max = f.depth === 16 ? 65535 : 255
  for (let i = 0; i < s.length; i++) s[i] = Math.floor(rand() * (max + 1))
  return s
}
const same = (a: Samples, b: Samples) => a.length === b.length && a.every((v, i) => v === b[i])

// --- formats ----------------------------------------------------------------
console.log('\nformats')
check('an 8-bit RGB tile is 256 KB: four planes of 256 × 256', tileBytes({ mode: 'rgb', depth: 8 }) === 256 * 1024)
check('a 16-bit CMYK tile is 640 KB: five planes of two bytes', tileBytes({ mode: 'cmyk', depth: 16 }) === 640 * 1024)
check('Gray has two planes, colour and alpha', planesOf({ mode: 'gray', depth: 8 }) === 2)
check('quantising clamps and rounds to the depth', quantise({ mode: 'rgb', depth: 8 }, [1.2, 0.5, -1], 1).join() === '255,128,0,255')

// --- tiles ------------------------------------------------------------------
console.log('\ntiles')
for (const f of FORMATS) {
  const { s } = store()
  const a = photo(f)
  const id = s.data(f, a)
  const back = await s.samples(id)
  check(`${label(f)}: a data tile reads back exactly`, same(a, back))
  back[0] ^= 1
  check(`${label(f)}: what comes back is a copy, so changing it changes nothing stored`, same(a, await s.samples(id)))
}
{
  const f: TileFormat = { mode: 'cmyk', depth: 16 }
  const { s } = store()
  const v = [100, 200, 300, 400, 65535]
  const u = s.uniform(f, v)
  check('equal uniform values share one tile', s.uniform(f, v) === u)
  const filled = newSamples(f)
  for (let p = 0; p < 5; p++) filled.fill(v[p], p * TILE_PIXELS, (p + 1) * TILE_PIXELS)
  check('a data tile with one value per plane becomes that uniform tile, using no memory', s.data(f, filled) === u && s.stats().residentBytes === 0)
  check('a uniform tile reads back as full samples', same(await s.samples(u), filled))
  let threw = false
  try {
    s.uniform(f, [1, 2, 3])
  } catch {
    threw = true
  }
  check('a uniform value with the wrong number of planes is refused', threw)
}

// --- sets -------------------------------------------------------------------
console.log('\nsets')
{
  const f: TileFormat = { mode: 'rgb', depth: 8 }
  const { s } = store()
  const t1 = s.data(f, photo(f, 1))
  const t2 = s.data(f, photo(f, 2))
  const t3 = s.data(f, photo(f, 3))
  const a = s.createSet(f, [[0, 0, t1], [1, 0, t2]])
  const b = s.derive(a, [[1, 0, t3], [0, 1, t1]])
  const c = s.derive(b, [[0, 0, null]])
  const ta = s.getSet(a).tiles
  const tb = s.getSet(b).tiles
  check('a derived set shares the tiles it didn’t change', tb.get('0,0') === t1 && tb.get('1,0') === t3 && tb.get('0,1') === t1)
  check('the set it came from is unchanged', ta.size === 2 && ta.get('1,0') === t2)
  check('null removes a tile', !s.getSet(c).tiles.has('0,0') && s.getSet(c).tiles.size === 2)
  check('sets get fresh ids', new Set([a, b, c]).size === 3)
  check('an empty set describes as empty', s.describe(s.createSet(f, [])).kind === 'empty')
  const u = s.uniform(f, [255, 255, 255, 255])
  const white = s.createSet(f, [[0, 0, u], [1, 0, u]])
  const d = s.describe(white)
  check('a set of one uniform tile describes as that value', d.kind === 'uniform' && d.value.join() === '255,255,255,255')
  check('a set of photos describes as mixed', s.describe(a).kind === 'mixed')
  let threw = false
  try {
    s.createSet({ mode: 'cmyk', depth: 8 }, [[0, 0, t1]])
  } catch {
    threw = true
  }
  check('a set can’t hold tiles of another format', threw)

  // Collection: keep b alive; a and c go. t2 was only in a.
  const freed = s.gc([b, white])
  check('collecting frees the sets not in use', !s.hasSet(a) && !s.hasSet(c) && s.hasSet(b), JSON.stringify(freed))
  check('and the tiles only they held, but not tiles still in use', freed.tiles === 1 && s.stats().tiles === 3, JSON.stringify(s.stats()))
  s.gc([])
  check('collecting with nothing in use frees everything', s.stats().sets === 0 && s.stats().tiles === 0 && s.stats().residentBytes === 0)
}

// --- the memory budget -----------------------------------------------------
console.log('\nmemory budget')
{
  const f: TileFormat = { mode: 'rgb', depth: 16 }
  const { s, spill } = store(tileBytes(f) * 3)
  const originals: Samples[] = []
  const ids: number[] = []
  for (let i = 0; i < 10; i++) {
    originals.push(photo(f, i * 7))
    ids.push(s.data(f, originals[i]))
  }
  const set = s.createSet(f, ids.map((t, i) => [i, 0, t]))
  check('past the budget, memory stays within it', s.stats().residentBytes <= tileBytes(f) * 3, JSON.stringify(s.stats()))
  check('and the oldest tiles are spilled', s.stats().spilledTiles === 7, String(s.stats().spilledTiles))
  let all = true
  for (let i = 0; i < 10; i++) all &&= same(await s.samples(ids[i]), originals[i])
  check('every tile reads back exactly, spilled or not', all)
  check('reading them back keeps memory within the budget', s.stats().residentBytes <= tileBytes(f) * 3)
  await s.settle()
  check('spilled tiles are written out', spill.files.size >= 7, String(spill.files.size))
  s.gc([])
  await s.settle()
  await new Promise((r) => setTimeout(r, 10))
  check('collecting a set removes its spilled tiles too', spill.files.size === 0 && !s.hasSet(set), String(spill.files.size))
}

// --- hashes ---------------------------------------------------------------------
console.log('\nhashes')
{
  const f: TileFormat = { mode: 'gray', depth: 8 }
  const { s } = store()
  const p = photo(f, 5)
  const a = s.data(f, p)
  const b = s.data(f, p.slice())
  const q = p.slice()
  q[1000] ^= 1
  const c = s.data(f, q)
  check('tiles with equal pixels hash equal', (await s.hashOf(a)) === (await s.hashOf(b)))
  check('one sample different, a different hash', (await s.hashOf(a)) !== (await s.hashOf(c)))
  check('uniform tiles of different formats hash differently', (await s.hashOf(s.uniform(f, [0, 255]))) !== (await s.hashOf(s.uniform({ mode: 'gray', depth: 16 }, [0, 255]))))
}

// --- packs ------------------------------------------------------------------------
console.log('\npacks')
for (const f of FORMATS) {
  const { s } = store()
  const tiles: Samples[] = [photo(f, 1), noise(f)]
  const set = s.createSet(f, [
    [0, 0, s.data(f, tiles[0])],
    [3, -2, s.data(f, tiles[1])],
    [1, 1, s.uniform(f, quantise(f, new Array(planesOf(f) - 1).fill(0.25)))],
  ])
  const bytes = await encodeSet(s, set)
  const { s: s2 } = store()
  await decodeSet(s2, bytes, set)
  const back = s2.getSet(set)
  check(`${label(f)}: a set survives a pack round trip, coordinates and all`, same(await s2.samples(back.tiles.get('0,0')!), tiles[0]) && same(await s2.samples(back.tiles.get('3,-2')!), tiles[1]))
  check(`${label(f)}: a uniform tile stays uniform`, !!s2.isUniform(back.tiles.get('1,1')!))
}
{
  const f: TileFormat = { mode: 'rgb', depth: 8 }
  const { s } = store()
  const smooth = s.createSet(f, [[0, 0, s.data(f, photo(f))]])
  const size = (await encodeSet(s, smooth)).length
  const raw = await s.samples(s.getSet(smooth).tiles.get('0,0')!)
  const plain = (await deflateRaw(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))).length
  check('the Sub filter packs a photo-like tile smaller than deflate alone', size < plain * 0.8, `${(size / 1024).toFixed(0)} KB filtered, ${(plain / 1024).toFixed(0)} KB plain, of ${tileBytes(f) / 1024} KB`)
  check('and to under a third of its size', size < tileBytes(f) / 3)
  const good = await encodeSet(s, smooth)
  const refuse = async (bytes: Uint8Array, pattern: RegExp) => {
    try {
      await decodeSet(store().s, bytes, 'x1')
      return false
    } catch (e) {
      return e instanceof PackError && pattern.test(e.message)
    }
  }
  check('bytes that aren’t tile data are refused', await refuse(new TextEncoder().encode('hello there, not tiles at all'), /isn’t Plexel tile data/))
  const newer = good.slice()
  newer[4] = 9
  check('a newer pack format is refused, saying so', await refuse(newer, /newer format/))
  check('a pack cut short is refused', await refuse(good.subarray(0, good.length - 100), /past the end/))
  const kind = good.slice()
  kind[16 + 8] = 7
  check('a tile stored an unknown way is refused', await refuse(kind, /doesn’t know/))
}

// --- the journal ----------------------------------------------------------------------
console.log('\njournal')
{
  const f: TileFormat = { mode: 'cmyk', depth: 8 }
  const { s } = store()
  const journal = memoryStore()
  const tj = new TileJournal(s, journal)
  const t = [photo(f, 1), photo(f, 2), photo(f, 3)].map((p) => s.data(f, p))
  const white = s.uniform(f, [0, 0, 0, 0, 255])
  const a = s.createSet(f, [[0, 0, t[0]], [1, 0, t[1]], [2, 0, white]])
  check('journalling a set writes each of its data tiles once', (await tj.write([a])) === 2)
  const b = s.derive(a, [[1, 0, t[2]]])
  check('journalling a set derived from it writes only the new tile', (await tj.write([b])) === 1)
  check('journalling a set already written writes nothing', (await tj.write([a, b])) === 0)
  const { s: fresh } = store()
  const tj2 = new TileJournal(fresh, journal)
  const r = await tj2.restore([a, b, 'tmissing'])
  check('sets are restored from the journal', r.restored.join() === `${a},${b}` && r.missing.join() === 'tmissing')
  check('with every tile as it was', same(await fresh.samples(fresh.getSet(b).tiles.get('1,0')!), await s.samples(t[2])))
  check('and uniform tiles still uniform', !!fresh.isUniform(fresh.getSet(a).tiles.get('2,0')!))
  const before = journal.files.size
  const removed = await tj.collect([b])
  check('collecting removes the sets no document holds and the tiles only they used', removed.sets === 1 && removed.tiles === 1 && journal.files.size === before - 2, JSON.stringify(removed))
  journal.files.delete([...journal.files.keys()].find((k) => k.startsWith('tiles/'))!)
  const { s: third } = store()
  const r3 = await new TileJournal(third, journal).restore([b])
  check('a set with a missing tile is reported missing, not thrown', r3.missing.join() === b)
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
