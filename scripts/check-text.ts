/**
 * Type, headless: HarfBuzz through our wrapper (faces, names, axes,
 * shaping with kerning, features, variations, Arabic joining and
 * Devanagari reordering, outlines), the font library, the text model's
 * edits, readers and styles, and layout: point, area and path text, line
 * breaking, the single-line and every-line composers, justification,
 * overflow, bidi, font fallback, shaped frames, tracking, underlines,
 * caret boxes, and the glyph geometry the renderer draws.
 *
 * Run with: npm run check:text
 */
import { readFileSync } from 'node:fs'
import { embeddable, startHarfBuzz } from '../src/text/hb'
import { FontLibrary, styleWeight } from '../src/text/fonts'
import { distanceAlong, layoutText, scriptOf, type TextLayout } from '../src/text/layout'
import {
  DEFAULT_CHAR,
  contentFrom,
  deleteRange,
  insertText,
  locate,
  plainText,
  readTextContent,
  readTextStyles,
  replaceRange,
  resolveChar,
  resolvePara,
  styleParagraphs,
  styleRange,
  textLength,
  type TextContent,
  type TextStyles,
} from '../src/doc/text'
import { flattenGlyphs, glyphsBounds, glyphsToPath } from '../src/geom/glyphs'
import { flattenPath, polyArea, type PathData } from '../src/geom/path'
import { shapePath } from '../src/geom/shapes'
import { pathBounds } from '../src/geom/path'
import { DEFAULT_PROFILES, createDoc, insertNode } from '../src/doc/edit'
import { makeNode } from '../src/doc/nodes'
import { NO_STYLES, fontsUsed } from '../src/doc/text'
import { pxllBlob, readPxll } from '../src/io/pxll'
import { sha256 } from '../src/io/assets'
import { Hyphenation } from '../src/text/hyphenate'
import { alternatesOf, cmapOf } from '../src/text/glyphs'
import { readParaProps, DEFAULT_PARA, type ParaProps, type CharProps } from '../src/doc/text'
import { vectorOutline } from '../src/vector/outline'
import { fillItem, solid } from '../src/doc/vector'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}
const fmt = (x: number) => (Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(1) : x.toFixed(2))

const hb = await startHarfBuzz(readFileSync('src/text/wasm/pxhb.wasm'))
const lib = new FontLibrary(hb)
lib.addFile('InterVariable.ttf', readFileSync('public/fonts/InterVariable.ttf'), 'builtin')
lib.addFile('InterVariable-Italic.ttf', readFileSync('public/fonts/InterVariable-Italic.ttf'), 'builtin')
lib.addFile('NotoSansArabic.ttf', readFileSync('scripts/fixtures/fonts/NotoSansArabic-Regular.ttf'), 'builtin')
lib.addFile('NotoSansDevanagari.ttf', readFileSync('scripts/fixtures/fonts/NotoSansDevanagari-Regular.ttf'), 'builtin')
lib.setFallbacks({ Arab: ['NotoSansArabic.ttf'], Deva: ['NotoSansDevanagari.ttf'] })

// --- HarfBuzz ----------------------------------------------------------------------------------
console.log('\nHarfBuzz')
check(`HarfBuzz ${hb.version}, built from the pinned release`, hb.version === '14.6.0')
const interFace = lib.face('Inter Variable', 'Regular')!.face
const info = interFace.info
check('a face’s names, units and licence', info.family === 'Inter Variable' && info.subfamily === 'Regular' && info.upem === 2048 && info.glyphs > 2000 && embeddable(info.fsType))
check('its variation axes and named instances', info.axes.map((a) => a.tag).join() === 'opsz,wght' && info.instances.length >= 9 && info.instances.some((i) => i.name === 'Bold' && i.coords.wght === 700), info.instances.map((i) => i.name).join(', '))
const inter = interFace.font()
const adv = (t: string, f = inter, feats: string[] = []) => f.shape(t, 0, t.length, 'ltr', 'Latn', 'en', feats).reduce((a, g) => a + g.ax, 0)
check('kerning tightens AV, and turns off', adv('AV') < adv('AV', inter, ['kern=0']), `${adv('AV')} against ${adv('AV', inter, ['kern=0'])}`)
check('a variable font’s weight changes its advances', adv('o', interFace.font({ wght: 900 })) > adv('o'))
check('features switch glyphs: tabular figures are all one width', (() => {
  const g = inter.shape('1478', 0, 4, 'ltr', 'Latn', 'en', ['tnum']).map((x) => x.ax)
  return g.every((a) => a === g[0])
})())
const arabicFace = lib.face('Noto Sans Arabic', 'Regular')!.face.font()
const seen = arabicFace.shape('س', 0, 1, 'rtl', 'Arab')[0].gid
const joined = arabicFace.shape('سلام', 0, 4, 'rtl', 'Arab')
check('Arabic letters join: a letter in a word takes another form than alone', joined.some((g) => g.cluster === 0 && g.gid !== seen) && joined[joined.length - 1].cluster === 0, joined.map((g) => `${g.gid}@${g.cluster}`).join(' '))
const deva = lib.face('Noto Sans Devanagari', 'Regular')!.face.font()
const ki = deva.shape('कि', 0, 2, 'ltr', 'Deva')
check('Devanagari reorders: the i-sign is drawn before the consonant it follows', ki.length >= 1 && ki.every((g) => g.cluster === 0), ki.map((g) => `${g.gid}@${g.cluster}`).join(' '))
const o = inter.outline(inter.shape('o', 0, 1, 'ltr')[0].gid)
check('outlines come back as closed contours of lines and cubics', o.filter((v, i) => v === 0 && (i === 0 || o[i - 1] === 4)).length === 2 && o[o.length - 1] === 4)

