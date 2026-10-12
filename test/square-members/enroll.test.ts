// Joining on a membership page with Square (ADR 0171 D8, wave Q3b, design 5.3): the guards of membership/start, the household rule,
// the size priced and synced, the deliverable email; the state machine started -> customer_ready -> card_saved -> subscribed ->
// active, resumed with the same keys after a lost answer, abandoned after an hour and cleaned up at Square; a failed first payment
// ends it (canceled at Square, a new membership page texted); the page polls the status.
import { describe, expect, it } from 'vitest'
import { sqKey } from '../../src/integrations/square/keys.js'
import { runEnrollmentJobs } from '../../src/modules/memberships/square/enroll.js'
import { addHouseholdMember } from '../../src/modules/memberships/service.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { DAY, useSquareMembers } from './rig.js'
import { PHONES, useLinksHarness } from '../public-links/harness.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)
const MIN = 60_000

const enrollments = () => h.db.selectFrom('square_enrollments').selectAll().orderBy('started_at').orderBy('id').execute()
const membershipsOf = (customerId: string) => h.db.selectFrom('memberships').selectAll().where('customer_id', '=', customerId).orderBy('created_at').orderBy('id').execute()

describe('POST membership/subscribe', () => {
  it('saves the card with the consent, makes the subscription from today, and is active once the first invoice is paid', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    expect(await r.status(p.session)).toEqual({ status: 'none', membershipRef: null })
    const s = await r.subscribe(p.session, { vehicles: [{ car: '2022 Honda Civic', plate: 'NJ1234' }] })
    expect(s.status, JSON.stringify(s.body)).toBe(202)
    expect(s.body).toMatchObject({ status: 'pending', membershipRef: expect.stringMatching(/^OAS-M-[0-9A-F]{8}$/) })
    const [e] = await enrollments()
    expect(e).toMatchObject({ state: 'subscribed', email: 'maria.delgado@gmail.com', plan_class: 'compact_car', monthly_cents: 12900, start_date: '2026-06-13', attempts: 1 })
    // the keys are the enrollment's own
    expect(r.sim.sim.log.find((x) => x.path === '/v2/cards')!.idempotencyKey).toBe(sqKey('cd', e!.id))
    expect(r.sim.sim.log.find((x) => x.path === '/v2/subscriptions')!.idempotencyKey).toBe(sqKey('sb', e!.id))
    const sub = r.sim.store.subscriptions.get(e!.square_subscription_id!)!
    expect(sub).toMatchObject({ start_date: '2026-06-13', timezone: 'America/New_York', status: 'ACTIVE' })
    expect(r.sim.store.customers.get(e!.square_customer_id!)!.email_address).toBe('maria.delgado@gmail.com')
    const consent = await h.db.selectFrom('card_consents').selectAll().executeTakeFirstOrThrow()
    expect(consent).toMatchObject({ purposes: ['membership_billing'], text_version: 'v1', link_id: p.linkId })
    let [m] = await membershipsOf(p.customerId)
    expect(m).toMatchObject({ status: 'pending', source: 'square', plan_class: 'compact_car', square_subscription_id: sub.id, card_id: e!.card_id })
    expect(await r.status(p.session)).toMatchObject({ status: 'pending' })
    // Square bills the first period: the events make it active, with the period from today in shop-local midnights
    const notes = await r.drain()
    ;[m] = await membershipsOf(p.customerId)
    expect(m).toMatchObject({ status: 'active', billing_status: 'ok', paid_order_count: 1, square_status: 'ACTIVE' })
    expect(m!.current_period_start).toEqual(new Date('2026-06-13T04:00:00Z'))
    expect(m!.current_period_end).toEqual(new Date('2026-07-13T04:00:00Z'))
    expect((await enrollments())[0]).toMatchObject({ state: 'active' })
    expect(await r.status(p.session)).toMatchObject({ status: 'active' })
    // the subscription's payment is a membership payment: never matched to an Oasis invoice nor queued for staff
    const pay = await h.db.selectFrom('square_payments').select(['classification', 'match_state', 'ignore_note']).execute()
    expect(pay, notes.join('\n')).toEqual([{ classification: 'membership', match_state: 'ignored', ignore_note: 'membership payment (Square subscription)' }])
    const vehicles = await h.db.selectFrom('vehicles').select(['make', 'plate']).where('customer_id', '=', p.customerId).execute()
    expect(vehicles).toEqual([{ make: 'Honda', plate: 'NJ1234' }])
  })

  it('refuses before anything is written: Squarespace as processor (501), watch-only (409), an undeliverable email (422), an old consent (409)', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    for (const email of ['maria@example.com', 'maria@shop.test']) {
      const bad = await r.subscribe(p.session, { email })
      expect(bad.status).toBe(422)
      expect(bad.body.errors).toEqual([{ path: 'body.email', message: 'Use an email you check: Square sends your membership receipts there.' }])
    }
    expect((await r.subscribe(p.session, { consentVersion: 'v0' })).body).toMatchObject({ status: 409, code: 'CARD_CONSENT_OUTDATED' })
    // before the cutover the page joins through the Squarespace checkout (membership/start); watch-only cannot make a subscription
    configureSquareRuntime({ env: { ...r.env, PAYMENT_PROCESSOR: 'squarespace' }, api: () => r.sim.api })
    expect((await r.subscribe(p.session)).body).toMatchObject({ status: 501, code: 'LINK_ACTION_NOT_READY' })
    configureSquareRuntime({ env: { ...r.env, SQUARE_WRITES_ENABLED: false }, api: () => r.sim.api })
    expect((await r.subscribe(p.session)).body).toMatchObject({ status: 409, code: 'LINK_CHECKOUT_UNAVAILABLE' })
    configureSquareRuntime({ env: r.env, api: () => r.sim.api })
    expect(await enrollments()).toEqual([])
    expect(r.sim.sim.log.filter((x) => x.method === 'POST' && !x.path.startsWith('/v2/catalog'))).toEqual([])
  })

  it('needs a fresh PIN or code, a membership link, a priced and synced size, and answers LINK_ALREADY_MEMBER for a member or a household member', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    await r.price('gold', 'truck', 15900, { sync: false })
    const p = await r.page()
    expect((await r.subscribe(p.session, { planClass: 'large_suv' })).body).toMatchObject({ code: 'TIER_CLASS_UNPRICED' })
    expect((await r.subscribe(p.session, { planClass: 'truck' })).body).toMatchObject({ status: 409, code: 'LINK_CHECKOUT_UNAVAILABLE' })
    // a household member of someone else's membership joins nothing else (the household rule)
    const holder = await r.member({ phone: PHONES.liam, name: 'Liam Ortiz' })
    await h.db.transaction().execute((tx) =>
      addHouseholdMember(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, holder.membershipId, p.customerId, { userId: h.newId(), name: 'Desk', audit: {} }),
    )
    expect((await r.subscribe(p.session)).body).toMatchObject({ status: 409, code: 'LINK_ALREADY_MEMBER' })
    // the holder's own page: already a member
    const own = await r.page({ customerId: holder.customerId, phone: PHONES.liam })
    expect((await r.subscribe(own.session)).body).toMatchObject({ status: 409, code: 'LINK_ALREADY_MEMBER' })
    // a calendar page cannot subscribe; a membership page whose step-up is older than 5 minutes cannot either
    const cal = await h.page({ customerId: p.customerId })
    expect((await r.subscribe(cal.session)).body).toMatchObject({ status: 401, code: 'LINK_WRONG_PURPOSE' })
    const stale = await r.page({ customerId: (await h.customer({ phone: PHONES.other, name: 'Ana Reyes' })), phone: PHONES.other })
    h.advance(6 * MIN)
    expect((await r.subscribe(stale.session)).body).toMatchObject({ status: 403, code: 'IDENTITY_STEP_UP_REQUIRED' })
  })

  it('a declined card: 422 CARD_DECLINED with the reason, the attempt failed; another card on the same page joins', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    const d = await r.subscribe(p.session, { sourceId: 'cnon:card-nonce-declined' })
    expect(d.status).toBe(422)
    expect(d.body).toMatchObject({ code: 'CARD_DECLINED' })
    expect(await enrollments()).toEqual([expect.objectContaining({ state: 'failed', failure_code: 'card_declined', cleanup: 'none' })])
    expect(await r.status(p.session)).toMatchObject({ status: 'failed' })
    const ok = await r.subscribe(p.session)
    expect(ok.status, JSON.stringify(ok.body)).toBe(202)
    const all = await enrollments()
    expect(all.map((x) => x.state)).toEqual(['failed', 'subscribed'])
    // one membership row, reused
    expect(await membershipsOf(p.customerId)).toHaveLength(1)
  })

  it('a second submit while the attempt is past its card answers its status and sends nothing', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    await r.subscribe(p.session)
    const posts = r.sim.sim.log.filter((x) => x.method === 'POST').length
    const again = await r.subscribe(p.session)
    expect(again).toMatchObject({ status: 202, body: { status: 'pending' } })
    expect(r.sim.sim.log.filter((x) => x.method === 'POST').length).toBe(posts)
    expect(await enrollments()).toHaveLength(1)
  })
})

