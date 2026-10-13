/**
 * The clipboard in Chrome, end to end, through Chrome's own clipboard:
 * copying pixels under a selection and pasting them back (in place, into
 * the selection, outside it, into another document in another mode),
 * cutting, Copy Merged, copying layers live (pixels, shapes, text), Layer
 * via Copy and Cut, Duplicate Layer, layer styles, paths with Direct
 * Selection, New from Clipboard, and pasting what other apps put there:
 * an image, SVG markup and plain text. A text field keeps its own
 * clipboard.
 *
 * Documents are 800 × 600 at 100%, so an offset from the canvas's centre
 * is one from the document's centre (400, 300).
 *
 * Run with: npm run check:clipboard
 */
import { check, finish, frames, open, settle, waitUntil, waitForEngine } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { browser, page, url } = await open({ viewport: { width: 1280, height: 860 } })
await browser.defaultBrowserContext().overridePermissions(new URL(url).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
await page.goto(url)
await waitForEngine(page)
await page.bringToFront()

// --- helpers ---------------------------------------------------------------------------
const press = async (combo) => {
  const keys = combo.split('+')
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k)
  await page.keyboard.press(keys[keys.length - 1])
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k)
  await frames(page)
}
/** Ctrl+V (with Shift, Ctrl+Shift+V) as Chrome does it: the key, then its paste. Headless Chrome needs telling to paste. */
const pasteKey = async (shift = false) => {
  await page.keyboard.down('Control')
  if (shift) await page.keyboard.down('Shift')
  await page.keyboard.press('KeyV', { commands: ['paste'] })
  if (shift) await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  await frames(page)
}
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
}
const rect = () => page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const at = async (dx, dy, img) => {
  const r = await rect()
  return pixelAt(img ?? (await shot()), Math.round(r.x + r.w / 2 + dx), Math.round(r.y + r.h / 2 + dy)).slice(0, 3)
}
const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const isChecker = (c) => near(c, [255, 255, 255]) || near(c, [204, 204, 204])
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const active = () => page.evaluate(() => { const d = globalThis.plexel.documents().active(); return { key: d.key, selected: d.selected } })
const stepIs = (label) => waitUntil(page, (l) => globalThis.plexel.documents().active()?.history.label === l, { args: [label], timeout: 8000 })
const stepCount = () => page.evaluate(() => globalThis.plexel.documents().active().history.labels.length)
/** The top-level layers, bottom first, with what the checks look at. */
const layers = async () => {
  const d = await doc()
  return (d.nodes[d.root].children ?? []).map((id) => d.nodes[id])
}
/** What a paste just put in: it's selected, above the layer that was (the top when none was). */
const pasted = async () => {
  const d = await doc()
  const key = await page.evaluate(() => globalThis.plexel.documents().active().selected)
  return d.nodes[key]
}
/** Where a pixel layer's pixels are in the document, [x0, y0, x1, y1). */
const pixelBounds = (id) =>
  page.evaluate(async (id) => {
    const d = globalThis.plexel.documents().active().history.present
    const n = d.nodes[id]
    if (!n?.props.tiles) return null
    const b = await globalThis.plexel.engine().call('tiles.alphaBounds', { set: n.props.tiles })
    const t = n.transform
    return b && [b[0] + t[4], b[1] + t[5], b[2] + t[4], b[3] + t[5]]
  }, id)
