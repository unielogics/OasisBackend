import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { isAppError } from '../../src/platform/errors.js'
import {
  DEFAULT_HOURS,
  DEFAULT_RULES,
  getHoursAndRules,
  hoursLabel,
  saveHoursAndRules,
  validateHours,
  validateRules,
  weekMinutes,
  type HoursDay,
  type SaveHoursInput,
} from '../../src/modules/settings/index.js'
import { useTestDb } from '../helpers/db.js'
import { edt, makeAppointment, makeCustomer, makeService, setupLocation } from '../domain-schema/helpers.js'

const t = useTestDb()
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

const week = (patch: Partial<Record<number, Partial<HoursDay>>> = {}): HoursDay[] =>
  DEFAULT_HOURS.map((d) => ({ ...d, ...(patch[d.weekday] ?? {}) }))

describe('validateHours (pure)', () => {
  const cases: [string, HoursDay[], string[]][] = [
    ['the design week is valid', week(), []],
    [
      'closing equal to opening',
      week({ 1: { openMin: 600, closeMin: 600 } }),
      ['Monday: closing time must be after opening time.'],
    ],
    [
      'closing before opening',
      week({ 2: { openMin: 720, closeMin: 600 } }),
      ['Tuesday: closing time must be after opening time.'],
    ],
    [
      'opening before 5:00 AM',
      week({ 3: { openMin: 270 } }),
      ['Wednesday: hours must be between 5:00 AM and 11:30 PM.'],
    ],
    [
      'closing after 11:30 PM',
      week({ 4: { closeMin: 1440 } }),
      ['Thursday: hours must be between 5:00 AM and 11:30 PM.'],
    ],
    ['off the 30-minute grid', week({ 5: { openMin: 495 } }), ['Friday: use 30-minute steps.']],
    ['the full range is valid', week({ 6: { openMin: 300, closeMin: 1410 } }), []],
    [
      'a closed day still has to hold valid hours',
      week({ 0: { isOpen: false, openMin: 900, closeMin: 540 } }),
      ['Sunday: closing time must be after opening time.'],
    ],
    ['fractional minutes', week({ 1: { openMin: 480.5 } }), ['Monday: times must be whole minutes.']],
  ]
  for (const [name, days, messages] of cases)
    it(name, () => {
      expect(validateHours(days).map((i) => i.message)).toEqual(messages)
    })

  it('needs all seven days exactly once', () => {
    expect(validateHours(week().slice(0, 6)).map((i) => i.message)).toContain(
      'Send all seven days, Sunday to Saturday.',
    )
    const dup = [...week().slice(0, 6), { ...week()[0]! }]
    expect(validateHours(dup).map((i) => i.message)).toEqual(
      expect.arrayContaining(['Sunday appears twice.']),
    )
    expect(
      validateHours([...week().slice(0, 6), { weekday: 9, isOpen: true, openMin: 480, closeMin: 1080 }])[0]!
        .path,
    ).toBe('days.6.weekday')
  })

  it('reports every bad day, not only the first', () => {
    const issues = validateHours(week({ 1: { openMin: 600, closeMin: 600 }, 2: { openMin: 270 } }))
    expect(issues.map((i) => i.path)).toEqual(['days.1', 'days.2'])
  })
})

describe('validateRules (pure)', () => {
  it('accepts the design choices and rejects everything else', () => {
    expect(validateRules({ slotMinutes: 15, bufferMinutes: 0, cutoffMinutes: 90 })).toEqual([])
    expect(validateRules({ slotMinutes: 20 }).map((i) => i.path)).toEqual(['rules.slotMinutes'])
    expect(validateRules({ bufferMinutes: 5 }).map((i) => i.path)).toEqual(['rules.bufferMinutes'])
    expect(validateRules({ cutoffMinutes: 45 }).map((i) => i.path)).toEqual(['rules.cutoffMinutes'])
    expect(validateRules({ onlineLeadMinutes: 241 }).map((i) => i.path)).toEqual(['rules.onlineLeadMinutes'])
    expect(validateRules({ slotMinutes: 30, bufferMinutes: 10, cutoffMinutes: 60 })).toEqual([])
  })
})

describe('week totals', () => {
  it('the design week is 65 hours', () => {
    expect(weekMinutes(DEFAULT_HOURS)).toBe(3900)
    expect(hoursLabel(3900)).toBe('65 hrs')
    expect(hoursLabel(630)).toBe('10.5 hrs')
    expect(weekMinutes(week({ 0: { isOpen: false } }))).toBe(3900 - 360)
  })
})

