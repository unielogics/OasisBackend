import { describe, expect, it } from 'vitest'
import { useHarness, type Harness, type Session } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

async function asSuper(h: Harness) {
  const user = await h.createUser({
    email: 'amara@example.test',
    roles: ['super'],
    first: 'Amara',
    last: 'Okoye',
  })
  return { user, session: await h.login(user, '10.2.0.1') }
}

async function asMgmt(h: Harness) {
  const user = await h.createUser({
    email: 'rafael@example.test',
    roles: ['mgmt'],
    first: 'Rafael',
    last: 'Mendes',
  })
  return { user, session: await h.login(user, '10.2.0.2') }
}

const overview = async (h: Harness, s: Session) => h.json<Json>(await h.call('GET', 'roles', { session: s }))
const roleByKey = (o: Json, key: string): Json => o.roles.find((r: Json) => r.key === key)

describe('GET /roles', () => {
  const h = useHarness()

  it('returns roles, the 27-key catalog, the matrix, limits in cents and people counts', async () => {
    const { session } = await asSuper(h)
    await h.createUser({ email: 'r@example.test', roles: ['mgmt', 'acct'] })
    await h.createUser({ email: 'm@example.test', roles: ['crew'] })
    const o = await overview(h, session)
    expect(o.roles.map((r: Json) => r.name)).toEqual([
      'Super Admin',
      'Management',
      'Accounting',
      'Customer Support',
      'Crew',
    ])
    expect(o.permissions).toHaveLength(27)
    expect(o.permissions.filter((p: Json) => p.hasLimit).map((p: Json) => p.key)).toEqual([
      'pay.refund',
      'pay.adjust',
      'pay.credit',
    ])
    expect(o.permissions[0]).toMatchObject({
      key: 'sched.view',
      module: 'Schedule & jobs',
      label: 'View schedule & calendar',
      sort: 1,
    })
    expect(o.roles.map((r: Json) => r.permissionCount)).toEqual([27, 26, 13, 13, 4])
    expect(o.roles.map((r: Json) => r.peopleCount)).toEqual([1, 1, 1, 0, 1])
    expect(roleByKey(o, 'super')).toMatchObject({
      locked: true,
      custom: false,
      description: 'Owner level. Everything, including billing.',
    })
    const id = (k: string) => roleByKey(o, k).id
    expect(o.matrix[id('mgmt')]['set.billing']).toBe(false)
    expect(o.matrix[id('mgmt')]['pay.void']).toBe(true)
    expect(o.matrix[id('crew')]['jobs.status']).toBe(true)
    expect(o.limits[id('super')]).toEqual({ refund: null, adjust: null, credit: null })
    expect(o.limits[id('mgmt')]).toEqual({ refund: 100_000, adjust: 50_000, credit: 50_000 })
    expect(o.limits[id('acct')]).toEqual({ refund: 50_000, adjust: 25_000, credit: 25_000 })
    expect(o.limits[id('support')]).toEqual({ refund: 5000, adjust: 2500, credit: 5000 })
    expect(o.limits[id('crew')]).toEqual({ refund: 2500, adjust: 2500, credit: 2500 })
    expect(o.limitChoicesCents).toEqual([2500, 5000, 10_000, 25_000, 50_000, 100_000, null])
  })

  it('a role with no limit row shows (and is evaluated as) the 2500-cent default; an unlimited row is null', async () => {
    const { session } = await asSuper(h)
    const sup = roleByKey(await overview(h, session), 'support')
    await h.t.db
      .deleteFrom('role_limits')
      .where('role_id', '=', sup.id)
      .where('kind', '=', 'refund')
      .execute()
    await h.t.db
      .updateTable('role_limits')
      .set({ unlimited: true, limit_cents: null })
      .where('role_id', '=', sup.id)
      .where('kind', '=', 'credit')
      .execute()
    await h.t.db
      .updateTable('rbac_state')
      .set((eb) => ({ version: eb('version', '+', 1) }))
      .execute()
    const o = await overview(h, session)
    expect(o.limits[sup.id]).toEqual({ refund: 2500, adjust: 2500, credit: null })
    const u = await h.createUser({ email: 's@example.test', roles: ['support'] })
    const me = h.json<Json>(await h.call('GET', 'me', { session: await h.login(u, '10.6.0.1') }))
    expect(me.limits).toEqual({ refund: 2500, adjust: 2500, credit: null })
  })
})

