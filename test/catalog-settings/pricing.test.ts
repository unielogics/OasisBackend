// The price book (ADR 0170): the price at a vehicle size (the size's cell; the first size's when no size is known; the starting price
// when the size has none; the base price without any size price), the member price (whole dollars, half up, never above the price),
// coverage up to the plan size's price with the size difference due (no % off on it, nor on a covered line), every-visit inclusions,
// credits spent line by line in a whole-visit quote, and the starting prices of services and tiers.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  classPrice,
  coveringInclusion,
  fromPrice,
  memberCents,
  memberFromPrice,
  missingCells,
  priceLine,
  quoteVisit,
  tierFromPrice,
  type BookCell,
  type MemberContext,
  type PriceBook,
} from '../../src/modules/catalog/price-book.js'

const CLASSES = [
  { key: 'compact_car', label: 'Compact car', sort: 10 },
  { key: 'large_car', label: 'Large car', sort: 20 },
  { key: 'compact_suv', label: 'Compact SUV', sort: 30 },
  { key: 'large_suv', label: 'Large SUV', sort: 40 },
  { key: 'truck', label: 'Truck', sort: 50 },
]

const svc = (id: string, priceCents: number, kind: 'package' | 'addon' = 'package') => ({
  id,
  kind,
  name: id,
  priceCents,
  category: kind === 'addon' ? 'addons' : 'wash',
  tags: [],
  active: true,
  quoteOnly: false,
})

function book(cells: Record<string, Record<string, number | [number, number]>>, o: { off?: string[] } = {}): PriceBook {
  const services = new Map(
    ['wash', 'wax', 'tint', 'bare', 'engine', 'leather'].map((id) => [id, svc(id, id === 'bare' ? 2500 : 999, id === 'wash' || id === 'tint' || id === 'bare' ? 'package' : 'addon')]),
  )
  return {
    classes: CLASSES.filter((c) => !(o.off ?? []).includes(c.key)),
    labels: new Map(CLASSES.map((c) => [c.key, c.label])),
    services,
    cells: new Map(
      Object.entries(cells).map(([id, row]) => [
        id,
        new Map(
          Object.entries(row).map(([k, v]): [string, BookCell] => [k, Array.isArray(v) ? { cents: v[0], maxCents: v[1] } : { cents: v, maxCents: null }]),
        ),
      ]),
    ),
    tintFilms: [],
  }
}

const B = book({
  wash: { compact_car: 4000, large_car: 5000, large_suv: 6000 },
  wax: { compact_car: 3900, truck: 4900 },
  tint: { compact_car: [22900, 27900], compact_suv: [26900, 32900] },
  engine: { compact_car: 4500 },
})

const member = (o: Partial<MemberContext> = {}): MemberContext => ({
  membershipId: 'm1',
  holderId: 'c1',
  viaHousehold: false,
  planId: 'p1',
  tierKey: 'gold',
  tierName: 'Gold',
  discountBp: 1000,
  planClass: 'compact_car',
  vipBooking: false,
  inclusions: [{ id: 'i-wash', label: 'Hand wash', mode: 'per_cycle', left: 2, autoApply: true, serviceIds: ['wash'] }],
  ...o,
})

describe('memberCents: price x (1 - %), whole dollars half up', () => {
  it('rounds half up to whole dollars and never goes above the price', () => {
    expect(memberCents(4000, 1000)).toBe(3600)
    expect(memberCents(4500, 1000)).toBe(4100) // $40.50 -> $41
    expect(memberCents(4450, 1000)).toBe(4000) // $40.05 -> $40
    expect(memberCents(2999, 1500)).toBe(2500) // $25.49 -> $25
    expect(memberCents(3000, 1500)).toBe(2600) // $25.50 -> $26
    expect(memberCents(50, 100)).toBe(0) // $0.495 -> $0
    expect(memberCents(4000, 10_000)).toBe(0)
  })

  it('0% off is the price itself, cents included (no rounding without a discount)', () => {
    expect(memberCents(4050, 0)).toBe(4050)
  })

  it('is whole dollars and within half a dollar of the exact figure for every price and %', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 9_999 }), (cents, bp) => {
        const out = memberCents(cents, bp)
        const exact = (cents * (10_000 - bp)) / 10_000
        expect(out).toBeLessThanOrEqual(cents)
        if (out < cents) {
          expect(out % 100).toBe(0)
          expect(Math.abs(out - exact)).toBeLessThanOrEqual(50)
        }
      }),
    )
  })
})

