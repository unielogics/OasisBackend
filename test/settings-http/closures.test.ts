import { describe, expect, it } from 'vitest'
import { edt, makeAppointment, makeCustomer, makeService } from '../domain-schema/helpers.js'
import { auditActions, events, json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

async function book(
  date: string,
  hhmm: string,
  status: 'booked' | 'canceled' | 'completed' = 'booked',
  customerOpts = {},
) {
  const customer = await makeCustomer(h.db, h.fx, customerOpts)
  const service = await makeService(h.db, h.fx)
  return makeAppointment(h.db, h.fx, {
    customerId: customer,
    serviceId: service,
    start: edt(date, hhmm),
    status,
  })
}

const activityCount = async (): Promise<number> =>
  Number(
    (
      await h.db
        .selectFrom('activity_log')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  )

describe('GET /closures', () => {
  it('lists upcoming ascending and past newest first, with real counts and the design labels', async () => {
    const s = await h.admin()
    await h.post('closures', s, { date: '2026-05-25', name: 'Memorial Day', type: 'closed' })
    await h.post('closures', s, { date: '2026-12-25', name: 'Christmas Day', type: 'closed' })
    await h.post('closures', s, {
      date: '2026-09-07',
      name: 'Labor Day',
      type: 'reduced',
      from: '10:00 AM',
      to: '2:00 PM',
    })
    await book('2026-12-25', '10:00')
    await book('2026-12-25', '11:00')
    await book('2026-12-25', '12:00', 'canceled')
    await book('2026-09-07', '09:00')
    await book('2026-09-07', '11:00')
    await book('2026-09-07', '15:00')

    const r = await h.get('closures', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.federalAuto).toBe(true)
    expect(b.upcoming.map((c: { name: string }) => c.name)).toEqual(['Labor Day', 'Christmas Day'])
    expect(b.past.map((c: { name: string }) => c.name)).toEqual(['Memorial Day'])

    const [labor, xmas] = b.upcoming
    expect(labor).toMatchObject({
      mon: 'SEP',
      day: '7',
      dow: 'MON',
      type: 'reduced',
      from: '10:00 AM',
      to: '2:00 PM',
      typeLabel: 'Reduced · 10:00 AM – 2:00 PM',
      affectedCount: 2,
      subLine: 'Slots outside reduced hours hidden · 2 bookings affected',
      past: false,
      emergency: false,
    })
    expect(xmas).toMatchObject({
      mon: 'DEC',
      day: '25',
      dow: 'FRI',
      typeLabel: 'Closed all day',
      from: null,
      affectedCount: 2,
      subLine: 'Online booking blocked · 2 existing bookings to move',
    })
    expect(b.past[0]).toMatchObject({ past: true, affectedCount: null, subLine: null })
  })

  it('filters by date range and rejects a malformed one', async () => {
    const s = await h.admin()
    await h.post('closures', s, { date: '2026-07-04', name: 'Independence Day' })
    await h.post('closures', s, { date: '2026-11-26', name: 'Thanksgiving' })
    const r = json(await h.get('closures?from=2026-11-01&to=2026-11-30', s))
    expect(r.upcoming.map((c: { name: string }) => c.name)).toEqual(['Thanksgiving'])
    expect((await h.get('closures?from=June', s)).statusCode).toBe(422)
  })

  it('is open to any signed-in user', async () => {
    const crew = await h.withPermissions([])
    expect((await h.get('closures', crew)).statusCode).toBe(200)
  })
})

describe('POST /closures/preview', () => {
  it('counts booked customers that day, and for reduced hours only those outside the window', async () => {
    const s = await h.admin()
    await book('2026-06-20', '09:00')
    await book('2026-06-20', '11:00')
    await book('2026-06-20', '15:00')
    await book('2026-06-20', '16:00', 'canceled')
    expect(json(await h.post('closures/preview', s, { date: '2026-06-20', type: 'closed' }))).toEqual({
      affected: 3,
    })
    expect(
      json(
        await h.post('closures/preview', s, {
          date: '2026-06-20',
          type: 'reduced',
          from: '10:00 AM',
          to: '2:00 PM',
        }),
      ),
    ).toEqual({ affected: 2 })
    expect(json(await h.post('closures/preview', s, { date: '2026-06-21', type: 'closed' }))).toEqual({
      affected: 0,
    })
  })

  it('answers the design string for a missing date and validates reduced hours', async () => {
    const s = await h.admin()
    const r = await h.post('closures/preview', s, { type: 'closed' })
    expect(r.statusCode).toBe(422)
    expect(json(r)).toMatchObject({ detail: 'Add a date and a name.' })
    expect(json(await h.post('closures/preview', s, { date: '2026-06-20', type: 'reduced' })).detail).toBe(
      'Set the opening and closing time for reduced hours.',
    )
    expect(
      json(
        await h.post('closures/preview', s, {
          date: '2026-06-20',
          type: 'reduced',
          from: '2:00 PM',
          to: '10:00 AM',
        }),
      ).detail,
    ).toBe('Closing time must be after opening time.')
  })

  it('needs set.hours', async () => {
    const s = await h.withPermissions(['set.emergency'])
    expect((await h.post('closures/preview', s, { date: '2026-06-20', type: 'closed' })).statusCode).toBe(403)
  })
})

describe('POST /closures', () => {
  it('adds a closure, queues notices for reachable booked customers, audits and publishes', async () => {
    const s = await h.admin()
    await book('2026-06-20', '09:00')
    await book('2026-06-20', '10:00', 'booked', { optedOut: true, email: null })
    await book('2026-06-20', '11:00', 'booked', { optedOut: true, email: 'opted.out@example.test' })
    await book('2026-06-20', '12:00', 'completed')

    const r = await h.post('closures', s, {
      date: '2026-06-20',
      name: '  Staff training day  ',
      type: 'closed',
    })
    expect(r.statusCode).toBe(201)
    const b = json(r)
    expect(b.closure).toMatchObject({
      date: '2026-06-20',
      name: 'Staff training day',
      type: 'closed',
      notify: true,
      source: 'manual',
      typeLabel: 'Closed all day',
      affectedCount: 4,
    })
    expect(b.affectedCount).toBe(4)
    expect(b.notified).toBe(2)

    const lines = await h.db
      .selectFrom('activity_log')
      .select(['text', 'channels', 'actor_type'])
      .orderBy('id')
      .execute()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ actor_type: 'system' })
    expect(lines.map((l) => l.text).join('|')).toContain(
      'Closure notice queued by SMS: Staff training day, Jun 20, 2026',
    )
    expect(lines.map((l) => l.text).join('|')).toContain('queued by email')

    expect(await auditActions(h.db)).toEqual(
      expect.arrayContaining(['settings.closure.create', 'closure.notify.queued']),
    )
    expect((await events(h.db, 'settings')).some((e) => e.payload.section === 'closures')).toBe(true)
    const row = await h.db.selectFrom('closures').selectAll().executeTakeFirstOrThrow()
    expect(row.created_by).not.toBeNull()
  })

  it('does not message anyone when notify is off', async () => {
    const s = await h.admin()
    await book('2026-06-20', '09:00')
    const r = json(await h.post('closures', s, { date: '2026-06-20', name: 'Quiet day', notify: false }))
    expect(r).toMatchObject({ notified: 0, affectedCount: 1, closure: { notify: false } })
    expect(await activityCount()).toBe(0)
  })

  it('creates reduced hours', async () => {
    const s = await h.admin()
    const r = json(
      await h.post('closures', s, {
        date: '2026-12-24',
        name: 'Christmas Eve',
        type: 'reduced',
        from: '8:00 AM',
        to: '1:00 PM',
      }),
    )
    expect(r.closure).toMatchObject({
      type: 'reduced',
      fromMin: 480,
      toMin: 780,
      typeLabel: 'Reduced · 8:00 AM – 1:00 PM',
    })
  })

  it('refuses with the design strings and the 422 shape', async () => {
    const s = await h.admin()
    for (const body of [
      {},
      { date: '2026-06-20' },
      { name: 'Training' },
      { date: '2026-06-20', name: '   ' },
      { date: '', name: 'x' },
    ]) {
      const r = await h.post('closures', s, body)
      expect(r.statusCode, JSON.stringify(body)).toBe(422)
      expect(r.headers['content-type']).toContain('application/problem+json')
      expect(json(r)).toMatchObject({
        type: 'urn:oasis:problem:closure-incomplete',
        title: 'Check the form',
        status: 422,
        code: 'CLOSURE_INCOMPLETE',
        detail: 'Add a date and a name.',
      })
    }
    expect((await h.post('closures', s, { date: '2026-02-30', name: 'x' })).json().detail).toBe(
      'Add a date and a name.',
    )

    await h.post('closures', s, { date: '2026-06-20', name: 'First' })
    const dup = await h.post('closures', s, { date: '2026-06-20', name: 'Second' })
    expect(dup.statusCode).toBe(422)
    expect(json(dup)).toMatchObject({
      code: 'CLOSURE_DATE_TAKEN',
      title: 'Check the form',
      detail: "There's already a closure on that date.",
    })
    const long = await h.post('closures', s, { date: '2026-06-22', name: 'x'.repeat(81) })
    expect(json(long).detail).toBe('Keep the name under 80 characters.')
    expect(await h.db.selectFrom('closures').select('id').execute()).toHaveLength(1)
  })

  it('replays an Idempotency-Key without adding a second closure', async () => {
    const s = await h.admin()
    const key = { 'idempotency-key': 'closure-key-0001' }
    const a = await h.post('closures', s, { date: '2026-06-20', name: 'Training' }, key)
    const b = await h.post('closures', s, { date: '2026-06-20', name: 'Training' }, key)
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    expect(json(b).closure.id).toBe(json(a).closure.id)
    expect(await h.db.selectFrom('closures').select('id').execute()).toHaveLength(1)
    const other = await h.post('closures', s, { date: '2026-06-21', name: 'Different' }, key)
    expect(other.statusCode).toBe(422)
    expect(json(other).code).toBe('IDEMPOTENCY_MISMATCH')
  })

  it('needs set.hours', async () => {
    const s = await h.withPermissions(['set.emergency', 'cli.member'])
    expect((await h.post('closures', s, { date: '2026-06-20', name: 'x' })).statusCode).toBe(403)
  })
})

