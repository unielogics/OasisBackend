// Staff actions on a membership billed by Square (ADR 0171 wave Q3b, design 5.6; cli.member, refunds pay.refund). The Square call
// runs in the route's prepare hook (after the Idempotency-Key is claimed, before the transaction, never under a row lock); the
// transaction then records what Square answered and audits it. What Square schedules takes effect at the next billing date (sandbox
// 2026-10-12): a pause, a cancel at the period end, a tier or size change (SwapPlan). Undo removes the scheduled action
// (DeleteSubscriptionAction); a paused membership is resumed at once.
import type { SquareApi } from '../../../integrations/ports/square.js'
import { SquareApiError } from '../../../integrations/square/errors.js'
import { sqKey } from '../../../integrations/square/keys.js'
import { usd } from '../../../integrations/square/money.js'
import type { WireSubscription, WireSubscriptionAction } from '../../../integrations/square/wire.js'
import * as audit from '../../../platform/audit.js'
import type { AuditContext } from '../../../platform/audit.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { issueClientLink } from '../../identity/links.js'
import { messagingConfig } from '../../messaging/config.js'
import { loadCustomerTarget } from '../../messaging/db/recipients.js'
import { DbMessageQueue } from '../../messaging/queue.js'
import { squareProblem, squareWritesOn } from '../../square/links.js'
import { resolvePlanClass } from '../plan-class.js'
import { loadPlans, planByKey } from '../plans.js'
import type { ScheduledChange } from '../schema.js'
import type { MembershipRow } from '../view.js'
import { scheduledAtSquare } from './policy.js'
import type { SquareSteps } from './steps.js'
import './problems.js'

export type BillingAction = 'pause' | 'resume' | 'cancel' | 'cancel_undo' | 'change' | 'change_undo'

export interface StaffActor {
  userId: string
  name: string
  audit: AuditContext
}

/** A Square membership of the location, or 404 / 409 MEMBERSHIP_NOT_BILLED_BY_SQUARE. */
export async function squareMembership(db: Executor, locationId: string, id: string): Promise<MembershipRow> {
  const m = await db.selectFrom('memberships').selectAll().where('id', '=', id).where('location_id', '=', locationId).executeTakeFirst()
  if (!m) throw new AppError('MEMBERSHIP_NOT_FOUND')
  if (m.source !== 'square' || !m.square_subscription_id) throw new AppError('MEMBERSHIP_NOT_BILLED_BY_SQUARE')
  return m
}

const swaps = (sub: { actions?: WireSubscriptionAction[] | null }) => (sub.actions ?? []).filter((a) => a.type === 'SWAP_PLAN')

/**
 * Replaces any scheduled plan swap with one to `variationId` (at the next billing date). Used by Change and by "Move members". A
 * swap to that variation already scheduled is kept as it is: deleting it and sending the same swap again leaves the subscription
 * "locked and not billable" for SwapPlan at Square (sandbox 2026-10-12, still after 6 minutes), while a swap to another variation
 * after the delete is accepted.
 */
export async function replaceSwap(api: SquareApi, subscriptionId: string, variationId: string): Promise<{ subscription: WireSubscription; action: WireSubscriptionAction | null }> {
  const cur = await api.subscriptions.retrieve(subscriptionId, { includeActions: true })
  const same = swaps(cur).find((a) => a.new_plan_variation_id === variationId)
  if (same) return { subscription: cur, action: same }
  for (const a of swaps(cur)) await whenFree(() => api.subscriptions.deleteAction(subscriptionId, a.id))
  const r = await whenFree(() => api.subscriptions.swapPlan(subscriptionId, { new_plan_variation_id: variationId }))
  return { subscription: r.subscription, action: r.actions.find((a) => a.type === 'SWAP_PLAN') ?? null }
}

const detailOf = (e: SquareApiError): string => e.errors.map((x) => x.detail ?? '').join(' ')

/** Square's 500 "Subscription … is locked and is not billable" (see replaceSwap): not an outage, a refusal of this change. */
export const lockedAtSquare = (e: unknown): boolean => e instanceof SquareApiError && e.status === 500 && /locked/i.test(detailOf(e))

/** Square's 409 CONFLICT "Unable to lock subscription": another change of it is still being made (seconds; sandbox 2026-10-12). */
export const busyAtSquare = (e: unknown): boolean => e instanceof SquareApiError && e.status === 409 && /unable to lock/i.test(detailOf(e))