const drag = async (from, to, keys = []) => {
  const r = await rect()
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(cx + from[0], cy + from[1])
  await page.mouse.down()
  await page.mouse.move(cx + to[0], cy + to[1], { steps: 8 })
  await page.mouse.up()
  for (const k of keys.reverse()) await page.keyboard.up(k)
  await settle(100)
}
const clickAt = async (dx, dy) => {
  const r = await rect()
  await page.mouse.click(r.x + r.w / 2 + dx, r.y + r.h / 2 + dy)
  await settle(60)
}
const setForeground = async (r, g, b) => {
  await page.click('[data-model="rgb"]')
  for (const [label, v] of Object.entries({ R: r, G: g, B: b })) {
    await page.click(`.colour-number[data-channel="${label}"]`, { clickCount: 3 })
    await page.keyboard.type(String(v))
    await page.keyboard.press('Enter')
  }
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
  await page.click('.layer-row .layer-name')
  await press('Control+Digit1')
  await idle()
}
const selectLayer = async (id) => {
  await page.click(`.layer-row[data-layer="${id}"] .layer-name`)
  await frames(page)
}
/** The marquee round the red square, (200, 200) to (400, 400). */
const selectSquare = async () => {
  await press('KeyM')
  await drag([-200, -100], [0, 100])
  await stepIs('Rectangular Marquee')
}
const notice = (re) => waitUntil(page, (src) => [...document.querySelectorAll('.notice')].some((n) => new RegExp(src).test(n.textContent)), { args: [re.source], timeout: 3000 })
const dismissNotices = () => page.$$eval('.notice button', (bs) => bs.forEach((b) => b.click()))
/** What's on the system clipboard: its types, Plexel's marker, the PNG's size and middle colour, and the text. */
const system = () =>
  page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    const out = { types: [], marker: null, png: null, text: null }
    for (const it of items) {
      out.types.push(...it.types)
      if (it.types.includes('text/html')) out.marker = /name="plexel-clip"[^>]*content="([^"]+)"/.exec(await (await it.getType('text/html')).text())?.[1] ?? null
      if (it.types.includes('text/plain')) out.text = await (await it.getType('text/plain')).text()
      if (it.types.includes('image/png')) {
        const bmp = await createImageBitmap(await it.getType('image/png'))
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const g = c.getContext('2d')
        g.drawImage(bmp, 0, 0)
        out.png = { w: bmp.width, h: bmp.height, mid: [...g.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data] }
      }
    }
    return out
  })
/** Until the system clipboard holds a copy of Plexel's other than `before`. */
const copied = async (before) => {
  for (let i = 0; i < 60; i++) {
    const s = await system().catch(() => null)
    if (s?.marker && s.marker !== before) return s
    await settle(100)
  }
  return null
}
const RED = [255, 0, 0]
const BLUE = [0, 0, 255]

// --- pixels ------------------------------------------------------------------------------
console.log('\npixels')
await newDoc()
const bg = (await active()).selected
await setForeground(255, 0, 0)
await press('KeyM')
await drag([-200, -100], [0, 100])
await stepIs('Rectangular Marquee')
await press('Alt+Backspace')
await stepIs('Fill with Foreground')
await idle()

await press('Control+KeyC')
const c1 = await copied(null)
check('Ctrl+C with a selection puts the pixels on the system clipboard, as PNG and with the marker', !!c1 && c1.types.includes('image/png') && c1.types.includes('text/html') && !!c1.marker, JSON.stringify(c1?.types))
check('the PNG is what the selection covers, red', c1?.png?.w === 200 && c1?.png?.h === 200 && near(c1.png.mid.slice(0, 3), RED), JSON.stringify(c1?.png))
check('copying is no step', (await doc()).nodes[bg] && (await page.evaluate(() => globalThis.plexel.documents().active().history.label)) === 'Fill with Foreground')

await pasteKey()
check('Ctrl+V pastes, as a step', await stepIs('Paste'))
let ls = await layers()
const p1 = ls.at(-1)
check('as a new pixel layer above, named Layer 1, and selected', ls.length === 2 && p1.kind === 'pixel' && p1.name === 'Layer 1' && (await active()).selected === p1.id, ls.map((l) => l.name).join())
check('centred on the selection, which is where it came from', JSON.stringify(await pixelBounds(p1.id)) === '[200,200,400,400]', JSON.stringify(await pixelBounds(p1.id)))
check('and the selection is dropped, as Photoshop does', (await doc()).selection === null)

