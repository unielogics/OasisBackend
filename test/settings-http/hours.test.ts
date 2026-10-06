import { describe, expect, it } from 'vitest'
import { edt, makeAppointment, makeCustomer, makeService } from '../domain-schema/helpers.js'
import { auditActions, events, json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

const week = (over: Record<number, Record<string, unknown>> = {}) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    open: true,
    from: weekday === 0 ? '9:00 AM' : '8:00 AM',
    to: weekday === 0 ? '3:00 PM' : weekday === 6 ? '5:00 PM' : '6:00 PM',
    ...over[weekday],
  }))

async function version(s: Awaited<ReturnType<typeof h.admin>>): Promise<number> {
  return json(await h.get('settings/hours', s)).version as number
}

describe('GET /settings/hours', () => {
  it('returns the design week, rules, week total, federal toggle and an ETag', async () => {
    const s = await h.admin()
    const r = await h.get('settings/hours', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.days).toHaveLength(7)
    expect(b.days[0]).toMatchObject({
      weekday: 0,
      day: 'Sunday',
      open: true,
      from: '9:00 AM',
      to: '3:00 PM',
      len: '6 hrs',
    })
    expect(b.days[1]).toMatchObject({
      weekday: 1,
      from: '8:00 AM',
      to: '6:00 PM',
      len: '10 hrs',
      fromMin: 480,
      toMin: 1080,
    })
    expect(b.days[6]).toMatchObject({ weekday: 6, to: '5:00 PM', len: '9 hrs' })
    expect(b.weekHours).toBe('65 hrs')
    expect(b.weekMinutes).toBe(3900)
    expect(b.rules).toMatchObject({ slot: 30, buffer: 10, cutoff: 60 })
    expect(b.federalAuto).toBe(true)
    expect(r.headers.etag).toBe(`"${b.version}"`)
  })

  it('is readable by any signed-in user and refuses anonymous callers', async () => {
    const crew = await h.withPermissions([])
    expect((await h.get('settings/hours', crew)).statusCode).toBe(200)
    expect((await h.call('GET', 'settings/hours')).statusCode).toBe(401)
  })
})

