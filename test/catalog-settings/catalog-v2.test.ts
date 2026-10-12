// GET /public/catalog/v2 (ADR 0170 wave Q3d, design q-design-pricing §9): the catalog by vehicle size over the website catalog, the
// owner's defaults and a few more prices. Set cells only, member prices computed half up to whole dollars at the lowest % off of the
// tiers sold online that have a price, a tier without a current price not listed, nothing internal (ids, versions, Square fields,
// checkout URLs), the same cache header and query rule as v1, and v1 unchanged beside it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { WEBSITE_PLANS, WEBSITE_TINT_FILMS } from '../../db/seeds/website-catalog.js'
import { apiModules } from '../../src/http/modules.js'
import { putClassPrices } from '../../src/modules/catalog/class-prices.js'
import { putTier, putTierPrices, requireTier, type InclusionInput } from '../../src/modules/catalog/tiers.js'
import { PublicCatalogV2View } from '../../src/modules/public/catalog.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'

let t: TestDb
let app: TestApp
let clock: FixedClock
let locationId = ''

beforeAll(async () => {
  clock = new FixedClock(PARITY_NOW)
  t = await createTestDb({ clock, poolMax: 6 })
  app = await createTestApp({ testDb: t, modules: apiModules, env: { PUBLIC_WRITES_ENABLED: 'false' } })
})

beforeEach(async () => {
  clock.set(PARITY_NOW)
  await truncateAll(t.db)
  await runSeed({ db: t.db, clock, profile: 'catalog' })
  await runSeed({ db: t.db, clock, profile: 'website-catalog' })
  await runSeed({ db: t.db, clock, profile: 'pricing-defaults' })
  locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => {
  await app?.close()
  await t?.close()
})

const newId = () => createIdGenerator(clock)()
const get = (url: string) => app.app.inject({ method: 'GET', url: `/api/v1/${url}`, headers: { 'x-test-anonymous': '1' } })
const v2 = async () => {
  const r = await get('public/catalog/v2')
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

async function serviceId(name: string): Promise<string> {
  return (await t.db.selectFrom('services').select('id').where('location_id', '=', locationId).where('name', '=', name).executeTakeFirstOrThrow()).id
}

async function setPrices(rows: [string, Record<string, number | [number, number]>][]) {
  await t.db.transaction().execute(async (tx) => {
    const svc = await tx.selectFrom('services').select(['id', 'name', 'version']).where('location_id', '=', locationId).execute()
    await putClassPrices(tx, {
      locationId,
      userId: null,
      rows: rows.map(([name, cells]) => {
        const s = svc.find((x) => x.name === name)!
        return {
          serviceId: s.id,
          version: s.version,
          cells: Object.entries(cells).map(([k, v]) => (Array.isArray(v) ? { class: k, cents: v[0], maxCents: v[1] } : { class: k, cents: v, maxCents: null })),
        }
      }),
    })
  })
}

async function tier(key: string, patch: { memberDiscountBp?: number; inclusions?: InclusionInput[]; public?: boolean; maxVehicles?: number | null }) {
  await t.db.transaction().execute(async (tx) => {
    const cur = await requireTier(tx, locationId, key)
    await putTier(tx, { newId }, { locationId, key, expectedVersion: cur.version, fields: { ...cur, inclusions: cur.inclusions, ...patch } })
  })
}

async function tierPrices(key: string, cells: Record<string, number | null>) {
  await t.db.transaction().execute(async (tx) => {
    const cur = await requireTier(tx, locationId, key)
    await putTierPrices(tx, { newId, now: clock.now() }, {
      locationId,
      userId: null,
      rows: [{ tierKey: key, priceVersion: cur.priceVersion, cells: Object.entries(cells).map(([k, v]) => ({ class: k, monthlyCents: v })) }],
    })
  })
}

/** The owner's defaults, a few more prices by size, Gold 10% off including 4 Signature washes a cycle. */
async function priced() {
  await setPrices([
    ['Signature Hand Wash', { large_suv: 6000 }],
    ['Exterior Hand Wash', { compact_car: 3500, truck: 4500 }],
    ['Carbon window tint', { compact_car: [27500, 33500], compact_suv: [32300, 39500] }],
    ['Hand wax', { compact_car: 4700 }],
  ])
  const sig = await serviceId('Signature Hand Wash')
  const wax = await serviceId('Hand wax')
  await tier('gold', {
    memberDiscountBp: 1000,
    inclusions: [{ label: 'Signature washes', mode: 'per_cycle', perCycle: 4, autoApply: true, serviceIds: [sig] }],
  })
  await tier('vip', {
    memberDiscountBp: 2000,
    maxVehicles: 3,
    inclusions: [
      { label: 'Signature washes', mode: 'per_cycle', perCycle: null, autoApply: true, serviceIds: [sig] },
      { label: 'Wax every wash', mode: 'every_visit', perCycle: null, autoApply: true, serviceIds: [wax] },
    ],
  })
}

// nothing internal: ids, versions, Square fields, checkout links, tags, desk or online flags, people
const FORBIDDEN = /^id$|Id$|^version$|Version|checkout|sqsp|square|task|tags|bookable|^active$|visible|quoteOnly|vipInclusion|vipNote|customer|phone|email|plate|appointment|employee|_/i

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out))
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k)
      keysOf(x, out)
    }
  return out
}