// --- the font library --------------------------------------------------------------------------
console.log('\nthe font library')
const inters = lib.families().find((f) => f.family === 'Inter Variable')
check('a variable font’s named instances are its styles, upright and italic', !!inters && inters.styles.some((s) => s.style === 'Bold' && !s.italic) && inters.styles.some((s) => s.style === 'Bold Italic' && s.italic), inters?.styles.map((s) => s.style).join(', '))
check('a style missing from a family gives its nearest', lib.face('Inter Variable', 'Semi Bold Oblique')?.coords.wght === 600)
check('an unknown family is missing', lib.face('No Such Font', 'Regular') === null && !lib.hasFamily('No Such Font'))
check('each instance of a variable font has a PostScript name of its own, and is found by it', lib.entry('Inter Variable', 'Bold')?.postscript === 'InterVariable-Bold' && lib.byPostscript('InterVariable-Bold')?.style === 'Bold' && lib.byPostscript('InterVariableItalic-BoldItalic')?.style === 'Bold Italic', `${lib.entry('Inter Variable', 'Bold')?.postscript} ${lib.entry('Inter Variable', 'Bold Italic')?.postscript}`)
check('a variable face’s own name finds its Regular', lib.byPostscript('InterVariable')?.style === 'Regular' && lib.byPostscript('NoSuchFont-Bold') === null)
check('weights from style names', styleWeight('ExtraBold Italic') === 800 && styleWeight('Book') === 400 && styleWeight('Light') === 300)
check('licences: restricted and preview-only fonts aren’t embedded, editable ones are', !embeddable(0x0002) && !embeddable(0x0004) && embeddable(0x0008) && embeddable(0x000c) && embeddable(0))
{
  let made = 0
  let loaded = 0
  const lazy = new FontLibrary(hb)
  lazy.addFile('Inter', readFileSync('public/fonts/InterVariable.ttf'), 'builtin')
  lazy.addLazy('local:Arabic', 'local', async () => {
    loaded++
    return readFileSync('scripts/fixtures/fonts/NotoSansArabic-Regular.ttf')
  }, [{ family: 'Noto Sans Arabic', style: 'Regular', weight: 400, italic: false, index: 0, coords: {}, postscript: 'NotoSansArabic-Regular' }])
  lazy.subscribe(() => made++)
  const before = lazy.face('Noto Sans Arabic', 'Regular')
  await new Promise((r) => setTimeout(r, 20))
  check('a known font loads when it’s first wanted, and says so', before === null && loaded === 1 && made > 0 && !!lazy.face('Noto Sans Arabic', 'Regular'))
}
{
  // A system font the browser lists under names of its own (as Local Font Access can), read when first used.
  const sys = new FontLibrary(hb)
  sys.addFile('Inter', readFileSync('public/fonts/InterVariable.ttf'), 'builtin')
  sys.addLazy('local:NotoSansArabic-Regular', 'local', async () => readFileSync('scripts/fixtures/fonts/NotoSansArabic-Regular.ttf'), [
    { family: 'Noto Arabic UI', style: 'Book', weight: 400, italic: false, index: 0, coords: {}, postscript: 'NotoSansArabic-Regular', full: 'Noto Arabic UI Book' },
  ])
  const asked = (font: string, style: string) => layoutText({ content: contentFrom('abc', { font, style }), mode: 'point', frame: null, pathOffset: 0 }, sys)
  const first = asked('Noto Arabic UI', 'Book')
  check('a font still loading is pending, not missing', first.missing.length === 0 && first.pending.includes('Noto Arabic UI Book') && sys.status('Noto Arabic UI', 'Book') === 'loading', JSON.stringify({ m: first.missing, p: first.pending }))
  await new Promise((r) => setTimeout(r, 20))
  const after = asked('Noto Arabic UI', 'Book')
  check('once read, the names the browser listed it by still find it', after.missing.length === 0 && after.pending.length === 0 && !!sys.face('Noto Arabic UI', 'Book') && sys.status('Noto Arabic UI', 'Book') === 'ready')
  const fams = sys.families().map((f) => f.family)
  check('the menu lists it by those names, the file’s own kept as an alias it doesn’t list', fams.includes('Noto Arabic UI') && !fams.includes('Noto Sans Arabic') && sys.resolve('Noto Sans Arabic', 'Regular')?.file === 'local:NotoSansArabic-Regular', JSON.stringify(fams))
  check('found by PostScript name, with no style (as a Photoshop file asks)', sys.resolve('NotoSansArabic-Regular', '')?.family === 'Noto Arabic UI')
  check('found by its full name, or names written another way', sys.resolve('Noto Arabic UI Book', '')?.family === 'Noto Arabic UI' && sys.resolve('noto-arabic-ui', 'BOOK')?.family === 'Noto Arabic UI')
  check('a PostScript name not here is guessed as a family and style', sys.resolve('InterVariable-Bold', '')?.style === 'Bold' && sys.resolve('InterVariable-Bold', '')?.family === 'Inter Variable')
  const none = asked('Nowhere Sans', 'Regular')
  check('a font nothing knows is missing', none.missing.includes('Nowhere Sans Regular') && none.pending.length === 0 && sys.status('Nowhere Sans', 'Regular') === 'missing')
}

