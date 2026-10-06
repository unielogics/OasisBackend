import { describe, expect, it } from 'vitest'
import {
  mapContact,
  mapOrder,
  mapTransactionDocument,
} from '../../../src/integrations/squarespace/mappers.js'
import { decimalToCents } from '../../../src/integrations/squarespace/money.js'
import { SquarespaceMappingError } from '../../../src/integrations/squarespace/errors.js'
import { fixture } from '../../fixtures/squarespace/load.js'

describe('decimalToCents', () => {
  it.each([
    [49.99, 4999],
    [0.1 + 0.2, 30],
    [29.96, 2996],
    [1.005, 100],
    [159.43, 15943],
    [0, 0],
    [-12.34, -1234],
    ['10.50', 1050],
  ])('%s -> %i', (v, c) => expect(decimalToCents(v)).toBe(c))
  it('rejects non-finite', () => expect(() => decimalToCents(Number.NaN)).toThrow())
  it('never returns -0', () => expect(Object.is(decimalToCents(-0.001), 0)).toBe(true))
})

describe('mapOrder', () => {
  it('maps the documented sample order verbatim', () => {
    const o = mapOrder(fixture('docs-sample-order.json'))
    expect(o).toMatchObject({
      id: '585d498fdee9f31a60284a37',
      orderNumber: '3',
      customerEmail: 'bob@example.com',
      customerName: 'Bob Loblaw',
      customerPhone: '5553334444',
      customerId: '585d498fdee9f31a60284a38',
      grandTotalCents: 4999,
      refundedTotalCents: 4999,
      taxCents: 4999,
      currency: 'USD',
      testMode: true,
      paymentState: 'NOT_CHARGED',
      fulfillmentStatus: 'PENDING',
      channel: 'web',
      priceTaxInterpretation: 'EXCLUSIVE',
      externalOrderReference: 'EXT-98765',
      isSubscription: false,
    })
    expect(o.createdOn.toISOString()).toBe('2016-12-23T15:58:07.187Z')
    expect(o.lineItems).toEqual([
      {
        productId: '565c8f3da7c8a3cf71d5fd0a',
        sku: 'SQ3381024',
        name: 'Product',
        unitCents: 4999,
        qty: 1,
        lineItemType: 'PHYSICAL_PRODUCT',
        variantId: '88c16ee4-547b-445e-a392-bded9991ae30',
      },
    ])
    expect(o.raw).toEqual(fixture('docs-sample-order.json'))
  })

  it('maps every fixture order and keeps cents exact', () => {
    const orders = fixture<unknown[]>('orders.json').map((o) => mapOrder(o))
    expect(orders).toHaveLength(9)
    const premium = orders[0]!
    expect(premium.grandTotalCents).toBe(15943)
    expect(premium.taxCents).toBe(1043)
    expect(premium.customerPhone).toBe('5557120188')
    const pos = orders[7]!
    expect(pos.customerEmail).toBeUndefined()
    expect(pos.customerName).toBeUndefined()
    expect(pos.channel).toBe('pos')
    expect(orders[4]!.testMode).toBe(true)
    expect(orders[6]!.paymentState).toBe('PARTIALLY_PAID')
  })

  it('treats unknown payment states as UNKNOWN and tolerates null arrays', () => {
    const base = {
      ...fixture<Record<string, unknown>>('docs-sample-order.json'),
      lineItems: null,
      paymentState: 'SOMETHING_NEW',
    }
    const o = mapOrder(base)
    expect(o.paymentState).toBe('UNKNOWN')
    expect(o.lineItems).toEqual([])
  })

  it('flags subscriptions only by documented-adjacent heuristics (line item type or configured product ids)', () => {
    const raw = fixture<unknown[]>('orders.json')[0]
    expect(mapOrder(raw).isSubscription).toBe(false)
    expect(
      mapOrder(raw, { subscriptionProductIds: new Set(['64a1c0de0000000000000001']) }).isSubscription,
    ).toBe(true)
    const typed = structuredClone(raw) as { lineItems: { lineItemType: string }[] }
    typed.lineItems[0]!.lineItemType = 'SUBSCRIPTION'
    expect(mapOrder(typed).isSubscription).toBe(true)
  })

  it('throws a mapping error naming the problem for malformed orders', () => {
    expect(() => mapOrder({ id: 'x' })).toThrow(SquarespaceMappingError)
    expect(() => mapOrder({ ...fixture<object>('docs-sample-order.json'), createdOn: 'yesterday' })).toThrow(
      /createdOn/,
    )
  })
})

