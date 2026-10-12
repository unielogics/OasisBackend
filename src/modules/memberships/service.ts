// The membership service: drives memberships from the ingested Squarespace subscription orders (status, renewal, credits)
// through the pure inference in payments-sync/membership.ts, rolls manual memberships, and applies hand edits.
//   - Squarespace exposes no subscription id, status or cancellation signal, so everything is inferred from paid orders:
//     active until the paid period ends plus the grace days, then past_due, then (lagged, flagged) canceled.
//   - a full refund flags the member for review and never cancels.
//   - a manual override (PATCH, or a manually created member) holds until a NEWER paid order arrives.
//   - cycle credits are granted when a paid period starts (renewal order, manual roll) and by the daily job.
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { sql } from 'kysely'
import { staleRecord, staleWhy, type StaleVerdict } from '../identity/stale.js'
import { alertKey, raiseAlert, resolveAlertKeys } from '../payments-sync/db/alerts.js'
import { orderFromJson } from '../payments-sync/db/codec.js'
import { normalizeEmail, normalizePhone } from '../payments-sync/identity.js'
import {
  addMonths,
  inferMemberships,
  reconcileMembership,
  type CheckoutIntentRef,
  type CustomerRef,
  type ExistingMembership,
  type MembershipConfig,
  type MembershipInference,
} from '../payments-sync/membership.js'
import type { ProductMap } from '../payments-sync/product-map.js'
import { loadIntentRefs, markIntentsMatched, openAwaitingMatch } from './checkouts.js'
import './square/problems.js'
import { grantCycleCredits } from './credits.js'
import { resolvePlanClass } from './plan-class.js'
import { ensurePlans, loadPlans, planByKey, type Plan } from './plans.js'
import './problems.js'
import type { MembershipRow } from './view.js'
import type { MembershipStatus, PlanKey } from './schema.js'

const DAY = 86_400_000

export interface MembershipSyncDeps {
  locationId: string
  clock: Clock
  newId: NewId
  productMap: ProductMap
  config: Partial<MembershipConfig>
  /** How far back subscription orders are read. Default 540 days: a yearly plan is inferred canceled 12 months + grace + lapse (432 days) after its last order. */
  lookbackDays?: number
}

export interface MembershipSyncReport {
  considered: number
  created: number
  updated: number
  unchanged: number
  held: number
  needsCustomer: number
  /** Orders that match a client only through an unverified email, waiting for staff (membership_checkouts awaiting_match). */
  awaitingMatch: number
  /** Checkout intents an order arrived for (open -> matched). */
  intentsMatched: number
  /** Paid orders of a plan the member was already paying for (flagged duplicate_payment, alert raised once). */
  duplicates: number
  creditsGranted: number
}

const empty = (): MembershipSyncReport => ({
  considered: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  held: 0,
  needsCustomer: 0,
  awaitingMatch: 0,
  intentsMatched: 0,
  duplicates: 0,
  creditsGranted: 0,
})

/** Squarespace payment states of an order whose money was taken (a refund after it included). */
const PAID_STATES = ['PAID', 'PARTIALLY_PAID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED']

const SYSTEM_AUDIT: AuditContext = { actor: { name: 'Squarespace sync' } }

function labelFor(inf: MembershipInference, plan: Plan): string {
  const l = inf.planLabel.trim()
  return l.toLowerCase() === plan.key ? plan.name : l
}

