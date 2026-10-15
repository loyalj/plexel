/**
 * Workflow in Chrome, through the real pointer and keys: picking layers on
 * the canvas with the Move tool (Ctrl-click, Auto-Select, Alt for the next
 * one down, Shift to add, Group); Previous Tool on `; Hold H for a bird's-
 * eye view; dragging a swatch onto a shape to fill or stroke it; and Split
 * View, its panes drawn, zoomed and drawn in on their own.
 *
 * Run with: npm run check:workflow
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 860 } })
await page.goto(url)
await waitForEngine(page)

// --- helpers ---------------------------------------------------------------------------
const { press } = pageHelpers(page)
const { idle } = pageHelpers(page)
const doc = () => page.evaluate(() => globalThis.plexel.documents().active().history.present)
const selected = () => page.evaluate(() => { const d = globalThis.plexel.documents().active(); return [d.selected, ...d.others] })
const tool = () => page.evaluate(() => globalThis.plexel.tools().get())
const view = () => page.evaluate(() => globalThis.plexel.views().front())
/** The page point over document point (x, y), through the active pane's view, as the engine draws it. */
const pt = (x, y) =>
  page.evaluate(
    (px, py) => {
      const e = globalThis.plexel.engine()
      const v = globalThis.plexel.views().front()
      const c = e.canvasSize()
      const pane = e.panes()[e.activePane()]
      const r = document.querySelector('[data-engine-canvas]').getBoundingClientRect()
      const s = v.zoom * c.dpr
      const t = (v.rotation * Math.PI) / 180
      const cos = Math.cos(t) * s
      const sin = Math.sin(t) * s
      let ex = c.width / 2 - (cos * v.cx - sin * v.cy)
      let fy = c.height / 2 - (sin * v.cx + cos * v.cy)
      if (v.rotation === 0) {
        ex = Math.round(ex)
        fy = Math.round(fy)
      }
      const k = r.width / e.fullCanvasSize().width
      return [r.x + (pane.x + cos * px - sin * py + ex) * k, r.y + (sin * px + cos * py + fy) * k]
    },
    x,
    y,
  )
const drag = async (from, to, keys = []) => {
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(120)
}
const click = async (at, keys = []) => {
  for (const k of keys) await page.keyboard.down(k)
  await page.mouse.click(...at)
  for (const k of [...keys].reverse()) await page.keyboard.up(k)
  await settle(150)
}
/** A rectangle drawn with the Shape tool, snapping let go, named. */
const rectangle = async (name, x0, y0, x1, y1) => {
  await press('KeyU')
  await drag(await pt(x0, y0), await pt(x1, y1), ['Control'])
  await waitUntil(page, () => globalThis.plexel.documents().active().history.label === 'New Shape')
  await page.evaluate((nm) => {
    const s = globalThis.plexel.documents()
    const d = s.active()
    s.commit((x) => ({ ...x, nodes: { ...x.nodes, [d.selected]: { ...x.nodes[d.selected], name: nm } } }), { label: 'Rename' })
  }, name)
  return page.evaluate(() => globalThis.plexel.documents().active().selected)
}

await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
for (const [id, v] of [['#new-width', 800], ['#new-height', 600]]) {
  await page.click(id, { clickCount: 3 })
  await page.keyboard.type(String(v))
}
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await press('Control+Digit1')
await idle()
await page.evaluate(() => globalThis.plexel.guidePrefs().update({ snap: false }))
await page.evaluate(() => globalThis.plexel.moveTool().update({ autoSelect: false, target: 'layer' }))

