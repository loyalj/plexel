/**
 * Working with many layers, in Chrome: shapes drawn with a group selected
 * going into it (at its top, or above the layer selected in it) and named
 * after it; Rasterize on a group making every shape in it a pixel layer of
 * its own, in one step; dragging several selected layers in the Layers
 * panel moving them all, and a click on one of them selecting it alone;
 * Merge Layers making the selected layers one pixel layer. Then the
 * panel's menu and Draw Into's pin; a new layer above the topmost of
 * several selected; numbers not given twice; a folded group opening for a
 * new layer (and staying folded when folded again); Select All in Group;
 * Group and Ungroup; Move to Group; Alt-drag copying; Merge Down, Merge
 * Group, Merge Visible and Stamp Visible; Combine into One Shape; colour
 * labels, taken by new layers; Rename Layers; Collapse All; a drag opening
 * a folded group it rests on, and scrolling a long list.
 *
 * Run with: npm run check:layers
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'
import { decodePng, pixelAt } from './png.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)
const { press, idle } = pageHelpers(page)

const openMenu = async (menu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
}
const run = async (menu, command) => {
  await openMenu(menu)
  await page.click(`[data-command="${command}"]`)
  await frames(page)
}
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const label = () => page.evaluate(() => globalThis.plexel.documents().active().history.label)
const steps = () => page.evaluate(() => globalThis.plexel.documents().active().history.past.length)
const stepIs = (l, timeout = 8000) => waitUntil(page, (x) => globalThis.plexel.documents().active().history.label === x, { args: [l], timeout }).then(() => true, () => false)
const selected = () => page.evaluate(() => {
  const d = globalThis.plexel.documents().active()
  return [d.selected, ...d.others].filter(Boolean).sort()
})
const select = (id) => page.evaluate((i) => globalThis.plexel.documents().select(i), id)
const screenOf = (x, y) => page.evaluate((x, y) => {
  const v = globalThis.plexel.views().front()
  const r = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
  return [r.left + r.width / 2 + (x - v.cx) * v.zoom, r.top + r.height / 2 + (y - v.cy) * v.zoom]
}, x, y)
const shot = async () => decodePng(Buffer.from(await page.screenshot()))
const dark = async (x, y, img) => {
  const [sx, sy] = await screenOf(x, y)
  return pixelAt(img, Math.round(sx), Math.round(sy)).slice(0, 3).every((v) => v < 100)
}
/** A Pencil stroke across the document at height `y`, from x 150 to 450. */
const line = async (y) => {
  const pts = Array.from({ length: 16 }, (_, i) => [150 + i * 20, y])
  const a = await screenOf(...pts[0])
  await page.mouse.move(a[0], a[1])
  await page.mouse.down()
  for (const p of pts.slice(1)) await page.mouse.move(...(await screenOf(...p)), { steps: 2 })
  await page.mouse.up()
  await settle(120)
}
const rowOf = (id) => page.$eval(`.layer-row[data-layer="${id}"]`, (e) => { const b = e.getBoundingClientRect(); return { x: b.x + 120, y: b.y, h: b.height } })

// --- a document with a group ------------------------------------------------------------------
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
await run('Layer', 'layer.new-group')
const group = await page.evaluate(() => globalThis.plexel.documents().active().selected)
await page.evaluate((g) => globalThis.plexel.documents().commit((x) => ({ ...x, nodes: { ...x.nodes, [g]: { ...x.nodes[g], name: 'Home' } } })), group)
await frames(page)

console.log('\nshapes drawn with a group selected')
await page.evaluate(() => globalThis.plexel.tools().set('pencil'))
await select(group)
await line(100)
await line(200)
let d = await doc()
let kids = d.nodes[group].children
check('a shape drawn with a group selected goes into it', kids.length === 2 && kids.every((k) => d.nodes[k].kind === 'vector'), String(kids.length))
check('each at the group’s top', d.nodes[kids[1]].props.geometry.path.subpaths[0].anchors[0].p[1] > 150)
check('named after the group', d.nodes[kids[0]].name === 'Home 1' && d.nodes[kids[1]].name === 'Home 2', kids.map((k) => d.nodes[k].name).join())
await select(kids[0])
await line(300)
d = await doc()
const [h1, h3, h2] = d.nodes[group].children
check('with a layer in the group selected, the new one goes just above it', d.nodes[group].children.length === 3 && d.nodes[h3].name === 'Home 3' && d.nodes[h1].name === 'Home 1' && d.nodes[h2].name === 'Home 2', d.nodes[group].children.map((k) => d.nodes[k].name).join())

