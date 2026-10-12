// Staff routes of the memberships billed by Square (ADR 0171 wave Q3b; api-spec 30.11):
//   POST /memberships/:id/billing/{pause|resume|cancel|cancel/undo|change|change/undo}  cli.member; the Square call in the prepare hook
//   POST /memberships/:id/billing/card-link                                           cli.member; texts the client's card page
//   POST /memberships/:id/billing/refund-last                                         pay.refund, Idempotency-Key; RefundPayment
//   POST /catalog/tiers/:key/move-members {notice}                                     set.billing; "Move members" (plan decision 8)
//   POST /integrations/square/catalog/sync                                             set.billing; "Sync to Square" now
import type { FastifyRequest } from 'fastify'
import { access } from '../../../../http/access.js'
import { auditContextOf } from '../../../../http/authorizer.js'
import { idempotentHandler } from '../../../../http/idempotent.js'
import type { AppInstance } from '../../../../http/types.js'
import { z } from '../../../../http/zod.js'
import { transaction, type Executor } from '../../../../platform/db.js'
import { AppError } from '../../../../platform/errors.js'
import { squareApi, squareEnv } from '../../../square/runtime.js'
import { MembershipView } from '../../http/schemas.js'
import { locationTz, viewsOf, type MembershipRow } from '../../view.js'
import {
  prepareBillingAction,
  prepareRefundLast,
  recordBillingAction,
  recordRefundLast,
  textCardLink,
  type BillingAction,
  type PreparedAction,
  type PreparedRefund,
  type StaffActor,
} from '../actions.js'
import { runCatalogSync } from '../catalog-sync.js'
import { moveMembers } from '../moves.js'
import type { SquareSteps } from '../steps.js'
import '../problems.js'

const TAG = 'memberships'
const IdParams = z.object({ id: z.string().uuid() }).strict()
const KeyParams = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use a tier key such as gold') }).strict()
const Result = z.object({ membership: MembershipView })
const ChangeBody = z
  .object({
    planKey: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).describe('The tier to move to (its current price at the size)'),
    planClass: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional().describe('The size to price it at; absent keeps the membership’s size'),
  })
  .strict()
const Empty = z.object({}).strict()

const ACTIONS: Array<{ path: string; action: BillingAction; summary: string; description: string }> = [
  {
    path: 'pause',
    action: 'pause',
    summary: 'Pause a Square membership at its next billing date',
    description: 'PauseSubscription: Square pauses billing from the next billing date (until resumed); perks continue until then. Undo before it starts with resume.',
  },
  {
    path: 'resume',
    action: 'resume',
    summary: 'Resume a paused Square membership, or undo a pause still to come',
    description: 'A paused subscription resumes now (ResumeSubscription, IMMEDIATE); a pause still to come is removed (DeleteSubscriptionAction: Square refuses a resume before a pause starts).',
  },
  {
    path: 'cancel',
    action: 'cancel',
    summary: 'Cancel a Square membership at the end of the paid period',
    description: 'CancelSubscription: Square ends it on the next billing date (`billing.cancelAt`); the member keeps the perks until then. Undo with cancel/undo while it is scheduled.',
  },
  {
    path: 'cancel/undo',
    action: 'cancel_undo',
    summary: 'Undo a scheduled cancel of a Square membership',
    description: 'DeleteSubscriptionAction on the scheduled CANCEL: the membership keeps renewing.',
  },
  {
    path: 'change',
    action: 'change',
    summary: 'Change a Square membership’s tier or size at its next billing date',
    description:
      'SwapPlan to the current price of `planKey` at `planClass` (default: the membership’s size), which must be at Square (409 `TIER_PRICE_NOT_SYNCED`); any earlier scheduled swap is replaced. Square swaps at the next billing date (`billing.change.effectiveDate`); the membership follows when it does.',
  },
  {
    path: 'change/undo',
    action: 'change_undo',
    summary: 'Undo a scheduled tier or size change of a Square membership',
    description: 'DeleteSubscriptionAction on the scheduled SWAP_PLAN.',
  },
]