// --- picking layers on the canvas -----------------------------------------------------------
console.log('picking layers on the canvas')
const background = (await doc()).nodes[(await doc()).nodes[(await doc()).root].children[0]].id
const a = await rectangle('A', 100, 100, 300, 300)
const b = await rectangle('B', 200, 200, 400, 400)
await press('KeyV')
await page.evaluate((id) => globalThis.plexel.documents().select(id), background)
await click(await pt(150, 150), ['Control'])
check('Ctrl-click with the Move tool selects the layer under the pointer', (await selected())[0] === a, JSON.stringify(await selected()))
await click(await pt(250, 250), ['Control'])
check('the topmost where they overlap', (await selected())[0] === b)
await click(await pt(250, 250), ['Control', 'Alt'])
check('Alt goes one down: the layer under it', (await selected())[0] === a)
await click(await pt(250, 250), ['Control', 'Alt'])
check('and again, the one under that (the background’s pixels)', (await selected())[0] === background)
await click(await pt(250, 250), ['Control', 'Alt'])
check('round to the top again', (await selected())[0] === b)
await click(await pt(150, 150), ['Control', 'Shift'])
check('Shift adds the layer under the pointer to the selection', JSON.stringify((await selected()).sort()) === JSON.stringify([a, b].sort()))
await page.evaluate((id) => globalThis.plexel.documents().select(id), b)
await click(await pt(600, 500))
check('with Auto-Select off, a plain click doesn’t pick', (await selected())[0] === b)
await page.click('#opt-auto-select')
await frames(page)
check('the options bar turns Auto-Select on', await page.evaluate(() => globalThis.plexel.moveTool().get().autoSelect))
const before = JSON.stringify((await doc()).nodes[a].transform)
await drag(await pt(150, 150), await pt(170, 160))
check('then a press picks the layer under it, and the drag moves that layer', (await selected())[0] === a && JSON.stringify((await doc()).nodes[a].transform) !== before)
await press('Control+KeyZ')
await click(await pt(150, 150), ['Control'])
check('Ctrl lets go of Auto-Select for that press', (await selected())[0] === a)
await page.evaluate((id) => globalThis.plexel.documents().select(id), b)
// A group: Auto-Select set to pick groups picks the group holding it.
await page.evaluate(
  ({ a: ida }) => {
    const s = globalThis.plexel.documents()
    s.commit((x) => {
      const root = x.nodes[x.root]
      const g = globalThis.plexel.doc.makeNode('group', 'grp', 'Group')
      return { ...x, nodes: { ...x.nodes, grp: { ...g, children: [ida] }, [x.root]: { ...root, children: root.children.flatMap((c) => (c === ida ? ['grp'] : [c])) } } }
    })
  },
  { a },
)
await page.select('#opt-auto-target', 'group')
await click(await pt(150, 150))
check('Auto-Select set to Group picks the group holding the layer', (await selected())[0] === 'grp')
await page.select('#opt-auto-target', 'layer')
await click(await pt(150, 150))
check('set to Layer, the layer in it', (await selected())[0] === a)
await page.evaluate(() => globalThis.plexel.documents().commit((x) => x, {}))
await press('Control+KeyZ')
await page.click('#opt-auto-select')
await frames(page)

// --- the previous tool ------------------------------------------------------------------------
console.log('\nthe previous tool')
await press('KeyV')
await press('KeyB')
await press('Backquote')
check('` goes back to the tool before', (await tool()) === 'move')
await press('Backquote')
check('and again comes back', (await tool()) === 'brush')
await press('KeyV')

// --- the bird's-eye view ----------------------------------------------------------------------
console.log('\nthe bird’s-eye view')
await page.evaluate(() => globalThis.plexel.views().zoomTo(4))
await idle()
const zoomed = await view()
const canvasBox = await page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
await page.keyboard.down('KeyH')
await page.mouse.move(...canvasBox)
await page.mouse.down()
await frames(page)
const fitted = await view()
check('H held and a press shows the whole document', fitted.zoom < zoomed.zoom && Math.abs(fitted.cx - 400) < 1 && Math.abs(fitted.cy - 300) < 1, JSON.stringify(fitted))
const target = await pt(600, 150)
await page.mouse.move(...target, { steps: 5 })
await page.mouse.up()
await page.keyboard.up('KeyH')
await frames(page)
const back = await view()
check('let go, it zooms back in where the frame was', back.zoom === zoomed.zoom && Math.abs(back.cx - 600) < 2 && Math.abs(back.cy - 150) < 2, JSON.stringify(back))
await page.keyboard.down('KeyH')
await page.mouse.move(...canvasBox)
await page.mouse.down()
await frames(page)
await page.keyboard.press('Escape')
await page.mouse.up()
await page.keyboard.up('KeyH')
await frames(page)
check('Esc puts the view back as it was', JSON.stringify(await view()) === JSON.stringify(back))
await press('KeyV')
await press('Control+Digit1')
await idle()

