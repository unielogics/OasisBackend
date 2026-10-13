// Integer cents only. This is the only module that does money arithmetic or formatting.
// Rounding is half-up (toward +infinity on exact halves) in integer math, except sales tax on an invoice whose tax_rounding is
// half_even (Square's rule, ADR 0173); floats never touch a cent value.

export const MAX_MONEY_CENTS = 1_000_000_000_000 // $10 billion, far below 2^53 so sums stay exact

function assertSafe(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${String(n)}`)
}

/** Divides n by d (d > 0) and rounds half-up. Works for negative n (exact halves round toward +infinity). */
export function divHalfUp(n: number, d: number): number {
  assertSafe(n, 'numerator')
  assertSafe(d, 'divisor')
  if (d <= 0) throw new RangeError('divisor must be positive')
  assertSafe(n * 2 + d, 'numerator')
  const q = Math.floor((n * 2 + d) / (2 * d))
  return q === 0 ? 0 : q
}

/** Divides n by d (d > 0) and rounds half to even ("bankers' rounding", Square's rule). Works for negative n. */
export function divHalfEven(n: number, d: number): number {
  assertSafe(n, 'numerator')
  assertSafe(d, 'divisor')
  if (d <= 0) throw new RangeError('divisor must be positive')
  const q = Math.floor(n / d)
  const r2 = 2 * (n - q * d)
  const out = r2 < d ? q : r2 > d ? q + 1 : q % 2 === 0 ? q : q + 1
  return out === 0 ? 0 : out
}

/**
 * Sales tax (ADR 0173). The rate is in thousandths of a percent ("dbp", tenths of a basis point): 7000 = 7%, 6625 = 6.625%; an
 * invoice keeps its own rate and its own rounding rule. Square (CalculateOrder, sandbox check SQR-18) rounds the tax of an order
 * ONCE on its taxable subtotal, half to even. A new invoice takes the location's setting tax.rounding: half_up by default (the
 * design's rule, so today's 7% numbers never change), half_even once the rollout switches it together with 6.625%.
 */
export type TaxRounding = 'half_up' | 'half_even'
export const TAX_ROUNDINGS = ['half_up', 'half_even'] as const satisfies readonly TaxRounding[]
/** Square's rule (SQR-18): what tax.rounding is set to at the rollout, so Oasis's tax equals Square's to the cent. */
export const SQUARE_TAX_ROUNDING: TaxRounding = 'half_even'
/** 100% in dbp: a rate is 0 to 100000 (0% to 100%). */
export const TAX_DBP_PER_100_PERCENT = 100_000

export interface TaxRate {
  /** Thousandths of a percent: 6625 = 6.625%. */
  dbp: number
  rounding: TaxRounding
}

/** Tax on a (non-negative) subtotal, once per invoice, rounded to the cent by the invoice's rule. */
export function salesTaxCents(subCents: number, rate: TaxRate): number {
  assertSafe(subCents, 'subtotal')
  assertSafe(rate.dbp, 'tax rate')
  const n = subCents * rate.dbp
  return rate.rounding === 'half_even' ? divHalfEven(n, TAX_DBP_PER_100_PERCENT) : divHalfUp(n, TAX_DBP_PER_100_PERCENT)
}

/** The rate in whole basis points for readers that predate ADR 0173 (DTO field taxBp, deprecated): 6625 -> 663, 7000 -> 700. */
export const legacyTaxBp = (dbp: number): number => divHalfUp(dbp, 10)

/** "7%", "6.625%": the rate as staff read it (up to three decimals, no trailing zeros). */
export function taxPercentLabel(dbp: number): string {
  assertSafe(dbp, 'tax rate')
  const whole = Math.floor(dbp / 1000)
  const frac = String(dbp % 1000).padStart(3, '0').replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''}%`
}

/**
 * Parses a percentage as staff type it ("6.625", "7", "6.625%") into dbp exactly (no floats): up to three decimals, 0 to 100.
 * Returns null for anything else (four decimals, letters, a minus sign, more than 100).
 */
export function parseTaxPercent(raw: string): number | null {
  const m = /^\s*(\d{1,3})(?:\.(\d{0,3}))?\s*%?\s*$/.exec(String(raw ?? ''))
  if (!m) return null
  const dbp = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0') || '0')
  return dbp <= TAX_DBP_PER_100_PERCENT ? dbp : null
}

/** A percentage of an amount; pctBp is the percent in basis points (1000 = 10%, two decimals allowed). */
export function percentOfCents(cents: number, pctBp: number): number {
  assertSafe(cents, 'amount')
  assertSafe(pctBp, 'percent')
  return divHalfUp(cents * pctBp, 10_000)
}

export function sumCents(values: readonly number[]): number {
  let total = 0
  for (const v of values) {
    assertSafe(v, 'amount')
    total += v
  }
  assertSafe(total, 'sum')
  return total
}

export const clampCents = (cents: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, cents))

/**
 * Shared amount parser for the dashboard and any server-side text input.
 * Port of the design's parseFloat(raw.replace(/[^0-9.]/g, '')) || 0 with exact decimal rounding:
 * everything except digits and dots is dropped (so a minus sign is ignored), parsing stops at the second dot
 * ("1.2.3" is 1.20), a third decimal rounds half-up ("1.005" is 1.01), and empty input is 0.
 */
export function parseMoneyToCents(raw: string): number {
  const cleaned = String(raw ?? '').replace(/[^0-9.]/g, '')
  const m = /^(\d*)(?:\.(\d*))?/.exec(cleaned)
  const whole = (m?.[1] ?? '').replace(/^0+(?=\d)/, '')
  const frac = m?.[2] ?? ''
  const wholeNum = whole === '' ? 0 : Number(whole)
  if (!Number.isSafeInteger(wholeNum) || wholeNum * 100 > MAX_MONEY_CENTS) {
    throw new RangeError('Amount is too large')
  }
  const f2 = Number((frac + '00').slice(0, 2))
  const roundUp = (frac[2] ?? '0') >= '5' ? 1 : 0
  return wholeNum * 100 + f2 + roundUp
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function parts(cents: number): { neg: boolean; whole: string; frac: string } {
  assertSafe(cents, 'amount')
  const abs = Math.abs(cents)
  return { neg: cents < 0, whole: String(Math.floor(abs / 100)), frac: String(abs % 100).padStart(2, '0') }
}

/** Plain decimal for CSV and machine output: 123450 -> "1234.50", -250 -> "-2.50". No symbol, no grouping. */
export function formatDecimal(cents: number): string {
  const p = parts(cents)
  return `${p.neg ? '-' : ''}${p.whole}.${p.frac}`
}

/** Payments display: "$1,234.50" and "−$12.00" (U+2212 minus). */
export function formatUsd(cents: number): string {
  const p = parts(cents)
  return `${p.neg ? '−' : ''}$${group(p.whole)}.${p.frac}`
}

/** Operations display: whole dollars when the cents are zero, otherwise two decimals. */
export function formatUsdOps(cents: number): string {
  const p = parts(cents)
  const body = p.frac === '00' ? group(p.whole) : `${group(p.whole)}.${p.frac}`
  return `${p.neg ? '−' : ''}$${body}`
}
