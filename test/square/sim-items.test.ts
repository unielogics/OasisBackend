// The simulator's item library and CalculateOrder (ADR 0172), honest to what the sandbox answered on 2026-10-13
// (docs/integrations/square.md section 14): nested variations with temp ids, Square's per-field version check (on nested variations
// too), a variation left out of an item upsert deleted, hidden variations, archive, CATEGORY (never location-scoped) and TAX,
// BatchUpsert keeping the good batches of a request that fails, batch retrieve and incremental search with deleted objects; and
// CalculateOrder rounding half to even once per tax, replaying all 200 sandbox answers of SQR-18.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SquareApiError } from '../../src/integrations/square/errors.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { SquareSimApi, SquareSimStore, simFetch } from '../../src/integrations/square/sim/index.js'
import { divHalfEvenInt, spread } from '../../src/integrations/square/sim/calculate.js'
import { FixedClock } from '../../src/platform/clock.js'
import { calculate, taxCases, type TaxObservation } from '../../scripts/verify-live/square-tax.js'

const LOC = 'LTEST'

function rig() {
  const clock = new FixedClock('2026-10-13T14:00:00Z')
  const store = new SquareSimStore(clock, { locationId: LOC })
  const sim = new SquareSimApi(store, { tokens: ['t-123456789'] })
  const client = new SquareClient({ baseUrl: 'http://sim', accessToken: 't-123456789', fetch: simFetch(sim), sleeper: { sleep: async () => undefined } })
  return { clock, store, sim, client, api: createSquareApi(client) }
}

let n = 0
const key = () => sqKey('ct', `sim-items-${++n}`)
const here = { present_at_all_locations: false, present_at_location_ids: [LOC] }
const variation = (id: string, item: string, name: string, cents: number | null) => ({
  type: 'ITEM_VARIATION',
  id,
  ...here,
  item_variation_data: { item_id: item, name, ...(cents === null ? { pricing_type: 'VARIABLE_PRICING' } : { pricing_type: 'FIXED_PRICING', price_money: usd(cents) }) },
})

async function library(r: ReturnType<typeof rig>) {
  const made = await r.api.catalog.batchUpsert(key(), [
    [
      { type: 'CATEGORY', id: '#cat', category_data: { name: 'Wash' } },
      { type: 'TAX', id: '#tax', ...here, tax_data: { name: 'Sales tax', percentage: '6.625', calculation_phase: 'TAX_SUBTOTAL_PHASE', inclusion_type: 'ADDITIVE', applies_to_custom_amounts: false, enabled: true } },
      {
        type: 'ITEM',
        id: '#item',
        ...here,
        item_data: {
          name: 'Signature Hand Wash',
          product_type: 'REGULAR',
          tax_ids: ['#tax'],
          categories: [{ id: '#cat', ordinal: 3 }],
          reporting_category: { id: '#cat' },
          variations: [variation('#v1', '#item', 'Compact car', 4000), variation('#v2', '#item', 'Large car · $229–$279', null), variation('#v3', '#item', 'Truck', 0)],
        },
      },
    ],
  ])
  const id = (t: string) => made.idMappings.find((m) => m.client_object_id === t)!.object_id!
  return { item: id('#item'), v1: id('#v1'), v2: id('#v2'), v3: id('#v3'), cat: id('#cat'), tax: id('#tax') }
}

