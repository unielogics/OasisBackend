// The per-employee activity report (ADR 0180, design section 5; Settings -> Team activity). Read from staff_events (car steps,
// bookings, add-ons, sizes, checklist, photos: kiosk and signed-in alike), the ledger (payments: `pay` events done, a voided one never
// counted), the messages (texts out sent by the employee as staff) and the appointments (bay time of the cars the employee was the
// worker of at completion). One business time zone: a range is whole business days, [from 00:00, to + 1 day 00:00) in the shop's time
// zone, at most 31 days. Access: team.edit; amounts (payments.amountCents, cars[].paidCents, events' amountCents) are null without
// pay.reports.
import type { FastifyRequest } from 'fastify'
import { sql, type RawBuilder } from 'kysely'
import { access } from '../../http/access.js'
import { hasPermission } from '../../http/authorizer.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import { bizDayBounds, diffDays, isValidBizDate, toBizDate } from '../../platform/time.js'
import { displayName, initials } from '../auth/context.js'
import { vehicleLabel } from '../scheduling/appointments.js'
import { locationTimezone } from '../scheduling/context.js'
import { STAFF_EVENT_KINDS, type StaffEventKind } from './schema.js'
import '../customers/schema.js'
import '../payments/schema.js'
import '../people/schema.js'
import './problems.js'

const BizDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const ActivityTotals = z.object({
  /** arrive, plus the implicit arrival of assign_bay */
  checkIns: z.number().int(),
  /** assign_bay and start */
  baysStarted: z.number().int(),
  completed: z.number().int(),
  pickedUp: z.number().int(),
  readyTexts: z.number().int(),
  bookings: z.number().int(),
  walkIns: z.number().int(),
  addons: z.number().int(),
  sizeChanges: z.number().int(),
  checklistTasks: z.number().int(),
  photos: z.number().int(),
  /** messages out, sent by this employee as staff */
  textsSent: z.number().int(),
  /** ledger pay events done, voided ones excluded; amountCents null without pay.reports */
  payments: z.object({ count: z.number().int(), amountCents: z.number().int().nullable() }),
  /** completed_at - cleaning_started_at of the cars this employee was the worker of at completion */
  bayMinutes: z.object({ total: z.number().int(), avg: z.number().int().nullable(), cars: z.number().int() }),
})

export const EmployeeActivity = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  avatarColor: z.string().nullable(),
  title: z.string(),
  status: z.enum(['active', 'invited', 'inactive']),
  totals: ActivityTotals,
  days: z.array(ActivityTotals.extend({ date: BizDate })),
})

const Via = z.enum(['kiosk', 'signed_in'])

export const ActivityCar = z.object({
  appointmentId: z.string(),
  seq: z.number().int().nullable(),
  customer: z.string(),
  vehicle: z.string(),
  date: BizDate,
  worker: z.object({ id: z.string(), name: z.string() }).nullable(),
  steps: z.array(
    z.object({ kind: z.enum(STAFF_EVENT_KINDS), at: z.string(), by: z.string(), via: Via }),
  ),
  bayMinutes: z.number().int().nullable(),
  paidCents: z.number().int().nullable(),
})

export const EmployeeActivityResponse = z.object({
  from: BizDate,
  to: BizDate,
  tz: z.string(),
  /** false without pay.reports: every amount is null */
  amounts: z.boolean(),
  employees: z.array(EmployeeActivity),
  /** only with ?employeeId: every car the employee touched in the range */
  cars: z.array(ActivityCar).optional(),
})

export const EmployeeActivityQuery = z
  .object({ from: BizDate, to: BizDate, employeeId: z.string().uuid().optional() })
  .strict()

export const StaffEventView = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(STAFF_EVENT_KINDS),
  via: Via,
  deviceName: z.string().nullable(),
  appointmentId: z.string().nullable(),
  customerId: z.string().nullable(),
  customer: z.string().nullable(),
  /** null without pay.reports */
  amountCents: z.number().int().nullable(),
  messageId: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
})

export const EmployeeEventsResponse = z.object({
  items: z.array(StaffEventView),
  nextCursor: z.string().nullable(),
})

export const EmployeeEventsQuery = z
  .object({ from: BizDate, to: BizDate, cursor: z.string().max(200).optional() })
  .strict()

/** The longest range the report answers, in business days. */
export const MAX_REPORT_DAYS = 31
/** Timeline page size. */
export const EVENTS_PAGE = 50

type Totals = z.infer<typeof ActivityTotals>
type Day = Totals & { date: string }

