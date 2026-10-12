// The output guard v4, deterministic part (ADR 0160, design sections 3, 3b and 3c): every text the model writes passes here before
// the policy judge (judge.ts) and before it can reach a client. Pure: the turn (turn.ts) decides what to do with the verdict (one
// rewrite call, one shorten call, a cut, the judge, or the fallback).
//
// GUARD v4 (orchestrator decision 2026-10-11, after three adversarial review rounds: a fixed word list cannot recognise meaning, and
// tightening it blocks ordinary replies). Three layers; this file holds the first two:
//
//   (1) SELF-CONTAINED RENDERINGS. Only placeholders carry amounts, and each renders as a full phrase that names its own subject
//       (facts.ts placeholderValues): {price:<itemKey>} "Signature Hand Wash starts at $45 for members, $54 otherwise",
//       {price:tint:<vehicle>:<film>} "Carbon tint for a sedan starts at $229 ...", {plan:<key>} "Gold is $99 a month", {fee}
//       "Guests pay a $25 booking fee", {balance} "Your open balance is $12.50". A placeholder must stand as its own clause: it starts
//       the text or follows . ! ? ; : a spaced dash or a line break, and it ends the text or is followed by . ! ? ; : , or a spaced
//       dash (`placement`), so it cannot be attached to another noun ("Window tint {price:signature-hand-wash}"), added up ("{price:a}
//       plus {price:b}") or called a total. {linkN} placeholders are links, not amounts, and may stand anywhere. Anything else in
//       braces is `unknown_placeholder`.
//   (2) A SMALL, PRECISE DETERMINISTIC LAYER on the model's raw text (placeholders out). It must not block ordinary replies, so it
//       holds only the unambiguous cases; meaning (paraphrases, slang, other languages) is the judge's:
//       - `money`: a currency sign ($ ¢ € £ ¥) or a money word: dollar(s), dólar(es), cent(s), centavo(s), peso(s), USD, and buck(s)
//         as an amount word (a capitalised "Buck" is a name);
//       - `digits`: a code or a phone number: 5+ digits in a row; 7+ digits in one group split by spaces, dashes, dots, slashes,
//         underscores or en/em dashes; 3+ numeric tokens in a row (clock times and durations included: "2:01 5:55 01:23", "201 min,
//         555 min, ...") holding 7+ digits, EVERY digit counted (clock times too); such a run passes only as a list of appointment
//         times: every token a clock time on a 5-minute step or a bare hour, strictly ascending (it may turn to the afternoon once,
//         where the written clock goes down: "11:30, 12:00, 1:30"), each inside the shop's opening window ("Openings: 9:10, 9:40, 10:20" passes, "Call
//         20:15, 5:50, 1:23" and "7:30 2:15 5:55 01" do not); 5+ spelled digits in a row; an extension ("ext 4821"); a toll-free
//         vanity number ("1 800 FLOWERS"); and the same rules over a digit skeleton where look-alike letters inside a token with
//         digits, or all-capital look-alike groups, read as digits ("2O1 5S5", "ZOI-SSS"); the shop's own numbers and the
//         server-owned literals (its address, catalog and plan names; punctuation, spacing and the state name normalised: "468 River
//         Drive, Garfield, New Jersey 07026") are out first. Client-entered text (a vehicle, a name) is never out;
//       - `url`: anything host-shaped (v3's host skeleton: "[.]", " dot ", spaced letters, "name,com"; now also "period com",
//         "point com", "punto com", "-dot-", ";com", " : com", "<word> com slash"), an IP, http/hxxp/www/"://"; only {linkN} and the
//         shop's own host as plain text (no path, not even after a space) pass;
//       - `secret` and `promise_words`: short lists of UNAMBIGUOUS words in English and Spanish (pin, passcode, password, OTP, CVV,
//         card number...; English "code" only in its secret senses: "the/your/a/that/this/what code", "the code we sent", "a
//         verification/security/confirmation/one-time/reply code", "enter codes", codes next to "secure page" or "by text"; English
//         "digit(s)" only as "6-digit code/number", "the digits we texted", "digits on your card"; so "promo code", "ZIP code",
//         "dress code", "area code" and "the last digits of your plate" pass here and the judge reads them; free (not "feel free" or
//         a non-money "-free" compound), discount, refund, coupon, guarantee, warranty, complimentary, on the house, % off; código,
//         contraseña, clave, gratis, gratuito, descuento, reembolso, garantía; no phrase that ordinary replies use: no deal, on us,
//         one-time, sue, legal or time words), matched on the plain text and a skeleton (accents stripped, look-alikes mapped,
//         spaced-out letters joined). The client's own first name and vehicles are skipped by THESE TWO LISTS ONLY ("Hi Buck",
//         "Thanks, Sue", "your Ford Focus"): never by the money, digit or host rules, and never trusted by the judge.
//       Numbers in general are allowed ("2 to 3 days", "8 to 6", "bay 2", "a 2-door", "October 12, 2026").
//   (3) The policy judge (judge.ts) reads every reply that passed (1) and (2), rendered, with the server's segments marked trusted
//       (guardReply returns them as `segments`): rendered placeholders, links, the shop's own phone numbers, address and host (the
//       turn adds the safety line). Nothing a client entered is ever trusted.
// Kept: markdown stripped (a line break ends a clause), GSM-7, at most MAX_REPLY_CHARS after rendering, at most one question.
import { isGsm7Char, normalizeForSms } from '../../integrations/sms/gsm.js'

