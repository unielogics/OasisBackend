// POST /public/memberships (ADR 0150): joining on the website creates the customer (or links by phone), their vehicles and a
// membership in the pending state tied to the tier's Squarespace product; nothing is charged online. The person is told the
// checkout link will be texted; staff get a notification asking them to send it (the dashboard's payment-link flow), with the
// mapped product named, or with the fact that the product map has no product for the plan (then an open alert too). The
// membership activates when the existing Squarespace sync sees the paid subscription order.
import * as audit from '../../platform/audit.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { formatPhoneDisplay } from '../../platform/phone.js'
import { upsertCustomerByPhone, upsertVehicleByPlate } from '../customers/service.js'
import { ensurePlans, loadPlans, planByKey } from '../memberships/plans.js'
import { notifyManagers } from '../messaging/notify.js'
import { raiseAlert } from '../payments-sync/db/alerts.js'
import { listProductRows } from '../payments-sync/db/product-map.js'
import type { ProductMapEntry } from '../payments-sync/product-map.js'
import { parseVehicleLabel } from './bookings.js'
import type { PublicDeps, PublicLocation, PublicRequest } from './deps.js'
import { enforceLimits, publicLimitChecks } from './limits.js'
import { phoneOrThrow } from './otp.js'
import './problems.js'
import { tierSpec, type PublicTier } from './tiers.js'

export interface WebJoinInput {
  tier: PublicTier
  name: string
  phone: string
  email: string
  vehicles: { car: string; plate?: string }[]
  smsConsent: boolean
  agree: true
}

export interface WebJoinResult {
  memberRef: string
  status: 'pending_payment'
  next: 'checkout_link_by_sms'
  tier: PublicTier
  plan: string
  confirmationBy: 'sms' | 'none'
}

export interface TierProduct {
  productId: string | null
  sku: string | null
  name: string | null
}

/** The Squarespace product sold for a plan: the environment bootstrap map first, then the admin's table rows. */
export async function membershipProductFor(
  tx: Tx,
  locationId: string,
  envJson: string | undefined,
  planKey: string,
): Promise<TierProduct | undefined> {
  const rows = await listProductRows(tx, locationId)
  const row = rows.find((r) => r.active && r.kind === 'membership' && r.plan === planKey)
  if (row) return { productId: row.productId, sku: row.sku, name: row.name }
  try {
    const entries = envJson?.trim() ? (JSON.parse(envJson) as ProductMapEntry[]) : []
    const e = entries.find((x) => x.kind === 'membership' && (x.tier === planKey || (x.tierLabel ?? '').toLowerCase().includes(planKey)))
    if (e) return { productId: e.productId ?? null, sku: e.sku ?? null, name: e.label ?? e.tierLabel ?? null }
  } catch {
    // an invalid bootstrap map is ignored here as the sync ignores it
  }
  return undefined
}

export const memberRefOf = (membershipId: string): string => `OAS-M-${membershipId.replace(/-/g, '').slice(-8).toUpperCase()}`

export async function chargeJoinLimits(d: PublicDeps, r: PublicRequest, phone: string): Promise<void> {
  await enforceLimits(d.app.db, d.app.clock, publicLimitChecks('membership', r.ip, phone))
}

