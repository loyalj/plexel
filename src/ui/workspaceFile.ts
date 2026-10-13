/**
 * A workspace as a file: Window → Workspace → Export and Import.
 *
 * The file is JSON: the workspace's name, its layout (layout.ts, as the
 * browser saves it, less where closed panels were) and, when you've changed
 * any, your keyboard shortcuts (input/keymap.ts), so a setup moves to
 * another browser or computer whole. It's read the way the saved workspace
 * is, field by field: a panel this version doesn't have is dropped, sizes
 * are clamped, a key that doesn't parse is left out. A file from a later
 * version is read for what this one understands.
 */
import { readKeyChanges, type KeyChanges } from '../input/keymap'
import { readLayout, type Layout } from './layout'
import { MAX_NAME } from './workspace'

const FORMAT = 'plexel-workspace'
const VERSION = 1

/** What Export writes and the save picker offers. */
export const WORKSPACE_FILE_TYPE = { description: 'Plexel workspace', mime: 'application/json', extensions: ['.json'] as readonly string[] }

export interface WorkspaceFile {
  name: string
  layout: Layout
  /** Your keyboard shortcuts as they were exported; null when the file has none. */
  keys: KeyChanges | null
}

/** The file's text. Keys go in only when there are some. */
export function workspaceFileText(name: string, layout: Layout, keys: KeyChanges): string {
  const out: Record<string, unknown> = { format: FORMAT, version: VERSION, app: 'Plexel', name, layout: { ...layout, closed: {} } }
  if (Object.keys(keys).length) out.keys = keys
  return JSON.stringify(out, null, 2)
}

/** "Retouch / Print" → "Retouch - Print.plexel-workspace.json". */
export function workspaceFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Workspace'
  return `${safe}.plexel-workspace.json`
}

/** A workspace file read, or what's wrong with it, in words for a notice. */
export function readWorkspaceFile(text: string, fileName = ''): WorkspaceFile | { problem: string } {
  let raw: Record<string, unknown> | null
  try {
    raw = JSON.parse(text) as Record<string, unknown> | null
  } catch {
    return { problem: 'It isn’t a workspace file: it isn’t JSON.' }
  }
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) return { problem: 'It isn’t a Plexel workspace file.' }
  const layout = readLayout(raw.layout)
  if (!layout) return { problem: 'Its layout couldn’t be read.' }
  if (!layout.left.length && !layout.right.length && !layout.floats.length) return { problem: 'It has no panels that this version of Plexel has.' }
  const fromFile = fileName.replace(/\.plexel-workspace\.json$|\.json$/i, '')
  const name = (typeof raw.name === 'string' ? raw.name : fromFile).trim().replace(/\s+/g, ' ').slice(0, MAX_NAME) || 'Imported'
  const keys = raw.keys && typeof raw.keys === 'object' ? readKeyChanges(raw.keys) : null
  return { name, layout: { ...layout, closed: {} }, keys: keys && Object.keys(keys).length ? keys : null }
}
