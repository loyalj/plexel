/**
 * The whole page, when there is no WebGPU. Plexel has no fallback
 * renderer, by design (ARCHITECTURE.md, "Goals and limits"), so this says
 * plainly why and what would fix it rather than showing an editor that
 * can't draw.
 */
export function Unsupported({ reason }: { reason: string }) {
  return (
    <div className="screen" role="alert" data-screen="unsupported">
      <div className="screen-card">
        <h1>Plexel needs WebGPU</h1>
        <p>{reason}</p>
        <p>
          Current versions of Chrome, Edge, Safari and Firefox on a desktop computer all have it. In Chrome or Edge,{' '}
          <code>chrome://gpu</code> shows whether WebGPU is available and why not.
        </p>
        <div className="screen-actions">
          <button type="button" className="button primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}
