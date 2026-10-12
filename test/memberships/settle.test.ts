// Settling a member's visit (ADR 0170, wave Q2: settleMembershipVisit). The membership the client holds or shares (household) covers
// each line one of its inclusions names, up to the price at the plan size: a Gold (Compact car plan) member's Large SUV wash is
// covered $40 of $60 and the $20 size difference stays due, with no % off on it. Lines are priced again first (covered: the regular
// price; others: the member price), then ONE adjust + ONE redeem per covered line. Completion never fails because of it; an
// emergency closure gives back every redeem of a canceled visit. The invoice calc and the ledger integrity check do not change.
import { describe, expect, it } from 'vitest'
import { checkLedgerIntegrity } from '../../src/modules/payments/jobs-integrity.js'
import { creditEvents, idemKey, recordPayment } from '../scheduling-gaps/support.js'
import { useMemRig } from './harness.js'
import { apptRow, bookAt, calcOfInvoice, itemsOf, memberAt, setCells, setTier, setTierPrice } from './sizes-rig.js'

const WASH = 'Express Hand Wash'
const WAX = 'Wax'

const adjustsOf = (m: ReturnType<typeof useMemRig>, invoiceId: string) =>
  m.h.t.db
    .selectFrom('ledger_events')
    .select(['id', 'amount_cents', 'reason', 'note', 'source'])
    .where('invoice_id', '=', invoiceId)
    .where('type', '=', 'adjust')
    .orderBy('seq')
    .execute()

const redeemsOf = (m: ReturnType<typeof useMemRig>, appointmentId: string) =>
  m.h.t.db
    .selectFrom('membership_credit_events')
    .select(['membership_id', 'inclusion_id', 'service_id', 'line_cents', 'covered_cents', 'plan_class', 'visit_class', 'ledger_event_id', 'idempotency_key', 'note'])
    .where('appointment_id', '=', appointmentId)
    .where('kind', '=', 'redeem')
    .orderBy('created_at')
    .orderBy('id')
    .execute()

