// square.payments.match (every minute): the counter payments whose SQUARE_MATCH_DELAY_SECONDS has passed are matched (design 2.3:
// the delay lets a POS callback or a subscription event explain a payment first). Each payment in its own transaction under its
// advisory lock, from the mirror row (no Square call, except the payer's Square customer for the identity rule R4, read before the
// transaction). Runs whatever SQUARE_WRITES_ENABLED says: matching writes only Oasis's ledger (observe-only mode matches too).
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { maskText } from '../../platform/logging.js'
import { factsOfRow } from './facts.js'
import type { SquareLogger } from './ingest.js'
import type { Identity } from './matcher.js'
import { decideSquarePayment, lockPayment, type DecideOutcome } from './payments.js'

export interface MatchRunDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  api: SquareApi
  logger: SquareLogger
  locationId: string
}

export interface MatchRunReport {
  considered: number
  outcomes: Partial<Record<DecideOutcome, number>>
  failed: number
}

/** The payer's email and phone as Square knows them (best effort: an unreachable Square leaves the buyer email only). */
async function payerOf(d: MatchRunDeps, customerId: string | null): Promise<Identity | undefined> {
  if (!customerId) return undefined
  try {
    const c = await d.api.customers.retrieve(customerId)
    return { emails: c.email_address ? [c.email_address] : [], phones: c.phone_number ? [c.phone_number] : [] }
  } catch {
    return undefined
  }
}

export async function runSquareMatching(d: MatchRunDeps): Promise<MatchRunReport> {
  const now = d.clock.now()
  const due = await d.db
    .selectFrom('square_payments')
    .select(['square_payment_id', 'square_customer_id'])
    .where('location_id', '=', d.locationId)
    .where('match_state', '=', 'pending')
    .where('status', '=', 'COMPLETED')
    .where('classification', 'in', ['counter', 'pos_intent'])
    .where('match_after', '<=', now)
    .orderBy('square_created_at')
    .limit(100)
    .execute()
  const r: MatchRunReport = { considered: due.length, outcomes: {}, failed: 0 }
  for (const p of due) {
    const payer = await payerOf(d, p.square_customer_id)
    try {
      const out = await transaction(d.db, async (tx) => {
        await lockPayment(tx, p.square_payment_id)
        const row = await tx.selectFrom('square_payments').selectAll().where('square_payment_id', '=', p.square_payment_id).executeTakeFirstOrThrow()
        if (row.match_state !== 'pending') return 'done' as const
        return decideSquarePayment(tx, d, factsOfRow(row), { force: true, ...(payer ? { payer } : {}) })
      })
      r.outcomes[out] = (r.outcomes[out] ?? 0) + 1
    } catch (e) {
      r.failed++
      d.logger.warn({ square: { payment: p.square_payment_id }, err: maskText(String(e)).slice(0, 200) }, 'square payment not matched (next run tries again)')
    }
  }
  return r
}
