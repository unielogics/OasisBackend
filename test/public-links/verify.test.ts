// Step-up on a personal link page (ADR 0160, design sections 5 and 10): a texted code goes to the link's own number only (a phone
// in the body is ignored), a confirmed code verifies the page and trusts the number 30 days, a PIN outranks a code once set, a
// wrong PIN where none exists answers like any wrong PIN, a reset holds memberships and payments for 72 hours.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { DAY, HOUR, json, MIN, PHONES, useLinksHarness } from './harness.js'

const h = useLinksHarness()

describe('texted codes', () => {
  it('go to the link’s number only: a phone field in the body is ignored', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id })
    const r = await h.call('POST', 'verify/code', { session, body: { purpose: 'verify', phone: PHONES.intruder, to: PHONES.liam } })
    expect(r.statusCode, r.body).toBe(202)
    expect(json(r)).toMatchObject({ purpose: 'verify', expiresInSec: 600, to: '21' })
    const row = await h.db.selectFrom('public_otp_challenges').selectAll().where('id', '=', json(r).challengeId).executeTakeFirstOrThrow()
    expect(row.phone_e164).toBe(PHONES.maria)
    expect(row.purpose).toBe('link_verify')
    expect((await h.texts(PHONES.maria)).map((t) => t.klass)).toEqual(['otp_code'])
    expect(await h.texts(PHONES.intruder)).toEqual([])
    expect(await h.texts(PHONES.liam)).toEqual([])
    const outbox = await h.db.selectFrom('sms_outbox').select('to_e164').execute()
    expect(outbox.map((o) => o.to_e164)).toEqual([PHONES.maria])
  })

  it('a confirmed code verifies the page, trusts the number 30 days and uses up a verify link', async () => {
    const id = await h.customer()
    const { session, link } = await h.page({ customerId: id, kind: 'verify' })
    const v = await h.verifyByCode(session)
    expect(v.statusCode, v.body).toBe(200)
    expect(json(v)).toMatchObject({ verified: true, trust: { verified: true, by: 'code' }, appointments: [] })
    expect(new Date(json(v).trust.until).getTime() - h.clock.now().getTime()).toBe(30 * DAY)
    expect(new Date(json(v).stepUp.freshUntil).getTime() - h.clock.now().getTime()).toBe(5 * MIN)
    expect(new Date(json(v).stepUp.canSetPinUntil).getTime() - h.clock.now().getTime()).toBe(10 * MIN)
    const trust = await h.db.selectFrom('phone_trust').selectAll().executeTakeFirstOrThrow()
    expect(trust).toMatchObject({ customer_id: id, phone_e164: PHONES.maria, verified_by: 'code' })
    const row = await h.db.selectFrom('client_links').select(['uses', 'consumed_at']).where('id', '=', link.id).executeTakeFirstOrThrow()
    expect(row.uses).toBe(1)
    expect(row.consumed_at).not.toBeNull()
    // the page goes on; the link cannot be opened again
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(200)
    expect((await h.call('POST', 'exchange', { body: { token: link.token } })).statusCode).toBe(401)
  })

  it('a wrong code counts: 401 with the tries left, the third locks the code', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id })
    const r = await h.call('POST', 'verify/code', { session, body: {} })
    const challengeId = json(r).challengeId as string
    const right = await h.codeOf(challengeId)
    const wrong = right === '000000' ? '111111' : '000000'
    const a = await h.call('POST', 'verify/code/confirm', { session, body: { challengeId, code: wrong } })
    expect(a.statusCode).toBe(401)
    expect(json(a)).toMatchObject({ code: 'PUBLIC_OTP_INVALID', meta: { attemptsLeft: 2 } })
    await h.call('POST', 'verify/code/confirm', { session, body: { challengeId, code: wrong } })
    const c = await h.call('POST', 'verify/code/confirm', { session, body: { challengeId, code: wrong } })
    expect(c.statusCode).toBe(429)
    expect(json(c).code).toBe('PUBLIC_OTP_LOCKED')
    const late = await h.call('POST', 'verify/code/confirm', { session, body: { challengeId, code: right } })
    expect(late.statusCode).toBe(429)
    expect(json((await h.call('GET', 'me', { session }))).trust.verified).toBe(false)
  })

  it('a stranger’s link verifies the page by code, but trusts no number (there is no client yet)', async () => {
    const { session } = await h.page({ customerId: null, phone: PHONES.stranger })
    const v = await h.verifyByCode(session)
    expect(v.statusCode, v.body).toBe(200)
    expect(json(v)).toMatchObject({ verified: true, trust: { verified: true, until: null }, client: { firstName: '' } })
    expect(await h.db.selectFrom('phone_trust').selectAll().execute()).toEqual([])
    const pin = await h.call('POST', 'verify/code', { session, body: { purpose: 'pin_set' } })
    expect(pin.statusCode).toBe(409)
    expect(json(pin).code).toBe('IDENTITY_UNKNOWN_CLIENT')
  })
})

