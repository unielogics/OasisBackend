// SQR-18 of pnpm verify:square (ADR 0173): how Square rounds sales tax. CalculateOrder (read-only: nothing is created by the
// ad-hoc cases) prices many orders under a 6.625% and a 7% ADDITIVE tax: single whole-dollar lines (every $4 + $8k up to $196 and
// $500, whose 6.625% tax ends in exactly half a cent), lines with cents (the half-cent cases of 7%), multi-line baskets, quantity 2
// and 3 lines, the tax at ORDER and at LINE_ITEM scope, and the same through catalog items with a catalog TAX object and
// auto_apply_taxes (the counter's POS path; those objects are created with a verify- name and deleted by the cleanup). Each answer is
// compared with every candidate rounding rule (half-up / half-even, per order / per line / per unit) and with Oasis's own
// salesTaxCents (src/platform/money.ts); the result table goes to docs/integrations/square.md section 15 and ADR 0173.
import { z } from 'zod'
import type { SquareClient } from '../../src/integrations/square/client.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { centsOf, usd } from '../../src/integrations/square/money.js'
import { NEW_INVOICE_TAX_ROUNDING, salesTaxCents } from '../../src/platform/money.js'
import type { Report } from './lib.js'

/** A rate in 1/1000 basis points: 6625 = 6.625%, 7000 = 7%. */
export type RateDbp = number

export interface TaxLine {
  unitCents: number
  qty: number
}

export interface TaxCase {
  label: string
  rateDbp: RateDbp
  lines: TaxLine[]
  /** ORDER: one order-level tax; LINE_ITEM: the tax applied on each line; CATALOG: catalog variations + catalog TAX, auto-applied. */
  scope: 'ORDER' | 'LINE_ITEM' | 'CATALOG'
  /** An order-level discount (Oasis's adjustment): a fixed amount, or a percentage whose amount is exact in cents. */
  discount?: { cents: number } | { percent: string; cents: number }
}

export interface TaxObservation extends TaxCase {
  squareTax: number
  squareLineTaxes: number[]
}

export type RuleName = 'order_half_up' | 'order_half_even' | 'line_half_up' | 'line_half_even' | 'unit_half_up' | 'unit_half_even'
export const RULES: readonly RuleName[] = ['order_half_up', 'order_half_even', 'line_half_up', 'line_half_even', 'unit_half_up', 'unit_half_even']

const DEN = 100_000

/** n / DEN rounded half-up (n >= 0). */
export const hu = (n: number): number => Math.floor((2 * n + DEN) / (2 * DEN))
/** n / DEN rounded half to even (n >= 0). */
export function he(n: number): number {
  const q = Math.floor(n / DEN)
  const r = n - q * DEN
  if (2 * r < DEN) return q
  if (2 * r > DEN) return q + 1
  return q % 2 === 0 ? q : q + 1
}

export function ruleTax(rule: RuleName, rateDbp: RateDbp, lines: readonly TaxLine[], discountCents = 0): number {
  const round = rule.endsWith('half_up') ? hu : he
  if (rule.startsWith('order')) return round((lines.reduce((s, l) => s + l.unitCents * l.qty, 0) - discountCents) * rateDbp)
  // a discount spread over lines has no single per-line rule: only the order rules are compared then
  if (discountCents) return Number.NaN
  if (rule.startsWith('line')) return lines.reduce((s, l) => s + round(l.unitCents * l.qty * rateDbp), 0)
  return lines.reduce((s, l) => s + l.qty * round(l.unitCents * rateDbp), 0)
}

/** The rules every observation agrees with. */
export function matchingRules(obs: readonly TaxObservation[]): RuleName[] {
  return RULES.filter((r) => obs.every((o) => ruleTax(r, o.rateDbp, o.lines, o.discount?.cents) === o.squareTax))
}