describe('PATCH /closures/:id', () => {
  const create = async (s: Awaited<ReturnType<typeof h.admin>>, body: Record<string, unknown>) =>
    json(await h.post('closures', s, body)).closure.id as string

  it('toggling notify stores the flag and sends nothing', async () => {
    const s = await h.admin()
    await book('2026-09-07', '11:00')
    const id = await create(s, { date: '2026-09-07', name: 'Labor Day', notify: false })
    const before = await activityCount()
    const r = await h.patch(`closures/${id}`, s, { notify: true })
    expect(r.statusCode).toBe(200)
    expect(json(r)).toMatchObject({ id, notify: true, affectedCount: 1 })
    expect(await activityCount()).toBe(before)
    expect(await auditActions(h.db)).toContain('settings.closure.update')
  })

  it('turns a closed day into reduced hours (how Labor Day became reduced) and back', async () => {
    const s = await h.admin()
    await book('2026-09-07', '09:00')
    await book('2026-09-07', '11:00')
    const id = await create(s, { date: '2026-09-07', name: 'Labor Day' })
    const reduced = json(
      await h.patch(`closures/${id}`, s, { type: 'reduced', from: '10:00 AM', to: '2:00 PM' }),
    )
    expect(reduced).toMatchObject({
      type: 'reduced',
      typeLabel: 'Reduced · 10:00 AM – 2:00 PM',
      affectedCount: 1,
      subLine: 'Slots outside reduced hours hidden · 1 booking affected',
    })
    const closed = json(await h.patch(`closures/${id}`, s, { type: 'closed' }))
    expect(closed).toMatchObject({ type: 'closed', from: null, to: null, affectedCount: 2 })
    const renamed = json(await h.patch(`closures/${id}`, s, { name: 'Labor Day (observed)' }))
    expect(renamed.name).toBe('Labor Day (observed)')
  })

  it('refuses a time sent in two forms that disagree, and accepts them when they agree', async () => {
    const s = await h.admin()
    const id = await create(s, {
      date: '2026-09-07',
      name: 'Labor Day',
      type: 'reduced',
      from: '10:00 AM',
      to: '2:00 PM',
    })
    const clash = await h.patch(`closures/${id}`, s, { to: '3:00 PM', toMin: 840 })
    expect(clash.statusCode).toBe(422)
    expect(json(clash).detail).toBe('to and toMin disagree. Send only one of them.')
    const same = await h.patch(`closures/${id}`, s, { to: '3:00 PM', toMin: 900 })
    expect(json(same)).toMatchObject({ to: '3:00 PM', toMin: 900 })
    expect(json(await h.patch(`closures/${id}`, s, { from: 'soon' })).detail).toBe(
      'Use a time like 10:00 AM.',
    )
  })

  it('validates, and answers 404 for an unknown or removed closure', async () => {
    const s = await h.admin()
    const id = await create(s, { date: '2026-09-07', name: 'Labor Day' })
    expect(json(await h.patch(`closures/${id}`, s, { name: '  ' })).detail).toBe('Add a date and a name.')
    expect(json(await h.patch(`closures/${id}`, s, { type: 'reduced' })).detail).toBe(
      'Set the opening and closing time for reduced hours.',
    )
    expect(
      (await h.patch('closures/00000000-0000-7000-8000-000000000001', s, { notify: true })).statusCode,
    ).toBe(404)
    await h.del(`closures/${id}`, s)
    expect((await h.patch(`closures/${id}`, s, { notify: true })).statusCode).toBe(404)
  })
})