describe('the simulator item library', () => {
  it('splits nested variations, resolves every temp id, keeps Square’s own fields (ordinals, sellable, presence)', async () => {
    const r = rig()
    const ids = await library(r)
    const item = await r.api.catalog.retrieve(ids.item)
    expect(item.type).toBe('ITEM')
    expect(item).toMatchObject({ present_at_all_locations: false, present_at_location_ids: [LOC], is_deleted: false })
    expect(item.item_data).toMatchObject({ name: 'Signature Hand Wash', product_type: 'REGULAR', tax_ids: [ids.tax], is_archived: false, reporting_category: { id: ids.cat } })
    // Square keeps its own ordinal within a category whatever was sent
    expect(item.item_data!.categories).toEqual([{ id: ids.cat, ordinal: -2251799796908032 }])
    const vs = item.item_data!.variations!
    expect(vs.map((v) => [v.id, v.item_variation_data?.item_id, v.item_variation_data?.ordinal, v.item_variation_data?.sellable])).toEqual([
      [ids.v1, ids.item, 0, true],
      [ids.v2, ids.item, 1, true],
      [ids.v3, ids.item, 2, true],
    ])
    expect(vs[1]!.item_variation_data).not.toHaveProperty('price_money')
    expect(vs[2]!.item_variation_data!.price_money).toEqual(usd(0))
    // one version for the whole batch
    expect(new Set([item.version, ...vs.map((v) => v.version)]).size).toBe(1)
    // a variation is an object of its own too
    expect((await r.api.catalog.retrieve(ids.v1)).item_variation_data).toMatchObject({ item_id: ids.item, name: 'Compact car' })
  })

  it('an item upsert deletes the variations it leaves out; hides one with an empty location list; an unchanged upsert keeps the version', async () => {
    const r = rig()
    const ids = await library(r)
    const cur = await r.api.catalog.retrieve(ids.item)
    const [v1, v2] = cur.item_data!.variations!
    r.clock.advance(1000)
    const next = await r.api.catalog.upsert(key(), {
      ...cur,
      item_data: {
        ...cur.item_data,
        variations: [
          { ...v1, item_variation_data: { ...v1!.item_variation_data, price_money: usd(4500) } },
          { ...v2, present_at_all_locations: false, present_at_location_ids: [] },
        ],
      },
    })
    const after = next.object.item_data!.variations!
    expect(after.map((v) => v.id)).toEqual([ids.v1, ids.v2])
    expect(after[0]!.item_variation_data!.price_money).toEqual(usd(4500))
    expect(after[1]).toMatchObject({ present_at_all_locations: false })
    expect(after[1]).not.toHaveProperty('present_at_location_ids')
    expect(next.object.version).toBeGreaterThan(cur.version!)
    // the dropped variation is deleted: 404 to a retrieve, is_deleted to a batch retrieve that asks for deleted objects
    await expect(r.api.catalog.retrieve(ids.v3)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    const b = await r.api.catalog.batchRetrieve([ids.item, ids.v3, 'NOPE'], { include_deleted_objects: true, include_related_objects: true })
    expect(b.objects.map((o) => [o.id, o.is_deleted])).toEqual([
      [ids.item, false],
      [ids.v3, true],
    ])
    expect(b.related.map((o) => o.type).sort()).toEqual(['CATEGORY', 'TAX'])
    expect((await r.api.catalog.batchRetrieve([ids.v3])).objects).toEqual([])
    // the same content again: nothing changes, the version stays
    const again = await r.api.catalog.retrieve(ids.item)
    r.clock.advance(1000)
    const same = await r.api.catalog.upsert(key(), again)
    expect(same.object.version).toBe(again.version)
  })

  it('checks versions like Square: none is a mismatch; a stale one only when a field it changes was changed since (nested too)', async () => {
    const r = rig()
    const ids = await library(r)
    const v0 = await r.api.catalog.retrieve(ids.item)
    r.clock.advance(1000)
    await r.api.catalog.upsert(key(), { ...v0, item_data: { ...v0.item_data, name: 'Signature Hand Wash B' } })
    // the old version changing the same field: VERSION_MISMATCH
    await expect(r.api.catalog.upsert(key(), { ...v0, item_data: { ...v0.item_data, name: 'Stale' } })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' })
    // no version at all: VERSION_MISMATCH
    const cur = await r.api.catalog.retrieve(ids.item)
    await expect(r.api.catalog.upsert(key(), { ...cur, version: undefined })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' })
    // the old version changing another field: accepted, and the newer name is kept
    r.clock.advance(1000)
    const merged = await r.api.catalog.upsert(key(), { ...v0, item_data: { ...v0.item_data, is_archived: true } })
    expect(merged.object.item_data).toMatchObject({ name: 'Signature Hand Wash B', is_archived: true })
    // a nested variation with a stale version whose price changed since
    const now = await r.api.catalog.retrieve(ids.item)
    const old = now.item_data!.variations!
    r.clock.advance(1000)
    await r.api.catalog.upsert(key(), { ...now, item_data: { ...now.item_data, variations: [{ ...old[0], item_variation_data: { ...old[0]!.item_variation_data, price_money: usd(5000) } }, old[1], old[2]] } })
    const fresh = await r.api.catalog.retrieve(ids.item)
    await expect(
      r.api.catalog.upsert(key(), {
        ...fresh,
        item_data: { ...fresh.item_data, variations: [{ ...old[0], item_variation_data: { ...old[0]!.item_variation_data, price_money: usd(5100) } }, ...fresh.item_data!.variations!.slice(1)] },
      }),
    ).rejects.toMatchObject({ code: 'VERSION_MISMATCH' })
  })

  it('refuses a variation present where its item is not (sandbox 2026-10-13)', async () => {
    const r = rig()
    const ids = await library(r)
    const cur = await r.api.catalog.retrieve(ids.item)
    await expect(
      r.api.catalog.upsert(key(), { ...cur, item_data: { ...cur.item_data, variations: [...cur.item_data!.variations!, { type: 'ITEM_VARIATION', id: '#all', item_variation_data: { item_id: cur.id, name: 'Everywhere', pricing_type: 'FIXED_PRICING', price_money: usd(1) } }] } }),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'INVALID_VALUE', detail: expect.stringMatching(/enabled at all future locations, but the referenced object .* of type ITEM is not/) })] })
  })

  it('archives, keeps CATEGORY global (a location list is refused) and TAX at the location, refuses a FIXED price without money', async () => {
    const r = rig()
    const ids = await library(r)
    const cur = await r.api.catalog.retrieve(ids.item)
    const a = await r.api.catalog.upsert(key(), { ...cur, item_data: { ...cur.item_data, is_archived: true } })
    expect(a.object.item_data!.is_archived).toBe(true)
    await expect(r.api.catalog.upsert(key(), { type: 'CATEGORY', id: '#c', ...here, category_data: { name: 'Tint' } })).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'INVALID_VALUE', detail: expect.stringMatching(/Unexpected unit-overridden attribute/) })],
    })
    const tax = await r.api.catalog.retrieve(ids.tax)
    expect(tax.tax_data).toMatchObject({ percentage: '6.625', inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', enabled: true })
    await expect(
      r.api.catalog.upsert(key(), { type: 'ITEM', id: '#i', item_data: { name: 'X', variations: [{ type: 'ITEM_VARIATION', id: '#v', item_variation_data: { item_id: '#i', name: 'x', pricing_type: 'FIXED_PRICING' } }] } }),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'INVALID_VALUE', field: 'price' })] })
    await expect(r.api.catalog.upsert(key(), { type: 'ITEM', id: '#i', item_data: { name: 'X', tax_ids: ['NOPE'], variations: [variation('#v', '#i', 'x', 1)] } })).rejects.toMatchObject({
      code: 'INVALID_VALUE',
    })
    // product_type can never change
    await expect(r.api.catalog.upsert(key(), { ...a.object, item_data: { ...a.object.item_data, product_type: 'APPOINTMENTS_SERVICE' } })).rejects.toMatchObject({ code: 'INVALID_VALUE' })
  })

  it('a BatchUpsert with a failing batch answers 400 but keeps the other batches (sandbox 2026-10-13)', async () => {
    const r = rig()
    const err = await r.api.catalog
      .batchUpsert(key(), [
        [{ type: 'CATEGORY', id: '#good', category_data: { name: 'Kept' } }],
        [{ type: 'ITEM', id: '#bad', item_data: { name: 'Bad', variations: [{ type: 'ITEM_VARIATION', id: '#bv', item_variation_data: { item_id: '#bad', name: 'x', pricing_type: 'FIXED_PRICING' } }] } }],
      ])
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SquareApiError)
    expect((err as SquareApiError).status).toBe(400)
    const cats = r.store.searchCatalog(['CATEGORY'])
    expect(cats.map((c) => (c.category_data as { name: string }).name)).toEqual(['Kept'])
    expect(r.store.searchCatalog(['ITEM'])).toEqual([])
  })

  it('searches incrementally (begin_time) with deleted objects, and an item search carries its variations', async () => {
    const r = rig()
    const ids = await library(r)
    const t1 = r.clock.now().toISOString()
    r.clock.advance(60_000)
    await r.api.catalog.delete(ids.v3)
    const cur = await r.api.catalog.retrieve(ids.item)
    await r.api.catalog.upsert(key(), { ...cur, item_data: { ...cur.item_data, name: 'Renamed' } })
    const changed = await r.api.catalog.search({ object_types: ['ITEM', 'ITEM_VARIATION', 'CATEGORY', 'TAX'], begin_time: t1, include_deleted_objects: true })
    expect(changed.items.map((o) => [o.type, o.id, o.is_deleted ?? false]).sort()).toEqual(
      [
        ['ITEM', ids.item, false],
        ['ITEM_VARIATION', ids.v3, true],
      ].sort(),
    )
    const items = await r.api.catalog.search({ object_types: ['ITEM'] })
    expect(items.items[0]!.item_data!.variations!.map((v) => v.id)).toEqual([ids.v1, ids.v2])
    // deleting an item deletes its variations
    await r.api.catalog.delete(ids.item)
    await expect(r.api.catalog.retrieve(ids.v1)).rejects.toMatchObject({ status: 404 })
  })
})

