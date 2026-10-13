// The per-employee activity report (ADR 0180, design section 5): CONTRACT ONLY in wave K1a. The schemas are final so the dashboard can
// be built against them; the handlers answer 501 NOT_BUILT until the report package (wave K2b) implements them from staff_events,
// the ledger and the messages. Access: team.edit; amounts (payments.amountCents, cars[].paidCents) are null without pay.reports.
import { access } from '../../http/access.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'
import { AppError } from '../../platform/errors.js'
import { STAFF_EVENT_KINDS } from './schema.js'
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

export function registerActivityReportRoutes(app: AppInstance): void {
  app.get(
    '/reports/employee-activity',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['reports'],
        summary: 'Team activity per employee for a date range (at most 31 days, business time zone)',
        description:
          'Counts per employee and per day from the staff events (kiosk and signed-in), the ledger and the messages. Amounts are null ' +
          'without pay.reports. With employeeId the cars that employee touched, step by step. Not built yet: answers 501 NOT_BUILT ' +
          '(ADR 0180 wave K2b).',
        querystring: EmployeeActivityQuery,
        response: { 200: EmployeeActivityResponse },
      },
    },
    async () => {
      throw new AppError('NOT_BUILT')
    },
  )

  app.get(
    '/reports/employee-activity/:employeeId/events',
    {
      config: { access: access.perm('team.edit') },
      schema: {
        tags: ['reports'],
        summary: 'One employee’s activity timeline, newest first, paged',
        description: 'Amounts are null without pay.reports. Not built yet: answers 501 NOT_BUILT (ADR 0180 wave K2b).',
        params: z.object({ employeeId: z.string() }),
        querystring: EmployeeEventsQuery,
        response: { 200: EmployeeEventsResponse },
      },
    },
    async () => {
      throw new AppError('NOT_BUILT')
    },
  )
}
