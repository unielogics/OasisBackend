// One way of collecting at a time (review Q4 money:H1): while a saved-card charge of an invoice waits for Square's answer (`charging`,
// or `unknown`: the job square.charges.resolve sends the same request again), nothing else may collect that invoice's money. Collect
// (cash or card), Send link, a Square link made for the pay page or the staff, and the pay page itself answer 409
// CARD_CHARGE_IN_PROGRESS until the charge is known; otherwise the balance could be paid twice (the card, and the other way).
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import './db/cards-schema.js'
import './problems.js'

/** The saved-card charge of the invoice still waiting for Square, or null. */
export async function chargeWaiting(db: Executor, invoiceId: string): Promise<string | null> {
  const open = await db
    .selectFrom('square_charges')
    .select('id')
    .where('invoice_id', '=', invoiceId)
    .where('state', 'in', ['charging', 'unknown'])
    .executeTakeFirst()
  return open?.id ?? null
}

/** 409 CARD_CHARGE_IN_PROGRESS while a saved-card charge of the invoice waits for Square (`client`: the pay page's words). */
export async function assertNoChargeWaiting(db: Executor, invoiceId: string, o: { client?: boolean } = {}): Promise<void> {
  if (!(await chargeWaiting(db, invoiceId))) return
  throw new AppError(
    'CARD_CHARGE_IN_PROGRESS',
    o.client ? { detail: 'A payment on your saved card is still going through. Check again in a few minutes, or text us.' } : {},
  )
}
