import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ROLE_KEYS,
  DEFAULT_LIMIT_CENTS,
  DEFAULT_ROLES,
  LIMITED_PERMISSION,
  PERMISSION_KEYS,
  PERMISSIONS,
} from '../../src/modules/rbac/catalog.js'
import {
  allowedKeys,
  effectiveAll,
  effectivePermission,
  formatLimit,
  limitsOf,
  roleLimit,
  type Override,
  type RoleGrant,
} from '../../src/modules/rbac/engine.js'

const role = (
  key: string,
  extra: Partial<Pick<RoleGrant, 'locked' | 'limits'>> & { perms?: readonly string[]; name?: string } = {},
): RoleGrant => {
  const def = DEFAULT_ROLES.find((r) => r.key === key)
  return {
    id: `id-${key}`,
    key,
    name: extra.name ?? def?.name ?? key,
    locked: extra.locked ?? def?.locked ?? false,
    perms: new Set(extra.perms ?? def?.perms ?? []),
    limits:
      extra.limits ??
      (def
        ? {
            refund: def.limits.refund === null ? null : def.limits.refund * 100,
            adjust: def.limits.adjust === null ? null : def.limits.adjust * 100,
            credit: def.limits.credit === null ? null : def.limits.credit * 100,
          }
        : {}),
  }
}

const custom = (name: string, perms: string[], limits: RoleGrant['limits'] = {}): RoleGrant => ({
  id: `id-${name}`,
  key: null,
  name,
  locked: false,
  perms: new Set(perms),
  limits,
})

describe('catalog and design defaults', () => {
  it('has the 27 permission keys, 3 of them money-limited', () => {
    expect(PERMISSION_KEYS).toHaveLength(27)
    expect(new Set(PERMISSION_KEYS).size).toBe(27)
    expect(LIMITED_PERMISSION).toEqual({ 'pay.refund': 'refund', 'pay.adjust': 'adjust', 'pay.credit': 'credit' })
  })

  it('default role grants match Settings: super 27, mgmt 26 (all but set.billing), acct 13, support 13, crew 4', () => {
    const count = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, r.perms.length]))
    expect(count).toEqual({ super: 27, mgmt: 26, acct: 13, support: 13, crew: 4 })
    expect(DEFAULT_ROLES.find((r) => r.key === 'mgmt')!.perms).not.toContain('set.billing')
    expect(DEFAULT_ROLES.map((r) => r.key)).toEqual([...BUILTIN_ROLE_KEYS])
    for (const r of DEFAULT_ROLES) for (const k of r.perms) expect(PERMISSION_KEYS).toContain(k)
  })
})

