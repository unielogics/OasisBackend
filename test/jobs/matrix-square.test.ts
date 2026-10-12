// square.event.process, square.events.catchup and square.reconcile through the real worker, twice each, against the Square
// simulator (the runtime pointed at it, SQUARE_PROVIDER=live): the second run of every job leaves the database exactly as the first did.
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { loadEnv } from '../../src/config/env.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { squareJobs } from '../../src/modules/square/jobs/index.js'
import { squareWebhookLog } from '../../src/modules/square/events.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { liveEnvVars, simFor } from '../square-db/helpers.js'
import { useJobsHarness } from './harness.js'

const h = useJobsHarness()
afterEach(() => configureSquareRuntime({}))

async function arrange() {
  const db = h.t.db
  const newId = createIdGenerator(h.clock)
  await ensureLocation(db, newId)
  const sim = simFor(h.clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...liveEnvVars })
  configureSquareRuntime({ env, api: () => sim.api })
  await sim.api.payments.create(sqKey('ch', 'matrix-1'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSIMTEST0001' })
  await sim.api.payments.create(sqKey('ch', 'matrix-2'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(2500), location_id: 'LSIMTEST0001' })
  return { db, newId, sim }
}

const snapshot = async () => {
  const db = h.t.db
  return {
    log: (await sql<{ external_id: string; status: string; error: string | null }>`
      select external_id, status, error from webhook_log where provider = 'square' order by external_id`.execute(db)).rows,
    state: (await sql<Record<string, unknown>>`
      select watermark, last_catchup_events, last_catchup_claimed_at, last_reconcile, last_error from square_state`.execute(db)).rows,
  }
}

async function run(worker: Awaited<ReturnType<typeof h.start>>, name: string, data: object = {}): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, data)
  await h.waitFor(async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before, 60_000)
}

describe('the Square jobs, twice each through the real worker', () => {
  it('square.event.process processes a logged event once; the second run leaves the row as it was', async () => {
    const { db, newId, sim } = await arrange()
    const ev = sim.store.events.find((e) => e.type === 'payment.created')!
    await squareWebhookLog(db, newId).claim(ev.event_id, h.clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(ev) })
    const w = await h.start({ definitions: squareJobs as never })
    const before = JSON.stringify(await snapshot())
    await run(w, 'square.event.process', { eventId: ev.event_id })
    const first = await snapshot()
    expect(first.log).toEqual([{ external_id: ev.event_id, status: 'processed', error: null }])
    expect(JSON.stringify(first)).not.toBe(before)
    await run(w, 'square.event.process', { eventId: ev.event_id })
    expect(await snapshot()).toEqual(first)
  })

  it('square.events.catchup claims and processes each event once; the second run finds nothing new', async () => {
    await arrange()
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.events.catchup')
    const first = await snapshot()
    expect(first.log.length).toBe(4) // two payments: created + updated each
    expect(first.log.every((r) => r.status === 'processed')).toBe(true)
    await run(w, 'square.events.catchup')
    const second = await snapshot()
    expect(second.log).toEqual(first.log)
    expect(second.state[0]!.watermark).toEqual(first.state[0]!.watermark)
  })

  it('square.reconcile keeps the same counts however many times it runs', async () => {
    await arrange()
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.reconcile')
    const first = await snapshot()
    expect(first.state[0]!.last_reconcile).toMatchObject({ payments: 2, refunds: 0 })
    await run(w, 'square.reconcile')
    expect(await snapshot()).toEqual(first)
  })
})
