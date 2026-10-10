// The durable limits of the public routes (ADR 0150, review 2026-10-10): the rules are charged in order and stop at the first
// refusal, so a request refused for its address never counts against the number it names; and every per-number rule has a
// stricter per-number-per-address twin over the same window, so no single address can use up a number's allowance.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { enforceLimits, PUBLIC_LIMITS, publicLimitChecks } from '../../src/modules/public/limits.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()
const counts = async (): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await sql<{ key: string; count: number }>`select key, count from public_rate_limits order by key`.execute(t.db)).rows.map((r) => [r.key, r.count]),
  )

describe('enforceLimits', () => {
  it('stops at the first refusal: an address over its limit charges nothing to the numbers it names', async () => {
    const ip = { key: 'otp:ip:10.0.0.1', rule: { max: 2, windowSec: 600 } }
    const phone = (n: string) => ({ key: `otp:phone:${n}`, rule: { max: 3, windowSec: 600 } })
    await enforceLimits(t.db, t.clock, [ip, phone('a')])
    await enforceLimits(t.db, t.clock, [ip, phone('b')])
    for (let i = 0; i < 5; i++) await expect(enforceLimits(t.db, t.clock, [ip, phone('victim')])).rejects.toMatchObject({ code: 'PUBLIC_RATE_LIMITED' })
    expect(await counts()).toEqual({ 'otp:ip:10.0.0.1': 7, 'otp:phone:a': 1, 'otp:phone:b': 1 })
  })

  it('answers with the Retry-After of the rule that refused', async () => {
    const day = { key: 'membership:phone:x', rule: { max: 0, windowSec: 86_400 } }
    const err = await enforceLimits(t.db, t.clock, [day]).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'PUBLIC_RATE_LIMITED' })
    expect(Number((err as { headers: Record<string, string> }).headers['Retry-After'])).toBeGreaterThan(3600)
  })
})

describe('the public rules', () => {
  it('pair every per-number rule with a smaller per-number-per-address rule of the same window, and check the address first', () => {
    for (const [action, rules] of Object.entries(PUBLIC_LIMITS)) {
      if (!('phone' in rules)) continue
      expect(rules.phoneIp.windowSec, action).toBe(rules.phone.windowSec)
      expect(rules.phoneIp.max, action).toBeLessThan(rules.phone.max)
      const p = ({ otpRequest: 'otp', booking: 'booking', membership: 'membership' } as Record<string, string>)[action]
      const keys = publicLimitChecks(action as 'otpRequest', '10.0.0.9', '+12015550101').map((c) => c.key)
      expect(keys, action).toEqual([`${p}:ip:10.0.0.9`, `${p}:phone_ip:+12015550101:10.0.0.9`, `${p}:phone:+12015550101`])
    }
  })
})
