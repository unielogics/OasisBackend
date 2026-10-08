// Inbound keyword parsing. A keyword is the whole message: trimmed, case-insensitive, with surrounding punctuation ignored
// ("Stop.", "stop!"). "please stop texting me" is not a keyword, it is a message for staff.
// The two-word opt-outs ("opt out", "stop all") also match written together or with a hyphen, underscore or dot between the
// words. CANCEL is deliberately not an opt-out here (it asks staff to cancel the appointment); ADR 0124 explains why and what
// the owner can choose instead, and the same for Spanish keywords.

export const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'REVOKE', 'OPTOUT'] as const
/** Opt-outs people write as two words: matched after joining the words ("Opt-Out", "stop all"). */
const OPT_OUT_PHRASES: ReadonlySet<string> = new Set(['OPTOUT', 'STOPALL'])
export const OPT_IN_KEYWORDS = ['START', 'UNSTOP'] as const
export const CONFIRM_KEYWORDS = ['C', 'CONFIRM'] as const

export type ParsedKeyword =
  | { kind: 'opt_out'; keyword: string }
  | { kind: 'opt_in'; keyword: string }
  /** YES is context dependent: opt back in when opted out, otherwise confirm a booking when one is waiting. */
  | { kind: 'yes' }
  | { kind: 'help' }
  | { kind: 'confirm'; keyword: string }
  /** CANCEL is not an opt-out. It means "cancel my appointment" and goes to staff. */
  | { kind: 'cancel' }
  | { kind: 'none' }

/** Upper-cased message with whitespace, invisible characters and edge punctuation removed; null if it has inner spaces. */
export function keywordToken(body: string): string | null {
  const cleaned = body
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toUpperCase()
  if (cleaned.length === 0 || /\s/.test(cleaned)) return null
  return cleaned
}

/** The message with the separators between words removed ("Opt - Out" -> "OPTOUT"); null unless only letters remain. */
function joinedToken(body: string): string | null {
  const joined = body
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/[\s._-]+/g, '')
    .toUpperCase()
  return /^\p{L}+$/u.test(joined) ? joined : null
}

export function parseKeyword(body: string): ParsedKeyword {
  const token = keywordToken(body)
  if (token === null || !(OPT_OUT_KEYWORDS as readonly string[]).includes(token)) {
    const joined = joinedToken(body)
    if (joined !== null && OPT_OUT_PHRASES.has(joined)) return { kind: 'opt_out', keyword: joined }
  }
  if (token === null) return { kind: 'none' }
  if ((OPT_OUT_KEYWORDS as readonly string[]).includes(token)) return { kind: 'opt_out', keyword: token }
  if ((OPT_IN_KEYWORDS as readonly string[]).includes(token)) return { kind: 'opt_in', keyword: token }
  if (token === 'YES') return { kind: 'yes' }
  if (token === 'HELP') return { kind: 'help' }
  if ((CONFIRM_KEYWORDS as readonly string[]).includes(token)) return { kind: 'confirm', keyword: token }
  if (token === 'CANCEL') return { kind: 'cancel' }
  return { kind: 'none' }
}
