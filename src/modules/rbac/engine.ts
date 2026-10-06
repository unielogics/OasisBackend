// Effective permissions: a pure port of the Settings design's eff() (set-domain 2.1, backend.md 4.3).
//   - permissions are the union over the person's roles;
//   - a money limit is the highest limit among ONLY the roles that grant that permission, null (unlimited) wins, and a
//     role with no limit row for the kind counts as the default 2500 cents;
//   - a per-person Deny beats everything; an Allow keeps the roles' limit when a role grants the permission and
//     otherwise gets the default limit.
// The locked Super Admin role grants everything and is unlimited by definition, whatever rows exist (keyed off
// is_locked, not the name).
import { DEFAULT_LIMIT_CENTS, LIMITED_PERMISSION, PERMISSIONS, type LimitKind } from './catalog.js'

export type Override = 'allow' | 'deny'

export interface RoleGrant {
  id: string
  key: string | null
  name: string
  locked: boolean
  perms: ReadonlySet<string>
  /** Absent kind = no role_limits row (default); null = unlimited; number = cents. */
  limits: Readonly<Partial<Record<LimitKind, number | null>>>
}

export interface EffectivePermission {
  on: boolean
  /** Cents; null = unlimited. Present only for money-limited permissions that are on. */
  limit?: number | null
  /** The label the roles matrix shows, e.g. "via Support + Crew · ≤ $50". */
  src: string
  ov?: Override
  /** Names of the roles that grant the permission. */
  via?: string[]
}

export type EffectiveMap = Record<string, EffectivePermission>

export function roleLimit(role: RoleGrant, kind: LimitKind): number | null {
  if (role.locked) return null
  const v = role.limits[kind]
  return v === undefined ? DEFAULT_LIMIT_CENTS : v
}

/** "No limit" or "≤ $1,000" (whole dollars; a sub-dollar remainder is shown as cents). */
export function formatLimit(cents: number | null): string {
  if (cents === null) return 'No limit'
  const dollars = cents / 100
  const text = Number.isInteger(dollars)
    ? dollars.toLocaleString('en-US')
    : dollars.toLocaleString('en-US', { minimumFractionDigits: 2 })
  return `≤ $${text}`
}

export function effectivePermission(
  perm: string,
  roles: readonly RoleGrant[],
  override?: Override,
): EffectivePermission {
  const granting = roles.filter((r) => r.locked || r.perms.has(perm))
  const kind = LIMITED_PERMISSION[perm]
  let limit: number | null | undefined
  if (kind) {
    const lims = granting.map((r) => roleLimit(r, kind))
    if (lims.length === 0) limit = DEFAULT_LIMIT_CENTS
    else if (lims.includes(null)) limit = null
    else limit = Math.max(...(lims as number[]))
  }
  const tail = kind ? ` · ${formatLimit(limit as number | null)}` : ''

  if (override === 'deny') return { on: false, src: 'Exception · denied', ov: 'deny' }
  if (override === 'allow') {
    return {
      on: true,
      ...(kind ? { limit } : {}),
      src: `Exception · allowed${tail}`,
      ov: 'allow',
      ...(granting.length ? { via: granting.map((r) => r.name) } : {}),
    }
  }
  if (granting.length) {
    return {
      on: true,
      ...(kind ? { limit } : {}),
      src: `via ${granting.map((r) => r.name).join(' + ')}${tail}`,
      via: granting.map((r) => r.name),
    }
  }
  return { on: false, src: 'Not included in assigned roles' }
}

export function effectiveAll(
  roles: readonly RoleGrant[],
  overrides: Readonly<Record<string, Override>> = {},
): EffectiveMap {
  const out: EffectiveMap = {}
  for (const p of PERMISSIONS) out[p.key] = effectivePermission(p.key, roles, overrides[p.key])
  return out
}

export const allowedKeys = (m: EffectiveMap): string[] =>
  Object.entries(m)
    .filter(([, v]) => v.on)
    .map(([k]) => k)

/** Money limits of the kinds whose permission is on (cents; null = unlimited). */
export function limitsOf(m: EffectiveMap): Partial<Record<LimitKind, number | null>> {
  const out: Partial<Record<LimitKind, number | null>> = {}
  for (const [perm, kind] of Object.entries(LIMITED_PERMISSION)) {
    const e = m[perm]
    if (e?.on) out[kind] = e.limit ?? DEFAULT_LIMIT_CENTS
  }
  return out
}