async function customerRefs(
  db: Executor,
  locationId: string,
  orders: readonly { customerEmail?: string; customerPhone?: string; customerId?: string }[],
  now: Date,
): Promise<CustomerRef[]> {
  const emails = [
    ...new Set(orders.map((o) => normalizeEmail(o.customerEmail)).filter((x): x is string => !!x)),
  ]
  const phones = [
    ...new Set(orders.map((o) => normalizePhone(o.customerPhone)).filter((x): x is string => !!x)),
  ]
  const sqsp = [...new Set(orders.map((o) => o.customerId).filter((x): x is string => !!x))]
  if (emails.length + phones.length + sqsp.length === 0) return []
  const rows = await sql<{ id: string; email: string | null; email_verified: boolean; phone_e164: string | null }>`
    select c.id, c.email::text as email, c.email_verified, c.phone_e164
    from customers c
    where c.merged_into is null and c.deleted_at is null
      and (c.email = any(${emails}::citext[])
        or c.phone_e164 = any(${phones}::text[])
        or c.id in (select l.customer_id from sqsp_customer_links l
                    where l.location_id = ${locationId} and l.sqsp_customer_id = any(${sqsp}::text[]))
        or c.id in (select m.customer_id from memberships m
                    where m.location_id = ${locationId} and m.sqsp_customer_id = any(${sqsp}::text[]))
        or c.id in (select o.customer_id from sqsp_orders o
                    where o.location_id = ${locationId} and o.customer_id is not null and o.sqsp_customer_id = any(${sqsp}::text[])
                      and o.payment_state = any(${PAID_STATES}::text[])))`.execute(
    db,
  )
  if (rows.rows.length === 0) return []
  const links = await db
    .selectFrom('sqsp_customer_links')
    .select(['customer_id', 'sqsp_customer_id', 'source', 'created_at'])
    .where('location_id', '=', locationId)
    .where(
      'customer_id',
      'in',
      rows.rows.map((r) => r.id),
    )
    .execute()
  const held = await db
    .selectFrom('memberships')
    .select(['customer_id', 'sqsp_customer_id', 'last_paid_at'])
    .where('location_id', '=', locationId)
    .where('sqsp_customer_id', 'is not', null)
    .where(
      'customer_id',
      'in',
      rows.rows.map((r) => r.id),
    )
    .execute()
  // A Squarespace customer that already PAID on the client's record (W4c re-review 3, D1): the one on a membership row of theirs that
  // a matched payment reached, or on a paid order already linked to them. It is that client: its orders link to them whatever the
  // record's staleness and whatever made the contact link (phone, an email verified or not). A NEW Squarespace customer never paid
  // on the record, so the stale rule below still keeps it off a recycled number's old record.
  const paidOrders = await db
    .selectFrom('sqsp_orders')
    .select(['customer_id', 'sqsp_customer_id'])
    .where('location_id', '=', locationId)
    .where('sqsp_customer_id', 'is not', null)
    .where('payment_state', 'in', PAID_STATES)
    .where(
      'customer_id',
      'in',
      rows.rows.map((r) => r.id),
    )
    .execute()
  // A staff (manual) link always wins (W4c re-review 4, E1): once staff link a Squarespace customer to a client, no other client's
  // record takes its orders or holds it, whatever it paid on before (its membership row there, a paid order linked there).
  const ids = [...new Set([...sqsp, ...held.map((m) => m.sqsp_customer_id!), ...paidOrders.map((o) => o.sqsp_customer_id!)])]
  const staffLinks =
    ids.length === 0
      ? []
      : await db
          .selectFrom('sqsp_customer_links')
          .select(['customer_id', 'sqsp_customer_id'])
          .where('location_id', '=', locationId)
          .where('source', '=', 'manual')
          .where('sqsp_customer_id', 'in', ids)
          .execute()
  const staffElsewhere = (customerId: string, sqspCustomerId: string): boolean =>
    staffLinks.some((l) => l.sqsp_customer_id === sqspCustomerId && l.customer_id !== customerId)
  const paidBy = (customerId: string): string[] => [
    ...held.filter((m) => m.customer_id === customerId && m.last_paid_at !== null).map((m) => m.sqsp_customer_id!),
    ...paidOrders.filter((o) => o.customer_id === customerId).map((o) => o.sqsp_customer_id!),
  ]
  // The stale-record rule (identity/stale.ts, W4c re-review 2 N1): numbers are recycled, so the phone of a record the rule holds
  // links no order placed since it went stale (and neither does its unverified email): its new holder paying with it is not that
  // client. Nor does a Squarespace contact the contacts job linked BY that phone after the record went stale (unless that
  // Squarespace customer already paid on the record, above); one linked while it was the client's (a real member's renewals), a
  // staff link and a verified email still link, and so does every order placed before the record went stale (a lapsed member's own
  // history).
  const verdicts = new Map<string, StaleVerdict>()
  for (const r of rows.rows)
    if (r.phone_e164) verdicts.set(r.id, await staleRecord(db, { locationId, customerId: r.id, phone: r.phone_e164, now }))
  const staleSinceOf = (v: StaleVerdict | undefined): Date | undefined => (v?.stale ? (v.staleSince ?? v.lastActivityAt) : undefined)
  const linkedWhileStale = (l: { customer_id: string; source: string; created_at: Date }): boolean => {
    const since = staleSinceOf(verdicts.get(l.customer_id))
    return l.source === 'phone' && since !== undefined && l.created_at.getTime() >= since.getTime()
  }
  // Only a verified email links an order (ADR 0160): an unverified one is offered to staff instead, and a Squarespace contact
  // that was linked automatically BY that email (sqsp.contacts) is not a way around it. Phone and staff links count as before.
  // What a client HOLDS is wider (F1): every link whatever its source and the Squarespace customer on their membership rows; and
  // their email even unverified: another client's checkout intent never takes such an order (payments-sync/membership.ts).
  const mine = (customerId: string, list: string[]): string[] => [...new Set(list)].filter((x) => !staffElsewhere(customerId, x))
  return rows.rows.map((r) => ({
    id: r.id,
    emails: r.email && r.email_verified ? [r.email] : [],
    unverifiedEmails: r.email && !r.email_verified ? [r.email] : [],
    phones: r.phone_e164 ? [r.phone_e164] : [],
    staleSince: staleSinceOf(verdicts.get(r.id)),
    sqspCustomerIds: mine(r.id, [
      ...links
        .filter((l) => l.customer_id === r.id && (l.source !== 'email' || r.email_verified) && !linkedWhileStale(l))
        .map((l) => l.sqsp_customer_id),
      ...paidBy(r.id),
    ]),
    heldSqspCustomerIds: mine(r.id, [
      ...links.filter((l) => l.customer_id === r.id).map((l) => l.sqsp_customer_id),
      ...held.filter((m) => m.customer_id === r.id).map((m) => m.sqsp_customer_id!),
      ...paidBy(r.id),
    ]),
    staffSqspCustomerIds: links.filter((l) => l.customer_id === r.id && l.source === 'manual').map((l) => l.sqsp_customer_id),
  }))
}

