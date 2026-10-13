/**
 * Short messages at the bottom of the canvas: what a file open repaired,
 * why a save failed, that a file was saved. Info fades by itself; a
 * warning or error stays until it's dismissed, because a message that
 * vanishes before it's read is no message at all.
 */
export interface Notice {
  id: number
  tone: 'info' | 'warning' | 'error'
  text: string
  /** Extra lines, shown under the message: the warnings a file open produced, say. */
  details?: string[]
}

const INFO_MS = 4000

let notices: Notice[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())

export const noticeStore = {
  get: () => notices,
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

export function notify(tone: Notice['tone'], text: string, details?: string[]) {
  const n: Notice = { id: nextId++, tone, text, details: details?.length ? details : undefined }
  notices = [...notices, n]
  emit()
  if (tone === 'info') setTimeout(() => dismiss(n.id), INFO_MS)
  return n.id
}

export function dismiss(id: number) {
  const next = notices.filter((n) => n.id !== id)
  if (next.length === notices.length) return
  notices = next
  emit()
}
