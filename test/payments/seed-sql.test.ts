// parity-pay seeded into Postgres, the SQL calc (invoice_calc_of) against the TS twin over every seeded invoice and
// against the original bundle's calc(), idempotency of the seed, credit lots and event times.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { designInvoices } from '../../db/seeds/payments.js'
import { calcInvoice } from '../../src/modules/payments/calc.js'
import { clientCreditBalance, loadCreditLots } from '../../src/modules/payments/credit.js'
import { calcFromRow } from '../../src/modules/payments/repository.js'
import type { InvoiceCalcRow } from '../../src/modules/payments/schema.js'
import { isoInTz } from '../../src/platform/time.js'
import { useTestDb } from '../helpers/db.js'
import { cents, oracleCalcs, STATUS_KEY } from './golden.js'

const t = useTestDb()
const design = designInvoices()

async function seed(): Promise<void> {
  await runSeed({ db: t.db, clock: t.clock, profile: 'parity-pay' })
}

describe('parity-pay seed', () => {
  it('creates the 105 invoices, their ledger and the counter, and is idempotent', async () => {
    await seed()
    const counts = async () =>
      (
        await sql<{ i: number; it: number; e: number; a: number; c: number }>`
          select (select count(*) from invoices)::int i, (select count(*) from invoice_items)::int it,
                 (select count(*) from ledger_events)::int e, (select count(*) from credit_allocations)::int a,
                 (select count(*) from customers)::int c`.execute(t.db)
      ).rows[0]!
    const first = await counts()
    expect(first.i).toBe(105)
    expect(first.it).toBe(design.reduce((a, d) => a + d.items.length, 0))
    expect(first.e).toBe(design.reduce((a, d) => a + d.events.length, 0))
    const next = await sql<{ next_no: number }>`select next_no from invoice_counters`.execute(t.db)
    expect(next.rows[0]!.next_no).toBe(20611)
    await seed()
    expect(await counts()).toEqual(first)
  })

  it('SQL invoice_calc equals the TS twin for every seeded invoice', async () => {
    await seed()
    const rows = await sql<InvoiceCalcRow & { invoice_no: number }>`
      select c.*, i.invoice_no from invoices i cross join lateral invoice_calc_of(i.id) c`.execute(t.db)
    expect(rows.rows).toHaveLength(105)
    const byNo = new Map(rows.rows.map((r) => [r.invoice_no, r]))
    for (const d of design) {
      const sqlRow = byNo.get(d.no)!
      const twin = calcInvoice({
        itemPrices: d.items.map((i) => i.priceCents),
        events: d.events.map((e) => ({
          type: e.type,
          amountCents: e.amountCents,
          status: e.type === 'refund' ? (e.status ?? 'done') : undefined,
          dest: e.type === 'refund' ? (e.dest ?? 'card') : undefined,
        })),
        taxBp: 700,
        tipCents: d.tipCents,
        canceled: d.canceled,
      })
      expect(calcFromRow(sqlRow), `INV-${d.no}`).toEqual(twin)
    }
  })

  it('SQL invoice_calc equals the original bundle calc() for every invoice', async () => {
    await seed()
    const orig = oracleCalcs()
    const rows = await sql<InvoiceCalcRow & { invoice_no: number }>`
      select c.*, i.invoice_no from invoices i cross join lateral invoice_calc_of(i.id) c`.execute(t.db)
    const byNo = new Map(rows.rows.map((r) => [r.invoice_no, r]))
    for (const [i, d] of design.entries()) {
      const r = byNo.get(d.no)!
      const o = orig[i]!
      expect(
        [r.items, r.adj, r.sub, r.tax, r.total, r.paid, r.paid_orig, r.credit_applied, r.refunded, r.balance, r.refundable, r.to_orig_max, r.issued, r.net, r.status],
        `${d.designId} -> INV-${d.no}`,
      ).toEqual([
        cents(o.items),
        cents(o.adj),
        cents(o.sub),
        cents(o.tax),
        cents(o.total),
        cents(o.paid),
        cents(o.paidOrig),
        cents(o.creditApplied),
        cents(o.refunded),
        cents(o.balance),
        cents(o.refundable),
        cents(o.toOrigMax),
        cents(o.issued),
        cents(o.net),
        STATUS_KEY[o.status],
      ])
    }
  })

  it('client credit derived from the lots: Priya 20, Mateo 25, Victor 0, Ruby 20, Grace 20', async () => {
    await seed()
    const now = t.clock.now()
    const balance = async (name: string): Promise<number> => {
      const c = await t.db.selectFrom('customers').select('id').where('full_name', '=', name).executeTakeFirstOrThrow()
      return clientCreditBalance(t.db, c.id, now)
    }
    expect(await balance('Priya Nair')).toBe(2000)
    expect(await balance('Mateo Silva')).toBe(2500)
    expect(await balance('Victor Nguyen')).toBe(0)
    expect(await balance('Ruby Castillo')).toBe(2000)
    expect(await balance('Grace Adeyemi')).toBe(2000)
    const victor = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Victor Nguyen').executeTakeFirstOrThrow()
    const lots = await loadCreditLots(t.db, victor.id)
    expect(lots).toHaveLength(1)
    expect([lots[0]!.cents, lots[0]!.allocated]).toEqual([2500, 2500])
  })

  it('event times are real instants relative to the frozen clock (business tz)', async () => {
    await seed()
    const pending = await sql<{ occurred_at: Date; actor_name: string; actor_roles: string }>`
      select e.occurred_at, e.actor_name, e.actor_roles from ledger_events e join invoices i on i.id = e.invoice_id
      where i.invoice_no = 20579 and e.status = 'pending'`.execute(t.db)
    expect(isoInTz(pending.rows[0]!.occurred_at)).toBe('2026-06-12T16:40:00-04:00')
    expect([pending.rows[0]!.actor_name, pending.rows[0]!.actor_roles]).toEqual(['Sofia D.', 'Customer Support'])
    const refund = await sql<{ occurred_at: Date }>`
      select e.occurred_at from ledger_events e join invoices i on i.id = e.invoice_id where i.invoice_no = 20571 and e.type = 'refund'`.execute(t.db)
    expect(isoInTz(refund.rows[0]!.occurred_at)).toBe('2026-06-11T09:12:00-04:00')
    const inv = await sql<{ biz_date: string; occurred_at: Date }>`select biz_date, occurred_at from invoices where invoice_no = 20603`.execute(t.db)
    expect(inv.rows[0]!.biz_date).toBe('2026-06-13')
    expect(isoInTz(inv.rows[0]!.occurred_at)).toBe('2026-06-13T10:31:00-04:00')
  })
})
