// Deterministic Square idempotency keys (ADR 0171): the same business action always sends the same key, so a retry after a timeout
// or a crash can never create a second payment, refund, card or subscription. A key is "<prefix>_<32 hex>" (35 characters): the
// uuid of our own row without its dashes, or the first 32 hex of the SHA-256 of any other stable name. Square caps keys at 45
// characters for CreatePayment, CreateCard and RefundPayment (192 elsewhere); every key is checked against 45.
import { createHash } from 'node:crypto'

export const SQUARE_KEY_MAX = 45

/** pl payment link, ch card charge, rf refund leg, cu customer, cd card, sb subscription, ct catalog, wh webhook subscription, vf verify run. */
export const SQUARE_KEY_PREFIXES = ['pl', 'ch', 'rf', 'cu', 'cd', 'sb', 'ct', 'wh', 'vf', 'py'] as const
export type SquareKeyPrefix = (typeof SQUARE_KEY_PREFIXES)[number]

declare const brand: unique symbol
/** An idempotency key built by sqKey; the create calls accept nothing else, so a create cannot go out without one. */
export type SquareKey = string & { readonly [brand]: 'SquareKey' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sqKey(prefix: SquareKeyPrefix, id: string): SquareKey {
  if (!SQUARE_KEY_PREFIXES.includes(prefix)) throw new RangeError(`unknown Square key prefix ${String(prefix)}`)
  if (!id) throw new RangeError('a Square key needs a stable id')
  const hex = UUID.test(id) ? id.replace(/-/g, '').toLowerCase() : createHash('sha256').update(id).digest('hex').slice(0, 32)
  return assertSquareKey(`${prefix}_${hex}`)
}

/** Checks a key's length (45) and alphabet; returns it branded. */
export function assertSquareKey(key: string, max = SQUARE_KEY_MAX): SquareKey {
  if (key.length < 1 || key.length > max) throw new RangeError(`Square idempotency key must be 1 to ${max} characters, got ${key.length}`)
  if (!/^[A-Za-z0-9_:.-]+$/.test(key)) throw new RangeError('Square idempotency key may hold letters, digits, _ : . - only')
  return key as SquareKey
}
