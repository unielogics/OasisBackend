// The Team activity report (ADR 0180, wave K2b backend): GET /reports/employee-activity and the per-employee timeline. Counts across
// days, bay time, a voided payment never counted, amounts only with pay.reports, business-day edges in the shop's time zone, the 31-day
// limit, the cars drill-down and the paged timeline. Real kiosk flows where it matters, rows written directly for the day edges.
import { describe, expect, it } from 'vitest'
import type { StaffEventKind } from '../../src/modules/kiosk/schema.js'
import { reportRange } from '../../src/modules/kiosk/report.js'
import type { Session } from '../auth/harness.js'
import { kioskWorld as makeWorld, type KioskWorld } from './world.js'
import { idemKey, useRig } from '../scheduling-gaps/support.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const m = useRig()
const A = '/api/v1'
const db = () => m.h.t.db
const sup = () => m.superS()
const TZ = 'America/New_York'

type World = KioskWorld

const kioskWorld = (): Promise<World> => makeWorld(m.h)

const kiosk = (w: World, method: 'POST' | 'PUT', url: string, body: unknown = {}) =>
  m.h.kioskCall(method, `${A}/${url}`, w.kiosk, { actor: w.marco.employeeId, body, headers: { 'idempotency-key': idemKey() } })

const report = (s: Session, query: string) => m.get(s, `/reports/employee-activity?${query}`)

async function bay(n: number): Promise<string> {
  return (await db().selectFrom('bays').select('id').where('number', '=', n).executeTakeFirstOrThrow()).id
}

/** A staff_events row written directly at an instant (the day-edge and paging tests). */
async function event(o: { employeeId: string; kind: StaffEventKind; at: string; amountCents?: number; deviceId?: string; meta?: object }) {
  await db()
    .insertInto('staff_events')
    .values({
      location_id: m.locationId(),
      at: new Date(o.at),
      employee_id: o.employeeId,
      employee_name: 'Marco R.',
      kind: o.kind,
      amount_cents: o.amountCents ?? null,
      via: o.deviceId ? 'kiosk' : 'signed_in',
      kiosk_device_id: o.deviceId ?? null,
      meta: JSON.stringify(o.meta ?? {}) as never,
    })
    .execute()
}

const of = (body: Json, id: string): Json => (body.employees as Json[]).find((e) => e.id === id)!

