// /ops/*, /calendar/*, /availability, /bays, /staff: the read side of Operations.
import { access } from '../../../http/access.js'
import { z } from '../../../http/zod.js'
import type { AppInstance } from '../../../http/types.js'
import { AppError } from '../../../platform/errors.js'
import { canSeeContact } from '../../people/redact.js'
import { getAvailability } from '../availability-loader.js'
import { loadAlerts } from '../alerts.js'
import { listBays, getBay } from '../appointments.js'
import { calendarDay, calendarSummary } from '../calendar.js'
import { loadKpis } from '../kpis.js'
import type { SchedulingPorts } from '../ports.js'
import { loadSnapshot } from '../snapshot.js'
import { listBayStaff } from '../staff.js'
import { audit } from '../audit-helper.js'
import { publishOps } from '../appointments.js'
import { advisoryXactLock } from '../../../platform/db.js'
import { Alert, Availability, BayView, BizDate, CalendarDay, CalendarSummary, Kpi, OpsSnapshot, StaffView, Uuid } from './schemas.js'
import { actorOf, ctxOf } from './shared.js'

const TAGS = ['operations']

export function registerOpsRoutes(app: AppInstance, ports: SchedulingPorts): void {
  app.get(
    '/ops/snapshot',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'The Operations board in one call',
        description:
          'KPIs, alerts, bays and arrivals ignore `q` and `window`; the timeline, completed column, Up Next queue and staff columns follow both. `window`: next24 = today + tomorrow, today, tomorrow, week = today through today + 6. Phone numbers are only searched with cli.contact.',
        querystring: z.object({
          window: z.enum(['next24', 'today', 'tomorrow', 'week']).default('next24'),
          q: z.string().max(100).optional(),
        }),
        response: { 200: OpsSnapshot },
      },
    },
    async (req) =>
      loadSnapshot(app.db, await ctxOf(app, req, ports), {
        window: req.query.window,
        q: req.query.q,
        canContact: canSeeContact(req.auth!),
        manager: req.auth!.permissions.has('*') || req.auth!.permissions.has('set.billing'),
      }),
  )

  app.get(
    '/ops/kpis',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'The seven KPI tiles',
        response: { 200: z.object({ kpis: z.array(Kpi) }) },
      },
    },
    async (req) => ({ kpis: await loadKpis(app.db, await ctxOf(app, req, ports)) }),
  )

  app.get(
    '/ops/alerts',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Needs attention: the alerts, in the design order',
        response: { 200: z.object({ alerts: z.array(Alert) }) },
      },
    },
    async (req) => ({
      alerts: await loadAlerts(app.db, await ctxOf(app, req, ports), {
        manager: req.auth!.permissions.has('*') || req.auth!.permissions.has('set.billing'),
      }),
    }),
  )

  app.get(
    '/calendar/summary',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Appointment counts and closures per date (week and month grids)',
        description: 'Inclusive business dates, at most 70 days. Closed days include today.',
        querystring: z.object({ from: BizDate, to: BizDate }),
        response: { 200: CalendarSummary },
      },
    },
    async (req) => calendarSummary(app.db, await ctxOf(app, req, ports), req.query),
  )

  app.get(
    '/calendar/day',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'One day: open window, hour rows, and bookings the rows cannot show',
        querystring: z.object({ date: BizDate }),
        response: { 200: CalendarDay },
      },
    },
    async (req) => calendarDay(app.db, await ctxOf(app, req, ports), req.query.date),
  )

  app.get(
    '/availability',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Slot states of a date for a package',
        description:
          'States: available, blocked (would overbook a bay), vip_held (with releasesAt), closed, past, cutoff, outside_window (online only). `customerId` makes VIP holds and windows apply to that client. Add-ons never change the duration.',
        querystring: z.object({
          date: BizDate,
          serviceId: Uuid,
          channel: z.enum(['desk', 'online']).default('desk'),
          customerId: Uuid.optional(),
          excludeAppointmentId: Uuid.optional(),
        }),
        response: { 200: Availability },
      },
    },
    async (req) => {
      const c = await ctxOf(app, req, ports)
      const r = await getAvailability(app.db, {
        locationId: c.locationId,
        tz: c.tz,
        now: c.clock.now(),
        date: req.query.date,
        serviceId: req.query.serviceId,
        channel: req.query.channel,
        customerId: req.query.customerId,
        excludeAppointmentId: req.query.excludeAppointmentId,
      })
      return {
        date: r.date,
        channel: r.channel,
        isVip: r.isVip,
        closed: r.closed,
        reason: r.reason,
        openMin: r.openMin,
        closeMin: r.closeMin,
        durationMin: r.durationMin,
        slotMinutes: r.slotMinutes,
        releaseHours: r.releaseHours,
        slots: r.slots.map((s) => ({
          time: s.label,
          startMin: s.startMin,
          start: s.start.toISOString(),
          endsAt: s.endsAt.toISOString(),
          state: s.state,
          ...(s.reason ? { reason: s.reason } : {}),
          baysFree: s.baysFree,
          overridable: s.overridable,
          overrideKind: s.overrideKind,
          ...(s.releasesAt ? { releasesAt: s.releasesAt.toISOString() } : {}),
          sameDayEligible: s.sameDayEligible,
        })),
      }
    },
  )

  app.get(
    '/bays',
    {
      config: { access: access.perm('sched.view') },
      schema: { tags: TAGS, summary: 'Bays and their status', response: { 200: z.object({ items: z.array(BayView) }) } },
    },
    async (req) => ({ items: await listBays(app.db, (await ctxOf(app, req, ports)).locationId) }),
  )

  app.patch(
    '/bays/:id',
    {
      config: { access: access.perm('sched.override') },
      schema: {
        tags: TAGS,
        summary: 'Put a bay in or out of service',
        description: 'A bay in maintenance or blocked counts as zero capacity. A bay with a car in it cannot be taken out of service.',
        params: z.object({ id: Uuid }),
        body: z.object({ status: z.enum(['active', 'maintenance', 'blocked']) }).strict(),
        response: { 200: BayView },
      },
    },
    async (req) => {
      const c = await ctxOf(app, req, ports)
      const actor = actorOf(req)
      return app.db.transaction().execute(async (tx) => {
        await advisoryXactLock(tx, `bays:${c.locationId}`)
        const bay = await getBay(tx, c.locationId, req.params.id)
        if (!bay) throw new AppError('NOT_FOUND', { detail: 'That bay does not exist' })
        if (req.body.status !== 'active') {
          const occ = await tx
            .selectFrom('appointments')
            .select('id')
            .where('bay_id', '=', bay.id)
            .where('status', '=', 'cleaning')
            .executeTakeFirst()
          if (occ)
            throw new AppError('BAY_BUSY', { params: { n: bay.number }, detail: 'Finish the current vehicle first' })
        }
        if (bay.status !== req.body.status) {
          await tx.updateTable('bays').set({ status: req.body.status }).where('id', '=', bay.id).execute()
          await audit(tx, c, actor, 'bay.status', bay.id, { status: bay.status }, { status: req.body.status })
          await publishOps(tx, c.locationId, { bayIds: [bay.id], availability: [] })
        }
        return { ...bay, status: req.body.status }
      })
    },
  )

  app.get(
    '/staff',
    {
      config: { access: access.perm('sched.view') },
      schema: {
        tags: TAGS,
        summary: 'Assignable employees (bay staff: Crew role or jobs.status), without the Unassigned pseudo-column',
        response: { 200: z.object({ items: z.array(StaffView) }) },
      },
    },
    async (req) => ({
      items: (await listBayStaff(app.db, (await ctxOf(app, req, ports)).locationId)).map((s) => ({
        id: s.id,
        name: s.name,
        initials: s.initials,
        title: s.title,
        avatarColor: s.avatarColor,
      })),
    }),
  )
}
