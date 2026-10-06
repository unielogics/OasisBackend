// Emergency closing: state and idle strip, preview, close, reopen, history and the "needs rebooking" list.
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { fmtT, isValidBizDate, tryParseT } from '../../../platform/time.js'
import { weekdayMonthDay } from '../labels.js'
import { DAY_NAMES } from '../labels.js'
import type { AffectedAppointment } from '../ports.js'
import {
  getEmergency,
  getEmergencyState,
  listEmergencyHistory,
  listNeedsRebooking,
  previewEmergency,
  type EmergencyDuration,
  type EmergencyState,
  type NotifiedAppointment,
} from '../emergency.js'
import { DEFAULT_EMERGENCY_MESSAGE, EMERGENCY_REASONS, EMERGENCY_REASON_KEYS } from '../labels.js'
import { PREVIEW_SAMPLE } from '../emergency.js'
import type { EmergencyDurationKind, EmergencyReason } from '../schema.js'
import { assertTodayClosable, closeCommand, reopenCommand } from './emergency-commands.js'
import { ClosureItem, closureItem } from './closure-routes.js'
import { EMERGENCY_AUTO_REOPEN_JOB } from '../jobs/names.js'
import { businessTzOf, idem, requestContext, storedUserId, type SettingsRuntime } from './runtime.js'

const REASON_ALIASES = new Map<string, EmergencyReason>()
for (const key of EMERGENCY_REASON_KEYS) {
  const info = EMERGENCY_REASONS[key]
  for (const alias of [key, info.label, info.phrase, key.replace(/_/g, ' ')])
    REASON_ALIASES.set(alias.toLowerCase(), key)
}

/** The design sends the chip label ("Severe weather"); the API also takes the key ("severe_weather"). */
export function parseReason(text: string): EmergencyReason {
  const key = REASON_ALIASES.get(text.trim().toLowerCase())
  if (!key)
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Pick a reason.',
      errors: [{ path: 'reason', message: 'Pick a reason.' }],
    })
  return key
}

const DurIn = z.enum(['today', 'until', 'days', 'through'])

function durationOf(b: {
  dur: z.infer<typeof DurIn>
  until?: string
  untilMin?: number
  through?: string
}): EmergencyDuration {
  const kind: EmergencyDurationKind = b.dur === 'through' ? 'days' : b.dur
  if (kind === 'until') {
    const m = b.untilMin ?? (b.until !== undefined ? tryParseT(b.until) : null)
    if (m === null || m === undefined)
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Pick a time to reopen.',
        errors: [{ path: 'until', message: 'Pick a time to reopen.' }],
      })
    return { kind, untilMin: m }
  }
  if (kind === 'days') {
    if (!b.through || !isValidBizDate(b.through))
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Pick the last day of the closure.',
        errors: [{ path: 'through', message: 'Pick the last day of the closure.' }],
      })
    return { kind, throughDate: b.through }
  }
  return { kind }
}

// Views ---------------------------------------------------------------------------------------------------------------

const AffectedRow = z.object({
  appointmentId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  firstName: z.string(),
  vehicle: z.string().nullable(),
  time: z.string(),
  bizDate: z.string(),
  dateLabel: z.string().describe('"Monday, Jun 15": a multi-day list needs the date (review B50)'),
  status: z.string(),
})

const NotifiedRow = AffectedRow.extend({
  notification: z.object({ channel: z.enum(['sms', 'email', 'none']), state: z.string() }),
})

const affectedRow = (a: AffectedAppointment): z.infer<typeof AffectedRow> => ({
  appointmentId: a.appointmentId,
  customerId: a.customerId,
  customerName: a.customerName,
  firstName: a.firstName,
  vehicle: a.vehicle,
  time: a.time,
  bizDate: a.bizDate,
  dateLabel: weekdayMonthDay(a.bizDate),
  status: a.status,
})

