/**
 * The GPU against the CPU references, on the real device: every blend mode
 * under every compositing operation, in RGB, Gray and CMYK at 8 and 16
 * bits, in each storage precision the device offers; the four resampling
 * filters, magnified and through a mip; and the display table's sampling
 * against sampleLut.
 *
 * The probes run inside the engine worker (src/checks/probe.ts), render
 * through the real render graph, and send back the worst error and the
 * share of pixels past the tolerance. This suite judges them. It also
 * prints the numbers behind the 16-bit storage decision (PERFORMANCE.md).
 *
 * Run with: npm run check:gpu
 */
import { check, finish, open, waitForEngine } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1000, height: 700 } })
await page.goto(url)
await waitForEngine(page)

const probe = (args) => page.evaluate((a) => globalThis.plexel.engine().call('test.probe', a), args)
const fmt = (x) => (x === 0 ? '0' : x.toExponential(1))

const { features } = await probe({ kind: 'features' })
const f16 = features.includes('shader-f16')
console.log(`\ndevice: ${features.join(', ') || 'no optional features'}`)

// --- compositing -----------------------------------------------------------------
console.log('\ncompositing: every blend mode × over, atop, knockout and pass-through fade')
const precision = {}
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    for (const store of f16 ? ['f32', 'f16'] : ['f32']) {
      const rows = await probe({ kind: 'composite', mode, depth, store })
      const label = `${mode.toUpperCase()} ${depth}-bit in ${store}`
      // Modes with a jump in them (Hard Mix's threshold, Darker Color's
      // choice, a divide near zero) can land on the other side of it when
      // the GPU rounds differently, so they're judged by how many pixels do.
      // Exact ties are the extreme case: random 8-bit pairs sit exactly on
      // Hard Mix's b + s = 1 one time in 256, and any rounding (f16
      // storage, or CMYK's 1 − ink) decides which way such a pixel goes, so
      // up to that share may differ. 16-bit pairs almost never tie.
      const allowed = depth === 8 ? 1 / 256 + 0.003 : 0.003
      const bad = rows.filter((r) => (r.discontinuous ? r.bad > allowed : r.maxErr > r.tol))
      const worst = rows.filter((r) => !r.discontinuous).reduce((a, r) => Math.max(a, r.maxErr), 0)
      precision[`${depth}/${store}`] = Math.max(precision[`${depth}/${store}`] ?? 0, worst)
      if (depth === 16 && store === 'f16') {
        // Not the format 16-bit documents use: measured, for the record.
        console.log(`  ..    ${label}: worst error ${fmt(worst)}, against 16-bit steps of ${fmt(1 / 65535)} (measured, not used)`)
        continue
      }
      check(
        `${label}: all ${rows.length} cases match the reference (worst ${fmt(worst)})`,
        bad.length === 0,
        bad
          .slice(0, 6)
          .map((r) => `${r.blend}/${r.op}: max ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(2)}% over`)
          .join('; '),
      )
    }
  }
}
check('16-bit documents composite in f32, which holds their steps', precision['16/f32'] < 1 / 65535 * 4, fmt(precision['16/f32']))
if (f16) {
  check('f16 couldn’t: its error is many 16-bit steps, which is why 16-bit uses f32', precision['16/f16'] > 1 / 65535 * 4, fmt(precision['16/f16']))
  check('for 8-bit documents f16 is well inside one 8-bit step', precision['8/f16'] < 1 / 255 / 2, fmt(precision['8/f16']))
}

// --- resampling ------------------------------------------------------------------
console.log('\nresampling: a layer through its live transform')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'resample', mode, depth })
    for (const r of rows) {
      // Float32 positions put a few edge pixels on the other side of a
      // nearest-neighbour boundary; everything else must match.
      check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: matches the reference`, r.bad <= 0.002, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% over ${fmt(r.tol)}`)
    }
  }
}

// --- painting ------------------------------------------------------------------------
console.log('\npainting: strokes stamped and baked on the GPU, against the CPU reference')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'paint', mode, depth })
    // Float32 against float64 can round a sample the other way; anything
    // more than a step or two would be a real difference.
    for (const r of rows) {
      // Colour Burn's slope is steep where the dual brush is thin: float32's rounding there grows to a few 16-bit steps.
      const allowed = depth === 8 ? 1 : /Colour Burn/.test(r.name) ? 8 : 3
      check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: every baked sample within ${allowed} of the reference`, r.worst <= allowed && r.differ < 0.02, `worst ${r.worst}, ${(r.differ * 100).toFixed(2)}% differ, ${r.tiles} tiles`)
    }
  }
}

console.log('\nSmudge and the Mixer Brush: picked up, put down and baked on the GPU, against the CPU reference')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'sample', mode, depth })
    for (const r of rows) {
      const allowed = depth === 8 ? 1 : 3
      check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: every baked sample within ${allowed} of the reference`, r.worst <= allowed && r.differ < 0.02, `worst ${r.worst}, ${(r.differ * 100).toFixed(2)}% differ, ${r.tiles} tiles`)
    }
  }
}

