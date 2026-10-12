// Who a membership order belongs to (ADR 0160, design section 5): the checkout intent first (email + product + window) unless
// another client holds the order (any Squarespace link, membership row, email on file verified or not, phone, checkout row), then
// the Squarespace id, a VERIFIED email, the phone; an unverified email never links (it names a candidate for staff); a second paid
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

describe('an intent-only match whose order carries another phone or name waits for staff (W4c fixes P7)', () => {
  const at = '2026-10-12T09:00:00Z'
  const who = (over: Record<string, unknown> = {}) => ({ email: 'ana@example.com', orderId: 'o-x', createdOn: new Date(at), product, ...over })
  const anaIntent = intent({ client: { phone: '+12015550188', name: 'Ana Ruiz' } })

  it('her own phone and name (any spelling), or none on the order: the intent takes it', () => {
    const mine = { customerId: 'c-ana', by: 'checkout_intent', intent: { id: 'i1', fresh: true } }
    expect(linkCustomer(who({ phone: '(201) 555-0188', name: 'ANA RUIZ' }), [], [anaIntent])).toEqual(mine)
    expect(linkCustomer(who({ name: 'Ana M. Ruiz' }), [], [anaIntent])).toEqual(mine)
    expect(linkCustomer(who({ name: 'Ana R' }), [], [anaIntent])).toEqual(mine)
    expect(linkCustomer(who({ name: 'ana' }), [], [anaIntent])).toEqual(mine)
    expect(linkCustomer(who(), [], [anaIntent])).toEqual(mine)
  })

  it('another phone or another name: awaiting_match for staff with her as the candidate; the intent stays open', () => {
    const waits = { by: 'intent_mismatch', candidateCustomerId: 'c-ana' }
    expect(linkCustomer(who({ phone: '(973) 555-0101' }), [], [anaIntent])).toEqual(waits)
    expect(linkCustomer(who({ phone: '(201) 555-0188', name: 'Eve Squatter' }), [], [anaIntent])).toEqual(waits)
    expect(linkCustomer(who({ name: 'Ana Smith' }), [], [anaIntent])).toEqual(waits)
    // a client with no phone on file never matches an order that carries one
    expect(linkCustomer(who({ phone: '(201) 555-0188' }), [], [intent({ client: { name: 'Ana Ruiz' } })])).toEqual(waits)
    const [inf] = inferMemberships([order({ at, customerPhone: '(973) 555-0101', customerName: 'Eve Squatter' })], map, [], new Date('2026-10-12T10:00:00Z'), {}, [anaIntent])
    expect(inf).toMatchObject({ customerId: undefined, linkedBy: 'intent_mismatch', candidateCustomerId: 'c-ana', checkoutMatches: [] })
  })
})

