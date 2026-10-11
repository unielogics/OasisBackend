// The membership plans' public fields (ADR 0160, plan A): the label the website and the assistant sell a plan under (Gold, VIP),
// its monthly price, its perks (also what the dashboard's Membership tab lists) and the Squarespace subscription checkout the
// membership link redirects to. The checkout URL is internal: the public catalog never carries it (only a verified membership link
// leads there, design section 5). The plans themselves (credit rules, discounts, colours) stay the memberships module's.
import type { Executor, Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import * as realtime from '../../platform/realtime.js'
import '../memberships/schema.js'
import type { PlanKey } from '../memberships/schema.js'
import { PUBLIC_TIERS, type PublicTier } from '../public/tiers.js'

export const PLAN_KEYS: readonly PlanKey[] = ['essential', 'premium', 'executive', 'exotic']
export const MAX_PERKS = 12
export const MAX_PERK_LENGTH = 120

export interface PlanPublicFields {
  publicLabel: string | null
  monthlyPriceCents: number | null
  perks: string[]
  checkoutUrl: string | null
}

export interface PlanPublic extends PlanPublicFields {
  key: PlanKey
  /** The dashboard's plan name (Premium, Executive). */
  name: string
  active: boolean
  /** The website tier sold over this plan (gold = premium, vip = executive), or null. */
  websiteTier: PublicTier | null
  version: number
}

const COLUMNS = ['key', 'name', 'active', 'version', 'public_label', 'monthly_price_cents', 'perks', 'checkout_url', 'sort'] as const

type Row = {
  key: PlanKey
  name: string
  active: boolean
  version: number
  public_label: string | null
  monthly_price_cents: number | null
  perks: string[]
  checkout_url: string | null
}

const toPlan = (r: Row): PlanPublic => ({
  key: r.key,
  name: r.name,
  active: r.active,
  version: r.version,
  publicLabel: r.public_label,
  monthlyPriceCents: r.monthly_price_cents,
  perks: r.perks,
  checkoutUrl: r.checkout_url,
  websiteTier: PUBLIC_TIERS.find((t) => t.planKey === r.key)?.key ?? null,
})

export async function listPlanPublic(db: Executor, locationId: string): Promise<PlanPublic[]> {
  const rows = await db
    .selectFrom('membership_plans')
    .select([...COLUMNS])
    .where('location_id', '=', locationId)
    .orderBy('sort')
    .orderBy('key')
    .execute()
  return rows.map(toPlan)
}

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

/** The database's own rule (membership_plans_checkout_url_check), checked first so the caller gets a 422 rather than a 500. */
const CHECKOUT_RE = /^https:\/\/([a-z0-9-]+\.)*squarespace\.com(\/\S*)?$/

/**
 * A Squarespace checkout URL: https, on squarespace.com or one of its subdomains, no user, password or port, at most 2048
 * characters. Returns the URL as typed (trimmed); throws 422 on `path` otherwise.
 */
export function checkCheckoutUrl(raw: string, path = 'checkoutUrl'): string {
  const url = raw.trim()
  const bad = (): AppError => invalid(path, 'Use the plan’s Squarespace checkout link (https://….squarespace.com/…).')
  if (url.length === 0 || url.length > 2048 || !CHECKOUT_RE.test(url)) throw bad()
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw bad()
  }
  const host = u.hostname
  if (
    u.protocol !== 'https:' ||
    u.username !== '' ||
    u.password !== '' ||
    u.port !== '' ||
    !(host === 'squarespace.com' || host.endsWith('.squarespace.com'))
  )
    throw bad()
  return url
}

/** Trims and checks the fields; throws 422 on the first broken rule. */
export function normalizePlanPublic(f: PlanPublicFields): PlanPublicFields {
  const label = f.publicLabel?.trim() || null
  if (label !== null && label.length > 40) throw invalid('publicLabel', 'The public name can be at most 40 characters.')
  const price = f.monthlyPriceCents
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > 10_000_000))
    throw invalid('monthlyPriceCents', 'Enter a monthly price in whole cents, from 0 to $100,000.')
  const perks = f.perks.map((p) => p.trim()).filter((p) => p !== '')
  if (perks.length > MAX_PERKS) throw invalid('perks', `List at most ${MAX_PERKS} perks.`)
  perks.forEach((p, i) => {
    if (p.length > MAX_PERK_LENGTH) throw invalid(`perks.${i}`, `A perk can be at most ${MAX_PERK_LENGTH} characters.`)
  })
  if (new Set(perks.map((p) => p.toLowerCase())).size !== perks.length) throw invalid('perks', 'A perk is listed twice.')
  const checkoutUrl = f.checkoutUrl === null || f.checkoutUrl.trim() === '' ? null : checkCheckoutUrl(f.checkoutUrl)
  return { publicLabel: label, monthlyPriceCents: price, perks, checkoutUrl }
}

const auditOf = (p: PlanPublicFields) => ({
  publicLabel: p.publicLabel,
  monthlyPriceCents: p.monthlyPriceCents,
  perks: p.perks,
  checkoutUrl: p.checkoutUrl,
})

const same = (a: PlanPublicFields, b: PlanPublicFields): boolean =>
  a.publicLabel === b.publicLabel &&
  a.monthlyPriceCents === b.monthlyPriceCents &&
  a.checkoutUrl === b.checkoutUrl &&
  a.perks.length === b.perks.length &&
  a.perks.every((p, i) => p === b.perks[i])

export async function putPlanPublic(
  tx: Tx,
  input: { locationId: string; key: string; fields: PlanPublicFields; expectedVersion?: number; audit?: audit.AuditContext },
): Promise<{ plan: PlanPublic; changed: boolean }> {
  const row = (PLAN_KEYS as readonly string[]).includes(input.key)
    ? await tx
        .selectFrom('membership_plans')
        .select([...COLUMNS])
        .where('location_id', '=', input.locationId)
        .where('key', '=', input.key as PlanKey)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That plan does not exist' })
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: row.version } })
  const before = toPlan(row)
  const next = normalizePlanPublic(input.fields)
  if (same(before, next)) return { plan: before, changed: false }
  const updated = await tx
    .updateTable('membership_plans')
    .set((eb) => ({
      public_label: next.publicLabel,
      monthly_price_cents: next.monthlyPriceCents,
      perks: next.perks,
      checkout_url: next.checkoutUrl,
      version: eb('version', '+', 1),
      updated_at: eb.fn('app_now', []),
    }))
    .where('location_id', '=', input.locationId)
    .where('key', '=', row.key)
    .returning([...COLUMNS])
    .executeTakeFirstOrThrow()
  const plan = toPlan(updated)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.plan.update',
    entityType: 'membership_plan',
    entityId: plan.key,
    before: auditOf(before),
    after: auditOf(plan),
    ctx: input.audit,
  })
  await realtime.publish(tx, {
    locationId: input.locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'catalog', key: 'plans', plan: plan.key, version: plan.version },
  })
  return { plan, changed: true }
}
