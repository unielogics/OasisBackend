import { describe, expect, it } from 'vitest'
import { DbBusinessHours } from '../../src/modules/settings/db-adapters/business-hours.js'
import { onShiftUsers } from '../../src/modules/settings/db-adapters/effects.js'
import { AuditAccountNotifier } from '../../src/modules/settings/db-adapters/notifiers.js'
import { employeeScheduleConflicts } from '../../src/modules/settings/db-adapters/schedule-conflicts.js'
import { getHours } from '../../src/modules/settings/hours.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { makeLocation } from '../helpers/factories.js'
import { json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

const setSchedule = (employeeId: string, weekday: number, on: boolean, fromMin = 480, toMin = 1080) =>
  h.db
    .updateTable('employee_schedules')
    .set({ is_on: on, from_min: fromMin, to_min: toMin })
    .where('employee_id', '=', employeeId)
    .where('weekday', '=', weekday)
    .execute()

describe('DbBusinessHours', () => {
  it('reads the hours the manager saved, defaults included', async () => {
    const port = new DbBusinessHours(h.db)
    const before = (await port.get(h.fx.locationId))!
    expect(before).toHaveLength(7)
    expect(before[0]).toEqual({ weekday: 0, open: true, fromMin: 540, toMin: 900 })
    expect(before[6]).toEqual({ weekday: 6, open: true, fromMin: 480, toMin: 1020 })

    const s = await h.admin()
    const hours = json(await h.get('settings/hours', s))
    await h.put('settings/hours', s, {
      version: hours.version,
      days: hours.days.map((d: { weekday: number; fromMin: number; toMin: number }) => ({
        weekday: d.weekday,
        open: d.weekday !== 0,
        fromMin: d.fromMin,
        toMin: d.toMin,
      })),
    })
    const after = (await port.get(h.fx.locationId))!
    expect(after[0]).toMatchObject({ weekday: 0, open: false })
    expect(after[1]).toMatchObject({ weekday: 1, open: true, fromMin: 480, toMin: 1080 })
  })

  it('answers with the design defaults for a location that has no rows yet', async () => {
    const other = await makeLocation(h.db, createIdGenerator(h.clock))
    const days = await getHours(h.db, other.id)
    expect(days.map((d) => d.openMin)).toEqual([540, 480, 480, 480, 480, 480, 480])
    expect((await new DbBusinessHours(h.db).get(other.id))![0]).toMatchObject({ open: true, fromMin: 540 })
  })
})

describe('employeeScheduleConflicts', () => {
  const week = (over: Partial<Record<number, { isOpen: boolean; openMin: number; closeMin: number }>> = {}) =>
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      isOpen: true,
      openMin: 480,
      closeMin: 1080,
      ...over[weekday],
    }))

  it('lists active and invited people whose "on" days fall outside the hours, one entry per day', async () => {
    const a = await h.createUser({ email: 'a@example.test', first: 'Ana', last: 'Active' })
    const b = await h.createUser({ email: 'b@example.test', first: 'Bo', last: 'Off' })
    const c = await h.createUser({ email: 'c@example.test', first: 'Cy', last: 'Gone' })
    await setSchedule(a.employeeId, 1, true, 420, 1080) // starts 7:00, shop opens 8:00
    await setSchedule(a.employeeId, 2, true, 480, 1080) // fits
    await setSchedule(a.employeeId, 3, true, 480, 1140) // ends 7:00 PM
    await setSchedule(b.employeeId, 1, false, 420, 1080) // off: never a conflict
    await setSchedule(c.employeeId, 1, true, 420, 1080)
    await h.db
      .updateTable('employees')
      .set({ status: 'inactive', deactivated_at: h.clock.now() })
      .where('id', '=', c.employeeId)
      .execute()
    const out = await h.db
      .transaction()
      .execute((tx) => employeeScheduleConflicts(tx, { locationId: h.fx.locationId, days: week() }))
    expect(out.map((x) => `${x.employeeName} ${x.weekday}`)).toEqual(['Ana Active 1', 'Ana Active 3'])
    expect(out[0]!.message).toBe('Monday: availability must sit inside business hours (8:00 AM – 6:00 PM).')
    await setSchedule(a.employeeId, 4, true, 480, 1080)
    const closed = await h.db.transaction().execute((tx) =>
      employeeScheduleConflicts(tx, {
        locationId: h.fx.locationId,
        days: week({ 4: { isOpen: false, openMin: 480, closeMin: 1080 } }),
      }),
    )
    expect(closed.find((x) => x.weekday === 4)!.message).toBe(
      'Thursday: availability must sit inside business hours (closed).',
    )
  })

  it('ignores people linked only to another location', async () => {
    const a = await h.createUser({ email: 'a@example.test', first: 'Ana', last: 'Elsewhere' })
    await setSchedule(a.employeeId, 1, true, 420, 1080)
    const other = await makeLocation(h.db, createIdGenerator(h.clock))
    await h.db.deleteFrom('employee_locations').where('employee_id', '=', a.employeeId).execute()
    await h.db
      .insertInto('employee_locations')
      .values({ employee_id: a.employeeId, location_id: other.id })
      .execute()
    const mine = await h.db
      .transaction()
      .execute((tx) => employeeScheduleConflicts(tx, { locationId: h.fx.locationId, days: week() }))
    expect(mine.filter((x) => x.employeeName.startsWith('Ana'))).toEqual([])
    const theirs = await h.db
      .transaction()
      .execute((tx) => employeeScheduleConflicts(tx, { locationId: other.id, days: week() }))
    expect(theirs.map((x) => x.employeeName)).toEqual(['Ana Elsewhere'])
  })
})

