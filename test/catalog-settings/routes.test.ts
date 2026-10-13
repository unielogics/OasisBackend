// Settings → Catalog over HTTP (ADR 0160, plan A and K; ADR 0170): the route contract and its authz, a service's website fields, the
// categories, the vehicle sizes, the prices by size, the membership tiers with their inclusions and prices by size, the booking fee
// and the retired pre-size writes; each with validation, versions (ETag, 428, 412), an audit row and a settings.changed event.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { describeAccess } from '../../src/http/access.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { makeCustomer, makeService } from '../domain-schema/helpers.js'
import { bookCustomer } from '../settings-http/fixtures.js'
import { auditActions, events, json, useSettingsHarness, type Session } from '../settings-http/harness.js'

const h = useSettingsHarness()

const ROUTES: [string, string, string, 'optional' | undefined][] = [
  ['GET', '/api/v1/catalog', 'authenticated', undefined],
  ['GET', '/api/v1/catalog/services/:id', 'authenticated', undefined],
  ['PUT', '/api/v1/catalog/services/:id', 'set.services', undefined],
  ['GET', '/api/v1/catalog/categories', 'authenticated', undefined],
  ['POST', '/api/v1/catalog/categories', 'set.services', 'optional'],
  ['PATCH', '/api/v1/catalog/categories/:key', 'set.services', undefined],
  ['DELETE', '/api/v1/catalog/categories/:key', 'set.services', undefined],
  ['GET', '/api/v1/catalog/vehicle-classes', 'authenticated', undefined],
  ['POST', '/api/v1/catalog/vehicle-classes', 'set.services', 'optional'],
  ['PATCH', '/api/v1/catalog/vehicle-classes/:key', 'set.services', undefined],
  ['DELETE', '/api/v1/catalog/vehicle-classes/:key', 'set.services', undefined],
  ['PUT', '/api/v1/catalog/prices', 'set.services', undefined],
  ['GET', '/api/v1/catalog/tiers', 'authenticated', undefined],
  ['POST', '/api/v1/catalog/tiers', 'set.services', 'optional'],
  ['PUT', '/api/v1/catalog/tiers/:key', 'set.services', undefined],
  ['DELETE', '/api/v1/catalog/tiers/:key', 'set.services', undefined],
  ['PUT', '/api/v1/catalog/tier-prices', 'set.services', undefined],
  ['GET', '/api/v1/catalog/guest-fee', 'authenticated', undefined],
  ['PUT', '/api/v1/catalog/guest-fee', 'set.services', undefined],
  ['GET', '/api/v1/catalog/tint-matrix', 'authenticated', undefined],
  ['PUT', '/api/v1/catalog/tint-matrix', 'set.services', undefined],
  ['GET', '/api/v1/catalog/guest-markup', 'authenticated', undefined],
  ['PUT', '/api/v1/catalog/guest-markup', 'set.services', undefined],
  ['GET', '/api/v1/catalog/plans', 'authenticated', undefined],
  ['PUT', '/api/v1/catalog/plans/:key', 'set.services', undefined],
]

const website = (o: Record<string, unknown> = {}) => ({
  category: 'wash',
  publicName: 'Signature Hand Wash',
  description: '  Exterior + interior ',
  quoteOnly: false,
  visibleOnline: true,
  sort: 10,
  ...o,
})

const tierBody = (o: Record<string, unknown> = {}) => ({
  name: 'Platinum',
  colour: '#3b5a8a',
  sort: 40,
  active: true,
  public: true,
  vipBooking: false,
  memberDiscountBp: 1000,
  maxVehicles: null,
  perks: [' Two washes a month ', ''],
  checkoutUrl: null,
  inclusions: [],
  ...o,
})

const errorPath = (r: { json(): unknown }): string => (r.json() as { errors: { path: string }[] }).errors[0]!.path

const price = async (id: string): Promise<number> =>
  (await h.db.selectFrom('services').select('price_cents').where('id', '=', id).executeTakeFirstOrThrow()).price_cents
const version = async (id: string): Promise<number> =>
  (await h.db.selectFrom('services').select('version').where('id', '=', id).executeTakeFirstOrThrow()).version
const cells = async (id: string) =>
  (
    await h.db
      .selectFrom('service_class_prices')
      .select(['class_key', 'price_cents', 'max_cents'])
      .where('service_id', '=', id)
      .orderBy('class_key')
      .execute()
  ).map((c) => [c.class_key, c.price_cents, c.max_cents])

