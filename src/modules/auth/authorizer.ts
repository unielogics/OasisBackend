// The session-backed implementation of the platform Authorizer port.
//   resolve:    cookie -> live session -> person -> effective authority (RBAC engine, cached by rbac version) -> AuthContext
//   requirePerm: the platform's permission check over the context's effective permissions
//   verifyCsrf: synchronizer token (X-CSRF-Token) derived from the session's secret; layer 2 after the Origin check
import type { FastifyRequest } from 'fastify'
import type { Env } from '../../config/env.js'
import { checkPermissions, type AuthContext, type Authorizer } from '../../http/authorizer.js'
import { AppError } from '../../platform/errors.js'
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
}

export function createSessionAuthorizer(deps: SessionAuthorizerDeps): Authorizer {
  const cookieName = sessionCookieName(deps.env)

  return {
    knownPermissions: PERMISSION_KEY_SET,

    async resolve(req: FastifyRequest): Promise<AuthContext | null> {
      const token = req.cookies?.[cookieName]
      if (!token) return null
      const rec = await deps.sessions.lookup(token)
      if (!rec) return null

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
      }
      return ctx
    },

    requirePerm: (ctx, perms, mode) => checkPermissions(ctx, perms, mode),

    verifyCsrf(req: FastifyRequest, ctx: AuthContext): void {
      if (!isSessionContext(ctx)) return
      const header = req.headers['x-csrf-token']
      const given = Array.isArray(header) ? header[0] : header
      const expected = csrfTokenFor(ctx.session.csrfSecret, ctx.session.id)
      if (!given || !safeEqual(given, expected)) throw new AppError('CSRF_INVALID')
    },
  }
}
