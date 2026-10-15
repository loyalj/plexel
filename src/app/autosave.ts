/**
 * Keeps the journal in step with the open documents.
 *
 * It watches the document store, and a moment after anything changes
 * (AUTOSAVE_MS) writes each document whose state moved, then the session
 * list. A document closed is taken out of the journal. When the tab is
 * hidden or closed, pending writes go at once, because a page that's going
 * away may never get its timer back.
 *
 * The journal is the only copy of unsaved work, so its health is shown:
 * `status` says whether everything is written, and why not when it isn't.
 *
 * Pixels are journalled before the document that refers to them, and
 * profiles likewise, so a crash between the two leaves a document whose
 * every reference can be followed, never the other way round.
 */
import { addDocumentFonts } from './fonts'
import { fontsToCarry } from './fontEmbed'
import { documents, isDirty, type DocsState } from './documents'
import { removeJournalDoc, restoreSession, writeJournalDoc, writeSession, type JournalStore } from '../io/journal'
import { dropLostSets, tileSetsOf } from '../doc/edit'
import type { Doc } from '../doc/types'
import type { AssetStore } from '../io/assets'
import { Listeners } from '../lib/listeners'

/**
 * The tile sets' side of the journal, which lives in the engine worker
 * beside the tiles (tiles/journal.ts). Null when this tab doesn't own the
 * journal.
 */
export interface PixelJournal {
  write(ids: string[]): Promise<unknown>
  restore(ids: string[]): Promise<{ missing: string[] }>
  collect(live: string[]): Promise<unknown>
}

const AUTOSAVE_MS = 400

export type AutosaveStatus = { state: 'idle' | 'pending' | 'writing' } | { state: 'failed'; reason: string } | { state: 'unavailable'; reason: string }

export class Autosave {
  private written = new Map<string, Doc>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  private statusValue: AutosaveStatus = { state: 'idle' }
  private changes = new Listeners()
  private unsubscribe: (() => void) | null = null

  private profilesWritten = new Set<string>()
  private fontsWritten = new Set<string>()

  constructor(
    private store: JournalStore,
    private pixels: PixelJournal | null,
    private assets: AssetStore,
    unavailable: string | null = null,
  ) {
    if (unavailable) this.statusValue = { state: 'unavailable', reason: unavailable }
  }

  status = () => this.statusValue
  onStatus = (fn: () => void) => {
    return this.changes.subscribe(fn)
  }
  private setStatus(s: AutosaveStatus) {
    if (this.statusValue.state === 'unavailable') return
    this.statusValue = s
    this.changes.emit()
  }

