// Review finding 8: the adjust body accepts a percent of up to 2,000,000,000 basis points and a Super Admin has no adjust
// limit, so pre-tax = items x bp / 10000 is computed in JS and written to ledger_events.amount_cents (int4). Anything above
// 2,147,483,647 cents makes Postgres reject the insert and the API answers 500 instead of a validation error.
import { describe, expect, it } from 'vitest'
import { makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'

const p = usePayHarness()

describe('adjustments cannot overflow the integer amount column', () => {
  it('a huge percent surcharge is a 4xx validation error, never a 500', async () => {
    const { amara } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env(), {
      items: [{ name: 'Executive Detail', priceCents: 30000 }],
    })
    const res = await p.send(amara, 'POST', `invoices/${inv.id}/adjustments`, {
      kind: 'surcharge',
      unit: '%',
      value: 2_000_000_000,
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBeLessThan(500)
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    const rows = await p.h.t.db
      .selectFrom('ledger_events')
      .select('id')
      .where('invoice_id', '=', inv.id)
      .execute()
    expect(rows).toHaveLength(0)
  })
})
