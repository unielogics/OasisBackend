// The pricing migrations (ADR 0170) on top of a database that already holds the shop's data: the default vehicle sizes for the
// existing location; today's guest prices and tint matrix copied to prices by size (nothing invented); vehicles' types mapped to
// sizes; premium and executive renamed gold and vip with the rename carried into personal links and checkouts; the credit rules
// copied to inclusions with the same id and the services their tags covered; the credit events pointing at them; the monthly
// prices copied to the append-only tier prices; every membership priced at a size; one redeem per appointment AND inclusion.
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { DEFAULT_VEHICLE_CLASSES } from '../../src/modules/catalog/vehicle-classes.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import { DEFAULT_MIGRATIONS_DIR, loadMigrationFiles, migrateUp } from '../../src/platform/migrate.js'
import { dropSchema, schemaPrefix } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const url = testDatabaseUrl()
const clock = new FixedClock('2026-10-12T14:36:00Z')
const schema = `${schemaPrefix}_mig_pricing`
const FIRST = '20261014100000_vehicle_classes_and_prices.sql'
let admin: Db

beforeAll(async () => {
  admin = createDb({ url, poolMax: 2 })
  await dropSchema(admin, schema)
})
afterAll(async () => {
  await dropSchema(admin, schema)
  await admin.destroy()
})

const LOC = '00000000-0000-7000-8000-0000000000d1'
const id = (prefix: string, n: number): string => `00000000-0000-7000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`
const svc = (n: number) => id('1', n)
const cust = (n: number) => id('2', n)
const veh = (n: number) => id('3', n)
const plan = (n: number) => id('4', n)
const rule = (n: number) => id('5', n)
const mem = (n: number) => id('6', n)
const appt = (n: number) => id('7', n)
const ev = (n: number) => id('8', n)
const link = (n: number) => id('9', n)

const MATRIX = {
  vehicleTypes: [
    { key: 'sedan', label: 'Sedan / Coupe' },
    { key: 'suv', label: 'SUV / Crossover' },
    { key: 'truck', label: 'Truck / Van' },
    { key: 'boat', label: 'Boat' },
  ],
  films: [{ key: 'carbon', label: 'Carbon', vlt: [5, 20, 35] }],
  prices: [
    { vehicle: 'sedan', film: 'carbon', memberMinCents: 22900, memberMaxCents: 27900, guestMinCents: 27500, guestMaxCents: 33500 },
    { vehicle: 'suv', film: 'carbon', memberMinCents: 26900, memberMaxCents: 26900, guestMinCents: 32300, guestMaxCents: 32300 },
    { vehicle: 'truck', film: 'carbon', memberMinCents: 24900, memberMaxCents: 29900, guestMinCents: 29900, guestMaxCents: 35900 },
    { vehicle: 'boat', film: 'carbon', memberMinCents: 99900, memberMaxCents: 99900, guestMinCents: 99900, guestMaxCents: 99900 },
  ],
}

