// Every route must declare who may call it. A boot-time hook refuses to start the app when a route has no access
// metadata, and the registry of declared access feeds the authz-matrix test.
export type RouteAccess =
  | { kind: 'permission'; perms: readonly string[]; mode: 'all' | 'any' }
  | { kind: 'authenticated' }
  | { kind: 'public'; reason: string }
  | { kind: 'webhook'; provider: string }

export const access = {
  /** Requires every listed permission key. */
  perm: (...perms: string[]): RouteAccess => ({ kind: 'permission', perms, mode: 'all' }),
  /** Requires at least one of the listed permission keys. */
  anyPerm: (...perms: string[]): RouteAccess => ({ kind: 'permission', perms, mode: 'any' }),
  /** Any signed-in user. */
  authenticated: (): RouteAccess => ({ kind: 'authenticated' }),
  /** No session needed; the reason is mandatory so reviewers see why. */
  public: (reason: string): RouteAccess => ({ kind: 'public', reason }),
  /** Signed provider callback under /hooks/*: no Origin, CSRF or idempotency-key requirement; verified by signature. */
  webhook: (provider: string): RouteAccess => ({ kind: 'webhook', provider }),
}

export type IdempotencyMode = 'required' | 'optional'

export interface RouteRecord {
  method: string
  url: string
  access: RouteAccess
  idempotency?: IdempotencyMode
  operationId?: string
  tags?: readonly string[]
}

export function describeAccess(a: RouteAccess): string {
  switch (a.kind) {
    case 'permission':
      return a.perms.join(a.mode === 'all' ? ' + ' : ' | ')
    case 'authenticated':
      return 'authenticated'
    case 'public':
      return 'public'
    case 'webhook':
      return `webhook:${a.provider}`
  }
}
