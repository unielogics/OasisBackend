// The common tail of every change to an invoice's money, whoever makes it (a staff command in commands.ts, the Squarespace sync in
// payments-sync/db/ledger.ts, the Square ledger ops in square/ledger.ts): the optimistic version bump, the audit row with the
// invoice's new standing, the `payments` SSE events the Payments screen redraws from, and the Operations board refresh.
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Tx } from '../../platform/db.js'
import * as realtime from '../../platform/realtime.js'
import type { InvoiceCalc } from './calc.js'
import { publishOpsForInvoice } from './ops-events.js'
import { calcOf, touchInvoice } from './repository.js'

export interface AnnounceInput {
  locationId: string
  invoiceId: string
  now: Date
  /** Audit action, e.g. payments.collect, sqsp.record_payment, square.record_payment. */
  action: string
  ctx: AuditContext
  before?: unknown
  /** Merged into the audit row's `after`, after (and so over) the invoice's status, paid, refunded and balance. */
  after?: Record<string, unknown>
  /** Fields put first in the audit row's `after` (a staff command lists its new events there). */
  lead?: Record<string, unknown>
  /** Ledger events this change wrote or moved: one `ledger.event` each. */
  events: ReadonlyArray<{ id: string; type: string }>
  /** Extra realtime event types (refund.pending, refund.resolved, ...), with the event they are about. */
  extra?: ReadonlyArray<{ type: string; eventId?: string }>
}

export interface Announced {
  version: number
  calc: InvoiceCalc
  /** The audit_log row written (a staff event links it: ADR 0180). */
  auditId: number
}

export async function announceInvoiceChange(tx: Tx, o: AnnounceInput): Promise<Announced> {
  const version = await touchInvoice(tx, o.invoiceId, o.now)
  const calc = await calcOf(tx, o.invoiceId)
  const auditId = await audit.record(tx, {
    locationId: o.locationId,
    action: o.action,
    entityType: 'invoice',
    entityId: o.invoiceId,
    before: o.before,
    after: {
      ...o.lead,
      status: calc.status,
      paid: calc.paid,
      refunded: calc.refunded,
      balance: calc.balance,
      ...o.after,
    },
    ctx: o.ctx,
  })
  const pub = (type: string, payload: Record<string, string | number>): Promise<number> =>
    realtime.publish(tx, { locationId: o.locationId, channel: 'payments', type, payload })
  await pub('invoice.updated', { invoiceId: o.invoiceId, version })
  for (const e of o.events) await pub('ledger.event', { invoiceId: o.invoiceId, eventId: e.id, type: e.type })
  for (const x of o.extra ?? [])
    await pub(x.type, x.eventId ? { invoiceId: o.invoiceId, eventId: x.eventId } : { invoiceId: o.invoiceId })
  await publishOpsForInvoice(tx, o.locationId, o.invoiceId)
  return { version, calc, auditId }
}

/** The invoice's standing before a change, for the audit row's `before`. */
export async function invoiceSnapshot(
  tx: Tx,
  invoiceId: string,
): Promise<{ status: string; total: number; paid: number; refunded: number; balance: number }> {
  const c = await calcOf(tx, invoiceId)
  return { status: c.status, total: c.total, paid: c.paid, refunded: c.refunded, balance: c.balance }
}
