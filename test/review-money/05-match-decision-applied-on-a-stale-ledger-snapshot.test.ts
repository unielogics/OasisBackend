// Review finding 5: the matcher decides on a ledger snapshot (loadContext) and applies the decision later without looking
// again. recordPayment (rule 2, payment link) locks the invoice but never re-checks it, so a card payment the cashier records
// between the snapshot and the apply is counted next to the Squarespace order for the same money: paid = 2 x total.
// (Collect is guarded by the balance under the invoice lock; the sync's pay is not.)
import { describe, expect, it } from 'vitest'
import { PgAlertSink } from '../../src/modules/payments-sync/db/alerts.js'
import { MatchRunner } from '../../src/modules/payments-sync/match-runner.js'
import { PaymentsService } from '../../src/modules/payments/commands.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'
import { ctxFor, makeUser, stubActor } from './helpers.js'

describe('the sync does not double count money the cashier recorded while it was deciding', () => {
  const rig = useRig({ pageSize: 50 })

  it('a card payment recorded after the matcher loaded its snapshot and before it applied a link match', async () => {
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
    const service = new PaymentsService({ clock: r.clock, newId: r.newId, ports: defaultPorts() })
    const rafael = await makeUser(r.db, r.newId, 'Rafael')
    const actor = stubActor(rafael, { refund: null, adjust: null, credit: null })

    // a payment link for the whole balance is out
    await transaction(r.db, (tx) =>
      service.attachPaymentLink(tx, ctxFor(r.locationId, actor), inv.id, {
        kind: 'balance',
        url: 'https://oasis-auto-spa.squarespace.com/checkout/inv',
      }),
    )
    r.advance(60_000)

    // the customer pays through the link: the order reaches Oasis
    r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
    })
    r.advance(120_000)
    const parts = await r.rt.partsFor(r.locationId)
    if (!parts) throw new Error('runtime not configured')
    await parts.engine.runCycle()

    // ...and at the same moment the cashier taps Collect > Card for the same invoice
    let raced = false
    const racing = {
      loadContext: async (q: Parameters<typeof parts.ledger.loadContext>[0]) => {
        const ctx = await parts.ledger.loadContext(q)
        if (!raced) {
          raced = true
          await transaction(r.db, (tx) =>
            service.collect(tx, ctxFor(r.locationId, actor), inv.id, { method: 'card' }),
          )
        }
        return ctx
      },
      confirmAwaitingEvent: parts.ledger.confirmAwaitingEvent.bind(parts.ledger),
      attachProcessorRefs: parts.ledger.attachProcessorRefs.bind(parts.ledger),
      recordProcessorPayment: parts.ledger.recordProcessorPayment.bind(parts.ledger),
      confirmRefundEvent: parts.ledger.confirmRefundEvent.bind(parts.ledger),
      recordExternalRefund: parts.ledger.recordExternalRefund.bind(parts.ledger),
      enqueueManual: parts.ledger.enqueueManual.bind(parts.ledger),
    }
    const runner = new MatchRunner({
      orders: parts.repos.orders,
      transactions: parts.repos.transactions,
      ledger: racing,
      alerts: new PgAlertSink(r.db, { locationId: r.locationId, newId: r.newId, clock: r.clock }),
      clock: r.clock,
      productMap: parts.productMap,
      config: parts.matcher,
    })
    await runner.run()
    // the next normal cycles settle whatever is left
    for (let i = 0; i < 2; i++) {
      r.advance(120_000)
      await r.rt.syncCycle(r.locationId)
    }

    const calc = await r.db
      .selectFrom('ledger_events')
      .select(['type', 'amount_cents', 'source', 'processor_state'])
      .where('invoice_id', '=', inv.id)
      .where('type', '=', 'pay')
      .execute()
    const paid = calc.reduce((a, e) => a + e.amount_cents, 0)
    expect(paid, JSON.stringify(calc)).toBeLessThanOrEqual(20223)
  })
})
