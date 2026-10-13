// The Square item library planner and sender (ADR 0172), pure and against the in-process simulator (no database): the desired
// library follows the price rule Oasis charges by; and, for random libraries and random shops (fast-check):
//   - a sync converges: planning again finds nothing to do, also against a full read-back of Square;
//   - it never deletes anything at Square (no DeleteCatalogObject, and no variation is ever dropped from an item);
//   - it never writes a foreign id: every object it sends is a linked id or a temp id, and the shop's own items stay byte-identical;
//   - it keeps the variations staff added to an Oasis item;
//   - presence is exactly our location (or nowhere for a hidden size), prices equal classPrice for every active size, VARIABLE
//     pricing exactly for a range;
//   - turning a size off and on keeps its variation id;
//   - keys are at most 45 characters, the same for the same content;
//   - a tax check that fails plans only `blocked` and writes nothing.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SQUARE_KEY_MAX } from '../../src/integrations/square/keys.js'
import { SquareSimApi, SquareSimStore, simFetch } from '../../src/integrations/square/sim/index.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import type { WireCatalogObject } from '../../src/integrations/square/wire.js'
import { classPrice, type PriceBook } from '../../src/modules/catalog/price-book.js'
import {
  desiredLibrary,
  markerOf,
  OASIS_CATEGORY_KEY,
  parseMarker,
  variationName,
  type LibraryClass,
  type LibraryInput,
  type LibraryService,
} from '../../src/modules/catalog/square/desired.js'
import { memoryLinkStore, runEngine, type LinkStore } from '../../src/modules/catalog/square/engine.js'
import { planItems, planSetup, type LinkRow, type RemoteView } from '../../src/modules/catalog/square/plan.js'
import { decideTax, type TaxCheck } from '../../src/modules/catalog/square/tax.js'
import { FixedClock } from '../../src/platform/clock.js'

const LOC = 'LITEMS0001'
const CLASSES = [
  { key: 'compact_car', label: 'Compact car', sort: 10 },
  { key: 'large_car', label: 'Large car', sort: 20 },
  { key: 'compact_suv', label: 'Compact SUV', sort: 30 },
  { key: 'large_suv', label: 'Large SUV', sort: 40 },
  { key: 'truck', label: 'Truck', sort: 50 },
]
const CATEGORIES = [
  { key: 'wash', label: 'Wash', sort: 10 },
  { key: 'addons', label: 'Add-ons', sort: 20 },
  { key: 'tint', label: 'Tint', sort: 30 },
]
const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

interface Cell {
  cents: number
  maxCents: number | null
}
interface Lib {
  active: boolean[]
  services: Array<LibraryService & { cells: Record<string, Cell> }>
}

function input(l: Lib): LibraryInput {
  const classes: LibraryClass[] = CLASSES.map((c, i) => ({ ...c, active: l.active[i]! }))
  const book: PriceBook = {
    classes: classes.filter((c) => c.active).map((c) => ({ key: c.key, label: c.label, sort: c.sort })),
    labels: new Map(classes.map((c) => [c.key, c.label])),
    services: new Map(l.services.map((s) => [s.id, { id: s.id, kind: s.kind, name: s.name, priceCents: s.priceCents, category: s.category, tags: [], active: s.active, quoteOnly: s.quoteOnly }])),
    cells: new Map(l.services.map((s) => [s.id, new Map(Object.entries(s.cells))])),
    tintFilms: [],
  }
  return { classes, services: l.services, categories: CATEGORIES, book }
}

const cellArb: fc.Arbitrary<Cell> = fc
  .tuple(fc.integer({ min: 0, max: 300 }), fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }))
  .map(([d, extra]) => ({ cents: d * 100, maxCents: extra === null ? null : (d + extra) * 100 }))