describe('PUT /settings/hours', () => {
  it('saves with the version, accepts "8:00 AM" strings, publishes settings.changed and audits', async () => {
    const s = await h.admin()
    const v = await version(s)
    const r = await h.put('settings/hours', s, {
      version: v,
      days: week({ 6: { to: '4:30 PM' }, 0: { open: false } }),
    })
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.changed).toBe(true)
    expect(b.version).toBe(v + 1)
    expect(b.days[6]).toMatchObject({ to: '4:30 PM', len: '8.5 hrs' })
    expect(b.days[0]).toMatchObject({ open: false, from: '9:00 AM', to: '3:00 PM', len: '0 hrs' })
    expect(b.weekHours).toBe('58.5 hrs')
    expect(r.headers.etag).toBe(`"${v + 1}"`)
    expect(b.warnings).toEqual({ employeeScheduleConflicts: [], appointmentsOutsideHours: [] })

    expect((await events(h.db, 'settings')).filter((e) => e.payload.section === 'hours')).toHaveLength(1)
    expect(await auditActions(h.db)).toContain('settings.hours.update')
    const audit = await h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'settings.hours.update')
      .executeTakeFirstOrThrow()
    expect(audit.actor_name).toBe('Amara O.')
  })

  it('accepts what GET returned, read-only fields included, so a loaded screen can be saved as it is', async () => {
    const s = await h.admin()
    const loaded = json(await h.get('settings/hours', s))
    loaded.days[1].to = '5:00 PM'
    // one edit in two forms that disagree would silently lose one of them: refused
    const clash = await h.put('settings/hours', s, loaded)
    expect(clash.statusCode).toBe(422)
    expect(json(clash)).toMatchObject({
      detail: 'Monday: to and toMin disagree. Send only one of them.',
      errors: [{ path: 'days.1.to' }],
    })
    loaded.days[1].toMin = 1020
    const r = await h.put('settings/hours', s, loaded)
    expect(r.statusCode).toBe(200)
    expect(json(r).days[1]).toMatchObject({ to: '5:00 PM', len: '9 hrs' })
  })

  it('takes minutes as well as strings, keeps stored times for a closed day sent without them, and reports no change twice', async () => {
    const s = await h.admin()
    const v = await version(s)
    const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
      weekday === 3
        ? { weekday, open: false }
        : {
            weekday,
            open: true,
            fromMin: weekday === 0 ? 540 : 480,
            toMin: weekday === 0 ? 900 : weekday === 6 ? 1020 : 1080,
          },
    )
    const r = json(await h.put('settings/hours', s, { version: v, days }))
    expect(r.days[3]).toMatchObject({ open: false, from: '8:00 AM', to: '6:00 PM' })
    const again = json(await h.put('settings/hours', s, { version: r.version, days }))
    expect(again).toMatchObject({ changed: false, version: r.version })
  })

  it('requires the version (428), refuses a stale one (412 with the current version) and honours If-Match', async () => {
    const s = await h.admin()
    const v = await version(s)
    const none = await h.put('settings/hours', s, { days: week() })
    expect(none.statusCode).toBe(428)
    expect(json(none).code).toBe('PRECONDITION_REQUIRED')

    const stale = await h.put('settings/hours', s, { version: v + 5, days: week() })
    expect(stale.statusCode).toBe(412)
    expect(json(stale)).toMatchObject({ code: 'VERSION_CONFLICT', meta: { currentVersion: v } })

    const viaHeader = await h.put(
      'settings/hours',
      s,
      { days: week({ 1: { to: '5:00 PM' } }) },
      { 'if-match': `"${v}"` },
    )
    expect(viaHeader.statusCode).toBe(200)
    const reuse = await h.put('settings/hours', s, { days: week() }, { 'if-match': `"${v}"` })
    expect(reuse.statusCode).toBe(412)
  })

  it('validates the week with readable messages', async () => {
    const s = await h.admin()
    const v = await version(s)
    const put = async (days: unknown[]) => h.put('settings/hours', s, { version: v, days })

    const six = await put(week().slice(0, 6))
    expect(six.statusCode).toBe(422)
    expect(json(six).detail).toBe('Send all seven days, Sunday to Saturday.')

    const reversed = json(await put(week({ 2: { from: '6:00 PM', to: '8:00 AM' } })))
    expect(reversed.detail).toBe('Tuesday: closing time must be after opening time.')

    const grid = json(await put(week({ 2: { from: '8:10 AM' } })))
    expect(grid.detail).toBe('Tuesday: use 30-minute steps.')

    const early = json(await put(week({ 2: { from: '4:00 AM' } })))
    expect(early.detail).toBe('Tuesday: hours must be between 5:00 AM and 11:30 PM.')

    const garbled = await put(week({ 2: { from: 'early' } }))
    expect(garbled.statusCode).toBe(422)
    expect(json(garbled)).toMatchObject({
      detail: 'Tuesday: use a time like 8:00 AM.',
      errors: [{ path: 'days.2.from' }],
    })

    const twice = json(await put(week().map((d) => (d.weekday === 5 ? { ...d, weekday: 4 } : d))))
    expect(twice.errors.map((e: { message: string }) => e.message)).toContain('Thursday appears twice.')
    expect(await auditActions(h.db)).not.toContain('settings.hours.update')
  })

  it('is refused without set.hours', async () => {
    const mgr = await h.withPermissions(['set.emergency', 'set.services', 'cli.member'])
    const v = 1
    const r = await h.put('settings/hours', mgr, { version: v, days: week() })
    expect(r.statusCode).toBe(403)
    expect(json(r)).toMatchObject({ code: 'FORBIDDEN', meta: { required: ['set.hours'] } })
  })

  it('warns about employee schedules and appointments that no longer fit, and moves nothing', async () => {
    const s = await h.admin()
    const created = await h.post('employees', s, {
      first: 'Marco',
      last: 'Ruiz',
      phone: '(786) 555-0172',
      email: 'marco@example.test',
      schedule: [
        { weekday: 1, on: true, fromMin: 480, toMin: 1080 },
        { weekday: 6, on: true, fromMin: 480, toMin: 1020 },
        { weekday: 0, on: false, fromMin: 540, toMin: 900 },
      ],
    })
    expect(created.statusCode).toBe(201)
    const customer = await makeCustomer(h.db, h.fx)
    const service = await makeService(h.db, h.fx)
    const sunday = await makeAppointment(h.db, h.fx, {
      customerId: customer,
      serviceId: service,
      start: edt('2026-06-14', '10:00'),
    })
    const sat = await makeAppointment(h.db, h.fx, {
      customerId: customer,
      serviceId: service,
      start: edt('2026-06-13', '16:30'),
    })

    const v = await version(s)
    const r = await h.put('settings/hours', s, {
      version: v,
      days: week({ 0: { open: false }, 6: { to: '4:00 PM' } }),
    })
    expect(r.statusCode).toBe(200)
    const w = json(r).warnings
    expect(w.employeeScheduleConflicts).toEqual([
      expect.objectContaining({
        employeeName: 'Marco Ruiz',
        weekday: 6,
        day: 'Saturday',
        message: 'Saturday: availability must sit inside business hours (8:00 AM – 4:00 PM).',
      }),
    ])
    expect(w.appointmentsOutsideHours.map((a: { appointmentId: string }) => a.appointmentId).sort()).toEqual(
      [sunday, sat].sort(),
    )
    expect(
      w.appointmentsOutsideHours.find((a: { appointmentId: string }) => a.appointmentId === sunday),
    ).toMatchObject({
      date: '2026-06-14',
      time: '10:00 AM',
      weekday: 0,
    })
    const rows = await h.db.selectFrom('appointments').select(['id', 'scheduled_start', 'status']).execute()
    expect(rows.every((a) => a.status === 'booked')).toBe(true)
    const sched = await h.db
      .selectFrom('employee_schedules')
      .select(['weekday', 'to_min'])
      .where('employee_id', '=', json(created).employee.id)
      .where('weekday', '=', 6)
      .execute()
    expect(sched[0]!.to_min).toBe(1020)
  })
})

