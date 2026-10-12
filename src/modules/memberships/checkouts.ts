// Membership checkouts (ADR 0160, design section 5 "Squarespace", migrations 20261011000500 and 20261011050000).
//
//   - openCheckoutIntent: the membership page of a personal link (wave W3) starts a checkout for a verified client: a pending
//     membership (reused when one is pending already) and an open intent with the email they confirmed, the plan's Squarespace
//     product and a 72-hour window; any earlier open intent of that membership is superseded. The page then redirects to the
//     plan's checkout URL.
//   - the order sync (service.ts) reads the open and matched intents first (payments-sync/membership.ts linkCustomer) and marks an
//     intent matched when its order arrives; a paid order whose email matches a client only through an email nobody verified opens
//     an 'awaiting_match' row (origin 'sync') on that client's membership (a pending one is created when they have none) and asks
//     staff, who confirm it (matched: the next pass links the order) or reject it (the order goes back to "needs a customer").
//   - the checkouts job: open intents expire after their window; a pending web or link membership that never got a paid order and
//     that staff never touched (manual_status_at null) is closed 7 days after its last checkout attempt (canceled, cancel_reason
//     checkout_abandoned, its intents abandoned). Nothing to do: nothing happens.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { formatPhoneDisplay } from '../../platform/phone.js'
import { notifyManagers } from '../messaging/notify.js'
import { raiseAlert, resolveAlertKeys } from '../payments-sync/db/alerts.js'
import { listProductRows } from '../payments-sync/db/product-map.js'
import { normalizeEmail } from '../payments-sync/identity.js'
import type { CheckoutIntentRef, MembershipInference } from '../payments-sync/membership.js'
import type { ProductMapEntry } from '../payments-sync/product-map.js'
import { ensurePlans, loadPlans, planByKey, type Plan } from './plans.js'
import './problems.js'
import type { MembershipCheckoutState, MembershipCheckoutsTable } from './schema.js'
import type { Selectable } from 'kysely'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** How long an open checkout intent waits for its Squarespace order. */
export const CHECKOUT_WINDOW_MS = 72 * HOUR
/** A pending web or link membership with no paid order is closed after this long. */
export const PENDING_ABANDON_MS = 7 * DAY
/** memberships.cancel_reason of such a membership. */
export const CHECKOUT_ABANDONED = 'checkout_abandoned'

export type CheckoutRow = Selectable<MembershipCheckoutsTable>

const CHECKOUTS_AUDIT: AuditContext = { actor: { name: 'Membership checkouts' } }
const SYNC_AUDIT: AuditContext = { actor: { name: 'Squarespace sync' } }

interface Ctx {
  locationId: string
  clock: Clock
  newId: NewId
}

// ---- the matching's view of the rows ---------------------------------------------------------------------------------

/**
 * Open, matched and waiting rows of a location as the linking reads them (matched and waiting rows name their Squarespace order).
 * A row an intent matched by itself (origin link) whose order's Squarespace customer another client holds (their
 * sqsp_customer_links row of any source, or their membership row) is marked `orderHeldByAnother`: it binds nothing (F1). A row
 * staff matched (origin sync) is their decision and is never second-guessed.
 */
