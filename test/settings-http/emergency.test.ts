import { describe, expect, it } from 'vitest'
import { ActivityEmergencyNotifier } from '../../src/modules/settings/db-adapters/notifiers.js'
import { edt } from '../domain-schema/helpers.js'
import { bookCustomer, seedDesignDay } from './fixtures.js'
import { auditActions, events, json, useSettingsHarness, type Session } from './harness.js'

const h = useSettingsHarness()

const close = (s: Session, body: Record<string, unknown> = {}, key = 'close-key-0001') =>
  h.post(
    'emergency/close',
    s,
    { reason: 'Severe weather', dur: 'today', ...body },
    { 'idempotency-key': key },
  )

const activeCount = async (): Promise<number> =>
  (await h.db.selectFrom('emergency_closures').select('id').where('active', '=', true).execute()).length

describe('GET /emergency (state and the live idle strip)', () => {
  it('shows the design strip from real rows: open now, hours, appointments left, vehicles on site', async () => {
    await seedDesignDay(h.db, h.fx)
    const s = await h.admin()
    const r = await h.get('emergency', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.active).toBe(false)
    expect(b.summary).toBeNull()
    expect(b.counters).toBeNull()
    expect(b.strip).toMatchObject({
      openNow: true,
      todayHours: 'Saturday 8:00 AM – 5:00 PM',
      appointmentsRemaining: 6,
      vehiclesOnSite: 3,
      date: '2026-06-13',
    })
    expect(b.strip.text).toBe(
      'Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site',
    )
    expect(b.canClose).toBe(true)
    expect(b.closeRoleNames).toEqual(['Management', 'Super Admin'])
    expect(b.requirement).toBe('Requires Management or Super Admin')
    expect(b.history).toEqual([])
    expect(b.options.reasons.map((x: { label: string }) => x.label)).toEqual([
      'Severe weather',
      'Power outage',
      'Equipment failure',
      'Staff shortage',
      'Other',
    ])
    expect(b.options.defaultMessage).toContain(
      'Hi {first}, due to {reason} Oasis Auto Spa is closed {until}.',
    )
  })

  it('reads singular and closed states, and is open to any signed-in user without history or close rights', async () => {
    await bookCustomer(h.db, h.fx, { name: 'Solo', date: '2026-06-13', time: '14:00' })
    await bookCustomer(h.db, h.fx, { name: 'Parked', date: '2026-06-13', time: '09:00', status: 'cleaning' })
    const crew = await h.withPermissions([])
    const b = json(await h.get('emergency', crew))
    expect(b.strip.text).toBe(
      'Open now · Saturday 8:00 AM – 5:00 PM · 1 appointment left today, 1 vehicle on site',
    )
    expect(b.canClose).toBe(false)
    expect(b.history).toBeNull()
    expect(b.closeRoleNames).toEqual(['Management', 'Super Admin'])

    h.clock.set('2026-06-13T18:30:00-04:00')
    expect(json(await h.get('emergency', crew)).strip).toMatchObject({ openNow: false })
    expect(json(await h.get('emergency', crew)).strip.text).toMatch(
      /^Closed now · Saturday 8:00 AM – 5:00 PM/,
    )

    const s = await h.admin()
    await h.post('closures', s, { date: '2026-06-13', name: 'Block party', notify: false })
    const closed = json(await h.get('emergency', s)).strip
    expect(closed).toMatchObject({ openNow: false, todayHours: null, closedReason: 'Block party' })
    expect(closed.text).toMatch(/^Closed today · Block party · /)
  })

  it('is refused without a session', async () => {
    expect((await h.call('GET', 'emergency')).statusCode).toBe(401)
  })
})