console.log('\nRasterize on a group')
await select(group)
await page.evaluate(() => globalThis.plexel.tools().set('move'))
const before = await steps()
await run('Layer', 'layer.rasterize')
check('one step', (await stepIs('Rasterize Layers')) && (await steps()) === before + 1, await label())
d = await doc()
check('every shape in the group is a pixel layer of its own, in its place', d.nodes[group].children.join() === [h1, h3, h2].join() && [h1, h2, h3].every((k) => d.nodes[k].kind === 'pixel' && d.nodes[k].props.tiles))
check('their names kept', d.nodes[h1].name === 'Home 1' && d.nodes[h3].name === 'Home 3')
await idle()
let img = await shot()
check('they look as they did', (await dark(300, 100, img)) && (await dark(300, 200, img)) && (await dark(300, 300, img)))
await select(group)
await run('Layer', 'layer.rasterize')
await frames(page)
check('again, there’s nothing to rasterize and nothing changes', (await steps()) === before + 1)

console.log('\ndragging several layers')
await page.click(`.layer-row[data-layer="${h1}"] .layer-name`)
await page.keyboard.down('Control')
await page.click(`.layer-row[data-layer="${h2}"] .layer-name`)
await page.keyboard.up('Control')
await frames(page)
check('two layers selected', (await selected()).join() === [h1, h2].sort().join())
const bottom = d.nodes[d.root].children[0]
const from = await rowOf(h2)
const to = await rowOf(bottom)
await page.mouse.move(from.x, from.y + from.h / 2)
await page.mouse.down()
await page.mouse.move(to.x, to.y + to.h * 0.9, { steps: 8 })
await frames(page)
const drag = await page.$eval('[data-drag-label]', (e) => e.textContent).catch(() => '')
check('the label says how many', /2 layers/.test(drag), drag)
check('both rows are carried', (await page.$$eval('.layer-row.carried', (r) => r.length)) === 2)
await page.mouse.up()
await frames(page)
d = await doc()
check('both move, in their order', d.nodes[d.root].children.slice(0, 2).join() === [h1, h2].join() && d.nodes[group].children.join() === h3, d.nodes[d.root].children.join())
check('as one step', (await label()) === 'Move Layers', await label())
check('and stay selected', (await selected()).join() === [h1, h2].sort().join())
await page.click(`.layer-row[data-layer="${h1}"] .layer-name`)
await frames(page)
check('a click on one of them, without a drag, selects it alone', (await selected()).join() === h1)

console.log('\nMerge Layers')
await page.keyboard.down('Control')
await page.click(`.layer-row[data-layer="${h2}"] .layer-name`)
await page.click(`.layer-row[data-layer="${h3}"] .layer-name`)
await page.keyboard.up('Control')
await frames(page)
const had = new Set(Object.keys((await doc()).nodes))
await press('Control+KeyE')
check('Ctrl+E merges them, one step', await stepIs('Merge Layers'))
d = await doc()
const merged = Object.values(d.nodes).filter((n) => n.kind === 'pixel' && !had.has(n.id))
check('into one pixel layer, the others gone', merged.length === 1 && ![h1, h2, h3].some((k) => d.nodes[k]), String(merged.length))
check('in the top one’s place, with its name', d.nodes[group].children.join() === merged[0]?.id && merged[0]?.name === 'Home 3')
check('and selected', (await selected()).join() === merged[0]?.id)
await idle()
img = await shot()
check('with all of their pixels', (await dark(300, 100, img)) && (await dark(300, 200, img)) && (await dark(300, 300, img)))
await press('Control+KeyZ')
await frames(page)
d = await doc()
check('Undo brings the three back', [h1, h2, h3].every((k) => d.nodes[k]?.kind === 'pixel'))

