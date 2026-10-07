// Review finding 6: two match runs overlap (the sqsp.sync cron, the sqsp.webhook.process job, the nightly sqsp.reconcile and
// "Sync now" all call MatchRunner.run). A PAID order whose transaction row has not been stored yet is matched at order level
// (idempotency key sqsp:<order>:payment:order); once the transaction is stored the same money is an arrival keyed on the
// transaction id. A run that loaded the ledger before the other wrote still records its arrival: recordPayment claims only
// its own key and does not look for money already recorded for the order, so one card payment becomes two pay events.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { PgAlertSink } from '../../src/modules/payments-sync/db/alerts.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { MatchRunner } from '../../src/modules/payments-sync/match-runner.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'

describe('two overlapping match runs over one paid order', () => {
  const rig = useRig({ pageSize: 50 })
  const line = { productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }

  it('record one payment, not two', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) => replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'DET-SEDAN', kind: 'service' }]))
    const customerId = await makeCustomer(r.db, env, { name: 'Liam Chen', email: 'liam@example.com', phone: '+13055550142' })
    const inv = await makeInvoice(r.db, env, { customerId, items: [{ name: 'Full Detail', priceCents: 18900 }] })
    await r.db
      .insertInto('payment_links')
      .values({ id: r.newId(), location_id: r.locationId, invoice_id: inv.id, url: 'https://oasis.squarespace.com/pay/x', expected_cents: 20223, sent_at: new Date(r.clock.now().getTime() - 5 * 60_000) })
      .execute()
    r.store.createOrder({ email: 'liam@example.com', name: 'Liam Chen', phone: '3055550142', lineItems: [line], taxCents: 1323 })

    r.advance(120_000)
    const parts = (await r.rt.partsFor(r.locationId))!
    await parts.engine.pollOrders() // the order is stored PAID; its transaction row is not stored yet

    let aLoaded!: () => void
    const aHasLoaded = new Promise<void>((res) => (aLoaded = res))
    let bLoaded!: () => void
    const bHasLoaded = new Promise<void>((res) => (bLoaded = res))
    const gate = (afterLoad: () => void, wait: Promise<void> | null) =>
      new Proxy(parts.ledger, {
        get(target, prop) {
          if (prop === 'loadContext')
            return async (q: Parameters<typeof target.loadContext>[0]) => {
              const ctx = await target.loadContext(q)
              afterLoad()
              if (wait) await wait
              return ctx
            }
          const v = Reflect.get(target, prop, target) as unknown
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
        },
      })
    const runner = (ledger: typeof parts.ledger) =>
      new MatchRunner({
        orders: parts.repos.orders,
        transactions: parts.repos.transactions,
        ledger,
        alerts: new PgAlertSink(r.db, { locationId: r.locationId, newId: r.newId, clock: r.clock }),
        clock: r.clock,
        productMap: parts.productMap,
        config: parts.matcher,
      })

    const runA = runner(gate(aLoaded, bHasLoaded)).run() // sees the order only
    await aHasLoaded
    await parts.engine.pollTransactions() // the transaction row lands while A is between loading and writing
    const runB = runner(gate(bLoaded, null)).run() // sees the order and its transaction
    await Promise.all([runA, runB])

    const pays = await r.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', inv.id).where('type', '=', 'pay').execute()
    expect(pays).toHaveLength(1)
    expect(await r.db.selectFrom('invoice_calc').select(['paid', 'balance']).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow()).toMatchObject({ paid: 20223, balance: 0 })
  })
})
