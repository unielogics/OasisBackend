// Review Q4 pricing:F2 (staff side, accepted dispute): a service with no prices by size keeps its one price (services.price_cents,
// basis 'base', ADR 0170 rule 1), but the owner says those placeholder prices are not right, so a visit with such a line (the
// package or a live add-on) carries "Confirm price" on the booking answer, the board and the file until the size is confirmed at the
// shop, as a line charged its starting price does. A service priced on a quote (quote_only) never asks.
import { describe, expect, it } from 'vitest'
import { useMemRig } from '../memberships/harness.js'
import { bookAt, setCells } from '../memberships/sizes-rig.js'

const WASH = 'Express Hand Wash'
const WAX = 'Wax'

describe('a line priced at the service’s one price asks to confirm the price (review Q4 pricing:F2)', () => {
  const m = useMemRig()

  const fileOf = async (id: string) => (await m.get(m.superS(), `/appointments/${id}`)).json() as Record<string, unknown>
  const cardOf = async (id: string) => findCard((await m.get(m.superS(), '/ops/snapshot?window=today')).json(), id)

  it('the package without prices by size: Confirm price on the answer, the file and the board; the price is kept', async () => {
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv' })
    const row = await m.h.t.db.selectFrom('appointments').select(['price_cents', 'price_basis']).where('id', '=', b.appointmentId).executeTakeFirstOrThrow()
    expect(row).toEqual({ price_cents: 4500, price_basis: 'base' })
    expect(b.body.appointment).toMatchObject({ needsSizeConfirm: false, needsPriceConfirm: true })
    expect(await fileOf(b.appointmentId)).toMatchObject({ needsPriceConfirm: true, priceBasis: 'base' })
    expect(await cardOf(b.appointmentId)).toMatchObject({ needsPriceConfirm: true })
  })

  it('an add-on without prices by size flags the visit; priced by size, nothing is asked', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv', addons: [WAX] })
    const addon = await m.h.t.db.selectFrom('appointment_addons').select('price_basis').where('appointment_id', '=', b.appointmentId).executeTakeFirstOrThrow()
    expect(addon.price_basis).toBe('base')
    expect(b.body.appointment).toMatchObject({ needsPriceConfirm: true })
    expect(await fileOf(b.appointmentId)).toMatchObject({ needsPriceConfirm: true })
    expect(await cardOf(b.appointmentId)).toMatchObject({ needsPriceConfirm: true })
    await setCells(m, WAX, { compact_car: 2000, large_suv: 3000 })
    const ok = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv', addons: [WAX], start: '2026-06-13T16:00:00-04:00' })
    expect(ok.body.appointment).toMatchObject({ needsPriceConfirm: false })
    expect(await cardOf(ok.appointmentId)).toMatchObject({ needsPriceConfirm: false })
  })

  it('a service priced on a quote never asks', async () => {
    const svc = await m.h.t.db.selectFrom('services').select('id').where('name', '=', WASH).where('location_id', '=', m.locationId()).executeTakeFirstOrThrow()
    await m.h.t.db.updateTable('services').set({ quote_only: true }).where('id', '=', svc.id).execute()
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv' })
    expect(b.body.appointment).toMatchObject({ needsPriceConfirm: false })
    expect(await fileOf(b.appointmentId)).toMatchObject({ needsPriceConfirm: false })
    expect(await cardOf(b.appointmentId)).toMatchObject({ needsPriceConfirm: false })
  })

  it('confirming the size at the shop clears it', async () => {
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv' })
    const v = (await m.h.t.db.selectFrom('appointments').select('version').where('id', '=', b.appointmentId).executeTakeFirstOrThrow()).version
    const r = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/vehicle-class`, { vehicleClass: 'large_suv', version: v }, false)
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { appointment: Record<string, unknown> }).appointment).toMatchObject({ needsPriceConfirm: false })
  })
})

/** The board card of an appointment, wherever the board puts it. */
function findCard(x: unknown, id: string): Record<string, unknown> | undefined {
  if (!x || typeof x !== 'object') return undefined
  if (!Array.isArray(x) && (x as Record<string, unknown>).id === id && 'needsPriceConfirm' in (x as object)) return x as Record<string, unknown>
  for (const v of Object.values(x as object)) {
    const f = findCard(v, id)
    if (f) return f
  }
  return undefined
}