describe('the pricing migrations on top of existing data', () => {
  it('backfill sizes, prices, tiers, inclusions, credit events and memberships, and carry the key rename everywhere', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-pricing-'))
    for (const f of loadMigrationFiles().filter((x) => x.name < FIRST)) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f.name), path.join(dir, f.name))
    await migrateUp({ url }, { schema, clock, dir })

    const db = createDb({ url, poolMax: 2, searchPath: `${schema},public` })
    try {
      await sql`insert into locations (id, name, slug) values (${LOC}, 'Oasis Auto Spa', 'oasis')`.execute(db)
      await sql`insert into settings (location_id, key, value) values
        (${LOC}, 'catalog.guest_markup_pct', '25'), (${LOC}, 'catalog.tint_matrix', ${JSON.stringify(MATRIX)}::jsonb)`.execute(db)
      const services: [number, string, string, string[], number | null, number | null][] = [
        [1, 'package', 'Signature Hand Wash', ['premium', 'handwash'], 4500, null], // guest = 45 x 1.25 = 56.25 -> $56
        [2, 'package', 'Exterior Hand Wash', ['express', 'handwash'], 3200, 4000], // its own guest price
        [3, 'package', 'Carbon window tint', ['tint', 'carbon'], null, null], // the matrix prices it
        [4, 'package', 'Old Package', ['premium', 'legacy'], null, null], // no member price: no cell
        [5, 'addon', 'Wax', [], 3900, null], // 39 x 1.25 = 48.75 -> $49
        [6, 'package', 'Premium Detail', ['premium', 'detail'], null, null],
      ]
      for (const [n, kind, name, tags, member, guest] of services)
        await sql`insert into services (id, location_id, kind, name, price_cents, duration_min, tags, member_price_cents, guest_price_cents)
          values (${svc(n)}, ${LOC}, ${kind}, ${name}, 4500, ${kind === 'addon' ? 0 : 60}, ${tags}::text[], ${member}, ${guest})`.execute(db)
      await sql`update services set category = 'tint' where id = ${svc(3)}`.execute(db)
      for (const n of [1, 2, 3]) await sql`insert into customers (id, full_name) values (${cust(n)}, ${`Client ${n}`})`.execute(db)
      const vehicles: [number, string | null][] = [
        [1, 'sedan_coupe'],
        [2, 'suv_crossover'],
        [3, 'truck_van'],
        [4, null],
      ]
      for (const [n, type] of vehicles)
        await sql`insert into vehicles (id, customer_id, make, model, vehicle_type) values (${veh(n)}, ${cust(1)}, 'Ford', 'F', ${type})`.execute(db)
      const plans: [number, string, string, string | null, number | null][] = [
        [1, 'essential', 'Essential', null, null],
        [2, 'premium', 'Premium', 'Gold', 9900],
        [3, 'executive', 'Executive', null, 16900],
        [4, 'exotic', 'Exotic', null, null],
      ]
      for (const [n, key, name, label, monthly] of plans)
        await sql`insert into membership_plans (id, location_id, key, name, color, bg_color, tint, sort, public_label, monthly_price_cents)
          values (${plan(n)}, ${LOC}, ${key}, ${name}, '#000000', '#FFFFFF', '#000000', ${n}, ${label}, ${monthly})`.execute(db)
      await sql`insert into plan_credit_rules (id, plan_id, label, include_tags, exclude_tags, per_cycle, auto_apply, sort) values
        (${rule(1)}, ${plan(2)}, 'Premium wash', '{premium}', '{detail}', 2, true, 0),
        (${rule(2)}, ${plan(3)}, 'Express wash', '{express}', '{}', null, false, 0)`.execute(db)
      const start = '2026-10-01T04:00:00Z'
      await sql`insert into memberships (id, location_id, customer_id, plan_id, plan_label, status, source, started_at, current_period_start, current_period_end)
        values (${mem(1)}, ${LOC}, ${cust(1)}, ${plan(2)}, 'Gold', 'active', 'manual', ${start}, ${start}, '2026-11-01T04:00:00Z'),
               (${mem(2)}, ${LOC}, ${cust(2)}, ${plan(4)}, 'Exotic', 'active', 'manual', ${start}, ${start}, '2026-11-01T04:00:00Z')`.execute(db)
      await sql`insert into appointments (id, location_id, customer_id, service_id, package_name, price_cents, duration_min, scheduled_start, scheduled_end)
        values (${appt(1)}, ${LOC}, ${cust(1)}, ${svc(1)}, 'Signature Hand Wash', 5600, 45, '2026-10-05T14:00:00Z', '2026-10-05T14:45:00Z')`.execute(db)
      await sql`insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, appointment_id, idempotency_key) values
        (${ev(1)}, ${mem(1)}, ${start}, 'grant', 2, ${rule(1)}, null, 'g1'),
        (${ev(2)}, ${mem(1)}, ${start}, 'redeem', 1, ${rule(1)}, ${appt(1)}, 'r1')`.execute(db)
      await sql`insert into client_links (id, location_id, token_hash, kind, customer_id, phone_e164, plan_key, epoch, issued_by, expires_at, max_uses)
        values (${link(1)}, ${LOC}, ${'a'.repeat(64)}, 'membership', ${cust(3)}, '+12015550101', 'premium', 1, 'staff', '2026-10-20T00:00:00Z', 1)`.execute(db)
      await sql`insert into memberships (id, location_id, customer_id, plan_id, plan_label, status, source, started_at)
        values (${mem(3)}, ${LOC}, ${cust(3)}, ${plan(3)}, 'VIP', 'pending', 'manual', ${start})`.execute(db)
      await sql`insert into membership_checkouts (id, location_id, membership_id, customer_id, link_id, plan_key, checkout_url, started_at, expires_at)
        values (${id('a', 1)}, ${LOC}, ${mem(3)}, ${cust(3)}, ${link(1)}, 'executive', 'https://oasis.squarespace.com/x', ${start}, '2026-10-04T04:00:00Z')`.execute(db)

      const rest = await migrateUp({ url }, { schema, clock })
      expect(rest.applied.slice(0, 3)).toEqual([
        '20261014100000_vehicle_classes_and_prices.sql',
        '20261014100100_membership_tiers.sql',
        '20261014100200_class_price_snapshots.sql',
      ])

      // the default sizes
      const classes = await sql<{ key: string; label: string; sort: number; active: boolean }>`
        select key, label, sort, active from vehicle_classes where location_id = ${LOC} order by sort`.execute(db)
      expect(classes.rows).toEqual(DEFAULT_VEHICLE_CLASSES.map((c) => ({ ...c, active: true })))

      // prices by size: guest prices at the first size, the tint matrix by vehicle type (an unknown type is skipped)
      const cells = await sql<{ service_id: string; class_key: string; price_cents: number; max_cents: number | null }>`
        select service_id, class_key, price_cents, max_cents from service_class_prices order by service_id, price_cents`.execute(db)
      expect(cells.rows.map((c) => [c.service_id, c.class_key, c.price_cents, c.max_cents])).toEqual([
        [svc(1), 'compact_car', 5600, null],
        [svc(2), 'compact_car', 4000, null],
        [svc(3), 'compact_car', 27500, 33500],
        [svc(3), 'truck', 29900, 35900],
        [svc(3), 'compact_suv', 32300, null],
        [svc(5), 'compact_car', 4900, null],
      ])
      const films = await sql<{ value: unknown }>`select value from settings where location_id = ${LOC} and key = 'catalog.tint_films'`.execute(db)
      expect(films.rows[0]!.value).toEqual(MATRIX.films)

      // vehicles: the type's size, said by the legacy backfill
      const vs = await sql<{ id: string; vehicle_class: string | null; vehicle_class_source: string | null }>`
        select id, vehicle_class, vehicle_class_source from vehicles order by id`.execute(db)
      expect(vs.rows.map((v) => [v.vehicle_class, v.vehicle_class_source])).toEqual([
        ['compact_car', 'legacy'],
        ['compact_suv', 'legacy'],
        ['truck', 'legacy'],
        [null, null],
      ])

      // tiers: renamed with the old key kept; the public name is the name; VIP books VIP; the unsold one off, the held one on
      const tiers = await sql<{ id: string; key: string; legacy_key: string | null; name: string; public: boolean; vip_booking: boolean; active: boolean; member_discount_bp: number; price_version: number }>`
        select id, key, legacy_key, name, public, vip_booking, active, member_discount_bp, price_version from membership_plans order by sort`.execute(db)
      expect(tiers.rows.map((t) => [t.key, t.legacy_key, t.name, t.public, t.vip_booking, t.active, t.member_discount_bp, t.price_version])).toEqual([
        ['essential', null, 'Essential', false, false, false, 0, 1],
        ['gold', 'premium', 'Gold', true, false, true, 0, 1],
        ['vip', 'executive', 'VIP', true, true, true, 0, 1],
        ['exotic', null, 'Exotic', false, false, true, 0, 1],
      ])
      // the rename followed the foreign keys into links and checkouts
      expect((await sql<{ plan_key: string }>`select plan_key from client_links`.execute(db)).rows).toEqual([{ plan_key: 'gold' }])
      expect((await sql<{ plan_key: string }>`select plan_key from membership_checkouts`.execute(db)).rows).toEqual([{ plan_key: 'vip' }])

      // tier prices: today's monthly price at the first size, version 1, pending for Square
      const prices = await sql<{ plan_id: string; class_key: string; monthly_cents: number; price_version: number; square_state: string; superseded_at: Date | null }>`
        select plan_id, class_key, monthly_cents, price_version, square_state, superseded_at from membership_tier_prices order by monthly_cents`.execute(db)
      expect(prices.rows).toEqual([
        { plan_id: plan(2), class_key: 'compact_car', monthly_cents: 9900, price_version: 1, square_state: 'pending', superseded_at: null },
        { plan_id: plan(3), class_key: 'compact_car', monthly_cents: 16900, price_version: 1, square_state: 'pending', superseded_at: null },
      ])

      // inclusions: same id as the rule, the services its tags covered (any include tag, no exclude tag)
      const inc = await sql<{ id: string; plan_id: string; label: string; mode: string; per_cycle: number | null; auto_apply: boolean }>`
        select id, plan_id, label, mode, per_cycle, auto_apply from membership_inclusions order by id`.execute(db)
      expect(inc.rows).toEqual([
        { id: rule(1), plan_id: plan(2), label: 'Premium wash', mode: 'per_cycle', per_cycle: 2, auto_apply: true },
        { id: rule(2), plan_id: plan(3), label: 'Express wash', mode: 'per_cycle', per_cycle: null, auto_apply: false },
      ])
      const covers = await sql<{ inclusion_id: string; service_id: string }>`
        select inclusion_id, service_id from membership_inclusion_services order by inclusion_id, service_id`.execute(db)
      expect(covers.rows.map((c) => [c.inclusion_id, c.service_id])).toEqual([
        [rule(1), svc(1)],
        [rule(1), svc(4)],
        [rule(2), svc(2)],
      ])
      // the rules stay as history
      expect((await sql<{ n: number }>`select count(*)::int as n from plan_credit_rules`.execute(db)).rows[0]!.n).toBe(2)

      // credit events point at the inclusion
      const evs = await sql<{ id: string; inclusion_id: string | null; rule_id: string | null }>`
        select id, inclusion_id, rule_id from membership_credit_events order by id`.execute(db)
      expect(evs.rows).toEqual([
        { id: ev(1), inclusion_id: rule(1), rule_id: rule(1) },
        { id: ev(2), inclusion_id: rule(1), rule_id: rule(1) },
      ])

      // every membership is priced at a size (required); a new row without one gets the smallest active size
      const ms = await sql<{ plan_class: string }>`select plan_class from memberships order by id`.execute(db)
      expect(ms.rows.map((m) => m.plan_class)).toEqual(['compact_car', 'compact_car', 'compact_car'])
      await sql`update vehicle_classes set active = false where key = 'compact_car'`.execute(db)
      await sql`insert into memberships (id, location_id, customer_id, plan_id, plan_label, status, source, started_at)
        values (${mem(4)}, ${LOC}, ${cust(2)}, ${plan(1)}, 'Essential', 'canceled', 'manual', ${start})`.execute(db)
      expect((await sql<{ plan_class: string }>`select plan_class from memberships where id = ${mem(4)}`.execute(db)).rows[0]!.plan_class).toBe('large_car')
      await expect(sql`update memberships set plan_class = null where id = ${mem(4)}`.execute(db)).rejects.toThrow(/null value/)
      await expect(sql`update memberships set plan_class = 'boat' where id = ${mem(4)}`.execute(db)).rejects.toThrow(/memberships_plan_class_fkey/)

      // one redeem per appointment and inclusion: a second inclusion on the same visit is allowed, the same one twice is not
      await sql`insert into membership_inclusions (id, plan_id, label, mode) values (${rule(9)}, ${plan(2)}, 'Wax every wash', 'every_visit')`.execute(db)
      await sql`insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, inclusion_id, appointment_id)
        values (${ev(3)}, ${mem(1)}, ${start}, 'redeem', 1, ${rule(9)}, ${appt(1)})`.execute(db)
      await expect(
        sql`insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, inclusion_id, appointment_id)
          values (${ev(4)}, ${mem(1)}, ${start}, 'redeem', 1, ${rule(1)}, ${appt(1)})`.execute(db),
      ).rejects.toThrow(/uq_credit_redeem_appointment/)
      // an every_visit inclusion has no count
      await expect(
        sql`insert into membership_inclusions (id, plan_id, label, mode, per_cycle) values (${rule(8)}, ${plan(2)}, 'x', 'every_visit', 2)`.execute(db),
      ).rejects.toThrow(/check/)

      // the key is a slug now; an old key cannot be taken twice
      await sql`insert into membership_plans (id, location_id, key, name, color, bg_color, tint) values (${plan(5)}, ${LOC}, 'platinum', 'Platinum', '#000000', '#FFFFFF', '#000000')`.execute(db)
      await expect(
        sql`insert into membership_plans (id, location_id, key, name, color, bg_color, tint) values (${plan(6)}, ${LOC}, 'Bad Key', 'x', '#000000', '#FFFFFF', '#000000')`.execute(db),
      ).rejects.toThrow(/membership_plans_key_check/)
      await expect(sql`update membership_plans set legacy_key = 'premium' where id = ${plan(5)}`.execute(db)).rejects.toThrow(/uq_membership_plans_legacy_key/)

      // the snapshots exist and start as legacy
      const snap = await sql<{ price_basis: string; vehicle_class: string | null }>`select price_basis, vehicle_class from appointments`.execute(db)
      expect(snap.rows).toEqual([{ price_basis: 'legacy', vehicle_class: null }])
    } finally {
      await db.destroy()
    }
  })
})
