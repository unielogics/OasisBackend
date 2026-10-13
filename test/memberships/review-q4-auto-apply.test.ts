// Sandbox run SANDBOX-F1: what the booking and the quote show as covered is what completion covers. The default tiers' inclusions
// apply by themselves (plan decision 2); an inclusion the owner set to "staff applies" is never shown as covered before staff apply
// it, so completion never silently drops a coverage the client was shown.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { completeAs, creditEvents, idemKey } from '../scheduling-gaps/support.js'
import { useMemRig } from './harness.js'
import { bookAt, memberAt, setCells, setTier } from './sizes-rig.js'

const WASH = 'Express Hand Wash'

describe('a covered visit is covered at completion as the booking showed it (sandbox run F1)', () => {
  const m = useMemRig()

  const itemsOf = (invoiceId: string) =>
    m.h.t.db.selectFrom('invoice_items').select(['name', 'price_cents']).where('invoice_id', '=', invoiceId).orderBy('position').execute()
  const adjustsOf = (invoiceId: string) =>
    m.h.t.db.selectFrom('ledger_events').select(['amount_cents', 'reason']).where('invoice_id', '=', invoiceId).where('type', '=', 'adjust').execute()
  const quote = async (customerId: string, vehicleClass: string) => {
    const serviceId = (await m.h.t.db.selectFrom('services').select('id').where('name', '=', WASH).where('location_id', '=', m.locationId()).executeTakeFirstOrThrow()).id
    const r = await m.send(m.superS(), 'POST', '/appointments/quote', { customerId, serviceId, vehicleClass }, false)
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as { pricing: { totals: { listCents: number; coveredCents: number; dueCents: number } } }
  }

  it('the default tiers’ inclusions apply by themselves', async () => {
    const db = m.h.t.db
    await db.deleteFrom('membership_plans').where('location_id', '=', m.locationId()).execute()
    await ensurePlans(db, { locationId: m.locationId(), clock: m.h.clock, newId: m.h.t.app.newId })
    const rows = await db
      .selectFrom('membership_inclusions as i')
      .innerJoin('membership_plans as p', 'p.id', 'i.plan_id')
      .select(['p.key', 'i.auto_apply'])
      .where('p.location_id', '=', m.locationId())
      .execute()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => !r.auto_apply)).toEqual([])
  })

  it('auto-apply: the quote and the booking show covered $40 and a $20 size difference; completion covers exactly that', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    expect((await quote(mem.customerId, 'large_suv')).pricing.totals).toMatchObject({ listCents: 6000, coveredCents: 4000, dueCents: 2000 })
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'large_suv' })
    expect(b.body.pricing.totals).toMatchObject({ coveredCents: 4000, dueCents: 2000 })
    await completeAs(m, b.appointmentId)
    expect(await itemsOf(b.invoiceId)).toEqual([{ name: WASH, price_cents: 6000 }])
    expect(await adjustsOf(b.invoiceId)).toEqual([expect.objectContaining({ amount_cents: -4000, reason: 'Membership credit' })])
    expect((await creditEvents(m, mem.id)).filter((e) => e.kind === 'redeem')).toHaveLength(1)
  })

  it('staff applies: never shown as covered; the visit is priced as a member line until staff apply it, then covered', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH], autoApply: false }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    expect((await quote(mem.customerId, 'large_suv')).pricing.totals).toMatchObject({ listCents: 6000, coveredCents: 0, dueCents: 5400 })
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'large_suv' })
    expect(b.body.pricing.totals).toMatchObject({ coveredCents: 0, dueCents: 5400 })
    expect(await itemsOf(b.invoiceId)).toEqual([{ name: WASH, price_cents: 5400 }])
    await completeAs(m, b.appointmentId)
    // what the booking said, still: nothing dropped
    expect(await itemsOf(b.invoiceId)).toEqual([{ name: WASH, price_cents: 5400 }])
    expect(await adjustsOf(b.invoiceId)).toEqual([])
    const r = await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/membership-perks/apply`, {}, idemKey())
    expect(r.statusCode, r.body).toBe(201)
    expect(await itemsOf(b.invoiceId)).toEqual([{ name: WASH, price_cents: 6000 }])
    expect(await adjustsOf(b.invoiceId)).toEqual([expect.objectContaining({ amount_cents: -4000 })])
  })

  it('a member who asked for every inclusion to apply by itself sees "staff applies" inclusions covered too', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH], autoApply: false }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    await m.h.t.db.updateTable('memberships').set({ auto_apply: true }).where('id', '=', mem.id).execute()
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'large_suv' })
    expect(b.body.pricing.totals).toMatchObject({ coveredCents: 4000, dueCents: 2000 })
    await completeAs(m, b.appointmentId)
    expect(await adjustsOf(b.invoiceId)).toEqual([expect.objectContaining({ amount_cents: -4000 })])
  })
})
