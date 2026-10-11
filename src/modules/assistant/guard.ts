// The output guard v3 (ADR 0160, design sections 3, 3b and 3c): every text the model writes passes here before it can reach a client.
// Pure: the turn (turn.ts) decides what to do with the verdict (one rewrite call, one shorten call, a cut, or the fallback).
//
// SENSITIVE CONTENT IS SERVER-RENDERED, NOT WRITTEN BY THE MODEL (orchestrator decision 2026-10-11, after two adversarial review rounds
// showed that word lists cannot cover every phrasing). The model writes placeholders; the guard checks the model's RAW text; only then
// does the server render the placeholders from the current shop facts (facts.ts placeholderValues). Rendering is the only way a $
// amount reaches a client.
//
//   (1) placeholders: {price:<itemKey>}, {price:tint:<vehicle>:<film>}, {plan:<key>}, {fee}, {balance} (only after get_balance this
//       turn) and the turn's {linkN}; anything else in braces is `unknown_placeholder`
//   (2) the NUMBERS RULE (raw text, placeholders and server-owned literals removed): no currency sign, no money word (`money`); no
//       number, in digits or in words, except clock times, dates, durations and counts of 1-10 before a noun (`number`); never a
//       digit group of 4+ digits, even split by spaces, dashes, dots or slashes (`digits`: codes, phone numbers)
//   (3) every word check runs on the plain text AND on a SKELETON: accents stripped (NFKD), lower case, look-alikes mapped inside
//       words (0->o 1->i 3->e 4->a 5->s 7->t @->a $->s), i/l treated alike, zero-width characters gone, spaced-out letters joined
//       ("f r e e", "P - I - N"), "[.]" / "(.)" / " . " / " dot " / "name,com" folded to a dot for the host check
//   (4) secrets: no PIN, code, password, passphrase, OTP, one-time, digits, login, card numbers, CVV, expiry... at all (`secret`); the
//       server appends SAFETY_LINE itself after a verify / pin / membership / pay link, and the model writing it is a mention too
//   (5) promise words (`promise_words`): free (only "feel free" and "<word>-free" compounds pass), costs nothing, on me / on us,
//       percent off, sale, rebate, refund, discount, coupon, promo, deal, comp, waive, cover the cost, promise, guarantee, warranty,
//       time promises (ready / done / finished by, at, in, around ...), legal, insurance and damage words
//   (6) hosts (`url`): anything shaped like label.label, an IP, "http", "hxxp", "www", "://"; only the {linkN} placeholders and the
//       shop's own host exactly as text (no path) pass
// Kept: markdown stripped, GSM-7, at most MAX_REPLY_CHARS after rendering, at most one question. Every problem gets one rewrite
// call with a precise hint; a reply that still has a hard problem after it becomes the fallback and a handoff.
import { isGsm7Char, normalizeForSms } from '../../integrations/sms/gsm.js'

/** The longest reply (characters, after rendering; {linkN} counted as written). */
export const MAX_REPLY_CHARS = 320

/** The safety line the server appends to a reply that carries a verify, PIN, membership or payment link (A). The model never writes it. */
export const SAFETY_LINE = 'For your security, enter codes and your PIN only on the secure page, never by text.'
/** The link kinds whose reply gets SAFETY_LINE. */
export const SAFETY_LINK_KINDS: ReadonlySet<string> = new Set(['verify', 'pin', 'membership', 'pay'])

export type GuardProblem =
  | 'empty'
  | 'unknown_placeholder'
  | 'money'
  | 'number'
  | 'digits'
  | 'secret'
  | 'promise_words'
  | 'url'
  | 'questions'
  | 'too_long'

/** Problems only a rewrite can fix; a reply that still has one after the rewrite becomes the fallback. */
export const HARD_PROBLEMS: ReadonlySet<GuardProblem> = new Set(['empty', 'unknown_placeholder', 'money', 'number', 'digits', 'secret', 'promise_words', 'url'])

export type GuardVerdict =
  | { kind: 'ok'; text: string; rendered: string }
  | { kind: 'fix'; text: string; rendered: string; problems: GuardProblem[]; words: string[] }

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
   * Server-owned phrases that may carry digits (facts.ts factLiterals: the address, catalog and plan names; the client's own vehicles
   * on file, "2021 Tesla Model 3"): the numbers rule skips them where they stand exactly.
   */
  literals?: readonly (string | null | undefined)[]
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

