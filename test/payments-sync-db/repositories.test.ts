import { describe, expect, it } from 'vitest'
import type { SqspContact, SqspOrder, SqspTransaction } from '../../src/integrations/ports/squarespace.js'
import {
  PgContactRepository,
  PgOrderRepository,
  PgSyncErrorRepository,
  PgSyncStateRepository,
  PgTransactionRepository,
} from '../../src/modules/payments-sync/db/repositories.js'
import { D, useRig } from './harness.js'

const order = (over: Partial<SqspOrder> = {}): SqspOrder => ({
  id: 'o-1',
  orderNumber: '1001',
  createdOn: new Date('2026-10-05T12:00:00Z'),
  modifiedOn: new Date('2026-10-05T12:00:00Z'),
  customerEmail: 'maria@example.com',
  customerName: 'Maria Alvarez',
  customerPhone: '5557120188',
  customerId: 'c-1',
  isSubscription: false,
  grandTotalCents: 20223,
  refundedTotalCents: 0,
  currency: 'USD',
  testMode: false,
  paymentState: 'PAID',
  taxCents: 1323,
  lineItems: [{ productId: 'p-1', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900, qty: 1 }],
  raw: { id: 'o-1', wire: true },
  ...over,
})

const txn = (over: Partial<SqspTransaction> = {}): SqspTransaction => ({
  id: 't-1',
  orderId: 'o-1',
  kind: 'payment',
  createdOn: new Date('2026-10-05T12:01:00Z'),
  amountCents: 20223,
  currency: 'USD',
  brand: 'VISA',
  documentId: 'd-1',
  documentModifiedOn: new Date('2026-10-05T12:01:00Z'),
  provider: 'STRIPE',
  raw: { id: 't-1' },
  ...over,
})

