/**
 * The shell, driven the way a person drives it: menus by mouse and by
 * keyboard, the command palette, shortcuts, dialogs, the dock's panels and
 * splitter, and the view state surviving a reload.
 *
 * Run with: npm run check:shell
 */
import { check, finish, frames, open, waitForEngine, waitUntil } from './harness.mjs'

const { page, url } = await open({ viewport: { width: 1280, height: 800 } })
await page.goto(url)
await waitForEngine(page)

const html = (attr) => page.evaluate((a) => document.documentElement.dataset[a], attr)
const openMenu = () => page.evaluate(() => document.querySelector('.menu-title[aria-expanded="true"]')?.textContent ?? null)
const focused = () =>
  page.evaluate(() => {
    const el = document.activeElement
    return el?.dataset?.command ?? el?.textContent?.trim() ?? null
  })
const press = async (combo) => {
  const keys = combo.split('+')
  for (const k of keys.slice(0, -1)) await page.keyboard.down(k)
  await page.keyboard.press(keys[keys.length - 1])
  for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k)
  await frames(page)
}
const titleOf = (label) => page.evaluateHandle((l) => [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === l), label)
const clickTitle = async (label) => {
  const el = await titleOf(label)
  const box = await el.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  await frames(page)
}
const hoverTitle = async (label) => {
  const box = await (await titleOf(label)).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await frames(page)
}

// --- menus by mouse -----------------------------------------------------
console.log('\nmenus by mouse')
await clickTitle('View')
check('clicking View opens it', (await openMenu()) === 'View')
await hoverTitle('Window')
check('with a menu open, moving to Window opens Window', (await openMenu()) === 'Window')
await clickTitle('Window')
check('clicking the open menu’s title closes it', (await openMenu()) === null)

await clickTitle('View')
await page.mouse.click(60, 700)
await frames(page)
check('a click on the canvas closes the menu', (await openMenu()) === null)

// View → Theme → Darkroom.
await clickTitle('View')
await page.hover('[data-submenu="Theme"]')
await frames(page)
const darkroom = await page.waitForSelector('[data-command="appearance.theme.darkroom"]', { timeout: 2000 }).catch(() => null)
check('hovering Theme opens its submenu', !!darkroom)
await darkroom?.click()
await frames(page)
check('choosing Darkroom paints the page in Darkroom', (await html('theme')) === 'darkroom')
check('and closes the menu', (await openMenu()) === null)
await clickTitle('View')
await page.hover('[data-submenu="Theme"]')
const ticked = await page.$$eval('.menu .menu .menu-button[aria-checked="true"]', (els) => els.map((e) => e.dataset.command))
check('the submenu ticks Darkroom and the current mode', ticked.join() === 'appearance.theme.darkroom,appearance.mode.dark', ticked.join())
await press('Escape')

// --- menus by keyboard --------------------------------------------------
console.log('\nmenus by keyboard')
await page.mouse.click(60, 700)
await page.focus('.menu-root[data-menu="help"] .menu-title')
await press('ArrowDown')
check('↓ on a menu title opens it and focuses its first item', (await openMenu()) === 'Help' && (await focused()) === 'help.gpu', String(await focused()))
await press('ArrowDown')
check('↓ moves to the next item', (await focused()) === 'help.about')
await press('ArrowUp')
await press('ArrowUp')
check('↑ from the first item wraps to the last', (await focused()) === 'help.about', String(await focused()))
await press('ArrowLeft')
check('← moves to the previous menu', (await openMenu()) === 'Window', String(await openMenu()))
await press('Escape')
check('Esc closes the menu', (await openMenu()) === null)
check('and gives the focus back to its title', (await page.evaluate(() => document.activeElement?.textContent)) === 'Window')

// --- shortcuts ------------------------------------------------------------
console.log('\nshortcuts')
const mode = await html('mode')
await press('Control+Shift+KeyL')
check('Ctrl+Shift+L switches dark and light', (await html('mode')) !== mode, `${mode} → ${await html('mode')}`)
await press('Control+Shift+KeyL')
check('and back again', (await html('mode')) === mode)

