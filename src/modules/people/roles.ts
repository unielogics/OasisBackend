// Roles: the Settings "Roles & permissions" matrix. Locked roles reject edits; only a Super Admin changes limits or grants
// set.billing / pay.void; every change bumps the rbac version so cached authority is refreshed on the next request.
import type { AuditContext } from '../../platform/audit.js'
import * as audit from '../../platform/audit.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import type { SessionAuthContext } from '../auth/context.js'
import {
  CUSTOM_ROLE_DEFAULTS,
  LIMIT_CHOICES_CENTS,
  LIMIT_KINDS,
  PERMISSIONS,
  PERMISSION_KEY_SET,
  SUPER_ONLY_PERMISSIONS,
  type LimitKind,
} from '../rbac/catalog.js'
import { effectivePermission, roleLimit, type Override } from '../rbac/engine.js'
import { bumpRbacVersion, compareRoles, loadGrants } from '../rbac/repository.js'
import { requireSuper } from './guards.js'

export interface RoleView {
  id: string
  key: string | null
  name: string
  description: string
  locked: boolean
  custom: boolean
  peopleCount: number
  permissionCount: number
  version: number
}

export interface RolesOverview {
  roles: RoleView[]
  permissions: Array<{
    key: string
    module: string
    label: string
    hasLimit: boolean
    sort: number
    limitKind: LimitKind | null
  }>
  /** roleId -> permission key -> granted. */
  matrix: Record<string, Record<string, boolean>>
  /** roleId -> kind -> cents (null = No limit); a role with no stored row shows the 2500 default. */
  limits: Record<string, Record<LimitKind, number | null>>
  limitChoicesCents: Array<number | null>
  rbacVersion: number
}

export interface RolesServiceDeps {
  db: Db
  newId: NewId
}

const clampName = (s: string): string => s.trim().replace(/\s+/g, ' ').slice(0, 60)

export class RolesService {
  constructor(private readonly d: RolesServiceDeps) {}

