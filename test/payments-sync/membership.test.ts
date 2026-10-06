import { describe, expect, it } from 'vitest'
import type { SqspOrder } from '../../src/integrations/ports/squarespace.js'
import { mapOrder } from '../../src/integrations/squarespace/mappers.js'
import {
  addMonths,
  inferMemberships,
  linkCustomer,
  reconcileMembership,
  type CustomerRef,
  type ExistingMembership,
} from '../../src/modules/payments-sync/membership.js'
import { ProductMap, normalizeTier } from '../../src/modules/payments-sync/product-map.js'
import { normalizeEmail, normalizePhone } from '../../src/modules/payments-sync/identity.js'
import { fixture } from '../fixtures/squarespace/load.js'

const DAY = 86_400_000
const map = new ProductMap([
  { sku: 'MEM-ESSENTIAL', kind: 'membership', tierLabel: 'Essential' },
  { sku: 'MEM-PREMIUM', kind: 'membership', tierLabel: 'Premium Care' },
  { productId: 'prod-exec', kind: 'membership', tier: 'executive', tierLabel: 'Executive Club' },
  { sku: 'MEM-EXOTIC-ANNUAL', kind: 'membership', tierLabel: 'Exotic', intervalMonths: 12 },
  { sku: 'WASH-EXEC', kind: 'service' },
])

let n = 0
function order(over: Partial<SqspOrder> & { sku?: string; productId?: string; at: string }): SqspOrder {
  const { sku = 'MEM-PREMIUM', productId, at, ...rest } = over
  const id = `o${++n}`
  return {
    id,
    orderNumber: String(1000 + n),
    createdOn: new Date(at),
    modifiedOn: new Date(at),
    customerEmail: 'maria.alvarez@example.com',
    customerName: 'Maria Alvarez',
    customerPhone: '5557120188',
    customerId: 'sq-maria',
    isSubscription: true,
    grandTotalCents: 15943,
    refundedTotalCents: 0,
    currency: 'USD',
    testMode: false,
    paymentState: 'PAID',
    lineItems: [{ sku, productId, name: 'Membership', unitCents: 14900, qty: 1 }],
    raw: {},
    ...rest,
  }
}

const maria: CustomerRef = { id: 'c-maria', emails: ['maria.alvarez@example.com'], phones: ['555-712-0188'] }
const infer = (orders: SqspOrder[], now: string, customers: CustomerRef[] = [maria], cfg = {}) =>
  inferMemberships(orders, map, customers, new Date(now), cfg)

describe('tier normalisation', () => {
  it.each([
    ['Premium Care', 'premium'],
    ['Essential', 'essential'],
    ['Essentials Plus', 'essential'],
    ['EXECUTIVE club', 'executive'],
    ['Exotic', 'exotic'],
    ['Gold', undefined],
    ['Impremium', undefined],
    ['', undefined],
  ])('%s -> %s', (label, tier) => expect(normalizeTier(label)).toBe(tier))

  it('a membership entry must name a tier; an entry needs a product id or sku', () => {
    expect(() => new ProductMap([{ sku: 'X', kind: 'membership', tierLabel: 'Gold' }])).toThrow(/tier/)
    expect(() => new ProductMap([{ kind: 'service' }])).toThrow(/productId or a sku/)
  })

  it('looks up by product id first, then case-insensitive sku, and parses the env JSON', () => {
    const m = ProductMap.fromJson(
      '[{"sku":"Mem-Premium","kind":"membership","tierLabel":"Premium Care"},{"productId":"p1","kind":"service","label":"Wash"}]',
    )
    expect(m.size).toBe(2)
    expect(m.resolve({ sku: 'MEM-PREMIUM' })).toMatchObject({
      kind: 'membership',
      tier: 'premium',
      planLabel: 'Premium Care',
      matchedBy: 'sku',
    })
    expect(m.resolve({ productId: 'p1', sku: 'nope' })).toMatchObject({
      kind: 'service',
      matchedBy: 'productId',
    })
    expect(m.resolve({ sku: 'unknown' })).toBeUndefined()
    expect(ProductMap.fromJson(undefined).size).toBe(0)
  })
})

