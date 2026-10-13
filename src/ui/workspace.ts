/**
 * The workspace: where the panels are (layout.ts), in one of the task
 * workspaces (Essentials, Painting, Photo, Vector, Type, Print) or one of
 * your own, named and saved with Window → Workspace → New Workspace.
 *
 * View state, not document state: it has no undo, and it's kept per browser
 * under its own versioned key. Loading is defensive in the usual way. A
 * panel since removed is dropped, a new one is left closed, and a size out
 * of range is clamped rather than trusted. A save from before docking
 * (`plexel.workspace.v1`) is read once and carried over.
 *
 * Each workspace remembers how it was left, as Photoshop's do: open a panel
 * in Painting, switch to Photo and back, and the panel is still open there.
 * Reset puts the current one back as it was designed: a task workspace as
 * Plexel ships it, one of your own as you last saved it.
 */
import { PANELS, type PanelId } from './panels'
import { COLUMN_DEFAULT, columnLayout, readLayout, sameLayout, type Layout } from './layout'

export type WorkspaceId = 'essentials' | 'painting' | 'photo' | 'vector' | 'type' | 'print'

export interface WorkspaceDef {
  id: WorkspaceId
  name: string
  /** What it's for, for the menu's tooltip and the switcher. */
  hint: string
  /** The panels it opens, top to bottom in one column on the right. */
  panels: PanelId[]
  dockWidth: number
}

export const WORKSPACES: WorkspaceDef[] = [
  { id: 'essentials', name: 'Essentials', hint: 'Properties, Colour and Layers: a little of everything.', panels: PANELS.filter((p) => p.defaultOpen).map((p) => p.id), dockWidth: 300 },
  { id: 'painting', name: 'Painting', hint: 'Colour, Swatches, the brushes and their settings, Layers.', panels: ['colour', 'swatches', 'brushes', 'brush-settings', 'layers'], dockWidth: 320 },
  { id: 'photo', name: 'Photo', hint: 'Properties for adjustments, Layers, Channels and History.', panels: ['properties', 'colour', 'layers', 'channels', 'history'], dockWidth: 300 },
  { id: 'vector', name: 'Vector', hint: 'Properties for shapes and paths, Colour, Swatches, Patterns and Layers.', panels: ['properties', 'colour', 'swatches', 'layers', 'patterns'], dockWidth: 300 },
  { id: 'type', name: 'Type', hint: 'Character and Paragraph, Properties and Layers.', panels: ['properties', 'character', 'paragraph', 'layers'], dockWidth: 320 },
  { id: 'print', name: 'Print', hint: 'Separations, Swatches with spot colours, Colour and Layers.', panels: ['colour', 'swatches', 'separations', 'layers'], dockWidth: 300 },
]

export const WORKSPACE_BY_ID = new Map(WORKSPACES.map((w) => [w.id, w]))
const isBuiltin = (id: string): id is WorkspaceId => WORKSPACE_BY_ID.has(id as WorkspaceId)

/** A workspace of your own: its name and the layout it was saved with. */
export interface CustomWorkspace {
  /** `user-…`, never one of the task workspaces' ids. */
  id: string
  name: string
  layout: Layout
}

export interface Workspace {
  /** The workspace in use: a task workspace's id or one of your own. */
  current: string
  /** Where the panels are now. */
  layout: Layout
  /** How the other workspaces were left, to come back to. */
  kept: Record<string, Layout>
  /** Your own, in the order they were made. */
  custom: CustomWorkspace[]
}

export const MAX_NAME = 40
const KEY = 'plexel.workspace.v2'
const OLD_KEY = 'plexel.workspace.v1'

/** A task workspace as designed. */
export function presetLayout(id: WorkspaceId): Layout {
  const def = WORKSPACE_BY_ID.get(id) ?? WORKSPACES[0]
  // In the dock's usual order (PANELS), whatever order the list gives them.
  return columnLayout(
    PANELS.filter((p) => def.panels.includes(p.id)).map((p) => p.id),
    def.dockWidth,
  )
}

export function defaultWorkspace(): Workspace {
  return { current: 'essentials', layout: presetLayout('essentials'), kept: {}, custom: [] }
}

/** Every workspace, the task ones first, for the menu and the switcher. */
export const allWorkspaces = (ws: Workspace): { id: string; name: string; custom: boolean }[] => [
  ...WORKSPACES.map((w) => ({ id: w.id as string, name: w.name, custom: false })),
  ...ws.custom.map((w) => ({ id: w.id, name: w.name, custom: true })),
]

