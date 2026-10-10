// POST /public/bookings over the real app (ADR 0150): a real appointment with its invoice, the customer created or linked by phone
// with consent, the design's confirmation text queued in the same transaction (suppressed off the allowlist), the guest fee from
// the settings and none for a member, the design's wording on a taken or VIP-held slot, the last-bay race, idempotent replay,
// validation, the honeypot, the durable limits, token rules, and the dashboard's board seeing the booking.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createManualMembership } from '../../src/modules/memberships/service.js'
import { upsertCustomerByPhone, upsertVehicleByPlate } from '../../src/modules/customers/service.js'
import { loadCustomerTarget } from '../../src/modules/messaging/db/recipients.js'
import { bookingBody, json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness()

const book = (body: Record<string, unknown>, o: Parameters<typeof h.post>[2] = {}) => h.post('public/bookings', body, o)

async function tokenFor(phone: string): Promise<string> {
  const { challengeId } = json(await h.post('public/otp', { phone }))
  const r = await h.post('public/otp/verify', { challengeId, code: await h.codeSentTo(phone, challengeId) })
  expect(r.statusCode, r.body).toBe(200)
  return json(r).memberToken as string
}

async function member(phone: string, name = 'Mia Member', email = 'mia@example.test'): Promise<string> {
  return h.db.transaction().execute(async (tx) => {
    const { customer } = await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: name, phone, email, source: 'dashboard' })
    await createManualMembership(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, { customerId: customer.id, planKey: 'premium', planLabel: 'Gold' }, { userId: 'test', name: 'Test', audit: {} })
    return customer.id
  })
}

const appointments = () =>
  h.db.selectFrom('appointments').select(['id', 'seq', 'status', 'source', 'customer_id', 'scheduled_start', 'package_name', 'created_by']).orderBy('seq').execute()

