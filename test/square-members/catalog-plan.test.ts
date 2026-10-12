// The pure rules of the memberships on Square (ADR 0171 wave Q3b): the catalog diff planner (a plan per tier, a variation per
// current price row, never a change in place, never a delete of a variation in use, drift reported), the paid period in shop-local
// midnights, Square's status as the membership's, Square's scheduled actions, the failure timeline (0 / 7 / 21) and the deliverable
// email rule.
import { describe, expect, it } from 'vitest'
import { planCatalogChanges, remoteOf, variationName, type CatalogPriceRow, type CatalogTier } from '../../src/modules/memberships/square/catalog-plan.js'
import {
  deliverableEmail,
  failureStage,
  paidPeriod,
  scheduledAtSquare,
  shopDaysBetween,
  shopMidnight,
  statusFromSquare,
} from '../../src/modules/memberships/square/policy.js'

const TZ = 'America/New_York'
const gold: CatalogTier = { planId: 'p-gold', key: 'gold', name: 'Gold', active: true, squarePlanId: null }
const row = (o: Partial<CatalogPriceRow> & { id: string }): CatalogPriceRow => ({
  planId: 'p-gold',
  classKey: 'compact_car',
  classLabel: 'Compact car',
  monthlyCents: 12900,
  current: true,
  squareVariationId: null,
  squareState: 'pending',
  inUse: false,
  squareError: null,
  ...o,
})

describe('planCatalogChanges', () => {
  it('a tier’s first price: one plan, then one STATIC MONTHLY variation per current price row', () => {
    const plan = planCatalogChanges([gold], [row({ id: 'r1' }), row({ id: 'r2', classKey: 'truck', classLabel: 'Truck', monthlyCents: 15900 })])
    expect(plan).toEqual([
      { kind: 'create_plan', planId: 'p-gold', name: 'Gold' },
      { kind: 'create_variation', rowId: 'r1', planId: 'p-gold', squarePlanId: null, name: 'Gold · Compact car', cents: 12900 },
      { kind: 'create_variation', rowId: 'r2', planId: 'p-gold', squarePlanId: null, name: 'Gold · Truck', cents: 15900 },
    ])
    expect(variationName('Gold', 'Compact car')).toBe('Gold · Compact car')
  })

  it('synced prices need nothing; a price edit (a new row) is a new variation of the existing plan, the old row stays', () => {
    const synced = { ...gold, squarePlanId: 'SQ-PLAN' }
    const old = row({ id: 'r1', current: false, squareVariationId: 'SQ-V1', squareState: 'synced', inUse: true })
    expect(planCatalogChanges([synced], [row({ id: 'r1', squareVariationId: 'SQ-V1', squareState: 'synced' })])).toEqual([])
    expect(planCatalogChanges([synced], [old, row({ id: 'r2', monthlyCents: 13900 })])).toEqual([
      { kind: 'create_variation', rowId: 'r2', planId: 'p-gold', squarePlanId: 'SQ-PLAN', name: 'Gold · Compact car', cents: 13900 },
    ])
  })

  it('a failed row is tried again; an inactive tier and a retired row are left alone', () => {
    const synced = { ...gold, squarePlanId: 'SQ-PLAN' }
    expect(planCatalogChanges([synced], [row({ id: 'r1', squareState: 'failed', squareError: 'Square did not answer' })]).map((a) => a.kind)).toEqual(['create_variation'])
    expect(planCatalogChanges([{ ...gold, active: false }], [row({ id: 'r1' })])).toEqual([])
    expect(planCatalogChanges([synced], [row({ id: 'r1', current: false, squareVariationId: 'V', squareState: 'retired' })])).toEqual([])
  })

  it('a superseded price nobody uses is retired; one a membership or enrollment uses never is, nor one Square already kept', () => {
    const synced = { ...gold, squarePlanId: 'SQ-PLAN' }
    const unused = row({ id: 'r1', current: false, squareVariationId: 'SQ-V1', squareState: 'synced' })
    expect(planCatalogChanges([synced], [unused])).toEqual([{ kind: 'retire_variation', rowId: 'r1', squareVariationId: 'SQ-V1' }])
    expect(planCatalogChanges([synced], [{ ...unused, inUse: true }])).toEqual([])
    expect(planCatalogChanges([synced], [{ ...unused, squareError: 'Square keeps it: a subscription used it' }])).toEqual([])
  })

  it('drift: Square’s copy is compared, reported, never overwritten', () => {
    const synced = { ...gold, squarePlanId: 'SQ-PLAN' }
    const rows = [
      row({ id: 'r1', squareVariationId: 'V1', squareState: 'synced', inUse: true }),
      row({ id: 'r2', classKey: 'truck', classLabel: 'Truck', squareVariationId: 'V2', squareState: 'synced' }),
      row({ id: 'r3', classKey: 'large_suv', classLabel: 'Large SUV', squareVariationId: 'V3', squareState: 'synced', inUse: true }),
      row({ id: 'r4', classKey: 'large_car', classLabel: 'Large car', squareVariationId: 'V4', squareState: 'synced' }),
    ]
    const remote = remoteOf([
      { type: 'SUBSCRIPTION_PLAN', id: 'SQ-PLAN', version: 7, subscription_plan_data: { name: 'Gold (old name)' } },
      { type: 'SUBSCRIPTION_PLAN_VARIATION', id: 'V1', subscription_plan_variation_data: { subscription_plan_id: 'SQ-PLAN', phases: [{ cadence: 'MONTHLY', pricing: { type: 'STATIC', price_money: { amount: 9900 } } }] } },
      { type: 'SUBSCRIPTION_PLAN_VARIATION', id: 'V4', subscription_plan_variation_data: { subscription_plan_id: 'SQ-PLAN', phases: [{ cadence: 'MONTHLY', pricing: { type: 'STATIC', price_money: { amount: 12900 } } }] } },
    ])
    const plan = planCatalogChanges([synced], rows, remote)
    expect(plan).toEqual([
      { kind: 'rename_plan', planId: 'p-gold', squarePlanId: 'SQ-PLAN', name: 'Gold', version: 7 },
      { kind: 'drift', rowId: 'r1', detail: 'Square bills this price at $99.00, not $129.00 a month' },
      { kind: 'recreate', rowId: 'r2', detail: 'Square no longer has this price: it is made again' },
      { kind: 'drift', rowId: 'r3', detail: 'Square no longer has this price, but members are billed at it' },
    ])
  })
})

