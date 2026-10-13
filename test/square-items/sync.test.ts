// The Square item library sync with its database (ADR 0172), on the real app with the design catalog and an in-process simulator:
// the first sync; a price edit in place; sizes renamed, turned off and on; a service renamed, moved and turned off; a staff edit put
// back with one notice (and a reminder a day later); an item staff deleted made again; the shop's own items byte-identical and a
// variation staff added kept; a VERSION_MISMATCH between the read and the write; a lost answer recovered from the outbox with no
// duplicate; a wiped link table re-adopted by the marker; watch-only skipped with a preview; an environment switch; 429s; and the
// tax gate (a mismatch blocks and tells the managers once a day; Oasis's own tax follows the rate).
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import type { WireCatalogObject } from '../../src/integrations/square/wire.js'
import { runItemSync, type ItemSyncDeps } from '../../src/modules/catalog/square/sync.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { useRig } from '../scheduling-gaps/support.js'
import { squareEnvFor } from '../square-db/core.js'
import { liveEnvVars, SIM_LOCATION, simFor } from '../square-db/helpers.js'

const m = useRig()
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const db = () => m.h.t.db
const loc = () => m.locationId()

function on(vars: Record<string, string> = {}, sim = simFor(m.h.clock)) {
  const env = squareEnvFor({ SQUARE_ITEMS_SYNC_ENABLED: 'true', ...vars })
  configureSquareRuntime({ env, api: () => sim.api })
  const deps: ItemSyncDeps = { db: db(), clock: m.h.clock, newId: m.h.t.app.newId, env, api: sim.api }
  return { sim, env, deps, run: (o: Parameters<typeof runItemSync>[2] = {}) => runItemSync(deps, loc(), o) }
}

const service = (name: string, kind: 'package' | 'addon' = 'package') =>
  db().selectFrom('services').select(['id', 'version', 'name']).where('location_id', '=', loc()).where('name', '=', name).where('kind', '=', kind).executeTakeFirstOrThrow()

const links = (kind?: string) => {
  let q = db().selectFrom('square_catalog_links').selectAll().where('location_id', '=', loc())
  if (kind) q = q.where('kind', '=', kind as never)
  return q.orderBy('created_at').orderBy('id').execute()
}

const itemOf = async (r: ReturnType<typeof on>, serviceId: string): Promise<WireCatalogObject> => {
  const l = (await links('item')).find((x) => x.service_id === serviceId && x.environment === 'sim')
  expect(l?.square_object_id, 'item link').toBeTruthy()
  return r.sim.store.items.view(l!.square_object_id!) as unknown as WireCatalogObject
}

const variation = (item: WireCatalogObject, name: string) => item.item_data!.variations!.find((v) => v.item_variation_data?.name === name)

/** Writes Square answered (UpsertCatalogObject, BatchUpsert, Delete). */
const writes = (r: ReturnType<typeof on>) => r.sim.sim.log.filter((x) => x.method !== 'GET' && /\/v2\/catalog\/(object|batch-upsert)/.test(x.path) && x.method === 'POST').length

async function setPrices(name: string, cells: Array<{ class: string; cents: number | null; maxCents?: number | null }>) {
  const s = await service(name)
  const res = await m.send(m.superS(), 'PUT', '/catalog/prices', { rows: [{ serviceId: s.id, version: s.version, cells: cells.map((c) => ({ maxCents: null, ...c })) }] })
  expect(res.statusCode, res.body).toBe(200)
}

/** The categories of the sold services, and "Oasis". */
const soldCategories = async () =>
  (
    await db()
      .selectFrom('services')
      .select('category')
      .distinct()
      .where('location_id', '=', loc())
      .where('active', '=', true)
      .where('quote_only', '=', false)
      .where('price_cents', '>', 0)
      .execute()
  ).length + 1

const notices = (kind: string) => db().selectFrom('notifications').select(['kind', 'body']).where('kind', '=', kind).execute()

/** A staff edit at Square (the Square Dashboard): read, change, write with the current version. */
async function staffEdit(api: SquareApi, id: string, change: (o: WireCatalogObject) => WireCatalogObject) {
  const cur = await api.catalog.retrieve(id)
  await api.catalog.upsert(`ct_staffedit${String(Math.floor(m.h.clock.now().getTime() / 1000)).slice(-8)}${'0'.repeat(15)}` as never, change(cur))
}

