// The output guard (ADR 0160, design sections 3 and 3b): every text the model writes passes here before it can reach a client.
// Pure: the turn (turn.ts) decides what to do with the verdict (one rewrite call, one shorten call, a cut, or the fallback).
//
//   - plain text: markdown stripped, GSM-7 only (typography and emoji normalised like every other text; anything else dropped)
//   - at most MAX_REPLY_CHARS characters, at most one question
//   - no web address except the shop's own website as text and the server's registered {linkN} placeholders
//   - the PRICING RULE: every dollar amount must be a starting price, a plan price or the guest fee of the CURRENT shop facts (or an
//     amount a tool of this turn declared: the client's own balance), a service price must be introduced by "starts at",
//     "starting at" or "from" right before it, a plan price or the fee only in a sentence that names its plan or the fee, and no
//     amount may sit in a total or a combination ("$54 total", "$99 for both")
//   - refunds, discounts, free things, guarantees, "ready by" promises, damage and legal words: a person answers (handoff)
//   - never asks for a PIN, a code, a password or card numbers
import { isGsm7Char, normalizeForSms } from '../../integrations/sms/gsm.js'
import type { FactAmounts } from './facts.js'

/** The longest reply (characters, placeholders counted as written). */
export const MAX_REPLY_CHARS = 320

export type GuardProblem =
  | 'empty'
  | 'price_unknown'
  | 'price_unqualified'
  | 'price_combination'
  | 'url'
  | 'unknown_placeholder'
  | 'secret_request'
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
  'secret_request',
])

export type GuardVerdict =
  | { kind: 'ok'; text: string }
  | { kind: 'fix'; text: string; problems: GuardProblem[] }
  | { kind: 'handoff'; text: string; words: string[] }