/** The longest reply (characters, after rendering; {linkN} counted as written). */
export const MAX_REPLY_CHARS = 320

/** The safety line the server appends to a reply that carries a verify, PIN, membership or payment link (A). The model never writes it. */
export const SAFETY_LINE = 'For your security, enter codes and your PIN only on the secure page, never by text.'
/**
 * The line the server appends when the texts a turn answers hold what looks like a card number (W4 live eval: the model may write
 * nothing about cards, so a client who texted a card got no warning at all). The model never writes it.
 */
export const CARD_LINE = 'For your security, please never text card numbers.'

/** 13 to 19 digits in a row (single spaces or dashes between them allowed) that pass the Luhn check: a card number. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '')
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i])
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
      sum += d
    }
    if (sum % 10 === 0) return true
  }
  return false
}

/** The link kinds whose reply gets SAFETY_LINE. */
export const SAFETY_LINK_KINDS: ReadonlySet<string> = new Set(['verify', 'pin', 'membership', 'pay'])

export type GuardProblem =
  | 'empty'
  | 'unknown_placeholder'
  | 'placement'
  | 'money'
  | 'digits'
  | 'secret'
  | 'promise_words'
  | 'url'
  | 'questions'
  | 'too_long'

/** Problems only a rewrite can fix; a reply that still has one after the rewrite becomes the fallback. */
export const HARD_PROBLEMS: ReadonlySet<GuardProblem> = new Set(['empty', 'unknown_placeholder', 'placement', 'money', 'digits', 'secret', 'promise_words', 'url'])

/**
 * A piece of the rendered reply as the judge reads it: `trusted` = inserted by the server (rendered placeholders, links, the shop's
 * own phone numbers, address and host); never client-entered text.
 */
export interface ReplySegment {
  text: string
  trusted: boolean
}

export type GuardVerdict =
  | { kind: 'ok'; text: string; rendered: string; segments: ReplySegment[] }
  | { kind: 'fix'; text: string; rendered: string; problems: GuardProblem[]; words: string[] }

/** Minutes after midnight: the earliest opening and the latest closing time of the week. */
export interface OpenWindow {
  fromMin: number
  toMin: number
}

/** The window a run of clock times must fall in when the turn passes none (6 AM to 10 PM). */
export const DEFAULT_OPEN_WINDOW: OpenWindow = { fromMin: 6 * 60, toMin: 22 * 60 }

export interface GuardInput {
  text: string
  /**
   * Every placeholder the reply may use this turn and what the server writes for it (facts.ts placeholderValues, plus the turn's
   * {linkN}, which render as themselves: composeReply turns them into links).
   */
  values?: ReadonlyMap<string, string>
  /** The shop's website (https://oasisautospanj.com): its host, exactly and with no path, may be written as text. */
  website: string
  /** The shop's own phone numbers (any form): the only phone numbers a reply may write. */
  shopNumbers?: readonly (string | null | undefined)[]
  /**
   * Server-owned phrases that may carry digits (facts.ts factLiterals: the shop's address, catalog and plan names; NEVER client-
   * entered text such as a vehicle): the digit rules skip them where they stand, punctuation, spacing and the state name
   * normalised ("468 River Drive, Garfield, New Jersey 07026" for "468 River Drive, Garfield NJ 07026"). The judge reads them as
   * the model's text (untrusted), all but the address.
   */
  literals?: readonly (string | null | undefined)[]
  /** The shop's own address (facts.business.address): whole or any comma part, normalised as above, the judge reads it as trusted. */
  address?: string | null
  /**
   * The client's own first name and vehicles on file (client-entered): skipped by the secret and promise word lists only ("Hi Buck",
   * "your Free Spirit"); the money, digit and host rules read them, and the judge reads them as untrusted.
   */
  names?: readonly (string | null | undefined)[]
  /**
   * The shop's opening window in minutes after midnight (facts.ts openingWindow: the earliest opening, the latest closing of the
   * week): a run of clock times passes only as an ascending list inside it. Unset: DEFAULT_OPEN_WINDOW.
   */
  openWindow?: OpenWindow | null
  maxChars?: number
}

/** Markdown and list syntax out, one line; a line break that ends a line without punctuation becomes a full stop (a clause end). */
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
    .trim()
    .replace(/([\p{L}\p{N}}])[ \t]*\n\s*/gu, '$1. ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Compatibility forms folded (NFKC: full-width "ＰＩＮ" -> "PIN") and look-alike full stops ("。", "．") made a dot, before GSM-7. */
