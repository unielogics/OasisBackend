// Link sessions on Postgres (ADR 0160, design sections 5 and 10): the exchange returns a bearer token stored only hashed; 15 minutes
// idle and 1 hour at most; re-exchange while the link lives, at most 5 times for a verify or PIN link; an epoch bump, a PIN change
// and a phone change end live sessions; a live 30-day trust starts the session verified.
import { describe, expect, it } from 'vitest'
import { hashToken } from '../../src/modules/auth/tokens.js'
import { updateCustomer } from '../../src/modules/customers/service.js'
import { revokeLink } from '../../src/modules/identity/links.js'
import { exchangeLink, hasFreshStepUp, requireFreshStepUp, resolveSession } from '../../src/modules/identity/sessions.js'
import { grantTrust } from '../../src/modules/identity/trust.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const MIN = 60_000

describe('exchangeLink', () => {
  it('returns a session token stored only as its SHA-256, starting at trust "link"', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'calendar' })
    expect(s.session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.session).not.toBe(s.link.token)
    const row = await w.t.db.selectFrom('client_link_sessions').selectAll().executeTakeFirstOrThrow()
    expect(row.token_hash).toBe(hashToken(s.session))
    expect(JSON.stringify(row)).not.toContain(s.session)
    expect(row).toMatchObject({ trust: 'link', verified_by: null, customer_id: maria, phone_e164: PHONES.maria, ip: '203.0.113.7' })
    expect(row.idle_expires_at.getTime() - w.clock.now().getTime()).toBe(15 * MIN)
    expect(row.expires_at.getTime() - w.clock.now().getTime()).toBe(60 * MIN)
    expect(s.view.link).toMatchObject({ kind: 'calendar', customerId: maria, uses: 0, maxUses: 3 })
    expect(s.numberTrust).toMatchObject({ trusted: false, reason: 'none' })
  })

  it('starts verified while the number’s 30-day trust is live for the link’s client', async () => {
    const maria = await w.customer({})
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, verifiedBy: 'pin', now: w.clock.now() }))
    const s = await w.session({ customerId: maria, kind: 'calendar' })
    expect(s.view).toMatchObject({ trust: 'verified', verifiedBy: 'pin', stepUpAt: null })
    expect(s.numberTrust?.trusted).toBe(true)
    // the trust does not count as a fresh step-up (memberships and payments)
    expect(hasFreshStepUp(s.view, w.clock.now())).toBe(false)
    expect(() => requireFreshStepUp(s.view, w.clock.now())).toThrow(expect.objectContaining({ code: 'IDENTITY_STEP_UP_REQUIRED' }))
  })

  it('a verify link can be exchanged 5 times; the sixth is refused like a dead link', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'verify' })
    for (let i = 0; i < 5; i++) await exchangeLink(w.t.db, { token: l.token, ip: null, now: w.clock.now() })
    await expect(exchangeLink(w.t.db, { token: l.token, ip: null, now: w.clock.now() })).rejects.toMatchObject({
      code: 'IDENTITY_LINK_INVALID',
      meta: { reason: 'used' },
    })
  })

  it('a dead link cannot be exchanged (401 with the reason)', async () => {
    const maria = await w.customer({})
    const l = await w.link({ customerId: maria, kind: 'verify' })
    w.advance(16 * MIN)
    await expect(exchangeLink(w.t.db, { token: l.token, ip: null, now: w.clock.now() })).rejects.toMatchObject({ status: 401, meta: { reason: 'expired' } })
    await expect(exchangeLink(w.t.db, { token: 'nope', ip: null, now: w.clock.now() })).rejects.toMatchObject({ status: 401, meta: { reason: 'not_found' } })
  })
})

describe('resolveSession', () => {
  it('slides the 15-minute idle window up to the 1-hour end; re-exchange works while the link lives', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'calendar' })
    for (let i = 0; i < 4; i++) {
      w.advance(14 * MIN)
      await resolveSession(w.t.db, s.session, w.clock.now())
    }
    w.advance(5 * MIN) // 61 minutes after the exchange
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    const again = await exchangeLink(w.t.db, { token: s.link.token, ip: null, now: w.clock.now() })
    expect((await resolveSession(w.t.db, again.session, w.clock.now())).link.id).toBe(s.link.id)
  })

  it('an idle session ends after 15 minutes', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'calendar' })
    w.advance(15 * MIN)
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })

  it('outlives the 15-minute verify link it came from (within its own windows), but not the link’s revocation', async () => {
    const maria = await w.customer({})
    const s = await w.session({ customerId: maria, kind: 'verify' })
    w.advance(10 * MIN)
    await resolveSession(w.t.db, s.session, w.clock.now())
    w.advance(10 * MIN) // the link expired 5 minutes ago
    await resolveSession(w.t.db, s.session, w.clock.now())
    await w.tx((tx) => revokeLink(tx, s.link.id, 'staff', w.clock.now()))
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })

  it('an epoch bump ends every live session at its next request', async () => {
    const maria = await w.customer({})
    const a = await w.session({ customerId: maria, kind: 'calendar' })
    const b = await w.session({ customerId: null, kind: 'calendar', phone: PHONES.stranger })
    await w.bumpEpoch()
    for (const s of [a, b]) await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })

  it('a phone change ends the client’s sessions; a PIN version change does too', async () => {
    const maria = await w.customer({})
    const a = await w.session({ customerId: maria, kind: 'calendar' })
    await w.tx((tx) => updateCustomer(tx, { id: maria, patch: { phone: PHONES.other } }))
    await expect(resolveSession(w.t.db, a.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    expect((await w.t.db.selectFrom('client_link_sessions').select('revoked_at').executeTakeFirstOrThrow()).revoked_at).not.toBeNull()

    const b = await w.session({ customerId: maria, kind: 'calendar' })
    await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: 'x'.repeat(30), version: 1, set_at: w.clock.now() }).execute()
    await expect(resolveSession(w.t.db, b.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })

  it('refuses a malformed or unknown token', async () => {
    await expect(resolveSession(w.t.db, 'x', w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    await expect(resolveSession(w.t.db, 'B'.repeat(43), w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
  })
})
