import { describe, expect, it } from 'vitest'
import { TEST_PASSWORD, useHarness, type Harness, type Session } from '../auth/harness.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

async function asSuper(h: Harness, email = 'amara@example.test') {
  const user = await h.createUser({ email, roles: ['super'], first: 'Amara', last: 'Okoye' })
  return { user, session: await h.login(user, '10.2.0.1') }
}

async function asMgmt(h: Harness, email = 'rafael@example.test') {
  const user = await h.createUser({ email, roles: ['mgmt'], first: 'Rafael', last: 'Mendes' })
  return { user, session: await h.login(user, '10.2.0.2') }
}

const create = (h: Harness, s: Session, body: Json) => h.call('POST', 'employees', { session: s, body })

const valid = (over: Json = {}): Json => ({
  first: 'Kevin',
  last: 'Tran',
  phone: '(786) 555-0151',
  title: 'Detailer',
  ...over,
})

describe('creating employees', () => {
  const h = useHarness()

  it('refuses a missing name or phone and an empty role list with the design strings', async () => {
    const { session } = await asSuper(h)
    const a = await create(h, session, { last: 'Tran' })
    expect(a.statusCode).toBe(422)
    expect(a.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'First name and mobile number are required.',
    })
    expect(a.json().errors.map((e: { path: string }) => e.path)).toEqual(['body.first', 'body.phone'])
    const blank = await create(h, session, valid({ first: '   ' }))
    expect(blank.json().errors[0]).toMatchObject({
      path: 'body.first',
      message: 'First name and mobile number are required.',
    })
    const noPhone = await create(h, session, valid({ phone: '' }))
    expect(noPhone.json().errors[0].path).toBe('body.phone')

    const roles = await create(h, session, valid({ roles: [] }))
    expect(roles.statusCode).toBe(422)
    expect(roles.json()).toMatchObject({
      detail: 'Assign at least one role.',
      errors: [{ path: 'body.roles' }],
    })
    expect((await create(h, session, valid({ roles: ['nope'] }))).statusCode).toBe(422)
    expect((await create(h, session, valid({ phone: '12' }))).json().detail).toBe(
      'Enter a valid mobile number.',
    )
    expect((await create(h, session, valid({ skills: ['Juggling'] }))).statusCode).toBe(422)
    expect((await create(h, session, valid({ overrides: { 'nope.key': 'allow' } }))).statusCode).toBe(422)
    expect((await create(h, session, { ...valid(), unexpected: 1 })).statusCode).toBe(422)
  })

  it('creates an invited employee with design defaults (Crew, Mon-Fri 8-6, hourly, full time) and sends the invite', async () => {
    const { session } = await asSuper(h)
    const res = await create(h, session, valid())
    expect(res.statusCode).toBe(201)
    const body = h.json<Json>(res)
    expect(body.employee).toMatchObject({
      first: 'Kevin',
      last: 'Tran',
      name: 'Kevin T.',
      status: 'invited',
      statusLabel: 'Invite sent',
      employmentType: 'full_time',
      payType: 'hourly',
      phoneE164: '+17865550151',
      email: null,
      hasLogin: false,
      version: 1,
      daysPerWeek: 5,
    })
    expect(body.employee.roles.map((r: Json) => r.key)).toEqual(['crew'])
    expect(body.employee.schedule).toHaveLength(7)
    expect(body.employee.schedule[0]).toMatchObject({ weekday: 0, on: false })
    expect(body.employee.schedule[1]).toMatchObject({
      weekday: 1,
      on: true,
      fromMin: 480,
      toMin: 1080,
      from: '8:00 AM',
      to: '6:00 PM',
    })
    expect(res.headers.etag).toBe('"1"')
    expect(res.headers.location).toBe(`/api/v1/employees/${body.employee.id}`)

    expect(h.notifier.sent).toHaveLength(1)
    const m = h.notifier.last('invite')!
    expect(m).toMatchObject({ firstName: 'Kevin', phone: '+17865550151', employeeId: body.employee.id })
    expect(m.link).toMatch(/\/invite\?token=[A-Za-z0-9_-]{43}$/)
    expect(m.expiresAt.getTime() - h.clock.now().getTime()).toBe(7 * DAY)
    // the in-memory notifier does not deliver, so a Super Admin gets the link to pass on
    expect(body.invite).toMatchObject({ sent: false, channel: 'memory', link: m.link })
    const row = await h.t.db.selectFrom('invites').selectAll().executeTakeFirstOrThrow()
    expect(row.token_hash).not.toContain(h.notifier.lastToken('invite')!)
  })

  it('does not hand the invite link to a caller who is not a Super Admin', async () => {
    const { session } = await asMgmt(h)
    const res = h.json<Json>(await create(h, session, valid()))
    expect(res.invite.link).toBeUndefined()
    expect(h.notifier.sent).toHaveLength(1)
  })

  it('uses first-name plus last-initial display names and rotates avatar colours', async () => {
    const { session } = await asSuper(h)
    const a = h.json<Json>(
      await create(h, session, valid({ first: 'Ana', last: '', phone: '(305) 555-0111' })),
    )
    expect(a.employee.name).toBe('Ana')
    expect(a.employee.avatarColor).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('rejects a duplicate email and an email already used by a login', async () => {
    const { session } = await asSuper(h)
    expect((await create(h, session, valid({ email: 'kevin@example.test' }))).statusCode).toBe(201)
    const dup = await create(
      h,
      session,
      valid({ first: 'Kay', email: 'KEVIN@example.test', phone: '(305) 555-0112' }),
    )
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('EMAIL_TAKEN')
    const login = await create(
      h,
      session,
      valid({ first: 'Amy', email: 'amara@example.test', phone: '(305) 555-0113' }),
    )
    expect(login.statusCode).toBe(409)
  })

  it('checks the schedule against business hours, and warns when none are configured', async () => {
    const { session } = await asSuper(h)
    const day = (weekday: number, on: boolean, fromMin: number, toMin: number) => ({
      weekday,
      on,
      fromMin,
      toMin,
    })
    const bad = await create(
      h,
      session,
      valid({ schedule: [day(0, true, 480, 900), day(6, true, 480, 1080)] }),
    )
    expect(bad.statusCode).toBe(422)
    const body = bad.json()
    expect(body.detail).toBe('Sunday: availability must sit inside business hours (9:00 AM – 3:00 PM).')
    expect(body.errors.map((e: Json) => e.message)).toEqual([
      'Sunday: availability must sit inside business hours (9:00 AM – 3:00 PM).',
      'Saturday: availability must sit inside business hours (8:00 AM – 5:00 PM).',
    ])
    expect(body.errors[0].path).toBe('body.schedule[0]')
    expect(body.errors[1].path).toBe('body.schedule[1]')

    const edge = await create(
      h,
      session,
      valid({ schedule: [day(0, true, 540, 900), day(6, true, 480, 1020)] }),
    )
    expect(edge.statusCode).toBe(201)
    expect(edge.json().warnings).toEqual([])

    h.hours.set(h.identity.locationId, [
      { weekday: 1, open: false, fromMin: 0, toMin: 0 },
      ...[0, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: true, fromMin: 480, toMin: 1080 })),
    ])
    const closed = await create(
      h,
      session,
      valid({ first: 'Cy', phone: '(305) 555-0114', schedule: [day(1, true, 480, 600)] }),
    )
    expect(closed.json().detail).toBe('Monday: availability must sit inside business hours (closed).')

    expect(
      (
        await create(
          h,
          session,
          valid({ first: 'Di', phone: '(305) 555-0115', schedule: [day(2, true, 700, 600)] }),
        )
      ).statusCode,
    ).toBe(422)
  })

  it('saves with a warning instead of failing when business hours are not configured', async () => {
    h.hours.clear()
    const { session } = await asSuper(h)
    const res = await create(
      h,
      session,
      valid({ schedule: [{ weekday: 1, on: true, fromMin: 300, toMin: 1400 }] }),
    )
    expect(res.statusCode).toBe(201)
    expect(res.json().warnings).toHaveLength(1)
    expect(res.json().warnings[0]).toMatch(/Business hours are not configured/)
    const none = await create(h, session, valid({ first: 'Zed', phone: '(305) 555-0130' }))
    expect(none.statusCode).toBe(201)
  })

  it('trims the default week to the business hours instead of failing on it', async () => {
    const { session } = await asSuper(h)
    h.hours.set(h.identity.locationId, [
      { weekday: 0, open: false, fromMin: 0, toMin: 0 },
      { weekday: 1, open: true, fromMin: 540, toMin: 1020 },
      { weekday: 2, open: false, fromMin: 0, toMin: 0 },
      ...[3, 4, 5, 6].map((weekday) => ({ weekday, open: true, fromMin: 420, toMin: 1200 })),
    ])
    const res = h.json<Json>(await create(h, session, valid()))
    const days = res.employee.schedule as Json[]
    expect(days[1]).toMatchObject({ on: true, fromMin: 540, toMin: 1020 })
    expect(days[2]).toMatchObject({ on: false })
    expect(days[3]).toMatchObject({ on: true, fromMin: 480, toMin: 1080 })
    expect(res.warnings).toEqual([])
  })

  it('needs team.roles for roles other than Crew or any exception, but not for the defaults', async () => {
    const { session } = await h.userWithPermissions(['team.edit', 'team.view'])
    expect((await create(h, session, valid())).statusCode).toBe(201)
    expect(
      (await create(h, session, valid({ first: 'B', phone: '(305) 555-0116', roles: ['crew'] }))).statusCode,
    ).toBe(201)
    const roles = await create(h, session, valid({ first: 'C', phone: '(305) 555-0117', roles: ['mgmt'] }))
    expect(roles.statusCode).toBe(403)
    expect(roles.json().meta.required).toEqual(['team.roles'])
    const ov = await create(
      h,
      session,
      valid({ first: 'D', phone: '(305) 555-0118', overrides: { 'cli.export': 'allow' } }),
    )
    expect(ov.statusCode).toBe(403)
    expect(
      await h.t.db.selectFrom('employees').select('first').where('first', 'in', ['C', 'D']).execute(),
    ).toEqual([])
  })
})

