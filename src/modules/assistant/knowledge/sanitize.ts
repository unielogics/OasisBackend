// The owner's text on its way to the model (ADR 0174 §1f and §2 "Detectors"; design §8 "Prompt injection"). Two pure jobs, one
// set of detectors, shared by notes, documents and corrections:
//   knowledgeWarnings  what the editor shows before a save turns an entry on: amounts, links, other phone numbers and e-mail
//                      addresses (hidden from Oasis AI), promise words, instruction-like lines (a document must be confirmed before
//                      it goes live when it has any), markup and hidden characters;
//   maskForKnowledge   one line as the model reads it: flattened (control and format characters out, the judge's ⟦ ⟧ markers out),
//                      card numbers, amounts, links, e-mail addresses and phone numbers other than the shop's replaced by plain
//                      words. Percentages stay (tint shades need them). The result passes the output guard's money and web-address
//                      detectors (moneyWords, urlWords): prices still come only from Settings → Prices through the placeholders.
import { maskCardNumbers } from '../../messaging/inbound/cards.js'
import { PERK_PROMISE } from '../facts.js'
import { moneyWords, urlWords } from '../guard.js'
import { maskPhones } from '../transcript.js'
import type { KnowledgeWarning, KnowledgeWarningKind } from './schema.js'

export const AMOUNT_MASK = '[price in Settings]'
export const LINK_MASK = '[link removed]'
export const NUMBER_MASK = '[number]'

/** The most warnings kept per entry (the editor lists them; the rest are "and more"). */
export const MAX_WARNINGS = 50

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** A URL's characters; it never ends on sentence punctuation ("see www.x.com, then" keeps the comma). */
const URL_TAIL = String.raw`(?:[^\s<>"')\]]*[^\s<>"')\].,;:!?])?`
const URL_SCHEME = new RegExp(String.raw`\b(?:https?|ftp):\/\/` + URL_TAIL, 'gi')
const URL_WWW = new RegExp(String.raw`\bwww\.` + URL_TAIL, 'gi')
/** A bare domain with a common top-level domain ("oasisautospa.com", "bit.ly/x"). */
const URL_BARE = new RegExp(
  String.raw`\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|net|org|io|co|us|info|biz|app|shop|me|ly|gl|ai|site|online|store|xyz|link|page)\b(?:\/` +
    URL_TAIL +
    ')?',
  'gi',
)
/** "$45", "$1,299.99", "45 dollars", "USD 30", "30 USD", "€20", "20 bucks", "50¢", "45 dólares". */
const NUM = String.raw`\d(?:,?\d)*(?:\.\d+)?`
const AMOUNT = new RegExp(
  String.raw`[$€£¥¢]\s?${NUM}|\b${NUM}\s?(?:[$€£¥¢]|dollars?\b|d[oó]lares\b|bucks?\b|usd\b|cents?\b|centavos?\b|pesos?\b)|\b(?:usd|us\$)\s?${NUM}`,
  'gi',
)
/** HTML-like tags. */
const MARKUP = /<\s*\/?\s*[a-z!?][^>]*>/gi
/** The judge's trusted-part markers and its frame tags: never in owner text. */
const MARKERS = /[⟦⟧]/g
/** Hidden or control characters a reader cannot see (tab and line breaks aside): control, format, private use, tags, separators. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\u2028\u2029]/gu
const PLAIN_WS = /[\t\n\r]/g

/**
 * Instruction-like lines (design §2 "Detectors"): owner text is data, so a line that talks to the model (or imitates a section of
 * the prompt or the judge's frame) is flagged and a document holding one must be confirmed before it is turned on.
 */
