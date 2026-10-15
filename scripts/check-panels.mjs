/**
 * Panels and the shared controls in Chrome: a column's groups sharing its
 * height (one scroll level, never a tab bar over another, short panels kept
 * whole, dividers trading height and keeping proportions as the window
 * changes size, a double-click fitting them again), tabs that don't fit
 * going into a » menu, and the shared controls: slider bars whose label
 * scrubs, typed numbers with arrow keys and Esc, segmented choices, ⓘ
 * hints in place of sentences, and the labels of dialogs' number fields
 * scrubbing.
 *
 * Run with: npm run check:panels
 */
import { check, finish, frames, open, pageHelpers, settle, waitForEngine, waitUntil } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 800 } })
await page.goto(url)
await waitForEngine(page)
const { press, idle } = pageHelpers(page)

const openMenu = async (menu) => {
  await page.evaluate((m) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === m).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), menu)
  await frames(page)
}
const run = async (menu, command) => {
  await openMenu(menu)
  await page.$eval(`[data-command="${command}"]`, (e) => e.click())
  await frames(page)
}
/** The right column's groups, top to bottom: their panels, top, bottom and head's bottom. */
const groups = () =>
  page.$$eval('[data-dock-side="right"] .dock > [data-group]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      const h = e.querySelector('.panel-head').getBoundingClientRect()
      return { panels: e.dataset.group, top: r.top, bottom: r.bottom, height: r.height, head: h.bottom, collapsed: e.classList.contains('collapsed') }
    }),
  )
const dockScroll = () => page.$eval('[data-dock-side="right"] .dock', (e) => ({ sh: e.scrollHeight, ch: e.clientHeight }))
const drag = async (from, to, steps = 10) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
  await settle(150)
}
const centreOf = async (sel) => {
  const b = await (await page.$(sel)).boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }
}

// A document with a shape, so Properties is long.
await press('Control+Alt+KeyN')
await page.waitForSelector('#new-name')
await page.click('[data-dialog="new"] .dialog-foot .primary')
await waitUntil(page, () => !document.querySelector('[data-dialog="new"]'))
await idle()
await press('KeyU')
const c = await centreOf('[data-engine-canvas]')
await drag({ x: c.x - 100, y: c.y - 80 }, { x: c.x + 100, y: c.y + 80 }, 6)
await idle()
await page.waitForSelector('[data-props="vector"]')

// --- a column's groups share its height -------------------------------------------------
console.log('\nA column shares its height')
let g = await groups()
let s = await dockScroll()
const layersNatural = await page.$eval('.panel[data-panel="layers"]', (e) => e.querySelector('.panel-head').offsetHeight + e.querySelector('.panel-body').scrollHeight)
const layers = g.find((x) => x.panels === 'layers')
check('with a long Properties, the column itself doesn’t scroll', s.sh <= s.ch + 1, JSON.stringify(s))
check('Properties scrolls what’s in it instead', await page.$eval('.panel[data-panel="properties"] .panel-body', (e) => e.scrollHeight > e.clientHeight + 4))
check('and Layers, short, is kept whole', Math.abs(layers.height - layersNatural) <= 2, `${layers.height} of ${layersNatural}`)
check('no tab bar is over another group', g.every((x, i) => i === 0 || x.top >= g[i - 1].bottom - 0.5))

for (const p of ['swatches', 'brushes', 'history', 'channels', 'paragraph']) await run('Window', `window.panel.${p}`)
await settle(200)
g = await groups()
s = await dockScroll()
check('with eight groups open, still one scroll level', s.sh <= s.ch + 1, JSON.stringify(s))
check('each group at least its tab bar and a strip of what’s in it', g.every((x) => x.collapsed || x.height >= 70), g.map((x) => Math.round(x.height)).join())
check('and no tab bar is over another', g.every((x, i) => i === 0 || x.top >= g[i - 1].bottom - 0.5))
check('every tab bar can be clicked', await page.evaluate(() => [...document.querySelectorAll('[data-dock-side="right"] .dock > [data-group] .panel-head')].every((h) => { const r = h.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 40, r.top + r.height / 2); return h.contains(el) })))

// Close the extra ones again.
for (const p of ['swatches', 'brushes', 'history', 'channels', 'paragraph']) await page.$eval(`.panel[data-panel="${p}"] .panel-close`, (e) => e.click())
await frames(page)

