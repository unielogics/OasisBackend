// The product map in Postgres (sqsp_products): Squarespace product / SKU to "membership of plan X" or "one of our services".
// The effective map is the SQSP_PRODUCT_MAP environment JSON (a bootstrap) overlaid by the table rows (the admin's edits).
import { sql } from 'kysely'
import type { Clock } from '../../../platform/clock.js'
import type { Executor, Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { normalizeTier, ProductMap, type ProductMapEntry, type Tier } from '../product-map.js'

export interface ProductRow {
  id: string
  productId: string | null
  sku: string | null
  name: string | null
  kind: 'membership' | 'service'
  plan: Tier | null
  planLabel: string | null
  intervalMonths: number
  serviceId: string | null
  active: boolean
}

export interface ProductInput {
  productId?: string | null
  sku?: string | null
  name?: string | null
  kind: 'membership' | 'service'
  /** Required for a membership (or a planLabel that names one, e.g. "Premium Care"). */
  plan?: Tier | null
  planLabel?: string | null
  intervalMonths?: number | null
  serviceId?: string | null
  active?: boolean
}

export async function listProductRows(db: Executor, locationId: string): Promise<ProductRow[]> {
  const rows = await db
    .selectFrom('sqsp_products as p')
    .leftJoin('membership_plans as m', 'm.id', 'p.plan_id')
    .select([
      'p.id',
      'p.sqsp_product_id',
      'p.sku',
      'p.name',
      'p.kind',
      'm.key as plan_key',
      'p.plan_label',
      'p.interval_months',
      'p.service_id',
      'p.active',
    ])
    .where('p.location_id', '=', locationId)
    .orderBy('p.created_at')
    .orderBy('p.id')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    productId: r.sqsp_product_id,
    sku: r.sku,
    name: r.name,
    kind: r.kind,
    plan: r.plan_key,
    planLabel: r.plan_label,
    intervalMonths: r.interval_months,
    serviceId: r.service_id,
    active: r.active,
  }))
}

export function entriesOf(rows: readonly ProductRow[], planNames: ReadonlyMap<Tier, string>): ProductMapEntry[] {
  return rows
    .filter((r) => r.active)
    .map((r) => ({
      ...(r.productId ? { productId: r.productId } : {}),
      ...(r.sku ? { sku: r.sku } : {}),
      kind: r.kind,
      ...(r.kind === 'membership' && r.plan
        ? { tier: r.plan, tierLabel: r.planLabel ?? planNames.get(r.plan) ?? r.plan }
        : {}),
      intervalMonths: r.intervalMonths,
      ...(r.name ? { label: r.name } : {}),
    }))
}

/** Environment JSON first, then the table rows (later entries win for the same product id or SKU). */
export async function buildProductMap(
  db: Executor,
  locationId: string,
  envJson: string | undefined,
): Promise<ProductMap> {
  const rows = await listProductRows(db, locationId)
  const plans = await db
    .selectFrom('membership_plans')
    .select(['key', 'name'])
    .where('location_id', '=', locationId)
    .execute()
  const names = new Map(plans.map((p) => [p.key, p.name]))
  const envEntries = (() => {
    try {
      const e = envJson?.trim() ? (JSON.parse(envJson) as ProductMapEntry[]) : []
      new ProductMap(e) // an invalid bootstrap map is ignored rather than stopping every sync
      return e
    } catch {
      return []
    }
  })()
  return new ProductMap([...envEntries, ...entriesOf(rows, names)])
}

export interface ValidationIssue {
  index: number
  path: string
  message: string
}

