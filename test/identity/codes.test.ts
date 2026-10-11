// Step-up codes of a link session (ADR 0160, design sections 5 and 10): the code goes to the link's number and nowhere else (no
// phone input exists), shares the website's hourly ceiling, counts wrong tries against both the code (3) and the page (5); a
// confirmed link_verify code verifies the page and trusts the number 30 days; a PIN outranks a code once set.
import { describe, expect, it } from 'vitest'
import { confirmStepUpCode, requestStepUpCode, type StepUpPurpose } from '../../src/modules/identity/codes.js'
import { resolveSession } from '../../src/modules/identity/sessions.js'
import { evaluateTrust } from '../../src/modules/identity/trust.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const MIN = 60_000
let ipN = 0
const ip = () => `198.51.100.${++ipN % 250}`

async function codeFlow(session: string, purpose: StepUpPurpose) {
  const r = await requestStepUpCode(w.d, { session, purpose, ip: ip() })
  const code = await w.lastCode(r.challengeId)
  return confirmStepUpCode(w.d, { session, challengeId: r.challengeId, code, ip: ip() })
}

describe('requestStepUpCode', () => {
  it('texts the link’s number only: the caller has no way to name another one', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'verify' })
    // a stray phone in the input (what a request body could carry) is not read
    const r = await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip(), phone: PHONES.other } as never)
    expect(w.queue.calls).toHaveLength(1)
    expect(w.queue.calls[0]).toMatchObject({ templateKey: 'otp_code', customerId: null, recipient: { phone: PHONES.maria } })
    const row = await w.t.db.selectFrom('public_otp_challenges').selectAll().where('id', '=', r.challengeId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ phone_e164: PHONES.maria, purpose: 'link_verify', link_session_hash: s.view.tokenHash, delivery: 'queued' })
    // the outbox has the text to the link's number; the message row never shows the code
    const out = await w.t.db.selectFrom('sms_outbox').select(['to_e164']).execute()
    expect(out.map((o) => o.to_e164)).toEqual([PHONES.maria])
    const code = await w.lastCode(r.challengeId)
    const msgs = await w.t.db.selectFrom('messages').select('body').execute()
    for (const m of msgs) expect(m.body).not.toContain(code)
    expect(row.code_hash).not.toContain(code)
  })

  it('a stranger’s link texts the stranger’s number', async () => {
    const s = await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })
    expect(w.queue.calls[0]!.recipient.phone).toBe(PHONES.stranger)
  })

  it('shares PUBLIC_OTP_TEXTS_PER_HOUR with the website’s codes', async () => {
    const maria = await w.customer({})
    await w.manager()
    const d = { ...w.d, otpTextsPerHour: 2 }
    await w.t.db
      .insertInto('public_otp_challenges')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: PHONES.liam, code_hash: 'x', expires_at: new Date(w.clock.now().getTime() + 10 * MIN), delivery: 'queued', created_at: w.clock.now() })
      .execute()
    const s = await w.session({ customerId: maria, kind: 'verify' })
    await requestStepUpCode(d, { session: s.session, purpose: 'link_verify', ip: ip() })
    await expect(requestStepUpCode(d, { session: s.session, purpose: 'link_verify', ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_CODES_PAUSED' })
    expect(await w.t.db.selectFrom('notifications').select('kind').execute()).toEqual([{ kind: 'public.otp_cap_reached' }])
  })

  it('limits a page to 3 codes in 10 minutes', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'verify' })
    for (let i = 0; i < 3; i++) await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })
    await expect(requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_RATE_LIMITED' })
  })

  it('refuses a verify code once a PIN exists (a PIN outranks a code), and the PIN purposes where they do not apply', async () => {
    const stranger = await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    await expect(requestStepUpCode(w.d, { session: stranger.session, purpose: 'pin_set', ip: ip() })).rejects.toMatchObject({ code: 'IDENTITY_UNKNOWN_CLIENT' })
    const maria = await w.customer({})
    let s = await w.session({ customerId: maria, kind: 'verify' })
    await expect(requestStepUpCode(w.d, { session: s.session, purpose: 'pin_reset', ip: ip() })).rejects.toMatchObject({ code: 'IDENTITY_PIN_NOT_SET' })
    await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: await w.d.pins.hash(maria, '4831'), version: 1, set_at: w.clock.now() }).execute()
    s = await w.session({ customerId: maria, kind: 'verify' })
    await expect(requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })).rejects.toMatchObject({ code: 'IDENTITY_PIN_REQUIRED' })
    await expect(requestStepUpCode(w.d, { session: s.session, purpose: 'pin_set', ip: ip() })).rejects.toMatchObject({ code: 'IDENTITY_PIN_EXISTS' })
    await requestStepUpCode(w.d, { session: s.session, purpose: 'pin_reset', ip: ip() })
  })
})