describe('reading employees', () => {
  const h = useHarness()

  async function seedTeam() {
    const sup = await asSuper(h)
    const mk = async (body: Json) => h.json<Json>(await create(h, sup.session, body)).employee
    const marco = await mk({
      first: 'Marco',
      last: 'Ruiz',
      phone: '(786) 555-0172',
      title: 'Lead Detailer',
      roles: ['crew'],
      email: 'marco@example.test',
      payType: 'commission',
      rateText: '30',
    })
    const sofia = await mk({
      first: 'Sofia',
      last: 'Duarte',
      phone: '(786) 555-0133',
      title: 'Front Desk',
      roles: ['support', 'crew'],
      overrides: { 'sched.override': 'allow' },
      payType: 'hourly',
      rateText: '21',
    })
    const daniel = await mk({
      first: 'Daniel',
      last: 'Price',
      phone: '(305) 555-0188',
      title: 'Bookkeeper',
      roles: ['acct'],
      employmentType: 'part_time',
    })
    return { sup, marco, sofia, daniel }
  }

  const list = async (s: Session, qs = '') =>
    h.json<{ items: Json[] }>(await h.call('GET', `employees${qs}`, { session: s })).items

  it('searches first, last, phone, title and role names, but not email', async () => {
    const { sup } = await seedTeam()
    const names = async (q: string) =>
      (await list(sup.session, `?q=${encodeURIComponent(q)}`)).map((e) => e.first).sort()
    expect(await names('marco')).toEqual(['Marco'])
    expect(await names('DUARTE')).toEqual(['Sofia'])
    expect(await names('front desk')).toEqual(['Sofia'])
    expect(await names('bookkeeper')).toEqual(['Daniel'])
    expect(await names('555-0188')).toEqual(['Daniel'])
    expect(await names('(786)')).toEqual(['Marco', 'Sofia'])
    expect(await names('7865550133')).toEqual(['Sofia'])
    expect(await names('accounting')).toEqual(['Daniel'])
    expect(await names('customer support')).toEqual(['Sofia'])
    expect(await names('example.test')).toEqual([]) // emails are not searched
    expect(await names('marco@example')).toEqual([])
    expect(await names('zzz')).toEqual([])
  })

  it('filters by role id or key and lists people in creation order with role badges and counts', async () => {
    const { sup } = await seedTeam()
    const all = await list(sup.session)
    expect(all.map((e) => e.first)).toEqual(['Amara', 'Marco', 'Sofia', 'Daniel'])
    const sofia = all.find((e) => e.first === 'Sofia')!
    expect(sofia).toMatchObject({ exceptionCount: 1, daysPerWeek: 5 })
    expect(sofia.roles.map((r: Json) => r.name)).toEqual(['Customer Support', 'Crew'])
    expect((await list(sup.session, '?role=crew')).map((e) => e.first)).toEqual(['Marco', 'Sofia'])
    const crewId = sofia.roles[1].id
    expect((await list(sup.session, `?role=${crewId}`)).map((e) => e.first)).toEqual(['Marco', 'Sofia'])
    expect(await list(sup.session, '?role=ffffffff-ffff-4fff-8fff-ffffffffffff')).toEqual([])
    expect((await list(sup.session, '?role=crew&q=marco')).map((e) => e.first)).toEqual(['Marco'])
  })

  it('redacts pay data without team.edit, and masks phone/email (and hides them from search) without cli.contact', async () => {
    const { sup, marco } = await seedTeam()
    const edit = await list(sup.session)
    expect(edit.find((e) => e.id === marco.id)).toMatchObject({
      payType: 'commission',
      rateText: '30',
      phone: '(786) 555-0172',
      email: 'marco@example.test',
    })

    const { session: viewer } = await h.userWithPermissions(['team.view'])
    const rows = await list(viewer)
    const m = rows.find((e) => e.id === marco.id)!
    expect(m.payType).toBeNull()
    expect(m.rateText).toBeNull()
    expect(m.phone).not.toContain('555')
    expect(m.phone).toMatch(/0172$/)
    expect(m.phoneE164).toBeNull()
    expect(m.email).toBe('m***@example.test')
    expect((await list(viewer, '?q=0172')).map((e) => e.first)).toEqual([]) // phone digits are not searchable for them
    expect((await list(viewer, '?q=marco')).map((e) => e.first)).toEqual(['Marco'])

    const { session: contactViewer } = await h.userWithPermissions(['team.view', 'cli.contact'])
    const c = (await list(contactViewer)).find((e) => e.id === marco.id)!
    expect(c.phone).toBe('(786) 555-0172')
    expect(c.payType).toBeNull()
  })

  it('returns one employee with schedule, exceptions and effective permissions, and an ETag', async () => {
    const { sup, sofia } = await seedTeam()
    const res = await h.call('GET', `employees/${sofia.id}`, { session: sup.session })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('"1"')
    const e = h.json<Json>(res)
    expect(e.overrides).toEqual({ 'sched.override': 'allow' })
    expect(e.schedule).toHaveLength(7)
    const perm = (k: string) => e.effectivePermissions.find((p: Json) => p.key === k)
    expect(e.effectivePermissions).toHaveLength(27)
    expect(perm('pay.refund')).toMatchObject({
      on: true,
      limit: 5000,
      src: 'via Customer Support · ≤ $50',
      ov: null,
    })
    expect(perm('sched.override')).toMatchObject({ on: true, src: 'Exception · allowed', ov: 'allow' })
    expect(perm('set.hours')).toMatchObject({ on: false, src: 'Not included in assigned roles' })
    expect(e.allowedCount).toBe(e.effectivePermissions.filter((p: Json) => p.on).length)
    expect(e.allowedCount).toBe(16) // support 13 + crew jobs.status, jobs.checklist + the sched.override exception

    const eff = h.json<Json>(
      await h.call('GET', `employees/${sofia.id}/effective-permissions`, { session: sup.session }),
    )
    expect(eff).toMatchObject({ allowedCount: 16, total: 27 })
    expect(eff.items).toEqual(e.effectivePermissions)
    expect(
      (await h.call('GET', 'employees/00000000-0000-7000-8000-000000000000', { session: sup.session }))
        .statusCode,
    ).toBe(404)
    expect((await h.call('GET', 'employees/not-a-uuid', { session: sup.session })).statusCode).toBe(422)
  })
})

