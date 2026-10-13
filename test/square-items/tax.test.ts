// The tax check of the Square item library (ADR 0172 section 5, ADR 0173 T8): Square's percentage compared with Oasis's rate as exact
// decimals; auto adopts the one matching tax, creates one when the shop has none, blocks otherwise; adopt and create modes; Oasis's
// own tax follows Oasis's rate; the custom-amount and rounding warnings; the half-even vs half-up vectors at 7%, 663 bp and 6.625%;
// and the CalculateOrder rounding sample against the simulator.
import { describe, expect, it } from 'vitest'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SquareSimApi, SquareSimStore, simFetch } from '../../src/integrations/square/sim/index.js'
import type { WireCatalogObject } from '../../src/integrations/square/wire.js'
import { checkItemsTax, decideTax, roundingCheck, squarePercent, squarePercentDbp, type TaxCheckInput } from '../../src/modules/catalog/square/tax.js'
import { FixedClock } from '../../src/platform/clock.js'
import { salesTaxCents } from '../../src/platform/money.js'

const LOC = 'LTAX0001'
const tax = (id: string, o: { name?: string; percentage?: string; inclusion?: string; phase?: string; enabled?: boolean; at?: string[] | 'all'; custom?: boolean } = {}): WireCatalogObject => ({
  type: 'TAX',
  id,
  ...(o.at === undefined || o.at === 'all' ? { present_at_all_locations: true } : { present_at_all_locations: false, present_at_location_ids: o.at }),
  tax_data: {
    name: o.name ?? 'Sales tax',
    percentage: o.percentage ?? '6.625',
    inclusion_type: o.inclusion ?? 'ADDITIVE',
    calculation_phase: o.phase ?? 'TAX_SUBTOTAL_PHASE',
    enabled: o.enabled ?? true,
    applies_to_custom_amounts: o.custom ?? false,
  },
})
const input = (o: Partial<TaxCheckInput> = {}): TaxCheckInput => ({ locationId: LOC, rateDbp: 6625, rounding: 'half_even', mode: 'auto', chosenTaxId: null, ownTaxId: null, ...o })

describe('percentages as exact decimals', () => {
  it('reads Square’s percentage strings exactly (no floats; more precision than a thousandth never matches)', () => {
    expect(squarePercentDbp('6.625')).toBe(6625)
    expect(squarePercentDbp('6.6250')).toBe(6625)
    expect(squarePercentDbp('7')).toBe(7000)
    expect(squarePercentDbp('7.0')).toBe(7000)
    expect(squarePercentDbp('6.63')).toBe(6630)
    expect(squarePercentDbp('6.6251')).toBeNull()
    expect(squarePercentDbp('abc')).toBeNull()
    expect(squarePercentDbp(undefined)).toBeNull()
    expect(squarePercent(6625)).toBe('6.625')
    expect(squarePercent(7000)).toBe('7')
  })

  it('half-even (Square) against half-up at 7%, 663 bp and 6.625%: whole-dollar 7% always agrees; 6.625% differs on $4 + $16k', () => {
    const he = (sub: number, dbp: number) => salesTaxCents(sub, { dbp, rounding: 'half_even' })
    const hu = (sub: number, dbp: number) => salesTaxCents(sub, { dbp, rounding: 'half_up' })
    for (let d = 1; d <= 500; d++) expect(he(d * 100, 7000)).toBe(hu(d * 100, 7000))
    expect([he(10_000, 6625), hu(10_000, 6625)]).toEqual([662, 663])
    expect([he(400, 6625), hu(400, 6625)]).toEqual([26, 27])
    expect([he(5000, 6630), he(5000, 6625)]).toEqual([332, 331])
    expect([he(150, 7000), hu(150, 7000)]).toEqual([10, 11])
  })
})

