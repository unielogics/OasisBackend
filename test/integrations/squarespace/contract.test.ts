import { describe, expect, it } from 'vitest'
import type { SquarespaceSource } from '../../../src/integrations/ports/squarespace.js'
import { InProcessSquarespace } from '../../../src/integrations/squarespace/sim/fake.js'
import { SquarespaceNotFoundError } from '../../../src/integrations/squarespace/errors.js'
import type { SquarespaceSimStore } from '../../../src/integrations/squarespace/sim/store.js'
import { clientFor, drain, loadFixtures, rig, WINDOW } from './helpers.js'

/**
 * One contract suite, three drivers: the real client over the sim's HTTP surface with generated data, the same with
 * the recorded-shape fixtures, and the in-process fake. Whatever a SquarespaceSource must do, it does in all three.
 */
interface Harness {
  source: SquarespaceSource
  store: SquarespaceSimStore
}

type Driver = { name: string; make: (opts: { order: 'asc' | 'desc' }) => Harness }

const drivers: Driver[] = [
  {
    name: 'SquarespaceClient over simulator HTTP surface (generated)',
    make: ({ order }) => {
      const r = rig({ order })
      return { source: clientFor(r), store: r.store }
    },
  },
  {
    name: 'in-process fake',
    make: ({ order }) => {
      const r = rig({ order })
      return { source: new InProcessSquarespace(r.store), store: r.store }
    },
  },
]

function seedGenerated(
  store: SquarespaceSimStore,
  clock = new Date('2026-10-01T10:00:00Z'),
): { ids: string[] } {
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const { orderId } = store.createOrder({
      email: `c${i}@example.com`,
      name: `Cust ${i}`,
      phone: `555010100${i}`,
      lineItems: [{ productId: `p${i}`, sku: `S${i}`, name: `Item ${i}`, unitCents: 1000 + i }],
      taxCents: 70,
      createdOn: new Date(clock.getTime() + i * 3600_000),
    })
    ids.push(orderId)
  }
  return { ids }
}

