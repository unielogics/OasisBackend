// "Move members" (ADR 0171 D9, plan decision 8): a tier price edit is grandfathered (members keep the price they joined at, the
// variation their subscription bills) until admin presses Move members for a tier:
//   POST /catalog/tiers/:key/move-members {notice}  every Square member of the tier billed at an older price of their size gets a
//       scheduled change (kind move) to the size's current price after `notice` days (default memberships.price_change_notice_days,
//       30) and a notice by text and email naming the new price and the date; the current prices must be at Square already;
//   square.plans.swap (daily)  a move whose notice has run sends SwapPlan (any earlier scheduled swap removed first); Square makes
//       the swap at the next billing date, and the subscription event that follows moves the membership to the new price row.
// BulkSwapPlan is not used: per-subscription SwapPlan is what the sandbox verified; a bulk swap would also move members Oasis did
// not notify (anyone on the old variation, whatever the notice said).
import { DateTime } from 'luxon'
import * as audit from '../../../platform/audit.js'
import type { AuditContext } from '../../../platform/audit.js'
import { transaction, type Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting } from '../../../platform/settings.js'
import { squareWritesOn } from '../../square/links.js'
import type { ScheduledChange } from '../schema.js'
import { locationTz } from '../view.js'
import { replaceSwap } from './actions.js'
import { billingEmailOf } from './billing.js'
import { sendPriceChange, type NoticeDeps } from './notify.js'
import { shopDate } from './policy.js'
import type { SquareSteps } from './steps.js'
import './problems.js'

const DAY = 86_400_000

export interface MoveResult {
  tierKey: string
  /** Members told and scheduled. */
  moving: number
  /** Members with a staff change already scheduled (left alone). */
  skipped: number
  /** When their price moves (the first bill on or after this instant). */
  swapAfter: string
}

/** POST /catalog/tiers/:key/move-members (see the header), in the caller's transaction. */
export async function moveMembers(
  tx: Tx,
  d: NoticeDeps,
  input: { tierKey: string; noticeDays?: number; by: string; audit?: AuditContext },
): Promise<MoveResult> {
  const plan = await tx
    .selectFrom('membership_plans')
    .select(['id', 'key', 'name'])
    .where('location_id', '=', d.locationId)
    .where('key', '=', input.tierKey)
    .forUpdate()
    .executeTakeFirst()
  if (!plan) throw new AppError('NOT_FOUND', { detail: 'That membership tier does not exist' })
  const noticeDays = input.noticeDays ?? (await getSetting(tx, d.locationId, 'memberships.price_change_notice_days')).value
  const now = d.clock.now()
  const swapAfter = new Date(now.getTime() + noticeDays * DAY)
  const tz = await locationTz(tx, d.locationId)
  const dateLabel = DateTime.fromJSDate(swapAfter, { zone: tz }).toFormat('ccc, LLL d')
  const current = await tx
    .selectFrom('membership_tier_prices')
    .select(['id', 'class_key', 'monthly_cents', 'square_state', 'square_variation_id'])
    .where('plan_id', '=', plan.id)
    .where('superseded_at', 'is', null)
    .execute()
  const members = await tx
    .selectFrom('memberships as m')
    .leftJoin('membership_tier_prices as p', 'p.id', 'm.tier_price_id')
    .select(['m.id', 'm.customer_id', 'm.plan_class', 'm.tier_price_id', 'm.scheduled_change', 'p.monthly_cents as from_cents'])
    .where('m.location_id', '=', d.locationId)
    .where('m.plan_id', '=', plan.id)
    .where('m.source', '=', 'square')
    .where('m.status', 'in', ['active', 'past_due', 'paused'])
    .forUpdate(['m'])
    .execute()
  const out: MoveResult = { tierKey: plan.key, moving: 0, skipped: 0, swapAfter: swapAfter.toISOString() }
  const due = members
    .map((m) => ({ m, to: current.find((c) => c.class_key === m.plan_class) }))
    .filter((x) => x.to && x.to.id !== x.m.tier_price_id)
  if (due.some((x) => x.to!.square_state !== 'synced' || !x.to!.square_variation_id)) throw new AppError('TIER_PRICE_NOT_SYNCED')
  for (const { m, to } of due) {
    const prior = m.scheduled_change as ScheduledChange | null
    if (prior?.kind === 'change') {
      out.skipped++
      continue
    }
    const change: ScheduledChange = {
      kind: 'move',
      toTierPriceId: to!.id,
      fromTierPriceId: m.tier_price_id,
      planKey: plan.key,
      planClass: m.plan_class,
      monthlyCents: to!.monthly_cents,
      effectiveDate: null,
      swapAfter: swapAfter.toISOString(),
      noticeSentAt: now.toISOString(),
      requestedAt: now.toISOString(),
      by: input.by,
    }
    await tx
      .updateTable('memberships')
      .set((eb) => ({ scheduled_change: JSON.stringify(change), updated_at: now, version: eb('version', '+', 1) }))
      .where('id', '=', m.id)
      .execute()
    await sendPriceChange(tx, d, {
      membershipId: m.id,
      customerId: m.customer_id,
      tierName: plan.name,
      fromCents: m.from_cents ?? 0,
      toCents: to!.monthly_cents,
      dateLabel,
      email: await billingEmailOf(tx, m.id),
      moveKey: `${m.id}:${to!.id}`,
    })
    out.moving++
  }
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'catalog.tier.move_members',
    entityType: 'membership_plan',
    entityId: plan.key,
    after: { ...out, noticeDays },
    ctx: input.audit,
  })
  return out
}