describe('classPrice: the price at a size', () => {
  it('is the size’s own cell (basis class), with the “up to” price of a range', () => {
    expect(classPrice(B, 'wash', 'large_car')).toEqual({ cents: 5000, maxCents: null, basis: 'class', classKey: 'large_car', classLabel: 'Large car' })
    expect(classPrice(B, 'tint', 'compact_suv')).toMatchObject({ cents: 26900, maxCents: 32900, basis: 'class' })
  })

  it('no size known, or one that is unknown or turned off: the first active size’s cell (unknown_class)', () => {
    expect(classPrice(B, 'wash', null)).toEqual({ cents: 4000, maxCents: null, basis: 'unknown_class', classKey: null, classLabel: null })
    expect(classPrice(B, 'wash', 'limo')).toMatchObject({ cents: 4000, basis: 'unknown_class', classKey: null })
    const off = book({ wash: { compact_car: 4000, large_car: 5000 } }, { off: ['large_car'] })
    expect(classPrice(off, 'wash', 'large_car')).toMatchObject({ cents: 4000, basis: 'unknown_class' })
  })

  it('no size known and the first size has no price: the starting price (still unknown_class)', () => {
    expect(classPrice(B, 'wax', null)).toMatchObject({ cents: 3900, basis: 'unknown_class' })
    const b = book({ wash: { large_car: 5000, truck: 4500 } })
    expect(classPrice(b, 'wash', null)).toMatchObject({ cents: 4500, basis: 'unknown_class' })
  })

  it('a known size without a price: the starting price, flagged estimated (confirm at the shop)', () => {
    expect(classPrice(B, 'wash', 'truck')).toEqual({ cents: 4000, maxCents: null, basis: 'estimated', classKey: 'truck', classLabel: 'Truck' })
    expect(classPrice(B, 'tint', 'large_suv')).toMatchObject({ cents: 22900, maxCents: 27900, basis: 'estimated' })
  })

  it('a service without any price by size: its base price (basis base), whatever the size', () => {
    expect(classPrice(B, 'bare', 'large_suv')).toEqual({ cents: 2500, maxCents: null, basis: 'base', classKey: 'large_suv', classLabel: 'Large SUV' })
    expect(classPrice(B, 'bare', null)).toMatchObject({ cents: 2500, basis: 'base', classKey: null })
    // prices only on sizes that are off count as none
    const off = book({ bare: { truck: 9900 } }, { off: ['truck'] })
    expect(classPrice(off, 'bare', 'compact_car')).toMatchObject({ cents: 2500, basis: 'base' })
  })

  it('starting prices: the lowest cell over the active sizes; missing cells counted', () => {
    expect(fromPrice(B, 'wash')).toEqual({ cents: 4000, maxCents: null, classKey: 'compact_car', classLabel: 'Compact car', basis: 'class' })
    expect(fromPrice(B, 'bare')).toMatchObject({ cents: 2500, basis: 'base', classKey: null })
    expect(memberFromPrice(B, 'wash', 1000)).toBe(3600)
    expect(missingCells(B, 'wash')).toBe(2)
    expect(missingCells(B, 'bare')).toBe(5)
    expect(tierFromPrice(B, [{ classKey: 'large_car', monthlyCents: 14900 }, { classKey: 'compact_car', monthlyCents: 12900 }])).toEqual({
      monthlyCents: 12900,
      classKey: 'compact_car',
      classLabel: 'Compact car',
    })
    expect(tierFromPrice(B, [])).toBeNull()
    expect(tierFromPrice(book({}, { off: ['compact_car'] }), [{ classKey: 'compact_car', monthlyCents: 12900 }])).toBeNull()
  })
})