const INSTRUCTION: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:rules?|instructions?|prompts?|guidelines?|above|previous)\b/i,
  /\byou\s+are\s+(?:now|an?|the)\b/i,
  /\bsystem\s*(?:prompt|message|:)/i,
  /\b(?:assistant|ai|model|bot|chatbot|oasis\s+ai)\s+(?:must|should|will|shall|has\s+to|needs\s+to)\b/i,
  /\bdo\s+not\s+tell\b|\bdon'?t\s+tell\b/i,
  /\breveal\b/i,
  /\brespond\s+with\b|\breply\s+with\b|\banswer\s+with\b/i,
  /\bnew\s+(?:rules?|instructions?)\b/i,
  /^\s*(?:#+\s*)?(?:SHOP\s+FACTS|SHOP\s+KNOWLEDGE|TURN\s+CONTEXT|RULES?|SYSTEM|INSTRUCTIONS?|HOW\s+TO\s+WRITE|WHAT\s+IS\s+DATA)\b\s*[:(]?/i,
  /[⟦⟧]|<\/?\s*(?:message|own-text|server-record|trusted)\b|\[\/?trusted\]/i,
  /\b(?:"ok"\s*:\s*true|category"\s*:\s*"none")/i,
]

const clip = (s: string): string => (s.length > 40 ? `${s.slice(0, 39)}…` : s)
const digitsOf = (s: string): string => s.replace(/\D/g, '')

/** The 10-digit form of the shop's numbers (a number of the shop is not hidden). */
const shopDigits = (numbers: readonly (string | null | undefined)[]): Set<string> =>
  new Set(numbers.filter((n): n is string => !!n).map((n) => digitsOf(n).slice(-10)).filter((d) => d.length === 10))

export interface SanitizeOptions {
  /** The shop's own numbers (SHOP FACTS contact): kept as they are. */
  shopNumbers?: readonly (string | null | undefined)[]
}

/** Hidden or control characters of a text (tab and line breaks are plain), counted. */
export function hiddenCount(text: string): number {
  return (text.replace(PLAIN_WS, '').match(HIDDEN) ?? []).length
}

/** The warnings of an entry's text, in line order (at most MAX_WARNINGS). */
export function knowledgeWarnings(text: string, o: SanitizeOptions = {}): KnowledgeWarning[] {
  const shop = shopDigits(o.shopNumbers ?? [])
  const out: KnowledgeWarning[] = []
  const add = (kind: KnowledgeWarningKind, sample: string, line: number): void => {
    if (out.length >= MAX_WARNINGS) return
    if (out.some((w) => w.kind === kind && w.line === line && w.sample === clip(sample))) return
    out.push({ kind, sample: clip(sample.trim()), line })
  }
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    if (raw.trim() === '') return
    const hidden = hiddenCount(raw)
    if (hidden > 0) add('hidden', `${hidden} hidden character${hidden === 1 ? '' : 's'}`, line)
    for (const m of raw.match(MARKUP) ?? []) add('markup', m, line)
    const flat = raw.replace(HIDDEN, '')
    for (const m of flat.match(EMAIL) ?? []) add('email', m, line)
    const noEmail = flat.replace(EMAIL, ' ')
    // one link once: each pattern reads what the earlier ones left
    let noUrl = noEmail
    for (const re of [URL_SCHEME, URL_WWW, URL_BARE]) {
      for (const m of noUrl.match(re) ?? []) add('link', m, line)
      noUrl = noUrl.replace(re, ' ')
    }
    const amounts = noUrl.match(AMOUNT) ?? []
    for (const m of amounts) add('amount', m, line)
    if (amounts.length === 0) for (const m of moneyWords(noUrl)) add('amount', m, line)
    maskPhones(noUrl.replace(AMOUNT, ' '), (m) => {
      if (!shop.has(digitsOf(m).slice(-10))) add('phone', m, line)
      // a number (the shop's too) is consumed whole, so no later pattern reads a part of it
      return ' '
    })
    const promise = PERK_PROMISE.exec(flat)
    if (promise) add('promise', promise[0], line)
    for (const re of INSTRUCTION) {
      const m = re.exec(flat)
      if (m) {
        add('instruction', flat.trim(), line)
        break
      }
    }
  })
  return out
}

/** True when the warnings hold an instruction-like line (a document then needs confirmInstructions to go live). */
export const hasInstructionWarning = (warnings: readonly KnowledgeWarning[]): boolean => warnings.some((w) => w.kind === 'instruction')

/**
 * One line of owner text as the model reads it: flattened to one line, the judge's markers out, card numbers, e-mail addresses,
 * links, amounts and other phone numbers replaced. Empty when nothing is left.
 */
export function maskForKnowledge(line: string, o: SanitizeOptions = {}): string {
  const shop = shopDigits(o.shopNumbers ?? [])
  let s = line
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(MARKERS, ' ')
    .replace(MARKUP, ' ')
  s = maskCardNumbers(s)
  s = s.replace(EMAIL, LINK_MASK).replace(URL_SCHEME, LINK_MASK).replace(URL_WWW, LINK_MASK).replace(URL_BARE, LINK_MASK)
  s = s.replace(AMOUNT, AMOUNT_MASK)
  // the shop's own numbers are set aside first (a later pattern must not take a part of them), then every other number goes
  const kept: string[] = []
  s = maskPhones(s, (m) => {
    if (!shop.has(digitsOf(m).slice(-10))) return m
    kept.push(m)
    return `§shop${'abcdefghijklmnopqrstuvwxyz'[Math.min(kept.length - 1, 25)]}§`
  })
  s = maskPhones(s, () => NUMBER_MASK)
  s = s.replace(/§shop([a-z])§/g, (_m, c: string) => kept[c.charCodeAt(0) - 97] ?? NUMBER_MASK)
  // the guard's own detectors have the last word: whatever money word or web address they still find goes too
  for (const w of moneyWords(s)) s = s.split(w).join(AMOUNT_MASK)
  if (moneyWords(s).length > 0) s = AMOUNT_MASK
  for (const w of urlWords(s, '')) s = s.split(w).join(LINK_MASK)
  if (urlWords(s, '').length > 0) s = LINK_MASK
  return s.replace(/\s+/g, ' ').trim()
}