/**
 * An order a checkout intent of one client named but another client holds (the family account: the order is the holder's, F1) is
 * not counted on the holder silently (W4c re-review 4, E3): one alert per order, naming both clients. Raised once: an alert staff
 * resolved is not raised again by the next pass.
 */
async function raiseIntentConflicts(
  db: Executor,
  d: MembershipSyncDeps,
  inf: MembershipInference,
  intents: readonly CheckoutIntentRef[],
): Promise<void> {
  for (const c of inf.intentConflicts) {
    const a = { code: 'membership_intent_conflict', orderId: c.orderId }
    const known = await db
      .selectFrom('sqsp_alerts')
      .select('id')
      .where('location_id', '=', d.locationId)
      .where('dedupe_key', '=', alertKey(a))
      .executeTakeFirst()
    if (known) continue
    const intentClient = intents.find((i) => i.id === c.intentId)?.customerId
    const names = await db
      .selectFrom('customers')
      .select(['id', 'full_name'])
      .where('id', 'in', [inf.customerId!, intentClient ?? inf.customerId!])
      .execute()
    const name = (id: string | undefined) => names.find((n) => n.id === id)?.full_name ?? 'another client'
    const holder = name(inf.customerId)
    const how = c.by === 'sqsp_customer_id' || c.by === 'checkout_intent' ? `paid from ${holder}'s Squarespace account` : `paid with ${holder}'s email or phone`
    await raiseAlert(db, d, {
      ...a,
      message: `Order ${c.orderNumber} was ${how} for ${name(intentClient)}'s checkout: it was counted on ${holder}'s record (a checkout never takes an order another client holds) — check who it belongs to; if it is ${name(intentClient)}'s, link the Squarespace customer to them.`,
    })
  }
}

