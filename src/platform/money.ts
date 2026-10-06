// Integer cents only. This is the only module that does money arithmetic or formatting.
// Rounding is half-up (toward +infinity on exact halves) in integer math; floats never touch a cent value.

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

/** Tax on a subtotal at a rate in basis points (700 = 7%), half-up to the cent. */
export function taxCents(subCents: number, taxBp: number): number {
  assertSafe(subCents, 'subtotal')
  assertSafe(taxBp, 'tax rate')
  return divHalfUp(subCents * taxBp, 10_000)
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
