// The output guard (ADR 0160, design sections 3 and 3b): every text the model writes passes here before it can reach a client.
// Pure: the turn (turn.ts) decides what to do with the verdict (one rewrite call, one shorten call, a cut, or the fallback).
//
// ALLOW-LISTS, never excusals (owner-level redesign 2026-10-11): a forbidden thing is blocked wherever it appears, and only an
// exact, server-owned phrase lets it through. Nothing is excused because it sits near a "link", a "warning", the owner's facts or
// a capitalised word.
//
//   - plain text: markdown stripped, GSM-7 only (typography and emoji normalised like every other text; anything else dropped)
//   - at most MAX_REPLY_CHARS characters, at most one question
//   - (A) secrets: no PIN, passcode, password, code, card number, CVV, card digits or 4-8 digit code anywhere, except inside one of
//     the server's own SAFETY_LINES written as a whole sentence; the server appends SAFETY_LINE itself when a verify / pin /
//     membership / pay link goes out (turn.ts composeReply)
//   - (B) promise words: free, discount, refund, coupon, deal, guarantee, comp, waive, "on the house", "ready by", legal and
//     damage words; only the whole phrases of ALLOWED_PHRASES ("feel free", "spot-free" ...) pass
//   - (C) the PRICING RULE: a dollar amount is (1) a catalog starting price introduced by "starts at" / "starting at" / "from"
//     right before it, in a clause that names that item or its category, (2) a plan's monthly price with "a month" / "/month"
//     right after it and the plan's label right before it, (3) the guest booking fee next to the word "fee", or (4) an amount a
//     tool of this turn declared (the client's own balance); never a total or a combination
//   - (D) no web address: no "http", "://", "www", nothing shaped like label.label with a 2+ letter last label (any case); only
//     the server's {linkN} placeholders and the shop's own host as text (no path) pass
//   - (E) no phone number but the shop's own
// Every problem is fixed by one rewrite call; a reply that still has a hard problem after it becomes the fallback and a handoff.
import { isGsm7Char, normalizeForSms } from '../../integrations/sms/gsm.js'
import type { FactAmounts } from './facts.js'
import { INTL_PHONE, LOCAL_PHONE, NANP_PHONE } from './transcript.js'

/** The longest reply (characters, placeholders counted as written). */
export const MAX_REPLY_CHARS = 320

/** The safety line the server appends to a reply that carries a verify, PIN, membership or payment link (A). */
export const SAFETY_LINE = 'For your security, enter codes and your PIN only on the secure page, never by text.'
/** Every server-owned sentence that may mention codes or a PIN (the model may repeat one exactly, as a whole sentence). */
export const SAFETY_LINES: readonly string[] = [
  SAFETY_LINE,
  // the code_on_link_page template's line (messaging/templates/registry.ts): the model may see it in the conversation
  'For your security, codes are only entered on your secure link page, never by text.',
]
/** The link kinds whose reply gets SAFETY_LINE. */
export const SAFETY_LINK_KINDS: ReadonlySet<string> = new Set(['verify', 'pin', 'membership', 'pay'])

export type GuardProblem =
  | 'empty'
  | 'price_unknown'
  | 'price_unqualified'
  | 'price_combination'
  | 'url'
  | 'unknown_placeholder'
  | 'secret'
  | 'promise_words'
  | 'phone'
  | 'questions'
  | 'too_long'

/** Problems only a rewrite can fix; a reply that still has one after the rewrite becomes the fallback. */
export const HARD_PROBLEMS: ReadonlySet<GuardProblem> = new Set([
  'empty',
  'price_unknown',
  'price_unqualified',
  'price_combination',
  'url',
  'unknown_placeholder',
  'secret',
  'promise_words',
  'phone',
])

export type GuardVerdict = { kind: 'ok'; text: string } | { kind: 'fix'; text: string; problems: GuardProblem[]; words: string[] }

export interface GuardInput {
  text: string
  amounts: FactAmounts
  /** Amounts a tool of this turn declared (ToolOutcome.amountsCents: the client's own balance). */
  extraAmounts?: Iterable<number>
  /** The placeholders the turn registered ("{link1}"). */
  placeholders?: Iterable<string>
  /** The shop's website (https://oasisautospanj.com): its host, exactly, may be written as text. */
  website: string
  /** The shop's own phone numbers (any form): the only numbers a reply may write. */
  shopNumbers?: readonly (string | null | undefined)[]
  /** The shop's address: its own digit runs (the house number, the ZIP) are no code. */
  shopAddress?: string | null
  maxChars?: number
}

