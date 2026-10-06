// Store credit (review B1). A lot is one credit_issue event or one done refund with dest 'credit'. Issued credit expires
// at expires_at (clock starts at issue); refund-to-credit lots never expire. Applying credit consumes lots FIFO by earliest
// expiry (no-expiry last), skipping lots already expired at that instant, and the consumption is stored in
// credit_allocations at apply time. Balance = remaining of the lots not expired now, so a lot's unused remainder simply
// drops out when it expires and nothing that was spent is ever re-assigned.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'

export interface CreditLot {
  id: string
  invoiceId: string
  kind: 'issue' | 'refund'
  cents: number
  /** null = never expires. */
  expiresAt: Date | null
  /** When the credit became usable: issue time, or the approval time of a refund to credit. */
  effectiveAt: Date
  allocated: number
  reason: string | null
}

export const lotRemaining = (l: CreditLot): number => l.cents - l.allocated

export const isExpired = (l: Pick<CreditLot, 'expiresAt'>, at: Date): boolean =>
  l.expiresAt !== null && l.expiresAt.getTime() <= at.getTime()

/** Lots that can pay something at `at`: effective, not expired, with a remainder. */
export function usableLots(lots: readonly CreditLot[], at: Date): CreditLot[] {
  return lots.filter(
    (l) => l.effectiveAt.getTime() <= at.getTime() && !isExpired(l, at) && lotRemaining(l) > 0,
  )
}

export function creditBalance(lots: readonly CreditLot[], at: Date): number {
  return usableLots(lots, at).reduce((a, l) => a + lotRemaining(l), 0)
}

const FAR = Number.MAX_SAFE_INTEGER

/** FIFO by earliest expiry (no expiry last), then earliest effective time, then id. */
export function fifoOrder(lots: readonly CreditLot[]): CreditLot[] {
  return [...lots].sort(
    (a, b) =>
      (a.expiresAt?.getTime() ?? FAR) - (b.expiresAt?.getTime() ?? FAR) ||
      a.effectiveAt.getTime() - b.effectiveAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

export interface Allocation {
  lotId: string
  cents: number
}

/** Splits `cents` over the usable lots; throws RangeError when the usable balance is smaller. */
export function allocateFifo(lots: readonly CreditLot[], at: Date, cents: number): Allocation[] {
  const out: Allocation[] = []
  let left = cents
  for (const lot of fifoOrder(usableLots(lots, at))) {
    if (left <= 0) break
    const take = Math.min(left, lotRemaining(lot))
    out.push({ lotId: lot.id, cents: take })
    left -= take
  }
  if (left > 0) throw new RangeError(`Not enough store credit: short by ${left} cents`)
  return out
}

interface LotRow {
  id: string
  invoice_id: string
  type: 'credit_issue' | 'refund'
  cents: number
  expires_at: Date | null
  effective_at: Date
  allocated: number
  reason: string | null
}

export async function loadCreditLots(db: Executor, customerId: string): Promise<CreditLot[]> {
  const r = await sql<LotRow>`
    select e.id, e.invoice_id, e.type, e.amount_cents as cents, e.expires_at,
           coalesce(e.resolved_at, e.occurred_at) as effective_at, e.reason,
           coalesce((select sum(a.cents) from credit_allocations a where a.lot_event_id = e.id), 0)::bigint as allocated
    from ledger_events e
    where e.customer_id = ${customerId}
      and (e.type = 'credit_issue' or (e.type = 'refund' and e.dest = 'credit' and e.status = 'done'))
    order by e.occurred_at, e.seq`.execute(db)
  return r.rows.map((x) => ({
    id: x.id,
    invoiceId: x.invoice_id,
    kind: x.type === 'credit_issue' ? 'issue' : 'refund',
    cents: x.cents,
    expiresAt: x.expires_at,
    effectiveAt: x.effective_at,
    allocated: x.allocated,
    reason: x.reason,
  }))
}

export async function clientCreditBalance(db: Executor, customerId: string, at: Date): Promise<number> {
  return creditBalance(await loadCreditLots(db, customerId), at)
}

/** Serialises everything that spends or reads-then-spends a customer's credit (two invoices applying at once). */
export async function lockCustomerCredit(tx: Tx, customerId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`credit:${customerId}`}))`.execute(tx)
}

/** Writes the allocations of a credit_apply event. The caller holds the customer credit lock. */
export async function recordAllocations(
  tx: Tx,
  o: { applyEventId: string; customerId: string; cents: number; at: Date; newId: NewId; lots?: CreditLot[] },
): Promise<Allocation[]> {
  const lots = o.lots ?? (await loadCreditLots(tx, o.customerId))
  const alloc = allocateFifo(lots, o.at, o.cents)
  for (const a of alloc) {
    await tx
      .insertInto('credit_allocations')
      .values({
        id: o.newId(),
        apply_event_id: o.applyEventId,
        lot_event_id: a.lotId,
        customer_id: o.customerId,
        cents: a.cents,
      })
      .execute()
  }
  return alloc
}
