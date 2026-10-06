// Read models: snapshot lists and windows, the bay card, bay staff, search masking, calendar closures and the "outside
// hours" bucket, the appointment list and the appointment file.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import type { AuthContext } from '../../src/http/authorizer.js'
import { AppError } from '../../src/platform/errors.js'
import { calendarDay, calendarSummary } from '../../src/modules/scheduling/calendar.js'
import { loadAppointmentFile } from '../../src/modules/scheduling/file.js'
import { listAppointments } from '../../src/modules/scheduling/list.js'
import { loadSnapshot } from '../../src/modules/scheduling/snapshot.js'
import { listBayStaff } from '../../src/modules/scheduling/staff.js'
import { makeUser } from '../helpers/factories.js'
import { useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`
const snap = (window: 'next24' | 'today' | 'tomorrow' | 'week' = 'next24', q?: string, canContact = true) =>
  loadSnapshot(o.t.db, o.ctx, { window, q, canContact })
const auth = (...perms: string[]): AuthContext => ({
  userId: '00000000-0000-7000-8000-000000000001',
  employeeId: null,
  locationId: o.locationId,
  permissions: new Set(perms),
})

describe('bay staff (derived, not hard-coded)', () => {
  it('the design employees: Crew role, active, in the location, with the Unassigned column last', async () => {
    const staff = await listBayStaff(o.t.db, o.locationId)
    expect(staff.map((s) => s.name)).toEqual(['Marco R.', 'Lena K.', 'Sofia D.'])
    expect(staff.map((s) => s.title)).toEqual(['Lead Detailer', 'Detailer', 'Front Desk'])
    expect(staff.map((s) => s.initials)).toEqual(['MR', 'LK', 'SD'])
    const cols = (await snap()).staff
    expect(cols.map((c) => c.name)).toEqual(['Marco R.', 'Lena K.', 'Sofia D.', 'Unassigned'])
    expect(cols.at(-1)).toMatchObject({ employeeId: null, role: 'Queue', initials: '—' })
  })

  it('a custom role granting jobs.status or a per-person Allow adds someone; a Deny or an inactive account removes them', async () => {
    const db = o.t.db
    const newEmployee = async (first: string): Promise<string> => {
      const u = await makeUser(db, o.ctx.newId, { first })
      await db
        .insertInto('employee_locations')
        .values({ employee_id: u.employeeId, location_id: o.locationId })
        .execute()
      return u.employeeId
    }
    const roleId = o.ctx.newId()
    await db
      .insertInto('roles')
      .values({ id: roleId, key: null, name: 'Shift Lead', is_custom: true })
      .execute()
    await db
      .insertInto('role_permissions')
      .values({ role_id: roleId, permission_key: 'jobs.status' })
      .execute()
    const lead = await newEmployee('Nova')
    await db.insertInto('employee_roles').values({ employee_id: lead, role_id: roleId }).execute()
    const allowed = await newEmployee('Omar')
    await db
      .insertInto('employee_permission_overrides')
      .values({ employee_id: allowed, permission_key: 'jobs.status', effect: 'allow' })
      .execute()
    const plain = await newEmployee('Pia') // no role: not staff
    void plain
    await db
      .insertInto('employee_permission_overrides')
      .values({ employee_id: o.employee('Lena'), permission_key: 'jobs.status', effect: 'deny' })
      .execute()
    await db
      .updateTable('employees')
      .set({ status: 'inactive', deactivated_at: o.clock.now() })
      .where('id', '=', o.employee('Marco'))
      .execute()
    try {
      const names = (await listBayStaff(db, o.locationId)).map((s) => s.first)
      expect(names).toEqual(expect.arrayContaining(['Nova', 'Omar', 'Sofia']))
      expect(names).not.toContain('Lena')
      expect(names).not.toContain('Marco')
      expect(names).not.toContain('Pia')
      expect(names).not.toContain('Rafael') // Management grants jobs.status incidentally
      expect(names).not.toContain('Amara')
    } finally {
      await db
        .deleteFrom('employee_permission_overrides')
        .where('permission_key', '=', 'jobs.status')
        .execute()
      await db
        .updateTable('employees')
        .set({ status: 'active', deactivated_at: null })
        .where('id', '=', o.employee('Marco'))
        .execute()
    }
  })
})

describe('snapshot windows and lists', () => {
  it('today, tomorrow, week and next24 use the business day; tomorrow starts at business midnight', async () => {
    const mk = (customerName: string, when: string, status = 'confirmed') =>
      o.insert({ customerName, serviceName: 'Express Hand Wash', at: when, status })
    await mk('Maria Delgado', at('23:30'))
    await mk('David Okafor', '2026-06-14T00:30:00-04:00')
    await mk('Priya Nair', at('12:00', '2026-06-18'))
    await mk('Tom Bradley', at('12:00', '2026-06-20'))
    const names = async (w: 'today' | 'tomorrow' | 'week' | 'next24') =>
      (await snap(w)).timeline.groups.flatMap((g) => g.items.map((i) => i.customer.name))
    expect(await names('today')).toEqual(['Maria Delgado'])
    expect(await names('tomorrow')).toEqual(['David Okafor'])
    expect(await names('next24')).toEqual(['Maria Delgado', 'David Okafor'])
    expect(await names('week')).toEqual(['Maria Delgado', 'David Okafor', 'Priya Nair']) // today through today + 6
  })

  it('dividers: Today, Tomorrow, then a date; later groups of the same day have none', async () => {
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('13:00'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('09:00', '2026-06-14'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'Tom Bradley',
      serviceName: 'Express Hand Wash',
      at: at('09:00', '2026-06-16'),
      status: 'confirmed',
    })
    const w = (await snap('week')).timeline.groups
    expect(w.map((g) => g.divider)).toEqual(['Today', '', 'Tomorrow', 'Tuesday, June 16'])
    expect(w.map((g) => `${g.time} ${g.ampm}`)).toEqual(['11:00 AM', '1:00 PM', '9:00 AM', '9:00 AM'])
  })

  it('a card carries everything the design shows, derived: late badge, pay label, next step, drag flag, bay label', async () => {
    const id = await o.insert({
      customerName: 'Marcus Webb',
      serviceName: 'Family Wash + Pet Hair',
      at: at('10:15'),
      status: 'confirmed',
      special: 'Pet hair everywhere',
    })
    o.gateway.recordPayment(id, 2000, { deposit: true })
    const [card] = (await snap()).timeline.groups.flatMap((g) => g.items)
    expect(card).toMatchObject({
      status: 'confirmed',
      late: true,
      badge: { label: 'Late', color: '#C2410C' },
      bayLabel: 'No bay',
      durLabel: 'Est. 50 min',
      time: '10:15 AM',
      hasNotes: true,
      next: { label: 'Mark Arrived', step: 'arrive' },
      canDrag: true,
      pay: { label: 'Deposit · $81.65 due', kind: 'deposit', balanceCents: 8165 }, // $95 + 7% tax - the $20 deposit
    })
  })

  it("completed column: the day's finished jobs and yesterday's cars still waiting, unless the window is tomorrow", async () => {
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('08:30'),
      status: 'completed',
      completedAt: at('09:10'),
      pickup: 'collected',
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('16:00', '2026-06-12'),
      status: 'completed',
      completedAt: at('16:40', '2026-06-12'),
      pickup: 'pending',
    })
    await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('15:00', '2026-06-12'),
      status: 'completed',
      completedAt: at('15:40', '2026-06-12'),
      pickup: 'collected',
    })
    expect((await snap('today')).completed.items.map((c) => c.customer.name)).toEqual([
      'David Okafor',
      'Maria Delgado',
    ])
    expect((await snap('tomorrow')).completed.count).toBe(0)
  })

  it('the Up Next queue: VIP first, top six; the timeline excludes bays and finished jobs', async () => {
    const mk = (n: string, t: string) =>
      o.insert({ customerName: n, serviceName: 'Express Hand Wash', at: at(t), status: 'confirmed' })
    for (const [n, t] of [
      ['Maria Delgado', '11:00'],
      ['David Okafor', '11:30'],
      ['Priya Nair', '12:00'],
      ['Tom Bradley', '12:30'],
      ['Grace Adeyemi', '13:00'],
      ['Nathan Brooks', '13:30'],
      ['Marcus Webb', '14:00'],
      ['Jonathan Franco', '15:00'],
    ] as const)
      await mk(n, t)
    await o.insert({
      customerName: 'Sofia Marchetti',
      serviceName: 'Express Hand Wash',
      at: at('10:00'),
      status: 'cleaning',
      bay: 1,
      cleaningStartedAt: at('10:09'),
    })
    const s = await snap()
    expect(s.queue.map((c) => c.customer.name)).toEqual([
      'Jonathan Franco',
      'Maria Delgado',
      'David Okafor',
      'Priya Nair',
      'Tom Bradley',
      'Grace Adeyemi',
    ])
    expect(s.timeline.count).toBe(8)
    expect(s.inFacilityLabel).toBe('1 in facility')
  })
})

describe('bays', () => {
  it('an occupied bay: elapsed m:ss, progress, estimated completion = start + duration', async () => {
    await o.insert({
      customerName: 'Jonathan Franco',
      serviceName: 'Premium Hand Wash + Interior Refresh',
      at: at('10:00'),
      status: 'cleaning',
      bay: 1,
      cleaningStartedAt: at('10:09'),
      staff: 'Marco',
    })
    const bay = (await snap()).bays[0]!
    expect(bay).toMatchObject({ number: 1, occupied: true, free: false })
    expect(bay.occupant).toMatchObject({
      elapsedSec: 27 * 60,
      elapsedLabel: '27:00',
      progressLabel: '36% complete',
      durLabel: '75 min',
      estCompletionLabel: '11:24 AM',
      overrun: false,
      worker: { name: 'Marco R.', initials: 'MR' },
    })
    expect(bay.occupant!.card.next).toEqual({ label: 'Mark Complete', step: 'complete' })
    o.clock.advance(60 * 60_000)
    const later = (await snap()).bays[0]!.occupant!
    // 87 minutes in: past the 75-minute estimate, so it is overrunning and the estimate floors at now
    expect(later).toMatchObject({
      overrun: true,
      progressPct: 100,
      estCompletionLabel: '11:36 AM',
      elapsedLabel: '87:00',
    })
  })

  it('a free bay says who is next (its planned queue) and a bay in maintenance is not free', async () => {
    await o.insert({
      customerName: 'Sofia Marchetti',
      serviceName: 'Executive Detail',
      at: at('10:30'),
      status: 'arrived',
      plannedBay: 2,
    })
    await o.insert({
      customerName: 'Grace Adeyemi',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'booked',
      plannedBay: 2,
    })
    const s1 = await snap()
    expect(s1.bays[1]).toMatchObject({
      occupied: false,
      free: true,
      nextUp: 'Next: Sofia Marchetti · 10:30 AM',
    })
    expect(s1.bays[0]).toMatchObject({ free: true, nextUp: 'No vehicles queued' })
    await o.t.db.updateTable('bays').set({ status: 'maintenance' }).where('number', '=', 1).execute()
    expect((await snap()).bays[0]).toMatchObject({ status: 'maintenance', free: false })
  })

  it('arrivals: VIP first, then the nearest ETA', async () => {
    await o.insert({
      customerName: 'Grace Adeyemi',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'booked',
      etaMinutes: 22,
    })
    await o.insert({
      customerName: 'Tom Bradley',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'confirmed',
      etaMinutes: 5,
    })
    await o.insert({
      customerName: 'Liam Chen',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'confirmed',
      etaMinutes: 12,
    })
    expect((await snap()).arrivals.map((a) => a.title)).toEqual([
      'VIP arriving in 12 min · Liam Chen',
      'Arriving in 5 min · Tom Bradley',
      'Arriving in 22 min · Grace Adeyemi',
    ])
  })
})

describe('search and contact masking', () => {
  it('searches name, vehicle, plate and package; a phone only for callers with cli.contact', async () => {
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Full Detail',
      at: at('12:00'),
      status: 'confirmed',
    })
    const names = async (q: string, contact: boolean) =>
      (await snap('next24', q, contact)).timeline.groups.flatMap((g) => g.items.map((i) => i.customer.name))
    expect(await names('maria', false)).toEqual(['Maria Delgado'])
    expect(await names('q5', false)).toEqual(['Maria Delgado']) // Audi Q5
    expect(await names('FRD-1190', false)).toEqual(['David Okafor'])
    expect(await names('full detail', false)).toEqual(['David Okafor'])
    expect(await names('0102', true)).toEqual(['Maria Delgado']) // +1 305 555 0102
    expect(await names('0102', false)).toEqual([]) // a number typed into the box never reveals who owns it
    expect(await names('(305) 555-0102', true)).toEqual(['Maria Delgado']) // the formatted number matches too
    expect(await names('nobody', true)).toEqual([])
    // KPIs and bays ignore the search box
    expect((await snap('next24', 'maria')).kpis[0]!.value).toBe('2')
  })
})

describe('calendar', () => {
  it('closed days include today; bookings on a closed day are listed and flagged for rebooking', async () => {
    o.clock.set(at('10:36', '2026-07-04')) // Independence Day, closed
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('11:00', '2026-07-04'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('12:00', '2026-07-04'),
      status: 'completed',
      completedAt: at('12:40', '2026-07-04'),
    })
    const sum = await calendarSummary(o.t.db, o.ctx, { from: '2026-07-03', to: '2026-07-05' })
    expect(sum.days.map((d) => [d.date, d.closed, d.count, d.needsRebook, d.isToday])).toEqual([
      ['2026-07-03', null, 0, 0, false],
      ['2026-07-04', 'Independence Day', 2, 1, true],
      ['2026-07-05', null, 0, 0, false],
    ])
    const day = await calendarDay(o.t.db, o.ctx, '2026-07-04')
    expect(day).toMatchObject({ sub: 'Closed', rows: [], count: 2, isToday: true })
    expect(day.outsideHours.map((c) => c.customer.name)).toEqual(['Maria Delgado', 'David Okafor'])
  })

  it('an emergency closes today in the calendar like any other day', async () => {
    const id = o.ctx.newId()
    await sql`insert into emergency_closures (id, location_id, active, reason, duration_kind, through_date, message, summary, started_at)
      values (${id}, ${o.locationId}, true, 'power_outage', 'today', '2026-06-13', '', 'Power outage', ${o.clock.now()})`.execute(
      o.t.db,
    )
    try {
      const day = await calendarDay(o.t.db, o.ctx, '2026-06-13')
      expect(day.dayInfo).toMatchObject({ closed: 'Power outage closure', open: null })
      const sum = await calendarSummary(o.t.db, o.ctx, { from: '2026-06-13', to: '2026-06-14' })
      expect(sum.days.map((d) => d.closed)).toEqual(['Power outage closure', null])
    } finally {
      await sql`delete from emergency_closures where id = ${id}`.execute(o.t.db)
    }
  })

  it('a reduced day: bookings outside the window land in outsideHours instead of vanishing', async () => {
    // Labor Day 2026-09-07 is reduced, 10:00 AM - 2:00 PM
    const mk = (n: string, t: string) =>
      o.insert({
        customerName: n,
        serviceName: 'Express Hand Wash',
        at: at(t, '2026-09-07'),
        status: 'confirmed',
      })
    await mk('Maria Delgado', '08:00')
    await mk('David Okafor', '10:30')
    await mk('Priya Nair', '13:45')
    await mk('Tom Bradley', '14:30')
    const day = await calendarDay(o.t.db, o.ctx, '2026-09-07')
    expect(day.dayInfo).toMatchObject({
      closed: null,
      reduced: true,
      note: 'Labor Day · reduced hours',
      h0: 10,
      h1: 14,
    })
    expect(day.sub).toBe('4 appointments · Labor Day · reduced hours · 10:00 AM – 2:00 PM')
    expect(day.rows.map((r) => `${r.time}${r.ampm}:${r.items.length}`)).toEqual([
      '10AM:1',
      '11AM:0',
      '12PM:0',
      '1PM:1',
    ])
    expect(day.outsideHours.map((c) => c.customer.name)).toEqual(['Maria Delgado', 'Tom Bradley'])
    expect(day.count).toBe(4)
  })

  it('validates the range', async () => {
    const e = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (x: unknown) => x as AppError,
      )
    expect(await e(calendarSummary(o.t.db, o.ctx, { from: '2026-06-13', to: '2026-06-12' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(await e(calendarSummary(o.t.db, o.ctx, { from: '2026-01-01', to: '2026-06-12' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(await e(calendarSummary(o.t.db, o.ctx, { from: 'tomorrow', to: '2026-06-12' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect(await e(calendarDay(o.t.db, o.ctx, '2026-13-40'))).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('counts exclude canceled and no-show; the day heading carries the year only when it is not this year', async () => {
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('12:00'),
      status: 'canceled',
    })
    const [d] = (await calendarSummary(o.t.db, o.ctx, { from: '2026-06-13', to: '2026-06-13' })).days
    expect(d).toMatchObject({ count: 1, closed: null, open: { from: '8:00 AM', to: '5:00 PM' } })
    expect((await calendarDay(o.t.db, o.ctx, '2026-06-13')).label).toBe('Saturday, June 13')
    expect((await calendarDay(o.t.db, o.ctx, '2027-01-04')).label).toBe('Monday, January 4, 2027')
  })
})

describe('appointment list', () => {
  it('filters by range, status, customer and text, and pages by keyset', async () => {
    for (const [n, t] of [
      ['Maria Delgado', '11:00'],
      ['David Okafor', '12:00'],
      ['Priya Nair', '13:00'],
      ['Tom Bradley', '14:00'],
    ] as const)
      await o.insert({
        customerName: n,
        serviceName: 'Express Hand Wash',
        at: at(t),
        status: n === 'Tom Bradley' ? 'canceled' : 'confirmed',
      })
    const c = { ...o.ctx }
    const all = await listAppointments(o.t.db, c, {
      limit: 2,
      canContact: true,
      from: '2026-06-13',
      to: '2026-06-13',
    })
    expect(all.items.map((i) => i.customer.name)).toEqual(['Maria Delgado', 'David Okafor'])
    expect(all.nextCursor).not.toBeNull()
    const next = await listAppointments(o.t.db, c, {
      limit: 2,
      canContact: true,
      from: '2026-06-13',
      to: '2026-06-13',
      cursor: all.nextCursor!,
    })
    expect(next.items.map((i) => i.customer.name)).toEqual(['Priya Nair', 'Tom Bradley'])
    expect(next.nextCursor).toBeNull()
    expect(
      (await listAppointments(o.t.db, c, { limit: 10, canContact: true, status: 'canceled' })).items.map(
        (i) => i.customer.name,
      ),
    ).toEqual(['Tom Bradley'])
    expect(
      (
        await listAppointments(o.t.db, c, {
          limit: 10,
          canContact: true,
          customerId: o.customer('Priya Nair'),
        })
      ).items,
    ).toHaveLength(1)
    expect(
      (await listAppointments(o.t.db, c, { limit: 10, canContact: false, q: '0103' })).items,
    ).toHaveLength(0)
    expect(
      (await listAppointments(o.t.db, c, { limit: 10, canContact: true, q: '0103' })).items.map(
        (i) => i.customer.name,
      ),
    ).toEqual(['David Okafor'])
  })
})

describe('the appointment file', () => {
  it('overview, add-ons with the catalog, checklist, activity, invoice and history; contact masked without cli.contact', async () => {
    const b = await o.book({
      at: at('14:00'),
      serviceName: 'Premium Hand Wash + Interior',
      addonIds: [o.svc('Wax').id],
      notes: 'Parked south',
    })
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('08:30', '2026-06-06'),
      status: 'completed',
      completedAt: at('09:10', '2026-06-06'),
    })
    const full = await loadAppointmentFile(o.t.db, o.ctx, auth('sched.view', 'cli.contact'), b.appointment.id)
    expect(full.customer).toMatchObject({
      name: 'Maria Delgado',
      initials: 'MD',
      phone: '(305) 555-0102',
      contactMasked: false,
      vip: false,
      smsOptedIn: true,
    })
    expect(full.vehicle).toMatchObject({ make: 'Audi', model: 'Q5', plate: 'KLP-8842' })
    expect(full.overview).toMatchObject({
      time: '2:00 PM',
      service: { name: 'Premium Hand Wash + Interior', priceCents: 12900 },
      durLabel: 'Est. 75 min',
      bayLabel: 'Bay 1',
      staff: { name: 'Unassigned' },
      notes: 'Parked south',
    })
    expect(full.overview.pay).toMatchObject({ kind: 'due', label: '$180.83 due' })
    expect(full.addons.selected.map((a) => [a.name, a.priceCents])).toEqual([['Wax', 4000]])
    expect(full.addons.catalog).toHaveLength(10)
    expect(full.addons.catalog.find((a) => a.name === 'Wax')).toMatchObject({
      selected: true,
      priceCents: 4000,
    })
    expect(full.addons.totalCents).toBe(4000)
    expect(full.checklist).toMatchObject({ done: 0, total: 9, pct: 0 })
    expect(full.checklist.sections.map((s) => [s.kind, s.title, s.total])).toEqual([
      ['package', 'Premium Hand Wash + Interior', 7],
      ['addon', 'Wax', 2],
    ])
    expect(full.activity.map((a) => a.text)).toEqual(['Booking created', 'Booking thanks sent'])
    expect(full.activity[0]).toMatchObject({ atLabel: 'Today 10:36 AM', actorName: 'Test User' })
    expect(full.invoice).toMatchObject({ invoiceNo: 20611, totalCents: 18083 })
    expect(full.history.visitCount).toBe(1)
    expect(full.history.recent[0]).toMatchObject({ bizDate: '2026-06-06', service: 'Express Hand Wash' })
    expect(full.next).toEqual({ label: 'Confirm Appointment', step: 'confirm' })

    const masked = await loadAppointmentFile(o.t.db, o.ctx, auth('sched.view'), b.appointment.id)
    expect(masked.customer).toMatchObject({ contactMasked: true })
    expect(masked.customer.phone).not.toContain('555-0102')
    expect(masked.customer.phone).toMatch(/\*/)
  })

  it('an unknown appointment is 404', async () => {
    await expect(
      loadAppointmentFile(o.t.db, o.ctx, auth('sched.view'), '00000000-0000-7000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(loadAppointmentFile(o.t.db, o.ctx, auth('sched.view'), 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
