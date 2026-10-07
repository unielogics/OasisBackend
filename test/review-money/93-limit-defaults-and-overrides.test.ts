// Held invariants of the per-transaction limits (backend.md 4.3 / ADR 0010, 0051): a role that grants a permission without a
// role_limits row gets 2500 cents for adjust and credit as well as refund; a per-person Allow with no granting role also gets
// the default; a Deny beats everything; roles union to the highest limit among the roles that grant the permission.
import { describe, expect, it } from 'vitest'
import { makeInvoice, addEvent } from '../payments/helpers.js'
import { freshKey, usePayHarness } from '../payments/http.js'

const p = usePayHarness()

async function as(session: { cookie: string; csrf: string }, url: string, body: unknown) {
  return p.h.call('POST', url, { session, body, headers: { 'idempotency-key': freshKey() } })
}

describe('limit defaults and overrides', () => {
  it('adjust and credit with no limit row: 25.00 passes, 25.01 is blocked', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 30000 }] })
    const { session } = await p.h.userWithPermissions(['pay.adjust', 'pay.credit', 'pay.reports'], 'norow2@example.test')
    expect((await as(session, `invoices/${inv.id}/adjustments`, { kind: 'discount', unit: '$', value: 2500 })).statusCode).toBe(201)
    const over = await as(session, `invoices/${inv.id}/adjustments`, { kind: 'discount', unit: '$', value: 2501 })
    expect(over.statusCode).toBe(422)
    expect(over.json()).toMatchObject({ code: 'OVER_LIMIT' })
    expect((await as(session, `invoices/${inv.id}/credits`, { amountCents: 2500, expiry: 'none' })).statusCode).toBe(201)
    expect((await as(session, `invoices/${inv.id}/credits`, { amountCents: 2501, expiry: 'none' })).statusCode).toBe(422)
    // the percent form is measured on the pre-tax amount: 8.34% of 300.00 = 25.02
    expect((await as(session, `invoices/${inv.id}/adjustments`, { kind: 'discount', unit: '%', value: 834 })).statusCode).toBe(422)
    expect((await as(session, `invoices/${inv.id}/adjustments`, { kind: 'discount', unit: '%', value: 833 })).statusCode).toBe(201)
  })

  it('a per-person Allow without a granting role gets the default; a Deny removes a granted permission', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 30000 }] })
    await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 32100, method: 'Visa', methodKind: 'card', processorState: 'confirmed' })
    const crew = await p.h.createUser({ email: 'crew-allow@example.test', roles: ['crew'], overrides: { 'pay.refund': 'allow' } })
    const crewSession = await p.h.login(crew, '10.9.9.9')
    const ok = await as(crewSession, `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 2500, dest: 'cash' })
    expect(ok.json()).toMatchObject({ event: { status: 'done' } })
    const over = await as(crewSession, `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 2501, dest: 'cash' })
    expect(over.json()).toMatchObject({ event: { status: 'pending' } })

    const mgmt = await p.h.createUser({ email: 'mgmt-deny@example.test', roles: ['mgmt'], overrides: { 'pay.refund': 'deny' } })
    const mgmtSession = await p.h.login(mgmt, '10.9.9.8')
    expect((await as(mgmtSession, `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 100, dest: 'cash' })).statusCode).toBe(403)
  })

  it('roles union to the highest limit among the roles that grant the permission', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 200000 }] })
    await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 214000, method: 'Visa', methodKind: 'card', processorState: 'confirmed' })
    const both = await p.h.createUser({ email: 'support-acct@example.test', roles: ['support', 'acct'] })
    const session = await p.h.login(both, '10.9.9.7')
    expect(
      (await as(session, `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 50000, dest: 'cash' })).json(),
    ).toMatchObject({ event: { status: 'done' } })
    expect(
      (await as(session, `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: 50001, dest: 'cash' })).json(),
    ).toMatchObject({ event: { status: 'pending' } })
  })
})