const zero = (amounts: boolean): Totals => ({
  checkIns: 0,
  baysStarted: 0,
  completed: 0,
  pickedUp: 0,
  readyTexts: 0,
  bookings: 0,
  walkIns: 0,
  addons: 0,
  sizeChanges: 0,
  checklistTasks: 0,
  photos: 0,
  textsSent: 0,
  payments: { count: 0, amountCents: amounts ? 0 : null },
  bayMinutes: { total: 0, avg: null, cars: 0 },
})

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

export interface ReportRange {
  from: string
  to: string
  tz: string
  /** [start, end): from's midnight to the midnight after `to`, in the business time zone. */
  start: Date
  end: Date
}

/** The business-day range: valid dates, `to` not before `from`, at most MAX_REPORT_DAYS days (422 VALIDATION_FAILED). */
export function reportRange(from: string, to: string, tz: string): ReportRange {
  if (!isValidBizDate(from)) throw invalid('from', 'Pick a valid start date.')
  if (!isValidBizDate(to)) throw invalid('to', 'Pick a valid end date.')
  if (to < from) throw invalid('to', 'The end date is before the start date.')
  if (diffDays(from, to) + 1 > MAX_REPORT_DAYS) throw invalid('to', `Pick at most ${MAX_REPORT_DAYS} days.`)
  return { from, to, tz, start: bizDayBounds(from, tz).start, end: bizDayBounds(to, tz).end }
}

/** A payment event that a void cancels is never counted. */
const notVoided = sql<boolean>`not exists (select 1 from ledger_events v where v.voids_event_id = l.id and v.type = 'void')`

const andEmployee = (column: string, employeeId: string | null): RawBuilder<unknown> =>
  employeeId ? sql`and ${sql.ref(column)} = ${employeeId}::uuid` : sql``

interface EmployeeRow {
  id: string
  first: string
  last: string
  title: string
  avatar_color: string | null
  status: 'active' | 'invited' | 'inactive'
}

async function employeesOf(db: Executor, locationId: string, ids: readonly string[], everyone: boolean): Promise<EmployeeRow[]> {
  if (ids.length === 0 && !everyone) return []
  const rows = await db
    .selectFrom('employees as e')
    .select(['e.id', 'e.first', 'e.last', 'e.title', 'e.avatar_color', 'e.status'])
    .where((eb) => {
      // everyone active or invited at the shop is on the report, with or without activity
      const staff = eb.and([
        eb('e.status', 'in', ['active', 'invited']),
        eb.exists(
          eb
            .selectFrom('employee_locations as el')
            .select('el.employee_id')
            .whereRef('el.employee_id', '=', 'e.id')
            .where('el.location_id', '=', locationId),
        ),
      ])
      if (ids.length === 0) return staff
      const named = eb('e.id', 'in', [...ids])
      return everyone ? eb.or([named, staff]) : named
    })
    .orderBy('e.first')
    .orderBy('e.last')
    .orderBy('e.id')
    .execute()
  return rows as EmployeeRow[]
}

/** The employee of the shop, or 404. */
async function requireEmployee(db: Executor, locationId: string, employeeId: string): Promise<void> {
  const ok = isUuid(employeeId)
    ? await db
        .selectFrom('employee_locations')
        .select('employee_id')
        .where('employee_id', '=', employeeId)
        .where('location_id', '=', locationId)
        .executeTakeFirst()
    : undefined
  if (!ok) throw new AppError('NOT_FOUND', { detail: 'That team member does not exist' })
}

