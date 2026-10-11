// What a member and a guest pay for a catalog item (ADR 0160, plan A). One rule for the website, the assistant and the dashboard:
//   member price  the service's member_price_cents, else its plain price (price_cents, what a booking charges today);
//   guest price   the service's guest_price_cents, else the member price plus catalog.guest_markup_pct, rounded half up to whole
//                 dollars (the website's own rule: Math.round(m * 1.2) on dollar prices, so $45 → $54 and $39 → $47).
// A tint package (category tint, tagged with a film of catalog.tint_matrix) is priced by the matrix instead: its "from" prices are
// the lowest member and guest prices of that film over every vehicle type.
import type { SettingValue } from '../../platform/settings.js'

export interface PricedItem {
  priceCents: number
  memberPriceCents: number | null
  guestPriceCents: number | null
}

export type TintMatrix = SettingValue<'catalog.tint_matrix'>

/** The member price plus `pct` percent, rounded half up to whole dollars (in cents). */
export function withMarkup(memberCents: number, pct: number): number {
  return Math.floor((memberCents * (100 + pct) + 5_000) / 10_000) * 100
}

export const memberPriceOf = (s: PricedItem): number => s.memberPriceCents ?? s.priceCents

export const guestPriceOf = (s: PricedItem, markupPct: number): number =>
  s.guestPriceCents ?? withMarkup(memberPriceOf(s), markupPct)

/** The film of the tint matrix a service is priced by: the first of its tags that names a film, or null. */
export function tintFilmOf(s: { category: string; tags: readonly string[] }, m: TintMatrix): string | null {
  if (s.category !== 'tint') return null
  const films = new Set(m.films.map((f) => f.key))
  return s.tags.find((t) => films.has(t)) ?? null
}

/** The lowest member and guest prices of a film over every vehicle type, or null when the matrix has no price for it. */
export function tintFromPrices(m: TintMatrix, film: string): { memberCents: number; guestCents: number } | null {
  const rows = m.prices.filter((p) => p.film === film)
  if (rows.length === 0) return null
  return {
    memberCents: Math.min(...rows.map((p) => p.memberMinCents)),
    guestCents: Math.min(...rows.map((p) => p.guestMinCents)),
  }
}

export interface EffectivePrices {
  memberPriceCents: number
  guestPriceCents: number
  /** Prices from the tint matrix ("from"): the film the item is priced by. */
  tintFilm: string | null
}

/** The prices the public, the assistant and the dashboard show for a service. */
export function effectivePrices(
  s: PricedItem & { category: string; tags: readonly string[] },
  o: { markupPct: number; tint: TintMatrix },
): EffectivePrices {
  const film = tintFilmOf(s, o.tint)
  const from = film ? tintFromPrices(o.tint, film) : null
  if (film && from) return { memberPriceCents: from.memberCents, guestPriceCents: from.guestCents, tintFilm: film }
  return { memberPriceCents: memberPriceOf(s), guestPriceCents: guestPriceOf(s, o.markupPct), tintFilm: null }
}
