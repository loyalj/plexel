/**
 * Type in Chrome, end to end, through the real pointer, keys and panels:
 * point text typed, named and drawn; editing (the caret, selections,
 * Undo inside the session, IME composition, pasting); area text wrapping in
 * its frame and overflowing; text along a shape's path; the Character and
 * Paragraph panels on a selection, a layer and new text; styles; a missing
 * font; Create Outlines and Rasterize; then, with the browser's permission to
 * list the system's fonts granted, those fonts listed without a click, a
 * system font loading without being called missing, a Photoshop file's
 * fonts found by their PostScript names, and the font menu.
 *
 * Documents are 800 × 600 at 100%, so an offset from the canvas's centre is
 * one from the document's centre (400, 300).
 *
 * Run with: npm run check:type
 */
import fs from 'node:fs'
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { browser, page, url } = await open({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const { press } = pageHelpers(page)
const clickMenu = async (menu, command, submenu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
  if (submenu) {
    await page.click(`[data-submenu="${submenu}"]`)
    await frames(page)
  }
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const idle = async () => {
  await frames(page)
  await page.evaluate(() => globalThis.plexel.engine().call('render.idle', {}))
  await frames(page)
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
/** How many dark pixels a box of the canvas has (offsets from its centre). */
const ink = async (x0, y0, x1, y1, img) => {
  const r = await rect()
  const im = img ?? (await shot())
  let n = 0
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const c = pixelAt(im, Math.round(r.x + r.w / 2 + x), Math.round(r.y + r.h / 2 + y))
    if (c[0] + c[1] + c[2] < 300) n++
  }
  return n
}
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const selected = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return d.selected ? d.history.present.nodes[d.selected] : null
})
const textOf = (n) => n.props.content.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n')
const pointAt = async (dx, dy) => {
  const r = await rect()
  return [r.x + r.w / 2 + dx, r.y + r.h / 2 + dy]
}
const clickAt = async (dx, dy, keys = []) => {
  const p = await pointAt(dx, dy)
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.click(...p)
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(80)
}
const drag = async (from, to) => {
  const a = await pointAt(...from)
  const b = await pointAt(...to)
  await page.mouse.move(...a)
  await page.mouse.down()
  await page.mouse.move(...b, { steps: 8 })
  await page.mouse.up()
  await settle(120)
}
const typed = (text) => page.keyboard.type(text, { delay: 5 })
/** Waits for the fonts and the text to be drawn. */
const drawn = async () => {
  await settle(150)
  await idle()
}
const editing = () => page.evaluate(() => !!document.querySelector('[data-type-input]') && document.activeElement?.hasAttribute('data-type-input'))
const tap = async (sel) => {
  await page.$eval(sel, (e) => e.click())
  await frames(page)
}
const typeInto = async (sel, text) => {
  await page.$eval(sel, (e) => {
    e.focus()
    e.select()
  })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await frames(page)
}
const newDoc = async () => {
  await press('Control+Alt+KeyN')
  await page.waitForSelector('#new-name')
  for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
    await page.click(id, { clickCount: 3 })
    await page.keyboard.type(String(v))
  }
  await page.click('[data-dialog="new"] .dialog-foot .primary')
  await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
  await idle()
  await press('Control+Digit1')
  await idle()
}

