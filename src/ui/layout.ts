/**
 * Where the panels are: a workspace's layout.
 *
 * Panels live in groups, a group's panels shown one at a time as tabs, as in
 * Photoshop. Groups stack in columns, and columns sit side by side in a dock
 * on either side of the canvas; a group can also float in a window of its
 * own over the canvas, and a window can hold several groups stacked, as a
 * column does. A column can also be folded to icons, as Photoshop's are: a
 * button for each panel, which shows its group beside the column until
 * something else is clicked. A panel is open when it's in the layout
 * anywhere, and shown when it's its group's front tab, the group isn't
 * folded and its column isn't folded to icons.
 *
 * Everything here is pure, and works on plain data that JSON keeps as it is:
 * the app saves the layout per browser (workspace.ts), check-commands runs
 * these in Node, and the dock (Dock.tsx) only turns pointer moves into
 * calls. Sizes are in the interface's own pixels, before Edit → Interface
 * scales them.
 *
 * A group is named by any panel in it, since a panel is in one group at
 * most. Moves name their target the same way, by a panel already there, so
 * a target still means the same place once what moves has left its old one.
 */
import { PANELS, type PanelId } from './panels'

export type Side = 'left' | 'right'

export interface PanelGroup {
  /** Its tabs, in order. Never empty. */
  panels: PanelId[]
  /** The tab in front. */
  active: PanelId
  /** Folded down to its tabs. */
  collapsed: boolean
  /** Its height, when one has been dragged; null takes the height of what's in it. */
  height: number | null
}

export interface Column {
  /** Its width when it isn't folded to icons, kept while it is. */
  width: number
  /** Folded to a strip of icons, a button a panel. */
  icons: boolean
  /** Top to bottom. Never empty. */
  groups: PanelGroup[]
}

export interface FloatWindow {
  /** The window's top left, from the window's top left. */
  x: number
  y: number
  width: number
  height: number | null
  /** Top to bottom, as in a column. Never empty. */
  groups: PanelGroup[]
}

/** Where a closed panel was, so opening it again puts it back. */
export interface ClosedPlace {
  /** A panel it shared a group with. */
  with: PanelId | null
  /** The panel at the front of the group above it in its column or window. */
  after: PanelId | null
  /** The panel at the front of the group below it, when it was at the top. */
  before?: PanelId | null
  side: Side
  /** Where its window was, when it was alone in one. */
  float?: { x: number; y: number; width: number }
}

export interface Layout {
  /** Each dock's columns in screen order, left to right. */
  left: Column[]
  right: Column[]
  /** Back to front. */
  floats: FloatWindow[]
  /** Where closed panels were. Not part of how a workspace looks. */
  closed: Partial<Record<PanelId, ClosedPlace>>
}

export const COLUMN_MIN = 220
export const COLUMN_MAX = 560
export const COLUMN_DEFAULT = 300
export const GROUP_MIN = 60
export const GROUP_MAX = 2000
export const FLOAT_MIN_WIDTH = 200
export const FLOAT_MAX_WIDTH = 900
export const FLOAT_MIN_HEIGHT = 80

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)))
export const clampColumn = (w: number) => clamp(w, COLUMN_MIN, COLUMN_MAX)
export const clampGroupHeight = (h: number) => clamp(h, GROUP_MIN, GROUP_MAX)
export const clampFloatWidth = (w: number) => clamp(w, FLOAT_MIN_WIDTH, FLOAT_MAX_WIDTH)

export const group = (panels: PanelId[], active: PanelId = panels[0]): PanelGroup => ({ panels, active, collapsed: false, height: null })

/** One column on the right with a group per panel, in the order given: the shape of the task workspaces. */
export function columnLayout(panels: PanelId[], width = COLUMN_DEFAULT): Layout {
  return { left: [], right: panels.length ? [{ width: clampColumn(width), icons: false, groups: panels.map((p) => group([p])) }] : [], floats: [], closed: {} }
}

export const emptyLayout = (): Layout => ({ left: [], right: [], floats: [], closed: {} })

// --- finding --------------------------------------------------------------------