// --- the command palette ------------------------------------------------
console.log('\ncommand palette')
await press('Control+KeyK')
check('Ctrl+K opens the palette', !!(await page.$('.palette')))
check('with the search box focused', await page.evaluate(() => document.activeElement?.id === 'palette-input'))
const all = await page.$$eval('.palette-item', (els) => els.length)
check('with no query it lists the commands', all > 10, `${all} rows`)
await page.keyboard.type('fjord')
await frames(page)
const firstRow = await page.$eval('.palette-item[aria-selected="true"]', (e) => e.dataset.command)
check('typing “fjord” selects the Fjord theme', firstRow === 'appearance.theme.fjord', firstRow)
await press('Enter')
check('Enter runs it and closes the palette', (await html('theme')) === 'fjord' && !(await page.$('.palette')))

await press('Control+KeyK')
await page.keyboard.type('qqqq')
await frames(page)
check('a query that matches nothing says so', /No command matches/.test(await page.$eval('.palette', (e) => e.textContent)))
await press('Escape')
check('Esc closes the palette', !(await page.$('.palette')))

await press('Control+KeyK')
await page.keyboard.type('about')
await press('Enter')
check('the palette can open a dialog', !!(await page.$('[data-dialog="about"]')))
await press('Escape')
check('Esc closes the dialog', !(await page.$('[data-dialog="about"]')))

// --- dialogs ----------------------------------------------------------------
console.log('\ndialogs')
await press('Control+Slash')
check('Ctrl+/ opens the shortcuts list', !!(await page.$('[data-dialog="shortcuts"]')))
const listed = await page.$eval('[data-dialog="shortcuts"]', (e) => e.textContent)
check('it lists Ctrl+K for the palette', /Command Palette\s*Ctrl\+K/.test(listed), listed.slice(0, 80))
await press('Control+KeyK')
check('shortcuts are held back while a dialog is open', !(await page.$('.palette')))
await page.mouse.click(5, 790)
await frames(page)
check('a click on the backdrop closes the dialog', !(await page.$('[data-dialog="shortcuts"]')))

await clickTitle('Help')
await page.click('[data-command="help.gpu"]')
await frames(page)
const gpu = await page.$eval('[data-dialog="gpu"]', (e) => e.textContent).catch(() => '')
check('Graphics Information shows the canvas format and limits', /Canvas format/.test(gpu) && /Largest texture/.test(gpu))
check('and says the page has shared memory', /yes \(cross-origin isolated\)/.test(gpu))
await press('Escape')

// --- the dock -----------------------------------------------------------------
console.log('\nthe dock')
const panels = () => page.$$eval('.panel', (els) => els.map((e) => e.dataset.panel))
check('a fresh workspace shows Properties, Colour and Layers', (await panels()).join() === 'properties,colour,layers', (await panels()).join())
await page.click('[data-panel="layers"] .panel-close')
await frames(page)
check('× closes the Layers panel', !(await panels()).includes('layers'))
await clickTitle('Window')
const layersTick = await page.$eval('[data-command="window.panel.layers"]', (e) => e.getAttribute('aria-checked'))
check('the Window menu shows Layers unticked', layersTick === 'false')
await page.click('[data-command="window.panel.history"]')
await frames(page)
check('Window → History opens the History panel', (await panels()).includes('history'))

await page.click('[data-panel="colour"] .panel-fold')
await frames(page)
check('a panel title folds the panel', await page.$eval('[data-panel="colour"]', (e) => e.classList.contains('collapsed')))

