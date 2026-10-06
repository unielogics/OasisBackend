import type { Executor } from '../../src/platform/db.js'
import type { NewId } from '../../src/platform/ids.js'
import { ensureLocation, type Location } from '../../src/platform/locations.js'

let seq = 0

/** Inserts an additional location (the first one normally comes from ensureLocation). */
export async function makeLocation(
  db: Executor,
  newId: NewId,
  o: Partial<{ name: string; slug: string; timezone: string }> = {},
): Promise<Location> {
  seq += 1
  return ensureLocation(db, newId, {
    name: o.name ?? `Test Location ${seq}`,
    slug: o.slug ?? `test-location-${seq}`,
    timezone: o.timezone,
  })
}
