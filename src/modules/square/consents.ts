// The consent a client gives to save a card with Square and let the shop charge it (ADR 0171 D7, plan decision 6). The wording is
// versioned: a version's text never changes once shipped (a new wording is a new version), and each acceptance stores the version,
// the SHA-256 of the exact text shown and the text itself (card_consents). The page shows the box UNCHECKED; the client ticks it.
// Plain and short, for the client: what the card may be charged for, that the shop confirms every charge except the membership's
// monthly payment, and how to remove the card.
import { createHash } from 'node:crypto'
import { AppError } from '../../platform/errors.js'
import './problems.js'

/** What a saved card may be charged for (card_consents.purposes), in the order the text lists them. */
export const CARD_PURPOSES = ['membership_billing', 'no_show_fee', 'late_cancel_fee', 'balance'] as const
export type CardPurpose = (typeof CARD_PURPOSES)[number]

/** How each purpose reads in the consent text. */
export const PURPOSE_WORDS: Readonly<Record<CardPurpose, string>> = {
  membership_billing: 'your membership’s monthly payment',
  no_show_fee: 'a no-show fee',
  late_cancel_fee: 'a late-cancel fee',
  balance: 'a balance you owe',
}

/** Every wording ever shown, by version. `{purposes}` is replaced by the purposes ticked. Never edit a shipped version. */
export const CONSENT_TEXTS: Readonly<Record<string, string>> = {
  v1:
    'Save this card with Square so Oasis Auto Spa can charge it for: {purposes}. ' +
    'Charges are made only after the shop confirms them, except your membership’s monthly payment. ' +
    'You can remove the card any time from your link or by asking us.',
}

/** The wording a new consent is given on. */
export const CURRENT_CONSENT_VERSION = 'v1'

/** The consent box starts unchecked on the page (plan decision 6). */
export const CONSENT_CHECKED_BY_DEFAULT = false

export interface ConsentText {
  version: string
  purposes: CardPurpose[]
  text: string
  /** SHA-256 (hex) of `text`, exactly as shown. */
  sha256: string
}

export function isCardPurpose(v: unknown): v is CardPurpose {
  return typeof v === 'string' && (CARD_PURPOSES as readonly string[]).includes(v)
}

/** The purposes in their fixed order, each once; 422 CARD_CONSENT_INVALID for none or an unknown one. */
export function normalizePurposes(purposes: readonly unknown[]): CardPurpose[] {
  if (purposes.length === 0 || !purposes.every(isCardPurpose))
    throw new AppError('CARD_CONSENT_INVALID', { meta: { purposes: purposes.map(String) } })
  return CARD_PURPOSES.filter((p) => purposes.includes(p))
}

/** "a, b and c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * The exact text of a consent version for these purposes, and its hash. 409 CARD_CONSENT_OUTDATED for a version that is not the
 * current one (the page showed an older wording: it reloads), unless `anyVersion` (reading back an old consent).
 */
export function consentText(version: string, purposes: readonly unknown[], o: { anyVersion?: boolean } = {}): ConsentText {
  const template = Object.prototype.hasOwnProperty.call(CONSENT_TEXTS, version) ? CONSENT_TEXTS[version] : undefined
  if (!template || (!o.anyVersion && version !== CURRENT_CONSENT_VERSION))
    throw new AppError('CARD_CONSENT_OUTDATED', { meta: { version, current: CURRENT_CONSENT_VERSION } })
  const list = normalizePurposes(purposes)
  const text = template.replace('{purposes}', listWords(list.map((p) => PURPOSE_WORDS[p])))
  return { version, purposes: list, text, sha256: sha256Hex(text) }
}