await pasteKey()
await waitUntil(page, () => globalThis.plexel.documents().active().history.present.nodes[globalThis.plexel.documents().active().history.present.root].children.length === 3)
ls = await layers()
check('pasted again with nothing selected and its place in view, it goes in place', ls.at(-1).name === 'Layer 2' && JSON.stringify(await pixelBounds(ls.at(-1).id)) === '[200,200,400,400]')
await press('Control+KeyZ')
await press('Control+KeyZ')
check('Undo takes pastes back', (await layers()).length === 1)

// Pasted elsewhere: a selection somewhere else centres it there.
await press('Control+Shift+KeyD')
await stepIs('Reselect')
await press('KeyM')
await drag([100, 100], [300, 200])
await stepIs('Rectangular Marquee')
await pasteKey()
await stepIs('Paste')
ls = await layers()
check('with a selection elsewhere, Paste centres on it', JSON.stringify(await pixelBounds(ls.at(-1).id)) === '[500,350,700,550]', JSON.stringify(await pixelBounds(ls.at(-1).id)))
await press('Control+KeyZ')

await pasteKey(true)
check('Ctrl+Shift+V pastes in place', (await stepIs('Paste in Place')) && JSON.stringify(await pixelBounds((await layers()).at(-1).id)) === '[200,200,400,400]')
await press('Control+KeyZ')

// Paste Into and Outside: masked by the selection.
await press('Control+Alt+Shift+KeyV')
check('Ctrl+Alt+Shift+V pastes into the selection', await stepIs('Paste Into'))
ls = await layers()
let into = (await doc()).nodes
check('as a layer with a mask that reveals the selection, the selection gone', ls.at(-1).masks.length === 1 && into[ls.at(-1).masks[0]].props.outside === 0 && !!into[ls.at(-1).masks[0]].props.tiles && (await doc()).selection === null)
await press('Control+KeyZ')
await clickMenu('Edit', 'edit.paste-outside', 'Paste Special')
check('Paste Outside, from the menu', await stepIs('Paste Outside'))
into = (await doc()).nodes
ls = await layers()
check('masks the selection out', ls.at(-1).masks.length === 1 && into[ls.at(-1).masks[0]].props.outside === 1)
await press('Control+KeyZ')
await press('Control+KeyD')

// --- cut, merged -------------------------------------------------------------------------
console.log('\ncut and Copy Merged')
await selectLayer(bg)
await selectSquare()
const before1 = (await system()).marker
await press('Control+KeyX')
check('Ctrl+X cuts: copies, then clears what the selection covers', await stepIs('Cut'))
await idle()
check('the cut area is empty now', isChecker(await at(-100, 0)), JSON.stringify(await at(-100, 0)))
const c2 = await copied(before1)
check('and what was cut is on the clipboard', c2.png?.w === 200 && near(c2.png.mid.slice(0, 3), RED))
await pasteKey()
await stepIs('Paste')
await idle()
check('pasting it puts it back where it was', near(await at(-100, 0), RED))
await press('Control+KeyZ')
await press('Control+KeyZ')
await idle()
check('and Undo brings the cut pixels back', near(await at(-100, 0), RED))

// A blue layer over half the red: Copy Merged sees both, Copy only the layer.
await page.evaluate(() => {
  const { documents, doc } = globalThis.plexel
  const d = documents().active()
  return globalThis.plexel.engine().call('tiles.fill', { format: { mode: 'rgb', depth: 8 }, width: 300, height: 600, value: [0, 0, 255, 255] }).then((set) => {
    const n = doc.makeNode('pixel', 'blue', 'Blue', { tiles: set })
    documents().commit((x) => doc.insertNode(x, n, x.root, x.nodes[x.root].children.length), { key: d.key, label: 'Blue' })
  })
})
await idle()
const before2 = (await system()).marker
await press('Control+Alt+Shift+KeyC')
const merged = await copied(before2)
check('Copy Merged (Ctrl+Alt+Shift+C) copies everything that shows under the selection', merged?.png?.w === 200 && near(merged.png.mid.slice(0, 3), BLUE, 6), JSON.stringify(merged?.png))
await pasteKey()
await stepIs('Paste')
check('which pastes as one layer of it', JSON.stringify(await pixelBounds((await pasted()).id)) === '[200,200,400,400]')
await press('Control+KeyZ')