/**
 * A subscription change Square answered "busy" (409 Unable to lock) is sent again, at most twice, 1.5 s apart: the change was not made,
 * so sending it again is safe (none of these calls carries a key; a repeat of one that did go through answers an "already" code).
 */
export async function whenFree<T>(fn: () => Promise<T>, o: { tries?: number; waitMs?: number } = {}): Promise<T> {
  const tries = o.tries ?? 3
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!busyAtSquare(e) || i >= tries) throw e
      await new Promise((r) => setTimeout(r, o.waitMs ?? 1500))
    }
  }
}

export interface PreparedAction {
  action: BillingAction
  membershipId: string
  /** What Square has scheduled after the call. */
  cancelAt: string | null
  pauseAt: string | null
  squareStatus: string | null
  change: ScheduledChange | null
  /** change_undo: the variations whose swap was removed (never sent again this billing period). */
  undoneVariations: string[]
}

/**
 * The Square side of a staff action (the route's prepare hook). 409 SQUARE_WRITES_OFF in watch-only mode, 503 SQUARE_UNAVAILABLE
 * when Square does not answer, 409 MEMBERSHIP_BILLING_STATE when the membership is not in a state the action fits.
 */
export async function prepareBillingAction(
  x: SquareSteps,
  membershipId: string,
  action: BillingAction,
  o: { planKey?: string; planClass?: string; by: string } = { by: 'Staff' },
): Promise<PreparedAction> {
  const m = await squareMembership(x.db, x.locationId, membershipId)
  if (!squareWritesOn(x.env)) throw new AppError('SQUARE_WRITES_OFF')
  const subId = m.square_subscription_id!
  const state = (detail: string) => new AppError('MEMBERSHIP_BILLING_STATE', { detail })
  if (m.status === 'canceled' || m.status === 'pending') throw state('This membership is not running.')
  let change: ScheduledChange | null = (m.scheduled_change as ScheduledChange | null) ?? null
  const undone: string[] = []
  let sub: WireSubscription
  try {
    switch (action) {
      case 'pause': {
        if (m.status !== 'active') throw state('Only an active membership can be paused.')
        if (m.pause_effective_at) throw state('A pause is already scheduled.')
        await whenFree(() => x.api.subscriptions.pause(subId, {}))
        break
      }
      case 'resume': {
        const cur = await x.api.subscriptions.retrieve(subId, { includeActions: true })
        const pause = (cur.actions ?? []).find((a) => a.type === 'PAUSE')
        if (cur.status === 'PAUSED') await whenFree(() => x.api.subscriptions.resume(subId, { resume_change_timing: 'IMMEDIATE' }))
        // a pause still to come is undone (Square refuses a resume before it starts: INVALID_DATE)
        else if (pause) await whenFree(() => x.api.subscriptions.deleteAction(subId, pause.id))
        else throw state('This membership is not paused.')
        break
      }
      case 'cancel': {
        if (m.cancel_effective_at) throw state('A cancel is already scheduled.')
        await whenFree(() => x.api.subscriptions.cancel(subId))
        break
      }
      case 'cancel_undo': {
        const cur = await x.api.subscriptions.retrieve(subId, { includeActions: true })
        const c = (cur.actions ?? []).find((a) => a.type === 'CANCEL')
        if (!c) throw state('No cancel is scheduled.')
        await whenFree(() => x.api.subscriptions.deleteAction(subId, c.id))
        break
      }
      case 'change': {
        const plans = await loadPlans(x.db, x.locationId)
        const plan = planByKey(plans, o.planKey ?? '')
        if (!plan || !plan.active) throw new AppError('VALIDATION_FAILED', { detail: 'Pick one of the membership tiers.', errors: [{ path: 'body.planKey', message: 'Pick one of the membership tiers.' }] })
        const size = await resolvePlanClass(x.db, x.locationId, plan.id, { requested: o.planClass ?? m.plan_class, requirePrice: true, path: 'body.planClass' })
        const price = await x.db
          .selectFrom('membership_tier_prices')
          .select(['id', 'monthly_cents', 'square_variation_id', 'square_state'])
          .where('id', '=', size.tierPriceId!)
          .executeTakeFirstOrThrow()
        if (price.square_state !== 'synced' || !price.square_variation_id) throw new AppError('TIER_PRICE_NOT_SYNCED')
        if (price.id === m.tier_price_id) throw state('The membership is on that plan and size already.')
        if (m.swap_undone_variations.includes(price.square_variation_id)) throw state(UNDONE)
        const r = await replaceSwap(x.api, subId, price.square_variation_id)
        change = {
          kind: 'change',
          toTierPriceId: price.id,
          fromTierPriceId: m.tier_price_id,
          planKey: plan.key,
          planClass: size.classKey,
          monthlyCents: price.monthly_cents,
          effectiveDate: r.action?.effective_date ?? null,
          requestedAt: x.clock.now().toISOString(),
          by: o.by,
        }
        break
      }
      case 'change_undo': {
        const cur = await x.api.subscriptions.retrieve(subId, { includeActions: true })
        const s = swaps(cur)
        if (s.length === 0 && !change) throw state('No change is scheduled.')
        for (const a of s) {
          await whenFree(() => x.api.subscriptions.deleteAction(subId, a.id))
          if (a.new_plan_variation_id) undone.push(a.new_plan_variation_id)
        }
        change = null
        break
      }
    }
    sub = await x.api.subscriptions.retrieve(subId, { includeActions: true })
  } catch (e) {
    if (e instanceof AppError) throw e
    x.logger?.warn({ membership: m.id, action, err: e instanceof Error ? e.message : String(e) }, 'square: membership action failed')
    if (e instanceof SquareApiError && e.status === 400) throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'Square refused it for this subscription right now.' })
    if (lockedAtSquare(e))
      throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'Square won’t schedule that same change again right after it was undone. Try again later, or pick another plan or size.' })
    if (busyAtSquare(e)) throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'Square is still working on this membership. Try again in a minute.' })
    throw squareProblem(e)
  }
  const sched = scheduledAtSquare(sub)
  return { action, membershipId: m.id, cancelAt: sched.cancelAt, pauseAt: sched.pauseAt, squareStatus: sub.status, change, undoneVariations: undone }
}

