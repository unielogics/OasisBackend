// Stale-record re-binding (ADR 0160, "W4c fixes" B1): proving control of a NUMBER (a texted code) is not proof of being the OLD
// CLIENT. A party who verified only the number on a record the stale-record rule holds books as a NEW client: the number moves to it,
// the old record keeps its history, loses the phone and is flagged for staff, and nothing of the old client (name, vehicles, visits,
// balance) reaches the page or the assistant. The client's own PIN, or staff, is the proof that keeps the record.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { loadAppointmentRefs, loadTurnContext, resolveIdentity } from '../../src/modules/assistant/context.js'
import { staleRecord } from '../../src/modules/identity/stale.js'
import { DAY, json, PHONES, TODAY, useLinksHarness, type Json } from './harness.js'

const h = useLinksHarness()
const wash = (extra: Json = {}): Json => ({ serviceKey: h.key('Express Hand Wash'), addonKeys: [], date: TODAY, startMin: 13 * 60, ...extra })
const ago = (days: number): Date => new Date(h.clock.now().getTime() - days * DAY)
const CHECKOUT = 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?product=gold'

async function visit(customerId: string, o: { at: Date; createdAt: Date; source: string; status?: string; served?: boolean; arrived?: boolean }): Promise<string> {
  const svc = await h.db.selectFrom('services').select(['id', 'name', 'price_cents', 'duration_min']).where('kind', '=', 'package').executeTakeFirstOrThrow()
  const id = h.newId()
  await h.db
    .insertInto('appointments')
    .values({
      id,
      location_id: h.locationId,
      customer_id: customerId,
      service_id: svc.id,
      package_name: 'Signature Detail',
      price_cents: svc.price_cents,
      duration_min: svc.duration_min,
      scheduled_start: o.at,
      scheduled_end: new Date(o.at.getTime() + 3_600_000),
      status: (o.status ?? 'completed') as never,
      source: o.source as never,
      arrived_at: o.arrived || o.served ? o.at : null,
      completed_at: o.served ? new Date(o.at.getTime() + 3_600_000) : null,
      created_at: o.createdAt,
    })
    .execute()
  return id
}

/** Maria: on file 300 days, a red Tesla, a visit staff booked 250 days ago, and one she booked online for next week long ago. */
async function staleMaria(): Promise<{ id: string; upcoming: string }> {
  const id = await h.customer({ name: 'Maria Delgado', createdAt: ago(300) })
  await h.db.insertInto('vehicles').values({ id: h.newId(), customer_id: id, year: 2021, make: 'Tesla', model: 'Model 3', color: 'Red', plate: null, deleted_at: null }).execute()
  await visit(id, { at: ago(250), createdAt: ago(251), source: 'dashboard', served: true })
  const upcoming = await visit(id, { at: new Date(h.clock.now().getTime() + 7 * DAY), createdAt: ago(200), source: 'online', status: 'booked' })
  expect((await staleRecord(h.db, { locationId: h.locationId, customerId: id, phone: PHONES.maria, now: h.clock.now() })).stale).toBe(true)
  return { id, upcoming }
}

const who = () => resolveIdentity(h.db, { locationId: h.locationId, phone: PHONES.maria, customerId: null, now: h.clock.now() })
const customerRow = (id: string) =>
  h.db.selectFrom('customers').select(['id', 'full_name', 'phone_e164', 'needs_details', 'source', 'phone_reassigned_at', 'phone_reassigned_to']).where('id', '=', id).executeTakeFirstOrThrow()

