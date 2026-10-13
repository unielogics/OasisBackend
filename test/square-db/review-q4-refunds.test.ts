// Review Q4 SQ-SEM-1: a refund made in the Square app before its payment is on an invoice (the counter delay, the "payments to match"
// queue) is kept, and recorded on the invoice the moment the payment is: by the matcher after the delay, or by a person days later.
import { describe, expect, it } from 'vitest'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { applySquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { transaction } from '../../src/platform/db.js'
import { useTestDb } from '../helpers/db.js'
import { coreRig, useCoreRuntime } from './core.js'

const HOUR = 3_600_000

describe('a Square app refund before its payment is on an invoice (review Q4 SQ-SEM-1)', () => {
  const t = useTestDb()
  useCoreRuntime()

  const waiting = () => t.db.selectFrom('square_refunds_waiting').selectAll().execute()
  const refunds = (invoiceId: string) =>
    t.db.selectFrom('ledger_events').select(['type', 'amount_cents', 'needs_review', 'source']).where('invoice_id', '=', invoiceId).where('type', '=', 'refund').execute()

  it('refunded in full during the counter delay: recorded on the invoice when the matcher confirms the staff entry', async () => {
    const r = await coreRig(t, { SQUARE_MATCH_DELAY_SECONDS: '90' })
    const inv = await r.openInvoice()
    await r.staffCard(inv, 4280)
    const p = r.posPayment({ amountCents: 4280 })
    expect(await r.decide(p.id)).toBe('pending')
    const rf = await r.sim.api.refunds.refund(sqKey('rf', 'app-a1'), { payment_id: p.id, amount_money: usd(4280) })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(rf.id)).toMatchObject({ status: 'processed', note: 'refund of a Square payment that is not on an invoice yet: kept until the payment is matched' })
    expect(await waiting()).toHaveLength(1)
    r.clock.advance(2 * 60_000)
    expect(await r.decide(p.id)).toBe('matched')
    expect(await r.calc(inv.id)).toMatchObject({ paid: 4280, refunded: 4280 })
    expect(await refunds(inv.id)).toEqual([{ type: 'refund', amount_cents: 4280, needs_review: true, source: 'square' }])
    expect(await waiting()).toEqual([])
    // the refund event again (a duplicate delivery, the reconcile): nothing twice
    await r.ingestRefund(rf.id)
    expect(await refunds(inv.id)).toHaveLength(1)
  })

  it('refunded while the payment waits in the queue: recorded when a person applies it, even 73 hours later', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    const p = r.posPayment({ amountCents: 1000 })
    expect(await r.decide(p.id, { force: true })).toBe('unmatched')
    const rf = await r.sim.api.refunds.refund(sqKey('rf', 'app-a2'), { payment_id: p.id, amount_money: usd(1000) })
    r.sim.store.advance(5_000)
    await r.ingestRefund(rf.id)
    r.clock.advance(73 * HOUR)
    await transaction(t.db, async (tx) => {
      await lockPayment(tx, p.id)
      await applySquarePayment(tx, r.deps, paymentFacts(await r.sim.api.payments.get(p.id)), { invoiceId: inv.id, actor: { name: 'Sofia' } })
    })
    expect(await r.calc(inv.id)).toMatchObject({ paid: 1000, refunded: 1000 })
    expect(await refunds(inv.id)).toEqual([{ type: 'refund', amount_cents: 1000, needs_review: true, source: 'square' }])
    expect(await waiting()).toEqual([])
  })
})