export interface SwapReport {
  status: 'skipped' | 'done'
  reason?: string
  sent: number
  failed: number
}

/** square.plans.swap for one location (see the header). Skipped while Square writes are off. */
export async function runPlanSwaps(x: SquareSteps): Promise<SwapReport> {
  if (!squareWritesOn(x.env)) return { status: 'skipped', reason: 'Square writes are off (SQUARE_WRITES_ENABLED=false)', sent: 0, failed: 0 }
  const now = x.clock.now()
  const rows = await x.db
    .selectFrom('memberships as m')
    .select(['m.id', 'm.square_subscription_id', 'm.scheduled_change'])
    .where('m.location_id', '=', x.locationId)
    .where('m.source', '=', 'square')
    .where('m.status', 'in', ['active', 'past_due', 'paused'])
    .where('m.square_subscription_id', 'is not', null)
    .where('m.scheduled_change', 'is not', null)
    .execute()
  const report: SwapReport = { status: 'done', sent: 0, failed: 0 }
  const tz = await locationTz(x.db, x.locationId)
  for (const r of rows) {
    const c = r.scheduled_change as ScheduledChange | null
    if (!c || c.kind !== 'move' || c.effectiveDate || !c.swapAfter || new Date(c.swapAfter).getTime() > now.getTime()) continue
    const price = await x.db.selectFrom('membership_tier_prices').select(['square_variation_id']).where('id', '=', c.toTierPriceId).executeTakeFirst()
    if (!price?.square_variation_id) continue
    // staff undid this very swap this billing period: Square must not get it again before the next billing date (see actions.ts)
    const undone = await x.db.selectFrom('memberships').select('swap_undone_variations').where('id', '=', r.id).executeTakeFirstOrThrow()
    if (undone.swap_undone_variations.includes(price.square_variation_id)) continue
    let effective: string | null
    try {
      effective = (await replaceSwap(x.api, r.square_subscription_id!, price.square_variation_id)).action?.effective_date ?? null
    } catch (e) {
      x.logger?.warn({ membership: r.id, err: e instanceof Error ? e.message : String(e) }, 'square: a price move could not be sent')
      report.failed++
      continue
    }
    await transaction(x.db, async (tx) => {
      const cur = await tx.selectFrom('memberships').select(['scheduled_change']).where('id', '=', r.id).forUpdate().executeTakeFirstOrThrow()
      const still = cur.scheduled_change as ScheduledChange | null
      if (!still || still.kind !== 'move' || still.toTierPriceId !== c.toTierPriceId) return
      // Square answers the action's date; without one (a swap Square applied at once) the swap is done today
      const next: ScheduledChange = { ...still, effectiveDate: effective ?? shopDate(now, tz) }
      await tx.updateTable('memberships').set({ scheduled_change: JSON.stringify(next), updated_at: now }).where('id', '=', r.id).execute()
      await audit.record(tx, {
        locationId: x.locationId,
        action: 'membership.square.move_sent',
        entityType: 'membership',
        entityId: r.id,
        after: { toTierPriceId: c.toTierPriceId, effectiveDate: effective },
        ctx: { actor: { name: 'Square billing' } },
      })
    })
    report.sent++
  }
  return report
}
