// Sandbox run SANDBOX-F2: the first catch-up of a new connection reads the last day of Square events, and the shop's counter sales
// from before Oasis was connected must not land in "Square payments to match" (nor raise the 30-minute alert). The first read of a
// real Square stamps square_state.connected_at, whichever comes first: the first catch-up page, the first reconcile listing, the first
// webhook (a little before its event) or the first successful Test connection; a counter payment created before it is mirrored as
// history: ignored, "before connection", never queued or alerted. Later reads never move the stamp; a stack already running (a
// watermark) gets none; switching environment starts afresh.
import { describe, expect, it } from 'vitest'
import { runSquareCatchup } from '../../src/modules/square/catchup.js'
import { getSquareState, saveSquareState, squareEnvironment } from '../../src/modules/square/db/state.js'
import type { SquareEventDeps } from '../../src/modules/square/events.js'
import { squareCoreIngest } from '../../src/modules/square/handlers.js'
import { squareHookModule } from '../../src/modules/square/http/hook.js'
import { noopSquareIngest } from '../../src/modules/square/ingest.js'
import { runSquareReconcile } from '../../src/modules/square/reconcile.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { squareExternalAlerts, squarePaymentsToMatch } from '../../src/modules/square/db/alerts.js'
import { squareModule } from '../../src/modules/square/http/module.js'
import { systemModule } from '../../src/modules/system/index.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { createTestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'
import { coreRig, silent, squareEnvFor, useCoreRuntime, type Rig } from './core.js'
import { HOOK_URL, liveEnvVars, signed, simFor, useSquareRuntime } from './helpers.js'

const MIN = 60_000
/** The documented setup: SQUARE_PROVIDER=live with a token, the location and the application id (the sandbox environment). */
const LIVE: Record<string, string> = { ...liveEnvVars }
const eventDeps = (r: Rig): SquareEventDeps => ({ db: r.t.db, clock: r.clock, logger: silent, env: r.env, api: r.sim.api, ingest: squareCoreIngest, newId: r.newId })

describe('payments from before the connection are history (sandbox run F2)', () => {
  const t = useTestDb()
  useCoreRuntime()

  it('a counter payment created before the connection point is ignored as history; one after it is matched as usual', async () => {
    const r = await coreRig(t)
    const old = r.posPayment({ amountCents: 2500, note: 'a sale before Oasis' })
    r.clock.advance(30 * MIN)
    await saveSquareState(t.db, r.pe.locationId, r.env, r.clock.now(), { connected_at: r.clock.now() })
    r.clock.advance(MIN)
    const fresh = r.posPayment({ amountCents: 2600, note: 'a sale after the connection' })
    r.clock.advance(MIN)
    expect(await r.decide(old.id, { force: true })).toBe('ignored')
    expect(await r.mirror(old.id)).toMatchObject({ match_state: 'ignored', ignore_reason: 'other', classification: 'counter' })
    expect((await r.mirror(old.id))!.ignore_note).toMatch(/^before connection/)
    expect(await r.decide(fresh.id, { force: true })).toBe('unmatched')
    r.clock.advance(40 * MIN)
    const queue = await squarePaymentsToMatch(t.db, r.pe.locationId, r.clock.now())
    expect(queue.map((q) => q.paymentId)).toEqual([fresh.id])
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })
    expect(JSON.stringify(alerts)).not.toContain(old.id)
  })

  it('without a connection point nothing is cut (a stack connected before the stamp existed)', async () => {
    const r = await coreRig(t)
    const old = r.posPayment({ amountCents: 2500 })
    r.clock.advance(30 * MIN)
    expect(await r.decide(old.id, { force: true })).toBe('unmatched')
  })
})

describe('the first read of a real Square stamps the connection point (sandbox run F2, re-verified)', () => {
  const t = useTestDb()
  useCoreRuntime()
  const stamp = async (r: Rig) => (await getSquareState(t.db, r.pe.locationId))?.connected_at ?? null

  it('the first catch-up stamps it before deciding anything (it ran before Test connection): the earlier sales are history', async () => {
    const r = await coreRig(t, LIVE)
    expect(squareEnvironment(r.env)).toBe('sandbox')
    // the stack ran on the simulator before (production today): its row is of another environment
    await saveSquareState(t.db, r.pe.locationId, squareEnvFor(), r.clock.now(), { watermark: r.clock.now(), last_webhook_at: r.clock.now() })
    const old = r.posPayment({ amountCents: 2500, note: 'a sale the morning before Oasis' })
    r.clock.advance(30 * MIN)
    const first = r.clock.now()
    expect(await runSquareCatchup(eventDeps(r))).toMatchObject({ status: 'ok' })
    expect(await stamp(r)).toEqual(first)
    expect(await r.mirror(old.id)).toMatchObject({ match_state: 'ignored', ignore_reason: 'other' })
    expect((await r.mirror(old.id))!.ignore_note).toMatch(/^before connection/)
    // a sale after it is matched as usual, and the next runs keep the stamp
    r.clock.advance(MIN)
    const fresh = r.posPayment({ amountCents: 2600 })
    r.clock.advance(10 * MIN)
    await runSquareCatchup(eventDeps(r))
    expect(await stamp(r)).toEqual(first)
    expect(await r.mirror(fresh.id)).toMatchObject({ match_state: 'unmatched' })
    r.clock.advance(40 * MIN)
    const queue = await squarePaymentsToMatch(t.db, r.pe.locationId, r.clock.now())
    expect(queue.map((q) => q.paymentId)).toEqual([fresh.id])
  })

  it('the first reconcile stamps it before deciding the 72 hours it lists', async () => {
    const r = await coreRig(t, LIVE)
    const old = r.posPayment({ amountCents: 2500 })
    r.clock.advance(5 * 60 * MIN)
    const first = r.clock.now()
    expect(await runSquareReconcile(eventDeps(r))).toMatchObject({ status: 'ok' })
    expect(await stamp(r)).toEqual(first)
    expect(await r.mirror(old.id)).toMatchObject({ match_state: 'ignored' })
    expect((await r.mirror(old.id))!.ignore_note).toMatch(/^before connection/)
    // the next night keeps it
    r.clock.advance(24 * 60 * MIN)
    await runSquareReconcile(eventDeps(r))
    expect(await stamp(r)).toEqual(first)
  })

  it('a stack that read events before the stamp existed (a watermark) gets none from the catch-up or the reconcile', async () => {
    const r = await coreRig(t, LIVE)
    await saveSquareState(t.db, r.pe.locationId, r.env, r.clock.now(), { watermark: r.clock.now() })
    const old = r.posPayment({ amountCents: 2500 })
    r.clock.advance(30 * MIN)
    await runSquareCatchup(eventDeps(r))
    await runSquareReconcile(eventDeps(r))
    expect(await stamp(r)).toBeNull()
    expect(await r.mirror(old.id)).toMatchObject({ match_state: 'unmatched' })
  })

  it('the simulator is never stamped by a read (it has no sales from before Oasis)', async () => {
    const r = await coreRig(t)
    r.posPayment({ amountCents: 2500 })
    r.clock.advance(30 * MIN)
    await runSquareCatchup({ ...eventDeps(r), ingest: noopSquareIngest }, { force: true })
    await runSquareReconcile(eventDeps(r), { force: true })
    expect(await stamp(r)).toBeNull()
  })
})

