// What InvoiceSummary.paidCents means, pinned: the money paid against the invoice (payments less voided ones, plus store credit
// applied). Refunds are not subtracted; they are reported apart (`refunded`), and the balance never re-opens because of one.
import { describe, expect, it } from 'vitest'
import { calcInvoice } from '../../src/modules/payments/calc.js'

const base = { itemPrices: [10_000], taxBp: 700, tipCents: 0, canceled: false }

describe('paidCents', () => {
  it('counts payments and applied store credit, less voided payments', () => {
    const c = calcInvoice({
      ...base,
      events: [
        { type: 'pay', amountCents: 5_000 },
        { type: 'pay', amountCents: 2_000 },
        { type: 'void', amountCents: 2_000 },
        { type: 'credit_apply', amountCents: 1_500 },
      ],
    })
    expect(c.paid).toBe(6_500)
  })

  it('does not subtract a refund', () => {
    const c = calcInvoice({
      ...base,
      events: [
        { type: 'pay', amountCents: 10_700 },
        { type: 'refund', amountCents: 3_000, status: 'done', dest: 'card' },
      ],
    })
    expect({ paid: c.paid, refunded: c.refunded, balance: c.balance }).toEqual({ paid: 10_700, refunded: 3_000, balance: 0 })
  })
})
