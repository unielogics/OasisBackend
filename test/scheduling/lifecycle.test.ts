// Every transition and guard of the appointment state machine, with the design's exact toast strings.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import { updateSetting } from '../../src/platform/settings.js'
import { setChecklistItem } from '../../src/modules/scheduling/checklist.js'
import {
  advanceAppointment,
  arriveAppointment,
  assignToBay,
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  markNoShow,
  notifyReady,
  prepBay,
  reopenAppointment,
  rescheduleAppointment,
  setPickup,
  startCleaning,
  updateDetails,
} from '../../src/modules/scheduling/lifecycle.js'
import { ALL, useOps } from './helpers.js'

const o = useOps()
const TODAY = '2026-06-13'
const at = (hhmm: string, date = TODAY): string => `${date}T${hhmm}:00-04:00`

const err = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p
  } catch (e) {
    if (e instanceof AppError) return e
    throw e
  }
  throw new Error('expected an AppError')
}

async function row(id: string) {
  return o.t.db.selectFrom('appointments').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}
async function activity(id: string) {
  return o.t.db.selectFrom('activity_log').select(['text', 'channels']).where('appointment_id', '=', id).orderBy('id').execute()
}
async function events(type: string) {
  const r = await sql<{ payload: Record<string, unknown> }>`select payload from realtime_events where type = ${type} order by id`.execute(o.t.db)
  return r.rows.map((x) => x.payload)
}
async function audits(action: string) {
  const r = await sql<{ n: number }>`select count(*)::int as n from audit_log where action = ${action}`.execute(o.t.db)
  return r.rows[0]!.n
}

const run = async <T>(fn: (tx: Parameters<Parameters<typeof o.tx>[0]>[0], actor: Awaited<ReturnType<typeof o.actor>>) => Promise<T>, perms = ALL) => {
  const actor = await o.actor(perms)
  return o.tx((tx) => fn(tx, actor))
}

describe('confirm', () => {
  it('booked to confirmed: queues "confirmed", logs, audits, publishes, bumps the version', async () => {
    const b = await o.book({ at: at('14:00') })
    const r = await run((tx, a) => confirmAppointment(tx, o.ctx, a, b.appointment.id))
    expect(r.appointment.status).toBe('confirmed')
    expect(r.appointment.version).toBe(b.appointment.version + 1)
    expect(r.toast).toEqual({ title: 'Confirmation sent', detail: 'Reminder via SMS' })
    expect(o.queue.messages.map((m) => [m.templateKey, m.body])).toContainEqual(['confirmed', 'Your appointment is confirmed for 2:00 PM.'])
    expect(await activity(b.appointment.id)).toContainEqual({ text: 'Confirmation + reminder sent', channels: ['sms'] })
    expect(await audits('appointment.confirm')).toBe(1)
    expect((await events('appointment.updated')).at(-1)).toMatchObject({ id: b.appointment.id, status: 'confirmed', change: 'confirmed' })
  })

  it('says tomorrow for another day, and notes a message the SMS policy refused', async () => {
    const b = await o.book({ at: at('09:00', '2026-06-14') })
    o.queue.clear()
    o.queue.skipWhen = () => 'opted_out'
    await run((tx, a) => confirmAppointment(tx, o.ctx, a, b.appointment.id))
    expect(o.queue.messages).toHaveLength(0)
    expect((await activity(b.appointment.id)).at(-1)!.text).toBe('Confirmation + reminder sent (not sent: customer opted out of SMS)')
  })

  it('only a booked job, and only with sched.edit or jobs.status', async () => {
    const b = await o.book({ at: at('14:00') })
    await run((tx, a) => confirmAppointment(tx, o.ctx, a, b.appointment.id))
    const e = await err(run((tx, a) => confirmAppointment(tx, o.ctx, a, b.appointment.id)))
    expect(e).toMatchObject({ code: 'INVALID_TRANSITION', status: 409, title: 'Can’t do that now', detail: 'This job is confirmed', meta: { currentStatus: 'confirmed' } })
    const c = await o.book({ at: at('15:00'), customerName: 'David Okafor' })
    const denied = await err(run((tx, a) => confirmAppointment(tx, o.ctx, a, c.appointment.id), ['sched.view', 'cli.view']))
    expect(denied).toMatchObject({ code: 'FORBIDDEN', status: 403 })
    await run((tx, a) => confirmAppointment(tx, o.ctx, a, c.appointment.id), ['jobs.status'])
  })
})

