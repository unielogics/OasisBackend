import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { isAppError } from '../../src/platform/errors.js'
import { updateSetting } from '../../src/platform/settings.js'
import {
  CLOSURE_ERRORS,
  RecordingClosureNotifier,
  closureSubLine,
  closureTypeLabel,
  createClosure,
  deleteClosure,
  getClosure,
  listClosureViews,
  listLiveClosures,
  previewClosure,
  sqlAffectedCounter,
  updateClosure,
  type AffectedCounter,
} from '../../src/modules/settings/index.js'
import { useTestDb } from '../helpers/db.js'
import {
  edt,
  makeAppointment,
  makeCustomer,
  makeService,
  makeVehicle,
  setupLocation,
} from '../domain-schema/helpers.js'

const t = useTestDb({ poolMax: 6 })
const TZ = 'America/New_York'

async function appError(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (isAppError(e)) return e
    throw e
  }
  throw new Error('expected an AppError')
}

type Fx = Awaited<ReturnType<typeof setupLocation>>
const create = (f: Fx, o: Partial<Parameters<typeof createClosure>[1]> = {}) =>
  transaction(t.db, (tx) =>
    createClosure(tx, {
      locationId: f.locationId,
      date: '2026-07-04',
      name: 'Independence Day',
      type: 'closed',
      tz: TZ,
      newId: f.newId,
      ...o,
    }),
  )

