// Syncing the tier prices to Square's catalog (ADR 0171 wave Q3b, design 5.2, plan amendment 1: membership_tier_prices is the
// variation history): a plan per tier and a STATIC MONTHLY variation per current price; a price edit is a new variation and the old
// one stays for the members billed at it (grandfathered); a run is keyed (a repeat makes nothing twice); watch-only syncs nothing;
// a failure stays on the row and the managers are told; an unused superseded price is retired; the nightly drift check reports.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { loadCatalogState, runCatalogSync } from '../../src/modules/memberships/square/catalog-sync.js'
import { useLinksHarness } from '../public-links/harness.js'
import { useSquareMembers } from './rig.js'

const h = useLinksHarness()
const rigOf = useSquareMembers(h)

const rows = (tier = 'gold') =>
  h.db
    .selectFrom('membership_tier_prices as p')
    .innerJoin('membership_plans as pl', 'pl.id', 'p.plan_id')
    .select(['p.id', 'p.class_key', 'p.monthly_cents', 'p.superseded_at', 'p.square_variation_id', 'p.square_state', 'p.square_error'])
    .where('pl.key', '=', tier)
    .orderBy('p.effective_from')
    .orderBy('p.monthly_cents')
    .execute()

describe('the catalog sync', () => {
  it('makes one plan per tier and one STATIC MONTHLY variation per current price, once', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900, { sync: false })
    await r.price('gold', 'truck', 15900, { sync: false })
    const first = await runCatalogSync(r.steps(), h.locationId)
    expect(first).toMatchObject({ status: 'done', plansCreated: 1, variationsCreated: 2, failed: 0 })
    const plan = await h.db.selectFrom('membership_plans').select('square_plan_id').where('key', '=', 'gold').executeTakeFirstOrThrow()
    expect(plan.square_plan_id).toBeTruthy()
    const synced = await rows()
    expect(synced.map((x) => [x.class_key, x.square_state])).toEqual([
      ['compact_car', 'synced'],
      ['truck', 'synced'],
    ])
    for (const x of synced) {
      const v = r.sim.store.catalog.get(x.square_variation_id!)!
      expect(v.type).toBe('SUBSCRIPTION_PLAN_VARIATION')
      const data = v.subscription_plan_variation_data as { subscription_plan_id: string; phases: { cadence: string; pricing: { type: string; price_money: { amount: number } } }[] }
      expect(data.subscription_plan_id).toBe(plan.square_plan_id)
      expect(data.phases).toHaveLength(1)
      expect(data.phases[0]).toMatchObject({ cadence: 'MONTHLY', pricing: { type: 'STATIC', price_money: { amount: x.monthly_cents } } })
    }
    // a second run finds nothing to do and sends nothing
    const calls = r.sim.sim.log.length
    expect(await runCatalogSync(r.steps(), h.locationId)).toMatchObject({ status: 'done', plansCreated: 0, variationsCreated: 0 })
    expect(r.sim.sim.log.length).toBe(calls)
    const audits = await h.db.selectFrom('audit_log').select('action').where('action', '=', 'square.catalog.sync').execute()
    expect(audits).toHaveLength(1)
  })

  it('a price edit is a new variation; members keep the one they are billed at (grandfathered)', async () => {
    const r = rigOf()
    const m = await r.member()
    const before = await rows()
    expect(before).toHaveLength(1)
    const oldVariation = before[0]!.square_variation_id!
    await r.price('gold', 'compact_car', 13900)
    const after = await rows()
    expect(after.map((x) => [x.monthly_cents, x.superseded_at !== null, x.square_state])).toEqual([
      [12900, true, 'synced'],
      [13900, false, 'synced'],
    ])
    expect(after[1]!.square_variation_id).not.toBe(oldVariation)
    // the old variation is still at Square (a subscription uses it) and the member is still billed at it
    expect(r.sim.store.catalog.has(oldVariation)).toBe(true)
    expect(r.sim.store.subscriptions.get(m.subscriptionId)!.plan_variation_id).toBe(oldVariation)
    expect((await r.membership(m.membershipId)).tier_price_id).toBe(before[0]!.id)
    // a later run never retires a variation in use
    expect(await runCatalogSync(r.steps(), h.locationId)).toMatchObject({ retired: 0 })
  })

  it('retires a superseded price nobody used (deleted at Square), and keeps the reason when Square refuses', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    const unused = (await rows())[0]!
    await r.price('gold', 'compact_car', 13900, { sync: false })
    expect(await runCatalogSync(r.steps(), h.locationId)).toMatchObject({ retired: 1, variationsCreated: 1 })
    const gone = (await rows()).find((x) => x.id === unused.id)!
    expect(gone.square_state).toBe('retired')
    expect(r.sim.store.catalog.has(unused.square_variation_id!)).toBe(false)
  })

  it('watch-only (SQUARE_WRITES_ENABLED=false): skipped, nothing read or sent, the rows stay pending', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900, { sync: false })
    const out = await runCatalogSync({ ...r.steps(), env: { ...r.env, SQUARE_WRITES_ENABLED: false } }, h.locationId)
    expect(out).toMatchObject({ status: 'skipped' })
    expect(r.sim.sim.log).toEqual([])
    expect((await rows())[0]!.square_state).toBe('pending')
  })

  it('a refusal stays on the row (failed, with the reason), the managers are told, the next run tries again', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    await r.price('gold', 'truck', 15900, { sync: false })
    // every attempt of the client (4) answered 500
    r.sim.sim.injectFault({ status: 500, times: 4, path: '/v2/catalog/object' })
    expect(await runCatalogSync(r.steps(), h.locationId)).toMatchObject({ failed: 1, variationsCreated: 0 })
    const failed = (await rows()).find((x) => x.class_key === 'truck')!
    expect(failed.square_state).toBe('failed')
    expect(failed.square_error).toBe('Square did not answer')
    const told = await h.db.selectFrom('notifications').select(['kind', 'body']).where('kind', '=', 'square.catalog_sync_failed').execute()
    expect(told.length).toBeGreaterThan(0)
    expect(told[0]!.body).toContain('Square did not answer')
    expect(await runCatalogSync(r.steps(), h.locationId)).toMatchObject({ variationsCreated: 1, failed: 0 })
    expect((await rows()).find((x) => x.class_key === 'truck')!.square_state).toBe('synced')
  })

  it('the drift check reports a price changed at Square and makes a deleted, unused one again', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900)
    await r.price('gold', 'truck', 15900)
    const [car, truck] = await rows()
    // someone edits the compact car price in the Square Dashboard and deletes the truck one
    const v = r.sim.store.catalog.get(car!.square_variation_id!)!
    ;((v.subscription_plan_variation_data as { phases: { pricing: { price_money: { amount: number } } }[] }).phases[0]!.pricing.price_money).amount = 9900
    r.sim.store.catalog.delete(truck!.square_variation_id!)
    const out = await runCatalogSync(r.steps(), h.locationId, { drift: true })
    expect(out).toMatchObject({ drift: 1, recreated: 1 })
    const after = await rows()
    expect(after.find((x) => x.id === car!.id)).toMatchObject({ square_state: 'failed', square_error: 'Square bills this price at $99.00, not $129.00 a month' })
    expect(after.find((x) => x.id === truck!.id)).toMatchObject({ square_state: 'pending', square_variation_id: null })
    expect(await runCatalogSync(r.steps(), h.locationId)).toMatchObject({ variationsCreated: 1 })
    const state = await loadCatalogState(h.db, h.locationId)
    expect(state.rows.filter((x) => x.planId === state.tiers.find((t) => t.key === 'gold')!.planId && x.current).map((x) => x.squareState).sort()).toEqual(['failed', 'synced'])
  })

  it('POST /integrations/square/catalog/sync runs it now (set.billing)', async () => {
    const r = rigOf()
    await r.price('gold', 'compact_car', 12900, { sync: false })
    const res = await h.t.app.inject({ method: 'POST', url: '/api/v1/integrations/square/catalog/sync', payload: {} })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ status: 'done', plansCreated: 1, variationsCreated: 1 })
    expect((await sql<{ n: number }>`select count(*)::int as n from membership_tier_prices where square_state = 'synced'`.execute(h.db)).rows[0]!.n).toBe(1)
  })
})