describe('updating employees', () => {
  const h = useHarness()

  async function setup() {
    const sup = await asSuper(h)
    const emp = h.json<Json>(await create(h, sup.session, valid({ email: 'kevin@example.test' }))).employee
    return { sup, emp }
  }

  const put = (s: Session, id: string, body: Json, version: number | string | null) =>
    h.call('PUT', `employees/${id}`, {
      session: s,
      body,
      headers: version === null ? {} : { 'if-match': typeof version === 'number' ? `"${version}"` : version },
    })

  it('requires If-Match, answers 412 with the current version on a stale one, and bumps the version', async () => {
    const { sup, emp } = await setup()
    const none = await put(sup.session, emp.id, { title: 'Lead' }, null)
    expect(none.statusCode).toBe(428)
    expect(none.json().code).toBe('PRECONDITION_REQUIRED')
    expect((await put(sup.session, emp.id, { title: 'Lead' }, 'abc')).statusCode).toBe(400)

    const ok = await put(sup.session, emp.id, { title: 'Lead Detailer' }, 1)
    expect(ok.statusCode).toBe(200)
    expect(ok.headers.etag).toBe('"2"')
    expect(ok.json().employee).toMatchObject({ title: 'Lead Detailer', version: 2 })

    const stale = await put(sup.session, emp.id, { title: 'Again' }, 1)
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      title: 'Edited elsewhere',
      meta: { currentVersion: 2 },
    })
    expect((await put(sup.session, emp.id, { title: 'Again' }, 'W/"2"')).statusCode).toBe(200)
  })

  it('validates required fields, phone, email uniqueness and keeps untouched fields', async () => {
    const { sup, emp } = await setup()
    const noFirst = await put(sup.session, emp.id, { first: ' ' }, 1)
    expect(noFirst.json().detail).toBe('First name and mobile number are required.')
    expect((await put(sup.session, emp.id, { phone: '' }, 1)).statusCode).toBe(422)
    expect((await put(sup.session, emp.id, { phone: '123' }, 1)).json().detail).toBe(
      'Enter a valid mobile number.',
    )
    expect((await put(sup.session, emp.id, { roles: [] }, 1)).json().detail).toBe('Assign at least one role.')
    expect((await put(sup.session, emp.id, { email: 'amara@example.test' }, 1)).statusCode).toBe(409)

    const ok = h.json<Json>(
      await put(
        sup.session,
        emp.id,
        { phone: '(305) 555-0199', payType: 'salary', rateText: '52000', skills: ['Front desk'], email: '' },
        1,
      ),
    )
    expect(ok.employee).toMatchObject({
      phone: '(305) 555-0199',
      phoneE164: '+13055550199',
      payType: 'salary',
      rateText: '52000',
      skills: ['Front desk'],
      email: null,
      first: 'Kevin',
      version: 2,
    })
  })

  it('replaces the schedule, validated against business hours', async () => {
    const { sup, emp } = await setup()
    const bad = await put(
      sup.session,
      emp.id,
      { schedule: [{ weekday: 1, on: true, fromMin: 420, toMin: 1080 }] },
      1,
    )
    expect(bad.statusCode).toBe(422)
    expect(bad.json().detail).toBe('Monday: availability must sit inside business hours (8:00 AM – 6:00 PM).')
    const ok = h.json<Json>(
      await put(sup.session, emp.id, { schedule: [{ weekday: 0, on: true, fromMin: 540, toMin: 900 }] }, 1),
    )
    expect(ok.employee.daysPerWeek).toBe(1)
    expect(ok.employee.schedule.filter((d: Json) => d.on).map((d: Json) => d.weekday)).toEqual([0])
  })

  it('changing roles or exceptions needs team.roles, an unchanged list does not', async () => {
    const { sup, emp } = await setup()
    const { session: editor } = await h.userWithPermissions(['team.edit', 'team.view'])
    const same = await put(editor, emp.id, { title: 'X', roles: ['crew'], overrides: {} }, 1)
    expect(same.statusCode).toBe(200)
    const change = await put(editor, emp.id, { roles: ['crew', 'support'] }, 2)
    expect(change.statusCode).toBe(403)
    const ov = await put(editor, emp.id, { overrides: { 'cli.export': 'allow' } }, 2)
    expect(ov.statusCode).toBe(403)
    const ok = h.json<Json>(
      await put(sup.session, emp.id, { roles: ['crew', 'support'], overrides: { 'cli.export': 'allow' } }, 2),
    )
    expect(ok.employee.roles.map((r: Json) => r.key)).toEqual(['support', 'crew'])
    expect(ok.employee.exceptionCount).toBe(1)
    expect(ok.employee.overrides).toEqual({ 'cli.export': 'allow' })
  })

  it('a role or exception change takes effect for a signed-in person on their next request', async () => {
    const sup = await asSuper(h)
    const user = await h.createUser({ email: 'kai@example.test', roles: ['crew'] })
    const s = await h.login(user, '10.3.0.1')
    expect((await h.call('GET', 'employees', { session: s })).statusCode).toBe(403)
    await put(sup.session, user.employeeId, { roles: ['crew', 'support'] }, 1)
    expect((await h.call('GET', 'employees', { session: s })).statusCode).toBe(200)
    await put(sup.session, user.employeeId, { overrides: { 'team.view': 'deny' } }, 2)
    expect((await h.call('GET', 'employees', { session: s })).statusCode).toBe(403)
    // each access change tells clients to refresh /me
    const events = await h.t.db
      .selectFrom('realtime_events')
      .select(['channel', 'type', 'payload'])
      .where('type', '=', 'rbac.changed')
      .orderBy('id')
      .execute()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      channel: 'settings',
      payload: { reason: 'employee.access', employeeId: user.employeeId },
    })
  })

  it('announces every change to the team on the settings channel so open screens reload the list', async () => {
    const sup = await asSuper(h)
    const made = (await create(h, sup.session, valid())).json()
    const id = made.employee.id as string
    expect((await put(sup.session, id, { title: 'Lead' }, made.employee.version)).statusCode).toBe(200)
    expect((await h.call('POST', `employees/${id}/deactivate`, { session: sup.session })).statusCode).toBe(
      200,
    )
    expect((await h.call('POST', `employees/${id}/reactivate`, { session: sup.session })).statusCode).toBe(
      200,
    )
    const events = await h.t.db
      .selectFrom('realtime_events')
      .select(['channel', 'type', 'payload'])
      .where('type', '=', 'settings.changed')
      .orderBy('id')
      .execute()
    const team = events.filter((e) => (e.payload as Json).section === 'employees')
    expect(team.map((e) => (e.payload as Json).reason)).toEqual([
      'employee.create',
      'employee.update',
      'employee.deactivate',
      'employee.reactivate',
    ])
    for (const e of team) {
      expect(e.channel).toBe('settings')
      expect((e.payload as Json).employeeId).toBe(id)
    }
  })

  it('syncs the login email when an employee with a login changes it, and refuses to blank it', async () => {
    const sup = await asSuper(h)
    const user = await h.createUser({ email: 'kai@example.test', roles: ['crew'] })
    const ok = await put(sup.session, user.employeeId, { email: 'kai.new@example.test' }, 1)
    expect(ok.statusCode).toBe(200)
    expect(
      (
        await h.t.db
          .selectFrom('users')
          .select('email')
          .where('id', '=', user.userId)
          .executeTakeFirstOrThrow()
      ).email,
    ).toBe('kai.new@example.test')
    expect((await put(sup.session, user.employeeId, { email: '' }, 2)).statusCode).toBe(422)
  })

  it('writes audit rows with before and after', async () => {
    const { sup, emp } = await setup()
    await put(sup.session, emp.id, { title: 'Lead' }, 1)
    const rows = await h.t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_id', '=', emp.id)
      .orderBy('id')
      .execute()
    expect(rows.map((r) => r.action)).toEqual(['employee.create', 'employee.update'])
    expect(rows[1]).toMatchObject({ actor_name: 'Amara O.', actor_user_id: sup.user.userId })
    expect(rows[1]!.before).toMatchObject({ title: 'Detailer' })
    expect(rows[1]!.after).toMatchObject({ title: 'Lead' })
  })
})

