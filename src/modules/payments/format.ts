// Display helpers shared by the Payments read models. The API ships cents; these only build the few strings the design
// derives server side (limit text in guard errors, the pending banner) so they read exactly as the design's.
import { formatUsd } from '../../platform/money.js'

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** The design's money0: whole dollars (half-up on the absolute value) with a U+2212 minus. 123456 -> "$1,235". */
export function money0(cents: number): string {
  const abs = Math.abs(cents)
  const dollars = Math.floor((abs + 50) / 100)
  return `${cents < 0 && dollars !== 0 ? '−' : ''}$${group(String(dollars))}`
}

export const money = formatUsd

/** "no limit" or "$1,000 limit" (the design's limTxt). */
export const limitText = (limitCents: number | null): string =>
  limitCents === null ? 'no limit' : `${money0(limitCents)} limit`

/** "Chloe Bennett" -> "Chloe". */
export const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? full

/** "INV-20603": the number zero-padded to at least five digits. */
export const invoiceLabel = (no: number): string => `INV-${String(no).padStart(5, '0')}`

export function pendingBannerText(
  count: number,
  amountCents: number,
  client: string,
  requestedBy: string,
): string {
  const noun = count === 1 ? 'refund' : 'refunds'
  return `${count} ${noun} awaiting approval — ${formatUsd(amountCents)} · ${client} · requested by ${requestedBy}`
}
