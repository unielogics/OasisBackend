// ADR 0173: the sales tax rate in thousandths of a percent and Square's rounding. The golden vectors at 6.625% are Square's own
// answers (sandbox CalculateOrder, pnpm verify:square --tax-only = SQR-18, recorded in test/fixtures/square-tax); the 7% vectors of the
// design never change (half-up invoices) and whole-dollar 7% subtotals give the same tax under both rules.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  divHalfEven,
  divHalfUp,
  legacyTaxBp,
  parseTaxPercent,
  salesTaxCents,
  SQUARE_TAX_ROUNDING,
  taxPercentLabel,
  type TaxRate,
} from '../../src/platform/money.js'
import { calcInvoice, itemsRefundValue, adjustPreview } from '../../src/modules/payments/calc.js'
import { matchingRules, oasisTax, ruleTax, taxCases, type TaxObservation } from '../../scripts/verify-live/square-tax.js'

const NJ: TaxRate = { dbp: 6625, rounding: 'half_even' }
const SEVEN_NEW: TaxRate = { dbp: 7000, rounding: 'half_even' }
const SEVEN_OLD: TaxRate = { dbp: 7000, rounding: 'half_up' }

interface Fixture {
  source: string
  observations: Array<{ label: string; scope: string; rateDbp: number; taxableCents: number; squareTax: number; squareLineTaxes: number[] }>
}
const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../fixtures/square-tax/sqr18-tax-rounding-2026-10-13.json'), 'utf8')) as Fixture

describe('divHalfEven', () => {
  it('rounds exact halves to the even neighbour, everything else to the nearest', () => {
    expect([5, 15, 25, 35, 14, 16, -5, -15, 0].map((n) => divHalfEven(n, 10))).toEqual([0, 2, 2, 4, 1, 2, 0, -2, 0])
    expect(divHalfEven(265_000, 10_000)).toBe(26) // 26.5 -> 26
    expect(divHalfEven(795_000, 10_000)).toBe(80) // 79.5 -> 80
  })

  it('equals an exact BigInt reference and differs from half-up only on an exact half with an even floor', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), fc.integer({ min: 1, max: 200_000 }), (n, d) => {
        const N = BigInt(n)
        const D = BigInt(d)
        let q = N / D
        let r = N % D
        if (r < 0n) {
          q -= 1n
          r += D
        }
        const ref = 2n * r > D ? q + 1n : 2n * r < D ? q : q % 2n === 0n ? q : q + 1n
        expect(divHalfEven(n, d)).toBe(Number(ref))
        const exactHalf = 2n * r === D
        if (divHalfEven(n, d) !== divHalfUp(n, d)) expect(exactHalf && q % 2n === 0n).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })
})