describe('invites', () => {
  const h = useHarness()

  async function invited(email: string | undefined = undefined) {
    const sup = await asSuper(h)
    const emp = h.json<Json>(await create(h, sup.session, valid(email ? { email } : {}))).employee
    return { sup, emp, token: h.notifier.lastToken('invite')! }
  }

  const accept = (body: Json) => h.call('POST', 'auth/invite/accept', { body })

  it('accepting requires an email and a strong password, sets the email, activates the employee and signs them in', async () => {
    const { emp, token } = await invited()
    const noEmail = await accept({ token, password: TEST_PASSWORD })
    expect(noEmail.statusCode).toBe(422)
    expect(noEmail.json().errors[0].path).toBe('body.email')
    expect((await accept({ token, email: '', password: TEST_PASSWORD })).statusCode).toBe(422)
    expect((await accept({ token, email: 'not-an-email', password: TEST_PASSWORD })).statusCode).toBe(422)
    const weak = await accept({ token, email: 'kevin@example.test', password: 'short' })
    expect(weak.statusCode).toBe(422)
    expect(weak.json().errors[0].path).toBe('body.password')

    const res = await accept({ token, email: 'Kevin@Example.test', password: TEST_PASSWORD })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      user: { email: 'kevin@example.test', employeeId: emp.id, name: 'Kevin T.' },
    })
    const cookie = res.cookies.find((c) => c.name === 'oasis_sid')!
    const me = await h.call('GET', 'me', { session: { cookie: `oasis_sid=${cookie.value}`, csrf: '' } })
    expect(me.statusCode).toBe(200)
    expect(me.json().roles.map((r: Json) => r.key)).toEqual(['crew'])

    const after = await h.t.db
      .selectFrom('employees')
      .select(['status', 'email', 'version'])
      .where('id', '=', emp.id)
      .executeTakeFirstOrThrow()
    expect(after).toMatchObject({ status: 'active', email: 'kevin@example.test', version: 2 })
    await h.login({ email: 'kevin@example.test', password: TEST_PASSWORD })
  })

  it('a token works once, only before it expires, and an email already in use is refused', async () => {
    const { token } = await invited()
    expect((await accept({ token, email: 'taken@example.test', password: TEST_PASSWORD })).statusCode).toBe(
      200,
    )
    const again = await accept({ token, email: 'other@example.test', password: TEST_PASSWORD })
    expect(again.statusCode).toBe(410)
    expect(again.json().code).toBe('INVITE_INVALID')
    expect(
      (await accept({ token: 'x'.repeat(43), email: 'a@example.test', password: TEST_PASSWORD })).statusCode,
    ).toBe(410)

    const { token: second } = await (async () => {
      const sup = await h.login({ email: 'amara@example.test', password: TEST_PASSWORD }, '10.2.9.9')
      await create(h, sup, valid({ first: 'Lia', phone: '(305) 555-0161' }))
      return { token: h.notifier.lastToken('invite')! }
    })()
    const clash = await accept({ token: second, email: 'amara@example.test', password: TEST_PASSWORD })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().code).toBe('EMAIL_TAKEN')

    h.clock.advance(7 * DAY + 1000)
    const late = await accept({ token: second, email: 'lia@example.test', password: TEST_PASSWORD })
    expect(late.statusCode).toBe(410)
  })

  it('resending revokes the earlier link; it is refused once the invite was accepted', async () => {
    const { sup, emp, token } = await invited()
    const res = await h.call('POST', `employees/${emp.id}/invite/resend`, { session: sup.session })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sent: false, channel: 'memory' })
    const fresh = h.notifier.lastToken('invite')!
    expect(fresh).not.toBe(token)
    expect((await accept({ token, email: 'k@example.test', password: TEST_PASSWORD })).statusCode).toBe(410)
    expect(
      (await accept({ token: fresh, email: 'k@example.test', password: TEST_PASSWORD })).statusCode,
    ).toBe(200)
    const again = await h.call('POST', `employees/${emp.id}/invite/resend`, { session: sup.session })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('INVITE_NOT_PENDING')
  })
})