/** Compatibility forms folded (NFKC: full-width "ＰＩＮ" -> "PIN") and look-alike full stops ("。", "．") made a dot, before GSM-7. */
export function foldInput(text: string): string {
  return text.normalize('NFKC').replace(/[\u3002\uff61\uff0e\u2024\u2027]/g, '.')
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

/** The text with every known placeholder replaced by what the server writes for it ({linkN} stay: composeReply links them). */
export function renderPlaceholders(text: string, values: ReadonlyMap<string, string>): string {
  return text.replace(BRACED, (p) => values.get(p) ?? p)
}

// ---- (3) the skeleton -----------------------------------------------------------------------------------------------------------

/** Look-alike characters inside a word (a run that holds at least one letter). */
const LOOKALIKE: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i' }
/** Zero-width and format characters, the soft hyphen. */
const INVISIBLE = /[\p{Cf}­]/gu
/**
 * Three or more single characters in a row, separated by spaces, dots, dashes or underscores ("f r e e", "P - I - N", "c.o.d.e",
 * "P - 1 - N"): joined before the look-alikes are mapped.
 */
const SPACED_LETTERS = /(?<![\p{L}\p{N}@$!|])[\p{L}\p{N}@$!|](?:[\s._-]+[\p{L}\p{N}@$!|](?![\p{L}\p{N}@$!|])){2,}/gu

/** Accents stripped (NFKD), invisible characters out, lower case. */
export function plainFold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').replace(INVISIBLE, '').toLowerCase()
}

/** Look-alikes mapped inside words ("p1n" -> "pin", "fr33" -> "free", "u$d" -> "usd"); digit-only runs stay digits. */
function mapLookalikes(text: string): string {
  return text.replace(/[\p{L}\p{N}@$!|]+/gu, (w) => (/\p{L}/u.test(w) ? w.replace(/[013457@$!|]/g, (c) => LOOKALIKE[c] ?? c) : w))
}

/** The skeleton the word checks read (3): folded, look-alikes mapped, spaced-out letters joined into words. */
export function skeleton(text: string): string {
  return mapLookalikes(plainFold(text).replace(SPACED_LETTERS, (m) => m.replace(/[\s._-]+/g, '')))
}

/** The skeleton the host check reads: spaced-out letters joined (a dot among them kept), "[.]", "(.)", " . ", " dot ", "a,b" folded. */
export function hostSkeleton(text: string): string {
  return mapLookalikes(plainFold(text).replace(SPACED_LETTERS, (m) => m.replace(/[\s._-]+/g, (sep) => (sep.includes('.') ? '.' : ''))))
    .replace(/\s*(?:\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}|<\s*(?:\.|dot)\s*>)\s*/g, '.')
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

// ---- (4) secrets ----------------------------------------------------------------------------------------------------------------

const SECRET_WORDS = wordList([
  'pin~s?',
  'pincode~s?',
  'pin code~s?',
  'pin number~s?',
  'passcode~s?',
  'password~s?',
  'passwd',
  'passphrase~s?',
  'code~s?',
  'otp~s?',
  'one time',
  'onetime',
  'digit~s?',
  'personal identification',
  'identification number~s?',
  'secret number~s?',
  'secret code~s?',
  'secret word~s?',
  'verification number~s?',
  'security number~s?',
  'account number~s?',
  'routing number~s?',
  'login~s?',
  'log in details',
  'card number~s?',
  'card digits',
  'card details',
  'card info~(?:rmation)?',
  'cvv~2?',
  'cvc',
  'expiry',
  'expiration',
  'ssn',
  'social security',
])
/** Numbers asked for about a card, or "the number we sent". */
const SECRET_CONTEXT =
  /\bnumbers?\b[^.!?]{0,40}\b(?:cards?|visa|mastercard|amex|discover|debit|credit)\b|\b(?:cards?|visa|mastercard|amex|discover|debit|credit)\b[^.!?]{0,40}\bnumbers?\b|\bnumbers?\b\s+(?:we|i|you)\s+(?:just\s+)?(?:sent|texted|gave|got)\b|\bnumbers?\b\s+(?:from|in)\s+(?:the|our|my|your|that)\s+(?:text|message|sms)\b/g

