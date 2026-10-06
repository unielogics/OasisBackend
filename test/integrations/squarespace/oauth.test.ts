import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import {
  InMemoryOAuthTokenStore,
  OAuthReauthorizationRequired,
  RefreshingTokenProvider,
  TOKEN_ENDPOINT,
  type StoredOAuthTokens,
} from '../../../src/integrations/squarespace/oauth.js'
import { loadSquarespaceEnv } from '../../../src/integrations/squarespace/config.js'
import { NOW } from '../../fixtures/squarespace/load.js'

const t0 = Date.parse(NOW)
const stored = (over: Partial<StoredOAuthTokens> = {}): StoredOAuthTokens => ({
  accessToken: 'at-1',
  accessTokenExpiresAt: new Date(t0 + 10 * 60_000),
  refreshToken: 'rt-1',
  refreshTokenExpiresAt: new Date(t0 + 6 * 86400_000),
  ...over,
})

function setup(initial: StoredOAuthTokens | undefined, respond: () => Response) {
  const clock = new FixedClock(NOW)
  const store = new InMemoryOAuthTokenStore(initial)
  const calls: { url: string; init: RequestInit }[] = []
  const provider = new RefreshingTokenProvider({
    clientId: 'cid',
    clientSecret: 'secret',
    store,
    clock,
    userAgent: 'OasisTest/1.0',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return respond()
    }) as unknown as typeof fetch,
  })
  return { clock, store, calls, provider }
}

const refreshResponse = () =>
  new Response(
    JSON.stringify({
      token_type: 'bearer',
      access_token: 'at-2',
      access_token_expires_at: String((t0 + 30 * 60_000) / 1000),
      refresh_token: 'rt-2',
      refresh_token_expires_at: String((t0 + 7 * 86400_000) / 1000),
    }),
    { status: 200 },
  )

