// Review Q4 pricing:F5: "Confirm price" reads every live line. An add-on charged its starting price because the visit's size has no
// price of its own flags the visit on the booking answer, the board and the appointment file, as the package does; confirming the size
// clears it.
import { describe, expect, it } from 'vitest'
import { useMemRig } from '../memberships/harness.js'
import { bookAt, setCells } from '../memberships/sizes-rig.js'

const WASH = 'Express Hand Wash'
const WAX = 'Wax'

describe('an add-on priced at its starting price asks to confirm the price (review Q4 F5)', () => {
  const m = useMemRig()

  it('flags the visit on the booking answer, the board and the file; a size with the add-on priced does not', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setCells(m, WAX, { compact_car: 2000, truck: 3500 })
    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv', addons: [WAX] })
    const addon = await m.h.t.db.selectFrom('appointment_addons').select(['price_cents', 'price_basis']).where('appointment_id', '=', b.appointmentId).executeTakeFirstOrThrow()
    expect(addon).toEqual({ price_cents: 2000, price_basis: 'estimated' })
    expect(b.body.pricing).toMatchObject({ basis: 'class', confirmAtShop: true })
    expect(b.body.appointment).toMatchObject({ needsSizeConfirm: false, needsPriceConfirm: true })
    const file = (await m.get(m.superS(), `/appointments/${b.appointmentId}`)).json() as Record<string, unknown>
    expect(file).toMatchObject({ needsPriceConfirm: true, priceBasis: 'class' })
    const board = (await m.get(m.superS(), '/ops/snapshot?window=today')).json() as { cards?: Record<string, unknown>[] } & Record<string, unknown>
    const cards = JSON.stringify(board)
    expect(cards).toContain(b.appointmentId)
    const card = findCard(board, b.appointmentId)
    expect(card).toMatchObject({ needsPriceConfirm: true })
    // a visit whose add-on is priced at its size asks nothing
    const ok = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'compact_car', addons: [WAX], start: '2026-06-13T16:00:00-04:00' })
    expect(ok.body.appointment).toMatchObject({ needsPriceConfirm: false })
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