export const workspaceName = (ws: Workspace, id = ws.current) => (isBuiltin(id) ? WORKSPACE_BY_ID.get(id)!.name : (ws.custom.find((w) => w.id === id)?.name ?? 'Workspace'))
export const isCustom = (ws: Workspace, id = ws.current) => ws.custom.some((w) => w.id === id)

/** A workspace as designed, or null when there's no such workspace. */
export function designOf(ws: Workspace, id: string): Layout | null {
  if (isBuiltin(id)) return presetLayout(id)
  return ws.custom.find((w) => w.id === id)?.layout ?? null
}

/** Changes to another workspace, keeping how this one was left. */
export function switchWorkspace(ws: Workspace, id: string): Workspace {
  if (id === ws.current) return ws
  const design = designOf(ws, id)
  if (!design) return ws
  const kept = { ...ws.kept, [ws.current]: ws.layout }
  const next = kept[id] ?? design
  delete kept[id]
  return { ...ws, current: id, layout: next, kept }
}

/** Puts the current workspace back as designed. */
export const resetWorkspace = (ws: Workspace): Workspace => ({ ...ws, layout: designOf(ws, ws.current) ?? presetLayout('essentials') })

/** Whether the workspace is still as designed, for the menu's Reset. */
export const isPristine = (ws: Workspace) => {
  const d = designOf(ws, ws.current)
  return !!d && sameLayout(d, ws.layout)
}

const tidyName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME)
const sameName = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/**
 * What's wrong with a name for a workspace of your own, or null when it's
 * fine. `self` is the workspace being renamed, whose own name is fine.
 * A name one of yours already has is fine for a new one: saving replaces it.
 */
export function nameProblem(ws: Workspace, name: string, self?: string): string | null {
  const n = tidyName(name)
  if (!n) return 'A workspace needs a name.'
  if (WORKSPACES.some((w) => sameName(w.name, n))) return `${WORKSPACES.find((w) => sameName(w.name, n))!.name} is one of Plexel’s own workspaces: choose another name.`
  if (self && ws.custom.some((w) => w.id !== self && sameName(w.name, n))) return 'Another of your workspaces has that name.'
  return null
}

/** The workspace of yours a new one by this name would replace, if any. */
export const replacedBy = (ws: Workspace, name: string) => ws.custom.find((w) => sameName(w.name, tidyName(name))) ?? null

let made = 0
const newId = () => `user-${Date.now().toString(36)}${(made++).toString(36)}`

/**
 * Saves where the panels are now as a workspace of your own, and changes to
 * it. One of yours by the same name is replaced, as Photoshop does. The
 * workspace left keeps how it was left.
 */
export const newWorkspace = (ws: Workspace, name: string): Workspace => addWorkspace(ws, name, ws.layout)

/**
 * Adds a workspace of your own with a layout (New Workspace's, or one from
 * a file), and changes to it. One of yours by the same name is replaced.
 */
export function addWorkspace(ws: Workspace, name: string, design: Layout): Workspace {
  if (nameProblem(ws, name)) return ws
  const n = tidyName(name)
  const layout = { ...design, closed: {} }
  const old = replacedBy(ws, n)
  if (old) {
    const custom = ws.custom.map((w) => (w.id === old.id ? { ...w, name: n, layout } : w))
    const kept = { ...ws.kept }
    delete kept[old.id]
    if (ws.current !== old.id) kept[ws.current] = ws.layout
    return { ...ws, custom, kept, current: old.id, layout: design }
  }
  const id = newId()
  return { ...ws, custom: [...ws.custom, { id, name: n, layout }], kept: { ...ws.kept, [ws.current]: ws.layout }, current: id, layout: design }
}

/** Saves where the panels are now into the workspace of yours in use, as its design. */
export function saveChanges(ws: Workspace): Workspace {
  if (!isCustom(ws)) return ws
  return { ...ws, custom: ws.custom.map((w) => (w.id === ws.current ? { ...w, layout: { ...ws.layout, closed: {} } } : w)) }
}

export function renameWorkspace(ws: Workspace, id: string, name: string): Workspace {
  if (!isCustom(ws, id) || nameProblem(ws, name, id)) return ws
  return { ...ws, custom: ws.custom.map((w) => (w.id === id ? { ...w, name: tidyName(name) } : w)) }
}

