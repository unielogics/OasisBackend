// The billing block of a membership billed by Square as the dashboard reads it (wave Q3 dashapi, reusing wave Q3b's view): the plan
// size, the monthly price, the next charge date, the card with its label, the last paid and the last failed payment, and a scheduled
// change named in words; and the tier price grid with each cell's real Square state (synced, failed with its error, pending).
import { describe, expect, it } from 'vitest'
import { useLinksHarness } from '../public-links/harness.js'
import { DAY, useSquareMembers } from './rig.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const HOUR = 3_600_000

const staff = async (method: 'GET' | 'POST', url: string, payload: unknown = {}) => {
  const r = await h.t.app.inject({ method, url: `/api/v1${url}`, ...(method === 'POST' ? { payload: payload as object } : {}) })
  return { status: r.statusCode, body: r.json() as Json }
}
const billingOf = async (customerId: string): Promise<Json> => {
  const r = await staff('GET', `/customers/${customerId}/membership`)
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  return r.body.membership.billing
}

describe('the membership billing block', () => {
  it('an active member: size, price, next charge, the card, the last paid payment, nothing failed', async () => {
    const r = rigOf()
    const m = await r.member()
    const b = await billingOf(m.customerId)
    expect(b).toMatchObject({
      status: 'ok',
      squareStatus: 'ACTIVE',
      monthlyCents: 12900,
      planClassLabel: 'Compact car',
      nextChargeOn: '2026-07-13',
      card: { last4: '5858', label: 'Visa ••5858', state: 'active' },
      cancelAt: null,
      pauseAt: null,
      change: null,
      lastPaid: { amountCents: 12900, paidAt: expect.any(String), refundedCents: 0 },
      lastFailed: null,
    })
  })

  it('a scheduled cancel or pause leaves no next charge; a scheduled change is named in words', async () => {
    const r = rigOf()
    const m = await r.member()
    await r.price('vip', 'large_suv', 21900)
    const ch = await staff('POST', `/memberships/${m.membershipId}/billing/change`, { planKey: 'vip', planClass: 'large_suv' })
    expect(ch.status, JSON.stringify(ch.body)).toBe(200)
    expect(ch.body.membership.billing.change).toMatchObject({ planKey: 'vip', planName: expect.any(String), planClass: 'large_suv', planClassLabel: 'Large SUV', monthlyCents: 21900 })
    expect(ch.body.membership.billing.change.planName).not.toBe('')
    expect((await staff('POST', `/memberships/${m.membershipId}/billing/change/undo`)).status).toBe(200)
    const c = await staff('POST', `/memberships/${m.membershipId}/billing/cancel`)
    expect(c.body.membership.billing).toMatchObject({ cancelAt: '2026-07-13', nextChargeOn: null })
    await staff('POST', `/memberships/${m.membershipId}/billing/cancel/undo`)
    expect((await billingOf(m.customerId)).nextChargeOn).toBe('2026-07-13')
    const p = await staff('POST', `/memberships/${m.membershipId}/billing/pause`)
    expect(p.body.membership.billing).toMatchObject({ pauseAt: '2026-07-13', nextChargeOn: null })
  })

  it('a failed renewal: the last failed payment, no next charge date', async () => {
    const r = rigOf()
    const m = await r.member()
    const sub = r.sim.store.subscriptions.get(m.subscriptionId)!
    r.sim.store.cards.get(String(sub.card_id))!.enabled = false
    await r.advance(30 * DAY + 2 * HOUR)
    await r.drain()
    const b = await billingOf(m.customerId)
    expect(b).toMatchObject({
      status: 'failed',
      nextChargeOn: null,
      lastFailed: { amountCents: 12900, failedAt: expect.any(String), paid: false, payUrl: expect.stringMatching(/^https:\/\//) },
      lastPaid: { amountCents: 12900 },
    })
    expect(Date.parse(b.lastFailed.failedAt)).toBeGreaterThan(Date.parse(b.lastPaid.paidAt))
  })
})

describe('the tier price grid carries each cell’s Square state', () => {
  it('synced with its time; a failed sync with its error; a price not synced yet is pending', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    await r.price('gold', 'large_car', 14900, { sync: false })
    const tiers = await staff('GET', '/catalog/tiers')
    expect(tiers.status).toBe(200)
    const gold = (tiers.body.tiers as Json[]).find((t) => t.key === 'gold')!
    const cell = (cls: string) => (gold.prices as Json[]).find((p) => p.class === cls)
    expect(cell('compact_car')).toMatchObject({ monthlyCents: 12900, squareState: 'synced', squareError: null, squareSyncedAt: expect.any(String) })
    expect(cell('large_car')).toMatchObject({ monthlyCents: 14900, squareState: 'pending', squareError: null, squareSyncedAt: null })
    await h.db
      .updateTable('membership_tier_prices')
      .set({ square_state: 'failed', square_error: 'Square did not accept the price' })
      .where('class_key', '=', 'large_car')
      .where('superseded_at', 'is', null)
      .execute()
    const again = ((await staff('GET', '/catalog/tiers')).body.tiers as Json[]).find((t) => t.key === 'gold')!
    expect((again.prices as Json[]).find((p) => p.class === 'large_car')).toMatchObject({ squareState: 'failed', squareError: 'Square did not accept the price' })
  })
})