describe('effective permissions (set-domain 2.1)', () => {
  it('Rafael = mgmt + acct: refund limit is the highest of the roles that grant it (1000 > 500)', () => {
    const m = effectiveAll([role('mgmt'), role('acct')])
    expect(m['pay.refund']).toMatchObject({ on: true, limit: 100_000, src: 'via Management + Accounting · ≤ $1,000' })
    expect(m['pay.adjust']).toMatchObject({ on: true, limit: 50_000 })
    expect(m['pay.credit']).toMatchObject({ on: true, limit: 50_000 })
    expect(m['set.billing']).toMatchObject({ on: true, src: 'via Accounting' })
    expect(allowedKeys(m)).toHaveLength(27)
  })

  it('Sofia = support + crew: refund limit 50 (only support grants it), sched.override via exception', () => {
    const roles = [role('support'), role('crew')]
    const m = effectiveAll(roles, { 'sched.override': 'allow' })
    expect(m['pay.refund']).toMatchObject({ on: true, limit: 5000, src: 'via Customer Support · ≤ $50' })
    expect(m['pay.adjust']).toMatchObject({ limit: 2500 })
    expect(m['pay.credit']).toMatchObject({ limit: 5000 })
    expect(m['sched.override']).toEqual({ on: true, src: 'Exception · allowed', ov: 'allow' })
    expect(m['sched.view']).toMatchObject({ on: true, src: 'via Customer Support + Crew' })
    expect(m['set.hours']).toEqual({ on: false, src: 'Not included in assigned roles' })
    // the same roles without the exception cannot override
    expect(effectiveAll(roles)['sched.override']!.on).toBe(false)
  })

  it('a role that lacks a permission never contributes its limit (Crew has 25s but no pay permissions)', () => {
    const m = effectiveAll([role('crew')])
    expect(m['pay.refund']).toEqual({ on: false, src: 'Not included in assigned roles' })
    expect(limitsOf(m)).toEqual({})
  })

  it('deny beats a role grant', () => {
    const m = effectiveAll([role('mgmt')], { 'pay.refund': 'deny' })
    expect(m['pay.refund']).toEqual({ on: false, src: 'Exception · denied', ov: 'deny' })
    expect(limitsOf(m).refund).toBeUndefined()
  })

  it('deny beats even the locked Super role', () => {
    const m = effectiveAll([role('super')], { 'pay.void': 'deny' })
    expect(m['pay.void']!.on).toBe(false)
    expect(m['pay.reports']!.on).toBe(true)
  })

  it('allow with no granting role gets the 2500 default; allow with granting roles keeps the roles limit', () => {
    const noRole = effectiveAll([role('crew')], { 'pay.refund': 'allow' })
    expect(noRole['pay.refund']).toEqual({ on: true, limit: 2500, src: 'Exception · allowed · ≤ $25', ov: 'allow' })
    const withRole = effectiveAll([role('support')], { 'pay.refund': 'allow' })
    expect(withRole['pay.refund']).toMatchObject({ on: true, limit: 5000, src: 'Exception · allowed · ≤ $50', ov: 'allow', via: ['Customer Support'] })
    // an allow for a non-limited permission has no limit
    expect(effectiveAll([role('crew')], { 'sched.override': 'allow' })['sched.override']).not.toHaveProperty('limit')
  })

  it('unlimited (null) wins over any number', () => {
    const m = effectiveAll([role('super'), role('mgmt')])
    expect(m['pay.refund']).toMatchObject({ limit: null, src: 'via Super Admin + Management · No limit' })
    const viaCustom = effectiveAll([custom('A', ['pay.credit'], { credit: null }), custom('B', ['pay.credit'], { credit: 100_000 })])
    expect(viaCustom['pay.credit']!.limit).toBeNull()
  })

  it('a granting role with no limit row counts as the 2500 default, and max still applies', () => {
    const noRow = custom('Shift Lead', ['pay.adjust'])
    expect(effectiveAll([noRow])['pay.adjust']).toMatchObject({ on: true, limit: 2500 })
    expect(roleLimit(noRow, 'refund')).toBe(DEFAULT_LIMIT_CENTS)
    const mixed = effectiveAll([noRow, custom('Low', ['pay.adjust'], { adjust: 1000 })])
    expect(mixed['pay.adjust']!.limit).toBe(2500)
    const higher = effectiveAll([noRow, custom('High', ['pay.adjust'], { adjust: 25_000 })])
    expect(higher['pay.adjust']!.limit).toBe(25_000)
  })

  it('the locked role is unlimited and grants everything whatever rows it has (keyed off is_locked, not the name)', () => {
    const owner: RoleGrant = { id: 'x', key: null, name: 'Owner', locked: true, perms: new Set(), limits: { refund: 1 } }
    const m = effectiveAll([owner])
    expect(allowedKeys(m)).toHaveLength(27)
    expect(m['pay.refund']!.limit).toBeNull()
    expect(roleLimit(owner, 'refund')).toBeNull()
    // a role merely named "Super Admin" that is not locked gets no special treatment
    const fake: RoleGrant = { id: 'y', key: null, name: 'Super Admin', locked: false, perms: new Set(), limits: {} }
    expect(allowedKeys(effectiveAll([fake]))).toHaveLength(0)
  })

  it('no roles and no overrides is everything off; an override alone can switch a permission on', () => {
    expect(allowedKeys(effectiveAll([]))).toHaveLength(0)
    expect(effectiveAll([], { 'cli.export': 'allow' })['cli.export']).toMatchObject({ on: true, src: 'Exception · allowed' })
  })

  it('formats limits the way the matrix chips do', () => {
    expect(formatLimit(null)).toBe('No limit')
    expect(formatLimit(2500)).toBe('≤ $25')
    expect(formatLimit(100_000)).toBe('≤ $1,000')
    expect(formatLimit(2550)).toBe('≤ $25.50')
  })

  it('limitsOf only lists kinds whose permission is on', () => {
    expect(limitsOf(effectiveAll([role('acct')]))).toEqual({ refund: 50_000, adjust: 25_000, credit: 25_000 })
    expect(limitsOf(effectiveAll([role('acct')], { 'pay.credit': 'deny' }))).toEqual({ refund: 50_000, adjust: 25_000 })
  })
})

