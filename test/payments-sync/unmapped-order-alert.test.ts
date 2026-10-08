// An order whose every product is unmapped is ignored (it is not a car wash: a gift card, merchandise) and now says so with an
// order_ignored_unmapped alert, once per order, so a product someone forgot to map does not vanish silently. With no product
// mapped at all, the single product_map_empty alert covers it instead of one alert per order.
import { describe, expect, it } from 'vitest'
import { InMemoryAlertSink, InMemoryLedger } from '../../src/modules/payments-sync/memory-ledger.js'
import { MatchRunner } from '../../src/modules/payments-sync/match-runner.js'
import { ProductMap } from '../../src/modules/payments-sync/product-map.js'
import { syncRig } from './helpers.js'

const mapped = new ProductMap([{ sku: 'DET-SEDAN', kind: 'service', label: 'Full Detail' }])

function world(map: ProductMap) {
  const r = syncRig({ pageSize: 50 })
  const alerts = new InMemoryAlertSink()
  const runner = new MatchRunner({
    orders: r.repos.orders,
    transactions: r.repos.transactions,
    ledger: new InMemoryLedger(),
    alerts,
    clock: r.clock,
    productMap: map,
  })
  const order = (sku: string, email: string) =>
    r.store.createOrder({
      email,
      lineItems: [{ sku, name: sku, unitCents: 2800 }],
      createdOn: new Date(r.clock.now().getTime() - 60_000),
    })
  const sync = async () => {
    r.clock.advance(1000)
    await r.engine.runCycle()
  }
  return { r, alerts, runner, order, sync }
}

describe('order_ignored_unmapped', () => {
  it('is raised for an order whose every product is unmapped, once', async () => {
    const w = world(mapped)
    const gift = w.order('GIFTCARD-50', 'gift@example.com')
    w.order('DET-SEDAN', 'liam.chen@example.com')
    await w.sync()
    const report = await w.runner.run()
    expect(report.ignored).toBe(1)
    const raised = w.alerts.alerts.filter((a) => a.code === 'order_ignored_unmapped')
    expect(raised).toEqual([
      expect.objectContaining({ code: 'order_ignored_unmapped', orderId: gift.orderId }),
    ])
    expect(raised[0]!.message).toContain('GIFTCARD-50')
    // a second pass does not look at the ignored order again
    await w.sync()
    await w.runner.run()
    expect(w.alerts.alerts.filter((a) => a.code === 'order_ignored_unmapped')).toHaveLength(1)
  })

  it('is not raised per order when nothing is mapped (product_map_empty says it once)', async () => {
    const w = world(new ProductMap())
    w.order('GIFTCARD-50', 'gift@example.com')
    w.order('TSHIRT-M', 'tee@example.com')
    await w.sync()
    await w.runner.run()
    expect(w.alerts.codes()).toEqual(['product_map_empty'])
  })
})