export function foldInput(text: string): string {
  return text.normalize('NFKC').replace(/[。｡．․‧]/g, '.')
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

// ---- (1) placeholders -----------------------------------------------------------------------------------------------------------

/** Anything in braces (a placeholder or an attempt at one), and a brace left alone. */
const BRACED = /\{[^{}]{0,120}\}/g
const LONE_BRACE = /[{}]/
/** The turn's link placeholders: links, not amounts (no placement rule; the judge reads them as a trusted "[link]"). */
export const LINK_PLACEHOLDER = /^\{link\d+\}$/

/** The text with every known placeholder replaced by what the server writes for it ({linkN} stay: composeReply links them). */
export function renderPlaceholders(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(BRACED, (p) => values.get(p) ?? p)
}

/** A placeholder starts a clause: the text's start, or after . ! ? ; : or a spaced dash (a line break became ". "). */
const CLAUSE_BEFORE = /(?:^|[.!?;:]|\s-)\s*$/
/** ... and ends one: the text's end, or . ! ? ; : , or a spaced dash right after it. */
const CLAUSE_AFTER = /^(?:\s*$|\s*[.!?;:,]|\s+-(?:\s|$))/

/**
 * The last resort for `placement` (W4 live eval: "{confirm}. As a guest, {fee}." survived its rewrite, so a booking that was already
 * texted for confirmation ended in the fallback): every sentence that holds a misplaced placeholder is replaced by its placeholders
 * alone, each its own sentence ("As a guest, {fee}." -> "{fee}."). The rendering names its own subject, so dropping the words around
 * it can only lose a lead-in, never attach an amount to the wrong thing. Other sentences stay as written.
 */
export function isolatePlaceholders(text: string, values: ReadonlyMap<string, string>): string {
  const misplaced = new Set(misplacedPlaceholders(text, values))
  if (misplaced.size === 0) return text
  return text
    .split(/(?<=[.!?;:])\s+/)
    .map((sentence) => {
      const own = [...sentence.matchAll(BRACED)].map((m) => m[0]).filter((p) => values.has(p))
      if (!own.some((p) => misplaced.has(p))) return sentence
      return own.map((p) => `${p}.`).join(' ')
    })
    .join(' ')
}

/** The amount placeholders of a text that do not stand as their own clause ("Window tint {price:signature-hand-wash}"). */
export function misplacedPlaceholders(text: string, values: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  for (const m of text.matchAll(BRACED)) {
    if (!values.has(m[0]) || LINK_PLACEHOLDER.test(m[0])) continue
    const before = text.slice(0, m.index)
    const after = text.slice(m.index + m[0].length)
    if (!CLAUSE_BEFORE.test(before) || !CLAUSE_AFTER.test(after)) out.push(m[0])
  }
  return out
}

// ---- the skeleton ---------------------------------------------------------------------------------------------------------------

/** Look-alike characters inside a word (a run that holds at least one letter). */
const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i', '¡': 'i' }
/** Zero-width and format characters, the soft hyphen. */
const INVISIBLE = /[\p{Cf}­]/gu
/**
 * Three or more single characters in a row, separated by spaces, dots, dashes, underscores, stars, slashes, pluses or a bare comma
 * ("f r e e", "P - I - N", "c.o.d.e", "P*I*N", "P/I/N", "P,I,N"): joined before the look-alikes are mapped.
 */
const SPACED_LETTERS = /(?<![\p{L}\p{N}@$!|¡])[\p{L}\p{N}@$!|¡](?:(?:[\s._*/+-]+|,)[\p{L}\p{N}@$!|¡](?![\p{L}\p{N}@$!|¡])){2,}/gu

/** Accents stripped (NFKD), invisible characters out, lower case. */
export function plainFold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').replace(INVISIBLE, '').toLowerCase()
}

/** Look-alikes mapped inside words ("p1n" -> "pin", "fr33" -> "free", "u$d" -> "usd"); digit-only runs stay digits. */
function mapLookalikes(text: string): string {
  return text.replace(/[\p{L}\p{N}@$!|¡]+/gu, (w) => (/\p{L}/u.test(w) ? w.replace(/[013457@$!|¡]/g, (c) => LOOKALIKE[c] ?? c) : w))
}

/** The skeleton the word lists read: folded, look-alikes mapped, spaced-out letters joined into words. */
export function skeleton(text: string): string {
  return mapLookalikes(plainFold(text).replace(SPACED_LETTERS, (m) => m.replace(/[\s._*/+,-]+/g, '')))
}

/** Top-level domains a spoken dot ("period", "point", "punto") or a ";" / ":" may stand before (common ones only: precision). */
const SPOKEN_TLDS = 'com|net|org|io|info|biz|xyz|app|dev|shop|site|online|ly'

/**
 * The skeleton the host check reads: spaced-out letters joined (a dot among them kept), "[.]", "(.)", " . ", " dot ", "-dot-",
 * "period com", "point com", "punto com", ";com", " : com" and "a,b" folded to a dot.
 */
export function hostSkeleton(text: string): string {
  return mapLookalikes(plainFold(text).replace(SPACED_LETTERS, (m) => m.replace(/[\s._*/+,-]+/g, (sep) => (sep.includes('.') ? '.' : ''))))
    .replace(/\s*(?:\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}|<\s*(?:\.|dot)\s*>)\s*/g, '.')
    .replace(/(?<=[\p{L}\p{N}])-dot-(?=[\p{L}\p{N}])/gu, '.')
    .replace(new RegExp(`(?<=[\\p{L}\\p{N}])\\s+(?:period|point|punto)\\s+(?=(?:${SPOKEN_TLDS})(?![\\p{L}\\p{N}]))`, 'gu'), '.')
    .replace(new RegExp(`(?<=[\\p{L}\\p{N}])\\s*[;:]\\s*(?=(?:com|net|org|io)(?![\\p{L}\\p{N}]))`, 'gu'), '.')
    .replace(/(?<=[\p{L}\p{N}])\s+\.\s*(?=[\p{L}\p{N}])/gu, '.')
    .replace(/(?<=[\p{L}\p{N}])\s+dot\s+(?=[\p{L}\p{N}])/gu, '.')
    .replace(/(?<=\p{L}),(?=\p{L}{2,})/gu, '.')
}