export async function loadIntentRefs(db: Executor, locationId: string): Promise<CheckoutIntentRef[]> {
  const rows = await db
    .selectFrom('membership_checkouts as c')
    .leftJoin('sqsp_orders as o', 'o.id', 'c.matched_order_id')
    .leftJoin('customers as k', 'k.id', 'c.customer_id')
    .select((eb) => [
      'c.id',
      'c.customer_id',
      'k.phone_e164 as client_phone',
      'k.full_name as client_name',
      'c.membership_id',
      'c.state',
      'c.plan_key',
      'c.product_key',
      'c.expected_email',
      'c.started_at',
      'c.expires_at',
      'o.sqsp_order_id',
      'o.sqsp_customer_id as order_sqsp_customer_id',
      eb
        .and([
          eb('c.origin', '=', 'link'),
          eb.or([
            eb.exists(
              eb
                .selectFrom('sqsp_customer_links as l')
                .select(sql.lit(1).as('one'))
                .whereRef('l.location_id', '=', 'c.location_id')
                .whereRef('l.sqsp_customer_id', '=', 'o.sqsp_customer_id')
                .whereRef('l.customer_id', '<>', 'c.customer_id'),
            ),
            eb.exists(
              eb
                .selectFrom('memberships as m')
                .select(sql.lit(1).as('one'))
                .whereRef('m.location_id', '=', 'c.location_id')
                .whereRef('m.sqsp_customer_id', '=', 'o.sqsp_customer_id')
                .whereRef('m.customer_id', '<>', 'c.customer_id'),
            ),
          ]),
        ])
        .as('order_held_by_another'),
    ])
    .where('c.location_id', '=', locationId)
    .where('c.state', 'in', ['open', 'matched', 'awaiting_match'])
    .execute()
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    membershipId: r.membership_id,
    state: r.state as CheckoutIntentRef['state'],
    planKey: r.plan_key,
    productKey: r.product_key ?? undefined,
    expectedEmail: normalizeEmail(r.expected_email ?? undefined),
    startedAt: r.started_at,
    expiresAt: r.expires_at,
    orderId: r.sqsp_order_id ?? undefined,
    orderSqspCustomerId: r.order_sqsp_customer_id ?? undefined,
    ...(r.order_held_by_another === true ? { orderHeldByAnother: true } : {}),
    client: { phone: r.client_phone ?? undefined, name: r.client_name ?? undefined },
  }))
}

async function orderRowId(db: Executor, locationId: string, sqspOrderId: string): Promise<{ id: string; order_number: string } | undefined> {
  return db
    .selectFrom('sqsp_orders')
    .select(['id', 'order_number'])
    .where('location_id', '=', locationId)
    .where('sqsp_order_id', '=', sqspOrderId)
    .executeTakeFirst()
}

/** Marks the open intents an order arrived for as matched (idempotent: only an open row moves). Returns how many moved. */
export async function markIntentsMatched(
  tx: Tx,
  d: Ctx,
  matches: readonly { intentId: string; orderId: string }[],
): Promise<number> {
  let n = 0
  const now = d.clock.now()
  for (const m of matches) {
    const order = await orderRowId(tx, d.locationId, m.orderId)
    if (!order) continue
    const row = await tx
      .updateTable('membership_checkouts')
      .set((eb) => ({ state: 'matched', matched_order_id: order.id, matched_at: now, updated_at: now, version: eb('version', '+', 1) }))
      .where('id', '=', m.intentId)
      .where('location_id', '=', d.locationId)
      .where('state', '=', 'open')
      .returning(['id', 'membership_id', 'customer_id'])
      .executeTakeFirst()
    if (!row) continue
    n++
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'membership.checkout.matched',
      entityType: 'membership',
      entityId: row.membership_id,
      after: { checkoutId: row.id, order: order.order_number, by: 'checkout_intent' },
      ctx: SYNC_AUDIT,
    })
  }
  return n
}

// ---- an order that matches only an unverified email ------------------------------------------------------------------

export type AwaitingOutcome = 'opened' | 'waiting' | 'rejected'

/**
 * A paid order whose email matches one client only through an email nobody verified: a waiting row on that client's membership
 * (a pending one is created when they have no live membership), one staff notice and an open alert. 'waiting' when the row exists
 * already; 'rejected' when staff said before that the order is not this client's (the caller treats it as an unknown person).
 */
