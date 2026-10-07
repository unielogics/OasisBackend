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

/**
 * The cookie lives for `maxAgeSeconds` counted by the browser, not until an absolute date: the server's clock can be
 * frozen or offset (the design's pinned day, test stacks) and an `Expires` computed from it would already be in the
 * browser's past. The server still enforces the real session expiry.
 */
export function setSessionCookie(
  reply: FastifyReply,
  env: CookieEnv,
  token: string,
  maxAgeSeconds: number,
): void {
  void reply.setCookie(sessionCookieName(env), token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
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
