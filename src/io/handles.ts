/**
 * File handles and the recent-files list, kept in IndexedDB.
 *
 * A FileSystemFileHandle (Chromium's File System Access API) can be stored
 * and read back across visits, which is what lets a reopened document still
 * save to the file it came from, and what lets the start screen list recent
 * files. The browser asks again for permission to write when the page is
 * next opened; that's its rule, and requestWrite below is where we ask.
 *
 * Everything here is optional comfort. Each call is guarded, and without
 * IndexedDB or file handles the app works on, with downloads instead of
 * saving in place and no recent list.
 */

const DB = 'plexel'
const HANDLES = 'handles'
const RECENT_KEY = 'recent'
const META = 'meta'
/** How many files the start screen lists. */
const RECENT_LIMIT = 12

export interface RecentFile {
  handleKey: string
  name: string
  /** When it was last opened or saved, ms since the epoch. */
  at: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(HANDLES)
        req.result.createObjectStore(META)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const d = await db()
  if (!d) return null
  return new Promise((resolve) => {
    try {
      const req = fn(d.transaction(store, mode).objectStore(store))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

const newKey = () => `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Stores a handle and returns its key. A handle to a file already stored
 * reuses that file's key, so the recent list doesn't fill with the same file.
 */
export async function storeHandle(handle: FileSystemFileHandle): Promise<string | null> {
  for (const r of await recentFiles()) {
    const h = await loadHandle(r.handleKey)
    if (h && (await h.isSameEntry(handle).catch(() => false))) return r.handleKey
  }
  const key = newKey()
  const ok = await run(HANDLES, 'readwrite', (s) => s.put(handle, key))
  return ok === null ? null : key
}

export async function loadHandle(key: string): Promise<FileSystemFileHandle | null> {
  const h = await run<unknown>(HANDLES, 'readonly', (s) => s.get(key))
  return h && typeof h === 'object' && 'getFile' in h ? (h as FileSystemFileHandle) : null
}

export async function recentFiles(): Promise<RecentFile[]> {
  const list = await run<unknown>(META, 'readonly', (s) => s.get(RECENT_KEY))
  if (!Array.isArray(list)) return []
  return list.filter((r): r is RecentFile => !!r && typeof r.handleKey === 'string' && typeof r.name === 'string' && typeof r.at === 'number')
}

/** Puts a file at the top of the recent list. */
export async function touchRecent(handleKey: string, name: string) {
  const list = (await recentFiles()).filter((r) => r.handleKey !== handleKey)
  list.unshift({ handleKey, name, at: Date.now() })
  const kept = list.slice(0, RECENT_LIMIT)
  await run(META, 'readwrite', (s) => s.put(kept, RECENT_KEY))
  // Handles that fell off the end aren't needed any more.
  for (const r of list.slice(RECENT_LIMIT)) await run(HANDLES, 'readwrite', (s) => s.delete(r.handleKey))
}

export async function forgetRecent(handleKey: string) {
  const list = (await recentFiles()).filter((r) => r.handleKey !== handleKey)
  await run(META, 'readwrite', (s) => s.put(list, RECENT_KEY))
}

type PermissionHandle = FileSystemFileHandle & {
  queryPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

/**
 * Makes sure we may write to the file, asking if need be. Must be called
 * from a click or a key press, or the browser refuses to ask.
 */
export async function requestWrite(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as PermissionHandle
  if (!h.queryPermission) return true
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
}

export async function requestRead(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as PermissionHandle
  if (!h.queryPermission) return true
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
  return (await h.requestPermission?.({ mode: 'read' })) === 'granted'
}