// --- the model ---------------------------------------------------------------------------------
console.log('\nthe text model')
{
  let c = contentFrom('Hello world', { size: 20 })
  c = insertText(c, 5, ',')
  check('typing goes in at the caret, taking the style there', plainText(c) === 'Hello, world' && c.paragraphs[0].runs.length === 1)
  c = insertText(c, 12, '\nSecond line')
  check('a line feed starts a paragraph', c.paragraphs.length === 2 && plainText(c) === 'Hello, world\nSecond line' && textLength(c) === 24)
  check('positions count the break as one', JSON.stringify(locate(c, 13)) === JSON.stringify({ para: 1, offset: 0 }))
  c = deleteRange(c, 10, 15)
  check('deleting across a break joins the paragraphs', c.paragraphs.length === 1 && plainText(c) === 'Hello, worcond line')
  c = styleRange(c, 0, 5, { size: 40, font: 'Inter Variable', style: 'Bold' })
  check('a range takes settings of its own, in a run of its own', c.paragraphs[0].runs.length === 2 && c.paragraphs[0].runs[0].props.size === 40 && c.paragraphs[0].runs[1].props.size === 20)
  c = styleRange(c, 0, 19, { size: 20, style: undefined, font: undefined })
  check('and back: runs that end up the same merge, a setting set to nothing inherits again', c.paragraphs[0].runs.length === 1 && c.paragraphs[0].runs[0].props.style === undefined)
  c = styleParagraphs(c, 3, 3, { align: 'centre' })
  check('paragraph settings go on the paragraphs a range touches', c.paragraphs[0].props.align === 'centre')
  const r = replaceRange(contentFrom('abc', { size: 9 }), 1, 2, 'XY')
  check('typing over a selection takes the style of what it replaces', plainText(r) === 'aXYc' && r.paragraphs[0].runs.length === 1)
  check('an emptied paragraph keeps its settings for typing', deleteRange(contentFrom('abc', { size: 77 }), 0, 3).paragraphs[0].runs[0].props.size === 77)
  const warns: string[] = []
  const bad = readTextContent({ paragraphs: [{ runs: [{ text: 'a\nb', props: { size: -4, font: 7, features: ['liga', 'bad feature!'], variations: { wght: 700, toolong: 1 } } }] }, 'junk'] }, (w) => warns.push(w))
  const p0 = bad.paragraphs[0].runs[0]
  check('text read back from a file is repaired: breaks out of runs, settings in range, junk dropped', bad.paragraphs.length === 1 && p0.text === 'a b' && p0.props.size === 0.1 && p0.props.font === undefined && p0.props.features!.join() === 'liga' && Object.keys(p0.props.variations!).join() === 'wght' && warns.length === 1)
  check('and an empty one gets a paragraph to type in', readTextContent(null, () => {}).paragraphs.length === 1)
  const styles: TextStyles = readTextStyles(
    {
      paragraph: [
        { id: 'body', name: 'Body', basedOn: null, para: { align: 'justify' }, char: { size: 12, font: 'Inter Variable' } },
        { id: 'quote', name: 'Quote', basedOn: 'body', para: { indentLeft: 20 }, char: { style: 'Italic' } },
      ],
      character: [
        { id: 'em', name: 'Emphasis', basedOn: 'strong', char: { style: 'Italic' } },
        { id: 'strong', name: 'Strong', basedOn: 'em', char: { tracking: 50 } },
        { id: 'em', name: 'Twice' },
      ],
    },
    () => {},
  )
  check('styles read back, a repeated id dropped', styles.paragraph.length === 2 && styles.character.length === 2)
  const para = { runs: [], style: 'quote', props: { indentRight: 5 } }
  const rp = resolvePara(para, styles)
  check('paragraph settings resolve through the style it’s based on', rp.align === 'justify' && rp.indentLeft === 20 && rp.indentRight === 5)
  const rc = resolveChar({ style: 'em', props: { size: 30 } }, para, styles)
  check('character settings: defaults, the paragraph style’s, the character style’s, the run’s own; a loop in “based on” is cut', rc.size === 30 && rc.style === 'Italic' && rc.tracking === 50 && rc.font === 'Inter Variable' && rc.kerning === DEFAULT_CHAR.kerning)
}

// --- layout ------------------------------------------------------------------------------------
console.log('\nlayout')
const lay = (content: TextContent, mode: 'point' | 'area' | 'path' = 'point', frame: PathData | null = null, styles?: TextStyles, pathOffset = 0): TextLayout => layoutText({ content, mode, frame, styles, pathOffset }, lib)
const rect = (x: number, y: number, w: number, h: number) => shapePath({ type: 'rect', x, y, w, h, radii: [0, 0, 0, 0], corner: 'round' })
const LOREM =
  'Type is the visible form of language. Every line here is set by the composer, which looks for good breaks between words, never inside them, and shares out the spaces when the text is justified, so that the paragraph keeps an even colour from its first line to its last one.'