describe("salesTaxCents: Square's rule at 6.625% (golden vectors from the sandbox)", () => {
  it('half-cent subtotals ($4 + $8k) round to the even cent; the rest to the nearest', () => {
    const vectors: Array<[number, number]> = [
      [400, 26], [1200, 80], [2000, 132], [3600, 238], [5200, 344], [10_000, 662], [50_000, 3312],
      [100, 7], [500, 33], [4000, 265], [5000, 331], [5500, 364], [12_900, 855], [25_000, 1656],
      [800, 53], [1600, 106], [2400, 159], [6000, 398], [10_400, 689], [5600, 371], [14_000, 928], [150, 10], [250, 17], [650, 43],
    ]
    for (const [sub, tax] of vectors) expect(salesTaxCents(sub, NJ), `$${sub / 100}`).toBe(tax)
  })

  it('every one of the 200 recorded CalculateOrder answers equals Oasis (ad-hoc, line-item and catalog taxes, baskets, discounts)', () => {
    expect(fixture.observations).toHaveLength(200)
    const cases = taxCases()
    expect(cases).toHaveLength(fixture.observations.length)
    const obs: TaxObservation[] = cases.map((c, i) => {
      const o = fixture.observations[i]!
      expect([o.label, o.scope, o.rateDbp]).toEqual([c.label, c.scope, c.rateDbp])
      return { ...c, squareTax: o.squareTax, squareLineTaxes: o.squareLineTaxes }
    })
    // Square rounds once per order, half to even, whatever the tax's scope and whether the lines are catalog items
    expect(matchingRules(obs)).toEqual(['order_half_even'])
    for (const o of obs) {
      expect(oasisTax(o), `${o.label} ${o.scope} ${o.rateDbp}`).toBe(o.squareTax)
      // the per-line split Square shows always adds up to the order's tax
      expect(o.squareLineTaxes.reduce((a, b) => a + b, 0)).toBe(o.squareTax)
    }
    // per-line rounding would be wrong: $4 + $4 at 6.625% is 53 cents at Square (26 + 27), not 52 or 54
    const fourPlusFour = obs.find((o) => o.label === '$4 + $4' && o.scope === 'ORDER' && o.rateDbp === 6625)!
    expect([fourPlusFour.squareTax, ruleTax('line_half_even', 6625, fourPlusFour.lines), ruleTax('line_half_up', 6625, fourPlusFour.lines)]).toEqual([53, 52, 54])
  })

  it("Square's rule (set at the rollout) rounds half to even, once on the adjusted subtotal", () => {
    expect(SQUARE_TAX_ROUNDING).toBe('half_even')
    const c = calcInvoice({ itemPrices: [2000, 3600], events: [{ type: 'adjust', amountCents: -400 }], taxDbp: 6625, taxRounding: 'half_even', tipCents: 500, canceled: false })
    expect([c.sub, c.tax, c.total]).toEqual([5200, 344, 6044])
    const old = calcInvoice({ itemPrices: [2000, 3600], events: [{ type: 'adjust', amountCents: -400 }], taxDbp: 6625, taxRounding: 'half_up', tipCents: 500, canceled: false })
    expect(old.tax).toBe(345)
  })

  it('by-item refunds and adjustment previews use the invoice rule too', () => {
    expect(itemsRefundValue([400], NJ, 100_000)).toBe(426)
    expect(itemsRefundValue([400], { dbp: 6625, rounding: 'half_up' }, 100_000)).toBe(427)
    const c = calcInvoice({ itemPrices: [4000], events: [], taxDbp: 6625, taxRounding: 'half_even', tipCents: 0, canceled: false })
    expect(adjustPreview(c, NJ, { kind: 'discount', unit: '$', value: 400 }).newTotal).toBe(3600 + 238)
  })
})

describe('7%: the numbers of existing invoices never change', () => {
  it('the design vectors (half-up) are untouched', () => {
    expect([50, 150, 250, 1000, 18_400, 54_000, 15_400, 35_000].map((s) => salesTaxCents(s, SEVEN_OLD))).toEqual([4, 11, 18, 70, 1288, 3780, 1078, 2450])
  })

  it('in dbp half-up gives exactly the old basis-point formula for every whole-bp rate', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 10_000 }), (sub, bp) => {
        expect(salesTaxCents(sub, { dbp: bp * 10, rounding: 'half_up' })).toBe(Math.floor((sub * bp * 2 + 10_000) / 20_000))
      }),
      { numRuns: 2000 },
    )
  })

  it('a whole-dollar subtotal at 7% has the same tax under both rules (they differ only on $x.50 subtotals with x odd)', () => {
    for (let dollars = 0; dollars <= 5000; dollars++) expect(salesTaxCents(dollars * 100, SEVEN_NEW)).toBe(salesTaxCents(dollars * 100, SEVEN_OLD))
    expect([salesTaxCents(150, SEVEN_NEW), salesTaxCents(150, SEVEN_OLD)]).toEqual([10, 11])
    expect([salesTaxCents(250, SEVEN_NEW), salesTaxCents(250, SEVEN_OLD)]).toEqual([18, 18])
  })
})

describe('the rate as staff read and type it', () => {
  it('labels with up to three decimals and no trailing zeros', () => {
    expect([7000, 6625, 6250, 6600, 0, 100_000, 1, 10].map(taxPercentLabel)).toEqual(['7%', '6.625%', '6.25%', '6.6%', '0%', '100%', '0.001%', '0.01%'])
  })

  it('parses a percentage exactly, up to three decimals, 0 to 100', () => {
    expect(['6.625', '7', '7.0', '6.625%', ' 6.625 ', '0', '100', '0.001', '8.25'].map(parseTaxPercent)).toEqual([6625, 7000, 7000, 6625, 6625, 0, 100_000, 1, 8250])
    for (const bad of ['6.6255', '-1', '100.001', '101', 'abc', '', '6,625', '1e2', '.5', '6.62.5']) expect(parseTaxPercent(bad), bad).toBeNull()
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (dbp) => {
        expect(parseTaxPercent(taxPercentLabel(dbp))).toBe(dbp)
      }),
    )
  })

  it('the deprecated whole-bp field rounds half-up', () => {
    expect([7000, 6625, 8250, 0].map(legacyTaxBp)).toEqual([700, 663, 825, 0])
  })
})