describe('confirmStepUpCode', () => {
  it('a link_verify code verifies the page (step-up now) and trusts the number for the link’s client 30 days', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'verify' })
    const r = await codeFlow(s.session, 'link_verify')
    expect(r).toMatchObject({ verified: true, purpose: 'link_verify', session: { trust: 'verified', verifiedBy: 'code', stepUpAt: w.clock.now() } })
    const trust = await evaluateTrust(w.t.db, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, now: w.clock.now() })
    expect(trust).toMatchObject({ trusted: true, verifiedBy: 'code', until: new Date(w.clock.now().getTime() + 30 * 24 * 60 * MIN) })
  })

  it('a stranger’s page is verified but no trust is recorded (there is no client to trust)', async () => {
    const s = await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    expect((await codeFlow(s.session, 'link_verify')).verified).toBe(true)
    expect(await w.t.db.selectFrom('phone_trust').selectAll().execute()).toEqual([])
  })

  it('a pin_reset code verifies nothing by itself', async () => {
    const maria = await w.customer({})
    await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: await w.d.pins.hash(maria, '4831'), version: 1, set_at: w.clock.now() }).execute()
    const s = await w.session({ customerId: maria, kind: 'pin' })
    const r = await codeFlow(s.session, 'pin_reset')
    expect(r).toMatchObject({ verified: false, session: { trust: 'link' } })
    expect(await w.t.db.selectFrom('phone_trust').selectAll().execute()).toEqual([])
  })

  it('a code set meanwhile by a PIN verifies nothing (a PIN outranks a code)', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'verify' })
    const r = await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })
    const code = await w.lastCode(r.challengeId)
    // a PIN appears meanwhile (the link re-bound to it, as a PIN set from this very page would do)
    await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: await w.d.pins.hash(maria, '4831'), version: 1, set_at: w.clock.now() }).execute()
    await w.t.db.updateTable('client_links').set({ pin_version: 1 }).execute()
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: r.challengeId, code, ip: ip() })).rejects.toMatchObject({ code: 'IDENTITY_PIN_REQUIRED' })
    expect((await resolveSession(w.t.db, s.session, w.clock.now())).trust).toBe('link')
  })

  it('three wrong codes lock the code, and five wrong entries end the page', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'verify' })
    const a = await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })
    const right = await w.lastCode(a.challengeId)
    const wrong = right === '000000' ? '111111' : '000000'
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: a.challengeId, code: wrong, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_INVALID', meta: { attemptsLeft: 2 } })
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: a.challengeId, code: wrong, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_INVALID', meta: { attemptsLeft: 1 } })
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: a.challengeId, code: wrong, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_LOCKED' })
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: a.challengeId, code: right, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_LOCKED' })
    const b = await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: ip() })
    const right2 = await w.lastCode(b.challengeId)
    const wrong2 = right2 === '000000' ? '111111' : '000000'
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: b.challengeId, code: wrong2, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_INVALID', meta: { attemptsLeft: 1 } })
    await expect(confirmStepUpCode(w.d, { session: s.session, challengeId: b.challengeId, code: wrong2, ip: ip() })).rejects.toMatchObject({ code: 'IDENTITY_SESSION_LOCKED' })
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })

  it('a code another page asked for, or the website asked for, is unknown here; an expired one is refused', async () => {
    const maria = await w.customer({})
    const a = await w.session({ customerId: maria, kind: 'calendar' })
    const b = await w.session({ customerId: maria, kind: 'verify' })
    const r = await requestStepUpCode(w.d, { session: a.session, purpose: 'link_verify', ip: ip() })
    const code = await w.lastCode(r.challengeId)
    await expect(confirmStepUpCode(w.d, { session: b.session, challengeId: r.challengeId, code, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_EXPIRED' })
    w.advance(10 * MIN)
    await expect(confirmStepUpCode(w.d, { session: a.session, challengeId: r.challengeId, code, ip: ip() })).rejects.toMatchObject({ code: 'PUBLIC_OTP_EXPIRED' })
  })
})
