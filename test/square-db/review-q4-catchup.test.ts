// Review Q4 SQ-SEM-5: the catch-up runs a row the hook claimed whose job was lost (and a failed row) even after the search window has
// moved past its event: with steady traffic the watermark follows the run time, so the window alone would never read it again.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { runSquareCatchup } from '../../src/modules/square/catchup.js'
import { saveSquareState } from '../../src/modules/square/db/state.js'
import { squareWebhookLog, type SquareEventDeps } from '../../src/modules/square/events.js'
import { noopSquareIngest, type SquareIngest } from '../../src/modules/square/ingest.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { createLogger } from '../../src/platform/logging.js'
import { useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { liveEnvVars, simFor, useSquareRuntime } from './helpers.js'

const MIN = 60_000

describe('the catch-up and lost jobs outside its window (review Q4 SQ-SEM-5)', () => {
  const t = useTestDb()
  useSquareRuntime()

  it('runs a row still received after 15 minutes and a failed row, whatever the window; a second run has nothing left', async () => {
    const clock = t.clock as FixedClock
    const newId = createIdGenerator(clock)
    const location = await ensureLocation(t.db, newId)
    const sim = simFor(clock)
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...liveEnvVars })
    const calls: string[] = []
    const ingest: SquareIngest = { ...noopSquareIngest, payment: async (c, p) => (calls.push(p.id), noopSquareIngest.payment(c, p)) }
    const d: SquareEventDeps = { db: t.db, clock, logger: createLogger({ level: 'silent' }), env, api: sim.api, ingest, newId }
    const log = squareWebhookLog(t.db, newId)
    const p = await sim.api.payments.create(sqKey('ch', 'lost-job'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSIMTEST0001' })
    const [created, updated] = sim.store.events.filter((e) => e.data.id === p.id)
    // the hook claimed both events; one job was lost, the other failed
    await log.claim(created!.event_id, clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(created) })
    await log.claim(updated!.event_id, clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(updated) })
    await log.finish(updated!.event_id, 'failed', clock.now(), 'database hiccup')
    // steady traffic since: the watermark follows the runs, 20 minutes later the window starts after both events
    clock.advance(20 * MIN)
    await saveSquareState(t.db, location.id, env, clock.now(), { watermark: new Date(clock.now().getTime() - 5 * MIN) })
    const rep = await runSquareCatchup(d)
    expect(rep).toMatchObject({ status: 'ok', read: 0, rescued: 2, failed: 0 })
    expect(calls).toEqual([p.id, p.id])
    expect((await log.get(created!.event_id))!.status).toBe('processed')
    expect((await log.get(updated!.event_id))!.status).toBe('processed')
    calls.length = 0
    expect(await runSquareCatchup(d)).toMatchObject({ rescued: 0 })
    expect(calls).toEqual([])
  })

  it('leaves a row the hook claimed less than 15 minutes ago to its job', async () => {
    const clock = t.clock as FixedClock
    const newId = createIdGenerator(clock)
    const location = await ensureLocation(t.db, newId)
    const sim = simFor(clock)
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...liveEnvVars })
    const d: SquareEventDeps = { db: t.db, clock, logger: createLogger({ level: 'silent' }), env, api: sim.api, ingest: noopSquareIngest, newId }
    const log = squareWebhookLog(t.db, newId)
    const p = await sim.api.payments.create(sqKey('ch', 'fresh-job'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSIMTEST0001' })
    const ev = sim.store.events.find((e) => e.data.id === p.id)!
    await log.claim(ev.event_id, clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(ev) })
    clock.advance(14 * MIN)
    await saveSquareState(t.db, location.id, env, clock.now(), { watermark: clock.now() })
    expect(await runSquareCatchup(d)).toMatchObject({ rescued: 0 })
    expect((await log.get(ev.event_id))!.status).toBe('received')
  })
})
