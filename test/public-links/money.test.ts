// Memberships and payments through personal links (ADR 0160, design section 5, plan E): both need a PIN or code entered on the page
// in the last 5 minutes (the number's 30-day trust is not enough), and the redirect only ever goes to an allowed host. The email a
// client types to join is the checkout intent's expected email only: it never becomes a verified email, so it never links an order
// by itself (design section 10).
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { loadIntentRefs } from '../../src/modules/memberships/checkouts.js'
import { createManualMembership } from '../../src/modules/memberships/service.js'
import { linkCustomer, type CustomerRef } from '../../src/modules/payments-sync/membership.js'
import { DAY, json, MIN, PHONES, TODAY, useLinksHarness } from './harness.js'

const h = useLinksHarness()
const CHECKOUT = 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?product=gold'

async function membershipPage(o: { checkout?: string | null } = {}) {
  const id = await h.customer()
  if (o.checkout !== null) await sql`update membership_plans set checkout_url = ${o.checkout ?? CHECKOUT} where key = 'gold'`.execute(h.db)
  const p = await h.page({ customerId: id, kind: 'membership', planKey: 'gold' })
  return { id, ...p }
}

describe('POST membership/start', () => {
  it('shows the plan, needs a fresh PIN or code, then opens a pending membership and a checkout intent and redirects to Squarespace', async () => {
    const { id, session, body, link } = await membershipPage()
    expect(body.plan).toMatchObject({ tier: 'gold', planKey: 'gold' })
    const early = await h.call('POST', 'membership/start', { session, body: { email: 'maria.pays@example.test' } })
    expect(early.statusCode).toBe(403)
    expect(json(early)).toMatchObject({ code: 'IDENTITY_STEP_UP_REQUIRED', meta: { need: 'fresh' } })
    expect((await h.verifyByCode(session)).statusCode).toBe(200)
    const r = await h.call('POST', 'membership/start', {
      session,
      body: { email: 'Maria.Pays@Example.test', vehicles: [{ car: '2021 Tesla Model 3', plate: 'nj-mar1' }] },
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r).redirectUrl).toBe(CHECKOUT)
    expect(new URL(json(r).redirectUrl).hostname.endsWith('.squarespace.com')).toBe(true)
    expect(json(r).membershipRef).toMatch(/^OAS-M-[0-9A-F]{8}$/)
    expect(new Date(json(r).checkoutExpiresAt).getTime() - h.clock.now().getTime()).toBe(3 * DAY)
    const m = await h.db.selectFrom('memberships').selectAll().where('customer_id', '=', id).executeTakeFirstOrThrow()
    expect(m).toMatchObject({ status: 'pending', source: 'manual', manual_status_at: null })
    const c = await h.db.selectFrom('membership_checkouts').selectAll().where('membership_id', '=', m.id).executeTakeFirstOrThrow()
    expect(c).toMatchObject({ state: 'open', origin: 'link', link_id: link.id, plan_key: 'gold', expected_email: 'maria.pays@example.test', checkout_url: CHECKOUT })
    const v = await h.db.selectFrom('vehicles').select(['make', 'model', 'year', 'plate']).where('customer_id', '=', id).execute()
    expect(v).toEqual([{ make: 'Tesla', model: 'Model 3', year: 2021, plate: 'NJ-MAR1' }])
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', link.id).executeTakeFirstOrThrow()).uses).toBe(1)
  })

  it('an unverified email never links an order: the typed email is only the intent’s, never the client’s verified email', async () => {
    const { id, session } = await membershipPage()
    await h.verifyByCode(session)
    expect((await h.call('POST', 'membership/start', { session, body: { email: 'maria.pays@example.test' } })).statusCode).toBe(200)
    const row = await h.db.selectFrom('customers').select(['email', 'email_verified']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(row).toEqual({ email: null, email_verified: false })
    // the order sync's view of the client: no verified email (the rule of memberships/service.ts customerRefs)
    const ref: CustomerRef = { id, emails: row.email && row.email_verified ? [row.email] : [], unverifiedEmails: row.email ? [row.email] : [], phones: [PHONES.maria] }
    const intents = await loadIntentRefs(h.db, h.locationId)
    // inside the intent's window, the intent decides (the tier the design puts first)
    const inside = linkCustomer({ email: 'maria.pays@example.test', orderId: 'o-1', createdOn: h.clock.now(), product: { key: 'gold', tier: 'gold' } }, [ref], intents)
    expect(inside).toMatchObject({ customerId: id, by: 'checkout_intent' })
    // after it, the same email alone links nobody
    const later = new Date(h.clock.now().getTime() + 5 * DAY)
    const after = linkCustomer({ email: 'maria.pays@example.test', orderId: 'o-2', createdOn: later, product: { key: 'gold', tier: 'gold' } }, [ref], [])
    expect(after.customerId).toBeUndefined()
    expect(after.by).not.toBe('email')
  })

  it('a step-up older than 5 minutes is not fresh; a live member and a plan without a checkout are refused in plain words', async () => {
    const { id, session } = await membershipPage({ checkout: null })
    await h.verifyByCode(session)
    const none = await h.call('POST', 'membership/start', { session, body: { email: 'maria@example.test' } })
    expect(json(none)).toMatchObject({ status: 409, code: 'LINK_CHECKOUT_UNAVAILABLE' })
    await sql`update membership_plans set checkout_url = ${CHECKOUT} where key = 'gold'`.execute(h.db)
    h.advance(6 * MIN)
    const stale = await h.call('POST', 'membership/start', { session, body: { email: 'maria@example.test' } })
    expect(json(stale)).toMatchObject({ status: 403, code: 'IDENTITY_STEP_UP_REQUIRED' })
    await h.db.transaction().execute((tx) =>
      createManualMembership(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, { customerId: id, planKey: 'gold', planLabel: 'Gold' }, { userId: 'test', name: 'Test', audit: {} }),
    )
    await h.verifyByCode(session)
    const member = await h.call('POST', 'membership/start', { session, body: { email: 'maria@example.test' } })
    expect(json(member)).toMatchObject({ status: 409, code: 'LINK_ALREADY_MEMBER', detail: 'You already have a membership. Text us to change your plan.' })
    expect(await h.db.selectFrom('membership_checkouts').selectAll().execute()).toEqual([])
    expect(json(await h.call('POST', 'membership/start', { session, body: { email: 'not an email' } }))).toMatchObject({ status: 422 })
  })
})

describe('POST pay/start', () => {
  async function payPage() {
    const id = await h.customer()
    await h.trust(id)
    const cal = await h.page({ customerId: id })
    const booked = await h.call('POST', 'bookings', { session: cal.session, key: h.nextKey(), body: { serviceKey: h.key('Express Hand Wash'), addonKeys: [], date: TODAY, startMin: 13 * 60 } })
    expect(booked.statusCode, booked.body).toBe(201)
    const invoice = await h.db.selectFrom('invoices').select(['id', 'invoice_no']).where('customer_id', '=', id).executeTakeFirstOrThrow()
    const p = await h.page({ customerId: id, kind: 'pay', invoiceId: invoice.id })
    return { id, invoice, ...p }
  }

  it('shows the invoice, needs a fresh step-up even on a trusted number, then redirects to the invoice’s Squarespace link', async () => {
    const { session, body, invoice, link } = await payPage()
    expect(body.trust.verified).toBe(true)
    expect(body.invoice.number).toBe(invoice.invoice_no)
    expect(body.invoice.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Express Hand Wash' })]))
    expect(body.invoice.balanceCents).toBeGreaterThan(0)
    expect(body.invoice.balanceCents).toBe(body.invoice.totalCents)
    const early = await h.call('POST', 'pay/start', { session, body: {} })
    expect(json(early)).toMatchObject({ status: 403, code: 'IDENTITY_STEP_UP_REQUIRED', meta: { need: 'fresh' } })
    await sql`update invoices set payment_link_url = 'https://oasis-auto-spa.squarespace.com/pay/inv-1' where id = ${invoice.id}`.execute(h.db)
    await h.verifyByCode(session)
    const r = await h.call('POST', 'pay/start', { session, body: {} })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toEqual({ status: 'redirect', redirectUrl: 'https://oasis-auto-spa.squarespace.com/pay/inv-1' })
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', link.id).executeTakeFirstOrThrow()).uses).toBe(1)
  })

  it('without an allowed payment URL: link_pending, and the managers are asked once to text a payment link', async () => {
    const { session, invoice } = await payPage()
    await h.verifyByCode(session)
    const notices = () => h.db.selectFrom('notifications').select(['kind', 'title', 'source_ref']).where('kind', '=', 'payments.link_requested').execute()
    const r = await h.call('POST', 'pay/start', { session, body: {} })
    expect(r.statusCode, r.body).toBe(200)
    expect(json(r)).toEqual({ status: 'link_pending', redirectUrl: null })
    const first = await notices()
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]).toMatchObject({ title: 'Text Maria a payment link', source_ref: `pay_link_request:${invoice.id}` })
    await h.call('POST', 'pay/start', { session, body: {} })
    expect(await notices()).toHaveLength(first.length)
    // a URL on a host outside PAYMENT_LINK_HOSTS is never a redirect
    for (const url of ['https://evil.example/pay', 'http://oasis.squarespace.com/pay', 'https://squarespace.com.evil.example/pay', 'https://u:p@oasis.squarespace.com/pay']) {
      await sql`update invoices set payment_link_url = ${url} where id = ${invoice.id}`.execute(h.db)
      expect(json(await h.call('POST', 'pay/start', { session, body: {} })), url).toEqual({ status: 'link_pending', redirectUrl: null })
    }
  })

  it('a voided invoice ends its page; other kinds of pages cannot pay', async () => {
    const { session, invoice, id } = await payPage()
    await h.verifyByCode(session)
    const cal = await h.page({ customerId: id })
    expect(json(await h.call('POST', 'pay/start', { session: cal.session, body: {} }))).toMatchObject({ status: 401, code: 'LINK_WRONG_PURPOSE' })
    await sql`update invoices set canceled_at = app_now(), cancel_reason = 'canceled' where id = ${invoice.id}`.execute(h.db)
    expect(json(await h.call('POST', 'pay/start', { session, body: {} }))).toMatchObject({ status: 401, code: 'IDENTITY_SESSION_INVALID' })
  })
})