describe('the first sync', () => {
  it('every sold service is one item at our location, in its category and "Oasis", priced by size, with Oasis’s own tax; a second run writes nothing', async () => {
    const r = on()
    await setPrices('Express Hand Wash', [
      { class: 'compact_car', cents: 4000 },
      { class: 'large_suv', cents: 6000 },
      { class: 'truck', cents: 22900, maxCents: 27900 },
    ])
    const res = await r.run()
    expect(res).toMatchObject({ status: 'done', failed: 0, taxCreated: 1 })
    expect(res.created).toBeGreaterThan(5)
    const express = await itemOf(r, (await service('Express Hand Wash')).id)
    expect(express).toMatchObject({ present_at_all_locations: false, present_at_location_ids: [SIM_LOCATION] })
    expect(express.item_data).toMatchObject({ name: 'Express Hand Wash', product_type: 'REGULAR', is_archived: false, is_taxable: true })
    const prices = express.item_data!.variations!.map((v) => [v.item_variation_data!.name, v.item_variation_data!.pricing_type, v.item_variation_data!.price_money?.amount ?? null])
    expect(prices).toEqual([
      ['Compact car', 'FIXED_PRICING', 4000],
      ['Large car', 'FIXED_PRICING', 4000],
      ['Compact SUV', 'FIXED_PRICING', 4000],
      ['Large SUV', 'FIXED_PRICING', 6000],
      ['Truck · $229–$279', 'VARIABLE_PRICING', null],
    ])
    // the tax: Oasis's own, 7%, at our location, added on the subtotal, never to custom amounts
    const tax = r.sim.store.items.view(express.item_data!.tax_ids![0]!)!
    expect(tax.tax_data).toMatchObject({ name: 'Sales tax', percentage: '7', inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', applies_to_custom_amounts: false, enabled: true })
    // its category and "Oasis"
    const cats = express.item_data!.categories!.map((c) => (r.sim.store.items.view(c.id)!.category_data as { name: string }).name)
    expect(cats).toEqual(['Wash', 'Oasis'])
    // a service without sizes is one "Regular" variation at its price
    const premium = await itemOf(r, (await service('Premium Hand Wash + Interior')).id)
    expect(premium.item_data!.variations!.map((v) => [v.item_variation_data!.name, v.item_variation_data!.price_money?.amount])).toEqual([['Regular', 12900]])
    const audits = await db().selectFrom('audit_log').select(['action', 'after']).where('action', '=', 'square.items.sync').execute()
    expect(audits).toHaveLength(1)
    // nothing changed: a second run reads (the tax, what changed) and writes nothing
    const before = writes(r)
    expect(await r.run()).toMatchObject({ status: 'done', created: 0, updated: 0, failed: 0 })
    expect(writes(r)).toBe(before)
    expect(await db().selectFrom('audit_log').select('id').where('action', '=', 'square.items.sync').execute()).toHaveLength(1)
  })
})

describe('Oasis edits reach Square in place', () => {
  it('a price edit changes the variation in place (same id, new version); Prices by size shows it waiting, then on Square', async () => {
    const r = on()
    await setPrices('Express Hand Wash', [{ class: 'compact_car', cents: 4000 }])
    await r.run()
    const sid = (await service('Express Hand Wash')).id
    const v1 = variation(await itemOf(r, sid), 'Compact car')!
    await setPrices('Express Hand Wash', [{ class: 'compact_car', cents: 4500 }])
    const catalog = async () => ((await m.get(m.superS(), '/catalog')).json() as Json).prices.find((p: Json) => p.serviceId === sid)
    expect((await catalog()).square).toMatchObject({ state: 'pending', cells: { compact_car: 'pending' } })
    ;(m.h.clock as FixedClock).advance(60_000)
    expect(await r.run()).toMatchObject({ updated: 1, failed: 0 })
    const v2 = variation(await itemOf(r, sid), 'Compact car')!
    expect(v2.id).toBe(v1.id)
    expect(v2.version).toBeGreaterThan(v1.version!)
    expect(v2.item_variation_data!.price_money!.amount).toBe(4500)
    expect((await catalog()).square).toMatchObject({ state: 'synced', cells: { compact_car: 'synced', large_car: 'synced' }, error: null })
    // set.services without set.billing still sees it; a reader without set.services does not
    const reader = (await m.h.userWithPermissions(['sched.view'], 'reader@example.test')).session
    expect(((await m.get(reader, '/catalog')).json() as Json).prices[0]).not.toHaveProperty('square')
  })

  it('sizes: a rename renames the variation; a size turned off is hidden (same id) and comes back with it', async () => {
    const r = on()
    await setPrices('Express Hand Wash', [{ class: 'compact_car', cents: 4000 }, { class: 'truck', cents: 7000 }])
    await r.run()
    const sid = (await service('Express Hand Wash')).id
    const truck = variation(await itemOf(r, sid), 'Truck')!
    await db().updateTable('vehicle_classes').set({ label: 'Pickup truck' }).where('location_id', '=', loc()).where('key', '=', 'truck').execute()
    await r.run()
    expect(variation(await itemOf(r, sid), 'Pickup truck')?.id).toBe(truck.id)
    await db().updateTable('vehicle_classes').set({ active: false }).where('location_id', '=', loc()).where('key', '=', 'truck').execute()
    await r.run()
    const hidden = variation(await itemOf(r, sid), 'Pickup truck')!
    expect(hidden.id).toBe(truck.id)
    expect(hidden).toMatchObject({ present_at_all_locations: false })
    expect(hidden.present_at_location_ids ?? []).toEqual([])
    expect((await links('variation')).find((l) => l.square_object_id === truck.id)?.state).toBe('hidden')
    await db().updateTable('vehicle_classes').set({ active: true }).where('location_id', '=', loc()).where('key', '=', 'truck').execute()
    await r.run()
    expect(variation(await itemOf(r, sid), 'Pickup truck')).toMatchObject({ id: truck.id, present_at_location_ids: [SIM_LOCATION] })
    expect([...r.sim.store.items.deleted.keys()]).toEqual([])
  })

  it('a service renamed, moved to another category, turned off (archived, not deleted) and back on', async () => {
    const r = on()
    await r.run()
    const s = await service('Pet hair removal', 'addon')
    await db().updateTable('services').set({ name: 'Pet hair removal (deluxe)', public_name: 'Pet hair', category: 'detail' }).where('id', '=', s.id).execute()
    await r.run()
    let item = await itemOf(r, s.id)
    expect(item.item_data).toMatchObject({ name: 'Pet hair removal (deluxe)', buyer_facing_name: 'Pet hair' })
    expect((r.sim.store.items.view(item.item_data!.reporting_category!.id)!.category_data as { name: string }).name).toBe('Detail')
    await db().updateTable('services').set({ active: false }).where('id', '=', s.id).execute()
    expect(await r.run()).toMatchObject({ archived: 1 })
    item = await itemOf(r, s.id)
    expect(item.item_data!.is_archived).toBe(true)
    expect((await links('item')).find((l) => l.service_id === s.id)?.state).toBe('archived')
    await db().updateTable('services').set({ active: true }).where('id', '=', s.id).execute()
    await r.run()
    expect((await itemOf(r, s.id)).item_data!.is_archived).toBe(false)
    expect(r.sim.sim.log.filter((x) => x.method === 'DELETE')).toEqual([])
  })
})

describe('Square-side changes', () => {
  it('a staff edit of an Oasis price is put back, the managers told once, again only a day later', async () => {
    const r = on()
    await setPrices('Express Hand Wash', [{ class: 'compact_car', cents: 4000 }])
    await r.run()
    const sid = (await service('Express Hand Wash')).id
    const item = await itemOf(r, sid)
    const bump = (o: WireCatalogObject): WireCatalogObject => ({
      ...o,
      item_data: {
        ...o.item_data,
        variations: o.item_data!.variations!.map((v) =>
          v.item_variation_data?.name === 'Compact car' ? { ...v, item_variation_data: { ...v.item_variation_data, price_money: { amount: 4500, currency: 'USD' } } } : v,
        ),
      },
    })
    ;(m.h.clock as FixedClock).advance(60_000)
    await staffEdit(r.sim.api, item.id, bump)
    const res = await r.run()
    expect(res.restored).toBe(1)
    expect(res.changedInSquare).toEqual(['Express Hand Wash · Compact car was $45 in Square; Oasis charges $40'])
    expect(variation(await itemOf(r, sid), 'Compact car')!.item_variation_data!.price_money!.amount).toBe(4000)
    const told = await notices('square.items_changed_in_square')
    expect(told.length).toBeGreaterThan(0)
    expect(told[0]!.body).toMatch(/^Changed in Square: Express Hand Wash · Compact car was \$45 in Square; Oasis charges \$40\. Oasis set it back/)
    // the same edit again within a day: put back, nobody told again
    ;(m.h.clock as FixedClock).advance(60_000)
    await staffEdit(r.sim.api, item.id, bump)
    expect((await r.run()).restored).toBe(1)
    expect(await notices('square.items_changed_in_square')).toHaveLength(told.length)
    // a day later: told again
    ;(m.h.clock as FixedClock).advance(25 * 3600_000)
    await staffEdit(r.sim.api, item.id, bump)
    expect((await r.run()).restored).toBe(1)
    expect((await notices('square.items_changed_in_square')).length).toBe(told.length * 2)
  })

  it('an item staff deleted is made again; the shop’s own items stay byte-identical; a variation staff added is kept', async () => {
    const r = on()
    const shop = await r.sim.api.catalog.upsert('ct_shopitem00000000000000000000000' as never, {
      type: 'ITEM',
      id: '#gift',
      item_data: { name: 'Gift card', variations: [{ type: 'ITEM_VARIATION', id: '#g', item_variation_data: { item_id: '#gift', name: '$25', pricing_type: 'FIXED_PRICING', price_money: { amount: 2500, currency: 'USD' } } }] },
    })
    const shopBefore = JSON.stringify(r.sim.store.items.view(shop.object.id))
    await r.run()
    const premium = (await service('Premium Hand Wash + Interior')).id
    const wax = (await service('Express Hand Wash')).id
    const deleted = await itemOf(r, premium)
    ;(m.h.clock as FixedClock).advance(60_000)
    await r.sim.api.catalog.delete(deleted.id)
    // staff add a size of their own to another Oasis item
    const ex = await itemOf(r, wax)
    await staffEdit(r.sim.api, ex.id, (o) => ({
      ...o,
      item_data: {
        ...o.item_data,
        variations: [
          ...o.item_data!.variations!,
          {
            type: 'ITEM_VARIATION',
            id: '#staff',
            present_at_all_locations: false,
            present_at_location_ids: [SIM_LOCATION],
            item_variation_data: { item_id: o.id, name: 'Staff special', pricing_type: 'FIXED_PRICING', price_money: { amount: 1234, currency: 'USD' } },
          },
        ],
      },
    }))
    const res = await r.run({ drift: true })
    expect(res.recreated).toBe(1)
    expect(res.changedInSquare).toContain('Premium Hand Wash + Interior was deleted in Square: Oasis made it again')
    const again = await itemOf(r, premium)
    expect(again.id).not.toBe(deleted.id)
    expect(again.item_data!.is_archived).toBe(false)
    expect(variation(await itemOf(r, wax), 'Staff special')?.item_variation_data?.price_money?.amount).toBe(1234)
    expect(JSON.stringify(r.sim.store.items.view(shop.object.id))).toBe(shopBefore)
    // a second nightly run finds Square as this one left it
    const n = writes(r)
    expect(await r.run({ drift: true })).toMatchObject({ created: 0, updated: 0, restored: 0, recreated: 0, failed: 0 })
    expect(writes(r)).toBe(n)
  })

  it('a VERSION_MISMATCH between the read and the write (staff changed the same price) is read, merged and sent again', async () => {
    const base = simFor(m.h.clock)
    let raced = false
    const racing: SquareApi = {
      ...base.api,
      catalog: {
        ...base.api.catalog,
        retrieve: async (id) => {
          const o = await base.api.catalog.retrieve(id)
          if (!raced && o.type === 'ITEM' && o.item_data?.name === 'Express Hand Wash' && o.version) {
            raced = true
            ;(m.h.clock as FixedClock).advance(1000)
            await staffEdit(base.api, id, (x) => ({
              ...x,
              item_data: { ...x.item_data, variations: x.item_data!.variations!.map((v, i) => (i === 0 ? { ...v, item_variation_data: { ...v.item_variation_data, price_money: { amount: 9999, currency: 'USD' } } } : v)) },
            }))
          }
          return o
        },
      },
    }
    const r = on({}, { ...base, api: racing })
    await setPrices('Express Hand Wash', [{ class: 'compact_car', cents: 4000 }])
    await r.run()
    raced = false
    await setPrices('Express Hand Wash', [{ class: 'compact_car', cents: 4100 }])
    const res = await r.run()
    expect(raced).toBe(true)
    expect(res).toMatchObject({ failed: 0, updated: 1 })
    expect(base.sim.log.some((x) => x.status === 400)).toBe(true) // the mismatch happened
    expect(variation(await itemOf(r, (await service('Express Hand Wash')).id), 'Compact car')!.item_variation_data!.price_money!.amount).toBe(4100)
  })
})

describe('crash safety', () => {
  it('a lost answer leaves the create in the outbox; the next run sends the same request and gets the same item (no duplicate)', async () => {
    const r = on()
    await r.run()
    const id = m.h.t.app.newId()
    await db()
      .insertInto('services')
      .values({ id, location_id: loc(), kind: 'addon', name: 'Clay bar treatment (test)', price_cents: 5500, duration_min: 0, category: 'addons' })
      .execute()
    // Square makes it, every answer is lost (all four tries)
    r.sim.sim.injectFault({ dropAnswer: true, times: 4, path: '/v2/catalog/object', method: 'POST' })
    const first = await r.run()
    expect(first.failed).toBe(1)
    const pending = (await links('item')).find((l) => l.service_id === id)!
    expect(pending).toMatchObject({ state: 'failed', square_object_id: null })
    expect(pending.pending_key).toMatch(/^ct_/)
    expect(JSON.parse(pending.pending_body!)).toMatchObject({ type: 'ITEM', item_data: { name: 'Clay bar treatment (test)' } })
    const count = () => [...r.sim.store.catalog.values()].filter((o) => o.type === 'ITEM' && (o.item_data as { name: string }).name === 'Clay bar treatment (test)').length
    expect(count()).toBe(1)
    const second = await r.run()
    expect(second.failures).toEqual([])
    expect(count()).toBe(1)
    const done = (await links('item')).find((l) => l.service_id === id)!
    expect(done).toMatchObject({ state: 'synced', pending_key: null })
    expect(done.square_object_id).toBeTruthy()
  })

  it('a wiped link table: the items are found again by their marker, never made twice', async () => {
    const r = on()
    await r.run()
    const before = [...r.sim.store.catalog.values()].filter((o) => o.type === 'ITEM').length
    const ids = (await links('item')).map((l) => l.square_object_id).sort()
    await sql`delete from square_catalog_links`.execute(db())
    await sql`delete from square_items_state`.execute(db())
    const res = await r.run()
    expect(res).toMatchObject({ created: 0, failed: 0 })
    expect(res.adopted).toBe(ids.length)
    expect([...r.sim.store.catalog.values()].filter((o) => o.type === 'ITEM').length).toBe(before)
    expect((await links('item')).map((l) => l.square_object_id).sort()).toEqual(ids)
    expect([...r.sim.store.catalog.values()].filter((o) => o.type === 'CATEGORY').length).toBe(await soldCategories()) // none made twice
    expect([...r.sim.store.catalog.values()].filter((o) => o.type === 'TAX').length).toBe(1)
  })

  it('no item is ever sent without the sales tax; a tax deleted at Square is made again and every item moves to it', async () => {
    const r = on()
    // Square does not answer the tax create (every try): nothing is sent, the run says why
    r.sim.sim.injectFault({ status: 500, times: 4, path: '/v2/catalog/object', method: 'POST' })
    const first = await r.run()
    expect(first.failures.join(' ')).toMatch(/The sales tax: Square did not answer/)
    expect([...r.sim.store.catalog.values()].filter((o) => o.type === 'ITEM')).toEqual([])
    expect(await r.run()).toMatchObject({ failed: 0, taxCreated: 1 })
    const taxLink = (await links('tax'))[0]!
    const old = taxLink.square_object_id!
    // staff delete Oasis's tax in Square: made again (a new id, not the deleted one), the items carry the new one
    ;(m.h.clock as FixedClock).advance(60_000)
    await r.sim.api.catalog.delete(old)
    const again = await r.run()
    expect(again).toMatchObject({ failed: 0, taxCreated: 1 })
    const now = (await links('tax'))[0]!.square_object_id!
    expect(now).not.toBe(old)
    const item = await itemOf(r, (await service('Express Hand Wash')).id)
    expect(item.item_data!.tax_ids).toEqual([now])
  })

  it('429s are tried again; a switch to another Square environment starts afresh', async () => {
    const r = on()
    r.sim.sim.injectFault({ status: 429, times: 2, path: '/v2/catalog/object', retryAfterSeconds: 0 })
    expect(await r.run()).toMatchObject({ status: 'done', failed: 0 })
    const simLinks = (await links()).length
    // the sandbox (live, another merchant): nothing of the simulator's applies
    const sandbox = on({ ...liveEnvVars, SQUARE_ITEMS_SYNC_ENABLED: 'true' })
    const res = await sandbox.run()
    expect(res).toMatchObject({ status: 'done', failed: 0, taxCreated: 1 })
    expect(res.created).toBeGreaterThan(5)
    const all = await links()
    expect(all.filter((l) => l.environment === 'sim')).toHaveLength(simLinks)
    expect(all.filter((l) => l.environment === 'sandbox').length).toBe(simLinks)
  })
})

describe('switches and the tax gate', () => {
  it('watch-only (the defaults): the jobs skip without a Square call; Sync now gives a read-only preview', async () => {
    const sim = simFor(m.h.clock)
    configureSquareRuntime({ env: squareEnvFor({ PAYMENT_PROCESSOR: 'squarespace', SQUARE_WRITES_ENABLED: 'false' }), api: () => sim.api })
    const deps: ItemSyncDeps = { db: db(), clock: m.h.clock, newId: m.h.t.app.newId, env: squareEnvFor({ SQUARE_WRITES_ENABLED: 'false' }), api: sim.api }
    expect(await runItemSync(deps, loc())).toMatchObject({ status: 'skipped', mode: 'preview' })
    // the item switch on but writes off: still watch-only
    expect(await runItemSync({ ...deps, env: squareEnvFor({ SQUARE_WRITES_ENABLED: 'false', SQUARE_ITEMS_SYNC_ENABLED: 'true' }) }, loc())).toMatchObject({ status: 'skipped' })
    expect(sim.sim.log).toEqual([])
    const res = await m.send(m.superS(), 'POST', '/integrations/square/items/sync', {}, false)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Json
    expect(body).toMatchObject({ status: 'preview', mode: 'preview', tax: { status: 'create' }, created: 0, preview: { tax: 'create', categories: await soldCategories() } })
    expect(body.preview.create).toBeGreaterThan(5)
    expect(body.preview.createPrices).toBe(body.preview.create)
    expect(sim.sim.log.every((x) => x.path === '/v2/catalog/search')).toBe(true)
    const view = (await m.get(m.superS(), '/integrations/square/items')).json() as Json
    expect(view).toMatchObject({ mode: 'preview', writesEnabled: false, itemsSyncEnabled: false, taxCheck: { status: 'create' }, preview: { create: body.preview.create } })
    expect(await db().selectFrom('square_catalog_links').select('id').execute()).toEqual([])
  })

  it('a Square tax that does not match blocks the sync, the managers told once a day; Test connection fails; "create" unblocks', async () => {
    const r = on({ ...liveEnvVars, SQUARE_ITEMS_SYNC_ENABLED: 'true' })
    await r.sim.api.catalog.upsert('ct_shoptax000000000000000000000000' as never, {
      type: 'TAX',
      id: '#t',
      tax_data: { name: 'NJ sales tax', percentage: '8.875', inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', enabled: true },
    })
    const res = await r.run()
    expect(res).toMatchObject({ status: 'blocked', created: 0, reason: expect.stringMatching(/NJ sales tax 8.875%\) don’t match Oasis’s 7%/) })
    expect(writes(r)).toBe(1) // the shop's own tax only
    expect(await notices('square.items_tax_mismatch')).not.toHaveLength(0)
    const n = (await notices('square.items_tax_mismatch')).length
    await r.run()
    expect(await notices('square.items_tax_mismatch')).toHaveLength(n)
    // Test connection carries the tax check (it fails Test connection while the item sync is on)
    const test = (await m.send(m.superS(), 'POST', '/integrations/square/test', {}, false)).json() as Json
    expect(test.ok).toBe(false)
    expect(test.checks.find((c: Json) => c.key === 'tax')).toMatchObject({ ok: false, detail: expect.stringMatching(/don’t match Oasis’s 7%/) })
    // staff choose Oasis's own tax: unblocked
    const view = (await m.get(m.superS(), '/integrations/square/items')).json() as Json
    expect(view.taxCheck.candidates).toEqual([{ id: expect.any(String), name: 'NJ sales tax', percentage: '8.875', matches: false, problem: '8.875%, not 7%' }])
    expect((await m.send(m.superS(), 'PUT', '/integrations/square/items/tax', { mode: 'create' }, false)).statusCode).toBe(428)
    expect((await m.send(m.superS(), 'PUT', '/integrations/square/items/tax', { mode: 'adopt', version: view.version }, false)).statusCode).toBe(422)
    const put = await m.send(m.superS(), 'PUT', '/integrations/square/items/tax', { mode: 'create', version: view.version }, false)
    expect(put.statusCode, put.body).toBe(200)
    expect(put.json()).toEqual({ mode: 'create', squareTaxId: null, version: view.version + 1 })
    expect((await m.send(m.superS(), 'PUT', '/integrations/square/items/tax', { mode: 'auto', version: view.version }, false)).statusCode).toBe(412)
    expect(await r.run()).toMatchObject({ status: 'done', taxCreated: 1, failed: 0 })
    expect(await db().selectFrom('audit_log').select('action').where('action', '=', 'square.items.tax').execute()).toHaveLength(1)
  })

  it('Oasis’s own tax follows Oasis’s rate (7% to 6.625%); the billing panel and the status row carry the summary', async () => {
    const r = on()
    await r.run()
    const panel = (await m.get(m.superS(), '/settings/billing')).json() as Json
    expect(panel.processing.itemsSyncEnabled).toBe(true)
    expect(panel.squareItems).toMatchObject({ mode: 'on', tax: { status: 'ok' }, counts: { failed: 0, waiting: 0 } })
    expect(panel.squareItems.counts.onSquare).toBeGreaterThan(5)
    const put = await m.send(m.superS(), 'PUT', '/settings/billing/sales-tax', { percent: '6.625', version: panel.salesTax.version }, false)
    expect(put.statusCode, put.body).toBe(200)
    const res = await r.run()
    expect(res).toMatchObject({ taxUpdated: 1, failed: 0 })
    const own = (await links('tax'))[0]!
    expect((r.sim.store.items.view(own.square_object_id!)!.tax_data as { percentage: string }).percentage).toBe('6.625')
  })

  it('archive-all: refused watch-only and while the sync is on; with writes on and the sync off every Oasis item is archived', async () => {
    const r = on()
    await r.run()
    configureSquareRuntime({ env: squareEnvFor({ SQUARE_WRITES_ENABLED: 'false' }), api: () => r.sim.api })
    expect((await m.send(m.superS(), 'POST', '/integrations/square/items/archive-all', {}, false)).json()).toMatchObject({ code: 'SQUARE_WRITES_OFF' })
    configureSquareRuntime({ env: r.env, api: () => r.sim.api })
    expect((await m.send(m.superS(), 'POST', '/integrations/square/items/archive-all', {}, false)).json()).toMatchObject({ code: 'SQUARE_ITEMS_SYNC_ON' })
    configureSquareRuntime({ env: squareEnvFor({}), api: () => r.sim.api })
    const res = await m.send(m.superS(), 'POST', '/integrations/square/items/archive-all', {}, false)
    expect(res.statusCode, res.body).toBe(200)
    const out = res.json() as Json
    expect(out.archived).toBeGreaterThan(5)
    expect(out.failed).toBe(0)
    const items = [...r.sim.store.catalog.values()].filter((o) => o.type === 'ITEM')
    expect(items.every((o) => (o.item_data as { is_archived: boolean }).is_archived)).toBe(true)
    expect(r.sim.sim.log.filter((x) => x.method === 'DELETE')).toEqual([])
    expect(await db().selectFrom('audit_log').select('action').where('action', '=', 'square.items.archive_all').execute()).toHaveLength(1)
    // the sync on again puts them back on sale
    expect((await r.run()).failed).toBe(0)
    expect([...r.sim.store.catalog.values()].filter((o) => o.type === 'ITEM').every((o) => !(o.item_data as { is_archived: boolean }).is_archived)).toBe(true)
  })

  it('the routes need set.billing', async () => {
    on()
    const services = (await m.h.userWithPermissions(['set.services'], 'services@example.test')).session
    expect((await m.get(services, '/integrations/square/items')).statusCode).toBe(403)
    expect((await m.send(services, 'POST', '/integrations/square/items/sync', {}, false)).statusCode).toBe(403)
    const billing = (await m.h.userWithPermissions(['set.billing'], 'billing@example.test')).session
    expect((await m.get(billing, '/integrations/square/items')).statusCode).toBe(200)
  })
})