/** Markdown and list syntax out, one line. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[*_](\S(?:[^*_]*\S)?)[*_](?=[\s).,!?]|$)/gm, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** GSM-7 only: the shared SMS normalisation, then any character GSM-7 still lacks is dropped. */
export function toGsm7(text: string): string {
  let out = ''
  for (const ch of normalizeForSms(text)) out += isGsm7Char(ch) ? ch : ''
  return out.replace(/\s{2,}/g, ' ').trim()
}

/** Sentences of a text (a decimal point is not a sentence end). */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
}

/** The longest run of whole sentences within max characters; a first sentence longer than that is cut at a word. */
export function cutAtSentence(text: string, max = MAX_REPLY_CHARS): string {
  if (text.length <= max) return text
  let out = ''
  for (const s of sentencesOf(text)) {
    const next = out ? `${out} ${s}` : s
    if (next.length > max) break
    out = next
  }
  if (out) return out
  return `${text.slice(0, max - 3).replace(/\s+\S*$/, '')}...`
}

/** The text up to and including its first question mark. */
export function cutAfterFirstQuestion(text: string): string {
  const i = text.indexOf('?')
  return i < 0 ? text : text.slice(0, i + 1).trim()
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---- (A) secrets ----------------------------------------------------------------------------------------------------------------

/** What a reply never mentions (A). "code" alone counts: only the compounds of NOT_SECRET_CODE are no secret. */
const SECRET_WORDS =
  /\b(?:p[.-]?i[.-]?n(?:s|codes?|numbers?)?|p\.? i\.? n|pass[\s-]?codes?|pass[\s-]?words?|codes?|otp|card\s*(?:numbers?|details|info(?:rmation)?|digits)|cvv2?|cvc|ssn|social security|expir(?:y|ation) dates?|(?:last|first) (?:4|four) (?:digits|numbers))\b|\bdigits?\b[^.!?]{0,40}\bcards?\b|\bcards?\b[^.!?]{0,40}\bdigits?\b/i
/** Whole phrases with "code" that are no secret (an allow-list). */
const NOT_SECRET_CODE = /\b(?:zip|postal|area|dress|paint|colou?r|qr|bar)\s+codes?\b/gi
/** A 4-8 digit run on its own (not a price, a time, a phone number, a decimal, a percentage). */
const CODE_DIGITS = /(?<![\d$.,:/-])\d{4,8}(?![\d%$]|[.,:/-]\d|\s?(?:dollars?|bucks|usd)\b)/gi

/** The text without the server's safety lines, each removed only where it stands as a whole sentence (or right after a {linkN}). */
function withoutSafetyLines(text: string): string {
  let out = text
  for (const line of SAFETY_LINES) out = out.replace(new RegExp(`(?<=^|[.!?]\\s|\\}\\s)${escapeRe(line)}(?=\\s|$)`, 'g'), ' ')
  return out
}

/**
 * True when the text mentions a PIN, a code, a password, card numbers or a 4-8 digit code anywhere (A). Only a server safety line,
 * written exactly and as a whole sentence, may; a year (19xx/20xx) and the digits of the shop's own address are no code.
 */
export function mentionsSecret(text: string, shopAddress?: string | null): boolean {
  const rest = withoutSafetyLines(text).replace(NOT_SECRET_CODE, ' ')
  if (SECRET_WORDS.test(rest)) return true
  const own = new Set(shopAddress?.match(/\d+/g) ?? [])
  for (const m of rest.matchAll(CODE_DIGITS)) {
    if (/^(?:19|20)\d\d$/.test(m[0]) || own.has(m[0])) continue
    return true
  }
  return false
}

// ---- (B) promise words ----------------------------------------------------------------------------------------------------------

/** What the assistant never promises or discusses (B): one rewrite, then the fallback and a person. */
const PROMISE_WORDS =
  /\b(?:free of charge|free|freebies?|gratis|refund\w*|money back|store credit|discount\w*|coupons?|promo(?:tion)?s?|deals?|guarantee[sd]?|guaranteeing|guarant(?:y|ies)|warrant(?:y|ies)|comp(?:s|ed|ing)?|complimentary|compensat\w*|reimburs\w*|waive[sd]?|waiving|waivers?|on the house|(?:it'?s|is|be|that'?s) on us|no charge|(?:at )?no (?:extra )?cost|half[- ](?:off|price)|bogo|buy one,? get one|ready (?:by|at|in|before)|(?:done|finished) (?:by|at|before)|lawyers?|attorneys?|lawsuits?|sue[sd]?|suing|legal(?:ly)?|liab(?:le|ility)|insurance|damage[sd]?)\b|\d+\s?%\s?off\b|\$\s?\d+(?:\.\d{2})?\s+off\b|\bsave\s+(?:\$|\d)/gi
/** The only whole phrases with a promise word that pass (an allow-list): "free" meaning "without", and "feel free". */
const ALLOWED_PHRASES = /\bfeel free\b|\b(?:spot|streak|scratch|swirl|touch|toll|hands|stress|worry|hassle)[- ]free\b/gi

/** The promise words of a text, as found (lower case); a word inside an ALLOWED_PHRASES match passes, nothing else does. */
export function promiseWords(text: string): string[] {
  const allowed = [...text.matchAll(ALLOWED_PHRASES)].map((m) => [m.index, m.index + m[0].length] as const)
  const found: string[] = []
  for (const m of text.matchAll(PROMISE_WORDS)) {
    const end = m.index + m[0].length
    if (allowed.some(([from, to]) => m.index >= from && end <= to)) continue
    found.push(m[0].toLowerCase())
  }
  return [...new Set(found)]
}

// ---- (D) web addresses ----------------------------------------------------------------------------------------------------------

/** A scheme, "www", or a spelled-out dot ("oasis-pay dot com", "(dot)"). */
const SCHEME = /\bhttps?\b|:\/\/|\bwww\b|[([]\s*dot\s*[)\]]|\bdot\s+(?:com|net|org|io|co|us|app|dev|ai|shop|me|ly|info|biz)\b/i
/** Anything shaped like a host name: label.label with a last label of 2+ letters, any case ("oasis-deals.Shop", "soon.Thanks"). */
const HOSTISH = /(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?![\p{L}\p{N}-])/gu

const hostOf = (url: string): string =>
  url
    .replace(/^https?:\/\//i, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^www\./i, '')
    .toLowerCase()

/** True when the text holds a web address (D): only the shop's own host, exactly and without a path, passes. */
export function urlProblems(text: string, website: string): boolean {
  if (SCHEME.test(text)) return true
  const own = hostOf(website)
  for (const m of text.matchAll(HOSTISH)) {
    const next = text.slice(m.index + m[0].length)
    if (m[0].toLowerCase() === own && !/^[/:?#]\S/.test(next)) continue
    return true
  }
  return false
}

// ---- (E) phone numbers ----------------------------------------------------------------------------------------------------------

const digitsOf = (s: string): string => s.replace(/\D/g, '')

/** True when the text writes a phone number that is not one of the shop's own. */
export function foreignPhone(text: string, shopNumbers: readonly (string | null | undefined)[] = []): boolean {
  const own = shopNumbers.map((n) => digitsOf(n ?? '')).filter((d) => d.length >= 7)
  const isOwn = (d: string): boolean => own.some((o) => (d.length >= 10 ? o.slice(-10) === d.slice(-10) : o.slice(-7) === d.slice(-7)))
  let rest = text
  for (const re of [INTL_PHONE, NANP_PHONE, LOCAL_PHONE]) {
    for (const m of rest.matchAll(re)) if (!isOwn(digitsOf(m[0]))) return true
    rest = rest.replace(re, ' ')
  }
  return false
}

// ---- (C) prices -----------------------------------------------------------------------------------------------------------------

export interface FoundAmount {
  cents: number
  index: number
  raw: string
}

/** Dollar amounts in a text: "$45", "$1,299", "$45.50", "45$", "45 dollars", "45 bucks". */
export function findAmounts(text: string): FoundAmount[] {
  const out: FoundAmount[] = []
  const toCents = (whole: string, frac: string | undefined): number => {
    const w = Number(whole.replace(/,/g, ''))
    const f = frac ? Number(frac.padEnd(2, '0')) : 0
    return w * 100 + f
  }
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g))
    out.push({ cents: toCents(m[1]!, m[2]), index: m.index, raw: m[0] })
  for (const m of text.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s?(?:dollars?|bucks|usd)\b/gi))
    out.push({ cents: toCents(m[1]!, m[2]), index: m.index, raw: m[0] })
  for (const m of text.matchAll(/(?<![\d$.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?\$/g))
    out.push({ cents: toCents(m[1]!, m[2]), index: m.index, raw: m[0] })
  return out.sort((a, b) => a.index - b.index)
}

const COMBINATION =
  /\b(totals?|totaling|totalling|altogether|all together|combined|together|for both|for all|both for|in all|all[- ]in|comes? to|subtotal|sum|tax(?:es)?|bundle[sd]?|each additional|per extra)\b|\bplus\s+\$|\+\s*\$|\$\s?\d[\d,.]*\s*\+/i
/** "starts at" / "starting at" / "from" right before an amount (the text before it ends so). */
const QUALIFIER_BEFORE = /\b(?:starts?\s+at|starting\s+(?:at|from)|from)\s+(?:just\s+|only\s+)?$/i
/** Between two starting prices of one list ("starts at $45 for members, $54 otherwise"): short, and no new claim. */
const LIST_GAP_MAX = 30
const LIST_GAP_BREAK = /\b(?:is|are|was|were|be|costs?|runs?|pays?|charges?|totals?)\b|[;:]/i
/** A plan price: "a month" / "/month" right after the amount. */
const MONTH_AFTER = /^\s*(?:\/\s*(?:month|mo)\b|(?:a|per|each|every)\s+month\b|monthly\b)/i
/** The guest fee: "fee" right before ("the booking fee is $25") or right after ("a $25 booking fee") the amount. */
const FEE_BEFORE = /\bfees?\s*(?::\s*|(?:(?:is|are|of|costs?|runs?|at|just|only|stays)\s+){0,3})$/i
const FEE_AFTER = /^\s+(?:[a-z-]+\s+){0,2}fees?\b/i
/** Where a clause ends inside a sentence (a name in another clause does not name an amount). */
const CLAUSE_BREAK = /;|,\s*(?:and|but|while|whereas)\b|\b(?:but|while|whereas)\b/gi

/** The phrase as a whole-word pattern; spaces and hyphens interchangeable, a plural or "-ing" allowed. */
const phraseRe = (phrase: string, suffix = '(?:s|es|ing)?'): string =>
  `(?<![\\p{L}\\p{N}])${escapeRe(phrase).replace(/(?:\\-|\s)+/g, '[\\s-]+')}${suffix}(?![\\p{L}\\p{N}])`

function clauseAround(sentence: string, index: number): { start: number; end: number } {
  let start = 0
  let end = sentence.length
  for (const m of sentence.matchAll(CLAUSE_BREAK)) {
    if (m.index + m[0].length <= index) start = m.index + m[0].length
    else if (m.index >= index) {
      end = m.index
      break
    }
  }
  return { start, end }
}

/** The plan's label right before the amount (at most four words between, no comma) or "for <label>" right after "a month". */
function namesPlanNextTo(sentence: string, a: FoundAmount, labels: readonly string[], clauseStart: number, monthEnd: number): boolean {
  const before = sentence.slice(clauseStart, a.index)
  const after = sentence.slice(monthEnd)
  return labels.some(
    (l) =>
      new RegExp(`${phraseRe(l, "(?:'s)?")}(?:\\s*[:-]\\s*|\\s+)(?:[\\p{L}']+\\s+){0,4}$`, 'iu').test(before) ||
      new RegExp(`^\\s*(?:for|with|on)\\s+(?:the\\s+|a\\s+|our\\s+)?${phraseRe(l, '')}`, 'iu').test(after),
  )
}

/** An accepted starting price a list may continue: where it ends, and the names it was accepted under. */
interface ListHead {
  end: number
  names: string[]
}

/** The pricing rule of design section 3b over one text (C). */
export function pricingProblems(text: string, amounts: FactAmounts, extra: ReadonlySet<number>): GuardProblem[] {
  const problems = new Set<GuardProblem>()
  for (const sentence of sentencesOf(text)) {
    const found = findAmounts(sentence)
    if (found.length === 0) continue
    if (COMBINATION.test(sentence)) problems.add('price_combination')
    if (found.length >= 2 && /\band\b[^.!?]*\$/i.test(sentence) && /\b(both|two|all)\b/i.test(sentence)) problems.add('price_combination')
    // the previous amount when it was an accepted starting price: the names it was accepted under (a list it opens may follow)
    let list: ListHead | null = null
    for (const a of found) {
      const prev: ListHead | null = list
      list = null
      if (extra.has(a.cents)) continue
      const names = amounts.starting.get(a.cents)
      const labels = amounts.plans.get(a.cents)
      const isFee = amounts.fee !== null && amounts.fee === a.cents
      const { start, end } = clauseAround(sentence, a.index)
      // (1) a starting price: the qualifier right before it and its item (or category) named in the clause, or the next price of
      //     a list an accepted starting price opened ("starts at $45 for members, $54 otherwise")
      if (names) {
        const gap = prev === null ? null : sentence.slice(prev.end, a.index)
        if (prev && gap !== null && gap.length <= LIST_GAP_MAX && !LIST_GAP_BREAK.test(gap) && !/[$\d]/.test(gap)) {
          const shared: string[] = names.filter((n) => prev.names.includes(n))
          if (shared.length > 0) {
            list = { end: a.index + a.raw.length, names: shared }
            continue
          }
        }
        if (QUALIFIER_BEFORE.test(sentence.slice(start, a.index)) && !MONTH_AFTER.test(sentence.slice(a.index + a.raw.length))) {
          const clause = sentence.slice(start, end)
          const named = names.filter((n) => new RegExp(phraseRe(n), 'iu').test(clause))
          if (named.length > 0) {
            list = { end: a.index + a.raw.length, names: named }
            continue
          }
        }
      }
      // (2) a plan's monthly price: "a month" right after it, its label right before it
      if (labels) {
        const month = MONTH_AFTER.exec(sentence.slice(a.index + a.raw.length))
        if (month && namesPlanNextTo(sentence, a, labels, start, a.index + a.raw.length + month[0].length)) continue
      }
      // (3) the guest booking fee, stated as the fee
      if (isFee && (FEE_BEFORE.test(sentence.slice(start, a.index)) || FEE_AFTER.test(sentence.slice(a.index + a.raw.length)))) continue
      problems.add(names || labels || isFee ? 'price_unqualified' : 'price_unknown')
    }
  }
  return [...problems]
}

// ---- the verdict ----------------------------------------------------------------------------------------------------------------

/** Cleans a draft and checks every rule. */
export function guardReply(i: GuardInput): GuardVerdict {
  const max = i.maxChars ?? MAX_REPLY_CHARS
  const text = toGsm7(stripMarkdown(i.text))
  if (text.length === 0) return { kind: 'fix', text, problems: ['empty'], words: [] }
  const problems: GuardProblem[] = []
  const words = promiseWords(text)
  if (words.length > 0) problems.push('promise_words')
  const registered = new Set(i.placeholders ?? [])
  const withoutPlaceholders = text.replace(/\{link\d+\}/g, (p) => {
    if (!registered.has(p)) problems.push('unknown_placeholder')
    return ' '
  })
  if (mentionsSecret(text, i.shopAddress)) problems.push('secret')
  if (urlProblems(withoutPlaceholders, i.website)) problems.push('url')
  if (foreignPhone(withoutPlaceholders, i.shopNumbers)) problems.push('phone')
  problems.push(...pricingProblems(withoutPlaceholders, i.amounts, new Set(i.extraAmounts ?? [])))
  if ((text.match(/\?/g) ?? []).length > 1) problems.push('questions')
  if (text.length > max) problems.push('too_long')
  const unique = [...new Set(problems)]
  return unique.length === 0 ? { kind: 'ok', text } : { kind: 'fix', text, problems: unique, words }
}

/** What the rewrite call is told, per problem (plain words for the model). */
export const PROBLEM_HINTS: Record<GuardProblem, string> = {
  empty: 'The reply was empty: write the text for the client.',
  price_unknown: 'It states a dollar amount that is not a starting price, a membership price or the booking fee in SHOP FACTS. Use only those, or say the team confirms the exact price at the shop.',
  price_unqualified:
    'Write a service price as "<service> starts at $X" (the service or its category named in the same part of the sentence), a membership price as "<plan> is $X a month", and the booking fee as "the booking fee is $X".',
  price_combination: 'Never add prices up, never give a total and never price a combination; state starting prices one by one or say the team confirms the exact price.',
  url: 'Never write a web address (only the shop website as plain text, or a {linkN} placeholder a tool gave you). If it was a missing space after a full stop, add the space.',
  unknown_placeholder: 'Use only the {linkN} placeholders a tool gave you in this turn.',
  secret: 'Write nothing about PINs, codes, passwords, card numbers or digit codes, and never ask for them: the server adds the security line itself.',
  promise_words:
    'Rephrase without promising anything free, discounts, refunds, guarantees or times, and without legal, insurance or damage words (say "open times" or "openings" for availability). If the client asked for one of these, say a team member will text them back.',
  phone: "Never write a phone number other than the shop's own numbers in SHOP FACTS.",
  questions: 'Ask at most one question per text.',
  too_long: `Keep it under ${MAX_REPLY_CHARS - 20} characters.`,
}
