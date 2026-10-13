import { Component, type ErrorInfo, type ReactNode } from 'react'
import { download } from '../io/files'
import { restoreSession } from '../io/journal'
import { opfsAvailable, opfsStore } from '../io/opfs'
import { pxllBlob } from '../io/pxll'

interface State {
  error: Error | null
  /** The documents in the journal, once read: how many, and whether downloading them has been tried. */
  rescue: { count: number; done: boolean } | null
}

/**
 * What the page shows when the app itself has failed to draw.
 *
 * Without one, React unmounts the whole tree on an error during render and
 * leaves a blank page, and the next visit restores the same documents and
 * may fail the same way. So the screen offers the way out: every document
 * in the autosave journal, downloaded as an ordinary .pxll file. It reads
 * the journal from storage directly, through the file code alone, because
 * whatever threw may be anywhere in the app.
 */
export class AppBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, rescue: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[plexel] the app failed to draw', error, info.componentStack)
    if (!opfsAvailable()) return
    void restoreSession(opfsStore)
      .then((r) => this.setState({ rescue: { count: r.docs.length, done: false } }))
      .catch(() => {})
  }

  private async downloadAll() {
    const r = await restoreSession(opfsStore)
    for (const d of r.docs) download(await pxllBlob(d.doc), d.file?.name ?? d.doc.name)
    this.setState({ rescue: { count: r.docs.length, done: true } })
  }

  render() {
    const { error, rescue } = this.state
    if (!error) return this.props.children
    return (
      <div className="screen" role="alert" data-screen="crash">
        <div className="screen-card">
          <h1>Plexel stopped</h1>
          <p>
            Something went wrong drawing the app: <code>{error.message || String(error)}</code>
          </p>
          {rescue && rescue.count > 0 && (
            <p>
              {rescue.count === 1 ? 'The document' : `All ${rescue.count} documents`} you had open, unsaved changes included, can be
              downloaded as .pxll files first. Then reload; if it keeps landing here, open the downloaded files one at a time.
            </p>
          )}
          <div className="screen-actions">
            {rescue && rescue.count > 0 && (
              <button type="button" className="button primary" onClick={() => void this.downloadAll()}>
                {rescue.done ? 'Download again' : rescue.count === 1 ? 'Download the document' : `Download ${rescue.count} documents`}
              </button>
            )}
            <button type="button" className="button" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