const dockWidth = () => page.$eval('.dock', (e) => Math.round(e.getBoundingClientRect().width))
const w0 = await dockWidth()
const split = await (await page.$('.dock-splitter')).boundingBox()
await page.mouse.move(split.x + 2, split.y + 200)
await page.mouse.down()
await page.mouse.move(split.x - 98, split.y + 200, { steps: 5 })
await page.mouse.up()
await frames(page)
const w1 = await dockWidth()
check('dragging the splitter left widens the dock', w1 === w0 + 100, `${w0} → ${w1}`)
await page.mouse.move(split.x - 98, split.y + 200)
await page.mouse.down()
await page.mouse.move(split.x - 2000, split.y + 200, { steps: 3 })
await page.mouse.up()
await frames(page)
check('and no further than its widest', (await dockWidth()) === 560, String(await dockWidth()))

// --- the browser keeps out ----------------------------------------------------
// Synthetic events can't show the browser acting, but they show whether
// the guard cancels what it would do: on the page, everything; in a text
// field, only what isn't the field's own.
console.log('\nthe browser keeps out')
const cancelled = (kind, init, where = 'body') =>
  page.evaluate(
    ({ kind, init, where }) => {
      let target = document.body
      let tmp = null
      if (where !== 'body') {
        tmp = document.createElement(where === 'select' ? 'select' : where === 'button' ? 'button' : 'input')
        if (where === 'range') tmp.type = 'range'
        document.body.append(tmp)
        tmp.focus()
        target = tmp
      }
      const Ctor = { key: KeyboardEvent, mouse: MouseEvent, wheel: WheelEvent, drag: DragEvent }[kind]
      const type = init.type
      const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init, ...(kind === 'drag' ? { dataTransfer: new DataTransfer() } : {}) })
      target.dispatchEvent(ev)
      tmp?.remove()
      return ev.defaultPrevented
    },
    { kind, init, where },
  )
const key = (k, mods = {}) => ({ type: 'keydown', key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, ...mods })
const ctrl = { ctrlKey: true }
for (const [label, init] of [
  ['Ctrl+F (find)', key('f', ctrl)],
  ['Ctrl+P (print)', key('p', ctrl)],
  ['Ctrl+R (reload)', key('r', ctrl)],
  // Plexel's own key too: it shows Brush Settings, which is closed again below.
  ['F5 (reload)', key('F5')],
  ['Ctrl+H (history)', key('h', ctrl)],
  ['Ctrl+U (source)', key('u', ctrl)],
  ['Ctrl+L (address bar)', key('l', ctrl)],
  ['Alt+← (back)', key('ArrowLeft', { altKey: true })],
  ['F1 (help)', key('F1')],
  ['F3 (find next)', key('F3')],
  ['F7 (caret browsing)', key('F7')],
  ['Space (scroll)', key(' ')],
  ['PageDown (scroll)', key('PageDown')],
  ['an unbound letter', key('j')],
]) check(`${label} is kept from the browser`, await cancelled('key', init))
check('F5 shows Brush Settings, as in Photoshop', !!(await page.$('[data-panel="brush-settings"]')))
await page.evaluate(() => document.querySelector('[data-panel="brush-settings"] .panel-close')?.click())
await cancelled('key', { ...key(' '), type: 'keyup' })
check('Alt let go is kept from the browser’s menu', await cancelled('key', { ...key('Alt', { altKey: false }), type: 'keyup' }))
check('Ctrl+C, X and V are left alone, for clipboard events', !(await cancelled('key', key('c', ctrl))) && !(await cancelled('key', key('v', ctrl))))
check('so is F12, the developer tools', !(await cancelled('key', key('F12'))))
check('and Tab in a control, which moves the focus', !(await cancelled('key', key('Tab'), 'button')))
// With nothing focused, Tab is Plexel's: it hides the panels (and again shows them).
check('Tab with nothing focused hides the panels instead', (await cancelled('key', key('Tab'))) && (await cancelled('key', key('Tab'))))