describe('the connection point (sandbox run F2)', () => {
  const t = useTestDb()
  const runtime = useSquareRuntime()

  it('the first successful Test connection sets it; a later test keeps it; a failed test or a running stack sets none', async () => {
    const app = await createTestApp({ testDb: t, modules: [squareModule, systemModule], env: liveEnvVars })
    const clock = t.clock as FixedClock
    const sim = simFor(clock)
    runtime({ env: app.env, api: sim.api })
    const test = () => app.app.inject({ method: 'POST', url: '/api/v1/integrations/square/test', payload: {} })
    const state = () => app.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    // no webhook subscription yet: the test fails, no connection point
    expect((await test()).json()).toMatchObject({ ok: false })
    expect((await state()).connected_at).toBeNull()
    sim.sim.addWebhookSubscription({ url: HOOK_URL, signatureKey: 'k-0000000000' })
    expect((await test()).json()).toMatchObject({ ok: true })
    const first = (await state()).connected_at
    expect(first).not.toBeNull()
    clock.advance(60 * MIN)
    expect((await test()).json()).toMatchObject({ ok: true })
    expect((await state()).connected_at).toEqual(first)
    // a stack already reading events before the stamp existed: no stamp is made up later
    await app.db.updateTable('square_state').set({ connected_at: null, watermark: clock.now() }).execute()
    expect((await test()).json()).toMatchObject({ ok: true })
    expect((await state()).connected_at).toBeNull()
    await app.close()
  })

  it('the documented setup: live, restart, the catch-up runs first; the Test connection that follows keeps its stamp', async () => {
    const app = await createTestApp({ testDb: t, modules: [squareModule, systemModule], env: liveEnvVars })
    const clock = t.clock as FixedClock
    const sim = simFor(clock)
    runtime({ env: app.env, api: sim.api })
    const d: SquareEventDeps = { db: app.db, clock, logger: silent, env: app.env, api: sim.api, ingest: noopSquareIngest, newId: createIdGenerator(clock) }
    clock.advance(5 * MIN)
    const first = clock.now()
    expect(await runSquareCatchup(d)).toMatchObject({ status: 'ok' })
    const state = () => app.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    expect((await state()).connected_at).toEqual(first)
    sim.sim.addWebhookSubscription({ url: HOOK_URL, signatureKey: 'k-0000000000' })
    clock.advance(20 * MIN)
    expect((await app.app.inject({ method: 'POST', url: '/api/v1/integrations/square/test', payload: {} })).json()).toMatchObject({ ok: true })
    expect((await state()).connected_at).toEqual(first)
    await app.close()
  })

  it('a webhook before any read stamps it a little before its event (a live sale is never history); later reads keep it', async () => {
    const app = await createTestApp({ testDb: t, hookModules: [squareHookModule], modules: [squareModule, systemModule], env: liveEnvVars })
    const clock = t.clock as FixedClock
    const sim = simFor(clock)
    runtime({ env: app.env, api: sim.api })
    clock.advance(60 * MIN)
    const p = sim.store.posPayment({ amountCents: 2500, sourceType: 'CARD' })
    const ev = sim.store.events.find((e) => e.data.id === String(p.id))!
    clock.advance(MIN)
    const n = signed(ev)
    const res = await app.app.inject({ method: 'POST', url: '/hooks/square', headers: n.headers, payload: n.rawBody })
    expect(res.statusCode, res.body).toBe(200)
    const state = () => app.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    const at = new Date(Date.parse(ev.created_at) - 10 * MIN)
    expect((await state()).connected_at).toEqual(at)
    expect(Date.parse(String(p.created_at))).toBeGreaterThan(at.getTime())
    const d: SquareEventDeps = { db: app.db, clock, logger: silent, env: app.env, api: sim.api, ingest: noopSquareIngest, newId: createIdGenerator(clock) }
    clock.advance(10 * MIN)
    await runSquareCatchup(d)
    expect((await state()).connected_at).toEqual(at)
    await app.close()
  })
})
