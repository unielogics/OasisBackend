// The jobs of the Square item library (ADR 0172) through the real worker, twice each: with the defaults (Square writes off) both
// complete, change nothing and call Square never; so with writes on but the item sync off; with both on, square.items.sync makes the
// items once and its second run leaves the database (and Square) as the first did, and square.items.drift finds Square as the sync
// left it.
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { squareItemsJobs } from '../../src/modules/catalog/square/jobs.js'
import { ensureDomainDefaults } from '../../src/modules/settings/defaults.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { updateSetting } from '../../src/platform/settings.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { useJobsHarness } from './harness.js'

const h = useJobsHarness()
afterEach(() => configureSquareRuntime({}))

const NAMES = ['square.items.sync', 'square.items.drift']

async function arrange(vars: Record<string, string>) {
  const db = h.t.db
  const newId = createIdGenerator(h.clock)
  const loc = await ensureLocation(db, newId)
  await transaction(db, (tx) => ensureDomainDefaults(tx, loc.id))
  // Oasis rounds tax like Square: the item sync waits for it (K4 review tax:H2)
  await transaction(db, (tx) => updateSetting(tx, { locationId: loc.id, key: 'tax.rounding', value: 'half_even' }))
  const wash = newId()
  await db
    .insertInto('services')
    .values([
      { id: wash, location_id: loc.id, kind: 'package', name: 'Signature Hand Wash', price_cents: 4000, duration_min: 45, category: 'wash' },
      { id: newId(), location_id: loc.id, kind: 'addon', name: 'Tire shine', price_cents: 1500, duration_min: 0, category: 'addons' },
    ])
    .execute()
  await db.insertInto('service_class_prices').values({ service_id: wash, location_id: loc.id, class_key: 'compact_car', price_cents: 4000, max_cents: null }).execute()
  const sim = simFor(h.clock)
  configureSquareRuntime({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...vars }), api: () => sim.api })
  return { db, sim }
}

const snapshot = async () => {
  const db = h.t.db
  return {
    links: (await sql`select kind, service_id, class_key, category_key, square_object_id, square_version, content_hash, state from square_catalog_links order by kind, service_id, class_key, category_key`.execute(db)).rows,
    state: (await sql`select environment, fingerprint, tax_mode from square_items_state order by environment`.execute(db)).rows,
  }
}

async function run(worker: Awaited<ReturnType<typeof h.start>>, name: string): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, {})
  await h.waitFor(async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before, 60_000)
}

describe('the Square item library jobs, twice each through the real worker', () => {
  it('with the defaults (writes off): both complete, change nothing, and nothing reaches Square', async () => {
    const { sim } = await arrange({})
    const before = await snapshot()
    const w = await h.start({ definitions: squareItemsJobs as never })
    for (const name of NAMES) {
      await run(w, name)
      await run(w, name)
    }
    expect(await snapshot()).toEqual(before)
    expect(sim.sim.log).toEqual([])
  })

  it('with writes on but the item sync off (an earlier rollout stage): nothing reaches Square', async () => {
    const { sim } = await arrange(coreVars)
    const before = await snapshot()
    const w = await h.start({ definitions: squareItemsJobs as never })
    for (const name of NAMES) await run(w, name)
    expect(await snapshot()).toEqual(before)
    expect(sim.sim.log).toEqual([])
  })

  it('both on: the items are made once; the second run and the nightly drift check change nothing', async () => {
    const { sim } = await arrange({ ...coreVars, SQUARE_ITEMS_SYNC_ENABLED: 'true' })
    const w = await h.start({ definitions: squareItemsJobs as never })
    await run(w, 'square.items.sync')
    const first = await snapshot()
    expect(first.links.filter((l) => (l as { kind: string }).kind === 'item').map((l) => (l as { state: string }).state)).toEqual(['synced', 'synced'])
    expect([...sim.store.catalog.values()].filter((o) => o.type === 'ITEM')).toHaveLength(2)
    const writes = () => sim.sim.log.filter((x) => x.method === 'POST' && x.path === '/v2/catalog/object').length
    const made = writes()
    await run(w, 'square.items.sync')
    expect(await snapshot()).toEqual(first)
    expect(writes()).toBe(made)
    await run(w, 'square.items.drift')
    expect((await snapshot()).links).toEqual(first.links)
    expect(writes()).toBe(made)
  })
})
