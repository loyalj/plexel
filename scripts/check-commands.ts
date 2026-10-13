/**
 * The command registry, the menus built from it, the palette's search, the
 * shortcut parser, and the defensive loading of view state.
 *
 * Everything the menus, the keyboard and the palette show comes from one
 * list, so most of what can go wrong with them is something wrong in the
 * list: an id used twice, a menu entry pointing at nothing, two commands on
 * one key, a key the browser keeps for itself, a dialog command without its
 * ellipsis. All of it is checked here, in Node, before a browser starts.
 *
 * Run with: npm run check:commands
 */
import { COMMANDS, COMMANDS_BY_ID, MENUS, commandById, expandMenu, runtimeCommands, shortcutsOf, type CommandContext, type MenuItem } from '../src/commands'
import { matchCommand, matchText } from '../src/commands/search'
import { formatShortcut, matches, parseShortcut, shortcutKey } from '../src/input/shortcuts'
import { keepsDefault } from '../src/input/guard'
import { PANELS, type PanelId } from '../src/ui/panels'
import { TOOL_DEFS, type ToolId } from '../src/tools'
import { DEFAULT_APPEARANCE, THEMES, loadAppearance, type Appearance } from '../src/ui/theme'
import {
  WORKSPACES,
  addWorkspace,
  defaultWorkspace,
  deleteWorkspace,
  isPristine,
  loadWorkspace,
  nameProblem,
  newWorkspace,
  presetLayout,
  readWorkspace,
  renameWorkspace,
  resetWorkspace,
  saveChanges,
  switchWorkspace,
  workspaceName,
  type Workspace,
} from '../src/ui/workspace'
import {
  COLUMN_MAX,
  COLUMN_MIN,
  closeGroup,
  closePanel,
  find,
  inIcons,
  isOpen,
  isShown,
  move,
  moveWindow,
  openPanel,
  openPanels,
  readLayout,
  sameLayout,
  setIcons,
  togglePanel,
  type Layout,
} from '../src/ui/layout'
import { RESERVED, assignKey, clashes, isChanged, keyProblem, keysOf, ownerOf, readKeyChanges, removeKey, resetKeys, shortcutFromEvent, shortcutText } from '../src/input/keymap'
import { readWorkspaceFile, workspaceFileName, workspaceFileText } from '../src/ui/workspaceFile'
import type { Tiling } from '../src/doc/types'
import { DEFAULT_PREFS, readPrefs } from '../src/ui/interface'
import { HOLD_MS, Spring } from '../src/app/springTools'
import { NO_DOC, contextMenu, disabledReason, type ScreenMode } from '../src/commands'
import { SESSION_KEYS } from '../src/tools'
import { chordModifiers, chordParts } from '../src/ui/Keys'
import { ICONS, phosphorNames } from '../src/ui/icons'
import { ICON_DATA } from '../src/ui/icons.data'
import { ICON_DATA_FILE, iconBodies, iconDataSource } from './icon-data'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  return ok
}

// --- a context that records what commands do ---------------------------
interface Recorded {
  ctx: CommandContext
  dialogs: string[]
  palette: number
  /** Everything else a command asked the app to do, by name. */
  calls: string[]
}

/**
 * A context with a document open, a layer selected, something to undo and
 * to redo, so every command is enabled and does something to record.
 */
function fakeContext(): Recorded {
  let appearance: Appearance = { ...DEFAULT_APPEARANCE }
  let ws: Workspace = defaultWorkspace()
  let full = false
  let tool: ToolId = 'hand'
  let quick = false
  let mode: 'rgb' | 'gray' | 'cmyk' = 'rgb'
  let depth: 8 | 16 = 8
  let proof = false
  let gamut = false
  let screen: ScreenMode = 'standard'
  let hidden = false
  let dockHidden = false
  const mask = false
  const aids = { rulers: false, guides: true, lockGuides: false, grid: false, pixelGrid: true, smartGuides: true, snap: true, tiledView: true }
  let tiling: Tiling = 'off'
  const snapTo = { guides: true, grid: true, layers: true, document: true, points: true, pixels: false }
  let units: 'px' | 'in' | 'cm' | 'mm' | 'pt' = 'px'
  let alignTo: 'layers' | 'key' | 'canvas' | 'selection' = 'layers'
  let split = false
  const call = (name: string) => () => void rec.calls.push(name)
  const rec: Recorded = {
    dialogs: [],
    palette: 0,
    calls: [],
    ctx: {
      hasDoc: () => true,
      hasRecent: () => true,
      open: call('open'),
      save: call('save'),
      saveAs: call('saveAs'),
      close: call('close'),
      undoLabel: () => 'Canvas Size',
      redoLabel: () => 'Opacity',
      undo: call('undo'),
      redo: call('redo'),
      selectedLayer: () => 'n1',
      selectedKind: () => 'pixel',
      newGroup: call('newGroup'),
      newPixelLayer: call('newPixelLayer'),
      fill: (w) => void rec.calls.push(`fill ${w}`),
      act: (a) => void rec.calls.push(`act ${a}`),
      hasChannels: () => true,
      swapColours: call('swapColours'),
      resetColours: call('resetColours'),
      deleteLayer: call('deleteLayer'),
      renameLayer: call('renameLayer'),
      shiftLayer: (s) => void rec.calls.push(`shift ${s}`),
      canShiftLayer: () => true,
      toggleLayerVisible: call('toggleLayerVisible'),
      place: call('place'),
      canCopy: () => true,
      copy: (o) => (rec.calls.push(`copy ${o.cut ? 'cut' : o.merged ? 'merged' : ''}`), true),
      paste: (how) => void rec.calls.push(`paste ${how}`),
      newFromClipboard: call('newFromClipboard'),
      layerVia: (cut) => void rec.calls.push(`layerVia ${cut}`),
      duplicateLayer: call('duplicateLayer'),
      copyStyle: call('copyStyle'),
      pasteStyle: call('pasteStyle'),
      hasStyleClip: () => true,
      zoomIn: call('zoomIn'),
      zoomOut: call('zoomOut'),
      fitOnScreen: call('fitOnScreen'),
      actualPixels: call('actualPixels'),
      rotateView: (d) => void rec.calls.push(`rotate ${d}`),
      resetRotation: call('resetRotation'),
      tool: () => tool,
      setTool: (t) => (tool = t),
      resizeBrush: (d) => void rec.calls.push(`resize ${d}`),
      paints: () => true,
      hardenBrush: (d) => void rec.calls.push(`harden ${d}`),
      brushDigit: (d, f) => void rec.calls.push(`digit ${d} ${f}`),
      hasSelection: () => true,
      canReselect: () => true,
      selectAll: call('selectAll'),
      deselect: call('deselect'),
      reselect: call('reselect'),
      inverse: call('inverse'),
      quickMask: () => quick,
      toggleQuickMask: () => void (quick = !quick),
      deleteOrClear: call('deleteOrClear'),
      freeTransform: call('freeTransform'),
      liquify: call('liquify'),
      transform: (k) => void rec.calls.push(`transform ${k}`),
      session: () => 'transform',
      commitSession: call('commitSession'),
      cancelSession: call('cancelSession'),
      nudge: (x, y) => void rec.calls.push(`nudge ${x},${y}`),
      hasMask: () => mask,
      maskEnabled: () => true,
      addMask: (k) => void rec.calls.push(`addMask ${k}`),
      deleteMask: call('deleteMask'),
      applyMask: call('applyMask'),
      toggleMask: call('toggleMask'),
      invertMask: call('invertMask'),
      isClipped: () => false,
      canClip: () => true,
      toggleClip: call('toggleClip'),
      rasterize: call('rasterize'),
      cropToSelection: call('cropToSelection'),
      canCombine: () => true,
      combine: (op) => void rec.calls.push(`combine:${op}`),
      isCompound: () => true,
      releaseCompound: call('releaseCompound'),
      expandCompound: call('expandCompound'),
      isLiveShape: () => true,
      convertToPath: call('convertToPath'),
      isText: () => true,
      docMode: () => mode,
      docTiling: () => tiling,
      setTiling: (t) => void (tiling = t),
      docDepth: () => depth,
      convertMode: (m) => void (mode = m),
      convertDepth: (d) => void (depth = d),
      proofColours: () => proof,
      toggleProofColours: () => void (proof = !proof),
      gamutWarning: () => gamut,
      toggleGamutWarning: () => void (gamut = !gamut),
      isSplit: () => split,
      toggleSplit: () => void (split = !split),
      viewAid: (k) => aids[k],
      toggleViewAid: (k) => void (aids[k] = !aids[k]),
      snapTo: (k) => snapTo[k],
      toggleSnapTo: (k) => void (snapTo[k] = !snapTo[k]),
      units: () => units,
      setUnits: (u) => void (units = u),
      hasGuides: () => true,
      clearGuides: call('clearGuides'),
      guidesFromShape: call('guidesFromShape'),
      alignTo: () => alignTo,
      setAlignTo: (a) => void (alignTo = a),
      alignWhy: () => null,
      distributeWhy: () => null,
      align: (op) => void rec.calls.push(`align ${op}`),
      distribute: (op) => void rec.calls.push(`distribute ${op}`),
      createOutlines: call('createOutlines'),
      addFonts: call('addFonts'),
      importBrushes: call('importBrushes'),
      loadSystemFonts: call('loadSystemFonts'),
      hasVectorMask: () => mask,
      vectorMaskEnabled: () => true,
      addVectorMask: (kind) => void rec.calls.push(`addVectorMask:${kind}`),
      deleteVectorMask: call('deleteVectorMask'),
      toggleVectorMask: call('toggleVectorMask'),
      newAdjustment: (id) => void rec.calls.push(`adjust ${id}`),
      newFilterLayer: (id) => void rec.calls.push(`filter layer ${id}`),
      shapeCount: () => 2,
      isPlainShape: () => true,
      isLivePaint: () => false,
      construct: (k) => void rec.calls.push(`construct ${k}`),
      canFilter: () => true,
      hasLiveFilters: () => true,
      applyLiveFilters: call('applyLiveFilters'),
      hasStyle: () => true,
      clearStyle: call('clearStyle'),
      toSmartObject: call('toSmartObject'),
      editContents: call('editContents'),
      get appearance() {
        return appearance
      },
      setAppearance: (a) => (appearance = a),
      panelOpen: (id) => isShown(ws.layout, id),
      togglePanel: (id) => (ws = { ...ws, layout: togglePanel(ws.layout, id) }),
      resetWorkspace: () => (ws = resetWorkspace(ws)),
      workspace: () => ws.current,
      workspaceName: () => workspaceName(ws),
      workspacePristine: () => isPristine(ws),
      setWorkspace: (id) => (ws = switchWorkspace(ws, id)),
      customWorkspaces: () => ws.custom.map((w) => ({ id: w.id, name: w.name })),
      saveWorkspaceChanges: () => (ws = saveChanges(ws)),
      exportWorkspace: call('exportWorkspace'),
      importWorkspace: call('importWorkspace'),
      screenMode: () => screen,
      setScreenMode: (m) => (screen = m),
      panelsHidden: () => hidden,
      dockHidden: () => dockHidden,
      hidePanels: (which) => (which === 'all' ? (hidden = !hidden) : (dockHidden = !dockHidden)),
      tabHides: () => true,
      openDialog: (id) => rec.dialogs.push(id),
      openPalette: () => rec.palette++,
      fullscreen: () => full,
      toggleFullscreen: () => (full = !full),
    },
  }
  return rec
}

