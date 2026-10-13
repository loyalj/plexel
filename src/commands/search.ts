/**
 * The command palette's matching. The letters typed must appear in the
 * command's name in order, case ignored, so `dark`, `sdl` and `swi` all find
 * "Switch Dark and Light".
 *
 * Pure, so check-commands can hold it to the cases that matter: a prefix
 * beats a scatter, a word start beats a letter in the middle of a word, and
 * a category name ("appearance") finds every command in it.
 */

export interface Match {
  score: number
  /** Indices into the label of the letters that matched, for highlighting. */
  hits: number[]
}

const isWordStart = (s: string, i: number) => i === 0 || /[\s\-./(]/.test(s[i - 1])

/**
 * Scores `query` against `label`. Null when it doesn't match. Each matched
 * letter earns a point, more at a word start and more again when it
 * directly follows the previous match.
 *
 * Each letter is placed greedily: carry on a run if the very next letter
 * matches, otherwise jump to the next word that starts with it, otherwise
 * take the next place it occurs. That is how people abbreviate ("fs" for
 * Full Screen, "pal" for Palette), and it's linear, which matters when this
 * runs for every command on every keystroke.
 */
export function matchText(query: string, label: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { score: 0, hits: [] }
  const s = label.toLowerCase()
  const hits: number[] = []
  let score = 0
  let from = 0
  for (const ch of q) {
    const prev = hits[hits.length - 1]
    let at = -1
    if (prev !== undefined && s[prev + 1] === ch) {
      at = prev + 1
    } else {
      for (let i = from; i < s.length; i++) {
        if (s[i] === ch && isWordStart(s, i)) {
          at = i
          break
        }
      }
      if (at < 0) at = s.indexOf(ch, from)
    }
    if (at < 0) return null
    score += 1
    if (isWordStart(s, at)) score += 3
    if (prev !== undefined && at === prev + 1) score += 2
    hits.push(at)
    from = at + 1
  }
  // Of two labels with the same hits, the shorter is the closer match.
  score -= s.length * 0.01
  return { score, hits }
}

/**
 * Scores a command by its label. A query that starts with the command's
 * category, as a word (`appearance`, `window res`), narrows to that
 * category and matches the rest against the label, so a category name lists
 * everything in it.
 *
 * The category is only ever read as a leading word. Matched letter by
 * letter like a label, it found nonsense: `pa` listed every Appearance
 * command, for the p and the a in "appearance".
 */
export function matchCommand(query: string, label: string, category: string): Match | null {
  const own = matchText(query, label)
  const words = query.trim().toLowerCase().split(/\s+/)
  const cat = category.toLowerCase()
  if (words[0].length >= 3 && cat.startsWith(words[0]) && !own) {
    const rest = words.slice(1).join(' ')
    const inCat = matchText(rest, label)
    // Below any match on the label itself, so `dark` still puts Dark first.
    return inCat ? { score: inCat.score - 5, hits: inCat.hits } : null
  }
  return own
}
