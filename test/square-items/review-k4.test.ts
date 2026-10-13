// K4 review of the Square item library (ADR 0172), against the database and the simulator:
//   ITEMS-P1  a shop category named "OASIS" (any casing but the exact name) is the shop's: never adopted as Oasis's marker, never written
//   ITEMS-P2  a shop tax Oasis adopted that staff turn off blocks the sync and tells the managers; Oasis never makes its own instead
//   ITEMS-P3  an item deleted at Square, forgotten, then sold again is made anew (never Square's replay of the deleted one)
//   ITEMS-P4  Square not answering the tax check is a read failure: no "tax mismatch" notice, nothing written
//   tax:H2    Oasis rounding tax half up blocks the sync (and nothing is written) until it rounds like Square
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import type { WireCatalogObject } from '../../src/integrations/square/wire.js'
import { runItemSync, type ItemSyncDeps } from '../../src/modules/catalog/square/sync.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { transaction } from '../../src/platform/db.js'
import { updateSetting } from '../../src/platform/settings.js'
import { useRig } from '../scheduling-gaps/support.js'
import { squareEnvFor } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'

const m = useRig()
afterEach(() => configureSquareRuntime({}))
const db = () => m.h.t.db
const loc = () => m.locationId()
const rounding = (value: 'half_up' | 'half_even') =>
  transaction(db(), (tx) => updateSetting(tx, { locationId: loc(), key: 'tax.rounding', value })).then(() => undefined)
beforeEach(() => rounding('half_even'))

function on() {
  const sim = simFor(m.h.clock)
  const env = squareEnvFor({ SQUARE_ITEMS_SYNC_ENABLED: 'true' })
  configureSquareRuntime({ env, api: () => sim.api })
  const deps: ItemSyncDeps = { db: db(), clock: m.h.clock, newId: m.h.t.app.newId, env, api: sim.api }
  return { sim, run: (o: Parameters<typeof runItemSync>[2] = {}) => runItemSync(deps, loc(), o) }
}

const links = (kind: string) =>
  db().selectFrom('square_catalog_links').selectAll().where('location_id', '=', loc()).where('kind', '=', kind as never).orderBy('created_at').execute()
const notices = (kind: string) => db().selectFrom('notifications').select(['kind', 'body']).where('kind', '=', kind).execute()
const objects = (r: ReturnType<typeof on>, type: string) => [...r.sim.store.catalog.values()].filter((o) => o.type === type)
const catalogWrites = (r: ReturnType<typeof on>) =>
  r.sim.sim.log.filter((x) => x.method === 'POST' && /\/v2\/catalog\/(object|batch-upsert)$/.test(x.path) && (x.status ?? 200) < 300).length

async function staffEdit(api: SquareApi, id: string, change: (o: WireCatalogObject) => WireCatalogObject) {
  const cur = await api.catalog.retrieve(id)
  await api.catalog.upsert(`ct_k4staff${String(Math.floor(m.h.clock.now().getTime() / 1000)).slice(-8)}${'0'.repeat(15)}` as never, change(cur))
}

describe('ITEMS-P1: the shop’s "OASIS" category', () => {
  it('is never taken for Oasis’s marker category, never renamed, and holds no Oasis item', async () => {
    const r = on()
    const shopCat = (await r.sim.api.catalog.upsert('ct_k4shopcat000000000000000000000' as never, { type: 'CATEGORY', id: '#c', category_data: { name: 'OASIS' } })).object
    await r.sim.api.catalog.upsert('ct_k4shopitem00000000000000000000' as never, {
      type: 'ITEM',
      id: '#i',
      item_data: {
        name: 'Gift card holder',
        categories: [{ id: shopCat.id }],
        variations: [{ type: 'ITEM_VARIATION', id: '#v', item_variation_data: { item_id: '#i', name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 500, currency: 'USD' } } }],
      },
    })
    expect(await r.run()).toMatchObject({ status: 'done', failed: 0 })
    const marker = (await links('category')).find((l) => l.category_key === '_oasis')!
    expect(marker.square_object_id).not.toBe(shopCat.id)
    expect((r.sim.store.items.view(marker.square_object_id!)!.category_data as { name: string }).name).toBe('Oasis')
    const before = r.sim.store.items.view(shopCat.id)!
    // the nightly drift run: the shop's category is still the shop's, byte for byte
    ;(m.h.clock as FixedClock).advance(60_000)
    expect(await r.run({ drift: true })).toMatchObject({ failed: 0 })
    expect(r.sim.store.items.view(shopCat.id)).toEqual(before)
    expect((before.category_data as { name: string }).name).toBe('OASIS')
    const oasisItems = objects(r, 'ITEM').filter((o) => (o.item_data as { categories?: { id: string }[] }).categories?.some((c) => c.id === shopCat.id))
    expect(oasisItems.map((o) => (o.item_data as { name: string }).name)).toEqual(['Gift card holder'])
  })
})