describe('Postgres sync repositories', () => {
  const rig = useRig()
  const repos = () => {
    const r = rig()
    const d = { db: r.db, locationId: r.locationId, newId: r.newId, now: () => r.clock.now() }
    return {
      orders: new PgOrderRepository(d),
      txns: new PgTransactionRepository(d),
      contacts: new PgContactRepository(d),
      state: new PgSyncStateRepository(r.db, r.locationId, () => r.clock.now()),
      errors: new PgSyncErrorRepository(r.db, r.locationId, r.newId, () => r.clock.now()),
      now: r.clock.now(),
    }
  }
  const initial = { matchState: 'unmatched' as const }

  it('orders: insert, identical payload is unchanged, a newer payload updates, an older one is stale', async () => {
    const { orders, now } = repos()
    expect(await orders.upsert(order(), { now, initial })).toBe('inserted')
    expect(await orders.upsert(order(), { now, initial })).toBe('unchanged')
    const newer = order({
      modifiedOn: new Date('2026-10-05T13:00:00Z'),
      paymentState: 'REFUNDED',
      refundedTotalCents: 5000,
    })
    expect(await orders.upsert(newer, { now, initial })).toBe('updated')
    expect(await orders.upsert(order(), { now, initial })).toBe('stale')
    const stored = await orders.get('o-1')
    expect(stored?.order.paymentState).toBe('REFUNDED')
    expect(stored?.order.refundedTotalCents).toBe(5000)
    expect(stored?.order.createdOn).toBeInstanceOf(Date)
    expect(stored?.order.lineItems[0]?.sku).toBe('DET-SEDAN')
    expect(stored?.order.raw).toEqual({ id: 'o-1', wire: true })
  })

  it('orders: match fields survive a re-sync and setMatch round-trips', async () => {
    const { orders, now } = repos()
    await orders.upsert(order(), { now, initial })
    await orders.setMatch('o-1', { matchState: 'auto' })
    await orders.upsert(order({ modifiedOn: new Date('2026-10-05T14:00:00Z'), grandTotalCents: 20300 }), {
      now,
      initial: { matchState: 'unmatched' },
    })
    const stored = await orders.get('o-1')
    expect(stored?.matchState).toBe('auto')
    expect(stored?.order.grandTotalCents).toBe(20300)
    await orders.setMatch('o-1', { matchState: 'ignored', ignoreReason: 'test_mode' })
    expect((await orders.get('o-1'))?.ignoreReason).toBe('test_mode')
    await expect(orders.setMatch('missing', { matchState: 'auto' })).rejects.toThrow(/not stored/)
  })

  it('orders: initial state applies on insert only; lists by state and by modified window', async () => {
    const { orders, now } = repos()
    await orders.upsert(order({ id: 'o-a' }), {
      now,
      initial: { matchState: 'ignored', ignoreReason: 'test_mode' },
    })
    await orders.upsert(
      order({
        id: 'o-b',
        createdOn: new Date('2026-10-04T00:00:00Z'),
        modifiedOn: new Date('2026-10-04T00:00:00Z'),
      }),
      {
        now,
        initial,
      },
    )
    await orders.upsert(order({ id: 'o-c' }), { now, initial })
    expect((await orders.listByMatchState('unmatched', 10)).map((o) => o.order.id)).toEqual(['o-b', 'o-c'])
    expect((await orders.listByMatchState('ignored', 10)).map((o) => o.order.id)).toEqual(['o-a'])
    const win = await orders.listModifiedBetween(
      new Date('2026-10-04T12:00:00Z'),
      new Date('2026-10-06T00:00:00Z'),
    )
    expect(win.map((o) => o.order.id).sort()).toEqual(['o-a', 'o-c'])
  })

  it('transactions: same outcomes, state survives, document version decides staleness', async () => {
    const { txns, now } = repos()
    const ini = { state: 'new' as const }
    expect(await txns.upsert(txn(), { now, initial: ini })).toBe('inserted')
    expect(await txns.upsert(txn(), { now, initial: ini })).toBe('unchanged')
    await txns.setState('t-1', { state: 'matched', matchedEventId: undefined })
    const newer = txn({ documentModifiedOn: new Date('2026-10-06T00:00:00Z'), voided: true })
    expect(await txns.upsert(newer, { now, initial: ini })).toBe('updated')
    expect(await txns.upsert(txn(), { now, initial: ini })).toBe('stale')
    const s = await txns.get('t-1')
    expect(s?.state).toBe('matched')
    expect(s?.txn.voided).toBe(true)
    await txns.upsert(
      txn({ id: 't-2', kind: 'refund', amountCents: 500, createdOn: new Date('2026-10-05T15:00:00Z') }),
      { now, initial: ini },
    )
    expect((await txns.listByOrder('o-1')).map((t) => t.txn.id)).toEqual(['t-1', 't-2'])
    expect((await txns.listByState(['new'], 10)).map((t) => t.txn.id)).toEqual(['t-2'])
    await expect(txns.setState('nope', { state: 'ignored' })).rejects.toThrow(/not stored/)
  })

  it('the matcher’s first page puts matchable orders and new transactions ahead of unpaid orders and deferred refunds', async () => {
    const { orders, txns, now } = repos()
    // 3 older unpaid orders (no payment yet) and 1 newer paid one: with a page of 2 the paid one must be on it
    for (const i of [1, 2, 3])
      await orders.upsert(
        order({
          id: `unpaid-${i}`,
          paymentState: 'NOT_CHARGED',
          createdOn: new Date(`2026-10-0${i}T10:00:00Z`),
          modifiedOn: new Date(`2026-10-0${i}T10:00:00Z`),
        }),
        { now, initial },
      )
    await orders.upsert(
      order({
        id: 'paid',
        createdOn: new Date('2026-10-05T10:00:00Z'),
        modifiedOn: new Date('2026-10-05T10:00:00Z'),
      }),
      { now, initial },
    )
    expect((await orders.listByMatchState('unmatched', 2)).map((o) => o.order.id)).toEqual([
      'paid',
      'unpaid-1',
    ])
    // an unpaid-looking order that already has a transaction is matchable
    await orders.upsert(
      order({
        id: 'part',
        paymentState: 'PARTIALLY_PAID',
        createdOn: new Date('2026-10-06T10:00:00Z'),
        modifiedOn: new Date('2026-10-06T10:00:00Z'),
      }),
      { now, initial },
    )
    await orders.upsert(
      order({
        id: 'pending-with-txn',
        paymentState: 'PENDING',
        createdOn: new Date('2026-10-07T10:00:00Z'),
        modifiedOn: new Date('2026-10-07T10:00:00Z'),
      }),
      { now, initial },
    )
    await txns.upsert(txn({ id: 't-pw', orderId: 'pending-with-txn' }), { now, initial: { state: 'new' } })
    expect((await orders.listByMatchState('unmatched', 4)).map((o) => o.order.id)).toEqual([
      'paid',
      'part',
      'pending-with-txn',
      'unpaid-1',
    ])
    // deferred refunds go after new transactions, however old
    await txns.upsert(
      txn({
        id: 't-old-deferred',
        kind: 'refund',
        createdOn: new Date('2026-09-01T10:00:00Z'),
        documentModifiedOn: new Date('2026-09-01T10:00:00Z'),
      }),
      { now, initial: { state: 'deferred' } },
    )
    await txns.upsert(
      txn({
        id: 't-new',
        createdOn: new Date('2026-10-05T10:00:00Z'),
        documentModifiedOn: new Date('2026-10-05T10:00:00Z'),
      }),
      { now, initial: { state: 'new' } },
    )
    expect((await txns.listByState(['new', 'deferred'], 10)).map((t) => t.txn.id)).toEqual([
      't-new',
      't-pw',
      't-old-deferred',
    ])
  })

  it('contacts: upsert outcomes and listing', async () => {
    const { contacts, now } = repos()
    const c: SqspContact = { id: 'c-1', email: 'maria@example.com', name: 'Maria', phone: '5557120188' }
    expect(await contacts.upsert(c, { now })).toBe('inserted')
    expect(await contacts.upsert(c, { now })).toBe('unchanged')
    expect(await contacts.upsert({ ...c, name: 'Maria Alvarez' }, { now })).toBe('updated')
    const list = await contacts.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.contact.name).toBe('Maria Alvarez')
    expect(list[0]?.customerId).toBeUndefined()
  })

  it('sync state round-trips the in-flight window, watermark and failure counters', async () => {
    const { state, now } = repos()
    expect(await state.get('orders')).toBeUndefined()
    await state.save({
      resource: 'orders',
      watermark: now,
      inFlight: { from: new Date(now.getTime() - D), to: now, cursor: 'abc' },
      status: 'partial',
      lastRunAt: now,
      consecutiveFailures: 2,
      lastError: 'boom',
    })
    const s = await state.get('orders')
    expect(s?.watermark?.toISOString()).toBe(now.toISOString())
    expect(s?.inFlight?.cursor).toBe('abc')
    expect(s?.inFlight?.from.getTime()).toBe(now.getTime() - D)
    expect(s?.consecutiveFailures).toBe(2)
    await state.save({
      ...s!,
      inFlight: undefined,
      status: 'ok',
      consecutiveFailures: 0,
      lastError: undefined,
    })
    const after = await state.get('orders')
    expect(after?.inFlight).toBeUndefined()
    expect(after?.status).toBe('ok')
  })

  it('errors: attempts count per key, dead-letter at 5, clear resolves, a new failure starts over', async () => {
    const r = rig()
    const { errors, now } = repos()
    const e = {
      resource: 'orders' as const,
      key: 'o-9',
      kind: 'persist' as const,
      message: 'db down',
      at: now,
    }
    for (let i = 1; i <= 4; i++) expect((await errors.record(e)).attempts).toBe(i)
    let dead = await r.db.selectFrom('sqsp_sync_errors').select('dead_lettered_at').executeTakeFirstOrThrow()
    expect(dead.dead_lettered_at).toBeNull()
    expect((await errors.record(e)).attempts).toBe(5)
    dead = await r.db.selectFrom('sqsp_sync_errors').select('dead_lettered_at').executeTakeFirstOrThrow()
    expect(dead.dead_lettered_at).not.toBeNull()
    expect(await errors.list('orders')).toHaveLength(1)
    await errors.clear('orders', 'o-9')
    expect(await errors.list()).toHaveLength(0)
    expect((await errors.record(e)).attempts).toBe(1)
    const row = await r.db
      .selectFrom('sqsp_sync_errors')
      .select(['dead_lettered_at', 'resolved_at'])
      .executeTakeFirstOrThrow()
    expect(row.dead_lettered_at).toBeNull()
    expect(row.resolved_at).toBeNull()
    await errors.record({ ...e, key: 'o-10', kind: 'mapping', raw: { bad: true } })
    expect((await errors.list('orders')).find((x) => x.key === 'o-10')?.raw).toEqual({ bad: true })
  })
})