describe('the billing rules', () => {
  it('a paid period runs from the due date to the charged-through date, in shop-local midnights', () => {
    expect(paidPeriod({ dueDate: '2026-06-13', startDate: '2026-06-13', chargedThrough: '2026-07-13' }, TZ)).toEqual({
      start: new Date('2026-06-13T04:00:00Z'),
      end: new Date('2026-07-13T04:00:00Z'),
    })
    // a month-end anchor: Square's date wins when it is the next billing date
    expect(paidPeriod({ dueDate: '2026-01-31', startDate: null, chargedThrough: '2026-03-03' }, TZ).end).toEqual(new Date('2026-03-03T05:00:00Z'))
    // a charged-through date of a later cycle (an old invoice read late) or none: one calendar month
    expect(paidPeriod({ dueDate: '2026-06-13', startDate: null, chargedThrough: '2026-08-13' }, TZ).end).toEqual(new Date('2026-07-13T04:00:00Z'))
    expect(paidPeriod({ dueDate: null, startDate: '2026-11-01', chargedThrough: null }, TZ)).toEqual({
      start: new Date('2026-11-01T04:00:00Z'),
      end: new Date('2026-12-01T05:00:00Z'),
    })
    expect(shopMidnight('2026-11-01', TZ)).toEqual(new Date('2026-11-01T04:00:00Z'))
  })

  it('Square’s status as the membership’s', () => {
    expect(statusFromSquare('PAUSED', 'active')).toBe('paused')
    expect(statusFromSquare('CANCELED', 'past_due')).toBe('canceled')
    expect(statusFromSquare('DEACTIVATED', 'active')).toBe('canceled')
    expect(statusFromSquare('ACTIVE', 'paused')).toBe('active')
    expect(statusFromSquare('ACTIVE', 'past_due')).toBe('past_due')
    expect(statusFromSquare('ACTIVE', 'canceled')).toBe('canceled')
    expect(statusFromSquare('PENDING', 'pending')).toBe('pending')
  })

  it('what Square scheduled for the next billing date', () => {
    expect(
      scheduledAtSquare({
        status: 'ACTIVE',
        canceled_date: null,
        actions: [
          { id: 'a1', type: 'PAUSE', effective_date: '2026-07-13' },
          { id: 'a2', type: 'SWAP_PLAN', effective_date: '2026-07-13', new_plan_variation_id: 'V2' },
        ],
      }),
    ).toEqual({ cancelAt: null, pauseAt: '2026-07-13', swap: { actionId: 'a2', variationId: 'V2', date: '2026-07-13' } })
    expect(scheduledAtSquare({ status: 'ACTIVE', canceled_date: '2026-07-13', actions: [] }).cancelAt).toBe('2026-07-13')
    expect(scheduledAtSquare({ status: 'CANCELED', canceled_date: '2026-07-13', actions: [] })).toEqual({ cancelAt: null, pauseAt: null, swap: null })
  })

  it('the failure timeline counts shop-local days: grace 0 to 6, past due 7 to 20, canceled from 21', () => {
    const failed = new Date('2026-06-13T22:30:00-04:00')
    const on = (d: string) => failureStage(failed, new Date(`${d}T09:30:00-04:00`), TZ)
    expect(on('2026-06-13')).toBe('grace')
    expect(on('2026-06-19')).toBe('grace')
    expect(on('2026-06-20')).toBe('past_due')
    expect(on('2026-07-03')).toBe('past_due')
    expect(on('2026-07-04')).toBe('cancel')
    expect(failureStage(failed, new Date('2026-06-15T09:30:00-04:00'), TZ, { graceDays: 2, cancelDays: 3 })).toBe('past_due')
    expect(failureStage(failed, new Date('2026-06-16T09:30:00-04:00'), TZ, { graceDays: 2, cancelDays: 3 })).toBe('cancel')
    expect(shopDaysBetween(new Date('2026-06-13T23:59:00-04:00'), new Date('2026-06-14T00:01:00-04:00'), TZ)).toBe(1)
  })

  it('a deliverable email: well formed, a real-looking domain, no reserved example or test domain', () => {
    expect(deliverableEmail(' maria.delgado@gmail.com ')).toEqual({ ok: true, email: 'maria.delgado@gmail.com' })
    expect(deliverableEmail('verify-1@oasisautospanj.com').ok).toBe(true)
    for (const bad of ['maria@example.com', 'a@b.example.org', 'x@shop.test', 'x@host.invalid', 'x@mail.local', 'x@my.example'])
      expect(deliverableEmail(bad), bad).toMatchObject({ ok: false, message: 'Use an email you check: Square sends your membership receipts there.' })
    for (const bad of ['maria', 'maria@', '@gmail.com', 'ma ria@gmail.com', 'maria@gmail', 'maria@gmail..com', 'maria@gmail.c0m', 'x@localhost'])
      expect(deliverableEmail(bad), bad).toMatchObject({ ok: false })
  })
})