describe('getHoursAndRules / saveHoursAndRules', () => {
  const save = (f: Awaited<ReturnType<typeof setupLocation>>, o: Partial<SaveHoursInput>) =>
    transaction(t.db, (tx) =>
      saveHoursAndRules(tx, { locationId: f.locationId, now: t.clock.now(), tz: TZ, ...o }),
    )

  it('returns the design defaults at version 0 before anything is stored', async () => {
    const f = { ...(await setupLocation(t)) }
    await t.db.deleteFrom('business_hours').execute()
    await t.db.deleteFrom('booking_rules').execute()
    const empty = await getHoursAndRules(t.db, f.locationId)
    expect(empty).toMatchObject({ version: 0, weekMinutes: 3900, rules: DEFAULT_RULES })
    expect(empty.days).toEqual([...DEFAULT_HOURS])
  })

  it('reads the stored week and rules', async () => {
    const f = await setupLocation(t)
    const r = await getHoursAndRules(t.db, f.locationId)
    expect(r).toMatchObject({ version: 1, rules: { slotMinutes: 30, bufferMinutes: 10, cutoffMinutes: 60 } })
    expect(r.days.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(r.days[6]).toEqual({ weekday: 6, isOpen: true, openMin: 480, closeMin: 1020 })
  })

  it('saves hours and rules together with one version bump, an audit entry and an event', async () => {
    const f = await setupLocation(t)
    const r = await save(f, {
      days: week({ 1: { openMin: 540, closeMin: 1020 }, 0: { isOpen: false } }),
      rules: { slotMinutes: 15, bufferMinutes: 20, cutoffMinutes: 30 },
      expectedVersion: 1,
    })
    expect(r).toMatchObject({
      changed: true,
      version: 2,
      rules: { slotMinutes: 15, bufferMinutes: 20, cutoffMinutes: 30 },
    })
    expect(r.days[1]).toMatchObject({ openMin: 540, closeMin: 1020 })
    expect(r.days[0]!.isOpen).toBe(false)
    const stored = await getHoursAndRules(t.db, f.locationId)
    expect(stored).toMatchObject({ version: 2, rules: { slotMinutes: 15 } })
    expect(stored.days[1]).toMatchObject({ openMin: 540 })
    const audits = await t.db
      .selectFrom('audit_log')
      .select(['action', 'before', 'after'])
      .where('action', '=', 'settings.hours.update')
      .execute()
    expect(audits).toHaveLength(1)
    expect((audits[0]!.after as { rules: { slotMinutes: number } }).rules.slotMinutes).toBe(15)
    expect((audits[0]!.before as { rules: { slotMinutes: number } }).rules.slotMinutes).toBe(30)
    const ev = await t.db
      .selectFrom('realtime_events')
      .select('payload')
      .where('type', '=', 'settings.changed')
      .execute()
    expect(ev.map((e) => e.payload)).toEqual([{ section: 'hours', key: 'hours', version: 2 }])
  })

  it('saves rules alone or hours alone (rules save immediately)', async () => {
    const f = await setupLocation(t)
    const rulesOnly = await save(f, { rules: { bufferMinutes: 0 } })
    expect(rulesOnly).toMatchObject({ changed: true, version: 2 })
    expect(rulesOnly.days).toEqual([...DEFAULT_HOURS])
    const hoursOnly = await save(f, { days: week({ 6: { closeMin: 960 } }) })
    expect(hoursOnly).toMatchObject({ changed: true, version: 3, rules: { bufferMinutes: 0 } })
  })

  it('is a no-op when nothing changes: no version bump, no audit entry', async () => {
    const f = await setupLocation(t)
    const r = await save(f, { days: week(), rules: { slotMinutes: 30 } })
    expect(r).toMatchObject({ changed: false, version: 1 })
    expect(await t.db.selectFrom('audit_log').select('id').execute()).toHaveLength(0)
  })

  it('writes nothing when any part is invalid (one transaction)', async () => {
    const f = await setupLocation(t)
    const e = await appError(
      save(f, { days: week({ 2: { openMin: 720, closeMin: 600 } }), rules: { slotMinutes: 20 as never } }),
    )
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
    expect(e.errors?.map((x) => x.message)).toEqual([
      'Tuesday: closing time must be after opening time.',
      'Slot length must be 15, 30 or 60 minutes.',
    ])
    expect(e.detail).toBe('Tuesday: closing time must be after opening time.')
    expect(await getHoursAndRules(t.db, f.locationId)).toMatchObject({
      version: 1,
      rules: { slotMinutes: 30 },
    })
  })

  it('rejects a stale version and reports the current one', async () => {
    const f = await setupLocation(t)
    await save(f, { rules: { slotMinutes: 60 }, expectedVersion: 1 })
    const e = await appError(save(f, { rules: { slotMinutes: 15 }, expectedVersion: 1 }))
    expect(e.code).toBe('VERSION_CONFLICT')
    expect(e.meta).toEqual({ currentVersion: 2 })
    expect((await getHoursAndRules(t.db, f.locationId)).rules.slotMinutes).toBe(60)
  })

  it('accepts days in any order', async () => {
    const f = await setupLocation(t)
    const r = await save(f, { days: week({ 3: { closeMin: 1020 } }).reverse() })
    expect(r.days.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(r.days[3]!.closeMin).toBe(1020)
  })

  it('creates the rows for a location that has none', async () => {
    const f = await setupLocation(t)
    await t.db.deleteFrom('business_hours').execute()
    await t.db.deleteFrom('booking_rules').execute()
    const r = await save(f, { days: week({ 1: { closeMin: 1020 } }) })
    expect(r.version).toBe(2)
    expect((await t.db.selectFrom('business_hours').select('weekday').execute()).length).toBe(7)
  })

  describe('warnings', () => {
    async function scenario() {
      const f = await setupLocation(t)
      const service = await makeService(t.db, f)
      const appt = async (
        date: string,
        hhmm: string,
        status: 'booked' | 'confirmed' | 'completed' | 'canceled' | 'arrived' = 'booked',
      ) =>
        makeAppointment(t.db, f, {
          customerId: await makeCustomer(t.db, f),
          serviceId: service,
          start: edt(date, hhmm),
          status,
        })
      return { f, appt }
    }

    it('lists upcoming appointments outside the new window or on a day that is now closed, in the business time zone', async () => {
      const { f, appt } = await scenario()
      const early = await appt('2026-06-15', '08:00') // Monday, before the new 9:00 opening
      const ok = await appt('2026-06-15', '12:00')
      const late = await appt('2026-06-15', '17:30') // at or after the new 17:00 closing
      const sunday = await appt('2026-06-14', '10:00') // Sunday becomes a day off
      await appt('2026-06-15', '18:30', 'canceled')
      await appt('2026-06-15', '07:00', 'completed')
      await appt('2026-06-12', '07:00') // already in the past (clock is Jun 13)
      void ok
      const r = await save(f, { days: week({ 1: { openMin: 540, closeMin: 1020 }, 0: { isOpen: false } }) })
      expect(r.warnings.appointmentsOutsideHours.map((a) => a.appointmentId)).toEqual([sunday, early, late])
      expect(r.warnings.appointmentsOutsideHours.map((a) => [a.weekday, a.startMin])).toEqual([
        [0, 600],
        [1, 480],
        [1, 1050],
      ])
      expect(r.warnings.employeeScheduleConflicts).toEqual([])
    })

    it('does not move or cancel anything, and reports nothing when everything still fits', async () => {
      const { f, appt } = await scenario()
      const id = await appt('2026-06-15', '08:00')
      const r = await save(f, { days: week({ 1: { openMin: 540 } }) })
      expect(r.warnings.appointmentsOutsideHours).toHaveLength(1)
      const row = await t.db
        .selectFrom('appointments')
        .select(['status', 'scheduled_start'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.status).toBe('booked')
      expect(row.scheduled_start.toISOString()).toBe(edt('2026-06-15', '08:00').toISOString())
      const quiet = await save(f, { days: week({ 1: { openMin: 480 } }) })
      expect(quiet.warnings.appointmentsOutsideHours).toEqual([])
    })

    it('treats a start exactly at opening as inside and exactly at closing as outside', async () => {
      const { f, appt } = await scenario()
      await appt('2026-06-15', '09:00')
      const edge = await appt('2026-06-15', '17:00')
      const r = await save(f, { days: week({ 1: { openMin: 540, closeMin: 1020 } }) })
      expect(r.warnings.appointmentsOutsideHours.map((a) => a.appointmentId)).toEqual([edge])
    })

    it('hands the employee schedule check to the people vertical through a hook', async () => {
      const f = await setupLocation(t)
      const seen: HoursDay[][] = []
      const r = await save(f, {
        days: week({ 6: { closeMin: 960 } }),
        hooks: {
          employeeScheduleConflicts: async (_tx, ctx) => {
            seen.push(ctx.days)
            return [
              {
                employeeId: 'e3',
                employeeName: 'Marco R.',
                weekday: 6,
                message: 'Saturday: availability must sit inside business hours (8:00 AM – 4:00 PM).',
              },
            ]
          },
        },
      })
      expect(seen[0]!.find((d) => d.weekday === 6)!.closeMin).toBe(960)
      expect(r.warnings.employeeScheduleConflicts).toHaveLength(1)
      expect(r.changed).toBe(true)
    })

    it('still reports warnings on a no-op save', async () => {
      const { f, appt } = await scenario()
      await appt('2026-06-14', '10:00')
      await save(f, { days: week({ 0: { isOpen: false } }) })
      const again = await save(f, { days: week({ 0: { isOpen: false } }) })
      expect(again.changed).toBe(false)
      expect(again.warnings.appointmentsOutsideHours).toHaveLength(1)
    })
  })
})