/** A phrase as a pattern that reads "i" and "l" alike (P1N -> pin, PlN -> pln: both are "p[il]n"); spaces and hyphens interchangeable. */
function fuzzy(phrase: string): string {
  return phrase
    .split(/[\s-]+/)
    .map((w) => escapeRe(w).replace(/[il]/g, '[il]'))
    .join('[\\s-]*')
}

/** A whole-word pattern over a list of phrases (each may carry its own regex tail, written after a "~"). */
function wordList(items: readonly string[]): RegExp {
  const alts = items.map((x) => {
    const [phrase, tail] = x.split('~') as [string, string | undefined]
    return `${fuzzy(phrase)}${tail ?? ''}`
  })
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'gu')
}

/** The matches of a pattern in the plain text and in the skeleton (lower case, deduplicated). */
function hits(re: RegExp, texts: readonly string[], skip?: RegExp): string[] {
  const out: string[] = []
  for (const t of texts) {
    const allowed = skip ? [...t.matchAll(skip)].map((m) => [m.index, m.index + m[0].length] as const) : []
    for (const m of t.matchAll(re)) {
      const end = m.index + m[0].length
      if (allowed.some(([from, to]) => m.index >= from && end <= to)) continue
      out.push(m[0].trim())
    }
  }
  return [...new Set(out)]
}

/** The text with the given phrases replaced by "~" where they stand as whole words (any case, any spacing). */
function withoutPhrases(text: string, phrases: readonly (string | null | undefined)[], minLength = 2): string {
  let out = text
  const list = [...new Set(phrases.map((x) => x?.trim() ?? '').filter((x) => x.length >= minLength))].sort((a, b) => b.length - a.length)
  for (const p of list) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), '~')
  return out
}

// ---- (2) money ------------------------------------------------------------------------------------------------------------------

const CURRENCY = /[$¢€£¥¤]/g
const MONEY_WORDS = wordList(['dollar~s?', 'dolar~(?:es)?', 'buck~s?', 'cent~s?', 'centavo~s?', 'peso~s?', 'usd'])
/** "Buck" / "Bucks" written as a name (capital B, the rest lower case): not a money word. */
const BUCK_NAME = /(?<![\p{L}\p{N}])Bucks?(?![\p{L}\p{N}])/gu

/** The currency signs and money words of a text, as found. */
export function moneyWords(text: string): string[] {
  const t = text.replace(BUCK_NAME, '~')
  return [...new Set([...[...t.matchAll(CURRENCY)].map((m) => m[0]), ...hits(MONEY_WORDS, [plainFold(t), skeleton(t)])])]
}

// ---- (2) secrets ----------------------------------------------------------------------------------------------------------------

const SECRET_WORDS = wordList([
  'pin~s?',
  'pincode~s?',
  'pin code~s?',
  'pin number~s?',
  'passcode~s?',
  'pass code~s?',
  'password~s?',
  'pass word~s?',
  'passphrase~s?',
  'pass phrase~s?',
  'passkey~s?',
  'pwd',
  'otp~s?',
  'one time number~s?',
  'one time password~s?',
  'personal identification',
  'secret number~s?',
  'verification number~s?',
  'security number~s?',
  'access number~s?',
  'security key~s?',
  'cvv~2?',
  'cvc',
  'card number~s?',
  'card digits',
  'card details',
  // Spanish (accents are stripped before matching: código, contraseña)
  'codigo~s?',
  'contrasena~s?',
  'clave~s?',
  'numero de tarjeta',
  'numero de tu tarjeta',
  'numero de su tarjeta',
])

/** A spelled or written count before "digit" ("6-digit", "six digit"). */
const DIGIT_COUNT = '(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)'
/**
 * English "code(s)" and "digit(s)" in their SECRET senses only (fix 3 of the v4 re-check: the bare words blocked "promo code", "ZIP
 * code", "dress code", "area code" and "the last digits of your plate"; the judge reads those): a determiner right before "code"
 * ("the/your/a/that/this/what/which code"), the code someone sent or got, a verification/security/confirmation/one-time/reply/
 * access/login code, "enter/type/send/text/share/give/read/tell (me) codes", codes in a sentence about the secure page or "by
 * text" (a security notice of the model's own), "a 6-digit code/number/PIN", "the digits we texted", "the digits on your card".
 */
