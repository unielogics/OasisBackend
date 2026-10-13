// The `website-catalog` seed profile (ADR 0160, plan A; reworked by ADR 0170) over production's `catalog` profile, the
// `pricing-defaults` profile, and the public catalog (v1) they feed: the website's washes, add-ons, tint packages, details,
// quote-only services and the Gold/VIP tiers become the catalog with NO prices (the website's figures were wrong, plan decision 9);
// the dashboard design's other entries are deactivated (never deleted); a second run changes nothing; pricing-defaults fills only
// the two cells the owner gave; GET /public/catalog is built from the prices by size with no internal field.
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { PRICING_DEFAULTS } from '../../db/seeds/pricing-defaults.js'
import { WEBSITE_DURATIONS_CHOSEN, WEBSITE_PLANS, WEBSITE_SERVICES, WEBSITE_TINT_FILMS } from '../../db/seeds/website-catalog.js'
import { apiModules } from '../../src/http/modules.js'
import { putClassPrices } from '../../src/modules/catalog/class-prices.js'
import { putTier, putTierPrices, requireTier } from '../../src/modules/catalog/tiers.js'
import { inclusionCovers, loadPlans } from '../../src/modules/memberships/plans.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { getSetting } from '../../src/platform/settings.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { edt, makeAppointment, makeCustomer } from '../domain-schema/helpers.js'
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
  locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
})

afterAll(async () => {
  await app?.close()
  await t?.close()
})

const seed = (): Promise<string[]> => runSeed({ db: t.db, clock, profile: 'website-catalog' })

async function services() {
  return t.db
    .selectFrom('services')
    .selectAll()
    .where('location_id', '=', locationId)
    .orderBy('kind')
    .orderBy('sort')
    .orderBy('name')
    .execute()
}

const byName = async (name: string) => (await services()).find((s) => s.name === name)!

