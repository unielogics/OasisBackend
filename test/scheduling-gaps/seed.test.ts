import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'

describe('seed profile geofence', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb({ clock: new FixedClock('2026-06-13T10:36:00-04:00') })
    await truncateAll(t.db)
  })
  afterAll(async () => {
    await t?.close()
  })

  it('sets placeholder coordinates once and never overwrites real ones', async () => {
    const coords = async () => t.db.selectFrom('locations').select(['lat', 'lng']).executeTakeFirstOrThrow()
    await runSeed({ db: t.db, clock: t.clock, profile: 'geofence' })
    expect(await coords()).toEqual({ lat: '25.761700', lng: '-80.191800' })
    await t.db.updateTable('locations').set({ lat: 40.5, lng: -74.25 }).execute()
    await runSeed({ db: t.db, clock: t.clock, profile: 'geofence' })
    expect(await coords()).toEqual({ lat: '40.500000', lng: '-74.250000' })
  })
})