describe('employee schedules are validated against the stored hours (DB BusinessHoursPort)', () => {
  it('rejects a schedule outside the hours the manager saved', async () => {
    const s = await h.admin()
    const v = await version(s)
    await h.put('settings/hours', s, { version: v, days: week({ 0: { open: false } }) })
    const r = await h.post('employees', s, {
      first: 'Lena',
      last: 'Kim',
      phone: '(305) 555-0119',
      schedule: [{ weekday: 0, on: true, fromMin: 540, toMin: 900 }],
    })
    expect(r.statusCode).toBe(422)
    expect(json(r).detail).toBe('Sunday: availability must sit inside business hours (closed).')
    const ok = await h.post('employees', s, {
      first: 'Lena',
      last: 'Kim',
      phone: '(305) 555-0119',
      schedule: [{ weekday: 1, on: true, fromMin: 480, toMin: 1080 }],
    })
    expect(ok.statusCode).toBe(201)
  })
})

describe('booking rules save immediately (not part of the dirty-tracked hours save)', () => {
  it('GET /settings/rules returns the rules and federalAuto', async () => {
    const s = await h.admin()
    const r = json(await h.get('settings/rules', s))
    expect(r).toMatchObject({ rules: { slot: 30, buffer: 10, cutoff: 60 }, federalAuto: true })
    expect(typeof r.version).toBe('number')
  })

  it('PUT /settings/rules saves one chip, bumps the shared version and publishes settings.changed', async () => {
    const s = await h.admin()
    const v = await version(s)
    const r = await h.put('settings/rules', s, { slot: 60 })
    expect(r.statusCode).toBe(200)
    expect(json(r)).toMatchObject({
      rules: { slot: 60, buffer: 10, cutoff: 60 },
      changed: true,
      version: v + 1,
    })
    expect(r.headers.etag).toBe(`"${v + 1}"`)
    expect(json(await h.get('settings/hours', s)).rules.slot).toBe(60)
    const again = json(await h.put('settings/rules', s, { slot: 60 }))
    expect(again).toMatchObject({ changed: false, version: v + 1 })
    expect((await events(h.db, 'settings')).filter((e) => e.payload.section === 'hours')).toHaveLength(1)

    // the hours editor that loaded before the chip click holds a stale token
    const stale = await h.put('settings/hours', s, { version: v, days: week() })
    expect(stale.statusCode).toBe(412)
  })

  it('validates each chip with the design values and honours a supplied version', async () => {
    const s = await h.admin()
    const v = await version(s)
    expect(json(await h.put('settings/rules', s, { slot: 20 })).detail).toBe(
      'Slot length must be 15, 30 or 60 minutes.',
    )
    expect(json(await h.put('settings/rules', s, { buffer: 5 })).detail).toBe(
      'Buffer must be 0, 10, 15 or 20 minutes.',
    )
    expect(json(await h.put('settings/rules', s, { cutoff: 45 })).detail).toBe(
      'Last booking before close must be 30, 60 or 90 minutes.',
    )
    expect((await h.put('settings/rules', s, { cutoff: 90, version: v + 3 })).statusCode).toBe(412)
    expect(json(await h.put('settings/rules', s, { cutoff: 90, version: v })).rules.cutoff).toBe(90)
    expect((await h.put('settings/rules', s, { colour: 'red' })).statusCode).toBe(422)
  })

  it('needs set.hours', async () => {
    const s = await h.withPermissions(['set.emergency'])
    expect((await h.put('settings/rules', s, { slot: 15 })).statusCode).toBe(403)
  })
})