describe('route contract', () => {
  it('declares exactly these catalog routes with their access and idempotency', () => {
    const registered = h.t.app.routeRegistry.filter((r) => r.url.startsWith('/api/v1/catalog'))
    expect(new Set(registered.map((r) => `${r.method} ${r.url}`))).toEqual(new Set(ROUTES.map(([m, u]) => `${m} ${u}`)))
    for (const [method, url, access, idem] of ROUTES) {
      const r = registered.find((x) => x.method === method && x.url === url)!
      expect(describeAccess(r.access), `${method} ${url}`).toBe(access)
      expect(r.idempotency, `${method} ${url}`).toBe(idem)
    }
  })

  it('reads need a session, writes need set.services; a holder of everything else is refused every write', async () => {
    const svc = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const reads = ['catalog', `catalog/services/${svc}`, 'catalog/categories', 'catalog/vehicle-classes', 'catalog/tiers', 'catalog/guest-fee', 'catalog/tint-matrix', 'catalog/guest-markup', 'catalog/plans']
    for (const url of reads) expect((await h.call('GET', url)).statusCode, url).toBe(401)
    const crew = await h.withPermissions(['sched.view', 'sched.edit', 'set.hours', 'cli.member', 'set.billing'])
    for (const url of reads) expect((await h.get(url, crew)).statusCode, url).toBe(200)
    const writes: [string, string, unknown][] = [
      ['PUT', `catalog/services/${svc}`, { ...website(), version: 1 }],
      ['POST', 'catalog/categories', { key: 'ppf', label: 'PPF', colour: '#123456' }],
      ['PATCH', 'catalog/categories/wash', { label: 'Washes' }],
      ['DELETE', 'catalog/categories/quote', undefined],
      ['POST', 'catalog/vehicle-classes', { key: 'van', label: 'Van' }],
      ['PATCH', 'catalog/vehicle-classes/truck', { label: 'Pickup' }],
      ['DELETE', 'catalog/vehicle-classes/truck', undefined],
      ['PUT', 'catalog/prices', { rows: [{ serviceId: svc, version: 1, cells: [{ class: 'compact_car', cents: 4000 }] }] }],
      ['POST', 'catalog/tiers', { key: 'platinum', ...tierBody() }],
      ['PUT', 'catalog/tiers/gold', { ...tierBody(), version: 1 }],
      ['DELETE', 'catalog/tiers/gold', undefined],
      ['PUT', 'catalog/tier-prices', { rows: [{ tierKey: 'gold', priceVersion: 1, cells: [{ class: 'compact_car', monthlyCents: 12900 }] }] }],
      ['PUT', 'catalog/guest-fee', { cents: 2000, collect: 'counter', version: 0 }],
      ['PUT', 'catalog/tint-matrix', { version: 1 }],
      ['PUT', 'catalog/guest-markup', { pct: 25, version: 1 }],
      ['PUT', 'catalog/plans/gold', { version: 1 }],
    ]
    for (const [m, url, body] of writes) {
      const r = await h.call(m as 'PUT', url, { session: crew, body })
      expect(r.statusCode, `${m} ${url}`).toBe(403)
      expect(r.json().meta.required, `${m} ${url}`).toEqual(['set.services'])
    }
    expect((await h.get('catalog?includeInactive=true', crew)).statusCode).toBe(403)
    const editor = await h.withPermissions(['set.services'])
    expect((await h.get('catalog?includeInactive=true', editor)).statusCode).toBe(200)
    expect((await auditActions(h.db)).filter((a) => a.startsWith('catalog.') || a.startsWith('settings.'))).toEqual([])
  })
})

describe('GET /catalog', () => {
  it('returns categories, services, vehicle sizes, prices by size, tiers, the booking fee, and the deprecated pre-size data', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 4500 })
    await makeService(h.db, h.fx, { kind: 'addon', name: 'Wax', priceCents: 3900 })
    await makeService(h.db, h.fx, { name: 'Old Package', active: false })
    const s = await h.admin()
    const b = json(await h.get('catalog', s))
    expect(b.categories.map((c: { key: string }) => c.key)).toEqual(['wash', 'addons', 'tint', 'detail', 'quote'])
    expect(b.packages.map((p: { name: string }) => p.name)).toEqual(['Express Hand Wash'])
    expect(b.packages[0]).toMatchObject({ category: 'wash', publicName: null, effective: { memberPriceCents: 4500, guestPriceCents: 4500, tintFilm: null } })
    expect(b.vehicleClasses).toEqual([
      { key: 'compact_car', label: 'Compact car', sort: 10, active: true, version: 1 },
      { key: 'large_car', label: 'Large car', sort: 20, active: true, version: 1 },
      { key: 'compact_suv', label: 'Compact SUV', sort: 30, active: true, version: 1 },
      { key: 'large_suv', label: 'Large SUV', sort: 40, active: true, version: 1 },
      { key: 'truck', label: 'Truck', sort: 50, active: true, version: 1 },
    ])
    expect(b.prices[0]).toEqual({ serviceId: wash, version: 1, cells: [], fromCents: 4500, missing: 5 })
    expect(b.missingPrices).toBe(10)
    expect(b.tiers.map((t: { key: string; public: boolean; vipBooking: boolean; legacyKey: string | null }) => [t.key, t.public, t.vipBooking, t.legacyKey])).toEqual([
      ['essential', false, false, null],
      ['gold', true, false, 'premium'],
      ['vip', true, true, 'executive'],
      ['exotic', false, false, null],
    ])
    expect(b.tiers[1]).toMatchObject({ name: 'Gold', memberDiscountBp: 0, priceVersion: 1, prices: [], fromMonthlyCents: null, sold: false, squarePlanId: null })
    expect(b.tiers[1].inclusions).toEqual([
      { id: expect.any(String), label: 'Premium wash', mode: 'per_cycle', perCycle: 2, autoApply: true, active: true, serviceIds: [] },
    ])
    expect(b.guestFee).toEqual({ cents: 2500, collect: 'counter', version: expect.any(Number) })
    expect(b.guestBookingFeeCents).toBe(2500)
    expect(b.tintMatrix).toEqual({ vehicleTypes: [], films: [], prices: [], version: expect.any(Number) })
    expect(b.guestMarkup).toEqual({ pct: 20, version: expect.any(Number) })
    expect(b.plans.map((p: { key: string; websiteTier: string | null }) => [p.key, p.websiteTier])).toEqual([
      ['essential', null],
      ['gold', 'gold'],
      ['vip', 'vip'],
      ['exotic', null],
    ])
    // the Square fields are staff-with-set.services only
    const crew = await h.withPermissions(['sched.view'])
    const c = json(await h.get('catalog', crew))
    expect(c.tiers[1]).not.toHaveProperty('squarePlanId')
    const all = json(await h.get('catalog?includeInactive=true', s))
    expect(all.packages.map((p: { name: string }) => p.name)).toContain('Old Package')
  })
})