describe('effective permissions: properties', () => {
  const permArb = fc.constantFrom(...PERMISSION_KEYS)
  const limitArb = fc.constantFrom<number | null | undefined>(undefined, null, 2500, 5000, 10_000, 25_000, 100_000)
  const roleArb = fc.record({
    perms: fc.uniqueArray(permArb, { maxLength: 20 }),
    refund: limitArb,
    adjust: limitArb,
    credit: limitArb,
  })
  const toGrant = (r: { perms: string[]; refund?: number | null; adjust?: number | null; credit?: number | null }, i: number): RoleGrant => ({
    id: `r${i}`,
    key: null,
    name: `R${i}`,
    locked: false,
    perms: new Set(r.perms),
    limits: {
      ...(r.refund !== undefined ? { refund: r.refund } : {}),
      ...(r.adjust !== undefined ? { adjust: r.adjust } : {}),
      ...(r.credit !== undefined ? { credit: r.credit } : {}),
    },
  })
  const overridesArb = fc.dictionary(permArb, fc.constantFrom<Override>('allow', 'deny'))

  it('deny always wins; otherwise a permission is on iff a role grants it or it is allowed', () => {
    fc.assert(
      fc.property(fc.array(roleArb, { maxLength: 4 }), overridesArb, (rs, ov) => {
        const roles = rs.map(toGrant)
        const m = effectiveAll(roles, ov)
        for (const p of PERMISSION_KEYS) {
          const granted = roles.some((r) => r.perms.has(p))
          const expected = ov[p] === 'deny' ? false : ov[p] === 'allow' ? true : granted
          expect(m[p]!.on).toBe(expected)
        }
      }),
    )
  })

  it('the money limit is the max over granting roles only, null wins, default 2500 without a row', () => {
    fc.assert(
      fc.property(fc.array(roleArb, { minLength: 1, maxLength: 4 }), (rs) => {
        const roles = rs.map(toGrant)
        const m = effectiveAll(roles)
        for (const [perm, kind] of Object.entries(LIMITED_PERMISSION)) {
          const granting = roles.filter((r) => r.perms.has(perm))
          if (granting.length === 0) {
            expect(m[perm]!.on).toBe(false)
            continue
          }
          const lims = granting.map((r) => (r.limits[kind] === undefined ? 2500 : r.limits[kind]!))
          const expected = granting.some((r) => r.limits[kind] === null) ? null : Math.max(...lims)
          expect(m[perm]!.limit).toBe(expected)
        }
      }),
    )
  })

  it('adding a role never removes a permission or lowers a limit (absent exceptions)', () => {
    fc.assert(
      fc.property(fc.array(roleArb, { maxLength: 3 }), roleArb, (rs, extra) => {
        const base = effectiveAll(rs.map(toGrant))
        const more = effectiveAll([...rs, extra].map(toGrant))
        for (const p of PERMISSION_KEYS) {
          if (base[p]!.on) {
            expect(more[p]!.on).toBe(true)
            const b = base[p]!.limit
            const a = more[p]!.limit
            if (b === null) expect(a).toBeNull()
            else if (b !== undefined && a !== null) expect(a).toBeGreaterThanOrEqual(b)
          }
        }
      }),
    )
  })

  it('effectivePermission agrees with effectiveAll', () => {
    const roles = [role('support'), role('crew')]
    for (const p of PERMISSIONS) expect(effectivePermission(p.key, roles, undefined)).toEqual(effectiveAll(roles)[p.key])
  })
})
