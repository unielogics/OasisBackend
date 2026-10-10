import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { FixedClock } from '../../src/platform/clock.js'
import { AppError } from '../../src/platform/errors.js'
import {
  IDEMPOTENCY_TTL_MS,
  IN_FLIGHT_TIMEOUT_MS,
  purgeExpiredKeys,
  runIdempotent,
  type IdempotentRequest,
} from '../../src/platform/idempotency.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()
const clock = (): FixedClock => t.clock as FixedClock

const req = (over: Partial<IdempotentRequest> = {}): IdempotentRequest => ({
  key: 'key-0000-0001',
  actor: 'user-1',
  method: 'POST',
  url: '/api/v1/invoices/inv-1/refunds',
  route: '/api/v1/invoices/:id/refunds',
  body: { amountCents: 500 },
  ...over,
})

/** A command with a visible side effect (a row in notifications) and a call counter. */
function command(counter: { n: number }) {
  return async (tx: Parameters<Parameters<typeof runIdempotent>[3]>[0]) => {
    counter.n += 1
    await sql`insert into audit_log (location_id, action, entity_type) select id, 'cmd', 'x' from locations limit 1`.execute(
      tx,
    )
    return { status: 201, body: { ok: true, run: counter.n }, headers: { Location: '/api/v1/refunds/r-1' } }
  }
}

async function seedLocation(): Promise<void> {
  await t.db
    .insertInto('locations')
    .values({ id: '0197b3f2-8d3c-7b1a-9c2e-1f2a3b4c5d6e', name: 'L', slug: 'l' })
    .execute()
}
const sideEffects = async (): Promise<number> =>
  (await t.db.selectFrom('audit_log').selectAll().execute()).length