describe('a service’s website fields', () => {
  it('GET carries an ETag; PUT requires the version, trims, saves, audits and publishes; prices are not website fields', async () => {
    const id = await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 5400 })
    const s = await h.admin()
    const g = await h.get(`catalog/services/${id}`, s)
    expect(g.statusCode).toBe(200)
    expect(g.headers.etag).toBe('"1"')
    expect((await h.put(`catalog/services/${id}`, s, website())).statusCode).toBe(428)
    expect((await h.put(`catalog/services/${id}`, s, { ...website(), version: 7 })).statusCode).toBe(412)
    for (const extra of [{ memberPriceCents: 4500 }, { guestPriceCents: 5400 }, { vipInclusion: 'included' }, { vipNote: 'x' }])
      expect((await h.put(`catalog/services/${id}`, s, { ...website(extra), version: 1 })).statusCode, JSON.stringify(extra)).toBe(422)

    const r = await h.put(`catalog/services/${id}`, s, { ...website(), version: 1 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers.etag).toBe('"2"')
    expect(json(r)).toMatchObject({
      publicName: 'Signature Hand Wash',
      description: 'Exterior + interior',
      priceCents: 5400,
      effective: { memberPriceCents: 5400, guestPriceCents: 5400, tintFilm: null },
      changed: true,
      appointmentsUpdated: 0,
      version: 2,
    })
    expect(await price(id)).toBe(5400)
    expect(await auditActions(h.db)).toContain('catalog.website.update')
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ type: 'settings.changed', payload: { section: 'services', key: id } })
    const again = await h.put(`catalog/services/${id}`, s, website(), { 'if-match': '"2"' })
    expect(json(again)).toMatchObject({ changed: false, version: 2 })
  })

  it('refuses bad values with field paths (422)', async () => {
    const id = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const s = await h.admin()
    const bad: [Record<string, unknown>, string][] = [
      [{ category: 'ppf' }, 'category'],
      [{ publicName: 'x'.repeat(81) }, 'publicName'],
      [{ description: 'x'.repeat(1001) }, 'description'],
      [{ sort: 100_001 }, 'sort'],
    ]
    for (const [patch, path] of bad) {
      const r = await h.put(`catalog/services/${id}`, s, { ...website(patch), version: 1 })
      expect(r.statusCode, JSON.stringify(patch)).toBe(422)
      expect(errorPath(r), JSON.stringify(patch)).toBe(path)
    }
    await h.patch('catalog/categories/quote', s, { active: false })
    expect((await h.put(`catalog/services/${id}`, s, { ...website({ category: 'quote' }), version: 1 })).statusCode).toBe(422)
    expect(await auditActions(h.db)).not.toContain('catalog.website.update')
  })

  it('a category change re-derives the categories of the open visits holding the service, not the finished ones', async () => {
    const id = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const open = (await bookCustomer(h.db, h.fx, { name: 'Marcus Webb', date: '2026-06-13', time: '13:00', serviceId: id })).id
    const done = (await bookCustomer(h.db, h.fx, { name: 'Liam Chen', date: '2026-06-13', time: '08:00', serviceId: id, status: 'completed' })).id
    await h.db.updateTable('appointments').set({ categories: ['wash'] }).execute()
    const s = await h.admin()
    const r = await h.put(`catalog/services/${id}`, s, { ...website({ category: 'detail' }), version: 1 })
    expect(json(r)).toMatchObject({ category: 'detail', appointmentsUpdated: 1 })
    const rows = await h.db.selectFrom('appointments').select(['id', 'categories']).execute()
    expect(rows.find((x) => x.id === open)!.categories).toEqual(['detail'])
    expect(rows.find((x) => x.id === done)!.categories).toEqual(['wash'])
  })

  it('404 for an unknown service', async () => {
    const s = await h.admin()
    expect((await h.get('catalog/services/00000000-0000-7000-8000-000000000000', s)).statusCode).toBe(404)
  })
})

describe('categories', () => {
  it('creates, edits (key immutable), turns off and deletes an unused category, with versions, audit and events', async () => {
    const s = await h.admin()
    const c = await h.post('catalog/categories', s, { key: 'ppf', label: ' Paint film ', colour: '#aa00ff' })
    expect(c.statusCode, c.body).toBe(201)
    expect(json(c)).toEqual({ key: 'ppf', label: 'Paint film', colour: '#AA00FF', sort: 60, active: true, builtin: false, version: 1 })
    expect((await h.post('catalog/categories', s, { key: 'ppf', label: 'Again', colour: '#000000' })).json().code).toBe('CATEGORY_KEY_TAKEN')
    expect((await h.patch('catalog/categories/ppf', s, { label: 'PPF', version: 9 })).statusCode).toBe(412)
    const p = await h.patch('catalog/categories/ppf', s, { label: 'PPF', colour: '#112233', sort: 5, active: false, version: 1 })
    expect(json(p)).toMatchObject({ key: 'ppf', label: 'PPF', colour: '#112233', sort: 5, active: false, changed: true, version: 2 })
    expect((await h.patch('catalog/categories/ppf', s, { key: 'film' })).statusCode).toBe(422)
    expect(json(await h.del('catalog/categories/ppf', s))).toEqual({ key: 'ppf', removed: true })
    expect(await auditActions(h.db)).toEqual(
      expect.arrayContaining(['catalog.category.create', 'catalog.category.update', 'catalog.category.delete']),
    )
    expect(json(await h.del('catalog/categories/wash', s)).code).toBe('CATEGORY_BUILTIN')
  })
})