check('in a text field, a letter types', !(await cancelled('key', key('j'), 'text')))
check('Backspace, the arrows and Home edit and move', !(await cancelled('key', key('Backspace'), 'text')) && !(await cancelled('key', key('ArrowLeft'), 'text')) && !(await cancelled('key', key('Home'), 'text')))
check('Ctrl+A, Ctrl+Z and Ctrl+→ are the field’s', !(await cancelled('key', key('a', ctrl), 'text')) && !(await cancelled('key', key('z', ctrl), 'text')) && !(await cancelled('key', key('ArrowRight', ctrl), 'text')))
check('AltGr types', !(await cancelled('key', key('@', { ctrlKey: true, altKey: true }), 'text')))
check('but Ctrl+P and F5 aren’t the field’s', (await cancelled('key', key('p', ctrl), 'text')) && (await cancelled('key', key('F5'), 'text')))
check('a slider takes its arrows', !(await cancelled('key', key('ArrowRight'), 'range')))
check('a dropdown its keys', !(await cancelled('key', key('ArrowDown'), 'select')))
check('a button Enter and Space', !(await cancelled('key', key('Enter'), 'button')) && !(await cancelled('key', key(' '), 'button')))
check('but not Ctrl+F', await cancelled('key', key('f', ctrl), 'button'))

check('the browser’s context menu is kept off the page', await cancelled('mouse', { type: 'contextmenu', button: 2 }))
check('but not off a text field', !(await cancelled('mouse', { type: 'contextmenu', button: 2 }, 'text')))
check('the middle button doesn’t autoscroll', await cancelled('mouse', { type: 'mousedown', button: 1 }))
check('the side buttons don’t go back or forward', (await cancelled('mouse', { type: 'mouseup', button: 3 })) && (await cancelled('mouse', { type: 'mouseup', button: 4 })))
check('Ctrl+wheel (and a pinch) doesn’t zoom the page', await cancelled('wheel', { type: 'wheel', deltaY: 100, ctrlKey: true }))
check('a plain wheel still scrolls panels', !(await cancelled('wheel', { type: 'wheel', deltaY: 100 })))
check('nothing is dragged off the page', await cancelled('drag', { type: 'dragstart' }))
check('and a link dropped on it doesn’t open', await cancelled('drag', { type: 'dragover' }))
check('the page doesn’t swipe back or pinch-zoom', await page.evaluate(() => {
  const s = getComputedStyle(document.documentElement)
  return s.overscrollBehaviorX === 'none' && s.touchAction === 'pan-x pan-y'
}))

// --- view state survives a reload -------------------------------------------
console.log('\nreload')
await page.reload()
await waitForEngine(page)
await waitUntil(page, () => document.querySelectorAll('.panel').length > 0, { timeout: 5000 })
check('the theme survives a reload', (await html('theme')) === 'fjord')
check('so do the open panels', (await panels()).join() === 'properties,colour,history', (await panels()).join())
check('and the folded one', await page.$eval('[data-panel="colour"]', (e) => e.classList.contains('collapsed')))
check('and the dock’s width', (await dockWidth()) === 560)

await clickTitle('Window')
await page.hover('[data-submenu="Workspace"]')
await frames(page)
await page.click('[data-command="window.reset"]')
await frames(page)
check('Reset Workspace brings back the default panels', (await panels()).join() === 'properties,colour,layers')
check('at the default width', (await dockWidth()) === 300, String(await dockWidth()))

for (const id of ['properties', 'colour', 'layers']) await page.click(`[data-panel="${id}"] .panel-close`)
await frames(page)
check('with every panel closed the dock and its splitter go', !(await page.$('.dock')) && !(await page.$('.dock-splitter')))
const canvasWide = await page.$eval('[data-engine-canvas]', (e) => Math.round(e.getBoundingClientRect().width))
const toolbarWide = await page.$eval('.toolbar', (e) => Math.round(e.getBoundingClientRect().width))
check('and the canvas takes the whole width beside the toolbar', canvasWide + toolbarWide === 1280, `${canvasWide} + ${toolbarWide}`)
const drew = await waitUntil(page, () => {
  const m = /(\d+) × (\d+) px/.exec(document.querySelector('[data-status="canvas"]').textContent)
  return m && Number(m[1]) === Math.round(document.querySelector('[data-engine-canvas]').getBoundingClientRect().width * devicePixelRatio)
})
check('which the engine follows', drew)

await finish()
