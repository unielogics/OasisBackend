// HTTP of the standing-appointment and waitlist features (ADR 0086). Everything except the feature switch itself answers
// 409 FEATURE_DISABLED until `features.standing_waitlist` is on. No UI uses these yet.
import { access } from '../../http/access.js'
import { auditContextOf } from '../../http/authorizer.js'
import { idempotentHandler } from '../../http/idempotent.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'
import { transaction } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { getSetting, updateSetting } from '../../platform/settings.js'
import { cancelAppointment } from '../scheduling/lifecycle.js'
import { actorOf, ctxOf } from '../scheduling/http/shared.js'
import { BookingResult } from '../scheduling/http/schemas.js'
import type { SchedulingPorts } from '../scheduling/ports.js'
import {
  createSeries,
  listSeries,
  materializeAll,
  materializeSeries,
  requireSeries,
  updateSeries,
  upcomingVisits,
  type SeriesRecord,
} from './series.js'
import { acceptOffer, cancelEntry, joinWaitlist, listWaitlist, type EntryRecord } from './waitlist.js'
import { requireFeature } from './support.js'
import './problems.js'

const TAGS = ['standing']
const Uuid = z.string().uuid()
const BizDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const Cadence = z.enum(['weekly', 'biweekly', 'triweekly', 'monthly'])

const Series = z.object({
  id: z.string(),
  customerId: z.string(),
  vehicleId: z.string().nullable(),
  serviceId: z.string(),
  cadence: Cadence,
  weekday: z.number().int().describe('0 = Sunday ... 6 = Saturday, the weekday of the first visit'),
  timeMin: z.number().int().describe('Minutes from midnight, business time'),
  startDate: BizDate,
  endDate: BizDate.nullable(),
  status: z.enum(['active', 'paused', 'ended']),
  generatedThrough: BizDate.nullable().describe('The last date the materializer looked at'),
  autoConfirm: z.boolean(),
  notes: z.string().nullable(),
  version: z.number().int(),
})

const Report = z.object({
  booked: z.number().int(),
  skipped: z
    .number()
    .int()
    .describe('Dates that could not be booked (closed, full, ...), recorded with the reason'),
  through: BizDate.nullable(),
})

const Entry = z.object({
  id: z.string(),
  customerId: z.string(),
  vehicleId: z.string().nullable(),
  serviceId: z.string(),
  desiredDate: BizDate,
  windowStartMin: z.number().int(),
  windowEndMin: z.number().int(),
  isVip: z.boolean(),
  status: z.enum(['waiting', 'offered', 'booked', 'expired', 'canceled']),
  appointmentId: z.string().nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  openOffer: z
    .object({
      slotStart: z.string(),
      slotEnd: z.string(),
      phase: z.enum(['vip', 'everyone']),
      expiresAt: z.string(),
    })
    .nullable(),
})

const idem = (fn: Parameters<typeof idempotentHandler>[0]): never => idempotentHandler(fn) as never

