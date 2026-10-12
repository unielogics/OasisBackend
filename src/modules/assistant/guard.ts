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
//       plus {price:b}") or called a total. A placeholder followed by a new sentence without its full stop ("{fee} Want to
//       book?") gets the full stop from the server (punctuatePlaceholders). {linkN} placeholders are links, not amounts, and may stand anywhere. Anything else in
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
//         shop's own host as plain text (no path, not even after a space; "https://" or "http://" and a trailing slash allowed) pass;
//       - `secret`: only an unambiguous REQUEST for an account or card secret (W4a fix F2): a request verb (send, reply, text,
//         tell, type, give, share, read, provide, confirm; envía, manda, dime, dame, escribe, responde...), "what is your", "cuál es
//         tu" or "need your" (never right after a negation: "don't send card numbers by text" protects), then, in the same clause, a PIN, passcode, password, OTP, CVV, a card number or details, a
//         verification/security/one-time code, "the/your code", "the 6 digits", "the digits on your card" (contraseña, clave,
//         código but not código postal/promocional, número de tu tarjeta); on the plain text and a skeleton (accents stripped,
//         look-alikes mapped, spaced-out letters joined). The shop's own sending ("we'll text you a code") is not a request. A
//         MENTION is the judge's ("I lost the code", "ZIP code", a quoted "PIN", a security notice of the model's own). There is no
//         promise word list any more (free, discount, refund, guarantee, gratis, descuento...): promises are the judge's, which
//         reads them in any wording ("is the wax free?" quoted back is no promise). The client's own first name and vehicles are
//         skipped by the secret check ONLY ("Thanks, Clave"): never by the money, digit or host rules, and never trusted by the
//         judge.
//       Numbers in general are allowed ("2 to 3 days", "8 to 6", "bay 2", "a 2-door", "October 12, 2026").
//   (3) The policy judge (judge.ts) reads every reply that passed (1) and (2), rendered, with the server's segments marked trusted
//       (guardReply returns them as `segments`): rendered placeholders, links, the shop's own phone numbers, address and host (the
//       turn adds the safety line). Nothing a client entered is ever trusted.
// Kept: markdown stripped (a line break ends a clause), GSM-7, at most MAX_REPLY_CHARS after rendering, at most one question.
import { isGsm7Char, normalizeForSms } from '../../integrations/sms/gsm.js'
import { holdsCardNumber } from '../messaging/inbound/cards.js'
import { CARD_LINES, SAFETY_LINES } from './lang.js'

/** The longest reply (characters, after rendering; {linkN} counted as written). */
export const MAX_REPLY_CHARS = 320

/** The safety line the server appends to a reply that carries a verify, PIN, membership or payment link (A). The model never writes it. */
export const SAFETY_LINE = SAFETY_LINES.en
/**
 * The line the server appends when the texts a turn answers hold what looks like a card number (W4 live eval: the model may write
 * nothing about cards, so a client who texted a card got no warning at all). The model never writes it.
 */
export const CARD_LINE = CARD_LINES.en

/**
 * 13 to 19 digits in a row (single spaces or dashes between them allowed) that pass the Luhn check: a card number; or one the inbound
 * path already masked ("[card ending 1111]", W4b X6: a card number is never filed readable).
 */