export async function openAwaitingMatch(
  db: Db,
  d: Ctx,
  inf: MembershipInference,
  plan: Plan,
  planLabel: string,
): Promise<AwaitingOutcome> {
  const customerId = inf.candidateCustomerId
  if (!customerId) throw new Error('openAwaitingMatch needs a candidate client')
  const order = await orderRowId(db, d.locationId, inf.lastOrderId)
  if (!order) return 'waiting'
  const known = await db
    .selectFrom('membership_checkouts')
    .select(['state'])
    .where('customer_id', '=', customerId)
    .where('matched_order_id', '=', order.id)
    .where('origin', '=', 'sync')
    .executeTakeFirst()
  if (known) return known.state === 'rejected' ? 'rejected' : 'waiting'
  const now = d.clock.now()
  return transaction(db, async (tx) => {
    const customer = await tx
      .selectFrom('customers')
      .select(['id', 'full_name', 'phone_e164'])
      .where('id', '=', customerId)
      .forUpdate()
      .executeTakeFirst()
    if (!customer) return 'waiting'
    let membership = await tx
      .selectFrom('memberships')
      .select(['id'])
      .where('customer_id', '=', customerId)
      .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
      .executeTakeFirst()
    let created = false
    if (!membership) {
      membership = { id: d.newId() }
      created = true
      await tx
        .insertInto('memberships')
        .values({
          id: membership.id,
          location_id: d.locationId,
          customer_id: customerId,
          plan_id: plan.id,
          plan_label: planLabel,
          status: 'pending',
          source: 'squarespace',
          sqsp_product_key: inf.productKey,
          started_at: now,
          review_flags: JSON.stringify([]),
          inference_reason:
            inf.linkedBy === 'intent_mismatch'
              ? `Squarespace order ${order.order_number} matches this client's checkout email but not their phone or name: waiting for staff to confirm`
              : `Squarespace order ${order.order_number} matches this client only by an email nobody verified: waiting for staff to confirm`,
          last_synced_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute()
    }
    const id = d.newId()
    const inserted = await tx
      .insertInto('membership_checkouts')
      .values({
        id,
        location_id: d.locationId,
        membership_id: membership.id,
        customer_id: customerId,
        link_id: null,
        plan_key: plan.key,
        product_key: inf.productKey,
        expected_email: inf.email ?? null,
        checkout_url: null,
        origin: 'sync',
        started_at: now,
        expires_at: new Date(now.getTime() + PENDING_ABANDON_MS),
        state: 'awaiting_match',
        matched_order_id: order.id,
      })
      .onConflict((oc) =>
        oc.columns(['customer_id', 'matched_order_id']).where('origin', '=', 'sync').doNothing(),
      )
      .returning('id')
      .executeTakeFirst()
    if (!inserted) return 'waiting'
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'membership.checkout.awaiting_match',
      entityType: 'membership',
      entityId: membership.id,
      after: { checkoutId: id, order: order.order_number, email: inf.email ?? null, plan: plan.key, membershipCreated: created },
      ctx: SYNC_AUDIT,
    })
    const first = customer.full_name.trim().split(/\s+/)[0] ?? customer.full_name
    const who = customer.phone_e164 ? `${customer.full_name} (${formatPhoneDisplay(customer.phone_e164)})` : customer.full_name
    const message =
      inf.linkedBy === 'intent_mismatch'
        ? `Squarespace order ${order.order_number} (${planLabel}) was paid with the email ${who} typed on their membership page, but the order's phone or name is not theirs. Confirm with the client before it activates their membership, then match or reject it in Memberships.`
        : `Squarespace order ${order.order_number} (${planLabel}) was paid with ${inf.email ?? 'an email'}, which matches ${who} only through an email nobody verified. Confirm with the client before it activates their membership, then match or reject it in Memberships.`
    await notifyManagers(
      tx,
      {
        locationId: d.locationId,
        kind: 'membership.awaiting_match',
        title: `Confirm ${first}’s membership payment`,
        body: message,
        entityType: 'membership',
        entityId: membership.id,
        sourceRef: `membership_checkout:${id}`,
      },
      { newId: d.newId, clock: d.clock },
    )
    await raiseAlert(tx, d, {
      code: 'membership_awaiting_match',
      orderId: inf.lastOrderId,
      subject: `checkout:${id}`,
      message,
    })
    return 'opened'
  })
}

// ---- staff decide a waiting row ----------------------------------------------------------------------------------------

export interface StaffDecision {
  audit: AuditContext
  note?: string | null
}