describe('a guest booking', () => {
  it('creates the appointment, invoice, customer (consent, source online) and vehicle, queues the design’s confirmation, and reports the fee', async () => {
    const r = await book(bookingBody(h, { addonKeys: [h.key('Wax')] }))
    expect(r.statusCode, r.body).toBe(201)
    const b = json(r)
    expect(b).toMatchObject({
      status: 'booked',
      start: '2026-06-13T17:00:00.000Z',
      bayCount: 1,
      deposit: { dueCents: 2500, how: 'counter' },
      confirmationBy: 'sms',
      service: { key: 'express-hand-wash', name: 'Express Hand Wash' },
      addons: [{ key: 'wax', name: 'Wax' }],
      when: 'Today · 1:00 PM',
      member: false,
    })
    expect(b.bookingRef).toMatch(/^OAS-\d{5}$/)
    expect(r.headers['location']).toBeUndefined()
    const [a] = await appointments()
    expect(a).toMatchObject({ status: 'booked', source: 'online', package_name: 'Express Hand Wash', created_by: null })
    expect(b.bookingRef).toBe(`OAS-${String(a!.seq).padStart(5, '0')}`)
    const c = await h.db.selectFrom('customers').selectAll().where('id', '=', a!.customer_id).executeTakeFirstOrThrow()
    expect(c).toMatchObject({ full_name: 'Nina Guest', phone_e164: PHONES.guest, email: 'nina@example.test', source: 'online', sms_opted_in: true, sms_opt_in_source: 'online', synthetic: false, needs_details: false })
    const v = await h.db.selectFrom('vehicles').selectAll().where('customer_id', '=', c.id).execute()
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ year: 2021, make: 'Tesla', model: 'Model 3', plate: 'NJ-NINA1' })
    const inv = await sql<{ customer_id: string }>`select customer_id from invoices where appointment_id = ${a!.id}`.execute(h.db)
    expect(inv.rows).toEqual([{ customer_id: c.id }])
    const addons = await h.db.selectFrom('appointment_addons').select('name').where('appointment_id', '=', a!.id).execute()
    expect(addons.map((x) => x.name)).toEqual(['Wax'])
    const texts = await h.texts(PHONES.guest)
    expect(texts).toHaveLength(1)
    expect(texts[0]!.klass).toBe('booking_confirmed_web')
    expect(texts[0]!.body).toMatch(/^Booked: Express Hand Wash, today at 1:00 PM\. \$25 booking fee due at the shop\. Reply here to change it\./)
    const activity = await h.db.selectFrom('activity_log').select('text').where('appointment_id', '=', a!.id).orderBy('id').execute()
    expect(activity.map((x) => x.text)).toEqual(['Booking created', 'Booking confirmation sent', 'Booked on the website · $25 booking fee due at the counter'])
    const events = await h.db.selectFrom('realtime_events').select(['channel', 'type']).orderBy('id').execute()
    expect(events.filter((e) => e.channel === 'ops').map((e) => e.type)).toEqual(expect.arrayContaining(['appointment.updated', 'availability.changed', 'kpi.dirty']))
    const audit = await h.db.selectFrom('audit_log').select(['action', 'actor_name', 'ip']).where('action', '=', 'appointment.create').executeTakeFirstOrThrow()
    expect(audit).toMatchObject({ actor_name: 'Website' })
  })

  it('shows on the dashboard’s board (the ops snapshot) at once', async () => {
    expect((await book(bookingBody(h))).statusCode).toBe(201)
    const [a] = await appointments()
    const snap = await h.staff('GET', 'ops/snapshot?window=today')
    expect(snap.statusCode, snap.body).toBe(200)
    expect(snap.body).toContain(a!.id)
    expect(snap.body).toContain('Nina Guest')
  })

  it('follows the guest fee setting (amount and collection by link) and the "no fee" wording for a $0 fee', async () => {
    await sql`insert into settings (location_id, key, value) values (${h.locationId}, 'booking.guest_fee', ${JSON.stringify({ cents: 1500, collect: 'link' })}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value`.execute(h.db)
    const b = json(await book(bookingBody(h)))
    expect(b.deposit).toEqual({ dueCents: 1500, how: 'link' })
    expect((await h.texts(PHONES.guest))[0]!.body).toContain('$15 booking fee due by payment link.')
    await sql`update settings set value = ${JSON.stringify({ cents: 0, collect: 'counter' })}::jsonb where location_id = ${h.locationId} and key = 'booking.guest_fee'`.execute(h.db)
    const free = json(await book(bookingBody(h, { phone: PHONES.extra, startMin: 14 * 60 })))
    expect(free.deposit).toEqual({ dueCents: 0, how: 'counter' })
    expect((await h.texts(PHONES.extra))[0]!.body).toMatch(/^Booked: Express Hand Wash, today at 2:00 PM\. Reply here to change it\./)
  })

  it('an unverified booking with the number of an existing customer links the appointment and changes nothing on the record', async () => {
    const existing = await h.db.transaction().execute(async (tx) => {
      // a placeholder entered at the desk: no name, no email, never opted in, one car (deleted since)
      const { customer } = await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), phone: PHONES.guest, source: 'dashboard' })
      await upsertVehicleByPlate(tx, { newId: h.newId, customerId: customer.id, year: 2015, make: 'Honda', model: 'Fit', plate: 'NJ-NINA1' })
      await sql`update vehicles set deleted_at = app_now() where customer_id = ${customer.id}`.execute(tx)
      return customer
    })
    const before = await h.db.selectFrom('customers').selectAll().where('id', '=', existing.id).executeTakeFirstOrThrow()
    const carsBefore = await h.db.selectFrom('vehicles').selectAll().where('customer_id', '=', existing.id).execute()
    const r = await book(bookingBody(h, { name: 'Somebody Else', email: 'attacker@example.test', smsConsent: true, vehicle: { label: '2024 Lamborghini Urus', plate: 'NJ-NINA1' } }))
    expect(r.statusCode, r.body).toBe(201)
    const [a] = await appointments()
    expect(a!.customer_id).toBe(existing.id)
    const after = await h.db.selectFrom('customers').selectAll().where('id', '=', existing.id).executeTakeFirstOrThrow()
    expect(after).toEqual(before) // name, email, consent, version: all as they were
    expect(await h.db.selectFrom('vehicles').selectAll().where('customer_id', '=', existing.id).execute()).toEqual(carsBefore)
    expect((await h.db.selectFrom('appointments').select('vehicle_id').where('id', '=', a!.id).executeTakeFirstOrThrow()).vehicle_id).toBeNull()
    expect(await h.db.selectFrom('customers').select('id').where('synthetic', '=', false).execute()).toHaveLength(1)
    // staff see what was typed, marked as not verified, on the appointment's internal log
    const notes = await h.db.selectFrom('activity_log').select(['text', 'channels']).where('appointment_id', '=', a!.id).execute()
    const note = notes.find((n) => /not verified/.test(n.text))
    expect(note, JSON.stringify(notes)).toBeDefined()
    expect(note!.text).toContain('Somebody Else')
    expect(note!.text).toContain('attacker@example.test')
    expect(note!.text).toContain('2024 Lamborghini Urus')
    expect(note!.channels).toEqual(['internal'])
    // never opted in (and the website's consent is not recorded on an unverified number), so nothing is texted
    expect(await h.texts(PHONES.guest)).toEqual([])
  })

  it('records the website’s consent as the transactional kind: confirmations and reminders yes, marketing never', async () => {
    expect((await book(bookingBody(h))).statusCode).toBe(201)
    const c = await h.db.selectFrom('customers').select(['id', 'sms_opted_in', 'sms_opt_in_source']).where('phone_e164', '=', PHONES.guest).executeTakeFirstOrThrow()
    expect(c).toMatchObject({ sms_opted_in: true, sms_opt_in_source: 'online' })
    const target = await loadCustomerTarget(h.db, h.locationId, c.id)
    expect(target!.recipient.consentSource).toBe('web_booking')
  })

  it('suppresses the confirmation for a number off the allowlist outside production, and still books (the answer says what was asked for)', async () => {
    const r = await book(bookingBody(h, { phone: PHONES.stranger, name: 'Sam Stranger' }))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).confirmationBy).toBe('sms')
    expect(await h.texts(PHONES.stranger)).toEqual([])
    expect(await appointments()).toHaveLength(1)
  })
})

