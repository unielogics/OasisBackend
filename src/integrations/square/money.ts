// Square Money objects <-> integer cents. Oasis is USD only: any other currency is an error, never a conversion.
import { SquareError } from './errors.js'

export interface SquareMoney {
  amount: number
  currency: string
}

export class SquareCurrencyError extends SquareError {}

/** Integer cents (0 or more) as a USD Money object. */
export function usd(cents: number): SquareMoney {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`cents must be a non-negative safe integer, got ${String(cents)}`)
  return { amount: cents, currency: 'USD' }
}

/** A Money object as integer cents; refuses anything that is not USD (or not a whole number of cents). */
export function centsOf(m: { amount?: number | null; currency?: string | null } | null | undefined, what = 'amount'): number {
  if (!m || m.amount === null || m.amount === undefined) return 0
  if (m.currency !== 'USD') throw new SquareCurrencyError(`${what} is in ${m.currency ?? 'no currency'}; Oasis takes USD only`)
  if (!Number.isSafeInteger(m.amount)) throw new SquareCurrencyError(`${what} is not a whole number of cents`)
  return m.amount
}

/** Like centsOf, for a Money that may be absent: null instead of 0. */
export function centsOrNull(m: { amount?: number | null; currency?: string | null } | null | undefined, what = 'amount'): number | null {
  return m && m.amount !== null && m.amount !== undefined ? centsOf(m, what) : null
}