/** Where a group is: in a dock's column, or in a window (`index`), `sub` down from its top. */
export type Place = { where: 'dock'; side: Side; col: number; index: number; group: PanelGroup } | { where: 'float'; index: number; sub: number; group: PanelGroup }

/** Every group, docked and floating, with where it is. */
export function groups(l: Layout): Place[] {
  const out: Place[] = []
  for (const side of ['left', 'right'] as const) l[side].forEach((c, col) => c.groups.forEach((group, index) => out.push({ where: 'dock', side, col, index, group })))
  l.floats.forEach((f, index) => f.groups.forEach((group, sub) => out.push({ where: 'float', index, sub, group })))
  return out
}

export const find = (l: Layout, id: PanelId): Place | null => groups(l).find((p) => p.group.panels.includes(id)) ?? null
export const isOpen = (l: Layout, id: PanelId) => !!find(l, id)
/** Whether a panel is in a column folded to icons. */
export function inIcons(l: Layout, id: PanelId) {
  const p = find(l, id)
  return p?.where === 'dock' && l[p.side][p.col].icons
}
/** Open, in front in its group, the group not folded and its column not folded to icons: what the Window menu ticks. */
export function isShown(l: Layout, id: PanelId) {
  const p = find(l, id)
  return !!p && p.group.active === id && !p.group.collapsed && !inIcons(l, id)
}
export const openPanels = (l: Layout): PanelId[] => groups(l).flatMap((p) => p.group.panels)
export const hasDocked = (l: Layout) => l.left.length > 0 || l.right.length > 0

// --- changing groups in place -------------------------------------------------------

/** The layout with the group holding `id` changed by `f`; the same layout when it isn't open. */
export function updateGroup(l: Layout, id: PanelId, f: (g: PanelGroup) => PanelGroup): Layout {
  const p = find(l, id)
  if (!p) return l
  if (p.where === 'float') return { ...l, floats: l.floats.map((w, i) => (i === p.index ? { ...w, groups: w.groups.map((g, gi) => (gi === p.sub ? f(g) : g)) } : w)) }
  return {
    ...l,
    [p.side]: l[p.side].map((c, ci) => (ci === p.col ? { ...c, groups: c.groups.map((g, gi) => (gi === p.index ? f(g) : g)) } : c)),
  }
}

export const toggleCollapsed = (l: Layout, id: PanelId) => updateGroup(l, id, (g) => ({ ...g, collapsed: !g.collapsed }))
export const setGroupHeight = (l: Layout, id: PanelId, h: number | null) => updateGroup(l, id, (g) => ({ ...g, height: h === null ? null : clampGroupHeight(h) }))

/** Brings a tab to the front of its group, and unfolds the group. */
export const activate = (l: Layout, id: PanelId) => updateGroup(l, id, (g) => (g.active === id && !g.collapsed ? g : { ...g, active: id, collapsed: false }))

export function setColumnWidth(l: Layout, side: Side, col: number, w: number): Layout {
  if (!l[side][col]) return l
  return { ...l, [side]: l[side].map((c, i) => (i === col ? { ...c, width: clampColumn(w) } : c)) }
}

/** Folds the column holding `id` to icons, or opens it out again. */
export function setIcons(l: Layout, id: PanelId, icons: boolean): Layout {
  const p = find(l, id)
  if (!p || p.where !== 'dock' || l[p.side][p.col].icons === icons) return l
  return { ...l, [p.side]: l[p.side].map((c, i) => (i === p.col ? { ...c, icons } : c)) }
}

// --- taking out ------------------------------------------------------------------

/** Drops emptied groups, columns and windows, and keeps each group's front tab one of its own. */
function prune(l: Layout): Layout {
  const fix = (g: PanelGroup): PanelGroup | null => (g.panels.length === 0 ? null : g.panels.includes(g.active) ? g : { ...g, active: g.panels[0] })
  const cols = (cs: Column[]) =>
    cs.map((c) => ({ ...c, groups: c.groups.map(fix).filter((g): g is PanelGroup => !!g) })).filter((c) => c.groups.length > 0)
  return {
    ...l,
    left: cols(l.left),
    right: cols(l.right),
    floats: l.floats.map((f) => ({ ...f, groups: f.groups.map(fix).filter((g): g is PanelGroup => !!g) })).filter((f) => f.groups.length > 0),
  }
}

