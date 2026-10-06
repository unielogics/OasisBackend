import { describe, expect, it } from 'vitest'
import { SquarespaceApiError } from '../../src/integrations/squarespace/errors.js'
import { SyncEngine } from '../../src/modules/payments-sync/sync.js'
import { NOW } from '../fixtures/squarespace/load.js'
import { loadFixtureStore, syncRig } from './helpers.js'

const MIN = 60_000
const DAY = 86_400_000
// One chunk, 90 days back (the fixtures include a 63-day-old order), no request cap.
const WIDE = { initialLookbackMs: 90 * DAY, maxWindowMs: 400 * DAY, maxRequestsPerRun: 500 }

describe('SyncEngine.pollOrders / pollTransactions', () => {
  it('ingests everything on the first run and is a no-op on the second (idempotent)', async () => {
    const r = syncRig({ cfg: WIDE })
    loadFixtureStore(r.store)
    const first = await r.engine.runCycle()
    expect(first.orders).toMatchObject({ status: 'ok', seen: 9, inserted: 9 })
    expect(first.transactions).toMatchObject({ status: 'ok', seen: 13, inserted: 13 })
    const writes = [r.repos.orders.writes, r.repos.transactions.writes]
    // the next poll only re-reads the overlap window, so nothing new is seen...
    const second = await r.engine.runCycle()
    expect(second.orders).toMatchObject({ status: 'ok', seen: 0 })
    // ...and a full re-read (reconcile) upserts the same 9 orders and 13 transactions without writing anything
    const full = await r.engine.reconcile({ days: 90 })
    expect(full.orders).toMatchObject({ seen: 9, inserted: 0, updated: 0, unchanged: 9 })
    expect(full.transactions).toMatchObject({ seen: 13, inserted: 0, updated: 0, unchanged: 13 })
    expect([r.repos.orders.writes, r.repos.transactions.writes]).toEqual(writes)
    expect(r.repos.orders.rows.size).toBe(9)
  })

  it('advances the watermark to the request time and re-reads from watermark minus the overlap', async () => {
    const r = syncRig({ cfg: WIDE })
    loadFixtureStore(r.store)
    await r.engine.pollOrders()
    const state = await r.repos.state.get('orders')
    expect(state!.watermark!.toISOString()).toBe(NOW)
    expect(state!.status).toBe('ok')
    r.source.calls = []
    r.clock.advance(2 * MIN)
    await r.engine.pollOrders()
    const call = r.source.calls[0]!
    expect(call.after!.getTime()).toBe(Date.parse(NOW) - 5 * MIN)
    expect(call.before!.getTime()).toBe(Date.parse(NOW) + 2 * MIN)
  })

  it('first run looks back 45 days in chunks of at most 7 days and persists progress per chunk', async () => {
    const r = syncRig({ pageSize: 50 })
    await r.engine.pollOrders()
    const windows = r.source.calls.map((c) => [c.after!.getTime(), c.before!.getTime()] as const)
    expect(windows.length).toBe(Math.ceil((45 * DAY + 5 * MIN) / (7 * DAY - 5 * MIN)))
    for (const [a, b] of windows) expect(b - a).toBeLessThanOrEqual(7 * DAY)
    expect(windows[0]![0]).toBe(Date.parse(NOW) - 45 * DAY - 5 * MIN)
    expect(windows.at(-1)![1]).toBe(Date.parse(NOW))
    for (let i = 1; i < windows.length; i++) expect(windows[i]![0]).toBe(windows[i - 1]![1] - 5 * MIN)
  })

  it('keeps chunk progress when a later chunk fails, and resumes from there', async () => {
    const r = syncRig({ pageSize: 50 })
    r.source.failNext.push({ fn: 'listOrders', error: new Error('network down'), times: 1 })
    // let the first chunk through, then fail the second
    const real = r.source.listOrders.bind(r.source)
    let n = 0
    r.source.listOrders = async (p) => {
      if (++n === 3) throw new Error('boom on chunk 3')
      return real(p)
    }
    r.source.failNext.length = 0
    const res = await r.engine.pollOrders()
    expect(res.status).toBe('error')
    const state = await r.repos.state.get('orders')
    expect(state!.watermark!.getTime()).toBe(
      Date.parse(NOW) - 45 * DAY - 5 * MIN + 7 * DAY - 5 * MIN + 7 * DAY,
    )
    expect(state!.inFlight).toBeDefined()
    expect(state!.consecutiveFailures).toBe(1)
    r.source.listOrders = real
    r.source.calls = []
    const again = await r.engine.pollOrders()
    expect(again.status).toBe('ok')
    expect(r.source.calls[0]!.after!.getTime()).toBe(state!.inFlight!.from.getTime())
    expect((await r.repos.state.get('orders'))!.consecutiveFailures).toBe(0)
  })

  it('a record committed late inside the overlap is still picked up; one older than the overlap is only caught by reconcile', async () => {
    const r = syncRig({ pageSize: 50 })
    await r.engine.pollOrders()
    r.clock.advance(10 * MIN)
    const inside = r.store.createOrder({
      email: 'late@example.com',
      lineItems: [{ name: 'Wash', unitCents: 5000 }],
      createdOn: new Date(r.clock.now().getTime() - 12 * MIN),
    })
    const outside = r.store.createOrder({
      email: 'ancient@example.com',
      lineItems: [{ name: 'Wash', unitCents: 5000 }],
      createdOn: new Date(r.clock.now().getTime() - 2 * 3600_000),
    })
    const poll = await r.engine.pollOrders()
    // watermark was NOW, overlap 5 min: window starts at NOW-5min, i.e. 14 minutes before the clock.
    expect(r.repos.orders.rows.has(inside.orderId)).toBe(true)
    expect(r.repos.orders.rows.has(outside.orderId)).toBe(false)
    expect(poll.inserted).toBe(1)
    const rec = await r.engine.reconcile()
    expect(rec.complete).toBe(true)
    expect(rec.orders.inserted).toBe(1)
    expect(r.repos.orders.rows.has(outside.orderId)).toBe(true)
  })

  it('does not trust server ordering: descending pages with one item each still ingest everything once', async () => {
    const r = syncRig({ pageSize: 1, order: 'desc', cfg: WIDE })
    loadFixtureStore(r.store)
    const res = await r.engine.pollOrders()
    expect(res).toMatchObject({ status: 'ok', seen: 9, inserted: 9 })
  })

  it('never regresses a row: an older version arriving later is reported stale', async () => {
    const r = syncRig({ pageSize: 50 })
    const { orderId } = r.store.createOrder({
      email: 'a@example.com',
      lineItems: [{ name: 'Wash', unitCents: 5000 }],
    })
    r.clock.advance(1000)
    await r.engine.pollOrders()
    const stored = (await r.repos.orders.get(orderId))!.order
    r.clock.advance(60_000)
    r.store.refund(orderId, { amountCents: 1000 })
    expect(await r.engine.ingestOrder(orderId)).toBe('updated')
    expect((await r.repos.orders.get(orderId))!.order.refundedTotalCents).toBe(1000)
    const outcome = await r.repos.orders.upsert(stored, {
      now: r.clock.now(),
      initial: { matchState: 'unmatched' },
    })
    expect(outcome).toBe('stale')
    expect((await r.repos.orders.get(orderId))!.order.refundedTotalCents).toBe(1000)
    expect(await r.engine.ingestOrder(orderId)).toBe('unchanged')
  })

  it('keeps match fields when an order is updated', async () => {
    const r = syncRig({ pageSize: 50 })
    const { orderId } = r.store.createOrder({
      email: 'a@example.com',
      lineItems: [{ name: 'Wash', unitCents: 5000 }],
    })
    r.clock.advance(1000)
    await r.engine.pollOrders()
    await r.repos.orders.setMatch(orderId, { matchState: 'auto', matchedInvoiceId: 'inv-1' })
    r.clock.advance(60_000)
    r.store.refund(orderId, { amountCents: 500 })
    await r.engine.ingestOrder(orderId)
    expect(await r.repos.orders.get(orderId)).toMatchObject({ matchState: 'auto', matchedInvoiceId: 'inv-1' })
  })
})

