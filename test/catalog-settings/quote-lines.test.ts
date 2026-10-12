// Wave Q2 (ADR 0170): an inclusion covers every line of a visit it names while it can (every_visit and unlimited ones always,
// per_cycle ones while credits last): one redeem per covered line (review F4: "Wax and rain repellent every wash" covers both).
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

describe('quoteVisit: an inclusion covers every line it names while it can', () => {
  it('an every-visit inclusion naming two add-ons covers both; an unlimited one covers the wash', () => {
    const q = quoteVisit(
      book,
      { packageId: 'wash', addonIds: ['wax', 'tires'], classKey: 'compact_car' },
      member([
        { id: 'all', label: 'Everything', mode: 'per_cycle', left: null, autoApply: true, serviceIds: ['wash'] },
        { id: 'ev', label: 'Wax and tires every wash', mode: 'every_visit', left: null, autoApply: true, serviceIds: ['wax', 'tires'] },
      ]),
    )
    expect(q.lines.map((l) => l.coverage?.inclusionId ?? null)).toEqual(['all', 'ev', 'ev'])
    expect(q.totals).toMatchObject({ coveredCents: 8000, dueCents: 0 })
  })

  it('an unlimited inclusion naming the wash and an add-on covers both lines', () => {
    const q = quoteVisit(
      book,
      { packageId: 'wash', addonIds: ['wax', 'tires'], classKey: 'compact_car' },
      member([{ id: 'all', label: 'Everything', mode: 'per_cycle', left: null, autoApply: true, serviceIds: ['wash', 'wax'] }]),
    )
    expect(q.lines.map((l) => l.coverage?.inclusionId ?? null)).toEqual(['all', 'all', null])
    expect(q.totals).toMatchObject({ coveredCents: 7000, dueCents: 1000 })
  })

  it('a per-cycle inclusion covers lines while its credits last: two credits, three named lines', () => {
    const q = quoteVisit(
      book,
      { packageId: 'wash', addonIds: ['wax', 'tires'], classKey: 'compact_car' },
      member([{ id: 'x', label: 'Two extras', mode: 'per_cycle', left: 2, autoApply: true, serviceIds: ['wash', 'wax', 'tires'] }]),
    )
    expect(q.lines.map((l) => l.coverage?.inclusionId ?? null)).toEqual(['x', 'x', null])
  })
})
