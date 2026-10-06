import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import * as audit from '../../src/platform/audit.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, currentSchema, transaction } from '../../src/platform/db.js'
import { AppError } from '../../src/platform/errors.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation, getDefaultLocation } from '../../src/platform/locations.js'
import { cursorState, publish } from '../../src/platform/realtime.js'
import { getSetting, listSettings, settingKeys, updateSetting } from '../../src/platform/settings.js'
import { useTestDb } from '../helpers/db.js'
import { makeLocation } from '../helpers/factories.js'

const t = useTestDb()
const newId = (): string => createIdGenerator(t.clock)()

describe('app_now()', () => {
  it('uses the oasis.now GUC when set and falls back to the wall clock otherwise', async () => {
    const { db } = t
    await transaction(db, async (tx) => {
      await sql`select set_config('oasis.now', '2026-06-13T10:36:00-04:00', true)`.execute(tx)
      const r = await sql<{ now: Date }>`select app_now() as now`.execute(tx)
      expect(r.rows[0]!.now.toISOString()).toBe('2026-06-13T14:36:00.000Z')
    })
    await transaction(db, async (tx) => {
      await sql`select set_config('oasis.now', '', true)`.execute(tx)
      const r = await sql<{
        delta: number
      }>`select abs(extract(epoch from (app_now() - clock_timestamp())))::float8 as delta`.execute(tx)
      expect(r.rows[0]!.delta).toBeLessThan(2)
    })
  })

  it('column defaults read app_now(), so a frozen clock reaches stored timestamps', async () => {
    const { db } = t
    await ensureLocation(db, newId)
    const loc = await getDefaultLocation(db)
    const row = await db
      .selectFrom('locations')
      .select('created_at')
      .where('id', '=', loc!.id)
      .executeTakeFirstOrThrow()
    expect(row.created_at.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })

  it('the pool mirrors a synthetic Clock into the GUC on every checkout, including after the clock moves', async () => {
    const clock = new FixedClock('2030-01-01T00:00:00Z')
    const db = createDb({ url: t.connection.url, searchPath: t.connection.searchPath, clock, poolMax: 2 })
    try {
      const read = async (): Promise<string> =>
        (await sql<{ n: Date }>`select app_now() as n`.execute(db)).rows[0]!.n.toISOString()
      expect(await read()).toBe('2030-01-01T00:00:00.000Z')
      clock.advance(90_000)
      expect(await read()).toBe('2030-01-01T00:01:30.000Z')
      await transaction(db, async (tx) => {
        expect((await sql<{ n: Date }>`select app_now() as n`.execute(tx)).rows[0]!.n.toISOString()).toBe(
          '2030-01-01T00:01:30.000Z',
        )
      })
    } finally {
      await db.destroy()
    }
  })

  it('a real (non-synthetic) clock leaves the GUC unset', async () => {
    const db = createDb({ url: t.connection.url, searchPath: t.connection.searchPath, poolMax: 1 })
    try {
      const r = await sql<{ v: string | null }>`select current_setting('oasis.now', true) as v`.execute(db)
      expect(r.rows[0]!.v ?? '').toBe('')
    } finally {
      await db.destroy()
    }
  })
})

describe('connection settings', () => {
  it('parses int8 as number and date as a plain string', async () => {
    const r = await sql<{
      big: number
      sum: number
      d: string
    }>`select 9007199254740991::bigint as big, sum(x)::bigint as sum, date '2026-03-08' as d from generate_series(1, 4) x`.execute(
      t.db,
    )
    expect(r.rows[0]).toEqual({ big: 9007199254740991, sum: 10, d: '2026-03-08' })
    await expect(sql`select 9223372036854775807::bigint as big`.execute(t.db)).rejects.toThrow(/safe integer/)
  })

  it('runs in UTC with the worker schema first on the search_path', async () => {
    expect(await currentSchema(t.db)).toBe(t.schema)
    const tz = await sql<{ tz: string }>`select current_setting('timezone') as tz`.execute(t.db)
    expect(tz.rows[0]!.tz).toBe('UTC')
  })

  it('transaction() rolls back on error and supports isolation levels', async () => {
    await expect(
      transaction(t.db, async (tx) => {
        await tx.insertInto('locations').values({ id: newId(), name: 'Temp', slug: 'temp' }).execute()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await t.db.selectFrom('locations').selectAll().execute()).toHaveLength(0)
    await transaction(
      t.db,
      async (tx) => {
        const r = await sql<{ l: string }>`select current_setting('transaction_isolation') as l`.execute(tx)
        expect(r.rows[0]!.l).toBe('serializable')
      },
      'serializable',
    )
  })
})

describe('locations', () => {
  it('ensureLocation is idempotent and seeds default settings once', async () => {
    const a = await ensureLocation(t.db, newId)
    const b = await ensureLocation(t.db, newId)
    expect(b.id).toBe(a.id)
    expect(a).toMatchObject({ slug: 'oasis', name: 'Oasis Auto Spa', timezone: 'America/New_York' })
    expect(await t.db.selectFrom('locations').selectAll().execute()).toHaveLength(1)
    expect(await t.db.selectFrom('settings').selectAll().execute()).toHaveLength(settingKeys.length)
  })

  it('slug is unique and further locations are possible (multi-location readiness)', async () => {
    const first = await ensureLocation(t.db, newId)
    const second = await makeLocation(t.db, newId, { timezone: 'America/Chicago' })
    expect(second.id).not.toBe(first.id)
    expect(second.timezone).toBe('America/Chicago')
    await expect(
      t.db.insertInto('locations').values({ id: newId(), name: 'Dup', slug: 'oasis' }).execute(),
    ).rejects.toThrow(/duplicate key/)
  })

  it('does not overwrite settings that were already changed', async () => {
    const loc = await ensureLocation(t.db, newId)
    await transaction(t.db, (tx) => updateSetting(tx, { locationId: loc.id, key: 'tax.rate_bp', value: 825 }))
    await ensureLocation(t.db, newId)
    expect((await getSetting(t.db, loc.id, 'tax.rate_bp')).value).toBe(825)
  })
})

describe('audit_log', () => {
  it('records in the caller transaction with actor, request and idempotency context', async () => {
    const loc = await ensureLocation(t.db, newId)
    const id = await transaction(t.db, (tx) =>
      audit.record(tx, {
        locationId: loc.id,
        action: 'invoice.refund',
        entityType: 'invoice',
        entityId: 'INV-20604',
        before: { refunded: 0 },
        after: { refunded: 500 },
        ctx: {
          actor: { userId: newId(), employeeId: newId(), name: 'Rafael M.', roles: 'management,accounting' },
          requestId: 'req-123456',
          idempotencyKey: 'key-12345678',
          ip: '203.0.113.9',
        },
      }),
    )
    const row = await t.db.selectFrom('audit_log').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      action: 'invoice.refund',
      entity_type: 'invoice',
      entity_id: 'INV-20604',
      before: { refunded: 0 },
      after: { refunded: 500 },
      actor_name: 'Rafael M.',
      actor_roles: 'management,accounting',
      request_id: 'req-123456',
      idempotency_key: 'key-12345678',
      ip: '203.0.113.9',
    })
    expect(row.at.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })

  it('a rolled-back mutation leaves no audit row', async () => {
    const loc = await ensureLocation(t.db, newId)
    await expect(
      transaction(t.db, async (tx) => {
        await audit.record(tx, { locationId: loc.id, action: 'x', entityType: 'y' })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await t.db.selectFrom('audit_log').selectAll().execute()).toHaveLength(0)
  })

  it('the trigger rejects UPDATE and DELETE (even for the table owner)', async () => {
    const loc = await ensureLocation(t.db, newId)
    await transaction(t.db, (tx) => audit.record(tx, { locationId: loc.id, action: 'a', entityType: 'b' }))
    await expect(t.db.updateTable('audit_log').set({ action: 'tampered' }).execute()).rejects.toThrow(
      /insert-only/,
    )
    await expect(t.db.deleteFrom('audit_log').execute()).rejects.toThrow(/insert-only/)
    await expect(sql`update audit_log set after = '{}'::jsonb`.execute(t.db)).rejects.toThrow(/insert-only/)
    const rows = await t.db.selectFrom('audit_log').select('action').execute()
    expect(rows).toEqual([{ action: 'a' }])
  })

  it('ignores a malformed ip instead of failing the mutation', async () => {
    const loc = await ensureLocation(t.db, newId)
    const id = await transaction(t.db, (tx) =>
      audit.record(tx, { locationId: loc.id, action: 'a', entityType: 'b', ctx: { ip: 'not-an-ip' } }),
    )
    const row = await t.db.selectFrom('audit_log').select('ip').where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.ip).toBeNull()
  })
})

describe('webhook_log', () => {
  it('dedupes on (provider, external_id)', async () => {
    const row = (provider: 'smsgate' | 'squarespace', externalId: string) => ({
      id: newId(),
      provider,
      external_id: externalId,
      headers: JSON.stringify({ 'x-signature': 'abc' }),
      body: '{}',
      signature_valid: true,
    })
    await t.db.insertInto('webhook_log').values(row('smsgate', 'evt-1')).execute()
    await expect(t.db.insertInto('webhook_log').values(row('smsgate', 'evt-1')).execute()).rejects.toThrow(
      /duplicate key/,
    )
    await t.db.insertInto('webhook_log').values(row('squarespace', 'evt-1')).execute()
    await expect(
      t.db
        .insertInto('webhook_log')
        .values({ ...row('smsgate', 'evt-2'), provider: 'twilio' as never })
        .execute(),
    ).rejects.toThrow(/check constraint/)
    const stored = await t.db
      .selectFrom('webhook_log')
      .select(['status', 'received_at'])
      .where('provider', '=', 'smsgate')
      .executeTakeFirstOrThrow()
    expect(stored.status).toBe('received')
    expect(stored.received_at.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })
})

describe('notifications', () => {
  it('stores broadcast, role and employee targeted notifications; both targets at once is rejected', async () => {
    const loc = await ensureLocation(t.db, newId)
    const base = { location_id: loc.id, kind: 'alert', title: 'SMS device offline' }
    await t.db
      .insertInto('notifications')
      .values({ id: newId(), ...base })
      .execute()
    await t.db
      .insertInto('notifications')
      .values({ id: newId(), ...base, role_target: 'management' })
      .execute()
    await t.db
      .insertInto('notifications')
      .values({ id: newId(), ...base, employee_id: newId() })
      .execute()
    await expect(
      t.db
        .insertInto('notifications')
        .values({ id: newId(), ...base, role_target: 'x', employee_id: newId() })
        .execute(),
    ).rejects.toThrow(/check constraint/)
  })
})

describe('settings', () => {
  it('reads defaults before anything is stored and lists the whole registry', async () => {
    const loc = await makeLocation(t.db, newId)
    await t.db.deleteFrom('settings').where('location_id', '=', loc.id).execute()
    const rec = await getSetting(t.db, loc.id, 'tax.rate_bp')
    expect(rec).toMatchObject({ value: 700, version: 0, updatedAt: null })
    const all = await listSettings(t.db, loc.id)
    expect(all.map((s) => s.key)).toEqual(settingKeys)
  })

  it('updates with a version check, audit row and realtime event in one transaction', async () => {
    const loc = await ensureLocation(t.db, newId)
    const userId = newId()
    const v1 = await transaction(t.db, (tx) =>
      updateSetting(tx, {
        locationId: loc.id,
        key: 'tax.rate_bp',
        value: 825,
        expectedVersion: 1,
        updatedBy: userId,
        audit: { requestId: 'req-settings-1', actor: { userId, name: 'Rafael M.' } },
      }),
    )
    expect(v1).toMatchObject({ value: 825, version: 2, updatedBy: userId })
    const log = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('entity_id', '=', 'tax.rate_bp')
      .executeTakeFirstOrThrow()
    expect(log).toMatchObject({
      action: 'settings.update',
      before: 700,
      after: 825,
      request_id: 'req-settings-1',
    })
    const ev = await t.db.selectFrom('realtime_events').selectAll().executeTakeFirstOrThrow()
    expect(ev).toMatchObject({
      channel: 'settings',
      type: 'settings.changed',
      payload: { section: 'tax', key: 'tax.rate_bp', version: 2 },
    })
  })

  it('rejects a stale version with VERSION_CONFLICT carrying the current version, and writes nothing', async () => {
    const loc = await ensureLocation(t.db, newId)
    await transaction(t.db, (tx) =>
      updateSetting(tx, { locationId: loc.id, key: 'ops.late_grace_min', value: 15 }),
    )
    const attempt = transaction(t.db, (tx) =>
      updateSetting(tx, { locationId: loc.id, key: 'ops.late_grace_min', value: 20, expectedVersion: 1 }),
    )
    await expect(attempt).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 412,
      meta: { currentVersion: 2 },
    })
    expect((await getSetting(t.db, loc.id, 'ops.late_grace_min')).value).toBe(15)
    expect(await t.db.selectFrom('audit_log').selectAll().execute()).toHaveLength(1)
  })

  it('serialises two concurrent writers on the same expected version: exactly one wins', async () => {
    const loc = await ensureLocation(t.db, newId)
    const write = (v: number) =>
      transaction(t.db, (tx) =>
        updateSetting(tx, { locationId: loc.id, key: 'ops.late_grace_min', value: v, expectedVersion: 1 }),
      )
    const results = await Promise.allSettled([write(11), write(12), write(13)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError)
    expect((await getSetting(t.db, loc.id, 'ops.late_grace_min')).version).toBe(2)
  })

  it('validates values before touching the database', async () => {
    const loc = await ensureLocation(t.db, newId)
    await expect(
      transaction(t.db, (tx) =>
        updateSetting(tx, { locationId: loc.id, key: 'tax.rate_bp', value: 'seven' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
  })

  it('creates the row on first write for a key with no stored row (expected version 0)', async () => {
    const loc = await makeLocation(t.db, newId)
    await t.db.deleteFrom('settings').where('location_id', '=', loc.id).execute()
    const rec = await transaction(t.db, (tx) =>
      updateSetting(tx, { locationId: loc.id, key: 'reviews.enabled', value: true, expectedVersion: 0 }),
    )
    expect(rec).toMatchObject({ value: true, version: 1 })
  })
})

describe('realtime_events trigger and cursor', () => {
  it('assigns increasing ids and reports the cursor state', async () => {
    const loc = await ensureLocation(t.db, newId)
    expect(await cursorState(t.db)).toEqual({ latestId: 0, purgedThrough: 0 })
    const ids = await transaction(t.db, async (tx) => [
      await publish(tx, {
        locationId: loc.id,
        channel: 'ops',
        type: 'appointment.updated',
        payload: { id: 'a1', version: 3 },
      }),
      await publish(tx, { locationId: loc.id, channel: 'ops', type: 'kpi.dirty' }),
    ])
    expect(ids[1]! > ids[0]!).toBe(true)
    expect((await cursorState(t.db)).latestId).toBe(ids[1])
  })

  it('a rolled-back publish is never visible', async () => {
    const loc = await ensureLocation(t.db, newId)
    await expect(
      transaction(t.db, async (tx) => {
        await publish(tx, { locationId: loc.id, channel: 'ops', type: 'x' })
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    expect(await t.db.selectFrom('realtime_events').selectAll().execute()).toHaveLength(0)
  })
})