export function registerSquareMembershipRoutes(app: AppInstance): void {
  const auth = (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth
  }
  const steps = (req: FastifyRequest): SquareSteps => {
    const env = squareEnv()
    return { db: app.db, clock: app.clock, newId: app.newId, env, api: squareApi(env), locationId: auth(req).locationId, logger: req.log }
  }
  const actor = (req: FastifyRequest): StaffActor => {
    const a = auth(req)
    return { userId: a.userId, name: a.actorName ?? 'Staff', audit: auditContextOf(req) }
  }
  // inside an idempotent command only its transaction is used (a pool query there could deadlock a full pool)
  const view = async (req: FastifyRequest, row: MembershipRow, db: Executor = app.db) => {
    const locationId = auth(req).locationId
    const [v] = await viewsOf(db, { locationId, now: app.clock.now(), tz: await locationTz(db, locationId) }, [row])
    return v!
  }

  for (const a of ACTIONS)
    app.post(
      `/memberships/:id/billing/${a.path}`,
      {
        config: { access: access.perm('cli.member'), idempotency: 'optional' },
        schema: {
          tags: [TAG],
          summary: a.summary,
          description: `${a.description} Only a membership billed by Square (409 \`MEMBERSHIP_NOT_BILLED_BY_SQUARE\`); 409 \`MEMBERSHIP_BILLING_STATE\` when it does not fit the membership’s state; 409 \`SQUARE_WRITES_OFF\` in watch-only mode; 503 \`SQUARE_UNAVAILABLE\`. Audited \`membership.billing.${a.action}\`.`,
          params: IdParams,
          body: a.action === 'change' ? ChangeBody : Empty,
          response: { 200: Result },
        },
      },
      idempotentHandler<FastifyRequest, PreparedAction>(
        async (req, tx, _reply, p) => {
          const row = await recordBillingAction(tx, steps(req), p, actor(req))
          return { status: 200, body: { membership: await view(req, row, tx) } }
        },
        {
          prepare: (req) =>
            prepareBillingAction(steps(req), (req.params as { id: string }).id, a.action, {
              ...((req.body ?? {}) as { planKey?: string; planClass?: string }),
              by: actor(req).name,
            }),
        },
      ) as never,
    )

  app.post(
    '/memberships/:id/billing/card-link',
    {
      config: { access: access.perm('cli.member') },
      schema: {
        tags: [TAG],
        summary: 'Text the member a link to update the card of their Square membership',
        description:
          'Issues the client’s card page (personal link kind `card`, `#/k`, 24 hours) and texts it (template `personal_link_card`, the link stored masked). A card they save there for membership billing is put on the subscription by the job `square.enrollments.resume` (Square then retries a failed payment with it). `sms`: `queued`, or `skipped` (no consent, opted out, no number). 409 `MEMBERSHIP_BILLING_STATE` while personal links are closed. Audited `membership.billing.card_link`.',
        params: IdParams,
        body: Empty,
        response: { 200: Result.extend({ sms: z.enum(['queued', 'skipped']) }) },
      },
    },
    async (req) => {
      // the card page is a personal link page: nothing to text while they are closed
      if (!app.env.PUBLIC_LINKS_ENABLED)
        throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'Personal links are off, so a card link can’t be texted yet. Ask the client to call with a new card.' })
      const out = await transaction(app.db, (tx) => textCardLink(tx, steps(req), (req.params as { id: string }).id, actor(req)))
      return { membership: await view(req, out.row), sms: out.sms }
    },
  )

  app.post(
    '/memberships/:id/billing/refund-last',
    {
      config: { access: access.perm('pay.refund'), idempotency: 'required' },
      schema: {
        tags: [TAG],
        summary: 'Refund the last payment of a Square membership',
        description:
          'RefundPayment of the latest paid subscription invoice, in full, with the key rf_<invoice> (a repeat answers the same refund). The membership is not changed (cancel it separately). 409 `MEMBERSHIP_BILLING_STATE` when there is nothing (left) to refund; 409 `SQUARE_WRITES_OFF`; 503 `SQUARE_UNAVAILABLE`. Idempotency-Key required. Audited `membership.billing.refund`.',
        params: IdParams,
        body: Empty,
        response: { 200: Result.extend({ refund: z.object({ amountCents: z.number().int(), status: z.string() }) }) },
      },
    },
    idempotentHandler<FastifyRequest, PreparedRefund>(
      async (req, tx, _reply, p) => {
        const row = await recordRefundLast(tx, steps(req), p, actor(req))
        return { status: 200, body: { membership: await view(req, row, tx), refund: { amountCents: p.amountCents, status: p.status } } }
      },
      { prepare: (req) => prepareRefundLast(steps(req), (req.params as { id: string }).id) },
    ) as never,
  )

  app.post(
    '/catalog/tiers/:key/move-members',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: ['catalog'],
        summary: 'Move the tier’s Square members to its current prices, after a notice',
        description:
          'Plan decision 8: a price edit is grandfathered until this is pressed. Every member billed by Square at an older price of their size gets a scheduled move to the size’s current price and a notice by text and email; after `notice` days (default `memberships.price_change_notice_days`, 30) the job `square.plans.swap` sends SwapPlan, which Square applies at the next billing date. A member with a staff change scheduled is left alone (`skipped`). The current prices must be at Square (409 `TIER_PRICE_NOT_SYNCED`). Audited `catalog.tier.move_members`.',
        params: KeyParams,
        body: z.object({ notice: z.number().int().min(0).max(90).optional().describe('Days of notice (default 30)') }).strict(),
        response: { 200: z.object({ tierKey: z.string(), moving: z.number().int(), skipped: z.number().int(), swapAfter: z.string() }) },
      },
    },
    async (req) => {
      const x = steps(req)
      const body = req.body as { notice?: number }
      return transaction(app.db, (tx) =>
        moveMembers(tx, x, { tierKey: (req.params as { key: string }).key, noticeDays: body.notice, by: actor(req).name, audit: auditContextOf(req) }),
      )
    },
  )

  app.post(
    '/integrations/square/catalog/sync',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: ['square'],
        summary: 'Sync the membership prices to Square now',
        description:
          'Runs the catalog sync the job `square.catalog.sync` runs every 5 minutes: a Square plan per tier, a STATIC MONTHLY plan variation per current tier price (a price edit is a new variation; members keep theirs), a superseded price nobody used retired. `status: skipped` while SQUARE_WRITES_ENABLED is false. Failures are kept on the rows (`squareState: failed`) and the managers are told. Audited `square.catalog.sync`.',
        body: Empty,
        response: {
          200: z.object({
            status: z.enum(['skipped', 'done']),
            reason: z.string().optional(),
            plansCreated: z.number().int(),
            plansRenamed: z.number().int(),
            variationsCreated: z.number().int(),
            retired: z.number().int(),
            kept: z.number().int(),
            drift: z.number().int(),
            recreated: z.number().int(),
            failed: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const x = steps(req)
      return runCatalogSync(x, x.locationId)
    },
  )
}
