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

// --- kiosk cookies (ADR 0180) ---------------------------------------------------------------------------------------------------

type KioskCookieEnv = Pick<Env, 'NODE_ENV' | 'COOKIE_SECURE'>

/** The registered-device cookie: 400 days (the browsers' cap), set again on every unlock so a tablet in daily use never ages out. */
export const KIOSK_DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60

const hostPrefixed = (env: KioskCookieEnv, name: string): string =>
  env.NODE_ENV === 'production' && env.COOKIE_SECURE ? `__Host-${name}` : name

/** `__Host-oasis_kdev` in production behind HTTPS, else `oasis_kdev`. */
export const kioskDeviceCookieName = (env: KioskCookieEnv): string => hostPrefixed(env, 'oasis_kdev')
/** `__Host-oasis_ksid` in production behind HTTPS, else `oasis_ksid`. */
export const kioskSessionCookieName = (env: KioskCookieEnv): string => hostPrefixed(env, 'oasis_ksid')

// SameSite=Lax like the user session (a return trip from the Square app or a link must still carry it); unsafe requests also need
// the CSRF token and an allowed Origin.
const kioskCookieOptions = (env: KioskCookieEnv) =>
  ({ httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/' }) as const

export function setKioskDeviceCookie(reply: FastifyReply, env: KioskCookieEnv, token: string): void {
  void reply.setCookie(kioskDeviceCookieName(env), token, {
    ...kioskCookieOptions(env),
    maxAge: KIOSK_DEVICE_COOKIE_MAX_AGE_S,
  })
}

/** Lives until the lock time, counted by the browser (the same reason as setSessionCookie). */
export function setKioskSessionCookie(
  reply: FastifyReply,
  env: KioskCookieEnv,
  token: string,
  maxAgeSeconds: number,
): void {
  void reply.setCookie(kioskSessionCookieName(env), token, {
    ...kioskCookieOptions(env),
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  })
}

export function clearKioskSessionCookie(reply: FastifyReply, env: KioskCookieEnv): void {
  void reply.clearCookie(kioskSessionCookieName(env), kioskCookieOptions(env))
}

export function clearKioskDeviceCookie(reply: FastifyReply, env: KioskCookieEnv): void {
  void reply.clearCookie(kioskDeviceCookieName(env), kioskCookieOptions(env))
}