// --- point text ----------------------------------------------------------------------------
console.log('\npoint text')
await newDoc()
await clickMenu('Window', 'window.panel.character')
await clickMenu('Window', 'window.panel.paragraph')
await press('KeyT')
check('T chooses the Type tool', await page.$eval('[data-options="type"]', () => true).catch(() => false))
await clickAt(-300, -150)
await waitUntil(page, () => !!document.querySelector('[data-type-input]'), { timeout: 10000 })
check('a click starts text there, the keyboard going to it', await editing())
check('nothing is in the document until something is typed', (await doc()).nodes[(await doc()).root].children.length === 1)
await typed('Hello type')
await drawn()
let s = await selected()
check('typing makes a text layer, one step', s?.kind === 'text' && textOf(s) === 'Hello type' && (await label()) === 'New Text')
check('point text starts where the click was', Math.abs(s.transform[4] - 100) <= 1 && Math.abs(s.transform[5] - 150) <= 1)
check('and is drawn on the canvas', (await ink(-300, -190, 0, -140)) > 40)
await press('Escape')
s = await selected()
check('Esc finishes; the layer is named after its text', !(await editing()) && s.name === 'Hello type')
const thumbed = await waitUntil(page, (id) => document.querySelector(`[data-layer="${id}"] [data-part="content"] [data-thumb]`)?.getAttribute('data-thumb') === 'image', { timeout: 4000, args: [s.id] })
check('its thumbnail in Layers shows the text', thumbed, await page.$eval(`[data-layer="${s.id}"] [data-thumb]`, (e) => e.getAttribute('data-thumb')).catch(() => 'none'))
await clickMenu('Edit', 'edit.undo')
check('the new layer undoes in one step', !(await selected()) || (await doc()).nodes[(await doc()).root].children.length === 1)
await clickMenu('Edit', 'edit.redo')

// --- editing ---------------------------------------------------------------------------------
console.log('\nediting')
await clickAt(-290, -165)
check('a click in text edits it', await editing())
await press('End')
await typed('!')
s = await selected()
check('End goes to the end of the line; typing goes in there', textOf(s) === 'Hello type!')
await press('Home')
await press('Shift+ArrowRight')
await press('Shift+ArrowRight')
await press('Shift+ArrowRight')
await press('Shift+ArrowRight')
await press('Shift+ArrowRight')
await typed('Howdy')
s = await selected()
check('a selection made with Shift and the arrows is typed over', textOf(s) === 'Howdy type!')
await press('Control+KeyZ')
s = await selected()
check('Ctrl+Z inside the text undoes, and the editing goes on', textOf(s) === 'Hello type!' && (await editing()))
await press('Control+Shift+KeyZ')
s = await selected()
check('and Ctrl+Shift+Z redoes', textOf(s) === 'Howdy type!')
await press('Control+Backspace')
s = await selected()
check('Ctrl+Backspace deletes the word before the caret', textOf(s) === ' type!', JSON.stringify(textOf(s)))
await press('End')
await press('Enter')
await typed('Second')
s = await selected()
check('Enter starts a paragraph', s.props.content.paragraphs.length === 2 && s.props.content.paragraphs[1].runs[0].text === 'Second')
// An IME composing, as Chrome sends it.
const cdp = await page.createCDPSession()
await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 })
await settle(80)
check('an IME’s text in progress isn’t in the document yet', !textOf(await selected()).includes('にほ'))
await cdp.send('Input.insertText', { text: '日本' })
await settle(80)
s = await selected()
check('and goes in as one when chosen', textOf(s).endsWith('Second日本'))
await page.$eval('[data-type-input]', (ta) => {
  const dt = new DataTransfer()
  dt.setData('text/plain', ' pasted')
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
})
s = await selected()
check('pasting puts plain text in at the caret', textOf(s).endsWith('日本 pasted'))
await press('Control+KeyA')
await typeInto('#type-size', '30')
await drawn()
s = await selected()
check('the Character panel changes the selected text: everything selected is 30 px', s.props.content.paragraphs.every((p) => p.runs.every((r) => r.props.size === 30)))
await press('Escape')

