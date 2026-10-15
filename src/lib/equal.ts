/**
 * Whether two JSON-like values (a node's parameters, effects, a profile
 * reference) are the same: as their JSON would be, whatever order their keys
 * are in, an absent key and one set to undefined being the same.
 *
 * Comparing JSON.stringify's results did that but for key order (two equal
 * objects built differently compared different, so a no-op edit made a
 * history step), and turned whole values into strings to do it (a Liquify
 * field is half a megabyte, compared on every slider step).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const kx = Object.keys(x).filter((k) => x[k] !== undefined)
  const ky = Object.keys(y).filter((k) => y[k] !== undefined)
  if (kx.length !== ky.length) return false
  for (const k of kx) if (!deepEqual(x[k], y[k])) return false
  return true
}
