// The AuthContext the session authorizer produces: the platform's fields plus what the auth/people routes need.
import type { FastifyRequest } from 'fastify'
import type { AuthContext } from '../../http/authorizer.js'
import { AppError } from '../../platform/errors.js'
import type { Authority } from '../rbac/service.js'

export interface SessionInfo {
  id: string
  csrfSecret: string
  absoluteExpiresAt: Date
}

export interface SessionAuthContext extends AuthContext {
  session: SessionInfo
  email: string
  employee: {
    id: string
    first: string
    last: string
    displayName: string
    title: string
    phone: string
    email: string | null
    avatarColor: string | null
  }
  rbacVersion: number
  /** The REAL person holds the locked Super Admin role (independent of any role being viewed). */
  canViewAs: boolean
  /** The effective authority includes the locked Super Admin role (false while viewing as a lesser role). */
  isSuper: boolean
  viewAsRole: { id: string; name: string } | null
  /** The roles that decide authority now: the person's own, or the one viewed role. */
  authority: Authority
}

export const isSessionContext = (ctx: AuthContext | null | undefined): ctx is SessionAuthContext =>
  !!ctx && typeof (ctx as Partial<SessionAuthContext>).session === 'object'

/** The signed-in session context of a request, or 401 (also when a test authorizer without sessions is installed). */
export function sessionContext(req: FastifyRequest): SessionAuthContext {
  if (!isSessionContext(req.auth)) throw new AppError('UNAUTHENTICATED')
  return req.auth
}

/** "Marco R." — first name and last initial. */
export function displayName(first: string, last: string): string {
  const l = last.trim()
  return l ? `${first.trim()} ${l[0]!.toUpperCase()}.` : first.trim()
}

export function initials(first: string, last: string): string {
  return `${first.trim()[0] ?? ''}${last.trim()[0] ?? ''}`.toUpperCase()
}
