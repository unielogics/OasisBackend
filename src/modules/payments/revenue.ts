// Cash-basis revenue for the Operations "Revenue today" tile: money that moved in [from, to). Payments count when they
// are recorded (staff-recorded card payments count at once, flagged awaiting_processor until Squarespace confirms),
// voids and refunds paid back to card or cash subtract, store credit does not move money.
import { sql } from 'kysely'
import type { RevenueSource } from '../scheduling/ports.js'

export const ledgerRevenueSource: RevenueSource = {
  async revenueCents(db, locationId, from, to) {
    const r = await sql<{ cents: string | number | null }>`
      select coalesce(sum(case e.type
          when 'pay' then e.amount_cents
          when 'void' then -e.amount_cents
          else 0 end), 0)
        - coalesce(sum(case when e.type = 'refund' and e.status = 'done' and e.dest <> 'credit'
                              and coalesce(e.resolved_at, e.occurred_at) >= ${from}
                              and coalesce(e.resolved_at, e.occurred_at) < ${to}
                            then e.amount_cents else 0 end), 0) as cents
      from ledger_events e
      join invoices i on i.id = e.invoice_id
      where i.location_id = ${locationId}
        and ((e.type in ('pay', 'void') and e.occurred_at >= ${from} and e.occurred_at < ${to})
          or e.type = 'refund')`.execute(db)
    return Number(r.rows[0]?.cents ?? 0)
  },
}