for (const d of drivers) {
  for (const order of ['asc', 'desc'] as const) {
    describe(`SquarespaceSource contract: ${d.name} (server order ${order})`, () => {
      it('pages through every order exactly once, without relying on server ordering', async () => {
        const h = d.make({ order })
        const { ids } = seedGenerated(h.store)
        const { items, pages } = await drain((cursor) => h.source.listOrders({ ...WINDOW, cursor }))
        expect(pages).toBe(3) // 5 orders, page size 2
        expect(items.map((o) => o.id).sort()).toEqual([...ids].sort())
        expect(new Set(items.map((o) => o.id)).size).toBe(5)
      })

      it('applies modifiedAfter/modifiedBefore as an open interval', async () => {
        const h = d.make({ order })
        seedGenerated(h.store)
        const after = new Date('2026-10-01T11:00:00.000Z') // order 1 is created exactly then: excluded
        const before = new Date('2026-10-01T13:00:00.000Z') // order 3 exactly then: excluded
        const { items } = await drain((cursor) =>
          h.source.listOrders({ modifiedAfter: after, modifiedBefore: before, cursor }),
        )
        expect(items.map((o) => o.customerEmail)).toEqual(['c2@example.com'])
      })

      it('maps money to integer cents and keeps raw payloads', async () => {
        const h = d.make({ order })
        h.store.createOrder({
          email: 'a@example.com',
          lineItems: [{ name: 'Wash', unitCents: 5900 }],
          taxCents: 413,
        })
        const { items } = await drain((cursor) =>
          h.source.listOrders({ ...WINDOW, modifiedBefore: new Date('2026-10-07T00:00:00Z'), cursor }),
        )
        expect(items[0]).toMatchObject({
          grandTotalCents: 6313,
          taxCents: 413,
          subtotalCents: 5900,
          paymentState: 'PAID',
        })
        expect(items[0]!.raw).toMatchObject({ grandTotal: { value: 63.13 } })
      })

      it('getOrder returns one order and throws NotFound for an unknown id', async () => {
        const h = d.make({ order })
        const { orderId } = h.store.createOrder({
          email: 'a@example.com',
          lineItems: [{ name: 'Wash', unitCents: 5900 }],
        })
        expect((await h.source.getOrder(orderId)).id).toBe(orderId)
        await expect(h.source.getOrder('deadbeef')).rejects.toBeInstanceOf(SquarespaceNotFoundError)
      })

      it('lists payments and refunds as separate transactions and includes partially paid orders', async () => {
        const h = d.make({ order })
        const a = h.store.createOrder({
          email: 'a@example.com',
          lineItems: [{ name: 'Detail', unitCents: 10000 }],
          pay: { amountCents: 4000, brand: 'AMEX' },
        })
        const b = h.store.createOrder({
          email: 'b@example.com',
          lineItems: [{ name: 'Wash', unitCents: 5000 }],
        })
        h.store.refund(b.orderId, { amountCents: 1500 })
        const win = { ...WINDOW, modifiedBefore: new Date('2026-10-07T00:00:00Z') }
        const orders = (await drain((cursor) => h.source.listOrders({ ...win, cursor }))).items
        expect(orders.find((o) => o.id === a.orderId)!.paymentState).toBe('PARTIALLY_PAID')
        expect(orders.find((o) => o.id === b.orderId)!.paymentState).toBe('REFUNDED')
        const txns = (await drain((cursor) => h.source.listTransactions({ ...win, cursor }))).items
        const forB = txns.filter((t) => t.orderId === b.orderId).map((t) => [t.kind, t.amountCents])
        expect(forB.sort()).toEqual([
          ['payment', 5000],
          ['refund', 1500],
        ])
        expect(txns.find((t) => t.orderId === a.orderId)).toMatchObject({
          kind: 'payment',
          brand: 'AMEX',
          amountCents: 4000,
        })
        expect(txns.find((t) => t.kind === 'refund')!.paymentId).toBe(
          txns.find((t) => t.orderId === b.orderId && t.kind === 'payment')!.id,
        )
      })

      it('lists contacts with cursor paging', async () => {
        const h = d.make({ order })
        seedGenerated(h.store)
        const { items } = await drain((cursor) => h.source.listContacts({ cursor }))
        expect(items.map((c) => c.email).sort()).toEqual([0, 1, 2, 3, 4].map((i) => `c${i}@example.com`))
        expect(items.find((c) => c.email === 'c3@example.com')).toMatchObject({
          name: 'Cust 3',
          phone: '5550101003',
        })
      })

      it('surfaces test-mode orders so the sync layer can decide', async () => {
        const h = d.make({ order })
        h.store.createOrder({
          email: 't@example.com',
          lineItems: [{ name: 'Wash', unitCents: 5000 }],
          testMode: true,
        })
        const { items } = await drain((cursor) =>
          h.source.listOrders({ ...WINDOW, modifiedBefore: new Date('2026-10-07T00:00:00Z'), cursor }),
        )
        expect(items[0]!.testMode).toBe(true)
      })
    })
  }
}

describe('SquarespaceSource contract: client over simulator HTTP surface (recorded-shape fixtures)', () => {
  it('reads the fixture set end to end', async () => {
    const r = rig({ pageSize: 4 })
    loadFixtures(r.store)
    const client = clientFor(r)
    const orders = await drain((cursor) => client.listOrders({ ...WINDOW, cursor }))
    expect(orders.items).toHaveLength(9)
    expect(orders.pages).toBe(3)
    const txns = await drain((cursor) => client.listTransactions({ ...WINDOW, cursor }))
    // 10 documents: 9 orders + 1 donation; payments: 1+1+1+1+1+1+2+1+1+1 = 11, refunds: 2
    expect(txns.items.filter((t) => t.kind === 'payment')).toHaveLength(11)
    expect(txns.items.filter((t) => t.kind === 'refund')).toHaveLength(2)
    const contacts = await drain((cursor) => client.listContacts({ cursor }))
    expect(contacts.items).toHaveLength(4)
    expect((await client.getOrder('64f0a1000000000000000004')).refundedTotalCents).toBe(2000)
    expect(
      txns.items.every(
        (t) => t.brand === undefined || /^(VISA|MASTERCARD|AMEX|DISCOVER|JCB|OTHER)$/.test(t.brand),
      ),
    ).toBe(true)
  })

  it('narrows to one order through the orderId filter', async () => {
    const r = rig({ pageSize: 4 })
    loadFixtures(r.store)
    const client = clientFor(r)
    const page = await client.listTransactionsForOrder('64f0a1000000000000000007')
    expect(page.items.map((t) => t.amountCents)).toEqual([30000, 32100])
  })
})