// --- the registry ------------------------------------------------------
console.log('\nregistry')
const ids = COMMANDS.map((c) => c.id)
check('command ids are unique', new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(', '))
const badIds = ids.filter((id) => !/^[a-z]+(\.[a-z0-9-]+)+$/.test(id))
check('command ids are dotted lowercase, area first', badIds.length === 0, badIds.join(', '))
check('every command has a label and a category', COMMANDS.every((c) => c.label.trim() && c.category.trim()))
check('COMMANDS_BY_ID holds every command', COMMANDS.every((c) => COMMANDS_BY_ID.get(c.id) === c))
check('every theme has a command', THEMES.every((t) => COMMANDS_BY_ID.has(`appearance.theme.${t.id}`)))
check('every panel has a show/hide command', PANELS.every((p) => COMMANDS_BY_ID.has(`window.panel.${p.id}`)))

// --- labels follow the ellipsis rule -----------------------------------
console.log('\nlabels')
for (const c of COMMANDS) {
  const r = fakeContext()
  c.run(r.ctx)
  // Open, Save As and Import as Layer ask for a file, so they count as asking for more.
  const asks = r.dialogs.length > 0 || r.palette > 0 || ['open', 'saveAs', 'place', 'addFonts', 'importBrushes', 'exportWorkspace', 'importWorkspace'].some((c) => r.calls.includes(c))
  const dots = c.label.endsWith('…')
  check(
    `“${c.label}” ${asks ? 'opens something, so ends in …' : 'acts at once, so has no …'}`,
    asks === dots,
    c.label.endsWith('...') ? 'three dots instead of an ellipsis' : '',
  )
}

// --- ticks tell the truth -----------------------------------------------
console.log('\nticks')
for (const c of COMMANDS.filter((c) => c.checked)) {
  const r = fakeContext()
  const before = c.checked!(r.ctx)
  c.run(r.ctx)
  const after = c.checked!(r.ctx)
  // A choice (a theme) is ticked once chosen; a toggle (a panel) flips.
  check(`“${c.label}” shows what running it did`, after === true || after !== before, `before ${before}, after ${after}`)
}
{
  const r = fakeContext()
  COMMANDS_BY_ID.get('appearance.theme.darkroom')!.run(r.ctx)
  const ticked = THEMES.filter((t) => COMMANDS_BY_ID.get(`appearance.theme.${t.id}`)!.checked!(r.ctx))
  check('exactly one theme is ticked', ticked.length === 1 && ticked[0].id === 'darkroom', ticked.map((t) => t.id).join(', '))
  COMMANDS_BY_ID.get('appearance.mode.toggle')!.run(r.ctx)
  check('switching modes keeps the theme', r.ctx.appearance.theme === 'darkroom' && r.ctx.appearance.mode === 'light')
}

// --- shortcuts -----------------------------------------------------------
console.log('\nshortcuts')
const withKeys = COMMANDS.filter((c) => shortcutsOf(c).length)
const allKeys = withKeys.flatMap((c) => shortcutsOf(c).map((text) => ({ c, text })))
for (const { c, text } of allKeys) check(`${c.id}'s shortcut “${text}” parses`, parseShortcut(text) !== null)
const keys = allKeys.map(({ text }) => shortcutKey(parseShortcut(text)!))
check('no two commands share a shortcut', new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i).join(', '))

// Keys the browser keeps (input/keymap.ts): a command on one would close the tab or open a window instead of running.
const reserved = new Set(RESERVED.map((s) => shortcutKey(parseShortcut(s)!)))
const clash = allKeys.filter(({ text }) => reserved.has(shortcutKey(parseShortcut(text)!)))
check('no shortcut is one the browser keeps for itself', clash.length === 0, clash.map(({ c }) => c.id).join(', '))

