/**
 * The autosave journal: every open document, as it is right now, kept in
 * the browser's private storage, so closing the tab, a crash or a power cut
 * loses nothing. The next visit reopens what was open, unsaved changes and
 * all, the way a code editor does.
 *
 *   session.json        which documents were open, in which order, which
 *                       was in front, which file each came from, whether
 *                       each had unsaved changes, and its panel view state
 *   docs/<key>.json     each document's JSON
 *
 * Phase 3 adds content-addressed tile packs beside these (blobs/<hash>), so
 * a save after one brush stroke writes the tiles that stroke made and
 * nothing else.
 *
 * Written against JournalStore rather than OPFS directly, so the checks run
 * all of it in Node against a store in memory.
 */
import type { Doc, NodeId } from '../doc/types'
import { docToJson, readDocJson } from '../doc/serialize'

export interface JournalStore {
  read(path: string): Promise<Uint8Array | null>
  /** Replaces the file whole. A reader never sees a half-written file. */
  write(path: string, data: Uint8Array): Promise<void>
  remove(path: string): Promise<void>
  /** The names of the files in a directory, not recursive. */
  list(dir: string): Promise<string[]>
}

const JOURNAL_VERSION = 1

export interface FileRef {
  /** The key the file handle is stored under in IndexedDB, when there is one. */
  handleKey: string | null
  /** The file's name, for the tab and the title. */
  name: string
}

export interface SessionDoc {
  key: string
  file: FileRef | null
  /** False when it has changes not saved to its file. */
  clean: boolean
  /** Layers folded in the layers panel. */
  folded: NodeId[]
  /** A smart object's contents opened from another document: that document and the smart object's node. */
  parent?: { key: string; node: NodeId } | null
}

export interface Session {
  version: number
  active: string | null
  docs: SessionDoc[]
}

export interface RestoredDoc extends SessionDoc {
  doc: Doc
  warnings: string[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const docPath = (key: string) => `docs/${key}.json`

export async function writeSession(store: JournalStore, s: Omit<Session, 'version'>) {
  await store.write('session.json', enc.encode(JSON.stringify({ version: JOURNAL_VERSION, ...s })))
}

export async function writeJournalDoc(store: JournalStore, key: string, doc: Doc) {
  await store.write(docPath(key), enc.encode(docToJson(doc)))
}

export async function removeJournalDoc(store: JournalStore, key: string) {
  await store.remove(docPath(key))
}

export async function readJournalDoc(store: JournalStore, key: string) {
  const bytes = await store.read(docPath(key))
  return bytes ? readDocJson(dec.decode(bytes)) : null
}

/**
 * What was open last time, read back as defensively as a file: a session
 * that can't be read gives nothing to restore rather than an error, and a
 * document that can't be read is reported and skipped, without costing the
 * others. Documents in the journal that the session doesn't list (left by a
 * crash between two writes) are restored too, at the end, rather than lost.
 */
export async function restoreSession(store: JournalStore): Promise<{ docs: RestoredDoc[]; active: string | null; problems: string[] }> {
  const problems: string[] = []
  let session: Session = { version: JOURNAL_VERSION, active: null, docs: [] }
  const raw = await store.read('session.json').catch(() => null)
  if (raw) {
    try {
      const s = JSON.parse(dec.decode(raw)) as Partial<Session>
      if (Array.isArray(s.docs)) {
        session = {
          version: JOURNAL_VERSION,
          active: typeof s.active === 'string' ? s.active : null,
          docs: s.docs.filter((d): d is SessionDoc => !!d && typeof d.key === 'string' && /^[a-z0-9-]+$/i.test(d.key)),
        }
      }
    } catch {
      problems.push('The list of open documents was damaged; reopened what could be found.')
    }
  }

  const listed = new Set(session.docs.map((d) => d.key))
  const files = await store.list('docs').catch(() => [] as string[])
  for (const f of files) {
    const key = f.replace(/\.json$/, '')
    if (f.endsWith('.json') && !listed.has(key) && /^[a-z0-9-]+$/i.test(key)) {
      session.docs.push({ key, file: null, clean: false, folded: [] })
    }
  }

  const docs: RestoredDoc[] = []
  for (const d of session.docs) {
    const read = await readJournalDoc(store, d.key).catch(() => null)
    if (!read) continue
    if (!read.ok) {
      problems.push(`A document could not be restored: ${read.error}`)
      continue
    }
    docs.push({
      key: d.key,
      file: d.file && typeof d.file.name === 'string' ? { name: d.file.name, handleKey: typeof d.file.handleKey === 'string' ? d.file.handleKey : null } : null,
      clean: d.clean === true,
      folded: Array.isArray(d.folded) ? d.folded.filter((x) => typeof x === 'string') : [],
      parent: d.parent && typeof d.parent.key === 'string' && typeof d.parent.node === 'string' ? { key: d.parent.key, node: d.parent.node } : null,
      doc: read.doc,
      warnings: read.warnings,
    })
  }
  const active = docs.some((d) => d.key === session.active) ? session.active : (docs[docs.length - 1]?.key ?? null)
  return { docs, active, problems }
}

/** A JournalStore in memory, for the checks and for browsers with no private storage. */
export function memoryStore(): JournalStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    read: async (p) => files.get(p)?.slice() ?? null,
    write: async (p, d) => void files.set(p, d.slice()),
    remove: async (p) => void files.delete(p),
    list: async (dir) =>
      [...files.keys()].filter((k) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/')).map((k) => k.slice(dir.length + 1)),
  }
}
