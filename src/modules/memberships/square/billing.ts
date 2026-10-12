// Billing driven by Square's webhooks (ADR 0171 wave Q3b, design 5.4), installed into the Square runtime's ingest (square/handlers.ts):
//   invoice.*       a subscription invoice, re-fetched with its subscription: the row in square_subscription_invoices is kept current;
//                   PAID applies the cycle once (the period from the due date to the charged-through date in shop-local midnights,
//                   the membership active, the failure cleared, grantCycleCredits once per paid cycle) and activates a membership that
//                   was waiting for its first payment; a failed charge starts the failure policy (day 0: in grace, the client texted
//                   a card link, staff told) or, for a first payment, fails the enrollment (the job cancels at Square and texts a new
//                   membership page);
//   subscription.*  Square's status as the membership's (PAUSED paused, CANCELED or DEACTIVATED canceled, ACTIVE again after a
//                   pause), what Square scheduled for the next billing date (cancel, pause, a plan swap), and a plan swap that took
//                   effect (the membership follows the variation it is billed at: tier, size and price row).
// Every handler runs in the event's transaction under the event processor's advisory lock and locks the membership row, so a webhook
// and the catch-up, or an invoice and its subscription, never interleave on one membership. Square calls never happen here.
import { sql } from 'kysely'
import type { Env } from '../../../config/env.js'
import { centsOf } from '../../../integrations/square/money.js'
import type { WireInvoice, WireSubscription } from '../../../integrations/square/wire.js'
import * as audit from '../../../platform/audit.js'
import type { Clock } from '../../../platform/clock.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { createIdGenerator, type NewId } from '../../../platform/ids.js'
import { getSetting } from '../../../platform/settings.js'
import { notifyManagers } from '../../messaging/notify.js'
import type { IngestOutcome, SquareIngestContext } from '../../square/ingest.js'
import { grantCycleCredits } from '../credits.js'
import { loadPlans } from '../plans.js'
import type { MembershipStatus } from '../schema.js'
import { locationTz, type MembershipRow } from '../view.js'
import { sendPaymentFailed } from './notify.js'
import { paidPeriod, scheduledAtSquare, statusFromSquare } from './policy.js'
import { LIVE_ENROLLMENT_STATES } from './schema.js'
import '../schema.js'

const SQUARE_AUDIT: audit.AuditContext = { actor: { name: 'Square' } }

export interface BillingDeps {
  clock: Clock
  newId: NewId
  env: Env
  locationId: string
}

const depsOf = (ctx: SquareIngestContext): BillingDeps => ({ clock: ctx.clock, newId: createIdGenerator(ctx.clock), env: ctx.env, locationId: ctx.locationId })

/** Invoice states in which the money was taken (a refund after it included). */
export const PAID_INVOICE = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const

export function invoicePaid(inv: Pick<WireInvoice, 'status' | 'payment_requests'>): boolean {
  if ((PAID_INVOICE as readonly string[]).includes(inv.status)) return true
  const req = inv.payment_requests?.[0]
  const due = centsOf(req?.computed_amount_money)
  return due > 0 && centsOf(req?.total_completed_amount_money) >= due && inv.status !== 'CANCELED'
}

const lockMembership = (tx: Tx, id: string) => tx.selectFrom('memberships').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()

/**
 * Ties a subscription Square made to its membership and enrollment once the ids are known: by the time the subscribe command (or
 * the resume job) records them, or, when Square's event wins the race, by the enrollment that is waiting for exactly this
 * customer and plan variation. Locks and returns the membership; undefined for a subscription that is not an Oasis membership.
 */
