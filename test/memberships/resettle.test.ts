// A visit changed after it was settled is settled again (ADR 0170, wave Q2a review F1, F2, F4, F3): the coverage follows the visit.
//  * F1: the size confirmed after the visit was covered: a Large SUV plan's member whose visit was booked with no size is covered
//    up to the Large SUV price (nothing due); a smaller size gives the excess back; a compact plan leaves the size difference due.
//  * F2: an included add-on added after the visit was settled is covered; a covered add-on removed gives its coverage and credit back.
//  * F4: one inclusion naming two add-ons covers both lines (one redeem per covered line).
//  * F3: a household member cannot open a membership of their own through a personal link's checkout.
//  * N1: a change that would leave a paid visit overpaid is refused (409) and changes nothing: the settlement never turns it into a
//    store-credit refund on its own.
// Each change writes a reversing adjust + a `restore` for the redeem it replaces, then the new redeem + adjust; the invoice shows
// only the coverage in force, the credit counts stay right, and the ledger integrity check stays clean.
import { describe, expect, it } from 'vitest'
import { openCheckoutIntent } from '../../src/modules/memberships/checkouts.js'
import { checkLedgerIntegrity } from '../../src/modules/payments/jobs-integrity.js'
import { transaction } from '../../src/platform/db.js'
import { idemKey } from '../scheduling-gaps/support.js'
import { useMemRig } from './harness.js'
import { apptRow, bookAt, calcOfInvoice, itemsOf, memberAt, serviceIdOf, setCells, setTier } from './sizes-rig.js'

const WASH = 'Express Hand Wash'
const WAX = 'Wax'
const CLAY = 'Clay bar'
const ODOR = 'Odor removal'

type Rig = ReturnType<typeof useMemRig>

const adjustsOf = (m: Rig, invoiceId: string) =>
  m.h.t.db
    .selectFrom('ledger_events')
    .select(['id', 'amount_cents', 'reason', 'note'])
    .where('invoice_id', '=', invoiceId)
    .where('type', '=', 'adjust')
    .orderBy('seq')
    .execute()

const eventsOf = (m: Rig, appointmentId: string, kind: 'redeem' | 'restore') =>
  m.h.t.db
    .selectFrom('membership_credit_events')
    .select(['id', 'inclusion_id', 'service_id', 'line_cents', 'covered_cents', 'visit_class', 'ledger_event_id', 'idempotency_key', 'cycle_start'])
    .where('appointment_id', '=', appointmentId)
    .where('kind', '=', kind)
    .orderBy('created_at')
    .orderBy('id')
    .execute()

const setSize = async (m: Rig, appointmentId: string, vehicleClass: string) => {
  const row = await apptRow(m, appointmentId)
  return m.send(m.superS(), 'PUT', `/appointments/${appointmentId}/vehicle-class`, { vehicleClass, version: row.version }, false)
}

const applyAgain = (m: Rig, appointmentId: string) =>
  m.send(m.superS(), 'POST', `/appointments/${appointmentId}/membership-perks/apply`, {}, idemKey())

const creditsLeft = async (m: Rig, customerId: string): Promise<number> =>
  ((await m.get(m.superS(), `/customers/${customerId}/membership`)).json() as { membership: { credits: { left: number } } }).membership.credits.left

