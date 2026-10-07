// Review finding 13: the webhook job (fetches the order, then runs the matcher) and the poll (stores the Transactions feed, then
// runs the matcher) are different pg-boss queues and can overlap. The webhook sees the order PAID with no transaction row yet
// and books it as the order-level arrival (idempotency key sqsp:<order>:payment:order); the poll books the same money as the
// transaction-level arrival (sqsp:<order>:payment:<txn>). Different keys, each decided on a snapshot taken before the other's
// event existed, and recordPayment does not re-check under the invoice lock: one payment is on the invoice twice.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { PaymentsService } from '../../src/modules/payments/commands.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { PgAlertSink } from '../../src/modules/payments-sync/db/alerts.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { MatchRunner } from '../../src/modules/payments-sync/match-runner.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'
import { ctxFor, makeUser, stubActor } from './helpers.js'

describe('webhook and poll for the same order', () => {
  const rig = useRig({ pageSize: 50 })

  it('the payment is on the invoice once, whichever of the two books it first', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'DET-SEDAN', kind: 'service' }]),
    )
    const customerId = await makeCustomer(r.db, env, { name: 'Liam Chen', email: 'liam@example.com', phone: '+13055550142' })
    const inv = await makeInvoice(r.db, env, { customerId, items: [{ name: 'Full Detail', priceCents: 18900 }] })
    const service = new PaymentsService({ clock: r.clock, newId: r.newId, ports: defaultPorts() })
    const rafael = await makeUser(r.db, r.newId, 'Rafael')
    await transaction(r.db, (tx) =>
      service.attachPaymentLink(tx, ctxFor(r.locationId, stubActor(rafael, { refund: null })), inv.id, {
        kind: 'balance',
        url: 'https://oasis-auto-spa.squarespace.com/checkout/inv',
      }),
    )
    r.advance(60_000)
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
    // the webhook job: the order is stored, the transactions are not yet
    await parts.engine.pollOrders()

    let overlapped = false
    const webhookLedger = {
      loadContext: async (q: Parameters<typeof parts.ledger.loadContext>[0]) => {
        const ctx = await parts.ledger.loadContext(q) // the webhook's snapshot: no event yet
        if (!overlapped) {
          overlapped = true
          // meanwhile the poll stores the feed and runs its own matcher to the end
          await parts.engine.pollTransactions()
          await parts.runner.run()
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
    const webhookRunner = new MatchRunner({
      orders: parts.repos.orders,
      transactions: parts.repos.transactions,
      ledger: webhookLedger,
      alerts: new PgAlertSink(r.db, { locationId: r.locationId, newId: r.newId, clock: r.clock }),
      clock: r.clock,
      productMap: parts.productMap,
      config: parts.matcher,
    })
    await webhookRunner.run()
    for (let i = 0; i < 2; i++) {
      r.advance(120_000)
      await r.rt.syncCycle(r.locationId)
    }
    const pays = await r.db
      .selectFrom('ledger_events')
      .select(['amount_cents', 'source', 'processor_ref'])
      .where('invoice_id', '=', inv.id)
      .where('type', '=', 'pay')
      .execute()
    expect(pays.reduce((a, e) => a + e.amount_cents, 0), JSON.stringify(pays)).toBe(20223)
    expect(pays).toHaveLength(1)
  })
})