/** Validates a replacement set before it is written; the caller turns issues into a 422. */
export async function validateProductInputs(
  db: Executor,
  locationId: string,
  inputs: readonly ProductInput[],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const ids = new Set<string>()
  const skus = new Set<string>()
  const plans = new Set(
    (await db.selectFrom('membership_plans').select('key').where('location_id', '=', locationId).execute()).map(
      (p) => p.key as string,
    ),
  )
  inputs.forEach((p, index) => {
    const bad = (path: string, message: string) => issues.push({ index, path, message })
    if (!p.productId && !p.sku) bad('productId', 'Give a Squarespace product id or a SKU')
    if (p.productId) {
      if (ids.has(p.productId)) bad('productId', 'This product id is listed twice')
      ids.add(p.productId)
    }
    if (p.sku) {
      const k = p.sku.trim().toLowerCase()
      if (skus.has(k)) bad('sku', 'This SKU is listed twice')
      skus.add(k)
    }
    if (p.kind === 'membership') {
      const plan = p.plan ?? normalizeTier(p.planLabel)
      if (!plan) bad('plan', 'A membership product needs a plan: Essential, Premium, Executive or Exotic')
      else if (!plans.has(plan)) bad('plan', `The ${plan} plan is not set up`)
    }
  })
  return issues
}

/** Replaces the mapping with exactly these rows (matched by product id, then SKU) and returns the stored rows. */
export async function replaceProductRows(
  tx: Tx,
  d: { locationId: string; clock: Clock; newId: NewId },
  inputs: readonly ProductInput[],
): Promise<ProductRow[]> {
  const now = d.clock.now()
  const plans = new Map(
    (
      await tx.selectFrom('membership_plans').select(['id', 'key', 'billing_interval_months']).where('location_id', '=', d.locationId).execute()
    ).map((p) => [p.key as string, p]),
  )
  const existing = await tx.selectFrom('sqsp_products').selectAll().where('location_id', '=', d.locationId).execute()
  const keep = new Set<string>()
  for (const p of inputs) {
    const hit = existing.find(
      (e) =>
        (p.productId && e.sqsp_product_id === p.productId) ||
        (p.sku && e.sku && e.sku.toLowerCase() === p.sku.trim().toLowerCase()),
    )
    const plan = p.kind === 'membership' ? plans.get((p.plan ?? normalizeTier(p.planLabel))!) : undefined
    const v = {
      sqsp_product_id: p.productId ?? null,
      sku: p.sku?.trim() ?? null,
      name: p.name ?? null,
      kind: p.kind,
      plan_id: plan?.id ?? null,
      plan_label: p.kind === 'membership' ? (p.planLabel ?? null) : null,
      interval_months: p.intervalMonths ?? plan?.billing_interval_months ?? 1,
      service_id: p.kind === 'service' ? (p.serviceId ?? null) : null,
      active: p.active ?? true,
      updated_at: now,
    }
    if (hit) {
      keep.add(hit.id)
      await tx.updateTable('sqsp_products').set(v).where('id', '=', hit.id).execute()
    } else {
      const id = d.newId()
      keep.add(id)
      await tx
        .insertInto('sqsp_products')
        .values({ id, location_id: d.locationId, created_at: now, ...v })
        .execute()
    }
  }
  const drop = existing.filter((e) => !keep.has(e.id)).map((e) => e.id)
  if (drop.length > 0) await tx.deleteFrom('sqsp_products').where('id', 'in', drop).execute()
  return listProductRows(tx, d.locationId)
}

export interface SeenProduct {
  productId: string | null
  sku: string | null
  name: string
  orders: number
  lastSeen: string
  mapped: boolean
}

/** Products on recent orders, so the admin can see what still needs mapping. */
export async function seenProducts(
  db: Executor,
  locationId: string,
  since: Date,
  map: ProductMap,
): Promise<SeenProduct[]> {
  const r = await sql<{
    product_id: string | null
    sku: string | null
    name: string | null
    orders: number
    last_seen: Date
  }>`
    select li->>'productId' as product_id, li->>'sku' as sku, max(li->>'name') as name,
           count(distinct o.sqsp_order_id)::int as orders, max(o.created_on) as last_seen
    from sqsp_orders o cross join lateral jsonb_array_elements(o.line_items) li
    where o.location_id = ${locationId} and o.created_on >= ${since} and not o.test_mode
    group by 1, 2
    order by max(o.created_on) desc, 1, 2`.execute(db)
  return r.rows.map((x) => ({
    productId: x.product_id,
    sku: x.sku,
    name: x.name ?? '',
    orders: x.orders,
    lastSeen: x.last_seen.toISOString(),
    mapped: map.resolve({ productId: x.product_id ?? undefined, sku: x.sku ?? undefined }) !== undefined,
  }))
}
