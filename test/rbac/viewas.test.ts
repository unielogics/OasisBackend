import { describe, expect, it } from 'vitest'
import { useHarness, type Harness, type Session } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const roleId = async (h: Harness, key: string): Promise<string> =>
  (await h.t.db.selectFrom('roles').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id

const viewAs = (h: Harness, s: Session, id: string | null) =>
  h.call('POST', 'me/view-as', { session: s, body: { roleId: id } })
const me = async (h: Harness, s: Session) => h.json<Json>(await h.call('GET', 'me', { session: s }))

describe('view as', () => {
  const h = useHarness()

  async function superUser(email = 'amara@example.test', overrides?: Record<string, 'allow' | 'deny'>) {
    const user = await h.createUser({ email, roles: ['super'], first: 'Amara', last: 'Okoye', overrides })
    return { user, session: await h.login(user, '10.2.0.1') }
  }

  it('only a person who holds the locked Super Admin role may use it', async () => {
    const mgmt = await h.createUser({ email: 'm@example.test', roles: ['mgmt'] })
    const s = await h.login(mgmt, '10.7.0.1')
    const crew = await roleId(h, 'crew')
    const res = await viewAs(h, s, crew)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('VIEW_AS_FORBIDDEN')
    expect(await h.t.db.selectFrom('sessions').select('view_as_role_id').execute()).toEqual([
      { view_as_role_id: null },
    ])
    expect((await me(h, s)).viewAs).toMatchObject({ canViewAs: false, active: false, options: [] })
    // a Super-looking custom role does not count: the real identity must hold the locked role
    const { session } = await h.userWithPermissions(['team.roles', 'team.view', 'team.edit'])
    expect((await viewAs(h, session, crew)).statusCode).toBe(403)
  })

  it('evaluates as the viewed role only: permissions, limits and display role change, and it persists in the session', async () => {
    const { session } = await superUser()
    const full = await me(h, session)
    expect(full.viewAs).toMatchObject({ canViewAs: true, active: false, roleId: null, roleName: null })
    expect(full.viewAs.options.map((o: Json) => o.key)).toEqual(['super', 'mgmt', 'acct', 'support', 'crew'])
    expect(full.viewAs.options[1]).toMatchObject({
      name: 'Management',
      locked: false,
      limits: { refund: 100_000, adjust: 50_000, credit: 50_000 },
    })
    expect(full.viewAs.options[0]).toMatchObject({
      locked: true,
      limits: { refund: null, adjust: null, credit: null },
    })

    const support = await roleId(h, 'support')
    const res = await viewAs(h, session, support)
    expect(res.statusCode).toBe(200)
    const asSupport = res.json() as Json
    expect(asSupport.viewAs).toMatchObject({
      active: true,
      canViewAs: true,
      roleId: support,
      roleName: 'Customer Support',
    })
    expect(asSupport.displayRole).toBe('Customer Support')
    expect(asSupport.isSuperAdmin).toBe(true) // the real identity, so the menu stays available
    expect(asSupport.limits).toEqual({ refund: 5000, adjust: 2500, credit: 5000 })
    expect(asSupport.permissions['team.roles']).toEqual({ on: false })
    expect(asSupport.permissions['pay.refund']).toEqual({ on: true, limit: 5000 })
    expect(asSupport.permissions['set.billing']).toEqual({ on: false })
    expect(asSupport.roles.map((r: Json) => r.key)).toEqual(['support'])

    // persisted server-side: a later request still sees it
    expect((await me(h, session)).viewAs).toMatchObject({ active: true, roleId: support })
    expect(
      (await h.t.db.selectFrom('sessions').select('view_as_role_id').executeTakeFirstOrThrow())
        .view_as_role_id,
    ).toBe(support)
    // and so does a fresh login: view-as is per session, a new session starts as the real person
    const again = await h.login(
      { email: 'amara@example.test', password: 'correct horse battery' },
      '10.2.0.9',
    )
    expect((await me(h, again)).viewAs).toMatchObject({ active: false })
  })

  it('cannot escalate: while viewing a lesser role the person has only that role', async () => {
    const { session } = await superUser()
    const crew = await roleId(h, 'crew')
    await viewAs(h, session, crew)
    for (const url of ['employees', 'roles'])
      expect((await h.call('GET', url, { session })).statusCode).toBe(403)
    expect((await h.call('POST', 'roles', { session, body: {} })).statusCode).toBe(403)

    // Management can edit roles, but is still not Super: limits, Super-only grants and Super assignment stay closed
    const mgmt = await roleId(h, 'mgmt')
    await viewAs(h, session, mgmt)
    expect((await h.call('GET', 'roles', { session })).statusCode).toBe(200)
    const limit = await h.call('PUT', `roles/${mgmt}/limits/refund`, { session, body: { value: null } })
    expect(limit.statusCode).toBe(403)
    expect(limit.json().code).toBe('SUPER_ONLY')
    const grant = await h.call('PUT', `roles/${crew}/permissions/set.billing`, {
      session,
      body: { granted: true },
    })
    expect(grant.json().code).toBe('SUPER_ONLY')
    const sup = await roleId(h, 'super')
    const assign = await h.call('POST', 'employees', {
      session,
      body: { first: 'X', phone: '(305) 555-0100', roles: [sup] },
    })
    expect(assign.json().code).toBe('SUPER_ONLY')
    expect((await me(h, session)).isSuperAdmin).toBe(true)
  })

  it('ignores per-person exceptions, in both directions', async () => {
    const { session } = await superUser('amara@example.test', {
      'cli.export': 'deny',
      'sched.override': 'allow',
    })
    const full = await me(h, session)
    expect(full.permissions['cli.export']).toEqual({ on: false }) // a Deny beats even Super for the real person
    const crew = await roleId(h, 'crew')
    const viewed = (await viewAs(h, session, crew)).json() as Json
    expect(viewed.permissions['sched.override']).toEqual({ on: false }) // her allow exception does not carry over
    const acct = await roleId(h, 'acct')
    const asAcct = (await viewAs(h, session, acct)).json() as Json
    expect(asAcct.permissions['cli.export']).toEqual({ on: true }) // and her deny does not either
  })

  it('Super can always exit, even from a role that cannot do anything', async () => {
    const { session } = await superUser()
    const crew = await roleId(h, 'crew')
    await viewAs(h, session, crew)
    const out = await viewAs(h, session, null)
    expect(out.statusCode).toBe(200)
    expect(out.json().viewAs).toMatchObject({ active: false, roleId: null })
    expect(out.json().permissions['team.roles']).toEqual({ on: true })
    expect((await h.call('GET', 'roles', { session })).statusCode).toBe(200)
    // switching straight from one viewed role to another also works
    await viewAs(h, session, crew)
    expect((await viewAs(h, session, await roleId(h, 'acct'))).json().displayRole).toBe('Accounting')
  })

  it('rejects an unknown role and a malformed body', async () => {
    const { session } = await superUser()
    expect((await viewAs(h, session, '00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
    expect((await h.call('POST', 'me/view-as', { session, body: { roleId: 'crew' } })).statusCode).toBe(422)
    expect((await h.call('POST', 'me/view-as', { session, body: {} })).statusCode).toBe(422)
  })

  it('a person who is no longer Super gets no view-as even if the session still carries one', async () => {
    const a = await superUser('a@example.test')
    const bUser = await h.createUser({ email: 'b@example.test', roles: ['super'] })
    const b = await h.login(bUser, '10.7.1.1')
    await viewAs(h, b, await roleId(h, 'crew'))
    expect((await me(h, b)).viewAs.active).toBe(true)
    const row = await h.t.db
      .selectFrom('employees')
      .select('version')
      .where('id', '=', bUser.employeeId)
      .executeTakeFirstOrThrow()
    const demote = await h.call('PUT', `employees/${bUser.employeeId}`, {
      session: a.session,
      body: { roles: ['mgmt'] },
      headers: { 'if-match': `"${row.version}"` },
    })
    expect(demote.statusCode).toBe(200)
    const after = await me(h, b)
    expect(after.viewAs).toMatchObject({ active: false, canViewAs: false })
    expect(after.displayRole).toBe('Management')
    expect(after.permissions['team.roles']).toEqual({ on: true })
    expect((await viewAs(h, b, await roleId(h, 'crew'))).statusCode).toBe(403)
  })

  it('audit rows record the real actor and the viewed role', async () => {
    const { user, session } = await superUser()
    const mgmt = await roleId(h, 'mgmt')
    await viewAs(h, session, mgmt)
    const created = await h.call('POST', 'roles', { session, body: { name: 'Audited' } })
    expect(created.statusCode).toBe(201)
    const rows = await h.t.db.selectFrom('audit_log').selectAll().orderBy('id').execute()
    const setRow = rows.find((r) => r.action === 'user.view-as.set')!
    expect(setRow).toMatchObject({ actor_user_id: user.userId, actor_name: 'Amara O.' })
    const roleRow = rows.find((r) => r.action === 'role.create')!
    expect(roleRow).toMatchObject({
      actor_user_id: user.userId,
      actor_employee_id: user.employeeId,
      actor_name: 'Amara O.',
      view_as_role_id: mgmt,
      actor_roles: 'Management',
    })
    await viewAs(h, session, null)
    await h.call('POST', 'roles', { session, body: { name: 'Audited too' } })
    const after = (
      await h.t.db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'role.create')
        .orderBy('id')
        .execute()
    )[1]!
    expect(after.view_as_role_id).toBeNull()
    expect(after.actor_user_id).toBe(user.userId)
    expect(rows.find((r) => r.action === 'user.view-as.set')!.after).toEqual({ roleId: mgmt })
    expect(
      (
        await h.t.db
          .selectFrom('audit_log')
          .selectAll()
          .where('action', '=', 'user.view-as.clear')
          .executeTakeFirstOrThrow()
      ).before,
    ).toEqual({ roleId: mgmt })
  })
})