const UNDONE =
  'That change was undone this billing period, and Square won’t take the same change again until the next billing date. Pick another plan or size, or try after the next billing date.'

/** The transaction of a staff action: what Square now has scheduled, audited. */
export async function recordBillingAction(tx: Tx, x: Pick<SquareSteps, 'clock' | 'locationId'>, p: PreparedAction, actor: StaffActor): Promise<MembershipRow> {
  const cur = await tx.selectFrom('memberships').selectAll().where('id', '=', p.membershipId).forUpdate().executeTakeFirstOrThrow()
  const now = x.clock.now()
  const status = p.action === 'resume' && cur.status === 'paused' && p.squareStatus === 'ACTIVE' ? 'active' : cur.status
  const row = await tx
    .updateTable('memberships')
    .set((eb) => ({
      status,
      cancel_effective_at: p.cancelAt,
      pause_effective_at: p.pauseAt,
      ...(p.squareStatus ? { square_status: p.squareStatus } : {}),
      ...(p.action === 'change' || p.action === 'change_undo' ? { scheduled_change: p.change ? JSON.stringify(p.change) : null } : {}),
      ...(p.undoneVariations.length ? { swap_undone_variations: [...new Set([...cur.swap_undone_variations, ...p.undoneVariations])] } : {}),
      square_synced_at: now,
      updated_at: now,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', cur.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit.record(tx, {
    locationId: x.locationId,
    action: `membership.billing.${p.action}`,
    entityType: 'membership',
    entityId: cur.id,
    before: { status: cur.status, cancelAt: cur.cancel_effective_at, pauseAt: cur.pause_effective_at, change: cur.scheduled_change },
    after: { status: row.status, cancelAt: row.cancel_effective_at, pauseAt: row.pause_effective_at, change: row.scheduled_change },
    ctx: actor.audit,
  })
  return row
}

/** Staff "Text card link": the client's card page (kind card), texted with template personal_link_card. No Square call. */
export async function textCardLink(tx: Tx, x: Pick<SquareSteps, 'clock' | 'newId' | 'env' | 'locationId'>, membershipId: string, actor: StaffActor): Promise<{ row: MembershipRow; sms: 'queued' | 'skipped' }> {
  const m = await tx.selectFrom('memberships').selectAll().where('id', '=', membershipId).where('location_id', '=', x.locationId).forUpdate().executeTakeFirst()
  if (!m) throw new AppError('MEMBERSHIP_NOT_FOUND')
  if (m.source !== 'square') throw new AppError('MEMBERSHIP_NOT_BILLED_BY_SQUARE')
  const link = await issueClientLink(
    tx,
    { newId: x.newId, now: x.clock.now(), ...(x.env.PUBLIC_SITE_URL ? { siteUrl: x.env.PUBLIC_SITE_URL } : {}) },
    { locationId: x.locationId, kind: 'card', customerId: m.customer_id, issuedBy: 'staff' },
  )
  const target = await loadCustomerTarget(tx, x.locationId, m.customer_id)
  let sms: 'queued' | 'skipped' = 'skipped'
  if (target) {
    const out = await new DbMessageQueue({ clock: x.clock, newId: x.newId, config: messagingConfig(x.env) }).enqueueFor(tx, {
      locationId: x.locationId,
      customerId: m.customer_id,
      recipient: target.recipient,
      appointmentId: null,
      templateKey: 'personal_link_card',
      vars: { first: target.firstName },
      secretVars: { link: link.url },
      purpose: 'membership',
      senderKind: 'staff',
      dedupeKey: `personal_link_card:${link.id}`,
    })
    sms = out.queued ? 'queued' : 'skipped'
  }
  await audit.record(tx, {
    locationId: x.locationId,
    action: 'membership.billing.card_link',
    entityType: 'membership',
    entityId: m.id,
    after: { clientLinkId: link.id, sms },
    ctx: actor.audit,
  })
  return { row: m, sms }
}

export interface PreparedRefund {
  membershipId: string
  invoiceRowId: string
  amountCents: number
  squareRefundId: string
  status: string
}

/**
 * Staff "Refund last payment" (pay.refund): the membership's latest paid Square invoice, refunded in full through RefundPayment with
 * the key rf_<invoice row> (a repeat answers the same refund). The membership itself is not changed (cancel it separately).
 */
export async function prepareRefundLast(x: SquareSteps, membershipId: string): Promise<PreparedRefund> {
  const m = await squareMembership(x.db, x.locationId, membershipId)
  if (!squareWritesOn(x.env)) throw new AppError('SQUARE_WRITES_OFF')
  const inv = await x.db
    .selectFrom('square_subscription_invoices')
    .selectAll()
    .where('membership_id', '=', m.id)
    .where('paid_at', 'is not', null)
    .orderBy('paid_at', 'desc')
    .executeTakeFirst()
  if (!inv || inv.paid_cents <= 0) throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'There is no membership payment to refund.' })
  if (inv.refunded_cents > 0) throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'The last membership payment was refunded already.' })
  try {
    let paymentId = inv.square_payment_id
    if (!paymentId && inv.square_order_id) {
      const order = await x.api.orders.retrieve(inv.square_order_id)
      paymentId = order.tenders?.find((t) => t.payment_id)?.payment_id ?? null
    }
    if (!paymentId) throw new AppError('MEMBERSHIP_BILLING_STATE', { detail: 'Square has no payment for the last invoice yet.' })
    const refund = await x.api.refunds.refund(sqKey('rf', `membership-invoice:${inv.id}`), {
      payment_id: paymentId,
      amount_money: usd(inv.paid_cents),
      reason: 'Membership refund',
    })
    return { membershipId: m.id, invoiceRowId: inv.id, amountCents: inv.paid_cents, squareRefundId: refund.id, status: refund.status }
  } catch (e) {
    if (e instanceof AppError) throw e
    x.logger?.warn({ membership: m.id, err: e instanceof Error ? e.message : String(e) }, 'square: membership refund failed')
    throw squareProblem(e)
  }
}

export async function recordRefundLast(tx: Tx, x: Pick<SquareSteps, 'clock' | 'locationId'>, p: PreparedRefund, actor: StaffActor): Promise<MembershipRow> {
  const now = x.clock.now()
  await tx
    .updateTable('square_subscription_invoices')
    .set({ refunded_cents: p.amountCents, square_refund_id: p.squareRefundId, refunded_at: now, updated_at: now })
    .where('id', '=', p.invoiceRowId)
    .where('refunded_cents', '=', 0)
    .execute()
  await audit.record(tx, {
    locationId: x.locationId,
    action: 'membership.billing.refund',
    entityType: 'membership',
    entityId: p.membershipId,
    after: { amountCents: p.amountCents, squareRefundId: p.squareRefundId, status: p.status },
    ctx: actor.audit,
  })
  return tx.selectFrom('memberships').selectAll().where('id', '=', p.membershipId).executeTakeFirstOrThrow()
}
