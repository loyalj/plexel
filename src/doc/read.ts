/**
 * Reading untrusted values: from a file, from storage, from a newer or
 * older build. Each reader returns a usable value whatever it's given, and
 * says so in `warn` when it had to substitute one, so a loader can tell the
 * user what it repaired without ever throwing.
 */

export type Warn = (message: string) => void

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function readNumber(v: unknown, fallback: number, min: number, max: number, what: string, warn: Warn): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    if (v !== undefined) warn(`${what} was not a number; used ${fallback}`)
    return fallback
  }
  if (v < min || v > max) {
    const clamped = Math.min(max, Math.max(min, v))
    warn(`${what} was ${v}, outside ${min} to ${max}; used ${clamped}`)
    return clamped
  }
  return v
}

export function readInt(v: unknown, fallback: number, min: number, max: number, what: string, warn: Warn): number {
  const n = readNumber(v, fallback, min, max, what, warn)
  if (Number.isInteger(n)) return n
  const r = Math.round(n)
  warn(`${what} was ${n}, not a whole number; used ${r}`)
  return r
}

export function readBool(v: unknown, fallback: boolean, what: string, warn: Warn): boolean {
  if (typeof v === 'boolean') return v
  if (v !== undefined) warn(`${what} was not true or false; used ${fallback}`)
  return fallback
}

export function readString(v: unknown, fallback: string, what: string, warn: Warn): string {
  if (typeof v === 'string') return v
  if (v !== undefined) warn(`${what} was not text; used “${fallback}”`)
  return fallback
}

export function readOneOf<T extends string | number>(v: unknown, options: readonly T[], fallback: T, what: string, warn: Warn): T {
  if (options.includes(v as T)) return v as T
  if (v !== undefined) warn(`${what} “${String(v)}” is not known here; used “${fallback}”`)
  return fallback
}

/** A string or null, for optional references such as a tile-set id. */
export function readRef(v: unknown, what: string, warn: Warn): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v) return v
  warn(`${what} was not a reference; cleared it`)
  return null
}

/** A plain JSON object of parameters, kept as it is when it's an object. */
export function readParams(v: unknown, what: string, warn: Warn): Record<string, unknown> {
  if (isObject(v)) return v
  if (v !== undefined) warn(`${what} was not a set of parameters; cleared it`)
  return {}
}