/** Counts per employee and business day, plus the cars of one employee when `employeeId` is given. */
export async function employeeActivity(
  db: Executor,
  o: { locationId: string; range: ReportRange; employeeId: string | null; amounts: boolean },
): Promise<z.infer<typeof EmployeeActivityResponse>> {
  const { locationId, range, employeeId, amounts } = o
  const { tz, start, end } = range
  if (employeeId) await requireEmployee(db, locationId, employeeId)

  const [events, texts, payments, bays] = await Promise.all([
    sql<{ employee_id: string; day: string; kind: StaffEventKind; n: number; implicit: number; tasks: number }>`
      select employee_id, (at at time zone ${tz})::date as day, kind, count(*)::int as n,
        (count(*) filter (where kind = 'assign_bay' and meta->>'implicitArrival' = 'true'))::int as implicit,
        coalesce(sum(case when kind = 'checklist' then coalesce((meta->>'count')::int, 1) end), 0)::int as tasks
      from staff_events
      where location_id = ${locationId}::uuid and at >= ${start} and at < ${end} and employee_id is not null
        ${andEmployee('employee_id', employeeId)}
      group by 1, 2, 3`.execute(db),
    sql<{ employee_id: string; day: string; n: number }>`
      select sender_employee_id as employee_id, (queued_at at time zone ${tz})::date as day, count(*)::int as n
      from messages
      where location_id = ${locationId}::uuid and direction = 'out' and sender_kind = 'staff' and sender_employee_id is not null
        and queued_at >= ${start} and queued_at < ${end} ${andEmployee('sender_employee_id', employeeId)}
      group by 1, 2`.execute(db),
    sql<{ employee_id: string; day: string; n: number; cents: number }>`
      select l.actor_employee_id as employee_id, (l.occurred_at at time zone ${tz})::date as day, count(*)::int as n,
        coalesce(sum(l.amount_cents), 0)::bigint as cents
      from ledger_events l
      where l.location_id = ${locationId}::uuid and l.type = 'pay' and l.status = 'done' and l.actor_employee_id is not null
        and l.occurred_at >= ${start} and l.occurred_at < ${end} and ${notVoided} ${andEmployee('l.actor_employee_id', employeeId)}
      group by 1, 2`.execute(db),
    sql<{ employee_id: string; day: string; cars: number; minutes: number }>`
      select assigned_employee_id as employee_id, (completed_at at time zone ${tz})::date as day, count(*)::int as cars,
        coalesce(sum(floor(extract(epoch from (completed_at - cleaning_started_at)) / 60)), 0)::int as minutes
      from appointments
      where location_id = ${locationId}::uuid and status = 'completed' and assigned_employee_id is not null
        and cleaning_started_at is not null and completed_at >= ${start} and completed_at < ${end}
        ${andEmployee('assigned_employee_id', employeeId)}
      group by 1, 2`.execute(db),
  ])

  const byEmployee = new Map<string, Map<string, Day>>()
  const slot = (employee: string, day: string): Day => {
    let days = byEmployee.get(employee)
    if (!days) byEmployee.set(employee, (days = new Map()))
    let d = days.get(day)
    if (!d) days.set(day, (d = { date: day, ...zero(amounts) }))
    return d
  }
  for (const r of events.rows) {
    const d = slot(r.employee_id, r.day)
    switch (r.kind) {
      case 'arrive':
        d.checkIns += r.n
        break
      case 'assign_bay':
        d.baysStarted += r.n
        d.checkIns += r.implicit
        break
      case 'start':
        d.baysStarted += r.n
        break
      case 'complete':
        d.completed += r.n
        break
      case 'pickup':
        d.pickedUp += r.n
        break
      case 'notify_ready':
        d.readyTexts += r.n
        break
      case 'book':
        d.bookings += r.n
        break
      case 'walk_in':
        d.walkIns += r.n
        break
      case 'addon_add':
        d.addons += r.n
        break
      case 'size_change':
        d.sizeChanges += r.n
        break
      case 'checklist':
        d.checklistTasks += r.tasks
        break
      case 'photo':
        d.photos += r.n
        break
      default:
        // the other kinds (confirm, prep_bay, reschedule, update, texts and money, ...) are on the timeline and the cars, not counted
        break
    }
  }
  for (const r of texts.rows) slot(r.employee_id, r.day).textsSent += r.n
  for (const r of payments.rows) {
    const p = slot(r.employee_id, r.day).payments
    p.count += r.n
    if (p.amountCents !== null) p.amountCents += Number(r.cents)
  }
  for (const r of bays.rows) {
    const b = slot(r.employee_id, r.day).bayMinutes
    b.cars += r.cars
    b.total += r.minutes
  }

  const people = await employeesOf(db, locationId, employeeId ? [employeeId] : [...byEmployee.keys()], employeeId === null)
  const employees = people.map((e) => {
    const days = [...(byEmployee.get(e.id)?.values() ?? [])].sort((a, b) => a.date.localeCompare(b.date))
    const totals = zero(amounts)
    for (const d of days) {
      d.bayMinutes.avg = d.bayMinutes.cars ? Math.round(d.bayMinutes.total / d.bayMinutes.cars) : null
      for (const k of COUNTS) totals[k] += d[k]
      totals.payments.count += d.payments.count
      if (totals.payments.amountCents !== null) totals.payments.amountCents += d.payments.amountCents ?? 0
      totals.bayMinutes.total += d.bayMinutes.total
      totals.bayMinutes.cars += d.bayMinutes.cars
    }
    totals.bayMinutes.avg = totals.bayMinutes.cars ? Math.round(totals.bayMinutes.total / totals.bayMinutes.cars) : null
    return {
      id: e.id,
      name: displayName(e.first, e.last),
      initials: initials(e.first, e.last),
      avatarColor: e.avatar_color,
      title: e.title,
      status: e.status,
      totals,
      days,
    }
  })
  return {
    from: range.from,
    to: range.to,
    tz,
    amounts,
    employees,
    ...(employeeId ? { cars: await carsOf(db, { locationId, range, employeeId, amounts }) } : {}),
  }
}