/** What the text says about PINs, codes, passwords or cards (A): the words as found, on the plain text and the skeleton. */
export function secretWords(text: string): string[] {
  const texts = [plainFold(text), skeleton(text)]
  return [...new Set([...hits(SECRET_WORDS, texts), ...hits(SECRET_CONTEXT, texts)])]
}

// ---- (5) promise words ----------------------------------------------------------------------------------------------------------

const PROMISE_WORDS = wordList([
  'free',
  'freebie~s?',
  'gratis',
  'costs nothing',
  'cost nothing',
  'cost you nothing',
  'no charge',
  'no extra charge',
  'no cost',
  'no extra cost',
  'at no cost',
  'on me',
  'on us',
  'on the house',
  'per cent',
  'percent',
  'half off',
  'half price',
  'on sale',
  'sale~s?',
  'zero dollars',
  'rebate~s?',
  'refund~\\w*',
  'money back',
  'store credit',
  'credit your account',
  'account credit',
  'discount~\\w*',
  'coupon~s?',
  'promo~\\w*',
  'deal~s?',
  'comp~(?:s|ed|ing)?',
  'complimentary',
  'compensat~\\w*',
  'reimburs~\\w*',
  'waive~\\w*',
  'waiver~s?',
  'cover the cost~s?',
  'cover the costs',
  'covered by us',
  'promise~\\w*',
  'guarantee~\\w*',
  'guarant~(?:y|ies)',
  'warrant~(?:y|ies)',
  'bogo',
  'buy one get one',
  'lawyer~s?',
  'attorney~s?',
  'lawsuit~s?',
  'sue~[sd]?',
  'suing',
  'legal~(?:ly)?',
  'liab~(?:le|ility)',
  'insurance',
  'insured',
  'damage~[sd]?',
])
/** Time promises: "ready by 3", "finished in an hour", "done around noon", "have it back to you by 3 PM". */
const TIME_PROMISE =
  /\b(?:ready|done|finished|complete[d]?)\s+(?:by|at|in|around|before|within|after|until|no later)\b|\b(?:have|get|bring|give)\s+(?:it|them|your\s+\w+)\s+back\b|\bback\s+to\s+you\s+(?:by|at|in|around|before|within)\b|%\s*off\b|\boff\s+(?:your|the|any|each|every)\s+(?:next\s+)?(?:wash|visit|tint|detail|service|price|bill)\b|\bsave\s+(?:\$|\d|money|big)/g
/** The only phrases with "free" that pass: "feel free", "<word>-free" ("spot-free"), except money ones ("cost-free"). */
const FREE_OK = /\bfee[il][\s-]*free\b|\b(?!(?:cost|charge|fee|price|payment|tax|interest|risk)-)[\p{L}]{2,}-free\b/gu

/** The promise words of a text, as found (lower case), on the plain text and the skeleton. */
export function promiseWords(text: string): string[] {
  const texts = [plainFold(text), skeleton(text)]
  return [...new Set([...hits(PROMISE_WORDS, texts, FREE_OK), ...hits(TIME_PROMISE, texts)])]
}

// ---- (6) web addresses ----------------------------------------------------------------------------------------------------------

const SCHEME = /\bh(?:tt|xx|t|x)ps?\b|:\/\/|\bwww\d*\b/g
/** label.label: any labels of letters or digits, a last label of 2+ characters with a letter in it, any TLD. */
const HOSTISH = /(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?=[\p{N}-]*\p{L})[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}](?![\p{L}\p{N}-])/gu
const IPV4 = /(?<![\d.])\d{1,3}(?:\s*\.\s*\d{1,3}){3}(?![\d])/g

const hostOf = (url: string): string =>
  url
    .replace(/^https?:\/\//i, '')
    .replace(/[/:?#].*$/, '')
    .replace(/^www\./i, '')
    .toLowerCase()

/** The text without the shop's own host where it stands exactly, as text (no subdomain, no path, no port). */
function withoutOwnHost(text: string, website: string): string {
  const own = hostOf(website)
  if (!own) return text
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}.-])${escapeRe(own)}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}]|[/:?#]\\S)`, 'giu'), '~')
}

