/**
 * Character and paragraph styles: named in the document, made from what's
 * selected, redefined from it, deleted. Text that refers to a deleted style
 * keeps its own settings and inherits the rest from the defaults.
 */
import { setTextStyles } from '../doc/edit'
import { NO_STYLES, type CharProps, type ParaProps, type TextStyles } from '../doc/text'
import { documents, newId } from './documents'

const stylesOf = () => documents().active()?.history.present.textStyles ?? NO_STYLES

function commit(next: TextStyles, label: string) {
  const d = documents().active()
  if (d) documents().commit((x) => setTextStyles(x, next), { key: d.key, label })
}

function freshName(names: string[], base: string): string {
  for (let i = 1; ; i++) if (!names.includes(`${base} ${i}`)) return `${base} ${i}`
}

/** A new character style with these settings; returns its id. */
export function addCharStyle(char: Partial<CharProps>, basedOn: string | null = null): string {
  const s = stylesOf()
  const id = newId('cs')
  commit({ ...s, character: [...s.character, { id, name: freshName(s.character.map((x) => x.name), 'Character Style'), basedOn, char }] }, 'New Character Style')
  return id
}

export function addParaStyle(para: Partial<ParaProps>, char: Partial<CharProps>, basedOn: string | null = null): string {
  const s = stylesOf()
  const id = newId('ps')
  commit({ ...s, paragraph: [...s.paragraph, { id, name: freshName(s.paragraph.map((x) => x.name), 'Paragraph Style'), basedOn, para, char }] }, 'New Paragraph Style')
  return id
}

export function redefineCharStyle(id: string, char: Partial<CharProps>) {
  const s = stylesOf()
  commit({ ...s, character: s.character.map((x) => (x.id === id ? { ...x, char } : x)) }, 'Redefine Character Style')
}

export function redefineParaStyle(id: string, para: Partial<ParaProps>, char: Partial<CharProps>) {
  const s = stylesOf()
  commit({ ...s, paragraph: s.paragraph.map((x) => (x.id === id ? { ...x, para, char } : x)) }, 'Redefine Paragraph Style')
}

export function renameTextStyle(kind: 'character' | 'paragraph', id: string, name: string) {
  const s = stylesOf()
  if (!name.trim()) return
  commit(kind === 'character' ? { ...s, character: s.character.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)) } : { ...s, paragraph: s.paragraph.map((x) => (x.id === id ? { ...x, name: name.trim() } : x)) }, 'Rename Style')
}

export function deleteTextStyle(kind: 'character' | 'paragraph', id: string) {
  const s = stylesOf()
  // Styles based on it are based on what it was based on.
  if (kind === 'character') {
    const gone = s.character.find((x) => x.id === id)
    commit({ ...s, character: s.character.filter((x) => x.id !== id).map((x) => (x.basedOn === id ? { ...x, basedOn: gone?.basedOn ?? null } : x)) }, 'Delete Character Style')
  } else {
    const gone = s.paragraph.find((x) => x.id === id)
    commit({ ...s, paragraph: s.paragraph.filter((x) => x.id !== id).map((x) => (x.basedOn === id ? { ...x, basedOn: gone?.basedOn ?? null } : x)) }, 'Delete Paragraph Style')
  }
}