describe('settling a member’s visit', () => {
  const m = useMemRig()

  it('covers up to the plan size: Gold (Compact car plan), Large SUV visit: $40 covered, the $20 difference due with no % off', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    const [wash] = await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'large_suv' })
    // booked at the regular price (the inclusion will cover it), with the coverage previewed
    expect(b.body.pricing).toMatchObject({ member: true, totals: { listCents: 6000, discountCents: 0, coveredCents: 4000, dueCents: 2000 } })
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 6000, discount_bp: 0, membership_id: mem.id })
    await m.complete(b.appointmentId)

    const adj = await adjustsOf(m, b.invoiceId)
    expect(adj).toEqual([
      expect.objectContaining({
        amount_cents: -4000,
        reason: 'Membership credit',
        source: 'system',
        note: 'Express Hand Wash · Gold (Compact car plan) · covers $40 of $60 · auto-applied',
      }),
    ])
    expect(await redeemsOf(m, b.appointmentId)).toEqual([
      expect.objectContaining({
        membership_id: mem.id,
        inclusion_id: wash,
        line_cents: 6000,
        covered_cents: 4000,
        plan_class: 'compact_car',
        visit_class: 'large_suv',
        ledger_event_id: adj[0]!.id,
        idempotency_key: `redeem:${b.appointmentId}:${wash}`,
      }),
    ])
    // the difference stays due, taxed, with no % off
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 2000, adj: -4000, tax: 140, total: 2140, balance: 2140 })
    expect(await itemsOf(m, b.invoiceId)).toEqual([
      { kind: 'package', name: WASH, price_cents: 6000, list_cents: 6000, discount_bp: 0, price_basis: 'class' },
    ])
    // the invoice detail, the appointment file's summary and the board say "Covered $40 · $20 size difference due"
    const detail = (await m.get(m.superS(), `/invoices/${b.invoiceId}`)).json() as { adjustments: { coverage: unknown }[] }
    expect(detail.adjustments).toEqual([
      expect.objectContaining({
        amountCents: -4000,
        coverage: { serviceName: WASH, coveredCents: 4000, lineCents: 6000, differenceCents: 2000, planClassLabel: 'Compact car' },
      }),
    ])
    const file = (await m.get(m.superS(), `/appointments/${b.appointmentId}`)).json() as { invoice: { coverage: unknown[]; vehicleClassLabel: string } }
    expect(file.invoice).toMatchObject({
      vehicleClassLabel: 'Large SUV',
      coverage: [{ serviceName: WASH, coveredCents: 4000, lineCents: 6000, differenceCents: 2000, planClassLabel: 'Compact car' }],
    })
    // the calc and the integrity check are untouched by coverage
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('several inclusions on one visit: one adjust + one redeem per covered line (wash, and an add-on included every visit)', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setCells(m, WAX, { compact_car: 3000 })
    const [wash, wax] = await setTier(m, 'gold', {
      inclusions: [
        { label: 'Hand wash', services: [WASH], autoApply: false },
        { label: 'Wax every wash', services: [WAX], mode: 'every_visit', autoApply: false },
      ],
    })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', addons: [WAX] })
    const r = await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/membership-perks/apply`, {}, idemKey())
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({
      membershipId: mem.id,
      rule: { id: wash, label: 'Hand wash' },
      discountCents: 7000,
      credits: { left: 1, used: 1 },
      repriced: false,
      lines: [
        { inclusionId: wash, serviceName: WASH, kind: 'package', lineCents: 4000, coveredCents: 4000, differenceCents: 0 },
        { inclusionId: wax, serviceName: WAX, kind: 'addon', lineCents: 3000, coveredCents: 3000, differenceCents: 0 },
      ],
    })
    expect((await adjustsOf(m, b.invoiceId)).map((a) => a.amount_cents)).toEqual([-4000, -3000])
    expect((await redeemsOf(m, b.appointmentId)).map((e) => e.idempotency_key)).toEqual([
      `redeem:${b.appointmentId}:${wash}`,
      `redeem:${b.appointmentId}:${wax}`,
    ])
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, balance: 0 })
    // settled once: a second apply is refused and nothing more is written
    const again = await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/membership-perks/apply`, {}, idemKey())
    expect(again.statusCode).toBe(409)
    expect((again.json() as { code: string }).code).toBe('MEMBERSHIP_CREDIT_APPLIED')
    expect(await adjustsOf(m, b.invoiceId)).toHaveLength(2)
  })

  it('an included line the allowance no longer covers gets the member price at completion; a newly covered one goes back to the regular price', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH], perCycle: 1 }] })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const a = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car' })
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', start: '2026-06-13T15:00:00-04:00' })
    // both previewed as covered at booking: charged the regular price
    expect((await apptRow(m, b.appointmentId)).price_cents).toBe(4000)
    await m.complete(a.appointmentId)
    expect(await calcOfInvoice(m, a.invoiceId)).toMatchObject({ sub: 0 })
    await m.complete(b.appointmentId)
    // the one credit is spent: the member price ($40 less 10%), nothing covered
    expect(await redeemsOf(m, b.appointmentId)).toHaveLength(0)
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 3600, list_price_cents: 4000, discount_bp: 1000 })
    expect(await itemsOf(m, b.invoiceId)).toEqual([
      { kind: 'package', name: WASH, price_cents: 3600, list_cents: 4000, discount_bp: 1000, price_basis: 'class' },
    ])
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 3600, adj: 0 })
  })

  it('a line booked at the member price that an inclusion covers at completion goes back to the regular price, then is covered', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [] })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car' })
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 3600, discount_bp: 1000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    await m.complete(b.appointmentId)
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 4000, list_price_cents: 4000, discount_bp: 0 })
    expect((await adjustsOf(m, b.invoiceId)).map((a) => a.amount_cents)).toEqual([-4000])
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, balance: 0 })
  })

  it('never fails a completion: a reprice that would leave a paid invoice overpaid is skipped, the job completes', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH], perCycle: 1 }] })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const a = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car' })
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', start: '2026-06-13T15:00:00-04:00' })
    await m.complete(a.appointmentId)
    const due = await calcOfInvoice(m, b.invoiceId)
    await recordPayment(m, b.invoiceId, due.total, { kind: 'cash', deposit: false })
    await m.complete(b.appointmentId) // throws when the completion fails
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 4000, discount_bp: 0 })
    expect(await redeemsOf(m, b.appointmentId)).toHaveLength(0)
    const status = await m.h.t.db.selectFrom('appointments').select('status').where('id', '=', b.appointmentId).executeTakeFirstOrThrow()
    expect(status.status).toBe('completed')
  })

  it('a household shares the membership: a household member is priced and covered as the member, and spends the same credits', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setCells(m, WAX, { compact_car: 3000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH], perCycle: 2 }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const liam = await m.customer('Liam Chen')
    const add = await m.send(m.superS(), 'POST', `/memberships/${mem.id}/household`, { customerId: liam }, false)
    expect(add.statusCode, add.body).toBe(200)
    expect(add.json()).toMatchObject({ membership: { household: [{ customerId: liam, name: 'Liam Chen' }], planClass: 'compact_car', planClassLabel: 'Compact car' } })
    expect(await m.h.t.db.selectFrom('audit_log').select('action').where('action', '=', 'membership.household.add').execute()).toHaveLength(1)
    // adding again changes nothing
    expect((await m.send(m.superS(), 'POST', `/memberships/${mem.id}/household`, { customerId: liam }, false)).statusCode).toBe(200)

    const b = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv', addons: [WAX] })
    expect(b.body.pricing).toMatchObject({ member: true, totals: { coveredCents: 4000 } })
    // a line no inclusion names gets the member % off ($30 less 10% = $27)
    const wax = await m.h.t.db.selectFrom('appointment_addons').select(['price_cents', 'discount_bp']).where('appointment_id', '=', b.appointmentId).executeTakeFirstOrThrow()
    expect(wax).toEqual({ price_cents: 2700, discount_bp: 1000 })
    await m.complete(b.appointmentId)
    expect(await redeemsOf(m, b.appointmentId)).toEqual([expect.objectContaining({ membership_id: mem.id, covered_cents: 4000, line_cents: 6000 })])
    // the credits are the membership's: the holder sees one left, and so does the household member
    const maria = (await m.get(m.superS(), `/customers/${mem.customerId}/membership`)).json() as { membership: { credits: { left: number } } }
    expect(maria.membership.credits.left).toBe(1)
    const shared = (await m.get(m.superS(), `/customers/${liam}/membership`)).json() as {
      membership: { id: string; credits: { left: number } }
      sharedFrom: { customerId: string; name: string }
    }
    expect(shared).toMatchObject({ membership: { id: mem.id, credits: { left: 1 } }, sharedFrom: { customerId: mem.customerId, name: 'Maria Delgado' } })
    // the board knows the household member as a member
    const card = (await m.get(m.superS(), `/appointments/${b.appointmentId}`)).json() as { membership: { plan: string } | null }
    expect(card.membership?.plan).toBe('Gold')

    // removed: priced as anyone again
    const del = await m.send(m.superS(), 'DELETE', `/memberships/${mem.id}/household/${liam}`, undefined, false)
    expect(del.statusCode, del.body).toBe(200)
    expect(del.json()).toMatchObject({ membership: { household: [] } })
    const c = await bookAt(m, 'Liam Chen', WASH, { vehicleClass: 'large_suv', start: '2026-06-13T15:00:00-04:00' })
    expect(c.body.pricing.member).toBe(false)
    expect((await m.send(m.superS(), 'DELETE', `/memberships/${mem.id}/household/${liam}`, undefined, false)).statusCode).toBe(404)
    expect(await m.h.t.db.selectFrom('audit_log').select('action').where('action', '=', 'membership.household.remove').execute()).toHaveLength(1)
  })

  it('a household refuses the holder, a client with a membership of their own, and callers without cli.member', async () => {
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    await memberAt(m, 'Liam Chen', 'essential', 'compact_car')
    const self = await m.send(m.superS(), 'POST', `/memberships/${mem.id}/household`, { customerId: mem.customerId }, false)
    expect(self.statusCode).toBe(422)
    const own = await m.send(m.superS(), 'POST', `/memberships/${mem.id}/household`, { customerId: await m.customer('Liam Chen') }, false)
    expect(own.statusCode).toBe(409)
    expect((own.json() as { code: string }).code).toBe('MEMBERSHIP_HOUSEHOLD_TAKEN')
    const priya = await m.customer('Priya Nair')
    expect((await m.send(m.noMember(), 'POST', `/memberships/${mem.id}/household`, { customerId: priya }, false)).statusCode).toBe(403)
    expect((await m.send(m.noMember(), 'DELETE', `/memberships/${mem.id}/household/${priya}`, undefined, false)).statusCode).toBe(403)
    // and a household member cannot be given a membership of their own while they share one
    expect((await m.send(m.superS(), 'POST', `/memberships/${mem.id}/household`, { customerId: priya }, false)).statusCode).toBe(200)
    const second = await m.send(m.superS(), 'POST', '/memberships', { customerId: priya, planKey: 'gold' })
    expect(second.statusCode).toBe(409)
    expect((second.json() as { code: string }).code).toBe('MEMBERSHIP_HOUSEHOLD_TAKEN')
  })

  it('a manual membership takes a plan size (the tier’s cheapest priced size by default); a patch changes it', async () => {
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'large_suv')
    const row = await m.h.t.db.selectFrom('memberships').select(['plan_class', 'version']).where('id', '=', mem.id).executeTakeFirstOrThrow()
    expect(row.plan_class).toBe('large_suv')
    const p = await m.send(m.superS(), 'PATCH', `/memberships/${mem.id}`, { planClass: 'compact_suv' }, false)
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json()).toMatchObject({ membership: { planClass: 'compact_suv', planClassLabel: 'Compact SUV', plan: { memberDiscountBp: 0 } } })
    expect((await m.send(m.superS(), 'PATCH', `/memberships/${mem.id}`, { planClass: 'limo' }, false)).statusCode).toBe(422)
    // no size named: the tier's cheapest priced size
    await setTierPrice(m, 'essential', 'large_suv', 100)
    const liam = await m.send(m.superS(), 'POST', '/memberships', { customerId: await m.customer('Liam Chen'), planKey: 'essential' })
    expect(liam.statusCode, liam.body).toBe(201)
    expect(liam.json()).toMatchObject({ membership: { planClass: 'large_suv' } })
    const tierPrice = await m.h.t.db.selectFrom('memberships').select('tier_price_id').where('customer_id', '=', await m.customer('Liam Chen')).executeTakeFirstOrThrow()
    expect(tierPrice.tier_price_id).not.toBeNull()
  })

  it('an emergency closure gives back every redeem of a canceled visit (one restore per redeem)', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setCells(m, WAX, { compact_car: 3000 })
    await setTier(m, 'gold', {
      inclusions: [
        { label: 'Hand wash', services: [WASH], autoApply: false },
        { label: 'Wax every wash', services: [WAX], mode: 'every_visit', autoApply: false },
      ],
    })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', addons: [WAX] })
    expect((await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/membership-perks/apply`, {}, idemKey())).statusCode).toBe(201)
    const closed = await m.send(m.superS(), 'POST', '/emergency/close', { reason: 'Power outage', dur: 'today', credits: true, notify: false }, idemKey())
    expect(closed.statusCode, closed.body).toBe(201)
    expect(await creditEvents(m, mem.id, ['protect'])).toHaveLength(2)
    const cancel = await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/cancel`, { reason: 'Shop closed' }, idemKey())
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect(await creditEvents(m, mem.id, ['restore'])).toHaveLength(2)
    const activity = await m.h.t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', b.appointmentId).execute()
    const restored = activity.map((a) => a.text).find((t) => t.startsWith('Membership credit restored · emergency closure ('))
    expect(restored).toContain('Hand wash')
    expect(restored).toContain('Wax every wash')
    const credits = (await m.get(m.superS(), `/customers/${mem.customerId}/membership`)).json() as { membership: { credits: { left: number } } }
    expect(credits.membership.credits.left).toBe(2)
  })
})