describe('adding custom roles', () => {
  const h = useHarness()

  it('defaults to "Shift Lead", then "Shift Lead 2", copies Crew plus sched.edit and starts at 25/25/25', async () => {
    const { session } = await asSuper(h)
    const first = await h.call('POST', 'roles', { session, body: {} })
    expect(first.statusCode).toBe(201)
    expect(first.json()).toMatchObject({
      name: 'Shift Lead',
      description: 'Custom role — starts from Crew.',
      custom: true,
      locked: false,
      key: null,
      permissionCount: 5,
      peopleCount: 0,
      version: 1,
    })
    expect(first.headers.location).toBe(`/api/v1/roles/${first.json().id}`)
    const second = await h.call('POST', 'roles', { session, body: {} })
    expect(second.json().name).toBe('Shift Lead 2')
    expect((await h.call('POST', 'roles', { session, body: {} })).json().name).toBe('Shift Lead 3')

    const o = await overview(h, session)
    const granted = Object.entries(o.matrix[first.json().id])
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
    expect(granted).toEqual(['cli.view', 'jobs.checklist', 'jobs.status', 'sched.edit', 'sched.view'])
    expect(o.limits[first.json().id]).toEqual({ refund: 2500, adjust: 2500, credit: 2500 })
    const rows = await h.t.db
      .selectFrom('role_limits')
      .selectAll()
      .where('role_id', '=', first.json().id)
      .execute()
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => !r.unlimited && r.limit_cents === 2500)).toBe(true)
  })

  it('takes an explicit name and description, refuses a name already in use, and needs team.roles', async () => {
    const { session } = await asSuper(h)
    const ok = await h.call('POST', 'roles', {
      session,
      body: { name: '  Closer   Crew ', description: 'Evening team' },
    })
    expect(ok.json()).toMatchObject({ name: 'Closer Crew', description: 'Evening team' })
    const dup = await h.call('POST', 'roles', { session, body: { name: 'closer crew' } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('ROLE_NAME_TAKEN')
    expect((await h.call('POST', 'roles', { session, body: { name: 'crew' } })).statusCode).toBe(409)
    const { session: viewer } = await h.userWithPermissions(['team.view'])
    expect((await h.call('POST', 'roles', { session: viewer, body: {} })).statusCode).toBe(403)
  })
})

