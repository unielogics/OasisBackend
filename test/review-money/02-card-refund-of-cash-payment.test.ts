// Review finding 2: the card cap (toOrigMax) is "everything paid except store credit", so a refund to CARD is accepted on an
// invoice that was paid entirely in cash, or for more than the card part of a mixed payment. ADR 0051 says a card refund is
// "capped by what was paid by card" and the error text says "Only $X was paid by card". The refund is then flagged
// awaiting_processor ("complete in Squarespace") although no card ever paid, so the Transactions feed can never confirm it.
import { describe, expect, it } from 'vitest'
import { addEvent, makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'

const p = usePayHarness()

describe('a refund to card is capped by what was paid by card', () => {
  it('refuses a card refund on an invoice paid only in cash', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Express Hand Wash', priceCents: 10000 }] })
    const cash = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })
    expect(cash.statusCode).toBe(201)

    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
      mode: 'custom',
      amountCents: 5000,
      dest: 'card',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'REFUND_EXCEEDS_CARD' })
  })

  it('caps a card refund of a mixed cash + card invoice at the card part', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Express Hand Wash', priceCents: 10000 }] })
    await addEvent(p.h.t.db, p.env(), inv, {
      type: 'pay',
      amountCents: 7000,
      method: 'Cash',
      methodKind: 'cash',
    })
    await addEvent(p.h.t.db, p.env(), inv, {
      type: 'pay',
      amountCents: 3700,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'confirmed',
    })
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
      mode: 'custom',
      amountCents: 10700,
      dest: 'card',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'REFUND_EXCEEDS_CARD' })
  })
})
