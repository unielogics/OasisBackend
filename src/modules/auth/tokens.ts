import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Opaque 256-bit token, base64url (43 characters). Used for session cookies, invites and password resets. */
export const newToken = (): string => randomBytes(32).toString('base64url')

/** What the database stores: the token itself is never persisted. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** Per-session random secret from which the CSRF token is derived. */
export const newCsrfSecret = (): string => randomBytes(32).toString('base64url')

/**
 * Synchronizer token: HMAC of the session id under the session's own secret. It is stable for the session's life, only
 * valid for that session, and leaking it does not reveal the stored secret.
 */
export const csrfTokenFor = (csrfSecret: string, sessionId: string): string =>
  createHmac('sha256', csrfSecret).update(`oasis-csrf:${sessionId}`).digest('base64url')

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
