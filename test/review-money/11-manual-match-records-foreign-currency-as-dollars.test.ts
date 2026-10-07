// Review finding 11: the automatic matcher sends any non-USD arrival to the manual queue (currency_mismatch), but the manual
// match endpoint's function never looks at the currency: matching that order to an invoice books the foreign amount as US cents.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { SqspLedgerOps } from '../../src/modules/payments-sync/db/ledger.js'
import { manualMatch } from '../../src/modules/payments-sync/db/manual.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'
import { makeUser } from './helpers.js'

describe('manual match of a non-USD order', () => {
  const rig = useRig({ pageSize: 50 })

  it('is refused instead of booking euro cents as dollars', async () => {
    const r = rig()
    ;(r.store.options as { currency: string }).currency = 'EUR'
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
    const inv = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
    })
    const order = r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
    })
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)
    const q = await r.db
      .selectFrom('sqsp_manual_queue')
      .select('reason')
      .where('state', '=', 'open')
      .execute()
    expect(q).toEqual([{ reason: 'currency_mismatch' }])

    const rafael = await makeUser(r.db, r.newId, 'Rafael')
    const deps = {
      locationId: r.locationId,
      clock: r.clock,
      newId: r.newId,
      ops: new SqspLedgerOps({ locationId: r.locationId, clock: r.clock, newId: r.newId }),
      varianceAlertCents: 100,
    }
    const attempt = await transaction(r.db, (tx) =>
      manualMatch(
        tx,
        deps,
        { orderId: order.orderId, invoiceId: inv.id },
        { userId: rafael.userId, employeeId: rafael.employeeId, name: rafael.name },
      ),
    ).then(
      () => 'matched',
      (e: { code?: string }) => e.code ?? 'error',
    )
    const pays = await r.db
      .selectFrom('ledger_events')
      .select('amount_cents')
      .where('invoice_id', '=', inv.id)
      .where('type', '=', 'pay')
      .execute()
    expect(pays, `manual match answered ${attempt}`).toHaveLength(0)
  })
})
