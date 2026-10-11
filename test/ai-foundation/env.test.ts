// The AI assistant's environment (ADR 0160, design section 1 "Env"): off and simulated by default, PIN_PEPPER a secret that
// production needs once personal links are on (and takes only from the Secrets Manager secret), and no simulated assistant answering real clients in production.
import { describe, expect, it } from 'vitest'
import { DEV_PIN_PEPPER, ENV_KEYS, loadEnv } from '../../src/config/env.js'
import { FORBIDDEN_SECRET_KEYS, SECRET_KEYS } from '../../src/config/secrets-source.js'
import { aiEnvShape } from '../../src/integrations/ai/env.js'

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
const PEPPER = Buffer.alloc(32, 9).toString('base64')

describe('AI environment', () => {
  it('defaults: off, simulated, Sonnet 4.6 (the interim model, owner 2026-10-11) in us-east-1, the design caps; links closed', () => {
    const e = loadEnv(base)
    expect(e).toMatchObject({
      AI_ENABLED: false,
      AI_ACTIONS_ENABLED: false,
      AI_PROVIDER: 'sim',
      AI_BEDROCK_REGION: 'us-east-1',
      AI_BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
      AI_EFFORT: 'low',
      AI_MAX_TOKENS: 800,
      AI_TIMEOUT_MS: 20_000,
      AI_TURN_DEADLINE_MS: 60_000,
      AI_DEBOUNCE_MS: 8000,
      AI_TURNS_PER_NUMBER_HOUR: 8,
      AI_TURNS_PER_NUMBER_DAY: 25,
      AI_TURNS_UNKNOWN_DAY: 10,
      AI_GLOBAL_TURNS_HOUR: 100,
      AI_GLOBAL_TURNS_DAY: 600,
      AI_SMS_SEGMENTS_PER_30MIN: 12,
      AI_DAILY_BUDGET_USD: 10,
      PUBLIC_LINKS_ENABLED: false,
    })
    expect(e.PIN_PEPPER).toBe(DEV_PIN_PEPPER) // a development stand-in while links are off (test/ai-foundation/pin-pepper.test.ts)
    // unset: cost_micros uses the configured model's list prices (test/integrations/ai/cost.test.ts)
    for (const k of ['AI_PRICE_INPUT_PER_MTOK', 'AI_PRICE_OUTPUT_PER_MTOK', 'AI_PRICE_CACHE_READ_PER_MTOK', 'AI_PRICE_CACHE_WRITE_PER_MTOK'] as const)
      expect(e[k]).toBeUndefined()
  })

  it('declares every AI variable in the environment contract', () => {
    for (const k of [...Object.keys(aiEnvShape), 'PUBLIC_LINKS_ENABLED', 'PIN_PEPPER']) expect(ENV_KEYS.has(k), k).toBe(true)
  })

  it('validates values', () => {
    expect(() => loadEnv({ ...base, AI_PROVIDER: 'openai' })).toThrow(/AI_PROVIDER/)
    expect(() => loadEnv({ ...base, AI_MAX_TOKENS: '0' })).toThrow(/AI_MAX_TOKENS/)
    expect(() => loadEnv({ ...base, AI_EFFORT: 'max' })).toThrow(/AI_EFFORT/)
    expect(() => loadEnv({ ...base, PIN_PEPPER: 'short' })).toThrow(/PIN_PEPPER/)
    expect(loadEnv({ ...base, AI_ENABLED: 'true', AI_DAILY_BUDGET_USD: '2.5' })).toMatchObject({ AI_ENABLED: true, AI_DAILY_BUDGET_USD: 2.5 })
  })

  it('PIN_PEPPER is secret material: it belongs in the secret, never in the plain env files', () => {
    expect(SECRET_KEYS).toContain('PIN_PEPPER')
    expect(FORBIDDEN_SECRET_KEYS.PIN_PEPPER).toBeUndefined()
  })

  it('production: personal links need PIN_PEPPER; the AI may only answer through Bedrock', () => {
    expect(loadEnv(prod).PUBLIC_LINKS_ENABLED).toBe(false)
    expect(() => loadEnv({ ...prod, PUBLIC_LINKS_ENABLED: 'true' })).toThrow(/PIN_PEPPER: required in production when PUBLIC_LINKS_ENABLED/)
    // and only from the Secrets Manager secret (the loader's record; test/ai-foundation/pin-pepper.test.ts)
    expect(() => loadEnv({ ...prod, PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })).toThrow(/PIN_PEPPER: must come from the Secrets Manager secret/)
    expect(loadEnv({ ...prod, PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER }, { secretKeys: new Set(['PIN_PEPPER']) }).PUBLIC_LINKS_ENABLED).toBe(true)
    expect(() => loadEnv({ ...prod, AI_ENABLED: 'true' })).toThrow(/AI_PROVIDER: must be bedrock in production when AI_ENABLED/)
    expect(loadEnv({ ...prod, AI_ENABLED: 'true', AI_PROVIDER: 'bedrock' }).AI_ENABLED).toBe(true)
    // the simulator stays usable everywhere while the AI is off, and outside production with it on
    expect(loadEnv({ ...prod, AI_PROVIDER: 'sim' }).AI_PROVIDER).toBe('sim')
    expect(loadEnv({ ...base, AI_ENABLED: 'true' }).AI_PROVIDER).toBe('sim')
    expect(() => loadEnv({ ...base, PUBLIC_LINKS_ENABLED: 'true' })).toThrow(/PIN_PEPPER: required when PUBLIC_LINKS_ENABLED=true/)
  })
})