describe('deactivate and reactivate', () => {
  const h = useHarness()

  it('deactivating revokes sessions and blocks sign-in; reactivating restores active for a person who accepted', async () => {
    const sup = await asSuper(h)
    const user = await h.createUser({ email: 'kai@example.test', roles: ['crew'] })
    const s = await h.login(user, '10.4.0.1')
    const res = await h.call('POST', `employees/${user.employeeId}/deactivate`, { session: sup.session })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'inactive', statusLabel: 'Inactive', version: 2 })
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)
    const blocked = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin },
      payload: { email: user.email, password: user.password },
    })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().code).toBe('ACCOUNT_DISABLED')
    const wrongPw = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin },
      payload: { email: user.email, password: 'wrong password!' },
    })
    expect(wrongPw.statusCode).toBe(401) // a wrong password reveals nothing about the account state

    const again = await h.call('POST', `employees/${user.employeeId}/deactivate`, { session: sup.session })
    expect(again.json().version).toBe(2) // idempotent

    const back = await h.call('POST', `employees/${user.employeeId}/reactivate`, { session: sup.session })
    expect(back.json()).toMatchObject({ status: 'active', hasLogin: true })
    await h.login(user, '10.4.0.2')
  })

  it('reactivating someone who never accepted restores invited, not active', async () => {
    const sup = await asSuper(h)
    const emp = h.json<Json>(await create(h, sup.session, valid())).employee
    await h.call('POST', `employees/${emp.id}/deactivate`, { session: sup.session })
    const token = h.notifier.lastToken('invite')!
    expect(
      (
        await h.call('POST', 'auth/invite/accept', {
          body: { token, email: 'k@example.test', password: TEST_PASSWORD },
        })
      ).statusCode,
    ).toBe(410) // revoked on deactivation
    const back = await h.call('POST', `employees/${emp.id}/reactivate`, { session: sup.session })
    expect(back.json()).toMatchObject({
      status: 'invited',
      statusLabel: 'Invite sent',
      hasLogin: false,
      deactivatedAt: null,
    })
    expect(
      (await h.call('POST', `employees/${emp.id}/invite/resend`, { session: sup.session })).statusCode,
    ).toBe(200)
  })

  it('unknown employees are 404', async () => {
    const sup = await asSuper(h)
    for (const p of ['deactivate', 'reactivate', 'invite/resend', 'password-reset'])
      expect(
        (
          await h.call('POST', `employees/00000000-0000-7000-8000-000000000000/${p}`, {
            session: sup.session,
          })
        ).statusCode,
      ).toBe(404)
  })
})

