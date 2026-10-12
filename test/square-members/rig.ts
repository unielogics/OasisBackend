// The rig of the Square membership tests (ADR 0171 wave Q3b): the personal-link harness (the real app, the design seed, a frozen
// Saturday clock, personal links open) with the Square runtime pointed at a simulator on the same clock, Square as the processor and
// writes on; a tier priced at a size and synced to Square; Square's events processed through the real event processor and ingest
// handlers (as the webhook job does); the membership jobs run directly.
import { sql } from 'kysely'
import { afterEach, expect } from 'vitest'
import { loadEnv, type Env } from '../../src/config/env.js'
import type { WireEvent } from '../../src/integrations/square/wire.js'
import { runCatalogSync } from '../../src/modules/memberships/square/catalog-sync.js'
import { runEnrollmentJobs } from '../../src/modules/memberships/square/enroll.js'
import type { SquareSteps } from '../../src/modules/memberships/square/steps.js'
import { runBillingPolicy } from '../../src/modules/memberships/square/timeline.js'
import { runPlanSwaps } from '../../src/modules/memberships/square/moves.js'
import { squareCoreIngest } from '../../src/modules/square/handlers.js'
import { processSquareEvent } from '../../src/modules/square/ingest.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { CURRENT_CONSENT_VERSION } from '../../src/modules/square/consents.js'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars, silent } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { json, PHONES, type LinksHarness } from '../public-links/harness.js'

export const DAY = 86_400_000

export interface SquareMembersRig {
  sim: ReturnType<typeof simFor>
  env: Env
  steps(): SquareSteps
  /** Processes every Square event since the last call, in order, as the webhook job would. */
  drain(): Promise<string[]>
  /** Processes one event again (a duplicate delivery, the catch-up). */
  replay(e: { type: string }): Promise<string>
  /** A current price of a tier at a size, then synced to Square (unless sync: false). */
  price(tier: string, cls: string, cents: number, o?: { sync?: boolean }): Promise<string>
  /** A client on a membership page for the tier, verified by a texted code just now (a fresh step-up). */
  page(o?: { tier?: string; customerId?: string; phone?: string; name?: string }): Promise<{ customerId: string; session: string; linkId: string }>
  subscribe(session: string, body?: Record<string, unknown>): Promise<{ status: number; body: ReturnType<typeof json> }>
  status(session: string): Promise<ReturnType<typeof json>>
  /** A member through the membership page whose first invoice was paid: active. */
  member(o?: { tier?: string; cls?: string; phone?: string; name?: string }): Promise<{ customerId: string; membershipId: string; subscriptionId: string }>
  resume(): ReturnType<typeof runEnrollmentJobs>
  billing(): ReturnType<typeof runBillingPolicy>
  swaps(): ReturnType<typeof runPlanSwaps>
  membership(id: string): Promise<Record<string, unknown> & { status: string; billing_status: string }>
  advance(ms: number): Promise<void>
}