describe('GET /emergency/preview', () => {
  it('lists who is affected with date and vehicle, vehicles on site apart, and the message as it would read', async () => {
    await seedDesignDay(h.db, h.fx)
    const s = await h.admin()
    const r = await h.get('emergency/preview?reason=Severe%20weather&dur=today', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.count).toBe(6)
    expect(b.affected[0]).toMatchObject({
      customerName: 'Marcus Webb',
      vehicle: 'Jeep Wrangler',
      time: '10:15 AM',
      bizDate: '2026-06-13',
      dateLabel: 'Saturday, Jun 13',
      status: 'booked',
    })
    expect(b.affected.map((a: { customerName: string }) => a.customerName)).toEqual([
      'Marcus Webb',
      'Liam Chen',
      'Grace Adeyemi',
      'Aisha Rahman',
      'Tom Bradley',
      'Elena Volkov',
    ])
    expect(b.affected[0].phoneE164).toBeUndefined()
    expect(b.onSite.map((a: { customerName: string }) => a.customerName).sort()).toEqual([
      'On Site One',
      'On Site Two',
    ])
    expect(b.summary).toBe('Severe weather · closed for the rest of today · online booking paused')
    expect(b.untilText).toBe('for the rest of today')
    // reschedule links are off (RESCHEDULE_LINK_ENABLED=false): the link sentence is removed
    expect(b.renderedMessage).toBe(
      'Hi Liam, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience.',
    )
  })

  it('"Until a time" lists the appointments before it, and "Multiple days" includes the later days', async () => {
    await seedDesignDay(h.db, h.fx)
    await bookCustomer(h.db, h.fx, { name: 'Sunday Sam', date: '2026-06-14', time: '10:00' })
    await bookCustomer(h.db, h.fx, {
      name: 'Monday Mia',
      date: '2026-06-15',
      time: '09:00',
      status: 'confirmed',
    })
    await bookCustomer(h.db, h.fx, { name: 'Tuesday Tim', date: '2026-06-16', time: '09:00' })
    const s = await h.admin()
    const until = json(await h.get('emergency/preview?reason=power_outage&dur=until&until=2%3A00%20PM', s))
    expect(until.count).toBe(5)
    expect(until.untilText).toBe('until 2:00 PM today')
    expect(until.summary).toBe('Power outage · closed until 2:00 PM today · online booking paused')

    const days = json(await h.get('emergency/preview?reason=Other&dur=days&through=2026-06-15', s))
    expect(days.count).toBe(8)
    expect(days.untilText).toBe('through Monday, Jun 15')
    expect(
      days.affected
        .slice(-2)
        .map((a: { customerName: string; dateLabel: string }) => [a.customerName, a.dateLabel]),
    ).toEqual([
      ['Sunday Sam', 'Sunday, Jun 14'],
      ['Monday Mia', 'Monday, Jun 15'],
    ])
    expect(days.renderedMessage).toContain('closed through Monday, Jun 15')
    expect(json(await h.get('emergency/preview?reason=Other&dur=through&through=2026-06-15', s)).count).toBe(
      8,
    )
  })

  it('validates its inputs', async () => {
    const s = await h.admin()
    expect(json(await h.get('emergency/preview?reason=Aliens&dur=today', s)).detail).toBe('Pick a reason.')
    expect(json(await h.get('emergency/preview?reason=Other&dur=until', s)).detail).toBe(
      'Pick a time to reopen.',
    )
    expect(json(await h.get('emergency/preview?reason=Other&dur=until&until=9%3A00%20AM', s)).detail).toBe(
      'Pick a reopening time that is later than now.',
    )
    expect(json(await h.get('emergency/preview?reason=Other&dur=days', s)).detail).toBe(
      'Pick the last day of the closure.',
    )
    expect(json(await h.get('emergency/preview?reason=Other&dur=days&through=2026-06-01', s)).detail).toMatch(
      /Pick a date from today/,
    )
  })

  it('needs set.emergency', async () => {
    const s = await h.withPermissions(['set.hours'])
    expect((await h.get('emergency/preview?reason=Other&dur=today', s)).statusCode).toBe(403)
  })
})

