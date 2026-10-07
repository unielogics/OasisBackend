// A schema of the ops-kit tests' own. The shared per-worker schema is reused by every other suite in the same process, so leaving
// a device row, a bootstrapped administrator or a realtime event in it changes what the next file sees; these tests never touch it.
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { FixedClock } from '../../src/platform/clock.js'
import { createTestDb, schemaPrefix, truncateAll, type TestDb } from '../helpers/db.js'

export function useOwnSchema(label: string, o: { truncate?: boolean; poolMax?: number } = {}): TestDb {
  const schema = `ops_${schemaPrefix}_${label}`.toLowerCase()
  let current: TestDb | undefined
  const get = (): TestDb => {
    if (!current) throw new Error('used outside a test')
    return current
  }
  beforeAll(async () => {
    const admin = await createTestDb({
      schema,
      clock: new FixedClock('2026-06-13T10:36:00-04:00'),
      poolMax: o.poolMax ?? 4,
    })
    current = admin
  }, 120_000)
  beforeEach(async () => {
    if (o.truncate !== false) await truncateAll(get().db)
  })
  afterAll(async () => {
    if (!current) return
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(current.db)
    await current.close()
    current = undefined
  })
  return {
    get db() {
      return get().db
    },
    get schema() {
      return get().schema
    },
    get connection() {
      return get().connection
    },
    get clock() {
      return get().clock
    },
    close: () => get().close(),
  }
}