// --- a second document: the many-layer workflow ----------------------------------------------
const named = (id) => page.evaluate((i) => globalThis.plexel.documents().active().history.present.nodes[i]?.name, id)
const kidsOf = async (id) => (await doc()).nodes[id]?.children ?? []
const menuAt = async (id) => {
  const r = await rowOf(id)
  await page.mouse.click(r.x, r.y + r.h / 2, { button: 'right' })
  await frames(page)
}
const menuHas = (command) => page.$(`.context-menu [data-command="${command}"]`).then((x) => !!x)
const pickMenu = async (command) => {
  await page.click(`.context-menu [data-command="${command}"]`)
  await frames(page)
}
const clickRow = async (id, mods = []) => {
  for (const k of mods) await page.keyboard.down(k)
  await page.click(`.layer-row[data-layer="${id}"] .layer-name`)
  for (const k of [...mods].reverse()) await page.keyboard.up(k)
  await frames(page)
}
const draw = async (y) => {
  await page.evaluate(() => globalThis.plexel.tools().set('pencil'))
  const had = new Set(Object.keys((await doc()).nodes))
  await line(y)
  return Object.values((await doc()).nodes).find((n) => !had.has(n.id) && n.kind === 'vector')?.id
}

await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
const bg = (await doc()).nodes[(await doc()).root].children[0]
await run('Layer', 'layer.new-group')
const home = await page.evaluate(() => globalThis.plexel.documents().active().selected)
await page.evaluate((g) => globalThis.plexel.documents().commit((x) => ({ ...x, nodes: { ...x.nodes, [g]: { ...x.nodes[g], name: 'Home' } } })), home)
await frames(page)

console.log('\nDraw Into')
await menuAt(home)
check('right-clicking a group opens the panel’s menu, with Draw Into', await menuHas('layer.draw-into'))
await pickMenu('layer.draw-into')
check('the group shows a pin', !!(await page.$(`.layer-row[data-layer="${home}"] [data-pinned]`)))
await clickRow(bg)
const a1 = await draw(100)
check('with another layer selected, a new shape still goes into the pinned group', (await kidsOf(home)).includes(a1) && (await named(a1)) === 'Home 1', await named(a1))
const a2 = await draw(200)
const a3 = await draw(300)
check('and the next ones on top of it', (await kidsOf(home)).join() === [a1, a2, a3].join())
await page.click(`.layer-row[data-layer="${home}"] [data-pinned]`)
await frames(page)
check('a click on the pin unpins it', !(await page.$('[data-pinned]')) && (await page.evaluate(() => globalThis.plexel.documents().active().drawInto)) === null)

console.log('\nnumbers and places')
await clickRow(a3)
await press('Delete')
await frames(page)
await clickRow(a2)
const a4 = await draw(300)
check('a number freed by a deletion isn’t given again', (await named(a4)) === 'Home 4', await named(a4))
await clickRow(a1)
await clickRow(a4, ['Control'])
const a5 = await draw(400)
check('with several selected, a new layer goes above the topmost', (await kidsOf(home)).at(-1) === a5, (await kidsOf(home)).map((k) => k).join())

console.log('\nfolded groups')
await page.click(`.layer-row[data-layer="${home}"] .layer-fold`)
await frames(page)
await clickRow(home)
const a6 = await draw(450)
check('a new layer opens the folded group it goes into', !!(await page.$(`.layer-row[data-layer="${a6}"]`)))
await page.click(`.layer-row[data-layer="${home}"] .layer-fold`)
await frames(page)
await clickRow(home)
const a7 = await draw(480)
check('folded again by hand, it stays folded', !(await page.$(`.layer-row[data-layer="${a7}"]`)) && (await kidsOf(home)).includes(a7))
await page.click(`.layer-row[data-layer="${home}"] .layer-fold`, { modifiers: [] })
await frames(page)