describe('vehicle sizes', () => {
  it('adds, renames, reorders, turns off and deletes an unused size, with versions, audit and events', async () => {
    const s = await h.admin()
    const c = await h.post('catalog/vehicle-classes', s, { key: 'van', label: ' Van ' })
    expect(c.statusCode, c.body).toBe(201)
    expect(json(c)).toEqual({ key: 'van', label: 'Van', sort: 60, active: true, version: 1 })
    expect(json(await h.post('catalog/vehicle-classes', s, { key: 'van', label: 'Vans' })).code).toBe('CLASS_KEY_TAKEN')
    const dupLabel = await h.post('catalog/vehicle-classes', s, { key: 'pickup', label: 'TRUCK' })
    expect([dupLabel.statusCode, errorPath(dupLabel)]).toEqual([422, 'label'])
    for (const [body, path] of [
      [{ key: 'Big Van', label: 'x' }, 'key'],
      [{ key: 'ok', label: '  ' }, 'label'],
      [{ key: 'ok', label: 'x'.repeat(41) }, 'label'],
      [{ key: 'ok', label: 'x', sort: 1e6 }, 'sort'],
    ] as const) {
      const r = await h.post('catalog/vehicle-classes', s, body)
      expect([r.statusCode, errorPath(r)], JSON.stringify(body)).toEqual([422, path])
    }
    expect((await h.patch('catalog/vehicle-classes/van', s, { label: 'Minivan', version: 9 })).statusCode).toBe(412)
    const p = await h.patch('catalog/vehicle-classes/van', s, { label: 'Minivan', sort: 25, active: false, version: 1 })
    expect(p.headers.etag).toBe('"2"')
    expect(json(p)).toEqual({ key: 'van', label: 'Minivan', sort: 25, active: false, version: 2, changed: true })
    expect(json(await h.patch('catalog/vehicle-classes/van', s, { label: 'Minivan' }))).toMatchObject({ changed: false, version: 2 })
    expect((await h.patch('catalog/vehicle-classes/van', s, { key: 'minivan' })).statusCode).toBe(422)
    expect(json(await h.get('catalog/vehicle-classes', s)).vehicleClasses.map((x: { key: string }) => x.key)).toEqual([
      'compact_car',
      'large_car',
      'van',
      'compact_suv',
      'large_suv',
      'truck',
    ])
    expect(json(await h.del('catalog/vehicle-classes/van', s))).toEqual({ key: 'van', removed: true })
    expect((await h.patch('catalog/vehicle-classes/van', s, { label: 'x' })).statusCode).toBe(404)
    expect(await auditActions(h.db)).toEqual(
      expect.arrayContaining(['catalog.vehicle_class.create', 'catalog.vehicle_class.update', 'catalog.vehicle_class.delete']),
    )
    expect((await events(h.db, 'settings')).filter((e) => e.payload.key === 'vehicle_classes')).toHaveLength(3)
  })

  it('refuses to delete a size in use (CLASS_IN_USE names what uses it), keeps one size on, and stops at 12', async () => {
    const s = await h.admin()
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    await h.put('catalog/prices', s, { rows: [{ serviceId: wash, version: 1, cells: [{ class: 'large_car', cents: 5000 }] }] })
    const used = await h.del('catalog/vehicle-classes/large_car', s)
    expect(used.statusCode).toBe(409)
    expect(json(used)).toMatchObject({ code: 'CLASS_IN_USE', meta: { key: 'large_car', prices: 1 } })
    const cust = await makeCustomer(h.db, h.fx, { name: 'Maria Delgado' })
    await h.db.insertInto('vehicles').values({ id: h.fx.newId(), customer_id: cust, make: 'Ford', model: 'F-150', vehicle_class: 'truck', vehicle_class_source: 'staff' }).execute()
    expect(json(await h.del('catalog/vehicle-classes/truck', s))).toMatchObject({ code: 'CLASS_IN_USE', meta: { vehicles: 1 } })
    for (const key of ['compact_car', 'compact_suv', 'large_suv', 'truck']) await h.patch(`catalog/vehicle-classes/${key}`, s, { active: false })
    const last = await h.patch('catalog/vehicle-classes/large_car', s, { active: false })
    expect([last.statusCode, errorPath(last)]).toEqual([422, 'active'])
    // a membership checkout priced at a size (that column has no foreign key) keeps the size too
    expect((await h.post('catalog/vehicle-classes', s, { key: 'van', label: 'Van' })).statusCode).toBe(201)
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const plan = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()
    const mid = h.fx.newId()
    await h.db
      .insertInto('memberships')
      .values({ id: mid, location_id: h.fx.locationId, customer_id: cust, plan_id: plan.id, plan_label: 'Gold', status: 'pending', source: 'manual', started_at: h.clock.now(), plan_class: 'large_car' })
      .execute()
    await h.db
      .insertInto('membership_checkouts')
      .values({
        id: h.fx.newId(),
        location_id: h.fx.locationId,
        membership_id: mid,
        customer_id: cust,
        plan_key: 'gold',
        plan_class: 'van',
        checkout_url: 'https://oasis.squarespace.com/checkout/subscribe?productId=1',
        started_at: h.clock.now(),
        expires_at: new Date(h.clock.now().getTime() + 86_400_000),
      })
      .execute()
    const van = await h.del('catalog/vehicle-classes/van', s)
    expect([van.statusCode, json(van)]).toEqual([409, expect.objectContaining({ code: 'CLASS_IN_USE', meta: { key: 'van', checkouts: 1 } })])
    for (let i = 0; i < 6; i++) expect((await h.post('catalog/vehicle-classes', s, { key: `x${i}`, label: `X ${i}` })).statusCode).toBe(201)
    expect(json(await h.post('catalog/vehicle-classes', s, { key: 'x99', label: 'One more' })).code).toBe('CLASS_LIMIT')
  })

  it('turning a size off or on moves the starting price of the services priced on it (catalog.price.sync)', async () => {
    const s = await h.admin()
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 1 })
    await h.put('catalog/prices', s, {
      rows: [{ serviceId: wash, version: 1, cells: [{ class: 'compact_car', cents: 4000 }, { class: 'large_car', cents: 5000 }] }],
    })
    expect(await price(wash)).toBe(4000)
    await h.patch('catalog/vehicle-classes/compact_car', s, { active: false })
    expect(await price(wash)).toBe(5000)
    await h.patch('catalog/vehicle-classes/compact_car', s, { active: true })
    expect(await price(wash)).toBe(4000)
    const sync = await h.db.selectFrom('audit_log').select(['after']).where('action', '=', 'catalog.price.sync').orderBy('id').execute()
    expect(sync.map((x) => x.after)).toEqual([
      { priceCents: 5000, reason: 'catalog.vehicle_classes' },
      { priceCents: 4000, reason: 'catalog.vehicle_classes' },
    ])
  })
})