/** The inference pass: reads recent membership orders, links people, creates or updates members and grants cycle credits. */
export async function syncMemberships(db: Db, d: MembershipSyncDeps): Promise<MembershipSyncReport> {
  const report = empty()
  await ensurePlans(db, d)
  const now = d.clock.now()
  const since = new Date(now.getTime() - (d.lookbackDays ?? 540) * DAY)
  const rows = await db
    .selectFrom('sqsp_orders')
    .select(['order_json', 'test_mode'])
    .where('location_id', '=', d.locationId)
    .where('created_on', '>=', since)
    .orderBy('created_on')
    .execute()
  const includeTest = d.config.includeTestMode === true
  const orders = rows
    .filter((r) => includeTest || !r.test_mode)
    .map((r) => orderFromJson(r.order_json, undefined))
    .filter((o) => o.lineItems.some((li) => d.productMap.resolve(li)?.kind === 'membership'))
  if (orders.length === 0) return report

  const customers = await customerRefs(db, d.locationId, orders, now)
  const intents = await loadIntentRefs(db, d.locationId)
  const inferences = inferMemberships(orders, d.productMap, customers, now, d.config, intents)
  const plans = await loadPlans(db, d.locationId)
  report.considered = inferences.length

  for (const inf of inferences) {
    const plan = planByKey(plans, inf.tier)
    if (!plan) continue
    if (inf.checkoutMatches.length > 0)
      report.intentsMatched += await transaction(db, (tx) => markIntentsMatched(tx, d, inf.checkoutMatches))
    if (inf.customerId && inf.intentConflicts.length > 0) await raiseIntentConflicts(db, d, inf, intents)
    await resolveAlertKeys(
      db,
      d,
      [
        inf.email ? `membership_needs_customer:::email:${inf.email}` : '',
        inf.sqspCustomerId ? `membership_needs_customer:::sqsp:${inf.sqspCustomerId}` : '',
        inf.phone ? `membership_needs_customer:::phone:${inf.phone}` : '',
      ].filter(Boolean),
    )
    const existing = inf.customerId ? await currentMembership(db, inf.customerId) : undefined
    // a membership Square bills (ADR 0171 wave Q3b) is driven by Square's events, never by the Squarespace inference
    if (existing?.source === 'square') {
      report.held++
      continue
    }
    const em: ExistingMembership | undefined = existing && {
      id: existing.id,
      customerId: existing.customer_id,
      status: existing.status,
      source: existing.source,
      tier: plans.find((p) => p.id === existing.plan_id)?.key ?? inf.tier,
      currentPeriodEnd: existing.current_period_end ?? undefined,
      lastSqspOrderId: existing.last_sqsp_order_id ?? undefined,
      manualStatusAt: existing.manual_status_at ?? undefined,
    }
    // a hand edit holds until a newer paid order arrives (the pure rule only covers paused and canceled)
    const paidAt = inf.newestPaidAt ?? inf.lastPaidAt
    if (existing?.manual_status_at && !(paidAt && paidAt.getTime() > existing.manual_status_at.getTime())) {
      report.held++
      continue
    }
    let action = reconcileMembership(em, inf)
    // the pure rule compares status, tier, period and last order; grace and review flags are kept current as well
    if (
      action.action === 'none' &&
      action.reason === 'unchanged' &&
      existing &&
      (existing.in_grace !== inf.inGrace ||
        JSON.stringify(existing.review_flags) !== JSON.stringify(inf.flags) ||
        existing.inference_reason !== inf.reason)
    )
      action = { action: 'update', membershipId: existing.id, inference: inf, changes: ['grace or flags'] }
    if (action.action === 'needs_customer' && (inf.linkedBy === 'unverified_email' || inf.linkedBy === 'intent_mismatch') && inf.paidOrderCount > 0) {
      // the email matches a client nobody verified it for, or only a checkout intent's typed email whose order carries another phone
      // or name: staff confirm before it activates anything (ADR 0160, W4c fixes)
      const outcome = await openAwaitingMatch(db, d, inf, plan, labelFor(inf, plan))
      if (outcome !== 'rejected') {
        report.awaitingMatch++
        continue
      }
    }
    if (action.action === 'needs_customer') {
      report.needsCustomer++
      // an order a checkout intent named while another client's identity points at it says why (payments-sync/membership.ts)
      const conflict = inf.flags.find((f) => f.code === 'ambiguous_customer' && f.orderId !== undefined)
      // an order only a stale record's phone or unverified email points at (W4c re-review 2, N1), or a client's phone or unverified
      // email that a Squarespace account other than theirs pays with (W4c re-review 4, E2): staff decide who paid
      const candidate =
        (inf.linkedBy === 'stale_record' || inf.linkedBy === 'second_account') && inf.candidateCustomerId
          ? await db.selectFrom('customers').select('full_name').where('id', '=', inf.candidateCustomerId).executeTakeFirst()
          : undefined
      const why = candidate
        ? inf.linkedBy === 'second_account'
          ? `a second Squarespace account is using ${candidate.full_name}'s number (or the email on file, which nobody verified), though their record already has its own Squarespace account: the number may have a new holder. Confirm who paid, then create a client or link one`
          : `the order's phone or email matches ${candidate.full_name}, whose record is stale (no sign of that client for 180 days, or the number bounced): the number may belong to someone new. Confirm who paid, then create a client or link one`
        : conflict
          ? conflict.note
          : action.reason
      await raiseAlert(db, d, {
        code: 'membership_needs_customer',
        subject: inf.personKey,
        message: `${why}. Paid for ${labelFor(inf, plan)} on order ${inf.lastOrderId}.`,
      })
      continue
    }
    const known = new Set(
      ((existing?.review_flags ?? []) as { code?: string; orderId?: string }[])
        .filter((f) => f.code === 'duplicate_payment')
        .map((f) => f.orderId),
    )
    for (const f of inf.flags.filter((x) => x.code === 'duplicate_payment' && !known.has(x.orderId))) {
      report.duplicates++
      await raiseAlert(db, d, {
        code: 'membership_duplicate_payment',
        orderId: f.orderId,
        message: `${labelFor(inf, plan)}: ${f.note}.`,
      })
    }
    if (action.action === 'none') {
      if (action.reason === 'unchanged') report.unchanged++
      else report.held++
      continue
    }
    await transaction(db, async (tx) => {
      if (action.action === 'create') {
        const started = earliestOrder(orders, inf) ?? inf.lastPaidAt ?? now
        const id = d.newId()
        await tx
          .insertInto('memberships')
          .values({
            id,
            location_id: d.locationId,
            customer_id: action.customerId,
            plan_id: plan.id,
            plan_label: labelFor(inf, plan),
            status: inf.status,
            source: 'squarespace',
            sqsp_subscription_ref: inf.subscriptionRef,
            sqsp_customer_id: inf.sqspCustomerId ?? null,
            sqsp_product_key: inf.productKey,
            started_at: started,
            current_period_start: inf.currentPeriodStart ?? null,
            current_period_end: inf.currentPeriodEnd ?? null,
            canceled_at: inf.status === 'canceled' ? now : null,
            cancel_reason: inf.status === 'canceled' ? 'Inferred: no renewal order' : null,
            last_sqsp_order_id: inf.lastOrderId,
            last_paid_at: inf.lastPaidAt ?? null,
            paid_order_count: inf.paidOrderCount,
            in_grace: inf.inGrace,
            review_flags: JSON.stringify(inf.flags),
            inference_reason: inf.reason,
            last_synced_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute()
        await audit.record(tx, {
          locationId: d.locationId,
          action: 'membership.created',
          entityType: 'membership',
          entityId: id,
          after: {
            customerId: action.customerId,
            plan: plan.key,
            status: inf.status,
            order: inf.lastOrderId,
          },
          ctx: SYSTEM_AUDIT,
        })
        report.created++
        if (inf.status === 'active' && inf.currentPeriodStart)
          report.creditsGranted += await grantCycleCredits(
            tx,
            d,
            { id, currentPeriodStart: inf.currentPeriodStart },
            plan,
          )
      } else {
        const cur = existing!
        await tx
          .updateTable('memberships')
          .set((eb) => ({
            plan_id: plan.id,
            plan_label: labelFor(inf, plan),
            status: inf.status,
            source: 'squarespace',
            sqsp_subscription_ref: inf.subscriptionRef,
            sqsp_customer_id: inf.sqspCustomerId ?? cur.sqsp_customer_id,
            sqsp_product_key: inf.productKey,
            current_period_start: inf.currentPeriodStart ?? null,
            current_period_end: inf.currentPeriodEnd ?? null,
            canceled_at: inf.status === 'canceled' ? (cur.canceled_at ?? now) : null,
            cancel_reason:
              inf.status === 'canceled' ? (cur.cancel_reason ?? 'Inferred: no renewal order') : null,
            last_sqsp_order_id: inf.lastOrderId,
            last_paid_at: inf.lastPaidAt ?? null,
            paid_order_count: inf.paidOrderCount,
            in_grace: inf.inGrace,
            manual_status_at: null,
            review_flags: JSON.stringify(inf.flags),
            inference_reason: inf.reason,
            last_synced_at: now,
            updated_at: now,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', cur.id)
          .execute()
        await audit.record(tx, {
          locationId: d.locationId,
          action: 'membership.synced',
          entityType: 'membership',
          entityId: cur.id,
          before: {
            status: cur.status,
            plan: em?.tier,
            periodEnd: cur.current_period_end?.toISOString() ?? null,
          },
          after: {
            status: inf.status,
            plan: plan.key,
            periodEnd: inf.currentPeriodEnd?.toISOString() ?? null,
            changes: action.changes,
          },
          ctx: SYSTEM_AUDIT,
        })
        report.updated++
        if (inf.status === 'active' && inf.currentPeriodStart)
          report.creditsGranted += await grantCycleCredits(
            tx,
            d,
            { id: cur.id, currentPeriodStart: inf.currentPeriodStart },
            plan,
          )
      }
    }).catch((e: unknown) => {
      // another pass (sync job, contacts job, daily cycle, Sync now) created this member a moment ago: nothing left to do here
      if ((e as { code?: string } | null)?.code !== '23505') throw e
      report.unchanged++
    })
  }
  return report
}

function earliestOrder(
  orders: readonly { createdOn: Date; customerEmail?: string; customerId?: string }[],
  inf: MembershipInference,
): Date | undefined {
  const mine = orders.filter(
    (o) =>
      (inf.email && normalizeEmail(o.customerEmail) === inf.email) ||
      (inf.sqspCustomerId && o.customerId === inf.sqspCustomerId),
  )
  if (mine.length === 0) return undefined
  return new Date(Math.min(...mine.map((o) => o.createdOn.getTime())))
}

/** The member's live membership, else their most recent canceled one. */
export async function currentMembership(
  db: Executor,
  customerId: string,
): Promise<MembershipRow | undefined> {
  return db
    .selectFrom('memberships')
    .selectAll()
    .where('customer_id', '=', customerId)
    .orderBy(sql`(status = 'canceled')`)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
}

export interface CycleReport {
  rolled: number
  creditsGranted: number
}

/**
 * Daily: manual memberships (no subscription data to renew them) roll their period forward by the plan's billing interval, and
 * every active membership gets its cycle credits (idempotent per membership, cycle and rule).
 */
export async function runMembershipCycle(
  db: Db,
  d: { locationId: string; clock: Clock; newId: NewId },
): Promise<CycleReport> {
  await ensurePlans(db, d)
  const plans = await loadPlans(db, d.locationId)
  const now = d.clock.now()
  const out: CycleReport = { rolled: 0, creditsGranted: 0 }
  const manual = await db
    .selectFrom('memberships')
    .selectAll()
    .where('location_id', '=', d.locationId)
    .where('source', '=', 'manual')
    .where('status', '=', 'active')
    .where('current_period_end', '<=', now)
    .execute()
  for (const m of manual) {
    const plan = plans.find((p) => p.id === m.plan_id)
    if (!plan || !m.current_period_end) continue
    let start = m.current_period_end
    let end = addMonths(start, plan.billingIntervalMonths)
    while (end.getTime() <= now.getTime()) {
      start = end
      end = addMonths(start, plan.billingIntervalMonths)
    }
    await db
      .updateTable('memberships')
      .set((eb) => ({
        current_period_start: start,
        current_period_end: end,
        updated_at: now,
        version: eb('version', '+', 1),
      }))
      .where('id', '=', m.id)
      .execute()
    out.rolled++
  }
  const active = await db
    .selectFrom('memberships')
    .select(['id', 'plan_id', 'current_period_start'])
    .where('location_id', '=', d.locationId)
    .where('status', '=', 'active')
    .where('current_period_start', 'is not', null)
    .execute()
  for (const m of active) {
    const plan = plans.find((p) => p.id === m.plan_id)
    if (plan && m.current_period_start)
      out.creditsGranted += await grantCycleCredits(
        db,
        d,
        { id: m.id, currentPeriodStart: m.current_period_start },
        plan,
      )
  }
  return out
}

// ---- manual changes ----------------------------------------------------------------------------------------------------

export interface MembershipPatch {
  status?: MembershipStatus
  planKey?: PlanKey
  /** The size the membership is priced at (ADR 0170); absent keeps it. */
  planClass?: string
  planLabel?: string
  /** The next renewal instant; the period start is derived from the plan's billing interval when it does not fit. */
  renewsAt?: Date
  autoApply?: boolean
  note?: string | null
  expectedVersion?: number
}

export interface PatchActor {
  userId: string
  name: string
  audit: AuditContext
}

/**
 * A hand edit for when the subscription data is missing or wrong. Marks the row so the inference leaves it alone until a newer
 * paid order arrives, audited, and starts the new plan's credits when the tier changes.
 */
export async function patchMembership(
  tx: Tx,
  d: { locationId: string; clock: Clock; newId: NewId },
  id: string,
  p: MembershipPatch,
  actor: PatchActor,
): Promise<MembershipRow> {
  const cur = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('id', '=', id)
    .where('location_id', '=', d.locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!cur) throw new AppError('MEMBERSHIP_NOT_FOUND')
  if (p.expectedVersion !== undefined && p.expectedVersion !== cur.version)
    throw new AppError('VERSION_CONFLICT')
  // Square bills it (ADR 0171 wave Q3b): its status, plan, size and renewal follow Square (the billing actions); only the
  // auto-apply flag and a note are edited here
  if (cur.source === 'square') {
    const touches = [p.status, p.planKey, p.planClass, p.planLabel, p.renewsAt].some((v) => v !== undefined)
    if (touches) throw new AppError('MEMBERSHIP_BILLED_BY_SQUARE')
    return patchSquareMembership(tx, d, cur, p, actor)
  }
  const now = d.clock.now()
  const plans = await loadPlans(tx, d.locationId)
  const plan = p.planKey ? planByKey(plans, p.planKey) : plans.find((x) => x.id === cur.plan_id)
  if (!plan)
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ path: 'planKey', message: 'That plan is not set up' }],
    })
  const status = p.status ?? cur.status
  // setting a membership live (active, past due or paused) stamps a staff action, proof of the client: not on a stale record (D3)
  if (status === 'active' || status === 'past_due' || status === 'paused') await requireConfirmedClient(tx, d, cur.customer_id)
  let start = cur.current_period_start
  let end = cur.current_period_end
  if (p.renewsAt) {
    end = p.renewsAt
    if (!start || start.getTime() >= end.getTime()) start = addMonths(end, -plan.billingIntervalMonths)
  }
  const planChanged = plan.id !== cur.plan_id
  // the size (ADR 0170): the one named, else the current one; the price billed follows the tier and size (null without a price)
  const size =
    p.planClass !== undefined || planChanged
      ? await resolvePlanClass(tx, d.locationId, plan.id, { requested: p.planClass ?? cur.plan_class })
      : null
  const set = {
    plan_id: plan.id,
    ...(size ? { plan_class: size.classKey, tier_price_id: size.tierPriceId } : {}),
    plan_label: p.planLabel?.trim() || (planChanged ? plan.name : cur.plan_label),
    status,
    current_period_start: start,
    current_period_end: end,
    canceled_at: status === 'canceled' ? (cur.canceled_at ?? now) : null,
    cancel_reason: status === 'canceled' ? p.note?.trim() || cur.cancel_reason || 'Canceled by staff' : null,
    auto_apply: p.autoApply ?? cur.auto_apply,
    manual_status_at: now,
    in_grace: status === 'active' ? cur.in_grace : false,
    updated_at: now,
  }
  const row = await tx
    .updateTable('memberships')
    .set((eb) => ({ ...set, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.edited',
    entityType: 'membership',
    entityId: id,
    before: {
      status: cur.status,
      plan: plans.find((x) => x.id === cur.plan_id)?.key,
      planClass: cur.plan_class,
      renewsAt: cur.current_period_end?.toISOString() ?? null,
      autoApply: cur.auto_apply,
    },
    after: {
      status: row.status,
      plan: plan.key,
      planClass: row.plan_class,
      renewsAt: row.current_period_end?.toISOString() ?? null,
      autoApply: row.auto_apply,
      note: p.note ?? null,
    },
    ctx: actor.audit,
  })
  if (row.status === 'active' && row.current_period_start)
    await grantCycleCredits(tx, d, { id, currentPeriodStart: row.current_period_start }, plan, actor.name)
  return row
}

/** The edits a membership billed by Square takes here: the auto-apply flag and a note (kept in the audit). */
async function patchSquareMembership(
  tx: Tx,
  d: { locationId: string; clock: Clock },
  cur: MembershipRow,
  p: MembershipPatch,
  actor: PatchActor,
): Promise<MembershipRow> {
  const now = d.clock.now()
  const row = await tx
    .updateTable('memberships')
    .set((eb) => ({ auto_apply: p.autoApply ?? cur.auto_apply, updated_at: now, version: eb('version', '+', 1) }))
    .where('id', '=', cur.id)
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.edited',
    entityType: 'membership',
    entityId: cur.id,
    before: { autoApply: cur.auto_apply },
    after: { autoApply: row.auto_apply, note: p.note ?? null },
    ctx: actor.audit,
  })
  return row
}