const serviceArb = (n: number) =>
  fc
    .record({
      kind: fc.constantFrom('package' as const, 'addon' as const),
      name: fc.constantFrom('Signature Hand Wash', 'Express Hand Wash', 'Wax', 'Tire shine', 'Ceramic Tint', 'Interior Detail'),
      publicName: fc.option(fc.constantFrom('Signature', 'The Works'), { nil: null }),
      sort: fc.integer({ min: 0, max: 50 }),
      category: fc.constantFrom('wash', 'addons', 'tint'),
      active: fc.boolean(),
      quoteOnly: fc.boolean(),
      priceCents: fc.constantFrom(0, 2500, 4000),
      cells: fc.dictionary(fc.constantFrom(...CLASSES.map((c) => c.key)), cellArb, { maxKeys: 5 }),
    })
    .map((s) => ({ ...s, id: sid(n), name: `${s.name} ${n}` }))

const libArb: fc.Arbitrary<Lib> = fc
  .tuple(fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), fc.integer({ min: 1, max: 5 }))
  .chain(([active, count]) => fc.tuple(fc.constant(active), fc.tuple(...Array.from({ length: count }, (_, i) => serviceArb(i + 1)))))
  .map(([active, services]) => ({ active, services }))

/** A second state of the same library: same services and sizes, anything else may change. */
const nextArb = (l: Lib): fc.Arbitrary<Lib> =>
  fc
    .tuple(fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), fc.tuple(...l.services.map((_, i) => serviceArb(i + 1))))
    .map(([active, services]) => ({ active, services: services.map((s, i) => ({ ...s, id: l.services[i]!.id })) }))

/** A shop's own items (never Oasis's): random names and prices, with and without the shop's tax. */
const shopArb = fc.array(fc.record({ name: fc.constantFrom('Air freshener', 'Gift card', 'Coffee', 'Wiper blades'), cents: fc.integer({ min: 0, max: 5000 }), variations: fc.integer({ min: 1, max: 3 }) }), {
  maxLength: 4,
})

function simRig() {
  const clock = new FixedClock('2026-10-13T14:00:00Z')
  const store = new SquareSimStore(clock, { locationId: LOC })
  const sim = new SquareSimApi(store, { tokens: ['t-items-0001'] })
  const api = createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 't-items-0001', fetch: simFetch(sim), sleeper: { sleep: async () => undefined } }))
  // every Square call that changes something, with what it sent
  const writes: Array<{ path: string; key: string | undefined; body: Record<string, unknown> }> = []
  const spied: SquareApi = {
    ...api,
    catalog: {
      ...api.catalog,
      upsert: async (key, object) => {
        writes.push({ path: 'upsert', key, body: object })
        return api.catalog.upsert(key, object)
      },
      batchUpsert: async (key, batches) => {
        writes.push({ path: 'batchUpsert', key, body: { batches } })
        return api.catalog.batchUpsert(key, batches)
      },
      delete: async (id) => {
        writes.push({ path: 'delete', key: undefined, body: { id } })
        return api.catalog.delete(id)
      },
    },
  }
  return { clock, store, sim, api: spied, writes }
}

let ids = 0
const newId = () => `10000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`

async function shopItems(r: ReturnType<typeof simRig>, shop: Array<{ name: string; cents: number; variations: number }>): Promise<string[]> {
  const made: string[] = []
  for (const [i, s] of shop.entries()) {
    const res = await r.api.catalog.upsert(`ct_shop${i}${'0'.repeat(30)}`.slice(0, 35) as never, {
      type: 'ITEM',
      id: '#shop',
      item_data: {
        name: s.name,
        variations: Array.from({ length: s.variations }, (_, j) => ({
          type: 'ITEM_VARIATION',
          id: `#sv${j}`,
          item_variation_data: { item_id: '#shop', name: `Size ${j}`, pricing_type: 'FIXED_PRICING', price_money: { amount: s.cents + j, currency: 'USD' } },
        })),
      },
    })
    made.push(res.object.id)
  }
  r.writes.length = 0
  return made
}

const tax = (rateDbp = 6625): Promise<TaxCheck> => Promise.resolve(decideTax([], { locationId: LOC, rateDbp, rounding: 'half_even', mode: 'auto', chosenTaxId: null, ownTaxId: null }))

