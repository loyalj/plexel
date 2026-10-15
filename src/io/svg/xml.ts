/**
 * Enough XML for SVG: elements, attributes, text and CDATA, the five
 * named entities and numeric ones; comments, processing instructions and
 * the doctype skipped. Ours, so SVG can be read where there's no
 * DOMParser (the checks, in Node).
 */
export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: (XmlElement | string)[]
}

class XmlError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function parseXml(text: string): XmlElement {
  let i = 0
  const n = text.length
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      const tail = text.slice(i)
      if (tail.trim()) stack[stack.length - 1].children.push(decodeEntities(tail))
      break
    }
    if (lt > i) {
      const t = text.slice(i, lt)
      if (t) stack[stack.length - 1].children.push(decodeEntities(t))
    }
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt)
      i = e < 0 ? n : e + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt)
      stack[stack.length - 1].children.push(text.slice(lt + 9, e < 0 ? n : e))
      i = e < 0 ? n : e + 3
      continue
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      // A processing instruction or the doctype (with any internal subset).
      let depth = 0
      let j = lt + 1
      for (; j < n; j++) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') depth--
        else if (text[j] === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    if (text[lt + 1] === '/') {
      const gt = text.indexOf('>', lt)
      const name = text.slice(lt + 2, gt).trim()
      // Close back to the matching element; a stray close tag is ignored.
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k].name === name) {
          stack.length = k
          break
        }
      i = gt + 1
      continue
    }
    // A start tag: its name, then attributes up to > or />.
    let j = lt + 1
    while (j < n && !/[\s/>]/.test(text[j])) j++
    const el: XmlElement = { name: text.slice(lt + 1, j), attrs: {}, children: [] }
    for (;;) {
      while (j < n && /\s/.test(text[j])) j++
      if (j >= n) throw new XmlError('The file ends inside a tag')
      if (text[j] === '>' || (text[j] === '/' && text[j + 1] === '>')) break
      let k = j
      while (k < n && !/[\s=/>]/.test(text[k])) k++
      const key = text.slice(j, k)
      j = k
      while (j < n && /\s/.test(text[j])) j++
      let value = ''
      if (text[j] === '=') {
        j++
        while (j < n && /\s/.test(text[j])) j++
        const q = text[j]
        if (q === '"' || q === "'") {
          const e = text.indexOf(q, j + 1)
          if (e < 0) throw new XmlError('An attribute’s value is never closed')
          value = text.slice(j + 1, e)
          j = e + 1
        } else {
          let e = j
          while (e < n && !/[\s>]/.test(text[e])) e++
          value = text.slice(j, e)
          j = e
        }
      }
      if (key) el.attrs[key] = decodeEntities(value)
    }
    stack[stack.length - 1].children.push(el)
    if (text[j] === '/') i = j + 2
    else {
      i = j + 1
      stack.push(el)
    }
  }
  const top = root.children.find((c): c is XmlElement => typeof c !== 'string')
  if (!top) throw new XmlError('There’s no element in it')
  return top
}
