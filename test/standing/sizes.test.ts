// A standing series books its car (ADR 0170, wave Q2): the series' vehicle is passed to createAppointment, so each visit is that car
// and is priced at its size on file; a car taken off the file is simply not attached.
import { describe, expect, it } from 'vitest'
import { carOf, setCells } from '../memberships/sizes-rig.js'
import { appointmentsOf, idemKey, setFeature, useRig } from './support.js'

describe('standing series and the car’s size', () => {
  const m = useRig()

  it('every visit of the series is the series’ car, priced at its size', async () => {
    await setFeature(m, true)
    await setCells(m, 'Express Hand Wash', { compact_car: 4000, large_suv: 6000 })
    const car = await carOf(m, 'Liam Chen', { make: 'Kia', model: 'Telluride', cls: 'large_suv' })
    const cars = await m.h.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', await m.customer('Liam Chen')).execute()
    const res = await m.send(
      m.superS(),
      'POST',
      '/standing-series',
      {
        customerId: await m.customer('Liam Chen'),
        serviceId: (await m.h.t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').executeTakeFirstOrThrow()).id,
        vehicleId: car,
        cadence: 'weekly',
        startDate: '2026-06-20',
        time: '09:00',
        endDate: '2026-06-27',
      },
      idemKey(),
    )
    expect(res.statusCode, res.body).toBe(201)
    const series = (res.json() as { series: { id: string } }).series.id
    const appts = await appointmentsOf(m, series)
    expect(appts.length).toBeGreaterThan(0)
    const rows = await m.h.t.db
      .selectFrom('appointments')
      .select(['vehicle_id', 'vehicle_class', 'price_cents'])
      .where('standing_series_id', '=', series)
      .execute()
    expect(rows.every((r) => r.vehicle_id === car && r.vehicle_class === 'large_suv' && r.price_cents === 6000)).toBe(true)
    expect(await m.h.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', await m.customer('Liam Chen')).execute()).toHaveLength(cars.length)
  })
})
