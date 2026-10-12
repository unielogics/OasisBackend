// The member side of the price book (ADR 0170) on the database: loadMemberContext (and MembershipPort.pricingFor) finds the ACTIVE
// membership a customer holds or shares as a live household member, with the tier's % off, VIP flag, plan size and the inclusions'
// credits; credits are granted and counted per inclusion; the VIP slot rules come from the tier's flag, not its key; and an old tier
// key (premium, executive) still resolves to its tier, from the staff routes to the Squarespace product map.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { loadMemberContext, loadPriceBook, quoteVisit } from '../../src/modules/catalog/price-book.js'
import { privilegesOf } from '../../src/modules/assistant/tools/common.js'
import { creditSummaries, eligibleInclusion, grantCycleCredits } from '../../src/modules/memberships/credits.js'
import { ensurePlans, loadPlans, planByKey } from '../../src/modules/memberships/plans.js'
import { dbMembershipPort } from '../../src/modules/memberships/port.js'
import { buildProductMap } from '../../src/modules/payments-sync/db/product-map.js'
import { makeCustomer, makeService, setupLocation } from '../domain-schema/helpers.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()
const START = new Date('2026-06-01T04:00:00Z')

async function world() {
  const f = await setupLocation(t)
  const wash = await makeService(t.db, f, { name: 'Express Hand Wash', priceCents: 4000 })
  const wax = await makeService(t.db, f, { kind: 'addon', name: 'Wax', priceCents: 3900 })
  await t.db.updateTable('services').set({ tags: ['express', 'handwash'] }).where('id', '=', wash).execute()
  await ensurePlans(t.db, { locationId: f.locationId, clock: t.clock, newId: f.newId })
  const plans = await loadPlans(t.db, f.locationId)
  const gold = planByKey(plans, 'gold')!
  // Gold: 10% off, one wash a cycle, wax on every visit
  await t.db.updateTable('membership_plans').set({ member_discount_bp: 1000 }).where('id', '=', gold.id).execute()
  await t.db.deleteFrom('membership_inclusions').where('plan_id', '=', gold.id).execute()
  const washInc = f.newId()
  const waxInc = f.newId()
  await t.db
    .insertInto('membership_inclusions')
    .values([
      { id: washInc, plan_id: gold.id, label: 'Hand wash', mode: 'per_cycle', per_cycle: 1, sort: 0 },
      { id: waxInc, plan_id: gold.id, label: 'Wax every wash', mode: 'every_visit', per_cycle: null, sort: 1 },
    ])
    .execute()
  await t.db
    .insertInto('membership_inclusion_services')
    .values([
      { inclusion_id: washInc, service_id: wash },
      { inclusion_id: waxInc, service_id: wax },
    ])
    .execute()
  const holder = await makeCustomer(t.db, f, { name: 'Maria Delgado' })
  const partner = await makeCustomer(t.db, f, { name: 'Luis Delgado' })
  const stranger = await makeCustomer(t.db, f, { name: 'Ana Ruiz' })
  const membershipId = f.newId()
  await t.db
    .insertInto('memberships')
    .values({
      id: membershipId,
      location_id: f.locationId,
      customer_id: holder,
      plan_id: gold.id,
      plan_label: 'Gold',
      status: 'active',
      source: 'manual',
      started_at: START,
      current_period_start: START,
      plan_class: 'compact_car',
    })
    .execute()
  return { f, wash, wax, gold, washInc, waxInc, holder, partner, stranger, membershipId }
}

describe('loadMemberContext and MembershipPort.pricingFor', () => {
  it('the holder: the tier’s % off, plan size, VIP flag and the inclusions with this cycle’s credits', async () => {
    const w = await world()
    await grantCycleCredits(t.db, { clock: t.clock, newId: w.f.newId }, { id: w.membershipId, currentPeriodStart: START }, (await loadPlans(t.db, w.f.locationId)).find((p) => p.id === w.gold.id)!)
    const ctx = await loadMemberContext(t.db, w.f.locationId, w.holder)
    expect(ctx).toEqual({
      membershipId: w.membershipId,
      holderId: w.holder,
      viaHousehold: false,
      planId: w.gold.id,
      tierKey: 'gold',
      tierName: 'Gold',
      discountBp: 1000,
      planClass: 'compact_car',
      vipBooking: false,
      inclusions: [
        { id: w.washInc, label: 'Hand wash', mode: 'per_cycle', left: 1, autoApply: true, serviceIds: [w.wash] },
        { id: w.waxInc, label: 'Wax every wash', mode: 'every_visit', left: null, autoApply: true, serviceIds: [w.wax] },
      ],
    })
    expect(await dbMembershipPort.pricingFor!(t.db, { locationId: w.f.locationId, customerId: w.holder })).toEqual(ctx)
    // a Large SUV visit: the wash covered up to the Compact car price, the wax on every visit, both size differences due
    await t.db
      .insertInto('service_class_prices')
      .values([
        { service_id: w.wash, location_id: w.f.locationId, class_key: 'compact_car', price_cents: 4000 },
        { service_id: w.wash, location_id: w.f.locationId, class_key: 'large_suv', price_cents: 6000 },
        { service_id: w.wax, location_id: w.f.locationId, class_key: 'compact_car', price_cents: 3900 },
      ])
      .execute()
    const q = quoteVisit(await loadPriceBook(t.db, w.f.locationId), { packageId: w.wash, addonIds: [w.wax], classKey: 'large_suv' }, ctx)
    expect(q.lines.map((l) => [l.listCents, l.coverage?.coveredCents, l.dueCents])).toEqual([
      [6000, 4000, 2000],
      [3900, 3900, 0],
    ])
  })

  it('a live household member shares it; a removed one, a stranger and a membership that is not active do not', async () => {
    const w = await world()
    const hh = w.f.newId()
    await t.db.insertInto('membership_household').values({ id: hh, membership_id: w.membershipId, customer_id: w.partner }).execute()
    expect(await loadMemberContext(t.db, w.f.locationId, w.partner)).toMatchObject({ membershipId: w.membershipId, holderId: w.holder, viaHousehold: true })
    expect(await loadMemberContext(t.db, w.f.locationId, w.stranger)).toBeNull()
    // one live household per customer
    await expect(
      t.db.insertInto('membership_household').values({ id: w.f.newId(), membership_id: w.membershipId, customer_id: w.partner }).execute(),
    ).rejects.toThrow(/uq_membership_household_customer_live/)
    await t.db.updateTable('membership_household').set({ removed_at: t.clock.now() }).where('id', '=', hh).execute()
    expect(await loadMemberContext(t.db, w.f.locationId, w.partner)).toBeNull()
    await t.db.updateTable('memberships').set({ status: 'paused' }).where('id', '=', w.membershipId).execute()
    expect(await loadMemberContext(t.db, w.f.locationId, w.holder)).toBeNull()
  })
})

