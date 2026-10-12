// Booking and rescheduling on a personal link page (ADR 0160, design section 5, plan B): only a verified page (a PIN or code here,
// or the number's live trust), through the dashboard's createAppointment with channel online and source link, categories set, the
// website's confirmation text, the client's own privileges only; the open-times board is never cached and VIP-aware only when
// verified.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createManualMembership } from '../../src/modules/memberships/service.js'
import { DAY, HOUR, json, PHONES, TODAY, useLinksHarness, type Json } from './harness.js'

const h = useLinksHarness()

const book = (session: string, body: Json, key = h.nextKey(), ip?: string) => h.call('POST', 'bookings', { session, key, body, ip })
const wash = (extra: Json = {}): Json => ({ serviceKey: h.key('Express Hand Wash'), addonKeys: [], date: TODAY, startMin: 13 * 60, ...extra })
const appointments = () =>
  h.db.selectFrom('appointments').select(['id', 'seq', 'status', 'source', 'customer_id', 'scheduled_start', 'categories']).orderBy('seq').execute()

async function trustedPage(o: { name?: string; phone?: string; kind?: 'calendar' | 'book_again' } = {}) {
  const id = await h.customer({ name: o.name, phone: o.phone })
  await h.trust(id, o.phone)
  const p = await h.page({ customerId: id, kind: o.kind ?? 'calendar' })
  return { id, ...p }
}

