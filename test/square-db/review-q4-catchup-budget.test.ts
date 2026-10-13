// Review Q4 SQ-SEM-5-R1: the catch-up's rescue of rows outside its window gives a lost `received` row its own budget, so permanently
// failing rows never starve it, and backs failed rows off (webhook_log.attempts, the last try in processed_at): 10 minutes after the
// first failure, then doubling, at most a day.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { STUCK_BATCH, failedRetryDelayMs, runSquareCatchup } from '../../src/modules/square/catchup.js'
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

describe('the catch-up rescue budget and back-off (review Q4 SQ-SEM-5-R1)', () => {
  const t = useTestDb()
  useSquareRuntime()

  it('the retry delay doubles from 10 minutes and stops at a day', () => {
    expect([1, 2, 3, 4].map(failedRetryDelayMs)).toEqual([10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN])
    expect(failedRetryDelayMs(0)).toBe(10 * MIN)
    expect(failedRetryDelayMs(30)).toBe(24 * 60 * MIN)
  })

  it('a lost row runs although more than a batch of older rows keep failing; the failing rows are tried again later and later', async () => {
    const clock = t.clock as FixedClock
    const newId = createIdGenerator(clock)
    const location = await ensureLocation(t.db, newId)
    const sim = simFor(clock)
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...liveEnvVars })
    const bad = await sim.api.payments.create(sqKey('ch', 'always-fails'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(1000), location_id: 'LSIMTEST0001' })
    const calls: string[] = []
    const ingest: SquareIngest = {
      ...noopSquareIngest,
      payment: async (c, p) => {
        calls.push(p.id)
        if (p.id === bad.id) throw new Error('this one always fails')
        return noopSquareIngest.payment(c, p)
      },
    }
    const d: SquareEventDeps = { db: t.db, clock, logger: createLogger({ level: 'silent' }), env, api: sim.api, ingest, newId }
    const log = squareWebhookLog(t.db, newId)
    const badEvent = sim.store.events.find((e) => e.data.id === bad.id)!
    // more failed rows than a batch, older than the lost one
    const failing = STUCK_BATCH + 5
    for (let i = 0; i < failing; i++) {
      const id = `bad-event-${i}`
      await log.claim(id, clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify({ ...badEvent, event_id: id }) })
      await log.finish(id, 'failed', clock.now(), 'this one always fails')
    }
    clock.advance(MIN)
    const good = await sim.api.payments.create(sqKey('ch', 'lost-job-2'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSIMTEST0001' })
    const goodEvent = sim.store.events.find((e) => e.data.id === good.id)!
    await log.claim(goodEvent.event_id, clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(goodEvent) })
    const badCalls = () => calls.filter((x) => x === bad.id).length
    const run = async (minutes: number) => {
      clock.advance(minutes * MIN)
      // steady traffic: the window starts after every row
      await saveSquareState(t.db, location.id, env, clock.now(), { watermark: new Date(clock.now().getTime() - 5 * MIN) })
      calls.length = 0
      return runSquareCatchup(d)
    }

    // 20 minutes on: the lost row runs; a batch of the failing rows is tried again (each fails again, attempts 2)
    expect(await run(20)).toMatchObject({ status: 'ok', read: 0, rescued: 1 })
    expect(calls).toContain(good.id)
    expect((await log.get(goodEvent.event_id))!.status).toBe('processed')
    expect(badCalls()).toBe(STUCK_BATCH)
    const tried = await t.db.selectFrom('webhook_log').select(['attempts']).where('external_id', 'like', 'bad-event-%').execute()
    expect(tried.filter((r) => r.attempts === 2)).toHaveLength(STUCK_BATCH)
    expect(tried.filter((r) => r.attempts === 1)).toHaveLength(5)

    // 10 minutes later: only the rows not tried last time are due (attempts 1: 10 minutes); the others wait 20
    expect(await run(10)).toMatchObject({ rescued: 0 })
    expect(badCalls()).toBe(5)
    // 11 minutes later: the batch tried 21 minutes ago is due; the 5 tried 11 minutes ago wait
    await run(11)
    expect(badCalls()).toBe(STUCK_BATCH)
    // right after: nothing is due
    await run(1)
    expect(badCalls()).toBe(0)
  })
})