// The clipboard's keys stay the browser's, so its clipboard events fire (input/guard.ts), and only clipboard commands have them.
{
  // The guard asks what the key's target is; in Node there are no elements, so none is a field.
  for (const n of ['HTMLElement', 'HTMLInputElement', 'HTMLSelectElement']) (globalThis as Record<string, unknown>)[n] ??= class {}
  const kept = (text: string) => {
    const sc = parseShortcut(text)!
    return keepsDefault({ key: sc.key, code: '', ctrlKey: sc.mod, metaKey: false, shiftKey: sc.shift, altKey: sc.alt, target: null } as unknown as KeyboardEvent, false)
  }
  const clipCmds = COMMANDS.filter((c) => c.clipboard)
  check('Cut, Copy, Paste and Paste in Place are the clipboard commands', clipCmds.map((c) => c.id).sort().join() === 'edit.copy,edit.cut,edit.paste,edit.paste-in-place')
  check('their keys are left to the browser, so the clipboard events fire', clipCmds.every((c) => shortcutsOf(c).every(kept)), clipCmds.flatMap((c) => shortcutsOf(c).filter((t) => !kept(t))).join(', '))
  // Tab is the browser's in a control (it moves the focus), and the app's on the canvas (focusKey).
  const others = allKeys.filter(({ c, text }) => !c.clipboard && !c.focusKey && kept(text))
  check('no other command is on a key the browser keeps, but Tab, which a focused control keeps', others.length === 0, others.map(({ c }) => c.id).join(', '))
  const r = fakeContext()
  COMMANDS_BY_ID.get('edit.copy-merged')!.run(r.ctx)
  COMMANDS_BY_ID.get('edit.paste-into')!.run(r.ctx)
  COMMANDS_BY_ID.get('layer.via-copy')!.run(r.ctx)
  check('Copy Merged, Paste Into and Layer via Copy ask for what they say', r.calls.join() === 'copy merged,paste into,layerVia false', r.calls.join())
}

check('a malformed shortcut is refused', ['', 'Mod+', 'Ctrl+K', 'Mod+Mod+K', 'Shift'].every((s) => parseShortcut(s) === null))
check('modifier order does not matter', shortcutKey(parseShortcut('Shift+Mod+K')!) === shortcutKey(parseShortcut('Mod+Shift+K')!))
const ctrlK = parseShortcut('Mod+K')!
check('Mod+K is shown as Ctrl+K on Windows', formatShortcut(ctrlK, false) === 'Ctrl+K')
check('Mod+Shift+L is shown as ⇧⌘L on a Mac', formatShortcut(parseShortcut('Mod+Shift+L')!, true) === '⇧⌘L')
const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent
check('Ctrl+K matches Mod+K on Windows', matches(ctrlK, ev('k', { ctrlKey: true }), false))
check('⌘K matches Mod+K on a Mac', matches(ctrlK, ev('k', { metaKey: true }), true))
check('Ctrl+K does not match Mod+K on a Mac', !matches(ctrlK, ev('k', { ctrlKey: true }), true))
check('Ctrl+Shift+K does not match Mod+K', !matches(ctrlK, ev('K', { ctrlKey: true, shiftKey: true }), false))
check('Shift is matched whatever case the key comes in', matches(parseShortcut('Mod+Shift+L')!, ev('L', { ctrlKey: true, shiftKey: true }), false))
check('Shift+1 matches by the key it is on, where Shift makes it !', matches(parseShortcut('Shift+1')!, ev('!', { shiftKey: true, code: 'Digit1' }), false))
check('Shift+[ matches by the key it is on, where Shift makes it {', matches(parseShortcut('Shift+[')!, ev('{', { shiftKey: true, code: 'BracketLeft' }), false))
check('a plain 1 does not match Shift+1', !matches(parseShortcut('Shift+1')!, ev('1', { code: 'Digit1' }), false))
check('Shift+1 does not match a plain 1', !matches(parseShortcut('1')!, ev('!', { shiftKey: true, code: 'Digit1' }), false))
check('⌥K on a Mac, which types ˚, matches Alt+K by its key', matches(parseShortcut('Alt+K')!, ev('˚', { altKey: true, code: 'KeyK' }), true))
check('a letter is never matched by its place otherwise, so a layout keeps its letters', !matches(parseShortcut('Q')!, ev('a', { code: 'KeyQ' }), false))
check('AltGr typing ń on Windows (Ctrl+Alt+N by place) is typing, not Ctrl+Alt+N', !matches(parseShortcut('Mod+Alt+N')!, ev('ń', { ctrlKey: true, altKey: true, code: 'KeyN' }), false))
check('Shift+- matches by the key it is on, where Shift makes it _', matches(parseShortcut('Shift+-')!, ev('_', { shiftKey: true, code: 'Minus' }), false))
check('keys written as words parse: Space and Plus', parseShortcut('Mod+Space')?.key === ' ' && parseShortcut('Mod+Plus')?.key === '+')

// --- your own shortcuts ------------------------------------------------------
console.log('\nyour own shortcuts')
{
  const defs = COMMANDS
  check('every registry key is written back as it was read', allKeys.every(({ text }) => shortcutKey(parseShortcut(shortcutText(parseShortcut(text)!))!) === shortcutKey(parseShortcut(text)!)), allKeys.filter(({ text }) => shortcutKey(parseShortcut(shortcutText(parseShortcut(text)!))!) !== shortcutKey(parseShortcut(text)!)).map(({ text }) => text).join(', '))
  check('the registry’s keys have no clashes, and no problems', clashes(defs, {}).size === 0 && withKeys.every((c) => shortcutsOf(c).every((k) => !keyProblem(c, k, false))), withKeys.flatMap((c) => shortcutsOf(c).filter((k) => keyProblem(c, k, false)).map((k) => `${c.id} ${k}: ${keyProblem(c, k, false)}`)).join('; '))
  const dupLayer = ownerOf(defs, {}, 'Mod+J')!
  check('Ctrl+J is someone’s to start with', !!dupLayer && dupLayer.id !== 'layer.new-group', dupLayer?.id)
  const given = assignKey(defs, {}, 'layer.new-group', 'Mod+J')
  const newGroup = COMMANDS_BY_ID.get('layer.new-group')!
  check('a key given to a command is its', keysOf(newGroup, given).includes('Mod+J'))
  check('and taken from the one that had it', !keysOf(dupLayer, given).some((k) => k === 'Mod+J') && ownerOf(defs, given, 'Mod+J')?.id === 'layer.new-group')
  check('both are marked changed, and nothing clashes', isChanged(given, 'layer.new-group') && isChanged(given, dupLayer.id) && clashes(defs, given).size === 0)
  const back = resetKeys(defs, given, dupLayer.id)
  check('Reset gives a command its keys back, taking them from whatever has them', keysOf(dupLayer, back).includes('Mod+J') && !keysOf(newGroup, back).includes('Mod+J') && !isChanged(back, dupLayer.id))
  const undo = COMMANDS_BY_ID.get('edit.undo')!
  const replaced = assignKey(defs, {}, 'edit.undo', 'F9', 'Mod+Z')
  check('a key replaced is replaced in place', keysOf(undo, replaced).join() === 'F9')
  check('giving it its own key again forgets the change', !isChanged(assignKey(defs, replaced, 'edit.undo', 'Mod+Z', 'F9'), 'edit.undo'))
  const none = removeKey(defs, {}, 'edit.undo', 'Mod+Z')
  check('a key removed leaves the command with none, which is a change', keysOf(undo, none).length === 0 && isChanged(none, 'edit.undo'))
  check('a key the browser keeps is refused', !!keyProblem(undo, 'Mod+W', false) && Object.keys(assignKey(defs, {}, 'edit.undo', 'Mod+W')).length === 0)
  check('so are the developer tools’ keys and the clipboard’s', !!keyProblem(undo, 'Mod+Shift+I', false) && !!keyProblem(undo, 'F12', false) && !!keyProblem(undo, 'Mod+C', false))
  check('and the clipboard commands stay on the clipboard’s keys', !!keyProblem(COMMANDS_BY_ID.get('edit.copy')!, 'Mod+K', false) && !keyProblem(COMMANDS_BY_ID.get('edit.copy')!, 'Mod+C', false))
  check('Tab is only for Tab’s own commands', !!keyProblem(undo, 'Tab', false) && !keyProblem(COMMANDS_BY_ID.get('view.hide-panels')!, 'Tab', false))
  check('every reserved key is refused', RESERVED.every((k) => !!keyProblem(undo, k, false)))
  const read = readKeyChanges({ 'edit.undo': ['Mod+U', 'nonsense+', 'mod+u', 5, 'F9', 'F10', 'F11', 'F12'], 'x': 'Mod+K', '': ['F1'] })
  check('saved keys are read field by field: bad ones and repeats dropped, a few kept', read['edit.undo']?.join() === 'Mod+U,F9,F10,F11' && !('x' in read) && !('' in read), JSON.stringify(read))
  check('nothing to read reads as no changes', Object.keys(readKeyChanges('x')).length === 0 && Object.keys(readKeyChanges(null)).length === 0)
  const key = (o: Partial<KeyboardEvent>) => shortcutFromEvent({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o } as KeyboardEvent, false)
  check('a press records as its key: Ctrl+Shift+K', shortcutText(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })!) === 'Mod+Shift+K')
  check('Shift+1 records as Shift+1, not !', shortcutText(key({ key: '!', code: 'Digit1', shiftKey: true })!) === 'Shift+1')
  check('Shift+[ records as Shift+[', shortcutText(key({ key: '{', code: 'BracketLeft', shiftKey: true })!) === 'Shift+[')
  check('a modifier alone records nothing', key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }) === null && key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }) === null)
  check('the keypad’s + records as Plus, and reads back', shortcutText(key({ key: '+', code: 'NumpadAdd', ctrlKey: true })!) === 'Mod+Plus' && parseShortcut('Mod+Plus')!.key === '+')
  check('⌥K on a Mac records as Alt+K', shortcutText(shortcutFromEvent({ key: '˚', code: 'KeyK', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true } as KeyboardEvent, true)!) === 'Alt+K')
}