// --- layers ---------------------------------------------------------------------------------
console.log('\nlayers')
await press('Control+KeyD')
await selectLayer(bg)
const before3 = (await system()).marker
await press('Control+KeyC')
const c3 = await copied(before3)
check('Ctrl+C with no selection copies the layer, and puts its picture out', !!c3 && c3.png?.w === 800 && c3.png?.h === 600, JSON.stringify(c3?.png))
await pasteKey()
await stepIs('Paste')
ls = await layers()
const dup = ls.filter((l) => l.name === 'Background')
check('it pastes as the layer, live, just above it: its name and its pixels, the same set', dup.length === 2 && ls[1] === dup[1] && dup[1].props.tiles === dup[0].props.tiles && dup[1].id !== dup[0].id, ls.map((l) => l.name).join())
await press('Control+KeyZ')

// A shape with a mask and an effect, copied and pasted live.
await page.evaluate(() => {
  const { documents, doc } = globalThis.plexel
  const d = documents().active()
  const a = (x, y) => ({ p: [x, y], in: null, out: null, smooth: false })
  const n = doc.makeNode('vector', 'shape', 'Shape', {
    geometry: { kind: 'path', path: { fillRule: 'nonzero', subpaths: [{ closed: true, anchors: [a(500, 100), a(700, 100), a(700, 250), a(500, 250)] }] } },
    appearance: [{ kind: 'fill', enabled: true, opacity: 1, blend: 'normal', paint: { kind: 'solid', colour: [0, 0.5, 0] } }],
  })
  documents().commit((x) => doc.setFx(doc.insertNode(x, n, x.root, x.nodes[x.root].children.length), 'shape', [{ kind: 'drop-shadow', enabled: true, params: {} }]), { key: d.key, label: 'Shape' })
  documents().select('shape', d.key)
})
await frames(page)
const before4 = (await system()).marker
await press('Control+KeyC')
await copied(before4)
await pasteKey()
await stepIs('Paste')
ls = await layers()
const pastedShape = ls.at(-1)
check('a shape pastes as a shape, with its path and effects', pastedShape.kind === 'vector' && pastedShape.id !== 'shape' && JSON.stringify(pastedShape.props.geometry) === JSON.stringify((await doc()).nodes.shape.props.geometry) && pastedShape.fx.length === 1)
check('in place, since it’s in view', JSON.stringify(pastedShape.transform) === '[1,0,0,1,0,0]')
await press('Control+KeyZ')

// Duplicate Layer, Layer via Copy and Cut.
await selectLayer('shape')
await press('Control+KeyJ')
check('Ctrl+J with nothing selected duplicates the layer', await stepIs('Duplicate Layer'))
ls = await layers()
check('named “Shape copy”, above it, selected', ls.at(-1).name === 'Shape copy' && (await active()).selected === ls.at(-1).id)
await press('Control+KeyJ')
await stepIs('Duplicate Layer')
check('and again, “Shape copy 2”', (await layers()).at(-1).name === 'Shape copy 2')
await press('Control+KeyZ')
await press('Control+KeyZ')

