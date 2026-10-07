// Invariants of the people/roles module that hold regardless of who asks.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { SUPER_ONLY_PERMISSIONS } from '../rbac/catalog.js'
import { loadAuthority } from '../rbac/service.js'
import type { SessionAuthContext } from '../auth/context.js'

/** Only a Super Admin (acting as one: not while viewing as a lesser role) may do this. */
export function requireSuper(actor: Pick<SessionAuthContext, 'isSuper'>): void {
  if (!actor.isSuper) throw new AppError('SUPER_ONLY')
}

/**
 * Serialises every change that can reduce the number of Super Admins by locking the locked role row. Call before
 * counting, inside the transaction that makes the change.
 */
export async function lockSuperRole(tx: Tx): Promise<void> {
  await sql`select id from roles where is_locked for update`.execute(tx)
}

export async function countActiveSupers(db: Executor): Promise<number> {
  const r = await db
    .selectFrom('employees as e')
    .innerJoin('employee_roles as er', 'er.employee_id', 'e.id')
    .innerJoin('roles as r', 'r.id', 'er.role_id')
    .select((eb) => eb.fn.count<string>('e.id').distinct().as('n'))
    .where('r.is_locked', '=', true)
    .where('e.status', '=', 'active')
    .executeTakeFirstOrThrow()
  return Number(r.n)
}

/** At least one active Super Admin must exist after the change; call last, inside the same transaction. */
export async function assertSuperRemains(tx: Tx): Promise<void> {
  if ((await countActiveSupers(tx)) < 1) throw new AppError('LAST_SUPER_ADMIN')
}

export async function holdsLockedRole(db: Executor, employeeId: string): Promise<boolean> {
  const r = await db
    .selectFrom('employee_roles as er')
    .innerJoin('roles as r', 'r.id', 'er.role_id')
    .select('er.role_id')
    .where('er.employee_id', '=', employeeId)
    .where('r.is_locked', '=', true)
    .executeTakeFirst()
  return !!r
}

/**
 * A Super Admin, or anyone whose roles or exceptions grant a Super-only permission (set.billing, pay.void). Whoever controls
 * their phone or email controls the account (invite, reset and sign-in all run through them), so only a Super Admin may change
 * those two fields for such a person.
 */
export async function holdsSuperAuthority(db: Executor, employeeId: string): Promise<boolean> {
  if (await holdsLockedRole(db, employeeId)) return true
  const authority = await loadAuthority(db, employeeId)
  return [...SUPER_ONLY_PERMISSIONS].some((key) => authority.permissions.has(key))
}

/** Role ids among `roleIds` whose grants include a Super-only permission (set.billing / pay.void) or that are locked. */
export async function privilegedRoleIds(db: Executor, roleIds: readonly string[]): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set()
  const [locked, rp] = await Promise.all([
    db
      .selectFrom('roles')
      .select('id')
      .where('id', 'in', [...roleIds])
      .where('is_locked', '=', true)
      .execute(),
    db
      .selectFrom('role_permissions')
      .select('role_id')
      .where('role_id', 'in', [...roleIds])
      .where('permission_key', 'in', [...SUPER_ONLY_PERMISSIONS])
      .execute(),
  ])
  return new Set([...locked.map((r) => r.id), ...rp.map((r) => r.role_id)])
}