describe('priceLine: a guest, a member, a covered line', () => {
  it('a guest pays the regular price at the size', () => {
    expect(priceLine(B, { serviceId: 'wash' }, 'large_suv', null)).toEqual({
      serviceId: 'wash',
      listCents: 6000,
      listMaxCents: null,
      memberDiscountCents: 0,
      chargeCents: 6000,
      discountBp: 0,
      basis: 'class',
      classKey: 'large_suv',
      classLabel: 'Large SUV',
      coverage: null,
      dueCents: 6000,
    })
  })

  it('a member pays the member price on a line no inclusion covers', () => {
    const l = priceLine(B, { serviceId: 'wax' }, 'truck', member())
    expect(l).toMatchObject({ listCents: 4900, chargeCents: 4400, memberDiscountCents: 500, discountBp: 1000, coverage: null, dueCents: 4400 })
    // 0% off: no discount recorded
    expect(priceLine(B, { serviceId: 'wax' }, 'truck', member({ discountBp: 0 }))).toMatchObject({ chargeCents: 4900, discountBp: 0, memberDiscountCents: 0 })
  })

  it('a covered line: a car the plan size or smaller is fully covered', () => {
    expect(priceLine(B, { serviceId: 'wash' }, 'compact_car', member())).toMatchObject({
      listCents: 4000,
      chargeCents: 4000,
      discountBp: 0,
      coverage: { inclusionId: 'i-wash', label: 'Hand wash', coveredCents: 4000, differenceCents: 0, planClass: 'compact_car' },
      dueCents: 0,
    })
    // a smaller car than a Large car plan: its own (lower) price is covered in full
    expect(priceLine(B, { serviceId: 'wash' }, 'compact_car', member({ planClass: 'large_car' }))).toMatchObject({
      coverage: { coveredCents: 4000, differenceCents: 0 },
      dueCents: 0,
    })
  })

  it('a larger car than the plan size: covered up to the plan size’s price, the difference due with no % off', () => {
    const l = priceLine(B, { serviceId: 'wash' }, 'large_suv', member({ discountBp: 2500 }))
    expect(l).toMatchObject({
      listCents: 6000,
      chargeCents: 6000,
      memberDiscountCents: 0,
      discountBp: 0,
      coverage: { coveredCents: 4000, differenceCents: 2000, planClass: 'compact_car' },
      dueCents: 2000,
    })
  })

  it('the plan size without a price of its own is covered at the starting price (rule 1)', () => {
    const l = priceLine(B, { serviceId: 'wash' }, 'large_suv', member({ planClass: 'truck' }))
    expect(l.coverage).toMatchObject({ coveredCents: 4000, differenceCents: 2000 })
  })

  it('a plan size turned off later still covers at that size’s own price (members keep the size they pay for)', () => {
    const off = book({ wash: { compact_car: 4000, large_car: 5000, large_suv: 6000 } }, { off: ['large_suv'] })
    // a Large car on a Large SUV plan: $50 is within the $60 plan-size price, fully covered
    expect(priceLine(off, { serviceId: 'wash' }, 'large_car', member({ planClass: 'large_suv' }))).toMatchObject({
      coverage: { coveredCents: 5000, differenceCents: 0, planClass: 'large_suv' },
      dueCents: 0,
    })
    // a turned-off plan size without a price of its own: rule 1 as before
    const bare = book({ wash: { compact_car: 4000, large_car: 5000 } }, { off: ['large_suv'] })
    expect(priceLine(bare, { serviceId: 'wash' }, 'large_car', member({ planClass: 'large_suv' })).coverage).toMatchObject({
      coveredCents: 4000,
      differenceCents: 1000,
    })
  })

  it('no credit left: the line is not covered and gets the member price', () => {
    const m = member({ inclusions: [{ id: 'i-wash', label: 'Hand wash', mode: 'per_cycle', left: 0, autoApply: true, serviceIds: ['wash'] }] })
    expect(priceLine(B, { serviceId: 'wash' }, 'large_car', m)).toMatchObject({ chargeCents: 4500, coverage: null, dueCents: 4500 })
  })

  it('unlimited and every_visit inclusions always cover', () => {
    const m = member({
      inclusions: [
        { id: 'i-u', label: 'Unlimited washes', mode: 'per_cycle', left: null, autoApply: true, serviceIds: ['wash'] },
        { id: 'i-e', label: 'Wax every wash', mode: 'every_visit', left: null, autoApply: true, serviceIds: ['wax'] },
      ],
    })
    expect(coveringInclusion(m, 'wash')?.id).toBe('i-u')
    expect(coveringInclusion(m, 'wax')?.id).toBe('i-e')
    expect(priceLine(B, { serviceId: 'wax' }, 'truck', m)).toMatchObject({ coverage: { inclusionId: 'i-e', coveredCents: 3900, differenceCents: 1000 }, dueCents: 1000 })
  })

  it('an explicit inclusion of null prices the line without coverage', () => {
    expect(priceLine(B, { serviceId: 'wash' }, 'compact_car', member(), { inclusion: null })).toMatchObject({ coverage: null, chargeCents: 3600 })
  })
})

