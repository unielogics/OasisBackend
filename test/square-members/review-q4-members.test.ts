// Review Q4: memberships billed by Square.
//   SQ-SEM-2  a swap Oasis deletes to schedule another (a second change, a move replacing an earlier swap) is undone for the period
//             like a staff undo: a change back to it is refused before Square locks the subscription (the simulator now locks it
//             as the sandbox did: SwapPlan 500 "locked", then DeleteSubscriptionAction 409 until the next billing).
//   F3        a price move is never billed sooner than the 30-day notice of plan decision 8.
//   F6        a staff "change" to the member's own tier and size never moves a grandfathered price (that is Move members).
import { describe, expect, it } from 'vitest'
import { moveMembers } from '../../src/modules/memberships/square/moves.js'
import { transaction } from '../../src/platform/db.js'
import { PHONES, useLinksHarness } from '../public-links/harness.js'
import { DAY, useSquareMembers } from './rig.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)

const staff = (method: 'POST' | 'PATCH', url: string, payload: unknown = {}) => h.t.app.inject({ method, url: `/api/v1${url}`, payload: payload as object })
const billing = async (id: string, action: string, body: unknown = {}) => {
  const r = await staff('POST', `/memberships/${id}/billing/${action}`, body)
  return { status: r.statusCode, body: r.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}
const variationOf = async (id: string) =>
  (await h.db.selectFrom('membership_tier_prices').select('square_variation_id').where('id', '=', id).executeTakeFirstOrThrow()).square_variation_id!

describe('a swap replaced at Square is undone for the period (review Q4 SQ-SEM-2)', () => {
  it('the simulator locks a subscription as the sandbox did: the same swap after its delete, then every delete', async () => {
    const r = rigOf()
    const m = await r.member()
    const a = await variationOf(await r.price('vip', 'large_suv', 21900))
    const sw = await r.sim.api.subscriptions.swapPlan(m.subscriptionId, { new_plan_variation_id: a })
    const act = sw.actions.find((x) => x.type === 'SWAP_PLAN')!
    await r.sim.api.subscriptions.deleteAction(m.subscriptionId, act.id)
    await expect(r.sim.api.subscriptions.swapPlan(m.subscriptionId, { new_plan_variation_id: a })).rejects.toThrow(/locked and is not billable/)
    const pause = await r.sim.api.subscriptions.pause(m.subscriptionId, {})
    const p = pause.actions.find((x) => x.type === 'PAUSE')!
    await expect(r.sim.api.subscriptions.deleteAction(m.subscriptionId, p.id)).rejects.toThrow(/Unable to lock/)
  })

  it('change A, then B, then back to A: refused (A was undone by B), the subscription is never locked; cancel still works', async () => {
    const r = rigOf()
    const m = await r.member()
    const aId = await r.price('vip', 'large_suv', 21900)
    await r.price('vip', 'truck', 23900)
    expect((await billing(m.membershipId, 'change', { planKey: 'vip', planClass: 'large_suv' })).status).toBe(200)
    expect((await billing(m.membershipId, 'change', { planKey: 'vip', planClass: 'truck' })).status).toBe(200)
    expect((await r.membership(m.membershipId)).swap_undone_variations).toEqual([await variationOf(aId)])
    const back = await billing(m.membershipId, 'change', { planKey: 'vip', planClass: 'large_suv' })
    expect(back.body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE', detail: expect.stringMatching(/^That change was undone this billing period/) })
    expect(r.sim.store.retrieveSubscription(m.subscriptionId).actions.map((x) => x.type)).toEqual(['SWAP_PLAN'])
    const c = await billing(m.membershipId, 'cancel')
    expect(c.status, JSON.stringify(c.body)).toBe(200)
    expect((await billing(m.membershipId, 'cancel/undo')).status).toBe(200)
  })

  it('a price move that replaces a swap already at Square records it as undone', async () => {
    const r = rigOf()
    const m = await r.member()
    const other = await variationOf(await r.price('vip', 'large_suv', 21900))
    await r.price('gold', 'compact_car', 13900)
    expect((await staff('POST', '/catalog/tiers/gold/move-members', { notice: 30 })).statusCode).toBe(200)
    await r.advance(30 * DAY)
    await r.drain()
    // a swap scheduled at Square outside this membership's scheduled change (the Square dashboard, an earlier run)
    await r.sim.api.subscriptions.swapPlan(m.subscriptionId, { new_plan_variation_id: other })
    expect(await r.swaps()).toMatchObject({ sent: 1 })
    expect((await r.membership(m.membershipId)).swap_undone_variations).toEqual([other])
  })
})

describe('the price-move notice is at least 30 days (review Q4 F3)', () => {
  it('Move members refuses a notice under 30 days; the move itself never schedules sooner', async () => {
    const r = rigOf()
    await r.member()
    await r.price('gold', 'compact_car', 13900)
    const short = await staff('POST', '/catalog/tiers/gold/move-members', { notice: 0 })
    expect(short.statusCode).toBe(422)
    const out = await transaction(h.db, (tx) => moveMembers(tx, { ...r.steps(), locationId: h.locationId } as never, { tierKey: 'gold', noticeDays: 0, by: 'Test' }))
    expect(out.swapAfter).toBe(new Date(h.clock.now().getTime() + 30 * DAY).toISOString())
    expect((await h.texts(PHONES.maria)).find((t) => /membership will be/.test(t.body))?.body).toMatch(/from your first bill after Mon, Jul 13\./)
  })
})

describe('a change to the member’s own tier and size (review Q4 F6)', () => {
  it('is refused for a grandfathered member: the new price moves only with Move members and its notice', async () => {
    const r = rigOf()
    const m = await r.member()
    await r.price('gold', 'compact_car', 13900)
    const same = await billing(m.membershipId, 'change', { planKey: 'gold' })
    expect(same.body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE', detail: expect.stringMatching(/use Move members/) })
    expect(r.sim.store.retrieveSubscription(m.subscriptionId).actions).toEqual([])
    const sized = await billing(m.membershipId, 'change', { planKey: 'gold', planClass: 'compact_car' })
    expect(sized.body).toMatchObject({ status: 409, code: 'MEMBERSHIP_BILLING_STATE' })
  })
})