const SECRET_SENSE_PHRASES = [
  '(?:the|your|ur|a|that|this|what|which|any|those|these)\\s+codes?',
  'codes?\\s+(?:(?:we|you|i|they)\\s+(?:just\\s+)?(?:sent|texted|send|text|received|receive|got|get|gave)|(?:did|do)\\s+you\\s+(?:get|receive|see)|sent|texted)',
  '(?:verification|verify|security|confirmation|confirm|one[\\s-]*time|reply|access|login|log[\\s-]*in|auth|authentication|2fa|sms|text|secret)\\s+codes?',
  '(?:enter|type|send|text|share|give|read|tell)(?:s|ed|ing)?\\s+(?:(?:me|us)\\s+)?codes?',
  'codes?\\b[^.!?]{0,60}?(?:secure|link)\\s+page',
  'codes?\\b[^.!?]{0,60}?by\\s+text',
  `${DIGIT_COUNT}[\\s-]*digits?\\s+(?:codes?|numbers?|pins?)`,
  'digits?\\s+(?:(?:we|i|they)\\s+(?:just\\s+)?(?:sent|texted|send|text)|you\\s+(?:just\\s+)?(?:got|received|get|receive))',
  'digits?\\s+(?:on|of|from)\\s+(?:the\\s+(?:back|front)\\s+of\\s+)?(?:your|the|ur)\\s+(?:card|credit\\s+card|debit\\s+card)',
]
const SECRET_SENSES = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SECRET_SENSE_PHRASES.join('|')})(?![\\p{L}\\p{N}])`, 'gu')

/** What the text says about PINs, codes, passwords or cards, as found, on the plain text and the skeleton. */
export function secretWords(text: string): string[] {
  const texts = [plainFold(text), skeleton(text)]
  return [...new Set([...hits(SECRET_WORDS, texts), ...hits(SECRET_SENSES, texts)])]
}

// ---- (2) promise words ----------------------------------------------------------------------------------------------------------

const PROMISE_WORDS = wordList([
  'free',
  'freebie~s?',
  'gratis',
  'complimentary',
  'on the house',
  'discount~\\w*',
  'percent off',
  'per cent off',
  'half off',
  'half price',
  'rebate~s?',
  'refund~\\w*',
  'money back',
  'coupon~s?',
  'waive~[sd]?',
  'guarantee~\\w*',
  'guarant~(?:y|ies)',
  'warrant~(?:y|ies)',
  // Spanish
  'gratuit~\\w*',
  'descuent~\\w*',
  'reembols~\\w*',
  'garantia~s?',
  'garantiz~\\w*',
])
/** The only phrases with "free" that pass: "feel free", "<word>-free" ("spot-free", "cash-free"), except money ones ("cost-free"). */
const FREE_OK =
  /\bfee[il][\s-]*free\b|\b(?!(?:cost|charge|fee|fees|price|payment|pay|money|wallet|dollar|buck|cent|tax|interest|risk|commission|bill|tab)-)[\p{L}]{2,}-free\b/gu

/** "10% off", "20 % off". */
const PERCENT_OFF = /%\s*off\b/g

/** The promise words of a text, as found (lower case), on the plain text and the skeleton. */
export function promiseWords(text: string): string[] {
  const texts = [plainFold(text), skeleton(text)]
  return [...new Set([...hits(PROMISE_WORDS, texts, FREE_OK), ...hits(PERCENT_OFF, texts)])]
}

// ---- (2) web addresses ----------------------------------------------------------------------------------------------------------

const SCHEME = /\bh(?:tt|xx|t|x)ps?\b|:\/\/|\bwww\d*\b/g
/** "<word> com slash ...": a spoken path. */
const SPOKEN_PATH = /[\p{L}\p{N}-]+\s+(?:com|net|org|io)\s+slash\b/gu
/** label.label: any labels of letters or digits, a last label of 2+ characters with a letter in it, any TLD. */
const HOSTISH = /(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?=[\p{N}-]*\p{L})[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}](?![\p{L}\p{N}-])/gu
const IPV4 = /(?<![\d.])\d{1,3}(?:\s*\.\s*\d{1,3}){3}(?![\d])/g

export const hostOf = (url: string): string =>
  url
    .replace(/^https?:\/\//i, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^www\./i, '')
    .toLowerCase()

/** The pattern of the shop's own host where it stands exactly, as text (no subdomain, no path or port, not even after a space). */
function ownHostPattern(website: string): RegExp | null {
  const own = hostOf(website)
  if (!own) return null
  return new RegExp(`(?<![\\p{L}\\p{N}.-])${escapeRe(own)}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}]|[/:?#]\\S|\\s+/)`, 'giu')
}

/** The text without the shop's own host where it stands exactly, as text. */
function withoutOwnHost(text: string, website: string): string {
  const re = ownHostPattern(website)
  return re ? text.replace(re, '~') : text
}

/** The web addresses of a text, on the plain text and the host skeleton; the shop's own host as text passes. */
export function urlWords(text: string, website: string): string[] {
  const rest = withoutOwnHost(text, website)
  const texts = [plainFold(rest), hostSkeleton(rest)]
  return [...new Set([...hits(SCHEME, texts), ...hits(SPOKEN_PATH, texts), ...hits(HOSTISH, texts), ...hits(IPV4, texts)])]
}

// ---- (2) codes and phone numbers ------------------------------------------------------------------------------------------------

/** 5 or more digits in a row. */
const RUN5 = /\d{5,}/g
/** Digits in one group split by spaces, dashes, dots, slashes, underscores or en/em dashes (7+ digits: a phone or a code). */
const GROUP = /\d+(?:[\s./_\-–—]+\d+)*/g
/** An extension ("ext 4821", "extension #12"). */
const EXTENSION = /\b(?:ext|extension)\.?\s*#?\s*\d+/gi
/** A toll-free vanity number ("1 800 FLOWERS", "888-CARWASH"). */
const VANITY = /(?<![\p{L}\p{N}])(?:1[\s.-]?)?8(?:00|33|44|55|66|77|88)[\s.-]?[A-Z]{4,}(?![\p{L}])/gu
/** Words that keep a run of numeric tokens going ("201 min, 555 min, ..."). */
const UNIT_WORDS = new Set(['min', 'mins', 'minute', 'minutes', 'm', 'hr', 'hrs', 'hour', 'hours', 'h', 'sec', 'secs', 'second', 'seconds', 's', 'am', 'pm', 'a.m.', 'p.m.', 'a.m', 'p.m', 'oclock'])
/** Characters that keep a run of numeric tokens going. */
const RUN_SEPARATORS = new Set([',', ';', ':', '.', '/', '-', '–', '—', '_', '*', '+', '(', ')', '#', "'", '"'])
/** A clock time ("9:10", "08:30", "16:45") or a bare hour without a leading zero ("9", "10"): hours and minutes. */
function clockOf(tok: string): { h: number; m: number } | null {
  const t = /^(\d{1,2}):(\d{2})$/.exec(tok)
  if (t) {
    const h = Number(t[1])
    const m = Number(t[2])
    return h <= 23 && m <= 59 && m % 5 === 0 ? { h, m } : null
  }
  return /^(?:[1-9]|1\d|2[0-3])$/.test(tok) ? { h: Number(tok), m: 0 } : null
}