describe('identity normalisation', () => {
  it.each([
    ['(555) 712-0188', '+15557120188'],
    ['555.712.0188', '+15557120188'],
    ['1-555-712-0188', '+15557120188'],
    ['+44 20 7946 0958', '+442079460958'],
    ['712-0188', undefined],
    ['n/a', undefined],
    [undefined, undefined],
  ])('phone %s', (raw, e164) => expect(normalizePhone(raw)).toBe(e164))
  it('email', () => {
    expect(normalizeEmail('  Maria.Alvarez@Example.com ')).toBe('maria.alvarez@example.com')
    expect(normalizeEmail('not-an-email')).toBeUndefined()
  })
})

describe('addMonths', () => {
  it.each([
    ['2026-01-15T10:00:00.000Z', 1, '2026-02-15T10:00:00.000Z'],
    ['2026-01-31T10:00:00.000Z', 1, '2026-02-28T10:00:00.000Z'],
    ['2028-01-31T10:00:00.000Z', 1, '2028-02-29T10:00:00.000Z'],
    ['2026-12-05T10:00:00.000Z', 1, '2027-01-05T10:00:00.000Z'],
    ['2026-03-31T10:00:00.000Z', 12, '2027-03-31T10:00:00.000Z'],
  ])('%s + %i', (from, k, to) => expect(addMonths(new Date(from), k).toISOString()).toBe(to))
})

describe('status inference: paid period, grace, past due, lagged cancellation', () => {
  const first = order({ at: '2026-09-04T15:00:00.000Z' })
  const end = new Date('2026-10-04T15:00:00.000Z').getTime()

  it.each([
    ['mid-cycle', end - 10 * DAY, 'active', false],
    ['exactly at period end', end, 'active', false],
    ['1 ms into grace', end + 1, 'active', true],
    ['last moment of the 7-day grace', end + 7 * DAY, 'active', true],
    ['1 ms past grace', end + 7 * DAY + 1, 'past_due', false],
    ['40 days past grace', end + 47 * DAY, 'past_due', false],
  ])('%s', (_n, at, status, inGrace) => {
    const [m] = infer([first], new Date(at).toISOString())
    expect(m).toMatchObject({ status, inGrace })
    expect(m!.currentPeriodStart!.toISOString()).toBe('2026-09-04T15:00:00.000Z')
    expect(m!.currentPeriodEnd!.toISOString()).toBe('2026-10-04T15:00:00.000Z')
  })

  it('grace is configurable (a 3 day grace misfires on retried payments; 10 days waits longer)', () => {
    const at = new Date(end + 5 * DAY).toISOString()
    expect(infer([first], at, [maria], { graceDays: 3 })[0]!.status).toBe('past_due')
    expect(infer([first], at, [maria], { graceDays: 10 })[0]!.status).toBe('active')
    expect(infer([first], new Date(end + 1).toISOString(), [maria], { graceDays: 0 })[0]!.status).toBe(
      'past_due',
    )
  })

  it('cancellation is inferred only after grace plus the lapse days, and can be disabled', () => {
    const lapsed = new Date(end + 7 * DAY + 60 * DAY + 1).toISOString()
    const [m] = infer([first], lapsed)
    expect(m).toMatchObject({ status: 'canceled' })
    expect(m!.flags.map((f) => f.code)).toContain('lagged_cancellation')
    expect(infer([first], new Date(end + 7 * DAY + 60 * DAY).toISOString())[0]!.status).toBe('past_due')
    expect(infer([first], lapsed, [maria], { lapseCancelDays: null })[0]!.status).toBe('past_due')
    expect(infer([first], lapsed, [maria], { lapseCancelDays: 14 })[0]!.status).toBe('canceled')
  })

  it('a renewal landing in the grace period restores a clean cycle and moves the renewal date from the latest paid order', () => {
    const renewal = order({ at: new Date(end + 3 * DAY).toISOString() })
    const [m] = infer([first, renewal], new Date(end + 4 * DAY).toISOString())
    expect(m).toMatchObject({ status: 'active', inGrace: false, lastOrderId: renewal.id, paidOrderCount: 2 })
    expect(m!.currentPeriodStart).toEqual(renewal.createdOn)
    expect(m!.currentPeriodEnd!.toISOString()).toBe('2026-11-07T15:00:00.000Z')
  })

  it('order of arrival does not matter', () => {
    const renewal = order({ at: '2026-10-04T15:05:00.000Z' })
    expect(infer([renewal, first], '2026-10-10T00:00:00Z')).toEqual(
      infer([first, renewal], '2026-10-10T00:00:00Z'),
    )
  })

  it('billing interval comes from the product map (annual)', () => {
    const [m] = infer(
      [order({ sku: 'MEM-EXOTIC-ANNUAL', at: '2026-01-10T12:00:00.000Z' })],
      '2026-12-31T00:00:00Z',
    )
    expect(m).toMatchObject({ tier: 'exotic', intervalMonths: 12, status: 'active' })
    expect(m!.currentPeriodEnd!.toISOString()).toBe('2027-01-10T12:00:00.000Z')
  })

  it('maps tiers through sku and product id, keeping the sold label ("Premium Care" is Premium)', () => {
    const rows = infer(
      [
        order({
          sku: 'MEM-PREMIUM',
          at: '2026-10-01T00:00:00Z',
          customerEmail: 'a@example.com',
          customerId: 'a',
          customerPhone: undefined,
        }),
        order({
          sku: undefined,
          productId: 'prod-exec',
          at: '2026-10-01T00:00:00Z',
          customerEmail: 'b@example.com',
          customerId: 'b',
          customerPhone: undefined,
        }),
        order({
          sku: 'MEM-ESSENTIAL',
          at: '2026-10-01T00:00:00Z',
          customerEmail: 'c@example.com',
          customerId: 'c',
          customerPhone: undefined,
        }),
      ],
      '2026-10-05T00:00:00Z',
      [],
    )
    expect(rows.map((r) => [r.email, r.tier, r.planLabel])).toEqual([
      ['a@example.com', 'premium', 'Premium Care'],
      ['b@example.com', 'executive', 'Executive Club'],
      ['c@example.com', 'essential', 'Essential'],
    ])
  })
})

