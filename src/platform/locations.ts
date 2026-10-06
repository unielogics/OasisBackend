import { sql } from 'kysely'
import type { Executor } from './db.js'
import type { NewId } from './ids.js'
import { ensureSettingDefaults } from './settings.js'

export const DEFAULT_LOCATION = { slug: 'oasis', name: 'Oasis Auto Spa' } as const

export interface Location {
  id: string
  name: string
  slug: string
  timezone: string
}

/**
 * Idempotent: creates the location (via the ensure_location SQL function) and its default settings rows, or returns
 * the existing ones untouched. Used by seeds, tests and server boot.
 */
export async function ensureLocation(
  db: Executor,
  newId: NewId,
  o: { slug?: string; name?: string; timezone?: string } = {},
): Promise<Location> {
  const slug = o.slug ?? DEFAULT_LOCATION.slug
  const name = o.name ?? DEFAULT_LOCATION.name
  const tz = o.timezone ?? 'America/New_York'
  const r = await sql<{
    id: string
  }>`select ensure_location(${newId()}::uuid, ${slug}, ${name}, ${tz}) as id`.execute(db)
  const id = r.rows[0]!.id
  await ensureSettingDefaults(db, id)
  const loc = await getLocation(db, id)
  return loc!
}

export async function getLocation(db: Executor, id: string): Promise<Location | undefined> {
  return db
    .selectFrom('locations')
    .select(['id', 'name', 'slug', 'timezone'])
    .where('id', '=', id)
    .executeTakeFirst()
}

/** The single seeded location (the oldest row). */
export async function getDefaultLocation(db: Executor): Promise<Location | undefined> {
  return db
    .selectFrom('locations')
    .select(['id', 'name', 'slug', 'timezone'])
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst()
}
