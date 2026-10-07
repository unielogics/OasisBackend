// Memberships HTTP API. Reads: cli.view (the client file) and cli.member (the list). Writes need cli.member; applying a credit is
// money-effecting (a system adjust on the invoice) so it also needs an Idempotency-Key.
import { sql } from 'kysely'
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import type { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { decodeCursor, keysetCondition, toPage } from '../../../platform/pagination.js'
import { wallToInstant } from '../../../platform/time.js'
import { actorFromAuth } from '../../payments/actor.js'
import { PaymentsService } from '../../payments/commands.js'
import { defaultPorts } from '../../payments/ports.js'
import { applyMembershipCredit } from '../apply.js'
import { historyFor, upgradeOf, visitCounts } from '../retention.js'
import '../problems.js'
import { createManualMembership, currentMembership, patchMembership } from '../service.js'
import { locationTz, viewsOf, type MembershipRow } from '../view.js'
import {
  ApplyBody,
  ApplyResult,
  CreateBody,
  CustomerMembership,
  IdParams,
  ListQuery,
  ListResult,
  MembershipResult,
  PatchBody,
} from './schemas.js'

const TAG = 'memberships'

export function registerMembershipRoutes(app: AppInstance): void {
  const auth = (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth
  }
  const dctx = (req: FastifyRequest) => ({
    locationId: auth(req).locationId,
    clock: app.clock,
    newId: app.newId,
  })
  const payments = new PaymentsService({ clock: app.clock, newId: app.newId, ports: defaultPorts() })
  const idem = (fn: Parameters<typeof idempotentHandler<FastifyRequest>>[0]): never =>
    idempotentHandler(fn) as never

  app.get(
    '/customers/:id/membership',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: [TAG],
        summary:
          'A client’s membership: plan, credits, renewal, perks, retention, history and upgrade candidacy',
        description:
          'Everything the Membership and History tabs show, computed from the member row, the cycle credit events and real visit history. ' +
          'Retention compares completed visits in the last 30 days with the 30 before. A non-member with 3 or more completed visits in 60 days is an upgrade candidate. ' +
          'Percent perks are display data only.',
        params: IdParams,
        response: { 200: CustomerMembership },
      },
    },
    async (req) => {
      const c = dctx(req)
      const cust = await app.db
        .selectFrom('customers')
        .select(['id', 'full_name'])
        .where('id', '=', req.params.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
      if (!cust) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
      const now = app.clock.now()
      const tz = await locationTz(app.db, c.locationId)
      const row = await currentMembership(app.db, cust.id)
      const [view] =
        row && row.location_id === c.locationId ? await viewsOf(app.db, { ...c, now, tz }, [row]) : []
      const live = view && view.status !== 'canceled'
      const counts = (await visitCounts(app.db, c.locationId, [cust.id], now)).get(cust.id)
      return {
        customerId: cust.id,
        membership: view ?? null,
        upgrade: live ? null : upgradeOf(cust.full_name, counts?.visits60 ?? 0),
        history: await historyFor(app.db, c.locationId, cust.id),
      }
    },
  )

  app.get(
    '/memberships',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Members with plan, status, renewal date and credits left, with a count per status',
        querystring: ListQuery,
        response: { 200: ListResult },
      },
    },
    async (req) => {
      const c = dctx(req)
      const q = req.query
      let base = app.db
        .selectFrom('memberships as m')
        .innerJoin('customers as cu', 'cu.id', 'm.customer_id')
        .innerJoin('membership_plans as p', 'p.id', 'm.plan_id')
        .where('m.location_id', '=', c.locationId)
      if (q.status) base = base.where('m.status', '=', q.status)
      if (q.plan) base = base.where('p.key', '=', q.plan)
      if (q.q) base = base.where('cu.full_name', 'ilike', `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
      let page = base.selectAll('m').select('cu.full_name as customer_name')
      if (q.cursor) {
        const [name, id] = decodeCursor(q.cursor, 2)
        page = page.where(keysetCondition(['cu.full_name', 'm.id'], [name as string, id as string], 'asc'))
      }
      const rows = await page
        .orderBy('cu.full_name')
        .orderBy('m.id')
        .limit(q.limit + 1)
        .execute()
      const paged = toPage(rows, q.limit, (r) => [r.customer_name, r.id])
      const tz = await locationTz(app.db, c.locationId)
      const views = await viewsOf(app.db, { ...c, now: app.clock.now(), tz }, paged.items as MembershipRow[])
      const counts = await sql<{ status: string; n: number }>`
        select status, count(*)::int as n from memberships where location_id = ${c.locationId} group by status`.execute(
        app.db,
      )
      const by = (s: string) => counts.rows.find((x) => x.status === s)?.n ?? 0
      return {
        items: views.map((v, i) => ({
          ...v,
          customer: { id: v.customerId, name: paged.items[i]!.customer_name },
        })),
        nextCursor: paged.nextCursor,
        counts: {
          pending: by('pending'),
          active: by('active'),
          past_due: by('past_due'),
          paused: by('paused'),
          canceled: by('canceled'),
        },
      }
    },
  )

  app.post(
    '/memberships',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Add a member by hand (when there is no Squarespace subscription data)',
        description:
          'Creates an active manual membership with this cycle’s credits. It holds against the Squarespace inference until a newer paid subscription order arrives.',
        body: CreateBody,
        response: { 201: MembershipResult },
      },
    },
    async (req, reply) => {
      const a = auth(req)
      const c = dctx(req)
      const b = req.body as z.infer<typeof CreateBody>
      const tz = await locationTz(app.db, c.locationId)
      const row = await app.db.transaction().execute((tx) =>
        createManualMembership(
          tx,
          c,
          {
            customerId: b.customerId,
            planKey: b.planKey,
            planLabel: b.planLabel,
            renewsAt: b.renewsOn ? wallToInstant(b.renewsOn, 12 * 60, tz) : undefined,
          },
          { userId: a.userId, name: a.actorName ?? 'Unknown', audit: auditContextOf(req) },
        ),
      )
      reply.status(201)
      const [view] = await viewsOf(app.db, { ...c, now: app.clock.now(), tz }, [row])
      return { membership: view! }
    },
  )

  app.patch(
    '/memberships/:id',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Manual override of a membership’s status, tier, renewal date or auto-apply flag',
        description:
          'For when the Squarespace subscription data is missing or wrong. The edit holds against the inference until a newer paid order arrives; a tier change starts the new plan’s credits for the current cycle. Audited.',
        params: IdParams,
        body: PatchBody,
        response: { 200: MembershipResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const c = dctx(req)
      const b = req.body as z.infer<typeof PatchBody>
      const tz = await locationTz(app.db, c.locationId)
      const row = await app.db.transaction().execute((tx) =>
        patchMembership(
          tx,
          c,
          req.params.id,
          {
            status: b.status,
            planKey: b.planKey,
            planLabel: b.planLabel,
            renewsAt: b.renewsOn ? wallToInstant(b.renewsOn, 12 * 60, tz) : undefined,
            autoApply: b.autoApply,
            note: b.note,
            expectedVersion: b.expectedVersion,
          },
          { userId: a.userId, name: a.actorName ?? 'Unknown', audit: auditContextOf(req) },
        ),
      )
      const [view] = await viewsOf(app.db, { ...c, now: app.clock.now(), tz }, [row])
      return { membership: view! }
    },
  )

  app.post(
    '/appointments/:id/membership-perks/apply',
    {
      config: { access: access.perm('cli.member'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Apply one membership credit to this appointment’s invoice',
        description:
          'Creates a system adjust event (reason “Membership credit”) equal to the package line, exempt from the caller’s adjust limit, attributed to the caller. ' +
          'The member must be active, the plan must have an unused credit covering the service, and the invoice must have a balance. Percent perks are never applied.',
        params: IdParams,
        body: ApplyBody,
        response: { 201: ApplyResult },
      },
    },
    idem(async (req, tx) => {
      const a = auth(req)
      const key = req.headers['idempotency-key']
      return {
        status: 201,
        body: await applyMembershipCredit(
          tx,
          { ...dctx(req), payments },
          { appointmentId: (req.params as { id: string }).id },
          {
            actor: actorFromAuth(a),
            audit: auditContextOf(req),
            idempotencyKey: typeof key === 'string' ? key : null,
          },
        ),
      }
    }),
  )
}
