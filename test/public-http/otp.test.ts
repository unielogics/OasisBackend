// Member identification by phone + one-time SMS code (ADR 0150): the code goes through the messaging queue (and is suppressed for a
// number off the allowlist), is hashed at rest, allows three tries, expires, is one per number; a verified code issues a 30-minute
// member token that says only what the site may know about the member.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createManualMembership } from '../../src/modules/memberships/service.js'
import { upsertCustomerByPhone } from '../../src/modules/customers/service.js'
import { json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness()

const request = (phone: string, ip?: string) => h.post('public/otp', { phone }, { ip })
const verify = (challengeId: string, code: string, ip?: string) => h.post('public/otp/verify', { challengeId, code }, { ip })

async function member(phone: string, name = 'Mia Member'): Promise<string> {
  return h.db.transaction().execute(async (tx) => {
    const { customer } = await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: name, phone, email: 'mia@example.test', source: 'online', smsOptIn: 'online' })
    await createManualMembership(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, { customerId: customer.id, planKey: 'premium', planLabel: 'Gold' }, { userId: 'test', name: 'Test', audit: {} })
    return customer.id
  })
}

describe('POST /public/otp', () => {
  it('texts a six-digit code through the queue (class otp_code, no STOP footer), answers 202, stores only the hash, one active per number', async () => {
    const r = await request(PHONES.otp)
    expect(r.statusCode, r.body).toBe(202)
    const { challengeId, expiresInSec } = json(r)
    expect(expiresInSec).toBe(600)
    const texts = await h.texts(PHONES.otp)
    expect(texts).toHaveLength(1)
    expect(texts[0]!.klass).toBe('otp_code')
    expect(texts[0]!.body).toMatch(/^Your Oasis Auto Spa code is \d{6}\. It expires in 10 minutes\./)
    expect(texts[0]!.body).not.toMatch(/STOP/)
    const code = await h.codeSentTo(PHONES.otp, challengeId)
    const row = await h.db.selectFrom('public_otp_challenges').selectAll().where('id', '=', challengeId).executeTakeFirstOrThrow()
    expect(row.code_hash).not.toContain(code)
    expect(row.code_hash).toHaveLength(64)
    expect(row.consumed_at).toBeNull()
    expect(row.delivery).toBe('queued')
    // the Messages tab never shows the code
    const msg = await h.db.selectFrom('messages').select(['body', 'thread_id', 'customer_id']).executeTakeFirstOrThrow()
    expect(msg.body).not.toContain(code)
    expect(msg.thread_id).toBeNull()
    // a second request supersedes the first
    const again = await request(PHONES.otp)
    expect(again.statusCode).toBe(202)
    const first = await h.db.selectFrom('public_otp_challenges').select(['consumed_reason']).where('id', '=', challengeId).executeTakeFirstOrThrow()
    expect(first.consumed_reason).toBe('superseded')
    expect((await verify(challengeId, code)).statusCode).toBe(410)
  })

  it('still answers 202 for a number off the allowlist (nothing leaks), with the text suppressed outside production', async () => {
    const r = await request(PHONES.stranger)
    expect(r.statusCode).toBe(202)
    expect(await h.texts(PHONES.stranger)).toEqual([])
    const row = await h.db.selectFrom('public_otp_challenges').select('delivery').where('phone_e164', '=', PHONES.stranger).executeTakeFirstOrThrow()
    expect(row.delivery).toBe('not_allowlisted')
  })

  it('refuses a bad number (422) and limits a number to 3 codes per 10 minutes from one address, 5 in all, and an address to 10 (429 with Retry-After)', async () => {
    const bad = await request('12')
    expect(bad.statusCode).toBe(422)
    expect(json(bad).errors[0]).toEqual({ path: 'body.phone', message: 'Enter a valid mobile number.' })
    const one = '10.91.1.1'
    for (let i = 0; i < 3; i++) expect((await request(PHONES.extra, one)).statusCode, `code ${i + 1}`).toBe(202)
    const fourth = await request(PHONES.extra, one)
    expect(fourth.statusCode).toBe(429)
    expect(json(fourth)).toMatchObject({ code: 'PUBLIC_RATE_LIMITED', title: 'Slow down' })
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0)
    // one address cannot use up a number: the person asks from their own phone and still gets codes, up to 5 in the window
    expect((await request(PHONES.extra, '10.91.1.2')).statusCode).toBe(202)
    expect((await request(PHONES.extra, '10.91.1.3')).statusCode).toBe(202)
    expect((await request(PHONES.extra, '10.91.1.4')).statusCode).toBe(429)
    // the window turns over
    h.clock.set('2026-06-13T10:47:00-04:00')
    expect((await request(PHONES.extra, one)).statusCode).toBe(202)
    h.clock.set('2026-06-13T10:36:00-04:00')
    const ip = '10.91.0.1'
    for (let i = 0; i < 10; i++) expect((await request(`+1201555${String(200 + i).padStart(4, '0')}`, ip)).statusCode, `ip call ${i + 1}`).toBe(202)
    expect((await request('+12015550299', ip)).statusCode).toBe(429)
    // the counters live in the database, not in the process
    const rows = await sql<{ n: number }>`select count(*)::int as n from public_rate_limits where key like 'otp:%'`.execute(h.db)
    expect(rows.rows[0]!.n).toBeGreaterThan(10)
  })

  it('one address naming a number over and over cannot lock its owner out: only 3 of its calls count against the number', async () => {
    const attacker = '10.91.2.1'
    const answers = []
    for (let i = 0; i < 10; i++) answers.push((await request(PHONES.member, attacker)).statusCode)
    expect(answers).toEqual([202, 202, 202, 429, 429, 429, 429, 429, 429, 429])
    expect((await request(PHONES.member, '10.91.2.2')).statusCode).toBe(202)
    expect((await request(PHONES.member, '10.91.2.3')).statusCode).toBe(202)
  })
})