async function lockedWaiting(tx: Tx, locationId: string, id: string): Promise<CheckoutRow> {
  const row = await tx
    .selectFrom('membership_checkouts')
    .selectAll()
    .where('id', '=', id)
    .where('location_id', '=', locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new AppError('MEMBERSHIP_CHECKOUT_NOT_FOUND')
  if (row.state !== 'awaiting_match') throw new AppError('MEMBERSHIP_CHECKOUT_NOT_WAITING', { params: { state: row.state } })
  return row
}

async function closeAwaitingAlert(tx: Tx, d: Ctx, row: CheckoutRow): Promise<void> {
  const order = row.matched_order_id
    ? await tx.selectFrom('sqsp_orders').select('sqsp_order_id').where('id', '=', row.matched_order_id).executeTakeFirst()
    : undefined
  await resolveAlertKeys(tx, d, [`membership_awaiting_match:${order?.sqsp_order_id ?? ''}::checkout:${row.id}`])
}

/** Staff confirmed with the client that the waiting order is theirs: the row becomes matched and the next pass links the order. */
export async function confirmAwaitingMatch(tx: Tx, d: Ctx, id: string, by: StaffDecision): Promise<CheckoutRow> {
  const row = await lockedWaiting(tx, d.locationId, id)
  const now = d.clock.now()
  const out = await tx
    .updateTable('membership_checkouts')
    .set((eb) => ({ state: 'matched', matched_at: now, updated_at: now, version: eb('version', '+', 1) }))
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.checkout.confirmed',
    entityType: 'membership',
    entityId: row.membership_id,
    before: { checkoutId: row.id, state: row.state },
    after: { checkoutId: row.id, state: 'matched', note: by.note ?? null },
    ctx: by.audit,
  })
  await closeAwaitingAlert(tx, d, row)
  return out
}

/**
 * Staff found the waiting order is not this client's: the row is rejected (the order is never offered for this client again and
 * goes back to "needs a customer"), and a pending membership the sync created only for it is canceled.
 */