describe('POST bookings', () => {
  it('needs a verified page: 403 IDENTITY_STEP_UP_REQUIRED and nothing booked', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id })
    const r = await book(session, wash())
    expect(r.statusCode).toBe(403)
    expect(json(r)).toMatchObject({ code: 'IDENTITY_STEP_UP_REQUIRED', meta: { need: 'verified' } })
    expect(await appointments()).toEqual([])
    expect((await h.call('POST', 'bookings', { session, key: null, body: wash() })).statusCode).toBe(400)
  })

  it('a trusted number books at once: source link, online rules, categories, invoice, the confirmation text, one use of the link', async () => {
    const { id, session, link } = await trustedPage()
    const key = h.nextKey()
    const ip = h.nextIp()
    const r = await book(session, wash(), key, ip)
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({
      status: 'booked',
      deposit: { dueCents: 2500, how: 'counter' },
      member: false,
      confirmationBy: 'sms',
      service: { key: h.key('Express Hand Wash') },
      when: 'Today · 1:00 PM',
    })
    const [a] = await appointments()
    expect(a).toMatchObject({ source: 'link', customer_id: id, status: 'booked' })
    expect(a!.categories.length).toBeGreaterThan(0)
    expect(json(r).bookingRef).toBe(`OAS-${String(a!.seq).padStart(5, '0')}`)
    expect(await h.db.selectFrom('invoices').select('id').where('appointment_id', '=', a!.id).execute()).toHaveLength(1)
    const texts = await h.texts(PHONES.maria)
    expect(texts.map((t) => t.body).join('\n')).toMatch(/Express Hand Wash, today at 1:00 PM\. \$25 booking fee due at the shop/)
    const activity = await h.db.selectFrom('activity_log').select('text').where('appointment_id', '=', a!.id).execute()
    expect(activity.map((x) => x.text)).toContain('Booked on a personal link · $25 booking fee due at the counter')
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', link.id).executeTakeFirstOrThrow()).uses).toBe(1)
    // the same key and body from the same address: the stored answer, nothing booked twice
    const again = await book(session, wash(), key, ip)
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(await appointments()).toHaveLength(1)
    // the page lists the visit
    const me = json(await h.call('GET', 'me', { session }))
    expect(me.appointments).toEqual([
      expect.objectContaining({ ref: json(r).bookingRef, service: 'Express Hand Wash', status: 'booked', canReschedule: true, when: 'Sat, Jun 13 · 1:00 PM' }),
    ])
  })

  it('an Idempotency-Key belongs to the page: another page behind the same address with the same key and body books its own visit (W4c)', async () => {
    const maria = await trustedPage()
    const liam = await trustedPage({ name: 'Liam Chen', phone: PHONES.liam })
    const key = h.nextKey()
    const ip = h.nextIp()
    const r1 = await book(maria.session, wash(), key, ip)
    expect(r1.statusCode, r1.body).toBe(201)
    // the same key and the very same body from the same address, on Liam's page: Liam's own booking, never Maria's stored answer
    const r2 = await book(liam.session, wash(), key, ip)
    expect(r2.statusCode, r2.body).toBe(201)
    expect(r2.headers['idempotent-replayed']).toBeUndefined()
    expect(json(r2).bookingRef).not.toBe(json(r1).bookingRef)
    expect((await appointments()).map((a) => a.customer_id).sort()).toEqual([maria.id, liam.id].sort())
    // each page still replays its own answer
    const replay = await book(liam.session, wash(), key, ip)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(json(replay).bookingRef).toBe(json(r2).bookingRef)
    expect(await appointments()).toHaveLength(2)
  })

  it('an Idempotency-Key belongs to the link: a retry from a re-opened page of the same link replays its booking (W4c fixes B2)', async () => {
    const id = await h.customer()
    await h.trust(id)
    const link = await h.link({ customerId: id, kind: 'calendar' })
    const a = await h.open(link.token)
    const key = h.nextKey()
    const ip = h.nextIp()
    const r1 = await book(a.session, wash(), key, ip)
    expect(r1.statusCode, r1.body).toBe(201)
    // the page reloads (or its session idled out), opens the link again and the site retries the same request
    const b = await h.open(link.token)
    expect(b.res.statusCode).toBe(200)
    const r2 = await book(b.session, wash(), key, ip)
    expect({ status: r2.statusCode, replayed: r2.headers['idempotent-replayed'] ?? null, ref: json(r2).bookingRef }).toEqual({
      status: 201,
      replayed: 'true',
      ref: json(r1).bookingRef,
    })
    expect(await appointments()).toHaveLength(1)
    // a dead page claims no key: 401 before anything is stored
    const dead = await book('x'.repeat(43), wash(), h.nextKey(), ip)
    expect(dead.statusCode).toBe(401)
    expect(await h.db.selectFrom('idempotency_keys').select('key').execute()).toHaveLength(1)
  })

  it('two different links of one client behind one address never share a key', async () => {
    const id = await h.customer()
    await h.trust(id)
    const a = await h.page({ customerId: id, kind: 'calendar' })
    const b = await h.page({ customerId: id, kind: 'book_again' })
    const key = h.nextKey()
    const ip = h.nextIp()
    expect((await book(a.session, wash(), key, ip)).statusCode).toBe(201)
    const r2 = await book(b.session, wash({ startMin: 14 * 60 }), key, ip)
    expect(r2.statusCode, r2.body).toBe(201)
    expect(r2.headers['idempotent-replayed']).toBeUndefined()
    expect(await appointments()).toHaveLength(2)
  })

  it('a calendar link books three visits at most, a book-again link one', async () => {
    const { session } = await trustedPage()
    for (const startMin of [13 * 60, 14 * 60, 15 * 60]) expect((await book(session, wash({ startMin }))).statusCode).toBe(201)
    const fourth = await book(session, wash({ startMin: 16 * 60 }))
    expect(fourth.statusCode).toBe(409)
    expect(json(fourth).code).toBe('IDENTITY_LINK_USED')
    h.advance(HOUR) // a new hour of the per-number booking limit (5 an hour)
    const again = await h.page({ customerId: (await appointments())[0]!.customer_id, kind: 'book_again' })
    expect((await book(again.session, wash({ date: '2026-06-16' }))).statusCode).toBe(201)
    expect((await book(again.session, wash({ date: '2026-06-17' }))).statusCode).toBe(409)
    expect(await appointments()).toHaveLength(4)
  })

  it('member privileges follow the page’s own client: an active member pays no fee, never during a PIN reset hold', async () => {
    const { id, session } = await trustedPage()
    await h.db.transaction().execute((tx) =>
      createManualMembership(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, { customerId: id, planKey: 'premium', planLabel: 'Gold' }, { userId: 'test', name: 'Test', audit: {} }),
    )
    const r = await book(session, wash())
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({ member: true, deposit: { dueCents: 0 } })
    expect(json(await h.call('GET', 'me', { session })).client.tier).toBe('gold')
    await sql`insert into customer_pins (customer_id, pin_hash, version, set_at, reset_hold_until)
      values (${id}, '$scrypt$not-a-real-hash-for-the-test', 1, ${h.clock.now()}, ${new Date(h.clock.now().getTime() + DAY)})`.execute(h.db)
    // (a reset re-binds the page that did it to the new PIN version; this page plays that page)
    await sql`update client_links set pin_version = 1 where customer_id = ${id}`.execute(h.db)
    const held = await book(session, wash({ startMin: 14 * 60 }))
    expect(held.statusCode, held.body).toBe(201)
    expect(json(held)).toMatchObject({ member: false, deposit: { dueCents: 2500 } })
  })

  it('a stranger’s link books once verified by code: the name is required and creates the client', async () => {
    const { session } = await h.page({ customerId: null, phone: PHONES.stranger })
    expect((await book(session, wash({ name: 'Sam Stranger' }))).statusCode).toBe(403)
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    const noName = await book(session, wash())
    expect(noName.statusCode).toBe(422)
    expect(json(noName).errors[0].path).toBe('body.name')
    const r = await book(session, wash({ name: 'Sam Stranger', email: 'sam@example.test', smsConsent: true }))
    expect(r.statusCode, r.body).toBe(201)
    const c = await h.db.selectFrom('customers').selectAll().where('phone_e164', '=', PHONES.stranger).executeTakeFirstOrThrow()
    expect(c).toMatchObject({ full_name: 'Sam Stranger', source: 'online', sms_opted_in: true, sms_opt_in_source: 'online', email_verified: false })
    expect((await appointments())[0]).toMatchObject({ customer_id: c.id, source: 'link' })
  })

  it('fills a placeholder name and never replaces a real one', async () => {
    const real = await trustedPage()
    expect((await book(real.session, wash({ name: 'Mary' }))).statusCode).toBe(201)
    expect((await h.db.selectFrom('customers').select('full_name').where('id', '=', real.id).executeTakeFirstOrThrow()).full_name).toBe('Maria Delgado')
    const id = await h.customer({ name: 'New texter ••0122', phone: PHONES.liam, needsDetails: true })
    await h.trust(id, PHONES.liam)
    const { session } = await h.page({ customerId: id })
    expect((await book(session, wash({ name: 'Liam Ortiz', startMin: 14 * 60 }))).statusCode).toBe(201)
    expect(await h.db.selectFrom('customers').select(['full_name', 'needs_details']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual({
      full_name: 'Liam Ortiz',
      needs_details: false,
    })
  })

  it('fills an empty email but never replaces the email on file, so a PIN reset’s notice still reaches the real owner', async () => {
    // a page trusted by the number alone (no PIN typed) books with someone else's email
    const id = await h.customer({ email: 'real.owner@example.test' })
    await sql`update customers set email_verified = true where id = ${id}`.execute(h.db)
    const a = await h.page({ customerId: id })
    await h.verifyByCode(a.session)
    expect((await h.call('POST', 'pin', { session: a.session, body: { pin: '4826' } })).statusCode).toBe(200)
    await h.trust(id)
    const { session } = await h.page({ customerId: id })
    const r = await book(session, wash({ email: 'attacker@evil.example' }))
    expect(r.statusCode, r.body).toBe(201)
    const owner = () => h.db.selectFrom('customers').select(['email', 'email_verified']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(await owner()).toEqual({ email: 'real.owner@example.test', email_verified: true })
    // a reset by code on the number: the notice goes to the email on file, never to the address typed on the page
    const b = await h.page({ customerId: id, kind: 'book_again' })
    expect((await h.verifyByCode(b.session, 'pin_reset')).statusCode).toBe(200)
    expect((await h.call('POST', 'pin/reset', { session: b.session, body: { pin: '5917' } })).statusCode).toBe(200)
    const notices = await h.db.selectFrom('outbox_emails').select(['to_email', 'template']).where('template', '=', 'pin_reset_notice').execute()
    expect(notices).toEqual([{ to_email: 'real.owner@example.test', template: 'pin_reset_notice' }])
    // a client with no email on file: the page may fill it (unverified, so it never links an order by itself)
    const liam = await h.customer({ name: 'Liam Ortiz', phone: PHONES.liam })
    await h.trust(liam, PHONES.liam)
    const p = await h.page({ customerId: liam })
    expect((await book(p.session, wash({ email: 'liam@example.test', startMin: 14 * 60 }))).statusCode).toBe(201)
    expect(await h.db.selectFrom('customers').select(['email', 'email_verified']).where('id', '=', liam).executeTakeFirstOrThrow()).toEqual({
      email: 'liam@example.test',
      email_verified: false,
    })
  })

  it('refuses in the website’s words: past, off the grid, an unknown service; other kinds of links cannot book', async () => {
    const { id, session } = await trustedPage()
    expect(json(await book(session, wash({ startMin: 9 * 60 })))).toMatchObject({ status: 409, code: 'PUBLIC_SLOT_PAST' })
    expect(json(await book(session, wash({ startMin: 13 * 60 + 5 })))).toMatchObject({ status: 422, errors: [{ path: 'body.startMin' }] })
    expect(json(await book(session, wash({ serviceKey: 'no-such-wash' })))).toMatchObject({ status: 422, errors: [{ path: 'body.serviceKey' }] })
    expect(json(await book(session, wash({ extra: 1 })))).toMatchObject({ status: 422 })
    const pay = await h.page({ customerId: id, kind: 'membership', planKey: 'premium' })
    expect(json(await book(pay.session, wash()))).toMatchObject({ status: 401, code: 'LINK_WRONG_PURPOSE' })
    // nothing was booked and the refused attempts used none of the link's bookings
    expect(await appointments()).toEqual([])
  })
})

describe('GET availability', () => {
  it('is never cached and is VIP-aware only once the page is verified', async () => {
    const id = await h.customer()
    await h.db.insertInto('vip_clients').values({ location_id: h.locationId, customer_id: id, added_by: null }).execute()
    const { session } = await h.page({ customerId: id })
    const slotAt = (b: Json) =>
      (b.days as Json[]).find((d) => d.date === '2026-06-19')!.slots.find((s: Json) => s.startMin === 16 * 60)
    const before = await h.call('GET', 'availability?days=7', { session })
    expect(before.statusCode, before.body).toBe(200)
    expect(before.headers['cache-control']).toBe('no-store')
    expect(json(before).vip).toBe(false)
    expect(slotAt(json(before)).state).toBe('vip')
    await h.verifyByCode(session)
    const after = json(await h.call('GET', 'availability?days=7', { session }))
    expect(after.vip).toBe(true)
    expect(['open', 'last']).toContain(slotAt(after).state)
    // and the booking follows the same rule
    const r = await book(session, wash({ date: '2026-06-19', startMin: 16 * 60 }))
    expect(r.statusCode, r.body).toBe(201)
  })

  it('takes the website’s strict query and answers only calendar and book-again pages', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id })
    expect((await h.call('GET', 'availability?days=99', { session })).statusCode).toBe(422)
    expect((await h.call('GET', 'availability?service=nope', { session })).statusCode).toBe(422)
    expect((await h.call('GET', 'availability', {})).statusCode).toBe(401)
    const m = await h.page({ customerId: id, kind: 'membership', planKey: 'premium' })
    expect(json(await h.call('GET', 'availability', { session: m.session }))).toMatchObject({ status: 401, code: 'LINK_WRONG_PURPOSE' })
  })
})

