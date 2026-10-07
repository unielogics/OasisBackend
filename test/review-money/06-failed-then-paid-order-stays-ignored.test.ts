// Review finding 6: an order that is seen while its paymentState is FAILED is stored as ignored/payment_failed for good. If the
// customer then pays that same order (the state moves to PAID and a payment appears in the Transactions feed), nothing
// re-evaluates it: processOrder returns early for an ignored order and only unmapped_sku orders are ever reopened. Real card
// money sits in Squarespace with no ledger event, no manual-queue row and no alert.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'

describe('an order whose first payment attempt failed and whose retry succeeded', () => {
  const rig = useRig({ pageSize: 50 })

  it('is not left ignored: the payment reaches the ledger or the manual queue', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'DET-SEDAN', kind: 'service' },
      ]),
    )
    const customerId = await makeCustomer(r.db, env, {
      name: 'Liam Chen',
      email: 'liam@example.com',
      phone: '+13055550142',
    })
    const inv = await makeInvoice(r.db, env, { customerId, items: [{ name: 'Full Detail', priceCents: 18900 }] })
    const order = r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
      pay: false,
    })
    r.store.setState(order.orderId, { paymentState: 'FAILED' })
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)
    const first = await r.db.selectFrom('sqsp_orders').select(['match_state', 'ignore_reason']).executeTakeFirstOrThrow()
    expect(first).toEqual({ match_state: 'ignored', ignore_reason: 'payment_failed' })

    // the customer retries and the card goes through
    r.advance(10 * 60_000)
    r.store.addPayment(order.orderId, { amountCents: 20223, paidOn: r.clock.now() })
    for (let i = 0; i < 3; i++) {
      r.advance(120_000)
      await r.rt.syncCycle(r.locationId)
    }
    const order2 = await r.db.selectFrom('sqsp_orders').select(['match_state', 'payment_state']).executeTakeFirstOrThrow()
    expect(order2.payment_state).toBe('PAID')
    const pays = await r.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', inv.id).where('type', '=', 'pay').execute()
    const queued = await r.db.selectFrom('sqsp_manual_queue').select('id').where('state', '=', 'open').execute()
    expect(order2.match_state, 'a paid order must not stay ignored').not.toBe('ignored')
    expect(pays.length + queued.length, 'the money is on the ledger or in the queue').toBeGreaterThan(0)
  })
})