// --- the panels on a layer, and on new text -------------------------------------------------------
console.log('\nthe panels')
const before = await ink(-320, -200, 100, -60)
await page.select('#type-style', 'Black')
await drawn()
s = await selected()
check('with a text layer selected, the panels change all of it: Black', s.props.content.paragraphs.every((p) => p.runs.every((r) => r.props.style === 'Black')))
check('and it’s drawn heavier', (await ink(-320, -200, 100, -60)) > before * 1.2, `${before} → ${await ink(-320, -200, 100, -60)}`)
await tap('[data-type-align="right"]')
s = await selected()
check('the Paragraph panel aligns its paragraphs', s.props.content.paragraphs.every((p) => p.props.align === 'right'))
await tap('[data-type-new-style="paragraph"]')
s = await selected()
const docNow = await doc()
check('a paragraph style is made from it, and applied', docNow.textStyles?.paragraph.length === 1 && s.props.content.paragraphs[0].style === docNow.textStyles.paragraph[0].id)
await page.$eval(`[data-type-styles="paragraph"] [data-style="${docNow.textStyles.paragraph[0].id}"] .appearance-pick`, (e) => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
await frames(page)
await page.keyboard.type('Headline')
await page.keyboard.press('Enter')
await frames(page)
check('double-clicking a style renames it', (await doc()).textStyles.paragraph[0].name === 'Headline' && (await label()) === 'Rename Style', `${(await doc()).textStyles.paragraph[0].name} / ${await label()}`)
await page.evaluate(() => globalThis.plexel.documents().select(null))
await frames(page)
await typeInto('#type-size', '64')
check('with no text selected, the panels set new text’s settings', (await page.$eval('[data-type-target]', (e) => e.dataset.typeTarget)) === 'defaults' && (await page.$eval('#type-size', (e) => e.value)) === '64')

// --- area and path text --------------------------------------------------------------------------
console.log('\narea and path text')
await typeInto('#type-size', '20')
await drag([-350, 20], [-50, 260])
await waitUntil(page, () => !!document.querySelector('[data-type-input]'), { timeout: 10000 })
await typed('Area text flows inside its frame and wraps between words as the lines fill, one after another, until the frame is full.')
await drawn()
s = await selected()
check('a drag makes area text in the box dragged', s.props.mode === 'area' && s.props.frame?.shape?.w >= 299 && s.props.frame?.shape?.h >= 239)
check('its lines wrap inside the frame: ink in it, none past its right edge', (await ink(-350, 20, -50, 260)) > 200 && (await ink(-45, 20, 60, 260)) === 0)
await press('Escape')
await typeInto('#type-size', '60')
await drag([-350, 20], [-50, 70]).catch(() => {})
await waitUntil(page, () => !!document.querySelector('[data-type-input]'), { timeout: 10000 })
await typed('Too much text for so small a frame')
await press('Escape')
await drawn()
check('text that doesn’t fit says so in Properties', await page.$eval('[data-text-overflow]', () => true).catch(() => false))
// Text along a shape's outline.
await press('KeyU')
await page.click('[data-shape-type="ellipse"]')
await drag([100, -250], [350, 0])
await press('KeyT')
await typeInto('#type-size', '24')
await clickAt(350, -125, ['Alt'])
await waitUntil(page, () => !!document.querySelector('[data-type-input]'), { timeout: 10000 })
await typed('Along the outline')
await press('Escape')
await drawn()
s = await selected()
check('Alt-click on a closed shape’s outline types along it', s.props.mode === 'path' && textOf(s) === 'Along the outline')
check('the text follows the curve', (await ink(180, -135, 365, 20)) > 30)
const firstGlyph = await page.evaluate((id) => {
  const d = globalThis.plexel.documents().active().history.present
  const p = globalThis.plexel.text.layoutOf(d.nodes[id], d).glyphs.placements
  return [p[5], p[6]]
}, s.id)
check('and starts where the outline was clicked', s.props.pathOffset > 0 && Math.hypot(firstGlyph[0] - 750, firstGlyph[1] - 175) < 30, `offset ${s.props.pathOffset.toFixed(0)}, first glyph at ${firstGlyph.map((v) => v.toFixed(0))}`)

// A closed shape's outline, clicked: area text inside the shape.
await press('KeyU')
await page.click('[data-shape-type="star"]')
await drag([80, 30], [330, 200])
await press('KeyT')
await typeInto('#type-size', '14')
await clickAt(205, 32)
await waitUntil(page, () => !!document.querySelector('[data-type-input]'), { timeout: 10000 })
await typed('Inside the star the lines are as wide as the star is at each one, narrow at the top and wide across the arms.')
await press('Escape')
await drawn()
s = await selected()
const starLines = await page.evaluate((id) => {
  const d = globalThis.plexel.documents().active().history.present
  return globalThis.plexel.text.layoutOf(d.nodes[id], d).lines.map((l) => [l.x0, l.x1])
}, s.id)
const widths = starLines.map(([a, b]) => b - a)
check('a click on a closed shape’s outline sets area text inside it, shaped like it', s.props.mode === 'area' && s.props.frame?.kind === 'path' && widths.length >= 3 && Math.max(...widths) > Math.min(...widths) * 1.5, widths.map((w) => w.toFixed(0)).join(' '))

// --- outlines, rasterizing, a missing font -------------------------------------------------------
console.log('\noutlines and fonts')
const pathTextId = s.id
await clickMenu('Type', 'type.create-outlines')
s = await selected()
check('Create Outlines makes a shape of the text, in its place', (await label()) === 'Create Outlines' && s.kind === 'vector' && s.props.geometry.kind === 'path' && !(await doc()).nodes[pathTextId])
await press('Control+KeyZ')
await page.evaluate((id) => globalThis.plexel.documents().select(id), pathTextId)
await clickMenu('Layer', 'layer.rasterize')
await idle()
s = await selected()
check('Rasterize makes text a pixel layer', s?.kind === 'pixel' && !!s.props.tiles, `${s?.kind} ${await label()} ${JSON.stringify(s?.props).slice(0, 120)}`)
await page.evaluate(() => {
  const { makeNode } = globalThis.plexel.doc
  const store = globalThis.plexel.documents()
  store.commit((d) => {
    const n = makeNode('text', 'missing-font', 'Lost', { mode: 'point', content: { paragraphs: [{ runs: [{ text: 'Where is it', style: null, props: { font: 'Nowhere Grotesk', style: 'Bold', size: 30 } }], style: null, props: {} }] }, frame: null, pathOffset: 0, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0, 0, 0] }, opacity: 1, blend: 'normal' }] })
    n.transform = [1, 0, 0, 1, 450, 550]
    const root = d.nodes[d.root]
    return { ...d, nodes: { ...d.nodes, 'missing-font': n, [d.root]: { ...root, children: [...root.children, 'missing-font'] } } }
  })
})
await drawn()
const told = await waitUntil(page, () => [...document.querySelectorAll('.notice')].some((n) => /Nowhere Grotesk/.test(n.textContent)), { timeout: 4000 })
check('a font that isn’t here is named, and its text shown in the default', told && (await ink(50, 220, 380, 260)) > 20)

