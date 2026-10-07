// Review finding 4: the matcher pairs a feed refund with the staff refund waiting on Squarespace only when the two are within
// 48 h of the staff event's occurred_at, and occurred_at is the time the refund was REQUESTED (an approval never changes it,
// ADR 0050). A refund that waited more than 48 h for its approver (requested Tuesday, approved and refunded in Squarespace on
// Friday) is therefore never paired: the feed refund is ingested as an "external refund" on top of the approved one. The invoice
// is refunded twice for one real refund and the approved event stays awaiting_processor forever.
import { describe, expect, it } from 'vitest'
import { PaymentsService } from '../../src/modules/payments/commands.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { transaction } from '../../src/platform/db.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { H, useRig } from '../payments-sync-db/harness.js'
import { ctxFor, makeUser, stubActor } from './helpers.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'

describe('a refund approved late is still the same refund when Squarespace shows it', () => {
  const rig = useRig({ pageSize: 50 })

  it('confirms the approved staff refund instead of ingesting a second, external one', async () => {
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
    const inv = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
    })

    // the original card payment, confirmed from Squarespace
    const order = r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
    })
    await addEvent(r.db, env, inv, {
      type: 'pay',
      amountCents: 20223,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'confirmed',
      at: r.clock.now(),
    })
    await r.db
      .updateTable('ledger_events')
      .set({ sqsp_order_id: order.orderId, processor_ref: order.paymentId ?? null })
      .where('invoice_id', '=', inv.id)
      .execute()
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)

    // Sofia (refund limit $50) requests $60.00 to card on Tuesday: it waits for approval
    const service = new PaymentsService({ clock: r.clock, newId: r.newId, ports: defaultPorts() })
    const sofia = await makeUser(r.db, r.newId, 'Sofia')
    const rafael = await makeUser(r.db, r.newId, 'Rafael')
    const requested = await transaction(r.db, (tx) =>
      service.refund(tx, ctxFor(r.locationId, stubActor(sofia, { refund: 5000 })), inv.id, {
        mode: 'custom',
        amountCents: 6000,
        dest: 'card',
      }),
    )
    expect(requested.event.status).toBe('pending')

    // approved on Friday (72 h later), refunded in Squarespace right after
    r.advance(72 * H)
    await transaction(r.db, (tx) =>
      service.approveRefund(
        tx,
        ctxFor(r.locationId, stubActor(rafael, { refund: 100000 })),
        inv.id,
        requested.event.id,
      ),
    )
    r.advance(10 * 60_000)
    r.store.refund(order.orderId, { amountCents: 6000, refundedOn: r.clock.now() })
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)

    const refunds = await r.db
      .selectFrom('ledger_events')
      .select(['id', 'amount_cents', 'source', 'processor_state'])
      .where('invoice_id', '=', inv.id)
      .where('type', '=', 'refund')
      .execute()
    expect(refunds).toEqual([
      { id: requested.event.id, amount_cents: 6000, source: 'oasis', processor_state: 'confirmed' },
    ])
  })
})