/** Deletes a workspace of yours. Deleting the one in use changes to Essentials, as it was left. */
export function deleteWorkspace(ws: Workspace, id: string): Workspace {
  if (!isCustom(ws, id)) return ws
  const custom = ws.custom.filter((w) => w.id !== id)
  const kept = { ...ws.kept }
  delete kept[id]
  if (ws.current !== id) return { ...ws, custom, kept }
  const layout = kept.essentials ?? presetLayout('essentials')
  delete kept.essentials
  return { current: 'essentials', layout, kept, custom }
}

// --- reading and saving --------------------------------------------------------------

/** A layout saved before docking: open and folded panels down one dock on the right. */
function readOldLayout(raw: unknown, base: WorkspaceId): Layout {
  const def = presetLayout(base)
  if (!raw || typeof raw !== 'object') return def
  const r = raw as { open?: Record<string, unknown>; collapsed?: Record<string, unknown>; dockWidth?: unknown }
  const designed = new Set(def.right[0]?.groups.flatMap((g) => g.panels) ?? [])
  const open = PANELS.filter((p) => (typeof r.open?.[p.id] === 'boolean' ? r.open[p.id] : designed.has(p.id))).map((p) => p.id)
  const width = typeof r.dockWidth === 'number' && Number.isFinite(r.dockWidth) ? r.dockWidth : (def.right[0]?.width ?? COLUMN_DEFAULT)
  const l = columnLayout(open, width)
  for (const g of l.right[0]?.groups ?? []) g.collapsed = r.collapsed?.[g.active] === true
  return l
}

/** A first-version save, carried over: the task workspaces as they were left. */
export function readOldWorkspace(text: string | null): Workspace {
  if (!text) return defaultWorkspace()
  let raw: Record<string, unknown> | null
  try {
    raw = JSON.parse(text) as Record<string, unknown> | null
  } catch {
    return defaultWorkspace()
  }
  if (!raw || typeof raw !== 'object') return defaultWorkspace()
  // Saved before there were task workspaces: that layout is Essentials, as it was left.
  const current = typeof raw.preset === 'string' && isBuiltin(raw.preset) ? raw.preset : 'essentials'
  const kept: Record<string, Layout> = {}
  if (raw.kept && typeof raw.kept === 'object')
    for (const w of WORKSPACES) {
      const k = (raw.kept as Record<string, unknown>)[w.id]
      if (k && w.id !== current) kept[w.id] = readOldLayout(k, w.id)
    }
  return { current, layout: readOldLayout(raw, current), kept, custom: [] }
}

/** A workspace from its saved text; anything unreadable is the default's. */
export function readWorkspace(text: string | null): Workspace {
  if (!text) return defaultWorkspace()
  let raw: Partial<Record<keyof Workspace, unknown>> | null
  try {
    raw = JSON.parse(text) as Partial<Record<keyof Workspace, unknown>> | null
  } catch {
    return defaultWorkspace()
  }
  if (!raw || typeof raw !== 'object') return defaultWorkspace()
  const custom: CustomWorkspace[] = []
  for (const c of Array.isArray(raw.custom) ? raw.custom : []) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id.startsWith('user-') || custom.some((x) => x.id === c.id)) continue
    const name = typeof c.name === 'string' ? tidyName(c.name) : ''
    const layout = readLayout(c.layout)
    if (!name || !layout || WORKSPACES.some((w) => sameName(w.name, name)) || custom.some((x) => sameName(x.name, name))) continue
    custom.push({ id: c.id, name, layout: { ...layout, closed: {} } })
  }
  const ws: Workspace = { current: 'essentials', layout: presetLayout('essentials'), kept: {}, custom }
  const known = (id: unknown): id is string => typeof id === 'string' && (isBuiltin(id) || custom.some((w) => w.id === id))
  // A workspace since deleted, or never there, reads as Essentials.
  const current = known(raw.current) ? raw.current : 'essentials'
  ws.current = current
  ws.layout = readLayout(raw.layout) ?? designOf(ws, current)!
  if (raw.kept && typeof raw.kept === 'object')
    for (const [id, k] of Object.entries(raw.kept as Record<string, unknown>)) {
      const l = known(id) && id !== current ? readLayout(k) : null
      if (l) ws.kept[id] = l
    }
  return ws
}

export function loadWorkspace(): Workspace {
  try {
    const text = localStorage.getItem(KEY)
    if (text !== null) return readWorkspace(text)
    return readOldWorkspace(localStorage.getItem(OLD_KEY))
  } catch {
    return defaultWorkspace()
  }
}

export function saveWorkspace(ws: Workspace) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ws))
  } catch {
    // Not worth troubling anyone over: the layout just won't be remembered.
  }
}
