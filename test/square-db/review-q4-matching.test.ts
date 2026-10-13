// Review Q4 money:M1: a counter payment naming an invoice (R1) or opened from Oasis (R2) whose amount is not the staff "Square reader"
// entry waiting there is never recorded as new money beside that entry (a split tender, a partial reader payment would count twice);
// a person decides from the queue. The overpaid alert then says to check the waiting entry before refunding.
import { describe, expect, it } from 'vitest'
import { squareExternalAlerts } from '../../src/modules/square/db/alerts.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { applySquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { transaction } from '../../src/platform/db.js'
import { useTestDb } from '../helpers/db.js'
import { coreRig, useCoreRuntime } from './core.js'

describe('R1 and R2 with a staff entry of another amount waiting (review Q4 money:M1)', () => {
  const t = useTestDb()
  useCoreRuntime()

  it('two tenders naming the invoice beside a waiting 42.80 entry go to the queue; nothing is counted twice', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    const entry = await r.staffCard(inv, 4280)
    const a = r.posPayment({ amountCents: 2000, note: `INV-${inv.no}` })
    const b = r.posPayment({ amountCents: 2280, note: `INV-${inv.no}` })
    expect(await r.decide(a.id, { force: true })).toBe('unmatched')
    expect(await r.decide(b.id, { force: true })).toBe('unmatched')
    expect(await r.mirror(a.id)).toMatchObject({ match_state: 'unmatched', variance: { reason: 'a staff card entry of another amount is waiting on this invoice' } })
    const pays = await t.db.selectFrom('ledger_events').select(['id', 'amount_cents', 'processor_state']).where('invoice_id', '=', inv.id).where('type', '=', 'pay').execute()
    expect(pays).toEqual([{ id: entry, amount_cents: 4280, processor_state: 'awaiting_processor' }])
    expect(await r.calc(inv.id)).toMatchObject({ paid: 4280, overpaid: 0 })
    // the same tender with no staff entry waiting is recorded as before (R1, a partial amount)
    const other = await r.openInvoice()
    const c = r.posPayment({ amountCents: 2000, note: `INV-${other.no}` })
    expect(await r.decide(c.id, { force: true })).toBe('matched')
    expect(await r.calc(other.id)).toMatchObject({ paid: 2000 })
  })

  it('the overpaid alert names a waiting staff entry before suggesting a refund', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    await r.staffCard(inv, 4280)
    const p = r.posPayment({ amountCents: 4280 })
    // a person applies it as new money instead of confirming the entry
    await transaction(t.db, async (tx) => {
      await lockPayment(tx, p.id)
      await applySquarePayment(tx, r.deps, paymentFacts(await r.sim.api.payments.get(p.id)), { invoiceId: inv.id, actor: { name: 'Sofia' } })
    })
    expect(await r.calc(inv.id)).toMatchObject({ overpaid: 4280 })
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: false })
    expect(alerts.filter((x) => x.kind === 'square_overpaid').map((x) => x.desc)).toEqual([
      `$42.80 more than INV-${inv.no} · a staff card entry is still waiting: check it before refunding`,
    ])
  })
})
