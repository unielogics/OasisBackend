// Provider callbacks live under /hooks/* and are exempt from Origin, CSRF and Idempotency-Key checks; they are
// authenticated by signature and de-duplicated through webhook_log (provider, external_id).
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../platform/errors.js'
import { access } from './access.js'
import type { AppInstance } from './types.js'

export const WEBHOOK_BODY_LIMIT = 1024 * 1024

/** Keeps the exact request bytes in req.rawBody (HMAC needs them) and also parses JSON into req.body. */
export function installRawBodyParsers(scope: AppInstance): void {
  const parse = (
    req: FastifyRequest,
    body: string,
    done: (err: Error | null, value?: unknown) => void,
  ): void => {
    req.rawBody = body
    if (body === '') return done(null, undefined)
    try {
      done(null, JSON.parse(body))
    } catch {
      done(new AppError('MALFORMED_REQUEST'))
    }
  }
  scope.removeContentTypeParser(['application/json', 'text/plain'])
  scope.addContentTypeParser(
    ['application/json', 'text/plain'],
    { parseAs: 'string', bodyLimit: WEBHOOK_BODY_LIMIT },
    parse,
  )
}

export interface WebhookRouteOptions {
  provider: string
  /** Path below /hooks, e.g. "/smsgate" or "/squarespace". */
  path: string
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>
}

export function webhookRoute(scope: AppInstance, o: WebhookRouteOptions): void {
  scope.post(
    o.path,
    {
      bodyLimit: WEBHOOK_BODY_LIMIT,
      config: { access: access.webhook(o.provider), rateLimit: false },
      schema: { hide: true },
    },
    o.handler,
  )
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

/** Constant-time comparison of two hex/base64 strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
