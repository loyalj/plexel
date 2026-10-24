/** Types for the packages layout uses: just what it calls. */

declare module 'linebreak' {
  /** UAX #14 line breaking: each break is a UTF-16 offset a line may (or, when required, must) end at. */
  export default class LineBreaker {
    constructor(text: string)
    nextBreak(): { position: number; required: boolean } | null
  }
}

declare module 'bidi-js' {
  export interface EmbeddingLevels {
    levels: Uint8Array
    paragraphs: { start: number; end: number; level: number }[]
  }
  export interface Bidi {
    /** UAX #9: each UTF-16 unit's embedding level (odd is right to left). */
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl'): EmbeddingLevels
  }
  export default function bidiFactory(): Bidi
}

// The hyphen package's pattern files and its hyphenator (text/hyphenate.ts): UMD modules, their values opaque here.
declare module 'hyphen/patterns/*' {
  const patterns: unknown
  export default patterns
}
declare module 'hyphen/hyphen.js' {
  const createHyphenator: (patterns: unknown, options?: object) => (text: string, options?: object) => string
  export default createHyphenator
}