// --- the menus -----------------------------------------------------------
console.log('\nmenus')
const walk = (items: MenuItem[]): string[] =>
  items.flatMap((i) => ('command' in i ? [i.command] : 'submenu' in i ? walk(i.items) : []))
const inMenus = MENUS.flatMap((m) => walk(m.items))
const dangling = inMenus.filter((id) => !COMMANDS_BY_ID.has(id))
check('every menu entry names a real command', dangling.length === 0, dangling.join(', '))
check('no command appears twice in the menus', new Set(inMenus).size === inMenus.length)
check('menu ids are unique', new Set(MENUS.map((m) => m.id)).size === MENUS.length)

const separatorsTidy = (items: MenuItem[]): boolean => {
  const kinds = items.map((i) => ('separator' in i ? 'sep' : 'item'))
  if (kinds[0] === 'sep' || kinds[kinds.length - 1] === 'sep') return false
  if (kinds.some((k, i) => k === 'sep' && kinds[i + 1] === 'sep')) return false
  return items.every((i) => !('submenu' in i) || (i.items.length > 0 && separatorsTidy(i.items)))
}
for (const m of MENUS) {
  check(`the ${m.label} menu has items and no stray separators`, m.items.length > 0 && separatorsTidy(m.items))
}
// Every tool is a button on the toolbar too, which reaches the ones without a key of their own (a group's, Smudge).
const unreachable = COMMANDS.filter((c) => !inMenus.includes(c.id) && !shortcutsOf(c).length && !c.id.startsWith('tool.'))
// Everything is in the palette anyway; this says which commands only the
// palette reaches, so leaving one out of the menus is a decision.
check('every command is in a menu or has a shortcut', unreachable.length === 0, unreachable.map((c) => c.id).join(', '))

check('Undo’s menu item names the step it takes back', COMMANDS_BY_ID.get('edit.undo')!.menuLabel!(fakeContext().ctx) === 'Undo Canvas Size')
check('Redo’s names the step it brings back', COMMANDS_BY_ID.get('edit.redo')!.menuLabel!(fakeContext().ctx) === 'Redo Opacity')
{
  const none = fakeContext()
  none.ctx.hasDoc = () => false
  none.ctx.undoLabel = () => null
  none.ctx.selectedLayer = () => null
  none.ctx.selectedKind = () => null
  const needDoc = ['file.save', 'file.save-as', 'file.close', 'file.place', 'file.export', 'view.fit', 'view.actual', 'view.zoom-in', 'view.zoom-out', 'doc.canvas-size', 'doc.resolution', 'doc.rename', 'doc.assign-profile', 'layer.new-group', 'layer.new-pixel', 'layer.delete', 'layer.rename', 'edit.fill-foreground', 'edit.fill-background']
  const wrongly = needDoc.filter((id) => COMMANDS_BY_ID.get(id)!.enabled?.(none.ctx) !== false)
  check('with no document, the document commands are disabled', wrongly.length === 0, wrongly.join(', '))
  check('with nothing to undo, Undo is disabled and says only “Undo”', !COMMANDS_BY_ID.get('edit.undo')!.enabled!(none.ctx) && COMMANDS_BY_ID.get('edit.undo')!.menuLabel!(none.ctx) === 'Undo')
  const group = fakeContext()
  group.ctx.selectedKind = () => 'group'
  check('Fill needs a pixel layer (or a mask) selected, not a group', !COMMANDS_BY_ID.get('edit.fill-foreground')!.enabled!(group.ctx))
  group.ctx.hasMask = () => true
  check('a group’s mask can be filled', COMMANDS_BY_ID.get('edit.fill-foreground')!.enabled!(group.ctx))
  check('Apply Layer Mask needs a pixel layer', !COMMANDS_BY_ID.get('layer.mask-apply')!.enabled!(group.ctx))
  const plain = fakeContext()
  plain.ctx.hasSelection = () => false
  check('Delete deletes the layer with nothing selected, and clears with a selection', COMMANDS_BY_ID.get('edit.delete')!.menuLabel!(plain.ctx) === 'Delete Layer' && COMMANDS_BY_ID.get('edit.delete')!.menuLabel!(fakeContext().ctx) === 'Clear')
  check('the mask-from-selection commands need a selection', !COMMANDS_BY_ID.get('layer.mask-reveal-selection')!.enabled!(plain.ctx) && COMMANDS_BY_ID.get('layer.mask-reveal-all')!.enabled!(plain.ctx))
  check('only the arrow keys repeat while held', COMMANDS.filter((c) => c.repeats).every((c) => c.id.startsWith('edit.nudge-')))
  check('the tools are a choice: exactly one is ticked', (() => {
    const t = fakeContext()
    COMMANDS_BY_ID.get('tool.zoom')!.run(t.ctx)
    return COMMANDS.filter((c) => c.id.startsWith('tool.') && !!c.checked && c.checked(t.ctx)).map((c) => c.id).join() === 'tool.zoom'
  })())
  check('New and Open work with no document', ['file.new', 'file.open'].every((id) => COMMANDS_BY_ID.get(id)!.enabled?.(none.ctx) ?? true))
}

// --- the palette's search -----------------------------------------------
console.log('\nsearch')
const fs = matchText('fs', 'Full Screen')
check('“fs” finds Full Screen by its word starts', !!fs && fs.hits.join() === '0,5', JSON.stringify(fs))
check('“zzz” finds nothing', matchText('zzz', 'Full Screen') === null)
check('letters out of order find nothing', matchText('ksl', 'Light') === null)
check('an empty query matches everything', matchText('', 'Anything')?.score === 0)
check('case is ignored', !!matchText('ABOUT', 'About Plexel…'))
const dark = matchText('dark', 'Dark')!.score
const darkInside = matchText('dark', 'Switch Dark and Light')!.score
check('an exact label beats the same word inside a longer one', dark > darkInside, `${dark.toFixed(2)} vs ${darkInside.toFixed(2)}`)
const prefix = matchText('pal', 'Command Palette…')!.score
const scatter = matchText('pal', 'Graphics Information…')
check('a word start beats letters scattered through words', !scatter || prefix > scatter.score)
const byCategory = COMMANDS.filter((c) => matchCommand('appearance', c.label, c.category))
check(
  '“appearance” finds every appearance command by its category',
  COMMANDS.filter((c) => c.category === 'Appearance').every((c) => byCategory.includes(c)),
)
const catHits = matchCommand('appearance', 'Dark', 'Appearance')
check('a category match highlights nothing in the label', !!catHits && catHits.hits.length === 0, JSON.stringify(catHits))
check('“window res” narrows to Window and finds Reset Workspace', !!matchCommand('window res', 'Reset Workspace', 'Window'))
check('“window res” does not find a Window command without those letters', !matchCommand('window res', 'Layers', 'Window'))
check(
  'letters that happen to be in a category name find nothing there',
  !matchCommand('pa', 'Fjord', 'Appearance'),
  'the p and a in “appearance” once listed every theme',
)