describe('onShiftUsers', () => {
  it('includes active employees with a login whose schedule covers the instant, start inclusive and end exclusive', async () => {
    const a = await h.createUser({ email: 'a@example.test', first: 'Ana' })
    const b = await h.createUser({ email: 'b@example.test', first: 'Bo' })
    const c = await h.createUser({ email: 'c@example.test', first: 'Cy' })
    await setSchedule(a.employeeId, 6, true, 480, 1020)
    await setSchedule(b.employeeId, 6, true, 600, 1020) // starts at 10:00
    await setSchedule(c.employeeId, 6, true, 480, 1020)
    await h.db
      .updateTable('employees')
      .set({ status: 'inactive', deactivated_at: h.clock.now() })
      .where('id', '=', c.employeeId)
      .execute()
    const at = (iso: string) =>
      h.db
        .transaction()
        .execute((tx) =>
          onShiftUsers(tx, { locationId: h.fx.locationId, now: new Date(iso), tz: 'America/New_York' }),
        )
    expect((await at('2026-06-13T07:59:00-04:00')).map((x) => x.employeeId)).toEqual([])
    expect((await at('2026-06-13T08:00:00-04:00')).map((x) => x.employeeId)).toEqual([a.employeeId])
    expect((await at('2026-06-13T10:36:00-04:00')).map((x) => x.employeeId).sort()).toEqual(
      [a.employeeId, b.employeeId].sort(),
    )
    expect((await at('2026-06-13T17:00:00-04:00')).map((x) => x.employeeId)).toEqual([])
    expect((await at('2026-06-14T10:36:00-04:00')).map((x) => x.employeeId)).toEqual([])
  })
})

describe('AuditAccountNotifier', () => {
  it('reports "not delivered" and audits without writing the link', async () => {
    const notifier = new AuditAccountNotifier(h.db, h.fx.locationId)
    const link = 'http://localhost:3000/invite?token=SECRET-TOKEN-VALUE'
    const r = await notifier.deliver({
      kind: 'invite',
      employeeId: '0197b3f2-8d3c-7b1a-9c2e-1f2a3b4c5d6e',
      firstName: 'Kevin',
      phone: '+17865550151',
      email: null,
      link,
      expiresAt: new Date('2026-06-20T00:00:00Z'),
    })
    expect(r).toEqual({ delivered: false, channel: 'none' })
    const rows = await h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'account.invite.pending_delivery')
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      entity_type: 'employee',
      entity_id: '0197b3f2-8d3c-7b1a-9c2e-1f2a3b4c5d6e',
    })
    expect(JSON.stringify(rows[0])).not.toContain('SECRET-TOKEN-VALUE')
    expect(JSON.stringify(rows[0])).not.toContain('+17865550151')
    expect(rows[0]!.after).toMatchObject({
      kind: 'invite',
      plannedChannel: 'sms',
      expiresAt: '2026-06-20T00:00:00.000Z',
    })
  })
})
