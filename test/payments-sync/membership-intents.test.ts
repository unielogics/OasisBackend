// Who a membership order belongs to (ADR 0160, design section 5): the checkout intent first (email + product + window), then the
// Squarespace id, a VERIFIED email, the phone; an unverified email never links (it names a candidate for staff); a second paid
// order of the same plan while the period runs is a duplicate. Pure: payments-sync/membership.ts.
import { describe, expect, it } from 'vitest'
import type { SqspOrder } from '../../src/integrations/ports/squarespace.js'
import {
  inferMemberships,
  linkCustomer,
  RENEWAL_EARLY_MS,
  type CheckoutIntentRef,
  type CustomerRef,
} from '../../src/modules/payments-sync/membership.js'
import { ProductMap } from '../../src/modules/payments-sync/product-map.js'

const map = new ProductMap([
  { sku: 'MEM-PREMIUM', productId: 'prod-gold', kind: 'membership', tierLabel: 'Premium Care' },
  { sku: 'MEM-EXEC', productId: 'prod-vip', kind: 'membership', tier: 'executive', tierLabel: 'Executive' },
])

let n = 0
function order(over: Partial<SqspOrder> & { at: string; sku?: string; productId?: string }): SqspOrder {
  const { at, sku = 'MEM-PREMIUM', productId = 'prod-gold', ...rest } = over
  n++
  return {
    id: `o${n}`,
    orderNumber: String(2000 + n),
    createdOn: new Date(at),
    modifiedOn: new Date(at),
    customerEmail: 'ana@example.com',
    customerName: 'Ana Ruiz',
    isSubscription: true,
    grandTotalCents: 9900,
    refundedTotalCents: 0,
    currency: 'USD',
    testMode: false,
    paymentState: 'PAID',
    lineItems: [{ sku, productId, name: 'Gold', unitCents: 9900, qty: 1 }],
    raw: {},
    ...rest,
  }
}

const intent = (over: Partial<CheckoutIntentRef> = {}): CheckoutIntentRef => ({
  id: 'i1',
  customerId: 'c-ana',
  membershipId: 'm-ana',
  state: 'open',
  planKey: 'premium',
  productKey: 'prod-gold',
  expectedEmail: 'ana@example.com',
  startedAt: new Date('2026-10-11T12:00:00Z'),
  expiresAt: new Date('2026-10-14T12:00:00Z'),
  ...over,
})

// Ana's email on file was typed on the website and never verified
const ana: CustomerRef = { id: 'c-ana', emails: [], unverifiedEmails: ['ana@example.com'], phones: ['+12015550188'] }
const bob: CustomerRef = { id: 'c-bob', emails: ['bob@example.com'], phones: ['+12015550199'] }
const product = { key: 'prod-gold', productId: 'prod-gold', sku: 'MEM-PREMIUM', tier: 'premium' }