describe('request budget', () => {
  it('stops at maxRequestsPerRun, saves the cursor, and the next runs finish without duplicates', async () => {
    const r = syncRig({ pageSize: 2, cfg: { ...WIDE, maxRequestsPerRun: 2 } })
    loadFixtureStore(r.store)
    const results = []
    for (let i = 0; i < 6; i++) {
      const res = await r.engine.pollOrders()
      results.push(res)
      if (res.status === 'ok') break
    }
    expect(results.slice(0, -1).every((x) => x.status === 'partial')).toBe(true)
    expect(results.at(-1)!.status).toBe('ok')
    expect(results.every((x) => x.requests <= 2)).toBe(true)
    expect(r.repos.orders.rows.size).toBe(9)
    expect(results.reduce((a, x) => a + x.inserted, 0)).toBe(9)
    expect((await r.repos.state.get('orders'))!.inFlight).toBeUndefined()
  })

  it('a partial run does not advance the watermark past unread data', async () => {
    const r = syncRig({ pageSize: 2, cfg: { ...WIDE, maxRequestsPerRun: 1 } })
    loadFixtureStore(r.store)
    const res = await r.engine.pollOrders()
    expect(res.status).toBe('partial')
    const s = (await r.repos.state.get('orders'))!
    expect(s.inFlight?.cursor).toBeDefined()
    expect(s.watermark).toBeUndefined()
  })
})

