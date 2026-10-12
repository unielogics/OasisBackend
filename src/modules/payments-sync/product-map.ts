import { z } from 'zod'

/**
 * Squarespace product/SKU to Oasis meaning. The Orders API carries no subscription flag and no tier, so the mapping is
 * the only source of truth for "this order is a Gold membership payment" and for "this order is one of ours at all".
 *
 * ADR 0170: tiers are editable and keyed by a slug. A product names its tier by key; the old fixed keys (premium, executive) stay
 * valid and resolve through the tier's legacy_key (buildProductMap passes the aliases, so a resolved tier is always the current key).
 */
export type Tier = string

/** A tier key: a lowercase slug. */
export const TIER_KEY = /^[a-z][a-z0-9_]{0,31}$/

/** The tier names a product label is read for, in this order: the design's four (old keys included) and the website's two. */
export const TIER_WORDS = ['essential', 'premium', 'executive', 'exotic', 'gold', 'vip'] as const

/** "Premium Care" normalises to premium; matching is by whole word so "Essentials Plus" is essential too. */
export function normalizeTier(label: string | null | undefined): Tier | undefined {
  if (!label) return undefined
  const words = label.toLowerCase().match(/[a-z]+/g) ?? []
  for (const tier of TIER_WORDS) {
    if (words.some((w) => w === tier || w === `${tier}s`)) return tier
  }
  return undefined
}

const entrySchema = z
  .object({
    productId: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    kind: z.enum(['membership', 'service']),
    /** Membership display label as sold, e.g. "Premium Care"; the tier is derived from it. */
    tierLabel: z.string().min(1).optional(),
    tier: z.string().regex(TIER_KEY).optional(),
    intervalMonths: z.number().int().min(1).max(12).default(1),
    label: z.string().optional(),
  })
  .refine((e) => e.productId || e.sku, 'an entry needs a productId or a sku')
  .refine(
    (e) => e.kind !== 'membership' || e.tier || normalizeTier(e.tierLabel),
    'a membership entry needs a tier or a tierLabel that names one',
  )

export type ProductMapEntry = z.input<typeof entrySchema>
type ParsedEntry = z.output<typeof entrySchema>

export interface ResolvedProduct {
  kind: 'membership' | 'service'
  tier?: Tier
  planLabel?: string
  intervalMonths: number
  label?: string
  matchedBy: 'productId' | 'sku'
}

export class ProductMap {
  private readonly byProduct = new Map<string, ParsedEntry>()
  private readonly bySku = new Map<string, ParsedEntry>()

  /** `aliases`: old tier key -> current key (a tier's legacy_key), applied to every resolved tier. */
  constructor(
    entries: readonly ProductMapEntry[] = [],
    private readonly aliases: ReadonlyMap<string, string> = new Map(),
  ) {
    for (const raw of entries) {
      const e = entrySchema.parse(raw)
      if (e.productId) this.byProduct.set(e.productId, e)
      if (e.sku) this.bySku.set(e.sku.trim().toLowerCase(), e)
    }
  }

  /** Parse the SQSP_PRODUCT_MAP JSON array. */
  static fromJson(json: string | undefined): ProductMap {
    if (!json?.trim()) return new ProductMap()
    return new ProductMap(z.array(z.unknown()).parse(JSON.parse(json)) as ProductMapEntry[])
  }

  get size(): number {
    return new Set([...this.byProduct.values(), ...this.bySku.values()]).size
  }

  resolve(li: { productId?: string; sku?: string }): ResolvedProduct | undefined {
    const byId = li.productId ? this.byProduct.get(li.productId) : undefined
    const bySku = li.sku ? this.bySku.get(li.sku.trim().toLowerCase()) : undefined
    const e = byId ?? bySku
    if (!e) return undefined
    const tier = e.kind === 'membership' ? (e.tier ?? normalizeTier(e.tierLabel)) : undefined
    return {
      kind: e.kind,
      tier: tier === undefined ? undefined : (this.aliases.get(tier) ?? tier),
      planLabel: e.kind === 'membership' ? (e.tierLabel ?? e.label) : undefined,
      intervalMonths: e.intervalMonths,
      label: e.label,
      matchedBy: byId ? 'productId' : 'sku',
    }
  }
}