// --- dividers ------------------------------------------------------------------------------
console.log('\nDividers')
g = await groups()
const [a0, b0] = [g[0], g[1]]
const sizer = await centreOf(`[data-dock-side="right"] .dock > [data-group="${a0.panels}"] > .panel-sizer`)
await drag(sizer, { x: sizer.x, y: sizer.y - 80 })
g = await groups()
check('dragging the divider under a group up makes it shorter', g[0].height < a0.height - 60, `${a0.height} → ${g[0].height}`)
check('and the group below taller by as much', Math.abs(g[0].height + g[1].height - (a0.height + b0.height)) <= 3)
check('the column’s groups now have shares', !!(await page.$('[data-dock-side="right"] .dock > .panel.sized')))
const before = (await groups()).map((x) => x.height)
await page.setViewport({ width: 1280, height: 640 })
await settle(300)
const after = (await groups()).map((x) => x.height)
check('a shorter window keeps the shares’ proportions', Math.abs(after[0] / after[1] - before[0] / before[1]) < 0.12, `${before.map(Math.round)} → ${after.map(Math.round)}`)
s = await dockScroll()
check('and still one scroll level', s.sh <= s.ch + 1)
await page.setViewport({ width: 1280, height: 800 })
await settle(300)
const sizer2 = await centreOf(`[data-dock-side="right"] .dock > [data-group="${a0.panels}"] > .panel-sizer`)
await page.mouse.click(sizer2.x, sizer2.y, { clickCount: 2 })
await settle(200)
check('double-clicking a divider fits the groups again', !(await page.$('[data-dock-side="right"] .dock > .panel.sized')))
check('the last group open has no divider', !(await page.$('[data-dock-side="right"] .dock > [data-group="layers"] > .panel-sizer')))

// --- tabs that don't fit -----------------------------------------------------------------
console.log('\nTabs that don’t fit')
for (const p of ['swatches', 'brushes', 'history', 'channels', 'graphic-styles']) {
  await run('Window', `window.panel.${p}`)
  const t = await centreOf('[data-panel-tab="properties"]')
  const bar = await (await page.$('.panel[data-group^="properties"] .panel-tabs')).boundingBox()
  await drag((await centreOf(`[data-panel-tab="${p}"]`)), { x: bar.x + bar.width - 4, y: t.y })
}
const group = await page.$eval('.panel[data-group^="properties"]', (e) => e.dataset.group)
check('six panels are one group', group.split(' ').length === 6, group)
check('the tabs that don’t fit are in a » menu', !!(await page.$('.panel[data-group^="properties"] [data-tabs-more]')))
const shownTabs = await page.$$eval('.panel[data-group^="properties"] .panel-tabs:not(.panel-tabs-measure) [data-panel-tab]', (t) => t.map((x) => x.dataset.panelTab))
check('the front tab is on the bar', shownTabs.includes(await page.$eval('.panel[data-group^="properties"]', (e) => e.dataset.panel)), shownTabs.join())
check('and the bar’s tabs don’t run past it', await page.$eval('.panel[data-group^="properties"] .panel-tabs:not(.panel-tabs-measure)', (e) => e.scrollWidth <= e.clientWidth + 1))
await page.click('.panel[data-group^="properties"] [data-tabs-more]')
await page.waitForSelector('[data-tabs-menu]')
const hidden = await page.$$eval('[data-tab-pick]', (b) => b.map((x) => x.dataset.tabPick))
check('the menu lists the ones that didn’t fit', hidden.length > 0 && hidden.every((p) => !shownTabs.includes(p)), hidden.join())
await page.click(`[data-tab-pick="${hidden[hidden.length - 1]}"]`)
await frames(page)
check('picking one brings it to the front', (await page.$eval('.panel[data-group^="properties"]', (e) => e.dataset.panel)) === hidden[hidden.length - 1])
check('and it’s on the bar now', await page.$$eval('.panel[data-group^="properties"] .panel-tabs:not(.panel-tabs-measure) [data-panel-tab]', (t, p) => t.some((x) => x.dataset.panelTab === p), hidden[hidden.length - 1]))
await page.click('[data-panel-tab="properties"]').catch(() => {})
await page.$eval('[data-panel-tab="properties"]', (e) => e.click()).catch(() => {})
await frames(page)
// Back to the workspace as it was.
await openMenu('Window')
await page.click('[data-submenu="Workspace"]')
await page.click('[data-command="window.reset"]')
await settle(200)