export interface NewManualMembership {
  customerId: string
  planKey: PlanKey
  /** The size it is priced at (ADR 0170); absent: the tier's cheapest priced size, else the smallest size. */
  planClass?: string | null
  planLabel?: string
  renewsAt?: Date
  startedAt?: Date
}

/**
 * A staff membership is a staff action, and a staff action is proof of the client (identity/stale.ts): on a record the stale-record
 * rule holds it would hand the old client's record to whoever holds the number now (a website join with that number asks staff to
 * add the membership). So staff confirm the client first (POST /customers/:id/identity/confirm, audited), which ends the rule; until
 * then 409 MEMBERSHIP_CLIENT_UNCONFIRMED (W4c re-review 3, D3).
 */
async function requireConfirmedClient(tx: Tx, d: { locationId: string; clock: Clock }, customerId: string): Promise<void> {
  const c = await tx.selectFrom('customers').select('phone_e164').where('id', '=', customerId).executeTakeFirst()
  if (!c?.phone_e164) return
  const now = d.clock.now()
  const v = await staleRecord(tx, { locationId: d.locationId, customerId, phone: c.phone_e164, now })
  if (v.stale) {
    const why = staleWhy(v, now)
    throw new AppError('MEMBERSHIP_CLIENT_UNCONFIRMED', { params: { why: why.charAt(0).toUpperCase() + why.slice(1) } })
  }
}

