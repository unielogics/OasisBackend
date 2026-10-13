// The tax check of the Square item library (ADR 0172 section 5, ADR 0173 T8): which Square tax Oasis items carry, compared with
// Oasis's own rate (tax.rate_dbp) as EXACT decimals ("6.625" = 6625 thousandths of a percent). Read-only: it runs in Test connection
// (check `tax`), in the watch-only preview and before every sync, and a mismatch BLOCKS the sync (nothing is written).
//   auto    Oasis's own tax when it made one (it keeps its percentage equal to Oasis's rate); else the shop's one tax that is enabled at
//           the location, ADDITIVE, in the subtotal phase and at exactly Oasis's rate (adopted: referenced, never changed); else, when
//           the location has no enabled tax at all, Oasis creates "Sales tax"; anything else (taxes that do not match, or several that
//           do) is `blocked`.
//   adopt   the tax staff picked (PUT /integrations/square/items/tax): it must be enabled here, ADDITIVE, subtotal phase and match.
//   create  Oasis's own tax, whatever the shop has.
// Warnings (never blocking): an adopted tax that Square also adds to custom amounts (an Oasis total rung up as a custom amount would
// be taxed twice), and Oasis rounding new invoices half-up while Square rounds half to even (a few totals a cent apart).
// roundingCheck asks Square (CalculateOrder, read-only) to price a sample of Oasis's prices and counts the totals a cent apart.
import type { SquareApi } from '../../../integrations/ports/square.js'
import { SquareApiError, SquareAuthError } from '../../../integrations/square/errors.js'
import { usd } from '../../../integrations/square/money.js'
import type { WireCatalogObject } from '../../../integrations/square/wire.js'
import { maskText } from '../../../platform/logging.js'
import { parseTaxPercent, salesTaxCents, SQUARE_TAX_ROUNDING, taxPercentLabel, type TaxRounding } from '../../../platform/money.js'
import type { ItemsTaxMode } from './schema.js'

export const OASIS_TAX_NAME = 'Sales tax'

export type TaxStatus = 'ok' | 'create' | 'blocked' | 'error'

export interface TaxCandidate {
  id: string
  name: string
  percentage: string | null
  /** Enabled at the location, ADDITIVE, subtotal phase, at exactly Oasis's rate. */
  matches: boolean
  /** Why it cannot be used (null when it can). */
  problem: string | null
}

export interface TaxCheck {
  status: TaxStatus
  mode: ItemsTaxMode
  /** The Square tax Oasis items carry (status ok). */
  taxId: string | null
  taxName: string | null
  /** Square's percentage of that tax, as Square wrote it. */
  percentage: string | null
  /** Oasis's rate as a Square percentage ("6.625"). */
  wantPercentage: string
  /** Oasis made this tax: the sync keeps its percentage equal to Oasis's rate. */
  own: boolean
  /** In plain words. */
  detail: string
  warnings: string[]
  /** The enabled taxes present at the location (Oasis's own excluded). */
  candidates: TaxCandidate[]
  rounding?: { checked: number; differ: number; detail: string }
}

/** Oasis's rate as Square writes a percentage: 6625 -> "6.625", 7000 -> "7". */
export const squarePercent = (dbp: number): string => taxPercentLabel(dbp).slice(0, -1)

/** Square's percentage string as thousandths of a percent, exactly; null when it has more precision than that (never equal). */
export function squarePercentDbp(p: string | null | undefined): number | null {
  if (typeof p !== 'string') return null
  const m = /^(\d{1,3})(?:\.(\d+))?$/.exec(p.trim())
  if (!m) return null
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > 3) return null
  return parseTaxPercent(frac ? `${m[1]}.${frac}` : m[1]!)
}

const presentAt = (o: WireCatalogObject, loc: string): boolean =>
  o.present_at_all_locations !== false ? !(o.absent_at_location_ids ?? []).includes(loc) : (o.present_at_location_ids ?? []).includes(loc)