/**
 * A run of numeric tokens that reads as a list of appointment times (fix 2 of the v4 re-check; the digits are counted first, clock
 * times included): every token a clock time on a 5-minute step or a bare hour, strictly ascending, each inside the opening window.
 * A 1-to-11 o'clock time may read as the afternoon from one point on, where the written clock goes down ("11:30, 12:00, 1:30"), or
 * for the whole list ("5:00, 5:30, 5:45" when the shop opens at 8). So "Openings today: 9:10, 9:40, 10:20." and "Openings: 08:00,
 * 08:30, 09:00." pass, and a phone number written as times ("Call 20:15, 5:50, 1:23.", "7:30 2:15 5:55 01") does not.
 */
export function isTimeList(tokens: readonly string[], window: OpenWindow = DEFAULT_OPEN_WINDOW): boolean {
  const clocks = tokens.map(clockOf)
  if (clocks.length === 0 || clocks.some((c) => c === null)) return false
  const written = clocks.map((c) => c!.h * 60 + c!.m)
  // the tokens from index `pm` on read as the afternoon (pm = length: none does)
  const reads = (pm: number): boolean => {
    if (pm > 0 && pm < written.length && !(written[pm]! < written[pm - 1]!)) return false
    let prev = -1
    for (let i = 0; i < clocks.length; i++) {
      const { h } = clocks[i]!
      const v = written[i]! + (i >= pm && h >= 1 && h <= 11 ? 720 : 0)
      if (v <= prev || v < window.fromMin || v > window.toMin) return false
      prev = v
    }
    return true
  }
  for (let pm = 0; pm <= clocks.length; pm++) if (reads(pm)) return true
  return false
}

/** Spelled digits, English and Spanish. */
const DIGIT_WORD = '(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine|cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)'
/** Five or more spelled digits in a row ("two oh one five five five"). */
const SPELLED_RUN = new RegExp(`(?<![\\p{L}])${DIGIT_WORD}(?:[\\s,.-]+${DIGIT_WORD}){4,}(?![\\p{L}])`, 'gu')

/**
 * Runs of 3+ numeric tokens (clock times, units and punctuation between them) that hold 7+ digits, every digit counted (clock times
 * too), unless the run is a list of appointment times (isTimeList).
 */
