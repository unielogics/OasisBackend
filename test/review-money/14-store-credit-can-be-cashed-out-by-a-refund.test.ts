// Review finding 14: only a refund to CARD is capped by the original (non-credit) payments (to_orig_max, "refund the rest to
// store credit"); a refund to CASH is capped by `refundable` alone, which includes the store credit applied to the invoice.
// A Support agent (credit limit $50, refund limit $50, no approval needed) can therefore issue goodwill credit, apply it to an
// invoice and refund the same money in cash: store credit becomes cash, inside every per-transaction limit.
import { describe, expect, it } from 'vitest'
import { makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'

const p = usePayHarness()

describe('refunds to cash and card never return more than the non-credit money collected', () => {
  it('refuses a cash refund of money that was paid with store credit', async () => {
    const { sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Express Hand Wash', priceCents: 4000 }] })
    expect((await p.send(sofia, 'POST', `invoices/${inv.id}/credits`, { amountCents: 3000, expiry: 'none' })).statusCode).toBe(201)
    const applied = await p.send(sofia, 'POST', `invoices/${inv.id}/credit-applications`, {})
    expect(applied.statusCode).toBe(201)
    expect(applied.json()).toMatchObject({ event: { amountCents: 3000, type: 'credit_apply' } })

    const cash = await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 3000, dest: 'cash' })
    expect(cash.statusCode, cash.body.slice(0, 300)).toBe(422)
    expect(cash.json()).toMatchObject({ code: expect.stringMatching(/^REFUND_EXCEEDS/) })

    // the same money can still go back as store credit
    const credit = await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 3000, dest: 'credit' })
    expect(credit.statusCode).toBe(201)
  })
})
