// The jobs of the memberships billed by Square (ADR 0171 wave Q3b) through the real worker, twice each: with the defaults (Square
// writes off, Squarespace the processor) every one completes and changes nothing; with writes on the catalog sync makes the tier
// price's variation once and its second run leaves the database (and Square) as the first did.
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { loadEnv } from '../../src/config/env.js'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { squareMembershipJobs } from '../../src/modules/memberships/square/jobs.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { useJobsHarness } from './harness.js'

const h = useJobsHarness()
afterEach(() => configureSquareRuntime({}))

const NAMES = ['square.catalog.sync', 'square.catalog.drift', 'square.enrollments.resume', 'membership.billing', 'square.plans.swap']

async function arrange(vars: Record<string, string>) {
  const db = h.t.db
  const newId = createIdGenerator(h.clock)
  const loc = await ensureLocation(db, newId)
  await ensurePlans(db, { locationId: loc.id, clock: h.clock, newId })
  await ensureVehicleClasses(db, loc.id)
  const plan = await db.selectFrom('membership_plans').select(['id', 'price_version']).where('location_id', '=', loc.id).where('key', '=', 'gold').executeTakeFirstOrThrow()
  await db.updateTable('membership_tier_prices').set({ superseded_at: h.clock.now() }).where('plan_id', '=', plan.id).where('superseded_at', 'is', null).execute()
  await db.updateTable('membership_plans').set({ square_plan_id: null }).execute()
  await db
    .insertInto('membership_tier_prices')
    .values({ id: newId(), location_id: loc.id, plan_id: plan.id, class_key: 'compact_car', monthly_cents: 12900, price_version: plan.price_version, effective_from: h.clock.now() })
    .execute()
  const sim = simFor(h.clock)
  configureSquareRuntime({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...vars }), api: () => sim.api })
  return { db, sim }
}

const snapshot = async () => {
  const db = h.t.db
  return {
    prices: (await sql`select class_key, monthly_cents, square_state, square_variation_id, square_error from membership_tier_prices where superseded_at is null order by class_key`.execute(db)).rows,
    plans: (await sql`select key, square_plan_id from membership_plans order by key`.execute(db)).rows,
    memberships: (await sql`select id, status, billing_status from memberships order by id`.execute(db)).rows,
    enrollments: (await sql`select id, state from square_enrollments order by id`.execute(db)).rows,
  }
}

async function run(worker: Awaited<ReturnType<typeof h.start>>, name: string): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, {})
  await h.waitFor(async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before, 60_000)
}

describe('the Square membership jobs, twice each through the real worker', () => {
  it('with the defaults (writes off): every job completes and changes nothing, and nothing reaches Square', async () => {
    const { sim } = await arrange({})
    const before = await snapshot()
    const w = await h.start({ definitions: squareMembershipJobs as never })
    for (const name of NAMES) {
      await run(w, name)
      await run(w, name)
    }
    expect(await snapshot()).toEqual(before)
    expect(sim.sim.log).toEqual([])
  })

  it('square.catalog.sync with writes on: the price becomes a variation once; the second run changes nothing', async () => {
    const { sim } = await arrange(coreVars)
    const w = await h.start({ definitions: squareMembershipJobs as never })
    await run(w, 'square.catalog.sync')
    const first = await snapshot()
    expect(first.prices).toMatchObject([{ class_key: 'compact_car', square_state: 'synced' }])
    const calls = sim.sim.log.length
    await run(w, 'square.catalog.sync')
    expect(await snapshot()).toEqual(first)
    expect(sim.sim.log.length).toBe(calls)
    // the drift check reads Square back and finds it as the sync left it
    await run(w, 'square.catalog.drift')
    expect(await snapshot()).toEqual(first)
  })
})