/** The web addresses of a text (D), on the plain text and the host skeleton; the shop's own host as text passes. */
export function urlWords(text: string, website: string): string[] {
  const rest = withoutOwnHost(text, website)
  const texts = [plainFold(rest), hostSkeleton(rest)]
  return [...new Set([...hits(SCHEME, texts), ...hits(HOSTISH, texts), ...hits(IPV4, texts)])]
}

// ---- (2) the numbers rule -------------------------------------------------------------------------------------------------------

const CURRENCY = /[$¢€£¥¤]/g
const MONEY_WORDS = wordList(['dollar~s?', 'buck~s?', 'cent~s?', 'usd', 'quid'])
const NUMBER_WORDS_BIG = wordList([
  'zero',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fourty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred~s?',
  'thousand~s?',
  'million~s?',
  'dozen~s?',
  'twenties',
  'thirties',
  'forties',
  'fifties',
])
const SMALL_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'] as const
const DIGIT_SPELLING = '(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine|ten)'
/** Two or more spelled digits in a row ("five five five, oh one two three", "one two three"). */
const SPELLED_RUN = new RegExp(`(?<![\\p{L}])${DIGIT_SPELLING}(?:[\\s,.-]+${DIGIT_SPELLING}){1,}(?![\\p{L}])`, 'gu')
const SMALL_WORD = new RegExp(`(?<![\\p{L}\\p{N}-])(${SMALL_WORDS.join('|')})(?![\\p{L}\\p{N}])`, 'gu')

/** Words a count may not stand before: function words, money, codes, other numbers. */
const NOT_A_NOUN = new Set(
  (
    'a an the and or but nor so to of for at by in on off from with without into onto x times plus minus per each every is are was were be been ' +
    'it its this that these those you your we our i me my us they them their he she his her what which who when where how than then more less ' +
    'total totals left over only just about around after before until till dollar dollars buck bucks cent cents usd percent quid digit ' +
    'digits number numbers code codes pin pins am pm a.m p.m o clock oclock if as also too please now here there will would can could should ' +
    'may might must do does did have has had not no yes ok okay sure thanks thank'
  ).split(' '),
)
const HOURS_CUE =
  /\b(?:open|opens|opening|openings|close|closes|closed|closing|hours?|slots?|times?|appointments?|visits?|drop[\s-]?off|pick[\s-]?up|pickup|arrive|arrival|come|see you|book|booked|booking|morning|afternoon|evening|tonight|today|tomorrow|weekend|weekdays?|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon)\b/i
const MONEY_CUE = /\b(?:prices?|priced|costs?|pay|pays|paid|paying|charges?|charged|fees?|rates?|totals?|starts?\s+at|starting\s+at|dollars?|bucks?)\b|[$¢€£]/i
const MONTHS = '(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)'
const DAY = '(?:3[01]|[12]\\d|0?[1-9])'

/** Numbers a reply may write, in the order they are taken out (each replaced by a marker without digits). */
const ALLOWED_NUMBERS: readonly RegExp[] = [
  // clock times: 10:30, 9:00 AM, 18:00
  /(?<![\d:.,$])(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?(?:a\.?m\.?|p\.?m\.?)(?![\p{L}]))?(?![\d:])/giu,
  // 10am, 10 AM, 3 p.m.
  /(?<![\d:.,$])(?:1[0-2]|0?[1-9])\s?(?:a\.?m\.?|p\.?m\.?)(?![\p{L}])/giu,
  // dates: Oct 12, October 12th, 12 Oct, the 12th, 10/12
  new RegExp(`\\b${MONTHS}\\.?\\s+${DAY}(?:st|nd|rd|th)?(?![\\d])`, 'giu'),
  new RegExp(`(?<![\\d$.,])${DAY}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTHS}\\b`, 'giu'),
  new RegExp(`(?<![\\d$.,])${DAY}(?:st|nd|rd|th)(?![\\p{L}\\d])`, 'giu'),
  /(?<![\d/.\-$,])(?:1[0-2]|0?[1-9])\/(?:3[01]|[12]\d|0?[1-9])(?![\d]|[/.-]\d)/g,
  // durations: 45 minutes, 2 hours, a 30-minute wash
  /(?<![\d$.,])\d{1,3}\s?-?\s?(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?)\b/giu,
]

