// The client credit block of the invoice detail and GET /clients/:id/credit.
import type { Executor } from '../../platform/db.js'
import { creditBalance, isExpired, loadCreditLots, lotRemaining, usableLots, type CreditLot } from './credit.js'

export interface ClientCreditSummary {
  balanceCents: number
  /** The soonest expiry among usable lots that expire, with the cents it would take with it. */
  nextExpiry: { at: string; cents: number } | null
}

export interface CreditEntryDto {
  lotEventId: string
  invoiceId: string
  kind: 'issue' | 'refund'
  reason: string | null
  issuedCents: number
  usedCents: number
  remainingCents: number
  expiresAt: string | null
  state: 'active' | 'used' | 'expired'
}

export function summarize(lots: readonly CreditLot[], now: Date): ClientCreditSummary {
  const usable = usableLots(lots, now)
  const expiring = usable.filter((l) => l.expiresAt !== null).sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
  const first = expiring[0]
  return {
    balanceCents: creditBalance(lots, now),
    nextExpiry: first
      ? {
          at: first.expiresAt!.toISOString(),
          cents: expiring.filter((l) => l.expiresAt!.getTime() === first.expiresAt!.getTime()).reduce((a, l) => a + lotRemaining(l), 0),
        }
      : null,
  }
}

export async function clientCreditSummary(db: Executor, customerId: string, now: Date): Promise<ClientCreditSummary> {
  return summarize(await loadCreditLots(db, customerId), now)
}

export function creditEntries(lots: readonly CreditLot[], now: Date): CreditEntryDto[] {
  return lots.map((l) => ({
    lotEventId: l.id,
    invoiceId: l.invoiceId,
    kind: l.kind,
    reason: l.reason,
    issuedCents: l.cents,
    usedCents: l.allocated,
    remainingCents: isExpired(l, now) ? 0 : lotRemaining(l),
    expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
    state: isExpired(l, now) ? 'expired' : lotRemaining(l) === 0 ? 'used' : 'active',
  }))
}