const Counters = z.object({
  affected: z.number().int(),
  notified: z.number().int(),
  rebooked: z.number().int(),
  booking: z.enum(['Paused', 'Open']),
})

const CurrentView = z.object({
  id: z.string(),
  reason: z.string(),
  reasonLabel: z.string(),
  durationKind: z.enum(['today', 'until', 'days']),
  untilMin: z.number().int().nullable(),
  throughDate: z.string().nullable(),
  endsAt: z.string().nullable(),
  summary: z.string(),
  startedAt: z.string(),
  startedByName: z.string().nullable(),
  message: z.string(),
  notify: z.boolean(),
  link: z.boolean(),
  credits: z.boolean(),
  pause: z.boolean(),
  crew: z.boolean(),
  counters: Counters,
})

const HistoryItem = z.object({
  id: z.string(),
  date: z.string(),
  reason: z.string(),
  detail: z.string(),
  affectedCount: z.number().int(),
  notifiedCount: z.number().int(),
  rebookedCount: z.number().int(),
})

const Strip = z.object({
  openNow: z.boolean(),
  text: z
    .string()
    .describe('"Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site"'),
  todayHours: z.string().nullable().describe('"Saturday 8:00 AM – 5:00 PM"; null when closed all day'),
  closedReason: z.string().nullable(),
  appointmentsRemaining: z.number().int(),
  vehiclesOnSite: z.number().int(),
  date: z.string(),
  openMin: z.number().int().nullable(),
  closeMin: z.number().int().nullable(),
})

export const EmergencyView = z.object({
  active: z.boolean(),
  summary: z.string().nullable(),
  counters: Counters.nullable(),
  current: CurrentView.nullable(),
  strip: Strip,
  history: z.array(HistoryItem).nullable().describe('Null unless the caller holds set.emergency'),
  canClose: z.boolean(),
  closeRoleNames: z.array(z.string()),
  requirement: z.string().describe('"Requires Management or Super Admin"'),
  options: z.object({
    reasons: z.array(z.object({ key: z.string(), label: z.string(), phrase: z.string() })),
    defaultMessage: z.string(),
    sample: z.object({ first: z.string(), link: z.string() }),
  }),
})

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function stripView(s: EmergencyState['strip']): z.infer<typeof Strip> {
  const t = s.today
  const hours = t.closed ? null : `${DAY_NAMES[t.weekday]} ${fmtT(t.openMin!)} – ${fmtT(t.closeMin!)}`
  const head = s.openNow
    ? 'Open now'
    : t.closed
      ? `Closed today${t.reason ? ` · ${t.reason}` : ''}`
      : 'Closed now'
  const tail = `${plural(s.appointmentsRemaining, 'appointment', 'appointments')} left today, ${plural(s.vehiclesOnSite, 'vehicle', 'vehicles')} on site`
  return {
    openNow: s.openNow,
    text: [head, hours, tail].filter(Boolean).join(' · '),
    todayHours: hours,
    closedReason: t.closed ? t.reason : null,
    appointmentsRemaining: s.appointmentsRemaining,
    vehiclesOnSite: s.vehiclesOnSite,
    date: t.date,
    openMin: t.openMin,
    closeMin: t.closeMin,
  }
}

export function currentView(c: NonNullable<EmergencyState['current']>): z.infer<typeof CurrentView> {
  return {
    id: c.id,
    reason: c.reason,
    reasonLabel: c.reasonLabel,
    durationKind: c.durationKind,
    untilMin: c.untilMin,
    throughDate: c.throughDate,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    summary: c.summary,
    startedAt: c.startedAt.toISOString(),
    startedByName: c.startedByName,
    message: c.message,
    notify: c.notify,
    link: c.link,
    credits: c.credits,
    pause: c.pause,
    crew: c.crew,
    counters: c.counters,
  }
}

