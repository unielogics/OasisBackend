// The Authorizer is the seam between the HTTP platform and the auth/RBAC module (a later workstream).
// The platform asks it to resolve a session into an AuthContext and to enforce permissions; it never knows how.
import type { FastifyRequest } from 'fastify'
import { AppError } from '../platform/errors.js'
import type { AuditContext } from '../platform/audit.js'

/** The kiosk side of a kiosk request's context (ADR 0180). */
export interface KioskAuthInfo {
  /** kiosk_sessions.id (the sha256 of the session cookie token). */
  sessionId: string
  deviceId: string
  deviceName: string
  csrfSecret: string
  locksAt: Date
  /** The employee tapped for this request (X-Oasis-Employee), bound on unsafe requests only; null on reads. */
  acting: { id: string; first: string; last: string; name: string } | null
}

export interface AuthContext {
  /** Absent = a user (the test authorizers). */
  kind?: 'user' | 'kiosk'
  /**
   * The signed-in user; null for a kiosk (ADR 0180: on purpose, so the compiler lists every user-id write, each of which records the
   * acting employee instead).
   */
  userId: string | null
  /** A user's own employee record; for a kiosk the ACTING employee of this request (null on reads and until bound). */
  employeeId: string | null
  locationId: string
  /** Effective permission keys. '*' grants everything (test authorizers only). */
  permissions: ReadonlySet<string>
  /** Money limits in cents per limit kind; null = unlimited, absent = the default. */
  limits?: Readonly<Record<string, number | null>>
  actorName?: string
  roles?: readonly string[]
  /** Set when a Super Admin is viewing as another role; permissions are then evaluated as that role. */
  viewAsRoleId?: string | null
  /** The real person behind a view-as session. */
  realUserId?: string | null
  sessionId?: string
  /** Set exactly when kind is 'kiosk'. */
  kiosk?: KioskAuthInfo
}

export type KioskAuthContext = AuthContext & { kind: 'kiosk'; kiosk: KioskAuthInfo }

export const isKioskContext = (ctx: AuthContext | null | undefined): ctx is KioskAuthContext =>
  !!ctx && ctx.kind === 'kiosk' && !!ctx.kiosk

/**
 * Who a request counts as for rate limits, idempotency keys and the event-stream cap: the device for a kiosk (one tablet is one caller,
 * whoever taps), else the user.
 */
export const principalKey = (ctx: AuthContext): string =>
  isKioskContext(ctx) ? `kiosk:${ctx.kiosk.deviceId}` : `user:${ctx.userId}`

/**
 * Who owns the caller's stored idempotency and request keys: the user id (unchanged for users, so keys stored before kiosk mode still
 * replay), or `kiosk:<device id>` for a kiosk. Never null: two kiosks never share a key space.
 */
export const keyOwnerOf = (ctx: AuthContext): string =>
  isKioskContext(ctx) ? principalKey(ctx) : (ctx.userId ?? 'anonymous')

export interface Authorizer {
  /** Permission keys that exist; when provided, routes naming an unknown key fail at boot. */
  readonly knownPermissions?: ReadonlySet<string>
  /**
   * Resolves the request's session (cookie) into a context, or null when unauthenticated. `touch: false` is a re-check
   * that must not slide the session's idle expiry (an open event stream is not activity).
   */
  resolve(req: FastifyRequest, opts?: { touch?: boolean }): Promise<AuthContext | null>
  /** Throws AppError('FORBIDDEN') unless the context satisfies the permissions. */
  requirePerm(ctx: AuthContext, perms: readonly string[], mode?: 'all' | 'any'): void
  /** Per-channel SSE subscription check; defaults to the CHANNEL_PERMISSION table when absent. */
  canSubscribe?(ctx: AuthContext, channel: string): boolean
  /** Synchronizer-token CSRF check for unsafe methods on session-authenticated routes. Throws on failure. */
  verifyCsrf?(req: FastifyRequest, ctx: AuthContext): void | Promise<void>
  /**
   * Kiosk contexts only (ADR 0180): binds the employee named by X-Oasis-Employee as the request's actor (422 when it is not an active
   * or invited, listed employee of the device's location); `required` answers 428 when the header is missing. Without it a kiosk
   * context can never write (the request hooks fail closed).
   */
  bindKioskActor?(req: FastifyRequest, ctx: KioskAuthContext, required: boolean): Promise<void>
}

export const hasPermission = (ctx: AuthContext, perm: string): boolean =>
  ctx.permissions.has('*') || ctx.permissions.has(perm)

export function checkPermissions(
  ctx: AuthContext,
  perms: readonly string[],
  mode: 'all' | 'any' = 'all',
): void {
  const ok =
    mode === 'all' ? perms.every((p) => hasPermission(ctx, p)) : perms.some((p) => hasPermission(ctx, p))
  if (!ok) throw new AppError('FORBIDDEN', { meta: { required: [...perms], mode } })
}

/** What audit.record needs from the request: actor, request id, idempotency key, client ip. */
export function auditContextOf(req: FastifyRequest): AuditContext {
  const a = req.auth
  const key = req.headers['idempotency-key']
  return {
    actor: a
      ? {
          userId: a.realUserId ?? a.userId,
          employeeId: a.employeeId,
          name: a.actorName ?? null,
          roles: a.roles?.join(',') ?? null,
          viewAsRoleId: a.viewAsRoleId ?? null,
        }
      : undefined,
    requestId: req.id,
    idempotencyKey: typeof key === 'string' ? key : null,
    ip: req.ip,
    kioskDeviceId: isKioskContext(a) ? a.kiosk.deviceId : null,
  }
}

/** Always unauthenticated: the fail-closed default until the auth module provides the real implementation. */
export function createDenyAuthorizer(): Authorizer {
  return {
    resolve: async () => null,
    requirePerm: (ctx, perms, mode) => checkPermissions(ctx, perms, mode),
  }
}

export interface PermissiveAuthorizerOptions {
  locationId: string
  userId?: string
  employeeId?: string | null
  actorName?: string
}

/**
 * Test and local-development authorizer. Everyone is signed in with every permission unless the request says
 * otherwise: `x-test-anonymous: 1` is unauthenticated, `x-test-permissions: a,b` narrows the permission set and
 * `x-test-user: <uuid>` changes the user. Refuses to be constructed in production.
 */
export function createPermissiveAuthorizer(o: PermissiveAuthorizerOptions): Authorizer {
  if (process.env.NODE_ENV === 'production')
    throw new Error('The permissive authorizer must not be used in production')
  return {
    async resolve(req) {
      if (req.headers['x-test-anonymous']) return null
      const narrowed = req.headers['x-test-permissions']
      const user = req.headers['x-test-user']
      return {
        userId: typeof user === 'string' ? user : (o.userId ?? '00000000-0000-7000-8000-000000000001'),
        employeeId: o.employeeId ?? null,
        locationId: o.locationId,
        permissions: new Set(typeof narrowed === 'string' ? narrowed.split(',').filter(Boolean) : ['*']),
        actorName: o.actorName ?? 'Test User',
        roles: ['test'],
      }
    },
    requirePerm: (ctx, perms, mode) => checkPermissions(ctx, perms, mode),
  }
}
