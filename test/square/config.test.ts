// The Square environment (ADR 0171): off by default, live needs its keys, production never sells through a sandbox, and the POS app
// switch only on production Square.
import { describe, expect, it } from 'vitest'
import { ENV_KEYS, loadEnv } from '../../src/config/env.js'
import { SECRET_KEYS } from '../../src/config/secrets-source.js'
import { squareBaseUrl, squareItemsOn, squareLiveConfigured, squareLocationId, SIM_LOCATION_ID } from '../../src/integrations/square/config.js'

const base = { DATABASE_URL: 'postgres://oasis:x@127.0.0.1:5432/oasis' }
const prod = {
  ...base,
  NODE_ENV: 'production',
  SESSION_SECRET: 'x'.repeat(48),
  COOKIE_SECURE: 'true',
  SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_API_URL: 'https://app.example.com',
  PUBLIC_DASHBOARD_URL: 'https://app.example.com',
}
const live = {
  SQUARE_PROVIDER: 'live',
  SQUARE_ACCESS_TOKEN: 'test-token-not-real-0001',
  SQUARE_LOCATION_ID: 'L123',
  SQUARE_APPLICATION_ID: 'sandbox-app-1',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'test-signature-key',
  SQUARE_WEBHOOK_URL: 'https://app.example.com/hooks/square',
}

