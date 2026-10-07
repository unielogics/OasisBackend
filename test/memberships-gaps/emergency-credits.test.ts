// Gap 3b: no credit is lost because the shop closed. With "Protect member credits" on, an emergency closure marks the credits the
// affected visits hold (a `protect` marker that changes no count); when such a visit is then canceled or marked no-show the
// credit is given back (`restore`); a reschedule keeps it attached to the moved visit. Without the toggle, or for a visit the
// closure did not touch, nothing is restored.
import { describe, expect, it } from 'vitest'
import { grantCycleCredits } from '../../src/modules/memberships/credits.js'
import { loadPlans } from '../../src/modules/memberships/plans.js'
import {
  activityOf,
  completeAs,
  creditEvents,
  creditsOf,
  idemKey,
  ledgerOf,
  setRuleAutoApply,
  useRig,
  type Rig,
} from '../scheduling-gaps/support.js'

const SAT = '2026-06-13T14:00:00-04:00'
const MON = '2026-06-15T10:00:00-04:00'

const closeShop = (m: Rig, credits = true) =>
  m.send(
    m.superS(),
    'POST',
    '/emergency/close',
    { reason: 'Power outage', dur: 'today', credits, notify: false },
    idemKey(),
  )
const cancel = (m: Rig, id: string) =>
  m.send(m.superS(), 'POST', `/appointments/${id}/cancel`, { reason: 'Shop closed' }, idemKey())
const apply = (m: Rig, id: string) =>
  m.send(m.superS(), 'POST', `/appointments/${id}/membership-perks/apply`, {})

async function memberWithCredit(m: Rig, start = SAT) {
  const mem = await m.member('Maria Delgado', 'essential')
  const a = await m.book('Maria Delgado', 'Express Hand Wash', start)
  expect((await apply(m, a.appointmentId)).statusCode).toBe(201)
  expect((await creditsOf(m, mem.customerId)).left).toBe(1)
  return { mem, a }
}

describe('emergency closure and member credits', () => {
  const m = useRig()

  it('marks the credit a visit holds (protect) without changing the count, then restores it when the visit is canceled', async () => {
    const { mem, a } = await memberWithCredit(m)
    const closed = await closeShop(m)
    expect(closed.statusCode, closed.body).toBe(201)
    const flagged = await m.h.t.db
      .selectFrom('appointments')
      .select('emergency_closure_id')
      .where('id', '=', a.appointmentId)
      .executeTakeFirstOrThrow()
    expect(flagged.emergency_closure_id).not.toBeNull()
    const protect = await creditEvents(m, mem.id, ['protect'])
    expect(protect).toEqual([
      expect.objectContaining({
        qty: 1,
        appointment_id: a.appointmentId,
        note: 'Emergency closure · credit protected',
      }),
    ])
    expect((await creditsOf(m, mem.customerId)).left).toBe(1) // still attached to the visit: a marker moves nothing

    const res = await cancel(m, a.appointmentId)
    expect(res.statusCode, res.body).toBe(200)
    const restores = await creditEvents(m, mem.id, ['restore'])
    expect(restores).toEqual([
      expect.objectContaining({
        qty: 1,
        appointment_id: a.appointmentId,
        note: 'Emergency closure · credit restored',
      }),
    ])
    expect((await creditsOf(m, mem.customerId)).left).toBe(2)
    expect(await activityOf(m, a.appointmentId)).toContain(
      'Membership credit restored · emergency closure (Express wash)',
    )
  })

  it('a replayed cancel restores once', async () => {
    const { mem, a } = await memberWithCredit(m)
    await closeShop(m)
    const key = idemKey()
    const body = { reason: 'Shop closed' }
    await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, body, key)
    await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, body, key)
    expect(await creditEvents(m, mem.id, ['restore'])).toHaveLength(1)
    expect((await creditsOf(m, mem.customerId)).left).toBe(2)
  })

  it('a no-show on a flagged visit restores it too', async () => {
    const { mem, a } = await memberWithCredit(m)
    await closeShop(m)
    m.h.clock.set('2026-06-13T14:11:00-04:00')
    const res = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/no-show`, {}, idemKey())
    expect(res.statusCode, res.body).toBe(200)
    expect(await creditEvents(m, mem.id, ['restore'])).toHaveLength(1)
    expect((await creditsOf(m, mem.customerId)).left).toBe(2)
  })

  it('with "Protect member credits" off nothing is marked and a cancel does not give the credit back', async () => {
    const { mem, a } = await memberWithCredit(m)
    await closeShop(m, false)
    expect(await creditEvents(m, mem.id, ['protect'])).toHaveLength(0)
    await cancel(m, a.appointmentId)
    expect(await creditEvents(m, mem.id, ['restore'])).toHaveLength(0)
    expect((await creditsOf(m, mem.customerId)).left).toBe(1)
  })

  it('a visit the closure did not touch (an ordinary cancel) keeps its credit used', async () => {
    const { mem, a } = await memberWithCredit(m, MON)
    await closeShop(m) // closes today only; Monday is not affected
    await cancel(m, a.appointmentId)
    expect(await creditEvents(m, mem.id, ['protect', 'restore'])).toHaveLength(0)
    expect((await creditsOf(m, mem.customerId)).left).toBe(1)
  })

  it('a reschedule keeps the credit on the moved visit: one redeem, the same discount, no second use', async () => {
    const { mem, a } = await memberWithCredit(m)
    await setRuleAutoApply(m, 'essential', 'Express wash', true)
    await closeShop(m)
    const moved = await m.send(
      m.superS(),
      'POST',
      `/appointments/${a.appointmentId}/reschedule`,
      { start: MON },
      false,
    )
    expect(moved.statusCode, moved.body).toBe(200)
    expect((await creditsOf(m, mem.customerId)).left).toBe(1)
    await completeAs(m, a.appointmentId) // auto-apply is on, but this visit already holds its credit
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(1)
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'adjust')).toHaveLength(1)
    expect((await creditsOf(m, mem.customerId)).left).toBe(1)
  })

  it('after the cycle renewed, the restored credit comes back as a bonus in the new cycle (nothing to offset)', async () => {
    const { mem, a } = await memberWithCredit(m)
    await closeShop(m)
    const db = m.h.t.db
    const renewed = new Date('2026-06-14T12:00:00-04:00')
    await db
      .updateTable('memberships')
      .set({ current_period_start: renewed, current_period_end: new Date('2026-07-14T12:00:00-04:00') })
      .where('id', '=', mem.id)
      .execute()
    const plans = await loadPlans(db, m.locationId())
    await grantCycleCredits(
      db,
      { clock: m.h.clock, newId: m.h.t.app.newId },
      { id: mem.id, currentPeriodStart: renewed },
      plans.find((p) => p.key === 'essential')!,
    )
    expect((await creditsOf(m, mem.customerId)).left).toBe(2)
    await cancel(m, a.appointmentId)
    const after = await creditsOf(m, mem.customerId)
    expect(after.left).toBe(3)
    expect(after.used).toBe(0)
  })
})