describe('RefreshingTokenProvider', () => {
  it('uses the stored token while it is fresh and does not call the network', async () => {
    const s = setup(stored(), refreshResponse)
    expect(await s.provider.getAccessToken()).toBe('at-1')
    expect(s.calls).toHaveLength(0)
  })

  it('refreshes near expiry with Basic auth, grant_type=refresh_token, a User-Agent, and persists the new pair', async () => {
    const s = setup(stored({ accessTokenExpiresAt: new Date(t0 + 30_000) }), refreshResponse)
    expect(await s.provider.getAccessToken()).toBe('at-2')
    const call = s.calls[0]!
    expect(call.url).toBe(TOKEN_ENDPOINT)
    const h = new Headers(call.init.headers)
    expect(h.get('authorization')).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`)
    expect(h.get('user-agent')).toBe('OasisTest/1.0')
    expect(JSON.parse(String(call.init.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1' })
    const saved = await s.store.load()
    expect(saved).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' })
    expect(saved!.accessTokenExpiresAt.getTime()).toBe(t0 + 30 * 60_000)
  })

  it('single-flights concurrent refreshes (the refresh token is single use)', async () => {
    const s = setup(stored({ accessTokenExpiresAt: new Date(t0 - 1) }), refreshResponse)
    const [a, b, c] = await Promise.all([
      s.provider.getAccessToken(),
      s.provider.getAccessToken(),
      s.provider.refreshAfterUnauthorized(),
    ])
    expect([a, b, c]).toEqual(['at-2', 'at-2', 'at-2'])
    expect(s.calls).toHaveLength(1)
  })

  it('requires re-authorization when nothing is stored, the refresh token expired, or Squarespace rejects it', async () => {
    await expect(setup(undefined, refreshResponse).provider.getAccessToken()).rejects.toBeInstanceOf(
      OAuthReauthorizationRequired,
    )
    const expired = setup(
      stored({ accessTokenExpiresAt: new Date(t0 - 1), refreshTokenExpiresAt: new Date(t0 - 1) }),
      refreshResponse,
    )
    await expect(expired.provider.getAccessToken()).rejects.toBeInstanceOf(OAuthReauthorizationRequired)
    expect(expired.calls).toHaveLength(0)
    const rejected = setup(
      stored({ accessTokenExpiresAt: new Date(t0 - 1) }),
      () => new Response('{}', { status: 400 }),
    )
    await expect(rejected.provider.getAccessToken()).rejects.toBeInstanceOf(OAuthReauthorizationRequired)
  })

  it('does not overwrite the stored pair when the refresh call fails', async () => {
    const s = setup(
      stored({ accessTokenExpiresAt: new Date(t0 - 1) }),
      () => new Response('{}', { status: 503 }),
    )
    await expect(s.provider.getAccessToken()).rejects.toThrow(/503/)
    expect((await s.store.load())!.refreshToken).toBe('rt-1')
  })
})

describe('loadSquarespaceEnv', () => {
  it('defaults to the simulator and the documented base URL', () => {
    const e = loadSquarespaceEnv({})
    expect(e).toMatchObject({
      SQSP_PROVIDER: 'sim',
      SQSP_API_BASE: 'https://api.squarespace.com',
      SQSP_POLL_INTERVAL_SECONDS: 120,
      SQSP_OVERLAP_SECONDS: 300,
      SQSP_RECONCILE_DAYS: 45,
      SQSP_INCLUDE_TEST_ORDERS: false,
      SQSP_MEMBERSHIP_GRACE_DAYS: 7,
    })
  })

  it('requires a key for live and a hex webhook secret; coerces numbers and booleans', () => {
    expect(() => loadSquarespaceEnv({ SQSP_PROVIDER: 'live' })).toThrow(/SQSP_API_KEY/)
    expect(() => loadSquarespaceEnv({ SQSP_WEBHOOK_SECRET: 'zz' })).toThrow(/SQSP_WEBHOOK_SECRET/)
    const e = loadSquarespaceEnv({
      SQSP_PROVIDER: 'live',
      SQSP_API_KEY: 'k',
      SQSP_INCLUDE_TEST_ORDERS: 'true',
      SQSP_REQUESTS_PER_MINUTE: '100',
    })
    expect(e.SQSP_INCLUDE_TEST_ORDERS).toBe(true)
    expect(e.SQSP_REQUESTS_PER_MINUTE).toBe(100)
    expect(() => loadSquarespaceEnv({ SQSP_REQUESTS_PER_MINUTE: '1000' })).toThrow()
  })
})

describe('paymentsSyncConfigFromEnv', () => {
  it('maps the environment onto sync, matcher, membership and the product map', async () => {
    const { paymentsSyncConfigFromEnv } = await import('../../../src/modules/payments-sync/config.js')
    const env = loadSquarespaceEnv({
      SQSP_OVERLAP_SECONDS: '600',
      SQSP_MEMBERSHIP_GRACE_DAYS: '3',
      SQSP_LINK_WINDOW_DAYS: '7',
      SQSP_INCLUDE_TEST_ORDERS: '1',
      SQSP_PRODUCT_MAP: '[{"sku":"MEM-PREMIUM","kind":"membership","tierLabel":"Premium Care"}]',
    })
    const c = paymentsSyncConfigFromEnv(env)
    expect(c.sync).toMatchObject({
      overlapMs: 600_000,
      maxRequestsPerRun: 120,
      reconcileDays: 45,
      includeTestMode: true,
    })
    expect(c.matcher).toMatchObject({
      confidenceThreshold: 0.8,
      linkWindowMs: 7 * 86_400_000,
      linkAmountToleranceCents: 1,
      includeTestMode: true,
    })
    expect(c.membership).toMatchObject({ graceDays: 3, includeTestMode: true })
    expect(c.productMap.resolve({ sku: 'MEM-PREMIUM' })?.tier).toBe('premium')
  })
})