describe('Square environment', () => {
  it('defaults: simulator, sandbox, observe-only, Squarespace stays the processor, no POS switch, the pinned version', () => {
    const e = loadEnv(base)
    expect(e).toMatchObject({
      SQUARE_PROVIDER: 'sim',
      SQUARE_ENVIRONMENT: 'sandbox',
      SQUARE_WRITES_ENABLED: false,
      SQUARE_MEMBERSHIPS_ENABLED: false,
      SQUARE_ITEMS_SYNC_ENABLED: false,
      SQUARE_POS_API_ENABLED: false,
      PAYMENT_PROCESSOR: 'squarespace',
      SQUARE_API_VERSION: '2026-09-16',
      SQUARE_MATCH_DELAY_SECONDS: 90,
      SQUARE_POS_AUTOMATCH: 'evidence',
    })
    expect(e.SQUARE_ACCESS_TOKEN).toBeUndefined()
    expect(squareLiveConfigured(e)).toBe(false)
    // the item library sync needs both switches (ADR 0172)
    expect(squareItemsOn(e)).toBe(false)
    expect(squareItemsOn(loadEnv({ ...base, SQUARE_ITEMS_SYNC_ENABLED: 'true' }))).toBe(false)
    expect(squareItemsOn(loadEnv({ ...base, SQUARE_WRITES_ENABLED: 'true' }))).toBe(false)
    expect(squareItemsOn(loadEnv({ ...base, SQUARE_WRITES_ENABLED: 'true', SQUARE_ITEMS_SYNC_ENABLED: 'true' }))).toBe(true)
    expect(squareLocationId(e)).toBe(SIM_LOCATION_ID)
    // empty template lines count as unset
    expect(loadEnv({ ...base, SQUARE_ACCESS_TOKEN: '', SQUARE_LOCATION_ID: '', SQUARE_API_BASE: '' }).SQUARE_LOCATION_ID).toBeUndefined()
  })

  it('live requires the token, location, application id, webhook key and webhook URL', () => {
    expect(() => loadEnv({ ...base, SQUARE_PROVIDER: 'live' })).toThrow(
      /SQUARE_ACCESS_TOKEN: required when SQUARE_PROVIDER=live[\s\S]*SQUARE_LOCATION_ID[\s\S]*SQUARE_APPLICATION_ID[\s\S]*SQUARE_WEBHOOK_SIGNATURE_KEY[\s\S]*SQUARE_WEBHOOK_URL/,
    )
    const e = loadEnv({ ...base, ...live })
    expect(squareLiveConfigured(e)).toBe(true)
    expect(squareBaseUrl(e)).toBe('https://connect.squareupsandbox.com')
    expect(squareBaseUrl({ ...e, SQUARE_ENVIRONMENT: 'production' })).toBe('https://connect.squareup.com')
    expect(squareBaseUrl({ ...e, SQUARE_API_BASE: 'http://127.0.0.1:4591/' })).toBe('http://127.0.0.1:4591')
  })

  it('production with PAYMENT_PROCESSOR=square refuses the simulator and the sandbox', () => {
    expect(() => loadEnv({ ...prod, PAYMENT_PROCESSOR: 'square' })).toThrow(/SQUARE_PROVIDER: must be live in production when PAYMENT_PROCESSOR=square/)
    expect(() => loadEnv({ ...prod, ...live, PAYMENT_PROCESSOR: 'square' })).toThrow(
      /SQUARE_ENVIRONMENT: must be production in production when PAYMENT_PROCESSOR=square/,
    )
    expect(loadEnv({ ...prod, ...live, PAYMENT_PROCESSOR: 'square', SQUARE_ENVIRONMENT: 'production' }).PAYMENT_PROCESSOR).toBe('square')
    // rollout step 1: production may run the sandbox in observe-only while Squarespace is still the processor
    expect(loadEnv({ ...prod, ...live }).SQUARE_ENVIRONMENT).toBe('sandbox')
    // outside production the cutover switch may be tried against the sandbox
    expect(loadEnv({ ...base, ...live, PAYMENT_PROCESSOR: 'square' }).PAYMENT_PROCESSOR).toBe('square')
  })

  it('production with PAYMENT_PROCESSOR=square refuses SQUARE_API_BASE pointing anywhere but Square production (review Q4 SQ-SEM-3)', () => {
    const cut = { ...prod, ...live, PAYMENT_PROCESSOR: 'square', SQUARE_ENVIRONMENT: 'production', SQUARE_WRITES_ENABLED: 'true' }
    for (const b of ['https://connect.squareupsandbox.com', 'http://127.0.0.1:4593'])
      expect(() => loadEnv({ ...cut, SQUARE_API_BASE: b })).toThrow(/SQUARE_API_BASE: must be unset/)
    expect(squareBaseUrl(loadEnv({ ...cut, SQUARE_API_BASE: 'https://connect.squareup.com/' }))).toBe('https://connect.squareup.com')
    expect(squareBaseUrl(loadEnv(cut))).toBe('https://connect.squareup.com')
    // before the cutover a staging override stays possible (observe-only against the sandbox or a simulator)
    expect(loadEnv({ ...prod, ...live, SQUARE_API_BASE: 'http://127.0.0.1:4593' }).SQUARE_API_BASE).toBe('http://127.0.0.1:4593')
  })

  it('the POS app switch only with live production Square; the webhook URL is https://<domain>/hooks/square in production', () => {
    expect(() => loadEnv({ ...base, SQUARE_POS_API_ENABLED: 'true' })).toThrow(/SQUARE_POS_API_ENABLED: only with SQUARE_PROVIDER=live and SQUARE_ENVIRONMENT=production/)
    expect(loadEnv({ ...base, ...live, SQUARE_ENVIRONMENT: 'production', SQUARE_POS_API_ENABLED: 'true' }).SQUARE_POS_API_ENABLED).toBe(true)
    expect(() => loadEnv({ ...prod, ...live, SQUARE_WEBHOOK_URL: 'http://app.example.com/hooks/square' })).toThrow(/SQUARE_WEBHOOK_URL: must be https/)
    expect(() => loadEnv({ ...prod, ...live, SQUARE_WEBHOOK_URL: 'https://app.example.com/hooks/square/x' })).toThrow(/SQUARE_WEBHOOK_URL/)
    expect(() => loadEnv({ ...base, SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS: 'old-key-123456' })).toThrow(/SQUARE_WEBHOOK_SIGNATURE_KEY: set the current key too/)
  })

  it('the token and both webhook keys are secret keys, and every Square variable is declared', () => {
    for (const k of ['SQUARE_ACCESS_TOKEN', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS']) expect(SECRET_KEYS).toContain(k)
    for (const k of [
      'SQUARE_PROVIDER',
      'SQUARE_ENVIRONMENT',
      'SQUARE_APPLICATION_ID',
      'SQUARE_LOCATION_ID',
      'SQUARE_WEBHOOK_URL',
      'SQUARE_API_VERSION',
      'SQUARE_API_BASE',
      'SQUARE_TIMEOUT_MS',
      'SQUARE_MAX_ATTEMPTS',
      'SQUARE_WRITES_ENABLED',
      'SQUARE_MEMBERSHIPS_ENABLED',
      'SQUARE_ITEMS_SYNC_ENABLED',
      'SQUARE_POS_API_ENABLED',
      'SQUARE_MATCH_DELAY_SECONDS',
      'SQUARE_POS_AUTOMATCH',
      'PAYMENT_PROCESSOR',
    ])
      expect(ENV_KEYS.has(k), k).toBe(true)
  })
})