describe('arrive', () => {
  it('manual: arrived_at set, ETA cleared, "Arrival logged", no message', async () => {
    const id = await o.insert({ customerName: 'Liam Chen', serviceName: 'Express Hand Wash', at: at('10:45'), status: 'confirmed', etaMinutes: 12, plannedBay: 1 })
    const r = await run((tx, a) => arriveAppointment(tx, o.ctx, a, id))
    expect(r.toast).toEqual({ title: 'Marked arrived', detail: 'Internal team notified' })
    const db = await row(id)
    expect(db.status).toBe('arrived')
    expect(db.eta_minutes).toBeNull()
    expect(db.arrived_at).toEqual(o.clock.now())
    expect(db.geo_checked_in_at).toBeNull()
    expect(o.queue.messages).toHaveLength(0)
    expect(await activity(id)).toContainEqual({ text: 'Arrival logged', channels: ['internal'] })
  })

  it('geofence: records the check-in and sends the welcome with the planned bay', async () => {
    const id = await o.insert({ customerName: 'Liam Chen', serviceName: 'Express Hand Wash', at: at('10:45'), status: 'confirmed', etaMinutes: 12, plannedBay: 2 })
    const r = await run((tx, a) => arriveAppointment(tx, o.ctx, a, id, { source: 'geofence' }))
    expect(r.toast).toEqual({ title: 'Checked in automatically', detail: 'Liam Chen · welcome message sent' })
    expect((await row(id)).geo_checked_in_at).toEqual(o.clock.now())
    expect(o.queue.messages.at(-1)).toMatchObject({ templateKey: 'welcome', body: 'Welcome to Oasis! You’re checked in — pull into Bay 2.' })
    expect((await activity(id)).at(-1)).toEqual({ text: 'Auto check-in · geofence', channels: ['automation'] })
  })

  it('omits the bay segment when no bay is planned', async () => {
    const id = await o.insert({ customerName: 'Liam Chen', serviceName: 'Express Hand Wash', at: at('10:45'), status: 'booked' })
    await run((tx, a) => arriveAppointment(tx, o.ctx, a, id, { source: 'geofence' }))
    expect(o.queue.messages.at(-1)!.body).toBe('Welcome to Oasis! You’re checked in.')
  })

  it('rejects an arrived or finished job', async () => {
    const id = await o.insert({ customerName: 'Liam Chen', serviceName: 'Express Hand Wash', at: at('10:45'), status: 'arrived' })
    expect((await err(run((tx, a) => arriveAppointment(tx, o.ctx, a, id)))).code).toBe('INVALID_TRANSITION')
  })
})