export function looksLikeCardNumber(text: string): boolean {
  return holdsCardNumber(text)
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
  | 'url'
  | 'questions'
  | 'too_long'
  /** W4b X3: says something is booked, moved, cancelled, confirmed or "all set" while the server executed no such action. */
  | 'action_claim'
  /** The model's own notes in the text: "the client" in the third person, a self-correction, a recited writing rule. */
  | 'meta'
  /**
   * W4 final check L6: for a phone the server gives no open times (not verified, or in-chat booking off), a time named as open or
   * available, a day or part of a day named so with no check_availability result on the record, or "you're verified" while the
   * phone is not.
   */
  | 'unverified_claim'

/** Problems only a rewrite can fix; a reply that still has one after the rewrite becomes the fallback. */
export const HARD_PROBLEMS: ReadonlySet<GuardProblem> = new Set(['empty', 'unknown_placeholder', 'placement', 'money', 'digits', 'secret', 'url', 'meta'])

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
   * The client's own first name and vehicles on file (client-entered): skipped by the secret request check only ("Thanks, Clave",
   * "your Free Spirit"); the money, digit and host rules read them, and the judge reads them as untrusted.
   */
  names?: readonly (string | null | undefined)[]
  /**
   * The shop's opening window in minutes after midnight (facts.ts openingWindow: the earliest opening, the latest closing of the
   * week): a run of clock times passes only as an ascending list inside it. Unset: DEFAULT_OPEN_WINDOW.
   */
  openWindow?: OpenWindow | null
  maxChars?: number
  /**
   * W4b X3: check for claims that something is booked, moved, cancelled, confirmed or "all set" (actionClaims). The turn sets it
   * while the server executed no action since the assistant's last text and no rewrite was used yet; a claim left after the one
   * rewrite is the policy judge's, which reads the server's record of what was done and the client's visits.
   */
  checkActionClaims?: boolean
  /**
   * W4 final check L6: the phone is given no open times in the chat (not verified, or in-chat booking off): a clock time named as
   * open, available or working is a claim the server cannot back; a day or a part of a day named so is one unless check_availability
   * ran for it (`dayChecked`: a result in this turn or earlier in the conversation; the judge reads which day). Unset: not checked.
   */
  checkAvailabilityClaims?: { dayChecked: boolean } | null
  /** W4 final check L6: false while the phone is not verified: "you're verified" is a false claim. Unset: not checked. */
  phoneVerified?: boolean
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

