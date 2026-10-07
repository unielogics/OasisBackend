import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { creditSummaries } from '../../src/modules/memberships/credits.js'
import { loadPlans } from '../../src/modules/memberships/plans.js'
import { retentionOf, memberMonths, upgradeOf, visitCounts } from '../../src/modules/memberships/retention.js'
import { runMembershipCycle } from '../../src/modules/memberships/service.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { useTestDb } from '../helpers/db.js'

describe('the memberships seed profile', () => {
  const clock = new FixedClock(PARITY_NOW)
  const t = useTestDb({ clock })

  it('seeds the four plans and the design members, without Squarespace ids, idempotently', async () => {
    await runSeed({ db: t.db, clock, profile: 'memberships' })
    const rows = await t.db
      .selectFrom('memberships as m')
      .innerJoin('customers as c', 'c.id', 'm.customer_id')
      .innerJoin('membership_plans as p', 'p.id', 'm.plan_id')
      .select(['c.full_name', 'm.plan_label', 'p.key', 'm.status', 'm.source', 'm.sqsp_subscription_ref', 'm.sqsp_customer_id', 'm.last_sqsp_order_id', 'm.current_period_end', 'm.started_at'])
      .orderBy('c.full_name')
      .execute()
    expect(rows.map((r) => [r.full_name, r.plan_label, r.key])).toEqual([
      ['Aisha Rahman', 'Exotic', 'exotic'],
      ['Elena Volkov', 'Exotic', 'exotic'],
      ['Jonathan Franco', 'Premium Care', 'premium'],
      ['Maria Delgado', 'Essential', 'essential'],
      ['Nathan Brooks', 'Essential', 'essential'],
      ['Priya Nair', 'Premium', 'premium'],
      ['Sofia Marchetti', 'Executive', 'executive'],
    ])
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'active', source: 'manual', sqsp_subscription_ref: null, sqsp_customer_id: null, last_sqsp_order_id: null })
      // the design's renewal date, Jul 12 (noon-free: midnight New York of the day after "yesterday" + 1 month)
      expect(r.current_period_end?.toISOString()).toBe('2026-07-12T04:00:00.000Z')
    }
    // months active follow the design's 8 + visits % 6
    const months = Object.fromEntries(rows.map((r) => [r.full_name, memberMonths(r.started_at, clock.now())]))
    expect(months).toMatchObject({ 'Maria Delgado': 11, 'Priya Nair': 13, 'Jonathan Franco': 8, 'Sofia Marchetti': 9, 'Aisha Rahman': 13, 'Elena Volkov': 12 })
    // credits: Priya has used one of her two Premium credits this cycle, everyone else none
    const ms = await t.db.selectFrom('memberships').selectAll().execute()
    const plans = await loadPlans(t.db, ms[0]!.location_id)
    const credits = await creditSummaries(t.db, ms.map((m) => ({ id: m.id, planId: m.plan_id, currentPeriodStart: m.current_period_start })), plans)
    const byName = async (name: string) => {
      const c = await t.db.selectFrom('customers').select('id').where('full_name', '=', name).executeTakeFirstOrThrow()
      return credits.get(ms.find((m) => m.customer_id === c.id)!.id)!
    }
    expect(await byName('Priya Nair')).toMatchObject({ creditsLeft: 1, creditsUsed: 1 })
    expect(await byName('Maria Delgado')).toMatchObject({ creditsLeft: 2, creditsUsed: 0 })
    expect(await byName('Sofia Marchetti')).toMatchObject({ creditsLeft: null, creditsUsed: 0 })
    expect(await byName('Aisha Rahman')).toMatchObject({ creditsLeft: null })
    expect(await t.db.selectFrom('sqsp_products').select('id').execute()).toHaveLength(0)
    // a second run adds nothing
    const before = await t.db.selectFrom('membership_credit_events').select('id').execute()
    await runSeed({ db: t.db, clock, profile: 'memberships' })
    expect(await t.db.selectFrom('memberships').select('id').execute()).toHaveLength(7)
    expect(await t.db.selectFrom('membership_credit_events').select('id').execute()).toHaveLength(before.length)
    expect(await t.db.selectFrom('membership_plans').select('id').execute()).toHaveLength(4)
  })
})

describe('the daily membership cycle', () => {
  const clock = new FixedClock('2026-06-13T10:36:00-04:00')
  const t = useTestDb({ clock })

  it('rolls manual memberships forward by the billing interval and grants each cycle’s credits once', async () => {
    await runSeed({ db: t.db, clock, profile: 'memberships' })
    const loc = (await ensureLocation(t.db, createIdGenerator(clock))).id
    const d = { locationId: loc, clock, newId: createIdGenerator(clock) }
    const first = await runMembershipCycle(t.db, d)
    expect(first.rolled).toBe(0)
    expect(first.creditsGranted).toBe(0) // the seed already granted this cycle
    // two and a half months later the period has been rolled twice (Jun 12 -> Jul 12 -> Aug 12 -> Sep 12) and credits granted for the new cycle
    clock.set('2026-09-01T03:00:00-04:00')
    const next = await runMembershipCycle(t.db, d)
    expect(next.rolled).toBe(7)
    // one grant per rule: Essential 2 members x 1 rule, Premium 2 x 1, Executive 1 x 2, Exotic 2 x 1
    expect(next.creditsGranted).toBe(8)
    const m = await t.db.selectFrom('memberships').select(['current_period_start', 'current_period_end']).where('plan_label', '=', 'Essential').executeTakeFirstOrThrow()
    expect(m.current_period_end!.getTime()).toBeGreaterThan(clock.now().getTime())
    expect(m.current_period_start!.getTime()).toBeLessThanOrEqual(clock.now().getTime())
    const again = await runMembershipCycle(t.db, d)
    expect(again).toEqual({ rolled: 0, creditsGranted: 0 })
    // used credits do not carry: the new cycle starts full
    const ms = await t.db.selectFrom('memberships').selectAll().execute()
    const plans = await loadPlans(t.db, loc)
    const credits = await creditSummaries(t.db, ms.map((x) => ({ id: x.id, planId: x.plan_id, currentPeriodStart: x.current_period_start })), plans)
    const priya = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Priya Nair').executeTakeFirstOrThrow()
    expect(credits.get(ms.find((x) => x.customer_id === priya.id)!.id)).toMatchObject({ creditsLeft: 2, creditsUsed: 0 })
  })

  it('paused and canceled members are not rolled or granted credits', async () => {
    await runSeed({ db: t.db, clock, profile: 'memberships' })
    const loc = (await ensureLocation(t.db, createIdGenerator(clock))).id
    await t.db.updateTable('memberships').set({ status: 'paused' }).execute()
    clock.set('2026-09-01T03:00:00-04:00')
    const r = await runMembershipCycle(t.db, { locationId: loc, clock, newId: createIdGenerator(clock) })
    expect(r).toEqual({ rolled: 0, creditsGranted: 0 })
  })
})