describe('ITEMS-P2: a shop tax Oasis adopted', () => {
  it('turned off by staff: the sync stops and says so; Oasis never makes its own tax and moves the items', async () => {
    const r = on()
    const nj = (
      await r.sim.api.catalog.upsert('ct_k4njtax0000000000000000000000' as never, {
        type: 'TAX',
        id: '#t',
        tax_data: { name: 'NJ sales tax', percentage: '7', inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', enabled: true },
      })
    ).object
    expect(await r.run()).toMatchObject({ status: 'done', failed: 0, taxCreated: 0 })
    expect((await links('tax'))[0]).toMatchObject({ square_object_id: nj.id, adopted: true })
    ;(m.h.clock as FixedClock).advance(60_000)
    await staffEdit(r.sim.api, nj.id, (o) => ({ ...o, tax_data: { ...o.tax_data, enabled: false } }))
    const writes = catalogWrites(r)
    const res = await r.run({ drift: true })
    expect(res).toMatchObject({
      status: 'blocked',
      taxCreated: 0,
      reason: 'The Square tax Oasis items use, “NJ sales tax”, is turned off in Square: the item sync is paused until it matches again, or pick another tax',
    })
    expect(catalogWrites(r)).toBe(writes)
    expect(objects(r, 'TAX')).toHaveLength(1)
    expect(await notices('square.items_tax_mismatch')).toHaveLength(1)
  })
})

describe('ITEMS-P3: an item deleted at Square, forgotten, then sold again', () => {
  it('is made anew: a live item, never the deleted one answered again', async () => {
    const r = on()
    expect(await r.run()).toMatchObject({ failed: 0 })
    const svc = await db().selectFrom('services').select(['id']).where('location_id', '=', loc()).where('name', '=', 'Express Hand Wash').executeTakeFirstOrThrow()
    const itemLink = async () => (await links('item')).find((l) => l.service_id === svc.id)!
    const first = (await itemLink()).square_object_id!
    await db().updateTable('services').set({ active: false }).where('id', '=', svc.id).execute()
    ;(m.h.clock as FixedClock).advance(60_000)
    expect(await r.run()).toMatchObject({ failed: 0 })
    expect((await itemLink()).state).toBe('archived')
    await r.sim.api.catalog.delete(first)
    ;(m.h.clock as FixedClock).advance(60_000)
    await r.run({ drift: true })
    expect((await itemLink()).square_object_id).toBeNull()
    await db().updateTable('services').set({ active: true }).where('id', '=', svc.id).execute()
    ;(m.h.clock as FixedClock).advance(60_000)
    expect(await r.run()).toMatchObject({ failed: 0, created: 1 })
    const again = await itemLink()
    expect(again.state).toBe('synced')
    expect(again.square_object_id).not.toBe(first)
    const live = await r.sim.api.catalog.retrieve(again.square_object_id!)
    expect(live.is_deleted ?? false).toBe(false)
    expect((live.item_data as { name: string }).name).toBe('Express Hand Wash')
  })
})

describe('ITEMS-P4: Square not answering the tax check', () => {
  it('is a read failure: nothing written, no tax-mismatch notice; the next run goes on', async () => {
    const r = on()
    r.sim.sim.injectFault({ status: 503, times: 4, path: '/v2/catalog/search', method: 'POST' })
    const res = await r.run()
    expect(res.status).not.toBe('blocked')
    expect(res).toMatchObject({ failed: 1, failures: ['Reading Square’s taxes: Square did not answer the tax check'] })
    expect(catalogWrites(r)).toBe(0)
    expect(await notices('square.items_tax_mismatch')).toEqual([])
    const state = await db().selectFrom('square_items_state').select(['last_error']).where('location_id', '=', loc()).executeTakeFirstOrThrow()
    expect(state.last_error).toBe('tax check: Square did not answer the tax check')
    expect(await r.run()).toMatchObject({ status: 'done', failed: 0, taxCreated: 1 })
  })
})

describe('tax:H2: Oasis rounding tax half up', () => {
  it('blocks the sync with a plain reason and writes nothing (no 7% or 6.625% tax made in Square)', async () => {
    await rounding('half_up')
    const r = on()
    const res = await r.run()
    expect(res).toMatchObject({ status: 'blocked', taxCreated: 0, created: 0, reason: expect.stringMatching(/Oasis rounds tax half up and Square rounds half to even/) })
    expect(catalogWrites(r)).toBe(0)
    expect(objects(r, 'TAX')).toEqual([])
    await rounding('half_even')
    expect(await r.run()).toMatchObject({ status: 'done', taxCreated: 1, failed: 0 })
  })
})
