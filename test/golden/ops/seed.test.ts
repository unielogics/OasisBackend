// The parity-ops seed: the twelve design appointments with their state, the procedural calendar days, idempotency, and
// independence from the injected clock.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { runSeed, profiles } from '../../../db/seeds/index.js'
import {
  DESIGN_APPOINTMENTS,
  PARITY_NOW_MS,
  designDayCount,
  designGenDay,
} from '../../../db/seeds/scheduling.js'
import { FixedClock } from '../../../src/platform/clock.js'
import { truncateAll, useTestDb } from '../../helpers/db.js'
import { original } from './parity.js'

const t = useTestDb({ truncate: false })

const counts = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        'appointments',
        'appointment_addons',
        'job_checklist_items',
        'appointment_photos',
        'activity_log',
        'customers',
        'vehicles',
        'invoices',
        'ledger_events',
        'memberships',
        'messages',
      ].map(
        async (table) =>
          [
            table,
            (await sql<{ n: number }>`select count(*)::int as n from ${sql.id(table)}`.execute(t.db)).rows[0]!
              .n,
          ] as const,
      ),
    ),
  )

describe('parity-ops', () => {
  it('is registered, depends on the design profile, and seeds the design day exactly', async () => {
    expect(profiles['parity-ops']).toMatchObject({ dependsOn: ['design'] })
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock: t.clock, profile: 'parity-ops' })
    const rows = await t.db
      .selectFrom('appointments as a')
      .innerJoin('customers as c', 'c.id', 'a.customer_id')
      .select([
        'a.id',
        'c.full_name',
        'a.status',
        'a.package_name',
        'a.eta_minutes',
        'a.geo_checked_in_at',
        'a.cleaning_started_at',
        'a.pickup_state',
        'a.special_instructions',
        'a.notes',
        'a.planned_bay_id',
        'a.bay_id',
      ])
      .where('a.scheduled_start', '>=', new Date('2026-06-13T04:00:00Z'))
      .where('a.scheduled_start', '<', new Date('2026-06-15T04:00:00Z'))
      .orderBy('a.seq')
      .execute()
    expect(rows).toHaveLength(12)
    const by = Object.fromEntries(rows.map((r) => [r.full_name, r]))
    expect(rows.map((r) => r.full_name)).toEqual(DESIGN_APPOINTMENTS.map((a) => a.customer))
    expect(Object.fromEntries(rows.map((r) => [r.full_name, r.status]))).toEqual({
      'Maria Delgado': 'completed',
      'David Okafor': 'completed',
      'Priya Nair': 'completed',
      'Jonathan Franco': 'cleaning',
      'Sofia Marchetti': 'arrived',
      'Liam Chen': 'confirmed',
      'Marcus Webb': 'confirmed',
      'Grace Adeyemi': 'booked',
      'Aisha Rahman': 'confirmed',
      'Tom Bradley': 'confirmed',
      'Elena Volkov': 'booked',
      'Nathan Brooks': 'confirmed',
    })
    expect(by['Jonathan Franco']!.cleaning_started_at!.getTime()).toBe(PARITY_NOW_MS - 27 * 60_000)
    expect(by['Jonathan Franco']!.bay_id).not.toBeNull()
    expect(by['Sofia Marchetti']!.geo_checked_in_at).toEqual(new Date('2026-06-13T10:27:00-04:00'))
    expect([
      by['Liam Chen']!.eta_minutes,
      by['Grace Adeyemi']!.eta_minutes,
      by['Marcus Webb']!.eta_minutes,
    ]).toEqual([12, 22, null])
    expect(by['Marcus Webb']!.planned_bay_id).toBeNull()
    expect(by['Priya Nair']!.pickup_state).toBe('pending')
    expect(by['Maria Delgado']!.pickup_state).toBe('collected')
    expect(by['Elena Volkov']!.special_instructions).toMatch(/^Hand-dry only/)
    expect(by['Priya Nair']!.notes).toBe('Customer prefers no fragrance products. Parked in the south lot.')
  })

  it("adds the design's procedural days as real rows, one per counted appointment, none today or tomorrow", async () => {
    const expected = original.dayCounts
      .filter((d) => d.offset !== 0 && d.offset !== 1)
      .reduce((n, d) => n + d.count, 0)
    const total = (await counts()).appointments!
    expect(total).toBe(12 + expected)
    const near = await t.db
      .selectFrom('appointments')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('scheduled_start', '>=', new Date('2026-06-13T04:00:00Z'))
      .where('scheduled_start', '<', new Date('2026-06-15T04:00:00Z'))
      .executeTakeFirstOrThrow()
    expect(near.n).toBe(12)
    // past days are finished and collected, future days are confirmed (70%) or booked
    const past = await t.db
      .selectFrom('appointments')
      .select('status')
      .where('scheduled_start', '<', new Date('2026-06-12T04:00:00Z'))
      .execute()
    expect(new Set(past.map((p) => p.status))).toEqual(new Set(['completed']))
    const future = await t.db
      .selectFrom('appointments')
      .select('status')
      .where('scheduled_start', '>=', new Date('2026-06-16T04:00:00Z'))
      .execute()
    expect(new Set(future.map((p) => p.status))).toEqual(new Set(['confirmed', 'booked']))
  })

  it('the design checklists, photo rows and activity are there', async () => {
    const c = await counts()
    expect(c.job_checklist_items).toBe(7 + 13 + 9 + 11 + 10 + 7 + 9 + 5 + 11 + 5 + 9 + 10)
    expect(c.appointment_addons).toBe(1 + 1 + 1 + 1 + 0 + 0 + 1 + 0 + 1 + 0 + 0 + 1)
    // arrival 2 (not booked) + before 3 (cleaning, completed) + after 2 (completed) + one issue note on every 4th
    expect(c.appointment_photos).toBe(2 * 10 + 3 * 4 + 2 * 3 + 3)
  })

  it('carries the design money: one invoice per appointment, payments as the design shows, the design members', async () => {
    const inv = await sql<{
      name: string
      no: number
      tip: number
      total: number
      paid: number
      balance: number
      status: string
      deposit: boolean | null
    }>`
      select c.full_name as name, i.invoice_no as no, i.tip_cents as tip, k.total, k.paid, k.balance, k.status,
             (select bool_or(e.deposit) from ledger_events e where e.invoice_id = i.id and e.type = 'pay') as deposit
      from invoices i
      join customers c on c.id = i.customer_id
      cross join lateral invoice_calc_of(i.id) k
      where i.appointment_id is not null
      order by i.invoice_no`.execute(t.db)
    expect(inv.rows).toHaveLength(12)
    expect(inv.rows.map((r) => r.no)).toEqual(Array.from({ length: 12 }, (_, i) => 20611 + i))
    const by = Object.fromEntries(inv.rows.map((r) => [r.name, r]))
    // a1 paid with an $8 tip, a2 paid with a $20 tip, a5 and a7 deposits, a3 and a8 unpaid (golden totals in cents)
    expect(by['Maria Delgado']).toMatchObject({
      tip: 800,
      total: 9895,
      paid: 9895,
      balance: 0,
      status: 'paid',
    })
    expect(by['David Okafor']).toMatchObject({ tip: 2000, total: 42125, balance: 0 })
    expect(by['Priya Nair']).toMatchObject({ total: 16478, paid: 0, balance: 16478, status: 'unpaid' })
    expect(by['Jonathan Franco']).toMatchObject({ total: 19688, balance: 0 })
    expect(by['Sofia Marchetti']).toMatchObject({ total: 27820, paid: 5000, balance: 22820, deposit: true })
    expect(by['Nathan Brooks']).toMatchObject({ total: 13910, balance: 0 })
    // every payment the seed wrote is history Squarespace already settled
    const awaiting = await sql<{ n: number }>`
      select count(*)::int as n from ledger_events where processor_state = 'awaiting_processor'`.execute(t.db)
    expect(awaiting.rows[0]!.n).toBe(0)
    const members = await sql<{ n: number }>`select count(*)::int as n from memberships`.execute(t.db)
    expect(members.rows[0]!.n).toBe(7)
  })

  it("carries the design's conversations: a delivered text for each automatic SMS line of the activity log", async () => {
    const lines = await sql<{ n: number }>`
      select count(*)::int as n from activity_log
      where text in ('Booking created', 'Confirmation + reminder sent', 'In-progress message sent', 'Ready-for-pickup sent')
        and appointment_id in (select id from appointments where scheduled_start between '2026-06-13' and '2026-06-15')`.execute(
      t.db,
    )
    const msgs = await sql<{
      n: number
    }>`select count(*)::int as n from messages where appointment_id is not null`.execute(t.db)
    expect(msgs.rows[0]!.n).toBe(lines.rows[0]!.n)
    const priya = await sql<{ body: string; sender_kind: string; status: string; template_key: string }>`
      select m.body, m.sender_kind, m.status, m.template_key from messages m
      join customers c on c.id = m.customer_id where c.full_name = 'Priya Nair' order by m.queued_at, m.id`.execute(
      t.db,
    )
    expect(priya.rows.map((r) => [r.template_key, r.sender_kind, r.status])).toEqual([
      ['booking_thanks', 'system', 'delivered'],
      ['confirm_request', 'system', 'delivered'],
      ['in_progress', 'system', 'delivered'],
      ['ready', 'system', 'delivered'],
    ])
    expect(priya.rows[0]!.body).toBe('Hi Priya, thanks for booking with Oasis Auto Spa.')
    expect(priya.rows[1]!.body).toBe(
      'Your appointment at Oasis Auto Spa is confirmed for 9:45 AM. Reply C to confirm.',
    )
    const outbox = await sql<{ n: number }>`select count(*)::int as n from sms_outbox`.execute(t.db)
    expect(outbox.rows[0]!.n).toBe(0) // history, nothing waits to be sent
  })

  it('is idempotent and does not depend on the injected clock', async () => {
    const before = await counts()
    await runSeed({ db: t.db, clock: t.clock, profile: 'parity-ops' })
    await runSeed({ db: t.db, clock: new FixedClock('2030-01-01T00:00:00Z'), profile: 'parity-ops' })
    expect(await counts()).toEqual(before)
  })

  it('designGenDay consumes the design PRNG in order: counts per day match the original for a sample of offsets', () => {
    for (const d of original.dayCounts.filter((x) => x.offset !== 0 && x.offset !== 1 && x.closed === null)) {
      const [y, m, day] = d.iso.split('-').map(Number)
      const weekday = new Date(Date.UTC(y!, m! - 1, day!)).getUTCDay()
      const reduced = d.note.includes('reduced')
      expect(designGenDay(d.offset, weekday, d.h0!, d.h1!, reduced), `offset ${d.offset}`).toHaveLength(
        d.count,
      )
      expect(designDayCount(d.offset, weekday, reduced).n).toBe(d.count)
    }
  })
})
