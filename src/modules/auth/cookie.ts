import type { FastifyReply } from 'fastify'
import type { Env } from '../../config/env.js'

type CookieEnv = Pick<Env, 'NODE_ENV' | 'COOKIE_SECURE' | 'SESSION_COOKIE_NAME'>

/**
 * Cookie name. In production behind HTTPS the `__Host-` prefix pins the cookie to this host (no Domain, Path=/, Secure),
 * so a sibling subdomain cannot plant or shadow it. The browsers only accept that prefix on Secure cookies, hence it
 * follows COOKIE_SECURE. The dashboard's cheap "is there a session cookie" check must use this name.
 */
export function sessionCookieName(env: CookieEnv): string {
  return env.NODE_ENV === 'production' && env.COOKIE_SECURE
    ? `__Host-${env.SESSION_COOKIE_NAME}`
    : env.SESSION_COOKIE_NAME
}

export function setSessionCookie(reply: FastifyReply, env: CookieEnv, token: string, expires: Date): void {
  void reply.setCookie(sessionCookieName(env), token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires,
  })
}

export function clearSessionCookie(reply: FastifyReply, env: CookieEnv): void {
  void reply.clearCookie(sessionCookieName(env), {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  })
}
