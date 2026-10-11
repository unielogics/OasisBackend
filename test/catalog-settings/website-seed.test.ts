// The `website-catalog` seed profile (ADR 0160, plan A) over production's `catalog` profile, and the public catalog it feeds:
// the website's washes, add-ons, tint matrix, details, quote-only services and plans become the catalog; the dashboard design's
// other entries are deactivated (never deleted); a second run changes nothing; GET /public/catalog shows exactly the website's
// content with no internal field.
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import {
  WEBSITE_DURATIONS_CHOSEN,
  WEBSITE_PLANS,
  WEBSITE_SERVICES,
  WEBSITE_TINT_MATRIX,
} from '../../db/seeds/website-catalog.js'
import { apiModules } from '../../src/http/modules.js'
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

describe('website-catalog seed', () => {
  it('makes the website’s services the active catalog with categories, prices, VIP inclusion and durations', async () => {
    const before = await services()
    const wax = before.find((s) => s.name === 'Wax')!
    const fullDetail = before.find((s) => s.name === 'Full Detail')!
    const waxTasks = await t.db.selectFrom('checklist_tasks').select('label').where('service_id', '=', wax.id).orderBy('position').execute()
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
      price_cents: 5400,
      member_price_cents: 4500,
      guest_price_cents: null,
      vip_inclusion: 'included',
      quote_only: false,
      visible_online: true,
    })
    expect(await byName('Exterior Hand Wash')).toMatchObject({ duration_min: 30, price_cents: 3800, member_price_cents: 3200 })
    expect(await byName('Ceramic window tint')).toMatchObject({ category: 'tint', tags: ['tint', 'ceramic'], member_price_cents: null, price_cents: 45500 })
    expect(await byName('Interior detail')).toMatchObject({ category: 'detail', member_price_cents: 14900, price_cents: 17900 })
    expect(await byName('Car key copies')).toMatchObject({ category: 'quote', quote_only: true, price_cents: 0, member_price_cents: null })
    expect(await byName('Leather conditioning')).toMatchObject({ category: 'addons', vip_inclusion: 'allowance', vip_note: '2× / mo', member_price_cents: 3500, price_cents: 4200 })
    expect(await byName('Stain removal')).toMatchObject({ vip_inclusion: 'allowance', vip_note: '1× / mo', price_cents: 7100 })
    expect(await byName('Tire shine & dressing')).toMatchObject({ member_price_cents: 1200, price_cents: 1400, vip_inclusion: 'none' })

    // adopted rows keep their id and checklist; renamed to the website's names
    const hand = await byName('Hand wax')
    expect(hand.id).toBe(wax.id)
    expect(hand.version).toBe(wax.version + 1)
    expect(await t.db.selectFrom('checklist_tasks').select('label').where('service_id', '=', wax.id).orderBy('position').execute()).toEqual(waxTasks)
    expect((await byName('Full detail')).id).toBe(fullDetail.id)
    expect((await byName('Engine bay wash')).id).toBe(before.find((s) => s.name === 'Engine bay cleaning')!.id)
    expect((await byName('Rain-repellent glass')).id).toBe(before.find((s) => s.name === 'Rain repellent')!.id)
    // new rows start with the website's steps
    const sig = await byName('Signature Hand Wash')
    expect((await t.db.selectFrom('checklist_tasks').select('label').where('service_id', '=', sig.id).orderBy('position').execute()).map((x) => x.label)).toEqual(
      WEBSITE_SERVICES.find((s) => s.name === 'Signature Hand Wash')!.tasks,
    )

    // the dashboard design's other entries are kept, turned off
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
    expect(after).toHaveLength(before.length + 2 + 2 + 1 + 4 + 2) // washes, tint, interior detail, quotes, stain + tire shine

    expect((await getSetting(t.db, locationId, 'catalog.tint_matrix')).value).toEqual(WEBSITE_TINT_MATRIX)
    expect((await getSetting(t.db, locationId, 'catalog.guest_markup_pct')).value).toBe(20)
    const plans = await t.db.selectFrom('membership_plans').select(['key', 'public_label', 'monthly_price_cents', 'perks', 'checkout_url']).orderBy('sort').execute()
    expect(plans.filter((p) => p.public_label)).toEqual(
      WEBSITE_PLANS.map((p) => ({ key: p.key, public_label: p.publicLabel, monthly_price_cents: p.monthlyDollars * 100, perks: p.perks, checkout_url: null })),
    )
    const actions = (await t.db.selectFrom('audit_log').select(['action', 'actor_name']).execute())
    expect(new Set(actions.map((a) => a.actor_name))).toEqual(new Set(['Seed (website-catalog)']))
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(['catalog.seed.create', 'catalog.seed.update', 'catalog.seed.deactivate', 'catalog.seed.plan', 'settings.update']),
    )
  })

  it('the tint matrix is the website’s: vehicle × film, member ranges as shown, guest = member + 20% (to the dollar)', () => {
    const row = (v: string, f: string) => WEBSITE_TINT_MATRIX.prices.find((p) => p.vehicle === v && p.film === f)
    expect(row('sedan', 'carbon')).toEqual({ vehicle: 'sedan', film: 'carbon', memberMinCents: 22900, memberMaxCents: 27900, guestMinCents: 27500, guestMaxCents: 33500 })
    expect(row('suv', 'ceramic')).toEqual({ vehicle: 'suv', film: 'ceramic', memberMinCents: 42900, memberMaxCents: 52900, guestMinCents: 51500, guestMaxCents: 63500 })
    expect(row('truck', 'ceramic')).toMatchObject({ memberMinCents: 39900, memberMaxCents: 47900, guestMinCents: 47900, guestMaxCents: 57500 })
    expect(WEBSITE_TINT_MATRIX.prices).toHaveLength(6)
    expect(WEBSITE_TINT_MATRIX.films.map((f) => f.vlt)).toEqual([
      [5, 20, 35, 50, 70],
      [5, 20, 35, 50, 70],
    ])
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
    await t.db.updateTable('services').set({ member_price_cents: 5000, visible_online: false }).where('id', '=', sig.id).execute()
    await seed()
    expect(await byName('Signature Hand Wash')).toMatchObject({ member_price_cents: 4500, visible_online: true, version: sig.version + 1 })
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

describe('GET /public/catalog after the seed', () => {
  // nothing internal and nothing about people
  const FORBIDDEN = /^id$|Id$|version|checkout|sqsp|task|bookable|^active$|visible|quoteOnly|customer|phone|email|plate|appointment|employee|_/i

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

  it('shows the website’s content: categories with colours, washes, add-ons with VIP inclusion, tint, details, quotes and plans', async () => {
    await seed()
    const r = await get('public/catalog')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=60')
    expect(r.headers['set-cookie']).toBeUndefined()
    const b = r.json()
    expect(Object.keys(b).sort()).toEqual(
      ['addons', 'categories', 'currency', 'generatedAt', 'guestBookingFeeCents', 'guestMarkupPct', 'plans', 'quotes', 'services', 'tint'].sort(),
    )
    expect(b).toMatchObject({ currency: 'USD', guestMarkupPct: 20, guestBookingFeeCents: 2500 })
    expect(b.categories).toEqual([
      { key: 'wash', label: 'Wash', colour: '#1FB6FF', sort: 10 },
      { key: 'addons', label: 'Add-ons', colour: '#7FD6FF', sort: 20 },
      { key: 'tint', label: 'Tint', colour: '#2EE59D', sort: 30 },
      { key: 'detail', label: 'Detail', colour: '#FFB547', sort: 40 },
      { key: 'quote', label: 'Quote', colour: '#8C97A1', sort: 50 },
    ])
    const svc = (name: string) => b.services.find((s: { name: string }) => s.name === name)
    expect(b.services.map((s: { key: string }) => s.key)).toEqual([
      'signature-hand-wash',
      'exterior-hand-wash',
      'carbon-window-tint',
      'ceramic-window-tint',
      'interior-detail',
      'full-detail',
    ])
    expect(svc('Signature Hand Wash')).toEqual({
      key: 'signature-hand-wash',
      name: 'Signature Hand Wash',
      shortName: 'Signature Hand Wash',
      category: 'wash',
      description: 'Exterior + interior',
      durationMin: 45,
      priceCents: 5400,
      memberPriceCents: 4500,
      guestPriceCents: 5400,
      vipInclusion: 'included',
      vipNote: 'Included with Gold and VIP (4 washes a month)',
      tags: ['handwash', 'signature'],
      tintFilm: null,
    })
    expect(svc('Exterior Hand Wash')).toMatchObject({ durationMin: 30, memberPriceCents: 3200, guestPriceCents: 3800 })
    expect(svc('Carbon window tint')).toMatchObject({ category: 'tint', tintFilm: 'carbon', memberPriceCents: 22900, guestPriceCents: 27500 })
    expect(svc('Ceramic window tint')).toMatchObject({ tintFilm: 'ceramic', memberPriceCents: 37900, guestPriceCents: 45500 })
    expect(svc('Interior detail')).toMatchObject({ memberPriceCents: 14900, guestPriceCents: 17900, vipInclusion: 'none' })
    expect(svc('Full detail')).toMatchObject({ memberPriceCents: 24900, guestPriceCents: 29900 })

    const add = Object.fromEntries(
      b.addons.map((a: { key: string; memberPriceCents: number; guestPriceCents: number; vipInclusion: string; vipNote: string | null }) => [
        a.key,
        [a.memberPriceCents / 100, a.guestPriceCents / 100, a.vipInclusion, a.vipNote],
      ]),
    )
    expect(add).toEqual({
      'hand-wax': [39, 47, 'included', null],
      'engine-bay-wash': [45, 54, 'included', null],
      'leather-conditioning': [35, 42, 'allowance', '2× / mo'],
      'stain-removal': [59, 71, 'allowance', '1× / mo'],
      'tire-shine-and-dressing': [12, 14, 'none', null],
      'rain-repellent-glass': [25, 30, 'none', null],
      'odor-removal': [30, 36, 'none', null],
      'pet-hair-removal': [35, 42, 'none', null],
      'interior-deep-clean': [60, 72, 'none', null],
    })
    expect(Object.keys(b.addons[0]).sort()).toEqual(
      ['category', 'description', 'guestPriceCents', 'key', 'memberPriceCents', 'name', 'priceCents', 'tags', 'vipInclusion', 'vipNote'].sort(),
    )
    expect(b.quotes).toEqual(
      ['Windshield replacement', 'Rim powder coating', 'Chrome delete', 'Car key copies'].map((name) => ({
        key: name.toLowerCase().replace(/ /g, '-'),
        name,
        kind: 'package',
        category: 'quote',
        description: null,
      })),
    )
    expect(b.tint).toEqual(WEBSITE_TINT_MATRIX)
    expect(b.plans).toEqual([
      { key: 'gold', name: 'Gold', planKey: 'premium', planName: 'Premium', perks: WEBSITE_PLANS[0]!.perks, priceCents: 9900 },
      { key: 'vip', name: 'VIP', planKey: 'executive', planName: 'Executive', perks: WEBSITE_PLANS[1]!.perks, priceCents: 16900 },
    ])
    expect([...keysOf(b)].filter((k) => FORBIDDEN.test(k))).toEqual([])
  })

  it('the keys are the ones availability takes; the board defaults to the Signature wash', async () => {
    await seed()
    const cat = (await get('public/catalog')).json()
    const board = (await get('public/availability')).json()
    expect(board).toMatchObject({ serviceKey: 'signature-hand-wash', durationMin: 45 })
    for (const s of cat.services) {
      const r = await get(`public/availability?days=1&service=${s.key}`)
      expect(r.statusCode, s.key).toBe(200)
      expect(r.json().durationMin).toBe(s.durationMin)
    }
  })

  it('leaves out what is not listed online, a category turned off and a checkout link; a set link stays internal', async () => {
    await seed()
    await t.db.updateTable('services').set({ visible_online: false }).where('name', '=', 'Odor removal').execute()
    await t.db.updateTable('catalog_categories').set({ active: false }).where('key', '=', 'quote').execute()
    await t.db.updateTable('membership_plans').set({ checkout_url: 'https://oasis.squarespace.com/checkout/subscribe?x=1' }).where('key', '=', 'premium').execute()
    const b = (await get('public/catalog')).json()
    expect(b.addons.map((a: { key: string }) => a.key)).not.toContain('odor-removal')
    expect(b.quotes).toEqual([])
    expect(b.categories.map((c: { key: string }) => c.key)).not.toContain('quote')
    expect(JSON.stringify(b)).not.toContain('squarespace')
  })
})