  /** Reads what the last visit left, then starts watching. Restored documents count as already written. */
  async start(): Promise<{ restored: number; problems: string[] }> {
    const docs = documents()
    let restored = 0
    let problems: string[] = []
    try {
      const r = await restoreSession(this.store)
      problems = r.problems
      await this.restoreFonts()
      for (const d of r.docs) {
        let doc = d.doc
        let clean = d.clean
        if ('asset' in doc.profile) {
          const bytes = await this.store.read(`profiles/${doc.profile.asset}.icc`)
          if (!bytes || !(await this.assets.putAs(doc.profile.asset, bytes))) problems.push(`${doc.name}: its embedded profile couldn’t be restored`)
        }
        const sets = tileSetsOf(doc)
        if (sets.length && this.pixels) {
          const { missing } = await this.pixels.restore(sets)
          if (missing.length) {
            const lost = new Set(missing)
            doc = dropLostSets(doc, lost)
            problems.push(`${doc.name}: ${missing.length === 1 ? 'a layer' : `${missing.length} layers`} couldn’t be restored and came back empty`)
            clean = false
          }
        }
        docs.add({ key: d.key, doc, file: d.file, saved: clean, folded: d.folded, label: 'Restore', parent: d.parent ?? null })
        if (doc === d.doc) this.written.set(d.key, doc)
        for (const w of d.warnings) problems.push(`${doc.name}: ${w}`)
        restored++
      }
      if (r.active) docs.activate(r.active)
    } catch (e) {
      problems.push(`The documents open last time could not be restored: ${String(e)}`)
    }
    this.unsubscribe = docs.subscribe(() => this.schedule())
    const flushNow = () => void this.flush()
    addEventListener('pagehide', flushNow)
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushNow())
    return { restored, problems }
  }

  stop() {
    this.unsubscribe?.()
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    this.setStatus({ state: 'pending' })
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS)
  }

  /** Writes whatever has changed now. Calls that arrive mid-write run once more after it. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.write(documents().getState()).finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.flush()
      }
    })
    return this.running
  }

  /** The fonts the journal kept, back in the font library as the documents' own. */
  private async restoreFonts() {
    try {
      const list = await this.store.read('fonts.json')
      if (!list) return
      const hashes: unknown = JSON.parse(new TextDecoder().decode(list))
      const fonts = new Map<string, Uint8Array>()
      for (const h of Array.isArray(hashes) ? hashes : []) {
        if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) continue
        const bytes = await this.store.read(`fonts/${h}.font`)
        if (bytes) {
          fonts.set(h, bytes)
          this.fontsWritten.add(h)
        }
      }
      if (fonts.size) await addDocumentFonts(fonts)
    } catch {
      // Without them, text shows in the default font and names what's missing.
    }
  }

  /** True when what's on screen is all in the journal. */
  get settled() {
    return this.statusValue.state === 'idle' && !this.timer && !this.running
  }

  private async write(state: DocsState) {
    this.setStatus({ state: 'writing' })
    try {
      const open = new Set(state.docs.map((d) => d.key))
      let changed = false
      for (const d of state.docs) {
        const doc = d.history.present
        if (this.written.get(d.key) === doc) continue
        if (this.pixels) await this.pixels.write(tileSetsOf(doc))
        if ('asset' in doc.profile && !this.profilesWritten.has(doc.profile.asset)) {
          const bytes = this.assets.get(doc.profile.asset)
          if (bytes) await this.store.write(`profiles/${doc.profile.asset}.icc`, bytes)
          this.profilesWritten.add(doc.profile.asset)
        }
        // Fonts that came with a document: the journal keeps them, with a list of them to read back.
        for (const f of await fontsToCarry(doc, ['document'])) {
          if (this.fontsWritten.has(f.hash)) continue
          await this.store.write(`fonts/${f.hash}.font`, f.bytes)
          this.fontsWritten.add(f.hash)
          await this.store.write('fonts.json', new TextEncoder().encode(JSON.stringify([...this.fontsWritten])))
        }
        await writeJournalDoc(this.store, d.key, doc)
        this.written.set(d.key, doc)
        changed = true
      }
      await writeSession(this.store, {
        active: state.active,
        docs: state.docs.map((d) => ({ key: d.key, file: d.file, clean: !isDirty(d), folded: [...d.folded], parent: d.parent })),
      })
      for (const key of [...this.written.keys()]) {
        if (open.has(key)) continue
        await removeJournalDoc(this.store, key)
        this.written.delete(key)
        changed = true
      }
      // Tiles no journalled document holds any more can go.
      if (changed && this.pixels) await this.pixels.collect(state.docs.flatMap((d) => tileSetsOf(d.history.present)))
      this.setStatus({ state: 'idle' })
    } catch (e) {
      const reason =
        // By name: storage full in the engine (journalling pixels) arrives as an Error so named, not a DOMException.
        e instanceof Error && e.name === 'QuotaExceededError'
          ? 'The browser’s storage for this page is full, so unsaved changes aren’t being kept. Save your documents to files.'
          : `Unsaved changes couldn’t be kept: ${e instanceof Error ? e.message : String(e)}`
      this.setStatus({ state: 'failed', reason })
    }
  }
}
