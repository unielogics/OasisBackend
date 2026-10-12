// The catalog diff planner of the Square memberships (ADR 0171 wave Q3b, design 5.2), pure: what Square's catalog must gain so every
// tier price can be billed. The append-only membership_tier_prices IS the variation history (plan amendment 1):
//   - one SUBSCRIPTION_PLAN per tier (membership_plans.square_plan_id), created when a tier first needs a variation, renamed when the
//     tier's name changes (an upsert with the object's version);
//   - one SUBSCRIPTION_PLAN_VARIATION (STATIC price, MONTHLY) per current price row; a price edit writes a new row, so a new
//     variation, and members keep the one they joined at (grandfathered, plan decision 8);
//   - a variation is never changed in place and never deleted while a membership or an enrollment uses it (Square refuses to delete
//     one a subscription used, even a canceled one: sandbox 2026-10-12); a superseded price nobody ever used is retired (deleted);
//   - with the remote catalog (the nightly drift check): a variation gone or priced differently at Square, or a plan renamed there,
//     is reported (drift) rather than silently trusted.
// The executor (catalog-sync.ts) sends these with keys derived from our own row ids, so a run that stopped after Square answered but
// before the row was written sends the same key again and gets the same object back.

export interface CatalogTier {
  planId: string
  key: string
  name: string
  active: boolean
  squarePlanId: string | null
}

export interface CatalogPriceRow {
  id: string
  planId: string
  classKey: string
  classLabel: string
  monthlyCents: number
  /** The current price of its tier and size (superseded_at is null). */
  current: boolean
  squareVariationId: string | null
  squareState: 'pending' | 'synced' | 'failed' | 'retired'
  /** A membership or an enrollment names this price row (its variation must stay). */
  inUse: boolean
  /** Why the last sync of the row failed; a superseded row Square refused to delete keeps the reason and is not tried again. */
  squareError: string | null
}

export interface RemotePlan {
  id: string
  name: string | null
  version: number | null
  deleted: boolean
}

export interface RemoteVariation {
  id: string
  planId: string | null
  /** The STATIC price of its first phase, in cents (null: not a single static monthly price). */
  cents: number | null
  cadence: string | null
  deleted: boolean
}

/** What Square has (the nightly drift check reads it); absent for the ordinary sync, which trusts its own records. */
export interface RemoteCatalog {
  plans: ReadonlyMap<string, RemotePlan>
  variations: ReadonlyMap<string, RemoteVariation>
}

export type CatalogAction =
  /** A SUBSCRIPTION_PLAN for a tier that has none yet. */
  | { kind: 'create_plan'; planId: string; name: string }
  /** The tier's name changed (or was changed at Square): the plan is upserted with its version. */
  | { kind: 'rename_plan'; planId: string; squarePlanId: string; name: string; version: number }
  /** A variation for a price row; squarePlanId null = the plan create_plan makes in the same run. */
  | { kind: 'create_variation'; rowId: string; planId: string; squarePlanId: string | null; name: string; cents: number }
  /** A superseded price no membership or enrollment ever used: deleted at Square, the row retired. */
  | { kind: 'retire_variation'; rowId: string; squareVariationId: string }
  /** Square's copy does not match ours: the row is marked failed with the reason (staff are told; nothing is overwritten). */
  | { kind: 'drift'; rowId: string; detail: string }
  /** The variation is gone at Square and nobody used it: the row goes back to pending, so a fresh variation is made. */
  | { kind: 'recreate'; rowId: string; detail: string }

/** "Gold · Compact car": the variation's name as Square shows it (receipts, the Square Dashboard). */
export const variationName = (tierName: string, classLabel: string): string => `${tierName} · ${classLabel}`.slice(0, 255)

export function planCatalogChanges(
  tiers: readonly CatalogTier[],
  rows: readonly CatalogPriceRow[],
  remote?: RemoteCatalog,
): CatalogAction[] {
  const out: CatalogAction[] = []
  for (const t of tiers) {
    const mine = rows.filter((r) => r.planId === t.planId)
    // a price that still needs its variation: a current price of an active tier, not made yet (pending or failed without an id)
    const needed = t.active ? mine.filter((r) => r.current && !r.squareVariationId && r.squareState !== 'retired') : []
    const remotePlan = t.squarePlanId ? remote?.plans.get(t.squarePlanId) : undefined
    if (needed.length > 0 && !t.squarePlanId) out.push({ kind: 'create_plan', planId: t.planId, name: t.name })
    else if (t.squarePlanId && remotePlan && !remotePlan.deleted && remotePlan.name !== t.name)
      out.push({ kind: 'rename_plan', planId: t.planId, squarePlanId: t.squarePlanId, name: t.name, version: remotePlan.version ?? 0 })
    for (const r of needed)
      out.push({
        kind: 'create_variation',
        rowId: r.id,
        planId: t.planId,
        squarePlanId: t.squarePlanId,
        name: variationName(t.name, r.classLabel),
        cents: r.monthlyCents,
      })
    for (const r of mine) {
      if (!r.squareVariationId) continue
      if (!r.current && r.squareState === 'synced' && !r.inUse && !r.squareError)
        out.push({ kind: 'retire_variation', rowId: r.id, squareVariationId: r.squareVariationId })
      if (!remote || r.squareState === 'retired') continue
      const v = remote.variations.get(r.squareVariationId)
      if (!v || v.deleted) {
        if (r.inUse) out.push({ kind: 'drift', rowId: r.id, detail: 'Square no longer has this price, but members are billed at it' })
        else if (r.current) out.push({ kind: 'recreate', rowId: r.id, detail: 'Square no longer has this price: it is made again' })
        continue
      }
      if (v.cents !== r.monthlyCents || (v.cadence !== null && v.cadence !== 'MONTHLY'))
        out.push({
          kind: 'drift',
          rowId: r.id,
          detail: `Square bills this price at ${v.cents === null ? 'another price' : centsText(v.cents)}${v.cadence && v.cadence !== 'MONTHLY' ? ` ${v.cadence.toLowerCase()}` : ''}, not ${centsText(r.monthlyCents)} a month`,
        })
    }
  }
  return out
}

const centsText = (c: number): string => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`

/** The remote shape of a catalog object, from Square's wire object (unknown fields ignored). */
export function remoteOf(objects: ReadonlyArray<{
  type: string
  id: string
  version?: number | null
  is_deleted?: boolean | null
  subscription_plan_data?: { name?: string | null } | null
  subscription_plan_variation_data?: {
    subscription_plan_id?: string | null
    phases?: ReadonlyArray<{ cadence: string; pricing?: { type?: string | null; price_money?: { amount: number } | null } | null }> | null
  } | null
}>): RemoteCatalog {
  const plans = new Map<string, RemotePlan>()
  const variations = new Map<string, RemoteVariation>()
  for (const o of objects) {
    if (o.type === 'SUBSCRIPTION_PLAN')
      plans.set(o.id, { id: o.id, name: o.subscription_plan_data?.name ?? null, version: o.version ?? null, deleted: o.is_deleted === true })
    else if (o.type === 'SUBSCRIPTION_PLAN_VARIATION') {
      const phases = o.subscription_plan_variation_data?.phases ?? []
      const p = phases.length === 1 ? phases[0] : undefined
      const pricing = p?.pricing
      variations.set(o.id, {
        id: o.id,
        planId: o.subscription_plan_variation_data?.subscription_plan_id ?? null,
        cents: pricing?.type === 'STATIC' && pricing.price_money ? pricing.price_money.amount : null,
        cadence: p?.cadence ?? null,
        deleted: o.is_deleted === true,
      })
    }
  }
  return { plans, variations }
}