describe('admin-triggered password reset', () => {
  const h = useHarness()

  it('sends the person a link; only a Super Admin sees it, and only when nothing delivered it', async () => {
    const sup = await asSuper(h)
    const mgmt = await asMgmt(h)
    const user = await h.createUser({ email: 'kai@example.test', roles: ['crew'], phone: '(305) 555-0177' })
    const bySuper = await h.call('POST', `employees/${user.employeeId}/password-reset`, {
      session: sup.session,
    })
    expect(bySuper.statusCode).toBe(200)
    const m = h.notifier.last('password_reset')!
    expect(m).toMatchObject({ employeeId: user.employeeId, phone: '+13055550177', email: user.email })
    expect(bySuper.json()).toMatchObject({ sent: false, channel: 'memory', link: m.link })
    expect(m.expiresAt.getTime() - h.clock.now().getTime()).toBe(DAY)

    const byMgmt = await h.call('POST', `employees/${user.employeeId}/password-reset`, {
      session: mgmt.session,
    })
    expect(byMgmt.statusCode).toBe(200)
    expect(byMgmt.json().link).toBeUndefined() // a manager cannot read a link that would let them become that person
    expect(h.notifier.sent).toHaveLength(2)

    const token = h.notifier.lastToken('password_reset')!
    expect(
      (await h.call('POST', 'auth/password/reset', { body: { token, password: 'a fresh long passphrase' } }))
        .statusCode,
    ).toBe(200)
    await h.login({ email: user.email, password: 'a fresh long passphrase' })
  })

  it('refuses someone who has no login yet', async () => {
    const sup = await asSuper(h)
    const emp = h.json<Json>(await create(h, sup.session, valid())).employee
    const res = await h.call('POST', `employees/${emp.id}/password-reset`, { session: sup.session })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NO_LOGIN_YET')
  })
})

