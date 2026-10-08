// The demo seed: the design's day on today's date as it stands at the moment the seed runs, its money and texts, the Payments
// history and the calendar around today. Run at several times of day (and on a DST day) and through the CLI on a fresh schema.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { profiles, resolveProfiles, runSeed } from '../../db/seeds/index.js'
import { DEMO_PLAN, demoStateAt, historyAwaitingInvoiceNo } from '../../db/seeds/demo.js'
import { designInvoices } from '../../db/seeds/payments.js'
import { DESIGN_APPOINTMENTS } from '../../db/seeds/scheduling.js'
import { productionExternalAlerts } from '../../src/composition.js'
import { dbMembershipPort } from '../../src/modules/memberships/port.js'
import { createGatewayFor } from '../../src/modules/payments/module.js'
import { ledgerRevenueSource } from '../../src/modules/payments/revenue.js'
import { invoiceList } from '../../src/modules/payments/reports.js'
import type { SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { InMemoryMessageQueue } from '../../src/modules/scheduling/ports.js'
import { loadSnapshot } from '../../src/modules/scheduling/snapshot.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { migrateUp } from '../../src/platform/migrate.js'
import { addDays, bizDayBounds, parseT, toBizDate, wallToInstant } from '../../src/platform/time.js'
import { schemaPrefix, truncateAll, useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const TZ = 'America/New_York'
const t = useTestDb({ truncate: false })
const clock = (): FixedClock => t.clock as FixedClock

async function seedAt(iso: string, db: Db = t.db): Promise<void> {
  clock().set(iso)
  await runSeed({ db, clock: clock(), profile: 'demo' })
}

const n = async (db: Db, q: ReturnType<typeof sql<{ n: number }>>): Promise<number> =>
  (await q.execute(db)).rows[0]!.n

async function counts(db: Db = t.db): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of [
    'appointments',
    'appointment_addons',
    'job_checklist_items',
    'appointment_photos',
    'activity_log',
    'customers',
    'vehicles',
    'invoices',
    'invoice_items',
    'ledger_events',
    'credit_allocations',
    'memberships',
    'messages',
  ])
    out[table] = await n(db, sql<{ n: number }>`select count(*)::int as n from ${sql.id(table)}`)
  return out
}

function portsCtx(): SchedulingCtx {
  const c = clock()
  return {
    clock: c,
    newId: createIdGenerator(c),
    locationId: '',
    tz: TZ,
    ports: {
      invoices: createGatewayFor({ clock: c, newId: createIdGenerator(c) }),
      messages: new InMemoryMessageQueue(),
      memberships: dbMembershipPort,
      externalAlerts: productionExternalAlerts,
      revenue: ledgerRevenueSource,
    } as never,
  }
}

