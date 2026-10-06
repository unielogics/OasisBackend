import type { Clock } from '../../platform/clock.js'
import type { AccessTokenProvider } from './auth.js'

/**
 * OAuth token refresh, per https://developers.squarespace.com/commerce-apis/oauth (fetched 2026-10-06):
 * POST https://login.squarespace.com/api/1/login/oauth/provider/tokens, Basic client_id:client_secret,
 * grant_type=refresh_token. Access tokens live 30 minutes; refresh tokens 7 days and are single use, so the replacement
 * pair MUST be saved before the new access token is used. The store is an interface: the integrator persists it in an
 * encrypted table (review B45). Not exercised against the live service.
 */
export const TOKEN_ENDPOINT = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens'

export interface StoredOAuthTokens {
  accessToken: string
  accessTokenExpiresAt: Date
  refreshToken: string
  refreshTokenExpiresAt?: Date
}

export interface OAuthTokenStore {
  load(): Promise<StoredOAuthTokens | undefined>
  save(tokens: StoredOAuthTokens): Promise<void>
}

export class InMemoryOAuthTokenStore implements OAuthTokenStore {
  constructor(private tokens?: StoredOAuthTokens) {}
  async load(): Promise<StoredOAuthTokens | undefined> {
    return this.tokens
  }
  async save(tokens: StoredOAuthTokens): Promise<void> {
    this.tokens = tokens
  }
}

export class OAuthReauthorizationRequired extends Error {}

export interface RefreshingTokenProviderOptions {
  clientId: string
  clientSecret: string
  store: OAuthTokenStore
  clock: Clock
  userAgent: string
  fetch?: typeof fetch
  tokenEndpoint?: string
  /** Refresh when fewer than this many ms remain (docs example uses 10 s; default 60 s). */
  refreshSkewMs?: number
}

export class RefreshingTokenProvider implements AccessTokenProvider {
  private inflight?: Promise<string>
  constructor(private readonly o: RefreshingTokenProviderOptions) {}

  async getAccessToken(): Promise<string> {
    const t = await this.o.store.load()
    if (!t) throw new OAuthReauthorizationRequired('no stored OAuth tokens: authorize the app first')
    const skew = this.o.refreshSkewMs ?? 60_000
    if (t.accessTokenExpiresAt.getTime() - this.o.clock.now().getTime() > skew) return t.accessToken
    return this.refresh()
  }

  async refreshAfterUnauthorized(): Promise<string> {
    return this.refresh()
  }

  private refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async doRefresh(): Promise<string> {
    const current = await this.o.store.load()
    if (!current) throw new OAuthReauthorizationRequired('no stored OAuth tokens: authorize the app first')
    const now = this.o.clock.now()
    if (current.refreshTokenExpiresAt && current.refreshTokenExpiresAt <= now) {
      throw new OAuthReauthorizationRequired('refresh token expired (7 day lifetime): re-authorize the app')
    }
    const basic = Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')
    const res = await (this.o.fetch ?? fetch)(this.o.tokenEndpoint ?? TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        'User-Agent': this.o.userAgent,
      },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
    })
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        throw new OAuthReauthorizationRequired(`token refresh rejected (${res.status}): re-authorize the app`)
      }
      throw new Error(`token refresh failed (${res.status})`)
    }
    const body = (await res.json()) as {
      access_token?: string
      access_token_expires_at?: string
      refresh_token?: string
      refresh_token_expires_at?: string
    }
    if (!body.access_token || !body.refresh_token) throw new Error('token refresh response missing tokens')
    const next: StoredOAuthTokens = {
      accessToken: body.access_token,
      accessTokenExpiresAt:
        epochSeconds(body.access_token_expires_at) ?? new Date(now.getTime() + 30 * 60_000),
      refreshToken: body.refresh_token,
      refreshTokenExpiresAt:
        epochSeconds(body.refresh_token_expires_at) ?? new Date(now.getTime() + 7 * 86400_000),
    }
    await this.o.store.save(next) // single-use refresh token: persist before anyone uses the new access token
    return next.accessToken
  }
}

function epochSeconds(v: string | undefined): Date | undefined {
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? new Date(Math.round(n * 1000)) : undefined
}
