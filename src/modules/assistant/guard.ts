// The output guard (ADR 0160, design sections 3 and 3b): every text the model writes passes here before it can reach a client.
// Pure: the turn (turn.ts) decides what to do with the verdict (one rewrite call, one shorten call, a cut, or the fallback).
//
//   - plain text: markdown stripped, GSM-7 only (typography and emoji normalised like every other text; anything else dropped)
//   - at most MAX_REPLY_CHARS characters, at most one question
//   - no web address except the shop's own website as text and the server's registered {linkN} placeholders
//   - the PRICING RULE: every dollar amount must be a starting price, a plan price or the guest fee of the CURRENT shop facts (or an
//     amount a tool of this turn declared: the client's own balance), a service price must be introduced by "starts at",
//     "starting at" or "from", and no amount may sit in a total or a combination ("$54 total", "$99 for both")
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
  /** The rendered shop facts: a handoff word in the owner's own wording (a perk, an FAQ answer) may be repeated. */
  factsText?: string
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

/** Dollar amounts in a text: "$45", "$1,299", "$45.50", "45 dollars", "45 bucks". */
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
  return out.sort((a, b) => a.index - b.index)
}

const COMBINATION =
  /\b(totals?|totaling|totalling|altogether|all together|combined|together|for both|for all|both for|in all|all[- ]in|comes? to|subtotal|sum|tax(?:es)?|bundle[sd]?|each additional|per extra)\b|\bplus\s+\$|\+\s*\$|\$\s?\d[\d,.]*\s*\+/i
const QUALIFIER = /\b(starts?\s+at|starting\s+at|from)\b/i

const HANDOFF_WORDS =
  /\b(refunds?|refunded|refunding|discounts?|discounted|coupons?|promo(?:tion)?s?|promo codes?|guarantee[sd]?|guaranteeing|warrant(?:y|ies)|ready by|done by|finished by|lawyers?|attorneys?|lawsuits?|sue|suing|legal(?:ly)?|liab(?:le|ility)|insurance|damage[sd]?|compensat\w*|reimburs\w*|complimentary|on the house|no charge|waive[sd]?|free of charge)\b/gi
const FREE = /\bfree\b/gi
const BENIGN_FREE = /(feel free|free (?:to|slots?|spots?|times?|openings?)|toll[- ]free|hands[- ]free|stress[- ]free|worry[- ]free|scratch[- ]free|spot[- ]free|streak[- ]free|swirl[- ]free)/i

const SECRET_ASK =
  /\b(text|send|reply|share|give|tell|type|enter|provide|confirm)\b[^.!?]{0,40}\b(pins?|passcodes?|passwords?|verification codes?|security codes?|one[- ]time codes?|log[- ]?in codes?|sign[- ]in codes?|card numbers?|card details|credit cards?|debit cards?|cvv|cvc|social security|ssn)\b/i
const SECRET_QUESTION = /\bwhat(?:'s| is| are)\s+(?:your|the)\s+(pin|passcode|password|code|card|card number|cvv)\b/i
const CODE_BY_TEXT = /\b(text|send|reply|give|tell)\b(?:\s+(?:me|us))?(?:\s+with)?(?:\s+(?:your|the))?\s+code\b/i

const URLISH = /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|us|info|biz|app|ly|me|link|site|online|shop|page|gl|to|xyz)\b(?:\/\S*)?/gi

/**
 * True when the word, with the word before or after it, is written in the shop's own facts (a perk "Priority booking and same-day
 * guarantee", an FAQ answer): the owner's wording, which the assistant may repeat.
 */
