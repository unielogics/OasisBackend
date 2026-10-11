// Settings → Catalog over HTTP (ADR 0160, plan A and K): the route contract and its authz, a service's website fields, the
// categories, the tint matrix, the guest markup and the plans' public fields, each with validation, versions (ETag, 428, 412),
// an audit row and a settings.changed event.
import { describe, expect, it } from 'vitest'
import { describeAccess } from '../../src/http/access.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { makeService } from '../domain-schema/helpers.js'
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
  memberPriceCents: 4500,
  guestPriceCents: null,
  vipInclusion: 'included',
  vipNote: 'Included with Gold and VIP',
  quoteOnly: false,
  visibleOnline: true,
  sort: 10,
  ...o,
})

const MATRIX = {
  vehicleTypes: [
    { key: 'sedan', label: 'Sedan / Coupe' },
    { key: 'suv', label: 'SUV / Crossover' },
  ],
  films: [
    { key: 'carbon', label: 'Carbon', vlt: [5, 20, 35] },
    { key: 'ceramic', label: 'Ceramic', vlt: [20, 35] },
  ],
  prices: [
    { vehicle: 'sedan', film: 'carbon', memberMinCents: 22900, memberMaxCents: 27900, guestMinCents: 27500, guestMaxCents: 33500 },
    { vehicle: 'suv', film: 'carbon', memberMinCents: 26900, memberMaxCents: 32900, guestMinCents: 32300, guestMaxCents: 39500 },
    { vehicle: 'sedan', film: 'ceramic', memberMinCents: 37900, memberMaxCents: 44900, guestMinCents: 45500, guestMaxCents: 53900 },
  ],
}

const errorPath = (r: { json(): unknown }): string => (r.json() as { errors: { path: string }[] }).errors[0]!.path

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
    for (const url of ['catalog', `catalog/services/${svc}`, 'catalog/categories', 'catalog/tint-matrix', 'catalog/guest-markup', 'catalog/plans'])
      expect((await h.call('GET', url)).statusCode, url).toBe(401)
    const crew = await h.withPermissions(['sched.view', 'sched.edit', 'set.hours', 'cli.member', 'set.billing'])
    for (const url of ['catalog', `catalog/services/${svc}`, 'catalog/categories', 'catalog/tint-matrix', 'catalog/guest-markup', 'catalog/plans'])
      expect((await h.get(url, crew)).statusCode, url).toBe(200)
    const writes: [string, string, unknown][] = [
      ['PUT', `catalog/services/${svc}`, { ...website(), version: 1 }],
      ['POST', 'catalog/categories', { key: 'ppf', label: 'PPF', colour: '#123456' }],
      ['PATCH', 'catalog/categories/wash', { label: 'Washes' }],
      ['DELETE', 'catalog/categories/quote', undefined],
      ['PUT', 'catalog/tint-matrix', { ...MATRIX, version: 1 }],
      ['PUT', 'catalog/guest-markup', { pct: 25, version: 1 }],
      ['PUT', 'catalog/plans/premium', { publicLabel: 'Gold', monthlyPriceCents: 9900, perks: [], checkoutUrl: null, version: 1 }],
    ]
    for (const [m, url, body] of writes) {
      const r = await h.call(m as 'PUT', url, { session: crew, body })
      expect(r.statusCode, `${m} ${url}`).toBe(403)
      expect(r.json().meta.required, `${m} ${url}`).toEqual(['set.services'])
    }
    expect((await h.get('catalog?includeInactive=true', crew)).statusCode).toBe(403)
    const editor = await h.withPermissions(['set.services'])
    expect((await h.get('catalog?includeInactive=true', editor)).statusCode).toBe(200)
    expect(await auditActions(h.db)).not.toContain('catalog.website.update')
  })
})