describe('quoteVisit: a whole visit', () => {
  it('spends one credit per covered line, prices the rest at the member price, and sums the totals', () => {
    const m = member({
      inclusions: [
        { id: 'i-wash', label: 'Hand wash', mode: 'per_cycle', left: 1, autoApply: true, serviceIds: ['wash', 'engine'] },
        { id: 'i-e', label: 'Wax every wash', mode: 'every_visit', left: null, autoApply: true, serviceIds: ['wax'] },
      ],
    })
    const q = quoteVisit(B, { packageId: 'wash', addonIds: ['wax', 'engine'], classKey: 'large_car' }, m)
    expect(q.lines.map((l) => [l.serviceId, l.coverage?.inclusionId ?? null, l.chargeCents, l.dueCents])).toEqual([
      ['wash', 'i-wash', 5000, 1000], // covered up to $40, $10 size difference
      ['wax', 'i-e', 3900, 0], // large_car has no wax price: the starting price, covered in full
      ['engine', null, 4100, 4100], // the one credit is spent: member price ($45 less 10% = $40.50 -> $41)
    ])
    expect(q.totals).toEqual({ listCents: 5000 + 3900 + 4500, discountCents: 400, coveredCents: 4000 + 3900, dueCents: 1000 + 4100 })
  })

  it('a guest pays the list prices', () => {
    const q = quoteVisit(B, { packageId: 'wash', addonIds: ['wax'], classKey: 'truck' }, null)
    expect(q.lines.map((l) => [l.basis, l.chargeCents])).toEqual([
      ['estimated', 4000],
      ['class', 4900],
    ])
    expect(q.totals).toEqual({ listCents: 8900, discountCents: 0, coveredCents: 0, dueCents: 8900 })
  })

  it('never charges more than the list price, and due never exceeds the charge (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, 'compact_car', 'large_car', 'compact_suv', 'large_suv', 'truck', 'limo'),
        fc.constantFrom('compact_car', 'large_suv', 'truck'),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 3 }),
        (cls, plan, bp, left) => {
          const m = member({
            planClass: plan,
            discountBp: bp,
            inclusions: [{ id: 'i', label: 'x', mode: 'per_cycle', left, autoApply: true, serviceIds: ['wash', 'wax'] }],
          })
          const q = quoteVisit(B, { packageId: 'wash', addonIds: ['wax', 'engine', 'tint'], classKey: cls }, m)
          for (const l of q.lines) {
            expect(l.chargeCents).toBeLessThanOrEqual(l.listCents)
            expect(l.dueCents).toBeLessThanOrEqual(l.chargeCents)
            expect(l.dueCents).toBeGreaterThanOrEqual(0)
            if (l.coverage) expect(l.coverage.coveredCents + l.coverage.differenceCents).toBe(l.listCents)
          }
          expect(q.lines.filter((l) => l.coverage).length).toBeLessThanOrEqual(left)
        },
      ),
    )
  })
})
