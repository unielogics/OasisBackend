// The PIN on a link page (ADR 0160, design sections 5 and 10): a wrong PIN and a PIN where none exists answer alike and cost the
// same work; per page 5 tries; the lockout schedule 5 -> 15 min, +3 -> 1 h, +3 -> disabled (staff notified); at most 10 wrong a day
// per client and 20 an hour per address; a PIN is set only after a code on the same page, passes the blocklist and kills the client's
// other links; a reset needs a reset code, holds member privileges 72 h, emails the client and tells the managers; staff can clear.
import { describe, expect, it, vi } from 'vitest'
import { PasswordHasher } from '../../src/modules/auth/password.js'
import { confirmStepUpCode, requestStepUpCode, type StepUpPurpose } from '../../src/modules/identity/codes.js'
import { resolveLink } from '../../src/modules/identity/links.js'
import {
  clearCustomerPin,
  memberPrivilegesHeldUntil,
  resetSessionPin,
  setSessionPin,
  verifySessionPin,
} from '../../src/modules/identity/pin-service.js'
import { exchangeLink, resolveSession } from '../../src/modules/identity/sessions.js'
import { evaluateTrust, grantTrust } from '../../src/modules/identity/trust.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const MIN = 60_000
const PIN = '4831'
let ipN = 0
const ip = () => `198.51.100.${++ipN % 250}`

async function givePin(customerId: string, pin = PIN): Promise<void> {
  await w.t.db.insertInto('customer_pins').values({ customer_id: customerId, pin_hash: await w.d.pins.hash(customerId, pin), version: 1, set_at: w.clock.now() }).execute()
}

async function codeFlow(session: string, purpose: StepUpPurpose) {
  const r = await requestStepUpCode(w.d, { session, purpose, ip: ip() })
  const code = await w.lastCode(r.challengeId)
  return confirmStepUpCode(w.d, { session, challengeId: r.challengeId, code, ip: ip() })
}

const tryPin = (session: string, pin: string, from = '203.0.113.50') => verifySessionPin(w.d, { session, pin, ip: from })
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: { code: string; status: number; detail: string; meta?: unknown }) => e)