describe('GET /catalog', () => {
  it('returns categories, every service with its website fields and effective prices, tint matrix, markup and plans', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 4500 })
    await makeService(h.db, h.fx, { kind: 'addon', name: 'Wax', priceCents: 3900 })
    await makeService(h.db, h.fx, { name: 'Old Package', active: false })
    const s = await h.admin()
    const b = json(await h.get('catalog', s))
    expect(b.categories.map((c: { key: string }) => c.key)).toEqual(['wash', 'addons', 'tint', 'detail', 'quote'])
    expect(b.categories[0]).toEqual({ key: 'wash', label: 'Wash', colour: '#1FB6FF', sort: 10, active: true, builtin: true, version: 1 })
    expect(b.packages.map((p: { name: string }) => p.name)).toEqual(['Express Hand Wash'])
    expect(b.packages[0]).toMatchObject({
      category: 'wash',
      publicName: null,
      memberPriceCents: null,
      guestPriceCents: null,
      vipInclusion: 'none',
      quoteOnly: false,
      visibleOnline: true,
      effective: { memberPriceCents: 4500, guestPriceCents: 5400, tintFilm: null },
    })
    expect(b.addons[0]).toMatchObject({ name: 'Wax', category: 'addons', effective: { memberPriceCents: 3900, guestPriceCents: 4700 } })
    expect(b.tintMatrix).toEqual({ vehicleTypes: [], films: [], prices: [], version: expect.any(Number) })
    expect(b.guestMarkup).toEqual({ pct: 20, version: expect.any(Number) })
    expect(b.guestBookingFeeCents).toBe(2500)
    expect(b.plans.map((p: { key: string; websiteTier: string | null }) => [p.key, p.websiteTier])).toEqual([
      ['essential', null],
      ['premium', 'gold'],
      ['executive', 'vip'],
      ['exotic', null],
    ])
    const all = json(await h.get('catalog?includeInactive=true', s))
    expect(all.packages.map((p: { name: string }) => p.name)).toContain('Old Package')
  })
})

