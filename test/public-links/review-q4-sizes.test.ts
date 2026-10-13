// Review Q4 security:SEC-2: a size staff set on a car outranks the size a client names for it. A client booking their staff-confirmed
// Truck as a Compact car is priced at Truck (the car keeps Truck), and the board notes what the client chose.
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

describe('a staff-set size outranks the client’s (review Q4 SEC-2)', () => {
  it('prices the visit at the staff size, keeps the car’s size and notes the client’s choice for staff', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, truck: 7000 })
    const id = await h.customer()
    await h.trust(id)
    const car = h.newId()
    await h.db
      .insertInto('vehicles')
      .values({ id: car, customer_id: id, make: 'Ford', model: 'F-150', plate: 'TRK123', vehicle_class: 'truck', vehicle_class_source: 'staff' })
      .execute()
    const { session } = await h.page({ customerId: id, kind: 'calendar' })
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ vehicleClass: 'compact_car', vehicle: { make: 'Ford', model: 'F-150', plate: 'TRK123' } }) })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).pricing).toMatchObject({ vehicleClass: 'truck', listCents: 7000, dueCents: 7000 })
    const a = await h.db.selectFrom('appointments').select(['id', 'vehicle_id', 'vehicle_class', 'price_cents']).where('customer_id', '=', id).executeTakeFirstOrThrow()
    expect(a).toMatchObject({ vehicle_id: car, vehicle_class: 'truck', price_cents: 7000 })
    expect(await h.db.selectFrom('vehicles').select(['vehicle_class', 'vehicle_class_source']).where('id', '=', car).executeTakeFirstOrThrow()).toEqual({
      vehicle_class: 'truck',
      vehicle_class_source: 'staff',
    })
    const notes = await h.db.selectFrom('activity_log').select(['text', 'channels']).where('appointment_id', '=', a.id).execute()
    expect(notes).toContainEqual({ text: 'Size · the client chose Compact car; staff set Truck for this car, so it is priced at Truck', channels: ['internal'] })
  })

  it('a size the client set before is still theirs to change', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, truck: 7000 })
    const id = await h.customer()
    await h.trust(id)
    await h.db
      .insertInto('vehicles')
      .values({ id: h.newId(), customer_id: id, make: 'Ford', model: 'F-150', plate: 'TRK124', vehicle_class: 'truck', vehicle_class_source: 'client' })
      .execute()
    const { session } = await h.page({ customerId: id, kind: 'calendar' })
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ vehicleClass: 'compact_car', vehicle: { make: 'Ford', model: 'F-150', plate: 'TRK124' } }) })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).pricing).toMatchObject({ vehicleClass: 'compact_car', listCents: 4000 })
  })
})