describe('linkCustomer: the checkout-intent tier', () => {
  const who = (at: string, over: Record<string, unknown> = {}) => ({
    email: 'ANA@example.com',
    orderId: 'o-x',
    createdOn: new Date(at),
    product,
    ...over,
  })

  it('an order with the expected email and product inside the window belongs to the intent’s client, before any other tier', () => {
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [ana, bob], [intent()])).toEqual({
      customerId: 'c-ana',
      by: 'checkout_intent',
      intent: { id: 'i1', fresh: true },
    })
    // the intent's own client matching by another tier too (her phone, her Squarespace id) is no conflict
    const anaLinked: CustomerRef = { ...ana, sqspCustomerIds: ['sq-ana'] }
    expect(
      linkCustomer(who('2026-10-12T09:00:00Z', { phone: '(201) 555-0188', sqspCustomerId: 'sq-ana' }), [anaLinked, bob], [intent()]),
    ).toMatchObject({ customerId: 'c-ana', by: 'checkout_intent' })
  })

  it('an intent never takes an order that another client’s Squarespace id, verified email or phone points at: staff decide (F1)', () => {
    const conflict = { by: 'ambiguous', intentConflict: 'i1' }
    // the Squarespace customer id is linked to somebody else
    const linked: CustomerRef = { ...bob, sqspCustomerIds: ['sq-1'] }
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { sqspCustomerId: 'sq-1' }), [ana, linked], [intent()])).toEqual(conflict)
    // the intent names an email another client verified
    const eve = intent({ customerId: 'c-eve', membershipId: 'm-eve', expectedEmail: 'bob@example.com' })
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { email: 'bob@example.com' }), [ana, bob], [eve])).toEqual(conflict)
    // the order's phone is another client's
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { phone: '+12015550199' }), [ana, bob], [intent()])).toEqual(conflict)
    // a renewal of a matched intent is held to the same rule
    const matched = intent({ state: 'matched', orderId: 'o-first' })
    expect(linkCustomer(who('2026-11-12T09:00:00Z', { orderId: 'o-renewal', sqspCustomerId: 'sq-1' }), [linked], [matched])).toEqual(conflict)
    // an email somebody else has on file but never verified is no conflict: the intent is how such an email gets its owner
    const twin: CustomerRef = { id: 'c-twin', emails: [], unverifiedEmails: ['ana@example.com'], phones: [] }
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [ana, twin], [intent()]).customerId).toBe('c-ana')
  })

  it('a matched intent’s renewals follow the Squarespace customer of its bound order, never another payer with the same email (F1)', () => {
    const matched = intent({ state: 'matched', orderId: 'o-first', orderSqspCustomerId: 'sq-ana' })
    // the same Squarespace customer renews with a changed email: still the intent's client
    expect(
      linkCustomer(who('2026-11-12T09:00:00Z', { orderId: 'o-2', sqspCustomerId: 'sq-ana', email: 'ana.new@example.com' }), [], [matched]),
    ).toMatchObject({ customerId: 'c-ana', by: 'checkout_intent', intent: { id: 'i1', fresh: false } })
    // another Squarespace customer (or none) paying with the intent's email is no renewal of it
    expect(linkCustomer(who('2026-11-12T09:00:00Z', { orderId: 'o-3', sqspCustomerId: 'sq-other' }), [], [matched]).by).toBe('none')
    expect(linkCustomer(who('2026-11-12T09:00:00Z', { orderId: 'o-4' }), [], [matched]).by).toBe('none')
    // the bound order itself stays bound
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { orderId: 'o-first', sqspCustomerId: 'sq-ana' }), [], [matched]).customerId).toBe('c-ana')
  })

  it('outside the window, with another email, or another product the intent does not link', () => {
    expect(linkCustomer(who('2026-10-11T11:59:59Z'), [], [intent()])).toEqual({ by: 'none' })
    expect(linkCustomer(who('2026-10-14T12:00:01Z'), [], [intent()])).toEqual({ by: 'none' })
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { email: 'someone@example.com' }), [], [intent()])).toEqual({ by: 'none' })
    const vip = { key: 'prod-vip', productId: 'prod-vip', sku: 'MEM-EXEC', tier: 'executive' }
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { product: vip }), [], [intent()])).toEqual({ by: 'none' })
    // an intent without a product key accepts any product of its plan, by tier
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [], [intent({ productKey: undefined })]).customerId).toBe('c-ana')
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { product: vip }), [], [intent({ productKey: undefined })])).toEqual({ by: 'none' })
    // a SKU key matches too, in any letter case
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [], [intent({ productKey: 'mem-premium' })]).customerId).toBe('c-ana')
  })

  it('a matched intent binds its order and that email’s later renewals of the product; two clients’ intents for one email link nobody', () => {
    const matched = intent({ state: 'matched', orderId: 'o-first' })
    expect(linkCustomer(who('2026-12-12T09:00:00Z', { orderId: 'o-first', email: 'changed@example.com' }), [], [matched])).toEqual({
      customerId: 'c-ana',
      by: 'checkout_intent',
      intent: { id: 'i1', fresh: false },
    })
    expect(linkCustomer(who('2026-11-12T09:00:00Z', { orderId: 'o-renewal' }), [], [matched]).intent).toEqual({ id: 'i1', fresh: false })
    const other = intent({ id: 'i2', customerId: 'c-bob', membershipId: 'm-bob' })
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [ana, bob], [intent(), other])).toEqual({ by: 'ambiguous' })
    // a row waiting for staff binds nothing by itself
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { orderId: 'o-w' }), [], [intent({ state: 'awaiting_match', orderId: 'o-w' })]).by).not.toBe(
      'checkout_intent',
    )
  })
})

describe('linkCustomer: unverified emails never link', () => {
  it('an email nobody verified names the client as a candidate; a verified one links; the phone still links', () => {
    expect(linkCustomer({ email: 'ana@example.com' }, [ana, bob])).toEqual({ by: 'unverified_email', candidateCustomerId: 'c-ana' })
    expect(linkCustomer({ email: 'bob@example.com' }, [ana, bob])).toEqual({ customerId: 'c-bob', by: 'email' })
    expect(linkCustomer({ email: 'ana@example.com', phone: '(201) 555-0188' }, [ana, bob])).toEqual({ customerId: 'c-ana', by: 'phone' })
    const twin: CustomerRef = { id: 'c-twin', emails: [], unverifiedEmails: ['ana@example.com'], phones: [] }
    expect(linkCustomer({ email: 'ana@example.com' }, [ana, twin])).toEqual({ by: 'ambiguous' })
  })
})