describe('verifySessionPin', () => {
  it('a right PIN verifies the page by PIN (step-up now), trusts the number 30 days and clears the consecutive count', async () => {
    const maria = await w.customer({})
    await givePin(maria)
    const s = await w.session({ customerId: maria, kind: 'calendar' })
    await expect(tryPin(s.session, '9372')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    const v = await tryPin(s.session, PIN)
    expect(v).toMatchObject({ trust: 'verified', verifiedBy: 'pin', stepUpAt: w.clock.now() })
    expect(await evaluateTrust(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toMatchObject({ trusted: true, verifiedBy: 'pin', customerId: maria })
    expect((await w.t.db.selectFrom('customer_pins').select(['failed_attempts', 'lock_level']).executeTakeFirstOrThrow())).toEqual({ failed_attempts: 0, lock_level: 0 })
    expect((await w.t.db.selectFrom('audit_log').select('action').where('action', '=', 'identity.pin.verified').execute())).toHaveLength(1)
  })

  it('a wrong PIN, a PIN where the client has none and a stranger’s page answer alike, after the same scrypt work', async () => {
    const withPin = await w.customer({})
    await givePin(withPin)
    const without = await w.customer({ name: 'Liam Chen', phone: PHONES.liam })
    const a = await w.session({ customerId: withPin, kind: 'calendar' })
    const b = await w.session({ customerId: without, kind: 'calendar' })
    const c = await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    const spy = vi.spyOn(PasswordHasher.prototype, 'verify')
    const errors = []
    for (const s of [a, b, c]) {
      spy.mockClear()
      errors.push(await errorOf(tryPin(s.session, '9372')))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]![1].split('$')[2]).toBe('ln=6,r=8,p=1')
    }
    spy.mockRestore()
    const shape = (e: { code: string; status: number; detail: string; meta?: unknown } | null) => ({ code: e?.code, status: e?.status, detail: e?.detail, meta: e?.meta })
    expect(shape(errors[1]!)).toEqual(shape(errors[0]!))
    expect(shape(errors[2]!)).toEqual(shape(errors[0]!))
    expect(shape(errors[0]!)).toEqual({ code: 'IDENTITY_PIN_INVALID', status: 401, detail: 'That PIN didn’t match. 4 more tries on this page.', meta: { attemptsLeft: 4 } })
  })

  it('the fifth wrong entry of a page ends it, with or without a PIN', async () => {
    for (const hasPin of [true, false]) {
      const c = await w.customer({ name: hasPin ? 'A B' : 'C D', phone: hasPin ? PHONES.maria : PHONES.liam })
      if (hasPin) await givePin(c)
      const s = await w.session({ customerId: c, kind: 'calendar' })
      for (let left = 4; left >= 1; left--) await expect(tryPin(s.session, '9372')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID', meta: { attemptsLeft: left } })
      await expect(tryPin(s.session, '9372')).rejects.toMatchObject({ code: 'IDENTITY_SESSION_LOCKED', status: 429 })
      await expect(tryPin(s.session, PIN)).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    }
  })

  it('follows the lockout schedule: 5 wrong -> 15 min, 3 more -> 1 h, 3 more -> disabled until reset (managers told); 10 a day at most', async () => {
    const maria = await w.customer({})
    await w.manager()
    await givePin(maria)
    const link = await w.link({ customerId: maria, kind: 'calendar' })
    const page = async () => (await exchangeLink(w.t.db, { token: link.token, ip: null, now: w.clock.now() })).session
    const wrong = async (n: number) => {
      let s = await page()
      for (let i = 0; i < n; i++) {
        const e = await errorOf(tryPin(s, '9372'))
        if (e?.code === 'IDENTITY_SESSION_LOCKED') s = await page()
      }
      return s
    }
    let s = await wrong(5)
    s = await page()
    await expect(tryPin(s, PIN)).rejects.toMatchObject({ code: 'IDENTITY_PIN_LOCKED', headers: { 'Retry-After': '900' } })
    w.advance(15 * MIN)
    await wrong(3)
    s = await page()
    await expect(tryPin(s, PIN)).rejects.toMatchObject({ code: 'IDENTITY_PIN_LOCKED', headers: { 'Retry-After': '3600' } })
    expect((await w.t.db.selectFrom('customer_pins').select('lock_level').executeTakeFirstOrThrow()).lock_level).toBe(2)
    w.advance(60 * MIN)
    await wrong(2) // 10 wrong within 24 hours: the daily ceiling holds even the right PIN
    s = await page()
    const daily = await errorOf(tryPin(s, PIN))
    expect(daily).toMatchObject({ code: 'IDENTITY_PIN_LOCKED' })
    w.advance(24 * 60 * MIN - 75 * MIN + MIN) // the first five leave the 24 hours
    s = await page()
    await expect(tryPin(s, '9372')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' }) // the 11th consecutive wrong PIN
    expect(await w.t.db.selectFrom('customer_pins').select(['lock_level', 'locked_until']).executeTakeFirstOrThrow()).toEqual({ lock_level: 3, locked_until: null })
    await expect(tryPin(s, PIN)).rejects.toMatchObject({ code: 'IDENTITY_PIN_DISABLED', status: 423 })
    const notes = await w.t.db.selectFrom('notifications').select(['kind', 'title']).execute()
    expect(notes).toEqual([{ kind: 'identity.pin_disabled', title: 'Website PIN locked: Maria Delgado' }])
    const actions = (await w.t.db.selectFrom('audit_log').select('action').orderBy('id').execute()).map((r) => r.action)
    expect(actions.filter((a) => a.startsWith('identity.pin.'))).toEqual(['identity.pin.locked', 'identity.pin.locked', 'identity.pin.disabled'])
  })

  it('a right PIN between wrong ones does not reset the 24-hour count', async () => {
    const maria = await w.customer({})
    await givePin(maria)
    const link = await w.link({ customerId: maria, kind: 'calendar' })
    for (let round = 0; round < 2; round++) {
      const s = (await exchangeLink(w.t.db, { token: link.token, ip: null, now: w.clock.now() })).session
      for (let i = 0; i < 4; i++) await expect(tryPin(s, '9372')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
      await tryPin(s, PIN)
    }
    const s = (await exchangeLink(w.t.db, { token: link.token, ip: null, now: w.clock.now() })).session
    await expect(tryPin(s, '9372')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    await expect(tryPin(s, '9372')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    await expect(tryPin(s, PIN)).rejects.toMatchObject({ code: 'IDENTITY_PIN_LOCKED' })
  })

  it('an IPv6 client is one address per /64: 20 wrong PINs from addresses of one prefix, then 429 (W4c fixes P8)', async () => {
    const pages = []
    for (let i = 0; i < 5; i++) pages.push((await w.session({ customerId: null, kind: 'calendar', phone: `+1201555012${i}` })).session)
    let n = 0
    for (const p of pages)
      for (let i = 0; i < 4 && n < 20; i++, n++) await expect(tryPin(p, '9372', `2001:db8:1:2:${n.toString(16)}::1`)).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    await expect(tryPin(pages[4]!, '9372', '2001:db8:1:2:ffff:ffff:ffff:fffe')).rejects.toMatchObject({ code: 'IDENTITY_TOO_MANY_TRIES', status: 429 })
    // another /64 is another client; the rows keep the prefix, never the full address
    const other = (await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })).session
    await expect(tryPin(other, '9372', '2001:db8:1:3::1')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    const stored = (await w.t.db.selectFrom('identity_pin_failures').select('ip').where('ip', 'like', '2001:db8:%').execute()).map((r) => r.ip)
    expect(new Set(stored)).toEqual(new Set(['2001:db8:1:2::/64', '2001:db8:1:3::/64']))
  })

  it('an address gets 20 wrong PINs an hour, whatever the numbers; another address is unaffected', async () => {
    const pages = []
    for (let i = 0; i < 5; i++) pages.push((await w.session({ customerId: null, kind: 'calendar', phone: `+1201555012${i}` })).session)
    let n = 0
    for (const p of pages)
      for (let i = 0; i < 4 && n < 20; i++, n++) await expect(tryPin(p, '9372', '192.0.2.1')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    await expect(tryPin(pages[4]!, '9372', '192.0.2.1')).rejects.toMatchObject({ code: 'IDENTITY_TOO_MANY_TRIES', status: 429 })
    const other = (await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })).session
    await expect(tryPin(other, '9372', '192.0.2.2')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
    w.advance(60 * MIN)
    const fresh = (await w.session({ customerId: null, kind: 'calendar', phone: PHONES.other })).session
    await expect(tryPin(fresh, '9372', '192.0.2.1')).rejects.toMatchObject({ code: 'IDENTITY_PIN_INVALID' })
  })
})

describe('setSessionPin', () => {
  it('needs a code confirmed on this page within 10 minutes', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'pin' })
    await expect(setSessionPin(w.d, { session: s.session, pin: PIN, ip: null })).rejects.toMatchObject({ code: 'IDENTITY_CODE_REQUIRED' })
    await codeFlow(s.session, 'pin_set')
    w.advance(10 * MIN + 1000)
    await resolveSession(w.t.db, s.session, w.clock.now())
    await expect(setSessionPin(w.d, { session: s.session, pin: PIN, ip: null })).rejects.toMatchObject({ code: 'IDENTITY_CODE_REQUIRED' })
    // a code confirmed on another page of the same client does not count
    const other = await w.session({ customerId: maria, kind: 'calendar' })
    await codeFlow(other.session, 'pin_set')
    await expect(setSessionPin(w.d, { session: s.session, pin: PIN, ip: null })).rejects.toMatchObject({ code: 'IDENTITY_CODE_REQUIRED' })
  })

  it('refuses a blocked PIN and keeps the PIN hashed; the page stays alive, every other link and page of the client dies', async () => {
    const maria = await w.customer({})
    const other = await w.session({ customerId: maria, kind: 'calendar' })
    const s = await w.session({ customerId: maria, kind: 'pin' })
    await codeFlow(s.session, 'pin_set')
    await expect(setSessionPin(w.d, { session: s.session, pin: '0111', ip: null })).rejects.toMatchObject({ code: 'IDENTITY_PIN_REJECTED', status: 422, detail: 'Don’t use the end of your phone number.' })
    await expect(setSessionPin(w.d, { session: s.session, pin: '1234', ip: null })).rejects.toMatchObject({ code: 'IDENTITY_PIN_REJECTED' })
    const v = await setSessionPin(w.d, { session: s.session, pin: PIN, ip: null })
    expect(v).toMatchObject({ trust: 'verified', verifiedBy: 'code' })
    const row = await w.t.db.selectFrom('customer_pins').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({ version: 1, lock_level: 0, cleared_at: null, reset_hold_until: null })
    expect(row.pin_hash).not.toContain(PIN)
    expect(await w.d.pins.verify(maria, PIN, row.pin_hash!)).toBe(true)
    await resolveSession(w.t.db, s.session, w.clock.now())
    await expect(resolveSession(w.t.db, other.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    expect(await resolveLink(w.t.db, other.link.token, w.clock.now())).toEqual({ ok: false, reason: 'revoked' })
    expect((await w.t.db.selectFrom('client_links').select('revoke_reason').where('id', '=', other.link.id).executeTakeFirstOrThrow()).revoke_reason).toBe('pin_set')
    await expect(setSessionPin(w.d, { session: s.session, pin: '5926', ip: null })).rejects.toMatchObject({ code: 'IDENTITY_PIN_EXISTS' })
    // the new PIN works on a new link; the trust granted by the code stays
    const fresh = await w.session({ customerId: maria, kind: 'calendar' })
    expect((await tryPin(fresh.session, PIN)).verifiedBy).toBe('pin')
  })
})

describe('resetSessionPin', () => {
  it('needs a pin_reset code of this page; resets a disabled PIN, ends the other links, pages and trust, holds member privileges 72 h, emails and tells the managers', async () => {
    const maria = await w.customer({ email: 'maria@example.test' })
    await w.manager()
    await givePin(maria)
    await w.t.db.updateTable('customer_pins').set({ lock_level: 3, failed_attempts: 11 }).execute()
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, verifiedBy: 'pin', now: w.clock.now() }))
    const other = await w.session({ customerId: maria, kind: 'calendar' })
    const s = await w.session({ customerId: maria, kind: 'pin' })
    await expect(resetSessionPin(w.d, { session: s.session, pin: '5926', ip: null })).rejects.toMatchObject({ code: 'IDENTITY_CODE_REQUIRED' })
    await codeFlow(s.session, 'pin_reset')
    const r = await resetSessionPin(w.d, { session: s.session, pin: '5926', ip: null })
    const hold = new Date(w.clock.now().getTime() + 72 * 60 * MIN)
    expect(r).toMatchObject({ trust: 'verified', verifiedBy: 'code', resetHoldUntil: hold })
    expect(await memberPrivilegesHeldUntil(w.t.db, maria, w.clock.now())).toEqual(hold)
    const row = await w.t.db.selectFrom('customer_pins').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({ version: 2, lock_level: 0, failed_attempts: 0, locked_until: null })
    expect(await w.d.pins.verify(maria, '5926', row.pin_hash!)).toBe(true)
    expect(await w.d.pins.verify(maria, PIN, row.pin_hash!)).toBe(false)
    await expect(resolveSession(w.t.db, other.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    expect((await w.t.db.selectFrom('client_links').select('revoke_reason').where('id', '=', other.link.id).executeTakeFirstOrThrow()).revoke_reason).toBe('pin_reset')
    // the old trust ended with the reset; the reset's code trusts the number again
    expect(await evaluateTrust(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toMatchObject({ trusted: true, verifiedBy: 'code' })
    const mail = await w.t.db.selectFrom('outbox_emails').select(['to_email', 'template', 'vars', 'customer_id']).execute()
    expect(mail).toHaveLength(1)
    expect(mail[0]).toMatchObject({ to_email: 'maria@example.test', template: 'pin_reset_notice', customer_id: maria })
    expect(mail[0]!.vars).toMatchObject({ phoneLast4: '0111', customerName: 'Maria', changedLabel: 'on Sat, Jun 13 at 10:36 AM', holdLabel: 'Tue, Jun 16 at 10:36 AM' })
    expect(JSON.stringify(mail[0]!.vars)).not.toContain('5926')
    expect(await w.t.db.selectFrom('notifications').select(['kind', 'entity_id']).execute()).toEqual([{ kind: 'identity.pin_reset', entity_id: maria }])
    w.advance(72 * 60 * MIN)
    expect(await memberPrivilegesHeldUntil(w.t.db, maria, w.clock.now())).toBeNull()
  })

  it('a reset code confirmed before the current PIN was set does not count', async () => {
    const maria = await w.customer({})
    await givePin(maria)
    const s = await w.session({ customerId: maria, kind: 'pin' })
    await codeFlow(s.session, 'pin_reset')
    await w.t.db.updateTable('customer_pins').set({ set_at: new Date(w.clock.now().getTime() + 1000) }).execute()
    await expect(resetSessionPin(w.d, { session: s.session, pin: '5926', ip: null })).rejects.toMatchObject({ code: 'IDENTITY_CODE_REQUIRED' })
  })
})

describe('clearCustomerPin (staff)', () => {
  it('removes the PIN and ends the client’s links, pages, trust; a second clear changes nothing', async () => {
    const maria = await w.customer({})
    await givePin(maria)
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, verifiedBy: 'pin', now: w.clock.now() }))
    const s = await w.session({ customerId: maria, kind: 'calendar' })
    expect(await w.tx((tx) => clearCustomerPin(tx, { locationId: w.locationId, customerId: maria, now: w.clock.now() }))).toBe(true)
    expect(await w.t.db.selectFrom('customer_pins').select(['pin_hash', 'version']).executeTakeFirstOrThrow()).toEqual({ pin_hash: null, version: 2 })
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    expect((await w.t.db.selectFrom('client_links').select('revoke_reason').executeTakeFirstOrThrow()).revoke_reason).toBe('pin_cleared')
    expect(await evaluateTrust(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toMatchObject({ trusted: false, reason: 'revoked', revokeReason: 'pin_cleared' })
    expect(await w.tx((tx) => clearCustomerPin(tx, { locationId: w.locationId, customerId: maria, now: w.clock.now() }))).toBe(false)
    // the client verifies by code again and may create a new PIN
    const again = await w.session({ customerId: maria, kind: 'pin' })
    await codeFlow(again.session, 'pin_set')
    expect((await setSessionPin(w.d, { session: again.session, pin: '5926', ip: null })).trust).toBe('verified')
    expect((await w.t.db.selectFrom('customer_pins').select('version').executeTakeFirstOrThrow()).version).toBe(3)
  })
})
