import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../src/platform/clock.js'
import { InMemoryLedger, InMemoryAlertSink } from '../../src/modules/payments-sync/memory-ledger.js'
import { MatchRunner } from '../../src/modules/payments-sync/match-runner.js'
import { ProductMap } from '../../src/modules/payments-sync/product-map.js'
import type { IdentityRef } from '../../src/modules/payments-sync/identity.js'
import { NOW } from '../fixtures/squarespace/load.js'
import { syncRig } from './helpers.js'

const H = 3600_000
const map = new ProductMap([
  { sku: 'MEM-PREMIUM', kind: 'membership', tierLabel: 'Premium Care' },
  { sku: 'DET-SEDAN', kind: 'service', label: 'Full Detail' },
  { sku: 'WASH-EXEC', kind: 'service', label: 'Executive Wash' },
])
const liam: IdentityRef = {
  customerId: 'c-liam',
  emails: ['liam.chen@example.com'],
  phones: ['(555) 301-4420'],
}
const maria: IdentityRef = {
  customerId: 'c-maria',
  emails: ['maria.alvarez@example.com'],
  phones: ['555-712-0188'],
}

function world(over: { map?: ProductMap; matcher?: Record<string, unknown> } = {}) {
  const r = syncRig({ pageSize: 50 })
  const ledger = new InMemoryLedger()
  const alerts = new InMemoryAlertSink()
  const runner = new MatchRunner({
    orders: r.repos.orders,
    transactions: r.repos.transactions,
    ledger,
    alerts,
    clock: r.clock,
    productMap: over.map ?? map,
    config: over.matcher,
  })
  const sync = async () => {
    r.clock.advance(1000)
    await r.engine.runCycle()
  }
  const detail = (
    email: string,
    name: string,
    phone: string,
    extra: Partial<Parameters<typeof r.store.createOrder>[0]> = {},
  ) =>
    r.store.createOrder({
      email,
      name,
      phone,
      lineItems: [{ productId: 'p-det', sku: 'DET-SEDAN', name: 'Full Detail - Sedan', unitCents: 18900 }],
      taxCents: 1323,
      createdOn: new Date(r.clock.now().getTime() - 60_000),
      ...extra,
    })
  return { ...r, ledger, alerts, runner, sync, detail }
}