const pct = (dbp: RateDbp): string => (dbp / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')

/** Every case SQR-18 sends. */
export function taxCases(): TaxCase[] {
  const out: TaxCase[] = []
  const single = (cents: number, rateDbp: RateDbp, scope: TaxCase['scope'] = 'ORDER') =>
    out.push({ label: `$${(cents / 100).toFixed(2)}`, rateDbp, lines: [{ unitCents: cents, qty: 1 }], scope })
  // 6.625% tax is exactly half a cent on every subtotal of 400 + 800k cents ($4, $12, $20, ...)
  const halves = Array.from({ length: 25 }, (_, k) => 400 + 800 * k).concat([50_000])
  const others = [100, 200, 300, 500, 1000, 1500, 2500, 4000, 4500, 5000, 5500, 6000, 12_900, 25_000, 1234, 1999, 3333, 150, 250, 1250, 3750]
  for (const c of [...halves, ...others]) {
    single(c, 6625)
    single(c, 7000)
  }
  for (const c of [400, 2000, 1200, 150, 250]) {
    single(c, 6625, 'LINE_ITEM')
    single(c, 7000, 'LINE_ITEM')
  }
  const baskets: Array<{ label: string; lines: TaxLine[] }> = [
    { label: '$4 + $4', lines: [{ unitCents: 400, qty: 1 }, { unitCents: 400, qty: 1 }] },
    { label: '$4 + $20', lines: [{ unitCents: 400, qty: 1 }, { unitCents: 2000, qty: 1 }] },
    { label: '$12 + $4', lines: [{ unitCents: 1200, qty: 1 }, { unitCents: 400, qty: 1 }] },
    { label: '$20 + $20 + $20', lines: [{ unitCents: 2000, qty: 1 }, { unitCents: 2000, qty: 1 }, { unitCents: 2000, qty: 1 }] },
    { label: '$40 + $15', lines: [{ unitCents: 4000, qty: 1 }, { unitCents: 1500, qty: 1 }] },
    { label: '$100 + $4', lines: [{ unitCents: 10_000, qty: 1 }, { unitCents: 400, qty: 1 }] },
    { label: '$20 + $36', lines: [{ unitCents: 2000, qty: 1 }, { unitCents: 3600, qty: 1 }] },
    { label: '$36 + $100 + $4', lines: [{ unitCents: 3600, qty: 1 }, { unitCents: 10_000, qty: 1 }, { unitCents: 400, qty: 1 }] },
    { label: '$4 x2', lines: [{ unitCents: 400, qty: 2 }] },
    { label: '$20 x3', lines: [{ unitCents: 2000, qty: 3 }] },
    { label: '$1.50 + $1.50', lines: [{ unitCents: 150, qty: 1 }, { unitCents: 150, qty: 1 }] },
    { label: '$2.50 x2 + $1.50', lines: [{ unitCents: 250, qty: 2 }, { unitCents: 150, qty: 1 }] },
  ]
  // an adjustment: Square taxes the discounted subtotal ($36 and $52 are half-cent subtotals at 6.625%)
  const discounted: Array<{ label: string; lines: TaxLine[]; discount: TaxCase['discount'] }> = [
    { label: '$40 - $4', lines: [{ unitCents: 4000, qty: 1 }], discount: { cents: 400 } },
    { label: '$40 - 10%', lines: [{ unitCents: 4000, qty: 1 }], discount: { percent: '10', cents: 400 } },
    { label: '$20 + $36 - $4', lines: [{ unitCents: 2000, qty: 1 }, { unitCents: 3600, qty: 1 }], discount: { cents: 400 } },
    { label: '$15 - $13.50', lines: [{ unitCents: 1500, qty: 1 }], discount: { cents: 1350 } },
  ]
  for (const d of discounted) for (const rateDbp of [6625, 7000]) out.push({ ...d, rateDbp, scope: 'ORDER' })
  for (const b of baskets)
    for (const scope of ['ORDER', 'LINE_ITEM'] as const)
      for (const rateDbp of [6625, 7000]) out.push({ label: b.label, rateDbp, lines: b.lines, scope })
  // the counter's path: catalog variations with a catalog TAX, auto-applied
  const catalog: Array<{ label: string; lines: TaxLine[] }> = [
    ...[400, 1200, 2000, 3600, 10_000, 4000, 150, 250].map((c) => ({ label: `$${(c / 100).toFixed(2)}`, lines: [{ unitCents: c, qty: 1 }] })),
    ...baskets.filter((b) => b.lines.every((l) => CATALOG_PRICES.includes(l.unitCents))),
  ]
  for (const b of catalog) for (const rateDbp of [6625, 7000]) out.push({ label: b.label, rateDbp, lines: b.lines, scope: 'CATALOG' })
  return out
}

/** The variation prices the catalog cases use (one variation each, under an item per rate). */
export const CATALOG_PRICES = [400, 1200, 2000, 3600, 10_000, 4000, 1500, 150, 250]

const calcAnswer = z
  .object({
    order: z
      .object({
        total_tax_money: z.object({ amount: z.number().int().nullish(), currency: z.string().nullish() }).passthrough().nullish(),
        line_items: z
          .array(z.object({ total_tax_money: z.object({ amount: z.number().int().nullish(), currency: z.string().nullish() }).passthrough().nullish() }).passthrough())
          .nullish(),
      })
      .passthrough(),
  })
  .passthrough()

interface CatalogIds {
  tax: Record<number, string>
  variation: Record<string, string>
}

async function makeCatalog(api: SquareApi, run: string, ref: string, locationId: string, cleanup: Array<{ what: string; run: () => Promise<unknown> }>): Promise<CatalogIds> {
  const objects: Record<string, unknown>[] = []
  for (const rateDbp of [6625, 7000]) {
    objects.push({
      type: 'TAX',
      id: `#tax-${rateDbp}`,
      present_at_all_locations: false,
      present_at_location_ids: [locationId],
      tax_data: {
        name: `Verify tax ${pct(rateDbp)}% ${ref}`,
        calculation_phase: 'TAX_SUBTOTAL_PHASE',
        inclusion_type: 'ADDITIVE',
        percentage: pct(rateDbp),
        applies_to_custom_amounts: false,
        enabled: true,
      },
    })
    objects.push({
      type: 'ITEM',
      id: `#item-${rateDbp}`,
      present_at_all_locations: false,
      present_at_location_ids: [locationId],
      item_data: {
        name: `Verify wash ${pct(rateDbp)}% ${ref}`,
        product_type: 'REGULAR',
        tax_ids: [`#tax-${rateDbp}`],
        variations: CATALOG_PRICES.map((c) => ({
          type: 'ITEM_VARIATION',
          id: `#var-${rateDbp}-${c}`,
          present_at_all_locations: false,
          present_at_location_ids: [locationId],
          item_variation_data: { item_id: `#item-${rateDbp}`, name: `$${(c / 100).toFixed(2)}`, pricing_type: 'FIXED_PRICING', price_money: usd(c) },
        })),
      },
    })
  }
  const r = await api.catalog.batchUpsert(sqKey('ct', `${run}:tax-catalog`), objects)
  const idOf = (tmp: string): string => {
    const m = r.idMappings.find((x) => x.client_object_id === tmp)?.object_id
    if (!m) throw new Error(`the batch upsert gave no id for ${tmp}`)
    return m
  }
  const ids: CatalogIds = { tax: {}, variation: {} }
  for (const rateDbp of [6625, 7000]) {
    ids.tax[rateDbp] = idOf(`#tax-${rateDbp}`)
    for (const c of CATALOG_PRICES) ids.variation[`${rateDbp}:${c}`] = idOf(`#var-${rateDbp}-${c}`)
    const item = idOf(`#item-${rateDbp}`)
    const tax = ids.tax[rateDbp]!
    cleanup.push({ what: `verify tax item ${item} and tax ${tax}`, run: async () => Promise.all([api.catalog.delete(item), api.catalog.delete(tax)]) })
  }
  return ids
}

function orderBody(c: TaxCase, locationId: string, ref: string, ids: CatalogIds | undefined): Record<string, unknown> {
  const taxName = `Sales tax ${pct(c.rateDbp)}%`
  if (c.scope === 'CATALOG') {
    if (!ids) throw new Error('catalog objects missing')
    return {
      location_id: locationId,
      reference_id: ref,
      pricing_options: { auto_apply_taxes: true },
      line_items: c.lines.map((l) => ({ quantity: String(l.qty), catalog_object_id: ids.variation[`${c.rateDbp}:${l.unitCents}`] })),
    }
  }
  const lines = c.lines.map((l, i) => ({
    uid: `l${i}`,
    name: `Line ${i + 1}`,
    quantity: String(l.qty),
    base_price_money: usd(l.unitCents),
    ...(c.scope === 'LINE_ITEM' ? { applied_taxes: [{ tax_uid: 'tax' }] } : {}),
  }))
  const d = c.discount
  return {
    location_id: locationId,
    reference_id: ref,
    line_items: lines,
    taxes: [{ uid: 'tax', name: taxName, percentage: pct(c.rateDbp), type: 'ADDITIVE', scope: c.scope }],
    ...(d
      ? {
          discounts: [
            'percent' in d
              ? { uid: 'disc', name: 'Adjustment', type: 'FIXED_PERCENTAGE', percentage: d.percent, scope: 'ORDER' }
              : { uid: 'disc', name: 'Adjustment', type: 'FIXED_AMOUNT', amount_money: usd(d.cents), scope: 'ORDER' },
          ],
        }
      : {}),
  }
}

/** CalculateOrder for one case: Square's total tax and each line's tax. */
export async function calculate(client: SquareClient, c: TaxCase, locationId: string, ref: string, ids?: CatalogIds): Promise<TaxObservation> {
  const r = await client.request({
    method: 'POST',
    path: '/v2/orders/calculate',
    body: { order: orderBody(c, locationId, ref, ids) },
    readOnly: true,
    schema: calcAnswer,
  })
  return {
    ...c,
    squareTax: centsOf(r.order.total_tax_money ?? null, 'total tax'),
    squareLineTaxes: (r.order.line_items ?? []).map((l) => centsOf(l.total_tax_money ?? null, 'line tax')),
  }
}

const money = (c: number): string => `$${(c / 100).toFixed(2)}`

/** The markdown table docs/integrations/square.md and ADR 0173 carry (one row per case). */
export function resultTable(obs: readonly TaxObservation[]): string[] {
  const rows = ['| Case | Scope | Rate | Taxable subtotal | Square tax (per line) | half-up | half-even | Oasis |', '|---|---|---|---|---|---|---|---|']
  for (const o of obs) {
    const sub = o.lines.reduce((s, l) => s + l.unitCents * l.qty, 0) - (o.discount?.cents ?? 0)
    rows.push(
      `| ${o.label} | ${o.scope} | ${pct(o.rateDbp)}% | ${money(sub)} | ${money(o.squareTax)}${o.squareLineTaxes.length > 1 ? ` (${o.squareLineTaxes.map(money).join(' + ')})` : ''} | ${money(ruleTax('order_half_up', o.rateDbp, o.lines, o.discount?.cents))} | ${money(ruleTax('order_half_even', o.rateDbp, o.lines, o.discount?.cents))} | ${money(oasisTax(o))} |`,
    )
  }
  return rows
}

/** Oasis's rule for a new invoice with the same lines: the tax of the subtotal, rounded once (salesTaxCents, ADR 0173). */
export const oasisTax = (o: TaxCase): number =>
  salesTaxCents(o.lines.reduce((s, l) => s + l.unitCents * l.qty, 0) - (o.discount?.cents ?? 0), { dbp: o.rateDbp, rounding: NEW_INVOICE_TAX_ROUNDING })

export async function sqr18(
  o: { api: SquareApi; client: SquareClient; report: Report; run: string; ref: string; locationId: string; cleanup: Array<{ what: string; run: () => Promise<unknown> }> },
  log: (line: string) => void,
): Promise<TaxObservation[]> {
  const ids = await makeCatalog(o.api, o.run, o.ref, o.locationId, o.cleanup)
  const obs: TaxObservation[] = []
  for (const c of taxCases()) obs.push(await calculate(o.client, c, o.locationId, o.ref, ids))
  const byScope = (s: TaxCase['scope']) => obs.filter((x) => x.scope === s)
  const summary = (['ORDER', 'LINE_ITEM', 'CATALOG'] as const).map((s) => `${s}: ${matchingRules(byScope(s)).join('/') || 'no single rule'}`)
  const all = matchingRules(obs)
  const differ = obs.filter((x) => oasisTax(x) !== x.squareTax)
  for (const line of resultTable(obs)) log(line)
  const evidence = [...summary, `all ${obs.length} cases: ${all.join('/') || 'no single rule'}`]
  if (differ.length)
    o.report.fail(
      'SQR-18',
      `${differ.length} of ${obs.length} totals differ from Oasis's tax (${differ.slice(0, 5).map((d) => `${d.label} ${d.scope} ${pct(d.rateDbp)}%: Square ${d.squareTax}, Oasis ${oasisTax(d)}`).join('; ')})`,
      'align salesTaxCents in src/platform/money.ts (and invoice_calc_of) with the rule this check prints',
      evidence,
    )
  else o.report.pass('SQR-18', `${obs.length} CalculateOrder totals equal Oasis's tax; Square's rule: ${all.join('/') || summary.join('; ')}`, evidence)
  return obs
}
