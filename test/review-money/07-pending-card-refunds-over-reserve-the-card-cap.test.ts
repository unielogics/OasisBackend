// Review finding 7: a pending refund reserves `refundable` but not the card cap (to_orig_max ignores pending refunds). Two
// pending card refunds can therefore add up to more than was paid by card; the second one can never be approved
// (approval re-validates the cap without it and answers 422) and is stuck in the approvals queue until someone denies it.
import { describe, expect, it } from 'vitest'
import { addEvent, makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'

const p = usePayHarness()

describe('pending card refunds respect the card cap together', () => {
  it('refuses at request time a second card refund that could never be approved', async () => {
    const { sofia, rafael } = p.people()
    const env = p.env()
    // total 179.76 = card 120.00 (confirmed) + store credit 59.76
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 16800 }] })
    await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 12000,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'confirmed',
    })
    await addEvent(p.h.t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 5976,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    // Sofia's limit is $50.00: both requests wait for approval
    const first = await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, {
      mode: 'custom',
      amountCents: 10000,
      dest: 'card',
    })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({ event: { status: 'pending' } })

    // only 20.00 of the card money is left unreserved
    const second = await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, {
      mode: 'custom',
      amountCents: 5976,
      dest: 'card',
    })
    expect(second.statusCode, 'a request that cannot be approved must not be accepted').toBe(422)
    expect(second.json()).toMatchObject({ code: 'REFUND_EXCEEDS_CARD' })

    // and the approver is not left with a request that can only be denied
    const queue = (await p.get(rafael, 'payments/approvals')).json() as {
      items: { eventId: string; amountCents: number }[]
    }
    for (const item of queue.items) {
      const res = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds/${item.eventId}/approve`, {})
      expect(res.statusCode, `approving ${item.amountCents}`).toBe(200)
    }
  })
})
