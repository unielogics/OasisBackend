// A personal link page takes a vehicle size (ADR 0170, wave Q2): the chip prices the visit and is recorded on the client's car
// (source client); a size label sent as the car is the size, never a car; the payment page's invoice shows the size, the regular
// price and the member % off of each line.
import { describe, expect, it } from 'vitest'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { json, TODAY, useLinksHarness, type Json } from './harness.js'

const h = useLinksHarness()

async function cells(name: string, prices: Record<string, number>): Promise<void> {
  await ensureVehicleClasses(h.db, h.locationId)
  const s = await h.db.selectFrom('services').select('id').where('name', '=', name).executeTakeFirstOrThrow()
  await h.db.deleteFrom('service_class_prices').where('service_id', '=', s.id).execute()
  for (const [cls, cents] of Object.entries(prices))
    await h.db.insertInto('service_class_prices').values({ service_id: s.id, location_id: h.locationId, class_key: cls, price_cents: cents }).execute()
}

const wash = (extra: Json = {}): Json => ({ serviceKey: h.key('Express Hand Wash'), addonKeys: [], date: TODAY, startMin: 13 * 60, ...extra })

async function trustedPage() {
  const id = await h.customer()
  await h.trust(id)
  const p = await h.page({ customerId: id, kind: 'calendar' })
  return { id, ...p }
}

describe('sizes on a personal link page', () => {
  it('the size chip prices the visit and is recorded on the client’s car; the answer carries the pricing', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, large_suv: 6000 })
    const { id, session } = await trustedPage()
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ vehicleClass: 'large_suv', vehicle: { make: 'Honda', model: 'Pilot' } }) })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).pricing).toEqual({ vehicleClass: 'large_suv', vehicleClassLabel: 'Large SUV', confirmAtShop: false, listCents: 6000, discountCents: 0, coveredCents: 0, dueCents: 6000 })
    const a = await h.db.selectFrom('appointments').select(['vehicle_id', 'vehicle_class', 'price_cents']).where('customer_id', '=', id).executeTakeFirstOrThrow()
    expect(a).toMatchObject({ vehicle_class: 'large_suv', price_cents: 6000 })
    const car = await h.db.selectFrom('vehicles').select(['make', 'vehicle_class', 'vehicle_class_source']).where('id', '=', a.vehicle_id!).executeTakeFirstOrThrow()
    expect(car).toEqual({ make: 'Honda', vehicle_class: 'large_suv', vehicle_class_source: 'client' })
  })

  it('a size label sent as the car is the size, never a car; the payment page shows the size and the regular price per line', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, truck: 7000 })
    const { id, session } = await trustedPage()
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ vehicle: { label: 'Truck / Van' } }) })
    expect(r.statusCode, r.body).toBe(201)
    const a = await h.db.selectFrom('appointments').select(['vehicle_id', 'vehicle_class', 'price_cents']).where('customer_id', '=', id).executeTakeFirstOrThrow()
    expect(a).toEqual({ vehicle_id: null, vehicle_class: 'truck', price_cents: 7000 })
    expect(await h.db.selectFrom('vehicles').select('id').where('customer_id', '=', id).execute()).toEqual([])
    const invoice = await h.db.selectFrom('invoices').select('id').where('customer_id', '=', id).executeTakeFirstOrThrow()
    const pay = await h.page({ customerId: id, kind: 'pay', invoiceId: invoice.id })
    expect(pay.body.invoice).toMatchObject({
      items: [{ name: 'Express Hand Wash', priceCents: 7000, listCents: 7000, discountBp: 0, memberDiscountCents: 0, classLabel: 'Truck' }],
      coverage: [],
    })
  })

  it('a size that is not one of the shop’s is refused before the link is used', async () => {
    const { session, link } = await trustedPage()
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ vehicleClass: 'limo' }) })
    expect(r.statusCode).toBe(422)
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', link.id).executeTakeFirstOrThrow()).uses).toBe(0)
  })
})
