// The membership tiers' public fields (ADR 0160, plan A; ADR 0170): the name the website and the assistant sell a tier under, its
// starting monthly price (the lowest of its prices by size), its perks (also what the dashboard's Membership tab lists) and the
// Squarespace subscription checkout the membership link redirects to. The checkout URL is internal: the public catalog never carries
// it (only a verified membership link leads there, design section 5). Tiers are edited in Settings → Memberships (catalog/tiers.ts);
// the old per-plan save (PUT /catalog/plans/{key}) is retired (410).
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import '../memberships/schema.js'
import { loadTierCells, tierFromPrice } from './price-book.js'
import type { PlanKey } from '../memberships/schema.js'
import type { PublicTier } from '../public/tiers.js'

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
  /** The tier's name (Gold, VIP). */
  name: string
  active: boolean
  /** The key the website sells it under (the key of a public tier), or null for a tier not sold online. */
  websiteTier: PublicTier | null
  version: number
}

/**
 * Every tier with its public fields, in tier order. monthlyPriceCents is the tier's starting price: the lowest of its current prices
 * over the active sizes (null: no price yet, not sold online); publicLabel is the tier's name.
 */
export async function listPlanPublic(db: Executor, locationId: string): Promise<PlanPublic[]> {
  const [rows, cells, classes] = await Promise.all([
    db
      .selectFrom('membership_plans')
      .select(['id', 'key', 'name', 'active', 'public', 'version', 'perks', 'checkout_url'])
      .where('location_id', '=', locationId)
      .orderBy('sort')
      .orderBy('key')
      .execute(),
    loadTierCells(db, locationId),
    db
      .selectFrom('vehicle_classes')
      .select(['key', 'label', 'sort'])
      .where('location_id', '=', locationId)
      .where('active', '=', true)
      .orderBy('sort')
      .orderBy('key')
      .execute(),
  ])
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    active: r.active,
    version: r.version,
    publicLabel: r.name,
    monthlyPriceCents: tierFromPrice({ classes }, cells.get(r.id) ?? [])?.monthlyCents ?? null,
    perks: r.perks,
    checkoutUrl: r.checkout_url,
    websiteTier: r.public ? r.key : null,
  }))
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