describe('start (arrived to cleaning)', () => {
  const arrived = (n = 'Maria Delgado', plannedBay: number | null = null, time = '10:30') =>
    o.insert({ customerName: n, serviceName: 'Express Hand Wash', at: at(time), status: 'arrived', plannedBay })

  it('uses the planned bay, sets the clock, queues in_progress and publishes bay.changed', async () => {
    const id = await arrived('Maria Delgado', 2)
    const r = await run((tx, a) => startCleaning(tx, o.ctx, a, id))
    expect(r.appointment).toMatchObject({ status: 'cleaning', bay: { number: 2 } })
    expect(r.toast).toEqual({ title: 'Cleaning started', detail: 'In-progress message sent' })
    const db = await row(id)
    expect(db.bay_id).toBe(o.bay(2))
    expect(db.cleaning_started_at).toEqual(o.clock.now())
    expect(o.queue.messages.at(-1)).toMatchObject({ templateKey: 'in_progress', body: 'Good news — your vehicle is now being cleaned.' })
    expect((await events('bay.changed')).at(-1)).toEqual({ bayId: o.bay(2) })
  })

  it('no planned bay: the lowest-numbered free active bay; an explicit bay wins', async () => {
    const a = await arrived('Maria Delgado')
    expect((await run((tx, x) => startCleaning(tx, o.ctx, x, a))).appointment.bay?.number).toBe(1)
    const b = await arrived('David Okafor', 1)
    // planned bay 1 is busy now: falls to the free one
    expect((await run((tx, x) => startCleaning(tx, o.ctx, x, b))).appointment.bay?.number).toBe(2)
  })

  it('an explicit busy bay: "Bay N is busy" / "Finish {First}’s vehicle first"', async () => {
    const a = await arrived('Maria Delgado', 1)
    await run((tx, x) => startCleaning(tx, o.ctx, x, a))
    const b = await arrived('David Okafor')
    const e = await err(run((tx, x) => startCleaning(tx, o.ctx, x, b, { bayId: o.bay(1) })))
    expect(e).toMatchObject({ code: 'BAY_BUSY', status: 409, title: 'Bay 1 is busy', detail: 'Finish Maria’s vehicle first' })
  })

  it('every bay busy: BAY_BUSY on the planned bay; no active bay: NO_BAY_FREE; maintenance: BAY_UNAVAILABLE', async () => {
    const a = await arrived('Maria Delgado', 1)
    const b = await arrived('David Okafor', 2)
    await run((tx, x) => startCleaning(tx, o.ctx, x, a))
    await run((tx, x) => startCleaning(tx, o.ctx, x, b))
    const c = await arrived('Priya Nair', 2)
    expect(await err(run((tx, x) => startCleaning(tx, o.ctx, x, c)))).toMatchObject({ code: 'BAY_BUSY', title: 'Bay 2 is busy', detail: 'Finish David’s vehicle first' })
    await o.t.db.updateTable('bays').set({ status: 'maintenance' }).execute()
    expect(await err(run((tx, x) => startCleaning(tx, o.ctx, x, c)))).toMatchObject({ code: 'NO_BAY_FREE', title: 'No bay free' })
    await o.t.db.updateTable('bays').set({ status: 'maintenance' }).where('number', '=', 1).execute()
    await o.t.db.updateTable('bays').set({ status: 'active' }).where('number', '=', 2).execute()
    await o.t.db.updateTable('appointments').set({ status: 'completed', completed_at: o.clock.now() }).where('id', '=', b).execute()
    expect(await err(run((tx, x) => startCleaning(tx, o.ctx, x, c, { bayId: o.bay(1) })))).toMatchObject({ code: 'BAY_UNAVAILABLE', title: 'Bay 1 is unavailable' })
  })

  it('only an arrived job; a job already in a bay says which', async () => {
    const booked = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('14:00') })
    expect((await err(run((tx, x) => startCleaning(tx, o.ctx, x, booked)))).code).toBe('INVALID_TRANSITION')
    const a = await arrived('David Okafor', 1)
    await run((tx, x) => startCleaning(tx, o.ctx, x, a))
    expect(await err(run((tx, x) => startCleaning(tx, o.ctx, x, a)))).toMatchObject({ code: 'ALREADY_IN_BAY', title: 'Already in a bay', detail: 'That vehicle is in Bay 1' })
  })

  it('needs jobs.status', async () => {
    const a = await arrived()
    expect((await err(run((tx, x) => startCleaning(tx, o.ctx, x, a), ['sched.edit', 'sched.view']))).code).toBe('FORBIDDEN')
  })
})

describe('assign-bay (drag onto a bay)', () => {
  it('booked or confirmed arrive implicitly, both steps logged; toast names the bay', async () => {
    const id = await o.insert({ customerName: 'Marcus Webb', serviceName: 'Family Wash + Pet Hair', at: at('10:15'), status: 'confirmed' })
    const r = await run((tx, a) => assignToBay(tx, o.ctx, a, id, { bayId: o.bay(2) }))
    expect(r.toast).toEqual({ title: 'Moved to Bay 2', detail: 'Marcus Webb · cleaning started' })
    const db = await row(id)
    expect(db).toMatchObject({ status: 'cleaning', bay_id: o.bay(2) })
    expect(db.arrived_at).not.toBeNull()
    expect((await activity(id)).map((x) => x.text)).toEqual(['Arrival logged', 'Assigned to Bay 2 · cleaning started'])
    expect(o.queue.messages.at(-1)!.templateKey).toBe('in_progress')
  })

  it('guards in the design order: already in a bay, busy bay, then the new ones (not today, bay out of service)', async () => {
    const first = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:30'), status: 'arrived' })
    await run((tx, a) => assignToBay(tx, o.ctx, a, first, { bayId: o.bay(1) }))
    expect(await err(run((tx, a) => assignToBay(tx, o.ctx, a, first, { bayId: o.bay(2) })))).toMatchObject({
      code: 'ALREADY_IN_BAY',
      title: 'Already in a bay',
      detail: 'That vehicle is in Bay 1',
    })
    const second = await o.insert({ customerName: 'David Okafor', serviceName: 'Express Hand Wash', at: at('11:00'), status: 'booked' })
    expect(await err(run((tx, a) => assignToBay(tx, o.ctx, a, second, { bayId: o.bay(1) })))).toMatchObject({
      code: 'BAY_BUSY',
      title: 'Bay 1 is busy',
      detail: 'Finish Maria’s vehicle first',
    })
    const tomorrow = await o.insert({ customerName: 'Priya Nair', serviceName: 'Express Hand Wash', at: at('09:00', '2026-06-14'), status: 'confirmed' })
    expect(await err(run((tx, a) => assignToBay(tx, o.ctx, a, tomorrow, { bayId: o.bay(2) })))).toMatchObject({ code: 'NOT_TODAY', title: 'Not today' })
    await o.t.db.updateTable('bays').set({ status: 'blocked' }).where('number', '=', 2).execute()
    expect(await err(run((tx, a) => assignToBay(tx, o.ctx, a, second, { bayId: o.bay(2) })))).toMatchObject({ code: 'BAY_UNAVAILABLE', title: 'Bay 2 is unavailable' })
  })

  it('a finished job cannot be dragged', async () => {
    const done = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('08:30'), status: 'completed', completedAt: at('09:10') })
    expect((await err(run((tx, a) => assignToBay(tx, o.ctx, a, done, { bayId: o.bay(1) })))).code).toBe('INVALID_TRANSITION')
  })
})

