/**
 * Assets: bytes that documents refer to by content hash rather than hold,
 * such as embedded ICC profiles now, and fonts and placed files later. A
 * document stores `{ asset: <hash> }`, the bytes live here once however
 * many documents use them, and .pxll files and the journal carry them
 * beside the document JSON.
 */

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class AssetStore {
  private bytes = new Map<string, Uint8Array>()

  get(hash: string): Uint8Array | undefined {
    return this.bytes.get(hash)
  }

  has(hash: string) {
    return this.bytes.has(hash)
  }

  /** Keeps the bytes and returns their hash. Putting the same bytes twice keeps one copy. */
  async put(bytes: Uint8Array): Promise<string> {
    const hash = await sha256(bytes)
    if (!this.bytes.has(hash)) this.bytes.set(hash, bytes.slice())
    return hash
  }

  /** Keeps bytes under a hash already known (from a file's entry name), checking it matches. */
  async putAs(hash: string, bytes: Uint8Array): Promise<boolean> {
    if ((await sha256(bytes)) !== hash) return false
    if (!this.bytes.has(hash)) this.bytes.set(hash, bytes.slice())
    return true
  }
}

let store: AssetStore | null = null
/** The page's one asset store. */
export const assets = () => (store ??= new AssetStore())
