import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  adjustPreview,
  calcInvoice,
  deriveStatus,
  itemsRefundValue,
  netCents,
  statusLabel,
  type CalcEvent,
  type CalcInput,
} from '../../src/modules/payments/calc.js'
import { money0 } from '../../src/modules/payments/format.js'
import { divHalfUp, taxCents } from '../../src/platform/money.js'

const input = (o: Partial<CalcInput> & { itemPrices: number[] }): CalcInput => ({
  events: [],
  taxBp: 700,
  tipCents: 0,
  canceled: false,
  ...o,
})
const pay = (amountCents: number): CalcEvent => ({ type: 'pay', amountCents })
const refund = (
  amountCents: number,
  status: 'done' | 'pending',
  dest: 'card' | 'credit' | 'cash' = 'card',
): CalcEvent => ({
  type: 'refund',
  amountCents,
  status,
  dest,
})

describe('calcInvoice: the design vectors (backend.md 10.1) in cents', () => {
  it('half-up tax', () => {
    expect([taxCents(50, 700), taxCents(150, 700), taxCents(250, 700), taxCents(1000, 700)]).toEqual([
      4, 11, 18, 70,
    ])
  })
  it('INV-20604 / 20608 / 20603', () => {
    const a = calcInvoice(input({ itemPrices: [13900, 4500] }))
    expect([a.items, a.tax, a.total]).toEqual([18400, 1288, 19688])
    const b = calcInvoice(input({ itemPrices: [42000, 12000] }))
    expect([b.items, b.tax, b.total]).toEqual([54000, 3780, 57780])
    const c = calcInvoice(input({ itemPrices: [12900, 2500] }))
    expect([c.items, c.tax, c.total, c.status, c.balance]).toEqual([15400, 1078, 16478, 'unpaid', 16478])
  })
  it('INV-20602: discount, tip, payment', () => {
    const c = calcInvoice(
      input({
        itemPrices: [32000, 5500],
        tipCents: 2000,
        events: [{ type: 'adjust', amountCents: -2500 }, pay(39450)],
      }),
    )
    expect([c.items, c.adj, c.sub, c.tax, c.total, c.status]).toEqual([
      37500,
      -2500,
      35000,
      2450,
      39450,
      'paid',
    ])
  })
  it('deposits: INV-20605 and INV-20607', () => {
    const a = calcInvoice(input({ itemPrices: [26000], events: [pay(5000)] }))
    expect([a.total, a.balance, a.status]).toEqual([27820, 22820, 'partially_paid'])
    const b = calcInvoice(input({ itemPrices: [9500, 3000], events: [pay(2000)] }))
    expect([b.total, b.balance]).toEqual([13375, 11375])
  })
  it('INV-20560: store credit counts as paid but not as card capacity', () => {
    const c = calcInvoice(
      input({ itemPrices: [4500], events: [{ type: 'credit_apply', amountCents: 2500 }, pay(2315)] }),
    )
    expect([c.total, c.paid, c.paidOrig, c.refundable, c.toOrigMax, c.status]).toEqual([
      4815,
      4815,
      2315,
      4815,
      2315,
      'paid',
    ])
  })
  it('INV-20579: a pending refund reserves refundable and does not touch paid', () => {
    const c = calcInvoice(input({ itemPrices: [26000], events: [pay(27820), refund(8000, 'pending')] }))
    expect([c.pendingAmt, c.pendingN, c.refundable, c.refunded, c.paid, c.status]).toEqual([
      8000,
      1,
      19820,
      0,
      27820,
      'paid',
    ])
    expect(statusLabel(c.status, c.pendingN > 0)).toBe('Refund pending')
  })
  it('INV-20571: canceled with the deposit refunded', () => {
    const c = calcInvoice(
      input({ itemPrices: [32000], canceled: true, events: [pay(5000), refund(5000, 'done')] }),
    )
    expect([c.status, c.balance, c.net]).toEqual([
      'canceled_refunded',
      0,
      32000 - divHalfUp(5000 * 10000, 10700),
    ])
    expect(c.net).toBe(27327)
  })
  it('INV-20566: partially refunded', () => {
    const c = calcInvoice(
      input({ itemPrices: [12900, 3500], tipCents: 1000, events: [pay(18548), refund(3745, 'done')] }),
    )
    expect([c.total, c.refunded, c.status]).toEqual([18548, 3745, 'partially_refunded'])
  })
  it('percent discount: 10% of 15400 is 1540', () => {
    const c = calcInvoice(input({ itemPrices: [12900, 2500] }))
    expect(adjustPreview(c, 700, { kind: 'discount', unit: '%', value: 1000 }).pre).toBe(1540)
  })
  it('the status ladder gains canceled, canceled_kept and canceled_refunded', () => {
    expect(deriveStatus({ canceled: true, paid: 0, refunded: 0, balance: 0 })).toBe('canceled')
    expect(deriveStatus({ canceled: true, paid: 5000, refunded: 0, balance: 0 })).toBe('canceled_kept')
    expect(deriveStatus({ canceled: true, paid: 5000, refunded: 2000, balance: 0 })).toBe('canceled_kept')
    expect(deriveStatus({ canceled: true, paid: 5000, refunded: 5000, balance: 0 })).toBe('canceled_refunded')
  })
  it('a refund within one cent of paid reads as refunded', () => {
    expect(deriveStatus({ canceled: false, paid: 1000, refunded: 999, balance: 0 })).toBe('refunded')
    expect(deriveStatus({ canceled: false, paid: 1000, refunded: 998, balance: 0 })).toBe(
      'partially_refunded',
    )
  })
  it('by-item refund value carries the invoice tax rate and is capped at refundable', () => {
    expect(itemsRefundValue([12900], 700, 100000)).toBe(13803)
    expect(itemsRefundValue([12900], 700, 5000)).toBe(5000)
  })
  it('void reverses a payment', () => {
    const c = calcInvoice(
      input({ itemPrices: [4500], events: [pay(4815), { type: 'void', amountCents: 4815 }] }),
    )
    expect([c.paid, c.status, c.balance]).toEqual([0, 'unpaid', 4815])
  })
})