describe('complete', () => {
  it('checks the remaining tasks (system), sets the pickup, queues ready and frees the bay', async () => {
    const b = await o.book({ at: at('11:00'), serviceName: 'Express Hand Wash', addonIds: [o.svc('Wax').id] })
    await run((tx, a) => arriveAppointment(tx, o.ctx, a, b.appointment.id))
    await run((tx, a) => startCleaning(tx, o.ctx, a, b.appointment.id, { bayId: o.bay(1) }))
    const some = await o.t.db.selectFrom('job_checklist_items').select('id').where('appointment_id', '=', b.appointment.id).orderBy('position').limit(2).execute()
    await run(async (tx, a) => {
      for (const item of some) await setChecklistItem(tx, o.ctx, a, b.appointment.id, item.id, true)
    })
    o.clock.advance(35 * 60_000)
    const r = await run((tx, a) => completeAppointment(tx, o.ctx, a, b.appointment.id))
    expect(r.toast).toEqual({ title: 'Job completed', detail: 'Ready-for-pickup sent · moved to pickup' })
    const db = await row(b.appointment.id)
    expect(db).toMatchObject({ status: 'completed', pickup_state: 'pending' })
    expect(db.completed_at).toEqual(o.clock.now())
    expect(db.ready_notified_at).toEqual(o.clock.now())
    const items = await o.t.db.selectFrom('job_checklist_items').select(['done', 'done_by_employee_id']).where('appointment_id', '=', b.appointment.id).execute()
    expect(items).toHaveLength(7)
    expect(items.every((i) => i.done)).toBe(true)
    expect(items.filter((i) => i.done_by_employee_id === null)).toHaveLength(5) // the system checked five, two people two
    expect(o.queue.messages.at(-1)).toMatchObject({ templateKey: 'ready', body: 'Your vehicle is ready for pickup!' })
    expect((await activity(b.appointment.id)).map((x) => x.text)).toContain('5 remaining checklist tasks marked done on completion')
    // the bay is free again
    const next = await o.insert({ customerName: 'David Okafor', serviceName: 'Express Hand Wash', at: at('11:30'), status: 'arrived' })
    expect((await run((tx, a) => startCleaning(tx, o.ctx, a, next, { bayId: o.bay(1) }))).appointment.bay?.number).toBe(1)
  })

  it('only a job in a bay', async () => {
    const id = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:30'), status: 'arrived' })
    expect((await err(run((tx, a) => completeAppointment(tx, o.ctx, a, id)))).code).toBe('INVALID_TRANSITION')
  })
})