describe('POST appointments/:ref/reschedule', () => {
  it('moves one of the client’s own upcoming visits under the online rules and texts the new time', async () => {
    const { session } = await trustedPage()
    const ref = json(await book(session, wash())).bookingRef as string
    const r = await h.call('POST', `appointments/${ref}/reschedule`, { session, body: { date: TODAY, startMin: 15 * 60 } })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toMatchObject({ bookingRef: ref, status: 'booked', when: 'Sat, Jun 13 · 3:00 PM' })
    const [a] = await appointments()
    expect(a!.scheduled_start.toISOString()).toBe('2026-06-13T19:00:00.000Z')
    expect((await h.texts(PHONES.maria)).length).toBe(2)
    const past = await h.call('POST', `appointments/${ref}/reschedule`, { session, body: { date: TODAY, startMin: 9 * 60 } })
    expect(json(past)).toMatchObject({ status: 409, code: 'PUBLIC_SLOT_PAST' })
  })

  it('never reaches another client’s visit, a started one, or works on an unverified page', async () => {
    const liam = await trustedPage({ name: 'Liam Ortiz', phone: PHONES.liam })
    const liamRef = json(await book(liam.session, wash())).bookingRef as string
    const maria = await trustedPage()
    const other = await h.call('POST', `appointments/${liamRef}/reschedule`, { session: maria.session, body: { date: TODAY, startMin: 15 * 60 } })
    expect(other.statusCode).toBe(404)
    expect(json(other).code).toBe('LINK_APPOINTMENT_NOT_FOUND')
    await sql`update appointments set status = 'arrived', arrived_at = app_now() where customer_id = ${liam.id}`.execute(h.db)
    const started = await h.call('POST', `appointments/${liamRef}/reschedule`, { session: liam.session, body: { date: TODAY, startMin: 15 * 60 } })
    expect(json(started)).toMatchObject({ status: 409, code: 'LINK_CANT_RESCHEDULE' })
    const fresh = await h.customer({ name: 'Ola Other', phone: PHONES.other })
    const unverified = await h.page({ customerId: fresh })
    expect(json(await h.call('POST', 'appointments/OAS-00001/reschedule', { session: unverified.session, body: { date: TODAY, startMin: 15 * 60 } }))).toMatchObject({
      status: 403,
      code: 'IDENTITY_STEP_UP_REQUIRED',
    })
    expect((await h.call('POST', 'appointments/12/reschedule', { session: maria.session, body: { date: TODAY, startMin: 15 * 60 } })).statusCode).toBe(422)
  })
})