export function registerStandingRoutes(app: AppInstance, ports: SchedulingPorts): void {
  const inTx = <T>(fn: Parameters<typeof transaction<T>>[1]): Promise<T> => transaction(app.db, fn)
  const loc = (req: { auth: { locationId: string } | null }): string => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth.locationId
  }

  app.get(
    '/settings/features',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        summary: 'Feature switches: standing appointments and the waitlist',
        response: { 200: z.object({ standingWaitlist: z.boolean(), version: z.number().int() }) },
      },
    },
    async (req) => {
      const r = await getSetting(app.db, loc(req), 'features.standing_waitlist')
      return { standingWaitlist: r.value, version: r.version }
    },
  )

  app.put(
    '/settings/features',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Turn standing appointments and the waitlist on or off (default off)',
        description:
          'While off, every standing-series and waitlist endpoint answers 409 FEATURE_DISABLED, the jobs do nothing and a canceled slot is not offered. The VIP toggles in Settings must also be on for each feature.',
        body: z
          .object({ standingWaitlist: z.boolean(), version: z.number().int().min(0).optional() })
          .strict(),
        response: { 200: z.object({ standingWaitlist: z.boolean(), version: z.number().int() }) },
      },
    },
    async (req) => {
      const saved = await inTx((tx) =>
        updateSetting(tx, {
          locationId: loc(req),
          key: 'features.standing_waitlist',
          value: req.body.standingWaitlist,
          expectedVersion: req.body.version,
          updatedBy: req.auth?.realUserId ?? req.auth?.userId ?? null,
          audit: auditContextOf(req),
        }),
      )
      return { standingWaitlist: saved.value, version: saved.version }
    },
  )

  // Standing series -------------------------------------------------------------------------------------------------

  app.post(
    '/standing-series',
    {
      config: { access: access.perm('sched.edit'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Create a standing (recurring) appointment for a VIP client',
        description:
          'Needs the feature on, the VIP toggle "Standing appointments" on, a cadence from the VIP settings and a VIP client. The first visit sets the weekday; monthly repeats on the same occurrence of that weekday (the 2nd Saturday). The next four weeks are booked immediately as ordinary appointments (source standing); dates that cannot be booked are skipped with the reason.',
        body: z
          .object({
            customerId: Uuid,
            vehicleId: Uuid.nullish(),
            serviceId: Uuid,
            cadence: Cadence,
            startDate: BizDate,
            endDate: BizDate.nullish(),
            time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 hour)'),
            autoConfirm: z.boolean().optional(),
            notes: z.string().max(500).nullish(),
          })
          .strict(),
        response: { 201: z.object({ series: Series, materialized: Report }) },
      },
    },
    idem(async (req, tx) => {
      const b = req.body as {
        customerId: string
        vehicleId?: string | null
        serviceId: string
        cadence: 'weekly' | 'biweekly' | 'triweekly' | 'monthly'
        startDate: string
        endDate?: string | null
        time: string
        autoConfirm?: boolean
        notes?: string | null
      }
      const [h, m] = b.time.split(':').map(Number)
      const r = await createSeries(tx, await ctxOf(app, req, ports), actorOf(req), {
        customerId: b.customerId,
        vehicleId: b.vehicleId,
        serviceId: b.serviceId,
        cadence: b.cadence,
        startDate: b.startDate,
        endDate: b.endDate,
        timeMin: h! * 60 + m!,
        autoConfirm: b.autoConfirm,
        notes: b.notes,
      })
      return { status: 201, body: r }
    }),
  )

  app.get(
    '/standing-series',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Standing appointments (ended ones only with includeEnded)',
        querystring: z.object({ customerId: Uuid.optional(), includeEnded: z.coerce.boolean().optional() }),
        response: { 200: z.object({ items: z.array(Series) }) },
      },
    },
    async (req) => {
      const items = await inTx(async (tx) => {
        await requireFeature(tx, loc(req))
        return listSeries(tx, loc(req), req.query)
      })
      return { items }
    },
  )

  app.get(
    '/standing-series/:id',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'One standing appointment with the dates the materializer decided',
        params: z.object({ id: Uuid }),
        response: {
          200: z.object({
            series: Series,
            occurrences: z.array(
              z.object({
                date: BizDate,
                status: z.enum(['booked', 'skipped']),
                appointmentId: z.string().nullable(),
                reason: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req) =>
      inTx(async (tx) => {
        await requireFeature(tx, loc(req))
        const series = await requireSeries(tx, loc(req), req.params.id)
        const rows = await tx
          .selectFrom('standing_occurrences')
          .select(['occurrence_date', 'status', 'appointment_id', 'reason'])
          .where('series_id', '=', series.id)
          .orderBy('occurrence_date')
          .execute()
        return {
          series,
          occurrences: rows.map((r) => ({
            date: r.occurrence_date,
            status: r.status,
            appointmentId: r.appointment_id,
            reason: r.reason,
          })),
        }
      }),
  )

  app.patch(
    '/standing-series/:id',
    {
      config: { access: access.perm('sched.edit'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Pause, resume or end a standing appointment, or change its end date, auto-confirm or notes',
        description:
          '`cancelUpcoming` also cancels the booked and confirmed visits that have not happened (each as an ordinary cancel with the cancellation policy and no text). Ending is final.',
        params: z.object({ id: Uuid }),
        body: z
          .object({
            status: z.enum(['active', 'paused', 'ended']).optional(),
            endDate: BizDate.nullable().optional(),
            autoConfirm: z.boolean().optional(),
            notes: z.string().max(500).nullable().optional(),
            cancelUpcoming: z.boolean().optional(),
            version: z.number().int().min(1).optional(),
          })
          .strict(),
        response: { 200: z.object({ series: Series, canceled: z.number().int() }) },
      },
    },
    idem(async (req, tx) => {
      const b = req.body as {
        status?: 'active' | 'paused' | 'ended'
        endDate?: string | null
        autoConfirm?: boolean
        notes?: string | null
        cancelUpcoming?: boolean
        version?: number
      }
      const c = await ctxOf(app, req, ports)
      const id = (req.params as { id: string }).id
      const { cancelUpcoming, version, ...patch } = b
      const series = await updateSeries(tx, c, id, patch, version)
      let canceled = 0
      if (cancelUpcoming && (series.status === 'paused' || series.status === 'ended')) {
        const actor = actorOf(req)
        for (const apptId of await upcomingVisits(tx, c, id)) {
          await cancelAppointment(tx, c, actor, apptId, { reason: 'Standing appointment ended' })
          canceled++
        }
      }
      return { status: 200, body: { series, canceled } }
    }),
  )

  app.post(
    '/standing-series/:id/materialize',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Run the materializer for one series now (the daily job does this for all)',
        params: z.object({ id: Uuid }),
        response: { 200: Report },
      },
    },
    async (req) =>
      inTx(async (tx) => {
        await requireFeature(tx, loc(req))
        const c = await ctxOf(app, req, ports)
        return materializeSeries(tx, c, await requireSeries(tx, loc(req), req.params.id, true))
      }),
  )

  app.post(
    '/standing-series/materialize',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Run the materializer for every active series now',
        response: { 200: Report.extend({ series: z.number().int() }) },
      },
    },
    async (req) => inTx(async (tx) => materializeAll(tx, await ctxOf(app, req, ports))),
  )

  // Waitlist --------------------------------------------------------------------------------------------------------

  app.post(
    '/waitlist',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Put a client on the waitlist for a date and a time window',
        description:
          'A canceled job on that date whose start falls in the window (and is long enough for the package) is offered to the entry by text. VIP clients are offered first when the VIP "Waitlist priority" toggle is on.',
        body: z
          .object({
            customerId: Uuid,
            vehicleId: Uuid.nullish(),
            serviceId: Uuid,
            desiredDate: BizDate,
            windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
            windowEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/),
            notes: z.string().max(500).nullish(),
          })
          .strict(),
        response: { 201: Entry },
      },
    },
    async (req, reply) => {
      const b = req.body
      const mins = (s: string): number => {
        const [h, m] = s.split(':').map(Number)
        return h! * 60 + m!
      }
      const entry = await inTx(async (tx) =>
        joinWaitlist(tx, await ctxOf(app, req, ports), actorOf(req), {
          customerId: b.customerId,
          vehicleId: b.vehicleId,
          serviceId: b.serviceId,
          desiredDate: b.desiredDate,
          windowStartMin: mins(b.windowStart),
          windowEndMin: mins(b.windowEnd),
          notes: b.notes,
        }),
      )
      reply.status(201)
      return entry
    },
  )

  app.get(
    '/waitlist',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Waitlist entries with their open offer',
        querystring: z.object({
          status: z.enum(['waiting', 'offered', 'booked', 'expired', 'canceled']).optional(),
          date: BizDate.optional(),
        }),
        response: { 200: z.object({ items: z.array(Entry) }) },
      },
    },
    async (req) => {
      const items = await inTx(async (tx) => {
        await requireFeature(tx, loc(req))
        return listWaitlist(tx, loc(req), req.query)
      })
      return { items }
    },
  )

  app.post(
    '/waitlist/:id/cancel',
    {
      config: { access: access.perm('sched.edit') },
      schema: {
        tags: TAGS,
        summary: 'Take an entry off the waitlist (withdraws its open offer)',
        params: z.object({ id: Uuid }),
        response: { 200: Entry },
      },
    },
    async (req) => inTx(async (tx) => cancelEntry(tx, await ctxOf(app, req, ports), req.params.id)),
  )

  app.post(
    '/waitlist/:id/accept',
    {
      config: { access: access.perm('sched.edit'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Book the slot offered to an entry (the client said yes)',
        description:
          'The first accept wins: capacity is checked again, the slot is booked as an ordinary appointment and the other offers on it are withdrawn. 409 WAITLIST_NO_OFFER when there is no open offer or it has lapsed.',
        params: z.object({ id: Uuid }),
        response: { 201: z.object({ entry: Entry, booking: BookingResult }) },
      },
    },
    idem(async (req, tx) => {
      const r = await acceptOffer(
        tx,
        await ctxOf(app, req, ports),
        actorOf(req),
        (req.params as { id: string }).id,
      )
      return { status: 201, body: r }
    }),
  )
}

export type { EntryRecord, SeriesRecord }
