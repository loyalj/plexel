/**
 * Photoshop's text engine data: the PostScript-like dictionaries a type
 * layer keeps its text, runs, paragraphs and fonts in (inside the TySh
 * block's descriptor, as "EngineData").
 *
 *   << /Key value ... >>   dictionaries
 *   [ value ... ]          arrays
 *   (þÿ...)                strings, UTF-16 big-endian after a BOM, with \\ escapes
 *   /Name                  names
 *   12 0.5 .5 true false   numbers and booleans
 *
 * Read into plain objects (names as { name } so they write back as names),
 * and written in the same form.
 */
export type EValue = number | boolean | string | { name: string } | EValue[] | { [k: string]: EValue }

export function readEngineData(b: Uint8Array): EValue {
  let i = 0
  const n = b.length
  const ws = () => {
    while (i < n && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x00)) i++
  }
  const value = (): EValue => {
    ws()
    const c = b[i]
    if (c === 0x3c && b[i + 1] === 0x3c) {
      i += 2
      const o: { [k: string]: EValue } = {}
      for (;;) {
        ws()
        if (i >= n) return o
        if (b[i] === 0x3e && b[i + 1] === 0x3e) {
          i += 2
          return o
        }
        if (b[i] !== 0x2f) {
          i++
          continue
        }
        i++
        const k = token()
        o[k] = value()
      }
    }
    if (c === 0x5b) {
      i++
      const a: EValue[] = []
      for (;;) {
        ws()
        if (i >= n) return a
        if (b[i] === 0x5d) {
          i++
          return a
        }
        a.push(value())
      }
    }
    if (c === 0x28) {
      i++
      const bytes: number[] = []
      while (i < n && b[i] !== 0x29) {
        if (b[i] === 0x5c && i + 1 < n) {
          i++
          const e = b[i]
          bytes.push(e === 0x6e ? 10 : e === 0x72 ? 13 : e === 0x74 ? 9 : e)
          i++
        } else bytes.push(b[i++])
      }
      i++
      return decodeString(bytes)
    }
    if (c === 0x2f) {
      i++
      return { name: token() }
    }
    const t = token()
    if (t === 'true') return true
    if (t === 'false') return false
    const num = Number(t)
    return Number.isFinite(num) ? num : t
  }
  const token = () => {
    const s = i
    while (i < n && !/[\s/<>[\]()]/.test(String.fromCharCode(b[i]))) i++
    return new TextDecoder('latin1').decode(b.subarray(s, i))
  }
  return value()
}

function decodeString(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = ''
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1])
    return s
  }
  return String.fromCharCode(...bytes)
}

export function writeEngineData(v: EValue): Uint8Array {
  const out: number[] = []
  const ascii = (s: string) => {
    for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k) & 0xff)
  }
  const write = (x: EValue, indent: string) => {
    if (typeof x === 'number') return ascii(Number.isInteger(x) ? String(x) : String(Math.round(x * 100000) / 100000))
    if (typeof x === 'boolean') return ascii(x ? 'true' : 'false')
    if (typeof x === 'string') {
      out.push(0x28, 0xfe, 0xff)
      for (let k = 0; k < x.length; k++) {
        for (const byte of [x.charCodeAt(k) >> 8, x.charCodeAt(k) & 0xff]) {
          if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out.push(0x5c)
          out.push(byte)
        }
      }
      out.push(0x29)
      return
    }
    if (Array.isArray(x)) {
      ascii('[')
      for (const e of x) {
        ascii(' ')
        write(e, indent)
      }
      ascii(' ]')
      return
    }
    if ('name' in x && typeof x.name === 'string' && Object.keys(x).length === 1) return ascii('/' + x.name)
    ascii('\n' + indent + '<<')
    for (const [k, e] of Object.entries(x)) {
      ascii('\n' + indent + '\t/' + k + ' ')
      write(e as EValue, indent + '\t')
    }
    ascii('\n' + indent + '>>')
  }
  write(v, '')
  return Uint8Array.from(out)
}

/** A path into engine data, or undefined. */
export function at(v: EValue | null | undefined, ...path: (string | number)[]): EValue | undefined {
  let cur: EValue | null | undefined = v
  for (const p of path) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined
    cur = Array.isArray(cur) ? cur[p as number] : (cur as { [k: string]: EValue })[p as string]
  }
  return cur ?? undefined
}

export const eNum = (v: EValue | undefined, d = 0) => (typeof v === 'number' ? v : d)
export const eArr = (v: EValue | undefined): EValue[] => (Array.isArray(v) ? v : [])
