// Review finding 12 through the real stack: book, cancel (a deposit stays), reopen over HTTP with the real gateway; the invoice
// must be live again, with the deposit and the right balance, and Collect must work.
import { describe, expect, it } from 'vitest'
import { useMemRig } from '../memberships/harness.js'

describe('cancel then reopen over the API', () => {
  const m = useMemRig()

  it('the reopened job has a live invoice with its deposit and a collectable balance', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const pay = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/payment-links`, {
      kind: 'deposit',
      amountCents: 1000,
      url: 'https://oasis-auto-spa.squarespace.com/checkout/dep',
    })
    expect(pay.statusCode, pay.body).toBe(201)
    // the deposit arrives from Squarespace (recorded the way the sync does)
    await m.h.t.db
      .insertInto('ledger_events')
      .values({
        id: m.h.t.app.newId(),
        location_id: m.locationId(),
        invoice_id: a.invoiceId,
        customer_id: (await m.customer('Maria Delgado')) as string,
        type: 'pay',
        amount_cents: 1000,
        status: 'done',
        method: 'Visa',
        method_kind: 'card',
        deposit: true,
        actor_name: 'Squarespace',
        occurred_at: m.h.clock.now(),
        source: 'squarespace',
        processor_state: 'confirmed',
      })
      .execute()

    const canceled = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, {
      reason: 'Client asked',
    })
    expect(canceled.statusCode, canceled.body).toBe(200)
    expect(
      await m.h.t.db
        .selectFrom('invoice_calc')
        .select('status')
        .where('invoice_id', '=', a.invoiceId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'canceled_kept' })

    const reopened = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/reopen`, {}, false)
    expect(reopened.statusCode, reopened.body).toBe(200)
    const calc = await m.h.t.db
      .selectFrom('invoice_calc')
      .select(['status', 'balance', 'paid'])
      .where('invoice_id', '=', a.invoiceId)
      .executeTakeFirstOrThrow()
    expect(calc).toMatchObject({ status: 'partially_paid', paid: 1000 })
    expect(calc.balance).toBeGreaterThan(0)

    const collect = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/payments`, { method: 'cash' })
    expect(collect.statusCode, collect.body).toBe(201)
  })
})