describe('test mode', () => {
  it('stores test-mode orders as ignored by default and their transactions as ignored', async () => {
    const r = syncRig({ pageSize: 50, cfg: WIDE })
    loadFixtureStore(r.store)
    const res = await r.engine.runCycle()
    expect(res.orders.ignoredTestMode).toBe(1)
    const test = (await r.repos.orders.get('64f0a1000000000000000005'))!
    expect(test).toMatchObject({ matchState: 'ignored', ignoreReason: 'test_mode' })
    const txns = await r.repos.transactions.listByOrder('64f0a1000000000000000005')
    expect(txns.map((t) => [t.state, t.ignoreReason])).toEqual([['ignored', 'test_mode']])
    expect((await r.repos.orders.listByMatchState('unmatched', 100)).length).toBe(8)
  })

  it('treats them as ordinary when the flag is on', async () => {
    const r = syncRig({ pageSize: 50, cfg: { ...WIDE, includeTestMode: true } })
    loadFixtureStore(r.store)
    await r.engine.runCycle()
    expect((await r.repos.orders.get('64f0a1000000000000000005'))!.matchState).toBe('unmatched')
    expect((await r.repos.transactions.listByOrder('64f0a1000000000000000005'))[0]!.state).toBe('new')
  })

  it('donations (no order) are ignored at ingest', async () => {
    const r = syncRig({ pageSize: 50, cfg: WIDE })
    loadFixtureStore(r.store)
    await r.engine.runCycle()
    const donations = [...r.repos.transactions.rows.values()].filter((t) => !t.txn.orderId)
    expect(donations).toHaveLength(1)
    expect(donations[0]).toMatchObject({ state: 'ignored', ignoreReason: 'no_order' })
  })
})