describe('runIdempotent', () => {
  it('runs once, then replays the stored response without re-running the command', async () => {
    await seedLocation()
    const calls = { n: 0 }
    const first = await runIdempotent(t.db, clock(), req(), command(calls))
    expect(first).toMatchObject({
      replayed: false,
      status: 201,
      body: { ok: true, run: 1 },
      headers: { Location: '/api/v1/refunds/r-1' },
    })

    const second = await runIdempotent(t.db, clock(), req(), command(calls))
    expect(second).toMatchObject({
      replayed: true,
      status: 201,
      body: { ok: true, run: 1 },
      headers: { Location: '/api/v1/refunds/r-1' },
    })
    expect(calls.n).toBe(1)
    expect(await sideEffects()).toBe(1)
  })

  it('treats a re-ordered but equal body as the same request', async () => {
    await seedLocation()
    const calls = { n: 0 }
    await runIdempotent(t.db, clock(), req({ body: { a: 1, b: { x: 1, y: 2 } } }), command(calls))
    const again = await runIdempotent(
      t.db,
      clock(),
      req({ body: { b: { y: 2, x: 1 }, a: 1 } }),
      command(calls),
    )
    expect(again.replayed).toBe(true)
    expect(calls.n).toBe(1)
  })

  it('rejects the same key with a different body as 422 IDEMPOTENCY_MISMATCH and does not run', async () => {
    await seedLocation()
    const calls = { n: 0 }
    await runIdempotent(t.db, clock(), req(), command(calls))
    const clash = runIdempotent(t.db, clock(), req({ body: { amountCents: 501 } }), command(calls))
    await expect(clash).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', status: 422 })
    expect(calls.n).toBe(1)
  })

  it('rejects the same key on a different path or method as a mismatch', async () => {
    await seedLocation()
    const calls = { n: 0 }
    await runIdempotent(t.db, clock(), req(), command(calls))
    await expect(
      runIdempotent(t.db, clock(), req({ url: '/api/v1/invoices/inv-2/refunds' }), command(calls)),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    await expect(runIdempotent(t.db, clock(), req({ method: 'PUT' }), command(calls))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    })
  })

  it('scopes keys per actor: another user can reuse the key and never sees the first user response', async () => {
    await seedLocation()
    const calls = { n: 0 }
    await runIdempotent(t.db, clock(), req({ actor: 'user-1' }), command(calls))
    const other = await runIdempotent(t.db, clock(), req({ actor: 'user-2' }), command(calls))
    expect(other.replayed).toBe(false)
    expect(calls.n).toBe(2)
  })

  it('answers a concurrent duplicate with 409 IDEMPOTENCY_IN_FLIGHT and Retry-After while the first is running', async () => {
    await seedLocation()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    const slow = runIdempotent(t.db, clock(), req(), async () => {
      started()
      await gate
      return { status: 200, body: { done: true } }
    })
    await running
    const dup = runIdempotent(t.db, clock(), req(), async () => ({ status: 200, body: { dup: true } }))
    await expect(dup).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_FLIGHT',
      status: 409,
      headers: { 'Retry-After': '1' },
    })
    release()
    expect(await slow).toMatchObject({ replayed: false, body: { done: true } })
    // after completion the same request replays
    expect(
      await runIdempotent(t.db, clock(), req(), async () => ({ status: 200, body: { never: true } })),
    ).toMatchObject({ replayed: true, body: { done: true } })
  })

  it('runs a burst of identical concurrent requests exactly once', async () => {
    await seedLocation()
    const calls = { n: 0 }
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => runIdempotent(t.db, clock(), req(), command(calls))),
    )
    expect(calls.n).toBe(1)
    expect(await sideEffects()).toBe(1)
    const ok = results.filter((r) => r.status === 'fulfilled')
    const inFlight = results.filter(
      (r) => r.status === 'rejected' && (r.reason as AppError).code === 'IDEMPOTENCY_IN_FLIGHT',
    )
    expect(ok.length + inFlight.length).toBe(8)
    expect(
      ok.filter((r) => !(r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed),
    ).toHaveLength(1)
  })

  it('releases the key when the command fails, so a corrected retry runs (and nothing was committed)', async () => {
    await seedLocation()
    const calls = { n: 0 }
    const failing = runIdempotent(t.db, clock(), req(), async (tx) => {
      await command(calls)(tx)
      throw new AppError('FORBIDDEN')
    })
    await expect(failing).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await sideEffects()).toBe(0)
    expect(await t.db.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(0)

    const retry = await runIdempotent(t.db, clock(), req({ body: { amountCents: 400 } }), command(calls))
    expect(retry.replayed).toBe(false)
    expect(await sideEffects()).toBe(1)
  })

  it('stores the response atomically with the mutation (no done row without the effect)', async () => {
    await seedLocation()
    const calls = { n: 0 }
    await runIdempotent(t.db, clock(), req(), command(calls))
    const row = await t.db.selectFrom('idempotency_keys').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      state: 'done',
      response_status: 201,
      route: '/api/v1/invoices/:id/refunds',
      method: 'POST',
    })
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(IDEMPOTENCY_TTL_MS)
  })

  it('expires after 48 hours: the key can be used again and runs the command anew', async () => {
    await seedLocation()
    const calls = { n: 0 }
    await runIdempotent(t.db, clock(), req(), command(calls))
    clock().advance(IDEMPOTENCY_TTL_MS - 1000)
    expect((await runIdempotent(t.db, clock(), req(), command(calls))).replayed).toBe(true)
    clock().advance(2000)
    const after = await runIdempotent(t.db, clock(), req({ body: { amountCents: 999 } }), command(calls))
    expect(after.replayed).toBe(false)
    expect(calls.n).toBe(2)
  })

  it('reclaims an in-flight claim abandoned by a crashed process', async () => {
    await seedLocation()
    // simulate a crash: a committed in_flight claim with no running command
    const now = clock().now()
    await t.db
      .insertInto('idempotency_keys')
      .values({
        key: 'key-0000-0001',
        actor: 'user-1',
        method: 'POST',
        route: '/x',
        request_hash: 'deadbeef',
        state: 'in_flight',
        created_at: now,
        lock_expires_at: new Date(now.getTime() + IN_FLIGHT_TIMEOUT_MS),
        expires_at: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      })
      .execute()
    await expect(runIdempotent(t.db, clock(), req(), command({ n: 0 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    })
    clock().advance(IN_FLIGHT_TIMEOUT_MS + 1)
    const r = await runIdempotent(t.db, clock(), req(), command({ n: 0 }))
    expect(r.replayed).toBe(false)
  })

  it('a prepare step runs once per executed command, outside the transaction (its writes survive a failing command), never on a replay', async () => {
    await seedLocation()
    const calls = { n: 0 }
    const prepared: string[] = []
    const prepare = async (): Promise<string> => {
      // its own autocommit statement: the transaction has not opened yet (no connection is held while it runs)
      await sql`insert into public_rate_limits (key, window_start, count) values (${`prep-${prepared.length}`}, app_now(), 1)`.execute(t.db)
      prepared.push('ran')
      return `p${prepared.length}`
    }
    const first = await runIdempotent(t.db, clock(), req(), async (tx, p) => ({ ...(await command(calls)(tx)), body: { p } }), prepare)
    expect(first).toMatchObject({ replayed: false, body: { p: 'p1' } })
    const again = await runIdempotent(t.db, clock(), req(), async (tx, p) => ({ ...(await command(calls)(tx)), body: { p } }), prepare)
    expect(again).toMatchObject({ replayed: true, body: { p: 'p1' } })
    expect(prepared).toEqual(['ran'])
    // a command that fails after its prepare step: the prepare's writes stay, the command's roll back, the key is released
    const failing = runIdempotent(t.db, clock(), req({ key: 'key-0000-0002' }), async (tx) => {
      await command(calls)(tx)
      throw new AppError('VERSION_CONFLICT')
    }, prepare)
    await expect(failing).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(prepared).toEqual(['ran', 'ran'])
    expect((await t.db.selectFrom('public_rate_limits').select('key').execute()).map((r) => r.key).sort()).toEqual(['prep-0', 'prep-1'])
    expect(await sideEffects()).toBe(1)
    expect(await t.db.selectFrom('idempotency_keys').select('key').where('key', '=', 'key-0000-0002').execute()).toEqual([])
    // a prepare step that refuses (a rate limit) releases the key too, and the command never runs
    const refused = runIdempotent(t.db, clock(), req({ key: 'key-0000-0003' }), command(calls), async () => {
      throw new AppError('RATE_LIMITED')
    })
    await expect(refused).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(calls.n).toBe(2)
    expect(await t.db.selectFrom('idempotency_keys').select('key').where('key', '=', 'key-0000-0003').execute()).toEqual([])
  })

  it('purgeExpiredKeys removes only expired rows', async () => {
    await seedLocation()
    await runIdempotent(t.db, clock(), req({ key: 'key-old-00001' }), command({ n: 0 }))
    clock().advance(IDEMPOTENCY_TTL_MS + 1)
    await runIdempotent(t.db, clock(), req({ key: 'key-new-00001' }), command({ n: 0 }))
    expect(await purgeExpiredKeys(t.db, clock())).toBe(1)
    expect((await t.db.selectFrom('idempotency_keys').select('key').execute()).map((r) => r.key)).toEqual([
      'key-new-00001',
    ])
    expect(await purgeExpiredKeys(t.db, clock())).toBe(0)
  })

  it('rejects malformed keys before touching the database', async () => {
    await expect(runIdempotent(t.db, clock(), req({ key: 'x' }), command({ n: 0 }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_INVALID',
      status: 400,
    })
  })

  it('rolls back if its claim was reclaimed while the command ran (no double effect)', async () => {
    await seedLocation()
    const calls = { n: 0 }
    const slowRun = runIdempotent(t.db, clock(), req(), async (tx) => {
      await command(calls)(tx)
      // another process decided this claim was abandoned and replaced it
      await t.db.updateTable('idempotency_keys').set({ request_hash: 'someone-else' }).execute()
      return { status: 200, body: {} }
    })
    await expect(slowRun).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' })
    expect(await sideEffects()).toBe(0)
  })
})
