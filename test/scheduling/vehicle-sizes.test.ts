// Wave Q2 (ADR 0170): the staff booking path takes a size. The visit is priced at the size named, else the car's size on file, else
// unknown (the smallest size's price, "Confirm size"); the snapshot (charge, regular price, % off, basis, size and label) is on the
// appointment, its add-ons and the invoice lines. Staff change or confirm the size at the shop (PUT /appointments/:id/vehicle-class):
// the visit is priced again, refused whole when it would leave the invoice overpaid. POST /appointments/quote previews a price, and
// PATCH /customers/:id/vehicles/:vehicleId sets a car's size.
import { describe, expect, it } from 'vitest'
import { recordPayment } from '../scheduling-gaps/support.js'
import { useMemRig } from '../memberships/harness.js'
import { apptRow, bookAt, calcOfInvoice, carOf, itemsOf, memberAt, serviceIdOf, setCells, setTier } from '../memberships/sizes-rig.js'

const WASH = 'Express Hand Wash'
const WAX = 'Wax'

describe('vehicle sizes on the staff booking path', () => {
  const m = useMemRig()
  const prices = async () => {
    await setCells(m, WASH, { compact_car: 4000, large_car: 5000, large_suv: 6000 })
    await setCells(m, WAX, { compact_car: 3000, large_suv: 4500 })
  }

  it('snapshots the price at the size named: the appointment, its add-ons, the invoice lines and its size label', async () => {
    await prices()
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv', addons: [WAX] })
    expect(b.body.pricing).toMatchObject({
      vehicleClass: 'large_suv',
      vehicleClassLabel: 'Large SUV',
      basis: 'class',
      needsSizeConfirm: false,
      member: false,
      confirmAtShop: false,
      totals: { listCents: 10500, discountCents: 0, coveredCents: 0, dueCents: 10500 },
    })
    expect(b.body.appointment).toMatchObject({ vehicleClass: 'large_suv', vehicleClassLabel: 'Large SUV', needsSizeConfirm: false })
    expect(await apptRow(m, b.appointmentId)).toMatchObject({
      price_cents: 6000,
      list_price_cents: 6000,
      discount_bp: 0,
      price_basis: 'class',
      vehicle_class: 'large_suv',
      vehicle_class_label: 'Large SUV',
      class_confirmed_at: null,
      membership_id: null,
    })
    const addon = await m.h.t.db
      .selectFrom('appointment_addons')
      .select(['price_cents', 'list_price_cents', 'price_basis'])
      .where('appointment_id', '=', b.appointmentId)
      .executeTakeFirstOrThrow()
    expect(addon).toEqual({ price_cents: 4500, list_price_cents: 4500, price_basis: 'class' })
    expect(await itemsOf(m, b.invoiceId)).toEqual([
      { kind: 'package', name: WASH, price_cents: 6000, list_cents: 6000, discount_bp: 0, price_basis: 'class' },
      { kind: 'addon', name: WAX, price_cents: 4500, list_cents: 4500, discount_bp: 0, price_basis: 'class' },
    ])
    const inv = await m.h.t.db.selectFrom('invoices').select('vehicle_class_label').where('id', '=', b.invoiceId).executeTakeFirstOrThrow()
    expect(inv.vehicle_class_label).toBe('Large SUV')
    // the invoice detail shows the size, the regular price and the member % off (none for a guest)
    const detail = (await m.get(m.superS(), `/invoices/${b.invoiceId}`)).json() as { items: Record<string, unknown>[] }
    expect(detail.items[0]).toMatchObject({ priceCents: 6000, listCents: 6000, discountBp: 0, memberDiscountCents: 0, classLabel: 'Large SUV' })
  })

  it('no size known: the smallest size’s price ("starts at"), Confirm size; a size without a price: the starting price, Confirm price', async () => {
    await prices()
    const unknown = await bookAt(m, 'Liam Chen', WASH)
    expect(await apptRow(m, unknown.appointmentId)).toMatchObject({ price_cents: 4000, price_basis: 'unknown_class', vehicle_class: null })
    expect(unknown.body.appointment).toMatchObject({ needsSizeConfirm: true, needsPriceConfirm: false })
    expect(unknown.body.pricing).toMatchObject({ basis: 'unknown_class', confirmAtShop: true })
    const card = (await m.get(m.superS(), `/appointments/${unknown.appointmentId}`)).json() as Record<string, unknown>
    expect(card).toMatchObject({ needsSizeConfirm: true, vehicleClass: null, priceBasis: 'unknown_class', classConfirmedAt: null })
    const truck = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'truck', start: '2026-06-13T15:00:00-04:00' })
    expect(await apptRow(m, truck.appointmentId)).toMatchObject({ price_cents: 4000, price_basis: 'estimated', vehicle_class: 'truck' })
    expect(truck.body.appointment).toMatchObject({ needsSizeConfirm: false, needsPriceConfirm: true })
  })

  it('a service without prices by size keeps its one price and asks nothing', async () => {
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv' })
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 4500, price_basis: 'base', vehicle_class: 'large_suv' })
    expect(b.body.pricing.confirmAtShop).toBe(false)
  })

  it('the car on file: vehicleId books it (no duplicate), its size prices the visit; a size named is recorded on it (staff)', async () => {
    await prices()
    const car = await carOf(m, 'Liam Chen', { make: 'Honda', model: 'Pilot', cls: 'large_suv', source: 'legacy' })
    const before = await m.h.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', await m.customer('Liam Chen')).execute()
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleId: car })
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ vehicle_id: car, price_cents: 6000, vehicle_class: 'large_suv' })
    const after = await m.h.t.db.selectFrom('vehicles').select('id').where('customer_id', '=', await m.customer('Liam Chen')).execute()
    expect(after).toHaveLength(before.length)
    const c = await bookAt(m, 'Liam Chen', WASH, { vehicleId: car, vehicleClass: 'large_car', start: '2026-06-13T15:00:00-04:00' })
    expect(await apptRow(m, c.appointmentId)).toMatchObject({ price_cents: 5000, vehicle_class: 'large_car' })
    expect(
      await m.h.t.db.selectFrom('vehicles').select(['vehicle_class', 'vehicle_class_source']).where('id', '=', car).executeTakeFirstOrThrow(),
    ).toEqual({ vehicle_class: 'large_car', vehicle_class_source: 'staff' })
  })

  it('refuses a car of another client and a size that is not one of the shop’s (or is off)', async () => {
    const other = await carOf(m, 'Maria Delgado', { make: 'Tesla', model: 'Model 3' })
    const send = async (body: Record<string, unknown>) =>
      m.send(m.superS(), 'POST', '/appointments', {
        customer: { id: await m.customer('Liam Chen') },
        serviceId: await serviceIdOf(m, WASH),
        start: '2026-06-13T15:00:00-04:00',
        ...body,
      })
    const r1 = await send({ vehicleId: other })
    expect(r1.statusCode).toBe(422)
    expect(r1.body).toContain('vehicleId')
    const r2 = await send({ vehicleClass: 'limo' })
    expect(r2.statusCode).toBe(422)
    expect(r2.body).toContain('vehicleClass')
    await m.h.t.db.updateTable('vehicle_classes').set({ active: false }).where('key', '=', 'truck').execute()
    expect((await send({ vehicleClass: 'truck' })).statusCode).toBe(422)
    expect(await m.h.t.db.selectFrom('appointments').select('id').execute()).toHaveLength(0)
  })

  it('an add-on added later is priced at the visit’s size', async () => {
    await prices()
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv' })
    const r = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/addons/${await serviceIdOf(m, WAX)}`, {}, false)
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { addon: { priceCents: number } }).addon.priceCents).toBe(4500)
    expect((await itemsOf(m, b.invoiceId)).map((i) => [i.name, i.price_cents, i.list_cents])).toEqual([
      [WASH, 6000, 6000],
      [WAX, 4500, 4500],
    ])
  })

  it('PUT vehicle-class prices the visit again, confirms the size, syncs the invoice, records the car, audits and publishes', async () => {
    await prices()
    const car = await carOf(m, 'Liam Chen', { make: 'Honda', model: 'Pilot' })
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleId: car, addons: [WAX] })
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 4000, price_basis: 'unknown_class' })
    const row = await apptRow(m, b.appointmentId)
    const r = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'large_suv', version: row.version }, false)
    expect(r.statusCode, r.body).toBe(200)
    const out = r.json() as { appointment: Record<string, unknown>; invoice: { subtotalCents: number; vehicleClassLabel: string }; toast: { title: string } }
    expect(out.appointment).toMatchObject({ vehicleClass: 'large_suv', vehicleClassLabel: 'Large SUV', needsSizeConfirm: false, needsPriceConfirm: false })
    expect(out.invoice).toMatchObject({ subtotalCents: 10500, vehicleClassLabel: 'Large SUV' })
    expect(out.toast.title).toBe('Size updated')
    const after = await apptRow(m, b.appointmentId)
    expect(after).toMatchObject({ price_cents: 6000, price_basis: 'class', vehicle_class: 'large_suv', vehicle_class_label: 'Large SUV' })
    expect(after.class_confirmed_at).not.toBeNull()
    expect(after.version).toBe(row.version + 1)
    expect((await itemsOf(m, b.invoiceId)).map((i) => i.price_cents)).toEqual([6000, 4500])
    expect(await m.h.t.db.selectFrom('vehicles').select(['vehicle_class', 'vehicle_class_source']).where('id', '=', car).executeTakeFirstOrThrow()).toEqual({
      vehicle_class: 'large_suv',
      vehicle_class_source: 'staff',
    })
    expect(await m.h.t.db.selectFrom('audit_log').select('action').where('action', '=', 'appointment.vehicle_class.set').execute()).toHaveLength(1)
    const activity = await m.h.t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', b.appointmentId).execute()
    expect(activity.map((a) => a.text)).toContain('Size changed · Large SUV · $70 → $105')
    const events = await m.h.t.db.selectFrom('realtime_events').select('payload').where('type', '=', 'appointment.updated').execute()
    expect(events.some((e) => (e.payload as { change?: string }).change === 'pricing')).toBe(true)
    // a stale version changes nothing
    const stale = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'compact_car', version: row.version }, false)
    expect(stale.statusCode).toBe(412)
    expect((stale.json() as { code: string }).code).toBe('VERSION_CONFLICT')
  })

  it('refuses a size change that would leave the invoice overpaid (PRICE_CHANGE_OVERPAID), changing nothing', async () => {
    await prices()
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv' })
    const calc = await calcOfInvoice(m, b.invoiceId)
    await recordPayment(m, b.invoiceId, calc.total, { kind: 'cash', deposit: false })
    const row = await apptRow(m, b.appointmentId)
    const r = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'compact_car', version: row.version }, false)
    expect(r.statusCode, r.body).toBe(409)
    expect((r.json() as { code: string }).code).toBe('PRICE_CHANGE_OVERPAID')
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 6000, vehicle_class: 'large_suv', class_confirmed_at: null, version: row.version })
    expect((await itemsOf(m, b.invoiceId)).map((i) => i.price_cents)).toEqual([6000])
    // confirming the size it was booked at changes no price: fine
    const up = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'large_suv', version: row.version }, false)
    expect(up.statusCode, up.body).toBe(200)
  })

  it('refuses a canceled visit', async () => {
    const b = await bookAt(m, 'Liam Chen', WASH)
    expect((await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/cancel`, { reason: 'Client asked' })).statusCode).toBe(200)
    const row = await apptRow(m, b.appointmentId)
    const r = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'large_suv', version: row.version }, false)
    expect(r.statusCode).toBe(409)
    expect((r.json() as { code: string }).code).toBe('INVALID_TRANSITION')
  })

  it('POST /appointments/quote: a guest’s price at a size, and a member’s: % off, and coverage up to the plan size with the difference due', async () => {
    await prices()
    const guest = await m.send(m.superS(), 'POST', '/appointments/quote', { serviceId: await serviceIdOf(m, WASH), addonIds: [await serviceIdOf(m, WAX)], vehicleClass: 'large_suv' }, false)
    expect(guest.statusCode, guest.body).toBe(200)
    expect(guest.json()).toMatchObject({
      pricing: { vehicleClass: 'large_suv', member: false, totals: { listCents: 10500, dueCents: 10500 } },
      member: null,
      lines: [
        { name: WASH, kind: 'package', listCents: 6000, chargeCents: 6000, coverage: null },
        { name: WAX, kind: 'addon', listCents: 4500, chargeCents: 4500, coverage: null },
      ],
    })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const q = await m.send(m.superS(), 'POST', '/appointments/quote', { customerId: mem.customerId, serviceId: await serviceIdOf(m, WASH), addonIds: [await serviceIdOf(m, WAX)], vehicleClass: 'large_suv' }, false)
    expect(q.statusCode, q.body).toBe(200)
    expect(q.json()).toMatchObject({
      pricing: { member: true, totals: { listCents: 10500, discountCents: 400, coveredCents: 4000, dueCents: 2000 + 4100 } },
      member: { tierName: 'Gold', planClass: 'compact_car', planClassLabel: 'Compact car', discountBp: 1000, household: false },
      lines: [
        // covered up to the plan size's $40: the $20 size difference stays due, with no % off
        { chargeCents: 6000, discountBp: 0, coverage: { coveredCents: 4000, differenceCents: 2000, planClassLabel: 'Compact car' }, dueCents: 2000 },
        // $45 less 10% = $40.50, rounded half up to whole dollars: $41
        { chargeCents: 4100, memberDiscountCents: 400, discountBp: 1000, coverage: null, dueCents: 4100 },
      ],
    })
    // nothing was written
    expect(await m.h.t.db.selectFrom('appointments').select('id').execute()).toHaveLength(0)
  })

  it('PATCH /customers/:id/vehicles/:vehicleId sets (or clears) a car’s size as staff, audited; another client’s car is 404', async () => {
    const car = await carOf(m, 'Liam Chen', { make: 'Honda', model: 'Pilot' })
    const liam = await m.customer('Liam Chen')
    const r = await m.send(m.superS(), 'PATCH', `/customers/${liam}/vehicles/${car}`, { vehicleClass: 'compact_suv' }, false)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ vehicle: { id: car, vehicleClass: 'compact_suv', vehicleClassSource: 'staff' } })
    expect(await m.h.t.db.selectFrom('audit_log').select(['action', 'entity_id']).where('action', '=', 'customer.vehicle.update').execute()).toEqual([
      { action: 'customer.vehicle.update', entity_id: car },
    ])
    const cleared = await m.send(m.superS(), 'PATCH', `/customers/${liam}/vehicles/${car}`, { vehicleClass: null }, false)
    expect(cleared.json()).toMatchObject({ vehicle: { vehicleClass: null, vehicleClassSource: null } })
    expect((await m.send(m.superS(), 'PATCH', `/customers/${await m.customer('Maria Delgado')}/vehicles/${car}`, { vehicleClass: 'truck' }, false)).statusCode).toBe(404)
    expect((await m.send(m.superS(), 'PATCH', `/customers/${liam}/vehicles/${car}`, { vehicleClass: 'limo' }, false)).statusCode).toBe(422)
    // the client search shows the size
    const hits = (await m.get(m.superS(), '/customers?q=Liam')).json() as { items: { vehicles: { id: string; vehicleClass: string | null }[] }[] }
    expect(hits.items[0]!.vehicles.find((v) => v.id === car)).toMatchObject({ vehicleClass: null })
  })

  it('needs the right permission on every new route', async () => {
    const view = (await m.h.userWithPermissions(['sched.view', 'cli.view'], 'viewonly@example.test')).session
    const b = await bookAt(m, 'Liam Chen', WASH)
    const row = await apptRow(m, b.appointmentId)
    const car = await carOf(m, 'Liam Chen', { make: 'Honda', model: 'Pilot' })
    const calls = await Promise.all([
      m.send(view, 'POST', '/appointments/quote', { serviceId: await serviceIdOf(m, WASH) }, false),
      m.send(view, 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'truck', version: row.version }, false),
      m.send(view, 'PATCH', `/customers/${await m.customer('Liam Chen')}/vehicles/${car}`, { vehicleClass: 'truck' }, false),
    ])
    expect(calls.map((c) => c.statusCode)).toEqual([403, 403, 403])
    expect(calls.map((c) => (c.json() as { code: string }).code)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
  })
})