describe('retention and upgrade candidacy', () => {
  const now = new Date('2026-06-13T14:36:00Z')
  const DAY = 86_400_000

  it('Loyal when the last 30 days have a visit and no fewer than the 30 before', () => {
    expect(retentionOf({ cur30: 1, prev30: 1 }, null, now)).toMatchObject({ state: 'loyal', label: 'Loyal · low risk', desc: 'Consistent monthly usage — strong retention', tone: 'green' })
    expect(retentionOf({ cur30: 3, prev30: 1 }, null, now).state).toBe('loyal')
    expect(retentionOf({ cur30: 1, prev30: 0 }, null, now).state).toBe('loyal')
  })

  it('Watch with the missed visits and the design wording otherwise', () => {
    expect(retentionOf({ cur30: 1, prev30: 3 }, null, now)).toMatchObject({ state: 'watch', label: 'Watch · 2 missed visits', desc: 'Down from 3 to 1 visit last month', tone: 'red' })
    expect(retentionOf({ cur30: 0, prev30: 1 }, null, now)).toMatchObject({ label: 'Watch · 1 missed visit', desc: 'Down from 1 to 0 visits last month' })
    expect(retentionOf({ cur30: 0, prev30: 0 }, new Date(now.getTime() - 90 * DAY), now)).toMatchObject({ state: 'watch', label: 'Watch · 1 missed visit' })
    expect(retentionOf({ cur30: 2, prev30: 3 }, null, now).label).toBe('Watch · 1 missed visit')
  })

  it('a member who joined in the last 30 days with no visits is a new member, not at risk', () => {
    expect(retentionOf({ cur30: 0, prev30: 0 }, new Date(now.getTime() - 10 * DAY), now)).toMatchObject({ state: 'new', label: 'New member', tone: 'green' })
    expect(retentionOf({ cur30: 0, prev30: 0 }, new Date(now.getTime() - 31 * DAY), now).state).toBe('watch')
  })

  it('upgrade candidate from 3 completed visits in 60 days, with the real count in the copy', () => {
    expect(upgradeOf('Tom Bradley', 2)).toEqual({ candidate: false, visits60: 2, copy: null })
    expect(upgradeOf('Tom Bradley', 3).copy).toBe('Tom Bradley is a strong upgrade candidate — 3 visits in 60 days. Offer Essential at check-out.')
    expect(upgradeOf('Tom Bradley', 4).copy).toContain('4 visits in 60 days')
  })

  it('member months: whole months since the start, at least one', () => {
    expect(memberMonths(new Date('2025-07-13T00:00:00Z'), now)).toBe(11)
    expect(memberMonths(new Date('2025-07-14T00:00:00Z'), now)).toBe(10)
    expect(memberMonths(new Date('2026-06-12T00:00:00Z'), now)).toBe(1)
  })

  describe('visit counts from real appointments', () => {
    const clock = new FixedClock('2026-06-13T10:36:00-04:00')
    const t = useTestDb({ clock })
    it('counts completed visits only, per window, by completion time', async () => {
      await runSeed({ db: t.db, clock, profile: 'domain-design' })
      const loc = (await ensureLocation(t.db, createIdGenerator(clock))).id
      const c = await t.db.selectFrom('customers').select('id').where('full_name', '=', 'Maria Delgado').executeTakeFirstOrThrow()
      const svc = await t.db.selectFrom('services').select(['id', 'name']).where('kind', '=', 'package').limit(1).executeTakeFirstOrThrow()
      const add = async (daysAgo: number, status: 'completed' | 'canceled' | 'booked') => {
        const at = new Date(clock.now().getTime() - daysAgo * DAY)
        await t.db
          .insertInto('appointments')
          .values({
            id: createIdGenerator(clock)(), location_id: loc, customer_id: c.id, service_id: svc.id, package_name: svc.name, price_cents: 1000, duration_min: 30,
            status, scheduled_start: at, scheduled_end: new Date(at.getTime() + 1_800_000), completed_at: status === 'completed' ? at : null,
          })
          .execute()
      }
      await add(1, 'completed')
      await add(29, 'completed')
      await add(31, 'completed')
      await add(59, 'completed')
      await add(61, 'completed')
      await add(5, 'canceled')
      await add(-2, 'booked')
      const counts = (await visitCounts(t.db, loc, [c.id], clock.now())).get(c.id)
      expect(counts).toEqual({ cur30: 2, prev30: 2, visits60: 4, visitCount: 5 })
      expect((await visitCounts(t.db, loc, [], clock.now())).size).toBe(0)
    })
  })
})