console.log('\nselecting, grouping, moving')
await page.keyboard.down('Control')
await page.click(`.layer-row[data-layer="${home}"] .layer-fold`)
await page.keyboard.up('Control')
await frames(page)
check('Ctrl-click on a group’s arrow selects every layer in it', (await selected()).join() === [...(await kidsOf(home))].sort().join())
await clickRow(a1)
await clickRow(a2, ['Control'])
await press('Control+KeyG')
let g2 = await page.evaluate(() => globalThis.plexel.documents().active().selected)
check('Ctrl+G groups the selected layers, and selects the group', (await doc()).nodes[g2]?.kind === 'group' && (await kidsOf(g2)).join() === [a1, a2].join() && (await kidsOf(home)).includes(g2))
await press('Control+Shift+KeyG')
check('Ctrl+Shift+G lets them out again, selected', !(await doc()).nodes[g2] && (await selected()).join() === [a1, a2].sort().join())
await clickRow(a1)
await run('Layer', 'layer.move-to-group')
await page.waitForSelector('[data-dialog="moveToGroup"]')
await page.keyboard.type('top')
await page.keyboard.press('Enter')
await frames(page)
check('Move to Group: type, Enter, and it’s there', (await kidsOf((await doc()).root)).includes(a1) && (await selected()).join() === a1)

console.log('\ncopying by dragging')
{
  const from = await rowOf(a1)
  const to = await rowOf(home)
  await page.keyboard.down('Alt')
  await page.mouse.move(from.x, from.y + from.h / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y + to.h / 2, { steps: 8 })
  await frames(page)
  const label = await page.$eval('[data-drag-label]', (e) => e.textContent).catch(() => '')
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await frames(page)
  const copy = (await kidsOf(home)).at(-1)
  check('Alt-drag says it copies', /^Copy /.test(label), label)
  check('and copies into the group, the layer kept', copy !== a1 && (await named(copy)) === 'Home 1 copy' && !!(await doc()).nodes[a1])
}

console.log('\nmerging')
await clickRow(a5)
const down = await page.evaluate(() => {
  const c = globalThis.plexel.documents().active()
  const p = c.history.present
  const kids = p.nodes[Object.values(p.nodes).find((n) => n.children?.includes(c.selected)).id].children
  return p.nodes[kids[kids.indexOf(c.selected) - 1]].name
})
await press('Control+KeyE')
check('Ctrl+E on one layer merges it down, named after the one below', (await stepIs('Merge Down')) && (await named(await page.evaluate(() => globalThis.plexel.documents().active().selected))) === down)
await clickRow(home)
await openMenu('Layer')
const mergeLabel = await page.$eval('[data-command="layer.merge"]', (e) => e.textContent)
await page.keyboard.press('Escape')
await frames(page)
check('with a group selected the menu says Merge Group', /Merge Group/.test(mergeLabel), mergeLabel)
await press('Control+KeyE')
check('Ctrl+E on a group makes it one layer, named after it', (await stepIs('Merge Group')) && (await named(await page.evaluate(() => globalThis.plexel.documents().active().selected))) === 'Home')
await press('Control+KeyZ')
await press('Control+Alt+Shift+KeyE')
check('Stamp Visible adds a layer and keeps the rest', (await stepIs('Stamp Visible')) && !!(await doc()).nodes[home] && (await doc()).nodes[await page.evaluate(() => globalThis.plexel.documents().active().selected)].kind === 'pixel')
await press('Control+KeyZ')
const rootCount = (await kidsOf((await doc()).root)).length
await press('Control+Shift+KeyE')
check('Merge Visible makes the visible layers one', (await stepIs('Merge Visible')) && (await kidsOf((await doc()).root)).length === 1, `${rootCount} → ${(await kidsOf((await doc()).root)).length}`)
await press('Control+KeyZ')
await frames(page)

console.log('\nshapes, labels, names')
{
  const vecs = []
  for (const k of await kidsOf(home)) if ((await doc()).nodes[k]?.kind === 'vector') vecs.push(k)
  await clickRow(vecs[0])
  for (const k of vecs.slice(1)) await clickRow(k, ['Control'])
  await menuAt(vecs[0])
  await pickMenu('shape.combine-one')
  const one = await page.evaluate(() => globalThis.plexel.documents().active().selected)
  const after = await doc()
  const n = after.nodes[one]
  check('Combine into One Shape: one shape with every path, open strokes still open', n?.kind === 'vector' && n.props.geometry.path.subpaths.length >= vecs.length && n.props.geometry.path.subpaths.every((s) => !s.closed) && vecs.filter((k) => k !== one && after.nodes[k]).length === 0, `${vecs.length} shapes`)
  await press('Control+KeyZ')
}
await menuAt(home)
await pickMenu('layer.tag.green')
check('a colour label from the menu', (await doc()).nodes[home].tag === 'green' && !!(await page.$(`.layer-row[data-layer="${home}"][data-tag="green"]`)))
await clickRow(home)
const tagged = await draw(520)
check('a new layer in a labelled group takes its label', (await doc()).nodes[tagged].tag === 'green')
await page.keyboard.down('Control')
await page.click(`.layer-row[data-layer="${home}"] .layer-fold`)
await page.keyboard.up('Control')
await frames(page)
await run('Layer', 'layer.rename-many')
await page.waitForSelector('[data-dialog="renameLayers"]')
await page.click('#rename-pattern', { clickCount: 3 })
await page.keyboard.type('Window ##')
await page.click('[data-dialog="renameLayers"] .dialog-foot .primary')
await frames(page)
const names = await Promise.all((await kidsOf(home)).map(named))
check('Rename Layers numbers them from the bottom, in two digits', names[0] === 'Window 01' && names.at(-1) === `Window ${String(names.length).padStart(2, '0')}` && (await label()) === 'Rename Layers', names.join())