async function taxFor(api: SquareApi, store: LinkStore, rateDbp = 6625): Promise<TaxCheck> {
  const own = store.all().find((l) => l.kind === 'tax' && !l.adopted)?.objectId ?? null
  const taxes = (await api.catalog.search({ object_types: ['TAX'] })).items
  return decideTax(taxes, { locationId: LOC, rateDbp, rounding: 'half_even', mode: 'auto', chosenTaxId: null, ownTaxId: own })
}

/** Everything linked read back, plus every item carrying a marker: what the nightly drift run sees. */
async function fullRemote(api: SquareApi, store: LinkStore): Promise<RemoteView> {
  const linked = store.all().filter((l) => l.objectId && (l.kind === 'item' || l.kind === 'category')).map((l) => l.objectId!)
  const got = (await api.catalog.batchRetrieve(linked, { include_deleted_objects: true })).objects
  const byId = new Map(got.map((o) => [o.id, o]))
  const items = new Map(got.filter((o) => o.type === 'ITEM').map((o) => [o.id, o]))
  const categories = new Map(got.filter((o) => o.type === 'CATEGORY').map((o) => [o.id, o]))
  const gone = new Set(linked.filter((id) => !byId.has(id) || byId.get(id)!.is_deleted))
  const all = (await api.catalog.search({ object_types: ['ITEM'] })).items
  const marked = all.filter((o) => (o.item_data?.variations ?? []).some((v) => parseMarker(v.item_variation_data?.user_data)))
  return { items, categories, gone, marked }
}

async function sync(r: ReturnType<typeof simRig>, store: LinkStore, l: Lib, o: { remote?: boolean } = {}) {
  const lib = desiredLibrary(input(l))
  const t = await taxFor(r.api, store)
  return runEngine({ api: r.api, environment: 'sim', locationId: LOC, lib, tax: t, store, newId, now: r.clock.now(), remote: o.remote ? await fullRemote(r.api, store) : undefined })
}

async function nothingLeft(r: ReturnType<typeof simRig>, store: LinkStore, l: Lib): Promise<void> {
  const lib = desiredLibrary(input(l))
  const t = await taxFor(r.api, store)
  expect(planSetup(lib, store.all(), t)).toEqual([])
  expect(planItems(lib, { locationId: LOC, links: store.all() })).toEqual([])
  const remote = await fullRemote(r.api, store)
  expect(planSetup(lib, store.all(), t, remote)).toEqual([])
  expect(planItems(lib, { locationId: LOC, links: store.all(), remote })).toEqual([])
}