describe('a service’s website fields', () => {
  it('GET carries an ETag; PUT requires the version, trims, saves, audits and publishes', async () => {
    const id = await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 5400 })
    const s = await h.admin()
    const g = await h.get(`catalog/services/${id}`, s)
    expect(g.statusCode).toBe(200)
    expect(g.headers.etag).toBe('"1"')
    expect((await h.put(`catalog/services/${id}`, s, website())).statusCode).toBe(428)
    expect((await h.put(`catalog/services/${id}`, s, { ...website(), version: 7 })).statusCode).toBe(412)

    const r = await h.put(`catalog/services/${id}`, s, { ...website(), version: 1 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers.etag).toBe('"2"')
    expect(json(r)).toMatchObject({
      publicName: 'Signature Hand Wash',
      description: 'Exterior + interior',
      memberPriceCents: 4500,
      guestPriceCents: null,
      vipInclusion: 'included',
      effective: { memberPriceCents: 4500, guestPriceCents: 5400, tintFilm: null },
      changed: true,
      appointmentsUpdated: 0,
      version: 2,
    })
    expect(await auditActions(h.db)).toContain('catalog.website.update')
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ type: 'settings.changed', payload: { section: 'services', key: id } })
    // the same save again changes nothing; If-Match works as the version
    const again = await h.put(`catalog/services/${id}`, s, website(), { 'if-match': '"2"' })
    expect(json(again)).toMatchObject({ changed: false, version: 2 })
  })

  it('refuses bad values with field paths (422)', async () => {
    const id = await makeService(h.db, h.fx, { name: 'Express Hand Wash' })
    const s = await h.admin()
    const bad: [Record<string, unknown>, string][] = [
      [{ category: 'ppf' }, 'category'],
      [{ memberPriceCents: -1 }, 'memberPriceCents'],
      [{ guestPriceCents: 10_000_001, memberPriceCents: null }, 'guestPriceCents'],
      [{ memberPriceCents: 5000, guestPriceCents: 4000 }, 'guestPriceCents'],
      [{ vipInclusion: 'allowance', vipNote: '   ' }, 'vipNote'],
      [{ publicName: 'x'.repeat(81) }, 'publicName'],
      [{ description: 'x'.repeat(1001) }, 'description'],
      [{ sort: 100_001 }, 'sort'],
    ]
    for (const [patch, path] of bad) {
      const r = await h.put(`catalog/services/${id}`, s, { ...website(patch), version: 1 })
      expect(r.statusCode, JSON.stringify(patch)).toBe(422)
      expect(errorPath(r), JSON.stringify(patch)).toBe(path)
    }
    expect((await h.put(`catalog/services/${id}`, s, { ...website(), extra: 1, version: 1 })).statusCode).toBe(422)
    expect((await h.put(`catalog/services/${id}`, s, { ...website({ vipInclusion: 'gold' }), version: 1 })).statusCode).toBe(422)
    // a turned-off category takes no new service
    const admin = await h.admin()
    await h.patch('catalog/categories/quote', admin, { active: false })
    const off = await h.put(`catalog/services/${id}`, s, { ...website({ category: 'quote' }), version: 1 })
    expect(off.statusCode).toBe(422)
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

    const stale = await h.patch('catalog/categories/ppf', s, { label: 'PPF', version: 9 })
    expect(stale.statusCode).toBe(412)
    const p = await h.patch('catalog/categories/ppf', s, { label: 'PPF', colour: '#112233', sort: 5, active: false, version: 1 })
    expect(p.statusCode).toBe(200)
    expect(p.headers.etag).toBe('"2"')
    expect(json(p)).toMatchObject({ key: 'ppf', label: 'PPF', colour: '#112233', sort: 5, active: false, changed: true, version: 2 })
    expect(json(await h.patch('catalog/categories/ppf', s, { label: 'PPF' }))).toMatchObject({ changed: false, version: 2 })
    // the key is not a field
    expect((await h.patch('catalog/categories/ppf', s, { key: 'film' })).statusCode).toBe(422)
    const list = json(await h.get('catalog/categories', s)).categories.map((x: { key: string }) => x.key)
    expect(list).toEqual(['ppf', 'wash', 'addons', 'tint', 'detail', 'quote'])

    const d = await h.del('catalog/categories/ppf', s)
    expect(json(d)).toEqual({ key: 'ppf', removed: true })
    expect(await auditActions(h.db)).toEqual(
      expect.arrayContaining(['catalog.category.create', 'catalog.category.update', 'catalog.category.delete']),
    )
    const ev = (await events(h.db, 'settings')).filter((e) => e.payload.key === 'categories')
    expect(ev).toHaveLength(3)
    expect((await h.patch('catalog/categories/ppf', s, { label: 'x' })).statusCode).toBe(404)
  })

  it('validates keys, labels, colours and orders; never deletes a default or a used category', async () => {
    const s = await h.admin()
    const cases: [Record<string, unknown>, string][] = [
      [{ key: 'Bad Key', label: 'x', colour: '#000000' }, 'key'],
      [{ key: '9lives', label: 'x', colour: '#000000' }, 'key'],
      [{ key: 'ok', label: '   ', colour: '#000000' }, 'label'],
      [{ key: 'ok', label: 'x'.repeat(41), colour: '#000000' }, 'label'],
      [{ key: 'ok', label: 'x', colour: 'blue' }, 'colour'],
      [{ key: 'ok', label: 'x', colour: '#000000', sort: 1e6 }, 'sort'],
    ]
    for (const [body, path] of cases) {
      const r = await h.post('catalog/categories', s, body)
      expect(r.statusCode, JSON.stringify(body)).toBe(422)
      expect(errorPath(r)).toBe(path)
    }
    expect(json(await h.del('catalog/categories/wash', s)).code).toBe('CATEGORY_BUILTIN')
    await h.post('catalog/categories', s, { key: 'ppf', label: 'PPF', colour: '#000000' })
    const id = await makeService(h.db, h.fx, { name: 'Clear bra', active: false })
    await h.db.updateTable('services').set({ category: 'ppf' }).where('id', '=', id).execute()
    const used = await h.del('catalog/categories/ppf', s)
    expect(used.statusCode).toBe(409)
    expect(json(used)).toMatchObject({ code: 'CATEGORY_IN_USE', meta: { services: 1 } })
    for (let i = 0; i < 14; i++) await h.post('catalog/categories', s, { key: `extra_${i}`, label: `Extra ${i}`, colour: '#000000' })
    expect(json(await h.post('catalog/categories', s, { key: 'one_more', label: 'More', colour: '#000000' })).code).toBe('CATEGORY_LIMIT')
  })
})

