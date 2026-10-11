// The one pricing rule of the catalog (ADR 0160): member price, guest = member + markup rounded half up to whole dollars (the
// website's Math.round(m * 1.2)), explicit prices win, tint packages priced by their film's matrix row.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { effectivePrices, guestPriceOf, memberPriceOf, tintFilmOf, tintFromPrices, withMarkup } from '../../src/modules/catalog/pricing.js'
import { WEBSITE_TINT_MATRIX } from '../../db/seeds/website-catalog.js'

describe('withMarkup', () => {
  it('matches the website’s g(m) = Math.round(m * 1.2) on every dollar price it shows', () => {
    for (const m of [45, 32, 39, 35, 59, 12, 25, 30, 60, 149, 249, 229, 279, 269, 329, 249, 299, 379, 449, 429, 529, 399, 479])
      expect(withMarkup(m * 100, 20), `$${m}`).toBe(Math.round(m * 1.2) * 100)
  })

  it('rounds half up to whole dollars for any markup and never loses money to floating point', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 200 }), (cents, pct) => {
        const out = withMarkup(cents, pct)
        expect(out % 100).toBe(0)
        const exact = (cents * (100 + pct)) / 100
        expect(Math.abs(out - exact)).toBeLessThanOrEqual(50)
        expect(out).toBeGreaterThanOrEqual(Math.floor(exact / 100) * 100)
      }),
    )
    expect(withMarkup(1250, 20)).toBe(1500) // $15.00 exactly
    expect(withMarkup(1249, 20)).toBe(1500) // $14.988 → $15
    expect(withMarkup(1245, 20)).toBe(1500) // $14.94 → $15
    expect(withMarkup(1237, 20)).toBe(1500) // $14.844 → $15
    expect(withMarkup(1229, 20)).toBe(1500) // $14.748 → $15
    expect(withMarkup(1204, 20)).toBe(1400) // $14.448 → $14
  })
})

describe('member, guest and effective prices', () => {
  const s = (o: Partial<{ priceCents: number; memberPriceCents: number | null; guestPriceCents: number | null; category: string; tags: string[] }> = {}) => ({
    priceCents: 5400,
    memberPriceCents: null,
    guestPriceCents: null,
    category: 'wash',
    tags: [],
    ...o,
  })

  it('falls back member → plain price, guest → member + markup; explicit prices win', () => {
    expect(memberPriceOf(s())).toBe(5400)
    expect(memberPriceOf(s({ memberPriceCents: 4500 }))).toBe(4500)
    expect(guestPriceOf(s({ memberPriceCents: 4500 }), 20)).toBe(5400)
    expect(guestPriceOf(s({ memberPriceCents: 4500, guestPriceCents: 5000 }), 20)).toBe(5000)
    expect(effectivePrices(s({ memberPriceCents: 4500 }), { markupPct: 0, tint: WEBSITE_TINT_MATRIX })).toEqual({
      memberPriceCents: 4500,
      guestPriceCents: 4500,
      tintFilm: null,
    })
  })

  it('prices a tint package by its film’s lowest matrix prices; without a known film it is an ordinary item', () => {
    const tint = s({ category: 'tint', tags: ['tint', 'ceramic'], priceCents: 1 })
    expect(tintFilmOf(tint, WEBSITE_TINT_MATRIX)).toBe('ceramic')
    expect(tintFromPrices(WEBSITE_TINT_MATRIX, 'carbon')).toEqual({ memberCents: 22900, guestCents: 27500 })
    expect(effectivePrices(tint, { markupPct: 20, tint: WEBSITE_TINT_MATRIX })).toEqual({
      memberPriceCents: 37900,
      guestPriceCents: 45500,
      tintFilm: 'ceramic',
    })
    // a film tag outside the tint category does not count; an unknown film falls back
    expect(tintFilmOf(s({ tags: ['ceramic'] }), WEBSITE_TINT_MATRIX)).toBeNull()
    expect(effectivePrices(s({ category: 'tint', tags: ['ppf'], memberPriceCents: 10000 }), { markupPct: 20, tint: WEBSITE_TINT_MATRIX })).toEqual({
      memberPriceCents: 10000,
      guestPriceCents: 12000,
      tintFilm: null,
    })
    expect(tintFromPrices({ ...WEBSITE_TINT_MATRIX, prices: [] }, 'carbon')).toBeNull()
  })
})
