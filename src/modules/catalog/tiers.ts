// Settings → Memberships (ADR 0170, plan decisions 2, 3 and 8): the membership tiers, each with its name, badge colour, perks, member
// % off, VIP booking flag, car cap, whether it is sold online, what it includes (inclusions: services covered N times a cycle,
// unlimited, or on every visit) and its monthly price per vehicle size. A tier's key never changes (links, checkouts, Squarespace
// products and memberships refer to it). Prices are append-only (membership_tier_prices): a save supersedes the current price of
// a size and adds a new row (square_state pending, synced to Square in wave Q3b), and bumps the tier's price_version; members keep
// the price they joined at until staff move them (wave Q3b). Every write is audited and publishes settings.changed.
import type { Executor, Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { loadPlans, type Inclusion, type Plan } from '../memberships/plans.js'
import type { InclusionMode, TierPriceSquareState } from '../memberships/schema.js'
import { COLOUR } from './categories.js'
import { normalizePlanPublic } from './plans.js'
import { tierFromPrice } from './price-book.js'
import '../identity/schema.js'
import '../payments-sync/db/schema.js'
import './problems.js'
import './schema.js'

export const TIER_KEY = /^[a-z][a-z0-9_]{0,31}$/
export const MAX_TIERS = 12
export const MAX_INCLUSIONS = 20
const MAX_MONTHLY_CENTS = 10_000_000

export interface InclusionInput {
  /** An existing inclusion of the tier to keep (its credit history follows it); omitted for a new one. */
  id?: string
  label: string
  mode: InclusionMode
  /** per_cycle: visits a billing cycle, null = unlimited; must be null for every_visit. */
  perCycle: number | null
  autoApply: boolean
  active?: boolean
  serviceIds: string[]
}

export interface TierFields {
  name: string
  /** #RRGGBB: the board badge colour. */
  colour: string
  /** #RRGGBB: the badge background; derived from the colour when omitted. */
  bgColour?: string | null
  sort: number
  active: boolean
  public: boolean
  vipBooking: boolean
  memberDiscountBp: number
  maxVehicles: number | null
  perks: string[]
  checkoutUrl: string | null
  inclusions: InclusionInput[]
}

export interface TierPriceView {
  class: string
  monthlyCents: number
  priceVersion: number
  effectiveFrom: Date
  squareState: TierPriceSquareState
}

export interface Tier {
  key: string
  name: string
  colour: string
  bgColour: string
  sort: number
  active: boolean
  public: boolean
  vipBooking: boolean
  memberDiscountBp: number
  maxVehicles: number | null
  perks: string[]
  checkoutUrl: string | null
  /** The key before ADR 0170 (premium, executive), which old Squarespace product names and links resolve through. */
  legacyKey: string | null
  priceVersion: number
  version: number
  squarePlanId: string | null
  inclusions: Inclusion[]
  /** The current price of each size that has one, in size order. */
  prices: TierPriceView[]
  /** The lowest current price over the active sizes (null: no price, not sold online). */
  fromMonthlyCents: number | null
  /** Memberships, links or checkouts name it: it can be turned off, never deleted. */
  sold: boolean
}

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

/** A light background for a badge colour: 85% of the way to white. */
export function lightOf(colour: string): string {
  const n = parseInt(colour.slice(1), 16)
  const ch = (shift: number): string => {
    const v = (n >> shift) & 0xff
    return Math.round(v + (255 - v) * 0.85)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${ch(16)}${ch(8)}${ch(0)}`.toUpperCase()
}

// ---- reads -------------------------------------------------------------------------------------------------------------------

async function soldKeys(db: Executor, locationId: string): Promise<Set<string>> {
  const [members, links, checkouts] = await Promise.all([
    db
      .selectFrom('memberships as m')
      .innerJoin('membership_plans as p', 'p.id', 'm.plan_id')
      .select('p.key')
      .distinct()
      .where('m.location_id', '=', locationId)
      .execute(),
    db.selectFrom('client_links').select('plan_key').distinct().where('location_id', '=', locationId).where('plan_key', 'is not', null).execute(),
    db.selectFrom('membership_checkouts').select('plan_key').distinct().where('location_id', '=', locationId).execute(),
  ])
  return new Set([...members.map((r) => r.key), ...links.map((r) => r.plan_key!), ...checkouts.map((r) => r.plan_key)])
}

/** Every tier with its inclusions and current prices, in tier order. */
export async function listTiers(db: Executor, locationId: string): Promise<Tier[]> {
  const [plans, rows, prices, classes, sold] = await Promise.all([
    loadPlans(db, locationId),
    db
      .selectFrom('membership_plans')
      .select(['id', 'color', 'bg_color', 'checkout_url', 'version', 'square_plan_id'])
      .where('location_id', '=', locationId)
      .execute(),
    db
      .selectFrom('membership_tier_prices')
      .select(['plan_id', 'class_key', 'monthly_cents', 'price_version', 'effective_from', 'square_state'])
      .where('location_id', '=', locationId)
      .where('superseded_at', 'is', null)
      .execute(),
    db
      .selectFrom('vehicle_classes')
      .select(['key', 'label', 'sort', 'active'])
      .where('location_id', '=', locationId)
      .orderBy('sort')
      .orderBy('key')
      .execute(),
    soldKeys(db, locationId),
  ])
  const active = classes.filter((c) => c.active)
  const order = new Map(classes.map((c, i) => [c.key, i]))
  return plans.map((p) => {
    const r = rows.find((x) => x.id === p.id)!
    const mine = prices
      .filter((x) => x.plan_id === p.id)
      .sort((a, b) => (order.get(a.class_key) ?? 99) - (order.get(b.class_key) ?? 99))
    return {
      key: p.key,
      name: p.name,
      colour: r.color,
      bgColour: r.bg_color,
      sort: p.sort,
      active: p.active,
      public: p.public,
      vipBooking: p.vipBooking,
      memberDiscountBp: p.memberDiscountBp,
      maxVehicles: p.maxVehicles,
      perks: p.perks,
      checkoutUrl: r.checkout_url,
      legacyKey: p.legacyKey,
      priceVersion: p.priceVersion,
      version: r.version,
      squarePlanId: r.square_plan_id,
      inclusions: p.inclusions,
      prices: mine.map((x) => ({
        class: x.class_key,
        monthlyCents: x.monthly_cents,
        priceVersion: x.price_version,
        effectiveFrom: x.effective_from,
        squareState: x.square_state,
      })),
      fromMonthlyCents:
        tierFromPrice(
          { classes: active },
          mine.map((x) => ({ classKey: x.class_key, monthlyCents: x.monthly_cents })),
        )?.monthlyCents ?? null,
      sold: sold.has(p.key),
    }
  })
}

export async function requireTier(db: Executor, locationId: string, key: string): Promise<Tier> {
  const t = TIER_KEY.test(key) ? (await listTiers(db, locationId)).find((x) => x.key === key) : undefined
  if (!t) throw new AppError('NOT_FOUND', { detail: 'That membership tier does not exist' })
  return t
}

// ---- checks ------------------------------------------------------------------------------------------------------------------

async function checkFields(db: Executor, locationId: string, f: TierFields): Promise<TierFields> {
  const name = f.name.trim()
  if (name === '' || name.length > 40) throw invalid('name', 'Enter a name of up to 40 characters.')
  if (!COLOUR.test(f.colour)) throw invalid('colour', 'Use a colour like #8A6D3B.')
  if (f.bgColour != null && !COLOUR.test(f.bgColour)) throw invalid('bgColour', 'Use a colour like #F2E9D6.')
  if (!Number.isInteger(f.sort) || f.sort < -100_000 || f.sort > 100_000) throw invalid('sort', 'Enter an order from -100000 to 100000.')
  if (!Number.isInteger(f.memberDiscountBp) || f.memberDiscountBp < 0 || f.memberDiscountBp > 10_000)
    throw invalid('memberDiscountBp', 'Enter a member % off from 0 to 100.')
  if (f.maxVehicles !== null && (!Number.isInteger(f.maxVehicles) || f.maxVehicles < 1 || f.maxVehicles > 20))
    throw invalid('maxVehicles', 'Enter a number of cars from 1 to 20, or leave it empty.')
  const pub = normalizePlanPublic({ publicLabel: null, monthlyPriceCents: null, perks: f.perks, checkoutUrl: f.checkoutUrl })
  if (f.inclusions.length > MAX_INCLUSIONS) throw invalid('inclusions', `List at most ${MAX_INCLUSIONS} inclusions.`)
  const services = new Set(
    (await db.selectFrom('services').select('id').where('location_id', '=', locationId).execute()).map((s) => s.id),
  )
  const ids = new Set<string>()
  const inclusions = f.inclusions.map((inc, i) => {
    const at = `inclusions.${i}`
    const label = inc.label.trim()
    if (label === '' || label.length > 80) throw invalid(`${at}.label`, 'Enter a name of up to 80 characters.')
    if (inc.id !== undefined) {
      if (ids.has(inc.id)) throw invalid(`${at}.id`, 'This inclusion is listed twice.')
      ids.add(inc.id)
    }
    if (inc.mode === 'every_visit' && inc.perCycle !== null)
      throw invalid(`${at}.perCycle`, 'An inclusion on every visit has no count: leave it empty.')
    if (inc.perCycle !== null && (!Number.isInteger(inc.perCycle) || inc.perCycle < 1 || inc.perCycle > 100))
      throw invalid(`${at}.perCycle`, 'Enter how many a month, from 1 to 100, or leave it empty for unlimited.')
    if (inc.serviceIds.length === 0) throw invalid(`${at}.serviceIds`, 'Pick at least one service this inclusion covers.')
    const unique = [...new Set(inc.serviceIds)]
    unique.forEach((id, j) => {
      if (!services.has(id)) throw invalid(`${at}.serviceIds.${j}`, 'Pick packages or add-ons of the catalog.')
    })
    return { ...inc, label, serviceIds: unique }
  })
  return { ...f, name, colour: f.colour.toUpperCase(), bgColour: f.bgColour?.toUpperCase() ?? null, perks: pub.perks, checkoutUrl: pub.checkoutUrl, inclusions }
}

// ---- writes ------------------------------------------------------------------------------------------------------------------

async function publish(tx: Tx, locationId: string, key: string, what: 'tiers' | 'tier_prices'): Promise<void> {
  await realtime.publish(tx, {
    locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'catalog', key: what, tier: key },
  })
}

const tierAudit = (t: Tier) => ({
  name: t.name,
  colour: t.colour,
  bgColour: t.bgColour,
  sort: t.sort,
  active: t.active,
  public: t.public,
  vipBooking: t.vipBooking,
  memberDiscountBp: t.memberDiscountBp,
  maxVehicles: t.maxVehicles,
  perks: t.perks,
  checkoutUrl: t.checkoutUrl,
  inclusions: t.inclusions.map((i) => ({
    id: i.id,
    label: i.label,
    mode: i.mode,
    perCycle: i.perCycle,
    autoApply: i.autoApply,
    active: i.active,
    serviceIds: i.serviceIds,
  })),
})

/** Replaces the tier's inclusions: kept ids are updated, new ones inserted, dropped ones deleted (or turned off when credits name them). */
async function writeInclusions(tx: Tx, d: { newId: NewId }, plan: Plan, next: InclusionInput[]): Promise<void> {
  for (const [i, inc] of next.entries()) {
    if (inc.id !== undefined && !plan.inclusions.some((x) => x.id === inc.id))
      throw invalid(`inclusions.${i}.id`, 'That inclusion belongs to another tier: leave the id out to add it.')
  }
  const keep = new Set(next.flatMap((x) => (x.id ? [x.id] : [])))
  // one turned off goes after the saved list (in its old order), so the order never rests on a tie between ids
  let after = next.length
  for (const old of plan.inclusions) {
    if (keep.has(old.id)) continue
    const used = await tx
      .selectFrom('membership_credit_events')
      .select('id')
      .where((eb) => eb.or([eb('inclusion_id', '=', old.id), eb('rule_id', '=', old.id)]))
      .limit(1)
      .executeTakeFirst()
    if (used)
      await tx
        .updateTable('membership_inclusions')
        .set((eb) => ({ active: false, sort: after++, updated_at: eb.fn('app_now', []) }))
        .where('id', '=', old.id)
        .execute()
    else await tx.deleteFrom('membership_inclusions').where('id', '=', old.id).execute()
  }
  for (const [sort, inc] of next.entries()) {
    const values = {
      label: inc.label,
      mode: inc.mode,
      per_cycle: inc.mode === 'every_visit' ? null : inc.perCycle,
      auto_apply: inc.autoApply,
      sort,
      active: inc.active ?? true,
    }
    let id = inc.id
    if (id) await tx.updateTable('membership_inclusions').set((eb) => ({ ...values, updated_at: eb.fn('app_now', []) })).where('id', '=', id).execute()
    else {
      id = d.newId()
      await tx.insertInto('membership_inclusions').values({ id, plan_id: plan.id, ...values }).execute()
    }
    await tx.deleteFrom('membership_inclusion_services').where('inclusion_id', '=', id).execute()
    await tx
      .insertInto('membership_inclusion_services')
      .values(inc.serviceIds.map((service_id) => ({ inclusion_id: id!, service_id })))
      .execute()
  }
}

export async function createTier(
  tx: Tx,
  d: { newId: NewId },
  input: { locationId: string; key: string; fields: TierFields; audit?: audit.AuditContext },
): Promise<Tier> {
  if (!TIER_KEY.test(input.key))
    throw invalid('key', 'Use a lowercase key: a letter, then letters, digits or underscores (up to 32).')
  const f = await checkFields(tx, input.locationId, input.fields)
  const existing = await tx
    .selectFrom('membership_plans')
    .select(['key', 'legacy_key'])
    .where('location_id', '=', input.locationId)
    .execute()
  if (existing.length >= MAX_TIERS) throw invalid('key', `The shop can have at most ${MAX_TIERS} membership tiers.`)
  // an old key still names its tier (Squarespace products, old links): it cannot become a new tier's key
  if (existing.some((x) => x.key === input.key || x.legacy_key === input.key))
    throw new AppError('TIER_KEY_TAKEN', { meta: { key: input.key } })
  const id = d.newId()
  await tx
    .insertInto('membership_plans')
    .values({
      id,
      location_id: input.locationId,
      key: input.key,
      name: f.name,
      color: f.colour,
      bg_color: f.bgColour ?? lightOf(f.colour),
      tint: f.colour,
      sort: f.sort,
      active: f.active,
      public: f.public,
      vip_booking: f.vipBooking,
      member_discount_bp: f.memberDiscountBp,
      max_vehicles: f.maxVehicles,
      perks: f.perks,
      checkout_url: f.checkoutUrl,
    })
    .execute()
  const plan = (await loadPlans(tx, input.locationId)).find((p) => p.id === id)!
  await writeInclusions(tx, d, plan, f.inclusions)
  const t = await requireTier(tx, input.locationId, input.key)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.tier.create',
    entityType: 'membership_plan',
    entityId: t.key,
    after: tierAudit(t),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, t.key, 'tiers')
  return t
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The whole tier (inclusions included) in one version-checked replace; the key never changes. */
export async function putTier(
  tx: Tx,
  d: { newId: NewId },
  input: { locationId: string; key: string; fields: TierFields; expectedVersion: number; audit?: audit.AuditContext },
): Promise<{ tier: Tier; changed: boolean }> {
  const row = TIER_KEY.test(input.key)
    ? await tx
        .selectFrom('membership_plans')
        .select(['id', 'version'])
        .where('location_id', '=', input.locationId)
        .where('key', '=', input.key)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That membership tier does not exist' })
  if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: row.version } })
  const before = await requireTier(tx, input.locationId, input.key)
  const f = await checkFields(tx, input.locationId, input.fields)
  const bg = f.bgColour ?? (f.colour === before.colour ? before.bgColour : lightOf(f.colour))
  const wanted = tierAudit({
    ...before,
    name: f.name,
    colour: f.colour,
    bgColour: bg,
    sort: f.sort,
    active: f.active,
    public: f.public,
    vipBooking: f.vipBooking,
    memberDiscountBp: f.memberDiscountBp,
    maxVehicles: f.maxVehicles,
    perks: f.perks,
    checkoutUrl: f.checkoutUrl,
    inclusions: f.inclusions.map((x, i) => ({
      id: x.id ?? '',
      planId: '',
      label: x.label,
      mode: x.mode,
      perCycle: x.mode === 'every_visit' ? null : x.perCycle,
      autoApply: x.autoApply,
      sort: i,
      active: x.active ?? true,
      serviceIds: [...x.serviceIds].sort(),
    })),
  })
  if (sameJson(wanted, tierAudit({ ...before, inclusions: before.inclusions.filter((i) => i.active || f.inclusions.some((x) => x.id === i.id)) })))
    return { tier: before, changed: false }
  await tx
    .updateTable('membership_plans')
    .set((eb) => ({
      name: f.name,
      color: f.colour,
      bg_color: bg,
      tint: f.colour,
      sort: f.sort,
      active: f.active,
      public: f.public,
      vip_booking: f.vipBooking,
      member_discount_bp: f.memberDiscountBp,
      max_vehicles: f.maxVehicles,
      perks: f.perks,
      checkout_url: f.checkoutUrl,
      version: eb('version', '+', 1),
      updated_at: eb.fn('app_now', []),
    }))
    .where('id', '=', row.id)
    .execute()
  const plan = (await loadPlans(tx, input.locationId)).find((p) => p.id === row.id)!
  await writeInclusions(tx, d, plan, f.inclusions)
  const after = await requireTier(tx, input.locationId, input.key)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.tier.update',
    entityType: 'membership_plan',
    entityId: after.key,
    before: tierAudit(before),
    after: tierAudit(after),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, after.key, 'tiers')
  return { tier: after, changed: true }
}

/** Deletes a tier that was never sold (no membership, link or checkout names it): 409 TIER_IN_USE otherwise (turn it off instead). */
export async function deleteTier(
  tx: Tx,
  input: { locationId: string; key: string; expectedVersion?: number; audit?: audit.AuditContext },
): Promise<Tier> {
  const row = TIER_KEY.test(input.key)
    ? await tx
        .selectFrom('membership_plans')
        .select(['id', 'version'])
        .where('location_id', '=', input.locationId)
        .where('key', '=', input.key)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That membership tier does not exist' })
  if (input.expectedVersion !== undefined && row.version !== input.expectedVersion)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: row.version } })
  const t = await requireTier(tx, input.locationId, input.key)
  const products = await tx.selectFrom('sqsp_products').select('id').where('plan_id', '=', row.id).limit(1).executeTakeFirst()
  if (t.sold || products) throw new AppError('TIER_IN_USE', { meta: { key: t.key } })
  await tx.deleteFrom('membership_plans').where('id', '=', row.id).execute()
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.tier.delete',
    entityType: 'membership_plan',
    entityId: t.key,
    before: tierAudit(t),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, t.key, 'tiers')
  return t
}

// ---- tier prices -------------------------------------------------------------------------------------------------------------

export interface TierPriceRowInput {
  tierKey: string
  /** The tier's priceVersion the admin edited (412 naming this row when stale). */
  priceVersion: number
  cells: { class: string; monthlyCents: number | null }[]
}

/**
 * Saves the tier × size grid, all or nothing. Per row: each changed size supersedes its current price and, unless cleared, adds a
 * new row at the tier's next price_version with square_state 'pending'; the tier's price_version moves once per changed row. Sizes a
 * row does not list keep their price. Returns the tiers after the save.
 */
export async function putTierPrices(
  tx: Tx,
  d: { newId: NewId; now: Date },
  input: { locationId: string; rows: TierPriceRowInput[]; userId: string | null; audit?: audit.AuditContext },
): Promise<{ tiers: Tier[]; changed: string[] }> {
  if (input.rows.length === 0) throw invalid('rows', 'Send at least one row.')
  const classKeys = new Set(
    (await tx.selectFrom('vehicle_classes').select('key').where('location_id', '=', input.locationId).execute()).map((c) => c.key),
  )
  const keys = new Set<string>()
  input.rows.forEach((r, i) => {
    if (!TIER_KEY.test(r.tierKey)) throw invalid(`rows.${i}.tierKey`, 'Pick one of the membership tiers.')
    if (keys.has(r.tierKey)) throw invalid(`rows.${i}.tierKey`, 'This tier is listed twice.')
    keys.add(r.tierKey)
    const seen = new Set<string>()
    r.cells.forEach((c, j) => {
      const at = `rows.${i}.cells.${j}`
      if (!classKeys.has(c.class)) throw invalid(`${at}.class`, 'Pick one of the shop’s vehicle sizes.')
      if (seen.has(c.class)) throw invalid(`${at}.class`, 'This size is listed twice in the row.')
      seen.add(c.class)
      if (c.monthlyCents !== null && (!Number.isSafeInteger(c.monthlyCents) || c.monthlyCents < 0 || c.monthlyCents > MAX_MONTHLY_CENTS))
        throw invalid(`${at}.monthlyCents`, 'Enter a monthly price in whole cents, from 0 to $100,000.')
    })
  })
  const plans = await tx
    .selectFrom('membership_plans')
    .select(['id', 'key', 'price_version'])
    .where('location_id', '=', input.locationId)
    .where('key', 'in', [...keys])
    .orderBy('id')
    .forUpdate()
    .execute()
  input.rows.forEach((r, i) => {
    const p = plans.find((x) => x.key === r.tierKey)
    if (!p) throw new AppError('NOT_FOUND', { detail: 'That membership tier does not exist', meta: { row: i, tierKey: r.tierKey } })
    if (p.price_version !== r.priceVersion)
      throw new AppError('VERSION_CONFLICT', { meta: { row: i, tierKey: r.tierKey, currentVersion: p.price_version } })
  })
  const changed: string[] = []
  for (const r of input.rows) {
    const p = plans.find((x) => x.key === r.tierKey)!
    const current = await tx
      .selectFrom('membership_tier_prices')
      .select(['id', 'class_key', 'monthly_cents'])
      .where('plan_id', '=', p.id)
      .where('superseded_at', 'is', null)
      .execute()
    const moves = r.cells.filter((c) => {
      const cur = current.find((x) => x.class_key === c.class)
      return c.monthlyCents === null ? cur !== undefined : cur?.monthly_cents !== c.monthlyCents
    })
    if (moves.length === 0) continue
    const nextVersion = p.price_version + 1
    for (const c of moves) {
      const cur = current.find((x) => x.class_key === c.class)
      if (cur) await tx.updateTable('membership_tier_prices').set({ superseded_at: d.now }).where('id', '=', cur.id).execute()
      if (c.monthlyCents !== null)
        await tx
          .insertInto('membership_tier_prices')
          .values({
            id: d.newId(),
            location_id: input.locationId,
            plan_id: p.id,
            class_key: c.class,
            monthly_cents: c.monthlyCents,
            effective_from: d.now,
            price_version: nextVersion,
            square_state: 'pending',
            created_by: input.userId,
          })
          .execute()
    }
    await tx
      .updateTable('membership_plans')
      .set((eb) => ({ price_version: nextVersion, updated_at: eb.fn('app_now', []) }))
      .where('id', '=', p.id)
      .execute()
    const cells = (rows: { class_key: string; monthly_cents: number }[]) =>
      Object.fromEntries(rows.map((x) => [x.class_key, x.monthly_cents]))
    const after = await tx
      .selectFrom('membership_tier_prices')
      .select(['class_key', 'monthly_cents'])
      .where('plan_id', '=', p.id)
      .where('superseded_at', 'is', null)
      .execute()
    await audit.record(tx, {
      locationId: input.locationId,
      action: 'catalog.tier_price.update',
      entityType: 'membership_plan',
      entityId: p.key,
      before: { priceVersion: p.price_version, prices: cells(current) },
      after: { priceVersion: nextVersion, prices: cells(after) },
      ctx: input.audit,
    })
    changed.push(p.key)
  }
  if (changed.length > 0)
    await realtime.publish(tx, {
      locationId: input.locationId,
      channel: 'settings',
      type: 'settings.changed',
      payload: { section: 'catalog', key: 'tier_prices', tiers: changed },
    })
  return { tiers: await listTiers(tx, input.locationId), changed }
}