/** The layout with every group passed through `f`, which can return a group or null to remove it. */
function mapGroups(l: Layout, f: (g: PanelGroup) => PanelGroup | null): Layout {
  const empty = (g: PanelGroup): PanelGroup => ({ ...g, panels: [] })
  const cols = (cs: Column[]) => cs.map((c) => ({ ...c, groups: c.groups.map((g) => f(g) ?? empty(g)) }))
  return prune({ ...l, left: cols(l.left), right: cols(l.right), floats: l.floats.map((w) => ({ ...w, groups: w.groups.map((g) => f(g) ?? empty(g)) })) })
}

/** The tab that comes to the front when `id` leaves: the one after it, or before it at the end. */
function nextActive(g: PanelGroup, id: PanelId): PanelId {
  if (g.active !== id) return g.active
  const i = g.panels.indexOf(id)
  return g.panels[i + 1] ?? g.panels[i - 1] ?? id
}

const without = (g: PanelGroup, id: PanelId): PanelGroup => ({ ...g, panels: g.panels.filter((p) => p !== id), active: nextActive(g, id) })

/** Where a panel is, in the words opening it again uses. */
function placeOf(l: Layout, id: PanelId): ClosedPlace | null {
  const p = find(l, id)
  if (!p) return null
  const mate = p.group.panels.find((x) => x !== id) ?? null
  const stack = p.where === 'float' ? l.floats[p.index].groups : l[p.side][p.col].groups
  const at = p.where === 'float' ? p.sub : p.index
  const above = stack[at - 1]?.active ?? null
  const below = above ? null : (stack[at + 1]?.active ?? null)
  if (p.where === 'float') {
    const f = l.floats[p.index]
    const alone = !mate && f.groups.length === 1
    return { with: mate, after: above, before: below, side: 'right', ...(alone ? { float: { x: f.x, y: f.y, width: f.width } } : {}) }
  }
  return { with: mate, after: above, before: below, side: p.side }
}

/** Closes a panel, remembering where it was. */
export function closePanel(l: Layout, id: PanelId): Layout {
  const was = placeOf(l, id)
  if (!was) return l
  const out = mapGroups(l, (g) => (g.panels.includes(id) ? without(g, id) : g))
  return { ...out, closed: { ...out.closed, [id]: was } }
}

/** Closes the group holding `id`, every tab in it. */
export function closeGroup(l: Layout, id: PanelId): Layout {
  const p = find(l, id)
  if (!p) return l
  let out = l
  for (const x of p.group.panels) out = closePanel(out, x)
  return out
}

// --- putting in ------------------------------------------------------------------

/**
 * Where something can be put:
 * - `tab`: into the group holding `group`, as a tab at `index` (the end when past it).
 * - `stack`: a new group above or below the one holding `near`, in its column
 *   or its window.
 * - `column`: a new column on `side`, before or after the one holding `near`
 *   in screen order; with no `near`, at the dock's edge by the canvas.
 * - `float`: a new window at x, y.
 */
export type Target =
  | { kind: 'tab'; group: PanelId; index: number }
  | { kind: 'stack'; near: PanelId; where: 'before' | 'after' }
  | { kind: 'column'; side: Side; near: PanelId | null; where: 'before' | 'after' }
  | { kind: 'float'; x: number; y: number; width: number; height: number | null }