// --- view state loads defensively ---------------------------------------
console.log('\nview state')
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}
check('no saved appearance gives the default', JSON.stringify(loadAppearance()) === JSON.stringify(DEFAULT_APPEARANCE))
store.set('plexel.appearance.v1', '{not json')
check('a corrupt appearance gives the default', loadAppearance().theme === DEFAULT_APPEARANCE.theme)
store.set('plexel.appearance.v1', JSON.stringify({ theme: 'removed-theme', mode: 'light' }))
const kept = loadAppearance()
check('an unknown theme falls back but the mode is kept', kept.theme === DEFAULT_APPEARANCE.theme && kept.mode === 'light')

// A save from before docking is carried over, defensively.
store.set('plexel.workspace.v1', JSON.stringify({ open: { layers: false, history: true, gone: true }, collapsed: { colour: true }, dockWidth: 99999 }))
{
  const ws = loadWorkspace()
  const panels = openPanels(ws.layout)
  check('a first-version save is carried over: its panels down one dock on the right', ws.layout.right.length === 1 && ws.layout.left.length === 0 && panels.join() === 'properties,colour,history', panels.join())
  check('with the folded one folded', find(ws.layout, 'colour')?.group.collapsed === true)
  check('a panel no longer in the app is dropped', !panels.includes('gone' as PanelId))
  check('a dock width out of range is clamped', ws.layout.right[0].width === COLUMN_MAX, String(ws.layout.right[0].width))
}
store.set('plexel.workspace.v1', JSON.stringify({ dockWidth: -5 }))
check('a negative dock width is clamped to the minimum', loadWorkspace().layout.right[0].width === COLUMN_MIN)
store.set('plexel.workspace.v2', JSON.stringify(defaultWorkspace()))
store.set('plexel.workspace.v1', JSON.stringify({ open: { history: true } }))
check('once there’s a second-version save, the first is left alone', !isOpen(loadWorkspace().layout, 'history'))
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
}
check('storage that throws gives the defaults', JSON.stringify(loadWorkspace()) === JSON.stringify(defaultWorkspace()) && loadAppearance().mode === 'dark')

console.log('\nthe layout')
{
  const base = presetLayout('essentials')
  const names = (l: Layout) => ({
    left: l.left.map((c) => c.groups.map((g) => g.panels.join('+')).join('/')).join(' | '),
    right: l.right.map((c) => c.groups.map((g) => g.panels.join('+')).join('/')).join(' | '),
    floats: l.floats.map((f) => f.groups.map((g) => g.panels.join('+')).join('/')).join(' '),
  })
  check('Essentials is one column on the right, a group per panel', names(base).right === 'properties/colour/layers' && !names(base).left && !names(base).floats)
  const tabbed = move(base, 'colour', { kind: 'tab', group: 'properties', index: 1 })
  check('a panel dropped on a group’s tabs joins it, in front', names(tabbed).right === 'properties+colour/layers' && isShown(tabbed, 'colour') && !isShown(tabbed, 'properties') && isOpen(tabbed, 'properties'))
  const reordered = move(tabbed, 'colour', { kind: 'tab', group: 'properties', index: 0 })
  check('dropped on its own group’s tabs, it changes places', names(reordered).right === 'colour+properties/layers')
  const out = move(tabbed, 'colour', { kind: 'stack', near: 'layers', where: 'after' })
  check('dragged out below another group, it’s a group of its own', names(out).right === 'properties/layers/colour' && isShown(out, 'properties'))
  const left = move(base, 'layers', { kind: 'column', side: 'left', near: null, where: 'after' }, true)
  check('dropped at the window’s left edge, a group makes a dock there', names(left).left === 'layers' && names(left).right === 'properties/colour')
  const twoCols = move(base, 'colour', { kind: 'column', side: 'right', near: 'properties', where: 'after' })
  check('dropped beside a column, a new column', names(twoCols).right === 'properties/layers | colour' && twoCols.right[1].width === base.right[0].width)
  check('a group alone in its column, dropped beside it, stays put', JSON.stringify(move(twoCols, 'colour', { kind: 'column', side: 'right', near: 'colour', where: 'before' }, true)) === JSON.stringify(twoCols))
  const lastOut = move(twoCols, 'colour', { kind: 'stack', near: 'properties', where: 'before' }, true)
  check('the last group out of a column takes the column with it', lastOut.right.length === 1 && names(lastOut).right === 'colour/properties/layers')
  const floated = move(base, 'colour', { kind: 'float', x: 400, y: 120, width: 280, height: null }, true)
  check('dropped over the canvas, it floats in a window there', names(floated).floats === 'colour' && floated.floats[0].x === 400 && names(floated).right === 'properties/layers')
  const moved = move(floated, 'colour', { kind: 'float', x: 500, y: 140, width: 280, height: null }, true)
  check('a window dragged over the canvas just moves', moved.floats.length === 1 && moved.floats[0].x === 500 && moved.floats[0].width === floated.floats[0].width)
  const docked = move(floated, 'colour', { kind: 'tab', group: 'layers', index: 9 }, true)
  check('and dropped on a dock, it docks and the window goes', docked.floats.length === 0 && names(docked).right === 'properties/layers+colour')
  check('a drop onto its own place changes nothing', move(base, 'colour', { kind: 'stack', near: 'colour', where: 'after' }, true) === base)

  const closed = closePanel(tabbed, 'colour')
  check('closing a tab brings its neighbour to the front', isShown(closed, 'properties') && !isOpen(closed, 'colour'))
  check('and opening it again puts it back in that group', names(openPanel(closed, 'colour')).right === 'properties+colour/layers')
  const swatches = openPanel(base, 'swatches')
  check('a panel never opened goes at the foot of the dock', names(swatches).right === 'properties/colour/layers/swatches')
  const reopened = openPanel(closePanel(base, 'colour'), 'colour')
  check('one closed from a column comes back under the group it was under', names(reopened).right === 'properties/colour/layers')
  const fl = closePanel(floated, 'colour')
  check('one closed from a window floats again where it was', openPanel(fl, 'colour').floats[0]?.x === 400)
  check('the Window menu shows a panel behind a tab, rather than closing it', isShown(togglePanel(tabbed, 'properties'), 'properties') && !isShown(togglePanel(base, 'colour'), 'colour'))
  check('Close Tab Group closes every tab in it', !isOpen(closeGroup(tabbed, 'properties'), 'colour') && !isOpen(closeGroup(tabbed, 'properties'), 'properties'))
  const dup = readLayout({ right: [{ width: 9999, groups: [{ panels: ['layers', 'gone', 'layers'], active: 'nope' }] }], left: [{ groups: [{ panels: ['gone'] }] }], floats: [{ x: 'a', group: { panels: ['layers', 'history'] } }] })!
  check('a saved layout keeps a panel where it’s first, drops what’s gone, and clamps', names(dup).right === 'layers' && !dup.left.length && dup.right[0].width === COLUMN_MAX && dup.right[0].groups[0].active === 'layers')
  check('and a window with a bad position gets one', dup.floats.length === 1 && dup.floats[0].groups[0].panels.join() === 'history' && Number.isFinite(dup.floats[0].x))
  check('nothing to read reads as nothing', readLayout('x') === null && readLayout(null) === null)

  // Windows holding several groups stacked.
  const stacked = move(floated, 'layers', { kind: 'stack', near: 'colour', where: 'after' }, true)
  check('a group dropped at the foot of one in a window stacks under it there', names(stacked).floats === 'colour/layers' && names(stacked).right === 'properties' && stacked.floats.length === 1)
  check('both are shown', isShown(stacked, 'colour') && isShown(stacked, 'layers'))
  check('a window of several groups doesn’t just move when one is dragged over the canvas', names(move(stacked, 'layers', { kind: 'float', x: 700, y: 300, width: 280, height: null }, true)).floats === 'colour layers')
  const above = openPanel(closePanel(stacked, 'colour'), 'colour')
  check('one closed from the top of a window comes back at its top', names(above).floats === 'colour/layers')
  const below = openPanel(closePanel(stacked, 'layers'), 'layers')
  check('one closed from under another comes back under it', names(below).floats === 'colour/layers')
  const wDocked = moveWindow(stacked, 0, { kind: 'column', side: 'left', near: null, where: 'after' })
  check('a whole window dropped at the window’s edge docks there, its groups in order', names(wDocked).left === 'colour/layers' && wDocked.floats.length === 0)
  const wTabs = moveWindow(stacked, 0, { kind: 'tab', group: 'properties', index: 0 })
  check('dropped on a group’s tabs, its panels all join it, in order', names(wTabs).right === 'colour+layers+properties' && wTabs.floats.length === 0, names(wTabs).right)
  check('dropped over the canvas, it moves', moveWindow(stacked, 0, { kind: 'float', x: 10, y: 20, width: 280, height: null }).floats[0].x === 10)
  check('dropped onto itself, nothing changes', moveWindow(stacked, 0, { kind: 'stack', near: 'layers', where: 'after' }) === stacked)
  const stackRead = readLayout(JSON.parse(JSON.stringify(stacked)))!
  check('a window of several groups is saved and read back as it was', names(stackRead).floats === 'colour/layers' && sameLayout(stackRead, stacked))

  // Columns folded to icons.
  const icons = setIcons(base, 'layers', true)
  check('a column folds to icons, keeping its width', icons.right[0].icons && icons.right[0].width === base.right[0].width && inIcons(icons, 'colour'))
  check('a panel in a column of icons is open but not shown', isOpen(icons, 'layers') && !isShown(icons, 'layers'))
  check('folding counts as a change to the workspace', !sameLayout(icons, base))
  check('and opens out again', !setIcons(icons, 'layers', false).right[0].icons && sameLayout(setIcons(icons, 'layers', false), base))
  check('a floating panel has no column to fold', setIcons(floated, 'colour', true) === floated)
  check('a panel opened into a column of icons is an icon there', inIcons(openPanel(icons, 'swatches'), 'swatches'))
  check('folded columns are saved and read back folded', readLayout(JSON.parse(JSON.stringify(icons)))!.right[0].icons === true)
  check('a column saved before folding reads as not folded', readLayout({ right: [{ width: 300, groups: [{ panels: ['layers'] }] }] })!.right[0].icons === false)
}

