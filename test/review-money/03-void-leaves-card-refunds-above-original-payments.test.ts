// Review finding 3: voidPayment only checks paid - voided - refunded - pending >= 0 over ALL tenders (store credit included).
// It never re-checks the refunds that went back to the original payment methods, so voiding a payment after a refund to that
// tender leaves refunds above what is left of the original payments (to_orig_max is clamped to 0 and the over-refund is
// silent): money out exceeds money in.
import { describe, expect, it } from 'vitest'
import { addEvent, makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'

const p = usePayHarness()

describe('void keeps refunds within the original payments', () => {
  it('refuses to void a cash payment when refunds to cash would then exceed the remaining original payments', async () => {
    const { rafael, amara } = p.people()
    const env = p.env()
    // total 149.80 = card 60.00 (confirmed) + cash 40.00 + store credit 49.80; original (non-credit) payments 100.00
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 14000 }] })
    await addEvent(p.h.t.db, env, inv, { type: 'pay', amountCents: 6000, method: 'Visa', methodKind: 'card', processorState: 'confirmed' })
    const cash = await addEvent(p.h.t.db, env, inv, { type: 'pay', amountCents: 4000, method: 'Cash', methodKind: 'cash' })
    await addEvent(p.h.t.db, env, inv, { type: 'credit_apply', amountCents: 4980, method: 'Store credit', methodKind: 'store_credit' })
    // a refund of 100.00 in cash is inside toOrigMax (100.00) and refundable (149.80)
    const refund = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 10000, dest: 'cash' })
    expect(refund.statusCode).toBe(201)

    // voiding the 40.00 cash leaves original payments of 60.00 against 100.00 already refunded
    const voided = await p.send(amara, 'POST', `invoices/${inv.id}/void`, { eventId: cash })
    expect(voided.statusCode).toBe(422)

    const d = (await p.get(rafael, `invoices/${inv.id}`)).json<{ calc: { paidOrig: number; refOrig: number } }>()
    expect(d.calc.paidOrig).toBeGreaterThanOrEqual(d.calc.refOrig)
  })

  it('refuses to void a card payment that awaits Squarespace after part of it was refunded to card', async () => {
    const { rafael, amara } = p.people()
    const env = p.env()
    // total 200.09 = cash 100.00 + card 100.09 (recorded by staff, awaiting Squarespace)
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 18700 }] })
    await addEvent(p.h.t.db, env, inv, { type: 'pay', amountCents: 10000, method: 'Cash', methodKind: 'cash' })
    const card = await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 10009,
      method: 'Card',
      methodKind: 'card',
      processorState: 'awaiting_processor',
    })
    expect((await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 6000, dest: 'card' })).statusCode).toBe(201)

    // the card payment would be voided while 60.00 of it already went back to the card
    const voided = await p.send(amara, 'POST', `invoices/${inv.id}/void`, { eventId: card })
    expect(voided.statusCode).toBe(422)
  })
})