describe('money0 matches the design display rounding', () => {
  it('rounds the absolute value half up with the U+2212 minus', () => {
    expect([money0(190300), money0(-2500), money0(706927), money0(50), money0(49), money0(-49)]).toEqual([
      '$1,903',
      '−$25',
      '$7,069',
      '$1',
      '$0',
      '$0',
    ])
  })
})

const arbEvent: fc.Arbitrary<CalcEvent> = fc.oneof(
  fc.integer({ min: 1, max: 80_000 }).map((n) => pay(n)),
  fc
    .integer({ min: -20_000, max: 20_000 })
    .filter((n) => n !== 0)
    .map((n): CalcEvent => ({ type: 'adjust', amountCents: n })),
  fc.integer({ min: 1, max: 30_000 }).map((n): CalcEvent => ({ type: 'credit_apply', amountCents: n })),
  fc.integer({ min: 1, max: 30_000 }).map((n): CalcEvent => ({ type: 'credit_issue', amountCents: n })),
  fc
    .tuple(
      fc.integer({ min: 1, max: 40_000 }),
      fc.constantFrom('done', 'pending', 'denied'),
      fc.constantFrom('card', 'credit', 'cash'),
    )
    .map(([n, s, d]): CalcEvent => refund(n, s as 'done' | 'pending', d as 'card' | 'credit' | 'cash')),
)

describe('calcInvoice invariants (property tests)', () => {
  const arbInput = fc.record({
    itemPrices: fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 6 }),
    events: fc.array(arbEvent, { maxLength: 12 }),
    taxBp: fc.constantFrom(0, 500, 700, 825, 1000),
    tipCents: fc.integer({ min: 0, max: 5000 }),
    canceled: fc.boolean(),
  })

  it('balance is never negative and 0 when canceled; refundable never exceeds paid', () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        const c = calcInvoice(i)
        expect(c.balance).toBeGreaterThanOrEqual(0)
        if (i.canceled) expect(c.balance).toBe(0)
        expect(c.refundable).toBeGreaterThanOrEqual(0)
        expect(c.refundable).toBeLessThanOrEqual(Math.max(0, c.paid))
        expect(c.toOrigMax).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 400 },
    )
  })

  it('tax is half-up on the adjusted subtotal and total = sub + tax + tip', () => {
    fc.assert(
      fc.property(arbInput, (i) => {
        const c = calcInvoice(i)
        expect(c.sub).toBeGreaterThanOrEqual(0)
        expect(c.tax).toBe(Math.floor((c.sub * i.taxBp * 2 + 10_000) / 20_000))
        expect(c.total).toBe(c.sub + c.tax + i.tipCents)
        expect(c.net).toBe(netCents(c.items, c.adj, c.refunded, i.taxBp))
      }),
      { numRuns: 400 },
    )
  })

  it('every input lands on exactly one status, and canceled invoices only on canceled states', () => {
    const all = new Set([
      'paid',
      'unpaid',
      'partially_paid',
      'partially_refunded',
      'refunded',
      'canceled',
      'canceled_kept',
      'canceled_refunded',
    ])
    fc.assert(
      fc.property(arbInput, (i) => {
        const c = calcInvoice(i)
        expect(all.has(c.status)).toBe(true)
        expect(c.status.startsWith('canceled')).toBe(i.canceled)
        if (!i.canceled && c.paid === 0 && c.refunded === 0) expect(c.status).toBe('unpaid')
        if (!i.canceled && c.paid > 0 && c.balance > 0 && c.refunded === 0)
          expect(c.status).toBe('partially_paid')
      }),
      { numRuns: 400 },
    )
  })

  it('a pending refund changes refundable but never paid, refunded or the status ladder', () => {
    fc.assert(
      fc.property(arbInput, fc.integer({ min: 1, max: 50_000 }), (i, amt) => {
        const base = calcInvoice(i)
        const withPending = calcInvoice({ ...i, events: [...i.events, refund(amt, 'pending')] })
        expect(withPending.paid).toBe(base.paid)
        expect(withPending.refunded).toBe(base.refunded)
        expect(withPending.status).toBe(base.status)
        expect(withPending.refundable).toBe(Math.max(0, base.paid - base.refunded - base.pendingAmt - amt))
      }),
      { numRuns: 300 },
    )
  })
})
