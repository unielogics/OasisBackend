// The simulator's CalculateOrder (ADR 0172 tax check, ADR 0173): an order priced the way the sandbox priced 200 of them (SQR-18,
// test/fixtures/square-tax): every ADDITIVE tax is computed ONCE on its taxable subtotal (the lines it applies to, after the order
// discounts) and rounded HALF TO EVEN, then spread over those lines (largest remainder; Square's exact spread of a tie may differ by
// a cent between lines, never in total). Lines are ad-hoc (name, base_price_money) or rung up from the item library
// (catalog_object_id of an ITEM_VARIATION: its price, or base_price_money for VARIABLE_PRICING); with pricing_options.auto_apply_taxes
// a catalog line gets its item's enabled ADDITIVE taxes present at the location. Nothing is stored.
import type { SimCatalog } from './catalog.js'

type Obj = Record<string, unknown>
type Money = { amount: number; currency: string }

export class SimCalculateError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail)
  }
}

const usd = (amount: number): Money => ({ amount, currency: 'USD' })

/** A percentage string as an integer number of millionths of a percent ("6.625" -> 6625000). */
export function percentMicros(p: unknown): number {
  if (typeof p !== 'string' || !/^\d{1,3}(\.\d{1,6})?$/.test(p)) throw new SimCalculateError('INVALID_VALUE', `percentage must be a decimal string, got ${String(p)}`)
  const [w, f = ''] = p.split('.')
  return Number(w) * 1_000_000 + Number(f.padEnd(6, '0'))
}

/** n / d rounded half to even (n, d > 0 integers). */
export function divHalfEvenInt(n: number, d: number): number {
  const q = Math.floor(n / d)
  const r = n - q * d
  if (2 * r < d) return q
  if (2 * r > d) return q + 1
  return q % 2 === 0 ? q : q + 1
}

const PERCENT_DEN = 100 * 1_000_000

/** Splits `total` over `weights` in proportion, largest remainder first (a tie goes to the later line). */
export function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0)
  if (sum <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (total * w) / sum)
  const out = exact.map((x) => Math.floor(x))
  let left = total - out.reduce((s, x) => s + x, 0)
  const order = exact.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || b.i - a.i)
  for (const o of order) {
    if (left <= 0) break
    out[o.i]! += 1
    left--
  }
  return out
}

interface Line {
  uid: string
  name: string
  qty: number
  unit: number
  gross: number
  discount: number
  taxUids: Set<string>
  src: Obj
  catalog?: { variationId: string; version: unknown; variationName: string; itemTaxIds: string[] }
}

interface Tax {
  uid: string
  name: string
  micros: number
  scope: 'ORDER' | 'LINE_ITEM'
  catalogObjectId?: string
  auto?: boolean
}

