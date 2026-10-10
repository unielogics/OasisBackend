// POST /public/bookings over the real app (ADR 0150): a real appointment with its invoice, the customer created or linked by phone
// with consent, the design's confirmation text queued in the same transaction (suppressed off the allowlist), the guest fee from
// the settings and none for a member, the design's wording on a taken or VIP-held slot, the last-bay race, idempotent replay,
// validation, the honeypot, the durable limits, token rules, and the dashboard's board seeing the booking.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createManualMembership } from '../../src/modules/memberships/service.js'
import { upsertCustomerByPhone } from '../../src/modules/customers/service.js'
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

  it('links an existing customer by phone without touching their name or email, and records consent only when given', async () => {
    const existing = await h.db.transaction().execute((tx) =>
      upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: 'Nina Original', phone: PHONES.guest, email: 'original@example.test', source: 'dashboard' }),
    )
    const r = await book(bookingBody(h, { name: 'Somebody Else', email: 'other@example.test', smsConsent: false }))
    expect(r.statusCode, r.body).toBe(201)
    const c = await h.db.selectFrom('customers').selectAll().where('id', '=', existing.customer.id).executeTakeFirstOrThrow()
    expect(c).toMatchObject({ full_name: 'Nina Original', email: 'original@example.test', sms_opted_in: false })
    expect(await h.db.selectFrom('customers').select('id').where('synthetic', '=', false).execute()).toHaveLength(1)
    // no consent: the confirmation is not sent (policy not_opted_in), and the answer says so
    expect(json(r).confirmationBy).toBe('none')
    expect(await h.texts(PHONES.guest)).toEqual([])
  })

  it('suppresses the confirmation for a number off the allowlist outside production, and still books', async () => {
    const r = await book(bookingBody(h, { phone: PHONES.stranger, name: 'Sam Stranger' }))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).confirmationBy).toBe('none')
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
    const c = await h.db.selectFrom('customers').select(['full_name', 'email']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(c).toEqual({ full_name: 'Mia Membership', email: 'mia2@example.test' })
    const activity = await h.db.selectFrom('activity_log').select('text').orderBy('id').execute()
    expect(activity.at(-1)!.text).toBe('Booked on the website · member, no booking fee')
  })

  it('without a token an active member still pays no fee (the fee follows the membership, the token only proves the number)', async () => {
    await member(PHONES.member)
    const r = await book(bookingBody(h, { phone: PHONES.member, name: 'Mia Member' }))
    expect(json(r)).toMatchObject({ member: true, deposit: { dueCents: 0 } })
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
