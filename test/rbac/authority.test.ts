import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { SEED_EMPLOYEES, seedEmail } from '../../db/seeds/people.js'
import { DEFAULT_ROLES, PERMISSIONS } from '../../src/modules/rbac/catalog.js'
import {
  bumpRbacVersion,
  ensureDefaultRoles,
  loadGrants,
  rbacVersion,
} from '../../src/modules/rbac/repository.js'
import { RbacService, loadAuthority } from '../../src/modules/rbac/service.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { createTestDb, dropSchema, useTestDb, workerSchema } from '../helpers/db.js'

describe('database-backed RBAC', () => {
  const t = useTestDb()

  const employeeId = async (first: string): Promise<string> =>
    (
      await t.db
        .selectFrom('employees')
        .select('id')
        .where('email', '=', `${first.toLowerCase()}@oasisautospa.com`)
        .executeTakeFirstOrThrow()
    ).id

  const seed = () => runSeed({ db: t.db, clock: t.clock, profile: 'people' })

  it('the migration seeds exactly the 27 catalog permissions, with limit flags and order', async () => {
    // a scratch schema straight from the migrations (the worker schema is truncated between tests)
    const fresh = await createTestDb({ schema: workerSchema('permcheck') })
    try {
      const rows = await sql<{
        key: string
        module: string
        label: string
        has_limit: boolean
        sort: number
      }>`select * from permissions order by sort`.execute(fresh.db)
      expect(rows.rows).toEqual(
        PERMISSIONS.map((p, i) => ({
          key: p.key,
          module: p.module,
          label: p.label,
          has_limit: !!p.limit,
          sort: i + 1,
        })),
      )
      const state = await sql<{ version: number }>`select version from rbac_state`.execute(fresh.db)
      expect(state.rows).toEqual([{ version: 1 }])
    } finally {
      await dropSchema(fresh.db, fresh.schema)
      await fresh.close()
    }
  })

  it('ensureDefaultRoles creates the design roles once and never overwrites edits', async () => {
    const newId = createIdGenerator(t.clock)
    const ids = await t.db.transaction().execute((tx) => ensureDefaultRoles(tx, newId))
    expect([...ids.keys()]).toEqual(['super', 'mgmt', 'acct', 'support', 'crew'])
    const grants = await loadGrants(t.db)
    for (const def of DEFAULT_ROLES) {
      const g = grants.find((x) => x.key === def.key)!
      expect([...g.perms].sort()).toEqual([...def.perms].sort())
      expect(g.locked).toBe(def.locked)
      for (const kind of ['refund', 'adjust', 'credit'] as const)
        expect(g.limits[kind]).toBe(def.limits[kind] === null ? null : def.limits[kind]! * 100)
    }
    await t.db
      .deleteFrom('role_permissions')
      .where('role_id', '=', ids.get('crew')!)
      .where('permission_key', '=', 'cli.view')
      .execute()
    const v = await rbacVersion(t.db)
    const again = await t.db.transaction().execute((tx) => ensureDefaultRoles(tx, newId))
    expect([...again.entries()]).toEqual([...ids.entries()])
    expect(await rbacVersion(t.db)).toBe(v) // nothing created, nothing bumped
    expect((await loadGrants(t.db)).find((g) => g.key === 'crew')!.perms.has('cli.view')).toBe(false)
    expect(await t.db.selectFrom('roles').select('id').execute()).toHaveLength(5)
  })

  it('seeds the 7 design employees with schedules, skills, pay data and exceptions, and no passwords', async () => {
    await seed()
    const emps = await t.db.selectFrom('employees').selectAll().orderBy('created_at').execute()
    expect(emps.map((e) => `${e.first} ${e.last}`)).toEqual(SEED_EMPLOYEES.map((e) => `${e.first} ${e.last}`))
    expect(emps.map((e) => e.status)).toEqual([
      'active',
      'active',
      'active',
      'active',
      'active',
      'active',
      'invited',
    ])
    expect(await t.db.selectFrom('users').select('id').execute()).toEqual([])
    const by = (first: string) => emps.find((e) => e.first === first)!
    expect(by('Marco')).toMatchObject({
      pay_type: 'commission',
      rate_text: '30',
      title: 'Lead Detailer',
      phone: '(786) 555-0172',
      phone_e164: '+17865550172',
      skills: ['Paint correction', 'Ceramic coating', 'Exotic vehicles'],
    })
    expect(by('Daniel')).toMatchObject({ employment_type: 'part_time', pay_type: 'hourly', rate_text: '34' })
    expect(by('Amara').avatar_color).toBe('#0E7A63')
    expect(by('Kevin').avatar_color).toBe('#6B7280')
    expect(emps.every((e) => e.email === seedEmail(e))).toBe(true)

    const sched = async (first: string) =>
      (
        await t.db
          .selectFrom('employee_schedules')
          .selectAll()
          .where('employee_id', '=', by(first).id)
          .orderBy('weekday')
          .execute()
      )
        .map((s) => (s.is_on ? `${s.weekday}:${s.from_min}-${s.to_min}` : null))
        .filter(Boolean)
    expect(await sched('Amara')).toEqual([
      '1:480-1080',
      '2:480-1080',
      '3:480-1080',
      '4:480-1080',
      '5:480-1080',
      '6:480-1020',
    ])
    expect(await sched('Lena')).toEqual([
      '0:540-900',
      '2:480-1080',
      '3:480-1080',
      '4:480-1080',
      '5:480-1080',
      '6:480-1020',
    ])
    expect(await sched('Daniel')).toEqual(['1:480-1080', '3:480-1080', '5:480-1080'])
    expect(await sched('Kevin')).toEqual([
      '1:480-1080',
      '2:480-1080',
      '3:480-1080',
      '4:480-1080',
      '5:480-1080',
    ])
    expect(
      await t.db
        .selectFrom('employee_schedules')
        .select('weekday')
        .where('employee_id', '=', by('Kevin').id)
        .execute(),
    ).toHaveLength(7)

    const overrides = await t.db.selectFrom('employee_permission_overrides').selectAll().execute()
    expect(overrides).toEqual([
      { employee_id: by('Sofia').id, permission_key: 'sched.override', effect: 'allow' },
    ])
    expect(await t.db.selectFrom('employee_locations').select('employee_id').execute()).toHaveLength(7)
  })

  it('seeding twice changes nothing', async () => {
    await seed()
    const first = await t.db.selectFrom('employees').select(['id', 'version']).orderBy('id').execute()
    await seed()
    expect(await t.db.selectFrom('employees').select(['id', 'version']).orderBy('id').execute()).toEqual(
      first,
    )
    expect(await t.db.selectFrom('employee_roles').select('role_id').execute()).toHaveLength(9)
    expect(await t.db.selectFrom('roles').select('id').execute()).toHaveLength(5)
  })

  it('creates dev logins only when SEED_DEV_PASSWORD is set', async () => {
    process.env.SEED_DEV_PASSWORD = 'dev-only passphrase 1'
    try {
      await seed()
    } finally {
      delete process.env.SEED_DEV_PASSWORD
    }
    const users = await t.db.selectFrom('users').select(['email', 'password_hash']).orderBy('email').execute()
    expect(users.map((u) => u.email)).toEqual([
      'amara@oasisautospa.com',
      'daniel@oasisautospa.com',
      'lena@oasisautospa.com',
      'marco@oasisautospa.com',
      'rafael@oasisautospa.com',
      'sofia@oasisautospa.com',
    ])
    expect(
      users.every(
        (u) => u.password_hash.startsWith('$scrypt$ln=15,r=8,p=3$') && !u.password_hash.includes('dev-only'),
      ),
    ).toBe(true)
  })

  it('refuses SEED_DEV_PASSWORD in production', async () => {
    process.env.SEED_DEV_PASSWORD = 'dev-only passphrase 1'
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(seed()).rejects.toThrow(/must not be used in production/)
    } finally {
      delete process.env.SEED_DEV_PASSWORD
      process.env.NODE_ENV = prev
    }
  })

  it('Rafael (mgmt + acct): refund 1000, adjust 500, credit 500, everything allowed', async () => {
    await seed()
    const a = await loadAuthority(t.db, await employeeId('Rafael'))
    expect(a.limits).toEqual({ refund: 100_000, adjust: 50_000, credit: 50_000 })
    expect(a.permissions.size).toBe(27)
    expect(a.isSuper).toBe(false)
    expect(a.effective['pay.refund']!.src).toBe('via Management + Accounting · ≤ $1,000')
  })

  it('Sofia (support + crew): refund 50, sched.override only through her exception', async () => {
    await seed()
    const id = await employeeId('Sofia')
    const a = await loadAuthority(t.db, id)
    expect(a.limits).toEqual({ refund: 5000, adjust: 2500, credit: 5000 })
    expect(a.effective['sched.override']).toMatchObject({ on: true, src: 'Exception · allowed', ov: 'allow' })
    expect(a.permissions.size).toBe(16)
    await t.db.deleteFrom('employee_permission_overrides').where('employee_id', '=', id).execute()
    expect((await loadAuthority(t.db, id)).permissions.has('sched.override')).toBe(false)
  })

  it('Amara (super): everything and unlimited; Marco (crew): the four crew permissions; Kevin invited still resolves', async () => {
    await seed()
    const amara = await loadAuthority(t.db, await employeeId('Amara'))
    expect(amara.isSuper).toBe(true)
    expect(amara.permissions.size).toBe(27)
    expect(amara.limits).toEqual({ refund: null, adjust: null, credit: null })
    const marco = await loadAuthority(t.db, await employeeId('Marco'))
    expect([...marco.permissions].sort()).toEqual(['cli.view', 'jobs.checklist', 'jobs.status', 'sched.view'])
    expect(marco.limits).toEqual({})
    expect((await loadAuthority(t.db, await employeeId('Daniel'))).permissions.size).toBe(13)
  })

  it('a granting role with no limit row falls back to 2500 and the unlimited flag wins', async () => {
    await seed()
    const id = await employeeId('Daniel') // accounting: 500 / 250 / 250
    const acct = (await loadGrants(t.db)).find((g) => g.key === 'acct')!
    await t.db.deleteFrom('role_limits').where('role_id', '=', acct.id).where('kind', '=', 'refund').execute()
    await t.db
      .updateTable('role_limits')
      .set({ unlimited: true, limit_cents: null })
      .where('role_id', '=', acct.id)
      .where('kind', '=', 'adjust')
      .execute()
    expect((await loadAuthority(t.db, id)).limits).toEqual({ refund: 2500, adjust: null, credit: 25_000 })
  })

  it('the limit storage invariant is enforced by the database', async () => {
    await seed()
    const crew = (await loadGrants(t.db)).find((g) => g.key === 'crew')!
    const bad = (v: { unlimited: boolean; limit_cents: number | null }) =>
      t.db
        .updateTable('role_limits')
        .set(v)
        .where('role_id', '=', crew.id)
        .where('kind', '=', 'refund')
        .execute()
    await expect(bad({ unlimited: true, limit_cents: 100 })).rejects.toThrow()
    await expect(bad({ unlimited: false, limit_cents: null })).rejects.toThrow()
    await expect(bad({ unlimited: false, limit_cents: -1 })).rejects.toThrow()
    await bad({ unlimited: true, limit_cents: null })
  })

  it('caches by (employee, rbac version): a bump forces a reload, the same version serves the cache', async () => {
    await seed()
    const id = await employeeId('Marco')
    const rbac = new RbacService(t.db)
    const v1 = await rbacVersion(t.db)
    const a1 = await rbac.authorityFor(id, v1)
    expect(await rbac.authorityFor(id, v1)).toBe(a1) // same object: served from the cache
    const crew = (await loadGrants(t.db)).find((g) => g.key === 'crew')!
    await t.db
      .insertInto('role_permissions')
      .values({ role_id: crew.id, permission_key: 'cli.export' })
      .execute()
    expect((await rbac.authorityFor(id, v1)).permissions.has('cli.export')).toBe(false) // stale until the version moves
    const v2 = await t.db.transaction().execute((tx) => bumpRbacVersion(tx))
    expect(v2).toBe(v1 + 1)
    const a2 = await rbac.authorityFor(id, v2)
    expect(a2).not.toBe(a1)
    expect(a2.permissions.has('cli.export')).toBe(true)
  })

  it('the version counter heals itself if its row is missing', async () => {
    await sql`delete from rbac_state`.execute(t.db)
    expect(await rbacVersion(t.db)).toBe(1)
    expect(await t.db.transaction().execute((tx) => bumpRbacVersion(tx))).toBe(2)
    expect(await t.db.transaction().execute((tx) => bumpRbacVersion(tx))).toBe(3)
  })
})