describe('prices by size', () => {
  it('saves rows of cells (set, range, clear), keeps priceCents at the starting price, audits and publishes', async () => {
    const s = await h.admin()
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 4500 })
    const tint = await makeService(h.db, h.fx, { name: 'Carbon tint', priceCents: 0 })
    const r = await h.put('catalog/prices', s, {
      rows: [
        { serviceId: wash, version: 1, cells: [{ class: 'compact_car', cents: 4000 }, { class: 'large_suv', cents: 6000 }] },
        { serviceId: tint, version: 1, cells: [{ class: 'compact_car', cents: 22900, maxCents: 27900 }] },
      ],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toEqual({
      rows: [
        {
          serviceId: wash,
          version: 2,
          cells: [
            { class: 'compact_car', cents: 4000, maxCents: null },
            { class: 'large_suv', cents: 6000, maxCents: null },
          ],
          fromCents: 4000,
          missing: 3,
          changed: true,
        },
        { serviceId: tint, version: 2, cells: [{ class: 'compact_car', cents: 22900, maxCents: 27900 }], fromCents: 22900, missing: 4, changed: true },
      ],
      missingPrices: 7,
    })
    expect([await price(wash), await price(tint)]).toEqual([4000, 22900])
    const a = await h.db.selectFrom('audit_log').select(['entity_id', 'before', 'after']).where('action', '=', 'catalog.price.update').orderBy('id').execute()
    expect(a[0]).toEqual({ entity_id: wash, before: { cells: {}, priceCents: 4500 }, after: { cells: { compact_car: 4000, large_suv: 6000 }, priceCents: 4000 } })
    expect(a[1]!.after).toEqual({ cells: { compact_car: [22900, 27900] }, priceCents: 22900 })
    const ev = await events(h.db, 'settings')
    expect(ev.at(-1)).toMatchObject({ type: 'settings.changed', payload: { section: 'catalog', key: 'prices', services: [wash, tint] } })
    expect(ev.filter((e) => e.payload.section === 'services').map((e) => e.payload.key)).toEqual([wash, tint])

    // clearing the cheapest cell moves the starting price; a row that changes nothing keeps its version and writes no audit
    const c = await h.put('catalog/prices', s, {
      rows: [
        { serviceId: wash, version: 2, cells: [{ class: 'compact_car', cents: null }] },
        { serviceId: tint, version: 2, cells: [{ class: 'compact_car', cents: 22900, maxCents: 27900 }] },
      ],
    })
    expect(json(c).rows.map((x: { version: number; changed: boolean; fromCents: number }) => [x.version, x.changed, x.fromCents])).toEqual([
      [3, true, 6000],
      [2, false, 22900],
    ])
    expect(await price(wash)).toBe(6000)
    expect(await cells(wash)).toEqual([['large_suv', 6000, null]])
    // all cleared: the service keeps the price it has (its base price)
    await h.put('catalog/prices', s, { rows: [{ serviceId: wash, version: 3, cells: [{ class: 'large_suv', cents: null }] }] })
    expect([await price(wash), await cells(wash)]).toEqual([6000, []])
    expect(await h.db.selectFrom('audit_log').select('id').where('action', '=', 'catalog.price.update').execute()).toHaveLength(4)
  })

  it('is all or nothing: one stale row refuses the save with 412 naming it, and nothing is written', async () => {
    const s = await h.admin()
    const a = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const b = await makeService(h.db, h.fx, { name: 'Exterior Hand Wash' })
    await h.db.updateTable('services').set({ version: 5 }).where('id', '=', b).execute()
    const r = await h.put('catalog/prices', s, {
      rows: [
        { serviceId: a, version: 1, cells: [{ class: 'compact_car', cents: 4000 }] },
        { serviceId: b, version: 4, cells: [{ class: 'compact_car', cents: 3200 }] },
      ],
    })
    expect(r.statusCode).toBe(412)
    expect(json(r)).toMatchObject({ code: 'VERSION_CONFLICT', meta: { row: 1, serviceId: b, currentVersion: 5 } })
    expect([await cells(a), await cells(b), await version(a)]).toEqual([[], [], 1])
    expect((await auditActions(h.db)).filter((a) => a.startsWith('catalog.') || a.startsWith('settings.'))).toEqual([])
    // a row without a version: 428 naming it
    const n = await h.put('catalog/prices', s, { rows: [{ serviceId: a, cells: [{ class: 'compact_car', cents: 4000 }] }] })
    expect(n.statusCode).toBe(428)
    expect(json(n).meta).toEqual({ row: 0, serviceId: a })
    // an unknown service: 404, nothing written
    const u = await h.put('catalog/prices', s, {
      rows: [
        { serviceId: a, version: 1, cells: [{ class: 'compact_car', cents: 4000 }] },
        { serviceId: '00000000-0000-7000-8000-000000000000', version: 1, cells: [] },
      ],
    })
    expect(u.statusCode).toBe(404)
    expect(await cells(a)).toEqual([])
  })

  it('validates the cells with body paths (422)', async () => {
    const s = await h.admin()
    const a = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const row = (cellsIn: unknown[]) => ({ rows: [{ serviceId: a, version: 1, cells: cellsIn }] })
    const cases: [unknown, string][] = [
      [row([{ class: 'limo', cents: 100 }]), 'rows.0.cells.0.class'],
      [row([{ class: 'truck', cents: 100 }, { class: 'truck', cents: 200 }]), 'rows.0.cells.1.class'],
      [row([{ class: 'truck', cents: -1 }]), 'rows.0.cells.0.cents'],
      [row([{ class: 'truck', cents: 10_000_001 }]), 'rows.0.cells.0.cents'],
      [row([{ class: 'truck', cents: 5000, maxCents: 4000 }]), 'rows.0.cells.0.maxCents'],
      [row([{ class: 'truck', cents: null, maxCents: 4000 }]), 'rows.0.cells.0.maxCents'],
      [{ rows: [] }, 'rows'],
      [{ rows: [{ serviceId: a, version: 1, cells: [] }, { serviceId: a, version: 1, cells: [] }] }, 'rows.1.serviceId'],
      [{ rows: [{ serviceId: 'nope', version: 1, cells: [] }] }, 'rows.0.serviceId'],
    ]
    for (const [body, path] of cases) {
      const r = await h.put('catalog/prices', s, body)
      expect([r.statusCode, errorPath(r)], JSON.stringify(body)).toEqual([422, path])
    }
    expect(await cells(a)).toEqual([])
  })
})