// --- dropping a swatch on a shape -----------------------------------------------------------------
console.log('\ndropping a swatch on a shape')
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-command="window.panel.swatches"]')]
  return btn.length
})
if (!(await page.$('[data-swatch-index="3"]'))) {
  await page.evaluate(() => [...document.querySelectorAll('.menu-title')].find((x) => x.textContent === 'Window').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await frames(page)
  await page.click('[data-command="window.panel.swatches"]')
  await frames(page)
}
const chip = await page.$eval('[data-swatch-index="3"]', (e) => { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
const fillOf = async (id) => (await doc()).nodes[id].props.appearance.find((x) => x.kind === 'fill')?.paint
const strokeOf = async (id) => (await doc()).nodes[id].props.appearance.find((x) => x.kind === 'stroke')
const fill0 = JSON.stringify(await fillOf(b))
await drag(chip, await pt(350, 350))
await waitUntil(page, () => globalThis.plexel.documents().active().history.label === 'Fill with Swatch', { timeout: 3000 }).catch(() => {})
check('a swatch dropped on a shape fills it, as one step', JSON.stringify(await fillOf(b)) !== fill0 && (await doc()) && (await page.evaluate(() => globalThis.plexel.documents().active().history.label)) === 'Fill with Swatch')
check('the chip goes when the drag ends', !(await page.$('[data-colour-drag]')))
const hadStroke = !!(await strokeOf(b))
await drag(chip, await pt(350, 350), ['Shift'])
await waitUntil(page, () => globalThis.plexel.documents().active().history.label === 'Stroke with Swatch', { timeout: 3000 }).catch(() => {})
check('with Shift it strokes it (adding a stroke if it had none)', !hadStroke && !!(await strokeOf(b)) && JSON.stringify((await strokeOf(b)).paint) === JSON.stringify(await fillOf(b)))
const steps = await page.evaluate(() => globalThis.plexel.documents().active().history.past.length)
await drag(chip, await pt(700, 550))
check('dropped where there’s no shape, nothing changes', (await page.evaluate(() => globalThis.plexel.documents().active().history.past.length)) === steps)

// --- split view -------------------------------------------------------------------------------------
console.log('\nsplit view')
await page.evaluate(() => [...document.querySelectorAll('.menu-title')].find((x) => x.textContent === 'View').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
await frames(page)
await page.click('[data-command="view.split"]')
await idle()
const panes = await page.evaluate(() => globalThis.plexel.engine().panes())
check('View → Split View cuts the canvas in two', panes.length === 2 && panes[1].x > panes[0].width, JSON.stringify(panes))
const r0 = await page.$eval('[data-engine-canvas]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
// Over the right pane: it becomes the active one.
await page.mouse.move(r0.x + r0.w * 0.75, r0.y + r0.h / 2)
await frames(page)
check('the pane under the pointer is the active one', (await page.evaluate(() => globalThis.plexel.engine().activePane())) === 1)
const left0 = await page.evaluate(() => globalThis.plexel.views().panes(globalThis.plexel.documents().getState().active).views[0])
await page.keyboard.down('Control')
await page.mouse.wheel({ deltaY: -300 })
await page.keyboard.up('Control')
await frames(page)
const both = await page.evaluate(() => globalThis.plexel.views().panes(globalThis.plexel.documents().getState().active).views)
check('zooming there zooms that pane alone', both[1].zoom > 0.5 && JSON.stringify(both[0]) === JSON.stringify(left0), JSON.stringify(both))
await page.evaluate(() => globalThis.plexel.views().set(globalThis.plexel.documents().getState().active, { cx: 400, cy: 300, zoom: 0.5, rotation: 0 }))
await idle()
// The right pane draws the document: the white page in its middle.
const img = await page.screenshot()
const { decodePng, pixelAt } = await import('./png.mjs')
const shot = decodePng(Buffer.from(img))
const mid = await pt(400, 300)
const inRight = pixelAt(shot, Math.round(mid[0]), Math.round(mid[1])).slice(0, 3)
const outside = pixelAt(shot, Math.round(r0.x + r0.w * 0.52), Math.round(r0.y + 6)).slice(0, 3)
check('each pane draws the document through its own view', inRight.join() !== outside.join(), `${inRight} vs ${outside}`)
// Draw a shape in the right pane: it lands where the pane shows it.
const c = await rectangle('C', 500, 400, 560, 460)
const shape = (await doc()).nodes[c].props.geometry.shape
check('a shape drawn in the second pane lands where it shows', Math.abs(shape.x - 500) < 2 && Math.abs(shape.y - 400) < 2 && Math.abs(shape.w - 60) < 2, JSON.stringify(shape))
await page.evaluate(() => globalThis.plexel.views().toggleSplit())
await frames(page)
check('Split View again makes one pane, keeping the active pane’s view', (await page.evaluate(() => globalThis.plexel.engine().panes().length)) === 1 && (await view()).zoom === 0.5)

await finish()