const COUNTS = [
  'checkIns',
  'baysStarted',
  'completed',
  'pickedUp',
  'readyTexts',
  'bookings',
  'walkIns',
  'addons',
  'sizeChanges',
  'checklistTasks',
  'photos',
  'textsSent',
] as const satisfies ReadonlyArray<keyof Totals>

/** Every car the employee touched in the range (a staff event, or the worker of a car finished in it), each step by whoever did it. */
async function carsOf(
  db: Executor,
  o: { locationId: string; range: ReportRange; employeeId: string; amounts: boolean },
): Promise<z.infer<typeof ActivityCar>[]> {
  const { locationId, range, employeeId, amounts } = o
  const ids = (
    await sql<{ id: string }>`
      select appointment_id as id from staff_events
      where location_id = ${locationId}::uuid and employee_id = ${employeeId}::uuid and appointment_id is not null
        and at >= ${range.start} and at < ${range.end}
      union
      select id from appointments
      where location_id = ${locationId}::uuid and assigned_employee_id = ${employeeId}::uuid
        and completed_at >= ${range.start} and completed_at < ${range.end}`.execute(db)
  ).rows.map((r) => r.id)
  if (ids.length === 0) return []
  const [cars, steps, paid] = await Promise.all([
    db
      .selectFrom('appointments as a')
      .innerJoin('customers as c', 'c.id', 'a.customer_id')
      .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
      .leftJoin('employees as w', 'w.id', 'a.assigned_employee_id')
      .select([
        'a.id',
        'a.seq',
        'a.scheduled_start',
        'a.cleaning_started_at',
        'a.completed_at',
        'a.status',
        'c.full_name',
        'v.year',
        'v.make',
        'v.model',
        'w.id as worker_id',
        'w.first as worker_first',
        'w.last as worker_last',
      ])
      .where('a.id', 'in', ids)
      .orderBy('a.scheduled_start')
      .orderBy('a.seq')
      .execute(),
    db
      .selectFrom('staff_events')
      .select(['appointment_id', 'kind', 'at', 'employee_name', 'via'])
      .where('appointment_id', 'in', ids)
      .orderBy('at')
      .orderBy('id')
      .execute(),
    amounts
      ? sql<{ appointment_id: string; cents: number }>`
          select i.appointment_id, coalesce(sum(l.amount_cents), 0)::bigint as cents
          from ledger_events l join invoices i on i.id = l.invoice_id
          where i.appointment_id in (${sql.join(ids.map((id) => sql`${id}::uuid`))}) and l.type = 'pay' and l.status = 'done'
            and ${notVoided}
          group by 1`
          .execute(db)
          .then((r) => r.rows)
      : Promise.resolve([]),
  ])
  const paidOf = new Map(paid.map((p) => [p.appointment_id, Number(p.cents)]))
  return cars.map((a) => ({
    appointmentId: a.id,
    seq: a.seq,
    customer: a.full_name,
    vehicle: vehicleLabel(a.make || a.model || a.year ? { year: a.year, make: a.make, model: a.model } : null),
    date: toBizDate(a.scheduled_start, range.tz),
    worker: a.worker_id ? { id: a.worker_id, name: displayName(a.worker_first ?? '', a.worker_last ?? '') } : null,
    steps: steps
      .filter((x) => x.appointment_id === a.id)
      .map((x) => ({ kind: x.kind, at: x.at.toISOString(), by: x.employee_name, via: x.via })),
    bayMinutes:
      a.status === 'completed' && a.cleaning_started_at && a.completed_at
        ? Math.floor((a.completed_at.getTime() - a.cleaning_started_at.getTime()) / 60_000)
        : null,
    paidCents: amounts ? (paidOf.get(a.id) ?? 0) : null,
  }))
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(\d{1,18})$/

/** One employee's staff events in the range, newest first, EVENTS_PAGE at a time (`nextCursor` until the last page). */
export async function employeeEvents(
  db: Executor,
  o: { locationId: string; range: ReportRange; employeeId: string; amounts: boolean; cursor?: string },
): Promise<z.infer<typeof EmployeeEventsResponse>> {
  const { locationId, range, employeeId, amounts } = o
  await requireEmployee(db, locationId, employeeId)
  let after: { at: Date; id: number } | null = null
  if (o.cursor !== undefined) {
    const m = CURSOR.exec(o.cursor)
    if (!m) throw invalid('cursor', 'That page link is not valid. Load the timeline again.')
    after = { at: new Date(m[1]!), id: Number(m[2]) }
  }
  let q = db
    .selectFrom('staff_events as s')
    .leftJoin('kiosk_devices as d', 'd.id', 's.kiosk_device_id')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .select([
      's.id',
      's.at',
      's.kind',
      's.via',
      'd.name as device_name',
      's.appointment_id',
      's.customer_id',
      'c.full_name',
      's.amount_cents',
      's.message_id',
      's.meta',
    ])
    .where('s.location_id', '=', locationId)
    .where('s.employee_id', '=', employeeId)
    .where('s.at', '>=', range.start)
    .where('s.at', '<', range.end)
  if (after) {
    const a = after
    q = q.where((eb) => eb.or([eb('s.at', '<', a.at), eb.and([eb('s.at', '=', a.at), eb('s.id', '<', a.id)])]))
  }
  const rows = await q.orderBy('s.at', 'desc').orderBy('s.id', 'desc').limit(EVENTS_PAGE + 1).execute()
  const page = rows.slice(0, EVENTS_PAGE)
  const last = page[page.length - 1]
  return {
    items: page.map((r) => ({
      id: String(r.id),
      at: r.at.toISOString(),
      kind: r.kind,
      via: r.via,
      deviceName: r.device_name,
      appointmentId: r.appointment_id,
      customerId: r.customer_id,
      customer: r.full_name,
      amountCents: amounts ? r.amount_cents : null,
      messageId: r.message_id,
      meta: (r.meta ?? {}) as Record<string, unknown>,
    })),
    nextCursor: rows.length > EVENTS_PAGE && last ? `${last.at.toISOString()}|${last.id}` : null,
  }
}

export function registerActivityReportRoutes(app: AppInstance): void {
  const amountsFor = (req: FastifyRequest): boolean => !!req.auth && hasPermission(req.auth, 'pay.reports')

  app.get(
    '/reports/employee-activity',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['reports'],
        summary: 'Team activity per employee for a date range (at most 31 days, business time zone)',
        description:
          'Counts per employee and per business day from the staff events (kiosk and signed-in), the ledger and the messages: check-ins ' +
          '(arrive, and a drag from booked or confirmed onto a bay), bays started (assign-bay and start), completed, picked up, ready texts, ' +
          'bookings, walk-ins, add-ons, size changes, checklist tasks, photos and notes, texts sent, payments (`pay` events done; a voided one ' +
          'is never counted; amounts null without pay.reports) and bay minutes (completed minus cleaning started, for the cars the employee ' +
          'was the worker of). Every active or invited employee of the shop is listed, and anyone else with activity in the range; `days` ' +
          'holds only the days with activity. With employeeId: that employee alone (404 when not of the shop) and `cars`, every car they ' +
          'touched with each step and who did it. 422 VALIDATION_FAILED for a bad date, an end before the start or more than 31 days.',
        querystring: EmployeeActivityQuery,
        response: { 200: EmployeeActivityResponse },
      },
    },
    async (req) => {
      const a = req.auth!
      const q = req.query as z.infer<typeof EmployeeActivityQuery>
      const range = reportRange(q.from, q.to, await locationTimezone(app.db, a.locationId))
      return employeeActivity(app.db, { locationId: a.locationId, range, employeeId: q.employeeId ?? null, amounts: amountsFor(req) })
    },
  )

  app.get(
    '/reports/employee-activity/:employeeId/events',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['reports'],
        summary: 'One employee’s activity timeline, newest first, paged',
        description:
          `Their staff events in the range (at most 31 days, business time zone), ${EVENTS_PAGE} a page: kind, kiosk or signed in (with ` +
          'the device), the client and the visit. Pass `nextCursor` back as `cursor` for the next page (null on the last). Amounts are null ' +
          'without pay.reports. 404 when the employee is not of the shop; 422 VALIDATION_FAILED for a bad range or cursor.',
        params: z.object({ employeeId: z.string() }),
        querystring: EmployeeEventsQuery,
        response: { 200: EmployeeEventsResponse },
      },
    },
    async (req) => {
      const a = req.auth!
      const q = req.query as z.infer<typeof EmployeeEventsQuery>
      const range = reportRange(q.from, q.to, await locationTimezone(app.db, a.locationId))
      return employeeEvents(app.db, {
        locationId: a.locationId,
        range,
        employeeId: (req.params as { employeeId: string }).employeeId,
        amounts: amountsFor(req),
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      })
    },
  )
}