describe('membership tiers', () => {
  it('adds a tier with inclusions; refuses a key or an old key another tier holds', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const wax = await makeService(h.db, h.fx, { kind: 'addon', name: 'Wax' })
    const c = await h.post('catalog/tiers', s, {
      key: 'platinum',
      ...tierBody({
        inclusions: [
          { label: ' Two washes ', mode: 'per_cycle', perCycle: 2, autoApply: true, serviceIds: [wash] },
          { label: 'Wax every visit', mode: 'every_visit', perCycle: null, autoApply: true, serviceIds: [wax, wax] },
        ],
      }),
    })
    expect(c.statusCode, c.body).toBe(201)
    expect(json(c)).toMatchObject({
      key: 'platinum',
      name: 'Platinum',
      colour: '#3B5A8A',
      bgColour: '#E2E6ED',
      public: true,
      memberDiscountBp: 1000,
      perks: ['Two washes a month'],
      priceVersion: 1,
      version: 1,
      prices: [],
      fromMonthlyCents: null,
      sold: false,
    })
    expect(json(c).inclusions.map((i: { label: string; mode: string; perCycle: number | null; serviceIds: string[] }) => [i.label, i.mode, i.perCycle, i.serviceIds])).toEqual([
      ['Two washes', 'per_cycle', 2, [wash]],
      ['Wax every visit', 'every_visit', null, [wax]],
    ])
    expect(json(await h.post('catalog/tiers', s, { key: 'platinum', ...tierBody() })).code).toBe('TIER_KEY_TAKEN')
    expect(json(await h.post('catalog/tiers', s, { key: 'premium', ...tierBody() })).code).toBe('TIER_KEY_TAKEN')
    expect(await auditActions(h.db)).toContain('catalog.tier.create')
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ payload: { section: 'catalog', key: 'tiers', tier: 'platinum' } })
  })

  it('saves the whole tier with a required version; kept inclusions keep their id, a dropped one with credits is turned off', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const detail = await makeService(h.db, h.fx, { name: 'Full detail' })
    const gold = json(await h.get('catalog/tiers', s)).tiers.find((t: { key: string }) => t.key === 'gold')
    const old = gold.inclusions[0]
    const body = tierBody({
      name: 'Gold',
      colour: gold.colour,
      sort: gold.sort,
      vipBooking: false,
      memberDiscountBp: 500,
      maxVehicles: 3,
      perks: ['4 hand washes a month'],
      checkoutUrl: 'https://oasis.squarespace.com/checkout/gold',
      inclusions: [
        { id: old.id, label: 'Hand wash', mode: 'per_cycle', perCycle: 4, autoApply: true, serviceIds: [wash] },
        { label: 'Detail', mode: 'per_cycle', perCycle: null, autoApply: false, serviceIds: [detail] },
      ],
    })
    expect((await h.put('catalog/tiers/gold', s, body)).statusCode).toBe(428)
    expect((await h.put('catalog/tiers/gold', s, { ...body, version: gold.version + 1 })).statusCode).toBe(412)
    const r = await h.put('catalog/tiers/gold', s, { ...body, version: gold.version })
    expect(r.statusCode, r.body).toBe(200)
    const saved = json(r)
    expect(saved).toMatchObject({ key: 'gold', legacyKey: 'premium', memberDiscountBp: 500, maxVehicles: 3, changed: true, version: gold.version + 1 })
    expect(r.headers.etag).toBe(`"${gold.version + 1}"`)
    expect(saved.inclusions[0]).toEqual({ id: old.id, label: 'Hand wash', mode: 'per_cycle', perCycle: 4, autoApply: true, active: true, serviceIds: [wash] })
    // the same save again changes nothing
    const same = await h.put('catalog/tiers/gold', s, {
      ...body,
      inclusions: saved.inclusions.map((i: Record<string, unknown>) => ({ ...i })),
      version: saved.version,
    })
    expect(json(same)).toMatchObject({ changed: false, version: saved.version })
    // a dropped inclusion is deleted, unless credits name it (then turned off and listed after the tier's list)
    const m = await makeCustomer(h.db, h.fx, { name: 'Maria Delgado' })
    const plan = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()
    const mid = h.fx.newId()
    await h.db
      .insertInto('memberships')
      .values({ id: mid, location_id: h.fx.locationId, customer_id: m, plan_id: plan.id, plan_label: 'Gold', status: 'active', source: 'manual', started_at: h.clock.now(), current_period_start: h.clock.now() })
      .execute()
    await sql`insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, inclusion_id, idempotency_key)
      values (${h.fx.newId()}, ${mid}, ${h.clock.now()}, 'grant', 4, ${old.id}, 'k1')`.execute(h.db)
    const drop = await h.put('catalog/tiers/gold', s, { ...body, inclusions: [body.inclusions[1]], version: saved.version })
    expect(drop.statusCode, drop.body).toBe(200)
    expect(json(drop).inclusions.map((i: { id: string; active: boolean }) => [i.id === old.id, i.active])).toEqual([
      [false, true],
      [true, false],
    ])
    expect(json(drop).sold).toBe(true)
    expect(await auditActions(h.db)).toContain('catalog.tier.update')
  })

  it('validates a tier with body paths (422)', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    const wash = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const inc = (o: Record<string, unknown>) => ({ inclusions: [{ label: 'x', mode: 'per_cycle', perCycle: 1, autoApply: true, serviceIds: [wash], ...o }] })
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '  ' }, 'name'],
      [{ colour: 'gold' }, 'colour'],
      [{ memberDiscountBp: 10_001 }, 'memberDiscountBp'],
      [{ memberDiscountBp: -1 }, 'memberDiscountBp'],
      [{ maxVehicles: 0 }, 'maxVehicles'],
      [{ perks: ['Same', 'same'] }, 'perks'],
      [{ checkoutUrl: 'https://evil.example/x' }, 'checkoutUrl'],
      [inc({ mode: 'every_visit', perCycle: 2 }), 'inclusions.0.perCycle'],
      [inc({ perCycle: 0 }), 'inclusions.0.perCycle'],
      [inc({ serviceIds: [] }), 'inclusions.0.serviceIds'],
      [inc({ serviceIds: ['00000000-0000-7000-8000-000000000000'] }), 'inclusions.0.serviceIds.0'],
      [inc({ label: ' ' }), 'inclusions.0.label'],
      [inc({ id: '00000000-0000-7000-8000-000000000000' }), 'inclusions.0.id'],
    ]
    const v = json(await h.get('catalog/tiers', s)).tiers.find((t: { key: string }) => t.key === 'vip').version
    for (const [o, path] of cases) {
      const r = await h.put('catalog/tiers/vip', s, { ...tierBody(o), version: v })
      expect([r.statusCode, errorPath(r)], JSON.stringify(o)).toEqual([422, path])
    }
    const bad = await h.post('catalog/tiers', s, { key: 'Bad Key', ...tierBody() })
    expect([bad.statusCode, errorPath(bad)]).toEqual([422, 'key'])
    expect((await h.put('catalog/tiers/nope', s, { ...tierBody(), version: 1 })).statusCode).toBe(404)
  })

  it('deletes a tier never sold, refuses one a membership or a link names (TIER_IN_USE)', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    await h.post('catalog/tiers', s, { key: 'platinum', ...tierBody() })
    const v = json(await h.get('catalog/tiers', s)).tiers.find((t: { key: string }) => t.key === 'platinum').priceVersion
    await h.put('catalog/tier-prices', s, { rows: [{ tierKey: 'platinum', priceVersion: v, cells: [{ class: 'compact_car', monthlyCents: 19900 }] }] })
    expect(json(await h.del('catalog/tiers/platinum', s))).toEqual({ key: 'platinum', removed: true })
    expect(await h.db.selectFrom('membership_tier_prices').select('id').execute()).toHaveLength(0)
    const m = await makeCustomer(h.db, h.fx, { name: 'Maria Delgado' })
    const plan = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'exotic').executeTakeFirstOrThrow()
    await h.db
      .insertInto('memberships')
      .values({ id: h.fx.newId(), location_id: h.fx.locationId, customer_id: m, plan_id: plan.id, plan_label: 'Exotic', status: 'canceled', source: 'manual', started_at: h.clock.now() })
      .execute()
    const used = await h.del('catalog/tiers/exotic', s)
    expect([used.statusCode, json(used).code]).toEqual([409, 'TIER_IN_USE'])
    expect(await auditActions(h.db)).toContain('catalog.tier.delete')
  })
})