describe('last Super Admin and escalation guards', () => {
  const h = useHarness()

  const put = (s: Session, id: string, body: Json, version: number) =>
    h.call('PUT', `employees/${id}`, { session: s, body, headers: { 'if-match': `"${version}"` } })

  it('the last active Super Admin cannot be deactivated or demoted, but any of two can', async () => {
    const a = await asSuper(h, 'a@example.test')
    const deact = await h.call('POST', `employees/${a.user.employeeId}/deactivate`, { session: a.session })
    expect(deact.statusCode).toBe(409)
    expect(deact.json().code).toBe('LAST_SUPER_ADMIN')
    const demote = await put(a.session, a.user.employeeId, { roles: ['mgmt'] }, 1)
    expect(demote.statusCode).toBe(409)
    expect(demote.json().code).toBe('LAST_SUPER_ADMIN')
    const unchanged = await h.call('GET', `employees/${a.user.employeeId}`, { session: a.session })
    expect(unchanged.json()).toMatchObject({ status: 'active', version: 1 })
    expect(unchanged.json().roles.map((r: Json) => r.key)).toEqual(['super'])

    const b = await asSuper(h, 'b@example.test')
    expect((await put(a.session, b.user.employeeId, { roles: ['mgmt'] }, 1)).statusCode).toBe(200)
    // a is the only Super again
    expect(
      (await h.call('POST', `employees/${a.user.employeeId}/deactivate`, { session: a.session })).statusCode,
    ).toBe(409)
  })

  it('an invited or inactive Super does not count', async () => {
    const a = await asSuper(h, 'a@example.test')
    const inv = h.json<Json>(await create(h, a.session, valid({ roles: ['super'] }))).employee
    expect(inv.status).toBe('invited')
    expect(
      (await h.call('POST', `employees/${a.user.employeeId}/deactivate`, { session: a.session })).statusCode,
    ).toBe(409)
  })

  it('serialises concurrent demotions so one Super always remains', async () => {
    const a = await asSuper(h, 'a@example.test')
    const b = await asSuper(h, 'b@example.test')
    const sa = a.session
    const sb = await h.login(b.user, '10.5.5.5')
    const results = await Promise.all([
      h.call('POST', `employees/${b.user.employeeId}/deactivate`, { session: sa }),
      h.call('POST', `employees/${a.user.employeeId}/deactivate`, { session: sb }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const live = await h.t.db.selectFrom('employees').select('id').where('status', '=', 'active').execute()
    expect(live).toHaveLength(1)
  })

  it('Management cannot assign Super, assign a role carrying set.billing or pay.void, or touch a Super Admin', async () => {
    const sup = await asSuper(h)
    const mgmt = await asMgmt(h)
    const emp = h.json<Json>(await create(h, mgmt.session, valid())).employee
    for (const roles of [['super'], ['acct'], ['crew', 'acct']]) {
      const res = await put(mgmt.session, emp.id, { roles }, 1)
      expect(res.statusCode).toBe(403)
      expect(res.json().code).toBe('SUPER_ONLY')
    }
    expect(
      (await create(h, mgmt.session, valid({ first: 'N', phone: '(305) 555-0120', roles: ['super'] })))
        .statusCode,
    ).toBe(403)
    expect(
      (await create(h, mgmt.session, valid({ first: 'N', phone: '(305) 555-0120', roles: ['acct'] })))
        .statusCode,
    ).toBe(403)
    // ordinary roles are fine
    expect((await put(mgmt.session, emp.id, { roles: ['support'] }, 1)).statusCode).toBe(200)
    // a per-person Allow of a Super-only permission is a grant too
    expect((await put(mgmt.session, emp.id, { overrides: { 'set.billing': 'allow' } }, 2)).json().code).toBe(
      'SUPER_ONLY',
    )
    expect((await put(mgmt.session, emp.id, { overrides: { 'pay.void': 'allow' } }, 2)).json().code).toBe(
      'SUPER_ONLY',
    )
    expect((await put(mgmt.session, emp.id, { overrides: { 'pay.void': 'deny' } }, 2)).statusCode).toBe(200)

    // the Super Admin's own access is off limits for Management (roles, exceptions, deactivation, reactivation)
    const super1 = await h.t.db
      .selectFrom('employees')
      .select(['id', 'version'])
      .where('email', '=', 'amara@example.test')
      .executeTakeFirstOrThrow()
    expect(
      (await put(mgmt.session, super1.id, { overrides: { 'cli.export': 'deny' } }, super1.version)).json()
        .code,
    ).toBe('SUPER_ONLY')
    expect(
      (await put(mgmt.session, super1.id, { roles: ['super', 'crew'] }, super1.version)).json().code,
    ).toBe('SUPER_ONLY')
    expect((await put(mgmt.session, super1.id, { title: 'Boss' }, super1.version)).statusCode).toBe(200) // profile edits are team.edit business
    expect(
      (await h.call('POST', `employees/${super1.id}/deactivate`, { session: mgmt.session })).json().code,
    ).toBe('SUPER_ONLY')

    // a Super Admin may do all of it
    expect((await put(sup.session, emp.id, { roles: ['acct', 'crew'] }, 3)).statusCode).toBe(200)
  })

  it('nobody can deny themselves team.roles', async () => {
    const mgmt = await asMgmt(h)
    const me = await h.call('GET', `employees/${mgmt.user.employeeId}`, { session: mgmt.session })
    const res = await put(
      mgmt.session,
      mgmt.user.employeeId,
      { overrides: { 'team.roles': 'deny' } },
      me.json().version,
    )
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('SELF_DENY_ROLES')
    const sup = await asSuper(h)
    const sres = await put(sup.session, sup.user.employeeId, { overrides: { 'team.roles': 'deny' } }, 1)
    expect(sres.json().code).toBe('SELF_DENY_ROLES')
    // another person's deny is allowed
    const other = await h.createUser({ email: 'o@example.test', roles: ['mgmt'] })
    expect(
      (await put(sup.session, other.employeeId, { overrides: { 'team.roles': 'deny' } }, 1)).statusCode,
    ).toBe(200)
  })
})