describe('renaming roles', () => {
  const h = useHarness()

  it('renames and describes custom and built-in roles but never the locked one', async () => {
    const { session } = await asSuper(h)
    const o = await overview(h, session)
    const mgmt = roleByKey(o, 'mgmt')
    const r = await h.call('PATCH', `roles/${mgmt.id}`, {
      session,
      body: { name: 'Operations', description: 'Runs the floor' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({
      name: 'Operations',
      description: 'Runs the floor',
      version: 2,
      key: 'mgmt',
    })
    const locked = await h.call('PATCH', `roles/${roleByKey(o, 'super').id}`, {
      session,
      body: { name: 'Boss' },
    })
    expect(locked.statusCode).toBe(409)
    expect(locked.json()).toMatchObject({
      code: 'ROLE_LOCKED',
      title: 'Super Admin always has every permission',
      detail: 'Super Admin always has every permission',
    })
    expect((await h.call('PATCH', `roles/${mgmt.id}`, { session, body: { name: 'crew' } })).json().code).toBe(
      'ROLE_NAME_TAKEN',
    )
    expect((await h.call('PATCH', `roles/${mgmt.id}`, { session, body: { name: '   ' } })).statusCode).toBe(
      422,
    )
    expect((await h.call('PATCH', `roles/${mgmt.id}`, { session, body: {} })).statusCode).toBe(200)
    const stale = await h.call('PATCH', `roles/${mgmt.id}`, {
      session,
      body: { name: 'Ops' },
      headers: { 'if-match': '"1"' },
    })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().meta.currentVersion).toBe(3)
    expect(
      (await h.call('PATCH', 'roles/00000000-0000-7000-8000-000000000000', { session, body: { name: 'X' } }))
        .statusCode,
    ).toBe(404)
  })
})

describe('role permissions', () => {
  const h = useHarness()

  const grant = (s: Session, roleId: string, key: string, granted: boolean) =>
    h.call('PUT', `roles/${roleId}/permissions/${key}`, { session: s, body: { granted } })

  it('grants and revokes, idempotently, bumping the rbac version and telling clients', async () => {
    const { session } = await asSuper(h)
    const crew = roleByKey(await overview(h, session), 'crew')
    const before = (await overview(h, session)).rbacVersion
    const on = await grant(session, crew.id, 'cli.export', true)
    expect(on.statusCode).toBe(200)
    expect(on.json()).toEqual({ roleId: crew.id, key: 'cli.export', granted: true })
    const mid = (await overview(h, session)).rbacVersion
    expect(mid).toBeGreaterThan(before)
    expect((await grant(session, crew.id, 'cli.export', true)).statusCode).toBe(200) // no-op
    expect((await overview(h, session)).rbacVersion).toBe(mid)
    expect(roleByKey(await overview(h, session), 'crew').permissionCount).toBe(5)
    expect((await grant(session, crew.id, 'cli.export', false)).statusCode).toBe(200)
    expect(roleByKey(await overview(h, session), 'crew').permissionCount).toBe(4)

    const ev = await h.t.db
      .selectFrom('realtime_events')
      .selectAll()
      .where('type', '=', 'rbac.changed')
      .orderBy('id')
      .execute()
    expect(ev).toHaveLength(2)
    expect(ev[0]).toMatchObject({ channel: 'settings', target_user_id: null })
    expect(ev[0]!.payload).toMatchObject({
      reason: 'role.permission',
      roleId: crew.id,
      key: 'cli.export',
      granted: true,
      rbacVersion: mid,
    })
    const audit = await h.t.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('action', '=', 'role.permission')
      .execute()
    expect(audit).toHaveLength(2)
  })

  it('rejects the locked role with the design text, unknown keys and unknown roles', async () => {
    const { session } = await asSuper(h)
    const o = await overview(h, session)
    for (const granted of [true, false]) {
      const res = await grant(session, roleByKey(o, 'super').id, 'cli.export', granted)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        code: 'ROLE_LOCKED',
        title: 'Super Admin always has every permission',
      })
    }
    expect((await grant(session, roleByKey(o, 'crew').id, 'made.up', true)).statusCode).toBe(404)
    expect(
      (await grant(session, '00000000-0000-7000-8000-000000000000', 'cli.export', true)).statusCode,
    ).toBe(404)
    expect(
      (await h.call('PUT', `roles/${roleByKey(o, 'crew').id}/permissions/cli.export`, { session, body: {} }))
        .statusCode,
    ).toBe(422)
  })

  it('only a Super Admin may grant set.billing or pay.void', async () => {
    const sup = await asSuper(h)
    const mgmt = await asMgmt(h)
    const crew = roleByKey(await overview(h, sup.session), 'crew')
    for (const key of ['set.billing', 'pay.void']) {
      const denied = await grant(mgmt.session, crew.id, key, true)
      expect(denied.statusCode).toBe(403)
      expect(denied.json().code).toBe('SUPER_ONLY')
      expect((await grant(mgmt.session, crew.id, key, false)).statusCode).toBe(200) // revoking is not a grant
      expect((await grant(sup.session, crew.id, key, true)).statusCode).toBe(200)
    }
    // Management may grant ordinary permissions
    expect((await grant(mgmt.session, crew.id, 'cli.export', true)).statusCode).toBe(200)
  })

  it('a change reaches signed-in people on their next request (cache is keyed by the rbac version)', async () => {
    const sup = await asSuper(h)
    const roleRes = await h.call('POST', 'roles', { session: sup.session, body: { name: 'Lookers' } })
    const roleId = roleRes.json().id
    const emp = await h.createUser({ email: 'l@example.test', roles: [roleId] })
    const s = await h.login(emp, '10.6.1.1')
    const can = async () =>
      h.json<Json>(await h.call('GET', 'me', { session: s })).permissions['team.view'].on
    expect(await can()).toBe(false)
    await grant(sup.session, roleId, 'team.view', true)
    expect(await can()).toBe(true)
    expect((await h.call('GET', 'employees', { session: s })).statusCode).toBe(200)
    await grant(sup.session, roleId, 'team.view', false)
    expect(await can()).toBe(false)
    expect((await h.call('GET', 'employees', { session: s })).statusCode).toBe(403)
  })
})