/** Names of the roles whose members may close the shop; Super Admin (locked, holds everything) comes last. */
export async function closeRoleNames(db: Executor): Promise<string[]> {
  const rows = await db
    .selectFrom('roles as r')
    .select(['r.key', 'r.name', 'r.is_locked'])
    .where((eb) =>
      eb.or([
        eb('r.is_locked', '=', true),
        eb.exists(
          eb
            .selectFrom('role_permissions as p')
            .select('p.role_id')
            .whereRef('p.role_id', '=', 'r.id')
            .where('p.permission_key', '=', 'set.emergency'),
        ),
      ]),
    )
    .execute()
  return rows
    .sort(
      (a, b) =>
        Number(a.is_locked) - Number(b.is_locked) ||
        (a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) ||
        a.name.localeCompare(b.name),
    )
    .map((r) => r.name)
}

export async function loadEmergencyView(
  db: Executor,
  o: { locationId: string; now: Date; tz: string; canClose: boolean },
): Promise<z.infer<typeof EmergencyView>> {
  const [state, names] = await Promise.all([
    getEmergencyState(db, { locationId: o.locationId, now: o.now, tz: o.tz }),
    closeRoleNames(db),
  ])
  return {
    active: state.active,
    summary: state.current?.summary ?? null,
    counters: state.current?.counters ?? null,
    current: state.current ? currentView(state.current) : null,
    strip: stripView(state.strip),
    history: o.canClose ? state.history : null,
    canClose: o.canClose,
    closeRoleNames: names,
    requirement: `Requires ${names.join(' or ')}`,
    options: {
      reasons: EMERGENCY_REASON_KEYS.map((key) => ({
        key,
        label: EMERGENCY_REASONS[key].label,
        phrase: EMERGENCY_REASONS[key].phrase,
      })),
      defaultMessage: DEFAULT_EMERGENCY_MESSAGE,
      sample: { first: PREVIEW_SAMPLE.first, link: PREVIEW_SAMPLE.link },
    },
  }
}

const Bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