/** The invariants of what Square holds after a sync. */
function checkSquare(r: ReturnType<typeof simRig>, store: LinkStore, l: Lib, foreign: Map<string, string>): void {
  const inp = input(l)
  const lib = desiredLibrary(inp)
  // never a delete, and nothing Square holds was deleted (no variation dropped from an item)
  expect(r.writes.filter((w) => w.path === 'delete')).toEqual([])
  expect([...r.store.items.deleted.keys()]).toEqual([])
  // every object written is linked or new
  const linked = new Set(store.all().map((x) => x.objectId).filter(Boolean))
  for (const w of r.writes) {
    const top = w.body as { id: string; item_data?: { variations?: Array<{ id: string }> } }
    expect(top.id.startsWith('#') || linked.has(top.id), `wrote ${top.id}`).toBe(true)
    expect(foreign.has(top.id)).toBe(false)
    expect((w.key ?? '').length).toBeLessThanOrEqual(SQUARE_KEY_MAX)
  }
  // the shop's items are untouched
  for (const [id, before] of foreign) expect(JSON.stringify(r.store.items.view(id))).toBe(before)
  // each sold service: one item, our location only, prices by the rule, VARIABLE exactly for ranges, hidden sizes nowhere
  for (const item of lib.items) {
    const link = store.all().find((x) => x.kind === 'item' && x.serviceId === item.serviceId)
    if (item.archived) {
      if (link?.objectId) expect(r.store.items.view(link.objectId)!.item_data).toMatchObject({ is_archived: true })
      continue
    }
    expect(link?.objectId, item.name).toBeTruthy()
    const sq = r.store.items.view(link!.objectId!)! as unknown as WireCatalogObject
    expect(sq).toMatchObject({ present_at_all_locations: false, present_at_location_ids: [LOC] })
    expect(sq.item_data).toMatchObject({ name: item.name, is_archived: false, product_type: 'REGULAR' })
    const vs = sq.item_data!.variations!
    for (const d of item.variations) {
      const v = vs.find((x) => x.item_variation_data?.user_data === d.marker)
      if (!d.present) {
        if (v) expect(v.present_at_all_locations === false && !(v.present_at_location_ids ?? []).length, `${d.name} hidden`).toBe(true)
        continue
      }
      expect(v, `${item.name} · ${d.name}`).toBeDefined()
      expect(v).toMatchObject({ present_at_all_locations: false, present_at_location_ids: [LOC] })
      if (d.classKey) {
        const p = classPrice(inp.book, item.serviceId, d.classKey)
        if (p.maxCents !== null && p.maxCents > p.cents) {
          expect(v!.item_variation_data).toMatchObject({ pricing_type: 'VARIABLE_PRICING' })
          expect(v!.item_variation_data!.price_money).toBeUndefined()
        } else expect(v!.item_variation_data).toMatchObject({ pricing_type: 'FIXED_PRICING', price_money: { amount: p.cents } })
      } else expect(v!.item_variation_data!.price_money!.amount).toBe(l.services.find((s) => s.id === item.serviceId)!.priceCents)
    }
  }
}

describe('the desired library', () => {
  const svc = (o: Partial<Lib['services'][number]> = {}): Lib['services'][number] => ({
    id: sid(1),
    kind: 'package',
    name: 'Signature Hand Wash',
    publicName: null,
    sort: 1,
    category: 'wash',
    active: true,
    quoteOnly: false,
    priceCents: 4000,
    cells: {},
    ...o,
  })
  const all = [true, true, true, true, true]

  it('one variation per size at the price Oasis charges (estimated sizes at the starting price; a range is VARIABLE)', () => {
    const lib = desiredLibrary(input({ active: [true, true, true, true, false], services: [svc({ cells: { compact_car: { cents: 4000, maxCents: null }, large_suv: { cents: 22900, maxCents: 27900 } } })] }))
    const item = lib.items[0]!
    expect(item).toMatchObject({ archived: false, archiveReason: null, categoryKey: 'wash', name: 'Signature Hand Wash' })
    expect(item.variations.map((v) => [v.classKey, v.name, v.pricing, v.present])).toEqual([
      ['compact_car', 'Compact car', { type: 'FIXED', cents: 4000 }, true],
      ['large_car', 'Large car', { type: 'FIXED', cents: 4000 }, true],
      ['compact_suv', 'Compact SUV', { type: 'FIXED', cents: 4000 }, true],
      ['large_suv', 'Large SUV · $229–$279', { type: 'VARIABLE', cents: 22900, maxCents: 27900 }, true],
      ['truck', 'Truck', { type: 'FIXED', cents: 4000 }, false],
      [null, 'Regular', { type: 'FIXED', cents: 4000 }, false],
    ])
    expect(item.variations[0]!.marker).toBe(`oasis:v1:${sid(1)}:compact_car`)
    expect(lib.categories).toEqual([
      { key: 'wash', name: 'Wash' },
      { key: OASIS_CATEGORY_KEY, name: 'Oasis' },
    ])
  })

  it('a service without prices by size is one "Regular" variation; off, quote-only and unpriced services are archived', () => {
    const lib = desiredLibrary(
      input({
        active: all,
        services: [
          svc({ id: sid(1) }),
          svc({ id: sid(2), active: false }),
          svc({ id: sid(3), quoteOnly: true }),
          svc({ id: sid(4), priceCents: 0 }),
          svc({ id: sid(5), priceCents: 0, cells: { truck: { cents: 0, maxCents: null } } }),
        ],
      }),
    )
    expect(lib.items.map((i) => [i.serviceId, i.archiveReason])).toEqual([
      [sid(1), null],
      [sid(2), 'off'],
      [sid(3), 'quote_only'],
      [sid(4), 'unpriced'],
      [sid(5), null],
    ])
    expect(lib.items[0]!.variations.filter((v) => v.present).map((v) => [v.name, v.pricing])).toEqual([['Regular', { type: 'FIXED', cents: 4000 }]])
    // a $0 price set by size is a price (sold at $0 at that size, the starting price elsewhere)
    expect(lib.items[4]!.variations.filter((v) => v.present).map((v) => [v.classKey, v.pricing])).toEqual(
      CLASSES.map((c) => [c.key, { type: 'FIXED', cents: 0 }]),
    )
    expect(parseMarker(markerOf(sid(4), null))).toEqual({ serviceId: sid(4), classKey: null })
    expect(parseMarker('oasis:v1:not-a-service:x')).toBeNull()
    expect(parseMarker('something else')).toBeNull()
    expect(variationName('Compact car', { type: 'VARIABLE', cents: 22950, maxCents: 27900 })).toBe('Compact car · $229.50–$279')
  })
})

