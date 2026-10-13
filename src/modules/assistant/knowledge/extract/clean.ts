// The text of a PDF as it may be stored and shown to the owner (ADR 0174 §2 "Cleaning"): NFKC; hidden, control, format, private-use
// and tag characters stripped and COUNTED (white text and zero-width tricks still reach the owner's review as plain words, flagged);
// HTML-like tags stripped (flagged by the review's warnings when the owner types any back); words split at a line end joined again;
// whitespace collapsed; pages separated by a blank line; at most 200,000 characters.
export const MAX_EXTRACTED_CHARS = 200_000
/** A page holding fewer non-space characters than this on average is a scan (pictures of pages): no_text. */
export const MIN_CHARS_PER_PAGE = 40

const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/gu
const MARKUP = /<\s*\/?\s*[a-z!?][^>]{0,200}>/gi

export interface CleanText {
  text: string
  /** Hidden or control characters removed (line breaks and tabs are not counted). */
  removedChars: number
  /** HTML-like tags removed. */
  removedTags: number
  /** The text was cut at MAX_EXTRACTED_CHARS. */
  cut: boolean
}

export function cleanPage(raw: string): { text: string; removed: number; tags: number } {
  let removed = 0
  let tags = 0
  const nfkc = raw.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  const visible = nfkc.replace(HIDDEN, (m) => {
    if (m === '\n') return m
    removed += 1
    return ''
  })
  const plain = visible.replace(MARKUP, () => {
    tags += 1
    return ' '
  })
  const text = plain
    // "exam-\nple" -> "example": a word split at the end of a line
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, removed, tags }
}

/** The pages cleaned and joined (a blank line between pages). */
export function cleanPdfText(pages: readonly string[]): CleanText {
  let removedChars = 0
  let removedTags = 0
  const parts: string[] = []
  for (const p of pages) {
    const c = cleanPage(p)
    removedChars += c.removed
    removedTags += c.tags
    if (c.text !== '') parts.push(c.text)
  }
  const joined = parts.join('\n\n')
  const cut = joined.length > MAX_EXTRACTED_CHARS
  return { text: cut ? joined.slice(0, MAX_EXTRACTED_CHARS) : joined, removedChars, removedTags, cut }
}

/** A scan: on average fewer than MIN_CHARS_PER_PAGE non-space characters per page. */
export function looksScanned(text: string, pageCount: number): boolean {
  const chars = text.replace(/\s+/g, '').length
  return chars < MIN_CHARS_PER_PAGE * Math.max(1, pageCount)
}