describe('createClosure', () => {
  it('creates a closed day with notify on by default', async () => {
    const f = await setupLocation(t)
    const r = await create(f, { name: '  Independence Day  ' })
    expect(r.closure).toMatchObject({
      date: '2026-07-04',
      name: 'Independence Day',
      type: 'closed',
      openMin: null,
      closeMin: null,
      notify: true,
      source: 'manual',
      deletedAt: null,
    })
    expect(r.affectedCount).toBe(0)
    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', r.closure.id)
      .execute()
    expect(audit.map((a) => a.action)).toEqual(['settings.closure.create'])
  })

  it('creates a reduced day with its open window', async () => {
    const f = await setupLocation(t)
    const r = await create(f, {
      date: '2026-09-07',
      name: 'Labor Day',
      type: 'reduced',
      openMin: 600,
      closeMin: 840,
    })
    expect(r.closure).toMatchObject({ type: 'reduced', openMin: 600, closeMin: 840 })
  })

  it('rejects a missing date or name with the design string', async () => {
    const f = await setupLocation(t)
    for (const bad of [
      { date: '' },
      { name: '' },
      { name: '   ' },
      { date: 'not-a-date' },
      { date: '2026-02-30' },
    ]) {
      const e = await appError(create(f, bad))
      expect(e, JSON.stringify(bad)).toMatchObject({
        code: 'CLOSURE_INCOMPLETE',
        status: 422,
        detail: 'Add a date and a name.',
      })
    }
    expect(CLOSURE_ERRORS.incomplete).toBe('Add a date and a name.')
  })

  it('rejects a second closure on the same date with the design string', async () => {
    const f = await setupLocation(t)
    await create(f)
    const e = await appError(create(f, { name: 'Other' }))
    expect(e).toMatchObject({
      code: 'CLOSURE_DATE_TAKEN',
      status: 422,
      detail: "There's already a closure on that date.",
    })
    expect(await listLiveClosures(t.db, f.locationId)).toHaveLength(1)
  })

  it('allows the date again once the first closure was removed, and lets only one of two concurrent creates win', async () => {
    const f = await setupLocation(t)
    const first = await create(f)
    await transaction(t.db, (tx) => deleteClosure(tx, { locationId: f.locationId, id: first.closure.id }))
    await create(f, { name: 'Again' })
    const results = await Promise.allSettled([
      create(f, { date: '2026-08-01', name: 'A' }),
      create(f, { date: '2026-08-01', name: 'B' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(rejected.reason).toMatchObject({ code: 'CLOSURE_DATE_TAKEN' })
  })

  it('validates a reduced window', async () => {
    const f = await setupLocation(t)
    const reduced = (o: Partial<Parameters<typeof createClosure>[1]>) =>
      create(f, { type: 'reduced', date: '2026-09-07', ...o })
    expect((await appError(reduced({}))).detail).toBe('Set the opening and closing time for reduced hours.')
    expect((await appError(reduced({ openMin: 840, closeMin: 600 }))).detail).toBe(
      'Closing time must be after opening time.',
    )
    expect((await appError(reduced({ openMin: 615, closeMin: 840 }))).detail).toBe('Use 30-minute steps.')
    expect((await appError(reduced({ openMin: 240, closeMin: 840 }))).detail).toBe(
      'Hours must be between 5:00 AM and 11:30 PM.',
    )
    expect((await appError(create(f, { type: 'sometimes' as never }))).errors?.[0]?.path).toBe('type')
  })
})

describe('real affected counts', () => {
  async function bookings() {
    const f = await setupLocation(t)
    const service = await makeService(t.db, f)
    const appt = async (
      date: string,
      hhmm: string,
      status: 'booked' | 'confirmed' | 'completed' | 'canceled' | 'no_show' | 'arrived' = 'booked',
    ) =>
      makeAppointment(t.db, f, {
        customerId: await makeCustomer(t.db, f),
        serviceId: service,
        start: edt(date, hhmm),
        status,
      })
    return { f, appt }
  }
  const count = (f: Fx, o: Partial<Parameters<typeof previewClosure>[1]> = {}) =>
    previewClosure(t.db, { locationId: f.locationId, date: '2026-07-04', type: 'closed', tz: TZ, ...o })

  it('counts every non-canceled appointment that day for a closed closure, in the business time zone', async () => {
    const { f, appt } = await bookings()
    await appt('2026-07-04', '08:00')
    await appt('2026-07-04', '12:00', 'confirmed')
    await appt('2026-07-04', '16:00', 'arrived')
    await appt('2026-07-04', '23:30') // 03:30 UTC on the 5th, still the 4th in New York
    await appt('2026-07-04', '09:00', 'canceled')
    await appt('2026-07-05', '00:30') // the next business day
    await appt('2026-07-03', '23:30') // the previous one
    expect(await count(f)).toEqual({ affected: 4 })
  })

  it('counts only the appointments starting outside the open window for a reduced closure', async () => {
    const { f, appt } = await bookings()
    await appt('2026-09-07', '09:00') // before 10:00
    await appt('2026-09-07', '10:00') // exactly at opening: inside
    await appt('2026-09-07', '13:30') // inside
    await appt('2026-09-07', '14:00') // exactly at closing: outside
    await appt('2026-09-07', '15:00') // outside
    await appt('2026-09-07', '15:30', 'canceled')
    await appt('2026-09-08', '09:00')
    expect(await count(f, { date: '2026-09-07', type: 'reduced', openMin: 600, closeMin: 840 })).toEqual({
      affected: 3,
    })
  })

  it('is scoped to the location and ignores other days', async () => {
    const { f, appt } = await bookings()
    await appt('2026-07-04', '10:00')
    expect(await count({ ...f, locationId: '00000000-0000-7000-8000-000000000000' })).toEqual({ affected: 0 })
    expect(await count(f, { date: '2026-07-06' })).toEqual({ affected: 0 })
  })

  it('previews without writing and validates like create', async () => {
    const { f } = await bookings()
    expect(await count(f)).toEqual({ affected: 0 })
    expect(await listLiveClosures(t.db, f.locationId)).toEqual([])
    expect((await appError(count(f, { date: '' }))).code).toBe('CLOSURE_INCOMPLETE')
    expect((await appError(count(f, { type: 'reduced' }))).code).toBe('VALIDATION_FAILED')
  })

  it('goes through an interface, so another counter can replace the SQL one', async () => {
    const { f } = await bookings()
    const stub: AffectedCounter = { count: async () => 42, list: async () => [] }
    expect(await count(f, { counter: stub })).toEqual({ affected: 42 })
    const r = await create(f, { counter: stub, notify: false })
    expect(r.affectedCount).toBe(42)
    expect(sqlAffectedCounter.count).toBeTypeOf('function')
  })

  it('returns the real count when a closure is created, and messages the customers that need it when notify is on', async () => {
    const { f, appt } = await bookings()
    await appt('2026-07-04', '09:00')
    await appt('2026-07-04', '10:00', 'confirmed')
    await appt('2026-07-04', '11:00', 'completed')
    await appt('2026-07-04', '12:00', 'canceled')
    const notifier = new RecordingClosureNotifier()
    const r = await create(f, { notifier })
    expect(r).toMatchObject({ affectedCount: 3, notified: 2 })
    expect(notifier.notices).toHaveLength(1)
    expect(notifier.notices[0]!.notice).toMatchObject({
      date: '2026-07-04',
      name: 'Independence Day',
      type: 'closed',
      closureId: r.closure.id,
    })
    expect(notifier.notices[0]!.affected.map((a) => a.status).sort()).toEqual(['booked', 'confirmed'])
  })

  it('does not message anyone when notify is off but still counts', async () => {
    const { f, appt } = await bookings()
    await appt('2026-07-04', '09:00')
    const notifier = new RecordingClosureNotifier()
    const r = await create(f, { notifier, notify: false })
    expect(r).toMatchObject({ affectedCount: 1, notified: 0 })
    expect(notifier.notices).toEqual([])
  })

  it('lists the affected appointments with name, vehicle and time for the notifier', async () => {
    const { f } = await bookings()
    const c = await makeCustomer(t.db, f, { name: 'Marcus Webb' })
    const v = await makeVehicle(t.db, f, c, { make: 'Jeep', model: 'Wrangler' })
    const service = await makeService(t.db, f)
    await makeAppointment(t.db, f, {
      customerId: c,
      serviceId: service,
      vehicleId: v,
      start: edt('2026-07-04', '10:15'),
    })
    const list = await sqlAffectedCounter.list(
      t.db,
      { locationId: f.locationId, date: '2026-07-04', type: 'closed' },
      TZ,
    )
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      customerName: 'Marcus Webb',
      firstName: 'Marcus',
      vehicle: 'Jeep Wrangler',
      time: '10:15 AM',
      bizDate: '2026-07-04',
    })
  })
})

describe('updateClosure and deleteClosure', () => {
  it('edits the name, notify flag and type or window', async () => {
    const f = await setupLocation(t)
    const { closure } = await create(f, { date: '2026-09-07', name: 'Labor Day' })
    const ctx = { locationId: f.locationId, id: closure.id }
    const renamed = await transaction(t.db, (tx) =>
      updateClosure(tx, { ...ctx, patch: { name: ' Labor Day (short) ', notify: false } }),
    )
    expect(renamed).toMatchObject({ name: 'Labor Day (short)', notify: false, type: 'closed' })
    const reduced = await transaction(t.db, (tx) =>
      updateClosure(tx, { ...ctx, patch: { type: 'reduced', openMin: 600, closeMin: 840 } }),
    )
    expect(reduced).toMatchObject({ type: 'reduced', openMin: 600, closeMin: 840 })
    const window = await transaction(t.db, (tx) => updateClosure(tx, { ...ctx, patch: { closeMin: 900 } }))
    expect(window).toMatchObject({ openMin: 600, closeMin: 900 })
    const closed = await transaction(t.db, (tx) => updateClosure(tx, { ...ctx, patch: { type: 'closed' } }))
    expect(closed).toMatchObject({ type: 'closed', openMin: null, closeMin: null })
    expect(
      await appError(transaction(t.db, (tx) => updateClosure(tx, { ...ctx, patch: { type: 'reduced' } }))),
    ).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(
      await appError(transaction(t.db, (tx) => updateClosure(tx, { ...ctx, patch: { name: ' ' } }))),
    ).toMatchObject({ code: 'CLOSURE_INCOMPLETE' })
  })

  it('does not write or audit when nothing changes, and cannot reach another location or a missing id', async () => {
    const f = await setupLocation(t)
    const { closure } = await create(f)
    const same = await transaction(t.db, (tx) =>
      updateClosure(tx, { locationId: f.locationId, id: closure.id, patch: {} }),
    )
    expect(same.name).toBe('Independence Day')
    expect(
      await t.db
        .selectFrom('audit_log')
        .select('id')
        .where('action', '=', 'settings.closure.update')
        .execute(),
    ).toHaveLength(0)
    const other = '00000000-0000-7000-8000-000000000000'
    expect(
      (
        await appError(
          transaction(t.db, (tx) =>
            updateClosure(tx, { locationId: other, id: closure.id, patch: { notify: false } }),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND')
    expect(
      (
        await appError(
          transaction(t.db, (tx) => updateClosure(tx, { locationId: f.locationId, id: 'nope', patch: {} })),
        )
      ).code,
    ).toBe('NOT_FOUND')
  })

  it('soft-deletes, keeps the federal key, and frees the date', async () => {
    const f = await setupLocation(t)
    const { closure } = await create(f, {
      source: 'federal',
      federalKey: 'independence_day',
      federalYear: 2026,
    })
    const deleted = await transaction(t.db, (tx) =>
      deleteClosure(tx, { locationId: f.locationId, id: closure.id }),
    )
    expect(deleted.deletedAt?.toISOString()).toBe('2026-06-13T14:36:00.000Z')
    expect(await listLiveClosures(t.db, f.locationId)).toEqual([])
    const row = await getClosure(t.db, f.locationId, closure.id)
    expect(row).toMatchObject({ federalKey: 'independence_day', federalYear: 2026 })
    expect(
      (
        await appError(
          transaction(t.db, (tx) => deleteClosure(tx, { locationId: f.locationId, id: closure.id })),
        )
      ).code,
    ).toBe('NOT_FOUND')
    await create(f, { name: 'Replacement' })
  })

  it('refuses to edit or delete a closure that belongs to an emergency', async () => {
    const f = await setupLocation(t)
    const em = f.newId()
    await t.db
      .insertInto('emergency_closures')
      .values({
        id: em,
        location_id: f.locationId,
        reason: 'severe_weather',
        duration_kind: 'today',
        until_min: null,
        through_date: null,
        ends_at: null,
        started_by: null,
        started_by_name: null,
        reopened_at: null,
        reopened_by: null,
        reopened_by_name: null,
        detail: null,
      })
      .execute()
    const id = f.newId()
    await t.db
      .insertInto('closures')
      .values({
        id,
        location_id: f.locationId,
        date: '2026-06-13',
        name: 'Weather closure',
        type: 'closed',
        open_min: null,
        close_min: null,
        source: 'emergency',
        federal_key: null,
        federal_year: null,
        emergency_closure_id: em,
        created_by: null,
        deleted_at: null,
      })
      .execute()
    expect(
      (
        await appError(
          transaction(t.db, (tx) =>
            updateClosure(tx, { locationId: f.locationId, id, patch: { name: 'x' } }),
          ),
        )
      ).code,
    ).toBe('CLOSURE_LOCKED')
    expect(
      (await appError(transaction(t.db, (tx) => deleteClosure(tx, { locationId: f.locationId, id })))).code,
    ).toBe('CLOSURE_LOCKED')
  })
})

describe('listClosureViews and labels', () => {
  it('splits upcoming (ascending, with real counts) from past (newest first, no counts) and returns the federal toggle', async () => {
    const f = await setupLocation(t)
    const service = await makeService(t.db, f)
    await create(f, { date: '2026-05-25', name: 'Memorial Day' })
    await create(f, { date: '2026-06-03', name: 'Weather day' })
    await create(f, { date: '2026-09-07', name: 'Labor Day', type: 'reduced', openMin: 600, closeMin: 840 })
    await create(f, { date: '2026-07-04', name: 'Independence Day' })
    for (const hhmm of ['09:00', '10:00'])
      await makeAppointment(t.db, f, {
        customerId: await makeCustomer(t.db, f),
        serviceId: service,
        start: edt('2026-07-04', hhmm),
      })
    await makeAppointment(t.db, f, {
      customerId: await makeCustomer(t.db, f),
      serviceId: service,
      start: edt('2026-09-07', '09:00'),
    })
    const list = await listClosureViews(t.db, { locationId: f.locationId, today: '2026-06-13', tz: TZ })
    expect(list.federalAuto).toBe(true)
    expect(list.upcoming.map((c) => [c.date, c.affectedCount, c.subLine])).toEqual([
      ['2026-07-04', 2, 'Online booking blocked · 2 existing bookings to move'],
      ['2026-09-07', 1, 'Slots outside reduced hours hidden · 1 booking affected'],
    ])
    expect(list.upcoming.map((c) => c.typeLabel)).toEqual(['Closed all day', 'Reduced · 10:00 AM – 2:00 PM'])
    expect(list.past.map((c) => [c.date, c.affectedCount, c.subLine])).toEqual([
      ['2026-06-03', null, null],
      ['2026-05-25', null, null],
    ])
    await transaction(t.db, (tx) =>
      updateSetting(tx, { locationId: f.locationId, key: 'federal_holidays.auto', value: false }),
    )
    expect(
      (await listClosureViews(t.db, { locationId: f.locationId, today: '2026-06-13', tz: TZ })).federalAuto,
    ).toBe(false)
  })

  it('treats today as upcoming and honors a date range', async () => {
    const f = await setupLocation(t)
    await create(f, { date: '2026-06-13', name: 'Today' })
    await create(f, { date: '2026-12-25', name: 'Christmas Day' })
    const l = await listClosureViews(t.db, {
      locationId: f.locationId,
      today: '2026-06-13',
      tz: TZ,
      from: '2026-06-01',
      to: '2026-06-30',
    })
    expect(l.upcoming.map((c) => c.name)).toEqual(['Today'])
  })

  it('builds the tag and sub-line strings from the design', () => {
    expect(closureTypeLabel({ source: 'emergency', type: 'closed', openMin: null, closeMin: null })).toBe(
      'Emergency',
    )
    expect(closureTypeLabel({ source: 'manual', type: 'closed', openMin: null, closeMin: null })).toBe(
      'Closed all day',
    )
    expect(closureTypeLabel({ source: 'federal', type: 'reduced', openMin: 480, closeMin: 780 })).toBe(
      'Reduced · 8:00 AM – 1:00 PM',
    )
    expect(closureSubLine('closed', 0)).toBe('Online booking blocked · 0 existing bookings to move')
    expect(closureSubLine('closed', 1)).toBe('Online booking blocked · 1 existing booking to move')
    expect(closureSubLine('reduced', 3)).toBe('Slots outside reduced hours hidden · 3 bookings affected')
  })
})