const activityOf = async (m: Rig, appointmentId: string): Promise<string[]> =>
  (await m.h.t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', appointmentId).execute()).map((a) => a.text)

/** Everything a refused change must leave as it was: the ledger, the invoice lines, the visit, its add-ons and its credit events. */
const stateOf = async (m: Rig, appointmentId: string, invoiceId: string) => ({
  ledger: await m.h.t.db
    .selectFrom('ledger_events')
    .select(['id', 'type', 'amount_cents', 'status', 'dest', 'reason'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('seq')
    .execute(),
  items: await itemsOf(m, invoiceId),
  calc: await calcOfInvoice(m, invoiceId),
  appointment: await apptRow(m, appointmentId),
  addons: await m.h.t.db
    .selectFrom('appointment_addons')
    .select(['id', 'price_cents', 'discount_bp', 'removed_at'])
    .where('appointment_id', '=', appointmentId)
    .orderBy('id')
    .execute(),
  credits: await m.h.t.db
    .selectFrom('membership_credit_events')
    .select(['id', 'kind', 'idempotency_key'])
    .where('appointment_id', '=', appointmentId)
    .orderBy('id')
    .execute(),
})

describe('a settled visit that changes is settled again', () => {
  const m = useMemRig()

  it('F1: the size confirmed after completion is covered up to the plan size (Large SUV plan, booked with no size): nothing due', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    const [wash] = await setTier(m, 'gold', { inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'large_suv')
    const b = await bookAt(m, 'Maria Delgado', WASH)
    expect(await apptRow(m, b.appointmentId)).toMatchObject({ price_cents: 4000, price_basis: 'unknown_class' })
    await m.complete(b.appointmentId)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, balance: 0 })
    expect(await creditsLeft(m, mem.customerId)).toBe(1)

    const r = await setSize(m, b.appointmentId, 'large_suv')
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { invoice: { balanceCents: number } }).invoice.balanceCents).toBe(0)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, adj: -6000, tax: 0, balance: 0 })
    // the completion's $40, given back, then the Large SUV price covered
    const adj = await adjustsOf(m, b.invoiceId)
    expect(adj.map((a) => a.amount_cents)).toEqual([-4000, 4000, -6000])
    expect(adj.map((a) => a.reason)).toEqual(['Membership credit', 'Membership credit', 'Membership credit'])
    expect(adj[1]!.note).toBe(`${WASH} · Gold · coverage of $40 given back (the visit changed)`)
    expect(adj[2]!.note).toBe(`${WASH} · Gold (Large SUV plan) · covers $60 of $60`)
    const redeems = await eventsOf(m, b.appointmentId, 'redeem')
    expect(redeems).toEqual([
      expect.objectContaining({ inclusion_id: wash, covered_cents: 4000, line_cents: 4000, visit_class: null, idempotency_key: `redeem:${b.appointmentId}:${wash}` }),
      expect.objectContaining({
        inclusion_id: wash,
        covered_cents: 6000,
        line_cents: 6000,
        visit_class: 'large_suv',
        ledger_event_id: adj[2]!.id,
        idempotency_key: `redeem:${b.appointmentId}:${wash}:2`,
      }),
    ])
    const restores = await eventsOf(m, b.appointmentId, 'restore')
    expect(restores).toEqual([
      expect.objectContaining({ idempotency_key: `restore:${redeems[0]!.id}`, ledger_event_id: adj[1]!.id, cycle_start: redeems[0]!.cycle_start }),
    ])
    // still one credit spent on the visit
    expect(await creditsLeft(m, mem.customerId)).toBe(1)
    // the invoice shows the coverage in force only
    const detail = (await m.get(m.superS(), `/invoices/${b.invoiceId}`)).json() as { adjustments: { amountCents: number; coverage: unknown }[] }
    expect(detail.adjustments.map((a) => [a.amountCents, a.coverage])).toEqual([
      [-4000, null],
      [4000, null],
      [-6000, { serviceName: WASH, coveredCents: 6000, lineCents: 6000, differenceCents: 0, planClassLabel: 'Large SUV' }],
    ])
    const file = (await m.get(m.superS(), `/appointments/${b.appointmentId}`)).json() as { invoice: { coverage: unknown[] } }
    expect(file.invoice.coverage).toEqual([{ serviceName: WASH, coveredCents: 6000, lineCents: 6000, differenceCents: 0, planClassLabel: 'Large SUV' }])
    expect(await activityOf(m, b.appointmentId)).toContain('Membership coverage updated · $40 → $60')
    // nothing new to cover: the explicit apply says so and writes nothing
    const again = await applyAgain(m, b.appointmentId)
    expect(again.statusCode).toBe(409)
    expect((again.json() as { code: string }).code).toBe('MEMBERSHIP_CREDIT_APPLIED')
    expect(await adjustsOf(m, b.invoiceId)).toHaveLength(3)
    // confirming the same size again changes no coverage
    expect((await setSize(m, b.appointmentId, 'large_suv')).statusCode).toBe(200)
    expect(await adjustsOf(m, b.invoiceId)).toHaveLength(3)
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('F1: a smaller size confirmed after completion gives the excess back (covered $60, then $40 at Compact car)', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setTier(m, 'gold', { inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    await memberAt(m, 'Maria Delgado', 'gold', 'large_suv')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'large_suv' })
    await m.complete(b.appointmentId)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ adj: -6000, balance: 0 })
    const r = await setSize(m, b.appointmentId, 'compact_car')
    expect(r.statusCode, r.body).toBe(200)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, adj: -4000, balance: 0 })
    expect((await adjustsOf(m, b.invoiceId)).map((a) => a.amount_cents)).toEqual([-6000, 6000, -4000])
    expect(await activityOf(m, b.appointmentId)).toContain('Membership coverage updated · $60 → $40')
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('F1: a Compact car plan stays capped at its size: a Large SUV confirmed after completion leaves the $20 difference due', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setTier(m, 'gold', { discountBp: 1000, inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH)
    await m.complete(b.appointmentId)
    const r = await setSize(m, b.appointmentId, 'large_suv')
    expect(r.statusCode, r.body).toBe(200)
    // no % off on the difference
    const calc = await calcOfInvoice(m, b.invoiceId)
    expect(calc).toMatchObject({ sub: 2000, adj: -4000 })
    expect(calc.balance).toBe(2000 + calc.tax)
    const file = (await m.get(m.superS(), `/appointments/${b.appointmentId}`)).json() as { invoice: { coverage: unknown[] } }
    expect(file.invoice.coverage).toEqual([{ serviceName: WASH, coveredCents: 4000, lineCents: 6000, differenceCents: 2000, planClassLabel: 'Compact car' }])
  })

  it('F2: an included add-on added after completion is covered (regular price, then covered); another add-on gets the member price', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setCells(m, WAX, { compact_car: 3000 })
    await setCells(m, CLAY, { compact_car: 5000 })
    const [, wax] = await setTier(m, 'gold', {
      discountBp: 1000,
      inclusions: [
        { label: 'Hand wash', services: [WASH] },
        { label: 'Wax every wash', services: [WAX], mode: 'every_visit' },
      ],
    })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car' })
    await m.complete(b.appointmentId)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, balance: 0 })

    const add = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/addons/${await serviceIdOf(m, WAX)}`, {}, false)
    expect(add.statusCode, add.body).toBe(200)
    expect((add.json() as { addon: { priceCents: number } }).addon.priceCents).toBe(3000)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, adj: -7000, balance: 0 })
    expect(await eventsOf(m, b.appointmentId, 'redeem')).toEqual([
      expect.anything(),
      expect.objectContaining({ inclusion_id: wax, covered_cents: 3000, line_cents: 3000, idempotency_key: `redeem:${b.appointmentId}:${wax}` }),
    ])
    expect(await activityOf(m, b.appointmentId)).toContain('Membership coverage updated · $40 → $70')

    const clay = await m.send(m.superS(), 'PUT', `/appointments/${b.appointmentId}/addons/${await serviceIdOf(m, CLAY)}`, {}, false)
    expect(clay.statusCode, clay.body).toBe(200)
    expect((clay.json() as { addon: { priceCents: number } }).addon.priceCents).toBe(4500)
    const calc = await calcOfInvoice(m, b.invoiceId)
    expect(calc).toMatchObject({ sub: 4500, adj: -7000 })
    expect(await eventsOf(m, b.appointmentId, 'redeem')).toHaveLength(2)
    const again = await applyAgain(m, b.appointmentId)
    expect((again.json() as { code: string }).code).toBe('MEMBERSHIP_CREDIT_APPLIED')
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('F2: a covered add-on removed after completion gives its coverage and its credit back', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setCells(m, WAX, { compact_car: 3000 })
    await setCells(m, CLAY, { compact_car: 5000 })
    const [, wax] = await setTier(m, 'gold', {
      inclusions: [
        { label: 'Hand wash', services: [WASH], perCycle: 2 },
        { label: 'Wax', services: [WAX], perCycle: 2 },
      ],
    })
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', addons: [WAX, CLAY] })
    await m.complete(b.appointmentId)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 5000, adj: -7000 })
    expect(await creditsLeft(m, mem.customerId)).toBe(2)

    const del = await m.send(m.superS(), 'DELETE', `/appointments/${b.appointmentId}/addons/${await serviceIdOf(m, WAX)}`, undefined, false)
    expect(del.statusCode, del.body).toBe(200)
    // the wax's $30 coverage reversed; the clay bar is not paid for by it
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 5000, adj: -4000 })
    expect((await adjustsOf(m, b.invoiceId)).map((a) => a.amount_cents)).toEqual([-4000, -3000, 3000])
    const [, waxRedeem] = await eventsOf(m, b.appointmentId, 'redeem')
    expect(waxRedeem).toMatchObject({ inclusion_id: wax })
    expect(await eventsOf(m, b.appointmentId, 'restore')).toEqual([expect.objectContaining({ idempotency_key: `restore:${waxRedeem!.id}` })])
    expect(await creditsLeft(m, mem.customerId)).toBe(3)
    const file = (await m.get(m.superS(), `/appointments/${b.appointmentId}`)).json() as { invoice: { coverage: { serviceName: string }[] } }
    expect(file.invoice.coverage.map((c) => c.serviceName)).toEqual([WASH])
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('N1: a paid member visit whose size goes down is refused (409 PRICE_CHANGE_OVERPAID) and nothing changes', async () => {
    await setCells(m, WASH, { compact_car: 4000, large_suv: 6000 })
    await setTier(m, 'gold', { inclusions: [{ label: 'Hand wash', services: [WASH] }] })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH)
    await m.complete(b.appointmentId)
    expect((await setSize(m, b.appointmentId, 'large_suv')).statusCode).toBe(200)
    const due = await calcOfInvoice(m, b.invoiceId)
    expect(due).toMatchObject({ sub: 2000, adj: -4000 })
    const pay = await m.send(m.superS(), 'POST', `/invoices/${b.invoiceId}/payments`, { method: 'cash' })
    expect(pay.statusCode, pay.body).toBe(201)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ paid: due.balance, balance: 0 })
    const before = await stateOf(m, b.appointmentId, b.invoiceId)

    const r = await setSize(m, b.appointmentId, 'compact_car')
    expect(r.statusCode, r.body).toBe(409)
    expect((r.json() as { code: string }).code).toBe('PRICE_CHANGE_OVERPAID')
    // no reversal, no new coverage, no store-credit refund: the ledger, the invoice, the appointment and the credits as they were
    expect(await stateOf(m, b.appointmentId, b.invoiceId)).toEqual(before)
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('N1: removing a covered add-on from a paid member visit when another paid line would be covered instead is refused (409 ADDON_REMOVE_OVERPAID)', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setCells(m, WAX, { compact_car: 3000 })
    await setCells(m, CLAY, { compact_car: 5000 })
    await setTier(m, 'gold', {
      inclusions: [
        { label: 'Hand wash', services: [WASH] },
        { label: 'One extra', services: [WAX, CLAY], perCycle: 1 },
      ],
    })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', addons: [WAX, CLAY] })
    await m.complete(b.appointmentId)
    // the wash and one of the two extras covered; the other extra is due and paid
    const redeems = await eventsOf(m, b.appointmentId, 'redeem')
    expect(redeems).toHaveLength(2)
    const coveredExtra = redeems[1]!.service_id === (await serviceIdOf(m, WAX)) ? WAX : CLAY
    const pay = await m.send(m.superS(), 'POST', `/invoices/${b.invoiceId}/payments`, { method: 'cash' })
    expect(pay.statusCode, pay.body).toBe(201)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ balance: 0 })
    const before = await stateOf(m, b.appointmentId, b.invoiceId)

    const del = await m.send(m.superS(), 'DELETE', `/appointments/${b.appointmentId}/addons/${await serviceIdOf(m, coveredExtra)}`, undefined, false)
    expect(del.statusCode, del.body).toBe(409)
    expect((del.json() as { code: string }).code).toBe('ADDON_REMOVE_OVERPAID')
    expect(await stateOf(m, b.appointmentId, b.invoiceId)).toEqual(before)
    expect((await checkLedgerIntegrity(m.h.t.db, m.locationId())).findings).toEqual([])
  })

  it('F4: an every-visit inclusion naming two add-ons covers both lines (one redeem each)', async () => {
    await setCells(m, WASH, { compact_car: 4000 })
    await setCells(m, WAX, { compact_car: 3000 })
    await setCells(m, ODOR, { compact_car: 2000 })
    const [wash, extras] = await setTier(m, 'gold', {
      inclusions: [
        { label: 'Hand wash', services: [WASH] },
        { label: 'Wax and odor removal every wash', services: [WAX, ODOR], mode: 'every_visit' },
      ],
    })
    await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const b = await bookAt(m, 'Maria Delgado', WASH, { vehicleClass: 'compact_car', addons: [WAX, ODOR] })
    expect(b.body.pricing).toMatchObject({ totals: { listCents: 9000, coveredCents: 9000, dueCents: 0 } })
    await m.complete(b.appointmentId)
    expect(await calcOfInvoice(m, b.invoiceId)).toMatchObject({ sub: 0, adj: -9000, balance: 0 })
    expect((await eventsOf(m, b.appointmentId, 'redeem')).map((e) => [e.inclusion_id, e.covered_cents, e.idempotency_key])).toEqual([
      [wash, 4000, `redeem:${b.appointmentId}:${wash}`],
      [extras, 3000, `redeem:${b.appointmentId}:${extras}`],
      [extras, 2000, `redeem:${b.appointmentId}:${extras}:2`],
    ])
  })

  it('F3: a household member cannot start a membership of their own through a link checkout (MEMBERSHIP_HOUSEHOLD_TAKEN)', async () => {
    const mem = await memberAt(m, 'Maria Delgado', 'gold', 'compact_car')
    const priya = await m.customer('Priya Nair')
    expect((await m.send(m.superS(), 'POST', `/memberships/${mem.id}/household`, { customerId: priya }, false)).statusCode).toBe(200)
    await m.h.t.db.updateTable('membership_plans').set({ checkout_url: 'https://oasis.squarespace.com/gold' }).where('key', '=', 'gold').execute()
    const open = transaction(m.h.t.db, (tx) =>
      openCheckoutIntent(
        tx,
        { locationId: m.locationId(), clock: m.h.clock, newId: m.h.t.app.newId },
        { customerId: priya, planKey: 'gold', email: 'priya@example.test', linkId: null },
        { actor: { name: 'Website (personal link)' } },
      ),
    )
    await expect(open).rejects.toMatchObject({ code: 'MEMBERSHIP_HOUSEHOLD_TAKEN' })
    expect(await m.h.t.db.selectFrom('memberships').select('id').where('customer_id', '=', priya).execute()).toEqual([])
    // removed from the household: they may
    expect((await m.send(m.superS(), 'DELETE', `/memberships/${mem.id}/household/${priya}`, undefined, false)).statusCode).toBe(200)
    const ok = await transaction(m.h.t.db, (tx) =>
      openCheckoutIntent(
        tx,
        { locationId: m.locationId(), clock: m.h.clock, newId: m.h.t.app.newId },
        { customerId: priya, planKey: 'gold', email: 'priya@example.test', linkId: null },
        { actor: { name: 'Website (personal link)' } },
      ),
    )
    expect(ok.membershipCreated).toBe(true)
  })
})