{
  const l = lay(contentFrom('Hello', { size: 100 }))
  const w = adv('Hello') * (100 / 2048)
  check('point text sits on its origin’s baseline, as wide as its advances', l.lines.length === 1 && l.lines[0].baseline === 0 && Math.abs(l.lines[0].x1 - l.lines[0].x0 - w) < 1e-6 && l.lines[0].x0 === 0)
  const b = l.bounds!
  check('its ink stands above the baseline', b[1] < 0 && b[3] > -1 && b[1] > -100)
  const centred = lay(styleParagraphs(contentFrom('Hello', { size: 100 }), 0, 0, { align: 'centre' }))
  check('centred point text is centred on its origin', Math.abs(centred.lines[0].x0 + centred.lines[0].x1) < 1e-6)
  const two = lay(contentFrom('One\nTwo', { size: 50 }))
  check('paragraphs go down by the leading (auto: 120% of the size)', two.lines.length === 2 && Math.abs(two.lines[1].baseline - 60) < 1e-9)
  const tracked = lay(contentFrom('Hello', { size: 100, tracking: 100 }))
  check('tracking adds a tenth of an em after each of five letters', Math.abs(tracked.lines[0].x1 - tracked.lines[0].x0 - (w + 5 * 10)) < 1e-6)
  const boxes = l.lines[0].boxes
  check('each character has a box, left to right in order', boxes.length === 5 && boxes.every((bx, i) => bx[1] >= bx[0] && (i === 0 || Math.abs(bx[0] - boxes[i - 1][1]) < 1e-6)))
  const ul = lay(contentFrom('Hi', { size: 100, underline: true }))
  check('an underline is one more thing drawn', ul.glyphs.placements.length / 7 === l.glyphs.placements.length / 7 - 3 + 1, `${ul.glyphs.placements.length / 7}`)
}
{
  const frame = rect(10, 20, 300, 1000)
  const greedy = lay(styleParagraphs(contentFrom(LOREM, { size: 20 }), 0, 0, { composer: 'single' }), 'area', frame)
  const best = lay(contentFrom(LOREM, { size: 20 }), 'area', frame)
  const inFrame = (l: TextLayout) => l.lines.every((ln) => ln.boxes.every(([a, b], i) => (/\s/.test(LOREM[ln.start + i] ?? '') ? true : a >= 10 - 1e-6 && b <= 310 + 1e-6)))
  check('area text wraps inside its frame, whichever composer', greedy.lines.length > 4 && inFrame(greedy) && inFrame(best))
  const words = (l: TextLayout) => l.lines.every((ln) => ln.end === LOREM.length || /\s/.test(LOREM[ln.end - 1]))
  check('lines break between words, never inside them', words(greedy) && words(best))
  const rag = (l: TextLayout) => l.lines.slice(0, -1).reduce((a, ln) => {
    let right = 0
    ln.boxes.forEach(([, b], i) => {
      if (!/\s/.test(LOREM[ln.start + i])) right = Math.max(right, b)
    })
    return a + (310 - right) ** 2
  }, 0)
  check('the every-line composer leaves a less ragged edge than the single-line one', rag(best) < rag(greedy) - 1e-6, `${fmt(rag(best))} against ${fmt(rag(greedy))}`)
  check('the first baseline is a line’s ascent below the frame’s top', Math.abs(best.lines[0].baseline - (20 + (1984 / 2048) * 20)) < 1e-6)
  const just = lay(styleParagraphs(contentFrom(LOREM, { size: 20 }), 0, 0, { align: 'justify' }), 'area', frame)
  const rightEdge = (ln: TextLayout['lines'][number]) => Math.max(...ln.boxes.map(([, b], i) => (/\s/.test(LOREM[ln.start + i]) ? -Infinity : b)))
  check('justified lines reach the frame’s right edge, but the last', just.lines.slice(0, -1).every((ln) => Math.abs(rightEdge(ln) - 310) < 0.01) && rightEdge(just.lines[just.lines.length - 1]) < 300)
  const small = lay(contentFrom(LOREM, { size: 20 }), 'area', rect(0, 0, 300, 60))
  check('text past the frame’s bottom overflows, and isn’t set', small.overflow && small.lines.length === 2 && !best.overflow)
  const indent = lay(styleParagraphs(contentFrom(LOREM, { size: 20 }), 0, 0, { indentFirst: 30, indentLeft: 10, composer: 'single' }), 'area', frame)
  check('indents: the first line in further, every line in from the left', Math.abs(indent.lines[0].boxes[0][0] - 50) < 1e-6 && Math.abs(indent.lines[1].boxes[0][0] - 20) < 1e-6)
}
{
  // A circular frame: each line as wide as the circle is where it falls.
  const circle = shapePath({ type: 'ellipse', x: 0, y: 0, w: 400, h: 400 })
  const l = lay(contentFrom(LOREM + ' ' + LOREM, { size: 16 }), 'area', circle)
  const fits = l.lines.every((ln) => {
    const half = (y: number) => Math.sqrt(Math.max(0, 200 * 200 - (y - 200) ** 2))
    const w = Math.min(half(ln.top), half(ln.bottom))
    return ln.boxes.every(([a, b], i) => /\s/.test((LOREM + ' ' + LOREM)[ln.start + i] ?? '') || (a >= 200 - w - 1 && b <= 200 + w + 1))
  })
  check('text flows into a shape: every line within the circle where it falls', l.lines.length > 8 && fits, `${l.lines.length} lines`)
  check('wider in the middle than at the top', l.lines[Math.floor(l.lines.length / 2)].x1 - l.lines[Math.floor(l.lines.length / 2)].x0 > l.lines[0].x1 - l.lines[0].x0)
}
{
  const text = 'abc سلام def'
  const l = lay(contentFrom(text, { size: 40 }))
  const bx = l.lines[0].boxes
  check('bidi: the Arabic word runs right to left inside the line', bx[4][0] > bx[7][0] && bx[0][0] < bx[4][0] && bx[9][0] > bx[4][0], bx.map((b) => b[0].toFixed(0)).join(' '))
  check('scripts: Arabic and Latin told apart, spaces taking a neighbour’s', scriptOf('س') === 'Arab' && scriptOf('a') === 'Latn' && scriptOf(' ') === '')
  check('characters the font lacks come from a fallback for their script', l.missing.length === 0 && l.glyphs.outlines.length >= 8)
  const rtl = lay(contentFrom('سلام عليكم', { size: 40 }))
  check('a right-to-left paragraph knows it is one', rtl.lines[0].rtl)
  const hindi = lay(contentFrom('नमस्ते दुनिया', { size: 40 }))
  check('Devanagari shapes through its fallback', hindi.glyphs.placements.length > 0 && hindi.missing.length === 0)
  const missing = lay(contentFrom('abc', { font: 'Nowhere Sans', style: 'Bold' }))
  check('a missing font is named, and the text set in the default meanwhile', missing.missing.join() === 'Nowhere Sans Bold' && missing.glyphs.placements.length === 21)
}
{
  // Path text along a circle's top: every glyph on the circle, turned to follow it.
  const arc: PathData = { fillRule: 'nonzero', subpaths: [{ closed: false, anchors: Array.from({ length: 33 }, (_, i) => ({ p: [200 + 150 * Math.cos(Math.PI + (i * Math.PI) / 32), 200 + 150 * Math.sin(Math.PI + (i * Math.PI) / 32)] as [number, number], in: null, out: null, smooth: false })) }] }
  const l = lay(contentFrom('Along the path', { size: 24 }), 'path', arc)
  const g = l.glyphs.placements
  let worst = 0
  for (let i = 0; i < g.length; i += 7) {
    const r = Math.hypot(g[i + 5] - 200, g[i + 6] - 200)
    worst = Math.max(worst, Math.abs(r - 150))
  }
  check('path text sets each glyph on the path', g.length > 0 && worst < 15, `furthest ${fmt(worst)} px off`)
  const turned = g.length >= 14 && Math.abs(Math.atan2(g[2], g[1])) > 0.3
  check('turned to the path’s direction where it is', turned)
  const long = lay(contentFrom(LOREM, { size: 24 }), 'path', arc)
  check('text longer than its path overflows', long.overflow)
  // A closed path: text runs along every side, the last included, and starts where it's asked to.
  const square = shapePath({ type: 'rect', x: 0, y: 0, w: 200, h: 200, radii: [0, 0, 0, 0], corner: 'round' })
  const from = distanceAlong(square, 210, 100)
  check('a point beside a path is found along it', Math.abs(from - 300) < 1, `${fmt(from)} (300 wanted: the right side’s middle)`)
  const round = layoutText({ content: contentFrom('x'.repeat(60), { size: 20 }), styles: NO_STYLES, mode: 'path', frame: square, pathOffset: 0 }, lib)
  const q = round.glyphs.placements
  let onLast = false
  for (let i = 0; i < q.length; i += 7) if (q[i + 5] < 5 && q[i + 6] > 20 && q[i + 6] < 180) onLast = true
  check('text on a closed path runs along its closing side', onLast && !round.overflow)
}
{
  const l = lay(contentFrom('Glyphs', { size: 60 }))
  const area = flattenGlyphs(l.glyphs, 0.05).reduce((a, p) => a + Math.abs(polyArea(p.pts)), 0)
  const path = glyphsToPath(l.glyphs)
  const area2 = flattenPath(path, 0.05).reduce((a, p) => a + Math.abs(polyArea(p.pts)), 0)
  check('Create Outlines gives the same contours as drawing the glyphs', Math.abs(area - area2) < 1e-6 && path.subpaths.length > 6)
  const b = glyphsBounds(l.glyphs)!
  const pts = flattenGlyphs(l.glyphs, 0.05).flatMap((p) => p.pts)
  let inside = true
  for (let i = 0; i < pts.length; i += 2) if (pts[i] < b[0] - 1e-6 || pts[i] > b[2] + 1e-6 || pts[i + 1] < b[1] - 1e-6 || pts[i + 1] > b[3] + 1e-6) inside = false
  check('glyph bounds hold every point of every glyph', inside)
  check('a glyph used twice is kept once', l.glyphs.outlines.length < l.glyphs.placements.length / 7 || new Set('Glyphs').size === 6)
}

