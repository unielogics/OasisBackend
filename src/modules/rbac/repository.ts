// Reads of the RBAC tables, shared by the engine's service, the people module and the seeds.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import {
  BUILTIN_ROLE_KEYS,
  DEFAULT_ROLES,
  LIMIT_KINDS,
  PERMISSIONS,
  ROLE_PRECEDENCE,
  type LimitKind,
} from './catalog.js'
import type { Override, RoleGrant } from './engine.js'

export interface RoleRow {
  id: string
  key: string | null
  name: string
  description: string
  is_locked: boolean
  is_custom: boolean
  version: number
}

/** Built-in roles in their fixed order, then custom roles alphabetically. */
export function compareRoles(a: { key: string | null; name: string }, b: { key: string | null; name: string }): number {
  const ia = a.key ? ROLE_PRECEDENCE.indexOf(a.key) : -1
  const ib = b.key ? ROLE_PRECEDENCE.indexOf(b.key) : -1
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return a.name.localeCompare(b.name)
}

export async function loadGrants(db: Executor, roleIds?: readonly string[]): Promise<RoleGrant[]> {
  if (roleIds && roleIds.length === 0) return []
  let rq = db.selectFrom('roles').select(['id', 'key', 'name', 'is_locked'])
  if (roleIds) rq = rq.where('id', 'in', [...roleIds])
  const roles = await rq.execute()
  if (roles.length === 0) return []
  const ids = roles.map((r) => r.id)
  const [perms, limits] = await Promise.all([
    db.selectFrom('role_permissions').select(['role_id', 'permission_key']).where('role_id', 'in', ids).execute(),
    db.selectFrom('role_limits').select(['role_id', 'kind', 'unlimited', 'limit_cents']).where('role_id', 'in', ids).execute(),
  ])
  const permsBy = new Map<string, Set<string>>()
  for (const p of perms) {
    const s = permsBy.get(p.role_id) ?? new Set<string>()
    s.add(p.permission_key)
    permsBy.set(p.role_id, s)
  }
  const limitsBy = new Map<string, Partial<Record<LimitKind, number | null>>>()
  for (const l of limits) {
    const m = limitsBy.get(l.role_id) ?? {}
    m[l.kind] = l.unlimited ? null : l.limit_cents
    limitsBy.set(l.role_id, m)
  }
  return roles
    .map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      locked: r.is_locked,
      perms: permsBy.get(r.id) ?? new Set<string>(),
      limits: limitsBy.get(r.id) ?? {},
    }))
    .sort(compareRoles)
}

export async function employeeRoleIds(db: Executor, employeeId: string): Promise<string[]> {
  const rows = await db.selectFrom('employee_roles').select('role_id').where('employee_id', '=', employeeId).execute()
  return rows.map((r) => r.role_id)
}

export async function employeeOverrides(db: Executor, employeeId: string): Promise<Record<string, Override>> {
  const rows = await db
    .selectFrom('employee_permission_overrides')
    .select(['permission_key', 'effect'])
    .where('employee_id', '=', employeeId)
    .execute()
  return Object.fromEntries(rows.map((r) => [r.permission_key, r.effect]))
}

export async function rbacVersion(db: Executor): Promise<number> {
  const r = await db.selectFrom('rbac_state').select('version').executeTakeFirst()
  return Number(r?.version ?? 1)
}

/** Call in the transaction of any change to roles, grants, limits, overrides or a person's roles. */
export async function bumpRbacVersion(tx: Tx): Promise<number> {
  // upsert so a table emptied by a test truncation heals itself
  const r = await sql<{ version: number }>`
    insert into rbac_state (id, version) values (true, 2)
    on conflict (id) do update set version = rbac_state.version + 1
    returning version`.execute(tx)
  return Number(r.rows[0]!.version)
}

/** The permissions table is seeded by the migration; this restores it if rows are missing (an emptied test schema). */
export async function ensurePermissionCatalog(tx: Tx): Promise<void> {
  await tx
    .insertInto('permissions')
    .values(PERMISSIONS.map((p, i) => ({ key: p.key, module: p.module, label: p.label, has_limit: !!p.limit, sort: i + 1 })))
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()
}

/**
 * Creates the five built-in roles with the design's grants and limits when they do not exist yet (matched by key).
 * Existing roles are never touched, so an administrator's edits survive. Safe to call repeatedly and concurrently.
 */
export async function ensureDefaultRoles(tx: Tx, newId: NewId): Promise<Map<string, string>> {
  await ensurePermissionCatalog(tx)
  const ids = new Map<string, string>()
  let created = false
  for (const def of DEFAULT_ROLES) {
    const inserted = await tx
      .insertInto('roles')
      .values({
        id: newId(),
        key: def.key,
        name: def.name,
        description: def.description,
        is_locked: def.locked,
        is_custom: false,
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning('id')
      .executeTakeFirst()
    if (inserted) {
      created = true
      ids.set(def.key, inserted.id)
      await tx
        .insertInto('role_permissions')
        .values(def.perms.map((permission_key) => ({ role_id: inserted.id, permission_key })))
        .execute()
      await tx
        .insertInto('role_limits')
        .values(
          LIMIT_KINDS.map((kind) => {
            const dollars = def.limits[kind]
            return {
              role_id: inserted.id,
              kind,
              unlimited: dollars === null,
              limit_cents: dollars === null ? null : dollars * 100,
            }
          }),
        )
        .execute()
    } else {
      const r = await tx.selectFrom('roles').select('id').where('key', '=', def.key).executeTakeFirstOrThrow()
      ids.set(def.key, r.id)
    }
  }
  if ([...ids.keys()].length !== BUILTIN_ROLE_KEYS.length) throw new Error('default roles incomplete')
  if (created) await bumpRbacVersion(tx)
  return ids
}