/** A member added by hand (no Squarespace subscription data): active, cycle credits granted, held against the inference. */
export async function createManualMembership(
  tx: Tx,
  d: { locationId: string; clock: Clock; newId: NewId },
  input: NewManualMembership,
  actor: PatchActor,
): Promise<MembershipRow> {
  await ensurePlans(tx, d)
  const plans = await loadPlans(tx, d.locationId)
  const plan = planByKey(plans, input.planKey)
  if (!plan)
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ path: 'planKey', message: 'That plan is not set up' }],
    })
  const customer = await tx
    .selectFrom('customers')
    .select('id')
    .where('id', '=', input.customerId)
    .where('deleted_at', 'is', null)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  if (!customer) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  const live = await tx
    .selectFrom('memberships')
    .select('id')
    .where('customer_id', '=', input.customerId)
    .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .executeTakeFirst()
  if (live) throw new AppError('MEMBERSHIP_EXISTS')
  await requireConfirmedClient(tx, d, input.customerId)
  await requireNotInHousehold(tx, input.customerId)
  const size = await resolvePlanClass(tx, d.locationId, plan.id, { requested: input.planClass })
  const now = d.clock.now()
  const end = input.renewsAt ?? addMonths(now, plan.billingIntervalMonths)
  const start = addMonths(end, -plan.billingIntervalMonths)
  const id = d.newId()
  const row = await tx
    .insertInto('memberships')
    .values({
      id,
      location_id: d.locationId,
      customer_id: input.customerId,
      plan_id: plan.id,
      plan_label: input.planLabel?.trim() || plan.name,
      plan_class: size.classKey,
      tier_price_id: size.tierPriceId,
      status: 'active',
      source: 'manual',
      started_at: input.startedAt ?? now,
      current_period_start: start,
      current_period_end: end,
      manual_status_at: now,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.created',
    entityType: 'membership',
    entityId: id,
    after: { customerId: input.customerId, plan: plan.key, planClass: size.classKey, source: 'manual' },
    ctx: actor.audit,
  })
  await grantCycleCredits(tx, d, { id, currentPeriodStart: start }, plan, actor.name)
  return row
}

