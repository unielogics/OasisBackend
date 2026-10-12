// square.event.process, square.events.catchup and square.reconcile over Postgres and the simulator: the object is re-fetched, foreign
// merchants and locations are ignored, a webhook and the catch-up never both process one event, the watermark moves (and is held
// back by a failure), a stale watermark is an alert, and nothing runs with the defaults.
import { describe, expect, it } from 'vitest'
import { loadEnv, type Env } from '../../src/config/env.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { runSquareCatchup } from '../../src/modules/square/catchup.js'
import { currentSquareState, saveSquareState, getSquareState } from '../../src/modules/square/db/state.js'
import { processLoggedEvent, squareWebhookLog, type SquareEventDeps } from '../../src/modules/square/events.js'
import { noopSquareIngest, type SquareIngest } from '../../src/modules/square/ingest.js'
import { squareCatchupJob, squareEventJob, squareReconcileJob } from '../../src/modules/square/jobs/index.js'
import { runSquareReconcile } from '../../src/modules/square/reconcile.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { createLogger } from '../../src/platform/logging.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useTestDb } from '../helpers/db.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { liveEnvVars, simFor, useSquareRuntime } from './helpers.js'

const logger = createLogger({ level: 'silent' })

describe('Square jobs', () => {
  const t = useTestDb()
  const runtime = useSquareRuntime()
  const env = (vars: Record<string, string> = liveEnvVars): Env => loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...vars })

  async function rig(o: { vars?: Record<string, string>; ingest?: SquareIngest } = {}) {
    const clock = t.clock as FixedClock
    const newId = createIdGenerator(clock)
    const location = await ensureLocation(t.db, newId)
    const sim = simFor(clock)
    const e = env(o.vars)
    const calls: Array<{ kind: string; id: string }> = []
    const ingest: SquareIngest = o.ingest ?? {
      payment: async (c, p) => (calls.push({ kind: 'payment', id: p.id }), noopSquareIngest.payment(c, p)),
      refund: async (c, r) => (calls.push({ kind: 'refund', id: r.id }), noopSquareIngest.refund(c, r)),
      invoice: async (c, i) => (calls.push({ kind: 'invoice', id: i.id }), noopSquareIngest.invoice(c, i)),
      subscription: async (c, s) => (calls.push({ kind: 'subscription', id: s.id }), noopSquareIngest.subscription(c, s)),
      card: async (c, k, id) => (calls.push({ kind: 'card', id: k?.id ?? id }), noopSquareIngest.card(c, k, id)),
      customer: async (c, k, id) => (calls.push({ kind: 'customer', id }), noopSquareIngest.customer(c, k, id)),
    }
    const d: SquareEventDeps = { db: t.db, clock, logger, env: e, api: sim.api, ingest, newId }
    const log = squareWebhookLog(t.db, newId)
    const logEvent = async (ev: unknown, id = (ev as { event_id: string }).event_id) => {
      await log.claim(id, clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(ev) })
      return id
    }
    const pay = (cents: number, key: string) => sim.api.payments.create(sqKey('ch', key), { source_id: 'cnon:card-nonce-ok', amount_money: usd(cents), location_id: 'LSIMTEST0001' })
    return { clock, location, sim, env: e, d, log, logEvent, calls, pay, row: (id: string) => log.get(id) }
  }

  it('event.process: re-fetches the payment and closes the row processed; a processed row is not run twice', async () => {
    const r = await rig()
    const p = await r.pay(4000, 'p1')
    const ev = r.sim.store.events.find((e) => e.type === 'payment.created')!
    await r.logEvent(ev)
    expect(await processLoggedEvent(r.d, ev.event_id)).toBe('processed')
    expect(r.calls).toEqual([{ kind: 'payment', id: p.id }])
    expect(await r.row(ev.event_id)).toMatchObject({ status: 'processed', error: null })
    expect(await processLoggedEvent(r.d, ev.event_id)).toBe('done')
    expect(r.calls).toHaveLength(1)
    expect(await processLoggedEvent(r.d, 'no-such-event')).toBe('missing')
  })

  it('event.process ignores types it does not handle, objects that are gone, another location and another merchant', async () => {
    const r = await rig()
    const base = { merchant_id: r.sim.store.merchantId, created_at: '2026-06-13T14:00:00Z' }
    await r.logEvent({ ...base, type: 'order.updated', event_id: 'e-order', data: { type: 'order_updated', id: 'O1', object: {} } })
    await r.logEvent({ ...base, type: 'payment.updated', event_id: 'e-gone', data: { type: 'payment', id: 'NOPE', object: {} } })
    expect(await processLoggedEvent(r.d, 'e-order')).toBe('ignored')
    expect((await r.row('e-order'))!.error).toMatch(/order\.updated is not handled/)
    expect(await processLoggedEvent(r.d, 'e-gone')).toBe('ignored')
    expect((await r.row('e-gone'))!.error).toMatch(/no longer exists/)
    // our location is another one: the simulator's payment is not ours
    const r2 = { ...r.d, env: env({ ...liveEnvVars, SQUARE_LOCATION_ID: 'LOTHER' }) }
    const p = await r.pay(100, 'other-loc')
    await r.logEvent({ ...base, type: 'payment.updated', event_id: 'e-loc', data: { type: 'payment', id: p.id, object: {} } })
    expect(await processLoggedEvent(r2, 'e-loc')).toBe('ignored')
    expect((await r.row('e-loc'))!.error).toMatch(/another location/)
    // a known merchant: someone else's event is ignored
    await saveSquareState(t.db, r.location.id, r.env, r.clock.now(), { merchant_id: 'MOURS' })
    await r.logEvent({ ...base, merchant_id: 'MTHEIRS', type: 'payment.updated', event_id: 'e-merchant', data: { type: 'payment', id: p.id, object: {} } })
    expect(await processLoggedEvent(r.d, 'e-merchant')).toBe('ignored')
    expect(r.calls).toEqual([])
  })

  it('event.process: a merchant learned in another Square environment (the simulator, the sandbox) does not make our events foreign', async () => {
    const r = await rig()
    const p = await r.pay(100, 'env')
    const simEnv = env({})
    await saveSquareState(t.db, r.location.id, simEnv, r.clock.now(), { merchant_id: 'MSIMOASIS0001', events_enabled_at: r.clock.now() })
    await r.logEvent({ merchant_id: 'MREAL', created_at: '2026-06-13T14:00:00Z', type: 'payment.updated', event_id: 'e-real', data: { type: 'payment', id: p.id, object: {} } })
    expect(await processLoggedEvent(r.d, 'e-real')).toBe('processed')
    expect(r.calls).toEqual([{ kind: 'payment', id: p.id }])
  })

  it('square_state: one environment at a time; a save in another environment starts the row afresh, the same one keeps it', async () => {
    const r = await rig()
    const at = r.clock.now()
    const simEnv = env({})
    await saveSquareState(t.db, r.location.id, simEnv, at, {
      merchant_id: 'MSIM',
      events_enabled_at: at,
      webhook_subscription_id: 'wsub-sim',
      watermark: at,
      last_catchup_at: at,
      last_catchup_events: 7,
      last_test_at: at,
      last_test: { ok: true, at: at.toISOString(), checks: [] },
      last_error: 'x',
      last_error_at: at,
    })
    await saveSquareState(t.db, r.location.id, simEnv, at, { last_webhook_at: at })
    expect(await getSquareState(t.db, r.location.id)).toMatchObject({ environment: 'sim', merchant_id: 'MSIM', last_catchup_events: 7, last_error: 'x' })
    expect(await currentSquareState(t.db, r.location.id, simEnv)).toBeDefined()
    expect(await currentSquareState(t.db, r.location.id, r.env)).toBeUndefined()
    // the stack goes live (sandbox): what the save sets is kept, everything else learned from the simulator is gone
    await saveSquareState(t.db, r.location.id, r.env, at, { merchant_id: 'MSANDBOX' })
    const row = await getSquareState(t.db, r.location.id)
    expect(row).toMatchObject({
      environment: 'sandbox',
      merchant_id: 'MSANDBOX',
      events_enabled_at: null,
      webhook_subscription_id: null,
      watermark: null,
      last_webhook_at: null,
      last_catchup_at: null,
      last_catchup_events: 0,
      last_test_at: null,
      last_test: null,
      last_error: null,
    })
    expect(await currentSquareState(t.db, r.location.id, r.env)).toMatchObject({ merchant_id: 'MSANDBOX' })
  })

  it('event.process: a handler error marks the row failed and throws (pg-boss retries); the retry then processes it', async () => {
    let fail = true
    const r = await rig({
      ingest: {
        ...noopSquareIngest,
        payment: async (c, p) => {
          if (fail) throw new Error('database hiccup')
          return noopSquareIngest.payment(c, p)
        },
      },
    })
    await r.pay(100, 'f')
    const ev = r.sim.store.events.find((e) => e.type === 'payment.created')!
    await r.logEvent(ev)
    runtime({ env: r.env, api: r.sim.api, ingest: r.d.ingest })
    const ctx = { db: t.db, clock: r.clock, logger }
    await expect(squareEventJob.handler(ctx, { eventId: ev.event_id }, { id: 'j1' })).rejects.toThrow(/database hiccup/)
    expect(await r.row(ev.event_id)).toMatchObject({ status: 'failed', error: 'database hiccup' })
    fail = false
    await squareEventJob.handler(ctx, { eventId: ev.event_id }, { id: 'j1' })
    expect(await r.row(ev.event_id)).toMatchObject({ status: 'processed', error: null })
  })

  it('catch-up: reads the events, processes each once, skips what the webhook already claimed, keeps the watermark', async () => {
    const r = await rig()
    await r.pay(4000, 'a')
    r.clock.advance(1000)
    await r.pay(2500, 'b')
    const viaHook = r.sim.store.events.find((e) => e.type === 'payment.created')!
    await r.logEvent(viaHook)
    await processLoggedEvent(r.d, viaHook.event_id)
    r.calls.length = 0
    const rep = await runSquareCatchup(r.d)
    const ours = r.sim.store.events.filter((e) => ['payment.created', 'payment.updated'].includes(e.type))
    expect(rep).toMatchObject({ status: 'ok', read: ours.length, claimed: ours.length - 1, failed: 0, complete: true })
    expect(r.calls.filter((c) => c.kind === 'payment')).toHaveLength(ours.length - 1)
    const state = await getSquareState(t.db, r.location.id)
    expect(state?.watermark?.toISOString()).toBe(ours.at(-1)!.created_at)
    expect(state?.last_catchup_events).toBe(ours.length)
    // a second run finds nothing new: every event is already in the log
    r.calls.length = 0
    const again = await runSquareCatchup(r.d)
    expect(again).toMatchObject({ claimed: 0, processed: 0 })
    expect(r.calls).toEqual([])
    const rows = await t.db.selectFrom('webhook_log').select(['external_id', 'status']).where('provider', '=', 'square').execute()
    expect(rows.every((x) => x.status === 'processed')).toBe(true)
  })

  it('catch-up: searches from the watermark minus 10 minutes, never more than 28 days back, and alerts past 27 days', async () => {
    const r = await rig()
    const seen: string[] = []
    const spy: SquareApi = {
      ...r.sim.api,
      events: {
        ...r.sim.api.events,
        search: async (q) => {
          seen.push(q.start_at!)
          return r.sim.api.events.search(q)
        },
      },
    }
    const d = { ...r.d, api: spy }
    const now = r.clock.now().getTime()
    await runSquareCatchup(d)
    expect(seen.at(-1)).toBe(new Date(now - 86_400_000).toISOString()) // first run: the last day
    await saveSquareState(t.db, r.location.id, r.env, r.clock.now(), { watermark: new Date(now - 3_600_000) })
    await runSquareCatchup(d)
    expect(seen.at(-1)).toBe(new Date(now - 3_600_000 - 600_000).toISOString())
    await saveSquareState(t.db, r.location.id, r.env, r.clock.now(), { watermark: new Date(now - 30 * 86_400_000) })
    const rep = await runSquareCatchup(d)
    expect(rep.stale).toBe(true)
    expect(seen.at(-1)).toBe(new Date(now - 28 * 86_400_000).toISOString())
    const state = await getSquareState(t.db, r.location.id)
    expect(state?.last_error).toMatch(/older than 27 days/)
  })

  it('catch-up: a quiet period is not lost events: complete runs move the watermark to the run time minus 10 minutes, no alert', async () => {
    const r = await rig()
    const now = () => r.clock.now().getTime()
    // a watermark 27.5 days old (the last event, weeks ago): this run is the first to cover the gap, so it alerts once
    await saveSquareState(t.db, r.location.id, r.env, r.clock.now(), { watermark: new Date(now() - 27.5 * 86_400_000) })
    expect(await runSquareCatchup(r.d)).toMatchObject({ status: 'ok', read: 0, stale: true, complete: true })
    expect((await getSquareState(t.db, r.location.id))?.last_error).toMatch(/older than 27 days/)
    expect((await getSquareState(t.db, r.location.id))?.watermark?.getTime()).toBe(now() - 600_000)
    // then nothing happens at the shop for weeks; every run succeeds: no alert, the error clears
    for (let i = 0; i < 3; i++) {
      r.clock.advance(20 * 86_400_000)
      expect(await runSquareCatchup(r.d)).toMatchObject({ status: 'ok', read: 0, stale: false })
      const st = await getSquareState(t.db, r.location.id)
      expect(st?.last_error).toBeNull()
      expect(st?.watermark?.getTime()).toBe(now() - 600_000)
    }
    // an event after the quiet period is still read (the search starts 10 minutes before the watermark)
    r.clock.advance(60_000)
    await r.pay(700, 'after-quiet')
    r.clock.advance(60_000)
    const rep = await runSquareCatchup(r.d)
    expect(rep).toMatchObject({ stale: false, failed: 0 })
    expect(rep.claimed).toBeGreaterThan(0)
  })

  it('catch-up: a failed event holds the watermark back and is run again by the next catch-up', async () => {
    let fail = true
    const r = await rig({
      ingest: {
        ...noopSquareIngest,
        payment: async (c, p) => {
          if (fail && p.amount_money.amount === 111) throw new Error('not yet')
          return noopSquareIngest.payment(c, p)
        },
      },
    })
    await r.pay(111, 'x')
    r.clock.advance(60_000)
    await r.pay(222, 'y')
    const first = await runSquareCatchup(r.d)
    expect(first.failed).toBeGreaterThan(0)
    const failedAt = r.sim.store.events.find((e) => e.type === 'payment.created')!.created_at
    expect((await getSquareState(t.db, r.location.id))?.watermark?.toISOString()).toBe(failedAt)
    fail = false
    const second = await runSquareCatchup(r.d)
    expect(second.failed).toBe(0)
    const rows = await t.db.selectFrom('webhook_log').select('status').where('provider', '=', 'square').execute()
    expect(rows.every((x) => x.status === 'processed' || x.status === 'ignored')).toBe(true)
  })

  it('with the defaults (SQUARE_PROVIDER=sim) the catch-up and the reconcile do nothing and call nobody', async () => {
    const r = await rig({ vars: {} })
    let called = 0
    const counting = new Proxy(r.sim.api, {
      get: (target, prop) => {
        called++
        return target[prop as keyof SquareApi]
      },
    })
    runtime({ env: r.env, api: counting })
    const ctx = { db: t.db, clock: r.clock, logger }
    await squareCatchupJob.handler(ctx, {} as never, { id: 'j' })
    await squareReconcileJob.handler(ctx, {} as never, { id: 'j' })
    expect(called).toBe(0)
    expect(await getSquareState(t.db, r.location.id)).toBeUndefined()
  })

  it('reconcile: counts the last 72 hours of payments and refunds by status, source and product', async () => {
    const r = await rig()
    const p = await r.pay(4000, 'r1')
    await r.pay(2500, 'r2')
    r.sim.store.posPayment({ amountCents: 1500, sourceType: 'CASH' })
    await r.sim.api.refunds.refund(sqKey('rf', 'r1'), { payment_id: p.id, amount_money: usd(1000) })
    const out = await runSquareReconcile(r.d)
    expect(out.summary).toMatchObject({
      payments: 3,
      refunds: 1,
      paymentsByStatus: { COMPLETED: 3 },
      refundsByStatus: { PENDING: 1 },
      bySource: { CARD: 2, CASH: 1 },
      byProduct: { ECOMMERCE_API: 2, SQUARE_POS: 1 },
      complete: true,
    })
    const state = await getSquareState(t.db, r.location.id)
    expect(state?.last_reconcile).toMatchObject({ payments: 3 })
  })
})
