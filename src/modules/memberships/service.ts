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
import { raiseAlert, resolveAlertKeys } from '../payments-sync/db/alerts.js'
import { orderFromJson } from '../payments-sync/db/codec.js'
import { normalizeEmail, normalizePhone } from '../payments-sync/identity.js'
import {
  addMonths,
  inferMemberships,
  reconcileMembership,
  type CustomerRef,
  type ExistingMembership,
  type MembershipConfig,
  type MembershipInference,
} from '../payments-sync/membership.js'
import type { ProductMap } from '../payments-sync/product-map.js'
import { grantCycleCredits } from './credits.js'
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
  creditsGranted: number
}

const empty = (): MembershipSyncReport => ({
  considered: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  held: 0,
  needsCustomer: 0,
  creditsGranted: 0,
})

const SYSTEM_AUDIT: AuditContext = { actor: { name: 'Squarespace sync' } }

function labelFor(inf: MembershipInference, plan: Plan): string {
  const l = inf.planLabel.trim()
  return l.toLowerCase() === plan.key ? plan.name : l
}

async function customerRefs(
  db: Executor,
  locationId: string,
  orders: readonly { customerEmail?: string; customerPhone?: string; customerId?: string }[],
): Promise<CustomerRef[]> {
  const emails = [
    ...new Set(orders.map((o) => normalizeEmail(o.customerEmail)).filter((x): x is string => !!x)),
  ]
  const phones = [
    ...new Set(orders.map((o) => normalizePhone(o.customerPhone)).filter((x): x is string => !!x)),
  ]
  const sqsp = [...new Set(orders.map((o) => o.customerId).filter((x): x is string => !!x))]
  if (emails.length + phones.length + sqsp.length === 0) return []
  const rows = await sql<{ id: string; email: string | null; phone_e164: string | null }>`
    select c.id, c.email::text as email, c.phone_e164
    from customers c
    where c.merged_into is null and c.deleted_at is null
      and (c.email = any(${emails}::citext[])
        or c.phone_e164 = any(${phones}::text[])
        or c.id in (select l.customer_id from sqsp_customer_links l
                    where l.location_id = ${locationId} and l.sqsp_customer_id = any(${sqsp}::text[])))`.execute(
    db,
  )
  if (rows.rows.length === 0) return []
  const links = await db
    .selectFrom('sqsp_customer_links')
    .select(['customer_id', 'sqsp_customer_id'])
    .where('location_id', '=', locationId)
    .where(
      'customer_id',
      'in',
      rows.rows.map((r) => r.id),
    )
    .execute()
  return rows.rows.map((r) => ({
    id: r.id,
    emails: r.email ? [r.email] : [],
    phones: r.phone_e164 ? [r.phone_e164] : [],
    sqspCustomerIds: links.filter((l) => l.customer_id === r.id).map((l) => l.sqsp_customer_id),
  }))
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

  const customers = await customerRefs(db, d.locationId, orders)
  const inferences = inferMemberships(orders, d.productMap, customers, now, d.config)
  const plans = await loadPlans(db, d.locationId)
  report.considered = inferences.length

  for (const inf of inferences) {
    const plan = planByKey(plans, inf.tier)
    if (!plan) continue
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
    if (
      existing?.manual_status_at &&
      !(inf.lastPaidAt && inf.lastPaidAt.getTime() > existing.manual_status_at.getTime())
    ) {
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
    if (action.action === 'needs_customer') {
      report.needsCustomer++
      await raiseAlert(db, d, {
        code: 'membership_needs_customer',
        subject: inf.personKey,
        message: `${action.reason}. Paid for ${labelFor(inf, plan)} on order ${inf.lastOrderId}.`,
      })
      continue
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
  const now = d.clock.now()
  const plans = await loadPlans(tx, d.locationId)
  const plan = p.planKey ? planByKey(plans, p.planKey) : plans.find((x) => x.id === cur.plan_id)
  if (!plan)
    throw new AppError('VALIDATION_FAILED', {
      errors: [{ path: 'planKey', message: 'That plan is not set up' }],
    })
  const status = p.status ?? cur.status
  let start = cur.current_period_start
  let end = cur.current_period_end
  if (p.renewsAt) {
    end = p.renewsAt
    if (!start || start.getTime() >= end.getTime()) start = addMonths(end, -plan.billingIntervalMonths)
  }
  const planChanged = plan.id !== cur.plan_id
  const set = {
    plan_id: plan.id,
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
      renewsAt: cur.current_period_end?.toISOString() ?? null,
      autoApply: cur.auto_apply,
    },
    after: {
      status: row.status,
      plan: plan.key,
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

export interface NewManualMembership {
  customerId: string
  planKey: PlanKey
  planLabel?: string
  renewsAt?: Date
  startedAt?: Date
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
    after: { customerId: input.customerId, plan: plan.key, source: 'manual' },
    ctx: actor.audit,
  })
  await grantCycleCredits(tx, d, { id, currentPeriodStart: start }, plan, actor.name)
  return row
}