export async function joinWeb(
  tx: Tx,
  d: PublicDeps,
  loc: PublicLocation,
  r: PublicRequest,
  input: WebJoinInput,
): Promise<WebJoinResult> {
  const phone = phoneOrThrow(input.phone)
  const { clock, newId } = d.app
  const now = clock.now()
  const spec = tierSpec(input.tier)
  const dctx = { locationId: loc.id, clock, newId }
  await ensurePlans(tx, dctx)
  const plan = planByKey(await loadPlans(tx, loc.id), spec.planKey)
  if (!plan)
    throw new AppError('VALIDATION_FAILED', {
      detail: 'That plan is not available right now.',
      errors: [{ path: 'body.tier', message: 'That plan is not available right now.' }],
    })

  const { customer } = await upsertCustomerByPhone(tx, {
    newId,
    now,
    fullName: input.name,
    phone,
    email: input.email,
    source: 'online',
    smsOptIn: input.smsConsent ? 'online' : null,
  })
  for (const v of input.vehicles) {
    const parsed = parseVehicleLabel(v.car)
    if (!parsed.make && !v.plate) continue
    await upsertVehicleByPlate(tx, {
      newId,
      customerId: customer.id,
      year: parsed.year,
      make: parsed.make,
      model: parsed.model,
      plate: v.plate ?? null,
    })
  }
  const live = await tx
    .selectFrom('memberships')
    .select(['id', 'status'])
    .where('customer_id', '=', customer.id)
    .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .executeTakeFirst()
  if (live) throw new AppError('PUBLIC_ALREADY_MEMBER')

  const product = await membershipProductFor(tx, loc.id, d.app.env.SQSP_PRODUCT_MAP, plan.key)
  const id = newId()
  await tx
    .insertInto('memberships')
    .values({
      id,
      location_id: loc.id,
      customer_id: customer.id,
      plan_id: plan.id,
      plan_label: spec.label,
      status: 'pending',
      source: 'manual',
      sqsp_subscription_ref: null,
      sqsp_customer_id: null,
      sqsp_product_key: product?.productId ?? product?.sku ?? null,
      started_at: now,
      current_period_start: null,
      current_period_end: null,
      canceled_at: null,
      cancel_reason: null,
      last_sqsp_order_id: null,
      last_paid_at: null,
      manual_status_at: null,
      review_flags: JSON.stringify([]),
      inference_reason: product
        ? `Joined on the website; awaiting the Squarespace checkout of ${product.name ?? product.sku ?? product.productId}`
        : 'Joined on the website; the product map has no product for this plan, so the checkout link must be sent by hand',
      last_synced_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  await audit.record(tx, {
    locationId: loc.id,
    action: 'membership.created',
    entityType: 'membership',
    entityId: id,
    after: { customerId: customer.id, plan: plan.key, tier: spec.key, status: 'pending', source: 'web', product: product?.productId ?? product?.sku ?? null },
    ctx: { actor: { name: 'Website' }, requestId: r.requestId, idempotencyKey: r.idempotencyKey ?? null, ip: r.ip },
  })
  const who = `${customer.fullName} (${formatPhoneDisplay(phone)})`
  await notifyManagers(
    tx,
    {
      locationId: loc.id,
      kind: 'membership.web_join',
      title: `Website join: send ${customer.fullName.trim().split(/\s+/)[0]} the ${spec.label} checkout link`,
      body: product
        ? `${who} joined ${spec.label} on the website. Text them the Squarespace checkout link for "${product.name ?? product.sku ?? product.productId}"; the membership activates when the order is paid.`
        : `${who} joined ${spec.label} on the website. The Squarespace product map has no product for the ${plan.name} plan: text them the checkout link by hand and map the product in Settings so the payment activates the membership.`,
      entityType: 'membership',
      entityId: id,
    },
    { newId, clock },
  )
  if (!product)
    await raiseAlert(tx, dctx, {
      code: 'product_map_empty',
      subject: `membership:${id}`,
      message: `${who} joined ${spec.label} on the website, but no Squarespace product is mapped to the ${plan.name} plan.`,
    })
  const sent = await d.queue.enqueue(tx, {
    customerId: customer.id,
    appointmentId: null,
    templateKey: 'membership_welcome_web',
    vars: { first: customer.fullName.trim().split(/\s+/)[0] ?? customer.fullName, tier: spec.label },
    purpose: 'membership',
  })
  return {
    memberRef: memberRefOf(id),
    status: 'pending_payment',
    next: 'checkout_link_by_sms',
    tier: spec.key,
    plan: spec.label,
    confirmationBy: sent.queued ? 'sms' : 'none',
  }
}