export async function membershipForSubscription(
  tx: Tx,
  d: Pick<BillingDeps, 'clock' | 'locationId'>,
  subscriptionId: string,
  sub?: Pick<WireSubscription, 'id' | 'customer_id' | 'plan_variation_id' | 'status'>,
): Promise<MembershipRow | undefined> {
  const known = await tx
    .selectFrom('memberships')
    .select('id')
    .where('square_subscription_id', '=', subscriptionId)
    .where('location_id', '=', d.locationId)
    .executeTakeFirst()
  if (known) return lockMembership(tx, known.id)
  const enr =
    (await tx.selectFrom('square_enrollments').selectAll().where('square_subscription_id', '=', subscriptionId).forUpdate().executeTakeFirst()) ??
    (sub?.customer_id && sub.plan_variation_id
      ? await tx
          .selectFrom('square_enrollments')
          .selectAll()
          .where('location_id', '=', d.locationId)
          .where('state', '=', 'card_saved')
          .where('square_subscription_id', 'is', null)
          .where('square_customer_id', '=', sub.customer_id)
          .where('square_variation_id', '=', sub.plan_variation_id)
          .orderBy('started_at', 'desc')
          .forUpdate()
          .executeTakeFirst()
      : undefined)
  if (!enr) return undefined
  await linkSubscription(tx, d, enr.id, { id: subscriptionId, status: sub?.status ?? null })
  const m = await tx.selectFrom('memberships').select('id').where('id', '=', enr.membership_id).executeTakeFirstOrThrow()
  return lockMembership(tx, m.id)
}

/**
 * Records the subscription of an enrollment (the subscribe command's second transaction, the resume job, or the first event):
 * the enrollment `subscribed`, the membership's Square ids and card. Idempotent; never moves an enrollment backwards.
 */
