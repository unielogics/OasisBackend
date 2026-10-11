// The identity core's staff routes over HTTP (ADR 0160, design section 8): the masked identity state of a client, Clear PIN and
// Revoke trust (cli.edit, audited); no token, hash or full number in any answer. The authz matrix covers the permissions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { identityModule } from '../../src/modules/identity/http/module.js'
import { grantTrust } from '../../src/modules/identity/trust.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
let app: TestApp

beforeAll(async () => {
  app = await createTestApp({ testDb: w.t, modules: [identityModule] })
})
afterAll(async () => {
  await app?.close()
})

const call = (method: 'GET' | 'POST', url: string) => app.app.inject({ method, url, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, payload: method === 'POST' ? '{}' : undefined })

async function setup() {
  const maria = await w.customer({})
  await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: await w.d.pins.hash(maria, '4831'), version: 1, set_at: w.clock.now() }).execute()
  await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, verifiedBy: 'pin', now: w.clock.now() }))
  const s = await w.session({ customerId: maria, kind: 'calendar' })
  return { maria, s }
}

describe('GET /customers/:id/identity', () => {
  it('shows the PIN status, the trust, live links and pages, masked; nothing secret', async () => {
    const { maria, s } = await setup()
    const r = await call('GET', `/api/v1/customers/${maria}/identity`)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({
      customerId: maria,
      phone: '+1******0111',
      pin: { status: 'set', setAt: w.clock.now().toISOString(), lockedUntil: null, resetHoldUntil: null },
      trust: { trusted: true, verifiedBy: 'pin', until: new Date(w.clock.now().getTime() + 30 * 86_400_000).toISOString(), reason: null },
      links: { live: 1, byKind: { calendar: 1 } },
      sessions: { live: 1 },
      pendingAction: null,
      stale: { stale: false, reason: null },
    })
    for (const secret of [s.link.token, s.session, PHONES.maria]) expect(r.body).not.toContain(secret)
    expect(r.body).not.toMatch(/\$scrypt\$/)
  })

  it('answers 404 for an unknown client', async () => {
    expect((await call('GET', `/api/v1/customers/${w.newId()}/identity`)).statusCode).toBe(404)
  })
})

describe('POST /customers/:id/identity/pin/clear and /trust/revoke', () => {
  it('clear PIN: the PIN goes, links, pages and trust end; audited with the staff member', async () => {
    const { maria } = await setup()
    const r = await call('POST', `/api/v1/customers/${maria}/identity/pin/clear`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({
      pin: { status: 'cleared' },
      trust: { trusted: false, reason: 'revoked', revokeReason: 'pin_cleared' },
      links: { live: 0 },
      sessions: { live: 0 },
    })
    const audit = await w.t.db.selectFrom('audit_log').select(['action', 'entity_id', 'actor_name']).where('action', '=', 'identity.pin.cleared').execute()
    expect(audit).toHaveLength(1)
    expect(audit[0]!.entity_id).toBe(maria)
    // a second clear changes nothing and is not audited again
    expect((await call('POST', `/api/v1/customers/${maria}/identity/pin/clear`)).statusCode).toBe(200)
    expect(await w.t.db.selectFrom('audit_log').select('action').where('action', '=', 'identity.pin.cleared').execute()).toHaveLength(1)
  })

  it('revoke trust: the number must verify again; pages end, links stay', async () => {
    const { maria } = await setup()
    const r = await call('POST', `/api/v1/customers/${maria}/identity/trust/revoke`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ pin: { status: 'set' }, trust: { trusted: false, revokeReason: 'staff' }, links: { live: 1 }, sessions: { live: 0 } })
    expect(await w.t.db.selectFrom('audit_log').select('action').where('action', '=', 'identity.trust.revoked').execute()).toHaveLength(1)
    expect((await call('POST', `/api/v1/customers/${w.newId()}/identity/trust/revoke`)).statusCode).toBe(404)
  })
})