describe('GET /reports/employee-activity', () => {
  it('counts a kiosk day: check-in, bay, finish, pickup, payment, text and bay time; amounts with pay.reports', async () => {
    const w = await kioskWorld()
    const v = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T14:00:00-04:00')
    expect((await kiosk(w, 'POST', `appointments/${v.appointmentId}/assign-bay`, { bayId: await bay(1) })).statusCode).toBe(200)
    m.h.clock.set('2026-06-13T11:18:30-04:00') // 42.5 minutes later
    expect((await kiosk(w, 'POST', `appointments/${v.appointmentId}/complete`)).statusCode).toBe(200)
    const paid = await kiosk(w, 'POST', `invoices/${v.invoiceId}/payments`, { method: 'cash' })
    expect(paid.statusCode, paid.body).toBe(201)
    const amount = (paid.json() as Json).event.amountCents as number
    expect((await kiosk(w, 'POST', `appointments/${v.appointmentId}/messages`, { text: 'All done, see you soon.' })).statusCode).toBe(201)
    expect((await kiosk(w, 'POST', `appointments/${v.appointmentId}/pickup`, { state: 'collected' })).statusCode).toBe(200)

    const r = await report(sup(), 'from=2026-06-13&to=2026-06-13')
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json() as Json
    expect(body).toMatchObject({ from: '2026-06-13', to: '2026-06-13', tz: TZ, amounts: true })
    const marco = of(body, w.marco.employeeId)
    expect(marco).toMatchObject({ name: 'Marco R.', initials: 'MR', status: 'active' })
    expect(marco.totals).toMatchObject({
      checkIns: 1,
      baysStarted: 1,
      completed: 1,
      pickedUp: 1,
      textsSent: 1,
      payments: { count: 1, amountCents: amount },
      bayMinutes: { total: 42, avg: 42, cars: 1 },
    })
    expect(marco.days).toEqual([{ date: '2026-06-13', ...marco.totals }])
    // everyone active at the shop is listed, with or without activity
    const amara = await db().selectFrom('users').select('employee_id').where('email', '=', 'amara@example.test').executeTakeFirstOrThrow()
    expect(of(body, amara.employee_id!).totals.completed).toBe(0)

    // without pay.reports: the counts, never the amounts
    const lead = (await m.h.userWithPermissions(['team.edit'], 'lead@example.test')).session
    const redacted = (await report(lead, 'from=2026-06-13&to=2026-06-13')).json() as Json
    expect(redacted.amounts).toBe(false)
    expect(of(redacted, w.marco.employeeId).totals.payments).toEqual({ count: 1, amountCents: null })
    expect(of(redacted, w.marco.employeeId).days[0].payments.amountCents).toBeNull()

    // the cars drill-down: each step and who did it
    const one = (await report(sup(), `from=2026-06-13&to=2026-06-13&employeeId=${w.marco.employeeId}`)).json() as Json
    expect(one.employees).toHaveLength(1)
    expect(one.cars).toHaveLength(1)
    expect(one.cars[0]).toMatchObject({
      appointmentId: v.appointmentId,
      customer: 'Maria Delgado',
      vehicle: 'Vehicle on file', // booked without a car
      date: '2026-06-13',
      worker: { id: w.marco.employeeId, name: 'Marco R.' },
      bayMinutes: 42,
      paidCents: amount,
    })
    // every step of the car, by whoever did it: the booking was the Super Admin's, signed in
    expect(one.cars[0].steps.map((s: Json) => s.kind)).toEqual(['book', 'worker_set', 'assign_bay', 'complete', 'payment', 'text', 'pickup'])
    expect(one.cars[0].steps[0]).toMatchObject({ via: 'signed_in' })
    expect(one.cars[0].steps[2]).toMatchObject({ by: 'Marco R.', via: 'kiosk' })
    const hidden = (await report(lead, `from=2026-06-13&to=2026-06-13&employeeId=${w.marco.employeeId}`)).json() as Json
    expect(hidden.cars[0].paidCents).toBeNull()
  })

  it('a voided payment is never counted', async () => {
    const v = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T14:00:00-04:00')
    await m.complete(v.appointmentId)
    const paid = await m.send(sup(), 'POST', `/invoices/${v.invoiceId}/payments`, { method: 'cash' })
    expect(paid.statusCode, paid.body).toBe(201)
    const amara = await db().selectFrom('users').select('employee_id').where('email', '=', 'amara@example.test').executeTakeFirstOrThrow()
    const before = of((await report(sup(), 'from=2026-06-13&to=2026-06-13')).json() as Json, amara.employee_id!)
    expect(before.totals.payments.count).toBe(1)
    const voided = await m.send(sup(), 'POST', `/invoices/${v.invoiceId}/void`, { eventId: (paid.json() as Json).event.id })
    expect(voided.statusCode, voided.body).toBeLessThan(300)
    const after = of((await report(sup(), 'from=2026-06-13&to=2026-06-13')).json() as Json, amara.employee_id!)
    expect(after.totals.payments).toEqual({ count: 0, amountCents: 0 })
  })

  it('counts each event on its business day in the shop’s time zone, and checklist ticks by task', async () => {
    const w = await kioskWorld()
    const e = w.marco.employeeId
    await event({ employeeId: e, kind: 'arrive', at: '2026-06-13T03:59:59Z' }) // June 12, 11:59:59 PM in New Jersey
    await event({ employeeId: e, kind: 'arrive', at: '2026-06-13T04:00:00Z' }) // June 13, midnight
    await event({ employeeId: e, kind: 'assign_bay', at: '2026-06-14T03:59:59Z', meta: { implicitArrival: true } }) // June 13, 11:59 PM
    await event({ employeeId: e, kind: 'assign_bay', at: '2026-06-14T04:00:00Z', meta: { implicitArrival: false } }) // June 14
    await event({ employeeId: e, kind: 'checklist', at: '2026-06-13T15:00:00Z', meta: { count: 6 } })
    await event({ employeeId: e, kind: 'checklist', at: '2026-06-14T15:00:00Z', meta: { count: 1 } })
    await event({ employeeId: e, kind: 'photo', at: '2026-06-14T15:00:00Z' })
    const day = of((await report(sup(), 'from=2026-06-13&to=2026-06-13')).json() as Json, e)
    expect(day.totals).toMatchObject({ checkIns: 2, baysStarted: 1, checklistTasks: 6, photos: 0 })
    const two = of((await report(sup(), 'from=2026-06-13&to=2026-06-14')).json() as Json, e)
    expect(two.totals).toMatchObject({ checkIns: 2, baysStarted: 2, checklistTasks: 7, photos: 1 })
    expect(two.days.map((d: Json) => [d.date, d.checkIns, d.baysStarted, d.checklistTasks])).toEqual([
      ['2026-06-13', 2, 1, 6],
      ['2026-06-14', 0, 1, 1],
    ])
    const before = of((await report(sup(), 'from=2026-06-12&to=2026-06-12')).json() as Json, e)
    expect(before.totals.checkIns).toBe(1)
  })

  it('answers at most 31 days, and refuses a bad range, an unknown employee and anyone without team.edit', async () => {
    expect((await report(sup(), 'from=2026-05-14&to=2026-06-13')).statusCode).toBe(200)
    const long = await report(sup(), 'from=2026-05-13&to=2026-06-13')
    expect(long.statusCode).toBe(422)
    expect((long.json() as Json).errors[0]).toMatchObject({ path: 'to', message: 'Pick at most 31 days.' })
    const backwards = await report(sup(), 'from=2026-06-13&to=2026-06-12')
    expect(backwards.statusCode).toBe(422)
    expect((await report(sup(), 'from=2026-02-30&to=2026-03-01')).statusCode).toBe(422)
    expect((await report(sup(), `from=2026-06-13&to=2026-06-13&employeeId=${m.h.t.app.newId()}`)).statusCode).toBe(404)
    const crew = (await m.h.userWithPermissions(['sched.view', 'pay.reports'], 'crew2@example.test')).session
    expect((await report(crew, 'from=2026-06-13&to=2026-06-13')).statusCode).toBe(403)
  })

  it('a kiosk cannot read the report', async () => {
    const w = await kioskWorld()
    const r = await m.h.kioskCall('GET', `${A}/reports/employee-activity?from=2026-06-13&to=2026-06-13`, w.kiosk)
    expect(r.statusCode).toBe(403)
    expect((r.json() as Json).code).toBe('KIOSK_FORBIDDEN')
  })

  it('the range is whole business days in the time zone, across a daylight-saving change', () => {
    const r = reportRange('2026-11-01', '2026-11-01', TZ)
    expect(r.start.toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(r.end.toISOString()).toBe('2026-11-02T05:00:00.000Z') // 25 hours
    expect(() => reportRange('2026-01-01', '2026-01-31', TZ)).not.toThrow()
    expect(() => reportRange('2026-01-01', '2026-02-01', TZ)).toThrow()
  })
})

describe('GET /reports/employee-activity/:employeeId/events', () => {
  it('pages the timeline newest first, with the device, and amounts only with pay.reports', async () => {
    const w = await kioskWorld()
    const e = w.marco.employeeId
    for (let i = 0; i < 55; i++)
      await event({ employeeId: e, kind: 'payment', amountCents: 100 + i, at: new Date(Date.UTC(2026, 5, 13, 13, i)).toISOString(), deviceId: w.device.id })
    const url = `/reports/employee-activity/${e}/events?from=2026-06-13&to=2026-06-13`
    const first = (await m.get(sup(), url)).json() as Json
    expect(first.items).toHaveLength(50)
    expect(first.items[0]).toMatchObject({ kind: 'payment', via: 'kiosk', deviceName: w.device.name, amountCents: 154, at: '2026-06-13T13:54:00.000Z' })
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = (await m.get(sup(), `${url}&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as Json
    expect(second.items.map((x: Json) => x.amountCents)).toEqual([104, 103, 102, 101, 100])
    expect(second.nextCursor).toBeNull()
    const lead = (await m.h.userWithPermissions(['team.edit'], 'lead2@example.test')).session
    const redacted = (await m.get(lead, url)).json() as Json
    expect(redacted.items.every((x: Json) => x.amountCents === null)).toBe(true)
    expect((await m.get(sup(), `${url}&cursor=nonsense`)).statusCode).toBe(422)
    expect((await m.get(sup(), `/reports/employee-activity/${m.h.t.app.newId()}/events?from=2026-06-13&to=2026-06-13`)).statusCode).toBe(404)
    expect((await m.get(sup(), `/reports/employee-activity/${e}/events?from=2026-05-01&to=2026-06-13`)).statusCode).toBe(422)
  })
})