describe('DELETE /closures/:id', () => {
  it('soft-deletes, sends nothing, and frees the date', async () => {
    const s = await h.admin()
    await book('2026-06-20', '09:00')
    const id = json(await h.post('closures', s, { date: '2026-06-20', name: 'Training', notify: false }))
      .closure.id as string
    const r = await h.del(`closures/${id}`, s)
    expect(r.statusCode).toBe(200)
    expect(json(r)).toEqual({ id, name: 'Training', date: '2026-06-20', removed: true })
    const row = await h.db
      .selectFrom('closures')
      .select(['deleted_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row.deleted_at).not.toBeNull()
    expect(await activityCount()).toBe(0)
    expect((await h.del(`closures/${id}`, s)).statusCode).toBe(404)
    expect(json(await h.get('closures', s)).upcoming).toEqual([])
    expect((await h.post('closures', s, { date: '2026-06-20', name: 'Again' })).statusCode).toBe(201)
    expect(await auditActions(h.db)).toContain('settings.closure.delete')
  })
})

describe('PUT /settings/auto-federal-holidays', () => {
  const federal = async () =>
    h.db
      .selectFrom('closures')
      .select(['date', 'name', 'notify', 'source', 'federal_key', 'federal_year', 'type'])
      .where('source', '=', 'federal')
      .orderBy('date')
      .execute()

  it('turning it on generates the current and next year, closed, notify off, skipping past dates', async () => {
    const s = await h.admin()
    const r = await h.put('settings/auto-federal-holidays', s, { enabled: true })
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.enabled).toBe(true)
    const rows = await federal()
    expect(rows.map((x) => `${x.date} ${x.name}`)).toEqual([
      '2026-07-04 Independence Day',
      '2026-09-07 Labor Day',
      '2026-11-26 Thanksgiving',
      '2026-12-25 Christmas Day',
      '2027-05-31 Memorial Day',
      '2027-07-04 Independence Day',
      '2027-09-06 Labor Day',
      '2027-11-25 Thanksgiving',
      '2027-12-25 Christmas Day',
    ])
    expect(rows.every((x) => x.notify === false && x.type === 'closed')).toBe(true)
    expect(b.created).toHaveLength(9)
    expect(await activityCount()).toBe(0)
  })

  it('is idempotent, can be turned off, and never brings back a removed holiday', async () => {
    const s = await h.admin()
    await h.put('settings/auto-federal-holidays', s, { enabled: true })
    const again = json(await h.put('settings/auto-federal-holidays', s, { enabled: true }))
    expect(again.created).toEqual([])
    expect(await federal()).toHaveLength(9)

    const list = json(await h.get('closures', s))
    const thanksgiving = list.upcoming.find(
      (c: { name: string; date: string }) => c.name === 'Thanksgiving' && c.date.startsWith('2026'),
    )
    await h.del(`closures/${thanksgiving.id}`, s)
    const off = json(await h.put('settings/auto-federal-holidays', s, { enabled: false }))
    expect(off).toMatchObject({ enabled: false, created: [] })
    expect(json(await h.get('closures', s)).federalAuto).toBe(false)
    expect(json(await h.get('settings/rules', s)).federalAuto).toBe(false)
    const on = json(await h.put('settings/auto-federal-holidays', s, { enabled: true }))
    expect(on.created).toEqual([])
    const names = json(await h.get('closures', s)).upcoming.map(
      (c: { name: string; date: string }) => `${c.date} ${c.name}`,
    )
    expect(names).not.toContain('2026-11-26 Thanksgiving')
  })

  it('does not double a hand-entered closure for the same holiday', async () => {
    const s = await h.admin()
    await h.post('closures', s, {
      date: '2026-09-07',
      name: 'Labor Day',
      type: 'reduced',
      from: '10:00 AM',
      to: '2:00 PM',
    })
    await h.put('settings/auto-federal-holidays', s, { enabled: true })
    const labor = await h.db
      .selectFrom('closures')
      .select(['type', 'source', 'date'])
      .where('date', '=', '2026-09-07')
      .execute()
    expect(labor).toEqual([{ type: 'reduced', source: 'manual', date: '2026-09-07' }])
  })

  it('needs set.hours and enforces a supplied version', async () => {
    const mgr = await h.withPermissions(['set.emergency'])
    expect((await h.put('settings/auto-federal-holidays', mgr, { enabled: true })).statusCode).toBe(403)
    const s = await h.admin()
    const stale = await h.put('settings/auto-federal-holidays', s, { enabled: false, version: 9 })
    expect(stale.statusCode).toBe(412)
  })
})
