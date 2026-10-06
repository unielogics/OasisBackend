// Route handler wrapper for money-effecting commands. The wrapped function runs inside the idempotency transaction and
// returns { status, body }; replays are answered from the stored response with `Idempotent-Replayed: true`.
// Routes declared with config.idempotency = 'required' MUST use this wrapper (checked at boot).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { runIdempotent, type IdempotentResult } from '../platform/idempotency.js'
import type { Tx } from '../platform/db.js'

export const IDEMPOTENT_HANDLER = Symbol.for('oasis.idempotentHandler')

export function idempotentHandler<Req extends FastifyRequest = FastifyRequest>(
  fn: (req: Req, tx: Tx, reply: FastifyReply) => Promise<IdempotentResult>,
): (req: Req, reply: FastifyReply) => Promise<FastifyReply> {
  const handler = async (req: Req, reply: FastifyReply): Promise<FastifyReply> => {
    const app = req.server
    const header = req.headers['idempotency-key']
    const key = typeof header === 'string' ? header : undefined
    // The onRequest/preHandler hooks already rejected a missing key on 'required' routes.
    const out = key
      ? await runIdempotent(
          app.db,
          app.clock,
          {
            key,
            actor: req.auth?.userId ?? `anon:${req.ip}`,
            method: req.method,
            url: req.url,
            route: req.routeOptions.url ?? req.url,
            body: req.body,
          },
          (tx) => fn(req, tx, reply),
        )
      : { ...(await app.db.transaction().execute((tx) => fn(req, tx, reply))), replayed: false }
    reply.status(out.status)
    if (out.headers) for (const [k, v] of Object.entries(out.headers)) reply.header(k, v)
    if (out.replayed) reply.header('Idempotent-Replayed', 'true')
    return out.status === 204 ? reply.send() : reply.send(out.body)
  }
  ;(handler as unknown as Record<symbol, boolean>)[IDEMPOTENT_HANDLER] = true
  return handler
}

export const isIdempotentHandler = (h: unknown): boolean =>
  typeof h === 'function' && (h as unknown as Record<symbol, boolean>)[IDEMPOTENT_HANDLER] === true
