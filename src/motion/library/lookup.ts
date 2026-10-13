/**
 * English text -> library glosses, by dictionary lookup.
 *
 * This is the MVP's controlled mapping (normalised text -> known sign), not
 * translation: it does not reorder words into ASL grammar, add non-manual
 * markers, or handle words outside the library. Unknown words are reported,
 * never guessed.
 */

/**
 * English forms for the dataset's compound glosses (one sign covering
 * several English words). Every other gloss is matched by its own spelling.
 */
export const GLOSS_PHRASES: Record<string, string[]> = {
  thankyou: ['thank you', 'thanks'],
  callonphone: ['call on phone', 'phone call', 'call', 'phone'],
  frenchfries: ['french fries', 'fries'],
  glasswindow: ['glass', 'window'],
  haveto: ['have to', 'must'],
  hesheit: ['he', 'she', 'it'],
  icecream: ['ice cream'],
  minemy: ['mine', 'my'],
  weus: ['we', 'us'],
  shhh: ['shh', 'shush'],
  TV: ['tv', 'television']
}

/** Display label of a gloss ("thankyou" -> "thank you"). */
export function glossLabel(gloss: string) {
  const phrases = GLOSS_PHRASES[gloss]
  if (!phrases) return gloss
  if (gloss === 'TV') return 'TV'
  if (gloss === 'hesheit' || gloss === 'minemy' || gloss === 'weus' || gloss === 'glasswindow') return phrases.join(' / ')
  return phrases[0]
}

export interface LookupToken {
  /** The text the token covers, as typed. */
  text: string
  /** Matched gloss, or null when the word is not in the library. */
  gloss: string | null
}

const normalise = (word: string) => word.toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'/g, '')

/** Build the phrase table once per library: normalised word sequence -> gloss. */
export function buildLookup(glosses: readonly string[]) {
  const table = new Map<string, string>()
  let longest = 1
  const add = (phrase: string, gloss: string) => {
    const key = phrase.split(/\s+/).map(normalise).filter(Boolean).join(' ')
    if (!key) return
    if (!table.has(key)) table.set(key, gloss)
    longest = Math.max(longest, key.split(' ').length)
  }
  // Exact glosses first so they win over aliases.
  for (const gloss of glosses) add(gloss, gloss)
  for (const gloss of glosses) for (const phrase of GLOSS_PHRASES[gloss] ?? []) add(phrase, gloss)
  return { table, longest }
}

/** Greedy longest-match lookup of `text` against the library glosses. */
export function lookupText(text: string, lookup: ReturnType<typeof buildLookup>): LookupToken[] {
  const raw = text.split(/\s+/).filter(Boolean)
  const words = raw.map(normalise)
  const tokens: LookupToken[] = []
  let i = 0
  while (i < words.length) {
    if (!words[i]) {
      i += 1
      continue
    }
    let matched = false
    for (let n = Math.min(lookup.longest, words.length - i); n >= 1; n -= 1) {
      const key = words.slice(i, i + n).join(' ')
      const gloss = lookup.table.get(key)
      if (gloss) {
        tokens.push({ text: raw.slice(i, i + n).join(' '), gloss })
        i += n
        matched = true
        break
      }
    }
    if (!matched) {
      tokens.push({ text: raw[i], gloss: null })
      i += 1
    }
  }
  return tokens
}