describe('the sync against the simulator (property tests)', () => {
  it('converges, never deletes, never writes a foreign id, follows the price rule', async () => {
    const seen = { created: 0, variable: 0, archived: 0 }
    await fc.assert(
      fc.asyncProperty(libArb, shopArb, async (l, shop) => {
        const r = simRig()
        const foreignIds = await shopItems(r, shop)
        const foreign = new Map(foreignIds.map((id) => [id, JSON.stringify(r.store.items.view(id))]))
        const store = memoryLinkStore()
        const res = await sync(r, store, l)
        expect(res.status).toBe('done')
        expect(res.failures).toEqual([])
        checkSquare(r, store, l, foreign)
        await nothingLeft(r, store, l)
        seen.created += res.created
        seen.variable += [...r.store.catalog.values()].filter((o) => (o.item_variation_data as { pricing_type?: string } | undefined)?.pricing_type === 'VARIABLE_PRICING').length
        seen.archived += desiredLibrary(input(l)).items.filter((i) => i.archived).length
        // a second run sends nothing
        r.writes.length = 0
        const again = await sync(r, store, l, { remote: true })
        expect(again.writes).toBe(0)
        expect(r.writes).toEqual([])
      }),
      { numRuns: 40 },
    )
    // the random libraries really exercised creates, ranges, hidden sizes and archived services
    expect(seen.created).toBeGreaterThan(10)
    expect(seen.variable).toBeGreaterThan(0)
    expect(seen.archived).toBeGreaterThan(0)
  })

  it('a second state of the library (prices, sizes on and off, renames, archive) converges too and keeps variation ids', async () => {
    let hidden = 0
    let kept = 0
    await fc.assert(
      fc.asyncProperty(
        libArb.chain((l) => fc.tuple(fc.constant(l), nextArb(l), nextArb(l))),
        shopArb,
        async ([l1, l2, l3], shop) => {
          const r = simRig()
          const foreign = new Map((await shopItems(r, shop)).map((id) => [id, JSON.stringify(r.store.items.view(id))]))
          const store = memoryLinkStore()
          await sync(r, store, l1)
          const before = new Map(store.all().filter((x) => x.kind === 'variation').map((x) => [`${x.serviceId}:${x.classKey ?? ''}`, x.objectId]))
          for (const l of [l2, l3]) {
            const res = await sync(r, store, l)
            expect(res.failures).toEqual([])
            checkSquare(r, store, l, foreign)
            await nothingLeft(r, store, l)
          }
          // a variation once made keeps its id through every change (a size off is hidden, never dropped)
          for (const [k, id] of before) {
            const now = store.all().find((x) => x.kind === 'variation' && `${x.serviceId}:${x.classKey ?? ''}` === k)
            expect(now?.objectId, k).toBe(id)
            kept++
          }
          hidden += store.all().filter((x) => x.state === 'hidden').length
        },
      ),
      { numRuns: 30 },
    )
    expect(hidden).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(10)
  })

  it('keeps the variations staff added to an Oasis item, and puts back what staff changed on Oasis’s fields', async () => {
    await fc.assert(
      fc.asyncProperty(libArb, fc.integer({ min: 0, max: 99_999 }), async (l, staffCents) => {
        const r = simRig()
        const store = memoryLinkStore()
        await sync(r, store, l)
        const itemLink = store.all().find((x) => x.kind === 'item' && x.objectId && x.state === 'synced')
        if (!itemLink) return
        // staff add a size of their own and change an Oasis price in the Square Dashboard
        const cur = r.store.items.view(itemLink.objectId!)! as unknown as WireCatalogObject
        const vs = cur.item_data!.variations!
        const ours = vs.find((v) => v.present_at_location_ids?.includes(LOC) && v.item_variation_data?.pricing_type === 'FIXED_PRICING')
        await r.api.catalog.upsert(`ct_staff${'0'.repeat(27)}` as never, {
          ...cur,
          item_data: {
            ...cur.item_data,
            variations: [
              ...vs.map((v) =>
                v.id === ours?.id ? { ...v, item_variation_data: { ...v.item_variation_data, price_money: { amount: (v.item_variation_data?.price_money?.amount ?? 0) + 1, currency: 'USD' } } } : v,
              ),
              {
                type: 'ITEM_VARIATION',
                id: '#staff',
                present_at_all_locations: false,
                present_at_location_ids: [LOC],
                item_variation_data: { item_id: cur.id, name: 'Staff special', pricing_type: 'FIXED_PRICING', price_money: { amount: staffCents, currency: 'USD' } },
              },
            ],
          },
        })
        const staffId = r.store.items.view(itemLink.objectId!)!.item_data as { variations: Array<{ id: string; item_variation_data: { name: string } }> }
        const staff = staffId.variations.find((v) => v.item_variation_data.name === 'Staff special')!
        r.writes.length = 0
        const res = await sync(r, store, l, { remote: true })
        if (ours) expect(res.changedInSquare.join('\n')).toMatch(/in Square; Oasis charges/)
        const after = r.store.items.view(itemLink.objectId!)!.item_data as { variations: Array<{ id: string; item_variation_data: { name: string; price_money: { amount: number } } }> }
        const kept = after.variations.find((v) => v.id === staff.id)
        expect(kept?.item_variation_data).toMatchObject({ name: 'Staff special', price_money: { amount: staffCents } })
        checkSquare(r, store, l, new Map())
        await nothingLeft(r, store, l)
      }),
      { numRuns: 25 },
    )
  })
})