await selectLayer(bg)
await selectSquare()
await press('Control+KeyJ')
check('Ctrl+J with a selection is Layer via Copy', await stepIs('Layer via Copy'))
ls = await layers()
const via = ls.find((l) => l.name === 'Layer 1')
check('the selected pixels on a new layer, in place, above the one they came from', !!via && ls.indexOf(via) === ls.findIndex((l) => l.id === bg) + 1 && JSON.stringify(await pixelBounds(via.id)) === '[200,200,400,400]', ls.map((l) => l.name).join())
await press('Control+KeyZ')
await selectLayer(bg)
await selectSquare()
const bgTiles = (await doc()).nodes[bg].props.tiles
await clickMenu('Layer', 'layer.via-cut')
check('Layer via Cut takes them out of the layer as it makes the new one', await stepIs('Layer via Cut'))
ls = await layers()
const cutLayer = ls.find((l) => l.name === 'Layer 1')
check('the source’s pixels change, and the new layer has them', (await doc()).nodes[bg].props.tiles !== bgTiles && !!cutLayer && JSON.stringify(await pixelBounds(cutLayer.id)) === '[200,200,400,400]')
await press('Control+KeyZ')
await press('Control+KeyD')

// Layer styles.
await selectLayer('shape')
await clickMenu('Layer', 'layer.copy-style')
await selectLayer('blue')
await clickMenu('Layer', 'layer.paste-style')
check('Copy and Paste Layer Style take the effects across', (await stepIs('Paste Layer Style')) && (await doc()).nodes.blue.fx[0]?.kind === 'drop-shadow')
await press('Control+KeyZ')