function problemOf(t: WireCatalogObject, loc: string, rateDbp: number): string | null {
  const d = t.tax_data ?? {}
  if (d.enabled === false) return 'turned off'
  if (!presentAt(t, loc)) return 'not used at the shop'
  if ((d.inclusion_type ?? 'ADDITIVE') !== 'ADDITIVE') return 'included in the price, not added to it'
  if ((d.calculation_phase ?? 'TAX_SUBTOTAL_PHASE') !== 'TAX_SUBTOTAL_PHASE') return 'computed on the total, not the subtotal'
  if (squarePercentDbp(d.percentage) !== rateDbp) return `${d.percentage ?? '?'}%, not ${taxPercentLabel(rateDbp)}`
  return null
}

const why = (e: unknown): string =>
  e instanceof SquareAuthError
    ? 'Square refused the access token'
    : e instanceof SquareApiError && !e.retryable
      ? maskText(`Square refused the tax check: ${e.errors.map((x) => x.detail ?? x.code ?? '').filter(Boolean).join('; ') || e.status}`).slice(0, 200)
      : 'Square did not answer the tax check'

/** Every TAX object of the account (paged; read-only). */
export async function listTaxes(api: SquareApi): Promise<WireCatalogObject[]> {
  const all: WireCatalogObject[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const page = await api.catalog.search({ object_types: ['TAX'], cursor, include_deleted_objects: false })
    all.push(...page.items)
    cursor = page.cursor
    if (!cursor) break
  }
  return all.filter((t) => t.type === 'TAX' && !t.is_deleted)
}

export interface TaxCheckInput {
  locationId: string
  rateDbp: number
  rounding: TaxRounding
  mode: ItemsTaxMode
  /** mode adopt: the tax staff picked. */
  chosenTaxId: string | null
  /** The tax Oasis made earlier (its link, not adopted), if any. */
  ownTaxId: string | null
}

/** Decides the tax from Square's TAX objects (pure; checkItemsTax reads them). */
export function decideTax(taxes: readonly WireCatalogObject[], i: TaxCheckInput): TaxCheck {
  const want = squarePercent(i.rateDbp)
  const label = taxPercentLabel(i.rateDbp)
  const own = i.ownTaxId ? taxes.find((t) => t.id === i.ownTaxId) : undefined
  const shop = taxes.filter((t) => t.id !== own?.id && t.tax_data?.enabled !== false && presentAt(t, i.locationId))
  const candidates: TaxCandidate[] = shop.map((t) => {
    const problem = problemOf(t, i.locationId, i.rateDbp)
    return { id: t.id, name: t.tax_data?.name ?? 'Tax', percentage: t.tax_data?.percentage ?? null, matches: problem === null, problem }
  })
  const warnings: string[] = []
  if (i.rounding !== SQUARE_TAX_ROUNDING)
    warnings.push('Oasis rounds new invoices’ tax half up and Square rounds half to even, so a few totals can be a cent apart until the rollout switches Oasis to Square’s rounding')
  const base = { mode: i.mode, wantPercentage: want, candidates, warnings }
  const ok = (t: WireCatalogObject, isOwn: boolean, detail: string): TaxCheck => {
    if (!isOwn && t.tax_data?.applies_to_custom_amounts === true)
      warnings.push(`Square also adds “${t.tax_data?.name ?? 'this tax'}” to custom amounts: an Oasis total rung up as a custom amount would be taxed twice (ring up Oasis items, or turn that off in Square)`)
    return { ...base, status: 'ok', taxId: t.id, taxName: t.tax_data?.name ?? null, percentage: t.tax_data?.percentage ?? null, own: isOwn, detail }
  }
  const none = (status: TaxStatus, detail: string): TaxCheck => ({ ...base, status, taxId: null, taxName: null, percentage: null, own: false, detail })
  const ownOk = (t: WireCatalogObject): TaxCheck => {
    const same = squarePercentDbp(t.tax_data?.percentage) === i.rateDbp
    return ok(
      t,
      true,
      same
        ? `Oasis’s Square tax “${t.tax_data?.name ?? OASIS_TAX_NAME}” is ${label}, the same as Oasis`
        : `Oasis’s Square tax “${t.tax_data?.name ?? OASIS_TAX_NAME}” is ${t.tax_data?.percentage ?? '?'}%: the next sync sets it to ${label}`,
    )
  }
  const list = (xs: readonly TaxCandidate[]): string => xs.map((c) => `${c.name} ${c.percentage ?? '?'}%`).join(', ')
  if (i.mode === 'create') return own ? ownOk(own) : none('create', `Oasis will add its own Square tax “${OASIS_TAX_NAME}” at ${label}`)
  if (i.mode === 'adopt') {
    const t = taxes.find((x) => x.id === i.chosenTaxId)
    if (!t) return none('blocked', 'The Square tax picked for Oasis items no longer exists: pick another one')
    const problem = problemOf(t, i.locationId, i.rateDbp)
    if (problem) return none('blocked', `The Square tax picked, “${t.tax_data?.name ?? 'Tax'}”, is ${problem}: the item sync is paused until it matches`)
    return ok(t, false, `Square tax “${t.tax_data?.name ?? 'Tax'}” is ${label}, the same as Oasis`)
  }
  if (own) return ownOk(own)
  const matching = candidates.filter((c) => c.matches)
  if (matching.length === 1) {
    const t = shop.find((x) => x.id === matching[0]!.id)!
    return ok(t, false, `Square tax “${t.tax_data?.name ?? 'Tax'}” is ${label}, the same as Oasis`)
  }
  if (matching.length > 1) return none('blocked', `Several Square taxes are ${label} (${list(matching)}): pick the one Oasis items use`)
  if (candidates.length === 0) return none('create', `No sales tax in Square yet: the item sync will add “${OASIS_TAX_NAME}” at ${label}`)
  return none('blocked', `Square’s taxes at the shop (${list(candidates)}) don’t match Oasis’s ${label}: the item sync is paused until they match`)
}