describe('a code-verified party on a stale record books as a new client (W4c fixes B1)', () => {
  it('on a stranger’s link: a new client takes the number; the old record keeps its history, loses the phone and is flagged', async () => {
    const maria = await staleMaria()
    expect((await who()).fullName).toBeNull()
    const { session } = await h.page({ customerId: null, phone: PHONES.maria })
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ name: 'Somebody Else', smsConsent: true }) })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).member).toBe(false)

    const booked = await h.db.selectFrom('appointments').select(['customer_id', 'booked_with_pin']).where('source', '=', 'link').executeTakeFirstOrThrow()
    expect(booked.customer_id).not.toBe(maria.id)
    expect(booked.booked_with_pin).toBe(false)
    expect(await customerRow(booked.customer_id)).toMatchObject({ full_name: 'Somebody Else', phone_e164: PHONES.maria, source: 'online' })
    const old = await customerRow(maria.id)
    expect(old).toMatchObject({ full_name: 'Maria Delgado', phone_e164: null, phone_reassigned_to: booked.customer_id })
    expect(old.phone_reassigned_at).toEqual(h.clock.now())
    // her history stays hers
    expect((await h.db.selectFrom('appointments').select('id').where('customer_id', '=', maria.id).execute()).length).toBe(2)
    expect((await h.db.selectFrom('vehicles').select('id').where('customer_id', '=', maria.id).execute()).length).toBe(1)
    // staff are told, and it is audited
    const notes = await h.db.selectFrom('notifications').select(['kind', 'entity_id', 'title']).where('kind', '=', 'identity.number_reassigned').execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]).toMatchObject({ entity_id: maria.id, title: 'Number reassigned: Maria Delgado' })
    expect(await h.db.selectFrom('audit_log').select('entity_id').where('action', '=', 'customer.phone_reassigned').execute()).toEqual([{ entity_id: maria.id }])
    // the stranger's page goes on for the new client
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(200)
    // the staff view of the old record shows the flag
    const view = await h.t.app.inject({ method: 'GET', url: `/api/v1/customers/${maria.id}/identity` })
    expect(json(view).numberReassigned).toEqual({ at: h.clock.now().toISOString(), toCustomerId: booked.customer_id })
  })

  it('the assistant then knows the new client only: never the old name, vehicles, visits or balance (B1 c)', async () => {
    const maria = await staleMaria()
    const { session } = await h.page({ customerId: null, phone: PHONES.maria })
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    expect((await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ name: 'Somebody Else' }) })).statusCode).toBe(201)

    const resolved = await who()
    expect(resolved.fullName).toBe('Somebody Else')
    expect(resolved.identity.customerId).not.toBe(maria.id)
    const now = h.clock.now()
    const refs = await loadAppointmentRefs(h.db, { locationId: h.locationId, customerId: resolved.identity.customerId, now })
    expect(refs.map((x) => x.appointmentId)).not.toContain(maria.upcoming)
    expect(refs).toHaveLength(1)
    const ctx = await loadTurnContext(h.db, { resolved, conversationId: h.newId(), refs, actionsEnabled: true, firstContact: false, now, tz: 'America/New_York' })
    expect(ctx).toMatchObject({ firstName: 'Somebody', membership: null, vehicles: [], vehicleNames: [] })
    const text = JSON.stringify(ctx)
    for (const leak of ['Maria', 'Delgado', 'Tesla', 'Model 3', 'Signature Detail']) expect(text, leak).not.toContain(leak)
  })

  it('on the old client’s own calendar link: the page never shows her, her visits or her PIN window, and books a new client', async () => {
    const maria = await staleMaria()
    const { session, body } = await h.page({ customerId: maria.id })
    expect(body.client.firstName).toBe('')
    const v = await h.verifyByCode(session)
    expect(v.statusCode, v.body).toBe(200)
    // a texted code proves the number, not Maria
    expect(json(v)).toMatchObject({ client: { firstName: '', tier: null }, appointments: null })
    expect(json(v).stepUp.canSetPinUntil).toBeNull()
    // her visit cannot be moved by its reference
    const ref = `OAS-${String((await h.db.selectFrom('appointments').select('seq').where('id', '=', maria.upcoming).executeTakeFirstOrThrow()).seq).padStart(5, '0')}`
    const move = await h.call('POST', `appointments/${ref}/reschedule`, { session, body: { date: TODAY, startMin: 14 * 60 } })
    expect(json(move)).toMatchObject({ status: 404, code: 'LINK_APPOINTMENT_NOT_FOUND' })
    // no PIN from a code on her record
    const pin = await h.call('POST', 'verify/code', { session, body: { purpose: 'pin_set' } })
    expect(json(pin)).toMatchObject({ status: 409, code: 'IDENTITY_RECORD_UNCONFIRMED' })
    expect((await h.call('POST', 'pin', { session, body: { pin: '4826' } })).statusCode).toBe(409)
    // the booking makes a new client (a placeholder name: the page asked none), never one of her privileges
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash() })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).member).toBe(false)
    const booked = await h.db.selectFrom('appointments').select('customer_id').where('source', '=', 'link').executeTakeFirstOrThrow()
    expect(booked.customer_id).not.toBe(maria.id)
    expect(await customerRow(booked.customer_id)).toMatchObject({ phone_e164: PHONES.maria, needs_details: true })
    expect((await customerRow(maria.id)).phone_e164).toBeNull()
    // her link died with her number
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(401)
  })

  it('a membership page of a stale record proven only by a code starts nothing', async () => {
    const id = await h.customer({ createdAt: ago(300) })
    await sql`update membership_plans set checkout_url = ${CHECKOUT} where key = 'premium'`.execute(h.db)
    const { session } = await h.page({ customerId: id, kind: 'membership', planKey: 'premium' })
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    const r = await h.call('POST', 'membership/start', { session, body: { email: 'someone@example.test' } })
    expect(json(r)).toMatchObject({ status: 409, code: 'IDENTITY_RECORD_UNCONFIRMED' })
    expect(await h.db.selectFrom('membership_checkouts').select('id').execute()).toEqual([])
  })
})

