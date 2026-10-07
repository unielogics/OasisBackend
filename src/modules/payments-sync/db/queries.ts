// Read ports other modules consume: the Payments reconciliation lists (UnmatchedSource), the card hint behind "Visa · managed
// in Squarespace" (CardHintProvider) and the Operations "Needs attention" alert 12 (ExternalAlertSource).
import { sql } from 'kysely'
import type { Executor } from '../../../platform/db.js'
import { formatUsd } from '../../../platform/money.js'
import type { CardHintProvider, UnmatchedOrder, UnmatchedSource, UnmatchedTransaction } from '../../payments/ports.js'
import { AWAITING_ALERT_MINUTES } from '../../payments/reports.js'
import type { ExternalAlert, ExternalAlertSource } from '../../scheduling/ports.js'

export const sqspUnmatched: UnmatchedSource = {
  async unmatchedOrders(db: Executor): Promise<UnmatchedOrder[]> {
    const r = await sql<{
      sqsp_order_id: string
      order_number: string
      customer_email: string | null
      grand_total_cents: number
      created_on: Date
    }>`
      select o.sqsp_order_id, o.order_number, o.customer_email, o.grand_total_cents, o.created_on
      from sqsp_orders o
      where exists (select 1 from sqsp_manual_queue m
                    where m.location_id = o.location_id and m.sqsp_order_id = o.sqsp_order_id and m.state = 'open')
      order by o.created_on, o.sqsp_order_id`.execute(db)
    return r.rows.map((x) => ({
      sqspOrderId: x.sqsp_order_id,
      orderNumber: x.order_number,
      customerEmail: x.customer_email,
      totalCents: x.grand_total_cents,
      createdAt: x.created_on,
    }))
  },
  async unmatchedTransactions(db: Executor): Promise<UnmatchedTransaction[]> {
    const rows = await db
      .selectFrom('sqsp_transactions')
      .select(['sqsp_txn_id', 'sqsp_order_id', 'kind', 'amount_cents', 'created_on'])
      .where('state', 'in', ['manual', 'deferred'])
      .orderBy('created_on')
      .orderBy('sqsp_txn_id')
      .execute()
    return rows.map((t) => ({
      sqspTransactionId: t.sqsp_txn_id,
      sqspOrderId: t.sqsp_order_id,
      kind: t.kind,
      amountCents: t.amount_cents,
      createdAt: t.created_on,
    }))
  },
}

/** The brand of the customer's latest Squarespace card payment (by linked Squarespace customer id, then email); no last4 exists. */
export const sqspCardHints: CardHintProvider = {
  async hintFor(db: Executor, customerId: string): Promise<{ brand: string } | null> {
    const r = await sql<{ brand: string }>`
      select t.brand
      from sqsp_transactions t
      join sqsp_orders o on o.location_id = t.location_id and o.sqsp_order_id = t.sqsp_order_id
      where t.kind = 'payment' and t.brand is not null and t.brand <> 'OTHER' and not o.test_mode
        and (o.customer_id = ${customerId}
          or o.sqsp_customer_id in (select l.sqsp_customer_id from sqsp_customer_links l where l.customer_id = ${customerId})
          or lower(o.customer_email) = (select lower(c.email::text) from customers c where c.id = ${customerId}))
      order by t.created_on desc, t.sqsp_txn_id desc
      limit 1`.execute(db)
    return r.rows[0] ? { brand: r.rows[0].brand } : null
  },
}

const ageLabel = (minutes: number): string =>
  minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${Math.max(1, minutes)} min`

/**
 * Alert 12 of the Operations screen: card money recorded in Oasis that Squarespace has not confirmed after
 * AWAITING_ALERT_MINUTES (review B8: 2 hours, not the design's 24), and orders waiting in the manual matching queue
 * (managers only). Both are computed on read, so they clear the moment the sync or a person resolves them.
 */
export const sqspExternalAlerts: ExternalAlertSource = {
  async list(db, ctx): Promise<ExternalAlert[]> {
    const out: ExternalAlert[] = []
    const cutoff = new Date(ctx.now.getTime() - AWAITING_ALERT_MINUTES * 60_000)
    const aw = await sql<{
      id: string
      type: 'pay' | 'refund'
      amount_cents: number
      occurred_at: Date
      invoice_no: number
      client_name: string
      appointment_id: string | null
    }>`
      select e.id, e.type, e.amount_cents, e.occurred_at, i.invoice_no, i.client_name, i.appointment_id
      from ledger_events e join invoices i on i.id = e.invoice_id
      where e.location_id = ${ctx.locationId} and e.processor_state = 'awaiting_processor' and e.occurred_at <= ${cutoff}
        and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
      order by e.occurred_at, e.seq
      limit 20`.execute(db)
    for (const e of aw.rows) {
      const minutes = Math.floor((ctx.now.getTime() - e.occurred_at.getTime()) / 60_000)
      out.push({
        key: `awaiting_processor:${e.id}`,
        kind: 'awaiting_processor',
        tone: 'amber',
        title: `${e.type === 'refund' ? 'Card refund' : 'Card payment'} not confirmed · ${e.client_name}`,
        desc: `${formatUsd(e.amount_cents)} on INV-${e.invoice_no} recorded ${ageLabel(minutes)} ago · finish it in Squarespace`,
        actionLabel: 'Confirm',
        appointmentId: e.appointment_id,
        priority: 0,
      })
    }
    if (ctx.manager) {
      const q = await sql<{ n: number }>`
        select count(distinct m.sqsp_order_id)::int as n from sqsp_manual_queue m
        where m.location_id = ${ctx.locationId} and m.state = 'open'`.execute(db)
      const n = q.rows[0]?.n ?? 0
      if (n > 0)
        out.push({
          key: 'unmatched_orders',
          kind: 'unmatched_order',
          tone: 'violet',
          title: `${n} Squarespace ${n === 1 ? 'order needs' : 'orders need'} matching`,
          desc: 'Match each to an invoice or ignore it in Payments',
          actionLabel: 'Review',
          appointmentId: null,
          priority: 0,
        })
    }
    return out
  },
}

/** Merges several alert sources (messaging, payments sync) into the one the scheduling module takes. */
export function combineExternalAlerts(...sources: ExternalAlertSource[]): ExternalAlertSource {
  return {
    async list(db, ctx) {
      const lists = await Promise.all(sources.map((s) => s.list(db, ctx)))
      return lists.flat()
    },
  }
}