describe('the website PIN', () => {
  it('is chosen after a code, then outranks codes: the next page enters it (and a wrong one counts)', async () => {
    const id = await h.customer()
    const first = await h.page({ customerId: id })
    // no code yet: refused
    const early = await h.call('POST', 'pin', { session: first.session, body: { pin: '4826' } })
    expect(early.statusCode).toBe(403)
    expect(json(early).code).toBe('IDENTITY_CODE_REQUIRED')
    await h.verifyByCode(first.session)
    const blocked = await h.call('POST', 'pin', { session: first.session, body: { pin: '1234' } })
    expect(blocked.statusCode).toBe(422)
    expect(json(blocked).code).toBe('IDENTITY_PIN_REJECTED')
    const set = await h.call('POST', 'pin', { session: first.session, body: { pin: '4826' } })
    expect(set.statusCode, set.body).toBe(200)
    expect(json(set)).toMatchObject({ verified: true, stepUp: { method: 'pin' } })

    const next = await h.page({ customerId: id })
    expect(next.body.stepUp.method).toBe('pin')
    // the number is trusted, so the page starts verified; a PIN still gives the fresh step-up
    expect(next.body.trust.verified).toBe(true)
    const code = await h.call('POST', 'verify/code', { session: next.session, body: { purpose: 'verify' } })
    expect(code.statusCode).toBe(409)
    expect(json(code).code).toBe('IDENTITY_PIN_REQUIRED')
    const wrong = await h.call('POST', 'verify/pin', { session: next.session, body: { pin: '9137' } })
    expect(wrong.statusCode).toBe(401)
    expect(json(wrong)).toMatchObject({ code: 'IDENTITY_PIN_INVALID', meta: { attemptsLeft: 4 } })
    const right = await h.call('POST', 'verify/pin', { session: next.session, body: { pin: '4826' } })
    expect(right.statusCode, right.body).toBe(200)
    expect(json(right)).toMatchObject({ verified: true, trust: { verified: true, by: 'pin' } })
    expect(json(right).stepUp.freshUntil).not.toBeNull()
  })

  it('a PIN typed where none exists answers like a wrong PIN, and the fifth wrong entry ends the page', async () => {
    const id = await h.customer()
    const { session } = await h.page({ customerId: id })
    const answers = []
    for (let i = 0; i < 5; i++) answers.push(await h.call('POST', 'verify/pin', { session, body: { pin: '9137' } }))
    expect(answers.slice(0, 4).map((r) => [r.statusCode, json(r).code])).toEqual(Array(4).fill([401, 'IDENTITY_PIN_INVALID']))
    expect(json(answers[4]!).code).toBe('IDENTITY_SESSION_LOCKED')
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(401)
  })

  it('a reset by code: a new PIN, every other page ends, and memberships and payments wait 72 hours', async () => {
    const id = await h.customer()
    const a = await h.page({ customerId: id })
    await h.verifyByCode(a.session)
    expect((await h.call('POST', 'pin', { session: a.session, body: { pin: '4826' } })).statusCode).toBe(200)
    const other = await h.page({ customerId: id })
    const b = await h.page({ customerId: id, kind: 'membership', planKey: 'premium' })
    const reset = await h.verifyByCode(b.session, 'pin_reset')
    expect(reset.statusCode, reset.body).toBe(200)
    expect(json(reset).verified).toBe(false)
    const done = await h.call('POST', 'pin/reset', { session: b.session, body: { pin: '5917' } })
    expect(done.statusCode, done.body).toBe(200)
    expect(json(done)).toMatchObject({ verified: true, stepUp: { method: 'pin' } })
    expect((await h.call('GET', 'me', { session: other.session })).statusCode).toBe(401)
    await sql`update membership_plans set checkout_url = 'https://oasis.squarespace.com/checkout/gold' where key = 'premium'`.execute(h.db)
    const held = await h.call('POST', 'membership/start', { session: b.session, body: { email: 'maria@example.test' } })
    expect(held.statusCode, held.body).toBe(403)
    expect(json(held).code).toBe('LINK_PRIVILEGES_HELD')
    expect(new Date(json(held).meta.until).getTime() - h.clock.now().getTime()).toBe(72 * HOUR)
  })
})