describe('what ends the stale-record rule: proof of the client (B1 a)', () => {
  it('her PIN on a stranger’s link books for her and keeps her record (booked_with_pin), with no reassignment', async () => {
    const id = await h.customer({ name: 'Maria Delgado' })
    const own = await h.page({ customerId: id })
    expect((await h.verifyByCode(own.session)).statusCode).toBe(200)
    expect((await h.call('POST', 'pin', { session: own.session, body: { pin: '4826' } })).statusCode).toBe(200)
    await sql`delete from phone_trust`.execute(h.db)
    h.advance(203 * DAY) // Saturday 2027-01-02, 10:36: quiet for 203 days
    const verdict = () => staleRecord(h.db, { locationId: h.locationId, customerId: id, phone: PHONES.maria, now: h.clock.now() })
    expect((await verdict()).stale).toBe(true)
    const { session } = await h.page({ customerId: null, phone: PHONES.maria })
    expect((await h.call('POST', 'verify/pin', { session, body: { pin: '4826' } })).statusCode).toBe(200)
    expect((await verdict()).stale).toBe(false)
    const r = await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ name: 'Maria', date: '2027-01-02' }) })
    expect(r.statusCode, r.body).toBe(201)
    expect(await h.db.selectFrom('appointments').select(['customer_id', 'booked_with_pin']).execute()).toEqual([{ customer_id: id, booked_with_pin: true }])
    expect((await customerRow(id)).phone_e164).toBe(PHONES.maria)
    expect(await h.db.selectFrom('notifications').select('id').where('kind', '=', 'identity.number_reassigned').execute()).toEqual([])
  })

  it('staff confirming the number (POST /customers/:id/identity/confirm) ends it; a code-verified booking then is hers', async () => {
    const maria = await staleMaria()
    const c = await h.t.app.inject({ method: 'POST', url: `/api/v1/customers/${maria.id}/identity/confirm`, payload: {} })
    expect(c.statusCode, c.body).toBe(200)
    expect(json(c).stale).toMatchObject({ stale: false })
    expect(await h.db.selectFrom('audit_log').select('entity_id').where('action', '=', 'identity.client.confirmed').execute()).toEqual([{ entity_id: maria.id }])
    expect((await who()).fullName).toBe('Maria Delgado')
    const { session } = await h.page({ customerId: null, phone: PHONES.maria })
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    expect((await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash({ name: 'Maria' }) })).statusCode).toBe(201)
    expect((await h.db.selectFrom('appointments').select('customer_id').where('source', '=', 'link').executeTakeFirstOrThrow()).customer_id).toBe(maria.id)
  })

  it('counts a visit staff booked or served, a PIN booking and a staff confirmation; never a link, website or code booking by itself', async () => {
    const verdictOf = async (id: string) => (await staleRecord(h.db, { locationId: h.locationId, customerId: id, phone: PHONES.maria, now: h.clock.now() })).stale
    const fresh = async (setup: (id: string) => Promise<unknown>) => {
      await sql`delete from appointments`.execute(h.db)
      await sql`delete from customers where synthetic = false`.execute(h.db)
      const id = await h.customer({ createdAt: ago(300) })
      await setup(id)
      return verdictOf(id)
    }
    const recent = { at: ago(10), createdAt: ago(11) }
    expect(await fresh(async () => undefined)).toBe(true)
    expect(await fresh((id) => visit(id, { ...recent, source: 'dashboard' }))).toBe(false)
    expect(await fresh((id) => visit(id, { ...recent, source: 'phone', status: 'booked' }))).toBe(false)
    expect(await fresh((id) => visit(id, { ...recent, source: 'link', status: 'booked' }))).toBe(true)
    expect(await fresh((id) => visit(id, { ...recent, source: 'sms_ai', status: 'booked' }))).toBe(true)
    expect(await fresh((id) => visit(id, { ...recent, source: 'online', served: true }))).toBe(true)
    // an arrival alone can come from the client's phone (the arrival link): not proof
    expect(await fresh((id) => visit(id, { ...recent, source: 'link', status: 'arrived', arrived: true }))).toBe(true)
    // a visit the crew served is a staff action, whoever booked it (the website's excepted: anyone can type a number)
    expect(await fresh((id) => visit(id, { ...recent, source: 'link', served: true }))).toBe(false)
    expect(
      await fresh(async (id) => {
        const v = await visit(id, { ...recent, source: 'link', status: 'booked' })
        await h.db.updateTable('appointments').set({ booked_with_pin: true }).where('id', '=', v).execute()
      }),
    ).toBe(false)
    expect(await fresh((id) => h.db.updateTable('customers').set({ identity_confirmed_at: ago(5) }).where('id', '=', id).execute())).toBe(false)
  })

  it('a code verification and a link booking are not activity: 180 days later the record is stale again', async () => {
    const id = await h.customer({ name: 'Maria Delgado' })
    const { session } = await h.page({ customerId: id })
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    expect((await h.call('POST', 'bookings', { session, key: h.nextKey(), body: wash() })).statusCode).toBe(201)
    h.advance(181 * DAY)
    const v = await staleRecord(h.db, { locationId: h.locationId, customerId: id, phone: PHONES.maria, now: h.clock.now() })
    expect(v).toMatchObject({ stale: true, reason: 'inactive' })
  })
})