/** The text without its questions (each sentence that ends with "?"), or null when nothing else is left. */
export function withoutQuestions(text: string): string | null {
  const kept = sentencesOf(text).filter((s) => !/\?\s*$/.test(s))
  return kept.length > 0 ? kept.join(' ') : null
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

/** What may start the next sentence right after a placeholder: a capital letter, ¿ or ¡, or another placeholder. */
const NEXT_SENTENCE = /^\s+(?:[\p{Lu}¿¡]|\{[^{}]{1,120}\})/u

/**
 * A placeholder followed by a new sentence without its full stop ("{price:signature-hand-wash} Want me to book it?", "{plan:gold}
 * {plan:vip} Would you like ...", "{balance} You can pay it at the shop."): the server writes the full stop instead of rejecting the
 * reply (guard polish after W4b-fix, W4a fresh set: 11 of its 120 ordinary rows were refused for it). Only a known amount
 * placeholder, only before a capital letter, ¿, ¡ or another placeholder: "{price:a} plus {price:b}" and "Our wash {price:a}" stay
 * misplaced (the words before a placeholder are never touched).
 */
export function punctuatePlaceholders(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(BRACED, (p: string, at: number) => {
    if (!values.has(p) || LINK_PLACEHOLDER.test(p)) return p
    const rest = text.slice(at + p.length)
    const next = NEXT_SENTENCE.exec(rest)
    if (!next) return p
    // a following brace counts only when it is a placeholder the server knows
    const brace = /\{[^{}]{1,120}\}$/.exec(next[0])
    if (brace && !values.has(brace[0])) return p
    return `${p}.`
  })
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

// ---- (2) secret requests --------------------------------------------------------------------------------------------------------

/**
 * The secret REQUEST check (W4a fix F2): only an unambiguous request for an account or card secret blocks here, so a mention of one
 * ("I lost the code", "the ZIP code", a quoted "PIN") reaches the judge, which reads meaning. A request is a request verb, or "what
 * is/are your", or "need your", followed in the same clause (at most 60 characters, no . ! ? ;) by a secret noun, or a secret noun
 * followed by "please" ("Your verification code, please"); on the plain text
 * and the skeleton (accents stripped, look-alikes mapped, spaced-out letters joined: "Send me your P*I*N", "S e n d your p1n").
 * The shop's own sending ("we'll text you a code", "I will send the PIN page") is not a request: a send verb right after we/I/they
 * (one word may stand between: "we can text you ...") does not count.
 */
const REQUEST_VERB_EN = '(?:(?:send|reply|respond|text|txt|tell|type|give|share|read|provide|forward|confirm|verify)(?:s|ing)?|let\\s+(?:me|us)\\s+know)'
const REQUEST_VERB_ES = [
  'envia', 'envie', 'enviame', 'envieme', 'envianos', 'envienos', 'enviar', 'enviarnos', 'enviarme',
  'manda', 'mande', 'mandame', 'mandeme', 'mandanos', 'mandenos', 'mandar', 'mandarnos', 'mandarme',
  'dime', 'digame', 'dinos', 'diganos', 'decir', 'decirnos', 'decirme',
  'dame', 'deme', 'danos', 'denos', 'dar', 'darnos', 'darme',
  'escribe', 'escriba', 'escribeme', 'escribame', 'escribenos', 'escribanos', 'escribir',
  'responde', 'responda', 'respondeme', 'respondame', 'contesta', 'conteste', 'contestame', 'contesteme',
  'comparte', 'comparta', 'compartenos', 'compartanos', 'compartir', 'pasa', 'pase', 'pasar', 'pasarme', 'pasarnos', 'pasame', 'paseme', 'pasanos', 'pasenos',
  'indica', 'indique', 'indicame', 'indiqueme', 'proporciona', 'proporcione', 'proporcionanos', 'proporcionenos',
  'teclea', 'teclee', 'confirma', 'confirme', 'confirmame', 'confirmeme',
].join('|')
/** "what is your ...", "cual es tu ...", "need your ...": a request without a request verb. */
const REQUEST_ASK = "(?:what(?:'s|s|\\s+(?:is|are|was|were))|cual(?:es)?\\s+(?:es|son)|(?:need|necesito|necesitamos))"
/** The shop as the subject of a send verb: "we'll text you", "I can send", "they just sent" (one word may stand between). */
const SHOP_SUBJECT = "(?<!(?:^|[^\\p{L}])(?:we|i|they)(?:'ll|'d|'re|'ve|ll)?\\s+(?:[\\p{L}']+\\s+)?)"
const DIGIT_COUNT = '(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)'
/** The secrets of an account or a card, English and Spanish (after plainFold: accents stripped, lower case). */
const SECRET_NOUN = [
  'p[il]n(?:s|es|code|codes)?',
  'p[il]n\\s+(?:code|number)s?',
  'nip',
  'pass[\\s-]*(?:code|word|phrase|key)s?',
  'pwd',
  'otps?',
  'one[\\s-]*time\\s+(?:password|passcode|code|pin|number)s?',
  'cvv2?',
  'cvc',
  'personal\\s+identification',
  '(?:security|verification|verify|confirmation|login|log[\\s-]*in|access|auth|authentication|2fa|sms|secret|reply)\\s+(?:codes?|numbers?|keys?)',
  '(?:the|your|ur|that|this|those|these)\\s+codes?',
  'card\\s+(?:number|digits|details|info|information)s?',
  '(?:credit|debit|bank)\\s+card\\s+(?:number|digits|details|info|information)s?',
  `${DIGIT_COUNT}[\\s-]*digits?(?:\\s+(?:code|number|pin)s?)?`,
  'digits?\\s+(?:on|of|from)\\s+(?:the\\s+(?:back|front)\\s+of\\s+)?(?:your|the|ur)\\s+(?:credit\\s+|debit\\s+)?card',
  `last\\s+${DIGIT_COUNT}\\s+(?:digits?\\s+)?(?:of|on|from)\\s+(?:your|the|ur)\\s+(?:credit\\s+|debit\\s+)?card`,
  // Spanish
  'contrasena',
  'claves?',
  'codigos?(?!\\s+(?:postal|promocional|promo|de\\s+(?:descuento|promocion|area|vestimenta)))',
  '(?:numero|datos|digitos)\\s+de\\s+(?:tu|su|la)\\s+tarjeta',
  `${DIGIT_COUNT}\\s+digitos`,
].join('|')
/**
 * A PROTECTIVE reminder is no request (guard polish after W4b-fix, W4a fresh set: "Please don't send card numbers or codes by text."
 * and "Nunca te pediremos tu codigo por mensaje." were blocked): a negation right before the request verb ("don't send", "never
 * share", "do not text", "no envie", "nunca compartas"; "ever" or a Spanish pronoun may stand between) or "we never ask you to"
 * before it. Only right before: "Don't forget to send your PIN", "Don't wait, send your code" and "No, text me the code" still block.
 * The judge reads the rest ("don't send it to anyone but me" is a request in other words).
 */
const PROTECTIVE_NEG = "(?:don'?t|do\\s+not|never|no|nunca|jamas)\\s+(?:ever\\s+|(?:nos|me|te|le|les)\\s+)?"
const PROTECTIVE_ASK = "(?:never|won'?t|will\\s+not|don'?t|do\\s+not|nunca)\\s+(?:ever\\s+)?(?:ask|request)\\s+(?:you\\s+)?(?:to\\s+)?"
const NOT_PROTECTIVE = `(?<!(?:^|[^\\p{L}'])(?:${PROTECTIVE_NEG}|${PROTECTIVE_ASK}))`
/** "... your PIN, please" counts only when no protective negation and verb stand before it in the clause. */
const NO_PROTECTIVE_VERB_BEFORE = `(?<!(?:^|[^\\p{L}'])${PROTECTIVE_NEG}(?:${REQUEST_VERB_EN}|${REQUEST_VERB_ES})(?![\\p{L}\\p{N}])[^.!?;]{0,80})`
const SECRET_REQUEST = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${NOT_PROTECTIVE}(?:${SHOP_SUBJECT}${REQUEST_VERB_EN}|${REQUEST_VERB_ES}|${REQUEST_ASK})(?![\\p{L}\\p{N}])[^.!?;]{1,60}?(?<![\\p{L}\\p{N}])(?:${SECRET_NOUN})|${NO_PROTECTIVE_VERB_BEFORE}(?:${SECRET_NOUN})[\\s,]+(?:please|pls|plz|por\\s+favor))(?![\\p{L}\\p{N}])`,
  'gu',
)

/** The secret requests of a text ("send me your PIN", "dime tu clave"), as found, on the plain text and the skeleton. */
export function secretRequests(text: string): string[] {
  return hits(SECRET_REQUEST, [plainFold(text), skeleton(text)])
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

/**
 * The pattern of the shop's own host where it stands exactly, as text: no subdomain, no path or port, not even after a space; it may be
 * written with "https://" or "http://" and a trailing slash (W4a fresh set: "You can see the full menu at
 * https://oasisautospanj.com." was blocked). "hxxp", "www.", another scheme, a user part, a path or a port still block.
 */
function ownHostPattern(website: string): RegExp | null {
  const own = hostOf(website)
  if (!own) return null
  return new RegExp(
    `(?<![\\p{L}\\p{N}./-])(?:https?:\\/\\/)?${escapeRe(own)}\\/?(?![\\p{L}\\p{N}/-]|\\.[\\p{L}\\p{N}]|[:?#@]\\S|\\s+\\/)`,
    'giu',
  )
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
// ---- action claims (W4b X3) -------------------------------------------------------------------------------------------------------

/** "you're booked", "it is all set", "your visit has been moved", "I've cancelled it", "you're confirmed"; "esta reservado", "te agende". */
const CLAIM_EN = new RegExp(
  [
    // a subject, a form of "be" (or "'s"/"'re"), maybe "all"/"now"/"officially", then the done word
    "\\b(?:you|it|that|this|everything|we|your\\s+(?:visit|appointment|booking|reservation|wash|spot|slot|time|cancell?ation|change)|(?:the\\s+)?(?:visit|appointment|booking|reservation))\\s*(?:'s|'re|\\s+is|\\s+are|\\s+was|\\s+were|\\s+has\\s+been|\\s+have\\s+been|'ve\\s+been|\\s+got|\\s+just\\s+got)\\s+(?:all\\s+|now\\s+|officially\\s+|already\\s+|just\\s+|been\\s+)*(?:booked|confirmed|scheduled|rescheduled|moved|cancell?ed|reserved|locked\\s+in|set\\b|good\\s+to\\s+go)",
    // "I've booked you", "I moved it", "I went ahead and cancelled your visit", "we have you down for"
    "\\b(?:i|we)(?:'ve|\\s+have|\\s+just|\\s+went\\s+ahead\\s+and)?\\s+(?:booked|confirmed|scheduled|rescheduled|moved|cancell?ed|reserved|locked\\s+in|put)\\s+(?:you|it|that|your|the)\\b",
    '\\b(?:we|i)\\s+(?:have|got)\\s+you\\s+(?:down|booked|in)\\b',
    '\\ball\\s+set\\b',
    "\\byou'?re\\s+(?:all\\s+)?(?:good\\s+to\\s+go|in)\\b",
  ].join('|'),
  'i',
)
const CLAIM_ES = new RegExp(
  [
    '\\b(?:esta|estas|estan|queda|quedo|quedaste|quedas|ya\\s+esta|fue|ha\\s+sido|tienes)\\s+(?:todo\\s+|ya\\s+)?(?:reservad[oa]s?|agendad[oa]s?|confirmad[oa]s?|cancelad[oa]s?|programad[oa]s?|movid[oa]s?|cambiad[oa]s?|list[oa]s?)\\b',
    '\\bte\\s+(?:reserve|agende|cancele|movi|confirme|cambie|anote)\\b',
    // "Ya quedaste para el viernes", "tu cita queda para el lunes" (never "queda en": where the shop is)
    '\\b(?:quedaste|quedas|ya\\s+quedo|ya\\s+queda)\\s+(?:para|el|agendad[oa]|reservad[oa])\\b',
    '\\b(?:tu|su)\\s+(?:cita|reserva|lavado|visita)\\s+(?:queda|quedo)\\s+(?:para|el)\\b',
    '\\btodo\\s+listo\\b',
  ].join('|'),
  'i',
)
/**
 * Phrases with a negation word that negate nothing ("No problem, you're all set", "No worries, your first wash is free!"): taken out
 * before a negation decides anything, here (actionClaims) and in the conversation eval's checker (convo-eval.ts refusedPromise).
 */
export const NEGATION_IDIOMS =
  /\b(?:no (?:worries|worry|problem|problemo|prob|probs|rush|stress|biggie|sweat|doubt)|not a problem|never mind|nevermind|no hay (?:problema|prisa|lio)|no te preocupes|no se preocupe|sin problema|don['’]?t worry|no need to worry)\b/gi

/** A sentence that only says what will happen, what is not done yet or asks: no claim ("Nothing is booked until you confirm"). */
const CLAIM_EXCEPT =
  /\b(?:until|once|after|before|when|whenever|if|unless|not|never|nothing|no|yet|cannot|can't|won't|will|would|could|can|should|be|to\s+get|want|like|need|let|hasta|cuando|una\s+vez|antes|todavia|aun|nada|quieres|puedes|para)\b|n't\b|'ll\b|\bsi\s+(?!,)/i

/**
 * The model's notes to itself in a text (full Bedrock run, unseeded: "The client hasn't clarified which service they want. I need to
 * ask one more time gently. Hey Jonathan, ..."; a spot check: "Wait - no emoji, plain text only. Let me redo: ..."): the judge passed
 * both. A text to the client never names "the client" or "the user" in the third person, corrects its own draft or recites a rule.
 */
const META = new RegExp(
  [
    // W4 final check L5: its own instructions, tools, FAQ or intake ("The FAQ doesn't mention a waiting area or wifi, so I can only
    // say ...", seeded 2 x2-amenity-waiting-wifi: it passed the judge) and its own plan ("I should ask their name")
    "\\b(?:the|my)\\s+(?:faqs?|f\\.a\\.q\\.?|intake|instructions?|system\\s+prompt|turn\\s+context|shop\\s+facts|server\\s+record|tool\\s+results?)(?:'s)?\\s+(?:doesn'?t|does\\s+not|don'?t|do\\s+not|says?|said|mentions?|lists?|states?|shows?|has|have|covers?|only|is\\s+silent|isn'?t|returned|gave)\\b",
    '\\b(?:shop\\s+facts|turn\\s+context|server\\s+record|system\\s+prompt|policy\\s+check|intake\\s+step)\\b',
    '\\bmy\\s+(?:tools?|instructions?|notes|rules)\\b',
    '\\baccording\\s+to\\s+(?:the|my)\\s+(?:faqs?|instructions?|intake|tools?|records?|notes|rules)\\b',
    "(?:^|[.!?:;,]\\s*|\\b(?:so|and|but|now)\\s+)i\\s+(?:should|'ll\\s+now|will\\s+now|need\\s+to\\s+(?:ask|mention|present|pitch|follow|stick|answer\\s+with))\\b(?!\\s+be\\s+able)",
    '\\b(?:el|la|las|los|mis)\\s+(?:faq|preguntas\\s+frecuentes|instrucciones|herramientas)\\s+(?:no\\s+)?(?:dice|dicen|menciona|mencionan|incluye|incluyen)\\b',
    '\\b(?:debo|deberia|tengo\\s+que)\\s+(?:preguntar|pedir|mencionar|ofrecer|presentar|responder)\\b',
    "\\b(?:the\\s+(?:client|user)|el\\s+(?:cliente|usuario)|la\\s+(?:clienta|usuaria))(?:'s)?\\s+(?:has|hasn'?t|had|is|isn'?t|was|wasn'?t|wants?|said|asked|did|didn'?t|does|doesn'?t|needs?|seems|may|might|will|would|can|could|no|ya|quiere|dijo|pidio|pregunto|necesita|parece|todavia|aun|aún|tiene|esta|está)\\b",
    '\\blet\\s+me\\s+(?:redo|rewrite|revise|rephrase|try\\s+(?:that\\s+)?again)\\b',
    '\\b(?:plain\\s+text\\s+only|no\\s+emojis?)\\b',
  ].join('|'),
  'i',
)

/** The model's notes to itself in the text (see META). */
export function metaNotes(text: string): string[] {
  return [...text.matchAll(new RegExp(META.source, 'gi'))].map((m) => m[0].trim())
}

/** The model's claims that an action was done ("you're all set", "I've booked you"): questions and conditional sentences excluded. */
export function actionClaims(text: string): string[] {
  const out: string[] = []
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'")
  for (const s of folded.split(/(?<=[.!?])\s+|\n+/)) {
    if (s.trim().endsWith('?')) continue
    const m = CLAIM_EN.exec(s) ?? CLAIM_ES.exec(s)
    if (!m) continue
    // only the words before the claim decide whether it is conditional ("Once you confirm, you're all set" is no claim); an idiom
    // that negates nothing ("No problem, you're all set") is no condition (the eval's check found actionClaims skipped it)
    if (CLAIM_EXCEPT.test(s.slice(0, m.index).replace(NEGATION_IDIOMS, ' '))) continue
    out.push(m[0].trim())
  }
  return out
}

// ---- claims an unverified phone cannot have backed (W4 final check L6) -------------------------------------------------------------

const CLOCK = '(?:\\b\\d{1,2}(?::[0-5]\\d)?\\s*(?:a\\.?\\s?m\\b\\.?|p\\.?\\s?m\\b\\.?)|\\b\\d{1,2}:[0-5]\\d\\b|\\bnoon\\b|\\bmidday\\b|\\bmediodia\\b|\\ba\\s+las\\s+\\d{1,2}\\b)'
const DAYWORD =
  '\\b(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?|today|tonight|tomorrow|weekend|morning|afternoon|evening|lunes|martes|miercoles|jueves|viernes|sabado|domingo|hoy|manana|tarde|noche)\\b'
/**
 * Words that say a time or a day is open: "11 AM is open", "3 PM should work", "Friday morning has openings", "hay espacio", and
 * "9 AM Friday looks good" / "sounds good" (W4 leftover: the judge alone caught it).
 */
const OPEN_WORDS =
  /\b(?:open(?:ings?)?|available|availability|free|works?|work|room|spots?|slots?|(?:looks?|sounds?)\s+(?:good|great|perfect|fine)|disponibles?|libres?|espacio|lugar|cupo)\b/i
/** A sentence that only says what the client can do, gives hours, refuses, asks or is conditional: no claim. */
const AVAIL_EXCEPT =
  /\b(?:if|once|after|when|whenever|unless|until|not|no|never|none|nothing|closed?|closes|pick|choose|select|link|page|calendar|hours|you\s+can|you\s+could|let\s+me|i\s+can|we\s+can|check|whatever|whichever|which|any|si|cuando|una\s+vez|elige|escoge|enlace|horario|cerrad[oa]|n't)\b|\bwe(?:'re|\s+are)?\s+open\b|\bopens?\s+(?:at|from|until|till)\b|\bopen\s+(?:from|until|till)\b|\d\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:to|-|until|till|a)\s*\d/i
/** A sentence about picking on the link, the page or the calendar: "pick 3 PM on the link", "the link lets you pick a Friday afternoon time". */
const PICK_LINK = /\b(?:pick|picking|choose|choosing|select|selecting|link|page|calendar|elige|escoge|selecciona|enlace|calendario)\b/i
/** Opening hours in a sentence ("we're open 8 AM to 6 PM", "open from 8"): no time named for the client. */
const HOURS = /\bwe(?:'re|\s+are)?\s+open\b|\bopens?\s+(?:at|from|until|till)\b|\bopen\s+(?:from|until|till)\b|\bhours\b|\bhorario\b|\d\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:to|-|until|till|a)\s*\d/i
/** The client's own visit named in the sentence ("your wash on Friday at 3 PM", "you have ... at 3 PM"): its time is no claim. */
const OWN_VISIT =
  /\byour\s+(?:[\w-]+\s+){0,3}(?:visit|appointment|wash|detail|booking|tint|service|cita|lavado|reserva)\b|\byou(?:'re|\s+are)\s+(?:booked|scheduled)\b|\byou\s+have\b|\b(?:currently|now)\s+(?:booked|scheduled|set)\b|\btu\s+(?:cita|reserva|lavado)\b|\btienes\b/i
/** A part of the day ("Friday afternoon", "por la tarde"): the guard's own list, beside DAYWORD's days. */
const PART_OF_DAY = /\b(?:morning|afternoon|evening|tonight|manana|tarde|noche)\b/i
const VERIFIED_CLAIM =
  /\b(?:you(?:'re|\s+are|'ve\s+been|\s+have\s+been|\s+were)|your\s+(?:phone|number)\s+(?:is|has\s+been|was))\s+(?:now\s+|all\s+|fully\s+|successfully\s+|already\s+)*verified\b|\bverification\s+(?:is\s+|was\s+)?(?:done|complete|completed|went\s+through|worked)\b|\b(?:ya\s+)?(?:estas|quedaste|fuiste|esta)\s+verificad[oa]\b|\bthanks\s+for\s+verifying\b/i
const VERIFIED_EXCEPT = /\b(?:if|once|after|when|whenever|until|before|as\s+soon\s+as|not|si|cuando|una\s+vez|hasta|despues)\b|n't\b/i

/**
 * W4 final check L6 (X4 still open: "11 AM is open for both!" and "3 PM should work" to unverified phones with no lookup, "Great,
 * you're verified Chloe!" with no verify link): what an unverified phone's reply may not claim. `o.availability` set: a clock time
 * named with an open word (the phone is given no times), and a day or part of a day named so unless `dayChecked`; `o.verified`
 * false: "you're verified". Questions, conditionals, refusals, hours ("we're open 8 to 6") and what the client can pick are skipped,
 * EXCEPT (W4 leftover, wave Q3d: the guard and the judge's rule (g) say the same thing) a sentence about picking on the link that
 * names a clock time, or a part of the day without a check ("pick 3 PM on the link", "the link lets you pick a Friday afternoon
 * time"): the phone was given no times, so naming one there reads as saying it is open; "pick a time on the link" is fine.
 */
export function unverifiedClaims(text: string, o: { availability?: { dayChecked: boolean } | null; verified?: boolean }): string[] {
  const out: string[] = []
  // "11 a. m." (Spanish) is one clock time, not two sentences
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").replace(/\b([ap])\.\s?m\./gi, '$1m')
  for (const s of folded.split(/(?<=[.!?])\s+|\n+/)) {
    if (s.trim().endsWith('?')) continue
    if (o.verified === false) {
      const m = VERIFIED_CLAIM.exec(s)
      if (m && !VERIFIED_EXCEPT.test(s.slice(0, m.index).replace(NEGATION_IDIOMS, ' '))) out.push(m[0].trim())
    }
    if (!o.availability) continue
    const time = new RegExp(CLOCK, 'i').exec(s)
    const pick = PICK_LINK.exec(s)
    if (pick && !HOURS.test(s) && !OWN_VISIT.test(s)) {
      if (time) {
        out.push(`${time[0].trim()} … ${pick[0]}`)
        continue
      }
      const part = PART_OF_DAY.exec(s)
      if (part && !o.availability.dayChecked) {
        out.push(`${part[0]} … ${pick[0]}`)
        continue
      }
    }
    const open = OPEN_WORDS.exec(s)
    if (!open || AVAIL_EXCEPT.test(s.replace(NEGATION_IDIOMS, ' '))) continue
    if (time) {
      out.push(`${time[0].trim()} … ${open[0]}`)
      continue
    }
    const day = new RegExp(DAYWORD, 'i').exec(s)
    if (day && !o.availability.dayChecked) out.push(`${day[0]} … ${open[0]}`)
  }
  return out
}

export function guardReply(i: GuardInput): GuardVerdict {
  const max = i.maxChars ?? MAX_REPLY_CHARS
  const values = i.values ?? new Map<string, string>()
  const text = punctuatePlaceholders(toGsm7(stripMarkdown(foldInput(i.text))), values)
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
  // (2) the secret request check never reads the client's own name or vehicles ("Thanks, Clave", "your Free Spirit"); every other
  // rule reads them (client-entered text is never trusted: a vehicle "Free Wash 2015550123" is still a phone number). A currency
  // sign GSM-7 would drop ("45¢") still counts.
  const worded = withoutPhrases(raw, i.names ?? [])
  const dropped = [...foldInput(i.text).replace(BRACED, '~').matchAll(CURRENCY)].map((m) => m[0])
  flag('money', [...new Set([...dropped, ...moneyWords(raw)])])
  flag('secret', secretRequests(worded))
  flag('url', urlWords(raw, i.website))
  const literals = [...addressLiterals(i.address), ...(i.literals ?? [])]
  flag(
    'digits',
    digitWords(
      withoutOwnHost(withoutLiterals(raw, literals, i.shopNumbers ?? []), i.website),
      i.openWindow ?? DEFAULT_OPEN_WINDOW,
    ),
  )
  if (i.checkActionClaims) flag('action_claim', actionClaims(raw))
  if (i.checkAvailabilityClaims || i.phoneVerified === false)
    flag('unverified_claim', unverifiedClaims(raw, { availability: i.checkAvailabilityClaims ?? null, ...(i.phoneVerified === false ? { verified: false } : {}) }))
  flag('meta', metaNotes(raw))
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
    'Use only these placeholders, exactly: {price:<key>} or {price:<key>:<size key>} with an item key and a size key from SHOP FACTS, {plan:<key>} or {plan:<key>:<size key>} with a plan key from SHOP FACTS memberships, {perks:<key>}, {fee}, {balance} (only after get_balance in this turn), {confirm} (only after a proposal in this turn) and {linkN} exactly as send_link returned it.',
  placement:
    'Write each price placeholder as its own sentence, with nothing attached to it: "{price:<key>}." The server writes the whole sentence, the service name included ("Signature Hand Wash starts at ..."). Never put a name, "plus", "and", "total" or another placeholder right before or after it.',
  money:
    'Never write an amount, a currency sign or a money word (dollars, bucks, cents, USD, pesos). Write the placeholder as its own sentence and the server fills in the amount: "{price:<key>}.", "{plan:<key>}.", "{fee}.", "{balance}." (after get_balance). Never add prices up or give a total.',
  digits: 'Never write a digit code or a phone number, in any form (split by spaces, dashes or dots, as times, in words or with letters for digits): only the shop\'s own numbers in SHOP FACTS.',
  secret:
    'Never ask the client for a PIN, a code, a password or card details, and do not write a security reminder: send the right link with send_link and the server adds the security line itself.',
  url: 'Never write a web address or anything shaped like one (name.com, name dot com, an IP address, http, www): only the shop website exactly as in SHOP FACTS, or a {linkN} placeholder a tool gave you. If it was a missing space after a full stop or a comma, add the space.',
  questions: 'Ask at most one question per text.',
  too_long: `Keep it under ${MAX_REPLY_CHARS - 20} characters.`,
  meta: 'Write only the text the client reads, to them: never a note about "the client", your reasoning, a correction of your own draft or a rule about how to write.',
  unverified_claim:
    'This phone is not verified and the server gave you no open times: never name a time, a day or a part of a day as open, available, working or good (the booking link shows the open times), not even in a sentence about the link ("pick a time on the link", never "pick 3 PM on the link" or "pick a Friday afternoon time"), and never say they are verified (they are not). Point them to the booking link, or to the verify link to book by text.',
  action_claim:
    'Nothing was booked, moved or cancelled by the server: never say it is booked, confirmed, moved, cancelled, reserved, done or "all set". To book or change it, give the booking link (send_link) or, for a verified phone, propose it and write "{confirm}."; a visit the client already has reads "you have <service> on <day> at <time>".',
}