describe('tier prices', () => {
  it('supersedes the current price, adds a pending row at the next price version, and keeps history append-only', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    const tierOf = async (key: string) => json(await h.get('catalog/tiers', s)).tiers.find((t: { key: string }) => t.key === key)
    expect((await h.put('catalog/tier-prices', s, { rows: [{ tierKey: 'gold', cells: [] }] })).statusCode).toBe(428)
    const r = await h.put('catalog/tier-prices', s, {
      rows: [{ tierKey: 'gold', priceVersion: 1, cells: [{ class: 'compact_car', monthlyCents: 12900 }, { class: 'large_suv', monthlyCents: 15900 }] }],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r).changed).toEqual(['gold'])
    const gold = json(r).tiers.find((t: { key: string }) => t.key === 'gold')
    expect(gold).toMatchObject({ priceVersion: 2, fromMonthlyCents: 12900 })
    expect(gold.prices.map((p: { class: string; monthlyCents: number; priceVersion: number; squareState: string }) => [p.class, p.monthlyCents, p.priceVersion, p.squareState])).toEqual([
      ['compact_car', 12900, 2, 'pending'],
      ['large_suv', 15900, 2, 'pending'],
    ])
    // a price edit: the old row is superseded (kept), a new one is added; a clear supersedes without a new row
    h.clock.advance(60_000)
    await h.put('catalog/tier-prices', s, {
      rows: [{ tierKey: 'gold', priceVersion: 2, cells: [{ class: 'compact_car', monthlyCents: 13900 }, { class: 'large_suv', monthlyCents: null }] }],
    })
    const rows = await h.db
      .selectFrom('membership_tier_prices')
      .select(['class_key', 'monthly_cents', 'price_version', 'superseded_at'])
      .orderBy('created_at')
      .orderBy('class_key')
      .execute()
    expect(rows.map((x) => [x.class_key, x.monthly_cents, x.price_version, x.superseded_at !== null])).toEqual([
      ['compact_car', 12900, 2, true],
      ['large_suv', 15900, 2, true],
      ['compact_car', 13900, 3, false],
    ])
    expect((await tierOf('gold')).prices.map((p: { class: string; monthlyCents: number }) => [p.class, p.monthlyCents])).toEqual([['compact_car', 13900]])
    const a = await h.db.selectFrom('audit_log').select(['entity_id', 'before', 'after']).where('action', '=', 'catalog.tier_price.update').orderBy('id').execute()
    expect(a.at(-1)).toEqual({
      entity_id: 'gold',
      before: { priceVersion: 2, prices: { compact_car: 12900, large_suv: 15900 } },
      after: { priceVersion: 3, prices: { compact_car: 13900 } },
    })
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ payload: { section: 'catalog', key: 'tier_prices', tiers: ['gold'] } })
    // the same prices again: nothing moves
    const same = await h.put('catalog/tier-prices', s, { rows: [{ tierKey: 'gold', priceVersion: 3, cells: [{ class: 'compact_car', monthlyCents: 13900 }] }] })
    expect(json(same).changed).toEqual([])
    expect((await tierOf('gold')).priceVersion).toBe(3)
    // the history is append-only: a price cannot be edited or deleted in place
    await expect(sql`update membership_tier_prices set monthly_cents = 1`.execute(h.db)).rejects.toThrow(/append-only/)
    await expect(sql`delete from membership_tier_prices`.execute(h.db)).rejects.toThrow(/append-only/)
    await expect(sql`update membership_tier_prices set superseded_at = null where superseded_at is not null`.execute(h.db)).rejects.toThrow(/stays superseded/)
    await sql`update membership_tier_prices set square_state = 'synced', square_variation_id = 'VAR1' where superseded_at is null`.execute(h.db)
  })

  it('is all or nothing: a stale row refuses the whole save (412 naming it); validates with body paths', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    const r = await h.put('catalog/tier-prices', s, {
      rows: [
        { tierKey: 'gold', priceVersion: 1, cells: [{ class: 'compact_car', monthlyCents: 12900 }] },
        { tierKey: 'vip', priceVersion: 4, cells: [{ class: 'compact_car', monthlyCents: 19900 }] },
      ],
    })
    expect(r.statusCode).toBe(412)
    expect(json(r)).toMatchObject({ code: 'VERSION_CONFLICT', meta: { row: 1, tierKey: 'vip', currentVersion: 1 } })
    expect(await h.db.selectFrom('membership_tier_prices').select('id').execute()).toHaveLength(0)
    const cases: [unknown, string][] = [
      [{ rows: [{ tierKey: 'gold', priceVersion: 1, cells: [{ class: 'limo', monthlyCents: 1 }] }] }, 'rows.0.cells.0.class'],
      [{ rows: [{ tierKey: 'gold', priceVersion: 1, cells: [{ class: 'truck', monthlyCents: -1 }] }] }, 'rows.0.cells.0.monthlyCents'],
      [{ rows: [{ tierKey: 'gold', priceVersion: 1, cells: [{ class: 'truck', monthlyCents: 1 }, { class: 'truck', monthlyCents: 2 }] }] }, 'rows.0.cells.1.class'],
      [{ rows: [{ tierKey: 'gold', priceVersion: 1, cells: [] }, { tierKey: 'gold', priceVersion: 1, cells: [] }] }, 'rows.1.tierKey'],
      [{ rows: [] }, 'rows'],
    ]
    for (const [body, path] of cases) {
      const b = await h.put('catalog/tier-prices', s, body)
      expect([b.statusCode, errorPath(b)], JSON.stringify(body)).toEqual([422, path])
    }
    expect((await h.put('catalog/tier-prices', s, { rows: [{ tierKey: 'nope', priceVersion: 1, cells: [] }] })).statusCode).toBe(404)
  })
})

