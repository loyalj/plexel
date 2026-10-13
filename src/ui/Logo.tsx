/** The mark: a filled layer under an outlined one, crossed by a pen nib. Same drawing as favicon.svg. */
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="3" y="9" width="16" height="16" rx="2" fill="var(--accent)" />
      <rect x="9" y="4" width="16" height="16" rx="2" fill="none" stroke="var(--ink)" strokeWidth="2.5" />
      <path d="M13 27 L27 13 L29 15 L15 29 Z" fill="var(--ink)" />
    </svg>
  )
}
