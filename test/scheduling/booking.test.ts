// POST /appointments at the service level: customer and vehicle upsert, the slot guard with its copy, overrides, the
// same-day guarantee, walk-ins, checklist snapshot with stable ids, invoice numbering, auto-planned bay.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import { putChecklist } from '../../src/modules/catalog/service.js'
import { createAppointment } from '../../src/modules/scheduling/booking.js'
import { ALL, useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`

const err = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof AppError) return e
    throw e
  }
  throw new Error('expected an AppError')
}

describe('creating an appointment', () => {
  it('upserts the customer by phone and the vehicle by plate, snapshots the invoice and the checklist', async () => {
    const actor = await o.actor()
    const r = await o.tx((tx) =>
      createAppointment(tx, o.ctx, actor, {
        customer: { name: 'Zed New', phone: '(305) 555-0177', smsOptIn: true },
        vehicle: { year: 2020, make: 'Kia', model: 'Soul', color: 'Red', plate: 'abc-777' },
        serviceId: o.svc('Premium Hand Wash + Interior').id,
        addonIds: [o.svc('Wax').id, o.svc('Rain repellent').id],
        start: new Date(at('14:30')),
      }),
    )
    expect(r.customer).toMatchObject({ name: 'Zed New', created: true })
    expect(r.toast).toEqual({ title: 'Appointment booked', detail: 'Premium Hand Wash + Interior · 2:30 PM' })
    const cust = await o.t.db
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', r.customer.id)
      .executeTakeFirstOrThrow()
    expect(cust).toMatchObject({ phone_e164: '+13055550177', sms_opted_in: true, needs_details: false })
    const veh = await o.t.db
      .selectFrom('vehicles')
      .selectAll()
      .where('customer_id', '=', r.customer.id)
      .execute()
    expect(veh).toHaveLength(1)
    expect(veh[0]).toMatchObject({ plate: 'ABC-777', make: 'Kia' })

    // a second booking with the same phone and plate reuses both
    const again = await o.tx((tx) =>
      createAppointment(tx, o.ctx, actor, {
        customer: { name: 'Zed New', phone: '305-555-0177' },
        vehicle: { plate: 'ABC-777' },
        serviceId: o.svc('Express Hand Wash').id,
        start: new Date(at('16:00')),
      }),
    )
    expect(again.customer).toMatchObject({ id: r.customer.id, created: false })
    expect(
      await o.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', r.customer.id).execute(),
    ).toHaveLength(1)

    // the invoice: package + add-ons, 7% half-up, numbered from 20611 without gaps
    expect(r.invoice).toMatchObject({
      invoiceNo: 20611,
      subtotalCents: 12900 + 4000 + 2500,
      status: 'unpaid',
    })
    expect(r.invoice.taxCents).toBe(Math.round((19400 * 7) / 100))
    expect(again.invoice.invoiceNo).toBe(20612)
    expect(r.invoice.items.map((i) => i.name)).toEqual([
      'Premium Hand Wash + Interior',
      'Wax',
      'Rain repellent',
    ])

    // the checklist: 7 package tasks then 2 + 2 add-on tasks, with stable ids and positions
    const items = await o.t.db
      .selectFrom('job_checklist_items')
      .select(['section_kind', 'section_title', 'label', 'position', 'source_task_id'])
      .where('appointment_id', '=', r.appointment.id)
      .orderBy('position')
      .execute()
    expect(items).toHaveLength(11)
    expect(items.map((i) => i.position)).toEqual([...Array(11).keys()])
    expect(
      items
        .slice(0, 7)
        .every(
          (i) =>
            i.section_kind === 'package' &&
            i.section_title === 'Premium Hand Wash + Interior' &&
            i.source_task_id !== null,
        ),
    ).toBe(true)
    expect(items.slice(7).map((i) => i.section_title)).toEqual([
      'Wax',
      'Wax',
      'Rain repellent',
      'Rain repellent',
    ])
  })

  it('records the activity, queues the booking SMS, audits and publishes', async () => {
    const r = await o.book({ at: at('14:30') })
    expect(o.queue.messages.at(-1)).toMatchObject({
      templateKey: 'booking_thanks',
      body: 'Hi Maria, thanks for booking with Oasis Auto Spa.',
    })
    const log = await o.t.db
      .selectFrom('activity_log')
      .select(['text', 'channels'])
      .where('appointment_id', '=', r.appointment.id)
      .orderBy('id')
      .execute()
    expect(log).toEqual([
      { text: 'Booking created', channels: ['system'] },
      { text: 'Booking thanks sent', channels: ['sms'] },
    ])
    const ev = await sql<{
      type: string
      payload: Record<string, unknown>
    }>`select type, payload from realtime_events order by id`.execute(o.t.db)
    expect(ev.rows.map((e) => e.type)).toEqual(['appointment.updated', 'availability.changed', 'kpi.dirty'])
    expect(ev.rows[0]!.payload).toMatchObject({ id: r.appointment.id, change: 'created', status: 'booked' })
    expect(ev.rows[1]!.payload).toEqual({ date: '2026-06-13' })
    expect(
      (
        await sql<{
          n: number
        }>`select count(*)::int as n from audit_log where action = 'appointment.create'`.execute(o.t.db)
      ).rows[0]!.n,
    ).toBe(1)
  })

  it('template edits after booking never touch the snapshot (ids, not labels)', async () => {
    const r = await o.book({ at: at('14:30'), serviceName: 'Express Hand Wash' })
    const pkg = o.svc('Express Hand Wash')
    await o
      .tx((tx) =>
        putChecklist(tx, {
          locationId: o.locationId,
          serviceId: pkg.id,
          tasks: pkg.tasks.map((t, i) => ({ id: t.id, label: i === 0 ? 'Renamed task' : t.label })),
        } as never),
      )
      .catch(() => undefined)
    const labels = await o.t.db
      .selectFrom('job_checklist_items')
      .select('label')
      .where('appointment_id', '=', r.appointment.id)
      .orderBy('position')
      .execute()
    expect(labels.map((l) => l.label)).toEqual(pkg.tasks.map((t) => t.label))
  })

  it('a walk-in starts at the next slot on the grid and needs no phone', async () => {
    const actor = await o.actor()
    o.clock.set(at('10:36'))
    const r = await o.tx((tx) =>
      createAppointment(tx, o.ctx, actor, {
        customer: { name: 'Pat Walkin' },
        serviceId: o.svc('Express Hand Wash').id,
        walkIn: true,
      }),
    )
    expect(r.appointment.scheduledStart).toBe(new Date(at('11:00')).toISOString())
    const c = await o.t.db
      .selectFrom('customers')
      .select(['needs_details', 'source', 'phone_e164'])
      .where('id', '=', r.customer.id)
      .executeTakeFirstOrThrow()
    expect(c).toEqual({ needs_details: true, source: 'walk_in', phone_e164: null })
    expect(
      (
        await o.t.db
          .selectFrom('appointments')
          .select('source')
          .where('id', '=', r.appointment.id)
          .executeTakeFirstOrThrow()
      ).source,
    ).toBe('walk_in')
  })

  it('validates its input: start xor walkIn, a phone for a scheduled booking, real packages and add-ons', async () => {
    const actor = await o.actor()
    const base = { customer: { id: o.customer('Maria Delgado') }, serviceId: o.svc('Express Hand Wash').id }
    const bad = (extra: object) =>
      err(o.tx((tx) => createAppointment(tx, o.ctx, actor, { ...base, ...extra } as never)))
    expect((await bad({})).errors?.[0]?.path).toBe('start')
    expect((await bad({ start: new Date(at('14:00')), walkIn: true })).code).toBe('VALIDATION_FAILED')
    expect((await bad({ start: new Date(at('14:00')), serviceId: o.svc('Wax').id })).errors?.[0]?.path).toBe(
      'serviceId',
    )
    expect(
      (await bad({ start: new Date(at('14:00')), addonIds: [o.svc('Full Detail').id] })).errors?.[0]?.path,
    ).toBe('addonIds')
    const noPhone = await err(
      o.tx((tx) =>
        createAppointment(tx, o.ctx, actor, {
          customer: { name: 'No Phone' },
          serviceId: base.serviceId,
          start: new Date(at('14:00')),
        }),
      ),
    )
    expect(noPhone.errors?.[0]?.path).toBe('customer.phone')
  })

  it('plans the bay with the fewest overlapping jobs (lowest number on a tie) when auto-plan is on', async () => {
    const a = await o.book({ at: at('14:00') })
    const b = await o.book({ at: at('14:00'), customerName: 'David Okafor' })
    const c = await o.book({ at: at('14:00'), customerName: 'Priya Nair' }).catch((e: unknown) => e)
    expect([a.appointment.plannedBay?.number, b.appointment.plannedBay?.number]).toEqual([1, 2])
    expect(c).toBeInstanceOf(AppError) // both bays taken: the guard refuses a third
    await sql`update booking_rules set auto_plan_bay = false`.execute(o.t.db)
    const d = await o.book({ at: at('16:00') })
    expect(d.appointment.plannedBay).toBeNull()
    await sql`update booking_rules set auto_plan_bay = true`.execute(o.t.db)
  })
})

describe('the slot guard', () => {
  it('a full slot is 409 SLOT_UNAVAILABLE with the design copy and no side effects', async () => {
    await o.book({ at: at('14:00') })
    await o.book({ at: at('14:00'), customerName: 'David Okafor' })
    const before = (await sql<{ n: number }>`select count(*)::int as n from appointments`.execute(o.t.db))
      .rows[0]!.n
    const e = await err(o.book({ at: at('14:30'), customerName: 'Priya Nair' }))
    expect(e).toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      status: 409,
      title: 'Slot unavailable',
      detail: 'Would overbook a bay — override required',
    })
    expect(
      (await sql<{ n: number }>`select count(*)::int as n from appointments`.execute(o.t.db)).rows[0]!.n,
    ).toBe(before)
    expect(o.gateway.calls.filter((c) => c.method === 'ensureForAppointment')).toHaveLength(2)
  })

  it('a VIP hold: "Held for VIP clients" until release hours before; VIP clients book it now', async () => {
    // Saturday 2026-06-20 8:00 AM is held (release 48 h): booking it on Thursday 6/18 07:59 is refused for a regular client
    o.clock.set(at('07:59', '2026-06-18'))
    const e = await err(o.book({ at: at('08:00', '2026-06-20') }))
    expect(e).toMatchObject({
      code: 'SLOT_VIP_HELD',
      title: 'Held for VIP clients',
      detail: 'Releases to everyone 48h before · VIP clients can book it now',
    })
    await o.book({ at: at('08:00', '2026-06-20'), customerName: 'Jonathan Franco' }) // a VIP client
    o.clock.set(at('08:00', '2026-06-18'))
    await o.book({ at: at('08:00', '2026-06-20') }) // released
  })

  it('an override needs sched.override and a reason, is audited and written to appointment_overrides', async () => {
    o.clock.set(at('07:59', '2026-06-18'))
    const start = new Date(at('08:00', '2026-06-20'))
    const noPerm = await o.actor(ALL.filter((p) => p !== 'sched.override'))
    expect(
      (await err(o.book({ at: at('08:00', '2026-06-20'), actor: noPerm, override: { reason: 'Regular' } })))
        .code,
    ).toBe('OVERRIDE_NOT_ALLOWED')
    expect((await err(o.book({ at: at('08:00', '2026-06-20'), override: { reason: '  ' } }))).code).toBe(
      'OVERRIDE_REASON_REQUIRED',
    )
    const r = await o.book({ at: at('08:00', '2026-06-20'), override: { reason: 'Owner asked' } })
    expect(r.overrides).toEqual([{ kind: 'vip_hold', reason: 'Owner asked' }])
    expect(r.appointment.scheduledStart).toBe(start.toISOString())
    const rows = await o.t.db
      .selectFrom('appointment_overrides')
      .select(['kind', 'reason', 'employee_id'])
      .where('appointment_id', '=', r.appointment.id)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'vip_hold', reason: 'Owner asked' })
    expect(rows[0]!.employee_id).not.toBeNull()
    const audit = await sql<{
      after: { overrides: { kind: string }[] }
    }>`select after from audit_log where action = 'appointment.create'`.execute(o.t.db)
    expect(audit.rows[0]!.after.overrides).toEqual([{ kind: 'vip_hold', reason: 'Owner asked' }])
  })

  it('a VIP client may use the same-day guarantee on a full slot, twice a month, without the permission', async () => {
    const noOverride = await o.actor(ALL.filter((p) => p !== 'sched.override'))
    o.clock.set(at('08:00'))
    const fill = async (hhmm: string) => {
      await o.book({ at: at(hhmm), customerName: 'Maria Delgado' })
      await o.book({ at: at(hhmm), customerName: 'David Okafor' })
    }
    for (const hhmm of ['14:00', '15:00']) {
      await fill(hhmm)
      const r = await o.book({ at: at(hhmm), customerName: 'Jonathan Franco', actor: noOverride })
      expect(r.overrides).toEqual([
        { kind: 'same_day_guarantee', reason: 'Same-day guarantee for a VIP client' },
      ])
    }
    await fill('16:00')
    expect(
      (await err(o.book({ at: at('16:00'), customerName: 'Jonathan Franco', actor: noOverride }))).code,
    ).toBe('SLOT_UNAVAILABLE')
    // a regular client never gets the guarantee
    expect(
      (await err(o.book({ at: at('15:00'), customerName: 'Tom Bradley', actor: noOverride }))).code,
    ).toBe('SLOT_UNAVAILABLE')
  })

  it('past slots are never bookable, even with an override', async () => {
    o.clock.set(at('10:36'))
    expect((await err(o.book({ at: at('10:00'), override: { reason: 'x' } }))).code).toBe('SLOT_PAST')
  })

  it('closed today (emergency) blocks the booking: "Shop is closed" and needs an override', async () => {
    const id = o.ctx.newId()
    await sql`insert into emergency_closures (id, location_id, active, reason, duration_kind, through_date, message, summary, started_at)
      values (${id}, ${o.locationId}, true, 'severe_weather', 'today', '2026-06-13', '', 'Emergency closure', ${o.clock.now()})`.execute(
      o.t.db,
    )
    try {
      const e = await err(o.book({ at: at('14:00') }))
      expect(e).toMatchObject({ code: 'SLOT_CLOSED', title: 'Shop is closed' })
      const r = await o.book({ at: at('14:00'), override: { reason: 'Owner opened the bay' } })
      expect(r.overrides[0]!.kind).toBe('closure')
    } finally {
      await sql`delete from emergency_closures where id = ${id}`.execute(o.t.db)
    }
  })

  it('outside reduced hours or past the cutoff: "Outside opening hours"', async () => {
    const e = await err(o.book({ at: at('16:30') })) // Saturday: last start 4:00 PM
    expect(e).toMatchObject({ code: 'SLOT_OUTSIDE_HOURS', title: 'Outside opening hours' })
    expect(e.detail).toContain('4:00 PM')
  })
})