export function registerEmergencyRoutes(rt: SettingsRuntime): void {
  const { app } = rt
  const linkEnabled = (): boolean => app.env.RESCHEDULE_LINK_ENABLED

  app.get(
    '/emergency',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getEmergency',
        summary: 'Emergency banner state, counters, the idle strip (live) and who may close the shop',
        description:
          'Visible to every signed-in user (the Operations banner needs it). The idle strip is computed live: open now, today\'s hours, appointments remaining, vehicles on site. `canClose` and `closeRoleNames` replace the design\'s static "Requires Management or Super Admin" line. `history` is only sent to holders of set.emergency.',
        response: { 200: EmergencyView },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      return loadEmergencyView(app.db, {
        locationId: c.locationId,
        now: app.clock.now(),
        tz,
        canClose: hasPermission(req.auth!, 'set.emergency'),
      })
    },
  )

  app.get(
    '/emergency/preview',
    {
      config: { access: access.perm('set.emergency') },
      schema: {
        tags: ['settings'],
        operationId: 'previewEmergency',
        summary: 'Who a closure would affect and the customer message as it would read',
        description:
          '`reason` is the chip label or key; `dur` is today, until or days (through is accepted as days); `until` is "2:00 PM"; `through` a date. Multi-day previews include every date through the last day, and vehicles already on site are listed separately and never touched.',
        querystring: z.object({
          reason: z.string().max(60),
          dur: DurIn,
          until: z.string().max(12).optional(),
          through: z.string().max(10).optional(),
          message: z.string().max(1000).optional(),
          notify: Bool.optional(),
          link: Bool.optional(),
          pause: Bool.optional(),
        }),
        response: {
          200: z.object({
            count: z.number().int(),
            affected: z.array(AffectedRow),
            onSite: z.array(AffectedRow),
            summary: z.string(),
            untilText: z.string(),
            renderedMessage: z.string(),
            endsAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const q = req.query
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const duration = durationOf(q)
      if (duration.kind === 'today') {
        await assertTodayClosable(app.db, { locationId: c.locationId, now: app.clock.now(), tz })
      }
      const p = await previewEmergency(app.db, {
        locationId: c.locationId,
        reason: parseReason(q.reason),
        duration,
        message: q.message,
        notify: q.notify ?? true,
        link: q.link ?? true,
        credits: true,
        pause: q.pause ?? true,
        crew: true,
        now: app.clock.now(),
        tz,
        linkEnabled: linkEnabled(),
      })
      return {
        count: p.count,
        affected: p.affected.map(affectedRow),
        onSite: p.onSite.map(affectedRow),
        summary: p.summary,
        untilText: p.untilText,
        renderedMessage: p.renderedMessage,
        endsAt: p.window.endsAt.toISOString(),
      }
    },
  )

  app.post(
    '/emergency/close',
    {
      config: { access: access.perm('set.emergency'), idempotency: 'required' },
      schema: {
        tags: ['settings'],
        operationId: 'closeShop',
        summary:
          'Close the shop now: closure rows, affected customers, notifications, booking pause, crew alert',
        description:
          'Needs an Idempotency-Key (a replay returns the stored response with `Idempotent-Replayed: true`). One transaction: rejects a second active emergency (409 EMERGENCY_ACTIVE) and "rest of today" after closing time (422 EMERGENCY_NOTHING_TO_CLOSE). ' +
          'Affected = booked and confirmed appointments in the window (multi-day closures include every day through the last); arrived and cleaning vehicles are reported in `onSite`. Schedules `emergency.auto_reopen` at the end time. ' +
          'Publishes `emergency.started` (ops) and `settings.changed {section: "emergency"}`.',
        body: z
          .object({
            reason: z.string().max(60),
            dur: DurIn,
            until: z.string().max(12).optional(),
            untilMin: z.number().int().optional(),
            through: z.string().max(10).optional(),
            message: z.string().max(1000).optional(),
            notify: z.boolean().default(true),
            link: z.boolean().default(true),
            credits: z.boolean().default(true),
            pause: z.boolean().default(true),
            crew: z.boolean().default(true),
          })
          .strict(),
        response: {
          201: z.object({
            summary: z.string(),
            notifiedCount: z.number().int(),
            skipped: z.number().int(),
            affected: z.array(NotifiedRow),
            onSite: z.array(AffectedRow),
            closuresCreated: z.array(ClosureItem),
            emergency: CurrentView,
          }),
        },
      },
    },
    idem(async (req, tx) => {
      const b = req.body as {
        reason: string
        dur: z.infer<typeof DurIn>
        until?: string
        untilMin?: number
        through?: string
        message?: string
        notify: boolean
        link: boolean
        credits: boolean
        pause: boolean
        crew: boolean
      }
      const c = requestContext(req)
      const tz = await businessTzOf(tx, c.locationId, app.env.BUSINESS_TZ)
      const r = await closeCommand(
        tx,
        { clock: app.clock, newId: app.newId, tz, ports: rt.ports(), linkEnabled: linkEnabled() },
        {
          locationId: c.locationId,
          reason: parseReason(b.reason),
          duration: durationOf(b),
          message: b.message,
          notify: b.notify,
          link: b.link,
          credits: b.credits,
          pause: b.pause,
          crew: b.crew,
          startedBy: await storedUserId(tx, c.userId),
          startedByName: c.actorName,
          audit: c.audit,
        },
      )
      const em = r.emergency
      if (em.endsAt && app.jobs) {
        try {
          await app.jobs.enqueue(
            EMERGENCY_AUTO_REOPEN_JOB,
            { locationId: c.locationId, emergencyClosureId: em.id },
            { singletonKey: em.id, startAfter: em.endsAt },
          )
        } catch (err) {
          req.log.warn(
            { err: (err as Error).message },
            'could not schedule emergency.auto_reopen; the hourly sweep will reopen',
          )
        }
      }
      const counters = {
        affected: r.affected.length,
        notified: r.notifiedCount,
        rebooked: 0,
        booking: em.pause ? ('Paused' as const) : ('Open' as const),
      }
      const reasonLabel = EMERGENCY_REASONS[em.reason].label
      return {
        status: 201,
        body: {
          summary: r.summary,
          notifiedCount: r.notifiedCount,
          skipped: r.skipped,
          affected: r.affected.map((a: NotifiedAppointment) => ({
            ...affectedRow(a),
            notification: a.notification,
          })),
          onSite: r.onSite.map(affectedRow),
          closuresCreated: r.closuresCreated.map((x) => closureItem(x, { past: false, affectedCount: null })),
          emergency: currentView({
            id: em.id,
            reason: em.reason,
            reasonLabel,
            durationKind: em.durationKind,
            untilMin: em.untilMin,
            throughDate: em.throughDate,
            endsAt: em.endsAt,
            summary: em.summary,
            startedAt: em.startedAt,
            startedByName: em.startedByName,
            message: em.message,
            notify: em.notify,
            link: em.link,
            credits: em.credits,
            pause: em.pause,
            crew: em.crew,
            counters,
          }),
        },
      }
    }),
  )

  app.post(
    '/emergency/reopen',
    {
      config: { access: access.perm('set.emergency'), idempotency: 'optional' },
      schema: {
        tags: ['settings'],
        operationId: 'reopenShop',
        summary:
          'Reopen now: removes the emergency closure rows, restores replaced closures, resumes online booking',
        description:
          'Writes the history row "Reopened by {user} · {n} notified" with real counters. Customers who did not rebook stay flagged on their appointments (GET /emergency/{id}/affected); nothing is canceled. 409 EMERGENCY_NOT_ACTIVE when the shop is not closed. Publishes `emergency.reopened` (ops).',
        response: {
          200: z.object({
            id: z.string(),
            detail: z.string(),
            restoredClosures: z.number().int(),
            removedClosures: z.number().int(),
          }),
        },
      },
    },
    idem(async (req, tx) => {
      const c = requestContext(req)
      const tz = await businessTzOf(tx, c.locationId, app.env.BUSINESS_TZ)
      const r = await reopenCommand(
        tx,
        { clock: app.clock, tz },
        {
          locationId: c.locationId,
          reopenedBy: await storedUserId(tx, c.userId),
          reopenedByName: c.actorName,
          audit: c.audit,
        },
      )
      return {
        status: 200,
        body: {
          id: r.emergency.id,
          detail: r.detail,
          restoredClosures: r.restoredClosureIds.length,
          removedClosures: r.removedClosureIds.length,
        },
      }
    }),
  )

  app.get(
    '/emergency/history',
    {
      config: { access: access.perm('set.emergency') },
      schema: {
        tags: ['settings'],
        operationId: 'listEmergencyHistory',
        summary: 'Past emergency closures, newest first',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.object({ items: z.array(HistoryItem) }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      return { items: await listEmergencyHistory(app.db, c.locationId, tz, req.query.limit) }
    },
  )

  app.get(
    '/emergency/:id/affected',
    {
      config: { access: access.perm('set.emergency') },
      schema: {
        tags: ['settings'],
        operationId: 'listEmergencyAffected',
        summary: 'Customers flagged by an emergency that still need a new time (the "needs rebooking" queue)',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ items: z.array(AffectedRow), count: z.number().int() }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const em = await getEmergency(app.db, c.locationId, req.params.id)
      if (!em) throw new AppError('NOT_FOUND', { detail: 'That emergency closure does not exist' })
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const items = await listNeedsRebooking(app.db, {
        locationId: c.locationId,
        emergencyClosureId: em.id,
        tz,
      })
      return { items: items.map(affectedRow), count: items.length }
    },
  )
}