export interface GuardInput {
  text: string
  amounts: FactAmounts
  /** Amounts a tool of this turn declared (ToolOutcome.amountsCents: the client's own balance). */
  extraAmounts?: Iterable<number>
  /** The placeholders the turn registered ("{link1}"). */
  placeholders?: Iterable<string>
  /** The shop's website (https://oasisautospanj.com): its host may be written as text. */
  website: string
  /**
   * What the owner wrote as an offer (facts.ts ownerWording: plan perks, service descriptions, VIP notes): a handoff word the owner
   * wrote with the same content-word neighbour ("same-day guarantee") may be repeated. Never the rendered facts: their rules
   * ("never offer a discount") are the server's words, not an offer.
   */
  ownerWording?: readonly string[]
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
/** What names a plan price or the fee when FactAmounts carries no words for an amount. */
const PLAIN_CONTEXT = /\b(?:month|monthly|membership|plan|fee)\b/i

const HANDOFF_WORDS =
  /\b(refunds?|refunded|refunding|discounts?|discounted|coupons?|promo(?:tion)?s?|promo codes?|guarantee[sd]?|guaranteeing|warrant(?:y|ies)|ready by|done by|finished by|lawyers?|attorneys?|lawsuits?|sue|suing|legal(?:ly)?|liab(?:le|ility)|insurance|damage[sd]?|compensat\w*|reimburs\w*|complimentary|on the house|no charge|waive[sd]?|free of charge)\b/gi
const FREE = /\bfree\b/gi
const BENIGN_FREE = /\b(?:feel free|free (?:slots?|spots?|times?|openings?)|toll[- ]free|hands[- ]free|stress[- ]free|worry[- ]free|scratch[- ]free|spot[- ]free|streak[- ]free|swirl[- ]free)\b/gi

/** What may never be asked for by text. */
const SECRET_NOUN =
  /\b(?:pins?|passcodes?|passwords?|codes?|card numbers?|card details|credit cards?|debit cards?|cvv|cvc|social security|ssn|(?:last|first) (?:4|four) (?:digits|numbers)|digits (?:of|on|from) (?:your|the) card)\b/i
/** Codes that are no secret. */
const NOT_SECRET = /\b(?:zip|postal|area|promo|qr|paint|color|colour|dress)\s+codes?\b/gi
/** Verbs that ask the client to pass something to us by text: never fine, whatever page or link the sentence mentions. */
const SEND_VERB = /\b(?:text|send|reply|share|give|tell)\b/i
/** Sending that is not an ask: the shop sends ("we'll text you a code"), a warning ("never text it"), "by text". */
const SEND_NOT_ASKED =
  /\b(?:we|i)(?:'ll|'ve|'d|\s+will|\s+would|\s+can|\s+just|\s+have|\s+already|\s+also)*\s+(?:text|send|sent|share|give|tell)\b|\b(?:never|don't|do not|no need to)\s+(?:\w+\s+){0,2}?(?:text|send|share|give|tell|reply)\b|\b(?:by|over|via|per|in a|a)\s+text\b/gi
/** Verbs of typing something in: fine only on the secure link page. */
const ENTRY_VERB = /\b(?:type|enter|provide|confirm|put)\b/i
const SECRET_QUESTION =
  /\bwhat(?:'s| is| are| was| were)\s+(?:your|the)\s+(?:last\s+(?:4|four)\s+(?:digits\s+)?(?:of\s+(?:your|the)\s+)?)?(?:pin|passcode|password|code|card|card number|cvv|cvc)\b/i
/** A clause of a sentence: commas, semicolons, colons and "and" / "then" / "so" / "but" split it. */
const CLAUSE_SPLIT = /[,;:]|\b(?:and|then|so|but)\b/i

/** Anything shaped like a web address: a scheme, "www.", or label.label with a letters-only top-level domain (any, .dev and .ai too). */
const URLISH = /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b(?:\/\S*)?/gi
/** Top-level domains read as an address even when capitalised ("Oasis-Pay.Com"). */
const COMMON_TLD = /^(?:com|net|org|io|co|us|info|biz|app|ly|me|link|site|online|shop|page|gl|to|xyz|dev|ai|ca|de|uk|ru|cn|tk|ml|ga|cf|gq|top|club|store|pay|cc|tv|ws|pw|nj|ny)$/i

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Neighbours that carry no wording of the owner's ("a discount", "no refunds", "offer a ..."): they never excuse a word. */
const FUNCTION_WORDS = new Set(
  'a an the any no not none never our your my their his her its we you i us me it this that these those to of on in at for with by from and or but if as is are was were be been can could will would may might do does did get gets got give gives offer offers some all every each per'.split(
    ' ',
  ),
)

/**
 * True when the word, with a content-word neighbour before or after it, is written in what the owner offers (a perk "Priority
 * booking and same-day guarantee"): the owner's wording, which the assistant may repeat.
 */
function inOwnerWording(text: string, index: number, word: string, owner: string | undefined): boolean {
  if (!owner) return false
  const before = /([\p{L}\p{N}'-]+)\s+$/u.exec(text.slice(0, index))?.[1]?.toLowerCase()
  const after = /^\s+([\p{L}\p{N}'-]+)/u.exec(text.slice(index + word.length))?.[1]?.toLowerCase()
  const w = word.toLowerCase()
  const has = (phrase: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}'-])${escapeRe(phrase)}(?![\\p{L}\\p{N}'-])`, 'u').test(owner)
  return (
    (before !== undefined && !FUNCTION_WORDS.has(before) && has(`${before} ${w}`)) ||
    (after !== undefined && !FUNCTION_WORDS.has(after) && has(`${w} ${after}`))
  )
}

/**
 * The words that hand the conversation to a person (design section 3), as found. `ownerWording` (what the owner offers: perks,
 * descriptions) excuses a word the owner wrote with the same content-word neighbour. A benign "free" ("feel free", "spot-free")
 * excuses only itself.
 */
export function handoffWords(text: string, ownerWording?: readonly string[]): string[] {
  const owner = ownerWording && ownerWording.length > 0 ? ownerWording.map((x) => x.toLowerCase()).join('\n') : undefined
  const found: string[] = []
  for (const m of text.matchAll(HANDOFF_WORDS)) if (!inOwnerWording(text, m.index, m[0], owner)) found.push(m[0].toLowerCase())
  const benign = [...text.matchAll(BENIGN_FREE)].map((b) => [b.index, b.index + b[0].length] as const)
  for (const m of text.matchAll(FREE)) {
    if (benign.some(([from, to]) => m.index >= from && m.index < to)) continue
    if (!inOwnerWording(text, m.index, m[0], owner)) found.push('free')
  }
  return [...new Set(found)]
}

/**
 * True when the text asks for a PIN, a code, a password or card numbers. Asking to text, send, reply with or tell one is always a
 * secret request, whatever link or page the sentence mentions; typing one in is fine only on the secure link page.
 */
export function asksForSecret(text: string): boolean {
  for (const s of sentencesOf(text)) {
    if (SECRET_QUESTION.test(s)) return true
    const onPage = /\b(?:page|link)\b/i.test(s)
    for (const raw of s.split(CLAUSE_SPLIT)) {
      const clause = raw.replace(NOT_SECRET, ' ')
      if (!SECRET_NOUN.test(clause)) continue
      if (SEND_VERB.test(clause.replace(SEND_NOT_ASKED, ' '))) return true
      if (ENTRY_VERB.test(clause) && !onPage) return true
    }
  }
  return false
}

const hostOf = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()

export function urlProblems(text: string, website: string): boolean {
  const own = hostOf(website)
  for (const m of text.matchAll(URLISH)) {
    const raw = m[0].replace(/[.,!?)]+$/, '')
    const host = hostOf(raw).replace(/^www\./, '')
    // "done.Thanks": a missing space after a full stop, not an address (a capitalised word, no path, no known domain)
    const tld = host.split('.').at(-1) ?? ''
    const rawTld = /\.([A-Za-z]+)$/.exec(raw.replace(/\/.*$/, ''))?.[1] ?? ''
    if (!/^https?:\/\//i.test(raw) && !/^www\./i.test(raw) && !raw.includes('/') && /^[A-Z][a-z]+$/.test(rawTld) && !COMMON_TLD.test(tld)) continue
    // the shop's own website, as text (no path): it is in the facts
    if ((host === own || host === own.replace(/^www\./, '')) && !/\/\S/.test(raw.replace(/^https?:\/\//i, ''))) {
      if (/^https?:\/\//i.test(raw) || /^www\./i.test(raw)) return true
      continue
    }
    return true
  }
  return false
}

/** True when the sentence names what a plan price or the fee is (its plan, "a month", "membership", "fee"). */
function namesPlainAmount(sentence: string, cents: number, amounts: FactAmounts): boolean {
  const words = amounts.plainWords?.get(cents)
  if (!words || words.length === 0) return PLAIN_CONTEXT.test(sentence)
  return words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'iu').test(sentence))
}

/** The pricing rule of design section 3b over one text. */
export function pricingProblems(text: string, amounts: FactAmounts, extra: ReadonlySet<number>): GuardProblem[] {
  const problems = new Set<GuardProblem>()
  for (const sentence of sentencesOf(text)) {
    const found = findAmounts(sentence)
    if (found.length === 0) continue
    if (COMBINATION.test(sentence)) problems.add('price_combination')
    if (found.length >= 2 && /\band\b[^.!?]*\$/i.test(sentence) && /\b(both|two|all)\b/i.test(sentence)) problems.add('price_combination')
    // the end of the previous amount when it was a qualified starting price (a list it opens may follow)
    let listFrom: number | null = null
    for (const a of found) {
      const isStarting = amounts.starting.has(a.cents)
      const isPlain = amounts.plain.has(a.cents)
      const isExtra = extra.has(a.cents)
      const before = sentence.slice(0, a.index)
      const gap = listFrom === null ? null : sentence.slice(listFrom, a.index)
      const qualified =
        QUALIFIER_BEFORE.test(before) || (gap !== null && gap.length <= LIST_GAP_MAX && !LIST_GAP_BREAK.test(gap) && !/\$|\d/.test(gap))
      listFrom = null
      if (isExtra) continue
      if (!isStarting && !isPlain) {
        problems.add('price_unknown')
        continue
      }
      if (isStarting && qualified) {
        listFrom = a.index + a.raw.length
        continue
      }
      if (isPlain && namesPlainAmount(sentence, a.cents, amounts)) continue
      problems.add('price_unqualified')
    }
  }
  return [...problems]
}

/** Cleans a draft and checks every rule. */
export function guardReply(i: GuardInput): GuardVerdict {
  const max = i.maxChars ?? MAX_REPLY_CHARS
  const text = toGsm7(stripMarkdown(i.text))
  if (text.length === 0) return { kind: 'fix', text, problems: ['empty'] }
  const words = handoffWords(text, i.ownerWording)
  if (words.length > 0) return { kind: 'handoff', text, words }
  const problems: GuardProblem[] = []
  if (asksForSecret(text)) problems.push('secret_request')
  const registered = new Set(i.placeholders ?? [])
  const withoutPlaceholders = text.replace(/\{link\d+\}/g, (p) => {
    if (!registered.has(p)) problems.push('unknown_placeholder')
    return ' '
  })
  if (urlProblems(withoutPlaceholders, i.website)) problems.push('url')
  problems.push(...pricingProblems(withoutPlaceholders, i.amounts, new Set(i.extraAmounts ?? [])))
  if ((text.match(/\?/g) ?? []).length > 1) problems.push('questions')
  if (text.length > max) problems.push('too_long')
  const unique = [...new Set(problems)]
  return unique.length === 0 ? { kind: 'ok', text } : { kind: 'fix', text, problems: unique }
}

/** What the rewrite call is told, per problem (plain words for the model). */
export const PROBLEM_HINTS: Record<GuardProblem, string> = {
  empty: 'The reply was empty: write the text for the client.',
  price_unknown: 'It states a dollar amount that is not a starting price, a membership price or the booking fee in SHOP FACTS. Use only those, or say the team confirms the exact price at the shop.',
  price_unqualified:
    'Write "starts at" or "from" right before a service price (it is a starting price), and name the membership or the booking fee next to its price.',
  price_combination: 'Never add prices up, never give a total and never price a combination; state starting prices one by one or say the team confirms the exact price.',
  url: 'Never write a web address (only the shop website as plain text, or a {linkN} placeholder a tool gave you).',
  unknown_placeholder: 'Use only the {linkN} placeholders a tool gave you in this turn.',
  secret_request: 'Never ask for a PIN, a code, a password or card numbers by text; codes are typed only on the secure link page.',
  questions: 'Ask at most one question per text.',
  too_long: `Keep it under ${MAX_REPLY_CHARS - 20} characters.`,
}