describe('a member booking', () => {
  it('with a verified token owes nothing, gets the member sentence, and may correct their own name and email', async () => {
    const id = await member(PHONES.member)
    const memberToken = await tokenFor(PHONES.member)
    const r = await book(bookingBody(h, { phone: PHONES.member, name: 'Mia Membership', email: 'mia2@example.test', memberToken }))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({ member: true, deposit: { dueCents: 0, how: 'counter' }, confirmationBy: 'sms' })
    const texts = (await h.texts(PHONES.member)).filter((t) => t.klass === 'booking_confirmed_web')
    expect(texts[0]!.body).toMatch(/^Booked: Express Hand Wash, today at 1:00 PM\. Members never pay a booking fee\. Reply here to change it\./)
    const c = await h.db.selectFrom('customers').select(['full_name', 'email', 'sms_opted_in']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(c).toEqual({ full_name: 'Mia Membership', email: 'mia2@example.test', sms_opted_in: true })
    // the verified owner's car goes on their record
    expect(await h.db.selectFrom('vehicles').select(['make', 'plate']).where('customer_id', '=', id).execute()).toEqual([{ make: 'Tesla', plate: 'NJ-NINA1' }])
    const activity = await h.db.selectFrom('activity_log').select('text').orderBy('id').execute()
    expect(activity.at(-1)!.text).toBe('Booked on the website · member, no booking fee')
  })

  it('without a token a member’s number books as a guest’s would: the fee is due and the answer is a guest’s (nothing reveals the membership)', async () => {
    const id = await member(PHONES.member)
    await sql`update customers set sms_opted_in = true, sms_opt_in_source = 'dashboard' where id = ${id}`.execute(h.db)
    const r = await book(bookingBody(h, { phone: PHONES.member, name: 'Mia Member' }))
    expect(r.statusCode, r.body).toBe(201)
    const guest = await book(bookingBody(h, { phone: PHONES.extra, name: 'Gus Guest', startMin: 14 * 60 }))
    const strip = (x: Record<string, unknown>) => ({ ...x, bookingRef: '', start: '', end: '', when: '', bayCount: 0 })
    expect(strip(json(r))).toEqual(strip(json(guest)))
    expect(json(r)).toMatchObject({ member: false, deposit: { dueCents: 2500 }, confirmationBy: 'sms' })
    // the text goes to the number on file (its owner learns of the booking) with the guest's sentence
    const texts = await h.texts(PHONES.member)
    expect(texts[0]!.body).toMatch(/\$25 booking fee due at the shop/)
    const activity = await h.db.selectFrom('activity_log').select('text').orderBy('id').execute()
    expect(activity.map((x) => x.text)).toContain('Booked on the website · $25 booking fee due at the counter')
  })

  it('answers an unverified booking for a known number the same way, whatever the record says (opted out, never opted in)', async () => {
    const id = await member(PHONES.member)
    await sql`update customers set sms_opted_out_at = app_now() where id = ${id}`.execute(h.db)
    const known = json(await book(bookingBody(h, { phone: PHONES.member, smsConsent: true })))
    const unknown = json(await book(bookingBody(h, { phone: PHONES.extra, smsConsent: true, startMin: 14 * 60 })))
    expect(known.confirmationBy).toBe('sms')
    expect(unknown.confirmationBy).toBe('sms')
    expect(await h.texts(PHONES.member)).toEqual([])
    const quiet = json(await book(bookingBody(h, { phone: PHONES.joiner, smsConsent: false, startMin: 14 * 60 + 30 })))
    expect(quiet.confirmationBy).toBe('none')
  })

  it('VIP rules (held times, the 30-day window) need the VIP’s code: the number alone books as anyone', async () => {
    const id = await member(PHONES.member)
    await h.db.insertInto('vip_clients').values({ location_id: h.locationId, customer_id: id, added_by: null }).execute()
    const held = await book(bookingBody(h, { phone: PHONES.member, date: '2026-06-19', startMin: 16 * 60 }))
    expect(json(held)).toMatchObject({ status: 409, code: 'PUBLIC_SLOT_VIP' })
    const far = await book(bookingBody(h, { phone: PHONES.member, date: '2026-07-02', startMin: 13 * 60 }))
    expect(json(far)).toMatchObject({ status: 409, code: 'PUBLIC_SLOT_TOO_FAR', detail: 'Online booking opens 14 days ahead. Pick a sooner time.' })
    const memberToken = await tokenFor(PHONES.member)
    const heldOk = await book(bookingBody(h, { phone: PHONES.member, date: '2026-06-19', startMin: 16 * 60, memberToken }))
    expect(heldOk.statusCode, heldOk.body).toBe(201)
    const farOk = await book(bookingBody(h, { phone: PHONES.member, date: '2026-07-02', startMin: 13 * 60, memberToken }))
    expect(farOk.statusCode, farOk.body).toBe(201)
  })

  it('a verified member of the website’s VIP tier gets the VIP rules too; a verified Gold member does not', async () => {
    const vip = await h.db.transaction().execute(async (tx) => {
      const { customer } = await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: 'Vic Vip', phone: PHONES.joiner, source: 'dashboard' })
      await createManualMembership(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, { customerId: customer.id, planKey: 'executive', planLabel: 'VIP' }, { userId: 'test', name: 'Test', audit: {} })
      return customer.id
    })
    expect(await h.db.selectFrom('vip_clients').select('customer_id').where('customer_id', '=', vip).execute()).toEqual([])
    const vipToken = await tokenFor(PHONES.joiner)
    const ok = await book(bookingBody(h, { phone: PHONES.joiner, date: '2026-06-19', startMin: 16 * 60, memberToken: vipToken }))
    expect(ok.statusCode, ok.body).toBe(201)
    expect(json(ok)).toMatchObject({ member: true, deposit: { dueCents: 0 } })
    await member(PHONES.member)
    const goldToken = await tokenFor(PHONES.member)
    const gold = await book(bookingBody(h, { phone: PHONES.member, date: '2026-06-19', startMin: 16 * 60, memberToken: goldToken }))
    expect(json(gold)).toMatchObject({ status: 409, code: 'PUBLIC_SLOT_VIP' })
  })

  it('refuses an expired token (401) and a token for another number (422); a pending membership is not a member', async () => {
    await member(PHONES.member)
    const memberToken = await tokenFor(PHONES.member)
    expect(json(await book(bookingBody(h, { phone: PHONES.guest, memberToken })))).toMatchObject({ status: 422, code: 'PUBLIC_TOKEN_PHONE_MISMATCH' })
    h.clock.set('2026-06-13T11:07:00-04:00')
    const late = await book(bookingBody(h, { phone: PHONES.member, memberToken, startMin: 14 * 60 }))
    expect(json(late)).toMatchObject({ status: 401, code: 'PUBLIC_TOKEN_INVALID', title: 'Verify your number again' })
    h.clock.set('2026-06-13T10:36:00-04:00')
    expect(json(await book(bookingBody(h, { memberToken: 'x'.repeat(43) })))).toMatchObject({ status: 401, code: 'PUBLIC_TOKEN_INVALID' })
    await sql`update memberships set status = 'pending'`.execute(h.db)
    expect(json(await book(bookingBody(h, { phone: PHONES.member, startMin: 15 * 60 })))).toMatchObject({ member: false, deposit: { dueCents: 2500 } })
  })
})