// --- masks -----------------------------------------------------------------------------
console.log('\nmasks: sampled, feathered, inverted, thinned and multiplied on the GPU, against the reference')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'mask', mode, depth })
    for (const r of rows) {
      // Bilinear positions in float32 move an edge pixel now and then.
      check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: matches the reference`, r.bad <= 0.002, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% over ${fmt(r.tol)}`)
    }
  }
}

// --- adjustments and live filters ------------------------------------------------------
console.log('\nadjustments: every one as a layer, in a blend mode, clipped and as an effect, against runProgram')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'adjust', mode, depth })
    for (const r of rows) {
      // Threshold and Posterize jump at their steps, so float32 can land on
      // the other side for pixels right on one: in 8 bits, values sit
      // exactly on a step one time in 256.
      const ok = r.discontinuous ? r.bad <= (depth === 8 ? 1 / 256 + 0.002 : 0.002) : r.maxErr <= r.tol
      check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: matches the reference`, ok, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% over ${fmt(r.tol)}`)
    }
  }
}
console.log('\nlive filters: the middle of three by three tiles, gathered and filtered, against the reference on the whole layer')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'filter', mode, depth })
    for (const r of rows) check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: matches the reference`, r.bad <= r.allowed, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% over ${fmt(r.tol)}`)
  }
}

console.log('\nlayer effects: the middle of a layer of shapes over a backdrop, against fx/ref.ts in Photoshop’s order')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'fx', mode, depth })
    for (const r of rows) check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: matches the reference`, r.bad <= 0.001, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% over ${fmt(r.tol)}`)
  }
}

console.log('\nvectors: shapes, text’s glyphs, their fills and strokes, compounds and vector masks over a backdrop, against geom/raster.ts and vector/paint.ts')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'vector', mode, depth })
    for (const r of rows) check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: matches the reference`, r.bad <= 0.001 && r.drawn > 0.05, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% over ${fmt(r.tol)}, ${(r.drawn * 100).toFixed(0)}% of the tile drawn`)
  }
}

console.log('\nsmart objects: a layer placed through one, against the same layer drawn through the same transform')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const rows = await probe({ kind: 'smart', mode, depth })
    for (const r of rows) check(`${mode.toUpperCase()} ${depth}-bit, ${r.name}: the same picture`, r.bad <= 0.0005 && r.drawn > 0.05, `worst ${fmt(r.maxErr)}, ${(r.bad * 100).toFixed(3)}% differ, ${(r.drawn * 100).toFixed(0)}% of the tile drawn`)
  }
}

console.log('\nfilters baked into a layer: against the same filter live, and through a selection')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  for (const depth of [8, 16]) {
    const r = await probe({ kind: 'bake', mode, depth })
    const allowed = depth === 8 ? 1 : 3
    check(`${mode.toUpperCase()} ${depth}-bit: baked samples within ${allowed} of the live render`, r.worst <= allowed, `worst ${r.worst}`)
    check(`${mode.toUpperCase()} ${depth}-bit: through a selection, what's selected is baked and the rest left exactly as it was`, r.leftWorst === 0 && r.rightWorst === 0, `selected ${r.leftWorst}, not ${r.rightWorst}`)
  }
}

// --- the display table ---------------------------------------------------------------
console.log('\nthe display table on the GPU')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  const r = await probe({ kind: 'lut', mode })
  check(`${mode.toUpperCase()} (${r.dims === 4 ? `${r.size}³ × K slices` : r.dims === 1 ? `${r.size} points` : `${r.size}³`}): ${r.samples} colours sampled as sampleLut samples them`, r.maxErr < 2e-5, `worst ${fmt(r.maxErr)}`)
}

console.log('\nproofing on the GPU: a proof table, the gamut marked, inks hidden, coverage over a limit, against displayRef')
for (const mode of ['rgb', 'gray', 'cmyk']) {
  const r = await probe({ kind: 'look', mode })
  check(`${mode.toUpperCase()}: ${r.compared} colours shown as displayRef shows them (${r.marked} out of gamut${mode === 'cmyk' ? `, ${r.inkMarked} over the ink limit` : ''})`, r.maxErr < 2e-5 && (mode === 'gray' || r.marked > 0) && (mode !== 'cmyk' || r.inkMarked > 0), `worst ${fmt(r.maxErr)}`)
}

await finish()
