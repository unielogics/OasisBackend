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

/** Inserts a minimal employee plus login so audit-style foreign keys (created_by, started_by, ...) point at a real user. */
export async function makeUser(
  db: Executor,
  newId: NewId,
  o: Partial<{ first: string; email: string }> = {},
): Promise<{ userId: string; employeeId: string }> {
  seq += 1
  const employeeId = newId()
  const userId = newId()
  await db
    .insertInto('employees')
    .values({ id: employeeId, first: o.first ?? `Tester${seq}`, status: 'active' })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: userId,
      employee_id: employeeId,
      email: o.email ?? `tester${seq}-${userId.slice(-6)}@example.test`,
      password_hash: 'not-a-real-hash',
    })
    .execute()
  return { userId, employeeId }
}