describe('inferMemberships with intents, unverified emails and duplicates', () => {
  it('reports the open intents its orders consumed, and links the person through the intent', () => {
    const o = order({ at: '2026-10-12T09:00:00Z' })
    const [m] = inferMemberships([o], map, [ana], new Date('2026-10-13T00:00:00Z'), {}, [intent()])
    expect(m).toMatchObject({ customerId: 'c-ana', linkedBy: 'checkout_intent', status: 'active', checkoutMatches: [{ intentId: 'i1', orderId: o.id }] })
    // once matched, the same order no longer reports a fresh match
    const [again] = inferMemberships([o], map, [ana], new Date('2026-10-13T00:00:00Z'), {}, [intent({ state: 'matched', orderId: o.id })])
    expect(again).toMatchObject({ customerId: 'c-ana', checkoutMatches: [] })
  })

  it('another client’s open intent naming a member’s email never takes the member’s renewals (F1, adversarial)', () => {
    // Bob verified bob@example.com and his Squarespace id is linked; Eve opens an intent naming his email on Oct 8
    const bobLinked: CustomerRef = { ...bob, sqspCustomerIds: ['sq-bob'] }
    const bobOrder = (at: string) => order({ at, customerEmail: 'bob@example.com', customerId: 'sq-bob', customerName: 'Bob' })
    const o1 = bobOrder('2026-09-10T15:00:00Z')
    const o2 = bobOrder('2026-10-10T15:00:00Z')
    const eve = intent({
      id: 'i-eve',
      customerId: 'c-eve',
      membershipId: 'm-eve',
      expectedEmail: 'bob@example.com',
      startedAt: new Date('2026-10-08T12:00:00Z'),
      expiresAt: new Date('2026-10-11T12:00:00Z'),
    })
    const during = inferMemberships([o1, o2], map, [bobLinked], new Date('2026-10-10T16:00:00Z'), {}, [eve])
    // the renewal is not Eve's and the intent is not consumed; it waits for staff while the intent is open
    expect(during.some((m) => m.customerId === 'c-eve')).toBe(false)
    expect(during.flatMap((m) => m.checkoutMatches)).toEqual([])
    const held = during.find((m) => m.lastOrderId === o2.id)!
    expect(held).toMatchObject({ linkedBy: 'ambiguous', customerId: undefined })
    expect(held.flags.map((f) => f.code)).toContain('ambiguous_customer')
    // once the intent expired (no longer loaded), the renewal is Bob's again, and so are his later ones
    const o3 = bobOrder('2026-11-10T15:00:00Z')
    const after = inferMemberships([o1, o2, o3], map, [bobLinked], new Date('2026-11-11T00:00:00Z'), {}, [])
    expect(after).toEqual([expect.objectContaining({ customerId: 'c-bob', status: 'active', paidOrderCount: 3, lastOrderId: o3.id })])
  })

  it('an order matching only an unverified email is unlinked with its candidate', () => {
    const [m] = inferMemberships([order({ at: '2026-10-12T09:00:00Z' })], map, [ana], new Date('2026-10-13T00:00:00Z'))
    expect(m).toMatchObject({ customerId: undefined, linkedBy: 'unverified_email', candidateCustomerId: 'c-ana', paidOrderCount: 1 })
  })

  it('a second paid order of the same plan while the period runs is a flagged duplicate that never moves the period; a renewal is not', () => {
    const first = order({ at: '2026-09-04T15:00:00Z', customerEmail: 'bob@example.com' })
    const dup = order({ at: '2026-09-10T15:00:00Z', customerEmail: 'bob@example.com' })
    const renewal = order({ at: new Date(new Date('2026-10-04T15:00:00Z').getTime() - RENEWAL_EARLY_MS).toISOString(), customerEmail: 'bob@example.com' })
    const [m] = inferMemberships([first, dup, renewal], map, [bob], new Date('2026-10-05T00:00:00Z'))
    expect(m).toMatchObject({ customerId: 'c-bob', status: 'active', paidOrderCount: 2, lastOrderId: renewal.id })
    expect(m!.flags).toEqual([expect.objectContaining({ code: 'duplicate_payment', orderId: dup.id })])
    expect(m!.currentPeriodStart).toEqual(renewal.createdOn)
    // without the renewal: the period is still the first order's
    const [d] = inferMemberships([first, dup], map, [bob], new Date('2026-09-20T00:00:00Z'))
    expect(d!.currentPeriodStart).toEqual(first.createdOn)
    expect(d!.lastOrderId).toBe(first.id)
    // another plan mid-period is a tier change (flagged as before), not a duplicate
    const vip = order({ at: '2026-09-12T15:00:00Z', customerEmail: 'bob@example.com', sku: 'MEM-EXEC', productId: 'prod-vip' })
    const [t] = inferMemberships([first, vip], map, [bob], new Date('2026-09-20T00:00:00Z'))
    expect(t!.flags.map((f) => f.code)).toEqual(['tier_changed'])
    expect(t!.tier).toBe('executive')
    // a refunded first order leaves the second as the only paid one: no duplicate
    const refunded = { ...first, paymentState: 'REFUNDED' as const, refundedTotalCents: first.grandTotalCents }
    const [r] = inferMemberships([refunded, dup], map, [bob], new Date('2026-09-20T00:00:00Z'))
    expect(r!.flags.map((f) => f.code)).toEqual(['full_refund'])
    expect(r!.lastOrderId).toBe(dup.id)
  })
})