describe('GET /public/catalog/v2', () => {
  it('lists every listed item with its prices at the sizes that have one, member prices half up, the tiers sold online, nothing internal', async () => {
    await priced()
    const r = await get('public/catalog/v2')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=60')
    const b = r.json()
    expect(PublicCatalogV2View.safeParse(b).success).toBe(true)
    expect(Object.keys(b).sort()).toEqual(
      ['addons', 'categories', 'currency', 'generatedAt', 'guestBookingFeeCents', 'guestFeeCollect', 'memberDisplay', 'quotes', 'services', 'tiers', 'vehicleClasses', 'version'].sort(),
    )
    expect(b).toMatchObject({ version: 2, currency: 'USD', guestBookingFeeCents: 2500, guestFeeCollect: 'counter' })
    expect(b.vehicleClasses).toEqual([
      { key: 'compact_car', label: 'Compact car', sort: 10 },
      { key: 'large_car', label: 'Large car', sort: 20 },
      { key: 'compact_suv', label: 'Compact SUV', sort: 30 },
      { key: 'large_suv', label: 'Large SUV', sort: 40 },
      { key: 'truck', label: 'Truck', sort: 50 },
    ])
    // VIP has no price: not sold online, so its 20% does not count; Gold's 10% is the members' figure
    expect(b.memberDisplay).toEqual({ discountBp: 1000 })
    const svc = (key: string) => b.services.find((s: { key: string }) => s.key === key)
    expect(svc('signature-hand-wash')).toEqual({
      key: 'signature-hand-wash',
      name: 'Signature Hand Wash',
      shortName: 'Signature Hand Wash',
      category: 'wash',
      description: 'Exterior + interior',
      durationMin: 45,
      prices: [
        { class: 'compact_car', cents: 4000, maxCents: null, memberCents: 3600, memberMaxCents: null },
        { class: 'large_suv', cents: 6000, maxCents: null, memberCents: 5400, memberMaxCents: null },
      ],
      fromCents: 4000,
      fromClass: 'compact_car',
      memberFromCents: 3600,
      tintFilm: null,
      includedIn: [{ tier: 'gold', mode: 'per_cycle', perCycle: 4 }],
    })
    // $31.50 and $40.50 round half up to whole dollars
    expect(svc('exterior-hand-wash').prices).toEqual([
      { class: 'compact_car', cents: 3500, maxCents: null, memberCents: 3200, memberMaxCents: null },
      { class: 'truck', cents: 4500, maxCents: null, memberCents: 4100, memberMaxCents: null },
    ])
    const film = WEBSITE_TINT_FILMS.find((f) => f.key === 'carbon')!
    expect(svc('carbon-window-tint')).toMatchObject({
      tintFilm: { key: 'carbon', label: film.label, vlt: [...film.vlt] },
      fromCents: 27500,
      fromClass: 'compact_car',
      memberFromCents: 24800,
      prices: [
        { class: 'compact_car', cents: 27500, maxCents: 33500, memberCents: 24800, memberMaxCents: 30200 },
        { class: 'compact_suv', cents: 32300, maxCents: 39500, memberCents: 29100, memberMaxCents: 35600 },
      ],
    })
    // an item without any price (no cell, a $0 base price) is not listed; one with a base price only has no cells and no size
    expect(svc('interior-detail')).toBeUndefined()
    const full = svc('full-detail')
    expect(full.prices).toEqual([])
    expect(full.fromClass).toBeNull()
    expect(full.fromCents).toBeGreaterThan(0)
    expect(b.addons.find((a: { key: string }) => a.key === 'hand-wax')).toMatchObject({
      prices: [{ class: 'compact_car', cents: 4700, maxCents: null, memberCents: 4200, memberMaxCents: null }],
      includedIn: [],
    })
    // set cells only, never a $0 cell standing for an empty one
    for (const it of [...b.services, ...b.addons])
      for (const p of it.prices) {
        expect(p.cents, it.key).toBeGreaterThan(0)
        expect(p.memberCents, it.key).toBeLessThanOrEqual(p.cents)
        expect(p.memberCents % 100, it.key).toBe(0)
      }
    expect(b.tiers).toEqual([
      {
        key: 'gold',
        name: 'Gold',
        colour: '#8A6D3B',
        sort: expect.any(Number),
        perks: WEBSITE_PLANS[0]!.perks,
        memberDiscountBp: 1000,
        vipBooking: false,
        householdCars: null,
        prices: [{ class: 'compact_car', monthlyCents: 12900 }],
        fromMonthlyCents: 12900,
        fromClass: 'compact_car',
        inclusions: [{ serviceKey: 'signature-hand-wash', mode: 'per_cycle', perCycle: 4, group: 1 }],
      },
    ])
    expect([...keysOf(b)].filter((k) => FORBIDDEN.test(k) && k !== 'version')).toEqual([])
    expect(JSON.stringify(b)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })

  it('a tier is listed once it has a current price; the lowest % off of the listed tiers is the members’ figure', async () => {
    await priced()
    await tierPrices('vip', { compact_car: 19900, large_suv: 24900 })
    const b = await v2()
    expect(b.tiers.map((x: { key: string }) => x.key)).toEqual(['gold', 'vip'])
    expect(b.memberDisplay.discountBp).toBe(1000)
    const vip = b.tiers[1]
    expect(vip).toMatchObject({
      vipBooking: true,
      householdCars: 3,
      memberDiscountBp: 2000,
      prices: [
        { class: 'compact_car', monthlyCents: 19900 },
        { class: 'large_suv', monthlyCents: 24900 },
      ],
      fromMonthlyCents: 19900,
      fromClass: 'compact_car',
      inclusions: [
        { serviceKey: 'signature-hand-wash', mode: 'per_cycle', perCycle: null, group: 1 },
        { serviceKey: 'hand-wax', mode: 'every_visit', perCycle: null, group: 2 },
      ],
    })
    const sig = b.services.find((s: { key: string }) => s.key === 'signature-hand-wash')
    expect(sig.includedIn).toEqual([
      { tier: 'gold', mode: 'per_cycle', perCycle: 4 },
      { tier: 'vip', mode: 'per_cycle', perCycle: null },
    ])
    // Gold off the website: VIP's 20% is the only figure left
    await tier('gold', { public: false })
    const c = await v2()
    expect(c.tiers.map((x: { key: string }) => x.key)).toEqual(['vip'])
    expect(c.memberDisplay.discountBp).toBe(2000)
    expect(c.services.find((s: { key: string }) => s.key === 'signature-hand-wash').memberFromCents).toBe(3200)
  })

  it('numbers the inclusions: two of 4 a month stay apart, one of 4 a month over two items shares its group (review F4)', async () => {
    await priced()
    const [sig, ext, wax, tint] = await Promise.all(['Signature Hand Wash', 'Exterior Hand Wash', 'Hand wax', 'Carbon window tint'].map(serviceId))
    await tier('gold', {
      inclusions: [
        { label: 'Signature washes', mode: 'per_cycle', perCycle: 4, autoApply: true, serviceIds: [sig!] },
        { label: 'Exterior washes', mode: 'per_cycle', perCycle: 4, autoApply: true, serviceIds: [ext!] },
        { label: 'Wax or tint', mode: 'per_cycle', perCycle: 2, autoApply: false, serviceIds: [wax!, tint!] },
      ],
    })
    const gold = (await v2()).tiers.find((x: { key: string }) => x.key === 'gold')
    expect(gold.inclusions).toEqual([
      { serviceKey: 'signature-hand-wash', mode: 'per_cycle', perCycle: 4, group: 1 },
      { serviceKey: 'exterior-hand-wash', mode: 'per_cycle', perCycle: 4, group: 2 },
      // an inclusion's items in the catalog's order (packages, then add-ons), whatever order staff picked them in
      { serviceKey: 'carbon-window-tint', mode: 'per_cycle', perCycle: 2, group: 3 },
      { serviceKey: 'hand-wax', mode: 'per_cycle', perCycle: 2, group: 3 },
    ])
  })

  it('a size turned off drops out with its prices; a tier priced only at sizes that are off is not listed', async () => {
    await priced()
    await tierPrices('vip', { compact_suv: 21900 })
    let b = await v2()
    expect(b.tiers.map((x: { key: string }) => x.key)).toEqual(['gold', 'vip'])
    await t.db.updateTable('vehicle_classes').set({ active: false }).where('key', '=', 'compact_suv').execute()
    b = await v2()
    expect(b.vehicleClasses.map((c: { key: string }) => c.key)).toEqual(['compact_car', 'large_car', 'large_suv', 'truck'])
    expect(b.services.find((s: { key: string }) => s.key === 'carbon-window-tint').prices.map((p: { class: string }) => p.class)).toEqual(['compact_car'])
    expect(b.tiers.map((x: { key: string }) => x.key)).toEqual(['gold'])
  })

  it('carries no Square ids, checkout links or price versions even when the rows have them', async () => {
    await priced()
    await t.db.updateTable('membership_plans').set({ checkout_url: 'https://oasis.squarespace.com/checkout/subscribe?x=1', square_plan_id: 'SQPLANXYZ123' }).where('key', '=', 'gold').execute()
    await t.db.updateTable('membership_tier_prices').set({ square_variation_id: 'SQVARIATION987', square_state: 'synced' }).where('superseded_at', 'is', null).execute()
    const text = JSON.stringify(await v2())
    for (const bad of ['squarespace', 'SQPLANXYZ123', 'SQVARIATION987', 'synced', 'priceVersion', 'checkout']) expect(text).not.toContain(bad)
  })

  it('takes no query (the 60-second cache in front cannot be bypassed) and leaves v1 as it was', async () => {
    await priced()
    expect((await get('public/catalog/v2?x=1')).statusCode).toBe(422)
    const v1 = (await get('public/catalog')).json()
    expect(Object.keys(v1).sort()).toEqual(['addons', 'categories', 'currency', 'generatedAt', 'guestBookingFeeCents', 'guestMarkupPct', 'plans', 'quotes', 'services', 'tint'].sort())
    // v1 still lists every active public tier (a tier without a price with priceCents null)
    expect(v1.plans.map((p: { key: string; priceCents: number | null }) => [p.key, p.priceCents])).toEqual([
      ['gold', 12900],
      ['vip', null],
    ])
  })

  it('says how a guest pays the booking fee', async () => {
    await t.db
      .insertInto('settings')
      .values({ location_id: locationId, key: 'booking.guest_fee', value: JSON.stringify({ cents: 3000, collect: 'link' }) } as never)
      .onConflict((oc) => oc.columns(['location_id', 'key']).doUpdateSet({ value: JSON.stringify({ cents: 3000, collect: 'link' }) } as never))
      .execute()
    expect(await v2()).toMatchObject({ guestBookingFeeCents: 3000, guestFeeCollect: 'link' })
  })
})