export async function rejectAwaitingMatch(tx: Tx, d: Ctx, id: string, by: StaffDecision): Promise<CheckoutRow> {
  const row = await lockedWaiting(tx, d.locationId, id)
  const now = d.clock.now()
  const out = await tx
    .updateTable('membership_checkouts')
    .set((eb) => ({ state: 'rejected', updated_at: now, version: eb('version', '+', 1) }))
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  const m = await tx
    .selectFrom('memberships')
    .select(['id', 'status', 'source', 'paid_order_count', 'last_sqsp_order_id'])
    .where('id', '=', row.membership_id)
    .forUpdate()
    .executeTakeFirst()
  const others = await tx
    .selectFrom('membership_checkouts')
    .select('id')
    .where('membership_id', '=', row.membership_id)
    .where('id', '<>', row.id)
    .executeTakeFirst()
  const createdForIt =
    m && m.status === 'pending' && m.source === 'squarespace' && m.paid_order_count === 0 && m.last_sqsp_order_id === null && !others
  if (createdForIt)
    await tx
      .updateTable('memberships')
      .set((eb) => ({
        status: 'canceled',
        canceled_at: now,
        cancel_reason: 'Squarespace order not this client’s (staff)',
        manual_status_at: now,
        updated_at: now,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', m.id)
      .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.checkout.rejected',
    entityType: 'membership',
    entityId: row.membership_id,
    before: { checkoutId: row.id, state: row.state },
    after: { checkoutId: row.id, state: 'rejected', membershipCanceled: Boolean(createdForIt), note: by.note ?? null },
    ctx: by.audit,
  })
  await closeAwaitingAlert(tx, d, row)
  return out
}

// ---- the membership page starts a checkout (wave W3) -------------------------------------------------------------------

export interface OpenCheckoutInput {
  customerId: string
  planKey: string
  /** The email the client confirmed on the page: the order should carry it. */
  email: string
  linkId?: string | null
  /** SQSP_PRODUCT_MAP: the environment's bootstrap product map, read when the admin's table names no product for the plan. */
  envProductMap?: string
  /** The plan label the membership is sold under ("Gold"); the plan's public label or name by default. */
  planLabel?: string
}

export interface OpenCheckoutResult {
  membershipId: string
  checkoutId: string
  checkoutUrl: string
  expiresAt: Date
  membershipCreated: boolean
}

/** The Squarespace product key (id, else SKU) sold for a plan: the admin's product table first, then the bootstrap map. */
export async function planProductKey(tx: Executor, locationId: string, planKey: string, envJson?: string): Promise<string | null> {
  const rows = await listProductRows(tx, locationId)
  const row = rows.find((r) => r.active && r.kind === 'membership' && r.plan === planKey)
  if (row) return row.productId ?? row.sku ?? null
  try {
    const entries = envJson?.trim() ? (JSON.parse(envJson) as ProductMapEntry[]) : []
    const e = entries.find((x) => x.kind === 'membership' && x.tier === planKey)
    if (e) return e.productId ?? e.sku ?? null
  } catch {
    // an invalid bootstrap map is ignored here as the sync ignores it
  }
  return null
}

/**
 * Starts a Squarespace checkout for a verified client (the caller has checked the fresh PIN or code): refuses a client who is a
 * member already (a second paid subscription would only be flagged as a duplicate), reuses their pending membership (switching
 * its plan if they chose another) or creates one, supersedes its earlier open intent and opens a new one for 72 hours.
 */
export async function openCheckoutIntent(tx: Tx, d: Ctx, input: OpenCheckoutInput, ctx: AuditContext): Promise<OpenCheckoutResult> {
  const email = normalizeEmail(input.email)
  if (!email)
    throw new AppError('VALIDATION_FAILED', { detail: 'Enter a valid email.', errors: [{ path: 'email', message: 'Enter a valid email.' }] })
  await ensurePlans(tx, d)
  const plan = planByKey(await loadPlans(tx, d.locationId), input.planKey as Plan['key'])
  const planRow = plan
    ? await tx
        .selectFrom('membership_plans')
        .select(['checkout_url', 'public_label', 'active'])
        .where('id', '=', plan.id)
        .executeTakeFirst()
    : undefined
  if (!plan || !planRow || !planRow.active)
    throw new AppError('VALIDATION_FAILED', { detail: 'That plan is not available right now.', errors: [{ path: 'planKey', message: 'That plan is not available right now.' }] })
  if (!planRow.checkout_url) throw new AppError('MEMBERSHIP_CHECKOUT_UNAVAILABLE')
  const customer = await tx
    .selectFrom('customers')
    .select('id')
    .where('id', '=', input.customerId)
    .where('deleted_at', 'is', null)
    .where('merged_into', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!customer) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  const now = d.clock.now()
  const label = input.planLabel?.trim() || planRow.public_label || plan.name
  const productKey = await planProductKey(tx, d.locationId, plan.key, input.envProductMap)
  const live = await tx
    .selectFrom('memberships')
    .select(['id', 'status', 'plan_id'])
    .where('customer_id', '=', customer.id)
    .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .forUpdate()
    .executeTakeFirst()
  if (live && live.status !== 'pending') throw new AppError('MEMBERSHIP_EXISTS')
  let membershipId: string
  const created = !live
  if (live) {
    membershipId = live.id
    if (live.plan_id !== plan.id)
      await tx
        .updateTable('memberships')
        .set((eb) => ({ plan_id: plan.id, plan_label: label, sqsp_product_key: productKey, updated_at: now, version: eb('version', '+', 1) }))
        .where('id', '=', live.id)
        .execute()
  } else {
    membershipId = d.newId()
    await tx
      .insertInto('memberships')
      .values({
        id: membershipId,
        location_id: d.locationId,
        customer_id: customer.id,
        plan_id: plan.id,
        plan_label: label,
        status: 'pending',
        source: 'manual',
        sqsp_product_key: productKey,
        started_at: now,
        review_flags: JSON.stringify([]),
        inference_reason: 'Started from a personal link; waiting for the Squarespace checkout',
        created_at: now,
        updated_at: now,
      })
      .execute()
  }
  await tx
    .updateTable('membership_checkouts')
    .set((eb) => ({ state: 'superseded', updated_at: now, version: eb('version', '+', 1) }))
    .where('membership_id', '=', membershipId)
    .where('state', '=', 'open')
    .execute()
  const checkoutId = d.newId()
  const expiresAt = new Date(now.getTime() + CHECKOUT_WINDOW_MS)
  await tx
    .insertInto('membership_checkouts')
    .values({
      id: checkoutId,
      location_id: d.locationId,
      membership_id: membershipId,
      customer_id: customer.id,
      link_id: input.linkId ?? null,
      plan_key: plan.key,
      product_key: productKey,
      expected_email: email,
      checkout_url: planRow.checkout_url,
      origin: 'link',
      started_at: now,
      expires_at: expiresAt,
    })
    .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.checkout.started',
    entityType: 'membership',
    entityId: membershipId,
    after: { checkoutId, plan: plan.key, email, product: productKey, expiresAt: expiresAt.toISOString(), membershipCreated: created },
    ctx,
  })
  return { membershipId, checkoutId, checkoutUrl: planRow.checkout_url, expiresAt, membershipCreated: created }
}