describe('decideTax', () => {
  it('auto: the one matching tax is adopted (never changed); a shop without taxes gets Oasis’s own; anything else blocks', () => {
    expect(decideTax([tax('T1')], input())).toMatchObject({ status: 'ok', taxId: 'T1', own: false, percentage: '6.625', wantPercentage: '6.625' })
    expect(decideTax([], input())).toMatchObject({ status: 'create', taxId: null, detail: expect.stringMatching(/No sales tax in Square yet: the item sync will add “Sales tax” at 6.625%/) })
    const wrong = decideTax([tax('T1', { percentage: '7' })], input())
    expect(wrong).toMatchObject({ status: 'blocked', detail: expect.stringMatching(/don’t match Oasis’s 6.625%: the item sync is paused/) })
    expect(wrong.candidates).toEqual([{ id: 'T1', name: 'Sales tax', percentage: '7', matches: false, problem: '7%, not 6.625%' }])
    expect(decideTax([tax('T1'), tax('T2', { name: 'NJ' })], input())).toMatchObject({ status: 'blocked', detail: expect.stringMatching(/Several Square taxes are 6.625%/) })
    // only what applies at our location, enabled, added to the price, on the subtotal counts
    expect(decideTax([tax('T1'), tax('X1', { at: ['LOTHER'] }), tax('X2', { enabled: false })], input())).toMatchObject({ status: 'ok', taxId: 'T1' })
    expect(decideTax([tax('T1', { inclusion: 'INCLUSIVE' })], input()).candidates[0]!.problem).toBe('included in the price, not added to it')
    expect(decideTax([tax('T1', { phase: 'TAX_TOTAL_PHASE' })], input()).candidates[0]!.problem).toBe('computed on the total, not the subtotal')
    expect(decideTax([tax('T1', { percentage: '6.63' })], input()).status).toBe('blocked')
    // Oasis's own tax wins and follows Oasis's rate
    const own = decideTax([tax('OWN', { percentage: '7' }), tax('T9', { percentage: '8' })], input({ ownTaxId: 'OWN' }))
    expect(own).toMatchObject({ status: 'ok', taxId: 'OWN', own: true, percentage: '7', detail: expect.stringMatching(/the next sync sets it to 6.625%/) })
  })

  it('adopt mode needs the picked tax to match; create mode always uses Oasis’s own', () => {
    expect(decideTax([tax('T1'), tax('T2')], input({ mode: 'adopt', chosenTaxId: 'T2' }))).toMatchObject({ status: 'ok', taxId: 'T2' })
    expect(decideTax([tax('T1', { percentage: '7' })], input({ mode: 'adopt', chosenTaxId: 'T1' }))).toMatchObject({ status: 'blocked' })
    expect(decideTax([], input({ mode: 'adopt', chosenTaxId: 'GONE' }))).toMatchObject({ status: 'blocked', detail: expect.stringMatching(/no longer exists/) })
    expect(decideTax([tax('T1')], input({ mode: 'create' }))).toMatchObject({ status: 'create' })
    expect(decideTax([tax('T1'), tax('OWN')], input({ mode: 'create', ownTaxId: 'OWN' }))).toMatchObject({ status: 'ok', taxId: 'OWN', own: true })
  })

  it('warns about a tax Square also adds to custom amounts, and about half-up rounding before the rollout', () => {
    expect(decideTax([tax('T1', { custom: true })], input()).warnings.join(' ')).toMatch(/custom amounts: an Oasis total rung up as a custom amount would be taxed twice/)
    expect(decideTax([tax('T1')], input()).warnings).toEqual([])
    expect(decideTax([tax('T1', { percentage: '7' })], input({ rateDbp: 7000, rounding: 'half_up' })).warnings.join(' ')).toMatch(/half up and Square rounds half to even/)
  })
})

describe('against the simulator', () => {
  const rig = () => {
    const store = new SquareSimStore(new FixedClock('2026-10-13T14:00:00Z'), { locationId: LOC })
    const sim = new SquareSimApi(store, { tokens: ['t-tax-00001'] })
    return createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 't-tax-00001', fetch: simFetch(sim), sleeper: { sleep: async () => undefined }, maxAttempts: 1 }))
  }

  it('reads the taxes (read-only, allowed watch-only) and an unreachable Square is status error', async () => {
    const api = rig()
    expect((await checkItemsTax(api, input())).status).toBe('create')
    const broken = createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 'nope-nope', fetch: async () => new Response('', { status: 503 }), maxAttempts: 1, writesEnabled: false }))
    expect(await checkItemsTax(broken, input())).toMatchObject({ status: 'error', detail: 'Square did not answer the tax check' })
  })

  it('the rounding sample: every total matches with half to even; half-up at 6.625% differs by a cent on $4 + $16k', async () => {
    const api = rig()
    const prices = [400, 2000, 4000, 10_000, 12_900]
    expect(await roundingCheck(api, { locationId: LOC, percentage: '6.625', rateDbp: 6625, rounding: 'half_even', prices })).toEqual({ checked: 6, differ: 0, detail: 'all 6 sample totals match Square to the cent' })
    const up = await roundingCheck(api, { locationId: LOC, percentage: '6.625', rateDbp: 6625, rounding: 'half_up', prices })
    expect(up.differ).toBe(3) // $4, $20 and $100 end in exactly half a cent with an odd cent below
    expect(up.detail).toMatch(/3 of 6 sample totals differ by a cent/)
  })
})
