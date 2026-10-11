// Categories on every appointment DTO the dashboard reads (ADR 0160, plan K, design section 8): board cards (snapshot, list,
// calendar), the appointment file and its client history, command results (booking, add-on change) and the per-category counts
// beside the KPI strip (today's visits, each once: "mixed" for a wash with a tint). Over the real scheduling HTTP routes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { refreshAppointmentCategories } from '../../src/modules/catalog/appointment-categories.js'
import { customersModule } from '../../src/modules/customers/http/module.js'
import { createSchedulingModule } from '../../src/modules/scheduling/module.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useOps } from './helpers.js'

const o = useOps()
let app: TestApp

beforeAll(async () => {
  const user = await makeUser(o.t.db, o.ctx.newId, { first: 'Desk', email: 'desk-categories@example.test' })
  app = await createTestApp({
    testDb: o.t,
    modules: [customersModule, createSchedulingModule(o.ports)],
    authorizer: (location) =>
      createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    env: { STORAGE_PROVIDER: 'fs' },
  })
})
afterAll(async () => {
  await app?.close()
})

const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`
let keyN = 0
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return app.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: method === 'GET' ? {} : { 'idempotency-key': `categories-dto-${++keyN}-abcdefgh` },
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}
async function ok<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const r = await call(method, url, body)
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300)
  return r.json() as T
}

let n = 0
/** A service in the given category, written straight to the table (the design seed has no tint). */
async function service(kind: 'package' | 'addon', category: string): Promise<string> {
  const id = o.ctx.newId()
  await o.t.db
    .insertInto('services')
    .values({ id, location_id: o.locationId, kind, name: `${category} ${kind} ${++n}`, short_name: null, price_cents: 10_000, duration_min: kind === 'addon' ? 0 : 60, sqsp_sku: null, category })
    .execute()
  return id
}

interface Card {
  id: string
  categories: string[]
  category: string | null
}
interface Counts {
  bizDate: string
  total: number
  items: { key: string; label: string; colour: string | null; count: number }[]
}
interface Snapshot {
  timeline: { groups: { items: Card[] }[] }
  completed: { items: Card[] }
  categoryCounts: Counts
}
const cardsOf = (s: Snapshot): Card[] => [...s.timeline.groups.flatMap((g) => g.items), ...s.completed.items]
const count = (c: Counts, key: string): number => c.items.find((i) => i.key === key)?.count ?? 0

describe('board cards', () => {
  it('carry the categories and the visit word on the snapshot, the list and the calendar day; a booking result too', async () => {
    const tintAddon = await service('addon', 'tint')
    const mixed = await ok<{ appointment: Card & { id: string } }>('POST', '/appointments', {
      customer: { id: o.customer('Maria Delgado') },
      serviceId: o.svc('Express Hand Wash').id,
      addonIds: [tintAddon, o.svc('Wax').id],
      start: at('14:00'),
    })
    expect(mixed.appointment).toMatchObject({ categories: ['wash', 'addons', 'tint'], category: 'mixed' })
    const plain = await ok<{ appointment: Card }>('POST', '/appointments', {
      customer: { id: o.customer('Liam Chen') },
      serviceId: o.svc('Express Hand Wash').id,
      start: at('15:00'),
    })
    expect(plain.appointment).toMatchObject({ categories: ['wash'], category: 'wash' })

    const snap = await ok<Snapshot>('GET', '/ops/snapshot?window=today')
    const byId = new Map(cardsOf(snap).map((c) => [c.id, c]))
    expect(byId.get(mixed.appointment.id)).toMatchObject({ categories: ['wash', 'addons', 'tint'], category: 'mixed' })
    expect(byId.get(plain.appointment.id)).toMatchObject({ categories: ['wash'], category: 'wash' })

    const list = await ok<{ items: Card[] }>('GET', '/appointments?from=2026-06-13&limit=50')
    expect(list.items.find((c) => c.id === mixed.appointment.id)).toMatchObject({ category: 'mixed' })

    const day = await ok<{ appointments: Card[] }>('GET', '/calendar/day?date=2026-06-13')
    expect(day.appointments.find((c) => c.id === plain.appointment.id)).toMatchObject({ categories: ['wash'] })
  })
})

describe('the per-category counts beside the KPI strip', () => {
  it('count today’s visits once each (mixed, wash, detail), every active category listed, the same on /ops/kpis and the snapshot', async () => {
    const tintAddon = await service('addon', 'tint')
    const before = (await ok<{ categoryCounts: Counts }>('GET', '/ops/kpis')).categoryCounts
    expect(before).toMatchObject({ bizDate: '2026-06-13', total: 0 })
    // every active default category (zero included), then mixed; nothing for "no category"
    expect(before.items.map((i) => i.key)).toEqual(['wash', 'addons', 'tint', 'detail', 'quote', 'mixed'])
    expect(before.items[0]).toEqual({ key: 'wash', label: 'Wash', colour: '#1FB6FF', count: 0 })
    expect(before.items.at(-1)).toEqual({ key: 'mixed', label: 'Mixed', colour: null, count: 0 })

    await o.book({ serviceName: 'Express Hand Wash', addonIds: [tintAddon], customerName: 'Maria Delgado', at: at('13:00') })
    await o.book({ serviceName: 'Express Hand Wash', addonIds: [o.svc('Wax').id], customerName: 'Liam Chen', at: at('14:00') })
    await o.book({ serviceName: 'Executive Detail', customerName: 'Priya Nair', at: at('15:00') })
    // tomorrow and a canceled visit do not count
    await o.book({ serviceName: 'Express Hand Wash', customerName: 'Tom Bradley', at: at('10:00', '2026-06-14') })
    await o.insert({ customerName: 'Tom Bradley', serviceName: 'Express Hand Wash', at: at('16:00'), status: 'canceled' })

    const k = await ok<{ kpis: unknown[]; categoryCounts: Counts }>('GET', '/ops/kpis')
    expect(k.kpis).toHaveLength(7)
    expect(k.categoryCounts.total).toBe(3)
    expect(count(k.categoryCounts, 'mixed')).toBe(1)
    expect(count(k.categoryCounts, 'wash')).toBe(1)
    expect(count(k.categoryCounts, 'detail')).toBe(1)
    expect(count(k.categoryCounts, 'tint')).toBe(0)
    expect(k.categoryCounts.items.reduce((s, i) => s + i.count, 0)).toBe(k.categoryCounts.total)
    // search and window never change them
    const snap = await ok<Snapshot>('GET', '/ops/snapshot?window=tomorrow&q=zzz')
    expect(snap.categoryCounts).toEqual(k.categoryCounts)
  })

  it('an inactive category shows only while a visit counts under it', async () => {
    await o.t.db.updateTable('catalog_categories').set({ active: false }).where('key', '=', 'quote').execute()
    try {
      expect((await ok<{ categoryCounts: Counts }>('GET', '/ops/kpis')).categoryCounts.items.map((i) => i.key)).not.toContain('quote')
      const quote = await service('package', 'quote')
      await o.book({ serviceId: quote, customerName: 'Maria Delgado', at: at('13:00') })
      const c = (await ok<{ categoryCounts: Counts }>('GET', '/ops/kpis')).categoryCounts
      expect(c.items.map((i) => i.key)).toEqual(['wash', 'addons', 'tint', 'detail', 'quote', 'mixed'])
      expect(count(c, 'quote')).toBe(1)
    } finally {
      await o.t.db.updateTable('catalog_categories').set({ active: true }).where('key', '=', 'quote').execute()
    }
  })
})

describe('the appointment file', () => {
  it('carries the categories, the visit word, and both on each visit of the client history', async () => {
    const past = await o.insert({ customerName: 'Maria Delgado', serviceName: 'Executive Detail', at: at('09:00', '2026-06-01'), status: 'completed', completedAt: at('11:00', '2026-06-01') })
    await o.tx((tx) => refreshAppointmentCategories(tx, past))
    const b = await o.book({ serviceName: 'Express Hand Wash', customerName: 'Maria Delgado', at: at('13:00') })
    const f = await ok<{ categories: string[]; category: string | null; history: { recent: (Card & { service: string })[] } }>(
      'GET',
      `/appointments/${b.appointment.id}`,
    )
    expect(f).toMatchObject({ categories: ['wash'], category: 'wash' })
    expect(f.history.recent.find((h) => h.id === past)).toMatchObject({ categories: ['detail'], category: 'detail' })
  })

  it('an add-on change answers with the new categories: a tint add-on makes the wash mixed, removing it makes it a wash again', async () => {
    const tintAddon = await service('addon', 'tint')
    const b = await o.book({ serviceName: 'Express Hand Wash', customerName: 'Maria Delgado', at: at('13:00') })
    const added = await ok<{ categories: string[]; category: string }>('PUT', `/appointments/${b.appointment.id}/addons/${tintAddon}`)
    expect(added).toMatchObject({ categories: ['wash', 'tint'], category: 'mixed' })
    const again = await ok<{ changed: boolean; categories: string[] }>('PUT', `/appointments/${b.appointment.id}/addons/${tintAddon}`)
    expect(again).toMatchObject({ changed: false, categories: ['wash', 'tint'] })
    const removed = await ok<{ categories: string[]; category: string }>('DELETE', `/appointments/${b.appointment.id}/addons/${tintAddon}`)
    expect(removed).toMatchObject({ categories: ['wash'], category: 'wash' })
    expect(await ok<{ category: string }>('GET', `/appointments/${b.appointment.id}`)).toMatchObject({ category: 'wash' })
  })
})