// ---- the checkouts job ----------------------------------------------------------------------------------------------

export interface CheckoutSweepReport {
  expired: number
  abandoned: number
}

/**
 * Open intents past their window expire; pending web and link memberships with no paid order are closed 7 days after the last
 * checkout attempt (the membership's start, or its newest checkout row when a client restarted the checkout).
 */
export async function sweepCheckouts(db: Db, d: Ctx): Promise<CheckoutSweepReport> {
  const now = d.clock.now()
  const expired = await db
    .updateTable('membership_checkouts')
    .set((eb) => ({ state: 'expired', updated_at: now, version: eb('version', '+', 1) }))
    .where('location_id', '=', d.locationId)
    .where('state', '=', 'open')
    .where('expires_at', '<=', now)
    .executeTakeFirst()
  // A pending membership the website or a personal link created (source manual, never touched by staff: a staff-made membership
  // and any staff edit set manual_status_at, so a membership staff put on pending by hand stays theirs) that never saw a paid
  // order, 7 days after the last checkout attempt: a client who restarted the checkout gets their full window again. One with an
  // order waiting for staff, or an intent still open, is never closed here.
  const cutoff = new Date(now.getTime() - PENDING_ABANDON_MS)
  const stale = await db
    .selectFrom('memberships as m')
    .select(['m.id'])
    .where('m.location_id', '=', d.locationId)
    .where('m.status', '=', 'pending')
    .where('m.source', '=', 'manual')
    .where('m.manual_status_at', 'is', null)
    .where('m.paid_order_count', '=', 0)
    .where('m.last_paid_at', 'is', null)
    .where('m.started_at', '<=', cutoff)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('membership_checkouts as c')
            .select('c.id')
            .whereRef('c.membership_id', '=', 'm.id')
            .where((c) =>
              c.or([
                c('c.state', '=', 'awaiting_match'),
                c.and([c('c.state', '=', 'open'), c('c.expires_at', '>', now)]),
                c('c.started_at', '>', cutoff),
              ]),
            ),
        ),
      ),
    )
    .execute()
  let abandoned = 0
  for (const s of stale) {
    const closed = await transaction(db, async (tx) => {
      const m = await tx
        .selectFrom('memberships')
        .select(['id', 'status', 'paid_order_count', 'manual_status_at'])
        .where('id', '=', s.id)
        .forUpdate()
        .executeTakeFirst()
      if (!m || m.status !== 'pending' || m.paid_order_count > 0 || m.manual_status_at !== null) return false
      // a checkout restarted between the read and the lock: not stale any more
      const fresh = await tx
        .selectFrom('membership_checkouts')
        .select('id')
        .where('membership_id', '=', m.id)
        .where((eb) =>
          eb.or([
            eb('state', '=', 'awaiting_match'),
            eb.and([eb('state', '=', 'open'), eb('expires_at', '>', now)]),
            eb('started_at', '>', cutoff),
          ]),
        )
        .executeTakeFirst()
      if (fresh) return false
      const intents = await tx
        .updateTable('membership_checkouts')
        .set((eb) => ({ state: 'abandoned', updated_at: now, version: eb('version', '+', 1) }))
        .where('membership_id', '=', m.id)
        .where('state', 'in', ['open', 'expired'])
        .returning('id')
        .execute()
      await tx
        .updateTable('memberships')
        .set((eb) => ({
          status: 'canceled',
          canceled_at: now,
          cancel_reason: CHECKOUT_ABANDONED,
          // a paid order that still arrives later reactivates it (a hand-set status holds until a newer paid order)
          manual_status_at: now,
          updated_at: now,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', m.id)
        .execute()
      await audit.record(tx, {
        locationId: d.locationId,
        action: 'membership.canceled',
        entityType: 'membership',
        entityId: m.id,
        before: { status: 'pending' },
        after: { status: 'canceled', reason: CHECKOUT_ABANDONED, intentsAbandoned: intents.length },
        ctx: CHECKOUTS_AUDIT,
      })
      return true
    })
    if (closed) abandoned++
  }
  return { expired: Number(expired.numUpdatedRows ?? 0), abandoned }
}

// ---- read models ----------------------------------------------------------------------------------------------------

export interface CheckoutView {
  id: string
  membershipId: string
  customerId: string
  state: MembershipCheckoutState
  origin: 'link' | 'sync'
  planKey: string
  productKey: string | null
  expectedEmail: string | null
  startedAt: string
  expiresAt: string
  matchedAt: string | null
  order: { id: string; number: string; createdOn: string; email: string | null; totalCents: number } | null
  version: number
}

export async function checkoutViews(db: Executor, rows: readonly CheckoutRow[]): Promise<CheckoutView[]> {
  const orderIds = [...new Set(rows.map((r) => r.matched_order_id).filter((x): x is string => x !== null))]
  const orders = orderIds.length
    ? await db
        .selectFrom('sqsp_orders')
        .select(['id', 'sqsp_order_id', 'order_number', 'created_on', 'customer_email', 'grand_total_cents'])
        .where('id', 'in', orderIds)
        .execute()
    : []
  return rows.map((r) => {
    const o = orders.find((x) => x.id === r.matched_order_id)
    return {
      id: r.id,
      membershipId: r.membership_id,
      customerId: r.customer_id,
      state: r.state,
      origin: r.origin,
      planKey: r.plan_key,
      productKey: r.product_key,
      expectedEmail: r.expected_email,
      startedAt: r.started_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      matchedAt: r.matched_at?.toISOString() ?? null,
      order: o
        ? {
            id: o.sqsp_order_id,
            number: o.order_number,
            createdOn: o.created_on.toISOString(),
            email: o.customer_email,
            totalCents: o.grand_total_cents,
          }
        : null,
      version: r.version,
    }
  })
}

/** The live checkout of each membership (open or waiting for staff), newest first: what the membership view shows. */
export async function liveCheckouts(db: Executor, membershipIds: readonly string[]): Promise<Map<string, CheckoutView>> {
  if (membershipIds.length === 0) return new Map()
  const rows = await db
    .selectFrom('membership_checkouts')
    .selectAll()
    .where('membership_id', 'in', [...membershipIds])
    .where('state', 'in', ['open', 'awaiting_match'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
  const views = await checkoutViews(db, rows)
  const out = new Map<string, CheckoutView>()
  for (const v of views) if (!out.has(v.membershipId)) out.set(v.membershipId, v)
  return out
}

/** Checkout rows of a location, newest first, optionally of one state. */
export async function listCheckouts(
  db: Executor,
  locationId: string,
  q: { state?: MembershipCheckoutState; limit: number },
): Promise<(CheckoutView & { customerName: string })[]> {
  let query = db
    .selectFrom('membership_checkouts as c')
    .innerJoin('customers as cu', 'cu.id', 'c.customer_id')
    .selectAll('c')
    .select('cu.full_name as customer_name')
    .where('c.location_id', '=', locationId)
  if (q.state) query = query.where('c.state', '=', q.state)
  const rows = await query.orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').limit(q.limit).execute()
  const views = await checkoutViews(db, rows)
  return views.map((v, i) => ({ ...v, customerName: rows[i]!.customer_name }))
}

export const checkoutCount = async (db: Executor, locationId: string, state: MembershipCheckoutState): Promise<number> =>
  Number(
    (
      await sql<{ n: number }>`select count(*)::int as n from membership_checkouts where location_id = ${locationId} and state = ${state}`.execute(
        db,
      )
    ).rows[0]?.n ?? 0,
  )