// ---- households (ADR 0170) -----------------------------------------------------------------------------------------------

/** 409 MEMBERSHIP_HOUSEHOLD_TAKEN when the client shares someone else's membership as a live household member. */
async function requireNotInHousehold(tx: Tx, customerId: string, exceptMembershipId?: string): Promise<void> {
  const h = await tx
    .selectFrom('membership_household')
    .select('membership_id')
    .where('customer_id', '=', customerId)
    .where('removed_at', 'is', null)
    .executeTakeFirst()
  if (h && h.membership_id !== exceptMembershipId) throw new AppError('MEMBERSHIP_HOUSEHOLD_TAKEN')
}

const LIVE: MembershipStatus[] = ['pending', 'active', 'past_due', 'paused']

async function lockLiveMembership(tx: Tx, locationId: string, id: string): Promise<MembershipRow> {
  const m = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('id', '=', id)
    .where('location_id', '=', locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!m) throw new AppError('MEMBERSHIP_NOT_FOUND')
  if (!LIVE.includes(m.status)) throw new AppError('MEMBERSHIP_NOT_ACTIVE', { detail: 'This membership is canceled' })
  return m
}

/**
 * Adds a client to a membership's household (POST /memberships/:id/household): they are priced and covered as the member, and the
 * membership's credits are shared. A client who holds a live membership or shares another is refused (409
 * MEMBERSHIP_HOUSEHOLD_TAKEN); adding one already in this household changes nothing. Like adding a membership, it is proof of the
 * client: a record the stale-record rule holds is refused until staff confirm the client (409 MEMBERSHIP_CLIENT_UNCONFIRMED).
 */