describe('POST /public/otp/verify', () => {
  it('a wrong code counts a try and says how many are left; the third locks the code, even for the right one afterwards', async () => {
    const { challengeId } = json(await request(PHONES.otp))
    const code = await h.codeSentTo(PHONES.otp, challengeId)
    const wrong = code === '000000' ? '111111' : '000000'
    const first = await verify(challengeId, wrong)
    expect(first.statusCode).toBe(401)
    expect(json(first)).toMatchObject({ code: 'PUBLIC_OTP_INVALID', detail: 'That code didn’t match. 2 more tries before you need a new one.', meta: { attemptsLeft: 2 } })
    expect(json(await verify(challengeId, wrong))).toMatchObject({ detail: 'That code didn’t match. 1 more try before you need a new one.', meta: { attemptsLeft: 1 } })
    const third = await verify(challengeId, wrong)
    expect(third.statusCode).toBe(429)
    expect(json(third)).toMatchObject({ code: 'PUBLIC_OTP_LOCKED', detail: 'Too many tries. Request a new code.' })
    const right = await verify(challengeId, code)
    expect(right.statusCode).toBe(429)
    expect(json(right).code).toBe('PUBLIC_OTP_LOCKED')
    const row = await h.db.selectFrom('public_otp_challenges').select(['attempts', 'consumed_reason']).where('id', '=', challengeId).executeTakeFirstOrThrow()
    expect(row).toEqual({ attempts: 3, consumed_reason: 'locked' })
    expect(await h.db.selectFrom('public_member_tokens').selectAll().execute()).toEqual([])
  })

  it('an expired code is 410, a code used once is 410, an unknown challenge is 410', async () => {
    const { challengeId } = json(await request(PHONES.otp))
    const code = await h.codeSentTo(PHONES.otp, challengeId)
    h.clock.set('2026-06-13T10:47:00-04:00')
    expect(json(await verify(challengeId, code))).toMatchObject({ code: 'PUBLIC_OTP_EXPIRED', status: 410 })
    h.clock.set('2026-06-13T10:36:00-04:00')
    const { challengeId: c2 } = json(await request(PHONES.otp))
    const code2 = await h.codeSentTo(PHONES.otp, c2)
    expect((await verify(c2, code2)).statusCode).toBe(200)
    expect((await verify(c2, code2)).statusCode).toBe(410)
    expect((await verify('00000000-0000-7000-8000-000000000000', '123456')).statusCode).toBe(410)
    expect((await verify('not-a-uuid', '123456')).statusCode).toBe(422)
  })

  it('a right code issues an opaque token (hashed at rest, 30 min) and the member view: first name, tier, washes left, active', async () => {
    const customerId = await member(PHONES.member)
    const { challengeId } = json(await request(PHONES.member))
    const r = await verify(challengeId, await h.codeSentTo(PHONES.member, challengeId))
    expect(r.statusCode, r.body).toBe(200)
    const b = json(r)
    expect(b.memberToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b.expiresInSec).toBe(1800)
    expect(b.member).toEqual({ firstName: 'Mia', tier: 'gold', washesLeft: 2, plan: 'Gold', active: true })
    expect(Object.keys(b).sort()).toEqual(['expiresInSec', 'member', 'memberToken'])
    const tok = await h.db.selectFrom('public_member_tokens').selectAll().executeTakeFirstOrThrow()
    expect(tok.token_hash).not.toBe(b.memberToken)
    expect(tok.customer_id).toBe(customerId)
    expect(tok.phone_e164).toBe(PHONES.member)
    expect(tok.expires_at.toISOString()).toBe('2026-06-13T15:06:00.000Z')
  })

  it('a number nobody has yet verifies too (no member, empty first name), and a known non-member shows no tier', async () => {
    const { challengeId } = json(await request(PHONES.otp))
    const b = json(await verify(challengeId, await h.codeSentTo(PHONES.otp, challengeId)))
    expect(b.member).toEqual({ firstName: '', tier: null, washesLeft: null, plan: null, active: false })
    await h.db.transaction().execute((tx) => upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: 'Gus Guest', phone: PHONES.guest, source: 'online' }))
    const { challengeId: c2 } = json(await request(PHONES.guest))
    expect(json(await verify(c2, await h.codeSentTo(PHONES.guest, c2))).member).toEqual({ firstName: 'Gus', tier: null, washesLeft: null, plan: null, active: false })
  })
})