export function calculateOrder(order: Obj, catalog: SimCatalog, locationId: string): Obj {
  if (order.location_id !== locationId) throw new SimCalculateError('NOT_FOUND', `Location \`${String(order.location_id)}\` not found.`)
  const autoTaxes = (order.pricing_options as Obj | undefined)?.auto_apply_taxes === true
  const rawLines = (order.line_items as Obj[] | undefined) ?? []
  const lines: Line[] = rawLines.map((l, i) => {
    const qty = Number(l.quantity)
    if (!(qty > 0) || !Number.isInteger(qty)) throw new SimCalculateError('INVALID_VALUE', 'quantity must be a positive whole number (as a string).')
    const uid = typeof l.uid === 'string' ? l.uid : `line-${i}`
    let unit: number
    let name = typeof l.name === 'string' ? l.name : ''
    let cat: Line['catalog']
    if (typeof l.catalog_object_id === 'string') {
      const v = catalog.objects.get(l.catalog_object_id)
      if (!v || v.type !== 'ITEM_VARIATION') throw new SimCalculateError('NOT_FOUND', `Item variation \`${l.catalog_object_id}\` not found.`)
      const d = v.item_variation_data as Obj
      const item = catalog.objects.get(String(d.item_id))
      const override = ((d.location_overrides as Obj[] | undefined) ?? []).find((o) => o.location_id === locationId && o.price_money)
      if (d.pricing_type === 'VARIABLE_PRICING') {
        const b = l.base_price_money as Money | undefined
        if (!b) throw new SimCalculateError('INVALID_VALUE', 'A variable-price item needs base_price_money.')
        unit = b.amount
      } else unit = ((override?.price_money ?? d.price_money) as Money).amount
      name = String((item?.item_data as Obj | undefined)?.name ?? name)
      cat = {
        variationId: l.catalog_object_id,
        version: v.version,
        variationName: String(d.name ?? ''),
        itemTaxIds: (((item?.item_data as Obj | undefined)?.tax_ids as string[] | undefined) ?? []).slice(),
      }
    } else {
      const b = l.base_price_money as Money | undefined
      if (!b || typeof b.amount !== 'number') throw new SimCalculateError('INVALID_VALUE', 'An ad-hoc line needs base_price_money.')
      if (!name) throw new SimCalculateError('MISSING_REQUIRED_PARAMETER', 'An ad-hoc line needs a name.')
      unit = b.amount
    }
    const taxUids = new Set(((l.applied_taxes as Obj[] | undefined) ?? []).map((t) => String(t.tax_uid)))
    return { uid, name, qty, unit, gross: unit * qty, discount: 0, taxUids, src: l, catalog: cat }
  })
  const taxes: Tax[] = ((order.taxes as Obj[] | undefined) ?? []).map((t, i) => {
    if ((t.type ?? 'ADDITIVE') !== 'ADDITIVE') throw new SimCalculateError('INVALID_VALUE', 'The simulator prices ADDITIVE taxes only.')
    let micros: number
    let name = String(t.name ?? 'Tax')
    if (typeof t.catalog_object_id === 'string') {
      const o = catalog.objects.get(t.catalog_object_id)
      if (!o || o.type !== 'TAX') throw new SimCalculateError('NOT_FOUND', `Tax \`${t.catalog_object_id}\` not found.`)
      micros = percentMicros((o.tax_data as Obj).percentage)
      name = String((o.tax_data as Obj).name)
    } else micros = percentMicros(t.percentage)
    return { uid: typeof t.uid === 'string' ? t.uid : `tax-${i}`, name, micros, scope: t.scope === 'LINE_ITEM' ? 'LINE_ITEM' : 'ORDER', catalogObjectId: t.catalog_object_id as string | undefined }
  })
  if (autoTaxes) {
    const byId = new Map<string, Tax>()
    for (const l of lines) {
      for (const id of l.catalog?.itemTaxIds ?? []) {
        const o = catalog.objects.get(id)
        const d = o?.tax_data as Obj | undefined
        if (!o || !d || d.enabled === false || d.inclusion_type === 'INCLUSIVE') continue
        const here = o.present_at_all_locations !== false || ((o.present_at_location_ids as string[] | undefined) ?? []).includes(locationId)
        if (!here) continue
        let t = byId.get(id)
        if (!t) {
          t = { uid: `auto-${id}`, name: String(d.name), micros: percentMicros(d.percentage), scope: 'LINE_ITEM', catalogObjectId: id, auto: true }
          byId.set(id, t)
          taxes.push(t)
        }
        l.taxUids.add(t.uid)
      }
    }
  }
  // order discounts, spread over the lines by their gross
  let discountTotal = 0
  const discounts = ((order.discounts as Obj[] | undefined) ?? []).map((d, i) => {
    const gross = lines.reduce((s, l) => s + l.gross, 0)
    let amount: number
    if (d.type === 'FIXED_AMOUNT') amount = Math.min(gross, Number((d.amount_money as Money | undefined)?.amount ?? 0))
    else if (d.type === 'FIXED_PERCENTAGE') amount = divHalfEvenInt(gross * percentMicros(d.percentage), PERCENT_DEN)
    else throw new SimCalculateError('INVALID_VALUE', 'The simulator prices FIXED_AMOUNT and FIXED_PERCENTAGE discounts only.')
    spread(amount, lines.map((l) => l.gross)).forEach((x, j) => (lines[j]!.discount += x))
    discountTotal += amount
    return { uid: typeof d.uid === 'string' ? d.uid : `discount-${i}`, name: d.name, type: d.type, scope: d.scope ?? 'ORDER', applied_money: usd(amount), ...(d.percentage ? { percentage: d.percentage } : {}), ...(d.amount_money ? { amount_money: d.amount_money } : {}) }
  })
  // each tax once on its taxable subtotal, half to even, then spread
  const lineTax = lines.map(() => 0)
  const appliedTaxes = lines.map(() => [] as Obj[])
  const taxOut = taxes.map((t) => {
    const applies = lines.map((l) => t.scope === 'ORDER' || l.taxUids.has(t.uid))
    const bases = lines.map((l, i) => (applies[i] ? l.gross - l.discount : 0))
    const base = bases.reduce((s, b) => s + b, 0)
    const amount = divHalfEvenInt(base * t.micros, PERCENT_DEN)
    spread(amount, bases).forEach((x, i) => {
      if (!applies[i]) return
      lineTax[i]! += x
      appliedTaxes[i]!.push({ uid: `${t.uid}-${i}`, tax_uid: t.uid, applied_money: usd(x) })
    })
    return {
      uid: t.uid,
      name: t.name,
      percentage: (t.micros / 1_000_000).toString(),
      type: 'ADDITIVE',
      scope: t.scope,
      ...(t.catalogObjectId ? { catalog_object_id: t.catalogObjectId } : {}),
      ...(t.auto ? { auto_applied: true } : {}),
      applied_money: usd(amount),
    }
  })
  const lineItems = lines.map((l, i) => ({
    uid: l.uid,
    name: l.name,
    quantity: String(l.qty),
    item_type: 'ITEM',
    ...(l.catalog ? { catalog_object_id: l.catalog.variationId, catalog_version: l.catalog.version, variation_name: l.catalog.variationName } : {}),
    base_price_money: usd(l.unit),
    variation_total_price_money: usd(l.gross),
    gross_sales_money: usd(l.gross),
    total_discount_money: usd(l.discount),
    total_tax_money: usd(lineTax[i]!),
    total_money: usd(l.gross - l.discount + lineTax[i]!),
    ...(appliedTaxes[i]!.length ? { applied_taxes: appliedTaxes[i] } : {}),
  }))
  const tax = lineTax.reduce((s, x) => s + x, 0)
  const total = lines.reduce((s, l) => s + l.gross, 0) - discountTotal + tax
  return {
    location_id: locationId,
    ...(order.reference_id ? { reference_id: order.reference_id } : {}),
    line_items: lineItems,
    ...(taxOut.length ? { taxes: taxOut } : {}),
    ...(discounts.length ? { discounts } : {}),
    state: 'OPEN',
    version: 1,
    total_money: usd(total),
    total_tax_money: usd(tax),
    total_discount_money: usd(discountTotal),
    total_tip_money: usd(0),
    total_service_charge_money: usd(0),
    net_amount_due_money: usd(total),
  }
}
