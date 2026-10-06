/**
 * Two credential modes, both sent as `Authorization: Bearer <token>`:
 *  - api_key: generated in Settings > Advanced > Developer API Keys (Commerce Advanced plan). Never expires.
 *    Cannot call the Webhook Subscriptions API.
 *  - oauth: required for webhook subscriptions. Access tokens last 30 minutes; refresh tokens last 7 days and are
 *    single use, so whatever implements AccessTokenProvider must persist the replacement refresh token atomically.
 */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>
  /** Called once after a 401; return a fresh token or throw. Omit for tokens that cannot be refreshed. */
  refreshAfterUnauthorized?(): Promise<string>
}

export type SquarespaceAuth =
  { kind: 'api_key'; apiKey: string } | { kind: 'oauth'; tokens: AccessTokenProvider }

export class StaticTokenProvider implements AccessTokenProvider {
  constructor(private token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token
  }
  set(token: string): void {
    this.token = token
  }
}

export async function bearerFor(auth: SquarespaceAuth): Promise<string> {
  return auth.kind === 'api_key' ? auth.apiKey : auth.tokens.getAccessToken()
}