// --- paths --------------------------------------------------------------------------------
console.log('\npaths')
await selectLayer('shape')
await press('KeyA')
// The shape's corner (500, 100) is (100, -200) from the centre.
await clickAt(100, -200)
const before5 = (await system()).marker
await press('Control+KeyC')
const c5 = await copied(before5)
check('with Direct Selection and an anchor selected, Ctrl+C copies its path, as SVG for other apps', !!c5 && /^<svg[^>]*><path d="M ?500[ ,]100/.test(c5.text ?? ''), c5?.text?.slice(0, 80))
await pasteKey()
check('Ctrl+V adds the path to the shape, in place', await stepIs('Paste Path'))
check('so it has two now', (await doc()).nodes.shape.props.geometry.path.subpaths.length === 2)
await press('Control+KeyZ')
await press('KeyV')
await selectLayer(bg)
await pasteKey()
await stepIs('Paste Path')
ls = await layers()
check('pasted with another tool, it’s a new shape', ls.at(-1).kind === 'vector' && ls.at(-1).props.geometry.path.subpaths.length === 1)
await press('Control+KeyZ')

// --- from other apps ---------------------------------------------------------------------
console.log('\nfrom other apps')
await page.evaluate(async () => {
  const c = new OffscreenCanvas(30, 20)
  const g = c.getContext('2d')
  g.fillStyle = '#0000ff'
  g.fillRect(0, 0, 30, 20)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': await c.convertToBlob({ type: 'image/png' }) })])
})
await pasteKey()
check('an image from another app pastes as a pixel layer', await stepIs('Paste'))
ls = await layers()
const v = await page.evaluate(() => globalThis.plexel.views().front())
const ib = await pixelBounds((await pasted()).id)
check('its size, in the middle of the view', !!ib && ib[2] - ib[0] === 30 && ib[3] - ib[1] === 20 && Math.abs((ib[0] + ib[2]) / 2 - v.cx) <= 1 && Math.abs((ib[1] + ib[3]) / 2 - v.cy) <= 1, JSON.stringify(ib))
await press('Control+KeyZ')

await page.evaluate(() => navigator.clipboard.writeText('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#00ff00"/></svg>'))
await pasteKey()
check('SVG markup pastes as shapes', await stepIs('Paste'))
ls = await layers()
check('a vector layer of it', ls.slice(-1).some((l) => l.kind === 'vector' || l.kind === 'group'), ls.slice(-1).map((l) => l.kind).join())
await press('Control+KeyZ')

await page.evaluate(() => navigator.clipboard.writeText('Hello from elsewhere'))
await pasteKey()
check('plain text pastes as a text layer', await stepIs('Paste'))
ls = await layers()
const tl = await pasted()
check('named for its words, holding them', tl.kind === 'text' && tl.name === 'Hello from elsewhere' && tl.props.content.paragraphs[0].runs.map((r) => r.text).join('') === 'Hello from elsewhere')
const before6 = (await system()).marker
await press('Control+KeyC')
const c6 = await copied(before6)
check('copying a text layer gives other apps its words', c6?.text === 'Hello from elsewhere')
await press('Control+KeyZ')

// The menu reads the clipboard itself (the browser asks; here it's allowed).
await page.evaluate(() => navigator.clipboard.writeText('From the menu'))
await clickMenu('Edit', 'edit.paste')
check('Edit → Paste reads the clipboard', (await stepIs('Paste')) && (await pasted()).name === 'From the menu')
await press('Control+KeyZ')

// --- another document, another mode ----------------------------------------------------------
console.log('\nanother document')
await selectLayer(bg)
await selectSquare()
const before7 = (await system()).marker
await press('Control+KeyC')
await copied(before7)
await press('Control+KeyD')
const first = (await active()).key
await page.evaluate(() => {
  const { documents, doc } = globalThis.plexel
  const d = doc.createDoc({ name: 'Press', width: 400, height: 300, resolution: 300, mode: 'cmyk', depth: 16, profile: { builtin: 'generic-cmyk' } }, 'press-root')
  documents().add({ doc: d, file: null, saved: false })
})
await idle()
await pasteKey()
check('pixels paste into another document', await stepIs('Paste'))
const cm = await page.evaluate(async () => {
  const d = globalThis.plexel.documents().active().history.present
  const n = d.nodes[d.nodes[d.root].children.at(-1)]
  const desc = await globalThis.plexel.engine().call('tiles.describe', { ids: [n.props.tiles] })
  return { mode: d.mode, kind: n.kind, desc: desc[n.props.tiles] }
})
check('converted into its mode and depth (CMYK, 16 bits)', cm.mode === 'cmyk' && cm.kind === 'pixel' && cm.desc?.kind !== 'missing', JSON.stringify(cm))
await idle()
// (300, 250) in a 400 × 300 document is (100, 100) from its centre.
const pr = await at(100, 100)
check('and still red on screen', pr[0] > 180 && pr[1] < 90 && pr[2] < 90, JSON.stringify(pr))
await page.evaluate((k) => globalThis.plexel.documents().activate(k), first)
await idle()

// --- New from Clipboard; a text field's own clipboard ------------------------------------------
console.log('\nNew from Clipboard and text fields')
await clickMenu('File', 'file.new-from-clipboard')
await waitUntil(page, () => globalThis.plexel.documents().active()?.history.present.name === 'Untitled' && globalThis.plexel.documents().active()?.history.present.width === 200)
const nd = await doc()
check('File → New from Clipboard makes a document the copy’s size, with it in', nd.width === 200 && nd.height === 200 && (nd.nodes[nd.root].children ?? []).length === 1)
await page.evaluate((k) => globalThis.plexel.documents().activate(k), first)
await frames(page)

const steps0 = await stepCount()
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
await page.evaluate(() => navigator.clipboard.writeText('Pasted name'))
await page.click('#new-name', { clickCount: 3 })
await pasteKey()
check('in a text field, Ctrl+V pastes text into it, not a layer', (await page.$eval('#new-name', (e) => e.value)) === 'Pasted name')
await page.keyboard.press('Escape')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
check('and the document is untouched', (await stepCount()) === steps0)

// --- nothing to copy -------------------------------------------------------------------------
await dismissNotices()
await press('Control+KeyD')
await page.evaluate(() => globalThis.plexel.documents().select(null))
await frames(page)
const before8 = (await system()).marker
await press('Control+KeyC')
await settle(300)
check('with nothing to copy, the clipboard is left alone', (await system()).marker === before8)
const ok = !(await notice(/didn’t work/))
check('and nothing went wrong on the way', ok)

await finish()