describe('role limits', () => {
  const h = useHarness()

  const setLimit = (s: Session, roleId: string, kind: string, value: unknown) =>
    h.call('PUT', `roles/${roleId}/limits/${kind}`, { session: s, body: { value } })

  it('stores dollars as cents, null as unlimited, and the effect is visible to the role holders', async () => {
    const { session } = await asSuper(h)
    const created = (await h.call('POST', 'roles', { session, body: { name: 'Desk' } })).json()
    await h.call('PUT', `roles/${created.id}/permissions/pay.refund`, { session, body: { granted: true } })
    const emp = await h.createUser({ email: 'd@example.test', roles: [created.id] })
    const ds = await h.login(emp, '10.6.2.1')
    const refundLimit = async () =>
      h.json<Json>(await h.call('GET', 'me', { session: ds })).permissions['pay.refund'].limit

    expect(await refundLimit()).toBe(2500)
    for (const [value, cents] of [
      [25, 2500],
      [50, 5000],
      [100, 10_000],
      [250, 25_000],
      [500, 50_000],
      [1000, 100_000],
    ] as const) {
      const r = await setLimit(session, created.id, 'refund', value)
      expect(r.json()).toEqual({ roleId: created.id, kind: 'refund', limitCents: cents })
      expect(await refundLimit()).toBe(cents)
    }
    const row = await h.t.db
      .selectFrom('role_limits')
      .selectAll()
      .where('role_id', '=', created.id)
      .where('kind', '=', 'refund')
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ unlimited: false, limit_cents: 100_000 })
    const none = await setLimit(session, created.id, 'refund', null)
    expect(none.json().limitCents).toBeNull()
    expect(await refundLimit()).toBeNull()
    const nrow = await h.t.db
      .selectFrom('role_limits')
      .selectAll()
      .where('role_id', '=', created.id)
      .where('kind', '=', 'refund')
      .executeTakeFirstOrThrow()
    expect(nrow).toMatchObject({ unlimited: true, limit_cents: null })
    const o = await overview(h, session)
    expect(o.limits[created.id]).toEqual({ refund: null, adjust: 2500, credit: 2500 })
  })

  it('accepts only the chip values, a known kind, an unlocked role', async () => {
    const { session } = await asSuper(h)
    const o = await overview(h, session)
    const crew = roleByKey(o, 'crew').id
    for (const bad of [75, 0, -25, 1001, 25.5, 'fifty', undefined])
      expect((await setLimit(session, crew, 'refund', bad)).statusCode).toBe(422)
    expect((await setLimit(session, crew, 'tip', 25)).statusCode).toBe(422)
    const locked = await setLimit(session, roleByKey(o, 'super').id, 'refund', 25)
    expect(locked.statusCode).toBe(409)
    expect(locked.json().detail).toBe('Super Admin always has every permission')
    expect((await setLimit(session, '00000000-0000-7000-8000-000000000000', 'refund', 25)).statusCode).toBe(
      404,
    )
  })

  it('only a Super Admin may change limits, even a Management person who may edit roles', async () => {
    const sup = await asSuper(h)
    const mgmt = await asMgmt(h)
    const mg = roleByKey(await overview(h, sup.session), 'mgmt')
    const res = await setLimit(mgmt.session, mg.id, 'refund', null)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('SUPER_ONLY')
    const row = await h.t.db
      .selectFrom('role_limits')
      .select(['unlimited', 'limit_cents'])
      .where('role_id', '=', mg.id)
      .where('kind', '=', 'refund')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ unlimited: false, limit_cents: 100_000 })
    expect((await setLimit(sup.session, mg.id, 'refund', 500)).statusCode).toBe(200)
  })
})

