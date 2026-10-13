/**
 * Writes OPFS files for browsers whose pages can't: a sync access handle,
 * which only a worker may open. The file is truncated and rewritten whole,
 * then flushed, before the page hears it's done.
 */
const scope = self as unknown as {
  postMessage(m: { id: number; error?: string }): void
  onmessage: ((e: MessageEvent<{ id: number; path: string; data: Uint8Array }>) => void) | null
}

interface SyncHandle {
  truncate(size: number): void
  write(data: Uint8Array, opts: { at: number }): number
  flush(): void
  close(): void
}

scope.onmessage = async (e) => {
  const { id, path, data } = e.data
  try {
    let dir = await navigator.storage.getDirectory()
    const parts = path.split('/')
    const name = parts.pop()!
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true })
    const file = await dir.getFileHandle(name, { create: true })
    const handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle()
    try {
      handle.truncate(0)
      handle.write(data, { at: 0 })
      handle.flush()
    } finally {
      handle.close()
    }
    scope.postMessage({ id })
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