describe('failures and dead letter', () => {
  it('records errors, counts consecutive failures, dead-letters the resource, and resume() restores it', async () => {
    const r = syncRig({ cfg: { deadLetterAfterFailures: 3 } })
    r.source.failNext.push({
      fn: 'listOrders',
      error: new SquarespaceApiError(503, undefined, 'GET', '/x'),
      times: 10,
    })
    expect((await r.engine.pollOrders()).status).toBe('error')
    expect((await r.engine.pollOrders()).status).toBe('error')
    const third = await r.engine.pollOrders()
    expect(third.status).toBe('dead_letter')
    expect(third.error).toMatch(/503/)
    const calls = r.source.count('listOrders')
    const skipped = await r.engine.pollOrders()
    expect(skipped.status).toBe('skipped')
    expect(r.source.count('listOrders')).toBe(calls)
    r.source.failNext.length = 0
    await r.engine.resume('orders')
    expect((await r.engine.pollOrders()).status).toBe('ok')
  })

  it('a 400 on a saved cursor restarts that window instead of retrying the dead cursor forever', async () => {
    const r = syncRig({ pageSize: 2, cfg: WIDE })
    loadFixtureStore(r.store)
    const real = r.source.listOrders.bind(r.source)
    let n = 0
    r.source.listOrders = async (p) => {
      if (p.cursor && ++n === 1)
        throw new SquarespaceApiError(400, { type: 'INVALID_REQUEST_ERROR' }, 'GET', '/x')
      return real(p)
    }
    expect((await r.engine.pollOrders()).status).toBe('error')
    const s = (await r.repos.state.get('orders'))!
    expect(s.inFlight).toBeUndefined()
    expect((await r.engine.pollOrders()).status).toBe('ok')
    expect(r.repos.orders.rows.size).toBe(9)
  })

  it('a persist failure holds the watermark, then the item is dead-lettered after maxItemAttempts and the window moves on', async () => {
    const r = syncRig({ pageSize: 50, cfg: { ...WIDE, maxItemAttempts: 3, deadLetterAfterFailures: 99 } })
    loadFixtureStore(r.store)
    const real = r.repos.orders.upsert.bind(r.repos.orders)
    r.repos.orders.upsert = async (o, ctx) => {
      if (o.id === '64f0a1000000000000000003') throw new Error('db constraint violated')
      return real(o, ctx)
    }
    const a = await r.engine.pollOrders()
    expect(a).toMatchObject({ status: 'error', failed: 1 })
    expect((await r.repos.state.get('orders'))!.watermark).toBeUndefined()
    expect((await r.engine.pollOrders()).status).toBe('error')
    const c = await r.engine.pollOrders()
    expect(c).toMatchObject({ status: 'ok', deadLettered: 1, failed: 0 })
    expect((await r.repos.state.get('orders'))!.watermark).toBeDefined()
    expect(r.repos.orders.rows.size).toBe(8)
    const errs = await r.repos.errors.list('orders')
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ key: '64f0a1000000000000000003', kind: 'persist', attempts: 3 })
  })

  it('clears an item error once it later persists', async () => {
    const r = syncRig({ pageSize: 50, cfg: { ...WIDE, maxItemAttempts: 5 } })
    loadFixtureStore(r.store)
    const real = r.repos.orders.upsert.bind(r.repos.orders)
    let fail = true
    r.repos.orders.upsert = async (o, ctx) => {
      if (fail && o.id === '64f0a1000000000000000003') throw new Error('transient')
      return real(o, ctx)
    }
    await r.engine.pollOrders()
    expect(await r.repos.errors.list('orders')).toHaveLength(1)
    fail = false
    expect((await r.engine.pollOrders()).status).toBe('ok')
    expect(await r.repos.errors.list('orders')).toHaveLength(0)
  })

  it('rows the adapter rejected are dead-lettered immediately and do not block the watermark', async () => {
    const r = syncRig({ pageSize: 50, cfg: WIDE })
    loadFixtureStore(r.store)
    r.source.rejectIds = ['64f0a1000000000000000002']
    const res = await r.engine.pollOrders()
    expect(res).toMatchObject({ status: 'ok', rejected: 1, inserted: 8 })
    expect(await r.repos.errors.list('orders')).toEqual([
      expect.objectContaining({ key: '64f0a1000000000000000002', kind: 'mapping' }),
    ])
  })

  it('refuses a window configuration that cannot advance', () => {
    const r = syncRig()
    expect(
      () =>
        new SyncEngine({ ...({} as never), source: r.source } as never, {
          maxWindowMs: MIN,
          overlapMs: 5 * MIN,
        }),
    ).toThrow(/advance/)
  })
})