describe('refunds flag review, they do not cancel', () => {
  const first = order({ at: '2026-08-04T15:00:00.000Z' })
  const second = order({ at: '2026-09-04T15:00:00.000Z' })

  it('a fully refunded latest renewal is flagged and the status falls back to the earlier paid order', () => {
    const refunded = {
      ...second,
      paymentState: 'REFUNDED' as const,
      refundedTotalCents: second.grandTotalCents,
    }
    const [m] = infer([first, refunded], '2026-09-20T00:00:00Z')
    expect(m!.flags.map((f) => f.code)).toEqual(['full_refund'])
    expect(m).toMatchObject({ status: 'past_due', lastOrderId: first.id })
    expect(m!.status).not.toBe('canceled')
  })

  it('a fully refunded only order leaves the membership pending with the flag', () => {
    const only = { ...first, paymentState: 'REFUNDED' as const, refundedTotalCents: first.grandTotalCents }
    const [m] = infer([only], '2026-08-10T00:00:00Z')
    expect(m).toMatchObject({ status: 'pending', paidOrderCount: 0 })
    expect(m!.flags.map((f) => f.code)).toEqual(['full_refund'])
    expect(m!.currentPeriodEnd).toBeUndefined()
  })

  it('a partial refund still counts as paid and is flagged', () => {
    const partial = { ...second, paymentState: 'REFUNDED' as const, refundedTotalCents: 2000 }
    const [m] = infer([first, partial], '2026-09-10T00:00:00Z')
    expect(m).toMatchObject({ status: 'active', lastOrderId: second.id })
    expect(m!.flags).toEqual([expect.objectContaining({ code: 'partial_refund', orderId: second.id })])
  })

  it('a pending or failed latest renewal is flagged but does not change status', () => {
    const pending = { ...order({ at: '2026-09-04T16:00:00Z' }), paymentState: 'PENDING' as const }
    const [p] = infer([first, pending], '2026-09-05T00:00:00Z')
    expect(p!.flags.map((f) => f.code)).toEqual(['payment_pending'])
    expect(p).toMatchObject({ status: 'active', lastOrderId: first.id })
    const failed = { ...order({ at: '2026-09-04T16:00:00Z' }), paymentState: 'FAILED' as const }
    expect(infer([first, failed], '2026-09-05T00:00:00Z')[0]!.flags.map((f) => f.code)).toEqual([
      'payment_failed',
    ])
  })

  it('an old pending order superseded by a newer paid one is not flagged', () => {
    const stale = { ...order({ at: '2026-08-05T00:00:00Z' }), paymentState: 'PENDING' as const }
    const [m] = infer([first, stale, second], '2026-09-10T00:00:00Z')
    expect(m!.flags).toEqual([])
  })
})