describe('the booking fee', () => {
  it('reads and saves the fee with a required version, bounded, audited and published', async () => {
    const s: Session = await h.admin()
    const g = await h.get('catalog/guest-fee', s)
    const cur = json(g)
    expect(cur).toEqual({ cents: 2500, collect: 'counter', version: cur.version })
    expect(g.headers.etag).toBe(`"${cur.version}"`)
    expect((await h.put('catalog/guest-fee', s, { cents: 2000, collect: 'link' })).statusCode).toBe(428)
    for (const cents of [-1, 100_001]) expect((await h.put('catalog/guest-fee', s, { cents, collect: 'link', version: cur.version })).statusCode).toBe(422)
    const r = await h.put('catalog/guest-fee', s, { cents: 2000, collect: 'link', version: cur.version })
    expect(json(r)).toEqual({ cents: 2000, collect: 'link', version: cur.version + 1 })
    expect((await h.put('catalog/guest-fee', s, { cents: 2000, collect: 'link', version: cur.version })).statusCode).toBe(412)
    expect(json(await h.get('catalog', s))).toMatchObject({ guestBookingFeeCents: 2000, guestFee: { cents: 2000, collect: 'link' } })
    expect(await auditActions(h.db)).toContain('settings.update')
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ type: 'settings.changed' })
  })
})

describe('the pre-size writes are retired (ADR 0170)', () => {
  it('PUT tint-matrix, guest-markup and plans/{key} answer 410 CATALOG_ROUTE_RETIRED and change nothing; their reads stay', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    for (const [url, body] of [
      ['catalog/tint-matrix', { vehicleTypes: [], films: [], prices: [], version: 1 }],
      ['catalog/guest-markup', { pct: 30, version: 1 }],
      ['catalog/plans/gold', { publicLabel: 'Gold', monthlyPriceCents: 9900, perks: [], checkoutUrl: null, version: 1 }],
      ['catalog/plans/premium', {}],
    ] as const) {
      const r = await h.put(url, s, body)
      expect([r.statusCode, json(r).code], url).toEqual([410, 'CATALOG_ROUTE_RETIRED'])
    }
    expect(json(await h.get('catalog/guest-markup', s)).pct).toBe(20)
    expect(json(await h.get('catalog/plans', s)).plans.map((p: { key: string }) => p.key)).toEqual(['essential', 'gold', 'vip', 'exotic'])
    expect((await auditActions(h.db)).filter((a) => a.startsWith('catalog.') || a.startsWith('settings.'))).toEqual([])
  })
})