// --- hyphenation, colour per character, the Glyphs panel ----------------------------------------
console.log('\nhyphenation, colour per character, the Glyphs panel')
await newDoc()
const WORDS = 'Typography demonstrates extraordinarily international communication possibilities'
await page.evaluate((words) => {
  const { makeNode } = globalThis.plexel.doc
  globalThis.plexel.documents().commit((d) => {
    const n = makeNode('text', 'typo', 'Typo', {
      mode: 'area',
      content: { paragraphs: [{ runs: [{ text: words, style: null, props: { size: 28 } }, { text: ' BLUE', style: null, props: { size: 60, style: 'Black', fill: { kind: 'solid', colour: [0, 0, 1] } } }], style: null, props: {} }] },
      frame: { kind: 'shape', shape: { type: 'rect', x: 0, y: 0, w: 230, h: 500, radii: [0, 0, 0, 0], corner: 'round' } },
      pathOffset: 0,
      appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0, 0, 0] }, opacity: 1, blend: 'normal' }],
    })
    n.transform = [1, 0, 0, 1, 60, 40]
    const root = d.nodes[d.root]
    return { ...d, nodes: { ...d.nodes, typo: n, [d.root]: { ...root, children: [...root.children, 'typo'] } } }
  })
  globalThis.plexel.documents().select('typo')
}, WORDS)
await drawn()
await tap('[data-type-hyphenate]')
const brokenIn = () =>
  page.evaluate((words) => {
    const P = globalThis.plexel
    const d = P.documents().active().history.present
    const l = P.text.layoutOf(d.nodes.typo, d)
    const t = words + ' BLUE'
    return l ? l.lines.filter((ln, i) => i < l.lines.length - 1 && /\p{L}/u.test(t[ln.end - 1] ?? '') && /\p{L}/u.test(t[ln.end] ?? '')).length : -1
  }, WORDS)