export async function linkSubscription(
  tx: Tx,
  d: Pick<BillingDeps, 'clock'>,
  enrollmentId: string,
  sub: { id: string; status: string | null },
): Promise<void> {
  const now = d.clock.now()
  const enr = await tx.selectFrom('square_enrollments').selectAll().where('id', '=', enrollmentId).forUpdate().executeTakeFirstOrThrow()
  if (enr.square_subscription_id && enr.square_subscription_id !== sub.id) throw new Error('enrollment already names another subscription')
  if (!enr.square_subscription_id)
    await tx
      .updateTable('square_enrollments')
      .set({ square_subscription_id: sub.id, ...(enr.state === 'card_saved' ? { state: 'subscribed' as const } : {}), updated_at: now })
      .where('id', '=', enr.id)
      .execute()
  await tx
    .updateTable('memberships')
    .set((eb) => ({
      square_subscription_id: sub.id,
      square_customer_id: enr.square_customer_id,
      card_id: enr.card_id,
      ...(sub.status ? { square_status: sub.status } : {}),
      square_synced_at: now,
      updated_at: now,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', enr.membership_id)
    .where((eb) => eb.or([eb('square_subscription_id', 'is', null), eb('square_subscription_id', '=', sub.id)]))
    .execute()
}

/**
 * A plan swap that took effect at Square (staff "Change", "Move members", or someone in the Square Dashboard): the membership follows
 * the variation its subscription is billed at (tier, size, price row) and the scheduled change is done. Returns the row as it is now.
 */
async function followVariation(tx: Tx, d: BillingDeps, m: MembershipRow, sub: Pick<WireSubscription, 'plan_variation_id'> | undefined): Promise<MembershipRow> {
  const v = sub?.plan_variation_id
  if (!v) return m
  const cur = m.tier_price_id
    ? await tx.selectFrom('membership_tier_prices').select('square_variation_id').where('id', '=', m.tier_price_id).executeTakeFirst()
    : undefined
  if (cur?.square_variation_id === v) return m
  const price = await tx
    .selectFrom('membership_tier_prices as p')
    .innerJoin('membership_plans as pl', 'pl.id', 'p.plan_id')
    .select(['p.id', 'p.plan_id', 'p.class_key', 'pl.name', 'pl.key'])
    .where('p.square_variation_id', '=', v)
    .where('p.location_id', '=', d.locationId)
    .executeTakeFirst()
  if (!price) return m
  const now = d.clock.now()
  const row = await tx
    .updateTable('memberships')
    .set((eb) => ({
      plan_id: price.plan_id,
      plan_class: price.class_key,
      tier_price_id: price.id,
      plan_label: price.plan_id === m.plan_id ? m.plan_label : price.name,
      scheduled_change: null,
      updated_at: now,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', m.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.square.plan_changed',
    entityType: 'membership',
    entityId: m.id,
    before: { planId: m.plan_id, planClass: m.plan_class, tierPriceId: m.tier_price_id },
    after: { plan: price.key, planClass: price.class_key, tierPriceId: price.id },
    ctx: SQUARE_AUDIT,
  })
  return row
}

async function upsertInvoiceRow(tx: Tx, d: BillingDeps, m: MembershipRow, inv: WireInvoice) {
  const req = inv.payment_requests?.[0]
  const now = d.clock.now()
  const values = {
    status: inv.status,
    amount_cents: centsOf(req?.computed_amount_money),
    paid_cents: centsOf(req?.total_completed_amount_money),
    due_date: req?.due_date ?? null,
    public_url: inv.public_url && /^https:\/\//.test(inv.public_url) && inv.public_url.length <= 2048 ? inv.public_url : null,
    square_order_id: inv.order_id ?? null,
    updated_at: now,
  }
  await tx
    .insertInto('square_subscription_invoices')
    .values({ id: d.newId(), location_id: d.locationId, membership_id: m.id, square_invoice_id: inv.id, square_subscription_id: inv.subscription_id!, ...values, created_at: now })
    .onConflict((oc) => oc.column('square_invoice_id').doUpdateSet(values))
    .execute()
  // the invoice's payment may have come first (Square sends payment.* before invoice.payment_made): its mirror row is a membership
  // payment, never an Oasis invoice's money, before the counter matcher's delay (SQUARE_MATCH_DELAY_SECONDS) is over
  if (inv.order_id)
    await tx
      .updateTable('square_payments')
      .set({
        classification: 'membership',
        match_state: 'ignored',
        ignore_reason: 'other',
        ignore_note: 'membership payment (Square subscription)',
        decided_by: 'Square',
        decided_at: now,
        candidates: '[]',
        updated_at: now,
      })
      .where('square_order_id', '=', inv.order_id)
      .where('location_id', '=', d.locationId)
      .where('match_state', 'in', ['pending', 'unmatched'])
      .execute()
  return tx.selectFrom('square_subscription_invoices').selectAll().where('square_invoice_id', '=', inv.id).forUpdate().executeTakeFirstOrThrow()
}

/** The live enrollment of a pending membership (the first invoice is its). */
const enrollmentOf = (tx: Executor, membershipId: string) =>
  tx
    .selectFrom('square_enrollments')
    .selectAll()
    .where('membership_id', '=', membershipId)
    .orderBy('started_at', 'desc')
    .forUpdate()
    .executeTakeFirst()

/** A paid invoice: the cycle applied once (see the header). */
async function applyPaid(
  tx: Tx,
  d: BillingDeps,
  m0: MembershipRow,
  row: { id: string; applied_at: Date | null },
  inv: WireInvoice,
  sub: WireSubscription | undefined,
): Promise<string> {
  const tz = await locationTz(tx, d.locationId)
  const now = d.clock.now()
  const req = inv.payment_requests?.[0]
  const period = paidPeriod({ dueDate: req?.due_date ?? null, startDate: sub?.start_date ?? null, chargedThrough: sub?.charged_through_date ?? null }, tz)
  const m = await followVariation(tx, d, m0, sub)
  if (m.status === 'canceled') {
    await tx.updateTable('square_subscription_invoices').set({ paid_at: now, applied_at: now, updated_at: now }).where('id', '=', row.id).execute()
    await notifyManagers(
      tx,
      {
        locationId: d.locationId,
        kind: 'membership.square_paid_canceled',
        title: 'A canceled membership was paid at Square',
        body: `Square took a membership payment (invoice ${inv.invoice_number ?? inv.id}) for a membership that is canceled in Oasis. Check it in Square and refund it if it should not have been charged.`,
        entityType: 'membership',
        entityId: m.id,
      },
      { newId: d.newId, clock: d.clock },
    )
    return 'paid invoice of a canceled membership: staff told'
  }
  const forward = !m.current_period_start || period.start.getTime() >= m.current_period_start.getTime()
  const wasPending = m.status === 'pending'
  const restored = m.billing_status === 'failed' || m.status === 'past_due'
  const status: MembershipStatus = m.status === 'paused' ? 'paused' : 'active'
  await tx
    .updateTable('memberships')
    .set((eb) => ({
      status,
      in_grace: false,
      billing_status: 'ok',
      payment_failed_at: null,
      failure_notified_at: null,
      last_paid_at: now,
      paid_order_count: eb('paid_order_count', '+', 1),
      ...(forward ? { current_period_start: period.start, current_period_end: period.end, swap_undone_variations: [] } : {}),
      ...(sub?.status ? { square_status: sub.status } : {}),
      square_synced_at: now,
      updated_at: now,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', m.id)
    .execute()
  await tx
    .updateTable('square_subscription_invoices')
    .set({ paid_at: now, applied_at: now, period_start: period.start, period_end: period.end, updated_at: now })
    .where('id', '=', row.id)
    .execute()
  if (wasPending) {
    const enr = await enrollmentOf(tx, m.id)
    if (enr && enr.state !== 'active')
      await tx
        .updateTable('square_enrollments')
        .set({ state: 'active', failure_code: null, failure_detail: null, cleanup: 'none', finished_at: now, updated_at: now })
        .where('id', '=', enr.id)
        .execute()
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'membership.activated',
      entityType: 'membership',
      entityId: m.id,
      after: { source: 'square', subscription: m.square_subscription_id, invoice: inv.id },
      ctx: SQUARE_AUDIT,
    })
  }
  let granted = 0
  if (forward && status === 'active') {
    const plan = (await loadPlans(tx, d.locationId)).find((p) => p.id === m.plan_id)
    if (plan) granted = await grantCycleCredits(tx, d, { id: m.id, currentPeriodStart: period.start }, plan, 'Square')
  }
  await audit.record(tx, {
    locationId: d.locationId,
    action: restored ? 'membership.square.restored' : 'membership.square.paid',
    entityType: 'membership',
    entityId: m.id,
    after: {
      invoice: inv.id,
      amountCents: centsOf(req?.total_completed_amount_money),
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      creditsGranted: granted,
    },
    ctx: SQUARE_AUDIT,
  })
  return wasPending ? 'first invoice paid: membership active' : restored ? 'invoice paid: membership restored' : 'invoice paid: cycle applied'
}

/** The billing email of a Square membership: the one its enrollment gave Square. */
export async function billingEmailOf(db: Executor, membershipId: string): Promise<string | null> {
  const e = await db
    .selectFrom('square_enrollments')
    .select('email')
    .where('membership_id', '=', membershipId)
    .where('state', '=', 'active')
    .orderBy('started_at', 'desc')
    .executeTakeFirst()
  return e?.email ?? null
}

/**
 * Day 0 of a failed renewal for a membership the shop has not told yet: the client's card page and Square's invoice page by text,
 * Square's page by email (notify.ts). Marks the membership told. The daily job calls it again for one the event could not tell.
 */
export async function tellPaymentFailed(tx: Tx, d: BillingDeps, m: MembershipRow, inv: { id: string; amountCents: number; publicUrl: string | null }): Promise<void> {
  const plan = (await loadPlans(tx, d.locationId)).find((p) => p.id === m.plan_id)
  const policy = (await getSetting(tx, d.locationId, 'memberships.billing_policy')).value
  await sendPaymentFailed(tx, d, {
    membershipId: m.id,
    customerId: m.customer_id,
    tierName: plan?.name ?? m.plan_label,
    amountCents: inv.amountCents,
    payUrl: inv.publicUrl,
    email: await billingEmailOf(tx, m.id),
    graceDays: policy.graceDays,
    failureKey: `${m.id}:${inv.id}`,
  })
  await tx.updateTable('memberships').set({ failure_notified_at: d.clock.now() }).where('id', '=', m.id).execute()
}

/** A charge Square could not take (see the header). */
async function applyFailed(tx: Tx, d: BillingDeps, m: MembershipRow, row: { id: string; amount_cents: number; public_url: string | null }, inv: WireInvoice): Promise<string> {
  const now = d.clock.now()
  await tx.updateTable('square_subscription_invoices').set({ failed_at: now, updated_at: now }).where('id', '=', row.id).execute()
  if (m.status === 'pending') {
    const enr = await enrollmentOf(tx, m.id)
    if (enr && (LIVE_ENROLLMENT_STATES as readonly string[]).includes(enr.state))
      await tx
        .updateTable('square_enrollments')
        .set({
          state: 'failed',
          failure_code: 'first_payment_failed',
          failure_detail: 'Square could not charge the first payment',
          cleanup: 'pending',
          finished_at: now,
          updated_at: now,
        })
        .where('id', '=', enr.id)
        .execute()
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'membership.square.first_payment_failed',
      entityType: 'membership',
      entityId: m.id,
      after: { invoice: inv.id, enrollment: enr?.id ?? null },
      ctx: SQUARE_AUDIT,
    })
    return 'first payment failed: the enrollment ends'
  }
  if (m.status === 'canceled' || m.billing_status === 'failed') return 'payment failed again: nothing new'
  const updated = await tx
    .updateTable('memberships')
    .set((eb) => ({ billing_status: 'failed', payment_failed_at: now, failure_notified_at: null, in_grace: true, updated_at: now, version: eb('version', '+', 1) }))
    .where('id', '=', m.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  const cust = await tx.selectFrom('customers').select('full_name').where('id', '=', m.customer_id).executeTakeFirst()
  await notifyManagers(
    tx,
    {
      locationId: d.locationId,
      kind: 'membership.payment_failed',
      title: `Membership payment failed: ${cust?.full_name ?? 'a member'}`,
      body: `Square could not charge the ${m.plan_label} membership of ${cust?.full_name ?? 'a member'}. We texted them a link to update their card; Square will try again. Perks stay on for now, pause on day 7 and the membership is canceled on day 21 unless it is paid.`,
      entityType: 'membership',
      entityId: m.id,
    },
    { newId: d.newId, clock: d.clock },
  )
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.square.payment_failed',
    entityType: 'membership',
    entityId: m.id,
    after: { invoice: inv.id, amountCents: row.amount_cents },
    ctx: SQUARE_AUDIT,
  })
  // the notice never fails the event: a refusal rolls back to the savepoint and the daily job tells them (failure_notified_at null)
  await sql`savepoint membership_failure_notice`.execute(tx)
  try {
    await tellPaymentFailed(tx, d, updated, { id: inv.id, amountCents: row.amount_cents, publicUrl: row.public_url })
    await sql`release savepoint membership_failure_notice`.execute(tx)
  } catch {
    await sql`rollback to savepoint membership_failure_notice`.execute(tx)
    return 'renewal failed: grace, staff told (the client is told by the daily job)'
  }
  return 'renewal failed: grace, client texted, staff told'
}

/** invoice.* (see the header). */
export async function ingestSubscriptionInvoice(ctx: SquareIngestContext, inv: WireInvoice): Promise<IngestOutcome> {
  if (!inv.subscription_id) return { status: 'ignored', note: 'not a subscription invoice' }
  const d = depsOf(ctx)
  const sub = ctx.related?.subscription
  const m = await membershipForSubscription(ctx.tx, d, inv.subscription_id, sub)
  if (!m) return { status: 'ignored', note: 'a subscription of no Oasis membership' }
  const row = await upsertInvoiceRow(ctx.tx, d, m, inv)
  if (invoicePaid(inv)) {
    if (row.applied_at) return { status: 'processed', note: 'invoice paid: already applied' }
    return { status: 'processed', note: await applyPaid(ctx.tx, d, m, row, inv, sub) }
  }
  if (inv.status === 'CANCELED') {
    if (!row.canceled_at) await ctx.tx.updateTable('square_subscription_invoices').set({ canceled_at: d.clock.now() }).where('id', '=', row.id).execute()
    return { status: 'processed', note: 'invoice canceled' }
  }
  if (ctx.event.type === 'invoice.scheduled_charge_failed' && !row.failed_at)
    return { status: 'processed', note: await applyFailed(ctx.tx, d, m, row, inv) }
  return { status: 'processed', note: `invoice ${inv.status.toLowerCase()}` }
}

/** subscription.* (see the header). */
export async function ingestSquareSubscription(ctx: SquareIngestContext, sub: WireSubscription): Promise<IngestOutcome> {
  const d = depsOf(ctx)
  const tx = ctx.tx
  const m0 = await membershipForSubscription(tx, d, sub.id, sub)
  if (!m0) return { status: 'ignored', note: 'a subscription of no Oasis membership' }
  const now = d.clock.now()
  const m = await followVariation(tx, d, m0, sub)
  const sched = scheduledAtSquare(sub)
  const ended = sub.status === 'CANCELED' || sub.status === 'DEACTIVATED'
  if (m.status === 'pending') {
    if (!ended) {
      await tx.updateTable('memberships').set({ square_status: sub.status, square_synced_at: now }).where('id', '=', m.id).execute()
      return { status: 'processed', note: `subscription ${sub.status.toLowerCase()}: waiting for the first payment` }
    }
    const enr = await enrollmentOf(tx, m.id)
    if (enr && (LIVE_ENROLLMENT_STATES as readonly string[]).includes(enr.state))
      await tx
        .updateTable('square_enrollments')
        .set({
          state: 'failed',
          failure_code: 'deactivated',
          failure_detail: sub.status === 'DEACTIVATED' ? 'Square deactivated the subscription (often an email Square cannot deliver to)' : 'Square canceled the subscription',
          cleanup: 'pending',
          finished_at: now,
          updated_at: now,
        })
        .where('id', '=', enr.id)
        .execute()
    await tx.updateTable('memberships').set({ square_status: sub.status, square_synced_at: now }).where('id', '=', m.id).execute()
    return { status: 'processed', note: `subscription ${sub.status.toLowerCase()} before the first payment: the enrollment ends` }
  }
  const status = statusFromSquare(sub.status, m.status)
  const changed = status !== m.status
  await tx
    .updateTable('memberships')
    .set((eb) => ({
      status,
      square_status: sub.status,
      cancel_effective_at: ended ? null : sched.cancelAt,
      pause_effective_at: sched.pauseAt,
      square_synced_at: now,
      ...(status === 'canceled' && m.status !== 'canceled'
        ? {
            canceled_at: now,
            cancel_reason: m.cancel_reason ?? (sub.status === 'DEACTIVATED' ? 'Square deactivated the subscription' : 'Canceled at Square'),
            in_grace: false,
          }
        : {}),
      ...(status === 'paused' ? { in_grace: false } : {}),
      ...(changed ? { updated_at: now, version: eb('version', '+', 1) } : {}),
    }))
    .where('id', '=', m.id)
    .execute()
  if (changed)
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'membership.square.status',
      entityType: 'membership',
      entityId: m.id,
      before: { status: m.status },
      after: { status, square: sub.status },
      ctx: SQUARE_AUDIT,
    })
  return { status: 'processed', note: changed ? `membership ${m.status} -> ${status}` : `subscription ${sub.status.toLowerCase()}` }
}
