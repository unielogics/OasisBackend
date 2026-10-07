// Adversarial review (rv/sec): can someone below Super Admin end up with Super-only authority?
import { describe, expect, it } from 'vitest'
import { useHarness, type Harness, type Session } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const ATTACKER_PHONE = '(786) 555-0199'
const ATTACKER_E164 = '+17865550199'
const NEW_PASSWORD = 'attacker chosen passphrase'

async function versionOf(h: Harness, s: Session, employeeId: string): Promise<number> {
  const res = await h.call('GET', `employees/${employeeId}`, { session: s })
  return (res.json() as Json).version as number
}

/** The attack: point the victim's mobile at a phone the attacker holds, ask for an admin reset, use the SMS'd link. */
async function takeOver(h: Harness, attacker: Session, victim: { employeeId: string; email: string }) {
  const v = await versionOf(h, attacker, victim.employeeId)
  const put = await h.call('PUT', `employees/${victim.employeeId}`, {
    session: attacker,
    body: { phone: ATTACKER_PHONE },
    headers: { 'if-match': `"${v}"` },
  })
  const reset = await h.call('POST', `employees/${victim.employeeId}/password-reset`, { session: attacker })
  const sms = h.notifier.last('password_reset')
  let loggedInAsVictim = false
  if (sms?.phone === ATTACKER_E164) {
    const token = new URL(sms.link).searchParams.get('token')!
    const done = await h.call('POST', 'auth/password/reset', { body: { token, password: NEW_PASSWORD } })
    if (done.statusCode === 200) {
      const login = await h.t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: h.origin },
        remoteAddress: '10.77.0.1',
        payload: { email: victim.email, password: NEW_PASSWORD },
      })
      loggedInAsVictim = login.statusCode === 200
    }
  }
  return {
    editedVictimPhone: put.statusCode,
    adminReset: reset.statusCode,
    resetLinkSentToAttackerPhone: sms?.phone === ATTACKER_E164,
    loggedInAsVictim,
  }
}

describe('SEC-01 contact hijack: Management (team.edit) must not be able to become a Super Admin', () => {
  const h = useHarness()

  it('cannot take over a Super Admin by redirecting their mobile and sending an admin reset', async () => {
    const owner = await h.createUser({
      email: 'owner@example.test',
      roles: ['super'],
      phone: '(305) 555-0111',
    })
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'] })
    const session = await h.login(mgr, '10.77.0.2')

    const out = await takeOver(h, session, owner)

    expect(out).toEqual({
      editedVictimPhone: 403,
      adminReset: 200, // resetting to the owner's own, unchanged mobile is harmless
      resetLinkSentToAttackerPhone: false,
      loggedInAsVictim: false,
    })
  })

  it('cannot take over a person who holds a Super-only permission (Accounting carries set.billing and pay.void)', async () => {
    const acct = await h.createUser({
      email: 'daniel@example.test',
      roles: ['acct'],
      phone: '(305) 555-0122',
    })
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'] })
    const session = await h.login(mgr, '10.77.0.3')

    const out = await takeOver(h, session, acct)

    expect(out.resetLinkSentToAttackerPhone).toBe(false)
    expect(out.loggedInAsVictim).toBe(false)
    expect(out.editedVictimPhone).toBe(403)
  })

  it('cannot change the login email of a Super Admin either (the email is the login and a reset address)', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'] })
    const session = await h.login(mgr, '10.77.0.4')
    const v = await versionOf(h, session, owner.employeeId)
    const res = await h.call('PUT', `employees/${owner.employeeId}`, {
      session,
      body: { email: 'attacker@example.test' },
      headers: { 'if-match': `"${v}"` },
    })
    expect(res.statusCode).toBe(403)
    const login = await h.t.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', owner.userId)
      .executeTakeFirstOrThrow()
    expect(login.email).toBe('owner@example.test')
  })

  it('a Super Admin can still change anyone’s contact details, and Management can still edit an ordinary colleague', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'] })
    const crew = await h.createUser({ email: 'kai@example.test', roles: ['crew'] })
    const sup = await h.login(owner, '10.77.0.5')
    const mg = await h.login(mgr, '10.77.0.6')
    const vc = await versionOf(h, mg, crew.employeeId)
    expect(
      (
        await h.call('PUT', `employees/${crew.employeeId}`, {
          session: mg,
          body: { phone: ATTACKER_PHONE },
          headers: { 'if-match': `"${vc}"` },
        })
      ).statusCode,
    ).toBe(200)
    const am = await h.createUser({ email: 'daniel@example.test', roles: ['acct'] })
    const va = await versionOf(h, sup, am.employeeId)
    expect(
      (
        await h.call('PUT', `employees/${am.employeeId}`, {
          session: sup,
          body: { phone: ATTACKER_PHONE },
          headers: { 'if-match': `"${va}"` },
        })
      ).statusCode,
    ).toBe(200)
  })
})

describe('SEC-02 a person must not be able to lift their own per-person Deny', () => {
  const h = useHarness()

  it('Management cannot clear the Deny a Super Admin put on them, nor grant themselves an exception', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'] })
    const sup = await h.login(owner, '10.78.0.1')
    const mg = await h.login(mgr, '10.78.0.2')

    // the owner restricts Management's refunding after an incident
    const v1 = await versionOf(h, sup, mgr.employeeId)
    const deny = await h.call('PUT', `employees/${mgr.employeeId}`, {
      session: sup,
      body: { overrides: { 'pay.refund': 'deny' } },
      headers: { 'if-match': `"${v1}"` },
    })
    expect(deny.statusCode).toBe(200)
    const can = async () =>
      ((await h.call('GET', 'me', { session: mg })).json() as Json).permissions['pay.refund'].on
    expect(await can()).toBe(false)

    // the restricted person edits their own exceptions
    const v2 = await versionOf(h, mg, mgr.employeeId)
    const lift = await h.call('PUT', `employees/${mgr.employeeId}`, {
      session: mg,
      body: { overrides: {} },
      headers: { 'if-match': `"${v2}"` },
    })

    expect({ status: lift.statusCode, refundAllowedAgain: await can() }).toEqual({
      status: 403,
      refundAllowedAgain: false,
    })
  })
})
