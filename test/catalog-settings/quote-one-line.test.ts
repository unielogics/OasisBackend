// Wave Q2 (ADR 0170): an inclusion covers at most one line of a visit (one redeem per inclusion and visit, keyed
// redeem:<appointment>:<inclusion>), even when it names several of the visit's services and has credits for more.
import { describe, expect, it } from 'vitest'
import { quoteVisit, type MemberContext, type PriceBook } from '../../src/modules/catalog/price-book.js'

const svc = (id: string, kind: 'package' | 'addon') => ({ id, kind, name: id, priceCents: 0, category: 'wash', tags: [], active: true, quoteOnly: false })
const book: PriceBook = {
  classes: [{ key: 'compact_car', label: 'Compact car', sort: 10 }],
  labels: new Map([['compact_car', 'Compact car']]),
  services: new Map([
    ['wash', svc('wash', 'package')],
    ['wax', svc('wax', 'addon')],
    ['tires', svc('tires', 'addon')],
  ]),
  cells: new Map([
    ['wash', new Map([['compact_car', { cents: 4000, maxCents: null }]])],
    ['wax', new Map([['compact_car', { cents: 3000, maxCents: null }]])],
    ['tires', new Map([['compact_car', { cents: 1000, maxCents: null }]])],
  ]),
  tintFilms: [],
}
const member = (inclusions: MemberContext['inclusions']): MemberContext => ({
  membershipId: 'm',
  holderId: 'c',
  viaHousehold: false,
  planId: 'p',
  tierKey: 'gold',
  tierName: 'Gold',
  discountBp: 0,
  planClass: 'compact_car',
  vipBooking: false,
  inclusions,
})

describe('quoteVisit: one line per inclusion', () => {
  it('an unlimited inclusion naming two services of the visit covers the first; another inclusion may cover the second', () => {
    const q = quoteVisit(
      book,
      { packageId: 'wash', addonIds: ['wax', 'tires'], classKey: 'compact_car' },
      member([
        { id: 'all', label: 'Everything', mode: 'per_cycle', left: null, autoApply: true, serviceIds: ['wash', 'wax'] },
        { id: 'ev', label: 'Extras every visit', mode: 'every_visit', left: null, autoApply: true, serviceIds: ['wax', 'tires'] },
      ]),
    )
    expect(q.lines.map((l) => l.coverage?.inclusionId ?? null)).toEqual(['all', 'ev', null])
    expect(q.totals).toMatchObject({ coveredCents: 7000, dueCents: 1000 })
  })

  it('a per-cycle inclusion with three credits still covers one line of the visit', () => {
    const q = quoteVisit(
      book,
      { packageId: 'wash', addonIds: ['wax'], classKey: 'compact_car' },
      member([{ id: 'x', label: 'Hand wash', mode: 'per_cycle', left: 3, autoApply: true, serviceIds: ['wash', 'wax'] }]),
    )
    expect(q.lines.map((l) => l.coverage?.inclusionId ?? null)).toEqual(['x', null])
  })
})