/** True when the word after a count is a noun it may count ("2 add-ons", "3 openings"). */
function countsANoun(after: string): boolean {
  const m = /^\s+([\p{L}][\p{L}'-]*)/u.exec(after)
  if (!m) return false
  const w = m[1]!.toLowerCase().replace(/[-']+$/, '')
  return w.length >= 2 && !NOT_A_NOUN.has(w) && !SMALL_WORDS.includes(w as never)
}

/** The numbers rule (2) over a text whose placeholders and literals are already out: the problems and the offending pieces. */
export function numberProblems(text: string): { problems: GuardProblem[]; words: string[] } {
  const problems = new Set<GuardProblem>()
  const words: string[] = []
  const add = (p: GuardProblem, w: string): void => {
    problems.add(p)
    words.push(w.trim())
  }
  const plain = plainFold(text)
  const skel = skeleton(text)
  // money: a currency sign anywhere, a money word on the plain text or the skeleton
  for (const m of text.matchAll(CURRENCY)) add('money', m[0])
  for (const w of hits(MONEY_WORDS, [plain, skel])) add('money', w)
  // numbers in words: anything past ten, a run of spelled digits, one to ten not counting a noun
  for (const w of hits(NUMBER_WORDS_BIG, [plain, skel])) add('number', w)
  for (const w of hits(SPELLED_RUN, [plain, skel])) add('number', w)
  for (const t of [plain, skel])
    for (const m of t.matchAll(SMALL_WORD)) {
      const after = t.slice(m.index + m[0].length)
      const before = t.slice(Math.max(0, m.index - 24), m.index)
      if (countsANoun(after)) continue
      if (m[1] === 'one' && /\b(?:the|this|that|which|any|each|every|no|another|other|a|just|only|right|new|old|first|last|next|nearest)\s+$/.test(before)) continue
      if (m[1] === 'one' && /^\s+(?:of|more)\b/.test(after)) continue
      add('number', m[0])
    }
  // digits: the allowed forms out, then any group of 4+ digits (split or not) is a code or a phone number, any other digit a number
  let rest = text
  for (const re of ALLOWED_NUMBERS) rest = rest.replace(re, (m) => m.replace(/\d/g, '#'))
  for (const g of rest.matchAll(/\d+(?:(?:\s*[-./–]\s*|\s+)\d+)*/g)) {
    const digits = g[0].replace(/\D/g, '')
    if (digits.length >= 4) {
      add('digits', g[0])
      continue
    }
    for (const d of g[0].matchAll(/\d+/g)) {
      const at = g.index + d.index
      const n = Number(d[0])
      const before = rest.slice(Math.max(0, at - 40), at)
      const after = rest.slice(at + d[0].length)
      const sentence = rest.slice(rest.lastIndexOf('.', at) + 1, at + d[0].length + (/[.!?]/.exec(after)?.index ?? after.length))
      // a bare hour ("at 10", "and 11") in a sentence about hours and not about money
      const bareHour =
        n >= 1 && n <= 12 && /(?:\b(?:at|until|till|til|before|after|around|from|to|between|and|or|by)|[,–-])\s*$/i.test(before) && HOURS_CUE.test(sentence) && !MONEY_CUE.test(sentence)
      // a count of 1 to 10 before a noun ("2 add-ons", "3 openings"), not glued to a letter ("P1N", "A2B")
      const count = n >= 1 && n <= 10 && !/[\p{L}]$/u.test(before) && !/^[\p{L}]/u.test(after) && countsANoun(after)
      if (bareHour || count) continue
      add('number', d[0])
    }
  }
  return { problems: [...problems], words: [...new Set(words)] }
}

/** The text without the server-owned literals and the shop's own phone numbers (any spacing of their digits). */
function withoutLiterals(text: string, literals: readonly (string | null | undefined)[], shopNumbers: readonly (string | null | undefined)[]): string {
  let out = text
  const phrases = [...new Set(literals.map((x) => x?.trim() ?? '').filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)
  for (const p of phrases) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), '~')
  for (const n of shopNumbers) {
    const d = (n ?? '').replace(/\D/g, '')
    if (d.length < 10) continue
    const ten = d.slice(-10)
    const flexible = ten.split('').join('[\\s().\\/-]{0,2}')
    out = out.replace(new RegExp(`(?<![\\d+])(?:\\+?1[\\s().\\/-]{0,2})?\\(?${flexible}(?!\\d)`, 'g'), '~')
  }
  return out
}

// ---- the verdict ----------------------------------------------------------------------------------------------------------------

/** Cleans a draft, checks every rule on the model's raw text and, when it passes, renders the placeholders. */
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
  // (1) placeholders: only the known ones; each is taken out before any other check
  const unknown: string[] = []
  // a placeholder becomes "~" (no letter, digit or space: it can neither join nor split a word, a number or a host)
  const raw = text.replace(BRACED, (p) => {
    if (!values.has(p)) unknown.push(p)
    return '~'
  })
  if (LONE_BRACE.test(raw)) unknown.push(raw.match(LONE_BRACE)![0])
  flag('unknown_placeholder', unknown)
  // (4) secrets, (5) promise words, (6) hosts: plain text and skeleton
  flag('secret', secretWords(raw))
  flag('promise_words', promiseWords(raw))
  flag('url', urlWords(raw, i.website))
  // (2) numbers: the shop's own numbers, the server-owned literals and the shop's host out first
  const n = numberProblems(withoutOwnHost(withoutLiterals(raw, i.literals ?? [], i.shopNumbers ?? []), i.website))
  for (const p of n.problems) problems.push(p)
  words.push(...n.words)
  // the form: one question, the length after rendering
  const rendered = toGsm7(renderPlaceholders(text, values))
  if ((rendered.match(/\?/g) ?? []).length > 1) problems.push('questions')
  if (rendered.length > max) problems.push('too_long')
  const unique = [...new Set(problems)]
  return unique.length === 0 ? { kind: 'ok', text, rendered } : { kind: 'fix', text, rendered, problems: unique, words: [...new Set(words)] }
}

/** What the rewrite call is told, per problem (plain words for the model). */
export const PROBLEM_HINTS: Record<GuardProblem, string> = {
  empty: 'The reply was empty: write the text for the client.',
  unknown_placeholder:
    'Use only these placeholders, exactly: {price:<key>} or {price:tint:<vehicle>:<film>} with a key from SHOP FACTS, {plan:<key>}, {fee}, {balance} (only after get_balance in this turn) and {linkN} exactly as send_link returned it.',
  money:
    'Never write an amount, a currency sign or a money word (dollars, bucks, cents, USD). Write the placeholder and the server fills in the amount: "<service> {price:<key>}", "<plan> {plan:<key>}", "There is {fee}.", "Your open balance is {balance}." (after get_balance). Never add prices up or give a total.',
  number:
    'Write no numbers (in digits or in words) except clock times (10, 10:30, 10 AM, noon), dates (Oct 12, 10/12, the 12th), durations (45 minutes) and a count of 1 to 10 right before a noun ("2 add-ons"). For prices use the placeholders.',
  digits: 'Never write a digit code, a phone number or any number of 4 or more digits, even split by spaces, dashes, dots or slashes (only the shop\'s own numbers in SHOP FACTS).',
  secret:
    'Write nothing about PINs, codes, passwords, digits, logins or card numbers, never ask for them and do not write a security reminder: the server adds the security line itself.',
  promise_words:
    'Rephrase without promising anything free, sales, discounts, refunds, guarantees, promises or times, and without legal, insurance or damage words (say "open times" or "openings" for availability). If the client asked for one of these, say a team member will text them back.',
  url: 'Never write a web address or anything shaped like one (name.com, name dot com, an IP address, http, www): only the shop website exactly as in SHOP FACTS, or a {linkN} placeholder a tool gave you. If it was a missing space after a full stop or a comma, add the space.',
  questions: 'Ask at most one question per text.',
  too_long: `Keep it under ${MAX_REPLY_CHARS - 20} characters.`,
}
