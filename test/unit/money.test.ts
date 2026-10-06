import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  MAX_MONEY_CENTS,
  divHalfUp,
  formatDecimal,
  formatUsd,
  formatUsdOps,
  parseMoneyToCents,
  percentOfCents,
  sumCents,
  taxCents,
} from '../../src/platform/money.js'

const TAX_BP = 700
const invoice = (items: number, adj = 0, tip = 0) => {
  const sub = items + adj
  const tax = taxCents(sub, TAX_BP)
  return { sub, tax, total: sub + tax + tip }
}

describe('golden vectors (backend design 10.1)', () => {
  it('taxCents rounds half-up at .5', () => {
    expect(taxCents(50, TAX_BP)).toBe(4)
    expect(taxCents(150, TAX_BP)).toBe(11)
    expect(taxCents(250, TAX_BP)).toBe(18)
    expect(taxCents(1000, TAX_BP)).toBe(70)
    expect(taxCents(0, TAX_BP)).toBe(0)
  })

  it('INV-20604: items 18400 -> tax 1288, total 19688', () => {
    expect(invoice(18400)).toEqual({ sub: 18400, tax: 1288, total: 19688 })
  })

  it('INV-20608: items 54000 -> tax 3780, total 57780', () => {
    expect(invoice(54000)).toEqual({ sub: 54000, tax: 3780, total: 57780 })
  })

  it('INV-20603: items 15400 -> tax 1078, total 16478', () => {
    expect(invoice(15400)).toEqual({ sub: 15400, tax: 1078, total: 16478 })
  })

  it('INV-20602: items 37500, adjustment -2500, tip 2000 -> tax 2450, total 39450 (tip untaxed)', () => {
    expect(invoice(37500, -2500, 2000)).toEqual({ sub: 35000, tax: 2450, total: 39450 })
  })

  it('INV-20605 and INV-20607 totals', () => {
    // 25 000 + deposit math is in the ledger; here only the item totals the vectors name
    expect(27820 - 5000).toBe(22820)
    expect(13375 - 2000).toBe(11375)
  })

  it('percent discount: 10 percent of items 15400 is 1540', () => {
    expect(percentOfCents(15400, 1000)).toBe(1540)
    expect(percentOfCents(1, 5000)).toBe(1) // 0.5 rounds up
    expect(percentOfCents(15, 1250)).toBe(2) // 1.875
  })

  it('INV-20571: net = 32000 - divHalfUp(5000 * 10000, 10700) = 27327', () => {
    expect(divHalfUp(5000 * 10000, 10700)).toBe(4673)
    expect(32000 - divHalfUp(5000 * 10000, 10700)).toBe(27327)
  })
})

describe('divHalfUp', () => {
  it('rounds exact halves up, including negatives (toward +infinity)', () => {
    expect(divHalfUp(5, 10)).toBe(1)
    expect(divHalfUp(4, 10)).toBe(0)
    expect(divHalfUp(-5, 10)).toBe(0)
    expect(divHalfUp(-6, 10)).toBe(-1)
    expect(divHalfUp(15, 10)).toBe(2)
  })
  it('never returns negative zero', () => {
    expect(Object.is(divHalfUp(-4, 10), 0)).toBe(true)
  })
  it('rejects non-integers, unsafe values and non-positive divisors', () => {
    expect(() => divHalfUp(1.5, 2)).toThrow(RangeError)
    expect(() => divHalfUp(1, 0)).toThrow(RangeError)
    expect(() => divHalfUp(Number.MAX_SAFE_INTEGER, 3)).toThrow(RangeError)
  })
})