describe('advance (expectedStatus)', () => {
  it('walks booked, confirmed, arrived, cleaning in one transaction each', async () => {
    const b = await o.book({ at: at('10:40') })
    const id = b.appointment.id
    const seen: string[] = []
    for (const expected of ['booked', 'confirmed', 'arrived', 'cleaning'] as const) {
      const r = await run((tx, a) => advanceAppointment(tx, o.ctx, a, id, { expectedStatus: expected }))
      seen.push(r.appointment.status)
    }
    expect(seen).toEqual(['confirmed', 'arrived', 'cleaning', 'completed'])
  })

  it('a stale screen gets 409 STALE_STATE with the current status and does nothing', async () => {
    const b = await o.book({ at: at('10:40') })
    await run((tx, a) => confirmAppointment(tx, o.ctx, a, b.appointment.id))
    const e = await err(run((tx, a) => advanceAppointment(tx, o.ctx, a, b.appointment.id, { expectedStatus: 'booked' })))
    expect(e).toMatchObject({ code: 'STALE_STATE', status: 409, meta: { currentStatus: 'confirmed', expectedStatus: 'booked' } })
    expect(e.detail).toContain('confirmed')
    expect((await row(b.appointment.id)).status).toBe('confirmed')
  })

  it('a completed job has no next step here (collect payment belongs to the invoice)', async () => {
    const id = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('08:30'), status: 'completed', completedAt: at('09:10') })
    expect(await err(run((tx, a) => advanceAppointment(tx, o.ctx, a, id, { expectedStatus: 'completed' })))).toMatchObject({ code: 'NO_NEXT_STEP', status: 409 })
  })

  it('permissions are per step: sched.edit can confirm and arrive, only jobs.status can start and complete', async () => {
    const b = await o.book({ at: at('10:40') })
    const edit = ['sched.edit', 'sched.view']
    await run((tx, a) => advanceAppointment(tx, o.ctx, a, b.appointment.id, { expectedStatus: 'booked' }), edit)
    await run((tx, a) => advanceAppointment(tx, o.ctx, a, b.appointment.id, { expectedStatus: 'confirmed' }), edit)
    const e = await err(run((tx, a) => advanceAppointment(tx, o.ctx, a, b.appointment.id, { expectedStatus: 'arrived' }), edit))
    expect(e).toMatchObject({ code: 'FORBIDDEN', meta: { required: ['jobs.status'] } })
    await run((tx, a) => advanceAppointment(tx, o.ctx, a, b.appointment.id, { expectedStatus: 'arrived' }), ['jobs.status'])
  })
})

describe('cancel and no-show', () => {
  it('cancel needs a reason, cancels the invoice (a deposit stays: canceled_kept), notifies on request, frees the slot', async () => {
    const b = await o.book({ at: at('14:00') })
    expect((await err(run((tx, a) => cancelAppointment(tx, o.ctx, a, b.appointment.id, { reason: '  ' })))).code).toBe('VALIDATION_FAILED')
    o.gateway.recordPayment(b.appointment.id, 2000, { deposit: true })
    const r = await run((tx, a) => cancelAppointment(tx, o.ctx, a, b.appointment.id, { reason: 'Customer called', notify: true, deposit: 'refund_card' }))
    expect(r.appointment.status).toBe('canceled')
    expect(r.invoice?.status).toBe('canceled_kept')
    expect(r.depositPolicy).toBe('refund_card')
    expect(r.toast).toEqual({ title: 'Appointment canceled', detail: 'Maria Delgado · Customer called' })
    expect(o.queue.messages.at(-1)!.body).toBe('Your appointment at Oasis Auto Spa 2:00 PM has been canceled. Reply here if you have questions.')
    expect((await activity(b.appointment.id)).map((x) => x.text)).toEqual(['Booking created', 'Booking thanks sent', 'Appointment canceled · Customer called', 'Cancellation notice sent'])
    const db = await row(b.appointment.id)
    expect(db).toMatchObject({ status: 'canceled', cancel_reason: 'Customer called' })
    expect(db.canceled_at).toEqual(o.clock.now())
    expect((await events('availability.changed')).at(-1)).toEqual({ date: TODAY })
  })

  it('only booked and confirmed jobs; permission sched.cancel is enforced by the route', async () => {
    const id = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:30'), status: 'arrived' })
    expect((await err(run((tx, a) => cancelAppointment(tx, o.ctx, a, id, { reason: 'x' })))).code).toBe('INVALID_TRANSITION')
  })

  it('no-show only after start plus the late grace, and cancels the invoice', async () => {
    const b = await o.book({ at: at('11:00') })
    o.clock.set(at('11:10'))
    expect(await err(run((tx, a) => markNoShow(tx, o.ctx, a, b.appointment.id)))).toMatchObject({ code: 'TOO_EARLY_FOR_NO_SHOW', title: 'Too early' })
    o.clock.set(at('11:11'))
    const r = await run((tx, a) => markNoShow(tx, o.ctx, a, b.appointment.id))
    expect(r.appointment.status).toBe('no_show')
    expect(r.invoice?.status).toBe('canceled')
    expect(o.queue.messages.filter((m) => m.purpose === 'cancel')).toHaveLength(0)
    expect((await row(b.appointment.id)).no_show_at).toEqual(o.clock.now())
  })

  it('the grace follows ops.late_grace_min', async () => {
    const b = await o.book({ at: at('11:00') })
    await o.tx((tx) => updateSetting(tx, { locationId: o.locationId, key: 'ops.late_grace_min', value: 20 }))
    o.clock.set(at('11:15'))
    expect((await err(run((tx, a) => markNoShow(tx, o.ctx, a, b.appointment.id)))).code).toBe('TOO_EARLY_FOR_NO_SHOW')
    await o.tx((tx) => updateSetting(tx, { locationId: o.locationId, key: 'ops.late_grace_min', value: 10 }))
  })
})

