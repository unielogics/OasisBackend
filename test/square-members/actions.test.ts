// Staff actions on a membership billed by Square (ADR 0171 wave Q3b, design 5.6), "Move members" (plan decision 8) and the edit
// rules: pause / resume, cancel at the period end and its undo, a tier or size change at the next billing date and its undo (the
// membership follows when Square swaps), the card link, refunding the last payment (keyed); a patch may change only auto-apply and
// the note; actions need a Square membership, Square writes and the permission.
import { describe, expect, it } from 'vitest'
import { sqKey } from '../../src/integrations/square/keys.js'
import { PHONES, useLinksHarness } from '../public-links/harness.js'
import { DAY, useSquareMembers } from './rig.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)

const staff = (method: 'POST' | 'PATCH', url: string, payload: unknown = {}, headers: Record<string, string> = {}) =>
  h.t.app.inject({ method, url: `/api/v1${url}`, payload: payload as object, headers })

const billing = async (id: string, action: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const r = await staff('POST', `/memberships/${id}/billing/${action}`, body, headers)
  return { status: r.statusCode, body: r.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('billing actions', () => {
  it('pause at the next billing date and undo it; cancel at the period end and undo it', async () => {
    const r = rigOf()
    const m = await r.member()
    const p = await billing(m.membershipId, 'pause')
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    expect(p.body.membership.billing).toMatchObject({ pauseAt: '2026-07-13', cancelAt: null })
    expect(r.sim.store.retrieveSubscription(m.subscriptionId).actions.map((a) => a.type)).toEqual(['PAUSE'])
    expect((await billing(m.membershipId, 'pause')).body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE' })
    const undo = await billing(m.membershipId, 'resume')
    expect(undo.body.membership.billing).toMatchObject({ pauseAt: null })
    expect(r.sim.store.retrieveSubscription(m.subscriptionId).actions).toEqual([])
    const c = await billing(m.membershipId, 'cancel')
    expect(c.body.membership).toMatchObject({ status: 'active', billing: { cancelAt: '2026-07-13' } })
    expect(r.sim.store.subscriptions.get(m.subscriptionId)!.canceled_date).toBe('2026-07-13')
    const cu = await billing(m.membershipId, 'cancel/undo')
    expect(cu.body.membership.billing).toMatchObject({ cancelAt: null })
    expect(r.sim.store.subscriptions.get(m.subscriptionId)!.canceled_date).toBeUndefined()
    expect((await billing(m.membershipId, 'cancel/undo')).body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE' })
    const audits = await h.db.selectFrom('audit_log').select('action').where('action', 'like', 'membership.billing.%').orderBy('id').execute()
    expect(audits.map((a) => a.action)).toEqual(['membership.billing.pause', 'membership.billing.resume', 'membership.billing.cancel', 'membership.billing.cancel_undo'])
  })

  it('a paused membership resumes at once', async () => {
    const r = rigOf()
    const m = await r.member()
    r.sim.store.pauseSubscription(m.subscriptionId, { pause_effective_date: '2026-06-14' })
    await r.advance(DAY)
    await r.drain()
    expect((await r.membership(m.membershipId)).status).toBe('paused')
    const res = await billing(m.membershipId, 'resume')
    expect(res.body.membership).toMatchObject({ status: 'active' })
  })

  it('change tier and size at the next billing date, undo it; once Square swaps, the membership follows (tier, size, price)', async () => {
    const r = rigOf()
    const m = await r.member()
    await r.price('vip', 'large_suv', 21900)
    await r.price('vip', 'compact_car', 19900, { sync: false })
    expect((await billing(m.membershipId, 'change', { planKey: 'vip' })).body).toMatchObject({ status: 409, code: 'TIER_PRICE_NOT_SYNCED' })
    expect((await billing(m.membershipId, 'change', { planKey: 'gold' })).body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE' })
    const ch = await billing(m.membershipId, 'change', { planKey: 'vip', planClass: 'large_suv' })
    expect(ch.status, JSON.stringify(ch.body)).toBe(200)
    expect(ch.body.membership.billing.change).toEqual({ kind: 'change', planKey: 'vip', planName: expect.any(String), planClass: 'large_suv', planClassLabel: 'Large SUV', monthlyCents: 21900, effectiveDate: '2026-07-13', swapAfter: null })
    expect((await billing(m.membershipId, 'change/undo')).body.membership.billing.change).toBeNull()
    expect(r.sim.store.retrieveSubscription(m.subscriptionId).actions).toEqual([])
    // the same change again in this billing period is refused (Square locked the subscription for it in the sandbox)
    expect((await billing(m.membershipId, 'change', { planKey: 'vip', planClass: 'large_suv' })).body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE' })
    const truck = await r.price('vip', 'truck', 23900)
    const again = await billing(m.membershipId, 'change', { planKey: 'vip', planClass: 'truck' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    // the next billing date: Square swaps, then bills the new price
    await r.advance(30 * DAY)
    await r.drain()
    const row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ plan_class: 'truck', tier_price_id: truck, scheduled_change: null, status: 'active', paid_order_count: 2, swap_undone_variations: [] })
    const plan = await h.db.selectFrom('membership_plans').select('key').where('id', '=', String(row.plan_id)).executeTakeFirstOrThrow()
    expect(plan.key).toBe('vip')
    const last = await h.db.selectFrom('square_subscription_invoices').select('amount_cents').orderBy('due_date', 'desc').executeTakeFirstOrThrow()
    expect(last.amount_cents).toBe(23900)
  })

  it('texts the card link; refunds the last payment once (keyed)', async () => {
    const r = rigOf()
    const m = await r.member()
    const cl = await staff('POST', `/memberships/${m.membershipId}/billing/card-link`)
    expect(cl.statusCode, cl.body).toBe(200)
    expect(cl.json()).toMatchObject({ sms: 'queued' })
    expect((await h.texts(PHONES.maria)).find((t) => /Save a card/.test(t.body))?.body).toMatch(/^Save a card with Oasis Auto Spa on this secure page: https:\/\/site\.example\.test\/#\/k\/[A-Za-z0-9_-]{43}/)
    expect((await billing(m.membershipId, 'refund-last')).body).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' })
    const key = { 'idempotency-key': 'refund-last-key-0001' }
    const rf = await billing(m.membershipId, 'refund-last', {}, key)
    expect(rf.status, JSON.stringify(rf.body)).toBe(200)
    expect(rf.body.refund).toEqual({ amountCents: 12900, status: 'PENDING' })
    expect(r.sim.store.refunds.size).toBe(1)
    const inv = await h.db.selectFrom('square_subscription_invoices').select(['id', 'refunded_cents', 'square_refund_id']).executeTakeFirstOrThrow()
    expect(inv.refunded_cents).toBe(12900)
    expect(r.sim.sim.log.find((x) => x.path === '/v2/refunds')!.idempotencyKey).toBe(sqKey('rf', `membership-invoice:${inv.id}`))
    // the same key answers the same refund; another key finds nothing left to refund
    expect((await billing(m.membershipId, 'refund-last', {}, key)).body).toEqual(rf.body)
    expect((await billing(m.membershipId, 'refund-last', {}, { 'idempotency-key': 'refund-last-key-0002' })).body).toMatchObject({ code: 'MEMBERSHIP_BILLING_STATE' })
    expect(r.sim.store.refunds.size).toBe(1)
    // its refund event is not an Oasis invoice's: nothing is recorded in the ledger
    await r.advance(10_000)
    await r.drain()
    expect(await h.db.selectFrom('ledger_events').select('id').where('type', '=', 'refund').execute()).toEqual([])
  })

  it('a refund Square fails later is cleared: staff are told and can refund again with a new key', async () => {
    const r = rigOf()
    const m = await r.member()
    const rf = await billing(m.membershipId, 'refund-last', {}, { 'idempotency-key': 'refund-last-key-0101' })
    expect(rf.status, JSON.stringify(rf.body)).toBe(200)
    await r.drain()
    const inv0 = await h.db.selectFrom('square_subscription_invoices').selectAll().executeTakeFirstOrThrow()
    expect(inv0).toMatchObject({ refunded_cents: 12900, refund_status: 'PENDING' })
    const first = inv0.square_refund_id!
    r.sim.store.failRefund(first, 'FAILED')
    const notes = await r.drain()
    expect(notes.join('\n')).toMatch(/membership refund failed: cleared, staff told/)
    expect(await h.db.selectFrom('square_subscription_invoices').selectAll().executeTakeFirstOrThrow()).toMatchObject({
      refunded_cents: 0,
      refunded_at: null,
      refund_status: 'FAILED',
      square_refund_id: first,
    })
    expect(await h.db.selectFrom('notifications').select('kind').where('kind', '=', 'membership.refund_failed').execute()).not.toEqual([])
    // the failure again (a duplicate delivery) changes nothing; a new try is a new refund
    const failedEvent = r.sim.store.events.find((e) => e.type === 'refund.updated' && e.data.id === first)!
    expect(await r.replay(failedEvent)).toMatch(/already cleared/)
    const again = await billing(m.membershipId, 'refund-last', {}, { 'idempotency-key': 'refund-last-key-0102' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(r.sim.store.refunds.size).toBe(2)
    expect(r.sim.sim.log.filter((x) => x.path === '/v2/refunds').at(-1)!.idempotencyKey).toBe(sqKey('rf', `membership-invoice:${inv0.id}:after:${first}`))
    // Square completes it: the row says so, and nothing reaches the ledger
    await r.advance(10_000)
    await r.drain()
    const done = await h.db.selectFrom('square_subscription_invoices').selectAll().executeTakeFirstOrThrow()
    expect(done).toMatchObject({ refunded_cents: 12900, refund_status: 'COMPLETED' })
    expect(done.square_refund_id).not.toBe(first)
    expect(await h.db.selectFrom('ledger_events').select('id').where('type', '=', 'refund').execute()).toEqual([])
  })

  it('refuse: a membership Square does not bill, watch-only, a missing permission', async () => {
    const r = rigOf()
    const m = await r.member()
    const manual = h.newId()
    const other = await h.customer({ phone: PHONES.other, name: 'Ana Reyes' })
    const plan = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()
    await h.db
      .insertInto('memberships')
      .values({ id: manual, location_id: h.locationId, customer_id: other, plan_id: plan.id, plan_label: 'Gold', status: 'active', source: 'manual', started_at: h.clock.now(), review_flags: '[]' })
      .execute()
    expect((await billing(manual, 'pause')).body).toMatchObject({ status: 409, code: 'MEMBERSHIP_NOT_BILLED_BY_SQUARE' })
    expect((await billing('00000000-0000-4000-8000-000000000009', 'pause')).body).toMatchObject({ status: 404, code: 'MEMBERSHIP_NOT_FOUND' })
    expect((await billing(m.membershipId, 'pause', {}, { 'x-test-permissions': 'cli.view' })).body).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    const { configureSquareRuntime } = await import('../../src/modules/square/runtime.js')
    configureSquareRuntime({ env: { ...r.env, SQUARE_WRITES_ENABLED: false }, api: () => r.sim.api })
    expect((await billing(m.membershipId, 'pause')).body).toMatchObject({ status: 409, code: 'SQUARE_WRITES_OFF' })
  })
})

describe('editing a Square membership', () => {
  it('a patch changes only auto-apply and the note; status, plan, size, label and renewal answer 409 MEMBERSHIP_BILLED_BY_SQUARE', async () => {
    const r = rigOf()
    const m = await r.member()
    for (const body of [{ status: 'paused' }, { planKey: 'vip' }, { planClass: 'truck' }, { planLabel: 'Gold+' }, { renewsOn: '2026-08-01' }]) {
      const res = await staff('PATCH', `/memberships/${m.membershipId}`, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(409)
      expect(res.json()).toMatchObject({ code: 'MEMBERSHIP_BILLED_BY_SQUARE' })
    }
    const ok = await staff('PATCH', `/memberships/${m.membershipId}`, { autoApply: true, note: 'prefers mornings' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ membership: { autoApply: true, status: 'active', source: 'square' } })
    expect((await r.membership(m.membershipId)).manual_status_at).toBeNull()
  })
})

describe('Move members (plan decision 8)', () => {
  it('a price edit is grandfathered; Move members tells them, then swaps after the notice; Square moves them at the next billing date', async () => {
    const r = rigOf()
    const m = await r.member()
    const newer = await r.price('gold', 'compact_car', 13900)
    expect((await r.membership(m.membershipId)).tier_price_id).not.toBe(newer)
    const mv = await staff('POST', '/catalog/tiers/gold/move-members', { notice: 30 })
    expect(mv.statusCode, mv.body).toBe(200)
    expect(mv.json()).toEqual({ tierKey: 'gold', moving: 1, skipped: 0, swapAfter: new Date(h.clock.now().getTime() + 30 * DAY).toISOString() })
    expect((await h.texts(PHONES.maria)).find((t) => /membership will be/.test(t.body))?.body).toMatch(/^Hi Maria, your Oasis Auto Spa Gold membership will be \$139\/month from your first bill after Mon, Jul 13\. Questions\? Just reply here\./)
    expect(await h.db.selectFrom('outbox_emails').select(['template', 'to_email']).where('template', '=', 'membership_price_change').execute()).toEqual([
      { template: 'membership_price_change', to_email: 'maria.delgado@gmail.com' },
    ])
    let row = await r.membership(m.membershipId)
    expect(row.scheduled_change).toMatchObject({ kind: 'move', toTierPriceId: newer, monthlyCents: 13900, effectiveDate: null })
    // before the notice ends nothing is sent
    expect(await r.swaps()).toMatchObject({ sent: 0 })
    await r.advance(30 * DAY)
    await r.drain() // the July renewal, still at the old price
    expect((await h.db.selectFrom('square_subscription_invoices').select('amount_cents').orderBy('due_date', 'desc').executeTakeFirstOrThrow()).amount_cents).toBe(12900)
    expect(await r.swaps()).toMatchObject({ sent: 1 })
    expect(await r.swaps()).toMatchObject({ sent: 0 })
    row = await r.membership(m.membershipId)
    expect(row.scheduled_change).toMatchObject({ kind: 'move', effectiveDate: '2026-08-13' })
    await r.advance(31 * DAY)
    await r.drain()
    row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ tier_price_id: newer, scheduled_change: null })
    expect((await h.db.selectFrom('square_subscription_invoices').select('amount_cents').orderBy('due_date', 'desc').executeTakeFirstOrThrow()).amount_cents).toBe(13900)
  })

  it('refuses while the new prices are not at Square, and leaves a member with a staff change alone', async () => {
    const r = rigOf()
    const m = await r.member()
    await r.price('gold', 'compact_car', 13900, { sync: false })
    expect((await staff('POST', '/catalog/tiers/gold/move-members', {})).json()).toMatchObject({ status: 409, code: 'TIER_PRICE_NOT_SYNCED' })
    await r.price('gold', 'compact_car', 14900)
    await r.price('vip', 'compact_car', 19900)
    await billing(m.membershipId, 'change', { planKey: 'vip' })
    expect((await staff('POST', '/catalog/tiers/gold/move-members', {})).json()).toMatchObject({ moving: 0, skipped: 1 })
  })
})