const hyphenated = await waitUntil(page, (words) => {
  const P = globalThis.plexel
  const d = P.documents().active().history.present
  const l = P.text.layoutOf(d.nodes.typo, d)
  const t = words + ' BLUE'
  return !!l && l.lines.some((ln, i) => i < l.lines.length - 1 && /\p{L}/u.test(t[ln.end - 1] ?? '') && /\p{L}/u.test(t[ln.end] ?? ''))
}, { timeout: 8000, args: [WORDS] })
check('Hyphenate in the Paragraph panel: the language’s patterns load, and lines end inside words', (await label()) === 'Paragraph' && hyphenated, `${await brokenIn()} lines broken`)
await idle()
{
  // The blue run, drawn blue: its line's ink is blue where the black text's isn't.
  const box = await page.evaluate((words) => {
    const P = globalThis.plexel
    const d = P.documents().active().history.present
    const l = P.text.layoutOf(d.nodes.typo, d)
    const at = words.length + 2
    const line = l.lines.find((ln) => at >= ln.start && at < ln.end)
    return line ? { x0: line.boxes[at - line.start][0], x1: line.boxes[line.end - line.start - 1][1], top: line.top, bottom: line.bottom } : null
  }, WORDS)
  const img = await shot()
  const r = await rect()
  let blue = 0
  let black = 0
  if (box)
    for (let y = box.top; y < box.bottom; y += 2)
      for (let x = box.x0; x < box.x1; x += 2) {
        const c = pixelAt(img, Math.round(r.x + r.w / 2 + 60 + x - 400), Math.round(r.y + r.h / 2 + 40 + y - 300))
        if (c[2] > 150 && c[0] < 90 && c[1] < 90) blue++
        else if (c[0] + c[1] + c[2] < 150) black++
      }
  check('a run with its own fill is drawn in it, the rest in the text’s', blue > 40 && black < blue / 4, `${blue} blue, ${black} black`)
}
await clickMenu('Window', 'window.panel.glyphs')
await waitUntil(page, () => !!document.querySelector('[data-panel-body="glyphs"] [data-glyphs-grid]'), { timeout: 8000 })
const cells = await page.$eval('[data-glyphs-grid]', (e) => Number(e.getAttribute('data-glyphs-grid')))
check('the Glyphs panel shows every character of the font in use', cells > 1000, `${cells}`)
await press('KeyT')
await clickAt(150, 200)
await waitUntil(page, () => !!document.querySelector('[data-type-input]'), { timeout: 10000 })
await typed('X')
await drawn()
await page.$eval('[data-glyphs-grid] [data-glyph="65"]', (e) => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
await frames(page)
s = await selected()
check('double-clicking a glyph puts it in at the caret', s?.kind === 'text' && textOf(s) === 'XA', s && textOf(s))
await page.$eval('[data-glyphs-grid] [data-glyph="49"]', (e) => e.click())
await waitUntil(page, () => !!document.querySelector('[data-glyphs-alternates]'), { timeout: 4000 })
const alt = await page.$eval('[data-glyphs-alternates] [data-alternate]', (e) => e.getAttribute('data-alternate'))
await page.$eval('[data-glyphs-alternates] [data-alternate]', (e) => e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
await frames(page)
s = await selected()
const lastRun = s.props.content.paragraphs[0].runs.at(-1)
check('an alternate goes in with the feature that makes it, on that character', textOf(s) === 'XA1' && lastRun.text === '1' && (lastRun.props.features ?? []).includes(alt), JSON.stringify(s.props.content.paragraphs[0].runs.map((r) => [r.text, r.props.features])))
check('the panel keeps it among the recently used', !!(await page.$('[data-glyphs-recent] [data-glyph="65"]')))
await press('Escape')

// Dense text fitted on screen puts most of its glyphs in a few tiles: one tile's segments can outgrow the
// frame's storage ring (16 MB here, against 8), and must still be drawn rather than waited for forever.
console.log('\ndense text')
const dense = await page.evaluate(async () => {
  const P = globalThis.plexel
  const { createDoc, insertNode, makeNode } = P.doc
  const words = 'the quick brown fox jumps over a lazy dog while sphinxes of black quartz judge my vow'.split(' ')
  const paras = []
  let total = 0
  let k = 0
  while (total < 60000) {
    let t = ''
    while (t.length < 700) t += words[k++ % words.length] + ' '
    paras.push(t.trim() + '.')
    total += t.length
  }
  let doc = createDoc({ name: 'Dense', width: 6400, height: 8000, resolution: 300, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'dense-root')
  doc = insertNode(doc, makeNode('text', 'dense', 'Dense', { mode: 'area', content: { paragraphs: paras.map((text) => ({ runs: [{ text, style: null, props: { size: 22 } }], style: null, props: { align: 'justify' } })) }, frame: { kind: 'shape', shape: { type: 'rect', x: 600, y: 600, w: 5200, h: 6800, radii: [0, 0, 0, 0], corner: 'round' } }, pathOffset: 0, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0, 0, 0] }, opacity: 1, blend: 'normal' }] }), doc.root, 0)
  P.documents().add({ doc, file: null, saved: true })
  return Promise.race([P.engine().call('render.idle', {}).then(() => true), new Promise((r) => setTimeout(() => r(false), 60000))])
})
check('60,000 characters of area text, fitted on screen, are drawn to the last tile', dense)