describe('reopen', () => {
  it('canceled back to booked: invoice revived, slot revalidated', async () => {
    const b = await o.book({ at: at('14:00') })
    await run((tx, a) => cancelAppointment(tx, o.ctx, a, b.appointment.id, { reason: 'changed mind' }))
    expect(o.gateway.summaryOf(b.appointment.id).status).toBe('canceled')
    const r = await run((tx, a) => reopenAppointment(tx, o.ctx, a, b.appointment.id))
    expect(r.appointment.status).toBe('booked')
    expect(r.invoice?.status).toBe('unpaid')
    expect(await row(b.appointment.id)).toMatchObject({ cancel_reason: null, canceled_at: null })
  })

  it('refuses a full slot unless overridden by someone who may', async () => {
    const b = await o.book({ at: at('14:00') })
    await run((tx, a) => cancelAppointment(tx, o.ctx, a, b.appointment.id, { reason: 'x' }))
    await o.book({ at: at('14:00'), customerName: 'David Okafor' })
    await o.book({ at: at('14:00'), customerName: 'Priya Nair' })
    expect(await err(run((tx, a) => reopenAppointment(tx, o.ctx, a, b.appointment.id)))).toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      title: 'Slot unavailable',
      detail: 'Would overbook a bay — override required',
    })
    const r = await run((tx, a) => reopenAppointment(tx, o.ctx, a, b.appointment.id, { override: { reason: 'Regular client' } }))
    expect(r.appointment.status).toBe('booked')
    const ov = await o.t.db.selectFrom('appointment_overrides').select(['kind', 'reason']).where('appointment_id', '=', b.appointment.id).execute()
    expect(ov).toEqual([{ kind: 'capacity', reason: 'Regular client' }])
  })

  it('a no-show reopens at its (past) original time when a bay is free', async () => {
    const b = await o.book({ at: at('10:50') })
    o.clock.set(at('11:30'))
    await run((tx, a) => markNoShow(tx, o.ctx, a, b.appointment.id))
    const r = await run((tx, a) => reopenAppointment(tx, o.ctx, a, b.appointment.id))
    expect(r.appointment.status).toBe('booked')
  })
})

