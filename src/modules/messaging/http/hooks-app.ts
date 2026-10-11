// The tailnet-facing listener. The SMS Gate webhook is served ONLY here (HOOKS_HOST:HOOKS_PORT, default 127.0.0.1:3002,
// reached through `tailscale serve --set-path /hooks/smsgate`); the public listener has no such route and answers 404.
import Fastify, { type FastifyInstance } from 'fastify'
import { installRawBodyParsers, WEBHOOK_BODY_LIMIT } from '../../../http/webhooks.js'
import type { AppInstance } from '../../../http/types.js'
import type { MessagingRuntime } from '../runtime.js'

const SWEEP_EVERY_MS = 30_000
/**
 * A downloaded MMS carries its attachments base64-encoded in the webhook body (a few MB per picture), so the SMS Gate route
 * takes up to 16 MB; anything larger is answered 413. Every other path of this listener keeps WEBHOOK_BODY_LIMIT (1 MB).
 */
export const SMSGATE_WEBHOOK_BODY_LIMIT = 16 * 1024 * 1024

export interface HooksApp {
  app: FastifyInstance
  /** Starts listening; resolves with the bound address. */
  listen(): Promise<string>
  close(): Promise<void>
}

export async function buildHooksApp(rt: MessagingRuntime, o: { host: string; port: number; logger?: import('fastify').FastifyBaseLogger }): Promise<HooksApp> {
  const app = Fastify({ ...(o.logger ? { loggerInstance: o.logger } : { logger: false }), bodyLimit: WEBHOOK_BODY_LIMIT, trustProxy: false })
  installRawBodyParsers(app as unknown as AppInstance)

  app.post<{ Params: { deviceKey: string } }>('/hooks/smsgate/:deviceKey', { bodyLimit: SMSGATE_WEBHOOK_BODY_LIMIT }, async (req, reply) => {
    const res = await rt.webhooks.receive(req.params.deviceKey, req.headers, req.rawBody ?? '')
    return reply.code(res.status).send(res.body)
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, status: 'not_found' }))
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? (err as { status?: number }).status // Fastify's own errors, or an AppError from the body parser
    if (status === 413) {
      req.log.warn({ bytes: req.headers['content-length'] ?? null }, 'hooks listener: body over the limit')
      return reply.code(413).send({ ok: false, status: 'payload_too_large' })
    }
    req.log.error({ err: err.message }, 'hooks listener error')
    // 5xx makes the device retry the delivery, which is what we want for anything we did not persist
    return reply.code(status && status >= 400 && status < 500 ? status : 500).send({ ok: false, status: 'error' })
  })
  await app.ready()

  let sweep: NodeJS.Timeout | undefined
  return {
    app,
    async listen() {
      const address = await app.listen({ host: o.host, port: o.port })
      const run = (): void => {
        void rt.webhooks.sweep().catch((err: unknown) => rt.log.error({ err: (err as Error).message }, 'webhook sweep failed'))
      }
      run()
      sweep = setInterval(run, SWEEP_EVERY_MS)
      sweep.unref()
      return address
    },
    async close() {
      if (sweep) clearInterval(sweep)
      await app.close()
      await rt.idle()
    },
  }
}