describe('slots, races and replays', () => {
  it('answers the design’s wording when the time is gone, held for VIP, past or outside the hours', async () => {
    // two bays: two bookings fill 1:00 PM, the third is told the time was just taken
    expect((await book(bookingBody(h))).statusCode).toBe(201)
    expect((await book(bookingBody(h, { phone: PHONES.extra, name: 'Second' }))).statusCode).toBe(201)
    const taken = await book(bookingBody(h, { phone: PHONES.member, name: 'Third' }))
    expect(taken.statusCode).toBe(409)
    expect(json(taken)).toMatchObject({ code: 'PUBLIC_SLOT_TAKEN', title: 'That time was just taken', detail: 'That time was just taken. Pick another.' })
    expect(taken.headers['content-type']).toMatch(/problem\+json/)
    expect(await appointments()).toHaveLength(2)
    // each case from its own number: five bookings an hour per number is the limit this test must not trip
    const vip = await book(bookingBody(h, { date: '2026-06-19', startMin: 16 * 60, phone: '+12015550301' }))
    expect(json(vip)).toMatchObject({ code: 'PUBLIC_SLOT_VIP', detail: '4:00 PM is held for VIP members. Join to book it with no fee.' })
    const past = await book(bookingBody(h, { startMin: 10 * 60 + 30, phone: '+12015550302' }))
    expect(json(past)).toMatchObject({ code: 'PUBLIC_SLOT_PAST', detail: 'That time has passed. Pick another.' })
    const soon = await book(bookingBody(h, { startMin: 11 * 60, phone: '+12015550303' })) // 11:00 is inside the 30-minute online lead time
    expect(json(soon).code).toBe('PUBLIC_SLOT_PAST')
    const early = await book(bookingBody(h, { date: '2026-06-15', startMin: 7 * 60, phone: '+12015550304' }))
    expect(json(early)).toMatchObject({ code: 'PUBLIC_SLOT_CLOSED', detail: 'We’re closed at that time. Pick another.' })
    const far = await book(bookingBody(h, { date: '2026-07-20', startMin: 13 * 60, phone: '+12015550305' }))
    expect(json(far)).toMatchObject({ code: 'PUBLIC_SLOT_TOO_FAR', detail: 'Online booking opens 14 days ahead. Pick a sooner time.' })
    for (const r of [vip, past, early, far]) expect(r.body).not.toMatch(/override/i)
  })

  it('two bookings for the last bay at once: exactly one 201, the other 409 (repeated to catch interleavings)', async () => {
    for (let round = 0; round < 4; round++) {
      await sql`truncate table appointments, activity_log, idempotency_keys, messages, sms_outbox, public_rate_limits restart identity cascade`.execute(h.db)
      const at = 14 * 60 + 30 * (round % 2)
      expect((await book(bookingBody(h, { startMin: at }))).statusCode).toBe(201)
      const [a, b] = await Promise.all([
        book(bookingBody(h, { phone: PHONES.extra, name: 'Racer A', startMin: at })),
        book(bookingBody(h, { phone: PHONES.member, name: 'Racer B', startMin: at })),
      ])
      const codes = [a.statusCode, b.statusCode].sort()
      expect(codes, `round ${round}: ${a.body} / ${b.body}`).toEqual([201, 409])
      const loser = a.statusCode === 409 ? a : b
      expect(json(loser).code).toBe('PUBLIC_SLOT_TAKEN')
      expect(await appointments()).toHaveLength(2)
    }
  })

  it('needs an Idempotency-Key, replays the same request, and refuses the same key with another body', async () => {
    const noKey = await book(bookingBody(h), { key: null })
    expect(noKey.statusCode).toBe(400)
    expect(json(noKey).code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    const key = h.nextKey()
    const ip = h.nextIp()
    const first = await book(bookingBody(h), { key, ip })
    expect(first.statusCode).toBe(201)
    const again = await book(bookingBody(h), { key, ip })
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(json(again)).toEqual(json(first))
    expect(await appointments()).toHaveLength(1)
    expect(await h.texts(PHONES.guest)).toHaveLength(1)
    const other = await book(bookingBody(h, { startMin: 14 * 60 }), { key, ip })
    expect(other.statusCode).toBe(422)
    expect(json(other).code).toBe('IDEMPOTENCY_MISMATCH')
  })
})

describe('validation, the honeypot and the limits', () => {
  it('422 with field paths for a missing name, a bad number, an unknown service or add-on, an unknown field, a bad date', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'body.name'],
      [{ phone: '555' }, 'body.phone'],
      [{ phone: '+447911123456' }, 'body.phone'],
      [{ phone: '+19005551234' }, 'body.phone'],
      [{ phone: '+18765550123' }, 'body.phone'],
      [{ serviceKey: 'no-such' }, 'body.serviceKey'],
      [{ addonKeys: ['no-such'] }, 'body.addonKeys'],
      [{ date: '13/06/2026' }, 'body.date'],
      [{ date: '2026-02-30' }, 'body.date'], // the right shape, no such day
      [{ date: '2026-13-01' }, 'body.date'],
      [{ startMin: 13 * 60 + 5 }, 'body.startMin'], // 1:05 PM is not on the board's 30-minute grid
      [{ startMin: 13 * 60 + 15 }, 'body.startMin'],
      [{ startMin: 1500 }, 'body.startMin'],
      [{ card: '4242' }, 'body'],
    ]
    for (const [extra, path] of cases) {
      const r = await book(bookingBody(h, extra))
      expect(r.statusCode, JSON.stringify(extra)).toBe(422)
      expect(json(r).code).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(json(r).errors), JSON.stringify(extra)).toContain(path)
    }
    expect(await appointments()).toEqual([])
    expect(await h.db.selectFrom('customers').select('id').where('synthetic', '=', false).execute()).toEqual([])
  })

  it('a start off the grid next to a VIP-held time is refused like any off-grid start, not booked into the hold', async () => {
    // Friday 4:00 PM is held; 4:05 used to pass (the hold check matched the exact start only)
    const r = await book(bookingBody(h, { date: '2026-06-19', startMin: 16 * 60 + 5 }))
    expect(r.statusCode).toBe(422)
    expect(json(r).errors).toEqual([{ path: 'body.startMin', message: 'Pick one of the times on the board.' }])
    expect(await appointments()).toEqual([])
  })

  it('an impossible date is a 422 for the honeypot too, never a 500', async () => {
    const r = await book(bookingBody(h, { date: '2026-02-30', website: 'spam' }))
    expect(r.statusCode).toBe(422)
    expect(JSON.stringify(json(r).errors)).toContain('body.date')
  })

  it('a filled honeypot answers 202 with a fake reference and writes nothing', async () => {
    const r = await book(bookingBody(h, { website: 'http://spam.example' }))
    expect(r.statusCode).toBe(202)
    const b = json(r)
    expect(b.bookingRef).toMatch(/^OAS-\d{5}$/)
    expect(b.status).toBe('booked')
    expect(await appointments()).toEqual([])
    expect(await h.db.selectFrom('customers').select('id').where('synthetic', '=', false).execute()).toEqual([])
    expect(await h.texts(PHONES.guest)).toEqual([])
    expect(await h.db.selectFrom('audit_log').select('id').execute()).toEqual([])
  })

  it('limits a number to 3 bookings an hour from one address and 5 in all (a refused booking counts too), and an address to 10', async () => {
    const times = [11 * 60 + 30, 12 * 60, 12 * 60 + 30, 13 * 60, 13 * 60 + 30, 14 * 60]
    const one = '10.92.1.1'
    for (let i = 0; i < 3; i++) expect((await book(bookingBody(h, { startMin: times[i] }), { ip: one })).statusCode, `booking ${i + 1}`).toBe(201)
    const fourth = await book(bookingBody(h, { startMin: times[3] }), { ip: one })
    expect(fourth.statusCode).toBe(429)
    expect(json(fourth)).toMatchObject({ code: 'PUBLIC_RATE_LIMITED', detail: expect.stringMatching(/^Too many requests from this number or device\. Try again in \d+ min\.$/) })
    expect(fourth.headers['retry-after']).toBeDefined()
    // a refused booking counts: 11:30 is now taken by this number, and the next try is refused for the slot, yet still counted
    expect((await book(bookingBody(h, { startMin: 10 * 60 }), { ip: '10.92.1.2' })).statusCode).toBe(409)
    expect((await book(bookingBody(h, { startMin: times[4] }), { ip: '10.92.1.3' })).statusCode).toBe(201)
    expect((await book(bookingBody(h, { startMin: times[5] }), { ip: '10.92.1.4' })).statusCode).toBe(429)
    expect(await appointments()).toHaveLength(4)
    const ip = '10.92.0.1'
    for (let i = 0; i < 10; i++) {
      const r = await book(bookingBody(h, { phone: `+1201555${String(300 + i).padStart(4, '0')}`, startMin: 15 * 60 }), { ip })
      expect([201, 409], `ip booking ${i + 1}: ${r.body}`).toContain(r.statusCode)
    }
    expect((await book(bookingBody(h, { phone: '+12015550399', startMin: 15 * 60 + 30 }), { ip })).statusCode).toBe(429)
  })

  it('one address naming a number over and over cannot lock its owner out of booking', async () => {
    const attacker = '10.92.2.1'
    const answers = []
    for (let i = 0; i < 10; i++) answers.push((await book(bookingBody(h, { phone: PHONES.member, name: 'Not Mia', startMin: 11 * 60 + 30 + 30 * (i % 3) }), { ip: attacker })).statusCode)
    expect(answers).toEqual([201, 201, 201, 429, 429, 429, 429, 429, 429, 429])
    expect((await book(bookingBody(h, { phone: PHONES.member, startMin: 15 * 60 }), { ip: '10.92.2.2' })).statusCode).toBe(201)
  })
})