describe('a client with a one-word or placeholder name: the order’s phone must match too (W4c re-review I1)', () => {
  const at = '2026-10-12T09:00:00Z'
  const who = (over: Record<string, unknown> = {}) => ({ email: 'ana@example.com', orderId: 'o-x', createdOn: new Date(at), product, ...over })
  const mine = { customerId: 'c-ana', by: 'checkout_intent', intent: { id: 'i1', fresh: true } }
  const waits = { by: 'intent_mismatch', candidateCustomerId: 'c-ana' }

  it('a one-word name ("Maria") never takes an order by its first name alone: no phone, or another phone, waits for staff', () => {
    const maria = intent({ client: { phone: '+12015550188', name: 'Maria' } })
    expect(linkCustomer(who({ name: 'Maria Gonzalez' }), [], [maria])).toEqual(waits)
    expect(linkCustomer(who({ name: 'Maria' }), [], [maria])).toEqual(waits)
    expect(linkCustomer(who(), [], [maria])).toEqual(waits)
    expect(linkCustomer(who({ phone: '(973) 555-0101', name: 'Maria' }), [], [maria])).toEqual(waits)
    // her own phone on the order: hers
    expect(linkCustomer(who({ phone: '(201) 555-0188', name: 'Maria Gonzalez' }), [], [maria])).toEqual(mine)
    expect(linkCustomer(who({ phone: '(201) 555-0188' }), [], [maria])).toEqual(mine)
  })

  it('a placeholder name ("New texter ••0188", "Walk-in guest") matches no name: only the phone links', () => {
    for (const name of ['New texter ••0188', 'Walk-in guest']) {
      const c = intent({ client: { phone: '+12015550188', name } })
      expect(linkCustomer(who({ name: 'New Texter' }), [], [c]), name).toEqual(waits)
      expect(linkCustomer(who({ name: 'Walk In' }), [], [c]), name).toEqual(waits)
      expect(linkCustomer(who(), [], [c]), name).toEqual(waits)
      expect(linkCustomer(who({ phone: '(201) 555-0188', name: 'Ana Ruiz' }), [], [c]), name).toEqual(mine)
    }
  })
})

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

  it('an intent never takes an order another client holds: the order links as if there were no intent (F1)', () => {
    // each conflict source on its own; the order then goes through the other tiers (`intentConflict` names the refused intent)
    const at = '2026-10-12T09:00:00Z'
    // a Squarespace link of another client, whatever made it: one the contacts job made by an unverified email links nobody by
    // itself (sqspCustomerIds omits it) but still holds the Squarespace customer against an intent
    const legacy: CustomerRef = { id: 'c-bob', emails: [], unverifiedEmails: ['bob@example.com'], phones: [], heldSqspCustomerIds: ['sq-1'] }
    expect(linkCustomer(who(at, { sqspCustomerId: 'sq-1' }), [legacy], [intent()])).toEqual({ by: 'none', intentConflict: 'i1' })
    // a link the sqsp tier reads: the order is that client's
    const linked: CustomerRef = { ...bob, sqspCustomerIds: ['sq-1'] }
    expect(linkCustomer(who(at, { sqspCustomerId: 'sq-1' }), [ana, linked], [intent()])).toEqual({
      customerId: 'c-bob',
      by: 'sqsp_customer_id',
      intentConflict: 'i1',
    })
    // the Squarespace customer on another client's membership row (heldSqspCustomerIds carries it too)
    const member: CustomerRef = { id: 'c-meg', emails: [], phones: [], heldSqspCustomerIds: ['sq-meg'] }
    expect(linkCustomer(who(at, { sqspCustomerId: 'sq-meg' }), [member], [intent()])).toEqual({ by: 'none', intentConflict: 'i1' })
    // another client's email on file, verified ...
    const eve = intent({ customerId: 'c-eve', membershipId: 'm-eve', expectedEmail: 'bob@example.com' })
    expect(linkCustomer(who(at, { email: 'bob@example.com' }), [ana, bob], [eve])).toEqual({ customerId: 'c-bob', by: 'email', intentConflict: 'i1' })
    // ... or never verified: staff are asked about that client (awaiting_match), the intent's client gets nothing
    expect(linkCustomer(who(at, { email: 'bob@example.com' }), [ana, legacy], [eve])).toEqual({
      by: 'unverified_email',
      candidateCustomerId: 'c-bob',
      intentConflict: 'i1',
    })
    const twin: CustomerRef = { id: 'c-twin', emails: [], unverifiedEmails: ['ana@example.com'], phones: [] }
    expect(linkCustomer(who(at), [twin], [intent()])).toEqual({ by: 'unverified_email', candidateCustomerId: 'c-twin', intentConflict: 'i1' })
    expect(linkCustomer(who(at), [ana, twin], [intent()])).toEqual({ by: 'ambiguous', intentConflict: 'i1' })
    // the order's phone is another client's
    expect(linkCustomer(who(at, { phone: '+12015550199' }), [ana, bob], [intent()])).toEqual({ customerId: 'c-bob', by: 'phone', intentConflict: 'i1' })
    // another client's checkout row for the same Squarespace customer (matched, or waiting for staff), or for this very order
    const bobRow = intent({ id: 'i-bob', customerId: 'c-bob', membershipId: 'm-bob', state: 'matched', orderId: 'o-bob', orderSqspCustomerId: 'sq-2', expectedEmail: 'other@example.com' })
    // (Bob's matched row makes the order his renewal; one waiting for staff only holds it)
    expect(linkCustomer(who(at, { sqspCustomerId: 'sq-2' }), [], [intent(), bobRow])).toEqual({ customerId: 'c-bob', by: 'checkout_intent', intent: { id: 'i-bob', fresh: false } })
    const waiting = { ...bobRow, state: 'awaiting_match' as const }
    expect(linkCustomer(who(at, { sqspCustomerId: 'sq-2' }), [], [intent(), waiting])).toMatchObject({ by: 'none', intentConflict: 'i1' })
    const sameOrder = { ...waiting, orderId: 'o-x', orderSqspCustomerId: undefined }
    expect(linkCustomer(who(at), [], [intent(), sameOrder])).toMatchObject({ by: 'none', intentConflict: 'i1' })
    // the intent's own client holding all of these is no conflict
    const anaAll: CustomerRef = { ...ana, sqspCustomerIds: ['sq-a'], heldSqspCustomerIds: ['sq-a', 'sq-b'] }
    const anaRow = intent({ id: 'i0', state: 'matched', orderId: 'o-old', orderSqspCustomerId: 'sq-b' })
    expect(linkCustomer(who(at, { sqspCustomerId: 'sq-b', phone: '2015550188' }), [anaAll], [intent(), anaRow])).toMatchObject({
      customerId: 'c-ana',
      by: 'checkout_intent',
      intent: { id: 'i1', fresh: true },
    })
  })

  it('a refused intent never holds the owner’s order hostage: two clients’ refused intents still let the owner link (F1)', () => {
    const linked: CustomerRef = { ...bob, sqspCustomerIds: ['sq-1'] }
    const eve = intent({ id: 'i-eve', customerId: 'c-eve', expectedEmail: 'bob@example.com' })
    const mal = intent({ id: 'i-mal', customerId: 'c-mal', expectedEmail: 'bob@example.com' })
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { email: 'bob@example.com', sqspCustomerId: 'sq-1' }), [linked], [eve, mal])).toMatchObject({
      customerId: 'c-bob',
      by: 'sqsp_customer_id',
    })
  })

  it('a matched intent never binds a Squarespace customer another client holds: not its renewals, not even its bound order (F1)', () => {
    // a renewal from the bound order's Squarespace customer, which another client holds (any link, their membership row)
    const matched = intent({ state: 'matched', orderId: 'o-first', orderSqspCustomerId: 'sq-bob' })
    const legacy: CustomerRef = { id: 'c-bob', emails: [], unverifiedEmails: ['bob@example.com'], phones: [], heldSqspCustomerIds: ['sq-bob'] }
    const renewal = who('2026-11-12T09:00:00Z', { orderId: 'o-2', sqspCustomerId: 'sq-bob', email: 'bob@example.com' })
    expect(linkCustomer(renewal, [legacy], [matched])).toEqual({ by: 'unverified_email', candidateCustomerId: 'c-bob', intentConflict: 'i1' })
    // loadIntentRefs marks a row an intent matched by itself whose order's Squarespace customer another client holds: it binds
    // nothing, even when the other client is not among the order's candidates
    const held = { ...matched, orderHeldByAnother: true }
    expect(linkCustomer(renewal, [], [held])).toEqual({ by: 'none' })
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { orderId: 'o-first', sqspCustomerId: 'sq-bob' }), [], [held])).toEqual({ by: 'none' })
  })

  it('the honest case: a brand-new client’s intent takes the order of a new Squarespace customer, and its renewals follow', () => {
    const nina: CustomerRef = { id: 'c-nina', emails: [], unverifiedEmails: ['nina@example.com'], phones: [] }
    const open = intent({ id: 'i-nina', customerId: 'c-nina', membershipId: 'm-nina', expectedEmail: 'nina@example.com' })
    expect(linkCustomer(who('2026-10-12T09:00:00Z', { email: 'nina@example.com', sqspCustomerId: 'sq-new' }), [nina, bob], [open])).toEqual({
      customerId: 'c-nina',
      by: 'checkout_intent',
      intent: { id: 'i-nina', fresh: true },
    })
    // matched; the contacts job then linked sq-new to Nina by her email, and the sync wrote it on her membership
    const matched = { ...open, state: 'matched' as const, orderId: 'o-x', orderSqspCustomerId: 'sq-new' }
    const ninaHeld: CustomerRef = { ...nina, heldSqspCustomerIds: ['sq-new'] }
    expect(
      linkCustomer(who('2026-11-12T09:00:00Z', { email: 'nina@example.com', orderId: 'o-y', sqspCustomerId: 'sq-new' }), [ninaHeld, bob], [matched]),
    ).toEqual({ customerId: 'c-nina', by: 'checkout_intent', intent: { id: 'i-nina', fresh: false } })
    // Eve opening an intent with Nina's email later takes none of Nina's renewals
    const eve = intent({ id: 'i-eve', customerId: 'c-eve', membershipId: 'm-eve', expectedEmail: 'nina@example.com', startedAt: new Date('2026-12-11T12:00:00Z'), expiresAt: new Date('2026-12-14T12:00:00Z') })
    expect(
      linkCustomer(who('2026-12-12T09:00:00Z', { email: 'nina@example.com', orderId: 'o-z', sqspCustomerId: 'sq-new' }), [ninaHeld], [matched, eve]),
    ).toEqual({ customerId: 'c-nina', by: 'checkout_intent', intent: { id: 'i-nina', fresh: false } })
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
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [], [intent(), other])).toEqual({ by: 'ambiguous' })
    // with Ana's email on file (even unverified) Bob's intent naming it is refused, and Ana's own intent links
    expect(linkCustomer(who('2026-10-12T09:00:00Z'), [ana, bob], [intent(), other])).toMatchObject({ customerId: 'c-ana', by: 'checkout_intent' })
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
    // the renewal is not Eve's and the intent is not consumed: it is Bob's, as it would be without the intent, with no flag
    expect(during).toEqual([expect.objectContaining({ customerId: 'c-bob', status: 'active', paidOrderCount: 2, lastOrderId: o2.id, flags: [] })])
    expect(during.flatMap((m) => m.checkoutMatches)).toEqual([])
    // the legacy member (email never verified, the contact linked by that email) is held the same way: staff are asked about Bob
    const legacy: CustomerRef = { id: 'c-bob', emails: [], unverifiedEmails: ['bob@example.com'], phones: [], heldSqspCustomerIds: ['sq-bob'] }
    const held = inferMemberships([o1, o2], map, [legacy], new Date('2026-10-10T16:00:00Z'), {}, [eve])
    expect(held).toEqual([expect.objectContaining({ customerId: undefined, linkedBy: 'unverified_email', candidateCustomerId: 'c-bob', checkoutMatches: [] })])
    // an order no other tier links says why in its flag (the needs-customer alert repeats it)
    const stranger: CustomerRef = { id: 'c-bob', emails: [], phones: [], heldSqspCustomerIds: ['sq-bob'] }
    const [lone] = inferMemberships([o2], map, [stranger], new Date('2026-10-10T16:00:00Z'), {}, [eve])
    expect(lone).toMatchObject({ customerId: undefined, linkedBy: 'none', checkoutMatches: [] })
    expect(lone!.flags).toEqual([expect.objectContaining({ code: 'ambiguous_customer', orderId: o2.id })])
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