  async overview(db: Executor = this.d.db): Promise<RolesOverview> {
    const [rows, grants, counts, version] = await Promise.all([
      db.selectFrom('roles').selectAll().execute(),
      loadGrants(db),
      db
        .selectFrom('employee_roles as er')
        .innerJoin('employees as e', 'e.id', 'er.employee_id')
        .select(['er.role_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('e.status', '!=', 'inactive')
        .groupBy('er.role_id')
        .execute(),
      db.selectFrom('rbac_state').select('version').executeTakeFirstOrThrow(),
    ])
    const people = new Map(counts.map((c) => [c.role_id, Number(c.n)]))
    const byId = new Map(grants.map((g) => [g.id, g]))
    const matrix: RolesOverview['matrix'] = {}
    const limits: RolesOverview['limits'] = {}
    const roles = rows.sort(compareRoles).map<RoleView>((r) => {
      const g = byId.get(r.id)!
      matrix[r.id] = Object.fromEntries(PERMISSIONS.map((p) => [p.key, r.is_locked || g.perms.has(p.key)]))
      limits[r.id] = Object.fromEntries(LIMIT_KINDS.map((k) => [k, roleLimit(g, k)])) as Record<
        LimitKind,
        number | null
      >
      return {
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        locked: r.is_locked,
        custom: r.is_custom,
        peopleCount: people.get(r.id) ?? 0,
        permissionCount: Object.values(matrix[r.id]!).filter(Boolean).length,
        version: r.version,
      }
    })
    return {
      roles,
      permissions: PERMISSIONS.map((p, i) => ({
        key: p.key,
        module: p.module,
        label: p.label,
        hasLimit: !!p.limit,
        sort: i + 1,
        limitKind: p.limit ?? null,
      })),
      matrix,
      limits,
      limitChoicesCents: [...LIMIT_CHOICES_CENTS],
      rbacVersion: Number(version.version),
    }
  }

  private async getRole(tx: Executor, id: string, lock = false) {
    const q = tx.selectFrom('roles').selectAll().where('id', '=', id)
    const row = await (lock ? q.forUpdate() : q).executeTakeFirst()
    if (!row) throw new AppError('NOT_FOUND', { detail: 'That role does not exist' })
    return row
  }

  /** Bumps the rbac version and tells every client (settings channel) to refetch /me and /roles. */
  private async changed(
    tx: Tx,
    locationId: string,
    reason: string,
    payload: Record<string, string | number | boolean | null>,
  ): Promise<number> {
    const version = await bumpRbacVersion(tx)
    await realtime.publish(tx, {
      locationId,
      channel: 'settings',
      type: 'rbac.changed',
      payload: { ...payload, reason, rbacVersion: version },
    })
    return version
  }

  /** "Shift Lead", then "Shift Lead 2", "Shift Lead 3" ... skipping names in use (case-insensitive). */
  private async uniqueName(tx: Executor, base: string): Promise<string> {
    const rows = await tx.selectFrom('roles').select('name').execute()
    const taken = new Set(rows.map((r) => r.name.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
  }

  async create(
    actor: SessionAuthContext,
    input: { name?: string; description?: string },
    ac: AuditContext,
  ): Promise<RoleView> {
    const id = await transaction(this.d.db, async (tx) => {
      const requested = input.name !== undefined ? clampName(input.name) : ''
      let name: string
      if (requested) {
        const clash = await tx
          .selectFrom('roles')
          .select('id')
          .where((eb) => eb(eb.fn('lower', ['name']), '=', requested.toLowerCase()))
          .executeTakeFirst()
        if (clash)
          throw new AppError('ROLE_NAME_TAKEN', {
            errors: [{ path: 'body.name', message: 'A role with that name already exists' }],
          })
        name = requested
      } else name = await this.uniqueName(tx, CUSTOM_ROLE_DEFAULTS.name)
      const roleId = this.d.newId()
      await tx
        .insertInto('roles')
        .values({
          id: roleId,
          key: null,
          name,
          description: input.description?.trim() || CUSTOM_ROLE_DEFAULTS.description,
          is_custom: true,
        })
        .execute()
      const crew = await tx.selectFrom('roles').select('id').where('key', '=', 'crew').executeTakeFirst()
      const perms = new Set<string>(CUSTOM_ROLE_DEFAULTS.extraPerms)
      if (crew) {
        const rows = await tx
          .selectFrom('role_permissions')
          .select('permission_key')
          .where('role_id', '=', crew.id)
          .execute()
        for (const r of rows) perms.add(r.permission_key)
      }
      await tx
        .insertInto('role_permissions')
        .values([...perms].map((permission_key) => ({ role_id: roleId, permission_key })))
        .execute()
      await tx
        .insertInto('role_limits')
        .values(
          LIMIT_KINDS.map((kind) => ({
            role_id: roleId,
            kind,
            unlimited: false,
            limit_cents: CUSTOM_ROLE_DEFAULTS.limitDollars * 100,
          })),
        )
        .execute()
      await this.changed(tx, actor.locationId, 'role.created', { roleId })
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'role.create',
        entityType: 'role',
        entityId: roleId,
        after: { name, permissions: [...perms].sort() },
        ctx: ac,
      })
      return roleId
    })
    return this.view(id)
  }

  async view(id: string): Promise<RoleView> {
    const o = await this.overview()
    const r = o.roles.find((x) => x.id === id)
    if (!r) throw new AppError('NOT_FOUND', { detail: 'That role does not exist' })
    return r
  }

  async update(
    actor: SessionAuthContext,
    id: string,
    input: { name?: string; description?: string },
    version: number | null,
    ac: AuditContext,
  ): Promise<RoleView> {
    await transaction(this.d.db, async (tx) => {
      const role = await this.getRole(tx, id, true)
      if (role.is_locked) throw new AppError('ROLE_LOCKED')
      if (version !== null && role.version !== version)
        throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: role.version } })
      const name = input.name !== undefined ? clampName(input.name) : role.name
      if (!name)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'A role needs a name.',
          errors: [{ path: 'body.name', message: 'A role needs a name.' }],
        })
      if (name.toLowerCase() !== role.name.toLowerCase()) {
        const clash = await tx
          .selectFrom('roles')
          .select('id')
          .where((eb) => eb(eb.fn('lower', ['name']), '=', name.toLowerCase()))
          .where('id', '!=', id)
          .executeTakeFirst()
        if (clash)
          throw new AppError('ROLE_NAME_TAKEN', {
            errors: [{ path: 'body.name', message: 'A role with that name already exists' }],
          })
      }
      const description = input.description !== undefined ? input.description.trim() : role.description
      await tx
        .updateTable('roles')
        .set({ name, description, version: role.version + 1 })
        .where('id', '=', id)
        .execute()
      await this.changed(tx, actor.locationId, 'role.updated', { roleId: id })
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'role.update',
        entityType: 'role',
        entityId: id,
        before: { name: role.name, description: role.description },
        after: { name, description },
        ctx: ac,
      })
    })
    return this.view(id)
  }

  async setPermission(
    actor: SessionAuthContext,
    id: string,
    key: string,
    granted: boolean,
    ac: AuditContext,
  ): Promise<{ roleId: string; key: string; granted: boolean }> {
    if (!PERMISSION_KEY_SET.has(key))
      throw new AppError('NOT_FOUND', { detail: 'That permission does not exist' })
    await transaction(this.d.db, async (tx) => {
      const role = await this.getRole(tx, id, true)
      if (role.is_locked) throw new AppError('ROLE_LOCKED')
      if (granted && SUPER_ONLY_PERMISSIONS.has(key)) requireSuper(actor)
      const had = !!(await tx
        .selectFrom('role_permissions')
        .select('role_id')
        .where('role_id', '=', id)
        .where('permission_key', '=', key)
        .executeTakeFirst())
      if (had === granted) return
      if (granted)
        await tx.insertInto('role_permissions').values({ role_id: id, permission_key: key }).execute()
      else
        await tx
          .deleteFrom('role_permissions')
          .where('role_id', '=', id)
          .where('permission_key', '=', key)
          .execute()
      await tx
        .updateTable('roles')
        .set({ version: role.version + 1 })
        .where('id', '=', id)
        .execute()
      await this.changed(tx, actor.locationId, 'role.permission', { roleId: id, key, granted })
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'role.permission',
        entityType: 'role',
        entityId: id,
        before: { key, granted: had },
        after: { key, granted },
        ctx: ac,
      })
    })
    return { roleId: id, key, granted }
  }

  /** value in dollars from the choice list, or null for No limit; stored as cents. Super Admin only. */
  async setLimit(
    actor: SessionAuthContext,
    id: string,
    kind: LimitKind,
    valueDollars: number | null,
    ac: AuditContext,
  ): Promise<{ roleId: string; kind: LimitKind; limitCents: number | null }> {
    requireSuper(actor)
    const cents = valueDollars === null ? null : valueDollars * 100
    await transaction(this.d.db, async (tx) => {
      const role = await this.getRole(tx, id, true)
      if (role.is_locked) throw new AppError('ROLE_LOCKED')
      const prev = await tx
        .selectFrom('role_limits')
        .select(['unlimited', 'limit_cents'])
        .where('role_id', '=', id)
        .where('kind', '=', kind)
        .executeTakeFirst()
      await tx
        .insertInto('role_limits')
        .values({ role_id: id, kind, unlimited: cents === null, limit_cents: cents })
        .onConflict((oc) =>
          oc.columns(['role_id', 'kind']).doUpdateSet({ unlimited: cents === null, limit_cents: cents }),
        )
        .execute()
      await tx
        .updateTable('roles')
        .set({ version: role.version + 1 })
        .where('id', '=', id)
        .execute()
      await this.changed(tx, actor.locationId, 'role.limit', { roleId: id, kind, limitCents: cents })
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'role.limit',
        entityType: 'role',
        entityId: id,
        before: { kind, limitCents: prev ? (prev.unlimited ? null : prev.limit_cents) : 'default' },
        after: { kind, limitCents: cents },
        ctx: ac,
      })
    })
    return { roleId: id, kind, limitCents: cents }
  }

  /**
   * Removes a custom role: strips it from everyone, gives Crew to anyone left with no role, and drops exceptions of the
   * affected people that the change turned into no-ops (an Allow a remaining role already grants, a Deny of something no
   * remaining role grants), which leaves what they can do unchanged.
   */
  async remove(
    actor: SessionAuthContext,
    id: string,
    ac: AuditContext,
  ): Promise<{ removed: true; roleId: string; name: string; affected: number; reassignedToCrew: number }> {
    return transaction(this.d.db, async (tx) => {
      const role = await this.getRole(tx, id, true)
      if (!role.is_custom) throw new AppError('ROLE_NOT_REMOVABLE')
      const holders = (
        await tx.selectFrom('employee_roles').select('employee_id').where('role_id', '=', id).execute()
      ).map((r) => r.employee_id)
      await tx.deleteFrom('employee_roles').where('role_id', '=', id).execute()

      let reassigned = 0
      if (holders.length) {
        const crew = await tx.selectFrom('roles').select('id').where('key', '=', 'crew').executeTakeFirst()
        const remaining = await tx
          .selectFrom('employee_roles')
          .select('employee_id')
          .where('employee_id', 'in', holders)
          .execute()
        const withRole = new Set(remaining.map((r) => r.employee_id))
        const orphans = holders.filter((h) => !withRole.has(h))
        if (orphans.length && crew) {
          await tx
            .insertInto('employee_roles')
            .values(orphans.map((employee_id) => ({ employee_id, role_id: crew.id })))
            .execute()
          reassigned = orphans.length
        }
        await this.cleanOverrides(tx, holders)
      }
      await tx.deleteFrom('roles').where('id', '=', id).execute() // role_permissions / role_limits cascade; sessions.view_as_role_id -> null
      await this.changed(tx, actor.locationId, 'role.removed', { roleId: id })
      await audit.record(tx, {
        locationId: actor.locationId,
        action: 'role.delete',
        entityType: 'role',
        entityId: id,
        before: { name: role.name },
        after: { affected: holders.length, reassignedToCrew: reassigned },
        ctx: ac,
      })
      return {
        removed: true as const,
        roleId: id,
        name: role.name,
        affected: holders.length,
        reassignedToCrew: reassigned,
      }
    })
  }

  private async cleanOverrides(tx: Tx, employeeIds: string[]): Promise<void> {
    const overrides = await tx
      .selectFrom('employee_permission_overrides')
      .select(['employee_id', 'permission_key', 'effect'])
      .where('employee_id', 'in', employeeIds)
      .execute()
    if (overrides.length === 0) return
    const roleRows = await tx
      .selectFrom('employee_roles')
      .select(['employee_id', 'role_id'])
      .where('employee_id', 'in', employeeIds)
      .execute()
    const grants = await loadGrants(tx, [...new Set(roleRows.map((r) => r.role_id))])
    const grantById = new Map(grants.map((g) => [g.id, g]))
    for (const o of overrides) {
      const roles = roleRows
        .filter((r) => r.employee_id === o.employee_id)
        .map((r) => grantById.get(r.role_id)!)
        .filter(Boolean)
      const baseline = effectivePermission(o.permission_key, roles, undefined as Override | undefined)
      const noop = o.effect === 'allow' ? baseline.on : !baseline.on
      if (noop)
        await tx
          .deleteFrom('employee_permission_overrides')
          .where('employee_id', '=', o.employee_id)
          .where('permission_key', '=', o.permission_key)
          .execute()
    }
  }
}
