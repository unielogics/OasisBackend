// Sandbox run SANDBOX-F2: the first catch-up of a new connection reads the last day of Square events, and the shop's counter sales
// from before Oasis was connected must not land in "Square payments to match" (nor raise the 30-minute alert). The first successful
// Test connection stamps square_state.connected_at; a counter payment created before it is mirrored as history: ignored, "before
// connection", never queued or alerted. Later tests never move the stamp; a stack already running (a watermark) gets none.
import { describe, expect, it } from 'vitest'
import { saveSquareState } from '../../src/modules/square/db/state.js'
import { squareExternalAlerts, squarePaymentsToMatch } from '../../src/modules/square/db/alerts.js'
import { squareModule } from '../../src/modules/square/http/module.js'
import { systemModule } from '../../src/modules/system/index.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { createTestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'
import { coreRig, useCoreRuntime } from './core.js'
import { HOOK_URL, liveEnvVars, simFor, useSquareRuntime } from './helpers.js'

const MIN = 60_000

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
})