/** Reads Square's taxes and decides (read-only; allowed watch-only). A Square that does not answer is status `error`. */
export async function checkItemsTax(api: SquareApi, i: TaxCheckInput): Promise<TaxCheck> {
  try {
    return decideTax(await listTaxes(api), i)
  } catch (e) {
    return {
      status: 'error',
      mode: i.mode,
      taxId: null,
      taxName: null,
      percentage: null,
      wantPercentage: squarePercent(i.rateDbp),
      own: false,
      detail: why(e),
      warnings: [],
      candidates: [],
    }
  }
}

/**
 * Asks Square to price a sample of Oasis prices under the tax (CalculateOrder, read-only: ad-hoc lines and an order-level tax of the
 * same percentage, which the sandbox priced exactly like the catalog tax) and counts the totals that differ from Oasis's tax of the
 * same subtotal. At most 12 single prices and one basket of the first two.
 */
export async function roundingCheck(
  api: SquareApi,
  o: { locationId: string; percentage: string; rateDbp: number; rounding: TaxRounding; prices: readonly number[] },
): Promise<{ checked: number; differ: number; detail: string }> {
  const prices = [...new Set(o.prices.filter((c) => c > 0))].sort((a, b) => a - b).slice(0, 12)
  const samples: number[][] = prices.map((c) => [c])
  if (prices.length >= 2) samples.push([prices[0]!, prices[1]!])
  let differ = 0
  const examples: string[] = []
  for (const lines of samples) {
    const sub = lines.reduce((s, c) => s + c, 0)
    const r = await api.orders.calculate({
      location_id: o.locationId,
      line_items: lines.map((c, i) => ({ uid: `l${i}`, name: 'Oasis tax check', quantity: '1', base_price_money: usd(c) })),
      taxes: [{ uid: 'tax', name: 'Oasis tax check', percentage: o.percentage, type: 'ADDITIVE', scope: 'ORDER' }],
    })
    const square = r.total_tax_money?.amount ?? 0
    const oasis = salesTaxCents(sub, { dbp: o.rateDbp, rounding: o.rounding })
    if (square !== oasis) {
      differ++
      if (examples.length < 3) examples.push(`$${(sub / 100).toFixed(2)}: Square ${square}¢, Oasis ${oasis}¢`)
    }
  }
  const detail = samples.length === 0 ? 'no prices to check yet' : differ === 0 ? `all ${samples.length} sample totals match Square to the cent` : `${differ} of ${samples.length} sample totals differ by a cent (${examples.join('; ')})`
  return { checked: samples.length, differ, detail }
}