describe('tint matrix and guest markup', () => {
  it('saves the whole matrix with a required version and refuses broken ones with body paths', async () => {
    const s = await h.admin()
    const g = await h.get('catalog/tint-matrix', s)
    const v = json(g).version
    expect(g.headers.etag).toBe(`"${v}"`)
    expect((await h.put('catalog/tint-matrix', s, MATRIX)).statusCode).toBe(428)
    const r = await h.put('catalog/tint-matrix', s, { ...MATRIX, version: v })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toEqual({ ...MATRIX, version: v + 1 })
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ payload: { section: 'catalog', key: 'catalog.tint_matrix' } })
    expect((await h.put('catalog/tint-matrix', s, { ...MATRIX, version: v })).statusCode).toBe(412)

    const broken: [unknown, string][] = [
      [{ ...MATRIX, prices: [{ ...MATRIX.prices[0], vehicle: 'boat' }] }, 'prices.0.vehicle'],
      [{ ...MATRIX, prices: [{ ...MATRIX.prices[0], memberMaxCents: 100 }] }, 'prices.0.memberMaxCents'],
      [{ ...MATRIX, prices: [MATRIX.prices[0], MATRIX.prices[0]] }, 'prices.1'],
      [{ ...MATRIX, films: [{ key: 'Carbon', label: 'Carbon', vlt: [] }] }, 'films.0.key'],
      [{ ...MATRIX, films: [{ key: 'carbon', label: 'Carbon', vlt: [0] }] }, 'films.0.vlt.0'],
    ]
    for (const [body, path] of broken) {
      const b = await h.put('catalog/tint-matrix', s, { ...(body as object), version: v + 1 })
      expect(b.statusCode, path).toBe(422)
      expect(errorPath(b)).toBe(path)
    }
  })

  it('a tint package tagged with a film shows that film’s lowest prices', async () => {
    const s = await h.admin()
    await h.put('catalog/tint-matrix', s, { ...MATRIX, version: json(await h.get('catalog/tint-matrix', s)).version })
    const id = await makeService(h.db, h.fx, { name: 'Ceramic window tint', durationMin: 180, priceCents: 45500 })
    await h.db.updateTable('services').set({ category: 'tint', tags: ['tint', 'ceramic'] }).where('id', '=', id).execute()
    expect(json(await h.get(`catalog/services/${id}`, s)).effective).toEqual({ memberPriceCents: 37900, guestPriceCents: 45500, tintFilm: 'ceramic' })
  })

  it('the markup moves every computed guest price and is bounded', async () => {
    const id = await makeService(h.db, h.fx, { name: 'Express Hand Wash', priceCents: 4500 })
    const s = await h.admin()
    const m = json(await h.get('catalog/guest-markup', s))
    expect(m.pct).toBe(20)
    expect((await h.put('catalog/guest-markup', s, { pct: 25 })).statusCode).toBe(428)
    for (const pct of [-1, 201]) expect((await h.put('catalog/guest-markup', s, { pct, version: m.version })).statusCode).toBe(422)
    const r = await h.put('catalog/guest-markup', s, { pct: 30, version: m.version })
    expect(json(r)).toEqual({ pct: 30, version: m.version + 1 })
    expect(json(await h.get(`catalog/services/${id}`, s)).effective.guestPriceCents).toBe(5900) // 45 x 1.3 = 58.5 -> 59
    expect(await auditActions(h.db)).toContain('settings.update')
  })
})

