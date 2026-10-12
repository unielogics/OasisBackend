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
import { createInvoiceGateway } from '../../payments/gateway.js'
import { applyMembershipCredit } from '../apply.js'
import { historyFor, upgradeOf, visitCounts } from '../retention.js'
import '../problems.js'
import {
  checkoutCount,
  checkoutViews,
  confirmAwaitingMatch,
  listCheckouts,
  rejectAwaitingMatch,
  type CheckoutRow,
} from '../checkouts.js'
import { runMembershipPass } from '../jobs.js'
import {
  addHouseholdMember,
  createManualMembership,
  currentMembership,
  patchMembership,
  removeHouseholdMember,
  sharedMembership,
} from '../service.js'
import { locationTz, viewsOf, type MembershipRow } from '../view.js'
import { loadPlans } from '../plans.js'
import * as audit from '../../../platform/audit.js'
import {
  ApplyBody,
  ApplyResult,
  CheckoutDecisionBody,
  CheckoutDecisionResult,
  CheckoutListQuery,
  CheckoutListResult,
  CreateBody,
  CustomerMembership,
  HouseholdBody,
  HouseholdParams,
  IdParams,
  ListQuery,
  ListResult,
  MembershipResult,
  PatchBody,
  PlanRule,
  PlansResult,
  RuleParams,
  RulePatch,
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
  const invoices = createInvoiceGateway({ clock: app.clock, newId: app.newId })
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
      const held = await currentMembership(app.db, cust.id)
      // a client without a membership of their own may share one as a household member (ADR 0170)
      const shared = held && held.status !== 'canceled' ? undefined : await sharedMembership(app.db, cust.id)
      const row = shared?.row ?? held
      const [view] =
        row && row.location_id === c.locationId ? await viewsOf(app.db, { ...c, now, tz }, [row]) : []
      const live = view && view.status !== 'canceled'
      const counts = (await visitCounts(app.db, c.locationId, [cust.id], now)).get(cust.id)
      return {
        customerId: cust.id,
        membership: view ?? null,
        sharedFrom: shared && view ? { customerId: shared.row.customer_id, name: shared.holderName } : null,
        upgrade: live ? null : upgradeOf(cust.full_name, counts?.visits60 ?? 0),
        history: await historyFor(app.db, c.locationId, cust.id),
      }
    },
  )

  app.get(
    '/membership-plans',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: [TAG],
        summary: 'The membership tiers with what they include and each inclusion’s auto-apply flag',
        description:
          'Display data (perks, discount basis points), the member % off and the inclusions a visit can redeem (ADR 0170: each names the services it covers; `rules` is the same list under its old name). An inclusion with `autoApply` applies itself when a covered visit is completed.',
        response: { 200: PlansResult },
      },
    },
    async (req) => {
      const plans = await loadPlans(app.db, auth(req).locationId)
      return {
        plans: plans.map((p) => {
          const inclusions = p.inclusions.map((r) => ({
            id: r.id,
            label: r.label,
            mode: r.mode,
            perCycle: r.perCycle,
            autoApply: r.autoApply,
            active: r.active,
            serviceIds: r.serviceIds,
          }))
          return {
            id: p.id,
            key: p.key,
            name: p.name,
            active: p.active,
            perks: p.perks,
            addonDiscountBp: p.addonDiscountBp,
            serviceDiscountBp: p.serviceDiscountBp,
            memberDiscountBp: p.memberDiscountBp,
            vipBooking: p.vipBooking,
            inclusions,
            rules: inclusions,
          }
        }),
      }
    },
  )

  app.patch(
    '/membership-plans/rules/:id',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Turn an inclusion’s auto-apply on or off',
        description:
          'With it on, completing a visit the inclusion covers redeems one credit by itself (a system adjust on the invoice, one per appointment). The id is the inclusion’s (the credit rule’s id for one made from a rule, ADR 0170). Audited.',
        params: RuleParams,
        body: RulePatch,
        response: { 200: PlanRule },
      },
    },
    async (req) => {
      const a = auth(req)
      const body = req.body as z.infer<typeof RulePatch>
      return app.db.transaction().execute(async (tx) => {
        const rule = await tx
          .selectFrom('membership_inclusions as r')
          .innerJoin('membership_plans as p', 'p.id', 'r.plan_id')
          .select(['r.id', 'r.label', 'r.auto_apply', 'r.mode', 'r.per_cycle', 'r.active'])
          .where('r.id', '=', req.params.id)
          .where('p.location_id', '=', a.locationId)
          .forUpdate('r')
          .executeTakeFirst()
        if (!rule) throw new AppError('NOT_FOUND', { detail: 'That inclusion does not exist' })
        await tx
          .updateTable('membership_inclusions')
          .set((eb) => ({ auto_apply: body.autoApply, updated_at: eb.fn('app_now', []) }))
          .where('id', '=', rule.id)
          .execute()
        await audit.record(tx, {
          locationId: a.locationId,
          action: 'membership.rule.update',
          entityType: 'membership_inclusion',
          entityId: rule.id,
          before: { autoApply: rule.auto_apply },
          after: { autoApply: body.autoApply, label: rule.label },
          ctx: auditContextOf(req),
        })
        const services = await tx
          .selectFrom('membership_inclusion_services')
          .select('service_id')
          .where('inclusion_id', '=', rule.id)
          .orderBy('service_id')
          .execute()
        return {
          id: rule.id,
          label: rule.label,
          mode: rule.mode,
          perCycle: rule.mode === 'every_visit' ? null : rule.per_cycle,
          autoApply: body.autoApply,
          active: rule.active,
          serviceIds: services.map((x) => x.service_id),
        }
      })
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
      // a tier by its key or its old key (premium = gold, executive = vip: ADR 0170)
      if (q.plan) {
        const plan = q.plan
        base = base.where((eb) => eb.or([eb('p.key', '=', plan), eb('p.legacy_key', '=', plan)]))
      }
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
          'Creates an active manual membership with this cycle’s credits. It holds against the Squarespace inference until a newer paid subscription order arrives. On a record the stale-record rule holds (180 days without proof of the client, or a bounce as an invalid number: whoever has the number now may be a new holder of it) 409 `MEMBERSHIP_CLIENT_UNCONFIRMED`: staff confirm the client first (`POST /customers/:id/identity/confirm`), or create a new client.',
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
            planClass: b.planClass ?? null,
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
          'For when the Squarespace subscription data is missing or wrong. The edit holds against the inference until a newer paid order arrives; a tier change starts the new plan’s credits for the current cycle. Audited. An edit that leaves the membership active, past due or paused on a record the stale-record rule holds: 409 `MEMBERSHIP_CLIENT_UNCONFIRMED` (confirm the client first, `POST /customers/:id/identity/confirm`); canceling is allowed.',
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
            planClass: b.planClass,
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

  // ---- households (ADR 0170) ------------------------------------------------------------------------------------------

  app.post(
    '/memberships/:id/household',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Add a client to a membership’s household',
        description:
          'The client is then priced and covered as the member (ADR 0170): the member % off, the inclusions up to the plan size’s price, the website’s member privileges once they verify; the membership’s credits are shared. A client who holds a live membership or shares another: 409 `MEMBERSHIP_HOUSEHOLD_TAKEN`. A record the stale-record rule holds: 409 `MEMBERSHIP_CLIENT_UNCONFIRMED` (confirm the client first). Adding a client already in the household changes nothing. Audited (`membership.household.add`).',
        params: IdParams,
        body: HouseholdBody,
        response: { 200: MembershipResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const c = dctx(req)
      const b = req.body as z.infer<typeof HouseholdBody>
      const tz = await locationTz(app.db, c.locationId)
      const r = await app.db.transaction().execute((tx) =>
        addHouseholdMember(tx, c, req.params.id, b.customerId, {
          userId: a.userId,
          name: a.actorName ?? 'Unknown',
          audit: auditContextOf(req),
        }),
      )
      const [view] = await viewsOf(app.db, { ...c, now: app.clock.now(), tz }, [r.row])
      return { membership: view! }
    },
  )

  app.delete(
    '/memberships/:id/household/:customerId',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Remove a client from a membership’s household',
        description:
          'From now on the client is priced as anyone else; visits already covered stay covered. 404 when the client is not in the household. Audited (`membership.household.remove`).',
        params: HouseholdParams,
        response: { 200: MembershipResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const c = dctx(req)
      const p = req.params as z.infer<typeof HouseholdParams>
      const tz = await locationTz(app.db, c.locationId)
      const row = await app.db.transaction().execute((tx) =>
        removeHouseholdMember(tx, c, p.id, p.customerId, {
          userId: a.userId,
          name: a.actorName ?? 'Unknown',
          audit: auditContextOf(req),
        }),
      )
      const [view] = await viewsOf(app.db, { ...c, now: app.clock.now(), tz }, [row])
      return { membership: view! }
    },
  )

  // ---- membership checkouts (ADR 0160): orders waiting for staff, personal-link checkouts ------------------------------

  const checkoutOut = async (row: CheckoutRow) => {
    const [view] = await checkoutViews(app.db, [row])
    const cust = await app.db.selectFrom('customers').select('full_name').where('id', '=', row.customer_id).executeTakeFirst()
    const { customerId, ...rest } = view!
    return { ...rest, customer: { id: customerId, name: cust?.full_name ?? '' } }
  }

  app.get(
    '/membership-checkouts',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Membership checkouts: personal-link checkouts and paid orders waiting for staff to match',
        description:
          'Newest first, optionally of one state. A row in `awaiting_match` is a paid Squarespace membership order whose email matches the client only through an email nobody verified (ADR 0160): confirm it with the client, then match or reject it.',
        querystring: CheckoutListQuery,
        response: { 200: CheckoutListResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const q = req.query as z.infer<typeof CheckoutListQuery>
      const rows = await listCheckouts(app.db, a.locationId, { state: q.state, limit: q.limit })
      return {
        items: rows.map(({ customerId, customerName, ...rest }) => ({ ...rest, customer: { id: customerId, name: customerName } })),
        awaitingMatch: await checkoutCount(app.db, a.locationId, 'awaiting_match'),
      }
    },
  )

  for (const [verb, decide, summary, description] of [
    [
      'match',
      confirmAwaitingMatch,
      'Match a waiting Squarespace order to this client (staff confirmed it with them)',
      'Only a row in `awaiting_match`. The row becomes `matched`, the membership pass runs at once and links the order (and the same email’s later renewals of the plan) to the client, so the membership activates when the order is paid. Audited; closes the alert.',
    ],
    [
      'reject',
      rejectAwaitingMatch,
      'Reject a waiting Squarespace order: it is not this client’s',
      'Only a row in `awaiting_match`. The row becomes `rejected` and the order goes back to "needs a customer"; a pending membership the sync opened only for it is canceled. Audited; closes the alert.',
    ],
  ] as const) {
    app.post(
      `/membership-checkouts/:id/${verb}`,
      {
        config: { access: access.perm('cli.member') },
        schema: {
          tags: [TAG],
          summary,
          description,
          params: IdParams,
          body: CheckoutDecisionBody,
          response: { 200: CheckoutDecisionResult },
        },
      },
      async (req) => {
        const c = dctx(req)
        const b = req.body as z.infer<typeof CheckoutDecisionBody>
        const row = await app.db
          .transaction()
          .execute((tx) => decide(tx, c, (req.params as { id: string }).id, { audit: auditContextOf(req), note: b.note ?? null }))
        if (verb === 'match') await runMembershipPass(app.db, app.clock, c.locationId, app.env)
        const fresh = await app.db.selectFrom('membership_checkouts').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow()
        const m = await app.db.selectFrom('memberships').selectAll().where('id', '=', fresh.membership_id).executeTakeFirst()
        const tz = await locationTz(app.db, c.locationId)
        const [view] = m ? await viewsOf(app.db, { ...c, now: app.clock.now(), tz }, [m]) : []
        return { checkout: await checkoutOut(fresh), membership: view ?? null }
      },
    )
  }

  app.post(
    '/appointments/:id/membership-perks/apply',
    {
      config: { access: access.perm('cli.member'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Apply the membership to this visit: what its inclusions cover, written once',
        description:
          'Settles the visit (ADR 0170): the client holds or shares (household) an active membership; each inclusion with a credit left (or every-visit, or unlimited) covers one line, up to the price at the plan size, so a larger car’s size difference stays due. The lines are priced again first (a covered line at the regular price, the others at the member price). Then one system adjust event (reason “Membership credit”) and one redeem per covered line, exempt from the caller’s adjust limit, attributed to the caller; `lines` lists them, `discountCents` is the total covered, `event` is the first adjust and `invoice` the invoice after the last. ' +
          'Refused: no live membership 404 `MEMBERSHIP_NOT_FOUND`, not active 409 `MEMBERSHIP_NOT_ACTIVE`, already applied 409 `MEMBERSHIP_CREDIT_APPLIED`, nothing covered 409 `MEMBERSHIP_NOT_ELIGIBLE` / `MEMBERSHIP_NO_CREDIT`, no balance 409 `MEMBERSHIP_NO_BALANCE`, a reprice that would leave the invoice overpaid 409 `PRICE_CHANGE_OVERPAID`.',
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
          { ...dctx(req), payments, invoices },
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