describe('contacts', () => {
  it('reads the whole list, idempotently, and resumes from a saved cursor', async () => {
    const r = syncRig({ cfg: { maxRequestsPerRun: 1 } })
    for (let i = 0; i < 7; i++)
      r.store.createOrder({
        email: `c${i}@example.com`,
        lineItems: [{ name: 'Wash', unitCents: 1000 }],
        pay: false,
      })
    const sizes: number[] = []
    for (let i = 0; i < 10; i++) {
      const res = await r.engine.syncContacts()
      sizes.push(r.repos.contacts.rows.size)
      if (res.status === 'ok') break
    }
    expect(r.repos.contacts.rows.size).toBe(7)
    const again = await r.engine.syncContacts()
    expect(again.status === 'ok' || again.status === 'partial').toBe(true)
  })
})

describe('reconcile', () => {
  it('re-reads 45 days of orders then transactions and reports orders Squarespace no longer returns', async () => {
    const r = syncRig({ pageSize: 50, cfg: WIDE })
    loadFixtureStore(r.store)
    await r.engine.runCycle()
    // an order we hold locally (e.g. deleted/archived remotely): not in the sim any more
    const ghost = (await r.repos.orders.get('64f0a1000000000000000001'))!.order
    await r.repos.orders.upsert(
      { ...ghost, id: 'ghost-order', modifiedOn: new Date('2026-09-20T00:00:00Z') },
      { now: r.clock.now(), initial: { matchState: 'unmatched' } },
    )
    const rep = await r.engine.reconcile({ days: 90 })
    expect(rep).toMatchObject({ status: 'ok', complete: true })
    expect(rep.orders.seen).toBe(9)
    expect(rep.orders.unchanged).toBe(9)
    expect(rep.transactions.seen).toBe(13)
    expect(rep.missingRemoteOrderIds).toEqual(['ghost-order'])
    expect(rep.windowEnd!.getTime() - rep.windowStart!.getTime()).toBe(90 * DAY)
  })

  it('does not move the poll watermarks', async () => {
    const r = syncRig({ pageSize: 50 })
    await r.engine.pollOrders()
    const before = (await r.repos.state.get('orders'))!.watermark
    r.clock.advance(DAY)
    await r.engine.reconcile()
    expect((await r.repos.state.get('orders'))!.watermark).toEqual(before)
  })

  it('resumes when the budget runs out and completes on a later invocation', async () => {
    const r = syncRig({ pageSize: 3, cfg: { ...WIDE, reconcileMaxRequests: 2 } })
    loadFixtureStore(r.store)
    const first = await r.engine.reconcile({ days: 90 })
    expect(first.status).toBe('partial')
    expect(first.complete).toBe(false)
    let last = first
    for (let i = 0; i < 10 && !last.complete; i++) last = await r.engine.reconcile({ days: 90 })
    expect(last.complete).toBe(true)
    expect(r.repos.orders.rows.size).toBe(9)
    expect(r.repos.transactions.rows.size).toBe(13)
    expect((await r.repos.state.get('reconcile'))!.status).toBe('ok')
  })
})

describe('health', () => {
  it('flags never-run, stale and dead-lettered resources', async () => {
    const r = syncRig()
    expect((await r.engine.health()).ok).toBe(false)
    await r.engine.runCycle()
    expect((await r.engine.health()).ok).toBe(true)
    r.clock.advance(11 * MIN)
    const stale = await r.engine.health()
    expect(stale.ok).toBe(false)
    expect(stale.resources.orders!.lagMs).toBe(11 * MIN)
  })
})
