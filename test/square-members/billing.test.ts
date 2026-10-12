// Billing by Square's events and the failure policy (ADR 0171 D10, plan decision 7, design 5.4 and 5.5) under a frozen clock: a
// paid cycle is applied once (period, credits) however often its events arrive; a failed renewal is day 0 (in grace, perks on, the
// client texted their card page and Square's invoice page, emailed, staff told), day 7 past due, day 21 canceled at Square with its
// open invoice; any payment restores; the daily job tells a client the event could not; the Squarespace inference leaves Square
// memberships alone.
import { describe, expect, it } from 'vitest'
import { creditSummaries } from '../../src/modules/memberships/credits.js'
import { loadPlans } from '../../src/modules/memberships/plans.js'
import { runBillingPolicy } from '../../src/modules/memberships/square/timeline.js'
import { PHONES, useLinksHarness } from '../public-links/harness.js'
import { DAY, useSquareMembers } from './rig.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)
const HOUR = 3_600_000

/** Gold includes two Express Hand Washes a cycle. */
async function goldIncludesWashes(): Promise<void> {
  const plan = await h.db.selectFrom('membership_plans').select('id').where('location_id', '=', h.locationId).where('key', '=', 'gold').executeTakeFirstOrThrow()
  await h.db.deleteFrom('membership_inclusions').where('plan_id', '=', plan.id).execute()
  const id = h.newId()
  await h.db.insertInto('membership_inclusions').values({ id, plan_id: plan.id, label: 'Express Hand Wash', mode: 'per_cycle', per_cycle: 2, sort: 0 }).execute()
  const svc = await h.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').where('location_id', '=', h.locationId).executeTakeFirstOrThrow()
  await h.db.insertInto('membership_inclusion_services').values({ inclusion_id: id, service_id: svc.id }).execute()
}

const grants = (membershipId: string) =>
  h.db.selectFrom('membership_credit_events').select(['cycle_start', 'qty', 'actor']).where('membership_id', '=', membershipId).where('kind', '=', 'grant').orderBy('cycle_start').execute()

describe('paid cycles', () => {
  it('apply once: the period from the due date to the charged-through date, the cycle’s credits granted once, however often the events come', async () => {
    await goldIncludesWashes()
    const r = rigOf()
    const m = await r.member()
    expect(await grants(m.membershipId)).toEqual([{ cycle_start: new Date('2026-06-13T04:00:00Z'), qty: 2, actor: 'Square' }])
    // every event delivered again (a duplicate webhook, the catch-up): nothing twice
    const notes = await r.drain()
    expect(notes).toEqual([])
    const all = r.sim.store.events.filter((e) => e.type.startsWith('invoice.') || e.type.startsWith('subscription.'))
    for (const e of all) await r.replay(e)
    expect(await grants(m.membershipId)).toHaveLength(1)
    expect((await r.membership(m.membershipId)).paid_order_count).toBe(1)
    // the next month renews: the new cycle and its credits
    await r.advance(31 * DAY)
    await r.drain()
    const row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'active', paid_order_count: 2 })
    expect(row.current_period_start).toEqual(new Date('2026-07-13T04:00:00Z'))
    expect(row.current_period_end).toEqual(new Date('2026-08-13T04:00:00Z'))
    expect((await grants(m.membershipId)).map((g) => g.cycle_start.toISOString())).toEqual(['2026-06-13T04:00:00.000Z', '2026-07-13T04:00:00.000Z'])
    const plans = await loadPlans(h.db, h.locationId)
    const summary = (await creditSummaries(h.db, [{ id: m.membershipId, planId: String(row.plan_id), currentPeriodStart: row.current_period_start as Date }], plans)).get(m.membershipId)!
    expect(summary.creditsLeft).toBe(2)
    const invoices = await h.db.selectFrom('square_subscription_invoices').select(['status', 'amount_cents', 'due_date', 'applied_at']).orderBy('due_date').execute()
    expect(invoices.map((i) => [i.status, i.amount_cents, i.due_date, i.applied_at !== null])).toEqual([
      ['PAID', 12900, '2026-06-13', true],
      ['PAID', 12900, '2026-07-13', true],
    ])
  })
})