describe('credits by inclusion', () => {
  it('grants one event per per_cycle inclusion (naming the inclusion), none for every_visit, once per cycle', async () => {
    const w = await world()
    const plan = (await loadPlans(t.db, w.f.locationId)).find((p) => p.id === w.gold.id)!
    const d = { clock: t.clock, newId: w.f.newId }
    expect(await grantCycleCredits(t.db, d, { id: w.membershipId, currentPeriodStart: START }, plan)).toBe(1)
    expect(await grantCycleCredits(t.db, d, { id: w.membershipId, currentPeriodStart: START }, plan)).toBe(0)
    const ev = await t.db.selectFrom('membership_credit_events').select(['kind', 'qty', 'inclusion_id', 'rule_id']).execute()
    expect(ev).toEqual([{ kind: 'grant', qty: 1, inclusion_id: w.washInc, rule_id: null }])
    const summary = (await creditSummaries(t.db, [{ id: w.membershipId, planId: plan.id, currentPeriodStart: START }], [plan])).get(w.membershipId)!
    expect(summary).toMatchObject({ creditsLeft: 1, creditsUsed: 0, rules: [{ ruleId: w.washInc, label: 'Hand wash', left: 1 }] })
    expect(eligibleInclusion(plan, summary, w.wash)).toMatchObject({ inclusion: { id: w.washInc }, covered: true })
    expect(eligibleInclusion(plan, summary, w.wax)).toMatchObject({ inclusion: { id: w.waxInc }, covered: true })
    // a redeem written before ADR 0170 (only rule_id) still counts, through the inclusion of the same id
    await sql`insert into plan_credit_rules (id, plan_id, label, include_tags, per_cycle) values (${w.washInc}, ${plan.id}, 'Hand wash', '{handwash}', 1)`.execute(t.db)
    await sql`insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id) values (${w.f.newId()}, ${w.membershipId}, ${START}, 'redeem', 1, ${w.washInc})`.execute(t.db)
    const after = (await creditSummaries(t.db, [{ id: w.membershipId, planId: plan.id, currentPeriodStart: START }], [plan])).get(w.membershipId)!
    expect(after).toMatchObject({ creditsLeft: 0, creditsUsed: 1 })
    expect(eligibleInclusion(plan, after, w.wash)).toMatchObject({ covered: false })
    // a turned-off inclusion is no credit
    await t.db.updateTable('membership_inclusions').set({ active: false }).where('id', '=', w.washInc).execute()
    const off = (await loadPlans(t.db, w.f.locationId)).find((p) => p.id === w.gold.id)!
    expect(eligibleInclusion(off, after, w.wash)).toBeUndefined()
  })
})

describe('tier keys and flags', () => {
  it('the VIP slot rules come from the tier’s vipBooking flag, not its key', async () => {
    const w = await world()
    expect(await privilegesOf(t.db, w.f.locationId, w.holder, t.clock.now())).toEqual({ member: true, vip: false })
    await t.db.updateTable('membership_plans').set({ vip_booking: true }).where('id', '=', w.gold.id).execute()
    expect(await privilegesOf(t.db, w.f.locationId, w.holder, t.clock.now())).toEqual({ member: true, vip: true })
    const vip = planByKey(await loadPlans(t.db, w.f.locationId), 'vip')!
    await t.db.updateTable('membership_plans').set({ vip_booking: false }).where('id', '=', vip.id).execute()
    await t.db.updateTable('memberships').set({ plan_id: vip.id }).where('id', '=', w.membershipId).execute()
    expect(await privilegesOf(t.db, w.f.locationId, w.holder, t.clock.now())).toEqual({ member: true, vip: false })
  })

  it('an old key names its tier: planByKey, and the Squarespace bootstrap map and product rows resolve to the current key', async () => {
    const w = await world()
    const plans = await loadPlans(t.db, w.f.locationId)
    expect(planByKey(plans, 'premium')?.key).toBe('gold')
    expect(planByKey(plans, 'executive')?.key).toBe('vip')
    expect(planByKey(plans, 'platinum')).toBeUndefined()
    const env = JSON.stringify([
      { sku: 'MEM-PREM', kind: 'membership', tier: 'premium' },
      { sku: 'MEM-EXEC', kind: 'membership', tierLabel: 'Executive Club' },
      { sku: 'MEM-VIP', kind: 'membership', tier: 'vip' },
    ])
    const map = await buildProductMap(t.db, w.f.locationId, env)
    expect(['MEM-PREM', 'MEM-EXEC', 'MEM-VIP'].map((sku) => map.resolve({ sku })?.tier)).toEqual(['gold', 'vip', 'vip'])
  })
})
