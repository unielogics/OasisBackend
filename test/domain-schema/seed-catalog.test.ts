// The `catalog` seed profile: what a production location needs before the website can offer times and the dashboard can
// book (default settings, two bays, the packages and add-ons with their checklists), and nothing fabricated.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { profiles, runSeed } from '../../db/seeds/index.js'
import { DESIGN_ADDONS, DESIGN_PACKAGES } from '../../db/seeds/domain.js'
import { listCatalog } from '../../src/modules/catalog/service.js'
import { getHours } from '../../src/modules/settings/hours.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()
const count = async (table: string): Promise<number> =>
  Number(
    (await sql<{ n: string }>`select count(*)::int as n from ${sql.table(table)}`.execute(t.db)).rows[0]!.n,
  )

describe('seed profile catalog', () => {
  it('is registered on its own, without the people or design profiles', () => {
    expect(profiles.catalog).toBeDefined()
    expect(profiles.catalog!.dependsOn ?? []).toEqual([])
    expect(profiles.catalog!.description).toMatch(/no closures, history, holds or customers/)
  })

  it('creates the settings, the two bays and the catalog, nothing fabricated, and changes nothing on a second run', async () => {
    await runSeed({ db: t.db, clock: t.clock, profile: 'catalog' })
    const location = await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()
    expect(await count('bays')).toBe(2)
    const catalog = await listCatalog(t.db, location.id)
    expect(catalog.packages.map((p) => p.name)).toEqual(DESIGN_PACKAGES.map((p) => p.name))
    expect(catalog.addons.map((a) => a.name)).toEqual(DESIGN_ADDONS.map((a) => a.name))
    expect(await getHours(t.db, location.id)).toHaveLength(7)
    for (const table of [
      'closures',
      'emergency_closures',
      'vip_holds',
      'vip_clients',
      'customers',
      'vehicles',
      'appointments',
    ])
      expect(await count(table), table).toBe(0)
    const before = [await count('services'), await count('checklist_tasks'), await count('bays')]
    await runSeed({ db: t.db, clock: t.clock, profile: 'catalog' })
    expect([await count('services'), await count('checklist_tasks'), await count('bays')]).toEqual(before)
  })
})