describe('tier change, test mode and non-membership orders', () => {
  it('an upgrade is the latest paid order and flagged', () => {
    const a = order({ sku: 'MEM-ESSENTIAL', at: '2026-08-04T15:00:00Z' })
    const b = order({ sku: 'MEM-PREMIUM', at: '2026-09-04T15:00:00Z' })
    const [m] = infer([a, b], '2026-09-10T00:00:00Z')
    expect(m).toMatchObject({ tier: 'premium', planLabel: 'Premium Care' })
    expect(m!.flags).toEqual([
      expect.objectContaining({ code: 'tier_changed', note: 'essential -> premium' }),
    ])
  })

  it('skips test-mode orders (unless the flag is set) and orders without a membership product', () => {
    const test = order({ at: '2026-09-04T15:00:00Z', testMode: true })
    const wash = order({ sku: 'WASH-EXEC', at: '2026-09-04T15:00:00Z' })
    expect(infer([test, wash], '2026-09-10T00:00:00Z')).toEqual([])
    expect(infer([test], '2026-09-10T00:00:00Z', [maria], { includeTestMode: true })).toHaveLength(1)
  })
})

describe('customer linking: sqsp id, then email, then phone', () => {
  const liam: CustomerRef = {
    id: 'c-liam',
    emails: ['liam.chen@example.com'],
    phones: ['555-301-4420'],
    sqspCustomerIds: ['sq-liam'],
  }

  it('by email (case-insensitive), then phone (any formatting)', () => {
    expect(linkCustomer({ email: 'MARIA.ALVAREZ@example.com' }, [maria, liam])).toEqual({
      customerId: 'c-maria',
      by: 'email',
    })
    expect(linkCustomer({ email: 'other@example.com', phone: '+1 (555) 301 4420' }, [maria, liam])).toEqual({
      customerId: 'c-liam',
      by: 'phone',
    })
    expect(linkCustomer({ email: 'nobody@example.com', phone: '555-000-0000' }, [maria, liam])).toEqual({
      by: 'none',
    })
  })

  it('a stored Squarespace customer id beats a conflicting email', () => {
    expect(
      linkCustomer({ sqspCustomerId: 'sq-liam', email: 'maria.alvarez@example.com' }, [maria, liam]),
    ).toEqual({ customerId: 'c-liam', by: 'sqsp_customer_id' })
  })

  it('email beats phone; an ambiguous match links nobody', () => {
    expect(
      linkCustomer({ email: 'liam.chen@example.com', phone: '555-712-0188' }, [maria, liam]).customerId,
    ).toBe('c-liam')
    const twin: CustomerRef = { id: 'c-twin', emails: [], phones: ['5557120188'] }
    expect(linkCustomer({ phone: '5557120188' }, [maria, twin])).toEqual({ by: 'ambiguous' })
  })

  it('a changed email still groups with the same customer when the phone links, and an ambiguous link is flagged', () => {
    const a = order({ at: '2026-08-04T15:00:00Z', customerEmail: 'old@example.com', customerId: undefined })
    const b = order({ at: '2026-09-04T15:00:00Z', customerEmail: 'new@example.com', customerId: undefined })
    const rows = infer([a, b], '2026-09-10T00:00:00Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      customerId: 'c-maria',
      linkedBy: 'phone',
      email: 'new@example.com',
      paidOrderCount: 2,
    })
    const twin: CustomerRef = { id: 'c-twin', emails: [], phones: ['5557120188'] }
    const amb = infer(
      [order({ at: '2026-09-04T15:00:00Z', customerEmail: 'x@example.com', customerId: undefined })],
      '2026-09-10T00:00:00Z',
      [maria, twin],
    )
    expect(amb[0]).toMatchObject({ customerId: undefined, linkedBy: 'ambiguous' })
    expect(amb[0]!.flags.map((f) => f.code)).toEqual(['ambiguous_customer'])
  })

  it('an unknown customer yields an unlinked inference carrying email and phone for creation', () => {
    const [m] = infer(
      [
        order({
          at: '2026-09-04T15:00:00Z',
          customerEmail: 'new.person@example.com',
          customerPhone: '(555) 999-1234',
          customerId: undefined,
        }),
      ],
      '2026-09-10T00:00:00Z',
      [],
    )
    expect(m).toMatchObject({
      customerId: undefined,
      linkedBy: 'none',
      email: 'new.person@example.com',
      phone: '+15559991234',
    })
  })

  it('the subscription reference is derived from email plus product (Squarespace has no subscription id)', () => {
    const [m] = infer([order({ at: '2026-09-04T15:00:00Z' })], '2026-09-10T00:00:00Z')
    expect(m!.subscriptionRef).toBe('sqsp:maria.alvarez@example.com:MEM-PREMIUM')
    const [byId] = infer(
      [order({ sku: undefined, productId: 'prod-exec', at: '2026-09-04T15:00:00Z' })],
      '2026-09-10T00:00:00Z',
    )
    expect(byId!.subscriptionRef).toBe('sqsp:maria.alvarez@example.com:prod-exec')
  })
})