// --- system fonts and the font menu -----------------------------------------------------------------
// A second page, after the browser has been given permission to list the system's fonts (as a user who
// once said yes has): the page lists them by itself.
console.log('\nsystem fonts and the font menu')
{
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['localFonts'] })
  const p2 = await browser.newPage()
  await p2.setViewport({ width: 1280, height: 900 })
  await p2.goto(url)
  await waitForEngine(p2)
  const listed = await p2.evaluate(async () => {
    const lib = await globalThis.plexel.text.startFonts()
    for (let i = 0; i < 50 && !lib.families().some((f) => f.styles[0].source === 'local'); i++) await new Promise((r) => setTimeout(r, 100))
    const local = lib.families().filter((f) => f.styles[0].source === 'local')
    const arial = local.find((f) => f.family === 'Arial')
    const pick = arial ?? local.find((f) => f.styles.some((x) => /^regular$/i.test(x.style))) ?? local[0]
    return { count: local.length, family: pick?.family ?? null, style: pick ? (pick.styles.find((x) => /^regular$/i.test(x.style)) ?? pick.styles[0]).style : null, arial: !!arial }
  })
  check('with permission given once, the system’s fonts are listed without a click', listed.count > 0, JSON.stringify(listed))
  if (listed.family) {
    // Text in a system font that hasn't been read yet: it loads, and nothing calls it missing meanwhile.
    const r = await p2.evaluate(async (family, style) => {
      const P = globalThis.plexel
      const { createDoc, insertNode, makeNode } = P.doc
      let doc = createDoc({ name: 'System', width: 800, height: 600, resolution: 72, mode: 'rgb', depth: 8, profile: { builtin: 'srgb' } }, 'sys-root')
      doc = insertNode(doc, makeNode('text', 'sys', 'System', { mode: 'point', content: { paragraphs: [{ runs: [{ text: 'System font', style: null, props: { font: family, style, size: 40 } }], style: null, props: {} }] }, frame: null, pathOffset: 0, appearance: [{ kind: 'fill', enabled: true, paint: { kind: 'solid', colour: [0, 0, 0] }, opacity: 1, blend: 'normal' }] }), doc.root, 0)
      P.documents().add({ doc, file: null, saved: true })
      const lib = await P.text.startFonts()
      for (let i = 0; i < 50 && lib.status(family, style) !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 600))
      const said = [...document.querySelectorAll('.notice')].some((n) => /isn’t available|aren’t available/.test(n.textContent))
      return { status: lib.status(family, style), said }
    }, listed.family, listed.style)
    check('a system font loading when text first asks for it is drawn, and not called missing', r.status === 'ready' && !r.said, JSON.stringify({ ...r, family: listed.family }))
  }
  if (listed.arial) {
    // A Photoshop file asking for ArialMT: found among the system's fonts as it opens.
    const runs = await p2.evaluate(async (b64) => {
      const P = globalThis.plexel
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      await P.files.openFile(new File([bytes], 'text.psd'), null)
      const doc = P.documents().active().history.present
      return Object.values(doc.nodes).filter((n) => n.kind === 'text').flatMap((n) => n.props.content.paragraphs.flatMap((p) => p.runs.map((x) => [x.props.font, x.props.style])))
    }, fs.readFileSync('scripts/fixtures/psd/text.psd').toString('base64'))
    check('a Photoshop file’s fonts are found by their PostScript names among the system’s', runs.length > 0 && runs.every(([font, style]) => font === 'Arial' && !!style), JSON.stringify(runs))
  }
  // The font menu.
  await p2.evaluate(() => globalThis.plexel.tools().set('type'))
  await p2.waitForSelector('#opt-type-font')
  await p2.click('#opt-type-font')
  await p2.waitForSelector('[data-font-list]')
  const rows = await p2.$$eval('[data-font-list] .font-row', (r) => r.length)
  const total = await p2.evaluate(() => globalThis.plexel.text.startFonts().then((l) => l.families().length))
  check('the font menu opens, drawing only the rows in view of every family', rows > 0 && rows < Math.max(total, 30) + 1, `${rows} of ${total}`)
  if (listed.family) {
    await p2.type('.font-list-search', listed.family)
    await p2.waitForSelector(`.font-row[data-font-family="${listed.family}"]`)
    const face = await p2.$eval(`.font-row[data-font-family="${listed.family}"] .font-row-name`, (e) => getComputedStyle(e).fontFamily)
    check('a search finds a family, its name drawn in its own face', face.includes(listed.family), face)
    await p2.click(`.font-row[data-font-family="${listed.family}"] .font-star`)
    await p2.click('[data-font-filter="favourites"]')
    await p2.click('.font-list-search', { clickCount: 3 })
    await p2.keyboard.press('Backspace')
    const favs = await p2.$$eval('[data-font-list] .font-row', (r) => r.map((x) => x.dataset.fontFamily))
    check('the star makes it a favourite, shown under ★', favs.length === 1 && favs[0] === listed.family, JSON.stringify(favs))
    await p2.keyboard.press('Enter')
    await p2.waitForFunction(() => !document.querySelector('[data-font-list]'))
    const picked = await p2.$eval('#opt-type-font', (e) => e.dataset.fontPicker)
    const recent = await p2.evaluate(() => JSON.parse(localStorage.getItem('plexel.fontMenu') ?? '{}').recent ?? [])
    check('Enter picks it, and it’s first among the recent', picked === listed.family && recent[0] === listed.family, JSON.stringify({ picked, recent }))
  }
  await p2.click('#opt-type-font')
  await p2.waitForSelector('[data-font-list]')
  await p2.keyboard.press('Escape')
  check('Esc closes the menu', await p2.waitForFunction(() => !document.querySelector('[data-font-list]')).then(() => true, () => false))
  await p2.close()
}

await finish()
