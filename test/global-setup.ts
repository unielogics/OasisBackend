import { createDb } from '../src/platform/db.js'
import { sql } from 'kysely'
import { testDatabaseUrl } from './helpers/env.js'

// Verifies the test database is reachable and that the extensions the migrations rely on are installable
// (trusted extensions, so a database owner can create them), before any worker starts.
export default async function setup(): Promise<void> {
  const db = createDb({ url: testDatabaseUrl(), poolMax: 1, applicationName: 'oasis-test-setup' })
  try {
    for (const ext of ['citext', 'pg_trgm', 'btree_gist', 'pgcrypto']) {
      await sql`create extension if not exists ${sql.id(ext)} schema public`.execute(db)
    }
  } catch (e) {
    throw new Error(`Test database is not usable: ${(e as Error).message}`, { cause: e })
  } finally {
    await db.destroy()
  }
}