describe('removing custom roles', () => {
  const h = useHarness()

  it('only custom roles can be removed', async () => {
    const { session } = await asSuper(h)
    const o = await overview(h, session)
    for (const key of ['mgmt', 'crew']) {
      const r = await h.call('DELETE', `roles/${roleByKey(o, key).id}`, { session })
      expect(r.statusCode).toBe(409)
      expect(r.json().code).toBe('ROLE_NOT_REMOVABLE')
    }
    expect((await h.call('DELETE', `roles/${roleByKey(o, 'super').id}`, { session })).json().code).toBe(
      'ROLE_NOT_REMOVABLE',
    )
    expect(
      (await h.call('DELETE', 'roles/00000000-0000-7000-8000-000000000000', { session })).statusCode,
    ).toBe(404)
  })

  it('strips the role from people, gives Crew to anyone left with none, cleans no-op exceptions and returns the counts', async () => {
    const { session } = await asSuper(h)
    const lead = (await h.call('POST', 'roles', { session, body: {} })).json()
    await h.call('PUT', `roles/${lead.id}/permissions/cli.export`, { session, body: { granted: true } })
    const only = await h.createUser({
      email: 'only@example.test',
      roles: [lead.id],
      overrides: { 'cli.export': 'allow', 'pay.void': 'deny', 'cli.edit': 'allow' },
    })
    const both = await h.createUser({
      email: 'both@example.test',
      roles: [lead.id, 'support'],
      overrides: { 'cli.edit': 'allow' },
    })
    const none = await h.createUser({ email: 'none@example.test', roles: ['mgmt'] })
    const before = (await overview(h, session)).rbacVersion

    const res = await h.call('DELETE', `roles/${lead.id}`, { session })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      removed: true,
      roleId: lead.id,
      name: 'Shift Lead',
      affected: 2,
      reassignedToCrew: 1,
    })

    const roleKeys = async (employeeId: string) =>
      (
        await h.t.db
          .selectFrom('employee_roles as er')
          .innerJoin('roles as r', 'r.id', 'er.role_id')
          .select('r.key')
          .where('er.employee_id', '=', employeeId)
          .execute()
      )
        .map((r) => r.key)
        .sort()
    expect(await roleKeys(only.employeeId)).toEqual(['crew'])
    expect(await roleKeys(both.employeeId)).toEqual(['support'])
    expect(await roleKeys(none.employeeId)).toEqual(['mgmt'])

    const ov = async (employeeId: string) =>
      Object.fromEntries(
        (
          await h.t.db
            .selectFrom('employee_permission_overrides')
            .select(['permission_key', 'effect'])
            .where('employee_id', '=', employeeId)
            .execute()
        ).map((r) => [r.permission_key, r.effect]),
      )
    // 'only' now has just Crew: allow cli.export is still a real exception (no role grants it), allow cli.edit too;
    // deny pay.void was already a no-op (Crew never had it) and is dropped
    expect(await ov(only.employeeId)).toEqual({ 'cli.export': 'allow', 'cli.edit': 'allow' })
    // 'both' keeps Support, which already grants cli.edit, so that allow became redundant and is dropped
    expect(await ov(both.employeeId)).toEqual({})

    expect(await h.t.db.selectFrom('roles').select('id').where('id', '=', lead.id).execute()).toEqual([])
    expect(
      await h.t.db.selectFrom('role_permissions').select('role_id').where('role_id', '=', lead.id).execute(),
    ).toEqual([])
    expect(
      await h.t.db.selectFrom('role_limits').select('role_id').where('role_id', '=', lead.id).execute(),
    ).toEqual([])
    expect((await overview(h, session)).rbacVersion).toBeGreaterThan(before)

    // effective authority is unchanged by the cleanup
    const s = await h.login(only, '10.6.3.1')
    const me = h.json<Json>(await h.call('GET', 'me', { session: s }))
    expect(me.permissions['cli.export']).toEqual({ on: true })
    expect(me.permissions['cli.edit']).toEqual({ on: true })
    expect(me.permissions['pay.void']).toEqual({ on: false })
    expect(me.roles.map((r: Json) => r.key)).toEqual(['crew'])
  })

  it('a removed role that another Super Admin was viewing as simply stops being viewed', async () => {
    const a = await asSuper(h)
    const bUser = await h.createUser({ email: 'b@example.test', roles: ['super'] })
    const b = await h.login(bUser, '10.6.4.1')
    const lead = (await h.call('POST', 'roles', { session: a.session, body: {} })).json()
    expect((await h.call('POST', 'me/view-as', { session: b, body: { roleId: lead.id } })).statusCode).toBe(
      200,
    )
    expect(h.json<Json>(await h.call('GET', 'me', { session: b })).viewAs).toMatchObject({
      active: true,
      roleName: 'Shift Lead',
    })
    expect((await h.call('DELETE', `roles/${lead.id}`, { session: a.session })).statusCode).toBe(200)
    const me = h.json<Json>(await h.call('GET', 'me', { session: b }))
    expect(me.viewAs).toMatchObject({ active: false, canViewAs: true, roleId: null })
    expect(me.isSuperAdmin).toBe(true)
    expect(me.permissions['team.roles']).toEqual({ on: true })
  })
})