describe('fixture orders', () => {
  it('Maria (Premium Care, orders Aug 4 and Sep 4) is in grace on Oct 6 and active with a 7-day grace', () => {
    const orders = fixture<unknown[]>('orders.json').map((o) => mapOrder(o))
    const m = new ProductMap([{ sku: 'MEM-PREMIUM', kind: 'membership', tierLabel: 'Premium Care' }])
    const [row] = inferMemberships(orders, m, [maria], new Date('2026-10-06T14:00:00Z'))
    expect(row).toMatchObject({
      status: 'active',
      inGrace: true,
      tier: 'premium',
      planLabel: 'Premium Care',
      customerId: 'c-maria',
      paidOrderCount: 2,
    })
    expect(row!.currentPeriodEnd!.toISOString()).toBe('2026-10-04T15:12:11.874Z')
    const [tight] = inferMemberships(orders, m, [maria], new Date('2026-10-06T14:00:00Z'), { graceDays: 1 })
    expect(tight!.status).toBe('past_due')
  })
})

describe('reconcileMembership', () => {
  const [inf] = infer([order({ at: '2026-09-04T15:00:00Z' })], '2026-09-10T00:00:00Z')
  const stored = (over: Partial<ExistingMembership> = {}): ExistingMembership => ({
    id: 'm1',
    customerId: 'c-maria',
    status: 'active',
    source: 'squarespace',
    tier: 'premium',
    currentPeriodEnd: inf!.currentPeriodEnd,
    lastSqspOrderId: inf!.lastOrderId,
    ...over,
  })

  it('creates for a linked customer, asks for a customer otherwise, and ignores unpaid first orders', () => {
    expect(reconcileMembership(undefined, inf!)).toMatchObject({ action: 'create', customerId: 'c-maria' })
    const [stranger] = infer(
      [
        order({
          at: '2026-09-04T15:00:00Z',
          customerEmail: 'z@example.com',
          customerPhone: undefined,
          customerId: undefined,
        }),
      ],
      '2026-09-10T00:00:00Z',
      [],
    )
    expect(reconcileMembership(undefined, stranger!)).toMatchObject({ action: 'needs_customer' })
    const [unpaid] = infer(
      [{ ...order({ at: '2026-09-04T15:00:00Z' }), paymentState: 'PENDING' as const }],
      '2026-09-10T00:00:00Z',
    )
    expect(reconcileMembership(undefined, unpaid!)).toMatchObject({ action: 'none' })
  })

  it('is a no-op when nothing changed, and lists changes otherwise', () => {
    expect(reconcileMembership(stored(), inf!)).toEqual({ action: 'none', reason: 'unchanged' })
    const act = reconcileMembership(stored({ status: 'past_due', tier: 'essential' }), inf!)
    expect(act).toMatchObject({ action: 'update', membershipId: 'm1' })
    expect(act.action === 'update' && act.changes).toEqual([
      'status past_due -> active',
      'tier essential -> premium',
    ])
  })

  it('respects hand-set pause/cancel until a newer paid order arrives', () => {
    expect(
      reconcileMembership(
        stored({ status: 'paused', manualStatusAt: new Date('2026-09-20T00:00:00Z') }),
        inf!,
      ),
    ).toMatchObject({ action: 'none' })
    expect(
      reconcileMembership(
        stored({ status: 'paused', manualStatusAt: new Date('2026-08-20T00:00:00Z') }),
        inf!,
      ),
    ).toMatchObject({ action: 'update' })
    expect(
      reconcileMembership(
        stored({ status: 'canceled', source: 'manual', manualStatusAt: new Date('2026-09-20T00:00:00Z') }),
        inf!,
      ),
    ).toMatchObject({ action: 'none' })
    // an inferred (source=squarespace) cancellation is not a manual hold: a later renewal revives it
    expect(reconcileMembership(stored({ status: 'canceled', source: 'squarespace' }), inf!)).toMatchObject({
      action: 'update',
    })
  })
})
