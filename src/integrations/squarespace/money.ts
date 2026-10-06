/** Squarespace money is `{ currency, value }` with a decimal number (49.99). Oasis stores integer cents. */
export function decimalToCents(value: number | string): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) throw new Error(`not a finite money value: ${String(value)}`)
  return Math.sign(n) * Math.round(Math.abs(n) * 100) + 0
}

export function centsToDecimal(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error(`cents must be an integer: ${cents}`)
  return cents / 100
}