console.log('\nworkspaces')
{
  check('every workspace has a command and a name', WORKSPACES.every((w) => COMMANDS_BY_ID.has(`window.workspace.${w.id}`) && w.name.trim()))
  check('every workspace opens panels that exist, and at least Layers', WORKSPACES.every((w) => w.panels.length > 0 && w.panels.every((p) => PANELS.some((x) => x.id === p)) && w.panels.includes('layers')))
  check('Essentials is the panels open by default', openPanels(presetLayout('essentials')).join() === PANELS.filter((p) => p.defaultOpen).map((p) => p.id).join())
  const ws0 = defaultWorkspace()
  check('a fresh workspace is as designed', isPristine(ws0))
  const changed = { ...ws0, layout: openPanel(ws0.layout, 'history') }
  check('opening a panel makes it not', !isPristine(changed))
  check('but where a closed panel was doesn’t count', isPristine({ ...ws0, layout: { ...ws0.layout, closed: { history: { with: null, after: 'layers', side: 'right' } } } }))
  const painting = switchWorkspace(changed, 'painting')
  check('switching opens the other workspace’s panels', painting.current === 'painting' && isOpen(painting.layout, 'brush-settings') && !isOpen(painting.layout, 'history'))
  const back = switchWorkspace(painting, 'essentials')
  check('and coming back finds this one as it was left', back.current === 'essentials' && isOpen(back.layout, 'history'))
  check('Reset puts the current one back as designed, the others as they were left', isPristine(resetWorkspace(back)) && resetWorkspace(back).kept.painting !== undefined)
  const saved = readWorkspace(JSON.stringify(painting))
  check('a workspace survives saving with how the others were left', saved.current === 'painting' && isOpen(saved.kept.essentials, 'history'))
  check('a saved workspace no longer in the app reads as Essentials', readWorkspace(JSON.stringify({ ...painting, current: 'gone' })).current === 'essentials')

  // Your own.
  check('a workspace needs a name, and not one of Plexel’s', !!nameProblem(ws0, '  ') && /Plexel/.test(nameProblem(ws0, 'painting') ?? ''))
  const floated = { ...changed, layout: move(changed.layout, 'colour', { kind: 'float', x: 300, y: 200, width: 260, height: null }, true) }
  const mine = newWorkspace(floated, '  Retouch   work ')
  const id = mine.current
  check('New Workspace saves where the panels are and changes to it', mine.custom.length === 1 && mine.custom[0].name === 'Retouch work' && id.startsWith('user-') && isPristine(mine))
  check('the workspace left keeps how it was left', isOpen(mine.kept.essentials, 'history') && mine.kept.essentials.floats.length === 1)
  check('its name is the workspace’s name', workspaceName(mine) === 'Retouch work')
  const edited = { ...mine, layout: closePanel(mine.layout, 'history') }
  check('changing it makes it not as saved', !isPristine(edited))
  check('Reset brings it back as saved', isOpen(resetWorkspace(edited).layout, 'history') && resetWorkspace(edited).layout.floats.length === 1)
  const kept = saveChanges(edited)
  check('Save Changes makes the change its design', isPristine(kept) && !isOpen(resetWorkspace(kept).layout, 'history'))
  check('Save Changes leaves Plexel’s own alone', saveChanges(changed) === changed)
  const replaced = newWorkspace(switchWorkspace(kept, 'photo'), 'retouch WORK')
  check('a new one by the same name replaces it, as in Photoshop', replaced.custom.length === 1 && replaced.current === id && isOpen(replaced.layout, 'channels'))
  const two = newWorkspace(replaced, 'Painting big')
  check('renaming to another of yours is refused', renameWorkspace(two, id, 'painting BIG') === two && !!nameProblem(two, 'Painting big', id))
  check('renaming keeps the layout', renameWorkspace(two, id, 'Retouch').custom.find((w) => w.id === id)?.name === 'Retouch')
  const roundTrip = readWorkspace(JSON.stringify(two))
  check('yours survive saving, in order, with how each was left', roundTrip.custom.map((w) => w.name).join() === 'retouch WORK,Painting big' && roundTrip.current === two.current && !!roundTrip.kept[id])
  check('a saved one with a bad id, no name or a name taken is dropped', readWorkspace(JSON.stringify({ ...two, custom: [...two.custom, { id: 'x', name: 'A', layout: two.layout }, { id: 'user-z', name: '', layout: two.layout }, { id: 'user-y', name: 'Painting BIG', layout: two.layout }] })).custom.length === 2)
  const gone = deleteWorkspace(two, two.current)
  check('deleting the one in use changes to Essentials, as it was left', gone.current === 'essentials' && gone.custom.length === 1 && isOpen(gone.layout, 'history'))
  check('deleting another leaves the one in use', deleteWorkspace(two, id).current === two.current && deleteWorkspace(two, id).custom.length === 1)
  check('Plexel’s own can’t be deleted', deleteWorkspace(two, 'painting') === two)

  const r = fakeContext()
  COMMANDS_BY_ID.get('window.workspace.photo')!.run(r.ctx)
  check('exactly one workspace is ticked', WORKSPACES.filter((w) => COMMANDS_BY_ID.get(`window.workspace.${w.id}`)!.checked!(r.ctx)).map((w) => w.id).join() === 'photo')
  check('Reset names the workspace it resets', COMMANDS_BY_ID.get('window.reset')!.menuLabel!(r.ctx) === 'Reset Photo')
  check('Reset is disabled while it’s as designed', !COMMANDS_BY_ID.get('window.reset')!.enabled!(r.ctx))
  COMMANDS_BY_ID.get('window.panel.history')!.run(r.ctx)
  check('Window → History closes it in Photo, where it’s shown', !r.ctx.panelOpen('history') && COMMANDS_BY_ID.get('window.reset')!.enabled!(r.ctx))
  check('with none of your own, Save Changes and Rename and Delete say why', /Plexel/.test(disabledReason(COMMANDS_BY_ID.get('window.workspace-save')!, r.ctx) ?? '') && /New Workspace/.test(disabledReason(COMMANDS_BY_ID.get('window.workspace-manage')!, r.ctx) ?? ''))
  const menu = (c: CommandContext) => {
    const sub = MENUS.find((m) => m.id === 'window')!.items.find((i): i is { submenu: string; items: MenuItem[] } => 'submenu' in i && i.submenu === 'Workspace')!
    return expandMenu(sub.items, c)
  }
  check('with none of your own the menu has no empty section', !menu(r.ctx).some((x, i, a) => 'separator' in x && 'separator' in (a[i + 1] ?? {})))
  COMMANDS_BY_ID.get('window.workspace-new')!.run(r.ctx)
  check('New Workspace asks for a name', r.dialogs.at(-1) === 'newWorkspace')
  // What the dialog does with the name.
  const own = fakeContext()
  own.ctx.setWorkspace('photo')
  const s0 = newWorkspace(readWorkspace(null), 'Mine')
  const c = { ...own.ctx, customWorkspaces: () => s0.custom, workspace: () => s0.current }
  const listed = runtimeCommands(c)
  check('each of yours is a command, in the menu and the palette', listed.length === 1 && listed[0].label === 'Mine Workspace' && menu(c).some((x) => 'command' in x && x.command === listed[0].id))
  check('it’s ticked when in use, and found by its id', listed[0].checked!(c) && commandById(listed[0].id, c) !== undefined)
}