export async function addHouseholdMember(
  tx: Tx,
  d: { locationId: string; clock: Clock; newId: NewId },
  membershipId: string,
  customerId: string,
  actor: PatchActor,
): Promise<{ row: MembershipRow; added: boolean }> {
  const m = await lockLiveMembership(tx, d.locationId, membershipId)
  const customer = await tx
    .selectFrom('customers')
    .select('id')
    .where('id', '=', customerId)
    .where('deleted_at', 'is', null)
    .where('merged_into', 'is', null)
    .forUpdate()
    .executeTakeFirst()
  if (!customer) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  if (customerId === m.customer_id)
    throw new AppError('VALIDATION_FAILED', {
      detail: 'This client holds the membership already.',
      errors: [{ path: 'customerId', message: 'This client holds the membership already.' }],
    })
  const mine = await tx
    .selectFrom('membership_household')
    .select('id')
    .where('membership_id', '=', m.id)
    .where('customer_id', '=', customerId)
    .where('removed_at', 'is', null)
    .executeTakeFirst()
  if (mine) return { row: m, added: false }
  await requireNotInHousehold(tx, customerId)
  const own = await tx
    .selectFrom('memberships')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('status', 'in', LIVE)
    .executeTakeFirst()
  if (own) throw new AppError('MEMBERSHIP_HOUSEHOLD_TAKEN')
  await requireConfirmedClient(tx, d, customerId)
  const now = d.clock.now()
  await tx
    .insertInto('membership_household')
    .values({ id: d.newId(), membership_id: m.id, customer_id: customerId, added_at: now, added_by: actor.userId })
    .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.household.add',
    entityType: 'membership',
    entityId: m.id,
    after: { customerId, holderId: m.customer_id },
    ctx: actor.audit,
  })
  return { row: m, added: true }
}

/** Removes a client from a membership's household (DELETE /memberships/:id/household/:customerId); 404 when they are not in it. */
export async function removeHouseholdMember(
  tx: Tx,
  d: { locationId: string; clock: Clock },
  membershipId: string,
  customerId: string,
  actor: PatchActor,
): Promise<MembershipRow> {
  const m = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('id', '=', membershipId)
    .where('location_id', '=', d.locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!m) throw new AppError('MEMBERSHIP_NOT_FOUND')
  const r = await tx
    .updateTable('membership_household')
    .set({ removed_at: d.clock.now() })
    .where('membership_id', '=', m.id)
    .where('customer_id', '=', customerId)
    .where('removed_at', 'is', null)
    .executeTakeFirst()
  if (Number(r.numUpdatedRows ?? 0) === 0) throw new AppError('NOT_FOUND', { detail: 'That client is not in this household' })
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'membership.household.remove',
    entityType: 'membership',
    entityId: m.id,
    before: { customerId, holderId: m.customer_id },
    ctx: actor.audit,
  })
  return m
}

/** The live membership a client shares as a household member (not the one they hold), with its holder's name. */
export async function sharedMembership(
  db: Executor,
  customerId: string,
): Promise<{ row: MembershipRow; holderName: string } | undefined> {
  const r = await db
    .selectFrom('membership_household as h')
    .innerJoin('memberships as m', 'm.id', 'h.membership_id')
    .innerJoin('customers as cu', 'cu.id', 'm.customer_id')
    .selectAll('m')
    .select('cu.full_name as holder_name')
    .where('h.customer_id', '=', customerId)
    .where('h.removed_at', 'is', null)
    .where('m.status', 'in', LIVE)
    .executeTakeFirst()
  if (!r) return undefined
  const { holder_name, ...row } = r
  return { row: row as MembershipRow, holderName: holder_name }
}
