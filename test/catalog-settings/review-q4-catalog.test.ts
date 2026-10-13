// Review Q4 on the production seed path (catalog, website-catalog, pricing-defaults):
//   F1  Gold and VIP cover what their perks promise (Gold: 4 hand washes a month; VIP: those, wax and engine bay every wash, leather
//       2 and stain removal 1 a month), applied by themselves; Gold no longer promises member prices while its % off is 0.
//   F2  catalog v2 (the website and the assistant's facts) lists no item without a price at any size: never the legacy figure as one
//       price for every size; an item appears once the owner prices it in the size grid.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { apiModules } from '../../src/http/modules.js'
import { putClassPrices } from '../../src/modules/catalog/class-prices.js'
import { loadPlans } from '../../src/modules/memberships/plans.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'

let t: TestDb
let app: TestApp
let clock: FixedClock
let locationId = ''

beforeAll(async () => {
  clock = new FixedClock(PARITY_NOW)
  t = await createTestDb({ clock, poolMax: 6 })
  app = await createTestApp({ testDb: t, modules: apiModules, env: { PUBLIC_WRITES_ENABLED: 'false' } })
})

beforeEach(async () => {
  clock.set(PARITY_NOW)
  await truncateAll(t.db)
  await runSeed({ db: t.db, clock, profile: 'catalog' })
  await runSeed({ db: t.db, clock, profile: 'website-catalog' })
  await runSeed({ db: t.db, clock, profile: 'pricing-defaults' })
  locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => {
  await app?.close()
  await t?.close()
})

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const v2 = async (): Promise<Json> => {
  const r = await app.app.inject({ method: 'GET', url: '/api/v1/public/catalog/v2', headers: { 'x-test-anonymous': '1' } })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

describe('the seeded tiers cover what their perks promise (review Q4 F1)', () => {
  it('Gold: 4 hand washes a month; VIP: those, wax and engine bay every wash, leather 2× and stain removal 1× a month; auto-applied', async () => {
    const plans = await loadPlans(t.db, locationId)
    const names = new Map((await t.db.selectFrom('services').select(['id', 'name', 'active']).where('location_id', '=', locationId).execute()).map((s) => [s.id, s]))
    const view = (key: string) =>
      plans
        .find((p) => p.key === key)!
        .inclusions.filter((i) => i.active)
        .map((i) => ({ label: i.label, mode: i.mode, perCycle: i.perCycle, autoApply: i.autoApply, services: i.serviceIds.map((id) => names.get(id)!.name).sort(), active: i.serviceIds.every((id) => names.get(id)!.active) }))
    expect(view('gold')).toEqual([
      { label: 'Hand washes', mode: 'per_cycle', perCycle: 4, autoApply: true, services: ['Exterior Hand Wash', 'Signature Hand Wash'], active: true },
    ])
    expect(view('vip')).toEqual([
      { label: 'Hand washes', mode: 'per_cycle', perCycle: 4, autoApply: true, services: ['Exterior Hand Wash', 'Signature Hand Wash'], active: true },
      { label: 'Wax every wash', mode: 'every_visit', perCycle: null, autoApply: true, services: ['Hand wax'], active: true },
      { label: 'Engine bay every wash', mode: 'every_visit', perCycle: null, autoApply: true, services: ['Engine bay wash'], active: true },
      { label: 'Leather conditioning', mode: 'per_cycle', perCycle: 2, autoApply: true, services: ['Leather conditioning'], active: true },
      { label: 'Stain removal', mode: 'per_cycle', perCycle: 1, autoApply: true, services: ['Stain removal'], active: true },
    ])
    const gold = (await v2()).tiers.find((x: Json) => x.key === 'gold')
    expect(gold.perks).toEqual(['4 hand washes a month, interior included', 'Share across household cars', 'No booking fees'])
    expect(gold.memberDiscountBp).toBe(0)
    expect(gold.inclusions.map((i: Json) => i.serviceKey)).toEqual(expect.arrayContaining(['signature-hand-wash']))
    // a second run changes nothing, and the owner's own inclusions are never replaced
    const before = await t.db.selectFrom('membership_inclusions').select(['id', 'label']).orderBy('id').execute()
    await runSeed({ db: t.db, clock, profile: 'website-catalog' })
    expect(await t.db.selectFrom('membership_inclusions').select(['id', 'label']).orderBy('id').execute()).toEqual(before)
  })
})

describe('catalog v2 lists only items priced by size (review Q4 F2)', () => {
  it('no item without a price at any size; one appears once priced in the grid', async () => {
    const cat = await v2()
    const all = [...cat.services, ...cat.addons]
    expect(all.length).toBeGreaterThan(0)
    for (const it of all) expect(it.prices.length, it.name).toBeGreaterThan(0)
    expect(all.map((x: Json) => x.name)).not.toContain('Full detail')
    expect(all.map((x: Json) => x.name)).not.toContain('Hand wax')
    const wax = await t.db.selectFrom('services').select(['id', 'version']).where('location_id', '=', locationId).where('name', '=', 'Hand wax').executeTakeFirstOrThrow()
    await t.db.transaction().execute((tx) =>
      putClassPrices(tx, { locationId, userId: null, rows: [{ serviceId: wax.id, version: wax.version, cells: [{ class: 'compact_car', cents: 2000, maxCents: null }] }] }),
    )
    const after = await v2()
    expect(after.addons.find((x: Json) => x.name === 'Hand wax')).toMatchObject({ prices: [expect.objectContaining({ class: 'compact_car', cents: 2000 })], fromCents: 2000 })
  })
})
