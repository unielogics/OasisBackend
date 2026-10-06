import type { Executor } from '../../platform/db.js'
import type { LimitKind } from './catalog.js'
import {
  allowedKeys,
  effectiveAll,
  limitsOf,
  type EffectiveMap,
  type Override,
  type RoleGrant,
} from './engine.js'
import { employeeOverrides, employeeRoleIds, loadGrants } from './repository.js'

export interface Authority {
  /** The roles that decide what the person may do: their own, or the single viewed role under view-as. */
  roles: RoleGrant[]
  overrides: Record<string, Override>
  effective: EffectiveMap
  permissions: Set<string>
  limits: Partial<Record<LimitKind, number | null>>
  /** The authority includes the locked Super Admin role. */
  isSuper: boolean
}

const authorityOf = (roles: RoleGrant[], overrides: Record<string, Override>): Authority => {
  const effective = effectiveAll(roles, overrides)
  return {
    roles,
    overrides,
    effective,
    permissions: new Set(allowedKeys(effective)),
    limits: limitsOf(effective),
    isSuper: roles.some((r) => r.locked),
  }
}

/** Authority of an employee from the database, uncached. */
export async function loadAuthority(db: Executor, employeeId: string): Promise<Authority> {
  const [roleIds, overrides] = await Promise.all([employeeRoleIds(db, employeeId), employeeOverrides(db, employeeId)])
  return authorityOf(await loadGrants(db, roleIds), overrides)
}

/**
 * View-as authority: ONLY the viewed role, no per-person exceptions (the design's "Preview as"). Returns null when the
 * role no longer exists.
 */
export async function loadViewAsAuthority(db: Executor, roleId: string): Promise<Authority | null> {
  const [grant] = await loadGrants(db, [roleId])
  return grant ? authorityOf([grant], {}) : null
}

const MAX_CACHE_ENTRIES = 1000

/**
 * Per-process cache of resolved authority keyed by (employee, viewed role) and tagged with the global rbac_state
 * version: every change that can alter anyone's permissions bumps the version in its own transaction, so a request that
 * reads the current version never sees a stale entry, in this process or any other.
 */
export class RbacService {
  private readonly cache = new Map<string, { version: number; value: Authority | null }>()

  constructor(private readonly db: Executor) {}

  async authorityFor(employeeId: string, version: number): Promise<Authority> {
    const hit = this.cache.get(employeeId)
    if (hit && hit.version === version && hit.value) return hit.value
    const value = await loadAuthority(this.db, employeeId)
    this.put(employeeId, version, value)
    return value
  }

  async viewAsAuthorityFor(roleId: string, version: number): Promise<Authority | null> {
    const key = `view:${roleId}`
    const hit = this.cache.get(key)
    if (hit && hit.version === version) return hit.value
    const value = await loadViewAsAuthority(this.db, roleId)
    this.put(key, version, value)
    return value
  }

  private put(key: string, version: number, value: Authority | null): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear()
    this.cache.set(key, { version, value })
  }

  clear(): void {
    this.cache.clear()
  }
}