describe('the simulator CalculateOrder', () => {
  it('rounds every tax once on its taxable subtotal, half to even, and spreads it over the lines', async () => {
    const r = rig()
    const ids = await library(r)
    const calc = (order: Record<string, unknown>) => r.api.orders.calculate({ location_id: LOC, ...order })
    const one = await calc({ line_items: [{ name: 'Wash', quantity: '1', base_price_money: usd(10_000) }], taxes: [{ uid: 't', name: 'Sales tax', percentage: '6.625', type: 'ADDITIVE', scope: 'ORDER' }] })
    expect(one.total_tax_money).toEqual(usd(662))
    expect(one.total_money).toEqual(usd(10_662))
    const two = await calc({ line_items: [{ name: 'A', quantity: '1', base_price_money: usd(400) }, { name: 'B', quantity: '1', base_price_money: usd(400) }], taxes: [{ uid: 't', name: 'T', percentage: '6.625', scope: 'ORDER' }] })
    expect(two.total_tax_money).toEqual(usd(53))
    expect(two.line_items!.map((l) => l.total_tax_money!.amount)).toEqual([26, 27])
    // the POS path: catalog lines, the item's tax auto-applied; a VARIABLE price takes the amount rung up
    const pos = await calc({
      pricing_options: { auto_apply_taxes: true },
      line_items: [
        { catalog_object_id: ids.v1, quantity: '1' },
        { catalog_object_id: ids.v2, quantity: '1', base_price_money: usd(22_900) },
      ],
    })
    expect(pos.line_items!.map((l) => [l.catalog_object_id, l.base_price_money?.amount, l.variation_name, l.name])).toEqual([
      [ids.v1, 4000, 'Compact car', 'Signature Hand Wash'],
      [ids.v2, 22_900, 'Large car · $229–$279', 'Signature Hand Wash'],
    ])
    expect(pos.total_tax_money).toEqual(usd(divHalfEvenInt(26_900 * 6625, 100_000)))
    expect(pos.total_money!.amount).toBe(26_900 + pos.total_tax_money!.amount)
    await expect(calc({ line_items: [{ catalog_object_id: ids.v2, quantity: '1' }] })).rejects.toMatchObject({ code: 'INVALID_VALUE' })
    expect(spread(398, [2000, 2000, 2000]).reduce((s, x) => s + x, 0)).toBe(398)
  })

  it('gives every one of the 200 sandbox CalculateOrder totals of SQR-18 (6.625% and 7%; ORDER, LINE_ITEM and catalog taxes)', async () => {
    const r = rig()
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../fixtures/square-tax/sqr18-tax-rounding-2026-10-13.json'), 'utf8')) as {
      observations: Array<{ label: string; scope: string; rateDbp: number; squareTax: number; squareLineTaxes: number[] }>
    }
    // the catalog the catalog cases ring up, made the way SQR-18 makes it in the sandbox
    const { CATALOG_PRICES } = await import('../../scripts/verify-live/square-tax.js')
    const objects: Record<string, unknown>[] = []
    for (const rate of [6625, 7000]) {
      const pct = rate === 6625 ? '6.625' : '7'
      objects.push({ type: 'TAX', id: `#tax-${rate}`, ...here, tax_data: { name: `T ${pct}`, calculation_phase: 'TAX_SUBTOTAL_PHASE', inclusion_type: 'ADDITIVE', percentage: pct, applies_to_custom_amounts: false, enabled: true } })
      objects.push({
        type: 'ITEM',
        id: `#item-${rate}`,
        ...here,
        item_data: { name: `I ${pct}`, product_type: 'REGULAR', tax_ids: [`#tax-${rate}`], variations: CATALOG_PRICES.map((c) => variation(`#var-${rate}-${c}`, `#item-${rate}`, `$${c}`, c)) },
      })
    }
    const made = await r.api.catalog.batchUpsert(key(), [objects])
    const idOf = (t: string) => made.idMappings.find((m) => m.client_object_id === t)!.object_id!
    const ids = { tax: { 6625: idOf('#tax-6625'), 7000: idOf('#tax-7000') }, variation: Object.fromEntries([6625, 7000].flatMap((rate) => CATALOG_PRICES.map((c) => [`${rate}:${c}`, idOf(`#var-${rate}-${c}`)]))) }
    const cases = taxCases()
    expect(cases).toHaveLength(fixture.observations.length)
    const got: TaxObservation[] = []
    for (const c of cases) got.push(await calculate(r.client, c, LOC, 'verify-sim', ids))
    const wrong = got.flatMap((o, i) => {
      const want = fixture.observations[i]!
      expect([o.label, o.scope, o.rateDbp]).toEqual([want.label, want.scope, want.rateDbp])
      return o.squareTax === want.squareTax && o.squareLineTaxes.reduce((s, x) => s + x, 0) === want.squareTax ? [] : [`${o.label} ${o.scope} ${o.rateDbp}: ${o.squareTax} vs ${want.squareTax}`]
    })
    expect(wrong).toEqual([])
  })
})