describe('a failed renewal (day 0 / 7 / 21, plan decision 7)', () => {
  it('day 0 in grace with the card page texted; day 7 past due; a payment restores it with the new cycle', async () => {
    await goldIncludesWashes()
    const r = rigOf()
    const m = await r.member()
    // the card stops working before the renewal
    const sub = r.sim.store.subscriptions.get(m.subscriptionId)!
    r.sim.store.cards.get(String(sub.card_id))!.enabled = false
    await r.advance(30 * DAY + 2 * HOUR) // 2026-07-13 12:36
    await r.drain()
    let row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'active', billing_status: 'failed', in_grace: true })
    expect(row.payment_failed_at).toEqual(h.clock.now())
    expect(row.failure_notified_at).toEqual(h.clock.now())
    const text = (await h.texts(PHONES.maria)).find((t) => /go through/.test(t.body))!
    expect(text.klass).toBe('personal_link')
    expect(text.body).toMatch(
      /^Hi Maria, your Oasis Auto Spa Gold payment didn.t go through\. Update your card on this secure page: https:\/\/site\.example\.test\/#\/k\/[A-Za-z0-9_-]{43} Or pay this month here: https:\/\/app\.squareupsandbox\.com\/pay-invoice\/inv:0-[A-Z0-9]+ Your perks stay on while we sort it out\./,
    )
    const mail = await h.db.selectFrom('outbox_emails').select(['to_email', 'template']).where('template', '=', 'membership_payment_failed').execute()
    expect(mail).toEqual([{ to_email: 'maria.delgado@gmail.com', template: 'membership_payment_failed' }])
    expect(await h.db.selectFrom('notifications').select('kind').where('kind', '=', 'membership.payment_failed').execute()).not.toEqual([])
    // the failure event again: nothing twice
    await r.drain()
    expect((await h.texts(PHONES.maria)).filter((t) => /didn.t go through/.test(t.body))).toHaveLength(1)
    // day 6: still in grace, perks on
    await r.advance(6 * DAY)
    expect(await r.billing()).toMatchObject({ considered: 1, pastDue: 0 })
    expect((await r.membership(m.membershipId)).status).toBe('active')
    // day 7: past due (perks off)
    await r.advance(DAY)
    expect(await r.billing()).toMatchObject({ pastDue: 1 })
    row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'past_due', in_grace: false, billing_status: 'failed' })
    expect(await r.billing()).toMatchObject({ pastDue: 0, canceled: 0 })
    // the client pays from Square's invoice page: restored, the cycle that invoice paid for applied, its credits granted once
    const inv = await h.db.selectFrom('square_subscription_invoices').select('square_invoice_id').where('failed_at', 'is not', null).executeTakeFirstOrThrow()
    r.sim.store.payInvoice(inv.square_invoice_id, { nonce: 'cnon:card-nonce-ok' })
    await r.drain()
    row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'active', billing_status: 'ok', payment_failed_at: null, in_grace: false, paid_order_count: 2 })
    expect(row.current_period_start).toEqual(new Date('2026-07-13T04:00:00Z'))
    expect((await grants(m.membershipId)).map((g) => g.cycle_start.toISOString())).toEqual(['2026-06-13T04:00:00.000Z', '2026-07-13T04:00:00.000Z'])
    expect(await h.db.selectFrom('audit_log').select('action').where('action', '=', 'membership.square.restored').execute()).toHaveLength(1)
  })

  it('day 21: canceled at Square (the subscription and its open invoice), the membership canceled payment_failed; nothing twice', async () => {
    const r = rigOf()
    const m = await r.member()
    const sub = r.sim.store.subscriptions.get(m.subscriptionId)!
    r.sim.store.cards.get(String(sub.card_id))!.enabled = false
    await r.advance(30 * DAY + 2 * HOUR)
    await r.drain()
    await r.advance(21 * DAY)
    // watch-only: nothing can be canceled at Square, so nothing is canceled here either (the job tries again tomorrow)
    const off = await runBillingPolicy({ ...r.steps(), env: { ...r.env, SQUARE_WRITES_ENABLED: false } })
    expect(off).toMatchObject({ waiting: 1, canceled: 0 })
    expect(await r.billing()).toMatchObject({ canceled: 1 })
    const row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'canceled', cancel_reason: 'payment_failed', in_grace: false })
    const s = r.sim.store.subscriptions.get(m.subscriptionId)!
    expect(s.canceled_date).toBeTruthy()
    const failed = [...r.sim.store.invoices.values()].filter((i) => i.subscription_id === m.subscriptionId && i.status !== 'PAID')
    expect(failed.map((i) => i.status)).toEqual(['CANCELED'])
    expect(await h.db.selectFrom('notifications').select('kind').where('kind', '=', 'membership.canceled_unpaid').execute()).not.toEqual([])
    expect(await r.billing()).toMatchObject({ considered: 0 })
    // Square's events about it afterwards keep it canceled
    await r.drain()
    expect((await r.membership(m.membershipId)).status).toBe('canceled')
  })

  it('the daily job tells a client the invoice event could not (the notice failed or was lost)', async () => {
    const r = rigOf()
    const m = await r.member()
    const sub = r.sim.store.subscriptions.get(m.subscriptionId)!
    r.sim.store.cards.get(String(sub.card_id))!.enabled = false
    await r.advance(30 * DAY + 2 * HOUR)
    await r.drain()
    await h.db.updateTable('memberships').set({ failure_notified_at: null }).where('id', '=', m.membershipId).execute()
    await h.db.deleteFrom('outbox_emails').execute()
    expect(await r.billing()).toMatchObject({ told: 1 })
    expect((await r.membership(m.membershipId)).failure_notified_at).toEqual(h.clock.now())
    expect(await h.db.selectFrom('outbox_emails').select('template').execute()).toEqual([{ template: 'membership_payment_failed' }])
    expect(await r.billing()).toMatchObject({ told: 0 })
  })
})

describe('Square’s subscription status', () => {
  it('paused at Square is paused here, active again when resumed; canceled or deactivated is canceled', async () => {
    const r = rigOf()
    const m = await r.member()
    r.sim.store.pauseSubscription(m.subscriptionId, { pause_effective_date: '2026-06-14' })
    await r.advance(DAY)
    await r.drain()
    expect((await r.membership(m.membershipId)).status).toBe('paused')
    r.sim.store.resumeSubscription(m.subscriptionId, { resume_change_timing: 'IMMEDIATE' })
    await r.drain()
    expect((await r.membership(m.membershipId)).status).toBe('active')
    r.sim.store.cancelSubscription(m.subscriptionId)
    await r.drain()
    let row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'active', cancel_effective_at: '2026-07-13' })
    await r.advance(30 * DAY)
    await r.drain()
    row = await r.membership(m.membershipId)
    expect(row).toMatchObject({ status: 'canceled', cancel_reason: 'Canceled at Square', square_status: 'CANCELED', cancel_effective_at: null })
  })
})