console.log('\nworkspace files')
{
  const ws = newWorkspace(readWorkspace(null), 'Retouch')
  const keys = assignKey(COMMANDS, {}, 'layer.new-group', 'Mod+J')
  const text = workspaceFileText('Retouch', setIcons(ws.layout, 'layers', true), keys)
  const read = readWorkspaceFile(text, 'Retouch.plexel-workspace.json')
  check('a workspace file reads back with its name, layout and keys', !('problem' in read) && read.name === 'Retouch' && sameLayout(read.layout, setIcons(ws.layout, 'layers', true)) && JSON.stringify(read.keys) === JSON.stringify(keys))
  const plain = readWorkspaceFile(workspaceFileText('Plain', ws.layout, {}))
  check('with no keys changed, it carries none', !('problem' in plain) && plain.keys === null && !/"keys"/.test(workspaceFileText('Plain', ws.layout, {})))
  check('not JSON, not a workspace, or no panels this version has: each says why', ['{', '{"format":"other"}', JSON.stringify({ format: 'plexel-workspace', layout: { right: [{ groups: [{ panels: ['gone'] }] }] } })].every((t) => 'problem' in readWorkspaceFile(t)))
  const unnamed = readWorkspaceFile(JSON.stringify({ format: 'plexel-workspace', version: 9, layout: ws.layout }), 'Night shift.plexel-workspace.json')
  check('a file with no name is named after the file, and a later version is read for what this one knows', !('problem' in unnamed) && unnamed.name === 'Night shift')
  check('a file name leaves out what a file name can’t have', workspaceFileName('A/B: C?') === 'A-B- C-.plexel-workspace.json')
  if (!('problem' in read)) {
    const added = addWorkspace(defaultWorkspace(), read.name, read.layout)
    check('imported, it’s one of yours and in use', added.custom.length === 1 && added.current === added.custom[0].id && sameLayout(added.layout, read.layout) && isPristine(added))
    check('it can’t take a name of Plexel’s', addWorkspace(defaultWorkspace(), 'Painting', read.layout).custom.length === 0)
    const again = addWorkspace(added, 'retouch', presetLayout('print'))
    check('one of yours by the same name is replaced', again.custom.length === 1 && isOpen(again.layout, 'separations'))
  }
  const r = fakeContext()
  COMMANDS_BY_ID.get('window.workspace-export')!.run(r.ctx)
  COMMANDS_BY_ID.get('window.workspace-import')!.run(r.ctx)
  check('Export and Import Workspace ask for what they say', r.calls.join() === 'exportWorkspace,importWorkspace', r.calls.join())
  check('Export names the workspace it exports', COMMANDS_BY_ID.get('window.workspace-export')!.menuLabel!(r.ctx) === 'Export Essentials…')
}

console.log('\nscreen modes and Tab')
{
  const r = fakeContext()
  const next = COMMANDS_BY_ID.get('view.screen-next')!
  const seen: string[] = []
  for (let i = 0; i < 3; i++) {
    next.run(r.ctx)
    seen.push(r.ctx.screenMode())
  }
  check('F steps through the three screen modes and back', seen.join() === 'menus,full,standard', seen.join())
  check('Tab and Shift+Tab are focus keys, left to a focused control', ['view.hide-panels', 'view.hide-dock'].every((id) => COMMANDS_BY_ID.get(id)!.focusKey))
  r.ctx.tabHides = () => false
  check('with Tab only moving the focus, Tab hides nothing, and says why', !COMMANDS_BY_ID.get('view.hide-panels')!.enabled!(r.ctx) && /Interface/.test(disabledReason(COMMANDS_BY_ID.get('view.hide-panels')!, r.ctx) ?? ''))
}

console.log('\nwhy a command is unavailable')
{
  const none = fakeContext()
  none.ctx.hasDoc = () => false
  none.ctx.selectedLayer = () => null
  none.ctx.selectedKind = () => null
  none.ctx.undoLabel = () => null
  none.ctx.redoLabel = () => null
  none.ctx.hasSelection = () => false
  none.ctx.session = () => null
  none.ctx.hasRecent = () => false
  const silent = COMMANDS.filter((c) => c.enabled && !c.enabled(none.ctx) && !disabledReason(c, none.ctx)?.trim())
  check('every command disabled with no document says why', silent.length === 0, silent.map((c) => c.id).join(', '))
  check('with no document, a document command says to open one', disabledReason(COMMANDS_BY_ID.get('layer.new-pixel')!, none.ctx) === NO_DOC)
  check('an enabled command has no reason', disabledReason(COMMANDS_BY_ID.get('file.new')!, fakeContext().ctx) === null)
  const noLayer = fakeContext()
  noLayer.ctx.selectedLayer = () => null
  noLayer.ctx.selectedKind = () => null
  const silentLayer = COMMANDS.filter((c) => c.enabled && !c.enabled(noLayer.ctx) && !disabledReason(c, noLayer.ctx)?.trim())
  check('every command disabled with no layer selected says why', silentLayer.length === 0, silentLayer.map((c) => c.id).join(', '))
  check('with no layer selected, a layer command says to select one', disabledReason(COMMANDS_BY_ID.get('layer.duplicate')!, noLayer.ctx) === 'Select a layer first')
  const text = fakeContext()
  text.ctx.selectedKind = () => 'text'
  check('Fill on a text layer says what it needs and what’s selected', /pixel layer or a mask/.test(disabledReason(COMMANDS_BY_ID.get('edit.fill')!, text.ctx) ?? ''), disabledReason(COMMANDS_BY_ID.get('edit.fill')!, text.ctx) ?? '')
  const sel = fakeContext()
  sel.ctx.hasSelection = () => false
  check('Feather with nothing selected says it needs a selection', /selection/.test(disabledReason(COMMANDS_BY_ID.get('select.feather')!, sel.ctx) ?? ''))
  const brushy = fakeContext()
  brushy.ctx.paints = () => false
  check('a brush key with a tool that doesn’t paint says which tools do', /Brush/.test(disabledReason(COMMANDS_BY_ID.get('brush.opacity-5')!, brushy.ctx) ?? ''))
}

