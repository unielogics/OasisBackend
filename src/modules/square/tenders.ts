// Which Square tenders staff may offer on an invoice (ADR 0171, wave Q3 dashapi): the Collect sheet of the appointment file, the
// board and the invoice detail read the same answer, so a front-desk role without pay.reports sees the right options before its
// first collect. Everything is decided from the switches (PAYMENT_PROCESSOR, SQUARE_WRITES_ENABLED, SQUARE_POS_API_ENABLED) and,
// for a saved card, the client's cards and consents; with the defaults (Squarespace the processor) every Square tender is off.
//   reader     PAYMENT_PROCESSOR=square: a "Square reader" entry waits for the counter matcher (works observe-only too)
//   link       Square the processor and writes on: a Square link (or the personal pay page) can be made for the balance
//   savedCard  Square the processor, writes on, an open (not canceled) invoice, and an active, unexpired card whose live consent
//              covers balances (the newest such card, as POST /invoices/:id/card-charges picks it without a cardId)
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import type { Executor } from '../../platform/db.js'
import { cardLabel } from '../payments/repository.js'
import './db/cards-schema.js'

export interface SavedCardTender {
  cardId: string
  /** "Visa ••4242" */
  label: string
  brand: string | null
  last4: string | null
}

export interface SquareTenders {
  reader: boolean
  link: boolean
  savedCard: SavedCardTender | null
}

export interface InvoiceProcessing {
  /** Who takes new card money, links and refunds (PAYMENT_PROCESSOR). */
  processor: 'squarespace' | 'square'
  /** "Open Square POS" is on (SQUARE_POS_API_ENABLED, with Square the processor). */
  squarePosAppSwitch: boolean
  squareTenders: SquareTenders
}

type Switches = Pick<Env, 'PAYMENT_PROCESSOR' | 'SQUARE_WRITES_ENABLED' | 'SQUARE_POS_API_ENABLED'>

const square = (env: Switches): boolean => env.PAYMENT_PROCESSOR === 'square'
/** A saved card can be charged now (before the client's cards are looked at). */
export const savedCardsUsable = (env: Switches): boolean => square(env) && env.SQUARE_WRITES_ENABLED

/** The processing block of an invoice: `card` is the client's usable card (balanceCardsFor), `canceled` the invoice's state. */
export function processingOf(env: Switches, o: { card?: SavedCardTender | null; canceled?: boolean } = {}): InvoiceProcessing {
  const sq = square(env)
  return {
    processor: env.PAYMENT_PROCESSOR,
    squarePosAppSwitch: env.SQUARE_POS_API_ENABLED,
    squareTenders: {
      reader: sq,
      link: sq && env.SQUARE_WRITES_ENABLED,
      savedCard: savedCardsUsable(env) && !o.canceled ? (o.card ?? null) : null,
    },
  }
}

/** The month a card is good through has ended (the same rule as square/charges.ts cardExpired). */
const expired = (c: { exp_month: number | null; exp_year: number | null }, now: Date): boolean =>
  !!c.exp_month && !!c.exp_year && now.getTime() >= Date.UTC(c.exp_year, c.exp_month, 1)

/**
 * The card a balance would be charged on, per client: the newest active, unexpired card with a live consent covering `balance`.
 * One query for every client of a board; nothing is read while saved cards cannot be charged (the defaults). `now` defaults to the
 * database's app_now().
 */
export async function balanceCardsFor(
  db: Executor,
  env: Switches,
  o: { locationId?: string | null; customerIds: readonly string[]; now?: Date },
): Promise<Map<string, SavedCardTender>> {
  const out = new Map<string, SavedCardTender>()
  const ids = [...new Set(o.customerIds)]
  if (!savedCardsUsable(env) || ids.length === 0) return out
  const rows = await db
    .selectFrom('customer_cards as c')
    .select(['c.id', 'c.customer_id', 'c.brand', 'c.last4', 'c.exp_month', 'c.exp_year'])
    .where('c.customer_id', 'in', ids)
    .$if(!!o.locationId, (q) => q.where('c.location_id', '=', o.locationId!))
    .where('c.state', '=', 'active')
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('card_consents as k')
          .select('k.id')
          .whereRef('k.card_id', '=', 'c.id')
          .where('k.revoked_at', 'is', null)
          .where(sql<boolean>`'balance' = any(k.purposes)`),
      ),
    )
    .orderBy('c.created_at', 'desc')
    .orderBy('c.id', 'desc')
    .execute()
  if (rows.length === 0) return out
  // the database's clock (app_now(): a frozen test clock follows it) when the caller has none
  const now = o.now ?? (await sql<{ now: Date }>`select app_now() as now`.execute(db)).rows[0]!.now
  for (const r of rows) {
    if (out.has(r.customer_id) || expired(r, now)) continue
    out.set(r.customer_id, { cardId: r.id, label: cardLabel(r.brand, r.last4).label, brand: r.brand, last4: r.last4 })
  }
  return out
}
