// Payments split by category (ADR 0160, plan K, design section 8): each invoice row of GET /payments/invoices carries the visit's
// categories (its appointment's; without an appointment, those of the invoiced services) and the word it counts under, and
// GET /payments/summary splits the range's invoices by that word: counts, gross, net and outstanding per category, "mixed" for a
// multi-category visit, every active category listed (zero included).
import { beforeEach, describe, expect, it } from 'vitest'
import { ensureCatalogCategories } from '../../src/modules/catalog/categories.js'
import { makeCustomer, makeInvoice } from './helpers.js'
import { usePayHarness } from './http.js'

const p = usePayHarness()
const get = (path: string) => p.get(p.people().rafael, path)

let n = 0
async function service(category: string, kind: 'package' | 'addon' = 'package'): Promise<string> {
  const env = p.env()
  const id = env.newId()
  await p.h.t.db
    .insertInto('services')
    .values({ id, location_id: env.locationId, kind, name: `${category} ${kind} ${++n}`, short_name: null, price_cents: 5000, duration_min: kind === 'addon' ? 0 : 60, sqsp_sku: null, category })
    .execute()
  return id
}

/** An appointment holding these categories (as appointments.categories keeps them) and its invoice. */
async function visit(categories: string[], items: { name: string; priceCents: number }[], o: { serviceId: string; bizDate?: string }) {
  const env = p.env()
  const db = p.h.t.db
  const customerId = await makeCustomer(db, env)
  const apptId = env.newId()
  await db
    .insertInto('appointments')
    .values({
      id: apptId,
      location_id: env.locationId,
      customer_id: customerId,
      service_id: o.serviceId,
      package_name: items[0]!.name,
      price_cents: items[0]!.priceCents,
      duration_min: 60,
      status: 'completed',
      scheduled_start: new Date('2026-06-13T09:00:00-04:00'),
      scheduled_end: new Date('2026-06-13T10:00:00-04:00'),
      categories,
    })
    .execute()
  const inv = await makeInvoice(db, env, { customerId, items, bizDate: o.bizDate })
  await db.updateTable('invoices').set({ appointment_id: apptId }).where('id', '=', inv.id).execute()
  return inv
}

interface Row {
  invoiceNo: number
  categories: string[]
  category: string | null
}
interface Split {
  key: string
  label: string
  colour: string | null
  count: number
  grossCents: number
  netCents: number
  outstandingCents: number
}

describe('payments by category', () => {
  beforeEach(async () => {
    await ensureCatalogCategories(p.h.t.db, p.env().locationId)
  })

  it('rows carry the categories; the summary splits the range by visit word with counts and amounts', async () => {
    const wash = await service('wash')
    const tintAddon = await service('tint', 'addon')
    const detail = await service('detail')
    const mixed = await visit(['wash', 'addons', 'tint'], [{ name: 'Signature Hand Wash', priceCents: 4500 }, { name: 'Tint', priceCents: 22900 }], { serviceId: wash })
    const washOnly = await visit(['wash', 'addons'], [{ name: 'Signature Hand Wash', priceCents: 4500 }, { name: 'Wax', priceCents: 1500 }], { serviceId: wash })
    // an invoice without an appointment: the categories of the services its items name
    const env = p.env()
    const imported = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 30000 }, { name: 'Tint', priceCents: 10000 }] })
    await p.h.t.db.updateTable('invoice_items').set({ service_id: detail }).where('id', '=', imported.itemIds[0]!).execute()
    await p.h.t.db.updateTable('invoice_items').set({ service_id: tintAddon }).where('id', '=', imported.itemIds[1]!).execute()
    // nothing to say: no appointment, no service
    const bare = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Gift card', priceCents: 5000 }] })
    // another day outside the range
    await visit(['detail'], [{ name: 'Executive Detail', priceCents: 30000 }], { serviceId: detail, bizDate: '2026-05-01' })

    const list = p.json<{ items: Row[] }>(await get('payments/invoices?range=today&limit=500'))
    const row = (no: number) => list.items.find((r) => r.invoiceNo === no)
    expect(row(mixed.no)).toMatchObject({ categories: ['wash', 'addons', 'tint'], category: 'mixed' })
    expect(row(washOnly.no)).toMatchObject({ categories: ['wash', 'addons'], category: 'wash' })
    expect(row(imported.no)).toMatchObject({ categories: ['tint', 'detail'], category: 'mixed' })
    expect(row(bare.no)).toMatchObject({ categories: [], category: null })

    const s = p.json<{ byCategory: Split[]; kpis: { grossSales: number; outstanding: number; netRevenue: number } }>(await get('payments/summary?range=today'))
    expect(s.byCategory.map((x) => x.key)).toEqual(['wash', 'addons', 'tint', 'detail', 'quote', 'mixed', '_none'])
    const by = new Map(s.byCategory.map((x) => [x.key, x]))
    expect(by.get('wash')).toEqual({ key: 'wash', label: 'Wash', colour: '#1FB6FF', count: 1, grossCents: 6000, netCents: 6000, outstandingCents: 6420 })
    expect(by.get('mixed')).toMatchObject({ label: 'Mixed', colour: null, count: 2, grossCents: 4500 + 22900 + 30000 + 10000 })
    expect(by.get('_none')).toMatchObject({ label: 'No category', colour: null, count: 1, grossCents: 5000 })
    expect(by.get('tint')).toMatchObject({ count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 })
    // the split adds up to the KPIs
    const total = (k: keyof Split) => s.byCategory.reduce((a, x) => a + (x[k] as number), 0)
    expect(total('count')).toBe(4)
    expect(total('grossCents')).toBe(s.kpis.grossSales)
    expect(total('outstandingCents')).toBe(s.kpis.outstanding)
  })

  it('an empty range lists every active category at zero, then mixed', async () => {
    const s = p.json<{ byCategory: Split[] }>(await get('payments/summary?range=today'))
    expect(s.byCategory).toEqual([
      { key: 'wash', label: 'Wash', colour: '#1FB6FF', count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 },
      { key: 'addons', label: 'Add-ons', colour: '#7FD6FF', count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 },
      { key: 'tint', label: 'Tint', colour: '#2EE59D', count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 },
      { key: 'detail', label: 'Detail', colour: '#FFB547', count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 },
      { key: 'quote', label: 'Quote', colour: '#8C97A1', count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 },
      { key: 'mixed', label: 'Mixed', colour: null, count: 0, grossCents: 0, netCents: 0, outstandingCents: 0 },
    ])
  })
})