export function useSquareMembers(h: LinksHarness, vars: Record<string, string> = {}): () => SquareMembersRig {
  // the links harness deletes its clients before each test: what refers to them goes first; every simulator is new, so no tier
  // keeps a Square plan id of an earlier test's simulator
  afterEach(async () => {
    configureSquareRuntime({})
    await sql`truncate table square_enrollments, square_subscription_invoices, card_consents, square_charges, customer_cards,
      square_customer_links, square_payments, membership_tier_prices, memberships restart identity cascade`.execute(h.db)
    await sql`update membership_plans set square_plan_id = null`.execute(h.db)
    await sql`delete from webhook_log where provider = 'square'`.execute(h.db)
  })
  return () => {
    const sim = simFor(h.clock)
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      ...coreVars,
      SMS_ALLOWLIST: [PHONES.maria, PHONES.liam, PHONES.stranger, PHONES.other].join(','),
      SMS_DISPATCH_MODE: 'off',
      PUBLIC_SITE_URL: 'https://site.example.test',
      ...vars,
    })
    configureSquareRuntime({ env, api: () => sim.api })
    let cursor = 0
    const steps = (): SquareSteps => ({ db: h.db, clock: h.clock, newId: h.newId, env, api: sim.api, locationId: h.locationId, logger: silent })
    const rig: SquareMembersRig = {
      sim,
      env,
      steps,
      async drain() {
        const notes: string[] = []
        while (cursor < sim.store.events.length) {
          const e = sim.store.events[cursor++]!
          const r = await processSquareEvent(
            { db: h.db, clock: h.clock, logger: silent, env, api: sim.api, ingest: squareCoreIngest, locationId: h.locationId },
            e as unknown as WireEvent,
          )
          notes.push(`${e.type}: ${r.status}${r.note ? ` ${r.note}` : ''}`)
        }
        return notes
      },
      async replay(e) {
        const r = await processSquareEvent(
          { db: h.db, clock: h.clock, logger: silent, env, api: sim.api, ingest: squareCoreIngest, locationId: h.locationId },
          e as unknown as WireEvent,
        )
        return `${e.type}: ${r.status}${r.note ? ` ${r.note}` : ''}`
      },
      async price(tier, cls, cents, o = {}) {
        await ensureVehicleClasses(h.db, h.locationId)
        const plan = await h.db.selectFrom('membership_plans').select(['id', 'price_version']).where('location_id', '=', h.locationId).where('key', '=', tier).executeTakeFirstOrThrow()
        await h.db.updateTable('membership_tier_prices').set({ superseded_at: h.clock.now() }).where('plan_id', '=', plan.id).where('class_key', '=', cls).where('superseded_at', 'is', null).execute()
        const id = h.newId()
        await h.db
          .insertInto('membership_tier_prices')
          .values({ id, location_id: h.locationId, plan_id: plan.id, class_key: cls, monthly_cents: cents, price_version: plan.price_version + 1, effective_from: h.clock.now() })
          .execute()
        await h.db.updateTable('membership_plans').set({ price_version: plan.price_version + 1, active: true }).where('id', '=', plan.id).execute()
        if (o.sync !== false) expect((await runCatalogSync(steps(), h.locationId)).failed).toBe(0)
        return id
      },
      async page(o = {}) {
        const customerId = o.customerId ?? (await h.customer({ phone: o.phone ?? PHONES.maria, name: o.name ?? 'Maria Delgado' }))
        const p = await h.page({ customerId, kind: 'membership', planKey: o.tier ?? 'gold' })
        const v = await h.verifyByCode(p.session)
        expect(v.statusCode, v.body).toBe(200)
        return { customerId, session: p.session, linkId: p.link.id }
      },
      async subscribe(session, body = {}) {
        const r = await h.call('POST', 'membership/subscribe', {
          session,
          body: { email: 'maria.delgado@gmail.com', planClass: 'compact_car', sourceId: 'cnon:card-nonce-ok', consentVersion: CURRENT_CONSENT_VERSION, postalCode: '07026', ...body },
        })
        return { status: r.statusCode, body: json(r) }
      },
      async status(session) {
        const r = await h.call('GET', 'membership/status', { session })
        expect(r.statusCode, r.body).toBe(200)
        return json(r)
      },
      async member(o = {}) {
        await rig.price(o.tier ?? 'gold', o.cls ?? 'compact_car', 12900)
        const p = await rig.page({ tier: o.tier, phone: o.phone, name: o.name })
        const s = await rig.subscribe(p.session, { planClass: o.cls ?? 'compact_car' })
        expect(s.status, JSON.stringify(s.body)).toBe(202)
        await rig.drain()
        const m = await h.db.selectFrom('memberships').selectAll().where('customer_id', '=', p.customerId).orderBy('created_at', 'desc').executeTakeFirstOrThrow()
        expect(m.status).toBe('active')
        return { customerId: p.customerId, membershipId: m.id, subscriptionId: m.square_subscription_id! }
      },
      resume: () => runEnrollmentJobs(steps()),
      billing: () => runBillingPolicy(steps()),
      swaps: () => runPlanSwaps(steps()),
      membership: async (id) => (await h.db.selectFrom('memberships').selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as never,
      async advance(ms) {
        h.advance(ms)
        sim.store.tick()
      },
    }
    return rig
  }
}