describe('plans’ public fields', () => {
  const plan = (o: Record<string, unknown> = {}) => ({
    publicLabel: 'Gold',
    monthlyPriceCents: 9900,
    perks: [' 4 hand washes a month ', '', 'No booking fees'],
    checkoutUrl: 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?productId=abc',
    ...o,
  })

  it('saves label, price, perks and the Squarespace checkout link with a required version', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s: Session = await h.admin()
    const before = json(await h.get('catalog/plans', s)).plans.find((p: { key: string }) => p.key === 'premium')
    expect((await h.put('catalog/plans/premium', s, plan())).statusCode).toBe(428)
    const r = await h.put('catalog/plans/premium', s, { ...plan(), version: before.version })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toMatchObject({
      key: 'premium',
      websiteTier: 'gold',
      publicLabel: 'Gold',
      monthlyPriceCents: 9900,
      perks: ['4 hand washes a month', 'No booking fees'],
      checkoutUrl: 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?productId=abc',
      changed: true,
      version: before.version + 1,
    })
    expect(r.headers.etag).toBe(`"${before.version + 1}"`)
    expect(await auditActions(h.db)).toContain('catalog.plan.update')
    expect((await events(h.db, 'settings')).at(-1)).toMatchObject({ payload: { section: 'catalog', key: 'plans', plan: 'premium' } })
    expect((await h.put('catalog/plans/premium', s, { ...plan(), version: before.version })).statusCode).toBe(412)
    expect((await h.put('catalog/plans/gold', s, { ...plan(), version: 1 })).statusCode).toBe(422)
  })

  it('takes Squarespace https links only, and checks the perks', async () => {
    await ensurePlans(h.db, { locationId: h.fx.locationId, clock: h.clock, newId: h.fx.newId })
    const s = await h.admin()
    const v = json(await h.get('catalog/plans', s)).plans.find((p: { key: string }) => p.key === 'executive').version
    for (const checkoutUrl of [
      'http://oasis.squarespace.com/checkout',
      'https://squarespace.com.evil.example/checkout',
      'https://evil.example/squarespace.com',
      'https://user:pw@oasis.squarespace.com/x',
      'https://oasis.squarespace.com:8443/x',
      'https://OASIS.squarespace.com/x',
      'javascript:alert(1)',
      `https://oasis.squarespace.com/${'x'.repeat(2048)}`,
    ]) {
      const r = await h.put('catalog/plans/executive', s, { ...plan({ checkoutUrl }), version: v })
      expect(r.statusCode, checkoutUrl).toBe(422)
      expect(errorPath(r)).toBe('checkoutUrl')
    }
    for (const [o, path] of [
      [{ perks: Array.from({ length: 13 }, (_, i) => `Perk ${i}`) }, 'perks'],
      [{ perks: ['x'.repeat(121)] }, 'perks.0'],
      [{ perks: ['Same', 'same'] }, 'perks'],
      [{ monthlyPriceCents: -5 }, 'monthlyPriceCents'],
      [{ publicLabel: 'x'.repeat(41) }, 'publicLabel'],
    ] as const) {
      const r = await h.put('catalog/plans/executive', s, { ...plan(o), version: v })
      expect(r.statusCode, path).toBe(422)
      expect(errorPath(r)).toBe(path)
    }
    // squarespace.com itself and a blank link (= none) are fine
    expect(json(await h.put('catalog/plans/executive', s, { ...plan({ checkoutUrl: 'https://squarespace.com/x' }), version: v })).checkoutUrl).toBe(
      'https://squarespace.com/x',
    )
    expect(json(await h.put('catalog/plans/executive', s, { ...plan({ checkoutUrl: '  ' }), version: v + 1 })).checkoutUrl).toBeNull()
  })
})