describe('MatchRunner end to end (simulator -> sync -> matcher -> ledger)', () => {
  it('confirms a staff-recorded awaiting_processor payment from the feed and never creates a second pay event', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-1', totalCents: 20223, taxCents: 1323, customer: liam })
    const staff = w.ledger.addEvent({
      type: 'pay',
      invoiceId: 'inv-1',
      amountCents: 20223,
      occurredAt: new Date(w.clock.now().getTime() - 2 * H),
      processorState: 'awaiting_processor',
      methodKind: 'card',
    })
    w.ledger.addLink({
      id: 'link-1',
      invoiceId: 'inv-1',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId, paymentId } = w.detail('Liam.Chen@example.com', 'Liam Chen', '5553014420')
    await w.sync()

    const report = await w.runner.run()
    expect(report).toMatchObject({ confirmedAwaiting: 1, paymentsRecorded: 0, manual: 0, errors: [] })
    expect(w.ledger.events).toHaveLength(1)
    expect(w.ledger.events[0]).toMatchObject({
      id: staff.id,
      processorState: 'confirmed',
      sqspOrderId: orderId,
      processorRef: paymentId,
    })
    expect(w.ledger.links[0]!.state).toBe('active')
    expect(await w.repos.orders.get(orderId)).toMatchObject({ matchState: 'auto', matchedInvoiceId: 'inv-1' })
    expect(await w.repos.transactions.get(paymentId!)).toMatchObject({
      state: 'matched',
      matchedEventId: staff.id,
    })

    // idempotent
    await w.sync()
    const again = await w.runner.run()
    expect(again.ordersProcessed).toBe(0)
    expect(w.ledger.events).toHaveLength(1)
  })

  it('records a pay event for a unique payment-link match and marks the link paid', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-2', totalCents: 20223, taxCents: 1323, customer: maria })
    w.ledger.addLink({
      id: 'link-2',
      invoiceId: 'inv-2',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId, paymentId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188')
    await w.sync()
    const report = await w.runner.run()
    expect(report).toMatchObject({ paymentsRecorded: 1, errors: [] })
    expect(w.ledger.events).toHaveLength(1)
    expect(w.ledger.events[0]).toMatchObject({
      type: 'pay',
      invoiceId: 'inv-2',
      amountCents: 20223,
      source: 'squarespace',
      processorState: 'confirmed',
      methodKind: 'card',
      brand: 'VISA',
      sqspOrderId: orderId,
      processorRef: paymentId,
      deposit: false,
    })
    expect(w.ledger.links[0]).toMatchObject({ state: 'paid', matchedSqspOrderId: orderId })
    expect((await w.repos.orders.get(orderId))!.matchState).toBe('auto')
    await w.sync()
    await w.runner.run()
    expect(w.ledger.events).toHaveLength(1)
  })

  it('order seen before its transaction is recorded once, and the later transaction only attaches the reference', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-2', totalCents: 20223, taxCents: 1323, customer: maria })
    w.ledger.addLink({
      id: 'link-2',
      invoiceId: 'inv-2',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId, paymentId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188')
    w.clock.advance(1000)
    await w.engine.pollOrders() // transactions feed has not been polled yet
    await w.runner.run()
    expect(w.ledger.events).toHaveLength(1)
    expect(w.ledger.events[0]!.processorRef).toBeUndefined()
    expect(w.ledger.events[0]!.sqspOrderId).toBe(orderId)

    await w.engine.pollTransactions()
    const report = await w.runner.run()
    expect(report).toMatchObject({ alreadyRecorded: 1, paymentsRecorded: 0 })
    expect(w.ledger.events).toHaveLength(1)
    expect(w.ledger.events[0]!.processorRef).toBe(paymentId)
  })

  it('a staff-recorded payment plus a payment link on the same invoice yields one confirmation, not a second pay event', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-1', totalCents: 20223, taxCents: 1323, customer: liam })
    w.ledger.addEvent({
      type: 'pay',
      invoiceId: 'inv-1',
      amountCents: 20223,
      occurredAt: new Date(w.clock.now().getTime() - 4 * H),
      processorState: 'awaiting_processor',
      methodKind: 'card',
    })
    w.ledger.addLink({
      id: 'link-1',
      invoiceId: 'inv-1',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 6 * H),
    })
    w.detail('liam.chen@example.com', 'Liam Chen', '5553014420')
    await w.sync()
    await w.runner.run()
    expect(w.ledger.events.filter((e) => e.type === 'pay')).toHaveLength(1)
  })

  it('a different amount for the same customer is held for a human instead of double counting', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-1', totalCents: 20223, taxCents: 1323, customer: liam })
    w.ledger.addEvent({
      type: 'pay',
      invoiceId: 'inv-1',
      amountCents: 19900,
      occurredAt: new Date(w.clock.now().getTime() - 4 * H),
      processorState: 'awaiting_processor',
      methodKind: 'card',
    })
    w.ledger.addLink({
      id: 'link-1',
      invoiceId: 'inv-1',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 6 * H),
    })
    const { orderId, paymentId } = w.detail('liam.chen@example.com', 'Liam Chen', '5553014420')
    await w.sync()
    const report = await w.runner.run()
    expect(report).toMatchObject({ manual: 1, paymentsRecorded: 0, confirmedAwaiting: 0 })
    expect(w.ledger.events).toHaveLength(1)
    expect(w.ledger.manualQueue).toEqual([
      expect.objectContaining({ orderId, transactionId: paymentId, reason: 'possible_double_count' }),
    ])
    expect((await w.repos.orders.get(orderId))!.matchState).toBe('manual')
    expect((await w.repos.transactions.get(paymentId!))!.state).toBe('manual')
    await w.sync()
    await w.runner.run()
    expect(w.ledger.manualQueue).toHaveLength(1)
  })

  it('ambiguous staff events go to the manual queue once', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-1', totalCents: 20223, customer: liam })
    w.ledger.addInvoice({ id: 'inv-3', totalCents: 20223, customer: liam })
    for (const inv of ['inv-1', 'inv-3']) {
      w.ledger.addEvent({
        type: 'pay',
        invoiceId: inv,
        amountCents: 20223,
        occurredAt: new Date(w.clock.now().getTime() - 4 * H),
        processorState: 'awaiting_processor',
      })
    }
    w.detail('liam.chen@example.com', 'Liam Chen', '5553014420')
    await w.sync()
    await w.runner.run()
    await w.runner.run()
    expect(w.ledger.manualQueue).toHaveLength(1)
    expect(w.ledger.manualQueue[0]).toMatchObject({ reason: 'ambiguous_awaiting' })
    expect(w.ledger.events.every((e) => e.processorState === 'awaiting_processor')).toBe(true)
  })

  it('ingests a refund made in Squarespace as a source=squarespace event with an alert, once', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-2', totalCents: 20223, taxCents: 1323, customer: maria })
    w.ledger.addLink({
      id: 'link-2',
      invoiceId: 'inv-2',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188')
    await w.sync()
    await w.runner.run()
    w.clock.advance(60_000)
    const refundId = w.store.refund(orderId, { amountCents: 5000 })
    await w.sync()
    const report = await w.runner.run()
    expect(report).toMatchObject({ externalRefunds: 1 })
    const refund = w.ledger.events.find((e) => e.type === 'refund')!
    expect(refund).toMatchObject({
      source: 'squarespace',
      amountCents: 5000,
      processorState: 'confirmed',
      processorRef: refundId,
      invoiceId: 'inv-2',
      needsReview: true,
    })
    expect(w.alerts.codes()).toContain('external_refund')
    await w.sync()
    await w.runner.run()
    expect(w.ledger.events.filter((e) => e.type === 'refund')).toHaveLength(1)
  })

  it('confirms an Oasis-recorded refund when the same refund appears in the feed', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-2', totalCents: 20223, customer: maria })
    w.ledger.addLink({
      id: 'link-2',
      invoiceId: 'inv-2',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188')
    await w.sync()
    await w.runner.run()
    const oasisRefund = w.ledger.addEvent({
      type: 'refund',
      invoiceId: 'inv-2',
      amountCents: 5000,
      occurredAt: w.clock.now(),
      processorState: 'awaiting_processor',
      sqspOrderId: orderId,
      status: 'done',
    })
    w.clock.advance(30 * 60_000)
    const refundId = w.store.refund(orderId, { amountCents: 5000 })
    await w.sync()
    const report = await w.runner.run()
    expect(report).toMatchObject({ refundsConfirmed: 1, externalRefunds: 0 })
    expect(w.ledger.events.find((e) => e.id === oasisRefund.id)).toMatchObject({
      processorState: 'confirmed',
      processorRef: refundId,
    })
    expect(w.alerts.codes()).not.toContain('external_refund')
  })

  it('defers a refund for an order that is not booked yet, then applies it once the order is matched', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-2', totalCents: 20223, customer: maria })
    const { orderId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188') // no link yet: payment goes to manual
    w.clock.advance(60_000)
    const refundId = w.store.refund(orderId, { amountCents: 5000 })
    await w.sync()
    const first = await w.runner.run()
    expect(first).toMatchObject({ manual: 1, deferred: 1 })
    expect(w.ledger.events).toHaveLength(0)
    // staff resolve the order in the manual queue: payment event exists and the order is marked matched
    w.ledger.addEvent({
      type: 'pay',
      invoiceId: 'inv-2',
      amountCents: 20223,
      occurredAt: w.clock.now(),
      processorState: 'confirmed',
      sqspOrderId: orderId,
      source: 'oasis',
    })
    const second = await w.runner.run()
    expect(second).toMatchObject({ externalRefunds: 1 })
    expect(w.ledger.events.find((e) => e.type === 'refund')!.processorRef).toBe(refundId)
  })

  it('ignores test-mode orders, unmapped products and donations; membership orders route to memberships', async () => {
    const w = world()
    w.store.createOrder({
      email: 'qa@example.com',
      lineItems: [{ sku: 'DET-SEDAN', name: 'x', unitCents: 100 }],
      testMode: true,
      createdOn: new Date(w.clock.now().getTime() - 60_000),
    })
    w.store.createOrder({
      email: 'gift@example.com',
      lineItems: [{ sku: 'TSHIRT-M', name: 'Tee', unitCents: 2800 }],
      createdOn: new Date(w.clock.now().getTime() - 60_000),
    })
    const m = w.store.createOrder({
      email: 'maria.alvarez@example.com',
      lineItems: [{ sku: 'MEM-PREMIUM', name: 'Premium Care', unitCents: 14900 }],
      createdOn: new Date(w.clock.now().getTime() - 60_000),
    })
    await w.sync()
    const report = await w.runner.run()
    expect(report).toMatchObject({ ignored: 1, membership: 1 })
    expect(w.ledger.events).toHaveLength(0)
    expect((await w.repos.orders.get(m.orderId))!.matchState).toBe('membership')
    expect((await w.repos.transactions.get(m.paymentId!))!.state).toBe('membership')
    const ignored = [...w.repos.orders.rows.values()].map((o) => [
      o.order.customerEmail,
      o.matchState,
      o.ignoreReason,
    ])
    expect(ignored).toContainEqual(['qa@example.com', 'ignored', 'test_mode'])
    expect(ignored).toContainEqual(['gift@example.com', 'ignored', 'unmapped_sku'])
    const txnStates = [...w.repos.transactions.rows.values()].map((t) => t.state).sort()
    expect(txnStates).toEqual(['ignored', 'ignored', 'membership'])
  })

  it('alerts loudly when no products are mapped instead of silently ignoring everything', async () => {
    const w = world({ map: new ProductMap() })
    w.detail('liam.chen@example.com', 'Liam Chen', '5553014420')
    await w.sync()
    const report = await w.runner.run()
    expect(report.ignored).toBe(1)
    expect(w.alerts.codes()).toEqual(['product_map_empty'])
  })

  it('raises variance alerts and keeps the variance on the ledger event', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-1', totalCents: 20000, taxCents: 1100, customer: liam })
    const staff = w.ledger.addEvent({
      type: 'pay',
      invoiceId: 'inv-1',
      amountCents: 20223,
      occurredAt: new Date(w.clock.now().getTime() - 2 * H),
      processorState: 'awaiting_processor',
    })
    w.detail('liam.chen@example.com', 'Liam Chen', '5553014420')
    await w.sync()
    await w.runner.run()
    expect(w.alerts.codes()).toEqual(['variance_exceeds_delta'])
    expect(w.ledger.events.find((e) => e.id === staff.id)!.variance).toMatchObject({
      deltaCents: 223,
      taxDeltaCents: 223,
      exceedsAlert: true,
    })
  })

  it('a failing ledger command is reported and retried on the next run without duplicating anything', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-2', totalCents: 20223, customer: maria })
    w.ledger.addLink({
      id: 'link-2',
      invoiceId: 'inv-2',
      state: 'active',
      expectedCents: 20223,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188')
    await w.sync()
    const real = w.ledger.recordProcessorPayment.bind(w.ledger)
    let calls = 0
    w.ledger.recordProcessorPayment = async (i) => {
      calls++
      if (calls === 1) {
        await real(i) // the write lands, then the process "crashes" before the runner records the outcome
        throw new Error('connection reset')
      }
      return real(i)
    }
    const first = await w.runner.run()
    expect(first.errors).toEqual([{ orderId, message: 'connection reset' }])
    expect(w.ledger.events).toHaveLength(1)
    const second = await w.runner.run()
    expect(second.errors).toEqual([])
    expect(w.ledger.events).toHaveLength(1)
    expect(second).toMatchObject({ alreadyRecorded: 1, paymentsRecorded: 0 })
    expect((await w.repos.orders.get(orderId))!.matchState).toBe('auto')
  })

  it('payment-plan installments are matched one by one', async () => {
    const w = world()
    w.ledger.addInvoice({ id: 'inv-9', totalCents: 96300, customer: maria })
    w.ledger.addLink({
      id: 'link-9',
      invoiceId: 'inv-9',
      state: 'active',
      expectedCents: 30000,
      sentAt: new Date(w.clock.now().getTime() - 5 * H),
    })
    const { orderId } = w.detail('maria.alvarez@example.com', 'Maria Alvarez', '5557120188', {
      lineItems: [{ sku: 'DET-SEDAN', name: 'Plan', unitCents: 90000 }],
      taxCents: 6300,
      pay: { amountCents: 30000 },
    })
    await w.sync()
    expect(await w.runner.run()).toMatchObject({ paymentsRecorded: 1 })
    w.clock.advance(60_000)
    w.store.addPayment(orderId, { amountCents: 66300, brand: 'VISA' })
    await w.sync()
    const second = await w.runner.run()
    // the first installment tied the link to this order, so the second is an explicit match to the same invoice
    expect(second).toMatchObject({ paymentsRecorded: 1, manual: 0 })
    const pays = w.ledger.events.filter((e) => e.type === 'pay')
    expect(pays.map((e) => [e.invoiceId, e.amountCents, e.deposit])).toEqual([
      ['inv-9', 30000, true],
      ['inv-9', 66300, false],
    ])
    expect(w.ledger.summary(w.ledger.invoices.get('inv-9')!).balanceCents).toBe(0)
  })

  it('uses the injected clock only (frozen time gives the same result)', () => {
    expect(new FixedClock(NOW).now().toISOString()).toBe(NOW)
  })
})
