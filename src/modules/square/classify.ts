// What a Square payment is (ADR 0171, design 2.3): the first rule that applies wins.
//   1 another location                                     -> ignored
//   2 already in the ledger (its key or processor_ref)     -> done
//   3 its order is one of our payment links                -> link
//   4 one of our card-on-file charges (wave Q3a)           -> charge
//   5 a membership's subscription invoice (wave Q3b)       -> membership
//   6 a POS intent (callback order, or the code in the note) -> pos_intent
//   7 anything else                                        -> counter (waits SQUARE_MATCH_DELAY_SECONDS, then the matcher)
// A payment that is not COMPLETED is not classified yet: APPROVED or PENDING waits for its next update, FAILED or CANCELED is ignored.
// Pure: the caller loads the context (classifyContext in payments.ts).
import type { SquarePaymentFacts } from './facts.js'

/** The short code of a POS intent in a payment's note ("INV-20640 · OAS-PI-7KQ2"). */
export const POS_CODE = /\bOAS-PI-[A-Z0-9]{4,8}\b/
/** An invoice number in a note or reference id: INV-20640, INV20640, inv-20640. */
export const INVOICE_NO = /\bINV-?(\d{5,9})\b/i

export interface LinkRef {
  id: string
  invoiceId: string
  purpose: 'balance' | 'deposit'
  expectedCents: number
  state: string
}

export interface PosIntentRef {
  id: string
  invoiceId: string
  ledgerEventId: string | null
  amountCents: number
}

export interface ClassifyContext {
  /** SQUARE_LOCATION_ID (or the simulator's). */
  squareLocationId: string | undefined
  /** A ledger event already carries this payment (its idempotency key or its processor_ref). */
  inLedger: boolean
  /** The payment link whose Square order this payment paid. */
  link: LinkRef | null
  /** One of our card-on-file charges (wave Q3a): by its payment id, or its reference_id (the charge's id). */
  charge: boolean
  /** That charge's id (square_charges). */
  chargeId?: string | null
  /** A membership's subscription invoice (wave Q3b; always false before it). */
  membership: boolean
  /** The POS intent this payment answers (by the callback's order id or the code in its note). */
  posIntent: PosIntentRef | null
}

export type Classification =
  | { kind: 'waiting'; reason: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'done' }
  | { kind: 'link'; link: LinkRef }
  | { kind: 'charge' }
  | { kind: 'membership' }
  | { kind: 'pos_intent'; intent: PosIntentRef }
  | { kind: 'counter' }

export function classifySquarePayment(p: SquarePaymentFacts, ctx: ClassifyContext): Classification {
  if (p.status === 'FAILED' || p.status === 'CANCELED') return { kind: 'ignored', reason: `payment ${p.status.toLowerCase()}` }
  if (p.status !== 'COMPLETED') return { kind: 'waiting', reason: `payment ${p.status.toLowerCase()}` }
  if (p.squareLocationId && ctx.squareLocationId && p.squareLocationId !== ctx.squareLocationId)
    return { kind: 'ignored', reason: 'another location' }
  if (ctx.inLedger) return { kind: 'done' }
  if (ctx.link) return { kind: 'link', link: ctx.link }
  if (ctx.charge) return { kind: 'charge' }
  if (ctx.membership) return { kind: 'membership' }
  if (ctx.posIntent) return { kind: 'pos_intent', intent: ctx.posIntent }
  return { kind: 'counter' }
}

/** The invoice number a note or reference id names, if any (R1). */
export function invoiceNoIn(...texts: Array<string | null | undefined>): number | null {
  for (const t of texts) {
    const m = t ? INVOICE_NO.exec(t) : null
    if (m) return Number(m[1])
  }
  return null
}

/** The POS intent code in a note, if any (R2). */
export function posCodeIn(note: string | null | undefined): string | null {
  const m = note ? POS_CODE.exec(note) : null
  return m ? m[0] : null
}