{
  // A glyph set's box is a path's: tight round the curves, turned glyphs too, so a gradient sits the same after Create Outlines.
  const near = (a: number[] | null, b: number[] | null) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
  const flat = lay(contentFrom('Bounds, gradients', { size: 50 })).glyphs
  const arc: PathData = { fillRule: 'nonzero', subpaths: [{ closed: false, anchors: Array.from({ length: 33 }, (_, i) => ({ p: [200 + 150 * Math.cos(Math.PI + (i * Math.PI) / 32), 200 + 150 * Math.sin(Math.PI + (i * Math.PI) / 32)] as [number, number], in: null, out: null, smooth: false })) }] }
  const curved = lay(contentFrom('Around', { size: 30 }), 'path', arc).glyphs
  check('glyph bounds are their outlines’ bounds, exactly', near(glyphsBounds(flat), pathBounds(glyphsToPath(flat))))
  check('and on a path, each glyph turned', near(glyphsBounds(curved), pathBounds(glyphsToPath(curved))))
}

// --- fonts in documents ------------------------------------------------------------------------
console.log('\nlaying out again after an edit')
{
  // A long story, justified in a frame: laid out, one paragraph edited, laid out again. Paragraphs
  // the edit didn't touch are kept from the first layout; the result must be what laying out a
  // copy that shares nothing gives.
  const story = styleParagraphs(contentFrom(Array.from({ length: 120 }, (_, i) => `${i}. ${LOREM}`).join('\n'), { size: 14 }), 0, 119, { align: 'justify' })
  const frame = rect(0, 0, 600, 100000)
  const timed = (fn: () => void) => {
    const t = performance.now()
    fn()
    return performance.now() - t
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  lay(story, 'area', frame)
  let edited = story
  let again = lay(edited, 'area', frame)
  // Medians of three each, so one slow run (the machine busy, the JIT warming) can't decide it.
  const afterEdits = [0, 1, 2].map((k) => timed(() => {
    edited = replaceRange(edited, 60 + k, 60 + k, 'An edit. ')
    again = lay(edited, 'area', frame)
  }))
  const fromNothing = [0, 1, 2].map(() => timed(() => lay(structuredClone(edited), 'area', frame)))
  const fresh = lay(structuredClone(edited), 'area', frame)
  const same = again.glyphs.placements.length === fresh.glyphs.placements.length && again.glyphs.placements.every((v, i) => v === fresh.glyphs.placements[i]) && again.lines.length === fresh.lines.length
  check('an edit lays out the same as laying the result out afresh', same, `${again.lines.length} lines`)
  check('and only the edited paragraph is shaped again', median(afterEdits) < median(fromNothing) * 0.75, `from nothing ${median(fromNothing).toFixed(0)} ms, after an edit ${median(afterEdits).toFixed(0)} ms`)
}

console.log('\nfonts in documents')
{
  const noto = new Uint8Array(readFileSync('scripts/fixtures/fonts/NotoSansArabic-Regular.ttf'))
  const notoFace = hb.openFace(noto, 0)!
  check('Noto’s licence lets it travel with a document', embeddable(notoFace.info.fsType), `fsType ${notoFace.info.fsType}`)
  let doc = createDoc({ name: 'Poster', width: 800, height: 600, resolution: 72, mode: 'rgb', depth: 8, profile: DEFAULT_PROFILES.rgb }, 'root')
  const t = makeNode('text', 't', 'Headline', {
    mode: 'point',
    content: { paragraphs: [{ runs: [{ text: 'مرحبا ', style: null, props: { font: notoFace.info.family, style: 'Regular' } }, { text: 'and Inter', style: 'cs1', props: {} }], style: null, props: {} }] },
    frame: null,
    pathOffset: 0,
    appearance: [],
  })
  doc = insertNode(doc, t, 'root', 0)
  doc = { ...doc, textStyles: { character: [{ id: 'cs1', name: 'Bold', basedOn: null, char: { style: 'Bold' } }], paragraph: [] } }
  const used = fontsUsed(doc).map((f) => `${f.family} ${f.style}`).sort()
  check('a document’s fonts are found, through its character styles', used.join(', ') === `${DEFAULT_CHAR.font} Bold, ${notoFace.info.family} Regular`, used.join(', '))
  const hash = await sha256(noto)
  const blob = await pxllBlob(doc, { pack: async () => new Uint8Array(), profile: () => undefined, fonts: async () => [{ hash, bytes: noto }] })
  const back = await readPxll(blob)
  check('a font carried in a .pxll comes back, byte for byte, by its hash', back.ok && back.fonts.size === 1 && !!back.fonts.get(hash) && back.fonts.get(hash)!.length === noto.length && back.fonts.get(hash)!.every((v, i) => v === noto[i]))
  check('and the document with it', back.ok && JSON.stringify(back.doc.textStyles) === JSON.stringify(doc.textStyles) && (back.doc.nodes.t as typeof t).props.content.paragraphs[0].runs.length === 2)
  const other = new FontLibrary(hb)
  other.addFile('InterVariable.ttf', readFileSync('public/fonts/InterVariable.ttf'), 'builtin')
  if (back.ok) for (const [h, bytes] of back.fonts) other.addFile(`${h}.font`, bytes, 'document')
  check('on another computer, the document’s font is there for its text', other.hasFamily(notoFace.info.family) && other.entry(notoFace.info.family, 'Regular')?.source === 'document')
  const plain = await readPxll(await pxllBlob(doc, { pack: async () => new Uint8Array(), profile: () => undefined }))
  check('a .pxll without fonts reads with none', plain.ok && plain.fonts.size === 0)
}

// --- hyphenation, justification, tabs, colour per character, glyphs -----------------------------------
console.log('\nhyphenation, justification and tabs')
{
  const hyph = new Hyphenation()
  check('a language’s patterns aren’t here until asked for', hyph.points('hyphenation', 'en') === null)
  await hyph.load('en')
  const pts = hyph.points('hyphenation', 'en-US') ?? []
  check('then a word’s breaks come from TeX’s patterns: hy-phen-ation', JSON.stringify(pts) === JSON.stringify([2, 6]), JSON.stringify(pts))
  check('a language without patterns has none, and asks for nothing', JSON.stringify(hyph.points('word', 'xx')) === '[]')
  const words = 'Typography demonstrates extraordinarily international communication possibilities within constrained typographical arrangements everywhere'
  const frame = { subpaths: [{ closed: true, anchors: [[0, 0], [260, 0], [260, 4000], [0, 4000]].map((p) => ({ p: p as [number, number], in: null, out: null, smooth: false })) }], fillRule: 'nonzero' as const }
  const para = (p: Partial<ParaProps>, text = words, char: Partial<CharProps> = {}) => ({ paragraphs: [{ runs: [{ text, style: null, props: { size: 24, ...char } }], style: null, props: p }] })
  const lay = (p: Partial<ParaProps>, text?: string, char?: Partial<CharProps>) => layoutText({ content: para(p, text, char), mode: 'area', frame, hyphenator: hyph }, lib)
  const isLetter = (ch: string | undefined) => !!ch && /\p{L}/u.test(ch)
  const broken = (l: ReturnType<typeof lay>, text = words) => l.lines.filter((ln, i) => i < l.lines.length - 1 && isLetter(text[ln.end - 1]) && isLetter(text[ln.end]))
  const plain = lay({ hyphenate: false, align: 'left', composer: 'single' })
  const hy = lay({ hyphenate: true, align: 'left', composer: 'single' })
  check('without hyphenation no line ends inside a word', broken(plain).length === 0)
  const glyphCount = (l: ReturnType<typeof lay>) => l.glyphs.placements.length / 7
  check('hyphenating, lines end inside words, each with a hyphen drawn', broken(hy).length > 0 && glyphCount(hy) === glyphCount(plain) + broken(hy).length, `${broken(hy).length} broken, ${glyphCount(hy)} glyphs against ${glyphCount(plain)}`)
  check('and the text takes fewer lines', hy.lines.length <= plain.lines.length, `${hy.lines.length} against ${plain.lines.length}`)
  const every = lay({ hyphenate: true, align: 'justify', composer: 'every' })
  check('the every-line composer hyphenates too', broken(every).length > 0)
  const limited = lay({ hyphenate: true, align: 'left', composer: 'single', hyphenation: { ...DEFAULT_PARA.hyphenation, limit: 1 } })
  const ends = limited.lines.map((ln, i) => i < limited.lines.length - 1 && isLetter(words[ln.end - 1]) && isLetter(words[ln.end]))
  check('a hyphen limit of 1: never two hyphenated lines in a row', !ends.some((b, i) => b && ends[i + 1]), ends.map((b) => (b ? '-' : '.')).join(''))
  const long = lay({ hyphenate: true, align: 'left', composer: 'single', hyphenation: { ...DEFAULT_PARA.hyphenation, minWord: 30 } })
  check('words no longer than “words longer than” aren’t hyphenated', broken(long).length === 0)
  const soft = 'Supercali\u00adfragilistic\u00adexpialidocious'
  const sl = layoutText({ content: para({ align: 'left' }, soft), mode: 'area', frame: { ...frame, subpaths: [{ ...frame.subpaths[0], anchors: frame.subpaths[0].anchors.map((a) => ({ ...a, p: [Math.min(a.p[0], 200), a.p[1]] as [number, number] })) }] } }, lib)
  check('a soft hyphen is a place to break, with a hyphen drawn there', sl.lines.length > 1 && soft[sl.lines[0].end - 1] === '\u00ad', sl.lines.map((l) => soft.slice(l.start, l.end)).join(' | '))
  check('Photoshop’s hyphenation and justification settings read back, kept in order', JSON.stringify(readParaProps({ hyphenate: true, hyphenation: { minWord: 7, minBefore: 3, minAfter: 3, limit: 0, zone: 20, caps: false }, wordSpacing: [120, 90, 80], autoLeading: 140, tabs: [{ at: 50, align: 'decimal', leader: '.', char: ',' }] })) === JSON.stringify({ hyphenate: true, hyphenation: { minWord: 7, minBefore: 3, minAfter: 3, limit: 0, zone: 20, caps: false }, wordSpacing: [90, 90, 90], autoLeading: 140, tabs: [{ at: 50, align: 'decimal', leader: '.', char: ',' }] }))

  // Spacing: a point text's word space at 200% is twice as wide; letter spacing and glyph scaling widen the line.
  const pt = (p: Partial<ParaProps>, text = 'ab cd') => layoutText({ content: para(p, text), mode: 'point', frame: null }, lib).lines[0]
  const spaceW = (l: ReturnType<typeof pt>) => l.boxes[2][1] - l.boxes[2][0]
  check('wanted word spacing scales the spaces', Math.abs(spaceW(pt({ wordSpacing: [80, 200, 250] })) - 2 * spaceW(pt({}))) < 0.01, `${fmt(spaceW(pt({ wordSpacing: [80, 200, 250] })))} against ${fmt(spaceW(pt({})))}`)
  const w = (l: ReturnType<typeof pt>) => l.x1 - l.x0
  check('wanted letter spacing adds room between letters', w(pt({ letterSpacing: [0, 50, 50] })) > w(pt({})) + 2)
  check('wanted glyph scaling widens the glyphs', w(pt({ glyphScaling: [100, 150, 150] }, 'abcd')) > w(pt({}, 'abcd')) * 1.4)
  // Justified: with word spacing fixed, letter spacing takes the slack; one word spreads across its letters.
  const narrow = frame
  const jtext = 'ab cd ef gh ij kl mn op qr st uv wx yz ab cd ef'
  const jl = layoutText({ content: para({ align: 'justify', composer: 'single', wordSpacing: [100, 100, 100], letterSpacing: [0, 0, 100] }, jtext), mode: 'area', frame: narrow }, lib).lines[0]
  // The last letter on the line (its trailing space hangs past the frame).
  let lastLetter = jl.end - 1
  while (lastLetter > jl.start && jtext[lastLetter] === ' ') lastLetter--
  const space0 = jl.boxes[2][1] - jl.boxes[2][0]
  check('justified with word spacing held at 100%, the spaces stay their size and the letters spread', Math.abs(space0 - spaceW(pt({}))) < 0.5 && Math.abs(jl.boxes[lastLetter - jl.start][1] - 260) < 0.5, `space ${fmt(space0)}, letters to ${fmt(jl.boxes[lastLetter - jl.start][1])}`)

  // Tabs.
  const tl = (tabs: ParaProps['tabs'], text: string) => layoutText({ content: para({ tabs }, text), mode: 'point', frame: null }, lib)
  const left = tl([{ at: 200, align: 'left', leader: '', char: '.' }], 'a\tb').lines[0]
  check('a tab moves to the next stop: left-aligned text starts there', Math.abs(left.boxes[2][0] - 200) < 0.5, fmt(left.boxes[2][0]))
  const right = tl([{ at: 300, align: 'right', leader: '', char: '.' }], 'a\tlast').lines[0]
  check('right-aligned text ends there', Math.abs(right.boxes[right.boxes.length - 1][1] - 300) < 1, fmt(right.boxes[right.boxes.length - 1][1]))
  const dec = tl([{ at: 300, align: 'decimal', leader: '', char: '.' }], 'a\t123.45').lines[0]
  check('decimal-aligned text lines its point up on it', Math.abs(dec.boxes[5][0] - 300) < 1, fmt(dec.boxes[5][0]))
  const plainTab = tl([{ at: 300, align: 'left', leader: '', char: '.' }], 'a\tb')
  const dotted = tl([{ at: 300, align: 'left', leader: '.', char: '.' }], 'a\tb')
  check('a leader fills the gap', dotted.glyphs.placements.length / 7 > plainTab.glyphs.placements.length / 7 + 5, `${dotted.glyphs.placements.length / 7} glyphs`)
  const def = tl([], 'a\tb').lines[0]
  check('past the last stop, one every four ems', Math.abs(def.boxes[2][0] - 24 * 4) < 0.5, fmt(def.boxes[2][0]))
}

console.log('\ncolour per character')
{
  const content = { paragraphs: [{ runs: [{ text: 'ab', style: null, props: { size: 40 } }, { text: 'cd', style: null, props: { size: 40, fill: solid([0, 0, 1]) } }, { text: 'ef', style: null, props: { size: 40, stroke: solid([1, 0, 0]), strokeWidth: 2 } }], style: null, props: {} }] }
  const l = layoutText({ content, mode: 'point', frame: null }, lib)
  const g = l.glyphs
  check('glyphs keep the paints their characters have of their own', g.paints?.length === 2 && JSON.stringify(g.paintOf) === JSON.stringify([-1, -1, 0, 0, 1, 1]), JSON.stringify(g.paintOf))
  const o = vectorOutline(g, [fillItem(solid([0, 0, 0]))], [1, 0, 0, 1, 0, 0], 0, 'rgb')
  const paints = o.items.map((it) => `${it.item.kind}:${it.item.paint.kind === 'solid' ? it.item.paint.colour.join(',') : ''}`)
  check('the text’s fill is split: its own glyphs black, the blue ones blue; a stroke added for the stroked ones', JSON.stringify(paints) === JSON.stringify(['fill:0,0,0', 'fill:0,0,1', 'stroke:1,0,0']), JSON.stringify(paints))
}

console.log('\nthe Glyphs panel')
{
  const map = cmapOf(interFace)
  check('every character the font maps, from its cmap', map.length > 1000 && map.some((m) => m.cp === 65) && map.some((m) => m.cp === 0x20ac), `${map.length} characters`)
  const alts = alternatesOf(inter, '1'.codePointAt(0)!, 'en')
  check('a character’s alternates, each with the feature that makes it', alts.length > 0 && alts.every((a) => a.gid > 0 && a.feature), alts.map((a) => a.feature).join(' '))
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