function phoneLikeRuns(text: string, window: OpenWindow): string[] {
  const out: string[] = []
  const tokens = text.matchAll(/(\d{1,2}:\d{2}(?!\d)|\d+)|([\p{L}][\p{L}.']*)|(\S)/gu)
  let start = -1
  let end = -1
  let nums: string[] = []
  let digits = 0
  const close = (): void => {
    if (nums.length >= 3 && digits >= 7 && !isTimeList(nums, window)) out.push(text.slice(start, end))
    start = -1
    nums = []
    digits = 0
  }
  for (const m of tokens) {
    const [tok, num, word] = m
    if (num !== undefined) {
      if (start < 0) start = m.index
      end = m.index + tok.length
      nums.push(num)
      digits += num.replace(/\D/g, '').length
    } else if (word !== undefined) {
      if (!(nums.length > 0 && UNIT_WORDS.has(word.toLowerCase().replace(/'/g, '')))) close()
    } else if (!RUN_SEPARATORS.has(tok)) close()
  }
  close()
  return out
}

/** Digits for look-alike letters, in the tokens a phone number hides in. */
const LOOK_DIGIT: Record<string, string> = { o: '0', i: '1', l: '1', z: '2', e: '3', a: '4', s: '5', t: '7', b: '8', g: '9', q: '9' }
const toDigits = (w: string): string => w.replace(/[a-z]/gi, (c) => LOOK_DIGIT[c.toLowerCase()] ?? c)
/**
 * The digit skeleton: a token that mixes digits with look-alike letters only ("2O1", "O1Z3"; not an ordinal like "1st"), and a group
 * of all-capital look-alike tokens joined by dashes, dots, slashes or underscores ("ZOI-SSS-OIZE"), written as digits.
 */
export function digitSkeleton(text: string): string {
  return text
    .replace(/(?<![\p{L}\p{N}])(?=[\p{L}\p{N}]*\d)(?=[\p{L}\p{N}]*[a-z])[0-9oilzeastbgq]+(?![\p{L}\p{N}])/giu, (w) => (/^\d+(?:st|nd|rd|th)$/i.test(w) ? w : toDigits(w)))
    .replace(/(?<![\p{L}\p{N}])[OILZEASTBG0-9]{2,}(?:[-./_–][OILZEASTBG0-9]{2,})+(?![\p{L}\p{N}])/gu, (w) => (/[A-Z]/.test(w) ? toDigits(w) : w))
}

/** The codes and phone numbers of a text (already without the shop's own numbers and the server-owned literals), as found. */
export function digitWords(text: string, window: OpenWindow = DEFAULT_OPEN_WINDOW): string[] {
  const out: string[] = []
  for (const t of new Set([text, digitSkeleton(text)])) {
    for (const m of t.matchAll(RUN5)) out.push(m[0])
    for (const m of t.matchAll(GROUP)) if (m[0].replace(/\D/g, '').length >= 7) out.push(m[0])
    out.push(...phoneLikeRuns(t, window))
  }
  for (const m of text.matchAll(EXTENSION)) out.push(m[0])
  for (const m of text.matchAll(VANITY)) out.push(m[0])
  for (const m of plainFold(text).matchAll(SPELLED_RUN)) out.push(m[0])
  return [...new Set(out.map((x) => x.trim()))]
}

/** The shop's own phone numbers (any spacing of their digits) where they stand. */
function shopNumberPatterns(shopNumbers: readonly (string | null | undefined)[]): RegExp[] {
  const out: RegExp[] = []
  for (const n of shopNumbers) {
    const d = (n ?? '').replace(/\D/g, '')
    if (d.length < 10) continue
    const flexible = d.slice(-10).split('').join('[\\s().\\/_–-]{0,2}')
    out.push(new RegExp(`(?<![\\d+])(?:\\+?1[\\s().\\/_–-]{0,2})?\\(?${flexible}(?!\\d)`, 'g'))
  }
  return out
}

/** US states and DC: the code and the name, either may stand for the other in a server-owned literal ("NJ" / "New Jersey"). */
const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}
/** Commas and spaces between the words of a literal: any mix of them, at least one. */
const LITERAL_SEP = '[\\s,]+'

/**
 * A server-owned literal as a pattern, punctuation and spacing normalised (fix 4 of the v4 re-check): its words in order, any run
 * of spaces and commas between them, the full stop of an abbreviation optional ("Dr."), a US state as its code, its name or "N.J." ("468
 * River Drive, Garfield NJ 07026" matches "468 River Drive, Garfield, New Jersey 07026"). Whole words only.
 */
function literalPattern(literal: string): RegExp {
  let text = literal.trim()
  for (const [code, name] of Object.entries(US_STATES)) text = text.replace(new RegExp(`(?<![\\p{L}])${name.replace(/ /g, '\\s+')}(?![\\p{L}])`, 'giu'), code)
  const words = text.split(/[\s,]+/).filter((w) => w !== '')
  const parts = words.map((w) => {
    const name = /^[A-Z]{2}$/.test(w) ? US_STATES[w] : undefined
    if (name) return `(?:${w}|${w[0]}\\.\\s?${w[1]}\\.?|${name.replace(/ /g, '\\s+')})`
    // an abbreviation written with its full stop in the literal ("Dr.") may be written without it
    return w.endsWith('.') ? `${escapeRe(w.slice(0, -1))}\\.?` : escapeRe(w)
  })
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join(LITERAL_SEP)}(?![\\p{L}\\p{N}])`, 'giu')
}

/** The patterns of server-owned literals, longest first (a whole address before its parts). */
function literalPatterns(literals: readonly (string | null | undefined)[], minLength = 2): RegExp[] {
  return [...new Set(literals.map((x) => x?.trim() ?? '').filter((x) => x.length >= minLength))].sort((a, b) => b.length - a.length).map(literalPattern)
}

/** The shop's address as literals: whole, and each comma part. */
export function addressLiterals(address: string | null | undefined): string[] {
  const a = address?.trim() ?? ''
  return a ? [...new Set([a, ...a.split(',').map((x) => x.trim()).filter((x) => x !== '')])] : []
}

/** The text without the server-owned literals and the shop's own phone numbers. */
function withoutLiterals(text: string, literals: readonly (string | null | undefined)[], shopNumbers: readonly (string | null | undefined)[]): string {
  let out = text
  for (const re of literalPatterns(literals)) out = out.replace(re, '~')
  for (const re of shopNumberPatterns(shopNumbers)) out = out.replace(re, '~')
  return out
}

// ---- (3) the judge's view -------------------------------------------------------------------------------------------------------

/**
 * The rendered reply as segments for the judge: the model's own text (untrusted) and what the server wrote (trusted): rendered
 * placeholders, links (as "[link]": the judge never sees a URL or a token), the shop's own phone numbers, address and website.
 * Nothing else is trusted: not the catalog names the model copied, and never client-entered text (a vehicle, a name).
 */
export function replySegments(text: string, o: { values: ReadonlyMap<string, string>; website: string; shopNumbers?: readonly (string | null | undefined)[]; address?: string | null }): ReplySegment[] {
  const out: ReplySegment[] = []
  const push = (s: ReplySegment): void => {
    if (s.text === '') return
    const last = out[out.length - 1]
    if (last && last.trusted === s.trusted) last.text += s.text
    else out.push({ ...s })
  }
  // the own facts inside the model's text: phone numbers, the address (whole and its parts, normalised), the website as text
  const own: RegExp[] = [...shopNumberPatterns(o.shopNumbers ?? [])]
  const host = ownHostPattern(o.website)
  if (host) own.push(host)
  own.push(...literalPatterns(addressLiterals(o.address), 3))
  const plain = (s: string): void => {
    let pieces: ReplySegment[] = [{ text: s, trusted: false }]
    for (const re of own)
      pieces = pieces.flatMap((p) => {
        if (p.trusted) return [p]
        const parts: ReplySegment[] = []
        let at = 0
        for (const m of p.text.matchAll(re)) {
          parts.push({ text: p.text.slice(at, m.index), trusted: false }, { text: m[0], trusted: true })
          at = m.index + m[0].length
        }
        parts.push({ text: p.text.slice(at), trusted: false })
        return parts
      })
    for (const p of pieces) push(p)
  }
  let at = 0
  for (const m of text.matchAll(BRACED)) {
    const value = o.values.get(m[0])
    if (value === undefined) continue
    plain(text.slice(at, m.index))
    push({ text: LINK_PLACEHOLDER.test(m[0]) ? '[link]' : toGsm7(value), trusted: true })
    at = m.index + m[0].length
  }
  plain(text.slice(at))
  return out
}

// ---- the verdict ----------------------------------------------------------------------------------------------------------------

/** Cleans a draft, checks every deterministic rule on the model's raw text and, when it passes, renders the placeholders. */
export function guardReply(i: GuardInput): GuardVerdict {
  const max = i.maxChars ?? MAX_REPLY_CHARS
  const values = i.values ?? new Map<string, string>()
  const text = toGsm7(stripMarkdown(foldInput(i.text)))
  if (text.length === 0) return { kind: 'fix', text, rendered: text, problems: ['empty'], words: [] }
  const problems: GuardProblem[] = []
  const words: string[] = []
  const flag = (p: GuardProblem, found: readonly string[]): void => {
    if (found.length === 0) return
    problems.push(p)
    words.push(...found)
  }
  // (1) placeholders: only the known ones, each an own clause; each is taken out before any other check
  const unknown: string[] = []
  // a placeholder becomes "~" (no letter, digit or space: it can neither join nor split a word, a number or a host)
  const raw = text.replace(BRACED, (p) => {
    if (!values.has(p)) unknown.push(p)
    return '~'
  })
  if (LONE_BRACE.test(raw)) unknown.push(raw.match(LONE_BRACE)![0])
  flag('unknown_placeholder', unknown)
  flag('placement', misplacedPlaceholders(text, values))
  // (2) the secret and promise word lists never read the client's own name or vehicles ("Hi Buck", "your Free Spirit"); every other
  // rule reads them (client-entered text is never trusted: a vehicle "Free Wash 2015550123" is still a phone number). A currency
  // sign GSM-7 would drop ("45¢") still counts.
  const worded = withoutPhrases(raw, i.names ?? [])
  const dropped = [...foldInput(i.text).replace(BRACED, '~').matchAll(CURRENCY)].map((m) => m[0])
  flag('money', [...new Set([...dropped, ...moneyWords(raw)])])
  flag('secret', secretWords(worded))
  flag('promise_words', promiseWords(worded))
  flag('url', urlWords(raw, i.website))
  const literals = [...addressLiterals(i.address), ...(i.literals ?? [])]
  flag('digits', digitWords(withoutOwnHost(withoutLiterals(raw, literals, i.shopNumbers ?? []), i.website), i.openWindow ?? DEFAULT_OPEN_WINDOW))
  // the form: one question, the length after rendering
  const rendered = toGsm7(renderPlaceholders(text, values))
  if ((rendered.match(/\?/g) ?? []).length > 1) problems.push('questions')
  if (rendered.length > max) problems.push('too_long')
  const unique = [...new Set(problems)]
  if (unique.length > 0) return { kind: 'fix', text, rendered, problems: unique, words: [...new Set(words)] }
  const segments = replySegments(text, { values, website: i.website, shopNumbers: i.shopNumbers ?? [], address: i.address ?? null })
  return { kind: 'ok', text, rendered, segments }
}

/** What the rewrite call is told, per problem (plain words for the model). */
export const PROBLEM_HINTS: Record<GuardProblem, string> = {
  empty: 'The reply was empty: write the text for the client.',
  unknown_placeholder:
    'Use only these placeholders, exactly: {price:<key>} or {price:tint:<vehicle>:<film>} with a key from SHOP FACTS, {plan:<key>}, {perks:<key>}, {fee}, {balance} (only after get_balance in this turn), {confirm} (only after a proposal in this turn) and {linkN} exactly as send_link returned it.',
  placement:
    'Write each price placeholder as its own sentence, with nothing attached to it: "{price:<key>}." The server writes the whole sentence, the service name included ("Signature Hand Wash starts at ..."). Never put a name, "plus", "and", "total" or another placeholder right before or after it.',
  money:
    'Never write an amount, a currency sign or a money word (dollars, bucks, cents, USD, pesos). Write the placeholder as its own sentence and the server fills in the amount: "{price:<key>}.", "{plan:<key>}.", "{fee}.", "{balance}." (after get_balance). Never add prices up or give a total.',
  digits: 'Never write a digit code or a phone number, in any form (split by spaces, dashes or dots, as times, in words or with letters for digits): only the shop\'s own numbers in SHOP FACTS.',
  secret:
    'Write nothing about PINs, codes, passwords or card numbers, never ask for them and do not write a security reminder: the server adds the security line itself.',
  promise_words:
    'Rephrase without promising anything free, discounts, refunds, coupons or guarantees (say "open times" or "openings" for availability). If the client asked for one of these, say a team member will text them back.',
  url: 'Never write a web address or anything shaped like one (name.com, name dot com, an IP address, http, www): only the shop website exactly as in SHOP FACTS, or a {linkN} placeholder a tool gave you. If it was a missing space after a full stop or a comma, add the space.',
  questions: 'Ask at most one question per text.',
  too_long: `Keep it under ${MAX_REPLY_CHARS - 20} characters.`,
}