console.log('\nfolding and long lists')
await page.keyboard.down('Alt')
await page.click(`.layer-row[data-layer="${home}"] .layer-fold`)
await page.keyboard.up('Alt')
await frames(page)
check('Alt-click on an arrow folds every group', await page.evaluate((g) => globalThis.plexel.documents().active().folded.has(g), home))
{
  // The list at its top, so a drag near its top edge has nowhere to scroll it.
  await page.$eval('.layer-list', (e) => { for (let at = e; at; at = at.parentElement) at.scrollTop = 0 })
  await frames(page)
  await clickRow(bg)
  await settle(400)
  const atRest = (await rowOf(home)).y
  await page.mouse.move((await rowOf(bg)).x, (await rowOf(bg)).y + 14)
  await settle(400)
  check('hovering a row moves no panel', Math.abs((await rowOf(home)).y - atRest) < 1, `${atRest} → ${(await rowOf(home)).y}`)
  const from = await rowOf(bg)
  const to = await rowOf(home)
  await page.mouse.move(from.x, from.y + from.h / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y + to.h / 2, { steps: 8 })
  await settle(900)
  const opened = !(await page.evaluate((g) => globalThis.plexel.documents().active().folded.has(g), home))
  // The group opening takes room in the column: the panels hold still for the drag, the rows staying under the pointer.
  const still = Math.abs((await rowOf(home)).y - to.y) < 1
  await page.mouse.move(640, 840, { steps: 3 })
  await page.mouse.up()
  await frames(page)
  check('a drag resting on a folded group opens it', opened)
  check('and the rows don’t move under the pointer while it does', still)
  if ((await label()) !== 'Rename Layers') await press('Control+KeyZ')
}
// A long list: sixty layers, so the panel scrolls.
await page.evaluate(() => {
  const { documents, doc: D } = globalThis.plexel
  documents().commit((x) => {
    let y = x
    for (let i = 0; i < 60; i++) y = D.insertNode(y, D.makeNode('pixel', `long${i}`, `Long ${i}`), y.root, 0)
    return y
  })
})
await frames(page)
{
  const box = await page.evaluate(() => {
    let el = document.querySelector('.layer-list')
    while (el && !(getComputedStyle(el).overflowY === 'auto' || getComputedStyle(el).overflowY === 'scroll')) el = el.parentElement
    el.scrollTop = 0
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, x: r.left + 120 }
  })
  const first = await page.$eval('.layer-row[data-layer]', (e) => { const b = e.getBoundingClientRect(); return { y: b.y + b.height / 2 } })
  await page.mouse.move(box.x, first.y)
  await page.mouse.down()
  await page.mouse.move(box.x, box.bottom - 4, { steps: 8 })
  await settle(500)
  const scrolled = await page.evaluate(() => {
    let el = document.querySelector('.layer-list')
    while (el && !(getComputedStyle(el).overflowY === 'auto' || getComputedStyle(el).overflowY === 'scroll')) el = el.parentElement
    return el.scrollTop
  })
  await page.keyboard.press('Escape')
  await page.mouse.move(640, 840, { steps: 3 })
  await page.mouse.up()
  check('a drag near the list’s bottom edge scrolls it', scrolled > 40, String(scrolled))
}

await finish()
