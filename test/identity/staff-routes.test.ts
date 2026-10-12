// The identity core's staff routes over HTTP (ADR 0160, design section 8): the masked identity state of a client, Clear PIN and
// Revoke trust (cli.edit, audited); no token, hash or full number in any answer. The authz matrix covers the permissions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { identityModule } from '../../src/modules/identity/http/module.js'
import { resolveSession } from '../../src/modules/identity/sessions.js'
import { evaluateTrust, grantTrust } from '../../src/modules/identity/trust.js'
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

const call = (method: 'GET' | 'POST', url: string, body: unknown = {}) =>
  app.app.inject({ method, url, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, payload: method === 'POST' ? JSON.stringify(body) : undefined })

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

describe('POST /identity/links/kill (the links kill switch, W4c fixes B4)', () => {
  it('bumps the links epoch: every link, page and trust issued before ends; audited with the reason; needs a reason', async () => {
    const { s } = await setup()
    expect((await call('POST', '/api/v1/identity/links/kill', {})).statusCode).toBe(422)
    const r = await call('POST', '/api/v1/identity/links/kill', { reason: 'lost tablet' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ epochBefore: 1, epoch: 2 })
    await expect(resolveSession(w.t.db, s.session, w.clock.now())).rejects.toMatchObject({ code: 'IDENTITY_SESSION_INVALID' })
    expect(await evaluateTrust(w.t.db, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() })).toMatchObject({ trusted: false, reason: 'epoch' })
    const audit = await w.t.db.selectFrom('audit_log').select(['action', 'after']).where('action', 'in', ['identity.links.killed', 'settings.update']).orderBy('action').execute()
    expect(audit).toEqual([
      { action: 'identity.links.killed', after: { epoch: 2, reason: 'lost tablet' } },
      { action: 'settings.update', after: 2 },
    ])
    expect((await call('POST', '/api/v1/identity/links/kill', { reason: 'again' })).json()).toEqual({ epochBefore: 2, epoch: 3 })
  })

  it('is owner level: it needs both Billing & integrations and Roles (a Super Admin)', () => {
    const route = app.app.routeRegistry.find((x) => x.method === 'POST' && x.url === '/api/v1/identity/links/kill')
    expect(route?.access).toEqual({ kind: 'permission', perms: ['set.billing', 'team.roles'], mode: 'all' })
  })
})

describe('POST /customers/:id/identity/confirm (staff confirm the number, W4c fixes B1)', () => {
  it('ends the stale-record rule for the client (a staff action is proof of them); audited', async () => {
    const maria = await w.customer({ createdAt: new Date(w.clock.now().getTime() - 300 * 86_400_000) })
    expect((await call('GET', `/api/v1/customers/${maria}/identity`)).json().stale).toMatchObject({ stale: true, reason: 'inactive' })
    const r = await call('POST', `/api/v1/customers/${maria}/identity/confirm`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().stale).toMatchObject({ stale: false, lastActivityAt: w.clock.now().toISOString() })
    expect(await w.t.db.selectFrom('audit_log').select(['action', 'entity_id']).where('action', '=', 'identity.client.confirmed').execute()).toEqual([
      { action: 'identity.client.confirmed', entity_id: maria },
    ])
    const nophone = await w.customer({ name: 'No Phone', phone: null })
    expect((await call('POST', `/api/v1/customers/${nophone}/identity/confirm`)).statusCode).toBe(422)
  })
})
