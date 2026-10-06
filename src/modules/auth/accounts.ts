// Creating logins without an invite: the first-user bootstrap (BOOTSTRAP_ADMIN_EMAIL / _PASSWORD on an empty database),
// the `pnpm user:create` CLI, and the dev seeds. Invited employees get their login through acceptInvite instead.
import { sql } from 'kysely'
import * as audit from '../../platform/audit.js'
import { transaction } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import { normalizePhone } from '../../platform/phone.js'
import { bumpRbacVersion, ensureDefaultRoles } from '../rbac/repository.js'
import { defaultSchedule } from '../people/employees.js'
import type { Identity } from './identity.js'
import { passwordProblem } from './password.js'
import { normalizeEmail } from './service.js'

export interface CreateAccountInput {
  email: string
  password: string
  first: string
  last?: string
  title?: string
  phone?: string
  /** Built-in role keys or role ids. Defaults to the Super Admin role. */
  roles?: string[]
}

export interface CreatedAccount {
  employeeId: string
  userId: string
  email: string
  attachedToExisting: boolean
}

/** Creates (or completes) an active employee with a login. Used by the CLI and bootstrap; audited as the system. */
export async function createAccount(
  identity: Identity,
  input: CreateAccountInput,
  o: { onlyIfNoUsers?: boolean } = {},
): Promise<CreatedAccount | null> {
  const email = normalizeEmail(input.email)
  const problem = passwordProblem(input.password, { email })
  if (problem)
    throw new AppError('VALIDATION_FAILED', {
      detail: problem,
      errors: [{ path: 'password', message: problem }],
    })
  const passwordHash = await identity.hasher.hash(input.password)
  const phone = input.phone?.trim() ?? ''

  return transaction(identity.db, async (tx) => {
    if (o.onlyIfNoUsers) {
      await sql`select pg_advisory_xact_lock(hashtext('oasis:bootstrap-admin'))`.execute(tx)
      const n = await tx
        .selectFrom('users')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
      if (Number(n.n) > 0) return null
    }
    const roleIds = await ensureDefaultRoles(tx, identity.newId)
    const refs = input.roles?.length ? input.roles : ['super']
    const wanted: string[] = []
    for (const ref of refs) {
      const id = isUuid(ref) ? ref : roleIds.get(ref)
      const exists = id
        ? await tx.selectFrom('roles').select('id').where('id', '=', id).executeTakeFirst()
        : undefined
      if (!exists)
        throw new AppError('VALIDATION_FAILED', {
          detail: `Unknown role "${ref}"`,
          errors: [{ path: 'roles', message: `Unknown role "${ref}"` }],
        })
      wanted.push(exists.id)
    }

    const existing = await tx
      .selectFrom('employees')
      .select(['id', 'version'])
      .where('email', '=', email)
      .forUpdate()
      .executeTakeFirst()
    const taken = await tx
      .selectFrom('users')
      .select(['id', 'employee_id'])
      .where('email', '=', email)
      .executeTakeFirst()
    if (taken) throw new AppError('EMAIL_TAKEN')
    const now = identity.clock.now()
    let employeeId: string
    if (existing) {
      const hasUser = await tx
        .selectFrom('users')
        .select('id')
        .where('employee_id', '=', existing.id)
        .executeTakeFirst()
      if (hasUser) throw new AppError('EMAIL_TAKEN')
      employeeId = existing.id
      await tx
        .updateTable('employees')
        .set({ status: 'active', deactivated_at: null, version: existing.version + 1, updated_at: now })
        .where('id', '=', employeeId)
        .execute()
    } else {
      employeeId = identity.newId()
      await tx
        .insertInto('employees')
        .values({
          id: employeeId,
          first: input.first.trim() || 'Admin',
          last: (input.last ?? '').trim(),
          title: (input.title ?? '').trim(),
          phone,
          phone_e164: phone ? normalizePhone(phone) : null,
          email,
          status: 'active',
          avatar_color: null,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await tx
        .insertInto('employee_locations')
        .values({ employee_id: employeeId, location_id: identity.locationId })
        .execute()
      await tx
        .insertInto('employee_schedules')
        .values(
          defaultSchedule().map((s) => ({
            employee_id: employeeId,
            weekday: s.weekday,
            is_on: s.on,
            from_min: s.fromMin,
            to_min: s.toMin,
          })),
        )
        .execute()
    }
    await tx
      .insertInto('employee_roles')
      .values(wanted.map((role_id) => ({ employee_id: employeeId, role_id })))
      .onConflict((oc) => oc.doNothing())
      .execute()
    const userId = identity.newId()
    await tx
      .insertInto('users')
      .values({ id: userId, employee_id: employeeId, email, password_hash: passwordHash })
      .execute()
    await bumpRbacVersion(tx)
    await audit.record(tx, {
      locationId: identity.locationId,
      action: 'user.create',
      entityType: 'user',
      entityId: userId,
      after: { email, employeeId, roles: refs },
      ctx: { actor: { name: 'system' } },
    })
    return { employeeId, userId, email, attachedToExisting: !!existing }
  })
}

/**
 * First-user bootstrap: when no user exists yet, creates the Super Admin from the given email and password. Safe to call
 * on every boot and from concurrent processes (an advisory lock serialises the check with the insert).
 */
export async function bootstrapAdmin(
  identity: Identity,
  o: { email: string; password: string },
): Promise<{ created: boolean }> {
  const made = await createAccount(
    identity,
    { email: o.email, password: o.password, first: 'Admin', title: 'Owner', roles: ['super'] },
    { onlyIfNoUsers: true },
  )
  return { created: made !== null }
}
