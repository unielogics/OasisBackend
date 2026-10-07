// Review finding 10: manually matching a Squarespace PAYMENT to an invoice is refused (409 SQSP_MATCH_DUPLICATE) when the invoice
// already shows a waiting or equal card payment, unless `force`. Manually matching a REFUND to an invoice has no such guard:
// it always inserts an external refund. A refund that sits in the queue because the order's contact does not match the
// customer (so the matcher cannot pair it with the staff-recorded refund) can therefore be booked a second time by the
// natural "match to invoice" click, leaving the staff refund awaiting forever.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { PaymentsService } from '../../src/modules/payments/commands.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { SqspLedgerOps } from '../../src/modules/payments-sync/db/ledger.js'
import { manualMatch } from '../../src/modules/payments-sync/db/manual.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'
import { ctxFor, makeUser, stubActor } from './helpers.js'

describe('manual matching of a refund', () => {
  const rig = useRig({ pageSize: 50 })

  it('is refused when the invoice already carries the same refund, waiting on Squarespace', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'DET-SEDAN', kind: 'service' }]),
    )
    // the customer's contact on file differs from the one on the Squarespace order (work email, other phone)
    const customerId = await makeCustomer(r.db, env, { name: 'Liam Chen', email: 'liam@example.com', phone: '+13055550142' })
    const inv = await makeInvoice(r.db, env, { customerId, items: [{ name: 'Full Detail', priceCents: 18900 }] })
    const order = r.store.createOrder({
      email: 'liam.work@acme.example',
      name: 'Liam Chen',
      phone: '7865550199',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
    })
    await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, method: 'Visa', methodKind: 'card', processorState: 'confirmed', at: r.clock.now() })
    await r.db
      .updateTable('ledger_events')
      .set({ sqsp_order_id: order.orderId, processor_ref: order.paymentId ?? null })
      .where('invoice_id', '=', inv.id)
      .execute()
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)

    const service = new PaymentsService({ clock: r.clock, newId: r.newId, ports: defaultPorts() })
    const rafael = await makeUser(r.db, r.newId, 'Rafael')
    const staff = await transaction(r.db, (tx) =>
      service.refund(tx, ctxFor(r.locationId, stubActor(rafael, { refund: null })), inv.id, {
        mode: 'custom',
        amountCents: 6000,
        dest: 'card',
      }),
    )
    expect(staff.event.processorState).toBe('awaiting_processor')
    r.advance(600_000)
    r.store.refund(order.orderId, { amountCents: 6000, refundedOn: r.clock.now() })
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)
    const queued = await r.db.selectFrom('sqsp_manual_queue').select(['reason', 'state']).where('state', '=', 'open').execute()
    expect(queued.length, 'the unpairable refund waits in the queue').toBe(1)

    // staff pick "match to invoice" for it
    const deps = {
      locationId: r.locationId,
      clock: r.clock,
      newId: r.newId,
      ops: new SqspLedgerOps({ locationId: r.locationId, clock: r.clock, newId: r.newId }),
      varianceAlertCents: 100,
    }
    const attempt = await transaction(r.db, (tx) =>
      manualMatch(tx, deps, { orderId: order.orderId, invoiceId: inv.id }, { userId: rafael.userId, employeeId: rafael.employeeId, name: rafael.name }),
    ).then(
      () => 'matched',
      (e: { code?: string }) => e.code ?? 'error',
    )
    const refunds = await r.db.selectFrom('ledger_events').select(['id', 'amount_cents', 'source']).where('invoice_id', '=', inv.id).where('type', '=', 'refund').execute()
    expect(refunds, `manual match answered ${attempt}`).toHaveLength(1)
  })
})