/** Puts a group in at a target. The group's panels must not already be in the layout, except as a move leaves them. */
function insert(l: Layout, g: PanelGroup, t: Target): Layout {
  switch (t.kind) {
    case 'tab':
      return updateGroup(l, t.group, (x) => {
        const panels = [...x.panels]
        panels.splice(Math.max(0, Math.min(t.index, panels.length)), 0, ...g.panels)
        return { ...x, panels, active: g.active, collapsed: false }
      })
    case 'stack': {
      const p = find(l, t.near)
      if (!p) return insertDefault(l, g)
      if (p.where === 'float')
        return {
          ...l,
          floats: l.floats.map((w, i) => {
            if (i !== p.index) return w
            const groups = [...w.groups]
            groups.splice(p.sub + (t.where === 'after' ? 1 : 0), 0, { ...g, height: null })
            return { ...w, groups }
          }),
        }
      return {
        ...l,
        [p.side]: l[p.side].map((c, ci) => {
          if (ci !== p.col) return c
          const groups = [...c.groups]
          groups.splice(p.index + (t.where === 'after' ? 1 : 0), 0, g)
          return { ...c, groups }
        }),
      }
    }
    case 'column': {
      const cols = [...l[t.side]]
      const fresh: Column = { width: COLUMN_DEFAULT, icons: false, groups: [g] }
      const p = t.near ? find(l, t.near) : null
      if (p && p.where === 'dock' && p.side === t.side) {
        fresh.width = cols[p.col].width
        cols.splice(p.col + (t.where === 'after' ? 1 : 0), 0, fresh)
      } else if (t.side === 'right') cols.unshift(fresh)
      else cols.push(fresh)
      return { ...l, [t.side]: cols }
    }
    case 'float':
      return {
        ...l,
        floats: [...l.floats, { x: Math.round(t.x), y: Math.round(t.y), width: clampFloatWidth(t.width), height: t.height === null ? null : clampGroupHeight(t.height), groups: [{ ...g, height: null }] }],
      }
  }
}

/** A new group at the foot of the dock by the canvas on the right: where a panel goes that has nowhere better. */
function insertDefault(l: Layout, g: PanelGroup): Layout {
  if (l.right.length === 0) return { ...l, right: [{ width: COLUMN_DEFAULT, icons: false, groups: [g] }] }
  return { ...l, right: l.right.map((c, i) => (i === 0 ? { ...c, groups: [...c.groups, g] } : c)) }
}

/** Opens a panel where it was when it was closed, or brings it to the front when it's open. */
export function openPanel(l: Layout, id: PanelId): Layout {
  if (isOpen(l, id)) return activate(l, id)
  const was = l.closed[id]
  const { [id]: _, ...closed } = l.closed
  const base = { ...l, closed }
  const g = group([id])
  if (was?.with && isOpen(base, was.with)) return insert(base, g, { kind: 'tab', group: was.with, index: Infinity })
  if (was?.float) return insert(base, g, { kind: 'float', ...was.float, height: null })
  if (was?.after && isOpen(base, was.after)) return insert(base, g, { kind: 'stack', near: was.after, where: 'after' })
  if (was?.before && isOpen(base, was.before)) return insert(base, g, { kind: 'stack', near: was.before, where: 'before' })
  if (was && !was.after && base[was.side].length) {
    // It was at the top of a column: the top of the dock's column by the canvas.
    const col = was.side === 'right' ? base.right[0] : base.left[base.left.length - 1]
    return insert(base, g, { kind: 'stack', near: col.groups[0].active, where: 'before' })
  }
  return insertDefault(base, g)
}

/** What the Window menu does: shows a panel that isn't shown, and closes one that is. */
export const togglePanel = (l: Layout, id: PanelId) => (isShown(l, id) ? closePanel(l, id) : openPanel(l, id))

/**
 * Moves a panel, or with `whole` the group it's in, to a target. Moving a
 * panel to its own group reorders the tabs; a move that would put things
 * back where they are leaves the layout as it is.
 */