// --- the shared controls --------------------------------------------------------------
console.log('\nSlider bars and numbers')
await page.waitForSelector('#props-opacity')
const opacity = () => page.evaluate(() => { const d = globalThis.plexel.documents().active(); return d.history.present.nodes[d.selected].opacity })
check('Opacity is one bar: the range, its number and its label together', await page.$eval('.slider-row:has(#props-opacity)', (r) => !!r.querySelector('input[type=range]') && !!r.querySelector('.slider-number') && !!r.querySelector('.slider-label')))
const lab = await centreOf('.slider-row:has(#props-opacity) .slider-label')
await drag({ x: lab.x, y: lab.y }, { x: lab.x - 60, y: lab.y }, 8)
await idle()
const o1 = await opacity()
check('dragging its label left scrubs it down', o1 < 0.9 && o1 > 0.2, String(o1))
await page.$eval('.slider-row:has(#props-opacity) .slider-number', (e) => e.focus())
await page.keyboard.press('ArrowUp')
await idle()
check('ArrowUp in its number steps it by one', Math.abs((await opacity()) - (Math.round(o1 * 100) + 1) / 100) < 0.005, String(await opacity()))
await page.keyboard.down('Shift')
await page.keyboard.press('ArrowDown')
await page.keyboard.up('Shift')
await idle()
check('Shift+ArrowDown by ten', Math.abs((await opacity()) - (Math.round(o1 * 100) - 9) / 100) < 0.005, String(await opacity()))
const o2 = await opacity()
await page.keyboard.type('5')
await page.keyboard.press('Escape')
await page.keyboard.press('Tab')
await idle()
check('Esc puts back what was typed', Math.abs((await opacity()) - o2) < 0.001)

console.log('\nScrubbing labels')
const xBefore = await page.$eval('#props-shape-x', (e) => Number(e.value))
const xl = await centreOf('label[for="props-shape-x"]')
await drag({ x: xl.x, y: xl.y }, { x: xl.x + 30, y: xl.y }, 6)
await idle()
check('dragging a box field’s letter scrubs it', (await page.$eval('#props-shape-x', (e) => Number(e.value))) > xBefore + 10)
check('the cursor says so', await page.$eval('label[for="props-shape-x"]', (e) => getComputedStyle(e).cursor === 'ew-resize'))

console.log('\nSegmented choices')
check('a shape’s corner style is buttons side by side', await page.$$eval('#props-shape-corner [role=radio]', (b) => b.length === 3))
await page.$eval('#props-shape-corner-chamfer', (e) => e.click())
await idle()
const corner = () => page.evaluate(() => { const d = globalThis.plexel.documents().active(); return d.history.present.nodes[d.selected].props.geometry.shape.corner })
check('pressing one chooses it', (await corner()) === 'chamfer')
await page.$eval('#props-shape-corner-chamfer', (e) => e.focus())
await page.keyboard.press('ArrowRight')
await idle()
check('the arrow keys move to the next', (await corner()) === 'inset' && (await page.evaluate(() => document.activeElement?.id)) === 'props-shape-corner-inset')

console.log('\nHints rather than sentences')
check('Properties has no sentences under its fields', (await page.$$('.panel[data-panel="properties"] .field-note')).length === 0)
check('it has ⓘ hints instead', (await page.$$('.panel[data-panel="properties"] [data-hint]')).length >= 2)
await page.$eval('.panel[data-panel="properties"] [data-hint]', (e) => e.scrollIntoView({ block: 'center' }))
await page.mouse.move(10, 400)
await settle(300)
const hint = await centreOf('.panel[data-panel="properties"] [data-hint]')
await page.mouse.move(hint.x, hint.y)
check('hovering one shows its explanation', await waitUntil(page, () => (document.querySelector('[data-tooltip]')?.textContent ?? '').length > 20, { timeout: 2000 }))
await page.mouse.move(10, 400)

console.log('\nA dialog’s number labels')
await run('Select', 'select.all')
await openMenu('Select')
await page.click('[data-submenu="Modify"]')
await page.click('[data-command="select.feather"]')
await page.waitForSelector('#feather-radius')
const fr = await centreOf('label[for="feather-radius"]')
const r0 = await page.$eval('#feather-radius', (e) => Number(e.value))
await drag({ x: fr.x, y: fr.y }, { x: fr.x + 25, y: fr.y }, 6)
check('dragging Feather’s label scrubs its radius', (await page.$eval('#feather-radius', (e) => Number(e.value))) >= r0 + 10, String(await page.$eval('#feather-radius', (e) => e.value)))
check('and it explains itself with an ⓘ by the label, not in a paragraph', !!(await page.$('[data-dialog="feather"] label[for="feather-radius"] [data-hint]')) && !(await page.$('[data-dialog="feather"] .dialog-body p')))
await press('Escape')

await finish()
