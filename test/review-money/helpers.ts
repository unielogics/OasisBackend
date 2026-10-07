// Shared bits of the money review tests: users and stub actors for driving PaymentsService without HTTP.
import type { Executor } from '../../src/platform/db.js'
import type { NewId } from '../../src/platform/ids.js'
import type { PayActor } from '../../src/modules/payments/actor.js'
import type { CommandContext } from '../../src/modules/payments/commands.js'

export interface StubUser {
  userId: string
  employeeId: string
  name: string
}

export async function makeUser(db: Executor, newId: NewId, first: string): Promise<StubUser> {
  const employeeId = newId()
  const userId = newId()
  await db
    .insertInto('employees')
    .values({
      id: employeeId,
      first,
      last: 'Review',
      email: `${first.toLowerCase()}.${employeeId}@example.test`,
      status: 'active',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: userId,
      employee_id: employeeId,
      email: `${first.toLowerCase()}.${userId}@example.test`,
      password_hash: 'x',
    })
    .execute()
  return { userId, employeeId, name: `${first} R.` }
}

export type Limits = { refund: number | null; adjust: number | null; credit: number | null }

/** An actor holding every permission with the given per-transaction limits (null = unlimited). */
export function stubActor(u: StubUser, limits: Partial<Limits> = {}): PayActor {
  const l: Limits = { refund: 2500, adjust: 2500, credit: 2500, ...limits }
  return {
    userId: u.userId,
    employeeId: u.employeeId,
    name: u.name,
    viewAsRoleId: null,
    has: () => true,
    limit: (k) => l[k],
    rolesFor: () => 'Review',
    limitRole: () => 'Review',
  }
}

let keyN = 0
export function ctxFor(locationId: string, actor: PayActor, key?: string): CommandContext {
  return {
    locationId,
    actor,
    audit: {},
    idempotencyKey: key ?? `rv-${++keyN}-${Math.random().toString(36).slice(2, 8)}`,
  }
}