/** Everything a run could touch, to compare two runs. */
async function snapshot() {
  return {
    services: await services(),
    tasks: await t.db.selectFrom('checklist_tasks').selectAll().orderBy('id').execute(),
    plans: await t.db.selectFrom('membership_plans').selectAll().orderBy('key').execute(),
    settings: await t.db.selectFrom('settings').select(['key', 'value', 'version']).orderBy('key').execute(),
    categories: await t.db.selectFrom('catalog_categories').selectAll().orderBy('key').execute(),
    audit: (await t.db.selectFrom('audit_log').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n,
    events: (await t.db.selectFrom('realtime_events').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n,
  }
}

const newId = () => createIdGenerator(clock)()

/** Sets prices by size the way Settings does (all or nothing, with each row's version). */
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

describe('website-catalog seed', () => {
  it('makes the website’s services the active catalog with categories, descriptions, VIP inclusion and durations, and no prices', async () => {
    const before = await services()
    const wax = before.find((s) => s.name === 'Wax')!
    const fullDetail = before.find((s) => s.name === 'Full Detail')!
    const waxTasks = await t.db.selectFrom('checklist_tasks').select('label').where('service_id', '=', wax.id).orderBy('position').execute()
    const tintMatrix = await getSetting(t.db, locationId, 'catalog.tint_matrix')
    const markup = await getSetting(t.db, locationId, 'catalog.guest_markup_pct')
    await seed()
    const after = await services()
    const active = after.filter((s) => s.active)
    expect(active.filter((s) => s.kind === 'package').map((s) => s.name)).toEqual([
      'Signature Hand Wash',
      'Exterior Hand Wash',
      'Carbon window tint',
      'Ceramic window tint',
      'Interior detail',
      'Full detail',
      'Windshield replacement',
      'Rim powder coating',
      'Chrome delete',
      'Car key copies',
    ])
    expect(active.filter((s) => s.kind === 'addon').map((s) => s.name)).toEqual([
      'Hand wax',
      'Engine bay wash',
      'Leather conditioning',
      'Stain removal',
      'Tire shine & dressing',
      'Rain-repellent glass',
      'Odor removal',
      'Pet hair removal',
      'Interior deep clean',
    ])
    expect(await byName('Signature Hand Wash')).toMatchObject({
      category: 'wash',
      public_name: 'Signature Hand Wash',
      description: 'Exterior + interior',
      duration_min: 45,
      price_cents: 0,
      member_price_cents: null,
      guest_price_cents: null,
      vip_inclusion: 'included',
      quote_only: false,
      visible_online: true,
    })
    expect(await byName('Ceramic window tint')).toMatchObject({ category: 'tint', tags: ['tint', 'ceramic'], member_price_cents: null, price_cents: 0 })
    expect(await byName('Car key copies')).toMatchObject({ category: 'quote', quote_only: true, price_cents: 0 })
    expect(await byName('Leather conditioning')).toMatchObject({ category: 'addons', vip_inclusion: 'allowance', vip_note: '2× / mo' })
    // an adopted row keeps the price it had: the seed never writes a price
    const hand = await byName('Hand wax')
    expect(hand).toMatchObject({ id: wax.id, price_cents: wax.price_cents, version: wax.version + 1 })
    expect(await t.db.selectFrom('checklist_tasks').select('label').where('service_id', '=', wax.id).orderBy('position').execute()).toEqual(waxTasks)
    expect((await byName('Full detail')).id).toBe(fullDetail.id)
    expect((await byName('Engine bay wash')).id).toBe(before.find((s) => s.name === 'Engine bay cleaning')!.id)
    const sig = await byName('Signature Hand Wash')
    expect((await t.db.selectFrom('checklist_tasks').select('label').where('service_id', '=', sig.id).orderBy('position').execute()).map((x) => x.label)).toEqual(
      WEBSITE_SERVICES.find((s) => s.name === 'Signature Hand Wash')!.tasks,
    )
    const off = after.filter((s) => !s.active).map((s) => s.name).sort()
    expect(off).toEqual(
      [
        'Ceramic Maintenance + Wax',
        'Executive Detail',
        'Executive Detail + Ceramic',
        'Exotic Detail Package',
        'Express Hand Wash',
        'Family Wash + Pet Hair',
        'Premium Hand Wash + Interior',
        'Premium Hand Wash + Interior Refresh',
        'Ceramic maintenance',
        'Clay bar',
        'Wheel deep clean',
      ].sort(),
    )
    // no price anywhere: no cell, no tier price, the markup and the tint matrix untouched
    expect(await t.db.selectFrom('service_class_prices').select('service_id').execute()).toEqual([])
    expect(await t.db.selectFrom('membership_tier_prices').select('id').execute()).toEqual([])
    expect(await getSetting(t.db, locationId, 'catalog.tint_matrix')).toEqual(tintMatrix)
    expect(await getSetting(t.db, locationId, 'catalog.guest_markup_pct')).toEqual(markup)
    expect((await getSetting(t.db, locationId, 'catalog.tint_films')).value).toEqual(WEBSITE_TINT_FILMS)
    const plans = await t.db.selectFrom('membership_plans').select(['key', 'name', 'public', 'perks', 'monthly_price_cents', 'checkout_url']).where('public', '=', true).orderBy('sort').execute()
    expect(plans).toEqual(WEBSITE_PLANS.map((p) => ({ key: p.key, name: p.name, public: true, perks: p.perks, monthly_price_cents: null, checkout_url: null })))
    const actions = await t.db.selectFrom('audit_log').select(['action', 'actor_name']).execute()
    expect(new Set(actions.map((a) => a.actor_name))).toEqual(new Set(['Seed (website-catalog)']))
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(['catalog.seed.create', 'catalog.seed.update', 'catalog.seed.deactivate', 'catalog.seed.plan', 'settings.update']),
    )
    expect(WEBSITE_DURATIONS_CHOSEN).toMatchObject({ 'Carbon window tint': 180, 'Interior detail': 150, 'Full detail': 240, 'Car key copies': 30 })
  })

  it('is idempotent: a second run writes nothing (same versions, no audit row, no event)', async () => {
    await seed()
    const first = await snapshot()
    await seed()
    expect(await snapshot()).toEqual(first)
  })

  it('runs on an empty catalog too, and puts back what an owner edit changed (by design: run once, then edit in Settings)', async () => {
    await sql`delete from checklist_tasks`.execute(t.db)
    await sql`delete from services`.execute(t.db)
    await seed()
    expect((await services()).filter((s) => s.active)).toHaveLength(19)
    const sig = await byName('Signature Hand Wash')
    await t.db.updateTable('services').set({ description: 'Edited', visible_online: false }).where('id', '=', sig.id).execute()
    await seed()
    expect(await byName('Signature Hand Wash')).toMatchObject({ description: 'Exterior + interior', visible_online: true, version: sig.version + 1 })
  })

  it('says which inclusions of the active tiers cover no active service after the run (the owner aligns them in Settings)', async () => {
    const lines: string[] = []
    await runSeed({ db: t.db, clock, profile: 'website-catalog', log: (l) => lines.push(l) })
    const plans = await loadPlans(t.db, locationId)
    const active = (await services()).filter((s) => s.active)
    const coverage = Object.fromEntries(
      plans.flatMap((p) => p.inclusions.map((r) => [`${p.key}: ${r.label}`, active.filter((s) => inclusionCovers(r, s.id)).map((s) => s.name).sort()])),
    )
    // the tiers the website sells get the inclusions their perks promise (review Q4 F1); the other tiers' inclusions name the
    // design's services they covered when they were made (the website's washes are new rows)
    const washes = ['Exterior Hand Wash', 'Signature Hand Wash']
    expect(coverage).toEqual({
      'essential: Express wash': [],
      'gold: Hand washes': washes,
      'vip: Hand washes': washes,
      'vip: Wax every wash': ['Hand wax'],
      'vip: Engine bay every wash': ['Engine bay wash'],
      'vip: Leather conditioning': ['Leather conditioning'],
      'vip: Stain removal': ['Stain removal'],
      'exotic: Hand wash': [],
    })
    expect(lines.filter((l) => l.startsWith('WARNING'))).toEqual(
      ['essential: Express wash', 'exotic: Hand wash'].map(
        (r) => `WARNING website-catalog: inclusion "${r}" covers no active service; align it in Settings → Memberships before members redeem (ADR 0170)`,
      ),
    )
    // the owner's own inclusions are never replaced by a later run
    await t.db.transaction().execute(async (tx) => {
      const gold = await requireTier(tx, locationId, 'gold')
      const sig = await byName('Signature Hand Wash')
      await putTier(tx, { newId }, {
        locationId,
        key: 'gold',
        expectedVersion: gold.version,
        fields: {
          ...gold,
          inclusions: [{ id: gold.inclusions[0]!.id, label: 'Hand wash', mode: 'per_cycle', perCycle: 4, autoApply: true, serviceIds: [sig.id] }],
        },
      })
    })
    const again: string[] = []
    await runSeed({ db: t.db, clock, profile: 'website-catalog', log: (l) => again.push(l) })
    expect((await loadPlans(t.db, locationId)).find((p) => p.key === 'gold')!.inclusions.map((r) => r.label)).toEqual(['Hand wash'])
    expect(again.filter((l) => l.includes('gold:'))).toEqual([])
  })

  it('re-derives the categories of visits not yet finished', async () => {
    const full = await byName('Full Detail')
    const f = { location: { id: locationId } as never, locationId, newId: createIdGenerator(clock) }
    const customerId = await makeCustomer(t.db, f, { name: 'Cat Test' })
    const id = await makeAppointment(t.db, f, { customerId, serviceId: full.id, start: edt('2026-06-14', '10:00') })
    expect((await t.db.selectFrom('appointments').select('categories').where('id', '=', id).executeTakeFirstOrThrow()).categories).toEqual([])
    await seed()
    expect((await t.db.selectFrom('appointments').select('categories').where('id', '=', id).executeTakeFirstOrThrow()).categories).toEqual(['detail'])
  })
})

describe('pricing-defaults seed', () => {
  const runDefaults = (log?: (l: string) => void) => runSeed({ db: t.db, clock, profile: 'pricing-defaults', ...(log ? { log } : {}) })

  it('sets Signature Hand Wash at Compact car $40 and Gold at Compact car $129/month, audited; % off stays 0', async () => {
    await seed()
    const lines: string[] = []
    await runDefaults((l) => lines.push(l))
    const sig = await byName('Signature Hand Wash')
    expect(await t.db.selectFrom('service_class_prices').select(['service_id', 'class_key', 'price_cents', 'max_cents']).execute()).toEqual([
      { service_id: sig.id, class_key: 'compact_car', price_cents: 4000, max_cents: null },
    ])
    expect(sig.price_cents).toBe(4000)
    const gold = await requireTier(t.db, locationId, 'gold')
    expect(gold).toMatchObject({ memberDiscountBp: 0, priceVersion: 2, fromMonthlyCents: 12900 })
    expect(gold.prices.map((p) => [p.class, p.monthlyCents, p.squareState])).toEqual([['compact_car', 12900, 'pending']])
    const actions = await t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('actor_name', '=', 'Seed (pricing-defaults)').execute()
    expect(actions.map((a) => a.action).sort()).toEqual(['catalog.price.update', 'catalog.tier_price.update'])
    expect(lines.filter((l) => l.startsWith('pricing-defaults:'))).toEqual(['pricing-defaults: size compact_car, wash Signature Hand Wash, tier Gold'])
    expect(PRICING_DEFAULTS).toMatchObject({ washCents: 4000, tierMonthlyCents: 12900, classKey: 'compact_car' })
  })

  it('is idempotent and fills only empty cells: an owner’s price is never changed', async () => {
    await seed()
    const sig = await byName('Signature Hand Wash')
    await setPrices([['Signature Hand Wash', { compact_car: 4500, large_suv: 6500 }]])
    await runDefaults()
    expect(await t.db.selectFrom('service_class_prices').select(['class_key', 'price_cents']).where('service_id', '=', sig.id).orderBy('class_key').execute()).toEqual([
      { class_key: 'compact_car', price_cents: 4500 },
      { class_key: 'large_suv', price_cents: 6500 },
    ])
    const first = await snapshot()
    const tierRows = await t.db.selectFrom('membership_tier_prices').selectAll().execute()
    const lines: string[] = []
    await runDefaults((l) => lines.push(l))
    expect(await snapshot()).toEqual(first)
    expect(await t.db.selectFrom('membership_tier_prices').selectAll().execute()).toEqual(tierRows)
    expect(lines.find((l) => l.startsWith('pricing-defaults:'))).toBe(
      'pricing-defaults: size compact_car, wash unchanged, tier unchanged (Signature Hand Wash already has a compact_car price of $45, kept: set $40 in Settings if that is the price; Gold already has a compact_car price)',
    )
  })

  it('without a Signature Hand Wash, prices the cheapest active wash', async () => {
    // the production `catalog` profile alone: the design's washes
    const washes = (await services()).filter((s) => s.active && s.kind === 'package' && s.category === 'wash')
    expect(washes.map((w) => w.name)).not.toContain('Signature Hand Wash')
    await runDefaults()
    const cells = await t.db.selectFrom('service_class_prices').select(['service_id', 'price_cents']).execute()
    expect(cells).toHaveLength(1)
    const chosen = washes.find((w) => w.id === cells[0]!.service_id)!
    expect(chosen.price_cents).toBe(Math.min(...washes.map((w) => w.price_cents)))
    expect(cells[0]!.price_cents).toBe(4000)
  })
})

describe('GET /public/catalog (v1) from the prices by size', () => {
  // nothing internal and nothing about people
  const FORBIDDEN = /^id$|Id$|version|checkout|sqsp|square|task|bookable|^active$|visible|quoteOnly|customer|phone|email|plate|appointment|employee|_/i

  function keysOf(v: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out))
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        out.add(k)
        keysOf(x, out)
      }
    return out
  }

  const get = (url: string) => app.app.inject({ method: 'GET', url: `/api/v1/${url}`, headers: { 'x-test-anonymous': '1' } })

  /** The website catalog, the owner's defaults and a few more prices by size. */
  async function priced() {
    await seed()
    await runSeed({ db: t.db, clock, profile: 'pricing-defaults' })
    await setPrices([
      ['Signature Hand Wash', { large_suv: 6000 }],
      ['Exterior Hand Wash', { compact_car: 3500, truck: 4500 }],
      ['Carbon window tint', { compact_car: [27500, 33500], compact_suv: [32300, 39500] }],
      ['Hand wax', { compact_car: 4700 }],
      ['Leather conditioning', { large_car: 4200 }],
    ])
  }

  it('states starting prices from the cells, tint rows by size, the tiers sold online, and nothing internal', async () => {
    await priced()
    const r = await get('public/catalog')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=60')
    const b = r.json()
    expect(Object.keys(b).sort()).toEqual(
      ['addons', 'categories', 'currency', 'generatedAt', 'guestBookingFeeCents', 'guestMarkupPct', 'plans', 'quotes', 'services', 'tint'].sort(),
    )
    expect(b).toMatchObject({ currency: 'USD', guestMarkupPct: 0, guestBookingFeeCents: 2500 })
    const svc = (name: string) => b.services.find((s: { name: string }) => s.name === name)
    expect(svc('Signature Hand Wash')).toEqual({
      key: 'signature-hand-wash',
      name: 'Signature Hand Wash',
      shortName: 'Signature Hand Wash',
      category: 'wash',
      description: 'Exterior + interior',
      durationMin: 45,
      priceCents: 4000,
      memberPriceCents: 4000,
      guestPriceCents: 4000,
      vipInclusion: 'included',
      vipNote: 'Included with Gold and VIP (4 washes a month)',
      tags: ['handwash', 'signature', 'premium'],
      tintFilm: null,
    })
    expect(svc('Exterior Hand Wash')).toMatchObject({ priceCents: 3500, memberPriceCents: 3500, guestPriceCents: 3500 })
    expect(svc('Carbon window tint')).toMatchObject({ tintFilm: 'carbon', guestPriceCents: 27500 })
    // a new row nobody priced yet (no price by size, a $0 base price) is not listed: never stated as $0
    expect(svc('Interior detail')).toBeUndefined()
    // Full detail is the design's adopted row: it keeps its base price until the grid prices it
    expect(b.services.map((x: { key: string }) => x.key)).toEqual(['signature-hand-wash', 'exterior-hand-wash', 'carbon-window-tint', 'full-detail'])
    const add = Object.fromEntries(b.addons.map((a: { key: string; guestPriceCents: number }) => [a.key, a.guestPriceCents]))
    // adopted rows keep the design's base price until the grid prices them
    expect(add).toMatchObject({ 'hand-wax': 4700, 'leather-conditioning': 4200 })
    expect(add).not.toHaveProperty('stain-removal')
    expect(b.tint).toEqual({
      vehicleTypes: [
        { key: 'compact_car', label: 'Compact car' },
        { key: 'large_car', label: 'Large car' },
        { key: 'compact_suv', label: 'Compact SUV' },
        { key: 'large_suv', label: 'Large SUV' },
        { key: 'truck', label: 'Truck' },
      ],
      films: WEBSITE_TINT_FILMS,
      prices: [
        { vehicle: 'compact_car', film: 'carbon', memberMinCents: 27500, memberMaxCents: 33500, guestMinCents: 27500, guestMaxCents: 33500 },
        { vehicle: 'compact_suv', film: 'carbon', memberMinCents: 32300, memberMaxCents: 39500, guestMinCents: 32300, guestMaxCents: 39500 },
      ],
    })
    expect(b.plans).toEqual([
      { key: 'gold', name: 'Gold', planKey: 'gold', planName: 'Gold', perks: WEBSITE_PLANS[0]!.perks, priceCents: 12900 },
      { key: 'vip', name: 'VIP', planKey: 'vip', planName: 'VIP', perks: WEBSITE_PLANS[1]!.perks, priceCents: null },
    ])
    expect([...keysOf(b)].filter((k) => FORBIDDEN.test(k))).toEqual([])
  })

  it('member prices follow the lowest % off of the public tiers that have a price, rounded to whole dollars', async () => {
    await priced()
    await t.db.transaction().execute(async (tx) => {
      const gold = await requireTier(tx, locationId, 'gold')
      await putTier(tx, { newId }, { locationId, key: 'gold', expectedVersion: gold.version, fields: { ...gold, memberDiscountBp: 1000, inclusions: gold.inclusions } })
      // VIP has a larger % off but no price yet: it does not count
      const vip = await requireTier(tx, locationId, 'vip')
      await putTier(tx, { newId }, { locationId, key: 'vip', expectedVersion: vip.version, fields: { ...vip, memberDiscountBp: 2000, inclusions: vip.inclusions } })
    })
    let b = (await get('public/catalog')).json()
    const sig = () => b.services.find((s: { key: string }) => s.key === 'signature-hand-wash')
    const ext = () => b.services.find((s: { key: string }) => s.key === 'exterior-hand-wash')
    expect(sig()).toMatchObject({ guestPriceCents: 4000, memberPriceCents: 3600 })
    expect(ext()).toMatchObject({ guestPriceCents: 3500, memberPriceCents: 3200 }) // $31.50 -> $32
    expect(b.tint.prices[0]).toMatchObject({ guestMinCents: 27500, memberMinCents: 24800, memberMaxCents: 30200 }) // 247.5 -> 248, 301.5 -> 302
    for (const it of [...b.services, ...b.addons]) expect(it.guestPriceCents, it.key).toBeGreaterThanOrEqual(it.memberPriceCents)
    await t.db.transaction().execute(async (tx) => {
      const vip = await requireTier(tx, locationId, 'vip')
      await putTierPrices(tx, { newId, now: clock.now() }, { locationId, userId: null, rows: [{ tierKey: 'vip', priceVersion: vip.priceVersion, cells: [{ class: 'compact_car', monthlyCents: 19900 }] }] })
    })
    b = (await get('public/catalog')).json()
    expect(sig()).toMatchObject({ memberPriceCents: 3600 }) // still the lowest %: Gold's
    expect(b.plans.map((p: { key: string; priceCents: number | null }) => [p.key, p.priceCents])).toEqual([
      ['gold', 12900],
      ['vip', 19900],
    ])
  })

  it('the keys are the ones availability takes; the board defaults to the Signature wash', async () => {
    await priced()
    const cat = (await get('public/catalog')).json()
    const board = (await get('public/availability')).json()
    expect(board).toMatchObject({ serviceKey: 'signature-hand-wash', durationMin: 45 })
    for (const s of cat.services) {
      const r = await get(`public/availability?days=1&service=${s.key}`)
      expect(r.statusCode, s.key).toBe(200)
      expect(r.json().durationMin).toBe(s.durationMin)
    }
  })

  it('leaves out what is not listed online, a category turned off, a tier not sold online, and every checkout link', async () => {
    await priced()
    await t.db.updateTable('services').set({ visible_online: false }).where('name', '=', 'Odor removal').execute()
    await t.db.updateTable('catalog_categories').set({ active: false }).where('key', '=', 'quote').execute()
    await t.db.updateTable('membership_plans').set({ checkout_url: 'https://oasis.squarespace.com/checkout/subscribe?x=1' }).where('key', '=', 'gold').execute()
    await t.db.updateTable('membership_plans').set({ public: false }).where('key', '=', 'vip').execute()
    const b = (await get('public/catalog')).json()
    expect(b.addons.map((a: { key: string }) => a.key)).not.toContain('odor-removal')
    expect(b.quotes).toEqual([])
    expect(b.categories.map((c: { key: string }) => c.key)).not.toContain('quote')
    expect(b.plans.map((p: { key: string }) => p.key)).toEqual(['gold'])
    expect(JSON.stringify(b)).not.toContain('squarespace')
  })
})