export function move(l: Layout, id: PanelId, t: Target, whole = false): Layout {
  const from = find(l, id)
  if (!from) return l
  const src = from.group
  const all = whole || src.panels.length === 1
  if ((t.kind === 'tab' || t.kind === 'stack') && src.panels.includes(t.kind === 'tab' ? t.group : t.near)) {
    if (t.kind === 'stack' || all) return l
    // Reordering its own tabs.
    return updateGroup(l, id, (g) => {
      const at = g.panels.indexOf(id)
      const panels = g.panels.filter((p) => p !== id)
      panels.splice(Math.max(0, Math.min(t.index > at ? t.index - 1 : t.index, panels.length)), 0, id)
      return { ...g, panels, active: id }
    })
  }
  if (t.kind === 'column' && t.near && all && src.panels.includes(t.near)) {
    // A new column beside the one it's in: when it's alone there, nothing changes.
    if (from.where === 'dock' && from.side === t.side && l[t.side][from.col].groups.length === 1) return l
  }
  const moving: PanelGroup = all ? { ...src, collapsed: t.kind === 'float' ? false : src.collapsed, height: t.kind === 'stack' ? src.height : null } : group([id])
  if (t.kind === 'float' && all && from.where === 'float' && l.floats[from.index].groups.length === 1) {
    // A window of one group dragged to somewhere else over the canvas just moves.
    return { ...l, floats: l.floats.map((f, i) => (i === from.index ? { ...f, x: Math.round(t.x), y: Math.round(t.y) } : f)) }
  }
  // In at the target first, then out of where it was: named by panels, the
  // target can't be lost to what the move empties.
  const marked = { ...src, panels: src.panels.map((p) => `~${p}` as PanelId) }
  const placeholder = (g: PanelGroup) => (g === src ? marked : g)
  let out = mapGroups(l, placeholder)
  const near = (p: PanelId | null) => (p && src.panels.includes(p) ? (`~${p}` as PanelId) : p)
  const target: Target = t.kind === 'column' ? { ...t, near: near(t.near) } : t
  out = insert(out, moving, target)
  out = mapGroups(out, (g) => {
    if (!g.panels.some((p) => p.startsWith('~'))) return g
    if (all) return null
    const left = g.panels.filter((p) => p !== `~${id}`).map((p) => p.slice(1) as PanelId)
    return { ...g, panels: left, active: nextActive(src, id) }
  })
  const { [id]: _, ...closed } = out.closed
  return { ...out, closed }
}

// --- floating windows ----------------------------------------------------------------

/**
 * Moves a whole window, every group in it, to a target: over the canvas it
 * just moves; anywhere else its groups go in at the target in order, the
 * first where the target says and the rest stacked under it (or, onto a
 * group's tabs, as more tabs there). A target in the window itself leaves
 * the layout as it is.
 */
export function moveWindow(l: Layout, index: number, t: Target): Layout {
  const w = l.floats[index]
  if (!w) return l
  if (t.kind === 'float') return moveFloat(l, index, t.x, t.y)
  const mine = new Set(w.groups.flatMap((g) => g.panels))
  const near = t.kind === 'tab' ? t.group : t.near
  if (near && mine.has(near)) return l
  const anchors = w.groups.map((g) => g.active)
  let out = move(l, anchors[0], t, true)
  let at = t.kind === 'tab' ? t.index : 0
  for (let i = 1; i < anchors.length; i++) {
    at += w.groups[i - 1].panels.length
    out = move(out, anchors[i], t.kind === 'tab' ? { kind: 'tab', group: t.group, index: at } : { kind: 'stack', near: anchors[i - 1], where: 'after' }, true)
  }
  return out
}

export function moveFloat(l: Layout, index: number, x: number, y: number): Layout {
  return { ...l, floats: l.floats.map((f, i) => (i === index ? { ...f, x: Math.round(x), y: Math.round(y) } : f)) }
}

export function resizeFloat(l: Layout, index: number, width: number, height: number | null): Layout {
  return { ...l, floats: l.floats.map((f, i) => (i === index ? { ...f, width: clampFloatWidth(width), height: height === null ? null : Math.max(FLOAT_MIN_HEIGHT, Math.round(height)) } : f)) }
}

/** Brings a window to the front. */
export function raiseFloat(l: Layout, index: number): Layout {
  if (index === l.floats.length - 1 || !l.floats[index]) return l
  return { ...l, floats: [...l.floats.filter((_, i) => i !== index), l.floats[index]] }
}

/** Where a window is drawn in a window of a given size: never so far off that its title bar can't be reached. */
export function floatOnScreen(f: FloatWindow, viewW: number, viewH: number): { x: number; y: number } {
  return { x: Math.min(Math.max(f.x, 40 - f.width), Math.max(0, viewW - 60)), y: Math.min(Math.max(f.y, 0), Math.max(0, viewH - 30)) }
}