async function snapshot(db: Db = t.db) {
  const c = portsCtx()
  c.locationId = (await db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
  return loadSnapshot(db, c, { window: 'today', canContact: true, manager: true })
}

const DESIGN_TODAY = DESIGN_APPOINTMENTS.filter((a) => a.day === 0)

/** Everything the seed wrote happened at or before the clock it ran with. */
async function assertNothingInTheFuture(db: Db, now: Date): Promise<void> {
  const late = await sql<{ what: string; n: number }>`
    select 'ledger' as what, count(*)::int as n from ledger_events where occurred_at > ${now}
    union all select 'activity', count(*)::int from activity_log where at > ${now}
    union all select 'messages', count(*)::int from messages where queued_at > ${now}
    union all select 'checklist', count(*)::int from job_checklist_items where done and done_at > ${now}
    union all select 'arrived', count(*)::int from appointments where arrived_at > ${now} or cleaning_started_at > ${now}
      or completed_at > ${now} or picked_up_at > ${now} or created_at > ${now}
    union all select 'photos', count(*)::int from appointment_photos where taken_at > ${now}`.execute(db)
  expect(late.rows.filter((r) => r.n > 0)).toEqual([])
}

async function assertCoherent(db: Db, now: Date): Promise<void> {
  await assertNothingInTheFuture(db, now)
  // one invoice per live appointment, never two invoices with one number, and the design numbers on the design's people
  const dupes = await n(
    db,
    sql<{
      n: number
    }>`select count(*)::int as n from (select invoice_no from invoices group by invoice_no having count(*) > 1) x`,
  )
  expect(dupes).toBe(0)
  const orphans = await n(
    db,
    sql<{ n: number }>`select count(*)::int as n from appointments a
      where a.status not in ('canceled', 'no_show') and not exists (select 1 from invoices i where i.appointment_id = a.id)`,
  )
  expect(orphans).toBe(0)
  const counter = await n(db, sql<{ n: number }>`select next_no as n from invoice_counters`)
  expect(await n(db, sql<{ n: number }>`select max(invoice_no)::int as n from invoices`)).toBeLessThan(
    counter,
  )
  // a bay holds one car, and a car in a bay has a bay
  const cleaning = await db
    .selectFrom('appointments')
    .select(['bay_id', 'status'])
    .where('status', '=', 'cleaning')
    .execute()
  expect(cleaning.every((r) => r.bay_id !== null)).toBe(true)
  expect(new Set(cleaning.map((r) => r.bay_id)).size).toBe(cleaning.length)
  // card money still waiting on Squarespace: exactly one staff card payment
  const awaiting = await db
    .selectFrom('ledger_events')
    .select(['method', 'last4', 'method_kind'])
    .where('processor_state', '=', 'awaiting_processor')
    .execute()
  expect(awaiting).toHaveLength(1)
  expect(awaiting[0]).toMatchObject({ method_kind: 'card', last4: null })
  // the invoice money adds up: never paid beyond the total
  const overpaid = await n(
    db,
    sql<{
      n: number
    }>`select count(*)::int as n from invoices i cross join lateral invoice_calc_of(i.id) c where c.paid > c.total`,
  )
  expect(overpaid).toBe(0)
}

describe('demo seed', () => {
  it('is registered and runs with the design, memberships and geofence profiles', () => {
    expect(profiles.demo).toMatchObject({ dependsOn: ['design', 'memberships', 'geofence'] })
    const order = resolveProfiles('design,demo')
    expect(order.slice(-1)).toEqual(['demo'])
    for (const p of ['people', 'domain', 'base', 'domain-design', 'design', 'memberships', 'geofence'])
      expect(order).toContain(p)
    expect(new Set(order).size).toBe(order.length)
  })

  it('at 10:36 AM reproduces the design board on today’s date', async () => {
    await truncateAll(t.db)
    await seedAt('2026-10-08T10:36:00-04:00')
    const today = '2026-10-08'
    const rows = await t.db
      .selectFrom('appointments as a')
      .innerJoin('customers as c', 'c.id', 'a.customer_id')
      .select([
        'c.full_name',
        'a.status',
        'a.scheduled_start',
        'a.pickup_state',
        'a.eta_minutes',
        'a.geo_checked_in_at',
      ])
      .where('a.scheduled_start', '>=', bizDayBounds(today, TZ).start)
      .where('a.scheduled_start', '<', bizDayBounds(today, TZ).end)
      .execute()
    expect(rows).toHaveLength(DESIGN_TODAY.length)
    const by = Object.fromEntries(rows.map((r) => [r.full_name, r]))
    for (const a of DESIGN_TODAY) {
      expect(by[a.customer]!.status, a.id).toBe(a.status)
      expect(by[a.customer]!.scheduled_start).toEqual(wallToInstant(today, parseT(a.time), TZ))
      if (a.status === 'completed') expect(by[a.customer]!.pickup_state).toBe(a.pickup)
      expect(by[a.customer]!.eta_minutes ?? undefined, a.id).toBe(a.eta)
    }
    expect(by['Sofia Marchetti']!.geo_checked_in_at).toEqual(wallToInstant(today, parseT('10:27 AM'), TZ))

    // the money the design shows: paid, deposit or unpaid, on the Payments design's invoice numbers
    const inv = await sql<{
      client_name: string
      invoice_no: number
      paid: number
      total: number
      status: string
      tip: number
    }>`
      select i.client_name, i.invoice_no, c.paid, c.total, c.status, i.tip_cents as tip
      from invoices i cross join lateral invoice_calc_of(i.id) c where i.biz_date = ${today}`.execute(t.db)
    const money = Object.fromEntries(inv.rows.map((r) => [r.client_name, r]))
    expect(
      Object.fromEntries(
        inv.rows.filter((r) => r.invoice_no <= 20608).map((r) => [r.invoice_no, r.client_name]),
      ),
    ).toEqual({
      20601: 'Maria Delgado',
      20602: 'David Okafor',
      20603: 'Priya Nair',
      20604: 'Jonathan Franco',
      20605: 'Sofia Marchetti',
      20606: 'Liam Chen',
      20607: 'Marcus Webb',
      20608: 'Aisha Rahman',
    })
    // Payments design golden values: INV-20604 19688, INV-20608 57780, INV-20602 39450, INV-20605 27820 (deposit 5000),
    // INV-20607 13375 (deposit 2000), INV-20603 16478 unpaid
    expect(money['Jonathan Franco']).toMatchObject({ total: 19688, paid: 19688 })
    expect(money['Aisha Rahman']).toMatchObject({ total: 57780, paid: 57780 })
    expect(money['David Okafor']).toMatchObject({ total: 39450, paid: 39450, tip: 2000 })
    expect(money['Sofia Marchetti']).toMatchObject({ total: 27820, paid: 5000, status: 'partially_paid' })
    expect(money['Marcus Webb']).toMatchObject({ total: 13375, paid: 2000, status: 'partially_paid' })
    expect(money['Priya Nair']).toMatchObject({ total: 16478, paid: 0, status: 'unpaid' })
    for (const name of ['Grace Adeyemi', 'Tom Bradley', 'Elena Volkov'])
      expect(money[name]).toMatchObject({ paid: 0 })
    expect(Object.keys(money)).toHaveLength(DESIGN_TODAY.length)

    // David's counter payment (10:07 AM) is the latest card taken at the counter: it reads "Payment pending"
    const snap = await snapshot()
    const cards = [...snap.timeline.groups.flatMap((g) => g.items), ...snap.completed.items]
    const david = cards.find((c) => c.customer.name === 'David Okafor')!
    expect(david.pay).toMatchObject({ kind: 'pending', label: 'Payment pending' })
    const jonathan = snap.bays.find((b) => b.occupant)!
    expect(jonathan.occupant).toBeTruthy()
    expect(snap.timeline.count + snap.completed.count).toBeGreaterThan(0)
    // Marcus is late, exactly as in the design
    expect(cards.find((c) => c.customer.name === 'Marcus Webb')!.late).toBe(true)
    await assertCoherent(t.db, clock().now())
  })

  it.each([
    ['before opening', '2026-10-08T06:45:00-04:00'],
    ['mid-morning', '2026-10-08T09:20:00-04:00'],
    ['early afternoon', '2026-10-08T13:10:00-04:00'],
    ['after closing', '2026-10-08T19:30:00-04:00'],
    ['the day the clocks go back', '2026-11-01T14:00:00-05:00'],
  ])(
    '%s: statuses follow the time of day, nothing is in the future, the board is not empty',
    async (_label, iso) => {
      await truncateAll(t.db)
      await seedAt(iso)
      const now = clock().now()
      const today = toBizDate(now, TZ)
      const rows = await t.db
        .selectFrom('appointments as a')
        .innerJoin('customers as c', 'c.id', 'a.customer_id')
        .select(['c.full_name', 'a.status'])
        .where('a.scheduled_start', '>=', bizDayBounds(today, TZ).start)
        .where('a.scheduled_start', '<', bizDayBounds(today, TZ).end)
        .execute()
      const status = Object.fromEntries(rows.map((r) => [r.full_name, r.status]))
      for (const a of DESIGN_TODAY)
        expect(status[a.customer], a.id).toBe(demoStateAt(a, today, TZ, now).status)
      const snap = await snapshot()
      const shown = snap.timeline.count + snap.completed.count + snap.bays.filter((b) => b.occupied).length
      expect(shown).toBeGreaterThanOrEqual(DESIGN_TODAY.length)
      await assertCoherent(t.db, now)
    },
  )

  it('before any counter payment of the day, yesterday’s last card payment is the one awaiting Squarespace', async () => {
    await truncateAll(t.db)
    await seedAt('2026-10-08T07:30:00-04:00')
    const no = historyAwaitingInvoiceNo(designInvoices())!
    const row = await t.db
      .selectFrom('ledger_events as e')
      .innerJoin('invoices as i', 'i.id', 'e.invoice_id')
      .select(['i.invoice_no', 'i.biz_date', 'e.method'])
      .where('e.processor_state', '=', 'awaiting_processor')
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ invoice_no: no, biz_date: '2026-10-07' })
    expect(row.method).not.toMatch(/••/)
    const list = await invoiceList(
      t.db,
      {
        locationId: (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id,
        now: clock().now(),
        tz: TZ,
      },
      { range: '7d', filter: 'all', q: `INV-${no}`, limit: 5 },
    )
    expect(list.items.map((x) => [x.invoiceNo, x.awaiting])).toEqual([[no, 'payment']])
  })

  it('is idempotent, and its history and calendar have the expected shape', async () => {
    await truncateAll(t.db)
    await seedAt('2026-10-08T12:00:00-04:00')
    const first = await counts()
    clock().set('2026-10-08T12:05:00-04:00')
    await runSeed({ db: t.db, clock: clock(), profile: 'demo' })
    expect(await counts()).toEqual(first)

    const history = designInvoices().filter((i) => i.off < 0)
    const linked = await n(
      t.db,
      sql<{ n: number }>`select count(*)::int as n from invoices where invoice_no between 20506 and 20610
        and appointment_id is not null and biz_date < '2026-10-08'`,
    )
    expect(linked).toBe(history.length)
    // the history keeps its design facts: the pending refund, the canceled job, store credit
    const pending = await t.db
      .selectFrom('ledger_events as e')
      .innerJoin('invoices as i', 'i.id', 'e.invoice_id')
      .select(['i.invoice_no', 'i.client_name', 'e.amount_cents'])
      .where('e.type', '=', 'refund')
      .where('e.status', '=', 'pending')
      .execute()
    expect(pending).toEqual([{ invoice_no: 20579, client_name: 'Chloe Bennett', amount_cents: 8000 }])
    const canceled = await t.db
      .selectFrom('invoices as i')
      .innerJoin('appointments as a', 'a.id', 'i.appointment_id')
      .select(['a.status'])
      .where('i.invoice_no', '=', 20571)
      .executeTakeFirstOrThrow()
    expect(canceled.status).toBe('canceled')
    // invoice numbers run with time: past procedural below the history, the history, today, then the future
    const ranges = await sql<{ band: string; lo: number; hi: number; from: string; to: string }>`
      select case when biz_date < ${addDays('2026-10-08', -29)} then 'past'
                  when biz_date < '2026-10-08' then 'history'
                  when biz_date = '2026-10-08' then 'today' else 'future' end as band,
             min(invoice_no)::int as lo, max(invoice_no)::int as hi, min(biz_date)::text as from, max(biz_date)::text as to
      from invoices group by 1 order by 2`.execute(t.db)
    const band = Object.fromEntries(ranges.rows.map((r) => [r.band, r]))
    expect(band.past!.hi).toBeLessThan(band.history!.lo)
    expect(band.history!.lo).toBe(20506)
    expect(band.today).toMatchObject({ lo: 20601 })
    expect(band.future!.lo).toBeGreaterThanOrEqual(20611)
    expect(band.past!.from).toBe(addDays('2026-10-08', -60))
    expect(band.future!.to <= addDays('2026-10-08', 60)).toBe(true)
    // every phone number the seed created is synthetic
    const real = await n(
      t.db,
      sql<{
        n: number
      }>`select count(*)::int as n from customers where phone_e164 is not null and phone_e164 !~ '^\\+1[0-9]{3}55501[0-9]{2}$'`,
    )
    expect(real).toBe(0)
    // members and texts of the design day
    expect(first.memberships).toBe(7)
    expect(first.messages).toBeGreaterThan(DESIGN_APPOINTMENTS.length)
    // the plan never puts two cars in one bay at the same time
    for (const bay of [1, 2] as const) {
      const spans = Object.values(DEMO_PLAN)
        .filter((p, i) => p.bay === bay && DESIGN_APPOINTMENTS[i]!.day === 0)
        .map((p) => [p.start, p.done] as const)
        .sort((x, y) => x[0] - y[0])
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1])
    }
  })

  it('pnpm seed -- --profile design,demo works on a fresh schema with the real clock', async () => {
    const schema = `${schemaPrefix}_democli`.slice(0, 63)
    const url = testDatabaseUrl()
    const admin = createDb({ url, poolMax: 1 })
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin)
    try {
      await migrateUp({ url }, { schema, clock: new FixedClock(Date.now()) })
      const run = spawnSync('pnpm', ['seed', '--', '--profile', 'design,demo', '--url', url], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 240_000,
        env: { ...process.env, DATABASE_URL: url, DB_SEARCH_PATH: `${schema},public`, CLOCK_FREEZE_AT: '' },
      })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('seeded: ')
      expect(run.stdout).toMatch(/-> demo\n/)
      const db = createDb({ url, searchPath: `${schema},public`, poolMax: 2 })
      try {
        clock().set(Date.now())
        const snap = await snapshot(db)
        expect(
          snap.timeline.count + snap.completed.count + snap.bays.filter((b) => b.occupied).length,
        ).toBeGreaterThan(0)
        const c = await counts(db)
        expect(c.appointments).toBeGreaterThan(300)
        expect(c.invoices).toBe(c.appointments) // the canceled history job keeps its canceled invoice
        await assertCoherent(db, clock().now())
      } finally {
        await db.destroy()
      }
    } finally {
      await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(admin)
      await admin.destroy()
    }
  }, 300_000)
})