describe('POST /emergency/close', () => {
  it('needs an Idempotency-Key', async () => {
    const s = await h.admin()
    const r = await h.post('emergency/close', s, { reason: 'Severe weather', dur: 'today' })
    expect(r.statusCode).toBe(400)
    expect(json(r).code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    expect(await activeCount()).toBe(0)
    const bad = await h.post(
      'emergency/close',
      s,
      { reason: 'x', dur: 'today' },
      { 'idempotency-key': 'short' },
    )
    expect(json(bad).code).toBe('IDEMPOTENCY_KEY_INVALID')
  })

  it('runs the whole flow on real appointments: counts, closure rows, notifications, events, audit', async () => {
    const day = await seedDesignDay(h.db, h.fx)
    // two customers that cannot be texted
    const optedOut = await bookCustomer(h.db, h.fx, {
      name: 'Opted Out',
      date: '2026-06-13',
      time: '16:00',
      customer: { optedOut: true, email: null },
    })
    const nobody = await bookCustomer(h.db, h.fx, {
      name: 'No Contact',
      date: '2026-06-13',
      time: '16:30',
      customer: { noPhone: true, email: null },
    })
    const s = await h.admin()

    const r = await close(s)
    expect(r.statusCode).toBe(201)
    const b = json(r)
    expect(b.summary).toBe('Severe weather · closed for the rest of today · online booking paused')
    expect(b.affected).toHaveLength(8)
    expect(b.notifiedCount).toBe(6)
    expect(b.skipped).toBe(2)
    expect(b.affected.map((a: { customerName: string }) => a.customerName).slice(0, 2)).toEqual([
      'Marcus Webb',
      'Liam Chen',
    ])
    expect(
      b.affected.find((a: { customerName: string }) => a.customerName === 'Opted Out').notification,
    ).toEqual({ channel: 'none', state: 'skipped_opt_out' })
    expect(
      b.affected.find((a: { customerName: string }) => a.customerName === 'No Contact').notification,
    ).toEqual({ channel: 'none', state: 'no_contact' })
    expect(b.onSite).toHaveLength(2)
    expect(b.emergency).toMatchObject({
      reason: 'severe_weather',
      reasonLabel: 'Severe weather',
      pause: true,
      startedByName: 'Amara O.',
    })
    expect(b.emergency.counters).toEqual({ affected: 8, notified: 6, rebooked: 0, booking: 'Paused' })

    // rows: the closure, the appointments flagged, one notification per affected appointment
    const em = await h.db.selectFrom('emergency_closures').selectAll().executeTakeFirstOrThrow()
    expect(em).toMatchObject({ active: true, affected_count: 8, notified_count: 6, duration_kind: 'today' })
    expect(em.ends_at?.toISOString()).toBe(edt('2026-06-13', '17:00').toISOString())
    expect(em.started_by).not.toBeNull()
    const closures = await h.db.selectFrom('closures').selectAll().where('source', '=', 'emergency').execute()
    expect(closures).toEqual([
      expect.objectContaining({
        date: '2026-06-13',
        type: 'reduced',
        open_min: 480,
        close_min: 636,
        name: 'Weather closure',
        notify: false,
      }),
    ])
    const flagged = await h.db
      .selectFrom('appointments')
      .select('id')
      .where('emergency_closure_id', '=', em.id)
      .execute()
    expect(flagged.map((a) => a.id).sort()).toEqual([...day.map((d) => d.id), optedOut.id, nobody.id].sort())
    const notes = await h.db
      .selectFrom('emergency_notifications')
      .select(['channel', 'state'])
      .where('emergency_closure_id', '=', em.id)
      .execute()
    expect(notes.filter((n) => n.state === 'queued')).toHaveLength(6)
    expect(h.emergencyNotifier.sent).toHaveLength(6)
    expect(h.emergencyNotifier.sent[0]!.message).toBe(
      'Hi Marcus, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience.',
    )
    // vehicles already on site are untouched
    const onSite = await h.db
      .selectFrom('appointments')
      .select('status')
      .where('emergency_closure_id', 'is', null)
      .where('status', 'in', ['arrived', 'cleaning'])
      .execute()
    expect(onSite).toHaveLength(2)

    const ev = await events(h.db)
    expect(ev.filter((e) => e.channel === 'ops').map((e) => e.type)).toEqual(['emergency.started'])
    expect(
      ev.filter((e) => e.type === 'settings.changed').some((e) => e.payload.section === 'emergency'),
    ).toBe(true)
    expect(await auditActions(h.db)).toContain('emergency.close')

    // the delayed auto-reopen job is scheduled for the end time, keyed by the emergency
    expect(h.queued).toHaveLength(1)
    expect(h.queued[0]).toMatchObject({
      name: 'emergency.auto_reopen',
      data: { emergencyClosureId: em.id, locationId: h.fx.locationId },
    })
    expect((h.queued[0]!.opts?.startAfter as Date).toISOString()).toBe(em.ends_at!.toISOString())
    expect(h.queued[0]!.opts?.singletonKey).toBe(em.id)

    // the banner and the strip now read the emergency
    const state = json(await h.get('emergency', s))
    expect(state).toMatchObject({
      active: true,
      summary: 'Severe weather · closed for the rest of today · online booking paused',
      counters: { affected: 8, notified: 6, rebooked: 0, booking: 'Paused' },
    })
    expect(state.strip.openNow).toBe(false)
    // and the closures list shows the emergency row, locked
    const list = json(await h.get('closures', s))
    const row = list.upcoming.find((c: { emergency: boolean }) => c.emergency)
    expect(row).toMatchObject({ typeLabel: 'Emergency', source: 'emergency' })
    expect((await h.patch(`closures/${row.id}`, s, { notify: true })).statusCode).toBe(409)
    expect(json(await h.del(`closures/${row.id}`, s)).code).toBe('CLOSURE_LOCKED')
  })

  it('replays the same Idempotency-Key without a second closure, and refuses a different body or a second emergency', async () => {
    await seedDesignDay(h.db, h.fx)
    const s = await h.admin()
    const a = await close(s)
    const b = await close(s)
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    expect(json(b)).toEqual(json(a))
    expect(await activeCount()).toBe(1)
    expect(h.emergencyNotifier.sent).toHaveLength(6)
    expect(h.queued).toHaveLength(1)

    const mismatch = await close(s, { reason: 'Power outage' })
    expect(mismatch.statusCode).toBe(422)
    expect(json(mismatch).code).toBe('IDEMPOTENCY_MISMATCH')

    const second = await close(s, {}, 'close-key-0002')
    expect(second.statusCode).toBe(409)
    expect(json(second)).toMatchObject({ code: 'EMERGENCY_ACTIVE', title: 'Already closed' })
    expect(await activeCount()).toBe(1)
    // a failed attempt releases its key so the user can retry after fixing the problem
    const reopen = await h.post('emergency/reopen', s)
    expect(reopen.statusCode).toBe(200)
    expect((await close(s, {}, 'close-key-0002')).statusCode).toBe(201)
  })

  it('rejects "rest of today" once the shop has closed, with a clear error, but allows an earlier hour and multi-day', async () => {
    const s = await h.admin()
    h.clock.set('2026-06-13T18:30:00-04:00')
    const late = await close(s)
    expect(late.statusCode).toBe(422)
    expect(json(late)).toMatchObject({
      code: 'EMERGENCY_NOTHING_TO_CLOSE',
      title: 'Already closed',
      detail: 'The shop is already closed for the rest of today. Choose Multiple days to close from tomorrow',
    })
    expect(json(await h.get('emergency/preview?reason=Other&dur=today', s)).code).toBe(
      'EMERGENCY_NOTHING_TO_CLOSE',
    )
    expect(await activeCount()).toBe(0)
    const days = await close(s, { dur: 'days', through: '2026-06-15' }, 'close-key-0003')
    expect(days.statusCode).toBe(201)
    await h.post('emergency/reopen', s)

    h.clock.set('2026-06-13T06:30:00-04:00')
    expect((await close(s, {}, 'close-key-0004')).statusCode).toBe(201)
    const row = await h.db
      .selectFrom('closures')
      .select(['type'])
      .where('source', '=', 'emergency')
      .where('deleted_at', 'is', null)
      .execute()
    expect(row).toEqual([{ type: 'closed' }])
  })

  it('closes several days: every affected day is listed, planned closures are replaced and restored on reopen', async () => {
    await bookCustomer(h.db, h.fx, { name: 'Sunday Sam', date: '2026-06-14', time: '10:00' })
    await bookCustomer(h.db, h.fx, {
      name: 'Monday Mia',
      date: '2026-06-15',
      time: '09:00',
      status: 'confirmed',
    })
    await bookCustomer(h.db, h.fx, { name: 'Tuesday Tim', date: '2026-06-16', time: '09:00' })
    const s = await h.admin()
    await h.post('closures', s, { date: '2026-06-15', name: 'Training day', notify: false })
    const r = await close(s, {
      dur: 'days',
      through: '2026-06-15',
      message: 'Hello {first}, we are closed {until}. Rebook: {link}',
    })
    expect(r.statusCode).toBe(201)
    const b = json(r)
    expect(b.summary).toBe('Severe weather · closed through Monday, Jun 15 · online booking paused')
    expect(b.affected.map((a: { customerName: string }) => a.customerName)).toEqual([
      'Sunday Sam',
      'Monday Mia',
    ])
    expect(b.closuresCreated.map((c: { date: string; type: string }) => `${c.date} ${c.type}`)).toEqual([
      '2026-06-13 closed',
      '2026-06-14 closed',
      '2026-06-15 closed',
    ])
    expect(h.emergencyNotifier.sent[0]!.message).toBe('Hello Sunday, we are closed through Monday, Jun 15.')
    const live = await h.db
      .selectFrom('closures')
      .select(['date', 'name', 'source'])
      .where('deleted_at', 'is', null)
      .orderBy('date')
      .execute()
    expect(live.map((c) => `${c.date} ${c.source}`)).toEqual([
      '2026-06-13 emergency',
      '2026-06-14 emergency',
      '2026-06-15 emergency',
    ])

    const reopen = await h.post('emergency/reopen', s)
    expect(reopen.statusCode).toBe(200)
    expect(json(reopen)).toMatchObject({ restoredClosures: 1, removedClosures: 3 })
    const after = await h.db
      .selectFrom('closures')
      .select(['date', 'name', 'source'])
      .where('deleted_at', 'is', null)
      .orderBy('date')
      .execute()
    expect(after).toEqual([{ date: '2026-06-15', name: 'Training day', source: 'manual' }])
  })

  it('records the activity line and customer message through the default notifier', async () => {
    const day = await seedDesignDay(h.db, h.fx)
    h.ports.emergencyNotifier = new ActivityEmergencyNotifier()
    try {
      const s = await h.admin()
      expect((await close(s)).statusCode).toBe(201)
    } finally {
      h.ports.emergencyNotifier = h.emergencyNotifier
    }
    const lines = await h.db
      .selectFrom('activity_log')
      .select(['appointment_id', 'text', 'channels', 'meta'])
      .where('appointment_id', '=', day[0]!.id)
      .execute()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('Emergency closure message queued by SMS')
    expect(lines[0]!.channels).toEqual(['sms', 'system'])
    expect((lines[0]!.meta as unknown as { state: string }).state).toBe('queued')
  })

  it('alerts the crew on shift now with a bell notification and a targeted event', async () => {
    const s = await h.admin()
    const lena = await h.createUser({ email: 'lena@example.test', first: 'Lena', last: 'Kim' })
    const sam = await h.createUser({ email: 'sam@example.test', first: 'Sam', last: 'Off' })
    const sched = (employeeId: string, on: boolean) =>
      h.db
        .updateTable('employee_schedules')
        .set({ is_on: on, from_min: 480, to_min: 1020 })
        .where('employee_id', '=', employeeId)
        .where('weekday', '=', 6)
        .execute()
    await sched(lena.employeeId, true)
    await sched(sam.employeeId, false)
    expect((await close(s)).statusCode).toBe(201)
    const notes = await h.db
      .selectFrom('notifications')
      .select(['employee_id', 'kind', 'title', 'body', 'entity_type'])
      .execute()
    expect(notes).toEqual([
      {
        employee_id: lena.employeeId,
        kind: 'emergency',
        title: 'Emergency closure',
        body: 'Severe weather · closed for the rest of today · online booking paused',
        entity_type: 'emergency_closure',
      },
    ])
    const targeted = await h.db
      .selectFrom('realtime_events')
      .select(['type', 'target_user_id'])
      .where('channel', '=', 'notifications')
      .execute()
    expect(targeted).toEqual([{ type: 'notification.new', target_user_id: lena.userId }])
  })

  it('skips the crew alert and the messages when their switches are off', async () => {
    await seedDesignDay(h.db, h.fx)
    const s = await h.admin()
    const lena = await h.createUser({ email: 'lena@example.test', first: 'Lena' })
    await h.db
      .updateTable('employee_schedules')
      .set({ is_on: true, from_min: 480, to_min: 1020 })
      .where('employee_id', '=', lena.employeeId)
      .where('weekday', '=', 6)
      .execute()
    const r = json(await close(s, { notify: false, crew: false, pause: false }))
    expect(r.notifiedCount).toBe(0)
    expect(r.summary).toBe('Severe weather · closed for the rest of today')
    expect(h.emergencyNotifier.sent).toHaveLength(0)
    expect(await h.db.selectFrom('notifications').select('id').execute()).toHaveLength(0)
    expect(json(await h.get('emergency', s)).counters).toMatchObject({ booking: 'Open' })
  })

  it('validates the request body', async () => {
    const s = await h.admin()
    expect(json(await close(s, { reason: 'Meteor' })).detail).toBe('Pick a reason.')
    expect(json(await close(s, { dur: 'until' })).detail).toBe('Pick a time to reopen.')
    expect(json(await close(s, { dur: 'days' })).detail).toBe('Pick the last day of the closure.')
    expect(json(await close(s, { dur: 'until', until: '9:00 AM' })).detail).toBe(
      'Pick a reopening time that is later than now.',
    )
    expect((await close(s, { message: 'x'.repeat(1001) })).statusCode).toBe(422)
    expect(await activeCount()).toBe(0)
  })

  it('needs set.emergency', async () => {
    const s = await h.withPermissions(['set.hours', 'set.services'])
    const r = await close(s)
    expect(r.statusCode).toBe(403)
    expect(json(r).meta.required).toEqual(['set.emergency'])
  })
})

describe('reopen, history and the needs-rebooking queue', () => {
  it('reopens with the real counts, writes the history, and lists customers who have not rebooked', async () => {
    const day = await seedDesignDay(h.db, h.fx)
    const s = await h.admin()
    const em = json(await close(s)).emergency.id as string
    // two customers rebooked through their links
    await h.db
      .updateTable('emergency_notifications')
      .set({ rebooked_at: h.clock.now() })
      .where('appointment_id', 'in', [day[0]!.id, day[1]!.id])
      .execute()

    expect(json(await h.get('emergency', s)).counters).toEqual({
      affected: 6,
      notified: 6,
      rebooked: 2,
      booking: 'Paused',
    })
    h.clock.advance(5 * 60_000)
    const r = await h.post('emergency/reopen', s)
    expect(r.statusCode).toBe(200)
    expect(json(r)).toMatchObject({
      id: em,
      detail: 'Reopened by Amara O. · 6 notified',
      removedClosures: 1,
      restoredClosures: 0,
    })
    expect(await activeCount()).toBe(0)
    expect(
      await h.db.selectFrom('closures').select('id').where('deleted_at', 'is', null).execute(),
    ).toHaveLength(0)

    const types = (await events(h.db, 'ops')).map((e) => e.type)
    expect(types).toEqual(['emergency.started', 'emergency.reopened'])
    expect(await auditActions(h.db)).toContain('emergency.reopen')

    const history = json(await h.get('emergency/history', s))
    expect(history.items).toEqual([
      {
        id: em,
        date: 'Jun 13, 2026',
        reason: 'Severe weather',
        detail: 'Reopened by Amara O. · 6 notified',
        affectedCount: 6,
        notifiedCount: 6,
        rebookedCount: 2,
      },
    ])
    expect(json(await h.get('emergency', s)).history).toHaveLength(1)

    const queue = json(await h.get(`emergency/${em}/affected`, s))
    expect(queue.count).toBe(4)
    expect(queue.items.map((a: { customerName: string }) => a.customerName)).toEqual([
      'Grace Adeyemi',
      'Aisha Rahman',
      'Tom Bradley',
      'Elena Volkov',
    ])
    // nobody was canceled
    expect(
      await h.db.selectFrom('appointments').select('id').where('status', '=', 'canceled').execute(),
    ).toHaveLength(1)
  })

  it('answers 409 when there is nothing to reopen, and 404 for an unknown emergency', async () => {
    const s = await h.admin()
    const r = await h.post('emergency/reopen', s)
    expect(r.statusCode).toBe(409)
    expect(json(r)).toMatchObject({
      code: 'EMERGENCY_NOT_ACTIVE',
      detail: 'There is no active emergency closure',
    })
    expect((await h.get('emergency/00000000-0000-7000-8000-000000000001/affected', s)).statusCode).toBe(404)
  })

  it('history and the queue need set.emergency', async () => {
    const s = await h.withPermissions(['set.hours'])
    expect((await h.get('emergency/history', s)).statusCode).toBe(403)
    expect((await h.get('emergency/00000000-0000-7000-8000-000000000001/affected', s)).statusCode).toBe(403)
    expect((await h.post('emergency/reopen', s)).statusCode).toBe(403)
  })

  it('lists seeded history newest first', async () => {
    const s = await h.admin()
    const insert = (
      id: string,
      at: string,
      reason: string,
      detail: string,
      notified: number,
      rebooked: number,
    ) =>
      h.db
        .insertInto('emergency_closures')
        .values({
          id,
          location_id: h.fx.locationId,
          active: false,
          reason: reason as never,
          duration_kind: 'today',
          through_date: at.slice(0, 10),
          started_at: new Date(at),
          reopened_at: new Date(at),
          detail,
          notified_count: notified,
          rebooked_count: rebooked,
          affected_count: notified,
        })
        .execute()
    await insert(
      '0197b3f2-8d3c-7b1a-9c2e-1f2a3b4c5d01',
      '2026-02-18T16:20:00Z',
      'power_outage',
      '11:20 AM – 3:00 PM · 4 notified',
      4,
      0,
    )
    await insert(
      '0197b3f2-8d3c-7b1a-9c2e-1f2a3b4c5d02',
      '2026-06-03T12:00:00Z',
      'severe_weather',
      'Full day · 7 customers notified · 6 rebooked',
      7,
      6,
    )
    const items = json(await h.get('emergency/history', s)).items
    expect(items.map((i: { date: string; reason: string }) => `${i.date} ${i.reason}`)).toEqual([
      'Jun 3, 2026 Severe weather',
      'Feb 18, 2026 Power outage',
    ])
    expect(json(await h.get('emergency/history?limit=1', s)).items).toHaveLength(1)
  })
})