describe('reschedule', () => {
  it('moves within the day: message, log, invoice date, availability events for old and new date', async () => {
    const b = await o.book({ at: at('14:00') })
    const r = await run((tx, a) => rescheduleAppointment(tx, o.ctx, a, b.appointment.id, { start: new Date(at('16:00')) }))
    expect(r.toast).toEqual({ title: 'Moved to 4:00 PM', detail: 'Maria Delgado notified via SMS' })
    expect(o.queue.messages.at(-1)).toMatchObject({ templateKey: 'reschedule', body: 'Your appointment has been moved to 4:00 PM. Reply if that doesn’t work.' })
    expect((await activity(b.appointment.id)).at(-1)).toEqual({ text: 'Rescheduled to 4:00 PM', channels: ['internal', 'sms'] })
    const db = await row(b.appointment.id)
    expect(db.scheduled_start).toEqual(new Date(at('16:00')))
    expect(db.scheduled_end).toEqual(new Date(new Date(at('16:00')).getTime() + 35 * 60_000))
    expect(o.gateway.occurredAtOf(b.appointment.id)).toEqual(new Date(at('16:00')))
  })

  it('can cross days (the label says when) and clears the late state', async () => {
    const id = await o.insert({ customerName: 'Marcus Webb', serviceName: 'Express Hand Wash', at: at('10:15'), status: 'confirmed' })
    const r = await run((tx, a) => rescheduleAppointment(tx, o.ctx, a, id, { start: new Date(at('09:00', '2026-06-14')) }))
    expect(r.toast.title).toBe('Moved to tomorrow at 9:00 AM')
    expect(r.appointment.late).toBe(false)
  })

  it('is capacity checked and excludes the job itself', async () => {
    const a1 = await o.book({ at: at('14:00') })
    await o.book({ at: at('15:00'), customerName: 'David Okafor' })
    await o.book({ at: at('15:00'), customerName: 'Priya Nair' })
    expect(await err(run((tx, a) => rescheduleAppointment(tx, o.ctx, a, a1.appointment.id, { start: new Date(at('15:00')) })))).toMatchObject({ code: 'SLOT_UNAVAILABLE', status: 409 })
    // a nudge that ends where the others begin overlaps only itself: 14:15 + 35 min + 10 min buffer = 15:00
    await run((tx, a) => rescheduleAppointment(tx, o.ctx, a, a1.appointment.id, { start: new Date(at('14:15')) }))
  })

  it('override: needs sched.override and a reason, and is recorded', async () => {
    const a1 = await o.book({ at: at('14:00') })
    await o.book({ at: at('15:00'), customerName: 'David Okafor' })
    await o.book({ at: at('15:00'), customerName: 'Priya Nair' })
    const start = new Date(at('15:00'))
    const noPerm = ALL.filter((p) => p !== 'sched.override')
    expect(await err(run((tx, a) => rescheduleAppointment(tx, o.ctx, a, a1.appointment.id, { start, override: { reason: 'VIP' } }), noPerm))).toMatchObject({ code: 'OVERRIDE_NOT_ALLOWED', status: 403 })
    expect(await err(run((tx, a) => rescheduleAppointment(tx, o.ctx, a, a1.appointment.id, { start, override: { reason: ' ' } })))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED', status: 422 })
    await run((tx, a) => rescheduleAppointment(tx, o.ctx, a, a1.appointment.id, { start, override: { reason: 'VIP client' } }))
    expect(await o.t.db.selectFrom('appointment_overrides').select(['kind', 'reason']).where('appointment_id', '=', a1.appointment.id).execute()).toEqual([{ kind: 'capacity', reason: 'VIP client' }])
    expect(await audits('appointment.reschedule')).toBe(1)
  })

  it('"Can’t move this job" for a job in a bay or finished; a closed day needs an override', async () => {
    const cleaning = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:00'), status: 'cleaning', bay: 1, cleaningStartedAt: at('10:09') })
    expect(await err(run((tx, a) => rescheduleAppointment(tx, o.ctx, a, cleaning, { start: new Date(at('12:00')) })))).toMatchObject({
      code: 'CANT_MOVE_JOB',
      title: 'Can’t move this job',
      detail: 'It’s already in progress or done',
    })
    const b = await o.book({ at: at('14:00'), customerName: 'David Okafor' })
    const err2 = await err(run((tx, a) => rescheduleAppointment(tx, o.ctx, a, b.appointment.id, { start: new Date(at('10:00', '2026-07-04')) })))
    expect(err2).toMatchObject({ code: 'SLOT_CLOSED', title: 'Shop is closed', detail: 'Independence Day · override required' })
    await run((tx, a) => rescheduleAppointment(tx, o.ctx, a, b.appointment.id, { start: new Date(at('10:00', '2026-07-04')), override: { reason: 'Owner approved' } }))
    expect((await o.t.db.selectFrom('appointment_overrides').select('kind').where('appointment_id', '=', b.appointment.id).executeTakeFirstOrThrow()).kind).toBe('closure')
  })

  it('moving to the same start is a no-op', async () => {
    const b = await o.book({ at: at('14:00') })
    const r = await run((tx, a) => rescheduleAppointment(tx, o.ctx, a, b.appointment.id, { start: new Date(at('14:00')) }))
    expect(r.toast.title).toBe('No change')
    expect(r.appointment.version).toBe(b.appointment.version)
  })
})

describe('prep-bay, pickup, notify-ready', () => {
  it('prep-bay is recorded once, warns when the planned bay is occupied, and names a VIP', async () => {
    const vip = await o.insert({ customerName: 'Liam Chen', serviceName: 'Express Hand Wash', at: at('10:45'), status: 'confirmed', etaMinutes: 12, plannedBay: 1 })
    const busy = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:00'), status: 'cleaning', bay: 1, cleaningStartedAt: at('10:09') })
    void busy
    const r = await run((tx, a) => prepBay(tx, o.ctx, a, vip))
    expect(r.toast).toEqual({ title: 'Bay 1 prepped', detail: 'VIP Liam Chen arrives in 12 min' })
    expect(r.warnings).toEqual(['Bay 1 is still occupied by Maria’s vehicle'])
    expect(r.appointment.prepped).toBe(true)
    await run((tx, a) => prepBay(tx, o.ctx, a, vip))
    expect((await activity(vip)).filter((x) => x.text.startsWith('Bay 1 prepped'))).toHaveLength(1)
  })

  it('pickup toggles collected and pending with the design strings; no SMS', async () => {
    const id = await o.insert({ customerName: 'Priya Nair', serviceName: 'Express Hand Wash', at: at('09:45'), status: 'completed', completedAt: at('10:20') })
    const a = await run((tx, x) => setPickup(tx, o.ctx, x, id, { state: 'collected' }))
    expect(a.toast).toEqual({ title: 'Vehicle picked up', detail: 'Released to Priya' })
    expect((await row(id)).picked_up_at).toEqual(o.clock.now())
    const b = await run((tx, x) => setPickup(tx, o.ctx, x, id, { state: 'pending' }))
    expect(b.toast).toEqual({ title: 'Pickup reopened', detail: 'Back to ready for pickup' })
    expect((await activity(id)).map((x) => x.text)).toEqual(['Vehicle released to customer', 'Pickup reopened'])
    expect(o.queue.messages).toHaveLength(0)
    const open = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Express Hand Wash', at: at('10:30'), status: 'arrived' })
    expect((await err(run((tx, x) => setPickup(tx, o.ctx, x, open, { state: 'collected' })))).code).toBe('INVALID_TRANSITION')
  })

  it('notify-ready re-sends the ready SMS and stamps ready_notified_at', async () => {
    const id = await o.insert({ customerName: 'Priya Nair', serviceName: 'Express Hand Wash', at: at('09:45'), status: 'completed', completedAt: at('10:20') })
    const r = await run((tx, x) => notifyReady(tx, o.ctx, x, id))
    expect(r.toast).toEqual({ title: 'Customer notified', detail: 'Ready-for-pickup sent via SMS' })
    expect(o.queue.messages.at(-1)!.templateKey).toBe('ready')
    expect((await row(id)).ready_notified_at).toEqual(o.clock.now())
  })
})

describe('PATCH details', () => {
  it('plans a bay without starting, assigns an active employee, edits notes; honours the version', async () => {
    const b = await o.book({ at: at('14:00') })
    const r = await run((tx, a) =>
      updateDetails(tx, o.ctx, a, b.appointment.id, { plannedBayId: o.bay(2), assignedEmployeeId: o.employee('Marco'), notes: ' Likes a text ' }, b.appointment.version),
    )
    expect(r.appointment).toMatchObject({ plannedBay: { number: 2 }, assignedEmployeeId: o.employee('Marco') })
    expect((await row(b.appointment.id)).notes).toBe('Likes a text')
    expect((await activity(b.appointment.id)).map((x) => x.text)).toEqual(expect.arrayContaining(['Planned for Bay 2', 'Assigned to Marco R.', 'Notes updated']))
    expect(await err(run((tx, a) => updateDetails(tx, o.ctx, a, b.appointment.id, { notes: 'x' }, 1)))).toMatchObject({ code: 'VERSION_CONFLICT', status: 412 })
    expect((await err(run((tx, a) => updateDetails(tx, o.ctx, a, b.appointment.id, { assignedEmployeeId: o.employee('Kevin') })))).code).toBe('VALIDATION_FAILED') // invited, not active
  })
})

describe('late is computed, never stored', () => {
  it('late = booked or confirmed and now > start + grace; clears on arrive', async () => {
    const id = await o.insert({ customerName: 'Marcus Webb', serviceName: 'Express Hand Wash', at: at('10:15'), status: 'confirmed' })
    const r = await run((tx, a) => notifyReadyOrCore(tx, a, id))
    expect(r.late).toBe(true) // 10:36 > 10:25
    o.clock.set(at('10:25'))
    expect((await run((tx, a) => notifyReadyOrCore(tx, a, id))).late).toBe(false)
    o.clock.set(at('10:26'))
    expect((await run((tx, a) => notifyReadyOrCore(tx, a, id))).late).toBe(true)
    const arrived = await run((tx, a) => arriveAppointment(tx, o.ctx, a, id))
    expect(arrived.appointment.late).toBe(false)
  })

  async function notifyReadyOrCore(tx: Parameters<Parameters<typeof o.tx>[0]>[0], a: Awaited<ReturnType<typeof o.actor>>, id: string) {
    const { toCore } = await import('../../src/modules/scheduling/lifecycle.js')
    const { requireAppointment } = await import('../../src/modules/scheduling/appointments.js')
    void a
    return toCore(tx, o.ctx, await requireAppointment(tx, o.locationId, id))
  }
})