describe('property tests', () => {
  const cents = fc.integer({ min: 0, max: 100_000_000 })
  const bp = fc.integer({ min: 0, max: 10_000 })

  it('divHalfUp equals exact BigInt half-up (floor of n/d + 1/2) rounding', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (n, d) => {
          const num = BigInt(n) * 2n + BigInt(d)
          const den = 2n * BigInt(d)
          const floor = num / den - (num % den !== 0n && num < 0n ? 1n : 0n) // BigInt division truncates toward zero
          expect(divHalfUp(n, d)).toBe(Number(floor))
        },
      ),
    )
  })

  it('tax is within half a cent of the exact value and half-up on exact ties', () => {
    fc.assert(
      fc.property(cents, bp, (sub, rate) => {
        const t = taxCents(sub, rate)
        const exactTimes10000 = sub * rate
        expect(Math.abs(t * 10_000 - exactTimes10000)).toBeLessThanOrEqual(5000)
        if (exactTimes10000 % 10_000 === 5000) expect(t * 10_000).toBe(exactTimes10000 + 5000)
      }),
    )
  })

  it('tax is monotone in the subtotal and in the rate', () => {
    fc.assert(
      fc.property(cents, cents, bp, (a, b, rate) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        expect(taxCents(lo, rate)).toBeLessThanOrEqual(taxCents(hi, rate))
      }),
    )
    fc.assert(
      fc.property(cents, bp, bp, (sub, r1, r2) => {
        const [lo, hi] = r1 <= r2 ? [r1, r2] : [r2, r1]
        expect(taxCents(sub, lo)).toBeLessThanOrEqual(taxCents(sub, hi))
      }),
    )
  })

  it('total = subtotal + tax + tip and the tip never changes the tax', () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 0, max: 5_000_000 }), (items, tip) => {
        const a = invoice(items, 0, 0)
        const b = invoice(items, 0, tip)
        expect(b.tax).toBe(a.tax)
        expect(b.total).toBe(b.sub + b.tax + tip)
      }),
    )
  })

  it('a percentage never exceeds the amount and 100% is the amount', () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 0, max: 10_000 }), (c, p) => {
        expect(percentOfCents(c, p)).toBeLessThanOrEqual(c)
        expect(percentOfCents(c, 10_000)).toBe(c)
      }),
    )
  })

  it('parseMoneyToCents inverts formatDecimal for non-negative amounts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99_999_999_999 }), (c) => {
        expect(parseMoneyToCents(formatDecimal(c))).toBe(c)
        expect(parseMoneyToCents(formatUsd(c))).toBe(c)
      }),
    )
  })

  it('sumCents is exact', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 50 }), (xs) => {
        expect(sumCents(xs)).toBe(xs.reduce((a, b) => a + b, 0))
      }),
    )
  })
})

describe('parseMoneyToCents (design quirk rules)', () => {
  it.each([
    ['', 0],
    ['abc', 0],
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    ['$1,234.50', 123450],
    ['.5', 50],
    ['5.', 500],
    ['0.07', 7],
    ['1.2.3', 120], // parsing stops at the second dot, like parseFloat
    ['1.005', 101], // third decimal rounds half-up, exactly (floats would give 1.00)
    ['1.004', 100],
    ['0.995', 100],
    ['-5', 500], // the design strips every non-digit, so the minus is ignored
    ['  $ 20 ', 2000],
    ['007.10', 710],
  ])('parses %j as %i cents', (raw, expected) => {
    expect(parseMoneyToCents(raw)).toBe(expected)
  })
  it('rejects absurd amounts instead of losing precision', () => {
    expect(() => parseMoneyToCents('9'.repeat(30))).toThrow(RangeError)
    expect(parseMoneyToCents(String(MAX_MONEY_CENTS / 100))).toBe(MAX_MONEY_CENTS)
  })
})

describe('formatters', () => {
  it('formatDecimal is a plain decimal for CSV', () => {
    expect(formatDecimal(123450)).toBe('1234.50')
    expect(formatDecimal(5)).toBe('0.05')
    expect(formatDecimal(-250)).toBe('-2.50')
    expect(formatDecimal(0)).toBe('0.00')
  })
  it('formatUsd groups thousands and uses U+2212 for negatives', () => {
    expect(formatUsd(123450)).toBe('$1,234.50')
    expect(formatUsd(-1200)).toBe('−$12.00')
    expect(formatUsd(100_000_000)).toBe('$1,000,000.00')
  })
  it('formatUsdOps hides zero cents', () => {
    expect(formatUsdOps(12000)).toBe('$120')
    expect(formatUsdOps(129853)).toBe('$1,298.53')
    expect(formatUsdOps(-500)).toBe('−$5')
  })
})
