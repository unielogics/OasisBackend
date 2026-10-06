// Concurrency: the bay is the final guard (partial unique index), capacity holds under simultaneous bookings, and a
// stale advance loses cleanly.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import { advanceAppointment, startCleaning } from '../../src/modules/scheduling/lifecycle.js'
import { useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string): string => `2026-06-13T${hhmm}:00-04:00`

const settle = async <T>(ps: Promise<T>[]) => {
  const r = await Promise.allSettled(ps)
  return {
    ok: r.filter((x) => x.status === 'fulfilled').length,
    errors: r
      .filter((x): x is PromiseRejectedResult => x.status === 'rejected')
      .map((x) => x.reason as AppError),
  }
}

describe('two simultaneous starts on one bay', () => {
  it('exactly one wins, the other gets "Bay 1 is busy" (repeated to catch interleavings)', async () => {
    for (let round = 0; round < 8; round++) {
      await o.t.db.deleteFrom('appointments').execute()
      const a = await o.insert({
        customerName: 'Maria Delgado',
        serviceName: 'Express Hand Wash',
        at: at('10:30'),
        status: 'arrived',
      })
      const b = await o.insert({
        customerName: 'David Okafor',
        serviceName: 'Express Hand Wash',
        at: at('10:30'),
        status: 'arrived',
      })
      const actor = await o.actor()
      const r = await settle([
        o.tx((tx) => startCleaning(tx, o.ctx, actor, a, { bayId: o.bay(1) })),
        o.tx((tx) => startCleaning(tx, o.ctx, actor, b, { bayId: o.bay(1) })),
      ])
      expect(r.ok).toBe(1)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toMatchObject({ code: 'BAY_BUSY', status: 409, title: 'Bay 1 is busy' })
      const cleaning = await o.t.db
        .selectFrom('appointments')
        .select('id')
        .where('status', '=', 'cleaning')
        .where('bay_id', '=', o.bay(1))
        .execute()
      expect(cleaning).toHaveLength(1)
    }
  })

  it('without a chosen bay both cars find a free bay: the two bays take one each', async () => {
    const a = await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('10:30'),
      status: 'arrived',
    })
    const b = await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('10:30'),
      status: 'arrived',
    })
    const c = await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('10:30'),
      status: 'arrived',
    })
    const actor = await o.actor()
    const r = await settle([a, b, c].map((id) => o.tx((tx) => startCleaning(tx, o.ctx, actor, id))))
    expect(r.ok).toBe(2)
    expect(r.errors[0]).toMatchObject({ code: 'BAY_BUSY' })
    const bays = await o.t.db
      .selectFrom('appointments')
      .select('bay_id')
      .where('status', '=', 'cleaning')
      .execute()
    expect(new Set(bays.map((x) => x.bay_id)).size).toBe(2)
  })

  it('the database is the last guard: the partial unique index refuses a second cleaning job in a bay', async () => {
    const a = await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('10:30'),
      status: 'arrived',
    })
    const b = await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('10:30'),
      status: 'arrived',
    })
    const start = (id: string) =>
      o.tx(async (tx) => {
        await sql`update appointments set status = 'cleaning', bay_id = ${o.bay(2)}, cleaning_started_at = ${o.clock.now()} where id = ${id}`.execute(
          tx,
        )
        await sql`select pg_sleep(0.15)`.execute(tx)
      })
    const r = await settle([start(a), start(b)])
    expect(r.ok).toBe(1)
    expect((r.errors[0] as unknown as { code: string; constraint: string }).code).toBe('23505')
    expect((r.errors[0] as unknown as { constraint: string }).constraint).toBe('uq_bay_occupied')
  })
})

describe('capacity under concurrent bookings', () => {
  it('six clients race for one 2:00 PM slot on two bays: exactly two get it', async () => {
    const names = [
      'Maria Delgado',
      'David Okafor',
      'Priya Nair',
      'Sofia Marchetti',
      'Grace Adeyemi',
      'Marcus Webb',
    ]
    const r = await settle(names.map((customerName) => o.book({ at: at('14:00'), customerName })))
    expect(r.ok).toBe(2)
    expect(r.errors).toHaveLength(4)
    expect(r.errors.every((e) => e.code === 'SLOT_UNAVAILABLE')).toBe(true)
    const rows = await o.t.db
      .selectFrom('appointments')
      .select('id')
      .where('scheduled_start', '=', new Date(at('14:00')))
      .execute()
    expect(rows).toHaveLength(2)
    // invoices are created after the guard, so numbering has no gaps
    expect(o.gateway.calls.filter((c) => c.method === 'ensureForAppointment')).toHaveLength(2)
  })

  it('overlapping starts race too: capacity is checked over the interval, not the start instant', async () => {
    const r = await settle([
      o.book({ at: at('14:00'), customerName: 'Maria Delgado', serviceName: 'Full Detail' }),
      o.book({ at: at('14:30'), customerName: 'David Okafor', serviceName: 'Full Detail' }),
      o.book({ at: at('15:00'), customerName: 'Priya Nair', serviceName: 'Full Detail' }),
      o.book({ at: at('15:30'), customerName: 'Grace Adeyemi', serviceName: 'Full Detail' }),
    ])
    expect(r.ok).toBe(2) // 120-minute jobs on two bays
    const rows = await o.t.db
      .selectFrom('appointments')
      .select(['scheduled_start', 'scheduled_end'])
      .execute()
    expect(rows).toHaveLength(2)
  })
})

describe('advance races', () => {
  it('two simultaneous advances from booked: one wins, the other is stale (409 STALE_STATE) and nothing is skipped', async () => {
    const b = await o.book({ at: at('14:00') })
    const actor = await o.actor()
    const r = await settle([
      o.tx((tx) => advanceAppointment(tx, o.ctx, actor, b.appointment.id, { expectedStatus: 'booked' })),
      o.tx((tx) => advanceAppointment(tx, o.ctx, actor, b.appointment.id, { expectedStatus: 'booked' })),
    ])
    expect(r.ok).toBe(1)
    expect(r.errors[0]).toMatchObject({
      code: 'STALE_STATE',
      status: 409,
      meta: { currentStatus: 'confirmed' },
    })
    expect(
      (
        await o.t.db
          .selectFrom('appointments')
          .select('status')
          .where('id', '=', b.appointment.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('confirmed')
  })
})
