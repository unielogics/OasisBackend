import { describe, expect, it } from 'vitest'
import {
  arrivalsForOrder,
  findOverdueAwaiting,
  isAutoApplicable,
  matchArrival,
  matchArrivals,
  planOrder,
  type MatchDecision,
} from '../../src/modules/payments-sync/matcher.js'
import { ProductMap } from '../../src/modules/payments-sync/product-map.js'
import { mapOrder, mapTransactionDocument } from '../../src/integrations/squarespace/mappers.js'
import { fixture } from '../fixtures/squarespace/load.js'
import { H, T0, arrival, cfg, ctx, event, invoice, liam, link, maria, nobody } from './matcher-helpers.js'

const kind = (d: MatchDecision) => d.kind

describe('rule 0: money already recorded is never recorded twice', () => {
  it('recognises the processor reference', () => {
    const d = matchArrival(
      arrival(),
      ctx({ events: [event({ processorState: 'confirmed', processorRef: 'txn-1', sqspOrderId: 'ord-1' })] }),
      cfg(),
    )
    expect(d).toMatchObject({
      kind: 'already_recorded',
      eventId: 'ev-1',
      attachProcessorRef: false,
      attachSqspOrderId: false,
      rule: 'recorded',
    })
    expect(d.confidence.score).toBe(1)
  })

  it('recognises an order-level pay event when the transaction shows up later, and asks to attach the reference', () => {
    const d = matchArrival(
      arrival(),
      ctx({ events: [event({ processorState: 'confirmed', source: 'squarespace', sqspOrderId: 'ord-1' })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'already_recorded', attachProcessorRef: true, attachSqspOrderId: false })
  })

  it('an order-level arrival matches an existing event for the same order and amount', () => {
    const d = matchArrival(
      arrival({ source: 'order', transactionId: undefined }),
      ctx({ events: [event({ processorState: 'confirmed', sqspOrderId: 'ord-1' })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'already_recorded', attachProcessorRef: false })
  })

  it('does not treat a different amount on the same order, or a denied event, as recorded', () => {
    const other = matchArrival(
      arrival(),
      ctx({ events: [event({ processorState: 'confirmed', sqspOrderId: 'ord-1', amountCents: 100 })] }),
      cfg(),
    )
    expect(other.kind).not.toBe('already_recorded')
    const denied = matchArrival(
      arrival(),
      ctx({ events: [event({ processorState: 'confirmed', processorRef: 'txn-1', status: 'denied' })] }),
      cfg(),
    )
    expect(denied.kind).not.toBe('already_recorded')
  })

  it('applies to refunds by reference too', () => {
    const d = matchArrival(
      arrival({ kind: 'refund', transactionId: 'rf-1', amountCents: 2000 }),
      ctx({
        events: [
          event({
            type: 'refund',
            amountCents: 2000,
            processorState: 'confirmed',
            processorRef: 'rf-1',
            source: 'squarespace',
          }),
        ],
      }),
      cfg(),
    )
    expect(d.kind).toBe('already_recorded')
  })
})

describe('rule 1: staff-recorded awaiting_processor event', () => {
  it('confirms a unique same-customer equal-amount event within 48 h', () => {
    const d = matchArrival(arrival(), ctx({ events: [event()] }), cfg())
    expect(d).toMatchObject({
      kind: 'confirm_awaiting',
      eventId: 'ev-1',
      invoiceId: 'inv-1',
      rule: 'awaiting',
    })
    expect(d.confidence).toEqual({ score: 1, level: 'high' })
    expect(isAutoApplicable(d, cfg())).toBe(true)
  })

  it.each([
    ['email only (case-insensitive)', { email: 'MARIA.ALVAREZ@EXAMPLE.COM', phone: undefined }, 0.95],
    ['phone only, other formatting', { email: undefined, phone: '+1 555 712 0188' }, 0.9],
    [
      'Squarespace customer id',
      { email: undefined, phone: undefined, sqspCustomerId: '64e0c0000000000000000001' },
      1,
    ],
    ['email and phone', {}, 1],
  ])('identity via %s', (_n, over, score) => {
    const d = matchArrival(arrival(over), ctx({ events: [event()] }), cfg())
    expect(d.kind).toBe('confirm_awaiting')
    expect(d.confidence.score).toBe(score)
  })

  it.each([
    ['exactly 48 h before', -48 * H, 'confirm_awaiting', 0.9],
    ['48 h and 1 minute before', -48 * H - 60_000, 'manual_queue', undefined],
    ['staff recorded 1 h after the customer paid', 1 * H, 'confirm_awaiting', 1],
    ['recorded 30 h before', -30 * H, 'confirm_awaiting', 0.9],
  ])('time window: %s', (_n, offset, expected, score) => {
    const d = matchArrival(
      arrival(),
      ctx({ events: [event({ occurredAt: new Date(T0.getTime() + offset) })] }),
      cfg(),
    )
    expect(d.kind).toBe(expected)
    if (score) expect(d.confidence.score).toBe(score)
  })

  it('a 1 cent difference is not "equal amount"', () => {
    const d = matchArrival(arrival(), ctx({ events: [event({ amountCents: 20222 })] }), cfg())
    expect(d.kind).not.toBe('confirm_awaiting')
  })

  it('two equal candidates for the same customer are ambiguous: manual, and no link auto-record', () => {
    const d = matchArrival(
      arrival(),
      ctx({ events: [event(), event({ id: 'ev-2' })], links: [link()] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'manual_queue', reason: 'ambiguous_awaiting' })
    if (d.kind === 'manual_queue') expect(d.candidates.map((c) => c.id).sort()).toEqual(['ev-1', 'ev-2'])
  })

  it('an equal amount for a different customer is only a suggestion: manual, and rule 2 does not run', () => {
    const d = matchArrival(arrival(), ctx({ events: [event({ customer: liam })], links: [link()] }), cfg())
    expect(d).toMatchObject({ kind: 'manual_queue', reason: 'low_confidence' })
  })

  it('ignores denied events and events already consumed by an earlier arrival', () => {
    expect(matchArrival(arrival(), ctx({ events: [event({ status: 'denied' })] }), cfg()).kind).not.toBe(
      'confirm_awaiting',
    )
    const d = matchArrival(arrival(), ctx({ events: [event()] }), cfg(), new Set(['ev-1']))
    expect(d.kind).toBe('manual_queue')
  })

  it('an event the staff attached to this Squarespace order matches without any identity', () => {
    const d = matchArrival(
      arrival({ email: undefined, phone: undefined }),
      ctx({ events: [event({ sqspOrderId: 'ord-1', customer: nobody })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'confirm_awaiting' })
    expect(d.confidence.score).toBe(1)
  })

  it('never auto-confirms below the threshold: raising it turns the same match into a manual queue item', () => {
    const d = matchArrival(
      arrival({ phone: undefined }),
      ctx({ events: [event()] }),
      cfg({ confidenceThreshold: 0.96 }),
    )
    expect(d).toMatchObject({ kind: 'manual_queue', reason: 'low_confidence' })
    expect(isAutoApplicable(d, cfg())).toBe(false)
  })

  it('records the tax/fee variance against the Oasis invoice and alerts only past the delta', () => {
    const within = matchArrival(
      arrival({ orderTotalCents: 20263, orderTaxCents: 1363 }),
      ctx({ events: [event()] }),
      cfg(),
    )
    expect(within.variance).toEqual({
      sqspTotalCents: 20263,
      oasisTotalCents: 20223,
      deltaCents: 40,
      sqspTaxCents: 1363,
      oasisTaxCents: 1323,
      taxDeltaCents: 40,
      exceedsAlert: false,
    })
    expect(within.alerts).toEqual([])
    const over = matchArrival(arrival({ orderTotalCents: 20423 }), ctx({ events: [event()] }), cfg())
    expect(over.variance).toMatchObject({ deltaCents: 200, exceedsAlert: true })
    expect(over.alerts).toEqual(['variance_exceeds_delta'])
    const tighter = matchArrival(
      arrival({ orderTotalCents: 20263 }),
      ctx({ events: [event()] }),
      cfg({ varianceAlertCents: 10 }),
    )
    expect(tighter.alerts).toEqual(['variance_exceeds_delta'])
  })
})

describe('rule 2: payment link on an invoice', () => {
  it('creates a pay event for exactly one matching link', () => {
    const d = matchArrival(arrival(), ctx({ links: [link()] }), cfg())
    expect(d).toMatchObject({
      kind: 'create_payment',
      invoiceId: 'inv-1',
      paymentLinkId: 'link-1',
      deposit: false,
      rule: 'link',
    })
    expect(d.confidence.score).toBe(0.95)
  })

  it('phone-only identity scores lower but still passes the default threshold', () => {
    const d = matchArrival(arrival({ email: undefined }), ctx({ links: [link()] }), cfg())
    expect(d.kind).toBe('create_payment')
    expect(d.confidence.score).toBe(0.85)
  })

  it('amount tolerance: 1 cent by default, widened by cents or basis points', () => {
    const near = matchArrival(arrival({ amountCents: 20224 }), ctx({ links: [link()] }), cfg())
    expect(near.kind).toBe('create_payment')
    expect(near.confidence.score).toBe(0.9)
    expect(matchArrival(arrival({ amountCents: 20225 }), ctx({ links: [link()] }), cfg()).kind).toBe(
      'manual_queue',
    )
    expect(
      matchArrival(
        arrival({ amountCents: 20300 }),
        ctx({ links: [link()] }),
        cfg({ linkAmountToleranceCents: 100 }),
      ).kind,
    ).toBe('create_payment')
    expect(
      matchArrival(
        arrival({ amountCents: 20400 }),
        ctx({ links: [link()] }),
        cfg({ linkAmountToleranceBp: 100 }),
      ).kind,
    ).toBe('create_payment')
    expect(
      matchArrival(
        arrival({ amountCents: 20500 }),
        ctx({ links: [link()] }),
        cfg({ linkAmountToleranceBp: 100 }),
      ).kind,
    ).toBe('manual_queue')
  })

  it.each([
    ['before the link was sent', -3 * 86400_000, 'manual_queue'],
    ['13 days after', 13 * 86400_000, 'create_payment'],
    ['15 days after', 15 * 86400_000, 'manual_queue'],
  ])('window: %s', (_n, offsetFromSent, expected) => {
    const sentAt = new Date(T0.getTime() - 2 * 86400_000)
    const d = matchArrival(
      arrival({ occurredAt: new Date(sentAt.getTime() + offsetFromSent) }),
      ctx({ links: [link({ sentAt })] }),
      cfg(),
    )
    expect(d.kind).toBe(expected)
  })

  it('an expired link only matches up to its expiry; paid and canceled links never match', () => {
    const sentAt = new Date(T0.getTime() - 2 * 86400_000)
    expect(
      matchArrival(
        arrival(),
        ctx({ links: [link({ sentAt, expiresAt: new Date(T0.getTime() - H) })] }),
        cfg(),
      ).kind,
    ).toBe('manual_queue')
    expect(matchArrival(arrival(), ctx({ links: [link({ state: 'paid' })] }), cfg()).kind).toBe(
      'manual_queue',
    )
    expect(matchArrival(arrival(), ctx({ links: [link({ state: 'canceled' })] }), cfg()).kind).toBe(
      'manual_queue',
    )
    expect(
      matchArrival(arrival(), ctx({ links: [link({ invoice: invoice({ canceled: true }) })] }), cfg()).kind,
    ).toBe('manual_queue')
  })

  it('two candidate links for the same customer are ambiguous', () => {
    const d = matchArrival(
      arrival(),
      ctx({ links: [link(), link({ id: 'link-2', invoiceId: 'inv-2', invoice: invoice({ id: 'inv-2' }) })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'manual_queue', reason: 'ambiguous_link' })
  })

  it('another customer’s link with the same amount does not make it ambiguous', () => {
    const other = link({
      id: 'link-2',
      invoiceId: 'inv-2',
      customer: liam,
      invoice: invoice({ id: 'inv-2' }),
    })
    const d = matchArrival(arrival(), ctx({ links: [link(), other] }), cfg())
    expect(d).toMatchObject({ kind: 'create_payment', paymentLinkId: 'link-1' })
  })

  it('a staff-attached Squarespace order number is an explicit match (score 1, no identity needed)', () => {
    const d = matchArrival(
      arrival({ email: undefined, phone: undefined }),
      ctx({ links: [link({ matchedSqspOrderId: 'ord-1', customer: nobody })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'create_payment', paymentLinkId: 'link-1' })
    expect(d.confidence.score).toBe(1)
  })

  it('no customer identity on the order (point of sale) never auto-matches a link, but suggests it', () => {
    const d = matchArrival(arrival({ email: undefined, phone: undefined }), ctx({ links: [link()] }), cfg())
    expect(d).toMatchObject({ kind: 'manual_queue', reason: 'no_candidate' })
    if (d.kind === 'manual_queue')
      expect(d.candidates).toEqual([expect.objectContaining({ kind: 'link', id: 'link-1' })])
  })

  it('a partial payment is flagged as a deposit', () => {
    const d = matchArrival(
      arrival({ amountCents: 10000 }),
      ctx({ links: [link({ expectedCents: 10000 })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'create_payment', deposit: true })
  })

  it('guards: settled invoice, overpayment', () => {
    const settled = link({ invoice: invoice({ balanceCents: 0 }) })
    expect(matchArrival(arrival(), ctx({ links: [settled] }), cfg())).toMatchObject({
      kind: 'manual_queue',
      reason: 'invoice_settled',
    })
    const over = link({ expectedCents: 20223, invoice: invoice({ balanceCents: 15000 }) })
    expect(matchArrival(arrival(), ctx({ links: [over] }), cfg())).toMatchObject({
      kind: 'manual_queue',
      reason: 'overpayment',
    })
  })

  it('guard: a card pay event of the same amount already on the invoice means possible double count; cash does not', () => {
    const card = link({
      invoice: invoice({ payEvents: [{ id: 'p1', amountCents: 20223, methodKind: 'card' }] }),
    })
    expect(matchArrival(arrival(), ctx({ links: [card] }), cfg())).toMatchObject({
      kind: 'manual_queue',
      reason: 'possible_double_count',
    })
    const cash = link({
      invoice: invoice({ payEvents: [{ id: 'p1', amountCents: 20223, methodKind: 'cash' }] }),
    })
    expect(matchArrival(arrival(), ctx({ links: [cash] }), cfg()).kind).toBe('create_payment')
    const sameOrder = link({
      invoice: invoice({
        payEvents: [{ id: 'p1', amountCents: 20223, methodKind: 'card', sqspOrderId: 'ord-1' }],
      }),
    })
    expect(matchArrival(arrival(), ctx({ links: [sameOrder] }), cfg()).kind).toBe('create_payment')
  })

  it('guard: an unconfirmed staff-recorded payment for the same customer with a different amount blocks auto-recording', () => {
    const d = matchArrival(
      arrival(),
      ctx({ links: [link()], events: [event({ amountCents: 20973 })] }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'manual_queue', reason: 'possible_double_count' })
  })

  it('records variance and alerts on a link match', () => {
    const d = matchArrival(
      arrival({ orderTotalCents: 20223 }),
      ctx({ links: [link({ invoice: invoice({ totalCents: 20900 }) })] }),
      cfg(),
    )
    expect(d.kind).toBe('create_payment')
    expect(d.variance).toMatchObject({ deltaCents: -677, exceedsAlert: true })
    expect(d.alerts).toContain('variance_exceeds_delta')
  })
})

describe('rule 3 and global guards', () => {
  it('nothing to match goes to the manual queue', () => {
    expect(matchArrival(arrival(), ctx(), cfg())).toMatchObject({
      kind: 'manual_queue',
      reason: 'no_candidate',
      candidates: [],
      rule: 'manual',
    })
  })

  it('non-USD never auto-matches', () => {
    expect(matchArrival(arrival({ currency: 'EUR' }), ctx({ events: [event()] }), cfg())).toMatchObject({
      kind: 'manual_queue',
      reason: 'currency_mismatch',
    })
  })

  it('manual queue candidates are capped and best first', () => {
    const links = [1, 2, 3, 4, 5].map((i) =>
      link({
        id: `l${i}`,
        invoiceId: `i${i}`,
        customer: nobody,
        invoice: invoice({ id: `i${i}` }),
        expectedCents: 20223 - (i % 2),
      }),
    )
    const d = matchArrival(
      arrival({ email: undefined, phone: undefined }),
      ctx({ links }),
      cfg({ maxManualCandidates: 2 }),
    )
    expect(d.kind).toBe('manual_queue')
    if (d.kind === 'manual_queue') {
      expect(d.candidates).toHaveLength(2)
      expect(d.candidates[0]!.score).toBeGreaterThanOrEqual(d.candidates[1]!.score)
    }
  })
})

describe('refunds', () => {
  const refund = (over = {}) =>
    arrival({ kind: 'refund', transactionId: 'rf-1', amountCents: 2000, orderTotalCents: 20223, ...over })
  const awaitingRefund = (over = {}) => event({ id: 'ev-r', type: 'refund', amountCents: 2000, ...over })

  it('confirms a staff-recorded refund waiting on Squarespace', () => {
    const d = matchArrival(refund(), ctx({ events: [awaitingRefund()] }), cfg())
    expect(d).toMatchObject({ kind: 'confirm_refund', eventId: 'ev-r', rule: 'awaiting' })
  })

  it('a refund still pending Oasis approval goes to a human', () => {
    expect(
      matchArrival(refund(), ctx({ events: [awaitingRefund({ status: 'pending' })] }), cfg()),
    ).toMatchObject({ kind: 'manual_queue', reason: 'refund_pending_approval' })
  })

  it('two equal awaiting refunds are ambiguous', () => {
    expect(
      matchArrival(refund(), ctx({ events: [awaitingRefund(), awaitingRefund({ id: 'ev-r2' })] }), cfg()),
    ).toMatchObject({ kind: 'manual_queue', reason: 'ambiguous_awaiting' })
  })

  it('no matching Oasis event and a tracked order: ingest as a source=squarespace refund with an alert', () => {
    const d = matchArrival(refund(), ctx({ orderInvoiceId: 'inv-1' }), cfg())
    expect(d).toMatchObject({ kind: 'record_external_refund', invoiceId: 'inv-1', rule: 'feed' })
    expect(d.alerts).toEqual(['external_refund'])
    expect(d.confidence.score).toBe(0.95)
  })

  it('finds the invoice through the order’s own pay event when the loader gave no orderInvoiceId', () => {
    const d = matchArrival(
      refund(),
      ctx({
        events: [
          event({
            processorState: 'confirmed',
            sqspOrderId: 'ord-1',
            processorRef: 'pay-9',
            amountCents: 20223,
          }),
        ],
      }),
      cfg(),
    )
    expect(d).toMatchObject({ kind: 'record_external_refund', invoiceId: 'inv-1' })
  })

  it('flags a refund larger than what the invoice has been paid', () => {
    const d = matchArrival(
      refund({ amountCents: 30000 }),
      ctx({
        orderInvoiceId: 'inv-1',
        events: [event({ id: 'p', processorState: 'confirmed', amountCents: 20223 })],
      }),
      cfg(),
    )
    expect(d.alerts).toEqual(['external_refund', 'refund_exceeds_payment'])
  })

  it('an order not booked against any invoice defers the refund instead of inventing one', () => {
    expect(matchArrival(refund(), ctx(), cfg())).toMatchObject({ kind: 'defer', reason: 'order_not_matched' })
  })

  it('an Oasis-denied refund does not absorb the feed refund: it is external', () => {
    const d = matchArrival(
      refund(),
      ctx({ orderInvoiceId: 'inv-1', events: [awaitingRefund({ status: 'denied' })] }),
      cfg(),
    )
    expect(d.kind).toBe('record_external_refund')
  })

  it('a feed refund of a different amount than the awaiting one is external; the awaiting event stays open for the overdue alert', () => {
    const d = matchArrival(
      refund({ amountCents: 1500 }),
      ctx({ orderInvoiceId: 'inv-1', events: [awaitingRefund()] }),
      cfg(),
    )
    expect(d.kind).toBe('record_external_refund')
  })
})

describe('matchArrivals (several arrivals in one order)', () => {
  it('never uses one event or link twice (payment plan with equal installments)', () => {
    const plan = {
      kind: 'payments' as const,
      alerts: [],
      arrivals: [
        arrival({ transactionId: 't1', amountCents: 10000, occurredAt: new Date(T0.getTime() - H) }),
        arrival({ transactionId: 't2', amountCents: 10000, occurredAt: T0 }),
      ],
    }
    const out = matchArrivals(plan, ctx({ events: [event({ amountCents: 10000 })] }), cfg())
    expect(out.map(kind)).toEqual(['confirm_awaiting', 'manual_queue'])
  })

  it('orders payments before refunds and passes plan alerts on', () => {
    const plan = {
      kind: 'payments' as const,
      alerts: ['partially_unmapped_skus' as const],
      arrivals: [
        arrival({ kind: 'refund', transactionId: 'rf', amountCents: 500 }),
        arrival({ transactionId: 'p' }),
      ],
    }
    const out = matchArrivals(plan, ctx({ events: [event()], orderInvoiceId: 'inv-1' }), cfg())
    expect(out.map((d) => d.arrival.kind)).toEqual(['payment', 'refund'])
    expect(out.every((d) => d.alerts.includes('partially_unmapped_skus'))).toBe(true)
  })
})

describe('planOrder and arrivalsForOrder on the fixture set', () => {
  const map = new ProductMap([
    { sku: 'MEM-PREMIUM', kind: 'membership', tierLabel: 'Premium Care' },
    { sku: 'DET-SEDAN', kind: 'service', label: 'Full Detail' },
    { sku: 'WASH-EXEC', kind: 'service', label: 'Executive Wash' },
    { sku: 'CERAMIC-PLAN', kind: 'service' },
  ])
  const orders = fixture<unknown[]>('orders.json').map((o) => mapOrder(o))
  const txns = fixture<unknown[]>('transactions.json').flatMap((d) => mapTransactionDocument(d))
  const plan = (i: number, c = cfg()) =>
    planOrder(
      orders[i]!,
      txns.filter((t) => t.orderId === orders[i]!.id),
      map,
      c,
    )

  it('membership product -> membership', () => {
    expect(plan(0)).toMatchObject({
      kind: 'membership',
      product: { tier: 'premium', planLabel: 'Premium Care', intervalMonths: 1 },
    })
  })
  it('mapped service with a payment -> one payment arrival with brand and cents', () => {
    const p = plan(2)
    expect(p.kind).toBe('payments')
    if (p.kind === 'payments') {
      expect(p.arrivals).toHaveLength(1)
      expect(p.arrivals[0]).toMatchObject({
        kind: 'payment',
        amountCents: 20223,
        brand: 'MASTERCARD',
        email: 'liam.chen@example.com',
        phone: '(555) 301-4420',
        orderTotalCents: 20223,
        orderTaxCents: 1323,
        source: 'transaction',
      })
    }
  })
  it('refunded order -> payment and refund arrivals', () => {
    const p = plan(3)
    expect(p.kind === 'payments' && p.arrivals.map((a) => [a.kind, a.amountCents])).toEqual([
      ['payment', 6313],
      ['refund', 2000],
    ])
  })
  it('test-mode order is ignored unless the flag is set', () => {
    expect(plan(4)).toEqual({ kind: 'ignore', reason: 'test_mode' })
    expect(plan(4, cfg({ includeTestMode: true })).kind).toBe('payments')
  })
  it('unmapped SKU (merchandise) is ignored; with requireMappedSkus off it proceeds', () => {
    expect(plan(5)).toEqual({ kind: 'ignore', reason: 'unmapped_sku' })
    expect(plan(5, cfg({ requireMappedSkus: false })).kind).toBe('payments')
  })
  it('a payment-plan order yields one arrival per installment', () => {
    const p = plan(6)
    expect(p.kind === 'payments' && p.arrivals.map((a) => a.amountCents)).toEqual([30000, 32100])
  })
  it('a point-of-sale order has no identity', () => {
    const p = plan(7)
    const a = p.kind === 'payments' ? p.arrivals[0]! : undefined
    expect([a?.email, a?.phone, a?.sqspCustomerId]).toEqual([undefined, undefined, undefined])
  })
  it('without transactions: PAID order is its own arrival, unpaid orders wait, failed ones are ignored', () => {
    const o = orders[2]!
    const paid = planOrder(o, [], map, cfg())
    expect(paid.kind === 'payments' && paid.arrivals[0]).toMatchObject({
      source: 'order',
      amountCents: 20223,
    })
    expect(paid.kind === 'payments' && paid.arrivals[0]!.transactionId).toBeUndefined()
    expect(planOrder({ ...o, paymentState: 'NOT_CHARGED' }, [], map, cfg())).toEqual({
      kind: 'no_payment_yet',
      paymentState: 'NOT_CHARGED',
    })
    expect(planOrder({ ...o, paymentState: 'PENDING' }, [], map, cfg()).kind).toBe('no_payment_yet')
    expect(planOrder({ ...o, paymentState: 'FAILED' }, [], map, cfg())).toEqual({
      kind: 'ignore',
      reason: 'payment_failed',
    })
    expect(arrivalsForOrder(o, [], { includeOrderLevel: false })).toEqual([])
  })
  it('mixed mapped and unmapped line items proceed with an alert; membership plus service flags the mix', () => {
    const o = orders[2]!
    const mixed = {
      ...o,
      lineItems: [...o.lineItems, { name: 'Tee', sku: 'TSHIRT-M', unitCents: 100, qty: 1 }],
    }
    expect(planOrder(mixed, [], map, cfg())).toMatchObject({
      kind: 'payments',
      alerts: ['partially_unmapped_skus'],
    })
    const m = orders[0]!
    const both = { ...m, lineItems: [...m.lineItems, ...o.lineItems] }
    expect(planOrder(both, [], map, cfg())).toMatchObject({
      kind: 'membership',
      alerts: ['mixed_membership_order'],
    })
  })
  it('an empty product map ignores everything while strict', () => {
    expect(planOrder(orders[2]!, [], new ProductMap(), cfg())).toEqual({
      kind: 'ignore',
      reason: 'unmapped_sku',
    })
  })
})

describe('findOverdueAwaiting', () => {
  it('returns awaiting events older than 24 h only', () => {
    const now = T0
    const events = [
      event({ id: 'old', occurredAt: new Date(now.getTime() - 25 * H) }),
      event({ id: 'fresh', occurredAt: new Date(now.getTime() - 23 * H) }),
      event({ id: 'done', occurredAt: new Date(now.getTime() - 99 * H), processorState: 'confirmed' }),
      event({ id: 'denied', occurredAt: new Date(now.getTime() - 99 * H), status: 'denied' }),
    ]
    expect(findOverdueAwaiting(events, now).map((e) => e.id)).toEqual(['old'])
    expect(findOverdueAwaiting(events, now, 12 * H).map((e) => e.id)).toEqual(['old', 'fresh'])
  })
})

// Keep an unused-identity import honest: maria is exercised through helpers and the guards above.
void maria