describe('mapTransactionDocument', () => {
  it('flattens the documented sample: payment plus a document-level refund linked to the only payment', () => {
    const rows = mapTransactionDocument(fixture('docs-sample-transaction-document.json'))
    expect(rows.map((r) => [r.kind, r.id, r.amountCents])).toEqual([
      ['payment', 'ece69479-50bc-4763-9067-4473f3abcf83', 4999],
      ['refund', 'cfdb6b87-64bf-461a-b48b-eca7bd2389fc', 4999],
    ])
    const [pay, refund] = rows
    expect(pay).toMatchObject({
      orderId: '5d71991aac180c3e7857e1df',
      brand: 'VISA',
      provider: 'STRIPE',
      voided: true,
    })
    expect(refund).toMatchObject({ paymentId: pay!.id, orderId: '5d71991aac180c3e7857e1df' })
    expect(pay!.createdOn.toISOString()).toBe('2019-09-05T23:24:09.845Z')
    expect(refund!.createdOn.toISOString()).toBe('2019-11-18T21:22:06.500Z')
  })

  it('reads refunds nested under the payment (schema shape) and does not duplicate them', () => {
    const docs = fixture<Record<string, unknown>[]>('transactions.json')
    const rows = mapTransactionDocument(docs[3])
    expect(rows.map((r) => [r.kind, r.amountCents, r.paymentId ?? null])).toEqual([
      ['payment', 6313, null],
      ['refund', 2000, rows[0]!.id],
    ])
    const dup = structuredClone(docs[3]) as { payments: { refunds: unknown[] }[]; refunds: unknown[] }
    dup.refunds = [...dup.payments[0]!.refunds]
    expect(mapTransactionDocument(dup)).toHaveLength(2)
  })

  it('handles multiple payments (payment plan), brand enum only, no last4, donations without an order', () => {
    const docs = fixture<Record<string, unknown>[]>('transactions.json')
    const plan = mapTransactionDocument(docs[6])
    expect(plan.map((r) => r.amountCents)).toEqual([30000, 32100])
    expect(plan.every((r) => r.brand === 'DISCOVER')).toBe(true)
    expect(Object.keys(plan[0]!)).not.toContain('last4')
    const donation = mapTransactionDocument(docs[9])
    expect(donation[0]!.orderId).toBeUndefined()
    const doclevel = mapTransactionDocument(docs[8])
    expect(doclevel.map((r) => r.kind)).toEqual(['payment', 'refund'])
    expect(doclevel[1]!.paymentId).toBe(doclevel[0]!.id)
  })

  it('rejects malformed documents', () => {
    expect(() => mapTransactionDocument({ id: 'x' })).toThrow(SquarespaceMappingError)
  })
})

describe('mapContact', () => {
  it('takes email from primaryEmail and phone from the default shipping address', () => {
    const c = fixture<unknown[]>('contacts.json').map(mapContact)
    expect(c[0]).toMatchObject({
      id: '64e0c0000000000000000001',
      email: 'maria.alvarez@example.com',
      name: 'Maria Alvarez',
      phone: '555-712-0188',
    })
    expect(c[3]!.phone).toBeUndefined()
    expect(c[0]!.createdOn?.toISOString()).toBe('2026-01-15T10:00:00.000Z')
  })
})
