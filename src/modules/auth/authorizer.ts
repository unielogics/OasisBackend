// The session-backed implementation of the platform Authorizer port.
//   resolve:    cookie -> live session -> person -> effective authority (RBAC engine, cached by rbac version) -> AuthContext
//   requirePerm: the platform's permission check over the context's effective permissions
//   verifyCsrf: synchronizer token (X-CSRF-Token) derived from the session's secret; layer 2 after the Origin check
// Kiosk mode (ADR 0180): when no live user session comes with the request, the kiosk resolver may produce a kiosk context (a kiosk
// session cookie plus the cookie of the live device it was opened on, while kiosk mode is on). A user session always wins: with both,
// the request is the user's and X-Oasis-Employee is ignored.
import type { FastifyRequest } from 'fastify'
import type { Env } from '../../config/env.js'
import {
  checkPermissions,
  isKioskContext,
  type AuthContext,
  type Authorizer,
  type KioskAuthContext,
} from '../../http/authorizer.js'
import { AppError } from '../../platform/errors.js'
import '../kiosk/problems.js'
import { PERMISSION_KEY_SET } from '../rbac/catalog.js'
import type { RbacService } from '../rbac/service.js'
import { displayName, isSessionContext, type SessionAuthContext } from './context.js'
import { sessionCookieName } from './cookie.js'
import type { SessionService } from './sessions.js'
import { csrfTokenFor, safeEqual } from './tokens.js'

export interface SessionAuthorizerDeps {
  env: Pick<Env, 'NODE_ENV' | 'COOKIE_SECURE' | 'SESSION_COOKIE_NAME'>
  sessions: SessionService
  rbac: RbacService
  /** Location used when an employee has no employee_locations row yet. */
  defaultLocationId: string
  /** Kiosk mode (ADR 0180); absent = no kiosk contexts. */
  kiosk?: KioskResolver
}

export interface KioskResolver {
  resolveContext(req: FastifyRequest, opts?: { touch?: boolean }): Promise<KioskAuthContext | null>
  bindActor(req: FastifyRequest, ctx: KioskAuthContext, required: boolean): Promise<void>
  /** The live registered device named by the request's device cookie, or null. */
  liveDeviceOf(req: FastifyRequest): Promise<string | null>
}

export function createSessionAuthorizer(deps: SessionAuthorizerDeps): Authorizer {
  const cookieName = sessionCookieName(deps.env)

  return {
    knownPermissions: PERMISSION_KEY_SET,

    async resolve(req: FastifyRequest, opts?: { touch?: boolean }): Promise<AuthContext | null> {
      const token = req.cookies?.[cookieName]
      let rec = token ? await deps.sessions.lookup(token, opts) : null
      if (!rec) return deps.kiosk ? deps.kiosk.resolveContext(req, opts) : null
      // a session that comes with the cookie of a live kiosk device is a manager on the shared tablet, however it was opened (before
      // the tablet was registered, an invite accepted there, ...): it is tied to the device for good and gets the short timings
      if (token && !rec.kioskDevice && deps.kiosk) {
        const deviceId = await deps.kiosk.liveDeviceOf(req)
        if (deviceId && (await deps.sessions.attachKioskDevice(rec.id, deviceId))) {
          rec = await deps.sessions.lookup(token, { touch: false })
          if (!rec) return null
        }
      }

      const real = await deps.rbac.authorityFor(rec.employee.id, rec.rbacVersion)
      const canViewAs = real.isSuper
      let authority = real
      let viewAsRole: SessionAuthContext['viewAsRole'] = null
      if (rec.viewAsRoleId && canViewAs) {
        const viewed = await deps.rbac.viewAsAuthorityFor(rec.viewAsRoleId, rec.rbacVersion)
        if (viewed) {
          authority = viewed
          viewAsRole = { id: rec.viewAsRoleId, name: viewed.roles[0]!.name }
        }
      }

      const e = rec.employee
      const name = displayName(e.first, e.last)
      const ctx: SessionAuthContext = {
        userId: rec.userId,
        employeeId: e.id,
        locationId: rec.locationId ?? deps.defaultLocationId,
        permissions: authority.permissions,
        limits: authority.limits,
        actorName: name,
        roles: authority.roles.map((r) => r.name),
        viewAsRoleId: viewAsRole?.id ?? null,
        realUserId: viewAsRole ? rec.userId : null,
        sessionId: rec.id,
        session: { id: rec.id, csrfSecret: rec.csrfSecret, absoluteExpiresAt: rec.absoluteExpiresAt },
        email: rec.user.email,
        employee: {
          id: e.id,
          first: e.first,
          last: e.last,
          displayName: name,
          title: e.title,
          phone: e.phone,
          email: e.email,
          avatarColor: e.avatarColor,
        },
        rbacVersion: rec.rbacVersion,
        canViewAs,
        isSuper: authority.isSuper,
        viewAsRole,
        authority,
        kioskDevice: rec.kioskDevice,
      }
      return ctx
    },

    requirePerm: (ctx, perms, mode) => checkPermissions(ctx, perms, mode),

    verifyCsrf(req: FastifyRequest, ctx: AuthContext): void {
      const header = req.headers['x-csrf-token']
      const given = Array.isArray(header) ? header[0] : header
      let expected: string
      if (isKioskContext(ctx)) expected = csrfTokenFor(ctx.kiosk.csrfSecret, ctx.kiosk.sessionId)
      else if (isSessionContext(ctx)) expected = csrfTokenFor(ctx.session.csrfSecret, ctx.session.id)
      else return
      if (!given || !safeEqual(given, expected)) throw new AppError('CSRF_INVALID')
    },

    async bindKioskActor(req: FastifyRequest, ctx: KioskAuthContext, required: boolean): Promise<void> {
      if (!deps.kiosk) throw new AppError('KIOSK_FORBIDDEN')
      await deps.kiosk.bindActor(req, ctx, required)
    },
  }
}
