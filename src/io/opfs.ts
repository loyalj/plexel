/**
 * The journal's store in the Origin Private File System: the browser's own
 * private disk for this site, invisible to the user's file system, and
 * much larger than localStorage.
 *
 * Every file lives under `journal/`. A write goes through createWritable,
 * which keeps the old contents until the new ones are closed, so a crash
 * mid-write leaves the previous version rather than half of the new one.
 * Browsers without createWritable on the page get the same writes through a
 * worker using a sync access handle, which every browser with OPFS has.
 * That path rewrites the file in place, so it lacks the guarantee: a crash
 * mid-write there can leave a damaged journal entry, which the restore
 * reports and skips.
 */
import type { JournalStore } from './journal'

async function dirFor(root: string, path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(root, { create: true })
  const parts = path.split('/')
  const name = parts.pop()!
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create })
  return { dir, name }
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>()

function writeInWorker(root: string, path: string, data: Uint8Array): Promise<void> {
  worker ??= (() => {
    const w = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module', name: 'plexel-storage' })
    w.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => {
      const p = pending.get(e.data.id)
      pending.delete(e.data.id)
      if (e.data.error) p?.reject(new Error(e.data.error))
      else p?.resolve()
    }
    return w
  })()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, path: `${root}/${path}`, data }, [data.buffer])
  })
}

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
}

/**
 * A store over one top-level OPFS folder: `journal` for the autosave,
 * `spill` for tiles the tile store has no memory for.
 */
export function opfsStoreAt(root: string): JournalStore & { clear(): Promise<void> } {
  return {
    async read(path) {
      try {
        const { dir, name } = await dirFor(root, path, false)
        const file = await (await dir.getFileHandle(name)).getFile()
        return new Uint8Array(await file.arrayBuffer())
      } catch {
        return null
      }
    },
    async write(path, data) {
      const { dir, name } = await dirFor(root, path, true)
      const handle = await dir.getFileHandle(name, { create: true })
      if ('createWritable' in handle) {
        const w = await handle.createWritable()
        try {
          await w.write(data as BufferSource)
          await w.close()
        } catch (e) {
          await w.abort().catch(() => {})
          throw e
        }
      } else {
        await writeInWorker(root, path, data.slice())
      }
    },
    async remove(path) {
      try {
        const { dir, name } = await dirFor(root, path, false)
        await dir.removeEntry(name)
      } catch {
        // Already gone is as good as removed.
      }
    },
    async list(path) {
      try {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(root)
        for (const p of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(p)
        const names: string[] = []
        for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          if (h.kind === 'file') names.push(name)
        }
        return names
      } catch {
        return []
      }
    },
    /** Removes the whole folder and everything in it. */
    async clear() {
      try {
        await (await navigator.storage.getDirectory()).removeEntry(root, { recursive: true })
      } catch {
        // Nothing there to clear.
      }
    },
  }
}

/** The autosave journal's store. */
export const opfsStore = opfsStoreAt('journal')

/** Asks the browser not to clear this site's storage under pressure. Granted quietly or not at all. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    // Nothing lost: the storage simply stays "best effort".
  }
}
