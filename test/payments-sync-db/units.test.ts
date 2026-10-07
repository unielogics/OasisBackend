import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { createSecretBox, keyIdOf, secretBoxFromEnv } from '../../src/modules/payments-sync/db/secrets.js'
import { alertKey } from '../../src/modules/payments-sync/db/alerts.js'
import { payloadHash } from '../../src/modules/payments-sync/db/codec.js'
import { pollCron } from '../../src/modules/payments-sync/jobs/index.js'
import { combineExternalAlerts } from '../../src/modules/payments-sync/db/queries.js'
import { testDatabaseUrl } from '../helpers/env.js'

const K1 = Buffer.alloc(32, 1).toString('base64')
const K2 = Buffer.alloc(32, 2).toString('base64')

describe('secrets (AES-256-GCM with SECRETS_KEY)', () => {
  it('round-trips, never repeats a ciphertext, and names the key id', () => {
    const box = createSecretBox([K1])
    const a = box.encrypt('sq-secret-key')
    const b = box.encrypt('sq-secret-key')
    expect(a).not.toBe(b)
    expect(a).not.toContain('sq-secret-key')
    expect(box.decrypt(a)).toBe('sq-secret-key')
    expect(a.startsWith(`${keyIdOf(Buffer.from(K1, 'base64'))}:`)).toBe(true)
    expect(box.decrypt(box.encrypt(''))).toBe('')
  })

  it('refuses tampering, truncation and a key that is not configured; a rotated key still reads old rows', () => {
    const old = createSecretBox([K1])
    const stored = old.encrypt('value')
    const [id, iv, tag, body] = stored.split(':')
    const flipped = [id, iv, tag, Buffer.from(Buffer.from(body!, 'base64url').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64url')].join(':')
    expect(() => old.decrypt(flipped)).toThrow()
    expect(() => old.decrypt(`${id}:${iv}`)).toThrow(/malformed/)
    expect(() => createSecretBox([K2]).decrypt(stored)).toThrow(/no SECRETS_KEY with id/)
    expect(createSecretBox([K2, K1]).decrypt(stored)).toBe('value')
    expect(createSecretBox([K2, K1]).encrypt('x').startsWith(`${keyIdOf(Buffer.from(K2, 'base64'))}:`)).toBe(true)
  })

  it('needs a 32-byte key; the environment helper answers 503 naming the variable', () => {
    expect(() => createSecretBox([Buffer.alloc(16).toString('base64')])).toThrow(/32 bytes/)
    expect(() => createSecretBox([])).toThrow(/not configured/)
    try {
      secretBoxFromEnv({})
      throw new Error('expected a problem')
    } catch (e) {
      expect((e as { status: number; detail: string }).status).toBe(503)
      expect((e as { detail: string }).detail).toMatch(/SECRETS_KEY/)
    }
  })
})

describe('poll cron', () => {
  it('turns SQSP_POLL_INTERVAL_SECONDS into minute cron expressions, never faster than every minute', () => {
    expect(pollCron(30)).toBe('* * * * *')
    expect(pollCron(60)).toBe('* * * * *')
    expect(pollCron(120)).toBe('*/2 * * * *')
    expect(pollCron(300)).toBe('*/5 * * * *')
    expect(pollCron(3600)).toBe('0 */1 * * *')
  })
})

describe('environment', () => {
  it('the Squarespace tuning variables are optional with the documented defaults', () => {
    const e = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl() })
    expect(e).toMatchObject({
      SQSP_PROVIDER: 'sim',
      SQSP_POLL_INTERVAL_SECONDS: 120,
      SQSP_OVERLAP_SECONDS: 300,
      SQSP_RECONCILE_DAYS: 45,
      SQSP_REQUESTS_PER_MINUTE: 240,
      SQSP_MAX_REQUESTS_PER_RUN: 120,
      SQSP_INCLUDE_TEST_ORDERS: false,
      SQSP_MEMBERSHIP_GRACE_DAYS: 7,
      SQSP_LAPSE_CANCEL_DAYS: 60,
      SQSP_MATCH_CONFIDENCE_THRESHOLD: 0.8,
      SQSP_VARIANCE_ALERT_CENTS: 100,
    })
  })

  it('rejects out-of-range values and a non-hex webhook secret', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl() }
    expect(() => loadEnv({ ...base, SQSP_MEMBERSHIP_GRACE_DAYS: '99' })).toThrow(/SQSP_MEMBERSHIP_GRACE_DAYS/)
    expect(() => loadEnv({ ...base, SQSP_WEBHOOK_SECRET: 'zz' })).toThrow(/SQSP_WEBHOOK_SECRET/)
    expect(() => loadEnv({ ...base, SQSP_LAPSE_CANCEL_DAYS: '-1' })).toThrow(/SQSP_LAPSE_CANCEL_DAYS/)
  })
})

describe('helpers', () => {
  it('alert keys are stable per code, order, transaction and subject', () => {
    expect(alertKey({ code: 'external_refund', orderId: 'o', transactionId: 't' })).toBe('external_refund:o:t:')
    expect(alertKey({ code: 'product_map_empty' })).toBe('product_map_empty:::')
    expect(alertKey({ code: 'membership_needs_customer', subject: 'email:a@b.c' })).toBe('membership_needs_customer:::email:a@b.c')
  })

  it('payload hashes ignore key order and treat dates by instant', () => {
    expect(payloadHash({ a: 1, b: new Date('2026-01-01T00:00:00Z') })).toBe(payloadHash({ b: new Date('2026-01-01T00:00:00.000Z'), a: 1 }))
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }))
  })

  it('combined alert sources concatenate in order', async () => {
    const src = (k: string) => ({
      list: async () => [{ key: k, kind: 'new_reply' as const, tone: 'blue' as const, title: k, desc: '', actionLabel: '', appointmentId: null, priority: 0 }],
    })
    const out = await combineExternalAlerts(src('a'), src('b')).list({} as never, { locationId: 'l', now: new Date(), manager: true })
    expect(out.map((x) => x.key)).toEqual(['a', 'b'])
  })
})