describe('the tax gate', () => {
  it('a tax check that does not pass plans only "blocked" and writes nothing', async () => {
    const r = simRig()
    const t = decideTax(
      [{ type: 'TAX', id: 'SHOPTAX', present_at_all_locations: true, tax_data: { name: 'NJ', percentage: '7', inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', enabled: true } }],
      { locationId: LOC, rateDbp: 6625, rounding: 'half_even', mode: 'auto', chosenTaxId: null, ownTaxId: null },
    )
    expect(t.status).toBe('blocked')
    const l: Lib = { active: [true, true, true, true, true], services: [{ id: sid(1), kind: 'package', name: 'Wash', publicName: null, sort: 1, category: 'wash', active: true, quoteOnly: false, priceCents: 4000, cells: {} }] }
    const lib = desiredLibrary(input(l))
    expect(planSetup(lib, [], t)).toEqual([{ kind: 'blocked', detail: t.detail }])
    const res = await runEngine({ api: r.api, environment: 'sim', locationId: LOC, lib, tax: t, store: memoryLinkStore(), newId, now: r.clock.now() })
    expect(res).toMatchObject({ status: 'blocked', blocked: t.detail, writes: 0 })
    expect(r.writes).toEqual([])
    expect((await tax()).status).toBe('create')
  })

  it('Oasis’s own tax: an equal percentage written another way plans nothing; a field staff changed plans update_tax naming it', () => {
    const own = (o: Record<string, unknown>, pct = '7'): WireCatalogObject => ({
      type: 'TAX',
      id: 'OWNTAX',
      present_at_all_locations: false,
      present_at_location_ids: [LOC],
      tax_data: { name: 'Sales tax', percentage: pct, inclusion_type: 'ADDITIVE', calculation_phase: 'TAX_SUBTOTAL_PHASE', enabled: true, applies_to_custom_amounts: false, ...o },
    })
    const check = (t: WireCatalogObject) => decideTax([t], { locationId: LOC, rateDbp: 7000, rounding: 'half_even', mode: 'auto', chosenTaxId: null, ownTaxId: 'OWNTAX' })
    const link: LinkRow = { id: 'L-TAX', kind: 'tax', serviceId: null, classKey: null, categoryKey: null, objectId: 'OWNTAX', itemId: null, version: 1, desiredHash: null, contentHash: null, state: 'synced', adopted: false, error: null, pendingKey: null, pendingBody: null, pendingAt: null }
    const lib = desiredLibrary(input({ active: [true, true, true, true, true], services: [] }))
    const taxActions = (t: WireCatalogObject) => planSetup(lib, [link], check(t)).filter((a) => a.kind.endsWith('_tax'))
    expect(taxActions(own({}, '7'))).toEqual([])
    expect(taxActions(own({}, '7.0'))).toEqual([])
    expect(taxActions(own({}, '7.000'))).toEqual([])
    expect(taxActions(own({}, '6.625'))).toEqual([{ kind: 'update_tax', linkId: 'L-TAX', objectId: 'OWNTAX', percentage: '7', changed: [] }])
    expect(taxActions(own({ enabled: false }))).toEqual([{ kind: 'update_tax', linkId: 'L-TAX', objectId: 'OWNTAX', percentage: '7', changed: ['turned off'] }])
    expect(taxActions(own({ inclusion_type: 'INCLUSIVE', calculation_phase: 'TAX_TOTAL_PHASE' }))).toEqual([
      { kind: 'update_tax', linkId: 'L-TAX', objectId: 'OWNTAX', percentage: '7', changed: ['included in the price, not added to it', 'computed on the total, not the subtotal'] },
    ])
  })
})

describe('K4 review ITEMS-HARDEN: an item found again by its marker', () => {
  it('two marked items for one service: the oldest (created_at) is adopted, the other reported, whatever the search order', () => {
    const l: Lib = { active: [true, true, true, true, true], services: [{ id: sid(7), kind: 'package', name: 'Wash', publicName: null, sort: 1, category: 'wash', active: true, quoteOnly: false, priceCents: 4000, cells: {} }] }
    const lib = desiredLibrary(input(l))
    const marked = (id: string, created: string): WireCatalogObject => ({
      type: 'ITEM',
      id,
      created_at: created,
      item_data: { name: 'Wash', variations: [{ type: 'ITEM_VARIATION', id: `${id}-v`, item_variation_data: { item_id: id, name: 'Regular', user_data: markerOf(sid(7), null) } }] },
    } as WireCatalogObject)
    const remote: RemoteView = { items: new Map(), categories: new Map(), gone: new Set(), marked: [marked('NEWER', '2026-10-13T10:00:00Z'), marked('OLDER', '2026-10-01T10:00:00Z')] }
    const plan = planItems(lib, { locationId: LOC, links: [], remote })
    expect(plan.find((a) => a.kind === 'adopt_orphan')).toMatchObject({ itemId: 'OLDER' })
    expect(plan.filter((a) => a.kind === 'drift')).toHaveLength(1)
  })
})
