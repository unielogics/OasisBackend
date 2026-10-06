import { describe, expect, it } from 'vitest'
import { FixedClock, PARITY_NOW } from '../src/platform/clock.js'
import { mulberry32 } from '../src/platform/random.js'
import { loadEnv } from '../src/config/env.js'
import { squarespaceCapabilities } from '../src/integrations/ports/index.js'

describe('clock', () => {
  it('FixedClock is frozen until advanced', () => {
    const c = new FixedClock(PARITY_NOW)
    expect(c.now().toISOString()).toBe('2026-06-13T14:36:00.000Z') // 10:36 Eastern (-04:00)
    c.advance(60_000)
    expect(c.now().toISOString()).toBe('2026-06-13T14:37:00.000Z')
  })
})

describe('mulberry32', () => {
  it('reproduces the Payments design generator (seed 987654) exactly', () => {
    // Verbatim from the Payments prototype fixture builder.
    let t = 987654
    const designRnd = () => {
      t += 0x6d2b79f5
      let r = Math.imul(t ^ (t >>> 15), 1 | t)
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296
    }
    const ours = mulberry32(987654)
    for (let i = 0; i < 500; i++) expect(ours()).toBe(designRnd())
  })
})

describe('env contract', () => {
  const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' }
  it('parses defaults with simulators and America/New_York', () => {
    const e = loadEnv(base)
    expect(e).toMatchObject({
      SMS_PROVIDER: 'sim',
      EMAIL_PROVIDER: 'sim',
      STORAGE_PROVIDER: 'fs',
      BUSINESS_TZ: 'America/New_York',
      PORT: 4000,
    })
    expect(e.SMSGATE_MAX_PER_WINDOW).toBe(30)
  })
  it('requires smsgate credentials when SMS_PROVIDER=smsgate', () => {
    expect(() => loadEnv({ ...base, SMS_PROVIDER: 'smsgate' })).toThrow(/SMSGATE_DEVICE_URL/)
  })
  it('refuses a frozen clock and missing secret in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CLOCK_FREEZE_AT: PARITY_NOW })).toThrow(
      /CLOCK_FREEZE_AT/,
    )
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/)
  })
})

describe('squarespace capabilities', () => {
  it('states honestly that Squarespace cannot charge, refund or create links', () => {
    expect(squarespaceCapabilities).toEqual({
      chargeCard: false,
      refundCard: false,
      paymentLink: 'manual',
      savedCards: 'hint',
    })
  })
})
