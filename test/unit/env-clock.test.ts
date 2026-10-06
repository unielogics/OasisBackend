import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { FixedClock, PARITY_NOW, createClock, systemClock } from '../../src/platform/clock.js'

const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' }

describe('platform env additions', () => {
  it('has safe defaults', () => {
    const e = loadEnv(base)
    expect(e).toMatchObject({
      HOST: '127.0.0.1',
      DB_POOL_MAX: 10,
      PGBOSS_SCHEMA: 'pgboss',
      RATE_LIMIT_PER_MIN: 300,
      SSE_HEARTBEAT_MS: 20_000,
      DEV_AUTH_BYPASS: false,
      JOBS_ENABLED: true,
    })
  })
  it('refuses the dev auth bypass in production', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), DEV_AUTH_BYPASS: 'true' }),
    ).toThrow(/DEV_AUTH_BYPASS/)
    expect(loadEnv({ ...base, DEV_AUTH_BYPASS: 'true' }).DEV_AUTH_BYPASS).toBe(true)
  })
  it('requires CLOCK_FREEZE_AT to be an instant', () => {
    expect(() => loadEnv({ ...base, CLOCK_FREEZE_AT: 'yesterday' })).toThrow(/CLOCK_FREEZE_AT/)
    expect(loadEnv({ ...base, CLOCK_FREEZE_AT: PARITY_NOW }).CLOCK_FREEZE_AT).toBe(PARITY_NOW)
  })
  it('rejects an unsafe pg-boss schema name', () => {
    expect(() => loadEnv({ ...base, PGBOSS_SCHEMA: 'x; drop table y' })).toThrow(/PGBOSS_SCHEMA/)
  })
})

describe('createClock', () => {
  it('returns the wall clock without CLOCK_FREEZE_AT and a frozen synthetic clock with it', () => {
    expect(createClock(undefined)).toBe(systemClock)
    expect(createClock('')).toBe(systemClock)
    const c = createClock(PARITY_NOW)
    expect(c).toBeInstanceOf(FixedClock)
    expect(c.synthetic).toBe(true)
    expect(c.now().toISOString()).toBe('2026-06-13T14:36:00.000Z')
    expect(systemClock.synthetic).toBeUndefined()
  })
  it('rejects an unparsable freeze instant', () => {
    expect(() => new FixedClock('nope')).toThrow(/Invalid clock instant/)
  })
})