// --- comparing and reading ------------------------------------------------------------

/** How a layout looks, for telling whether it's still as designed: where closed panels were doesn't count. */
export const sameLayout = (a: Layout, b: Layout) => JSON.stringify({ ...a, closed: {} }) === JSON.stringify({ ...b, closed: {} })

const PANEL_IDS = new Set<string>(PANELS.map((p) => p.id))
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A layout from saved data, field by field. A panel since removed is
 * dropped, one listed twice is kept where it's first, sizes out of range are
 * clamped, and what's left empty goes. Null when there's nothing to read.
 */
export function readLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<Record<keyof Layout, unknown>>
  const seen = new Set<string>()
  const readGroup = (x: unknown): PanelGroup | null => {
    if (!x || typeof x !== 'object') return null
    const g = x as Partial<Record<keyof PanelGroup, unknown>>
    const panels: PanelId[] = []
    for (const p of Array.isArray(g.panels) ? g.panels : [])
      if (typeof p === 'string' && PANEL_IDS.has(p) && !seen.has(p)) {
        seen.add(p)
        panels.push(p as PanelId)
      }
    if (!panels.length) return null
    return {
      panels,
      active: panels.includes(g.active as PanelId) ? (g.active as PanelId) : panels[0],
      collapsed: g.collapsed === true,
      height: num(g.height) ? clampGroupHeight(g.height) : null,
    }
  }
  const readColumns = (x: unknown): Column[] =>
    (Array.isArray(x) ? x : [])
      .map((c): Column | null => {
        if (!c || typeof c !== 'object') return null
        const groups = (Array.isArray(c.groups) ? c.groups : []).map(readGroup).filter((g: PanelGroup | null): g is PanelGroup => !!g)
        return groups.length ? { width: num(c.width) ? clampColumn(c.width) : COLUMN_DEFAULT, icons: c.icons === true, groups } : null
      })
      .filter((c): c is Column => !!c)
  const left = readColumns(r.left)
  const right = readColumns(r.right)
  const floats = (Array.isArray(r.floats) ? r.floats : [])
    .map((f): FloatWindow | null => {
      if (!f || typeof f !== 'object') return null
      // Several groups, or one, as windows held before they stacked.
      const groups = (Array.isArray(f.groups) ? f.groups : [f.group]).map(readGroup).filter((g: PanelGroup | null): g is PanelGroup => !!g)
      if (!groups.length) return null
      return {
        x: num(f.x) ? Math.round(f.x) : 80,
        y: num(f.y) ? Math.round(f.y) : 80,
        width: num(f.width) ? clampFloatWidth(f.width) : COLUMN_DEFAULT,
        height: num(f.height) ? Math.max(FLOAT_MIN_HEIGHT, Math.round(f.height)) : null,
        groups: groups.map((g: PanelGroup) => ({ ...g, height: null })),
      }
    })
    .filter((f): f is FloatWindow => !!f)
  const closed: Layout['closed'] = {}
  if (r.closed && typeof r.closed === 'object')
    for (const [id, c] of Object.entries(r.closed as Record<string, unknown>)) {
      if (!PANEL_IDS.has(id) || seen.has(id) || !c || typeof c !== 'object') continue
      const k = c as Partial<Record<keyof ClosedPlace, unknown>>
      const pid = (v: unknown) => (typeof v === 'string' && PANEL_IDS.has(v) ? (v as PanelId) : null)
      const f = k.float as Record<string, unknown> | undefined
      closed[id as PanelId] = {
        with: pid(k.with),
        after: pid(k.after),
        ...(pid(k.before) ? { before: pid(k.before) } : {}),
        side: k.side === 'left' ? 'left' : 'right',
        ...(f && num(f.x) && num(f.y) && num(f.width) ? { float: { x: Math.round(f.x), y: Math.round(f.y), width: clampFloatWidth(f.width) } } : {}),
      }
    }
  return { left, right, floats, closed }
}