describe('square.enrollments.resume', () => {
  it('takes on an attempt whose CreateSubscription got no answer, with the same key, then reads the first invoice back', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    r.sim.sim.injectFault({ status: 500, times: 4, path: '/v2/subscriptions', method: 'POST' })
    const s = await r.subscribe(p.session)
    expect(s).toMatchObject({ status: 202, body: { status: 'pending' } })
    const [e] = await enrollments()
    expect(e).toMatchObject({ state: 'card_saved', square_subscription_id: null })
    expect(r.sim.store.subscriptions.size).toBe(0)
    h.advance(5 * MIN)
    expect(await r.resume()).toMatchObject({ status: 'done', subscribed: 1 })
    const after = (await enrollments())[0]!
    expect(after.state).toBe('subscribed')
    expect(r.sim.sim.log.filter((x) => x.path === '/v2/subscriptions' && x.status === 200).map((x) => x.idempotencyKey)).toEqual([sqKey('sb', e!.id)])
    // no event delivered: the next run reads the subscription and its invoice and activates the membership
    expect(await r.resume()).toMatchObject({ polled: 1 })
    const [m] = await membershipsOf(p.customerId)
    expect(m!.status).toBe('active')
    expect((await enrollments())[0]!.state).toBe('active')
  })

  it('abandons an attempt older than an hour: the subscription canceled, the card disabled, the membership canceled', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    r.sim.store.firstInvoiceDelayMs = 3 * 60 * MIN // Square slow to bill: nothing paid within the hour
    const p = await r.page()
    await r.subscribe(p.session)
    const e = (await enrollments())[0]!
    h.advance(61 * MIN)
    const out = await r.resume()
    expect(out).toMatchObject({ abandoned: 1, cleaned: 1 })
    expect((await enrollments())[0]).toMatchObject({ state: 'abandoned', failure_code: 'expired', cleanup: 'done' })
    expect(r.sim.store.subscriptions.get(e.square_subscription_id!)!.canceled_date).toBeTruthy()
    expect(await h.db.selectFrom('customer_cards').select(['state', 'disabled_reason']).execute()).toEqual([{ state: 'disabled', disabled_reason: 'membership_failed' }])
    expect(await h.db.selectFrom('card_consents').select('revoke_reason').execute()).toEqual([{ revoke_reason: 'membership_failed' }])
    expect((await membershipsOf(p.customerId))[0]).toMatchObject({ status: 'canceled', cancel_reason: 'enrollment_failed' })
    // a second run has nothing left to do and changes nothing at Square
    const writes = () => r.sim.sim.log.filter((x) => x.method !== 'GET').length
    const before = writes()
    expect(await r.resume()).toMatchObject({ abandoned: 0, cleaned: 0, closed: 0 })
    expect(writes()).toBe(before)
  })

  it('closes a pending membership whose last attempt failed an hour ago', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    await r.subscribe(p.session, { sourceId: 'cnon:card-nonce-declined' })
    expect((await membershipsOf(p.customerId))[0]!.status).toBe('pending')
    h.advance(30 * MIN)
    expect(await r.resume()).toMatchObject({ closed: 0 })
    h.advance(31 * MIN)
    expect(await r.resume()).toMatchObject({ closed: 1 })
    expect((await membershipsOf(p.customerId))[0]).toMatchObject({ status: 'canceled', cancel_reason: 'enrollment_failed' })
  })

  it('a first payment that fails ends the attempt: canceled at Square with its invoice, the card disabled, a new membership page texted', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    r.sim.store.firstInvoiceDelayMs = 60 * MIN
    const p = await r.page()
    await r.subscribe(p.session)
    const e = (await enrollments())[0]!
    const inv = r.sim.store.billNow(e.square_subscription_id!, 'failed')
    await r.drain()
    expect((await enrollments())[0]).toMatchObject({ state: 'failed', failure_code: 'first_payment_failed', cleanup: 'pending' })
    expect(await r.status(p.session)).toMatchObject({ status: 'failed' })
    expect(await r.resume()).toMatchObject({ cleaned: 1 })
    expect(r.sim.store.invoices.get(String(inv.id))!.status).toBe('CANCELED')
    expect(r.sim.store.subscriptions.get(e.square_subscription_id!)!.canceled_date).toBeTruthy()
    expect((await membershipsOf(p.customerId))[0]).toMatchObject({ status: 'canceled', cancel_reason: 'first_payment_failed' })
    const texts = await h.texts(PHONES.maria)
    expect(texts.find((t) => /Try another card/.test(t.body))?.body).toMatch(/^Your first Oasis Auto Spa Gold payment didn.t go through, so your membership hasn.t started\. Try another card on this secure page: https:\/\/site\.example\.test\/#\/m\/[A-Za-z0-9_-]{43}/)
    expect(await h.db.selectFrom('notifications').select('kind').where('kind', '=', 'membership.first_payment_failed').execute()).not.toEqual([])
    // the delivered invoice event again (a duplicate) changes nothing
    expect(await r.resume()).toMatchObject({ cleaned: 0 })
  })

  it('a retry on the same page after a failed first payment is a membership of its own: the old one is closed and cleaned up, the new one bills', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    r.sim.store.firstInvoiceDelayMs = 60 * MIN
    const p = await r.page()
    await r.subscribe(p.session)
    const e1 = (await enrollments())[0]!
    r.sim.store.billNow(e1.square_subscription_id!, 'failed')
    await r.drain()
    // the client tries another card on the same page before the job cleaned the first attempt up
    const again = await r.subscribe(p.session)
    expect(again.status, JSON.stringify(again.body)).toBe(202)
    const e2 = (await enrollments())[1]!
    expect(e2).toMatchObject({ state: 'subscribed' })
    expect(e2.membership_id).not.toBe(e1.membership_id)
    expect(e2.square_subscription_id).not.toBe(e1.square_subscription_id)
    let [old, cur] = await membershipsOf(p.customerId)
    expect(old).toMatchObject({ id: e1.membership_id, status: 'canceled', cancel_reason: 'first_payment_failed', square_subscription_id: e1.square_subscription_id })
    expect(cur).toMatchObject({ id: e2.membership_id, status: 'pending', square_subscription_id: e2.square_subscription_id, card_id: e2.card_id })
    r.sim.store.billNow(e2.square_subscription_id!, 'paid')
    await r.drain()
    // the job cleans the first attempt up at Square and touches nothing of the new membership
    expect(await r.resume()).toMatchObject({ cleaned: 1, cardsMoved: 0 })
    expect(r.sim.store.subscriptions.get(e1.square_subscription_id!)!.canceled_date).toBeTruthy()
    expect(r.sim.store.subscriptions.get(e2.square_subscription_id!)!.card_id).toBe((await h.db.selectFrom('customer_cards').select('square_card_id').where('id', '=', e2.card_id!).executeTakeFirstOrThrow()).square_card_id)
    expect(await h.db.selectFrom('customer_cards').select('state').where('id', '=', e1.card_id!).executeTakeFirstOrThrow()).toEqual({ state: 'disabled' })
    expect(await r.status(p.session)).toMatchObject({ status: 'active', membershipRef: again.body.membershipRef })
    // a month later: the old subscription has ended, the new one renews, the membership stays active
    await r.advance(32 * DAY)
    const notes = await r.drain()
    ;[old, cur] = await membershipsOf(p.customerId)
    expect(cur, notes.join('\n')).toMatchObject({ status: 'active', square_subscription_id: e2.square_subscription_id, paid_order_count: 2 })
    expect(old).toMatchObject({ status: 'canceled' })
    expect(await h.db.selectFrom('notifications').select('kind').where('kind', '=', 'membership.square_paid_canceled').execute()).toEqual([])
  })

  it('memberships off answers 409; a retry right after Square refused the subscription survives the cleanup of the refused attempt', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    r.sim.store.firstInvoiceDelayMs = 60 * MIN
    const p = await r.page()
    // memberships on Square not switched on yet (writes on for links, deposits and refunds only): nothing is written
    configureSquareRuntime({ env: { ...r.env, SQUARE_MEMBERSHIPS_ENABLED: false }, api: () => r.sim.api })
    expect((await r.subscribe(p.session)).body).toMatchObject({ status: 409, code: 'LINK_CHECKOUT_UNAVAILABLE' })
    expect(await enrollments()).toEqual([])
    configureSquareRuntime({ env: r.env, api: () => r.sim.api })
    r.sim.sim.injectFault({ status: 400, times: 1, path: '/v2/subscriptions', method: 'POST' })
    expect((await r.subscribe(p.session)).body).toMatchObject({ status: 409, code: 'LINK_CHECKOUT_UNAVAILABLE' })
    const ok = await r.subscribe(p.session)
    expect(ok.status, JSON.stringify(ok.body)).toBe(202)
    const [e1, e2] = await enrollments()
    expect(e1).toMatchObject({ state: 'failed', failure_code: 'subscription_refused', cleanup: 'pending' })
    expect(e2).toMatchObject({ state: 'subscribed' })
    // the job runs before Square bills the new attempt's first invoice
    expect(await r.resume()).toMatchObject({ cleaned: 1 })
    const ms = await membershipsOf(p.customerId)
    expect(ms.map((m) => [m.id, m.status])).toEqual([
      [e1!.membership_id, 'canceled'],
      [e2!.membership_id, 'pending'],
    ])
    r.sim.store.billNow(e2!.square_subscription_id!, 'paid')
    await r.drain()
    expect((await membershipsOf(p.customerId))[1]).toMatchObject({ status: 'active', square_subscription_id: e2!.square_subscription_id })
    expect((await enrollments())[1]).toMatchObject({ state: 'active' })
    expect(await r.status(p.session)).toMatchObject({ status: 'active' })
  })

  it('the cleanup of a failed attempt never closes a membership a newer attempt is using', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    r.sim.store.firstInvoiceDelayMs = 3 * 60 * MIN
    const p = await r.page()
    await r.subscribe(p.session)
    const live = (await enrollments())[0]!
    // an older attempt of the same membership that still owes its cleanup (e.g. a submit that was superseded while in flight)
    const t0 = new Date(live.started_at.getTime() - MIN)
    await h.db
      .insertInto('square_enrollments')
      .values({
        ...live,
        id: h.newId(),
        state: 'failed',
        failure_code: 'subscription_refused',
        failure_detail: 'Square refused the subscription',
        cleanup: 'pending',
        card_id: null,
        consent_id: null,
        square_subscription_id: null,
        started_at: t0,
        created_at: t0,
        updated_at: t0,
      })
      .execute()
    expect(await r.resume()).toMatchObject({ cleaned: 1 })
    expect((await membershipsOf(p.customerId))[0]).toMatchObject({ id: live.membership_id, status: 'pending' })
    r.sim.store.billNow(live.square_subscription_id!, 'paid')
    await r.drain()
    expect((await membershipsOf(p.customerId))[0]).toMatchObject({ status: 'active' })
  })

  it('reads Square once before abandoning a subscribed attempt older than an hour: a first invoice already paid makes it active', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const p = await r.page()
    await r.subscribe(p.session)
    const e = (await enrollments())[0]!
    // neither the events nor the job ran for an hour
    await r.advance(61 * MIN)
    expect(await r.resume()).toMatchObject({ abandoned: 0, cleaned: 0 })
    expect((await enrollments())[0]).toMatchObject({ state: 'active' })
    expect((await membershipsOf(p.customerId))[0]).toMatchObject({ status: 'active', paid_order_count: 1 })
    expect(r.sim.store.subscriptions.get(e.square_subscription_id!)!.canceled_date).toBeFalsy()
    // Square not answering: the attempt is kept for the next run, nothing is canceled
    const q = await r.page({ phone: PHONES.liam, name: 'Liam Ortiz' })
    r.sim.store.firstInvoiceDelayMs = 3 * 60 * MIN
    await r.subscribe(q.session)
    await r.advance(61 * MIN)
    r.sim.sim.injectFault({ status: 500, times: 100, path: '/v2/subscriptions/', method: 'GET' })
    expect(await r.resume()).toMatchObject({ abandoned: 0, cleaned: 0 })
  })

  it('does nothing with Square writes off (the default)', async () => {
    const r = rigOf()
    const out = await runEnrollmentJobs({ ...r.steps(), env: { ...r.env, SQUARE_WRITES_ENABLED: false } })
    expect(out).toMatchObject({ status: 'skipped' })
    expect(r.sim.sim.log).toEqual([])
  })
})
