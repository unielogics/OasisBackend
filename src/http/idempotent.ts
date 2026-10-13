// Route handler wrapper for money-effecting commands. The wrapped function runs inside the idempotency transaction and
// returns { status, body }; replays are answered from the stored response with `Idempotent-Replayed: true`.
// Routes declared with config.idempotency = 'required' MUST use this wrapper (checked at boot).
import type { FastifyReply, FastifyRequest } from 'fastify'
import { runIdempotent, type IdempotentResult } from '../platform/idempotency.js'
import type { Tx } from '../platform/db.js'
import { keyOwnerOf } from './authorizer.js'

export const IDEMPOTENT_HANDLER = Symbol.for('oasis.idempotentHandler')

export interface IdempotentHandlerOptions<Req, P> {
  /**
   * Work that must not run inside the command's transaction: reads on the pool and writes that must survive a failing command
   * (durable rate limits). It runs after the key is claimed and before the transaction opens, never on a replay, and what it
   * throws releases the key. The command must then use only `tx`: a pool query from inside the transaction would hold one
   * connection while waiting for a second, which deadlocks a full pool.
   */
  prepare?: (req: Req) => Promise<P>
  /**
   * Who owns the key when the request has no signed-in user (default: `anon:<address>`). A route that acts for something that is not
   * in the body (the personal-link pages: their link) names it here, so two links behind one address can never replay each other's
   * stored answer with the same key and body, while a retry from a re-opened page of the same link replays its own (W4c fixes). It
   * is resolved before the key is claimed; what it throws answers the request and claims nothing.
   */
  actor?: (req: Req) => string | Promise<string>
}

export function idempotentHandler<Req extends FastifyRequest = FastifyRequest, P = undefined>(
  fn: (req: Req, tx: Tx, reply: FastifyReply, prepared: P) => Promise<IdempotentResult>,
  o: IdempotentHandlerOptions<Req, P> = {},
): (req: Req, reply: FastifyReply) => Promise<FastifyReply> {
  const handler = async (req: Req, reply: FastifyReply): Promise<FastifyReply> => {
    const app = req.server
    const header = req.headers['idempotency-key']
    const key = typeof header === 'string' ? header : undefined
    const prepare = o.prepare ? () => o.prepare!(req) : undefined
    const owner = key ? (req.auth ? keyOwnerOf(req.auth) : o.actor ? await o.actor(req) : `anon:${req.ip}`) : ''
    // The onRequest/preHandler hooks already rejected a missing key on 'required' routes.
    const out = key
      ? await runIdempotent(
          app.db,
          app.clock,
          {
            key,
            actor: owner,
            method: req.method,
            url: req.url,
            route: req.routeOptions.url ?? req.url,
            body: req.body,
          },
          (tx, prepared: P) => fn(req, tx, reply, prepared),
          prepare,
        )
      : await (async () => {
          const prepared = (prepare ? await prepare() : undefined) as P
          return { ...(await app.db.transaction().execute((tx) => fn(req, tx, reply, prepared))), replayed: false }
        })()
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