console.log('\nthe canvas’s context menu')
{
  const ids = (items: MenuItem[]) => walk(items)
  const enabledIn = (c: ReturnType<typeof fakeContext>['ctx'], items: MenuItem[]) => ids(items).every((id) => COMMANDS_BY_ID.get(id)!.enabled?.(c) ?? true)
  // The fake context has a transform open, which would be all the menu offered.
  const idle = () => {
    const r = fakeContext()
    r.ctx.session = () => null
    return r
  }
  const withSel = idle()
  const m1 = contextMenu(withSel.ctx)
  check('with a selection it offers Deselect, Inverse, Feather and Select and Mask', ['select.deselect', 'select.inverse', 'select.feather', 'select.mask'].every((id) => ids(m1).includes(id)), ids(m1).join(', '))
  check('everything it offers can run now', enabledIn(withSel.ctx, m1))
  check('its separators are tidy', separatorsTidy(m1))
  const plain = idle()
  plain.ctx.hasSelection = () => false
  const m2 = contextMenu(plain.ctx)
  check('without a selection it offers Select All, not Deselect', ids(m2).includes('select.all') && !ids(m2).includes('select.deselect'))
  const text = idle()
  text.ctx.selectedKind = () => 'text'
  text.ctx.isText = () => true
  check('on a text layer it offers Create Outlines', ids(contextMenu(text.ctx)).includes('type.create-outlines'))
  const busy = fakeContext()
  busy.ctx.session = () => 'transform'
  const m3 = contextMenu(busy.ctx)
  check('during a Free Transform it offers Commit and Cancel, and nothing else', ids(m3).join() === 'edit.commit,edit.cancel', ids(m3).join())
  const none = idle()
  none.ctx.hasDoc = () => false
  check('with no document it offers New and Open', ids(contextMenu(none.ctx)).slice(0, 2).join() === 'file.new,file.open')
}

console.log('\ntool keys')
{
  check('every tool lists its keys', TOOL_DEFS.every((t) => t.keys.length > 0), TOOL_DEFS.filter((t) => !t.keys.length).map((t) => t.id).join(', '))
  const all = [...TOOL_DEFS.flatMap((t) => t.keys), ...Object.values(SESSION_KEYS).flat()]
  check('every key says what it does', all.every((k) => k.keys.trim() && k.does.trim()))
  check('Shift, Alt and Ctrl are read out of a chord', chordModifiers('Shift+Alt').join() === 'Shift,Alt' && chordModifiers('[ ]').length === 0)
  check('on a Mac they print as ⇧, ⌥ and ⌘', chordParts('Shift+Alt+Ctrl', true).join('') === '⇧⌥⌘')
  check('the brush sizing drag is Ctrl+Option on a Mac', chordParts('Alt+Right-drag', true).join(' ') === '⌃ ⌥ Drag')
  const hint = TOOL_DEFS.find((t) => t.id === 'marquee')!.keys
  check('the Marquee’s keys say Shift adds and, while dragging, makes a square', hint.some((k) => k.keys === 'Shift' && !k.during && /adds/.test(k.does)) && hint.some((k) => k.keys === 'Shift' && k.during === 'drag' && /square/.test(k.does)))
}

console.log('\nspring-loaded tools')
{
  let t = 0
  const st = { tool: 'brush' as ToolId }
  const cur = (): ToolId => st.tool
  let drag = false
  const make = () => new Spring(() => t, (id) => (st.tool = id), () => drag)
  const s = make()
  // A tap: down and up at once.
  st.tool = 'move'
  s.press('KeyV', 'brush', 'move')
  t += 80
  check('a tap switches for good', s.release('KeyV') === null && cur() === 'move')
  // A hold: longer than HOLD_MS.
  st.tool = 'brush'
  s.press('KeyV', 'brush', 'move')
  st.tool = 'move'
  t += HOLD_MS + 50
  check('a hold gives the tool before back on release', s.release('KeyV') === 'brush' && cur() === 'brush')
  // A quick press that used the tool is a hold too.
  s.press('KeyI', 'brush', 'picker')
  st.tool = 'picker'
  s.use()
  t += 60
  check('a quick press used on the canvas counts as a hold', s.release('KeyI') === 'brush' && cur() === 'brush')
  // Let go mid-drag: back once the drag ends, not before.
  s.press('KeyV', 'brush', 'move')
  st.tool = 'move'
  s.use()
  drag = true
  s.release('KeyV')
  check('let go during a drag, the tool stays until the drag ends', cur() === 'move')
  drag = false
  s.dragEnded()
  check('and then comes back', cur() === 'brush')
  // Another key's release changes nothing; a second tool key keeps the first tool to go back to.
  s.press('KeyV', 'brush', 'move')
  st.tool = 'move'
  t += HOLD_MS + 50
  check('another key coming up changes nothing', s.release('KeyB') === null && cur() === 'move')
  s.press('KeyI', 'move', 'picker')
  st.tool = 'picker'
  t += HOLD_MS + 50
  check('a second tool key held over the first still goes back to the tool before both', s.release('KeyI') === 'brush' && cur() === 'brush')
  s.press('KeyM', 'brush', 'marquee')
  st.tool = 'marquee'
  s.forget()
  t += HOLD_MS + 50
  check('a tool chosen on the toolbar mid-hold leaves nothing to go back to', s.release('KeyM') === null && cur() === 'marquee')
  const same = make()
  same.press('KeyB', 'brush', 'brush')
  check('the key of the tool already in use is no spring', same.get() === null)
}

console.log('\ninterface settings')
{
  check('no saved settings give the defaults', JSON.stringify(readPrefs(null)) === JSON.stringify(DEFAULT_PREFS))
  check('a corrupt save gives the defaults', JSON.stringify(readPrefs('{oops')) === JSON.stringify(DEFAULT_PREFS))
  const p = readPrefs(JSON.stringify({ scale: 1.25, density: 'compact', contrast: 'more', motion: 'reduce', richTips: false, keyHints: false, tabHides: false }))
  check('every setting is read back', p.scale === 1.25 && p.density === 'compact' && p.contrast === 'more' && p.motion === 'reduce' && !p.richTips && !p.keyHints && !p.tabHides)
  const bad = readPrefs(JSON.stringify({ scale: 7, density: 'huge', contrast: 1, tabHides: 'yes' }))
  check('a size off the list, an unknown density and a wrong type fall back', bad.scale === 1 && bad.density === 'comfortable' && bad.contrast === 'normal' && bad.tabHides === true)
}

console.log('\nicons')
{
  const missing = TOOL_DEFS.filter((t) => !(`tool.${t.id}` in ICONS)).map((t) => t.id)
  check('every tool has an icon in the registry', missing.length === 0, missing.join(', '))
  const noData = phosphorNames().filter((n) => !ICON_DATA[n])
  check('every icon the registry names has its outline, filled weights for the tools too', noData.length === 0, noData.join(', '))
  const extra = Object.keys(ICON_DATA).filter((n) => !phosphorNames().includes(n))
  check('and the app carries no outline it doesn’t use', extra.length === 0, extra.join(', '))
  let fresh = ''
  try {
    fresh = iconDataSource(iconBodies())
  } catch (e) {
    fresh = String(e)
  }
  check('icons.data.ts is what build:icons makes from Phosphor’s set (after changing icons.ts, run npm run build:icons)', fresh === readFileSync(ICON_DATA_FILE, 'utf8').replace(/\r\n/g, '\n'))
  check('every outline draws in the current colour, so icons follow the theme', Object.values(ICON_DATA).every((b) => !/(fill|stroke)="#/.test(b)))
}

console.log(`\n${failures === 0 ? 'all clear' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
