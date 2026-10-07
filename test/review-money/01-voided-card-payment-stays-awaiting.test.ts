// Review finding 1: voiding a card payment that is still awaiting Squarespace leaves the pay event in
// processor_state = awaiting_processor. The void event nets the money out of the invoice, but the voided pay keeps being
// counted as "card money waiting on Squarespace": the Payments summary, the invoice list pill (the dashboard reads
// awaiting = 'payment' as "Payment pending", DV-212, even though the invoice is Unpaid again), the reconciliation alert
// after 2 h, and confirm-processor still accepts it (it "confirms" money that was reversed).
import { describe, expect, it } from 'vitest'
import { makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'

const p = usePayHarness()

interface PayResult {
  event: { id: string; processorState: string }
}

async function voidedCardPayment() {
  const { rafael } = p.people()
  const inv = await makeInvoice(p.h.t.db, p.env())
  const card = p.json<PayResult>(await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'card' }))
  expect(card.event.processorState).toBe('awaiting_processor')
  const voided = await p.send(rafael, 'POST', `invoices/${inv.id}/void`, { eventId: card.event.id })
  expect(voided.statusCode).toBe(201)
  return { rafael, inv, cardEventId: card.event.id }
}

describe('a voided card payment is no longer awaiting Squarespace', () => {
  it('is not counted in the Payments summary awaitingProcessor', async () => {
    const { rafael } = await voidedCardPayment()
    const summary = p.json<{ awaitingProcessor: { count: number; cents: number } }>(
      await p.get(rafael, 'payments/summary?range=today'),
    )
    expect(summary.awaitingProcessor).toEqual({ count: 0, cents: 0 })
  })

  it('does not mark the (unpaid again) invoice as awaiting in the list', async () => {
    const { rafael, inv } = await voidedCardPayment()
    const list = p.json<{ items: { id: string; awaiting: string | null; status: string }[] }>(
      await p.get(rafael, 'payments/invoices?range=today'),
    )
    expect(list.items.find((r) => r.id === inv.id)).toMatchObject({ status: 'unpaid', awaiting: null })
  })

  it('does not stay on the reconciliation list after the 2 h threshold', async () => {
    const { rafael, cardEventId } = await voidedCardPayment()
    p.h.clock.advance(3 * 3_600_000)
    const rec = p.json<{ awaitingProcessor: { eventId: string }[] }>(
      await p.get(rafael, 'payments/reconciliation'),
    )
    expect(rec.awaitingProcessor.map((x) => x.eventId)).not.toContain(cardEventId)
  })

  it('cannot be confirmed by hand', async () => {
    const { rafael, cardEventId } = await voidedCardPayment()
    const confirm = await p.send(rafael, 'POST', `ledger-events/${cardEventId}/confirm-processor`, {})
    expect(confirm.statusCode).toBe(409)
  })
})