function inFacts(text: string, index: number, word: string, facts: string | undefined): boolean {
  if (!facts) return false
  const before = /([\p{L}\p{N}'-]+)\s+$/u.exec(text.slice(0, index))?.[1]
  const after = /^\s+([\p{L}\p{N}'-]+)/u.exec(text.slice(index + word.length))?.[1]
  const w = word.toLowerCase()
  return (before !== undefined && facts.includes(`${before.toLowerCase()} ${w}`)) || (after !== undefined && facts.includes(`${w} ${after.toLowerCase()}`))
}

/**
 * The words that hand the conversation to a person (design section 3), as found. `facts` (the rendered shop facts, lower case)
 * excuses a word the owner's own wording uses with the same neighbour.
 */
export function handoffWords(text: string, facts?: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(HANDOFF_WORDS)) if (!inFacts(text, m.index, m[0], facts)) found.push(m[0].toLowerCase())
  for (const m of text.matchAll(FREE)) {
    const around = text.slice(Math.max(0, m.index - 12), m.index + 16)
    if (!BENIGN_FREE.test(around) && !inFacts(text, m.index, m[0], facts)) found.push('free')
  }
  return [...new Set(found)]
}

/** True when the text asks for a PIN, a code, a password or card numbers (entering one on the link page is fine). */
export function asksForSecret(text: string): boolean {
  for (const s of sentencesOf(text)) {
    const onPage = /\b(page|link)\b/i.test(s)
    if (SECRET_QUESTION.test(s)) return true
    if (!onPage && (SECRET_ASK.test(s) || CODE_BY_TEXT.test(s))) return true
  }
  return false
}

const hostOf = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()

export function urlProblems(text: string, website: string): boolean {
  const own = hostOf(website)
  for (const m of text.matchAll(URLISH)) {
    const raw = m[0].replace(/[.,!?)]+$/, '')
    const host = hostOf(raw).replace(/^www\./, '')
    // the shop's own website, as text (no path): it is in the facts
    if ((host === own || host === own.replace(/^www\./, '')) && !/\/\S/.test(raw.replace(/^https?:\/\//i, ''))) {
      if (/^https?:\/\//i.test(raw) || /^www\./i.test(raw)) return true
      continue
    }
    return true
  }
  return false
}

/** The pricing rule of design section 3b over one text. */
export function pricingProblems(text: string, amounts: FactAmounts, extra: ReadonlySet<number>): GuardProblem[] {
  const problems = new Set<GuardProblem>()
  let offset = 0
  for (const sentence of sentencesOf(text)) {
    const start = text.indexOf(sentence, offset)
    offset = start + sentence.length
    const found = findAmounts(sentence)
    if (found.length === 0) continue
    if (COMBINATION.test(sentence)) problems.add('price_combination')
    if (found.length >= 2 && /\band\b[^.!?]*\$/i.test(sentence) && /\b(both|two|all)\b/i.test(sentence)) problems.add('price_combination')
    for (const a of found) {
      const isStarting = amounts.starting.has(a.cents)
      const isPlain = amounts.plain.has(a.cents) || extra.has(a.cents)
      if (!isStarting && !isPlain) {
        problems.add('price_unknown')
        continue
      }
      if (isStarting && !isPlain && !QUALIFIER.test(sentence.slice(0, a.index))) problems.add('price_unqualified')
    }
  }
  return [...problems]
}

/** Cleans a draft and checks every rule. */
export function guardReply(i: GuardInput): GuardVerdict {
  const max = i.maxChars ?? MAX_REPLY_CHARS
  const text = toGsm7(stripMarkdown(i.text))
  if (text.length === 0) return { kind: 'fix', text, problems: ['empty'] }
  const words = handoffWords(text, i.factsText?.toLowerCase())
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
  price_unqualified: 'A service price must be introduced by "starts at" or "from" (it is a starting price).',
  price_combination: 'Never add prices up, never give a total and never price a combination; state starting prices one by one or say the team confirms the exact price.',
  url: 'Never write a web address (only the shop website as plain text, or a {linkN} placeholder a tool gave you).',
  unknown_placeholder: 'Use only the {linkN} placeholders a tool gave you in this turn.',
  secret_request: 'Never ask for a PIN, a code, a password or card numbers by text; codes are typed only on the secure link page.',
  questions: 'Ask at most one question per text.',
  too_long: `Keep it under ${MAX_REPLY_CHARS - 20} characters.`,
}
